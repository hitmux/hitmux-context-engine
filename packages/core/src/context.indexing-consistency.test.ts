import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Context } from './context';
import { Embedding, EmbeddingVector } from './embedding';
import { CodeChunk, Splitter } from './splitter';
import { FileSynchronizer } from './sync/synchronizer';
import { InsertOptions, VectorDatabase, VectorDocument } from './vectordb';

class TestEmbedding extends Embedding {
    protected maxTokens = 8192;

    async detectDimension(): Promise<number> { return 3; }
    async embed(): Promise<EmbeddingVector> { return { vector: [1, 0, 0], dimension: 3 }; }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map(() => ({ vector: [1, 0, 0], dimension: 3 }));
    }
    getDimension(): number { return 3; }
    getProvider(): string { return 'test'; }
}

class LineSplitter implements Splitter {
    async split(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        if (code.trim().length === 0) return [];
        return code.split('\n').map((content, index) => ({
            content,
            metadata: { startLine: index + 1, endLine: index + 1, language, filePath },
        }));
    }
    setChunkSize(): void { }
    setChunkOverlap(): void { }
}

describe('Context indexing consistency', () => {
    let tempRoot: string;
    let originalHome: string | undefined;
    let originalUserProfile: string | undefined;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hce-indexing-consistency-'));
        originalHome = process.env.HOME;
        process.env.HOME = path.join(tempRoot, 'home');
        originalUserProfile = process.env.USERPROFILE;
        process.env.USERPROFILE = process.env.HOME;
        const configDir = path.join(process.env.HOME, '.hitmux-context-engine');
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(path.join(configDir, 'config.conf'), [
            'embeddingBatchSize = 1',
            'embeddingConcurrency = 1',
            'fileProcessingConcurrency = 1',
        ].join('\n'));
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (originalUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = originalUserProfile;
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    async function createFixture(options: { hybridMode?: boolean; index?: boolean; files?: Record<string, string> } = {}) {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        for (const [file, content] of Object.entries(options.files ?? { 'index.ts': 'export const value = 1;' })) {
            await fs.writeFile(path.join(project, file), content);
        }
        const documents = new Map<string, VectorDocument>();
        const write = async (_collection: string, batch: VectorDocument[], insertOptions?: InsertOptions): Promise<void> => {
            for (const document of batch) {
                if (documents.has(document.id) && !insertOptions?.upsert) {
                    throw new Error('Duplicate insert without upsert');
                }
                documents.set(document.id, document);
            }
        };
        const finalize = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
        const vectorDatabase: jest.Mocked<VectorDatabase> = {
            createCollection: jest.fn().mockResolvedValue(undefined),
            createHybridCollection: jest.fn().mockResolvedValue(undefined),
            ensureHybridCollectionReady: jest.fn().mockResolvedValue(undefined),
            dropCollection: jest.fn().mockResolvedValue(undefined),
            hasCollection: jest.fn().mockResolvedValue(false),
            listCollections: jest.fn().mockResolvedValue([]),
            insert: jest.fn(write),
            insertHybrid: jest.fn(write),
            finalizeCollectionWrites: finalize,
            search: jest.fn().mockResolvedValue([]),
            hybridSearch: jest.fn().mockResolvedValue([]),
            delete: jest.fn(async (_collection, ids) => {
                for (const id of ids) documents.delete(id);
            }),
            query: jest.fn(async (_collection, filter, _outputFields: string[], _limit?: number) => {
                const relativePath = JSON.parse(filter.slice('relativePath == '.length)) as string;
                return [...documents.values()]
                    .filter(document => document.relativePath === relativePath)
                    .map(document => ({ id: document.id }));
            }),
            getCollectionDescription: jest.fn().mockResolvedValue(`hitmuxContext:${JSON.stringify({
                version: 1,
                codebasePath: project,
                embedding: { provider: 'test', model: 'unknown', dimension: 3 },
                schemaVersion: 2,
                metadataVersion: 2,
            })}`),
            checkCollectionLimit: jest.fn().mockResolvedValue(true),
            getCollectionRowCount: jest.fn(async (_collection: string) => documents.size),
            writeIndexManifest: jest.fn().mockResolvedValue(undefined),
        };
        const embedding = new TestEmbedding();
        const splitter = new LineSplitter();
        const context = new Context({ hybridMode: options.hybridMode ?? false, embedding, vectorDatabase, codeSplitter: splitter });
        if (options.index !== false) await context.indexCodebase(project);
        jest.clearAllMocks();
        return { context, project, documents, vectorDatabase, embedding, splitter, write, finalize };
    }

    it.each(['missing', 'split', 'empty'])('does not commit a full-index baseline after a %s file failure', async (failure) => {
        const { context, project, vectorDatabase, splitter } = await createFixture({ index: false });
        if (failure === 'missing') {
            jest.spyOn(context as unknown as { getCodeFiles: () => Promise<string[]> }, 'getCodeFiles')
                .mockResolvedValueOnce([path.join(project, 'missing.ts')]);
        } else if (failure === 'split') {
            jest.spyOn(splitter, 'split').mockRejectedValueOnce(new Error('injected split failure'));
        } else {
            jest.spyOn(splitter, 'split').mockResolvedValueOnce([]);
        }

        await expect(context.indexCodebase(project)).rejects.toThrow('Failed to index file');
        expect(vectorDatabase.writeIndexManifest).not.toHaveBeenCalled();
        const synchronizer = new FileSynchronizer(project, [], ['.ts']);
        await synchronizer.initialize({ createSnapshotIfMissing: false });
        await expect(synchronizer.checkChangedPaths(['index.ts'], { deferSnapshotUpdate: true })).resolves.toEqual({
            added: ['index.ts'], removed: [], modified: [],
        });
    });

    const failureCases = [false, true].flatMap(hybridMode =>
        ['split', 'empty', 'embedding', 'insert', 'finalize', 'abort'].map(failure => ({ hybridMode, failure }))
    );
    it.each(failureCases)('retains old chunks after $failure failure (hybrid: $hybridMode) and converges on retry', async ({ hybridMode, failure }) => {
        const { context, project, documents, vectorDatabase, embedding, splitter, write, finalize } = await createFixture({ hybridMode });
        const [oldDocument] = documents.values();
        const nextLines = ['export const value = 2;', 'export const added = true;'];
        await fs.writeFile(path.join(project, 'index.ts'), nextLines.join('\n'));
        const insert = hybridMode ? vectorDatabase.insertHybrid : vectorDatabase.insert;
        const controller = new AbortController();
        if (failure === 'split') jest.spyOn(splitter, 'split').mockRejectedValueOnce(new Error('injected split failure'));
        if (failure === 'empty') jest.spyOn(splitter, 'split').mockResolvedValueOnce([]);
        if (failure === 'embedding') jest.spyOn(embedding, 'embedBatch').mockRejectedValueOnce(new Error('injected embedding failure'));
        if (failure === 'insert') {
            insert.mockImplementationOnce(async (...args) => {
                await write(...args);
                throw new Error('injected insert failure after a partial write');
            });
        }
        if (failure === 'finalize') finalize.mockRejectedValueOnce(new Error('injected finalize failure'));
        if (failure === 'abort') {
            insert.mockImplementationOnce(async (...args) => {
                await write(...args);
                controller.abort();
            });
        }

        await expect(context.reindexChangedPaths(
            project, ['index.ts'], undefined, [], [], undefined, [], undefined, { abortSignal: controller.signal }
        )).rejects.toThrow();
        expect(documents.get(oldDocument.id)).toEqual(oldDocument);
        expect(vectorDatabase.delete).not.toHaveBeenCalled();
        expect(vectorDatabase.writeIndexManifest).not.toHaveBeenCalled();
        const synchronizer = new FileSynchronizer(project, [], ['.ts']);
        await synchronizer.initialize();
        await expect(synchronizer.checkChangedPaths(['index.ts'], { deferSnapshotUpdate: true })).resolves.toEqual({
            added: [], removed: [], modified: ['index.ts'],
        });

        await expect(context.reindexChangedPaths(project, ['index.ts'])).resolves.toEqual({ added: 0, removed: 0, modified: 1 });
        expect([...documents.values()].map(document => document.content).sort()).toEqual([...nextLines].sort());
        expect(insert.mock.calls.every(([, , insertOptions]) => insertOptions?.upsert === true)).toBe(true);
        expect(documents.has(oldDocument.id)).toBe(false);
    });

    it('does not delete removed files before all replacement writes succeed', async () => {
        const { context, project, documents, vectorDatabase, embedding } = await createFixture({
            files: { 'index.ts': 'export const value = 1;', 'removed.ts': 'export const removed = true;' },
        });
        const oldDocuments = new Map(documents);
        await fs.rm(path.join(project, 'removed.ts'));
        await fs.writeFile(path.join(project, 'index.ts'), 'export const value = 2;');
        jest.spyOn(embedding, 'embedBatch').mockRejectedValueOnce(new Error('injected failure'));

        await expect(context.reindexChangedPaths(project, ['index.ts', 'removed.ts'])).rejects.toThrow('injected failure');
        expect(documents).toEqual(oldDocuments);
        expect(vectorDatabase.delete).not.toHaveBeenCalled();
        await context.reindexChangedPaths(project, ['index.ts', 'removed.ts']);
        expect([...documents.values()].map(document => document.content)).toEqual(['export const value = 2;']);
    });

    it('retains unchanged chunk IDs and finalizes replacements before deleting stale chunks', async () => {
        const sharedLine = 'export const shared = true;';
        const { context, project, documents, vectorDatabase, finalize } = await createFixture({
            files: { 'index.ts': `${sharedLine}\nexport const value = 1;` },
        });
        const oldDocuments = [...documents.values()];
        const shared = oldDocuments.find(document => document.content === sharedLine)!;
        const stale = oldDocuments.find(document => document.content !== sharedLine)!;
        await fs.writeFile(path.join(project, 'index.ts'), `${sharedLine}\nexport const value = 2;`);

        await context.reindexChangedPaths(project, ['index.ts']);
        expect(documents.get(shared.id)).toEqual(shared);
        expect(documents.has(stale.id)).toBe(false);
        expect(documents.size).toBe(2);
        expect(vectorDatabase.delete).toHaveBeenCalledWith(context.getCollectionName(project), [stale.id]);
        expect(finalize.mock.invocationCallOrder[0])
            .toBeLessThan(vectorDatabase.delete.mock.invocationCallOrder[0]);
    });

    it('cleans up partial writes for a previously added file when retrying with different content', async () => {
        const { context, project, documents, vectorDatabase, write } = await createFixture();
        const addedPath = path.join(project, 'added.ts');
        await fs.writeFile(addedPath, 'export const firstAttempt = true;');
        vectorDatabase.insert.mockImplementationOnce(async (...args) => {
            await write(...args);
            throw new Error('injected insert failure');
        });
        await expect(context.reindexChangedPaths(project, ['added.ts'])).rejects.toThrow('injected insert failure');
        await fs.writeFile(addedPath, 'export const finalAttempt = true;');

        await expect(context.reindexChangedPaths(project, ['added.ts'])).resolves.toEqual({ added: 1, removed: 0, modified: 0 });
        expect([...documents.values()].filter(document => document.relativePath === 'added.ts').map(document => document.content))
            .toEqual(['export const finalAttempt = true;']);
    });

    it.each(['targeted', 'full scan'])('recovers files restored to the snapshot after a partial write (%s)', async (retryMode) => {
        const { context, project, documents, finalize } = await createFixture();
        const original = 'export const value = 1;';
        const added = 'src/added.ts';
        await fs.mkdir(path.join(project, 'src'));
        await fs.writeFile(path.join(project, added), 'export const extra = true;');
        await fs.writeFile(path.join(project, 'index.ts'), 'export const changed = true;');
        finalize.mockRejectedValueOnce(new Error('failed after writing vectors'));

        await expect(context.reindexChangedPaths(project, [added, 'index.ts'])).rejects.toThrow('failed after writing vectors');
        expect(documents.size).toBe(3);
        await fs.rm(path.join(project, added));
        await fs.writeFile(path.join(project, 'index.ts'), original);

        const retry = retryMode === 'targeted'
            ? () => context.reindexChangedPaths(project, [])
            : () => context.reindexByChange(project);
        await expect(retry()).resolves.toEqual({ added: 0, removed: 1, modified: 1 });
        expect([...documents.values()].map(document => document.content)).toEqual([original]);
        await expect(retry()).resolves.toEqual({ added: 0, removed: 0, modified: 0 });
    });

    const symlinkTest = process.platform === 'win32' ? it.skip : it;
    symlinkTest('indexes regular sources alongside dangling and valid symlinks', async () => {
        const { context, project, documents } = await createFixture({ index: false });
        await fs.symlink('absent-target', path.join(project, 'dangling.ts'));
        await fs.symlink('index.ts', path.join(project, 'alias.ts'));

        await expect(context.indexCodebase(project)).resolves.toMatchObject({ indexedFiles: 1, status: 'completed' });
        await expect(context.reindexByChange(project)).resolves.toEqual({ added: 0, removed: 0, modified: 0 });
        await expect(context.reindexChangedPaths(project, ['dangling.ts', 'alias.ts'])).resolves.toEqual({
            added: 0, removed: 0, modified: 0,
        });
        expect([...documents.values()].map(document => document.relativePath)).toEqual(['index.ts']);
    });

    it('leaves the snapshot pending when stale-chunk deletion fails and converges on retry', async () => {
        const { context, project, documents, vectorDatabase } = await createFixture();
        await fs.writeFile(path.join(project, 'index.ts'), 'export const value = 2;');
        vectorDatabase.delete.mockRejectedValueOnce(new Error('injected delete failure'));

        await expect(context.reindexChangedPaths(project, ['index.ts'])).rejects.toThrow('injected delete failure');
        expect(vectorDatabase.writeIndexManifest).not.toHaveBeenCalled();
        await expect(context.reindexChangedPaths(project, ['index.ts'])).resolves.toEqual({ added: 0, removed: 0, modified: 1 });
        expect([...documents.values()].map(document => document.content)).toEqual(['export const value = 2;']);
    });

    it('does not delete old chunks or commit the snapshot after hitting the incremental chunk limit', async () => {
        const { context, project, documents, vectorDatabase } = await createFixture();
        const oldDocuments = new Map(documents);
        await fs.writeFile(path.join(project, 'index.ts'), 'export const value = 2;');
        const processing = jest.spyOn(context as unknown as {
            processFileList: () => Promise<{ status: string }>;
        }, 'processFileList').mockResolvedValueOnce({ status: 'limit_reached' });

        await expect(context.reindexChangedPaths(project, ['index.ts'])).rejects.toThrow('chunk limit');
        expect(documents).toEqual(oldDocuments);
        expect(vectorDatabase.delete).not.toHaveBeenCalled();
        expect(vectorDatabase.writeIndexManifest).not.toHaveBeenCalled();
        processing.mockRestore();
        await expect(context.reindexChangedPaths(project, ['index.ts'])).resolves.toEqual({ added: 0, removed: 0, modified: 1 });
    });

    it('removes old chunks when a file legitimately becomes empty', async () => {
        const { context, project, documents } = await createFixture();
        await fs.writeFile(path.join(project, 'index.ts'), '');

        await expect(context.reindexChangedPaths(project, ['index.ts'])).resolves.toEqual({ added: 0, removed: 0, modified: 1 });
        expect(documents.size).toBe(0);
        await expect(context.reindexChangedPaths(project, ['index.ts'])).resolves.toEqual({ added: 0, removed: 0, modified: 0 });
    });
});
