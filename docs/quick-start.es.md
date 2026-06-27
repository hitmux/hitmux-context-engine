# Quick Start

Idioma: [English](quick-start.md) | [中文](quick-start.zh-CN.md) | Español | [Français](quick-start.fr.md) | [Deutsch](quick-start.de.md) | [日本語](quick-start.ja.md) | [한국어](quick-start.ko.md)

Esta página explica cómo iniciar Hitmux Context Engine desde clientes MCP. La configuración del producto vive en `~/.hitmux-context-engine/config.conf` o en `.hitmux-context-engine/config.conf` dentro del proyecto. La configuración del MCP client solo arranca el stdio server.

## Product Config

Instala el CLI corto y crea la configuración:

```bash
npm install -g @hitmux/hce@latest
hce init
```

Edita `~/.hitmux-context-engine/config.conf`, añade la provider key y ejecuta:

```bash
hce doctor
```

Usa `hce doctor --no-connectivity` cuando solo quieras checks locales. Local Milvus usa `milvusAddress = localhost:19530`. Para Zilliz Cloud gratuito, regístrate en https://cloud.zilliz.com/signup y usa el endpoint público como `milvusAddress` con la Personal Key en `milvusToken`.

Hitmux Context Engine no hereda system proxy variables por defecto. Configura `embeddingUseSystemProxy` y `databaseUseSystemProxy` solo cuando el provider o la vector database deban usar proxy; ver [Configuration](configuration.es.md#system-proxy).

`hce` sin argumentos es el modo MCP stdio server:

```bash
hce
```

Después de indexar, puedes revisar estado con `hce status .` desde la raíz del repositorio.

## CLI Usage

Usa `hce` sin argumentos solo como comando MCP stdio server en la configuración del client. Desde shell, pasa un command:

| Comando | Uso |
| --- | --- |
| `hce --help` | Muestra el command usage. |
| `hce --version` | Imprime la versión del MCP package instalado. |
| `hce init` | Crea o completa `~/.hitmux-context-engine/config.conf` sin sobrescribir valores existentes. |
| `hce config path` | Muestra las rutas de configuración global y de proyecto, y si existen. |
| `hce doctor [--no-connectivity]` | Comprueba Node, config parsing, runtime settings y opcionalmente conectividad de embedding/vector database. |
| `hce test [embedding\|vectordb]` | Ejecuta checks de conectividad. |
| `hce index [path]` | Sincroniza o crea un index. Para el repositorio actual usa `hce index .`. |
| `hce index --force [path]` | Force rebuild de un repository index. |
| `hce index --all --force` | Force rebuild de todos los repository indexes conocidos. `hce index --all` sin `--force` se rechaza. |
| `hce status [path] [--refresh]` | Muestra el indexing status de un path, por defecto el directorio actual. |
| `hce search <query> [path] [--limit n] [--target-role role]` | Busca en un path indexado desde shell. `role` puede ser `implementation`, `test`, `docs`, `config` o `all`. |
| `hce list [collection-name\|repo-path]` | Lista collections o muestra detalles de una collection/path. |
| `hce clear <path>` | Limpia index data de un path. |
| `hce repair <path>` | Repara un remote index manifest legacy o ausente. |
| `hce rm <collection-name\|repo-path> [...]` | Elimina una o más collections por collection name o repo path. |

## Claude Code

```bash
npm install -g @hitmux/hce@latest
claude mcp add hitmux-context-engine -- hce
```

Después de editar `config.conf`, reconecta:

```text
/mcp reconnect hitmux-context-engine
```

## OpenAI Codex CLI

```bash
npm install -g @hitmux/hce@latest
codex mcp add hitmux-context-engine -- hce
```

También puedes editar `~/.codex/config.toml`:

```toml
[mcp_servers.hitmux-context-engine]
command = "hce"
args = []
startup_timeout_sec = 20
```

## OpenCode

Config global en `~/.config/opencode/opencode.json` o config local `opencode.json`:

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

Cursor, Windsurf, Claude Desktop, Gemini CLI, Qwen Code, Cline y Roo Code suelen usar `mcpServers`:

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

En Windows, si el client no encuentra el npm shim global, usa `hce.cmd`:

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

VS Code MCP normalmente usa `servers`:

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

Para usar el checkout actual en vez del package publicado:

```bash
./scripts/install-local-global.sh
```

El script verifica Node.js y pnpm, instala dependencias desde lockfile, construye `@hitmux/hitmux-context-engine-mcp` e instala un wrapper `hitmux-context-engine-mcp` que apunta a `packages/mcp/dist/index.js`. Con `sudo` instala en `/usr/local/bin/hitmux-context-engine-mcp`.

Ejemplo para JSON clients:

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

Para un repositorio nuevo, crea el primer índice desde la raíz:

```bash
hce index .
```

Después abre tu MCP client en el repositorio y pregunta:

```text
Check the indexing status
Find functions that handle user authentication
```

Después de editar `config.conf`, reconecta o reinicia el MCP server.
