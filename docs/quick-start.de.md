# Quick Start

Sprache: [English](quick-start.md) | [中文](quick-start.zh-CN.md) | [Español](quick-start.es.md) | [Français](quick-start.fr.md) | Deutsch | [日本語](quick-start.ja.md) | [한국어](quick-start.ko.md)

Diese Seite zeigt, wie Hitmux Context Engine aus MCP-Clients gestartet wird. Die Produktkonfiguration liegt in `~/.hitmux-context-engine/config.conf` oder projektlokal in `.hitmux-context-engine/config.conf`. Die MCP client-Konfiguration startet nur den stdio server.

## Product Config

Kurzes CLI global installieren und Konfiguration erstellen:

```bash
npm install -g @hitmux/hce@latest
hce init
```

Danach `~/.hitmux-context-engine/config.conf` bearbeiten, provider key eintragen und ausführen:

```bash
hce doctor
```

`hce doctor --no-connectivity` führt nur lokale Checks aus. Local Milvus nutzt `milvusAddress = localhost:19530`. Für kostenlose Zilliz Cloud database unter https://cloud.zilliz.com/signup registrieren, public endpoint als `milvusAddress` nutzen und Personal Key in `milvusToken` setzen.

Hitmux Context Engine übernimmt standardmäßig keine system proxy variables. `embeddingUseSystemProxy` und `databaseUseSystemProxy` nur setzen, wenn provider oder vector database einen Proxy brauchen; siehe [Configuration](configuration.de.md#system-proxy).

`hce` ohne Argumente ist der MCP stdio server mode:

```bash
hce
```

Nach dem Indexing kann der Status aus dem Repository-Root mit `hce status .` geprüft werden.

## Claude Code

```bash
npm install -g @hitmux/hce@latest
claude mcp add hitmux-context-engine -- hce
```

Nach Änderungen an `config.conf` neu verbinden:

```text
/mcp reconnect hitmux-context-engine
```

## OpenAI Codex CLI

```bash
npm install -g @hitmux/hce@latest
codex mcp add hitmux-context-engine -- hce
```

Alternativ `~/.codex/config.toml` bearbeiten:

```toml
[mcp_servers.hitmux-context-engine]
command = "hce"
args = []
startup_timeout_sec = 20
```

## OpenCode

Globale Konfiguration in `~/.config/opencode/opencode.json` oder lokale `opencode.json`:

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

Cursor, Windsurf, Claude Desktop, Gemini CLI, Qwen Code, Cline und Roo Code nutzen meist `mcpServers`:

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

Unter Windows `hce.cmd` verwenden, wenn der Client den globalen npm shim nicht findet:

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

VS Code MCP nutzt normalerweise `servers`:

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

Um den aktuellen Checkout statt des veröffentlichten Packages zu verwenden:

```bash
./scripts/install-local-global.sh
```

Das Skript prüft Node.js und pnpm, installiert Workspace-Abhängigkeiten aus dem Lockfile, baut `@hitmux/hitmux-context-engine-mcp` und installiert einen Wrapper `hitmux-context-engine-mcp`, der auf `packages/mcp/dist/index.js` zeigt. Mit `sudo` wird nach `/usr/local/bin/hitmux-context-engine-mcp` installiert.

Beispiel für JSON clients:

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

Für ein neues Repository zuerst den Index im Repository-Root erstellen:

```bash
hce index .
```

Danach den MCP client im Repository öffnen und fragen:

```text
Check the indexing status
Find functions that handle user authentication
```

Nach Änderungen an `config.conf` den MCP server neu verbinden oder neu starten.
