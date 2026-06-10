import { Context, SearchTimeoutError } from './context';
import { Embedding, EmbeddingVector } from './embedding';
import { VectorDatabase } from './vectordb';

class TestEmbedding extends Embedding {
    protected maxTokens = 8192;

    async detectDimension(): Promise<number> {
        return 3;
    }

    async embed(_text: string): Promise<EmbeddingVector> {
        return { vector: [1, 0, 0], dimension: 3 };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map(() => ({ vector: [1, 0, 0], dimension: 3 }));
    }

    getDimension(): number {
        return 3;
    }

    getProvider(): string {
        return 'test';
    }
}

const createVectorDatabase = (): jest.Mocked<VectorDatabase> => ({
    createCollection: jest.fn().mockResolvedValue(undefined),
    createHybridCollection: jest.fn().mockResolvedValue(undefined),
    ensureHybridCollectionReady: jest.fn().mockResolvedValue(undefined),
    dropCollection: jest.fn().mockResolvedValue(undefined),
    hasCollection: jest.fn().mockResolvedValue(true),
    listCollections: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockResolvedValue(undefined),
    insertHybrid: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockReturnValue(new Promise(() => undefined)),
    hybridSearch: jest.fn().mockReturnValue(new Promise(() => undefined)),
    delete: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([{ id: 'chunk-1' }]),
    getCollectionDescription: jest.fn().mockResolvedValue(''),
    checkCollectionLimit: jest.fn().mockResolvedValue(true),
    getCollectionRowCount: jest.fn().mockResolvedValue(1),
});

describe('Context semanticSearch timeout', () => {
    it('returns a bounded timeout error when vector search does not finish', async () => {
        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            searchTimeoutMs: 10,
        });

        await expect(context.semanticSearch('/repo', 'find auth flow'))
            .rejects
            .toBeInstanceOf(SearchTimeoutError);
    });
});
