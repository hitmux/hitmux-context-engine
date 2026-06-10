import { Ollama } from 'ollama';
import { OllamaEmbedding } from './ollama-embedding';

const mockEmbed = jest.fn();

jest.mock('ollama', () => ({
    Ollama: jest.fn().mockImplementation(() => ({
        embed: mockEmbed,
    })),
}));

describe('OllamaEmbedding', () => {
    beforeEach(() => {
        mockEmbed.mockReset();
        (Ollama as unknown as jest.Mock).mockClear();
    });

    it('detects batch dimensions from the batch response without a probe request', async () => {
        mockEmbed.mockResolvedValue({
            embeddings: [
                [1, 0, 0, 0],
                [0, 1, 0, 0],
            ],
        });

        const embedding = new OllamaEmbedding({
            model: 'nomic-embed-text',
            host: 'http://127.0.0.1:11434',
        });

        const vectors = await embedding.embedBatch(['first chunk', 'second chunk']);

        expect(vectors).toEqual([
            { vector: [1, 0, 0, 0], dimension: 4 },
            { vector: [0, 1, 0, 0], dimension: 4 },
        ]);
        expect(embedding.getDimension()).toBe(4);
        expect(mockEmbed).toHaveBeenCalledTimes(1);
        expect(mockEmbed).toHaveBeenCalledWith({
            model: 'nomic-embed-text',
            input: ['first chunk', 'second chunk'],
            options: undefined,
        });
    });

    it('throws a model-specific error when batch response count mismatches input count', async () => {
        mockEmbed.mockResolvedValue({
            embeddings: [
                [1, 0, 0],
            ],
        });

        const embedding = new OllamaEmbedding({
            model: 'mxbai-embed-large',
        });

        await expect(embedding.embedBatch(['first chunk', 'second chunk']))
            .rejects
            .toThrow('Ollama API returned 1 embeddings for 2 inputs using model "mxbai-embed-large"');
    });

    it('returns an empty batch without calling Ollama', async () => {
        const embedding = new OllamaEmbedding({
            model: 'nomic-embed-text',
        });

        await expect(embedding.embedBatch([])).resolves.toEqual([]);
        expect(mockEmbed).not.toHaveBeenCalled();
    });
});
