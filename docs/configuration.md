# Configuration

Hitmux Context Engine reads runtime options from conf files:

1. `~/.hitmux-context-engine/config.conf`
2. `./.hitmux-context-engine/config.conf`
3. built-in defaults

Project config overrides global config for fields that are present. Keep secret fields commented until you need them; an uncommented empty string overrides the global value.

Environment variables and `~/.hitmux-context-engine/.env` are not used for MCP product options.

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

By default, Hitmux Context Engine does not inherit system proxy environment variables such as `http_proxy`, `https_proxy`, or `grpc_proxy`. See [System Proxy](#system-proxy) when an embedding provider or remote vector database must use a proxy.

Add the MCP server:

```bash
claude mcp add hitmux-context-engine -- npx -y @hitmux/hce@latest
codex mcp add hitmux-context-engine -- npx -y @hitmux/hce@latest
```

`@hitmux/hce`, `@hitmux/hitmux-context-engine`, and `@hitmux/hitmux-context-engine-mcp` start the same MCP server.

For a local source checkout, `./scripts/install-local-global.sh` builds the MCP package and installs a user-level `hitmux-context-engine-mcp` command. Run it with `sudo` for a global install. Use that installed command in client setup, such as `claude mcp add hitmux-context-engine -- hitmux-context-engine-mcp` or `codex mcp add hitmux-context-engine -- hitmux-context-engine-mcp`.

Database note: Use Local Milvus with `milvusAddress = localhost:19530`. For self-hosted remote Milvus, replace it with the reachable host and port. For Zilliz Cloud, use the cloud public endpoint and add `milvusToken` with your Personal Key.

## Embedding Providers

OpenRouter is the default provider.

```conf
embeddingProvider = OpenRouter
embeddingModel = qwen/qwen3-embedding-4b
openrouterApiKey = sk-or-your-openrouter-api-key
```

Database fields are configured separately in [Vector Database](#vector-database).

OpenAI:

```conf
embeddingProvider = OpenAI
embeddingModel = text-embedding-3-small
openaiApiKey = sk-your-openai-api-key
openaiBaseUrl = https://api.openai.com/v1
```

Database fields are configured separately in [Vector Database](#vector-database).

VoyageAI:

```conf
embeddingProvider = VoyageAI
embeddingModel = voyage-code-3
voyageaiApiKey = pa-your-voyageai-api-key
```

Database fields are configured separately in [Vector Database](#vector-database).

Gemini:

```conf
embeddingProvider = Gemini
embeddingModel = gemini-embedding-001
geminiApiKey = your-gemini-api-key
geminiBaseUrl = https://generativelanguage.googleapis.com
```

Database fields are configured separately in [Vector Database](#vector-database).

Ollama:

```conf
embeddingProvider = Ollama
embeddingModel = nomic-embed-text
ollamaHost = http://127.0.0.1:11434
```

Database fields are configured separately in [Vector Database](#vector-database).

## Vector Database

Hitmux Context Engine currently supports Milvus-compatible vector storage through `config.conf`. This includes Local Milvus, self-hosted remote Milvus, and Zilliz Cloud. SQLite, Chroma, Qdrant, LanceDB, and other database backends are not selectable from `config.conf`.

Local Milvus:

```conf
milvusAddress = localhost:19530
```

Local Milvus deployment on Linux without Docker:

```bash
MILVUS_VERSION=2.6.9
wget "https://github.com/milvus-io/milvus/releases/download/v${MILVUS_VERSION}/milvus_${MILVUS_VERSION}-1_amd64.deb" \
    -O "/tmp/milvus_${MILVUS_VERSION}-1_amd64.deb"
sudo apt install -y "/tmp/milvus_${MILVUS_VERSION}-1_amd64.deb"
sudo systemctl enable --now milvus
```

Verify the service before indexing:

```bash
systemctl is-active milvus
dpkg-query -W -f='${Package} ${Version}\n' milvus
ss -ltnp | rg '(:19530|:9091|:2379|:2380)'
```

Local Milvus deployment on macOS with Docker Desktop:

```bash
mkdir -p ~/milvus-local
cd ~/milvus-local
curl -sfL https://raw.githubusercontent.com/milvus-io/milvus/master/scripts/standalone_embed.sh \
    -o standalone_embed.sh
bash standalone_embed.sh start
```

Verify the container before indexing:

```bash
docker ps --filter name=milvus-standalone
curl -f http://localhost:9091/healthz
lsof -nP -iTCP:19530 -sTCP:LISTEN
```

Docker Desktop on macOS should have at least 2 vCPUs and 8 GB memory assigned to its VM.

Local Milvus deployment on Windows with Docker Desktop:

```powershell
mkdir $HOME\milvus-local
cd $HOME\milvus-local
Invoke-WebRequest https://raw.githubusercontent.com/milvus-io/milvus/refs/heads/master/scripts/standalone_embed.bat -OutFile standalone.bat
.\standalone.bat start
```

Verify the container before indexing:

```powershell
docker ps --filter name=milvus-standalone
curl.exe -f http://localhost:9091/healthz
netstat -ano | findstr ":19530"
```

Docker Desktop on Windows should use the WSL 2 backend. Keep the Milvus data directory in a normal user-owned folder, and run PowerShell or Command Prompt as administrator if Docker Desktop requires it.

The MCP config only needs the local gRPC endpoint:

```conf
milvusAddress = localhost:19530
```

Do not set `milvusToken` for a default local package install. After switching from a remote database or changing embedding model/provider, re-index affected codebases so collection metadata matches the active embedding configuration.

Self-hosted remote Milvus:

```conf
milvusAddress = your-milvus-host:19530
```

If your self-hosted Milvus deployment requires authentication, add `milvusToken`:

```conf
milvusAddress = your-milvus-host:19530
milvusToken = your-milvus-token
```

Zilliz Cloud:

```conf
milvusAddress = your-zilliz-cloud-public-endpoint
milvusToken = your-zilliz-cloud-personal-key
```

Optional database fields:

| Field | Description | Default |
| --- | --- | --- |
| `milvusUseRestful` | Reserved advanced option; the current MCP startup path uses the gRPC Milvus client | `false` |
| `milvusCollectionLimitCheckTimeoutMs` | Timeout for collection-limit pre-check | `15000` |
| `zillizBaseUrl` | Zilliz management API base URL | provider default |
| `hybridMode` | Enable BM25 + dense vector hybrid search | `true` |

If `milvusAddress` is omitted and `milvusToken` is set, token-based address resolution is intended for Zilliz Cloud. For self-hosted remote Milvus, set `milvusAddress` explicitly.

## System Proxy

Hitmux Context Engine ignores system proxy environment variables by default. This prevents local Milvus, Ollama, and other localhost services from being routed through a desktop or shell proxy by accident.

The proxy controls are split by dependency type:

| Field | Applies to | Default |
| --- | --- | --- |
| `embeddingUseSystemProxy` | Embedding providers such as OpenAI, OpenRouter, VoyageAI, Gemini, and Ollama | `false` |
| `databaseUseSystemProxy` | Milvus-compatible vector database connections, including Local Milvus, self-hosted Milvus, and Zilliz Cloud | `false` |

Enable only the side that actually needs the proxy.

Embedding provider through system proxy, local Milvus direct:

```conf
embeddingUseSystemProxy = true
databaseUseSystemProxy = false
```

Remote vector database through system proxy, embedding direct:

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = true
```

Fully direct local setup:

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = false
```

For a default local Milvus setup, keep `databaseUseSystemProxy = false`. If a local database connection fails with gRPC errors such as `14 UNAVAILABLE: No connection established`, check whether the shell or MCP client process has proxy variables set and keep the database proxy disabled.

## File Filtering

Additional extensions and ignore patterns are additive.

```conf
customExtensions = .vue
customExtensions = .svelte
customExtensions = .astro
customIgnorePatterns = fixtures/**
customIgnorePatterns = tmp/**
customIgnorePatterns = *.backup
```

The final file set is:

```text
(default supported extensions + customExtensions)
- (default ignore patterns + customIgnorePatterns + ignore files)
```

Default ignore patterns include dependency folders, build output, version control folders, caches, logs, temp files, minified bundles, source maps, `.env`, `.env.*`, and `*.local`.

## Collection Identity

Use these fields when collection naming needs to be stable across paths or shared across checkouts.

```conf
collectionNameOverride = my_project
codebaseIdentityMode = path
codebaseIdentity = shared-custom-identity
globalCollectionName = default
gitRemoteName = origin
```

`codebaseIdentityMode` accepts `path`, `gitRemote`, `global`, or `custom`.

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

Useful combinations:

- Set `backgroundSync = false` to disable periodic polling while keeping trigger-based sync.
- Set `triggerWatcher = false` on read-only or sandboxed filesystems.
- Set `projectWatcher = false` to force the older full change scan before automatic sync and default `search_code` refreshes.
- Set `projectWatcherUsePolling = true` only when native file events are unreliable.
- Set `interactiveIndexing = false` to block `index_codebase` writes while still allowing dry-run previews.
- Set `automaticIncrementalEffectiveLineLimit` to control when automatic incremental sync pauses and asks for manual `index_codebase` with `incremental=true`.

The trigger watcher listens to `~/.hitmux-context-engine/.sync-trigger`. Touching that file requests a debounced re-index.
The project watcher records dirty paths for indexed codebases during the MCP server lifetime. Clean projects skip full scans until `projectWatcherFallbackScanIntervalMs` forces reconciliation.

## Full Template

```conf
embeddingProvider = OpenRouter
embeddingModel = qwen/qwen3-embedding-4b

openrouterApiKey = sk-or-your-openrouter-api-key
openaiApiKey = sk-your-openai-api-key
openaiBaseUrl = https://api.openai.com/v1
voyageaiApiKey = pa-your-voyageai-api-key
geminiApiKey = your-gemini-api-key
geminiBaseUrl = https://generativelanguage.googleapis.com
ollamaModel = nomic-embed-text
ollamaHost = http://127.0.0.1:11434

milvusAddress = localhost:19530
milvusToken = your-zilliz-or-milvus-token
milvusUseRestful = false
milvusCollectionLimitCheckTimeoutMs = 15000
zillizBaseUrl = https://api.cloud.zilliz.com

collectionNameOverride = my_project
codebaseIdentityMode = path
codebaseIdentity = shared-custom-identity
globalCollectionName = default
gitRemoteName = origin
hybridMode = true

searchTimeoutMs = 30000
# embeddingBatchSize = 32
# embeddingConcurrency = 4
fileProcessingConcurrency = 2
customExtensions = .vue
customExtensions = .svelte
customExtensions = .astro
customIgnorePatterns = temp/**
customIgnorePatterns = *.backup
merkleSnapshotMaxBytes = 52428800

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

splitterType = ast
searchTopK = 5
searchThreshold = 0
```
