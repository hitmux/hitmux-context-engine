import { MilvusClient, DataType, MetricType, FunctionType, LoadState } from '@zilliz/milvus2-sdk-node';
import { randomUUID } from 'crypto';
import {
    VectorDocument,
    SearchOptions,
    VectorSearchResult,
    VectorDatabase,
    HybridSearchRequest,
    HybridSearchOptions,
    HybridSearchResult,
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
import { configManager } from '../utils/config-manager';
import { withSystemProxyPolicy } from '../utils/proxy-env';
import { withMilvusConnectionRetry } from '../utils/milvus-retry';
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
import {
    COLLECTION_LEASE_COLLECTION,
    type CollectionLeaseRecord,
    type CollectionLeaseReapResult,
    resolveCollectionLeaseConfig,
    type ResolvedCollectionLeaseConfig,
} from './collection-lease';

export interface MilvusConfig {
    address?: string;
    token?: string;
    username?: string;
    password?: string;
    ssl?: boolean;
    useSystemProxy?: boolean;
    collectionLeaseEnabled?: boolean;
    collectionLeaseHeartbeatMs?: number;
    collectionLeaseMissLimit?: number;
}

const COLLECTION_CREATE_TIMEOUT_MS = 120000;
const COLLECTION_LEASE_VECTOR_FIELD = 'leaseVector';
const COLLECTION_LEASE_VECTOR_DIMENSION = 2;
const COLLECTION_LEASE_VECTOR_INDEX = 'lease_vector_index';

function createStructuredFieldSchemas() {
    return [
        ...STRUCTURED_STRING_FIELD_DEFINITIONS.map(field => ({
            name: field.name,
            description: field.description,
            data_type: DataType.VarChar,
            max_length: field.maxLength,
        })),
        {
            name: 'isDefinition',
            description: 'Whether the chunk is a definition owner',
            data_type: DataType.Bool,
        },
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

function isCurrentLeaseVectorField(field: unknown): boolean {
    if (!field || typeof field !== 'object') {
        return false;
    }
    const candidate = field as Record<string, unknown>;
    const dataType = candidate.dataType ?? candidate.data_type;
    const typeParams = Array.isArray(candidate.type_params) ? candidate.type_params : [];
    const dimensionParameter = typeParams.find(param => (
        param && typeof param === 'object' && (param as Record<string, unknown>).key === 'dim'
    )) as Record<string, unknown> | undefined;
    const dimension = candidate.dim ?? dimensionParameter?.value;

    return candidate.name === COLLECTION_LEASE_VECTOR_FIELD &&
        (dataType === DataType.FloatVector || dataType === 'FloatVector') &&
        Number(dimension) === COLLECTION_LEASE_VECTOR_DIMENSION;
}

export class MilvusVectorDatabase implements VectorDatabase {
    protected config: MilvusConfig;
    private client: MilvusClient | null = null;
    protected initializationPromise: Promise<void>;
    private initializationError: unknown;
    private verifiedStructuredSchemaCollections = new Set<string>();
    private readonly leaseConfig: ResolvedCollectionLeaseConfig;
    private readonly leaseOwnerId = randomUUID();
    private readonly leasedCollections = new Set<string>();
    private leaseHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
    private leaseRefreshPromise: Promise<void> | null = null;
    private leaseControlCollectionPromise: Promise<void> | null = null;
    private closed = false;
    private performanceMetrics = {
        flushLoadMs: 0
    };

    constructor(config: MilvusConfig) {
        this.config = config;
        this.leaseConfig = resolveCollectionLeaseConfig({
            enabled: config.collectionLeaseEnabled,
            heartbeatMs: config.collectionLeaseHeartbeatMs,
            missLimit: config.collectionLeaseMissLimit,
        });

        // Start initialization asynchronously without waiting
        this.initializationPromise = this.initialize().catch((error: unknown) => {
            this.initializationError = error;
        });
    }

    private async initialize(): Promise<void> {
        await withSystemProxyPolicy(this.config.useSystemProxy === true, async () => {
            const resolvedAddress = await this.resolveAddress();
            await this.initializeClient(resolvedAddress);
        });
    }

    private async initializeClient(address: string): Promise<void> {
        const milvusConfig = this.config as MilvusConfig;
        console.log('🔌 Connecting to vector database at: ', address);
        this.client = new MilvusClient({
            address: address,
            username: milvusConfig.username,
            password: milvusConfig.password,
            token: milvusConfig.token,
            ssl: milvusConfig.ssl || false,
            timeout: COLLECTION_CREATE_TIMEOUT_MS,
            'grpc.enable_http_proxy': milvusConfig.useSystemProxy ? 1 : 0,
        } as any);
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
        if (!this.client) {
            throw new Error('Client not initialized');
        }
    }

    private isLeaseControlCollection(collectionName: string): boolean {
        return collectionName === COLLECTION_LEASE_COLLECTION;
    }

    private async assertCurrentLeaseControlCollectionSchema(): Promise<void> {
        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }
        const result = await this.client.describeCollection({
            collection_name: COLLECTION_LEASE_COLLECTION,
        });
        if (!result.schema?.fields?.some(isCurrentLeaseVectorField)) {
            throw new Error(
                `Collection lease control collection '${COLLECTION_LEASE_COLLECTION}' has an incompatible legacy scalar-only schema. ` +
                `Expected FloatVector field '${COLLECTION_LEASE_VECTOR_FIELD}' with dim ${COLLECTION_LEASE_VECTOR_DIMENSION}. ` +
                'Delete this control collection during a maintenance window and retry; it is not removed automatically.'
            );
        }
    }

    private async ensureLeaseControlCollection(): Promise<void> {
        if (this.leaseControlCollectionPromise) {
            return this.leaseControlCollectionPromise;
        }

        this.leaseControlCollectionPromise = (async () => {
            await this.ensureInitialized();
            if (!this.client) {
                throw new Error('MilvusClient is not initialized after ensureInitialized().');
            }

            const exists = await this.client.hasCollection({
                collection_name: COLLECTION_LEASE_COLLECTION,
            });
            if (!exists.value) {
                try {
                    await this.client.createCollection({
                        collection_name: COLLECTION_LEASE_COLLECTION,
                        description: 'Hitmux Context Engine collection load leases',
                        fields: [
                            {
                                name: 'leaseId',
                                data_type: DataType.VarChar,
                                max_length: 512,
                                is_primary_key: true,
                            },
                            {
                                name: 'collectionName',
                                data_type: DataType.VarChar,
                                max_length: 255,
                            },
                            {
                                name: 'ownerId',
                                data_type: DataType.VarChar,
                                max_length: 128,
                            },
                            { name: 'expiresAt', data_type: DataType.Int64 },
                            { name: 'updatedAt', data_type: DataType.Int64 },
                            {
                                name: COLLECTION_LEASE_VECTOR_FIELD,
                                data_type: DataType.FloatVector,
                                dim: COLLECTION_LEASE_VECTOR_DIMENSION,
                            },
                        ],
                    });
                } catch (error) {
                    if (!isCollectionAlreadyExistsError(error)) {
                        throw error;
                    }
                }
            }
            await this.assertCurrentLeaseControlCollectionSchema();
            await this.createIndexIfMissing(
                COLLECTION_LEASE_COLLECTION,
                COLLECTION_LEASE_VECTOR_FIELD,
                {
                    collection_name: COLLECTION_LEASE_COLLECTION,
                    field_name: COLLECTION_LEASE_VECTOR_FIELD,
                    index_name: COLLECTION_LEASE_VECTOR_INDEX,
                    index_type: 'AUTOINDEX',
                    metric_type: MetricType.L2,
                },
            );
            await this.ensureRawCollectionLoaded(COLLECTION_LEASE_COLLECTION);
        })().finally(() => {
            this.leaseControlCollectionPromise = null;
        });

        return this.leaseControlCollectionPromise;
    }

    private async ensureRawCollectionLoaded(collectionName: string): Promise<void> {
        if (!this.client) {
            throw new Error('MilvusClient is not initialized. Call ensureInitialized() first.');
        }
        const result = await this.client.getLoadState({ collection_name: collectionName });
        if (result.state !== LoadState.LoadStateLoaded) {
            await this.client.loadCollection({ collection_name: collectionName });
        }
    }

    private getLeaseId(collectionName: string): string {
        return `${this.leaseOwnerId}:${collectionName}`;
    }

    private startLeaseHeartbeat(): void {
        if (this.leaseHeartbeatTimer || this.closed || this.leasedCollections.size === 0) {
            return;
        }
        this.leaseHeartbeatTimer = setInterval(() => {
            void this.refreshCollectionLeases().catch((error: unknown) => {
                console.warn(`[MilvusDB] Failed to refresh collection leases: ${formatErrorDetails(error)}`);
            });
        }, this.leaseConfig.heartbeatMs);
        this.leaseHeartbeatTimer.unref?.();
    }

    private stopLeaseHeartbeat(): void {
        if (this.leaseHeartbeatTimer) {
            clearInterval(this.leaseHeartbeatTimer);
            this.leaseHeartbeatTimer = undefined;
        }
    }

    private async upsertCollectionLease(collectionName: string): Promise<void> {
        if (!this.leaseConfig?.enabled || this.isLeaseControlCollection(collectionName)) {
            return;
        }
        await this.ensureLeaseControlCollection();
        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        const updatedAt = Date.now();
        await this.client.upsert({
            collection_name: COLLECTION_LEASE_COLLECTION,
            data: [{
                leaseId: this.getLeaseId(collectionName),
                collectionName,
                ownerId: this.leaseOwnerId,
                expiresAt: updatedAt + this.leaseConfig.ttlMs,
                updatedAt,
                [COLLECTION_LEASE_VECTOR_FIELD]: [0, 0],
            }],
        });
        this.leasedCollections.add(collectionName);
        this.startLeaseHeartbeat();
    }

    private async refreshCollectionLeases(): Promise<void> {
        if (this.leaseRefreshPromise) {
            return this.leaseRefreshPromise;
        }
        this.leaseRefreshPromise = (async () => {
            for (const collectionName of this.leasedCollections) {
                await this.upsertCollectionLease(collectionName);
            }
        })().finally(() => {
            this.leaseRefreshPromise = null;
        });
        return this.leaseRefreshPromise;
    }

    private async releaseCollectionLease(collectionName: string): Promise<void> {
        this.leasedCollections.delete(collectionName);
        if (this.leasedCollections.size === 0) {
            this.stopLeaseHeartbeat();
        }
        if (!this.leaseConfig?.enabled || this.isLeaseControlCollection(collectionName)) {
            return;
        }
        await this.ensureLeaseControlCollection();
        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }
        await this.client.delete({
            collection_name: COLLECTION_LEASE_COLLECTION,
            filter: `leaseId == ${JSON.stringify(this.getLeaseId(collectionName))}`,
        });
    }

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.stopLeaseHeartbeat();
        const collections = [...this.leasedCollections];
        await Promise.allSettled(collections.map(collectionName => this.releaseCollectionLease(collectionName)));
    }

    private parseLeaseRecord(row: Record<string, any>): CollectionLeaseRecord | null {
        const expiresAt = Number(row.expiresAt);
        const updatedAt = Number(row.updatedAt);
        if (
            typeof row.leaseId !== 'string' ||
            typeof row.collectionName !== 'string' ||
            typeof row.ownerId !== 'string' ||
            !Number.isFinite(expiresAt) ||
            !Number.isFinite(updatedAt)
        ) {
            return null;
        }
        return {
            leaseId: row.leaseId,
            collectionName: row.collectionName,
            ownerId: row.ownerId,
            expiresAt,
            updatedAt,
        };
    }

    private async readCollectionLeaseRecords(): Promise<CollectionLeaseRecord[]> {
        await this.ensureInitialized();
        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }
        const exists = await this.client.hasCollection({
            collection_name: COLLECTION_LEASE_COLLECTION,
        });
        if (!exists.value) {
            return [];
        }
        await this.ensureRawCollectionLoaded(COLLECTION_LEASE_COLLECTION);
        const result = await this.client.query({
            collection_name: COLLECTION_LEASE_COLLECTION,
            output_fields: ['leaseId', 'collectionName', 'ownerId', 'expiresAt', 'updatedAt'],
            limit: 16_384,
        });
        if (result.status?.error_code && result.status.error_code !== 'Success') {
            throw new Error(`Failed to read collection leases: ${result.status.reason || result.status.error_code}`);
        }
        return (result.data || [])
            .map((row: Record<string, any>) => this.parseLeaseRecord(row))
            .filter((record: CollectionLeaseRecord | null): record is CollectionLeaseRecord => record !== null);
    }

    private async deleteExpiredLeaseRecords(records: CollectionLeaseRecord[], expiresAt: number): Promise<void> {
        if (records.length === 0 || !this.client) {
            return;
        }
        const ids = records.map(record => JSON.stringify(record.leaseId)).join(', ');
        await this.client.delete({
            collection_name: COLLECTION_LEASE_COLLECTION,
            filter: `leaseId in [${ids}] && expiresAt <= ${expiresAt}`,
        });
    }

    async reapExpiredCollectionLeases(now: number = Date.now()): Promise<CollectionLeaseReapResult> {
        const records = await this.readCollectionLeaseRecords();
        const byCollection = new Map<string, CollectionLeaseRecord[]>();
        for (const record of records) {
            if (record.collectionName === COLLECTION_LEASE_COLLECTION) {
                continue;
            }
            const grouped = byCollection.get(record.collectionName) || [];
            grouped.push(record);
            byCollection.set(record.collectionName, grouped);
        }

        const result: CollectionLeaseReapResult = {
            releasedCollections: [],
            deletedLeaseRecords: 0,
        };
        for (const [collectionName, collectionRecords] of byCollection) {
            if (collectionRecords.some(record => record.expiresAt > now)) {
                continue;
            }

            const refreshed = await this.readCollectionLeaseRecords();
            const currentRecords = refreshed.filter(record => record.collectionName === collectionName);
            if (currentRecords.some(record => record.expiresAt > now)) {
                continue;
            }

            if (!this.client) {
                throw new Error('MilvusClient is not initialized after ensureInitialized().');
            }
            const exists = await this.client.hasCollection({ collection_name: collectionName });
            if (!exists.value) {
                await this.deleteExpiredLeaseRecords(currentRecords, now);
                result.deletedLeaseRecords += currentRecords.filter(record => record.expiresAt <= now).length;
                continue;
            }
            await this.client.releaseCollection({ collection_name: collectionName });
            await this.deleteExpiredLeaseRecords(currentRecords, now);
            result.releasedCollections.push(collectionName);
            result.deletedLeaseRecords += currentRecords.filter(record => record.expiresAt <= now).length;
        }
        return result;
    }

    /**
     * Ensure collection is loaded before search/query operations
     */
    protected async ensureLoaded(collectionName: string): Promise<void> {
        if (!this.client) {
            throw new Error('MilvusClient is not initialized. Call ensureInitialized() first.');
        }

        try {
            await this.upsertCollectionLease(collectionName);
            // Check if collection is loaded
            const result = await this.client.getLoadState({
                collection_name: collectionName
            });

            if (result.state !== LoadState.LoadStateLoaded) {
                console.log(`[MilvusDB] 🔄 Loading collection '${collectionName}' to memory...`);
                await this.client.loadCollection({
                    collection_name: collectionName,
                });
            }
        } catch (error) {
            console.error(`[MilvusDB] ❌ Failed to ensure collection '${collectionName}' is loaded:`, error);
            throw error;
        }
    }

    private isCollectionReleasedError(error: unknown): boolean {
        const message = formatErrorDetails(error);
        return /collection.*(not loaded|not load)|collection.*(released|release)|load state.*not.*loaded/i.test(message);
    }

    private async runWithCollectionLoadRetry<T>(
        collectionName: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        await this.ensureLoaded(collectionName);
        try {
            return await operation();
        } catch (error) {
            if (!this.isCollectionReleasedError(error)) {
                throw error;
            }
            console.warn(`[MilvusDB] Collection '${collectionName}' was released while handling a request; loading it once more.`);
            await this.ensureLoaded(collectionName);
            return operation();
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

    private async insertRowsWithRecovery(
        collectionName: string,
        data: Array<ReturnType<typeof createInsertRow>>,
        options: InsertOptions,
        operation: 'Milvus insert' | 'Milvus insertHybrid',
    ): Promise<void> {
        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        await withMilvusConnectionRetry(
            `${operation} for '${collectionName}'`,
            async (attempt) => {
                if (!this.client) {
                    throw new Error('MilvusClient is not initialized after ensureInitialized().');
                }
                const request = {
                    collection_name: collectionName,
                    data,
                };
                // A transport failure may arrive after Milvus accepted the
                // first insert. Replays therefore use primary-key upsert.
                if (options.upsert || attempt > 1) {
                    await this.client.upsert(request);
                } else {
                    await this.client.insert(request);
                }
            },
            {
                onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
                    console.warn(
                        `[MilvusDB] ${operation} lost its connection; retrying ` +
                        `(attempt ${attempt + 1}/${maxAttempts}) in ${delayMs}ms: ` +
                        `${error instanceof Error ? error.message : String(error)}`,
                    );
                },
            },
        );
    }

    /**
     * Wait for an index to be ready before proceeding
     * Polls index build progress with exponential backoff up to 60 seconds
     */
    protected async waitForIndexReady(
        collectionName: string,
        fieldName: string,
        maxWaitTime: number = 60000, // 60 seconds
        initialInterval: number = 500, // 500ms
        maxInterval: number = 5000, // 5 seconds
        backoffMultiplier: number = 1.5
    ): Promise<void> {
        if (!this.client) {
            throw new Error('MilvusClient is not initialized. Call ensureInitialized() first.');
        }

        let interval = initialInterval;
        const startTime = Date.now();

        console.log(`[MilvusDB] ⏳ Waiting for index on field '${fieldName}' in collection '${collectionName}' to be ready...`);

        while (Date.now() - startTime < maxWaitTime) {
            try {
                const indexBuildProgress = await this.client.getIndexBuildProgress({
                    collection_name: collectionName,
                    field_name: fieldName
                });

                // Debug logging to understand the progress
                console.log(`[MilvusDB] 📊 Index build progress for '${fieldName}': indexed_rows=${indexBuildProgress.indexed_rows}, total_rows=${indexBuildProgress.total_rows}`);
                console.log(`[MilvusDB] 📊 Full response:`, JSON.stringify(indexBuildProgress));

                // Check if index building is complete
                if (indexBuildProgress.indexed_rows === indexBuildProgress.total_rows) {
                    console.log(`[MilvusDB] ✅ Index on field '${fieldName}' is ready! (${indexBuildProgress.indexed_rows}/${indexBuildProgress.total_rows} rows indexed)`);
                    return;
                }

                // Check for error status
                if (indexBuildProgress.status && indexBuildProgress.status.error_code !== 'Success') {
                    // Handle known issue with older Milvus versions where sparse vector index progress returns incorrect error
                    if (indexBuildProgress.status.reason && indexBuildProgress.status.reason.includes('index duplicates[indexName=]')) {
                        console.log(`[MilvusDB] ⚠️  Index progress check returned known older Milvus issue: ${indexBuildProgress.status.reason}`);
                        console.log(`[MilvusDB] ⚠️  This is a known issue with older Milvus versions - treating as index ready`);
                        return; // Treat as ready since this is a false error
                    }
                    throw new Error(`Index creation failed for field '${fieldName}' in collection '${collectionName}': ${indexBuildProgress.status.reason}`);
                }

                console.log(`[MilvusDB] 📊 Index building in progress: ${indexBuildProgress.indexed_rows}/${indexBuildProgress.total_rows} rows indexed`);

                // Wait with exponential backoff
                await new Promise(resolve => setTimeout(resolve, interval));
                interval = Math.min(interval * backoffMultiplier, maxInterval);

            } catch (error) {
                console.error(`[MilvusDB] ❌ Error checking index build progress for field '${fieldName}':`, error);
                throw error;
            }
        }

        throw new Error(`Timeout waiting for index on field '${fieldName}' in collection '${collectionName}' to be ready after ${maxWaitTime}ms`);
    }

    /**
     * Load collection with retry logic and exponential backoff
     * Retries up to 5 times with exponential backoff
     */
    protected async loadCollectionWithRetry(
        collectionName: string,
        maxRetries: number = 5,
        initialInterval: number = 1000, // 1 second
        backoffMultiplier: number = 2
    ): Promise<void> {
        if (!this.client) {
            throw new Error('MilvusClient is not initialized. Call ensureInitialized() first.');
        }

        await this.upsertCollectionLease(collectionName);

        let attempt = 1;
        let interval = initialInterval;

        while (attempt <= maxRetries) {
            try {
                console.log(`[MilvusDB] 🔄 Loading collection '${collectionName}' to memory (attempt ${attempt}/${maxRetries})...`);

                await this.client.loadCollection({
                    collection_name: collectionName,
                });

                console.log(`[MilvusDB] ✅ Collection '${collectionName}' loaded successfully!`);
                return;

            } catch (error) {
                console.error(`[MilvusDB] ❌ Failed to load collection '${collectionName}' on attempt ${attempt}:`, error);

                if (attempt === maxRetries) {
                    throw new Error(`Failed to load collection '${collectionName}' after ${maxRetries} attempts: ${error}`);
                }

                // Wait with exponential backoff before retry
                console.log(`[MilvusDB] ⏳ Retrying collection load in ${interval}ms...`);
                await new Promise(resolve => setTimeout(resolve, interval));
                interval *= backoffMultiplier;
                attempt++;
            }
        }
    }

    private getErrorMessage(error: unknown): string {
        return formatErrorDetails(error);
    }

    private async getIndexDescriptions(collectionName: string): Promise<any[]> {
        if (!this.client) {
            throw new Error('MilvusClient is not initialized. Call ensureInitialized() first.');
        }

        let result: any;
        try {
            result = await this.client.describeIndex({
                collection_name: collectionName,
            });
        } catch (error) {
            const message = this.getErrorMessage(error);
            if (/index.*not.*(exist|found)|no.*index/i.test(message)) {
                return [];
            }
            throw error;
        }

        if (result.status && result.status.error_code !== 'Success') {
            if (/index.*not.*(exist|found)|no.*index/i.test(result.status.reason || '')) {
                return [];
            }
            throw new Error(`Failed to describe indexes for collection '${collectionName}': ${result.status.reason}`);
        }

        return result.index_descriptions || [];
    }

    private async createIndexIfMissing(collectionName: string, fieldName: string, indexParams: any): Promise<void> {
        if (!this.client) {
            throw new Error('MilvusClient is not initialized. Call ensureInitialized() first.');
        }

        const indexDescriptions = await this.getIndexDescriptions(collectionName);
        const hasIndex = indexDescriptions.some((index: any) => index.field_name === fieldName || index.fieldName === fieldName);

        if (hasIndex) {
            console.log(`[MilvusDB] ✅ Index for field '${fieldName}' already exists in collection '${collectionName}'`);
            await this.waitForIndexReady(collectionName, fieldName);
            return;
        }

        console.log(`[MilvusDB] 🔧 Creating index for field '${fieldName}' in collection '${collectionName}'...`);
        try {
            await this.client.createIndex(indexParams);
        } catch (error) {
            const message = this.getErrorMessage(error);
            if (/index.*(exist|duplicate)|duplicate.*index/i.test(message)) {
                console.log(`[MilvusDB] ✅ Index for field '${fieldName}' already exists in collection '${collectionName}'`);
            } else {
                throw error;
            }
        }
        await this.waitForIndexReady(collectionName, fieldName);
    }

    async ensureHybridCollectionReady(collectionName: string): Promise<void> {
        await this.ensureInitialized();

        const denseIndexParams = {
            collection_name: collectionName,
            field_name: 'vector',
            index_name: 'vector_index',
            index_type: 'AUTOINDEX',
            metric_type: MetricType.COSINE,
        };

        const sparseIndexParams = {
            collection_name: collectionName,
            field_name: 'sparse_vector',
            index_name: 'sparse_vector_index',
            index_type: 'SPARSE_INVERTED_INDEX',
            metric_type: MetricType.BM25,
            params: {
                inverted_index_algo: 'DAAT_WAND',
            },
        };

        await this.createIndexIfMissing(collectionName, 'vector', denseIndexParams);
        await this.createIndexIfMissing(collectionName, 'sparse_vector', sparseIndexParams);
        await this.loadCollectionWithRetry(collectionName);
    }

    async createCollection(collectionName: string, dimension: number, description?: string): Promise<void> {
        await this.ensureInitialized();

        console.log('Beginning collection creation:', collectionName);
        console.log('Collection dimension:', dimension);
        const schema = [
            {
                name: 'id',
                description: 'Document ID',
                data_type: DataType.VarChar,
                max_length: 512,
                is_primary_key: true,
            },
            {
                name: 'vector',
                description: 'Embedding vector',
                data_type: DataType.FloatVector,
                dim: dimension,
            },
            {
                name: 'content',
                description: 'Document content',
                data_type: DataType.VarChar,
                max_length: 65535,
            },
            {
                name: 'relativePath',
                description: 'Relative path to the codebase',
                data_type: DataType.VarChar,
                max_length: 1024,
            },
            {
                name: 'startLine',
                description: 'Start line number of the chunk',
                data_type: DataType.Int64,
            },
            {
                name: 'endLine',
                description: 'End line number of the chunk',
                data_type: DataType.Int64,
            },
            {
                name: 'fileExtension',
                description: 'File extension',
                data_type: DataType.VarChar,
                max_length: 32,
            },
            {
                name: 'metadata',
                description: 'Additional document metadata as JSON string',
                data_type: DataType.VarChar,
                max_length: 65535,
            },
            ...createStructuredFieldSchemas(),
        ];

        const createCollectionParams = {
            collection_name: collectionName,
            description: description || `Hitmux Context Engine collection: ${collectionName}`,
            fields: schema,
            timeout: COLLECTION_CREATE_TIMEOUT_MS,
        };

        if (!this.client) {
            throw new Error('MilvusClient is not initialized. Call ensureInitialized() first.');
        }

        try {
            await this.client.createCollection(createCollectionParams);
        } catch (error) {
            throw milvusOperationError('Milvus createCollection', {
                collectionName,
                dimension,
                description: createCollectionParams.description,
            }, error);
        }

        // Create index
        const indexParams = {
            collection_name: collectionName,
            field_name: 'vector',
            index_name: 'vector_index',
            index_type: 'AUTOINDEX',
            metric_type: MetricType.COSINE,
        };

        console.log(`[MilvusDB] 🔧 Creating index for field 'vector' in collection '${collectionName}'...`);
        try {
            await this.client.createIndex(indexParams);
        } catch (error) {
            throw milvusOperationError('Milvus createIndex', {
                collectionName,
                fieldName: 'vector',
                indexName: 'vector_index',
            }, error);
        }

        // Wait for index to be ready before loading collection
        await this.waitForIndexReady(collectionName, 'vector');

        // Load collection to memory with retry logic
        await this.loadCollectionWithRetry(collectionName);

        // Verify collection is created correctly
        try {
            await this.client.describeCollection({
                collection_name: collectionName,
            });
        } catch (error) {
            throw milvusOperationError('Milvus describeCollection', { collectionName }, error);
        }
    }

    async dropCollection(collectionName: string): Promise<void> {
        await this.ensureInitialized();

        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        await this.releaseCollectionLease(collectionName);
        await this.client.dropCollection({ collection_name: collectionName });
    }


    async hasCollection(collectionName: string): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        const result = await this.client.hasCollection({
            collection_name: collectionName,
        });

        return Boolean(result.value);
    }

    async listCollections(): Promise<string[]> {
        await this.ensureInitialized();

        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        const result = await this.client.showCollections();
        // Handle the response format - cast to any to avoid type errors
        const collections = (result as any).collection_names || (result as any).collections || [];
        return Array.isArray(collections) ? collections : [];
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
            console.warn(`[MilvusDB] Failed to delete previous index manifest '${documentId}', continuing with upsert insert:`, error);
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
        await this.upsertCollectionLease(collectionName);
        if (!options.deferFlushLoad) {
            await this.measureFlushLoad(() => this.ensureLoaded(collectionName));
        }

        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        console.log('Inserting documents into collection:', collectionName);
        const data = documents.map(createInsertRow);

        try {
            await this.insertRowsWithRecovery(collectionName, data, options, 'Milvus insert');
            if (!options.deferFlushLoad) {
                await this.measureFlushLoad(async () => {
                    await this.flushCollection(collectionName);
                    await this.ensureLoaded(collectionName);
                });
            }
        } catch (error) {
            throw milvusOperationError('Milvus insert', {
                collectionName,
                documentCount: documents.length,
            }, error);
        }
    }

    async search(collectionName: string, queryVector: number[], options?: SearchOptions): Promise<VectorSearchResult[]> {
        await this.ensureInitialized();
        return this.runWithCollectionLoadRetry(collectionName, async () => {
            if (!this.client) {
                throw new Error('MilvusClient is not initialized after ensureInitialized().');
            }

            await this.ensureCurrentStructuredSchema(collectionName);
            const searchParams: any = {
            collection_name: collectionName,
            data: [queryVector],
            limit: options?.topK || 10,
            output_fields: [...DEFAULT_SEARCH_OUTPUT_FIELDS],
        };

        // Apply boolean expression filter if provided (e.g., fileExtension in [".ts",".py"]) 
        if (options?.filterExpr && options.filterExpr.trim().length > 0) {
            searchParams.expr = options.filterExpr;
        }

            let searchResult: any;
            try {
                searchResult = await this.client.search(searchParams);
            } catch (error) {
                throw isMissingStructuredFieldError(error)
                    ? createSchemaMismatchError(collectionName, 'Milvus rejected one or more structured output fields.')
                    : error;
            }

            if (!searchResult.results || searchResult.results.length === 0) {
                return [];
            }

            return searchResult.results.map((result: any) => {
            let metadata = {};
            try {
                metadata = mergeStructuredMetadata(result, JSON.parse(result.metadata || '{}'), {
                    deriveContentMetadata: false,
                });
            } catch (error) {
                console.warn(`[MilvusDB] Failed to parse metadata for item ${result.id}:`, error);
            }

            return {
                document: {
                    id: result.id,
                    vector: queryVector,
                    content: result.content,
                    relativePath: result.relativePath,
                    startLine: result.startLine,
                    endLine: result.endLine,
                    fileExtension: result.fileExtension,
                    metadata,
                    ...getStructuredDocumentFields(result),
                },
                score: result.score,
            };
            });
        });
    }

    async delete(collectionName: string, ids: string[]): Promise<void> {
        await this.ensureInitialized();
        await this.runWithCollectionLoadRetry(collectionName, async () => {
            if (!this.client) {
                throw new Error('MilvusClient is not initialized after ensureInitialized().');
            }
            await this.client.delete({
                collection_name: collectionName,
                filter: `id in [${ids.map(id => `"${id}"`).join(', ')}]`,
            });
        });
    }

    async query(collectionName: string, filter: string, outputFields: string[], limit?: number): Promise<Record<string, any>[]> {
        await this.ensureInitialized();
        return this.runWithCollectionLoadRetry(collectionName, async () => {
            if (!this.client) {
                throw new Error('MilvusClient is not initialized after ensureInitialized().');
            }
            try {
            const requestedOutputFields = outputFields;
            const hydrationOutputFields = getMetadataHydrationOutputFields(requestedOutputFields);
            const queryParams: any = {
                collection_name: collectionName,
                output_fields: hydrationOutputFields,
            };

            // Only include filter if it's a non-empty, non-whitespace string
            // An empty string filter is falsy in JS and causes Milvus SDK to return empty results
            if (filter && filter.trim() !== '') {
                queryParams.filter = filter;
            }

            // Add limit if provided, or default when no filter is specified
            if (limit !== undefined) {
                queryParams.limit = limit;
            } else if (!filter || filter.trim() === '') {
                // Milvus requires limit when no filter expression is provided
                queryParams.limit = 16384; // Default limit for unfiltered queries
            }

            let result: any;
            try {
                result = await this.client.query(queryParams);
            } catch (error) {
                if (hydrationOutputFields.length !== requestedOutputFields.length && isMissingStructuredFieldError(error)) {
                    result = await this.client.query({
                        ...queryParams,
                        output_fields: requestedOutputFields,
                    });
                } else {
                    throw error;
                }
            }

            if (result.status.error_code !== 'Success') {
                throw new Error(`Failed to query Milvus: ${result.status.reason}`);
            }

            return hydrateSlimMetadataRows(result.data || [], outputFields);
            } catch (error) {
                console.error(`[MilvusDB] ❌ Failed to query collection '${collectionName}':`, error);
                throw error;
            }
        });
    }

    async createHybridCollection(collectionName: string, dimension: number, description?: string): Promise<void> {
        await this.ensureInitialized();

        console.log('Beginning hybrid collection creation:', collectionName);
        console.log('Collection dimension:', dimension);

        const schema = [
            {
                name: 'id',
                description: 'Document ID',
                data_type: DataType.VarChar,
                max_length: 512,
                is_primary_key: true,
            },
            {
                name: 'content',
                description: 'Full text content for BM25 and storage',
                data_type: DataType.VarChar,
                max_length: 65535,
                enable_analyzer: true,
            },
            {
                name: 'vector',
                description: 'Dense vector embedding',
                data_type: DataType.FloatVector,
                dim: dimension,
            },
            {
                name: 'sparse_vector',
                description: 'Sparse vector embedding from BM25',
                data_type: DataType.SparseFloatVector,
            },
            {
                name: 'relativePath',
                description: 'Relative path to the codebase',
                data_type: DataType.VarChar,
                max_length: 1024,
            },
            {
                name: 'startLine',
                description: 'Start line number of the chunk',
                data_type: DataType.Int64,
            },
            {
                name: 'endLine',
                description: 'End line number of the chunk',
                data_type: DataType.Int64,
            },
            {
                name: 'fileExtension',
                description: 'File extension',
                data_type: DataType.VarChar,
                max_length: 32,
            },
            {
                name: 'metadata',
                description: 'Additional document metadata as JSON string',
                data_type: DataType.VarChar,
                max_length: 65535,
            },
            ...createStructuredFieldSchemas(),
        ];

        // Add BM25 function
        const functions = [
            {
                name: "content_bm25_emb",
                description: "content bm25 function",
                type: FunctionType.BM25,
                input_field_names: ["content"],
                output_field_names: ["sparse_vector"],
                params: {},
            },
        ];

        const createCollectionParams = {
            collection_name: collectionName,
            description: description || `Hybrid code context collection: ${collectionName}`,
            fields: schema,
            functions: functions,
            timeout: COLLECTION_CREATE_TIMEOUT_MS,
        };

        if (!this.client) {
            throw new Error('MilvusClient is not initialized. Call ensureInitialized() first.');
        }

        try {
            await this.client.createCollection(createCollectionParams);
        } catch (error) {
            if (isUnsupportedSparseVectorError(error)) {
                throw milvusHybridCompatibilityError('Milvus createHybridCollection', error);
            }
            throw milvusOperationError('Milvus createHybridCollection', {
                collectionName,
                dimension,
                description: createCollectionParams.description,
            }, error);
        }

        await this.ensureHybridCollectionReady(collectionName);

        // Verify collection is created correctly
        try {
            await this.client.describeCollection({
                collection_name: collectionName,
            });
        } catch (error) {
            throw milvusOperationError('Milvus describeHybridCollection', { collectionName }, error);
        }
    }

    async insertHybrid(collectionName: string, documents: VectorDocument[], options: InsertOptions = {}): Promise<void> {
        await this.ensureInitialized();
        await this.upsertCollectionLease(collectionName);
        if (!options.deferFlushLoad) {
            await this.measureFlushLoad(() => this.ensureLoaded(collectionName));
        }

        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        const data = documents.map(createInsertRow);

        try {
            await this.insertRowsWithRecovery(collectionName, data, options, 'Milvus insertHybrid');
            if (!options.deferFlushLoad) {
                await this.measureFlushLoad(async () => {
                    await this.flushCollection(collectionName);
                    await this.ensureLoaded(collectionName);
                });
            }
        } catch (error) {
            throw milvusOperationError('Milvus insertHybrid', {
                collectionName,
                documentCount: documents.length,
            }, error);
        }
    }

    async finalizeCollectionWrites(collectionName: string): Promise<void> {
        await this.ensureInitialized();
        await this.upsertCollectionLease(collectionName);
        await withMilvusConnectionRetry(
            `Milvus finalize writes for '${collectionName}'`,
            async () => this.measureFlushLoad(async () => {
                await this.flushCollection(collectionName);
                await this.ensureLoaded(collectionName);
            }),
            {
                onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
                    console.warn(
                        `[MilvusDB] Finalizing '${collectionName}' lost its connection; retrying ` +
                        `(attempt ${attempt + 1}/${maxAttempts}) in ${delayMs}ms: ` +
                        `${error instanceof Error ? error.message : String(error)}`,
                    );
                },
            },
        );
    }

    private async flushCollection(collectionName: string): Promise<void> {
        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        const result = await this.client.flushSync({
            collection_names: [collectionName],
        });

        if (result.status && result.status.error_code !== 'Success') {
            throw new Error(`Flush failed for collection '${collectionName}': ${result.status.reason || result.status.error_code}`);
        }
    }

    async hybridSearch(collectionName: string, searchRequests: HybridSearchRequest[], options?: HybridSearchOptions): Promise<HybridSearchResult[]> {
        await this.ensureInitialized();
        return this.runWithCollectionLoadRetry(collectionName, async () => {
            if (!this.client) {
                throw new Error('MilvusClient is not initialized after ensureInitialized().');
            }

            try {
            // Generate OpenAI embedding for the first search request (dense)
            console.log(`[MilvusDB] 🔍 Preparing hybrid search for collection: ${collectionName}`);

            // Prepare search requests in the correct Milvus format
            const search_param_1 = {
                data: Array.isArray(searchRequests[0].data) ? searchRequests[0].data : [searchRequests[0].data],
                anns_field: searchRequests[0].anns_field, // "vector"
                param: searchRequests[0].param, // {"nprobe": 10}
                limit: searchRequests[0].limit
            };

            const search_param_2 = {
                data: searchRequests[1].data, // query text for sparse search
                anns_field: searchRequests[1].anns_field, // "sparse_vector"
                param: searchRequests[1].param, // {"drop_ratio_search": 0.2}
                limit: searchRequests[1].limit
            };

            // Set rerank strategy to RRF (100) by default
            const rerank_strategy = {
                strategy: "rrf",
                params: {
                    k: 100
                }
            };

            console.log(`[MilvusDB] 🔍 Dense search params:`, JSON.stringify({
                anns_field: search_param_1.anns_field,
                param: search_param_1.param,
                limit: search_param_1.limit,
                data_length: Array.isArray(search_param_1.data[0]) ? search_param_1.data[0].length : 'N/A'
            }, null, 2));
            console.log(`[MilvusDB] 🔍 Sparse search params:`, JSON.stringify({
                anns_field: search_param_2.anns_field,
                param: search_param_2.param,
                limit: search_param_2.limit,
                query_text: typeof search_param_2.data === 'string' ? search_param_2.data.substring(0, 50) + '...' : 'N/A'
            }, null, 2));
            console.log(`[MilvusDB] 🔍 Rerank strategy:`, JSON.stringify(rerank_strategy, null, 2));

            // Execute hybrid search using the correct client.search format
            await this.ensureCurrentStructuredSchema(collectionName);
            const searchParams: any = {
                collection_name: collectionName,
                data: [search_param_1, search_param_2],
                limit: options?.limit || searchRequests[0]?.limit || 10,
                rerank: rerank_strategy,
                output_fields: [...DEFAULT_SEARCH_OUTPUT_FIELDS],
            };

            if (options?.filterExpr && options.filterExpr.trim().length > 0) {
                searchParams.expr = options.filterExpr;
            }

            console.log(`[MilvusDB] 🔍 Complete search request:`, JSON.stringify({
                collection_name: searchParams.collection_name,
                data_count: searchParams.data.length,
                limit: searchParams.limit,
                rerank: searchParams.rerank,
                output_fields: searchParams.output_fields,
                expr: searchParams.expr
            }, null, 2));

            let searchResult: any;
            try {
                searchResult = await this.client.search(searchParams);
            } catch (error) {
                throw isMissingStructuredFieldError(error)
                    ? createSchemaMismatchError(collectionName, 'Milvus rejected one or more structured output fields.')
                    : error;
            }

            console.log(`[MilvusDB] 🔍 Search executed, processing results...`);

            if (!searchResult.results || searchResult.results.length === 0) {
                console.log(`[MilvusDB] ⚠️  No results returned from Milvus search`);
                return [];
            }

            console.log(`[MilvusDB] ✅ Found ${searchResult.results.length} results from hybrid search`);

            // Transform results to HybridSearchResult format
            return searchResult.results.map((result: any) => {
                let metadata = {};
                try {
                    metadata = mergeStructuredMetadata(result, JSON.parse(result.metadata || '{}'), {
                        deriveContentMetadata: false,
                    });
                } catch (error) {
                    console.warn(`[MilvusDB] Failed to parse metadata for item ${result.id}:`, error);
                }

                return {
                    document: {
                        id: result.id,
                        content: result.content,
                        vector: [],
                        sparse_vector: [],
                        relativePath: result.relativePath,
                        startLine: result.startLine,
                        endLine: result.endLine,
                        fileExtension: result.fileExtension,
                        metadata,
                        ...getStructuredDocumentFields(result),
                    },
                    score: result.score,
                };
            });

            } catch (error) {
                console.error(`[MilvusDB] ❌ Failed to perform hybrid search on collection '${collectionName}':`, error);
                throw error;
            }
        });
    }

    async getCollectionDescription(collectionName: string): Promise<string> {
        await this.ensureInitialized();

        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }

        const result = await this.client.describeCollection({
            collection_name: collectionName,
        });

        return (result as any).schema?.description || '';
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
     * Wrapper method to handle collection creation with limit detection for gRPC client
     * Returns true if collection can be created, false if limit exceeded
     */
    async checkCollectionLimit(): Promise<boolean> {
        if (!this.client) {
            throw new Error('MilvusClient is not initialized. Call ensureInitialized() first.');
        }

        const configuredTimeoutMs = configManager.getNumber('milvusCollectionLimitCheckTimeoutMs');
        const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs! > 0 ? configuredTimeoutMs! : 15000;
        const collectionName = `dummy_collection_${Date.now()}`;
        const createCollectionParams = {
            collection_name: collectionName,
            description: 'Test collection for limit check',
            fields: [
                {
                    name: 'id',
                    data_type: DataType.VarChar,
                    max_length: 512,
                    is_primary_key: true,
                },
                {
                    name: 'vector',
                    data_type: DataType.FloatVector,
                    dim: 128,
                }
            ]
        };

        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
            const createPromise = this.client.createCollection(createCollectionParams);
            // Best-effort late cleanup ONLY if the timeout fires first. Gated by `timedOut`
            // so we do not race the normal-path drop below on fast successes.
            void createPromise
                .then(async () => {
                    if (!timedOut) return;
                    try {
                        if (!this.client) return;
                        if (await this.client.hasCollection({ collection_name: collectionName })) {
                            await this.client.dropCollection({
                                collection_name: collectionName,
                            });
                        }
                    } catch {
                        // Best effort only: orphan cleanup is not user-visible.
                    }
                })
                .catch(() => {
                    // createCollection failed; nothing to clean up.
                });

            await Promise.race([
                createPromise,
                new Promise<never>((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        timedOut = true;
                        reject(new Error(`checkCollectionLimit timeout after ${timeoutMs}ms`));
                    }, timeoutMs);
                }),
            ]);
            // Immediately drop the collection after successful creation
            if (await this.client.hasCollection({ collection_name: collectionName })) {
                await this.client.dropCollection({
                    collection_name: collectionName,
                });
            }
            return true;
        } catch (error: any) {
            // Check if the error message contains the collection limit exceeded pattern
            const errorMessage = error.message || error.toString() || '';
            if (/exceeded the limit number of collections/i.test(errorMessage)) {
                // Return false for collection limit exceeded
                return false;
            }
            if (/deadline_exceeded|deadline exceeded|timeout/i.test(errorMessage)) {
                console.warn(
                    `[MilvusDB] checkCollectionLimit timed out after ${timeoutMs}ms; proceeding without limit pre-check. ` +
                    'Set milvusCollectionLimitCheckTimeoutMs in ~/.hitmux-context-engine/config.conf to increase timeout.'
                );
                return true;
            }
            // Re-throw other errors as-is
            throw error;
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    /**
     * Get the number of entities (rows) in a collection.
     * Returns -1 on any failure (collection missing, RPC error, malformed response).
     * -1 means "unknown" — callers must NOT treat it as "empty".
     *
     * Uses count(*) via query() rather than getCollectionStatistics(): stats are
     * computed from sealed segments and lag recent inserts (returning 0 for a
     * freshly-indexed but unflushed collection), while count(*) reads the real
     * current state. A stale 0 would fool recovery into thinking the collection
     * is truly empty and cause Issue #295-style false-negative "not indexed"
     * errors even when data exists.
     */
    async getCollectionRowCount(collectionName: string): Promise<number> {
        await this.ensureInitialized();
        if (!this.client) return -1;
        try {
            const hasCol = await this.client.hasCollection({ collection_name: collectionName });
            if (!hasCol.value) return -1;

            // count(*) requires the collection to be loaded.
            await this.ensureLoaded(collectionName);

            const result = await this.client.query({
                collection_name: collectionName,
                output_fields: ['count(*)'],
            });
            if (result.status.error_code !== 'Success') {
                console.warn(`[MilvusDB] count(*) query failed for '${collectionName}': ${result.status.reason}`);
                return -1;
            }

            // Shape observed: { data: [{ "count(*)": "<number-as-string>" }] }
            const row = result.data?.[0] as Record<string, any> | undefined;
            if (!row) return -1;
            const raw = row['count(*)'] ?? row['count'];
            if (raw === undefined || raw === null) return -1;
            const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
            return Number.isFinite(n) && n >= 0 ? n : -1;
        } catch (error) {
            console.error(`[MilvusDB] Error in count(*) query for '${collectionName}':`, error);
            return -1;
        }
    }

}
