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

class RecordingSplitter implements Splitter {
    public calls: Array<{ code: string; language: string; filePath?: string }> = [];

    constructor(private readonly label: string) { }

    async split(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        this.calls.push({ code, language, filePath });
        return [{
            content: `${this.label}:${code}`,
            metadata: {
                startLine: 1,
                endLine: code.split('\n').length,
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

describe('Context request-scoped splitters', () => {
    let tempRoot: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hitmux-context-engine-splitter-'));
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

    it('uses a request-scoped splitter for indexing without replacing the context splitter', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'index.ts'), 'const value = 1;');

        const vectorDatabase = createVectorDatabase();
        const contextSplitter = new RecordingSplitter('context');
        const requestSplitter = new RecordingSplitter('request');
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: contextSplitter,
        });

        await context.indexCodebase(project, undefined, false, [], [], requestSplitter);

        expect(contextSplitter.calls).toHaveLength(0);
        expect(requestSplitter.calls).toHaveLength(1);
        expect(context.getCodeSplitter()).toBe(contextSplitter);

        const insertedDocuments = vectorDatabase.insert.mock.calls
            .flatMap(([, documents]) => documents);
        expect(insertedDocuments).toHaveLength(1);
        expect(insertedDocuments[0].content).toBe('request:const value = 1;');
        expect(insertedDocuments[0].metadata).toMatchObject({
            fileName: 'index.ts',
            basename: 'index',
            pathTokens: ['index', 'ts'],
            symbols: ['value'],
            definitionIdentifiers: ['value'],
            chunkKind: 'code',
        });
        expect(insertedDocuments[0]).toMatchObject({
            primarySymbol: 'value',
            chunkKind: 'code',
            isDefinition: false,
            fileRole: 'implementation',
            basename: 'index',
            pathSegment0: 'index.ts',
        });
    });

    it('uses a request-scoped splitter for changed files during sync reindexing', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        const filePath = path.join(project, 'note.md');
        await fs.writeFile(filePath, 'first version');

        const vectorDatabase = createVectorDatabase();
        const contextSplitter = new RecordingSplitter('context');
        const requestSplitter = new RecordingSplitter('request');
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: contextSplitter,
        });

        try {
            const synchronizer = new FileSynchronizer(
                project,
                await context.getEffectiveIgnorePatterns(project),
                context.getEffectiveSupportedExtensions()
            );
            await synchronizer.initialize();
            context.setSynchronizer(context.getCollectionName(project), synchronizer);

            await fs.writeFile(filePath, 'second version');
            await context.reindexByChange(project, undefined, [], [], requestSplitter);

            expect(contextSplitter.calls).toHaveLength(0);
            expect(requestSplitter.calls).toHaveLength(1);
            expect(context.getCodeSplitter()).toBe(contextSplitter);

            const insertedDocuments = vectorDatabase.insert.mock.calls
                .flatMap(([, documents]) => documents);
            expect(insertedDocuments).toHaveLength(1);
            expect(insertedDocuments[0].content).toBe('request:second version');
        } finally {
            await FileSynchronizer.deleteSnapshot(project);
        }
    });

    it('indexes Solidity files by default and maps them to the solidity language', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'Token.sol'), 'contract Token {}');

        const vectorDatabase = createVectorDatabase();
        const splitter = new RecordingSplitter('context');
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: splitter,
        });

        await context.indexCodebase(project);

        expect(splitter.calls).toHaveLength(1);
        expect(splitter.calls[0]).toMatchObject({
            language: 'solidity',
            filePath: path.join(project, 'Token.sol'),
        });

        const insertedDocuments = vectorDatabase.insert.mock.calls
            .flatMap(([, documents]) => documents);
        expect(insertedDocuments).toHaveLength(1);
        expect(insertedDocuments[0].relativePath).toBe('Token.sol');
    });

    it('adds splitter definition symbols to definitionIdentifiers', async () => {
        const project = path.join(tempRoot, 'project-symbol-metadata');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'registry.go'), 'body without recognizable declaration');

        const vectorDatabase = createVectorDatabase();
        const splitter: Splitter = {
            async split(_code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
                return [{
                    content: 'body without recognizable declaration',
                    metadata: {
                        startLine: 1,
                        endLine: 1,
                        language,
                        filePath,
                        symbolName: 'RegisterRoom',
                        symbolKind: 'function',
                        chunkKind: 'function_definition',
                        isDefinition: true,
                    },
                }];
            },
            setChunkSize(): void { },
            setChunkOverlap(): void { },
        };
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: splitter,
        });

        await context.indexCodebase(project);

        const insertedDocument = vectorDatabase.insert.mock.calls
            .flatMap(([, documents]) => documents)[0];

        expect(insertedDocument).toMatchObject({
            primarySymbol: 'RegisterRoom',
            symbolKind: 'function',
            chunkKind: 'function_definition',
            isDefinition: true,
        });
        expect(insertedDocument.metadata.definitionIdentifiers).toEqual(['RegisterRoom']);
    });

    it('indexes TSX, JSX, Markdown, Elixir, Lua, and Luau files by default with language metadata', async () => {
        const project = path.join(tempRoot, 'project-language-support');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'Panel.tsx'), 'export function Panel() { return null; }');
        await fs.writeFile(path.join(project, 'Widget.jsx'), 'export function Widget() { return null; }');
        await fs.writeFile(path.join(project, 'README.md'), '# Usage\n\nDetails');
        await fs.writeFile(path.join(project, 'greeter.ex'), 'defmodule Greeter do\n  def hello, do: :ok\nend');
        await fs.writeFile(path.join(project, 'script.exs'), 'IO.puts("hello")');
        await fs.writeFile(path.join(project, 'init.lua'), 'local value = 1');
        await fs.writeFile(path.join(project, 'game.luau'), 'local value: number = 1');

        const vectorDatabase = createVectorDatabase();
        const splitter = new RecordingSplitter('context');
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: splitter,
        });

        await context.indexCodebase(project);

        const callsByFile = new Map(
            splitter.calls.map(call => [path.basename(call.filePath || ''), call.language])
        );

        expect(callsByFile.get('Panel.tsx')).toBe('tsx');
        expect(callsByFile.get('Widget.jsx')).toBe('jsx');
        expect(callsByFile.get('README.md')).toBe('markdown');
        expect(callsByFile.get('greeter.ex')).toBe('elixir');
        expect(callsByFile.get('script.exs')).toBe('elixir');
        expect(callsByFile.get('init.lua')).toBe('lua');
        expect(callsByFile.get('game.luau')).toBe('luau');

        const indexedPaths = vectorDatabase.insert.mock.calls
            .flatMap(([, documents]) => documents)
            .map(document => document.relativePath)
            .sort();
        expect(indexedPaths).toEqual(['Panel.tsx', 'README.md', 'Widget.jsx', 'game.luau', 'greeter.ex', 'init.lua', 'script.exs']);
    });

    it('reports AST splitter supported languages', () => {
        const context = new Context({
            hybridMode: false,
            vectorDatabase: createVectorDatabase(),
        });

        expect(context.getSplitterInfo()).toMatchObject({
            type: 'ast',
            hasBuiltinFallback: true,
        });
        expect(context.getSplitterInfo().supportedLanguages).toEqual(
            expect.arrayContaining(['c', 'cpp', 'java', 'markdown', 'scala', 'tsx', 'typescript'])
        );
    });
});

async function writeConfig(homeDir: string, config: Record<string, unknown>): Promise<void> {
    const configDir = path.join(homeDir, '.hitmux-context-engine');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'config.jsonc'), JSON.stringify(config), 'utf-8');
}
