# Quick Start

Langue : [English](quick-start.md) | [中文](quick-start.zh-CN.md) | [Español](quick-start.es.md) | Français | [Deutsch](quick-start.de.md) | [日本語](quick-start.ja.md) | [한국어](quick-start.ko.md)

Cette page montre comment démarrer Hitmux Context Engine depuis les clients MCP. La configuration produit se trouve dans `~/.hitmux-context-engine/config.conf` ou `.hitmux-context-engine/config.conf` dans un projet. La configuration du MCP client ne fait que lancer le stdio server.

## Product Config

Installez le CLI court et créez la configuration :

```bash
npm install -g @hitmux/hce@latest
hce init
```

Modifiez `~/.hitmux-context-engine/config.conf`, ajoutez la provider key, puis exécutez :

```bash
hce doctor
```

Utilisez `hce doctor --no-connectivity` pour des checks locaux uniquement. Local Milvus utilise `milvusAddress = localhost:19530`. Pour Zilliz Cloud gratuit, inscrivez-vous sur https://cloud.zilliz.com/signup puis utilisez le public endpoint comme `milvusAddress` et la Personal Key dans `milvusToken`.

Hitmux Context Engine n'hérite pas des system proxy variables par défaut. Configurez `embeddingUseSystemProxy` et `databaseUseSystemProxy` seulement si le provider ou la vector database doit utiliser un proxy ; voir [Configuration](configuration.fr.md#system-proxy).

`hce` sans arguments est le mode MCP stdio server :

```bash
hce
```

Après indexing, vous pouvez vérifier l'état avec `hce status .` depuis la racine du dépôt.

## CLI Usage

Utilisez `hce` sans arguments uniquement comme commande MCP stdio server dans la configuration client. Depuis un shell, ajoutez une commande :

| Commande | Usage |
| --- | --- |
| `hce --help` | Affiche le command usage. |
| `hce --version` | Affiche la version du MCP package installé. |
| `hce init` | Crée ou complète `~/.hitmux-context-engine/config.conf` sans écraser les valeurs existantes. |
| `hce config path` | Affiche les chemins de configuration globale et projet, ainsi que leur existence. |
| `hce doctor [--no-connectivity]` | Vérifie Node, config parsing, runtime settings et éventuellement la connectivité embedding/vector database. |
| `hce test [embedding\|vectordb]` | Exécute les checks de connectivité. |
| `hce index [path]` | Synchronise ou crée un index. Pour le dépôt courant, utilisez `hce index .`. |
| `hce index --force [path]` | Force rebuild d'un repository index. |
| `hce index --all --force` | Force rebuild de tous les repository indexes connus. `hce index --all` sans `--force` est rejeté. |
| `hce status [path] [--refresh]` | Affiche l'indexing status d'un path, par défaut le répertoire courant. |
| `hce search <query> [path] [--limit n] [--target-role role]` | Recherche dans un path indexé depuis le shell. `role` peut être `implementation`, `test`, `docs`, `config` ou `all`. |
| `hce list [collection-name\|repo-path]` | Liste les collections ou affiche les détails d'une collection/path. |
| `hce clear <path>` | Nettoie l'index data d'un path. |
| `hce repair <path>` | Répare un remote index manifest legacy ou manquant. |
| `hce rm <collection-name\|repo-path> [...]` | Supprime une ou plusieurs collections par collection name ou repo path. |

## Claude Code

```bash
npm install -g @hitmux/hce@latest
claude mcp add hitmux-context-engine -- hce
```

Après modification de `config.conf`, reconnectez :

```text
/mcp reconnect hitmux-context-engine
```

## OpenAI Codex CLI

```bash
npm install -g @hitmux/hce@latest
codex mcp add hitmux-context-engine -- hce
```

Vous pouvez aussi modifier `~/.codex/config.toml` :

```toml
[mcp_servers.hitmux-context-engine]
command = "hce"
args = []
startup_timeout_sec = 20
```

## OpenCode

Configuration globale dans `~/.config/opencode/opencode.json` ou configuration locale `opencode.json` :

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

Cursor, Windsurf, Claude Desktop, Gemini CLI, Qwen Code, Cline et Roo Code utilisent souvent `mcpServers` :

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

Sous Windows, si le client ne trouve pas le npm shim global, utilisez `hce.cmd` :

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

VS Code MCP utilise souvent `servers` :

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

Pour utiliser le checkout courant au lieu du package publié :

```bash
./scripts/install-local-global.sh
```

Le script vérifie Node.js et pnpm, installe les dépendances depuis le lockfile, construit `@hitmux/hitmux-context-engine-mcp` et installe un wrapper `hitmux-context-engine-mcp` pointant vers `packages/mcp/dist/index.js`. Avec `sudo`, il installe dans `/usr/local/bin/hitmux-context-engine-mcp`.

Exemple pour clients JSON :

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

Pour un nouveau dépôt, créez le premier index depuis la racine :

```bash
hce index .
```

Ouvrez ensuite votre MCP client dans le dépôt et demandez :

```text
Check the indexing status
Find functions that handle user authentication
```

Après modification de `config.conf`, reconnectez ou redémarrez le MCP server.
