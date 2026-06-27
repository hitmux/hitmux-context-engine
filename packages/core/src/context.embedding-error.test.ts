import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Context, EmbeddingError, IndexingVerificationError } from './context';
import { Embedding, EmbeddingVector } from './embedding';
import { Splitter, CodeChunk } from './splitter';
import { VectorDatabase } from './vectordb';

type EmbeddingMode = 'throw' | 'empty' | 'short' | 'mixed-dimensions';

class FailingEmbedding extends Embedding {
    protected maxTokens = 8192;
    public batchTexts: string[][] = [];

    constructor(private readonly mode: EmbeddingMode) {
        super();
    }

    async detectDimension(): Promise<number> {
        return 3;
    }

    async embed(_text: string): Promise<EmbeddingVector> {
        return { vector: [1, 0, 0], dimension: 3 };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        this.batchTexts.push([...texts]);
        if (this.mode === 'throw') {
            throw new Error('quota exhausted');
        }

        if (this.mode === 'empty') {
            return [];
        }

        if (this.mode === 'mixed-dimensions') {
            return texts.map((_text, index) => ({
                vector: index === 0 ? [1, 0, 0] : [1, 0, 0, 0],
                dimension: index === 0 ? 3 : 4,
            }));
        }

        return texts.slice(0, Math.max(0, texts.length - 1)).map(() => ({
            vector: [1, 0, 0],
            dimension: 3,
        }));
    }

    getDimension(): number {
        return 3;
    }

    getProvider(): string {
        return 'test';
    }
}

class HealthyEmbedding extends FailingEmbedding {
    constructor() {
        super('empty');
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map(() => ({ vector: [1, 0, 0], dimension: 3 }));
    }
}

class FailsOnSecondFileEmbedding extends HealthyEmbedding {
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        if (texts.some(text => text.includes('two'))) {
            throw new Error('quota exhausted on second file');
        }

        return super.embedBatch(texts);
    }
}

class OneChunkSplitter implements Splitter {
    async split(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        return [{
            content: code,
            metadata: {
                startLine: 1,
                endLine: 1,
                language,
                filePath,
            },
        }];
    }

    setChunkSize(): void { }
    setChunkOverlap(): void { }
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

describe('Context embedding failure handling', () => {
    let tempRoot: string;
    let originalHome: string | undefined;
    let homeDir: string;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hitmux-context-engine-embedding-error-'));
        homeDir = path.join(tempRoot, 'home');
        await fs.mkdir(homeDir, { recursive: true });
        originalHome = process.env.HOME;
        process.env.HOME = homeDir;
        await writeConfig({ hybridMode: false });
    });

    afterEach(async () => {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    async function writeConfig(config: Record<string, unknown>): Promise<void> {
        const configDir = path.join(homeDir, '.hitmux-context-engine');
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(path.join(configDir, 'config.conf'), stringifyConf(config), 'utf-8');
    }

    async function createProject(): Promise<string> {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'one.ts'), 'const one = 1;');
        await fs.writeFile(path.join(project, 'two.ts'), 'const two = 2;');
        return project;
    }

    it('propagates embedding API errors instead of treating them as file skips', async () => {
        await writeConfig({ hybridMode: false, embeddingBatchSize: 1 });
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new FailingEmbedding('throw'),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project)).rejects.toThrow(EmbeddingError);
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
        expect(vectorDatabase.insertHybrid).not.toHaveBeenCalled();
    });

    it('propagates duplicate embedding failures without inserting partial documents', async () => {
        const project = path.join(tempRoot, 'duplicate-failure-project');
        await fs.mkdir(project);
        const content = 'export const duplicated = 1;\n';
        await fs.writeFile(path.join(project, 'one.ts'), content);
        await fs.writeFile(path.join(project, 'two.ts'), content);
        await writeProjectConfig(project, { embeddingBatchSize: 10 });
        const embedding = new FailingEmbedding('throw');
        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding,
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project)).rejects.toThrow(EmbeddingError);
        expect(embedding.batchTexts).toEqual([[content]]);
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
        expect(vectorDatabase.insertHybrid).not.toHaveBeenCalled();
    });

    it('rejects empty embedding batches before inserting documents', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new FailingEmbedding('empty'),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project)).rejects.toThrow('Embedding API returned 0 embeddings for 2 chunks');
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
        expect(vectorDatabase.insertHybrid).not.toHaveBeenCalled();
    });

    it('rejects embedding batches that do not match the chunk count', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new FailingEmbedding('short'),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project)).rejects.toThrow('Embedding API returned 1 embeddings for 2 chunks');
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
        expect(vectorDatabase.insertHybrid).not.toHaveBeenCalled();
    });

    it('rejects embedding batches with inconsistent vector dimensions before inserting documents', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new FailingEmbedding('mixed-dimensions'),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project)).rejects.toThrow('Embedding API returned inconsistent vector dimensions in one batch');
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
        expect(vectorDatabase.insertHybrid).not.toHaveBeenCalled();
    });

    it('propagates vector database insert failures instead of reporting indexing success', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.insert.mockRejectedValue(new Error('Milvus insert failed'));
        const context = new Context({
            hybridMode: false,
            embedding: new HealthyEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project)).rejects.toThrow('Milvus insert failed');
    });

    it('propagates mid-index vector database insert failures instead of treating them as file skips', async () => {
        await writeConfig({ hybridMode: false, embeddingBatchSize: 1 });
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.insert.mockRejectedValueOnce(new Error('Milvus insert failed mid-index'));
        vectorDatabase.getCollectionRowCount.mockResolvedValue(1);
        const context = new Context({
            hybridMode: false,
            embedding: new HealthyEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project)).rejects.toThrow('Milvus insert failed mid-index');
        expect(vectorDatabase.insert).toHaveBeenCalledTimes(1);
    });

    it('waits for in-flight vector writes to settle before reporting a concurrent embedding failure', async () => {
        const project = await createProject();
        await writeProjectConfig(project, {
            embeddingBatchSize: 1,
            embeddingConcurrency: 2,
            fileProcessingConcurrency: 1
        });
        const oneFile = path.join(project, 'one.ts');
        const twoFile = path.join(project, 'two.ts');
        const vectorDatabase = createVectorDatabase();
        let releaseInsert!: () => void;
        const insertStarted = new Promise<void>((resolve) => {
            vectorDatabase.insert.mockImplementationOnce(async () => {
                resolve();
                await new Promise<void>((insertResolve) => {
                    releaseInsert = insertResolve;
                });
            });
        });
        const context = new Context({
            hybridMode: false,
            embedding: new FailsOnSecondFileEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });
        const getCodeFilesSpy = jest
            .spyOn(context as unknown as { getCodeFiles: () => Promise<string[]> }, 'getCodeFiles')
            .mockResolvedValue([oneFile, twoFile]);

        try {
            const indexPromise = context.indexCodebase(project);
            let settled = false;
            indexPromise.catch(() => {
                settled = true;
            });

            await expect(Promise.race([
                insertStarted,
                sleep(1000).then(() => {
                    throw new Error('first insert did not start');
                })
            ])).resolves.toBeUndefined();
            await sleep(25);
            expect(settled).toBe(false);

            releaseInsert();
            await expect(indexPromise).rejects.toThrow(EmbeddingError);
            expect(settled).toBe(true);
        } finally {
            getCodeFilesSpy.mockRestore();
        }
    });

    it('rejects completed indexing when the target collection remains empty', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.getCollectionRowCount.mockResolvedValue(0);
        const context = new Context({
            hybridMode: false,
            embedding: new HealthyEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project)).rejects.toBeInstanceOf(IndexingVerificationError);
    });

    it('rejects completed indexing when fewer searchable rows than chunks are visible', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.getCollectionRowCount.mockResolvedValue(1);
        const context = new Context({
            hybridMode: false,
            embedding: new HealthyEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project)).rejects.toThrow(
            `Indexing produced 2 chunks but collection '${context.getCollectionName(project)}' has only 1 searchable row(s)`
        );
    });

    it('rejects completed indexing when row count cannot be verified', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.getCollectionRowCount.mockResolvedValue(-1);
        const context = new Context({
            hybridMode: false,
            embedding: new HealthyEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project)).rejects.toThrow(
            `Indexing produced 2 chunks but collection '${context.getCollectionName(project)}' row count could not be verified`
        );
    });
});

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeProjectConfig(projectRoot: string, config: Record<string, unknown>): Promise<void> {
    const configDir = path.join(projectRoot, '.hitmux-context-engine');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'config.conf'), stringifyConf(config), 'utf-8');
}

function stringifyConf(config: Record<string, unknown>): string {
    return Object.entries(config)
        .flatMap(([key, value]) => Array.isArray(value)
            ? value.map(item => `${key} = ${String(item)}`)
            : [`${key} = ${String(value)}`])
        .join('\n') + '\n';
}
