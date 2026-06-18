import { getEmbeddingIndexingDefaults } from './indexing-defaults';

describe('embedding indexing defaults', () => {
    it('uses faster defaults for the default OpenRouter Qwen embedding model', () => {
        expect(getEmbeddingIndexingDefaults('OpenRouter', 'qwen/qwen3-embedding-4b')).toEqual({
            batchSize: 32,
            concurrency: 4,
        });
    });

    it('keeps conservative defaults for local Ollama embeddings', () => {
        expect(getEmbeddingIndexingDefaults('Ollama', 'nomic-embed-text')).toEqual({
            batchSize: 16,
            concurrency: 1,
        });
    });

    it('uses provider defaults when a model default belongs to another provider', () => {
        expect(getEmbeddingIndexingDefaults('Ollama', 'qwen/qwen3-embedding-4b')).toEqual({
            batchSize: 16,
            concurrency: 1,
        });
    });

    it('falls back to the stable provider/model default when the provider is unknown', () => {
        expect(getEmbeddingIndexingDefaults('CustomProvider', 'custom-model')).toEqual({
            batchSize: 32,
            concurrency: 4,
        });
    });
});
