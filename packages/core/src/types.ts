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
}
