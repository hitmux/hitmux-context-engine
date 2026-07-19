import { checkCollectionFields, DataType, LoadState, MetricType } from '@zilliz/milvus2-sdk-node';
import { MilvusVectorDatabase } from './milvus-vectordb';
import { COLLECTION_LEASE_COLLECTION } from './collection-lease';

function createDatabase(): MilvusVectorDatabase {
    const database = new MilvusVectorDatabase({
        address: 'localhost:19530',
        collectionLeaseHeartbeatMs: 30_000,
        collectionLeaseMissLimit: 3,
    });
    return database;
}

function createClient(overrides: Record<string, jest.Mock> = {}): Record<string, jest.Mock> {
    return {
        hasCollection: jest.fn(async () => ({ value: true })),
        createCollection: jest.fn(async () => ({ status: { error_code: 'Success' } })),
        getLoadState: jest.fn(async () => ({ state: LoadState.LoadStateLoaded })),
        loadCollection: jest.fn(async () => ({ status: { error_code: 'Success' } })),
        upsert: jest.fn(async () => ({ status: { error_code: 'Success' } })),
        delete: jest.fn(async () => ({ status: { error_code: 'Success' } })),
        query: jest.fn(async () => ({ status: { error_code: 'Success' }, data: [] })),
        releaseCollection: jest.fn(async () => ({ status: { error_code: 'Success' } })),
        describeIndex: jest.fn(async () => ({ status: { error_code: 'Success' }, index_descriptions: [] })),
        createIndex: jest.fn(async () => ({ status: { error_code: 'Success' } })),
        getIndexBuildProgress: jest.fn(async () => ({
            status: { error_code: 'Success' },
            indexed_rows: 0,
            total_rows: 0,
        })),
        describeCollection: jest.fn(async () => ({
            schema: {
                description: '',
                fields: [{
                    name: 'leaseVector',
                    data_type: 'FloatVector',
                    dataType: DataType.FloatVector,
                    dim: 2,
                }],
            },
        })),
        search: jest.fn(async () => ({ results: [] })),
        ...overrides,
    };
}

async function useClient(database: MilvusVectorDatabase, client: Record<string, jest.Mock>): Promise<void> {
    await (database as any).ensureInitialized();
    (database as any).client = client;
}

describe('Milvus collection leases', () => {
    it('creates and upserts a lease before loading a collection, then deletes it on close', async () => {
        const client = createClient({
            hasCollection: jest.fn(async ({ collection_name }: { collection_name: string }) => ({
                value: collection_name !== COLLECTION_LEASE_COLLECTION,
            })),
        });
        const database = createDatabase();
        await useClient(database, client);

        await (database as any).ensureLoaded('code_chunks');

        expect(client.createCollection).toHaveBeenCalledWith(expect.objectContaining({
            collection_name: COLLECTION_LEASE_COLLECTION,
        }));
        const createRequest = client.createCollection.mock.calls[0][0];
        expect(createRequest.fields).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'leaseVector',
                data_type: DataType.FloatVector,
                dim: 2,
            }),
        ]));
        expect(checkCollectionFields(createRequest.fields)).toBe(true);
        expect(client.createIndex).toHaveBeenCalledWith(expect.objectContaining({
            collection_name: COLLECTION_LEASE_COLLECTION,
            field_name: 'leaseVector',
            index_name: 'lease_vector_index',
            index_type: 'AUTOINDEX',
            metric_type: MetricType.L2,
        }));
        expect(client.upsert).toHaveBeenCalledWith(expect.objectContaining({
            collection_name: COLLECTION_LEASE_COLLECTION,
            data: [expect.objectContaining({
                collectionName: 'code_chunks',
                expiresAt: expect.any(Number),
                updatedAt: expect.any(Number),
                leaseVector: [0, 0],
            })],
        }));
        expect(client.loadCollection).not.toHaveBeenCalledWith({ collection_name: COLLECTION_LEASE_COLLECTION });

        await database.close();
        expect(client.delete).toHaveBeenCalledWith(expect.objectContaining({
            collection_name: COLLECTION_LEASE_COLLECTION,
            filter: expect.stringContaining('leaseId =='),
        }));
        expect(client.delete.mock.calls[0][0].filter).not.toContain('leaseVector');
    });

    it('refreshes every held collection and removes the runtime lease before drop', async () => {
        const client = createClient();
        const database = createDatabase();
        await useClient(database, client);
        await (database as any).ensureLoaded('first');
        await (database as any).ensureLoaded('second');
        client.upsert.mockClear();

        await (database as any).refreshCollectionLeases();
        expect(client.upsert).toHaveBeenCalledTimes(2);
        for (const [request] of client.upsert.mock.calls) {
            expect(request.data[0]).toEqual(expect.objectContaining({ leaseVector: [0, 0] }));
        }

        client.dropCollection = jest.fn(async () => ({ status: { error_code: 'Success' } }));
        await database.dropCollection('first');
        expect(client.delete).toHaveBeenCalledWith(expect.objectContaining({
            collection_name: COLLECTION_LEASE_COLLECTION,
        }));
        expect(client.dropCollection).toHaveBeenCalledWith({ collection_name: 'first' });
        await database.close();
    });

    it('keeps a collection loaded while any owner lease is valid', async () => {
        const now = Date.now();
        const client = createClient({
            query: jest.fn(async () => ({
                status: { error_code: 'Success' },
                data: [
                    {
                        leaseId: 'expired-owner:code_chunks',
                        collectionName: 'code_chunks',
                        ownerId: 'expired-owner',
                        expiresAt: now - 1,
                        updatedAt: now - 2,
                    },
                    {
                        leaseId: 'live-owner:code_chunks',
                        collectionName: 'code_chunks',
                        ownerId: 'live-owner',
                        expiresAt: now + 1,
                        updatedAt: now,
                    },
                ],
            })),
        });
        const database = createDatabase();
        await useClient(database, client);

        await expect(database.reapExpiredCollectionLeases(now)).resolves.toEqual({
            releasedCollections: [],
            deletedLeaseRecords: 0,
        });
        expect(client.releaseCollection).not.toHaveBeenCalled();
        expect(client.delete).not.toHaveBeenCalled();
        await database.close();
    });

    it('releases once all leases expired and preserves records when release fails', async () => {
        const now = Date.now();
        const expiredRows = [{
            leaseId: 'dead-owner:code_chunks',
            collectionName: 'code_chunks',
            ownerId: 'dead-owner',
            expiresAt: now - 1,
            updatedAt: now - 2,
        }];
        const client = createClient({
            query: jest.fn(async () => ({
                status: { error_code: 'Success' },
                data: expiredRows,
            })),
        });
        const database = createDatabase();
        await useClient(database, client);

        await expect(database.reapExpiredCollectionLeases(now)).resolves.toEqual({
            releasedCollections: ['code_chunks'],
            deletedLeaseRecords: 1,
        });
        expect(client.releaseCollection).toHaveBeenCalledTimes(1);
        expect(client.delete).toHaveBeenCalledWith(expect.objectContaining({
            filter: expect.stringContaining('expiresAt <='),
        }));
        expect(client.query).toHaveBeenCalledWith(expect.objectContaining({
            output_fields: expect.not.arrayContaining(['leaseVector']),
        }));
        expect(client.delete.mock.calls[0][0].filter).not.toContain('leaseVector');

        client.releaseCollection.mockRejectedValueOnce(new Error('Milvus unavailable'));
        client.delete.mockClear();
        await expect(database.reapExpiredCollectionLeases(now)).rejects.toThrow('Milvus unavailable');
        expect(client.delete).not.toHaveBeenCalled();
        await database.close();
    });

    it('rejects a legacy scalar-only lease control collection without deleting it', async () => {
        const client = createClient({
            describeCollection: jest.fn(async () => ({
                schema: {
                    fields: [{ name: 'leaseId', dataType: DataType.VarChar }],
                },
            })),
        });
        const database = createDatabase();
        await useClient(database, client);

        await expect((database as any).ensureLoaded('code_chunks')).rejects.toThrow(
            "Collection lease control collection 'hitmux_collection_leases' has an incompatible legacy scalar-only schema"
        );
        expect(client.delete).not.toHaveBeenCalled();
        await database.close();
    });

    it('loads once more and retries a query if a concurrent release makes it unavailable', async () => {
        const client = createClient({
            query: jest
                .fn()
                .mockRejectedValueOnce(new Error('collection is not loaded'))
                .mockResolvedValueOnce({ status: { error_code: 'Success' }, data: [] }),
        });
        const database = createDatabase();
        await useClient(database, client);
        (database as any).ensureCurrentStructuredSchema = jest.fn(async () => undefined);

        await expect(database.query('code_chunks', '', ['id'])).resolves.toEqual([]);
        expect(client.query).toHaveBeenCalledTimes(2);
        expect(client.getLoadState).toHaveBeenCalledWith({ collection_name: 'code_chunks' });
        await database.close();
    });
});
