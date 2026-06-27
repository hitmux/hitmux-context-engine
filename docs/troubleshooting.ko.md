# Troubleshooting

Language: [English](troubleshooting.md) | [中文](troubleshooting.zh-CN.md) | [Español](troubleshooting.es.md) | [Français](troubleshooting.fr.md) | [Deutsch](troubleshooting.de.md) | [日本語](troubleshooting.ja.md) | 한국어

## Check Indexing Status First

MCP client에 다음을 실행하게 합니다.

```text
Check the indexing status
```

이 명령은 `get_indexing_status`를 호출하며 보통 indexing progress, completed state 또는 최신 indexing error를 보여줍니다.

## Check Configuration

Hitmux Context Engine은 `~/.hitmux-context-engine/config.conf`, `./.hitmux-context-engine/config.conf`, built-in defaults에서 configuration을 읽습니다. 환경 변수와 `~/.hitmux-context-engine/.env`는 MCP options에 사용되지 않습니다.

일반적인 확인 항목:

- active `embeddingProvider`에 맞는 API key가 있는지: `openrouterApiKey`, `openaiApiKey`, `voyageaiApiKey`, `geminiApiKey`.
- Local Milvus는 `milvusAddress = localhost:19530`을 사용하는지.
- Remote Milvus는 접근 가능한 host와 port를 사용하는지. `milvusToken`은 server가 auth를 요구할 때만 설정.
- Zilliz Cloud는 https://cloud.zilliz.com/signup 에서 만들고 public endpoint를 `milvusAddress`, Personal Key를 `milvusToken`에 설정.
- SQLite, Chroma, Qdrant, LanceDB 등은 `config.conf`에서 선택할 수 없습니다.
- project-level `.hitmux-context-engine/config.conf`가 global secret을 빈 값으로 override하지 않는지.

## System Proxy

기본적으로 `http_proxy`, `https_proxy`, `all_proxy`, `grpc_proxy`, `no_proxy`를 상속하지 않습니다.

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = false
```

`embeddingUseSystemProxy`는 OpenAI, OpenRouter, VoyageAI, Gemini, Ollama에 영향을 줍니다. `databaseUseSystemProxy`는 Milvus/Zilliz connections에 영향을 줍니다. Local Milvus와 local Ollama는 보통 `false`로 둡니다.

proxy variables를 확인합니다.

```bash
env | grep -i proxy
```

Local Milvus가 `14 UNAVAILABLE: No connection established`를 반환하면 먼저 `databaseUseSystemProxy = false`를 확인하고 MCP server를 reconnect 또는 restart하세요.

## Reconnect After Config Changes

`config.conf`를 편집한 뒤 MCP server를 reconnect 또는 restart합니다.

Claude Code:

```text
/mcp reconnect hitmux-context-engine
```

Gemini CLI:

```text
/mcp refresh
```

GUI MCP clients는 보통 MCP settings에 restart, reconnect, enable/disable controls를 제공합니다.

## Get Logs

Claude Code와 Gemini CLI:

```bash
claude --debug
gemini --debug
```

Cursor, Windsurf, Cline, Roo Code는 보통 Output panel에 MCP logs를 표시합니다.

issue를 보고할 때는 MCP client name/version, server config, redacted `config.conf`, `get_indexing_status` output, 관련 debug logs를 포함하세요.

## Windows: `spawn C:\Windows\system32\cmd.exe ENOENT`

이 error는 Hitmux Context Engine이 시작되기 전에 MCP client 쪽에서 발생합니다. 확인:

```powershell
Test-Path "$env:SystemRoot\System32\cmd.exe"
Get-Command node
Get-Command npm
Get-Command hce
```

`hce`가 없으면 `npm install -g @hitmux/hce@latest`를 실행하고 MCP client를 restart합니다. global npm shim을 resolve하지 못하는 client는 `hce.cmd`를 사용합니다.

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

`get_indexing_status`는 local MCP snapshot metadata를 읽습니다. completed entry가 zero counts를 보이면:

1. original indexing run과 같은 absolute path를 확인 중인지 확인합니다.
2. 해당 path에 `clear_index`를 실행합니다.
3. 같은 path에 `index_codebase`를 다시 실행합니다.

## Fully Local Setup

완전 local setup은 Local Milvus와 Ollama를 사용할 수 있습니다.

```conf
embeddingProvider = Ollama
embeddingModel = nomic-embed-text
ollamaHost = http://127.0.0.1:11434
milvusAddress = localhost:19530
```
