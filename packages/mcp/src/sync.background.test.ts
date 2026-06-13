import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IncrementalIndexTooLargeError } from "@hitmux/hitmux-context-engine-core";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";

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
    await writeFile(path.join(configDir, "config.jsonc"), JSON.stringify(config), "utf-8");
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

test("background sync schedules the next periodic run only after the current run finishes", async () => {
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
                throw new IncrementalIndexTooLargeError(10_001, 10_000, 1);
            }
        } as any;
        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex();

        const info = snapshotManager.getCodebaseInfo(codebasePath);
        assert.equal(info?.status, "indexed");
        assert.equal(snapshotManager.getIndexedCodebases().includes(codebasePath), true);
        assert.match((info as any).syncWarning, /10001 effective lines/);
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
