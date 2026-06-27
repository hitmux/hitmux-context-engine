# Quick Start

Language: [English](quick-start.md) | [中文](quick-start.zh-CN.md) | [Español](quick-start.es.md) | [Français](quick-start.fr.md) | [Deutsch](quick-start.de.md) | [日本語](quick-start.ja.md) | 한국어

이 페이지는 MCP clients에서 Hitmux Context Engine을 시작하는 방법을 설명합니다. Product configuration은 `~/.hitmux-context-engine/config.conf` 또는 project 안의 `.hitmux-context-engine/config.conf`에 있습니다. MCP client configuration은 stdio server를 시작하기만 합니다.

## Product Config

짧은 CLI를 global install하고 config를 만듭니다.

```bash
npm install -g @hitmux/hce@latest
hce init
```

그다음 `~/.hitmux-context-engine/config.conf`를 편집해 provider key를 넣고 실행합니다.

```bash
hce doctor
```

local checks만 원하면 `hce doctor --no-connectivity`를 사용합니다. Local Milvus는 `milvusAddress = localhost:19530`을 사용합니다. 무료 Zilliz Cloud database는 https://cloud.zilliz.com/signup 에서 가입하고 public endpoint를 `milvusAddress`, Personal Key를 `milvusToken`에 설정합니다.

Hitmux Context Engine은 기본적으로 system proxy variables를 상속하지 않습니다. provider 또는 vector database가 proxy를 필요로 할 때만 `embeddingUseSystemProxy`와 `databaseUseSystemProxy`를 설정하세요. 자세한 내용은 [Configuration](configuration.ko.md#system-proxy)를 참고하세요.

인자 없는 `hce`는 MCP stdio server mode입니다.

```bash
hce
```

indexing 후 repository root에서 `hce status .`로 상태를 확인할 수 있습니다.

## Claude Code

```bash
npm install -g @hitmux/hce@latest
claude mcp add hitmux-context-engine -- hce
```

`config.conf` 편집 후 재연결합니다.

```text
/mcp reconnect hitmux-context-engine
```

## OpenAI Codex CLI

```bash
npm install -g @hitmux/hce@latest
codex mcp add hitmux-context-engine -- hce
```

`~/.codex/config.toml`을 직접 편집할 수도 있습니다.

```toml
[mcp_servers.hitmux-context-engine]
command = "hce"
args = []
startup_timeout_sec = 20
```

## OpenCode

global config는 `~/.config/opencode/opencode.json`, project-local config는 `opencode.json`입니다.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "hitmux-context-engine": {
      "type": "local",
      "command": ["hce"],
      "enabled": true
    }
  }
}
```

## JSON Clients

Cursor, Windsurf, Claude Desktop, Gemini CLI, Qwen Code, Cline, Roo Code는 보통 `mcpServers`를 사용합니다.

```json
{
  "mcpServers": {
    "hitmux-context-engine": {
      "command": "hce",
      "args": []
    }
  }
}
```

Windows에서 client가 global npm shim을 찾지 못하면 `hce.cmd`를 사용합니다.

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

VS Code MCP는 보통 `servers`를 사용합니다.

```json
{
  "servers": {
    "hitmux-context-engine": {
      "type": "stdio",
      "command": "hce",
      "args": []
    }
  }
}
```

## Local Source Install

published package 대신 현재 checkout을 사용하려면:

```bash
./scripts/install-local-global.sh
```

이 script는 Node.js와 pnpm versions를 확인하고, lockfile에서 dependencies를 설치하고, `@hitmux/hitmux-context-engine-mcp`를 build한 뒤 `packages/mcp/dist/index.js`를 가리키는 wrapper `hitmux-context-engine-mcp`를 설치합니다. `sudo`로 실행하면 `/usr/local/bin/hitmux-context-engine-mcp`에 설치합니다.

JSON clients 예시:

```json
{
  "mcpServers": {
    "hitmux-context-engine": {
      "command": "hitmux-context-engine-mcp",
      "args": []
    }
  }
}
```

## Use In A Repository

새 repository에서는 repository root에서 첫 index를 만듭니다.

```bash
hce index .
```

그다음 repository에서 MCP client를 열고 질문합니다.

```text
Check the indexing status
Find functions that handle user authentication
```

`config.conf`를 편집한 뒤 MCP server를 reconnect 또는 restart하세요.
