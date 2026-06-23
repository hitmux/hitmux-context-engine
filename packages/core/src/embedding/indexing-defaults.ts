export interface EmbeddingIndexingDefaults {
    batchSize: number;
    concurrency: number;
}

export const DEFAULT_EMBEDDING_BATCH_SIZE = 64;
export const DEFAULT_EMBEDDING_CONCURRENCY = 2;

const PROVIDER_DEFAULTS: Record<string, EmbeddingIndexingDefaults> = {
    OpenRouter: { batchSize: 64, concurrency: 2 },
    OpenAI: { batchSize: 64, concurrency: 2 },
    VoyageAI: { batchSize: 64, concurrency: 2 },
    Gemini: { batchSize: 64, concurrency: 2 },
    Ollama: { batchSize: 16, concurrency: 1 },
};

export function getEmbeddingIndexingDefaults(provider?: string, _model?: string): EmbeddingIndexingDefaults {
    const providerDefaults = provider ? PROVIDER_DEFAULTS[provider] : undefined;
    if (providerDefaults) {
        return providerDefaults;
    }

    return {
        batchSize: DEFAULT_EMBEDDING_BATCH_SIZE,
        concurrency: DEFAULT_EMBEDDING_CONCURRENCY,
    };
}
