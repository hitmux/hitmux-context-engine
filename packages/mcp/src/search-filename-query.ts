import * as fs from "fs";
import * as path from "path";

const FILE_TOKEN_PATTERN = /(?:^|[\s"'`(<{\[])([A-Za-z0-9_.@+~-]+(?:[\\/][A-Za-z0-9_.@+~-]+)*\.[A-Za-z0-9][A-Za-z0-9_+-]{0,15})(?=$|[\s"'`),}\]>:;!?])/g;
const MAX_EXACT_BASENAME_INDEX_ROWS = 20;

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
    indexVerificationWarning?: string;
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

    const collectionName = options.getCollectionName();
    const indexStatus = await checkExactFileInIndex(options.getVectorDatabase(), collectionName, filenameQuery);
    const exactFileExistsInTree = checkExactFileInTree(
        options.codebasePath,
        filenameQuery,
        indexStatus.exactRelativePaths
    );

    return {
        query: filenameQuery,
        exactFileExistsInTree,
        exactFileExistsInIndex: indexStatus.exists,
        ...(indexStatus.warning ? { indexVerificationWarning: indexStatus.warning } : {})
    };
}

export function filenameQueryNeedsNotice(status: FilenameQueryStatus | null): boolean {
    if (!status) {
        return false;
    }

    return status.exactFileExistsInTree === false
        || status.exactFileExistsInIndex === false
        || typeof status.indexVerificationWarning === "string";
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
    if (status.indexVerificationWarning) {
        lines.push(status.indexVerificationWarning);
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

    if (matches.length !== 1) {
        return null;
    }

    return isStandaloneFilenameLikeQuery(query, matches[0].normalizedPath) ? matches[0] : null;
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

function isStandaloneFilenameLikeQuery(query: string, normalizedPath: string): boolean {
    const trimmedQuery = query
        .trim()
        .replace(/^[\s"'`(<{\[]+/, "")
        .replace(/[\s"'`),}\]>:;!?]+$/, "");
    return normalizeQueryPath(trimmedQuery) === normalizedPath;
}

function checkExactFileInTree(
    codebasePath: string,
    query: FilenameLikeQuery,
    exactIndexedRelativePaths: string[] = []
): boolean | undefined {
    try {
        const relativePaths = query.isPathLike ? [query.normalizedPath] : exactIndexedRelativePaths;
        if (relativePaths.length === 0) return undefined;
        return relativePaths.some((relativePath) => {
            const candidatePath = resolveInside(codebasePath, relativePath);
            return candidatePath ? isFile(candidatePath) : false;
        });
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

async function checkExactFileInIndex(
    vectorDatabase: QueryableVectorDatabase,
    collectionName: string,
    query: FilenameLikeQuery
): Promise<{ exists: boolean | undefined; exactRelativePaths: string[]; warning?: string }> {
    const filter = buildExactIndexFilter(query);
    try {
        const rows = await vectorDatabase.query(
            collectionName,
            filter,
            ["relativePath"],
            query.isPathLike ? 1 : MAX_EXACT_BASENAME_INDEX_ROWS
        );

        const exactRelativePaths: string[] = [];
        const exists = rows.some((row) => {
            if (typeof row.relativePath !== "string" || row.relativePath.length === 0) {
                return false;
            }

            const indexedPath = normalizeQueryPath(row.relativePath);
            if (query.isPathLike) {
                if (indexedPath === query.normalizedPath) {
                    exactRelativePaths.push(indexedPath);
                    return true;
                }
                return false;
            }

            if (path.posix.basename(indexedPath) === query.basename) {
                exactRelativePaths.push(indexedPath);
                return true;
            }
            return false;
        });

        return {
            exists,
            exactRelativePaths
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`[SEARCH] Failed to check exact filename query in index '${collectionName}': ${errorMessage}`);
        if (isMissingStructuredFieldError(error)) {
            return {
                exists: undefined,
                exactRelativePaths: [],
                warning: "Exact filename verification is unavailable for this index schema. Re-index may be needed."
            };
        }
        return { exists: undefined, exactRelativePaths: [] };
    }
}

function buildExactIndexFilter(query: FilenameLikeQuery): string {
    if (query.isPathLike) {
        return `relativePath == "${escapeFilterString(query.normalizedPath)}"`;
    }

    return buildBasenameExactFilter(query.basename);
}

function buildBasenameExactFilter(fileName: string): string {
    const extension = path.posix.extname(fileName);
    const basename = path.posix.basename(fileName, extension);
    return `basename == "${escapeFilterString(basename)}" and fileExtension == "${escapeFilterString(extension)}"`;
}

function isMissingStructuredFieldError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /field|schema|output|not.*exist|not.*found|cannot.*find|undefined/i.test(message)
        && /\b(?:basename|fileExtension|relativePath)\b/.test(message);
}

function escapeFilterString(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
