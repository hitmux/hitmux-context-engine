import * as fs from "fs";
import * as path from "path";
import chokidar, { type FSWatcher } from "chokidar";

export type ProjectChangeState =
    | { kind: "clean"; version: number }
    | { kind: "dirty"; paths: string[]; version: number }
    | { kind: "unknown"; reason: string; version: number };

export interface ProjectChangeTrackerOptions {
    debounceMs: number;
    usePolling: boolean;
}

interface UnknownReason {
    reason: string;
    version: number;
}

interface PendingProjectEvents {
    files: string[];
    directories: Array<{ eventPath: string; reason: string }>;
}

const WATCHER_IGNORED_DIRS = new Set([
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".idea",
    ".vscode",
]);

export class ProjectChangeTracker {
    private watchers: Map<string, FSWatcher> = new Map();
    private dirtyPaths: Map<string, Map<string, number>> = new Map();
    private unknownReasons: Map<string, UnknownReason> = new Map();
    private versions: Map<string, number> = new Map();
    private requestIgnoreFiles: Map<string, Set<string>> = new Map();
    private pendingEvents: Map<string, PendingProjectEvents> = new Map();
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private readonly options: ProjectChangeTrackerOptions;

    constructor(options: ProjectChangeTrackerOptions) {
        this.options = options;
    }

    public watch(codebasePath: string, ignoreFiles: string[] = []): void {
        this.updateIgnoreFiles(codebasePath, ignoreFiles);
        if (this.watchers.has(codebasePath) || this.unknownReasons.has(codebasePath)) {
            return;
        }

        if (!fs.existsSync(codebasePath)) {
            this.markUnknown(codebasePath, "codebase path does not exist");
            return;
        }

        try {
            const watcher = chokidar.watch(codebasePath, {
                ignored: (candidatePath: string) => this.isWatcherIgnored(codebasePath, candidatePath),
                ignoreInitial: true,
                persistent: false,
                usePolling: this.options.usePolling,
            });

            watcher
                .on("add", (filePath) => this.queueFileEvent(codebasePath, filePath))
                .on("change", (filePath) => this.queueFileEvent(codebasePath, filePath))
                .on("unlink", (filePath) => this.queueFileEvent(codebasePath, filePath))
                .on("addDir", (dirPath) => this.queueDirectoryEvent(codebasePath, dirPath, "directory added"))
                .on("unlinkDir", (dirPath) => this.queueDirectoryEvent(codebasePath, dirPath, "directory removed"))
                .on("raw", (eventName) => {
                    if (String(eventName).toLowerCase().includes("overflow")) {
                        this.markUnknown(codebasePath, `watcher overflow: ${String(eventName)}`);
                    }
                })
                .on("error", (error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    this.markUnknown(codebasePath, `watcher error: ${message}`);
                });

            this.watchers.set(codebasePath, watcher);
            if (!this.dirtyPaths.has(codebasePath)) {
                this.dirtyPaths.set(codebasePath, new Map());
            }
            if (!this.versions.has(codebasePath)) {
                this.versions.set(codebasePath, 0);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.markUnknown(codebasePath, `watcher setup failed: ${message}`);
        }
    }

    public getState(codebasePath: string): ProjectChangeState {
        const version = this.getVersion(codebasePath);
        const unknownReason = this.unknownReasons.get(codebasePath);
        if (unknownReason) {
            return { kind: "unknown", reason: unknownReason.reason, version };
        }

        const paths = this.dirtyPaths.get(codebasePath);
        if (paths && paths.size > 0) {
            return { kind: "dirty", paths: Array.from(paths.keys()).sort(), version };
        }

        return { kind: "clean", version };
    }

    public markClean(codebasePath: string, observedVersion?: number): void {
        this.deleteUnknownSeenAtOrBefore(codebasePath, observedVersion);
        if (observedVersion === undefined) {
            this.dirtyPaths.set(codebasePath, new Map());
        } else {
            this.deletePathsSeenAtOrBefore(codebasePath, undefined, observedVersion);
        }
        if (!this.watchers.has(codebasePath)) {
            this.watch(codebasePath, Array.from(this.requestIgnoreFiles.get(codebasePath) ?? []));
        }
    }

    public markPathsClean(codebasePath: string, relativePaths: string[], observedVersion?: number): void {
        this.deletePathsSeenAtOrBefore(codebasePath, relativePaths, observedVersion);
    }

    private deletePathsSeenAtOrBefore(codebasePath: string, relativePaths: string[] | undefined, observedVersion: number | undefined): void {
        const paths = this.dirtyPaths.get(codebasePath);
        if (!paths) {
            return;
        }

        const candidates = relativePaths ?? Array.from(paths.keys());
        for (const relativePath of candidates) {
            const pathVersion = paths.get(relativePath);
            if (observedVersion === undefined || (pathVersion !== undefined && pathVersion <= observedVersion)) {
                paths.delete(relativePath);
            }
        }
    }

    public markUnknown(codebasePath: string, reason: string, options: { closeWatcher?: boolean } = {}): void {
        this.clearPendingEvents(codebasePath);
        const version = this.bumpVersion(codebasePath);
        this.unknownReasons.set(codebasePath, { reason, version });
        this.dirtyPaths.delete(codebasePath);
        if (options.closeWatcher === false) {
            return;
        }
        const watcher = this.watchers.get(codebasePath);
        if (watcher) {
            this.watchers.delete(codebasePath);
            void watcher.close().catch(() => undefined);
        }
    }

    public async close(): Promise<void> {
        const watchers = Array.from(this.watchers.values());
        this.watchers.clear();
        this.dirtyPaths.clear();
        this.unknownReasons.clear();
        this.versions.clear();
        this.requestIgnoreFiles.clear();
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.pendingEvents.clear();
        await Promise.all(watchers.map((watcher) => watcher.close()));
    }

    private queueFileEvent(codebasePath: string, eventPath: string): void {
        const pending = this.getPendingEvents(codebasePath);
        pending.files.push(eventPath);
        this.scheduleFlush(codebasePath);
    }

    private queueDirectoryEvent(codebasePath: string, eventPath: string, reason: string): void {
        const pending = this.getPendingEvents(codebasePath);
        pending.directories.push({ eventPath, reason });
        this.scheduleFlush(codebasePath);
    }

    private getPendingEvents(codebasePath: string): PendingProjectEvents {
        let pending = this.pendingEvents.get(codebasePath);
        if (!pending) {
            pending = { files: [], directories: [] };
            this.pendingEvents.set(codebasePath, pending);
        }
        return pending;
    }

    private scheduleFlush(codebasePath: string): void {
        const previousTimer = this.debounceTimers.get(codebasePath);
        if (previousTimer) {
            clearTimeout(previousTimer);
        }

        const timer = setTimeout(() => {
            this.debounceTimers.delete(codebasePath);
            this.flushPendingEvents(codebasePath);
        }, Math.max(0, Math.floor(this.options.debounceMs)));
        this.debounceTimers.set(codebasePath, timer);
    }

    private flushPendingEvents(codebasePath: string): void {
        const pending = this.pendingEvents.get(codebasePath);
        if (!pending) {
            return;
        }

        this.pendingEvents.delete(codebasePath);
        for (const filePath of pending.files) {
            this.recordFileEvent(codebasePath, filePath);
        }
        for (const directoryEvent of pending.directories) {
            this.recordDirectoryEvent(codebasePath, directoryEvent.eventPath, directoryEvent.reason);
        }
    }

    private clearPendingEvents(codebasePath: string): void {
        const timer = this.debounceTimers.get(codebasePath);
        if (timer) {
            clearTimeout(timer);
            this.debounceTimers.delete(codebasePath);
        }
        this.pendingEvents.delete(codebasePath);
    }

    private recordFileEvent(codebasePath: string, eventPath: string): void {
        const relativePath = this.toRelativePath(codebasePath, eventPath);
        if (!relativePath) {
            this.markUnknown(codebasePath, `event path is outside watched root: ${eventPath}`);
            return;
        }

        if (this.isIgnoreFilePath(codebasePath, relativePath)) {
            this.markUnknown(codebasePath, `ignore file changed: ${relativePath}`, { closeWatcher: false });
            return;
        }

        if (!this.dirtyPaths.has(codebasePath)) {
            this.dirtyPaths.set(codebasePath, new Map());
        }

        this.dirtyPaths.get(codebasePath)?.set(relativePath, this.bumpVersion(codebasePath));
    }

    private recordDirectoryEvent(codebasePath: string, eventPath: string, reason: string): void {
        const relativePath = this.toRelativePath(codebasePath, eventPath);
        this.markUnknown(codebasePath, relativePath ? `${reason}: ${relativePath}` : `${reason}: unresolved path`, { closeWatcher: false });
    }

    private toRelativePath(codebasePath: string, eventPath: string): string | null {
        const relativePath = path.relative(codebasePath, eventPath).replace(/\\/g, "/");
        if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
            return null;
        }
        return relativePath;
    }

    private isWatcherIgnored(codebasePath: string, candidatePath: string): boolean {
        const relativePath = path.relative(codebasePath, candidatePath).replace(/\\/g, "/");
        if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
            return false;
        }

        return relativePath
            .split("/")
            .some((segment) => WATCHER_IGNORED_DIRS.has(segment));
    }

    private getVersion(codebasePath: string): number {
        return this.versions.get(codebasePath) ?? 0;
    }

    private bumpVersion(codebasePath: string): number {
        const nextVersion = this.getVersion(codebasePath) + 1;
        this.versions.set(codebasePath, nextVersion);
        return nextVersion;
    }

    private deleteUnknownSeenAtOrBefore(codebasePath: string, observedVersion: number | undefined): void {
        const unknownReason = this.unknownReasons.get(codebasePath);
        if (!unknownReason) {
            return;
        }

        if (observedVersion === undefined || unknownReason.version <= observedVersion) {
            this.unknownReasons.delete(codebasePath);
        }
    }

    private updateIgnoreFiles(codebasePath: string, ignoreFiles: string[]): void {
        const normalized = ignoreFiles
            .map(ignoreFile => this.normalizeRelativePath(ignoreFile))
            .filter((ignoreFile): ignoreFile is string => ignoreFile !== null);
        this.requestIgnoreFiles.set(codebasePath, new Set(normalized));
    }

    private isIgnoreFilePath(codebasePath: string, relativePath: string): boolean {
        const normalizedPath = this.normalizeRelativePath(relativePath);
        if (!normalizedPath) {
            return false;
        }

        if (this.requestIgnoreFiles.get(codebasePath)?.has(normalizedPath)) {
            return true;
        }

        const basename = path.basename(relativePath);
        return basename === ".gitignore" ||
            basename === ".hceignore" ||
            basename === ".hitmux-context-engineignore" ||
            basename.endsWith(".ignore") ||
            (basename.startsWith(".") && basename.endsWith("ignore"));
    }

    private normalizeRelativePath(relativePath: string): string | null {
        const normalizedPath = relativePath
            .replace(/\\/g, "/")
            .replace(/^\/+/, "")
            .split("/")
            .filter(segment => segment.length > 0 && segment !== ".")
            .join("/");

        if (
            normalizedPath.length === 0 ||
            normalizedPath.startsWith("../") ||
            normalizedPath.includes("/../")
        ) {
            return null;
        }

        return normalizedPath;
    }
}
