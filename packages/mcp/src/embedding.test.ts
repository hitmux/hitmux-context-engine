import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmbeddingInstance } from "./embedding.js";
import type { ContextMcpConfig } from "./config.js";

const baseConfig: ContextMcpConfig = {
    name: "test",
    version: "0.0.0",
    embeddingProvider: "OpenRouter",
    embeddingModel: "qwen/qwen3-embedding-4b",
    openrouterApiKey: "test-openrouter-key",
    embeddingUseSystemProxy: false,
    databaseUseSystemProxy: false,
};

test("OpenRouter embedding declares app attribution headers", () => {
    const embedding = createEmbeddingInstance(baseConfig);
    const delegate = (embedding as unknown as { delegate: { getClient: () => unknown } }).delegate;
    const client = delegate.getClient() as { _options?: { defaultHeaders?: Record<string, string> } };

    assert.deepEqual(client._options?.defaultHeaders, {
        "X-Hitmux-Client": "Hitmux Context Engine",
        "HTTP-Referer": "https://github.com/hitmux/hitmux-context-engine",
        "X-OpenRouter-Title": "Hitmux Context Engine",
    });
});

test("OpenAI-compatible embedding declares the Hitmux client name", () => {
    const embedding = createEmbeddingInstance({
        ...baseConfig,
        embeddingProvider: "OpenAI",
        openrouterApiKey: undefined,
        openaiApiKey: "test-openai-key",
        openaiBaseUrl: "https://provider.example/v1",
    });
    const delegate = (embedding as unknown as { delegate: { getClient: () => unknown } }).delegate;
    const client = delegate.getClient() as { _options?: { defaultHeaders?: Record<string, string> } };

    assert.deepEqual(client._options?.defaultHeaders, {
        "X-Hitmux-Client": "Hitmux Context Engine",
    });
});
