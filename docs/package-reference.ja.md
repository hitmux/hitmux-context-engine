# Package Reference

Language: [English](package-reference.md) | [中文](package-reference.zh-CN.md) | [Español](package-reference.es.md) | [Français](package-reference.fr.md) | [Deutsch](package-reference.de.md) | 日本語 | [한국어](package-reference.ko.md)

## MCP Packages

Packages:

- `@hitmux/hce`: MCP server の短い alias。
- `@hitmux/hitmux-context-engine`: MCP server の full-name alias。
- `@hitmux/hitmux-context-engine-mcp`: original MCP server package。
- `hce-mcp`: scoped package names を使えない環境向けの unscoped alias。同じ `hce` command を install します。

global install:

```bash
npm install -g @hitmux/hce@latest
hce
```

scoped packages が使えない場合:

```bash
npm install -g hce-mcp@latest
hce
```

product options は `~/.hitmux-context-engine/config.conf` または `./.hitmux-context-engine/config.conf` に設定します。詳しくは [configuration.ja.md](configuration.ja.md)。

### CLI Commands

引数なしの `hce` は MCP stdio server を起動します。引数を付けると shell CLI として動きます。

| Command | Purpose |
| --- | --- |
| `hce --help` | CLI usage を表示。 |
| `hce --version` | MCP package version を表示。 |
| `hce init` | 既存値を上書きせず `~/.hitmux-context-engine/config.conf` を作成または補完。 |
| `hce config path` | global と project の config paths を表示。 |
| `hce doctor [--no-connectivity]` | Node、config parsing、必要に応じて embedding/vector database connectivity を確認。 |
| `hce test [embedding\|vectordb]` | connectivity checks を実行。 |
| `hce status [path] [--refresh]` | path の indexing status を表示。 |
| `hce search <query> [path] [--limit n] [--target-role role]` | index 済み path を検索。`role` は `implementation`、`test`、`docs`、`config`、`all`。 |
| `hce clear <path>` | path の index data を削除。 |
| `hce repair <path>` | legacy または missing remote index manifest を repair。 |
| `hce list [collection-name\|repo-path]` | collections を list、または detail を表示。 |
| `hce rm <collection-name\|repo-path> [...]` | collection name または repo path で collections を削除。 |
| `hce index [collection-name\|repo-path]` | index を create または sync。 |
| `hce index --force [collection-name\|repo-path ...]` | rebuild を force。 |
| `hce index --all --force` | known repo indexes をすべて force rebuild。 |

### MCP Tools

`index_codebase`: directory を hybrid search 用に index します。主な arguments: `path`、`incremental`、`force`、`dryRun`、`customExtensions`、`customIgnorePatterns`。

`search_code`: index 済み codebase を検索します。`query` には identifiers、filenames、path words、domain terms、scope hints を含めると有効です。`targetRole` は `implementation`、`test`、`docs`、`config`、`all` で、default は `implementation`。

`clear_index`: codebase の index data を削除します。

`get_indexing_status`: progress、completion status、counts、recent errors を返します。

## Core Package

Package: `@hitmux/hitmux-context-engine-core`

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

const context = new Context({ embedding, vectorDatabase });
await context.indexCodebase('./my-project');
const results = await context.semanticSearch('./my-project', 'function that handles user authentication', 5);
```

Common Core APIs: `indexCodebase`, `reindexByChange`, `semanticSearch`, `traceSymbol`, `hasIndex`, `clearIndex`, `addCustomIgnorePatterns`, `addCustomExtensions`, `updateEmbedding`, `updateVectorDatabase`, `updateSplitter`。

`semanticSearch` は visible results count の API name として `topK` を維持します。results には `resultGroup`、`isPrimary`、`fileRole`、`chunkRole` が含まれ、primary implementation、related tests、docs/config、other matches を分けられます。

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
