import * as fs from 'fs/promises';
import * as nodeFs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Context, ExistingCollectionFullIndexError } from './context';
import { Embedding, EmbeddingVector } from './embedding';
import { FileSynchronizer } from './sync/synchronizer';
import { Splitter, CodeChunk } from './splitter';
import { VectorDatabase } from './vectordb';

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

class NamedTestEmbedding extends TestEmbedding {
    constructor(
        private readonly provider: string,
        private readonly model: string = 'unknown'
    ) {
        super();
    }

    getProvider(): string {
        return this.provider;
    }

    getModel(): string {
        return this.model;
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

class SlowTrackingEmbedding extends TestEmbedding {
    public activeRequests = 0;
    public maxActiveRequests = 0;

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        this.activeRequests += 1;
        this.maxActiveRequests = Math.max(this.maxActiveRequests, this.activeRequests);
        try {
            await sleep(25);
            return texts.map(() => ({ vector: [1, 0, 0], dimension: 3 }));
        } finally {
            this.activeRequests -= 1;
        }
    }
}

class BatchDimensionEmbedding extends TestEmbedding {
    public detectCalls = 0;

    async detectDimension(): Promise<number> {
        this.detectCalls += 1;
        throw new Error('detectDimension should not be called before first full-index embedding batch');
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map(() => ({ vector: [1, 0, 0, 0, 0], dimension: 5 }));
    }

    getDimension(): number {
        return 5;
    }
}

class SlowTrackingSplitter implements Splitter {
    public activeSplits = 0;
    public maxActiveSplits = 0;

    async split(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        this.activeSplits += 1;
        this.maxActiveSplits = Math.max(this.maxActiveSplits, this.activeSplits);
        try {
            await sleep(25);
            return [{
                content: code,
                metadata: {
                    startLine: 1,
                    endLine: 1,
                    language,
                    filePath,
                },
            }];
        } finally {
            this.activeSplits -= 1;
        }
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

describe('Context indexing lifecycle', () => {
    let tempRoot: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hitmux-context-engine-indexing-lifecycle-'));
        const homeDir = path.join(tempRoot, 'home');
        await fs.mkdir(homeDir, { recursive: true });
        originalHome = process.env.HOME;
        process.env.HOME = homeDir;
        await writeConfig(homeDir, { hybridMode: false });
    });

    afterEach(async () => {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    async function createProject(): Promise<string> {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'index.ts'), 'export const value = 1;');
        return project;
    }

    function createDescription(codebasePath: string): string {
        return [
            `codebasePath:${codebasePath}`,
            `hitmuxContext:${JSON.stringify({
                version: 1,
                codebasePath,
                embedding: {
                    provider: 'test',
                    model: 'unknown',
                    dimension: 3,
                },
                schemaVersion: 2,
                metadataVersion: 2,
                splitterType: 'ast',
                createdAt: '2026-06-20T00:00:00.000Z',
            })}`,
        ].join('\n');
    }

    async function createProjectSnapshot(project: string): Promise<void> {
        const synchronizer = new FileSynchronizer(project, [], ['.ts']);
        await synchronizer.initialize();
        await synchronizer.checkForChanges();
    }

    async function indexProjectAndReadTimingSummary(
        project: string,
        embedding: Embedding = new TestEmbedding()
    ): Promise<Record<string, unknown>> {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.getCollectionRowCount.mockResolvedValue(1);
        const context = new Context({
            hybridMode: false,
            embedding,
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            await context.indexCodebase(project);
            const timingCall = logSpy.mock.calls.find(([message]) => message === '[Context] ⏱️ Indexing timing summary:');
            expect(timingCall).toBeDefined();
            return timingCall?.[1] as Record<string, unknown>;
        } finally {
            logSpy.mockRestore();
        }
    }

    it('rejects ordinary full indexing when the collection already exists', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(true);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project)).rejects.toBeInstanceOf(ExistingCollectionFullIndexError);
        expect(vectorDatabase.dropCollection).not.toHaveBeenCalled();
        expect(vectorDatabase.createCollection).not.toHaveBeenCalled();
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
    });

    it('does not treat an empty collection as an existing searchable index', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(true);
        vectorDatabase.getCollectionRowCount.mockResolvedValue(0);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.hasIndex(project)).resolves.toBe(false);
    });

    it('recreates an empty collection during full indexing', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(true);
        vectorDatabase.getCollectionRowCount
            .mockResolvedValueOnce(0)
            .mockResolvedValue(1);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });
        vectorDatabase.getCollectionDescription.mockResolvedValue(
            (context as any).createCollectionDescription(project, {
                provider: 'test',
                model: 'unknown',
                dimension: 3,
            })
        );

        await expect(context.indexCodebase(project)).resolves.toMatchObject({
            indexedFiles: 1,
            totalChunks: 1,
            status: 'completed',
        });
        expect(vectorDatabase.dropCollection).toHaveBeenCalledWith(context.getCollectionName(project));
        expect(vectorDatabase.createCollection).toHaveBeenCalledWith(
            context.getCollectionName(project),
            3,
            expect.stringContaining('"dimension":3')
        );
        expect(vectorDatabase.insert).toHaveBeenCalled();
    });

    it('creates a Merkle baseline during core-only full indexing for the first incremental sync', async () => {
        const project = await createProject();
        await fs.writeFile(path.join(project, 'removed.ts'), 'export const removed = true;');
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.getCollectionRowCount.mockResolvedValue(2);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });
        vectorDatabase.getCollectionDescription.mockResolvedValue(createDescription(project));

        await expect(context.indexCodebase(project)).resolves.toMatchObject({
            indexedFiles: 2,
            totalChunks: 2,
            status: 'completed',
        });

        await fs.writeFile(path.join(project, 'index.ts'), 'export const value = 2;');
        await fs.writeFile(path.join(project, 'added.ts'), 'export const added = true;');
        await fs.rm(path.join(project, 'removed.ts'));

        await expect(context.reindexByChange(project)).resolves.toEqual({
            added: 1,
            removed: 1,
            modified: 1,
        });
    });

    it('does not commit a full-index Merkle baseline when indexing stops at the chunk limit', async () => {
        const project = await createProject();
        await fs.writeFile(path.join(project, 'skipped.ts'), 'export const skipped = true;');
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.getCollectionRowCount.mockResolvedValue(1);
        vectorDatabase.readIndexManifest = jest.fn().mockResolvedValue(null);
        vectorDatabase.writeIndexManifest = jest.fn().mockResolvedValue(undefined);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });
        const processFileListSpy = jest
            .spyOn(context as any, 'processFileList')
            .mockResolvedValue({
                processedFiles: 1,
                totalChunks: 1,
                status: 'limit_reached',
                embeddingBatchSize: 100,
                embeddingConcurrency: 5,
                fileProcessingConcurrency: 2,
            });

        try {
            await expect(context.indexCodebase(project)).resolves.toMatchObject({
                indexedFiles: 1,
                totalChunks: 1,
                status: 'limit_reached',
            });
        } finally {
            processFileListSpy.mockRestore();
        }

        expect(vectorDatabase.writeIndexManifest).toHaveBeenCalledWith(expect.objectContaining({
            codebasePath: project,
            collectionName: context.getCollectionName(project),
            status: 'limit_reached',
            indexedFiles: 1,
            totalChunks: 1,
        }));

        const synchronizer = new FileSynchronizer(project, [], ['.ts']);
        await synchronizer.initialize({ createSnapshotIfMissing: false });
        await expect(synchronizer.checkForChanges({ deferSnapshotUpdate: true })).resolves.toMatchObject({
            added: expect.arrayContaining(['index.ts', 'skipped.ts']),
        });
    });

    it('refreshes the remote manifest when incremental sync has no changes', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.getCollectionRowCount.mockResolvedValue(1);
        vectorDatabase.readIndexManifest = jest.fn().mockResolvedValue(null);
        vectorDatabase.writeIndexManifest = jest.fn().mockResolvedValue(undefined);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });
        vectorDatabase.getCollectionDescription.mockResolvedValue(createDescription(project));

        await expect(context.indexCodebase(project)).resolves.toMatchObject({
            indexedFiles: 1,
            totalChunks: 1,
            status: 'completed',
        });

        await expect(context.reindexByChange(project)).resolves.toEqual({
            added: 0,
            removed: 0,
            modified: 0,
        });

        expect(vectorDatabase.writeIndexManifest).toHaveBeenCalledTimes(2);
        expect(vectorDatabase.writeIndexManifest).toHaveBeenLastCalledWith(expect.objectContaining({
            codebasePath: project,
            collectionName: context.getCollectionName(project),
            status: 'completed',
            indexedFiles: 1,
            totalChunks: 1,
        }));
    });

    it('logs indexing timing summary with runtime batch settings', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase() as jest.Mocked<VectorDatabase> & {
            drainPerformanceMetrics: jest.Mock<{ flushLoadMs: number }, []>;
        };
        vectorDatabase.drainPerformanceMetrics = jest.fn()
            .mockReturnValueOnce({ flushLoadMs: 0 })
            .mockReturnValueOnce({ flushLoadMs: 7 })
            .mockReturnValue({ flushLoadMs: 0 });
        vectorDatabase.getCollectionRowCount.mockResolvedValue(1);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            await expect(context.indexCodebase(project)).resolves.toMatchObject({
                indexedFiles: 1,
                totalChunks: 1,
                status: 'completed',
            });

            const timingCall = logSpy.mock.calls.find(([message]) => message === '[Context] ⏱️ Indexing timing summary:');
            expect(timingCall).toBeDefined();
            const summary = timingCall?.[1] as Record<string, unknown>;
            expect(summary).toMatchObject({
                codebasePath: project,
                indexedFiles: 1,
                totalChunks: 1,
                embeddingBatchSize: 64,
                embeddingConcurrency: 2,
                fileProcessingConcurrency: 1,
                flushLoadMs: 7,
            });
            for (const key of [
                'totalIndexingMs',
                'prepareCollectionMs',
                'loadIgnorePatternsMs',
                'scanFilesMs',
                'fileWeightStatMs',
                'readAndSplitMs',
                'embeddingMs',
                'vectorInsertMs',
                'verifyMs',
            ]) {
                expect(typeof summary[key]).toBe('number');
            }
            expect(typeof summary.filesPerSecond).toBe('number');
            expect(typeof summary.chunksPerSecond).toBe('number');
        } finally {
            logSpy.mockRestore();
        }
    });

    it('uses provider-specific embedding defaults when batch and concurrency are not configured', async () => {
        const project = await createProject();

        const summary = await indexProjectAndReadTimingSummary(
            project,
            new NamedTestEmbedding('Ollama', 'nomic-embed-text')
        );

        expect(summary).toMatchObject({
            embeddingBatchSize: 16,
            embeddingConcurrency: 1,
        });
    });

    it('keeps explicit embedding batch and concurrency config above provider defaults', async () => {
        const project = await createProject();
        await writeProjectConfig(project, {
            embeddingProvider: 'Ollama',
            embeddingBatchSize: 7,
            embeddingConcurrency: 3,
        });

        const summary = await indexProjectAndReadTimingSummary(project);

        expect(summary).toMatchObject({
            embeddingBatchSize: 7,
            embeddingConcurrency: 3,
        });
    });

    it('defers vector flush/load during full indexing and finalizes once before verification', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase() as jest.Mocked<VectorDatabase> & {
            finalizeCollectionWrites: jest.Mock<Promise<void>, [string]>;
        };
        vectorDatabase.finalizeCollectionWrites = jest.fn().mockResolvedValue(undefined);
        vectorDatabase.getCollectionRowCount.mockResolvedValue(1);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project)).resolves.toMatchObject({
            indexedFiles: 1,
            totalChunks: 1,
            status: 'completed',
        });

        expect(vectorDatabase.insert).toHaveBeenCalledWith(
            context.getCollectionName(project),
            expect.any(Array),
            { deferFlushLoad: true }
        );
        expect(vectorDatabase.finalizeCollectionWrites).toHaveBeenCalledTimes(1);
        expect(vectorDatabase.finalizeCollectionWrites).toHaveBeenCalledWith(context.getCollectionName(project));
        expect(vectorDatabase.getCollectionRowCount).toHaveBeenCalledWith(context.getCollectionName(project));
    });

    it('does not fail clearIndex when remote manifest deletion fails', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(true);
        vectorDatabase.deleteIndexManifest = jest.fn().mockRejectedValue(new Error('manifest delete failed'));
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            await expect(context.clearIndex(project)).resolves.toBeUndefined();
        } finally {
            warnSpy.mockRestore();
        }

        expect(vectorDatabase.dropCollection).toHaveBeenCalledWith(context.getCollectionName(project));
        expect(vectorDatabase.deleteIndexManifest).toHaveBeenCalledWith(
            context.getCollectionName(project),
            project
        );
    });

    it('finalizes removed-only incremental deletes before committing the Merkle snapshot', async () => {
        const project = await createProject();
        await createProjectSnapshot(project);
        await fs.rm(path.join(project, 'index.ts'));

        const vectorDatabase = createVectorDatabase() as jest.Mocked<VectorDatabase> & {
            finalizeCollectionWrites: jest.Mock<Promise<void>, [string]>;
        };
        vectorDatabase.getCollectionDescription.mockResolvedValue(createDescription(project));
        vectorDatabase.query.mockResolvedValue([{ id: 'old-chunk' }]);
        vectorDatabase.finalizeCollectionWrites = jest.fn().mockResolvedValue(undefined);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.reindexChangedPaths(project, ['index.ts'])).resolves.toEqual({
            added: 0,
            removed: 1,
            modified: 0,
        });

        expect(vectorDatabase.delete).toHaveBeenCalledWith(context.getCollectionName(project), ['old-chunk']);
        expect(vectorDatabase.finalizeCollectionWrites).toHaveBeenCalledWith(context.getCollectionName(project));

        const synchronizer = new FileSynchronizer(project, [], ['.ts']);
        await synchronizer.initialize();
        await expect(synchronizer.checkChangedPaths(['index.ts'])).resolves.toMatchObject({
            removed: [],
        });
    });

    it('does not commit the Merkle snapshot when incremental finalize fails', async () => {
        const project = await createProject();
        await createProjectSnapshot(project);
        await fs.rm(path.join(project, 'index.ts'));

        const vectorDatabase = createVectorDatabase() as jest.Mocked<VectorDatabase> & {
            finalizeCollectionWrites: jest.Mock<Promise<void>, [string]>;
        };
        vectorDatabase.getCollectionDescription.mockResolvedValue(createDescription(project));
        vectorDatabase.query.mockResolvedValue([{ id: 'old-chunk' }]);
        vectorDatabase.finalizeCollectionWrites = jest.fn().mockRejectedValue(new Error('flush failed'));
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.reindexChangedPaths(project, ['index.ts'])).rejects.toThrow('flush failed');

        const synchronizer = new FileSynchronizer(project, [], ['.ts']);
        await synchronizer.initialize();
        await expect(synchronizer.checkChangedPaths(['index.ts'])).resolves.toMatchObject({
            removed: ['index.ts'],
        });
    });

    it('defers and finalizes modified incremental writes before committing the Merkle snapshot', async () => {
        const project = await createProject();
        await createProjectSnapshot(project);
        await fs.writeFile(path.join(project, 'index.ts'), 'export const value = 2;');

        const vectorDatabase = createVectorDatabase() as jest.Mocked<VectorDatabase> & {
            finalizeCollectionWrites: jest.Mock<Promise<void>, [string]>;
        };
        vectorDatabase.getCollectionDescription.mockResolvedValue(createDescription(project));
        vectorDatabase.query.mockResolvedValue([{ id: 'old-chunk' }]);
        vectorDatabase.finalizeCollectionWrites = jest.fn().mockResolvedValue(undefined);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.reindexChangedPaths(project, ['index.ts'])).resolves.toEqual({
            added: 0,
            removed: 0,
            modified: 1,
        });

        expect(vectorDatabase.insert).toHaveBeenCalledWith(
            context.getCollectionName(project),
            expect.any(Array),
            { deferFlushLoad: true }
        );
        expect(vectorDatabase.finalizeCollectionWrites).toHaveBeenCalledWith(context.getCollectionName(project));

        const synchronizer = new FileSynchronizer(project, [], ['.ts']);
        await synchronizer.initialize();
        await expect(synchronizer.checkChangedPaths(['index.ts'])).resolves.toMatchObject({
            modified: [],
        });
    });

    it('does not drop the collection when local Merkle snapshot cleanup fails', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(true);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });
        const deleteSnapshotSpy = jest.spyOn(FileSynchronizer, 'deleteSnapshot')
            .mockRejectedValueOnce(new Error('unlink failed'));

        try {
            await expect(context.clearIndex(project)).rejects.toThrow('unlink failed');
            expect(vectorDatabase.dropCollection).not.toHaveBeenCalled();
        } finally {
            deleteSnapshotSpy.mockRestore();
        }
    });

    it('creates a new full-index collection from the first embedding batch dimension', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.getCollectionRowCount.mockResolvedValue(1);
        const embedding = new BatchDimensionEmbedding();
        const context = new Context({
            hybridMode: false,
            embedding,
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project)).resolves.toMatchObject({
            indexedFiles: 1,
            totalChunks: 1,
            status: 'completed',
        });

        expect(embedding.detectCalls).toBe(0);
        expect(vectorDatabase.createCollection).toHaveBeenCalledTimes(1);
        expect(vectorDatabase.createCollection).toHaveBeenCalledWith(
            context.getCollectionName(project),
            5,
            expect.stringContaining('"dimension":5')
        );
        expect(vectorDatabase.insert).toHaveBeenCalledWith(
            context.getCollectionName(project),
            expect.arrayContaining([
                expect.objectContaining({ vector: [1, 0, 0, 0, 0] })
            ]),
            { deferFlushLoad: true }
        );
    });

    it('reuses discovered file sizes for weighted progress', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'small.ts'), 'x');
        await fs.writeFile(path.join(project, 'large.ts'), 'x'.repeat(10_000));
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.getCollectionRowCount.mockResolvedValue(2);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });
        const statSpy = jest.spyOn(nodeFs.promises, 'stat');
        let indexedFileStats: string[] = [];

        try {
            await expect(context.indexCodebase(project)).resolves.toMatchObject({
                indexedFiles: 2,
                totalChunks: 2,
                status: 'completed',
            });
            indexedFileStats = statSpy.mock.calls
                .map(([filePath]) => String(filePath))
                .filter(filePath => filePath === path.join(project, 'small.ts') || filePath === path.join(project, 'large.ts'));
        } finally {
            statSpy.mockRestore();
        }

        expect(new Set(indexedFileStats)).toEqual(new Set([
            path.join(project, 'small.ts'),
            path.join(project, 'large.ts')
        ]));
    });

    it('keeps weighted progress monotonic when file updates arrive out of size order', async () => {
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase: createVectorDatabase(),
            codeSplitter: new OneChunkSplitter(),
        });
        const smallFile = path.join(tempRoot, 'small.ts');
        const largeFile = path.join(tempRoot, 'large.ts');
        const progress: Array<{ phase: string; current: number; total: number; percentage: number }> = [];
        const tracker = await (context as unknown as {
            createWeightedFileProgressTracker: (
                filePaths: string[],
                startPercentage: number,
                endPercentage: number,
                progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
                knownFileSizes?: Map<string, number>
            ) => Promise<{
                updateFile: (filePath: string, fileProgress: number, phase: string) => void;
                completeFile: (filePath: string, phase: string) => void;
            }>;
        }).createWeightedFileProgressTracker(
            [smallFile, largeFile],
            10,
            95,
            update => progress.push(update),
            new Map([
                [smallFile, 1],
                [largeFile, 10_000],
            ])
        );

        tracker.updateFile(largeFile, 0.5, 'large half');
        tracker.completeFile(smallFile, 'small complete');

        for (let i = 1; i < progress.length; i++) {
            expect(progress[i].percentage).toBeGreaterThanOrEqual(progress[i - 1].percentage);
        }
    });

    it('allows force reindexing to replace an existing collection', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(true);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project, undefined, true)).resolves.toMatchObject({
            indexedFiles: 1,
            totalChunks: 1,
            status: 'completed',
        });
        expect(vectorDatabase.dropCollection).toHaveBeenCalledWith(context.getCollectionName(project));
        expect(vectorDatabase.createCollection).toHaveBeenCalled();
        expect(vectorDatabase.insert).toHaveBeenCalled();
    });

    it('weights full indexing progress by file size instead of file count', async () => {
        const project = path.join(tempRoot, 'weighted-progress-project');
        await fs.mkdir(project);
        const smallFile = path.join(project, 'small.ts');
        const largeFile = path.join(project, 'large.ts');
        await fs.writeFile(smallFile, 'x');
        await fs.writeFile(largeFile, 'x'.repeat(10_000));
        await writeProjectConfig(project, { fileProcessingConcurrency: 1 });

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });
        const getCodeFilesSpy = jest
            .spyOn(context as unknown as { getCodeFiles: () => Promise<string[]> }, 'getCodeFiles')
            .mockResolvedValue([smallFile, largeFile]);
        const progress: Array<{ phase: string; current: number; total: number; percentage: number }> = [];

        try {
            await context.indexCodebase(project, update => progress.push(update));
        } finally {
            getCodeFilesSpy.mockRestore();
        }

        const firstFileComplete = progress.find(update => update.phase === 'Processing files (1/2)...');
        expect(firstFileComplete?.percentage).toBeLessThan(20);
        expect(progress.some(update => update.percentage === 95)).toBe(true);
        expect(progress.at(-1)?.percentage).toBe(100);
    });

    it('limits concurrent embedding batches across parallel index operations', async () => {
        const firstProject = await createProjectWithFiles(tempRoot, 'project-a', 3);
        const secondProject = await createProjectWithFiles(tempRoot, 'project-b', 3);
        await writeProjectConfig(firstProject, {
            embeddingBatchSize: 1,
            embeddingConcurrency: 2
        });
        await writeProjectConfig(secondProject, {
            embeddingBatchSize: 1,
            embeddingConcurrency: 2
        });
        const embedding = new SlowTrackingEmbedding();
        const context = new Context({
            hybridMode: false,
            embedding,
            vectorDatabase: createVectorDatabase(),
            codeSplitter: new OneChunkSplitter(),
        });

        const processFileList = (context as unknown as {
            processFileList: (
                filePaths: string[],
                codebasePath: string,
                onFileProcessed?: (filePath: string, fileIndex: number, totalFiles: number) => void,
                splitter?: Splitter
            ) => Promise<unknown>;
        }).processFileList.bind(context);
        const firstFiles = await listProjectFiles(firstProject);
        const secondFiles = await listProjectFiles(secondProject);

        await Promise.all([
            processFileList(firstFiles, firstProject, undefined, new OneChunkSplitter()),
            processFileList(secondFiles, secondProject, undefined, new OneChunkSplitter())
        ]);

        expect(embedding.maxActiveRequests).toBeGreaterThan(1);
        expect(embedding.maxActiveRequests).toBeLessThanOrEqual(2);
    });

    it('processes file read/split work with configured bounded concurrency', async () => {
        const project = await createProjectWithFiles(tempRoot, 'split-concurrency-project', 4);
        await writeProjectConfig(project, {
            fileProcessingConcurrency: 2,
            embeddingBatchSize: 100,
        });
        const splitter = new SlowTrackingSplitter();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.getCollectionRowCount.mockResolvedValue(4);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: splitter,
        });

        await expect(context.indexCodebase(project)).resolves.toMatchObject({
            indexedFiles: 4,
            totalChunks: 4,
            status: 'completed',
        });

        expect(splitter.maxActiveSplits).toBeGreaterThan(1);
        expect(splitter.maxActiveSplits).toBeLessThanOrEqual(2);
    });

    it('keeps configured file read/split concurrency when a non-aborted signal is present', async () => {
        const project = await createProjectWithFiles(tempRoot, 'split-signal-concurrency-project', 4);
        await writeProjectConfig(project, {
            fileProcessingConcurrency: 2,
            embeddingBatchSize: 100,
        });
        const splitter = new SlowTrackingSplitter();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.getCollectionRowCount.mockResolvedValue(4);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: splitter,
        });
        const controller = new AbortController();

        await expect(
            context.indexCodebase(project, undefined, false, [], [], undefined, controller.signal)
        ).resolves.toMatchObject({
            indexedFiles: 4,
            totalChunks: 4,
            status: 'completed',
        });

        expect(splitter.maxActiveSplits).toBeGreaterThan(1);
        expect(splitter.maxActiveSplits).toBeLessThanOrEqual(2);
    });

    it('skips oversized files before reading them into memory', async () => {
        const project = await createProjectWithFiles(tempRoot, 'oversized-file-project', 1);
        const filePath = path.join(project, 'file-0.ts');
        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });
        const readFileSpy = jest.spyOn(nodeFs.promises, 'readFile');
        const processFileList = (context as unknown as {
            processFileList: (
                filePaths: string[],
                codebasePath: string,
                onFileProcessed?: (filePath: string, fileIndex: number, totalFiles: number) => void,
                splitter?: Splitter,
                signal?: AbortSignal,
                onFileProgress?: unknown,
                timingMetrics?: unknown,
                options?: { knownFileSizes?: Map<string, number> }
            ) => Promise<{ processedFiles: number; totalChunks: number }>;
        }).processFileList.bind(context);

        try {
            const result = await processFileList(
                [filePath],
                project,
                undefined,
                new OneChunkSplitter(),
                undefined,
                undefined,
                undefined,
                { knownFileSizes: new Map([[filePath, 129 * 1024 * 1024]]) }
            );

            expect(result).toMatchObject({ processedFiles: 0, totalChunks: 0 });
            expect(readFileSpy).not.toHaveBeenCalledWith(filePath, 'utf-8');
            expect(vectorDatabase.insert).not.toHaveBeenCalled();
        } finally {
            readFileSpy.mockRestore();
        }
    });
});

async function createProjectWithFiles(root: string, name: string, count: number): Promise<string> {
    const project = path.join(root, name);
    await fs.mkdir(project, { recursive: true });
    for (let i = 0; i < count; i++) {
        await fs.writeFile(path.join(project, `file-${i}.ts`), `export const value${i} = ${i};`);
    }
    return project;
}

async function listProjectFiles(project: string): Promise<string[]> {
    const entries = await fs.readdir(project, { withFileTypes: true });
    return entries
        .filter(entry => entry.isFile())
        .map(entry => path.join(project, entry.name));
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeConfig(homeDir: string, config: Record<string, unknown>): Promise<void> {
    const configDir = path.join(homeDir, '.hitmux-context-engine');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'config.conf'), stringifyConf(config), 'utf-8');
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
