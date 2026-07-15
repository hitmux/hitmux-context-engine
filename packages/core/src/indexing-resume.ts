import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const RESUME_JOURNAL_VERSION = 1;
const CHECKPOINT_INTERVAL_MS = 2_000;

export interface FullIndexResumeJournalInput {
    codebasePath: string;
    collectionName: string;
    runSignature: string;
}

interface FullIndexResumeHeader extends FullIndexResumeJournalInput {
    version: number;
    startedAt: string;
}

interface FullIndexResumeProgressRecord {
    documents: Array<{
        id: string;
        relativePath: string;
        fileHash: string;
    }>;
}

function getResumeJournalKey(codebasePath: string, collectionName: string): string {
    return crypto
        .createHash('sha256')
        .update(`${codebasePath}\0${collectionName}`)
        .digest('hex');
}

function getResumeJournalPaths(codebasePath: string, collectionName: string): {
    headerPath: string;
    progressPath: string;
} {
    const directory = path.join(os.homedir(), '.hitmux-context-engine', 'index-resume');
    const key = getResumeJournalKey(codebasePath, collectionName);
    return {
        headerPath: path.join(directory, `${key}.json`),
        progressPath: path.join(directory, `${key}.jsonl`),
    };
}

function isValidHeader(value: unknown): value is FullIndexResumeHeader {
    if (!value || typeof value !== 'object') return false;
    const header = value as Partial<FullIndexResumeHeader>;
    return header.version === RESUME_JOURNAL_VERSION
        && typeof header.codebasePath === 'string'
        && typeof header.collectionName === 'string'
        && typeof header.runSignature === 'string'
        && typeof header.startedAt === 'string';
}

function getErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class FullIndexResumeSourceChangedError extends Error {
    constructor(codebasePath: string) {
        super(
            `The source files for '${codebasePath}' changed after its interrupted full index. ` +
            'Refusing to combine old and new chunks. Run a force rebuild to start a clean index.',
        );
        this.name = 'FullIndexResumeSourceChangedError';
    }
}

export class FullIndexResumeConfigurationChangedError extends Error {
    constructor(codebasePath: string) {
        super(
            `The indexing configuration for '${codebasePath}' changed after its interrupted full index. ` +
            'Run a force rebuild to avoid mixing incompatible chunks.',
        );
        this.name = 'FullIndexResumeConfigurationChangedError';
    }
}

/**
 * Durable, append-only acknowledgement journal for a full index. It is local
 * by design: the vector database remains the data plane, while this journal
 * only records batches known to have completed. Writes are coalesced and never
 * sit on the embedding or Milvus insertion critical path.
 */
export class FullIndexResumeJournal {
    private readonly committedDocumentIds: Set<string>;
    private pendingDocumentIds = new Set<string>();
    private writeQueue: Promise<void> = Promise.resolve();
    private writeError: unknown;
    private flushTimer: NodeJS.Timeout | undefined;
    private lastFlushAt = Date.now();

    private constructor(
        private readonly header: FullIndexResumeHeader,
        private readonly paths: { headerPath: string; progressPath: string },
        committedDocumentIds: Iterable<string>,
        private readonly committedFileHashes: Map<string, string>,
        private readonly committedFilePaths: Set<string>,
    ) {
        this.committedDocumentIds = new Set(committedDocumentIds);
    }

    public static async create(input: FullIndexResumeJournalInput): Promise<FullIndexResumeJournal> {
        const paths = getResumeJournalPaths(input.codebasePath, input.collectionName);
        const header: FullIndexResumeHeader = {
            version: RESUME_JOURNAL_VERSION,
            ...input,
            startedAt: new Date().toISOString(),
        };
        await fs.mkdir(path.dirname(paths.headerPath), { recursive: true });
        // Remove an old progress stream before publishing its replacement
        // header. A crash in this window replays data safely; it can never
        // attach stale acknowledgements to a new full-index run.
        await fs.rm(paths.progressPath, { force: true });
        const tempPath = `${paths.headerPath}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tempPath, JSON.stringify(header), 'utf8');
        await fs.rename(tempPath, paths.headerPath);
        return new FullIndexResumeJournal(header, paths, [], new Map(), new Set());
    }

    public static async load(input: Pick<FullIndexResumeJournalInput, 'codebasePath' | 'collectionName'>): Promise<FullIndexResumeJournal | undefined> {
        const paths = getResumeJournalPaths(input.codebasePath, input.collectionName);
        let header: FullIndexResumeHeader;
        try {
            header = JSON.parse(await fs.readFile(paths.headerPath, 'utf8')) as FullIndexResumeHeader;
        } catch (error: unknown) {
            if (getErrorCode(error) === 'ENOENT') return undefined;
            throw new Error(`Failed to read indexing resume journal for '${input.codebasePath}': ${getErrorMessage(error)}`);
        }

        if (!isValidHeader(header)
            || header.codebasePath !== input.codebasePath
            || header.collectionName !== input.collectionName) {
            return undefined;
        }

        const committedDocumentIds = new Set<string>();
        const committedFileHashes = new Map<string, string>();
        const committedFilePaths = new Set<string>();
        try {
            const content = await fs.readFile(paths.progressPath, 'utf8');
            for (const line of content.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const record = JSON.parse(line) as Partial<FullIndexResumeProgressRecord>;
                    if (Array.isArray(record.documents)) {
                        for (const document of record.documents) {
                            if (typeof document?.id !== 'string'
                                || typeof document.relativePath !== 'string'
                                || typeof document.fileHash !== 'string') {
                                continue;
                            }
                            const previousHash = committedFileHashes.get(document.relativePath);
                            if (previousHash && previousHash !== document.fileHash) {
                                throw new FullIndexResumeSourceChangedError(header.codebasePath);
                            }
                            committedDocumentIds.add(document.id);
                            committedFileHashes.set(document.relativePath, document.fileHash);
                            committedFilePaths.add(document.relativePath);
                        }
                    }
                } catch (error) {
                    if (error instanceof FullIndexResumeSourceChangedError) {
                        throw error;
                    }
                    // A process may die during append. Earlier complete JSONL
                    // records are valid; replaying the final partial record is
                    // safe because resumed writes use primary-key upsert.
                }
            }
        } catch (error: unknown) {
            if (getErrorCode(error) !== 'ENOENT') {
                if (error instanceof FullIndexResumeSourceChangedError) {
                    throw error;
                }
                throw new Error(`Failed to read indexing resume progress for '${input.codebasePath}': ${getErrorMessage(error)}`);
            }
        }

        return new FullIndexResumeJournal(
            header,
            paths,
            committedDocumentIds,
            committedFileHashes,
            committedFilePaths,
        );
    }

    public static async exists(input: Pick<FullIndexResumeJournalInput, 'codebasePath' | 'collectionName'>): Promise<boolean> {
        return (await this.load(input)) !== undefined;
    }

    public static async clear(input: Pick<FullIndexResumeJournalInput, 'codebasePath' | 'collectionName'>): Promise<void> {
        const paths = getResumeJournalPaths(input.codebasePath, input.collectionName);
        await Promise.all([
            fs.rm(paths.headerPath, { force: true }),
            fs.rm(paths.progressPath, { force: true }),
        ]);
    }

    public validate(input: Pick<FullIndexResumeJournalInput, 'runSignature'>): void {
        if (this.header.runSignature !== input.runSignature) {
            throw new FullIndexResumeConfigurationChangedError(this.header.codebasePath);
        }
    }

    public assertNoCommittedFileWasRemoved(currentRelativePaths: Iterable<string>): void {
        const currentPaths = new Set(currentRelativePaths);
        for (const relativePath of this.committedFilePaths) {
            if (!currentPaths.has(relativePath)) {
                throw new FullIndexResumeSourceChangedError(this.header.codebasePath);
            }
        }
    }

    public prepareFile(relativePath: string, content: string, resumeMode: boolean): void {
        const fileHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
        const committedHash = this.committedFileHashes.get(relativePath);
        if (resumeMode && committedHash !== undefined && committedHash !== fileHash) {
            throw new FullIndexResumeSourceChangedError(this.header.codebasePath);
        }
        this.committedFileHashes.set(relativePath, fileHash);
    }

    public isDocumentCommitted(documentId: string, relativePath: string, resumeMode: boolean): boolean {
        return resumeMode
            && this.committedFileHashes.has(relativePath)
            && this.committedDocumentIds.has(documentId);
    }

    public markCommitted(documents: ReadonlyArray<{ id: string; relativePath: string }>): void {
        this.throwIfWriteFailed();
        const pendingDocuments: FullIndexResumeProgressRecord['documents'] = [];
        for (const document of documents) {
            if (!this.committedDocumentIds.has(document.id)) {
                const fileHash = this.committedFileHashes.get(document.relativePath);
                if (!fileHash) {
                    throw new Error(`Missing resume fingerprint for '${document.relativePath}'`);
                }
                this.committedDocumentIds.add(document.id);
                this.committedFilePaths.add(document.relativePath);
                pendingDocuments.push({ ...document, fileHash });
            }
        }
        if (pendingDocuments.length > 0) {
            for (const document of pendingDocuments) {
                this.pendingDocumentIds.add(JSON.stringify(document));
            }
            this.scheduleFlush();
        }
    }

    public async flush(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }

        while (this.pendingDocumentIds.size > 0) {
            const documents = [...this.pendingDocumentIds].map((entry) => JSON.parse(entry)) as FullIndexResumeProgressRecord['documents'];
            this.pendingDocumentIds.clear();
            const record = `${JSON.stringify({ documents })}\n`;
            this.writeQueue = this.writeQueue.then(() => fs.appendFile(this.paths.progressPath, record, 'utf8'));
            try {
                await this.writeQueue;
                this.lastFlushAt = Date.now();
            } catch (error) {
                this.writeError = error;
                throw error;
            }
        }
    }

    public async complete(): Promise<void> {
        await this.flush();
        await FullIndexResumeJournal.clear(this.header);
    }

    private scheduleFlush(): void {
        if (this.flushTimer) return;
        const remainingDelay = Math.max(0, CHECKPOINT_INTERVAL_MS - (Date.now() - this.lastFlushAt));
        this.flushTimer = setTimeout(() => {
            this.flush().catch((error) => {
                this.writeError = error;
                console.error(`[INDEX-RESUME] Failed to persist checkpoint for '${this.header.codebasePath}':`, error);
            });
        }, remainingDelay);
        this.flushTimer.unref?.();
    }

    private throwIfWriteFailed(): void {
        if (this.writeError !== undefined) {
            throw new Error(`Indexing resume checkpoint is unavailable: ${this.writeError instanceof Error ? this.writeError.message : String(this.writeError)}`);
        }
    }
}
