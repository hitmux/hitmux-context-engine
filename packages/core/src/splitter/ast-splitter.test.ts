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

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.some((chunk) => chunk.content.includes('class Greeter'))).toBe(true);
        expect(chunks.some((chunk) => chunk.content.includes('String greet'))).toBe(true);
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

            expect(chunks.length).toBeGreaterThan(0);
            expect(chunks.some((chunk) => chunk.content.includes('class Greeter'))).toBe(true);
            expect(chunks.some((chunk) => chunk.content.includes('string Greet'))).toBe(true);
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
