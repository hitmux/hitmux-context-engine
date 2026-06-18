import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type EmbeddingProviderName = 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama' | 'OpenRouter';

export interface HitmuxConfig {
    mcpServerName?: string;
    mcpServerVersion?: string;
    embeddingProvider?: EmbeddingProviderName;
    embeddingModel?: string;
    embeddingBatchSize?: number;
    embeddingConcurrency?: number;
    fileProcessingConcurrency?: number;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    voyageaiApiKey?: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openrouterApiKey?: string;
    embeddingUseSystemProxy?: boolean;
    ollamaModel?: string;
    ollamaHost?: string;
    milvusAddress?: string;
    milvusToken?: string;
    databaseUseSystemProxy?: boolean;
    milvusUseRestful?: boolean;
    milvusCollectionLimitCheckTimeoutMs?: number;
    zillizBaseUrl?: string;
    collectionNameOverride?: string;
    codebaseIdentityMode?: 'path' | 'gitRemote' | 'global' | 'custom';
    codebaseIdentity?: string;
    globalCollectionName?: string;
    gitRemoteName?: string;
    hybridMode?: boolean;
    searchTimeoutMs?: number;
    customExtensions?: string[];
    customIgnorePatterns?: string[];
    merkleSnapshotMaxBytes?: number;
    automaticIncrementalEffectiveLineLimit?: number;
    autoIndexing?: boolean;
    interactiveIndexing?: boolean;
    backgroundSync?: boolean;
    vectorDatabaseSyncTimeoutMs?: number;
    syncIntervalMs?: number;
    syncLockStaleMs?: number;
    triggerWatcher?: boolean;
    projectWatcher?: boolean;
    projectWatcherDebounceMs?: number;
    projectWatcherUsePolling?: boolean;
    projectWatcherFallbackScanIntervalMs?: number;
    projectWatcherIgnoredDirs?: string[];
    splitterType?: string;
    searchTopK?: number;
    searchThreshold?: number;
}

export type HitmuxConfigKey = keyof HitmuxConfig;

export interface ConfigReadError {
    path: string;
    message: string;
}

export interface EnsureConfigFileResult {
    path: string;
    created: boolean;
    updated: boolean;
    appendedKeys: HitmuxConfigKey[];
}

export class ConfigManager {
    getConfigFilePath(): string {
        return this.getGlobalConfigFilePath();
    }

    getGlobalConfigFilePath(): string {
        return path.join(os.homedir(), '.hitmux-context-engine', 'config.conf');
    }

    getProjectConfigFilePath(projectRoot: string = process.cwd()): string {
        return path.join(projectRoot, '.hitmux-context-engine', 'config.conf');
    }

    ensureGlobalConfigFile(): EnsureConfigFileResult {
        const configPath = this.getGlobalConfigFilePath();
        if (fs.existsSync(configPath)) {
            return this.completeExistingGlobalConfigFile(configPath);
        }

        const configDir = path.dirname(configPath);
        fs.mkdirSync(configDir, { recursive: true });

        try {
            fs.writeFileSync(configPath, DEFAULT_GLOBAL_CONFIG_CONTENT, {
                encoding: 'utf-8',
                flag: 'wx'
            });
            return {
                path: configPath,
                created: true,
                updated: false,
                appendedKeys: []
            };
        } catch (error) {
            if (isFileAlreadyExistsError(error)) {
                return this.completeExistingGlobalConfigFile(configPath);
            }
            throw error;
        }
    }

    private completeExistingGlobalConfigFile(configPath: string): EnsureConfigFileResult {
        const content = fs.readFileSync(configPath, 'utf-8');
        const existingKeys = extractConfOptionKeys(content);
        const missingEntries = CONFIG_COMPLETION_ENTRIES.filter(entry => !existingKeys.has(entry.key));
        if (missingEntries.length === 0) {
            return {
                path: configPath,
                created: false,
                updated: false,
                appendedKeys: []
            };
        }

        const completedContent = mergeExistingConfigIntoTemplate(content, DEFAULT_GLOBAL_CONFIG_CONTENT);
        fs.writeFileSync(configPath, completedContent, 'utf-8');

        return {
            path: configPath,
            created: false,
            updated: true,
            appendedKeys: missingEntries.map(entry => entry.key)
        };
    }

    getAll(projectRoot: string = process.cwd()): HitmuxConfig {
        return {
            ...this.readConfigFile(this.getGlobalConfigFilePath()),
            ...this.readConfigFile(this.getProjectConfigFilePath(projectRoot))
        };
    }

    getGlobalAll(): HitmuxConfig {
        return this.readConfigFile(this.getGlobalConfigFilePath());
    }

    getReadErrors(projectRoot: string = process.cwd()): ConfigReadError[] {
        return [
            this.validateConfigFile(this.getGlobalConfigFilePath()),
            this.validateConfigFile(this.getProjectConfigFilePath(projectRoot))
        ].filter((error): error is ConfigReadError => error !== null);
    }

    private validateConfigFile(configPath: string): ConfigReadError | null {
        try {
            if (!fs.existsSync(configPath)) {
                return null;
            }

            const content = fs.readFileSync(configPath, 'utf-8').trim();
            if (!content) {
                return null;
            }

            const parsed = parseConfConfig(content);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {
                    path: configPath,
                    message: 'expected conf key-value fields'
                };
            }

            return null;
        } catch (error) {
            return {
                path: configPath,
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }

    private readConfigFile(configPath: string): HitmuxConfig {
        try {
            if (!fs.existsSync(configPath)) {
                return {};
            }

            const content = fs.readFileSync(configPath, 'utf-8').trim();
            if (!content) {
                return {};
            }

            const parsed = parseConfConfig(content);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                console.warn(`[ConfigManager] Ignoring ${configPath}: expected conf key-value fields.`);
                return {};
            }

            return parsed as HitmuxConfig;
        } catch (error) {
            console.warn(`[ConfigManager] Failed to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
            return {};
        }
    }

    get<T extends HitmuxConfigKey>(key: T, projectRoot?: string): HitmuxConfig[T] | undefined {
        const value = this.getAll(projectRoot)[key];
        return value === null ? undefined : value;
    }

    getGlobal<T extends HitmuxConfigKey>(key: T): HitmuxConfig[T] | undefined {
        const value = this.getGlobalAll()[key];
        return value === null ? undefined : value;
    }

    getString(key: HitmuxConfigKey, projectRoot?: string): string | undefined {
        const value = this.get(key, projectRoot);
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed.length > 0 ? trimmed : undefined;
        }
        return undefined;
    }

    getNumber(key: HitmuxConfigKey, projectRoot?: string): number | undefined {
        const value = this.get(key, projectRoot);
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === 'string' && value.trim().length > 0) {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : undefined;
        }
        return undefined;
    }

    getBoolean(key: HitmuxConfigKey, projectRoot?: string): boolean | undefined {
        const value = this.get(key, projectRoot);
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'string') {
            switch (value.trim().toLowerCase()) {
                case '1':
                case 'true':
                case 'yes':
                case 'on':
                    return true;
                case '0':
                case 'false':
                case 'no':
                case 'off':
                    return false;
            }
        }
        return undefined;
    }

    getStringArray(key: HitmuxConfigKey, projectRoot?: string): string[] {
        const value = this.get(key, projectRoot);
        return this.normalizeStringArray(value);
    }

    getGlobalStringArray(key: HitmuxConfigKey): string[] {
        const value = this.getGlobal(key);
        return this.normalizeStringArray(value);
    }

    private normalizeStringArray(value: unknown): string[] {
        if (Array.isArray(value)) {
            return value
                .map(item => typeof item === 'string' ? item.trim() : '')
                .filter(item => item.length > 0);
        }
        if (typeof value === 'string') {
            return value
                .split(',')
                .map(item => item.trim())
                .filter(item => item.length > 0);
        }
        return [];
    }

    set<T extends HitmuxConfigKey>(key: T, value: HitmuxConfig[T]): void {
        const configPath = this.getGlobalConfigFilePath();
        const configDir = path.dirname(configPath);
        fs.mkdirSync(configDir, { recursive: true });

        const config = this.getAll();
        config[key] = value;
        fs.writeFileSync(configPath, formatConfConfig(config), 'utf-8');
    }
}

export const configManager = new ConfigManager();

interface ConfigCompletionEntry {
    key: HitmuxConfigKey;
    description: string;
    example: string;
}

const DEFAULT_GLOBAL_CONFIG_HEADER = `# Hitmux Context Engine global configuration.
# This file was created automatically because no global config file existed.
# Project config at ./.hitmux-context-engine/config.conf overrides matching fields.
# Keep secret fields commented until you are ready to use them.
`;

const DEFAULT_GLOBAL_CONFIG_ACTIVE_CONTENT = `
# =============================================================================
# Basic configuration: set these fields first to make the service usable.
# =============================================================================

# Default embedding provider.
embeddingProvider = OpenRouter
embeddingModel = qwen/qwen3-embedding-4b
# openrouterApiKey = sk-or-your-openrouter-api-key

# Local Milvus default. Change this for remote Milvus or Zilliz Cloud.
milvusAddress = localhost:19530
# milvusToken = your-milvus-or-zilliz-token

# System proxy inheritance is disabled by default.
embeddingUseSystemProxy = false
databaseUseSystemProxy = false

# =============================================================================
# Advanced configuration: tune these only when you need custom behavior.
# =============================================================================

# Server metadata.
# mcpServerName = Hitmux Context Engine MCP Server
# mcpServerVersion = 1.0.0

# Index worker defaults.
fileProcessingConcurrency = 2

# Background sync defaults.
backgroundSync = true
triggerWatcher = true
projectWatcher = true
projectWatcherDebounceMs = 1000
projectWatcherUsePolling = false
projectWatcherFallbackScanIntervalMs = 600000
`;

const CONFIG_COMPLETION_ENTRIES: ConfigCompletionEntry[] = [
    {
        key: 'mcpServerName',
        description: 'Server name shown in MCP logs.',
        example: 'Hitmux Context Engine MCP Server'
    },
    {
        key: 'mcpServerVersion',
        description: 'Server version shown in MCP logs.',
        example: '1.0.0'
    },
    {
        key: 'embeddingProvider',
        description: 'Embedding provider: OpenAI, VoyageAI, Gemini, Ollama, or OpenRouter.',
        example: 'OpenRouter'
    },
    {
        key: 'embeddingModel',
        description: 'Embedding model name for the selected provider.',
        example: 'qwen/qwen3-embedding-4b'
    },
    {
        key: 'embeddingBatchSize',
        description: 'Embedding batch size for index operations.',
        example: '32'
    },
    {
        key: 'embeddingConcurrency',
        description: 'Embedding request concurrency for index operations.',
        example: '4'
    },
    {
        key: 'fileProcessingConcurrency',
        description: 'Read/split worker concurrency for index operations.',
        example: '2'
    },
    {
        key: 'openaiApiKey',
        description: 'OpenAI API key when embeddingProvider = OpenAI.',
        example: 'sk-your-openai-api-key'
    },
    {
        key: 'openaiBaseUrl',
        description: 'OpenAI-compatible API base URL for custom endpoints.',
        example: 'https://api.openai.com/v1'
    },
    {
        key: 'voyageaiApiKey',
        description: 'VoyageAI API key when embeddingProvider = VoyageAI.',
        example: 'pa-your-voyageai-api-key'
    },
    {
        key: 'geminiApiKey',
        description: 'Google AI API key when embeddingProvider = Gemini.',
        example: 'your-gemini-api-key'
    },
    {
        key: 'geminiBaseUrl',
        description: 'Gemini API base URL for custom endpoints.',
        example: 'https://generativelanguage.googleapis.com'
    },
    {
        key: 'openrouterApiKey',
        description: 'OpenRouter API key when embeddingProvider = OpenRouter.',
        example: 'sk-or-your-openrouter-api-key'
    },
    {
        key: 'embeddingUseSystemProxy',
        description: 'Allow embedding providers to inherit system proxy environment variables.',
        example: 'false'
    },
    {
        key: 'ollamaModel',
        description: 'Ollama model name, preferred over embeddingModel for Ollama.',
        example: 'nomic-embed-text'
    },
    {
        key: 'ollamaHost',
        description: 'Ollama server host.',
        example: 'http://127.0.0.1:11434'
    },
    {
        key: 'milvusAddress',
        description: 'Milvus or Zilliz Cloud public endpoint.',
        example: 'localhost:19530'
    },
    {
        key: 'milvusToken',
        description: 'Milvus or Zilliz token, when authentication is required.',
        example: 'your-zilliz-or-milvus-token'
    },
    {
        key: 'databaseUseSystemProxy',
        description: 'Allow Milvus/Zilliz connections to inherit system proxy environment variables.',
        example: 'false'
    },
    {
        key: 'milvusUseRestful',
        description: 'Reserved advanced option; the MCP startup path uses the gRPC Milvus client.',
        example: 'false'
    },
    {
        key: 'milvusCollectionLimitCheckTimeoutMs',
        description: 'Timeout for collection-limit pre-check.',
        example: '15000'
    },
    {
        key: 'zillizBaseUrl',
        description: 'Zilliz management API base URL.',
        example: 'https://api.cloud.zilliz.com'
    },
    {
        key: 'collectionNameOverride',
        description: 'Optional readable prefix for collection names.',
        example: 'my_project'
    },
    {
        key: 'codebaseIdentityMode',
        description: 'Collection identity mode: path, gitRemote, global, or custom.',
        example: 'path'
    },
    {
        key: 'codebaseIdentity',
        description: 'Explicit shared identity string for custom mode.',
        example: 'shared-custom-identity'
    },
    {
        key: 'globalCollectionName',
        description: 'Name for global mode shared collections.',
        example: 'default'
    },
    {
        key: 'gitRemoteName',
        description: 'Git remote name for gitRemote mode.',
        example: 'origin'
    },
    {
        key: 'hybridMode',
        description: 'Enable BM25 + dense vector hybrid search.',
        example: 'true'
    },
    {
        key: 'searchTimeoutMs',
        description: 'Search timeout in milliseconds.',
        example: '30000'
    },
    {
        key: 'customExtensions',
        description: 'Additional file extensions to index; repeat the field for multiple values.',
        example: '.vue'
    },
    {
        key: 'customIgnorePatterns',
        description: 'Additional ignore patterns; repeat the field for multiple values.',
        example: 'temp/**'
    },
    {
        key: 'merkleSnapshotMaxBytes',
        description: 'Maximum bytes for Merkle snapshot storage.',
        example: '52428800'
    },
    {
        key: 'automaticIncrementalEffectiveLineLimit',
        description: 'Effective-line growth limit before automatic incremental sync pauses for manual review.',
        example: '5000'
    },
    {
        key: 'autoIndexing',
        description: 'Enable all automatic re-indexing.',
        example: 'true'
    },
    {
        key: 'interactiveIndexing',
        description: 'Allow index_codebase writes through MCP.',
        example: 'true'
    },
    {
        key: 'backgroundSync',
        description: 'Enable startup and periodic background sync; project watcher event sync remains available when false.',
        example: 'true'
    },
    {
        key: 'vectorDatabaseSyncTimeoutMs',
        description: 'Timeout for vector database sync operations.',
        example: '300000'
    },
    {
        key: 'syncIntervalMs',
        description: 'Background sync interval in milliseconds.',
        example: '120000'
    },
    {
        key: 'syncLockStaleMs',
        description: 'Age after which a sync lock is treated as stale.',
        example: '600000'
    },
    {
        key: 'triggerWatcher',
        description: 'Watch ~/.hitmux-context-engine/.sync-trigger for immediate debounced sync.',
        example: 'true'
    },
    {
        key: 'projectWatcher',
        description: 'Watch indexed project roots and use dirty paths for faster incremental sync.',
        example: 'true'
    },
    {
        key: 'projectWatcherDebounceMs',
        description: 'Debounce window for project file watcher events.',
        example: '1000'
    },
    {
        key: 'projectWatcherUsePolling',
        description: 'Use polling for project file watchers on filesystems with unreliable native events.',
        example: 'false'
    },
    {
        key: 'projectWatcherFallbackScanIntervalMs',
        description: 'Maximum time between full fallback scans while project watcher fast path is active.',
        example: '600000'
    },
    {
        key: 'projectWatcherIgnoredDirs',
        description: 'Directory names ignored by the project watcher; repeat the field for multiple values.',
        example: 'node_modules'
    },
    {
        key: 'splitterType',
        description: 'Default splitter: ast or langchain.',
        example: 'ast'
    },
    {
        key: 'searchTopK',
        description: 'Default maximum search result count.',
        example: '5'
    },
    {
        key: 'searchThreshold',
        description: 'Default minimum search relevance threshold.',
        example: '0'
    }
];

const DEFAULT_GLOBAL_CONFIG_ACTIVE_KEYS = extractConfOptionKeys(DEFAULT_GLOBAL_CONFIG_ACTIVE_CONTENT);
const DEFAULT_GLOBAL_CONFIG_CONTENT = `${DEFAULT_GLOBAL_CONFIG_HEADER}${DEFAULT_GLOBAL_CONFIG_ACTIVE_CONTENT}${formatCompletionBlock(
    CONFIG_COMPLETION_ENTRIES.filter(entry => !DEFAULT_GLOBAL_CONFIG_ACTIVE_KEYS.has(entry.key)),
    'Available optional fields'
)}`;

const ARRAY_CONFIG_KEYS = new Set<HitmuxConfigKey>([
    'customExtensions',
    'customIgnorePatterns'
]);

function isFileAlreadyExistsError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === 'EEXIST';
}

function extractConfOptionKeys(content: string): Set<HitmuxConfigKey> {
    const keys = new Set<HitmuxConfigKey>();
    for (const rawLine of content.split(/\r?\n/)) {
        const match = matchConfOptionLine(rawLine);
        if (!match) {
            continue;
        }

        keys.add(match.key as HitmuxConfigKey);
    }
    return keys;
}

function mergeExistingConfigIntoTemplate(existingContent: string, templateContent: string): string {
    const existingLinesByKey = collectExistingConfOptionLines(existingContent);
    const templateKeys = extractConfOptionKeys(templateContent);
    const usedKeys = new Set<string>();
    const outputLines: string[] = [];

    for (const line of templateContent.replace(/\n$/, '').split(/\r?\n/)) {
        const match = matchConfOptionLine(line);
        if (!match) {
            outputLines.push(line);
            continue;
        }

        const existingLines = existingLinesByKey.get(match.key);
        if (!existingLines || usedKeys.has(match.key)) {
            outputLines.push(line);
            continue;
        }

        outputLines.push(...existingLines);
        usedKeys.add(match.key);
    }

    const extraLines: string[] = [];
    for (const [key, lines] of existingLinesByKey.entries()) {
        if (!templateKeys.has(key as HitmuxConfigKey)) {
            extraLines.push(...lines);
        }
    }

    if (extraLines.length > 0) {
        outputLines.push('', '# Existing fields not present in the current default template.', ...extraLines);
    }

    return `${outputLines.join('\n')}\n`;
}

function collectExistingConfOptionLines(content: string): Map<string, string[]> {
    const linesByKey = new Map<string, string[]>();
    for (const rawLine of content.split(/\r?\n/)) {
        const match = matchConfOptionLine(rawLine);
        if (!match) {
            continue;
        }

        const lines = linesByKey.get(match.key) || [];
        lines.push(rawLine);
        linesByKey.set(match.key, lines);
    }
    return linesByKey;
}

function matchConfOptionLine(line: string): { key: string } | null {
    const match = /^\s*#?\s*([A-Za-z][A-Za-z0-9]*)\s*=/.exec(line);
    return match ? { key: match[1] } : null;
}

function formatCompletionBlock(entries: ConfigCompletionEntry[], title: string): string {
    if (entries.length === 0) {
        return '';
    }

    const lines = [
        '',
        `# ${title}.`,
        '# Uncomment and edit only the fields you need.'
    ];

    for (const entry of entries) {
        lines.push('', `# ${entry.description}`, `# ${entry.key} = ${entry.example}`);
    }

    return `${lines.join('\n')}\n`;
}

function parseConfConfig(input: string): HitmuxConfig {
    const config: Record<string, unknown> = {};
    const lines = input.split(/\r?\n/);

    for (const [index, rawLine] of lines.entries()) {
        const line = stripConfComment(rawLine).trim();
        if (!line) {
            continue;
        }

        const separatorIndex = line.indexOf('=');
        if (separatorIndex < 1) {
            throw new Error(`Invalid config line ${index + 1}: expected "field = value"`);
        }

        const key = line.slice(0, separatorIndex).trim() as HitmuxConfigKey;
        const rawValue = line.slice(separatorIndex + 1).trim();
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
            throw new Error(`Invalid config line ${index + 1}: invalid field name "${key}"`);
        }

        if (ARRAY_CONFIG_KEYS.has(key)) {
            const values = parseConfArrayValue(rawValue);
            const previous = config[key];
            config[key] = Array.isArray(previous) ? [...previous, ...values] : values;
            continue;
        }

        config[key] = parseConfScalarValue(rawValue);
    }

    return config as HitmuxConfig;
}

function stripConfComment(input: string): string {
    let output = '';
    let inString = false;
    let quote: '"' | "'" | null = null;
    let escaped = false;

    for (let i = 0; i < input.length; i++) {
        const current = input[i];

        if (inString) {
            output += current;
            if (escaped) {
                escaped = false;
            } else if (current === '\\') {
                escaped = true;
            } else if (current === quote) {
                inString = false;
                quote = null;
            }
            continue;
        }

        if (current === '"' || current === "'") {
            inString = true;
            quote = current;
            output += current;
            continue;
        }

        if (current === '#') {
            break;
        }

        output += current;
    }

    return output;
}

function parseConfArrayValue(rawValue: string): string[] {
    const value = unquoteConfValue(rawValue).trim();
    if (!value) {
        return [];
    }

    return value
        .split(/\s+/)
        .map(item => item.trim())
        .filter(item => item.length > 0);
}

function parseConfScalarValue(rawValue: string): string | number | boolean | undefined {
    const value = unquoteConfValue(rawValue).trim();
    if (!value) {
        return undefined;
    }

    const lowerValue = value.toLowerCase();
    if (lowerValue === 'true') {
        return true;
    }
    if (lowerValue === 'false') {
        return false;
    }

    const numberValue = Number(value);
    if (Number.isFinite(numberValue) && value === String(numberValue)) {
        return numberValue;
    }

    return value;
}

function unquoteConfValue(rawValue: string): string {
    if (rawValue.length < 2) {
        return rawValue;
    }

    const quote = rawValue[0];
    if ((quote !== '"' && quote !== "'") || rawValue[rawValue.length - 1] !== quote) {
        return rawValue;
    }

    return rawValue
        .slice(1, -1)
        .replace(/\\(["'\\#])/g, '$1');
}

function formatConfConfig(config: HitmuxConfig): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(config)) {
        if (value === undefined || value === null) {
            continue;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                lines.push(`${key} = ${formatConfValue(item)}`);
            }
            continue;
        }

        lines.push(`${key} = ${formatConfValue(value)}`);
    }

    return `${lines.join('\n')}\n`;
}

function formatConfValue(value: string | number | boolean): string {
    if (typeof value !== 'string') {
        return String(value);
    }

    if (!value || /(^\s|\s$|#)/.test(value)) {
        return `"${value.replace(/(["\\#])/g, '\\$1')}"`;
    }

    return value;
}
