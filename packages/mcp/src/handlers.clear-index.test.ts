import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hitmux-context-engine-mcp-clear-"));
    const homeDir = path.join(tempRoot, "home");
    await mkdir(homeDir, { recursive: true });

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

function createContextStub(options: { hasIndex?: boolean } = {}) {
    const clearedPaths: string[] = [];
    let hasIndexCalls = 0;

    return {
        context: {
            hasIndex: async () => {
                hasIndexCalls += 1;
                return options.hasIndex ?? false;
            },
            clearIndex: async (codebasePath: string) => {
                clearedPaths.push(codebasePath);
            }
        } as any,
        clearedPaths,
        getHasIndexCalls: () => hasIndexCalls
    };
}

test("clear_index clears snapshot-known codebase after the local directory is deleted", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 2,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        await rm(codebasePath, { recursive: true, force: true });

        const contextStub = createContextStub();
        const handlers = new ToolHandlers(contextStub.context, snapshotManager);

        const result = await handlers.handleClearIndex({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Successfully cleared codebase/);
        assert.deepEqual(contextStub.clearedPaths, [codebasePath]);
        assert.equal(contextStub.getHasIndexCalls(), 0);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "not_found");
    });
});

test("clear_index clears collection-known codebase after snapshot state is missing", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        const snapshotManager = new SnapshotManager();
        const contextStub = createContextStub({ hasIndex: true });
        const handlers = new ToolHandlers(contextStub.context, snapshotManager);

        const result = await handlers.handleClearIndex({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Successfully cleared codebase/);
        assert.deepEqual(contextStub.clearedPaths, [codebasePath]);
        assert.equal(contextStub.getHasIndexCalls(), 1);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "not_found");
    });
});
