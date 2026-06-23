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
    it('ranks a file with multiple distinct supporting chunks ahead of a slightly stronger single chunk', () => {
        const results = diversifySemanticSearchResultsByFile([
            createResult({
                relativePath: 'src/single.ts',
                startLine: 1,
                endLine: 20,
                content: 'single high semantic owner candidate with one isolated evidence block',
                score: 0.96,
            }),
            createResult({
                relativePath: 'src/owner.ts',
                startLine: 1,
                endLine: 20,
                content: 'owner file primary semantic candidate covers relay billing context',
                score: 0.9,
            }),
            createResult({
                relativePath: 'src/owner.ts',
                startLine: 40,
                endLine: 60,
                content: 'export function registerOwnerRoute(): void {}',
                score: 0.89,
                scoreReasons: ['path_match'],
            }),
            createResult({
                relativePath: 'src/owner.ts',
                startLine: 80,
                endLine: 100,
                content: 'export function dispatchOwnerAdapter(): void {}',
                score: 0.88,
                scoreReasons: ['exact_symbol_definition'],
            }),
        ], 3);

        expect(results.map(result => `${result.relativePath}:${result.startLine}`)).toEqual([
            'src/owner.ts:1',
            'src/single.ts:1',
            'src/owner.ts:40',
        ]);
    });

    it('does not promote repeated overlapping weak chunks as file-level evidence', () => {
        const results = diversifySemanticSearchResultsByFile([
            createResult({
                relativePath: 'src/single.ts',
                startLine: 1,
                endLine: 20,
                content: 'single high semantic owner candidate with one isolated evidence block',
                score: 0.96,
            }),
            createResult({
                relativePath: 'src/noisy.ts',
                startLine: 1,
                endLine: 20,
                content: 'repeated weak generic token repeated weak generic token',
                score: 0.94,
            }),
            createResult({
                relativePath: 'src/noisy.ts',
                startLine: 10,
                endLine: 28,
                content: 'repeated weak generic token repeated weak generic token',
                score: 0.93,
            }),
            createResult({
                relativePath: 'src/noisy.ts',
                startLine: 14,
                endLine: 30,
                content: 'repeated weak generic token repeated weak generic token',
                score: 0.92,
            }),
        ], 3);

        expect(results.map(result => `${result.relativePath}:${result.startLine}`)).toEqual([
            'src/single.ts:1',
            'src/noisy.ts:1',
            'src/noisy.ts:10',
        ]);
    });

    it('does not let many distinct weak semantic chunks outrank a single exact owner', () => {
        const results = diversifySemanticSearchResultsByFile([
            createResult({
                relativePath: 'src/exact.ts',
                startLine: 1,
                endLine: 20,
                content: 'exact filename owner evidence',
                score: 0.9,
                scoreReasons: ['exact_filename'],
            }),
            createResult({
                relativePath: 'src/large.ts',
                startLine: 1,
                endLine: 20,
                content: 'broad weak semantic chunk one with enough different text',
                score: 0.89,
            }),
            createResult({
                relativePath: 'src/large.ts',
                startLine: 40,
                endLine: 60,
                content: 'broad weak semantic chunk two with unrelated wording',
                score: 0.88,
            }),
            createResult({
                relativePath: 'src/large.ts',
                startLine: 80,
                endLine: 100,
                content: 'broad weak semantic chunk three with unrelated wording',
                score: 0.87,
            }),
            createResult({
                relativePath: 'src/large.ts',
                startLine: 120,
                endLine: 140,
                content: 'broad weak semantic chunk four with unrelated wording',
                score: 0.86,
            }),
        ], 3);

        expect(results.map(result => `${result.relativePath}:${result.startLine}`)).toEqual([
            'src/exact.ts:1',
            'src/large.ts:1',
            'src/large.ts:40',
        ]);
    });

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

    it('prefers non-overlapping strong secondary evidence over overlapping same-file chunks', () => {
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
                content: 'export function overlappingA(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
            createResult({
                relativePath: 'src/b.ts',
                startLine: 1,
                endLine: 8,
                content: 'export function firstB(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
            createResult({
                relativePath: 'src/b.ts',
                startLine: 40,
                endLine: 50,
                content: 'export function secondB(): void {}',
                scoreReasons: ['exact_symbol_definition'],
            }),
        ], 4);

        expect(results.map(result => `${result.relativePath}:${result.startLine}`)).toEqual([
            'src/b.ts:1',
            'src/a.ts:10',
            'src/b.ts:40',
            'src/a.ts:25',
        ]);
    });
});
