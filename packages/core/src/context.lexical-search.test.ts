import { Context } from './context';
import { Embedding, EmbeddingVector } from './embedding';
import { DEFAULT_SEARCH_OUTPUT_FIELDS, VectorDatabase } from './vectordb';

class TestEmbedding extends Embedding {
    protected maxTokens = 8192;

    async detectDimension(): Promise<number> {
        return 3;
    }

    async embed(_text: string): Promise<EmbeddingVector> {
        return { vector: [1, 0, 0], dimension: 3 };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map(() => ({ vector: [1, 0, 0], dimension: 3 }));
    }

    getDimension(): number {
        return 3;
    }

    getProvider(): string {
        return 'test';
    }
}

const TEST_COLLECTION_DESCRIPTION = [
    'codebasePath:/repo',
    `hitmuxContext:${JSON.stringify({
        version: 1,
        codebasePath: '/repo',
        embedding: {
            provider: 'test',
            model: 'unknown',
            dimension: 3,
        },
        schemaVersion: 2,
        metadataVersion: 2,
        splitterType: 'ast',
        createdAt: '2026-06-12T00:00:00.000Z',
    })}`,
].join('\n');

const createVectorDatabase = (): jest.Mocked<VectorDatabase> => ({
    createCollection: jest.fn().mockResolvedValue(undefined),
    createHybridCollection: jest.fn().mockResolvedValue(undefined),
    ensureHybridCollectionReady: jest.fn().mockResolvedValue(undefined),
    dropCollection: jest.fn().mockResolvedValue(undefined),
    hasCollection: jest.fn().mockResolvedValue(true),
    listCollections: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockResolvedValue(undefined),
    insertHybrid: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([{
        document: {
            id: 'server-ready',
            vector: [1, 0, 0],
            content: 'export class GameRoom {}',
            relativePath: 'server/src/rooms/GameRoom.ts',
            startLine: 1,
            endLine: 20,
            fileExtension: '.ts',
            metadata: { language: 'typescript' },
        },
        score: 0.95,
    }]),
    hybridSearch: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([createRow({
        id: 'render-worker-bridge',
        content: 'export class RenderWorkerBridge {}',
        relativePath: 'src/workers/bridge/renderWorkerBridge.ts',
        startLine: 28,
        endLine: 40,
        metadata: {
            language: 'typescript',
            fileName: 'renderWorkerBridge.ts',
            basename: 'renderWorkerBridge',
            symbols: ['RenderWorkerBridge'],
            definitionIdentifiers: ['RenderWorkerBridge'],
        },
    })]),
    getCollectionDescription: jest.fn().mockResolvedValue(TEST_COLLECTION_DESCRIPTION),
    checkCollectionLimit: jest.fn().mockResolvedValue(true),
    getCollectionRowCount: jest.fn().mockResolvedValue(1),
});

const SEARCH_OUTPUT_FIELDS = [...DEFAULT_SEARCH_OUTPUT_FIELDS];

function createRow(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
    const metadata = overrides.metadata && typeof overrides.metadata === 'object'
        ? overrides.metadata
        : { language: 'typescript' };

    return {
        id: 'row',
        content: '',
        relativePath: '',
        startLine: 1,
        endLine: 1,
        fileExtension: '.ts',
        ...overrides,
        metadata: typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
    };
}

function createVectorResult(
    overrides: Partial<{
        id: string;
        content: string;
        relativePath: string;
        startLine: number;
        endLine: number;
        fileExtension: string;
        metadata: Record<string, unknown>;
    }>,
    score: number
) {
    const { metadata, ...documentOverrides } = overrides;

    return {
        document: {
            id: 'vector-row',
            vector: [1, 0, 0],
            content: '',
            relativePath: '',
            startLine: 1,
            endLine: 1,
            fileExtension: '.ts',
            metadata: metadata ?? { language: 'typescript' },
            ...documentOverrides,
        },
        score,
    };
}

describe('Context lexical search supplement', () => {
    it('promotes exact identifier matches that vector search misses', async () => {
        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'RenderWorkerBridge', 5, 0.3);

        expect(results[0]).toMatchObject({
            relativePath: 'src/workers/bridge/renderWorkerBridge.ts',
            startLine: 28,
            endLine: 40,
            language: 'typescript',
        });
        expect(results[0].scoreReasons).toEqual(expect.arrayContaining(['exact_filename', 'exact_symbol_definition']));
        expect(results[1].relativePath).toBe('server/src/rooms/GameRoom.ts');
        expect(vectorDatabase.query).toHaveBeenNthCalledWith(
            1,
            expect.any(String),
            expect.stringContaining('RenderWorkerBridge'),
            SEARCH_OUTPUT_FIELDS,
            200
        );
        const exactFilter = vectorDatabase.query.mock.calls[0][1];
        expect(exactFilter).toContain('primarySymbol');
        expect(exactFilter).toContain('basename');
        expect(exactFilter).toContain('isDefinition == true');
        expect(exactFilter).not.toContain('metadata like');
    });

    it('uses a larger vector candidate pool while preserving the final output limit', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.search.mockResolvedValue(Array.from({ length: 80 }, (_, index) => createVectorResult({
            id: `candidate-${index}`,
            content: `export function candidate${index}() { return ${index}; }`,
            relativePath: `src/candidates/candidate${index}.ts`,
            startLine: index + 1,
            endLine: index + 1,
            metadata: { language: 'typescript' },
        }, 1 - (index / 1000))));
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'player ready countdown start', 5, 0.3);

        expect(vectorDatabase.search).toHaveBeenCalledWith(
            expect.any(String),
            [1, 0, 0],
            expect.objectContaining({ topK: 80, threshold: 0.3 })
        );
        expect(results).toHaveLength(5);
    });

    it('uses a larger hybrid candidate pool while preserving the final output limit', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hybridSearch.mockResolvedValue(Array.from({ length: 80 }, (_, index) => ({
            document: {
                id: `hybrid-candidate-${index}`,
                vector: [1, 0, 0],
                content: `export function hybridCandidate${index}() { return ${index}; }`,
                relativePath: `src/candidates/hybridCandidate${index}.ts`,
                startLine: index + 1,
                endLine: index + 1,
                fileExtension: '.ts',
                metadata: { language: 'typescript' },
            },
            score: 1 - (index / 1000),
        })));
        const context = new Context({
            hybridMode: true,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'player ready countdown start', 5, 0.3);

        expect(vectorDatabase.hybridSearch).toHaveBeenCalledWith(
            expect.any(String),
            [
                expect.objectContaining({ anns_field: 'vector', limit: 80 }),
                expect.objectContaining({ anns_field: 'sparse_vector', limit: 80 }),
            ],
            expect.objectContaining({ limit: 80 })
        );
        expect(results).toHaveLength(5);
    });

    it('caps lexical supplement candidate pools independently from final result limit', async () => {
        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        await context.semanticSearch('/repo', 'RenderWorkerBridge', 1000, 0.3);

        expect(vectorDatabase.query).toHaveBeenNthCalledWith(
            1,
            expect.any(String),
            expect.stringContaining('RenderWorkerBridge'),
            SEARCH_OUTPUT_FIELDS,
            200
        );
        expect(vectorDatabase.query).toHaveBeenNthCalledWith(
            2,
            expect.any(String),
            expect.stringContaining('RenderWorkerBridge'),
            SEARCH_OUTPUT_FIELDS,
            80
        );
    });

    it('rejects lexical supplement search when structured fields are missing', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query.mockRejectedValueOnce(new Error('field primarySymbol not found in schema'));
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        await expect(context.semanticSearch('/repo', 'RenderWorkerBridge', 5, 0.3)).rejects.toThrow('unsupported search schema');
        expect(vectorDatabase.query).toHaveBeenCalledTimes(1);
    });

    it('queries broad lexical candidates when exact rows do not contain enough owner-quality matches', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce(Array.from({ length: 5 }, (_, index) => createRow({
                id: `render-worker-bridge-reference-${index}`,
                content: `registry.register('RenderWorkerBridge', bridge${index});`,
                relativePath: `src/registry/renderWorkerBridgeReference${index}.ts`,
                startLine: 1,
                endLine: 3,
                metadata: {
                    language: 'typescript',
                    fileName: `renderWorkerBridgeReference${index}.ts`,
                    basename: `renderWorkerBridgeReference${index}`,
                    symbols: ['RenderWorkerBridge'],
                },
            })))
            .mockResolvedValueOnce([createRow({
                id: 'render-worker-bridge-definition',
                content: 'export class RenderWorkerBridge {}',
                relativePath: 'src/workers/bridge/renderWorkerBridge.ts',
                startLine: 28,
                endLine: 40,
                metadata: {
                    language: 'typescript',
                    fileName: 'renderWorkerBridge.ts',
                    basename: 'renderWorkerBridge',
                    definitionIdentifiers: ['RenderWorkerBridge'],
                },
            })]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        await context.semanticSearch('/repo', 'RenderWorkerBridge', 5, 0.3);

        expect(vectorDatabase.query).toHaveBeenCalledTimes(2);
    });

    it('does not query broad lexical candidates when exact anchor candidates fill the needed pool', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query.mockResolvedValueOnce(Array.from({ length: 5 }, (_, index) => createRow({
            id: `render-worker-bridge-${index}`,
            content: 'export class RenderWorkerBridge {}',
            relativePath: `src/workers/bridge${index}/renderWorkerBridge.ts`,
            startLine: 1,
            endLine: 3,
            metadata: {
                language: 'typescript',
                fileName: 'renderWorkerBridge.ts',
                basename: 'renderWorkerBridge',
                symbols: ['RenderWorkerBridge'],
                definitionIdentifiers: ['RenderWorkerBridge'],
            },
        })));
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        await context.semanticSearch('/repo', 'RenderWorkerBridge', 5, 0.3);

        expect(vectorDatabase.query).toHaveBeenCalledTimes(1);
    });

    it('ranks exact filename matches before high-scoring semantic drift', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query.mockResolvedValue([createRow({
            id: 'render-worker-bridge',
            content: 'export class RenderWorkerBridge {}',
            relativePath: 'src/workers/bridge/renderWorkerBridge.ts',
            startLine: 28,
            endLine: 40,
            metadata: {
                language: 'typescript',
                fileName: 'renderWorkerBridge.ts',
                basename: 'renderWorkerBridge',
                symbols: ['RenderWorkerBridge'],
                definitionIdentifiers: ['RenderWorkerBridge'],
            },
        })]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'renderWorkerBridge.ts', 5, 0.3);

        expect(results[0].relativePath).toBe('src/workers/bridge/renderWorkerBridge.ts');
        expect(results[0].scoreReasons).toEqual(expect.arrayContaining(['exact_filename']));
        expect(results[1].relativePath).toBe('server/src/rooms/GameRoom.ts');
    });

    it('recalls path fragments like router/relay-router.go as strong anchors', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'router-owner',
                    content: 'func TaskPrivateData() {}',
                    relativePath: 'internal/router/relay-router.go',
                    startLine: 1,
                    endLine: 18,
                    fileExtension: '.go',
                    metadata: {
                        language: 'go',
                        fileName: 'relay-router.go',
                        basename: 'relay-router',
                        symbols: ['TaskPrivateData'],
                        definitionIdentifiers: ['TaskPrivateData'],
                        pathTokens: ['internal', 'router', 'relay-router'],
                    },
                }),
                createRow({
                    id: 'drift',
                    content: 'func RelayStatus() {}',
                    relativePath: 'internal/router/relay-status.go',
                    startLine: 1,
                    endLine: 10,
                    fileExtension: '.go',
                    metadata: {
                        language: 'go',
                        fileName: 'relay-status.go',
                        basename: 'relay-status',
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'router/relay-router.go TaskPrivateData', 5, 0.3);
        const exactFilter = String(vectorDatabase.query.mock.calls[0][1]);

        expect(results[0].relativePath).toBe('internal/router/relay-router.go');
        expect(exactFilter).toContain('router/relay-router.go');
        expect(exactFilter).toContain('TaskPrivateData');
        expect(exactFilter).toContain('relay-router');
    });

    it('ranks symbol definitions above references with the same identifier', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'caller',
                    content: 'const bridge = new RenderWorkerBridge();',
                    relativePath: 'src/app/bootstrap.ts',
                    startLine: 5,
                    endLine: 10,
                }),
                createRow({
                    id: 'definition',
                    content: 'export class RenderWorkerBridge {}',
                    relativePath: 'src/workers/bridge/renderWorkerBridge.ts',
                    startLine: 28,
                    endLine: 40,
                    metadata: {
                        language: 'typescript',
                        fileName: 'renderWorkerBridge.ts',
                        basename: 'renderWorkerBridge',
                        symbols: ['RenderWorkerBridge'],
                        definitionIdentifiers: ['RenderWorkerBridge'],
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'RenderWorkerBridge', 5, 0.3);

        expect(results[0].relativePath).toBe('src/workers/bridge/renderWorkerBridge.ts');
        expect(results[0].scoreReasons).toEqual(expect.arrayContaining(['exact_symbol_definition']));
        expect(results.findIndex(result => result.relativePath === 'src/app/bootstrap.ts')).toBeGreaterThan(0);
    });

    it('keeps exact symbol definitions above reference-heavy callers with higher cumulative score', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'caller',
                    content: [
                        'FooRegistry.register("foo", createFoo);',
                        'FactoryRegistry.register("factory", createFactory);',
                        'ManagerRegistry.register("manager", createManager);',
                    ].join('\n'),
                    relativePath: 'src/bootstrap/registryBootstrap.ts',
                    startLine: 12,
                    endLine: 30,
                    metadata: {
                        language: 'typescript',
                        fileName: 'registryBootstrap.ts',
                        basename: 'registryBootstrap',
                        symbols: ['FooRegistry', 'FactoryRegistry', 'ManagerRegistry'],
                    },
                }),
                createRow({
                    id: 'definition',
                    content: 'export class FooRegistry {}',
                    relativePath: 'src/registries/foo.ts',
                    startLine: 3,
                    endLine: 25,
                    metadata: {
                        language: 'typescript',
                        fileName: 'foo.ts',
                        basename: 'foo',
                        symbols: ['FooRegistry'],
                        definitionIdentifiers: ['FooRegistry'],
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'FooRegistry FactoryRegistry ManagerRegistry', 10, 0.3);
        const definition = results.find(result => result.relativePath === 'src/registries/foo.ts');
        const caller = results.find(result => result.relativePath === 'src/bootstrap/registryBootstrap.ts');

        expect(results[0].relativePath).toBe('src/registries/foo.ts');
        expect(definition?.scoreReasons).toEqual(expect.arrayContaining(['exact_symbol_definition']));
        expect(caller?.scoreReasons).toEqual(expect.arrayContaining(['reference_match']));
        expect(caller!.score).toBeGreaterThan(definition!.score);
    });

    it('ranks lexical owner results above vector reference results for multi-token queries', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.search.mockResolvedValue([
            createVectorResult({
                id: 'test-reference',
                content: 'expect(TowerRegistry.config.manager.system).toBeDefined();',
                relativePath: 'src/towers/towerRegistry.test.ts',
                startLine: 12,
                endLine: 20,
                metadata: {
                    language: 'typescript',
                    fileName: 'towerRegistry.test.ts',
                    basename: 'towerRegistry.test',
                },
            }, 12),
            createVectorResult({
                id: 'bootstrap-reference',
                content: [
                    'TowerRegistry.register("alpha", createTower);',
                    'TowerRegistry.register("beta", createTower);',
                    'TowerRegistry.register("gamma", createTower);',
                ].join('\n'),
                relativePath: 'src/bootstrap/towerBootstrap.ts',
                startLine: 40,
                endLine: 60,
            }, 11),
        ]);
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'owner',
                    content: 'export class TowerRegistry {}',
                    relativePath: 'src/towers/towerRegistry.ts',
                    startLine: 12,
                    endLine: 53,
                    metadata: {
                        language: 'typescript',
                        fileName: 'towerRegistry.ts',
                        basename: 'towerRegistry',
                        symbols: ['TowerRegistry'],
                        definitionIdentifiers: ['TowerRegistry'],
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'TowerRegistry config manager system', 10, 0.3);
        const owner = results.find(result => result.relativePath === 'src/towers/towerRegistry.ts');
        const testReference = results.find(result => result.relativePath === 'src/towers/towerRegistry.test.ts');

        expect(results[0].relativePath).toBe('src/towers/towerRegistry.ts');
        expect(owner?.scoreReasons).toEqual(expect.arrayContaining(['exact_symbol_definition']));
        expect(testReference?.scoreReasons).not.toEqual(expect.arrayContaining(['exact_symbol_definition']));
        expect(vectorDatabase.search.mock.results[0].type).toBe('return');
        expect(testReference).toBeDefined();
    });

    it('ranks implementation definitions above test docs and style matches by default', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'style',
                    content: '.TowerRegistry { color: red; }',
                    relativePath: 'src/styles/index.less',
                    startLine: 1,
                    endLine: 3,
                    fileExtension: '.less',
                    metadata: {
                        language: 'less',
                        fileName: 'index.less',
                        basename: 'index',
                    },
                }),
                createRow({
                    id: 'test',
                    content: 'TowerRegistry.register("TestTower", () => ({}));',
                    relativePath: 'src/network/validation/clientValidator.test.ts',
                    startLine: 50,
                    endLine: 60,
                }),
                createRow({
                    id: 'docs',
                    content: 'TowerRegistry is the central tower registry.',
                    relativePath: 'docs/towers/README.md',
                    startLine: 1,
                    endLine: 5,
                    fileExtension: '.md',
                }),
                createRow({
                    id: 'caller',
                    content: 'const creator = TowerRegistry.getCreator(name);',
                    relativePath: 'src/systems/save/saveManager.ts',
                    startLine: 277,
                    endLine: 280,
                }),
                createRow({
                    id: 'definition',
                    content: 'export class TowerRegistry extends BaseRegistry<TowerCreator> {}',
                    relativePath: 'src/towers/towerRegistry.ts',
                    startLine: 20,
                    endLine: 80,
                    metadata: {
                        language: 'typescript',
                        fileName: 'towerRegistry.ts',
                        basename: 'towerRegistry',
                        symbols: ['TowerRegistry'],
                        definitionIdentifiers: ['TowerRegistry'],
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'TowerRegistry', 10, 0.3);
        const paths = results.map(result => result.relativePath);

        expect(paths[0]).toBe('src/towers/towerRegistry.ts');
        expect(results[0].scoreReasons).toEqual(expect.arrayContaining(['exact_symbol_definition']));
        expect(paths.indexOf('src/towers/towerRegistry.ts')).toBeLessThan(paths.indexOf('src/network/validation/clientValidator.test.ts'));
        expect(paths.indexOf('src/towers/towerRegistry.ts')).toBeLessThan(paths.indexOf('docs/towers/README.md'));
        expect(paths.indexOf('src/towers/towerRegistry.ts')).toBeLessThan(paths.indexOf('src/styles/index.less'));
        expect(paths.indexOf('src/towers/towerRegistry.ts')).toBeLessThan(paths.indexOf('src/systems/save/saveManager.ts'));
    });

    it('does not let weak descriptors recall or outrank strong anchor definitions', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'config-only',
                    content: 'export const configDefinitions = { enabled: true };',
                    relativePath: 'src/config/configDefinitions.ts',
                    startLine: 1,
                    endLine: 8,
                    metadata: {
                        language: 'typescript',
                        fileName: 'configDefinitions.ts',
                        basename: 'configDefinitions',
                    },
                }),
                createRow({
                    id: 'caller',
                    content: [
                        'import { FooRegistry } from "../foo/FooRegistry";',
                        'FooRegistry.register("alpha", createFoo);',
                        'FooRegistry.register("beta", createFoo);',
                    ].join('\n'),
                    relativePath: 'src/app/fooBootstrap.ts',
                    startLine: 10,
                    endLine: 20,
                }),
                createRow({
                    id: 'definition',
                    content: 'export class FooRegistry {}',
                    relativePath: 'src/foo/FooRegistry.ts',
                    startLine: 3,
                    endLine: 25,
                    metadata: {
                        language: 'typescript',
                        fileName: 'FooRegistry.ts',
                        basename: 'FooRegistry',
                        symbols: ['FooRegistry'],
                        definitionIdentifiers: ['FooRegistry'],
                    },
                }),
                createRow({
                    id: 'test',
                    content: 'FooRegistry.register("test", createFoo);',
                    relativePath: 'src/foo/FooRegistry.test.ts',
                    startLine: 7,
                    endLine: 16,
                }),
                createRow({
                    id: 'docs',
                    content: 'FooRegistry config definitions are documented here.',
                    relativePath: 'docs/foo/README.md',
                    startLine: 1,
                    endLine: 4,
                    fileExtension: '.md',
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'FooRegistry config definitions', 10, 0.3);
        const paths = results.map(result => result.relativePath);
        const exactFilter = String(vectorDatabase.query.mock.calls[0][1]);
        const broadFilter = String(vectorDatabase.query.mock.calls[1][1]);

        expect(paths[0]).toBe('src/foo/FooRegistry.ts');
        expect(paths.indexOf('src/foo/FooRegistry.ts')).toBeLessThan(paths.indexOf('src/config/configDefinitions.ts'));
        expect(paths.indexOf('src/foo/FooRegistry.ts')).toBeLessThan(paths.indexOf('src/app/fooBootstrap.ts'));
        expect(paths.indexOf('src/foo/FooRegistry.ts')).toBeLessThan(paths.indexOf('src/foo/FooRegistry.test.ts'));
        expect(paths.indexOf('src/foo/FooRegistry.ts')).toBeLessThan(paths.indexOf('docs/foo/README.md'));
        expect(exactFilter).toContain('FooRegistry');
        expect(broadFilter).toContain('FooRegistry');
        expect(exactFilter).not.toContain('config');
        expect(broadFilter).not.toContain('config');
        expect(exactFilter).not.toContain('definitions');
        expect(broadFilter).not.toContain('definitions');
    });

    it('does not let weak multi-token descriptors expand recall when a strong anchor exists', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'descriptor-only',
                    content: 'export const configManagerSystem = { enabled: true };',
                    relativePath: 'src/config/configManagerSystem.ts',
                    startLine: 1,
                    endLine: 10,
                    metadata: {
                        language: 'typescript',
                        fileName: 'configManagerSystem.ts',
                        basename: 'configManagerSystem',
                    },
                }),
                createRow({
                    id: 'owner',
                    content: 'export class FooRegistry {}',
                    relativePath: 'src/foo/FooRegistry.ts',
                    startLine: 3,
                    endLine: 25,
                    metadata: {
                        language: 'typescript',
                        fileName: 'FooRegistry.ts',
                        basename: 'FooRegistry',
                        symbols: ['FooRegistry'],
                        definitionIdentifiers: ['FooRegistry'],
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'FooRegistry config manager system', 10, 0.3);
        const exactFilter = String(vectorDatabase.query.mock.calls[0][1]);
        const broadFilter = String(vectorDatabase.query.mock.calls[1][1]);

        expect(results[0].relativePath).toBe('src/foo/FooRegistry.ts');
        expect(exactFilter).toContain('FooRegistry');
        expect(broadFilter).toContain('FooRegistry');
        expect(exactFilter).not.toContain('config');
        expect(exactFilter).not.toContain('manager');
        expect(exactFilter).not.toContain('system');
        expect(broadFilter).not.toContain('config');
        expect(broadFilter).not.toContain('manager');
        expect(broadFilter).not.toContain('system');
    });

    it('recalls literal anchors for HTTP paths, env vars, and dotted config keys', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'config-owner',
                    content: [
                        'export const FRONTEND_BASE_URL = "https://api.hitmux.com";',
                        'export const serverPort = 8080;',
                        'export const chatCompletionsRoute = "/v1/chat/completions";',
                    ].join('\n'),
                    relativePath: 'src/config/serviceConfig.ts',
                    startLine: 1,
                    endLine: 12,
                    metadata: {
                        language: 'typescript',
                        fileName: 'serviceConfig.ts',
                        basename: 'serviceConfig',
                        symbols: ['FRONTEND_BASE_URL', 'serverPort', 'chatCompletionsRoute'],
                        definitionIdentifiers: ['FRONTEND_BASE_URL', 'serverPort', 'chatCompletionsRoute'],
                        pathTokens: ['src', 'config', 'serviceConfig'],
                    },
                }),
                createRow({
                    id: 'drift',
                    content: 'export const chatStatusRoute = "/v1/chat/status";',
                    relativePath: 'src/config/chatStatus.ts',
                    startLine: 1,
                    endLine: 8,
                    metadata: {
                        language: 'typescript',
                        fileName: 'chatStatus.ts',
                        basename: 'chatStatus',
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch(
            '/repo',
            'FRONTEND_BASE_URL /v1/chat/completions api.hitmux.com:443 server.port',
            5,
            0.3
        );
        const exactFilter = String(vectorDatabase.query.mock.calls[0][1]);

        expect(results.map(result => result.relativePath)).toContain('src/config/serviceConfig.ts');
        expect(exactFilter).toContain('FRONTEND_BASE_URL');
        expect(exactFilter).toContain('/v1/chat/completions');
        expect(exactFilter).toContain('api.hitmux.com:443');
        expect(exactFilter).toContain('server.port');
        expect(exactFilter).not.toContain('basename == "chat"');
        expect(exactFilter).not.toContain('primarySymbol == "chat"');
    });

    it('keeps full HTTP route matches above tail segment matches', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'tail-only',
                    content: 'export const completions = createLegacyCompletionHandler();',
                    relativePath: 'src/api/completions.ts',
                    startLine: 1,
                    endLine: 12,
                    metadata: {
                        language: 'typescript',
                        fileName: 'completions.ts',
                        basename: 'completions',
                        symbols: ['completions'],
                    },
                }),
                createRow({
                    id: 'full-route',
                    content: 'router.post("/v1/chat/completions", handleChatCompletions);',
                    relativePath: 'src/routes/chatCompletions.ts',
                    startLine: 20,
                    endLine: 34,
                    metadata: {
                        language: 'typescript',
                        fileName: 'chatCompletions.ts',
                        basename: 'chatCompletions',
                        symbols: ['handleChatCompletions'],
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', '/v1/chat/completions', 5, 0.3);

        expect(results[0].relativePath).toBe('src/routes/chatCompletions.ts');
        expect(results[0].scoreReasons).toEqual(expect.arrayContaining(['reference_match']));
        expect(results.map(result => result.relativePath).indexOf('src/routes/chatCompletions.ts')).toBeLessThan(
            results.map(result => result.relativePath).indexOf('src/api/completions.ts')
        );
    });

    it('treats a standalone config descriptor as weak when a strong anchor is present', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'implementation-reference',
                    content: 'FooRegistry.register("runtime", createFoo);',
                    relativePath: 'src/app/fooBootstrap.ts',
                    startLine: 20,
                    endLine: 28,
                }),
                createRow({
                    id: 'config-reference',
                    content: 'FooRegistry is mentioned in config metadata.',
                    relativePath: 'src/config/fooConfig.ts',
                    startLine: 1,
                    endLine: 10,
                    metadata: {
                        language: 'typescript',
                        fileName: 'fooConfig.ts',
                        basename: 'fooConfig',
                    },
                }),
                createRow({
                    id: 'definition',
                    content: 'export class FooRegistry {}',
                    relativePath: 'src/foo/FooRegistry.ts',
                    startLine: 3,
                    endLine: 25,
                    metadata: {
                        language: 'typescript',
                        fileName: 'FooRegistry.ts',
                        basename: 'FooRegistry',
                        symbols: ['FooRegistry'],
                        definitionIdentifiers: ['FooRegistry'],
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'FooRegistry config', 10, 0.3);
        const paths = results.map(result => result.relativePath);
        const exactFilter = String(vectorDatabase.query.mock.calls[0][1]);

        expect(paths[0]).toBe('src/foo/FooRegistry.ts');
        expect(paths.indexOf('src/app/fooBootstrap.ts')).toBeLessThan(paths.indexOf('src/config/fooConfig.ts'));
        expect(paths.indexOf('src/foo/FooRegistry.ts')).toBeLessThan(paths.indexOf('src/config/fooConfig.ts'));
        expect(exactFilter).toContain('FooRegistry');
        expect(exactFilter).not.toContain('config');
    });

    it('allows explicit targetRole=config to outrank implementation references', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'implementation-reference',
                    content: 'FooRegistry.register("runtime", createFoo);',
                    relativePath: 'src/app/fooBootstrap.ts',
                    startLine: 20,
                    endLine: 28,
                }),
                createRow({
                    id: 'config-reference',
                    content: 'FooRegistry config file entry.',
                    relativePath: 'src/config/fooConfig.ts',
                    startLine: 1,
                    endLine: 10,
                    metadata: {
                        language: 'typescript',
                        fileName: 'fooConfig.ts',
                        basename: 'fooConfig',
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'FooRegistry config file', 10, 0.3, undefined, {
            targetRole: 'config'
        });
        const paths = results.map(result => result.relativePath);

        expect(paths.indexOf('src/config/fooConfig.ts')).toBeLessThan(paths.indexOf('src/app/fooBootstrap.ts'));
        expect(results[0].resultGroup).toBe('docs_config');
        expect(results[0].isPrimary).toBe(true);
    });

    it('keeps implementation owner first for ambiguous role words but honors explicit role requests', async () => {
        const ambiguousVectorDatabase = createVectorDatabase();
        ambiguousVectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'implementation-reference',
                    content: 'FooRegistry.register("runtime", createFoo);',
                    relativePath: 'src/app/fooBootstrap.ts',
                    startLine: 20,
                    endLine: 28,
                }),
                createRow({
                    id: 'config-reference',
                    content: 'FooRegistry runtime config entry.',
                    relativePath: 'src/config/fooConfig.ts',
                    startLine: 1,
                    endLine: 10,
                    metadata: {
                        language: 'typescript',
                        fileName: 'fooConfig.ts',
                        basename: 'fooConfig',
                    },
                }),
                createRow({
                    id: 'definition',
                    content: 'export class FooRegistry {}',
                    relativePath: 'src/foo/FooRegistry.ts',
                    startLine: 3,
                    endLine: 25,
                    metadata: {
                        language: 'typescript',
                        fileName: 'FooRegistry.ts',
                        basename: 'FooRegistry',
                        symbols: ['FooRegistry'],
                        definitionIdentifiers: ['FooRegistry'],
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const ambiguousContext = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase: ambiguousVectorDatabase,
        });

        const ambiguousResults = await ambiguousContext.semanticSearch('/repo', 'FooRegistry config', 10, 0.3);

        expect(ambiguousResults[0].relativePath).toBe('src/foo/FooRegistry.ts');
        expect(ambiguousResults.map(result => result.relativePath).indexOf('src/app/fooBootstrap.ts')).toBeLessThan(
            ambiguousResults.map(result => result.relativePath).indexOf('src/config/fooConfig.ts')
        );

        const explicitVectorDatabase = createVectorDatabase();
        explicitVectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'implementation-reference',
                    content: 'FooRegistry.register("runtime", createFoo);',
                    relativePath: 'src/app/fooBootstrap.ts',
                    startLine: 20,
                    endLine: 28,
                }),
                createRow({
                    id: 'config-reference',
                    content: 'FooRegistry runtime config file entry.',
                    relativePath: 'src/config/fooConfig.ts',
                    startLine: 1,
                    endLine: 10,
                    metadata: {
                        language: 'typescript',
                        fileName: 'fooConfig.ts',
                        basename: 'fooConfig',
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const explicitContext = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase: explicitVectorDatabase,
        });

        const explicitResults = await explicitContext.semanticSearch('/repo', 'FooRegistry config file', 10, 0.3, undefined, {
            targetRole: 'config'
        });
        const explicitPaths = explicitResults.map(result => result.relativePath);

        expect(explicitPaths.indexOf('src/config/fooConfig.ts')).toBeLessThan(explicitPaths.indexOf('src/app/fooBootstrap.ts'));
    });

    it('allows explicit config extensions to outrank implementation references', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'implementation-reference',
                    content: 'FooRegistry.register("runtime", createFoo);',
                    relativePath: 'src/app/fooBootstrap.ts',
                    startLine: 20,
                    endLine: 28,
                }),
                createRow({
                    id: 'json-config',
                    content: '{ "registry": "FooRegistry" }',
                    relativePath: 'src/config/foo-registry.json',
                    startLine: 1,
                    endLine: 3,
                    fileExtension: '.json',
                    metadata: {
                        language: 'json',
                        fileName: 'foo-registry.json',
                        basename: 'foo-registry',
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'FooRegistry .json', 10, 0.3);
        const paths = results.map(result => result.relativePath);

        expect(paths.indexOf('src/config/foo-registry.json')).toBeLessThan(paths.indexOf('src/app/fooBootstrap.ts'));
    });

    it('allows explicitly requested README results to outrank implementation files', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'implementation',
                    content: 'export function packVisionSources() {}',
                    relativePath: 'src/workers/payloadPacker.ts',
                    startLine: 1,
                    endLine: 20,
                    metadata: {
                        language: 'typescript',
                        fileName: 'payloadPacker.ts',
                        basename: 'payloadPacker',
                    },
                }),
                createRow({
                    id: 'readme',
                    content: 'payloadPacker serializes worker payloads.',
                    relativePath: 'src/messages/README.md',
                    startLine: 1,
                    endLine: 8,
                    fileExtension: '.md',
                    metadata: {
                        language: 'markdown',
                        fileName: 'README.md',
                        basename: 'README',
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'payloadPacker README', 10, 0.3);

        expect(results[0].relativePath).toBe('src/messages/README.md');
        expect(results[1].relativePath).toBe('src/workers/payloadPacker.ts');
    });

    it('allows explicitly requested style files to outrank implementation files', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'implementation',
                    content: 'export class ManualCannonPanel {}',
                    relativePath: 'src/ui/interfaces/battle/manualCannonPanel.ts',
                    startLine: 36,
                    endLine: 80,
                    metadata: {
                        language: 'typescript',
                        fileName: 'manualCannonPanel.ts',
                        basename: 'manualCannonPanel',
                        symbols: ['ManualCannonPanel'],
                        definitionIdentifiers: ['ManualCannonPanel'],
                    },
                }),
                createRow({
                    id: 'style',
                    content: '.ManualCannonPanel { position: absolute; }',
                    relativePath: 'src/styles/index.less',
                    startLine: 1,
                    endLine: 8,
                    fileExtension: '.less',
                    metadata: {
                        language: 'less',
                        fileName: 'index.less',
                        basename: 'index',
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'ManualCannonPanel index.less', 10, 0.3);

        expect(results[0].relativePath).toBe('src/styles/index.less');
        expect(results[1].relativePath).toBe('src/ui/interfaces/battle/manualCannonPanel.ts');
    });

    it('groups semantic-only results by explicit default implementation target', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.search.mockResolvedValueOnce([
            {
                document: {
                    id: 'test',
                    vector: [1, 0, 0],
                    content: 'it("starts the countdown", () => startCountdown());',
                    relativePath: 'src/rooms/GameRoom.test.ts',
                    startLine: 1,
                    endLine: 8,
                    fileExtension: '.ts',
                    metadata: { language: 'typescript', fileRole: 'test' },
                    fileRole: 'test',
                },
                score: 0.99,
            },
            {
                document: {
                    id: 'implementation',
                    vector: [1, 0, 0],
                    content: 'export class GameRoom { startCountdown() {} }',
                    relativePath: 'src/rooms/GameRoom.ts',
                    startLine: 1,
                    endLine: 20,
                    fileExtension: '.ts',
                    metadata: { language: 'typescript', fileRole: 'implementation' },
                    fileRole: 'implementation',
                },
                score: 0.9,
            },
            {
                document: {
                    id: 'docs',
                    vector: [1, 0, 0],
                    content: 'GameRoom countdown docs',
                    relativePath: 'docs/game-room.md',
                    startLine: 1,
                    endLine: 4,
                    fileExtension: '.md',
                    metadata: { language: 'markdown', fileRole: 'docs' },
                    fileRole: 'docs',
                },
                score: 0.88,
            },
        ]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'go', 3, 0.3);

        expect(results.map(result => result.relativePath)).toEqual([
            'src/rooms/GameRoom.ts',
            'src/rooms/GameRoom.test.ts',
            'docs/game-room.md',
        ]);
        expect(results.map(result => result.resultGroup)).toEqual([
            'implementation',
            'related_tests',
            'docs_config',
        ]);
        expect(results.map(result => result.isPrimary)).toEqual([true, false, false]);
    });

    it('keeps targetRole=all output in original ranked order without file diversification', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.search.mockResolvedValueOnce([
            createVectorResult({
                id: 'first-a',
                content: 'export function firstA(): void {}',
                relativePath: 'src/a.ts',
                startLine: 10,
                endLine: 20,
                metadata: {
                    language: 'typescript',
                    fileRole: 'implementation',
                    chunkRole: 'definition',
                },
            }, 0.99),
            createVectorResult({
                id: 'second-a',
                content: 'export function secondA(): void {}',
                relativePath: 'src/a.ts',
                startLine: 40,
                endLine: 50,
                metadata: {
                    language: 'typescript',
                    fileRole: 'implementation',
                    chunkRole: 'definition',
                },
            }, 0.98),
            createVectorResult({
                id: 'test',
                content: 'it("uses A", () => firstA());',
                relativePath: 'src/a.test.ts',
                startLine: 1,
                endLine: 8,
                metadata: {
                    language: 'typescript',
                    fileRole: 'test',
                    chunkRole: 'test_case',
                },
            }, 0.97),
        ]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'go', 3, 0.3, undefined, {
            targetRole: 'all',
        });

        expect(results.map(result => `${result.relativePath}:${result.startLine}`)).toEqual([
            'src/a.ts:10',
            'src/a.ts:40',
            'src/a.test.ts:1',
        ]);
        expect(results.map(result => result.isPrimary)).toEqual([true, true, true]);
    });

    it('reranks implementation matches by structure before semantic drift inside the same group', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.search.mockResolvedValueOnce([
            createVectorResult({
                id: 'network-fog',
                content: 'render network towers monsters buildings and bullets through fog state',
                relativePath: 'src/network/rendering/networkFog.ts',
                startLine: 1,
                endLine: 20,
                metadata: {
                    language: 'typescript',
                    fileRole: 'implementation',
                    chunkRole: 'reference',
                },
            }, 0.99),
            createVectorResult({
                id: 'render-proxy',
                content: [
                    'export class RenderProxy {',
                    '    translateNetworkTowers(): void {}',
                    '    translateNetworkMonsters(): void {}',
                    '    translateNetworkBuildings(): void {}',
                    '    translateNetworkBullets(): void {}',
                    '}',
                ].join('\n'),
                relativePath: 'src/network/rendering/renderProxy.ts',
                startLine: 1,
                endLine: 40,
                metadata: {
                    language: 'typescript',
                    fileRole: 'implementation',
                },
            }, 0.72),
            createVectorResult({
                id: 'tower-renderer',
                content: 'render tower sprites and monster overlays',
                relativePath: 'src/towers/rendering/towerRenderer.ts',
                startLine: 1,
                endLine: 20,
                metadata: {
                    language: 'typescript',
                    fileRole: 'implementation',
                    chunkRole: 'reference',
                },
            }, 0.95),
        ]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch(
            '/repo',
            'client render proxies translate network towers monsters buildings and bullets',
            5,
            0.3
        );

        expect(results[0]).toMatchObject({
            relativePath: 'src/network/rendering/renderProxy.ts',
            resultGroup: 'implementation',
            isPrimary: true,
        });
    });

    it('does not let broad path and content terms outrank stronger semantic implementation matches', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.search.mockResolvedValueOnce([
            createVectorResult({
                id: 'expected-owner',
                content: 'export class EnergyCalculator { calculateIncome(): number { return 0; } }',
                relativePath: 'server/src/systems/energy/energyCalculator.ts',
                startLine: 1,
                endLine: 20,
                metadata: {
                    language: 'typescript',
                    fileRole: 'implementation',
                },
            }, 0.95),
            createVectorResult({
                id: 'broad-token-match',
                content: 'territory mines territory production rules mines territory production rules',
                relativePath: 'src/systems/territory/territory.ts',
                startLine: 1,
                endLine: 20,
                metadata: {
                    language: 'typescript',
                    fileRole: 'implementation',
                },
            }, 0.9),
        ]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch(
            '/repo',
            'server calculates energy income from mines territory and production rules',
            5,
            0.3
        );

        expect(results.map(result => result.relativePath)).toEqual([
            'server/src/systems/energy/energyCalculator.ts',
            'src/systems/territory/territory.ts',
        ]);
    });

    it('does not treat actor words as specific owner matches for camel case basenames', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.search.mockResolvedValueOnce([
            createVectorResult({
                id: 'expected-owner',
                content: 'export class TerritoryCalculator { computeOwnership(): void {} }',
                relativePath: 'server/src/systems/territory/territoryCalculator.ts',
                startLine: 1,
                endLine: 20,
                metadata: {
                    language: 'typescript',
                    fileRole: 'implementation',
                },
            }, 0.95),
            createVectorResult({
                id: 'multiplayer-territory',
                content: 'export class MultiPlayerTerritory { updatePlayerTerritory(): void {} }',
                relativePath: 'src/systems/territory/multiPlayerTerritory.ts',
                startLine: 1,
                endLine: 20,
                metadata: {
                    language: 'typescript',
                    fileRole: 'implementation',
                },
            }, 0.9),
        ]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch(
            '/repo',
            'server computes territory ownership influence and expansion from player structures',
            5,
            0.3
        );

        expect(results.map(result => result.relativePath)).toEqual([
            'server/src/systems/territory/territoryCalculator.ts',
            'src/systems/territory/multiPlayerTerritory.ts',
        ]);
    });

    it('reserves related result slots when primary matches fill the output limit', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.search.mockResolvedValueOnce([
            ...Array.from({ length: 6 }, (_, index) => ({
                document: {
                    id: `implementation-${index}`,
                    vector: [1, 0, 0],
                    content: `export function implementation${index}() {}`,
                    relativePath: `src/impl${index}.ts`,
                    startLine: 1,
                    endLine: 4,
                    fileExtension: '.ts',
                    metadata: { language: 'typescript', fileRole: 'implementation' },
                    fileRole: 'implementation',
                },
                score: 1 - index * 0.01,
            })),
            {
                document: {
                    id: 'test',
                    vector: [1, 0, 0],
                    content: 'it("covers implementation", () => implementation0());',
                    relativePath: 'src/impl0.test.ts',
                    startLine: 1,
                    endLine: 8,
                    fileExtension: '.ts',
                    metadata: { language: 'typescript', fileRole: 'test' },
                    fileRole: 'test',
                },
                score: 0.8,
            },
        ]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'go', 5, 0.3);

        expect(results).toHaveLength(5);
        expect(results.slice(0, 4).every(result => result.isPrimary)).toBe(true);
        expect(results[4].relativePath).toBe('src/impl0.test.ts');
        expect(results[4].resultGroup).toBe('related_tests');
        expect(results[4].isPrimary).toBe(false);
    });

    it('can return only explicit test primary results', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.search.mockResolvedValueOnce([
            {
                document: {
                    id: 'implementation',
                    vector: [1, 0, 0],
                    content: 'export class GameRoom {}',
                    relativePath: 'src/rooms/GameRoom.ts',
                    startLine: 1,
                    endLine: 20,
                    fileExtension: '.ts',
                    metadata: { language: 'typescript', fileRole: 'implementation' },
                    fileRole: 'implementation',
                },
                score: 0.99,
            },
            {
                document: {
                    id: 'test',
                    vector: [1, 0, 0],
                    content: 'it("creates a GameRoom", () => new GameRoom());',
                    relativePath: 'src/rooms/GameRoom.test.ts',
                    startLine: 1,
                    endLine: 8,
                    fileExtension: '.ts',
                    metadata: { language: 'typescript', fileRole: 'test' },
                    fileRole: 'test',
                },
                score: 0.9,
            },
        ]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'go', 5, 0.3, undefined, {
            targetRole: 'test',
            includeRelated: false,
        });

        expect(results.map(result => result.relativePath)).toEqual(['src/rooms/GameRoom.test.ts']);
        expect(results[0].resultGroup).toBe('related_tests');
        expect(results[0].isPrimary).toBe(true);
    });

    it('normalizes string line ranges returned from lexical query rows', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'string-lines',
                    content: 'export class RenderWorkerBridge {}',
                    relativePath: 'src/workers/bridge/renderWorkerBridge.ts',
                    startLine: '28',
                    endLine: '40',
                    metadata: {
                        language: 'typescript',
                        fileName: 'renderWorkerBridge.ts',
                        basename: 'renderWorkerBridge',
                        symbols: ['RenderWorkerBridge'],
                        definitionIdentifiers: ['RenderWorkerBridge'],
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'RenderWorkerBridge', 5, 0.3);

        expect(results[0]).toMatchObject({
            relativePath: 'src/workers/bridge/renderWorkerBridge.ts',
            startLine: 28,
            endLine: 40,
        });
        expect(results[0].lineRangeUnavailable).toBeUndefined();
    });

    it('recovers missing lexical line ranges from metadata', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'metadata-lines',
                    content: 'export class RenderWorkerBridge {}',
                    relativePath: 'src/workers/bridge/renderWorkerBridge.ts',
                    startLine: undefined,
                    endLine: undefined,
                    metadata: {
                        language: 'typescript',
                        fileName: 'renderWorkerBridge.ts',
                        basename: 'renderWorkerBridge',
                        symbols: ['RenderWorkerBridge'],
                        definitionIdentifiers: ['RenderWorkerBridge'],
                        sourceStartLine: '28',
                        sourceEndLine: '40',
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'RenderWorkerBridge', 5, 0.3);

        expect(results[0]).toMatchObject({
            relativePath: 'src/workers/bridge/renderWorkerBridge.ts',
            startLine: 28,
            endLine: 40,
        });
        expect(results[0].lineRangeUnavailable).toBeUndefined();
    });

    it('marks unavailable lexical line ranges instead of treating 0-0 as real', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query
            .mockResolvedValueOnce([
                createRow({
                    id: 'missing-lines',
                    content: 'export class RenderWorkerBridge {}',
                    relativePath: 'src/workers/bridge/renderWorkerBridge.ts',
                    startLine: 0,
                    endLine: 0,
                    metadata: {
                        language: 'typescript',
                        fileName: 'renderWorkerBridge.ts',
                        basename: 'renderWorkerBridge',
                        symbols: ['RenderWorkerBridge'],
                        definitionIdentifiers: ['RenderWorkerBridge'],
                    },
                }),
            ])
            .mockResolvedValueOnce([]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'RenderWorkerBridge', 5, 0.3);

        expect(results[0]).toMatchObject({
            relativePath: 'src/workers/bridge/renderWorkerBridge.ts',
            startLine: 0,
            endLine: 0,
            lineRangeUnavailable: true,
        });
        expect(results[0].lineRangeWarning).toMatch(/line range unavailable/);
    });

    it('uses a larger deterministic candidate pool for exact queries', async () => {
        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        await context.semanticSearch('/repo', 'TowerRegistry', 5, 0.3);

        expect(vectorDatabase.query).toHaveBeenNthCalledWith(
            1,
            expect.any(String),
            expect.stringContaining('TowerRegistry'),
            SEARCH_OUTPUT_FIELDS,
            200
        );
        expect(vectorDatabase.query).toHaveBeenNthCalledWith(
            2,
            expect.any(String),
            expect.stringContaining('TowerRegistry'),
            SEARCH_OUTPUT_FIELDS,
            80
        );
    });

    it('deduplicates nested vector results from the same logical block', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.search.mockResolvedValue([
            createVectorResult({
                id: 'render-worker-method',
                content: [
                    'this.renderWorkerBridge.flushPendingPayloads();',
                    'this.ready = true;',
                    'this.flushComplete = true;',
                ].join('\n'),
                relativePath: 'src/workers/bridge/renderWorkerBridge.ts',
                startLine: 45,
                endLine: 52,
            }, 0.99),
            createVectorResult({
                id: 'render-worker-class',
                content: [
                    'export class RenderWorkerBridge {',
                    '    constructor(private readonly worker: Worker) {}',
                    '    flushPendingPayloads(): void {',
                    '        this.ready = true;',
                    '        this.flushComplete = true;',
                    '    }',
                    '}',
                ].join('\n'),
                relativePath: 'src/workers/bridge/renderWorkerBridge.ts',
                startLine: 28,
                endLine: 90,
            }, 0.98),
            createVectorResult({
                id: 'game-room',
                content: 'export class GameRoom {}',
                relativePath: 'server/src/rooms/GameRoom.ts',
                startLine: 1,
                endLine: 10,
            }, 0.8),
        ]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'duplicate snippets audit', 10, 0.3);
        const renderWorkerResults = results.filter(result => result.relativePath === 'src/workers/bridge/renderWorkerBridge.ts');

        expect(renderWorkerResults).toHaveLength(1);
        expect(renderWorkerResults[0].content).toMatch(/^export class RenderWorkerBridge/);
        expect(results.map(result => result.relativePath)).toContain('server/src/rooms/GameRoom.ts');
    });

    it('deduplicates unavailable line ranges by normalized content containment', async () => {
        const vectorDatabase = createVectorDatabase();
        const canonicalFunction = [
            'export function packVisionSources(payload: WorkerPayload): PackedPayload {',
            '    const sources = payload.sources.map(source => source.id).join(",");',
            '    return { ...payload, packedSources: sources, packedAt: Date.now() };',
            '}',
        ].join('\n');
        vectorDatabase.search.mockResolvedValue([
            createVectorResult({
                id: 'overlapped-packer',
                content: [
                    'this.previousPayload = null;',
                    canonicalFunction,
                ].join('\n'),
                relativePath: 'src/workers/payloadPacker.ts',
                startLine: 0,
                endLine: 0,
            }, 0.99),
            createVectorResult({
                id: 'canonical-packer',
                content: canonicalFunction,
                relativePath: 'src/workers/payloadPacker.ts',
                startLine: 0,
                endLine: 0,
            }, 0.98),
        ]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'duplicate snippets audit', 10, 0.3);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            relativePath: 'src/workers/payloadPacker.ts',
            lineRangeUnavailable: true,
        });
        expect(results[0].content).toBe(canonicalFunction);
    });

    it('keeps distinct shifted overlap chunks without treating them as duplicate snippets', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.search.mockResolvedValue([
            createVectorResult({
                id: 'packed-vision-sources',
                content: [
                    'export interface PackedVisionSources {',
                    '    buffer: Float32Array;',
                    '    count: number;',
                    '}',
                ].join('\n'),
                relativePath: 'src/workers/payloadPacker.ts',
                startLine: 7,
                endLine: 10,
            }, 0.99),
            createVectorResult({
                id: 'overlapped-building-positions',
                content: [
                    '    buffer: Float32Array;',
                    '    count: number;',
                    '}',
                    '',
                    'export interface PackedBuildingPositions {',
                    '    buffer: Float32Array;',
                    '    count: number;',
                    '}',
                ].join('\n'),
                relativePath: 'src/workers/payloadPacker.ts',
                startLine: 8,
                endLine: 15,
            }, 0.98),
        ]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'duplicate snippets audit', 10, 0.3);

        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({
            relativePath: 'src/workers/payloadPacker.ts',
            startLine: 7,
            endLine: 10,
        });
        expect(results[1]).toMatchObject({
            relativePath: 'src/workers/payloadPacker.ts',
            startLine: 8,
            endLine: 15,
        });
    });

    it('does not run lexical supplement for broad natural language queries', async () => {
        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
        });

        const results = await context.semanticSearch('/repo', 'player ready countdown start', 5, 0.3);

        expect(results[0].relativePath).toBe('server/src/rooms/GameRoom.ts');
        expect(results[0].scoreReason).toBe('semantic_match');
        expect(vectorDatabase.query).not.toHaveBeenCalled();
    });
});
