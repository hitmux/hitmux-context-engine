import { selectAutoTopK } from './auto-top-k';
import { calibrateSearchCandidate } from './calibration';
import type { SemanticSearchResult } from '../types';

function result(index: number, score: number | undefined, rerankScore?: number): SemanticSearchResult {
    return {
        id: `chunk-${index}`,
        content: `candidate ${index}`,
        relativePath: `src/candidate-${index}.ts`,
        startLine: index + 1,
        endLine: index + 1,
        language: 'typescript',
        score: score ?? 0,
        ...(score === undefined ? {} : { retrievalScore: score }),
        ...(rerankScore === undefined ? {} : { rerankScore }),
    };
}

describe('calibrated automatic TopK', () => {
    const options = {
        strategy: 'calibrated' as const,
        candidateWindow: 100,
        returnCap: 12,
        useVectorFallback: true,
    };

    it('accepts beyond the first page while retaining a 12-result return cap', () => {
        const candidates = Array.from({ length: 100 }, (_, index) =>
            result(index, 0.92 - index * 0.004, 0.98 - index * 0.006),
        );

        expect(selectAutoTopK(candidates, 12, options, false)).toMatchObject({
            selectedResults: 12,
            candidateWindow: 100,
            returnCap: 12,
            truncated: true,
            signal: 'rerank',
        });
        expect(selectAutoTopK(candidates, 12, options, false).acceptedResults).toBeGreaterThan(12);
    });

    it('returns no candidates for a flat weak score signal', () => {
        const candidates = Array.from({ length: 100 }, (_, index) => result(index, 0.5));

        expect(selectAutoTopK(candidates, 12, options, false)).toMatchObject({
            selectedResults: 0,
            acceptedResults: 0,
            truncated: false,
            signal: 'vector',
        });
    });

    it('uses mixed calibration when rerank only covers an initial subset', () => {
        const candidates = Array.from({ length: 20 }, (_, index) =>
            result(index, 0.95 - index * 0.03, index < 8 ? 0.99 - index * 0.06 : undefined),
        );

        expect(selectAutoTopK(candidates, 12, options, false).signal).toBe('mixed');
    });

    it('normalizes mixed candidates according to the score source', () => {
        const candidates = [
            result(0, 0.02, 0.05),
            result(1, 0.02),
        ];

        expect(calibrateSearchCandidate(candidates[0], 0, candidates, 'mixed').features.normalizedScore).toBeCloseTo(0.05);
        expect(calibrateSearchCandidate(candidates[1], 1, candidates, 'mixed').features.normalizedScore).toBeCloseTo(0.9);
    });

    it('keeps strong lexical evidence when no finite retrieval score exists', () => {
        const candidates = [
            result(0, undefined),
            {
                ...result(1, undefined),
                scoreReasons: ['exact_symbol_definition' as const],
            },
        ];

        expect(selectAutoTopK(candidates, 12, options, false)).toMatchObject({
            selectedResults: 1,
            acceptedResults: 1,
            reason: 'strong_lexical_evidence',
        });
    });
});
