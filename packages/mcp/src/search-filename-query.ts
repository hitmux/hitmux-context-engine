import * as fs from "fs";
import * as path from "path";

const MAX_TREE_ENTRIES_TO_SCAN = 100_000;
const MAX_INDEX_ROWS_TO_SCAN = 10_000;
const SKIPPED_TREE_DIRS = new Set([".git", ".hg", ".svn", "node_modules"]);
const FILE_TOKEN_PATTERN = /(?:^|[\s"'`(<{\[])([A-Za-z0-9_.@+~-]+(?:[\\/][A-Za-z0-9_.@+~-]+)*\.[A-Za-z0-9][A-Za-z0-9_+-]{0,15})(?=$|[\s"'`),}\]>:;!?])/g;

interface QueryableVectorDatabase {
    query(collectionName: string, filter: string, outputFields: string[], limit?: number): Promise<Record<string, any>[]>;
}

export interface FilenameLikeQuery {
    raw: string;
    normalizedPath: string;
    basename: string;
    isPathLike: boolean;
}

export interface FilenameQueryStatus {
    query: FilenameLikeQuery;
    exactFileExistsInTree: boolean | undefined;
    exactFileExistsInIndex: boolean | undefined;
}

export async function analyzeFilenameLikeQuery(options: {
    query: string;
    codebasePath: string;
    getCollectionName: () => string;
    getVectorDatabase: () => QueryableVectorDatabase;
}): Promise<FilenameQueryStatus | null> {
    const filenameQuery = extractFilenameLikeQuery(options.query);
    if (!filenameQuery) {
        return null;
    }

    const exactFileExistsInTree = checkExactFileInTree(options.codebasePath, filenameQuery);
    const collectionName = options.getCollectionName();
    const exactFileExistsInIndex = await checkExactFileInIndex(options.getVectorDatabase(), collectionName, filenameQuery);

    return {
        query: filenameQuery,
        exactFileExistsInTree,
        exactFileExistsInIndex
    };
}

export function filenameQueryNeedsNotice(status: FilenameQueryStatus | null): boolean {
    if (!status) {
        return false;
    }

    return status.exactFileExistsInTree === false || status.exactFileExistsInIndex === false;
}

export function searchResultsAreFallbackMatches(status: FilenameQueryStatus | null): boolean {
    if (!status) {
        return false;
    }

    return status.exactFileExistsInTree === false || status.exactFileExistsInIndex === false;
}

export function formatFilenameQueryNotice(status: FilenameQueryStatus | null, hasSearchResults: boolean): string {
    if (!status || !filenameQueryNeedsNotice(status)) {
        return "";
    }

    const target = status.query.normalizedPath;
    const { exactFileExistsInTree, exactFileExistsInIndex } = status;
    const lines: string[] = [];

    if (exactFileExistsInTree === false && exactFileExistsInIndex === false) {
        lines.push(`Exact file not found: ${target}`);
    } else if (exactFileExistsInTree === false && exactFileExistsInIndex === true) {
        lines.push(`Exact file not found in the current file tree: ${target}`);
        lines.push("The existing index still contains this exact file name, so the index may be stale. Re-index may be needed.");
    } else if (exactFileExistsInTree === true && exactFileExistsInIndex === false) {
        lines.push(`Exact file exists in the current file tree but is missing from the index: ${target}`);
        lines.push("The index may be stale. Re-index may be needed.");
    } else if (exactFileExistsInTree === false) {
        lines.push(`Exact file not found in the current file tree: ${target}`);
    } else if (exactFileExistsInIndex === false) {
        lines.push(`Exact file not found in the current index: ${target}`);
        lines.push("The index may be stale. Re-index may be needed.");
    }

    if (hasSearchResults) {
        lines.push("Fallback matches: the results below are semantic/lexical matches, not confirmation that the requested file exists.");
    }

    return lines.join("\n");
}

function extractFilenameLikeQuery(query: string): FilenameLikeQuery | null {
    const matches: FilenameLikeQuery[] = [];
    let match: RegExpExecArray | null;

    FILE_TOKEN_PATTERN.lastIndex = 0;
    while ((match = FILE_TOKEN_PATTERN.exec(query)) !== null) {
        const raw = match[1];
        if (!raw) {
            continue;
        }

        const normalizedPath = normalizeQueryPath(raw);
        if (!isLikelyFileToken(normalizedPath)) {
            continue;
        }

        const basename = path.posix.basename(normalizedPath);
        const candidate: FilenameLikeQuery = {
            raw,
            normalizedPath,
            basename,
            isPathLike: normalizedPath.includes("/")
        };

        if (!matches.some((existing) => existing.normalizedPath === candidate.normalizedPath)) {
            matches.push(candidate);
        }
    }

    return matches.length === 1 ? matches[0] : null;
}

function normalizeQueryPath(value: string): string {
    return value
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "")
        .replace(/\/+/g, "/");
}

function isLikelyFileToken(normalizedPath: string): boolean {
    const basename = path.posix.basename(normalizedPath);
    if (basename.length === 0 || basename === "." || basename === "..") {
        return false;
    }

    if (/^\.[A-Za-z0-9_-]+$/.test(basename)) {
        return true;
    }

    const extension = path.posix.extname(basename);
    return extension.length >= 2 && extension.length <= 17 && /[A-Za-z0-9]/.test(extension.slice(1));
}

function checkExactFileInTree(codebasePath: string, query: FilenameLikeQuery): boolean | undefined {
    try {
        if (query.isPathLike) {
            const candidatePath = resolveInside(codebasePath, query.normalizedPath);
            return candidatePath ? isFile(candidatePath) : false;
        }

        return findFileByBasename(codebasePath, query.basename);
    } catch {
        return undefined;
    }
}

function resolveInside(rootPath: string, relativeQueryPath: string): string | null {
    const candidatePath = path.resolve(rootPath, relativeQueryPath);
    const relativePath = path.relative(rootPath, candidatePath);
    if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return null;
    }

    return candidatePath;
}

function isFile(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function findFileByBasename(rootPath: string, basename: string): boolean | undefined {
    const stack = [rootPath];
    let visitedEntries = 0;

    while (stack.length > 0) {
        const currentPath = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentPath, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            visitedEntries += 1;
            if (visitedEntries > MAX_TREE_ENTRIES_TO_SCAN) {
                return undefined;
            }

            if (entry.isFile() && entry.name === basename) {
                return true;
            }

            if (entry.isDirectory() && !SKIPPED_TREE_DIRS.has(entry.name)) {
                stack.push(path.join(currentPath, entry.name));
            }
        }
    }

    return false;
}

async function checkExactFileInIndex(
    vectorDatabase: QueryableVectorDatabase,
    collectionName: string,
    query: FilenameLikeQuery
): Promise<boolean | undefined> {
    const filterTerm = escapeFilterString(query.isPathLike ? query.normalizedPath : query.basename);
    try {
        const rows = await vectorDatabase.query(
            collectionName,
            `relativePath like "%${filterTerm}%"`,
            ["relativePath"],
            MAX_INDEX_ROWS_TO_SCAN
        );

        return rows.some((row) => {
            if (typeof row.relativePath !== "string" || row.relativePath.length === 0) {
                return false;
            }

            const indexedPath = normalizeQueryPath(row.relativePath);
            if (query.isPathLike) {
                return indexedPath === query.normalizedPath;
            }

            return path.posix.basename(indexedPath) === query.basename;
        });
    } catch (error) {
        console.warn(`[SEARCH] Failed to check exact filename query in index '${collectionName}':`, error);
        return undefined;
    }
}

function escapeFilterString(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
