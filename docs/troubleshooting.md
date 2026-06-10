# Troubleshooting

## Check Indexing Status First

Ask the MCP client:

```text
Check the indexing status
```

This calls `get_indexing_status` and usually shows progress, completion, or the last indexing error.

## Check Configuration

Hitmux Context Engine reads product options from:

1. `~/.hitmux-context-engine/config.jsonc`
2. `./.hitmux-context-engine/config.jsonc`
3. built-in defaults

Environment variables and `~/.hitmux-context-engine/.env` are not used for MCP product options.

Common checks:

- The active provider has the matching API key field, such as `openrouterApiKey`, `openaiApiKey`, `voyageaiApiKey`, or `geminiApiKey`.
- Local Milvus uses `"milvusAddress": "localhost:19530"`.
- Self-hosted remote Milvus uses the reachable host and port as `milvusAddress`; add `milvusToken` only if authentication is required.
- Zilliz Cloud uses the cloud public endpoint as `milvusAddress` and the Personal Key as `milvusToken`.
- SQLite, Chroma, Qdrant, LanceDB, and other database backends are not selectable from `config.jsonc`.
- Project config does not accidentally override global secrets with empty strings.

## Reconnect After Config Changes

After changing JSONC config, reconnect or restart the MCP server.

Claude Code:

```text
/mcp reconnect hitmux-context-engine
```

Gemini CLI:

```text
/mcp refresh
```

GUI MCP clients usually have a restart, reconnect, or enable/disable toggle in their MCP settings.

## Get Logs

Claude Code and Gemini CLI:

```bash
claude --debug
gemini --debug
```

Cursor-like IDEs usually expose MCP logs in the Output panel.

When reporting an issue, include:

- MCP client name and version.
- MCP client server config.
- Redacted `config.jsonc`.
- `get_indexing_status` output.
- Relevant debug logs.

## Windows: `spawn C:\Windows\system32\cmd.exe ENOENT`

This is raised by the MCP client before Hitmux Context Engine starts. Check:

```powershell
Test-Path "$env:SystemRoot\System32\cmd.exe"
Get-Command node
Get-Command npm
Get-Command npx
```

If `cmd.exe` is missing, repair Windows or restore `ComSpec` to `%SystemRoot%\System32\cmd.exe`. If `npx` is missing, reinstall Node.js from the official Windows installer and restart the MCP client.

For clients that do not resolve npm shims correctly, use `npx.cmd`:

```json
{
  "mcpServers": {
    "hitmux-context-engine": {
      "command": "npx.cmd",
      "args": ["-y", "@hitmux/hitmux-context-engine-mcp@latest"]
    }
  }
}
```

## Completed Status Shows `0 files, 0 chunks`

`get_indexing_status` reads local MCP snapshot metadata. If a completed entry shows zero counts:

1. Confirm you are checking the same absolute path originally indexed.
2. Run `clear_index` for that path.
3. Run `index_codebase` again for the same path.

## Fully Local Setup

Use Local Milvus plus Ollama:

```jsonc
{
    "embeddingProvider": "Ollama",
    "embeddingModel": "nomic-embed-text",
    "ollamaHost": "http://127.0.0.1:11434",
    "milvusAddress": "localhost:19530"
}
```

Database note: Use Local Milvus with `"milvusAddress": "localhost:19530"`. For self-hosted remote Milvus, replace it with the reachable host and port. For Zilliz Cloud, use the cloud public endpoint and add `"milvusToken"` with your Personal Key.
