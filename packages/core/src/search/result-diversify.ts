import { SemanticSearchResult } from '../types';
import { hasValidLineRange } from './line-range';

const DEFAULT_MAX_RESULTS_PER_FILE = 3;
const FILE_EVIDENCE_SUPPORT_LIMIT = 4;
const FILE_EVIDENCE_SUPPORT_WEIGHT = 0.35;
const FILE_EVIDENCE_SUPPORT_CAP = 260;
const FILE_EVIDENCE_RANK_STEP_PENALTY = 40;

export function diversifySemanticSearchResultsByFile<T extends SemanticSearchResult>(
    results: T[],
    limit: number,
    maxResultsPerFile = DEFAULT_MAX_RESULTS_PER_FILE
): T[] {
    if (limit <= 0 || results.length === 0) {
        return [];
    }

    const perFileLimit = Math.max(1, Math.floor(maxResultsPerFile));
    const buckets = createFileBuckets(results);
    const selected: T[] = [];
    const selectedByPath = new Map<string, OrderedResult<T>[]>();
    const selectedOrders = new Set<number>();

    for (const bucket of buckets) {
        selectResult(bucket.results[0], selected, selectedByPath, selectedOrders);
        if (selected.length >= limit) {
            return selected;
        }
    }

    for (let evidenceIndex = 1; evidenceIndex < perFileLimit; evidenceIndex++) {
        let selectedAny = false;
        for (const bucket of buckets) {
            const alreadySelected = selectedByPath.get(bucket.relativePath) ?? [];
            if (alreadySelected.length >= perFileLimit) {
                continue;
            }

            const evidenceResult = bucket.results.find((candidate, index) => (
                index > 0
                && !selectedOrders.has(candidate.order)
                && isDistinctStrongEvidence(candidate.result, alreadySelected.map(selectedResult => selectedResult.result))
            ));
            if (!evidenceResult) {
                continue;
            }

            selectResult(evidenceResult, selected, selectedByPath, selectedOrders);
            selectedAny = true;
            if (selected.length >= limit) {
                return selected;
            }
        }

        if (!selectedAny) {
            break;
        }
    }

    for (const bucket of buckets) {
        for (const candidate of bucket.results) {
            if (selectedOrders.has(candidate.order)) {
                continue;
            }

            const alreadySelected = selectedByPath.get(bucket.relativePath) ?? [];
            if (alreadySelected.length >= perFileLimit) {
                continue;
            }

            selectResult(candidate, selected, selectedByPath, selectedOrders);
            if (selected.length >= limit) {
                return selected;
            }
        }
    }

    return selected;
}

function selectResult<T extends SemanticSearchResult>(
    orderedResult: OrderedResult<T>,
    selected: T[],
    selectedByPath: Map<string, OrderedResult<T>[]>,
    selectedOrders: Set<number>
): void {
    selected.push(orderedResult.result);
    selectedOrders.add(orderedResult.order);

    const pathResults = selectedByPath.get(orderedResult.result.relativePath) ?? [];
    pathResults.push(orderedResult);
    selectedByPath.set(orderedResult.result.relativePath, pathResults);
}

interface OrderedResult<T extends SemanticSearchResult> {
    result: T;
    order: number;
}

interface FileBucket<T extends SemanticSearchResult> {
    relativePath: string;
    results: OrderedResult<T>[];
    aggregateScore: number;
}

function createFileBuckets<T extends SemanticSearchResult>(results: T[]): FileBucket<T>[] {
    const buckets: FileBucket<T>[] = [];
    const bucketByPath = new Map<string, FileBucket<T>>();

    results.forEach((result, order) => {
        let bucket = bucketByPath.get(result.relativePath);
        if (!bucket) {
            bucket = {
                relativePath: result.relativePath,
                results: [],
                aggregateScore: 0,
            };
            bucketByPath.set(result.relativePath, bucket);
            buckets.push(bucket);
        }

        bucket.results.push({ result, order });
    });

    for (const bucket of buckets) {
        bucket.aggregateScore = getFileAggregateEvidenceScore(bucket);
    }

    return buckets.sort((a, b) => {
        const aggregateDelta = b.aggregateScore - a.aggregateScore;
        if (aggregateDelta !== 0) return aggregateDelta;

        return a.results[0].order - b.results[0].order;
    });
}

function getFileAggregateEvidenceScore<T extends SemanticSearchResult>(bucket: FileBucket<T>): number {
    const [primary, ...supportingCandidates] = bucket.results;
    if (!primary) {
        return 0;
    }

    let aggregateScore = -primary.order * FILE_EVIDENCE_RANK_STEP_PENALTY;
    const selectedSupport: SemanticSearchResult[] = [primary.result];
    const orderedSupport = supportingCandidates
        .sort((a, b) => {
            const scoreDelta = getResultFileEvidenceScore(b.result) - getResultFileEvidenceScore(a.result);
            if (scoreDelta !== 0) return scoreDelta;

            return a.order - b.order;
        });

    for (const candidate of orderedSupport) {
        if (selectedSupport.length > FILE_EVIDENCE_SUPPORT_LIMIT || !isDistinctFileSupport(candidate.result, selectedSupport)) {
            continue;
        }

        const supportScore = Math.min(
            getResultFileEvidenceScore(candidate.result) * FILE_EVIDENCE_SUPPORT_WEIGHT,
            FILE_EVIDENCE_SUPPORT_CAP
        );
        aggregateScore += supportScore;
        selectedSupport.push(candidate.result);
    }

    return aggregateScore;
}

function getResultFileEvidenceScore(result: SemanticSearchResult): number {
    const score = Number.isFinite(result.score) && result.score > 0
        ? Math.log1p(result.score) * 120
        : 0;
    let evidenceScore = score;
    const reasons = result.scoreReasons ?? (result.scoreReason ? [result.scoreReason] : []);

    if (reasons.includes('exact_filename')) {
        evidenceScore += 420;
    }
    if (reasons.includes('exact_symbol_definition')) {
        evidenceScore += 360;
    }
    if (reasons.includes('path_match')) {
        evidenceScore += 180;
    }
    switch (result.chunkRole) {
        case 'definition':
            evidenceScore += 110;
            break;
        case 'method_body':
            evidenceScore += 90;
            break;
    }

    if (getLeadingDefinitionSignature(result.content) !== undefined) {
        evidenceScore += 90;
    }

    return evidenceScore;
}

function isDistinctFileSupport(candidate: SemanticSearchResult, selected: SemanticSearchResult[]): boolean {
    if (!hasStrongEvidence(candidate)) {
        return false;
    }

    if (selected.some(existing => hasOverlappingLineRange(candidate, existing))) {
        return false;
    }

    const candidateSignature = getEvidenceSignature(candidate);
    if (!candidateSignature) {
        return false;
    }

    return selected.every(existing => {
        const existingSignature = getEvidenceSignature(existing);
        return candidateSignature !== existingSignature;
    });
}

function isDistinctStrongEvidence(candidate: SemanticSearchResult, selected: SemanticSearchResult[]): boolean {
    if (!hasStrongEvidence(candidate)) {
        return false;
    }

    return selected.every(existing => hasDistinctEvidence(candidate, existing));
}

function hasStrongEvidence(result: SemanticSearchResult): boolean {
    const reasons = result.scoreReasons ?? (result.scoreReason ? [result.scoreReason] : []);
    return reasons.includes('exact_symbol_definition')
        || reasons.includes('exact_filename')
        || reasons.includes('path_match')
        || getLeadingDefinitionSignature(result.content) !== undefined;
}

function hasDistinctEvidence(candidate: SemanticSearchResult, existing: SemanticSearchResult): boolean {
    if (hasOverlappingLineRange(candidate, existing)) {
        return false;
    }

    const candidateSignature = getEvidenceSignature(candidate);
    const existingSignature = getEvidenceSignature(existing);
    if (candidateSignature && existingSignature && candidateSignature !== existingSignature) {
        return true;
    }

    return Boolean(candidateSignature && !existingSignature);
}

function hasOverlappingLineRange(left: SemanticSearchResult, right: SemanticSearchResult): boolean {
    if (!hasValidLineRange(left) || !hasValidLineRange(right)) {
        return false;
    }

    const overlapStart = Math.max(left.startLine, right.startLine);
    const overlapEnd = Math.min(left.endLine, right.endLine);
    if (overlapStart > overlapEnd) {
        return false;
    }

    const overlapSize = overlapEnd - overlapStart + 1;
    const leftSize = left.endLine - left.startLine + 1;
    const rightSize = right.endLine - right.startLine + 1;
    const smallerSize = Math.min(leftSize, rightSize);
    return smallerSize > 0 && overlapSize / smallerSize > 0.2;
}

function getEvidenceSignature(result: SemanticSearchResult): string | undefined {
    const definitionSignature = getLeadingDefinitionSignature(result.content);
    if (definitionSignature) {
        return definitionSignature;
    }

    const reasons = result.scoreReasons ?? (result.scoreReason ? [result.scoreReason] : []);
    const strongReasons = reasons
        .filter(reason => reason === 'exact_symbol_definition' || reason === 'exact_filename' || reason === 'path_match')
        .sort();
    if (strongReasons.length === 0) {
        return undefined;
    }

    const range = hasValidLineRange(result) ? `${result.startLine}-${result.endLine}` : 'unknown-range';
    return `${strongReasons.join('+')}:${result.chunkRole ?? 'unknown'}:${range}`;
}

function getLeadingDefinitionSignature(content: string): string | undefined {
    const firstMeaningfulRawLine = content
        .replace(/\r\n/g, '\n')
        .split('\n')
        .find(line => {
            const trimmed = line.trim();
            return trimmed.length > 0 && !isCommentLine(trimmed) && !trimmed.startsWith('@');
        });

    if (!firstMeaningfulRawLine) {
        return undefined;
    }

    const declarationMatch = firstMeaningfulRawLine.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|function|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
    if (declarationMatch) {
        return `${declarationMatch[1]}:${declarationMatch[2]}`;
    }

    const firstMeaningfulLine = firstMeaningfulRawLine.trim();
    const pythonMatch = firstMeaningfulLine.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (pythonMatch) {
        return `def:${pythonMatch[1]}`;
    }

    const goMatch = firstMeaningfulLine.match(/^func\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (goMatch) {
        return `func:${goMatch[1]}`;
    }

    const rustMatch = firstMeaningfulLine.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (rustMatch) {
        return `fn:${rustMatch[1]}`;
    }

    const methodMatch = firstMeaningfulLine.match(/^(?:public|private|protected|static|async|override|readonly|\s)*(?:[A-Za-z_$][A-Za-z0-9_$<>[\],.?]*\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*(?:\{|=>|:)/);
    if (methodMatch) {
        return `method:${methodMatch[1]}`;
    }

    const typedMethodMatch = firstMeaningfulLine.match(/^(?:public|private|protected|internal|static|final|abstract|override|virtual|async|sealed|synchronized|\s)*(?:[A-Za-z_$][A-Za-z0-9_$<>[\],.?]*\s+)+([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*(?:\{|=>|:)/);
    if (typedMethodMatch) {
        return `method:${typedMethodMatch[1]}`;
    }

    return undefined;
}

function isCommentLine(line: string): boolean {
    return line.startsWith('//')
        || line.startsWith('#')
        || line.startsWith('/*')
        || line.startsWith('*')
        || line.endsWith('*/');
}
