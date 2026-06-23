import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { configManager } from "@hitmux/hitmux-context-engine-core";

const DEFAULT_SYNC_LOCK_STALE_MS = 10 * 60 * 1000;

interface WriterLockOwner {
    pid?: number;
    token?: string;
    acquiredAt?: string;
    heartbeatAt?: string;
    label?: string;
    recoveredStaleLock?: boolean;
}

export type McpWriterLockScope =
    | { kind: "collection"; collectionName: string }
    | { kind: "global"; name?: string };

export class McpWriterLock {
    private heartbeatTimer: NodeJS.Timeout | null = null;

    constructor(
        public readonly lockPath: string,
        private readonly token: string,
        private readonly staleMs: number
    ) {}

    public startHeartbeat(): void {
        if (this.heartbeatTimer) {
            return;
        }

        const intervalMs = Math.max(1, Math.min(Math.floor(this.staleMs / 3), 30_000));
        this.heartbeatTimer = setInterval(() => {
            const owner = readWriterLockOwner(this.lockPath);
            if (!owner?.token || owner.token !== this.token) {
                this.stopHeartbeat();
                return;
            }

            try {
                writeWriterLockOwner(this.lockPath, owner);
            } catch (error: any) {
                console.warn(`[SYNC-DEBUG] Failed to heartbeat MCP writer lock: ${error?.message || String(error)}`);
            }
        }, intervalMs);
        this.heartbeatTimer.unref?.();
    }

    public release(): void {
        try {
            this.stopHeartbeat();
            const ownerPath = path.join(this.lockPath, "owner.json");
            if (fs.existsSync(ownerPath)) {
                const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as WriterLockOwner;
                if (owner.token && owner.token !== this.token) {
                    console.warn(`[SYNC-DEBUG] MCP writer lock is owned by another process. Skipping release: ${this.lockPath}`);
                    return;
                }
            }
            fs.rmSync(this.lockPath, { recursive: true, force: true });
            console.log(`[SYNC-DEBUG] Released MCP writer lock: ${this.lockPath}`);
        } catch (error: any) {
            console.warn(`[SYNC-DEBUG] Failed to release MCP writer lock: ${error?.message || String(error)}`);
        }
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
}

export function getMcpWriterLockPath(scope: McpWriterLockScope = { kind: "global", name: "maintenance" }): string {
    const basePath = path.join(os.homedir(), ".hitmux-context-engine", "locks");
    if (scope.kind === "collection") {
        const safeCollectionName = encodeURIComponent(scope.collectionName);
        return path.join(basePath, "collections", `${safeCollectionName}.lock`);
    }

    const safeName = encodeURIComponent(scope.name || "maintenance");
    return path.join(basePath, "global", `${safeName}.lock`);
}

export function acquireMcpWriterLock(
    label: string,
    scope: McpWriterLockScope = { kind: "global", name: "maintenance" },
): McpWriterLock | null {
    const lockPath = getMcpWriterLockPath(scope);
    const staleMs = getWriterLockStaleMs();
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    try {
        fs.mkdirSync(lockPath);
        writeWriterLockOwner(lockPath, {
            pid: process.pid,
            token,
            acquiredAt: new Date().toISOString(),
            label
        });
        console.log(`[SYNC-DEBUG] Acquired MCP writer lock for ${label}: ${lockPath}`);
        const lock = new McpWriterLock(lockPath, token, staleMs);
        lock.startHeartbeat();
        return lock;
    } catch (error: any) {
        if (error?.code !== "EEXIST") {
            console.warn(`[SYNC-DEBUG] Failed to acquire MCP writer lock for ${label}: ${error?.message || String(error)}`);
            return null;
        }

        try {
            const owner = readWriterLockOwner(lockPath);
            if (
                owner?.pid !== undefined &&
                !isProcessAlive(owner.pid)
            ) {
                return reclaimWriterLock(
                    lockPath,
                    token,
                    staleMs,
                    label,
                    "dead owner process",
                );
            }
            const lastOwnerUpdateMs = getWriterLockLastUpdateMs(lockPath);
            const ownerHasLivePid =
                owner?.pid !== undefined && isProcessAlive(owner.pid);
            if (!ownerHasLivePid && Date.now() - lastOwnerUpdateMs > staleMs) {
                return reclaimWriterLock(
                    lockPath,
                    token,
                    staleMs,
                    label,
                    "stale heartbeat",
                );
            }
        } catch (statError: any) {
            console.warn(`[SYNC-DEBUG] Could not inspect MCP writer lock for ${label}: ${statError?.message || String(statError)}`);
        }

        console.log(`[SYNC-DEBUG] Another MCP process is already writing index state. Skipping ${label}.`);
        return null;
    }
}

function reclaimWriterLock(
    lockPath: string,
    token: string,
    staleMs: number,
    label: string,
    reason: string
): McpWriterLock | null {
    const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
    console.warn(`[SYNC-DEBUG] Reclaiming MCP writer lock (${reason}): ${lockPath}`);
    fs.renameSync(lockPath, stalePath);
    fs.rmSync(stalePath, { recursive: true, force: true });
    fs.mkdirSync(lockPath);
    writeWriterLockOwner(lockPath, {
        pid: process.pid,
        token,
        acquiredAt: new Date().toISOString(),
        label,
        recoveredStaleLock: true
    });
    console.log(`[SYNC-DEBUG] Acquired MCP writer lock after cleanup for ${label}: ${lockPath}`);
    const lock = new McpWriterLock(lockPath, token, staleMs);
    lock.startHeartbeat();
    return lock;
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error: any) {
        return error?.code === "EPERM";
    }
}

export function formatMcpWriterLockBusyMessage(
    action: string,
    scope: McpWriterLockScope = { kind: "global", name: "maintenance" },
): string {
    const lockPath = getMcpWriterLockPath(scope);
    const owner = readWriterLockOwner(lockPath);
    const ownerLabel = owner?.label || "unknown operation";
    const pid = owner?.pid === undefined ? "unknown" : String(owner.pid);
    const acquiredAt = owner?.acquiredAt || "unknown";
    const heartbeatAt = owner?.heartbeatAt || "unknown";
    const heldFor = formatHeldDuration(owner?.acquiredAt);
    return (
        `Another MCP process is already writing index state for ${formatLockScope(scope)}. ` +
        `Current owner: ${ownerLabel}; pid: ${pid}; acquiredAt: ${acquiredAt}; ` +
        `heartbeatAt: ${heartbeatAt}; heldFor: ${heldFor}; lockPath: ${lockPath}. ` +
        `Please retry ${action} after the current write operation finishes.`
    );
}

function getWriterLockStaleMs(): number {
    const value = configManager.getNumber("syncLockStaleMs");
    if (value === undefined) {
        return DEFAULT_SYNC_LOCK_STALE_MS;
    }

    if (!Number.isFinite(value) || value <= 0) {
        console.warn(`[SYNC-DEBUG] Invalid config.syncLockStaleMs value '${value}'. Falling back to ${DEFAULT_SYNC_LOCK_STALE_MS}ms.`);
        return DEFAULT_SYNC_LOCK_STALE_MS;
    }

    return Math.floor(value);
}

function readWriterLockOwner(lockPath: string): WriterLockOwner | undefined {
    try {
        return JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")) as WriterLockOwner;
    } catch {
        return undefined;
    }
}

function writeWriterLockOwner(lockPath: string, owner: WriterLockOwner): void {
    const now = new Date();
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
        ...owner,
        heartbeatAt: now.toISOString()
    }, null, 2));
    fs.utimesSync(lockPath, now, now);
}

function getWriterLockLastUpdateMs(lockPath: string): number {
    const owner = readWriterLockOwner(lockPath);
    const heartbeatMs = owner?.heartbeatAt ? Date.parse(owner.heartbeatAt) : NaN;
    if (Number.isFinite(heartbeatMs)) {
        return heartbeatMs;
    }

    const acquiredMs = owner?.acquiredAt ? Date.parse(owner.acquiredAt) : NaN;
    if (Number.isFinite(acquiredMs)) {
        return acquiredMs;
    }

    return fs.statSync(lockPath).mtimeMs;
}

function formatLockScope(scope: McpWriterLockScope): string {
    if (scope.kind === "collection") {
        return `collection '${scope.collectionName}'`;
    }
    return `global '${scope.name || "maintenance"}'`;
}

function formatHeldDuration(acquiredAt: string | undefined): string {
    if (!acquiredAt) {
        return "unknown";
    }

    const acquiredMs = Date.parse(acquiredAt);
    if (!Number.isFinite(acquiredMs)) {
        return "unknown";
    }

    const elapsedMs = Math.max(0, Date.now() - acquiredMs);
    if (elapsedMs < 1000) {
        return `${Math.round(elapsedMs)}ms`;
    }
    if (elapsedMs < 60_000) {
        return `${(elapsedMs / 1000).toFixed(1)}s`;
    }

    const minutes = Math.floor(elapsedMs / 60_000);
    const seconds = Math.floor((elapsedMs % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
}
