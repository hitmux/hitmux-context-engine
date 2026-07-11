import { SemanticSearchResult } from '../types';
import { EmbeddingProviderName } from '../utils/config-manager';
import { closeProxyDispatcher, createSystemProxyDispatcher } from '../utils/proxy-env';
import type { Dispatcher } from 'undici';

export const DEFAULT_RERANK_MODEL = 'cohere/rerank-4-fast';
export const DEFAULT_RERANK_CANDIDATE_LIMIT = 100;
export const MAX_RERANK_CANDIDATE_LIMIT = 100;
export const DEFAULT_RERANK_TIMEOUT_MS = 8000;
export const DEFAULT_RERANK_MAX_CHARS_PER_DOCUMENT = 6000;
export const DEFAULT_OPENROUTER_RERANK_BASE_URL = 'https://openrouter.ai/api/v1';

export interface ExternalRerankConfig {
    enabled: boolean;
    model: string;
    endpoint?: string;
    apiKey?: string;
    candidateLimit: number;
    timeoutMs: number;
    maxCharsPerDocument: number;
    useSystemProxy: boolean;
    skipReason?: string;
    candidateLimitClamped: boolean;
}

export interface ExternalRerankConfigInput {
    rerankEnabled?: boolean;
    rerankModel?: string;
    rerankBaseUrl?: string;
    rerankApiKey?: string;
    rerankCandidateLimit?: number;
    rerankTimeoutMs?: number;
    rerankMaxCharsPerDocument?: number;
    rerankUseSystemProxy?: boolean;
    embeddingProvider?: EmbeddingProviderName;
    embeddingBaseUrl?: string;
    embeddingApiKey?: string;
    embeddingUseSystemProxy?: boolean;
}

interface RerankResponseResult {
    index: number;
    relevance_score: number;
}

interface RerankResponse {
    results: RerankResponseResult[];
}

export function resolveExternalRerankConfig(input: ExternalRerankConfigInput): ExternalRerankConfig {
    const enabled = input.rerankEnabled !== false;
    const configuredCandidateLimit = normalizePositiveInteger(input.rerankCandidateLimit, DEFAULT_RERANK_CANDIDATE_LIMIT);
    const candidateLimit = Math.min(configuredCandidateLimit, MAX_RERANK_CANDIDATE_LIMIT);
    const explicitBaseUrl = normalizeBaseUrl(input.rerankBaseUrl);
    const embeddingBaseUrl = normalizeBaseUrl(input.embeddingBaseUrl);
    const provider = input.embeddingProvider || 'OpenRouter';
    const endpointBaseUrl = explicitBaseUrl
        || (provider === 'OpenRouter' ? embeddingBaseUrl || DEFAULT_OPENROUTER_RERANK_BASE_URL : undefined)
        || (isOpenRouterBaseUrl(embeddingBaseUrl) ? embeddingBaseUrl : undefined);
    const apiKey = trimToUndefined(input.rerankApiKey) || trimToUndefined(input.embeddingApiKey);
    const endpoint = endpointBaseUrl ? appendRerankPath(endpointBaseUrl) : undefined;

    let skipReason: string | undefined;
    if (!enabled) {
        skipReason = 'disabled by config';
    } else if (!endpoint) {
        skipReason = `no rerank endpoint for embedding provider ${provider}`;
    } else if (!apiKey) {
        skipReason = 'missing rerank API key';
    }

    return {
        enabled,
        model: trimToUndefined(input.rerankModel) || DEFAULT_RERANK_MODEL,
        endpoint,
        apiKey,
        candidateLimit,
        timeoutMs: normalizePositiveInteger(input.rerankTimeoutMs, DEFAULT_RERANK_TIMEOUT_MS),
        maxCharsPerDocument: normalizePositiveInteger(input.rerankMaxCharsPerDocument, DEFAULT_RERANK_MAX_CHARS_PER_DOCUMENT),
        useSystemProxy: input.rerankUseSystemProxy ?? input.embeddingUseSystemProxy ?? false,
        skipReason,
        candidateLimitClamped: configuredCandidateLimit > MAX_RERANK_CANDIDATE_LIMIT
    };
}

export async function externalRerankSemanticSearchResults<T extends SemanticSearchResult>(
    query: string,
    results: T[],
    config: ExternalRerankConfig
): Promise<T[]> {
    if (!config.enabled || config.skipReason || results.length <= 1) {
        return results;
    }

    const endpoint = config.endpoint;
    const apiKey = config.apiKey;
    if (!endpoint || !apiKey) {
        return results;
    }

    const limitedResults = results.slice(0, config.candidateLimit);
    const remainingResults = results.slice(config.candidateLimit);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    let dispatcher: Dispatcher | undefined;

    try {
        dispatcher = createSystemProxyDispatcher(endpoint, config.useSystemProxy);
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'X-Hitmux-Client': 'Hitmux Context Engine'
            },
            body: JSON.stringify({
                model: config.model,
                query,
                documents: limitedResults.map(result => formatRerankDocument(result, config.maxCharsPerDocument)),
                top_n: limitedResults.length
            }),
            signal: controller.signal,
            ...(dispatcher ? { dispatcher } : {})
        } as RequestInit & { dispatcher?: Dispatcher });

        if (!response.ok) {
            console.log(`[Context] ⚠️  External rerank failed with HTTP ${response.status}; using original search order.`);
            return results;
        }

        const payload = await response.json() as unknown;
        const rerankResponse = parseRerankResponse(payload, limitedResults.length);
        if (!rerankResponse) {
            console.log('[Context] ⚠️  External rerank returned an unexpected response; using original search order.');
            return results;
        }

        const byIndex = new Map<number, T>();
        limitedResults.forEach((result, index) => byIndex.set(index, result));

        const reranked: T[] = [];
        const seen = new Set<number>();
        for (const [rank, item] of rerankResponse.results.entries()) {
            const result = byIndex.get(item.index);
            if (!result || seen.has(item.index)) {
                continue;
            }

            reranked.push({
                ...result,
                rerankScore: item.relevance_score,
                rerankRank: rank + 1
            });
            seen.add(item.index);
        }

        for (const [index, result] of limitedResults.entries()) {
            if (!seen.has(index)) {
                reranked.push(result);
            }
        }

        console.log(`[Context] 🔁 External rerank applied to ${limitedResults.length} candidates with ${config.model}.`);
        return [...reranked, ...remainingResults];
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.log(`[Context] ⚠️  External rerank failed (${reason}); using original search order.`);
        return results;
    } finally {
        clearTimeout(timeout);
        await closeProxyDispatcher(dispatcher);
    }
}

function parseRerankResponse(payload: unknown, candidateCount: number): RerankResponse | null {
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { results?: unknown }).results)) {
        return null;
    }

    const results: RerankResponseResult[] = [];
    for (const item of (payload as { results: unknown[] }).results) {
        if (!item || typeof item !== 'object') {
            return null;
        }
        const candidate = item as { index?: unknown; relevance_score?: unknown };
        const index = candidate.index;
        if (
            typeof index !== 'number'
            || !Number.isInteger(index)
            || typeof candidate.relevance_score !== 'number'
            || !Number.isFinite(candidate.relevance_score)
            || index < 0
            || index >= candidateCount
        ) {
            return null;
        }
        results.push({
            index,
            relevance_score: candidate.relevance_score
        });
    }

    return { results };
}

function formatRerankDocument(result: SemanticSearchResult, maxChars: number): string {
    const metadata = [
        `path: ${result.relativePath}`,
        `lines: ${result.startLine}-${result.endLine}`,
        `language: ${result.language}`,
        result.fileRole ? `fileRole: ${result.fileRole}` : '',
        result.chunkRole ? `chunkRole: ${result.chunkRole}` : ''
    ].filter(Boolean).join('\n');
    const content = `${metadata}\n\n${result.content}`;
    return content.length > maxChars ? content.slice(0, maxChars) : content;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function trimToUndefined(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
    const trimmed = trimToUndefined(value);
    if (!trimmed) {
        return undefined;
    }

    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return undefined;
        }
        return trimmed.replace(/\/+$/, '');
    } catch {
        return undefined;
    }
}

function isOpenRouterBaseUrl(value: string | undefined): boolean {
    if (!value) {
        return false;
    }

    try {
        return new URL(value).hostname === 'openrouter.ai';
    } catch {
        return false;
    }
}

function appendRerankPath(baseUrl: string): string {
    return baseUrl.endsWith('/rerank') ? baseUrl : `${baseUrl}/rerank`;
}
