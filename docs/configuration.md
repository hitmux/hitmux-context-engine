# Configuration

Hitmux Context Engine reads runtime options from JSONC files:

1. `~/.hitmux-context-engine/config.jsonc`
2. `./.hitmux-context-engine/config.jsonc`
3. built-in defaults

Project config overrides global config for fields that are present. Keep secret fields commented until you need them; an uncommented empty string overrides the global value.

Environment variables and `~/.hitmux-context-engine/.env` are not used for MCP product options.

## Minimal Config

```bash
mkdir -p ~/.hitmux-context-engine
cat > ~/.hitmux-context-engine/config.jsonc << 'EOF'
{
    "embeddingProvider": "OpenRouter",
    "embeddingModel": "qwen/qwen3-embedding-4b",
    "openrouterApiKey": "sk-or-your-openrouter-api-key",
    "milvusAddress": "localhost:19530"
}
EOF
```

Add the MCP server without `env` entries:

```bash
claude mcp add hitmux-context-engine -- npx @hitmux/hitmux-context-engine-mcp@latest
codex mcp add hitmux-context-engine -- npx @hitmux/hitmux-context-engine-mcp@latest
```

For a local source checkout, `./scripts/install-local-global.sh` builds the MCP package and installs a user-level `hitmux-context-engine-mcp` command. Run it with `sudo` for a global install. Use that installed command in client setup, such as `claude mcp add hitmux-context-engine -- hitmux-context-engine-mcp` or `codex mcp add hitmux-context-engine -- hitmux-context-engine-mcp`.

Database note: Use Local Milvus with `"milvusAddress": "localhost:19530"`. For self-hosted remote Milvus, replace it with the reachable host and port. For Zilliz Cloud, use the cloud public endpoint and add `"milvusToken"` with your Personal Key.

## Embedding Providers

OpenRouter is the default provider.

```jsonc
{
    "embeddingProvider": "OpenRouter",
    "embeddingModel": "qwen/qwen3-embedding-4b",
    "openrouterApiKey": "sk-or-your-openrouter-api-key"
}
```

Database fields are configured separately in [Vector Database](#vector-database).

OpenAI:

```jsonc
{
    "embeddingProvider": "OpenAI",
    "embeddingModel": "text-embedding-3-small",
    "openaiApiKey": "sk-your-openai-api-key",
    "openaiBaseUrl": "https://api.openai.com/v1"
}
```

Database fields are configured separately in [Vector Database](#vector-database).

VoyageAI:

```jsonc
{
    "embeddingProvider": "VoyageAI",
    "embeddingModel": "voyage-code-3",
    "voyageaiApiKey": "pa-your-voyageai-api-key"
}
```

Database fields are configured separately in [Vector Database](#vector-database).

Gemini:

```jsonc
{
    "embeddingProvider": "Gemini",
    "embeddingModel": "gemini-embedding-001",
    "geminiApiKey": "your-gemini-api-key",
    "geminiBaseUrl": "https://generativelanguage.googleapis.com"
}
```

Database fields are configured separately in [Vector Database](#vector-database).

Ollama:

```jsonc
{
    "embeddingProvider": "Ollama",
    "embeddingModel": "nomic-embed-text",
    "ollamaHost": "http://127.0.0.1:11434"
}
```

Database fields are configured separately in [Vector Database](#vector-database).

## Vector Database

Hitmux Context Engine currently supports Milvus-compatible vector storage through `config.jsonc`. This includes Local Milvus, self-hosted remote Milvus, and Zilliz Cloud. SQLite, Chroma, Qdrant, LanceDB, and other database backends are not selectable from `config.jsonc`.

Local Milvus:

```jsonc
{
    "milvusAddress": "localhost:19530"
}
```

Self-hosted remote Milvus:

```jsonc
{
    "milvusAddress": "your-milvus-host:19530"
}
```

If your self-hosted Milvus deployment requires authentication, add `milvusToken`:

```jsonc
{
    "milvusAddress": "your-milvus-host:19530",
    "milvusToken": "your-milvus-token"
}
```

Zilliz Cloud:

```jsonc
{
    "milvusAddress": "your-zilliz-cloud-public-endpoint",
    "milvusToken": "your-zilliz-cloud-personal-key"
}
```

Optional database fields:

| Field | Description | Default |
| --- | --- | --- |
| `milvusUseRestful` | Reserved advanced option; the current MCP startup path uses the gRPC Milvus client | `false` |
| `milvusCollectionLimitCheckTimeoutMs` | Timeout for collection-limit pre-check | `15000` |
| `zillizBaseUrl` | Zilliz management API base URL | provider default |
| `hybridMode` | Enable BM25 + dense vector hybrid search | `true` |

If `milvusAddress` is omitted and `milvusToken` is set, token-based address resolution is intended for Zilliz Cloud. For self-hosted remote Milvus, set `milvusAddress` explicitly.

## File Filtering

Additional extensions and ignore patterns are additive.

```jsonc
{
    "customExtensions": [".vue", ".svelte", ".astro"],
    "customIgnorePatterns": ["fixtures/**", "tmp/**", "*.backup"]
}
```

The final file set is:

```text
(default supported extensions + customExtensions)
- (default ignore patterns + customIgnorePatterns + ignore files)
```

Default ignore patterns include dependency folders, build output, version control folders, caches, logs, temp files, minified bundles, source maps, `.env`, `.env.*`, and `*.local`.

## Collection Identity

Use these fields when collection naming needs to be stable across paths or shared across checkouts.

```jsonc
{
    "collectionNameOverride": "my_project",
    "codebaseIdentityMode": "path",
    "codebaseIdentity": "shared-custom-identity",
    "globalCollectionName": "default",
    "gitRemoteName": "origin"
}
```

`codebaseIdentityMode` accepts `path`, `gitRemote`, `global`, or `custom`.

## Indexing And Sync

```jsonc
{
    "autoIndexing": true,
    "interactiveIndexing": true,
    "backgroundSync": true,
    "syncIntervalMs": 300000,
    "syncLockStaleMs": 600000,
    "triggerWatcher": true
}
```

Useful combinations:

- Set `"backgroundSync": false` to disable periodic polling while keeping trigger-based sync.
- Set `"triggerWatcher": false` on read-only or sandboxed filesystems.
- Set `"interactiveIndexing": false` to block `index_codebase` writes while still allowing dry-run previews.

The trigger watcher listens to `~/.hitmux-context-engine/.sync-trigger`. Touching that file requests a debounced re-index.

## Full Template

```jsonc
{
    "embeddingProvider": "OpenRouter",
    "embeddingModel": "qwen/qwen3-embedding-4b",

    "openrouterApiKey": "sk-or-your-openrouter-api-key",
    "openaiApiKey": "sk-your-openai-api-key",
    "openaiBaseUrl": "https://api.openai.com/v1",
    "voyageaiApiKey": "pa-your-voyageai-api-key",
    "geminiApiKey": "your-gemini-api-key",
    "geminiBaseUrl": "https://generativelanguage.googleapis.com",
    "ollamaModel": "nomic-embed-text",
    "ollamaHost": "http://127.0.0.1:11434",

    "milvusAddress": "localhost:19530",
    "milvusToken": "your-zilliz-or-milvus-token",
    "milvusUseRestful": false,
    "milvusCollectionLimitCheckTimeoutMs": 15000,
    "zillizBaseUrl": "https://api.cloud.zilliz.com",

    "collectionNameOverride": "my_project",
    "codebaseIdentityMode": "path",
    "codebaseIdentity": "shared-custom-identity",
    "globalCollectionName": "default",
    "gitRemoteName": "origin",
    "hybridMode": true,

    "searchTimeoutMs": 30000,
    "embeddingBatchSize": 100,
    "embeddingConcurrency": 1,
    "customExtensions": [".vue", ".svelte", ".astro"],
    "customIgnorePatterns": ["temp/**", "*.backup"],
    "merkleSnapshotMaxBytes": 52428800,

    "autoIndexing": true,
    "interactiveIndexing": true,
    "backgroundSync": true,
    "syncIntervalMs": 300000,
    "syncLockStaleMs": 600000,
    "triggerWatcher": true,

    "splitterType": "ast",
    "searchTopK": 5,
    "searchThreshold": 0
}
```
