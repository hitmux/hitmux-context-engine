import OpenAI from 'openai';
import { Embedding, EmbeddingVector } from './base-embedding';

export interface OpenAIEmbeddingConfig {
    model: string;
    apiKey: string;
    baseURL?: string; // OpenAI supports custom baseURL
}

export class OpenAIEmbedding extends Embedding {
    private client: OpenAI;
    private config: OpenAIEmbeddingConfig;
    private dimension: number = 1536; // Default dimension for text-embedding-3-small
    protected maxTokens: number = 8192; // Maximum tokens for OpenAI embedding models
    private static readonly detectedDimensions = new Map<string, number>();

    constructor(config: OpenAIEmbeddingConfig) {
        super();
        this.config = config;
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
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

        const cachedDimension = OpenAIEmbedding.detectedDimensions.get(model);
        if (cachedDimension) {
            this.dimension = cachedDimension;
            return cachedDimension;
        }

        // For custom models, make API call to detect dimension
        try {
            const processedText = this.preprocessText(testText);
            const response = await this.client.embeddings.create({
                model: model,
                input: processedText,
                encoding_format: 'float',
            });
            const dimension = response.data[0].embedding.length;
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

        await this.ensureDimension(model);

        try {
            const response = await this.client.embeddings.create({
                model: model,
                input: processedText,
                encoding_format: 'float',
            });

            // Update dimension from actual response
            this.cacheDimension(model, response.data[0].embedding.length);

            return {
                vector: response.data[0].embedding,
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

        await this.ensureDimension(model);

        try {
            const response = await this.client.embeddings.create({
                model: model,
                input: processedTexts,
                encoding_format: 'float',
            });

            this.cacheDimension(model, response.data[0].embedding.length);

            return response.data.map((item) => ({
                vector: item.embedding,
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

        const cachedDimension = OpenAIEmbedding.detectedDimensions.get(model);
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

        const cachedDimension = OpenAIEmbedding.detectedDimensions.get(model);
        if (cachedDimension) {
            this.dimension = cachedDimension;
            return;
        }

        this.dimension = await this.detectDimension();
    }

    private cacheDimension(model: string, dimension: number): void {
        this.dimension = dimension;
        if (!OpenAIEmbedding.getSupportedModels()[model]) {
            OpenAIEmbedding.detectedDimensions.set(model, dimension);
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
