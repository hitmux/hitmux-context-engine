import assert from "node:assert/strict";
import test from "node:test";

import { dispatchMcpTool } from "./tool-dispatch.js";

function createRuntime() {
    const calls: string[] = [];
    const searchContextArgs: unknown[] = [];
    const runtime = {
        backgroundSyncStarted: false,
        syncManager: {
            startBackgroundSync: () => {
                calls.push("startBackgroundSync");
            },
        },
        toolHandlers: {
            handleIndexCodebase: async () => {
                calls.push("handleIndexCodebase");
                return { content: [{ type: "text", text: "indexed" }] };
            },
            handleSearchContext: async (args: unknown) => {
                calls.push("handleSearchContext");
                searchContextArgs.push(args);
                return { content: [{ type: "text", text: "searched" }] };
            },
            handleClearIndex: async () => {
                calls.push("handleClearIndex");
                return { content: [{ type: "text", text: "cleared" }] };
            },
            handleGetIndexingStatus: async () => {
                calls.push("handleGetIndexingStatus");
                return { content: [{ type: "text", text: "status" }] };
            },
            handleRepairIndexManifest: async () => {
                calls.push("handleRepairIndexManifest");
                return { content: [{ type: "text", text: "repaired" }] };
            },
        },
    };
    return { calls, runtime, searchContextArgs };
}

test("first index_codebase dispatch starts background sync after the handler", async () => {
    const { calls, runtime } = createRuntime();

    await dispatchMcpTool(
        runtime,
        "index_codebase",
        { path: "/repo" },
        (name) => ({ isError: true, content: [{ type: "text", text: name }] }),
    );

    assert.deepEqual(calls, ["handleIndexCodebase", "startBackgroundSync"]);
    assert.equal(runtime.backgroundSyncStarted, true);
});

test("first clear_index dispatch starts background sync after the handler", async () => {
    const { calls, runtime } = createRuntime();

    await dispatchMcpTool(
        runtime,
        "clear_index",
        { path: "/repo" },
        (name) => ({ isError: true, content: [{ type: "text", text: name }] }),
    );

    assert.deepEqual(calls, ["handleClearIndex", "startBackgroundSync"]);
    assert.equal(runtime.backgroundSyncStarted, true);
});

test("first repair_index_manifest dispatch starts background sync after the handler", async () => {
    const { calls, runtime } = createRuntime();

    await dispatchMcpTool(
        runtime,
        "repair_index_manifest",
        { path: "/repo" },
        (name) => ({ isError: true, content: [{ type: "text", text: name }] }),
    );

    assert.deepEqual(calls, [
        "handleRepairIndexManifest",
        "startBackgroundSync",
    ]);
    assert.equal(runtime.backgroundSyncStarted, true);
});

test("first search_context dispatch starts background sync before the handler", async () => {
    const { calls, runtime } = createRuntime();

    await dispatchMcpTool(
        runtime,
        "search_context",
        { path: "/repo", query: "search terms" },
        (name) => ({ isError: true, content: [{ type: "text", text: name }] }),
    );

    assert.deepEqual(calls, ["startBackgroundSync", "handleSearchContext"]);
    assert.equal(runtime.backgroundSyncStarted, true);
});

test("search_context dispatch removes manual limit so MCP always uses automatic TopK", async () => {
    const { runtime, searchContextArgs } = createRuntime();

    await dispatchMcpTool(
        runtime,
        "search_context",
        { path: "/repo", query: "search terms", limit: 3 },
        (name) => ({ isError: true, content: [{ type: "text", text: name }] }),
    );

    assert.deepEqual(searchContextArgs, [{ path: "/repo", query: "search terms" }]);
});

test("first get_indexing_status dispatch starts background sync before the handler", async () => {
    const { calls, runtime } = createRuntime();

    await dispatchMcpTool(
        runtime,
        "get_indexing_status",
        { path: "/repo" },
        (name) => ({ isError: true, content: [{ type: "text", text: name }] }),
    );

    assert.deepEqual(calls, [
        "startBackgroundSync",
        "handleGetIndexingStatus",
    ]);
    assert.equal(runtime.backgroundSyncStarted, true);
});

test("background sync starts only once across dispatches", async () => {
    const { calls, runtime } = createRuntime();

    await dispatchMcpTool(
        runtime,
        "search_context",
        { path: "/repo", query: "search terms" },
        (name) => ({ isError: true, content: [{ type: "text", text: name }] }),
    );
    await dispatchMcpTool(
        runtime,
        "index_codebase",
        { path: "/repo" },
        (name) => ({ isError: true, content: [{ type: "text", text: name }] }),
    );

    assert.deepEqual(calls, [
        "startBackgroundSync",
        "handleSearchContext",
        "handleIndexCodebase",
    ]);
    assert.equal(runtime.backgroundSyncStarted, true);
});
