import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeCodebaseIdentityPath } from "@hitmux/hitmux-context-engine-core";
import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

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

test("get_indexing_status syncs cloud state before reading the snapshot", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "not_found");

        const handlers = new ToolHandlers({} as any, snapshotManager);
        let syncCalls = 0;
        (handlers as any).syncIndexedCodebasesFromCloud = async () => {
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

test("get_indexing_status does not let cloud recovery mark active indexing as completed", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexing(codebasePath, 42);
        snapshotManager.saveCodebaseSnapshot();

        let rowCountQueries = 0;
        const collectionName = "code_chunks_partial";
        const vectorDb = {
            listCollections: async () => [collectionName],
            getCollectionDescription: async () => `codebasePath:${codebasePath}`,
            getCollectionRowCount: async () => {
                rowCountQueries += 1;
                return 64;
            },
        };
        const context = {
            getVectorDatabase: () => vectorDb,
            getCollectionName: () => collectionName,
        };

        const handlers = new ToolHandlers(context as any, snapshotManager);
        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(rowCountQueries, 0);
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /currently being indexed/);
        assert.match(result.content[0].text, /42\.0%/);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexing");
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
        (handlers as any).syncIndexedCodebasesFromCloud = async () => {};

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
        (handlers as any).syncIndexedCodebasesFromCloud = async () => {};

        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /2 files, 4300 chunks/);
        assert.doesNotMatch(result.content[0].text, /4300 files, 4300 chunks/);
    });
});

test("cloud recovery counts distinct relative paths for indexed file count", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        const collectionName = "code_chunks_recovered";
        const vectorDb = {
            listCollections: async () => [collectionName],
            getCollectionDescription: async () => `codebasePath:${codebasePath}`,
            getCollectionRowCount: async () => 4,
            query: async () => [
                { relativePath: "src/a.ts" },
                { relativePath: "src/a.ts" },
                { relativePath: "src/b.ts" },
                { relativePath: "src/c.ts" },
            ],
        };
        const context = {
            getVectorDatabase: () => vectorDb,
            getCollectionName: () => collectionName,
        };

        const handlers = new ToolHandlers(context as any, snapshotManager);
        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /3 files, 4 chunks/);
        assert.doesNotMatch(result.content[0].text, /4 files, 4 chunks/);
    });
});
