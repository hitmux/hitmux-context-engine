#!/usr/bin/env node

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
console.log = (...args: any[]) => {
    process.stderr.write("[LOG] " + args.join(" ") + "\n");
};

console.warn = (...args: any[]) => {
    process.stderr.write("[WARN] " + args.join(" ") + "\n");
};

// console.error already goes to stderr by default

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
    Context,
    applySystemProxyPolicy,
    configManager,
} from "@hitmux/hitmux-context-engine-core";

// Import our modular components
import {
    createMcpConfig,
    logConfigurationSummary,
    showHelpMessage,
    ContextMcpConfig,
} from "./config.js";
import { createRuntimeContext } from "./runtime-context.js";
import { runCliManageCommand } from "./cli-manage.js";
import { runCliTestCommand } from "./cli-test.js";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";
import { ToolHandlers } from "./handlers.js";
import { UpdateChecker } from "./update-checker.js";

applySystemProxyPolicy(false);

process.on("unhandledRejection", (reason) => {
    console.error("[MCP] Unhandled async error (kept server alive):", reason);
});

const MCP_PACKAGE_NAME = "@hitmux/hitmux-context-engine-mcp";
const MCP_PACKAGE_VERSION_FALLBACK = "0.0.0";

function readCurrentPackageVersion(): string {
    try {
        const packageJsonPath = join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "package.json",
        );
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
            version?: string;
        };
        return packageJson.version ?? MCP_PACKAGE_VERSION_FALLBACK;
    } catch (error) {
        console.warn("[MCP] Failed to read package version:", error);
        return MCP_PACKAGE_VERSION_FALLBACK;
    }
}

class ContextMcpServer {
    private server: Server;
    private snapshotManager: SnapshotManager;
    private updateChecker: UpdateChecker;
    private currentPackageVersion: string;
    private runtime: {
        context: Context;
        syncManager: SyncManager;
        toolHandlers: ToolHandlers;
        backgroundSyncStarted: boolean;
        snapshotValidated: boolean;
    } | null = null;
    private runtimePromise: Promise<
        NonNullable<ContextMcpServer["runtime"]>
    > | null = null;

    constructor() {
        this.currentPackageVersion = readCurrentPackageVersion();
        // Initialize MCP server
        this.server = new Server(
            {
                name: "Hitmux Context Engine MCP Server",
                version: this.currentPackageVersion,
            },
            {
                capabilities: {
                    tools: {},
                },
            },
        );

        this.snapshotManager = new SnapshotManager();
        this.snapshotManager.loadCodebaseSnapshot();
        this.updateChecker = new UpdateChecker({
            packageName: MCP_PACKAGE_NAME,
            currentVersion: this.currentPackageVersion,
        });
        this.updateChecker.start();

        this.setupTools();
    }

    private formatToolError(prefix: string, error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [
                {
                    type: "text",
                    text: `${prefix}: ${message}`,
                },
            ],
            isError: true,
        };
    }

    private formatRuntimeInitializationError(error: unknown) {
        return this.formatToolError(
            "Error initializing Hitmux Context Engine runtime",
            error,
        );
    }

    private withUpdateNotice(result: any): any {
        const notice = this.updateChecker.consumeNotice();
        if (!notice || !Array.isArray(result?.content)) {
            return result;
        }

        const firstTextContent = result.content.find(
            (item: any) => item?.type === "text" && typeof item.text === "string",
        );

        if (!firstTextContent) {
            return result;
        }

        firstTextContent.text = `${notice}\n\n${firstTextContent.text}`;
        return result;
    }

    private getAbsolutePathArgument(args: unknown): string | undefined {
        if (!args || typeof args !== "object" || Array.isArray(args)) {
            return undefined;
        }

        const value = (args as { path?: unknown }).path;
        if (typeof value !== "string" || value.trim().length === 0) {
            return undefined;
        }

        const trimmed = value.trim();
        return isAbsolute(trimmed) ? trimmed : undefined;
    }

    private getConfigReadError(): Error | null {
        const errors = configManager.getReadErrors(process.cwd());
        if (errors.length === 0) {
            return null;
        }

        const details = errors
            .map((error) => `${error.path}: ${error.message}`)
            .join("\n");
        return new Error(
            `Invalid config.conf. Fix the configuration before using MCP tools.\n${details}`,
        );
    }

    private async getRuntime(): Promise<
        NonNullable<ContextMcpServer["runtime"]>
    > {
        if (this.runtime) {
            return this.runtime;
        }

        if (this.runtimePromise) {
            return this.runtimePromise;
        }

        this.runtimePromise = Promise.resolve()
            .then(async () => {
                const configError = this.getConfigReadError();
                if (configError) {
                    throw configError;
                }

                const config = createMcpConfig(this.currentPackageVersion);
                logConfigurationSummary(config);

                const runtime = await this.createRuntime(config);
                this.runtime = runtime;
                return runtime;
            })
            .finally(() => {
                this.runtimePromise = null;
            });

        return this.runtimePromise;
    }

    private async createRuntime(
        config: ContextMcpConfig,
    ): Promise<NonNullable<ContextMcpServer["runtime"]>> {
        console.log(
            `[EMBEDDING] Initializing embedding provider: ${config.embeddingProvider}`,
        );
        console.log(`[EMBEDDING] Using model: ${config.embeddingModel}`);

        const context = createRuntimeContext(config);

        // Initialize managers
        const syncManager = new SyncManager(context, this.snapshotManager);
        const toolHandlers = new ToolHandlers(
            context,
            this.snapshotManager,
            syncManager,
        );

        return {
            context,
            syncManager,
            toolHandlers,
            backgroundSyncStarted: false,
            snapshotValidated: false,
        };
    }

    private setupTools() {
        const index_description = `
Index a codebase directory to enable semantic search using a configurable code splitter.

**IMPORTANT**:
- You MUST provide an absolute path to the target codebase.

**Usage Guidance**:
- This tool is typically used when search fails due to an unindexed codebase.
- Before first indexing, create a project ignore file such as .hceignore when generated, large, or private paths should be excluded.
- The indexer automatically loads .*ignore files it finds in the project tree, including .hceignore, .gitignore, and .cursorignore. Use ignoreFiles only for extra non-default ignore file paths.
- For an already indexed codebase, prefer incremental=true to manually sync added, modified, removed, or newly ignored files without rebuilding the full index.
- Use force=true only when a full rebuild is required, such as after changing embedding configuration, splitter/schema compatibility, or when index/snapshot state is no longer trustworthy. Force re-indexing drops the existing index and should not be the default fix for ordinary file changes.
`;

        const search_description = `
Search the indexed codebase with code-search style queries within a specified absolute path.

**IMPORTANT**:
- You MUST provide an absolute path.
- Do NOT pass a broad natural-language sentence as the only query when the user is asking where behavior is implemented.
- Rewrite natural-language requests into focused code-search terms before calling this tool.
- Strongly prefer English queries, even when the user's request is in another language.

**When to Use**:
This tool is versatile and can be used before completing various tasks to retrieve relevant context:
- **Code search**: Find specific functions, classes, or implementations
- **Context-aware assistance**: Gather relevant code context before making changes
- **Issue identification**: Locate problematic code sections or bugs
- **Code review**: Understand existing implementations and patterns
- **Refactoring**: Find all related code pieces that need to be updated
- **Feature development**: Understand existing architecture and similar implementations
- **Duplicate detection**: Identify redundant or duplicated code patterns across the codebase

**Usage Guidance**:
- If the codebase is not indexed, this tool will return a clear error message indicating that indexing is required first and recommending a project ignore file such as .hceignore.
- You can then use the index_codebase tool to index the codebase before searching again.
- For natural-language discovery tasks, generate one focused query per likely implementation angle instead of one broad sentence.
- Include likely identifiers, class/function names, file names, path segments, and English code/domain terms. Strongly prefer English for query terms.
- Include scope hints such as client, server, shared, UI, network, rendering, storage, validation, worker, or route when relevant.
- Prefer several short searches and compare their results by path, symbol, and content evidence.

**Good query style**:
- "authentication middleware token validation"
- "AuthMiddleware validateToken bearer token"
- "src/auth middleware token validation"
- "database migration schema version rollback"

**Poor query style**:
- "where is the code for this behavior"
- "find the thing that handles the user request"
`;

        // Define available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: "index_codebase",
                        description: index_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to index.`,
                                },
                                force: {
                                    type: "boolean",
                                    description:
                                        "Full rebuild for exceptional cases only. Drops and recreates the existing index; prefer incremental=true for ordinary added, modified, removed, or newly ignored files.",
                                    default: false,
                                },
                                incremental: {
                                    type: "boolean",
                                    description:
                                        "Manually sync an already indexed codebase without dropping or rebuilding the full index. Handles added, modified, removed, and newly ignored files. Use this for normal index updates and after reviewing a large automatic incremental-sync warning. Cannot be combined with force=true or dryRun=true.",
                                    default: false,
                                },
                                splitter: {
                                    type: "string",
                                    description:
                                        "Optional code splitter override: 'ast' for syntax-aware splitting with automatic fallback, 'langchain' for character-based splitting. Omit to use config.splitterType, then ast.",
                                    enum: ["ast", "langchain"],
                                },
                                customExtensions: {
                                    type: "array",
                                    items: {
                                        type: "string",
                                    },
                                    description:
                                        "Optional: Additional file extensions to include beyond defaults (e.g., ['.vue', '.svelte', '.astro']). Extensions should include the dot prefix or will be automatically added",
                                    default: [],
                                },
                                ignorePatterns: {
                                    type: "array",
                                    items: {
                                        type: "string",
                                    },
                                    description:
                                        "Optional: Additional ignore patterns to exclude specific files/directories beyond defaults. Only include this parameter if the user explicitly requests custom ignore patterns (e.g., ['static/**', '*.tmp', 'private/**'])",
                                    default: [],
                                },
                                ignoreFiles: {
                                    type: "array",
                                    items: {
                                        type: "string",
                                    },
                                    description:
                                        "Optional: Additional ignore files to load beyond automatically discovered .*ignore files. Relative paths are resolved from the codebase root (e.g., ['config/index.ignore']).",
                                    default: [],
                                },
                                maxDepth: {
                                    type: "number",
                                    description:
                                        "Optional: Maximum directory depth to traverse from the codebase root. 0 indexes only files directly in the root.",
                                    minimum: 0,
                                },
                                dryRun: {
                                    type: "boolean",
                                    description:
                                        "Preview the files that would be indexed without creating collections, embedding, or writing index data.",
                                    default: false,
                                },
                            },
                            required: ["path"],
                        },
                    },
                    {
                        name: "search_code",
                        description: search_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to search in.`,
                                },
                                query: {
                                    type: "string",
                                    description:
                                        "Focused code-search query. Strongly prefer English query terms. Rewrite natural-language requests into likely identifiers, filenames, path words, English domain terms, and scope hints. Prefer multiple short searches over one broad sentence.",
                                },
                                limit: {
                                    type: "number",
                                    description:
                                        "Optional override for the maximum number of results to return. Leave empty for the bounded default result set; use a specific value only when you need more or fewer results.",
                                },
                                targetRole: {
                                    type: "string",
                                    enum: [
                                        "implementation",
                                        "test",
                                        "docs",
                                        "config",
                                        "all",
                                    ],
                                    description:
                                        "Optional explicit search target. Defaults to implementation, which keeps tests, docs, config, and barrel exports out of the primary result group.",
                                },
                                includeRelated: {
                                    type: "boolean",
                                    description:
                                        "Optional: include non-primary result groups such as entry/exports, related tests, docs, and config. Defaults to true.",
                                    default: true,
                                },
                                includeTraceEvidence: {
                                    type: "boolean",
                                    description:
                                        "Optional: attach compact symbol relationship evidence for a small number of top implementation or entry results. Defaults to false.",
                                    default: false,
                                },
                                consistency: {
                                    type: "string",
                                    enum: ["low_latency", "strong"],
                                    description:
                                        "Optional search consistency mode. Defaults to low_latency, which uses watcher dirty paths when available and never blocks on full-scan reconciliation. Use strong only when the search must refresh the index before returning.",
                                    default: "low_latency",
                                },
                                skipConsistencyCheck: {
                                    type: "boolean",
                                    description:
                                        "Deprecated compatibility option. When true, forces low_latency behavior. Prefer consistency='low_latency' or consistency='strong'.",
                                    default: false,
                                },
                                extensionFilter: {
                                    type: "array",
                                    items: {
                                        type: "string",
                                    },
                                    description:
                                        "Optional: List of file extensions to filter results. (e.g., ['.ts','.py']).",
                                    default: [],
                                },
                            },
                            required: ["path", "query"],
                        },
                    },
                    {
                        name: "clear_index",
                        description: `Clear the search index. IMPORTANT: You MUST provide an absolute path.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to clear.`,
                                },
                            },
                            required: ["path"],
                        },
                    },
                    {
                        name: "get_indexing_status",
                        description: `Get the current indexing status of a codebase. Shows progress percentage for actively indexing codebases and completion status for indexed codebases.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to check status for.`,
                                },
                            },
                            required: ["path"],
                        },
                    },
                    {
                        name: "repair_index_manifest",
                        description:
                            "Explicitly migrate or repair legacy remote status for an indexed codebase by scanning chunk metadata once and writing the remote index manifest. Use only when get_indexing_status reports a missing remote manifest for an existing collection.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory whose remote index manifest should be repaired.`,
                                },
                            },
                            required: ["path"],
                        },
                    },
                ],
            };
        });

        // Handle tool execution
        this.server.setRequestHandler(
            CallToolRequestSchema,
            async (request) => {
                const { name, arguments: args } = request.params;
                let runtime: NonNullable<ContextMcpServer["runtime"]>;
                try {
                    runtime = await this.getRuntime();
                    if (!runtime.snapshotValidated) {
                        const targetCodebasePath =
                            this.getAbsolutePathArgument(args);
                        if (targetCodebasePath) {
                            await runtime.toolHandlers.validateLegacyZeroEntries(
                                targetCodebasePath,
                            );
                            await runtime.toolHandlers.validateIndexedCollections(
                                targetCodebasePath,
                            );
                        }
                        runtime.snapshotValidated = true;
                    }
                    if (!runtime.backgroundSyncStarted) {
                        console.log(
                            "[SYNC-DEBUG] Initializing background sync after first successful runtime initialization...",
                        );
                        runtime.syncManager.startBackgroundSync();
                        runtime.backgroundSyncStarted = true;
                    }
                } catch (error) {
                    return this.withUpdateNotice(
                        this.formatRuntimeInitializationError(error),
                    );
                }

                try {
                    let result: any;
                    switch (name) {
                        case "index_codebase":
                            result = await runtime.toolHandlers.handleIndexCodebase(
                                args,
                            );
                            return this.withUpdateNotice(result);
                        case "search_code":
                            result = await runtime.toolHandlers.handleSearchCode(
                                args,
                            );
                            return this.withUpdateNotice(result);
                        case "clear_index":
                            result = await runtime.toolHandlers.handleClearIndex(
                                args,
                            );
                            return this.withUpdateNotice(result);
                        case "get_indexing_status":
                            result = await runtime.toolHandlers.handleGetIndexingStatus(
                                args,
                            );
                            return this.withUpdateNotice(result);
                        case "repair_index_manifest":
                            result = await runtime.toolHandlers.handleRepairIndexManifest(
                                args,
                            );
                            return this.withUpdateNotice(result);

                        default:
                            return this.withUpdateNotice(
                                this.formatToolError("Unknown tool", name),
                            );
                    }
                } catch (error) {
                    console.error(`[MCP] Tool '${name}' failed:`, error);
                    return this.withUpdateNotice(
                        this.formatToolError(
                            `Error running tool '${name}'`,
                            error,
                        ),
                    );
                }
            },
        );
    }

    async start() {
        console.log("[SYNC-DEBUG] MCP server start() method called");
        console.log("Starting Context MCP server...");

        const transport = new StdioServerTransport();
        console.log(
            "[SYNC-DEBUG] StdioServerTransport created, attempting server connection...",
        );

        await this.server.connect(transport);
        console.log("MCP server started and listening on stdio.");
        console.log("[SYNC-DEBUG] Server connection established successfully");
        console.log(
            "[SYNC-DEBUG] MCP protocol ready. Runtime config will be loaded on first tool call.",
        );
    }
}

// Main execution
async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);

    // Show help if requested
    if (args.includes("--help") || args.includes("-h")) {
        showHelpMessage();
        process.exit(0);
    }

    const ensureConfigResult = configManager.ensureGlobalConfigFile();
    if (ensureConfigResult.created) {
        console.log(
            `[MCP] Created default global config file: ${ensureConfigResult.path}`,
        );
    } else if (ensureConfigResult.updated) {
        console.log(
            `[MCP] Completed global config comments for missing fields: ${ensureConfigResult.appendedKeys.join(", ")}`,
        );
    }

    if (args[0] === "test") {
        const exitCode = await runCliTestCommand(args.slice(1));
        process.exit(exitCode);
    }

    if (args[0] === "list" || args[0] === "rm" || args[0] === "index") {
        const exitCode = await runCliManageCommand(args);
        process.exit(exitCode);
    }

    const server = new ContextMcpServer();
    await server.start();
}

// Handle graceful shutdown
process.on("SIGINT", () => {
    console.error("Received SIGINT, shutting down gracefully...");
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down gracefully...");
    process.exit(0);
});

// Always start the server - this is designed to be the main entry point
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
