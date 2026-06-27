# Configuration

Sprache: [English](configuration.md) | [中文](configuration.zh-CN.md) | [Español](configuration.es.md) | [Français](configuration.fr.md) | Deutsch | [日本語](configuration.ja.md) | [한국어](configuration.ko.md)

Hitmux Context Engine liest runtime options aus:

1. `~/.hitmux-context-engine/config.conf`
2. `./.hitmux-context-engine/config.conf`
3. built-in defaults

Projektkonfiguration überschreibt globale Werte für vorhandene Felder. Secrets sollten kommentiert bleiben, bis sie gebraucht werden; ein nicht kommentierter leerer String überschreibt den globalen Wert. Umgebungsvariablen und `~/.hitmux-context-engine/.env` werden nicht für MCP-Produktoptionen verwendet.

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

CLI installieren und MCP server hinzufügen:

```bash
npm install -g @hitmux/hce@latest
claude mcp add hitmux-context-engine -- hce
codex mcp add hitmux-context-engine -- hce
```

`@hitmux/hce`, `@hitmux/hitmux-context-engine` und `@hitmux/hitmux-context-engine-mcp` starten denselben MCP server.

## Embedding Providers

OpenRouter ist der Standard-provider:

```conf
embeddingProvider = OpenRouter
embeddingModel = qwen/qwen3-embedding-4b
openrouterApiKey = sk-or-your-openrouter-api-key
```

Mit `qwen/qwen3-embedding-4b` nutzt indexing `embeddingBatchSize = 64` und `embeddingConcurrency = 2`, sofern nicht überschrieben. Weitere providers:

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

`config.conf` unterstützt Milvus-kompatiblen Vektorspeicher: Local Milvus, self-hosted remote Milvus und Zilliz Cloud. SQLite, Chroma, Qdrant, LanceDB und andere backends sind über `config.conf` nicht auswählbar.

Local Milvus:

```conf
milvusAddress = localhost:19530
```

Remote Milvus:

```conf
milvusAddress = your-milvus-host:19530
milvusToken = your-milvus-token
```

Kostenlose Zilliz Cloud database: unter https://cloud.zilliz.com/signup registrieren und konfigurieren:

```conf
milvusAddress = your-zilliz-cloud-public-endpoint
milvusToken = your-zilliz-cloud-personal-key
```

Optionale Felder:

| Field | Description | Default |
| --- | --- | --- |
| `milvusUseRestful` | Reservierte Advanced-Option; der aktuelle MCP-Startpfad nutzt den gRPC Milvus client | `false` |
| `milvusCollectionLimitCheckTimeoutMs` | Timeout für collection-limit pre-check | `15000` |
| `zillizBaseUrl` | Zilliz management API base URL | provider default |
| `hybridMode` | Aktiviert BM25 + dense vector hybrid search | `true` |

## System Proxy

Hitmux Context Engine ignoriert standardmäßig System-proxy-Variablen wie `http_proxy`, `https_proxy`, `all_proxy` und `grpc_proxy`.

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = false
```

Aktiviere nur die Seite, die den Proxy braucht. Embedding provider über Proxy, Local Milvus direkt:

```conf
embeddingUseSystemProxy = true
databaseUseSystemProxy = false
```

Remote vector database über Proxy, embedding direkt:

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = true
```

## File Filtering

Zusätzliche Extensions und ignore patterns sind additiv:

```conf
customExtensions = .vue
customExtensions = .svelte
customExtensions = .astro
customIgnorePatterns = fixtures/**
customIgnorePatterns = tmp/**
customIgnorePatterns = *.backup
```

Die finale Dateimenge ist `(default supported extensions + customExtensions) - (default ignore patterns + customIgnorePatterns + ignore files)`.

## Collection Identity

Nutze diese Felder, wenn collection-Namen über Pfade stabil oder zwischen checkouts geteilt sein sollen:

```conf
collectionNameOverride = my_project
codebaseIdentityMode = path
codebaseIdentity = shared-custom-identity
globalCollectionName = default
gitRemoteName = origin
```

`codebaseIdentityMode` akzeptiert `path`, `gitRemote`, `global` oder `custom`.

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

- `backgroundSync = false` deaktiviert periodisches Polling, behält aber trigger-based und project-watcher sync.
- `triggerWatcher = false` passt für read-only oder sandboxed filesystems.
- `projectWatcher = false` erzwingt den älteren vollständigen Change-Scan vor automatischer sync.
- `projectWatcherUsePolling = true` nur bei unzuverlässigen nativen File Events.
- `interactiveIndexing = false` blockiert `index_codebase`-Writes und erlaubt weiter dry-run previews.

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
