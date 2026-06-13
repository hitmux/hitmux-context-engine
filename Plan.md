# Plan.md

## 当前目标

把 `search_code` 从“单次小候选池语义搜索 + 启发式排序”收敛为“足够召回 + 结构化信号 + 显式目标 + 代码结构导航”的代码定位工具。

当前重点不是继续调排序分数，也不是迁移向量库。优先修正会让正确结果进不了候选池的召回问题，把 AST metadata、symbol/path、file/chunk role 等强信号提升为可过滤、可排序的结构化字段，再把工具契约、结果角色和后续导航流程拆清楚。自然语言可以作为初始召回输入，但排序和定位结论只能依赖显式参数、文件结构、AST metadata、symbol/path 字面证据和后续代码关系。

## 当前状态

已新增 `/opt/CannonWar` 30 case 的可复跑 search-quality fixture 和 runner：

* `evaluation/search-quality/cannonwar-cases.json` 保存 query、expected path、expected role 和人工复核状态，不进入 runtime。
* `evaluation/search-quality/run-cannonwar-search-quality.ts` 只执行已有索引上的 `semanticSearch`，不触发 `indexCodebase`。
* `pnpm benchmark:search:cannonwar` 是默认入口，可用 `--out <path>` 写出 JSON report。

阶段 1、阶段 2、阶段 3 的实现和验证已完成：

* 阶段 1：core search 把可见 `outputLimit` 和内部 `candidateLimit` 分离，默认内部候选池为 `min(max(outputLimit * 4, 80), 200)`；hybrid dense/sparse、regular vector search 和 lexical supplement 都使用扩大后的候选池，最终结果仍按 `outputLimit` 裁剪。broad lexical 是否执行改为看 exact rows 中 owner-quality 候选是否覆盖可见输出范围，避免 metadata/path 噪声阻断 content broad recall。
* 阶段 2：`VectorDocument`、gRPC/REST Milvus regular + hybrid schema、insert/search output 和 search result rehydrate 已支持 `primarySymbol`、`symbolKind`、`chunkKind`、`isDefinition`、`fileRole`、`basename`、`pathSegment0..4`。新 collection description 写入 `schemaVersion:2`、`metadataVersion:2`、`splitterType`；旧 schema 会提示 reindex，并在 search 时走 legacy output fields 和 legacy `metadata like` fallback。
* 阶段 3：AST splitter 已补 TSX/JSX parser 分支、Markdown header section splitter、TypeScript/Python/Go/Rust/Java/C# definition metadata 覆盖；`isDefinition + symbolName` 会进入 `definitionIdentifiers`；LangChain generic fallback 的重复文本行号估算已改为从上一匹配位置继续；overlap 只用于大 definition 的二次切分，不跨独立顶层 AST chunk。

`pnpm benchmark:search:cannonwar` 会先执行 `pnpm build:core`，避免 runner 通过 package `main` 读到旧 `packages/core/dist`。最新 report 写在 `evaluation/search-quality/cannonwar-latest-report.json`；日志确认 30/30 轮使用 `output=20, candidates=80`，dense/sparse hybrid request 均为 `limit=80`。

当前 `/opt/CannonWar` 实测已切到本地 Milvus package install，不使用 Docker。全局配置使用 `milvusAddress: localhost:19530`，未设置 `milvusToken`。`/opt/CannonWar` 已按 schema v2 重新 index 到 collection `hybrid_code_chunks_a9e9a6a5`，collection row count 为 `7769`，snapshot 记录 `indexedFiles: 380`、`totalChunks: 7769`、`indexStatus: completed`，collection description 显示 `schemaVersion:2`、`metadataVersion:2`、`splitterType: ast`。

最新 `/opt/CannonWar` report 摘要：

* `expectedImplementationTop3`: 27/30
* `expectedImplementationTop5`: 27/30
* `missingExpected`: 1/30
* `testFirstRate`: 0
* `barrelFirstRate`: 0
* `relatedTestsPresent`: 24/30

仍待解决的问题集中在自然语言 ownership / adapter / entity lifecycle 类查询：含准确符号的查询已经稳定命中，schema v2 结构字段也已生效；剩余失败项主要是 implementation 之间的 owner 排序和宽泛查询目标问题。后续重点是显式 role、结果分组、fileRole/chunkRole 和结构 rerank。

已验证：

```bash
pnpm --filter @hitmux/hitmux-context-engine-core test
pnpm --filter @hitmux/hitmux-context-engine-mcp test
pnpm typecheck
pnpm build:core
pnpm benchmark:search:cannonwar -- --out /opt/hitmux-context-engine/evaluation/search-quality/cannonwar-latest-report.json
```

## Roo-Code 静态参考结论

Roo-Code 的整体检索架构不比本仓库更强：它主要依赖 Qdrant vector score、`minScore` 和 `maxResults`，没有 HCE 当前已有的 hybrid BM25+dense、lexical supplement、role-aware ranking、dedupe 和 source rehydrate。

有参考价值的部分集中在索引质量和结构字段：

* chunk 更贴近语义块：Tree-sitter query 优先抓 function/class/method/interface 等代码责任单元，`MAX_BLOCK_CHARS=1000`，并避免尾部碎片过小。
* Markdown 按 header section 切分，header text 作为 identifier，比普通文本窗口更适合 README、docs、Plan 类文件。
* upsert 时把路径拆成 `pathSegments.0..n`，并为前几级 path segment 建 payload index，用于目录过滤和删除。
* 用 `fileHash` 判断文件新鲜度，用 `segmentHash` 稳定 chunk 身份。
* 用 metadata point 标记 `indexing_complete`，搜索时排除 metadata point，并允许 indexing 中搜索但提示结果可能不完整。

不采纳的部分：

* 不迁移到 Qdrant；Milvus hybrid schema 是当前基础。
* 不照搬纯 vector score ranking。
* 不把工具 prompt 当作准确性主方案。
* 不把 Roo-Code watcher 的实时更新实现作为参考依据；静态阅读显示其 batch upsert 路径并不完整。

## 当前问题

`/opt/CannonWar` 的当前实测结果显示：含准确符号的查询已经稳定命中，纯自然语言查询也能把 expected implementation 放进可见输出；但一次搜索仍不稳定，常见问题变成类型/导出片段、facade/adapter、相邻概念片段排在真实 owner implementation 之前。这个结果更像“候选入口搜索”，不是稳定的问题定位。

本仓库当前剩余设计问题：

* `/opt/CannonWar` 已用 schema v2 重建索引，结构字段可以参与搜索；当前剩余 top5 外 case 主要是多个 implementation 候选都语义相关时，owner implementation 没有稳定排到前列。
* `packages/core/src/search/file-role.ts` 的 `inferFileRoleIntent(query, filterExpr)` 会从 query 文本推断 `test`、`docs`、`style`、`config`、`generated`，并影响排序。
* `packages/core/src/context.ts` 的 `strongAnchors`、`weakDescriptors`、`roleHints`、`pathHints` 会按 query 词形决定 lexical supplement 的召回和分数。
* `scoreFileRoleMatch()` 只有在 lexical score 大于 0 时才参与加减分，纯 semantic 命中的 `test`、`docs`、barrel export 仍会和 implementation 同池竞争。
* `fileRole` 类型已包含 `barrel` / `entrypoint`，但 `classifyFileRole()` 还没有用 AST/export 事实识别纯 re-export 或入口文件，`index.ts` re-export 仍可能被当成 implementation。
* 阶段 4 的显式 `targetRole` / `includeRelated` 和结果分组尚未实现，tests/docs/config/barrel 还没有 API contract 级别的主结果隔离。

## 设计原则

* 候选池大小和最终输出数量分离；默认输出保持克制，内部召回池必须给 rerank/dedupe 足够空间。
* 强信号优先结构化：filename、basename、path segment、primary symbol、definition flag、file role、chunk role 应作为可过滤字段进入向量库 schema。
* 不从自然语言 query 推断用户想找 `implementation`、`test`、`docs` 或 `config`。
* `search_code` 默认是 implementation/source owner search。
* 角色切换必须来自显式参数，或来自精确文件名、路径、扩展名这类字面证据。
* 文件角色和 chunk 角色来自代码结构事实：路径、文件名、AST、import/export、测试框架语法、配置文件约定。
* 主结果和 related results 分组输出，不让 tests/docs/config/barrel 默认和 implementation 混排竞争。
* 排序只在同一结构分组内微调；跨组优先级由工具契约和显式参数决定。
* 复杂问题最终要走结构导航：definition、reference、import/export、caller/callee、related tests，而不是一次 semantic rank。

## 非目标

* 不继续扩大自然语言词表、query classifier、role hint、weak descriptor 规则。
* 不把 benchmark case、项目专用词或 `/opt/CannonWar` 特定知识写进 runtime。
* 不把 LLM query rewrite 作为第一阶段依赖。
* 不用“调分数”替代结构分组和导航工具。
* 不把迁移 Qdrant 作为准确性改造路径。

## 阶段 1：扩大召回池并保留输出 limit

目标：解决“正确实现没进候选池，排序无从修正”的问题。

实现状态：已完成代码、单元测试和 `/opt/CannonWar` benchmark 验收。阶段 1 解决了候选池过小的基础问题；剩余排序质量问题进入阶段 4+ 的显式 role、结果分组、fileRole/chunkRole 和结构 rerank，不继续用调分数替代结构字段。

任务：

* 将 core search API 内部的 `candidateLimit` 和最终 `outputLimit` 分离。
* 默认输出仍由 MCP `limit` 控制；内部 dense/sparse search 使用 `max(outputLimit * 4, 80)` 一类有上限的候选池策略。
* lexical supplement 的候选池也基于 `candidateLimit`，最终输出统一 dedupe/rerank 后再裁剪。
* broad lexical 是否执行不能只看 raw `exactRows.length`，应先看有效高分候选覆盖情况，避免 metadata/path 噪声挡住 content broad recall。
* 记录默认候选池倍率的理由，并限制 Milvus 请求量和输出大小。

验收：

* 默认 `search_code` 输出数量不变，但内部候选池大于输出数量。
* 正确 implementation 因未进 top20 而丢失的 case 明显减少。
* 精确符号查询保持当前强命中能力。
* 查询耗时和 Milvus 请求量保持在可接受范围。
* `pnpm --filter @hitmux/hitmux-context-engine-core test` 通过。

当前验收结果：schema v2 重建后，`/opt/CannonWar` 30 case 中 27/30 进入 top3/top5；exact 组 15/15 进入 top3/top5，自然语言组 12/15 进入 top3/top5。日志确认默认输出仍为 20，内部 hybrid 候选池为 80。

## 阶段 2：结构化 metadata / Milvus schema

目标：把 AST 和路径信号从 JSON `metadata` 提升为可过滤、可排序、可迁移的结构化字段。

实现状态：已完成。结构字段已进入 `VectorDocument`、gRPC/REST Milvus regular + hybrid schema、insert/search output 和 result document；旧 JSON `metadata` 仍保留为兼容输出。`buildExactCandidateFilter()` 在 schema v2 上使用 `basename`、`primarySymbol`、`isDefinition`、`pathSegment0..4` 等结构字段；旧 schema collection 会被标记为 legacy，并使用 legacy output fields 和 `metadata like` fallback。

拟新增字段：

```text
primarySymbol: string
symbolKind: string
chunkKind: string
isDefinition: boolean
fileRole: implementation | test | docs | style | config | generated | barrel | entrypoint
basename: string
pathSegment0..pathSegment4: string
```

验收：

* exact filename、basename、symbol definition 可以不依赖 `metadata like` 命中：已用单元测试覆盖 schema v2 filter/output 路径。
* path segment / directory hint 能参与候选召回或过滤：已进入 schema 和 lexical/exact filter。
* 旧 collection schema mismatch 有明确 reindex 提示：已实现，并由 schema 回归测试覆盖；当前 `/opt/CannonWar` collection 已是 schema v2。
* gRPC 和 REST Milvus 实现字段一致：已覆盖 regular + hybrid schema 和 legacy output fields 回归。

## 阶段 3：跨语言 definition 和 splitter 质量

目标：让 chunk 对齐代码责任单元，并让 definition metadata 在多语言下稳定生效。

实现状态：已完成低风险实现，Tree-sitter query/capture 仍保留为长期优化方向。当前版本继续使用 node type 白名单 + regex，但已修正 parser export 选择、TSX/JSX 分支、跨语言 definition 提取、Markdown section splitter 和 fallback 行号估算。

验收：

* TypeScript、TSX、Python、Go、Rust、Java/C# definition metadata：已由 `ast-splitter.test.ts` 覆盖。
* Markdown section 查询定位到具体 header section：已由 `ast-splitter.test.ts` 覆盖。
* 重复文本 fallback chunk 行号从上一匹配位置继续估算：已由 `langchain-splitter.test.ts` 覆盖。
* 大 definition 二次切分只在同一 definition 内加 overlap，且只有第一个 sub-chunk 保留 definition metadata：已由 `ast-splitter.test.ts` 覆盖。

## 阶段 4：显式搜索目标和结果分组

目标：把搜索目标从 query 猜测改为 API contract，并让主结果与 related results 分组输出。

拟新增参数：

```ts
targetRole?: "implementation" | "test" | "docs" | "config" | "all";
includeRelated?: boolean;
```

默认：

```ts
targetRole = "implementation";
includeRelated = true;
```

默认输出分组：

* `Implementation matches`
* `Entry / exports`
* `Related tests`
* `Docs / config`

任务：

* 在 MCP schema、handler 参数校验和 core search API 中传递 `targetRole` / `includeRelated`。
* 将 primary results 和 related results 分开组装。
* 把 `Score reason` 改成更准确的 `Match signals` 或等价字段，避免把启发式信号写成验证结论。
* `docs/package-reference.md` 的 focused code-search query / `limit` 口径已先行更新；阶段 4 新增 `targetRole` / `includeRelated` 后再同步新参数。

验收：

* `targetRole="implementation"` 时，tests/docs/config/barrel 不抢 primary rank。
* `targetRole="test"` 时，test files/test cases 成为 primary。
* `targetRole="docs"` / `targetRole="config"` 只由显式参数触发。
* MCP args tests 覆盖默认值、非法值、显式 role 和输出分组。

## 阶段 5：结构化 fileRole / chunkRole

目标：用结构事实替代自然语言 role 猜测。

扩展 metadata：

```text
fileRole: implementation | test | docs | style | config | generated | barrel | entrypoint
chunkRole: definition | method_body | reference | test_case | assertion | re_export | module_decl
```

任务：

* 扩展 `classifyFileRole()`，识别 `barrel` / `entrypoint`。
* 用通用路径规则识别多语言测试文件，例如 `*.test.*`、`*.spec.*`、`*_test.go`、`test_*.py`、`*_test.py`、`*Test.java`、`*Tests.cs`、`*_spec.rb`。
* 在 AST splitter 中输出更明确的 `chunkRole`，区分 definition、method body、export/re-export、test case。
* 识别 re-export-only 文件，不把纯 barrel 当 implementation owner。
* 保持语言 adapter 小而明确，只映射 AST/文件结构，不解释自然语言。

验收：

* `index.ts` / `__init__.py` / module entry 文件只有在包含真实实现时才进入 implementation primary。
* 纯 re-export chunk 默认进入 `Entry / exports`。
* TypeScript、Python、Go、Java/Rust 中至少各有一个 fileRole/chunkRole 单元测试。

## 阶段 6：按结构 rerank

目标：在候选池足够大的前提下，按结构证据稳定排序。

任务：

* 本地 rerank 先按 `targetRole` 和 result group 分层，再按同组结构信号排序。
* 同组排序信号优先级：exact path/file match、exact symbol definition、definition/method body、same basename source file、reference/caller、semantic score。
* 避免 weak descriptor 影响跨组排序。
* 只让 `exact_filename`、`exact_symbol_definition` 这类 owner signal 强制优先；普通 `reference_match` 不应无条件压过高语义分实现候选。
* dedupe replacement 纳入 `scoreReasons`，保护 exact filename / exact definition 的重复候选。

验收：

* 默认 implementation search 的 `test-first rate` 和 `barrel-first rate` 明显下降。
* 精确符号查询保持当前强命中能力。
* 重叠 chunk 中更精确的 definition/filename 命中不会被更宽但不相关的块替换。

## 阶段 7：结构导航工具

目标：把复杂问题从一次搜索升级为可验证的代码链路。

候选工具：

* `find_definitions`
* `find_references`
* `trace_symbol`
* `read_context`
* `related_tests`
* `module_exports`

任务：

* 索引 definitions、references、imports、exports、module graph。
* 对 `search_code` 的 top implementation results 提供可选 follow-up：definition -> references -> import/export -> related tests。
* 输出 evidence chain，明确哪些是实现、入口、调用点、测试覆盖。
* 找不到结构证据时报告不足，不用 semantic similarity 伪装成定位成功。

验收：

* 跨模块问题能返回实现链路，而不是孤立 chunk。
* `多人模式只渲染服务器同步状态客户端不推进完整游戏逻辑` 这类问题至少能给出入口、adapter/facade/controller 相关链路，或明确报告缺失的证据环节。

## 评测基线

`/opt/CannonWar` 的 30 个 hand case 已固化成可复跑 search-quality benchmark。早期手工结果作为待复核基线：

* 含准确符号/文件/类名的 15 轮：强命中 8，部分命中 2，弱命中 5。
* 纯自然语言的 15 轮：强命中 8，部分命中 4，弱命中 3。

指标：

* `expected implementation top3/top5`
* `first implementation rank`
* `test-first rate`
* `barrel-first rate`
* `strong/partial/weak`
* `related tests present`
* `exports separated`

当前最新自动 report（本地 Milvus、schema v2 重建 `/opt/CannonWar` 后）：

* total: 30
* exact 组：15/15 top3，15/15 top5，missing 0
* natural-language 组：12/15 top3，12/15 top5，missing 1
* overall: 27/30 top3，27/30 top5，missing 1
* `test-first rate`: 0
* `barrel-first rate`: 0
* `related tests present`: 24/30

当前 top5 外 case：

* `nl-render-proxy-entities`: expected `src/network/rendering/renderProxy.ts`，rank 13
* `nl-multiplayer-ui-world-facade`: expected `src/ui/interfaces/battle/multiplayerWorldFacade.ts`，rank 7
* `nl-client-entity-lifecycle`: expected `src/game/entities/entityManager.ts`，未命中 expected rank

要求：

* benchmark 只保存 query、expected paths、expected roles 和人工标签，不把项目专用 hint 写进 runtime。
* 每个阶段改动前后都要能输出 before/after。
* 当前 per-case `manualLabel` 仍是 `pending_manual_review`；需要人工复核最新 report 后再写入 `strong` / `partial` / `weak` 标签。

## 当前下一步

1. 人工复核 `evaluation/search-quality/cannonwar-latest-report.json` 中 3 个 top5 外 natural-language case，决定是否更新 fixture 的 `manualLabel` 或收窄/修正 expected owner。
2. 继续阶段 4：设计并实现 `targetRole` / `includeRelated` 参数、primary/related result 分组，以及 MCP args tests。
3. 推进阶段 5：用 AST/export/path 事实识别 `barrel`、`entrypoint` 和更细的 `chunkRole`，减少 re-export / test / docs 与 implementation 混排。
4. 推进阶段 6：基于 `targetRole`、result group、definition/method body、same basename、reference/caller 等结构证据做同组 rerank，重点验证剩余 3 个自然语言 case。
5. 保留 Tree-sitter query/capture 作为阶段 3 之后的长期优化，不作为阶段 4 的阻塞项。

## 验证命令

按改动范围逐步运行：

```bash
pnpm --filter @hitmux/hitmux-context-engine-core test
pnpm --filter @hitmux/hitmux-context-engine-mcp test
pnpm typecheck
pnpm build:core
pnpm build
pnpm benchmark:search:cannonwar -- --out /opt/hitmux-context-engine/evaluation/search-quality/cannonwar-latest-report.json
```

如果只改文档，不需要运行构建和测试；如果修改 core search API 或 MCP schema，至少运行 core tests、MCP tests 和 `pnpm typecheck`。
