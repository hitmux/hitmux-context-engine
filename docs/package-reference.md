# Package Reference

## MCP Package

Package: `@hitmux/hitmux-context-engine-mcp`

Run with:

```bash
npx @hitmux/hitmux-context-engine-mcp@latest
```

Configure product options in `~/.hitmux-context-engine/config.jsonc` or `./.hitmux-context-engine/config.jsonc`. See [configuration.md](configuration.md).

### MCP Tools

`index_codebase`

Indexes a codebase directory for hybrid search. Useful arguments include:

- `path`: codebase path.
- `force`: re-index even when already indexed.
- `dryRun`: preview indexable files without writing vectors.
- `customExtensions`: additional extensions to include.
- `customIgnorePatterns`: additional ignore globs.

`search_code`

Searches an indexed codebase with a natural language query.

- `path`: codebase path.
- `query`: search query.
- `topK`: max number of results.

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

Database note: Use Local Milvus with `address: "localhost:19530"`. For self-hosted remote Milvus, replace it with the reachable host and port, and pass `token` only if authentication is required. For Zilliz Cloud, use the cloud public endpoint and pass the Personal Key as `token`.

### Common Core APIs

- `indexCodebase(path, progressCallback?, forceReindex?)`
- `reindexByChange(path, progressCallback?)`
- `semanticSearch(path, query, topK?, threshold?, filterExpr?)`
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
