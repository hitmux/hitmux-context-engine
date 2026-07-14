import {
    SearchAutoTopKDecision,
    SearchAutoTopKOptions,
    SearchAutoTopKSignal,
    SemanticSearchResult,
} from '../types';

interface ScoreSignal {
    signal: SearchAutoTopKSignal;
    scores: number[];
}

interface GapThresholds {
    minRelativeSpan: number;
    minNormalizedGap: number;
    minRobustZScore: number;
    minMedianGapMultiplier: number;
}

const RERANK_THRESHOLDS: GapThresholds = {
    minRelativeSpan: 0.05,
    minNormalizedGap: 0.12,
    minRobustZScore: 3.5,
    minMedianGapMultiplier: 3,
};

const VECTOR_FALLBACK_THRESHOLDS: GapThresholds = {
    minRelativeSpan: 0.08,
    minNormalizedGap: 0.18,
    minRobustZScore: 4.5,
    minMedianGapMultiplier: 4,
};

const STRONG_SCORE_REASONS = new Set([
    'exact_filename',
    'exact_symbol_definition',
    'path_match',
]);

export function selectAutoTopK(
    results: readonly SemanticSearchResult[],
    maxResults: number,
    options: SearchAutoTopKOptions,
    isHybrid: boolean,
): SearchAutoTopKDecision {
    const availableResults = results.length;
    const upperBound = Math.min(normalizePositiveInteger(maxResults, 1), availableResults);
    const minResults = Math.min(
        Math.max(1, normalizePositiveInteger(options.minResults, 1)),
        upperBound,
    );

    if (upperBound === 0) {
        return {
            selectedResults: 0,
            minResults: 0,
            maxResults: 0,
            availableResults,
            signal: 'none',
            reason: 'no_score_signal',
        };
    }

    const protectedMinimum = Math.max(
        minResults,
        Math.min(upperBound, countStrongEvidence(results)),
    );
    const rerankSignal = getCompleteRerankSignal(results, upperBound);
    const scoreSignal = rerankSignal
        ?? (options.useVectorFallback ? getVectorFallbackSignal(results, upperBound, isHybrid) : undefined);

    if (!scoreSignal) {
        return createDecision(upperBound, protectedMinimum, upperBound, availableResults, 'none', 'no_score_signal');
    }

    if (scoreSignal.scores.length < 2) {
        return createDecision(upperBound, protectedMinimum, upperBound, availableResults, scoreSignal.signal, 'insufficient_finite_scores');
    }

    const thresholds = scoreSignal.signal === 'rerank'
        ? RERANK_THRESHOLDS
        : VECTOR_FALLBACK_THRESHOLDS;
    const breakAfter = findReliableScoreGap(scoreSignal.scores, thresholds);
    if (breakAfter === undefined) {
        return createDecision(upperBound, protectedMinimum, upperBound, availableResults, scoreSignal.signal, 'no_reliable_score_gap');
    }

    return createDecision(
        Math.max(protectedMinimum, breakAfter),
        protectedMinimum,
        upperBound,
        availableResults,
        scoreSignal.signal,
        'significant_score_gap',
    );
}

function getCompleteRerankSignal(
    results: readonly SemanticSearchResult[],
    upperBound: number,
): ScoreSignal | undefined {
    const leadingScores = results
        .slice(0, upperBound)
        .map(result => result.rerankScore);
    if (leadingScores.some(score => !isFiniteNumber(score))) {
        return undefined;
    }

    return {
        signal: 'rerank',
        scores: (leadingScores as number[]).sort((a, b) => b - a),
    };
}

function getVectorFallbackSignal(
    results: readonly SemanticSearchResult[],
    upperBound: number,
    isHybrid: boolean,
): ScoreSignal | undefined {
    const scores = results
        .map(result => result.retrievalScore)
        .filter(isFiniteNumber)
        .sort((a, b) => b - a)
        .slice(0, upperBound);
    if (scores.length === 0) {
        return undefined;
    }

    return {
        signal: isHybrid ? 'hybrid_rrf' : 'vector',
        scores,
    };
}

function findReliableScoreGap(scores: readonly number[], thresholds: GapThresholds): number | undefined {
    const highest = scores[0];
    const lowest = scores[scores.length - 1];
    if (!isFiniteNumber(highest) || !isFiniteNumber(lowest)) {
        return undefined;
    }

    const range = highest - lowest;
    const relativeSpan = range / Math.max(Math.abs(highest), Number.EPSILON);
    if (range <= 0 || relativeSpan < thresholds.minRelativeSpan) {
        return undefined;
    }

    const gaps = scores.slice(0, -1).map((score, index) => score - scores[index + 1]);
    const medianGap = median(gaps);
    const medianAbsoluteDeviation = median(gaps.map(gap => Math.abs(gap - medianGap)));
    let bestGapIndex: number | undefined;
    let bestGap = -Infinity;

    for (const [index, gap] of gaps.entries()) {
        const normalizedGap = gap / range;
        const robustZScore = getRobustZScore(gap, medianGap, medianAbsoluteDeviation);
        const medianMultiplier = medianGap === 0
            ? (gap > 0 ? Infinity : 0)
            : gap / medianGap;
        if (
            normalizedGap < thresholds.minNormalizedGap
            || robustZScore < thresholds.minRobustZScore
            || medianMultiplier < thresholds.minMedianGapMultiplier
        ) {
            continue;
        }

        if (gap > bestGap) {
            bestGap = gap;
            bestGapIndex = index;
        }
    }

    return bestGapIndex === undefined ? undefined : bestGapIndex + 1;
}

function countStrongEvidence(results: readonly SemanticSearchResult[]): number {
    const uniqueEvidence = new Set<string>();
    for (const result of results) {
        const reasons = result.scoreReasons ?? (result.scoreReason ? [result.scoreReason] : []);
        if (!reasons.some(reason => STRONG_SCORE_REASONS.has(reason))) {
            continue;
        }
        uniqueEvidence.add(`${result.relativePath}:${result.startLine}:${result.endLine}`);
    }
    return uniqueEvidence.size;
}

function createDecision(
    selectedResults: number,
    minResults: number,
    maxResults: number,
    availableResults: number,
    signal: SearchAutoTopKSignal,
    reason: SearchAutoTopKDecision['reason'],
): SearchAutoTopKDecision {
    return {
        selectedResults,
        minResults,
        maxResults,
        availableResults,
        signal,
        reason,
    };
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const midpoint = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
        : sorted[midpoint];
}

function getRobustZScore(value: number, medianValue: number, medianAbsoluteDeviation: number): number {
    if (medianAbsoluteDeviation === 0) {
        return value === medianValue ? 0 : Infinity;
    }
    return 0.6745 * Math.abs(value - medianValue) / medianAbsoluteDeviation;
}

function normalizePositiveInteger(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}
