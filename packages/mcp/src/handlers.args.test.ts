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

test("search_code rejects missing query before search handling", async () => {
    const handlers = createHandlers();

    const result = await handlers.handleSearchCode({ path: "/tmp/project" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /search_code/);
    assert.match(result.content[0].text, /'query'/);
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
