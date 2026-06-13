import { MilvusVectorDatabase } from './milvus-vectordb';
import { MilvusRestfulVectorDatabase } from './milvus-restful-vectordb';

class TestableMilvusVectorDatabase extends MilvusVectorDatabase {
    waitUntilInitialized(): Promise<void> {
        return this.ensureInitialized();
    }
}

class TestableMilvusRestfulVectorDatabase extends MilvusRestfulVectorDatabase {
    waitUntilInitialized(): Promise<void> {
        return this.ensureInitialized();
    }
}

function waitForUnhandledRejectionTurn(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

describe('Milvus initialization', () => {
    it('does not emit an unhandled rejection when SDK initialization is missing an address', async () => {
        const unhandledRejections: unknown[] = [];
        const listener = (reason: unknown) => {
            unhandledRejections.push(reason);
        };
        process.on('unhandledRejection', listener);

        try {
            const database = new TestableMilvusVectorDatabase({});
            await waitForUnhandledRejectionTurn();

            expect(unhandledRejections).toHaveLength(0);
            await expect(database.waitUntilInitialized()).rejects.toThrow('Address is required and could not be resolved from token');
        } finally {
            process.removeListener('unhandledRejection', listener);
        }
    });

    it('does not emit an unhandled rejection when REST initialization is missing an address', async () => {
        const unhandledRejections: unknown[] = [];
        const listener = (reason: unknown) => {
            unhandledRejections.push(reason);
        };
        process.on('unhandledRejection', listener);

        try {
            const database = new TestableMilvusRestfulVectorDatabase({});
            await waitForUnhandledRejectionTurn();

            expect(unhandledRejections).toHaveLength(0);
            await expect(database.waitUntilInitialized()).rejects.toThrow('Address is required and could not be resolved from token');
        } finally {
            process.removeListener('unhandledRejection', listener);
        }
    });
});
