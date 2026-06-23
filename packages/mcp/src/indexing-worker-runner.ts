import { Worker } from "node:worker_threads";

import type {
    CodebaseIndexOptions,
    RequestSplitterType,
} from "./config.js";
import type {
    IndexingJobProgress,
    IndexingJobStats,
} from "./indexing-job-state.js";

export class IndexingWorkerCancelledError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "IndexingWorkerCancelledError";
    }
}

export interface IndexingWorkerRequest {
    jobId: string;
    codebasePath: string;
    splitterType: RequestSplitterType;
    customIgnorePatterns: string[];
    customFileExtensions: string[];
    customIgnoreFiles: string[];
    requestMaxDepth?: number;
    indexOptions?: CodebaseIndexOptions;
    serverVersion?: string;
}

interface IndexingWorkerLike {
    postMessage(message: unknown): void;
    terminate(): Promise<number>;
    on(event: "message", listener: (message: IndexingWorkerMessage) => void): void;
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "exit", listener: (code: number) => void): void;
}

type IndexingWorkerMessage =
    | { type: "ready"; threadId: number }
    | { type: "progress"; progress: IndexingJobProgress }
    | { type: "completed"; stats: IndexingJobStats }
    | { type: "failed"; errorMessage: string }
    | { type: "cancelled"; errorMessage: string };

function getWorkerUrl(): URL {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    return new URL(`./indexing-worker.${extension}`, import.meta.url);
}

export function startIndexingWorkerJob(
    request: IndexingWorkerRequest,
    signal: AbortSignal,
    callbacks: {
        onReady?: (threadId: number) => void;
        onProgress?: (progress: IndexingJobProgress) => void;
    } = {},
    options: {
        createWorker?: (url: URL, workerData: IndexingWorkerRequest) => IndexingWorkerLike;
        forceTerminateMs?: number;
    } = {},
): Promise<IndexingJobStats> {
    return new Promise((resolve, reject) => {
        const worker =
            options.createWorker?.(getWorkerUrl(), request) ??
            new Worker(getWorkerUrl(), {
                workerData: request,
            });
        let settled = false;
        let cancellationRequested = false;
        let forceTerminateTimer: NodeJS.Timeout | undefined;

        const cancelWorker = () => {
            cancellationRequested = true;
            worker.postMessage({ type: "cancel" });
            forceTerminateTimer = setTimeout(() => {
                void worker.terminate();
            }, options.forceTerminateMs ?? 30_000);
            forceTerminateTimer.unref?.();
        };
        const cleanupWorker = (terminate = true) => {
            signal.removeEventListener("abort", cancelWorker);
            if (forceTerminateTimer) {
                clearTimeout(forceTerminateTimer);
                forceTerminateTimer = undefined;
            }
            if (terminate) {
                void worker.terminate().catch(() => undefined);
            }
        };
        if (signal.aborted) {
            cancelWorker();
        } else {
            signal.addEventListener("abort", cancelWorker, { once: true });
        }

        worker.on("message", (message: IndexingWorkerMessage) => {
            switch (message.type) {
                case "ready":
                    callbacks.onReady?.(message.threadId);
                    break;
                case "progress":
                    callbacks.onProgress?.(message.progress);
                    break;
                case "completed":
                    settled = true;
                    cleanupWorker();
                    resolve(message.stats);
                    break;
                case "cancelled":
                    settled = true;
                    cleanupWorker();
                    reject(
                        new IndexingWorkerCancelledError(message.errorMessage),
                    );
                    break;
                case "failed":
                    settled = true;
                    cleanupWorker();
                    reject(new Error(message.errorMessage));
                    break;
            }
        });

        worker.on("error", (error) => {
            if (settled) return;
            settled = true;
            cleanupWorker();
            reject(error);
        });

        worker.on("exit", (code) => {
            if (settled) return;
            settled = true;
            cleanupWorker(false);
            if (cancellationRequested) {
                reject(
                    new IndexingWorkerCancelledError(
                        "Indexing worker was cancelled",
                    ),
                );
                return;
            }
            reject(
                new Error(
                    `Indexing worker exited before completion with code ${code}`,
                ),
            );
        });
    });
}
