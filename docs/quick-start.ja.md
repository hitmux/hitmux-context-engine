# Quick Start

Language: [English](quick-start.md) | [中文](quick-start.zh-CN.md) | [Español](quick-start.es.md) | [Français](quick-start.fr.md) | [Deutsch](quick-start.de.md) | 日本語 | [한국어](quick-start.ko.md)

このページでは MCP clients から Hitmux Context Engine を起動する方法を説明します。product configuration は `~/.hitmux-context-engine/config.conf` または project 内の `.hitmux-context-engine/config.conf` にあります。MCP client configuration は stdio server を起動するだけです。

## Product Config

短い CLI を global install し、config を作成します。

```bash
npm install -g @hitmux/hce@latest
hce init
```

次に `~/.hitmux-context-engine/config.conf` を編集し、provider key を入れて実行します。

```bash
hce doctor
```

local checks だけなら `hce doctor --no-connectivity` を使います。Local Milvus は `milvusAddress = localhost:19530` を使います。無料の Zilliz Cloud database は https://cloud.zilliz.com/signup で登録し、public endpoint を `milvusAddress`、Personal Key を `milvusToken` に設定します。

Hitmux Context Engine は default で system proxy variables を継承しません。provider または vector database が proxy を必要とするときだけ `embeddingUseSystemProxy` と `databaseUseSystemProxy` を設定します。詳しくは [Configuration](configuration.ja.md#system-proxy) を参照してください。

引数なしの `hce` は MCP stdio server mode です。

```bash
hce
```

indexing 後、repository root で `hce status .` を実行すると状態を確認できます。

## Claude Code

```bash
npm install -g @hitmux/hce@latest
claude mcp add hitmux-context-engine -- hce
```

`config.conf` 編集後は再接続します。

```text
/mcp reconnect hitmux-context-engine
```

## OpenAI Codex CLI

```bash
npm install -g @hitmux/hce@latest
codex mcp add hitmux-context-engine -- hce
```

`~/.codex/config.toml` を直接編集することもできます。

```toml
[mcp_servers.hitmux-context-engine]
command = "hce"
args = []
startup_timeout_sec = 20
```

## OpenCode

global config は `~/.config/opencode/opencode.json`、project-local config は `opencode.json` です。

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

Cursor、Windsurf、Claude Desktop、Gemini CLI、Qwen Code、Cline、Roo Code は通常 `mcpServers` を使います。

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

Windows で client が global npm shim を見つけられない場合は `hce.cmd` を使います。

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

VS Code MCP は通常 `servers` を使います。

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

公開 package ではなく現在の checkout を使う場合:

```bash
./scripts/install-local-global.sh
```

この script は Node.js と pnpm versions を確認し、lockfile から dependencies を install し、`@hitmux/hitmux-context-engine-mcp` を build して、`packages/mcp/dist/index.js` を指す wrapper `hitmux-context-engine-mcp` を install します。`sudo` 付きでは `/usr/local/bin/hitmux-context-engine-mcp` に install します。

JSON clients の例:

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

新しい repository では、repository root で最初の index を作成します。

```bash
hce index .
```

その後 MCP client を repository で開き、次のように質問します。

```text
Check the indexing status
Find functions that handle user authentication
```

`config.conf` を編集した後は MCP server を reconnect または restart してください。
