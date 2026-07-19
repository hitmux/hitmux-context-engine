export const COLLECTION_LEASE_COLLECTION = 'hitmux_collection_leases';
export const DEFAULT_COLLECTION_LEASE_HEARTBEAT_MS = 30_000;
export const DEFAULT_COLLECTION_LEASE_MISS_LIMIT = 3;

export interface CollectionLeaseConfig {
    enabled?: boolean;
    heartbeatMs?: number;
    missLimit?: number;
}

export interface ResolvedCollectionLeaseConfig {
    enabled: boolean;
    heartbeatMs: number;
    missLimit: number;
    ttlMs: number;
}

export interface CollectionLeaseRecord {
    leaseId: string;
    collectionName: string;
    ownerId: string;
    expiresAt: number;
    updatedAt: number;
}

export interface CollectionLeaseReapResult {
    releasedCollections: string[];
    deletedLeaseRecords: number;
}

export function resolveCollectionLeaseConfig(config: CollectionLeaseConfig = {}): ResolvedCollectionLeaseConfig {
    const heartbeatMs = normalizePositiveInteger(
        config.heartbeatMs,
        DEFAULT_COLLECTION_LEASE_HEARTBEAT_MS,
    );
    const missLimit = normalizeMissLimit(config.missLimit);
    return {
        enabled: config.enabled !== false,
        heartbeatMs,
        missLimit,
        ttlMs: heartbeatMs * missLimit,
    };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
        ? value
        : fallback;
}

function normalizeMissLimit(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 2
        ? value
        : DEFAULT_COLLECTION_LEASE_MISS_LIMIT;
}
