import assert from "node:assert/strict";
import test from "node:test";

import { runCollectionReaperCommand } from "./collection-reaper.js";
import type { ContextMcpConfig } from "./config.js";

const config: ContextMcpConfig = {
    name: "test",
    version: "1.0.0",
    embeddingProvider: "OpenAI",
    embeddingModel: "text-embedding-3-small",
    embeddingUseSystemProxy: false,
    databaseUseSystemProxy: false,
    collectionLeaseHeartbeatMs: 1,
};

test("collection reaper loops until shutdown and closes its database", async () => {
    const controller = new AbortController();
    let closed = false;
    const output: string[] = [];
    const database = {
        reapExpiredCollectionLeases: async () => {
            controller.abort();
            return { releasedCollections: ["code_chunks"], deletedLeaseRecords: 1 };
        },
        close: async () => {
            closed = true;
        },
    };

    const exitCode = await runCollectionReaperCommand([], {
        createConfig: () => config,
        signal: controller.signal,
        stdout: (message) => output.push(message),
        createVectorDatabase: () => database as any,
    });

    assert.equal(exitCode, 0);
    assert.equal(closed, true);
    assert.match(output.join(""), /Released expired collection lease: code_chunks/);
});

test("collection reaper rejects arguments without starting a database", async () => {
    const errors: string[] = [];
    const exitCode = await runCollectionReaperCommand(["--once"], {
        createConfig: () => config,
        stderr: (message) => errors.push(message),
    });

    assert.equal(exitCode, 2);
    assert.match(errors.join(""), /Usage: hce collection-reaper/);
});
