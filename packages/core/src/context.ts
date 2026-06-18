import {
    Splitter,
    CodeChunk,
    AstCodeSplitter
} from './splitter';
import {
    Embedding,
    EmbeddingVector,
    OpenAIEmbedding,
    getEmbeddingIndexingDefaults
} from './embedding';
import {
    VectorDatabase,
    VectorDocument,
    VectorSearchResult,
    HybridSearchRequest,
    HybridSearchResult,
    InsertOptions,
    DEFAULT_SEARCH_OUTPUT_FIELDS,
    STRUCTURED_METADATA_FIELDS
} from './vectordb';
import {
    SearchResultGroup,
    SearchScoreReason,
    SearchTargetRole,
    SemanticSearchFilenameLikeQuery,
    SemanticSearchOptions,
    SemanticSearchResult,
    SymbolTraceOptions,
    SymbolTraceResult
} from './types';
import { configManager } from './utils/config-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileSynchronizer } from './sync/synchronizer';
import { CodebaseIdentityOptions, resolveCodebaseIdentity } from './utils/path-identity';
import { IgnoreMatcher } from './utils/ignore-matcher';
import {
    classifyFileRole,
    FileRole,
    FileRoleIntent,
    inferFileRoleIntent,
    isFileRoleExplicitlyRequested
} from './search/file-role';
import { normalizeLineRange } from './search/line-range';
import { diversifySemanticSearchResultsByFile } from './search/result-diversify';
import { deduplicateSemanticSearchResults, getNormalizedContentHash } from './search/result-dedupe';
import { traceSymbolInFiles } from './search/symbol-trace';
import { countEffectiveLinesInContent } from './utils/effective-lines';

const FILE_TOKEN_PATTERN = /(?:^|[\s"'`(<{\[])([A-Za-z0-9_.@+~-]+(?:[\\/][A-Za-z0-9_.@+~-]+)*\.[A-Za-z0-9][A-Za-z0-9_+-]{0,15})(?=$|[\s"'`),}\]>:;!?])/g;

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

export class IncrementalIndexTooLargeError extends Error {
    constructor(
        public readonly effectiveLines: number,
        public readonly threshold: number,
        public readonly changedFiles: number
    ) {
        super(
            `Automatic incremental indexing paused because ${changedFiles} added/modified file(s) contain ${effectiveLines} effective lines, exceeding the automatic sync limit of ${threshold}. Check whether these files should be ignored in .hceignore. If they should be indexed, run an explicit MCP index_codebase call with incremental=true after reviewing the change set.`
        );
        this.name = 'IncrementalIndexTooLargeError';
    }
}

interface ReindexByChangeOptions {
    skipEffectiveLineLimit?: boolean;
}

interface IncrementalChanges {
    added: string[];
    removed: string[];
    modified: string[];
}

interface FileProcessingProgress {
    filePath: string;
    fileIndex: number;
    totalFiles: number;
    processedChunks: number;
    totalChunks: number;
    fileProgress: number;
}

interface IndexingTimingMetrics {
    totalIndexingMs: number;
    prepareCollectionMs: number;
    loadIgnorePatternsMs: number;
    scanFilesMs: number;
    fileWeightStatMs: number;
    readAndSplitMs: number;
    embeddingMs: number;
    vectorInsertMs: number;
    flushLoadMs: number;
    verifyMs: number;
}

interface CodeFileDiscoveryMetrics {
    fileSizes: Map<string, number>;
    fileStatMs: number;
}

interface VectorDatabasePerformanceMetrics {
    flushLoadMs?: number;
}

interface InstrumentedVectorDatabase extends VectorDatabase {
    drainPerformanceMetrics?: () => VectorDatabasePerformanceMetrics;
}

interface ProcessFileListOptions {
    deferVectorFlushLoad?: boolean;
    ensureCollectionBeforeInsert?: (dimension: number) => Promise<void>;
    knownFileSizes?: Map<string, number>;
}

interface ChunkBatchInsertOptions extends InsertOptions {
    ensureCollectionBeforeInsert?: (dimension: number) => Promise<void>;
}

interface PrepareCollectionOptions {
    rejectExistingFullIndex?: boolean;
    createIfMissing?: boolean;
    dimension?: number;
    abortSignal?: AbortSignal;
}

interface PrepareCollectionResult {
    collectionName: string;
    collectionExists: boolean;
    created: boolean;
    creationDeferred: boolean;
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

const DEFAULT_AUTOMATIC_INCREMENTAL_EFFECTIVE_LINE_LIMIT = 5_000;
const MAX_INDEX_FILE_BYTES = 128 * 1024 * 1024;

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

export class CollectionSchemaMismatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CollectionSchemaMismatchError';
    }
}

export class ExistingCollectionFullIndexError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ExistingCollectionFullIndexError';
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
    schemaVersion?: number;
    metadataVersion?: number;
    splitterType?: string;
    createdAt: string;
}

interface RankedSearchResult extends SemanticSearchResult {
    vectorScore: number;
    lexicalScore: number;
    ownerTier: number;
    originalRank: number;
    lexicalMetadata?: QueryRow;
}

interface GroupedSearchResult extends SemanticSearchResult {
    fileRole: FileRole;
    resultGroup: SearchResultGroup;
    isPrimary: boolean;
    roleSortPriority: number;
    ownerSignalPriority: number;
    structureScore: number;
    originalOrder: number;
}

interface NormalizedSemanticSearchOptions {
    targetRole: SearchTargetRole;
    includeRelated: boolean;
    filenameLikeQuery?: SemanticSearchFilenameLikeQuery;
}

interface StructuralSearchTerms {
    terms: string[];
    variants: string[];
}

type QueryRow = Record<string, unknown>;

interface LexicalMatchScore {
    score: number;
    reasons: SearchScoreReason[];
    ownerTier: number;
}

interface LexicalSearchTerms {
    strongAnchors: string[];
    weakDescriptors: string[];
    roleHints: string[];
    pathHints: string[];
    literalAnchors: string[];
    recallTerms: string[];
    scoringTerms: string[];
}

interface RankedLexicalCandidate {
    result: SemanticSearchResult;
    metadata: QueryRow;
    lexicalScore: LexicalMatchScore;
}

const LEXICAL_OWNER_TIERS = {
    exactFilename: 600,
    exactDefinition: 500,
    pathOwner: 400,
    reference: 300,
    semantic: 0
} as const;

const LEXICAL_EXACT_CANDIDATE_LIMIT_MIN = 100;
const LEXICAL_EXACT_CANDIDATE_LIMIT_MAX = 200;
const LEXICAL_BROAD_CANDIDATE_LIMIT_MIN = 40;
const LEXICAL_BROAD_CANDIDATE_LIMIT_MAX = 80;
const SEARCH_CANDIDATE_LIMIT_MULTIPLIER = 4;
const SEARCH_CANDIDATE_LIMIT_MIN = 80;
const SEARCH_CANDIDATE_LIMIT_MAX = 200;

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
    private static readonly COLLECTION_SCHEMA_VERSION = 2;
    private static readonly COLLECTION_METADATA_VERSION = 2;

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
    private activeIndexingBatchCount: number = 0;
    private indexingBatchWaiters: Array<() => void> = [];

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

        const configuredCustomExtensions = this.getGlobalCustomExtensionsFromConfig();

        // Combine default extensions with config and global extensions.
        const allSupportedExtensions = [
            ...DEFAULT_SUPPORTED_EXTENSIONS,
            ...(config.supportedExtensions || []),
            ...(config.customExtensions || []),
            ...configuredCustomExtensions
        ];
        // Remove duplicates
        this.supportedExtensions = [...new Set(this.normalizeExtensions(allSupportedExtensions))];

        const configuredCustomIgnorePatterns = this.getGlobalCustomIgnorePatternsFromConfig();

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
    getEffectiveSupportedExtensions(additionalExtensions: string[] = [], codebasePath?: string): string[] {
        const normalizedExtensions = this.normalizeExtensions(additionalExtensions);
        const configuredExtensions = codebasePath ? this.getCustomExtensionsFromConfig(codebasePath) : [];
        return [...new Set([...this.supportedExtensions, ...configuredExtensions, ...normalizedExtensions])];
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
        const supportedExtensions = this.getEffectiveSupportedExtensions(additionalSupportedExtensions, codebasePath);
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
        await this.prepareCollection(codebasePath);
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
        this.throwIfIndexAborted(signal);
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🚀 Starting to index codebase with ${searchType}: ${codebasePath}`);
        const splitter = requestSplitter || this.codeSplitter;
        const timingMetrics = this.createIndexingTimingMetrics();
        const indexingStartedAt = this.getMonotonicMs();
        const fileDiscoveryMetrics: CodeFileDiscoveryMetrics = {
            fileSizes: new Map<string, number>(),
            fileStatMs: 0
        };
        this.drainVectorDatabasePerformanceMetrics();

        // 1. Compute ignore patterns for this codebase/request without
        // retaining file-based patterns from previous codebases.
        const ignorePatterns = await this.measureIndexingStage(
            timingMetrics,
            'loadIgnorePatternsMs',
            () => this.loadIgnorePatterns(
                codebasePath,
                additionalIgnorePatterns,
                requestOptions.additionalIgnoreFiles || []
            )
        );
        this.throwIfIndexAborted(signal);

        // 2. Check and prepare vector collection
        progressCallback?.({ phase: 'Preparing collection...', current: 0, total: 100, percentage: 0 });
        console.log(`Debug2: Preparing vector collection for codebase${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        const prepareResult = await this.measureIndexingStage(
            timingMetrics,
            'prepareCollectionMs',
            () => this.prepareCollection(codebasePath, forceReindex, splitter, {
                rejectExistingFullIndex: true,
                createIfMissing: false,
                abortSignal: signal
            })
        );
        this.throwIfIndexAborted(signal);
        let deferredCollectionCreation: Promise<void> | undefined;
        let deferredCollectionDimension: number | undefined;
        const ensureCollectionBeforeInsert = prepareResult.creationDeferred
            ? async (dimension: number): Promise<void> => {
                if (deferredCollectionDimension !== undefined && deferredCollectionDimension !== dimension) {
                    throw new EmbeddingError(
                        `Embedding API returned inconsistent vector dimensions during indexing: first batch=${deferredCollectionDimension}, current batch=${dimension}`
                    );
                }

                deferredCollectionDimension = dimension;
                if (!deferredCollectionCreation) {
                    deferredCollectionCreation = this.measureIndexingStage(
                        timingMetrics,
                        'prepareCollectionMs',
                        () => this.createCollectionWithDimension(codebasePath, splitter, dimension)
                    ).then(() => undefined);
                }

                await deferredCollectionCreation;
            }
            : undefined;

        // 3. Recursively traverse codebase to get all supported files
        progressCallback?.({ phase: 'Scanning files...', current: 5, total: 100, percentage: 5 });
        const supportedExtensions = this.getEffectiveSupportedExtensions(additionalSupportedExtensions, codebasePath);
        const codeFiles = await this.measureIndexingStage(
            timingMetrics,
            'scanFilesMs',
            () => this.getCodeFiles(
                codebasePath,
                ignorePatterns,
                supportedExtensions,
                requestOptions.maxDepth,
                fileDiscoveryMetrics
            )
        );
        timingMetrics.scanFilesMs = Math.max(0, timingMetrics.scanFilesMs - fileDiscoveryMetrics.fileStatMs);
        timingMetrics.fileWeightStatMs += fileDiscoveryMetrics.fileStatMs;
        console.log(`[Context] 📁 Found ${codeFiles.length} code files`);

        if (codeFiles.length === 0) {
            progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
            timingMetrics.totalIndexingMs = this.getMonotonicMs() - indexingStartedAt;
            this.logIndexingTimingSummary(codebasePath, {
                indexedFiles: 0,
                totalChunks: 0,
                embeddingBatchSize: this.getEmbeddingBatchSize(codebasePath),
                embeddingConcurrency: this.getEmbeddingConcurrency(codebasePath),
                fileProcessingConcurrency: this.getFileProcessingConcurrency(codebasePath)
            }, timingMetrics);
            return { indexedFiles: 0, totalChunks: 0, status: 'completed' };
        }

        // 3. Process each file with streaming chunk processing.
        // Reserve 10% for preparation/scanning and 5% for final verification.
        const indexingStartPercentage = 10;
        const indexingEndPercentage = 95;
        const progressTracker = await this.measureIndexingStage(
            timingMetrics,
            'fileWeightStatMs',
            () => this.createWeightedFileProgressTracker(
                codeFiles,
                indexingStartPercentage,
                indexingEndPercentage,
                progressCallback,
                fileDiscoveryMetrics.fileSizes
            )
        );

        const result = await this.processFileList(
            codeFiles,
            codebasePath,
            (filePath, fileIndex, totalFiles) => {
                console.log(`[Context] 📊 Processed ${fileIndex}/${totalFiles} files`);
                progressTracker.completeFile(filePath, `Processing files (${fileIndex}/${totalFiles})...`);
            },
            splitter,
            signal,
            (progress) => {
                progressTracker.updateFile(
                    progress.filePath,
                    progress.fileProgress,
                    `Processing ${path.relative(codebasePath, progress.filePath)} (${progress.processedChunks}/${progress.totalChunks} chunks)...`
                );
            },
            timingMetrics,
            {
                deferVectorFlushLoad: true,
                ensureCollectionBeforeInsert,
                knownFileSizes: fileDiscoveryMetrics.fileSizes
            }
        );

        await this.measureIndexingStage(
            timingMetrics,
            'verifyMs',
            () => this.verifyIndexedCollection(codebasePath, result.totalChunks)
        );
        this.drainVectorDatabasePerformanceMetrics(timingMetrics);

        console.log(`[Context] ✅ Codebase indexing completed! Processed ${result.processedFiles} files in total, generated ${result.totalChunks} code chunks`);
        timingMetrics.totalIndexingMs = this.getMonotonicMs() - indexingStartedAt;
        this.logIndexingTimingSummary(codebasePath, {
            indexedFiles: result.processedFiles,
            totalChunks: result.totalChunks,
            embeddingBatchSize: result.embeddingBatchSize,
            embeddingConcurrency: result.embeddingConcurrency,
            fileProcessingConcurrency: result.fileProcessingConcurrency
        }, timingMetrics);

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
        maxDepth?: number,
        options: ReindexByChangeOptions = {}
    ): Promise<{ added: number, removed: number, modified: number }> {
        const collectionName = this.getCollectionName(codebasePath);
        const splitter = requestSplitter || this.codeSplitter;

        // Recreate the synchronizer on each sync so newly added or edited
        // ignore files affect the next incremental check without a restart.
        const ignorePatterns = await this.loadIgnorePatterns(codebasePath, additionalIgnorePatterns, additionalIgnoreFiles);
        const supportedExtensions = this.getEffectiveSupportedExtensions(additionalSupportedExtensions, codebasePath);
        const currentSynchronizer = new FileSynchronizer(codebasePath, ignorePatterns, supportedExtensions, { maxDepth });
        await currentSynchronizer.initialize();
        this.synchronizers.set(collectionName, currentSynchronizer);


        progressCallback?.({ phase: 'Checking for file changes...', current: 0, total: 100, percentage: 0 });
        const { added, removed, modified } = await currentSynchronizer.checkForChanges({ deferSnapshotUpdate: true });
        return this.applyIncrementalChanges(
            codebasePath,
            collectionName,
            currentSynchronizer,
            { added, removed, modified },
            splitter,
            progressCallback,
            options
        );
    }

    async reindexChangedPaths(
        codebasePath: string,
        relativePaths: string[],
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        additionalIgnorePatterns: string[] = [],
        additionalSupportedExtensions: string[] = [],
        requestSplitter?: Splitter,
        additionalIgnoreFiles: string[] = [],
        maxDepth?: number,
        options: ReindexByChangeOptions = {}
    ): Promise<{ added: number, removed: number, modified: number }> {
        const collectionName = this.getCollectionName(codebasePath);
        const splitter = requestSplitter || this.codeSplitter;

        const ignorePatterns = await this.loadIgnorePatterns(codebasePath, additionalIgnorePatterns, additionalIgnoreFiles);
        const supportedExtensions = this.getEffectiveSupportedExtensions(additionalSupportedExtensions, codebasePath);
        const currentSynchronizer = new FileSynchronizer(codebasePath, ignorePatterns, supportedExtensions, { maxDepth });
        await currentSynchronizer.initialize();
        this.synchronizers.set(collectionName, currentSynchronizer);

        progressCallback?.({ phase: 'Checking targeted file changes...', current: 0, total: 100, percentage: 0 });
        const changes = await currentSynchronizer.checkChangedPaths(relativePaths, { deferSnapshotUpdate: true });
        return this.applyIncrementalChanges(
            codebasePath,
            collectionName,
            currentSynchronizer,
            changes,
            splitter,
            progressCallback,
            options
        );
    }

    private async applyIncrementalChanges(
        codebasePath: string,
        collectionName: string,
        currentSynchronizer: FileSynchronizer,
        changes: IncrementalChanges,
        splitter: Splitter,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        options: ReindexByChangeOptions = {}
    ): Promise<{ added: number, removed: number, modified: number }> {
        const { added, removed, modified } = changes;
        const totalChanges = added.length + removed.length + modified.length;

        if (totalChanges === 0) {
            await currentSynchronizer.commitPendingChanges();
            progressCallback?.({ phase: 'No changes detected', current: 100, total: 100, percentage: 100 });
            console.log('[Context] ✅ No file changes detected.');
            return { added: 0, removed: 0, modified: 0 };
        }

        console.log(`[Context] 🔄 Found changes: ${added.length} added, ${removed.length} removed, ${modified.length} modified.`);

        const filesToIndex = [...added, ...modified].map(f => path.join(codebasePath, f));
        if (filesToIndex.length > 0) {
            const { effectiveLines, changedFiles } = currentSynchronizer.getPendingEffectiveLineIncrease(added, modified);
            const effectiveLineLimit = this.getAutomaticIncrementalEffectiveLineLimit(codebasePath);
            if (!options.skipEffectiveLineLimit && effectiveLines > effectiveLineLimit) {
                currentSynchronizer.discardPendingChanges();
                throw new IncrementalIndexTooLargeError(
                    effectiveLines,
                    effectiveLineLimit,
                    changedFiles
                );
            }
        }

        const fileWeights = await this.getFileProcessingWeights(filesToIndex);
        const deletionWeight = 1;
        const deletionWeightTotal = (removed.length + modified.length) * deletionWeight;
        const totalWorkWeight = Math.max(deletionWeightTotal + fileWeights.totalWeight, 1);
        let completedWorkWeight = 0;
        let lastProgressPercentage = -1;
        const completedIndexFiles = new Set<string>();
        const emitProgress = (phase: string, currentWorkWeight: number) => {
            const computedPercentage = Math.max(0, Math.min(100, Math.round((currentWorkWeight / totalWorkWeight) * 100)));
            const percentage = Math.max(lastProgressPercentage, computedPercentage);
            if (percentage === lastProgressPercentage && percentage !== 100) {
                return;
            }
            lastProgressPercentage = percentage;
            progressCallback?.({
                phase,
                current: Math.round(currentWorkWeight),
                total: Math.round(totalWorkWeight),
                percentage
            });
        };
        const completeDeletionWork = (phase: string) => {
            completedWorkWeight += deletionWeight;
            emitProgress(phase, completedWorkWeight);
        };
        const updateIndexFileProgress = (filePath: string, fileProgress: number, phase: string) => {
            const fileWeight = fileWeights.weights.get(filePath) || 1;
            emitProgress(phase, completedWorkWeight + fileWeight * Math.max(0, Math.min(1, fileProgress)));
        };
        const completeIndexFile = (filePath: string, phase: string) => {
            if (!completedIndexFiles.has(filePath)) {
                completedIndexFiles.add(filePath);
                completedWorkWeight += fileWeights.weights.get(filePath) || 1;
            }
            emitProgress(phase, completedWorkWeight);
        };

        for (const file of removed) {
            await this.deleteFileChunks(collectionName, file);
            completeDeletionWork(`Removed ${file}`);
        }

        for (const file of modified) {
            await this.deleteFileChunks(collectionName, file);
            completeDeletionWork(`Deleted old chunks for ${file}`);
        }

        if (filesToIndex.length > 0) {
            await this.processFileList(
                filesToIndex,
                codebasePath,
                (filePath, fileIndex, totalFiles) => {
                    completeIndexFile(filePath, `Indexed ${filePath} (${fileIndex}/${totalFiles})`);
                },
                splitter,
                undefined,
                (progress) => {
                    updateIndexFileProgress(
                        progress.filePath,
                        progress.fileProgress,
                        `Indexing ${path.relative(codebasePath, progress.filePath)} (${progress.processedChunks}/${progress.totalChunks} chunks)`
                    );
                }
            );
        }

        await currentSynchronizer.commitPendingChanges();

        console.log(`[Context] ✅ Re-indexing complete. Added: ${added.length}, Removed: ${removed.length}, Modified: ${modified.length}`);
        progressCallback?.({ phase: 'Re-indexing complete!', current: totalChanges, total: totalChanges, percentage: 100 });

        return { added: added.length, removed: removed.length, modified: modified.length };
    }

    private async countEffectiveLines(filePaths: string[]): Promise<number> {
        let total = 0;

        for (const filePath of filePaths) {
            total += await this.countEffectiveLinesInFile(filePath);
        }

        return total;
    }

    private async countEffectiveLinesInFile(filePath: string): Promise<number> {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        return countEffectiveLinesInContent(content);
    }

    private getAutomaticIncrementalEffectiveLineLimit(codebasePath: string): number {
        const configured = configManager.getNumber('automaticIncrementalEffectiveLineLimit', codebasePath);
        if (Number.isFinite(configured) && configured! >= 0) {
            return Math.floor(configured!);
        }

        return DEFAULT_AUTOMATIC_INCREMENTAL_EFFECTIVE_LINE_LIMIT;
    }

    private async deleteFileChunks(collectionName: string, relativePath: string): Promise<void> {
        const normalizedPath = relativePath.replace(/\\/g, '/');
        const escapedPath = this.escapeFilterString(normalizedPath);
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
    async semanticSearch(
        codebasePath: string,
        query: string,
        topK: number = 5,
        threshold: number = 0.5,
        filterExpr?: string,
        options: SemanticSearchOptions = {}
    ): Promise<SemanticSearchResult[]> {
        return this.withSearchTimeout(
            this.performSemanticSearch(codebasePath, query, topK, threshold, filterExpr, options),
            codebasePath,
            query
        );
    }

    async traceSymbol(
        codebasePath: string,
        symbol: string,
        options: SymbolTraceOptions = {}
    ): Promise<SymbolTraceResult> {
        const ignorePatterns = await this.loadIgnorePatterns(codebasePath);
        const allFiles = await this.getCodeFiles(codebasePath, ignorePatterns);
        return traceSymbolInFiles({
            codebasePath,
            symbol,
            options,
            files: allFiles,
            supportedExtensions: this.supportedExtensions
        });
    }

    private async performSemanticSearch(
        codebasePath: string,
        query: string,
        topK: number = 5,
        threshold: number = 0.5,
        filterExpr?: string,
        options: SemanticSearchOptions = {}
    ): Promise<SemanticSearchResult[]> {
        const outputLimit = this.normalizeSearchOutputLimit(topK);
        const candidateLimit = this.getSearchCandidateLimit(outputLimit);
        const searchOptions = this.normalizeSemanticSearchOptions(query, options);
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🔍 Executing ${searchType}: "${query}" in ${codebasePath}`);
        console.log(`[Context] 🔍 Search limits: output=${outputLimit}, candidates=${candidateLimit}`);

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
                const rowCount = await this.vectorDatabase.getCollectionRowCount(collectionName);
                if (rowCount === 0) {
                    console.log(`[Context] ⚠️  Collection '${collectionName}' exists but has 0 searchable rows. Please re-index the codebase.`);
                    return [];
                }
                if (rowCount > 0) {
                    console.log(`[Context] 🔍 Collection '${collectionName}' exists and has ${rowCount} searchable rows`);
                } else {
                    const sampleRows = await this.vectorDatabase.query(collectionName, '', ['id'], 1);
                    if (sampleRows.length === 0) {
                        console.log(`[Context] ⚠️  Collection '${collectionName}' exists but returned no sample rows. Please re-index the codebase.`);
                        return [];
                    }
                    console.log(`[Context] 🔍 Collection '${collectionName}' exists and appears to have data`);
                }
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
                    limit: candidateLimit
                },
                {
                    data: query,
                    anns_field: "sparse_vector",
                    param: { "drop_ratio_search": 0.2 },
                    limit: candidateLimit
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
                    limit: candidateLimit,
                    filterExpr
                }
            );

            console.log(`[Context] 🔍 Raw search results count: ${searchResults.length}`);

            // 4. Convert to semantic search result format
            const results: SemanticSearchResult[] = searchResults.map(result => this.vectorSearchResultToSemanticSearchResult(
                result.document,
                result.score
            ));

            const rankedResults = await this.addLexicalSearchResults(collectionName, query, candidateLimit, outputLimit, filterExpr, results, searchOptions);
            const dedupedResults = this.applySearchResultGrouping(this.deduplicateResults(rankedResults), searchOptions, query, filterExpr, outputLimit);
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
                { topK: candidateLimit, threshold, filterExpr }
            );

            // 3. Convert to semantic search result format
            const results: SemanticSearchResult[] = searchResults.map(result => this.vectorSearchResultToSemanticSearchResult(
                result.document,
                result.score
            ));

            const rankedResults = await this.addLexicalSearchResults(collectionName, query, candidateLimit, outputLimit, filterExpr, results, searchOptions);
            const dedupedResults = this.applySearchResultGrouping(this.deduplicateResults(rankedResults), searchOptions, query, filterExpr, outputLimit);
            console.log(`[Context] ✅ Found ${results.length} results, ${dedupedResults.length} after dedup`);
            return dedupedResults;
        }
    }

    private normalizeSearchOutputLimit(topK: number): number {
        return Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 5;
    }

    private getSearchCandidateLimit(outputLimit: number): number {
        // Keep visible output small while giving rerank/dedupe enough recall;
        // the cap bounds Milvus dense/sparse request volume for large limits.
        return Math.min(
            Math.max(outputLimit * SEARCH_CANDIDATE_LIMIT_MULTIPLIER, SEARCH_CANDIDATE_LIMIT_MIN),
            SEARCH_CANDIDATE_LIMIT_MAX
        );
    }

    private normalizeSemanticSearchOptions(query: string, options: SemanticSearchOptions): NormalizedSemanticSearchOptions {
        const explicitFilenameLikeQuery = this.isSemanticSearchFilenameLikeQuery(options.filenameLikeQuery)
            ? options.filenameLikeQuery
            : undefined;
        const inferredFilenameLikeQuery = explicitFilenameLikeQuery
            ? undefined
            : this.extractFilenameLikeQuery(query);

        return {
            targetRole: this.isSearchTargetRole(options.targetRole) ? options.targetRole : 'implementation',
            includeRelated: options.includeRelated !== false,
            ...(explicitFilenameLikeQuery ?? inferredFilenameLikeQuery
                ? { filenameLikeQuery: explicitFilenameLikeQuery ?? inferredFilenameLikeQuery }
                : {})
        };
    }

    private extractFilenameLikeQuery(query: string): SemanticSearchFilenameLikeQuery | undefined {
        const matches: SemanticSearchFilenameLikeQuery[] = [];
        let match: RegExpExecArray | null;

        FILE_TOKEN_PATTERN.lastIndex = 0;
        while ((match = FILE_TOKEN_PATTERN.exec(query)) !== null) {
            const raw = match[1];
            if (!raw) {
                continue;
            }

            const normalizedPath = this.normalizeQueryPath(raw);
            if (!this.isLikelyFileToken(normalizedPath)) {
                continue;
            }

            const candidate: SemanticSearchFilenameLikeQuery = {
                normalizedPath,
                basename: path.posix.basename(normalizedPath),
                isPathLike: normalizedPath.includes('/')
            };

            if (!matches.some(existing => existing.normalizedPath === candidate.normalizedPath)) {
                matches.push(candidate);
            }
        }

        if (matches.length !== 1) {
            return undefined;
        }

        return this.isStandaloneFilenameLikeQuery(query, matches[0].normalizedPath) ? matches[0] : undefined;
    }

    private normalizeQueryPath(value: string): string {
        return value
            .trim()
            .replace(/\\/g, '/')
            .replace(/^\.\/+/, '')
            .replace(/\/+/g, '/');
    }

    private isLikelyFileToken(normalizedPath: string): boolean {
        const basename = path.posix.basename(normalizedPath);
        if (basename.length === 0 || basename === '.' || basename === '..') {
            return false;
        }

        if (/^\.[A-Za-z0-9_-]+$/.test(basename)) {
            return true;
        }

        const extension = path.posix.extname(basename);
        return extension.length >= 2 && extension.length <= 17 && /[A-Za-z0-9]/.test(extension.slice(1));
    }

    private isStandaloneFilenameLikeQuery(query: string, normalizedPath: string): boolean {
        const trimmedQuery = query
            .trim()
            .replace(/^[\s"'`(<{\[]+/, '')
            .replace(/[\s"'`),}\]>:;!?]+$/, '');
        return this.normalizeQueryPath(trimmedQuery) === normalizedPath;
    }

    private isSemanticSearchFilenameLikeQuery(value: unknown): value is SemanticSearchFilenameLikeQuery {
        if (!value || typeof value !== 'object') {
            return false;
        }

        const candidate = value as Partial<SemanticSearchFilenameLikeQuery>;
        return typeof candidate.normalizedPath === 'string'
            && candidate.normalizedPath.length > 0
            && typeof candidate.basename === 'string'
            && candidate.basename.length > 0
            && typeof candidate.isPathLike === 'boolean';
    }

    private isSearchTargetRole(value: unknown): value is SearchTargetRole {
        return value === 'implementation'
            || value === 'test'
            || value === 'docs'
            || value === 'config'
            || value === 'all';
    }

    private getSearchFileRoleIntent(query: string, filterExpr: string | undefined, targetRole: SearchTargetRole): FileRoleIntent {
        const inferredIntent = inferFileRoleIntent(query, filterExpr);
        const preferredRoles = new Set<FileRole>();
        if (targetRole === 'test') {
            preferredRoles.add('test');
        } else if (targetRole === 'docs') {
            preferredRoles.add('docs');
        } else if (targetRole === 'config') {
            preferredRoles.add('config');
        }

        return {
            preferredRoles,
            explicitExtensions: inferredIntent.explicitExtensions
        };
    }

    private applySearchResultGrouping(
        results: SemanticSearchResult[],
        options: NormalizedSemanticSearchOptions,
        query: string,
        filterExpr: string | undefined,
        outputLimit: number
    ): SemanticSearchResult[] {
        const roleIntent = this.getSearchFileRoleIntent(query, filterExpr, options.targetRole);
        const structuralTerms = this.extractStructuralSearchTerms(query);
        const decoratedResults: GroupedSearchResult[] = results.map((result, index) => {
            const fileRole = this.resolveResultFileRole(result);
            const resultGroup = this.getSearchResultGroup(fileRole);
            const isPrimary = this.isPrimarySearchResult(fileRole, options.targetRole, roleIntent, result.relativePath, query);
            const roleSortPriority = this.getSearchResultRoleSortPriority(fileRole, resultGroup, options.targetRole, roleIntent, result.relativePath, query);
            const ownerSignalPriority = this.getOwnerSignalPriority(result, query);
            const structureScore = this.getSearchResultStructureScore(result, structuralTerms, options.targetRole);
            return {
                ...result,
                fileRole,
                resultGroup,
                isPrimary,
                roleSortPriority,
                ownerSignalPriority,
                structureScore,
                originalOrder: index
            };
        });

        if (options.targetRole === 'all') {
            return decoratedResults
                .slice(0, outputLimit)
                .map(result => this.stripGroupedSearchResultSortFields(result));
        }

        const orderedResults = options.includeRelated
            ? decoratedResults.sort((a, b) => {
                const primaryDelta = Number(b.isPrimary) - Number(a.isPrimary);
                if (primaryDelta !== 0) return primaryDelta;

                const rolePriorityDelta = a.roleSortPriority - b.roleSortPriority;
                if (rolePriorityDelta !== 0) return rolePriorityDelta;

                const ownerSignalDelta = a.ownerSignalPriority - b.ownerSignalPriority;
                if (ownerSignalDelta !== 0) return ownerSignalDelta;

                const structureDelta = b.structureScore - a.structureScore;
                if (structureDelta !== 0) return structureDelta;

                const scoreDelta = b.score - a.score;
                if (scoreDelta !== 0) return scoreDelta;

                return a.originalOrder - b.originalOrder;
            })
            : decoratedResults.filter(result => result.isPrimary);

        if (!options.includeRelated) {
            return diversifySemanticSearchResultsByFile(orderedResults, outputLimit)
                .map(result => this.stripGroupedSearchResultSortFields(result));
        }

        const primaryResults = orderedResults.filter(result => result.isPrimary);
        const relatedResults = orderedResults.filter(result => !result.isPrimary);
        const relatedReserve = this.getRelatedResultReserve(outputLimit, primaryResults.length, relatedResults.length);
        const selectedPrimary = diversifySemanticSearchResultsByFile(primaryResults, Math.max(0, outputLimit - relatedReserve));
        const selectedRelated = this.selectRelatedSearchResults(
            diversifySemanticSearchResultsByFile(relatedResults, relatedResults.length),
            outputLimit - selectedPrimary.length
        );

        return [...selectedPrimary, ...selectedRelated]
            .slice(0, outputLimit)
            .map(result => this.stripGroupedSearchResultSortFields(result));
    }

    private stripGroupedSearchResultSortFields(result: GroupedSearchResult): SemanticSearchResult {
        const {
            originalOrder: _originalOrder,
            roleSortPriority: _roleSortPriority,
            ownerSignalPriority: _ownerSignalPriority,
            structureScore: _structureScore,
            ...strippedResult
        } = result;
        return strippedResult;
    }

    private getRelatedResultReserve(outputLimit: number, primaryCount: number, relatedCount: number): number {
        if (outputLimit <= 1 || relatedCount === 0) {
            return 0;
        }

        if (primaryCount < outputLimit) {
            return Math.min(relatedCount, outputLimit - primaryCount);
        }

        return Math.min(
            relatedCount,
            Math.max(1, Math.floor(outputLimit * 0.2)),
            outputLimit - 1
        );
    }

    private selectRelatedSearchResults(relatedResults: GroupedSearchResult[], limit: number): GroupedSearchResult[] {
        if (limit <= 0) {
            return [];
        }

        const selected: GroupedSearchResult[] = [];
        const selectedOrders = new Set<number>();
        const preferredGroups: SearchResultGroup[] = ['entry_exports', 'related_tests', 'docs_config', 'other'];

        for (const group of preferredGroups) {
            const result = relatedResults.find(candidate => candidate.resultGroup === group && !selectedOrders.has(candidate.originalOrder));
            if (!result) {
                continue;
            }
            selected.push(result);
            selectedOrders.add(result.originalOrder);
            if (selected.length >= limit) {
                return selected;
            }
        }

        for (const result of relatedResults) {
            if (selectedOrders.has(result.originalOrder)) {
                continue;
            }
            selected.push(result);
            selectedOrders.add(result.originalOrder);
            if (selected.length >= limit) {
                break;
            }
        }

        return selected;
    }

    private resolveResultFileRole(result: SemanticSearchResult): FileRole {
        if (typeof result.fileRole === 'string' && this.isFileRole(result.fileRole)) {
            return result.fileRole;
        }

        return classifyFileRole(result.relativePath);
    }

    private getSearchResultGroup(fileRole: FileRole): SearchResultGroup {
        switch (fileRole) {
            case 'implementation':
                return 'implementation';
            case 'barrel':
            case 'entrypoint':
                return 'entry_exports';
            case 'test':
                return 'related_tests';
            case 'docs':
            case 'config':
            case 'style':
            case 'generated':
                return 'docs_config';
        }
    }

    private isPrimarySearchResult(
        fileRole: FileRole,
        targetRole: SearchTargetRole,
        roleIntent: FileRoleIntent,
        relativePath: string,
        query: string
    ): boolean {
        switch (targetRole) {
            case 'implementation':
                return fileRole === 'implementation'
                    || isFileRoleExplicitlyRequested(fileRole, roleIntent, relativePath)
                    || this.hasExplicitPathLiteralMatch(relativePath, query);
            case 'test':
                return fileRole === 'test';
            case 'docs':
                return fileRole === 'docs';
            case 'config':
                return fileRole === 'config';
            case 'all':
                return true;
        }
    }

    private hasExplicitPathLiteralMatch(relativePath: string, query: string): boolean {
        const normalizedPath = relativePath.replace(/\\/g, '/').toLowerCase();
        const filename = path.basename(normalizedPath);
        const basename = path.basename(filename, path.extname(filename));
        const extension = path.extname(filename);
        const queryTerms = query
            .split(/[^A-Za-z0-9_./\\-]+/)
            .map(term => term.trim().toLowerCase())
            .filter(term => term.length >= 3);

        return queryTerms.some(term => {
            if (term.includes('/') || term.includes('\\')) {
                return normalizedPath.includes(term.replace(/\\/g, '/'));
            }

            if (term.startsWith('.')) {
                return extension === term;
            }

            if (term.includes('.')) {
                return filename === term || normalizedPath.endsWith(`/${term}`);
            }

            return filename === term || basename === term;
        });
    }

    private getSearchResultGroupPriority(group: SearchResultGroup | undefined): number {
        switch (group) {
            case 'implementation':
                return 0;
            case 'entry_exports':
                return 1;
            case 'related_tests':
                return 2;
            case 'docs_config':
                return 3;
            case 'other':
            default:
                return 4;
        }
    }

    private getSearchResultRoleSortPriority(
        fileRole: FileRole,
        group: SearchResultGroup,
        targetRole: SearchTargetRole,
        roleIntent: FileRoleIntent,
        relativePath: string,
        query: string
    ): number {
        if (targetRole !== 'implementation') {
            return this.isPrimarySearchResult(fileRole, targetRole, roleIntent, relativePath, query)
                ? 0
                : this.getSearchResultGroupPriority(group) + 1;
        }

        if (fileRole !== 'implementation' && (
            isFileRoleExplicitlyRequested(fileRole, roleIntent, relativePath)
            || this.hasExplicitPathLiteralMatch(relativePath, query)
        )) {
            return 0;
        }

        return this.getSearchResultGroupPriority(group) + 1;
    }

    private getOwnerSignalPriority(result: SemanticSearchResult, query: string): number {
        const reasons = result.scoreReasons ?? (result.scoreReason ? [result.scoreReason] : []);
        if (reasons.includes('exact_filename') || reasons.includes('exact_symbol_definition')) {
            return 0;
        }

        if (reasons.includes('path_match') || this.hasLiteralAnchorMatch(result, query)) {
            return 1;
        }

        return 2;
    }

    private hasLiteralAnchorMatch(result: SemanticSearchResult, query: string): boolean {
        const literalAnchors = this.extractLexicalSearchTerms(query).literalAnchors;
        if (literalAnchors.length === 0) {
            return false;
        }

        const lowerPath = result.relativePath.toLowerCase();
        const lowerContent = result.content.toLowerCase();
        return literalAnchors.some(anchor => {
            const lowerAnchor = anchor.toLowerCase();
            return lowerPath.includes(lowerAnchor) || lowerContent.includes(lowerAnchor);
        });
    }

    private getSearchResultStructureScore(
        result: SemanticSearchResult,
        terms: StructuralSearchTerms,
        targetRole: SearchTargetRole
    ): number {
        const pathTokens = this.getStructuralTokens(result.relativePath);
        const filename = path.basename(result.relativePath);
        const basename = path.basename(filename, path.extname(filename));
        const lowerFilename = filename.toLowerCase();
        const lowerBasename = basename.toLowerCase();
        const basenameTokens = this.getStructuralTokens(basename);
        const lowerContent = result.content.toLowerCase();
        const uniqueVariants = [...new Set(terms.variants)];

        let score = this.getChunkRoleStructureScore(result.chunkRole, targetRole);
        let basenameTermMatches = 0;

        for (const term of uniqueVariants) {
            if (lowerBasename === term || lowerFilename === term) {
                basenameTermMatches++;
                continue;
            }

            if (basenameTokens.has(term)) {
                basenameTermMatches++;
            }
        }

        const hasSpecificOwnerMatch = basenameTermMatches >= 2;
        if (hasSpecificOwnerMatch) {
            score += basenameTermMatches * 45;
        }

        const matchedPathTerms = uniqueVariants.filter(term => pathTokens.has(term)).length;
        const matchedContentTerms = uniqueVariants.filter(term => lowerContent.includes(term)).length;
        if (hasSpecificOwnerMatch) {
            score += Math.min(matchedPathTerms * 8, 40);
            score += Math.min(matchedContentTerms * 4, 48);
        }

        if (hasSpecificOwnerMatch && this.startsWithDefinitionLike(result.content)) {
            score += targetRole === 'test' ? 20 : 60;
        }

        const reasons = result.scoreReasons ?? (result.scoreReason ? [result.scoreReason] : []);
        if (reasons.includes('reference_match') && !reasons.includes('exact_filename') && !reasons.includes('exact_symbol_definition')) {
            score -= 20;
        }

        return score;
    }

    private getChunkRoleStructureScore(chunkRole: string | undefined, targetRole: SearchTargetRole): number {
        switch (chunkRole) {
            case 'definition':
                return targetRole === 'test' ? 40 : 140;
            case 'method_body':
                return targetRole === 'test' ? 30 : 120;
            case 'test_case':
                return targetRole === 'test' ? 160 : -80;
            case 'assertion':
                return targetRole === 'test' ? 90 : -60;
            case 're_export':
                return targetRole === 'implementation' ? -140 : -20;
            case 'module_decl':
                return targetRole === 'implementation' ? -60 : 0;
            case 'reference':
                return 0;
            default:
                return 0;
        }
    }

    private extractStructuralSearchTerms(query: string): StructuralSearchTerms {
        const terms = query
            .split(/[^A-Za-z0-9_./-]+/)
            .flatMap(term => this.splitStructuralToken(term))
            .map(term => term.toLowerCase())
            .filter(term => term.length >= 3 && !this.isStructuralStopword(term));
        const uniqueTerms = [...new Set(terms)].slice(0, 24);
        const variants = [...new Set(uniqueTerms.flatMap(term => this.getStructuralTermVariants(term)))];

        return {
            terms: uniqueTerms,
            variants
        };
    }

    private getStructuralTokens(value: string): Set<string> {
        const tokens = value
            .split(/[^A-Za-z0-9_]+/)
            .flatMap(term => this.splitStructuralToken(term))
            .map(term => term.toLowerCase())
            .filter(term => term.length >= 2)
            .flatMap(term => this.getStructuralTermVariants(term));

        return new Set(tokens);
    }

    private splitStructuralToken(value: string): string[] {
        return value
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .split(/[^A-Za-z0-9]+/)
            .map(term => term.trim())
            .filter(term => term.length > 0);
    }

    private getStructuralTermVariants(term: string): string[] {
        const variants = new Set<string>([term]);
        if (term.endsWith('ies') && term.length > 4) {
            variants.add(`${term.slice(0, -3)}y`);
        }
        if (term.endsWith('es') && term.length > 4) {
            variants.add(term.slice(0, -2));
        }
        if (term.endsWith('s') && term.length > 3) {
            variants.add(term.slice(0, -1));
        }

        return [...variants];
    }

    private isStructuralStopword(term: string): boolean {
        return [
            'and',
            'the',
            'that',
            'this',
            'with',
            'from',
            'into',
            'onto',
            'used',
            'uses',
            'use',
            'reads',
            'read',
            'shows',
            'show',
            'handles',
            'handle',
            'through',
            'between',
            'over',
            'under',
            'player',
            'players',
        ].includes(term);
    }

    private startsWithDefinitionLike(content: string): boolean {
        const firstMeaningfulLine = content
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map(line => line.trim())
            .find(line => line.length > 0 && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'));

        if (!firstMeaningfulLine) {
            return false;
        }

        return /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|function|type|enum|const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\b/.test(firstMeaningfulLine)
            || /^(?:async\s+)?def\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(firstMeaningfulLine)
            || /^func\s+(?:\([^)]+\)\s*)?[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(firstMeaningfulLine)
            || /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(firstMeaningfulLine)
            || /^(?:public|private|protected|internal|static|final|abstract|override|virtual|async|sealed|synchronized|\s)*(?:[A-Za-z_$][A-Za-z0-9_$<>\[\],.?]*\s+)+[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(firstMeaningfulLine);
    }

    private async addLexicalSearchResults(
        collectionName: string,
        query: string,
        candidateLimit: number,
        outputLimit: number,
        filterExpr: string | undefined,
        vectorResults: SemanticSearchResult[],
        options: NormalizedSemanticSearchOptions
    ): Promise<SemanticSearchResult[]> {
        const terms = this.extractLexicalSearchTerms(query);
        if (terms.recallTerms.length === 0) {
            return vectorResults;
        }

        const roleIntent = this.getSearchFileRoleIntent(query, filterExpr, options.targetRole);
        let exactRows: QueryRow[] = [];
        let broadRows: QueryRow[] = [];
        let exactCandidates: RankedLexicalCandidate[] = [];
        try {
            const lexicalLimits = this.getLexicalCandidateLimits(candidateLimit);
            const exactFilter = options.filenameLikeQuery
                ? this.buildFilenameLikeExactCandidateFilter(options.filenameLikeQuery, filterExpr)
                : this.buildExactCandidateFilter(terms, filterExpr);
            exactRows = await this.vectorDatabase.query(
                collectionName,
                exactFilter,
                [...DEFAULT_SEARCH_OUTPUT_FIELDS],
                lexicalLimits.exact
            );
            exactCandidates = this.rankLexicalRows(exactRows, terms, roleIntent);
            if (!options.filenameLikeQuery && this.shouldQueryBroadLexicalCandidates(exactCandidates, outputLimit, lexicalLimits.exact)) {
                const lexicalFilter = this.buildLexicalFilter(terms, filterExpr);
                broadRows = await this.vectorDatabase.query(
                    collectionName,
                    lexicalFilter,
                    [...DEFAULT_SEARCH_OUTPUT_FIELDS],
                    lexicalLimits.broad
                );
            }
        } catch (error) {
            if (this.isMissingStructuredFieldError(error) && options.filenameLikeQuery) {
                console.warn(`[Context] Filename-like lexical supplement unavailable for '${collectionName}' because structured filename fields are missing.`);
                return vectorResults;
            }

            throw this.isMissingStructuredFieldError(error)
                ? this.createCollectionSchemaMismatchError(collectionName, 'Milvus rejected one or more structured lexical filter fields.')
                : error;
        }

        if (exactRows.length === 0 && broadRows.length === 0) {
            return vectorResults;
        }

        const rankedByKey = new Map<string, RankedSearchResult>();
        vectorResults.forEach((result, index) => {
            const lexicalScore = this.scoreLexicalMatchWithReasons(result, terms, {}, roleIntent);
            const reasons: SearchScoreReason[] = lexicalScore.reasons.length > 0 ? lexicalScore.reasons : ['semantic_match'];
            rankedByKey.set(this.getSearchResultKey(result), {
                ...result,
                vectorScore: result.score,
                lexicalScore: lexicalScore.score,
                ownerTier: lexicalScore.ownerTier,
                scoreReason: this.getPrimaryScoreReason(reasons),
                scoreReasons: reasons,
                originalRank: index
            });
        });

        const lexicalCandidates = [
            ...exactCandidates,
            ...this.rankLexicalRows(this.excludeExistingQueryRows(broadRows, exactRows), terms, roleIntent)
        ];

        for (const candidate of lexicalCandidates) {
            const { result, metadata, lexicalScore } = candidate;
            const key = this.getSearchResultKey(result);
            const existing = rankedByKey.get(key);
            const reasons: SearchScoreReason[] = lexicalScore.reasons.length > 0 ? lexicalScore.reasons : ['semantic_match'];

            if (existing) {
                existing.lexicalScore = Math.max(existing.lexicalScore, lexicalScore.score);
                existing.ownerTier = Math.max(existing.ownerTier, lexicalScore.ownerTier);
                existing.score = Math.max(existing.score, result.score);
                existing.scoreReasons = this.mergeScoreReasons(existing.scoreReasons ?? [], reasons);
                existing.scoreReason = this.getPrimaryScoreReason(existing.scoreReasons);
                existing.lexicalMetadata = metadata;
            } else {
                rankedByKey.set(key, {
                    ...result,
                    vectorScore: 0,
                    lexicalScore: lexicalScore.score,
                    ownerTier: lexicalScore.ownerTier,
                    scoreReason: this.getPrimaryScoreReason(reasons),
                    scoreReasons: reasons,
                    lexicalMetadata: metadata,
                    originalRank: vectorResults.length + rankedByKey.size
                });
            }
        }

        return [...rankedByKey.values()]
            .sort((a, b) => {
                const ownerTierDelta = b.ownerTier - a.ownerTier;
                if (ownerTierDelta !== 0) return ownerTierDelta;

                const lexicalDelta = b.lexicalScore - a.lexicalScore;
                if (lexicalDelta !== 0) return lexicalDelta;

                const vectorDelta = b.vectorScore - a.vectorScore;
                if (vectorDelta !== 0) return vectorDelta;

                return a.originalRank - b.originalRank;
            })
            .map(({
                vectorScore: _vectorScore,
                lexicalScore: _lexicalScore,
                ownerTier: _ownerTier,
                originalRank: _originalRank,
                lexicalMetadata: _lexicalMetadata,
                ...result
            }) => result);
    }

    private buildFilenameLikeExactCandidateFilter(query: SemanticSearchFilenameLikeQuery, filterExpr?: string): string {
        const filenameFilter = query.isPathLike
            ? `relativePath == "${this.escapeFilterString(query.normalizedPath)}"`
            : this.buildBasenameExactFilter(query.basename);
        if (filterExpr && filterExpr.trim().length > 0) {
            return `(${filterExpr}) and (${filenameFilter})`;
        }

        return `(${filenameFilter})`;
    }

    private buildBasenameExactFilter(fileName: string): string {
        const extension = path.posix.extname(fileName);
        const basename = path.posix.basename(fileName, extension);
        return `basename == "${this.escapeFilterString(basename)}" and fileExtension == "${this.escapeFilterString(extension)}"`;
    }

    private getLexicalCandidateLimits(topK: number): { exact: number; broad: number } {
        const normalizedTopK = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 5;

        return {
            exact: Math.min(
                Math.max(normalizedTopK * 20, LEXICAL_EXACT_CANDIDATE_LIMIT_MIN),
                LEXICAL_EXACT_CANDIDATE_LIMIT_MAX
            ),
            broad: Math.min(
                Math.max(normalizedTopK * 8, LEXICAL_BROAD_CANDIDATE_LIMIT_MIN),
                LEXICAL_BROAD_CANDIDATE_LIMIT_MAX
            )
        };
    }

    private shouldQueryBroadLexicalCandidates(exactCandidates: RankedLexicalCandidate[], topK: number, exactLimit: number): boolean {
        const normalizedTopK = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 5;
        const exactEnoughThreshold = Math.min(normalizedTopK, exactLimit);
        const effectiveExactCandidates = exactCandidates.filter(candidate =>
            candidate.lexicalScore.ownerTier >= LEXICAL_OWNER_TIERS.exactDefinition
        );
        return effectiveExactCandidates.length < exactEnoughThreshold;
    }

    private extractLexicalSearchTerms(query: string): LexicalSearchTerms {
        const rawTerms = query
            .split(/[^A-Za-z0-9_./:-]+/)
            .map(term => term.trim())
            .filter(term => term.length >= 3 && term.length <= 120);

        const strongAnchors = new Set<string>();
        const weakDescriptors = new Set<string>();
        const roleHints = new Set<string>();
        const pathHints = new Set<string>();
        const literalAnchors = new Set<string>();
        for (const term of rawTerms) {
            if (!/^[A-Za-z0-9_./:-]+$/.test(term)) {
                continue;
            }

            const isHttpPath = /^\/[A-Za-z0-9_./:-]+$/.test(term) && term.includes('/');
            const isPathLike = /[./-]/.test(term);
            const isIdentifierLike = /[A-Z]/.test(term) && /[a-z]/.test(term);
            const isSnakeCase = /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*$/.test(term) && term.length >= 6;
            const isEnvVar = /^[A-Z][A-Z0-9_]{2,}$/.test(term) && term.includes('_');
            const isDottedOrColonApi = /^[A-Za-z_][A-Za-z0-9_-]*(?:[.:][A-Za-z_][A-Za-z0-9_-]*)+$/.test(term);
            const isLongSpecificToken = term.length >= 12 && !/^[a-z]+$/.test(term);
            const isRoleHint = this.isFileRoleHintToken(term);
            if (this.isQueryAnchorStopword(term)) {
                weakDescriptors.add(term);
                continue;
            }
            if (isHttpPath || isDottedOrColonApi || isEnvVar) {
                literalAnchors.add(term);
                if (isHttpPath || isPathLike) {
                    pathHints.add(term);
                }
            }

            if (isPathLike) {
                pathHints.add(term);
                const basename = isHttpPath ? '' : path.basename(term, path.extname(term));
                if (basename && basename !== term && basename.length >= 3) {
                    pathHints.add(basename);
                }
            } else if (isIdentifierLike || isSnakeCase || isEnvVar || isDottedOrColonApi || isLongSpecificToken) {
                strongAnchors.add(term);
            } else if (isRoleHint) {
                roleHints.add(term);
            } else if (/^[a-z][a-z0-9_-]*$/i.test(term)) {
                weakDescriptors.add(term);
            }
        }

        const primaryTerms = [...new Set([
            ...strongAnchors,
            ...pathHints,
            ...literalAnchors,
        ])].slice(0, 8);
        const fallbackRecallTerms = primaryTerms.length > 0
            ? primaryTerms
            : [...roleHints].slice(0, 8);

        return {
            strongAnchors: [...strongAnchors].slice(0, 8),
            weakDescriptors: [...weakDescriptors].slice(0, 8),
            roleHints: [...roleHints].slice(0, 8),
            pathHints: [...pathHints].slice(0, 8),
            literalAnchors: [...literalAnchors].slice(0, 8),
            recallTerms: fallbackRecallTerms,
            scoringTerms: [...new Set([
                ...strongAnchors,
                ...pathHints,
                ...roleHints,
                ...literalAnchors,
            ])].slice(0, 12)
        };
    }

    private buildLexicalFilter(terms: LexicalSearchTerms, filterExpr?: string): string {
        const termFilters = terms.recallTerms
            .map(term => this.escapeFilterString(term))
            .flatMap(term => [
                `relativePath like "%${term}%"`,
                `content like "%${term}%"`,
                `primarySymbol like "%${term}%"`,
                `basename like "%${term}%"`,
                `pathSegment0 like "%${term}%"`,
                `pathSegment1 like "%${term}%"`,
                `pathSegment2 like "%${term}%"`,
                `pathSegment3 like "%${term}%"`,
                `pathSegment4 like "%${term}%"`
            ]);

        const lexicalFilter = `(${termFilters.join(' or ')})`;
        if (filterExpr && filterExpr.trim().length > 0) {
            return `(${filterExpr}) and ${lexicalFilter}`;
        }

        return lexicalFilter;
    }

    private buildExactCandidateFilter(terms: LexicalSearchTerms, filterExpr?: string): string {
        const termFilters = terms.recallTerms
            .map(term => this.escapeFilterString(term))
            .flatMap(term => {
                const filters = [
                    `relativePath like "%${term}%"`,
                    `content like "%${term}%"`,
                    `basename == "${term}"`,
                    `primarySymbol == "${term}"`,
                    `primarySymbol like "%${term}%"`,
                    `pathSegment0 == "${term}"`,
                    `pathSegment1 == "${term}"`,
                    `pathSegment2 == "${term}"`,
                    `pathSegment3 == "${term}"`,
                    `pathSegment4 == "${term}"`
                ];

                if (this.isIdentifierTerm(term)) {
                    filters.push(
                        `(isDefinition == true and primarySymbol == "${term}")`,
                        `content like "%class ${term}%"`,
                        `content like "%interface ${term}%"`,
                        `content like "%function ${term}%"`,
                        `content like "%def ${term}%"`,
                        `content like "%func ${term}%"`,
                        `content like "%fn ${term}%"`,
                        `content like "%struct ${term}%"`,
                        `content like "%const ${term}%"`,
                        `content like "%type ${term}%"`,
                        `content like "%enum ${term}%"`
                    );
                }

                return filters;
            });

        const exactFilter = `(${termFilters.join(' or ')})`;
        if (filterExpr && filterExpr.trim().length > 0) {
            return `(${filterExpr}) and ${exactFilter}`;
        }

        return exactFilter;
    }

    private isMissingStructuredFieldError(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error);
        const lowerMessage = message.toLowerCase();
        const lexicalFilterFields = [
            ...STRUCTURED_METADATA_FIELDS,
            'fileExtension',
            'relativePath',
        ];
        return lexicalFilterFields.some(field => lowerMessage.includes(field.toLowerCase()))
            && /field|schema|output|not.*exist|not.*found|cannot.*find|undefined/i.test(message);
    }

    private isIdentifierTerm(term: string): boolean {
        return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(term);
    }

    private isFileRoleHintToken(term: string): boolean {
        return /^(?:__tests__|tests?|specs?|e2e|readme|docs?|documentation|markdown|mdx?|css|scss|sass|less|stylus?|styles?|stylesheet|generated|dist|build|bundle|minified|min)$/i.test(term);
    }

    private isQueryAnchorStopword(term: string): boolean {
        return /^(?:where|when|what|which|who|whom|whose|why|how|does|this|that|these|those|with|from|into|onto|between|including|implemented|handles?|uses?|reads?|writes?|shows?|find)$/i.test(term);
    }

    private vectorSearchResultToSemanticSearchResult(document: VectorDocument, score: number): SemanticSearchResult {
        const lineRange = normalizeLineRange({
            startLine: document.startLine,
            endLine: document.endLine,
            metadata: document.metadata,
            content: document.content
        });

        const metadataRole = typeof document.metadata.fileRole === 'string' ? document.metadata.fileRole : '';
        const fileRole = this.isFileRole(document.fileRole || '')
            ? document.fileRole
            : this.isFileRole(metadataRole)
                ? metadataRole
                : classifyFileRole(document.relativePath, document.fileExtension);

        return {
            content: document.content,
            relativePath: document.relativePath,
            ...lineRange,
            language: document.metadata.language || 'unknown',
            score,
            scoreReason: 'semantic_match',
            scoreReasons: ['semantic_match'],
            chunkRole: typeof document.metadata.chunkRole === 'string' ? document.metadata.chunkRole : undefined,
            fileRole
        };
    }

    private rankLexicalRows(rows: QueryRow[], terms: LexicalSearchTerms, roleIntent: FileRoleIntent): RankedLexicalCandidate[] {
        return rows
            .map(row => {
                const metadata = this.getRowMetadata(row);
                const result = this.rowToSemanticSearchResult(row, terms, metadata, roleIntent);
                const lexicalScore = this.scoreLexicalMatchWithReasons(result, terms, metadata, roleIntent);
                const reasons: SearchScoreReason[] = lexicalScore.reasons.length > 0 ? lexicalScore.reasons : ['semantic_match'];
                result.score = lexicalScore.score;
                result.scoreReason = this.getPrimaryScoreReason(reasons);
                result.scoreReasons = reasons;

                return { result, metadata, lexicalScore };
            })
            .sort((a, b) => {
                const ownerTierDelta = b.lexicalScore.ownerTier - a.lexicalScore.ownerTier;
                if (ownerTierDelta !== 0) return ownerTierDelta;

                const scoreDelta = b.lexicalScore.score - a.lexicalScore.score;
                if (scoreDelta !== 0) return scoreDelta;

                const pathDelta = a.result.relativePath.localeCompare(b.result.relativePath);
                if (pathDelta !== 0) return pathDelta;

                return a.result.startLine - b.result.startLine;
            });
    }

    private excludeExistingQueryRows(rows: QueryRow[], existingRows: QueryRow[]): QueryRow[] {
        const existingKeys = new Set(existingRows.map(row => this.getQueryRowKey(row)));
        return rows.filter(row => !existingKeys.has(this.getQueryRowKey(row)));
    }

    private getQueryRowKey(row: QueryRow): string {
        return [
            typeof row.relativePath === 'string' ? row.relativePath : '',
            String(row.startLine ?? ''),
            String(row.endLine ?? ''),
            typeof row.id === 'string' ? row.id : ''
        ].join(':');
    }

    private mergeScoreReasons(existingReasons: SearchScoreReason[], newReasons: SearchScoreReason[]): SearchScoreReason[] {
        const merged = new Set<SearchScoreReason>([...existingReasons, ...newReasons]);
        return [...merged].sort((a, b) => this.getScoreReasonPriority(b) - this.getScoreReasonPriority(a));
    }

    private getPrimaryScoreReason(reasons: SearchScoreReason[]): SearchScoreReason {
        return this.mergeScoreReasons(reasons, [])[0] ?? 'semantic_match';
    }

    private getScoreReasonPriority(reason: SearchScoreReason): number {
        switch (reason) {
            case 'exact_filename':
                return 300;
            case 'exact_symbol_definition':
                return 300;
            case 'path_match':
                return 200;
            case 'reference_match':
                return 100;
            case 'semantic_match':
                return 0;
        }
    }

    private escapeFilterString(value: string): string {
        return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    private getRowMetadata(row: QueryRow): QueryRow {
        const structuredMetadata = this.getStructuredMetadataFromRow(row);
        if (typeof row.metadata === 'string') {
            try {
                const parsed = JSON.parse(row.metadata) as unknown;
                return this.isQueryRow(parsed) ? { ...parsed, ...structuredMetadata } : structuredMetadata;
            } catch {
                return structuredMetadata;
            }
        } else if (this.isQueryRow(row.metadata)) {
            return { ...row.metadata, ...structuredMetadata };
        }

        return structuredMetadata;
    }

    private getStructuredMetadataFromRow(row: QueryRow): QueryRow {
        const metadata: QueryRow = {};
        for (const field of STRUCTURED_METADATA_FIELDS) {
            const value = row[field];
            if (typeof value === 'string' || typeof value === 'boolean') {
                metadata[field] = value;
            }
        }
        return metadata;
    }

    private rowToSemanticSearchResult(
        row: QueryRow,
        terms: LexicalSearchTerms,
        metadata: QueryRow = this.getRowMetadata(row),
        roleIntent: FileRoleIntent = inferFileRoleIntent(terms.scoringTerms.join(' '))
    ): SemanticSearchResult {
        const content = typeof row.content === 'string' ? row.content : '';
        const lineRange = normalizeLineRange({
            startLine: row.startLine,
            endLine: row.endLine,
            metadata,
            content
        });
        const result: SemanticSearchResult = {
            content,
            relativePath: typeof row.relativePath === 'string' ? row.relativePath : '',
            ...lineRange,
            language: typeof metadata.language === 'string' ? metadata.language : this.getLanguageFromExtension(String(row.fileExtension || '')),
            score: 0,
            chunkRole: this.getMetadataString(metadata, 'chunkRole') || undefined,
            fileRole: this.getRowFileRole(row, metadata)
        };
        const lexicalScore = this.scoreLexicalMatchWithReasons(result, terms, metadata, roleIntent);
        const reasons: SearchScoreReason[] = lexicalScore.reasons.length > 0 ? lexicalScore.reasons : ['semantic_match'];
        result.score = lexicalScore.score;
        result.scoreReason = this.getPrimaryScoreReason(reasons);
        result.scoreReasons = reasons;
        return result;
    }

    private getRowFileRole(row: QueryRow, metadata: QueryRow): FileRole {
        const metadataRole = this.getMetadataString(metadata, 'fileRole');
        if (this.isFileRole(metadataRole)) {
            return metadataRole;
        }

        return classifyFileRole(
            typeof row.relativePath === 'string' ? row.relativePath : '',
            typeof row.fileExtension === 'string' ? row.fileExtension : undefined
        );
    }

    private isQueryRow(value: unknown): value is QueryRow {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private scoreLexicalMatch(
        result: SemanticSearchResult,
        terms: LexicalSearchTerms,
        metadata: QueryRow = {},
        roleIntent: FileRoleIntent = inferFileRoleIntent(terms.scoringTerms.join(' '))
    ): number {
        return this.scoreLexicalMatchWithReasons(result, terms, metadata, roleIntent).score;
    }

    private scoreLexicalMatchWithReasons(
        result: SemanticSearchResult,
        terms: LexicalSearchTerms,
        metadata: QueryRow = {},
        roleIntent: FileRoleIntent = inferFileRoleIntent(terms.scoringTerms.join(' '))
    ): LexicalMatchScore {
        const relativePath = result.relativePath;
        const filename = path.basename(relativePath);
        const basename = path.basename(relativePath, path.extname(relativePath));
        const lowerPath = relativePath.toLowerCase();
        const lowerFilename = filename.toLowerCase();
        const lowerBasename = basename.toLowerCase();
        const content = result.content;
        const lowerContent = content.toLowerCase();
        const metadataFileName = this.getMetadataString(metadata, 'fileName');
        const metadataBasename = this.getMetadataString(metadata, 'basename');
        const symbols = this.getMetadataStringArray(metadata, 'symbols');
        const definitionIdentifiers = this.getMetadataStringArray(metadata, 'definitionIdentifiers');
        const pathTokens = this.getMetadataStringArray(metadata, 'pathTokens');

        let score = 0;
        let ownerTier: number = LEXICAL_OWNER_TIERS.semantic;
        const reasons = new Set<SearchScoreReason>();
        const promoteOwnerTier = (tier: number) => {
            ownerTier = Math.max(ownerTier, tier);
        };

        for (const term of terms.scoringTerms) {
            const lowerTerm = term.toLowerCase();

            if (filename === term || lowerFilename === lowerTerm || metadataFileName.toLowerCase() === lowerTerm) {
                score += 500;
                reasons.add('exact_filename');
                promoteOwnerTier(LEXICAL_OWNER_TIERS.exactFilename);
            } else if (basename === term || lowerBasename === lowerTerm || metadataBasename.toLowerCase() === lowerTerm) {
                score += 420;
                reasons.add('exact_filename');
                promoteOwnerTier(LEXICAL_OWNER_TIERS.exactFilename);
            } else if (relativePath.includes(term)) {
                score += 90;
                reasons.add('path_match');
                promoteOwnerTier(LEXICAL_OWNER_TIERS.pathOwner);
            } else if (lowerPath.includes(lowerTerm)) {
                score += 70;
                reasons.add('path_match');
                promoteOwnerTier(LEXICAL_OWNER_TIERS.pathOwner);
            }

            if (definitionIdentifiers.some(symbol => symbol === term || symbol.toLowerCase() === lowerTerm)) {
                score += 360;
                reasons.add('exact_symbol_definition');
                promoteOwnerTier(LEXICAL_OWNER_TIERS.exactDefinition);
            } else if (this.hasDefinitionMatch(content, term)) {
                score += 320;
                reasons.add('exact_symbol_definition');
                promoteOwnerTier(LEXICAL_OWNER_TIERS.exactDefinition);
            } else if (symbols.some(symbol => symbol === term || symbol.toLowerCase() === lowerTerm)) {
                score += 260;
                reasons.add('reference_match');
                promoteOwnerTier(LEXICAL_OWNER_TIERS.reference);
            }

            if (pathTokens.some(token => token === term || token.toLowerCase() === lowerTerm)) {
                score += 140;
                reasons.add('path_match');
                promoteOwnerTier(LEXICAL_OWNER_TIERS.pathOwner);
            }

            if (content.includes(term)) {
                score += 100;
                reasons.add('reference_match');
                promoteOwnerTier(LEXICAL_OWNER_TIERS.reference);
            } else if (lowerContent.includes(lowerTerm)) {
                score += 50;
                reasons.add('reference_match');
                promoteOwnerTier(LEXICAL_OWNER_TIERS.reference);
            }
        }

        if (score > 0) {
            score += this.scoreWeakDescriptorMatches(result, metadata, terms.weakDescriptors);
            score += this.scoreFileRoleMatch(result, metadata, roleIntent);
        }

        const scoreReasons = this.mergeScoreReasons([...reasons], []);
        return {
            score,
            reasons: scoreReasons,
            ownerTier
        };
    }

    private scoreWeakDescriptorMatches(result: SemanticSearchResult, metadata: QueryRow, weakDescriptors: string[]): number {
        if (weakDescriptors.length === 0) {
            return 0;
        }

        const haystacks = [
            result.relativePath,
            result.content,
            this.getMetadataString(metadata, 'fileName'),
            this.getMetadataString(metadata, 'basename'),
            ...this.getMetadataStringArray(metadata, 'pathTokens'),
            ...this.getMetadataStringArray(metadata, 'symbols'),
            ...this.getMetadataStringArray(metadata, 'definitionIdentifiers')
        ].map(value => value.toLowerCase());

        let score = 0;
        for (const descriptor of weakDescriptors) {
            const lowerDescriptor = descriptor.toLowerCase();
            if (haystacks.some(value => value.includes(lowerDescriptor))) {
                score += 15;
            }
        }

        return Math.min(score, 45);
    }

    private scoreFileRoleMatch(result: SemanticSearchResult, metadata: QueryRow, roleIntent: FileRoleIntent): number {
        const role = this.getFileRole(result, metadata);
        if (isFileRoleExplicitlyRequested(role, roleIntent, result.relativePath)) {
            return role === 'implementation' && roleIntent.preferredRoles.size > 0 ? 0 : 120;
        }

        switch (role) {
            case 'implementation':
                return 80;
            case 'test':
            case 'style':
                return -80;
            case 'docs':
                return -70;
            case 'config':
                return -40;
            case 'generated':
                return -120;
            case 'barrel':
                return -60;
            case 'entrypoint':
                return 20;
        }
    }

    private getFileRole(result: SemanticSearchResult, metadata: QueryRow): FileRole {
        const metadataRole = this.getMetadataString(metadata, 'fileRole');
        if (this.isFileRole(metadataRole)) {
            return metadataRole;
        }

        return classifyFileRole(result.relativePath);
    }

    private isFileRole(value: string): value is FileRole {
        return value === 'implementation'
            || value === 'test'
            || value === 'docs'
            || value === 'style'
            || value === 'config'
            || value === 'generated'
            || value === 'barrel'
            || value === 'entrypoint';
    }

    private getMetadataString(metadata: QueryRow, key: string): string {
        const value = metadata[key];
        return typeof value === 'string' ? value : '';
    }

    private getMetadataStringArray(metadata: QueryRow, key: string): string[] {
        const value = metadata[key];
        if (!Array.isArray(value)) {
            return [];
        }

        return value.filter((item): item is string => typeof item === 'string');
    }

    private hasDefinitionMatch(content: string, term: string): boolean {
        const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const definitionPatterns = [
            new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:class|interface|function|type|enum|const|let|var)\\s+${escapedTerm}\\b`),
            new RegExp(`\\b(?:async\\s+)?def\\s+${escapedTerm}\\s*\\(`),
            new RegExp(`\\bfunc\\s+(?:\\([^)]+\\)\\s*)?${escapedTerm}\\s*\\(`),
            new RegExp(`\\b(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${escapedTerm}\\s*\\(`),
            new RegExp(`\\b(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|trait|mod)\\s+${escapedTerm}\\b`),
            new RegExp(`\\b(?:public|private|protected|internal|static|final|abstract|override|virtual|async|sealed|synchronized|\\s)+(?:[A-Za-z_$][A-Za-z0-9_$<>\\[\\],.?]*\\s+)+${escapedTerm}\\s*\\(`),
            new RegExp(`^#{1,6}\\s+${escapedTerm}(?:\\s|$)`, 'm'),
        ];
        return definitionPatterns.some(pattern => pattern.test(content));
    }

    private getSearchResultKey(result: SemanticSearchResult): string {
        if (result.lineRangeUnavailable) {
            return `${result.relativePath}:unknown:${crypto.createHash('sha1').update(result.content).digest('hex')}`;
        }

        return `${result.relativePath}:${result.startLine}:${result.endLine}`;
    }

    private async withSearchTimeout<T>(operation: Promise<T>, codebasePath: string, query: string): Promise<T> {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
            timeoutHandle = setTimeout(() => {
                reject(new SearchTimeoutError(
                    `Search timed out after ${this.searchTimeoutMs}ms for query "${query}" in codebase "${codebasePath}". ` +
                    'Set searchTimeoutMs in ~/.hitmux-context-engine/config.conf to increase the timeout.'
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

    private deduplicateResults(results: SemanticSearchResult[]): SemanticSearchResult[] {
        return deduplicateSemanticSearchResults(results);
    }

    /**
     * Check if index exists for codebase
     * @param codebasePath Codebase path to check
     * @returns Whether index exists
     */
    async hasIndex(codebasePath: string): Promise<boolean> {
        const collectionName = this.getCollectionName(codebasePath);
        const hasCollection = await this.vectorDatabase.hasCollection(collectionName);
        if (!hasCollection) {
            return false;
        }

        const rowCount = await this.vectorDatabase.getCollectionRowCount(collectionName);
        return rowCount !== 0;
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
    private async prepareCollection(
        codebasePath: string,
        forceReindex: boolean = false,
        splitter: Splitter = this.codeSplitter,
        options: PrepareCollectionOptions = {}
    ): Promise<PrepareCollectionResult> {
        const isHybrid = this.getIsHybrid();
        const collectionType = isHybrid === true ? 'hybrid vector' : 'vector';
        console.log(`[Context] 🔧 Preparing ${collectionType} collection for codebase: ${codebasePath}${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        const collectionName = this.getCollectionName(codebasePath);

        // Check if collection already exists
        this.throwIfIndexAborted(options.abortSignal);
        const collectionExists = await this.vectorDatabase.hasCollection(collectionName);
        this.throwIfIndexAborted(options.abortSignal);

        if (collectionExists && !forceReindex) {
            const rowCount = await this.vectorDatabase.getCollectionRowCount(collectionName);
            this.throwIfIndexAborted(options.abortSignal);
            if (options.rejectExistingFullIndex) {
                if (rowCount !== 0) {
                    const rowCountDetails = rowCount > 0 ? ` It currently has ${rowCount} searchable row(s).` : '';
                    throw new ExistingCollectionFullIndexError(
                        `Collection '${collectionName}' already exists for '${codebasePath}'.${rowCountDetails} Refusing ordinary full indexing because it would append chunks without removing stale rows. Use incremental indexing to sync changes, or use force=true to rebuild the collection.`
                    );
                }
                console.log(`📋 Collection ${collectionName} already exists but has 0 rows, dropping it before full indexing`);
                this.throwIfIndexAborted(options.abortSignal);
                await this.vectorDatabase.dropCollection(collectionName);
                if (options.createIfMissing === false) {
                    console.log(`[Context] ⏳ Collection ${collectionName} will be recreated after the first embedding batch determines vector dimension`);
                    return {
                        collectionName,
                        collectionExists: true,
                        created: false,
                        creationDeferred: true
                    };
                }
            } else {
                await this.validateExistingCollectionEmbedding(collectionName);
                if (isHybrid === true) {
                    console.log(`📋 Hybrid collection ${collectionName} already exists, ensuring indexes are ready`);
                    await this.vectorDatabase.ensureHybridCollectionReady(collectionName);
                } else {
                    console.log(`📋 Collection ${collectionName} already exists, skipping creation`);
                }
                return {
                    collectionName,
                    collectionExists: true,
                    created: false,
                    creationDeferred: false
                };
            }
        }

        if (collectionExists && forceReindex) {
            console.log(`[Context] 🗑️  Dropping existing collection ${collectionName} for force reindex...`);
            this.throwIfIndexAborted(options.abortSignal);
            await this.vectorDatabase.dropCollection(collectionName);
            console.log(`[Context] ✅ Collection ${collectionName} dropped successfully`);
        }

        if (options.createIfMissing === false) {
            console.log(`[Context] ⏳ Collection ${collectionName} will be created after the first embedding batch determines vector dimension`);
            return {
                collectionName,
                collectionExists: false,
                created: false,
                creationDeferred: true
            };
        }

        const dimension = options.dimension ?? await this.detectEmbeddingDimensionForCollection();
        if (options.dimension === undefined) {
            console.log(`[Context] 📏 Detected dimension: ${dimension} for ${this.embedding.getProvider()}`);
        } else {
            console.log(`[Context] 📏 Using embedding dimension from first batch: ${dimension} for ${this.embedding.getProvider()}`);
        }

        await this.createCollectionWithDimension(codebasePath, splitter, dimension);
        return {
            collectionName,
            collectionExists: false,
            created: true,
            creationDeferred: false
        };
    }

    private throwIfIndexAborted(signal?: AbortSignal, processedFiles: number = 0, totalFiles: number = 0): void {
        if (signal?.aborted) {
            throw new IndexAbortError(`Indexing aborted after processing ${processedFiles}/${totalFiles} files`);
        }
    }

    private async detectEmbeddingDimensionForCollection(): Promise<number> {
        console.log(`[Context] 🔍 Detecting embedding dimension for ${this.embedding.getProvider()} provider...`);
        return this.embedding.detectDimension();
    }

    private async createCollectionWithDimension(
        codebasePath: string,
        splitter: Splitter,
        dimension: number
    ): Promise<void> {
        const isHybrid = this.getIsHybrid();
        const collectionName = this.getCollectionName(codebasePath);
        const description = this.createCollectionDescription(codebasePath, this.getCurrentEmbeddingMetadata(dimension), splitter);
        if (isHybrid === true) {
            await this.vectorDatabase.createHybridCollection(collectionName, dimension, description);
        } else {
            await this.vectorDatabase.createCollection(collectionName, dimension, description);
        }

        console.log(`[Context] ✅ Collection ${collectionName} created successfully (dimension: ${dimension})`);
    }

    private async validateExistingCollectionEmbedding(collectionName: string, currentDimension?: number): Promise<void> {
        let description: string;
        try {
            description = await this.vectorDatabase.getCollectionDescription(collectionName);
        } catch (error) {
            throw this.createCollectionSchemaMismatchError(collectionName, `Unable to read hitmuxContext collection metadata: ${error instanceof Error ? error.message : String(error)}.`);
        }

        const storedMetadata = this.parseCollectionMetadata(description);
        if (!storedMetadata) {
            throw this.createCollectionSchemaMismatchError(collectionName, 'Missing hitmuxContext collection metadata.');
        }

        this.assertCurrentCollectionSchema(collectionName, storedMetadata);

        if (this.isEmbeddingModelCheckSkipped()) {
            console.warn(`[Context] ⚠️ Skipping embedding model compatibility check because ${Context.SKIP_EMBEDDING_MODEL_CHECK_ENV} is set.`);
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
        } else {
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

    }

    private getCurrentEmbeddingMetadata(dimension: number): CollectionEmbeddingMetadata {
        return {
            provider: this.embedding.getProvider(),
            model: this.embedding.getModel(),
            dimension,
        };
    }

    private createCollectionDescription(codebasePath: string, embedding: CollectionEmbeddingMetadata, splitter: Splitter = this.codeSplitter): string {
        const metadata: CollectionMetadata = {
            version: 1,
            codebasePath,
            embedding,
            schemaVersion: Context.COLLECTION_SCHEMA_VERSION,
            metadataVersion: Context.COLLECTION_METADATA_VERSION,
            splitterType: this.getSplitterTypeName(splitter),
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
                schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : undefined,
                metadataVersion: typeof parsed.metadataVersion === 'number' ? parsed.metadataVersion : undefined,
                splitterType: typeof parsed.splitterType === 'string' ? parsed.splitterType : undefined,
                createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
            };
        } catch (error) {
            console.warn(`[Context] ⚠️ Failed to parse collection embedding metadata: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    private assertCurrentCollectionSchema(collectionName: string, metadata: CollectionMetadata): void {
        const schemaVersion = metadata.schemaVersion ?? 1;
        const metadataVersion = metadata.metadataVersion ?? 1;
        const mismatches: string[] = [];

        if (schemaVersion !== Context.COLLECTION_SCHEMA_VERSION) {
            mismatches.push(`schemaVersion indexed=${schemaVersion} current=${Context.COLLECTION_SCHEMA_VERSION}`);
        }
        if (metadataVersion !== Context.COLLECTION_METADATA_VERSION) {
            mismatches.push(`metadataVersion indexed=${metadataVersion} current=${Context.COLLECTION_METADATA_VERSION}`);
        }

        if (mismatches.length === 0) {
            return;
        }

        throw this.createCollectionSchemaMismatchError(collectionName, mismatches.join('; '));
    }

    private createCollectionSchemaMismatchError(collectionName: string, detail: string): CollectionSchemaMismatchError {
        return new CollectionSchemaMismatchError(`Collection '${collectionName}' uses an unsupported search schema. ${detail} Reindex the codebase with force=true to create schema v2 metadata fields.`);
    }

    private getSplitterTypeName(splitter: Splitter): string {
        const constructorName = splitter.constructor?.name;
        if (constructorName === 'AstCodeSplitter') {
            return 'ast';
        }
        if (constructorName === 'LangChainCodeSplitter') {
            return 'langchain';
        }
        return constructorName || 'custom';
    }

    private createIndexingTimingMetrics(): IndexingTimingMetrics {
        return {
            totalIndexingMs: 0,
            prepareCollectionMs: 0,
            loadIgnorePatternsMs: 0,
            scanFilesMs: 0,
            fileWeightStatMs: 0,
            readAndSplitMs: 0,
            embeddingMs: 0,
            vectorInsertMs: 0,
            flushLoadMs: 0,
            verifyMs: 0
        };
    }

    private getMonotonicMs(): number {
        return Number(process.hrtime.bigint()) / 1_000_000;
    }

    private async measureIndexingStage<T>(
        metrics: IndexingTimingMetrics | undefined,
        key: keyof IndexingTimingMetrics,
        action: () => Promise<T>
    ): Promise<T> {
        if (!metrics) {
            return action();
        }

        const startedAt = this.getMonotonicMs();
        try {
            return await action();
        } finally {
            metrics[key] += this.getMonotonicMs() - startedAt;
        }
    }

    private getEmbeddingBatchSize(codebasePath: string): number {
        const configured = configManager.getNumber('embeddingBatchSize', codebasePath);
        if (configured !== undefined) {
            return Math.max(1, Math.floor(configured));
        }

        return this.getDefaultEmbeddingIndexingOptions(codebasePath).batchSize;
    }

    private getEmbeddingConcurrency(codebasePath: string): number {
        const configured = configManager.getNumber('embeddingConcurrency', codebasePath);
        if (configured !== undefined) {
            return Math.max(1, Math.floor(configured));
        }

        return this.getDefaultEmbeddingIndexingOptions(codebasePath).concurrency;
    }

    private getFileProcessingConcurrency(codebasePath: string): number {
        return Math.max(1, Math.floor(configManager.getNumber('fileProcessingConcurrency', codebasePath) || 2));
    }

    private getDefaultEmbeddingIndexingOptions(codebasePath: string): { batchSize: number; concurrency: number } {
        const configuredProvider = configManager.getString('embeddingProvider', codebasePath);
        const configuredModel = configManager.getString('embeddingModel', codebasePath);
        const embeddingProvider = this.embedding.getProvider();
        const embeddingModel = this.embedding.getModel();
        const provider = this.resolveEmbeddingDefaultProvider(configuredProvider, embeddingProvider);
        const model = this.resolveEmbeddingDefaultModel(provider, configuredProvider, configuredModel, embeddingModel);

        return getEmbeddingIndexingDefaults(
            provider,
            model
        );
    }

    private resolveEmbeddingDefaultProvider(configuredProvider: string | undefined, embeddingProvider: string): string | undefined {
        if (configuredProvider === 'OpenRouter' && embeddingProvider === 'OpenAI') {
            return configuredProvider;
        }

        if (embeddingProvider && embeddingProvider !== 'unknown') {
            return embeddingProvider;
        }

        return configuredProvider;
    }

    private resolveEmbeddingDefaultModel(
        provider: string | undefined,
        configuredProvider: string | undefined,
        configuredModel: string | undefined,
        embeddingModel: string
    ): string | undefined {
        if (provider && provider === configuredProvider) {
            return configuredModel || (embeddingModel !== 'unknown' ? embeddingModel : undefined);
        }

        if (embeddingModel && embeddingModel !== 'unknown') {
            return embeddingModel;
        }

        return configuredModel;
    }

    private drainVectorDatabasePerformanceMetrics(metrics?: IndexingTimingMetrics): number {
        const vectorDatabase = this.vectorDatabase as InstrumentedVectorDatabase;
        const snapshot = vectorDatabase.drainPerformanceMetrics?.();
        if (!snapshot) {
            return 0;
        }

        const flushLoadMs = snapshot.flushLoadMs || 0;
        if (metrics) {
            metrics.flushLoadMs += flushLoadMs;
        }
        return flushLoadMs;
    }

    private logIndexingTimingSummary(
        codebasePath: string,
        summary: {
            indexedFiles: number;
            totalChunks: number;
            embeddingBatchSize: number;
            embeddingConcurrency: number;
            fileProcessingConcurrency: number;
        },
        metrics: IndexingTimingMetrics
    ): void {
        const roundedMetrics = Object.fromEntries(
            Object.entries(metrics).map(([key, value]) => [key, Math.round(value)])
        );
        const totalIndexingSeconds = Math.max(metrics.totalIndexingMs / 1000, 0.001);
        console.log('[Context] ⏱️ Indexing timing summary:', {
            codebasePath,
            ...summary,
            ...roundedMetrics,
            filesPerSecond: Number((summary.indexedFiles / totalIndexingSeconds).toFixed(2)),
            chunksPerSecond: Number((summary.totalChunks / totalIndexingSeconds).toFixed(2))
        });
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
        requestMaxDepth?: number,
        discoveryMetrics?: CodeFileDiscoveryMetrics
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
                        if (discoveryMetrics) {
                            const startedAt = this.getMonotonicMs();
                            try {
                                const stat = await fs.promises.stat(fullPath);
                                discoveryMetrics.fileSizes.set(fullPath, stat.size);
                            } catch (error) {
                                console.warn(`[Context] ⚠️  Could not stat file ${fullPath} during file discovery: ${error}`);
                            } finally {
                                discoveryMetrics.fileStatMs += this.getMonotonicMs() - startedAt;
                            }
                        }
                    }
                }
            }
        };

        await traverseDirectory(codebasePath);
        return files;
    }

    private async getFileProcessingWeights(
        filePaths: string[],
        knownFileSizes: Map<string, number> = new Map<string, number>()
    ): Promise<{ weights: Map<string, number>; totalWeight: number }> {
        const weights = new Map<string, number>();
        let totalWeight = 0;

        await Promise.all(filePaths.map(async (filePath) => {
            let weight = 1;
            const knownSize = knownFileSizes.get(filePath);
            if (knownSize !== undefined) {
                weight = Math.max(1, knownSize);
            } else {
                try {
                    const stat = await fs.promises.stat(filePath);
                    weight = Math.max(1, stat.size);
                } catch (error) {
                    console.warn(`[Context] ⚠️  Could not stat file ${filePath} for progress weighting: ${error}`);
                }
            }
            weights.set(filePath, weight);
            totalWeight += weight;
        }));

        return {
            weights,
            totalWeight
        };
    }

    private async createWeightedFileProgressTracker(
        filePaths: string[],
        startPercentage: number,
        endPercentage: number,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        knownFileSizes: Map<string, number> = new Map<string, number>()
    ): Promise<{
        updateFile: (filePath: string, fileProgress: number, phase: string) => void;
        completeFile: (filePath: string, phase: string) => void;
    }> {
        const fileWeights = await this.getFileProcessingWeights(filePaths, knownFileSizes);
        const completedFiles = new Set<string>();
        let completedWeight = 0;
        let lastPercentage = -1;

        const emit = (phase: string, currentWeight: number, force: boolean = false) => {
            const totalWeight = Math.max(fileWeights.totalWeight, 1);
            const safeProgress = Math.max(0, Math.min(1, currentWeight / totalWeight));
            const percentage = Math.max(
                Math.max(startPercentage, lastPercentage),
                Math.min(endPercentage, Math.round(startPercentage + safeProgress * (endPercentage - startPercentage)))
            );
            if (!force && percentage === lastPercentage) {
                return;
            }
            lastPercentage = percentage;
            progressCallback?.({
                phase,
                current: Math.round(currentWeight),
                total: Math.round(totalWeight),
                percentage
            });
        };

        return {
            updateFile: (filePath: string, fileProgress: number, phase: string) => {
                const fileWeight = fileWeights.weights.get(filePath) || 1;
                emit(phase, completedWeight + fileWeight * Math.max(0, Math.min(1, fileProgress)));
            },
            completeFile: (filePath: string, phase: string) => {
                if (!completedFiles.has(filePath)) {
                    completedFiles.add(filePath);
                    completedWeight += fileWeights.weights.get(filePath) || 1;
                }
                emit(phase, completedWeight, true);
            }
        };
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
        signal?: AbortSignal,
        onFileProgress?: (progress: FileProcessingProgress) => void,
        timingMetrics?: IndexingTimingMetrics,
        options: ProcessFileListOptions = {}
    ): Promise<{
        processedFiles: number;
        totalChunks: number;
        status: 'completed' | 'limit_reached';
        embeddingBatchSize: number;
        embeddingConcurrency: number;
        fileProcessingConcurrency: number;
    }> {
        const isHybrid = this.getIsHybrid();
        const EMBEDDING_BATCH_SIZE = this.getEmbeddingBatchSize(codebasePath);
        const EMBEDDING_CONCURRENCY = this.getEmbeddingConcurrency(codebasePath);
        const FILE_PROCESSING_CONCURRENCY = Math.min(filePaths.length || 1, this.getFileProcessingConcurrency(codebasePath));
        const CHUNK_LIMIT = 450000;
        console.log(`[Context] 🔧 Using embeddingBatchSize: ${EMBEDDING_BATCH_SIZE}`);
        console.log(`[Context] 🔧 Using embeddingConcurrency: ${EMBEDDING_CONCURRENCY}`);
        console.log(`[Context] 🔧 Using fileProcessingConcurrency: ${FILE_PROCESSING_CONCURRENCY}`);

        let chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }> = [];
        let processedFiles = 0;
        let totalChunks = 0;
        let limitReached = false;
        let chunkLimitWarningLogged = false;
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
                firstFatalError = firstFatalError ?? result.error;
                throwBatchError(result.error, 'concurrent');
            }
        };

        const markChunkLimitReached = (): void => {
            if (!chunkLimitWarningLogged) {
                console.warn(`[Context] ⚠️  Chunk limit of ${CHUNK_LIMIT} reached. Stopping indexing.`);
                chunkLimitWarningLogged = true;
            }
            limitReached = true;
        };

        const waitForAllBatches = async (): Promise<void> => {
            let batchError: unknown;
            while (activeBatches.size > 0) {
                try {
                    await waitForOneBatch();
                } catch (error) {
                    batchError = batchError ?? error;
                }
            }
            if (batchError !== undefined) {
                throw batchError;
            }
        };

        const drainActiveBatches = async (): Promise<void> => {
            while (activeBatches.size > 0) {
                try {
                    await waitForOneBatch();
                } catch {
                    // Preserve firstFatalError and wait for every in-flight write to settle.
                }
            }
        };

        const enqueueChunkBuffer = async (buffer: Array<{ chunk: CodeChunk; codebasePath: string }>): Promise<void> => {
            const batch = buffer;
            const releaseSlot = await this.acquireIndexingBatchSlot(EMBEDDING_CONCURRENCY);
            const task: Promise<BatchResult> = this.processChunkBuffer(batch, timingMetrics, {
                deferFlushLoad: options.deferVectorFlushLoad === true,
                ensureCollectionBeforeInsert: options.ensureCollectionBeforeInsert
            })
                .then(() => ({ ok: true as const }))
                .catch((error) => ({ ok: false as const, error }))
                .finally(() => {
                    releaseSlot();
                    activeBatches.delete(task);
                });
            activeBatches.add(task);

            if (activeBatches.size >= EMBEDDING_CONCURRENCY) {
                await waitForOneBatch();
            }
        };

        let nextFileIndex = 0;
        let chunkQueue: Promise<void> = Promise.resolve();
        let firstFatalError: unknown;

        const throwIfStopped = (): void => {
            this.throwIfIndexAborted(signal, processedFiles, filePaths.length);
            if (firstFatalError !== undefined) {
                throw firstFatalError;
            }
        };

        const runChunkQueue = async (action: () => Promise<void>): Promise<void> => {
            const previous = chunkQueue;
            let releaseQueue!: () => void;
            chunkQueue = new Promise<void>((resolve) => {
                releaseQueue = resolve;
            });
            await previous;
            try {
                throwIfStopped();
                await action();
            } catch (error) {
                firstFatalError = firstFatalError ?? error;
                throw error;
            } finally {
                releaseQueue();
            }
        };

        const readAndSplitFile = async (filePath: string): Promise<{ content: string; chunks: CodeChunk[] } | undefined> => {
            try {
                const readSplitStartedAt = this.getMonotonicMs();
                try {
                    const knownSize = options.knownFileSizes?.get(filePath);
                    const fileSize = knownSize ?? (await fs.promises.stat(filePath)).size;
                    if (fileSize > MAX_INDEX_FILE_BYTES) {
                        console.warn(`[Context] ⚠️  Skipping file ${filePath}: ${Math.round(fileSize / 1024 / 1024)}MB exceeds the ${Math.round(MAX_INDEX_FILE_BYTES / 1024 / 1024)}MB indexing file size limit`);
                        return undefined;
                    }
                    let content = await fs.promises.readFile(filePath, 'utf-8');
                    const extension = path.extname(filePath);
                    if (extension === '.ipynb') {
                        content = this.extractNotebookSource(content);
                    }
                    const language = this.getLanguageFromExtension(extension);
                    const chunks = this.deduplicateFileChunks(
                        await splitter.split(content, language, filePath),
                        codebasePath,
                        filePath
                    );
                    return { content, chunks };
                } finally {
                    if (timingMetrics) {
                        timingMetrics.readAndSplitMs += this.getMonotonicMs() - readSplitStartedAt;
                    }
                }
            } catch (error) {
                if (error instanceof EmbeddingError || error instanceof IndexAbortError) {
                    throw error;
                }
                console.warn(`[Context] ⚠️  Skipping file ${filePath}: ${error}`);
                return undefined;
            }
        };

        const enqueueFileChunks = async (
            filePath: string,
            originalFileIndex: number,
            content: string,
            chunks: CodeChunk[]
        ): Promise<void> => {
            await runChunkQueue(async () => {
                if (limitReached) {
                    return;
                }

                if (chunks.length > 50) {
                    console.warn(`[Context] ⚠️  File ${filePath} generated ${chunks.length} chunks (${Math.round(content.length / 1024)}KB)`);
                } else if (content.length > 100000) {
                    console.log(`📄 Large file ${filePath}: ${Math.round(content.length / 1024)}KB -> ${chunks.length} chunks`);
                }

                let completedWholeFile = true;
                for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
                    if (totalChunks >= CHUNK_LIMIT) {
                        completedWholeFile = false;
                        markChunkLimitReached();
                        break;
                    }

                    const chunk = chunks[chunkIndex];
                    chunkBuffer.push({ chunk, codebasePath });
                    totalChunks++;

                    if (chunkBuffer.length >= EMBEDDING_BATCH_SIZE) {
                        const batch = chunkBuffer;
                        chunkBuffer = [];
                        await enqueueChunkBuffer(batch);
                    }

                    onFileProgress?.({
                        filePath,
                        fileIndex: originalFileIndex + 1,
                        totalFiles: filePaths.length,
                        processedChunks: chunkIndex + 1,
                        totalChunks: chunks.length,
                        fileProgress: (chunkIndex + 1) / chunks.length
                    });

                    if (totalChunks >= CHUNK_LIMIT) {
                        markChunkLimitReached();
                        if (chunkIndex < chunks.length - 1) {
                            completedWholeFile = false;
                        }
                        break;
                    }
                }

                if (!completedWholeFile) {
                    return;
                }

                processedFiles++;
                if (chunks.length === 0) {
                    onFileProgress?.({
                        filePath,
                        fileIndex: originalFileIndex + 1,
                        totalFiles: filePaths.length,
                        processedChunks: 0,
                        totalChunks: 0,
                        fileProgress: 1
                    });
                }
                onFileProcessed?.(filePath, processedFiles, filePaths.length);
            });
        };

        const processWorker = async (): Promise<void> => {
            while (true) {
                throwIfStopped();
                if (limitReached) {
                    return;
                }
                const fileIndex = nextFileIndex;
                nextFileIndex++;
                if (fileIndex >= filePaths.length) {
                    return;
                }

                const filePath = filePaths[fileIndex];
                const result = await readAndSplitFile(filePath);
                throwIfStopped();
                if (!result) {
                    continue;
                }
                await enqueueFileChunks(filePath, fileIndex, result.content, result.chunks);
            }
        };

        const workers = Array.from({ length: FILE_PROCESSING_CONCURRENCY }, () => processWorker());
        const workerResults = await Promise.allSettled(workers);
        const workerError = workerResults.find((result): result is PromiseRejectedResult => result.status === 'rejected')?.reason;
        if (workerError !== undefined) {
            firstFatalError = firstFatalError ?? workerError;
        }
        if (firstFatalError !== undefined) {
            await drainActiveBatches();
            throw firstFatalError;
        }

        // Process any remaining chunks in the buffer (skip if cancelled).
        if (chunkBuffer.length > 0 && !signal?.aborted) {
            const searchType = isHybrid === true ? 'hybrid' : 'regular';
            console.log(`📝 Processing final batch of ${chunkBuffer.length} chunks for ${searchType}`);
            try {
                await enqueueChunkBuffer(chunkBuffer);
                chunkBuffer = [];
            } catch (error) {
                firstFatalError = firstFatalError ?? error;
                await drainActiveBatches();
                throwBatchError(error, 'final');
            }
        }

        await waitForAllBatches();

        this.throwIfIndexAborted(signal, processedFiles, filePaths.length);

        if (options.deferVectorFlushLoad === true && totalChunks > 0) {
            await this.finalizeVectorCollectionWrites(codebasePath, timingMetrics);
        }

        return {
            processedFiles,
            totalChunks,
            status: limitReached ? 'limit_reached' : 'completed',
            embeddingBatchSize: EMBEDDING_BATCH_SIZE,
            embeddingConcurrency: EMBEDDING_CONCURRENCY,
            fileProcessingConcurrency: FILE_PROCESSING_CONCURRENCY
        };
    }

    private extractNotebookSource(content: string): string {
        const notebook = JSON.parse(content) as unknown;
        if (!notebook || typeof notebook !== 'object' || !Array.isArray((notebook as { cells?: unknown }).cells)) {
            throw new Error('Invalid Jupyter notebook: missing cells array');
        }

        return (notebook as { cells: unknown[] }).cells
            .map((cell) => this.extractNotebookCellSource(cell))
            .filter((source): source is string => source !== undefined)
            .join('\n\n');
    }

    private extractNotebookCellSource(cell: unknown): string | undefined {
        if (!cell || typeof cell !== 'object') {
            return undefined;
        }

        const record = cell as { cell_type?: unknown; source?: unknown };
        if (record.cell_type !== 'markdown' && record.cell_type !== 'code') {
            return undefined;
        }

        if (typeof record.source === 'string') {
            return record.source;
        }
        if (Array.isArray(record.source)) {
            return record.source
                .filter((line): line is string => typeof line === 'string')
                .join('');
        }
        return undefined;
    }

    private deduplicateFileChunks(chunks: CodeChunk[], codebasePath: string, fallbackFilePath: string): CodeChunk[] {
        if (chunks.length <= 1) {
            return chunks;
        }

        const seen = new Set<string>();
        const deduplicated: CodeChunk[] = [];
        for (const chunk of chunks) {
            const chunkFilePath = chunk.metadata.filePath || fallbackFilePath;
            const relativePath = path.relative(codebasePath, chunkFilePath).replace(/\\/g, '/');
            const key = `${relativePath}:${getNormalizedContentHash(chunk.content)}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            deduplicated.push(chunk);
        }
        return deduplicated;
    }

    private async acquireIndexingBatchSlot(maxConcurrency: number): Promise<() => void> {
        while (this.activeIndexingBatchCount >= maxConcurrency) {
            await new Promise<void>((resolve) => {
                this.indexingBatchWaiters.push(resolve);
            });
        }

        this.activeIndexingBatchCount += 1;
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.activeIndexingBatchCount = Math.max(0, this.activeIndexingBatchCount - 1);
            const nextWaiter = this.indexingBatchWaiters.shift();
            nextWaiter?.();
        };
    }

    /**
 * Process accumulated chunk buffer
 */
    private async processChunkBuffer(
        chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }>,
        timingMetrics?: IndexingTimingMetrics,
        insertOptions: ChunkBatchInsertOptions = {}
    ): Promise<void> {
        if (chunkBuffer.length === 0) return;

        // Extract chunks and ensure they all have the same codebasePath
        const chunks = chunkBuffer.map(item => item.chunk);
        const codebasePath = chunkBuffer[0].codebasePath;

        // Estimate tokens (rough estimation: 1 token ≈ 4 characters)
        const estimatedTokens = chunks.reduce((sum, chunk) => sum + Math.ceil(chunk.content.length / 4), 0);

        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid' : 'regular';
        console.log(`[Context] 🔄 Processing batch of ${chunks.length} chunks (~${estimatedTokens} tokens) for ${searchType}`);
        await this.processChunkBatch(chunks, codebasePath, timingMetrics, insertOptions);
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

        if (rowCount > 0 && rowCount < totalChunks) {
            throw new IndexingVerificationError(
                `Indexing produced ${totalChunks} chunks but collection '${collectionName}' has only ${rowCount} searchable row(s)`
            );
        }

        if (rowCount < 0) {
            throw new IndexingVerificationError(
                `Indexing produced ${totalChunks} chunks but collection '${collectionName}' row count could not be verified`
            );
        }
    }

    private async finalizeVectorCollectionWrites(
        codebasePath: string,
        timingMetrics?: IndexingTimingMetrics
    ): Promise<void> {
        const collectionName = this.getCollectionName(codebasePath);
        try {
            await this.vectorDatabase.finalizeCollectionWrites?.(collectionName);
        } finally {
            if (timingMetrics) {
                this.drainVectorDatabasePerformanceMetrics(timingMetrics);
            }
        }
    }

    /**
     * Process a batch of chunks
     */
    private async processChunkBatch(
        chunks: CodeChunk[],
        codebasePath: string,
        timingMetrics?: IndexingTimingMetrics,
        insertOptions: ChunkBatchInsertOptions = {}
    ): Promise<void> {
        const isHybrid = this.getIsHybrid();

        // Generate embedding vectors
        const chunkContents = chunks.map(chunk => chunk.content);

        let embeddings: EmbeddingVector[];
        const embeddingStartedAt = this.getMonotonicMs();
        try {
            embeddings = await this.embedding.embedBatch(chunkContents);
        } catch (error) {
            if (timingMetrics) {
                this.drainVectorDatabasePerformanceMetrics(timingMetrics);
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            // Include batch size in the log/error message so operators can
            // identify how many chunks were lost when the API call failed.
            console.error(`[Context] ❌ Embedding API failed (batch size: ${chunkContents.length}): ${errorMessage}`);
            throw new EmbeddingError(`Embedding API error (batch size: ${chunkContents.length}): ${errorMessage}`);
        } finally {
            if (timingMetrics) {
                timingMetrics.embeddingMs += this.getMonotonicMs() - embeddingStartedAt;
            }
        }
        this.validateEmbeddings(embeddings, chunks.length);
        const { ensureCollectionBeforeInsert, ...vectorInsertOptions } = insertOptions;
        await ensureCollectionBeforeInsert?.(embeddings[0].vector.length);

        if (isHybrid === true) {
            // Create hybrid vector documents
            const documents: VectorDocument[] = chunks.map((chunk, index) => this.createVectorDocument(chunk, embeddings[index], codebasePath, index));

            // Store to vector database
            const insertStartedAt = this.getMonotonicMs();
            try {
                await this.vectorDatabase.insertHybrid(this.getCollectionName(codebasePath), documents, vectorInsertOptions);
            } finally {
                if (timingMetrics) {
                    const elapsedMs = this.getMonotonicMs() - insertStartedAt;
                    const flushLoadMs = this.drainVectorDatabasePerformanceMetrics(timingMetrics);
                    timingMetrics.vectorInsertMs += Math.max(0, elapsedMs - flushLoadMs);
                }
            }
        } else {
            // Create regular vector documents
            const documents: VectorDocument[] = chunks.map((chunk, index) => this.createVectorDocument(chunk, embeddings[index], codebasePath, index));

            // Store to vector database
            const insertStartedAt = this.getMonotonicMs();
            try {
                await this.vectorDatabase.insert(this.getCollectionName(codebasePath), documents, vectorInsertOptions);
            } finally {
                if (timingMetrics) {
                    const elapsedMs = this.getMonotonicMs() - insertStartedAt;
                    const flushLoadMs = this.drainVectorDatabasePerformanceMetrics(timingMetrics);
                    timingMetrics.vectorInsertMs += Math.max(0, elapsedMs - flushLoadMs);
                }
            }
        }
    }

    private createVectorDocument(chunk: CodeChunk, embedding: EmbeddingVector, codebasePath: string, chunkIndex: number): VectorDocument {
        if (!chunk.metadata.filePath) {
            throw new Error(`Missing filePath in chunk metadata at index ${chunkIndex}`);
        }

        const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
        const normalizedRelativePath = relativePath.replace(/\\/g, '/');
        const fileExtension = path.extname(chunk.metadata.filePath);
        const { filePath: _filePath, startLine: _startLine, endLine: _endLine, ...restMetadata } = chunk.metadata;
        const sourceStartLine = chunk.metadata.startLine || 0;
        const sourceEndLine = chunk.metadata.endLine || 0;
        const searchMetadata = this.createSearchMetadata(normalizedRelativePath, chunk.content, restMetadata);
        const structuredFields = this.createStructuredDocumentFields(searchMetadata);

        return {
            id: this.generateId(normalizedRelativePath, sourceStartLine, sourceEndLine, chunk.content),
            vector: embedding.vector,
            content: chunk.content,
            relativePath: normalizedRelativePath,
            startLine: sourceStartLine,
            endLine: sourceEndLine,
            fileExtension,
            ...structuredFields,
            metadata: {
                ...restMetadata,
                ...searchMetadata,
                ...structuredFields,
                codebasePath,
                language: chunk.metadata.language || 'unknown',
                sourceStartLine,
                sourceEndLine,
                chunkIndex
            }
        };
    }

    private createSearchMetadata(relativePath: string, content: string, chunkMetadata: Record<string, unknown>): QueryRow {
        const fileName = path.posix.basename(relativePath);
        const extension = path.posix.extname(fileName);
        const basename = path.posix.basename(fileName, extension);
        const pathTokens = this.extractPathTokens(relativePath);
        const definitionIdentifierSet = new Set<string>(this.extractDefinitionIdentifiers(content));
        const symbols = new Set<string>(definitionIdentifierSet);
        const isDefinition = chunkMetadata.isDefinition === true;
        const symbolName = typeof chunkMetadata.symbolName === 'string' ? chunkMetadata.symbolName : '';

        if (symbolName.length > 0) {
            symbols.add(symbolName);
            if (isDefinition) {
                definitionIdentifierSet.add(symbolName);
            }
        }

        const definitionIdentifiers = [...definitionIdentifierSet];
        const primarySymbol = symbolName || definitionIdentifiers[0] || '';
        const pathSegments = this.extractPathSegments(relativePath);

        return {
            fileName,
            basename,
            pathTokens,
            symbols: [...symbols],
            definitionIdentifiers,
            primarySymbol,
            symbolKind: typeof chunkMetadata.symbolKind === 'string' ? chunkMetadata.symbolKind : '',
            chunkKind: typeof chunkMetadata.chunkKind === 'string' ? chunkMetadata.chunkKind : 'code',
            isDefinition,
            contentHash: crypto.createHash('sha1').update(content).digest('hex'),
            normalizedContentHash: getNormalizedContentHash(content),
            chunkRole: typeof chunkMetadata.chunkRole === 'string' ? chunkMetadata.chunkRole : 'reference',
            fileRole: classifyFileRole(relativePath, extension, content),
            pathSegment0: pathSegments[0] || '',
            pathSegment1: pathSegments[1] || '',
            pathSegment2: pathSegments[2] || '',
            pathSegment3: pathSegments[3] || '',
            pathSegment4: pathSegments[4] || '',
        };
    }

    private createStructuredDocumentFields(metadata: QueryRow): Partial<VectorDocument> {
        return {
            primarySymbol: this.getMetadataString(metadata, 'primarySymbol'),
            symbolKind: this.getMetadataString(metadata, 'symbolKind'),
            chunkKind: this.getMetadataString(metadata, 'chunkKind'),
            isDefinition: metadata.isDefinition === true,
            fileRole: this.getMetadataString(metadata, 'fileRole'),
            basename: this.getMetadataString(metadata, 'basename'),
            pathSegment0: this.getMetadataString(metadata, 'pathSegment0'),
            pathSegment1: this.getMetadataString(metadata, 'pathSegment1'),
            pathSegment2: this.getMetadataString(metadata, 'pathSegment2'),
            pathSegment3: this.getMetadataString(metadata, 'pathSegment3'),
            pathSegment4: this.getMetadataString(metadata, 'pathSegment4'),
        };
    }

    private extractPathTokens(relativePath: string): string[] {
        return [...new Set(
            relativePath
                .split(/[\\/._-]+/)
                .map(token => token.trim())
                .filter(token => token.length >= 2)
        )];
    }

    private extractPathSegments(relativePath: string): string[] {
        return relativePath
            .replace(/\\/g, '/')
            .split('/')
            .map(segment => segment.trim())
            .filter(segment => segment.length > 0)
            .slice(0, 5);
    }

    private extractDefinitionIdentifiers(content: string): string[] {
        const identifiers = new Set<string>();
        const definitionPatterns = [
            /\b(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|function|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g,
            /\b(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
            /\bfunc\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
            /\b(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
            /\b(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|mod)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
            /\b(?:public|private|protected|internal|static|final|abstract|override|virtual|async|sealed|synchronized|\s)+(?:[A-Za-z_$][A-Za-z0-9_$<>\[\],.?]*\s+)+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g,
            /^#{1,6}\s+(.+?)\s*#*\s*$/gm,
        ];

        for (const pattern of definitionPatterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(content)) !== null) {
                identifiers.add(match[1].trim());
            }
        }

        return [...identifiers];
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
            if (embedding.vector.length !== embeddings[0].vector.length) {
                throw new EmbeddingError(
                    `Embedding API returned inconsistent vector dimensions in one batch: index 0=${embeddings[0].vector.length}, index ${index}=${embedding.vector.length}`
                );
            }
        });
    }

    /**
     * Get programming language based on file extension
     */
    private getLanguageFromExtension(ext: string): string {
        const languageMap: Record<string, string> = {
            '.ts': 'typescript',
            '.tsx': 'tsx',
            '.js': 'javascript',
            '.jsx': 'jsx',
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
            '.md': 'markdown',
            '.markdown': 'markdown',
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

            // Load root and nested .*ignore files with directory-local scope.
            const ignoreFiles = await this.findIgnoreFiles(codebasePath, additionalIgnoreFiles);
            for (const ignoreFile of ignoreFiles) {
                const patterns = await this.loadIgnoreFile(ignoreFile.filePath, path.relative(codebasePath, ignoreFile.filePath));
                fileBasedPatterns.push(...this.scopeIgnorePatterns(patterns, ignoreFile.scopeRelativePath));
            }

            // Load global ~/.hitmux-context-engine/.hitmux-context-engineignore
            const globalIgnorePatterns = await this.loadGlobalIgnoreFile();
            fileBasedPatterns.push(...globalIgnorePatterns);

            const configuredIgnorePatterns = this.getCustomIgnorePatternsFromConfig(codebasePath);
            const effectiveIgnorePatterns = this.dedupePatterns([
                ...this.baseIgnorePatterns,
                ...configuredIgnorePatterns,
                ...additionalIgnorePatterns,
                ...fileBasedPatterns
            ]);
            // Preserve the previous observable getIgnorePatterns() behavior for
            // sequential callers, while all indexing paths use the local return
            // value to avoid shared-state leakage between background tasks.
            this.ignorePatterns = effectiveIgnorePatterns;

            if (fileBasedPatterns.length > 0 || additionalIgnorePatterns.length > 0 || configuredIgnorePatterns.length > 0) {
                console.log(`[Context] 🚫 Loaded total ${fileBasedPatterns.length} ignore patterns from all ignore files, ${configuredIgnorePatterns.length} config ignore patterns, and ${additionalIgnorePatterns.length} request ignore patterns`);
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
                ...this.getCustomIgnorePatternsFromConfig(codebasePath),
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
                        if (entry.name.startsWith('.') && entry.name.endsWith('ignore')) {
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
    private getCustomExtensionsFromConfig(projectRoot?: string): string[] {
        const configuredExtensions = configManager.getStringArray('customExtensions', projectRoot);
        return this.normalizeCustomExtensions(configuredExtensions);
    }

    private getGlobalCustomExtensionsFromConfig(): string[] {
        const configuredExtensions = configManager.getGlobalStringArray('customExtensions');
        return this.normalizeCustomExtensions(configuredExtensions);
    }

    private normalizeCustomExtensions(configuredExtensions: string[]): string[] {
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
    private getCustomIgnorePatternsFromConfig(projectRoot?: string): string[] {
        const configuredIgnorePatterns = configManager.getStringArray('customIgnorePatterns', projectRoot);
        return this.normalizeCustomIgnorePatterns(configuredIgnorePatterns);
    }

    private getGlobalCustomIgnorePatternsFromConfig(): string[] {
        const configuredIgnorePatterns = configManager.getGlobalStringArray('customIgnorePatterns');
        return this.normalizeCustomIgnorePatterns(configuredIgnorePatterns);
    }

    private normalizeCustomIgnorePatterns(configuredIgnorePatterns: string[]): string[] {
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
