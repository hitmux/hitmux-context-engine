import corePackage from "@hitmux/hitmux-context-engine-core";
import type {
    Embedding as EmbeddingInstance,
    EmbeddingVector,
} from "@hitmux/hitmux-context-engine-core";
import { ContextMcpConfig } from "./config.js";

const {
    Embedding,
    OpenAIEmbedding,
    VoyageAIEmbedding,
    GeminiEmbedding,
    OllamaEmbedding,
    applySystemProxyPolicy,
    restoreProxyEnvironment,
    withSystemProxyPolicy,
} = corePackage;

const HITMUX_CLIENT_HEADERS = {
    "X-Hitmux-Client": "Hitmux Context Engine",
} as const;

const OPENROUTER_APP_ATTRIBUTION_HEADERS = {
    ...HITMUX_CLIENT_HEADERS,
    "HTTP-Referer": "https://github.com/hitmux/hitmux-context-engine",
    "X-OpenRouter-Title": "Hitmux Context Engine",
} as const;

export interface EmbeddingInstanceOptions {
    openAiRetryMaxElapsedMs?: number;
}

class ProxyControlledEmbedding extends Embedding {
    protected maxTokens = 0;

    constructor(
        private readonly delegate: EmbeddingInstance,
        private readonly useSystemProxy: boolean,
    ) {
        super();
    }

    detectDimension(testText?: string): Promise<number> {
        return withSystemProxyPolicy(this.useSystemProxy, () =>
            this.delegate.detectDimension(testText),
        );
    }

    embed(text: string): Promise<EmbeddingVector> {
        return withSystemProxyPolicy(this.useSystemProxy, () =>
            this.delegate.embed(text),
        );
    }

    embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return withSystemProxyPolicy(this.useSystemProxy, () =>
            this.delegate.embedBatch(texts),
        );
    }

    getDimension(): number {
        return this.delegate.getDimension();
    }

    getProvider(): string {
        return this.delegate.getProvider();
    }

    getModel(): string {
        return this.delegate.getModel();
    }
}

// Helper function to create embedding instance based on provider
export function createEmbeddingInstance(
    config: ContextMcpConfig,
    options: EmbeddingInstanceOptions = {},
): EmbeddingInstance {
    console.log(
        `[EMBEDDING] Creating ${config.embeddingProvider} embedding instance...`,
    );

    let embedding: EmbeddingInstance;
    const previousProxyEnv = applySystemProxyPolicy(
        config.embeddingUseSystemProxy,
    );
    try {
        switch (config.embeddingProvider) {
            case "OpenAI": {
                if (!config.openaiApiKey) {
                    console.error(
                        `[EMBEDDING] OpenAI API key is required but not provided`,
                    );
                    throw new Error(
                        "openaiApiKey is required in ~/.hitmux-context-engine/config.conf for OpenAI embedding provider",
                    );
                }
                console.log(
                    `[EMBEDDING] Configuring OpenAI with model: ${config.embeddingModel}`,
                );
                embedding = new OpenAIEmbedding({
                    apiKey: config.openaiApiKey,
                    model: config.embeddingModel,
                    defaultHeaders: HITMUX_CLIENT_HEADERS,
                    ...(config.openaiBaseUrl && {
                        baseURL: config.openaiBaseUrl,
                    }),
                    ...(options.openAiRetryMaxElapsedMs !== undefined && {
                        retryMaxElapsedMs: options.openAiRetryMaxElapsedMs,
                    }),
                });
                console.log(
                    `[EMBEDDING] OpenAI embedding instance created successfully`,
                );
                break;
            }

            case "VoyageAI": {
                if (!config.voyageaiApiKey) {
                    console.error(
                        `[EMBEDDING] VoyageAI API key is required but not provided`,
                    );
                    throw new Error(
                        "voyageaiApiKey is required in ~/.hitmux-context-engine/config.conf for VoyageAI embedding provider",
                    );
                }
                console.log(
                    `[EMBEDDING] Configuring VoyageAI with model: ${config.embeddingModel}`,
                );
                embedding = new VoyageAIEmbedding({
                    apiKey: config.voyageaiApiKey,
                    model: config.embeddingModel,
                });
                console.log(
                    `[EMBEDDING] VoyageAI embedding instance created successfully`,
                );
                break;
            }

            case "Gemini": {
                if (!config.geminiApiKey) {
                    console.error(
                        `[EMBEDDING] Gemini API key is required but not provided`,
                    );
                    throw new Error(
                        "geminiApiKey is required in ~/.hitmux-context-engine/config.conf for Gemini embedding provider",
                    );
                }
                console.log(
                    `[EMBEDDING] Configuring Gemini with model: ${config.embeddingModel}`,
                );
                embedding = new GeminiEmbedding({
                    apiKey: config.geminiApiKey,
                    model: config.embeddingModel,
                    ...(config.geminiBaseUrl && {
                        baseURL: config.geminiBaseUrl,
                    }),
                });
                console.log(
                    `[EMBEDDING] Gemini embedding instance created successfully`,
                );
                break;
            }

            case "OpenRouter": {
                if (!config.openrouterApiKey) {
                    console.error(
                        `[EMBEDDING] OpenRouter API key is required but not provided`,
                    );
                    throw new Error(
                        "openrouterApiKey is required in ~/.hitmux-context-engine/config.conf for OpenRouter embedding provider",
                    );
                }
                console.log(
                    `[EMBEDDING] Configuring OpenRouter with model: ${config.embeddingModel}`,
                );
                // Reuse OpenAIEmbedding with OpenRouter's OpenAI-compatible endpoint
                embedding = new OpenAIEmbedding({
                    apiKey: config.openrouterApiKey,
                    model: config.embeddingModel,
                    baseURL: "https://openrouter.ai/api/v1",
                    defaultHeaders: OPENROUTER_APP_ATTRIBUTION_HEADERS,
                    ...(options.openAiRetryMaxElapsedMs !== undefined && {
                        retryMaxElapsedMs: options.openAiRetryMaxElapsedMs,
                    }),
                });
                console.log(
                    `[EMBEDDING] OpenRouter embedding instance created successfully`,
                );
                break;
            }

            case "Ollama": {
                const ollamaHost =
                    config.ollamaHost || "http://127.0.0.1:11434";
                console.log(
                    `[EMBEDDING] Configuring Ollama with model: ${config.embeddingModel}, host: ${ollamaHost}`,
                );
                embedding = new OllamaEmbedding({
                    model: config.embeddingModel,
                    host: ollamaHost,
                });
                console.log(
                    `[EMBEDDING] Ollama embedding instance created successfully`,
                );
                break;
            }

            default:
                console.error(
                    `[EMBEDDING] Unsupported embedding provider: ${config.embeddingProvider}`,
                );
                throw new Error(
                    `Unsupported embedding provider: ${config.embeddingProvider}`,
                );
        }
    } finally {
        restoreProxyEnvironment(previousProxyEnv);
    }

    return new ProxyControlledEmbedding(
        embedding,
        config.embeddingUseSystemProxy,
    );
}

export function logEmbeddingProviderInfo(
    config: ContextMcpConfig,
    embedding: EmbeddingInstance,
): void {
    console.log(
        `[EMBEDDING] Successfully initialized ${config.embeddingProvider} embedding provider`,
    );
    console.log(
        `[EMBEDDING] Provider details - Model: ${config.embeddingModel}, Dimension: ${embedding.getDimension()}`,
    );

    // Log provider-specific configuration details
    switch (config.embeddingProvider) {
        case "OpenAI":
            console.log(
                `[EMBEDDING] OpenAI configuration - API Key: ${config.openaiApiKey ? "Provided" : "Missing"}, Base URL: ${config.openaiBaseUrl || "Default"}`,
            );
            break;
        case "VoyageAI":
            console.log(
                `[EMBEDDING] VoyageAI configuration - API Key: ${config.voyageaiApiKey ? "Provided" : "Missing"}`,
            );
            break;
        case "Gemini":
            console.log(
                `[EMBEDDING] Gemini configuration - API Key: ${config.geminiApiKey ? "Provided" : "Missing"}, Base URL: ${config.geminiBaseUrl || "Default"}`,
            );
            break;
        case "OpenRouter":
            console.log(
                `[EMBEDDING] OpenRouter configuration - API Key: ${config.openrouterApiKey ? "Provided" : "Missing"}`,
            );
            break;
        case "Ollama":
            console.log(
                `[EMBEDDING] Ollama configuration - Host: ${config.ollamaHost || "http://127.0.0.1:11434"}, Model: ${config.embeddingModel}`,
            );
            break;
    }
}
