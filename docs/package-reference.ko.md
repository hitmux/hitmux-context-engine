# Package Reference

Language: [English](package-reference.md) | [中文](package-reference.zh-CN.md) | [Español](package-reference.es.md) | [Français](package-reference.fr.md) | [Deutsch](package-reference.de.md) | [日本語](package-reference.ja.md) | 한국어

## MCP Packages

Packages:

- `@hitmux/hce`: MCP server의 짧은 alias.
- `@hitmux/hitmux-context-engine`: MCP server의 full-name alias.
- `@hitmux/hitmux-context-engine-mcp`: original MCP server package.
- `hce-mcp`: scoped package names를 사용할 수 없는 환경용 unscoped alias. 같은 `hce` command를 설치합니다.

global install:

```bash
npm install -g @hitmux/hce@latest
hce
```

scoped packages를 사용할 수 없으면:

```bash
npm install -g hce-mcp@latest
hce
```

product options는 `~/.hitmux-context-engine/config.conf` 또는 `./.hitmux-context-engine/config.conf`에 설정합니다. [configuration.ko.md](configuration.ko.md)를 참고하세요.

### CLI Commands

인자 없는 `hce`는 MCP stdio server를 시작합니다. 인자를 주면 shell CLI로 동작합니다.

| Command | Purpose |
| --- | --- |
| `hce --help` | CLI usage 표시. |
| `hce --version` | MCP package version 출력. |
| `hce init` | 기존 값을 덮어쓰지 않고 `~/.hitmux-context-engine/config.conf` 생성 또는 보완. |
| `hce config path` | global 및 project config paths 표시. |
| `hce doctor [--no-connectivity]` | Node, config parsing, 선택적 embedding/vector database connectivity 확인. |
| `hce test [embedding\|vectordb]` | connectivity checks 실행. |
| `hce status [path] [--refresh]` | path의 indexing status 표시. |
| `hce search <query> [path] [--limit n] [--target-role role]` | indexed path 검색. `role`은 `implementation`, `test`, `docs`, `config`, `all`. |
| `hce clear <path>` | path의 index data 삭제. |
| `hce repair <path>` | legacy 또는 missing remote index manifest 복구. |
| `hce list [collection-name\|repo-path]` | collections list 또는 detail 표시. |
| `hce rm <collection-name\|repo-path> [...]` | collection name 또는 repo path로 collections 삭제. |
| `hce index [collection-name\|repo-path]` | index create 또는 sync. |
| `hce index --force [collection-name\|repo-path ...]` | rebuild 강제 실행. |
| `hce index --all --force` | known repo indexes 전체 force rebuild. |

### MCP Tools

`index_codebase`: directory를 hybrid search용으로 index합니다. 주요 arguments: `path`, `incremental`, `force`, `dryRun`, `customExtensions`, `customIgnorePatterns`.

`search_code`: indexed codebase를 검색합니다. `query`에는 identifiers, filenames, path words, domain terms, scope hints를 포함하는 것이 좋습니다. `targetRole`은 `implementation`, `test`, `docs`, `config`, `all`이며 default는 `implementation`입니다.

`clear_index`: codebase의 index data를 삭제합니다.

`get_indexing_status`: progress, completion status, counts, recent errors를 반환합니다.

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

Common Core APIs: `indexCodebase`, `reindexByChange`, `semanticSearch`, `traceSymbol`, `hasIndex`, `clearIndex`, `addCustomIgnorePatterns`, `addCustomExtensions`, `updateEmbedding`, `updateVectorDatabase`, `updateSplitter`.

`semanticSearch`는 visible results count의 API name으로 `topK`를 유지합니다. results에는 `resultGroup`, `isPrimary`, `fileRole`, `chunkRole`이 포함되어 primary implementation, related tests, docs/config, other matches를 구분할 수 있습니다.

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
