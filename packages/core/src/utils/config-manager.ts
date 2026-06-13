import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type EmbeddingProviderName = 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama' | 'OpenRouter';

export interface HitmuxConfig {
    mcpServerName?: string;
    mcpServerVersion?: string;
    embeddingProvider?: EmbeddingProviderName;
    embeddingModel?: string;
    embeddingBatchSize?: number;
    embeddingConcurrency?: number;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    voyageaiApiKey?: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openrouterApiKey?: string;
    ollamaModel?: string;
    ollamaHost?: string;
    milvusAddress?: string;
    milvusToken?: string;
    milvusUseRestful?: boolean;
    milvusCollectionLimitCheckTimeoutMs?: number;
    zillizBaseUrl?: string;
    collectionNameOverride?: string;
    codebaseIdentityMode?: 'path' | 'gitRemote' | 'global' | 'custom';
    codebaseIdentity?: string;
    globalCollectionName?: string;
    gitRemoteName?: string;
    hybridMode?: boolean;
    searchTimeoutMs?: number;
    customExtensions?: string[];
    customIgnorePatterns?: string[];
    merkleSnapshotMaxBytes?: number;
    autoIndexing?: boolean;
    interactiveIndexing?: boolean;
    backgroundSync?: boolean;
    syncIntervalMs?: number;
    syncLockStaleMs?: number;
    triggerWatcher?: boolean;
    splitterType?: string;
    searchTopK?: number;
    searchThreshold?: number;
}

export type HitmuxConfigKey = keyof HitmuxConfig;

export interface ConfigReadError {
    path: string;
    message: string;
}

export class ConfigManager {
    getConfigFilePath(): string {
        return this.getGlobalConfigFilePath();
    }

    getGlobalConfigFilePath(): string {
        return path.join(os.homedir(), '.hitmux-context-engine', 'config.jsonc');
    }

    getProjectConfigFilePath(projectRoot: string = process.cwd()): string {
        return path.join(projectRoot, '.hitmux-context-engine', 'config.jsonc');
    }

    getAll(): HitmuxConfig {
        return {
            ...this.readConfigFile(this.getGlobalConfigFilePath()),
            ...this.readConfigFile(this.getProjectConfigFilePath())
        };
    }

    getReadErrors(projectRoot: string = process.cwd()): ConfigReadError[] {
        return [
            this.validateConfigFile(this.getGlobalConfigFilePath()),
            this.validateConfigFile(this.getProjectConfigFilePath(projectRoot))
        ].filter((error): error is ConfigReadError => error !== null);
    }

    private validateConfigFile(configPath: string): ConfigReadError | null {
        try {
            if (!fs.existsSync(configPath)) {
                return null;
            }

            const content = fs.readFileSync(configPath, 'utf-8').trim();
            if (!content) {
                return null;
            }

            const parsed = JSON.parse(stripJsonComments(content));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {
                    path: configPath,
                    message: 'expected a JSON object'
                };
            }

            return null;
        } catch (error) {
            return {
                path: configPath,
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }

    private readConfigFile(configPath: string): HitmuxConfig {
        try {
            if (!fs.existsSync(configPath)) {
                return {};
            }

            const content = fs.readFileSync(configPath, 'utf-8').trim();
            if (!content) {
                return {};
            }

            const parsed = JSON.parse(stripJsonComments(content));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                console.warn(`[ConfigManager] Ignoring ${configPath}: expected a JSON object.`);
                return {};
            }

            return parsed as HitmuxConfig;
        } catch (error) {
            console.warn(`[ConfigManager] Failed to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
            return {};
        }
    }

    get<T extends HitmuxConfigKey>(key: T): HitmuxConfig[T] | undefined {
        const value = this.getAll()[key];
        return value === null ? undefined : value;
    }

    getString(key: HitmuxConfigKey): string | undefined {
        const value = this.get(key);
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed.length > 0 ? trimmed : undefined;
        }
        return undefined;
    }

    getNumber(key: HitmuxConfigKey): number | undefined {
        const value = this.get(key);
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === 'string' && value.trim().length > 0) {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : undefined;
        }
        return undefined;
    }

    getBoolean(key: HitmuxConfigKey): boolean | undefined {
        const value = this.get(key);
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'string') {
            switch (value.trim().toLowerCase()) {
                case '1':
                case 'true':
                case 'yes':
                case 'on':
                    return true;
                case '0':
                case 'false':
                case 'no':
                case 'off':
                    return false;
            }
        }
        return undefined;
    }

    getStringArray(key: HitmuxConfigKey): string[] {
        const value = this.get(key);
        if (Array.isArray(value)) {
            return value
                .map(item => typeof item === 'string' ? item.trim() : '')
                .filter(item => item.length > 0);
        }
        if (typeof value === 'string') {
            return value
                .split(',')
                .map(item => item.trim())
                .filter(item => item.length > 0);
        }
        return [];
    }

    set<T extends HitmuxConfigKey>(key: T, value: HitmuxConfig[T]): void {
        const configPath = this.getGlobalConfigFilePath();
        const configDir = path.dirname(configPath);
        fs.mkdirSync(configDir, { recursive: true });

        const config = this.getAll();
        config[key] = value;
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 4)}\n`, 'utf-8');
    }
}

export const configManager = new ConfigManager();

function stripJsonComments(input: string): string {
    let output = '';
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;

    for (let i = 0; i < input.length; i++) {
        const current = input[i];
        const next = input[i + 1];

        if (inLineComment) {
            if (current === '\n' || current === '\r') {
                inLineComment = false;
                output += current;
            }
            continue;
        }

        if (inBlockComment) {
            if (current === '*' && next === '/') {
                inBlockComment = false;
                i++;
                continue;
            }
            if (current === '\n' || current === '\r') {
                output += current;
            }
            continue;
        }

        if (inString) {
            output += current;
            if (escaped) {
                escaped = false;
            } else if (current === '\\') {
                escaped = true;
            } else if (current === '"') {
                inString = false;
            }
            continue;
        }

        if (current === '"') {
            inString = true;
            output += current;
            continue;
        }

        if (current === '/' && next === '/') {
            inLineComment = true;
            i++;
            continue;
        }

        if (current === '/' && next === '*') {
            inBlockComment = true;
            i++;
            continue;
        }

        output += current;
    }

    return output;
}
