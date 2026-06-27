import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IndexingJobStateManager } from "./indexing-job-state.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hitmux-context-engine-mcp-jobs-"));
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

test("indexing job state tracks progress and final stats outside global snapshot", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        const manager = new IndexingJobStateManager();
        const jobId = manager.createJobId(codebasePath);

        await manager.createRunningJob({
            jobId,
            codebasePath,
            collectionName: "collection_repo",
            splitterType: "ast",
        });
        await manager.updateWorkerThreadId(jobId, 7);
        await manager.updateProgress(jobId, {
            phase: "Processing files...",
            current: 4,
            total: 10,
            percentage: 40,
        });
        await manager.markCompleted(jobId, {
            indexedFiles: 3,
            totalChunks: 9,
            status: "completed",
        });

        const job = manager.findLatestForCodebase(codebasePath);
        assert.equal(job?.jobId, jobId);
        assert.equal(job?.workerThreadId, 7);
        assert.equal(job?.status, "completed");
        assert.deepEqual(job?.stats, {
            indexedFiles: 3,
            totalChunks: 9,
            status: "completed",
        });
        assert.equal(job?.progress.percentage, 100);
    });
});
