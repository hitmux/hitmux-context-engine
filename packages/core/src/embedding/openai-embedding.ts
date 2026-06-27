import OpenAI from 'openai';
import { Embedding, EmbeddingVector } from './base-embedding';

export interface OpenAIEmbeddingConfig {
    model: string;
    apiKey: string;
    baseURL?: string; // OpenAI supports custom baseURL
    defaultHeaders?: Record<string, string>;
    retryMaxElapsedMs?: number;
}

export class OpenAIEmbedding extends Embedding {
    private client: OpenAI;
    private config: OpenAIEmbeddingConfig;
    private dimension: number = 1536; // Default dimension for text-embedding-3-small
    protected maxTokens: number = 8192; // Maximum tokens for OpenAI embedding models
    private static readonly detectedDimensions = new Map<string, number>();
    private static readonly retryDelayMs = 3000;
    private static readonly defaultRetryMaxElapsedMs = 60000;

    constructor(config: OpenAIEmbeddingConfig) {
        super();
        this.config = config;
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            defaultHeaders: config.defaultHeaders,
        });
    }

    async detectDimension(testText: string = "test"): Promise<number> {
        const model = this.config.model || 'text-embedding-3-small';
        const knownModels = OpenAIEmbedding.getSupportedModels();

        // Use known dimension for standard models
        if (knownModels[model]) {
            this.dimension = knownModels[model].dimension;
            return knownModels[model].dimension;
        }

        const cachedDimension = OpenAIEmbedding.detectedDimensions.get(this.getDimensionCacheKey(model));
        if (cachedDimension) {
            this.dimension = cachedDimension;
            return cachedDimension;
        }

        // For custom models, make API call to detect dimension
        try {
            const processedText = this.preprocessText(testText);
            const embeddings = await this.withRetry('detect embedding dimension', async () => {
                const response = await this.client.embeddings.create({
                    model: model,
                    input: processedText,
                    encoding_format: 'float',
                });
                return this.getEmbeddingResponseVectors(response, 1);
            });
            const dimension = embeddings[0].length;
            this.cacheDimension(model, dimension);
            return dimension;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            // Re-throw authentication errors
            if (errorMessage.includes('API key') || errorMessage.includes('unauthorized') || errorMessage.includes('authentication')) {
                throw new Error(`Failed to detect dimension for model ${model}: ${errorMessage}`);
            }

            // For other errors, throw exception instead of using fallback
            throw new Error(`Failed to detect dimension for model ${model}: ${errorMessage}`);
        }
    }

    async embed(text: string): Promise<EmbeddingVector> {
        const processedText = this.preprocessText(text);
        const model = this.config.model || 'text-embedding-3-small';

        try {
            const embeddings = await this.withRetry('generate OpenAI embedding', async () => {
                const response = await this.client.embeddings.create({
                    model: model,
                    input: processedText,
                    encoding_format: 'float',
                });
                return this.getEmbeddingResponseVectors(response, 1);
            });

            // Update dimension from actual response
            this.cacheDimension(model, embeddings[0].length);

            return {
                vector: embeddings[0],
                dimension: this.dimension
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to generate OpenAI embedding: ${errorMessage}`);
        }
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        const processedTexts = this.preprocessTexts(texts);
        const model = this.config.model || 'text-embedding-3-small';

        try {
            const embeddings = await this.withRetry('generate OpenAI batch embeddings', async () => {
                const response = await this.client.embeddings.create({
                    model: model,
                    input: processedTexts,
                    encoding_format: 'float',
                });
                return this.getEmbeddingResponseVectors(response, processedTexts.length);
            });

            this.cacheDimension(model, embeddings[0].length);

            return embeddings.map((embedding) => ({
                vector: embedding,
                dimension: this.dimension
            }));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to generate OpenAI batch embeddings: ${errorMessage}`);
        }
    }

    getDimension(): number {
        // For custom models, we need to detect the dimension first
        const model = this.config.model || 'text-embedding-3-small';
        const knownModels = OpenAIEmbedding.getSupportedModels();

        // If it's a known model, return its known dimension
        if (knownModels[model]) {
            this.dimension = knownModels[model].dimension;
            return knownModels[model].dimension;
        }

        const cachedDimension = OpenAIEmbedding.detectedDimensions.get(this.getDimensionCacheKey(model));
        if (cachedDimension) {
            this.dimension = cachedDimension;
            return cachedDimension;
        }

        // For custom models, return the current dimension
        // Note: This may be incorrect until detectDimension() is called
        console.warn(`[OpenAIEmbedding] ⚠️ getDimension() called for custom model '${model}' - returning ${this.dimension}. Call detectDimension() first for accurate dimension.`);
        return this.dimension;
    }

    getProvider(): string {
        return 'OpenAI';
    }

    getModel(): string {
        return this.config.model || 'text-embedding-3-small';
    }

    /**
     * Set model type
     * @param model Model name
     */
    async setModel(model: string): Promise<void> {
        this.config.model = model;
        this.dimension = await this.detectDimension();
    }

    private async ensureDimension(model: string): Promise<void> {
        const knownModels = OpenAIEmbedding.getSupportedModels();
        const knownDimension = knownModels[model]?.dimension;
        if (knownDimension) {
            this.dimension = knownDimension;
            return;
        }

        const cachedDimension = OpenAIEmbedding.detectedDimensions.get(this.getDimensionCacheKey(model));
        if (cachedDimension) {
            this.dimension = cachedDimension;
            return;
        }

        this.dimension = await this.detectDimension();
    }

    private cacheDimension(model: string, dimension: number): void {
        this.dimension = dimension;
        if (!OpenAIEmbedding.getSupportedModels()[model]) {
            OpenAIEmbedding.detectedDimensions.set(this.getDimensionCacheKey(model), dimension);
        }
    }

    private async withRetry<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
        const startedAtMs = Date.now();
        const retryMaxElapsedMs = this.getRetryMaxElapsedMs();
        for (let attempt = 1; ; attempt += 1) {
            try {
                return await operation();
            } catch (error) {
                const elapsedMs = Date.now() - startedAtMs;
                const nextElapsedMs = elapsedMs + OpenAIEmbedding.retryDelayMs;
                if (!this.isRetryableEmbeddingError(error) || nextElapsedMs > retryMaxElapsedMs) {
                    throw error;
                }

                console.warn(
                    `[OpenAIEmbedding] ${operationName} failed with retryable provider error. ` +
                    `Retrying in ${OpenAIEmbedding.retryDelayMs}ms ` +
                    `(attempt ${attempt + 1}, elapsed ${elapsedMs}ms, budget ${retryMaxElapsedMs}ms). ` +
                    this.getErrorMessage(error)
                );
                await this.sleep(OpenAIEmbedding.retryDelayMs);
            }
        }
    }

    private getRetryMaxElapsedMs(): number {
        const configured = this.config.retryMaxElapsedMs;
        if (configured === undefined) {
            return OpenAIEmbedding.defaultRetryMaxElapsedMs;
        }

        if (!Number.isFinite(configured) || configured < 0) {
            return OpenAIEmbedding.defaultRetryMaxElapsedMs;
        }

        return Math.floor(configured);
    }

    private isRetryableEmbeddingError(error: unknown): boolean {
        const errorRecord = error as { status?: unknown; code?: unknown };
        if (errorRecord.status === 429 || errorRecord.code === 429 || errorRecord.code === '429') {
            return true;
        }

        const message = this.getErrorMessage(error).toLowerCase();
        return message.includes('http 429') ||
            message.includes('rate limit') ||
            message.includes('engine_overloaded') ||
            message.includes('model busy');
    }

    private getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private getEmbeddingResponseVectors(response: unknown, expectedCount: number): number[][] {
        const responseRecord = response as {
            data?: Array<{ embedding?: unknown }>;
            error?: { message?: unknown; code?: unknown; type?: unknown };
        } | null;

        if (!responseRecord || !Array.isArray(responseRecord.data)) {
            throw new Error(
                `Embedding response missing data array${this.formatProviderError(responseRecord)}${this.formatResponseKeys(responseRecord)}`
            );
        }

        if (responseRecord.data.length < expectedCount) {
            throw new Error(
                `Embedding response returned ${responseRecord.data.length} item(s), expected ${expectedCount}${this.formatProviderError(responseRecord)}`
            );
        }

        return responseRecord.data.slice(0, expectedCount).map((item, index) => {
            if (!Array.isArray(item.embedding) || !item.embedding.every((value) => typeof value === 'number')) {
                throw new Error(`Embedding response item ${index} is missing a numeric embedding vector`);
            }
            return item.embedding;
        });
    }

    private formatProviderError(response: { error?: { message?: unknown; code?: unknown; type?: unknown } } | null): string {
        const error = response?.error;
        if (!error) {
            return '';
        }

        const details = [
            typeof error.message === 'string' ? `message=${error.message}` : undefined,
            typeof error.code === 'string' || typeof error.code === 'number' ? `code=${error.code}` : undefined,
            typeof error.type === 'string' ? `type=${error.type}` : undefined,
        ].filter(Boolean);
        return details.length > 0 ? `; provider error: ${details.join(', ')}` : '; provider error present';
    }

    private formatResponseKeys(response: object | null): string {
        if (!response) {
            return '';
        }

        return `; response keys: ${Object.keys(response).join(', ') || 'none'}`;
    }

    private getDimensionCacheKey(model: string): string {
        return `${this.getNormalizedBaseURL()}::${model}`;
    }

    private getNormalizedBaseURL(): string {
        const baseURL = this.config.baseURL?.trim();
        if (!baseURL) {
            return 'openai-default';
        }

        try {
            return new URL(baseURL).toString().replace(/\/+$/, '');
        } catch {
            return baseURL.replace(/\/+$/, '');
        }
    }

    /**
     * Get client instance (for advanced usage)
     */
    getClient(): OpenAI {
        return this.client;
    }

    /**
     * Get list of supported models
     */
    static getSupportedModels(): Record<string, { dimension: number; description: string }> {
        return {
            'text-embedding-3-small': {
                dimension: 1536,
                description: 'High performance and cost-effective embedding model (recommended)'
            },
            'text-embedding-3-large': {
                dimension: 3072,
                description: 'Highest performance embedding model with larger dimensions'
            },
            'text-embedding-ada-002': {
                dimension: 1536,
                description: 'Legacy model (use text-embedding-3-small instead)'
            },
            'qwen/qwen3-embedding-4b': {
                dimension: 2560,
                description: 'Qwen3 Embedding 4B model via OpenAI-compatible providers'
            },
            'qwen/qwen3-embedding-8b': {
                dimension: 4096,
                description: 'Qwen3 Embedding 8B model via OpenAI-compatible providers'
            }
        };
    }
} 
