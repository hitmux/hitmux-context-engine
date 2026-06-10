import { MilvusVectorDatabase } from './milvus-vectordb';
import { MilvusRestfulVectorDatabase } from './milvus-restful-vectordb';

describe('Milvus hybrid index preparation', () => {
    it('creates a BM25 sparse vector index with the WAND algorithm through the SDK client', async () => {
        const database = Object.create(MilvusVectorDatabase.prototype) as MilvusVectorDatabase;
        const createIndex = jest.fn().mockResolvedValue({});

        (database as any).initializationPromise = Promise.resolve();
        (database as any).client = {
            describeIndex: jest.fn().mockResolvedValue({ status: { error_code: 'Success' }, index_descriptions: [] }),
            createIndex,
            getIndexBuildProgress: jest.fn().mockResolvedValue({
                indexed_rows: '0',
                total_rows: '0',
                status: { error_code: 'Success' },
            }),
            loadCollection: jest.fn().mockResolvedValue({}),
        };

        await database.ensureHybridCollectionReady('hybrid_code_chunks_test');

        expect(createIndex).toHaveBeenCalledWith(expect.objectContaining({
            collection_name: 'hybrid_code_chunks_test',
            field_name: 'sparse_vector',
            index_name: 'sparse_vector_index',
            index_type: 'SPARSE_INVERTED_INDEX',
            metric_type: 'BM25',
            params: { inverted_index_algo: 'DAAT_WAND' },
        }));
    });

    it('creates a BM25 sparse vector index with the WAND algorithm through the REST API', async () => {
        const database = Object.create(MilvusRestfulVectorDatabase.prototype) as MilvusRestfulVectorDatabase;
        const makeRequest = jest.fn(async (endpoint: string) => {
            if (endpoint === '/indexes/list') {
                return { data: [] };
            }
            return { code: 0, data: { loadState: 'LoadStateLoaded' } };
        });

        (database as any).initializationPromise = Promise.resolve();
        (database as any).baseUrl = 'http://localhost:19530/v2/vectordb';
        (database as any).config = { database: 'default' };
        (database as any).makeRequest = makeRequest;

        await database.ensureHybridCollectionReady('hybrid_code_chunks_test');

        expect(makeRequest).toHaveBeenCalledWith('/indexes/create', 'POST', expect.objectContaining({
            collectionName: 'hybrid_code_chunks_test',
            dbName: 'default',
            indexParams: [expect.objectContaining({
                fieldName: 'sparse_vector',
                indexName: 'sparse_vector_index',
                metricType: 'BM25',
                params: {
                    index_type: 'SPARSE_INVERTED_INDEX',
                    inverted_index_algo: 'DAAT_WAND',
                },
            })],
        }));
    });
});
