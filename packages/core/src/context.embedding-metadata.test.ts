import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { CollectionSchemaMismatchError, Context, EmbeddingModelMismatchError } from './context';
import { Embedding, EmbeddingVector } from './embedding';
import { FileSynchronizer } from './sync/synchronizer';
import { normalizeCodebaseIdentityPath } from './utils/path-identity';
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
    getCollectionRowCount: jest.fn().mockResolvedValue(999),
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
        await fs.writeFile(path.join(configDir, 'config.conf'), stringifyConf(config), 'utf-8');
    }

    function createDescription(
        codebasePath: string,
        model: string = 'model-a',
        dimension: number = 3,
        schemaVersion: number = 2,
        metadataVersion: number = 2
    ): string {
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
                schemaVersion,
                metadataVersion,
                splitterType: 'ast',
                createdAt: '2026-06-10T00:00:00.000Z',
            })}`,
        ].join('\n');
    }

    async function createProjectSnapshot(project: string): Promise<void> {
        await fs.mkdir(project, { recursive: true });
        await fs.writeFile(path.join(project, 'index.ts'), 'export const value = 1;\n', 'utf-8');
        const synchronizer = new FileSynchronizer(project, [], ['.ts']);
        await synchronizer.initialize();
        await synchronizer.checkForChanges();
    }

    function getMerkleSnapshotPath(codebasePath: string): string {
        const normalizedPath = normalizeCodebaseIdentityPath(codebasePath);
        const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
        return path.join(homeDir, '.hitmux-context-engine', 'merkle', `${hash}.json`);
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
        expect(metadata).toMatchObject({
            schemaVersion: 2,
            metadataVersion: 2,
            splitterType: 'ast',
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
        expect(vectorDatabase.getCollectionDescription).toHaveBeenCalledTimes(1);
        expect(vectorDatabase.createCollection).not.toHaveBeenCalled();
    });

    it('rejects semantic search when the collection embedding metadata does not match', async () => {
        const project = path.join(tempRoot, 'project');
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(true);
        vectorDatabase.getCollectionRowCount.mockResolvedValue(1);
        vectorDatabase.getCollectionDescription.mockResolvedValue(createDescription(project, 'model-a', 3));

        const context = new Context({
            embedding: new TestEmbedding('test', 'model-b', 3),
            vectorDatabase,
        });

        await expect(context.semanticSearch(project, 'query')).rejects.toBeInstanceOf(EmbeddingModelMismatchError);
        expect(vectorDatabase.search).not.toHaveBeenCalled();
        expect(vectorDatabase.hybridSearch).not.toHaveBeenCalled();
    });

    it('rejects an existing collection that uses legacy search metadata schema', async () => {
        const project = path.join(tempRoot, 'project');
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(true);
        vectorDatabase.getCollectionDescription.mockResolvedValue(createDescription(project, 'model-a', 3, 1, 1));

        const context = new Context({
            embedding: new TestEmbedding('test', 'model-a', 3),
            vectorDatabase,
        });

        await expect(context.getPreparedCollection(project)).rejects.toBeInstanceOf(CollectionSchemaMismatchError);
        expect(vectorDatabase.createCollection).not.toHaveBeenCalled();
    });

    it.each([
        {
            label: 'same-dimension model mismatch',
            description: (project: string) => createDescription(project, 'model-a', 3),
            embedding: new TestEmbedding('test', 'model-b', 3),
            errorType: EmbeddingModelMismatchError,
        },
        {
            label: 'dimension mismatch',
            description: (project: string) => createDescription(project, 'model-a', 3),
            embedding: new TestEmbedding('test', 'model-a', 4),
            errorType: EmbeddingModelMismatchError,
        },
        {
            label: 'schema mismatch',
            description: (project: string) => createDescription(project, 'model-a', 3, 1, 2),
            embedding: new TestEmbedding('test', 'model-a', 3),
            errorType: CollectionSchemaMismatchError,
        },
    ])('rejects incremental writes before deleting chunks on $label', async ({ description, embedding, errorType }) => {
        const project = path.join(tempRoot, 'project-incremental-mismatch');
        await createProjectSnapshot(project);
        await fs.writeFile(path.join(project, 'index.ts'), 'export const value = 2;\n', 'utf-8');

        const vectorDatabase = createVectorDatabase();
        vectorDatabase.getCollectionDescription.mockResolvedValue(description(project));
        vectorDatabase.query.mockResolvedValue([{ id: 'old-chunk' }]);
        const context = new Context({
            embedding,
            vectorDatabase,
        });

        await expect(context.reindexChangedPaths(project, ['index.ts'])).rejects.toBeInstanceOf(errorType);

        expect(vectorDatabase.query).not.toHaveBeenCalled();
        expect(vectorDatabase.delete).not.toHaveBeenCalled();
        expect(vectorDatabase.insert).not.toHaveBeenCalled();

        const synchronizer = new FileSynchronizer(project, [], ['.ts']);
        await synchronizer.initialize();
        await expect(synchronizer.checkChangedPaths(['index.ts'])).resolves.toMatchObject({
            modified: ['index.ts'],
        });
    });

    it('rejects incremental metadata mismatch before creating a missing Merkle baseline', async () => {
        const project = path.join(tempRoot, 'project-incremental-no-baseline');
        await fs.mkdir(project, { recursive: true });
        await fs.writeFile(path.join(project, 'index.ts'), 'export const value = 1;\n', 'utf-8');

        const vectorDatabase = createVectorDatabase();
        vectorDatabase.getCollectionDescription.mockResolvedValue(createDescription(project, 'model-a', 3));
        const context = new Context({
            embedding: new TestEmbedding('test', 'model-b', 3),
            vectorDatabase,
        });

        await expect(context.reindexChangedPaths(project, ['index.ts'])).rejects.toBeInstanceOf(EmbeddingModelMismatchError);
        await expect(fs.access(getMerkleSnapshotPath(project))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(vectorDatabase.query).not.toHaveBeenCalled();
        expect(vectorDatabase.delete).not.toHaveBeenCalled();
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
    });

    it('rejects incremental metadata mismatch even when no content changes are detected', async () => {
        const project = path.join(tempRoot, 'project-incremental-no-content-change');
        await createProjectSnapshot(project);

        const vectorDatabase = createVectorDatabase();
        vectorDatabase.getCollectionDescription.mockResolvedValue(createDescription(project, 'model-a', 3));
        const context = new Context({
            embedding: new TestEmbedding('test', 'model-b', 3),
            vectorDatabase,
        });

        await expect(context.reindexChangedPaths(project, ['index.ts'])).rejects.toBeInstanceOf(EmbeddingModelMismatchError);
        expect(vectorDatabase.query).not.toHaveBeenCalled();
        expect(vectorDatabase.delete).not.toHaveBeenCalled();
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
    });
});

function stringifyConf(config: Record<string, unknown>): string {
    return Object.entries(config)
        .flatMap(([key, value]) => Array.isArray(value)
            ? value.map(item => `${key} = ${String(item)}`)
            : [`${key} = ${String(value)}`])
        .join('\n') + '\n';
}
