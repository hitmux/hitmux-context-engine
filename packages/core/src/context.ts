import {
    Splitter,
    CodeChunk,
    AstCodeSplitter
} from './splitter';
import {
    Embedding,
    EmbeddingVector,
    OpenAIEmbedding
} from './embedding';
import {
    VectorDatabase,
    VectorDocument,
    VectorSearchResult,
    HybridSearchRequest,
    HybridSearchResult
} from './vectordb';
import { SemanticSearchResult } from './types';
import { configManager } from './utils/config-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileSynchronizer } from './sync/synchronizer';
import { CodebaseIdentityOptions, resolveCodebaseIdentity } from './utils/path-identity';
import { IgnoreMatcher } from './utils/ignore-matcher';

/**
 * Thrown by indexCodebase / processFileList when an AbortSignal fires
 * mid-indexing. Callers (e.g. the MCP server's clear_index handler) use
 * this to detect a cooperative cancel vs. a real failure.
 */
export class IndexAbortError extends Error {
    constructor(message: string = 'Indexing aborted') {
        super(message);
        this.name = 'IndexAbortError';
    }
}

/**
 * Thrown when the embedding API fails (quota exhausted, auth failure,
 * network error, etc.). Propagates through processFileList so callers
 * can distinguish a critical embedding failure from a per-file skip.
 *
 * Unlike a per-file read/parse error (which is logged and skipped),
 * an EmbeddingError is always re-thrown so that the entire indexing
 * pipeline stops. This prevents silent partial indexing: Milvus would
 * otherwise receive zero vectors while the snapshot marks files as done.
 */
export class EmbeddingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EmbeddingError';
    }
}

export class IndexingVerificationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'IndexingVerificationError';
    }
}

export class EmbeddingModelMismatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EmbeddingModelMismatchError';
    }
}

export class SearchTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SearchTimeoutError';
    }
}

const DEFAULT_SEARCH_TIMEOUT_MS = 30000;
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_EMBEDDING_MODEL = 'qwen/qwen3-embedding-4b';

export interface IndexingRequestOptions {
    maxDepth?: number;
    additionalIgnoreFiles?: string[];
}

export interface IndexableFilePreview {
    totalFiles: number;
    files: string[];
    sampleLimit: number;
}

interface IgnoreFileEntry {
    filePath: string;
    scopeRelativePath: string;
}

interface CollectionEmbeddingMetadata {
    provider: string;
    model: string;
    dimension: number;
}

interface CollectionMetadata {
    version: 1;
    codebasePath: string;
    embedding: CollectionEmbeddingMetadata;
    createdAt: string;
}

const DEFAULT_SUPPORTED_EXTENSIONS = [
    // Programming languages
    '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cpp', '.c', '.h', '.hpp',
    '.cs', '.go', '.rs', '.php', '.rb', '.swift', '.kt', '.scala', '.m', '.mm',
    '.dart', '.sol', '.ex', '.exs', '.lua', '.luau',
    // Text and markup files
    '.md', '.markdown', '.ipynb',
    // '.txt',  '.json', '.yaml', '.yml', '.xml', '.html', '.htm',
    // '.css', '.scss', '.less', '.sql', '.sh', '.bash', '.env'
];

const DEFAULT_IGNORE_PATTERNS = [
    // Common build output and dependency directories
    'node_modules/**',
    'dist/**',
    'build/**',
    'out/**',
    'target/**',
    'coverage/**',
    '.nyc_output/**',

    // IDE and editor files
    '.vscode/**',
    '.idea/**',
    '*.swp',
    '*.swo',

    // Version control
    '.git/**',
    '.svn/**',
    '.hg/**',

    // Cache directories
    '.cache/**',
    '__pycache__/**',
    '.pytest_cache/**',

    // Logs and temporary files
    'logs/**',
    'tmp/**',
    'temp/**',
    '*.log',

    // Environment and config files
    '.env',
    '.env.*',
    '*.local',

    // Minified and bundled files
    '*.min.js',
    '*.min.css',
    '*.min.map',
    '*.bundle.js',
    '*.bundle.css',
    '*.chunk.js',
    '*.vendor.js',
    '*.polyfills.js',
    '*.runtime.js',
    '*.map', // source map files
    'node_modules', '.git', '.svn', '.hg', 'build', 'dist', 'out',
    'target', '.vscode', '.idea', '__pycache__', '.pytest_cache',
    'coverage', '.nyc_output', 'logs', 'tmp', 'temp'
];

export interface ContextConfig {
    embedding?: Embedding;
    vectorDatabase?: VectorDatabase;
    codeSplitter?: Splitter;
    searchTimeoutMs?: number;
    supportedExtensions?: string[];
    ignorePatterns?: string[];
    ignoreFiles?: string[];
    customExtensions?: string[]; // New: custom extensions from MCP
    customIgnorePatterns?: string[]; // New: custom ignore patterns from MCP
    collectionNameOverride?: string; // Optional: custom collection name suffix
    collectionIdentity?: CodebaseIdentityOptions;
    maxDepth?: number;
    hybridMode?: boolean;
}

export class Context {
    private static readonly MAX_COLLECTION_NAME_LENGTH = 255;
    private static readonly COLLECTION_METADATA_PREFIX = 'hitmuxContext:';
    private static readonly SKIP_EMBEDDING_MODEL_CHECK_ENV = 'HITMUX_CONTEXT_ENGINE_SKIP_EMBEDDING_MODEL_CHECK';

    private embedding: Embedding;
    private vectorDatabase: VectorDatabase;
    private codeSplitter: Splitter;
    private supportedExtensions: string[];
    private baseIgnorePatterns: string[];
    private ignorePatterns: string[];
    private baseIgnoreFiles: string[];
    private collectionNameOverride?: string;
    private collectionIdentity: CodebaseIdentityOptions;
    private warnedOverrideSanitization = new Set<string>();
    private synchronizers = new Map<string, FileSynchronizer>();
    private searchTimeoutMs: number;
    private maxDepth?: number;
    private hybridMode?: boolean;

    constructor(config: ContextConfig = {}) {
        // Initialize services
        this.embedding = config.embedding || new OpenAIEmbedding({
            apiKey: configManager.getString('openrouterApiKey') || configManager.getString('openaiApiKey') || 'your-openrouter-api-key',
            model: configManager.getString('embeddingModel') || DEFAULT_EMBEDDING_MODEL,
            baseURL: configManager.getString('openaiBaseUrl') || DEFAULT_OPENROUTER_BASE_URL
        });

        if (!config.vectorDatabase) {
            throw new Error('VectorDatabase is required. Please provide a vectorDatabase instance in the config.');
        }
        this.vectorDatabase = config.vectorDatabase;

        this.codeSplitter = config.codeSplitter || new AstCodeSplitter(2500, 300);
        this.searchTimeoutMs = this.getConfiguredSearchTimeoutMs(config.searchTimeoutMs);

        const configuredCustomExtensions = this.getCustomExtensionsFromConfig();

        // Combine default extensions with config and global extensions.
        const allSupportedExtensions = [
            ...DEFAULT_SUPPORTED_EXTENSIONS,
            ...(config.supportedExtensions || []),
            ...(config.customExtensions || []),
            ...configuredCustomExtensions
        ];
        // Remove duplicates
        this.supportedExtensions = [...new Set(this.normalizeExtensions(allSupportedExtensions))];

        const configuredCustomIgnorePatterns = this.getCustomIgnorePatternsFromConfig();

        // Start with default ignore patterns and persistent config patterns.
        const allIgnorePatterns = [
            ...DEFAULT_IGNORE_PATTERNS,
            ...(config.ignorePatterns || []),
            ...(config.customIgnorePatterns || []),
            ...configuredCustomIgnorePatterns
        ];
        this.baseIgnorePatterns = this.dedupePatterns(allIgnorePatterns);
        this.ignorePatterns = [...this.baseIgnorePatterns];
        this.baseIgnoreFiles = this.dedupePatterns(config.ignoreFiles || []);
        this.collectionNameOverride = config.collectionNameOverride;
        this.collectionIdentity = config.collectionIdentity || {};
        this.maxDepth = this.normalizeMaxDepth(config.maxDepth);
        this.hybridMode = config.hybridMode;

        console.log(`[Context] 🔧 Initialized with ${this.supportedExtensions.length} supported extensions and ${this.ignorePatterns.length} ignore patterns`);
        if (configuredCustomExtensions.length > 0) {
            console.log(`[Context] 📎 Loaded ${configuredCustomExtensions.length} custom extensions from config: ${configuredCustomExtensions.join(', ')}`);
        }
        if (configuredCustomIgnorePatterns.length > 0) {
            console.log(`[Context] 🚫 Loaded ${configuredCustomIgnorePatterns.length} custom ignore patterns from config: ${configuredCustomIgnorePatterns.join(', ')}`);
        }
    }

    /**
     * Get embedding instance
     */
    getEmbedding(): Embedding {
        return this.embedding;
    }

    /**
     * Get vector database instance
     */
    getVectorDatabase(): VectorDatabase {
        return this.vectorDatabase;
    }

    /**
     * Get code splitter instance
     */
    getCodeSplitter(): Splitter {
        return this.codeSplitter;
    }

    /**
     * Get supported extensions
     */
    getSupportedExtensions(): string[] {
        return [...this.supportedExtensions];
    }

    /**
     * Get supported extensions for the current operation without mutating
     * the Context's persistent extension list.
     */
    getEffectiveSupportedExtensions(additionalExtensions: string[] = []): string[] {
        const normalizedExtensions = this.normalizeExtensions(additionalExtensions);
        return [...new Set([...this.supportedExtensions, ...normalizedExtensions])];
    }

    /**
     * Get ignore patterns
     */
    getIgnorePatterns(): string[] {
        return [...this.ignorePatterns];
    }

    /**
     * Get synchronizers map
     */
    getSynchronizers(): Map<string, FileSynchronizer> {
        return new Map(this.synchronizers);
    }

    /**
     * Set synchronizer for a collection
     */
    setSynchronizer(collectionName: string, synchronizer: FileSynchronizer): void {
        this.synchronizers.set(collectionName, synchronizer);
    }

    /**
     * Public wrapper for loadIgnorePatterns private method
     */
    async getLoadedIgnorePatterns(codebasePath: string): Promise<void> {
        await this.loadIgnorePatterns(codebasePath);
    }

    /**
     * Get the effective ignore patterns for a codebase without relying on
     * codebase-specific patterns already stored on this Context instance.
     */
    async getEffectiveIgnorePatterns(
        codebasePath: string,
        additionalIgnorePatterns: string[] = [],
        additionalIgnoreFiles: string[] = []
    ): Promise<string[]> {
        return this.loadIgnorePatterns(codebasePath, additionalIgnorePatterns, additionalIgnoreFiles);
    }

    async previewIndexableFiles(
        codebasePath: string,
        additionalIgnorePatterns: string[] = [],
        additionalSupportedExtensions: string[] = [],
        requestOptions: IndexingRequestOptions = {},
        sampleLimit: number = 50
    ): Promise<IndexableFilePreview> {
        const ignorePatterns = await this.loadIgnorePatterns(
            codebasePath,
            additionalIgnorePatterns,
            requestOptions.additionalIgnoreFiles || []
        );
        const supportedExtensions = this.getEffectiveSupportedExtensions(additionalSupportedExtensions);
        const codeFiles = await this.getCodeFiles(
            codebasePath,
            ignorePatterns,
            supportedExtensions,
            requestOptions.maxDepth
        );
        const normalizedSampleLimit = Number.isFinite(sampleLimit) && sampleLimit > 0
            ? Math.floor(sampleLimit)
            : 50;

        return {
            totalFiles: codeFiles.length,
            files: codeFiles
                .map(filePath => path.relative(codebasePath, filePath).replace(/\\/g, '/'))
                .sort()
                .slice(0, normalizedSampleLimit),
            sampleLimit: normalizedSampleLimit
        };
    }

    /**
     * Public wrapper for prepareCollection private method
     */
    async getPreparedCollection(codebasePath: string): Promise<void> {
        return this.prepareCollection(codebasePath);
    }

    private getIsHybrid(): boolean {
        if (typeof this.hybridMode === 'boolean') {
            return this.hybridMode;
        }

        return configManager.getBoolean('hybridMode') ?? true;
    }

    /**
     * Generate collection name based on codebase path and hybrid mode
     */
    public getCollectionName(codebasePath: string): string {
        const isHybrid = this.getIsHybrid();
        const prefix = isHybrid === true ? 'hybrid_code_chunks' : 'code_chunks';
        const identity = resolveCodebaseIdentity(codebasePath, this.getEffectiveCollectionIdentity());
        const identityHash = crypto.createHash('md5').update(identity.value).digest('hex').substring(0, 8);

        // Overrides keep the identity hash suffix so existing path-scoped
        // overrides remain distinct while shared identity modes can opt in.
        const configOverride = this.getValidOverrideValue(this.collectionNameOverride);
        if (configOverride) {
            const suffix = this.sanitizeCollectionNameSuffix(configOverride, prefix, identityHash, 'Context config');
            return `${prefix}_${suffix}`;
        }

        const configuredOverride = this.getValidOverrideValue(configManager.getString('collectionNameOverride'));
        if (configuredOverride) {
            const suffix = this.sanitizeCollectionNameSuffix(configuredOverride, prefix, identityHash, 'config.collectionNameOverride');
            return `${prefix}_${suffix}`;
        }

        if (identity.readableName && identity.mode !== 'gitRemote') {
            const suffix = this.sanitizeCollectionNameSuffix(identity.readableName, prefix, identityHash, 'Collection identity');
            return `${prefix}_${suffix}`;
        }

        return `${prefix}_${identityHash}`;
    }

    private getEffectiveCollectionIdentity(): CodebaseIdentityOptions {
        return {
            ...this.collectionIdentity,
            mode: this.getValidIdentityMode(configManager.getString('codebaseIdentityMode')) || this.collectionIdentity.mode,
            customIdentity: this.getValidOverrideValue(configManager.getString('codebaseIdentity')) || this.collectionIdentity.customIdentity,
            globalName: this.getValidOverrideValue(configManager.getString('globalCollectionName')) || this.collectionIdentity.globalName,
            gitRemoteName: this.getValidOverrideValue(configManager.getString('gitRemoteName')) || this.collectionIdentity.gitRemoteName
        };
    }

    private getValidOverrideValue(value?: string): string | undefined {
        if (!value) {
            return undefined;
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }

    private getValidIdentityMode(value?: string): CodebaseIdentityOptions['mode'] | undefined {
        if (value === 'path' || value === 'gitRemote' || value === 'global' || value === 'custom') {
            return value;
        }
        return undefined;
    }

    private getConfiguredSearchTimeoutMs(configValue?: number): number {
        if (Number.isFinite(configValue) && configValue! > 0) {
            return Math.floor(configValue!);
        }

        const configuredValue = configManager.getNumber('searchTimeoutMs');
        if (Number.isFinite(configuredValue) && configuredValue! > 0) {
            return Math.floor(configuredValue!);
        }

        return DEFAULT_SEARCH_TIMEOUT_MS;
    }

    private sanitizeCollectionNameSuffix(value: string, prefix: string, identityHash: string, source: string): string {
        const hashSuffix = `_${identityHash}`;
        // Leave room for both the prefix and the trailing identity hash.
        const maxReadableLength = Context.MAX_COLLECTION_NAME_LENGTH - `${prefix}_`.length - hashSuffix.length;
        const normalized = value.trim();
        let sanitized = normalized.replace(/[^A-Za-z0-9_]/g, '_');
        sanitized = sanitized.slice(0, Math.max(0, maxReadableLength));

        if (sanitized.length === 0) {
            sanitized = 'custom';
        }

        const full = `${sanitized}${hashSuffix}`;

        if (sanitized !== normalized) {
            const warningKey = `${source}:${normalized}:${sanitized}`;
            if (!this.warnedOverrideSanitization.has(warningKey)) {
                console.warn(`[Context] ⚠️ Sanitized collection name override from "${normalized}" to "${sanitized}" (${source}); final suffix "${full}"`);
                this.warnedOverrideSanitization.add(warningKey);
            }
        }

        return full;
    }

    /**
     * Index a codebase for semantic search
     * @param codebasePath Codebase root path
     * @param progressCallback Optional progress callback function
     * @param forceReindex Whether to recreate the collection even if it exists
     * @param additionalIgnorePatterns Request-scoped ignore patterns
     * @param additionalSupportedExtensions Request-scoped file extensions
     * @param requestSplitter Request-scoped splitter for this indexing run
     * @returns Indexing statistics
     */
    async indexCodebase(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        forceReindex: boolean = false,
        additionalIgnorePatterns: string[] = [],
        additionalSupportedExtensions: string[] = [],
        requestSplitter?: Splitter,
        signal?: AbortSignal,
        requestOptions: IndexingRequestOptions = {}
    ): Promise<{ indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🚀 Starting to index codebase with ${searchType}: ${codebasePath}`);
        const splitter = requestSplitter || this.codeSplitter;

        // 1. Compute ignore patterns for this codebase/request without
        // retaining file-based patterns from previous codebases.
        const ignorePatterns = await this.loadIgnorePatterns(
            codebasePath,
            additionalIgnorePatterns,
            requestOptions.additionalIgnoreFiles || []
        );

        // 2. Check and prepare vector collection
        progressCallback?.({ phase: 'Preparing collection...', current: 0, total: 100, percentage: 0 });
        console.log(`Debug2: Preparing vector collection for codebase${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        await this.prepareCollection(codebasePath, forceReindex);

        // 3. Recursively traverse codebase to get all supported files
        progressCallback?.({ phase: 'Scanning files...', current: 5, total: 100, percentage: 5 });
        const supportedExtensions = this.getEffectiveSupportedExtensions(additionalSupportedExtensions);
        const codeFiles = await this.getCodeFiles(
            codebasePath,
            ignorePatterns,
            supportedExtensions,
            requestOptions.maxDepth
        );
        console.log(`[Context] 📁 Found ${codeFiles.length} code files`);

        if (codeFiles.length === 0) {
            progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
            return { indexedFiles: 0, totalChunks: 0, status: 'completed' };
        }

        // 3. Process each file with streaming chunk processing
        // Reserve 10% for preparation, 90% for actual indexing
        const indexingStartPercentage = 10;
        const indexingEndPercentage = 100;
        const indexingRange = indexingEndPercentage - indexingStartPercentage;

        const result = await this.processFileList(
            codeFiles,
            codebasePath,
            (filePath, fileIndex, totalFiles) => {
                // Calculate progress percentage
                const progressPercentage = indexingStartPercentage + (fileIndex / totalFiles) * indexingRange;

                console.log(`[Context] 📊 Processed ${fileIndex}/${totalFiles} files`);
                progressCallback?.({
                    phase: `Processing files (${fileIndex}/${totalFiles})...`,
                    current: fileIndex,
                    total: totalFiles,
                    percentage: Math.round(progressPercentage)
                });
            },
            splitter,
            signal
        );

        await this.verifyIndexedCollection(codebasePath, result.totalChunks);

        console.log(`[Context] ✅ Codebase indexing completed! Processed ${result.processedFiles} files in total, generated ${result.totalChunks} code chunks`);

        progressCallback?.({
            phase: 'Indexing complete!',
            current: result.processedFiles,
            total: codeFiles.length,
            percentage: 100
        });

        return {
            indexedFiles: result.processedFiles,
            totalChunks: result.totalChunks,
            status: result.status
        };
    }

    async reindexByChange(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        additionalIgnorePatterns: string[] = [],
        additionalSupportedExtensions: string[] = [],
        requestSplitter?: Splitter,
        additionalIgnoreFiles: string[] = [],
        maxDepth?: number
    ): Promise<{ added: number, removed: number, modified: number }> {
        const collectionName = this.getCollectionName(codebasePath);
        const synchronizer = this.synchronizers.get(collectionName);
        const splitter = requestSplitter || this.codeSplitter;

        if (!synchronizer) {
            // Recreate the synchronizer with the same request-scoped options that
            // were used for the original indexing task.
            const ignorePatterns = await this.loadIgnorePatterns(codebasePath, additionalIgnorePatterns, additionalIgnoreFiles);
            const supportedExtensions = this.getEffectiveSupportedExtensions(additionalSupportedExtensions);

            // To be safe, let's initialize if it's not there.
            const newSynchronizer = new FileSynchronizer(codebasePath, ignorePatterns, supportedExtensions, { maxDepth });
            await newSynchronizer.initialize();
            this.synchronizers.set(collectionName, newSynchronizer);
        }

        const currentSynchronizer = this.synchronizers.get(collectionName)!;

        progressCallback?.({ phase: 'Checking for file changes...', current: 0, total: 100, percentage: 0 });
        const { added, removed, modified } = await currentSynchronizer.checkForChanges();
        const totalChanges = added.length + removed.length + modified.length;

        if (totalChanges === 0) {
            progressCallback?.({ phase: 'No changes detected', current: 100, total: 100, percentage: 100 });
            console.log('[Context] ✅ No file changes detected.');
            return { added: 0, removed: 0, modified: 0 };
        }

        console.log(`[Context] 🔄 Found changes: ${added.length} added, ${removed.length} removed, ${modified.length} modified.`);

        let processedChanges = 0;
        const updateProgress = (phase: string) => {
            processedChanges++;
            const percentage = Math.round((processedChanges / (removed.length + modified.length + added.length)) * 100);
            progressCallback?.({ phase, current: processedChanges, total: totalChanges, percentage });
        };

        // Handle removed files
        for (const file of removed) {
            await this.deleteFileChunks(collectionName, file);
            updateProgress(`Removed ${file}`);
        }

        // Handle modified files
        for (const file of modified) {
            await this.deleteFileChunks(collectionName, file);
            updateProgress(`Deleted old chunks for ${file}`);
        }

        // Handle added and modified files
        const filesToIndex = [...added, ...modified].map(f => path.join(codebasePath, f));

        if (filesToIndex.length > 0) {
            await this.processFileList(
                filesToIndex,
                codebasePath,
                (filePath, fileIndex, totalFiles) => {
                    updateProgress(`Indexed ${filePath} (${fileIndex}/${totalFiles})`);
                },
                splitter
            );
        }

        console.log(`[Context] ✅ Re-indexing complete. Added: ${added.length}, Removed: ${removed.length}, Modified: ${modified.length}`);
        progressCallback?.({ phase: 'Re-indexing complete!', current: totalChanges, total: totalChanges, percentage: 100 });

        return { added: added.length, removed: removed.length, modified: modified.length };
    }

    private async deleteFileChunks(collectionName: string, relativePath: string): Promise<void> {
        // Escape backslashes for Milvus query expression (Windows path compatibility)
        const escapedPath = relativePath.replace(/\\/g, '\\\\');
        const results = await this.vectorDatabase.query(
            collectionName,
            `relativePath == "${escapedPath}"`,
            ['id']
        );

        if (results.length > 0) {
            const ids = results.map(r => r.id as string).filter(id => id);
            if (ids.length > 0) {
                await this.vectorDatabase.delete(collectionName, ids);
                console.log(`[Context] Deleted ${ids.length} chunks for file ${relativePath}`);
            }
        }
    }

    /**
     * Semantic search with unified implementation
     * @param codebasePath Codebase path to search in
     * @param query Search query
     * @param topK Number of results to return
     * @param threshold Similarity threshold
     */
    async semanticSearch(codebasePath: string, query: string, topK: number = 5, threshold: number = 0.5, filterExpr?: string): Promise<SemanticSearchResult[]> {
        return this.withSearchTimeout(
            this.performSemanticSearch(codebasePath, query, topK, threshold, filterExpr),
            codebasePath,
            query
        );
    }

    private async performSemanticSearch(codebasePath: string, query: string, topK: number = 5, threshold: number = 0.5, filterExpr?: string): Promise<SemanticSearchResult[]> {
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🔍 Executing ${searchType}: "${query}" in ${codebasePath}`);

        const collectionName = this.getCollectionName(codebasePath);
        console.log(`[Context] 🔍 Using collection: ${collectionName}`);

        // Check if collection exists and has data
        const hasCollection = await this.vectorDatabase.hasCollection(collectionName);
        if (!hasCollection) {
            console.log(`[Context] ⚠️  Collection '${collectionName}' does not exist. Please index the codebase first.`);
            return [];
        }

        if (isHybrid === true) {
            try {
                // Check collection stats to see if it has data
                await this.vectorDatabase.query(collectionName, '', ['id'], 1);
                console.log(`[Context] 🔍 Collection '${collectionName}' exists and appears to have data`);
            } catch (error) {
                console.log(`[Context] ⚠️  Collection '${collectionName}' exists but may be empty or not properly indexed:`, error);
            }

            // 1. Generate query vector
            console.log(`[Context] 🔍 Generating embeddings for query: "${query}"`);
            const queryEmbedding: EmbeddingVector = await this.embedding.embed(query);
            console.log(`[Context] ✅ Generated embedding vector with dimension: ${queryEmbedding.vector.length}`);
            console.log(`[Context] 🔍 First 5 embedding values: [${queryEmbedding.vector.slice(0, 5).join(', ')}]`);
            await this.validateExistingCollectionEmbedding(collectionName, queryEmbedding.vector.length);

            // 2. Prepare hybrid search requests
            const searchRequests: HybridSearchRequest[] = [
                {
                    data: queryEmbedding.vector,
                    anns_field: "vector",
                    param: { "nprobe": 10 },
                    limit: topK
                },
                {
                    data: query,
                    anns_field: "sparse_vector",
                    param: { "drop_ratio_search": 0.2 },
                    limit: topK
                }
            ];

            console.log(`[Context] 🔍 Search request 1 (dense): anns_field="${searchRequests[0].anns_field}", vector_dim=${queryEmbedding.vector.length}, limit=${searchRequests[0].limit}`);
            console.log(`[Context] 🔍 Search request 2 (sparse): anns_field="${searchRequests[1].anns_field}", query_text="${query}", limit=${searchRequests[1].limit}`);

            // 3. Execute hybrid search
            console.log(`[Context] 🔍 Executing hybrid search with RRF reranking...`);
            const searchResults: HybridSearchResult[] = await this.vectorDatabase.hybridSearch(
                collectionName,
                searchRequests,
                {
                    rerank: {
                        strategy: 'rrf',
                        params: { k: 100 }
                    },
                    limit: topK,
                    filterExpr
                }
            );

            console.log(`[Context] 🔍 Raw search results count: ${searchResults.length}`);

            // 4. Convert to semantic search result format
            const results: SemanticSearchResult[] = searchResults.map(result => ({
                content: result.document.content,
                relativePath: result.document.relativePath,
                startLine: result.document.startLine,
                endLine: result.document.endLine,
                language: result.document.metadata.language || 'unknown',
                score: result.score
            }));

            const dedupedResults = this.deduplicateResults(results);
            console.log(`[Context] ✅ Found ${results.length} results, ${dedupedResults.length} after dedup`);
            if (dedupedResults.length > 0) {
                console.log(`[Context] 🔍 Top result score: ${dedupedResults[0].score}, path: ${dedupedResults[0].relativePath}`);
            }

            return dedupedResults;
        } else {
            // Regular semantic search
            // 1. Generate query vector
            const queryEmbedding: EmbeddingVector = await this.embedding.embed(query);
            await this.validateExistingCollectionEmbedding(collectionName, queryEmbedding.vector.length);

            // 2. Search in vector database
            const searchResults: VectorSearchResult[] = await this.vectorDatabase.search(
                collectionName,
                queryEmbedding.vector,
                { topK, threshold, filterExpr }
            );

            // 3. Convert to semantic search result format
            const results: SemanticSearchResult[] = searchResults.map(result => ({
                content: result.document.content,
                relativePath: result.document.relativePath,
                startLine: result.document.startLine,
                endLine: result.document.endLine,
                language: result.document.metadata.language || 'unknown',
                score: result.score
            }));

            const dedupedResults = this.deduplicateResults(results);
            console.log(`[Context] ✅ Found ${results.length} results, ${dedupedResults.length} after dedup`);
            return dedupedResults;
        }
    }

    private async withSearchTimeout<T>(operation: Promise<T>, codebasePath: string, query: string): Promise<T> {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
            timeoutHandle = setTimeout(() => {
                reject(new SearchTimeoutError(
                    `Search timed out after ${this.searchTimeoutMs}ms for query "${query}" in codebase "${codebasePath}". ` +
                    'Set searchTimeoutMs in ~/.hitmux-context-engine/config.jsonc to increase the timeout.'
                ));
            }, this.searchTimeoutMs);
        });

        try {
            return await Promise.race([operation, timeoutPromise]);
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    /**
     * Deduplicate search results by file + line range overlap.
     * Keeps higher-scored result when two results from the same file overlap >50%.
     */
    private deduplicateResults(results: SemanticSearchResult[]): SemanticSearchResult[] {
        const kept: SemanticSearchResult[] = [];

        for (const result of results) {
            const overlaps = kept.some((existing) => {
                if (existing.relativePath !== result.relativePath) return false;
                const overlapStart = Math.max(existing.startLine, result.startLine);
                const overlapEnd = Math.min(existing.endLine, result.endLine);
                if (overlapStart > overlapEnd) return false;
                // Line ranges are inclusive (endLine = startLine + N - 1).
                const overlapSize = overlapEnd - overlapStart + 1;
                const resultSize = result.endLine - result.startLine + 1;
                return resultSize > 0 && overlapSize / resultSize > 0.5;
            });
            if (!overlaps) {
                kept.push(result);
            }
        }

        return kept;
    }

    /**
     * Check if index exists for codebase
     * @param codebasePath Codebase path to check
     * @returns Whether index exists
     */
    async hasIndex(codebasePath: string): Promise<boolean> {
        const collectionName = this.getCollectionName(codebasePath);
        return await this.vectorDatabase.hasCollection(collectionName);
    }

    /**
     * Clear index
     * @param codebasePath Codebase path to clear index for
     * @param progressCallback Optional progress callback function
     */
    async clearIndex(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void
    ): Promise<void> {
        console.log(`[Context] 🧹 Cleaning index data for ${codebasePath}...`);

        progressCallback?.({ phase: 'Checking existing index...', current: 0, total: 100, percentage: 0 });

        const collectionName = this.getCollectionName(codebasePath);
        const collectionExists = await this.vectorDatabase.hasCollection(collectionName);

        progressCallback?.({ phase: 'Removing index data...', current: 50, total: 100, percentage: 50 });

        if (collectionExists) {
            await this.vectorDatabase.dropCollection(collectionName);
        }

        // Delete snapshot file
        await FileSynchronizer.deleteSnapshot(codebasePath);

        progressCallback?.({ phase: 'Index cleared', current: 100, total: 100, percentage: 100 });
        console.log('[Context] ✅ Index data cleaned');
    }

    /**
     * Update ignore patterns (merges with default patterns and existing patterns)
     * @param ignorePatterns Array of ignore patterns to add to defaults
     */
    updateIgnorePatterns(ignorePatterns: string[]): void {
        // Merge with default patterns and any existing custom patterns, avoiding duplicates
        const mergedPatterns = [...DEFAULT_IGNORE_PATTERNS, ...ignorePatterns];
        this.baseIgnorePatterns = this.dedupePatterns(mergedPatterns);
        this.ignorePatterns = [...this.baseIgnorePatterns];
        console.log(`[Context] 🚫 Updated ignore patterns: ${ignorePatterns.length} new + ${DEFAULT_IGNORE_PATTERNS.length} default = ${this.ignorePatterns.length} total patterns`);
    }

    /**
     * Add custom ignore patterns (from MCP or other sources) without replacing existing ones
     * @param customPatterns Array of custom ignore patterns to add
     */
    addCustomIgnorePatterns(customPatterns: string[]): void {
        if (customPatterns.length === 0) return;

        // Merge persistent base patterns with new custom patterns, avoiding duplicates.
        const mergedPatterns = [...this.baseIgnorePatterns, ...customPatterns];
        this.baseIgnorePatterns = this.dedupePatterns(mergedPatterns);
        this.ignorePatterns = [...this.baseIgnorePatterns];
        console.log(`[Context] 🚫 Added ${customPatterns.length} custom ignore patterns. Total: ${this.ignorePatterns.length} patterns`);
    }

    /**
     * Reset ignore patterns to defaults only
     */
    resetIgnorePatternsToDefaults(): void {
        this.baseIgnorePatterns = [...DEFAULT_IGNORE_PATTERNS];
        this.ignorePatterns = [...this.baseIgnorePatterns];
        console.log(`[Context] 🔄 Reset ignore patterns to defaults: ${this.ignorePatterns.length} patterns`);
    }

    /**
     * Update embedding instance
     * @param embedding New embedding instance
     */
    updateEmbedding(embedding: Embedding): void {
        this.embedding = embedding;
        console.log(`[Context] 🔄 Updated embedding provider: ${embedding.getProvider()}`);
    }

    /**
     * Update vector database instance
     * @param vectorDatabase New vector database instance
     */
    updateVectorDatabase(vectorDatabase: VectorDatabase): void {
        this.vectorDatabase = vectorDatabase;
        console.log(`[Context] 🔄 Updated vector database`);
    }

    /**
     * Update splitter instance
     * @param splitter New splitter instance
     */
    updateSplitter(splitter: Splitter): void {
        this.codeSplitter = splitter;
        console.log(`[Context] 🔄 Updated splitter instance`);
    }

    /**
     * Prepare vector collection
     */
    private async prepareCollection(codebasePath: string, forceReindex: boolean = false): Promise<void> {
        const isHybrid = this.getIsHybrid();
        const collectionType = isHybrid === true ? 'hybrid vector' : 'vector';
        console.log(`[Context] 🔧 Preparing ${collectionType} collection for codebase: ${codebasePath}${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        const collectionName = this.getCollectionName(codebasePath);

        // Check if collection already exists
        const collectionExists = await this.vectorDatabase.hasCollection(collectionName);

        if (collectionExists && !forceReindex) {
            await this.validateExistingCollectionEmbedding(collectionName);
            if (isHybrid === true) {
                console.log(`📋 Hybrid collection ${collectionName} already exists, ensuring indexes are ready`);
                await this.vectorDatabase.ensureHybridCollectionReady(collectionName);
            } else {
                console.log(`📋 Collection ${collectionName} already exists, skipping creation`);
            }
            return;
        }

        if (collectionExists && forceReindex) {
            console.log(`[Context] 🗑️  Dropping existing collection ${collectionName} for force reindex...`);
            await this.vectorDatabase.dropCollection(collectionName);
            console.log(`[Context] ✅ Collection ${collectionName} dropped successfully`);
        }

        console.log(`[Context] 🔍 Detecting embedding dimension for ${this.embedding.getProvider()} provider...`);
        const dimension = await this.embedding.detectDimension();
        console.log(`[Context] 📏 Detected dimension: ${dimension} for ${this.embedding.getProvider()}`);
        const description = this.createCollectionDescription(codebasePath, this.getCurrentEmbeddingMetadata(dimension));
        if (isHybrid === true) {
            await this.vectorDatabase.createHybridCollection(collectionName, dimension, description);
        } else {
            await this.vectorDatabase.createCollection(collectionName, dimension, description);
        }

        console.log(`[Context] ✅ Collection ${collectionName} created successfully (dimension: ${dimension})`);
    }

    private async validateExistingCollectionEmbedding(collectionName: string, currentDimension?: number): Promise<void> {
        if (this.isEmbeddingModelCheckSkipped()) {
            console.warn(`[Context] ⚠️ Skipping embedding model compatibility check because ${Context.SKIP_EMBEDDING_MODEL_CHECK_ENV} is set.`);
            return;
        }

        let description: string;
        try {
            description = await this.vectorDatabase.getCollectionDescription(collectionName);
        } catch (error) {
            console.warn(`[Context] ⚠️ Unable to read collection metadata for '${collectionName}', embedding model compatibility was not verified: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }

        const storedMetadata = this.parseCollectionMetadata(description);
        if (!storedMetadata) {
            console.warn(`[Context] ⚠️ Collection '${collectionName}' has no embedding metadata, embedding model compatibility was not verified.`);
            return;
        }

        const dimension = currentDimension ?? await this.embedding.detectDimension();
        const currentEmbedding = this.getCurrentEmbeddingMetadata(dimension);
        const storedEmbedding = storedMetadata.embedding;
        const mismatches: string[] = [];

        if (storedEmbedding.provider !== currentEmbedding.provider) {
            mismatches.push(`provider indexed=${storedEmbedding.provider} current=${currentEmbedding.provider}`);
        }
        if (storedEmbedding.model !== currentEmbedding.model) {
            mismatches.push(`model indexed=${storedEmbedding.model} current=${currentEmbedding.model}`);
        }
        if (storedEmbedding.dimension !== currentEmbedding.dimension) {
            mismatches.push(`dimension indexed=${storedEmbedding.dimension} current=${currentEmbedding.dimension}`);
        }

        if (mismatches.length === 0) {
            console.log(`[Context] ✅ Collection '${collectionName}' embedding metadata matches current configuration (${currentEmbedding.provider}/${currentEmbedding.model}, dimension ${currentEmbedding.dimension}).`);
            return;
        }

        const message = [
            `Embedding model mismatch for collection '${collectionName}'.`,
            `Indexed with provider=${storedEmbedding.provider}, model=${storedEmbedding.model}, dimension=${storedEmbedding.dimension};`,
            `current provider=${currentEmbedding.provider}, model=${currentEmbedding.model}, dimension=${currentEmbedding.dimension}.`,
            `Details: ${mismatches.join('; ')}.`,
            `Reindex the codebase or set ${Context.SKIP_EMBEDDING_MODEL_CHECK_ENV}=true to bypass this check.`
        ].join(' ');

        console.error(`[Context] ❌ ${message}`);
        throw new EmbeddingModelMismatchError(message);
    }

    private getCurrentEmbeddingMetadata(dimension: number): CollectionEmbeddingMetadata {
        return {
            provider: this.embedding.getProvider(),
            model: this.embedding.getModel(),
            dimension,
        };
    }

    private createCollectionDescription(codebasePath: string, embedding: CollectionEmbeddingMetadata): string {
        const metadata: CollectionMetadata = {
            version: 1,
            codebasePath,
            embedding,
            createdAt: new Date().toISOString(),
        };

        return [
            `codebasePath:${codebasePath}`,
            `${Context.COLLECTION_METADATA_PREFIX}${JSON.stringify(metadata)}`,
        ].join('\n');
    }

    private parseCollectionMetadata(description: string): CollectionMetadata | undefined {
        const metadataLine = description
            .split(/\r?\n/)
            .find((line) => line.startsWith(Context.COLLECTION_METADATA_PREFIX));

        if (!metadataLine) {
            return undefined;
        }

        try {
            const parsed = JSON.parse(metadataLine.slice(Context.COLLECTION_METADATA_PREFIX.length));
            if (!parsed || parsed.version !== 1 || typeof parsed.codebasePath !== 'string') {
                return undefined;
            }

            const embedding = parsed.embedding;
            if (!embedding || typeof embedding.provider !== 'string' || typeof embedding.model !== 'string' || typeof embedding.dimension !== 'number') {
                return undefined;
            }

            return {
                version: 1,
                codebasePath: parsed.codebasePath,
                embedding: {
                    provider: embedding.provider,
                    model: embedding.model,
                    dimension: embedding.dimension,
                },
                createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
            };
        } catch (error) {
            console.warn(`[Context] ⚠️ Failed to parse collection embedding metadata: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    private isEmbeddingModelCheckSkipped(): boolean {
        const value = process.env[Context.SKIP_EMBEDDING_MODEL_CHECK_ENV];
        return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    }

    /**
     * Recursively get all code files in the codebase
     */
    private async getCodeFiles(
        codebasePath: string,
        ignorePatterns: string[] = this.ignorePatterns,
        supportedExtensions: string[] = this.supportedExtensions,
        requestMaxDepth?: number
    ): Promise<string[]> {
        const files: string[] = [];
        const maxDepth = this.normalizeMaxDepth(requestMaxDepth) ?? this.maxDepth;
        const ignoreMatcher = new IgnoreMatcher(ignorePatterns);

        const traverseDirectory = async (currentPath: string, depth: number = 0) => {
            const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);
                const relativePath = path.relative(codebasePath, fullPath);

                // Check if path matches ignore patterns
                if (ignoreMatcher.shouldIgnore(relativePath, entry.isDirectory())) {
                    continue;
                }

                if (entry.isDirectory()) {
                    if (maxDepth === undefined || depth < maxDepth) {
                        await traverseDirectory(fullPath, depth + 1);
                    }
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name);
                    if (supportedExtensions.includes(ext)) {
                        files.push(fullPath);
                    }
                }
            }
        };

        await traverseDirectory(codebasePath);
        return files;
    }

    /**
 * Process a list of files with streaming chunk processing
 * @param filePaths Array of file paths to process
 * @param codebasePath Base path for the codebase
 * @param onFileProcessed Callback called when each file is processed
 * @returns Object with processed file count and total chunk count
 */
    private async processFileList(
        filePaths: string[],
        codebasePath: string,
        onFileProcessed?: (filePath: string, fileIndex: number, totalFiles: number) => void,
        splitter: Splitter = this.codeSplitter,
        signal?: AbortSignal
    ): Promise<{ processedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const isHybrid = this.getIsHybrid();
        const EMBEDDING_BATCH_SIZE = Math.max(1, Math.floor(configManager.getNumber('embeddingBatchSize') || 100));
        const EMBEDDING_CONCURRENCY = Math.max(1, Math.floor(configManager.getNumber('embeddingConcurrency') || 1));
        const CHUNK_LIMIT = 450000;
        console.log(`[Context] 🔧 Using embeddingBatchSize: ${EMBEDDING_BATCH_SIZE}`);
        console.log(`[Context] 🔧 Using embeddingConcurrency: ${EMBEDDING_CONCURRENCY}`);

        let chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }> = [];
        let processedFiles = 0;
        let totalChunks = 0;
        let limitReached = false;
        type BatchResult = { ok: true } | { ok: false; error: unknown };
        const activeBatches = new Set<Promise<BatchResult>>();

        const throwBatchError = (error: unknown, context: string): never => {
            if (error instanceof EmbeddingError) {
                throw error;
            }
            const searchType = isHybrid === true ? 'hybrid' : 'regular';
            console.error(`[Context] ❌ Failed to process ${context} chunk batch for ${searchType}:`, error);
            if (error instanceof Error) {
                console.error('[Context] Stack trace:', error.stack);
            }
            throw error;
        };

        const waitForOneBatch = async (): Promise<void> => {
            if (activeBatches.size === 0) {
                return;
            }
            const result = await Promise.race(activeBatches);
            if (!result.ok) {
                throwBatchError(result.error, 'concurrent');
            }
        };

        const waitForAllBatches = async (): Promise<void> => {
            while (activeBatches.size > 0) {
                await waitForOneBatch();
            }
        };

        const enqueueChunkBuffer = async (buffer: Array<{ chunk: CodeChunk; codebasePath: string }>): Promise<void> => {
            const batch = buffer;
            const task: Promise<BatchResult> = this.processChunkBuffer(batch)
                .then(() => ({ ok: true as const }))
                .catch((error) => ({ ok: false as const, error }))
                .finally(() => {
                    activeBatches.delete(task);
                });
            activeBatches.add(task);

            if (activeBatches.size >= EMBEDDING_CONCURRENCY) {
                await waitForOneBatch();
            }
        };

        for (let i = 0; i < filePaths.length; i++) {
            // Cooperative cancellation: bail out at the next file boundary so the
            // caller (e.g. clear_index) can rely on no further inserts/snapshot
            // writes happening once it has signalled abort. See issue #199.
            if (signal?.aborted) {
                throw new IndexAbortError(`Indexing aborted after processing ${processedFiles}/${filePaths.length} files`);
            }

            const filePath = filePaths[i];

            try {
                const content = await fs.promises.readFile(filePath, 'utf-8');
                const language = this.getLanguageFromExtension(path.extname(filePath));
                const chunks = await splitter.split(content, language, filePath);

                // Log files with many chunks or large content
                if (chunks.length > 50) {
                    console.warn(`[Context] ⚠️  File ${filePath} generated ${chunks.length} chunks (${Math.round(content.length / 1024)}KB)`);
                } else if (content.length > 100000) {
                    console.log(`📄 Large file ${filePath}: ${Math.round(content.length / 1024)}KB -> ${chunks.length} chunks`);
                }

                // Add chunks to buffer
                for (const chunk of chunks) {
                    chunkBuffer.push({ chunk, codebasePath });
                    totalChunks++;

                    // Process batch when buffer reaches EMBEDDING_BATCH_SIZE
                    if (chunkBuffer.length >= EMBEDDING_BATCH_SIZE) {
                        const batch = chunkBuffer;
                        chunkBuffer = [];
                        await enqueueChunkBuffer(batch);
                    }

                    // Check if chunk limit is reached
                    if (totalChunks >= CHUNK_LIMIT) {
                        console.warn(`[Context] ⚠️  Chunk limit of ${CHUNK_LIMIT} reached. Stopping indexing.`);
                        limitReached = true;
                        break; // Exit the inner loop (over chunks)
                    }
                }

                processedFiles++;
                onFileProcessed?.(filePath, i + 1, filePaths.length);

                if (limitReached) {
                    break; // Exit the outer loop (over files)
                }

            } catch (error) {
                if (error instanceof EmbeddingError) {
                    throw error;
                }
                console.warn(`[Context] ⚠️  Skipping file ${filePath}: ${error}`);
            }
        }

        // Process any remaining chunks in the buffer (skip if cancelled).
        if (chunkBuffer.length > 0 && !signal?.aborted) {
            const searchType = isHybrid === true ? 'hybrid' : 'regular';
            console.log(`📝 Processing final batch of ${chunkBuffer.length} chunks for ${searchType}`);
            try {
                await enqueueChunkBuffer(chunkBuffer);
                chunkBuffer = [];
            } catch (error) {
                throwBatchError(error, 'final');
            }
        }

        await waitForAllBatches();

        if (signal?.aborted) {
            throw new IndexAbortError(`Indexing aborted after processing ${processedFiles}/${filePaths.length} files`);
        }

        return {
            processedFiles,
            totalChunks,
            status: limitReached ? 'limit_reached' : 'completed'
        };
    }

    /**
 * Process accumulated chunk buffer
 */
    private async processChunkBuffer(chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }>): Promise<void> {
        if (chunkBuffer.length === 0) return;

        // Extract chunks and ensure they all have the same codebasePath
        const chunks = chunkBuffer.map(item => item.chunk);
        const codebasePath = chunkBuffer[0].codebasePath;

        // Estimate tokens (rough estimation: 1 token ≈ 4 characters)
        const estimatedTokens = chunks.reduce((sum, chunk) => sum + Math.ceil(chunk.content.length / 4), 0);

        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid' : 'regular';
        console.log(`[Context] 🔄 Processing batch of ${chunks.length} chunks (~${estimatedTokens} tokens) for ${searchType}`);
        await this.processChunkBatch(chunks, codebasePath);
    }

    private async verifyIndexedCollection(codebasePath: string, totalChunks: number): Promise<void> {
        if (totalChunks === 0) {
            return;
        }

        const collectionName = this.getCollectionName(codebasePath);
        const rowCount = await this.vectorDatabase.getCollectionRowCount(collectionName);

        if (rowCount === 0) {
            throw new IndexingVerificationError(
                `Indexing produced ${totalChunks} chunks but collection '${collectionName}' has 0 searchable rows`
            );
        }

        if (rowCount < 0) {
            console.warn(`[Context] ⚠️ Unable to verify searchable row count for collection '${collectionName}' after indexing`);
        }
    }

    /**
     * Process a batch of chunks
     */
    private async processChunkBatch(chunks: CodeChunk[], codebasePath: string): Promise<void> {
        const isHybrid = this.getIsHybrid();

        // Generate embedding vectors
        const chunkContents = chunks.map(chunk => chunk.content);

        let embeddings: EmbeddingVector[];
        try {
            embeddings = await this.embedding.embedBatch(chunkContents);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            // Include batch size in the log/error message so operators can
            // identify how many chunks were lost when the API call failed.
            console.error(`[Context] ❌ Embedding API failed (batch size: ${chunkContents.length}): ${errorMessage}`);
            throw new EmbeddingError(`Embedding API error (batch size: ${chunkContents.length}): ${errorMessage}`);
        }
        this.validateEmbeddings(embeddings, chunks.length);

        if (isHybrid === true) {
            // Create hybrid vector documents
            const documents: VectorDocument[] = chunks.map((chunk, index) => {
                if (!chunk.metadata.filePath) {
                    throw new Error(`Missing filePath in chunk metadata at index ${index}`);
                }

                const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
                const fileExtension = path.extname(chunk.metadata.filePath);
                const { filePath: _filePath, startLine: _startLine, endLine: _endLine, ...restMetadata } = chunk.metadata;

                return {
                    id: this.generateId(relativePath, chunk.metadata.startLine || 0, chunk.metadata.endLine || 0, chunk.content),
                    content: chunk.content, // Full text content for BM25 and storage
                    vector: embeddings[index].vector, // Dense vector
                    relativePath,
                    startLine: chunk.metadata.startLine || 0,
                    endLine: chunk.metadata.endLine || 0,
                    fileExtension,
                    metadata: {
                        ...restMetadata,
                        codebasePath,
                        language: chunk.metadata.language || 'unknown',
                        chunkIndex: index
                    }
                };
            });

            // Store to vector database
            await this.vectorDatabase.insertHybrid(this.getCollectionName(codebasePath), documents);
        } else {
            // Create regular vector documents
            const documents: VectorDocument[] = chunks.map((chunk, index) => {
                if (!chunk.metadata.filePath) {
                    throw new Error(`Missing filePath in chunk metadata at index ${index}`);
                }

                const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
                const fileExtension = path.extname(chunk.metadata.filePath);
                const { filePath: _filePath, startLine: _startLine, endLine: _endLine, ...restMetadata } = chunk.metadata;

                return {
                    id: this.generateId(relativePath, chunk.metadata.startLine || 0, chunk.metadata.endLine || 0, chunk.content),
                    vector: embeddings[index].vector,
                    content: chunk.content,
                    relativePath,
                    startLine: chunk.metadata.startLine || 0,
                    endLine: chunk.metadata.endLine || 0,
                    fileExtension,
                    metadata: {
                        ...restMetadata,
                        codebasePath,
                        language: chunk.metadata.language || 'unknown',
                        chunkIndex: index
                    }
                };
            });

            // Store to vector database
            await this.vectorDatabase.insert(this.getCollectionName(codebasePath), documents);
        }
    }

    /**
     * Validate that the embedding batch response is well-formed before writing
     * any vectors to Milvus. Throwing EmbeddingError here aborts the entire
     * indexing run so that no partial / empty vectors are persisted.
     *
     * @param embeddings   - Array of embedding vectors returned by the API.
     * @param expectedCount - Number of chunks submitted in the batch request.
     * @throws EmbeddingError if the response is missing, mismatched, or contains
     *         any empty vector.
     * @returns void
     */
    private validateEmbeddings(embeddings: EmbeddingVector[], expectedCount: number): void {
        // Guard against non-array return values (e.g. API returning null or an
        // error object instead of throwing).
        if (!Array.isArray(embeddings)) {
            throw new EmbeddingError('Embedding API returned invalid embedding batch response');
        }

        // A partial response would silently mis-align embeddings[i] with chunks[i],
        // producing wrong vectors in Milvus — treat it as a hard failure.
        if (embeddings.length !== expectedCount) {
            throw new EmbeddingError(`Embedding API returned ${embeddings.length} embeddings for ${expectedCount} chunks`);
        }

        // Check each vector; an empty vector inserted into Milvus
        // would corrupt search results for that chunk's file.
        embeddings.forEach((embedding, index) => {
            if (!embedding || !Array.isArray(embedding.vector) || embedding.vector.length === 0) {
                throw new EmbeddingError(`Embedding API returned empty embedding vector at index ${index}`);
            }
        });
    }

    /**
     * Get programming language based on file extension
     */
    private getLanguageFromExtension(ext: string): string {
        const languageMap: Record<string, string> = {
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.py': 'python',
            '.java': 'java',
            '.cpp': 'cpp',
            '.c': 'c',
            '.h': 'c',
            '.hpp': 'cpp',
            '.cs': 'csharp',
            '.go': 'go',
            '.rs': 'rust',
            '.php': 'php',
            '.rb': 'ruby',
            '.swift': 'swift',
            '.kt': 'kotlin',
            '.scala': 'scala',
            '.m': 'objective-c',
            '.mm': 'objective-c',
            '.dart': 'dart',
            '.sol': 'solidity',
            '.ex': 'elixir',
            '.exs': 'elixir',
            '.lua': 'lua',
            '.luau': 'luau',
            '.ipynb': 'jupyter'
        };
        return languageMap[ext] || 'text';
    }

    /**
     * Generate unique ID based on chunk content and location
     * @param relativePath Relative path to the file
     * @param startLine Start line number
     * @param endLine End line number
     * @param content Chunk content
     * @returns Hash-based unique ID
     */
    private generateId(relativePath: string, startLine: number, endLine: number, content: string): string {
        const combinedString = `${relativePath}:${startLine}:${endLine}:${content}`;
        const hash = crypto.createHash('sha256').update(combinedString, 'utf-8').digest('hex');
        return `chunk_${hash.substring(0, 16)}`;
    }

    /**
     * Read ignore patterns from file (e.g., .gitignore)
     * @param filePath Path to the ignore file
     * @returns Array of ignore patterns
     */
    static async getIgnorePatternsFromFile(filePath: string): Promise<string[]> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#')); // Filter out empty lines and comments
        } catch (error) {
            console.warn(`[Context] ⚠️  Could not read ignore file ${filePath}: ${error}`);
            return [];
        }
    }

    /**
     * Load ignore patterns from various ignore files in the codebase.
     * Returns the effective patterns for the current codebase/request without
     * allowing file-based patterns from previous codebases to leak forward.
     * @param codebasePath Path to the codebase
     * @param additionalIgnorePatterns Ignore patterns for the current request
     */
    private async loadIgnorePatterns(
        codebasePath: string,
        additionalIgnorePatterns: string[] = [],
        additionalIgnoreFiles: string[] = []
    ): Promise<string[]> {
        try {
            let fileBasedPatterns: string[] = [];

            // Load root ignore files and scoped nested .gitignore files.
            const ignoreFiles = await this.findIgnoreFiles(codebasePath, additionalIgnoreFiles);
            for (const ignoreFile of ignoreFiles) {
                const patterns = await this.loadIgnoreFile(ignoreFile.filePath, path.relative(codebasePath, ignoreFile.filePath));
                fileBasedPatterns.push(...this.scopeIgnorePatterns(patterns, ignoreFile.scopeRelativePath));
            }

            // Load global ~/.hitmux-context-engine/.hitmux-context-engineignore
            const globalIgnorePatterns = await this.loadGlobalIgnoreFile();
            fileBasedPatterns.push(...globalIgnorePatterns);

            const effectiveIgnorePatterns = this.dedupePatterns([
                ...this.baseIgnorePatterns,
                ...additionalIgnorePatterns,
                ...fileBasedPatterns
            ]);
            // Preserve the previous observable getIgnorePatterns() behavior for
            // sequential callers, while all indexing paths use the local return
            // value to avoid shared-state leakage between background tasks.
            this.ignorePatterns = effectiveIgnorePatterns;

            if (fileBasedPatterns.length > 0 || additionalIgnorePatterns.length > 0) {
                console.log(`[Context] 🚫 Loaded total ${fileBasedPatterns.length} ignore patterns from all ignore files and ${additionalIgnorePatterns.length} request ignore patterns`);
            } else {
                console.log('📄 No ignore files found, using base ignore patterns');
            }
            return effectiveIgnorePatterns;
        } catch (error) {
            console.warn(`[Context] ⚠️ Failed to load ignore patterns: ${error}`);
            // Continue with base/request patterns on error - don't reuse
            // previously loaded codebase-specific patterns.
            const fallbackPatterns = this.dedupePatterns([
                ...this.baseIgnorePatterns,
                ...additionalIgnorePatterns
            ]);
            this.ignorePatterns = fallbackPatterns;
            return fallbackPatterns;
        }
    }

    /**
     * Find all .xxxignore files in the codebase directory
     * @param codebasePath Path to the codebase
     * @returns Array of ignore file paths
     */
    private async findIgnoreFiles(codebasePath: string, additionalIgnoreFiles: string[] = []): Promise<IgnoreFileEntry[]> {
        try {
            const ignoreFiles: IgnoreFileEntry[] = [];
            const baseMatcher = new IgnoreMatcher(this.baseIgnorePatterns);

            const traverse = async (currentPath: string): Promise<void> => {
                const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
                const currentRelativePath = path.relative(codebasePath, currentPath).replace(/\\/g, '/');

                for (const entry of entries) {
                    const fullPath = path.join(currentPath, entry.name);
                    const relativePath = path.relative(codebasePath, fullPath).replace(/\\/g, '/');

                    if (entry.isFile()) {
                        if (!currentRelativePath && entry.name.startsWith('.') && entry.name.endsWith('ignore')) {
                            ignoreFiles.push({ filePath: fullPath, scopeRelativePath: '' });
                        } else if (currentRelativePath && entry.name === '.gitignore') {
                            ignoreFiles.push({ filePath: fullPath, scopeRelativePath: currentRelativePath });
                        }
                    } else if (entry.isDirectory() && !baseMatcher.shouldIgnore(relativePath, true)) {
                        await traverse(fullPath);
                    }
                }
            };

            await traverse(codebasePath);
            ignoreFiles.push(...this.resolveAdditionalIgnoreFiles(codebasePath, additionalIgnoreFiles));

            if (ignoreFiles.length > 0) {
                console.log(`📄 Found ignore files: ${ignoreFiles.map(f => path.relative(codebasePath, f.filePath)).join(', ')}`);
            }

            return this.dedupeIgnoreFiles(ignoreFiles);
        } catch (error) {
            console.warn(`[Context] ⚠️ Failed to scan for ignore files: ${error}`);
            return this.resolveAdditionalIgnoreFiles(codebasePath, additionalIgnoreFiles);
        }
    }

    private resolveAdditionalIgnoreFiles(codebasePath: string, requestIgnoreFiles: string[]): IgnoreFileEntry[] {
        return this.dedupePatterns([...this.baseIgnoreFiles, ...requestIgnoreFiles])
            .map(ignoreFile => ignoreFile.trim())
            .filter(ignoreFile => ignoreFile.length > 0)
            .map(ignoreFile => path.isAbsolute(ignoreFile)
                ? ignoreFile
                : path.join(codebasePath, ignoreFile))
            .map(filePath => ({ filePath, scopeRelativePath: '' }));
    }

    private dedupeIgnoreFiles(ignoreFiles: IgnoreFileEntry[]): IgnoreFileEntry[] {
        const seen = new Set<string>();
        const deduped: IgnoreFileEntry[] = [];

        for (const ignoreFile of ignoreFiles) {
            if (!seen.has(ignoreFile.filePath)) {
                seen.add(ignoreFile.filePath);
                deduped.push(ignoreFile);
            }
        }

        return deduped;
    }

    private scopeIgnorePatterns(patterns: string[], scopeRelativePath: string): string[] {
        const normalizedScope = scopeRelativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!normalizedScope) {
            return patterns;
        }

        return patterns.map(pattern => this.scopeIgnorePattern(pattern, normalizedScope));
    }

    private scopeIgnorePattern(pattern: string, scopeRelativePath: string): string {
        const isNegative = pattern.startsWith('!');
        const marker = isNegative ? '!' : '';
        const body = isNegative ? pattern.slice(1) : pattern;

        if (!body || body.startsWith('#')) {
            return pattern;
        }

        if (body.startsWith('/')) {
            return `${marker}${scopeRelativePath}/${body.replace(/^\/+/, '')}`;
        }

        const bodyWithoutTrailingSlash = body.replace(/\/+$/g, '');
        if (bodyWithoutTrailingSlash.includes('/')) {
            return `${marker}${scopeRelativePath}/${body}`;
        }

        return `${marker}${scopeRelativePath}/**/${body}`;
    }

    /**
     * Load global ignore file from ~/.hitmux-context-engine/.hitmux-context-engineignore
     * @returns Array of ignore patterns
     */
    private async loadGlobalIgnoreFile(): Promise<string[]> {
        try {
            const homeDir = require('os').homedir();
            const globalIgnorePath = path.join(homeDir, '.hitmux-context-engine', '.hitmux-context-engineignore');
            return await this.loadIgnoreFile(globalIgnorePath, 'global .hitmux-context-engineignore');
        } catch {
            // Global ignore file is optional, don't log warnings
            return [];
        }
    }

    /**
     * Load ignore patterns from a specific ignore file
     * @param filePath Path to the ignore file
     * @param fileName Display name for logging
     * @returns Array of ignore patterns
     */
    private async loadIgnoreFile(filePath: string, fileName: string): Promise<string[]> {
        try {
            await fs.promises.access(filePath);
            console.log(`📄 Found ${fileName} file at: ${filePath}`);

            const ignorePatterns = await Context.getIgnorePatternsFromFile(filePath);

            if (ignorePatterns.length > 0) {
                console.log(`[Context] 🚫 Loaded ${ignorePatterns.length} ignore patterns from ${fileName}`);
                return ignorePatterns;
            } else {
                console.log(`📄 ${fileName} file found but no valid patterns detected`);
                return [];
            }
        } catch {
            if (fileName.includes('global')) {
                console.log(`📄 No ${fileName} file found`);
            }
            return [];
        }
    }

    private dedupePatterns(patterns: string[]): string[] {
        return [...new Set(patterns)];
    }

    private normalizeMaxDepth(maxDepth?: number): number | undefined {
        if (maxDepth === undefined || maxDepth === null) {
            return undefined;
        }
        if (!Number.isFinite(maxDepth) || maxDepth < 0) {
            return undefined;
        }
        return Math.floor(maxDepth);
    }

    /**
     * Get custom extensions from global config.
     * @returns Array of custom extensions
     */
    private getCustomExtensionsFromConfig(): string[] {
        const configuredExtensions = configManager.getStringArray('customExtensions');
        if (configuredExtensions.length === 0) {
            return [];
        }

        try {
            const extensions = configuredExtensions
                .map(ext => ext.trim())
                .filter(ext => ext.length > 0)
                .map(ext => ext.startsWith('.') ? ext : `.${ext}`); // Ensure extensions start with dot

            return extensions;
        } catch (error) {
            console.warn(`[Context] ⚠️  Failed to parse customExtensions from config: ${error}`);
            return [];
        }
    }

    /**
     * Get custom ignore patterns from global config.
     * @returns Array of custom ignore patterns
     */
    private getCustomIgnorePatternsFromConfig(): string[] {
        const configuredIgnorePatterns = configManager.getStringArray('customIgnorePatterns');
        if (configuredIgnorePatterns.length === 0) {
            return [];
        }

        try {
            const patterns = configuredIgnorePatterns
                .map(pattern => pattern.trim())
                .filter(pattern => pattern.length > 0);

            return patterns;
        } catch (error) {
            console.warn(`[Context] ⚠️  Failed to parse customIgnorePatterns from config: ${error}`);
            return [];
        }
    }

    private normalizeExtensions(extensions: string[]): string[] {
        return extensions
            .map(ext => ext.trim())
            .map(ext => this.normalizeExtension(ext))
            .filter((ext): ext is string => ext !== null);
    }

    private normalizeExtension(ext: string): string | null {
        if (ext.length === 0) {
            return '';
        }

        const extensionlessAliases = new Set([
            '<extensionless>',
            'extensionless',
            '<no-extension>',
            'no-extension',
            'no_extension',
            '<none>',
            'none'
        ]);

        if (extensionlessAliases.has(ext.toLowerCase())) {
            return '';
        }

        return ext.startsWith('.') ? ext : `.${ext}`;
    }

    /**
     * Add custom extensions (from MCP or other sources) without replacing existing ones
     * @param customExtensions Array of custom extensions to add
     */
    addCustomExtensions(customExtensions: string[]): void {
        if (customExtensions.length === 0) return;

        const normalizedExtensions = this.normalizeExtensions(customExtensions);

        // Merge current extensions with new custom extensions, avoiding duplicates
        const mergedExtensions = [...this.supportedExtensions, ...normalizedExtensions];
        const uniqueExtensions: string[] = [...new Set(mergedExtensions)];
        this.supportedExtensions = uniqueExtensions;
        console.log(`[Context] 📎 Added ${customExtensions.length} custom extensions. Total: ${this.supportedExtensions.length} extensions`);
    }

    /**
     * Get current splitter information
     */
    getSplitterInfo(): { type: string; hasBuiltinFallback: boolean; supportedLanguages?: string[] } {
        const splitterName = this.codeSplitter.constructor.name;

        if (splitterName === 'AstCodeSplitter') {
            const { AstCodeSplitter } = require('./splitter/ast-splitter');
            return {
                type: 'ast',
                hasBuiltinFallback: true,
                supportedLanguages: AstCodeSplitter.getSupportedLanguages()
            };
        } else {
            return {
                type: 'langchain',
                hasBuiltinFallback: false
            };
        }
    }

    /**
     * Check if current splitter supports a specific language
     * @param language Programming language
     */
    isLanguageSupported(language: string): boolean {
        const splitterName = this.codeSplitter.constructor.name;

        if (splitterName === 'AstCodeSplitter') {
            const { AstCodeSplitter } = require('./splitter/ast-splitter');
            return AstCodeSplitter.isLanguageSupported(language);
        }

        // LangChain splitter supports most languages
        return true;
    }

    /**
     * Get which strategy would be used for a specific language
     * @param language Programming language
     */
    getSplitterStrategyForLanguage(language: string): { strategy: 'ast' | 'langchain'; reason: string } {
        const splitterName = this.codeSplitter.constructor.name;

        if (splitterName === 'AstCodeSplitter') {
            const { AstCodeSplitter } = require('./splitter/ast-splitter');
            const isSupported = AstCodeSplitter.isLanguageSupported(language);

            return {
                strategy: isSupported ? 'ast' : 'langchain',
                reason: isSupported
                    ? 'Language supported by AST parser'
                    : 'Language not supported by AST, will fallback to LangChain'
            };
        } else {
            return {
                strategy: 'langchain',
                reason: 'Using LangChain splitter directly'
            };
        }
    }
}
