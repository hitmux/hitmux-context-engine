import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hitmux-context-engine-mcp-index-"));
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

test("parallel index_codebase calls for the same path start only one background job", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        const vectorDb = {
            checkCollectionLimit: async () => true
        };
        const context = {
            hasIndex: async () => false,
            clearIndex: async () => undefined,
            getVectorDatabase: () => vectorDb
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager);

        let backgroundStarts = 0;
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
        (handlers as any).startBackgroundIndexing = async () => {
            backgroundStarts += 1;
            await new Promise((resolve) => setTimeout(resolve, 25));
        };

        const [first, second] = await Promise.all([
            handlers.handleIndexCodebase({ path: codebasePath }),
            handlers.handleIndexCodebase({ path: codebasePath })
        ]);

        assert.equal(backgroundStarts, 1);
        assert.equal(first.isError, undefined);
        assert.equal(second.isError, true);
        assert.match(second.content[0].text, /already indexing, clearing, or syncing/);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexing");
    });
});

test("forced index_codebase clears existing collection state even when hasIndex is false", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        const vectorDb = {
            checkCollectionLimit: async () => true
        };
        let clearCalls = 0;
        const context = {
            hasIndex: async () => false,
            clearIndex: async (targetPath: string) => {
                assert.equal(targetPath, codebasePath);
                clearCalls += 1;
            },
            getVectorDatabase: () => vectorDb
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager);

        let backgroundStarts = 0;
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
        (handlers as any).startBackgroundIndexing = async () => {
            backgroundStarts += 1;
        };

        const result = await handlers.handleIndexCodebase({ path: codebasePath, force: true });

        assert.equal(result.isError, undefined);
        assert.equal(clearCalls, 1);
        assert.equal(backgroundStarts, 1);
    });
});

test("parallel forced index_codebase calls do not replace an active background job", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        const vectorDb = {
            checkCollectionLimit: async () => true
        };
        const context = {
            hasIndex: async () => false,
            clearIndex: async () => undefined,
            getVectorDatabase: () => vectorDb
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager);

        let backgroundStarts = 0;
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
        (handlers as any).startBackgroundIndexing = async () => {
            backgroundStarts += 1;
            await new Promise((resolve) => setTimeout(resolve, 25));
        };

        const [first, second] = await Promise.all([
            handlers.handleIndexCodebase({ path: codebasePath, force: true }),
            handlers.handleIndexCodebase({ path: codebasePath, force: true })
        ]);

        assert.equal(backgroundStarts, 1);
        assert.equal(first.isError, undefined);
        assert.equal(second.isError, true);
        assert.match(second.content[0].text, /already indexing, clearing, or syncing/);
    });
});
