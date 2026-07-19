import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    COLLECTION_REAPER_UNIT_NAME,
    getCollectionReaperUnitContent,
    installCollectionReaperUserService,
} from "./systemd-user-service.js";

test("installs the user reaper unit and enables it without credentials", () => {
    const configDir = mkdtempSync(join(tmpdir(), "hce-systemd-user-test-"));
    const calls: string[][] = [];
    try {
        const result = installCollectionReaperUserService({
            configDir,
            runSystemctl: (args) => {
                calls.push(args);
                return { status: 0 };
            },
        });

        assert.equal(result.changed, true);
        assert.match(result.path, new RegExp(`${COLLECTION_REAPER_UNIT_NAME.replace(".", "\\.")}$`));
        assert.equal(readFileSync(result.path, "utf-8"), getCollectionReaperUnitContent());
        assert.match(readFileSync(result.path, "utf-8"), /ExecStart=hce collection-reaper/);
        assert.doesNotMatch(readFileSync(result.path, "utf-8"), /milvusToken|token|apiKey/i);
        assert.deepEqual(calls, [
            ["--user", "daemon-reload"],
            ["--user", "enable", "--now", COLLECTION_REAPER_UNIT_NAME],
        ]);

        const second = installCollectionReaperUserService({
            configDir,
            runSystemctl: () => ({ status: 0 }),
        });
        assert.equal(second.changed, false);
    } finally {
        rmSync(configDir, { recursive: true, force: true });
    }
});

test("reports systemctl failures after writing the unit", () => {
    const configDir = mkdtempSync(join(tmpdir(), "hce-systemd-user-test-"));
    try {
        assert.throws(
            () => installCollectionReaperUserService({
                configDir,
                runSystemctl: () => ({ status: 1, stderr: "user manager is unavailable" }),
            }),
            /systemctl --user daemon-reload failed: user manager is unavailable/,
        );
    } finally {
        rmSync(configDir, { recursive: true, force: true });
    }
});
