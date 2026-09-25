import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), "hitmux-continuation-handler-"));
    const home = path.join(root, "home");
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    await mkdir(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
        await run(root);
    } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (originalUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = originalUserProfile;
        await rm(root, { recursive: true, force: true });
    }
}

function fingerprint(relativePath: string, startLine: number, endLine: number, content: string): string {
    return crypto.createHash("sha1").update(`${relativePath}\n${startLine}\n${endLine}\n${content}`).digest("hex");
}

test("continuation fetches accepted chunks by id without starting another semantic search", async () => {
    await withTempDir(async (root) => {
        const project = path.join(root, "project");
        await mkdir(project, { recursive: true });
        const candidates = Array.from({ length: 15 }, (_, index) => {
            const id = `chunk-${index}`;
            const relativePath = `src/candidate-${index}.ts`;
            const content = `export const candidate${index} = true;`;
            return {
                id,
                relativePath,
                startLine: index + 1,
                endLine: index + 1,
                content,
                language: "typescript",
                score: 0.99 - index * 0.01,
                contentFingerprint: fingerprint(relativePath, index + 1, index + 1, content),
                rank: index + 1,
            };
        });
        let semanticSearchCalls = 0;
        let queryCalls = 0;
        const context = {
            getCollectionName: () => "test_collection",
            getEmbedding: () => ({ getProvider: () => "test" }),
            getVectorDatabase: () => ({
                query: async (_collection: string, filter: string) => {
                    queryCalls++;
                    const ids = [...filter.matchAll(/"([^"]+)"/g)].map(match => match[1]);
                    return candidates
                        .filter(candidate => ids.includes(candidate.id))
                        .map(candidate => ({
                            id: candidate.id,
                            content: candidate.content,
                            relativePath: candidate.relativePath,
                            startLine: candidate.startLine,
                            endLine: candidate.endLine,
                            fileExtension: ".ts",
                            metadata: JSON.stringify({ language: candidate.language }),
                        }));
                },
            }),
            semanticSearch: async (_path: string, _query: string, _limit: number, _threshold: number, _filter: unknown, options: any) => {
                semanticSearchCalls++;
                options.autoTopK.onDecision({
                    selectedResults: 12,
                    acceptedResults: 15,
                    minResults: 0,
                    maxResults: 12,
                    availableResults: 15,
                    candidateWindow: 100,
                    returnCap: 12,
                    truncated: true,
                    signal: "rerank",
                    reason: "calibrated_threshold",
                });
                options.autoTopK.onCandidateManifest({
                    candidates,
                    acceptedCount: 15,
                    returnedCount: 12,
                    candidateWindow: 100,
                    returnCap: 12,
                    truncated: true,
                });
                return candidates.slice(0, 12).map(candidate => ({
                    id: candidate.id,
                    content: candidate.content,
                    relativePath: candidate.relativePath,
                    startLine: candidate.startLine,
                    endLine: candidate.endLine,
                    language: candidate.language,
                    score: candidate.score,
                }));
            },
        } as any;
        const snapshot = new SnapshotManager();
        snapshot.setCodebaseIndexed(project, {
            indexedFiles: 1,
            totalChunks: candidates.length,
            status: "completed",
        });
        snapshot.saveCodebaseSnapshot();
        const handlers = new ToolHandlers(context, snapshot);

        const first = await handlers.handleSearchContext({ path: project, query: "candidate" });
        const token = first.structuredContent?.pagination?.continuationToken;
        assert.equal(typeof token, "string");
        assert.doesNotMatch(first.content[0].text, /continuationToken=/);
        assert.match(first.content[0].text, /More results are available/);
        assert.equal(semanticSearchCalls, 1);

        const mismatch = await handlers.handleSearchContext({
            path: project,
            query: "candidate",
            scope: "docs",
            continuationToken: token,
        });
        assert.equal(mismatch.isError, true);
        assert.match(mismatch.content[0].text, /search options/);
        assert.equal(queryCalls, 0);

        const second = await handlers.handleSearchContext({
            path: project,
            query: "candidate",
            continuationToken: token,
        });
        assert.equal(semanticSearchCalls, 1);
        assert.equal(queryCalls, 1);
        assert.equal(second.structuredContent?.pagination?.acceptedCount, 15);
        assert.equal(second.structuredContent?.pagination?.returnedCount, 3);
        assert.match(second.content[0].text, /candidate12/);
        assert.match(second.content[0].text, /candidate14/);
        assert.doesNotMatch(second.content[0].text, /continuationToken=/);
    });
});
