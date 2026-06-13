import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

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
    await writeFile(path.join(configDir, "config.jsonc"), JSON.stringify(config), "utf-8");
}

test("index_codebase rejects missing path before path resolution", async () => {
    const handlers = createHandlers();

    const result = await handlers.handleIndexCodebase({});

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /index_codebase/);
    assert.match(result.content[0].text, /'path'/);
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
        assert.match(text, /Score reason: exact_symbol_definition/);
        assert.match(text, /Score reason: semantic_match/);
        assert.doesNotMatch(text, /stale fog chunk/);
        assert.doesNotMatch(text, /stale territory chunk/);
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

        const context = {
            getCollectionName: () => "test_collection",
            getVectorDatabase: () => ({
                listCollections: async () => [],
                query: async () => [{ relativePath: "docs/architecture.md" }]
            }),
            getEmbedding: () => ({
                getProvider: () => "test"
            }),
            semanticSearch: async () => [{
                content: "The old architecture mentioned spawnSystem.ts.",
                relativePath: "docs/architecture.md",
                startLine: 1,
                endLine: 1,
                language: "markdown",
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
            query: "spawnSystem.ts",
            limit: 1
        });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Exact file not found: spawnSystem\.ts/);
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

        const context = {
            getCollectionName: () => "test_collection",
            getVectorDatabase: () => ({
                listCollections: async () => [],
                query: async () => [{ relativePath: "src/existing.ts" }]
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
        assert.match(result.content[0].text, /Found 1 results/);
        assert.match(result.content[0].text, /1\. Source context/);
        assert.match(result.content[0].text, /Score reason: exact_filename, path_match/);
        assert.doesNotMatch(result.content[0].text, /Exact file not found/);
        assert.doesNotMatch(result.content[0].text, /fallback matches/);
    });
});

test("search_code reports possible stale index when exact file exists only in current tree", async () => {
    await withTempDir(async (tempRoot) => {
        const project = path.join(tempRoot, "repo");
        await mkdir(path.join(project, "src"), { recursive: true });
        await writeFile(path.join(project, "src", "newFile.ts"), "export const newFile = true;", "utf-8");

        const context = {
            getCollectionName: () => "test_collection",
            getVectorDatabase: () => ({
                listCollections: async () => [],
                query: async () => []
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
            query: "newFile.ts",
            limit: 1
        });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Exact file exists in the current file tree but is missing from the index: newFile\.ts/);
        assert.match(result.content[0].text, /Re-index may be needed/);
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
