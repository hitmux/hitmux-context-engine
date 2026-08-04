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
    autoTopK?: SearchAutoTopKOptions;
}

export type SearchAutoTopKSignal = 'rerank' | 'vector' | 'hybrid_rrf' | 'mixed' | 'none';

export type SearchAutoTopKStrategy = 'calibrated' | 'legacy-gap';

export type SearchAutoTopKReason =
    | 'significant_score_gap'
    | 'no_reliable_score_gap'
    | 'insufficient_finite_scores'
    | 'no_score_signal'
    | 'calibrated_threshold'
    | 'strong_lexical_evidence'
    | 'calibration_profile_missing'
    | 'no_finite_scores';

export interface SearchAutoTopKDecision {
    selectedResults: number;
    acceptedResults: number;
    minResults: number;
    maxResults: number;
    availableResults: number;
    candidateWindow: number;
    returnCap: number;
    truncated: boolean;
    signal: SearchAutoTopKSignal;
    reason: SearchAutoTopKReason;
    /** Internal ordering used to retain accepted candidates for continuation pages. */
    acceptedCandidateIndexes?: number[];
}

export interface SearchAutoTopKOptions {
    /** Deprecated in calibrated mode. Retained for legacy-gap rollback compatibility. */
    minResults?: number;
    useVectorFallback: boolean;
    strategy?: SearchAutoTopKStrategy;
    candidateWindow?: number;
    returnCap?: number;
    provider?: string;
    model?: string;
    intent?: string;
    onDecision?: (decision: SearchAutoTopKDecision) => void;
    onCandidateManifest?: (manifest: SearchCandidateManifest) => void;
}

export interface SearchCandidateManifestEntry {
    id: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    contentFingerprint: string;
    rank: number;
    score: number;
    retrievalScore?: number;
    rerankScore?: number;
    scoreReasons?: SearchScoreReason[];
    fileRole?: string;
    chunkRole?: string;
    resultGroup?: SearchResultGroup;
    isPrimary?: boolean;
}

export interface SearchCandidateManifest {
    candidates: SearchCandidateManifestEntry[];
    acceptedCount: number;
    returnedCount: number;
    candidateWindow: number;
    returnCap: number;
    truncated: boolean;
}

export interface SemanticSearchPage {
    results: SemanticSearchResult[];
    acceptedResults: number;
    returnedResults: number;
    candidateWindow: number;
    returnCap: number;
    truncated: boolean;
    candidates: SearchCandidateManifestEntry[];
    decision?: SearchAutoTopKDecision;
}

export interface SemanticSearchResult {
    /** Internal chunk id. Kept on results so continuation pages can re-fetch by id. */
    id?: string;
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
    rerankScore?: number;
    rerankRank?: number;
    /** Internal retrieval score retained so local TopK selection ignores lexical-only scores. */
    retrievalScore?: number;
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
