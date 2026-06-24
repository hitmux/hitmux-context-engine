import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IncrementalIndexTooLargeError } from "@hitmux/hitmux-context-engine-core";
import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";

const require = createRequire(import.meta.url);

function createHandlers(): ToolHandlers {
    return new ToolHandlers({} as any, new SnapshotManager());
}

async function withTempDir(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hitmux-context-engine-mcp-args-"));
    const homeDir = path.join(tempRoot, "home");
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalCwd = process.cwd();
    try {
        await mkdir(homeDir, { recursive: true });
        process.env.HOME = homeDir;
        process.env.USERPROFILE = homeDir;
        process.chdir(tempRoot);
        await run(tempRoot);
    } finally {
        process.chdir(originalCwd);
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

async function writeProjectConfig(projectRoot: string, config: Record<string, unknown>): Promise<void> {
    const configDir = path.join(projectRoot, ".hitmux-context-engine");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "config.conf"), stringifyConf(config), "utf-8");
}

function stringifyConf(config: Record<string, unknown>): string {
    return Object.entries(config)
        .flatMap(([key, value]) => Array.isArray(value)
            ? value.map(item => `${key} = ${String(item)}`)
            : [`${key} = ${String(value)}`])
        .join("\n") + "\n";
}

test("index_codebase rejects missing path before path resolution", async () => {
    const handlers = createHandlers();

    const result = await handlers.handleIndexCodebase({});

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /index_codebase/);
    assert.match(result.content[0].text, /'path'/);
});

test("MCP tools reject relative codebase paths", async () => {
    await withTempDir(async () => {
        const handlers = new ToolHandlers({
            hasIndex: async () => {
                throw new Error("relative path should be rejected before index lookup");
            },
            semanticSearch: async () => {
                throw new Error("relative path should be rejected before search");
            }
        } as any, new SnapshotManager());
        const cases: Array<{ tool: string; run: () => Promise<any> }> = [
            {
                tool: "index_codebase",
                run: () => handlers.handleIndexCodebase({ path: "repo", dryRun: true })
            },
            {
                tool: "search_code",
                run: () => handlers.handleSearchCode({ path: "repo", query: "auth middleware" })
            },
            {
                tool: "clear_index",
                run: () => handlers.handleClearIndex({ path: "repo" })
            },
            {
                tool: "get_indexing_status",
                run: () => handlers.handleGetIndexingStatus({ path: "repo" })
            }
        ];

        for (const { tool, run } of cases) {
            const result = await run();
            assert.equal(result.isError, true, `${tool} should reject relative paths`);
            assert.match(result.content[0].text, /Path must be absolute/);
            assert.match(result.content[0].text, /repo/);
        }
    });
});

test("index_codebase rejects malformed ignore pattern arrays before path resolution", async () => {
    const handlers = createHandlers();

    const result = await handlers.handleIndexCodebase({
        path: "/tmp/project",
        ignorePatterns: ["dist/**", 12]
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ignorePatterns/);
    assert.match(result.content[0].text, /array of non-empty strings/);
});

test("index_codebase rejects malformed control arguments before path resolution", async () => {
    const handlers = createHandlers();

    const cases: Array<{ args: Record<string, unknown>; field: string }> = [
        { args: { force: "false" }, field: "force" },
        { args: { incremental: "true" }, field: "incremental" },
        { args: { dryRun: "true" }, field: "dryRun" },
        { args: { maxDepth: "1" }, field: "maxDepth" },
        { args: { maxDepth: -1 }, field: "maxDepth" },
        { args: { maxDepth: Number.POSITIVE_INFINITY }, field: "maxDepth" },
    ];

    for (const { args, field } of cases) {
        const result = await handlers.handleIndexCodebase({
            path: "/tmp/does-not-exist",
            ...args
        });

        assert.equal(result.isError, true);
        assert.match(result.content[0].text, new RegExp(field));
        assert.doesNotMatch(result.content[0].text, /does not exist/);
    }
});

test("get_indexing_status rejects malformed refresh argument before status lookup", async () => {
    const handlers = createHandlers();

    const result = await handlers.handleGetIndexingStatus({
        path: "/tmp/does-not-exist",
        refresh: "true",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /refresh/);
    assert.match(result.content[0].text, /boolean/);
});

test("index_codebase dryRun previews files without starting indexing", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let previewCalled = false;
        const context = {
            previewIndexableFiles: async (
                codebasePath: string,
                ignorePatterns: string[],
                customExtensions: string[],
                requestOptions: any
            ) => {
                previewCalled = true;
                assert.equal(codebasePath, project);
                assert.deepEqual(ignorePatterns, ["dist/**"]);
                assert.deepEqual(customExtensions, ["foo"]);
                assert.deepEqual(requestOptions, {
                    additionalIgnoreFiles: [".hitmux-context-engineignore"],
                    maxDepth: 1
                });
                return {
                    totalFiles: 2,
                    files: ["src/a.ts", "src/b.foo"],
                    sampleLimit: 50
                };
            }
        } as any;
        const handlers = new ToolHandlers(context, new SnapshotManager());

        const result = await handlers.handleIndexCodebase({
            path: project,
            dryRun: true,
            ignorePatterns: ["dist/**"],
            customExtensions: ["foo"],
            ignoreFiles: [".hitmux-context-engineignore"],
            maxDepth: 1
        });

        assert.equal(result.isError, undefined);
        assert.equal(previewCalled, true);
        assert.match(result.content[0].text, /Dry run/);
        assert.match(result.content[0].text, /Matched 2 file/);
        assert.match(result.content[0].text, /src\/a\.ts/);
    });
});

test("index_codebase respects interactiveIndexing=false from config", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });
        await writeProjectConfig(tempRoot, { interactiveIndexing: false });

        const handlers = createHandlers();
        const result = await handlers.handleIndexCodebase({ path: project });

        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /Interactive indexing is disabled/);
    });
});

test("index_codebase incremental=true manually syncs changed files without full reindex", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let reindexArgs: any[] | undefined;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            hasIndex: async () => true,
            reindexByChange: async (...args: any[]) => {
                reindexArgs = args;
                return { added: 2, removed: 1, modified: 3 };
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 4,
            totalChunks: 12,
            status: "completed"
        }, {
            requestSplitter: "langchain",
            requestCustomExtensions: [".vue"],
            requestIgnorePatterns: ["dist/**"],
            requestIgnoreFiles: [".hceignore"],
            requestMaxDepth: 3
        });
        snapshotManager.setCodebaseSyncWarning(project, "old warning");
        snapshotManager.saveCodebaseSnapshot();

        const handlers = new ToolHandlers(context, snapshotManager);
        const result = await handlers.handleIndexCodebase({
            path: project,
            incremental: true
        });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Manual incremental indexing completed/);
        assert.match(result.content[0].text, /Added 2, Removed 1, Modified 3/);
        assert.equal(reindexArgs?.[0], project);
        assert.deepEqual(reindexArgs?.[2], ["dist/**"]);
        assert.deepEqual(reindexArgs?.[3], [".vue"]);
        assert.deepEqual(reindexArgs?.[5], [".hceignore"]);
        assert.equal(reindexArgs?.[6], 3);
        assert.deepEqual(reindexArgs?.[7], { skipEffectiveLineLimit: true });

        const info = snapshotManager.getCodebaseInfo(project);
        assert.equal(info?.status, "indexed");
        assert.equal((info as any).syncWarning, undefined);
    });
});

test("index_codebase incremental=true updates snapshot without metadata statistics scan", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        const collectionName = "code_chunks_repo";
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => [],
                getCollectionRowCount: async () => 5,
                query: async () => {
                    throw new Error("metadata query should not run after manual incremental indexing");
                }
            }),
            getCollectionName: () => collectionName,
            hasIndex: async () => true,
            reindexByChange: async () => ({ added: 1, removed: 0, modified: 1 })
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 2,
            status: "completed"
        }, {
            requestSplitter: "langchain",
            requestCustomExtensions: [".vue"]
        });
        snapshotManager.saveCodebaseSnapshot();

        const handlers = new ToolHandlers(context, snapshotManager);
        const result = await handlers.handleIndexCodebase({
            path: project,
            incremental: true
        });

        assert.equal(result.isError, undefined);
        const info = snapshotManager.getCodebaseInfo(project);
        assert.equal(info?.status, "indexed");
        assert.equal((info as any).indexedFiles, 2);
        assert.equal((info as any).totalChunks, 2);
        assert.equal((info as any).statsSource, undefined);
        assert.equal((info as any).requestSplitter, "langchain");
        assert.deepEqual((info as any).requestCustomExtensions, [".vue"]);
    });
});

test("index_codebase uses config splitterType when splitter argument is omitted", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });
        await writeProjectConfig(project, { splitterType: "langchain" });

        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => [],
                checkCollectionLimit: async () => true
            }),
            hasIndex: async () => false
        } as any;
        const snapshotManager = new SnapshotManager();
        const handlers = new ToolHandlers(context, snapshotManager);
        let requestedSplitter: string | undefined;
        (handlers as any).startBackgroundIndexing = async (_path: string, _force: boolean, splitterType: string) => {
            requestedSplitter = splitterType;
        };

        const result = await handlers.handleIndexCodebase({ path: project });

        assert.equal(result.isError, undefined);
        assert.equal(requestedSplitter, "langchain");
        assert.match(result.content[0].text, /LANGCHAIN splitter/);
        assert.equal((snapshotManager.getCodebaseInfo(project) as any)?.requestSplitter, "langchain");
    });
});

test("index_codebase explicit splitter overrides config splitterType", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });
        await writeProjectConfig(project, { splitterType: "langchain" });

        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => [],
                checkCollectionLimit: async () => true
            }),
            hasIndex: async () => false
        } as any;
        const handlers = new ToolHandlers(context, new SnapshotManager());
        let requestedSplitter: string | undefined;
        (handlers as any).startBackgroundIndexing = async (_path: string, _force: boolean, splitterType: string) => {
            requestedSplitter = splitterType;
        };

        const result = await handlers.handleIndexCodebase({ path: project, splitter: "ast" });

        assert.equal(result.isError, undefined);
        assert.equal(requestedSplitter, "ast");
        assert.match(result.content[0].text, /AST splitter/);
    });
});

test("index_codebase rejects conflicting incremental and force modes", async () => {
    const handlers = createHandlers();

    const result = await handlers.handleIndexCodebase({
        path: "/tmp/project",
        incremental: true,
        force: true
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /mutually exclusive/);
});

test("search_code rejects missing query before search handling", async () => {
    const handlers = createHandlers();

    const result = await handlers.handleSearchCode({ path: "/tmp/project" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /search_code/);
    assert.match(result.content[0].text, /'query'/);
});

test("search_code not-indexed response recommends project ignore file", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            hasIndex: async () => false
        } as any;
        const handlers = new ToolHandlers(context, new SnapshotManager());

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch"
        });

        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /not indexed/);
        assert.match(result.content[0].text, /\.hceignore/);
        assert.match(result.content[0].text, /\.\*ignore/);
        assert.match(result.content[0].text, /index_codebase/);
    });
});

test("get_indexing_status not-indexed response recommends project ignore file", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            })
        } as any;
        const handlers = new ToolHandlers(context, new SnapshotManager());

        const result = await handlers.handleGetIndexingStatus({ path: project });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /not indexed/);
        assert.match(result.content[0].text, /\.hceignore/);
        assert.match(result.content[0].text, /\.\*ignore/);
        assert.match(result.content[0].text, /index_codebase/);
        assert.match(result.content[0].text, /refresh=true/);
    });
});

test("search_code uses a bounded default when limit is omitted", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let requestedTopK: number | undefined;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async (_codebasePath: string, _query: string, topK: number) => {
                requestedTopK = topK;
                return [{
                    content: "function runSearch() {}",
                    relativePath: "src/search.ts",
                    startLine: 1,
                    endLine: 1,
                    language: "typescript",
                    score: 1
                }];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 4,
            totalChunks: 37,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch"
        });

        assert.equal(result.isError, undefined);
        assert.equal(requestedTopK, 20);
        assert.match(result.content[0].text, /Found 1 results/);
    });
});

test("search_code does not sync all vector database collections before normal search", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let listCollectionCalls = 0;
        let searchCalls = 0;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => {
                    listCollectionCalls += 1;
                    throw new Error("search_code should not list all collections");
                }
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => {
                searchCalls += 1;
                return [{
                    content: "function runSearch() {}",
                    relativePath: "src/search.ts",
                    startLine: 1,
                    endLine: 1,
                    language: "typescript",
                    score: 1
                }];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 4,
            totalChunks: 37,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch"
        });

        assert.equal(result.isError, undefined);
        assert.equal(searchCalls, 1);
        assert.equal(listCollectionCalls, 0);
        assert.match(result.content[0].text, /Found 1 results/);
    });
});

test("search_code recovers a missing snapshot from the target collection only", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let listCollectionCalls = 0;
        let hasIndexCalls = 0;
        let rowCountCalls = 0;
        let metadataQueryCalls = 0;
        let searchCalls = 0;
        const collectionName = "code_chunks_repo";
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => {
                    listCollectionCalls += 1;
                    throw new Error("target recovery should not list all collections");
                },
                getCollectionRowCount: async (requestedCollection: string) => {
                    rowCountCalls += 1;
                    assert.equal(requestedCollection, collectionName);
                    return 3;
                },
                readIndexManifest: async (requestedCollection: string, codebasePath: string) => {
                    assert.equal(requestedCollection, collectionName);
                    assert.equal(codebasePath, project);
                    return {
                        manifestVersion: 1,
                        codebasePath: project,
                        collectionName,
                        status: "completed" as const,
                        indexedFiles: 2,
                        totalChunks: 3,
                        schemaVersion: 2,
                        metadataVersion: 2,
                        generation: 1,
                        updatedAt: "2026-06-21T00:00:00.000Z"
                    };
                },
                query: async () => {
                    metadataQueryCalls += 1;
                    throw new Error("metadata query should not run during search snapshot recovery");
                },
            }),
            getCollectionName: () => collectionName,
            hasIndex: async (codebasePath: string) => {
                hasIndexCalls += 1;
                assert.equal(codebasePath, project);
                return true;
            },
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async (codebasePath: string) => {
                searchCalls += 1;
                assert.equal(codebasePath, project);
                return [{
                    content: "function runSearch() {}",
                    relativePath: "src/search.ts",
                    startLine: 1,
                    endLine: 1,
                    language: "typescript",
                    score: 1
                }];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch"
        });

        assert.equal(result.isError, undefined);
        assert.equal(listCollectionCalls, 0);
        assert.equal(hasIndexCalls, 1);
        assert.equal(rowCountCalls, 0);
        assert.equal(metadataQueryCalls, 0);
        assert.equal(searchCalls, 1);
        const info = snapshotManager.getCodebaseInfo(project) as any;
        assert.equal(info.status, "indexed");
        assert.equal(info.indexedFiles, 2);
        assert.equal(info.totalChunks, 3);
    });
});

test("search_code recovers a missing snapshot from an indexed ancestor without listing collections", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        const requestedPath = path.join(project, "src");
        await mkdir(requestedPath, { recursive: true });

        let listCollectionCalls = 0;
        const hasIndexCalls: string[] = [];
        let rowCountCalls = 0;
        let metadataQueryCalls = 0;
        let searchCalls = 0;
        const collectionName = "code_chunks_repo";
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => {
                    listCollectionCalls += 1;
                    throw new Error("ancestor recovery should not list all collections");
                },
                getCollectionRowCount: async (requestedCollection: string) => {
                    rowCountCalls += 1;
                    assert.equal(requestedCollection, collectionName);
                    return 2;
                },
                readIndexManifest: async (requestedCollection: string, codebasePath: string) => {
                    assert.equal(requestedCollection, collectionName);
                    assert.equal(codebasePath, project);
                    return {
                        manifestVersion: 1,
                        codebasePath: project,
                        collectionName,
                        status: "completed" as const,
                        indexedFiles: 2,
                        totalChunks: 2,
                        schemaVersion: 2,
                        metadataVersion: 2,
                        generation: 1,
                        updatedAt: "2026-06-21T00:00:00.000Z"
                    };
                },
                query: async () => {
                    metadataQueryCalls += 1;
                    throw new Error("metadata query should not run during ancestor recovery");
                },
            }),
            getCollectionName: (codebasePath: string) => {
                assert.equal(
                    codebasePath === requestedPath || codebasePath === project,
                    true
                );
                return collectionName;
            },
            hasIndex: async (codebasePath: string) => {
                hasIndexCalls.push(codebasePath);
                return codebasePath === project;
            },
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async (codebasePath: string) => {
                searchCalls += 1;
                assert.equal(codebasePath, project);
                return [{
                    content: "function runSearch() {}",
                    relativePath: "src/search.ts",
                    startLine: 1,
                    endLine: 1,
                    language: "typescript",
                    score: 1
                }];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: requestedPath,
            query: "runSearch"
        });

        assert.equal(result.isError, undefined);
        assert.equal(listCollectionCalls, 0);
        assert.deepEqual(hasIndexCalls, [requestedPath, project]);
        assert.equal(rowCountCalls, 0);
        assert.equal(metadataQueryCalls, 0);
        assert.equal(searchCalls, 1);
        assert.match(result.content[0].text, /covered by indexed codebase/);
        const info = snapshotManager.getCodebaseInfo(project) as any;
        assert.equal(info.status, "indexed");
        assert.equal(info.indexedFiles, 2);
        assert.equal(info.totalChunks, 2);
    });
});

test("search_code stops snapshot recovery when a matched collection has unverifiable stats", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        const requestedPath = path.join(project, "src");
        await mkdir(requestedPath, { recursive: true });

        const hasIndexCalls: string[] = [];
        let searchCalls = 0;
        const context = {
            getVectorDatabase: () => ({
                getCollectionDescription: async () => undefined,
                getCollectionRowCount: async () => -1,
                readIndexManifest: async () => null,
                query: async () => {
                    throw new Error("metadata query should not run when manifest is missing");
                },
            }),
            getCollectionName: () => "code_chunks_src",
            hasIndex: async (codebasePath: string) => {
                hasIndexCalls.push(codebasePath);
                return true;
            },
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => {
                searchCalls += 1;
                return [{
                    content: "function runSearch() {}",
                    relativePath: "src/search.ts",
                    startLine: 1,
                    endLine: 1,
                    language: "typescript",
                    score: 1
                }];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: requestedPath,
            query: "runSearch"
        });

        assert.equal(result.isError, true);
        assert.deepEqual(hasIndexCalls, [requestedPath]);
        assert.equal(searchCalls, 0);
        assert.equal(snapshotManager.getCodebaseStatus(requestedPath), "not_found");
        assert.equal(snapshotManager.getCodebaseStatus(project), "not_found");
        assert.match(result.content[0].text, /not indexed/);
    });
});

test("search_code uses collection metadata to recover the real indexed root for shared identities", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        const requestedPath = path.join(project, "src");
        await mkdir(requestedPath, { recursive: true });

        let searchCalls = 0;
        const collectionName = "code_chunks_shared";
        const context = {
            getVectorDatabase: () => ({
                getCollectionDescription: async (requestedCollection: string) => {
                    assert.equal(requestedCollection, collectionName);
                    return `codebasePath:${project}`;
                },
                getCollectionRowCount: async (requestedCollection: string) => {
                    assert.equal(requestedCollection, collectionName);
                    return 2;
                },
                readIndexManifest: async (requestedCollection: string, codebasePath: string) => {
                    assert.equal(requestedCollection, collectionName);
                    assert.equal(codebasePath, project);
                    return {
                        manifestVersion: 1,
                        codebasePath: project,
                        collectionName,
                        status: "completed" as const,
                        indexedFiles: 2,
                        totalChunks: 2,
                        schemaVersion: 2,
                        metadataVersion: 2,
                        generation: 1,
                        updatedAt: "2026-06-21T00:00:00.000Z"
                    };
                },
                query: async () => {
                    throw new Error("metadata query should not run during shared identity recovery");
                },
            }),
            getCollectionName: (codebasePath: string) => {
                assert.equal(
                    codebasePath === requestedPath || codebasePath === project,
                    true
                );
                return collectionName;
            },
            hasIndex: async (codebasePath: string) => {
                assert.equal(codebasePath, requestedPath);
                return true;
            },
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async (codebasePath: string) => {
                searchCalls += 1;
                assert.equal(codebasePath, project);
                return [{
                    content: "function runSearch() {}",
                    relativePath: "src/search.ts",
                    startLine: 1,
                    endLine: 1,
                    language: "typescript",
                    score: 1
                }];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: requestedPath,
            query: "runSearch"
        });

        assert.equal(result.isError, undefined);
        assert.equal(searchCalls, 1);
        assert.equal(snapshotManager.getCodebaseStatus(requestedPath), "not_found");
        const info = snapshotManager.getCodebaseInfo(project) as any;
        assert.equal(info.status, "indexed");
        assert.equal(info.indexedFiles, 2);
        assert.equal(info.totalChunks, 2);
        assert.match(result.content[0].text, /covered by indexed codebase/);
    });
});

test("search_code uses project searchTopK and searchThreshold when explicit limit is omitted", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });
        await writeProjectConfig(project, {
            searchTopK: 7,
            searchThreshold: 0.12
        });

        let requestedTopK: number | undefined;
        let requestedThreshold: number | undefined;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async (
                _codebasePath: string,
                _query: string,
                topK: number,
                threshold: number
            ) => {
                requestedTopK = topK;
                requestedThreshold = threshold;
                return [{
                    content: "function runSearch() {}",
                    relativePath: "src/search.ts",
                    startLine: 1,
                    endLine: 1,
                    language: "typescript",
                    score: 1
                }];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 4,
            totalChunks: 37,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch"
        });

        assert.equal(result.isError, undefined);
        assert.equal(requestedTopK, 7);
        assert.equal(requestedThreshold, 0.12);
    });
});

test("search_code falls back when configured searchTopK or searchThreshold are invalid", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });
        await writeProjectConfig(project, {
            searchTopK: -1,
            searchThreshold: -0.5
        });

        let requestedTopK: number | undefined;
        let requestedThreshold: number | undefined;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async (
                _codebasePath: string,
                _query: string,
                topK: number,
                threshold: number
            ) => {
                requestedTopK = topK;
                requestedThreshold = threshold;
                return [{
                    content: "function runSearch() {}",
                    relativePath: "src/search.ts",
                    startLine: 1,
                    endLine: 1,
                    language: "typescript",
                    score: 1
                }];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 4,
            totalChunks: 37,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch"
        });

        assert.equal(result.isError, undefined);
        assert.equal(requestedTopK, 20);
        assert.equal(requestedThreshold, 0.3);
    });
});

test("search_code defaults to low-latency results while automatic sync is active", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let searchCalls = 0;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => {
                searchCalls += 1;
                return [{
                    content: "function runSearch() {}",
                    relativePath: "src/search.ts",
                    startLine: 1,
                    endLine: 1,
                    language: "typescript",
                    score: 1
                }];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 4,
            totalChunks: 37,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const syncManager = {
            getSyncStatus: (requestedPath: string) => requestedPath === project
                ? {
                    codebasePath: project,
                    phase: "Removed third_party/generated.c",
                    current: 1,
                    total: 4,
                    percentage: 25,
                    startedAtMs: Date.now() - 1250,
                    updatedAtMs: Date.now()
                }
                : undefined
        };
        const handlers = new ToolHandlers(context, snapshotManager, syncManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch"
        });

        assert.equal(result.isError, undefined);
        assert.equal(searchCalls, 1);
        assert.match(result.content[0].text, /Automatic sync in progress/);
        assert.match(result.content[0].text, /Search used the current index while automatic sync is in progress/);
        assert.match(result.content[0].text, /Progress: 25\.0% \(1\/4\)/);
    });
});

test("search_code rejects active sync in strong consistency mode", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let searchCalls = 0;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => {
                searchCalls += 1;
                return [];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 4,
            totalChunks: 37,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const syncManager = {
            getSyncStatus: (requestedPath: string) => requestedPath === project
                ? {
                    codebasePath: project,
                    phase: "Removed third_party/generated.c",
                    current: 1,
                    total: 4,
                    percentage: 25,
                    startedAtMs: Date.now() - 1250,
                    updatedAtMs: Date.now()
                }
                : undefined
        };
        const handlers = new ToolHandlers(context, snapshotManager, syncManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch",
            consistency: "strong"
        });

        assert.equal(result.isError, true);
        assert.equal(searchCalls, 0);
        assert.match(result.content[0].text, /requires a fresh index/);
        assert.match(result.content[0].text, /Automatic sync in progress/);
    });
});

test("search_code refreshes an indexed codebase before searching in strong consistency mode", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        const calls: string[] = [];
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => [],
                getCollectionRowCount: async () => 2,
                query: async () => [
                    { relativePath: "src/search.ts" },
                    { relativePath: "src/other.ts" }
                ]
            }),
            getCollectionName: () => "code_chunks_repo",
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            reindexByChange: async (codebasePath: string) => {
                calls.push(`sync:${codebasePath}`);
                return { added: 1, removed: 0, modified: 0 };
            },
            semanticSearch: async (codebasePath: string) => {
                calls.push(`search:${codebasePath}`);
                return [{
                    content: "function runSearch() {}",
                    relativePath: "src/search.ts",
                    startLine: 1,
                    endLine: 1,
                    language: "typescript",
                    score: 1
                }];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch",
            consistency: "strong"
        });

        assert.equal(result.isError, undefined);
        assert.deepEqual(calls, [`sync:${project}`, `search:${project}`]);
        const info = snapshotManager.getCodebaseInfo(project) as any;
        assert.equal(info.indexedFiles, 2);
        assert.equal(info.totalChunks, 1);
    });
});

test("search_code does not return stale results when strong pre-search sync exceeds the automatic limit", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let searchCalls = 0;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            reindexByChange: async () => {
                throw new IncrementalIndexTooLargeError(5_001, 5_000, 1);
            },
            semanticSearch: async () => {
                searchCalls += 1;
                return [];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch",
            consistency: "strong"
        });

        assert.equal(result.isError, true);
        assert.equal(searchCalls, 0);
        assert.match(result.content[0].text, /requires a fresh index/);
        assert.match(result.content[0].text, /index_codebase with incremental=true/);
        const info = snapshotManager.getCodebaseInfo(project) as any;
        assert.match(info.syncWarning, /5001 effective lines/);
    });
});

test("search_code does not return stale results when strong SyncManager pre-search sync exceeds the automatic limit", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let searchCalls = 0;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            reindexByChange: async () => ({ added: 0, removed: 0, modified: 0 }),
            semanticSearch: async () => {
                searchCalls += 1;
                return [];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const syncManager = {
            getSyncStatus: () => undefined,
            syncCodebaseForSearch: async () => {
                throw new IncrementalIndexTooLargeError(5_001, 5_000, 1);
            },
            trackCodebase: () => undefined
        };
        const handlers = new ToolHandlers(context, snapshotManager, syncManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch",
            consistency: "strong"
        });

        assert.equal(result.isError, true);
        assert.equal(searchCalls, 0);
        assert.match(result.content[0].text, /requires a fresh index/);
        assert.match(result.content[0].text, /index_codebase with incremental=true/);
        const info = snapshotManager.getCodebaseInfo(project) as any;
        assert.match(info.syncWarning, /5001 effective lines/);
    });
});

test("search_code does not return stale results when strong SyncManager pre-search sync fails", async () => {
    await withTempDir(async (tempRoot) => {
        await writeProjectConfig(tempRoot, { projectWatcher: false });
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let searchCalls = 0;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            reindexByChange: async () => {
                throw new Error("sync backend unavailable");
            },
            semanticSearch: async () => {
                searchCalls += 1;
                return [];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const syncManager = new SyncManager(context, snapshotManager);
        const handlers = new ToolHandlers(context, snapshotManager, syncManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch",
            consistency: "strong"
        });

        assert.equal(result.isError, true);
        assert.equal(searchCalls, 0);
        assert.match(result.content[0].text, /could not refresh index/);
        assert.match(result.content[0].text, /sync backend unavailable/);
    });
});

test("search_code warns and searches current index when low-latency SyncManager pre-search sync fails", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let searchCalls = 0;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            reindexByChange: async () => {
                throw new Error("full scan should not run");
            },
            reindexChangedPaths: async () => {
                throw new Error("sync backend unavailable");
            },
            semanticSearch: async () => {
                searchCalls += 1;
                return [{
                    content: "function runSearch() {}",
                    relativePath: "src/search.ts",
                    startLine: 1,
                    endLine: 1,
                    language: "typescript",
                    score: 1
                }];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const syncManager = new SyncManager(context, snapshotManager);
        (syncManager as any).lastFullScanMs.set(project, Date.now());
        (syncManager as any).projectChangeTracker = {
            watch: () => undefined,
            getState: () => ({ kind: "dirty", paths: ["src/search.ts"], version: 1 }),
            markPathsClean: () => undefined,
            markClean: () => undefined,
            close: async () => undefined
        };
        const handlers = new ToolHandlers(context, snapshotManager, syncManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch",
            consistency: "low_latency"
        });

        assert.equal(result.isError, undefined);
        assert.equal(searchCalls, 1);
        assert.match(result.content[0].text, /pre-search incremental sync failed: sync backend unavailable/);
        assert.match(result.content[0].text, /function runSearch/);
    });
});

test("search_code can skip the pre-search consistency check", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let syncCalls = 0;
        let searchCalls = 0;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            reindexByChange: async () => {
                syncCalls += 1;
                throw new Error("should not sync");
            },
            semanticSearch: async () => {
                searchCalls += 1;
                return [{
                    content: "function runSearch() {}",
                    relativePath: "src/search.ts",
                    startLine: 1,
                    endLine: 1,
                    language: "typescript",
                    score: 1
                }];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch",
            consistency: "strong",
            skipConsistencyCheck: true
        });

        assert.equal(result.isError, undefined);
        assert.equal(syncCalls, 0);
        assert.equal(searchCalls, 1);
        assert.match(result.content[0].text, /Found 1 results/);
    });
});

test("search_code keeps explicit limit as an override", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let requestedTopK: number | undefined;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async (_codebasePath: string, _query: string, topK: number) => {
                requestedTopK = topK;
                return [{
                    content: "function runSearch() {}",
                    relativePath: "src/search.ts",
                    startLine: 1,
                    endLine: 1,
                    language: "typescript",
                    score: 1
                }];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 4,
            totalChunks: 37,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch",
            limit: 3
        });

        assert.equal(result.isError, undefined);
        assert.equal(requestedTopK, 3);
    });
});

test("search_code validates extensionFilter before building the vector database filter", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let searchCalls = 0;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => {
                searchCalls += 1;
                return [];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch",
            extensionFilter: [".ts'] || id != '' || fileExtension in ['.js"]
        });

        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /extensionFilter/);
        assert.equal(searchCalls, 0);
    });
});

test("search_code passes validated extensionFilter as a Milvus filter expression", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let requestedFilter: string | undefined;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async (
                _codebasePath: string,
                _query: string,
                _topK: number,
                _threshold: number,
                filterExpr?: string
            ) => {
                requestedFilter = filterExpr;
                return [{
                    content: "function runSearch() {}",
                    relativePath: "src/search.ts",
                    startLine: 1,
                    endLine: 1,
                    language: "typescript",
                    score: 1
                }];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch",
            extensionFilter: [".ts", ".tsx", ".c++"]
        });

        assert.equal(result.isError, undefined);
        assert.equal(requestedFilter, "fileExtension in ['.ts', '.tsx', '.c++']");
    });
});

test("search_code validates explicit target role and optional boolean arguments", async () => {
    const handlers = createHandlers();

    const invalidRole = await handlers.handleSearchCode({
        path: "/tmp/project",
        query: "runSearch",
        targetRole: "source"
    });
    assert.equal(invalidRole.isError, true);
    assert.match(invalidRole.content[0].text, /targetRole/);

    const invalidIncludeRelated = await handlers.handleSearchCode({
        path: "/tmp/project",
        query: "runSearch",
        includeRelated: "false"
    });
    assert.equal(invalidIncludeRelated.isError, true);
    assert.match(invalidIncludeRelated.content[0].text, /includeRelated/);

    const invalidIncludeTraceEvidence = await handlers.handleSearchCode({
        path: "/tmp/project",
        query: "runSearch",
        includeTraceEvidence: "true"
    });
    assert.equal(invalidIncludeTraceEvidence.isError, true);
    assert.match(invalidIncludeTraceEvidence.content[0].text, /includeTraceEvidence/);

    const invalidSkipConsistencyCheck = await handlers.handleSearchCode({
        path: "/tmp/project",
        query: "runSearch",
        skipConsistencyCheck: "true"
    });
    assert.equal(invalidSkipConsistencyCheck.isError, true);
    assert.match(invalidSkipConsistencyCheck.content[0].text, /skipConsistencyCheck/);

    const invalidConsistency = await handlers.handleSearchCode({
        path: "/tmp/project",
        query: "runSearch",
        consistency: "fresh"
    });
    assert.equal(invalidConsistency.isError, true);
    assert.match(invalidConsistency.content[0].text, /consistency/);
});

test("search_code passes target role options and formats grouped results", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let requestedOptions: any;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async (
                _codebasePath: string,
                _query: string,
                _topK: number,
                _threshold: number,
                _filterExpr: string | undefined,
                options: any
            ) => {
                requestedOptions = options;
                return [
                    {
                        content: "export function runSearch() {}",
                        relativePath: "src/search.ts",
                        startLine: 1,
                        endLine: 1,
                        language: "typescript",
                        score: 1,
                        resultGroup: "implementation",
                        isPrimary: true,
                        scoreReasons: ["semantic_match"]
                    },
                    {
                        content: "test('runSearch', () => runSearch())",
                        relativePath: "src/search.test.ts",
                        startLine: 1,
                        endLine: 1,
                        language: "typescript",
                        score: 0.9,
                        resultGroup: "related_tests",
                        isPrimary: false,
                        scoreReasons: ["reference_match"]
                    }
                ];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 4,
            totalChunks: 37,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch",
            targetRole: "test",
            includeRelated: false
        });

        assert.equal(result.isError, undefined);
        assert.deepEqual(requestedOptions, {
            targetRole: "test",
            includeRelated: false
        });
        assert.match(result.content[0].text, /## Implementation matches/);
        assert.match(result.content[0].text, /## Related tests/);
        assert.match(result.content[0].text, /Match signals: semantic_match/);
        assert.match(result.content[0].text, /Match signals: reference_match/);
    });
});

test("search_code includes compact trace evidence when explicitly requested", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        let traceRequest: { codebasePath: string; symbol: string; options: any } | undefined;
        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [{
                content: [
                    "import { EntityManager } from './entities';",
                    "",
                    "class World {",
                    "    private readonly _entityManager: EntityManager;",
                    "    addTower(tower: TowerLike): void {",
                    "        this._entityManager.addTower(tower);",
                    "    }",
                    "}"
                ].join("\n"),
                relativePath: "src/game/world.ts",
                startLine: 1,
                endLine: 8,
                language: "typescript",
                score: 1,
                resultGroup: "implementation",
                isPrimary: true,
                scoreReasons: ["semantic_match"]
            }],
            traceSymbol: async (codebasePath: string, symbol: string, options: any) => {
                traceRequest = { codebasePath, symbol, options };
                return {
                    symbol,
                    codebasePath,
                    definitions: [{
                        kind: "definition",
                        relativePath: "src/game/entities/entityManager.ts",
                        line: 130,
                        preview: "export class EntityManager {}",
                        matchedText: "EntityManager"
                    }],
                    references: [{
                        kind: "reference",
                        relativePath: "src/game/world.ts",
                        line: 445,
                        preview: "this._entityManager.addTower(tower);",
                        matchedText: "_entityManager",
                        enclosingSymbol: "World.addTower",
                        callTarget: "EntityManager.addTower"
                    }],
                    imports: [{
                        kind: "import",
                        relativePath: "src/game/world.ts",
                        line: 1,
                        preview: "import { EntityManager } from './entities';",
                        matchedText: "EntityManager",
                        moduleSpecifier: "./entities",
                        resolvedPath: "src/game/entities/index.ts"
                    }],
                    exports: [{
                        kind: "export",
                        relativePath: "src/game/entities/index.ts",
                        line: 1,
                        preview: "export { EntityManager } from './entityManager';",
                        matchedText: "EntityManager",
                        moduleSpecifier: "./entityManager",
                        resolvedPath: "src/game/entities/entityManager.ts"
                    }],
                    relatedTests: [{
                        kind: "related_test",
                        relativePath: "src/game/entities/entityManager.test.ts",
                        line: 3,
                        preview: "expect(new EntityManager()).toBeTruthy();",
                        matchedText: "EntityManager"
                    }],
                    scannedFiles: 37,
                    truncated: false,
                    warnings: []
                };
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 4,
            totalChunks: 37,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "client entity lifecycle",
            includeTraceEvidence: true
        });

        assert.equal(result.isError, undefined);
        assert.deepEqual(traceRequest, {
            codebasePath: project,
            symbol: "EntityManager",
            options: {
                startPath: "src/game/world.ts",
                startLine: 1,
                endLine: 8,
                maxFiles: 500,
                maxReferences: 8,
                includeTests: true
            }
        });
        assert.match(result.content[0].text, /Trace evidence \(EntityManager\):/);
        assert.match(result.content[0].text, /Evidence chain: entry src\/game\/world\.ts:1-8 => import src\/game\/world\.ts:1 -> src\/game\/entities\/index\.ts => export src\/game\/entities\/index\.ts:1 -> src\/game\/entities\/entityManager\.ts => owner src\/game\/entities\/entityManager\.ts:130 EntityManager => call src\/game\/world\.ts:445 World\.addTower -> EntityManager\.addTower/);
        assert.match(result.content[0].text, /Owner definitions: src\/game\/entities\/entityManager\.ts:130/);
        assert.match(result.content[0].text, /Entry references: src\/game\/world\.ts:445/);
        assert.match(result.content[0].text, /Call chain: src\/game\/world\.ts:445 World\.addTower -> EntityManager\.addTower/);
        assert.match(result.content[0].text, /Module links: src\/game\/world\.ts:1 -> src\/game\/entities\/index\.ts; src\/game\/entities\/index\.ts:1 -> src\/game\/entities\/entityManager\.ts/);
        assert.match(result.content[0].text, /Related tests: src\/game\/entities\/entityManager\.test\.ts:3/);
    });
});

test("search_code rehydrates context from current source when line range is valid", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(path.join(project, "src"), { recursive: true });
        await writeFile(path.join(project, "src", "search.ts"), [
            "const before = true;",
            "",
            "export function runSearch() {",
            "    return before;",
            "}",
            "",
            "const after = true;"
        ].join("\n"), "utf-8");

        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [{
                content: "stale indexed chunk content",
                relativePath: "src/search.ts",
                startLine: 3,
                endLine: 5,
                language: "typescript",
                score: 1
            }]
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch",
            limit: 1
        });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Context source: current source file, lines 1-7; indexed range 3-5/);
        assert.match(result.content[0].text, /const before = true/);
        assert.match(result.content[0].text, /export function runSearch\(\)/);
        assert.match(result.content[0].text, /const after = true/);
        assert.doesNotMatch(result.content[0].text, /stale indexed chunk content/);
    });
});

test("search_code preserves distinct locations when rehydrated source windows overlap", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(path.join(project, "src"), { recursive: true });
        await writeFile(path.join(project, "src", "bridge.ts"), [
            "export class Bridge {",
            "    init(): void {}",
            "",
            "    requestFogRebuild(): void {",
            "        this.sendFog();",
            "    }",
            "",
            "    requestTerritoryRebuild(): void {",
            "        this.sendTerritory();",
            "    }",
            "",
            "    private sendFog(): void {}",
            "    private sendTerritory(): void {}",
            "}"
        ].join("\n"), "utf-8");

        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [
                {
                    content: "stale fog chunk",
                    relativePath: "src/bridge.ts",
                    startLine: 4,
                    endLine: 6,
                    language: "typescript",
                    score: 1,
                    scoreReasons: ["exact_symbol_definition"]
                },
                {
                    content: "stale territory chunk",
                    relativePath: "src/bridge.ts",
                    startLine: 8,
                    endLine: 10,
                    language: "typescript",
                    score: 0.9,
                    scoreReason: "semantic_match"
                }
            ]
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 2,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "Bridge rebuild",
            limit: 2
        });

        const text = result.content[0].text;
        assert.equal(result.isError, undefined);
        assert.match(text, /Location: src\/bridge\.ts:4-6/);
        assert.match(text, /Location: src\/bridge\.ts:8-10/);
        assert.match(text, /Context source: current source file, lines 1-10; indexed range 4-6/);
        assert.match(text, /Context source: current source file, lines 4-14; indexed range 8-10/);
        assert.match(text, /Match signals: exact_symbol_definition/);
        assert.match(text, /Match signals: semantic_match/);
        assert.doesNotMatch(text, /stale fog chunk/);
        assert.doesNotMatch(text, /stale territory chunk/);
    });
});

test("search_code reuses current source reads for repeated result paths", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        const sourcePath = path.join(project, "src", "bridge.ts");
        await mkdir(path.join(project, "src"), { recursive: true });
        await writeFile(sourcePath, [
            "export class Bridge {",
            "    init(): void {}",
            "",
            "    requestFogRebuild(): void {",
            "        this.sendFog();",
            "    }",
            "",
            "    requestTerritoryRebuild(): void {",
            "        this.sendTerritory();",
            "    }",
            "",
            "    private sendFog(): void {}",
            "    private sendTerritory(): void {}",
            "}"
        ].join("\n"), "utf-8");

        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [
                {
                    content: "stale fog chunk",
                    relativePath: "src/bridge.ts",
                    startLine: 4,
                    endLine: 6,
                    language: "typescript",
                    score: 1
                },
                {
                    content: "stale territory chunk",
                    relativePath: "src/bridge.ts",
                    startLine: 8,
                    endLine: 10,
                    language: "typescript",
                    score: 0.9
                }
            ]
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 2,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const fsModule = require("node:fs") as typeof import("node:fs");
        const originalReadFileSync = fsModule.readFileSync;
        let sourceReadCount = 0;
        fsModule.readFileSync = ((filePath: Parameters<typeof originalReadFileSync>[0], ...rest: any[]) => {
            if (path.resolve(String(filePath)) === sourcePath) {
                sourceReadCount++;
            }
            return originalReadFileSync(filePath, ...rest);
        }) as typeof originalReadFileSync;
        syncBuiltinESMExports();

        try {
            const result = await handlers.handleSearchCode({
                path: project,
                query: "Bridge rebuild",
                limit: 2
            });

            const text = result.content[0].text;
            assert.equal(result.isError, undefined);
            assert.equal(sourceReadCount, 1);
            assert.match(text, /Location: src\/bridge\.ts:4-6/);
            assert.match(text, /Location: src\/bridge\.ts:8-10/);
            assert.match(text, /Context source: current source file, lines 1-10; indexed range 4-6/);
            assert.match(text, /Context source: current source file, lines 4-14; indexed range 8-10/);
        } finally {
            fsModule.readFileSync = originalReadFileSync;
            syncBuiltinESMExports();
        }
    });
});

test("search_code formats mixed current-source and indexed-fallback results independently", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(path.join(project, "src"), { recursive: true });
        await writeFile(path.join(project, "src", "search.ts"), [
            "export function runSearch() {",
            "    return true;",
            "}"
        ].join("\n"), "utf-8");

        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [
                {
                    content: "stale indexed chunk content",
                    relativePath: "src/search.ts",
                    startLine: 1,
                    endLine: 3,
                    language: "typescript",
                    score: 1
                },
                {
                    content: "indexed fallback body",
                    relativePath: "src/missing.ts",
                    startLine: 1,
                    endLine: 3,
                    language: "typescript",
                    score: 0.8
                }
            ]
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 2,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch missing",
            limit: 2
        });

        const text = result.content[0].text;
        assert.equal(result.isError, undefined);
        assert.match(text, /Location: src\/search\.ts:1-3/);
        assert.match(text, /Context source: current source file, lines 1-3; indexed range 1-3/);
        assert.match(text, /export function runSearch\(\)/);
        assert.doesNotMatch(text, /stale indexed chunk content/);
        assert.match(text, /Location: src\/missing\.ts:1-3/);
        assert.match(text, /Warning: source rehydrate failed; using indexed chunk fallback/);
        assert.match(text, /Context source: indexed chunk fallback/);
        assert.match(text, /indexed fallback body/);
    });
});

test("search_code falls back to indexed chunk when source file is missing", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [{
                content: "indexed fallback body",
                relativePath: "src/missing.ts",
                startLine: 3,
                endLine: 5,
                language: "typescript",
                score: 1
            }]
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "missing",
            limit: 1
        });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Warning: source rehydrate failed; using indexed chunk fallback/);
        assert.match(result.content[0].text, /Context source: indexed chunk fallback/);
        assert.match(result.content[0].text, /indexed fallback body/);
    });
});

test("search_code reuses source read failures for repeated missing result paths", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        const missingSourcePath = path.join(project, "src", "missing.ts");
        await mkdir(project, { recursive: true });

        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [
                {
                    content: "first indexed fallback body",
                    relativePath: "src/missing.ts",
                    startLine: 3,
                    endLine: 5,
                    language: "typescript",
                    score: 1
                },
                {
                    content: "second indexed fallback body",
                    relativePath: "src/missing.ts",
                    startLine: 8,
                    endLine: 10,
                    language: "typescript",
                    score: 0.9
                }
            ]
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 2,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const fsModule = require("node:fs") as typeof import("node:fs");
        const originalReadFileSync = fsModule.readFileSync;
        let missingSourceReadCount = 0;
        fsModule.readFileSync = ((filePath: Parameters<typeof originalReadFileSync>[0], ...rest: any[]) => {
            if (path.resolve(String(filePath)) === missingSourcePath) {
                missingSourceReadCount++;
            }
            return originalReadFileSync(filePath, ...rest);
        }) as typeof originalReadFileSync;
        syncBuiltinESMExports();

        try {
            const result = await handlers.handleSearchCode({
                path: project,
                query: "missing",
                limit: 2
            });

            const text = result.content[0].text;
            assert.equal(result.isError, undefined);
            assert.equal(missingSourceReadCount, 1);
            assert.match(text, /Warning: source rehydrate failed; using indexed chunk fallback/);
            assert.match(text, /first indexed fallback body/);
            assert.match(text, /second indexed fallback body/);
        } finally {
            fsModule.readFileSync = originalReadFileSync;
            syncBuiltinESMExports();
        }
    });
});

test("search_code falls back to indexed chunk when indexed line range is outside current source", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(path.join(project, "src"), { recursive: true });
        await writeFile(path.join(project, "src", "short.ts"), "export const shortFile = true;", "utf-8");

        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [{
                content: "indexed out of range body",
                relativePath: "src/short.ts",
                startLine: 20,
                endLine: 25,
                language: "typescript",
                score: 1
            }]
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "short",
            limit: 1
        });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Warning: source rehydrate failed because the indexed line range is outside the current source file/);
        assert.match(result.content[0].text, /Context source: indexed chunk fallback/);
        assert.match(result.content[0].text, /indexed out of range body/);
        assert.doesNotMatch(result.content[0].text, /export const shortFile = true/);
    });
});

test("search_code refuses to rehydrate paths outside the indexed codebase", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [{
                content: "indexed escaped body",
                relativePath: "../outside.ts",
                startLine: 1,
                endLine: 1,
                language: "typescript",
                score: 1
            }]
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "outside",
            limit: 1
        });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Warning: source rehydrate skipped because the result path is outside the indexed codebase/);
        assert.match(result.content[0].text, /Context source: indexed chunk fallback/);
        assert.match(result.content[0].text, /indexed escaped body/);
    });
});

test("search_code formats unavailable line ranges as unknown", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(project, { recursive: true });

        const context = {
            getVectorDatabase: () => ({
                listCollections: async () => []
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [{
                content: "function runSearch() {}",
                relativePath: "src/search.ts",
                startLine: 0,
                endLine: 0,
                lineRangeUnavailable: true,
                lineRangeWarning: "line range unavailable; re-index this codebase to refresh line metadata.",
                language: "typescript",
                score: 1
            }]
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 4,
            totalChunks: 37,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "runSearch",
            limit: 1
        });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Location: src\/search\.ts:unknown/);
        assert.match(result.content[0].text, /Warning: line range unavailable/);
        assert.match(result.content[0].text, /Context source: indexed chunk fallback/);
        assert.match(result.content[0].text, /function runSearch\(\) \{\}/);
        assert.doesNotMatch(result.content[0].text, /Location: src\/search\.ts:0-0/);
    });
});

test("search_code marks filename-like query results as fallback when exact file is absent", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(path.join(project, "docs"), { recursive: true });
        await writeFile(path.join(project, "docs", "architecture.md"), "mentions spawnSystem.ts", "utf-8");
        const indexQueries: Array<{ filter: string; limit?: number }> = [];
        let semanticSearchOptions: any;

        const context = {
            getCollectionName: () => "test_collection",
            getVectorDatabase: () => ({
                listCollections: async () => [],
                query: async (_collectionName: string, filter: string, _outputFields: string[], limit?: number) => {
                    indexQueries.push({ filter, limit });
                    return [];
                }
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async (...args: any[]) => {
                semanticSearchOptions = args[5];
                return [{
                    content: "The old architecture mentioned spawnSystem.ts.",
                    relativePath: "docs/architecture.md",
                    startLine: 1,
                    endLine: 1,
                    language: "markdown",
                    score: 1
                }];
            }
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "spawnSystem.ts",
            limit: 1
        });

        assert.equal(result.isError, undefined);
        assert.deepEqual(indexQueries, [{
            filter: 'basename == "spawnSystem" and fileExtension == ".ts"',
            limit: 20
        }]);
        assert.deepEqual(semanticSearchOptions.filenameLikeQuery, {
            raw: "spawnSystem.ts",
            normalizedPath: "spawnSystem.ts",
            basename: "spawnSystem.ts",
            isPathLike: false
        });
        assert.match(result.content[0].text, /Exact file not found in the current index: spawnSystem\.ts/);
        assert.match(result.content[0].text, /Found 1 fallback matches/);
        assert.match(result.content[0].text, /1\. Fallback match/);
        assert.match(result.content[0].text, /not confirmation that the requested file exists/);
    });
});

test("search_code does not warn for filename-like query when exact file exists in tree and index", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(path.join(project, "src"), { recursive: true });
        await writeFile(path.join(project, "src", "existing.ts"), "export const existing = true;", "utf-8");
        const indexQueries: Array<{ filter: string; limit?: number }> = [];

        const context = {
            getCollectionName: () => "test_collection",
            getVectorDatabase: () => ({
                listCollections: async () => [],
                query: async (_collectionName: string, filter: string, _outputFields: string[], limit?: number) => {
                    indexQueries.push({ filter, limit });
                    return [{ relativePath: "src/existing.ts" }];
                }
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [{
                content: "export const existing = true;",
                relativePath: "src/existing.ts",
                startLine: 1,
                endLine: 1,
                language: "typescript",
                score: 1,
                scoreReason: "exact_filename",
                scoreReasons: ["exact_filename", "path_match"]
            }]
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "existing.ts",
            limit: 1
        });

        assert.equal(result.isError, undefined);
        assert.deepEqual(indexQueries, [{
            filter: 'basename == "existing" and fileExtension == ".ts"',
            limit: 20
        }]);
        assert.match(result.content[0].text, /Found 1 results/);
        assert.match(result.content[0].text, /1\. Source context/);
        assert.match(result.content[0].text, /Match signals: exact_filename, path_match/);
        assert.doesNotMatch(result.content[0].text, /Exact file not found/);
        assert.doesNotMatch(result.content[0].text, /fallback matches/);
    });
});

test("search_code warns when filename exact verification is unavailable on a legacy index", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(path.join(project, "src"), { recursive: true });

        const context = {
            getCollectionName: () => "test_collection",
            getVectorDatabase: () => ({
                listCollections: async () => [],
                query: async () => {
                    throw new Error("field basename not found in schema");
                }
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [{
                content: "export const maybeLegacy = true;",
                relativePath: "src/maybeLegacy.ts",
                startLine: 1,
                endLine: 1,
                language: "typescript",
                score: 1
            }]
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "maybeLegacy.ts",
            limit: 1
        });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Exact filename verification is unavailable for this index schema/);
        assert.match(result.content[0].text, /Re-index may be needed/);
        assert.match(result.content[0].text, /1\. Source context/);
    });
});

test("search_code reports possible stale index when exact file exists only in current tree", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(path.join(project, "src"), { recursive: true });
        await writeFile(path.join(project, "src", "newFile.ts"), "export const newFile = true;", "utf-8");
        const indexQueries: Array<{ filter: string; limit?: number }> = [];

        const context = {
            getCollectionName: () => "test_collection",
            getVectorDatabase: () => ({
                listCollections: async () => [],
                query: async (_collectionName: string, filter: string, _outputFields: string[], limit?: number) => {
                    indexQueries.push({ filter, limit });
                    return [];
                }
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [{
                content: "export const oldFile = true;",
                relativePath: "src/oldFile.ts",
                startLine: 1,
                endLine: 1,
                language: "typescript",
                score: 1
            }]
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "src/newFile.ts",
            limit: 1
        });

        assert.equal(result.isError, undefined);
        assert.deepEqual(indexQueries, [{
            filter: 'relativePath == "src/newFile.ts"',
            limit: 1
        }]);
        assert.match(result.content[0].text, /Exact file exists in the current file tree but is missing from the index: src\/newFile\.ts/);
        assert.match(result.content[0].text, /Re-index may be needed/);
        assert.match(result.content[0].text, /1\. Fallback match/);
    });
});

test("search_code reports possible stale index when exact path exists only in index", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(path.join(project, "src"), { recursive: true });
        const indexQueries: Array<{ filter: string; limit?: number }> = [];

        const context = {
            getCollectionName: () => "test_collection",
            getVectorDatabase: () => ({
                listCollections: async () => [],
                query: async (_collectionName: string, filter: string, _outputFields: string[], limit?: number) => {
                    indexQueries.push({ filter, limit });
                    return [{ relativePath: "src/deletedFile.ts" }];
                }
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [{
                content: "export const deletedFile = true;",
                relativePath: "src/deletedFile.ts",
                startLine: 1,
                endLine: 1,
                language: "typescript",
                score: 1
            }]
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "src/deletedFile.ts",
            limit: 1
        });

        assert.equal(result.isError, undefined);
        assert.deepEqual(indexQueries, [{
            filter: 'relativePath == "src/deletedFile.ts"',
            limit: 1
        }]);
        assert.match(result.content[0].text, /Exact file not found in the current file tree: src\/deletedFile\.ts/);
        assert.match(result.content[0].text, /index may be stale/);
        assert.match(result.content[0].text, /1\. Fallback match/);
    });
});

test("search_code reports possible stale index when exact basename exists only in index", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(path.join(project, "src"), { recursive: true });
        const indexQueries: Array<{ filter: string; limit?: number }> = [];

        const context = {
            getCollectionName: () => "test_collection",
            getVectorDatabase: () => ({
                listCollections: async () => [],
                query: async (_collectionName: string, filter: string, _outputFields: string[], limit?: number) => {
                    indexQueries.push({ filter, limit });
                    return [{ relativePath: "src/deletedFile.ts" }];
                }
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [{
                content: "export const deletedFile = true;",
                relativePath: "src/deletedFile.ts",
                startLine: 1,
                endLine: 1,
                language: "typescript",
                score: 1
            }]
        } as any;
        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshotManager);

        const result = await handlers.handleSearchCode({
            path: project,
            query: "deletedFile.ts",
            limit: 1
        });

        assert.equal(result.isError, undefined);
        assert.deepEqual(indexQueries, [{
            filter: 'basename == "deletedFile" and fileExtension == ".ts"',
            limit: 20
        }]);
        assert.match(result.content[0].text, /Exact file not found in the current file tree: deletedFile\.ts/);
        assert.match(result.content[0].text, /index may be stale/);
        assert.match(result.content[0].text, /1\. Fallback match/);
    });
});

test("clear_index rejects absent argument object before path resolution", async () => {
    const handlers = createHandlers();

    const result = await handlers.handleClearIndex(undefined);

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /clear_index/);
    assert.match(result.content[0].text, /argument object/);
});

test("get_indexing_status rejects blank path before status lookup", async () => {
    const handlers = createHandlers();

    const result = await handlers.handleGetIndexingStatus({ path: " " });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /get_indexing_status/);
    assert.match(result.content[0].text, /'path'/);
});
