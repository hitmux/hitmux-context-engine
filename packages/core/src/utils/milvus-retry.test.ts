import {
    isRetryableMilvusConnectionError,
    withMilvusConnectionRetry,
} from './milvus-retry';

describe('Milvus connection retry', () => {
    it('retries unavailable transport failures with exponential backoff', async () => {
        const attempts: number[] = [];
        const delays: number[] = [];

        await expect(withMilvusConnectionRetry(
            'test insert',
            async (attempt) => {
                attempts.push(attempt);
                if (attempt < 3) {
                    throw { code: 14, message: 'UNAVAILABLE: No connection established' };
                }
                return 'ok';
            },
            {
                maxAttempts: 4,
                initialDelayMs: 10,
                sleep: async (delayMs) => {
                    delays.push(delayMs);
                },
            },
        )).resolves.toBe('ok');

        expect(attempts).toEqual([1, 2, 3]);
        expect(delays).toEqual([10, 20]);
    });

    it('does not retry ambiguous timeout failures', async () => {
        const operation = jest.fn(async () => {
            throw new Error('DEADLINE_EXCEEDED');
        });

        await expect(withMilvusConnectionRetry('test insert', operation)).rejects.toThrow('DEADLINE_EXCEEDED');
        expect(operation).toHaveBeenCalledTimes(1);
        expect(isRetryableMilvusConnectionError(new Error('ECONNREFUSED 127.0.0.1:19530'))).toBe(true);
        expect(isRetryableMilvusConnectionError(new Error('DEADLINE_EXCEEDED'))).toBe(false);
    });
});
