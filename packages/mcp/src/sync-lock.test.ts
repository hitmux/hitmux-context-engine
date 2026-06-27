import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    acquireMcpWriterLock,
    formatMcpWriterLockBusyMessage,
    getMcpWriterLockPath,
} from "./sync-lock.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hitmux-context-engine-mcp-lock-"));
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

async function writeOwner(
    lockPath: string,
    pid: number,
    options: { label?: string; acquiredAt?: string; heartbeatAt?: string } = {},
): Promise<void> {
    await mkdir(lockPath, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify({
            pid,
            token: `token-${pid}`,
            acquiredAt: options.acquiredAt ?? now,
            heartbeatAt: options.heartbeatAt ?? now,
            label: options.label ?? "existing writer"
        }),
        "utf8",
    );
}

test("writer lock immediately reclaims a lock owned by a dead local process", async () => {
    await withTempHome(async () => {
        const lockPath = getMcpWriterLockPath();
        await writeOwner(lockPath, 2147483647);

        const lock = acquireMcpWriterLock("new writer");

        assert.ok(lock);
        lock.release();
    });
});

test("writer lock does not reclaim a lock owned by the current live process", async () => {
    await withTempHome(async () => {
        const lockPath = getMcpWriterLockPath();
        await writeOwner(lockPath, process.pid);

        const lock = acquireMcpWriterLock("blocked writer");

        assert.equal(lock, null);
    });
});

test("writer lock does not reclaim stale heartbeat while owner pid is still alive", async () => {
    await withTempHome(async () => {
        const lockPath = getMcpWriterLockPath();
        const oldTimestamp = new Date(Date.now() - 11 * 60_000).toISOString();
        await writeOwner(lockPath, process.pid, {
            acquiredAt: oldTimestamp,
            heartbeatAt: oldTimestamp,
        });

        const lock = acquireMcpWriterLock("blocked writer");

        assert.equal(lock, null);
    });
});

test("writer lock busy message includes owner and lock path details", async () => {
    await withTempHome(async () => {
        const scope = { kind: "collection" as const, collectionName: "code_chunks_repo" };
        const lockPath = getMcpWriterLockPath(scope);
        await writeOwner(lockPath, process.pid, { label: "index_codebase for '/repo'" });

        const message = formatMcpWriterLockBusyMessage("clear_index", scope);

        assert.match(message, /collection 'code_chunks_repo'/);
        assert.match(message, /Current owner: index_codebase for '\/repo'/);
        assert.match(message, new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(message, /pid:/);
        assert.match(message, /heartbeatAt:/);
    });
});
