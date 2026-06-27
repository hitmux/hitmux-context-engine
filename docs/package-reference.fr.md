# Package Reference

Langue : [English](package-reference.md) | [中文](package-reference.zh-CN.md) | [Español](package-reference.es.md) | Français | [Deutsch](package-reference.de.md) | [日本語](package-reference.ja.md) | [한국어](package-reference.ko.md)

## MCP Packages

Packages :

- `@hitmux/hce` : alias court du MCP server.
- `@hitmux/hitmux-context-engine` : alias nom complet du MCP server.
- `@hitmux/hitmux-context-engine-mcp` : package MCP server original.
- `hce-mcp` : alias non scoped pour les environnements qui ne peuvent pas utiliser les scoped package names ; il installe le même commande `hce`.

Installation globale :

```bash
npm install -g @hitmux/hce@latest
hce
```

Utilisez `hce-mcp` si les scoped packages ne sont pas disponibles :

```bash
npm install -g hce-mcp@latest
hce
```

Configurez les options produit dans `~/.hitmux-context-engine/config.conf` ou `./.hitmux-context-engine/config.conf`. Voir [configuration.fr.md](configuration.fr.md).

### CLI Commands

`hce` sans arguments démarre le MCP stdio server. Avec des arguments, il sert de shell CLI :

| Command | Purpose |
| --- | --- |
| `hce --help` | Affiche CLI usage. |
| `hce --version` | Affiche la version du MCP package. |
| `hce init` | Crée ou complète `~/.hitmux-context-engine/config.conf` sans écraser les valeurs existantes. |
| `hce config path` | Affiche les chemins de config globale et project. |
| `hce doctor [--no-connectivity]` | Vérifie Node, config parsing et la connectivité embedding/vector database optionnelle. |
| `hce test [embedding\|vectordb]` | Lance les connectivity checks. |
| `hce status [path] [--refresh]` | Affiche indexing status pour un chemin. |
| `hce search <query> [path] [--limit n] [--target-role role]` | Recherche dans un chemin indexé. `role` vaut `implementation`, `test`, `docs`, `config` ou `all`. |
| `hce clear <path>` | Supprime index data pour un chemin. |
| `hce repair <path>` | Répare un manifest distant legacy ou absent. |
| `hce list [collection-name\|repo-path]` | Liste les collections ou affiche un détail. |
| `hce rm <collection-name\|repo-path> [...]` | Supprime des collections par nom ou repo path. |
| `hce index [collection-name\|repo-path]` | Crée ou synchronise un index. |
| `hce index --force [collection-name\|repo-path ...]` | Force un rebuild. |
| `hce index --all --force` | Force le rebuild de tous les repo indexes connus. |

### MCP Tools

`index_codebase` : indexe un dossier pour hybrid search. Arguments utiles : `path`, `incremental`, `force`, `dryRun`, `customExtensions`, `customIgnorePatterns`.

`search_code` : recherche dans un codebase indexé. Utilisez un `query` ciblé avec identifiers, filenames, path words, domain terms et scope hints. `targetRole` peut être `implementation`, `test`, `docs`, `config` ou `all`; default `implementation`.

`clear_index` : supprime index data pour un codebase.

`get_indexing_status` : renvoie progression, completion status, counts ou erreurs récentes.

## Core Package

Package : `@hitmux/hitmux-context-engine-core`

```bash
npm install @hitmux/hitmux-context-engine-core
```

Usage minimal :

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

Core APIs courantes : `indexCodebase`, `reindexByChange`, `semanticSearch`, `traceSymbol`, `hasIndex`, `clearIndex`, `addCustomIgnorePatterns`, `addCustomExtensions`, `updateEmbedding`, `updateVectorDatabase`, `updateSplitter`.

`semanticSearch` garde `topK` comme nom d'API pour le nombre de résultats visibles. Les résultats incluent `resultGroup`, `isPrimary`, `fileRole` et `chunkRole` pour séparer implémentation primaire, tests liés, docs/config et autres matches.

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
