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
import {
    acquireMcpWriterLock,
    formatMcpWriterLockBusyMessage,
    type McpWriterLock,
} from "./sync-lock.js";
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

function getProjectWatcherIgnoredDirectories(): string[] {
    return configManager.getStringArray("projectWatcherIgnoredDirs");
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

export type SearchConsistencyMode = "low_latency" | "strong";

export interface CodebaseSyncStats {
    added: number;
    removed: number;
    modified: number;
    warning?: string;
}

export class SyncManager {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private isSyncing: boolean = false;
    private triggerWatcher: fs.FSWatcher | null = null;
    private triggerDebounceTimer: NodeJS.Timeout | null = null;
    private backgroundSyncTimer: NodeJS.Timeout | null = null;
    private backgroundSyncIntervalMs: number | null = null;
    private backgroundSyncEnabled: boolean = false;
    private syncStatuses: Map<string, CodebaseSyncStatus> = new Map();
    private projectChangeTracker: ProjectChangeTracker | null = null;
    private lastFullScanMs: Map<string, number> = new Map();
    private projectWatcherSyncTimers: Map<string, NodeJS.Timeout> = new Map();
    private projectWatcherFullScanTimers: Map<string, NodeJS.Timeout> = new Map();
    private projectWatcherSyncActive: Set<string> = new Set();
    private projectWatcherSyncQueued: Set<string> = new Set();
    private projectWatcherFullScanQueued: Set<string> = new Set();

    constructor(context: Context, snapshotManager: SnapshotManager) {
        this.context = context;
        this.snapshotManager = snapshotManager;
    }

    public getSyncStatus(codebasePath: string): CodebaseSyncStatus | undefined {
        const status = this.syncStatuses.get(codebasePath);
        return status ? { ...status } : undefined;
    }

    public trackCodebase(codebasePath: string): void {
        const codebaseInfo = this.snapshotManager.getCodebaseInfo(codebasePath);
        this.ensureProjectWatcher(codebasePath, codebaseInfo?.requestIgnoreFiles || []);
    }

    private getCollectionNameForLock(codebasePath: string): string {
        const context = this.context as unknown as {
            getCollectionName?: (path: string) => string;
        };
        if (typeof context.getCollectionName === "function") {
            return context.getCollectionName(codebasePath);
        }

        return `codebase_${codebasePath.replace(/[^A-Za-z0-9]/g, "_")}`;
    }

    public async syncCodebaseForSearch(
        codebasePath: string,
        options: {
            consistencyMode?: SearchConsistencyMode;
            writerLockHeld?: boolean;
        } = {},
    ): Promise<CodebaseSyncStats> {
        return this.syncCodebase(codebasePath, 0, 1, {
            consistencyMode: options.consistencyMode ?? "strong",
            throwOnIncrementalTooLarge: true,
            throwOnSyncError: true,
            writerLockHeld: options.writerLockHeld === true,
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
            const syncWarnings = syncResults
                .map((stats, index) => ({
                    codebasePath: indexedCodebases[index],
                    warning: stats.warning,
                }))
                .filter((entry): entry is { codebasePath: string; warning: string } =>
                    typeof entry.warning === "string" && entry.warning.length > 0,
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
            if (syncWarnings.length > 0) {
                console.warn(
                    `[SYNC] Index sync completed with warnings. Total changes - Added: ${totalStats.added}, Removed: ${totalStats.removed}, Modified: ${totalStats.modified}. ` +
                        `Skipped or warned codebases: ${syncWarnings.length}.`,
                );
                console.warn(
                    `[SYNC] Index sync skipped or warned for ${syncWarnings.length} codebase(s): ` +
                        syncWarnings.map((entry) => `${entry.codebasePath}: ${entry.warning}`).join("; "),
                );
            } else {
                console.log(
                    `[SYNC] Index sync completed for all codebases. Total changes - Added: ${totalStats.added}, Removed: ${totalStats.removed}, Modified: ${totalStats.modified}`,
                );
            }
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
            this.drainQueuedProjectWatcherSyncs();
            const totalElapsed = Date.now() - syncStartTime;
            console.log(
                `[SYNC-DEBUG] handleSyncIndex() finished at ${new Date().toISOString()}, total duration: ${totalElapsed}ms`,
            );
        }
    }

    private async runCodebaseSyncsWithConcurrency(
        indexedCodebases: string[],
        concurrency: number,
    ): Promise<CodebaseSyncStats[]> {
        const results: CodebaseSyncStats[] = new Array(indexedCodebases.length);
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
        options: {
            consistencyMode?: SearchConsistencyMode;
            throwOnIncrementalTooLarge?: boolean;
            throwOnSyncError?: boolean;
            forceFullScan?: boolean;
            writerLockHeld?: boolean;
        } = {},
    ): Promise<CodebaseSyncStats> {
        const codebaseStartTime = Date.now();
        const collectionName = this.getCollectionNameForLock(codebasePath);
        const lockScope = { kind: "collection" as const, collectionName };
        let writerLock: McpWriterLock | null = null;

        console.log(
            `[SYNC-DEBUG] [${index + 1}/${totalCodebases}] Starting sync for codebase: '${codebasePath}'`,
        );

        if (options.writerLockHeld !== true) {
            writerLock = acquireMcpWriterLock(
                `automatic sync for '${codebasePath}'`,
                lockScope,
            );
            if (!writerLock) {
                const warning = formatMcpWriterLockBusyMessage(
                    `automatic sync for '${codebasePath}'`,
                    lockScope,
                );
                console.log(`[SYNC-DEBUG] Skipping automatic sync: ${warning}`);
                this.snapshotManager.setCodebaseSyncWarning(codebasePath, warning);
                await this.snapshotManager.saveCodebaseSnapshotAsync();
                return { added: 0, removed: 0, modified: 0, warning };
            }
        }

        try {
            const pathExists = fs.existsSync(codebasePath);
            console.log(`[SYNC-DEBUG] Codebase path exists: ${pathExists}`);

            if (!pathExists) {
                console.warn(
                    `[SYNC-DEBUG] Codebase path '${codebasePath}' no longer exists. Removing it from automatic sync tracking.`,
                );
                await this.removeMissingCodebaseFromTracking(codebasePath);
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
                options.consistencyMode ?? "strong",
                options.forceFullScan === true,
            );
            const codebaseElapsed = Date.now() - codebaseStartTime;

            console.log(`[SYNC-DEBUG] Reindex stats for '${codebasePath}':`, stats);
            console.log(
                `[SYNC-DEBUG] Codebase sync completed in ${codebaseElapsed}ms`,
            );

            if (stats.added > 0 || stats.removed > 0 || stats.modified > 0) {
                this.snapshotManager.markCodebaseSynced(codebasePath, stats);
                await this.snapshotManager.saveCodebaseSnapshotAsync();
                console.log(
                    `[SYNC] Sync complete for '${codebasePath}'. Added: ${stats.added}, Removed: ${stats.removed}, Modified: ${stats.modified} (${codebaseElapsed}ms)`,
                );
            } else {
                if (!stats.warning) {
                    const previousInfo =
                        this.snapshotManager.getCodebaseInfo(codebasePath);
                    const hadSyncWarning =
                        previousInfo?.status === "indexed" &&
                        typeof previousInfo.syncWarning === "string";
                    this.snapshotManager.clearCodebaseSyncWarning(codebasePath);
                    if (hadSyncWarning) {
                        await this.snapshotManager.saveCodebaseSnapshotAsync();
                    }
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
                await this.snapshotManager.saveCodebaseSnapshotAsync();
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

            if (options.throwOnSyncError === true) {
                throw error;
            }

            return { added: 0, removed: 0, modified: 0 };
        } finally {
            this.syncStatuses.delete(codebasePath);
            writerLock?.release();
        }
    }

    private async removeMissingCodebaseFromTracking(codebasePath: string): Promise<void> {
        const timer = this.projectWatcherSyncTimers.get(codebasePath);
        if (timer) {
            clearTimeout(timer);
            this.projectWatcherSyncTimers.delete(codebasePath);
        }
        const fullScanTimer = this.projectWatcherFullScanTimers.get(codebasePath);
        if (fullScanTimer) {
            clearTimeout(fullScanTimer);
            this.projectWatcherFullScanTimers.delete(codebasePath);
        }

        this.projectWatcherSyncQueued.delete(codebasePath);
        this.projectWatcherFullScanQueued.delete(codebasePath);
        this.projectWatcherSyncActive.delete(codebasePath);
        this.lastFullScanMs.delete(codebasePath);
        this.syncStatuses.delete(codebasePath);
        this.projectChangeTracker?.unwatch(codebasePath);
        this.snapshotManager.removeCodebaseCompletely(codebasePath);
        await this.snapshotManager.saveCodebaseSnapshotAsync();
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
        this.clearProjectWatcherSyncTimers();
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
                ignoredDirectories: getProjectWatcherIgnoredDirectories(),
                onChange: (changedCodebasePath) => {
                    this.scheduleProjectWatcherSync(changedCodebasePath);
                },
            });
        }

        this.projectChangeTracker.watch(codebasePath, requestIgnoreFiles);
    }

    private clearProjectWatcherSyncTimers(): void {
        for (const timer of this.projectWatcherSyncTimers.values()) {
            clearTimeout(timer);
        }
        for (const timer of this.projectWatcherFullScanTimers.values()) {
            clearTimeout(timer);
        }
        this.projectWatcherSyncTimers.clear();
        this.projectWatcherFullScanTimers.clear();
        this.projectWatcherSyncQueued.clear();
        this.projectWatcherFullScanQueued.clear();
    }

    private scheduleProjectWatcherSync(codebasePath: string, delayMs: number = 0): void {
        if (!isAutoIndexingEnabled() || !isProjectWatcherEnabled()) {
            return;
        }

        const info = this.snapshotManager.getCodebaseInfo(codebasePath);
        if (!info || info.status !== "indexed") {
            return;
        }
        if (!fs.existsSync(codebasePath)) {
            return;
        }

        const existingTimer = this.projectWatcherSyncTimers.get(codebasePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
            this.projectWatcherSyncTimers.delete(codebasePath);
            void this.runProjectWatcherSync(codebasePath).catch((error) => {
                console.error(
                    `[SYNC-DEBUG] Project watcher sync failed for '${codebasePath}':`,
                    error,
                );
            });
        }, Math.max(0, Math.floor(delayMs)));
        timer.unref?.();
        this.projectWatcherSyncTimers.set(codebasePath, timer);
    }

    private scheduleFullScanReconciliation(codebasePath: string, delayMs: number = 0): void {
        if (!isAutoIndexingEnabled() || !isProjectWatcherEnabled()) {
            return;
        }

        const info = this.snapshotManager.getCodebaseInfo(codebasePath);
        if (!info || info.status !== "indexed") {
            return;
        }
        if (!fs.existsSync(codebasePath)) {
            return;
        }

        if (this.projectWatcherFullScanTimers.has(codebasePath)) {
            return;
        }

        const timer = setTimeout(() => {
            this.projectWatcherFullScanTimers.delete(codebasePath);
            void this.runProjectWatcherSync(codebasePath, { forceFullScan: true }).catch((error) => {
                console.error(
                    `[SYNC-DEBUG] Project watcher full-scan reconciliation failed for '${codebasePath}':`,
                    error,
                );
            });
        }, Math.max(0, Math.floor(delayMs)));
        timer.unref?.();
        this.projectWatcherFullScanTimers.set(codebasePath, timer);
    }

    private async runProjectWatcherSync(
        codebasePath: string,
        options: { forceFullScan?: boolean } = {},
    ): Promise<void> {
        const forceFullScan = options.forceFullScan === true;
        if (this.projectWatcherSyncActive.size > 0) {
            if (forceFullScan) {
                this.projectWatcherFullScanQueued.add(codebasePath);
            } else {
                this.projectWatcherSyncQueued.add(codebasePath);
            }
            return;
        }

        if (this.isSyncing) {
            if (forceFullScan) {
                this.projectWatcherFullScanQueued.add(codebasePath);
            } else {
                this.projectWatcherSyncQueued.add(codebasePath);
            }
            return;
        }

        this.isSyncing = true;
        this.projectWatcherSyncActive.add(codebasePath);
        try {
            const info = this.snapshotManager.getCodebaseInfo(codebasePath);
            if (!info || info.status !== "indexed") {
                return;
            }

            await this.syncCodebase(codebasePath, 0, 1, {
                consistencyMode: "low_latency",
                forceFullScan,
            });

            if (!fs.existsSync(codebasePath)) {
                return;
            }

            const state = this.projectChangeTracker?.getState(codebasePath);
            if (state?.kind === "dirty" || state?.kind === "unknown") {
                this.projectWatcherSyncQueued.add(codebasePath);
            }
        } finally {
            this.projectWatcherSyncActive.delete(codebasePath);
            this.isSyncing = false;
            if (this.projectWatcherSyncQueued.delete(codebasePath)) {
                this.scheduleProjectWatcherSync(codebasePath);
            }
            if (this.projectWatcherFullScanQueued.delete(codebasePath)) {
                this.scheduleFullScanReconciliation(codebasePath, Math.max(1, getProjectWatcherDebounceMs()));
            }
            if (this.projectWatcherSyncActive.size === 0) {
                this.drainQueuedProjectWatcherSyncs();
            }
        }
    }

    private drainQueuedProjectWatcherSyncs(): void {
        const queuedCodebases = Array.from(this.projectWatcherSyncQueued);
        this.projectWatcherSyncQueued.clear();
        for (const queuedCodebasePath of queuedCodebases) {
            this.scheduleProjectWatcherSync(queuedCodebasePath);
        }

        const queuedFullScans = Array.from(this.projectWatcherFullScanQueued);
        this.projectWatcherFullScanQueued.clear();
        for (const queuedCodebasePath of queuedFullScans) {
            this.scheduleFullScanReconciliation(queuedCodebasePath, Math.max(1, getProjectWatcherDebounceMs()));
        }
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
        consistencyMode: SearchConsistencyMode,
        forceFullScan: boolean,
    ): Promise<CodebaseSyncStats> {
        const fallbackIntervalMs = getProjectWatcherFallbackScanIntervalMs();
        const lastFullScanMs = this.lastFullScanMs.get(codebasePath);
        const fullScanDue =
            state === null ||
            lastFullScanMs === undefined ||
            Date.now() - lastFullScanMs >= fallbackIntervalMs;
        const fullScanDeferredWarning =
            "Search used the current index without blocking on a due full-scan reconciliation. A background sync was queued; results may be stale for changes not captured by watcher events.";

        if (forceFullScan) {
            progressCallback({ phase: "Running background full-scan reconciliation", current: 0, total: 100, percentage: 0 });
            console.log(
                `[SYNC-DEBUG] Running background full-scan reconciliation for '${codebasePath}'.`,
            );
            const startedAt = Date.now();
            const stats = await this.context.reindexByChange(
                codebasePath,
                progressCallback,
                requestIgnorePatterns,
                requestCustomExtensions,
                requestSplitter,
                requestIgnoreFiles,
                requestMaxDepth,
            );
            const elapsedMs = Date.now() - startedAt;
            this.lastFullScanMs.set(codebasePath, Date.now());
            this.projectChangeTracker?.markClean(codebasePath, state?.version);
            console.log(
                `[SYNC-DEBUG] Background full-scan reconciliation completed for '${codebasePath}' in ${elapsedMs}ms. Added: ${stats.added}, Removed: ${stats.removed}, Modified: ${stats.modified}`,
            );
            return stats;
        }

        if (consistencyMode === "low_latency") {
            if (state?.kind === "clean") {
                progressCallback({ phase: "No watcher changes detected", current: 100, total: 100, percentage: 100 });
                if (fullScanDue) {
                    this.scheduleFullScanReconciliation(codebasePath, Math.max(1, getProjectWatcherDebounceMs()));
                    return { added: 0, removed: 0, modified: 0, warning: fullScanDeferredWarning };
                }
                return { added: 0, removed: 0, modified: 0 };
            }

            if (
                state?.kind === "dirty" &&
                state.paths.length > 0 &&
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
                if (fullScanDue) {
                    this.scheduleFullScanReconciliation(codebasePath, Math.max(1, getProjectWatcherDebounceMs()));
                    return { ...stats, warning: fullScanDeferredWarning };
                }
                return stats;
            }

            let warning: string;
            if (state?.kind === "unknown") {
                warning = `Search used the current index because watcher state is unknown (${state.reason}). A background sync was queued; results may be stale.`;
            } else if (state?.kind === "dirty") {
                warning = "Search used the current index because targeted dirty-path sync is unavailable. A background sync was queued; results may be stale.";
            } else {
                warning = "Search used the current index without a pre-search consistency scan because watcher state is unavailable. A background sync was queued; results may be stale.";
            }
            this.scheduleFullScanReconciliation(codebasePath, Math.max(1, getProjectWatcherDebounceMs()));
            progressCallback({ phase: "Using current index for low-latency search", current: 100, total: 100, percentage: 100 });
            return { added: 0, removed: 0, modified: 0, warning };
        }

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

        progressCallback({ phase: "Running full change scan", current: 0, total: 100, percentage: 0 });
        const startedAt = Date.now();
        const stats = await this.context.reindexByChange(
            codebasePath,
            progressCallback,
            requestIgnorePatterns,
            requestCustomExtensions,
            requestSplitter,
            requestIgnoreFiles,
            requestMaxDepth,
        );
        const elapsedMs = Date.now() - startedAt;
        this.lastFullScanMs.set(codebasePath, Date.now());
        this.projectChangeTracker?.markClean(codebasePath, state?.version);
        console.log(
            `[SYNC-DEBUG] Full change scan completed for '${codebasePath}' in ${elapsedMs}ms. Added: ${stats.added}, Removed: ${stats.removed}, Modified: ${stats.modified}`,
        );
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
