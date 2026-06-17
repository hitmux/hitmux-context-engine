import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    Context,
    FileSynchronizer,
    IncrementalIndexTooLargeError,
    configManager,
    getEmbeddingIndexingDefaults,
} from "@hitmux/hitmux-context-engine-core";
import { SnapshotManager } from "./snapshot.js";
import type { RequestSplitterType } from "./config.js";
import {
    createRequestSplitter,
    resolveRequestSplitterType,
} from "./splitter.js";
import { queryCollectionStats } from "./collection-stats.js";
import { acquireMcpWriterLock, type McpWriterLock } from "./sync-lock.js";
import { ProjectChangeTracker, type ProjectChangeState } from "./project-change-tracker.js";

const DEFAULT_INITIAL_SYNC_DELAY_MS = 5_000;
const DEFAULT_SYNC_INTERVAL_MS = 2 * 60 * 1000;
const MIN_SYNC_INTERVAL_MS = 1_000;
const DEFAULT_PROJECT_WATCHER_DEBOUNCE_MS = 1_000;
const DEFAULT_PROJECT_WATCHER_FALLBACK_SCAN_INTERVAL_MS = 10 * 60 * 1000;

function isBackgroundSyncEnabled(): boolean {
    return configManager.getBoolean("backgroundSync") ?? true;
}

function isAutoIndexingEnabled(): boolean {
    return configManager.getBoolean("autoIndexing") ?? true;
}

function getBackgroundSyncIntervalMs(): number {
    const intervalMs = configManager.getNumber("syncIntervalMs");
    if (intervalMs === undefined) {
        return DEFAULT_SYNC_INTERVAL_MS;
    }

    if (!Number.isFinite(intervalMs) || intervalMs < MIN_SYNC_INTERVAL_MS) {
        console.warn(
            `[SYNC-DEBUG] Invalid config.syncIntervalMs value '${intervalMs}'. ` +
                `Falling back to ${DEFAULT_SYNC_INTERVAL_MS}ms.`,
        );
        return DEFAULT_SYNC_INTERVAL_MS;
    }

    return Math.floor(intervalMs);
}

function getSyncConcurrencyForCodebase(codebasePath: string): number {
    const concurrency = configManager.getNumber("embeddingConcurrency", codebasePath);
    const defaultConcurrency = getEmbeddingIndexingDefaults(
        configManager.getString("embeddingProvider", codebasePath),
        configManager.getString("embeddingModel", codebasePath),
    ).concurrency;
    if (concurrency === undefined) {
        return defaultConcurrency;
    }

    if (!Number.isFinite(concurrency) || concurrency < 1) {
        console.warn(
            `[SYNC-DEBUG] Invalid config.embeddingConcurrency value '${concurrency}'. Falling back to ${defaultConcurrency}.`,
        );
        return defaultConcurrency;
    }

    return Math.max(1, Math.floor(concurrency));
}

function getSyncConcurrency(indexedCodebases: string[]): number {
    if (indexedCodebases.length === 0) {
        return 1;
    }

    return indexedCodebases.reduce(
        (lowestConcurrency, codebasePath) => Math.min(
            lowestConcurrency,
            getSyncConcurrencyForCodebase(codebasePath),
        ),
        Number.POSITIVE_INFINITY,
    );
}

function isProjectWatcherEnabled(): boolean {
    return configManager.getBoolean("projectWatcher") ?? true;
}

function getProjectWatcherDebounceMs(): number {
    const value = configManager.getNumber("projectWatcherDebounceMs");
    if (value === undefined) {
        return DEFAULT_PROJECT_WATCHER_DEBOUNCE_MS;
    }

    if (!Number.isFinite(value) || value < 0) {
        console.warn(
            `[SYNC-DEBUG] Invalid config.projectWatcherDebounceMs value '${value}'. Falling back to ${DEFAULT_PROJECT_WATCHER_DEBOUNCE_MS}ms.`,
        );
        return DEFAULT_PROJECT_WATCHER_DEBOUNCE_MS;
    }

    return Math.floor(value);
}

function isProjectWatcherPollingEnabled(): boolean {
    return configManager.getBoolean("projectWatcherUsePolling") ?? false;
}

function getProjectWatcherFallbackScanIntervalMs(): number {
    const value = configManager.getNumber("projectWatcherFallbackScanIntervalMs");
    if (value === undefined) {
        return DEFAULT_PROJECT_WATCHER_FALLBACK_SCAN_INTERVAL_MS;
    }

    if (!Number.isFinite(value) || value < 0) {
        console.warn(
            `[SYNC-DEBUG] Invalid config.projectWatcherFallbackScanIntervalMs value '${value}'. Falling back to ${DEFAULT_PROJECT_WATCHER_FALLBACK_SCAN_INTERVAL_MS}ms.`,
        );
        return DEFAULT_PROJECT_WATCHER_FALLBACK_SCAN_INTERVAL_MS;
    }

    return Math.floor(value);
}

export interface CodebaseSyncStatus {
    codebasePath: string;
    phase: string;
    current: number;
    total: number;
    percentage: number;
    startedAtMs: number;
    updatedAtMs: number;
}

export class SyncManager {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private isSyncing: boolean = false;
    private syncLock: McpWriterLock | null = null;
    private triggerWatcher: fs.FSWatcher | null = null;
    private triggerDebounceTimer: NodeJS.Timeout | null = null;
    private backgroundSyncTimer: NodeJS.Timeout | null = null;
    private backgroundSyncIntervalMs: number | null = null;
    private backgroundSyncEnabled: boolean = false;
    private syncStatuses: Map<string, CodebaseSyncStatus> = new Map();
    private projectChangeTracker: ProjectChangeTracker | null = null;
    private lastFullScanMs: Map<string, number> = new Map();

    constructor(context: Context, snapshotManager: SnapshotManager) {
        this.context = context;
        this.snapshotManager = snapshotManager;
    }

    private acquireGlobalSyncLock(): boolean {
        if (this.syncLock) {
            return true;
        }

        this.syncLock = acquireMcpWriterLock("automatic sync");
        return this.syncLock !== null;
    }

    private releaseGlobalSyncLock(): void {
        if (this.syncLock) {
            this.syncLock.release();
            this.syncLock = null;
        }
    }

    public getSyncStatus(codebasePath: string): CodebaseSyncStatus | undefined {
        const status = this.syncStatuses.get(codebasePath);
        return status ? { ...status } : undefined;
    }

    public trackCodebase(codebasePath: string): void {
        const codebaseInfo = this.snapshotManager.getCodebaseInfo(codebasePath);
        this.ensureProjectWatcher(codebasePath, codebaseInfo?.requestIgnoreFiles || []);
    }

    public async syncCodebaseForSearch(
        codebasePath: string,
    ): Promise<{ added: number; removed: number; modified: number }> {
        return this.syncCodebase(codebasePath, 0, 1, {
            throwOnIncrementalTooLarge: true,
        });
    }

    private setCodebaseSyncStatus(
        codebasePath: string,
        status: Omit<CodebaseSyncStatus, "codebasePath">,
    ): void {
        this.syncStatuses.set(codebasePath, {
            codebasePath,
            ...status,
        });
    }

    private updateCodebaseSyncProgress(
        codebasePath: string,
        startedAtMs: number,
        progress: {
            phase: string;
            current: number;
            total: number;
            percentage: number;
        },
    ): void {
        this.setCodebaseSyncStatus(codebasePath, {
            phase: progress.phase,
            current: progress.current,
            total: progress.total,
            percentage: progress.percentage,
            startedAtMs,
            updatedAtMs: Date.now(),
        });
    }

    public async handleSyncIndex(): Promise<void> {
        const syncStartTime = Date.now();
        console.log(
            `[SYNC-DEBUG] handleSyncIndex() called at ${new Date().toISOString()}`,
        );

        if (!isAutoIndexingEnabled()) {
            console.log(
                "[SYNC-DEBUG] Automatic indexing is disabled via config.autoIndexing=false.",
            );
            return;
        }

        const indexedCodebases = this.snapshotManager.getIndexedCodebases();
        for (const codebasePath of indexedCodebases) {
            const codebaseInfo = this.snapshotManager.getCodebaseInfo(codebasePath);
            this.ensureProjectWatcher(codebasePath, codebaseInfo?.requestIgnoreFiles || []);
        }

        if (indexedCodebases.length === 0) {
            console.log("[SYNC-DEBUG] No codebases indexed. Skipping sync.");
            return;
        }

        console.log(
            `[SYNC-DEBUG] Found ${indexedCodebases.length} indexed codebases:`,
            indexedCodebases,
        );

        if (this.isSyncing) {
            console.log(
                "[SYNC-DEBUG] Index sync already in progress. Skipping.",
            );
            return;
        }

        if (!this.acquireGlobalSyncLock()) {
            return;
        }

        this.isSyncing = true;
        console.log(
            `[SYNC-DEBUG] Starting index sync for all ${indexedCodebases.length} codebases...`,
        );

        try {
            for (let i = 0; i < indexedCodebases.length; i++) {
                this.setCodebaseSyncStatus(indexedCodebases[i], {
                    phase: "Waiting for automatic sync...",
                    current: i,
                    total: indexedCodebases.length,
                    percentage: 0,
                    startedAtMs: syncStartTime,
                    updatedAtMs: Date.now(),
                });
            }

            const syncConcurrency = Math.min(
                getSyncConcurrency(indexedCodebases),
                indexedCodebases.length,
            );
            console.log(
                `[SYNC-DEBUG] Running automatic sync with concurrency ${syncConcurrency}`,
            );
            const syncResults = await this.runCodebaseSyncsWithConcurrency(
                indexedCodebases,
                syncConcurrency,
            );
            const totalStats = syncResults.reduce(
                (total, stats) => ({
                    added: total.added + stats.added,
                    removed: total.removed + stats.removed,
                    modified: total.modified + stats.modified,
                }),
                { added: 0, removed: 0, modified: 0 },
            );

            const totalElapsed = Date.now() - syncStartTime;
            console.log(
                `[SYNC-DEBUG] Total sync stats across all codebases: Added: ${totalStats.added}, Removed: ${totalStats.removed}, Modified: ${totalStats.modified}`,
            );
            console.log(
                `[SYNC-DEBUG] Index sync completed for all codebases in ${totalElapsed}ms`,
            );
            console.log(
                `[SYNC] Index sync completed for all codebases. Total changes - Added: ${totalStats.added}, Removed: ${totalStats.removed}, Modified: ${totalStats.modified}`,
            );
        } catch (error: any) {
            const totalElapsed = Date.now() - syncStartTime;
            console.error(
                `[SYNC-DEBUG] Error during index sync after ${totalElapsed}ms:`,
                error,
            );
            console.error(`[SYNC-DEBUG] Error stack:`, error.stack);
        } finally {
            this.isSyncing = false;
            this.syncStatuses.clear();
            this.releaseGlobalSyncLock();
            const totalElapsed = Date.now() - syncStartTime;
            console.log(
                `[SYNC-DEBUG] handleSyncIndex() finished at ${new Date().toISOString()}, total duration: ${totalElapsed}ms`,
            );
        }
    }

    private async runCodebaseSyncsWithConcurrency(
        indexedCodebases: string[],
        concurrency: number,
    ): Promise<Array<{ added: number; removed: number; modified: number }>> {
        const results: Array<{ added: number; removed: number; modified: number }> =
            new Array(indexedCodebases.length);
        let nextIndex = 0;

        const runWorker = async (): Promise<void> => {
            while (nextIndex < indexedCodebases.length) {
                const index = nextIndex;
                nextIndex += 1;
                results[index] = await this.syncCodebase(
                    indexedCodebases[index],
                    index,
                    indexedCodebases.length,
                );
            }
        };

        await Promise.all(
            Array.from({ length: concurrency }, () => runWorker()),
        );
        return results;
    }

    private async syncCodebase(
        codebasePath: string,
        index: number,
        totalCodebases: number,
        options: { throwOnIncrementalTooLarge?: boolean } = {},
    ): Promise<{ added: number; removed: number; modified: number }> {
        const codebaseStartTime = Date.now();

        console.log(
            `[SYNC-DEBUG] [${index + 1}/${totalCodebases}] Starting sync for codebase: '${codebasePath}'`,
        );

        try {
            const pathExists = fs.existsSync(codebasePath);
            console.log(`[SYNC-DEBUG] Codebase path exists: ${pathExists}`);

            if (!pathExists) {
                console.warn(
                    `[SYNC-DEBUG] Codebase path '${codebasePath}' no longer exists. Skipping sync.`,
                );
                this.syncStatuses.delete(codebasePath);
                return { added: 0, removed: 0, modified: 0 };
            }
        } catch (pathError: any) {
            console.error(
                `[SYNC-DEBUG] Error checking codebase path '${codebasePath}':`,
                pathError,
            );
            this.syncStatuses.delete(codebasePath);
            return { added: 0, removed: 0, modified: 0 };
        }

        try {
            console.log(`[SYNC-DEBUG] Preparing sync for '${codebasePath}'`);
            this.setCodebaseSyncStatus(codebasePath, {
                phase: "Checking for file changes...",
                current: 0,
                total: 100,
                percentage: 0,
                startedAtMs: codebaseStartTime,
                updatedAtMs: Date.now(),
            });
            const codebaseInfo = this.snapshotManager.getCodebaseInfo(codebasePath);
            const requestSplitterType: RequestSplitterType =
                resolveRequestSplitterType(codebaseInfo?.requestSplitter);
            const requestIgnorePatterns = codebaseInfo?.requestIgnorePatterns || [];
            const requestCustomExtensions =
                codebaseInfo?.requestCustomExtensions || [];
            const requestIgnoreFiles = codebaseInfo?.requestIgnoreFiles || [];
            const requestMaxDepth = codebaseInfo?.requestMaxDepth;
            const progressCallback = (progress: { phase: string; current: number; total: number; percentage: number }) =>
                this.updateCodebaseSyncProgress(
                    codebasePath,
                    codebaseStartTime,
                    progress,
                );
            const state = this.getProjectChangeStateForSync(codebasePath, requestIgnoreFiles);
            const stats = await this.runContextSyncForState(
                codebasePath,
                state,
                progressCallback,
                requestIgnorePatterns,
                requestCustomExtensions,
                createRequestSplitter(requestSplitterType),
                requestIgnoreFiles,
                requestMaxDepth,
            );
            const codebaseElapsed = Date.now() - codebaseStartTime;

            console.log(`[SYNC-DEBUG] Reindex stats for '${codebasePath}':`, stats);
            console.log(
                `[SYNC-DEBUG] Codebase sync completed in ${codebaseElapsed}ms`,
            );

            if (stats.added > 0 || stats.removed > 0 || stats.modified > 0) {
                const collectionStats = await queryCollectionStats(
                    this.context,
                    codebasePath,
                    "SYNC-STATS",
                );
                if (collectionStats) {
                    this.snapshotManager.setCodebaseIndexed(codebasePath, {
                        ...collectionStats,
                        status: "completed",
                    });
                    this.snapshotManager.saveCodebaseSnapshot();
                } else {
                    this.snapshotManager.clearCodebaseSyncWarning(codebasePath);
                    this.snapshotManager.saveCodebaseSnapshot();
                }
                console.log(
                    `[SYNC] Sync complete for '${codebasePath}'. Added: ${stats.added}, Removed: ${stats.removed}, Modified: ${stats.modified} (${codebaseElapsed}ms)`,
                );
            } else {
                const previousInfo =
                    this.snapshotManager.getCodebaseInfo(codebasePath);
                const hadSyncWarning =
                    previousInfo?.status === "indexed" &&
                    typeof previousInfo.syncWarning === "string";
                this.snapshotManager.clearCodebaseSyncWarning(codebasePath);
                if (hadSyncWarning) {
                    this.snapshotManager.saveCodebaseSnapshot();
                }
                console.log(
                    `[SYNC] No changes detected for '${codebasePath}' (${codebaseElapsed}ms)`,
                );
            }

            return stats;
        } catch (error: any) {
            const codebaseElapsed = Date.now() - codebaseStartTime;
            if (error instanceof IncrementalIndexTooLargeError) {
                if (options.throwOnIncrementalTooLarge === true) {
                    throw error;
                }
                const warning = `Automatic incremental indexing paused: detected ${error.effectiveLines} effective lines across ${error.changedFiles} added/modified file(s), exceeding the ${error.threshold} line limit. Check whether this is a large batch of files that should be added to .hceignore. If the files should be indexed, review the change set and run index_codebase with incremental=true from MCP.`;
                console.warn(`[SYNC] ${warning}`);
                this.snapshotManager.setCodebaseSyncWarning(codebasePath, warning);
                this.snapshotManager.saveCodebaseSnapshot();
                return { added: 0, removed: 0, modified: 0 };
            }

            console.error(
                `[SYNC-DEBUG] Error syncing codebase '${codebasePath}' after ${codebaseElapsed}ms:`,
                error,
            );
            console.error(`[SYNC-DEBUG] Error stack:`, error.stack);

            if (error.message.includes("Failed to query Milvus")) {
                await FileSynchronizer.deleteSnapshot(codebasePath);
            }

            if (error.code) {
                console.error(`[SYNC-DEBUG] Error code: ${error.code}`);
            }
            if (error.errno) {
                console.error(`[SYNC-DEBUG] Error errno: ${error.errno}`);
            }

            return { added: 0, removed: 0, modified: 0 };
        } finally {
            this.syncStatuses.delete(codebasePath);
        }
    }

    public startBackgroundSync(): void {
        console.log("[SYNC-DEBUG] startBackgroundSync() called");

        if (!isAutoIndexingEnabled()) {
            console.log(
                "[SYNC-DEBUG] Automatic indexing is disabled via config.autoIndexing=false.",
            );
            return;
        }

        // Set up the trigger file watcher first, independent of polling.
        this.setupTriggerWatcher();
        for (const codebasePath of this.snapshotManager.getIndexedCodebases()) {
            this.ensureProjectWatcher(codebasePath);
        }

        if (!isBackgroundSyncEnabled()) {
            console.log(
                "[SYNC-DEBUG] Background sync is disabled via config.backgroundSync=false.",
            );
            return;
        }

        if (this.backgroundSyncEnabled) {
            console.log(
                "[SYNC-DEBUG] Background sync polling is already active, skipping re-init",
            );
            return;
        }

        const syncIntervalMs = getBackgroundSyncIntervalMs();
        this.backgroundSyncIntervalMs = syncIntervalMs;
        this.backgroundSyncEnabled = true;

        // Execute initial sync immediately after a short delay to let server initialize
        console.log(
            `[SYNC-DEBUG] Scheduling initial sync in ${DEFAULT_INITIAL_SYNC_DELAY_MS}ms...`,
        );
        this.scheduleBackgroundSync(DEFAULT_INITIAL_SYNC_DELAY_MS, "initial");

        // Periodically check for file changes and update the index. The next
        // timer is scheduled only after the current sync attempt settles, so
        // a long sync cannot queue or overlap with another periodic sync.
        console.log(
            `[SYNC-DEBUG] Background sync will repeat every ${syncIntervalMs}ms after each completed run`,
        );

        console.log(
            "[SYNC-DEBUG] Background sync setup complete. Timer ID:",
            this.backgroundSyncTimer,
        );
    }

    private scheduleBackgroundSync(
        delayMs: number,
        reason: "initial" | "periodic",
    ): void {
        this.backgroundSyncTimer = setTimeout(async () => {
            this.backgroundSyncTimer = null;
            const label =
                reason === "initial"
                    ? "initial sync after server startup"
                    : "scheduled periodic sync";
            console.log(`[SYNC-DEBUG] Executing ${label}`);

            try {
                await this.handleSyncIndex();
            } catch (error) {
                const errorMessage =
                    error instanceof Error ? error.message : String(error);
                if (errorMessage.includes("Failed to query collection")) {
                    console.log(
                        "[SYNC-DEBUG] Collection not yet established, this is expected for new cluster users. Will retry on next sync cycle.",
                    );
                } else {
                    console.error(
                        `[SYNC-DEBUG] ${reason === "initial" ? "Initial" : "Periodic"} sync failed with unexpected error:`,
                        error,
                    );
                }
            } finally {
                if (
                    this.backgroundSyncEnabled &&
                    this.backgroundSyncIntervalMs !== null
                ) {
                    this.scheduleBackgroundSync(
                        this.backgroundSyncIntervalMs,
                        "periodic",
                    );
                }
            }
        }, delayMs);
    }

    public stopBackgroundSync(): void {
        this.backgroundSyncEnabled = false;
        this.backgroundSyncIntervalMs = null;
        if (this.backgroundSyncTimer) {
            clearTimeout(this.backgroundSyncTimer);
            this.backgroundSyncTimer = null;
        }
        this.stopTriggerWatcher();
        void this.stopProjectWatcher();
    }

    public async stopProjectWatcher(): Promise<void> {
        if (this.projectChangeTracker) {
            await this.projectChangeTracker.close();
            this.projectChangeTracker = null;
        }
    }

    private ensureProjectWatcher(codebasePath: string, requestIgnoreFiles: string[] = []): void {
        if (!isProjectWatcherEnabled()) {
            return;
        }

        if (!this.projectChangeTracker) {
            this.projectChangeTracker = new ProjectChangeTracker({
                debounceMs: getProjectWatcherDebounceMs(),
                usePolling: isProjectWatcherPollingEnabled(),
            });
        }

        this.projectChangeTracker.watch(codebasePath, requestIgnoreFiles);
    }

    private getProjectChangeStateForSync(codebasePath: string, requestIgnoreFiles: string[] = []): ProjectChangeState | null {
        if (!isProjectWatcherEnabled()) {
            return null;
        }

        this.ensureProjectWatcher(codebasePath, requestIgnoreFiles);
        return this.projectChangeTracker?.getState(codebasePath) ?? null;
    }

    private async runContextSyncForState(
        codebasePath: string,
        state: ProjectChangeState | null,
        progressCallback: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        requestIgnorePatterns: string[],
        requestCustomExtensions: string[],
        requestSplitter: ReturnType<typeof createRequestSplitter>,
        requestIgnoreFiles: string[],
        requestMaxDepth: number | undefined,
    ): Promise<{ added: number; removed: number; modified: number }> {
        const fallbackIntervalMs = getProjectWatcherFallbackScanIntervalMs();
        const lastFullScanMs = this.lastFullScanMs.get(codebasePath);
        const fullScanDue =
            state === null ||
            lastFullScanMs === undefined ||
            Date.now() - lastFullScanMs >= fallbackIntervalMs;

        if (state?.kind === "clean" && !fullScanDue) {
            progressCallback({ phase: "No watcher changes detected", current: 100, total: 100, percentage: 100 });
            return { added: 0, removed: 0, modified: 0 };
        }

        if (
            state?.kind === "dirty" &&
            state.paths.length > 0 &&
            !fullScanDue &&
            typeof this.context.reindexChangedPaths === "function"
        ) {
            console.log(
                `[SYNC-DEBUG] Calling context.reindexChangedPaths() for '${codebasePath}' with ${state.paths.length} dirty path(s)`,
            );
            const stats = await this.context.reindexChangedPaths(
                codebasePath,
                state.paths,
                progressCallback,
                requestIgnorePatterns,
                requestCustomExtensions,
                requestSplitter,
                requestIgnoreFiles,
                requestMaxDepth,
            );
            this.projectChangeTracker?.markPathsClean(codebasePath, state.paths, state.version);
            return stats;
        }

        if (state?.kind === "unknown") {
            console.log(
                `[SYNC-DEBUG] Project watcher state is unknown for '${codebasePath}' (${state.reason}); falling back to full change scan.`,
            );
        } else if (state?.kind === "dirty" && typeof this.context.reindexChangedPaths !== "function") {
            console.log(
                `[SYNC-DEBUG] context.reindexChangedPaths() is unavailable for '${codebasePath}'; falling back to full change scan.`,
            );
        } else if (fullScanDue) {
            console.log(
                `[SYNC-DEBUG] Project watcher fallback scan is due for '${codebasePath}'; running full change scan.`,
            );
        }

        const stats = await this.context.reindexByChange(
            codebasePath,
            progressCallback,
            requestIgnorePatterns,
            requestCustomExtensions,
            requestSplitter,
            requestIgnoreFiles,
            requestMaxDepth,
        );
        this.lastFullScanMs.set(codebasePath, Date.now());
        this.projectChangeTracker?.markClean(codebasePath, state?.version);
        return stats;
    }

    /**
     * Read config.triggerWatcher. Default ON — the watcher is cheap and only
     * fires when an external process explicitly touches the trigger file. Users who want
     * zero filesystem watching (e.g. read-only filesystems, sandboxed envs) can disable it.
     */
    private isTriggerWatcherEnabled(): boolean {
        return configManager.getBoolean("triggerWatcher") ?? true;
    }

    /**
     * Watch for trigger file changes to enable instant re-index.
     * Claude Code PostToolUse hooks can touch ~/.hitmux-context-engine/.sync-trigger
     * after Write/Edit operations to trigger immediate re-indexing.
     */
    private setupTriggerWatcher(): void {
        if (!this.isTriggerWatcherEnabled()) {
            console.log(
                "[SYNC-DEBUG] Trigger watcher disabled via config.triggerWatcher=false",
            );
            return;
        }

        // Guard against double-initialization (hot reload, repeated test setup).
        if (this.triggerWatcher) {
            console.log(
                "[SYNC-DEBUG] Trigger watcher already active, skipping re-init",
            );
            return;
        }

        const contextDir = path.join(os.homedir(), ".hitmux-context-engine");
        const triggerFile = ".sync-trigger";
        const triggerPath = path.join(contextDir, triggerFile);

        try {
            // Ensure context dir exists before watching (snapshot manager
            // also creates it, but be defensive in case watcher starts first).
            fs.mkdirSync(contextDir, { recursive: true });

            // Pass encoding so `filename` is consistently a string across platforms
            // (default can be Buffer on some Node builds).
            const watcher = fs.watch(
                contextDir,
                { encoding: "utf8" },
                (_event, filename) => {
                    // With encoding: 'utf8', filename is `string | null`. null happens on
                    // some platforms when the underlying event lacks a name; treat as no-op.
                    if (
                        typeof filename !== "string" ||
                        filename !== triggerFile
                    )
                        return;

                    if (this.triggerDebounceTimer)
                        clearTimeout(this.triggerDebounceTimer);
                    this.triggerDebounceTimer = setTimeout(() => {
                        console.log(
                            "[SYNC] Trigger file detected, starting instant re-index...",
                        );
                        // Fire-and-forget with explicit catch so an unhandled rejection
                        // can't crash the process from inside the setTimeout callback.
                        void this.handleSyncIndex().catch((error) => {
                            const errorMessage =
                                error instanceof Error
                                    ? error.message
                                    : String(error);
                            if (
                                errorMessage.includes(
                                    "Failed to query collection",
                                )
                            ) {
                                console.log(
                                    "[SYNC-DEBUG] Collection not yet established during trigger sync; will retry on next cycle.",
                                );
                            } else {
                                console.error(
                                    "[SYNC-DEBUG] Triggered sync failed with unexpected error:",
                                    error,
                                );
                            }
                        });
                    }, 2000);
                },
            );

            // fs.watch can emit `error` asynchronously (e.g. dir deleted, fs unmounted).
            // Without a listener this would crash the process.
            watcher.on("error", (err) => {
                console.warn(
                    "[SYNC-DEBUG] Trigger watcher error:",
                    err instanceof Error ? err.message : String(err),
                );
                this.stopTriggerWatcher();
            });

            this.triggerWatcher = watcher;
            console.log(
                `[SYNC-DEBUG] Trigger watcher active on ${triggerPath}`,
            );
        } catch (error) {
            if (error instanceof Error) {
                console.warn(
                    "[SYNC-DEBUG] Could not set up trigger watcher:",
                    error.message,
                );
                if (error.stack) console.warn(error.stack);
            } else {
                console.warn(
                    "[SYNC-DEBUG] Could not set up trigger watcher:",
                    String(error),
                );
            }
        }
    }

    /** Stop the watcher (idempotent). Useful for tests or graceful shutdown. */
    public stopTriggerWatcher(): void {
        if (this.triggerDebounceTimer) {
            clearTimeout(this.triggerDebounceTimer);
            this.triggerDebounceTimer = null;
        }
        if (this.triggerWatcher) {
            try {
                this.triggerWatcher.close();
            } catch {
                /* already closed */
            }
            this.triggerWatcher = null;
        }
    }
}
