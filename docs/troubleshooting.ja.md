# Troubleshooting

Language: [English](troubleshooting.md) | [中文](troubleshooting.zh-CN.md) | [Español](troubleshooting.es.md) | [Français](troubleshooting.fr.md) | [Deutsch](troubleshooting.de.md) | 日本語 | [한국어](troubleshooting.ko.md)

## Check Indexing Status First

MCP client に次を実行させます。

```text
Check the indexing status
```

これは `get_indexing_status` を呼び、通常は indexing progress、completed state、または最新の indexing error を表示します。

## Check Configuration

Hitmux Context Engine は `~/.hitmux-context-engine/config.conf`、`./.hitmux-context-engine/config.conf`、built-in defaults から configuration を読みます。環境変数と `~/.hitmux-context-engine/.env` は MCP options には使われません。

よくある確認項目:

- active な `embeddingProvider` に対応する API key があること: `openrouterApiKey`、`openaiApiKey`、`voyageaiApiKey`、`geminiApiKey`。
- Local Milvus は `milvusAddress = localhost:19530` を使うこと。
- Remote Milvus は到達可能な host と port を使うこと。`milvusToken` は server が auth を要求する場合だけ設定。
- Zilliz Cloud は https://cloud.zilliz.com/signup から作成し、public endpoint を `milvusAddress`、Personal Key を `milvusToken` に設定。
- SQLite、Chroma、Qdrant、LanceDB などは `config.conf` から選択できません。
- project-level `.hitmux-context-engine/config.conf` が global secret を空値で上書きしていないこと。

## System Proxy

default では `http_proxy`、`https_proxy`、`all_proxy`、`grpc_proxy`、`no_proxy` を継承しません。

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = false
```

`embeddingUseSystemProxy` は OpenAI、OpenRouter、VoyageAI、Gemini、Ollama に影響します。`databaseUseSystemProxy` は Milvus/Zilliz connections に影響します。Local Milvus と local Ollama は通常 `false` のままにします。

proxy variables を確認します。

```bash
env | grep -i proxy
```

Local Milvus が `14 UNAVAILABLE: No connection established` を返す場合、まず `databaseUseSystemProxy = false` を確認してから MCP server を reconnect または restart してください。

## Reconnect After Config Changes

`config.conf` 編集後は MCP server を reconnect または restart します。

Claude Code:

```text
/mcp reconnect hitmux-context-engine
```

Gemini CLI:

```text
/mcp refresh
```

GUI MCP clients では MCP settings に restart、reconnect、enable/disable の controls があることが多いです。

## Get Logs

Claude Code と Gemini CLI:

```bash
claude --debug
gemini --debug
```

Cursor、Windsurf、Cline、Roo Code は通常 Output panel に MCP logs を表示します。

issue を報告するときは MCP client name/version、server config、redacted `config.conf`、`get_indexing_status` output、関連 debug logs を含めてください。

## Windows: `spawn C:\Windows\system32\cmd.exe ENOENT`

この error は Hitmux Context Engine が起動する前に MCP client 側で発生します。確認:

```powershell
Test-Path "$env:SystemRoot\System32\cmd.exe"
Get-Command node
Get-Command npm
Get-Command hce
```

`hce` がない場合は `npm install -g @hitmux/hce@latest` を実行し、MCP client を restart します。global npm shim を解決できない client では `hce.cmd` を使います。

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

`get_indexing_status` は local MCP snapshot metadata を読みます。completed entry が zero counts を示す場合:

1. original indexing run と同じ absolute path を見ていることを確認します。
2. その path に対して `clear_index` を実行します。
3. 同じ path に対して `index_codebase` を再実行します。

## Fully Local Setup

完全 local setup は Local Milvus と Ollama を使えます。

```conf
embeddingProvider = Ollama
embeddingModel = nomic-embed-text
ollamaHost = http://127.0.0.1:11434
milvusAddress = localhost:19530
```
