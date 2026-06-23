import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import {
    Context,
    COLLECTION_LIMIT_MESSAGE,
    FileSynchronizer,
    IndexAbortError,
    IncrementalIndexTooLargeError,
    configManager,
    normalizeCodebaseIdentityPath,
    REMOTE_INDEX_MANIFEST_VERSION,
    type RemoteIndexManifest,
    type SearchTargetRole,
    type SymbolTraceEvidence,
    type SymbolTraceResult,
} from "@hitmux/hitmux-context-engine-core";
import { SnapshotManager } from "./snapshot.js";
import {
    getBooleanFromConfig,
    type CodebaseIndexOptions,
    type CodebaseInfoIndexing,
    type CodebaseInfoIndexed,
    type RequestSplitterType,
} from "./config.js";
import {
    createRequestSplitter,
    isRequestSplitterType,
    resolveRequestSplitterType,
} from "./splitter.js";
import {
    analyzeFilenameLikeQuery,
    formatFilenameQueryNotice,
    searchResultsAreFallbackMatches,
} from "./search-filename-query.js";
import {
    requireAbsolutePath,
    truncateContent,
    trackCodebasePath,
} from "./utils.js";
import {
    queryCollectionStats,
} from "./collection-stats.js";
import type {
    CodebaseSyncStats,
    CodebaseSyncStatus,
    SearchConsistencyMode,
    SyncManager,
} from "./sync.js";
import {
    acquireMcpWriterLock,
    formatMcpWriterLockBusyMessage,
    McpWriterLock,
    type McpWriterLockScope,
} from "./sync-lock.js";
import {
    IndexingJobStateManager,
    type IndexingJobProgress,
    type IndexingJobState,
} from "./indexing-job-state.js";
import {
    IndexingWorkerCancelledError,
    startIndexingWorkerJob,
} from "./indexing-worker-runner.js";

const DEFAULT_SEARCH_RESULT_LIMIT = 20;
const SOURCE_CONTEXT_WINDOW_LINES = 4;
const SEARCH_CONTEXT_MAX_CHARS = 5000;
const SEARCH_TRACE_EVIDENCE_RESULT_LIMIT = 3;
const SEARCH_TRACE_EVIDENCE_SYMBOL_LIMIT = 1;
const SEARCH_TRACE_EVIDENCE_MAX_FILES = 500;
const SEARCH_TRACE_EVIDENCE_MAX_REFERENCES = 8;
const DEFAULT_VECTOR_DATABASE_SYNC_TIMEOUT_MS = 5_000;
const MAX_SNAPSHOT_RECOVERY_ANCESTOR_PROBES = 32;
const NOT_INDEXED_INDEXING_HINT =
    "Please index it first using the index_codebase tool. Before first indexing, create a project ignore file such as .hceignore when you need to exclude generated, large, or private paths. The indexer automatically loads .*ignore files it finds in the project tree, so files like .hceignore, .gitignore, and .cursorignore are applied without passing ignoreFiles.";

interface RemoteCollectionProbe {
    collectionName: string;
    exists: boolean;
    description?: string;
    rowCount?: number;
    descriptionError?: string;
    rowCountError?: string;
}

interface RemoteManifestRead {
    available: boolean;
    manifest: RemoteIndexManifest | null;
    error?: string;
}

interface ManifestRepairStatus {
    phase: string;
    current: number;
    total: number;
    percentage: number;
    startedAtMs: number;
    updatedAtMs: number;
    error?: string;
}

type SourceFileCache = Map<string, string | Error>;

function getVectorDatabaseSyncTimeoutMs(): number {
    const configuredTimeoutMs = configManager.getNumber(
        "vectorDatabaseSyncTimeoutMs",
    );
    if (configuredTimeoutMs === undefined) {
        return DEFAULT_VECTOR_DATABASE_SYNC_TIMEOUT_MS;
    }

    if (!Number.isFinite(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
        console.warn(
            `[SYNC-VDB] Ignoring invalid config.vectorDatabaseSyncTimeoutMs value '${configuredTimeoutMs}'. Falling back to ${DEFAULT_VECTOR_DATABASE_SYNC_TIMEOUT_MS}ms.`,
        );
        return DEFAULT_VECTOR_DATABASE_SYNC_TIMEOUT_MS;
    }

    return Math.floor(configuredTimeoutMs);
}

export class ToolHandlers {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private indexingStats: {
        indexedFiles: number;
        totalChunks: number;
    } | null = null;
    private currentWorkspace: string;
    /**
     * Tracks active background indexing tasks per absolute codebase path so
     * clear_index can cancel and await them before dropping the collection.
     * Without this, a clear_index call returns "successfully cleared" while
     * the background task keeps embedding chunks and writing them into the
     * just-cleared collection (issue #199).
     */
    private indexingTasks: Map<
        string,
        { controller: AbortController; promise: Promise<void> }
    > = new Map();
    private indexingStateLocks: Map<string, Promise<void>> = new Map();
    private vectorDatabaseSyncTimeoutMs: number;
    private remoteCollectionProbeTasks = new Map<
        string,
        Promise<RemoteCollectionProbe>
    >();
    private remoteManifestReadTasks = new Map<
        string,
        Promise<RemoteManifestRead>
    >();
    private manifestRepairStatuses = new Map<string, ManifestRepairStatus>();
    private indexingJobStates = new IndexingJobStateManager();
    private syncManager?: Pick<
        SyncManager,
        "getSyncStatus" | "syncCodebaseForSearch" | "trackCodebase"
    >;

    constructor(
        context: Context,
        snapshotManager: SnapshotManager,
        syncManager?: Pick<
            SyncManager,
            "getSyncStatus" | "syncCodebaseForSearch" | "trackCodebase"
        >,
    ) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.syncManager = syncManager;
        this.currentWorkspace = process.cwd();
        this.vectorDatabaseSyncTimeoutMs = getVectorDatabaseSyncTimeoutMs();
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    private errorResponse(text: string) {
        return {
            content: [
                {
                    type: "text",
                    text,
                },
            ],
            isError: true,
        };
    }

    private getSnapshotPathsForCollection(
        absolutePath: string,
        indexedCodebases: string[],
        indexingCodebases: string[],
    ): string[] {
        const collectionName = this.context.getCollectionName(absolutePath);
        const paths = new Set([absolutePath]);

        for (const candidatePath of [...indexedCodebases, ...indexingCodebases]) {
            if (this.context.getCollectionName(candidatePath) === collectionName) {
                paths.add(candidatePath);
            }
        }

        return Array.from(paths);
    }

    private notIndexedResponse(absolutePath: string) {
        return this.errorResponse(
            `Error: Codebase '${absolutePath}' is not indexed. ${NOT_INDEXED_INDEXING_HINT}`,
        );
    }

    public setSyncManager(
        syncManager: Pick<
            SyncManager,
            "getSyncStatus" | "syncCodebaseForSearch" | "trackCodebase"
        >,
    ): void {
        this.syncManager = syncManager;
    }

    private trackIndexedCodebase(codebasePath: string): void {
        this.syncManager?.trackCodebase?.(codebasePath);
    }

    private formatElapsedMs(elapsedMs: number): string {
        if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
            return "unknown";
        }
        if (elapsedMs < 1000) {
            return `${Math.round(elapsedMs)}ms`;
        }
        if (elapsedMs < 60_000) {
            return `${(elapsedMs / 1000).toFixed(1)}s`;
        }
        const minutes = Math.floor(elapsedMs / 60_000);
        const seconds = Math.floor((elapsedMs % 60_000) / 1000);
        return `${minutes}m ${seconds}s`;
    }

    private formatSyncStatus(status: CodebaseSyncStatus): string {
        const elapsed = this.formatElapsedMs(Date.now() - status.startedAtMs);
        const progress = Number.isFinite(status.percentage)
            ? `${Math.max(0, Math.min(100, status.percentage)).toFixed(1)}%`
            : "unknown";
        const step =
            status.total > 0 ? ` (${status.current}/${status.total})` : "";
        return ` Automatic sync in progress for '${status.codebasePath}'. Elapsed: ${elapsed}. Progress: ${progress}${step}. Phase: ${status.phase}. Please wait for sync to finish before relying on freshly changed or newly ignored files.`;
    }

    private getSyncStatusMessage(codebasePath: string): string {
        const status = this.syncManager?.getSyncStatus(codebasePath);
        return status ? this.formatSyncStatus(status) : "";
    }

    private getManifestRepairStatusMessage(codebasePath: string): string {
        const status = this.manifestRepairStatuses.get(codebasePath);
        if (!status) {
            return "";
        }

        const elapsed = this.formatElapsedMs(Date.now() - status.startedAtMs);
        const progress = Number.isFinite(status.percentage)
            ? `${Math.max(0, Math.min(100, status.percentage)).toFixed(1)}%`
            : "unknown";
        const step =
            status.total > 0 ? ` (${status.current}/${status.total})` : "";
        const suffix = status.error ? ` Last error: ${status.error}` : "";
        return ` Manifest repair in progress for '${codebasePath}'. Elapsed: ${elapsed}. Progress: ${progress}${step}. Phase: ${status.phase}.${suffix}`;
    }

    private isIndexingJobStale(job: IndexingJobState): boolean {
        if (job.status !== "running") return false;
        if (this.indexingTasks.has(job.codebasePath)) return false;
        const updatedAtMs = Date.parse(job.updatedAt);
        return !Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > 30_000;
    }

    private getIndexingJobStatusMessage(
        codebasePath: string,
        job?: IndexingJobState,
    ): string {
        const latestJob = job ?? this.indexingJobStates.findLatestForCodebase(codebasePath);
        if (!latestJob) return "";

        const elapsed = this.formatElapsedMs(
            Date.now() - Date.parse(latestJob.startedAt),
        );
        const progress = Number.isFinite(latestJob.progress.percentage)
            ? `${Math.max(0, Math.min(100, latestJob.progress.percentage)).toFixed(1)}%`
            : "unknown";
        const step =
            latestJob.progress.total > 0
                ? ` (${latestJob.progress.current}/${latestJob.progress.total})`
                : "";
        const staleSuffix = this.isIndexingJobStale(latestJob)
            ? " The worker job appears stale; retry indexing if this status does not change."
            : "";
        const errorSuffix = latestJob.errorMessage
            ? ` Error: ${latestJob.errorMessage}`
            : "";
        return ` Indexing job '${latestJob.jobId}' is ${latestJob.status}. Elapsed: ${elapsed}. Progress: ${progress}${step}. Phase: ${latestJob.progress.phase}.${errorSuffix}${staleSuffix}`;
    }

    private setManifestRepairStatus(
        codebasePath: string,
        status: Omit<ManifestRepairStatus, "startedAtMs" | "updatedAtMs"> & {
            startedAtMs?: number;
        },
    ): void {
        const previous = this.manifestRepairStatuses.get(codebasePath);
        const startedAtMs = status.startedAtMs ?? previous?.startedAtMs ?? Date.now();
        this.manifestRepairStatuses.set(codebasePath, {
            ...status,
            startedAtMs,
            updatedAtMs: Date.now(),
        });
    }

    private acquireManualWriterLock(
        action: string,
        scope: McpWriterLockScope,
    ): McpWriterLock | ReturnType<ToolHandlers["errorResponse"]> {
        const lock = acquireMcpWriterLock(action, scope);
        return (
            lock ??
            this.errorResponse(
                `Error: ${formatMcpWriterLockBusyMessage(action, scope)}`,
            )
        );
    }

    private getCollectionWriterLockScope(codebasePath: string): McpWriterLockScope {
        const context = this.context as unknown as {
            getCollectionName?: (path: string) => string;
        };
        const collectionName =
            typeof context.getCollectionName === "function"
                ? context.getCollectionName(codebasePath)
                : `codebase_${codebasePath.replace(/[^A-Za-z0-9]/g, "_")}`;
        return {
            kind: "collection",
            collectionName,
        };
    }

    private validateRequiredStringArgs(
        toolName: string,
        args: any,
        fields: string[],
    ): { error: ReturnType<ToolHandlers["errorResponse"]> | null } {
        if (!args || typeof args !== "object" || Array.isArray(args)) {
            return {
                error: this.errorResponse(
                    `Error: ${toolName} requires an argument object with ${fields.map((field) => `'${field}'`).join(", ")}.`,
                ),
            };
        }

        const missingFields = fields.filter(
            (field) =>
                typeof args[field] !== "string" ||
                args[field].trim().length === 0,
        );
        if (missingFields.length > 0) {
            return {
                error: this.errorResponse(
                    `Error: Missing required argument(s) for ${toolName}: ${missingFields.map((field) => `'${field}'`).join(", ")}.`,
                ),
            };
        }

        return { error: null };
    }

    private validateOptionalStringArrayArgs(
        toolName: string,
        args: any,
        fields: string[],
    ): { error: ReturnType<ToolHandlers["errorResponse"]> | null } {
        for (const field of fields) {
            const value = args?.[field];
            if (value === undefined) {
                continue;
            }
            if (
                !Array.isArray(value) ||
                value.some(
                    (item) =>
                        typeof item !== "string" || item.trim().length === 0,
                )
            ) {
                return {
                    error: this.errorResponse(
                        `Error: ${toolName} argument '${field}' must be an array of non-empty strings.`,
                    ),
                };
            }
        }

        return { error: null };
    }

    private normalizeStringArray(value: unknown): string[] {
        if (!Array.isArray(value)) {
            return [];
        }

        return value
            .map((item) => (typeof item === "string" ? item.trim() : ""))
            .filter((item) => item.length > 0);
    }

    private normalizeOptionalSearchLimit(value: unknown): {
        limit?: number;
        error?: ReturnType<ToolHandlers["errorResponse"]>;
    } {
        if (value === undefined || value === null) {
            return {};
        }

        if (
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            value <= 0
        ) {
            return {
                error: this.errorResponse(
                    "Error: search_code argument 'limit' must be a positive number when provided.",
                ),
            };
        }

        return { limit: Math.floor(value) };
    }

    private normalizeOptionalSearchTargetRole(value: unknown): {
        targetRole?: SearchTargetRole;
        error?: ReturnType<ToolHandlers["errorResponse"]>;
    } {
        if (value === undefined || value === null) {
            return {};
        }

        if (
            value === "implementation" ||
            value === "test" ||
            value === "docs" ||
            value === "config" ||
            value === "all"
        ) {
            return { targetRole: value };
        }

        return {
            error: this.errorResponse(
                "Error: search_code argument 'targetRole' must be one of: implementation, test, docs, config, all.",
            ),
        };
    }

    private normalizeOptionalIncludeRelated(value: unknown): {
        includeRelated?: boolean;
        error?: ReturnType<ToolHandlers["errorResponse"]>;
    } {
        if (value === undefined || value === null) {
            return {};
        }

        if (typeof value === "boolean") {
            return { includeRelated: value };
        }

        return {
            error: this.errorResponse(
                "Error: search_code argument 'includeRelated' must be a boolean when provided.",
            ),
        };
    }

    private normalizeOptionalIncludeTraceEvidence(value: unknown): {
        includeTraceEvidence?: boolean;
        error?: ReturnType<ToolHandlers["errorResponse"]>;
    } {
        if (value === undefined || value === null) {
            return {};
        }

        if (typeof value === "boolean") {
            return { includeTraceEvidence: value };
        }

        return {
            error: this.errorResponse(
                "Error: search_code argument 'includeTraceEvidence' must be a boolean when provided.",
            ),
        };
    }

    private normalizeOptionalSkipConsistencyCheck(value: unknown): {
        skipConsistencyCheck?: boolean;
        error?: ReturnType<ToolHandlers["errorResponse"]>;
    } {
        if (value === undefined || value === null) {
            return {};
        }

        if (typeof value === "boolean") {
            return { skipConsistencyCheck: value };
        }

        return {
            error: this.errorResponse(
                "Error: search_code argument 'skipConsistencyCheck' must be a boolean when provided.",
            ),
        };
    }

    private normalizeOptionalSearchConsistency(value: unknown): {
        consistencyMode?: SearchConsistencyMode;
        error?: ReturnType<ToolHandlers["errorResponse"]>;
    } {
        if (value === undefined || value === null) {
            return {};
        }

        if (value === "low_latency" || value === "strong") {
            return { consistencyMode: value };
        }

        return {
            error: this.errorResponse(
                "Error: search_code argument 'consistency' must be one of: low_latency, strong.",
            ),
        };
    }

    private normalizeOptionalExtensionFilter(value: unknown): {
        extensions?: string[];
        error?: ReturnType<ToolHandlers["errorResponse"]>;
    } {
        if (value === undefined || value === null) {
            return {};
        }

        if (!Array.isArray(value)) {
            return {
                error: this.errorResponse(
                    "Error: search_code argument 'extensionFilter' must be an array of file extensions when provided.",
                ),
            };
        }

        const cleaned = value
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
        const invalid = value.filter(
            (item) =>
                typeof item !== "string" ||
                !/^\.[A-Za-z0-9][A-Za-z0-9_+-]*$/.test(item.trim()),
        );

        if (invalid.length > 0) {
            return {
                error: this.errorResponse(
                    `Error: Invalid file extensions in extensionFilter: ${JSON.stringify(invalid)}. Use simple extensions like '.ts', '.tsx', '.py'.`,
                ),
            };
        }

        return { extensions: cleaned };
    }

    private normalizeOptionalBooleanArg(
        toolName: string,
        field: string,
        value: unknown,
    ): { value?: boolean; error?: ReturnType<ToolHandlers["errorResponse"]> } {
        if (value === undefined || value === null) {
            return {};
        }

        if (typeof value !== "boolean") {
            return {
                error: this.errorResponse(
                    `Error: ${toolName} argument '${field}' must be a boolean when provided.`,
                ),
            };
        }

        return { value };
    }

    private normalizeOptionalNonNegativeIntegerArg(
        toolName: string,
        field: string,
        value: unknown,
    ): { value?: number; error?: ReturnType<ToolHandlers["errorResponse"]> } {
        if (value === undefined || value === null) {
            return {};
        }

        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            return {
                error: this.errorResponse(
                    `Error: ${toolName} argument '${field}' must be a non-negative number when provided.`,
                ),
            };
        }

        return { value: Math.floor(value) };
    }

    private formatSearchResultLocation(result: any): {
        location: string;
        warning?: string;
    } {
        if (this.hasValidLineRange(result)) {
            return {
                location: `${result.relativePath}:${result.startLine}-${result.endLine}`,
            };
        }

        return {
            location: `${result.relativePath}:unknown`,
            warning:
                typeof result.lineRangeWarning === "string" &&
                result.lineRangeWarning.length > 0
                    ? result.lineRangeWarning
                    : "line range unavailable; re-index this codebase to refresh line metadata.",
        };
    }

    private hasValidLineRange(
        result: any,
    ): result is { relativePath: string; startLine: number; endLine: number } {
        return (
            result?.lineRangeUnavailable !== true &&
            typeof result?.startLine === "number" &&
            typeof result?.endLine === "number" &&
            Number.isInteger(result.startLine) &&
            Number.isInteger(result.endLine) &&
            result.startLine > 0 &&
            result.endLine >= result.startLine
        );
    }

    private formatSearchScoreReason(result: any): string | undefined {
        const scoreReasons = Array.isArray(result?.scoreReasons)
            ? result.scoreReasons.filter(
                  (reason: unknown): reason is string =>
                      typeof reason === "string" && reason.length > 0,
              )
            : [];
        if (scoreReasons.length > 0) {
            return scoreReasons.join(", ");
        }

        return typeof result?.scoreReason === "string" &&
            result.scoreReason.length > 0
            ? result.scoreReason
            : undefined;
    }

    private formatSearchResultGroupLabel(group: unknown): string {
        switch (group) {
            case "implementation":
                return "Implementation matches";
            case "entry_exports":
                return "Entry / exports";
            case "related_tests":
                return "Related tests";
            case "docs_config":
                return "Docs / config";
            default:
                return "Other matches";
        }
    }

    private async formatSearchTraceEvidence(
        result: any,
        resultIndex: number,
        codebasePath: string,
        contextText: string,
    ): Promise<string> {
        if (
            resultIndex >= SEARCH_TRACE_EVIDENCE_RESULT_LIMIT ||
            typeof result?.relativePath !== "string"
        ) {
            return "";
        }
        if (
            result?.resultGroup !== undefined &&
            result.resultGroup !== "implementation" &&
            result.resultGroup !== "entry_exports"
        ) {
            return "";
        }

        const symbols = this.extractTraceFollowupSymbols(contextText).slice(
            0,
            SEARCH_TRACE_EVIDENCE_SYMBOL_LIMIT,
        );
        if (symbols.length === 0) {
            return " Trace evidence: insufficient; no traceable implementation symbol found in this result.\n";
        }

        const traces: string[] = [];
        for (const symbol of symbols) {
            try {
                const trace = await this.context.traceSymbol(
                    codebasePath,
                    symbol,
                    {
                        startPath: result.relativePath,
                        startLine: this.hasValidLineRange(result)
                            ? result.startLine
                            : undefined,
                        endLine: this.hasValidLineRange(result)
                            ? result.endLine
                            : undefined,
                        maxFiles: SEARCH_TRACE_EVIDENCE_MAX_FILES,
                        maxReferences: SEARCH_TRACE_EVIDENCE_MAX_REFERENCES,
                        includeTests: true,
                    },
                );
                traces.push(
                    this.formatCompactTraceEvidence(result, symbol, trace),
                );
            } catch (error) {
                traces.push(
                    ` Trace evidence (${symbol}): insufficient; trace failed: ${error instanceof Error ? error.message : String(error)}\n`,
                );
            }
        }

        return traces.join("");
    }

    private formatCompactTraceEvidence(
        result: any,
        symbol: string,
        trace: SymbolTraceResult,
    ): string {
        const hasEvidence =
            trace.definitions.length > 0 ||
            trace.references.length > 0 ||
            trace.imports.length > 0 ||
            trace.exports.length > 0 ||
            trace.relatedTests.length > 0;
        const lines = [` Trace evidence (${symbol}):`];

        if (!hasEvidence) {
            lines.push(
                " Evidence insufficient: no definitions, references, imports, exports, or related tests found.",
            );
            return `${lines.join("\n")}\n`;
        }

        this.pushCompactEvidenceChainLine(lines, result, symbol, trace);
        this.pushCompactTraceLine(
            lines,
            "Owner definitions",
            trace.definitions,
        );
        this.pushCompactTraceLine(lines, "Entry references", trace.references);
        this.pushCompactCallChainLine(lines, trace.references);
        const moduleLinks = [...trace.imports, ...trace.exports].filter(
            (entry) => entry.moduleSpecifier || entry.resolvedPath,
        );
        this.pushCompactTraceLine(lines, "Module links", moduleLinks, true);
        this.pushCompactTraceLine(lines, "Related tests", trace.relatedTests);
        if (trace.truncated) {
            lines.push(
                " Warning: trace truncated by maxFiles or maxReferences.",
            );
        }
        if (trace.warnings.length > 0) {
            lines.push(` Warning: ${trace.warnings.slice(0, 2).join("; ")}`);
        }

        return `${lines.join("\n")}\n`;
    }

    private pushCompactEvidenceChainLine(
        lines: string[],
        result: any,
        symbol: string,
        trace: SymbolTraceResult,
    ): void {
        const steps: string[] = [];
        const seen = new Set<string>();
        const pushStep = (step: string | undefined) => {
            if (!step || seen.has(step)) {
                return;
            }
            seen.add(step);
            steps.push(step);
        };

        if (typeof result?.relativePath === "string") {
            const lineRange = this.hasValidLineRange(result)
                ? `:${result.startLine}-${result.endLine}`
                : "";
            pushStep(`entry ${result.relativePath}${lineRange}`);
        }

        const moduleLinks = [...trace.imports, ...trace.exports]
            .filter((entry) => entry.resolvedPath)
            .slice(0, 3);
        for (const entry of moduleLinks) {
            pushStep(
                `${entry.kind} ${entry.relativePath}:${entry.line} -> ${entry.resolvedPath}`,
            );
        }

        const owner = trace.definitions[0];
        if (owner) {
            pushStep(`owner ${owner.relativePath}:${owner.line} ${symbol}`);
        }

        const localCall = trace.references.find(
            (entry) => entry.enclosingSymbol && entry.callTarget,
        );
        if (localCall) {
            pushStep(
                `call ${localCall.relativePath}:${localCall.line} ${localCall.enclosingSymbol} -> ${localCall.callTarget}`,
            );
        } else if (trace.references[0]) {
            const reference = trace.references[0];
            pushStep(`reference ${reference.relativePath}:${reference.line}`);
        }

        if (steps.length > 1) {
            lines.push(` Evidence chain: ${steps.join(" => ")}`);
        }
    }

    private pushCompactTraceLine(
        lines: string[],
        label: string,
        entries: SymbolTraceEvidence[],
        includeResolution: boolean = false,
    ): void {
        if (entries.length === 0) {
            return;
        }

        const formatted = entries
            .slice(0, 3)
            .map((entry) => {
                const resolved =
                    includeResolution && entry.resolvedPath
                        ? ` -> ${entry.resolvedPath}`
                        : "";
                return `${entry.relativePath}:${entry.line}${resolved}`;
            })
            .join("; ");
        lines.push(` ${label}: ${formatted}`);
    }

    private pushCompactCallChainLine(
        lines: string[],
        entries: SymbolTraceEvidence[],
    ): void {
        const chains = entries
            .filter((entry) => entry.enclosingSymbol && entry.callTarget)
            .slice(0, 3)
            .map(
                (entry) =>
                    `${entry.relativePath}:${entry.line} ${entry.enclosingSymbol} -> ${entry.callTarget}`,
            );

        if (chains.length > 0) {
            lines.push(` Call chain: ${chains.join("; ")}`);
        }
    }

    private extractTraceFollowupSymbols(content: string): string[] {
        const symbols = new Set<string>();
        const addSymbol = (value: string | undefined) => {
            if (
                !value ||
                !/^[A-Z][A-Za-z0-9_$]*$/.test(value) ||
                this.isUnhelpfulTraceSymbol(value)
            ) {
                return;
            }
            symbols.add(value);
        };

        const patterns = [
            /@delegate\s+([A-Z][A-Za-z0-9_$]*)\b/g,
            /\b(?:new|extends|implements)\s+([A-Z][A-Za-z0-9_$]*)\b/g,
            /:\s*([A-Z][A-Za-z0-9_$]*)\b/g,
            /\bas\s+([A-Z][A-Za-z0-9_$]*)\b/g,
            /\b(?:class|interface|type|enum)\s+([A-Z][A-Za-z0-9_$]*)\b/g,
        ];

        for (const pattern of patterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(content)) !== null) {
                addSymbol(match[1]);
            }
        }

        for (const importMatch of content.matchAll(/\bimport\s*\{([^}]+)\}/g)) {
            for (const imported of importMatch[1].split(",")) {
                const name = imported
                    .trim()
                    .split(/\s+as\s+/)[0]
                    ?.trim();
                addSymbol(name);
            }
        }

        for (const exportMatch of content.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
            for (const exported of exportMatch[1].split(",")) {
                const name = exported
                    .trim()
                    .split(/\s+as\s+/)[0]
                    ?.trim();
                addSymbol(name);
            }
        }

        return [...symbols];
    }

    private isUnhelpfulTraceSymbol(symbol: string): boolean {
        return new Set([
            "Array",
            "Boolean",
            "Date",
            "Error",
            "Map",
            "Number",
            "Object",
            "Promise",
            "Record",
            "Set",
            "String",
            "WeakMap",
            "WeakSet",
        ]).has(symbol);
    }

    private formatSearchResultContext(
        result: any,
        codebasePath: string,
        sourceFileCache: SourceFileCache,
    ): { context: string; source: string; warning?: string } {
        const fallbackContent = truncateContent(
            String(result?.content ?? ""),
            SEARCH_CONTEXT_MAX_CHARS,
        );
        if (!this.hasValidLineRange(result)) {
            return {
                context: fallbackContent,
                source: "indexed chunk fallback",
            };
        }

        const resolvedPath = this.resolveResultSourcePath(
            codebasePath,
            result.relativePath,
        );
        if (!resolvedPath) {
            return {
                context: fallbackContent,
                source: "indexed chunk fallback",
                warning:
                    "source rehydrate skipped because the result path is outside the indexed codebase.",
            };
        }

        try {
            const source = this.readSourceFileForSearchContext(
                resolvedPath,
                sourceFileCache,
            );
            const lines = source.split(/\r?\n/);
            const contextStartLine = Math.max(
                1,
                result.startLine - SOURCE_CONTEXT_WINDOW_LINES,
            );
            const contextEndLine = Math.min(
                lines.length,
                result.endLine + SOURCE_CONTEXT_WINDOW_LINES,
            );

            if (contextStartLine > contextEndLine) {
                return {
                    context: fallbackContent,
                    source: "indexed chunk fallback",
                    warning:
                        "source rehydrate failed because the indexed line range is outside the current source file.",
                };
            }

            return {
                context: truncateContent(
                    lines
                        .slice(contextStartLine - 1, contextEndLine)
                        .join("\n"),
                    SEARCH_CONTEXT_MAX_CHARS,
                ),
                source: `current source file, lines ${contextStartLine}-${contextEndLine}; indexed range ${result.startLine}-${result.endLine}`,
            };
        } catch {
            return {
                context: fallbackContent,
                source: "indexed chunk fallback",
                warning:
                    "source rehydrate failed; using indexed chunk fallback.",
            };
        }
    }

    private readSourceFileForSearchContext(
        resolvedPath: string,
        sourceFileCache: SourceFileCache,
    ): string {
        const cached = sourceFileCache.get(resolvedPath);
        if (typeof cached === "string") {
            return cached;
        }
        if (cached instanceof Error) {
            throw cached;
        }

        try {
            const source = fs.readFileSync(resolvedPath, "utf-8");
            sourceFileCache.set(resolvedPath, source);
            return source;
        } catch (error) {
            const readError =
                error instanceof Error ? error : new Error(String(error));
            sourceFileCache.set(resolvedPath, readError);
            throw readError;
        }
    }

    private resolveResultSourcePath(
        codebasePath: string,
        relativePath: unknown,
    ): string | null {
        if (
            typeof relativePath !== "string" ||
            relativePath.trim().length === 0
        ) {
            return null;
        }

        const resolvedPath = path.resolve(codebasePath, relativePath);
        const relativeToCodebase = path.relative(codebasePath, resolvedPath);
        if (
            relativeToCodebase.startsWith("..") ||
            path.isAbsolute(relativeToCodebase)
        ) {
            return null;
        }

        return resolvedPath;
    }

    private async resolveSearchResultLimit(
        explicitLimit: number | undefined,
        codebasePath: string,
    ): Promise<number> {
        if (explicitLimit !== undefined) {
            return explicitLimit;
        }

        const configuredLimit = configManager.getNumber(
            "searchTopK",
            codebasePath,
        );
        if (configuredLimit !== undefined) {
            if (Number.isInteger(configuredLimit) && configuredLimit > 0) {
                return configuredLimit;
            }

            console.warn(
                `[SEARCH] Ignoring invalid config.searchTopK value '${configuredLimit}'. Falling back to ${DEFAULT_SEARCH_RESULT_LIMIT}.`,
            );
        }

        return DEFAULT_SEARCH_RESULT_LIMIT;
    }

    private resolveSearchThreshold(codebasePath: string): number {
        const defaultThreshold = 0.3;
        const configuredThreshold = configManager.getNumber(
            "searchThreshold",
            codebasePath,
        );
        if (configuredThreshold === undefined) {
            return defaultThreshold;
        }

        if (Number.isFinite(configuredThreshold) && configuredThreshold >= 0) {
            return configuredThreshold;
        }

        console.warn(
            `[SEARCH] Ignoring invalid config.searchThreshold value '${configuredThreshold}'. Falling back to ${defaultThreshold}.`,
        );
        return defaultThreshold;
    }

    private isInteractiveIndexingEnabled(): boolean {
        return getBooleanFromConfig("interactiveIndexing", true);
    }

    private async withIndexingStateLock<T>(
        codebasePath: string,
        run: () => Promise<T>,
    ): Promise<T> {
        const previous = this.indexingStateLocks.get(codebasePath);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const chain = (previous ?? Promise.resolve())
            .catch(() => undefined)
            .then(() => gate);

        this.indexingStateLocks.set(codebasePath, chain);
        await previous?.catch(() => undefined);

        try {
            return await run();
        } finally {
            release();
            if (this.indexingStateLocks.get(codebasePath) === chain) {
                this.indexingStateLocks.delete(codebasePath);
            }
        }
    }

    /**
     * Query Milvus for the real row count of a codebase's collection.
     * Returns null if the count cannot be determined — callers must NOT write a
     * snapshot entry in that case. Writing { indexedFiles: 0, totalChunks: 0,
     * status: 'completed' } for an unknown-state collection poisons the client:
     * the client treats 0/0 as "not indexed" and triggers force reindex, which
     * deletes real data and rewrites 0/0 — an infinite loop. See Issue #295.
     */
    private async queryCollectionStats(codebasePath: string): Promise<{
        indexedFiles: number;
        totalChunks: number;
        statsSource: "collection_row_count";
    } | null> {
        return queryCollectionStats(this.context, codebasePath);
    }

    private getSnapshotRecoveryCandidates(absolutePath: string): string[] {
        const candidates: string[] = [];
        let candidate = path.resolve(absolutePath);

        for (
            let probes = 0;
            probes < MAX_SNAPSHOT_RECOVERY_ANCESTOR_PROBES;
            probes++
        ) {
            candidates.push(candidate);
            const parent = path.dirname(candidate);
            if (parent === candidate) {
                break;
            }
            candidate = parent;
        }

        return candidates;
    }

    private parseCollectionDescriptionCodebasePath(
        description: string | undefined,
    ): string | null {
        if (!description || !description.startsWith("codebasePath:")) {
            return null;
        }

        const codebasePath = description
            .split(/\r?\n/, 1)[0]
            .substring("codebasePath:".length);
        return codebasePath.length > 0 ? codebasePath : null;
    }

    private async resolveSnapshotRecoveryCodebasePath(
        candidatePath: string,
    ): Promise<string> {
        try {
            const vectorDatabase = this.context.getVectorDatabase();
            if (
                !vectorDatabase ||
                typeof vectorDatabase.getCollectionDescription !== "function"
            ) {
                return candidatePath;
            }

            const collectionName = this.context.getCollectionName(candidatePath);
            const description = await this.withVectorDatabaseSyncTimeout(
                `Milvus getCollectionDescription(${collectionName}) during search snapshot recovery`,
                vectorDatabase.getCollectionDescription(collectionName),
            );
            const recoveredCodebasePath =
                this.parseCollectionDescriptionCodebasePath(description);
            if (recoveredCodebasePath && fs.existsSync(recoveredCodebasePath)) {
                return path.resolve(recoveredCodebasePath);
            }
        } catch (error) {
            console.warn(
                `[SEARCH] Failed to resolve recovery codebase path for '${candidatePath}' from collection description:`,
                error,
            );
        }

        return candidatePath;
    }

    private async recoverIndexedCodebaseFromVectorDatabase(
        absolutePath: string,
    ): Promise<string | null> {
        if (typeof this.context.hasIndex !== "function") {
            return null;
        }

        for (const candidatePath of this.getSnapshotRecoveryCandidates(
            absolutePath,
        )) {
            const hasVectorIndex = await this.context.hasIndex(candidatePath);
            if (!hasVectorIndex) {
                continue;
            }

            const recoveryCodebasePath =
                await this.resolveSnapshotRecoveryCodebasePath(candidatePath);
            const collectionName =
                this.context.getCollectionName(recoveryCodebasePath);
            let manifestRead = await this.readRemoteIndexManifest(
                collectionName,
                recoveryCodebasePath,
            );
            let manifestCodebasePath = recoveryCodebasePath;
            if (
                !manifestRead.manifest &&
                recoveryCodebasePath !== candidatePath
            ) {
                manifestRead = await this.readRemoteIndexManifest(
                    this.context.getCollectionName(candidatePath),
                    candidatePath,
                );
                manifestCodebasePath = candidatePath;
            }
            if (!manifestRead.manifest) {
                console.warn(
                    `[SEARCH] Snapshot missing but remote manifest is unavailable for '${recoveryCodebasePath}', skipping implicit legacy recovery. Run repair_index_manifest for old collections.`,
                );
                return null;
            }

            console.warn(
                `[SEARCH] Snapshot missing but remote manifest exists for '${manifestCodebasePath}', recovering snapshot (chunks=${manifestRead.manifest.totalChunks})`,
            );
            this.snapshotManager.setCodebaseIndexed(manifestCodebasePath, {
                indexedFiles: manifestRead.manifest.indexedFiles,
                totalChunks: manifestRead.manifest.totalChunks,
                status: manifestRead.manifest.status,
            });
            await this.snapshotManager.saveCodebaseSnapshotAsync();
            return manifestCodebasePath;
        }

        return null;
    }

    private formatIncrementalTooLargeWarning(
        error: IncrementalIndexTooLargeError,
    ): string {
        return `Automatic incremental indexing paused: detected ${error.effectiveLines} effective lines across ${error.changedFiles} added/modified file(s), exceeding the ${error.threshold} line limit. Check whether this is a large batch of files that should be added to .hceignore. If the files should be indexed, review the change set and run index_codebase with incremental=true from MCP.`;
    }

    private async refreshCodebaseIndexBeforeSearch(
        codebasePath: string,
        consistencyMode: SearchConsistencyMode,
    ): Promise<{ error?: any; warning?: string } | null> {
        if (typeof this.context.reindexByChange !== "function") {
            if (consistencyMode === "low_latency") {
                return null;
            }
            return null;
        }

        const writerLock = this.acquireManualWriterLock(
            `search_code sync for '${codebasePath}'`,
            this.getCollectionWriterLockScope(codebasePath),
        );
        if (!(writerLock instanceof McpWriterLock)) {
            if (consistencyMode === "low_latency") {
                return {
                    warning:
                        "Search used the current index because a writer lock is active. Results may be stale until the active indexing or sync operation finishes.",
                };
            }
            return { error: writerLock };
        }

        try {
            return await this.withIndexingStateLock(codebasePath, async () => {
                const info = this.snapshotManager.getCodebaseInfo(codebasePath);
                if (!info || info.status !== "indexed") {
                    return { error: this.notIndexedResponse(codebasePath) };
                }

                try {
                    const stats = this.syncManager?.syncCodebaseForSearch
                        ? await this.syncManager.syncCodebaseForSearch(
                              codebasePath,
                              { consistencyMode, writerLockHeld: true },
                          )
                        : await this.refreshCodebaseIndexBeforeSearchWithoutSyncManager(
                              codebasePath,
                              info,
                              consistencyMode,
                          );

                    if (
                        stats.added > 0 ||
                        stats.removed > 0 ||
                        stats.modified > 0
                    ) {
                        this.snapshotManager.markCodebaseSynced(
                            codebasePath,
                            stats,
                        );
                    } else {
                        this.snapshotManager.clearCodebaseSyncWarning(
                            codebasePath,
                        );
                    }
                    await this.snapshotManager.saveCodebaseSnapshotAsync();
                    return stats.warning ? { warning: stats.warning } : null;
                } catch (error) {
                    if (error instanceof IncrementalIndexTooLargeError) {
                        const warning =
                            this.formatIncrementalTooLargeWarning(error);
                        this.snapshotManager.setCodebaseSyncWarning(
                            codebasePath,
                            warning,
                        );
                        await this.snapshotManager.saveCodebaseSnapshotAsync();
                        if (consistencyMode === "low_latency") {
                            return { warning };
                        }
                        return {
                            error: this.errorResponse(
                                `Error: search_code requires a fresh index for '${codebasePath}', but ${warning}`,
                            ),
                        };
                    }

                    const message =
                        error instanceof Error ? error.message : String(error);
                    if (consistencyMode === "low_latency") {
                        return {
                            warning: `Search used the current index because pre-search incremental sync failed: ${message}`,
                        };
                    }
                    return {
                        error: this.errorResponse(
                            `Error: search_code could not refresh index for '${codebasePath}' before searching: ${message}`,
                        ),
                    };
                }
            });
        } finally {
            writerLock.release();
        }
    }

    private async refreshCodebaseIndexBeforeSearchWithoutSyncManager(
        codebasePath: string,
        info: NonNullable<ReturnType<SnapshotManager["getCodebaseInfo"]>>,
        consistencyMode: SearchConsistencyMode,
    ): Promise<CodebaseSyncStats> {
        if (consistencyMode === "low_latency") {
            return {
                added: 0,
                removed: 0,
                modified: 0,
                warning:
                    "Search used the current index without a pre-search consistency scan because SyncManager is unavailable. Results may be stale.",
            };
        }

        const splitterType = resolveRequestSplitterType(info.requestSplitter);
        return this.context.reindexByChange(
            codebasePath,
            undefined,
            info.requestIgnorePatterns || [],
            info.requestCustomExtensions || [],
            createRequestSplitter(splitterType),
            info.requestIgnoreFiles || [],
            info.requestMaxDepth,
        );
    }

    private getMerkleTrackedFileCount(
        codebasePath: string,
    ): number | undefined {
        try {
            const normalizedPath = normalizeCodebaseIdentityPath(codebasePath);
            const hash = crypto
                .createHash("md5")
                .update(normalizedPath)
                .digest("hex");
            const snapshotPath = path.join(
                os.homedir(),
                ".hitmux-context-engine",
                "merkle",
                `${hash}.json`,
            );
            const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
            if (Array.isArray(snapshot.fileHashes)) {
                return snapshot.fileHashes.length;
            }
            if (
                snapshot.fileHashes &&
                typeof snapshot.fileHashes === "object"
            ) {
                return Object.keys(snapshot.fileHashes).length;
            }
        } catch {
            return undefined;
        }

        return undefined;
    }

    private hasRecoveredStats(
        codebasePath: string,
        info: CodebaseInfoIndexed,
    ): boolean {
        if (info.statsSource === "collection_row_count") {
            return true;
        }

        const trackedFileCount = this.getMerkleTrackedFileCount(codebasePath);
        return (
            trackedFileCount !== undefined &&
            info.indexedFiles === info.totalChunks &&
            trackedFileCount !== info.indexedFiles
        );
    }

    private formatIndexedStatistics(
        codebasePath: string,
        info: CodebaseInfoIndexed,
    ): string {
        if (this.hasRecoveredStats(codebasePath, info)) {
            if (
                info.statsSource === "collection_row_count" &&
                info.indexedFiles > 0
            ) {
                return `${info.indexedFiles} files, ${info.totalChunks} chunks`;
            }

            const trackedFileCount =
                this.getMerkleTrackedFileCount(codebasePath);
            if (trackedFileCount !== undefined) {
                return `${trackedFileCount} files, ${info.totalChunks} chunks`;
            }

            return `file count unknown, ${info.totalChunks} chunks`;
        }

        return `${info.indexedFiles} files, ${info.totalChunks} chunks`;
    }

    private async withVectorDatabaseSyncTimeout<T>(
        label: string,
        operation: Promise<T>,
    ): Promise<T> {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
            timeoutHandle = setTimeout(() => {
                reject(
                    new Error(
                        `${label} timed out after ${this.vectorDatabaseSyncTimeoutMs}ms`,
                    ),
                );
            }, this.vectorDatabaseSyncTimeoutMs);
        });

        try {
            return await Promise.race([operation, timeoutPromise]);
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    private async getRemoteCollectionProbe(
        collectionName: string,
    ): Promise<RemoteCollectionProbe> {
        const existingTask = this.remoteCollectionProbeTasks.get(collectionName);
        if (existingTask) {
            return existingTask;
        }

        const task = this.readRemoteCollectionProbe(collectionName).finally(
            () => {
                if (this.remoteCollectionProbeTasks.get(collectionName) === task) {
                    this.remoteCollectionProbeTasks.delete(collectionName);
                }
            },
        );
        this.remoteCollectionProbeTasks.set(collectionName, task);
        return task;
    }

    private async readRemoteCollectionProbe(
        collectionName: string,
    ): Promise<RemoteCollectionProbe> {
        const vectorDatabase = this.context.getVectorDatabase();
        const exists = await this.withVectorDatabaseSyncTimeout(
            `Milvus hasCollection(${collectionName}) during remote status probe`,
            vectorDatabase.hasCollection(collectionName),
        );
        if (!exists) {
            return { collectionName, exists: false };
        }

        const probe: RemoteCollectionProbe = { collectionName, exists: true };
        try {
            probe.description = await this.withVectorDatabaseSyncTimeout(
                `Milvus getCollectionDescription(${collectionName}) during remote status probe`,
                vectorDatabase.getCollectionDescription(collectionName),
            );
        } catch (error) {
            probe.descriptionError =
                error instanceof Error ? error.message : String(error);
        }

        try {
            probe.rowCount = await this.withVectorDatabaseSyncTimeout(
                `Milvus getCollectionRowCount(${collectionName}) during remote status probe`,
                vectorDatabase.getCollectionRowCount(collectionName),
            );
        } catch (error) {
            probe.rowCountError =
                error instanceof Error ? error.message : String(error);
        }

        return probe;
    }

    private async readRemoteIndexManifest(
        collectionName: string,
        codebasePath: string,
    ): Promise<RemoteManifestRead> {
        const taskKey = `${collectionName}\0${codebasePath}`;
        const existingTask = this.remoteManifestReadTasks.get(taskKey);
        if (existingTask) {
            return existingTask;
        }

        const vectorDatabase = this.context.getVectorDatabase();
        if (typeof vectorDatabase.readIndexManifest !== "function") {
            return { available: false, manifest: null };
        }

        const task = (async (): Promise<RemoteManifestRead> => {
            try {
                const manifest = await this.withVectorDatabaseSyncTimeout(
                    `remote index manifest read(${collectionName})`,
                    vectorDatabase.readIndexManifest!(collectionName, codebasePath),
                );
                return { available: true, manifest };
            } catch (error) {
                return {
                    available: true,
                    manifest: null,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        })().finally(() => {
            if (this.remoteManifestReadTasks.get(taskKey) === task) {
                this.remoteManifestReadTasks.delete(taskKey);
            }
        });
        this.remoteManifestReadTasks.set(taskKey, task);
        return task;
    }

    private async writeRemoteIndexManifest(
        manifest: RemoteIndexManifest,
    ): Promise<void> {
        const vectorDatabase = this.context.getVectorDatabase();
        if (typeof vectorDatabase.writeIndexManifest !== "function") {
            throw new Error(
                "Current vector database implementation does not support remote index manifests.",
            );
        }
        await this.withVectorDatabaseSyncTimeout(
            `remote index manifest write(${manifest.collectionName})`,
            vectorDatabase.writeIndexManifest(manifest),
        );
    }

    private async deleteRemoteIndexManifest(
        collectionName: string,
        codebasePath: string,
    ): Promise<void> {
        if (typeof (this.context as any).getVectorDatabase !== "function") {
            return;
        }
        const vectorDatabase = this.context.getVectorDatabase();
        if (typeof vectorDatabase.deleteIndexManifest !== "function") {
            return;
        }
        await this.withVectorDatabaseSyncTimeout(
            `remote index manifest delete(${collectionName})`,
            vectorDatabase.deleteIndexManifest(collectionName, codebasePath),
        );
    }

    private formatRemoteStatusDiagnostics(
        codebasePath: string,
        probe: RemoteCollectionProbe | null,
        manifestRead: RemoteManifestRead | null,
    ): string {
        if (!probe) {
            return "";
        }

        const lines: string[] = [];
        if (!probe.exists) {
            lines.push(`Remote collection: missing (${probe.collectionName})`);
            return lines.join("\n");
        }

        lines.push(`Remote collection: exists (${probe.collectionName})`);
        if (probe.rowCount !== undefined) {
            lines.push(`Remote collection rows: ${probe.rowCount}`);
        } else if (probe.rowCountError) {
            lines.push(`Remote collection rows: unknown (${probe.rowCountError})`);
        }

        const describedCodebasePath =
            this.parseCollectionDescriptionCodebasePath(probe.description);
        if (describedCodebasePath && describedCodebasePath !== codebasePath) {
            lines.push(
                `Remote warning: collection description codebasePath is '${describedCodebasePath}', not '${codebasePath}'.`,
            );
        } else if (!describedCodebasePath && probe.descriptionError) {
            lines.push(
                `Remote warning: collection description unavailable (${probe.descriptionError}).`,
            );
        }

        if (!manifestRead || !manifestRead.available) {
            lines.push(
                "Remote manifest: unavailable. This vector database implementation cannot report precise remote file-level status without legacy repair support.",
            );
        } else if (manifestRead.error) {
            lines.push(`Remote manifest: read failed (${manifestRead.error}).`);
        } else if (!manifestRead.manifest) {
            lines.push(
                "Remote manifest: missing. Run repair_index_manifest for this codebase to migrate legacy remote status; status will not scan chunk metadata automatically.",
            );
        } else {
            const manifest = manifestRead.manifest;
            lines.push(
                `Remote manifest: ${manifest.status}, ${manifest.indexedFiles} files, ${manifest.totalChunks} chunks, generation ${manifest.generation}, updated ${manifest.updatedAt}.`,
            );
            if (
                probe.rowCount !== undefined &&
                probe.rowCount >= 0 &&
                probe.rowCount !== manifest.totalChunks
            ) {
                lines.push(
                    `Remote warning: collection row count ${probe.rowCount} does not match manifest totalChunks ${manifest.totalChunks}.`,
                );
            }
        }

        return lines.join("\n");
    }

    /**
     * One-shot startup validation: find any legacy 0/0+completed entries on disk
     * (left over from old MCP versions, v1 snapshot migrations, or pre-fix recovery
     * paths) and either heal them with the real Milvus row count or remove them
     * if the underlying collection is empty/missing. See Issue #295.
     *
     * Safe to call multiple times but intended to run once per server start after
     * loadCodebaseSnapshot(). Errors are caught and logged; never throws.
     */
    private getIndexedCodebasesForValidation(targetCodebasePath?: string): string[] {
        if (!targetCodebasePath) {
            return this.snapshotManager.getIndexedCodebases();
        }

        const indexedCodebasePath =
            this.snapshotManager.findIndexedCodebasePath(targetCodebasePath);
        return indexedCodebasePath ? [indexedCodebasePath] : [];
    }

    public async validateLegacyZeroEntries(
        targetCodebasePath?: string,
    ): Promise<void> {
        try {
            const indexedCodebases =
                this.getIndexedCodebasesForValidation(targetCodebasePath);
            let healed = 0,
                removed = 0,
                skipped = 0,
                checked = 0;

            for (const codebasePath of indexedCodebases) {
                const info = this.snapshotManager.getCodebaseInfo(codebasePath);
                if (!info || info.status !== "indexed") continue;
                // Only validate suspiciously-zero entries
                if (info.indexedFiles !== 0 || info.totalChunks !== 0) continue;

                checked++;
                const collectionName =
                    this.context.getCollectionName(codebasePath);
                const vdb = this.context.getVectorDatabase();

                // First probe: does the collection even exist? A "no" here is
                // authoritative (permanent orphan), while a throw is most likely
                // transient (Milvus unreachable) — keep those two cases distinct
                // so we don't destroy real state on a network blip.
                let collectionExists: boolean;
                try {
                    collectionExists = await this.withVectorDatabaseSyncTimeout(
                        `snapshot validation hasCollection(${collectionName})`,
                        vdb.hasCollection(collectionName),
                    );
                } catch (err) {
                    console.warn(
                        `[SNAPSHOT-VALIDATE] hasCollection failed for '${codebasePath}' (likely transient), skipping:`,
                        err,
                    );
                    skipped++;
                    continue;
                }

                if (!collectionExists) {
                    // Permanent orphan — no matching Milvus collection, so the
                    // 0/0+completed snapshot entry is a pure phantom. Remove it.
                    this.snapshotManager.removeCodebaseCompletely(codebasePath);
                    removed++;
                    console.warn(
                        `[SNAPSHOT-VALIDATE] Removed orphan 0/0 entry '${codebasePath}' — no matching Milvus collection`,
                    );
                    continue;
                }

                // Collection exists — get an accurate row count.
                let rowCount: number;
                try {
                    rowCount = await this.withVectorDatabaseSyncTimeout(
                        `snapshot validation getCollectionRowCount(${collectionName})`,
                        vdb.getCollectionRowCount(collectionName),
                    );
                } catch (err) {
                    console.warn(
                        `[SNAPSHOT-VALIDATE] getCollectionRowCount failed for '${codebasePath}', skipping:`,
                        err,
                    );
                    skipped++;
                    continue;
                }

                if (rowCount > 0) {
                    const manifestRead = await this.readRemoteIndexManifest(
                        collectionName,
                        codebasePath,
                    );
                    if (!manifestRead.manifest) {
                        skipped++;
                        console.warn(
                            `[SNAPSHOT-VALIDATE] Collection '${collectionName}' has rows, but remote manifest is missing for '${codebasePath}'. Run repair_index_manifest to migrate legacy status.`,
                        );
                        continue;
                    }
                    this.snapshotManager.setCodebaseIndexed(codebasePath, {
                        indexedFiles: manifestRead.manifest.indexedFiles,
                        totalChunks: manifestRead.manifest.totalChunks,
                        status: manifestRead.manifest.status,
                    });
                    healed++;
                    console.log(
                        `[SNAPSHOT-VALIDATE] Healed legacy 0/0 entry '${codebasePath}' from remote manifest → chunks=${manifestRead.manifest.totalChunks}`,
                    );
                } else if (rowCount === 0) {
                    // Collection exists but truly empty — the 0/0+completed entry
                    // is a phantom. Remove so the user must explicitly reindex.
                    this.snapshotManager.removeCodebaseCompletely(codebasePath);
                    removed++;
                    console.warn(
                        `[SNAPSHOT-VALIDATE] Removed phantom 0/0 entry '${codebasePath}' — collection exists but empty`,
                    );
                } else {
                    // rowCount === -1 despite the collection existing: the count
                    // query failed after the existence probe succeeded. Treat as
                    // transient and leave the entry alone.
                    skipped++;
                    console.warn(
                        `[SNAPSHOT-VALIDATE] Row count unavailable for existing collection '${codebasePath}', skipping`,
                    );
                }
            }

            if (healed > 0 || removed > 0) {
                await this.snapshotManager.saveCodebaseSnapshotAsync();
            }
            if (checked > 0) {
                console.log(
                    `[SNAPSHOT-VALIDATE] Done — checked=${checked} healed=${healed} removed=${removed} skipped=${skipped}`,
                );
            }
        } catch (error) {
            console.warn(
                `[SNAPSHOT-VALIDATE] Unexpected error during legacy 0/0 validation (non-fatal):`,
                error,
            );
        }
    }

    /**
     * Validate every indexed snapshot entry against the backing vector DB.
     * A restart can load stale local state after the remote collection was
     * deleted; remove those entries before clients can report them searchable.
     */
    public async validateIndexedCollections(
        targetCodebasePath?: string,
    ): Promise<void> {
        try {
            const indexedCodebases =
                this.getIndexedCodebasesForValidation(targetCodebasePath);
            let removed = 0,
                skipped = 0,
                checked = 0;

            for (const codebasePath of indexedCodebases) {
                checked++;
                const collectionName =
                    this.context.getCollectionName(codebasePath);
                let collectionExists: boolean;

                try {
                    collectionExists = await this.withVectorDatabaseSyncTimeout(
                        `snapshot reconciliation hasCollection(${collectionName})`,
                        this.context
                            .getVectorDatabase()
                            .hasCollection(collectionName),
                    );
                } catch (error) {
                    skipped++;
                    console.warn(
                        `[SNAPSHOT-RECONCILE] hasCollection failed for '${codebasePath}' (leaving snapshot entry unchanged):`,
                        error,
                    );
                    continue;
                }

                if (!collectionExists) {
                    this.snapshotManager.removeCodebaseCompletely(codebasePath);
                    removed++;
                    console.warn(
                        `[SNAPSHOT-RECONCILE] Removed stale indexed entry '${codebasePath}' — collection '${collectionName}' is missing`,
                    );
                }
            }

            if (removed > 0) {
                await this.snapshotManager.saveCodebaseSnapshotAsync();
            }
            if (checked > 0) {
                console.log(
                    `[SNAPSHOT-RECONCILE] Done — checked=${checked} removed=${removed} skipped=${skipped}`,
                );
            }
        } catch (error) {
            console.warn(
                `[SNAPSHOT-RECONCILE] Unexpected error during indexed collection validation (non-fatal):`,
                error,
            );
        }
    }

    /**
     * Sync indexed codebases from vector database collections.
     * This method fetches all collections from the vector database,
     * extracts codebasePath from collection description (preferred) or falls back
     * to querying document metadata for old collections,
     * and updates the snapshot with discovered codebases.
     *
     * Logic: Compare mcp-codebase-snapshot.json with vector database collections
     * - If local snapshot has extra directories (not in vector database), remove them
     * - If local snapshot is missing directories (exist in vector database), recover them
     */
    private async syncIndexedCodebasesFromVectorDatabase(): Promise<void> {
        try {
            console.log(
                `[SYNC-VDB] Syncing indexed codebases from vector database...`,
            );

            // Get all collections using the interface method
            const vectorDb = this.context.getVectorDatabase();

            // Use the new listCollections method from the interface
            const collections = await this.withVectorDatabaseSyncTimeout(
                "Milvus listCollections during vector database sync",
                vectorDb.listCollections(),
            );

            console.log(
                `[SYNC-VDB] Found ${collections.length} collections in vector database`,
            );

            if (collections.length === 0) {
                console.log(
                    `[SYNC-VDB] No collections found in vector database. Skipping deletion of local codebases to avoid data loss from transient errors.`,
                );
                return;
            }

            const vectorDatabaseCodebases = new Set<string>();
            const collectionsWithIncompletePathExtraction = new Set<string>();
            const remoteManifestsByCodebase = new Map<string, RemoteIndexManifest>();
            let codeCollectionsChecked = 0;
            let successfulExtractions = 0;

            // Check each collection for codebase path
            for (const collectionName of collections) {
                try {
                    // Skip collections that don't match the code_chunks pattern (support both legacy and new collections)
                    if (
                        !collectionName.startsWith("code_chunks_") &&
                        !collectionName.startsWith("hybrid_code_chunks_")
                    ) {
                        console.log(
                            `[SYNC-VDB] Skipping non-code collection: ${collectionName}`,
                        );
                        continue;
                    }

                    codeCollectionsChecked++;
                    console.log(
                        `[SYNC-VDB] Checking collection: ${collectionName}`,
                    );

                    let describedCodebasePath: string | null = null;

                    // Try to extract codebasePath from collection description.
                    // Legacy row metadata scans are intentionally not run here;
                    // old collections without manifests require repair_index_manifest.
                    try {
                        const description =
                            await this.withVectorDatabaseSyncTimeout(
                                `Milvus getCollectionDescription(${collectionName}) during vector database sync`,
                                vectorDb.getCollectionDescription(
                                    collectionName,
                                ),
                            );
	                        if (
	                            description &&
	                            description.startsWith("codebasePath:")
	                        ) {
	                            describedCodebasePath = description
	                                .split(/\r?\n/, 1)[0]
	                                .substring("codebasePath:".length);
	                            if (describedCodebasePath.length > 0) {
	                                console.log(
	                                    `[SYNC-VDB] Found codebase path from description: ${describedCodebasePath} in collection: ${collectionName}`,
	                                );
	                            }
	                        }
                    } catch (descError: any) {
                        console.warn(
                            `[SYNC-VDB] Failed to get description for collection ${collectionName}:`,
                            descError.message || descError,
                        );
                    }

                    if (describedCodebasePath) {
                        vectorDatabaseCodebases.add(describedCodebasePath);
                        const manifestRead = await this.readRemoteIndexManifest(
                            collectionName,
                            describedCodebasePath,
                        );
                        if (manifestRead.manifest) {
                            remoteManifestsByCodebase.set(
                                describedCodebasePath,
                                manifestRead.manifest,
                            );
                            successfulExtractions++;
                            continue;
                        }

                        collectionsWithIncompletePathExtraction.add(
                            collectionName,
                        );
                        console.warn(
                            `[SYNC-VDB] Remote manifest missing for '${describedCodebasePath}' in '${collectionName}'. Skipping implicit legacy metadata scan; run repair_index_manifest to migrate.`,
                        );
                        continue;
                    }

                    collectionsWithIncompletePathExtraction.add(collectionName);
                    console.warn(
                        `[SYNC-VDB] Collection '${collectionName}' has no description codebasePath. Skipping implicit legacy metadata scan; run repair_index_manifest with the owning path if this is an old collection.`,
                    );
                } catch (collectionError: any) {
                    console.warn(
                        `[SYNC-VDB] Error checking collection ${collectionName}:`,
                        collectionError.message || collectionError,
                    );
                    // Continue with next collection
                }
            }

            console.log(
                `[SYNC-VDB] Found ${vectorDatabaseCodebases.size} valid codebases in vector database (checked ${codeCollectionsChecked} code collections, ${successfulExtractions} successfully extracted)`,
            );

            // Safety guard: if we checked code collections but none returned results,
            // treat this as an extraction failure rather than "vector database is empty".
            // This prevents deleting all local codebases due to transient errors.
            if (codeCollectionsChecked > 0 && successfulExtractions === 0) {
                console.warn(
                    `[SYNC-VDB] All ${codeCollectionsChecked} code collection extractions failed. Skipping sync to avoid accidental deletion of local codebases.`,
                );
                return;
            }

            // Get current local codebases
            const localCodebases = new Set(
                this.snapshotManager.getIndexedCodebases(),
            );
            console.log(
                `[SYNC-VDB] Found ${localCodebases.size} local codebases in snapshot`,
            );

            let hasChanges = false;

            // Remove local codebases that don't exist in the vector database.
            for (const localCodebase of localCodebases) {
                if (!vectorDatabaseCodebases.has(localCodebase)) {
                    const localCollectionName =
                        this.context.getCollectionName(localCodebase);
                    if (
                        collectionsWithIncompletePathExtraction.has(
                            localCollectionName,
                        )
                    ) {
                        console.warn(
                            `[SYNC-VDB] Keeping local codebase '${localCodebase}' because collection '${localCollectionName}' could not be fully enumerated`,
                        );
                        continue;
                    }

                    this.snapshotManager.removeCodebaseCompletely(
                        localCodebase,
                    );
                    hasChanges = true;

                    try {
                        await FileSynchronizer.deleteSnapshot(localCodebase);
                    } catch (error: any) {
                        console.warn(
                            `[SYNC-VDB] Failed to delete local merkle snapshot for removed codebase '${localCodebase}':`,
                            error?.message || error,
                        );
                    }

                    console.log(
                        `[SYNC-VDB] Removed local codebase (not in vector database): ${localCodebase}`,
                    );
                }
            }

            // Add vector database codebases that are missing from local snapshot (recovery).
            // Query Milvus for the real row count — if unknown/empty, skip the write
            // so we don't persist a poisoning 0/0+completed entry (Issue #295).
            for (const vectorDatabaseCodebase of vectorDatabaseCodebases) {
                if (!localCodebases.has(vectorDatabaseCodebase)) {
                    const indexingCodebase =
                        this.snapshotManager.findIndexingCodebasePath(
                            vectorDatabaseCodebase,
                        );
                    if (indexingCodebase !== undefined) {
                        console.log(
                            `[SYNC-VDB] Skipped recovery for ${vectorDatabaseCodebase} because '${indexingCodebase}' is currently indexing`,
                        );
                        continue;
                    }

                    const manifest =
                        remoteManifestsByCodebase.get(vectorDatabaseCodebase);
                    if (manifest) {
                        this.snapshotManager.setCodebaseIndexed(
                            vectorDatabaseCodebase,
                            {
                                indexedFiles: manifest.indexedFiles,
                                totalChunks: manifest.totalChunks,
                                status: manifest.status,
                            },
                        );
                        hasChanges = true;
                        console.log(
                            `[SYNC-VDB] Recovered codebase from remote manifest: ${vectorDatabaseCodebase} (chunks=${manifest.totalChunks})`,
                        );
                    } else {
                        console.log(
                            `[SYNC-VDB] Skipped recovery for ${vectorDatabaseCodebase} (remote manifest missing)`,
                        );
                    }
                }
            }

            if (hasChanges) {
                await this.snapshotManager.saveCodebaseSnapshotAsync();
                console.log(
                    `[SYNC-VDB] Updated snapshot to match vector database state`,
                );
            } else {
                console.log(
                    `[SYNC-VDB] Local snapshot already matches vector database state`,
                );
            }

            console.log(
                `[SYNC-VDB] Vector database sync completed successfully`,
            );
        } catch (error: any) {
            console.error(
                `[SYNC-VDB] Error syncing codebases from vector database:`,
                error.message || error,
            );
            // Don't throw - this is not critical for the main functionality
        }
    }

    private async syncTargetCodebaseFromVectorDatabase(
        codebasePath: string,
    ): Promise<RemoteCollectionProbe | null> {
        try {
            if (
                typeof (this.context as any).getCollectionName !== "function" ||
                typeof (this.context as any).getVectorDatabase !== "function"
            ) {
                return null;
            }
            const collectionName = this.context.getCollectionName(codebasePath);
            const vectorDatabase = this.context.getVectorDatabase();
            if (
                typeof vectorDatabase?.hasCollection !== "function" ||
                typeof vectorDatabase?.getCollectionDescription !== "function" ||
                typeof vectorDatabase?.getCollectionRowCount !== "function"
            ) {
                return null;
            }

            console.log(
                `[SYNC-VDB] Syncing target codebase '${codebasePath}' from collection '${collectionName}'...`,
            );

            let probe: RemoteCollectionProbe;
            try {
                probe = await this.getRemoteCollectionProbe(collectionName);
            } catch (error: any) {
                console.warn(
                    `[SYNC-VDB] Failed to check target collection '${collectionName}':`,
                    error.message || error,
                );
                return null;
            }

            const trackedCodebasePath =
                this.snapshotManager.findTrackedCodebasePath(codebasePath);
            if (!probe.exists) {
                if (trackedCodebasePath) {
                    this.snapshotManager.removeCodebaseCompletely(
                        trackedCodebasePath,
                    );
                    await this.snapshotManager.saveCodebaseSnapshotAsync();
                    try {
                        await FileSynchronizer.deleteSnapshot(
                            trackedCodebasePath,
                        );
                    } catch (error: any) {
                        console.warn(
                            `[SYNC-VDB] Failed to delete local merkle snapshot for removed codebase '${trackedCodebasePath}':`,
                            error?.message || error,
                        );
                    }
                    console.warn(
                        `[SYNC-VDB] Removed stale local codebase '${trackedCodebasePath}' because collection '${collectionName}' is missing`,
                    );
                }
                return probe;
            }

            const describedCodebasePath =
                this.parseCollectionDescriptionCodebasePath(probe.description);
            if (
                trackedCodebasePath &&
                describedCodebasePath &&
                describedCodebasePath !== trackedCodebasePath &&
                this.snapshotManager.getCodebaseStatus(trackedCodebasePath) ===
                    "indexed"
            ) {
                console.warn(
                    `[SYNC-VDB] Collection '${collectionName}' description points at '${describedCodebasePath}', not tracked codebase '${trackedCodebasePath}'. Keeping local status until explicit repair.`,
                );
                return probe;
            }

            const manifestRead = await this.readRemoteIndexManifest(
                collectionName,
                codebasePath,
            );
            if (!manifestRead.manifest) {
                if (manifestRead.error) {
                    console.warn(
                        `[SYNC-VDB] Remote manifest read failed for '${codebasePath}': ${manifestRead.error}`,
                    );
                } else {
                console.warn(
                        `[SYNC-VDB] Remote manifest missing for '${codebasePath}'. Skipping implicit legacy metadata scan; run repair_index_manifest if this is an old collection.`,
                    );
                }
                return probe;
            }

            if (
                this.snapshotManager.findTrackedCodebasePath(codebasePath) ===
                undefined
            ) {
                this.snapshotManager.setCodebaseIndexed(codebasePath, {
                    indexedFiles: manifestRead.manifest.indexedFiles,
                    totalChunks: manifestRead.manifest.totalChunks,
                    status: manifestRead.manifest.status,
                });
                await this.snapshotManager.saveCodebaseSnapshotAsync();
            }
            return probe;
        } catch (error: any) {
            console.error(
                `[SYNC-VDB] Error syncing target codebase from vector database:`,
                error.message || error,
            );
            return null;
        }
    }

    public async handleIndexCodebase(args: any): Promise<any> {
        const validation = this.validateRequiredStringArgs(
            "index_codebase",
            args,
            ["path"],
        );
        if (validation.error) {
            return validation.error;
        }
        const arrayValidation = this.validateOptionalStringArrayArgs(
            "index_codebase",
            args,
            ["customExtensions", "ignorePatterns", "ignoreFiles"],
        );
        if (arrayValidation.error) {
            return arrayValidation.error;
        }

        const {
            path: codebasePath,
            force,
            splitter,
            maxDepth,
            dryRun,
            incremental,
        } = args;
        const normalizedForce = this.normalizeOptionalBooleanArg(
            "index_codebase",
            "force",
            force,
        );
        if (normalizedForce.error) {
            return normalizedForce.error;
        }
        const normalizedIncremental = this.normalizeOptionalBooleanArg(
            "index_codebase",
            "incremental",
            incremental,
        );
        if (normalizedIncremental.error) {
            return normalizedIncremental.error;
        }
        const normalizedDryRun = this.normalizeOptionalBooleanArg(
            "index_codebase",
            "dryRun",
            dryRun,
        );
        if (normalizedDryRun.error) {
            return normalizedDryRun.error;
        }
        const normalizedMaxDepth = this.normalizeOptionalNonNegativeIntegerArg(
            "index_codebase",
            "maxDepth",
            maxDepth,
        );
        if (normalizedMaxDepth.error) {
            return normalizedMaxDepth.error;
        }
        const forceReindex = normalizedForce.value === true;
        const incrementalIndex = normalizedIncremental.value === true;
        const dryRunEnabled = normalizedDryRun.value === true;
        const splitterWasProvided = typeof splitter === "string";
        const explicitSplitter = splitterWasProvided
            ? splitter.trim()
            : undefined;
        const customFileExtensions = this.normalizeStringArray(
            args.customExtensions,
        );
        const customIgnorePatterns = this.normalizeStringArray(
            args.ignorePatterns,
        );
        const customIgnoreFiles = this.normalizeStringArray(args.ignoreFiles);
        const customFileExtensionsProvided = Array.isArray(
            args.customExtensions,
        );
        const customIgnorePatternsProvided = Array.isArray(args.ignorePatterns);
        const customIgnoreFilesProvided = Array.isArray(args.ignoreFiles);
        const requestMaxDepth = normalizedMaxDepth.value;
        const requestMaxDepthProvided = requestMaxDepth !== undefined;

        try {
            if (incrementalIndex && forceReindex) {
                return this.errorResponse(
                    "Error: index_codebase arguments 'incremental' and 'force' are mutually exclusive. Use incremental=true for ordinary manual sync of added, modified, removed, or newly ignored files. Use force=true only when a full rebuild is required, such as after embedding/schema/splitter compatibility changes or when index state is not trustworthy.",
                );
            }
            if (incrementalIndex && dryRunEnabled) {
                return this.errorResponse(
                    "Error: index_codebase incremental=true cannot be combined with dryRun=true.",
                );
            }
            if (splitter !== undefined && typeof splitter !== "string") {
                return this.errorResponse(
                    "Error: index_codebase argument 'splitter' must be 'ast' or 'langchain' when provided.",
                );
            }

            // Validate splitter parameter
            if (
                explicitSplitter !== undefined &&
                !isRequestSplitterType(explicitSplitter)
            ) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: Invalid splitter type '${explicitSplitter}'. Must be 'ast' or 'langchain'.`,
                        },
                    ],
                    isError: true,
                };
            }
            const absolutePath = requireAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`,
                        },
                    ],
                    isError: true,
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: Path '${absolutePath}' is not a directory`,
                        },
                    ],
                    isError: true,
                };
            }

            const configuredSplitter = configManager.getString(
                "splitterType",
                absolutePath,
            );
            if (
                configuredSplitter !== undefined &&
                !isRequestSplitterType(configuredSplitter)
            ) {
                console.warn(
                    `[INDEX] Ignoring invalid config.splitterType value '${configuredSplitter}' for '${absolutePath}'. Falling back to ast unless the tool request overrides it.`,
                );
            }
            const splitterType: RequestSplitterType =
                explicitSplitter ??
                (isRequestSplitterType(configuredSplitter)
                    ? configuredSplitter
                    : "ast");
            const indexOptions: CodebaseIndexOptions = {
                requestSplitter: splitterType,
                requestCustomExtensions: customFileExtensions,
                requestIgnorePatterns: customIgnorePatterns,
                requestIgnoreFiles: customIgnoreFiles,
                requestMaxDepth,
            };

            if (dryRunEnabled) {
                const preview = await this.context.previewIndexableFiles(
                    absolutePath,
                    customIgnorePatterns,
                    customFileExtensions,
                    {
                        additionalIgnoreFiles: customIgnoreFiles,
                        maxDepth: requestMaxDepth,
                    },
                );
                const pathInfo =
                    codebasePath !== absolutePath
                        ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                        : "";
                const sampleText =
                    preview.files.length > 0
                        ? preview.files
                              .map(
                                  (file: string, index: number) =>
                                      `${index + 1}. ${file}`,
                              )
                              .join("\n")
                        : "No files matched the current indexing rules.";
                const truncatedInfo =
                    preview.totalFiles > preview.files.length
                        ? `\nShowing first ${preview.files.length} of ${preview.totalFiles} file(s).`
                        : "";

                return {
                    content: [
                        {
                            type: "text",
                            text: `Dry run for codebase '${absolutePath}'.${pathInfo}\nMatched ${preview.totalFiles} file(s).${truncatedInfo}\n\n${sampleText}`,
                        },
                    ],
                };
            }

            if (!this.isInteractiveIndexingEnabled()) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Error: Interactive indexing is disabled by config.interactiveIndexing=false. Run index_codebase with dryRun=true to inspect matching files.",
                        },
                    ],
                    isError: true,
                };
            }

            const writerLock = this.acquireManualWriterLock(
                `index_codebase for '${absolutePath}'`,
                this.getCollectionWriterLockScope(absolutePath),
            );
            if (!(writerLock instanceof McpWriterLock)) {
                return writerLock;
            }
            let releaseWriterLockAfterReturn = true;

            try {
                // Sync indexed codebases from the vector database first.
                await this.syncTargetCodebaseFromVectorDatabase(absolutePath);

                return await this.withIndexingStateLock(
                    absolutePath,
                    async () => {
                        if (this.indexingTasks.has(absolutePath)) {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Codebase '${absolutePath}' is already being indexed in the background. Please wait for completion.`,
                                    },
                                ],
                                isError: true,
                            };
                        }

                        // Check if already indexing
                        if (
                            this.snapshotManager
                                .getIndexingCodebases()
                                .includes(absolutePath)
                        ) {
                            if (forceReindex) {
                                console.log(
                                    `[FORCE-REINDEX] Clearing stale indexing state for '${absolutePath}'`,
                                );
                                this.snapshotManager.removeCodebaseCompletely(
                                    absolutePath,
                                );
                                await this.snapshotManager.saveCodebaseSnapshotAsync();
                            } else {
                                return {
                                    content: [
                                        {
                                            type: "text",
                                            text: `Codebase '${absolutePath}' is already being indexed in the background. Please wait for completion.`,
                                        },
                                    ],
                                    isError: true,
                                };
                            }
                        }

                        // Check if the snapshot and vector database index are in sync.
                        const snapshotHasIndex = this.snapshotManager
                            .getIndexedCodebases()
                            .includes(absolutePath);
                        const vectorDbHasIndex =
                            await this.context.hasIndex(absolutePath);
                        if (snapshotHasIndex !== vectorDbHasIndex) {
                            if (vectorDbHasIndex && !snapshotHasIndex) {
                                const collectionName =
                                    this.context.getCollectionName(absolutePath);
                                const manifestRead =
                                    await this.readRemoteIndexManifest(
                                        collectionName,
                                        absolutePath,
                                    );
                                if (manifestRead.manifest) {
                                    console.warn(
                                        `[INDEX-VALIDATION] Recovering missing snapshot for '${absolutePath}' from remote manifest (chunks=${manifestRead.manifest.totalChunks})`,
                                    );
                                    this.snapshotManager.setCodebaseIndexed(
                                        absolutePath,
                                        {
                                            indexedFiles:
                                                manifestRead.manifest.indexedFiles,
                                            totalChunks:
                                                manifestRead.manifest.totalChunks,
                                            status: manifestRead.manifest.status,
                                        },
                                    );
                                    await this.snapshotManager.saveCodebaseSnapshotAsync();
                                } else {
                                    console.warn(
                                        `[INDEX-VALIDATION] VectorDB reports index for '${absolutePath}' but remote manifest is missing — not running implicit legacy metadata scan. Run repair_index_manifest if this is an old collection.`,
                                    );
                                }
                            } else if (!vectorDbHasIndex && snapshotHasIndex) {
                                console.warn(
                                    `[INDEX-VALIDATION] Clearing stale snapshot for '${absolutePath}'`,
                                );
                                this.snapshotManager.removeCodebaseCompletely(
                                    absolutePath,
                                );
                                await this.snapshotManager.saveCodebaseSnapshotAsync();
                            }
                        }

                        if (incrementalIndex) {
                            return await this.handleManualIncrementalIndexing(
                                absolutePath,
                                codebasePath,
                                splitterType,
                                {
                                    splitterWasProvided,
                                    customFileExtensions,
                                    customIgnorePatterns,
                                    customIgnoreFiles,
                                    customFileExtensionsProvided,
                                    customIgnorePatternsProvided,
                                    customIgnoreFilesProvided,
                                    requestMaxDepth,
                                    requestMaxDepthProvided,
                                },
                            );
                        }

                        // Check if already indexed (unless force is true)
                        if (
                            !forceReindex &&
                            this.snapshotManager
                                .getIndexedCodebases()
                                .includes(absolutePath)
                        ) {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Codebase '${absolutePath}' is already indexed. Use incremental=true to manually sync added, modified, removed, or newly ignored files without rebuilding. Use force=true only when a full rebuild is required, such as after embedding/schema/splitter compatibility changes or when index state is not trustworthy.`,
                                    },
                                ],
                                isError: true,
                            };
                        }

                        // If force reindex and codebase is already indexed, remove it
                        if (forceReindex) {
                            this.snapshotManager.removeCodebaseCompletely(
                                absolutePath,
                            );
                            await this.snapshotManager.saveCodebaseSnapshotAsync();
                            console.log(
                                `[FORCE-REINDEX] Clearing index for '${absolutePath}'`,
                            );
                            await this.context.clearIndex(absolutePath);
                        }

                        // CRITICAL: Pre-index collection creation validation
                        try {
                            console.log(
                                `[INDEX-VALIDATION] Validating collection creation capability`,
                            );
                            const canCreateCollection = await this.context
                                .getVectorDatabase()
                                .checkCollectionLimit();

                            if (!canCreateCollection) {
                                console.error(
                                    `[INDEX-VALIDATION] Collection limit validation failed: ${absolutePath}`,
                                );

                                // CRITICAL: Immediately return the COLLECTION_LIMIT_MESSAGE to MCP client
                                return {
                                    content: [
                                        {
                                            type: "text",
                                            text: COLLECTION_LIMIT_MESSAGE,
                                        },
                                    ],
                                    isError: true,
                                };
                            }

                            console.log(
                                `[INDEX-VALIDATION] Collection creation validation completed`,
                            );
                        } catch (validationError: any) {
                            // Handle other collection creation errors
                            console.error(
                                `[INDEX-VALIDATION] Collection creation validation failed:`,
                                validationError,
                            );
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Error validating collection creation: ${validationError.message || validationError}`,
                                    },
                                ],
                                isError: true,
                            };
                        }

                        if (customFileExtensions.length > 0) {
                            console.log(
                                `[CUSTOM-EXTENSIONS] Using ${customFileExtensions.length} request-scoped custom extensions: ${customFileExtensions.join(", ")}`,
                            );
                        }

                        // Check current status and log if retrying after failure
                        const currentStatus =
                            this.snapshotManager.getCodebaseStatus(
                                absolutePath,
                            );
                        if (currentStatus === "indexfailed") {
                            const failedInfo =
                                this.snapshotManager.getCodebaseInfo(
                                    absolutePath,
                                ) as any;
                            console.log(
                                `[BACKGROUND-INDEX] Retrying indexing for previously failed codebase. Previous error: ${failedInfo?.errorMessage || "Unknown error"}`,
                            );
                        }

                        // Set to indexing status and save snapshot immediately
                        this.snapshotManager.setCodebaseIndexing(
                            absolutePath,
                            0,
                            indexOptions,
                        );
                        await this.snapshotManager.saveCodebaseSnapshotAsync();

                        // Track the codebase path for syncing
                        trackCodebasePath(absolutePath);

                        // Start background indexing - now safe to proceed.
                        // Track the controller + promise so clear_index can cancel and
                        // await us before dropping the underlying collection.
                        const controller = new AbortController();
                        const promise = this.startBackgroundIndexing(
                            absolutePath,
                            forceReindex,
                            splitterType,
                            customIgnorePatterns,
                            customFileExtensions,
                            customIgnoreFiles,
                            requestMaxDepth,
                            indexOptions,
                            controller.signal,
                        ).finally(() => {
                            // Only clear the entry if it still points at this run — a
                            // concurrent re-index may have replaced us.
                            const current =
                                this.indexingTasks.get(absolutePath);
                            if (current && current.controller === controller) {
                                this.indexingTasks.delete(absolutePath);
                            }
                            writerLock.release();
                        });
                        this.indexingTasks.set(absolutePath, {
                            controller,
                            promise,
                        });
                        releaseWriterLockAfterReturn = false;

                        const pathInfo =
                            codebasePath !== absolutePath
                                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                                : "";

                        const extensionInfo =
                            customFileExtensions.length > 0
                                ? `\nUsing ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(", ")}`
                                : "";

                        const ignoreInfo =
                            customIgnorePatterns.length > 0
                                ? `\nUsing ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(", ")}`
                                : "";
                        const ignoreFilesInfo =
                            customIgnoreFiles.length > 0
                                ? `\nUsing ${customIgnoreFiles.length} custom ignore files: ${customIgnoreFiles.join(", ")}`
                                : "";
                        const maxDepthInfo =
                            requestMaxDepth !== undefined
                                ? `\nLimiting traversal to maxDepth=${requestMaxDepth}`
                                : "";

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Started background indexing for codebase '${absolutePath}' using ${splitterType.toUpperCase()} splitter.${pathInfo}${extensionInfo}${ignoreInfo}${ignoreFilesInfo}${maxDepthInfo}\n\nIndexing is running in the background. You can search the codebase while indexing is in progress, but results may be incomplete until indexing completes.`,
                                },
                            ],
                        };
                    },
                );
            } finally {
                if (releaseWriterLockAfterReturn) {
                    writerLock.release();
                }
            }
        } catch (error: any) {
            // Enhanced error handling to prevent MCP service crash
            console.error("Error in handleIndexCodebase:", error);

            // Ensure we always return a proper MCP response, never throw
            return {
                content: [
                    {
                        type: "text",
                        text: `Error starting indexing: ${error.message || error}`,
                    },
                ],
                isError: true,
            };
        }
    }

    private async handleManualIncrementalIndexing(
        absolutePath: string,
        originalPath: string,
        requestedSplitter: RequestSplitterType,
        options: {
            splitterWasProvided: boolean;
            customFileExtensions: string[];
            customIgnorePatterns: string[];
            customIgnoreFiles: string[];
            customFileExtensionsProvided: boolean;
            customIgnorePatternsProvided: boolean;
            customIgnoreFilesProvided: boolean;
            requestMaxDepth?: number;
            requestMaxDepthProvided: boolean;
        },
    ): Promise<any> {
        const info = this.snapshotManager.getCodebaseInfo(absolutePath);
        if (!info || info.status !== "indexed") {
            return this.notIndexedResponse(absolutePath);
        }

        const splitterType = options.splitterWasProvided
            ? requestedSplitter
            : resolveRequestSplitterType(info.requestSplitter);
        const ignorePatterns = options.customIgnorePatternsProvided
            ? options.customIgnorePatterns
            : info.requestIgnorePatterns || [];
        const customExtensions = options.customFileExtensionsProvided
            ? options.customFileExtensions
            : info.requestCustomExtensions || [];
        const ignoreFiles = options.customIgnoreFilesProvided
            ? options.customIgnoreFiles
            : info.requestIgnoreFiles || [];
        const maxDepth = options.requestMaxDepthProvided
            ? options.requestMaxDepth
            : info.requestMaxDepth;

        const stats = await this.context.reindexByChange(
            absolutePath,
            undefined,
            ignorePatterns,
            customExtensions,
            createRequestSplitter(splitterType),
            ignoreFiles,
            maxDepth,
            { skipEffectiveLineLimit: true },
        );

        if (stats.added > 0 || stats.removed > 0 || stats.modified > 0) {
            this.snapshotManager.markCodebaseSynced(absolutePath, stats);
        } else {
            this.snapshotManager.clearCodebaseSyncWarning(absolutePath);
        }
        await this.snapshotManager.saveCodebaseSnapshotAsync();
        this.trackIndexedCodebase(absolutePath);

        const pathInfo =
            originalPath !== absolutePath
                ? `\nNote: Input path '${originalPath}' was resolved to absolute path '${absolutePath}'`
                : "";
        const optionInfo = [
            `splitter=${splitterType}`,
            customExtensions.length > 0
                ? `customExtensions=${customExtensions.join(", ")}`
                : null,
            ignorePatterns.length > 0
                ? `ignorePatterns=${ignorePatterns.join(", ")}`
                : null,
            ignoreFiles.length > 0
                ? `ignoreFiles=${ignoreFiles.join(", ")}`
                : null,
            maxDepth !== undefined ? `maxDepth=${maxDepth}` : null,
        ]
            .filter((item): item is string => item !== null)
            .join("; ");

        return {
            content: [
                {
                    type: "text",
                    text: `Manual incremental indexing completed for '${absolutePath}'.${pathInfo}\nChanges: Added ${stats.added}, Removed ${stats.removed}, Modified ${stats.modified}.\nOptions: ${optionInfo}`,
                },
            ],
        };
    }

    private async startBackgroundIndexing(
        codebasePath: string,
        forceReindex: boolean,
        splitterType: RequestSplitterType,
        customIgnorePatterns: string[] = [],
        customFileExtensions: string[] = [],
        customIgnoreFiles: string[] = [],
        requestMaxDepth?: number,
        indexOptions?: CodebaseIndexOptions,
        signal?: AbortSignal,
    ): Promise<void> {
        if (this.context instanceof Context) {
            await this.startWorkerBackgroundIndexing(
                codebasePath,
                forceReindex,
                splitterType,
                customIgnorePatterns,
                customFileExtensions,
                customIgnoreFiles,
                requestMaxDepth,
                indexOptions,
                signal,
            );
            return;
        }

        await this.startInlineBackgroundIndexing(
            codebasePath,
            forceReindex,
            splitterType,
            customIgnorePatterns,
            customFileExtensions,
            customIgnoreFiles,
            requestMaxDepth,
            indexOptions,
            signal,
        );
    }

    private async startInlineBackgroundIndexing(
        codebasePath: string,
        forceReindex: boolean,
        splitterType: RequestSplitterType,
        customIgnorePatterns: string[] = [],
        customFileExtensions: string[] = [],
        customIgnoreFiles: string[] = [],
        requestMaxDepth?: number,
        indexOptions?: CodebaseIndexOptions,
        signal?: AbortSignal,
    ): Promise<void> {
        const absolutePath = codebasePath;
        let lastSaveTime = 0; // Track last save timestamp

        try {
            console.log(
                `[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`,
            );

            // Note: If force reindex, collection was already cleared during validation phase
            if (forceReindex) {
                console.log(
                    `[BACKGROUND-INDEX] Force reindex mode - collection was already cleared during validation`,
                );
            }

            const requestSplitter = createRequestSplitter(splitterType);

            // Load ignore patterns from files first (including .ignore, .gitignore, etc.)
            // and merge them with this request's custom ignore patterns without
            // relying on shared Context state for this background indexing task.
            const ignorePatterns =
                await this.context.getEffectiveIgnorePatterns(
                    absolutePath,
                    customIgnorePatterns,
                    customIgnoreFiles,
                );
            // Initialize file synchronizer with proper ignore patterns (including project-specific patterns)
            console.log(
                `[BACKGROUND-INDEX] Using ignore patterns: ${ignorePatterns.join(", ")}`,
            );
            if (customFileExtensions.length > 0) {
                console.log(
                    `[BACKGROUND-INDEX] Using ${customFileExtensions.length} request-scoped custom extensions: ${customFileExtensions.join(", ")}`,
                );
            }
            if (customIgnoreFiles.length > 0) {
                console.log(
                    `[BACKGROUND-INDEX] Using ${customIgnoreFiles.length} request-scoped ignore files: ${customIgnoreFiles.join(", ")}`,
                );
            }
            if (requestMaxDepth !== undefined) {
                console.log(
                    `[BACKGROUND-INDEX] Limiting traversal to maxDepth=${requestMaxDepth}`,
                );
            }

            console.log(
                `[BACKGROUND-INDEX] Starting indexing with ${splitterType} splitter for: ${absolutePath}`,
            );

            // Log embedding provider information before indexing
            const embeddingProvider = this.context.getEmbedding();
            console.log(
                `[BACKGROUND-INDEX] Using embedding provider: ${embeddingProvider.getProvider()} with dimension: ${embeddingProvider.getDimension()}`,
            );

            // Start indexing with the appropriate context and progress tracking
            console.log(
                `[BACKGROUND-INDEX] Beginning codebase indexing process...`,
            );
            const stats = await this.context.indexCodebase(
                absolutePath,
                (progress) => {
                    // Update progress in snapshot manager using new method
                    this.snapshotManager.setCodebaseIndexing(
                        absolutePath,
                        progress.percentage,
                    );

                    // Save snapshot periodically (every 2 seconds to avoid too frequent saves)
                    const currentTime = Date.now();
                    if (currentTime - lastSaveTime >= 2000) {
                        // 2 seconds = 2000ms
                        this.snapshotManager.saveCodebaseSnapshot();
                        lastSaveTime = currentTime;
                        console.log(
                            `[BACKGROUND-INDEX] Saved progress snapshot at ${progress.percentage.toFixed(1)}%`,
                        );
                    }

                    console.log(
                        `[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`,
                    );
                },
                false,
                customIgnorePatterns,
                customFileExtensions,
                requestSplitter,
                signal,
                {
                    additionalIgnoreFiles: customIgnoreFiles,
                    maxDepth: requestMaxDepth,
                },
            );
            console.log(
                `[BACKGROUND-INDEX] Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`,
            );

            // Set codebase to indexed status with complete statistics
            this.snapshotManager.setCodebaseIndexed(
                absolutePath,
                stats,
                indexOptions,
            );
            this.indexingStats = {
                indexedFiles: stats.indexedFiles,
                totalChunks: stats.totalChunks,
            };

            // Save snapshot after updating codebase lists
            await this.snapshotManager.saveCodebaseSnapshotAsync();
            this.trackIndexedCodebase(absolutePath);

            let message = `Background indexing completed for '${absolutePath}' using ${splitterType.toUpperCase()} splitter.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === "limit_reached") {
                message += `\n Warning: Indexing stopped because the chunk limit (450,000) was reached. The index may be incomplete.`;
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);
        } catch (error: any) {
            // Cooperative cancel from clear_index — clear_index is responsible
            // for tearing down the snapshot/collection right after, so do not
            // overwrite the snapshot with an "indexfailed" entry that would
            // race the clear and leave a tombstone behind.
            if (error instanceof IndexAbortError) {
                console.log(
                    `[BACKGROUND-INDEX] Indexing for ${absolutePath} was cancelled: ${error.message}`,
                );
                return;
            }

            console.error(
                `[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`,
                error,
            );

            // Get the last attempted progress
            const lastProgress =
                this.snapshotManager.getIndexingProgress(absolutePath);

            // Set codebase to failed status with error information
            const errorMessage = error.message || String(error);
            this.snapshotManager.setCodebaseIndexFailed(
                absolutePath,
                errorMessage,
                lastProgress,
                indexOptions,
            );
            await this.snapshotManager.saveCodebaseSnapshotAsync();

            // Log error but don't crash MCP service - indexing errors are handled gracefully
            console.error(
                `[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`,
            );
        }
    }

    private async startWorkerBackgroundIndexing(
        codebasePath: string,
        forceReindex: boolean,
        splitterType: RequestSplitterType,
        customIgnorePatterns: string[] = [],
        customFileExtensions: string[] = [],
        customIgnoreFiles: string[] = [],
        requestMaxDepth?: number,
        indexOptions?: CodebaseIndexOptions,
        signal?: AbortSignal,
    ): Promise<void> {
        const absolutePath = codebasePath;
        const jobId = this.indexingJobStates.createJobId(absolutePath);
        const collectionName = this.context.getCollectionName(absolutePath);
        let lastProgress: IndexingJobProgress | undefined;

        try {
            console.log(
                `[BACKGROUND-INDEX] Starting indexing worker ${jobId} for: ${absolutePath}`,
            );
            if (forceReindex) {
                console.log(
                    `[BACKGROUND-INDEX] Force reindex mode - collection was already cleared during validation`,
                );
            }

            await this.indexingJobStates.createRunningJob({
                jobId,
                codebasePath: absolutePath,
                collectionName,
                splitterType,
                indexOptions,
            });

            const stats = await startIndexingWorkerJob(
                {
                    jobId,
                    codebasePath: absolutePath,
                    splitterType,
                    customIgnorePatterns,
                    customFileExtensions,
                    customIgnoreFiles,
                    requestMaxDepth,
                    indexOptions,
                },
                signal ?? new AbortController().signal,
                {
                    onReady: (workerThreadId) => {
                        void this.indexingJobStates.updateWorkerThreadId(
                            jobId,
                            workerThreadId,
                        );
                    },
                    onProgress: (progress) => {
                        lastProgress = progress;
                        this.snapshotManager.setCodebaseIndexing(
                            absolutePath,
                            progress.percentage,
                            indexOptions,
                        );
                        void this.indexingJobStates.updateProgress(
                            jobId,
                            progress,
                        );
                        console.log(
                            `[BACKGROUND-INDEX] Worker ${jobId} progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`,
                        );
                    },
                },
            );

            await this.indexingJobStates.markCompleted(jobId, stats);
            this.snapshotManager.setCodebaseIndexed(
                absolutePath,
                stats,
                indexOptions,
            );
            this.indexingStats = {
                indexedFiles: stats.indexedFiles,
                totalChunks: stats.totalChunks,
            };
            await this.snapshotManager.saveCodebaseSnapshotAsync();
            this.trackIndexedCodebase(absolutePath);

            let message = `Background indexing worker ${jobId} completed for '${absolutePath}' using ${splitterType.toUpperCase()} splitter.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === "limit_reached") {
                message += `\n Warning: Indexing stopped because the chunk limit (450,000) was reached. The index may be incomplete.`;
            }
            console.log(`[BACKGROUND-INDEX] ${message}`);
        } catch (error: any) {
            if (error instanceof IndexAbortError || error instanceof IndexingWorkerCancelledError) {
                const message = error.message || "Indexing was cancelled";
                await this.indexingJobStates.markCancelled(jobId, message);
                console.log(
                    `[BACKGROUND-INDEX] Indexing worker ${jobId} for ${absolutePath} was cancelled: ${message}`,
                );
                return;
            }

            const errorMessage = error.message || String(error);
            console.error(
                `[BACKGROUND-INDEX] Error during indexing worker ${jobId} for ${absolutePath}:`,
                error,
            );
            await this.indexingJobStates.markFailed(jobId, errorMessage);
            this.snapshotManager.setCodebaseIndexFailed(
                absolutePath,
                errorMessage,
                lastProgress?.percentage ??
                    this.snapshotManager.getIndexingProgress(absolutePath),
                indexOptions,
            );
            await this.snapshotManager.saveCodebaseSnapshotAsync();
            console.error(
                `[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`,
            );
        }
    }

    public async handleSearchCode(args: any): Promise<any> {
        const validation = this.validateRequiredStringArgs(
            "search_code",
            args,
            ["path", "query"],
        );
        if (validation.error) {
            return validation.error;
        }

        const {
            path: codebasePath,
            query,
            limit,
            extensionFilter,
            targetRole,
            includeRelated,
            includeTraceEvidence,
            skipConsistencyCheck,
            consistency,
        } = args;
        const normalizedLimit = this.normalizeOptionalSearchLimit(limit);
        if (normalizedLimit.error) {
            return normalizedLimit.error;
        }
        const normalizedTargetRole =
            this.normalizeOptionalSearchTargetRole(targetRole);
        if (normalizedTargetRole.error) {
            return normalizedTargetRole.error;
        }
        const normalizedIncludeRelated =
            this.normalizeOptionalIncludeRelated(includeRelated);
        if (normalizedIncludeRelated.error) {
            return normalizedIncludeRelated.error;
        }
        const normalizedIncludeTraceEvidence =
            this.normalizeOptionalIncludeTraceEvidence(includeTraceEvidence);
        if (normalizedIncludeTraceEvidence.error) {
            return normalizedIncludeTraceEvidence.error;
        }
        const normalizedSkipConsistencyCheck =
            this.normalizeOptionalSkipConsistencyCheck(skipConsistencyCheck);
        if (normalizedSkipConsistencyCheck.error) {
            return normalizedSkipConsistencyCheck.error;
        }
        const normalizedConsistency =
            this.normalizeOptionalSearchConsistency(consistency);
        if (normalizedConsistency.error) {
            return normalizedConsistency.error;
        }
        const normalizedExtensionFilter =
            this.normalizeOptionalExtensionFilter(extensionFilter);
        if (normalizedExtensionFilter.error) {
            return normalizedExtensionFilter.error;
        }
        const consistencyMode: SearchConsistencyMode =
            (normalizedSkipConsistencyCheck.skipConsistencyCheck === true
                ? "low_latency"
                : normalizedConsistency.consistencyMode ?? "low_latency");

        try {
            this.snapshotManager.refreshFromDiskForRead();

            const absolutePath = requireAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`,
                        },
                    ],
                    isError: true,
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: Path '${absolutePath}' is not a directory`,
                        },
                    ],
                    isError: true,
                };
            }

            trackCodebasePath(absolutePath);

            // Check if this codebase is indexed or being indexed
            const indexedCodebasePath =
                this.snapshotManager.findIndexedCodebasePath(absolutePath);
            const indexingCodebasePath =
                this.snapshotManager.findIndexingCodebasePath(absolutePath);
            const matchedCodebase = [indexedCodebasePath, indexingCodebasePath]
                .filter(
                    (codebase): codebase is string => codebase !== undefined,
                )
                .sort((a, b) => b.length - a.length)[0];
            let searchCodebasePath = matchedCodebase || absolutePath;
            let isIndexed = indexedCodebasePath === searchCodebasePath;
            const isIndexing = indexingCodebasePath === searchCodebasePath;

            if (!isIndexed && !isIndexing) {
                // Fallback: check VectorDB directly in case snapshot is out of sync.
                // Only recover the snapshot when we can confirm a real row count —
                // writing 0/0+completed for an unverifiable collection poisons the
                // client into a force-reindex loop (Issue #295).
                const recoveredCodebasePath =
                    await this.recoverIndexedCodebaseFromVectorDatabase(
                        absolutePath,
                    );
                if (recoveredCodebasePath) {
                    searchCodebasePath = recoveredCodebasePath;
                    isIndexed = true;
                    // Continue with search (don't return error)
                } else {
                    return this.notIndexedResponse(absolutePath);
                }
            }

            if (
                isIndexing &&
                consistencyMode === "strong"
            ) {
                return this.errorResponse(
                    `Error: Codebase '${searchCodebasePath}' is currently being indexed in the background. search_code requires a completed, fresh index; retry after indexing completes.`,
                );
            }

            const activeSyncStatusMessage =
                this.getSyncStatusMessage(searchCodebasePath);
            if (
                activeSyncStatusMessage.length > 0 &&
                consistencyMode === "strong"
            ) {
                return this.errorResponse(
                    `Error: search_code requires a fresh index for '${searchCodebasePath}', but automatic sync is already in progress.\n${activeSyncStatusMessage}`,
                );
            }

            let searchConsistencyWarning = "";
            if (
                consistencyMode === "strong" ||
                activeSyncStatusMessage.length === 0
            ) {
                const refreshResult = await this.refreshCodebaseIndexBeforeSearch(
                    searchCodebasePath,
                    consistencyMode,
                );
                if (refreshResult?.error) {
                    return refreshResult.error;
                }
                searchConsistencyWarning = refreshResult?.warning ?? "";
                this.snapshotManager.refreshFromDiskForRead();
            } else {
                searchConsistencyWarning =
                    "Search used the current index while automatic sync is in progress. Results may be stale until sync finishes.";
            }

            let indexingStatusMessage = "";
            if (isIndexing) {
                indexingStatusMessage = `\n **Indexing in Progress**: This codebase is currently being indexed in the background. Search results may be incomplete until indexing completes.`;
            }
            const syncSearchPrefix =
                [activeSyncStatusMessage, searchConsistencyWarning]
                    .filter((message) => message.length > 0)
                    .join("\n");
            const syncSearchPrefixBlock =
                syncSearchPrefix.length > 0 ? `${syncSearchPrefix}\n\n` : "";

            console.log(
                `[SEARCH] Searching in codebase: ${searchCodebasePath}`,
            );
            console.log(`[SEARCH] Query: "${query}"`);
            console.log(
                `[SEARCH] Indexing status: ${isIndexing ? "In Progress" : "Completed"}`,
            );

            // Log embedding provider information before search
            const embeddingProvider = this.context.getEmbedding();
            console.log(
                `[SEARCH] Using embedding provider: ${embeddingProvider.getProvider()} for search`,
            );
            console.log(
                `[SEARCH] Generating embeddings for query using ${embeddingProvider.getProvider()}...`,
            );

            // Build filter expression from extensionFilter list
            let filterExpr: string | undefined = undefined;
            if (
                normalizedExtensionFilter.extensions &&
                normalizedExtensionFilter.extensions.length > 0
            ) {
                const quoted = normalizedExtensionFilter.extensions
                    .map((e: string) => `'${e}'`)
                    .join(", ");
                filterExpr = `fileExtension in [${quoted}]`;
            }

            const resultLimit = await this.resolveSearchResultLimit(
                normalizedLimit.limit,
                searchCodebasePath,
            );
            const searchThreshold =
                this.resolveSearchThreshold(searchCodebasePath);
            const filenameQueryStatus = await analyzeFilenameLikeQuery({
                query,
                codebasePath: searchCodebasePath,
                getCollectionName: () =>
                    this.context.getCollectionName(searchCodebasePath),
                getVectorDatabase: () => this.context.getVectorDatabase(),
            });

            // Search in the specified codebase
            const searchResults = await this.context.semanticSearch(
                searchCodebasePath,
                query,
                resultLimit,
                searchThreshold,
                filterExpr,
                {
                    targetRole: normalizedTargetRole.targetRole,
                    includeRelated: normalizedIncludeRelated.includeRelated,
                    ...(filenameQueryStatus
                        ? { filenameLikeQuery: filenameQueryStatus.query }
                        : {}),
                },
            );

            console.log(
                `[SEARCH] Search completed! Found ${searchResults.length} results using ${embeddingProvider.getProvider()} embeddings`,
            );

            if (searchResults.length === 0) {
                // Check if collection was lost (indexed locally but missing in Milvus)
                if (isIndexed && !isIndexing) {
                    const collectionName =
                        this.context.getCollectionName(searchCodebasePath);
                    const hasCollection = await this.context
                        .getVectorDatabase()
                        .hasCollection(collectionName);
                    if (!hasCollection) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Error: Index data for '${searchCodebasePath}' has been lost (collection not found in Milvus). Please re-index using index_codebase with force=true.`,
                                },
                            ],
                            isError: true,
                        };
                    }
                }

                const filenameNotice = formatFilenameQueryNotice(
                    filenameQueryStatus,
                    false,
                );
                let noResultsMessage = `No results found for query: "${query}" in codebase '${searchCodebasePath}'`;
                if (filenameNotice.length > 0) {
                    noResultsMessage = `${filenameNotice}\n\n${noResultsMessage}`;
                }
                if (searchCodebasePath !== absolutePath) {
                    noResultsMessage += `\nRequested path '${absolutePath}' is covered by indexed codebase '${searchCodebasePath}'.`;
                }
                if (isIndexing) {
                    noResultsMessage += `\n\nNote: This codebase is still being indexed. Try searching again after indexing completes, or the query may not match any indexed content.`;
                }
                if (syncSearchPrefixBlock.length > 0) {
                    noResultsMessage = `${syncSearchPrefixBlock}${noResultsMessage}`;
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: noResultsMessage,
                        },
                    ],
                };
            }

            // Format results
            const useFallbackMatchLabel =
                searchResultsAreFallbackMatches(filenameQueryStatus);
            const formattedResultsByGroup = new Map<string, string[]>();
            const sourceFileCache: SourceFileCache = new Map();
            for (let index = 0; index < searchResults.length; index++) {
                const result: any = searchResults[index];
                const { location, warning } =
                    this.formatSearchResultLocation(result);
                const scoreReason = this.formatSearchScoreReason(result);
                const sourceContext = this.formatSearchResultContext(
                    result,
                    searchCodebasePath,
                    sourceFileCache,
                );
                const codebaseInfo = path.basename(searchCodebasePath);
                const resultLabel = useFallbackMatchLabel
                    ? "Fallback match"
                    : "Source context";
                const warnings = [warning, sourceContext.warning].filter(
                    (value): value is string =>
                        typeof value === "string" && value.length > 0,
                );
                const groupLabel = this.formatSearchResultGroupLabel(
                    result.resultGroup,
                );
                const traceEvidence =
                    normalizedIncludeTraceEvidence.includeTraceEvidence === true
                        ? await this.formatSearchTraceEvidence(
                              result,
                              index,
                              searchCodebasePath,
                              sourceContext.context,
                          )
                        : "";

                const formattedResult =
                    `${index + 1}. ${resultLabel} (${result.language}) [${codebaseInfo}]\n` +
                    ` Location: ${location}\n` +
                    warnings.map((value) => ` Warning: ${value}\n`).join("") +
                    ` Context source: ${sourceContext.source}\n` +
                    (scoreReason ? ` Match signals: ${scoreReason}\n` : "") +
                    traceEvidence +
                    ` Rank: ${index + 1}\n` +
                    ` Context: \n\`\`\`${result.language}\n${sourceContext.context}\n\`\`\`\n`;
                const groupResults =
                    formattedResultsByGroup.get(groupLabel) ?? [];
                groupResults.push(formattedResult);
                formattedResultsByGroup.set(groupLabel, groupResults);
            }
            const formattedResults = [...formattedResultsByGroup.entries()]
                .map(
                    ([groupLabel, groupResults]) =>
                        `## ${groupLabel}\n\n${groupResults.join("\n")}`,
                )
                .join("\n\n");

            const filenameNotice = formatFilenameQueryNotice(
                filenameQueryStatus,
                searchResults.length > 0,
            );
            let resultMessage = useFallbackMatchLabel
                ? `Found ${searchResults.length} fallback matches for query: "${query}" in codebase '${searchCodebasePath}'${indexingStatusMessage}`
                : `Found ${searchResults.length} results for query: "${query}" in codebase '${searchCodebasePath}'${indexingStatusMessage}`;
            if (filenameNotice.length > 0) {
                resultMessage += `\n${filenameNotice}`;
            }
            if (searchCodebasePath !== absolutePath) {
                resultMessage += `\nRequested path '${absolutePath}' is covered by indexed codebase '${searchCodebasePath}'.`;
            }
            if (syncSearchPrefixBlock.length > 0) {
                resultMessage = `${syncSearchPrefixBlock}${resultMessage}`;
            }
            resultMessage += `\n\n${formattedResults}`;

            if (isIndexing) {
                resultMessage += `\n\n **Tip**: This codebase is still being indexed. More results may become available as indexing progresses.`;
            }

            return {
                content: [
                    {
                        type: "text",
                        text: resultMessage,
                    },
                ],
            };
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage =
                typeof error === "string"
                    ? error
                    : error instanceof Error
                      ? error.message
                      : String(error);

            if (
                errorMessage === COLLECTION_LIMIT_MESSAGE ||
                errorMessage.includes(COLLECTION_LIMIT_MESSAGE)
            ) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
                return {
                    content: [
                        {
                            type: "text",
                            text: COLLECTION_LIMIT_MESSAGE,
                        },
                    ],
                };
            }

            return {
                content: [
                    {
                        type: "text",
                        text: `Error searching code: ${errorMessage} Please check if the codebase has been indexed first.`,
                    },
                ],
                isError: true,
            };
        }
    }

    public async handleClearIndex(args: any): Promise<any> {
        const validation = this.validateRequiredStringArgs(
            "clear_index",
            args,
            ["path"],
        );
        if (validation.error) {
            return validation.error;
        }

        const { path: codebasePath } = args;

        try {
            const absolutePath = requireAbsolutePath(codebasePath);

            const indexedCodebases = this.snapshotManager.getIndexedCodebases();
            const indexingCodebases =
                this.snapshotManager.getIndexingCodebases();
            const isIndexed = indexedCodebases.includes(absolutePath);
            const isIndexing = indexingCodebases.includes(absolutePath);
            let hasVectorIndex = false;

            if (!isIndexed && !isIndexing) {
                hasVectorIndex = await this.context.hasIndex(absolutePath);
            }

            // clear_index must be able to clean up remote collection state after
            // the local directory was deleted. Only enforce filesystem checks
            // when the path still exists locally.
            const pathExists = fs.existsSync(absolutePath);
            if (pathExists && !fs.statSync(absolutePath).isDirectory()) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: Path '${absolutePath}' is not a directory`,
                        },
                    ],
                    isError: true,
                };
            }

            if (!isIndexed && !isIndexing && !hasVectorIndex) {
                if (!pathExists) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`,
                            },
                        ],
                        isError: true,
                    };
                }
                if (
                    indexedCodebases.length === 0 &&
                    indexingCodebases.length === 0
                ) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "No codebases are currently indexed or being indexed.",
                            },
                        ],
                    };
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: Codebase '${absolutePath}' is not indexed or being indexed.`,
                        },
                    ],
                    isError: true,
                };
            }

            console.log(`[CLEAR] Clearing codebase: ${absolutePath}`);
            const pathsToRemoveFromSnapshot = this.getSnapshotPathsForCollection(
                absolutePath,
                indexedCodebases,
                indexingCodebases,
            );

            // Cancel any in-flight background indexing for this codebase and
            // wait for it to wind down before we drop the collection.
            // Otherwise the background task keeps embedding chunks and writes
            // them into the just-cleared collection (issue #199).
            const cancelledIndexingPaths: string[] = [];
            for (const pathToRemove of pathsToRemoveFromSnapshot) {
                const activeTask = this.indexingTasks.get(pathToRemove);
                if (activeTask) {
                    console.log(
                        `[CLEAR] Cancelling in-flight background indexing for: ${pathToRemove}`,
                    );
                    activeTask.controller.abort();
                    try {
                        await activeTask.promise;
                    } catch (waitError: any) {
                        // startBackgroundIndexing already logs and never re-throws,
                        // so this catch only guards against future refactors.
                        console.warn(
                            `[CLEAR] Background indexing wind-down reported: ${waitError?.message || waitError}`,
                        );
                    }
                    this.indexingTasks.delete(pathToRemove);
                    cancelledIndexingPaths.push(pathToRemove);
                }
            }

            const writerLock = this.acquireManualWriterLock(
                `clear_index for '${absolutePath}'`,
                this.getCollectionWriterLockScope(absolutePath),
            );
            if (!(writerLock instanceof McpWriterLock)) {
                if (cancelledIndexingPaths.length > 0) {
                    const errorMessage =
                        "Indexing was cancelled by clear_index, but clear_index could not acquire the collection writer lock. Retry clear_index after the active writer finishes.";
                    for (const cancelledPath of cancelledIndexingPaths) {
                        this.snapshotManager.setCodebaseIndexFailed(
                            cancelledPath,
                            errorMessage,
                            this.snapshotManager.getIndexingProgress(cancelledPath),
                        );
                    }
                    await this.snapshotManager.saveCodebaseSnapshotAsync();
                }
                return writerLock;
            }

            try {
                const cleanupWarnings: string[] = [];
                try {
                    await this.context.clearIndex(absolutePath);
                    console.log(
                        `[CLEAR] Successfully cleared index for: ${absolutePath}`,
                    );
                } catch (error: any) {
                    const errorMsg = `Failed to clear ${absolutePath}: ${error.message}`;
                    console.error(`[CLEAR] ${errorMsg}`);
                    return {
                        content: [
                            {
                                type: "text",
                                text: errorMsg,
                            },
                        ],
                        isError: true,
                    };
                }

                // Completely remove every snapshot entry backed by the dropped
                // collection. Shared identity modes map multiple paths to one
                // collection, so leaving sibling paths indexed would point them
                // at a collection that no longer exists.
                for (const pathToRemove of pathsToRemoveFromSnapshot) {
                    try {
                        await this.deleteRemoteIndexManifest(
                            this.context.getCollectionName(pathToRemove),
                            pathToRemove,
                        );
                    } catch (manifestError: any) {
                        const warning = `Failed to delete remote manifest for '${pathToRemove}': ${manifestError?.message || manifestError}`;
                        cleanupWarnings.push(warning);
                        console.warn(`[CLEAR] ${warning}`);
                    }
                    if (pathToRemove !== absolutePath) {
                        try {
                            await FileSynchronizer.deleteSnapshot(pathToRemove);
                        } catch (snapshotError: any) {
                            const warning = `Failed to delete Merkle snapshot for '${pathToRemove}': ${snapshotError?.message || snapshotError}`;
                            cleanupWarnings.push(warning);
                            console.warn(`[CLEAR] ${warning}`);
                        }
                    }
                    this.snapshotManager.removeCodebaseCompletely(pathToRemove);
                }

                // Reset indexing stats if this was the active codebase
                this.indexingStats = null;

                // Save snapshot after clearing index
                await this.snapshotManager.saveCodebaseSnapshotAsync();

                let resultText = `Successfully cleared codebase '${absolutePath}'`;

                const remainingIndexed =
                    this.snapshotManager.getIndexedCodebases().length;
                const remainingIndexing =
                    this.snapshotManager.getIndexingCodebases().length;

                if (remainingIndexed > 0 || remainingIndexing > 0) {
                    resultText += `\n${remainingIndexed} other indexed codebase(s) and ${remainingIndexing} indexing codebase(s) remain`;
                }

                if (cleanupWarnings.length > 0) {
                    resultText += `\nWarning: ${cleanupWarnings.join("; ")}`;
                }

                return {
                    content: [
                        {
                            type: "text",
                            text: resultText,
                        },
                    ],
                };
            } finally {
                writerLock.release();
            }
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage =
                typeof error === "string"
                    ? error
                    : error instanceof Error
                      ? error.message
                      : String(error);

            if (
                errorMessage === COLLECTION_LIMIT_MESSAGE ||
                errorMessage.includes(COLLECTION_LIMIT_MESSAGE)
            ) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
                return {
                    content: [
                        {
                            type: "text",
                            text: COLLECTION_LIMIT_MESSAGE,
                        },
                    ],
                };
            }

            return {
                content: [
                    {
                        type: "text",
                        text: `Error clearing index: ${errorMessage}`,
                    },
                ],
                isError: true,
            };
        }
    }

    public async handleRepairIndexManifest(args: any): Promise<any> {
        const validation = this.validateRequiredStringArgs(
            "repair_index_manifest",
            args,
            ["path"],
        );
        if (validation.error) {
            return validation.error;
        }

        const { path: codebasePath } = args;

        try {
            const absolutePath = requireAbsolutePath(codebasePath);
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`,
                        },
                    ],
                    isError: true,
                };
            }
            if (!fs.statSync(absolutePath).isDirectory()) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: Path '${absolutePath}' is not a directory`,
                        },
                    ],
                    isError: true,
                };
            }

            const writerLock = this.acquireManualWriterLock(
                `repair_index_manifest for '${absolutePath}'`,
                this.getCollectionWriterLockScope(absolutePath),
            );
            if (!(writerLock instanceof McpWriterLock)) {
                return writerLock;
            }

            try {
                const startedAtMs = Date.now();
                this.setManifestRepairStatus(absolutePath, {
                    phase: "Checking remote collection",
                    current: 1,
                    total: 4,
                    percentage: 10,
                    startedAtMs,
                });
                const collectionName = this.context.getCollectionName(absolutePath);
                const probe = await this.getRemoteCollectionProbe(collectionName);
                if (!probe.exists) {
                    return this.errorResponse(
                        `Error: Cannot repair remote manifest because collection '${collectionName}' does not exist for '${absolutePath}'.`,
                    );
                }

                this.setManifestRepairStatus(absolutePath, {
                    phase: "Scanning legacy chunk metadata",
                    current: 2,
                    total: 4,
                    percentage: 40,
                });
                const stats = await this.queryCollectionStats(absolutePath);
                if (!stats) {
                    return this.errorResponse(
                        `Error: Cannot repair remote manifest for '${absolutePath}' because legacy row metadata scan returned no usable file/chunk stats.`,
                    );
                }

                this.setManifestRepairStatus(absolutePath, {
                    phase: "Writing remote manifest",
                    current: 3,
                    total: 4,
                    percentage: 75,
                });
                const existingManifest = await this.readRemoteIndexManifest(
                    collectionName,
                    absolutePath,
                );
                const generation = existingManifest.manifest
                    ? existingManifest.manifest.generation + 1
                    : 1;
                const manifest: RemoteIndexManifest = {
                    manifestVersion: REMOTE_INDEX_MANIFEST_VERSION,
                    codebasePath: absolutePath,
                    collectionName,
                    status: "completed",
                    indexedFiles: stats.indexedFiles,
                    totalChunks: stats.totalChunks,
                    schemaVersion: 2,
                    metadataVersion: 2,
                    generation,
                    updatedAt: new Date().toISOString(),
                };
                await this.writeRemoteIndexManifest(manifest);

                this.setManifestRepairStatus(absolutePath, {
                    phase: "Updating local snapshot",
                    current: 4,
                    total: 4,
                    percentage: 95,
                });
                if (
                    this.snapshotManager.findIndexingCodebasePath(absolutePath) ===
                    undefined
                ) {
                    this.snapshotManager.setCodebaseIndexed(absolutePath, {
                        indexedFiles: manifest.indexedFiles,
                        totalChunks: manifest.totalChunks,
                        status: manifest.status,
                    });
                    await this.snapshotManager.saveCodebaseSnapshotAsync();
                }

                return {
                    content: [
                        {
                            type: "text",
                            text: `Repaired remote index manifest for '${absolutePath}'. Collection: ${collectionName}. Stats: ${manifest.indexedFiles} files, ${manifest.totalChunks} chunks. Generation: ${manifest.generation}.`,
                        },
                    ],
                };
            } finally {
                this.manifestRepairStatuses.delete(absolutePath);
                writerLock.release();
            }
        } catch (error: any) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error repairing index manifest: ${error.message || error}`,
                    },
                ],
                isError: true,
            };
        }
    }

    public async handleGetIndexingStatus(args: any): Promise<any> {
        const validation = this.validateRequiredStringArgs(
            "get_indexing_status",
            args,
            ["path"],
        );
        if (validation.error) {
            return validation.error;
        }

        const { path: codebasePath } = args;

        try {
            const absolutePath = requireAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`,
                        },
                    ],
                    isError: true,
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: Path '${absolutePath}' is not a directory`,
                        },
                    ],
                    isError: true,
                };
            }

            const syncCodebasePath =
                this.snapshotManager.findTrackedCodebasePath(absolutePath) ||
                absolutePath;
            let remoteProbe =
                await this.syncTargetCodebaseFromVectorDatabase(syncCodebasePath);
            this.snapshotManager.refreshFromDiskForRead();

            // Check indexing status using new status system
            const statusCodebasePath =
                this.snapshotManager.findTrackedCodebasePath(absolutePath) ||
                absolutePath;
            const status =
                this.snapshotManager.getCodebaseStatus(statusCodebasePath);
            const info =
                this.snapshotManager.getCodebaseInfo(statusCodebasePath);
            const syncStatusMessage =
                this.getSyncStatusMessage(statusCodebasePath);
            const manifestRepairStatusMessage =
                this.getManifestRepairStatusMessage(statusCodebasePath);
            const indexingJob =
                this.indexingJobStates.findLatestForCodebase(statusCodebasePath);
            const indexingJobStatusMessage = this.getIndexingJobStatusMessage(
                statusCodebasePath,
                indexingJob,
            );
            let remoteDiagnostics = "";
            if (
                typeof (this.context as any).getCollectionName === "function" &&
                typeof (this.context as any).getVectorDatabase === "function"
            ) {
                const collectionName =
                    this.context.getCollectionName(statusCodebasePath);
                if (!remoteProbe || remoteProbe.collectionName !== collectionName) {
                    try {
                        remoteProbe = await this.getRemoteCollectionProbe(
                            collectionName,
                        );
                    } catch (error) {
                        remoteProbe = {
                            collectionName,
                            exists: false,
                            rowCountError:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        };
                    }
                }
                const remoteManifestRead = remoteProbe.exists
                    ? await this.readRemoteIndexManifest(
                          collectionName,
                          statusCodebasePath,
                      )
                    : null;
                remoteDiagnostics = this.formatRemoteStatusDiagnostics(
                    statusCodebasePath,
                    remoteProbe,
                    remoteManifestRead,
                );
            }

            let statusMessage = "";

            switch (status) {
                case "indexed":
                    if (info && "indexedFiles" in info) {
                        const indexedInfo = info as CodebaseInfoIndexed;
                        statusMessage = ` Codebase '${statusCodebasePath}' is fully indexed and ready for search.`;
                        statusMessage += `\n Statistics: ${this.formatIndexedStatistics(statusCodebasePath, indexedInfo)}`;
                        statusMessage += `\n Status: ${indexedInfo.indexStatus}`;
                        if (indexedInfo.syncWarning) {
                            statusMessage += `\n Sync warning: ${indexedInfo.syncWarning}`;
                        }
                        if (syncStatusMessage.length > 0) {
                            statusMessage += `\n${syncStatusMessage}`;
                        }
                        if (manifestRepairStatusMessage.length > 0) {
                            statusMessage += `\n${manifestRepairStatusMessage}`;
                        }
                        if (remoteDiagnostics.length > 0) {
                            statusMessage += `\n${remoteDiagnostics}`;
                        }
                        statusMessage += `\n Last updated: ${new Date(indexedInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = ` Codebase '${statusCodebasePath}' is fully indexed and ready for search.`;
                        if (syncStatusMessage.length > 0) {
                            statusMessage += `\n${syncStatusMessage}`;
                        }
                        if (manifestRepairStatusMessage.length > 0) {
                            statusMessage += `\n${manifestRepairStatusMessage}`;
                        }
                        if (remoteDiagnostics.length > 0) {
                            statusMessage += `\n${remoteDiagnostics}`;
                        }
                    }
                    break;

                case "indexing":
                    if (
                        indexingJob?.status === "running" ||
                        (info && "indexingPercentage" in info)
                    ) {
                        const indexingInfo = info as CodebaseInfoIndexing;
                        const progressPercentage =
                            indexingJob?.status === "running"
                                ? indexingJob.progress.percentage
                                : indexingInfo.indexingPercentage || 0;
                        statusMessage = ` Codebase '${statusCodebasePath}' is currently being indexed. Progress: ${progressPercentage.toFixed(1)}%`;

                        // Add more detailed status based on progress
                        if (progressPercentage < 10) {
                            statusMessage +=
                                " (Preparing and scanning files...)";
                        } else if (progressPercentage < 100) {
                            statusMessage +=
                                " (Processing files and generating embeddings...)";
                        }
                        const lastUpdated =
                            indexingJob?.status === "running"
                                ? indexingJob.updatedAt
                                : indexingInfo.lastUpdated;
                        statusMessage += `\n Last updated: ${new Date(lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = ` Codebase '${statusCodebasePath}' is currently being indexed.`;
                    }
                    if (indexingJobStatusMessage.length > 0) {
                        statusMessage += `\n${indexingJobStatusMessage}`;
                    }
                    if (syncStatusMessage.length > 0) {
                        statusMessage += `\n${syncStatusMessage}`;
                    }
                    if (manifestRepairStatusMessage.length > 0) {
                        statusMessage += `\n${manifestRepairStatusMessage}`;
                    }
                    if (remoteDiagnostics.length > 0) {
                        statusMessage += `\n${remoteDiagnostics}`;
                    }
                    break;

                case "indexfailed":
                    if (info && "errorMessage" in info) {
                        const failedInfo = info as any;
                        statusMessage = ` Codebase '${statusCodebasePath}' indexing failed.`;
                        statusMessage += `\n Error: ${failedInfo.errorMessage}`;
                        if (failedInfo.lastAttemptedPercentage !== undefined) {
                            statusMessage += `\n Failed at: ${failedInfo.lastAttemptedPercentage.toFixed(1)}% progress`;
                        }
                        statusMessage += `\n Failed at: ${new Date(failedInfo.lastUpdated).toLocaleString()}`;
                        statusMessage += `\n You can retry indexing by running the index_codebase command again.`;
                    } else {
                        statusMessage = ` Codebase '${statusCodebasePath}' indexing failed. You can retry indexing.`;
                    }
                    if (remoteDiagnostics.length > 0) {
                        statusMessage += `\n${remoteDiagnostics}`;
                    }
                    if (
                        indexingJobStatusMessage.length > 0 &&
                        indexingJob?.status !== "completed"
                    ) {
                        statusMessage += `\n${indexingJobStatusMessage}`;
                    }
                    if (manifestRepairStatusMessage.length > 0) {
                        statusMessage += `\n${manifestRepairStatusMessage}`;
                    }
                    break;

                case "not_found":
                default:
                    if (
                        indexingJobStatusMessage.length > 0 &&
                        indexingJob?.status !== "completed"
                    ) {
                        statusMessage = ` Codebase '${absolutePath}' is not recorded in the global snapshot, but an indexing job exists.`;
                        statusMessage += `\n${indexingJobStatusMessage}`;
                    } else {
                        statusMessage = ` Codebase '${absolutePath}' is not indexed. ${NOT_INDEXED_INDEXING_HINT}`;
                    }
                    if (manifestRepairStatusMessage.length > 0) {
                        statusMessage += `\n${manifestRepairStatusMessage}`;
                    }
                    if (remoteDiagnostics.length > 0) {
                        statusMessage += `\n${remoteDiagnostics}`;
                    }
                    break;
            }

            const pathInfo =
                codebasePath !== absolutePath
                    ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                    : "";
            const matchedPathInfo =
                statusCodebasePath !== absolutePath
                    ? `\nRequested path '${absolutePath}' is covered by tracked codebase '${statusCodebasePath}'.`
                    : "";

            return {
                content: [
                    {
                        type: "text",
                        text: statusMessage + pathInfo + matchedPathInfo,
                    },
                ],
            };
        } catch (error: any) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error getting indexing status: ${error.message || error}`,
                    },
                ],
                isError: true,
            };
        }
    }
}
