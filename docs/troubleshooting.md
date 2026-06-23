# Troubleshooting

## Check Indexing Status First

Ask the MCP client to run:

```text
Check the indexing status
```

This calls `get_indexing_status` and usually shows indexing progress, completed state, or the most recent indexing error.

## Check Configuration

Hitmux Context Engine reads product configuration from:

1. `~/.hitmux-context-engine/config.conf`
2. `./.hitmux-context-engine/config.conf`
3. built-in defaults

Environment variables and `~/.hitmux-context-engine/.env` are not used for MCP product options.

Common checks:

- The active `embeddingProvider` has its matching API key field, such as `openrouterApiKey`, `openaiApiKey`, `voyageaiApiKey`, or `geminiApiKey`.
- Local Milvus uses `milvusAddress = localhost:19530`.
- Self-hosted remote Milvus uses a reachable host and port as `milvusAddress`; set `milvusToken` only when the server requires authentication.
- Zilliz Cloud can be created from the free signup page at https://cloud.zilliz.com/signup, then uses the cloud public endpoint as `milvusAddress`, with the Personal Key in `milvusToken`.
- SQLite, Chroma, Qdrant, LanceDB, and other database backends cannot be selected through `config.conf`.
- The project-level `.hitmux-context-engine/config.conf` is not overriding a global secret with an empty value.

## System Proxy

Hitmux Context Engine does not inherit system proxy environment variables by default, including `http_proxy`, `https_proxy`, `all_proxy`, `grpc_proxy`, and `no_proxy`.

Proxy use is split by dependency type:

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = false
```

- `embeddingUseSystemProxy` only affects embedding providers such as OpenAI, OpenRouter, VoyageAI, Gemini, and Ollama.
- `databaseUseSystemProxy` only affects Milvus / Zilliz vector database connections.

Local Milvus and local Ollama normally should keep these fields set to `false`. If an embedding endpoint such as OpenRouter or OpenAI must use the system proxy, enable only:

```conf
embeddingUseSystemProxy = true
databaseUseSystemProxy = false
```

If a remote Milvus / Zilliz endpoint must use the system proxy, enable only:

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = true
```

Check proxy environment variables with:

```bash
env | grep -i proxy
```

If local Milvus reports `14 UNAVAILABLE: No connection established`, first confirm `databaseUseSystemProxy = false`, then reconnect or restart the MCP server.

## Reconnect After Config Changes

After editing `config.conf`, reconnect or restart the MCP server.

Claude Code:

```text
/mcp reconnect hitmux-context-engine
```

Gemini CLI:

```text
/mcp refresh
```

GUI MCP clients usually provide restart, reconnect, or enable/disable controls in MCP settings.

## Get Logs

Claude Code and Gemini CLI:

```bash
claude --debug
gemini --debug
```

Cursor, Windsurf, Cline, and Roo Code usually expose MCP logs in an Output panel.

When reporting an issue, include:

- MCP client name and version.
- MCP client server config.
- Redacted `config.conf`.
- `get_indexing_status` output.
- Relevant debug logs.

## Windows: `spawn C:\Windows\system32\cmd.exe ENOENT`

This error is thrown by the MCP client before Hitmux Context Engine starts. Check:

```powershell
Test-Path "$env:SystemRoot\System32\cmd.exe"
Get-Command node
Get-Command npm
Get-Command hce
```

If `cmd.exe` is missing, repair Windows or restore `ComSpec` to `%SystemRoot%\System32\cmd.exe`. If `hce` is missing, run `npm install -g @hitmux/hce@latest` and restart the MCP client.

Clients that cannot resolve the global npm shim correctly can use `hce.cmd`:

```json
{
  "mcpServers": {
    "hitmux-context-engine": {
      "command": "hce.cmd",
      "args": []
    }
  }
}
```

## Completed Status Shows `0 files, 0 chunks`

`get_indexing_status` reads local MCP snapshot metadata. If a completed entry shows zero counts:

1. Confirm that you are checking the same absolute path used during the original indexing run.
2. Run `clear_index` for that path.
3. Run `index_codebase` again for the same path.

## Fully Local Setup

A fully local setup can use Local Milvus with Ollama:

```conf
embeddingProvider = Ollama
embeddingModel = nomic-embed-text
ollamaHost = http://127.0.0.1:11434
milvusAddress = localhost:19530
```
