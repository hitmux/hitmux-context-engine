# Configuration

Language: [English](configuration.md) | [中文](configuration.zh-CN.md) | [Español](configuration.es.md) | [Français](configuration.fr.md) | [Deutsch](configuration.de.md) | [日本語](configuration.ja.md) | 한국어

Hitmux Context Engine은 runtime options를 다음 순서로 읽습니다.

1. `~/.hitmux-context-engine/config.conf`
2. `./.hitmux-context-engine/config.conf`
3. built-in defaults

Project config는 존재하는 field에 대해 global config를 override합니다. secret fields는 필요할 때까지 주석 처리해 두세요. 주석 해제된 빈 문자열은 global value를 override합니다. 환경 변수와 `~/.hitmux-context-engine/.env`는 MCP product options에 사용되지 않습니다.

## Minimal Config

```bash
mkdir -p ~/.hitmux-context-engine
cat > ~/.hitmux-context-engine/config.conf << 'EOF'
embeddingProvider = OpenRouter
embeddingModel = qwen/qwen3-embedding-4b
openrouterApiKey = sk-or-your-openrouter-api-key
milvusAddress = localhost:19530
EOF
```

CLI를 설치하고 MCP server를 추가합니다.

```bash
npm install -g @hitmux/hce@latest
claude mcp add hitmux-context-engine -- hce
codex mcp add hitmux-context-engine -- hce
```

`@hitmux/hce`, `@hitmux/hitmux-context-engine`, `@hitmux/hitmux-context-engine-mcp`는 같은 MCP server를 시작합니다.

## Embedding Providers

OpenRouter가 default provider입니다.

```conf
embeddingProvider = OpenRouter
embeddingModel = qwen/qwen3-embedding-4b
openrouterApiKey = sk-or-your-openrouter-api-key
```

`qwen/qwen3-embedding-4b` 설정에서는 override하지 않는 한 indexing이 `embeddingBatchSize = 64`와 `embeddingConcurrency = 2`를 사용합니다. 다른 providers:

```conf
embeddingProvider = OpenAI
embeddingModel = text-embedding-3-small
openaiApiKey = sk-your-openai-api-key
openaiBaseUrl = https://api.openai.com/v1

embeddingProvider = VoyageAI
embeddingModel = voyage-code-3
voyageaiApiKey = pa-your-voyageai-api-key

embeddingProvider = Gemini
embeddingModel = gemini-embedding-001
geminiApiKey = your-gemini-api-key
geminiBaseUrl = https://generativelanguage.googleapis.com

embeddingProvider = Ollama
embeddingModel = nomic-embed-text
ollamaHost = http://127.0.0.1:11434
```

## Vector Database

`config.conf`는 Milvus-compatible vector storage를 지원합니다. Local Milvus, self-hosted remote Milvus, Zilliz Cloud가 대상입니다. SQLite, Chroma, Qdrant, LanceDB 및 기타 backends는 `config.conf`에서 선택할 수 없습니다.

Local Milvus:

```conf
milvusAddress = localhost:19530
```

Remote Milvus:

```conf
milvusAddress = your-milvus-host:19530
milvusToken = your-milvus-token
```

무료 Zilliz Cloud database는 https://cloud.zilliz.com/signup 에서 가입한 뒤 설정합니다.

```conf
milvusAddress = your-zilliz-cloud-public-endpoint
milvusToken = your-zilliz-cloud-personal-key
```

Optional fields:

| Field | Description | Default |
| --- | --- | --- |
| `milvusUseRestful` | reserved advanced option. 현재 MCP startup path는 gRPC Milvus client를 사용합니다 | `false` |
| `milvusCollectionLimitCheckTimeoutMs` | collection-limit pre-check timeout | `15000` |
| `zillizBaseUrl` | Zilliz management API base URL | provider default |
| `hybridMode` | BM25 + dense vector hybrid search 활성화 | `true` |

## System Proxy

Hitmux Context Engine은 기본적으로 `http_proxy`, `https_proxy`, `all_proxy`, `grpc_proxy` 같은 system proxy variables를 상속하지 않습니다.

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = false
```

proxy가 필요한 쪽만 활성화하세요. embedding provider는 proxy, Local Milvus는 direct:

```conf
embeddingUseSystemProxy = true
databaseUseSystemProxy = false
```

remote vector database는 proxy, embedding은 direct:

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = true
```

## File Filtering

추가 extensions와 ignore patterns는 additive입니다.

```conf
customExtensions = .vue
customExtensions = .svelte
customExtensions = .astro
customIgnorePatterns = fixtures/**
customIgnorePatterns = tmp/**
customIgnorePatterns = *.backup
```

최종 file set은 `(default supported extensions + customExtensions) - (default ignore patterns + customIgnorePatterns + ignore files)`입니다.

## Collection Identity

collection naming을 paths 간에 안정화하거나 checkouts 간에 공유해야 할 때 사용합니다.

```conf
collectionNameOverride = my_project
codebaseIdentityMode = path
codebaseIdentity = shared-custom-identity
globalCollectionName = default
gitRemoteName = origin
```

`codebaseIdentityMode`는 `path`, `gitRemote`, `global`, `custom`을 받습니다.

## Indexing And Sync

```conf
autoIndexing = true
interactiveIndexing = true
backgroundSync = true
automaticIncrementalEffectiveLineLimit = 5000
syncIntervalMs = 120000
syncLockStaleMs = 600000
triggerWatcher = true
projectWatcher = true
projectWatcherDebounceMs = 1000
projectWatcherUsePolling = false
projectWatcherFallbackScanIntervalMs = 600000
```

- `backgroundSync = false`는 periodic polling을 끄고 trigger-based 및 project-watcher sync는 유지합니다.
- `triggerWatcher = false`는 read-only 또는 sandboxed filesystems에서 사용합니다.
- `projectWatcher = false`는 automatic sync 전에 이전 full change scan을 사용합니다.
- `projectWatcherUsePolling = true`는 native file events가 불안정할 때만 사용합니다.
- `interactiveIndexing = false`는 dry-run previews를 허용하면서 `index_codebase` writes를 막습니다.

## Full Template

```conf
embeddingProvider = OpenRouter
embeddingModel = qwen/qwen3-embedding-4b
openrouterApiKey = sk-or-your-openrouter-api-key
milvusAddress = localhost:19530
milvusToken = your-zilliz-or-milvus-token
hybridMode = true
searchTimeoutMs = 30000
fileProcessingConcurrency = 2
customExtensions = .vue
customIgnorePatterns = temp/**
autoIndexing = true
interactiveIndexing = true
backgroundSync = true
projectWatcher = true
splitterType = ast
searchTopK = 5
searchThreshold = 0
```
