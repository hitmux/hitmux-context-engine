import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
    startIndexingWorkerJob,
    type IndexingWorkerRequest,
} from "./indexing-worker-runner.js";

class FakeWorker extends EventEmitter {
    terminated = 0;
    messages: unknown[] = [];

    postMessage(message: unknown): void {
        this.messages.push(message);
    }

    async terminate(): Promise<number> {
        this.terminated++;
        return 0;
    }
}

function createRequest(): IndexingWorkerRequest {
    return {
        jobId: "index_test",
        codebasePath: "/tmp/repo",
        splitterType: "ast",
        customIgnorePatterns: [],
        customFileExtensions: [],
        customIgnoreFiles: [],
    };
}

test("indexing worker runner terminates worker after completed message", async () => {
    const worker = new FakeWorker();
    const promise = startIndexingWorkerJob(
        createRequest(),
        new AbortController().signal,
        {},
        {
            createWorker: () => worker,
        },
    );

    worker.emit("message", {
        type: "completed",
        stats: {
            indexedFiles: 1,
            totalChunks: 2,
            status: "completed",
        },
    });

    await assert.doesNotReject(promise);
    assert.equal(worker.terminated, 1);
});

test("indexing worker runner force-terminates a cancelled worker that does not reply", async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const promise = startIndexingWorkerJob(
        createRequest(),
        controller.signal,
        {},
        {
            createWorker: () => worker,
            forceTerminateMs: 1,
        },
    );

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    worker.emit("exit", 1);

    await assert.rejects(promise, /cancelled/i);
    assert.deepEqual(worker.messages, [{ type: "cancel" }]);
    assert.equal(worker.terminated, 1);
});
