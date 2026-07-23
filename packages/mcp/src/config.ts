import {
    configManager,
    DEFAULT_COLLECTION_LEASE_HEARTBEAT_MS,
    DEFAULT_COLLECTION_LEASE_MISS_LIMIT,
} from "@hitmux/hitmux-context-engine-core";
import type {
    CodebaseIdentityMode,
    IncrementalIndexFileChange,
} from "@hitmux/hitmux-context-engine-core";

export interface ContextMcpConfig {
    name: string;
    version: string;
    // Embedding provider configuration
    embeddingProvider:
        | "OpenAI"
        | "VoyageAI"
        | "Gemini"
        | "Ollama"
        | "OpenRouter";
    embeddingModel: string;
    // Provider-specific API keys
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    voyageaiApiKey?: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    // OpenRouter configuration
    openrouterApiKey?: string;
    embeddingUseSystemProxy: boolean;
    // External rerank configuration
    rerankEnabled?: boolean;
    rerankModel?: string;
    rerankBaseUrl?: string;
    rerankApiKey?: string;
    rerankCandidateLimit?: number;
    rerankTimeoutMs?: number;
    rerankMaxCharsPerDocument?: number;
    rerankUseSystemProxy?: boolean;
    // Ollama configuration
    ollamaModel?: string;
    ollamaHost?: string;
    // Vector database configuration
    milvusAddress?: string; // Optional, can be auto-resolved from token
    milvusToken?: string;
    databaseUseSystemProxy: boolean;
    collectionLeaseEnabled?: boolean;
    collectionLeaseHeartbeatMs?: number;
    collectionLeaseMissLimit?: number;
    collectionNameOverride?: string;
    codebaseIdentityMode?: CodebaseIdentityMode;
    codebaseIdentity?: string;
    globalCollectionName?: string;
    gitRemoteName?: string;
}

// Legacy format (v1) - for backward compatibility
export interface CodebaseSnapshotV1 {
    indexedCodebases: string[];
    indexingCodebases: string[] | Record<string, number>; // Array (legacy) or Map of codebase path to progress percentage
    lastUpdated: string;
}

// New format (v2) - structured with codebase information

export type RequestSplitterType = "ast" | "langchain";
export type CodebaseStatsSource = "index_run" | "collection_row_count" | "remote_manifest";

// Request-level indexing options stored with a codebase's snapshot entry.
export interface CodebaseIndexOptions {
    requestSplitter?: RequestSplitterType;
    requestCustomExtensions?: string[];
    requestIgnorePatterns?: string[];
    requestIgnoreFiles?: string[];
    requestMaxDepth?: number;
}

// Base interface for common fields
interface CodebaseInfoBase extends CodebaseIndexOptions {
    lastUpdated: string;
}

// Indexing state - when indexing is in progress
export interface CodebaseInfoIndexing extends CodebaseInfoBase {
    status: "indexing";
    indexingPercentage: number; // Current progress percentage
}

// Indexed state - when indexing completed successfully
export interface CodebaseInfoIndexed extends CodebaseInfoBase {
    status: "indexed";
    indexedFiles: number; // Number of files indexed
    totalChunks: number; // Total number of chunks generated
    indexStatus: "completed" | "limit_reached"; // Status from indexing result
    statsSource?: CodebaseStatsSource; // Missing means a normal full index from older snapshots
    syncWarning?: string; // Warning from automatic incremental sync while preserving the existing index
    syncWarningDetails?: IncrementalIndexFileChange[]; // Affected files from an oversized automatic incremental sync
}

// Index failed state - when indexing failed
export interface CodebaseInfoIndexFailed extends CodebaseInfoBase {
    status: "indexfailed";
    errorMessage: string; // Error message from the failure
    lastAttemptedPercentage?: number; // Progress when failure occurred
}

// Union type for all codebase information states
export type CodebaseInfo =
    | CodebaseInfoIndexing
    | CodebaseInfoIndexed
    | CodebaseInfoIndexFailed;

export interface CodebaseSnapshotV2 {
    formatVersion: "v2";
    codebases: Record<string, CodebaseInfo>; // codebasePath -> CodebaseInfo
    removedCodebases?: Record<string, string>; // codebasePath -> removal timestamp tombstone
    lastUpdated: string;
}

// Union type for all supported formats
export type CodebaseSnapshot = CodebaseSnapshotV1 | CodebaseSnapshotV2;

// Helper function to get default model for each provider
export function getDefaultModelForProvider(provider: string): string {
    switch (provider) {
        case "OpenAI":
            return "text-embedding-3-small";
        case "VoyageAI":
            return "voyage-code-3";
        case "Gemini":
            return "gemini-embedding-001";
        case "OpenRouter":
            return "qwen/qwen3-embedding-4b";
        case "Ollama":
            return "nomic-embed-text";
        default:
            return "text-embedding-3-small";
    }
}

// Helper function to get embedding model with provider-specific config priority
export function getEmbeddingModelForProvider(provider: string): string {
    switch (provider) {
        case "Ollama": {
            const ollamaModel =
                configManager.getString("ollamaModel") ||
                configManager.getString("embeddingModel") ||
                getDefaultModelForProvider(provider);
            console.log(
                `[DEBUG] Ollama model selection: ollamaModel=${configManager.getString("ollamaModel") || "NOT SET"}, embeddingModel=${configManager.getString("embeddingModel") || "NOT SET"}, selected=${ollamaModel}`,
            );
            return ollamaModel;
        }
        case "OpenAI":
        case "VoyageAI":
        case "Gemini":
        case "OpenRouter":
        default: {
            const selectedModel =
                configManager.getString("embeddingModel") ||
                getDefaultModelForProvider(provider);
            console.log(
                `[DEBUG] ${provider} model selection: embeddingModel=${configManager.getString("embeddingModel") || "NOT SET"}, selected=${selectedModel}`,
            );
            return selectedModel;
        }
    }
}

export function getBooleanFromConfig(
    name: Parameters<typeof configManager.getBoolean>[0],
    defaultValue: boolean,
): boolean {
    const rawValue = configManager.getBoolean(name);
    if (rawValue === undefined) {
        return defaultValue;
    }

    return rawValue;
}

function getUrlFromConfig(
    name: Parameters<typeof configManager.getString>[0],
): string | undefined {
    const rawValue = configManager.getString(name);
    if (!rawValue) {
        return undefined;
    }

    const trimmedValue = rawValue.trim();
    try {
        const url = new URL(trimmedValue);
        if (url.protocol === "http:" || url.protocol === "https:") {
            return trimmedValue.replace(/\/+$/, "");
        }
    } catch {
        // fall through to warning below
    }

    console.warn(
        `[DEBUG] Ignoring invalid config.${name}: ${rawValue}. Expected an http(s) URL.`,
    );
    return undefined;
}

function getCodebaseIdentityModeFromConfig(): CodebaseIdentityMode | undefined {
    const mode = configManager.getString("codebaseIdentityMode");
    if (!mode) {
        return undefined;
    }

    if (
        mode === "path" ||
        mode === "gitRemote" ||
        mode === "global" ||
        mode === "custom"
    ) {
        return mode;
    }

    console.warn(
        `[DEBUG] Ignoring invalid config.codebaseIdentityMode: ${mode}. Expected path, gitRemote, global, or custom.`,
    );
    return undefined;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : fallback;
}

function getCollectionLeaseHeartbeatMs(): number {
    const value = configManager.getNumber("collectionLeaseHeartbeatMs");
    if (value === undefined) {
        return DEFAULT_COLLECTION_LEASE_HEARTBEAT_MS;
    }
    if (Number.isInteger(value) && value > 0) {
        return value;
    }
    console.warn(
        `[DEBUG] Ignoring invalid config.collectionLeaseHeartbeatMs: ${value}. Expected a positive integer.`,
    );
    return DEFAULT_COLLECTION_LEASE_HEARTBEAT_MS;
}

function getCollectionLeaseMissLimit(): number {
    const value = configManager.getNumber("collectionLeaseMissLimit");
    if (value === undefined) {
        return DEFAULT_COLLECTION_LEASE_MISS_LIMIT;
    }
    if (Number.isInteger(value) && value >= 2) {
        return value;
    }
    console.warn(
        `[DEBUG] Ignoring invalid config.collectionLeaseMissLimit: ${value}. Expected an integer of at least 2.`,
    );
    return DEFAULT_COLLECTION_LEASE_MISS_LIMIT;
}

export function getEmbeddingBaseUrlForRerank(
    config: Pick<ContextMcpConfig, "embeddingProvider" | "openaiBaseUrl" | "geminiBaseUrl">,
): string | undefined {
    switch (config.embeddingProvider) {
        case "OpenAI":
            return config.openaiBaseUrl;
        case "Gemini":
            return config.geminiBaseUrl;
        case "OpenRouter":
            return "https://openrouter.ai/api/v1";
        default:
            return undefined;
    }
}

export function getEmbeddingApiKeyForRerank(
    config: Pick<ContextMcpConfig, "embeddingProvider" | "openaiApiKey" | "voyageaiApiKey" | "geminiApiKey" | "openrouterApiKey">,
): string | undefined {
    switch (config.embeddingProvider) {
        case "OpenAI":
            return config.openaiApiKey;
        case "VoyageAI":
            return config.voyageaiApiKey;
        case "Gemini":
            return config.geminiApiKey;
        case "OpenRouter":
            return config.openrouterApiKey || config.openaiApiKey;
        default:
            return undefined;
    }
}

export function createMcpConfig(defaultServerVersion = "0.0.0"): ContextMcpConfig {
    console.log(
        `[DEBUG] Global config file: ${configManager.getGlobalConfigFilePath()}`,
    );
    console.log(
        `[DEBUG] Project config file: ${configManager.getProjectConfigFilePath()}`,
    );
    console.log(
        `[DEBUG] embeddingProvider: ${configManager.getString("embeddingProvider") || "NOT SET"}`,
    );
    console.log(
        `[DEBUG] embeddingModel: ${configManager.getString("embeddingModel") || "NOT SET"}`,
    );
    console.log(
        `[DEBUG] ollamaModel: ${configManager.getString("ollamaModel") || "NOT SET"}`,
    );
    console.log(
        `[DEBUG] geminiApiKey: ${configManager.getString("geminiApiKey") ? "Configured" : "Missing"}`,
    );
    console.log(
        `[DEBUG] openaiApiKey: ${configManager.getString("openaiApiKey") ? "Configured" : "Missing"}`,
    );
    console.log(
        `[DEBUG] milvusAddress: ${configManager.getString("milvusAddress") || "NOT SET"}`,
    );
    console.log(
        `[DEBUG] embeddingUseSystemProxy: ${getBooleanFromConfig("embeddingUseSystemProxy", false)}`,
    );
    console.log(
        `[DEBUG] rerankEnabled: ${getBooleanFromConfig("rerankEnabled", true)}`,
    );
    console.log(
        `[DEBUG] rerankApiKey: ${configManager.getString("rerankApiKey") ? "Configured" : "Missing"}`,
    );
    console.log(
        `[DEBUG] databaseUseSystemProxy: ${getBooleanFromConfig("databaseUseSystemProxy", false)}`,
    );
    console.log(
        `[DEBUG] collectionNameOverride: ${configManager.getString("collectionNameOverride") || "NOT SET"}`,
    );
    console.log(
        `[DEBUG] collectionLeaseEnabled: ${getBooleanFromConfig("collectionLeaseEnabled", true)}`,
    );

    const embeddingProvider = configManager.getString("embeddingProvider") as
        | "OpenAI"
        | "VoyageAI"
        | "Gemini"
        | "Ollama"
        | "OpenRouter"
        | undefined;
    const config: ContextMcpConfig = {
        name:
            configManager.getString("mcpServerName") ||
            "Hitmux Context Engine MCP Server",
        version: configManager.getString("mcpServerVersion") || defaultServerVersion,
        // Embedding provider configuration
        embeddingProvider: embeddingProvider || "OpenRouter",
        embeddingModel: getEmbeddingModelForProvider(
            embeddingProvider || "OpenRouter",
        ),
        // Provider-specific API keys
        openaiApiKey: configManager.getString("openaiApiKey"),
        openaiBaseUrl: getUrlFromConfig("openaiBaseUrl"),
        voyageaiApiKey: configManager.getString("voyageaiApiKey"),
        geminiApiKey: configManager.getString("geminiApiKey"),
        geminiBaseUrl: getUrlFromConfig("geminiBaseUrl"),
        // OpenRouter configuration
        openrouterApiKey: configManager.getString("openrouterApiKey"),
        embeddingUseSystemProxy: getBooleanFromConfig(
            "embeddingUseSystemProxy",
            false,
        ),
        // External rerank configuration
        rerankEnabled: getBooleanFromConfig("rerankEnabled", true),
        rerankModel:
            configManager.getString("rerankModel") || "cohere/rerank-4-fast",
        rerankBaseUrl: getUrlFromConfig("rerankBaseUrl"),
        rerankApiKey: configManager.getString("rerankApiKey"),
        rerankCandidateLimit: normalizePositiveInteger(
            configManager.getNumber("rerankCandidateLimit"),
            100,
        ),
        rerankTimeoutMs: normalizePositiveInteger(
            configManager.getNumber("rerankTimeoutMs"),
            8000,
        ),
        rerankMaxCharsPerDocument: normalizePositiveInteger(
            configManager.getNumber("rerankMaxCharsPerDocument"),
            6000,
        ),
        rerankUseSystemProxy: getBooleanFromConfig(
            "rerankUseSystemProxy",
            getBooleanFromConfig("embeddingUseSystemProxy", false),
        ),
        // Ollama configuration
        ollamaModel: configManager.getString("ollamaModel"),
        ollamaHost: configManager.getString("ollamaHost"),
        // Vector database configuration - address can be auto-resolved from token
        milvusAddress: configManager.getString("milvusAddress"), // Optional, can be resolved from token
        milvusToken: configManager.getString("milvusToken"),
        databaseUseSystemProxy: getBooleanFromConfig(
            "databaseUseSystemProxy",
            false,
        ),
        collectionLeaseEnabled: getBooleanFromConfig("collectionLeaseEnabled", true),
        collectionLeaseHeartbeatMs: getCollectionLeaseHeartbeatMs(),
        collectionLeaseMissLimit: getCollectionLeaseMissLimit(),
        collectionNameOverride: configManager.getString(
            "collectionNameOverride",
        ),
        codebaseIdentityMode: getCodebaseIdentityModeFromConfig(),
        codebaseIdentity: configManager.getString("codebaseIdentity"),
        globalCollectionName: configManager.getString("globalCollectionName"),
        gitRemoteName: configManager.getString("gitRemoteName"),
    };

    return config;
}

export function logConfigurationSummary(config: ContextMcpConfig): void {
    // Log configuration summary before starting server
    console.log(`[MCP] Starting Hitmux Context Engine MCP Server`);
    console.log(`[MCP] Configuration Summary:`);
    console.log(`[MCP] Server: ${config.name} v${config.version}`);
    console.log(`[MCP] Embedding Provider: ${config.embeddingProvider}`);
    console.log(`[MCP] Embedding Model: ${config.embeddingModel}`);
    console.log(
        `[MCP] Embedding System Proxy: ${config.embeddingUseSystemProxy ? "enabled" : "disabled"}`,
    );
    const rerankEnabled = config.rerankEnabled !== false;
    console.log(`[MCP] Rerank: ${rerankEnabled ? "enabled" : "disabled"}`);
    if (rerankEnabled) {
        console.log(`[MCP] Rerank Model: ${config.rerankModel || "cohere/rerank-4-fast"}`);
        console.log(
            `[MCP] Rerank API Key: ${config.rerankApiKey ? "Configured" : "Using embedding provider key if available"}`,
        );
        if (config.rerankBaseUrl) {
            console.log(`[MCP] Rerank Base URL: ${config.rerankBaseUrl}`);
        }
    }
    console.log(
        `[MCP] Milvus Address: ${config.milvusAddress || (config.milvusToken ? "[Auto-resolve from token]" : "[Not configured]")}`,
    );
    console.log(
        `[MCP] Database System Proxy: ${config.databaseUseSystemProxy ? "enabled" : "disabled"}`,
    );
    console.log(
        `[MCP] Collection lease: ${config.collectionLeaseEnabled ? `enabled (${config.collectionLeaseHeartbeatMs}ms x ${config.collectionLeaseMissLimit})` : "disabled"}`,
    );
    if (config.collectionNameOverride) {
        console.log(`[MCP] Collection Name Override: Configured`);
    }
    console.log(
        `[MCP] Codebase Identity Mode: ${config.codebaseIdentityMode || "path"}`,
    );
    if (config.codebaseIdentity) {
        console.log(`[MCP] Codebase Identity: Configured`);
    }

    // Log provider-specific configuration without exposing sensitive data
    switch (config.embeddingProvider) {
        case "OpenAI":
            console.log(
                `[MCP] OpenAI API Key: ${config.openaiApiKey ? "Configured" : "Missing"}`,
            );
            if (config.openaiBaseUrl) {
                console.log(`[MCP] OpenAI Base URL: ${config.openaiBaseUrl}`);
            }
            break;
        case "VoyageAI":
            console.log(
                `[MCP] VoyageAI API Key: ${config.voyageaiApiKey ? "Configured" : "Missing"}`,
            );
            break;
        case "Gemini":
            console.log(
                `[MCP] Gemini API Key: ${config.geminiApiKey ? "Configured" : "Missing"}`,
            );
            if (config.geminiBaseUrl) {
                console.log(`[MCP] Gemini Base URL: ${config.geminiBaseUrl}`);
            }
            break;
        case "OpenRouter":
            console.log(
                `[MCP] OpenRouter API Key: ${config.openrouterApiKey ? "Configured" : "Missing"}`,
            );
            break;
        case "Ollama":
            console.log(
                `[MCP] Ollama Host: ${config.ollamaHost || "http://127.0.0.1:11434"}`,
            );
            console.log(`[MCP] Ollama Model: ${config.embeddingModel}`);
            break;
    }

    console.log(`[MCP] Initializing server components...`);
}

export function showHelpMessage(): void {
    console.log(`
Hitmux Context Engine MCP Server

Usage:
 npx @hitmux/hce@latest [options]
 npx @hitmux/hitmux-context-engine-mcp@latest [options]

Options:
 --help, -h Show this help message

Test commands:
 hce test                 Test embedding and vector database connectivity
 hce test embedding       Test the configured embedding provider
 hce test vectordb        Test the configured Milvus/Zilliz connection

Index management commands:
 hce list                 List collections in the configured database
 hce list <name|path>     Show details for one collection or repo path
 hce rm <name|path>       Delete one collection by collection name or repo path
 hce index                Sync or create the index for the current directory
 hce index <name|path>    Sync or create by collection name or repo path
 hce index --all --force  Force rebuild all known repo indexes

Configuration:
 Runtime configuration is read from both files, with project config overriding
 global config for matching fields:
 ~/.hitmux-context-engine/config.conf
 ./.hitmux-context-engine/config.conf

 Environment variables and ~/.hitmux-context-engine/.env are not used for
 Hitmux Context Engine options.

Safety override environment variable:
 HITMUX_CONTEXT_ENGINE_SKIP_EMBEDDING_MODEL_CHECK=true
 Bypass collection embedding metadata mismatch errors.

Common config.conf fields:
 mcpServerName Server name
 mcpServerVersion Server version
 Embedding Provider Configuration:
 embeddingProvider Embedding provider: OpenAI, VoyageAI, Gemini, Ollama, OpenRouter (default: OpenRouter)
 embeddingModel Embedding model name (works for all providers)
 embeddingBatchSize Embedding batch size for index operations (default: provider/model-specific)
 embeddingConcurrency Embedding request concurrency for index operations (default: provider/model-specific)
  Provider-specific API Keys:
 openaiApiKey OpenAI API key (required for OpenAI provider)
 openaiBaseUrl OpenAI-compatible API base URL (optional, for custom endpoints)
 voyageaiApiKey VoyageAI API key (required for VoyageAI provider)
 geminiApiKey Google AI API key (required for Gemini provider)
 geminiBaseUrl Gemini API base URL (optional, for custom endpoints)
 openrouterApiKey OpenRouter API key (required for OpenRouter provider)
 embeddingUseSystemProxy
 Allow embedding providers to inherit system proxy
 environment variables (default: false)

 Rerank Configuration:
 rerankEnabled Enable external rerank after initial search recall (default: true)
 rerankModel Rerank model name (default: cohere/rerank-4-fast)
 rerankBaseUrl Rerank API base URL; /rerank is appended automatically
 rerankApiKey Rerank API key (defaults to embedding provider key)
 rerankCandidateLimit Candidates sent to rerank, capped at 100 (default: 100)
 rerankTimeoutMs Rerank timeout in milliseconds (default: 8000)
 rerankMaxCharsPerDocument Max characters per rerank document (default: 6000)
 rerankUseSystemProxy
 Allow rerank requests to inherit system proxy variables
 (default: follows embeddingUseSystemProxy)

 Ollama Configuration:
 ollamaHost Ollama server host (default: http://127.0.0.1:11434)
 ollamaModel Ollama model name (preferred over embeddingModel for Ollama)
  Vector Database Configuration:
 milvusAddress Milvus address (optional, can be auto-resolved from token)
 milvusToken Milvus token (optional, used for authentication and address resolution)
 databaseUseSystemProxy
 Allow Milvus/Zilliz connections to inherit system
 proxy environment variables (default: false)
 collectionNameOverride
 Optional readable prefix for collection names.
 Uses code_chunks_<override>_<identityHash> (or hybrid_...)
 after sanitization (letters/digits/underscore, 255 chars max).
 codebaseIdentityMode
 Collection identity mode: path, gitRemote, global, or custom.
 Default is path. gitRemote keys collections by remote URL
 when a .git/config remote is found, then falls back to path.
 global shares one collection across all indexed paths.
 custom uses codebaseIdentity.
 codebaseIdentity
 Explicit shared identity string for custom mode.
 globalCollectionName
 Name for global mode shared collections (default: default).
 gitRemoteName
 Git remote name for gitRemote mode (default: origin).

 MCP Sync Configuration:
 autoIndexing
 Enable/disable all automatic re-indexing, including
 startup polling, periodic polling, and trigger-file
 sync (default: true).
 interactiveIndexing
 Enable/disable index_codebase writes through MCP.
 Set to false to allow dryRun previews while blocking
 interactive indexing (default: true).
 backgroundSync
 Enable/disable startup + periodic background sync
 for indexed codebases (default: true). Set to false
 to disable polling while keeping trigger-based and
 project-watcher event sync.
 syncIntervalMs
 Background sync interval in milliseconds when enabled
 (default: 120000).

 Sync Trigger Watcher:
 triggerWatcher
 Enable/disable the ~/.hitmux-context-engine/.sync-trigger filesystem
 watcher (default: true). When enabled, touching the
 trigger file kicks off an immediate, debounced re-index.
 Triggered syncs share the same global cross-process
 lock as background sync, so multi-instance setups stay
 coordinated. Set to false to disable filesystem
 watching entirely (read-only / sandboxed environments).

Example config.conf:
 embeddingProvider = OpenRouter
 embeddingModel = qwen/qwen3-embedding-4b
 # embeddingBatchSize = 64
 # embeddingConcurrency = 2
 openrouterApiKey = sk-or-xxx
 # rerankEnabled = true
 # rerankModel = cohere/rerank-4-fast
 # rerankCandidateLimit = 100
 milvusAddress = localhost:19530
 milvusToken = your-token
 embeddingUseSystemProxy = false
 databaseUseSystemProxy = false
 backgroundSync = true
 syncIntervalMs = 120000
 projectWatcher = true
 projectWatcherDebounceMs = 1000
 projectWatcherFallbackScanIntervalMs = 600000
 # projectWatcherIgnoredDirs = node_modules
 # projectWatcherIgnoredDirs = dist
 # projectWatcherIgnoredDirs = build

Start:
 npx @hitmux/hce@latest
 npx @hitmux/hitmux-context-engine-mcp@latest
 `);
}
