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
    CURRENT_DIRECTORY_INDEXED_NOTICE,
    CURRENT_DIRECTORY_NOT_INDEXED_NOTICE,
    getCurrentDirectoryIndexNotice,
    prependStartupIndexNotice,
    UNINDEXED_TOOL_LIST_NOTICE,
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
Index an absolute directory/context root for semantic search. Before first indexing, add .hceignore for generated, large, or private paths. The indexer automatically loads discovered .*ignore files, including .hceignore, .gitignore, and .cursorignore; use ignoreFiles only for additional files. Use incremental=true to sync an indexed root without rebuilding after added, modified, removed, or newly ignored files. Use force=true only after embedding, splitter/schema compatibility changes or when index/snapshot state is untrusted; it drops and recreates the index.
`;

        const indexCodebaseInputSchema = {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Absolute directory/context root to index.",
                },
                force: {
                    type: "boolean",
                    description:
                        "Exceptional full rebuild that drops and recreates the index. Use incremental=true for ordinary file or ignore changes.",
                    default: false,
                },
                incremental: {
                    type: "boolean",
                    description:
                        "Sync an indexed root without rebuilding for normal updates or after reviewing a large automatic-sync warning. Handles added, modified, removed, and newly ignored files. Cannot combine with force=true or dryRun=true.",
                    default: false,
                },
                splitter: {
                    type: "string",
                    description:
                        "Optional override: ast for syntax-aware splitting with fallback; langchain for character-based splitting. Defaults to config.splitterType, then ast.",
                    enum: ["ast", "langchain"],
                },
                customExtensions: {
                    type: "array",
                    items: {
                        type: "string",
                    },
                    description:
                        "Additional extensions beyond defaults (e.g., ['.vue', '.svelte', '.astro']). Include the dot prefix or it is added automatically.",
                    default: [],
                },
                ignorePatterns: {
                    type: "array",
                    items: {
                        type: "string",
                    },
                    description:
                        "Additional ignore patterns beyond defaults. Set only when the user explicitly requests them (e.g., ['static/**', '*.tmp', 'private/**']).",
                    default: [],
                },
                ignoreFiles: {
                    type: "array",
                    items: {
                        type: "string",
                    },
                    description:
                        "Additional ignore files beyond automatically discovered .*ignore files. Relative paths use the context root (e.g., ['config/index.ignore']).",
                    default: [],
                },
                maxDepth: {
                    type: "number",
                    description:
                        "Maximum traversal depth from the context root. 0 indexes only files directly in the root.",
                    minimum: 0,
                },
                dryRun: {
                    type: "boolean",
                    description:
                        "Preview files that would be indexed without creating collections, embedding, or writing index data.",
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
Search indexed context in an absolute path. If the root is unindexed, the tool reports that indexing is required and recommends .hceignore; then use index_codebase before searching again. Indexed files follow .hceignore, .gitignore, and other discovered .*ignore files. It searches all context by default; use scope='docs' or scope='code' to filter. Use focused filenames, headings, identifiers, path words, or domain terms.
`;

        // Define available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const startupIndexNotice = getCurrentDirectoryIndexNotice(
                this.snapshotManager,
            );
            const fullToolListNotice =
                startupIndexNotice ?? CURRENT_DIRECTORY_INDEXED_NOTICE;
            const indexedToolListNotice = startupIndexNotice
                ? undefined
                : CURRENT_DIRECTORY_INDEXED_NOTICE;
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
                            description: UNINDEXED_TOOL_LIST_NOTICE,
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
                            fullToolListNotice,
                        ),
                        inputSchema: indexCodebaseInputSchema,
                    },
                    {
                        name: "search_context",
                        description: prependStartupIndexNotice(
                            search_description,
                            fullToolListNotice,
                        ),
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: "Absolute indexed directory/context root to search.",
                                },
                                query: {
                                    type: "string",
                                    description:
                                        "Focused query; include filenames, headings, identifiers, path words, or domain terms when useful.",
                                },
                                limit: {
                                    type: "number",
                                    default: 10,
                                    description:
                                        "Maximum results. Default to 10; change only when the user explicitly asks for more or fewer.",
                                },
                                scope: {
                                    type: "string",
                                    enum: [
                                        "all",
                                        "docs",
                                        "code",
                                    ],
                                    description:
                                        "Optional scope: all by default, docs for docs only, code for code only.",
                                    default: "all",
                                },
                            },
                            required: ["path", "query"],
                            additionalProperties: false,
                        },
                    },
                    {
                        name: "clear_index",
                        description: prependStartupIndexNotice(
                            "Clear the search index for an absolute directory/context root.",
                            indexedToolListNotice,
                        ),
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: "Absolute directory/context root to clear.",
                                },
                            },
                            required: ["path"],
                        },
                    },
                    {
                        name: "get_indexing_status",
                        description: prependStartupIndexNotice(
                            "Get indexing status for an absolute directory/context root, including active progress or completion.",
                            indexedToolListNotice,
                        ),
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: "Absolute directory/context root to check.",
                                },
                                refresh: {
                                    type: "boolean",
                                    description:
                                        "Defaults to false for fast local snapshot/job status. True probes the vector database and recovers remote collection/manifest state.",
                                    default: false,
                                },
                                details: {
                                    type: "boolean",
                                    description:
                                        "Defaults to false. True lists files and effective-line increases from an oversized automatic incremental-sync warning.",
                                    default: false,
                                },
                            },
                            required: ["path"],
                        },
                    },
                    {
                        name: "repair_index_manifest",
                        description: prependStartupIndexNotice(
                            "Migrate or repair a legacy remote manifest by scanning chunk metadata once and writing the index manifest. Use only when get_indexing_status reports a missing remote manifest for an existing collection.",
                            indexedToolListNotice,
                        ),
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: "Absolute directory/context root whose remote manifest to repair.",
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
