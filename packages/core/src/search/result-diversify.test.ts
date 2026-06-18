import { SemanticSearchResult } from '../types';
import { diversifySemanticSearchResultsByFile } from './result-diversify';

function createResult(overrides: Partial<SemanticSearchResult>): SemanticSearchResult {
    return {
        content: '',
        relativePath: 'src/a.ts',
        startLine: 1,
        endLine: 1,
        language: 'typescript',
        score: 1,
        ...overrides,
    };
}

describe('diversifySemanticSearchResultsByFile', () => {
    it('keeps each file best chunk before same-file secondary evidence', () => {
        const results = diversifySemanticSearchResultsByFile([
            createResult({
                relativePath: 'src/a.ts',
                startLine: 10,
                endLine: 20,
                content: 'export function firstA(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
            createResult({
                relativePath: 'src/a.ts',
                startLine: 40,
                endLine: 50,
                content: 'export function secondA(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
            createResult({
                relativePath: 'src/b.ts',
                startLine: 1,
                endLine: 8,
                content: 'export function firstB(): void {}',
            }),
            createResult({
                relativePath: 'src/c.ts',
                startLine: 1,
                endLine: 8,
                content: 'export function firstC(): void {}',
            }),
        ], 4);

        expect(results.map(result => `${result.relativePath}:${result.startLine}`)).toEqual([
            'src/a.ts:10',
            'src/b.ts:1',
            'src/c.ts:1',
            'src/a.ts:40',
        ]);
    });

    it('moves weak same-file repeats behind other files', () => {
        const results = diversifySemanticSearchResultsByFile([
            createResult({
                relativePath: 'src/a.ts',
                startLine: 10,
                endLine: 20,
                content: 'loadPayload(firstA);',
            }),
            createResult({
                relativePath: 'src/a.ts',
                startLine: 30,
                endLine: 40,
                content: 'loadPayload(secondA);',
            }),
            createResult({
                relativePath: 'src/b.ts',
                startLine: 1,
                endLine: 8,
                content: 'loadPayload(firstB);',
            }),
        ], 3);

        expect(results.map(result => `${result.relativePath}:${result.startLine}`)).toEqual([
            'src/a.ts:10',
            'src/b.ts:1',
            'src/a.ts:30',
        ]);
    });

    it('allows up to three distinct strong evidence chunks from one file', () => {
        const results = diversifySemanticSearchResultsByFile([
            createResult({
                relativePath: 'src/a.ts',
                startLine: 10,
                endLine: 20,
                content: 'export function firstA(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
            createResult({
                relativePath: 'src/a.ts',
                startLine: 40,
                endLine: 50,
                content: 'export function secondA(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
            createResult({
                relativePath: 'src/a.ts',
                startLine: 70,
                endLine: 80,
                content: 'export function thirdA(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
            createResult({
                relativePath: 'src/a.ts',
                startLine: 100,
                endLine: 110,
                content: 'export function fourthA(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
            createResult({
                relativePath: 'src/b.ts',
                startLine: 1,
                endLine: 8,
                content: 'export function firstB(): void {}',
            }),
        ], 5);

        expect(results.map(result => `${result.relativePath}:${result.startLine}`)).toEqual([
            'src/a.ts:10',
            'src/b.ts:1',
            'src/a.ts:40',
            'src/a.ts:70',
        ]);
    });

    it('honors a lower maxResultsPerFile cap even for distinct strong evidence', () => {
        const results = diversifySemanticSearchResultsByFile([
            createResult({
                relativePath: 'src/a.ts',
                startLine: 10,
                endLine: 20,
                content: 'export function firstA(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
            createResult({
                relativePath: 'src/a.ts',
                startLine: 40,
                endLine: 50,
                content: 'export function secondA(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
            createResult({
                relativePath: 'src/a.ts',
                startLine: 70,
                endLine: 80,
                content: 'export function thirdA(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
            createResult({
                relativePath: 'src/b.ts',
                startLine: 1,
                endLine: 8,
                content: 'export function firstB(): void {}',
            }),
        ], 4, 2);

        expect(results.map(result => `${result.relativePath}:${result.startLine}`)).toEqual([
            'src/a.ts:10',
            'src/b.ts:1',
            'src/a.ts:40',
        ]);
    });

    it('normalizes invalid maxResultsPerFile to one result per file', () => {
        const results = diversifySemanticSearchResultsByFile([
            createResult({
                relativePath: 'src/a.ts',
                startLine: 10,
                endLine: 20,
                content: 'export function firstA(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
            createResult({
                relativePath: 'src/a.ts',
                startLine: 40,
                endLine: 50,
                content: 'export function secondA(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
            createResult({
                relativePath: 'src/b.ts',
                startLine: 1,
                endLine: 8,
                content: 'export function firstB(): void {}',
            }),
        ], 3, 0);

        expect(results.map(result => `${result.relativePath}:${result.startLine}`)).toEqual([
            'src/a.ts:10',
            'src/b.ts:1',
        ]);
    });

    it('recognizes distinct non-TypeScript definitions as strong evidence', () => {
        const results = diversifySemanticSearchResultsByFile([
            createResult({
                relativePath: 'server/relay.go',
                startLine: 10,
                endLine: 20,
                language: 'go',
                content: 'func RelayChatCompletionsViaResponses() error { return nil }',
            }),
            createResult({
                relativePath: 'server/relay.go',
                startLine: 40,
                endLine: 50,
                language: 'go',
                content: 'func BuildResponseRequest() Request { return Request{} }',
            }),
            createResult({
                relativePath: 'server/router.go',
                startLine: 1,
                endLine: 8,
                language: 'go',
                content: 'func MountRoutes() {}',
            }),
        ], 3);

        expect(results.map(result => `${result.relativePath}:${result.startLine}`)).toEqual([
            'server/relay.go:10',
            'server/router.go:1',
            'server/relay.go:40',
        ]);
    });

    it('does not treat plain call expressions as strong definition evidence', () => {
        const results = diversifySemanticSearchResultsByFile([
            createResult({
                relativePath: 'src/a.ts',
                startLine: 10,
                endLine: 20,
                content: 'loadPayload(firstA);',
            }),
            createResult({
                relativePath: 'src/a.ts',
                startLine: 40,
                endLine: 50,
                content: 'sendPayload(secondA);',
            }),
            createResult({
                relativePath: 'src/b.ts',
                startLine: 1,
                endLine: 8,
                content: 'export function firstB(): void {}',
            }),
        ], 3);

        expect(results.map(result => `${result.relativePath}:${result.startLine}`)).toEqual([
            'src/a.ts:10',
            'src/b.ts:1',
            'src/a.ts:40',
        ]);
    });

    it('moves overlapping strong chunks behind other files when evidence is not distinct', () => {
        const results = diversifySemanticSearchResultsByFile([
            createResult({
                relativePath: 'src/a.ts',
                startLine: 10,
                endLine: 30,
                content: 'export function firstA(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
            createResult({
                relativePath: 'src/a.ts',
                startLine: 25,
                endLine: 40,
                content: 'export function secondA(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
            createResult({
                relativePath: 'src/b.ts',
                startLine: 1,
                endLine: 8,
                content: 'export function firstB(): void {}',
            }),
        ], 3);

        expect(results.map(result => `${result.relativePath}:${result.startLine}`)).toEqual([
            'src/a.ts:10',
            'src/b.ts:1',
            'src/a.ts:25',
        ]);
    });
});
