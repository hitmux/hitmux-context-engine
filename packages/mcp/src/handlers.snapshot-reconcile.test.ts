import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hitmux-context-engine-mcp-reconcile-"));
    const homeDir = path.join(tempRoot, "home");

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    try {
        await run(tempRoot);
    } finally {
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

async function writeLegacyZeroSnapshot(homeDir: string, codebasePath: string): Promise<void> {
    const snapshotDir = path.join(homeDir, ".hitmux-context-engine");
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(path.join(snapshotDir, "mcp-codebase-snapshot.json"), JSON.stringify({
        formatVersion: "v2",
        codebases: {
            [codebasePath]: {
                status: "indexed",
                indexedFiles: 0,
                totalChunks: 0,
                indexStatus: "completed",
                lastUpdated: new Date().toISOString()
            }
        },
        lastUpdated: new Date().toISOString()
    }, null, 2), "utf-8");
}

test("startup reconciliation removes indexed snapshot entries whose collection is missing", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 2,
            totalChunks: 4,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        const vectorDb = {
            hasCollection: async () => false
        };
        const context = {
            getCollectionName: () => "missing_collection",
            getVectorDatabase: () => vectorDb
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager);

        await handlers.validateIndexedCollections();

        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "not_found");
        assert.deepEqual(snapshotManager.getIndexedCodebases(), []);
    });
});

test("startup reconciliation can validate only the requested indexed codebase", async () => {
    await withTempHome(async (tempRoot) => {
        const requestedCodebasePath = path.join(tempRoot, "repo-a");
        const unrelatedCodebasePath = path.join(tempRoot, "repo-b");
        await mkdir(requestedCodebasePath, { recursive: true });
        await mkdir(unrelatedCodebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(requestedCodebasePath, {
            indexedFiles: 2,
            totalChunks: 4,
            status: "completed"
        });
        snapshotManager.setCodebaseIndexed(unrelatedCodebasePath, {
            indexedFiles: 3,
            totalChunks: 5,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        const checkedCollections: string[] = [];
        const context = {
            getCollectionName: (codebasePath: string) => codebasePath === requestedCodebasePath
                ? "requested_collection"
                : "unrelated_collection",
            getVectorDatabase: () => ({
                hasCollection: async (collectionName: string) => {
                    checkedCollections.push(collectionName);
                    return true;
                }
            })
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager);

        await handlers.validateIndexedCollections(requestedCodebasePath);

        assert.deepEqual(checkedCollections, ["requested_collection"]);
        assert.equal(snapshotManager.getCodebaseStatus(requestedCodebasePath), "indexed");
        assert.equal(snapshotManager.getCodebaseStatus(unrelatedCodebasePath), "indexed");
    });
});

test("startup reconciliation times out stalled collection probes without deleting snapshot entries", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 2,
            totalChunks: 4,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        const vectorDb = {
            hasCollection: async () => new Promise<boolean>(() => undefined)
        };
        const context = {
            getCollectionName: () => "stalled_collection",
            getVectorDatabase: () => vectorDb
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager);
        (handlers as any).vectorDatabaseSyncTimeoutMs = 5;

        await handlers.validateIndexedCollections();

        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexed");
        assert.deepEqual(snapshotManager.getIndexedCodebases(), [codebasePath]);
    });
});

test("legacy zero-entry validation times out stalled row counts without deleting snapshot entries", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        const homeDir = path.join(tempRoot, "home");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        await writeLegacyZeroSnapshot(homeDir, codebasePath);
        snapshotManager.loadCodebaseSnapshot();

        const vectorDb = {
            hasCollection: async () => true,
            getCollectionRowCount: async () => new Promise<number>(() => undefined)
        };
        const context = {
            getCollectionName: () => "legacy_zero_collection",
            getVectorDatabase: () => vectorDb
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager);
        (handlers as any).vectorDatabaseSyncTimeoutMs = 5;

        await handlers.validateLegacyZeroEntries();

        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexed");
        assert.deepEqual(snapshotManager.getIndexedCodebases(), [codebasePath]);
    });
});
