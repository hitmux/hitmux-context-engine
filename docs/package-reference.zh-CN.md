# Package Reference

Language: [English](package-reference.md) | 中文 | [Español](package-reference.es.md) | [Français](package-reference.fr.md) | [Deutsch](package-reference.de.md) | [日本語](package-reference.ja.md) | [한국어](package-reference.ko.md)

## MCP Packages

Packages:

- `@hitmux/hce`: MCP server 的短 alias。
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

短 alias `@hitmux/hce`、原始 MCP package `@hitmux/hitmux-context-engine-mcp` 和 unscoped alias `hce-mcp` 是等价的 server packages。所有 setup 示例都使用全局 `hce` 命令；安装 `hce-mcp` 不会添加单独的 `hce-mcp` 命令。

产品选项在 `~/.hitmux-context-engine/config.conf` 或 `./.hitmux-context-engine/config.conf` 中配置。见 [configuration.zh-CN.md](configuration.zh-CN.md)。

### CLI Commands

不带参数的 `hce` 会启动 MCP stdio server。shell commands 使用参数：

自动输出模式会在 TTY 使用文本、非 TTY stdout 使用单个 JSON object。Agent 和脚本必须始终传入 `--json`，因为 PTY 可能被识别为交互终端。`--json` 返回稳定的 `ok`、`command`、`exitCode` 字段；`output` 是可读文本，handler 提供的机器可读数据位于 `data`。可用 `--text` 或 `HCE_OUTPUT_FORMAT=json|text` 覆盖格式。

三个已发布 package 都携带相同的 Agent Skill。全局安装后，Skill 位于安装 package 内的 `skills/hitmux-context-engine/SKILL.md`；使用 `@hitmux/hce` 时默认全局路径为 `$(npm root -g)/@hitmux/hce/skills/hitmux-context-engine/SKILL.md`。

| Command | Purpose |
| --- | --- |
| `hce --help` | 显示 CLI usage。 |
| `hce --version` | 打印 MCP package version。 |
| `hce <command>` | 自动适配输出：TTY 使用文本，非 TTY 使用单个 JSON object。Agent 和脚本使用 `hce --json <command>`，不要依赖 PTY 自动识别。 |
| `hce --json <command>` / `hce --text <command>` | 显式选择 JSON 或文本；`--json` 和 `--text` 也可以放在 command 末尾。 |
| `hce init` | 创建或补全 `~/.hitmux-context-engine/config.conf`，不会覆盖已有值。 |
| `hce config path` | 显示 global 和 project config paths，以及它们是否存在。 |
| `hce doctor [--no-connectivity]` | 检查 Node version、config parsing、关键 runtime settings，并可选检查 embedding/vector database 连通性。 |
| `hce test [embedding\|vectordb]` | 运行连通性检查。 |
| `hce status [path] [--refresh] [--details]` | 打印某个 path 的 indexing status，默认当前目录。`--details` 输出详细状态。 |
| `hce search <query> [path] [--limit n] [--scope all\|docs\|code] [--continuation-token token]` | 从 shell 搜索已索引 context。`scope` 默认 `all`；用 `docs` 或 `code` 缩小范围。JSON 中存在 `data.pagination.continuationToken` 时，使用原 query、path、scope 并通过该参数读取下一页。 |
| `hce clear <path>` | 清理某个 path 的 index data。 |
| `hce repair <path>` | 修复 legacy 或缺失的 remote index manifest。 |
| `hce list [collection-name\|repo-path]` | 列出 collections 或显示某个 collection/path 的详情。 |
| `hce rm <collection-name\|repo-path> [...]` | 按 collection name 或 repo path 删除一个或多个 collections。 |
| `hce index [collection-name\|repo-path]` | 为当前目录、某个 path 或匹配 collection 同步或创建 index。新仓库推荐先运行这个命令。 |
| `hce index --force [collection-name\|repo-path ...]` | 对当前目录、一个 target 或多个 target repo indexes 执行 force rebuild。 |
| `hce index --all --force` | Force rebuild all known repo indexes。`hce index --all` 会被有意拒绝。 |

### MCP Tools

`index_codebase`

为 directory/context root 建立 hybrid search index。常用 arguments 包括：

- `path`: absolute directory/context root path。
- `incremental`: 对已经索引的 context root 手动同步 added、modified、removed 或 newly ignored files，不做 rebuild。
- `force`: 只在少数异常场景做 full rebuild，例如 embedding/schema/splitter compatibility changes 或 index state 不可信。
- `dryRun`: 预览 indexable files，不写入 vectors。
- `customExtensions`: 额外纳入的 extensions。
- `customIgnorePatterns`: 额外 ignore globs。

`search_context`

使用聚焦 query 搜索已索引 context。具体纳入哪些文件由 `.hceignore`、`.gitignore` 和自动发现的其他 `.*ignore` 文件决定。

- `path`: absolute indexed path。
- `query`: 聚焦查询，使用相关 filenames、headings、identifiers、path words 或 domain terms。
- Automatic TopK 按当前分数分布返回 `3-12` 条。MCP 不提供手动指定返回数量的参数。
- `scope`: 可选搜索范围：`all`、`docs` 或 `code`。默认 `all`。

`clear_index`

清理 context root 的 index data。

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

`semanticSearch` 保留 `topK` 作为 core API 中的返回结果数量名称。自动搜索内部先在有界候选窗口（默认 `100`，最多 `200`）上做相关性门控，再进行 dedupe 和分组；自动首屏最多 `12` 条，`semanticSearchPage` 可取得分页元数据。显式 `topK` 仍精确控制可见数量。Search results 会带有 `resultGroup`、`isPrimary`、`fileRole` 和 `chunkRole` 标注。
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
    rerankScore?: number;
    rerankRank?: number;
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
