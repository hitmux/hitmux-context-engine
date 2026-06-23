import { getEmbeddingIndexingDefaults } from './indexing-defaults';

describe('embedding indexing defaults', () => {
    it('uses hosted embedding provider defaults regardless of model', () => {
        expect(getEmbeddingIndexingDefaults('OpenRouter', 'qwen/qwen3-embedding-4b')).toEqual({
            batchSize: 64,
            concurrency: 2,
        });
        expect(getEmbeddingIndexingDefaults('OpenAI', 'custom-model')).toEqual({
            batchSize: 64,
            concurrency: 2,
        });
    });

    it('keeps conservative defaults for local Ollama embeddings', () => {
        expect(getEmbeddingIndexingDefaults('Ollama', 'nomic-embed-text')).toEqual({
            batchSize: 16,
            concurrency: 1,
        });
    });

    it('uses provider defaults without model-specific overrides', () => {
        expect(getEmbeddingIndexingDefaults('Ollama', 'qwen/qwen3-embedding-4b')).toEqual({
            batchSize: 16,
            concurrency: 1,
        });
    });

    it('falls back to the stable provider/model default when the provider is unknown', () => {
        expect(getEmbeddingIndexingDefaults('CustomProvider', 'custom-model')).toEqual({
            batchSize: 64,
            concurrency: 2,
        });
    });
});
