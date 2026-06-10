import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
