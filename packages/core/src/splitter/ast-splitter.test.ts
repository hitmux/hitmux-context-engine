import { AstCodeSplitter } from './ast-splitter';

describe('AstCodeSplitter Java support', () => {
    it('chunks Java classes and methods without falling back to an empty result', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const code = [
            'package example;',
            '',
            'public class Greeter {',
            '    public String greet(String name) {',
            '        return "Hello " + name;',
            '    }',
            '}',
        ].join('\n');

        const chunks = await splitter.split(code, 'java', '/repo/src/Greeter.java');
        const greetChunk = chunks.find((chunk) => chunk.metadata.symbolName === 'greet');

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.some((chunk) => chunk.content.includes('class Greeter'))).toBe(true);
        expect(greetChunk).toBeDefined();
        expect(greetChunk?.metadata).toMatchObject({
            symbolName: 'greet',
            symbolKind: 'method',
            isDefinition: true,
        });
        expect(chunks.every((chunk) => chunk.metadata.language === 'java')).toBe(true);
    });
});

describe('AstCodeSplitter C# support', () => {
    it('loads the C# tree-sitter language export and chunks methods', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const code = [
            'namespace Example;',
            '',
            'public class Greeter',
            '{',
            '    public string Greet(string name)',
            '    {',
            '        return $"Hello {name}";',
            '    }',
            '}',
        ].join('\n');

        try {
            const chunks = await splitter.split(code, 'csharp', '/repo/src/Greeter.cs');
            const greetChunk = chunks.find((chunk) => chunk.metadata.symbolName === 'Greet');

            expect(chunks.length).toBeGreaterThan(0);
            expect(chunks.some((chunk) => chunk.content.includes('class Greeter'))).toBe(true);
            expect(greetChunk).toBeDefined();
            expect(greetChunk?.metadata).toMatchObject({
                symbolName: 'Greet',
                symbolKind: 'method',
                isDefinition: true,
            });
            expect(chunks.every((chunk) => chunk.metadata.language === 'csharp')).toBe(true);
            expect(warnSpy).not.toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('AstCodeSplitter C support', () => {
    it('chunks C functions with the bundled C-family parser', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const code = [
            '#include <stdio.h>',
            '',
            'static int add(int left, int right) {',
            '    return left + right;',
            '}',
            '',
            'int main(void) {',
            '    printf("%d\\n", add(1, 2));',
            '    return 0;',
            '}',
        ].join('\n');

        try {
            const chunks = await splitter.split(code, 'c', '/repo/src/main.c');

            expect(chunks.length).toBeGreaterThan(0);
            expect(chunks.some((chunk) => chunk.content.includes('static int add'))).toBe(true);
            expect(chunks.some((chunk) => chunk.content.includes('int main'))).toBe(true);
            expect(chunks.every((chunk) => chunk.metadata.language === 'c')).toBe(true);
            expect(warnSpy).not.toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('AstCodeSplitter leading comments', () => {
    it('keeps function header comments with the declaration chunk', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const code = [
            'const outside = true;',
            '',
            '/**',
            ' * Returns a greeting.',
            ' */',
            'export function greet(name: string): string {',
            '    return `Hello ${name}`;',
            '}',
        ].join('\n');

        const chunks = await splitter.split(code, 'typescript', '/repo/src/greet.ts');
        const functionChunk = chunks.find((chunk) => chunk.content.includes('function greet'));

        expect(functionChunk).toBeDefined();
        expect(functionChunk?.content).toContain('Returns a greeting.');
        expect(functionChunk?.content).not.toContain('const outside');
        expect(functionChunk?.metadata.startLine).toBe(3);
    });
});

describe('AstCodeSplitter parser cache', () => {
    it('reuses parser and language instances per tree-sitter language branch', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const cacheView = splitter as unknown as {
            parserCache: Map<string, unknown>;
            languageCache: Map<string, unknown>;
        };

        await splitter.split('export const first = 1;', 'typescript', '/repo/src/first.ts');
        await splitter.split('export const second = 2;', 'ts', '/repo/src/second.ts');
        await splitter.split('export function Panel() { return null; }', 'tsx', '/repo/src/Panel.tsx');
        await splitter.split('package rooms\nfunc BuildRoom() {}', 'go', '/repo/rooms/registry.go');
        await splitter.split('def build_room():\n    return None', 'python', '/repo/src/rooms.py');

        expect(cacheView.parserCache.size).toBe(4);
        expect(cacheView.languageCache.size).toBe(4);
        expect(cacheView.parserCache.has('typescript')).toBe(true);
        expect(cacheView.parserCache.has('tsx')).toBe(true);
        expect(cacheView.parserCache.has('go')).toBe(true);
        expect(cacheView.parserCache.has('python')).toBe(true);
    });

    it('keeps mixed-language cache entries correct across parallel split calls', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const cacheView = splitter as unknown as {
            parserCache: Map<string, unknown>;
            languageCache: Map<string, unknown>;
        };

        const [tsChunks, tsxChunks, goChunks, pythonChunks] = await Promise.all([
            splitter.split('export const value = 1;', 'typescript', '/repo/src/value.ts'),
            splitter.split('export function Panel() { return null; }', 'tsx', '/repo/src/Panel.tsx'),
            splitter.split('package rooms\nfunc BuildRoom() {}', 'go', '/repo/rooms/registry.go'),
            splitter.split('def build_room():\n    return None', 'python', '/repo/src/rooms.py'),
        ]);

        expect(tsChunks.every((chunk) => chunk.metadata.language === 'typescript')).toBe(true);
        expect(tsxChunks.every((chunk) => chunk.metadata.language === 'tsx')).toBe(true);
        expect(goChunks.find((chunk) => chunk.metadata.symbolName === 'BuildRoom')).toBeDefined();
        expect(pythonChunks.find((chunk) => chunk.metadata.symbolName === 'build_room')).toBeDefined();
        expect([...cacheView.parserCache.keys()].sort()).toEqual(['go', 'python', 'tsx', 'typescript']);
        expect([...cacheView.languageCache.keys()].sort()).toEqual(['go', 'python', 'tsx', 'typescript']);
    });
});

describe('AstCodeSplitter symbol metadata', () => {
    it('records TypeScript definition symbols for exact search reranking', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const code = [
            'export class RenderWorkerBridge {}',
            'export function payloadPacker() { return null; }',
            'export interface TowerRegistry {}',
            'export type TowerId = string;',
            'export const manualCannonPanel = true;',
        ].join('\n');

        const chunks = await splitter.split(code, 'typescript', '/repo/src/renderWorkerBridge.ts');
        const metadataBySymbol = new Map(
            chunks
                .filter((chunk) => typeof chunk.metadata.symbolName === 'string')
                .map((chunk) => [chunk.metadata.symbolName, chunk.metadata])
        );

        expect(metadataBySymbol.get('RenderWorkerBridge')).toMatchObject({
            symbolKind: 'class',
            isDefinition: true,
            chunkKind: 'class_definition',
            chunkRole: 'definition',
        });
        expect(metadataBySymbol.get('payloadPacker')).toMatchObject({
            symbolKind: 'function',
            isDefinition: true,
            chunkRole: 'definition',
        });
        expect(metadataBySymbol.get('TowerRegistry')).toMatchObject({
            symbolKind: 'interface',
            isDefinition: true,
            chunkRole: 'definition',
        });
        expect(metadataBySymbol.get('TowerId')).toMatchObject({
            symbolKind: 'type',
            isDefinition: true,
            chunkRole: 'definition',
        });
        expect(metadataBySymbol.get('manualCannonPanel')).toMatchObject({
            symbolKind: 'const',
            isDefinition: true,
            chunkRole: 'definition',
        });
    });

    it('does not split nested TypeScript locals into standalone definition chunks', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const code = [
            'export const topLevelValue = 1;',
            '',
            'export const makeThing = () => {',
            '    const callback = () => {',
            '        const nestedValue = 3;',
            '        return nestedValue;',
            '    };',
            '',
            '    return callback();',
            '};',
            '',
            'export function outer() {',
            '    const innerValue = 2;',
            '    return innerValue;',
            '}',
        ].join('\n');

        const chunks = await splitter.split(code, 'typescript', '/repo/src/example.ts');
        const symbols = chunks
            .map((chunk) => chunk.metadata.symbolName)
            .filter((symbol): symbol is string => typeof symbol === 'string');

        expect(symbols).toEqual(expect.arrayContaining([
            'topLevelValue',
            'makeThing',
            'outer',
        ]));
        expect(symbols).not.toEqual(expect.arrayContaining([
            'callback',
            'nestedValue',
            'innerValue',
        ]));
    });

    it('keeps regex fallback focused on top-level TypeScript declarations', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        (splitter as unknown as { getParser: () => never }).getParser = () => {
            throw new Error('forced fallback');
        };

        const code = [
            'export const topLevelValue = 1;',
            '',
            'export function outer() {',
            '    const innerValue = 2;',
            '    return innerValue;',
            '}',
        ].join('\n');

        const chunks = await splitter.split(code, 'typescript', '/repo/src/example.ts');
        const symbols = chunks
            .map((chunk) => chunk.metadata.symbolName)
            .filter((symbol): symbol is string => typeof symbol === 'string');

        expect(symbols).toEqual(expect.arrayContaining([
            'topLevelValue',
            'outer',
        ]));
        expect(symbols).not.toContain('innerValue');
    });

    it('marks TypeScript re-export chunks explicitly', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const code = [
            "export { RenderWorkerBridge } from './renderWorkerBridge';",
            "export type { BridgePacket } from './types';",
        ].join('\n');

        const chunks = await splitter.split(code, 'typescript', '/repo/src/workers/index.ts');

        expect(chunks).toHaveLength(2);
        expect(chunks.every((chunk) => chunk.metadata.chunkRole === 're_export')).toBe(true);
        expect(chunks.every((chunk) => chunk.metadata.isDefinition === false)).toBe(true);
    });

    it('does not duplicate exported declarations through wrapper chunks', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const code = [
            'export class RenderWorkerBridge {',
            '    connect(): void {}',
            '}',
        ].join('\n');

        const chunks = await splitter.split(code, 'typescript', '/repo/src/renderWorkerBridge.ts');
        const classChunks = chunks.filter((chunk) => chunk.content.includes('class RenderWorkerBridge'));

        expect(classChunks).toHaveLength(1);
        expect(classChunks[0].metadata).toMatchObject({
            startLine: 1,
            symbolName: 'RenderWorkerBridge',
            isDefinition: true,
        });
    });

    it('does not prepend overlap across independent AST chunks', async () => {
        const splitter = new AstCodeSplitter(2000, 80);
        const code = [
            'export function first(): number {',
            '    return 1;',
            '}',
            '',
            'export function second(): number {',
            '    return 2;',
            '}',
        ].join('\n');

        const chunks = await splitter.split(code, 'typescript', '/repo/src/functions.ts');
        const secondChunk = chunks.find((chunk) => chunk.content.includes('function second'));

        expect(secondChunk).toBeDefined();
        expect(secondChunk?.content).not.toContain('function first');
        expect(secondChunk?.content.trim()).toMatch(/^export function second/);
        expect(secondChunk?.metadata.startLine).toBe(5);
    });

    it('keeps definition metadata only on the first sub-chunk of a large definition', async () => {
        const splitter = new AstCodeSplitter(90, 0);
        const code = [
            'export class BigRegistry {',
            ...Array.from({ length: 12 }, (_unused, index) => `    value${index} = ${index};`),
            '}',
        ].join('\n');

        const chunks = await splitter.split(code, 'typescript', '/repo/src/bigRegistry.ts');
        const definitionChunks = chunks.filter((chunk) => chunk.metadata.symbolName === 'BigRegistry');

        expect(chunks.length).toBeGreaterThan(1);
        expect(definitionChunks).toHaveLength(1);
        expect(definitionChunks[0].content).toContain('export class BigRegistry');
        expect(definitionChunks[0].metadata.startLine).toBe(1);
        expect(chunks.slice(1).every((chunk) => chunk.metadata.symbolName !== 'BigRegistry')).toBe(true);
        expect(chunks.slice(1).every((chunk) => chunk.metadata.chunkRole === 'method_body')).toBe(true);
    });

    it('keeps overlap local to sub-chunks of the same large definition', async () => {
        const splitter = new AstCodeSplitter(90, 25);
        const code = [
            'export class BigRegistry {',
            ...Array.from({ length: 12 }, (_unused, index) => `    value${index} = ${index};`),
            '}',
            '',
            'export function afterRegistry(): void {}',
        ].join('\n');

        const chunks = await splitter.split(code, 'typescript', '/repo/src/bigRegistry.ts');
        const afterChunk = chunks.find((chunk) => chunk.content.includes('afterRegistry'));
        const bigChunks = chunks.filter((chunk) => chunk.content.includes('value'));

        expect(bigChunks.length).toBeGreaterThan(1);
        expect(bigChunks[1].content).toContain('value');
        expect(bigChunks[1].metadata.isDefinition).toBe(false);
        expect(afterChunk?.content).not.toContain('BigRegistry');
    });
});

describe('AstCodeSplitter cross-language definition metadata', () => {
    it('records Python definition symbols', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const code = [
            'class PyGreeter:',
            '    def greet(self, name):',
            '        return name',
            '',
            'async def load_room():',
            '    return None',
        ].join('\n');

        const chunks = await splitter.split(code, 'python', '/repo/src/greeter.py');
        const symbols = chunks
            .map((chunk) => chunk.metadata.symbolName)
            .filter(Boolean);

        expect(symbols).toEqual(expect.arrayContaining(['PyGreeter', 'greet', 'load_room']));
        expect(chunks.find((chunk) => chunk.metadata.symbolName === 'load_room')?.metadata.chunkRole).toBe('definition');
    });

    it('marks Python test functions as test cases', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const code = [
            'def test_room_registry():',
            '    assert build_room() is not None',
        ].join('\n');

        const chunks = await splitter.split(code, 'python', '/repo/tests/test_room_registry.py');
        const testChunk = chunks.find((chunk) => chunk.metadata.symbolName === 'test_room_registry');

        expect(testChunk?.metadata.chunkRole).toBe('test_case');
    });

    it('records Go definition symbols', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const code = [
            'package rooms',
            '',
            'type RoomRegistry struct {}',
            '',
            'func BuildRoom() {}',
            '',
            'func (r *RoomRegistry) Register() {}',
        ].join('\n');

        const chunks = await splitter.split(code, 'go', '/repo/rooms/registry.go');
        const symbols = chunks
            .map((chunk) => chunk.metadata.symbolName)
            .filter(Boolean);

        expect(symbols).toEqual(expect.arrayContaining(['RoomRegistry', 'BuildRoom', 'Register']));
        expect(chunks.find((chunk) => chunk.metadata.symbolName === 'BuildRoom')?.metadata.chunkRole).toBe('definition');
        expect(chunks.find((chunk) => chunk.content.trim() === 'package rooms')?.metadata.chunkRole).toBe('module_decl');
    });

    it('marks Go test functions as test cases', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const code = [
            'package rooms',
            '',
            'func TestBuildRoom(t *testing.T) {',
            '    if BuildRoom() == nil {',
            '        t.Fatal("missing room")',
            '    }',
            '}',
        ].join('\n');

        const chunks = await splitter.split(code, 'go', '/repo/rooms/registry_test.go');
        const testChunk = chunks.find((chunk) => chunk.metadata.symbolName === 'TestBuildRoom');

        expect(testChunk?.metadata.chunkRole).toBe('test_case');
    });

    it('records Rust definition symbols', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const code = [
            'pub struct RoomRegistry {}',
            '',
            'pub fn spawn_room() {}',
            '',
            'pub trait RoomFactory {}',
        ].join('\n');

        const chunks = await splitter.split(code, 'rust', '/repo/src/registry.rs');
        const symbols = chunks
            .map((chunk) => chunk.metadata.symbolName)
            .filter(Boolean);

        expect(symbols).toEqual(expect.arrayContaining(['RoomRegistry', 'spawn_room', 'RoomFactory']));
        expect(chunks.find((chunk) => chunk.metadata.symbolName === 'spawn_room')?.metadata.chunkRole).toBe('definition');
    });

    it('marks Rust module declarations explicitly', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const code = [
            'pub mod rooms;',
            'pub use rooms::RoomRegistry;',
        ].join('\n');

        const chunks = await splitter.split(code, 'rust', '/repo/src/mod.rs');

        expect(chunks.some((chunk) => chunk.metadata.chunkRole === 'module_decl')).toBe(true);
        expect(chunks.some((chunk) => chunk.metadata.chunkRole === 're_export')).toBe(true);
    });

    it('marks Java package declarations and test methods', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const code = [
            'package example.rooms;',
            '',
            'public class RoomRegistryTest {',
            '    public void testBuildRoom() {',
            '        assertTrue(true);',
            '    }',
            '}',
        ].join('\n');

        const chunks = await splitter.split(code, 'java', '/repo/src/RoomRegistryTest.java');
        const methodChunk = chunks.find((chunk) => chunk.metadata.symbolName === 'testBuildRoom');

        expect(chunks.find((chunk) => chunk.content.trim() === 'package example.rooms;')?.metadata.chunkRole).toBe('module_decl');
        expect(methodChunk?.metadata.chunkRole).toBe('test_case');
    });

    it('keeps TSX and JSX language values while using parser branches', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const tsxChunks = await splitter.split('export function Panel() { return null; }', 'tsx', '/repo/src/Panel.tsx');
        const jsxChunks = await splitter.split('export function Panel() { return null; }', 'jsx', '/repo/src/Panel.jsx');

        expect(tsxChunks.some((chunk) => chunk.metadata.symbolName === 'Panel')).toBe(true);
        expect(jsxChunks.some((chunk) => chunk.metadata.symbolName === 'Panel')).toBe(true);
        expect(tsxChunks.every((chunk) => chunk.metadata.language === 'tsx')).toBe(true);
        expect(jsxChunks.every((chunk) => chunk.metadata.language === 'jsx')).toBe(true);
    });

    it('splits Markdown by header sections with header symbol metadata', async () => {
        const splitter = new AstCodeSplitter(2000, 0);
        const code = [
            '# Overview',
            'Project intro.',
            '',
            '## Installation',
            'Install steps.',
            '',
            '## API Reference',
            'Endpoint details.',
        ].join('\n');

        const chunks = await splitter.split(code, 'markdown', '/repo/README.md');
        const installChunk = chunks.find((chunk) => chunk.metadata.symbolName === 'Installation');
        const apiChunk = chunks.find((chunk) => chunk.metadata.symbolName === 'API Reference');

        expect(installChunk).toMatchObject({
            metadata: {
                startLine: 4,
                endLine: 6,
                chunkKind: 'markdown_section',
                symbolKind: 'markdown_header',
                isDefinition: true,
            }
        });
        expect(installChunk?.content).not.toContain('API Reference');
        expect(apiChunk?.metadata.startLine).toBe(7);
    });
});
