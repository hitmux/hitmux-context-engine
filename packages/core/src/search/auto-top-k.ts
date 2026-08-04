import {
    SearchAutoTopKDecision,
    SearchAutoTopKOptions,
    SearchAutoTopKSignal,
    SemanticSearchResult,
} from '../types';
import {
    calibrateSearchCandidate,
    getSearchCalibrationProfile,
    hasStrongLexicalEvidence,
} from './calibration';

const MAX_AUTO_TOP_K_RETURN_CAP = 12;
const DEFAULT_CANDIDATE_WINDOW = 100;
const MAX_CANDIDATE_WINDOW = 200;

interface ScoreSignal {
    signal: SearchAutoTopKSignal;
    indexes: number[];
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

/**
 * Select an automatic result count from a bounded candidate window.
 *
 * `maxResults` remains the compatibility name for the visible return cap. In
 * calibrated mode the selector evaluates the whole candidate window and may
 * accept more results than fit on the first page.
 */
export function selectAutoTopK(
    results: readonly SemanticSearchResult[],
    maxResults: number,
    options: SearchAutoTopKOptions,
    isHybrid: boolean,
): SearchAutoTopKDecision {
    const candidateWindow = Math.min(
        Math.max(1, normalizePositiveInteger(options.candidateWindow, DEFAULT_CANDIDATE_WINDOW)),
        MAX_CANDIDATE_WINDOW,
    );
    const candidates = results.slice(0, Math.min(candidateWindow, results.length));
    const strategy = resolveStrategy(options);
    const requestedReturnCap = Math.max(1, normalizePositiveInteger(options.returnCap ?? maxResults, maxResults || 1));
    const returnCap = strategy === 'legacy-gap'
        ? requestedReturnCap
        : Math.min(MAX_AUTO_TOP_K_RETURN_CAP, requestedReturnCap);

    if (strategy === 'legacy-gap') {
        return selectLegacyGap(candidates, returnCap, options, isHybrid);
    }

    return selectCalibrated(candidates, returnCap, options, isHybrid);
}

function selectCalibrated(
    results: readonly SemanticSearchResult[],
    returnCap: number,
    options: SearchAutoTopKOptions,
    isHybrid: boolean,
): SearchAutoTopKDecision {
    const availableResults = results.length;
    const scoreSignal = getCalibratedSignal(results, options.useVectorFallback, isHybrid);
    if (!scoreSignal) {
        const strongIndexes = results
            .map((result, index) => hasStrongLexicalEvidence(result) ? index : -1)
            .filter(index => index >= 0);
        return createDecision({
            selectedResults: Math.min(returnCap, strongIndexes.length),
            acceptedResults: strongIndexes.length,
            minResults: 0,
            maxResults: returnCap,
            availableResults,
            candidateWindow: results.length,
            returnCap,
            truncated: strongIndexes.length > returnCap,
            signal: 'none',
            reason: strongIndexes.length > 0 ? 'strong_lexical_evidence' : 'no_finite_scores',
            acceptedCandidateIndexes: strongIndexes,
        });
    }

    const profileInfo = getSearchCalibrationProfile({
        provider: options.provider,
        model: options.model,
        signal: scoreSignal.signal,
        intent: options.intent,
    });
    const acceptedCandidateIndexes: number[] = [];
    let usedStrongEvidence = false;
    let usedFallbackProfile = profileInfo.fallback;
    for (const [index, result] of results.entries()) {
        const calibration = calibrateSearchCandidate(result, index, results, scoreSignal.signal, {
            provider: options.provider,
            model: options.model,
            intent: options.intent,
            profile: profileInfo.profile,
        });
        usedFallbackProfile ||= calibration.profileFallback;
        const strongEvidence = hasStrongLexicalEvidence(result);
        if (strongEvidence && calibration.probability >= profileInfo.profile.threshold * 0.75) {
            usedStrongEvidence = true;
        }
        if (calibration.probability >= profileInfo.profile.threshold || (strongEvidence && calibration.probability >= profileInfo.profile.threshold * 0.75)) {
            acceptedCandidateIndexes.push(index);
        }
    }

    const reason = acceptedCandidateIndexes.length === 0
        ? (usedFallbackProfile ? 'calibration_profile_missing' : 'calibrated_threshold')
        : usedStrongEvidence
            ? 'strong_lexical_evidence'
            : 'calibrated_threshold';
    return createDecision({
        selectedResults: Math.min(returnCap, acceptedCandidateIndexes.length),
        acceptedResults: acceptedCandidateIndexes.length,
        minResults: 0,
        maxResults: returnCap,
        availableResults,
        candidateWindow: results.length,
        returnCap,
        truncated: acceptedCandidateIndexes.length > returnCap,
        signal: scoreSignal.signal,
        reason,
        acceptedCandidateIndexes,
    });
}

function getCalibratedSignal(
    results: readonly SemanticSearchResult[],
    useVectorFallback: boolean,
    isHybrid: boolean,
): ScoreSignal | undefined {
    const rerankIndexes = results
        .map((result, index) => Number.isFinite(result.rerankScore) ? index : -1)
        .filter(index => index >= 0);
    const retrievalIndexes = results
        .map((result, index) => Number.isFinite(result.retrievalScore) ? index : -1)
        .filter(index => index >= 0);

    if (rerankIndexes.length === results.length && rerankIndexes.length > 0) {
        return { signal: 'rerank', indexes: rerankIndexes };
    }
    if (rerankIndexes.length > 0 && retrievalIndexes.length > 0) {
        return { signal: 'mixed', indexes: [...new Set([...rerankIndexes, ...retrievalIndexes])] };
    }
    if (!useVectorFallback || retrievalIndexes.length === 0) {
        return undefined;
    }
    return {
        signal: isHybrid ? 'hybrid_rrf' : 'vector',
        indexes: retrievalIndexes,
    };
}

function selectLegacyGap(
    results: readonly SemanticSearchResult[],
    returnCap: number,
    options: SearchAutoTopKOptions,
    isHybrid: boolean,
): SearchAutoTopKDecision {
    const availableResults = results.length;
    const upperBound = Math.min(returnCap, availableResults);
    const minResults = Math.min(
        Math.max(1, normalizePositiveInteger(options.minResults, 1)),
        upperBound,
    );

    if (upperBound === 0) {
        return createDecision({
            selectedResults: 0,
            acceptedResults: 0,
            minResults: 0,
            maxResults: 0,
            availableResults,
            candidateWindow: results.length,
            returnCap: 0,
            truncated: false,
            signal: 'none',
            reason: 'no_score_signal',
            acceptedCandidateIndexes: [],
        });
    }

    const strongMinimum = Math.min(upperBound, countStrongEvidence(results));
    const rerankSignal = getCompleteRerankSignal(results, upperBound);
    const scoreSignal = rerankSignal
        ?? (options.useVectorFallback ? getVectorFallbackSignal(results, upperBound, isHybrid) : undefined);

    if (!scoreSignal) {
        return createDecision({
            selectedResults: upperBound,
            acceptedResults: upperBound,
            minResults: Math.max(minResults, strongMinimum),
            maxResults: upperBound,
            availableResults,
            candidateWindow: results.length,
            returnCap: upperBound,
            truncated: false,
            signal: 'none',
            reason: 'no_score_signal',
            acceptedCandidateIndexes: range(upperBound),
        });
    }

    if (scoreSignal.scores.length < 2) {
        return createDecision({
            selectedResults: upperBound,
            acceptedResults: upperBound,
            minResults: Math.max(minResults, strongMinimum),
            maxResults: upperBound,
            availableResults,
            candidateWindow: results.length,
            returnCap: upperBound,
            truncated: false,
            signal: scoreSignal.signal,
            reason: 'insufficient_finite_scores',
            acceptedCandidateIndexes: range(upperBound),
        });
    }

    const thresholds = scoreSignal.signal === 'rerank' ? RERANK_THRESHOLDS : VECTOR_FALLBACK_THRESHOLDS;
    const breakAfter = findReliableScoreGap(scoreSignal.scores, thresholds);
    const selected = breakAfter === undefined
        ? upperBound
        : Math.max(minResults, strongMinimum, breakAfter);
    return createDecision({
        selectedResults: Math.min(selected, upperBound),
        acceptedResults: Math.min(selected, upperBound),
        minResults: Math.max(minResults, strongMinimum),
        maxResults: upperBound,
        availableResults,
        candidateWindow: results.length,
        returnCap: upperBound,
        truncated: false,
        signal: scoreSignal.signal,
        reason: breakAfter === undefined ? 'no_reliable_score_gap' : 'significant_score_gap',
        acceptedCandidateIndexes: range(Math.min(selected, upperBound)),
    });
}

interface LegacyScoreSignal {
    signal: SearchAutoTopKSignal;
    scores: number[];
}

function getCompleteRerankSignal(results: readonly SemanticSearchResult[], upperBound: number): LegacyScoreSignal | undefined {
    const leadingScores = results.slice(0, upperBound).map(result => result.rerankScore);
    if (leadingScores.some(score => !isFiniteNumber(score))) {
        return undefined;
    }
    return { signal: 'rerank', scores: (leadingScores as number[]).sort((a, b) => b - a) };
}

function getVectorFallbackSignal(results: readonly SemanticSearchResult[], upperBound: number, isHybrid: boolean): LegacyScoreSignal | undefined {
    const scores = results
        .map(result => result.retrievalScore)
        .filter(isFiniteNumber)
        .sort((a, b) => b - a)
        .slice(0, upperBound);
    return scores.length > 0 ? { signal: isHybrid ? 'hybrid_rrf' : 'vector', scores } : undefined;
}

function findReliableScoreGap(scores: readonly number[], thresholds: GapThresholds): number | undefined {
    const highest = scores[0];
    const lowest = scores[scores.length - 1];
    if (!isFiniteNumber(highest) || !isFiniteNumber(lowest)) return undefined;

    const range = highest - lowest;
    const relativeSpan = range / Math.max(Math.abs(highest), Number.EPSILON);
    if (range <= 0 || relativeSpan < thresholds.minRelativeSpan) return undefined;

    const gaps = scores.slice(0, -1).map((score, index) => score - scores[index + 1]);
    const medianGap = median(gaps);
    const medianAbsoluteDeviation = median(gaps.map(gap => Math.abs(gap - medianGap)));
    let bestGapIndex: number | undefined;
    let bestGap = -Infinity;
    for (const [index, gap] of gaps.entries()) {
        const normalizedGap = gap / range;
        const robustZScore = getRobustZScore(gap, medianGap, medianAbsoluteDeviation);
        const medianMultiplier = medianGap === 0 ? (gap > 0 ? Infinity : 0) : gap / medianGap;
        if (normalizedGap < thresholds.minNormalizedGap || robustZScore < thresholds.minRobustZScore || medianMultiplier < thresholds.minMedianGapMultiplier) continue;
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
        if (!hasStrongLexicalEvidence(result)) continue;
        uniqueEvidence.add(`${result.relativePath}:${result.startLine}:${result.endLine}`);
    }
    return uniqueEvidence.size;
}

function createDecision(input: Omit<SearchAutoTopKDecision, 'acceptedResults' | 'candidateWindow' | 'returnCap' | 'truncated'> & {
    acceptedResults: number;
    candidateWindow: number;
    returnCap: number;
    truncated: boolean;
}): SearchAutoTopKDecision {
    return {
        ...input,
        acceptedResults: Math.max(0, input.acceptedResults),
        candidateWindow: Math.max(0, input.candidateWindow),
        returnCap: Math.max(0, input.returnCap),
        truncated: input.truncated || input.acceptedResults > input.returnCap,
    };
}

function resolveStrategy(options: SearchAutoTopKOptions): 'calibrated' | 'legacy-gap' {
    if (options.strategy) return options.strategy;
    // Existing core callers that only provide the old min/useVector shape keep
    // legacy-gap semantics. MCP always passes the explicit calibrated strategy.
    return options.candidateWindow === undefined && options.returnCap === undefined ? 'legacy-gap' : 'calibrated';
}

function range(length: number): number[] {
    return Array.from({ length: Math.max(0, length) }, (_, index) => index);
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const midpoint = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
}

function getRobustZScore(value: number, medianValue: number, medianAbsoluteDeviation: number): number {
    if (medianAbsoluteDeviation === 0) return value === medianValue ? 0 : Infinity;
    return 0.6745 * Math.abs(value - medianValue) / medianAbsoluteDeviation;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}
