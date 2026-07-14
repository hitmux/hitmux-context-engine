import { resolve } from "node:path";

export const CURRENT_DIRECTORY_NOT_INDEXED_NOTICE =
    "Current working directory is not indexed; use index_codebase with its absolute path to create an index.";

export const CURRENT_DIRECTORY_INDEXED_NOTICE =
    "Current working directory is indexed; use the available tools directly.";

export const UNINDEXED_TOOL_LIST_NOTICE =
    "Current working directory is not indexed; create an index only when the user explicitly requests it.";

export const UNINDEXED_TOOL_DETAIL_DESCRIPTION =
    `${UNINDEXED_TOOL_LIST_NOTICE} Call tool_detail only for complete index_codebase parameters.`;

interface IndexedCodebaseLookup {
    findIndexedCodebasePath(codebasePath: string): string | undefined;
}

export function getCurrentDirectoryIndexNotice(
    snapshotManager: IndexedCodebaseLookup,
    currentDirectory = process.cwd(),
): string | undefined {
    const currentDirectoryPath = resolve(currentDirectory);
    return snapshotManager.findIndexedCodebasePath(currentDirectoryPath)
        ? undefined
        : CURRENT_DIRECTORY_NOT_INDEXED_NOTICE;
}

export function prependStartupIndexNotice(
    description: string,
    notice: string | undefined,
): string {
    return notice ? `${notice}\n\n${description.trimStart()}` : description;
}
