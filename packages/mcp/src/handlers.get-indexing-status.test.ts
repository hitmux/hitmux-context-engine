import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeCodebaseIdentityPath } from "@hitmux/hitmux-context-engine-core";
import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";
import { getMcpWriterLockPath } from "./sync-lock.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hitmux-context-engine-mcp-status-"));
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

async function writeMerkleSnapshot(homeDir: string, codebasePath: string, files: string[]): Promise<void> {
    const normalizedPath = normalizeCodebaseIdentityPath(codebasePath);
    const hash = crypto.createHash("md5").update(normalizedPath).digest("hex");
    const merkleDir = path.join(homeDir, ".hitmux-context-engine", "merkle");
    await mkdir(merkleDir, { recursive: true });
    await writeFile(
        path.join(merkleDir, `${hash}.json`),
        JSON.stringify({
            fileHashes: files.map((file, index) => [file, `hash-${index}`]),
            fileStates: [],
            merkleDAG: {},
        }),
        "utf8",
    );
}

test("get_indexing_status syncs vector database state before reading the snapshot", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "not_found");

        const handlers = new ToolHandlers({} as any, snapshotManager);
        let syncCalls = 0;
        (handlers as any).syncTargetCodebaseFromVectorDatabase = async () => {
            syncCalls += 1;
            snapshotManager.setCodebaseIndexed(codebasePath, {
                indexedFiles: 3,
                totalChunks: 5,
                status: "completed",
            });
        };

        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(syncCalls, 1);
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /fully indexed and ready for search/);
        assert.match(result.content[0].text, /3 files, 5 chunks/);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexed");
    });
});

test("get_indexing_status reports job state when global snapshot entry is missing", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        const handlers = new ToolHandlers({} as any, snapshotManager);
        const jobStates = (handlers as any).indexingJobStates;
        await jobStates.createRunningJob({
            jobId: "index_missing_snapshot",
            codebasePath,
            collectionName: "collection_repo",
            splitterType: "ast",
        });
        await jobStates.updateProgress("index_missing_snapshot", {
            phase: "Processing files...",
            current: 1,
            total: 4,
            percentage: 25,
        });

        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /not recorded in the global snapshot/);
        assert.match(result.content[0].text, /index_missing_snapshot/);
        assert.match(result.content[0].text, /25\.0%/);
    });
});

test("get_indexing_status refreshes indexed entries written by another MCP process", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const firstSnapshotManager = new SnapshotManager();
        const secondSnapshotManager = new SnapshotManager();
        secondSnapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 7,
            totalChunks: 11,
            status: "completed",
        });
        secondSnapshotManager.saveCodebaseSnapshot();

        const handlers = new ToolHandlers({} as any, firstSnapshotManager);
        (handlers as any).syncTargetCodebaseFromVectorDatabase = async () => {};

        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /fully indexed and ready for search/);
        assert.match(result.content[0].text, /7 files, 11 chunks/);
        assert.equal(firstSnapshotManager.getCodebaseStatus(codebasePath), "indexed");
    });
});

test("get_indexing_status refreshes active indexing entries without marking them failed", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const firstSnapshotManager = new SnapshotManager();
        const secondSnapshotManager = new SnapshotManager();
        secondSnapshotManager.setCodebaseIndexing(codebasePath, 37);
        secondSnapshotManager.saveCodebaseSnapshot();

        const handlers = new ToolHandlers({} as any, firstSnapshotManager);
        (handlers as any).syncTargetCodebaseFromVectorDatabase = async () => {};

        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /currently being indexed/);
        assert.match(result.content[0].text, /37\.0%/);
        assert.equal(firstSnapshotManager.getCodebaseStatus(codebasePath), "indexing");
    });
});

test("get_indexing_status does not hang when target collection existence check stalls", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        const context = {
            getCollectionName: () => "code_chunks_stalled",
            getVectorDatabase: () => ({
                hasCollection: async () => new Promise<boolean>(() => {}),
            }),
        };

        const handlers = new ToolHandlers(context as any, snapshotManager);
        (handlers as any).vectorDatabaseSyncTimeoutMs = 5;
        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /is not indexed/);
    });
});

test("get_indexing_status does not scan unrelated vector database collections for a tracked codebase", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 3,
            totalChunks: 5,
            status: "completed",
        });
        snapshotManager.saveCodebaseSnapshot();

        const collectionName = "hybrid_code_chunks_target";
        let hasCollectionCalls = 0;
        let descriptionCalls = 0;
        const vectorDb = {
            hasCollection: async () => {
                hasCollectionCalls += 1;
                return true;
            },
            getCollectionDescription: async () => {
                descriptionCalls += 1;
                return `codebasePath:${codebasePath}`;
            },
            listCollections: async () => {
                throw new Error("listCollections should not run for single-path status");
            },
            getCollectionRowCount: async () => {
                throw new Error("metadata row count should not run for tracked target");
            },
            query: async () => {
                throw new Error("metadata query should not run for tracked target");
            },
        };
        const context = {
            getVectorDatabase: () => vectorDb,
            getCollectionName: () => collectionName,
        };

        const handlers = new ToolHandlers(context as any, snapshotManager);
        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /fully indexed and ready for search/);
        assert.equal(hasCollectionCalls, 1);
        assert.equal(descriptionCalls, 1);
    });
});

test("get_indexing_status does not let vector database recovery mark active indexing as completed", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexing(codebasePath, 42);
        snapshotManager.saveCodebaseSnapshot();

        let rowCountQueries = 0;
        const collectionName = "code_chunks_partial";
        const vectorDb = {
            hasCollection: async () => true,
            listCollections: async () => [collectionName],
            getCollectionDescription: async () => `codebasePath:${codebasePath}`,
            getCollectionRowCount: async () => {
                rowCountQueries += 1;
                return 64;
            },
            readIndexManifest: async () => null,
            query: async () => {
                throw new Error("metadata query should not run during status");
            },
        };
        const context = {
            getVectorDatabase: () => vectorDb,
            getCollectionName: () => collectionName,
        };

        const handlers = new ToolHandlers(context as any, snapshotManager);
        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(rowCountQueries, 1);
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /currently being indexed/);
        assert.match(result.content[0].text, /42\.0%/);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexing");
    });
});

test("get_indexing_status keeps shared local snapshot entries while collection description path is indexing", async () => {
    await withTempHome(async (tempRoot) => {
        const indexingCodebasePath = path.join(tempRoot, "repo-indexing");
        const indexedCodebasePath = path.join(tempRoot, "repo-indexed");
        await mkdir(indexingCodebasePath, { recursive: true });
        await mkdir(indexedCodebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexing(indexingCodebasePath, 42);
        snapshotManager.setCodebaseIndexed(indexedCodebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed",
        });
        snapshotManager.saveCodebaseSnapshot();

        let rowCountQueries = 0;
        const collectionName = "hybrid_code_chunks_shared";
        const vectorDb = {
            hasCollection: async () => true,
            listCollections: async () => [collectionName],
            getCollectionDescription: async () => `codebasePath:${indexingCodebasePath}`,
            getCollectionRowCount: async () => {
                rowCountQueries += 1;
                return 64;
            },
            readIndexManifest: async () => null,
            query: async () => {
                throw new Error("metadata query should not run while collection path is indexing");
            },
        };
        const context = {
            getVectorDatabase: () => vectorDb,
            getCollectionName: () => collectionName,
        };

        const handlers = new ToolHandlers(context as any, snapshotManager);
        const result = await handlers.handleGetIndexingStatus({ path: indexedCodebasePath });

        assert.equal(rowCountQueries, 1);
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /fully indexed and ready for search/);
        assert.equal(snapshotManager.getCodebaseStatus(indexingCodebasePath), "indexing");
        assert.equal(snapshotManager.getCodebaseStatus(indexedCodebasePath), "indexed");
    });
});

test("get_indexing_status recovers requested codebase from shared remote manifest", async () => {
    await withTempHome(async (tempRoot) => {
        const firstCodebasePath = path.join(tempRoot, "repo-a");
        const secondCodebasePath = path.join(tempRoot, "repo-b");
        await mkdir(firstCodebasePath, { recursive: true });
        await mkdir(secondCodebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        const collectionName = "hybrid_code_chunks_shared";
        let metadataQueryCalls = 0;
        const vectorDb = {
            hasCollection: async () => true,
            listCollections: async () => [collectionName],
            getCollectionDescription: async () => `codebasePath:${firstCodebasePath}`,
            getCollectionRowCount: async () => 1,
            readIndexManifest: async (_collectionName: string, codebasePath: string) =>
                codebasePath === secondCodebasePath
                    ? {
                        manifestVersion: 1,
                        codebasePath: secondCodebasePath,
                        collectionName,
                        status: "completed" as const,
                        indexedFiles: 1,
                        totalChunks: 1,
                        schemaVersion: 2,
                        metadataVersion: 2,
                        generation: 1,
                        updatedAt: "2026-06-21T00:00:00.000Z",
                    }
                    : null,
            query: async () => {
                metadataQueryCalls += 1;
                throw new Error("metadata query should not run during status recovery");
            },
        };
        const context = {
            getVectorDatabase: () => vectorDb,
            getCollectionName: () => collectionName,
        };

        const handlers = new ToolHandlers(context as any, snapshotManager);
        const result = await handlers.handleGetIndexingStatus({ path: secondCodebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /fully indexed and ready for search/);
        assert.match(result.content[0].text, /1 files, 1 chunks/);
        assert.equal(metadataQueryCalls, 0);
        assert.equal(snapshotManager.getCodebaseStatus(firstCodebasePath), "not_found");
        assert.equal(snapshotManager.getCodebaseStatus(secondCodebasePath), "indexed");
    });
});

test("get_indexing_status deduplicates concurrent collection probes for the same collection", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed",
        });
        snapshotManager.saveCodebaseSnapshot();

        const collectionName = "code_chunks_dedupe";
        let hasCollectionCalls = 0;
        let descriptionCalls = 0;
        let rowCountCalls = 0;
        let releaseProbe!: () => void;
        const probeGate = new Promise<void>((resolve) => {
            releaseProbe = resolve;
        });
        const vectorDb = {
            hasCollection: async () => {
                hasCollectionCalls += 1;
                await probeGate;
                return true;
            },
            getCollectionDescription: async () => {
                descriptionCalls += 1;
                return `codebasePath:${codebasePath}`;
            },
            getCollectionRowCount: async () => {
                rowCountCalls += 1;
                return 1;
            },
            readIndexManifest: async () => ({
                manifestVersion: 1,
                codebasePath,
                collectionName,
                status: "completed" as const,
                indexedFiles: 1,
                totalChunks: 1,
                schemaVersion: 2,
                metadataVersion: 2,
                generation: 1,
                updatedAt: "2026-06-21T00:00:00.000Z",
            }),
            query: async () => {
                throw new Error("metadata query should not run during status");
            },
        };
        const context = {
            getVectorDatabase: () => vectorDb,
            getCollectionName: () => collectionName,
        };

        const handlers = new ToolHandlers(context as any, snapshotManager);
        const first = handlers.handleGetIndexingStatus({ path: codebasePath });
        const second = handlers.handleGetIndexingStatus({ path: codebasePath });
        await new Promise((resolve) => setImmediate(resolve));
        releaseProbe();
        const results = await Promise.all([first, second]);

        assert.equal(results[0].isError, undefined);
        assert.equal(results[1].isError, undefined);
        assert.equal(hasCollectionCalls, 1);
        assert.equal(descriptionCalls, 1);
        assert.equal(rowCountCalls, 1);
    });
});

test("get_indexing_status keeps local shared snapshot entries when path extraction is incomplete", async () => {
    await withTempHome(async (tempRoot) => {
        const firstCodebasePath = path.join(tempRoot, "repo-a");
        const secondCodebasePath = path.join(tempRoot, "repo-b");
        await mkdir(firstCodebasePath, { recursive: true });
        await mkdir(secondCodebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(secondCodebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed",
        });
        snapshotManager.saveCodebaseSnapshot();

        const collectionName = "hybrid_code_chunks_shared";
        const vectorDb = {
            hasCollection: async () => true,
            listCollections: async () => [collectionName],
            getCollectionDescription: async () => `codebasePath:${firstCodebasePath}`,
            getCollectionRowCount: async () => -1,
            query: async () => {
                throw new Error("metadata query unavailable");
            },
        };
        const context = {
            getVectorDatabase: () => vectorDb,
            getCollectionName: () => collectionName,
        };

        const handlers = new ToolHandlers(context as any, snapshotManager);
        const result = await handlers.handleGetIndexingStatus({ path: secondCodebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /fully indexed and ready for search/);
        assert.equal(snapshotManager.getCodebaseStatus(secondCodebasePath), "indexed");
    });
});

test("get_indexing_status reports active automatic sync progress for indexed codebases", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 3,
            totalChunks: 5,
            status: "completed",
        });

        const syncStartedAt = Date.now() - 1250;
        const syncManager = {
            getSyncStatus: (requestedPath: string) => requestedPath === codebasePath
                ? {
                    codebasePath,
                    phase: "Removed third_party/generated.c",
                    current: 1,
                    total: 4,
                    percentage: 25,
                    startedAtMs: syncStartedAt,
                    updatedAtMs: Date.now(),
                }
                : undefined,
        };

        const handlers = new ToolHandlers({} as any, snapshotManager, syncManager);
        (handlers as any).syncTargetCodebaseFromVectorDatabase = async () => {};

        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Automatic sync in progress/);
        assert.match(result.content[0].text, /Elapsed: \d+\.\d+s/);
        assert.match(result.content[0].text, /Progress: 25\.0% \(1\/4\)/);
        assert.match(result.content[0].text, /Phase: Removed third_party\/generated\.c/);
        assert.match(result.content[0].text, /Please wait for sync to finish/);
    });
});

test("get_indexing_status does not report recovered row count as file count", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 0,
            totalChunks: 4300,
            status: "completed",
            statsSource: "collection_row_count",
        });

        const handlers = new ToolHandlers({} as any, snapshotManager);
        (handlers as any).syncTargetCodebaseFromVectorDatabase = async () => {};

        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /file count unknown, 4300 chunks/);
        assert.doesNotMatch(result.content[0].text, /4300 files, 4300 chunks/);
    });
});

test("get_indexing_status uses merkle file count for legacy equal file and chunk counts", async () => {
    await withTempHome(async (tempRoot) => {
        const homeDir = path.join(tempRoot, "home");
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });
        await writeMerkleSnapshot(homeDir, codebasePath, ["src/a.ts", "src/b.ts"]);

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 4300,
            totalChunks: 4300,
            status: "completed",
        });

        const handlers = new ToolHandlers({} as any, snapshotManager);
        (handlers as any).syncTargetCodebaseFromVectorDatabase = async () => {};

        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /2 files, 4300 chunks/);
        assert.doesNotMatch(result.content[0].text, /4300 files, 4300 chunks/);
    });
});

test("repair_index_manifest counts distinct relative paths for legacy indexed file count", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        const collectionName = "code_chunks_recovered";
        let savedManifest: any = null;
        const vectorDb = {
            hasCollection: async () => true,
            listCollections: async () => [collectionName],
            getCollectionDescription: async () => `codebasePath:${codebasePath}`,
            getCollectionRowCount: async () => 4,
            query: async () => [
                { relativePath: "src/a.ts" },
                { relativePath: "src/a.ts" },
                { relativePath: "src/b.ts" },
                { relativePath: "src/c.ts" },
            ],
            readIndexManifest: async () => null,
            writeIndexManifest: async (manifest: any) => {
                savedManifest = manifest;
            },
        };
        const context = {
            getVectorDatabase: () => vectorDb,
            getCollectionName: () => collectionName,
        };

        const handlers = new ToolHandlers(context as any, snapshotManager);
        const result = await handlers.handleRepairIndexManifest({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /3 files, 4 chunks/);
        assert.equal(savedManifest.indexedFiles, 3);
        assert.equal(savedManifest.totalChunks, 4);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexed");
    });
});

test("repair_index_manifest refuses to run while another writer holds the lock", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });
        const collectionName = "code_chunks_locked";
        await mkdir(
            getMcpWriterLockPath({ kind: "collection", collectionName }),
            { recursive: true },
        );

        const snapshotManager = new SnapshotManager();
        let metadataQueryCalls = 0;
        const context = {
            getVectorDatabase: () => ({
                hasCollection: async () => true,
                getCollectionDescription: async () => `codebasePath:${codebasePath}`,
                getCollectionRowCount: async () => 1,
                query: async () => {
                    metadataQueryCalls += 1;
                    return [];
                },
            }),
            getCollectionName: () => collectionName,
        };

        const handlers = new ToolHandlers(context as any, snapshotManager);
        const result = await handlers.handleRepairIndexManifest({ path: codebasePath });

        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /already writing index state for collection/);
        assert.match(result.content[0].text, /code_chunks_locked/);
        assert.equal(metadataQueryCalls, 0);
    });
});
