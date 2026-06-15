import { performance } from "node:perf_hooks";

import {
    Embedding,
    MilvusVectorDatabase,
    VectorDatabase,
    configManager,
} from "@hitmux/hitmux-context-engine-core";
import { ContextMcpConfig, createMcpConfig } from "./config.js";
import { createEmbeddingInstance } from "./embedding.js";

export type CliTestTarget = "embedding" | "vectordb";

export interface CliTestOptions {
    createConfig?: () => ContextMcpConfig;
    createEmbedding?: (config: ContextMcpConfig) => Embedding;
    createVectorDatabase?: (config: ContextMcpConfig) => VectorDatabase;
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
}

export function parseCliTestTargets(args: string[]): CliTestTarget[] {
    if (args.length === 0) {
        return ["embedding", "vectordb"];
    }

    if (args.length === 1 && args[0] === "embedding") {
        return ["embedding"];
    }

    if (args.length === 1 && args[0] === "vectordb") {
        return ["vectordb"];
    }

    throw new Error(
        "Usage: hce test [embedding|vectordb]\n       hitmux-context-engine test [embedding|vectordb]",
    );
}

export async function runCliTestCommand(
    args: string[],
    options: CliTestOptions = {},
): Promise<number> {
    let targets: CliTestTarget[];
    try {
        targets = parseCliTestTargets(args);
    } catch (error) {
        writeStderr(options, `${formatErrorMessage(error)}\n`);
        return 2;
    }

    const configError = getConfigReadError();
    if (configError) {
        writeStderr(options, `Config error: ${configError.message}\n`);
        return 1;
    }

    const configFactory = options.createConfig ?? createMcpConfig;
    const config = configFactory();
    let failed = false;

    for (const target of targets) {
        try {
            if (target === "embedding") {
                await testEmbedding(config, options);
            } else {
                await testVectorDatabase(config, options);
            }
        } catch (error) {
            failed = true;
            writeStderr(options, `[FAIL] ${target}: ${formatErrorMessage(error)}\n`);
        }
    }

    return failed ? 1 : 0;
}

function getConfigReadError(): Error | null {
    const errors = configManager.getReadErrors(process.cwd());
    if (errors.length === 0) {
        return null;
    }

    const details = errors
        .map((error) => `${error.path}: ${error.message}`)
        .join("\n");
    return new Error(
        `Invalid config.conf. Fix the configuration before running tests.\n${details}`,
    );
}

async function testEmbedding(
    config: ContextMcpConfig,
    options: CliTestOptions,
): Promise<void> {
    writeStdout(
        options,
        `[TEST] embedding: ${config.embeddingProvider}/${config.embeddingModel}\n`,
    );
    const startedAt = performance.now();
    const createEmbedding = options.createEmbedding ?? createEmbeddingInstance;
    const embedding = createEmbedding(config);
    const result = await embedding.embed(
        "Hitmux Context Engine embedding connectivity test",
    );

    if (!Array.isArray(result.vector) || result.vector.length === 0) {
        throw new Error("Embedding provider returned an empty vector");
    }
    if (!result.vector.every(Number.isFinite)) {
        throw new Error("Embedding provider returned a non-finite vector value");
    }
    if (result.dimension !== result.vector.length) {
        throw new Error(
            `Embedding dimension mismatch: dimension=${result.dimension}, vector.length=${result.vector.length}`,
        );
    }

    writeStdout(
        options,
        `[PASS] embedding: dimension=${result.dimension}, elapsed=${formatElapsed(startedAt)}\n`,
    );
}

async function testVectorDatabase(
    config: ContextMcpConfig,
    options: CliTestOptions,
): Promise<void> {
    writeStdout(
        options,
        `[TEST] vectordb: ${config.milvusAddress || (config.milvusToken ? "[auto-resolve from token]" : "[not configured]")}\n`,
    );
    const startedAt = performance.now();
    const createVectorDatabase =
        options.createVectorDatabase ??
        ((currentConfig: ContextMcpConfig) =>
            new MilvusVectorDatabase({
                address: currentConfig.milvusAddress,
                ...(currentConfig.milvusToken && {
                    token: currentConfig.milvusToken,
                }),
                useSystemProxy: currentConfig.databaseUseSystemProxy,
            }));
    const vectorDatabase = createVectorDatabase(config);
    const collections = await vectorDatabase.listCollections();

    writeStdout(
        options,
        `[PASS] vectordb: collections=${collections.length}, elapsed=${formatElapsed(startedAt)}\n`,
    );
}

function formatElapsed(startedAt: number): string {
    return `${Math.round(performance.now() - startedAt)}ms`;
}

function formatErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function writeStdout(options: CliTestOptions, message: string): void {
    if (options.stdout) {
        options.stdout(message);
    } else {
        process.stdout.write(message);
    }
}

function writeStderr(options: CliTestOptions, message: string): void {
    if (options.stderr) {
        options.stderr(message);
    } else {
        process.stderr.write(message);
    }
}
