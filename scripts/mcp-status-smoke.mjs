#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

const DEFAULT_TIMEOUT_MS = 60_000;

function parseArgs(argv) {
    const options = {
        path: process.cwd(),
        command: process.env.HCE_MCP_COMMAND || "hitmux-context-engine-mcp",
        args: process.env.HCE_MCP_ARGS ? splitShellWords(process.env.HCE_MCP_ARGS) : [],
        timeoutMs: DEFAULT_TIMEOUT_MS,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--path") {
            options.path = requireValue(argv, ++i, arg);
        } else if (arg === "--command") {
            options.command = requireValue(argv, ++i, arg);
        } else if (arg === "--arg") {
            options.args.push(requireValue(argv, ++i, arg));
        } else if (arg === "--timeout-ms") {
            const value = Number(requireValue(argv, ++i, arg));
            if (!Number.isFinite(value) || value <= 0) {
                throw new Error("--timeout-ms must be a positive number");
            }
            options.timeoutMs = Math.floor(value);
        } else if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return options;
}

function requireValue(argv, index, name) {
    const value = argv[index];
    if (!value) {
        throw new Error(`${name} requires a value`);
    }
    return value;
}

function splitShellWords(value) {
    return value.trim().split(/\s+/).filter(Boolean);
}

function printHelp() {
    console.log(`Usage:
  node scripts/mcp-status-smoke.mjs [options]

Options:
  --path <dir>          Codebase path passed to get_indexing_status.
                        Default: current working directory.
  --command <cmd>       MCP server command. Default: HCE_MCP_COMMAND or hitmux-context-engine-mcp.
  --arg <value>         Add one MCP server argument. Can be repeated.
  --timeout-ms <ms>     Overall timeout. Default: ${DEFAULT_TIMEOUT_MS}.

Examples:
  node scripts/mcp-status-smoke.mjs --path /path/to/repo
  node scripts/mcp-status-smoke.mjs --command hce --path /path/to/repo
  node scripts/mcp-status-smoke.mjs --command npx --arg -y --arg @hitmux/hce@latest --path /path/to/repo

Environment:
  HCE_MCP_COMMAND       MCP server command override.
  HCE_MCP_ARGS          Space-separated MCP server args.
`);
}

function log(startedAt, message) {
    const elapsed = Date.now() - startedAt;
    console.log(`[${elapsed}ms] ${message}`);
}

function exitSoon(code) {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 250).unref();
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const startedAt = Date.now();
    let nextId = 1;
    let stdoutBuffer = "";
    let childExited = false;
    const pending = new Map();

    log(startedAt, `starting MCP server: ${[options.command, ...options.args].join(" ")}`);
    log(startedAt, `status path: ${options.path}`);

    const child = spawn(options.command, options.args, {
        cwd: options.path,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
        const pendingMethods = Array.from(pending.values()).map((entry) => entry.method).join(", ") || "none";
        log(startedAt, `TIMEOUT after ${options.timeoutMs}ms; pending=${pendingMethods}`);
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, options.timeoutMs);

    function send(method, params) {
        const id = nextId++;
        const payload = { jsonrpc: "2.0", id, method, params };
        pending.set(id, { method, sentAt: Date.now() });
        child.stdin.write(`${JSON.stringify(payload)}\n`);
        log(startedAt, `sent ${method} id=${id}`);
        return id;
    }

    function notify(method, params) {
        const payload = { jsonrpc: "2.0", method, params };
        child.stdin.write(`${JSON.stringify(payload)}\n`);
        log(startedAt, `sent notification ${method}`);
    }

    function finish(code) {
        clearTimeout(timeout);
        if (!childExited) {
            child.kill("SIGTERM");
        }
        exitSoon(code);
    }

    child.on("error", (error) => {
        log(startedAt, `failed to start MCP server: ${error.message}`);
        finish(1);
    });

    child.on("exit", (code, signal) => {
        childExited = true;
        log(startedAt, `MCP server exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    });

    child.stderr.on("data", (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
            if (line.trim()) {
                log(startedAt, `stderr ${line}`);
            }
        }
    });

    child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        for (;;) {
            const newlineIndex = stdoutBuffer.indexOf("\n");
            if (newlineIndex < 0) {
                break;
            }

            const line = stdoutBuffer.slice(0, newlineIndex).trim();
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            if (!line) {
                continue;
            }

            let message;
            try {
                message = JSON.parse(line);
            } catch {
                log(startedAt, `non-json stdout ${line}`);
                continue;
            }

            if (!message.id || !pending.has(message.id)) {
                log(startedAt, `unmatched stdout ${JSON.stringify(message).slice(0, 500)}`);
                continue;
            }

            const entry = pending.get(message.id);
            pending.delete(message.id);
            const elapsed = Date.now() - entry.sentAt;
            const status = message.error ? `error=${JSON.stringify(message.error)}` : "ok";
            log(startedAt, `response ${entry.method} id=${message.id} after=${elapsed}ms ${status}`);

            if (entry.method === "initialize") {
                notify("notifications/initialized", {});
                send("tools/list", {});
            } else if (entry.method === "tools/list") {
                send("tools/call", {
                    name: "get_indexing_status",
                    arguments: { path: options.path },
                });
            } else if (entry.method === "tools/call") {
                console.log("\n--- get_indexing_status result ---");
                console.log(JSON.stringify(message.result ?? message.error, null, 2));
                finish(message.error ? 1 : 0);
            }
        }
    });

    send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
            name: "hce-mcp-status-smoke",
            version: "0.0.0",
        },
    });
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
