import * as crypto from 'crypto';
import { SemanticSearchResult } from '../types';
import { hasValidLineRange } from './line-range';

const CONTENT_DUPLICATE_MIN_LENGTH = 80;
const CONTENT_SIMILARITY_MIN_LINES = 4;
const ADJACENT_RANGE_MAX_GAP = 2;
const ADJACENT_RANGE_SIMILARITY_THRESHOLD = 0.6;
const AUDITABILITY_DECISIVE_DELTA = 2;

export function deduplicateSemanticSearchResults(results: SemanticSearchResult[]): SemanticSearchResult[] {
    const kept: SemanticSearchResult[] = [];

    for (const result of results) {
        let shouldKeepResult = true;

        for (let index = 0; index < kept.length;) {
            const existing = kept[index];
            if (!areDuplicateResults(existing, result)) {
                index++;
                continue;
            }

            if (!shouldReplaceDuplicate(existing, result)) {
                shouldKeepResult = false;
                break;
            }

            kept.splice(index, 1);
        }

        if (shouldKeepResult) {
            kept.push(result);
        }
    }

    return kept;
}

export function getNormalizedContentHash(content: string): string {
    return crypto.createHash('sha1').update(normalizeResultContent(content)).digest('hex');
}

function areDuplicateResults(existing: SemanticSearchResult, candidate: SemanticSearchResult): boolean {
    if (existing.relativePath !== candidate.relativePath) {
        return false;
    }

    if (hasConflictingDefinitions(existing.content, candidate.content)) {
        return false;
    }

    return hasDuplicateLineRange(existing, candidate)
        || hasDuplicateContent(existing.content, candidate.content);
}

function hasDuplicateLineRange(existing: SemanticSearchResult, candidate: SemanticSearchResult): boolean {
    if (!hasUsableLineRange(existing) || !hasUsableLineRange(candidate)) {
        return false;
    }

    const overlapStart = Math.max(existing.startLine, candidate.startLine);
    const overlapEnd = Math.min(existing.endLine, candidate.endLine);
    if (overlapStart > overlapEnd) {
        return hasDuplicateAdjacentRange(existing, candidate);
    }

    const overlapSize = overlapEnd - overlapStart + 1;
    const existingSize = existing.endLine - existing.startLine + 1;
    const candidateSize = candidate.endLine - candidate.startLine + 1;
    const smallerSize = Math.min(existingSize, candidateSize);
    const largerSize = Math.max(existingSize, candidateSize);

    if (smallerSize <= 0 || largerSize <= 0) {
        return false;
    }

    return overlapSize / smallerSize > 0.5 || overlapSize / largerSize >= 0.6;
}

function hasDuplicateAdjacentRange(existing: SemanticSearchResult, candidate: SemanticSearchResult): boolean {
    const gap = existing.endLine < candidate.startLine
        ? candidate.startLine - existing.endLine - 1
        : existing.startLine - candidate.endLine - 1;
    if (gap < 0 || gap > ADJACENT_RANGE_MAX_GAP) {
        return false;
    }

    const existingSize = existing.endLine - existing.startLine + 1;
    const candidateSize = candidate.endLine - candidate.startLine + 1;
    const smallerSize = Math.min(existingSize, candidateSize);
    if (smallerSize < CONTENT_SIMILARITY_MIN_LINES) {
        return false;
    }

    const existingDefinition = getLeadingDefinitionSignature(existing.content);
    const candidateDefinition = getLeadingDefinitionSignature(candidate.content);
    if (existingDefinition && candidateDefinition && existingDefinition === candidateDefinition) {
        return true;
    }

    return getLineSetSimilarity(existing.content, candidate.content) >= ADJACENT_RANGE_SIMILARITY_THRESHOLD;
}

function hasDuplicateContent(existingContent: string, candidateContent: string): boolean {
    const existing = normalizeResultContent(existingContent);
    const candidate = normalizeResultContent(candidateContent);
    if (!existing || !candidate) {
        return false;
    }

    if (existing === candidate) {
        return existing.length >= CONTENT_DUPLICATE_MIN_LENGTH;
    }

    const shorter = existing.length <= candidate.length ? existing : candidate;
    const longer = existing.length > candidate.length ? existing : candidate;
    if (shorter.length >= CONTENT_DUPLICATE_MIN_LENGTH && longer.includes(shorter)) {
        return true;
    }

    return getLineSetSimilarity(existingContent, candidateContent) >= 0.82;
}

function shouldReplaceDuplicate(existing: SemanticSearchResult, candidate: SemanticSearchResult): boolean {
    if (!hasUsableLineRange(existing) && hasUsableLineRange(candidate)) {
        return true;
    }
    if (hasUsableLineRange(existing) && !hasUsableLineRange(candidate)) {
        return false;
    }

    const auditabilityDelta = getAuditabilityScore(candidate) - getAuditabilityScore(existing);
    if (auditabilityDelta >= AUDITABILITY_DECISIVE_DELTA) {
        return true;
    }
    if (auditabilityDelta <= -AUDITABILITY_DECISIVE_DELTA) {
        return false;
    }

    const existingOwnerSignal = hasExactOwnerSignal(existing);
    const candidateOwnerSignal = hasExactOwnerSignal(candidate);
    if (candidateOwnerSignal && !existingOwnerSignal) {
        return true;
    }
    if (existingOwnerSignal && !candidateOwnerSignal) {
        return false;
    }

    const existingStartsWithDefinition = startsWithDefinition(existing.content);
    const candidateStartsWithDefinition = startsWithDefinition(candidate.content);
    if (candidateStartsWithDefinition && !existingStartsWithDefinition && scoresAreClose(existing.score, candidate.score)) {
        return true;
    }
    if (existingStartsWithDefinition && !candidateStartsWithDefinition && scoresAreClose(existing.score, candidate.score)) {
        return false;
    }

    if (candidate.score > existing.score && !isMuchLessAuditable(existing, candidate)) {
        return true;
    }

    if (scoresAreClose(existing.score, candidate.score) && isMoreSpecific(candidate, existing)) {
        return true;
    }

    return false;
}

function hasExactOwnerSignal(result: SemanticSearchResult): boolean {
    const reasons = result.scoreReasons ?? (result.scoreReason ? [result.scoreReason] : []);
    return reasons.includes('exact_filename') || reasons.includes('exact_symbol_definition');
}

function normalizeResultContent(content: string): string {
    return content
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getLineSetSimilarity(existingContent: string, candidateContent: string): number {
    const existingLines = getMeaningfulLineSet(existingContent);
    const candidateLines = getMeaningfulLineSet(candidateContent);
    const smallerSize = Math.min(existingLines.size, candidateLines.size);
    if (smallerSize < CONTENT_SIMILARITY_MIN_LINES) {
        return 0;
    }

    let intersection = 0;
    for (const line of existingLines) {
        if (candidateLines.has(line)) {
            intersection++;
        }
    }

    const union = new Set([...existingLines, ...candidateLines]).size;
    return union === 0 ? 0 : intersection / union;
}

function getMeaningfulLineSet(content: string): Set<string> {
    return new Set(
        content
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map((line) => line.trim().replace(/\s+/g, ' '))
            .filter((line) => line.length >= 8)
    );
}

function startsWithDefinition(content: string): boolean {
    return getLeadingDefinitionSignature(content) !== undefined;
}

function getLeadingDefinitionSignature(content: string): string | undefined {
    const firstMeaningfulRawLine = content
        .replace(/\r\n/g, '\n')
        .split('\n')
        .find((line) => {
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
    const methodMatch = firstMeaningfulLine.match(/^(?:public|private|protected|static|async|override|readonly|\s)*(?:[A-Za-z_$][A-Za-z0-9_$<>[\],.?]*\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*(?:\{|=>|:)/);
    if (methodMatch) {
        return `method:${methodMatch[1]}`;
    }

    return undefined;
}

function getDefinitionSignatures(content: string): Set<string> {
    const signatures = new Set<string>();
    for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || isCommentLine(trimmed)) {
            continue;
        }

        const declarationMatch = line.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|function|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
        if (declarationMatch) {
            signatures.add(`${declarationMatch[1]}:${declarationMatch[2]}`);
        }
    }

    return signatures;
}

function hasConflictingDefinitions(existingContent: string, candidateContent: string): boolean {
    const existingDefinitions = getDefinitionSignatures(existingContent);
    const candidateDefinitions = getDefinitionSignatures(candidateContent);
    if (existingDefinitions.size === 0 || candidateDefinitions.size === 0) {
        return false;
    }

    if (isSubset(existingDefinitions, candidateDefinitions) || isSubset(candidateDefinitions, existingDefinitions)) {
        return false;
    }

    return true;
}

function isSubset(left: Set<string>, right: Set<string>): boolean {
    for (const value of left) {
        if (!right.has(value)) {
            return false;
        }
    }

    return true;
}

function isCommentLine(line: string): boolean {
    return line.startsWith('//')
        || line.startsWith('#')
        || line.startsWith('/*')
        || line.startsWith('*')
        || line.endsWith('*/');
}

function scoresAreClose(existingScore: number, candidateScore: number): boolean {
    const delta = Math.abs(existingScore - candidateScore);
    const scale = Math.max(Math.abs(existingScore), Math.abs(candidateScore), 1);
    return delta <= 1 || delta / scale <= 0.2;
}

function isMoreSpecific(candidate: SemanticSearchResult, existing: SemanticSearchResult): boolean {
    const candidateSize = getResultSize(candidate);
    const existingSize = getResultSize(existing);
    return candidateSize > 0 && existingSize > 0 && candidateSize < existingSize * 0.75;
}

function isMuchLessAuditable(existing: SemanticSearchResult, candidate: SemanticSearchResult): boolean {
    return startsWithDefinition(existing.content)
        && !startsWithDefinition(candidate.content)
        && scoresAreClose(existing.score, candidate.score);
}

function getAuditabilityScore(result: SemanticSearchResult): number {
    let score = 0;
    if (hasUsableLineRange(result)) {
        score += 2;
    }
    if (startsWithDefinition(result.content)) {
        score += 3;
    }
    if (hasBalancedSyntaxBlock(result.content)) {
        score += 1;
    }

    return score;
}

function hasBalancedSyntaxBlock(content: string): boolean {
    const meaningful = content
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (meaningful.length < 2) {
        return false;
    }

    const joined = meaningful.join('\n');
    const openBraces = (joined.match(/\{/g) ?? []).length;
    const closeBraces = (joined.match(/\}/g) ?? []).length;
    return openBraces > 0 && openBraces === closeBraces;
}

function getResultSize(result: SemanticSearchResult): number {
    if (hasUsableLineRange(result)) {
        return result.endLine - result.startLine + 1;
    }

    return normalizeResultContent(result.content).length;
}

function hasUsableLineRange(result: SemanticSearchResult): boolean {
    return hasValidLineRange(result);
}
