import * as crypto from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'readline';

const RESUME_JOURNAL_VERSION = 2;
const LEGACY_RESUME_JOURNAL_VERSION = 1;
const CHECKPOINT_INTERVAL_MS = 2_000;

type CheckpointMode = 'document' | 'file';
type FileCheckpointState = 'partial' | 'complete';

export interface FullIndexResumeJournalInput {
    codebasePath: string;
    collectionName: string;
    runSignature: string;
}

interface FullIndexResumeHeaderBase extends FullIndexResumeJournalInput {
    startedAt: string;
}

interface LegacyFullIndexResumeHeader extends FullIndexResumeHeaderBase {
    version: typeof LEGACY_RESUME_JOURNAL_VERSION;
}

interface FullIndexResumeHeader extends FullIndexResumeHeaderBase {
    version: typeof RESUME_JOURNAL_VERSION;
    checkpointMode: CheckpointMode;
}

interface FullIndexResumeDocumentCheckpoint {
    id: string;
    relativePath: string;
    fileHash: string;
}

interface FullIndexResumeDocumentProgressRecord {
    documents: FullIndexResumeDocumentCheckpoint[];
}

interface FullIndexResumeFileProgressRecord {
    relativePath: string;
    fileHash: string;
    state: FileCheckpointState;
}

interface LoadedResumeProgress {
    committedDocumentIds: Set<string>;
    committedFileHashes: Map<string, string>;
    committedFilePaths: Set<string>;
    fileCheckpointStates: Map<string, FileCheckpointState>;
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

function isValidHeaderBase(value: unknown): value is FullIndexResumeHeaderBase {
    if (!value || typeof value !== 'object') return false;
    const header = value as Partial<FullIndexResumeHeaderBase>;
    return typeof header.codebasePath === 'string'
        && typeof header.collectionName === 'string'
        && typeof header.runSignature === 'string'
        && typeof header.startedAt === 'string';
}

function isLegacyHeader(value: unknown): value is LegacyFullIndexResumeHeader {
    return isValidHeaderBase(value)
        && (value as Partial<LegacyFullIndexResumeHeader>).version === LEGACY_RESUME_JOURNAL_VERSION;
}

function isValidHeader(value: unknown): value is FullIndexResumeHeader {
    if (!isValidHeaderBase(value)) return false;
    const header = value as Partial<FullIndexResumeHeader>;
    return header.version === RESUME_JOURNAL_VERSION
        && (header.checkpointMode === 'document' || header.checkpointMode === 'file');
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
 * only records recovery fingerprints. New journals checkpoint at file level;
 * v1 journals are compacted to v2 document checkpoints so their exact resume
 * semantics remain intact.
 */
export class FullIndexResumeJournal {
    private readonly committedDocumentIds: Set<string>;
    private readonly pendingRecords = new Set<string>();
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
        private readonly fileCheckpointStates: Map<string, FileCheckpointState>,
    ) {
        this.committedDocumentIds = new Set(committedDocumentIds);
    }

    public static async create(input: FullIndexResumeJournalInput): Promise<FullIndexResumeJournal> {
        const paths = getResumeJournalPaths(input.codebasePath, input.collectionName);
        const header: FullIndexResumeHeader = {
            version: RESUME_JOURNAL_VERSION,
            checkpointMode: 'file',
            ...input,
            startedAt: new Date().toISOString(),
        };
        await fs.mkdir(path.dirname(paths.headerPath), { recursive: true });
        // Remove an old progress stream before publishing its replacement
        // header. A crash in this window replays data safely; it can never
        // attach stale acknowledgements to a new full-index run.
        await fs.rm(paths.progressPath, { force: true });
        await this.writeHeaderAtomically(paths.headerPath, header);
        return new FullIndexResumeJournal(header, paths, [], new Map(), new Set(), new Map());
    }

    public static async load(input: Pick<FullIndexResumeJournalInput, 'codebasePath' | 'collectionName'>): Promise<FullIndexResumeJournal | undefined> {
        const paths = getResumeJournalPaths(input.codebasePath, input.collectionName);
        let parsedHeader: unknown;
        try {
            parsedHeader = JSON.parse(await fs.readFile(paths.headerPath, 'utf8')) as unknown;
        } catch (error: unknown) {
            if (getErrorCode(error) === 'ENOENT') return undefined;
            throw new Error(`Failed to read indexing resume journal for '${input.codebasePath}': ${getErrorMessage(error)}`);
        }

        if ((!isLegacyHeader(parsedHeader) && !isValidHeader(parsedHeader))
            || parsedHeader.codebasePath !== input.codebasePath
            || parsedHeader.collectionName !== input.collectionName) {
            return undefined;
        }

        const header = isLegacyHeader(parsedHeader)
            ? await this.migrateLegacyJournal(parsedHeader, paths)
            : parsedHeader;
        const progress = await this.loadProgress(header, paths);

        return new FullIndexResumeJournal(
            header,
            paths,
            progress.committedDocumentIds,
            progress.committedFileHashes,
            progress.committedFilePaths,
            progress.fileCheckpointStates,
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

    public usesFileCheckpoints(): boolean {
        return this.header.checkpointMode === 'file';
    }

    public assertNoCommittedFileWasRemoved(currentRelativePaths: Iterable<string>): void {
        const currentPaths = new Set(currentRelativePaths);
        for (const relativePath of this.committedFilePaths) {
            if (!currentPaths.has(relativePath)) {
                throw new FullIndexResumeSourceChangedError(this.header.codebasePath);
            }
        }
    }

    /**
     * Returns true only for a v2 file checkpoint that is known complete. The
     * caller has already read the file at this point, so its source hash is
     * still validated before split/embed work is skipped.
     */
    public prepareFile(relativePath: string, content: string, resumeMode: boolean): boolean {
        const fileHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
        const committedHash = this.committedFileHashes.get(relativePath);
        if (resumeMode && committedHash !== undefined && committedHash !== fileHash) {
            throw new FullIndexResumeSourceChangedError(this.header.codebasePath);
        }
        this.committedFileHashes.set(relativePath, fileHash);
        return resumeMode
            && this.usesFileCheckpoints()
            && this.fileCheckpointStates.get(relativePath) === 'complete';
    }

    public isDocumentCommitted(documentId: string, relativePath: string, resumeMode: boolean): boolean {
        return resumeMode
            && this.header.checkpointMode === 'document'
            && this.committedFileHashes.has(relativePath)
            && this.committedDocumentIds.has(documentId);
    }

    /**
     * Records a successful vector write. The method deliberately projects
     * VectorDocument values into recovery fields; runtime vector/content/
     * metadata payloads must never enter the local checkpoint.
     */
    public markCommitted(documents: ReadonlyArray<{ id: string; relativePath: string }>): void {
        this.throwIfWriteFailed();
        if (this.header.checkpointMode === 'document') {
            const pendingDocuments: FullIndexResumeDocumentCheckpoint[] = [];
            for (const document of documents) {
                if (!this.committedDocumentIds.has(document.id)) {
                    const fileHash = this.getPreparedFileHash(document.relativePath);
                    const checkpoint: FullIndexResumeDocumentCheckpoint = {
                        id: document.id,
                        relativePath: document.relativePath,
                        fileHash,
                    };
                    this.committedDocumentIds.add(checkpoint.id);
                    this.committedFilePaths.add(checkpoint.relativePath);
                    pendingDocuments.push(checkpoint);
                }
            }
            if (pendingDocuments.length > 0) {
                this.queueRecord({ documents: pendingDocuments });
            }
            return;
        }

        for (const document of documents) {
            if (this.fileCheckpointStates.get(document.relativePath) === undefined) {
                this.setFileCheckpointState(document.relativePath, 'partial');
            }
        }
    }

    /**
     * Marks a file complete only after every batch containing one of its
     * chunks has acknowledged a successful vector write.
     */
    public markFileComplete(relativePath: string): void {
        this.throwIfWriteFailed();
        if (!this.usesFileCheckpoints()
            || this.fileCheckpointStates.get(relativePath) === 'complete') {
            return;
        }
        this.setFileCheckpointState(relativePath, 'complete');
    }

    public async flush(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }

        while (this.pendingRecords.size > 0) {
            const records = [...this.pendingRecords];
            this.pendingRecords.clear();
            const content = `${records.join('\n')}\n`;
            this.writeQueue = this.writeQueue.then(() => fs.appendFile(this.paths.progressPath, content, 'utf8'));
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

    private getPreparedFileHash(relativePath: string): string {
        const fileHash = this.committedFileHashes.get(relativePath);
        if (!fileHash) {
            throw new Error(`Missing resume fingerprint for '${relativePath}'`);
        }
        return fileHash;
    }

    private setFileCheckpointState(relativePath: string, state: FileCheckpointState): void {
        const fileHash = this.getPreparedFileHash(relativePath);
        this.committedFilePaths.add(relativePath);
        this.fileCheckpointStates.set(relativePath, state);
        const record: FullIndexResumeFileProgressRecord = { relativePath, fileHash, state };
        this.queueRecord(record);
    }

    private queueRecord(record: FullIndexResumeDocumentProgressRecord | FullIndexResumeFileProgressRecord): void {
        this.pendingRecords.add(JSON.stringify(record));
        this.scheduleFlush();
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

    private static async migrateLegacyJournal(
        legacyHeader: LegacyFullIndexResumeHeader,
        paths: { headerPath: string; progressPath: string },
    ): Promise<FullIndexResumeHeader> {
        const header: FullIndexResumeHeader = {
            ...legacyHeader,
            version: RESUME_JOURNAL_VERSION,
            checkpointMode: 'document',
        };
        const tempProgressPath = `${paths.progressPath}.tmp-${process.pid}-${Date.now()}`;
        let handle: fs.FileHandle | undefined;
        const committedFileHashes = new Map<string, string>();

        try {
            await fs.mkdir(path.dirname(paths.progressPath), { recursive: true });
            handle = await fs.open(tempProgressPath, 'w');
            try {
                const input = createReadStream(paths.progressPath, { encoding: 'utf8' });
                const lines = createInterface({ input, crlfDelay: Infinity });
                for await (const line of lines) {
                    try {
                        const documents = this.parseDocumentProgressLine(line, legacyHeader.codebasePath, committedFileHashes);
                        if (documents.length > 0) {
                            const record: FullIndexResumeDocumentProgressRecord = { documents };
                            await handle.write(`${JSON.stringify(record)}\n`, undefined, 'utf8');
                        }
                    } catch (error) {
                        if (error instanceof FullIndexResumeSourceChangedError) {
                            throw error;
                        }
                        // Keep the v1 append semantics: a process can die in
                        // the middle of its final JSONL record.
                    }
                }
            } catch (error: unknown) {
                if (getErrorCode(error) !== 'ENOENT') {
                    throw error;
                }
            }
            await handle.close();
            handle = undefined;
            await fs.rename(tempProgressPath, paths.progressPath);
            await this.writeHeaderAtomically(paths.headerPath, header);
            return header;
        } catch (error) {
            await handle?.close().catch(() => undefined);
            await fs.rm(tempProgressPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    private static async loadProgress(
        header: FullIndexResumeHeader,
        paths: { progressPath: string },
    ): Promise<LoadedResumeProgress> {
        const progress: LoadedResumeProgress = {
            committedDocumentIds: new Set<string>(),
            committedFileHashes: new Map<string, string>(),
            committedFilePaths: new Set<string>(),
            fileCheckpointStates: new Map<string, FileCheckpointState>(),
        };

        try {
            const input = createReadStream(paths.progressPath, { encoding: 'utf8' });
            const lines = createInterface({ input, crlfDelay: Infinity });
            for await (const line of lines) {
                try {
                    if (header.checkpointMode === 'document') {
                        const documents = this.parseDocumentProgressLine(line, header.codebasePath, progress.committedFileHashes);
                        for (const document of documents) {
                            progress.committedDocumentIds.add(document.id);
                            progress.committedFilePaths.add(document.relativePath);
                        }
                    } else {
                        const record = this.parseFileProgressLine(line);
                        if (!record) continue;
                        this.recordFileHash(
                            progress.committedFileHashes,
                            record.relativePath,
                            record.fileHash,
                            header.codebasePath,
                        );
                        progress.committedFilePaths.add(record.relativePath);
                        const currentState = progress.fileCheckpointStates.get(record.relativePath);
                        if (record.state === 'complete' || currentState === undefined) {
                            progress.fileCheckpointStates.set(record.relativePath, record.state);
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
                throw new Error(`Failed to read indexing resume progress for '${header.codebasePath}': ${getErrorMessage(error)}`);
            }
        }

        return progress;
    }

    private static parseDocumentProgressLine(
        line: string,
        codebasePath: string,
        committedFileHashes: Map<string, string>,
    ): FullIndexResumeDocumentCheckpoint[] {
        if (!line.trim()) return [];
        const record = JSON.parse(line) as Partial<FullIndexResumeDocumentProgressRecord>;
        if (!Array.isArray(record.documents)) return [];

        const documents: FullIndexResumeDocumentCheckpoint[] = [];
        for (const document of record.documents) {
            if (typeof document?.id !== 'string'
                || typeof document.relativePath !== 'string'
                || typeof document.fileHash !== 'string') {
                continue;
            }
            this.recordFileHash(committedFileHashes, document.relativePath, document.fileHash, codebasePath);
            documents.push({
                id: document.id,
                relativePath: document.relativePath,
                fileHash: document.fileHash,
            });
        }
        return documents;
    }

    private static parseFileProgressLine(line: string): FullIndexResumeFileProgressRecord | undefined {
        if (!line.trim()) return undefined;
        const record = JSON.parse(line) as Partial<FullIndexResumeFileProgressRecord>;
        if (typeof record.relativePath !== 'string'
            || typeof record.fileHash !== 'string'
            || (record.state !== 'partial' && record.state !== 'complete')) {
            return undefined;
        }
        return {
            relativePath: record.relativePath,
            fileHash: record.fileHash,
            state: record.state,
        };
    }

    private static recordFileHash(
        committedFileHashes: Map<string, string>,
        relativePath: string,
        fileHash: string,
        codebasePath: string,
    ): void {
        const previousHash = committedFileHashes.get(relativePath);
        if (previousHash && previousHash !== fileHash) {
            throw new FullIndexResumeSourceChangedError(codebasePath);
        }
        committedFileHashes.set(relativePath, fileHash);
    }

    private static async writeHeaderAtomically(
        headerPath: string,
        header: FullIndexResumeHeader,
    ): Promise<void> {
        const tempPath = `${headerPath}.tmp-${process.pid}-${Date.now()}`;
        try {
            await fs.writeFile(tempPath, JSON.stringify(header), 'utf8');
            await fs.rename(tempPath, headerPath);
        } catch (error) {
            await fs.rm(tempPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }
}
