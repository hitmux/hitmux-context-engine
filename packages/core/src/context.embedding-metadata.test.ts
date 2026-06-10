import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Context, EmbeddingModelMismatchError } from './context';
import { Embedding, EmbeddingVector } from './embedding';
import { VectorDatabase } from './vectordb';

class TestEmbedding extends Embedding {
    protected maxTokens = 8192;

    constructor(
        private readonly provider: string = 'test',
        private readonly model: string = 'model-a',
        private readonly dimension: number = 3
    ) {
        super();
    }

    async detectDimension(): Promise<number> {
        return this.dimension;
    }

    async embed(_text: string): Promise<EmbeddingVector> {
        return { vector: Array(this.dimension).fill(1), dimension: this.dimension };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map(() => ({ vector: Array(this.dimension).fill(1), dimension: this.dimension }));
    }

    getDimension(): number {
        return this.dimension;
    }

    getProvider(): string {
        return this.provider;
    }

    getModel(): string {
        return this.model;
    }
}

const createVectorDatabase = (): jest.Mocked<VectorDatabase> => ({
    createCollection: jest.fn().mockResolvedValue(undefined),
    createHybridCollection: jest.fn().mockResolvedValue(undefined),
    ensureHybridCollectionReady: jest.fn().mockResolvedValue(undefined),
    dropCollection: jest.fn().mockResolvedValue(undefined),
    hasCollection: jest.fn().mockResolvedValue(false),
    listCollections: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockResolvedValue(undefined),
    insertHybrid: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    hybridSearch: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
    getCollectionDescription: jest.fn().mockResolvedValue(''),
    checkCollectionLimit: jest.fn().mockResolvedValue(true),
    getCollectionRowCount: jest.fn().mockResolvedValue(-1),
});

describe('Context embedding collection metadata', () => {
    let tempRoot: string;
    let homeDir: string;
    let originalHome: string | undefined;
    let originalSkip: string | undefined;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hitmux-context-engine-embedding-metadata-'));
        homeDir = path.join(tempRoot, 'home');
        await fs.mkdir(homeDir, { recursive: true });
        originalHome = process.env.HOME;
        originalSkip = process.env.HITMUX_CONTEXT_ENGINE_SKIP_EMBEDDING_MODEL_CHECK;
        process.env.HOME = homeDir;
        delete process.env.HITMUX_CONTEXT_ENGINE_SKIP_EMBEDDING_MODEL_CHECK;
        await writeConfig({ hybridMode: false });
    });

    afterEach(async () => {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }

        if (originalSkip === undefined) {
            delete process.env.HITMUX_CONTEXT_ENGINE_SKIP_EMBEDDING_MODEL_CHECK;
        } else {
            process.env.HITMUX_CONTEXT_ENGINE_SKIP_EMBEDDING_MODEL_CHECK = originalSkip;
        }

        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    async function writeConfig(config: Record<string, unknown>): Promise<void> {
        const configDir = path.join(homeDir, '.hitmux-context-engine');
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(path.join(configDir, 'config.jsonc'), JSON.stringify(config), 'utf-8');
    }

    function createDescription(codebasePath: string, model: string = 'model-a', dimension: number = 3): string {
        return [
            `codebasePath:${codebasePath}`,
            `hitmuxContext:${JSON.stringify({
                version: 1,
                codebasePath,
                embedding: {
                    provider: 'test',
                    model,
                    dimension,
                },
                createdAt: '2026-06-10T00:00:00.000Z',
            })}`,
        ].join('\n');
    }

    it('stores embedding provider, model, and dimension in collection description', async () => {
        const project = path.join(tempRoot, 'project');
        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding('test', 'model-a', 3),
            vectorDatabase,
        });

        await context.getPreparedCollection(project);

        expect(vectorDatabase.createHybridCollection).toHaveBeenCalledTimes(1);
        const description = vectorDatabase.createHybridCollection.mock.calls[0][2];
        expect(description).toContain(`codebasePath:${project}`);
        expect(description).toContain('hitmuxContext:');

        const metadataLine = description!.split(/\r?\n/).find((line) => line.startsWith('hitmuxContext:'))!;
        const metadata = JSON.parse(metadataLine.slice('hitmuxContext:'.length));
        expect(metadata.embedding).toEqual({
            provider: 'test',
            model: 'model-a',
            dimension: 3,
        });
    });

    it('rejects an existing collection indexed with a different embedding model', async () => {
        const project = path.join(tempRoot, 'project');
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(true);
        vectorDatabase.getCollectionDescription.mockResolvedValue(createDescription(project, 'model-a', 3));

        const context = new Context({
            embedding: new TestEmbedding('test', 'model-b', 3),
            vectorDatabase,
        });

        await expect(context.getPreparedCollection(project)).rejects.toBeInstanceOf(EmbeddingModelMismatchError);
        expect(vectorDatabase.createCollection).not.toHaveBeenCalled();
    });

    it('allows an existing collection mismatch when the skip environment variable is set', async () => {
        const project = path.join(tempRoot, 'project');
        process.env.HITMUX_CONTEXT_ENGINE_SKIP_EMBEDDING_MODEL_CHECK = 'true';
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(true);
        vectorDatabase.getCollectionDescription.mockResolvedValue(createDescription(project, 'model-a', 3));

        const context = new Context({
            embedding: new TestEmbedding('test', 'model-b', 3),
            vectorDatabase,
        });

        await expect(context.getPreparedCollection(project)).resolves.toBeUndefined();
        expect(vectorDatabase.getCollectionDescription).not.toHaveBeenCalled();
        expect(vectorDatabase.createCollection).not.toHaveBeenCalled();
    });

    it('rejects semantic search when the collection embedding metadata does not match', async () => {
        const project = path.join(tempRoot, 'project');
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(true);
        vectorDatabase.getCollectionDescription.mockResolvedValue(createDescription(project, 'model-a', 3));

        const context = new Context({
            embedding: new TestEmbedding('test', 'model-b', 3),
            vectorDatabase,
        });

        await expect(context.semanticSearch(project, 'query')).rejects.toBeInstanceOf(EmbeddingModelMismatchError);
        expect(vectorDatabase.search).not.toHaveBeenCalled();
        expect(vectorDatabase.hybridSearch).not.toHaveBeenCalled();
    });
});
