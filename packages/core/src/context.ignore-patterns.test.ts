import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Context } from './context';
import { Embedding, EmbeddingVector } from './embedding';
import { Splitter, CodeChunk } from './splitter';
import { FileSynchronizer } from './sync/synchronizer';
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

class TestSplitter implements Splitter {
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
    getCollectionRowCount: jest.fn().mockResolvedValue(-1),
});

describe('Context ignore pattern isolation', () => {
    let tempRoot: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hitmux-context-engine-ignore-'));
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

    it('does not leak file-based ignore patterns between codebases', async () => {
        const projectA = path.join(tempRoot, 'project-a');
        const projectB = path.join(tempRoot, 'project-b');
        await fs.mkdir(projectA);
        await fs.mkdir(projectB);
        await fs.writeFile(path.join(projectA, '.hitmux-context-engineignore'), '*.md\n');

        const context = new Context({ vectorDatabase: createVectorDatabase() });

        const projectAIgnores = await context.getEffectiveIgnorePatterns(projectA);
        expect(projectAIgnores).toContain('*.md');

        const projectBIgnores = await context.getEffectiveIgnorePatterns(projectB);
        expect(projectBIgnores).not.toContain('*.md');
    });

    it('does not leak request ignore patterns between calls', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        const context = new Context({ vectorDatabase: createVectorDatabase() });

        const withRequestIgnores = await context.getEffectiveIgnorePatterns(project, ['*.txt']);
        expect(withRequestIgnores).toContain('*.txt');

        const withoutRequestIgnores = await context.getEffectiveIgnorePatterns(project);
        expect(withoutRequestIgnores).not.toContain('*.txt');
    });

    it('does not leak request custom extensions into persistent supported extensions', () => {
        const context = new Context({ vectorDatabase: createVectorDatabase() });

        const withRequestExtensions = context.getEffectiveSupportedExtensions(['foo']);
        expect(withRequestExtensions).toContain('.foo');

        const withoutRequestExtensions = context.getSupportedExtensions();
        expect(withoutRequestExtensions).not.toContain('.foo');
    });

    it('does not leak request custom extensions between codebase indexes', async () => {
        const projectA = path.join(tempRoot, 'project-a');
        const projectB = path.join(tempRoot, 'project-b');
        await fs.mkdir(projectA);
        await fs.mkdir(projectB);
        await fs.writeFile(path.join(projectA, 'a.foo'), 'project a custom file');
        await fs.writeFile(path.join(projectB, 'b.foo'), 'project b custom file');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        await context.indexCodebase(projectA, undefined, false, [], ['foo']);
        expect(vectorDatabase.insert).toHaveBeenCalledTimes(1);
        expect(vectorDatabase.insert.mock.calls[0][1][0].relativePath).toBe('a.foo');

        vectorDatabase.insert.mockClear();

        await context.indexCodebase(projectB);
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
    });

    it('indexes configured extension-less files without enabling them globally', async () => {
        const projectA = path.join(tempRoot, 'project-a-extensionless');
        const projectB = path.join(tempRoot, 'project-b-extensionless');
        await fs.mkdir(projectA);
        await fs.mkdir(projectB);
        await fs.writeFile(path.join(projectA, 'Dockerfile'), 'FROM node:20');
        await fs.writeFile(path.join(projectB, 'Makefile'), 'build:\n\tpnpm build');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        await context.indexCodebase(projectA, undefined, false, [], ['extensionless']);
        expect(vectorDatabase.insert).toHaveBeenCalledTimes(1);
        expect(vectorDatabase.insert.mock.calls[0][1][0].relativePath).toBe('Dockerfile');
        expect(vectorDatabase.insert.mock.calls[0][1][0].metadata.language).toBe('text');
        expect(context.getSupportedExtensions()).not.toContain('');

        vectorDatabase.insert.mockClear();

        await context.indexCodebase(projectB);
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
    });

    it('uses request options when recreating a synchronizer for change indexing', async () => {
        const project = path.join(tempRoot, 'project-with-options');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'custom.foo'), 'custom extension file');
        await fs.writeFile(path.join(project, 'ignored.ts'), 'ignored by request pattern');

        const context = new Context({ vectorDatabase: createVectorDatabase() });

        try {
            await context.reindexByChange(project, undefined, ['*.ts'], ['foo']);

            const collectionName = context.getCollectionName(project);
            const synchronizer = context.getSynchronizers().get(collectionName);

            expect(synchronizer).toBeDefined();
            expect(synchronizer?.getFileHash('custom.foo')).toBeDefined();
            expect(synchronizer?.getFileHash('ignored.ts')).toBeUndefined();
            expect(context.getSupportedExtensions()).not.toContain('.foo');
        } finally {
            await FileSynchronizer.deleteSnapshot(project);
        }
    });

    it('treats leading-slash directory ignore patterns as root-anchored and recursive during indexing', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(path.join(project, 'Library'), { recursive: true });
        await fs.mkdir(path.join(project, 'src', 'Library'), { recursive: true });
        await fs.writeFile(path.join(project, '.gitignore'), '/Library/\n');
        await fs.writeFile(path.join(project, 'Library', 'generated.md'), 'root library should be ignored');
        await fs.writeFile(path.join(project, 'src', 'Library', 'nested.md'), 'nested library should stay');
        await fs.writeFile(path.join(project, 'src', 'keep.md'), 'regular file should stay');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        await context.indexCodebase(project);

        const insertedDocuments = vectorDatabase.insert.mock.calls
            .flatMap(([, documents]) => documents);
        const indexedPaths = insertedDocuments
            .map(document => document.relativePath.replace(/\\/g, '/'))
            .sort();

        expect(indexedPaths).toEqual([
            'src/Library/nested.md',
            'src/keep.md',
        ]);
    });

    it('honors gitignore negation patterns during indexing', async () => {
        const project = path.join(tempRoot, 'project-gitignore-negation');
        await fs.mkdir(path.join(project, 'src'), { recursive: true });
        await fs.writeFile(path.join(project, '.gitignore'), '*.ts\n!src/keep.ts\n');
        await fs.writeFile(path.join(project, 'src', 'drop.ts'), 'ignored file');
        await fs.writeFile(path.join(project, 'src', 'keep.ts'), 'unignored file');
        await fs.writeFile(path.join(project, 'src', 'keep.md'), 'regular file');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        await context.indexCodebase(project);

        const insertedDocuments = vectorDatabase.insert.mock.calls
            .flatMap(([, documents]) => documents);
        const indexedPaths = insertedDocuments
            .map(document => document.relativePath.replace(/\\/g, '/'))
            .sort();

        expect(indexedPaths).toEqual([
            'src/keep.md',
            'src/keep.ts',
        ]);
    });

    it('honors double-star gitignore patterns during indexing', async () => {
        const project = path.join(tempRoot, 'project-gitignore-double-star');
        await fs.mkdir(path.join(project, 'src', 'generated'), { recursive: true });
        await fs.mkdir(path.join(project, 'src', 'nested', 'generated'), { recursive: true });
        await fs.writeFile(path.join(project, '.gitignore'), 'src/**/generated/*.ts\n');
        await fs.writeFile(path.join(project, 'src', 'generated', 'drop.ts'), 'ignored generated file');
        await fs.writeFile(path.join(project, 'src', 'nested', 'generated', 'drop.ts'), 'ignored nested generated file');
        await fs.writeFile(path.join(project, 'src', 'nested', 'keep.ts'), 'regular file');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        await context.indexCodebase(project);

        const insertedDocuments = vectorDatabase.insert.mock.calls
            .flatMap(([, documents]) => documents);
        const indexedPaths = insertedDocuments
            .map(document => document.relativePath.replace(/\\/g, '/'))
            .sort();

        expect(indexedPaths).toEqual(['src/nested/keep.ts']);
    });

    it('honors nested gitignore files relative to their directory during indexing', async () => {
        const project = path.join(tempRoot, 'project-nested-gitignore');
        await fs.mkdir(path.join(project, 'src', 'nested'), { recursive: true });
        await fs.writeFile(path.join(project, 'src', '.gitignore'), '*.ts\n!keep.ts\n');
        await fs.writeFile(path.join(project, 'root.ts'), 'root file should stay');
        await fs.writeFile(path.join(project, 'src', 'drop.ts'), 'nested ignore should drop this');
        await fs.writeFile(path.join(project, 'src', 'keep.ts'), 'nested ignore should keep this');
        await fs.writeFile(path.join(project, 'src', 'nested', 'drop.ts'), 'nested ignore should drop descendants too');
        await fs.writeFile(path.join(project, 'src', 'nested', 'keep.md'), 'regular file');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        await context.indexCodebase(project);

        const insertedDocuments = vectorDatabase.insert.mock.calls
            .flatMap(([, documents]) => documents);
        const indexedPaths = insertedDocuments
            .map(document => document.relativePath.replace(/\\/g, '/'))
            .sort();

        expect(indexedPaths).toEqual([
            'root.ts',
            'src/keep.ts',
            'src/nested/keep.md',
        ]);
    });

    it('skips dotfiles and dot directories during initial indexing', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(path.join(project, '.config'), { recursive: true });
        await fs.mkdir(path.join(project, '.github', 'workflows'), { recursive: true });
        await fs.mkdir(path.join(project, 'src', '.cache'), { recursive: true });
        await fs.mkdir(path.join(project, 'src'), { recursive: true });

        await fs.writeFile(path.join(project, '.hidden.md'), 'root hidden file should be ignored');
        await fs.writeFile(path.join(project, '.config', 'settings.md'), 'hidden dir should be ignored');
        await fs.writeFile(path.join(project, '.github', 'workflows', 'ci.md'), 'hidden nested dir should be ignored');
        await fs.writeFile(path.join(project, 'src', '.cache', 'generated.md'), 'nested hidden dir should be ignored');
        await fs.writeFile(path.join(project, 'src', 'keep.md'), 'regular file should stay');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        await context.indexCodebase(project);

        const insertedDocuments = vectorDatabase.insert.mock.calls
            .flatMap(([, documents]) => documents);
        const indexedPaths = insertedDocuments
            .map(document => document.relativePath.replace(/\\/g, '/'))
            .sort();

        expect(indexedPaths).toEqual(['src/keep.md']);
    });

    it('keeps dotfile skipping active when request ignore patterns are provided', async () => {
        const project = path.join(tempRoot, 'project-with-request-ignores');
        await fs.mkdir(path.join(project, '.config'), { recursive: true });
        await fs.mkdir(path.join(project, 'src'), { recursive: true });

        await fs.writeFile(path.join(project, '.config', 'settings.ts'), 'hidden dir should be ignored');
        await fs.writeFile(path.join(project, 'src', 'ignored.ts'), 'request ignore should be ignored');
        await fs.writeFile(path.join(project, 'src', 'keep.ts'), 'regular file should stay');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        await context.indexCodebase(project, undefined, false, ['src/ignored.ts']);

        const insertedDocuments = vectorDatabase.insert.mock.calls
            .flatMap(([, documents]) => documents);
        const indexedPaths = insertedDocuments
            .map(document => document.relativePath.replace(/\\/g, '/'))
            .sort();

        expect(indexedPaths).toEqual(['src/keep.ts']);
    });

    it('loads request-scoped additional ignore files during indexing', async () => {
        const project = path.join(tempRoot, 'project-with-extra-ignore-file');
        await fs.mkdir(path.join(project, 'src'), { recursive: true });
        await fs.writeFile(path.join(project, 'extra.ignore'), 'src/generated.ts\n');
        await fs.writeFile(path.join(project, 'src', 'generated.ts'), 'generated file should be ignored');
        await fs.writeFile(path.join(project, 'src', 'keep.ts'), 'regular file should stay');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        await context.indexCodebase(project, undefined, false, [], [], undefined, undefined, {
            additionalIgnoreFiles: ['extra.ignore']
        });

        const insertedDocuments = vectorDatabase.insert.mock.calls
            .flatMap(([, documents]) => documents);
        const indexedPaths = insertedDocuments
            .map(document => document.relativePath.replace(/\\/g, '/'))
            .sort();

        expect(indexedPaths).toEqual(['src/keep.ts']);
    });

    it('previews indexable files without creating collections or inserting vectors', async () => {
        const project = path.join(tempRoot, 'project-preview');
        await fs.mkdir(path.join(project, 'src'), { recursive: true });
        await fs.writeFile(path.join(project, '.hitmux-context-engineignore'), 'src/generated.ts\n');
        await fs.writeFile(path.join(project, 'src', 'generated.ts'), 'generated file should be ignored');
        await fs.writeFile(path.join(project, 'src', 'keep.ts'), 'regular file should stay');
        await fs.writeFile(path.join(project, 'src', 'extra.foo'), 'custom extension file should stay');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        const preview = await context.previewIndexableFiles(project, [], ['foo']);

        expect(preview.totalFiles).toBe(2);
        expect(preview.files).toEqual([
            'src/extra.foo',
            'src/keep.ts',
        ]);
        expect(vectorDatabase.createCollection).not.toHaveBeenCalled();
        expect(vectorDatabase.createHybridCollection).not.toHaveBeenCalled();
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
        expect(vectorDatabase.insertHybrid).not.toHaveBeenCalled();
    });

    it('limits indexing traversal by maxDepth', async () => {
        const project = path.join(tempRoot, 'project-with-depth-limit');
        await fs.mkdir(path.join(project, 'src', 'nested'), { recursive: true });
        await fs.writeFile(path.join(project, 'root.ts'), 'root file should stay');
        await fs.writeFile(path.join(project, 'src', 'child.ts'), 'child file should stay');
        await fs.writeFile(path.join(project, 'src', 'nested', 'deep.ts'), 'deep file should be skipped');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        await context.indexCodebase(project, undefined, false, [], [], undefined, undefined, {
            maxDepth: 1
        });

        const insertedDocuments = vectorDatabase.insert.mock.calls
            .flatMap(([, documents]) => documents);
        const indexedPaths = insertedDocuments
            .map(document => document.relativePath.replace(/\\/g, '/'))
            .sort();

        expect(indexedPaths).toEqual([
            'root.ts',
            'src/child.ts',
        ]);
    });

    it('treats leading-slash directory ignore patterns as root-anchored and recursive during sync', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(path.join(project, 'Library'), { recursive: true });
        await fs.mkdir(path.join(project, 'src', 'Library'), { recursive: true });
        await fs.writeFile(path.join(project, 'Library', 'generated.md'), 'root library should be ignored');
        await fs.writeFile(path.join(project, 'src', 'Library', 'nested.md'), 'nested library should stay');
        await fs.writeFile(path.join(project, 'src', 'keep.md'), 'regular file should stay');

        const synchronizer = new FileSynchronizer(project, ['/Library/'], ['.md']);
        const fileHashes = await (synchronizer as any).generateFileHashes(project) as Map<string, string>;

        expect(fileHashes.has(path.join('Library', 'generated.md'))).toBe(false);
        expect(fileHashes.has(path.join('src', 'Library', 'nested.md'))).toBe(true);
        expect(fileHashes.has(path.join('src', 'keep.md'))).toBe(true);
    });

    it('honors gitignore negation patterns during sync', async () => {
        const project = path.join(tempRoot, 'sync-gitignore-negation');
        await fs.mkdir(path.join(project, 'src'), { recursive: true });
        await fs.writeFile(path.join(project, 'src', 'drop.ts'), 'ignored file');
        await fs.writeFile(path.join(project, 'src', 'keep.ts'), 'unignored file');
        await fs.writeFile(path.join(project, 'src', 'keep.md'), 'regular file');

        const synchronizer = new FileSynchronizer(project, ['*.ts', '!src/keep.ts'], ['.ts', '.md']);
        const fileHashes = await (synchronizer as any).generateFileHashes(project) as Map<string, string>;

        expect(fileHashes.has(path.join('src', 'drop.ts'))).toBe(false);
        expect(fileHashes.has(path.join('src', 'keep.ts'))).toBe(true);
        expect(fileHashes.has(path.join('src', 'keep.md'))).toBe(true);
    });

    it('tracks configured extension-less files during sync', async () => {
        const project = path.join(tempRoot, 'sync-extensionless');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'Dockerfile'), 'FROM node:20');
        await fs.writeFile(path.join(project, 'ignored.txt'), 'not requested');

        const synchronizer = new FileSynchronizer(project, [], ['<extensionless>']);
        const fileHashes = await (synchronizer as any).generateFileHashes(project) as Map<string, string>;

        expect(fileHashes.has('Dockerfile')).toBe(true);
        expect(fileHashes.has('ignored.txt')).toBe(false);
    });
});

async function writeConfig(homeDir: string, config: Record<string, unknown>): Promise<void> {
    const configDir = path.join(homeDir, '.hitmux-context-engine');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'config.jsonc'), JSON.stringify(config), 'utf-8');
}
