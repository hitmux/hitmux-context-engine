# Configuration

Language: [English](configuration.md) | 中文 | [Español](configuration.es.md) | [Français](configuration.fr.md) | [Deutsch](configuration.de.md) | [日本語](configuration.ja.md) | [한국어](configuration.ko.md)

Hitmux Context Engine 从 conf 文件读取 runtime options：

1. `~/.hitmux-context-engine/config.conf`
2. `./.hitmux-context-engine/config.conf`
3. built-in defaults

项目配置会覆盖全局配置中已出现的字段。secret fields 在需要前保持注释状态；取消注释的空字符串会覆盖全局值。

环境变量和 `~/.hitmux-context-engine/.env` 不用于 MCP 产品选项。

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

默认情况下，Hitmux Context Engine 不继承 `http_proxy`、`https_proxy` 或 `grpc_proxy` 等系统代理环境变量。当 embedding provider 或 remote vector database 必须使用代理时，见 [System Proxy](#system-proxy)。

Claude Code 和 OpenAI Codex CLI 使用时，全局安装 CLI 并添加 MCP server：

```bash
npm install -g @hitmux/hce@latest
claude mcp add hitmux-context-engine -- hce
codex mcp add hitmux-context-engine -- hce
```

`@hitmux/hce`、`@hitmux/hitmux-context-engine` 和 `@hitmux/hitmux-context-engine-mcp` 启动的是同一个 MCP server。

本地源码 checkout 可运行 `./scripts/install-local-global.sh`，它会构建 MCP package 并安装用户级 `hitmux-context-engine-mcp` 命令。使用 `sudo` 运行会全局安装。已发布 package 的 Claude Code 和 Codex CLI setup 使用上面展示的全局 `hce` 命令。

数据库说明：Local Milvus 使用 `milvusAddress = localhost:19530`。self-hosted remote Milvus 把它替换为可访问的 host 和 port。免费 Zilliz Cloud 数据库可在 https://cloud.zilliz.com/signup 注册，然后使用 cloud public endpoint，并把 Personal Key 写入 `milvusToken`。

## Embedding Providers

OpenRouter 是默认 provider。

```conf
embeddingProvider = OpenRouter
embeddingModel = qwen/qwen3-embedding-4b
openrouterApiKey = sk-or-your-openrouter-api-key
```

默认 OpenRouter `qwen/qwen3-embedding-4b` 设置下，除非显式覆盖，否则 indexing 使用 `embeddingBatchSize = 64` 和 `embeddingConcurrency = 2`。粗略参考：约 50,000 effective lines 的仓库通常需要约 2-3 分钟完成索引，具体取决于网络延迟、provider load、文件类型组合和 vector database 性能。

数据库字段在 [Vector Database](#vector-database) 中单独配置。

OpenAI:

```conf
embeddingProvider = OpenAI
embeddingModel = text-embedding-3-small
openaiApiKey = sk-your-openai-api-key
openaiBaseUrl = https://api.openai.com/v1
```

数据库字段在 [Vector Database](#vector-database) 中单独配置。

VoyageAI:

```conf
embeddingProvider = VoyageAI
embeddingModel = voyage-code-3
voyageaiApiKey = pa-your-voyageai-api-key
```

数据库字段在 [Vector Database](#vector-database) 中单独配置。

Gemini:

```conf
embeddingProvider = Gemini
embeddingModel = gemini-embedding-001
geminiApiKey = your-gemini-api-key
geminiBaseUrl = https://generativelanguage.googleapis.com
```

数据库字段在 [Vector Database](#vector-database) 中单独配置。

Ollama:

```conf
embeddingProvider = Ollama
embeddingModel = nomic-embed-text
ollamaHost = http://127.0.0.1:11434
```

数据库字段在 [Vector Database](#vector-database) 中单独配置。

<a id="vector-database"></a>

## Vector Database

Hitmux Context Engine 目前通过 `config.conf` 支持 Milvus-compatible vector storage。包括 Local Milvus、self-hosted remote Milvus 和 Zilliz Cloud。SQLite、Chroma、Qdrant、LanceDB 和其他数据库 backend 不能通过 `config.conf` 选择。

Local Milvus:

```conf
milvusAddress = localhost:19530
```

Linux 上不使用 Docker 部署 Local Milvus：

```bash
MILVUS_VERSION=2.6.9
wget "https://github.com/milvus-io/milvus/releases/download/v${MILVUS_VERSION}/milvus_${MILVUS_VERSION}-1_amd64.deb" \
    -O "/tmp/milvus_${MILVUS_VERSION}-1_amd64.deb"
sudo apt install -y "/tmp/milvus_${MILVUS_VERSION}-1_amd64.deb"
sudo systemctl enable --now milvus
```

索引前验证服务：

```bash
systemctl is-active milvus
dpkg-query -W -f='${Package} ${Version}\n' milvus
ss -ltnp | rg '(:19530|:9091|:2379|:2380)'
```

macOS 上使用 Docker Desktop 部署 Local Milvus：

```bash
mkdir -p ~/milvus-local
cd ~/milvus-local
curl -sfL https://raw.githubusercontent.com/milvus-io/milvus/master/scripts/standalone_embed.sh \
    -o standalone_embed.sh
bash standalone_embed.sh start
```

索引前验证 container：

```bash
docker ps --filter name=milvus-standalone
curl -f http://localhost:9091/healthz
lsof -nP -iTCP:19530 -sTCP:LISTEN
```

macOS 上的 Docker Desktop 应至少为 VM 分配 2 vCPUs 和 8 GB memory。

Windows 上使用 Docker Desktop 部署 Local Milvus：

```powershell
mkdir $HOME\milvus-local
cd $HOME\milvus-local
Invoke-WebRequest https://raw.githubusercontent.com/milvus-io/milvus/refs/heads/master/scripts/standalone_embed.bat -OutFile standalone.bat
.\standalone.bat start
```

索引前验证 container：

```powershell
docker ps --filter name=milvus-standalone
curl.exe -f http://localhost:9091/healthz
netstat -ano | findstr ":19530"
```

Windows 上的 Docker Desktop 应使用 WSL 2 backend。把 Milvus data directory 放在普通用户拥有的文件夹中；如果 Docker Desktop 需要管理员权限，以 administrator 身份运行 PowerShell 或 Command Prompt。

MCP config 只需要本地 gRPC endpoint：

```conf
milvusAddress = localhost:19530
```

默认 local package install 不要设置 `milvusToken`。从 remote database 切换回来，或修改 embedding model/provider 后，需要重新索引受影响的 codebases，使 collection metadata 与当前 embedding configuration 匹配。

Self-hosted remote Milvus:

```conf
milvusAddress = your-milvus-host:19530
```

如果 self-hosted Milvus deployment 要求认证，添加 `milvusToken`：

```conf
milvusAddress = your-milvus-host:19530
milvusToken = your-milvus-token
```

Zilliz Cloud:

在 https://cloud.zilliz.com/signup 注册免费 Zilliz Cloud 数据库，然后配置 cloud endpoint 和 Personal Key：

```conf
milvusAddress = your-zilliz-cloud-public-endpoint
milvusToken = your-zilliz-cloud-personal-key
```

Optional database fields:

| Field | Description | Default |
| --- | --- | --- |
| `milvusUseRestful` | Reserved advanced option；当前 MCP startup path 使用 gRPC Milvus client | `false` |
| `milvusCollectionLimitCheckTimeoutMs` | collection-limit pre-check timeout | `15000` |
| `zillizBaseUrl` | Zilliz management API base URL | provider default |
| `hybridMode` | 启用 BM25 + dense vector hybrid search | `true` |

如果省略 `milvusAddress` 但设置了 `milvusToken`，token-based address resolution 用于 Zilliz Cloud。self-hosted remote Milvus 应显式设置 `milvusAddress`。

<a id="system-proxy"></a>

## System Proxy

Hitmux Context Engine 默认忽略系统代理环境变量。这可以避免 Local Milvus、Ollama 和其他 localhost services 意外经过桌面或 shell proxy。

代理控制按 dependency type 拆分：

| Field | Applies to | Default |
| --- | --- | --- |
| `embeddingUseSystemProxy` | OpenAI、OpenRouter、VoyageAI、Gemini 和 Ollama 等 embedding providers | `false` |
| `databaseUseSystemProxy` | Milvus-compatible vector database connections，包括 Local Milvus、self-hosted Milvus 和 Zilliz Cloud | `false` |

只启用实际需要代理的一侧。

Embedding provider 走系统代理，local Milvus 直连：

```conf
embeddingUseSystemProxy = true
databaseUseSystemProxy = false
```

Remote vector database 走系统代理，embedding 直连：

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = true
```

完全直连的本地 setup：

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = false
```

默认 local Milvus setup 保持 `databaseUseSystemProxy = false`。如果本地 database connection 出现 `14 UNAVAILABLE: No connection established` 等 gRPC errors，检查 shell 或 MCP client process 是否设置了 proxy variables，并保持 database proxy disabled。

## File Filtering

Additional extensions 和 ignore patterns 是增量配置。

```conf
customExtensions = .vue
customExtensions = .svelte
customExtensions = .astro
customIgnorePatterns = fixtures/**
customIgnorePatterns = tmp/**
customIgnorePatterns = *.backup
```

最终 file set 是：

```text
(default supported extensions + customExtensions)
- (default ignore patterns + customIgnorePatterns + ignore files)
```

Default ignore patterns 包括 dependency folders、build output、version control folders、caches、logs、temp files、minified bundles、source maps、`.env`、`.env.*` 和 `*.local`。

## Collection Identity

当 collection naming 需要跨路径稳定，或需要在多个 checkouts 间共享时，使用这些字段。

```conf
collectionNameOverride = my_project
codebaseIdentityMode = path
codebaseIdentity = shared-custom-identity
globalCollectionName = default
gitRemoteName = origin
```

`codebaseIdentityMode` 接受 `path`、`gitRemote`、`global` 或 `custom`。

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
# projectWatcherIgnoredDirs = node_modules
# projectWatcherIgnoredDirs = dist
# projectWatcherIgnoredDirs = build
```

Useful combinations:

- 设置 `backgroundSync = false` 可禁用 periodic polling，同时保留 trigger-based 和 project-watcher event sync。
- 在 read-only 或 sandboxed filesystems 上设置 `triggerWatcher = false`。
- 设置 `projectWatcher = false` 可强制使用较旧的 full change scan，再执行 automatic sync 和默认 `search_code` refreshes。
- 只有 native file events 不可靠时才设置 `projectWatcherUsePolling = true`。
- 当默认 watcher directory skips 与项目 indexed scope 不匹配时，设置 `projectWatcherIgnoredDirs`。
- 设置 `interactiveIndexing = false` 可阻止 `index_codebase` writes，同时仍允许 dry-run previews。
- 设置 `automaticIncrementalEffectiveLineLimit`，控制 automatic incremental sync 何时暂停并要求手动运行 `index_codebase` 且 `incremental=true`。

Trigger watcher 监听 `~/.hitmux-context-engine/.sync-trigger`。Touch 该文件会请求 debounced re-index。
Project watcher 在 MCP server 生命周期内为已索引 codebases 记录 dirty paths，并在 file events 后调度 debounced targeted sync。Clean projects 会跳过 full scans，直到 `projectWatcherFallbackScanIntervalMs` 触发 reconciliation。

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
# embeddingBatchSize = 64
# embeddingConcurrency = 2
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
