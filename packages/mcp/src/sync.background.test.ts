import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IncrementalIndexTooLargeError } from "@hitmux/hitmux-context-engine-core";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";
import { ProjectChangeTracker } from "./project-change-tracker.js";
import { getMcpWriterLockPath } from "./sync-lock.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hitmux-context-engine-mcp-sync-"));
    const homeDir = path.join(tempRoot, "home");

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalCwd = process.cwd();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(tempRoot);

    try {
        await run(tempRoot);
    } finally {
        process.chdir(originalCwd);
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }

        if (originalUserProfile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = originalUserProfile;
        }

        await rm(tempRoot, { recursive: true, force: true });
    }
}

async function writeProjectConfig(projectRoot: string, config: Record<string, unknown>): Promise<void> {
    const configDir = path.join(projectRoot, ".hitmux-context-engine");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "config.conf"), stringifyConf(config), "utf-8");
}

function stringifyConf(config: Record<string, unknown>): string {
    return Object.entries(config)
        .flatMap(([key, value]) => Array.isArray(value)
            ? value.map(item => `${key} = ${String(item)}`)
            : [`${key} = ${String(value)}`])
        .join("\n") + "\n";
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (!condition()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error("Timed out waiting for condition");
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

test("background sync schedules the next periodic run only after the current run finishes", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });
        await writeProjectConfig(tempRoot, { projectWatcher: false });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        let activeSyncs = 0;
        let maxActiveSyncs = 0;
        let reindexCalls = 0;

        const context = {
            reindexByChange: async () => {
                activeSyncs += 1;
                maxActiveSyncs = Math.max(maxActiveSyncs, activeSyncs);
                reindexCalls += 1;
                await new Promise((resolve) => setTimeout(resolve, 35));
                activeSyncs -= 1;
                return { added: 0, removed: 0, modified: 0 };
            }
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);

        (syncManager as any).backgroundSyncEnabled = true;
        (syncManager as any).backgroundSyncIntervalMs = 5;
        (syncManager as any).scheduleBackgroundSync(0, "periodic");

        await waitFor(() => reindexCalls >= 2, 500);
        syncManager.stopBackgroundSync();
        await waitFor(() => activeSyncs === 0, 100);

        assert.equal(maxActiveSyncs, 1);
        assert.ok(reindexCalls >= 2);
    });
});

test("autoIndexing=false disables background reindexing", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });
        await writeProjectConfig(tempRoot, { autoIndexing: false });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        let reindexCalls = 0;
        const context = {
            reindexByChange: async () => {
                reindexCalls += 1;
                return { added: 0, removed: 0, modified: 0 };
            }
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex();

        assert.equal(reindexCalls, 0);
    });
});

test("automatic sync skips a locked collection and continues syncing other collections", async () => {
    await withTempHome(async (tempRoot) => {
        const firstCodebasePath = path.join(tempRoot, "repo-a");
        const secondCodebasePath = path.join(tempRoot, "repo-b");
        await mkdir(firstCodebasePath, { recursive: true });
        await mkdir(secondCodebasePath, { recursive: true });
        await writeProjectConfig(tempRoot, { projectWatcher: false });

        const snapshotManager = new SnapshotManager();
        for (const codebasePath of [firstCodebasePath, secondCodebasePath]) {
            snapshotManager.setCodebaseIndexed(codebasePath, {
                indexedFiles: 1,
                totalChunks: 1,
                status: "completed"
            });
        }
        snapshotManager.saveCodebaseSnapshot();

        const firstCollectionName = "collection_repo_a";
        await mkdir(
            getMcpWriterLockPath({ kind: "collection", collectionName: firstCollectionName }),
            { recursive: true }
        );

        const syncedCodebases: string[] = [];
        const context = {
            getCollectionName: (codebasePath: string) =>
                codebasePath === firstCodebasePath
                    ? firstCollectionName
                    : "collection_repo_b",
            reindexByChange: async (codebasePath: string) => {
                syncedCodebases.push(codebasePath);
                return { added: 0, removed: 0, modified: 0 };
            }
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex();

        assert.deepEqual(syncedCodebases, [secondCodebasePath]);
        const firstInfo = snapshotManager.getCodebaseInfo(firstCodebasePath);
        if (firstInfo?.status !== "indexed") {
            throw new Error("Expected first codebase to remain indexed");
        }
        assert.match(firstInfo.syncWarning ?? "", /already writing index state/);
    });
});

test("syncCodebaseForSearch acquires the collection lock when caller does not already hold it", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });
        await writeProjectConfig(tempRoot, { projectWatcher: false });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        let activeSyncs = 0;
        let maxActiveSyncs = 0;
        let reindexCalls = 0;
        let releaseFirstSync!: () => void;
        const firstSyncGate = new Promise<void>((resolve) => {
            releaseFirstSync = resolve;
        });
        const context = {
            getCollectionName: () => "collection_search_sync",
            reindexByChange: async () => {
                activeSyncs += 1;
                maxActiveSyncs = Math.max(maxActiveSyncs, activeSyncs);
                reindexCalls += 1;
                try {
                    await firstSyncGate;
                    return { added: 0, removed: 0, modified: 0 };
                } finally {
                    activeSyncs -= 1;
                }
            }
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);

        const firstSyncPromise = syncManager.syncCodebaseForSearch(codebasePath);
        await waitFor(() => activeSyncs === 1, 500);
        const secondStats = await syncManager.syncCodebaseForSearch(codebasePath);

        assert.equal(reindexCalls, 1);
        assert.equal(maxActiveSyncs, 1);
        assert.match(secondStats.warning ?? "", /already writing index state/);

        releaseFirstSync();
        await firstSyncPromise;
    });
});

test("background sync exposes per-codebase progress while running", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        let releaseSync!: () => void;
        const syncGate = new Promise<void>((resolve) => {
            releaseSync = resolve;
        });

        const context = {
            reindexByChange: async (pathArg: string, progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void) => {
                assert.equal(pathArg, codebasePath);
                progressCallback?.({
                    phase: "Removed third_party/generated.c",
                    current: 1,
                    total: 4,
                    percentage: 25
                });
                await syncGate;
                return { added: 0, removed: 1, modified: 0 };
            }
        } as any;

        const syncManager = new SyncManager(context, snapshotManager);
        const syncPromise = syncManager.handleSyncIndex();

        await waitFor(() => syncManager.getSyncStatus(codebasePath)?.percentage === 25, 500);
        const status = syncManager.getSyncStatus(codebasePath);
        assert.equal(status?.phase, "Removed third_party/generated.c");
        assert.equal(status?.current, 1);
        assert.equal(status?.total, 4);

        releaseSync();
        await syncPromise;
        assert.equal(syncManager.getSyncStatus(codebasePath), undefined);
    });
});

test("background sync processes multiple codebases concurrently", async () => {
    await withTempHome(async (tempRoot) => {
        await writeProjectConfig(tempRoot, { embeddingConcurrency: 4 });
        const firstCodebasePath = path.join(tempRoot, "repo-a");
        const secondCodebasePath = path.join(tempRoot, "repo-b");
        await mkdir(firstCodebasePath, { recursive: true });
        await mkdir(secondCodebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        for (const codebasePath of [firstCodebasePath, secondCodebasePath]) {
            snapshotManager.setCodebaseIndexed(codebasePath, {
                indexedFiles: 1,
                totalChunks: 1,
                status: "completed"
            });
        }
        snapshotManager.saveCodebaseSnapshot();

        let activeSyncs = 0;
        let maxActiveSyncs = 0;
        const context = {
            reindexByChange: async () => {
                activeSyncs += 1;
                maxActiveSyncs = Math.max(maxActiveSyncs, activeSyncs);
                await sleep(30);
                activeSyncs -= 1;
                return { added: 0, removed: 0, modified: 0 };
            }
        } as any;

        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex();

        assert.equal(maxActiveSyncs, 2);
    });
});

test("background sync uses provider default concurrency when embeddingConcurrency is not configured", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePaths = [
            path.join(tempRoot, "repo-a"),
            path.join(tempRoot, "repo-b"),
            path.join(tempRoot, "repo-c")
        ];
        for (const codebasePath of codebasePaths) {
            await mkdir(codebasePath, { recursive: true });
        }

        const snapshotManager = new SnapshotManager();
        for (const codebasePath of codebasePaths) {
            snapshotManager.setCodebaseIndexed(codebasePath, {
                indexedFiles: 1,
                totalChunks: 1,
                status: "completed"
            });
        }
        snapshotManager.saveCodebaseSnapshot();

        let activeSyncs = 0;
        let maxActiveSyncs = 0;
        const context = {
            reindexByChange: async () => {
                activeSyncs += 1;
                maxActiveSyncs = Math.max(maxActiveSyncs, activeSyncs);
                await sleep(30);
                activeSyncs -= 1;
                return { added: 0, removed: 0, modified: 0 };
            }
        } as any;

        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex();

        assert.equal(maxActiveSyncs, 2);
    });
});

test("background sync limits codebase concurrency with embeddingConcurrency", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePaths = [
            path.join(tempRoot, "repo-a"),
            path.join(tempRoot, "repo-b"),
            path.join(tempRoot, "repo-c")
        ];
        for (const codebasePath of codebasePaths) {
            await mkdir(codebasePath, { recursive: true });
            await writeProjectConfig(codebasePath, { embeddingConcurrency: 2 });
        }

        const snapshotManager = new SnapshotManager();
        for (const codebasePath of codebasePaths) {
            snapshotManager.setCodebaseIndexed(codebasePath, {
                indexedFiles: 1,
                totalChunks: 1,
                status: "completed"
            });
        }
        snapshotManager.saveCodebaseSnapshot();

        let activeSyncs = 0;
        let maxActiveSyncs = 0;
        const context = {
            reindexByChange: async () => {
                activeSyncs += 1;
                maxActiveSyncs = Math.max(maxActiveSyncs, activeSyncs);
                await sleep(30);
                activeSyncs -= 1;
                return { added: 0, removed: 0, modified: 0 };
            }
        } as any;

        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex();

        assert.equal(maxActiveSyncs, 2);
    });
});

test("background sync reads concurrency from indexed codebase configs instead of cwd", async () => {
    await withTempHome(async (tempRoot) => {
        const launcherCwd = path.join(tempRoot, "launcher");
        const codebasePaths = [
            path.join(tempRoot, "repo-a"),
            path.join(tempRoot, "repo-b")
        ];
        await mkdir(launcherCwd, { recursive: true });
        for (const codebasePath of codebasePaths) {
            await mkdir(codebasePath, { recursive: true });
            await writeProjectConfig(codebasePath, { embeddingConcurrency: 1 });
        }
        process.chdir(launcherCwd);

        const snapshotManager = new SnapshotManager();
        for (const codebasePath of codebasePaths) {
            snapshotManager.setCodebaseIndexed(codebasePath, {
                indexedFiles: 1,
                totalChunks: 1,
                status: "completed"
            });
        }
        snapshotManager.saveCodebaseSnapshot();

        let activeSyncs = 0;
        let maxActiveSyncs = 0;
        const context = {
            reindexByChange: async () => {
                activeSyncs += 1;
                maxActiveSyncs = Math.max(maxActiveSyncs, activeSyncs);
                await sleep(30);
                activeSyncs -= 1;
                return { added: 0, removed: 0, modified: 0 };
            }
        } as any;

        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex();

        assert.equal(maxActiveSyncs, 1);
    });
});

test("large automatic incremental sync keeps the old index and records a warning", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        const context = {
            reindexByChange: async () => {
                throw new IncrementalIndexTooLargeError(5_001, 5_000, 1);
            }
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex();

        const info = snapshotManager.getCodebaseInfo(codebasePath);
        assert.equal(info?.status, "indexed");
        assert.equal(snapshotManager.getIndexedCodebases().includes(codebasePath), true);
        assert.match((info as any).syncWarning, /5001 effective lines/);
        assert.match((info as any).syncWarning, /\.hceignore/);
        assert.match((info as any).syncWarning, /index_codebase with incremental=true/);
    });
});

test("successful automatic sync clears previous large-increment warning", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.setCodebaseSyncWarning(codebasePath, "old warning");
        snapshotManager.saveCodebaseSnapshot();

        const context = {
            reindexByChange: async () => ({ added: 0, removed: 0, modified: 0 })
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex();

        const info = snapshotManager.getCodebaseInfo(codebasePath);
        assert.equal(info?.status, "indexed");
        assert.equal((info as any).syncWarning, undefined);
    });
});

test("automatic sync removes missing codebases from tracking", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        await rm(codebasePath, { recursive: true, force: true });

        let reindexCalls = 0;
        const context = {
            reindexByChange: async () => {
                reindexCalls += 1;
                return { added: 0, removed: 0, modified: 0 };
            }
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex();

        assert.equal(reindexCalls, 0);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "not_found");
        assert.deepEqual(snapshotManager.getIndexedCodebases(), []);
    });
});

test("successful automatic sync updates snapshot without querying full collection metadata", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 2,
            status: "completed"
        }, {
            requestSplitter: "langchain",
            requestIgnorePatterns: ["dist/**"]
        });
        snapshotManager.saveCodebaseSnapshot();

        const context = {
            reindexByChange: async () => ({ added: 1, removed: 1, modified: 0 }),
            getCollectionName: () => "code_chunks_repo",
            getVectorDatabase: () => ({
                query: async () => {
                    throw new Error("metadata query should not run after sync");
                }
            })
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex();

        const info = snapshotManager.getCodebaseInfo(codebasePath);
        assert.equal(info?.status, "indexed");
        assert.equal((info as any).indexedFiles, 1);
        assert.equal((info as any).totalChunks, 2);
        assert.equal((info as any).statsSource, undefined);
        assert.equal((info as any).requestSplitter, "langchain");
        assert.deepEqual((info as any).requestIgnorePatterns, ["dist/**"]);
    });
});

test("clean project watcher state skips full change scan before fallback interval", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        let reindexCalls = 0;
        const context = {
            reindexByChange: async () => {
                reindexCalls += 1;
                return { added: 0, removed: 0, modified: 0 };
            }
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);
        (syncManager as any).lastFullScanMs.set(codebasePath, Date.now());
        (syncManager as any).projectChangeTracker = {
            watch: () => undefined,
            getState: () => ({ kind: "clean" }),
            markClean: () => undefined,
            close: async () => undefined
        };

        await syncManager.handleSyncIndex();

        assert.equal(reindexCalls, 0);
    });
});

test("low-latency search sync queues due full scan for clean watcher state", async () => {
    await withTempHome(async (tempRoot) => {
        await writeProjectConfig(tempRoot, { projectWatcherDebounceMs: 0 });
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        let reindexCalls = 0;
        const context = {
            reindexByChange: async () => {
                reindexCalls += 1;
                return { added: 0, removed: 0, modified: 0 };
            }
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);
        (syncManager as any).projectChangeTracker = {
            watch: () => undefined,
            getState: () => ({ kind: "clean" }),
            markClean: () => undefined,
            close: async () => undefined
        };

        const stats = await syncManager.syncCodebaseForSearch(codebasePath, {
            consistencyMode: "low_latency"
        });

        assert.equal(reindexCalls, 0);
        assert.equal(stats.added, 0);
        assert.match(stats.warning ?? "", /without blocking on a due full-scan reconciliation/);
        await waitFor(() => reindexCalls === 1, 500);
        syncManager.stopBackgroundSync();
    });
});

test("dirty project watcher state syncs targeted paths without metadata statistics scan", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        }, {
            requestIgnorePatterns: ["dist/**"],
            requestCustomExtensions: [".vue"],
            requestIgnoreFiles: [".hceignore"],
            requestMaxDepth: 3
        });
        snapshotManager.saveCodebaseSnapshot();

        let targetedCalls = 0;
        let cleanedPaths: string[] = [];
        const context = {
            reindexChangedPaths: async (
                pathArg: string,
                paths: string[],
                _progress: unknown,
                ignorePatterns: string[],
                customExtensions: string[],
                _splitter: unknown,
                ignoreFiles: string[],
                maxDepth: number,
            ) => {
                targetedCalls += 1;
                assert.equal(pathArg, codebasePath);
                assert.deepEqual(paths, ["src/a.ts"]);
                assert.deepEqual(ignorePatterns, ["dist/**"]);
                assert.deepEqual(customExtensions, [".vue"]);
                assert.deepEqual(ignoreFiles, [".hceignore"]);
                assert.equal(maxDepth, 3);
                return { added: 0, removed: 0, modified: 1 };
            },
            reindexByChange: async () => {
                throw new Error("full scan should not run");
            },
            getCollectionName: () => "code_chunks_repo",
            getVectorDatabase: () => ({
                query: async () => {
                    throw new Error("metadata query should not run after targeted sync");
                }
            })
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);
        (syncManager as any).lastFullScanMs.set(codebasePath, Date.now());
        (syncManager as any).projectChangeTracker = {
            watch: () => undefined,
            getState: () => ({ kind: "dirty", paths: ["src/a.ts"] }),
            markPathsClean: (_codebasePath: string, paths: string[]) => {
                cleanedPaths = paths;
            },
            markClean: () => undefined,
            close: async () => undefined
        };

        await syncManager.handleSyncIndex();

        const info = snapshotManager.getCodebaseInfo(codebasePath);
        assert.equal(targetedCalls, 1);
        assert.deepEqual(cleanedPaths, ["src/a.ts"]);
        assert.equal((info as any).indexedFiles, 1);
        assert.equal((info as any).totalChunks, 1);
        assert.deepEqual((info as any).requestIgnorePatterns, ["dist/**"]);
    });
});

test("low-latency search sync uses dirty paths even when full scan is due", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        let targetedCalls = 0;
        let fullScanCalls = 0;
        const context = {
            reindexChangedPaths: async (
                pathArg: string,
                paths: string[],
            ) => {
                targetedCalls += 1;
                assert.equal(pathArg, codebasePath);
                assert.deepEqual(paths, ["src/a.ts"]);
                return { added: 0, removed: 0, modified: 1 };
            },
            reindexByChange: async () => {
                fullScanCalls += 1;
                return { added: 0, removed: 0, modified: 0 };
            },
            getCollectionName: () => "code_chunks_repo",
            getVectorDatabase: () => ({
                getCollectionRowCount: async () => 2,
                query: async () => [
                    { relativePath: "src/a.ts" },
                    { relativePath: "src/a.ts" }
                ]
            })
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);
        (syncManager as any).projectChangeTracker = {
            watch: () => undefined,
            getState: () => ({ kind: "dirty", paths: ["src/a.ts"], version: 1 }),
            markPathsClean: () => undefined,
            markClean: () => undefined,
            close: async () => undefined
        };

        const stats = await syncManager.syncCodebaseForSearch(codebasePath, {
            consistencyMode: "low_latency"
        });

        assert.equal(targetedCalls, 1);
        assert.equal(fullScanCalls, 0);
        assert.equal(stats.modified, 1);
        assert.match(stats.warning ?? "", /due full-scan reconciliation/);
        syncManager.stopBackgroundSync();
    });
});

test("project watcher sync prefers dirty paths and defers due full scan", async () => {
    await withTempHome(async (tempRoot) => {
        await writeProjectConfig(tempRoot, { projectWatcherDebounceMs: 0 });
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        let targetedCalls = 0;
        let fullScanCalls = 0;
        let dirty = true;
        const context = {
            reindexChangedPaths: async (
                pathArg: string,
                paths: string[],
            ) => {
                targetedCalls += 1;
                assert.equal(pathArg, codebasePath);
                assert.deepEqual(paths, ["src/a.ts"]);
                return { added: 0, removed: 0, modified: 1 };
            },
            reindexByChange: async () => {
                fullScanCalls += 1;
                return { added: 0, removed: 0, modified: 0 };
            },
            getCollectionName: () => "code_chunks_repo",
            getVectorDatabase: () => ({
                getCollectionRowCount: async () => 1,
                query: async () => [
                    { relativePath: "src/a.ts" }
                ]
            })
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);
        (syncManager as any).projectChangeTracker = {
            watch: () => undefined,
            getState: () => dirty
                ? ({ kind: "dirty", paths: ["src/a.ts"], version: 1 })
                : ({ kind: "clean", version: 1 }),
            markPathsClean: () => {
                dirty = false;
            },
            markClean: () => undefined,
            close: async () => undefined
        };

        await (syncManager as any).runProjectWatcherSync(codebasePath);

        assert.equal(targetedCalls, 1);
        assert.equal(fullScanCalls, 0);
        await waitFor(() => fullScanCalls === 1, 500);
        syncManager.stopBackgroundSync();
    });
});

test("project watcher keeps newer same-path events after cleaning an older sync snapshot", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const tracker = new ProjectChangeTracker({
            debounceMs: 1000,
            usePolling: false
        });

        tracker.watch(codebasePath);
        (tracker as any).recordFileEvent(codebasePath, path.join(codebasePath, "src", "a.ts"));
        const firstState = tracker.getState(codebasePath);
        assert.equal(firstState.kind, "dirty");
        assert.deepEqual(firstState.kind === "dirty" ? firstState.paths : [], ["src/a.ts"]);

        (tracker as any).recordFileEvent(codebasePath, path.join(codebasePath, "src", "a.ts"));
        tracker.markPathsClean(codebasePath, ["src/a.ts"], firstState.version);

        const secondState = tracker.getState(codebasePath);
        assert.equal(secondState.kind, "dirty");
        assert.deepEqual(secondState.kind === "dirty" ? secondState.paths : [], ["src/a.ts"]);

        await tracker.close();
    });
});

test("project watcher marks ignore file changes unknown so sync falls back to full scan", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const tracker = new ProjectChangeTracker({
            debounceMs: 1000,
            usePolling: false
        });

        tracker.watch(codebasePath);
        (tracker as any).recordFileEvent(codebasePath, path.join(codebasePath, ".hceignore"));

        const state = tracker.getState(codebasePath);
        assert.equal(state.kind, "unknown");
        assert.match(state.kind === "unknown" ? state.reason : "", /ignore file changed: \.hceignore/);

        await tracker.close();
    });
});

test("project watcher marks configured ignore file changes unknown", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const tracker = new ProjectChangeTracker({
            debounceMs: 1000,
            usePolling: false
        });

        tracker.watch(codebasePath, ["extra.ignore"]);
        (tracker as any).recordFileEvent(codebasePath, path.join(codebasePath, "extra.ignore"));

        const state = tracker.getState(codebasePath);
        assert.equal(state.kind, "unknown");
        assert.match(state.kind === "unknown" ? state.reason : "", /ignore file changed: extra\.ignore/);

        await tracker.close();
    });
});

test("project watcher preserves events observed during an unknown-state full scan", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const tracker = new ProjectChangeTracker({
            debounceMs: 1000,
            usePolling: false
        });

        tracker.watch(codebasePath);
        (tracker as any).recordFileEvent(codebasePath, path.join(codebasePath, ".gitignore"));
        const scanState = tracker.getState(codebasePath);
        assert.equal(scanState.kind, "unknown");

        (tracker as any).recordFileEvent(codebasePath, path.join(codebasePath, "src", "a.ts"));
        tracker.markClean(codebasePath, scanState.version);

        const state = tracker.getState(codebasePath);
        assert.equal(state.kind, "dirty");
        assert.deepEqual(state.kind === "dirty" ? state.paths : [], ["src/a.ts"]);

        await tracker.close();
    });
});

test("project watcher preserves newer unknown events observed during an unknown-state full scan", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const tracker = new ProjectChangeTracker({
            debounceMs: 1000,
            usePolling: false
        });

        tracker.watch(codebasePath);
        (tracker as any).recordDirectoryEvent(codebasePath, path.join(codebasePath, "src"), "directory added");
        const scanState = tracker.getState(codebasePath);
        assert.equal(scanState.kind, "unknown");

        (tracker as any).recordFileEvent(codebasePath, path.join(codebasePath, ".gitignore"));
        tracker.markClean(codebasePath, scanState.version);

        const state = tracker.getState(codebasePath);
        assert.equal(state.kind, "unknown");
        assert.match(state.kind === "unknown" ? state.reason : "", /ignore file changed: \.gitignore/);

        await tracker.close();
    });
});

test("project watcher debounces queued file events", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const tracker = new ProjectChangeTracker({
            debounceMs: 25,
            usePolling: false
        });

        tracker.watch(codebasePath);
        (tracker as any).queueFileEvent(codebasePath, path.join(codebasePath, "src", "a.ts"));
        assert.equal(tracker.getState(codebasePath).kind, "clean");

        await sleep(40);

        const state = tracker.getState(codebasePath);
        assert.equal(state.kind, "dirty");
        assert.deepEqual(state.kind === "dirty" ? state.paths : [], ["src/a.ts"]);

        await tracker.close();
    });
});

test("project watcher ignored directories can be customized", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const defaultTracker = new ProjectChangeTracker({
            debounceMs: 1000,
            usePolling: false
        });
        const customTracker = new ProjectChangeTracker({
            debounceMs: 1000,
            usePolling: false,
            ignoredDirectories: [".git", "node_modules"]
        });

        assert.equal(
            (defaultTracker as any).isWatcherIgnored(codebasePath, path.join(codebasePath, "dist", "bundle.js")),
            true,
        );
        assert.equal(
            (customTracker as any).isWatcherIgnored(codebasePath, path.join(codebasePath, "dist", "bundle.js")),
            false,
        );

        await defaultTracker.close();
        await customTracker.close();
    });
});

test("project watcher file events trigger sync without periodic background polling", async () => {
    await withTempHome(async (tempRoot) => {
        await writeProjectConfig(tempRoot, {
            backgroundSync: false,
            projectWatcherDebounceMs: 1
        });
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(path.join(codebasePath, "src"), { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        let targetedCalls = 0;
        const context = {
            reindexChangedPaths: async (
                pathArg: string,
                paths: string[],
            ) => {
                targetedCalls += 1;
                assert.equal(pathArg, codebasePath);
                assert.deepEqual(paths, ["src/a.ts"]);
                return { added: 0, removed: 0, modified: 0 };
            },
            reindexByChange: async () => {
                throw new Error("full scan should not run for a dirty file event");
            }
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);
        (syncManager as any).lastFullScanMs.set(codebasePath, Date.now());

        syncManager.startBackgroundSync();
        const tracker = (syncManager as any).projectChangeTracker as ProjectChangeTracker;
        (tracker as any).recordFileEvent(codebasePath, path.join(codebasePath, "src", "a.ts"));

        await waitFor(() => targetedCalls === 1, 500);
        syncManager.stopBackgroundSync();
    });
});

test("project watcher schedules a follow-up sync for events observed during an active sync", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(path.join(codebasePath, "src"), { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        let targetedCalls = 0;
        const context = {
            reindexChangedPaths: async () => {
                targetedCalls += 1;
                if (targetedCalls === 1) {
                    const tracker = (syncManager as any).projectChangeTracker as ProjectChangeTracker;
                    (tracker as any).recordFileEvent(codebasePath, path.join(codebasePath, "src", "a.ts"));
                    await sleep(20);
                }
                return { added: 0, removed: 0, modified: 0 };
            },
            reindexByChange: async () => {
                throw new Error("full scan should not run for dirty file events");
            }
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);
        (syncManager as any).lastFullScanMs.set(codebasePath, Date.now());

        syncManager.trackCodebase(codebasePath);
        const tracker = (syncManager as any).projectChangeTracker as ProjectChangeTracker;
        (tracker as any).recordFileEvent(codebasePath, path.join(codebasePath, "src", "a.ts"));

        await waitFor(() => targetedCalls >= 2, 500);
        await syncManager.stopProjectWatcher();
    });
});

test("global sync does not overlap an active project watcher sync in the same manager", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(path.join(codebasePath, "src"), { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        let activeSyncs = 0;
        let maxActiveSyncs = 0;
        let reindexCalls = 0;
        let releaseWatcherSync!: () => void;
        const watcherSyncGate = new Promise<void>((resolve) => {
            releaseWatcherSync = resolve;
        });

        const context = {
            reindexChangedPaths: async () => {
                activeSyncs += 1;
                maxActiveSyncs = Math.max(maxActiveSyncs, activeSyncs);
                reindexCalls += 1;
                try {
                    await watcherSyncGate;
                    return { added: 0, removed: 0, modified: 0 };
                } finally {
                    activeSyncs -= 1;
                }
            },
            reindexByChange: async () => {
                activeSyncs += 1;
                maxActiveSyncs = Math.max(maxActiveSyncs, activeSyncs);
                reindexCalls += 1;
                activeSyncs -= 1;
                return { added: 0, removed: 0, modified: 0 };
            }
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);
        (syncManager as any).lastFullScanMs.set(codebasePath, Date.now());
        let dirty = true;
        (syncManager as any).projectChangeTracker = {
            watch: () => undefined,
            getState: () => dirty
                ? ({ kind: "dirty", paths: ["src/a.ts"], version: 1 })
                : ({ kind: "clean", version: 1 }),
            markPathsClean: () => {
                dirty = false;
            },
            markClean: () => undefined,
            unwatch: () => undefined,
            close: async () => undefined
        };

        const watcherSyncPromise = (syncManager as any).runProjectWatcherSync(codebasePath);
        await waitFor(() => activeSyncs === 1, 500);

        await syncManager.handleSyncIndex();
        assert.equal(reindexCalls, 1);
        assert.equal(maxActiveSyncs, 1);

        releaseWatcherSync();
        await watcherSyncPromise;
        await syncManager.stopProjectWatcher();
    });
});

test("project watcher requests queue behind active collection sync without tight timer rescheduling", async () => {
    await withTempHome(async (tempRoot) => {
        await writeProjectConfig(tempRoot, { projectWatcherDebounceMs: 0 });
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        let fullScanCalls = 0;
        let releaseCollectionSync!: () => void;
        const collectionSyncGate = new Promise<void>((resolve) => {
            releaseCollectionSync = resolve;
        });
        const context = {
            reindexByChange: async () => {
                fullScanCalls += 1;
                if (fullScanCalls === 1) {
                    await collectionSyncGate;
                }
                return { added: 0, removed: 0, modified: 0 };
            }
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);
        (syncManager as any).projectChangeTracker = {
            watch: () => undefined,
            getState: () => ({ kind: "clean", version: 1 }),
            markClean: () => undefined,
            close: async () => undefined
        };

        const collectionSyncPromise = syncManager.handleSyncIndex();
        await waitFor(() => fullScanCalls === 1, 500);

        await (syncManager as any).runProjectWatcherSync(codebasePath, { forceFullScan: true });
        await (syncManager as any).runProjectWatcherSync(codebasePath, { forceFullScan: true });

        assert.equal((syncManager as any).projectWatcherFullScanQueued.size, 1);
        assert.equal((syncManager as any).projectWatcherFullScanTimers.size, 0);
        assert.equal(fullScanCalls, 1);

        releaseCollectionSync();
        await collectionSyncPromise;
        await waitFor(() => fullScanCalls === 2, 500);
        syncManager.stopBackgroundSync();
    });
});

test("unknown project watcher state falls back to full change scan", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        let fullScanCalls = 0;
        const context = {
            reindexByChange: async () => {
                fullScanCalls += 1;
                return { added: 0, removed: 0, modified: 0 };
            }
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);
        (syncManager as any).lastFullScanMs.set(codebasePath, Date.now());
        (syncManager as any).projectChangeTracker = {
            watch: () => undefined,
            getState: () => ({ kind: "unknown", reason: "watcher error" }),
            markClean: () => undefined,
            close: async () => undefined
        };

        await syncManager.handleSyncIndex();

        assert.equal(fullScanCalls, 1);
    });
});

test("projectWatcher=false keeps full change scan behavior", async () => {
    await withTempHome(async (tempRoot) => {
        await writeProjectConfig(tempRoot, { projectWatcher: false });
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        let fullScanCalls = 0;
        const context = {
            reindexByChange: async () => {
                fullScanCalls += 1;
                return { added: 0, removed: 0, modified: 0 };
            }
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex();

        assert.equal(fullScanCalls, 1);
        assert.equal((syncManager as any).projectChangeTracker, null);
    });
});

test("stopBackgroundSync closes project and trigger watchers", async () => {
    await withTempHome(async () => {
        const snapshotManager = new SnapshotManager();
        const syncManager = new SyncManager({} as any, snapshotManager);
        let projectClosed = false;
        let triggerClosed = false;
        (syncManager as any).projectChangeTracker = {
            close: async () => {
                projectClosed = true;
            }
        };
        (syncManager as any).triggerWatcher = {
            close: () => {
                triggerClosed = true;
            }
        };

        syncManager.stopBackgroundSync();
        await waitFor(() => projectClosed, 100);

        assert.equal(projectClosed, true);
        assert.equal(triggerClosed, true);
        assert.equal((syncManager as any).triggerWatcher, null);
        assert.equal((syncManager as any).projectChangeTracker, null);
    });
});

test("separate MCP sync managers do not run the same sync concurrently", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const initialSnapshotManager = new SnapshotManager();
        initialSnapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        initialSnapshotManager.saveCodebaseSnapshot();

        const firstSnapshotManager = new SnapshotManager();
        firstSnapshotManager.loadCodebaseSnapshot();
        const secondSnapshotManager = new SnapshotManager();
        secondSnapshotManager.loadCodebaseSnapshot();

        let activeSyncs = 0;
        let maxActiveSyncs = 0;
        let reindexCalls = 0;

        const context = {
            reindexByChange: async () => {
                activeSyncs += 1;
                maxActiveSyncs = Math.max(maxActiveSyncs, activeSyncs);
                reindexCalls += 1;
                await new Promise((resolve) => setTimeout(resolve, 35));
                activeSyncs -= 1;
                return { added: 0, removed: 0, modified: 0 };
            }
        } as any;

        const firstSyncManager = new SyncManager(context, firstSnapshotManager);
        const secondSyncManager = new SyncManager(context, secondSnapshotManager);

        await Promise.all([
            firstSyncManager.handleSyncIndex(),
            secondSyncManager.handleSyncIndex()
        ]);

        assert.equal(maxActiveSyncs, 1);
        assert.equal(reindexCalls, 1);
    });
});

test("active collection sync lock heartbeat prevents stale reclaim by another manager", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });
        await writeProjectConfig(tempRoot, { syncLockStaleMs: 20 });

        const initialSnapshotManager = new SnapshotManager();
        initialSnapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        initialSnapshotManager.saveCodebaseSnapshot();

        const firstSnapshotManager = new SnapshotManager();
        firstSnapshotManager.loadCodebaseSnapshot();
        const secondSnapshotManager = new SnapshotManager();
        secondSnapshotManager.loadCodebaseSnapshot();

        let activeSyncs = 0;
        let maxActiveSyncs = 0;
        let reindexCalls = 0;
        let releaseFirstSync!: () => void;
        const firstSyncGate = new Promise<void>((resolve) => {
            releaseFirstSync = resolve;
        });

        const context = {
            reindexByChange: async () => {
                activeSyncs += 1;
                maxActiveSyncs = Math.max(maxActiveSyncs, activeSyncs);
                reindexCalls += 1;
                try {
                    await firstSyncGate;
                    return { added: 0, removed: 0, modified: 0 };
                } finally {
                    activeSyncs -= 1;
                }
            }
        } as any;

        const firstSyncManager = new SyncManager(context, firstSnapshotManager);
        const secondSyncManager = new SyncManager(context, secondSnapshotManager);

        const firstSyncPromise = firstSyncManager.handleSyncIndex();
        await waitFor(() => activeSyncs === 1, 500);
        await sleep(60);

        await secondSyncManager.handleSyncIndex();
        assert.equal(reindexCalls, 1);
        assert.equal(maxActiveSyncs, 1);

        releaseFirstSync();
        await firstSyncPromise;
    });
});
