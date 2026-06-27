# Troubleshooting

Language: [English](troubleshooting.md) | 中文 | [Español](troubleshooting.es.md) | [Français](troubleshooting.fr.md) | [Deutsch](troubleshooting.de.md) | [日本語](troubleshooting.ja.md) | [한국어](troubleshooting.ko.md)

## Check Indexing Status First

让 MCP client 运行：

```text
Check the indexing status
```

这会调用 `get_indexing_status`，通常会显示 indexing progress、completed state 或最近一次 indexing error。

## Check Configuration

Hitmux Context Engine 从以下位置读取产品配置：

1. `~/.hitmux-context-engine/config.conf`
2. `./.hitmux-context-engine/config.conf`
3. built-in defaults

环境变量和 `~/.hitmux-context-engine/.env` 不用于 MCP 产品选项。

常见检查：

- 当前 `embeddingProvider` 有对应 API key 字段，例如 `openrouterApiKey`、`openaiApiKey`、`voyageaiApiKey` 或 `geminiApiKey`。
- Local Milvus 使用 `milvusAddress = localhost:19530`。
- Self-hosted remote Milvus 使用可访问的 host 和 port 作为 `milvusAddress`；只有服务端要求认证时才设置 `milvusToken`。
- Zilliz Cloud 可从免费注册页 https://cloud.zilliz.com/signup 创建，然后使用 cloud public endpoint 作为 `milvusAddress`，Personal Key 写入 `milvusToken`。
- SQLite、Chroma、Qdrant、LanceDB 和其他数据库 backend 不能通过 `config.conf` 选择。
- Project-level `.hitmux-context-engine/config.conf` 没有用空值覆盖 global secret。

## System Proxy

Hitmux Context Engine 默认不继承系统代理环境变量，包括 `http_proxy`、`https_proxy`、`all_proxy`、`grpc_proxy` 和 `no_proxy`。

代理使用按 dependency type 拆分：

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = false
```

- `embeddingUseSystemProxy` 只影响 OpenAI、OpenRouter、VoyageAI、Gemini 和 Ollama 等 embedding providers。
- `databaseUseSystemProxy` 只影响 Milvus / Zilliz vector database connections。

Local Milvus 和 local Ollama 通常应保持这些字段为 `false`。如果 OpenRouter 或 OpenAI 等 embedding endpoint 必须使用系统代理，只启用：

```conf
embeddingUseSystemProxy = true
databaseUseSystemProxy = false
```

如果 remote Milvus / Zilliz endpoint 必须使用系统代理，只启用：

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = true
```

检查代理环境变量：

```bash
env | grep -i proxy
```

如果 local Milvus 报告 `14 UNAVAILABLE: No connection established`，先确认 `databaseUseSystemProxy = false`，再重新连接或重启 MCP server。

## Reconnect After Config Changes

编辑 `config.conf` 后，重新连接或重启 MCP server。

Claude Code:

```text
/mcp reconnect hitmux-context-engine
```

Gemini CLI:

```text
/mcp refresh
```

GUI MCP clients 通常在 MCP settings 中提供 restart、reconnect 或 enable/disable 控件。

## Get Logs

Claude Code 和 Gemini CLI：

```bash
claude --debug
gemini --debug
```

Cursor、Windsurf、Cline 和 Roo Code 通常会在 Output panel 中暴露 MCP logs。

报告 issue 时包含：

- MCP client name 和 version。
- MCP client server config。
- 已脱敏的 `config.conf`。
- `get_indexing_status` output。
- 相关 debug logs。

## Windows: `spawn C:\Windows\system32\cmd.exe ENOENT`

这个错误由 MCP client 在 Hitmux Context Engine 启动前抛出。检查：

```powershell
Test-Path "$env:SystemRoot\System32\cmd.exe"
Get-Command node
Get-Command npm
Get-Command hce
```

如果 `cmd.exe` 缺失，修复 Windows 或把 `ComSpec` 恢复为 `%SystemRoot%\System32\cmd.exe`。如果 `hce` 缺失，运行 `npm install -g @hitmux/hce@latest` 并重启 MCP client。

无法正确解析全局 npm shim 的 clients 可以使用 `hce.cmd`：

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

`get_indexing_status` 读取本地 MCP snapshot metadata。如果 completed entry 显示 zero counts：

1. 确认正在检查的 absolute path 与最初 indexing run 使用的是同一个 path。
2. 对该 path 运行 `clear_index`。
3. 对同一个 path 再次运行 `index_codebase`。

## Fully Local Setup

Fully local setup 可以使用 Local Milvus 和 Ollama：

```conf
embeddingProvider = Ollama
embeddingModel = nomic-embed-text
ollamaHost = http://127.0.0.1:11434
milvusAddress = localhost:19530
```
