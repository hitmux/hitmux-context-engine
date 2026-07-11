import { resolve } from "node:path";

export const CURRENT_DIRECTORY_NOT_INDEXED_NOTICE =
    "The current working directory is not indexed; use index_codebase with its absolute path to create an index.";

export const UNINDEXED_TOOL_DETAIL_DESCRIPTION =
    "The current working directory is not indexed; call tool_detail only when you need the complete index_codebase parameters.";

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
