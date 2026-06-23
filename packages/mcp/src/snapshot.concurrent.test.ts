import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("snapshot save skips writing when the lock cannot be acquired", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotDir = path.join(tempRoot, "home", ".hitmux-context-engine");
        const snapshotPath = path.join(snapshotDir, "mcp-codebase-snapshot.json");
        await mkdir(snapshotDir, { recursive: true });
        await writeFile(snapshotPath, JSON.stringify({
            formatVersion: "v2",
            codebases: {},
            lastUpdated: "2026-01-01T00:00:00.000Z"
        }), "utf8");
        await mkdir(`${snapshotPath}.lock`);

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 2,
            status: "completed"
        });

        const saved = snapshotManager.saveCodebaseSnapshot();
        const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));

        assert.equal(saved, false);
        assert.deepEqual(snapshot.codebases, {});
    });
});

test("async snapshot save waits for a short lock without blocking timers", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotDir = path.join(tempRoot, "home", ".hitmux-context-engine");
        const snapshotPath = path.join(snapshotDir, "mcp-codebase-snapshot.json");
        const lockPath = `${snapshotPath}.lock`;
        await mkdir(lockPath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 2,
            status: "completed"
        });

        let timerFired = false;
        setTimeout(async () => {
            timerFired = true;
            await rm(lockPath, { recursive: true, force: true });
        }, 25);

        const saved = await snapshotManager.saveCodebaseSnapshotAsync();
        const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));

        assert.equal(timerFired, true);
        assert.equal(saved, true);
        assert.equal(snapshot.codebases[codebasePath].status, "indexed");
    });
});

test("snapshot tombstones prevent stale managers from restoring cleared codebases", async () => {
    await withTempHome(async (tempRoot) => {
        const firstCodebase = path.join(tempRoot, "repo-a");
        const secondCodebase = path.join(tempRoot, "repo-b");
        await mkdir(firstCodebase, { recursive: true });
        await mkdir(secondCodebase, { recursive: true });

        const staleManager = new SnapshotManager();
        staleManager.setCodebaseIndexed(firstCodebase, {
            indexedFiles: 1,
            totalChunks: 2,
            status: "completed"
        });
        assert.equal(staleManager.saveCodebaseSnapshot(), true);

        const clearingManager = new SnapshotManager();
        clearingManager.loadCodebaseSnapshot();
        clearingManager.removeCodebaseCompletely(firstCodebase);
        assert.equal(await clearingManager.saveCodebaseSnapshotAsync(), true);

        staleManager.setCodebaseIndexed(secondCodebase, {
            indexedFiles: 3,
            totalChunks: 4,
            status: "completed"
        });
        assert.equal(await staleManager.saveCodebaseSnapshotAsync(), true);

        const reloadedManager = new SnapshotManager();
        reloadedManager.loadCodebaseSnapshot();

        assert.equal(reloadedManager.getCodebaseInfo(firstCodebase), undefined);
        assert.equal(reloadedManager.getCodebaseInfo(secondCodebase)?.status, "indexed");
    });
});
