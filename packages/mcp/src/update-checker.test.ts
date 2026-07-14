import assert from "node:assert/strict";
import test from "node:test";

import {
    compareVersions,
    fetchLatestVersion,
    formatUpdateNotice,
    UpdateChecker,
} from "./update-checker.js";

test("compareVersions compares semantic version numbers", () => {
    assert.equal(compareVersions("0.1.21", "0.1.20"), 1);
    assert.equal(compareVersions("0.1.20", "0.1.21"), -1);
    assert.equal(compareVersions("0.1.20", "0.1.20"), 0);
    assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
});

test("compareVersions follows SemVer prerelease precedence", () => {
    assert.equal(compareVersions("1.0.0", "1.0.0-beta"), 1);
    assert.equal(compareVersions("1.0.0-beta", "1.0.0-beta.1"), -1);
    assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.11"), -1);
    assert.equal(compareVersions("1.0.0-beta.1", "1.0.0-beta.alpha"), -1);
    assert.equal(compareVersions("v1.0.0+build.42", "1.0.0"), 0);
});

test("formatUpdateNotice directs users to their installed CLI package", () => {
    assert.equal(
        formatUpdateNotice({
            packageName: "@hitmux/hitmux-context-engine-mcp",
            currentVersion: "0.1.20",
            latestVersion: "0.1.21",
        }),
        "Update available: @hitmux/hitmux-context-engine-mcp 0.1.20 -> 0.1.21. Update the globally installed package that provides the hce command (for example, npm update -g @hitmux/hce) or use the latest npx package.",
    );
});

test("fetchLatestVersion reads npm latest dist tag", async () => {
    const latestVersion = await fetchLatestVersion({
        packageName: "@hitmux/hitmux-context-engine-mcp",
        currentVersion: "0.1.20",
        registryUrl: "https://registry.example.test",
        fetch: async (url) => {
            assert.equal(
                String(url),
                "https://registry.example.test/%40hitmux%2Fhitmux-context-engine-mcp",
            );
            return new Response(
                JSON.stringify({
                    "dist-tags": {
                        latest: "0.1.21",
                    },
                }),
                { status: 200 },
            );
        },
    });

    assert.equal(latestVersion, "0.1.21");
});

test("UpdateChecker returns one notice only when a newer version is available", async () => {
    const checker = new UpdateChecker({
        packageName: "@hitmux/hitmux-context-engine-mcp",
        currentVersion: "0.1.20",
        fetch: async () =>
            new Response(
                JSON.stringify({
                    "dist-tags": {
                        latest: "0.1.21",
                    },
                }),
                { status: 200 },
            ),
    });

    checker.start();
    assert.equal(checker.consumeNotice(), null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(
        checker.consumeNotice(),
        formatUpdateNotice({
            packageName: "@hitmux/hitmux-context-engine-mcp",
            currentVersion: "0.1.20",
            latestVersion: "0.1.21",
        }),
    );
    assert.equal(checker.consumeNotice(), null);
});
