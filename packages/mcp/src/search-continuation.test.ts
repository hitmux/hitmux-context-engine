import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    createSearchContinuationToken,
    getSearchContinuationSecretPath,
    hashSearchOptions,
    verifySearchContinuationToken,
} from "./search-continuation.js";

async function withTempHome(run: () => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hitmux-continuation-test-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempRoot;
    process.env.USERPROFILE = tempRoot;
    try {
        await run();
    } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (originalUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = originalUserProfile;
        await rm(tempRoot, { recursive: true, force: true });
    }
}

function payload(expiresAt?: number) {
    return {
        codebasePath: "/repo",
        query: "query",
        optionsHash: hashSearchOptions({ scope: "all" }),
        collectionName: "collection",
        indexFingerprint: "fingerprint",
        offset: 12,
        pageSize: 12,
        candidates: [{
            id: "chunk-1",
            relativePath: "src/a.ts",
            startLine: 1,
            endLine: 2,
            contentFingerprint: "content",
            rank: 1,
            score: 0.9,
        }],
        ...(expiresAt === undefined ? {} : { expiresAt }),
    };
}

test("search continuation token round-trips with a shared 0600 secret", async () => {
    await withTempHome(async () => {
        const token = createSearchContinuationToken(payload());
        const verified = verifySearchContinuationToken(token);

        assert.equal(verified.codebasePath, "/repo");
        assert.equal(verified.candidates[0]?.id, "chunk-1");
        assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        const secretStat = await stat(getSearchContinuationSecretPath());
        assert.equal(secretStat.mode & 0o777, 0o600);
        assert.deepEqual(verifySearchContinuationToken(token), verified);
    });
});

test("search continuation token rejects tampering and expiry", async () => {
    await withTempHome(async () => {
        const token = createSearchContinuationToken(payload());
        assert.throws(() => verifySearchContinuationToken(`${token}x`), /Invalid continuation token/);

        const expired = createSearchContinuationToken(payload(Date.now() - 1));
        assert.throws(() => verifySearchContinuationToken(expired), /expired/);
    });
});
