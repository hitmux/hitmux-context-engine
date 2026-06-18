import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    projectRoot?: string;
    runs: number;
    outPath: string;
    collectionNameOverride: string;
    maxDepth?: number;
    keepCollection: boolean;
    allowDropExistingBaseline: boolean;
}

interface TimingSummary {
    codebasePath: string;
    indexedFiles: number;
    totalChunks: number;
    embeddingBatchSize: number;
    embeddingConcurrency: number;
    fileProcessingConcurrency: number;
    totalIndexingMs: number;
    prepareCollectionMs: number;
    loadIgnorePatternsMs: number;
    scanFilesMs: number;
    fileWeightStatMs: number;
    readAndSplitMs: number;
    embeddingMs: number;
    vectorInsertMs: number;
    flushLoadMs: number;
    verifyMs: number;
    filesPerSecond: number;
    chunksPerSecond: number;
    [key: string]: unknown;
}

interface BaselineRun {
    run: number;
    status: "completed" | "error";
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    timing?: TimingSummary;
    error?: string;
}

const DEFAULT_RUNS = 3;

function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = {
        runs: DEFAULT_RUNS,
        outPath: path.resolve("benchmark/results/indexing-baseline/report.json"),
        collectionNameOverride: `indexing_baseline_${new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "_")}`,
        keepCollection: false,
        allowDropExistingBaseline: false,
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        const next = () => {
            const value = argv[++index];
            if (!value) {
                throw new Error(`Missing value for ${arg}`);
            }
            return value;
        };

        switch (arg) {
            case "--project-root":
                options.projectRoot = path.resolve(next());
                break;
            case "--runs":
                options.runs = parsePositiveInteger(next(), "--runs");
                break;
            case "--out":
                options.outPath = path.resolve(next());
                break;
            case "--collection-name-override":
                options.collectionNameOverride = next();
                break;
            case "--max-depth":
                options.maxDepth = parseNonNegativeInteger(next(), "--max-depth");
                break;
            case "--keep-collection":
                options.keepCollection = true;
                break;
            case "--allow-drop-existing-baseline":
                options.allowDropExistingBaseline = true;
                break;
            case "--help":
            case "-h":
                printUsage();
                process.exit(0);
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (!options.projectRoot) {
        throw new Error("Missing required --project-root");
    }
    if (!fs.existsSync(options.projectRoot) || !fs.statSync(options.projectRoot).isDirectory()) {
        throw new Error(`Project root does not exist or is not a directory: ${options.projectRoot}`);
    }
    if (!options.collectionNameOverride.startsWith("indexing_baseline_")) {
        throw new Error("--collection-name-override must start with 'indexing_baseline_' so the runner cannot target a normal business collection");
    }

    return options;
}

function parsePositiveInteger(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

function parseNonNegativeInteger(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative integer`);
    }
    return parsed;
}

function printUsage(): void {
    console.log(`Usage:
  pnpm benchmark:indexing -- --project-root <path> [options]

Options:
  --runs <n>                         Number of full indexing runs. Default: ${DEFAULT_RUNS}
  --out <path>                       JSON report path. Default: benchmark/results/indexing-baseline/report.json
  --collection-name-override <name>  Temporary collection suffix. Default: indexing_baseline_<timestamp>
  --max-depth <n>                    Limit file traversal depth for the indexed project.
  --keep-collection                  Keep the temporary baseline collection after the run.
  --allow-drop-existing-baseline     Allow dropping an existing indexing_baseline_* collection before run 1.`);
}

function percentile(values: number[], percentileValue: number): number | null {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
    return sorted[index];
}

function summarizeMetric(runs: BaselineRun[], key: string): { p50: number | null; p95: number | null; min: number | null; max: number | null } {
    const values = runs
        .map(run => run.timing?.[key])
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return {
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        min: values.length > 0 ? Math.min(...values) : null,
        max: values.length > 0 ? Math.max(...values) : null,
    };
}

function buildReport(options: CliOptions, runs: BaselineRun[]): Record<string, unknown> {
    const timingKeys = [
        "totalIndexingMs",
        "prepareCollectionMs",
        "loadIgnorePatternsMs",
        "scanFilesMs",
        "fileWeightStatMs",
        "readAndSplitMs",
        "embeddingMs",
        "vectorInsertMs",
        "flushLoadMs",
        "verifyMs",
        "filesPerSecond",
        "chunksPerSecond",
    ];
    const metricSummary = Object.fromEntries(timingKeys.map(key => [key, summarizeMetric(runs, key)]));
    const durationMs = summarizeMetric(runs, "durationMs");
    const completed = runs.filter(run => run.status === "completed").length;
    const failed = runs.length - completed;

    return {
        generatedAt: new Date().toISOString(),
        projectRoot: options.projectRoot,
        collectionNameOverride: options.collectionNameOverride,
        runsRequested: options.runs,
        completedRuns: completed,
        failedRuns: failed,
        errorRate: runs.length > 0 ? failed / runs.length : 0,
        durationMs,
        timingMetricSemantics: {
            totalIndexingMs: "wall-clock time for a full indexCodebase call",
            filesPerSecond: "indexedFiles divided by totalIndexingMs",
            chunksPerSecond: "totalChunks divided by totalIndexingMs",
            readAndSplitMs: "accumulated file worker read/split time; may exceed or move differently from wall-clock time when fileProcessingConcurrency changes",
            embeddingMs: "accumulated embedding batch time; may exceed or move differently from wall-clock time when embeddingConcurrency changes",
            vectorInsertMs: "accumulated vector insert batch time excluding measured flush/load time",
            flushLoadMs: "accumulated VectorDB flush/load/finalize time reported by the vector database adapter",
        },
        metricSummary,
        runs,
    };
}

async function withTimingCapture(action: () => Promise<void>): Promise<TimingSummary | undefined> {
    const originalLog = console.log;
    let timingSummary: TimingSummary | undefined;
    console.log = (...args: unknown[]) => {
        if (args[0] === "[Context] ⏱️ Indexing timing summary:" && typeof args[1] === "object" && args[1] !== null) {
            timingSummary = args[1] as TimingSummary;
        }
        originalLog(...args);
    };
    try {
        await action();
        return timingSummary;
    } finally {
        console.log = originalLog;
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const [{ Context, MilvusVectorDatabase }, { createMcpConfig }, { createEmbeddingInstance }] = await Promise.all([
        import("@hitmux/hitmux-context-engine-core"),
        import("../packages/mcp/src/config.js"),
        import("../packages/mcp/src/embedding.js"),
    ]);
    const config = createMcpConfig();
    const embedding = createEmbeddingInstance(config);
    const vectorDatabase = new MilvusVectorDatabase({
        address: config.milvusAddress,
        ...(config.milvusToken && { token: config.milvusToken }),
        useSystemProxy: config.databaseUseSystemProxy,
    });
    const context = new Context({
        embedding,
        vectorDatabase,
        collectionNameOverride: options.collectionNameOverride,
        collectionIdentity: {
            mode: config.codebaseIdentityMode,
            customIdentity: config.codebaseIdentity,
            globalName: config.globalCollectionName,
            gitRemoteName: config.gitRemoteName,
        },
    });

    const runs: BaselineRun[] = [];
    const collectionName = context.getCollectionName(options.projectRoot);
    console.log(`[INDEXING-BASELINE] Using temporary collection: ${collectionName}`);
    const existingCollection = await vectorDatabase.hasCollection(collectionName);
    if (existingCollection && !options.allowDropExistingBaseline) {
        throw new Error(
            `Temporary baseline collection already exists: ${collectionName}. Re-run with a fresh --collection-name-override or pass --allow-drop-existing-baseline if this is an old indexing baseline collection.`
        );
    }

    try {
        for (let run = 1; run <= options.runs; run++) {
            const startedAt = new Date();
            console.log(`[INDEXING-BASELINE] Run ${run}/${options.runs} started`);
            try {
                const timing = await withTimingCapture(async () => {
                    await context.indexCodebase(
                        options.projectRoot,
                        undefined,
                        true,
                        [],
                        [],
                        undefined,
                        undefined,
                        { maxDepth: options.maxDepth },
                    );
                });
                if (!timing) {
                    throw new Error("Indexing completed but no timing summary was captured");
                }
                const finishedAt = new Date();
                runs.push({
                    run,
                    status: "completed",
                    startedAt: startedAt.toISOString(),
                    finishedAt: finishedAt.toISOString(),
                    durationMs: finishedAt.getTime() - startedAt.getTime(),
                    timing,
                });
                console.log(`[INDEXING-BASELINE] Run ${run}/${options.runs} completed`);
            } catch (error) {
                const finishedAt = new Date();
                runs.push({
                    run,
                    status: "error",
                    startedAt: startedAt.toISOString(),
                    finishedAt: finishedAt.toISOString(),
                    durationMs: finishedAt.getTime() - startedAt.getTime(),
                    error: error instanceof Error ? error.message : String(error),
                });
                console.error(`[INDEXING-BASELINE] Run ${run}/${options.runs} failed:`, error);
            }
        }
    } finally {
        if (!options.keepCollection) {
            try {
                if (await vectorDatabase.hasCollection(collectionName)) {
                    await vectorDatabase.dropCollection(collectionName);
                    console.log(`[INDEXING-BASELINE] Dropped temporary collection: ${collectionName}`);
                }
            } catch (error) {
                console.warn(`[INDEXING-BASELINE] Failed to drop temporary collection '${collectionName}':`, error);
            }
        }
    }

    const report = buildReport(options, runs);
    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    fs.writeFileSync(options.outPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
    console.log(`[INDEXING-BASELINE] Wrote report to ${options.outPath}`);

    if (runs.some(run => run.status === "error")) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
