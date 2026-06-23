import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeCodebaseIdentityPath } from "@hitmux/hitmux-context-engine-core";
import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hitmux-context-engine-mcp-index-"));
    const homeDir = path.join(tempRoot, "home");

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

function getMerkleSnapshotPath(tempRoot: string, codebasePath: string): string {
    const normalizedPath = normalizeCodebaseIdentityPath(codebasePath);
    const hash = crypto.createHash("md5").update(normalizedPath).digest("hex");
    return path.join(tempRoot, "home", ".hitmux-context-engine", "merkle", `${hash}.json`);
}

test("parallel index_codebase calls for the same path start only one background job", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        const vectorDb = {
            checkCollectionLimit: async () => true
        };
        const context = {
            hasIndex: async () => false,
            clearIndex: async () => undefined,
            getVectorDatabase: () => vectorDb
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager);

        let backgroundStarts = 0;
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
        (handlers as any).startBackgroundIndexing = async () => {
            backgroundStarts += 1;
            await new Promise((resolve) => setTimeout(resolve, 25));
        };

        const [first, second] = await Promise.all([
            handlers.handleIndexCodebase({ path: codebasePath }),
            handlers.handleIndexCodebase({ path: codebasePath })
        ]);

        assert.equal(backgroundStarts, 1);
        assert.equal(first.isError, undefined);
        assert.equal(second.isError, true);
        assert.match(second.content[0].text, /already writing index state for collection/);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexing");
    });
});

test("parallel index_codebase calls for different collections can both start", async () => {
    await withTempHome(async (tempRoot) => {
        const firstCodebasePath = path.join(tempRoot, "repo-a");
        const secondCodebasePath = path.join(tempRoot, "repo-b");
        await mkdir(firstCodebasePath, { recursive: true });
        await mkdir(secondCodebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        const vectorDb = {
            checkCollectionLimit: async () => true
        };
        const context = {
            hasIndex: async () => false,
            clearIndex: async () => undefined,
            getVectorDatabase: () => vectorDb,
            getCollectionName: (codebasePath: string) =>
                `collection_${path.basename(codebasePath)}`
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager);

        const backgroundStarts: string[] = [];
        let releaseBackground!: () => void;
        const backgroundGate = new Promise<void>((resolve) => {
            releaseBackground = resolve;
        });
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
        (handlers as any).startBackgroundIndexing = async (codebasePath: string) => {
            backgroundStarts.push(codebasePath);
            await backgroundGate;
        };

        const [first, second] = await Promise.all([
            handlers.handleIndexCodebase({ path: firstCodebasePath }),
            handlers.handleIndexCodebase({ path: secondCodebasePath })
        ]);
        releaseBackground();

        assert.equal(first.isError, undefined);
        assert.equal(second.isError, undefined);
        assert.deepEqual(
            new Set(backgroundStarts),
            new Set([firstCodebasePath, secondCodebasePath])
        );
    });
});

test("parallel index_codebase calls for different paths in the same collection start only one background job", async () => {
    await withTempHome(async (tempRoot) => {
        const firstCodebasePath = path.join(tempRoot, "repo-a");
        const secondCodebasePath = path.join(tempRoot, "repo-b");
        await mkdir(firstCodebasePath, { recursive: true });
        await mkdir(secondCodebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        const vectorDb = {
            checkCollectionLimit: async () => true
        };
        const context = {
            hasIndex: async () => false,
            clearIndex: async () => undefined,
            getVectorDatabase: () => vectorDb,
            getCollectionName: () => "shared_collection"
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager);

        const backgroundStarts: string[] = [];
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
        (handlers as any).startBackgroundIndexing = async (codebasePath: string) => {
            backgroundStarts.push(codebasePath);
            await new Promise((resolve) => setTimeout(resolve, 25));
        };

        const results = await Promise.all([
            handlers.handleIndexCodebase({ path: firstCodebasePath }),
            handlers.handleIndexCodebase({ path: secondCodebasePath })
        ]);
        const errorResults = results.filter((result) => result.isError === true);

        assert.equal(backgroundStarts.length, 1);
        assert.equal(errorResults.length, 1);
        assert.match(errorResults[0].content[0].text, /already writing index state for collection/);
        assert.match(errorResults[0].content[0].text, /shared_collection/);
    });
});

test("background full indexing does not write a Merkle baseline before a successful core index", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });
        await writeFile(path.join(codebasePath, "index.ts"), "export const value = 1;\n", "utf-8");

        const snapshotManager = new SnapshotManager();
        const context = {
            getEffectiveIgnorePatterns: async () => [],
            getEmbedding: () => ({
                getProvider: () => "test",
                getDimension: () => 3
            }),
            indexCodebase: async () => {
                throw new Error("index backend failed");
            }
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager);

        await (handlers as any).startBackgroundIndexing(codebasePath, false, "ast");

        await assert.rejects(
            access(getMerkleSnapshotPath(tempRoot, codebasePath)),
            { code: "ENOENT" }
        );
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexfailed");
    });
});

test("forced index_codebase clears existing collection state even when hasIndex is false", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        const vectorDb = {
            checkCollectionLimit: async () => true
        };
        let clearCalls = 0;
        const context = {
            hasIndex: async () => false,
            clearIndex: async (targetPath: string) => {
                assert.equal(targetPath, codebasePath);
                clearCalls += 1;
            },
            getVectorDatabase: () => vectorDb
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager);

        let backgroundStarts = 0;
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
        (handlers as any).startBackgroundIndexing = async () => {
            backgroundStarts += 1;
        };

        const result = await handlers.handleIndexCodebase({ path: codebasePath, force: true });

        assert.equal(result.isError, undefined);
        assert.equal(clearCalls, 1);
        assert.equal(backgroundStarts, 1);
    });
});

test("parallel forced index_codebase calls do not replace an active background job", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        const vectorDb = {
            checkCollectionLimit: async () => true
        };
        const context = {
            hasIndex: async () => false,
            clearIndex: async () => undefined,
            getVectorDatabase: () => vectorDb
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager);

        let backgroundStarts = 0;
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
        (handlers as any).startBackgroundIndexing = async () => {
            backgroundStarts += 1;
            await new Promise((resolve) => setTimeout(resolve, 25));
        };

        const [first, second] = await Promise.all([
            handlers.handleIndexCodebase({ path: codebasePath, force: true }),
            handlers.handleIndexCodebase({ path: codebasePath, force: true })
        ]);

        assert.equal(backgroundStarts, 1);
        assert.equal(first.isError, undefined);
        assert.equal(second.isError, true);
        assert.match(second.content[0].text, /already writing index state for collection/);
    });
});
