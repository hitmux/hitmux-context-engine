#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
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
    ContextMcpConfig,
} from "./config.js";
import {
    readCurrentPackageVersion,
    runCliCommand,
    shouldStartMcpServer,
} from "./cli.js";
import { createRuntimeContext } from "./runtime-context.js";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";
import { ToolHandlers } from "./handlers.js";
import { dispatchMcpTool } from "./tool-dispatch.js";
import { isHceDebugEnabled } from "./logger.js";
import {
    CURRENT_DIRECTORY_NOT_INDEXED_NOTICE,
    getCurrentDirectoryIndexNotice,
    prependStartupIndexNotice,
    UNINDEXED_TOOL_DETAIL_DESCRIPTION,
} from "./startup-index-notice.js";
import { UpdateChecker } from "./update-checker.js";

applySystemProxyPolicy(false);

process.on("unhandledRejection", (reason) => {
    console.error("[MCP] Unhandled async error (kept server alive):", reason);
});

let activeCommandAbortController: AbortController | null = null;
let activeCommandExitTimer: ReturnType<typeof setTimeout> | undefined;

function clearActiveCommandExitTimer(): void {
    if (activeCommandExitTimer) {
        clearTimeout(activeCommandExitTimer);
        activeCommandExitTimer = undefined;
    }
}

function handleShutdownSignal(signalName: "SIGINT" | "SIGTERM"): void {
    if (activeCommandAbortController && !activeCommandAbortController.signal.aborted) {
        console.error(`Received ${signalName}, cancelling active command...`);
        activeCommandAbortController.abort();
        clearActiveCommandExitTimer();
        activeCommandExitTimer = setTimeout(() => {
            console.error(`Active command did not stop after ${signalName}; exiting.`);
            process.exit(signalName === "SIGINT" ? 130 : 143);
        }, 5000);
        activeCommandExitTimer.unref?.();
        return;
    }

    console.error(`Received ${signalName}, shutting down gracefully...`);
    process.exit(signalName === "SIGINT" ? 130 : 143);
}

const MCP_PACKAGE_NAME = "@hitmux/hitmux-context-engine-mcp";

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
Index a directory/context root to enable semantic search over indexed context.

**IMPORTANT**:
- You MUST provide an absolute path to the target directory/context root.

**Usage Guidance**:
- This tool is typically used when search fails due to an unindexed directory/context root.
- Before first indexing, create a project ignore file such as .hceignore when generated, large, or private paths should be excluded.
- The indexer automatically loads .*ignore files it finds in the project tree, including .hceignore, .gitignore, and .cursorignore. Use ignoreFiles only for extra non-default ignore file paths.
- For an already indexed directory/context root, prefer incremental=true to manually sync added, modified, removed, or newly ignored files without rebuilding the full index.
- Use force=true only when a full rebuild is required, such as after changing embedding configuration, splitter/schema compatibility, or when index/snapshot state is no longer trustworthy. Force re-indexing drops the existing index and should not be the default fix for ordinary file changes.
`;

        const indexCodebaseInputSchema = {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: `ABSOLUTE path to the directory/context root to index.`,
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
                        "Manually sync an already indexed directory/context root without dropping or rebuilding the full index. Handles added, modified, removed, and newly ignored files. Use this for normal index updates and after reviewing a large automatic incremental-sync warning. Cannot be combined with force=true or dryRun=true.",
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
                        "Optional: Additional ignore files to load beyond automatically discovered .*ignore files. Relative paths are resolved from the context root (e.g., ['config/index.ignore']).",
                    default: [],
                },
                maxDepth: {
                    type: "number",
                    description:
                        "Optional: Maximum directory depth to traverse from the context root. 0 indexes only files directly in the root.",
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
        };

        const compactIndexCodebaseInputSchema = {
            type: "object",
            properties: {
                path: {
                    type: "string",
                },
            },
            required: ["path"],
            additionalProperties: false,
        };

        const toolDetailInputSchema = {
            type: "object",
            properties: {},
            additionalProperties: false,
        };

        const toolDetailResponse = () => ({
            content: [
                {
                    type: "text",
                    text: [
                        CURRENT_DIRECTORY_NOT_INDEXED_NOTICE,
                        "Complete index_codebase details:",
                        JSON.stringify(
                            {
                                name: "index_codebase",
                                description: index_description.trim(),
                                inputSchema: indexCodebaseInputSchema,
                            },
                            null,
                            2,
                        ),
                    ].join("\n\n"),
                },
            ],
        });

        const search_description = `
Search indexed context within a specified absolute path.

**IMPORTANT**:
- You MUST provide an absolute path.

**When to Use**:
This tool is versatile and can be used before completing various tasks to retrieve relevant context:
- **Documents and notes**: Find relevant sections in indexed Markdown, text, notebooks, and other supported files
- **Code search**: Find functions, classes, implementations, tests, or configuration
- **Context-aware assistance**: Gather relevant context before answering, editing, or reviewing

**Usage Guidance**:
- If the directory/context root is not indexed, this tool will return a clear error message indicating that indexing is required first and recommending a project ignore file such as .hceignore.
- You can then use the index_codebase tool to index the directory/context root before searching again.
- What gets indexed is controlled by ignore files such as .hceignore, .gitignore, and other .*ignore files.
- By default this tool searches all indexed context. Use scope='docs' for docs only or scope='code' for code only.
- Use focused queries with relevant filenames, headings, identifiers, path words, or domain terms.

**Good query style**:
- "authentication middleware token validation"
- "AuthMiddleware validateToken bearer token"
- "pricing table renewal policy"
- "database migration schema version rollback"
`;

        // Define available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const startupIndexNotice = getCurrentDirectoryIndexNotice(
                this.snapshotManager,
            );
            if (
                startupIndexNotice &&
                (configManager.getBoolean("restrictToolsWhenUnindexed") ?? true)
            ) {
                return {
                    tools: [
                        {
                            name: "tool_detail",
                            description: UNINDEXED_TOOL_DETAIL_DESCRIPTION,
                            inputSchema: toolDetailInputSchema,
                        },
                        {
                            name: "index_codebase",
                            inputSchema: compactIndexCodebaseInputSchema,
                        },
                    ],
                };
            }

            return {
                tools: [
                    {
                        name: "index_codebase",
                        description: prependStartupIndexNotice(
                            index_description,
                            startupIndexNotice,
                        ),
                        inputSchema: indexCodebaseInputSchema,
                    },
                    {
                        name: "search_context",
                        description: prependStartupIndexNotice(
                            search_description,
                            startupIndexNotice,
                        ),
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the indexed directory to search in.`,
                                },
                                query: {
                                    type: "string",
                                    description:
                                        "Focused search query. Include relevant filenames, headings, identifiers, path words, or domain terms when useful.",
                                },
                                limit: {
                                    type: "number",
                                    default: 10,
                                    description:
                                        "Maximum number of results to return. Default to 10 and use 10 for normal searches; set a different value only when the user explicitly asks for more or fewer results.",
                                },
                                scope: {
                                    type: "string",
                                    enum: [
                                        "all",
                                        "docs",
                                        "code",
                                    ],
                                    description:
                                        "Optional search scope. Defaults to all. Use docs for docs only, code for code only, or all for every indexed file role.",
                                    default: "all",
                                },
                            },
                            required: ["path", "query"],
                            additionalProperties: false,
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
                                    description: `ABSOLUTE path to the indexed directory/context root to clear.`,
                                },
                            },
                            required: ["path"],
                        },
                    },
                    {
                        name: "get_indexing_status",
                        description: `Get the current indexing status of a directory/context root. Shows progress percentage for active indexing and completion status for indexed context roots.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the directory/context root to check status for.`,
                                },
                                refresh: {
                                    type: "boolean",
                                    description:
                                        "Optional. Defaults to false for fast local snapshot/job status. Set true to probe the vector database and recover remote collection/manifest state.",
                                    default: false,
                                },
                            },
                            required: ["path"],
                        },
                    },
                    {
                        name: "repair_index_manifest",
                        description:
                            "Explicitly migrate or repair legacy remote status for an indexed directory/context root by scanning chunk metadata once and writing the remote index manifest. Use only when get_indexing_status reports a missing remote manifest for an existing collection.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the directory/context root whose remote index manifest should be repaired.`,
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
                if (name === "tool_detail") {
                    const startupIndexNotice = getCurrentDirectoryIndexNotice(
                        this.snapshotManager,
                    );
                    if (
                        startupIndexNotice &&
                        (configManager.getBoolean("restrictToolsWhenUnindexed") ?? true)
                    ) {
                        return this.withUpdateNotice(toolDetailResponse());
                    }
                    return this.withUpdateNotice(
                        this.formatToolError("Unknown tool", name),
                    );
                }

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
                } catch (error) {
                    return this.withUpdateNotice(
                        this.formatRuntimeInitializationError(error),
                    );
                }

                try {
                    const result = await dispatchMcpTool(
                        runtime,
                        name,
                        args,
                        (unknownName) =>
                            this.formatToolError("Unknown tool", unknownName),
                    );
                    return this.withUpdateNotice(result);
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
    const args = process.argv.slice(2);

    if (!shouldStartMcpServer(args)) {
        activeCommandAbortController = new AbortController();
        try {
            const exitCode = await runCliCommand(args, {
                signal: activeCommandAbortController.signal,
            });
            process.exit(exitCode);
        } finally {
            activeCommandAbortController = null;
            clearActiveCommandExitTimer();
        }
    }

    installMcpConsoleRedirect();
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

    const server = new ContextMcpServer();
    await server.start();
}

function installMcpConsoleRedirect(): void {
    console.log = (...args: any[]) => {
        if (isHceDebugEnabled()) {
            process.stderr.write("[LOG] " + args.join(" ") + "\n");
        }
    };

    console.warn = (...args: any[]) => {
        if (isHceDebugEnabled()) {
            process.stderr.write("[WARN] " + args.join(" ") + "\n");
        }
    };
}

function isDirectExecution(): boolean {
    if (process.argv[1] === undefined) {
        return false;
    }
    const entryPath = isAbsolute(process.argv[1])
        ? process.argv[1]
        : resolve(process.argv[1]);
    try {
        return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return entryPath === fileURLToPath(import.meta.url);
    }
}

export function runHitmuxContextEngineCli(): void {
    // Handle graceful shutdown
    process.on("SIGINT", () => {
        handleShutdownSignal("SIGINT");
    });

    process.on("SIGTERM", () => {
        handleShutdownSignal("SIGTERM");
    });

    // Always start the server - this is designed to be the main entry point
    main().catch((error) => {
        console.error("Fatal error:", error);
        process.exit(1);
    });
}

if (isDirectExecution()) {
    runHitmuxContextEngineCli();
}
