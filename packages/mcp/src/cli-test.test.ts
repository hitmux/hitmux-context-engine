import assert from "node:assert/strict";
import test from "node:test";

import {
    Embedding,
    EmbeddingVector,
    VectorDatabase,
} from "@hitmux/hitmux-context-engine-core";
import {
    parseCliTestTargets,
    runCliTestCommand,
} from "./cli-test.js";
import { ContextMcpConfig } from "./config.js";

class FakeEmbedding extends Embedding {
    protected maxTokens = 100;

    async detectDimension(): Promise<number> {
        return 3;
    }

    async embed(): Promise<EmbeddingVector> {
        return { vector: [1, 2, 3], dimension: 3 };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map(() => ({ vector: [1, 2, 3], dimension: 3 }));
    }

    getDimension(): number {
        return 3;
    }

    getProvider(): string {
        return "Fake";
    }

    getModel(): string {
        return "fake-model";
    }
}

const fakeConfig: ContextMcpConfig = {
    name: "test",
    version: "1.0.0",
    embeddingProvider: "OpenAI",
    embeddingModel: "text-embedding-3-small",
    openaiApiKey: "test-key",
    embeddingUseSystemProxy: false,
    milvusAddress: "localhost:19530",
    databaseUseSystemProxy: false,
};

function createFakeVectorDatabase(collections: string[]): VectorDatabase {
    return {
        createCollection: async () => undefined,
        createHybridCollection: async () => undefined,
        ensureHybridCollectionReady: async () => undefined,
        dropCollection: async () => undefined,
        hasCollection: async () => false,
        listCollections: async () => collections,
        insert: async () => undefined,
        insertHybrid: async () => undefined,
        search: async () => [],
        hybridSearch: async () => [],
        delete: async () => undefined,
        query: async () => [],
        getCollectionDescription: async () => "",
        checkCollectionLimit: async () => true,
        getCollectionRowCount: async () => 0,
    };
}

test("parseCliTestTargets defaults to embedding and vectordb", () => {
    assert.deepEqual(parseCliTestTargets([]), ["embedding", "vectordb"]);
    assert.deepEqual(parseCliTestTargets(["embedding"]), ["embedding"]);
    assert.deepEqual(parseCliTestTargets(["vectordb"]), ["vectordb"]);
    assert.throws(() => parseCliTestTargets(["unknown"]), /Usage: hce test/);
});

test("runCliTestCommand runs both tests by default", async () => {
    const output: string[] = [];
    const exitCode = await runCliTestCommand([], {
        createConfig: () => fakeConfig,
        createEmbedding: () => new FakeEmbedding(),
        createVectorDatabase: () => createFakeVectorDatabase(["a", "b"]),
        stdout: (message) => output.push(message),
    });

    assert.equal(exitCode, 0);
    assert.match(output.join(""), /\[PASS\] embedding: dimension=3/);
    assert.match(output.join(""), /\[PASS\] vectordb: collections=2/);
});

test("runCliTestCommand can run one target", async () => {
    const output: string[] = [];
    const exitCode = await runCliTestCommand(["embedding"], {
        createConfig: () => fakeConfig,
        createEmbedding: () => new FakeEmbedding(),
        createVectorDatabase: () => {
            throw new Error("should not run vectordb");
        },
        stdout: (message) => output.push(message),
    });

    assert.equal(exitCode, 0);
    assert.match(output.join(""), /\[PASS\] embedding/);
    assert.doesNotMatch(output.join(""), /vectordb/);
});

test("runCliTestCommand returns usage error for invalid targets", async () => {
    const errors: string[] = [];
    const exitCode = await runCliTestCommand(["embedding", "vectordb"], {
        stderr: (message) => errors.push(message),
    });

    assert.equal(exitCode, 2);
    assert.match(errors.join(""), /Usage: hce test/);
});
