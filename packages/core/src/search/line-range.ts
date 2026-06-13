export interface NormalizedLineRange {
    startLine: number;
    endLine: number;
    lineRangeUnavailable?: boolean;
    lineRangeWarning?: string;
}

interface LineRangeInput {
    startLine?: unknown;
    endLine?: unknown;
    metadata?: Record<string, unknown>;
    content?: string;
}

export function normalizeLineRange(input: LineRangeInput): NormalizedLineRange {
    const directRange = buildRange(input.startLine, input.endLine, input.content);
    if (directRange) {
        return directRange;
    }

    const metadataRange = getMetadataLineRange(input.metadata, input.content);
    if (metadataRange) {
        return metadataRange;
    }

    return {
        startLine: 0,
        endLine: 0,
        lineRangeUnavailable: true,
        lineRangeWarning: 'line range unavailable; re-index this codebase to refresh line metadata.'
    };
}

export function hasValidLineRange(value: { startLine?: unknown; endLine?: unknown; lineRangeUnavailable?: boolean }): value is { startLine: number; endLine: number } {
    if (value.lineRangeUnavailable) {
        return false;
    }

    const startLine = normalizeLineNumber(value.startLine);
    const endLine = normalizeLineNumber(value.endLine);
    return startLine !== undefined && endLine !== undefined && endLine >= startLine;
}

function getMetadataLineRange(metadata: Record<string, unknown> | undefined, content: string | undefined): NormalizedLineRange | undefined {
    if (!metadata) {
        return undefined;
    }

    const directRange = buildRange(metadata.startLine, metadata.endLine, content)
        || buildRange(metadata.sourceStartLine, metadata.sourceEndLine, content)
        || buildRange(metadata.lineStart, metadata.lineEnd, content)
        || buildRange(metadata.start, metadata.end, content);
    if (directRange) {
        return directRange;
    }

    const loc = metadata.loc;
    if (isRecord(loc)) {
        const locRange = buildRange(loc.startLine, loc.endLine, content)
            || buildRange(loc.start, loc.end, content);
        if (locRange) {
            return locRange;
        }

        const lines = loc.lines;
        if (isRecord(lines)) {
            return buildRange(lines.from, lines.to, content)
                || buildRange(lines.start, lines.end, content);
        }
    }

    return undefined;
}

function buildRange(startValue: unknown, endValue: unknown, content: string | undefined): NormalizedLineRange | undefined {
    const startLine = normalizeLineNumber(startValue);
    const endLine = normalizeLineNumber(endValue);

    if (startLine === undefined) {
        return undefined;
    }

    if (endLine !== undefined && endLine >= startLine) {
        return { startLine, endLine };
    }

    return {
        startLine,
        endLine: inferEndLine(startLine, content)
    };
}

function normalizeLineNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        return value;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^[1-9]\d*$/.test(trimmed)) {
            return Number(trimmed);
        }
    }

    return undefined;
}

function inferEndLine(startLine: number, content: string | undefined): number {
    if (!content) {
        return startLine;
    }

    return startLine + content.split(/\r?\n/).length - 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
