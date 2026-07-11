import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configManager } from "@hitmux/hitmux-context-engine-core";
import {
    createMcpConfig,
    getEmbeddingApiKeyForRerank,
    getEmbeddingBaseUrlForRerank,
} from "./config.js";

async function withTempConfig(
    configs: { global?: Record<string, unknown>; project?: Record<string, unknown> },
    run: () => void | Promise<void>
): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hitmux-context-engine-config-test-"));
    const homeDir = path.join(tempRoot, "home");
    const projectDir = path.join(tempRoot, "project");
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalCwd = process.cwd();

    await mkdir(homeDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(projectDir);

    if (configs.global) {
        await writeConfig(homeDir, configs.global);
    }
    if (configs.project) {
        await writeConfig(projectDir, configs.project);
    }

    try {
        await run();
    } finally {
        process.chdir(originalCwd);
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        if (originalUserProfile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = originalUserProfile;
        }
        await rm(tempRoot, { recursive: true, force: true });
    }
}

async function writeConfig(rootDir: string, config: Record<string, unknown>): Promise<void> {
    const configDir = path.join(rootDir, ".hitmux-context-engine");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "config.conf"), `# test config\n${stringifyConf(config)}`, "utf-8");
}

function stringifyConf(config: Record<string, unknown>): string {
    return Object.entries(config)
        .flatMap(([key, value]) => Array.isArray(value)
            ? value.map(item => `${key} = ${String(item)}`)
            : [`${key} = ${String(value)}`])
        .join("\n") + "\n";
}

test("createMcpConfig defaults to OpenRouter qwen embeddings", async () => {
    await withTempConfig({}, () => {
        const config = createMcpConfig("0.1.24");

        assert.equal(config.version, "0.1.24");
        assert.equal(config.embeddingProvider, "OpenRouter");
        assert.equal(config.embeddingModel, "qwen/qwen3-embedding-4b");
        assert.equal(config.embeddingUseSystemProxy, false);
        assert.equal(config.databaseUseSystemProxy, false);
        assert.equal(config.rerankEnabled, true);
        assert.equal(config.rerankModel, "cohere/rerank-4-fast");
        assert.equal(config.rerankCandidateLimit, 100);
        assert.equal(config.rerankTimeoutMs, 8000);
        assert.equal(config.rerankMaxCharsPerDocument, 6000);
        assert.equal(config.rerankUseSystemProxy, false);
    });
});

test("createMcpConfig lets configured MCP server version override package version", async () => {
    await withTempConfig({
        project: {
            mcpServerVersion: "custom-version"
        }
    }, () => {
        const config = createMcpConfig("0.1.24");

        assert.equal(config.version, "custom-version");
    });
});

test("ensureGlobalConfigFile creates a commented default global config", async () => {
    await withTempConfig({}, async () => {
        const result = configManager.ensureGlobalConfigFile();
        const content = await readFile(result.path, "utf-8");

        assert.equal(result.created, true);
        assert.match(result.path, /\.hitmux-context-engine[/\\]config\.conf$/);
        assert.match(content, /# Hitmux Context Engine global configuration\./);
        assert.match(content, /# Project config at \.\/\.hitmux-context-engine\/config\.conf overrides matching fields\./);
        assert.match(content, /# Basic configuration: set these fields first to make the service usable\./);
        assert.match(content, /# Advanced configuration: tune these only when you need custom behavior\./);
        assert.match(content, /embeddingProvider = OpenRouter/);
        assert.match(content, /embeddingModel = qwen\/qwen3-embedding-4b/);
        assert.match(content, /fileProcessingConcurrency = 2/);
        assert.doesNotMatch(content, /\nembeddingBatchSize = /);
        assert.doesNotMatch(content, /\nembeddingConcurrency = /);
        assert.match(content, /# embeddingBatchSize = 64/);
        assert.match(content, /# embeddingConcurrency = 2/);
        assert.match(content, /# rerankEnabled = true/);
        assert.match(content, /# rerankModel = cohere\/rerank-4-fast/);
        assert.match(content, /# rerankCandidateLimit = 100/);
        assert.match(content, /# rerankTimeoutMs = 8000/);
        assert.match(content, /# rerankMaxCharsPerDocument = 6000/);
        assert.match(content, /# rerankUseSystemProxy = false/);
        assert.match(content, /# openrouterApiKey = sk-or-your-openrouter-api-key/);
        assert.match(content, /milvusAddress = localhost:19530/);
        assert.match(content, /embeddingUseSystemProxy = false/);
        assert.match(content, /databaseUseSystemProxy = false/);
        assert.match(content, /# automaticIncrementalEffectiveLineLimit = 5000/);
        assert.match(content, /restrictToolsWhenUnindexed = true/);
        assert.match(content, /projectWatcher = true/);
        assert.match(content, /projectWatcherDebounceMs = 1000/);
        assert.match(content, /projectWatcherUsePolling = false/);
        assert.match(content, /projectWatcherFallbackScanIntervalMs = 600000/);

        const secondResult = configManager.ensureGlobalConfigFile();
        assert.deepEqual(secondResult, {
            path: result.path,
            created: false,
            updated: false,
            appendedKeys: []
        });
    });
});

test("ensureGlobalConfigFile completes existing config using the default template format", async () => {
    await withTempConfig({}, async () => {
        const configPath = configManager.getGlobalConfigFilePath();
        await mkdir(path.dirname(configPath), { recursive: true });
        await writeFile(configPath, [
            "# existing config",
            "embeddingProvider = OpenAI # keep inline comment",
            "# milvusAddress = remote.example:19530",
            "customExtensions = .vue",
            "customExtensions = .svelte",
            "futureOption = keep-me",
            ""
        ].join("\n"), "utf-8");

        const result = configManager.ensureGlobalConfigFile();
        const content = await readFile(configPath, "utf-8");

        assert.equal(result.created, false);
        assert.equal(result.updated, true);
        assert.ok(result.appendedKeys.includes("embeddingModel"));
        assert.ok(result.appendedKeys.includes("embeddingBatchSize"));
        assert.ok(result.appendedKeys.includes("embeddingConcurrency"));
        assert.ok(result.appendedKeys.includes("openrouterApiKey"));
        assert.ok(result.appendedKeys.includes("rerankEnabled"));
        assert.ok(result.appendedKeys.includes("rerankModel"));
        assert.ok(result.appendedKeys.includes("rerankCandidateLimit"));
        assert.ok(result.appendedKeys.includes("restrictToolsWhenUnindexed"));
        assert.ok(!result.appendedKeys.includes("embeddingProvider"));
        assert.ok(!result.appendedKeys.includes("milvusAddress"));
        assert.ok(!result.appendedKeys.includes("customExtensions"));
        assert.doesNotMatch(content, /# Missing optional fields added as comments\./);
        assert.match(content, /# Hitmux Context Engine global configuration\./);
        assert.match(content, /# Basic configuration: set these fields first to make the service usable\./);
        assert.match(content, /# Advanced configuration: tune these only when you need custom behavior\./);
        assert.match(content, /# Default embedding provider\.\nembeddingProvider = OpenAI # keep inline comment\nembeddingModel = qwen\/qwen3-embedding-4b\n# openrouterApiKey = sk-or-your-openrouter-api-key/);
        assert.match(content, /# Local Milvus default\. Change this for remote Milvus or Zilliz Cloud\.\n# milvusAddress = remote\.example:19530\n# milvusToken = your-milvus-or-zilliz-token/);
        assert.match(content, /# Index worker defaults\.\nfileProcessingConcurrency = 2/);
        assert.match(content, /# Embedding batch size for index operations\.\n# embeddingBatchSize = 64/);
        assert.match(content, /# Embedding request concurrency for index operations\.\n# embeddingConcurrency = 2/);
        assert.match(content, /# Enable external rerank after initial search recall\.\n# rerankEnabled = true/);
        assert.match(content, /# External rerank model name\.\n# rerankModel = cohere\/rerank-4-fast/);
        assert.match(content, /# Maximum candidates sent to external rerank, capped at 100\.\n# rerankCandidateLimit = 100/);
        assert.match(content, /# Effective-line growth limit before automatic incremental sync pauses for manual review\.\n# automaticIncrementalEffectiveLineLimit = 5000/);
        assert.match(content, /# Background sync defaults\.\nbackgroundSync = true\ntriggerWatcher = true\nprojectWatcher = true\nprojectWatcherDebounceMs = 1000\nprojectWatcherUsePolling = false\nprojectWatcherFallbackScanIntervalMs = 600000/);
        assert.match(content, /# Additional file extensions to index; repeat the field for multiple values\.\ncustomExtensions = \.vue\ncustomExtensions = \.svelte/);
        assert.match(content, /# Existing fields not present in the current default template\.\nfutureOption = keep-me/);

        const secondResult = configManager.ensureGlobalConfigFile();
        assert.equal(secondResult.updated, false);
        assert.deepEqual(secondResult.appendedKeys, []);
    });
});

test("createMcpConfig reads independent proxy toggles", async () => {
    await withTempConfig({
        project: {
            embeddingUseSystemProxy: true,
            databaseUseSystemProxy: true
        }
    }, () => {
        const config = createMcpConfig();

        assert.equal(config.embeddingUseSystemProxy, true);
        assert.equal(config.databaseUseSystemProxy, true);
    });
});

test("createMcpConfig reads rerank fields without exposing API key values", async () => {
    await withTempConfig({
        project: {
            embeddingUseSystemProxy: true,
            rerankEnabled: true,
            rerankModel: "cohere/rerank-4-pro",
            rerankBaseUrl: "https://api.cohere.com/v2/",
            rerankApiKey: "co-secret",
            rerankCandidateLimit: 120,
            rerankTimeoutMs: 9000,
            rerankMaxCharsPerDocument: 7000
        }
    }, () => {
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]) => {
            logs.push(args.map(String).join(" "));
        };
        try {
            const config = createMcpConfig();

            assert.equal(config.rerankEnabled, true);
            assert.equal(config.rerankModel, "cohere/rerank-4-pro");
            assert.equal(config.rerankBaseUrl, "https://api.cohere.com/v2");
            assert.equal(config.rerankApiKey, "co-secret");
            assert.equal(config.rerankCandidateLimit, 120);
            assert.equal(config.rerankTimeoutMs, 9000);
            assert.equal(config.rerankMaxCharsPerDocument, 7000);
            assert.equal(config.rerankUseSystemProxy, true);
            assert.match(logs.join("\n"), /rerankApiKey: Configured/);
            assert.doesNotMatch(logs.join("\n"), /co-secret|length: 9/);
        } finally {
            console.log = originalLog;
        }
    });
});

test("rerank inherits the active embedding provider key for non-OpenRouter providers", () => {
    const voyageConfig = {
        embeddingProvider: "VoyageAI" as const,
        openaiApiKey: "sk-openai",
        voyageaiApiKey: "pa-voyage",
        geminiApiKey: "gemini-key",
        openrouterApiKey: "sk-or",
    };
    const geminiConfig = {
        embeddingProvider: "Gemini" as const,
        openaiBaseUrl: "https://openai.example.com/v1",
        geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
        openaiApiKey: "sk-openai",
        voyageaiApiKey: "pa-voyage",
        geminiApiKey: "gemini-key",
        openrouterApiKey: "sk-or",
    };

    assert.equal(getEmbeddingApiKeyForRerank(voyageConfig), "pa-voyage");
    assert.equal(getEmbeddingApiKeyForRerank(geminiConfig), "gemini-key");
    assert.equal(getEmbeddingBaseUrlForRerank(geminiConfig), "https://generativelanguage.googleapis.com/v1beta");
});

test("createMcpConfig accepts OpenAI-compatible base URL from config", async () => {
    await withTempConfig({
        project: {
            openaiBaseUrl: "https://embeddings.example.com/v1/"
        }
    }, () => {
        const config = createMcpConfig();

        assert.equal(config.openaiBaseUrl, "https://embeddings.example.com/v1");
    });
});

test("createMcpConfig ignores invalid OpenAI-compatible base URLs", async () => {
    await withTempConfig({
        project: {
            openaiBaseUrl: "not-a-url"
        }
    }, () => {
        const config = createMcpConfig();

        assert.equal(config.openaiBaseUrl, undefined);
    });
});

test("project config overrides global config", async () => {
    await withTempConfig({
        global: {
            embeddingProvider: "OpenAI",
            embeddingModel: "text-embedding-3-small"
        },
        project: {
            embeddingProvider: "OpenRouter",
            embeddingModel: "qwen/qwen3-embedding-4b"
        }
    }, () => {
        const config = createMcpConfig();

        assert.equal(config.embeddingProvider, "OpenRouter");
        assert.equal(config.embeddingModel, "qwen/qwen3-embedding-4b");
    });
});
