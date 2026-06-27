import assert from "node:assert/strict";
import { resolve } from "node:path";
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
            handleSearchCode: async (args: unknown) => {
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

    assert.equal(await runCliCommand(["status", "/tmp", "--refresh"], options), 0);
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
                "--target-role",
                "implementation",
            ],
            options,
        ),
        0,
    );

    assert.deepEqual(calls, [
        { tool: "status", args: { path: "/tmp", refresh: true } },
        { tool: "clear", args: { path: "/tmp" } },
        { tool: "repair", args: { path: "/tmp" } },
        {
            tool: "search",
            args: {
                query: "authentication middleware",
                path: "/tmp",
                limit: 3,
                targetRole: "implementation",
            },
        },
    ]);
    assert.match(output.join(""), /status ok/);
    assert.match(output.join(""), /clear ok/);
    assert.match(output.join(""), /repair ok/);
    assert.match(output.join(""), /search ok/);
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
