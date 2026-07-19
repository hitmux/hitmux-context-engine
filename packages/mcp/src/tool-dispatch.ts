import type { ToolHandlers } from "./handlers.js";
import type { SyncManager } from "./sync.js";

type ToolDispatchRuntime = {
    syncManager: Pick<SyncManager, "startBackgroundSync">;
    toolHandlers: Pick<
        ToolHandlers,
        | "handleIndexCodebase"
        | "handleSearchContext"
        | "handleClearIndex"
        | "handleGetIndexingStatus"
        | "handleRepairIndexManifest"
    >;
    backgroundSyncStarted: boolean;
};

const MANUAL_WRITE_TOOL_NAMES = new Set([
    "index_codebase",
    "clear_index",
    "repair_index_manifest",
]);

export function shouldStartBackgroundSyncBeforeTool(toolName: string): boolean {
    return !MANUAL_WRITE_TOOL_NAMES.has(toolName);
}

export function startBackgroundSyncOnce(runtime: ToolDispatchRuntime): void {
    if (runtime.backgroundSyncStarted) {
        return;
    }

    console.log(
        "[SYNC-DEBUG] Initializing background sync after first successful runtime initialization...",
    );
    runtime.syncManager.startBackgroundSync();
    runtime.backgroundSyncStarted = true;
}

function removeSearchContextLimit(args: unknown): unknown {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return args;
    }

    const { limit: _limit, ...searchContextArgs } = args as Record<string, unknown>;
    return searchContextArgs;
}

export async function dispatchMcpTool(
    runtime: ToolDispatchRuntime,
    name: string,
    args: unknown,
    formatUnknownTool: (name: string) => unknown,
): Promise<unknown> {
    const startBeforeDispatch = shouldStartBackgroundSyncBeforeTool(name);
    if (startBeforeDispatch) {
        startBackgroundSyncOnce(runtime);
    }

    try {
        switch (name) {
            case "index_codebase":
                return await runtime.toolHandlers.handleIndexCodebase(args);
            case "search_context":
                return await runtime.toolHandlers.handleSearchContext(
                    removeSearchContextLimit(args),
                );
            case "clear_index":
                return await runtime.toolHandlers.handleClearIndex(args);
            case "get_indexing_status":
                return await runtime.toolHandlers.handleGetIndexingStatus(args);
            case "repair_index_manifest":
                return await runtime.toolHandlers.handleRepairIndexManifest(args);
            default:
                return formatUnknownTool(name);
        }
    } finally {
        if (!startBeforeDispatch) {
            startBackgroundSyncOnce(runtime);
        }
    }
}
