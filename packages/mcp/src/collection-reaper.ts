import { MilvusVectorDatabase } from "@hitmux/hitmux-context-engine-core";

import type { ContextMcpConfig } from "./config.js";

export interface CollectionReaperOptions {
    createConfig: () => ContextMcpConfig;
    signal?: AbortSignal;
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
    createVectorDatabase?: (config: ContextMcpConfig) => MilvusVectorDatabase;
}

export function getCollectionReaperUsage(): string {
    return "Usage: hce collection-reaper\n";
}

export async function runCollectionReaperCommand(
    args: string[],
    options: CollectionReaperOptions,
): Promise<number> {
    if (args.length !== 0) {
        writeStderr(options, getCollectionReaperUsage());
        return 2;
    }

    const config = options.createConfig();
    const database = options.createVectorDatabase?.(config) ?? new MilvusVectorDatabase({
        address: config.milvusAddress,
        ...(config.milvusToken && { token: config.milvusToken }),
        useSystemProxy: config.databaseUseSystemProxy,
        collectionLeaseEnabled: config.collectionLeaseEnabled,
        collectionLeaseHeartbeatMs: config.collectionLeaseHeartbeatMs,
        collectionLeaseMissLimit: config.collectionLeaseMissLimit,
    });
    const intervalMs = config.collectionLeaseHeartbeatMs ?? 30_000;

    try {
        while (!options.signal?.aborted) {
            const result = await database.reapExpiredCollectionLeases();
            for (const collectionName of result.releasedCollections) {
                writeStdout(options, `Released expired collection lease: ${collectionName}\n`);
            }
            await waitForInterval(intervalMs, options.signal);
        }
        return 0;
    } catch (error) {
        writeStderr(options, `Collection reaper failed: ${formatErrorMessage(error)}\n`);
        return 1;
    } finally {
        await database.close();
    }
}

async function waitForInterval(intervalMs: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
        if (!signal) {
            setTimeout(resolve, intervalMs);
            return;
        }
        if (signal.aborted) {
            resolve();
            return;
        }
        const onAbort = () => finish();
        const timer = setTimeout(() => finish(), intervalMs);
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function writeStdout(options: CollectionReaperOptions, message: string): void {
    options.stdout?.(message) ?? process.stdout.write(message);
}

function writeStderr(options: CollectionReaperOptions, message: string): void {
    options.stderr?.(message) ?? process.stderr.write(message);
}

function formatErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
