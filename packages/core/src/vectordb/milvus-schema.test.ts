import { MilvusRestfulVectorDatabase } from './milvus-restful-vectordb';
import { MilvusVectorDatabase } from './milvus-vectordb';
import { DEFAULT_SEARCH_OUTPUT_FIELDS, STRUCTURED_METADATA_FIELDS } from './types';

function createDescription(schemaVersion: number, metadataVersion: number): string {
    return [
        'codebasePath:/repo',
        `hitmuxContext:${JSON.stringify({
            version: 1,
            codebasePath: '/repo',
            embedding: {
                provider: 'test',
                model: 'model',
                dimension: 3,
            },
            schemaVersion,
            metadataVersion,
            splitterType: 'ast',
            createdAt: '2026-06-12T00:00:00.000Z',
        })}`,
    ].join('\n');
}

describe('Milvus structured metadata schema', () => {
    it('adds structured metadata fields to gRPC regular and hybrid collections', async () => {
        const database = Object.create(MilvusVectorDatabase.prototype) as MilvusVectorDatabase;
        const createCollection = jest.fn().mockResolvedValue({});

        (database as any).initializationPromise = Promise.resolve();
        (database as any).verifiedStructuredSchemaCollections = new Set();
        (database as any).client = {
            createCollection,
            createIndex: jest.fn().mockResolvedValue({}),
            describeIndex: jest.fn().mockResolvedValue({ status: { error_code: 'Success' }, index_descriptions: [] }),
            getIndexBuildProgress: jest.fn().mockResolvedValue({
                indexed_rows: '0',
                total_rows: '0',
                status: { error_code: 'Success' },
            }),
            loadCollection: jest.fn().mockResolvedValue({}),
            describeCollection: jest.fn().mockResolvedValue({}),
        };

        await database.createCollection('regular_schema_test', 3, 'regular');
        await database.createHybridCollection('hybrid_schema_test', 3, 'hybrid');

        const regularFields = createCollection.mock.calls[0][0].fields.map((field: { name: string }) => field.name);
        const hybridFields = createCollection.mock.calls[1][0].fields.map((field: { name: string }) => field.name);

        expect(regularFields).toEqual(expect.arrayContaining([...STRUCTURED_METADATA_FIELDS]));
        expect(hybridFields).toEqual(expect.arrayContaining([...STRUCTURED_METADATA_FIELDS]));
    });

    it('adds structured metadata fields to REST regular and hybrid collections', async () => {
        const database = Object.create(MilvusRestfulVectorDatabase.prototype) as MilvusRestfulVectorDatabase;
        const createRequests: any[] = [];
        const makeRequest = jest.fn(async (endpoint: string, _method: string, data?: any) => {
            if (endpoint === '/collections/create') {
                createRequests.push(data);
            }
            if (endpoint === '/indexes/list') {
                return { code: 0, data: [] };
            }
            return { code: 0, data: { loadState: 'LoadStateLoaded' } };
        });

        (database as any).initializationPromise = Promise.resolve();
        (database as any).baseUrl = 'http://localhost:19530/v2/vectordb';
        (database as any).config = { database: 'default' };
        (database as any).verifiedStructuredSchemaCollections = new Set();
        (database as any).makeRequest = makeRequest;

        await database.createCollection('regular_schema_test', 3, 'regular');
        await database.createHybridCollection('hybrid_schema_test', 3, 'hybrid');

        const regularFields = createRequests[0].schema.fields.map((field: { fieldName: string }) => field.fieldName);
        const hybridFields = createRequests[1].schema.fields.map((field: { fieldName: string }) => field.fieldName);

        expect(regularFields).toEqual(expect.arrayContaining([...STRUCTURED_METADATA_FIELDS]));
        expect(hybridFields).toEqual(expect.arrayContaining([...STRUCTURED_METADATA_FIELDS]));
    });

    it('uses structured output fields when a gRPC collection description has schema v2', async () => {
        const database = Object.create(MilvusVectorDatabase.prototype) as MilvusVectorDatabase;
        const search = jest.fn().mockResolvedValue({ results: [] });

        (database as any).initializationPromise = Promise.resolve();
        (database as any).verifiedStructuredSchemaCollections = new Set();
        (database as any).client = {
            getLoadState: jest.fn().mockResolvedValue({ state: 3 }),
            loadCollection: jest.fn().mockResolvedValue({}),
            describeCollection: jest.fn().mockResolvedValue({ schema: { description: createDescription(2, 2) } }),
            search,
        };

        await database.search('schema_v2_test', [1, 0, 0], { topK: 5 });
        await database.hybridSearch('schema_v2_test', [
            { data: [1, 0, 0], anns_field: 'vector', param: {}, limit: 5 },
            { data: 'query', anns_field: 'sparse_vector', param: {}, limit: 5 },
        ], { limit: 5 });

        expect(search.mock.calls[0][0].output_fields).toEqual([...DEFAULT_SEARCH_OUTPUT_FIELDS]);
        expect(search.mock.calls[1][0].output_fields).toEqual([...DEFAULT_SEARCH_OUTPUT_FIELDS]);
    });

    it('rejects a gRPC collection description with schema v1', async () => {
        const database = Object.create(MilvusVectorDatabase.prototype) as MilvusVectorDatabase;
        const search = jest.fn().mockResolvedValue({ results: [] });

        (database as any).initializationPromise = Promise.resolve();
        (database as any).verifiedStructuredSchemaCollections = new Set();
        (database as any).client = {
            getLoadState: jest.fn().mockResolvedValue({ state: 3 }),
            loadCollection: jest.fn().mockResolvedValue({}),
            describeCollection: jest.fn().mockResolvedValue({ schema: { description: createDescription(1, 1) } }),
            search,
        };

        await expect(database.search('legacy_schema_test', [1, 0, 0], { topK: 5 })).rejects.toThrow('unsupported search schema');
        await expect(database.hybridSearch('legacy_schema_test', [
            { data: [1, 0, 0], anns_field: 'vector', param: {}, limit: 5 },
            { data: 'query', anns_field: 'sparse_vector', param: {}, limit: 5 },
        ], { limit: 5 })).rejects.toThrow('unsupported search schema');

        expect(search).not.toHaveBeenCalled();
    });

    it('uses structured output fields when a REST collection description has schema v2', async () => {
        const database = Object.create(MilvusRestfulVectorDatabase.prototype) as MilvusRestfulVectorDatabase;
        const requests: Array<{ endpoint: string; data?: any }> = [];
        const makeRequest = jest.fn(async (endpoint: string, _method: string, data?: any) => {
            requests.push({ endpoint, data });
            if (endpoint === '/collections/describe') {
                return { code: 0, data: { description: createDescription(2, 2) } };
            }
            return { code: 0, data: [] };
        });

        (database as any).initializationPromise = Promise.resolve();
        (database as any).baseUrl = 'http://localhost:19530/v2/vectordb';
        (database as any).config = { database: 'default' };
        (database as any).verifiedStructuredSchemaCollections = new Set();
        (database as any).makeRequest = makeRequest;

        await database.search('schema_v2_test', [1, 0, 0], { topK: 5 });
        await database.hybridSearch('schema_v2_test', [
            { data: [1, 0, 0], anns_field: 'vector', param: {}, limit: 5 },
            { data: 'query', anns_field: 'sparse_vector', param: {}, limit: 5 },
        ], { limit: 5 });

        const searchRequest = requests.find((request) => request.endpoint === '/entities/search');
        const hybridRequest = requests.find((request) => request.endpoint === '/entities/hybrid_search');

        expect(searchRequest?.data.outputFields).toEqual([...DEFAULT_SEARCH_OUTPUT_FIELDS]);
        expect(hybridRequest?.data.outputFields).toEqual([...DEFAULT_SEARCH_OUTPUT_FIELDS]);
    });

    it('rejects a REST collection description with schema v1', async () => {
        const database = Object.create(MilvusRestfulVectorDatabase.prototype) as MilvusRestfulVectorDatabase;
        const requests: Array<{ endpoint: string; data?: any }> = [];
        const makeRequest = jest.fn(async (endpoint: string, _method: string, data?: any) => {
            requests.push({ endpoint, data });
            if (endpoint === '/collections/describe') {
                return { code: 0, data: { description: createDescription(1, 1) } };
            }
            return { code: 0, data: [] };
        });

        (database as any).initializationPromise = Promise.resolve();
        (database as any).baseUrl = 'http://localhost:19530/v2/vectordb';
        (database as any).config = { database: 'default' };
        (database as any).verifiedStructuredSchemaCollections = new Set();
        (database as any).makeRequest = makeRequest;

        await expect(database.search('legacy_schema_test', [1, 0, 0], { topK: 5 })).rejects.toThrow('unsupported search schema');
        await expect(database.hybridSearch('legacy_schema_test', [
            { data: [1, 0, 0], anns_field: 'vector', param: {}, limit: 5 },
            { data: 'query', anns_field: 'sparse_vector', param: {}, limit: 5 },
        ], { limit: 5 })).rejects.toThrow('unsupported search schema');

        expect(requests.some((request) => request.endpoint === '/entities/search')).toBe(false);
        expect(requests.some((request) => request.endpoint === '/entities/hybrid_search')).toBe(false);
    });
});
