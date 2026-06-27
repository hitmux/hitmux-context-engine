# Configuration

Idioma: [English](configuration.md) | [中文](configuration.zh-CN.md) | Español | [Français](configuration.fr.md) | [Deutsch](configuration.de.md) | [日本語](configuration.ja.md) | [한국어](configuration.ko.md)

Hitmux Context Engine lee opciones de runtime desde:

1. `~/.hitmux-context-engine/config.conf`
2. `./.hitmux-context-engine/config.conf`
3. built-in defaults

La configuración del proyecto sobrescribe la global para los campos presentes. Mantén secretos comentados hasta usarlos; una cadena vacía sin comentar sobrescribe el valor global. Las variables de entorno y `~/.hitmux-context-engine/.env` no se usan para opciones del producto MCP.

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

Instala el CLI y añade el MCP server:

```bash
npm install -g @hitmux/hce@latest
claude mcp add hitmux-context-engine -- hce
codex mcp add hitmux-context-engine -- hce
```

`@hitmux/hce`, `@hitmux/hitmux-context-engine` y `@hitmux/hitmux-context-engine-mcp` arrancan el mismo MCP server.

## Embedding Providers

OpenRouter es el provider por defecto:

```conf
embeddingProvider = OpenRouter
embeddingModel = qwen/qwen3-embedding-4b
openrouterApiKey = sk-or-your-openrouter-api-key
```

Con `qwen/qwen3-embedding-4b`, el indexing usa `embeddingBatchSize = 64` y `embeddingConcurrency = 2` si no se sobrescriben. Otros providers:

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

`config.conf` admite almacenamiento vectorial compatible con Milvus: Local Milvus, self-hosted remote Milvus y Zilliz Cloud. SQLite, Chroma, Qdrant, LanceDB y otros backends no se pueden seleccionar desde `config.conf`.

Local Milvus:

```conf
milvusAddress = localhost:19530
```

Remote Milvus:

```conf
milvusAddress = your-milvus-host:19530
milvusToken = your-milvus-token
```

Zilliz Cloud gratuito: regístrate en https://cloud.zilliz.com/signup y configura:

```conf
milvusAddress = your-zilliz-cloud-public-endpoint
milvusToken = your-zilliz-cloud-personal-key
```

Campos opcionales:

| Field | Description | Default |
| --- | --- | --- |
| `milvusUseRestful` | Opción avanzada reservada; el arranque MCP actual usa gRPC Milvus client | `false` |
| `milvusCollectionLimitCheckTimeoutMs` | Timeout del pre-check de límite de collections | `15000` |
| `zillizBaseUrl` | Zilliz management API base URL | provider default |
| `hybridMode` | Habilita búsqueda híbrida BM25 + dense vector | `true` |

## System Proxy

Hitmux Context Engine ignora por defecto variables proxy del sistema como `http_proxy`, `https_proxy`, `all_proxy` y `grpc_proxy`.

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = false
```

Activa solo el lado que necesita proxy. Para embedding provider por proxy y Local Milvus directo:

```conf
embeddingUseSystemProxy = true
databaseUseSystemProxy = false
```

Para remote vector database por proxy y embedding directo:

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = true
```

## File Filtering

Extensiones e ignore patterns adicionales son aditivos:

```conf
customExtensions = .vue
customExtensions = .svelte
customExtensions = .astro
customIgnorePatterns = fixtures/**
customIgnorePatterns = tmp/**
customIgnorePatterns = *.backup
```

El conjunto final es `(default supported extensions + customExtensions) - (default ignore patterns + customIgnorePatterns + ignore files)`.

## Collection Identity

Usa estos campos cuando el nombre de collection deba ser estable entre rutas o compartido entre checkouts:

```conf
collectionNameOverride = my_project
codebaseIdentityMode = path
codebaseIdentity = shared-custom-identity
globalCollectionName = default
gitRemoteName = origin
```

`codebaseIdentityMode` acepta `path`, `gitRemote`, `global` o `custom`.

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

- `backgroundSync = false` desactiva polling periódico, pero conserva trigger-based y project-watcher sync.
- `triggerWatcher = false` es útil en filesystems read-only o sandboxed.
- `projectWatcher = false` fuerza el scan de cambios completo anterior antes de sync automática.
- `projectWatcherUsePolling = true` solo cuando los eventos nativos no son fiables.
- `interactiveIndexing = false` bloquea escrituras de `index_codebase` y permite dry-run previews.

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
