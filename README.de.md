# Hitmux Context Engine

Sprache: [English](README.md) | [中文](README.zh-CN.md) | [Español](README.es.md) | [Français](README.fr.md) | Deutsch | [日本語](README.ja.md) | [한국어](README.ko.md)

Semantische Codesuche für MCP-Clients.

Hitmux Context Engine indexiert ein Repository in Milvus-kompatiblen Vektorspeicher und bietet Claude Code, OpenAI Codex CLI, OpenCode, Cursor, Windsurf und anderen MCP-Clients fokussierte Werkzeuge, um Code nach Verhalten, symbol, workflow oder Dateiverantwortung zu finden.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![npm - core](https://img.shields.io/npm/v/@hitmux/hitmux-context-engine-core?label=%40hitmux%2Fhitmux-context-engine-core&logo=npm)](https://www.npmjs.com/package/@hitmux/hitmux-context-engine-core)
[![npm - mcp](https://img.shields.io/npm/v/@hitmux/hitmux-context-engine-mcp?label=%40hitmux%2Fhitmux-context-engine-mcp&logo=npm)](https://www.npmjs.com/package/@hitmux/hitmux-context-engine-mcp)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Nutze es, wenn ein AI coding agent mehr als text grep braucht:

- Indexierten Code mit natürlicher Sprache oder identifier-lastigen Abfragen durchsuchen.
- Implementierungsdateien priorisieren und bei Bedarf verwandte Tests, docs, config und exports anzeigen.
- Projektkonfiguration in einfachen `config.conf`-Dateien halten, statt pro Client Umgebungsvariablen einzurichten.

Typischer Ablauf beim ersten Einsatz:

```text
hce index .
Check the indexing status
Find the handler that validates MCP tool arguments
```

## Quick Start

Erstelle oder vervollständige die Runtime-Konfiguration:

```bash
npm install -g @hitmux/hce@latest
hce init
```

Bearbeite danach `~/.hitmux-context-engine/config.conf` und trage die provider key ein. Prüfe lokale Konfiguration und Verbindung:

```bash
hce doctor
```

Für Claude Code den MCP server hinzufügen:

```bash
claude mcp add hitmux-context-engine -- hce
```

Für OpenAI Codex CLI den MCP server hinzufügen:

```bash
codex mcp add hitmux-context-engine -- hce
```

Der vollständige Package-Alias `@hitmux/hitmux-context-engine` und das ursprüngliche MCP-Package `@hitmux/hitmux-context-engine-mcp` starten denselben server.

Datenbankhinweis: Verwende Local Milvus mit `milvusAddress = localhost:19530`. Für self-hosted remote Milvus ersetze den Wert durch erreichbaren host und port und füge `milvusToken` nur hinzu, wenn Authentifizierung erforderlich ist. Für eine kostenlose Zilliz Cloud database registriere dich unter https://cloud.zilliz.com/signup, nutze den cloud public endpoint und füge deine Personal Key als `milvusToken` hinzu. Andere database backends können nicht über `config.conf` ausgewählt werden.

Für ein neues Repository zuerst im Repository-Root den ersten Index erstellen, bevor MCP search genutzt wird:

```bash
hce index .
```

Öffne danach deinen MCP client im Repository und frage:

```text
Check the indexing status
Find functions that handle user authentication
```

Der Status kann auch in der Shell geprüft werden:

```bash
hce status .
```

## CLI Usage

`hce` ohne Argumente startet den MCP stdio server für Clients. Mit Argumenten nutzt du es direkt in der Shell:

| Aufgabe | Befehl |
| --- | --- |
| Hilfe oder Version anzeigen | `hce --help`, `hce --version` |
| Globale Konfiguration erstellen oder vervollständigen | `hce init` |
| Globale und projektlokale Konfigurationspfade anzeigen | `hce config path` |
| Konfiguration und Verbindung prüfen | `hce doctor`, `hce doctor --no-connectivity` |
| Aktuelles Repository indexieren | `hce index .` |
| Index status anzeigen | `hce status .`, `hce status . --refresh` |
| Ein indexiertes Repository durchsuchen | `hce search "query" . --limit 5 --target-role implementation` |
| Indexes und collections verwalten | `hce list`, `hce list <name-or-path>`, `hce clear <path>`, `hce repair <path>`, `hce rm <name-or-path>`, `hce index --force <path>` |

Weitere Client-Beispiele, darunter Cursor, Windsurf, Claude Desktop, Gemini CLI, Qwen Code, VS Code MCP, Cline und Roo Code, stehen in [docs/quick-start.de.md](docs/quick-start.de.md).

Für einen lokalen Source-Checkout führe `./scripts/install-local-global.sh` aus. Das baut den Workspace und installiert aus dem aktuellen Checkout einen user-level Befehl `hitmux-context-engine-mcp`. Mit `sudo` installiert das Skript den Befehl global. Claude Code und Codex CLI mit veröffentlichtem Package verwenden den oben gezeigten globalen Befehl `hce`.

## Configuration

Hitmux Context Engine liest die Produktkonfiguration aus conf-Dateien:

1. `~/.hitmux-context-engine/config.conf`
2. `./.hitmux-context-engine/config.conf`
3. built-in defaults

Projektkonfiguration überschreibt die globale Konfiguration für vorhandene Felder. Umgebungsvariablen und `~/.hitmux-context-engine/.env` werden nicht für MCP-Produktoptionen verwendet.

Siehe [docs/configuration.de.md](docs/configuration.de.md) für provider-, Milvus/Zilliz-, indexing-, sync- und file-filtering-Optionen.

## Packages

- `@hitmux/hitmux-context-engine-mcp`: MCP stdio server für Claude Code und andere MCP-Clients.
- `@hitmux/hce` und `@hitmux/hitmux-context-engine`: npm package aliases für den MCP server.
- `@hitmux/hitmux-context-engine-core`: TypeScript-Package für indexing, splitting, embedding, synchronization und vector database.

Siehe [docs/package-reference.de.md](docs/package-reference.de.md) für tools, Package-Nutzung und core API examples.

## Repository Layout

```text
packages/core     Core indexing engine
packages/mcp      MCP server
docs              Flat documentation
examples          Local usage examples
evaluation        Evaluation scripts and raw case-study data
python            Python bridge helpers
```

## Development

Verwende Node `>=20` und pnpm `>=10`.

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm --filter @hitmux/hitmux-context-engine-core test
pnpm --filter @hitmux/hitmux-context-engine-mcp test
```

Package-spezifische Befehle:

```bash
pnpm build:core
pnpm build:mcp
pnpm build:examples
pnpm dev
pnpm example:basic
```

Vor dem Öffnen eines PR beschreibe das geänderte Package, das Verhalten, die Validierungsbefehle und mögliche Konfigurations- oder Migrationshinweise.

## Documentation

- [docs/configuration.de.md](docs/configuration.de.md): kanonische conf-Konfigurationsreferenz.
- [docs/quick-start.de.md](docs/quick-start.de.md): MCP client setup.
- [docs/troubleshooting.de.md](docs/troubleshooting.de.md): häufige setup- und runtime-Probleme.
- [docs/package-reference.de.md](docs/package-reference.de.md): MCP tools und core package usage.

## License

MIT. Siehe [LICENSE](LICENSE).

## Acknowledgements

Dieses Projekt basiert auf dem core von [zilliztech/claude-context](https://github.com/zilliztech/claude-context). Danke an die [Linux Do community](https://linux.do) für die Unterstützung.

## Screenshots

![Hitmux Context Engine Screenshot 1](img/English_1.jpg)

![Hitmux Context Engine Screenshot 2](img/English_2.jpg)

![Hitmux Context Engine Screenshot 3](img/English_3.jpg)
