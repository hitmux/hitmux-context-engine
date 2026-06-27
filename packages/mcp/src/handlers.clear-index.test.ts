import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Context, FileSynchronizer, normalizeCodebaseIdentityPath, type VectorDatabase } from "@hitmux/hitmux-context-engine-core";
import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";
import { getMcpWriterLockPath } from "./sync-lock.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hitmux-context-engine-mcp-clear-"));
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

function createContextStub(options: { hasIndex?: boolean; getCollectionName?: (codebasePath: string) => string } = {}) {
    const clearedPaths: string[] = [];
    let hasIndexCalls = 0;

    return {
        context: {
            getCollectionName: (codebasePath: string) =>
                options.getCollectionName?.(codebasePath) ?? `collection_${codebasePath.replace(/[^A-Za-z0-9]/g, "_")}`,
            hasIndex: async () => {
                hasIndexCalls += 1;
                return options.hasIndex ?? false;
            },
            clearIndex: async (codebasePath: string) => {
                clearedPaths.push(codebasePath);
            }
        } as any,
        clearedPaths,
        getHasIndexCalls: () => hasIndexCalls
    };
}

function getMerkleSnapshotPath(tempRoot: string, codebasePath: string): string {
    const normalizedPath = normalizeCodebaseIdentityPath(codebasePath);
    const hash = crypto.createHash("md5").update(normalizedPath).digest("hex");
    return path.join(tempRoot, "home", ".hitmux-context-engine", "merkle", `${hash}.json`);
}

test("clear_index clears snapshot-known codebase after the local directory is deleted", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 2,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        await rm(codebasePath, { recursive: true, force: true });

        const contextStub = createContextStub();
        const handlers = new ToolHandlers(contextStub.context, snapshotManager);

        const result = await handlers.handleClearIndex({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Successfully cleared codebase/);
        assert.deepEqual(contextStub.clearedPaths, [codebasePath]);
        assert.equal(contextStub.getHasIndexCalls(), 0);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "not_found");
    });
});

test("clear_index clears collection-known codebase after snapshot state is missing", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        const snapshotManager = new SnapshotManager();
        const contextStub = createContextStub({ hasIndex: true });
        const handlers = new ToolHandlers(contextStub.context, snapshotManager);

        const result = await handlers.handleClearIndex({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Successfully cleared codebase/);
        assert.deepEqual(contextStub.clearedPaths, [codebasePath]);
        assert.equal(contextStub.getHasIndexCalls(), 1);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "not_found");
    });
});

test("clear_index refuses to clear while another writer holds the index lock", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 2,
            status: "completed"
        });
        snapshotManager.saveCodebaseSnapshot();

        const contextStub = createContextStub();
        const collectionName = contextStub.context.getCollectionName(codebasePath);
        const lockPath = getMcpWriterLockPath({ kind: "collection", collectionName });
        await mkdir(lockPath, { recursive: true });
        const handlers = new ToolHandlers(contextStub.context, snapshotManager);

        const result = await handlers.handleClearIndex({ path: codebasePath });

        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /already writing index state for collection/);
        assert.match(result.content[0].text, new RegExp(collectionName));
        assert.deepEqual(contextStub.clearedPaths, []);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexed");
    });
});

test("clear_index marks cancelled local indexing failed when collection lock is taken before clear", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexing(codebasePath, 25);
        snapshotManager.saveCodebaseSnapshot();

        const contextStub = createContextStub();
        const collectionName = contextStub.context.getCollectionName(codebasePath);
        const lockPath = getMcpWriterLockPath({ kind: "collection", collectionName });
        const handlers = new ToolHandlers(contextStub.context, snapshotManager);

        const controller = new AbortController();
        const promise = new Promise<void>((resolve, reject) => {
            controller.signal.addEventListener("abort", () => {
                mkdir(lockPath, { recursive: true }).then(resolve, reject);
            }, { once: true });
        });
        (handlers as any).indexingTasks.set(codebasePath, { controller, promise });

        const result = await handlers.handleClearIndex({ path: codebasePath });

        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /already writing index state for collection/);
        assert.deepEqual(contextStub.clearedPaths, []);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexfailed");
    });
});

test("clear_index removes all snapshot entries that share the dropped collection", async () => {
    await withTempHome(async (tempRoot) => {
        const firstPath = path.join(tempRoot, "repo-a");
        const secondPath = path.join(tempRoot, "repo-b");
        await mkdir(firstPath, { recursive: true });
        await mkdir(secondPath, { recursive: true });
        await writeFile(path.join(secondPath, "index.ts"), "export const value = 1;\n", "utf-8");

        const secondSynchronizer = new FileSynchronizer(secondPath, [], [".ts"]);
        await secondSynchronizer.initialize();
        await secondSynchronizer.checkForChanges();
        await writeFile(path.join(secondPath, "index.ts"), "export const value = 2;\n", "utf-8");

        const snapshotManager = new SnapshotManager();
        for (const codebasePath of [firstPath, secondPath]) {
            snapshotManager.setCodebaseIndexed(codebasePath, {
                indexedFiles: 1,
                totalChunks: 2,
                status: "completed"
            });
        }
        snapshotManager.saveCodebaseSnapshot();

        const contextStub = createContextStub({
            getCollectionName: () => "hybrid_code_chunks_shared"
        });
        const handlers = new ToolHandlers(contextStub.context, snapshotManager);

        const result = await handlers.handleClearIndex({ path: firstPath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Successfully cleared codebase/);
        assert.deepEqual(contextStub.clearedPaths, [firstPath]);
        assert.equal(snapshotManager.getCodebaseStatus(firstPath), "not_found");
        assert.equal(snapshotManager.getCodebaseStatus(secondPath), "not_found");
        assert.deepEqual(snapshotManager.getIndexedCodebases(), []);

        const reloadedSynchronizer = new FileSynchronizer(secondPath, [], [".ts"]);
        await reloadedSynchronizer.initialize();
        await assert.doesNotReject(async () => {
            const changes = await reloadedSynchronizer.checkChangedPaths(["index.ts"]);
            assert.deepEqual(changes.modified, []);
        });
    });
});

test("clear_index deletes remote manifests for all tracked paths sharing the dropped collection", async () => {
    await withTempHome(async (tempRoot) => {
        const firstPath = path.join(tempRoot, "repo-a");
        const secondPath = path.join(tempRoot, "repo-b");
        await mkdir(firstPath, { recursive: true });
        await mkdir(secondPath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        for (const codebasePath of [firstPath, secondPath]) {
            snapshotManager.setCodebaseIndexed(codebasePath, {
                indexedFiles: 1,
                totalChunks: 2,
                status: "completed"
            });
        }
        snapshotManager.saveCodebaseSnapshot();

        const deletedManifests: Array<{ collectionName: string; codebasePath: string }> = [];
        const collectionName = "hybrid_code_chunks_shared";
        const context = {
            getCollectionName: () => collectionName,
            hasIndex: async () => false,
            clearIndex: async () => undefined,
            getVectorDatabase: () => ({
                deleteIndexManifest: async (requestedCollection: string, codebasePath: string) => {
                    deletedManifests.push({ collectionName: requestedCollection, codebasePath });
                }
            })
        };
        const handlers = new ToolHandlers(context as any, snapshotManager);

        const result = await handlers.handleClearIndex({ path: firstPath });

        assert.equal(result.isError, undefined);
        assert.deepEqual(
            deletedManifests.sort((a, b) => a.codebasePath.localeCompare(b.codebasePath)),
            [
                { collectionName, codebasePath: firstPath },
                { collectionName, codebasePath: secondPath }
            ].sort((a, b) => a.codebasePath.localeCompare(b.codebasePath))
        );
        assert.deepEqual(snapshotManager.getIndexedCodebases(), []);
    });
});

test("clear_index removes shared snapshot entries even when sibling Merkle cleanup fails", async () => {
    await withTempHome(async (tempRoot) => {
        const firstPath = path.join(tempRoot, "repo-a");
        const secondPath = path.join(tempRoot, "repo-b");
        await mkdir(firstPath, { recursive: true });
        await mkdir(secondPath, { recursive: true });
        await mkdir(getMerkleSnapshotPath(tempRoot, secondPath), { recursive: true });

        const snapshotManager = new SnapshotManager();
        for (const codebasePath of [firstPath, secondPath]) {
            snapshotManager.setCodebaseIndexed(codebasePath, {
                indexedFiles: 1,
                totalChunks: 2,
                status: "completed"
            });
        }
        snapshotManager.saveCodebaseSnapshot();

        const contextStub = createContextStub({
            getCollectionName: () => "hybrid_code_chunks_shared"
        });
        const handlers = new ToolHandlers(contextStub.context, snapshotManager);

        const result = await handlers.handleClearIndex({ path: firstPath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Warning: Failed to delete Merkle snapshot/);
        assert.equal(snapshotManager.getCodebaseStatus(firstPath), "not_found");
        assert.equal(snapshotManager.getCodebaseStatus(secondPath), "not_found");
        assert.deepEqual(snapshotManager.getIndexedCodebases(), []);
    });
});

for (const identityCase of [
    {
        name: "global",
        collectionIdentity: { mode: "global" as const, globalName: "team-kb" }
    },
    {
        name: "custom",
        collectionIdentity: { mode: "custom" as const, customIdentity: "team-kb" }
    }
]) {
    test(`clear_index removes all snapshot entries sharing a real ${identityCase.name} identity collection`, async () => {
        await withTempHome(async (tempRoot) => {
            const firstPath = path.join(tempRoot, "repo-a");
            const secondPath = path.join(tempRoot, "repo-b");
            await mkdir(firstPath, { recursive: true });
            await mkdir(secondPath, { recursive: true });

            const contextForIdentity = new Context({
                vectorDatabase: {} as VectorDatabase,
                collectionIdentity: identityCase.collectionIdentity
            });
            const firstCollection = contextForIdentity.getCollectionName(firstPath);
            assert.equal(firstCollection, contextForIdentity.getCollectionName(secondPath));

            const snapshotManager = new SnapshotManager();
            for (const codebasePath of [firstPath, secondPath]) {
                snapshotManager.setCodebaseIndexed(codebasePath, {
                    indexedFiles: 1,
                    totalChunks: 2,
                    status: "completed"
                });
            }
            snapshotManager.saveCodebaseSnapshot();

            const contextStub = createContextStub({
                getCollectionName: (codebasePath) => contextForIdentity.getCollectionName(codebasePath)
            });
            const handlers = new ToolHandlers(contextStub.context, snapshotManager);

            const result = await handlers.handleClearIndex({ path: firstPath });

            assert.equal(result.isError, undefined);
            assert.deepEqual(contextStub.clearedPaths, [firstPath]);
            assert.equal(snapshotManager.getCodebaseStatus(firstPath), "not_found");
            assert.equal(snapshotManager.getCodebaseStatus(secondPath), "not_found");
            assert.deepEqual(snapshotManager.getIndexedCodebases(), []);
        });
    });
}
