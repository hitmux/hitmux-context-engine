import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { MerkleDAG } from './merkle';
import * as os from 'os';
import { normalizeCodebaseIdentityPath } from '../utils/path-identity';
import { IgnoreMatcher } from '../utils/ignore-matcher';
import { configManager } from '../utils/config-manager';
import { countEffectiveLinesInContent } from '../utils/effective-lines';

interface FileSnapshotState {
    hash: string;
    mtimeMs?: number;
    size?: number;
    effectiveLines?: number;
}

interface FileHashScanMetrics {
    directoriesRead: number;
    filesVisited: number;
    filesHashed: number;
    hashesReused: number;
    statErrors: number;
    hashErrors: number;
}

export interface FileSynchronizerOptions {
    maxDepth?: number;
    maxSnapshotBytes?: number;
    snapshotBaseDir?: string;
}

export interface CheckForChangesOptions {
    deferSnapshotUpdate?: boolean;
}

export interface CheckChangedPathsOptions {
    deferSnapshotUpdate?: boolean;
}

export class SnapshotTooLargeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SnapshotTooLargeError';
    }
}

export class FileSynchronizer {
    private fileHashes: Map<string, string>;
    private fileStates: Map<string, FileSnapshotState>;
    private pendingFileStates: Map<string, FileSnapshotState> = new Map();
    private merkleDAG: MerkleDAG;
    private rootDir: string;
    private snapshotPath: string;
    private ignoreMatcher: IgnoreMatcher;
    private supportedExtensions: string[];
    private maxDepth?: number;
    private maxSnapshotBytes?: number;
    private snapshotBaseDir?: string;
    private pendingSnapshotUpdate: {
        fileHashes: Map<string, string>;
        fileStates: Map<string, FileSnapshotState>;
        merkleDAG: MerkleDAG;
    } | null = null;
    private currentScanMetrics: FileHashScanMetrics | null = null;
    private lastScanMetrics: FileHashScanMetrics | null = null;
    private static readonly DEFAULT_MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;

    constructor(rootDir: string, ignorePatterns: string[] = [], supportedExtensions: string[] = [], options: FileSynchronizerOptions = {}) {
        this.rootDir = rootDir;
        this.snapshotBaseDir = options.snapshotBaseDir;
        this.snapshotPath = this.getSnapshotPath(rootDir);
        this.fileHashes = new Map();
        this.fileStates = new Map();
        this.merkleDAG = new MerkleDAG();
        this.ignoreMatcher = new IgnoreMatcher(ignorePatterns);
        this.supportedExtensions = this.normalizeExtensions(supportedExtensions);
        this.maxDepth = this.normalizeMaxDepth(options.maxDepth);
        this.maxSnapshotBytes = this.normalizePositiveInteger(options.maxSnapshotBytes);
    }

    private getSnapshotPath(codebasePath: string): string {
        const merkleDir = this.snapshotBaseDir || path.join(this.getHomeDir(), '.hitmux-context-engine', 'merkle');

        const normalizedPath = normalizeCodebaseIdentityPath(codebasePath);
        const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');

        return path.join(merkleDir, `${hash}.json`);
    }

    private async readFileSnapshotState(filePath: string, stat: { mtimeMs: number; size: number }): Promise<FileSnapshotState> {
        // Double-check that this is actually a file, not a directory
        const currentStat = await fs.stat(filePath);
        if (currentStat.isDirectory()) {
            throw new Error(`Attempted to hash a directory: ${filePath}`);
        }
        const content = await fs.readFile(filePath, 'utf-8');
        return {
            hash: crypto.createHash('sha256').update(content).digest('hex'),
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            effectiveLines: countEffectiveLinesInContent(content)
        };
    }

    private async generateFileHashes(dir: string, depth: number = 0): Promise<Map<string, string>> {
        if (depth === 0) {
            const metrics: FileHashScanMetrics = {
                directoriesRead: 0,
                filesVisited: 0,
                filesHashed: 0,
                hashesReused: 0,
                statErrors: 0,
                hashErrors: 0
            };
            this.currentScanMetrics = metrics;
            try {
                return await this.generateFileHashesInDirectory(dir, depth);
            } finally {
                this.lastScanMetrics = metrics;
                this.currentScanMetrics = null;
            }
        }

        return this.generateFileHashesInDirectory(dir, depth);
    }

    private async generateFileHashesInDirectory(dir: string, depth: number = 0): Promise<Map<string, string>> {
        const fileHashes = new Map<string, string>();
        const fileStates = depth === 0 ? new Map<string, FileSnapshotState>() : this.pendingFileStates;
        if (depth === 0) {
            this.pendingFileStates = fileStates;
        }

        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error: any) {
            console.warn(`[Synchronizer] Cannot read directory ${dir}: ${error.message}`);
            return fileHashes;
        }
        this.currentScanMetrics!.directoriesRead += 1;

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(this.rootDir, fullPath);

            // Check if this path should be ignored BEFORE any file system operations
            if (this.shouldIgnore(relativePath, entry.isDirectory())) {
                continue; // Skip completely - no access at all
            }

            // Double-check with fs.stat to be absolutely sure about file type
            let stat;
            try {
                stat = await fs.stat(fullPath);
            } catch (error: any) {
                console.warn(`[Synchronizer] Cannot stat ${fullPath}: ${error.message}`);
                this.currentScanMetrics!.statErrors += 1;
                continue;
            }

            if (stat.isDirectory()) {
                // Verify it's really a directory and not ignored
                if (!this.shouldIgnore(relativePath, true) && this.shouldTraverseDirectory(depth)) {
                    const subHashes = await this.generateFileHashes(fullPath, depth + 1);
                    const entries = Array.from(subHashes.entries());
                    for (let i = 0; i < entries.length; i++) {
                        const [p, h] = entries[i];
                        fileHashes.set(p, h);
                    }
                }
            } else if (stat.isFile()) {
                // Verify it's really a file and not ignored
                if (!this.shouldIgnore(relativePath, false)) {
                    const ext = path.extname(entry.name);
                    if (this.supportedExtensions.length > 0 && !this.supportedExtensions.includes(ext)) {
                        continue;
                    }
                    this.currentScanMetrics!.filesVisited += 1;
                    try {
                        const previousState = this.fileStates.get(relativePath);
                        const canReuseHash = previousState &&
                            previousState.mtimeMs === stat.mtimeMs &&
                            previousState.size === stat.size &&
                            previousState.effectiveLines !== undefined;
                        const fileState = canReuseHash
                            ? previousState
                            : await this.readFileSnapshotState(fullPath, stat);
                        if (canReuseHash) {
                            this.currentScanMetrics!.hashesReused += 1;
                        } else {
                            this.currentScanMetrics!.filesHashed += 1;
                        }
                        fileHashes.set(relativePath, fileState.hash);
                        fileStates.set(relativePath, fileState);
                    } catch (error: any) {
                        console.warn(`[Synchronizer] Cannot hash file ${fullPath}: ${error.message}`);
                        this.currentScanMetrics!.hashErrors += 1;
                        continue;
                    }
                }
            }
            // Skip other types (symlinks, etc.)
        }
        return fileHashes;
    }

    private shouldTraverseDirectory(depth: number): boolean {
        return this.maxDepth === undefined || depth < this.maxDepth;
    }

    private normalizeMaxDepth(maxDepth?: number): number | undefined {
        if (maxDepth === undefined || maxDepth === null) {
            return undefined;
        }
        if (!Number.isFinite(maxDepth) || maxDepth < 0) {
            return undefined;
        }
        return Math.floor(maxDepth);
    }

    private normalizeExtensions(extensions: string[]): string[] {
        return extensions
            .map(ext => ext.trim())
            .map(ext => this.normalizeExtension(ext))
            .filter((ext): ext is string => ext !== null);
    }

    private normalizeExtension(ext: string): string | null {
        if (ext.length === 0) {
            return '';
        }

        const extensionlessAliases = new Set([
            '<extensionless>',
            'extensionless',
            '<no-extension>',
            'no-extension',
            'no_extension',
            '<none>',
            'none'
        ]);

        if (extensionlessAliases.has(ext.toLowerCase())) {
            return '';
        }

        return ext.startsWith('.') ? ext : `.${ext}`;
    }

    private shouldIgnore(relativePath: string, isDirectory: boolean): boolean {
        return this.ignoreMatcher.shouldIgnore(relativePath, isDirectory);
    }

    private buildMerkleDAG(fileHashes: Map<string, string>): MerkleDAG {
        const dag = new MerkleDAG();
        const keys = Array.from(fileHashes.keys());
        const sortedPaths = keys.slice().sort(); // Create a sorted copy

        // Create a root node for the entire directory
        let valuesString = "";
        sortedPaths.forEach(key => {
            valuesString += fileHashes.get(key);
        });
        const rootNodeData = "root:" + valuesString;
        const rootNodeId = dag.addNode(rootNodeData);

        // Add each file as a child of the root
        for (const path of sortedPaths) {
            const fileData = path + ":" + fileHashes.get(path);
            dag.addNode(fileData, rootNodeId);
        }

        return dag;
    }

    public async initialize() {
        console.log(`Initializing file synchronizer for ${this.rootDir}`);
        await this.loadSnapshot();
        this.merkleDAG = this.buildMerkleDAG(this.fileHashes);
        console.log(`[Synchronizer] File synchronizer initialized. Loaded ${this.fileHashes.size} file hashes.`);
    }

    public async checkForChanges(options: CheckForChangesOptions = {}): Promise<{ added: string[], removed: string[], modified: string[] }> {
        console.log('[Synchronizer] Checking for file changes...');

        const scanStartMs = Date.now();
        const newFileHashes = await this.generateFileHashes(this.rootDir);
        const scanElapsedMs = Date.now() - scanStartMs;
        const metrics = this.lastScanMetrics;
        if (metrics) {
            console.log(
                `[Synchronizer] Full scan/hash completed in ${scanElapsedMs}ms. ` +
                `Directories: ${metrics.directoriesRead}, files: ${metrics.filesVisited}, ` +
                `hashed: ${metrics.filesHashed}, reused: ${metrics.hashesReused}, ` +
                `statErrors: ${metrics.statErrors}, hashErrors: ${metrics.hashErrors}.`
            );
        }
        const compareStartMs = Date.now();
        const newFileStates = this.pendingFileStates;
        const newMerkleDAG = this.buildMerkleDAG(newFileHashes);
        const metadataChanged = !this.fileStatesEqual(this.fileStates, newFileStates);

        // Compare the DAGs
        const changes = MerkleDAG.compare(this.merkleDAG, newMerkleDAG);
        const compareElapsedMs = Date.now() - compareStartMs;
        console.log(`[Synchronizer] Full scan comparison completed in ${compareElapsedMs}ms.`);

        // If there are any changes in the DAG, do a file-level comparison
        if (changes.added.length > 0 || changes.removed.length > 0) {
            console.log('[Synchronizer] Merkle DAG has changed. Comparing file states...');
            const fileChanges = this.compareStates(this.fileHashes, newFileHashes);

            if (options.deferSnapshotUpdate) {
                this.pendingSnapshotUpdate = {
                    fileHashes: newFileHashes,
                    fileStates: newFileStates,
                    merkleDAG: newMerkleDAG
                };
                console.log(`[Synchronizer] Found changes: ${fileChanges.added.length} added, ${fileChanges.removed.length} removed, ${fileChanges.modified.length} modified. Snapshot update deferred.`);
                return fileChanges;
            }

            this.fileHashes = newFileHashes;
            this.fileStates = newFileStates;
            this.merkleDAG = newMerkleDAG;
            await this.saveSnapshot();

            console.log(`[Synchronizer] Found changes: ${fileChanges.added.length} added, ${fileChanges.removed.length} removed, ${fileChanges.modified.length} modified.`);
            return fileChanges;
        }

        if (metadataChanged) {
            this.fileStates = newFileStates;
            await this.saveSnapshot();
            console.log('[Synchronizer] File metadata changed without content changes. Snapshot metadata updated.');
        }

        console.log('[Synchronizer] No changes detected based on Merkle DAG comparison.');
        return { added: [], removed: [], modified: [] };
    }

    public async checkChangedPaths(relativePaths: string[], options: CheckChangedPathsOptions = {}): Promise<{ added: string[], removed: string[], modified: string[] }> {
        const normalizedPaths = this.normalizeChangedPaths(relativePaths);
        console.log(`[Synchronizer] Checking ${normalizedPaths.length} targeted path changes...`);

        const nextFileHashes = new Map(this.fileHashes);
        const nextFileStates = new Map(this.fileStates);
        const added: string[] = [];
        const removed: string[] = [];
        const modified: string[] = [];

        for (const relativePath of normalizedPaths) {
            const oldHash = this.fileHashes.get(relativePath);
            const nextState = await this.readCurrentPathState(relativePath);

            if (!nextState) {
                if (oldHash !== undefined) {
                    nextFileHashes.delete(relativePath);
                    nextFileStates.delete(relativePath);
                    removed.push(relativePath);
                }
                continue;
            }

            nextFileHashes.set(relativePath, nextState.hash);
            nextFileStates.set(relativePath, nextState);

            if (oldHash === undefined) {
                added.push(relativePath);
            } else if (oldHash !== nextState.hash) {
                modified.push(relativePath);
            } else {
                const oldState = this.fileStates.get(relativePath);
                if (!this.snapshotStateEqual(oldState, nextState)) {
                    nextFileStates.set(relativePath, nextState);
                }
            }
        }

        const nextMerkleDAG = this.buildMerkleDAG(nextFileHashes);
        const hasChanges = added.length > 0 || removed.length > 0 || modified.length > 0;
        const metadataChanged = !this.fileStatesEqual(this.fileStates, nextFileStates);

        if (options.deferSnapshotUpdate) {
            if (hasChanges || metadataChanged) {
                this.pendingSnapshotUpdate = {
                    fileHashes: nextFileHashes,
                    fileStates: nextFileStates,
                    merkleDAG: nextMerkleDAG
                };
            }
            console.log(`[Synchronizer] Targeted changes: ${added.length} added, ${removed.length} removed, ${modified.length} modified. Snapshot update ${hasChanges || metadataChanged ? 'deferred' : 'not needed'}.`);
            return { added, removed, modified };
        }

        if (hasChanges || metadataChanged) {
            this.fileHashes = nextFileHashes;
            this.fileStates = nextFileStates;
            this.merkleDAG = nextMerkleDAG;
            await this.saveSnapshot();
        }

        console.log(`[Synchronizer] Targeted changes: ${added.length} added, ${removed.length} removed, ${modified.length} modified.`);
        return { added, removed, modified };
    }

    public async commitPendingChanges(): Promise<void> {
        if (!this.pendingSnapshotUpdate) {
            return;
        }

        this.fileHashes = this.pendingSnapshotUpdate.fileHashes;
        this.fileStates = this.pendingSnapshotUpdate.fileStates;
        this.merkleDAG = this.pendingSnapshotUpdate.merkleDAG;
        this.pendingSnapshotUpdate = null;
        await this.saveSnapshot();
    }

    public discardPendingChanges(): void {
        this.pendingSnapshotUpdate = null;
    }

    public getPendingEffectiveLineIncrease(added: string[], modified: string[]): { effectiveLines: number; changedFiles: number } {
        const newStates = this.pendingSnapshotUpdate?.fileStates || this.fileStates;
        let effectiveLines = 0;
        let changedFiles = 0;

        for (const file of added) {
            const lines = newStates.get(file)?.effectiveLines || 0;
            if (lines > 0) {
                effectiveLines += lines;
                changedFiles++;
            }
        }

        for (const file of modified) {
            const oldLines = this.fileStates.get(file)?.effectiveLines;
            const newLines = newStates.get(file)?.effectiveLines;
            if (oldLines === undefined || newLines === undefined) {
                continue;
            }

            const increase = Math.max(newLines - oldLines, 0);
            if (increase > 0) {
                effectiveLines += increase;
                changedFiles++;
            }
        }

        return { effectiveLines, changedFiles };
    }

    private fileStatesEqual(a: Map<string, FileSnapshotState>, b: Map<string, FileSnapshotState>): boolean {
        if (a.size !== b.size) {
            return false;
        }

        for (const [file, state] of a) {
            const other = b.get(file);
            if (!other ||
                other.hash !== state.hash ||
                other.mtimeMs !== state.mtimeMs ||
                other.size !== state.size ||
                other.effectiveLines !== state.effectiveLines) {
                return false;
            }
        }

        return true;
    }

    private compareStates(oldHashes: Map<string, string>, newHashes: Map<string, string>): { added: string[], removed: string[], modified: string[] } {
        const added: string[] = [];
        const removed: string[] = [];
        const modified: string[] = [];

        const newEntries = Array.from(newHashes.entries());
        for (let i = 0; i < newEntries.length; i++) {
            const [file, hash] = newEntries[i];
            if (!oldHashes.has(file)) {
                added.push(file);
            } else if (oldHashes.get(file) !== hash) {
                modified.push(file);
            }
        }

        const oldKeys = Array.from(oldHashes.keys());
        for (let i = 0; i < oldKeys.length; i++) {
            const file = oldKeys[i];
            if (!newHashes.has(file)) {
                removed.push(file);
            }
        }

        return { added, removed, modified };
    }

    private normalizeChangedPaths(relativePaths: string[]): string[] {
        const normalized: string[] = [];
        const seen = new Set<string>();

        for (const relativePath of relativePaths) {
            const normalizedPath = relativePath
                .replace(/\\/g, '/')
                .replace(/^\/+/, '')
                .split('/')
                .filter(segment => segment.length > 0 && segment !== '.')
                .join('/');

            if (
                normalizedPath.length === 0 ||
                normalizedPath.startsWith('../') ||
                normalizedPath.includes('/../') ||
                seen.has(normalizedPath)
            ) {
                continue;
            }

            seen.add(normalizedPath);
            normalized.push(normalizedPath);
        }

        return normalized;
    }

    private async readCurrentPathState(relativePath: string): Promise<FileSnapshotState | null> {
        if (this.isBeyondMaxDepth(relativePath) || this.shouldIgnore(relativePath, false)) {
            return null;
        }

        const fullPath = path.join(this.rootDir, relativePath);
        const resolvedRoot = path.resolve(this.rootDir);
        const resolvedPath = path.resolve(fullPath);
        if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
            return null;
        }

        let stat;
        try {
            stat = await fs.stat(fullPath);
        } catch (error: any) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
                return null;
            }
            throw error;
        }

        if (!stat.isFile()) {
            return null;
        }

        if (this.shouldIgnore(relativePath, false)) {
            return null;
        }

        const ext = path.extname(relativePath);
        if (this.supportedExtensions.length > 0 && !this.supportedExtensions.includes(ext)) {
            return null;
        }

        return this.readFileSnapshotState(fullPath, stat);
    }

    private isBeyondMaxDepth(relativePath: string): boolean {
        if (this.maxDepth === undefined) {
            return false;
        }

        const directoryDepth = relativePath.split('/').length - 1;
        return directoryDepth > this.maxDepth;
    }

    private snapshotStateEqual(a: FileSnapshotState | undefined, b: FileSnapshotState | undefined): boolean {
        return !!a && !!b &&
            a.hash === b.hash &&
            a.mtimeMs === b.mtimeMs &&
            a.size === b.size &&
            a.effectiveLines === b.effectiveLines;
    }

    public getFileHash(filePath: string): string | undefined {
        return this.fileHashes.get(filePath);
    }

    private async saveSnapshot(): Promise<void> {
        const merkleDir = path.dirname(this.snapshotPath);
        await fs.mkdir(merkleDir, { recursive: true });

        // Convert Map to array without using iterator
        const fileHashesArray: [string, string][] = [];
        const keys = Array.from(this.fileHashes.keys());
        keys.forEach(key => {
            fileHashesArray.push([key, this.fileHashes.get(key)!]);
        });
        const fileStatesArray = Array.from(this.fileStates.entries());

        this.assertSnapshotSizeWithinLimit(fileHashesArray);

        const data = JSON.stringify({
            fileHashes: fileHashesArray,
            fileStates: fileStatesArray,
            merkleDAG: this.merkleDAG.serialize()
        });
        await fs.writeFile(this.snapshotPath, data, 'utf-8');
        console.log(`Saved snapshot to ${this.snapshotPath}`);
    }

    private assertSnapshotSizeWithinLimit(fileHashesArray: [string, string][]): void {
        const maxBytes = this.getMaxSnapshotBytes();
        const estimatedBytes = this.estimateSnapshotBytes(fileHashesArray);

        if (estimatedBytes > maxBytes) {
            throw new SnapshotTooLargeError(
                `Merkle snapshot for '${this.rootDir}' is too large to write safely: estimated ${estimatedBytes} bytes exceeds limit ${maxBytes} bytes. ` +
                'Increase merkleSnapshotMaxBytes in ~/.hitmux-context-engine/config.conf or reduce indexed files with ignore patterns.'
            );
        }
    }

    private getMaxSnapshotBytes(): number {
        if (this.maxSnapshotBytes !== undefined) {
            return this.maxSnapshotBytes;
        }

        const configured = configManager.getNumber('merkleSnapshotMaxBytes');
        if (Number.isFinite(configured) && configured! > 0) {
            return configured!;
        }
        return FileSynchronizer.DEFAULT_MAX_SNAPSHOT_BYTES;
    }

    private normalizePositiveInteger(value: number | undefined): number | undefined {
        if (Number.isFinite(value) && value! > 0) {
            return Math.floor(value!);
        }

        return undefined;
    }

    private getHomeDir(): string {
        return os.homedir();
    }

    private estimateSnapshotBytes(fileHashesArray: [string, string][]): number {
        let bytes = 64;

        for (const [filePath, hash] of fileHashesArray) {
            bytes += Buffer.byteLength(filePath, 'utf-8') + Buffer.byteLength(hash, 'utf-8') + 12;
        }

        for (const node of this.merkleDAG.getAllNodes()) {
            bytes += Buffer.byteLength(node.id, 'utf-8') * 2;
            bytes += Buffer.byteLength(node.data, 'utf-8');
            bytes += node.parents.length * 72;
            bytes += node.children.length * 72;
            bytes += 64;
        }

        return bytes;
    }

    private async loadSnapshot(): Promise<void> {
        try {
            const data = await fs.readFile(this.snapshotPath, 'utf-8');
            const obj = JSON.parse(data);

            // Reconstruct Map without using constructor with iterator
            this.fileHashes = new Map();
            for (const [key, value] of obj.fileHashes) {
                this.fileHashes.set(key, value);
            }
            this.fileStates = new Map();
            if (Array.isArray(obj.fileStates)) {
                for (const [key, value] of obj.fileStates) {
                    this.fileStates.set(key, value);
                }
            } else {
                for (const [key, value] of obj.fileHashes) {
                    this.fileStates.set(key, { hash: value });
                }
            }

            if (obj.merkleDAG) {
                this.merkleDAG = MerkleDAG.deserialize(obj.merkleDAG);
            }
            console.log(`Loaded snapshot from ${this.snapshotPath}`);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                console.log(`Snapshot file not found at ${this.snapshotPath}. Generating new one.`);
                this.fileHashes = await this.generateFileHashes(this.rootDir);
                this.fileStates = this.pendingFileStates;
                this.merkleDAG = this.buildMerkleDAG(this.fileHashes);
                await this.saveSnapshot();
            } else {
                throw error;
            }
        }
    }

    /**
     * Delete snapshot file for a given codebase path
     */
    static async deleteSnapshot(codebasePath: string): Promise<void> {
        const homeDir = os.homedir();
        const merkleDir = path.join(homeDir, '.hitmux-context-engine', 'merkle');
        const normalizedPath = normalizeCodebaseIdentityPath(codebasePath);
        const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
        const snapshotPath = path.join(merkleDir, `${hash}.json`);

        try {
            await fs.unlink(snapshotPath);
            console.log(`Deleted snapshot file: ${snapshotPath}`);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                console.log(`Snapshot file not found (already deleted): ${snapshotPath}`);
            } else {
                console.error(`[Synchronizer] Failed to delete snapshot file ${snapshotPath}:`, error.message);
                throw error; // Re-throw non-ENOENT errors
            }
        }
    }
}
