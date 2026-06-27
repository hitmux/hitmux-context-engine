# Package Reference

Language: [English](package-reference.md) | 中文 | [Español](package-reference.es.md) | [Français](package-reference.fr.md) | [Deutsch](package-reference.de.md) | [日本語](package-reference.ja.md) | [한국어](package-reference.ko.md)

## MCP Packages

Packages:

- `@hitmux/hce`: MCP server 的短 alias。
- `@hitmux/hitmux-context-engine`: MCP server 的完整名称 alias。
- `@hitmux/hitmux-context-engine-mcp`: 原始 MCP server package。
- `hce-mcp`: 面向不能使用 scoped package names 的环境的 unscoped install alias；它安装同一个 `hce` 命令。

全局安装短 CLI：

```bash
npm install -g @hitmux/hce@latest
hce
```

无法使用 scoped packages 时使用 unscoped alias：

```bash
npm install -g hce-mcp@latest
hce
```

完整名称 alias `@hitmux/hitmux-context-engine`、原始 MCP package `@hitmux/hitmux-context-engine-mcp` 和 unscoped alias `hce-mcp` 是等价的 server packages。所有 setup 示例都使用全局 `hce` 命令；安装 `hce-mcp` 不会添加单独的 `hce-mcp` 命令。

产品选项在 `~/.hitmux-context-engine/config.conf` 或 `./.hitmux-context-engine/config.conf` 中配置。见 [configuration.zh-CN.md](configuration.zh-CN.md)。

### CLI Commands

不带参数的 `hce` 会启动 MCP stdio server。shell commands 使用参数：

| Command | Purpose |
| --- | --- |
| `hce --help` | 显示 CLI usage。 |
| `hce --version` | 打印 MCP package version。 |
| `hce init` | 创建或补全 `~/.hitmux-context-engine/config.conf`，不会覆盖已有值。 |
| `hce config path` | 显示 global 和 project config paths，以及它们是否存在。 |
| `hce doctor [--no-connectivity]` | 检查 Node version、config parsing、关键 runtime settings，并可选检查 embedding/vector database 连通性。 |
| `hce test [embedding\|vectordb]` | 运行连通性检查。 |
| `hce status [path] [--refresh]` | 打印某个 path 的 indexing status，默认当前目录。 |
| `hce search <query> [path] [--limit n] [--target-role role]` | 从 shell 搜索已索引 path。`role` 可为 `implementation`、`test`、`docs`、`config` 或 `all`。 |
| `hce clear <path>` | 清理某个 path 的 index data。 |
| `hce repair <path>` | 修复 legacy 或缺失的 remote index manifest。 |
| `hce list [collection-name\|repo-path]` | 列出 collections 或显示某个 collection/path 的详情。 |
| `hce rm <collection-name\|repo-path> [...]` | 按 collection name 或 repo path 删除一个或多个 collections。 |
| `hce index [collection-name\|repo-path]` | 为当前目录、某个 path 或匹配 collection 同步或创建 index。新仓库推荐先运行这个命令。 |
| `hce index --force [collection-name\|repo-path ...]` | 对当前目录、一个 target 或多个 target repo indexes 执行 force rebuild。 |
| `hce index --all --force` | Force rebuild all known repo indexes。`hce index --all` 会被有意拒绝。 |

### MCP Tools

`index_codebase`

为 codebase directory 建立 hybrid search index。常用 arguments 包括：

- `path`: absolute codebase path。
- `incremental`: 对已经索引的 codebase 手动同步 added、modified、removed 或 newly ignored files，不做 rebuild。
- `force`: 只在少数异常场景做 full rebuild，例如 embedding/schema/splitter compatibility changes 或 index state 不可信。
- `dryRun`: 预览 indexable files，不写入 vectors。
- `customExtensions`: 额外纳入的 extensions。
- `customIgnorePatterns`: 额外 ignore globs。

`search_code`

使用聚焦的 code-search query 搜索已索引 codebase。

- `path`: absolute codebase path。
- `query`: 聚焦查询，使用可能的 identifiers、filenames、path words、domain terms 和 scope hints。
- `limit`: 返回结果最大数量。默认 `10`；只有调用方明确需要更多或更少结果时才改。
- `targetRole`: 可选显式搜索目标：`implementation`、`test`、`docs`、`config` 或 `all`。默认 `implementation`。
- `includeRelated`: 可选 boolean。默认 `true`；设为 `false` 时只返回 primary role group。
- `includeTraceEvidence`: 可选 boolean。默认 `false`；设为 `true` 时，为少量 top implementation 或 entry results 附加紧凑的 symbol relationship evidence。

`clear_index`

清理 codebase 的 index data。

`get_indexing_status`

返回 indexing progress、completion status、counts 或 recent errors。

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

数据库说明：Local Milvus 使用 `address: "localhost:19530"`。self-hosted remote Milvus 把它替换为可访问的 host 和 port；只有服务端要求认证时才传入 `token`。免费 Zilliz Cloud 数据库可在 https://cloud.zilliz.com/signup 注册，然后使用 cloud public endpoint，并把 Personal Key 作为 `token` 传入。

### Common Core APIs

- `indexCodebase(path, progressCallback?, forceReindex?)`
- `reindexByChange(path, progressCallback?)`
- `semanticSearch(path, query, topK?, threshold?, filterExpr?, options?)`
- `traceSymbol(path, symbol, options?)`

`semanticSearch` 保留 `topK` 作为 core API 中的返回结果数量名称。内部搜索会先使用更大的有界 candidate pool，再进行 dedupe/rerank，所以可见结果数量不会限制初始 dense/sparse recall。
`options.targetRole` 默认 `implementation`；`options.includeRelated` 默认 `true`。Search results 会带有 `resultGroup`、`isPrimary`、`fileRole` 和 `chunkRole` 标注，调用方可区分 primary implementation matches、entry/export、related test、docs/config 和 chunk-level structural matches。
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
