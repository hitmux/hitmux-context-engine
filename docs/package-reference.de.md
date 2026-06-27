# Package Reference

Sprache: [English](package-reference.md) | [中文](package-reference.zh-CN.md) | [Español](package-reference.es.md) | [Français](package-reference.fr.md) | Deutsch | [日本語](package-reference.ja.md) | [한국어](package-reference.ko.md)

## MCP Packages

Packages:

- `@hitmux/hce`: kurzer Alias für den MCP server.
- `@hitmux/hitmux-context-engine`: vollständiger Alias für den MCP server.
- `@hitmux/hitmux-context-engine-mcp`: ursprüngliches MCP server package.
- `hce-mcp`: unscoped Alias für Umgebungen ohne scoped package names; installiert denselben `hce` Befehl.

Global installieren:

```bash
npm install -g @hitmux/hce@latest
hce
```

`hce-mcp` nutzen, wenn scoped packages nicht verfügbar sind:

```bash
npm install -g hce-mcp@latest
hce
```

Produktoptionen in `~/.hitmux-context-engine/config.conf` oder `./.hitmux-context-engine/config.conf` konfigurieren. Siehe [configuration.de.md](configuration.de.md).

### CLI Commands

`hce` ohne Argumente startet den MCP stdio server. Mit Argumenten arbeitet es als Shell CLI:

| Command | Purpose |
| --- | --- |
| `hce --help` | Zeigt CLI usage. |
| `hce --version` | Gibt die MCP package version aus. |
| `hce init` | Erstellt oder ergänzt `~/.hitmux-context-engine/config.conf` ohne bestehende Werte zu überschreiben. |
| `hce config path` | Zeigt globale und project config paths. |
| `hce doctor [--no-connectivity]` | Prüft Node, config parsing und optional embedding/vector database connectivity. |
| `hce test [embedding\|vectordb]` | Führt connectivity checks aus. |
| `hce status [path] [--refresh]` | Zeigt indexing status für einen Pfad. |
| `hce search <query> [path] [--limit n] [--target-role role]` | Sucht in einem indexierten Pfad. `role` ist `implementation`, `test`, `docs`, `config` oder `all`. |
| `hce clear <path>` | Löscht index data für einen Pfad. |
| `hce repair <path>` | Repariert ein legacy oder fehlendes remote index manifest. |
| `hce list [collection-name\|repo-path]` | Listet collections oder zeigt Details. |
| `hce rm <collection-name\|repo-path> [...]` | Löscht collections nach Namen oder repo path. |
| `hce index [collection-name\|repo-path]` | Erstellt oder synchronisiert einen Index. |
| `hce index --force [collection-name\|repo-path ...]` | Erzwingt rebuild. |
| `hce index --all --force` | Erzwingt rebuild aller bekannten repo indexes. |

### MCP Tools

`index_codebase`: indexiert ein Verzeichnis für hybrid search. Wichtige Argumente: `path`, `incremental`, `force`, `dryRun`, `customExtensions`, `customIgnorePatterns`.

`search_code`: sucht in einem indexierten codebase. Verwende ein fokussiertes `query` mit identifiers, filenames, path words, domain terms und scope hints. `targetRole` kann `implementation`, `test`, `docs`, `config` oder `all` sein; default `implementation`.

`clear_index`: löscht index data für einen codebase.

`get_indexing_status`: gibt progress, completion status, counts oder aktuelle Fehler zurück.

## Core Package

Package: `@hitmux/hitmux-context-engine-core`

```bash
npm install @hitmux/hitmux-context-engine-core
```

Minimale Nutzung:

```typescript
import { Context, MilvusVectorDatabase, OpenAIEmbedding } from '@hitmux/hitmux-context-engine-core';

const embedding = new OpenAIEmbedding({
    apiKey: 'sk-your-openai-api-key',
    model: 'text-embedding-3-small'
});

const vectorDatabase = new MilvusVectorDatabase({
    address: 'localhost:19530',
    token: ''
});

const context = new Context({ embedding, vectorDatabase });
await context.indexCodebase('./my-project');
const results = await context.semanticSearch('./my-project', 'function that handles user authentication', 5);
```

Häufige Core APIs: `indexCodebase`, `reindexByChange`, `semanticSearch`, `traceSymbol`, `hasIndex`, `clearIndex`, `addCustomIgnorePatterns`, `addCustomExtensions`, `updateEmbedding`, `updateVectorDatabase`, `updateSplitter`.

`semanticSearch` behält `topK` als API-Namen für die sichtbare Ergebnisanzahl. Ergebnisse enthalten `resultGroup`, `isPrimary`, `fileRole` und `chunkRole`, um primäre Implementierung, related tests, docs/config und andere matches zu trennen.

## Development Commands

```bash
pnpm build
pnpm build:core
pnpm build:mcp
pnpm build:examples
pnpm typecheck
pnpm lint
pnpm --filter @hitmux/hitmux-context-engine-core test
pnpm --filter @hitmux/hitmux-context-engine-mcp test
```
