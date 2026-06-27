export interface SearchQuery {
    term: string;
    includeContent?: boolean;
    limit?: number;
}

export type SearchScoreReason =
    | 'exact_filename'
    | 'exact_symbol_definition'
    | 'path_match'
    | 'reference_match'
    | 'semantic_match';

export type SearchTargetRole = 'implementation' | 'test' | 'docs' | 'config' | 'all';

export type SearchResultGroup = 'implementation' | 'entry_exports' | 'related_tests' | 'docs_config' | 'other';

export type SearchChunkRole = 'definition' | 'method_body' | 'reference' | 'test_case' | 'assertion' | 're_export' | 'module_decl';

export interface SemanticSearchFilenameLikeQuery {
    normalizedPath: string;
    basename: string;
    isPathLike: boolean;
}

export interface SemanticSearchOptions {
    targetRole?: SearchTargetRole;
    includeRelated?: boolean;
    filenameLikeQuery?: SemanticSearchFilenameLikeQuery;
    enableLexicalSupplement?: boolean;
}

export interface SemanticSearchResult {
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    lineRangeUnavailable?: boolean;
    lineRangeWarning?: string;
    language: string;
    score: number;
    scoreReason?: SearchScoreReason;
    scoreReasons?: SearchScoreReason[];
    fileRole?: string;
    chunkRole?: string;
    resultGroup?: SearchResultGroup;
    isPrimary?: boolean;
}

export type SymbolTraceEvidenceKind = 'definition' | 'reference' | 'import' | 'export' | 'related_test';

export interface SymbolTraceOptions {
    startPath?: string;
    startLine?: number;
    endLine?: number;
    maxFiles?: number;
    maxReferences?: number;
    includeTests?: boolean;
}

export interface SymbolTraceEvidence {
    kind: SymbolTraceEvidenceKind;
    relativePath: string;
    line: number;
    preview: string;
    matchedText?: string;
    moduleSpecifier?: string;
    resolvedPath?: string;
    enclosingSymbol?: string;
    callTarget?: string;
}

export interface SymbolTraceResult {
    symbol: string;
    codebasePath: string;
    definitions: SymbolTraceEvidence[];
    references: SymbolTraceEvidence[];
    imports: SymbolTraceEvidence[];
    exports: SymbolTraceEvidence[];
    relatedTests: SymbolTraceEvidence[];
    scannedFiles: number;
    truncated: boolean;
    warnings: string[];
}
