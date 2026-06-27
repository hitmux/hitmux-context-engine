# Configuration

Language: [English](configuration.md) | [中文](configuration.zh-CN.md) | [Español](configuration.es.md) | [Français](configuration.fr.md) | [Deutsch](configuration.de.md) | 日本語 | [한국어](configuration.ko.md)

Hitmux Context Engine は runtime options を次の順序で読み込みます。

1. `~/.hitmux-context-engine/config.conf`
2. `./.hitmux-context-engine/config.conf`
3. built-in defaults

project config は存在する field について global config を上書きします。secret fields は必要になるまでコメントアウトしておいてください。コメント解除された空文字列は global value を上書きします。環境変数と `~/.hitmux-context-engine/.env` は MCP product options には使われません。

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

CLI をインストールして MCP server を追加します。

```bash
npm install -g @hitmux/hce@latest
claude mcp add hitmux-context-engine -- hce
codex mcp add hitmux-context-engine -- hce
```

`@hitmux/hce`、`@hitmux/hitmux-context-engine`、`@hitmux/hitmux-context-engine-mcp` は同じ MCP server を起動します。

## Embedding Providers

OpenRouter が default provider です。

```conf
embeddingProvider = OpenRouter
embeddingModel = qwen/qwen3-embedding-4b
openrouterApiKey = sk-or-your-openrouter-api-key
```

`qwen/qwen3-embedding-4b` では、上書きしない限り indexing は `embeddingBatchSize = 64` と `embeddingConcurrency = 2` を使います。その他の providers:

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

`config.conf` では Milvus-compatible vector storage をサポートします。Local Milvus、self-hosted remote Milvus、Zilliz Cloud が対象です。SQLite、Chroma、Qdrant、LanceDB などの backends は `config.conf` から選択できません。

Local Milvus:

```conf
milvusAddress = localhost:19530
```

Remote Milvus:

```conf
milvusAddress = your-milvus-host:19530
milvusToken = your-milvus-token
```

無料の Zilliz Cloud database は https://cloud.zilliz.com/signup で登録して、次を設定します。

```conf
milvusAddress = your-zilliz-cloud-public-endpoint
milvusToken = your-zilliz-cloud-personal-key
```

Optional fields:

| Field | Description | Default |
| --- | --- | --- |
| `milvusUseRestful` | reserved advanced option。現在の MCP startup path は gRPC Milvus client を使います | `false` |
| `milvusCollectionLimitCheckTimeoutMs` | collection-limit pre-check の timeout | `15000` |
| `zillizBaseUrl` | Zilliz management API base URL | provider default |
| `hybridMode` | BM25 + dense vector hybrid search を有効化 | `true` |

## System Proxy

Hitmux Context Engine は default で `http_proxy`、`https_proxy`、`all_proxy`、`grpc_proxy` などの system proxy variables を継承しません。

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = false
```

proxy が必要な側だけ有効にしてください。embedding provider は proxy、Local Milvus は direct:

```conf
embeddingUseSystemProxy = true
databaseUseSystemProxy = false
```

remote vector database は proxy、embedding は direct:

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = true
```

## File Filtering

追加 extensions と ignore patterns は additive です。

```conf
customExtensions = .vue
customExtensions = .svelte
customExtensions = .astro
customIgnorePatterns = fixtures/**
customIgnorePatterns = tmp/**
customIgnorePatterns = *.backup
```

最終的な file set は `(default supported extensions + customExtensions) - (default ignore patterns + customIgnorePatterns + ignore files)` です。

## Collection Identity

collection naming を paths 間で安定させる、または checkouts 間で共有する場合に使います。

```conf
collectionNameOverride = my_project
codebaseIdentityMode = path
codebaseIdentity = shared-custom-identity
globalCollectionName = default
gitRemoteName = origin
```

`codebaseIdentityMode` は `path`、`gitRemote`、`global`、`custom` を受け取ります。

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

- `backgroundSync = false` は periodic polling を止め、trigger-based と project-watcher sync は残します。
- `triggerWatcher = false` は read-only または sandboxed filesystems で使います。
- `projectWatcher = false` は automatic sync 前に旧来の full change scan を使います。
- `projectWatcherUsePolling = true` は native file events が不安定な場合だけ使います。
- `interactiveIndexing = false` は dry-run previews を許可しつつ `index_codebase` writes を止めます。

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
