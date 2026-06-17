import { Context } from './context';
import { FileSynchronizer } from './sync/synchronizer';
import { VectorDatabase } from './vectordb';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const createVectorDatabase = (): jest.Mocked<VectorDatabase> => ({
    createCollection: jest.fn().mockResolvedValue(undefined),
    createHybridCollection: jest.fn().mockResolvedValue(undefined),
    ensureHybridCollectionReady: jest.fn().mockResolvedValue(undefined),
    dropCollection: jest.fn().mockResolvedValue(undefined),
    hasCollection: jest.fn().mockResolvedValue(false),
    listCollections: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockResolvedValue(undefined),
    insertHybrid: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    hybridSearch: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
    getCollectionDescription: jest.fn().mockResolvedValue(''),
    checkCollectionLimit: jest.fn().mockResolvedValue(true),
    getCollectionRowCount: jest.fn().mockResolvedValue(999),
});

describe('codebase identity path normalization', () => {
    it('maps Windows drive paths with different casing to the same collection', () => {
        const context = new Context({ vectorDatabase: createVectorDatabase() });

        expect(context.getCollectionName('C:\\Repo')).toBe(context.getCollectionName('c:\\repo'));
        expect(context.getCollectionName('C:/Repo/Sub')).toBe(context.getCollectionName('c:/repo/sub'));
    });

    it('maps Windows drive paths with different casing to the same snapshot path', () => {
        const upper = new FileSynchronizer('C:\\Repo') as any;
        const lower = new FileSynchronizer('c:\\repo') as any;

        expect(upper.snapshotPath).toBe(lower.snapshotPath);
    });

    it('keeps different absolute paths isolated by default', () => {
        const context = new Context({ vectorDatabase: createVectorDatabase() });

        expect(context.getCollectionName('/repo/one')).not.toBe(context.getCollectionName('/repo/two'));
    });

    it('shares one collection in global identity mode', () => {
        const context = new Context({
            vectorDatabase: createVectorDatabase(),
            collectionIdentity: {
                mode: 'global',
                globalName: 'team_kb'
            }
        });

        expect(context.getCollectionName('/repo/one')).toBe(context.getCollectionName('/repo/two'));
        expect(context.getCollectionName('/repo/one')).toMatch(/^hybrid_code_chunks_team_kb_[a-f0-9]{8}$/);
    });

    it('shares one collection for an explicit custom identity', () => {
        const context = new Context({
            vectorDatabase: createVectorDatabase(),
            collectionIdentity: {
                mode: 'custom',
                customIdentity: 'remote:git@example.com/acme/repo'
            }
        });

        expect(context.getCollectionName('/checkout/a')).toBe(context.getCollectionName('/checkout/b'));
    });

    it('keys gitRemote identity by the configured remote URL', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hitmux-context-engine-identity-'));
        try {
            const firstRepo = path.join(tempRoot, 'first');
            const secondRepo = path.join(tempRoot, 'second');
            fs.mkdirSync(path.join(firstRepo, '.git'), { recursive: true });
            fs.mkdirSync(path.join(secondRepo, '.git'), { recursive: true });
            const config = [
                '[remote "origin"]',
                '    url = git@github.com:hitmux/hitmux-context-engine.git',
                ''
            ].join('\n');
            fs.writeFileSync(path.join(firstRepo, '.git', 'config'), config);
            fs.writeFileSync(path.join(secondRepo, '.git', 'config'), config);

            const context = new Context({
                vectorDatabase: createVectorDatabase(),
                collectionIdentity: {
                    mode: 'gitRemote'
                }
            });

            expect(context.getCollectionName(firstRepo)).toBe(context.getCollectionName(secondRepo));
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
