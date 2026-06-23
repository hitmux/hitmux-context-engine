import * as fs from "fs";
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

import type {
    CodebaseIndexOptions,
    RequestSplitterType,
} from "./config.js";

export interface IndexingJobProgress {
    phase: string;
    current: number;
    total: number;
    percentage: number;
}

export interface IndexingJobStats {
    indexedFiles: number;
    totalChunks: number;
    status: "completed" | "limit_reached";
}

export type IndexingJobStatus =
    | "running"
    | "completed"
    | "failed"
    | "cancelled";

export interface IndexingJobState {
    jobId: string;
    codebasePath: string;
    collectionName: string;
    splitterType: RequestSplitterType;
    status: IndexingJobStatus;
    startedAt: string;
    updatedAt: string;
    pid: number;
    workerThreadId?: number;
    progress: IndexingJobProgress;
    indexOptions?: CodebaseIndexOptions;
    stats?: IndexingJobStats;
    errorMessage?: string;
}

export class IndexingJobStateManager {
    private writeQueues = new Map<string, Promise<void>>();

    public createJobId(codebasePath: string): string {
        const digest = crypto
            .createHash("sha1")
            .update(`${process.pid}:${Date.now()}:${codebasePath}:${Math.random()}`)
            .digest("hex")
            .slice(0, 16);
        return `index_${Date.now()}_${digest}`;
    }

    public async createRunningJob(input: {
        jobId: string;
        codebasePath: string;
        collectionName: string;
        splitterType: RequestSplitterType;
        indexOptions?: CodebaseIndexOptions;
    }): Promise<IndexingJobState> {
        const now = new Date().toISOString();
        const state: IndexingJobState = {
            jobId: input.jobId,
            codebasePath: input.codebasePath,
            collectionName: input.collectionName,
            splitterType: input.splitterType,
            status: "running",
            startedAt: now,
            updatedAt: now,
            pid: process.pid,
            progress: {
                phase: "Starting indexing worker...",
                current: 0,
                total: 100,
                percentage: 0,
            },
            ...(input.indexOptions ? { indexOptions: input.indexOptions } : {}),
        };
        await this.writeState(state);
        return state;
    }

    public updateWorkerThreadId(
        jobId: string,
        workerThreadId: number,
    ): Promise<void> {
        return this.enqueue(jobId, async (state) => {
            if (!state || state.status !== "running") return state;
            return {
                ...state,
                workerThreadId,
                updatedAt: new Date().toISOString(),
            };
        });
    }

    public updateProgress(
        jobId: string,
        progress: IndexingJobProgress,
    ): Promise<void> {
        return this.enqueue(jobId, async (state) => {
            if (!state || state.status !== "running") return state;
            return {
                ...state,
                progress,
                updatedAt: new Date().toISOString(),
            };
        });
    }

    public markCompleted(jobId: string, stats: IndexingJobStats): Promise<void> {
        return this.enqueue(jobId, async (state) => {
            if (!state) return state;
            return {
                ...state,
                status: "completed",
                stats,
                progress: {
                    phase: "Indexing complete",
                    current: 100,
                    total: 100,
                    percentage: 100,
                },
                updatedAt: new Date().toISOString(),
            };
        });
    }

    public markFailed(jobId: string, errorMessage: string): Promise<void> {
        return this.enqueue(jobId, async (state) => {
            if (!state) return state;
            return {
                ...state,
                status: "failed",
                errorMessage,
                updatedAt: new Date().toISOString(),
            };
        });
    }

    public markCancelled(jobId: string, errorMessage: string): Promise<void> {
        return this.enqueue(jobId, async (state) => {
            if (!state) return state;
            return {
                ...state,
                status: "cancelled",
                errorMessage,
                updatedAt: new Date().toISOString(),
            };
        });
    }

    public readJob(jobId: string): IndexingJobState | undefined {
        try {
            return JSON.parse(
                fs.readFileSync(this.getJobPath(jobId), "utf8"),
            ) as IndexingJobState;
        } catch {
            return undefined;
        }
    }

    public findLatestForCodebase(
        codebasePath: string,
    ): IndexingJobState | undefined {
        try {
            const jobsDir = this.getJobsDir();
            if (!fs.existsSync(jobsDir)) return undefined;
            const states = fs
                .readdirSync(jobsDir)
                .filter((entry) => entry.endsWith(".json"))
                .map((entry) => {
                    try {
                        return JSON.parse(
                            fs.readFileSync(path.join(jobsDir, entry), "utf8"),
                        ) as IndexingJobState;
                    } catch {
                        return undefined;
                    }
                })
                .filter(
                    (state): state is IndexingJobState =>
                        !!state && state.codebasePath === codebasePath,
                )
                .sort(
                    (a, b) =>
                        Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
                );
            return states[0];
        } catch {
            return undefined;
        }
    }

    private enqueue(
        jobId: string,
        update: (
            state: IndexingJobState | undefined,
        ) => Promise<IndexingJobState | undefined>,
    ): Promise<void> {
        const previous = this.writeQueues.get(jobId) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(async () => {
                const nextState = await update(this.readJob(jobId));
                if (nextState) {
                    await this.writeState(nextState);
                }
            })
            .finally(() => {
                if (this.writeQueues.get(jobId) === next) {
                    this.writeQueues.delete(jobId);
                }
            });
        this.writeQueues.set(jobId, next);
        return next;
    }

    private getJobsDir(): string {
        return path.join(os.homedir(), ".hitmux-context-engine", "jobs");
    }

    private getJobPath(jobId: string): string {
        return path.join(this.getJobsDir(), `${jobId}.json`);
    }

    private async writeState(state: IndexingJobState): Promise<void> {
        const jobsDir = this.getJobsDir();
        await fsp.mkdir(jobsDir, { recursive: true });
        const jobPath = this.getJobPath(state.jobId);
        const tempPath = `${jobPath}.tmp-${process.pid}-${Date.now()}`;
        await fsp.writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
        await fsp.rename(tempPath, jobPath);
    }
}
