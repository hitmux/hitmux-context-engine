import * as fs from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    Context,
    configManager,
} from "@hitmux/hitmux-context-engine-core";

import {
    ContextMcpConfig,
    createMcpConfig,
    getDefaultModelForProvider,
} from "./config.js";
import { runCliManageCommand } from "./cli-manage.js";
import { runCliTestCommand } from "./cli-test.js";
import { ToolHandlers } from "./handlers.js";
import { isHceDebugEnabled } from "./logger.js";
import { createRuntimeContext } from "./runtime-context.js";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";

const MCP_PACKAGE_VERSION_FALLBACK = "0.0.0";

type CliSearchScope = "all" | "docs" | "code";

interface CliRuntime {
    context: Context;
    snapshotManager: SnapshotManager;
    syncManager: SyncManager;
    toolHandlers: ToolHandlers;
}

export interface CliDispatcherOptions {
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
    signal?: AbortSignal;
    readPackageVersion?: () => string;
    createConfig?: () => ContextMcpConfig;
    createRuntime?: () => CliRuntime;
    runConnectivityTest?: (
        args: string[],
        options: {
            stdout?: (message: string) => void;
            stderr?: (message: string) => void;
        },
    ) => Promise<number>;
    runManageCommand?: typeof runCliManageCommand;
}

export function readCurrentPackageVersion(): string {
    try {
        const packageJsonPath = join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "package.json",
        );
        const packageJson = JSON.parse(readFileSyncUtf8(packageJsonPath)) as {
            version?: string;
        };
        return packageJson.version ?? MCP_PACKAGE_VERSION_FALLBACK;
    } catch (error) {
        process.stderr.write(
            `[MCP] Failed to read package version: ${formatErrorMessage(error)}\n`,
        );
        return MCP_PACKAGE_VERSION_FALLBACK;
    }
}

export function getCliHelpText(): string {
    return [
        "Hitmux Context Engine",
        "",
        "Usage:",
        " hce                         Start the MCP stdio server",
        " hce --help|-h               Show this help",
        " hce --version|-v            Show package version",
        "",
        "Setup and diagnostics:",
        " hce init                    Create or complete global config.conf",
        " hce config path             Show config paths",
        " hce doctor [--no-connectivity]",
        "",
        "Index and collection management:",
        " hce status [path] [--refresh] [--details]",
        " hce search <query> [path] [--limit n] [--scope all|docs|code]",
        " hce clear <path>",
        " hce repair <path>",
        " hce test [embedding|vectordb]",
        " hce list [collection-name|repo-path]",
        " hce rm <collection-name|repo-path> [...]",
        " hce index [collection-name|repo-path]",
        " hce index --force [collection-name|repo-path ...]",
        " hce index --all --force",
        "",
        "Notes:",
        " Run plain hce only from MCP clients; it stays in stdio server mode.",
        " Config is read from ~/.hitmux-context-engine/config.conf and ./.hitmux-context-engine/config.conf.",
        " Omit --limit to use automatic TopK (default range: 3-12); pass --limit to force an exact count.",
        "",
    ].join("\n");
}

export function shouldStartMcpServer(args: string[]): boolean {
    return args.length === 0;
}

export async function runCliCommand(
    args: string[],
    options: CliDispatcherOptions = {},
): Promise<number> {
    if (args.length === 0) {
        return 2;
    }

    const [command, ...rest] = args;

    if (command === "--help" || command === "-h" || command === "help") {
        writeStdout(options, getCliHelpText());
        return 0;
    }

    if (command === "--version" || command === "-v" || command === "version") {
        const readVersion = options.readPackageVersion ?? readCurrentPackageVersion;
        writeStdout(options, `${readVersion()}\n`);
        return 0;
    }

    if (command === "init") {
        return runInitCommand(rest, options);
    }

    if (command === "config") {
        return runConfigCommand(rest, options);
    }

    if (command === "doctor") {
        return runDoctorCommand(rest, options);
    }

    if (command === "test") {
        return withCliDiagnosticsOnStderr(options, () =>
            runCliTestCommand(rest, options),
        );
    }

    if (command === "list" || command === "rm" || command === "index") {
        const runManage = options.runManageCommand ?? runCliManageCommand;
        return withCliDiagnosticsOnStderr(options, () =>
            runManage(args, {
                stdout: options.stdout,
                stderr: options.stderr,
                signal: options.signal,
            }),
        );
    }

    if (command === "status") {
        return parseAndRunHandlerCommand(() => parseStatusCommand(rest), options);
    }

    if (command === "clear") {
        return parseAndRunHandlerCommand(
            () => parsePathOnlyCommand("clear", rest),
            options,
        );
    }

    if (command === "repair") {
        return parseAndRunHandlerCommand(
            () => parsePathOnlyCommand("repair", rest),
            options,
        );
    }

    if (command === "search") {
        return parseAndRunHandlerCommand(() => parseSearchCommand(rest), options);
    }

    writeStderr(
        options,
        `Unknown command: ${command}\n\n${getCliHelpText()}`,
    );
    return 2;
}

function runInitCommand(
    args: string[],
    options: CliDispatcherOptions,
): number {
    if (args.length !== 0) {
        writeStderr(options, "Usage: hce init\n");
        return 2;
    }

    try {
        const result = configManager.ensureGlobalConfigFile();
        if (result.created) {
            writeStdout(
                options,
                `Created global config file: ${result.path}\nEdit secret fields before using remote providers.\n`,
            );
        } else if (result.updated) {
            writeStdout(
                options,
                `Completed global config file: ${result.path}\nAdded missing keys: ${result.appendedKeys.join(", ")}\n`,
            );
        } else {
            writeStdout(
                options,
                `Global config file already exists: ${result.path}\nNo changes made.\n`,
            );
        }
        return 0;
    } catch (error) {
        writeStderr(options, `Failed to initialize config: ${formatErrorMessage(error)}\n`);
        return 1;
    }
}

function runConfigCommand(
    args: string[],
    options: CliDispatcherOptions,
): number {
    if (args.length !== 1 || args[0] !== "path") {
        writeStderr(options, "Usage: hce config path\n");
        return 2;
    }

    const globalPath = configManager.getGlobalConfigFilePath();
    const projectPath = configManager.getProjectConfigFilePath(process.cwd());
    writeStdout(
        options,
        [
            `Global config: ${globalPath} (${fs.existsSync(globalPath) ? "exists" : "missing"})`,
            `Project config: ${projectPath} (${fs.existsSync(projectPath) ? "exists" : "missing"})`,
            "",
        ].join("\n"),
    );
    return 0;
}

async function runDoctorCommand(
    args: string[],
    options: CliDispatcherOptions,
): Promise<number> {
    const noConnectivity = args.includes("--no-connectivity");
    const unknown = args.find((arg) => arg !== "--no-connectivity");
    if (unknown) {
        writeStderr(options, "Usage: hce doctor [--no-connectivity]\n");
        return 2;
    }

    let failed = false;
    const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    if (nodeMajor >= 20) {
        writeStdout(options, `[PASS] node: ${process.version}\n`);
    } else {
        failed = true;
        writeStderr(options, `[FAIL] node: ${process.version}; Node >=20 is required\n`);
    }

    const configErrors = configManager.getReadErrors(process.cwd());
    if (configErrors.length === 0) {
        writeStdout(options, "[PASS] config: parsed global/project config files\n");
    } else {
        failed = true;
        writeStderr(
            options,
            `[FAIL] config: ${configErrors.map((error) => `${error.path}: ${error.message}`).join("; ")}\n`,
        );
    }

    const configCheck = checkRequiredRuntimeConfig();
    for (const line of configCheck.output) {
        if (line.startsWith("[FAIL]")) {
            failed = true;
            writeStderr(options, `${line}\n`);
        } else {
            writeStdout(options, `${line}\n`);
        }
    }

    if (!noConnectivity) {
        const runConnectivity =
            options.runConnectivityTest ??
            ((targets, testOptions) => runCliTestCommand(targets, testOptions));
        const exitCode = await withCliDiagnosticsOnStderr(options, () =>
            runConnectivity([], {
                stdout: options.stdout,
                stderr: options.stderr,
            }),
        );
        if (exitCode !== 0) {
            failed = true;
        }
    } else {
        writeStdout(options, "[SKIP] connectivity: --no-connectivity\n");
    }

    return failed ? 1 : 0;
}

function checkRequiredRuntimeConfig(): { output: string[] } {
    const output: string[] = [];
    const provider =
        configManager.getString("embeddingProvider") || "OpenRouter";
    const model =
        configManager.getString("embeddingModel") ||
        getDefaultModelForProvider(provider);
    output.push(`[PASS] embedding: provider=${provider}, model=${model}`);

    switch (provider) {
        case "OpenAI":
            output.push(
                configManager.getString("openaiApiKey")
                    ? "[PASS] openaiApiKey: configured"
                    : "[FAIL] openaiApiKey: missing for embeddingProvider=OpenAI",
            );
            break;
        case "VoyageAI":
            output.push(
                configManager.getString("voyageaiApiKey")
                    ? "[PASS] voyageaiApiKey: configured"
                    : "[FAIL] voyageaiApiKey: missing for embeddingProvider=VoyageAI",
            );
            break;
        case "Gemini":
            output.push(
                configManager.getString("geminiApiKey")
                    ? "[PASS] geminiApiKey: configured"
                    : "[FAIL] geminiApiKey: missing for embeddingProvider=Gemini",
            );
            break;
        case "OpenRouter":
            output.push(
                configManager.getString("openrouterApiKey")
                    ? "[PASS] openrouterApiKey: configured"
                    : "[FAIL] openrouterApiKey: missing for embeddingProvider=OpenRouter",
            );
            break;
        case "Ollama":
            output.push("[PASS] ollama: API key not required");
            break;
        default:
            output.push(
                `[FAIL] embeddingProvider: unsupported value '${provider}'`,
            );
            break;
    }

    const milvusAddress = configManager.getString("milvusAddress");
    const milvusToken = configManager.getString("milvusToken");
    output.push(
        milvusAddress || milvusToken
            ? "[PASS] vectordb: milvusAddress or milvusToken configured"
            : "[FAIL] vectordb: configure milvusAddress or milvusToken",
    );
    return { output };
}

interface HandlerCommand {
    tool: "status" | "clear" | "repair" | "search";
    args: Record<string, unknown>;
}

function parseStatusCommand(args: string[]): HandlerCommand {
    const refresh = args.includes("--refresh");
    const details = args.includes("--details");
    const unknownFlag = args.find(
        (arg) => arg.startsWith("--") && arg !== "--refresh" && arg !== "--details",
    );
    if (unknownFlag) {
        throw new CliUsageError("Usage: hce status [path] [--refresh] [--details]");
    }
    const paths = args.filter((arg) => arg !== "--refresh" && arg !== "--details");
    if (paths.length > 1) {
        throw new CliUsageError("Usage: hce status [path] [--refresh] [--details]");
    }
    return {
        tool: "status",
        args: {
            path: resolveCliPath(paths[0] ?? process.cwd()),
            ...(refresh ? { refresh: true } : {}),
            ...(details ? { details: true } : {}),
        },
    };
}

function parsePathOnlyCommand(
    tool: "clear" | "repair",
    args: string[],
): HandlerCommand {
    if (args.length !== 1 || args[0].startsWith("--")) {
        throw new CliUsageError(`Usage: hce ${tool} <path>`);
    }
    return {
        tool,
        args: {
            path: resolveCliPath(args[0]),
        },
    };
}

function parseSearchCommand(args: string[]): HandlerCommand {
    if (args.length === 0) {
        throw new CliUsageError(
            "Usage: hce search <query> [path] [--limit n] [--scope all|docs|code]",
        );
    }

    const positional: string[] = [];
    let limit: number | undefined;
    let scope: CliSearchScope | undefined;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--limit") {
            const rawLimit = args[++index];
            if (!rawLimit) {
                throw new CliUsageError("Usage: hce search <query> [path] [--limit n] [--scope all|docs|code]");
            }
            limit = Number(rawLimit);
            if (!Number.isFinite(limit) || limit <= 0 || !Number.isInteger(limit)) {
                throw new CliUsageError("--limit must be a positive integer");
            }
            continue;
        }
        if (arg === "--scope") {
            const rawScope = args[++index];
            if (!isCliSearchScope(rawScope)) {
                throw new CliUsageError("--scope must be one of: all, docs, code");
            }
            scope = rawScope;
            continue;
        }
        if (arg === "--target-role") {
            const rawRole = args[++index];
            const mappedScope = mapLegacyTargetRoleToScope(rawRole);
            if (!mappedScope) {
                throw new CliUsageError(
                    "Usage: hce search <query> [path] [--limit n] [--scope all|docs|code]",
                );
            }
            scope = mappedScope;
            continue;
        }
        if (arg.startsWith("--")) {
            throw new CliUsageError(
                "Usage: hce search <query> [path] [--limit n] [--scope all|docs|code]",
            );
        }
        positional.push(arg);
    }

    if (positional.length < 1 || positional.length > 2) {
        throw new CliUsageError(
            "Usage: hce search <query> [path] [--limit n] [--scope all|docs|code]",
        );
    }

    return {
        tool: "search",
        args: {
            query: positional[0],
            path: resolveCliPath(positional[1] ?? process.cwd()),
            ...(limit !== undefined ? { limit } : {}),
            ...(scope ? { scope } : {}),
        },
    };
}

async function runHandlerCommand(
    command: HandlerCommand,
    options: CliDispatcherOptions,
): Promise<number> {
    try {
        return await withCliDiagnosticsOnStderr(options, async () => {
            const runtime = getCliRuntime(options);
            let result: any;
            switch (command.tool) {
                case "status":
                    result = await runtime.toolHandlers.handleGetIndexingStatus(
                        command.args,
                    );
                    break;
                case "clear":
                    result = await runtime.toolHandlers.handleClearIndex(command.args);
                    break;
                case "repair":
                    result =
                        await runtime.toolHandlers.handleRepairIndexManifest(
                            command.args,
                        );
                    break;
                case "search":
                    result = await runtime.toolHandlers.handleSearchContext(command.args);
                    break;
            }
            return writeHandlerResult(result, options);
        });
    } catch (error) {
        if (error instanceof CliUsageError) {
            writeStderr(options, `${error.message}\n`);
            return 2;
        }
        writeStderr(options, `${formatErrorMessage(error)}\n`);
        return 1;
    }
}

function parseAndRunHandlerCommand(
    parse: () => HandlerCommand,
    options: CliDispatcherOptions,
): Promise<number> {
    try {
        return runHandlerCommand(parse(), options);
    } catch (error) {
        if (error instanceof CliUsageError) {
            writeStderr(options, `${error.message}\n`);
            return Promise.resolve(2);
        }
        writeStderr(options, `${formatErrorMessage(error)}\n`);
        return Promise.resolve(1);
    }
}

function getCliRuntime(options: CliDispatcherOptions): CliRuntime {
    if (options.createRuntime) {
        return options.createRuntime();
    }

    const configError = getConfigReadError();
    if (configError) {
        throw configError;
    }

    const configFactory = options.createConfig ?? createMcpConfig;
    const config = configFactory();
    const context = createRuntimeContext(config);
    const snapshotManager = new SnapshotManager();
    snapshotManager.loadCodebaseSnapshot();
    const syncManager = new SyncManager(context, snapshotManager);
    const toolHandlers = new ToolHandlers(context, snapshotManager, syncManager);

    return {
        context,
        snapshotManager,
        syncManager,
        toolHandlers,
    };
}

function writeHandlerResult(
    result: any,
    options: CliDispatcherOptions,
): number {
    const text = extractResultText(result);
    if (result?.isError) {
        writeStderr(options, `${text}\n`);
        return 1;
    }
    writeStdout(options, `${text}\n`);
    return 0;
}

function extractResultText(result: any): string {
    const content = Array.isArray(result?.content) ? result.content : [];
    const textParts = content
        .filter((item: any) => item?.type === "text" && typeof item.text === "string")
        .map((item: any) => item.text);
    return textParts.length > 0 ? textParts.join("\n") : String(result ?? "");
}

function resolveCliPath(input: string): string {
    return isAbsolute(input) ? input : resolve(process.cwd(), input);
}

function isCliSearchScope(value: string | undefined): value is CliSearchScope {
    return value === "all" || value === "docs" || value === "code";
}

function mapLegacyTargetRoleToScope(value: string | undefined): CliSearchScope | undefined {
    switch (value) {
        case "all":
        case "config":
            return "all";
        case "docs":
            return "docs";
        case "implementation":
        case "test":
            return "code";
        default:
            return undefined;
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

async function withCliDiagnosticsOnStderr<T>(
    options: CliDispatcherOptions,
    callback: () => Promise<T>,
): Promise<T> {
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => {
        if (isHceDebugEnabled()) {
            writeStderr(options, `${args.map(String).join(" ")}\n`);
        }
    };
    console.warn = (...args: unknown[]) => {
        if (isHceDebugEnabled()) {
            writeStderr(options, `${args.map(String).join(" ")}\n`);
        }
    };
    try {
        return await callback();
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
    }
}

class CliUsageError extends Error {}

function readFileSyncUtf8(path: string): string {
    return fs.readFileSync(path, "utf8");
}

function formatErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function writeStdout(options: CliDispatcherOptions, message: string): void {
    if (options.stdout) {
        options.stdout(message);
    } else {
        process.stdout.write(message);
    }
}

function writeStderr(options: CliDispatcherOptions, message: string): void {
    if (options.stderr) {
        options.stderr(message);
    } else {
        process.stderr.write(message);
    }
}
