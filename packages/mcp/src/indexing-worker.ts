import { parentPort, threadId, workerData } from "node:worker_threads";

console.log = (...args: any[]) => {
    process.stderr.write("[INDEX-WORKER] " + args.join(" ") + "\n");
};

console.warn = (...args: any[]) => {
    process.stderr.write("[INDEX-WORKER-WARN] " + args.join(" ") + "\n");
};

import {
    IndexAbortError,
    applySystemProxyPolicy,
} from "@hitmux/hitmux-context-engine-core";

import { createMcpConfig } from "./config.js";
import { createRequestSplitter } from "./splitter.js";
import { createRuntimeContext } from "./runtime-context.js";
import type { IndexingWorkerRequest } from "./indexing-worker-runner.js";

if (!parentPort) {
    throw new Error("indexing-worker must be started as a worker thread");
}
const port = parentPort;

applySystemProxyPolicy(false);

const request = workerData as IndexingWorkerRequest;
const controller = new AbortController();

port.on("message", (message: { type?: string }) => {
    if (message?.type === "cancel") {
        controller.abort();
    }
});

port.postMessage({ type: "ready", threadId });

void runWorker();

function postTerminalMessage(message: Record<string, unknown>): void {
    port.postMessage(message);
    port.close();
}

async function runWorker(): Promise<void> {
    try {
        const config = createMcpConfig(request.serverVersion);
        const context = createRuntimeContext(config);
        const requestSplitter = createRequestSplitter(request.splitterType);

        const stats = await context.indexCodebase(
            request.codebasePath,
            (progress) => {
                port.postMessage({ type: "progress", progress });
            },
            false,
            request.customIgnorePatterns,
            request.customFileExtensions,
            requestSplitter,
            controller.signal,
            {
                additionalIgnoreFiles: request.customIgnoreFiles,
                maxDepth: request.requestMaxDepth,
            },
        );

        postTerminalMessage({ type: "completed", stats });
    } catch (error: any) {
        if (error instanceof IndexAbortError || controller.signal.aborted) {
            postTerminalMessage({
                type: "cancelled",
                errorMessage: error?.message || "Indexing was cancelled",
            });
        } else {
            postTerminalMessage({
                type: "failed",
                errorMessage: error?.message || String(error),
            });
        }
    }
}
