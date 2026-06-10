import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SnapshotManager } from "./snapshot.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hitmux-context-engine-mcp-snapshot-concurrent-"));
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

test("separate MCP snapshot managers preserve each other's indexed entries", async () => {
    await withTempHome(async (tempRoot) => {
        const firstCodebase = path.join(tempRoot, "repo-a");
        const secondCodebase = path.join(tempRoot, "repo-b");
        await mkdir(firstCodebase, { recursive: true });
        await mkdir(secondCodebase, { recursive: true });

        const firstManager = new SnapshotManager();
        const secondManager = new SnapshotManager();

        firstManager.setCodebaseIndexed(firstCodebase, {
            indexedFiles: 1,
            totalChunks: 2,
            status: "completed"
        });
        secondManager.setCodebaseIndexed(secondCodebase, {
            indexedFiles: 3,
            totalChunks: 4,
            status: "completed"
        });

        firstManager.saveCodebaseSnapshot();
        secondManager.saveCodebaseSnapshot();

        const reloadedManager = new SnapshotManager();
        reloadedManager.loadCodebaseSnapshot();

        assert.deepEqual(new Set(reloadedManager.getIndexedCodebases()), new Set([firstCodebase, secondCodebase]));
        assert.equal(reloadedManager.getCodebaseInfo(firstCodebase)?.status, "indexed");
        assert.equal(reloadedManager.getCodebaseInfo(secondCodebase)?.status, "indexed");
    });
});
