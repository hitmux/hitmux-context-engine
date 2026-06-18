import { MilvusRestfulVectorDatabase } from './milvus-restful-vectordb';
import { createStructuredInsertRow, hydrateSlimMetadataRows, mergeStructuredMetadata } from './milvus-structured-fields';
import { MilvusVectorDatabase } from './milvus-vectordb';
import { DEFAULT_SEARCH_OUTPUT_FIELDS, STRUCTURED_METADATA_FIELDS, VectorDocument } from './types';

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

function expectedMetadataHydrationOutputFields(outputFields: string[]): string[] {
    return [...new Set([
        ...outputFields,
        'content',
        'relativePath',
        'startLine',
        'endLine',
        ...STRUCTURED_METADATA_FIELDS,
    ])];
}

function createHydrationRow(overrides: Record<string, any> = {}): Record<string, any> {
    return {
        metadata: JSON.stringify({
            language: 'typescript',
            pathTokens: ['src', 'build', 'room'],
            symbols: ['buildRoom'],
            definitionIdentifiers: ['buildRoom'],
        }),
        content: 'export function buildRoom() {}',
        relativePath: 'src/buildRoom.ts',
        startLine: 10,
        endLine: 12,
        primarySymbol: 'buildRoom',
        symbolKind: 'function',
        chunkKind: 'function_definition',
        isDefinition: true,
        fileRole: 'implementation',
        basename: 'buildRoom',
        pathSegment0: 'src',
        pathSegment1: 'buildRoom.ts',
        pathSegment2: '',
        pathSegment3: '',
        pathSegment4: '',
        ...overrides,
    };
}

describe('Milvus structured metadata schema', () => {
    it('stores structured metadata fields only in dedicated row columns', () => {
        const document: VectorDocument = {
            id: 'chunk-1',
            vector: [1, 0, 0],
            content: 'export function buildRoom() {}',
            relativePath: 'src/buildRoom.ts',
            startLine: 10,
            endLine: 12,
            fileExtension: '.ts',
            primarySymbol: 'buildRoom',
            symbolKind: 'function',
            chunkKind: 'function_definition',
            isDefinition: true,
            fileRole: 'implementation',
            basename: 'buildRoom',
            pathSegment0: 'src',
            pathSegment1: 'buildRoom.ts',
            metadata: {
                language: 'typescript',
                fileName: 'buildRoom.ts',
                basename: 'buildRoom',
                pathTokens: ['src', 'build', 'room'],
                symbols: ['buildRoom'],
                definitionIdentifiers: ['buildRoom'],
                content: 'export function buildRoom() {}',
                relativePath: 'src/buildRoom.ts',
                startLine: 10,
                endLine: 12,
                fileExtension: '.ts',
                primarySymbol: 'buildRoom',
                symbolName: 'buildRoom',
                symbolKind: 'function',
                chunkKind: 'function_definition',
                chunkRole: 'definition',
                isDefinition: true,
                fileRole: 'implementation',
                pathSegment0: 'src',
                pathSegment1: 'buildRoom.ts',
                sourceStartLine: 10,
                sourceEndLine: 12,
                chunkIndex: 0,
            },
        };

        const row = createStructuredInsertRow(document);
        const storedMetadata = JSON.parse(row.metadata);

        expect(row).toMatchObject({
            primarySymbol: 'buildRoom',
            symbolKind: 'function',
            chunkKind: 'function_definition',
            isDefinition: true,
            fileRole: 'implementation',
            basename: 'buildRoom',
            pathSegment0: 'src',
            pathSegment1: 'buildRoom.ts',
        });
        for (const field of STRUCTURED_METADATA_FIELDS) {
            expect(storedMetadata).not.toHaveProperty(field);
        }
        for (const field of [
            'content',
            'relativePath',
            'startLine',
            'endLine',
            'fileExtension',
            'fileName',
            'pathTokens',
            'symbols',
            'definitionIdentifiers',
            'sourceStartLine',
            'sourceEndLine',
            'contentHash',
            'normalizedContentHash',
        ]) {
            expect(storedMetadata).not.toHaveProperty(field);
        }
        expect(storedMetadata).toMatchObject({
            language: 'typescript',
            symbolName: 'buildRoom',
            chunkRole: 'definition',
            chunkIndex: 0,
        });
    });

    it('restores slimmed structured metadata from row columns', () => {
        const metadata = mergeStructuredMetadata({
            content: 'export function buildRoom() {}',
            relativePath: 'src/buildRoom.ts',
            startLine: '10',
            endLine: '12',
            primarySymbol: 'buildRoom',
            symbolKind: 'function',
            chunkKind: 'function_definition',
            isDefinition: true,
            fileRole: 'implementation',
            basename: 'buildRoom',
            pathSegment0: 'src',
            pathSegment1: 'buildRoom.ts',
        }, {
            language: 'typescript',
            fileName: 'buildRoom.ts',
            pathTokens: ['src', 'build', 'room'],
            symbols: ['buildRoom'],
            definitionIdentifiers: ['buildRoom'],
        });

        expect(metadata).toMatchObject({
            language: 'typescript',
            fileName: 'buildRoom.ts',
            primarySymbol: 'buildRoom',
            symbolKind: 'function',
            chunkKind: 'function_definition',
            isDefinition: true,
            fileRole: 'implementation',
            basename: 'buildRoom',
            pathSegment0: 'src',
            pathSegment1: 'buildRoom.ts',
            sourceStartLine: 10,
            sourceEndLine: 12,
        });
        expect(metadata.contentHash).toMatch(/^[0-9a-f]{40}$/);
        expect(metadata.normalizedContentHash).toMatch(/^[0-9a-f]{40}$/);
    });

    it('restores slimmed content and path metadata from row fields', () => {
        const metadata = mergeStructuredMetadata({
            content: 'export function buildRoom() {}',
            relativePath: 'src/buildRoom.ts',
            fileExtension: '.ts',
            startLine: 10,
            endLine: 12,
            primarySymbol: 'buildRoom',
            symbolKind: 'function',
            chunkKind: 'function_definition',
            isDefinition: true,
            fileRole: 'implementation',
            basename: 'buildRoom',
        }, {
            language: 'typescript',
            symbolName: 'buildRoom',
            chunkRole: 'definition',
        });

        expect(metadata).toMatchObject({
            language: 'typescript',
            fileName: 'buildRoom.ts',
            fileExtension: '.ts',
            primarySymbol: 'buildRoom',
            symbolKind: 'function',
            chunkKind: 'function_definition',
            chunkRole: 'definition',
            isDefinition: true,
            sourceStartLine: 10,
            sourceEndLine: 12,
            pathTokens: ['src', 'buildRoom', 'ts'],
            symbols: ['buildRoom'],
            definitionIdentifiers: ['buildRoom'],
        });
        expect(metadata.contentHash).toMatch(/^[0-9a-f]{40}$/);
        expect(metadata.normalizedContentHash).toMatch(/^[0-9a-f]{40}$/);
    });

    it('hydrates query rows while preserving requested output fields', () => {
        const rows = hydrateSlimMetadataRows([createHydrationRow({
            startLine: '10',
            endLine: '12',
        })], ['metadata']);

        expect(rows[0]).toEqual({ metadata: expect.any(String) });
        expect(JSON.parse(rows[0].metadata)).toMatchObject({
            language: 'typescript',
            fileName: 'buildRoom.ts',
            primarySymbol: 'buildRoom',
            sourceStartLine: 10,
            sourceEndLine: 12,
            contentHash: expect.stringMatching(/^[0-9a-f]{40}$/),
            normalizedContentHash: expect.stringMatching(/^[0-9a-f]{40}$/),
        });
    });

    it('hydrates metadata and keeps other requested query fields', () => {
        const rows = hydrateSlimMetadataRows([createHydrationRow()], ['metadata', 'relativePath']);
        const metadata = JSON.parse(rows[0].metadata);

        expect(rows[0]).toEqual({
            metadata: expect.any(String),
            relativePath: 'src/buildRoom.ts',
        });
        expect(metadata).toMatchObject({
            language: 'typescript',
            fileName: 'buildRoom.ts',
            primarySymbol: 'buildRoom',
            symbolKind: 'function',
            sourceStartLine: 10,
            sourceEndLine: 12,
            pathTokens: ['src', 'build', 'room'],
            symbols: ['buildRoom'],
            definitionIdentifiers: ['buildRoom'],
        });
    });

    it('hydrates wildcard query metadata without trimming row fields', () => {
        const row = createHydrationRow();
        const rows = hydrateSlimMetadataRows([row], ['*']);

        expect(rows[0]).toMatchObject({
            metadata: expect.any(String),
            content: 'export function buildRoom() {}',
            relativePath: 'src/buildRoom.ts',
            primarySymbol: 'buildRoom',
        });
        expect(JSON.parse(rows[0].metadata)).toMatchObject({
            fileName: 'buildRoom.ts',
            primarySymbol: 'buildRoom',
            sourceStartLine: 10,
            sourceEndLine: 12,
        });
    });

    it('does not hydrate rows when metadata was not requested', () => {
        const row = createHydrationRow();
        const rows = hydrateSlimMetadataRows([row], ['id', 'relativePath']);

        expect(rows[0]).toBe(row);
        expect(JSON.parse(rows[0].metadata)).not.toHaveProperty('fileName');
    });

    it('hydrates object metadata without stringifying it', () => {
        const rows = hydrateSlimMetadataRows([createHydrationRow({
            metadata: {
                language: 'typescript',
                symbols: ['buildRoom'],
            },
        })], ['metadata']);

        expect(rows[0]).toEqual({ metadata: expect.any(Object) });
        expect(rows[0].metadata).toMatchObject({
            language: 'typescript',
            fileName: 'buildRoom.ts',
            primarySymbol: 'buildRoom',
            sourceStartLine: 10,
            sourceEndLine: 12,
        });
    });

    it('keeps invalid JSON metadata unchanged while trimming hydration-only fields', () => {
        const rows = hydrateSlimMetadataRows([createHydrationRow({
            metadata: '{invalid json',
        })], ['metadata']);

        expect(rows[0]).toEqual({ metadata: '{invalid json' });
    });

    it('hydrates legacy rows that do not contain structured metadata fields', () => {
        const rows = hydrateSlimMetadataRows([{
            metadata: JSON.stringify({ language: 'typescript' }),
            content: 'export function legacyRoom() {}',
            relativePath: 'src/legacyRoom.ts',
            startLine: 3,
            endLine: 4,
        }], ['metadata']);
        const metadata = JSON.parse(rows[0].metadata);

        expect(rows[0]).toEqual({ metadata: expect.any(String) });
        expect(metadata).toMatchObject({
            language: 'typescript',
            fileName: 'legacyRoom.ts',
            sourceStartLine: 3,
            sourceEndLine: 4,
        });
        expect(metadata).not.toHaveProperty('primarySymbol');
        expect(metadata).not.toHaveProperty('symbolKind');
    });

    it.each([
        ['number lines', 10, 12, 10, 12],
        ['string lines', '10', '12', 10, 12],
        ['zero number lines', 0, 0, undefined, undefined],
        ['zero string lines', '0', '0', undefined, undefined],
    ])('hydrates %s into derived source line metadata', (_label, startLine, endLine, expectedStartLine, expectedEndLine) => {
        const rows = hydrateSlimMetadataRows([createHydrationRow({ startLine, endLine })], ['metadata']);
        const metadata = JSON.parse(rows[0].metadata);

        expect(metadata.sourceStartLine).toBe(expectedStartLine);
        expect(metadata.sourceEndLine).toBe(expectedEndLine);
    });

    it.each([
        ['metadata only', ['metadata'], expectedMetadataHydrationOutputFields(['metadata'])],
        ['metadata and relativePath', ['metadata', 'relativePath'], expectedMetadataHydrationOutputFields(['metadata', 'relativePath'])],
        ['wildcard', ['*'], ['*']],
        ['without metadata', ['id', 'relativePath'], ['id', 'relativePath']],
    ])('uses expected gRPC query output fields for %s', async (_label, outputFields, expectedOutputFields) => {
        const database = Object.create(MilvusVectorDatabase.prototype) as MilvusVectorDatabase;
        const query = jest.fn().mockResolvedValue({
            status: { error_code: 'Success' },
            data: [createHydrationRow()],
        });

        (database as any).initializationPromise = Promise.resolve();
        (database as any).client = {
            getLoadState: jest.fn().mockResolvedValue({ state: 3 }),
            loadCollection: jest.fn().mockResolvedValue({}),
            query,
        };

        const rows = await database.query('query_fields_test', 'relativePath == "src/buildRoom.ts"', outputFields, 5);

        expect(query).toHaveBeenCalledWith({
            collection_name: 'query_fields_test',
            output_fields: expectedOutputFields,
            filter: 'relativePath == "src/buildRoom.ts"',
            limit: 5,
        });
        if (outputFields.includes('metadata') && !outputFields.includes('*')) {
            expect(rows[0]).toEqual(expect.objectContaining({ metadata: expect.any(String) }));
            expect(rows[0]).not.toHaveProperty('content');
            expect(rows[0]).not.toHaveProperty('primarySymbol');
        } else {
            expect(rows[0]).toMatchObject({
                content: 'export function buildRoom() {}',
                relativePath: 'src/buildRoom.ts',
                primarySymbol: 'buildRoom',
            });
            if (outputFields.includes('*')) {
                expect(JSON.parse(rows[0].metadata)).toMatchObject({
                    fileName: 'buildRoom.ts',
                    primarySymbol: 'buildRoom',
                });
            }
        }
    });

    it('falls back to raw gRPC metadata query when legacy collections reject structured hydration fields', async () => {
        const database = Object.create(MilvusVectorDatabase.prototype) as MilvusVectorDatabase;
        const error = new Error('field primarySymbol does not exist');
        const query = jest.fn()
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce({
                status: { error_code: 'Success' },
                data: [{
                    metadata: JSON.stringify({
                        codebasePath: '/repo',
                        language: 'typescript',
                    }),
                }],
            });

        (database as any).initializationPromise = Promise.resolve();
        (database as any).client = {
            getLoadState: jest.fn().mockResolvedValue({ state: 3 }),
            loadCollection: jest.fn().mockResolvedValue({}),
            query,
        };

        const rows = await database.query('legacy_query_test', '', ['metadata'], 5);

        expect(query).toHaveBeenNthCalledWith(1, {
            collection_name: 'legacy_query_test',
            output_fields: expectedMetadataHydrationOutputFields(['metadata']),
            limit: 5,
        });
        expect(query).toHaveBeenNthCalledWith(2, {
            collection_name: 'legacy_query_test',
            output_fields: ['metadata'],
            limit: 5,
        });
        expect(rows).toEqual([{
            metadata: JSON.stringify({
                codebasePath: '/repo',
                language: 'typescript',
            }),
        }]);
    });

    it.each([
        ['metadata only', ['metadata'], expectedMetadataHydrationOutputFields(['metadata'])],
        ['metadata and relativePath', ['metadata', 'relativePath'], expectedMetadataHydrationOutputFields(['metadata', 'relativePath'])],
        ['wildcard', ['*'], ['*']],
        ['without metadata', ['id', 'relativePath'], ['id', 'relativePath']],
    ])('uses expected REST query output fields for %s', async (_label, outputFields, expectedOutputFields) => {
        const database = Object.create(MilvusRestfulVectorDatabase.prototype) as MilvusRestfulVectorDatabase;
        const requests: Array<{ endpoint: string; data?: any }> = [];
        const makeRequest = jest.fn(async (endpoint: string, _method: string, data?: any) => {
            requests.push({ endpoint, data });
            if (endpoint === '/collections/get_load_state') {
                return { code: 0, data: { loadState: 'LoadStateLoaded' } };
            }
            return { code: 0, data: [createHydrationRow()] };
        });

        (database as any).initializationPromise = Promise.resolve();
        (database as any).baseUrl = 'http://localhost:19530/v2/vectordb';
        (database as any).config = { database: 'default' };
        (database as any).performanceMetrics = { flushLoadMs: 0 };
        (database as any).makeRequest = makeRequest;

        const rows = await database.query('query_fields_test', 'relativePath == "src/buildRoom.ts"', outputFields, 5);
        const queryRequest = requests.find((request) => request.endpoint === '/entities/query');

        expect(queryRequest?.data).toEqual({
            collectionName: 'query_fields_test',
            dbName: 'default',
            outputFields: expectedOutputFields,
            offset: 0,
            filter: 'relativePath == "src/buildRoom.ts"',
            limit: 5,
        });
        if (outputFields.includes('metadata') && !outputFields.includes('*')) {
            expect(rows[0]).toEqual(expect.objectContaining({ metadata: expect.any(String) }));
            expect(rows[0]).not.toHaveProperty('content');
            expect(rows[0]).not.toHaveProperty('primarySymbol');
        } else {
            expect(rows[0]).toMatchObject({
                content: 'export function buildRoom() {}',
                relativePath: 'src/buildRoom.ts',
                primarySymbol: 'buildRoom',
            });
            if (outputFields.includes('*')) {
                expect(JSON.parse(rows[0].metadata)).toMatchObject({
                    fileName: 'buildRoom.ts',
                    primarySymbol: 'buildRoom',
                });
            }
        }
    });

    it('flushes REST inserts before reloading when writes are not deferred', async () => {
        const database = Object.create(MilvusRestfulVectorDatabase.prototype) as MilvusRestfulVectorDatabase;
        const requests: Array<{ endpoint: string; data?: any }> = [];
        const makeRequest = jest.fn(async (endpoint: string, _method: string, data?: any) => {
            requests.push({ endpoint, data });
            if (endpoint === '/collections/get_load_state') {
                return { code: 0, data: { loadState: 'LoadStateLoaded' } };
            }
            return { code: 0, data: [] };
        });
        const document: VectorDocument = {
            id: 'chunk-1',
            vector: [1, 0, 0],
            content: 'export const one = 1;',
            relativePath: 'src/one.ts',
            startLine: 1,
            endLine: 1,
            fileExtension: '.ts',
            metadata: { language: 'typescript' },
        };

        (database as any).initializationPromise = Promise.resolve();
        (database as any).baseUrl = 'http://localhost:19530/v2/vectordb';
        (database as any).config = { database: 'default' };
        (database as any).performanceMetrics = { flushLoadMs: 0 };
        (database as any).makeRequest = makeRequest;

        await database.insert('insert_flush_test', [document]);

        expect(requests.map(request => request.endpoint)).toEqual([
            '/collections/get_load_state',
            '/entities/insert',
            '/collections/flush',
            '/collections/get_load_state',
        ]);
        expect(requests.find(request => request.endpoint === '/collections/flush')?.data).toEqual({
            collectionName: 'insert_flush_test',
            dbName: 'default',
        });
    });

    it('falls back to raw REST metadata query when legacy collections reject structured hydration fields', async () => {
        const database = Object.create(MilvusRestfulVectorDatabase.prototype) as MilvusRestfulVectorDatabase;
        const requests: Array<{ endpoint: string; data?: any }> = [];
        let queryCount = 0;
        const makeRequest = jest.fn(async (endpoint: string, _method: string, data?: any) => {
            requests.push({ endpoint, data });
            if (endpoint === '/collections/get_load_state') {
                return { code: 0, data: { loadState: 'LoadStateLoaded' } };
            }
            queryCount++;
            if (queryCount === 1) {
                return { code: 100, message: 'field primarySymbol does not exist' };
            }
            return {
                code: 0,
                data: [{
                    metadata: JSON.stringify({
                        codebasePath: '/repo',
                        language: 'typescript',
                    }),
                }],
            };
        });

        (database as any).initializationPromise = Promise.resolve();
        (database as any).baseUrl = 'http://localhost:19530/v2/vectordb';
        (database as any).config = { database: 'default' };
        (database as any).makeRequest = makeRequest;

        const rows = await database.query('legacy_query_test', '', ['metadata'], 5);

        const queryRequests = requests.filter((request) => request.endpoint === '/entities/query');
        expect(queryRequests[0]?.data).toEqual({
            collectionName: 'legacy_query_test',
            dbName: 'default',
            outputFields: expectedMetadataHydrationOutputFields(['metadata']),
            offset: 0,
            limit: 5,
        });
        expect(queryRequests[1]?.data).toEqual({
            collectionName: 'legacy_query_test',
            dbName: 'default',
            outputFields: ['metadata'],
            offset: 0,
            limit: 5,
        });
        expect(rows).toEqual([{
            metadata: JSON.stringify({
                codebasePath: '/repo',
                language: 'typescript',
            }),
        }]);
    });

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
