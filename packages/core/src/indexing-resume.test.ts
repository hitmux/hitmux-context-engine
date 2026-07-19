import * as crypto from 'crypto';
import * as nodeFs from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    FullIndexResumeJournal,
    FullIndexResumeSourceChangedError,
} from './indexing-resume';

const hashFile = (content: string): string => crypto.createHash('sha256').update(content, 'utf8').digest('hex');

function getJournalPaths(codebasePath: string, collectionName: string): { headerPath: string; progressPath: string } {
    const key = crypto
        .createHash('sha256')
        .update(`${codebasePath}\0${collectionName}`)
        .digest('hex');
    const directory = path.join(os.homedir(), '.hitmux-context-engine', 'index-resume');
    return {
        headerPath: path.join(directory, `${key}.json`),
        progressPath: path.join(directory, `${key}.jsonl`),
    };
}

describe('FullIndexResumeJournal', () => {
    let tempRoot: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hitmux-context-engine-resume-'));
        originalHome = process.env.HOME;
        process.env.HOME = path.join(tempRoot, 'home');
    });

    afterEach(async () => {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    it('streams and compacts a v1 journal without retaining VectorDocument payloads', async () => {
        const codebasePath = path.join(tempRoot, 'project');
        const collectionName = 'project_chunks';
        const paths = getJournalPaths(codebasePath, collectionName);
        const content = 'export const value = 1;';
        const fileHash = hashFile(content);
        const documents = Array.from({ length: 64 }, (_, index) => ({
            id: `chunk-${index}`,
            relativePath: 'src/index.ts',
            fileHash,
            vector: Array.from({ length: 1024 }, () => index),
            content: 'x'.repeat(32_000),
            metadata: { nested: 'metadata payload' },
        }));
        await fs.mkdir(path.dirname(paths.headerPath), { recursive: true });
        await fs.writeFile(paths.headerPath, JSON.stringify({
            version: 1,
            codebasePath,
            collectionName,
            runSignature: 'test-run',
            startedAt: '2026-07-15T00:00:00.000Z',
        }), 'utf8');
        await fs.writeFile(
            paths.progressPath,
            `${JSON.stringify({ documents })}\n{"documents":[`,
            'utf8',
        );

        const readFileSpy = jest.spyOn(nodeFs.promises, 'readFile');
        try {
            const journal = await FullIndexResumeJournal.load({ codebasePath, collectionName });
            expect(journal).toBeDefined();
            expect(journal?.usesFileCheckpoints()).toBe(false);
            expect(readFileSpy).not.toHaveBeenCalledWith(paths.progressPath, 'utf8');
            expect(journal?.prepareFile('src/index.ts', content, true)).toBe(false);
            expect(journal?.isDocumentCommitted('chunk-0', 'src/index.ts', true)).toBe(true);
            expect(journal?.isDocumentCommitted('missing', 'src/index.ts', true)).toBe(false);
        } finally {
            readFileSpy.mockRestore();
        }

        const migratedHeader = JSON.parse(await fs.readFile(paths.headerPath, 'utf8')) as Record<string, unknown>;
        expect(migratedHeader).toMatchObject({ version: 2, checkpointMode: 'document' });
        const migratedProgress = await fs.readFile(paths.progressPath, 'utf8');
        expect(Buffer.byteLength(migratedProgress, 'utf8')).toBeLessThan(16 * 1024);
        expect(migratedProgress).not.toContain('"vector"');
        expect(migratedProgress).not.toContain('"content"');
        expect(migratedProgress).not.toContain('"metadata"');
        expect(JSON.parse(migratedProgress.trim())).toEqual({
            documents: documents.map(({ id, relativePath, fileHash: checkpointHash }) => ({
                id,
                relativePath,
                fileHash: checkpointHash,
            })),
        });
        expect(await fs.readdir(path.dirname(paths.progressPath))).not.toEqual(
            expect.arrayContaining([expect.stringContaining('.tmp-')]),
        );
    });

    it('keeps v1 source hash conflict protection while migrating', async () => {
        const codebasePath = path.join(tempRoot, 'project');
        const collectionName = 'project_chunks';
        const paths = getJournalPaths(codebasePath, collectionName);
        await fs.mkdir(path.dirname(paths.headerPath), { recursive: true });
        await fs.writeFile(paths.headerPath, JSON.stringify({
            version: 1,
            codebasePath,
            collectionName,
            runSignature: 'test-run',
            startedAt: '2026-07-15T00:00:00.000Z',
        }), 'utf8');
        await fs.writeFile(paths.progressPath, `${JSON.stringify({
            documents: [
                { id: 'first', relativePath: 'src/index.ts', fileHash: 'first-hash' },
                { id: 'second', relativePath: 'src/index.ts', fileHash: 'second-hash' },
            ],
        })}\n`, 'utf8');

        await expect(FullIndexResumeJournal.load({ codebasePath, collectionName }))
            .rejects.toBeInstanceOf(FullIndexResumeSourceChangedError);
    });

    it('writes compact file checkpoints and distinguishes partial from complete files', async () => {
        const codebasePath = path.join(tempRoot, 'project');
        const collectionName = 'project_chunks';
        const source = 'export const value = 1;';
        const journal = await FullIndexResumeJournal.create({
            codebasePath,
            collectionName,
            runSignature: 'test-run',
        });
        expect(journal.prepareFile('src/index.ts', source, false)).toBe(false);
        journal.markCommitted(Array.from({ length: 64 }, (_, index) => ({
            id: `chunk-${index}`,
            relativePath: 'src/index.ts',
            vector: Array.from({ length: 1024 }, () => index),
            content: 'x'.repeat(32_000),
            metadata: { nested: 'metadata payload' },
        })));
        await journal.flush();

        const paths = getJournalPaths(codebasePath, collectionName);
        const partialProgress = await fs.readFile(paths.progressPath, 'utf8');
        expect(Buffer.byteLength(partialProgress, 'utf8')).toBeLessThan(1024);
        expect(JSON.parse(partialProgress.trim())).toEqual({
            relativePath: 'src/index.ts',
            fileHash: hashFile(source),
            state: 'partial',
        });
        expect(partialProgress).not.toContain('"vector"');
        expect(partialProgress).not.toContain('"content"');
        expect(partialProgress).not.toContain('"metadata"');

        const partialJournal = await FullIndexResumeJournal.load({ codebasePath, collectionName });
        expect(partialJournal?.prepareFile('src/index.ts', source, true)).toBe(false);
        await expect(Promise.resolve().then(() => partialJournal?.prepareFile('src/index.ts', 'changed', true)))
            .rejects.toBeInstanceOf(FullIndexResumeSourceChangedError);

        journal.markFileComplete('src/index.ts');
        await journal.flush();
        const completeJournal = await FullIndexResumeJournal.load({ codebasePath, collectionName });
        expect(completeJournal?.prepareFile('src/index.ts', source, true)).toBe(true);
        expect(() => completeJournal?.assertNoCommittedFileWasRemoved([]))
            .toThrow(FullIndexResumeSourceChangedError);
        await expect(Promise.resolve().then(() => completeJournal?.prepareFile('src/index.ts', 'changed', true)))
            .rejects.toBeInstanceOf(FullIndexResumeSourceChangedError);
    });
});
