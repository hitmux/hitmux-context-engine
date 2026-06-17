export interface EmbeddingIndexingDefaults {
    batchSize: number;
    concurrency: number;
}

export const DEFAULT_EMBEDDING_BATCH_SIZE = 32;
export const DEFAULT_EMBEDDING_CONCURRENCY = 4;

type ModelDefault = EmbeddingIndexingDefaults & {
    providers?: string[];
};

const PROVIDER_DEFAULTS: Record<string, EmbeddingIndexingDefaults> = {
    OpenRouter: { batchSize: 32, concurrency: 4 },
    OpenAI: { batchSize: 64, concurrency: 2 },
    VoyageAI: { batchSize: 64, concurrency: 2 },
    Gemini: { batchSize: 32, concurrency: 2 },
    Ollama: { batchSize: 16, concurrency: 1 },
};

const MODEL_DEFAULTS: Record<string, ModelDefault> = {
    'qwen/qwen3-embedding-4b': { batchSize: 32, concurrency: 4, providers: ['OpenRouter', 'OpenAI'] },
    'qwen/qwen3-embedding-8b': { batchSize: 32, concurrency: 4, providers: ['OpenRouter', 'OpenAI'] },
    'nomic-embed-text': { batchSize: 16, concurrency: 1, providers: ['Ollama'] },
};

export function getEmbeddingIndexingDefaults(provider?: string, model?: string): EmbeddingIndexingDefaults {
    const modelDefaults = model ? MODEL_DEFAULTS[model] : undefined;
    if (modelDefaults && isModelDefaultCompatible(modelDefaults, provider)) {
        return {
            batchSize: modelDefaults.batchSize,
            concurrency: modelDefaults.concurrency,
        };
    }

    const providerDefaults = provider ? PROVIDER_DEFAULTS[provider] : undefined;
    if (providerDefaults) {
        return providerDefaults;
    }

    return {
        batchSize: DEFAULT_EMBEDDING_BATCH_SIZE,
        concurrency: DEFAULT_EMBEDDING_CONCURRENCY,
    };
}

function isModelDefaultCompatible(modelDefaults: ModelDefault, provider?: string): boolean {
    if (!modelDefaults.providers || !provider) {
        return true;
    }

    return modelDefaults.providers.includes(provider);
}
