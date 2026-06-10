import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { MerkleDAG } from './merkle';
import * as os from 'os';
import { normalizeCodebaseIdentityPath } from '../utils/path-identity';
import { IgnoreMatcher } from '../utils/ignore-matcher';
import { configManager } from '../utils/config-manager';

interface FileSnapshotState {
    hash: string;
    mtimeMs?: number;
    size?: number;
}

export interface FileSynchronizerOptions {
    maxDepth?: number;
    maxSnapshotBytes?: number;
    snapshotBaseDir?: string;
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
    private static readonly DEFAULT_MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;

    constructor(rootDir: string, ignorePatterns: string[] = [], supportedExtensions: string[] = [], options: FileSynchronizerOptions = {}) {
        this.rootDir = rootDir;
        this.snapshotPath = this.getSnapshotPath(rootDir);
        this.fileHashes = new Map();
        this.fileStates = new Map();
        this.merkleDAG = new MerkleDAG();
        this.ignoreMatcher = new IgnoreMatcher(ignorePatterns);
        this.supportedExtensions = this.normalizeExtensions(supportedExtensions);
        this.maxDepth = this.normalizeMaxDepth(options.maxDepth);
        this.maxSnapshotBytes = this.normalizePositiveInteger(options.maxSnapshotBytes);
        this.snapshotBaseDir = options.snapshotBaseDir;
    }

    private getSnapshotPath(codebasePath: string): string {
        const merkleDir = this.snapshotBaseDir || path.join(this.getHomeDir(), '.hitmux-context-engine', 'merkle');

        const normalizedPath = normalizeCodebaseIdentityPath(codebasePath);
        const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');

        return path.join(merkleDir, `${hash}.json`);
    }

    private async hashFile(filePath: string): Promise<string> {
        // Double-check that this is actually a file, not a directory
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
            throw new Error(`Attempted to hash a directory: ${filePath}`);
        }
        const content = await fs.readFile(filePath, 'utf-8');
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    private async generateFileHashes(dir: string, depth: number = 0): Promise<Map<string, string>> {
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
                    try {
                        const previousState = this.fileStates.get(relativePath);
                        const canReuseHash = previousState &&
                            previousState.mtimeMs === stat.mtimeMs &&
                            previousState.size === stat.size;
                        const hash = canReuseHash ? previousState.hash : await this.hashFile(fullPath);
                        fileHashes.set(relativePath, hash);
                        fileStates.set(relativePath, {
                            hash,
                            mtimeMs: stat.mtimeMs,
                            size: stat.size
                        });
                    } catch (error: any) {
                        console.warn(`[Synchronizer] Cannot hash file ${fullPath}: ${error.message}`);
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

    public async checkForChanges(): Promise<{ added: string[], removed: string[], modified: string[] }> {
        console.log('[Synchronizer] Checking for file changes...');

        const newFileHashes = await this.generateFileHashes(this.rootDir);
        const newFileStates = this.pendingFileStates;
        const newMerkleDAG = this.buildMerkleDAG(newFileHashes);
        const metadataChanged = !this.fileStatesEqual(this.fileStates, newFileStates);

        // Compare the DAGs
        const changes = MerkleDAG.compare(this.merkleDAG, newMerkleDAG);

        // If there are any changes in the DAG, do a file-level comparison
        if (changes.added.length > 0 || changes.removed.length > 0) {
            console.log('[Synchronizer] Merkle DAG has changed. Comparing file states...');
            const fileChanges = this.compareStates(this.fileHashes, newFileHashes);

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

    private fileStatesEqual(a: Map<string, FileSnapshotState>, b: Map<string, FileSnapshotState>): boolean {
        if (a.size !== b.size) {
            return false;
        }

        for (const [file, state] of a) {
            const other = b.get(file);
            if (!other ||
                other.hash !== state.hash ||
                other.mtimeMs !== state.mtimeMs ||
                other.size !== state.size) {
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
                'Increase merkleSnapshotMaxBytes in ~/.hitmux-context-engine/config.jsonc or reduce indexed files with ignore patterns.'
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
