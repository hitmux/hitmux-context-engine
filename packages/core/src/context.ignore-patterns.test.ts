import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Context, IncrementalIndexTooLargeError } from './context';
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

function createDescription(codebasePath: string = '/test/project'): string {
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
    getCollectionDescription: jest.fn().mockResolvedValue(createDescription()),
    checkCollectionLimit: jest.fn().mockResolvedValue(true),
    getCollectionRowCount: jest.fn().mockResolvedValue(999),
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

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: createVectorDatabase(),
        });

        const projectAIgnores = await context.getEffectiveIgnorePatterns(projectA);
        expect(projectAIgnores).toContain('*.md');

        const projectBIgnores = await context.getEffectiveIgnorePatterns(projectB);
        expect(projectBIgnores).not.toContain('*.md');
    });

    it('does not leak request ignore patterns between calls', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: createVectorDatabase(),
        });

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

    it('matches supported extensions case-insensitively', async () => {
        const project = path.join(tempRoot, 'project-uppercase-extension');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'UPPER.TS'), 'export const upper = true;');
        await fs.writeFile(path.join(project, 'BUILD.CMAKE'), 'set(SOURCES main.c)');

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
        expect(insertedDocuments.map(document => document.relativePath).sort()).toEqual([
            'BUILD.CMAKE',
            'UPPER.TS',
        ]);
    });

    it('uses target project customExtensions even when Context is constructed outside the project', async () => {
        const workspace = path.join(tempRoot, 'workspace');
        const project = path.join(tempRoot, 'project-with-config-extension');
        await fs.mkdir(workspace);
        await fs.mkdir(project);
        await writeConfig(project, { customExtensions: ['foo'] });
        await fs.writeFile(path.join(project, 'custom.foo'), 'project custom file');
        const originalCwd = process.cwd();

        const vectorDatabase = createVectorDatabase();
        try {
            process.chdir(workspace);
            const context = new Context({
                hybridMode: false,
                embedding: new TestEmbedding(),
                vectorDatabase,
                codeSplitter: new TestSplitter(),
            });

            await context.indexCodebase(project);
        } finally {
            process.chdir(originalCwd);
        }

        expect(vectorDatabase.insert).toHaveBeenCalledTimes(1);
        expect(vectorDatabase.insert.mock.calls[0][1][0].relativePath).toBe('custom.foo');
    });

    it('does not apply cwd project customExtensions to a different target project', async () => {
        const workspace = path.join(tempRoot, 'workspace-with-config');
        const project = path.join(tempRoot, 'project-without-config-extension');
        await fs.mkdir(workspace);
        await fs.mkdir(project);
        await writeConfig(workspace, { customExtensions: ['foo'] });
        await fs.writeFile(path.join(project, 'custom.foo'), 'target project should not inherit cwd config');
        const originalCwd = process.cwd();

        const vectorDatabase = createVectorDatabase();
        try {
            process.chdir(workspace);
            const context = new Context({
                hybridMode: false,
                embedding: new TestEmbedding(),
                vectorDatabase,
                codeSplitter: new TestSplitter(),
            });

            await context.indexCodebase(project);
        } finally {
            process.chdir(originalCwd);
        }

        expect(vectorDatabase.insert).not.toHaveBeenCalled();
    });

    it('uses target project customIgnorePatterns even when Context is constructed outside the project', async () => {
        const workspace = path.join(tempRoot, 'workspace');
        const project = path.join(tempRoot, 'project-with-config-ignore');
        await fs.mkdir(workspace);
        await fs.mkdir(project);
        await writeConfig(project, { customIgnorePatterns: ['ignored.ts'] });
        await fs.writeFile(path.join(project, 'ignored.ts'), 'ignored by project config');
        await fs.writeFile(path.join(project, 'kept.ts'), 'kept by project config');
        const originalCwd = process.cwd();

        const vectorDatabase = createVectorDatabase();
        try {
            process.chdir(workspace);
            const context = new Context({
                hybridMode: false,
                embedding: new TestEmbedding(),
                vectorDatabase,
                codeSplitter: new TestSplitter(),
            });

            await context.indexCodebase(project);
        } finally {
            process.chdir(originalCwd);
        }

        const insertedDocuments = vectorDatabase.insert.mock.calls
            .flatMap(([, documents]) => documents);
        expect(insertedDocuments.map(document => document.relativePath)).toEqual(['kept.ts']);
    });

    it('indexes known build and package metadata files by default without enabling all text files', async () => {
        const project = path.join(tempRoot, 'project-known-config-files');
        await fs.mkdir(project);
        await fs.mkdir(path.join(project, 'src'));
        await fs.writeFile(path.join(project, 'src', 'CMakeLists.txt'), 'set(SERVER_SOURCES server.c)');
        await fs.writeFile(path.join(project, 'pyproject.toml'), '[project]\nname = "demo"');
        await fs.writeFile(path.join(project, 'go.mod'), 'module example.com/demo');
        await fs.writeFile(path.join(project, 'package.json'), '{"scripts":{"start":"node index.js"}}');
        await fs.writeFile(path.join(project, 'notes.txt'), 'ordinary text should stay out');

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
        expect(insertedDocuments.map(document => document.relativePath).sort()).toEqual([
            'go.mod',
            'package.json',
            'pyproject.toml',
            'src/CMakeLists.txt',
        ]);
        expect(insertedDocuments.find(document => document.relativePath === 'src/CMakeLists.txt')?.metadata.language).toBe('cmake');
        expect(insertedDocuments.find(document => document.relativePath === 'pyproject.toml')?.metadata.language).toBe('toml');
        expect(insertedDocuments.find(document => document.relativePath === 'go.mod')?.metadata.language).toBe('go');
        expect(insertedDocuments.find(document => document.relativePath === 'package.json')?.metadata.language).toBe('json');
    });

    it('indexes configured extension-less files without enabling them globally', async () => {
        const projectA = path.join(tempRoot, 'project-a-extensionless');
        const projectB = path.join(tempRoot, 'project-b-extensionless');
        await fs.mkdir(projectA);
        await fs.mkdir(projectB);
        await fs.writeFile(path.join(projectA, 'Dockerfile'), 'FROM node:20');
        await fs.writeFile(path.join(projectB, 'Procfile'), 'web: node server.js');

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

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: createVectorDatabase(),
        });

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

    it('reindexChangedPaths rebuilds only dirty modified files', async () => {
        const project = path.join(tempRoot, 'project-targeted-modified');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'a.ts'), 'export const a = 1;\n');
        await fs.writeFile(path.join(project, 'b.ts'), 'export const b = 1;\n');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        try {
            await context.reindexByChange(project);
            vectorDatabase.insert.mockClear();

            await fs.writeFile(path.join(project, 'a.ts'), 'export const a = 2;\n');
            await expect(context.reindexChangedPaths(project, ['a.ts'])).resolves.toEqual({
                added: 0,
                removed: 0,
                modified: 1,
            });

            expect(vectorDatabase.insert).toHaveBeenCalledTimes(1);
            expect(vectorDatabase.insert.mock.calls[0][1][0].relativePath).toBe('a.ts');
        } finally {
            await FileSynchronizer.deleteSnapshot(project);
        }
    });

    it('reindexChangedPaths removes chunks when a dirty file is deleted', async () => {
        const project = path.join(tempRoot, 'project-targeted-deleted');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'a.ts'), 'export const a = 1;\n');

        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query.mockResolvedValue([{ id: 'chunk-a' } as any]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        try {
            await context.reindexByChange(project);
            vectorDatabase.insert.mockClear();
            vectorDatabase.delete.mockClear();

            await fs.rm(path.join(project, 'a.ts'));
            await expect(context.reindexChangedPaths(project, ['a.ts'])).resolves.toEqual({
                added: 0,
                removed: 1,
                modified: 0,
            });

            expect(vectorDatabase.delete).toHaveBeenCalledWith(expect.any(String), ['chunk-a']);
            expect(vectorDatabase.insert).not.toHaveBeenCalled();
        } finally {
            await FileSynchronizer.deleteSnapshot(project);
        }
    });

    it('reindexChangedPaths removes chunks when a dirty file becomes ignored', async () => {
        const project = path.join(tempRoot, 'project-targeted-ignored');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'a.ts'), 'export const a = 1;\n');

        const vectorDatabase = createVectorDatabase();
        vectorDatabase.query.mockResolvedValue([{ id: 'chunk-a' } as any]);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        try {
            await context.reindexByChange(project);
            vectorDatabase.insert.mockClear();
            vectorDatabase.delete.mockClear();

            await fs.writeFile(path.join(project, '.hceignore'), 'a.ts\n');
            await expect(context.reindexChangedPaths(project, ['a.ts'])).resolves.toEqual({
                added: 0,
                removed: 1,
                modified: 0,
            });

            expect(vectorDatabase.delete).toHaveBeenCalledWith(expect.any(String), ['chunk-a']);
            expect(vectorDatabase.insert).not.toHaveBeenCalled();
        } finally {
            await FileSynchronizer.deleteSnapshot(project);
        }
    });

    it('reindexChangedPaths keeps pending large additions uncommitted after safety-limit failure', async () => {
        const project = path.join(tempRoot, 'project-targeted-large');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'initial.ts'), 'const initial = true;\n');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        try {
            await context.reindexByChange(project);
            vectorDatabase.insert.mockClear();

            const lines = Array.from({ length: 5_001 }, (_, index) => `const value${index} = ${index};`).join('\n');
            await fs.writeFile(path.join(project, 'large.ts'), `${lines}\n`);

            await expect(context.reindexChangedPaths(project, ['large.ts'])).rejects.toBeInstanceOf(IncrementalIndexTooLargeError);
            await expect(context.reindexChangedPaths(project, ['large.ts'])).rejects.toBeInstanceOf(IncrementalIndexTooLargeError);
            expect(vectorDatabase.insert).not.toHaveBeenCalled();
        } finally {
            await FileSynchronizer.deleteSnapshot(project);
        }
    });

    it('stops automatic change indexing when added effective lines exceed the safety limit', async () => {
        const project = path.join(tempRoot, 'project-large-increment');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'initial.ts'), 'const initial = true;\n');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        try {
            await context.reindexByChange(project);
            vectorDatabase.insert.mockClear();

            const lines = Array.from({ length: 5_001 }, (_, index) => `const value${index} = ${index};`).join('\n');
            await fs.writeFile(path.join(project, 'large.ts'), `${lines}\n`);

            const result = context.reindexByChange(project);
            await expect(result).rejects.toMatchObject({
                name: 'IncrementalIndexTooLargeError',
                effectiveLines: 5_001,
                threshold: 5_000,
                changedFiles: 1,
            });
            await expect(context.reindexByChange(project)).rejects.toBeInstanceOf(IncrementalIndexTooLargeError);
            expect(vectorDatabase.insert).not.toHaveBeenCalled();
        } finally {
            await FileSynchronizer.deleteSnapshot(project);
        }
    });

    it('uses configured effective-line limit for automatic change indexing', async () => {
        const project = path.join(tempRoot, 'project-configured-limit');
        await fs.mkdir(project);
        await writeConfig(project, { automaticIncrementalEffectiveLineLimit: 2 });
        await fs.writeFile(path.join(project, 'initial.ts'), 'const initial = true;\n');

        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase: createVectorDatabase(),
            codeSplitter: new TestSplitter(),
        });

        try {
            await context.reindexByChange(project);

            await fs.writeFile(path.join(project, 'small.ts'), [
                'const a = 1;',
                'const b = 2;',
                'const c = 3;',
                ''
            ].join('\n'));

            await expect(context.reindexByChange(project)).rejects.toMatchObject({
                name: 'IncrementalIndexTooLargeError',
                effectiveLines: 3,
                threshold: 2,
                changedFiles: 1,
            });
        } finally {
            await FileSynchronizer.deleteSnapshot(project);
        }
    });

    it('does not stop automatic change indexing for a small edit in an existing large file', async () => {
        const project = path.join(tempRoot, 'project-large-existing-small-edit');
        await fs.mkdir(project);
            const initialLines = Array.from({ length: 5_001 }, (_, index) => `const value${index} = ${index};`);
        await fs.writeFile(path.join(project, 'large.ts'), `${initialLines.join('\n')}\n`);

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        try {
            await context.reindexByChange(project);
            vectorDatabase.insert.mockClear();

            initialLines[5_000] = 'const value5000 = 42;';
            await fs.writeFile(path.join(project, 'large.ts'), `${initialLines.join('\n')}\n`);

            await expect(context.reindexByChange(project)).resolves.toEqual({
                added: 0,
                removed: 0,
                modified: 1,
            });
            expect(vectorDatabase.insert).toHaveBeenCalled();
        } finally {
            await FileSynchronizer.deleteSnapshot(project);
        }
    });

    it('stops automatic change indexing when a modified file adds too many effective lines', async () => {
        const project = path.join(tempRoot, 'project-large-modified-growth');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'growing.ts'), 'const initial = true;\n');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        try {
            await context.reindexByChange(project);
            vectorDatabase.insert.mockClear();

            const lines = Array.from({ length: 5_002 }, (_, index) => `const value${index} = ${index};`).join('\n');
            await fs.writeFile(path.join(project, 'growing.ts'), `${lines}\n`);

            await expect(context.reindexByChange(project)).rejects.toMatchObject({
                name: 'IncrementalIndexTooLargeError',
                effectiveLines: 5_001,
                threshold: 5_000,
                changedFiles: 1,
            });
            expect(vectorDatabase.insert).not.toHaveBeenCalled();
        } finally {
            await FileSynchronizer.deleteSnapshot(project);
        }
    });

    it('reloads ignore files before change indexing so newly ignored large files do not trip the safety limit', async () => {
        const project = path.join(tempRoot, 'project-large-increment-ignored');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'initial.ts'), 'const initial = true;\n');

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new TestSplitter(),
        });

        try {
            await context.reindexByChange(project);
            vectorDatabase.insert.mockClear();

            const lines = Array.from({ length: 5_001 }, (_, index) => `const value${index} = ${index};`).join('\n');
            await fs.writeFile(path.join(project, 'large.ts'), `${lines}\n`);
            await fs.writeFile(path.join(project, '.hceignore'), 'large.ts\n');

            await expect(context.reindexByChange(project)).resolves.toEqual({
                added: 0,
                removed: 0,
                modified: 0,
            });
            expect(vectorDatabase.insert).not.toHaveBeenCalled();
        } finally {
            await FileSynchronizer.deleteSnapshot(project);
        }
    });

    it('keeps large pending changes detectable after the safety limit stops automatic change indexing', async () => {
        const project = path.join(tempRoot, 'project-large-increment-repeat');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'initial.ts'), 'const initial = true;\n');

        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase: createVectorDatabase(),
            codeSplitter: new TestSplitter(),
        });

        try {
            await context.reindexByChange(project);

            const lines = Array.from({ length: 5_001 }, (_, index) => `const value${index} = ${index};`).join('\n');
            await fs.writeFile(path.join(project, 'large.ts'), `${lines}\n`);

            await expect(context.reindexByChange(project)).rejects.toBeInstanceOf(IncrementalIndexTooLargeError);
            await expect(context.reindexByChange(project)).rejects.toBeInstanceOf(IncrementalIndexTooLargeError);
        } finally {
            await FileSynchronizer.deleteSnapshot(project);
        }
    });

    it('counts effective lines without blank lines or comment-only lines for incremental safety', async () => {
        const project = path.join(tempRoot, 'project-effective-lines');
        await fs.mkdir(project);

        const context = new Context({ vectorDatabase: createVectorDatabase() });
        const filePath = path.join(project, 'sample.ts');
        await fs.writeFile(filePath, [
            '',
            '// comment',
            '# shell-style comment',
            '/* block',
            ' * continuation',
            ' */',
            'const a = 1;',
            'const b = 2; // trailing comment',
            '* markdown-style content should count',
            ''
        ].join('\n'));

        await expect((context as any).countEffectiveLines([filePath])).resolves.toBe(3);
    });

    it('normalizes and escapes incremental delete filters', async () => {
        const vectorDatabase = createVectorDatabase();
        const context = new Context({ vectorDatabase });

        await (context as any).deleteFileChunks('collection', 'src\\foo.ts');
        expect(vectorDatabase.query).toHaveBeenLastCalledWith(
            'collection',
            'relativePath == "src/foo.ts"',
            ['id']
        );

        await (context as any).deleteFileChunks('collection', 'src/a"b.ts');
        expect(vectorDatabase.query).toHaveBeenLastCalledWith(
            'collection',
            'relativePath == "src/a\\"b.ts"',
            ['id']
        );
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

    it('honors nested dot-ignore files relative to their directory during indexing', async () => {
        const project = path.join(tempRoot, 'project-nested-hceignore');
        await fs.mkdir(path.join(project, 'src', 'nested'), { recursive: true });
        await fs.writeFile(path.join(project, 'src', '.hceignore'), '*.ts\n!keep.ts\n');
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
    await fs.writeFile(path.join(configDir, 'config.conf'), stringifyConf(config), 'utf-8');
}

function stringifyConf(config: Record<string, unknown>): string {
    return Object.entries(config)
        .flatMap(([key, value]) => Array.isArray(value)
            ? value.map(item => `${key} = ${String(item)}`)
            : [`${key} = ${String(value)}`])
        .join('\n') + '\n';
}
