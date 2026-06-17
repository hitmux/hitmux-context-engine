import OpenAI from 'openai';
import { OpenAIEmbedding } from './openai-embedding';

const mockCreate = jest.fn();

jest.mock('openai', () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
        embeddings: {
            create: mockCreate,
        },
    })),
}));

describe('OpenAIEmbedding', () => {
    beforeEach(() => {
        jest.useRealTimers();
        mockCreate.mockReset();
        (OpenAI as unknown as jest.Mock).mockClear();
    });

    it('caches detected dimensions per baseURL and model', async () => {
        mockCreate
            .mockResolvedValueOnce({ data: [{ embedding: [1, 2, 3] }] })
            .mockResolvedValueOnce({ data: [{ embedding: [1, 2, 3, 4, 5] }] });

        const first = new OpenAIEmbedding({
            apiKey: 'test-api-key',
            model: 'custom-embedding',
            baseURL: 'https://provider-a.example/v1/',
        });
        const second = new OpenAIEmbedding({
            apiKey: 'test-api-key',
            model: 'custom-embedding',
            baseURL: 'https://provider-b.example/v1',
        });

        await expect(first.detectDimension()).resolves.toBe(3);
        await expect(second.detectDimension()).resolves.toBe(5);
        expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('normalizes equivalent baseURL values for dimension cache keys', async () => {
        mockCreate.mockResolvedValueOnce({ data: [{ embedding: [1, 2, 3, 4] }] });

        const first = new OpenAIEmbedding({
            apiKey: 'test-api-key',
            model: 'same-provider-custom-embedding',
            baseURL: 'https://provider.example/v1/',
        });
        const second = new OpenAIEmbedding({
            apiKey: 'test-api-key',
            model: 'same-provider-custom-embedding',
            baseURL: 'https://provider.example/v1',
        });

        await expect(first.detectDimension()).resolves.toBe(4);
        await expect(second.detectDimension()).resolves.toBe(4);
        expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('does not probe dimension before embedding a custom model batch', async () => {
        mockCreate.mockResolvedValueOnce({
            data: [
                { embedding: [1, 2, 3, 4, 5] },
                { embedding: [6, 7, 8, 9, 10] },
            ],
        });

        const embedding = new OpenAIEmbedding({
            apiKey: 'test-api-key',
            model: 'custom-batch-model',
            baseURL: 'https://provider.example/v1',
        });

        await expect(embedding.embedBatch(['first chunk', 'second chunk'])).resolves.toEqual([
            { vector: [1, 2, 3, 4, 5], dimension: 5 },
            { vector: [6, 7, 8, 9, 10], dimension: 5 },
        ]);
        expect(mockCreate).toHaveBeenCalledTimes(1);
        expect(mockCreate).toHaveBeenCalledWith({
            model: 'custom-batch-model',
            input: ['first chunk', 'second chunk'],
            encoding_format: 'float',
        });
    });

    it('reports malformed embedding responses with provider details', async () => {
        mockCreate.mockResolvedValueOnce({
            error: {
                message: 'upstream provider returned no embeddings',
                code: 502,
            },
        });

        const embedding = new OpenAIEmbedding({
            apiKey: 'test-api-key',
            model: 'text-embedding-3-small',
            baseURL: 'https://provider.example/v1',
        });

        await expect(embedding.embedBatch(['first chunk', 'second chunk']))
            .rejects
            .toThrow(/Embedding response missing data array; provider error: message=upstream provider returned no embeddings, code=502; response keys: error/);
    });

    it('retries retryable OpenAI-compatible embedding provider errors after a delay', async () => {
        jest.useFakeTimers();
        mockCreate
            .mockResolvedValueOnce({
                error: {
                    message: 'HTTP 429: {"error":{"code":"engine_overloaded","message":"Model busy, retry later"}}',
                    code: 429,
                },
            })
            .mockResolvedValueOnce({
                data: [
                    { embedding: [1, 2, 3] },
                    { embedding: [4, 5, 6] },
                ],
            });

        const embedding = new OpenAIEmbedding({
            apiKey: 'test-api-key',
            model: 'text-embedding-3-small',
            baseURL: 'https://provider.example/v1',
        });

        const resultPromise = embedding.embedBatch(['first chunk', 'second chunk']);

        await Promise.resolve();
        expect(mockCreate).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(3000);

        await expect(resultPromise).resolves.toEqual([
            { vector: [1, 2, 3], dimension: 3 },
            { vector: [4, 5, 6], dimension: 3 },
        ]);
        expect(mockCreate).toHaveBeenCalledTimes(2);
    });
});
