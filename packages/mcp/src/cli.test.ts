import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
    runCliCommand,
    shouldStartMcpServer,
} from "./cli.js";

function createFakeRuntime(calls: Array<{ tool: string; args: unknown }>) {
    return {
        context: {},
        snapshotManager: {},
        syncManager: {},
        toolHandlers: {
            handleGetIndexingStatus: async (args: unknown) => {
                calls.push({ tool: "status", args });
                return { content: [{ type: "text", text: "status ok" }] };
            },
            handleClearIndex: async (args: unknown) => {
                calls.push({ tool: "clear", args });
                return { content: [{ type: "text", text: "clear ok" }] };
            },
            handleRepairIndexManifest: async (args: unknown) => {
                calls.push({ tool: "repair", args });
                return { content: [{ type: "text", text: "repair ok" }] };
            },
            handleSearchContext: async (args: unknown) => {
                calls.push({ tool: "search", args });
                return { content: [{ type: "text", text: "search ok" }] };
            },
        },
    } as any;
}

test("shouldStartMcpServer only returns true for no arguments", () => {
    assert.equal(shouldStartMcpServer([]), true);
    assert.equal(shouldStartMcpServer(["--help"]), false);
    assert.equal(shouldStartMcpServer(["status"]), false);
    assert.equal(shouldStartMcpServer(["unknown-command"]), false);
});

test("help and version write clean stdout without starting runtime", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    let runtimeStarted = false;

    const helpExit = await runCliCommand(["--help"], {
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
        createRuntime: () => {
            runtimeStarted = true;
            throw new Error("should not start runtime");
        },
    });
    const versionExit = await runCliCommand(["--version"], {
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
        readPackageVersion: () => "1.2.3",
        createRuntime: () => {
            runtimeStarted = true;
            throw new Error("should not start runtime");
        },
    });

    assert.equal(helpExit, 0);
    assert.equal(versionExit, 0);
    assert.equal(runtimeStarted, false);
    assert.match(output.join(""), /Usage:/);
    assert.match(output.join(""), /automatic TopK/);
    assert.match(output.join(""), /1\.2\.3/);
    assert.doesNotMatch(output.join(""), /\[LOG\]/);
    assert.equal(errors.join(""), "");
});

test("unknown command returns usage error without starting runtime", async () => {
    const errors: string[] = [];
    let runtimeStarted = false;

    const exitCode = await runCliCommand(["unknown-command"], {
        stderr: (message) => errors.push(message),
        createRuntime: () => {
            runtimeStarted = true;
            throw new Error("should not start runtime");
        },
    });

    assert.equal(exitCode, 2);
    assert.equal(runtimeStarted, false);
    assert.match(errors.join(""), /Unknown command: unknown-command/);
    assert.match(errors.join(""), /Usage:/);
});

test("init enables the collection reaper user service after creating config", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "hce-cli-init-test-"));
    const homeDir = join(tempRoot, "home");
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const output: string[] = [];
    try {
        mkdirSync(homeDir, { recursive: true });
        process.env.HOME = homeDir;
        process.env.USERPROFILE = homeDir;
        const exitCode = await runCliCommand(["init"], {
            stdout: (message) => output.push(message),
            installCollectionReaperService: () => ({
                path: "/home/test/.config/systemd/user/hce-collection-reaper.service",
                changed: true,
            }),
        });
        assert.equal(exitCode, 0);
        assert.match(output.join(""), /Created global config file/);
        assert.match(output.join(""), /Collection lease reaper service installed/);
        assert.match(output.join(""), /Enabled hce-collection-reaper\.service/);
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
        rmSync(tempRoot, { recursive: true, force: true });
    }
});

test("known manage command is delegated without starting handler runtime", async () => {
    let manageArgs: string[] | undefined;
    let runtimeStarted = false;

    const exitCode = await runCliCommand(["list"], {
        createRuntime: () => {
            runtimeStarted = true;
            throw new Error("should not start handler runtime");
        },
        runManageCommand: async (args) => {
            manageArgs = args;
            return 0;
        },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(manageArgs, ["list"]);
    assert.equal(runtimeStarted, false);
});

test("manage command diagnostics are silent by default while stdout is preserved", async () => {
    const originalDebug = process.env.HCE_DEBUG;
    delete process.env.HCE_DEBUG;

    const output: string[] = [];
    const errors: string[] = [];
    try {
        const exitCode = await runCliCommand(["list"], {
            stdout: (message) => output.push(message),
            stderr: (message) => errors.push(message),
            runManageCommand: async (_args, options) => {
                console.log("[DEBUG] internal log");
                console.warn("[SYNC-DEBUG] internal warning");
                options.stdout?.("collection output\n");
                return 0;
            },
        });

        assert.equal(exitCode, 0);
        assert.equal(output.join(""), "collection output\n");
        assert.equal(errors.join(""), "");
    } finally {
        if (originalDebug === undefined) {
            delete process.env.HCE_DEBUG;
        } else {
            process.env.HCE_DEBUG = originalDebug;
        }
    }
});

test("manage command diagnostics are forwarded to stderr when HCE_DEBUG is enabled", async () => {
    const originalDebug = process.env.HCE_DEBUG;
    process.env.HCE_DEBUG = "1";

    const output: string[] = [];
    const errors: string[] = [];
    try {
        const exitCode = await runCliCommand(["list"], {
            stdout: (message) => output.push(message),
            stderr: (message) => errors.push(message),
            runManageCommand: async (_args, options) => {
                console.log("[DEBUG] internal log");
                console.warn("[SYNC-DEBUG] internal warning");
                options.stdout?.("collection output\n");
                return 0;
            },
        });

        assert.equal(exitCode, 0);
        assert.equal(output.join(""), "collection output\n");
        assert.match(errors.join(""), /\[DEBUG\] internal log/);
        assert.match(errors.join(""), /\[SYNC-DEBUG\] internal warning/);
    } finally {
        if (originalDebug === undefined) {
            delete process.env.HCE_DEBUG;
        } else {
            process.env.HCE_DEBUG = originalDebug;
        }
    }
});

test("status, clear, repair, and search map to ToolHandlers", async () => {
    const calls: Array<{ tool: string; args: any }> = [];
    const output: string[] = [];
    const options = {
        stdout: (message: string) => output.push(message),
        createRuntime: () => createFakeRuntime(calls),
    };

    assert.equal(await runCliCommand(["status", "/tmp", "--refresh", "--details"], options), 0);
    assert.equal(await runCliCommand(["clear", "/tmp"], options), 0);
    assert.equal(await runCliCommand(["repair", "/tmp"], options), 0);
    assert.equal(
        await runCliCommand(
            [
                "search",
                "authentication middleware",
                "/tmp",
                "--limit",
                "3",
                "--scope",
                "docs",
                "--continuation-token",
                "next-page-token",
            ],
            options,
        ),
        0,
    );

    assert.deepEqual(calls, [
        { tool: "status", args: { path: "/tmp", refresh: true, details: true } },
        { tool: "clear", args: { path: "/tmp" } },
        { tool: "repair", args: { path: "/tmp" } },
        {
            tool: "search",
            args: {
                query: "authentication middleware",
                path: "/tmp",
                limit: 3,
                scope: "docs",
                continuationToken: "next-page-token",
            },
        },
    ]);
    assert.match(output.join(""), /status ok/);
    assert.match(output.join(""), /clear ok/);
    assert.match(output.join(""), /repair ok/);
    assert.match(output.join(""), /search ok/);
});

test("CLI help and search usage expose scope instead of target role", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    assert.equal(
        await runCliCommand(["--help"], {
            stdout: (message) => output.push(message),
            stderr: (message) => errors.push(message),
        }),
        0,
    );
    assert.equal(
        await runCliCommand(["search", "--unknown"], {
            stdout: (message) => output.push(message),
            stderr: (message) => errors.push(message),
        }),
        2,
    );

    const text = `${output.join("")}\n${errors.join("")}`;
    assert.match(text, /--scope all\|docs\|code/);
    assert.doesNotMatch(text, /--target-role/);
    assert.doesNotMatch(text, /targetRole/);
});

test("status and search default path to current directory", async () => {
    const calls: Array<{ tool: string; args: any }> = [];
    const options = {
        stdout: () => undefined,
        createRuntime: () => createFakeRuntime(calls),
    };

    assert.equal(await runCliCommand(["status"], options), 0);
    assert.equal(await runCliCommand(["search", "query"], options), 0);

    assert.deepEqual(calls, [
        { tool: "status", args: { path: resolve(process.cwd()) } },
        { tool: "search", args: { query: "query", path: resolve(process.cwd()) } },
    ]);
});

test("handler errors write stderr and return non-zero", async () => {
    const errors: string[] = [];

    const exitCode = await runCliCommand(["status", "/tmp"], {
        stderr: (message) => errors.push(message),
        createRuntime: () =>
            ({
                toolHandlers: {
                    handleGetIndexingStatus: async () => ({
                        content: [{ type: "text", text: "status failed" }],
                        isError: true,
                    }),
                },
            }) as any,
    });

    assert.equal(exitCode, 1);
    assert.match(errors.join(""), /status failed/);
});

test("--json wraps handler output for Skills and scripts", async () => {
    const output: string[] = [];
    const exitCode = await runCliCommand(
        ["--json", "status", "/tmp", "--details"],
        {
            stdout: (message) => output.push(message),
            createRuntime: () => createFakeRuntime([]),
        },
    );

    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(output.join("")), {
        ok: true,
        command: "status",
        exitCode: 0,
        output: "status ok",
    });
});

test("--json exposes handler structured content as data", async () => {
    const output: string[] = [];
    const exitCode = await runCliCommand(
        ["--json", "search", "query", "/tmp"],
        {
            stdout: (message) => output.push(message),
            createRuntime: () => ({
                context: {},
                snapshotManager: {},
                syncManager: {},
                toolHandlers: {
                    handleSearchContext: async () => ({
                        content: [{ type: "text", text: "search results" }],
                        structuredContent: {
                            pagination: {
                                acceptedCount: 20,
                                returnedCount: 12,
                                truncated: true,
                                continuationToken: "next-page-token",
                            },
                        },
                    }),
                },
            }) as any,
        },
    );

    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(output.join("")), {
        ok: true,
        command: "search",
        exitCode: 0,
        output: "search results",
        data: {
            pagination: {
                acceptedCount: 20,
                returnedCount: 12,
                truncated: true,
                continuationToken: "next-page-token",
            },
        },
    });
});

test("--json can follow a command and keeps usage errors machine-readable", async () => {
    const output: string[] = [];
    const exitCode = await runCliCommand(["search", "--unknown", "--json"], {
        stdout: (message) => output.push(message),
    });

    assert.equal(exitCode, 2);
    const payload = JSON.parse(output.join(""));
    assert.equal(payload.ok, false);
    assert.equal(payload.command, "search");
    assert.equal(payload.exitCode, 2);
    assert.match(payload.error, /Usage: hce search/);
});

test("--json wraps manage command stdout and stderr", async () => {
    const output: string[] = [];
    const exitCode = await runCliCommand(["list", "--json"], {
        stdout: (message) => output.push(message),
        runManageCommand: async (_args, options) => {
            options.stdout?.("collection output\n");
            options.stderr?.("diagnostic\n");
            return 1;
        },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(JSON.parse(output.join("")), {
        ok: false,
        command: "list",
        exitCode: 1,
        output: "collection output",
        error: "diagnostic",
    });
});

test("--text overrides JSON-friendly command placement", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await runCliCommand(["status", "--text"], {
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
        createRuntime: () => createFakeRuntime([]),
    });

    assert.equal(exitCode, 0);
    assert.equal(output.join(""), "status ok\n");
    assert.equal(errors.join(""), "");
});

test("--format json is an explicit alias for --json", async () => {
    const output: string[] = [];
    const exitCode = await runCliCommand(["status", "--format", "json"], {
        stdout: (message) => output.push(message),
        createRuntime: () => createFakeRuntime([]),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(output.join("")), {
        ok: true,
        command: "status",
        exitCode: 0,
        output: "status ok",
    });
});

test("format parsing errors remain machine-readable when JSON was requested", async () => {
    const output: string[] = [];
    const exitCode = await runCliCommand(["--json", "--format", "text", "status"], {
        stdout: (message) => output.push(message),
    });

    assert.equal(exitCode, 2);
    assert.deepEqual(JSON.parse(output.join("")), {
        ok: false,
        command: "cli",
        exitCode: 2,
        error: "Conflicting output format options.",
    });
});

test("JSON usage errors include an envelope even without a command", async () => {
    const output: string[] = [];
    const exitCode = await runCliCommand(["--json"], {
        stdout: (message) => output.push(message),
    });

    assert.equal(exitCode, 2);
    const payload = JSON.parse(output.join(""));
    assert.equal(payload.ok, false);
    assert.equal(payload.command, "cli");
    assert.equal(payload.exitCode, 2);
    assert.match(payload.error, /Usage: hce --json/);
});
