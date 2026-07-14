import { selectAutoTopK } from './auto-top-k';
import { SemanticSearchResult } from '../types';

function createResult(
    retrievalScore: number | undefined,
    overrides: Partial<SemanticSearchResult> = {},
): SemanticSearchResult {
    return {
        content: '',
        relativePath: `src/${overrides.startLine ?? 1}.ts`,
        startLine: 1,
        endLine: 1,
        language: 'typescript',
        score: retrievalScore ?? 0,
        ...(retrievalScore === undefined ? {} : { retrievalScore }),
        ...overrides,
    };
}

function select(
    scores: number[],
    options: Partial<{ minResults: number; useVectorFallback: boolean }> = {},
) {
    return selectAutoTopK(
        scores.map(score => createResult(score)),
        12,
        {
            minResults: options.minResults ?? 3,
            useVectorFallback: options.useVectorFallback ?? true,
        },
        false,
    );
}

describe('selectAutoTopK', () => {
    it('selects the earliest largest reliable rerank score gap', () => {
        const results = [0.99, 0.97, 0.95, 0.45, 0.44, 0.43, 0.42, 0.41]
            .map((rerankScore, index) => createResult(0.9 - index * 0.01, { rerankScore }));

        expect(selectAutoTopK(results, 12, { minResults: 3, useVectorFallback: true }, false))
            .toMatchObject({
                selectedResults: 3,
                minResults: 3,
                maxResults: 8,
                signal: 'rerank',
                reason: 'significant_score_gap',
            });
    });

    it('keeps the upper bound for uniform or low-span scores', () => {
        expect(select([0.9, 0.89, 0.88, 0.87, 0.86, 0.85])).toMatchObject({
            selectedResults: 6,
            reason: 'no_reliable_score_gap',
        });
        expect(select([1, 0.995, 0.99, 0.985, 0.98, 0.975])).toMatchObject({
            selectedResults: 6,
            reason: 'no_reliable_score_gap',
        });
    });

    it('does not reduce below the configured minimum when the gap is earlier', () => {
        expect(select([0.99, 0.4, 0.39, 0.38, 0.37, 0.36])).toMatchObject({
            selectedResults: 3,
            minResults: 3,
            reason: 'significant_score_gap',
        });
    });

    it('raises the minimum to preserve distinct strong evidence', () => {
        const results = [0.99, 0.97, 0.95, 0.45, 0.44, 0.43]
            .map((score, index) => createResult(score, {
                relativePath: `src/${index}.ts`,
                ...(index < 5 ? { scoreReasons: ['exact_symbol_definition'] } : {}),
            }));

        expect(selectAutoTopK(results, 12, { minResults: 3, useVectorFallback: true }, false))
            .toMatchObject({ selectedResults: 5, minResults: 5 });
    });

    it('uses the number of available candidates when it is below the minimum', () => {
        expect(select([0.9, 0.2], { minResults: 3 })).toMatchObject({
            selectedResults: 2,
            minResults: 2,
            maxResults: 2,
        });
    });

    it('falls back to the upper bound when no finite score signal is available', () => {
        const results = [
            createResult(undefined, { score: Number.NaN }),
            createResult(undefined, { score: Number.POSITIVE_INFINITY }),
            createResult(undefined, { score: Number.NEGATIVE_INFINITY }),
        ];

        expect(selectAutoTopK(results, 12, { minResults: 3, useVectorFallback: true }, false))
            .toMatchObject({
                selectedResults: 3,
                signal: 'none',
                reason: 'no_score_signal',
            });
    });

    it('uses stricter vector thresholds than rerank thresholds', () => {
        const scores = [1, 0.98, 0.96, 0.88];
        while (scores.length < 30) {
            scores.push(scores[scores.length - 1] - 0.02);
        }
        const rerankResults = scores.map((rerankScore, index) => createResult(1 - index * 0.01, { rerankScore }));

        expect(selectAutoTopK(rerankResults, 30, { minResults: 3, useVectorFallback: true }, false))
            .toMatchObject({ selectedResults: 3, signal: 'rerank', reason: 'significant_score_gap' });
        expect(selectAutoTopK(scores.map(score => createResult(score)), 30, { minResults: 3, useVectorFallback: true }, false)).toMatchObject({
            selectedResults: 30,
            signal: 'vector',
            reason: 'no_reliable_score_gap',
        });
    });

    it('labels hybrid fallback scores as hybrid RRF and excludes lexical-only candidates', () => {
        const results = [
            createResult(0.9),
            createResult(0.88),
            createResult(0.86),
            createResult(0.3),
            createResult(0.29),
            createResult(undefined, { score: 10, relativePath: 'src/lexical-only.ts' }),
        ];

        expect(selectAutoTopK(results, 12, { minResults: 3, useVectorFallback: true }, true))
            .toMatchObject({ selectedResults: 3, signal: 'hybrid_rrf' });
    });
});
