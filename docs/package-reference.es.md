# Package Reference

Idioma: [English](package-reference.md) | [中文](package-reference.zh-CN.md) | Español | [Français](package-reference.fr.md) | [Deutsch](package-reference.de.md) | [日本語](package-reference.ja.md) | [한국어](package-reference.ko.md)

## MCP Packages

Packages:

- `@hitmux/hce`: alias corto del MCP server.
- `@hitmux/hitmux-context-engine`: alias con nombre completo del MCP server.
- `@hitmux/hitmux-context-engine-mcp`: package MCP server original.
- `hce-mcp`: alias sin scope para entornos que no aceptan scoped package names; instala el mismo comando `hce`.

Instalación global:

```bash
npm install -g @hitmux/hce@latest
hce
```

Usa `hce-mcp` si los scoped packages no están disponibles:

```bash
npm install -g hce-mcp@latest
hce
```

Las opciones del producto se configuran en `~/.hitmux-context-engine/config.conf` o `./.hitmux-context-engine/config.conf`. Ver [configuration.es.md](configuration.es.md).

### CLI Commands

`hce` sin argumentos inicia el MCP stdio server. Con argumentos actúa como shell CLI:

| Command | Purpose |
| --- | --- |
| `hce --help` | Muestra CLI usage. |
| `hce --version` | Imprime la versión del MCP package. |
| `hce init` | Crea o completa `~/.hitmux-context-engine/config.conf` sin sobrescribir valores existentes. |
| `hce config path` | Muestra rutas de config global y project. |
| `hce doctor [--no-connectivity]` | Comprueba Node, config parsing y conectividad opcional de embedding/vector database. |
| `hce test [embedding\|vectordb]` | Ejecuta connectivity checks. |
| `hce status [path] [--refresh]` | Muestra indexing status para una ruta. |
| `hce search <query> [path] [--limit n] [--target-role role]` | Busca en una ruta indexada. `role` es `implementation`, `test`, `docs`, `config` o `all`. |
| `hce clear <path>` | Borra index data de una ruta. |
| `hce repair <path>` | Repara manifest remoto legacy o ausente. |
| `hce list [collection-name\|repo-path]` | Lista collections o muestra detalle. |
| `hce rm <collection-name\|repo-path> [...]` | Elimina collections por nombre o repo path. |
| `hce index [collection-name\|repo-path]` | Crea o sincroniza un index. |
| `hce index --force [collection-name\|repo-path ...]` | Fuerza rebuild. |
| `hce index --all --force` | Fuerza rebuild de todos los repo indexes conocidos. |

### MCP Tools

`index_codebase`: indexa una carpeta para hybrid search. Argumentos útiles: `path`, `incremental`, `force`, `dryRun`, `customExtensions`, `customIgnorePatterns`.

`search_code`: busca en un codebase indexado. Usa un `query` enfocado con identifiers, filenames, path words, domain terms y scope hints. `targetRole` puede ser `implementation`, `test`, `docs`, `config` o `all`; default `implementation`.

`clear_index`: borra index data de un codebase.

`get_indexing_status`: devuelve progreso, completion status, counts o errores recientes.

## Core Package

Package: `@hitmux/hitmux-context-engine-core`

```bash
npm install @hitmux/hitmux-context-engine-core
```

Uso mínimo:

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

Core APIs comunes: `indexCodebase`, `reindexByChange`, `semanticSearch`, `traceSymbol`, `hasIndex`, `clearIndex`, `addCustomIgnorePatterns`, `addCustomExtensions`, `updateEmbedding`, `updateVectorDatabase`, `updateSplitter`.

`semanticSearch` mantiene `topK` como nombre de API para el número de resultados visibles. Los resultados incluyen `resultGroup`, `isPrimary`, `fileRole` y `chunkRole` para separar implementación primaria, tests relacionados, docs/config y otros matches.

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
