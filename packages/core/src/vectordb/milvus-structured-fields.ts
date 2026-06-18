import * as crypto from 'crypto';
import * as path from 'path';
import { getNormalizedContentHash } from '../search/result-dedupe';
import { VectorDocument, STRUCTURED_METADATA_FIELDS } from './types';

export const STRUCTURED_STRING_FIELD_DEFINITIONS = [
    { name: 'primarySymbol', description: 'Primary symbol or section identifier', maxLength: 512 },
    { name: 'symbolKind', description: 'Symbol kind from splitter metadata', maxLength: 64 },
    { name: 'chunkKind', description: 'Chunk kind from splitter metadata', maxLength: 64 },
    { name: 'fileRole', description: 'File role inferred from path and extension', maxLength: 64 },
    { name: 'basename', description: 'File basename without extension', maxLength: 255 },
    { name: 'pathSegment0', description: 'Path segment 0', maxLength: 255 },
    { name: 'pathSegment1', description: 'Path segment 1', maxLength: 255 },
    { name: 'pathSegment2', description: 'Path segment 2', maxLength: 255 },
    { name: 'pathSegment3', description: 'Path segment 3', maxLength: 255 },
    { name: 'pathSegment4', description: 'Path segment 4', maxLength: 255 },
] as const;

const ROW_DERIVED_METADATA_FIELDS = [
    'content',
    'relativePath',
    'startLine',
    'endLine',
    'fileExtension',
    'fileName',
    'pathTokens',
    'symbols',
    'definitionIdentifiers',
    'sourceStartLine',
    'sourceEndLine',
    'contentHash',
    'normalizedContentHash',
] as const;

const METADATA_HYDRATION_FIELDS = [
    'content',
    'relativePath',
    'startLine',
    'endLine',
    ...STRUCTURED_METADATA_FIELDS,
] as const;

export function getStructuredFieldValue(document: VectorDocument, field: string): string | boolean {
    if (field === 'isDefinition') {
        return document.isDefinition === true;
    }

    const value = document[field as keyof VectorDocument];
    return typeof value === 'string' ? value : '';
}

export function createStructuredInsertRow(document: VectorDocument): Record<string, any> {
    const row: Record<string, any> = {
        id: document.id,
        vector: document.vector,
        content: document.content,
        relativePath: document.relativePath,
        startLine: document.startLine,
        endLine: document.endLine,
        fileExtension: document.fileExtension,
        metadata: JSON.stringify(createSlimMetadata(document.metadata)),
    };

    for (const field of STRUCTURED_METADATA_FIELDS) {
        row[field] = getStructuredFieldValue(document, field);
    }

    return row;
}

export function createSlimMetadata(metadata: Record<string, any>): Record<string, any> {
    const slimMetadata = { ...metadata };
    for (const field of STRUCTURED_METADATA_FIELDS) {
        delete slimMetadata[field];
    }
    for (const field of ROW_DERIVED_METADATA_FIELDS) {
        delete slimMetadata[field];
    }
    return slimMetadata;
}

export function mergeStructuredMetadata(result: Record<string, any>, metadata: Record<string, any>): Record<string, any> {
    const merged = { ...metadata };
    for (const field of STRUCTURED_METADATA_FIELDS) {
        const value = result[field];
        if (typeof value === 'string' || typeof value === 'boolean') {
            merged[field] = value;
        }
    }
    mergeRowDerivedMetadata(result, merged);
    return merged;
}

export function getMetadataHydrationOutputFields(outputFields: string[]): string[] {
    if (!outputFields.includes('metadata') || outputFields.includes('*')) {
        return outputFields;
    }

    return [...new Set([...outputFields, ...METADATA_HYDRATION_FIELDS])];
}

export function hydrateSlimMetadataRows(rows: Record<string, any>[], requestedOutputFields: string[]): Record<string, any>[] {
    const includesWildcard = requestedOutputFields.includes('*');
    if (!requestedOutputFields.includes('metadata') && !includesWildcard) {
        return rows;
    }

    const requestedFields = new Set(requestedOutputFields);
    return rows.map((row) => {
        const hydratedRow = { ...row };
        if (typeof hydratedRow.metadata === 'string') {
            try {
                hydratedRow.metadata = JSON.stringify(mergeStructuredMetadata(hydratedRow, JSON.parse(hydratedRow.metadata || '{}')));
            } catch {
                // Keep the original metadata value when legacy rows contain invalid JSON.
            }
        } else if (hydratedRow.metadata && typeof hydratedRow.metadata === 'object') {
            hydratedRow.metadata = mergeStructuredMetadata(hydratedRow, hydratedRow.metadata);
        }

        if (!includesWildcard) {
            for (const field of METADATA_HYDRATION_FIELDS) {
                if (!requestedFields.has(field)) {
                    delete hydratedRow[field];
                }
            }
        }
        return hydratedRow;
    });
}

function mergeRowDerivedMetadata(result: Record<string, any>, metadata: Record<string, any>): void {
    if (typeof metadata.fileName !== 'string' && typeof result.relativePath === 'string') {
        metadata.fileName = path.posix.basename(result.relativePath);
    }

    if (typeof metadata.fileExtension !== 'string' && typeof result.fileExtension === 'string') {
        metadata.fileExtension = result.fileExtension;
    }

    const startLine = getLineNumber(result.startLine);
    if (metadata.sourceStartLine === undefined && startLine !== undefined) {
        metadata.sourceStartLine = startLine;
    }

    const endLine = getLineNumber(result.endLine);
    if (metadata.sourceEndLine === undefined && endLine !== undefined) {
        metadata.sourceEndLine = endLine;
    }

    if (typeof result.content === 'string') {
        if (typeof metadata.contentHash !== 'string') {
            metadata.contentHash = crypto.createHash('sha1').update(result.content).digest('hex');
        }
        if (typeof metadata.normalizedContentHash !== 'string') {
            metadata.normalizedContentHash = getNormalizedContentHash(result.content);
        }

        mergeContentDerivedMetadata(result.content, result, metadata);
    }
}

function mergeContentDerivedMetadata(content: string, result: Record<string, any>, metadata: Record<string, any>): void {
    if (!Array.isArray(metadata.pathTokens) && typeof result.relativePath === 'string') {
        metadata.pathTokens = extractPathTokens(result.relativePath);
    }

    const definitionIdentifiers = new Set<string>(extractDefinitionIdentifiers(content));
    const symbols = new Set<string>(definitionIdentifiers);
    const symbolName = typeof metadata.symbolName === 'string'
        ? metadata.symbolName
        : typeof result.primarySymbol === 'string'
            ? result.primarySymbol
            : '';

    if (symbolName.length > 0) {
        symbols.add(symbolName);
        if (result.isDefinition === true || metadata.isDefinition === true) {
            definitionIdentifiers.add(symbolName);
        }
    }

    if (!Array.isArray(metadata.definitionIdentifiers)) {
        metadata.definitionIdentifiers = [...definitionIdentifiers];
    }
    if (!Array.isArray(metadata.symbols)) {
        metadata.symbols = [...symbols];
    }
}

function getLineNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        return value;
    }
    if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) {
        return Number(value.trim());
    }
    return undefined;
}

function extractPathTokens(relativePath: string): string[] {
    return [...new Set(
        relativePath
            .split(/[\\/._-]+/)
            .map(token => token.trim())
            .filter(token => token.length >= 2)
    )];
}

function extractDefinitionIdentifiers(content: string): string[] {
    const identifiers = new Set<string>();
    const definitionPatterns = [
        /\b(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|function|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g,
        /\b(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
        /\bfunc\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
        /\b(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
        /\b(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|mod)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
        /\b(?:public|private|protected|internal|static|final|abstract|override|virtual|async|sealed|synchronized|\s)+(?:[A-Za-z_$][A-Za-z0-9_$<>\[\],.?]*\s+)+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g,
        /^#{1,6}\s+(.+?)\s*#*\s*$/gm,
    ];

    for (const pattern of definitionPatterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
            identifiers.add(match[1].trim());
        }
    }

    return [...identifiers];
}

export function getStructuredDocumentFields(result: Record<string, any>): Partial<VectorDocument> {
    const fields: Partial<VectorDocument> = {};
    for (const field of STRUCTURED_METADATA_FIELDS) {
        const value = result[field];
        if (typeof value === 'string' || typeof value === 'boolean') {
            (fields as Record<string, string | boolean>)[field] = value;
        }
    }
    return fields;
}

export function createSchemaMismatchError(collectionName: string, detail: string): Error {
    return new Error(`Collection '${collectionName}' uses an unsupported search schema. ${detail} Reindex the codebase with force=true to create schema v2 metadata fields.`);
}

export function isMissingStructuredFieldMessage(message: string): boolean {
    return STRUCTURED_METADATA_FIELDS.some(field => message.includes(field))
        && /field|schema|output|not.*exist|not.*found|cannot.*find|undefined/i.test(message);
}

export function requireCurrentStructuredSchema(collectionName: string, description: string): void {
    const metadataLine = description
        .split(/\r?\n/)
        .find((line) => line.startsWith('hitmuxContext:'));
    if (!metadataLine) {
        throw createSchemaMismatchError(collectionName, 'Missing hitmuxContext collection metadata.');
    }

    let metadata: any;
    try {
        metadata = JSON.parse(metadataLine.slice('hitmuxContext:'.length));
    } catch {
        throw createSchemaMismatchError(collectionName, 'Invalid hitmuxContext collection metadata.');
    }

    const schemaVersion = metadata?.schemaVersion ?? 1;
    const metadataVersion = metadata?.metadataVersion ?? 1;
    if (schemaVersion !== 2 || metadataVersion !== 2) {
        throw createSchemaMismatchError(collectionName, `Indexed schemaVersion=${schemaVersion}, metadataVersion=${metadataVersion}; current schemaVersion=2, metadataVersion=2.`);
    }
}
