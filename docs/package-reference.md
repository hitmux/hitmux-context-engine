# Package Reference

Language: English | [中文](package-reference.zh-CN.md) | [Español](package-reference.es.md) | [Français](package-reference.fr.md) | [Deutsch](package-reference.de.md) | [日本語](package-reference.ja.md) | [한국어](package-reference.ko.md)

## MCP Packages

Packages:

- `@hitmux/hce`: short alias for the MCP server.
- `@hitmux/hitmux-context-engine`: full-name alias for the MCP server.
- `@hitmux/hitmux-context-engine-mcp`: original MCP server package.
- `hce-mcp`: unscoped install alias for environments that cannot use scoped package names; it installs the same `hce` command.

Install the short CLI globally:

```bash
npm install -g @hitmux/hce@latest
hce
```

Use the unscoped alias when scoped packages are unavailable:

```bash
npm install -g hce-mcp@latest
hce
```

The full-name alias `@hitmux/hitmux-context-engine`, the original MCP package `@hitmux/hitmux-context-engine-mcp`, and the unscoped alias `hce-mcp` are equivalent server packages. All setup examples use the global `hce` command; installing `hce-mcp` does not add a separate `hce-mcp` command.

Configure product options in `~/.hitmux-context-engine/config.conf` or `./.hitmux-context-engine/config.conf`. See [configuration.md](configuration.md).

### CLI Commands

Plain `hce` with no arguments starts the MCP stdio server. Use arguments for shell commands:

| Command | Purpose |
| --- | --- |
| `hce --help` | Show CLI usage. |
| `hce --version` | Print the MCP package version. |
| `hce init` | Create or complete `~/.hitmux-context-engine/config.conf` without overwriting existing values. |
| `hce config path` | Show global and project config paths and whether they exist. |
| `hce doctor [--no-connectivity]` | Check Node version, config parsing, key runtime settings, and optionally embedding/vector database connectivity. |
| `hce test [embedding\|vectordb]` | Run connectivity checks. |
| `hce status [path] [--refresh]` | Print indexing status for a path, defaulting to the current directory. |
| `hce search <query> [path] [--limit n] [--target-role role]` | Search an indexed path from the shell. `role` is `implementation`, `test`, `docs`, `config`, or `all`. |
| `hce clear <path>` | Clear index data for one path. |
| `hce repair <path>` | Repair a legacy or missing remote index manifest. |
| `hce list [collection-name\|repo-path]` | List collections or show details for one collection/path. |
| `hce rm <collection-name\|repo-path> [...]` | Delete one or more collections by collection name or repo path. |
| `hce index [collection-name\|repo-path]` | Sync or create an index for the current directory, a path, or a matching collection. Recommended first command for a new repository. |
| `hce index --force [collection-name\|repo-path ...]` | Force rebuild the current directory, one target, or multiple target repo indexes. |
| `hce index --all --force` | Force rebuild all known repo indexes. `hce index --all` is rejected intentionally. |

### MCP Tools

`index_codebase`

Indexes a codebase directory for hybrid search. Useful arguments include:

- `path`: absolute codebase path.
- `incremental`: manually sync added, modified, removed, or newly ignored files for an already indexed codebase without rebuilding.
- `force`: full rebuild for exceptional cases only, such as embedding/schema/splitter compatibility changes or untrustworthy index state.
- `dryRun`: preview indexable files without writing vectors.
- `customExtensions`: additional extensions to include.
- `customIgnorePatterns`: additional ignore globs.

`search_code`

Searches an indexed codebase with a focused code-search query.

- `path`: absolute codebase path.
- `query`: focused query using likely identifiers, filenames, path words, domain terms, and scope hints.
- `limit`: max number of returned results. Defaults to `10`; use a different value only when the caller explicitly needs more or fewer results.
- `targetRole`: optional explicit search target: `implementation`, `test`, `docs`, `config`, or `all`. Defaults to `implementation`.
- `includeRelated`: optional boolean. Defaults to `true`; set `false` to return only the primary role group.
- `includeTraceEvidence`: optional boolean. Defaults to `false`; set `true` to attach compact symbol relationship evidence for a small number of top implementation or entry results.

`clear_index`

Clears index data for a codebase.

`get_indexing_status`

Returns indexing progress, completion status, counts, or recent errors.

## Core Package

Package: `@hitmux/hitmux-context-engine-core`

Install:

```bash
npm install @hitmux/hitmux-context-engine-core
```

Minimal usage:

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

const context = new Context({
    embedding,
    vectorDatabase
});

await context.indexCodebase('./my-project');

const results = await context.semanticSearch(
    './my-project',
    'function that handles user authentication',
    5
);
```

Database note: Use Local Milvus with `address: "localhost:19530"`. For self-hosted remote Milvus, replace it with the reachable host and port, and pass `token` only if authentication is required. For a free Zilliz Cloud database, sign up at https://cloud.zilliz.com/signup, then use the cloud public endpoint and pass the Personal Key as `token`.

### Common Core APIs

- `indexCodebase(path, progressCallback?, forceReindex?)`
- `reindexByChange(path, progressCallback?)`
- `semanticSearch(path, query, topK?, threshold?, filterExpr?, options?)`
- `traceSymbol(path, symbol, options?)`

`semanticSearch` keeps `topK` as the core API name for the returned result count. Internally, search uses a larger bounded candidate pool before dedupe/rerank, so the visible result count does not cap initial dense/sparse recall.
`options.targetRole` defaults to `implementation`; `options.includeRelated` defaults to `true`. Search results are annotated with `resultGroup`, `isPrimary`, `fileRole`, and `chunkRole` so callers can separate primary implementation matches from entry/export, related test, docs/config, and chunk-level structural matches.
- `hasIndex(path)`
- `clearIndex(path, progressCallback?)`
- `addCustomIgnorePatterns(patterns)`
- `addCustomExtensions(extensions)`
- `updateEmbedding(embedding)`
- `updateVectorDatabase(vectorDB)`
- `updateSplitter(splitter)`

### Search Result Shape

```typescript
interface SemanticSearchResult {
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    score: number;
    resultGroup?: "implementation" | "entry_exports" | "related_tests" | "docs_config" | "other";
    isPrimary?: boolean;
    fileRole?: string;
    chunkRole?: "definition" | "method_body" | "reference" | "test_case" | "assertion" | "re_export" | "module_decl" | string;
}
```

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
