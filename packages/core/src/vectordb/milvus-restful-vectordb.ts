/**
 * Milvus RESTful Vector Database Implementation
 * 
 * This RESTful implementation of Milvus vector database is specifically designed for 
 * environments with strict dependency constraints, such as browser-like runtimes.
 * 
 * The standard Milvus gRPC implementation requires some dependencies and modules
 * that are not available or restricted in these constrained environments. This RESTful
 * implementation uses only HTTP requests, making it compatible with them.
 */

import {
    VectorDocument,
    SearchOptions,
    VectorSearchResult,
    VectorDatabase,
    HybridSearchRequest,
    HybridSearchOptions,
    HybridSearchResult,
    COLLECTION_LIMIT_MESSAGE,
    DEFAULT_SEARCH_OUTPUT_FIELDS,
    InsertOptions,
} from './types';
import {
    REMOTE_INDEX_MANIFEST_COLLECTION,
    REMOTE_INDEX_MANIFEST_VECTOR_DIMENSION,
    createRemoteIndexManifestDocument,
    getRemoteIndexManifestDocumentId,
    getRemoteIndexManifestKey,
    parseRemoteIndexManifestRow,
    type RemoteIndexManifest,
} from './remote-index-manifest';
import { ClusterManager } from './zilliz-utils';
import { formatErrorDetails, milvusOperationError } from '../utils/error-format';
import { isUnsupportedSparseVectorError, milvusHybridCompatibilityError } from './milvus-compatibility';
import {
    STRUCTURED_STRING_FIELD_DEFINITIONS,
    createSchemaMismatchError,
    createStructuredInsertRow as createInsertRow,
    getStructuredDocumentFields,
    getMetadataHydrationOutputFields,
    hydrateSlimMetadataRows,
    isMissingStructuredFieldMessage,
    mergeStructuredMetadata,
    requireCurrentStructuredSchema
} from './milvus-structured-fields';

export interface MilvusRestfulConfig {
    address?: string;
    token?: string;
    username?: string;
    password?: string;
    database?: string;
}

function createStructuredFieldSchemas(): Array<Record<string, unknown>> {
    return [
        ...STRUCTURED_STRING_FIELD_DEFINITIONS.map(field => ({
            fieldName: field.name,
            dataType: "VarChar",
            elementTypeParams: {
                max_length: field.maxLength
            }
        })),
        {
            fieldName: "isDefinition",
            dataType: "Bool"
        }
    ];
}

function isMissingStructuredFieldError(error: unknown): boolean {
    const message = formatErrorDetails(error);
    return isMissingStructuredFieldMessage(message);
}

function isCollectionAlreadyExistsError(error: unknown): boolean {
    const message = formatErrorDetails(error);
    return /collection.*(already.*exist|exist|duplicate)|already.*exist|duplicate.*collection/i.test(message);
}

/**
 * TODO: Change this usage to checkCollectionLimit()
 * Wrapper function to handle collection creation with limit detection
 * This is the single point where collection limit errors are detected and handled
 */
async function createCollectionWithLimitCheck(
    makeRequestFn: (endpoint: string, method: 'GET' | 'POST', data?: any) => Promise<any>,
    collectionSchema: any
): Promise<void> {
    try {
        await makeRequestFn('/collections/create', 'POST', collectionSchema);
    } catch (error: any) {
        // Check if the error message contains the collection limit exceeded pattern
        const errorMessage = error.message || error.toString() || '';
        if (/exceeded the limit number of collections/i.test(errorMessage)) {
            // Throw the exact message string, not an Error object
            throw COLLECTION_LIMIT_MESSAGE;
        }
        // Re-throw other errors as-is
        throw error;
    }
}

/**
 * Milvus Vector Database implementation using REST API
 * This implementation is designed for environments where gRPC is not available,
 * such as browser-like environments.
 */
export class MilvusRestfulVectorDatabase implements VectorDatabase {
    protected config: MilvusRestfulConfig;
    private baseUrl: string | null = null;
    protected initializationPromise: Promise<void>;
    private initializationError: unknown;
    private verifiedStructuredSchemaCollections = new Set<string>();
    private performanceMetrics = {
        flushLoadMs: 0
    };

    constructor(config: MilvusRestfulConfig) {
        this.config = config;

        // Start initialization asynchronously without waiting
        this.initializationPromise = this.initialize().catch((error: unknown) => {
            this.initializationError = error;
        });
    }

    private async initialize(): Promise<void> {
        const resolvedAddress = await this.resolveAddress();
        await this.initializeClient(resolvedAddress);
    }

    private async initializeClient(address: string): Promise<void> {
        // Ensure address has protocol prefix
        let processedAddress = address;
        if (!processedAddress.startsWith('http://') && !processedAddress.startsWith('https://')) {
            processedAddress = `http://${processedAddress}`;
        }

        this.baseUrl = processedAddress.replace(/\/$/, '') + '/v2/vectordb';

        console.log(`🔌 Connecting to Milvus REST API at: ${processedAddress}`);
    }

    /**
     * Resolve address from config or token
     * Common logic for both gRPC and REST implementations
     */
    protected async resolveAddress(): Promise<string> {
        let finalConfig = { ...this.config };

        // If address is not provided, get it using token
        if (!finalConfig.address && finalConfig.token) {
            finalConfig.address = await ClusterManager.getAddressFromToken(finalConfig.token);
        }

        if (!finalConfig.address) {
            throw new Error('Address is required and could not be resolved from token');
        }

        return finalConfig.address;
    }

    /**
     * Ensure initialization is complete before method execution
     */
    protected async ensureInitialized(): Promise<void> {
        await this.initializationPromise;
        if (this.initializationError !== undefined) {
            throw this.initializationError;
        }
        if (!this.baseUrl) {
            throw new Error('Base URL not initialized');
        }
    }

    /**
     * Ensure collection is loaded before search/query operations
     */
    protected async ensureLoaded(collectionName: string): Promise<void> {
        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            // Check if collection is loaded
            const response = await this.makeRequest('/collections/get_load_state', 'POST', {
                collectionName,
                dbName: restfulConfig.database
            });

            const loadState = response.data?.loadState;
            if (loadState !== 'LoadStateLoaded') {
                console.log(`[MilvusRestfulDB] 🔄 Loading collection '${collectionName}' to memory...`);
                await this.loadCollection(collectionName);
            }
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to ensure collection '${collectionName}' is loaded:`, error);
            throw error;
        }
    }

    drainPerformanceMetrics(): { flushLoadMs: number } {
        const snapshot = { ...this.performanceMetrics };
        this.performanceMetrics.flushLoadMs = 0;
        return snapshot;
    }

    private async measureFlushLoad<T>(action: () => Promise<T>): Promise<T> {
        const startedAt = Number(process.hrtime.bigint()) / 1_000_000;
        try {
            return await action();
        } finally {
            this.performanceMetrics.flushLoadMs += Number(process.hrtime.bigint()) / 1_000_000 - startedAt;
        }
    }

    /**
     * Make HTTP request to Milvus REST API
     */
    private async makeRequest(endpoint: string, method: 'GET' | 'POST' = 'POST', data?: any): Promise<any> {
        const url = `${this.baseUrl}${endpoint}`;

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };

        // Handle authentication
        if (this.config.token) {
            headers['Authorization'] = `Bearer ${this.config.token}`;
        } else if (this.config.username && this.config.password) {
            headers['Authorization'] = `Bearer ${this.config.username}:${this.config.password}`;
        }

        const requestOptions: RequestInit = {
            method,
            headers,
        };

        if (data && method === 'POST') {
            requestOptions.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(url, requestOptions);
            const responseText = await response.text();
            let result: any = {};
            if (responseText.trim().length > 0) {
                try {
                    result = JSON.parse(responseText);
                } catch {
                    result = { rawBody: responseText };
                }
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}; endpoint=${endpoint}; response=${formatErrorDetails(result)}`);
            }

            if (result.code !== 0 && result.code !== 200) {
                throw new Error(`Milvus API error at ${endpoint}: ${formatErrorDetails(result)}`);
            }

            return result;
        } catch (error) {
            const wrapped = milvusOperationError('Milvus REST request', {
                endpoint,
                method,
                request: data,
            }, error);
            console.error(`[MilvusRestfulDB] Milvus REST API request failed:`, wrapped.message);
            throw wrapped;
        }
    }

    async createCollection(collectionName: string, dimension: number, description?: string): Promise<void> {
        await this.ensureInitialized();

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            // Build collection schema based on the original milvus-vectordb.ts implementation
            const collectionSchema: any = {
                collectionName,
                dbName: restfulConfig.database,
                description: description || `Hitmux Context Engine collection: ${collectionName}`,
                schema: {
                    enableDynamicField: false,
                    fields: [
                        {
                            fieldName: "id",
                            dataType: "VarChar",
                            isPrimary: true,
                            elementTypeParams: {
                                max_length: 512
                            }
                        },
                        {
                            fieldName: "vector",
                            dataType: "FloatVector",
                            elementTypeParams: {
                                dim: dimension
                            }
                        },
                        {
                            fieldName: "content",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 65535
                            }
                        },
                        {
                            fieldName: "relativePath",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 1024
                            }
                        },
                        {
                            fieldName: "startLine",
                            dataType: "Int64"
                        },
                        {
                            fieldName: "endLine",
                            dataType: "Int64"
                        },
                        {
                            fieldName: "fileExtension",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 32
                            }
                        },
                        {
                            fieldName: "metadata",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 65535
                            }
                        },
                        ...createStructuredFieldSchemas()
                    ]
                }
            };

            // Step 1: Create collection with schema
            try {
                await createCollectionWithLimitCheck(this.makeRequest.bind(this), collectionSchema);
            } catch (error) {
                throw milvusOperationError('Milvus REST createCollection', {
                    collectionName,
                    dimension,
                    description: collectionSchema.description,
                }, error);
            }

            // Step 2: Create index for vector field (separate API call)
            await this.createIndex(collectionName);

            // Step 3: Load collection to memory for searching
            await this.loadCollection(collectionName);

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to create collection '${collectionName}':`, error);
            throw error;
        }
    }

    /**
     * Create index for vector field using the Index Create API
     */
    private async createIndex(collectionName: string): Promise<void> {
        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            const indexParams = {
                collectionName,
                dbName: restfulConfig.database,
                indexParams: [
                    {
                        fieldName: "vector",
                        indexName: "vector_index",
                        metricType: "COSINE",
                        params: {
                            index_type: "AUTOINDEX"
                        }
                    }
                ]
            };

            await this.makeRequest('/indexes/create', 'POST', indexParams);
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to create index for collection '${collectionName}':`, error);
            throw error;
        }
    }

    private async getIndexNames(collectionName: string): Promise<string[]> {
        const restfulConfig = this.config as MilvusRestfulConfig;
        const response = await this.makeRequest('/indexes/list', 'POST', {
            collectionName,
            dbName: restfulConfig.database
        });

        return Array.isArray(response.data) ? response.data : [];
    }

    private async createRestIndexIfMissing(collectionName: string, indexName: string, indexParams: any): Promise<void> {
        const indexNames = await this.getIndexNames(collectionName);

        if (indexNames.includes(indexName)) {
            console.log(`[MilvusRestfulDB] ✅ Index '${indexName}' already exists in collection '${collectionName}'`);
            return;
        }

        try {
            await this.makeRequest('/indexes/create', 'POST', indexParams);
        } catch (error: any) {
            const message = error?.message || String(error);
            if (/index.*(exist|duplicate)|duplicate.*index/i.test(message)) {
                console.log(`[MilvusRestfulDB] ✅ Index '${indexName}' already exists in collection '${collectionName}'`);
                return;
            }
            throw error;
        }
    }

    async ensureHybridCollectionReady(collectionName: string): Promise<void> {
        await this.ensureInitialized();

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;

            await this.createRestIndexIfMissing(collectionName, "vector_index", {
                collectionName,
                dbName: restfulConfig.database,
                indexParams: [
                    {
                        fieldName: "vector",
                        indexName: "vector_index",
                        metricType: "COSINE",
                        params: {
                            index_type: "AUTOINDEX"
                        }
                    }
                ]
            });

            await this.createRestIndexIfMissing(collectionName, "sparse_vector_index", {
                collectionName,
                dbName: restfulConfig.database,
                indexParams: [
                    {
                        fieldName: "sparse_vector",
                        indexName: "sparse_vector_index",
                        metricType: "BM25",
                        params: {
                            index_type: "SPARSE_INVERTED_INDEX",
                            inverted_index_algo: "DAAT_WAND"
                        }
                    }
                ]
            });

            await this.loadCollection(collectionName);
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to ensure hybrid collection '${collectionName}' is ready:`, error);
            throw error;
        }
    }

    /**
     * Load collection to memory for searching
     */
    private async loadCollection(collectionName: string): Promise<void> {
        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            await this.makeRequest('/collections/load', 'POST', {
                collectionName,
                dbName: restfulConfig.database
            });
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to load collection '${collectionName}':`, error);
            throw error;
        }
    }

    private async flushCollection(collectionName: string): Promise<void> {
        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            await this.makeRequest('/collections/flush', 'POST', {
                collectionName,
                dbName: restfulConfig.database
            });
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to flush collection '${collectionName}':`, error);
            throw error;
        }
    }

    async dropCollection(collectionName: string): Promise<void> {
        await this.ensureInitialized();

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            await this.makeRequest('/collections/drop', 'POST', {
                collectionName,
                dbName: restfulConfig.database
            });
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to drop collection '${collectionName}':`, error);
            throw error;
        }
    }

    async hasCollection(collectionName: string): Promise<boolean> {
        await this.ensureInitialized();

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            const response = await this.makeRequest('/collections/has', 'POST', {
                collectionName,
                dbName: restfulConfig.database
            });

            const exists = response.data?.has || false;
            return exists;
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to check collection '${collectionName}' existence:`, error);
            throw error;
        }
    }

    async listCollections(): Promise<string[]> {
        await this.ensureInitialized();

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            const response = await this.makeRequest('/collections/list', 'POST', {
                dbName: restfulConfig.database
            });

            return response.data || [];
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to list collections:`, error);
            throw error;
        }
    }

    private async ensureIndexManifestCollection(): Promise<void> {
        const exists = await this.hasCollection(REMOTE_INDEX_MANIFEST_COLLECTION);
        if (exists) {
            return;
        }

        try {
            await this.createCollection(
                REMOTE_INDEX_MANIFEST_COLLECTION,
                REMOTE_INDEX_MANIFEST_VECTOR_DIMENSION,
                'Hitmux Context Engine remote index status manifests'
            );
        } catch (error) {
            if (!isCollectionAlreadyExistsError(error) || !(await this.hasCollection(REMOTE_INDEX_MANIFEST_COLLECTION))) {
                throw error;
            }
        }
    }

    async readIndexManifest(collectionName: string, codebasePath: string): Promise<RemoteIndexManifest | null> {
        const exists = await this.hasCollection(REMOTE_INDEX_MANIFEST_COLLECTION);
        if (!exists) {
            return null;
        }

        const relativePath = getRemoteIndexManifestKey(collectionName, codebasePath);
        const rows = await this.query(
            REMOTE_INDEX_MANIFEST_COLLECTION,
            `relativePath == "${relativePath}"`,
            ['content'],
            1
        );
        return rows.length > 0 ? parseRemoteIndexManifestRow(rows[0]) : null;
    }

    async writeIndexManifest(manifest: RemoteIndexManifest): Promise<void> {
        await this.ensureIndexManifestCollection();
        const documentId = getRemoteIndexManifestDocumentId(manifest.collectionName, manifest.codebasePath);
        try {
            await this.delete(REMOTE_INDEX_MANIFEST_COLLECTION, [documentId]);
        } catch (error) {
            console.warn(`[MilvusRestfulDB] Failed to delete previous index manifest '${documentId}', continuing with upsert insert:`, error);
        }
        await this.insert(REMOTE_INDEX_MANIFEST_COLLECTION, [createRemoteIndexManifestDocument(manifest)]);
    }

    async deleteIndexManifest(collectionName: string, codebasePath: string): Promise<void> {
        const exists = await this.hasCollection(REMOTE_INDEX_MANIFEST_COLLECTION);
        if (!exists) {
            return;
        }
        await this.delete(
            REMOTE_INDEX_MANIFEST_COLLECTION,
            [getRemoteIndexManifestDocumentId(collectionName, codebasePath)]
        );
    }

    async insert(collectionName: string, documents: VectorDocument[], options: InsertOptions = {}): Promise<void> {
        await this.ensureInitialized();
        if (!options.deferFlushLoad) {
            await this.measureFlushLoad(() => this.ensureLoaded(collectionName));
        }

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            // Transform VectorDocument array to Milvus entity format
            const data = documents.map(createInsertRow);

            const insertRequest = {
                collectionName,
                data,
                dbName: restfulConfig.database
            };

            await this.makeRequest('/entities/insert', 'POST', insertRequest);
            if (!options.deferFlushLoad) {
                await this.measureFlushLoad(async () => {
                    await this.flushCollection(collectionName);
                    await this.ensureLoaded(collectionName);
                });
            }

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to insert documents into collection '${collectionName}':`, error);
            throw error;
        }
    }

    async search(collectionName: string, queryVector: number[], options?: SearchOptions): Promise<VectorSearchResult[]> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        const topK = options?.topK || 10;

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            await this.ensureCurrentStructuredSchema(collectionName);
            // Build search request according to Milvus REST API specification
            const searchRequest: any = {
                collectionName,
                dbName: restfulConfig.database,
                data: [queryVector], // Array of query vectors
                annsField: "vector", // Vector field name
                limit: topK,
                outputFields: [...DEFAULT_SEARCH_OUTPUT_FIELDS],
                searchParams: {
                    metricType: "COSINE", // Match the index metric type
                    params: {}
                }
            };

            // Apply boolean expression filter if provided (e.g., fileExtension in ['.ts','.py']) 
            if (options?.filterExpr && options.filterExpr.trim().length > 0) {
                searchRequest.filter = options.filterExpr;
            }

            let response: any;
            try {
                response = await this.makeRequest('/entities/search', 'POST', searchRequest);
            } catch (error) {
                throw isMissingStructuredFieldError(error)
                    ? createSchemaMismatchError(collectionName, 'Milvus rejected one or more structured output fields.')
                    : error;
            }

            // Transform response to VectorSearchResult format
            const results: VectorSearchResult[] = (response.data || []).map((item: any) => {
                // Parse metadata from JSON string
                let metadata = {};
                try {
                    metadata = mergeStructuredMetadata(item, JSON.parse(item.metadata || '{}'));
                } catch (error) {
                    console.warn(`[MilvusRestfulDB] Failed to parse metadata for item ${item.id}:`, error);
                    metadata = {};
                }

                return {
                    document: {
                        id: item.id?.toString() || '',
                        vector: queryVector, // Vector not returned in search results
                        content: item.content || '',
                        relativePath: item.relativePath || '',
                        startLine: item.startLine || 0,
                        endLine: item.endLine || 0,
                        fileExtension: item.fileExtension || '',
                        metadata: metadata,
                        ...getStructuredDocumentFields(item),
                    },
                    score: item.distance || 0
                };
            });

            return results;

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to search in collection '${collectionName}':`, error);
            throw error;
        }
    }

    async delete(collectionName: string, ids: string[]): Promise<void> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            // Build filter expression for deleting by IDs
            // Format: id in ["id1", "id2", "id3"]
            const filter = `id in [${ids.map(id => `"${id}"`).join(', ')}]`;

            const deleteRequest = {
                collectionName,
                filter,
                dbName: restfulConfig.database
            };

            await this.makeRequest('/entities/delete', 'POST', deleteRequest);

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to delete documents from collection '${collectionName}':`, error);
            throw error;
        }
    }

    async query(collectionName: string, filter: string, outputFields: string[], limit?: number): Promise<Record<string, any>[]> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            const requestedOutputFields = outputFields;
            const hydrationOutputFields = getMetadataHydrationOutputFields(requestedOutputFields);
            const queryRequest: Record<string, any> = {
                collectionName,
                dbName: restfulConfig.database,
                outputFields: hydrationOutputFields,
                offset: 0
            };
            // Only include filter if it's a non-empty, non-whitespace string
            if (filter && filter.trim() !== '') {
                queryRequest.filter = filter;
            }
            // Add limit if provided, or default when no filter is specified
            if (limit !== undefined) {
                queryRequest.limit = limit;
            } else if (!filter || filter.trim() === '') {
                queryRequest.limit = 16384;
            }

            let response = await this.makeRequest('/entities/query', 'POST', queryRequest);
            if (
                response.code !== 0
                && hydrationOutputFields.length !== requestedOutputFields.length
                && isMissingStructuredFieldMessage(response.message || '')
            ) {
                response = await this.makeRequest('/entities/query', 'POST', {
                    ...queryRequest,
                    outputFields: requestedOutputFields,
                });
            }

            if (response.code !== 0) {
                throw new Error(`Failed to query Milvus: ${response.message || 'Unknown error'}`);
            }

            return hydrateSlimMetadataRows(response.data || [], outputFields);

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to query collection '${collectionName}':`, error);
            throw error;
        }
    }

    async createHybridCollection(collectionName: string, dimension: number, description?: string): Promise<void> {
        await this.ensureInitialized();

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;

            const collectionSchema: any = {
                collectionName,
                dbName: restfulConfig.database,
                description: description || `Hybrid code context collection: ${collectionName}`,
                schema: {
                    enableDynamicField: false,
                    functions: [
                        {
                            name: "content_bm25_emb",
                            description: "content bm25 function",
                            type: "BM25",
                            inputFieldNames: ["content"],
                            outputFieldNames: ["sparse_vector"],
                            params: {},
                        },
                    ],
                    fields: [
                        {
                            fieldName: "id",
                            dataType: "VarChar",
                            isPrimary: true,
                            elementTypeParams: {
                                max_length: 512
                            }
                        },
                        {
                            fieldName: "content",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 65535,
                                enable_analyzer: true
                            }
                        },
                        {
                            fieldName: "vector",
                            dataType: "FloatVector",
                            elementTypeParams: {
                                dim: dimension
                            }
                        },
                        {
                            fieldName: "sparse_vector",
                            dataType: "SparseFloatVector"
                        },
                        {
                            fieldName: "relativePath",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 1024
                            }
                        },
                        {
                            fieldName: "startLine",
                            dataType: "Int64"
                        },
                        {
                            fieldName: "endLine",
                            dataType: "Int64"
                        },
                        {
                            fieldName: "fileExtension",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 32
                            }
                        },
                        {
                            fieldName: "metadata",
                            dataType: "VarChar",
                            elementTypeParams: {
                                max_length: 65535
                            }
                        },
                        ...createStructuredFieldSchemas()
                    ]
                }
            };

            // Step 1: Create collection with schema and functions
            try {
                await createCollectionWithLimitCheck(this.makeRequest.bind(this), collectionSchema);
            } catch (error) {
                if (isUnsupportedSparseVectorError(error)) {
                    throw milvusHybridCompatibilityError('Milvus REST createHybridCollection', error);
                }
                throw milvusOperationError('Milvus REST createHybridCollection', {
                    collectionName,
                    dimension,
                    description: collectionSchema.description,
                }, error);
            }

            // Step 2: Create indexes for both vector fields
            await this.ensureHybridCollectionReady(collectionName);

            // ensureHybridCollectionReady loads the collection for searching.

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to create hybrid collection '${collectionName}':`, error);
            throw error;
        }
    }

    private async createHybridIndexes(collectionName: string): Promise<void> {
        try {
            const restfulConfig = this.config as MilvusRestfulConfig;

            // Create index for dense vector
            const denseIndexParams = {
                collectionName,
                dbName: restfulConfig.database,
                indexParams: [
                    {
                        fieldName: "vector",
                        indexName: "vector_index",
                        metricType: "COSINE",
                        params: {
                            index_type: "AUTOINDEX"
                        }
                    }
                ]
            };
            await this.makeRequest('/indexes/create', 'POST', denseIndexParams);

            // Create index for sparse vector
            const sparseIndexParams = {
                collectionName,
                dbName: restfulConfig.database,
                indexParams: [
                    {
                        fieldName: "sparse_vector",
                        indexName: "sparse_vector_index",
                        metricType: "BM25",
                        params: {
                            index_type: "SPARSE_INVERTED_INDEX",
                            inverted_index_algo: "DAAT_WAND"
                        }
                    }
                ]
            };
            await this.makeRequest('/indexes/create', 'POST', sparseIndexParams);

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to create hybrid indexes for collection '${collectionName}':`, error);
            throw error;
        }
    }

    async insertHybrid(collectionName: string, documents: VectorDocument[], options: InsertOptions = {}): Promise<void> {
        await this.ensureInitialized();
        if (!options.deferFlushLoad) {
            await this.measureFlushLoad(() => this.ensureLoaded(collectionName));
        }

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;

            const data = documents.map(createInsertRow);

            const insertRequest = {
                collectionName,
                dbName: restfulConfig.database,
                data: data
            };

            const response = await this.makeRequest('/entities/insert', 'POST', insertRequest);

            if (response.code !== 0) {
                throw new Error(`Insert failed: ${response.message || 'Unknown error'}`);
            }
            if (!options.deferFlushLoad) {
                await this.measureFlushLoad(async () => {
                    await this.flushCollection(collectionName);
                    await this.ensureLoaded(collectionName);
                });
            }

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to insert hybrid documents to collection '${collectionName}':`, error);
            throw error;
        }
    }

    async finalizeCollectionWrites(collectionName: string): Promise<void> {
        await this.ensureInitialized();
        await this.measureFlushLoad(async () => {
            await this.flushCollection(collectionName);
            await this.ensureLoaded(collectionName);
        });
    }

    async hybridSearch(collectionName: string, searchRequests: HybridSearchRequest[], options?: HybridSearchOptions): Promise<HybridSearchResult[]> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;

            console.log(`[MilvusRestfulDB] 🔍 Preparing hybrid search for collection: ${collectionName}`);

            // Prepare search requests according to Milvus REST API hybrid search specification
            // For dense vector search - data must be array of vectors: [[0.1, 0.2, 0.3, ...]]
            const search_param_1: any = {
                data: Array.isArray(searchRequests[0].data) ? [searchRequests[0].data] : [[searchRequests[0].data]],
                annsField: searchRequests[0].anns_field, // "vector"
                limit: searchRequests[0].limit,
                outputFields: ["*"],
                searchParams: {
                    metricType: "COSINE",
                    params: searchRequests[0].param || { "nprobe": 10 }
                }
            };

            // For sparse vector search - data must be array of queries: ["query text"]
            const search_param_2: any = {
                data: Array.isArray(searchRequests[1].data) ? searchRequests[1].data : [searchRequests[1].data],
                annsField: searchRequests[1].anns_field, // "sparse_vector"
                limit: searchRequests[1].limit,
                outputFields: ["*"],
                searchParams: {
                    metricType: "BM25",
                    params: searchRequests[1].param || { "drop_ratio_search": 0.2 }
                }
            };

            // Apply filter to both search parameters if provided
            if (options?.filterExpr && options.filterExpr.trim().length > 0) {
                search_param_1.filter = options.filterExpr;
                search_param_2.filter = options.filterExpr;
            }

            const rerank_strategy = {
                strategy: "rrf",
                params: {
                    k: 100
                }
            };

            console.log(`[MilvusRestfulDB] 🔍 Dense search params:`, JSON.stringify({
                annsField: search_param_1.annsField,
                limit: search_param_1.limit,
                data_length: Array.isArray(search_param_1.data[0]) ? search_param_1.data[0].length : 'N/A',
                searchParams: search_param_1.searchParams
            }, null, 2));
            console.log(`[MilvusRestfulDB] 🔍 Sparse search params:`, JSON.stringify({
                annsField: search_param_2.annsField,
                limit: search_param_2.limit,
                query_text: typeof search_param_2.data[0] === 'string' ? search_param_2.data[0].substring(0, 50) + '...' : 'N/A',
                searchParams: search_param_2.searchParams
            }, null, 2));

            await this.ensureCurrentStructuredSchema(collectionName);
            const hybridSearchRequest: any = {
                collectionName,
                dbName: restfulConfig.database,
                search: [search_param_1, search_param_2],
                rerank: rerank_strategy,
                limit: options?.limit || searchRequests[0]?.limit || 10,
                outputFields: [...DEFAULT_SEARCH_OUTPUT_FIELDS],
            };

            console.log(`[MilvusRestfulDB] 🔍 Executing REST API hybrid search...`);
            let response: any;
            try {
                response = await this.makeRequest('/entities/hybrid_search', 'POST', hybridSearchRequest);
            } catch (error) {
                throw isMissingStructuredFieldError(error)
                    ? createSchemaMismatchError(collectionName, 'Milvus rejected one or more structured output fields.')
                    : error;
            }

            if (response.code !== 0) {
                throw new Error(`Hybrid search failed: ${response.message || 'Unknown error'}`);
            }

            const results = response.data || [];
            console.log(`[MilvusRestfulDB] ✅ Found ${results.length} results from hybrid search`);

            // Transform response to HybridSearchResult format
            return results.map((result: any) => {
                let metadata = {};
                try {
                    metadata = mergeStructuredMetadata(result, JSON.parse(result.metadata || '{}'));
                } catch (error) {
                    console.warn(`[MilvusRestfulDB] Failed to parse metadata for item ${result.id}:`, error);
                }

                return {
                    document: {
                        id: result.id,
                        content: result.content,
                        vector: [], // Vector not returned in search results
                        sparse_vector: [], // Vector not returned in search results
                        relativePath: result.relativePath,
                        startLine: result.startLine,
                        endLine: result.endLine,
                        fileExtension: result.fileExtension,
                        metadata,
                        ...getStructuredDocumentFields(result),
                    },
                    score: result.score || result.distance || 0,
                };
            });

        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to perform hybrid search on collection '${collectionName}':`, error);
            throw error;
        }
    }

    async getCollectionDescription(collectionName: string): Promise<string> {
        await this.ensureInitialized();

        try {
            const restfulConfig = this.config as MilvusRestfulConfig;
            const response = await this.makeRequest('/collections/describe', 'POST', {
                collectionName,
                dbName: restfulConfig.database
            });

            return response.data?.description || '';
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Failed to get description for collection '${collectionName}':`, error);
            throw error;
        }
    }

    private async ensureCurrentStructuredSchema(collectionName: string): Promise<void> {
        if (!this.verifiedStructuredSchemaCollections) {
            this.verifiedStructuredSchemaCollections = new Set<string>();
        }

        if (this.verifiedStructuredSchemaCollections.has(collectionName)) {
            return;
        }

        try {
            const description = await this.getCollectionDescription(collectionName);
            requireCurrentStructuredSchema(collectionName, description);
            this.verifiedStructuredSchemaCollections.add(collectionName);
        } catch (error) {
            throw error instanceof Error
                ? error
                : createSchemaMismatchError(collectionName, String(error));
        }
    }

    /**
     * Check collection limit
     * Returns true if collection can be created, false if limit exceeded
     * TODO: Implement proper collection limit checking for REST API
     */
    async checkCollectionLimit(): Promise<boolean> {
        // TODO: Implement REST API version of collection limit checking
        // For now, always return true to maintain compatibility
        console.warn('[MilvusRestfulDB] ⚠️  checkCollectionLimit not implemented for REST API - returning true');
        return true;
    }

    /**
     * Get the number of entities (rows) in a collection.
     * Returns -1 on any failure (collection missing, RPC error, malformed response).
     * -1 means "unknown" — callers must NOT treat it as "empty".
     *
     * Uses count(*) via /entities/query rather than /collections/get_stats: stats
     * are computed from sealed segments and lag recent inserts (returning 0 for
     * a freshly-indexed but unflushed collection), while count(*) reads the real
     * current state. A stale 0 would fool recovery into thinking the collection
     * is truly empty and cause Issue #295-style false-negative "not indexed"
     * errors even when data exists.
     */
    async getCollectionRowCount(collectionName: string): Promise<number> {
        await this.ensureInitialized();
        try {
            const restfulConfig = this.config as MilvusRestfulConfig;

            const hasResponse = await this.makeRequest('/collections/has', 'POST', {
                collectionName,
                dbName: restfulConfig.database
            });
            if (!hasResponse.data?.has) return -1;

            // count(*) requires the collection to be loaded.
            await this.ensureLoaded(collectionName);

            const response = await this.makeRequest('/entities/query', 'POST', {
                collectionName,
                dbName: restfulConfig.database,
                outputFields: ['count(*)'],
            });

            const row = response?.data?.[0];
            if (!row) return -1;
            const raw = row['count(*)'] ?? row['count'];
            if (raw === undefined || raw === null) return -1;
            const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
            return Number.isFinite(n) && n >= 0 ? n : -1;
        } catch (error) {
            console.error(`[MilvusRestfulDB] ❌ Error in count(*) query for '${collectionName}':`, error);
            return -1;
        }
    }
}
