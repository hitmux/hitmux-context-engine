import * as fs from "fs";
import {
    Context,
    Embedding,
    FileSynchronizer,
    MilvusVectorDatabase,
    REMOTE_INDEX_MANIFEST_COLLECTION,
    VectorDatabase,
    configManager,
} from "@hitmux/hitmux-context-engine-core";

import {
    CodebaseIndexOptions,
    ContextMcpConfig,
    RequestSplitterType,
    createMcpConfig,
} from "./config.js";
import { createEmbeddingInstance } from "./embedding.js";
import { createRequestSplitter, resolveRequestSplitterType } from "./splitter.js";
import { SnapshotManager } from "./snapshot.js";
import { ensureAbsolutePath } from "./utils.js";
import {
    McpWriterLock,
    acquireMcpWriterLock,
    formatMcpWriterLockBusyMessage,
} from "./sync-lock.js";

const HCE_METADATA_PREFIX = "hitmuxContext:";
const CODEBASE_PATH_PREFIX = "codebasePath:";

type CliManageAction = "list" | "rm" | "index";

interface CollectionEmbeddingInfo {
    provider?: string;
    model?: string;
    dimension?: number;
}

interface CollectionMetadataInfo {
    codebasePath?: string;
    embedding?: CollectionEmbeddingInfo;
    schemaVersion?: number;
    metadataVersion?: number;
    splitterType?: string;
    createdAt?: string;
}

interface CollectionOverview {
    collectionName: string;
    codebasePath?: string;
    chunks?: number;
    metadata?: CollectionMetadataInfo;
    description?: string;
}

interface CliManageCommand {
    action: CliManageAction;
    target?: string;
    targets?: string[];
    all?: boolean;
    force?: boolean;
}

export interface CliManageOptions {
    createConfig?: () => ContextMcpConfig;
    createEmbedding?: (config: ContextMcpConfig) => Embedding;
    createVectorDatabase?: (config: ContextMcpConfig) => VectorDatabase;
    createContext?: (
        config: ContextMcpConfig,
        embedding: Embedding,
        vectorDatabase: VectorDatabase,
    ) => Context;
    createSnapshotManager?: () => SnapshotManager;
    acquireWriterLock?: (label: string) => McpWriterLock | null;
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
    signal?: AbortSignal;
}

export function parseCliManageCommand(args: string[]): CliManageCommand {
    const [action, ...rest] = args;
    if (action !== "list" && action !== "rm" && action !== "index") {
        throw new Error(getCliManageUsage());
    }

    if (action === "list") {
        if (rest.length > 1) {
            throw new Error(getCliManageUsage());
        }
        return { action, target: rest[0] };
    }

    if (action === "rm") {
        if (rest.length === 0 || rest.some((arg) => arg.startsWith("--"))) {
            throw new Error("Usage: hce rm <collection-name|repo-path> [...]");
        }
        return { action, targets: rest };
    }

    const all = rest.includes("--all");
    const force = rest.includes("--force");
    const unknownFlag = rest.find(
        (arg) => arg.startsWith("--") && arg !== "--all" && arg !== "--force",
    );
    if (unknownFlag) {
        throw new Error(getCliManageUsage());
    }

    const targets = rest.filter((arg) => arg !== "--all" && arg !== "--force");
    if (all && targets.length > 0) {
        throw new Error(getCliManageUsage());
    }
    if (all && !force) {
        throw new Error(
            "Refusing to force rebuild all known repo indexes without explicit confirmation.\nUsage: hce index --all --force",
        );
    }
    if (!force && targets.length > 1) {
        throw new Error(getCliManageUsage());
    }

    return {
        action,
        all,
        force,
        target: targets[0],
        targets: targets.length > 0 ? targets : undefined,
    };
}

export async function runCliManageCommand(
    args: string[],
    options: CliManageOptions = {},
): Promise<number> {
    let command: CliManageCommand;
    try {
        command = parseCliManageCommand(args);
    } catch (error) {
        writeStderr(options, `${formatErrorMessage(error)}\n`);
        return 2;
    }

    const configError = getConfigReadError();
    if (configError) {
        writeStderr(options, `Config error: ${configError.message}\n`);
        return 1;
    }

    try {
        const runtime = createCliRuntime(options);
        if (command.action === "list") {
            await listCollections(command.target, runtime, options);
            return 0;
        }

        if (command.action === "rm") {
            await removeCollections(command.targets!, runtime, options);
            return 0;
        }

        await indexCollections(command, runtime, options);
        return 0;
    } catch (error) {
        writeStderr(options, `${formatErrorMessage(error)}\n`);
        return 1;
    }
}

export function getCliManageUsage(): string {
    return [
        "Usage:",
        " hce list [collection-name|repo-path]",
        " hce rm <collection-name|repo-path> [...]",
        " hce index [collection-name|repo-path]",
        " hce index --force [collection-name|repo-path ...]",
        " hce index --all --force",
    ].join("\n");
}

function createCliRuntime(options: CliManageOptions) {
    const createConfig = options.createConfig ?? createMcpConfig;
    const config = createConfig();
    const createVectorDatabase =
        options.createVectorDatabase ??
        ((currentConfig: ContextMcpConfig) =>
            new MilvusVectorDatabase({
                address: currentConfig.milvusAddress,
                ...(currentConfig.milvusToken && {
                    token: currentConfig.milvusToken,
                }),
                useSystemProxy: currentConfig.databaseUseSystemProxy,
            }));
    const vectorDatabase = createVectorDatabase(config);
    const createEmbedding = options.createEmbedding ?? createEmbeddingInstance;
    const embedding = createEmbedding(config);
    const createContext =
        options.createContext ??
        ((
            currentConfig: ContextMcpConfig,
            currentEmbedding: Embedding,
            currentVectorDatabase: VectorDatabase,
        ) =>
            new Context({
                embedding: currentEmbedding,
                vectorDatabase: currentVectorDatabase,
                collectionNameOverride: currentConfig.collectionNameOverride,
                collectionIdentity: {
                    mode: currentConfig.codebaseIdentityMode,
                    customIdentity: currentConfig.codebaseIdentity,
                    globalName: currentConfig.globalCollectionName,
                    gitRemoteName: currentConfig.gitRemoteName,
                },
            }));
    const context = createContext(config, embedding, vectorDatabase);
    const createSnapshotManager =
        options.createSnapshotManager ??
        (() => {
            const snapshotManager = new SnapshotManager();
            snapshotManager.loadCodebaseSnapshot();
            return snapshotManager;
        });

    return {
        config,
        vectorDatabase,
        embedding,
        context,
        snapshotManager: createSnapshotManager(),
    };
}

async function listCollections(
    target: string | undefined,
    runtime: ReturnType<typeof createCliRuntime>,
    options: CliManageOptions,
): Promise<void> {
    const collections = await getCollectionOverviews(runtime.vectorDatabase);
    if (!target) {
        writeStdout(options, formatCollectionTable(collections));
        return;
    }

    const matches = resolveCollectionTarget(target, collections, runtime.context);
    if (matches.length === 0) {
        throw new Error(`No collection or repo path matched '${target}'.`);
    }
    if (matches.length > 1) {
        throw new Error(formatAmbiguousTarget(target, matches));
    }

    writeStdout(options, formatCollectionDetails(matches[0]));
}

async function removeCollections(
    targets: string[],
    runtime: ReturnType<typeof createCliRuntime>,
    options: CliManageOptions,
): Promise<void> {
    const collections = await getCollectionOverviews(runtime.vectorDatabase);
    const resolvedCollections: CollectionOverview[] = [];
    const resolvedCollectionNames = new Set<string>();

    for (const target of targets) {
        const matches = resolveCollectionTarget(target, collections, runtime.context);
        if (matches.length === 0) {
            throw new Error(`No collection or repo path matched '${target}'.`);
        }
        if (matches.length > 1) {
            throw new Error(formatAmbiguousTarget(target, matches));
        }

        const collection = matches[0];
        if (!resolvedCollectionNames.has(collection.collectionName)) {
            resolvedCollectionNames.add(collection.collectionName);
            resolvedCollections.push(collection);
        }
    }

    const lockFactory = options.acquireWriterLock ?? acquireMcpWriterLock;
    const lockLabel =
        resolvedCollections.length === 1
            ? `cli rm '${resolvedCollections[0].collectionName}'`
            : `cli rm ${resolvedCollections.length} collections`;
    const writerLock = lockFactory(lockLabel);
    if (!writerLock) {
        throw new Error(formatMcpWriterLockBusyMessage(formatRmAction(targets)));
    }

    const removedLines: string[] = [];
    try {
        for (const collection of resolvedCollections) {
            await runtime.vectorDatabase.dropCollection(collection.collectionName);
            if (collection.codebasePath) {
                runtime.snapshotManager.removeCodebaseCompletely(collection.codebasePath);
                await runtime.snapshotManager.saveCodebaseSnapshotAsync();
                await FileSynchronizer.deleteSnapshot(collection.codebasePath);
            }

            const repoPath = collection.codebasePath ?? "unknown";
            removedLines.push(
                `Removed collection '${collection.collectionName}'.\nRepo path: ${repoPath}`,
            );
        }
    } finally {
        writerLock.release();
    }

    writeStdout(options, `${removedLines.join("\n")}\n`);
}

async function indexCollections(
    command: CliManageCommand,
    runtime: ReturnType<typeof createCliRuntime>,
    options: CliManageOptions,
): Promise<void> {
    const lockFactory = options.acquireWriterLock ?? acquireMcpWriterLock;
    const actionLabel = formatIndexAction(command);
    const writerLock = lockFactory(actionLabel);
    if (!writerLock) {
        throw new Error(formatMcpWriterLockBusyMessage(actionLabel.replace(/^cli /, "")));
    }

    try {
        const targets = command.all
            ? await resolveAllIndexTargets(runtime)
            : await resolveIndexTargets(command, runtime);

        if (targets.length === 0) {
            throw new Error("No indexed repo paths were found for index --all.");
        }

        const results: string[] = [];
        for (const targetPath of targets) {
            const result = command.all || command.force
                ? await forceRebuildPath(targetPath, runtime, options)
                : await syncOrCreatePath(targetPath, runtime, options);
            results.push(result);
        }

        writeStdout(options, `${results.join("\n")}\n`);
    } finally {
        writerLock.release();
    }
}

function formatIndexAction(command: CliManageCommand): string {
    if (command.all) {
        return "cli index --all";
    }
    const targets = command.targets ?? [command.target ?? process.cwd()];
    if (command.force) {
        return targets.length === 1
            ? `cli index --force '${targets[0]}'`
            : `cli index --force ${targets.length} targets`;
    }
    return `cli index '${targets[0]}'`;
}

async function syncOrCreatePath(
    codebasePath: string,
    runtime: ReturnType<typeof createCliRuntime>,
    options: CliManageOptions,
): Promise<string> {
    assertDirectory(codebasePath);
    const indexOptions = getCliIndexOptions(runtime.snapshotManager, codebasePath);
    const splitterType = getCliSplitterType(codebasePath, indexOptions);
    const splitter = createRequestSplitter(splitterType);
    const hasIndex = await runtime.context.hasIndex(codebasePath);

    if (hasIndex) {
        const stats = await runtime.context.reindexByChange(
            codebasePath,
            (progress) => writeProgress(options, codebasePath, progress),
            indexOptions.requestIgnorePatterns ?? [],
            indexOptions.requestCustomExtensions ?? [],
            splitter,
            indexOptions.requestIgnoreFiles ?? [],
            indexOptions.requestMaxDepth,
            { abortSignal: options.signal },
        );
        const collectionName = runtime.context.getCollectionName(codebasePath);
        const remoteManifest =
            typeof runtime.context.getVectorDatabase().readIndexManifest === "function"
                ? await runtime.context
                      .getVectorDatabase()
                      .readIndexManifest!(collectionName, codebasePath)
                : null;
        if (remoteManifest) {
            runtime.snapshotManager.setCodebaseIndexed(codebasePath, {
                indexedFiles: remoteManifest.indexedFiles,
                totalChunks: remoteManifest.totalChunks,
                status: remoteManifest.status,
                statsSource: "remote_manifest",
            }, indexOptions);
            await runtime.snapshotManager.saveCodebaseSnapshotAsync();
        } else {
            writeStderr(
                options,
                `Remote manifest missing for '${codebasePath}'. Snapshot counts were not refreshed; run repair_index_manifest for legacy collections.\n`,
            );
        }
        return `Synced '${codebasePath}'. Changes: added=${stats.added}, removed=${stats.removed}, modified=${stats.modified}.`;
    }

    const stats = await runtime.context.indexCodebase(
        codebasePath,
        (progress) => writeProgress(options, codebasePath, progress),
        false,
        indexOptions.requestIgnorePatterns ?? [],
        indexOptions.requestCustomExtensions ?? [],
        splitter,
        options.signal,
        {
            additionalIgnoreFiles: indexOptions.requestIgnoreFiles ?? [],
            maxDepth: indexOptions.requestMaxDepth,
        },
    );
    runtime.snapshotManager.setCodebaseIndexed(codebasePath, stats, {
        ...indexOptions,
        requestSplitter: splitterType,
    });
    await runtime.snapshotManager.saveCodebaseSnapshotAsync();
    return `Indexed '${codebasePath}'. Chunks: ${stats.totalChunks}, files: ${stats.indexedFiles}.`;
}

async function forceRebuildPath(
    codebasePath: string,
    runtime: ReturnType<typeof createCliRuntime>,
    options: CliManageOptions,
): Promise<string> {
    assertDirectory(codebasePath);
    const indexOptions = getCliIndexOptions(runtime.snapshotManager, codebasePath);
    const splitterType = getCliSplitterType(codebasePath, indexOptions);
    const stats = await runtime.context.indexCodebase(
        codebasePath,
        (progress) => writeProgress(options, codebasePath, progress),
        true,
        indexOptions.requestIgnorePatterns ?? [],
        indexOptions.requestCustomExtensions ?? [],
        createRequestSplitter(splitterType),
        options.signal,
        {
            additionalIgnoreFiles: indexOptions.requestIgnoreFiles ?? [],
            maxDepth: indexOptions.requestMaxDepth,
        },
    );
    runtime.snapshotManager.setCodebaseIndexed(codebasePath, stats, {
        ...indexOptions,
        requestSplitter: splitterType,
    });
    await runtime.snapshotManager.saveCodebaseSnapshotAsync();
    return `Rebuilt '${codebasePath}'. Chunks: ${stats.totalChunks}, files: ${stats.indexedFiles}.`;
}

function getCliIndexOptions(
    snapshotManager: SnapshotManager,
    codebasePath: string,
): CodebaseIndexOptions {
    const info = snapshotManager.getCodebaseInfo(codebasePath);
    if (!info) {
        return {};
    }

    return {
        ...(info.requestSplitter ? { requestSplitter: info.requestSplitter } : {}),
        ...(info.requestIgnorePatterns?.length
            ? { requestIgnorePatterns: info.requestIgnorePatterns }
            : {}),
        ...(info.requestCustomExtensions?.length
            ? { requestCustomExtensions: info.requestCustomExtensions }
            : {}),
        ...(info.requestIgnoreFiles?.length
            ? { requestIgnoreFiles: info.requestIgnoreFiles }
            : {}),
        ...(info.requestMaxDepth !== undefined
            ? { requestMaxDepth: info.requestMaxDepth }
            : {}),
    };
}

function getCliSplitterType(
    codebasePath: string,
    indexOptions: CodebaseIndexOptions,
): RequestSplitterType {
    return resolveRequestSplitterType(
        indexOptions.requestSplitter ??
            configManager.getString("splitterType", codebasePath),
    );
}

async function resolveAllIndexTargets(
    runtime: ReturnType<typeof createCliRuntime>,
): Promise<string[]> {
    const collections = await getCollectionOverviews(runtime.vectorDatabase);
    const paths = new Set<string>();
    for (const collection of collections) {
        if (collection.codebasePath && fs.existsSync(collection.codebasePath)) {
            paths.add(ensureAbsolutePath(collection.codebasePath));
        }
    }
    for (const codebasePath of runtime.snapshotManager.getIndexedCodebases()) {
        if (fs.existsSync(codebasePath)) {
            paths.add(ensureAbsolutePath(codebasePath));
        }
    }
    return [...paths].sort();
}

async function resolveIndexTargets(
    command: CliManageCommand,
    runtime: ReturnType<typeof createCliRuntime>,
): Promise<string[]> {
    const requestedTargets = command.targets ?? [command.target ?? process.cwd()];
    const resolvedPaths = new Set<string>();
    for (const target of requestedTargets) {
        resolvedPaths.add(await resolveIndexTarget(target, runtime));
    }
    return [...resolvedPaths];
}

async function resolveIndexTarget(
    target: string,
    runtime: ReturnType<typeof createCliRuntime>,
): Promise<string> {
    const absolutePath = ensureAbsolutePath(target);
    if (fs.existsSync(absolutePath)) {
        assertDirectory(absolutePath);
        return absolutePath;
    }

    const collections = await getCollectionOverviews(runtime.vectorDatabase);
    const matches = resolveCollectionTarget(target, collections, runtime.context);
    if (matches.length === 0) {
        return absolutePath;
    }
    if (matches.length > 1) {
        throw new Error(formatAmbiguousTarget(target, matches));
    }
    if (!matches[0].codebasePath) {
        throw new Error(
            `Collection '${matches[0].collectionName}' does not expose a repo path, so it cannot be indexed by collection name.`,
        );
    }
    const matchedPath = ensureAbsolutePath(matches[0].codebasePath);
    const currentCollectionName = runtime.context.getCollectionName(matchedPath);
    if (
        target === matches[0].collectionName &&
        currentCollectionName !== matches[0].collectionName
    ) {
        throw new Error(
            `Collection '${matches[0].collectionName}' belongs to '${matchedPath}', but current configuration maps that path to '${currentCollectionName}'. Run hce index with the matching collection identity configuration, or remove the old collection explicitly with hce rm ${matches[0].collectionName}.`,
        );
    }
    return matchedPath;
}

async function getCollectionOverviews(
    vectorDatabase: VectorDatabase,
): Promise<CollectionOverview[]> {
    const collectionNames = await vectorDatabase.listCollections();
    const overviews: CollectionOverview[] = [];

    for (const collectionName of collectionNames.sort()) {
        if (collectionName === REMOTE_INDEX_MANIFEST_COLLECTION) {
            continue;
        }

        const description = await getCollectionDescription(
            vectorDatabase,
            collectionName,
        );
        const metadata = parseCollectionMetadata(description);
        const codebasePath =
            metadata?.codebasePath ??
            (await queryLegacyCodebasePath(vectorDatabase, collectionName));
        const chunks = await getCollectionRowCount(vectorDatabase, collectionName);

        overviews.push({
            collectionName,
            codebasePath,
            chunks,
            metadata,
            description,
        });
    }

    return overviews;
}

async function getCollectionDescription(
    vectorDatabase: VectorDatabase,
    collectionName: string,
): Promise<string> {
    try {
        return await vectorDatabase.getCollectionDescription(collectionName);
    } catch {
        return "";
    }
}

async function getCollectionRowCount(
    vectorDatabase: VectorDatabase,
    collectionName: string,
): Promise<number | undefined> {
    try {
        const rowCount = await vectorDatabase.getCollectionRowCount(collectionName);
        return rowCount >= 0 ? rowCount : undefined;
    } catch {
        return undefined;
    }
}

async function queryLegacyCodebasePath(
    vectorDatabase: VectorDatabase,
    collectionName: string,
): Promise<string | undefined> {
    try {
        const rows = await vectorDatabase.query(
            collectionName,
            undefined as unknown as string,
            ["metadata"],
            1,
        );
        const metadata = rows[0]?.metadata;
        const parsed =
            typeof metadata === "string" ? JSON.parse(metadata) : metadata;
        return typeof parsed?.codebasePath === "string"
            ? parsed.codebasePath
            : undefined;
    } catch {
        return undefined;
    }
}

function parseCollectionMetadata(description: string): CollectionMetadataInfo | undefined {
    const firstLine = description.split(/\r?\n/, 1)[0];
    const legacyPath = firstLine.startsWith(CODEBASE_PATH_PREFIX)
        ? firstLine.slice(CODEBASE_PATH_PREFIX.length)
        : undefined;
    const metadataLine = description
        .split(/\r?\n/)
        .find((line) => line.startsWith(HCE_METADATA_PREFIX));

    if (!metadataLine) {
        return legacyPath ? { codebasePath: legacyPath } : undefined;
    }

    try {
        const parsed = JSON.parse(metadataLine.slice(HCE_METADATA_PREFIX.length));
        return {
            codebasePath:
                typeof parsed.codebasePath === "string"
                    ? parsed.codebasePath
                    : legacyPath,
            embedding:
                parsed.embedding && typeof parsed.embedding === "object"
                    ? {
                          provider:
                              typeof parsed.embedding.provider === "string"
                                  ? parsed.embedding.provider
                                  : undefined,
                          model:
                              typeof parsed.embedding.model === "string"
                                  ? parsed.embedding.model
                                  : undefined,
                          dimension:
                              typeof parsed.embedding.dimension === "number"
                                  ? parsed.embedding.dimension
                                  : undefined,
                      }
                    : undefined,
            schemaVersion:
                typeof parsed.schemaVersion === "number"
                    ? parsed.schemaVersion
                    : undefined,
            metadataVersion:
                typeof parsed.metadataVersion === "number"
                    ? parsed.metadataVersion
                    : undefined,
            splitterType:
                typeof parsed.splitterType === "string"
                    ? parsed.splitterType
                    : undefined,
            createdAt:
                typeof parsed.createdAt === "string" ? parsed.createdAt : undefined,
        };
    } catch {
        return legacyPath ? { codebasePath: legacyPath } : undefined;
    }
}

function resolveCollectionTarget(
    target: string,
    collections: CollectionOverview[],
    context: Context,
): CollectionOverview[] {
    const exactName = collections.find(
        (collection) => collection.collectionName === target,
    );
    if (exactName) {
        return [exactName];
    }

    const absolutePath = ensureAbsolutePath(target);
    const pathMatches = collections.filter((collection) => {
        if (!collection.codebasePath) {
            return false;
        }
        return ensureAbsolutePath(collection.codebasePath) === absolutePath;
    });
    if (pathMatches.length > 0) {
        return pathMatches;
    }

    const expectedCollectionName = context.getCollectionName(absolutePath);
    return collections.filter(
        (collection) => collection.collectionName === expectedCollectionName,
    );
}

function formatCollectionTable(collections: CollectionOverview[]): string {
    if (collections.length === 0) {
        return "No collections found.\n";
    }

    const rows = collections.map((collection) => [
        collection.collectionName,
        collection.codebasePath ?? "-",
        collection.chunks === undefined ? "unknown" : String(collection.chunks),
    ]);
    const headers = ["Collection", "Repo Path", "Chunks"];
    const widths = headers.map((header, index) =>
        Math.max(header.length, ...rows.map((row) => row[index].length)),
    );
    const formatRow = (row: string[]) =>
        row
            .map((value, index) => value.padEnd(widths[index]))
            .join("  ")
            .trimEnd();

    return [
        formatRow(headers),
        formatRow(widths.map((width) => "-".repeat(width))),
        ...rows.map(formatRow),
        "",
    ].join("\n");
}

function formatCollectionDetails(collection: CollectionOverview): string {
    const lines = [
        `Collection: ${collection.collectionName}`,
        `Repo path: ${collection.codebasePath ?? "unknown"}`,
        `Chunks: ${collection.chunks === undefined ? "unknown" : collection.chunks}`,
    ];
    const embedding = collection.metadata?.embedding;
    if (embedding) {
        lines.push(
            `Embedding: ${embedding.provider ?? "unknown"}/${embedding.model ?? "unknown"} (${embedding.dimension ?? "unknown"} dimensions)`,
        );
    }
    if (collection.metadata?.schemaVersion !== undefined) {
        lines.push(`Schema version: ${collection.metadata.schemaVersion}`);
    }
    if (collection.metadata?.metadataVersion !== undefined) {
        lines.push(`Metadata version: ${collection.metadata.metadataVersion}`);
    }
    if (collection.metadata?.splitterType) {
        lines.push(`Splitter: ${collection.metadata.splitterType}`);
    }
    if (collection.metadata?.createdAt) {
        lines.push(`Created at: ${collection.metadata.createdAt}`);
    }
    return `${lines.join("\n")}\n`;
}

function formatAmbiguousTarget(
    target: string,
    matches: CollectionOverview[],
): string {
    return [
        `Target '${target}' matched multiple collections:`,
        ...matches.map(
            (collection) =>
                `- ${collection.collectionName} (${collection.codebasePath ?? "unknown"})`,
        ),
    ].join("\n");
}

function formatRmAction(targets: string[]): string {
    if (targets.length === 1) {
        return `rm '${targets[0]}'`;
    }

    return `rm ${targets.length} targets`;
}

function assertDirectory(codebasePath: string): void {
    if (!fs.existsSync(codebasePath)) {
        throw new Error(`Path '${codebasePath}' does not exist.`);
    }
    if (!fs.statSync(codebasePath).isDirectory()) {
        throw new Error(`Path '${codebasePath}' is not a directory.`);
    }
}

function getConfigReadError(): Error | null {
    const errors = configManager.getReadErrors(process.cwd());
    if (errors.length === 0) {
        return null;
    }

    const details = errors
        .map((error) => `${error.path}: ${error.message}`)
        .join("\n");
    return new Error(
        `Invalid config.conf. Fix the configuration before running CLI commands.\n${details}`,
    );
}

function writeProgress(
    options: CliManageOptions,
    codebasePath: string,
    progress: { phase: string; current: number; total: number; percentage: number },
): void {
    writeStderr(
        options,
        `[INDEX] ${codebasePath}: ${progress.phase} ${progress.percentage.toFixed(1)}% (${progress.current}/${progress.total})\n`,
    );
}

function formatErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function writeStdout(options: CliManageOptions, message: string): void {
    if (options.stdout) {
        options.stdout(message);
    } else {
        process.stdout.write(message);
    }
}

function writeStderr(options: CliManageOptions, message: string): void {
    if (options.stderr) {
        options.stderr(message);
    } else {
        process.stderr.write(message);
    }
}
