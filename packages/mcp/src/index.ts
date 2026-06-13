#!/usr/bin/env node

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
console.log = (...args: any[]) => {
    process.stderr.write('[LOG] ' + args.join(' ') + '\n');
};

console.warn = (...args: any[]) => {
    process.stderr.write('[WARN] ' + args.join(' ') + '\n');
};

// console.error already goes to stderr by default

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { Context, configManager } from "@hitmux/hitmux-context-engine-core";
import { MilvusVectorDatabase } from "@hitmux/hitmux-context-engine-core";

// Import our modular components
import { createMcpConfig, logConfigurationSummary, showHelpMessage, ContextMcpConfig } from "./config.js";
import { createEmbeddingInstance, logEmbeddingProviderInfo } from "./embedding.js";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";
import { ToolHandlers } from "./handlers.js";

class ContextMcpServer {
    private server: Server;
    private snapshotManager: SnapshotManager;
    private runtime: {
        context: Context;
        syncManager: SyncManager;
        toolHandlers: ToolHandlers;
        backgroundSyncStarted: boolean;
        snapshotValidated: boolean;
    } | null = null;
    private runtimePromise: Promise<NonNullable<ContextMcpServer["runtime"]>> | null = null;

    constructor() {
        // Initialize MCP server
        this.server = new Server(
            {
                name: "Hitmux Context Engine MCP Server",
                version: "1.0.0"
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        this.snapshotManager = new SnapshotManager();
        this.snapshotManager.loadCodebaseSnapshot();

        this.setupTools();
    }

    private formatRuntimeInitializationError(error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{
                type: "text",
                text: `Error initializing Hitmux Context Engine runtime: ${message}`
            }],
            isError: true
        };
    }

    private getConfigReadError(): Error | null {
        const errors = configManager.getReadErrors(process.cwd());
        if (errors.length === 0) {
            return null;
        }

        const details = errors
            .map((error) => `${error.path}: ${error.message}`)
            .join("\n");
        return new Error(`Invalid config.jsonc. Fix the configuration before using MCP tools.\n${details}`);
    }

    private async getRuntime(): Promise<NonNullable<ContextMcpServer["runtime"]>> {
        if (this.runtime) {
            return this.runtime;
        }

        if (this.runtimePromise) {
            return this.runtimePromise;
        }

        this.runtimePromise = Promise.resolve().then(async () => {
            const configError = this.getConfigReadError();
            if (configError) {
                throw configError;
            }

            const config = createMcpConfig();
            logConfigurationSummary(config);

            const runtime = await this.createRuntime(config);
            this.runtime = runtime;
            return runtime;
        }).finally(() => {
            this.runtimePromise = null;
        });

        return this.runtimePromise;
    }

    private async createRuntime(config: ContextMcpConfig): Promise<NonNullable<ContextMcpServer["runtime"]>> {
        // Initialize embedding provider
        console.log(`[EMBEDDING] Initializing embedding provider: ${config.embeddingProvider}`);
        console.log(`[EMBEDDING] Using model: ${config.embeddingModel}`);

        const embedding = createEmbeddingInstance(config);
        logEmbeddingProviderInfo(config, embedding);

        // Initialize vector database
        const vectorDatabase = new MilvusVectorDatabase({
            address: config.milvusAddress,
            ...(config.milvusToken && { token: config.milvusToken })
        });

        // Initialize Hitmux Context Engine
        const context = new Context({
            embedding,
            vectorDatabase,
            collectionNameOverride: config.collectionNameOverride,
            collectionIdentity: {
                mode: config.codebaseIdentityMode,
                customIdentity: config.codebaseIdentity,
                globalName: config.globalCollectionName,
                gitRemoteName: config.gitRemoteName
            }
        });

        // Initialize managers
        const syncManager = new SyncManager(context, this.snapshotManager);
        const toolHandlers = new ToolHandlers(context, this.snapshotManager);

        return {
            context,
            syncManager,
            toolHandlers,
            backgroundSyncStarted: false,
            snapshotValidated: false
        };
    }

    private setupTools() {
        const index_description = `
Index a codebase directory to enable semantic search using a configurable code splitter.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path to the target codebase.

✨ **Usage Guidance**:
- This tool is typically used when search fails due to an unindexed codebase.
- Before first indexing, create a project ignore file such as .hceignore when generated, large, or private paths should be excluded.
- The indexer automatically loads .*ignore files it finds in the project tree, including .hceignore, .gitignore, and .cursorignore. Use ignoreFiles only for extra non-default ignore file paths.
- For an already indexed codebase, use incremental=true to manually sync changed files without rebuilding the full index.
- If indexing is attempted on an already indexed path, and a conflict is detected, you MUST prompt the user to confirm whether to proceed with a force index (i.e., re-indexing and overwriting the previous index).
`;


        const search_description = `
Search the indexed codebase with code-search style queries within a specified absolute path.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path.
- Do NOT pass a broad natural-language sentence as the only query when the user is asking where behavior is implemented.
- Rewrite natural-language requests into focused code-search terms before calling this tool.

🎯 **When to Use**:
This tool is versatile and can be used before completing various tasks to retrieve relevant context:
- **Code search**: Find specific functions, classes, or implementations
- **Context-aware assistance**: Gather relevant code context before making changes
- **Issue identification**: Locate problematic code sections or bugs
- **Code review**: Understand existing implementations and patterns
- **Refactoring**: Find all related code pieces that need to be updated
- **Feature development**: Understand existing architecture and similar implementations
- **Duplicate detection**: Identify redundant or duplicated code patterns across the codebase

✨ **Usage Guidance**:
- If the codebase is not indexed, this tool will return a clear error message indicating that indexing is required first and recommending a project ignore file such as .hceignore.
- You can then use the index_codebase tool to index the codebase before searching again.
- For natural-language discovery tasks, generate one focused query per likely implementation angle instead of one broad sentence.
- Include likely identifiers, class/function names, file names, path segments, and English code/domain terms.
- Include scope hints such as client, server, shared, UI, network, rendering, storage, validation, worker, or route when relevant.
- Prefer several short searches and compare their results by path, symbol, and content evidence.

✅ **Good query style**:
- "authentication middleware token validation"
- "AuthMiddleware validateToken bearer token"
- "src/auth middleware token validation"
- "database migration schema version rollback"

❌ **Poor query style**:
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
                                    description: `ABSOLUTE path to the codebase directory to index.`
                                },
                                force: {
                                    type: "boolean",
                                    description: "Force re-indexing even if already indexed",
                                    default: false
                                },
                                incremental: {
                                    type: "boolean",
                                    description: "Manually sync changed files for an already indexed codebase without dropping or rebuilding the full index. Use this after reviewing a large automatic incremental-sync warning. Cannot be combined with force=true or dryRun=true.",
                                    default: false
                                },
                                splitter: {
                                    type: "string",
                                    description: "Code splitter to use: 'ast' for syntax-aware splitting with automatic fallback, 'langchain' for character-based splitting",
                                    enum: ["ast", "langchain"],
                                    default: "ast"
                                },
                                customExtensions: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Additional file extensions to include beyond defaults (e.g., ['.vue', '.svelte', '.astro']). Extensions should include the dot prefix or will be automatically added",
                                    default: []
                                },
                                ignorePatterns: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Additional ignore patterns to exclude specific files/directories beyond defaults. Only include this parameter if the user explicitly requests custom ignore patterns (e.g., ['static/**', '*.tmp', 'private/**'])",
                                    default: []
                                },
                                ignoreFiles: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Additional ignore files to load beyond automatically discovered .*ignore files. Relative paths are resolved from the codebase root (e.g., ['config/index.ignore']).",
                                    default: []
                                },
                                maxDepth: {
                                    type: "number",
                                    description: "Optional: Maximum directory depth to traverse from the codebase root. 0 indexes only files directly in the root.",
                                    minimum: 0
                                },
                                dryRun: {
                                    type: "boolean",
                                    description: "Preview the files that would be indexed without creating collections, embedding, or writing index data.",
                                    default: false
                                }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "search_code",
                        description: search_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to search in.`
                                },
                                query: {
                                    type: "string",
                                    description: "Focused code-search query. Rewrite natural-language requests into likely identifiers, filenames, path words, English domain terms, and scope hints. Prefer multiple short searches over one broad sentence."
                                },
                                limit: {
                                    type: "number",
                                    description: "Optional override for the maximum number of results to return. Leave empty for the bounded default result set; use a specific value only when you need more or fewer results."
                                },
                                extensionFilter: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: List of file extensions to filter results. (e.g., ['.ts','.py']).",
                                    default: []
                                }
                            },
                            required: ["path", "query"]
                        }
                    },
                    {
                        name: "clear_index",
                        description: `Clear the search index. IMPORTANT: You MUST provide an absolute path.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to clear.`
                                }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "get_indexing_status",
                        description: `Get the current indexing status of a codebase. Shows progress percentage for actively indexing codebases and completion status for indexed codebases.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to check status for.`
                                }
                            },
                            required: ["path"]
                        }
                    },
                ]
            };
        });

        // Handle tool execution
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            let runtime: NonNullable<ContextMcpServer["runtime"]>;
            try {
                runtime = await this.getRuntime();
                if (!runtime.snapshotValidated) {
                    await runtime.toolHandlers.validateLegacyZeroEntries();
                    await runtime.toolHandlers.validateIndexedCollections();
                    runtime.snapshotValidated = true;
                }
                if (!runtime.backgroundSyncStarted) {
                    console.log('[SYNC-DEBUG] Initializing background sync after first successful runtime initialization...');
                    runtime.syncManager.startBackgroundSync();
                    runtime.backgroundSyncStarted = true;
                }
            } catch (error) {
                return this.formatRuntimeInitializationError(error);
            }

            switch (name) {
                case "index_codebase":
                    return await runtime.toolHandlers.handleIndexCodebase(args);
                case "search_code":
                    return await runtime.toolHandlers.handleSearchCode(args);
                case "clear_index":
                    return await runtime.toolHandlers.handleClearIndex(args);
                case "get_indexing_status":
                    return await runtime.toolHandlers.handleGetIndexingStatus(args);

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }

    async start() {
        console.log('[SYNC-DEBUG] MCP server start() method called');
        console.log('Starting Context MCP server...');

        const transport = new StdioServerTransport();
        console.log('[SYNC-DEBUG] StdioServerTransport created, attempting server connection...');

        await this.server.connect(transport);
        console.log("MCP server started and listening on stdio.");
        console.log('[SYNC-DEBUG] Server connection established successfully');
        console.log('[SYNC-DEBUG] MCP protocol ready. Runtime config will be loaded on first tool call.');
    }
}

// Main execution
async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);

    // Show help if requested
    if (args.includes('--help') || args.includes('-h')) {
        showHelpMessage();
        process.exit(0);
    }

    const server = new ContextMcpServer();
    await server.start();
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.error("Received SIGINT, shutting down gracefully...");
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.error("Received SIGTERM, shutting down gracefully...");
    process.exit(0);
});

// Always start the server - this is designed to be the main entry point
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
