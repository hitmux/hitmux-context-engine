import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    Context,
    Embedding,
    EmbeddingVector,
    REMOTE_INDEX_MANIFEST_COLLECTION,
    VectorDatabase,
} from "@hitmux/hitmux-context-engine-core";

import {
    parseCliManageCommand,
    runCliManageCommand,
} from "./cli-manage.js";
import { ContextMcpConfig } from "./config.js";
import { SnapshotManager } from "./snapshot.js";
import { McpWriterLock } from "./sync-lock.js";

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

function createFakeVectorDatabase(
    collections: Record<
        string,
        {
            description?: string;
            rowCount?: number;
            queryRows?: Record<string, unknown>[];
        }
    >,
): VectorDatabase & { dropped: string[] } {
    const dropped: string[] = [];
    return {
        dropped,
        createCollection: async () => undefined,
        createHybridCollection: async () => undefined,
        ensureHybridCollectionReady: async () => undefined,
        dropCollection: async (collectionName: string) => {
            dropped.push(collectionName);
        },
        hasCollection: async (collectionName: string) => collectionName in collections,
        listCollections: async () => Object.keys(collections),
        insert: async () => undefined,
        insertHybrid: async () => undefined,
        search: async () => [],
        hybridSearch: async () => [],
        delete: async () => undefined,
        query: async (collectionName: string) =>
            collections[collectionName]?.queryRows ?? [],
        getCollectionDescription: async (collectionName: string) =>
            collections[collectionName]?.description ?? "",
        checkCollectionLimit: async () => true,
        getCollectionRowCount: async (collectionName: string) =>
            collections[collectionName]?.rowCount ?? -1,
    };
}

class FakeContext {
    reindexCalls: unknown[][] = [];

    constructor(
        private readonly vectorDatabase?: VectorDatabase,
        private readonly collectionName = "hybrid_code_chunks_app",
    ) {}

    getCollectionName(): string {
        return this.collectionName;
    }

    getVectorDatabase(): VectorDatabase {
        if (!this.vectorDatabase) {
            throw new Error("Fake vector database is not configured");
        }
        return this.vectorDatabase;
    }

    async hasIndex(): Promise<boolean> {
        return true;
    }

    async reindexByChange(
        ...args: unknown[]
    ): Promise<{ added: number; removed: number; modified: number }> {
        this.reindexCalls.push(args);
        return { added: 1, removed: 2, modified: 3 };
    }
}

class FakeSnapshotManager {
    removed: string[] = [];
    saved = 0;
    codebaseInfo: ReturnType<SnapshotManager["getCodebaseInfo"]>;
    indexed: Array<{
        codebasePath: string;
        stats: {
            indexedFiles: number;
            totalChunks: number;
            status: "completed" | "limit_reached";
            statsSource?: string;
        };
        indexOptions?: unknown;
    }> = [];

    loadCodebaseSnapshot(): void {}

    getIndexedCodebases(): string[] {
        return [];
    }

    getCodebaseInfo(): ReturnType<SnapshotManager["getCodebaseInfo"]> {
        return this.codebaseInfo;
    }

    setCodebaseIndexed(
        codebasePath: string,
        stats: {
            indexedFiles: number;
            totalChunks: number;
            status: "completed" | "limit_reached";
            statsSource?: string;
        },
        indexOptions?: unknown,
    ): void {
        this.indexed.push({ codebasePath, stats, indexOptions });
    }

    removeCodebaseCompletely(codebasePath: string): void {
        this.removed.push(codebasePath);
    }

    saveCodebaseSnapshot(): boolean {
        this.saved++;
        return true;
    }

    async saveCodebaseSnapshotAsync(): Promise<boolean> {
        this.saved++;
        return true;
    }
}

function createFakeLock(): McpWriterLock {
    return {
        startHeartbeat: () => undefined,
        release: () => undefined,
    } as unknown as McpWriterLock;
}

test("parseCliManageCommand parses list, rm, index, and index --all", () => {
    assert.deepEqual(parseCliManageCommand(["list"]), {
        action: "list",
        target: undefined,
    });
    assert.deepEqual(parseCliManageCommand(["list", "abc"]), {
        action: "list",
        target: "abc",
    });
    assert.deepEqual(parseCliManageCommand(["rm", "abc"]), {
        action: "rm",
        target: "abc",
    });
    assert.deepEqual(parseCliManageCommand(["index"]), {
        action: "index",
        all: false,
        target: undefined,
    });
    assert.deepEqual(parseCliManageCommand(["index", "--all"]), {
        action: "index",
        all: true,
        target: undefined,
    });
    assert.throws(() => parseCliManageCommand(["rm"]), /Usage: hce rm/);
});

test("runCliManageCommand list prints collection repo path and chunk count", async () => {
    const output: string[] = [];
    const vectorDatabase = createFakeVectorDatabase({
        hybrid_code_chunks_app: {
            description:
                'codebasePath:/repo/app\nhitmuxContext:{"version":1,"codebasePath":"/repo/app","embedding":{"provider":"OpenAI","model":"text-embedding-3-small","dimension":1536},"schemaVersion":2,"metadataVersion":2,"splitterType":"ast","createdAt":"2026-06-18T00:00:00.000Z"}',
            rowCount: 42,
        },
    });

    const exitCode = await runCliManageCommand(["list"], {
        createConfig: () => fakeConfig,
        createEmbedding: () => new FakeEmbedding(),
        createVectorDatabase: () => vectorDatabase,
        createContext: () => new FakeContext() as unknown as Context,
        createSnapshotManager: () => new FakeSnapshotManager() as unknown as SnapshotManager,
        stdout: (message) => output.push(message),
    });

    assert.equal(exitCode, 0);
    assert.match(output.join(""), /hybrid_code_chunks_app/);
    assert.match(output.join(""), /\/repo\/app/);
    assert.match(output.join(""), /42/);
});

test("runCliManageCommand list target prints collection details", async () => {
    const output: string[] = [];
    const vectorDatabase = createFakeVectorDatabase({
        hybrid_code_chunks_app: {
            description:
                'codebasePath:/repo/app\nhitmuxContext:{"version":1,"codebasePath":"/repo/app","embedding":{"provider":"OpenAI","model":"text-embedding-3-small","dimension":1536},"schemaVersion":2,"metadataVersion":2,"splitterType":"ast","createdAt":"2026-06-18T00:00:00.000Z"}',
            rowCount: 42,
        },
    });

    const exitCode = await runCliManageCommand(["list", "hybrid_code_chunks_app"], {
        createConfig: () => fakeConfig,
        createEmbedding: () => new FakeEmbedding(),
        createVectorDatabase: () => vectorDatabase,
        createContext: () => new FakeContext() as unknown as Context,
        createSnapshotManager: () => new FakeSnapshotManager() as unknown as SnapshotManager,
        stdout: (message) => output.push(message),
    });

    assert.equal(exitCode, 0);
    assert.match(output.join(""), /Chunks: 42/);
    assert.match(output.join(""), /Embedding: OpenAI\/text-embedding-3-small/);
    assert.match(output.join(""), /Splitter: ast/);
});

test("runCliManageCommand list ignores remote manifest collection", async () => {
    const output: string[] = [];
    const vectorDatabase = createFakeVectorDatabase({
        [REMOTE_INDEX_MANIFEST_COLLECTION]: {
            queryRows: [
                {
                    metadata: {
                        codebasePath: "/repo/app",
                        collectionName: "hybrid_code_chunks_app",
                    },
                },
            ],
            rowCount: 1,
        },
        hybrid_code_chunks_app: {
            description:
                'codebasePath:/repo/app\nhitmuxContext:{"version":1,"codebasePath":"/repo/app","embedding":{"provider":"OpenAI","model":"text-embedding-3-small","dimension":1536},"schemaVersion":2,"metadataVersion":2,"splitterType":"ast","createdAt":"2026-06-18T00:00:00.000Z"}',
            rowCount: 42,
        },
    });

    const exitCode = await runCliManageCommand(["list", "/repo/app"], {
        createConfig: () => fakeConfig,
        createEmbedding: () => new FakeEmbedding(),
        createVectorDatabase: () => vectorDatabase,
        createContext: () => new FakeContext() as unknown as Context,
        createSnapshotManager: () => new FakeSnapshotManager() as unknown as SnapshotManager,
        stdout: (message) => output.push(message),
    });

    assert.equal(exitCode, 0);
    assert.match(output.join(""), /Collection: hybrid_code_chunks_app/);
    assert.doesNotMatch(output.join(""), new RegExp(REMOTE_INDEX_MANIFEST_COLLECTION));
});

test("runCliManageCommand rm drops collection and removes snapshot entry", async () => {
    const output: string[] = [];
    const vectorDatabase = createFakeVectorDatabase({
        hybrid_code_chunks_app: {
            description: "codebasePath:/repo/app",
            rowCount: 42,
        },
    });
    const snapshotManager = new FakeSnapshotManager();

    const exitCode = await runCliManageCommand(["rm", "/repo/app"], {
        createConfig: () => fakeConfig,
        createEmbedding: () => new FakeEmbedding(),
        createVectorDatabase: () => vectorDatabase,
        createContext: () => new FakeContext() as unknown as Context,
        createSnapshotManager: () => snapshotManager as unknown as SnapshotManager,
        acquireWriterLock: () => createFakeLock(),
        stdout: (message) => output.push(message),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(vectorDatabase.dropped, ["hybrid_code_chunks_app"]);
    assert.deepEqual(snapshotManager.removed, ["/repo/app"]);
    assert.equal(snapshotManager.saved, 1);
    assert.match(output.join(""), /Removed collection 'hybrid_code_chunks_app'/);
});

test("runCliManageCommand index sync refreshes snapshot from remote manifest", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "hce-cli-index-"));
    const output: string[] = [];
    let metadataQueryCalls = 0;
    const vectorDatabase = createFakeVectorDatabase({
        hybrid_code_chunks_app: {
            rowCount: 3,
        },
    });
    vectorDatabase.readIndexManifest = async (collectionName: string, codebasePath: string) => {
        assert.equal(collectionName, "hybrid_code_chunks_app");
        assert.equal(codebasePath, tempDir);
        return {
            manifestVersion: 1,
            codebasePath,
            collectionName,
            status: "completed",
            indexedFiles: 2,
            totalChunks: 3,
            schemaVersion: 2,
            metadataVersion: 2,
            generation: 1,
            updatedAt: "2026-06-21T00:00:00.000Z",
        };
    };
    vectorDatabase.query = async () => {
        metadataQueryCalls++;
        throw new Error("CLI index sync should not scan row metadata");
    };
    const snapshotManager = new FakeSnapshotManager();

    try {
        const exitCode = await runCliManageCommand(["index", tempDir], {
            createConfig: () => fakeConfig,
            createEmbedding: () => new FakeEmbedding(),
            createVectorDatabase: () => vectorDatabase,
            createContext: () =>
                new FakeContext(vectorDatabase) as unknown as Context,
            createSnapshotManager: () =>
                snapshotManager as unknown as SnapshotManager,
            acquireWriterLock: () => createFakeLock(),
            stdout: (message) => output.push(message),
        });

        assert.equal(exitCode, 0);
        assert.match(output.join(""), /Synced/);
        assert.deepEqual(snapshotManager.indexed, [
            {
                codebasePath: tempDir,
                stats: {
                    indexedFiles: 2,
                    totalChunks: 3,
                    status: "completed",
                    statsSource: "remote_manifest",
                },
                indexOptions: {},
            },
        ]);
        assert.equal(snapshotManager.saved, 1);
        assert.equal(metadataQueryCalls, 0);
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runCliManageCommand index sync reuses snapshot request options", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "hce-cli-options-"));
    const vectorDatabase = createFakeVectorDatabase({
        hybrid_code_chunks_app: {
            rowCount: 1,
        },
    });
    vectorDatabase.readIndexManifest = async (collectionName: string, codebasePath: string) => ({
        manifestVersion: 1,
        codebasePath,
        collectionName,
        status: "completed",
        indexedFiles: 1,
        totalChunks: 1,
        schemaVersion: 2,
        metadataVersion: 2,
        generation: 1,
        updatedAt: "2026-06-21T00:00:00.000Z",
    });
    const context = new FakeContext(vectorDatabase);
    const snapshotManager = new FakeSnapshotManager();
    snapshotManager.codebaseInfo = {
        status: "indexed",
        indexedFiles: 1,
        totalChunks: 1,
        indexStatus: "completed",
        requestSplitter: "langchain",
        requestIgnorePatterns: ["generated/**"],
        requestCustomExtensions: [".vue"],
        requestIgnoreFiles: [".extraignore"],
        requestMaxDepth: 2,
        lastUpdated: "2026-06-18T00:00:00.000Z",
    } as ReturnType<SnapshotManager["getCodebaseInfo"]>;

    try {
        const exitCode = await runCliManageCommand(["index", tempDir], {
            createConfig: () => fakeConfig,
            createEmbedding: () => new FakeEmbedding(),
            createVectorDatabase: () => vectorDatabase,
            createContext: () => context as unknown as Context,
            createSnapshotManager: () =>
                snapshotManager as unknown as SnapshotManager,
            acquireWriterLock: () => createFakeLock(),
            stdout: () => undefined,
        });

        assert.equal(exitCode, 0);
        assert.equal(context.reindexCalls.length, 1);
        assert.deepEqual(context.reindexCalls[0][2], ["generated/**"]);
        assert.deepEqual(context.reindexCalls[0][3], [".vue"]);
        assert.deepEqual(context.reindexCalls[0][5], [".extraignore"]);
        assert.equal(context.reindexCalls[0][6], 2);
        assert.deepEqual(snapshotManager.indexed[0]?.indexOptions, {
            requestSplitter: "langchain",
            requestIgnorePatterns: ["generated/**"],
            requestCustomExtensions: [".vue"],
            requestIgnoreFiles: [".extraignore"],
            requestMaxDepth: 2,
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runCliManageCommand index refuses collection-name target with mismatched current identity", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "hce-cli-mismatch-"));
    const errors: string[] = [];
    const vectorDatabase = createFakeVectorDatabase({
        legacy_collection: {
            description: `codebasePath:${tempDir}`,
            rowCount: 2,
        },
    });

    try {
        const exitCode = await runCliManageCommand(["index", "legacy_collection"], {
            createConfig: () => fakeConfig,
            createEmbedding: () => new FakeEmbedding(),
            createVectorDatabase: () => vectorDatabase,
            createContext: () =>
                new FakeContext(vectorDatabase, "current_collection") as unknown as Context,
            createSnapshotManager: () =>
                new FakeSnapshotManager() as unknown as SnapshotManager,
            acquireWriterLock: () => createFakeLock(),
            stderr: (message) => errors.push(message),
        });

        assert.equal(exitCode, 1);
        assert.match(errors.join(""), /current configuration maps that path/);
        assert.match(errors.join(""), /legacy_collection/);
        assert.match(errors.join(""), /current_collection/);
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
