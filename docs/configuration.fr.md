# Configuration

Langue : [English](configuration.md) | [中文](configuration.zh-CN.md) | [Español](configuration.es.md) | Français | [Deutsch](configuration.de.md) | [日本語](configuration.ja.md) | [한국어](configuration.ko.md)

Hitmux Context Engine lit les options runtime depuis :

1. `~/.hitmux-context-engine/config.conf`
2. `./.hitmux-context-engine/config.conf`
3. built-in defaults

La configuration projet remplace la configuration globale pour les champs présents. Gardez les secrets commentés jusqu'à leur utilisation ; une chaîne vide non commentée remplace la valeur globale. Les variables d'environnement et `~/.hitmux-context-engine/.env` ne sont pas utilisées pour les options produit MCP.

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

Installez le CLI et ajoutez le MCP server :

```bash
npm install -g @hitmux/hce@latest
claude mcp add hitmux-context-engine -- hce
codex mcp add hitmux-context-engine -- hce
```

`@hitmux/hce`, `@hitmux/hitmux-context-engine` et `@hitmux/hitmux-context-engine-mcp` démarrent le même MCP server.

## Embedding Providers

OpenRouter est le provider par défaut :

```conf
embeddingProvider = OpenRouter
embeddingModel = qwen/qwen3-embedding-4b
openrouterApiKey = sk-or-your-openrouter-api-key
```

Avec `qwen/qwen3-embedding-4b`, l'indexing utilise `embeddingBatchSize = 64` et `embeddingConcurrency = 2` sauf surcharge. Autres providers :

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

`config.conf` prend en charge le stockage vectoriel compatible Milvus : Local Milvus, self-hosted remote Milvus et Zilliz Cloud. SQLite, Chroma, Qdrant, LanceDB et les autres backends ne sont pas sélectionnables depuis `config.conf`.

Local Milvus :

```conf
milvusAddress = localhost:19530
```

Remote Milvus :

```conf
milvusAddress = your-milvus-host:19530
milvusToken = your-milvus-token
```

Zilliz Cloud gratuit : inscrivez-vous sur https://cloud.zilliz.com/signup puis configurez :

```conf
milvusAddress = your-zilliz-cloud-public-endpoint
milvusToken = your-zilliz-cloud-personal-key
```

Champs optionnels :

| Field | Description | Default |
| --- | --- | --- |
| `milvusUseRestful` | Option avancée réservée ; le chemin de démarrage MCP actuel utilise le client gRPC Milvus | `false` |
| `milvusCollectionLimitCheckTimeoutMs` | Timeout du pre-check de limite de collections | `15000` |
| `zillizBaseUrl` | Zilliz management API base URL | provider default |
| `hybridMode` | Active la recherche hybride BM25 + dense vector | `true` |

## System Proxy

Hitmux Context Engine ignore par défaut les variables proxy système comme `http_proxy`, `https_proxy`, `all_proxy` et `grpc_proxy`.

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = false
```

Activez uniquement le côté qui a besoin du proxy. Embedding provider via proxy et Local Milvus direct :

```conf
embeddingUseSystemProxy = true
databaseUseSystemProxy = false
```

Remote vector database via proxy et embedding direct :

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = true
```

## File Filtering

Les extensions et ignore patterns supplémentaires sont additifs :

```conf
customExtensions = .vue
customExtensions = .svelte
customExtensions = .astro
customIgnorePatterns = fixtures/**
customIgnorePatterns = tmp/**
customIgnorePatterns = *.backup
```

L'ensemble final est `(default supported extensions + customExtensions) - (default ignore patterns + customIgnorePatterns + ignore files)`.

## Collection Identity

Utilisez ces champs quand le nom de collection doit rester stable entre chemins ou partagé entre checkouts :

```conf
collectionNameOverride = my_project
codebaseIdentityMode = path
codebaseIdentity = shared-custom-identity
globalCollectionName = default
gitRemoteName = origin
```

`codebaseIdentityMode` accepte `path`, `gitRemote`, `global` ou `custom`.

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

- `backgroundSync = false` désactive le polling périodique mais conserve trigger-based et project-watcher sync.
- `triggerWatcher = false` convient aux filesystems read-only ou sandboxed.
- `projectWatcher = false` force l'ancien scan complet avant la sync automatique.
- `projectWatcherUsePolling = true` seulement si les événements natifs ne sont pas fiables.
- `interactiveIndexing = false` bloque les écritures `index_codebase` tout en autorisant les dry-run previews.

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
