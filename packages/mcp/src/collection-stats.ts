export interface CollectionStats {
    indexedFiles: number;
    totalChunks: number;
    statsSource: "collection_row_count";
}

interface CollectionStatsContext {
    getCollectionName(codebasePath: string): string;
    getVectorDatabase(): {
        getCollectionRowCount(collectionName: string): Promise<number>;
        query(collectionName: string, filter: string, outputFields: string[], limit: number): Promise<CollectionStatsRow[]>;
    };
}

interface CollectionStatsRow {
    relativePath?: unknown;
    metadata?: unknown;
}

function parseRowCodebasePath(row: CollectionStatsRow): string | undefined {
    if (typeof row.metadata === "string" && row.metadata.length > 0) {
        try {
            const metadata = JSON.parse(row.metadata) as { codebasePath?: unknown };
            return typeof metadata.codebasePath === "string" && metadata.codebasePath.length > 0
                ? metadata.codebasePath
                : undefined;
        } catch {
            return undefined;
        }
    }

    if (
        row.metadata &&
        typeof row.metadata === "object" &&
        "codebasePath" in row.metadata
    ) {
        const codebasePath = (row.metadata as { codebasePath?: unknown }).codebasePath;
        return typeof codebasePath === "string" && codebasePath.length > 0
            ? codebasePath
            : undefined;
    }

    return undefined;
}

async function queryIndexedFileCount(
    context: CollectionStatsContext,
    collectionName: string,
    codebasePath: string,
    rowCount: number,
    logPrefix: string
): Promise<{ indexedFiles: number; totalChunks: number } | undefined> {
    try {
        const rows = await context.getVectorDatabase().query(collectionName, "", ["relativePath", "metadata"], rowCount);
        const filePaths = new Set<string>();
        let totalChunks = 0;
        let sawCodebaseMetadata = false;

        for (const row of rows) {
            const rowCodebasePath = parseRowCodebasePath(row);
            if (rowCodebasePath) {
                sawCodebaseMetadata = true;
                if (rowCodebasePath !== codebasePath) {
                    continue;
                }
            }

            totalChunks++;
            if (typeof row.relativePath === "string" && row.relativePath.length > 0) {
                filePaths.add(row.relativePath);
            }
        }

        if (sawCodebaseMetadata && totalChunks === 0) {
            return undefined;
        }

        if (totalChunks > 0) {
            return { indexedFiles: filePaths.size, totalChunks };
        }
    } catch (error) {
        console.warn(`[${logPrefix}] Failed to query distinct indexed files for '${collectionName}':`, error);
    }

    return undefined;
}

export async function queryCollectionCodebasePaths(
    context: CollectionStatsContext,
    collectionName: string,
    logPrefix = "SNAPSHOT-RECOVERY"
): Promise<Set<string> | null> {
    try {
        const vectorDatabase = context.getVectorDatabase();
        if (typeof vectorDatabase?.getCollectionRowCount !== "function") {
            return null;
        }

        const rowCount = await vectorDatabase.getCollectionRowCount(collectionName);
        if (rowCount < 0) {
            console.warn(`[${logPrefix}] Row count unknown for '${collectionName}', skipping codebase path extraction`);
            return null;
        }
        if (rowCount === 0) {
            return new Set();
        }

        const rows = await vectorDatabase.query(collectionName, "", ["metadata"], rowCount);
        const codebasePaths = new Set<string>();
        for (const row of rows) {
            const codebasePath = parseRowCodebasePath(row);
            if (codebasePath) {
                codebasePaths.add(codebasePath);
            }
        }

        return codebasePaths;
    } catch (error) {
        console.warn(`[${logPrefix}] Failed to query codebase paths for '${collectionName}':`, error);
        return null;
    }
}

export async function queryCollectionStats(
    context: CollectionStatsContext,
    codebasePath: string,
    logPrefix = "SNAPSHOT-RECOVERY"
): Promise<CollectionStats | null> {
    try {
        const statsContext = context as any;
        if (typeof statsContext.getCollectionName !== "function" || typeof statsContext.getVectorDatabase !== "function") {
            return null;
        }
        const collectionName = context.getCollectionName(codebasePath);
        const vectorDatabase = context.getVectorDatabase();
        if (typeof vectorDatabase?.getCollectionRowCount !== "function") {
            return null;
        }
        const rowCount = await vectorDatabase.getCollectionRowCount(collectionName);
        if (rowCount < 0) {
            console.warn(`[${logPrefix}] Row count unknown for '${codebasePath}', skipping snapshot stats update`);
            return null;
        }
        if (rowCount === 0) {
            console.warn(`[${logPrefix}] Collection '${collectionName}' is empty; skipping snapshot stats update`);
            return null;
        }

        const indexedStats = await queryIndexedFileCount(context, collectionName, codebasePath, rowCount, logPrefix);
        if (indexedStats) {
            return {
                indexedFiles: indexedStats.indexedFiles,
                totalChunks: indexedStats.totalChunks,
                statsSource: "collection_row_count",
            };
        }

        console.warn(`[${logPrefix}] No rows found for '${codebasePath}' in '${collectionName}', skipping snapshot stats update`);
        return null;
    } catch (error) {
        console.warn(`[${logPrefix}] Failed to query stats for '${codebasePath}':`, error);
        return null;
    }
}
