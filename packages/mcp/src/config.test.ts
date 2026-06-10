import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMcpConfig } from "./config.js";

async function withTempConfig(
    configs: { global?: Record<string, unknown>; project?: Record<string, unknown> },
    run: () => void
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
        run();
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
    await writeFile(path.join(configDir, "config.jsonc"), `// test config\n${JSON.stringify(config, null, 4)}\n`, "utf-8");
}

test("createMcpConfig defaults to OpenRouter qwen embeddings", async () => {
    await withTempConfig({}, () => {
        const config = createMcpConfig();

        assert.equal(config.embeddingProvider, "OpenRouter");
        assert.equal(config.embeddingModel, "qwen/qwen3-embedding-4b");
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
