import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
    CURRENT_DIRECTORY_NOT_INDEXED_NOTICE,
    UNINDEXED_TOOL_DETAIL_DESCRIPTION,
} from "./startup-index-notice.js";

const UNINDEXED_TOOL_LIST_NOTICE =
    "Current working directory is not indexed; create an index only when the user explicitly requests it.";
const INDEXED_TOOL_LIST_NOTICE =
    "Current working directory is indexed; use the available tools directly.";

const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve("tsx");
const serverEntrypoint = fileURLToPath(new URL("./index.ts", import.meta.url));

interface ListedTool {
    name: string;
    description?: string;
    inputSchema?: {
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
    };
}

function createChildEnvironment(homeDirectory: string): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
            environment[key] = value;
        }
    }

    environment.HOME = homeDirectory;
    environment.USERPROFILE = homeDirectory;
    return environment;
}

async function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error(`Timed out while ${label}`));
                }, 10_000);
            }),
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

async function withMcpClient<T>(
    workingDirectory: string,
    homeDirectory: string,
    run: (client: Client) => Promise<T>,
): Promise<T> {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", tsxLoaderPath, serverEntrypoint],
        cwd: workingDirectory,
        env: createChildEnvironment(homeDirectory),
        stderr: "pipe",
    });
    const client = new Client(
        { name: "startup-index-notice-test", version: "1.0.0" },
        { capabilities: {} },
    );

    try {
        await withTimeout(client.connect(transport), "starting the MCP server");
        return await run(client);
    } finally {
        await transport.close();
    }
}

async function listMcpTools(client: Client): Promise<readonly ListedTool[]> {
    return (await withTimeout(client.listTools(), "listing MCP tools")).tools;
}

async function getToolDetail(client: Client): Promise<string> {
    const response = await withTimeout(
        client.callTool({ name: "tool_detail", arguments: {} }),
        "getting compact tool details",
    );
    return JSON.stringify(response);
}

async function writeIndexedSnapshot(
    homeDirectory: string,
    indexedCodebasePath: string,
): Promise<void> {
    const snapshotPath = join(
        homeDirectory,
        ".hitmux-context-engine",
        "mcp-codebase-snapshot.json",
    );
    const now = new Date().toISOString();
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(
        snapshotPath,
        JSON.stringify({
            formatVersion: "v2",
            codebases: {
                [indexedCodebasePath]: {
                    status: "indexed",
                    indexedFiles: 1,
                    totalChunks: 1,
                    indexStatus: "completed",
                    lastUpdated: now,
                },
            },
            lastUpdated: now,
        }),
        "utf8",
    );
}

async function writeConfig(
    rootDirectory: string,
    values: Record<string, string | boolean>,
): Promise<void> {
    const configDirectory = join(rootDirectory, ".hitmux-context-engine");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
        join(configDirectory, "config.conf"),
        `${Object.entries(values)
            .map(([key, value]) => `${key} = ${value}`)
            .join("\n")}\n`,
        "utf8",
    );
}

function assertCompactUnindexedToolList(tools: readonly ListedTool[]): void {
    assert.deepEqual(tools.map((tool) => tool.name), ["tool_detail", "index_codebase"]);
    assert.equal(tools[0]?.description, UNINDEXED_TOOL_DETAIL_DESCRIPTION);
    assert.match(tools[0]?.description ?? "", new RegExp(UNINDEXED_TOOL_LIST_NOTICE));
    assert.deepEqual(Object.keys(tools[0]?.inputSchema?.properties ?? {}), []);
    assert.equal(tools[0]?.inputSchema?.additionalProperties, false);
    assert.equal(tools[1]?.description, UNINDEXED_TOOL_LIST_NOTICE);
    assert.deepEqual(Object.keys(tools[1]?.inputSchema?.properties ?? {}), ["path"]);
    assert.deepEqual(tools[1]?.inputSchema?.required, ["path"]);
    assert.equal(tools[1]?.inputSchema?.additionalProperties, false);
}

function assertFullToolList(
    tools: readonly ListedTool[],
    expectedNotice?: string,
): void {
    assert.deepEqual(
        tools.map((tool) => tool.name),
        [
            "index_codebase",
            "search_context",
            "clear_index",
            "get_indexing_status",
            "repair_index_manifest",
        ],
    );
    if (expectedNotice) {
        for (const tool of tools) {
            assert.match(tool.description ?? "", new RegExp(expectedNotice));
        }
    }
    const searchContext = tools.find((tool) => tool.name === "search_context");
    assert.deepEqual(
        Object.keys(searchContext?.inputSchema?.properties ?? {}),
        ["path", "query", "scope"],
    );
    assert.equal(searchContext?.inputSchema?.properties?.limit, undefined);
}

test("tools/list stays compact until the current directory is indexed", { timeout: 30_000 }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "hitmux-mcp-startup-notice-"));

    try {
        const indexedRoot = join(tempRoot, "repo");
        const indexedWorkspace = join(indexedRoot, "project");
        const indexedHome = join(tempRoot, "indexed-home");
        await Promise.all([
            mkdir(indexedWorkspace, { recursive: true }),
            mkdir(indexedHome, { recursive: true }),
        ]);
        await withMcpClient(indexedWorkspace, indexedHome, async (client) => {
            assertCompactUnindexedToolList(await listMcpTools(client));
            const toolDetail = await getToolDetail(client);
            assert.ok(toolDetail.includes(CURRENT_DIRECTORY_NOT_INDEXED_NOTICE));
            assert.ok(toolDetail.includes("index_codebase"));
            assert.ok(toolDetail.includes("force"));
            assert.ok(toolDetail.includes("ignoreFiles"));
            await writeIndexedSnapshot(indexedHome, indexedRoot);
            assertFullToolList(await listMcpTools(client), INDEXED_TOOL_LIST_NOTICE);
            assert.ok((await getToolDetail(client)).includes("Unknown tool: tool_detail"));
            return undefined;
        });

        const prefixWorkspace = join(tempRoot, "repo-other");
        const prefixHome = join(tempRoot, "prefix-home");
        await Promise.all([
            mkdir(prefixWorkspace, { recursive: true }),
            mkdir(prefixHome, { recursive: true }),
        ]);
        await writeIndexedSnapshot(prefixHome, indexedRoot);
        await withMcpClient(prefixWorkspace, prefixHome, async (client) => {
            assertCompactUnindexedToolList(await listMcpTools(client));
            return undefined;
        });
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
});

test("global and project config can restore the full unindexed tool list", { timeout: 30_000 }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "hitmux-mcp-unindexed-tools-config-"));

    try {
        const workspace = join(tempRoot, "workspace");
        const homeDirectory = join(tempRoot, "home");
        await Promise.all([
            mkdir(workspace, { recursive: true }),
            mkdir(homeDirectory, { recursive: true }),
        ]);
        await writeConfig(homeDirectory, { restrictToolsWhenUnindexed: false });

        await withMcpClient(workspace, homeDirectory, async (client) => {
            assertFullToolList(await listMcpTools(client));

            await writeConfig(workspace, { restrictToolsWhenUnindexed: true });
            assertCompactUnindexedToolList(await listMcpTools(client));

            await writeConfig(workspace, { restrictToolsWhenUnindexed: false });
            assertFullToolList(await listMcpTools(client));
            return undefined;
        });
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
});
