import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configManager } from "@hitmux/hitmux-context-engine-core";
import { createMcpConfig } from "./config.js";

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
        const config = createMcpConfig();

        assert.equal(config.embeddingProvider, "OpenRouter");
        assert.equal(config.embeddingModel, "qwen/qwen3-embedding-4b");
        assert.equal(config.embeddingUseSystemProxy, false);
        assert.equal(config.databaseUseSystemProxy, false);
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
        assert.match(content, /embeddingProvider = OpenRouter/);
        assert.match(content, /embeddingModel = qwen\/qwen3-embedding-4b/);
        assert.doesNotMatch(content, /\nembeddingBatchSize = /);
        assert.doesNotMatch(content, /\nembeddingConcurrency = /);
        assert.match(content, /# embeddingBatchSize = 32/);
        assert.match(content, /# embeddingConcurrency = 4/);
        assert.match(content, /# openrouterApiKey = sk-or-your-openrouter-api-key/);
        assert.match(content, /milvusAddress = localhost:19530/);
        assert.match(content, /embeddingUseSystemProxy = false/);
        assert.match(content, /databaseUseSystemProxy = false/);
        assert.match(content, /# automaticIncrementalEffectiveLineLimit = 5000/);
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
        assert.ok(!result.appendedKeys.includes("embeddingProvider"));
        assert.ok(!result.appendedKeys.includes("milvusAddress"));
        assert.ok(!result.appendedKeys.includes("customExtensions"));
        assert.doesNotMatch(content, /# Missing optional fields added as comments\./);
        assert.match(content, /# Hitmux Context Engine global configuration\./);
        assert.match(content, /# Default embedding provider\.\nembeddingProvider = OpenAI # keep inline comment\nembeddingModel = qwen\/qwen3-embedding-4b\nfileProcessingConcurrency = 2/);
        assert.match(content, /# Local Milvus default\. Change this for remote Milvus or Zilliz Cloud\.\n# milvusAddress = remote\.example:19530\n# milvusToken = your-milvus-or-zilliz-token/);
        assert.match(content, /embeddingModel = qwen\/qwen3-embedding-4b\nfileProcessingConcurrency = 2\n# openrouterApiKey = sk-or-your-openrouter-api-key/);
        assert.match(content, /# Embedding batch size for index operations\.\n# embeddingBatchSize = 32/);
        assert.match(content, /# Embedding request concurrency for index operations\.\n# embeddingConcurrency = 4/);
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
