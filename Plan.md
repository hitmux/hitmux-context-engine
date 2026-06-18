# 性能瓶颈处理计划

## 当前状态

本计划记录 2026-06-18 只读分析发现的 6 个主要性能瓶颈。第 1 项已完成：普通 `search_code` 不再无条件触发全库 VectorDB collection 同步，snapshot 缺失时改为目标 collection / bounded ancestor 恢复。第 2 项已完成：默认 `search_code` 改为低延迟模式，full-scan due / unknown watcher 状态不再阻塞搜索，强一致刷新通过显式 `consistency: "strong"` 请求。第 3 项已完成：standalone filename-like query 不再递归扫描文件树或执行大范围 `relativePath like` / `content like`，改走结构化 exact filename checks。第 4 项已完成：watcher dirty path 自动同步优先走 `reindexChangedPaths()`，due full scan 改为独立后台 reconciliation，并补充 full scan/hash 耗时和文件数量日志。第 5 项已完成：`search_code` 单次请求格式化结果时按 resolved source path 复用源文件读取结果，成功读取和读取失败都会缓存，避免同一文件多结果重复 `readFileSync`。第 6 项已完成：full indexing timing summary 增加 wall-clock 总耗时和吞吐字段，并新增可复跑的 indexing baseline runner，用独立临时 collection 记录多轮 p50/p95/error rate，再决定是否调整 `fileProcessingConcurrency`、embedding batch/concurrency 或扫描队列结构。

现有 `benchmark/results/test-hce/results.jsonl` 可作为历史参考：240 条旧搜索记录的 `durationMs` p50 约 644ms，p95 约 1845ms，max 约 3982ms。但该结果最近经过 rescore，不代表最新运行时性能基线。

## 主线任务

1. [已完成] 降低 `search_code` 每次全库 VectorDB 同步成本
   - 瓶颈：`search_code` 入口会先调用 `syncIndexedCodebasesFromVectorDatabase()`，该流程会 `listCollections()` 并逐个 collection 抽取 `codebasePath`。collection 数量多或远程 Milvus/Zilliz 延迟高时，一次搜索会被放大全库扫描成本。
   - 状态：`handleSearchCode()` 入口已移除无条件 `syncIndexedCodebasesFromVectorDatabase()`；普通搜索只刷新本地 snapshot。snapshot 缺失时通过目标 collection 和最多 32 层 ancestor `hasIndex()` 探测恢复，恢复前必须拿到可验证 row count，并优先使用 collection description 的 `codebasePath` 校正真实 indexed root。
   - 验收：普通 `search_code` 不再无条件触发全库 `listCollections()`；snapshot 丢失时仍能通过目标 collection 或已索引父级恢复；`get_indexing_status` / `index_codebase` 等状态和管理路径仍保留全库恢复能力。
   - 验证：`pnpm --dir packages/mcp exec node --import tsx --test src/handlers.args.test.ts src/handlers.get-indexing-status.test.ts`；`pnpm --filter @hitmux/hitmux-context-engine-mcp typecheck`；`pnpm build:mcp`。

2. [已完成] 拆分低延迟搜索与强一致搜索
   - 瓶颈：默认 `search_code` 会调用 `refreshCodebaseIndexBeforeSearch()`，再进入 `syncCodebaseForSearch()`。watcher clean 且未到 fallback interval 时可以跳过；dirty、unknown 或 full scan due 时会把交互搜索变成同步/reindex 请求。
   - 状态：`search_code` 新增 `consistency` 参数，默认 `low_latency`；显式 `consistency: "strong"` 保留强一致 fail-closed 行为。默认搜索在 watcher clean 且 full scan due、unknown watcher、active sync 或 writer lock busy 时继续查询当前索引，并在返回文本中写入 stale 风险；dirty path 且支持 `reindexChangedPaths()` 时仍走 targeted sync，并把 due full-scan reconciliation 排到后台。
   - 验收：clean 项目搜索不执行 full scan；dirty path 可走 targeted sync；unknown/full-scan due 不阻塞默认搜索，并能把 stale 风险写入返回提示或后台状态。
   - 验证：`pnpm --dir packages/mcp exec node --import tsx --test src/handlers.args.test.ts src/sync.background.test.ts`；`pnpm --filter @hitmux/hitmux-context-engine-mcp typecheck`；`pnpm build:mcp`；子代理只读复查后发现的 `skipConsistencyCheck` 兼容参数优先级问题已修复并重新验证。

3. [已完成] 避免 filename-like query 的请求时大范围扫描
   - 瓶颈：`analyzeFilenameLikeQuery()` 对 filename-like query 会扫本地文件树，basename 查询最多扫描 100000 entries，并在索引中执行 `relativePath like "%...%"` 最多取 10000 rows。
   - 状态：standalone filename-like query 现在只使用结构化等值查询：path-like 使用 `relativePath == ...`，basename 使用 `basename == ... and fileExtension == ...`。MCP 侧不再递归扫本地文件树，basename 只对 exact index rows 做最多 20 条 bounded `stat` 以保留 index-only stale 提示；path-like 仍能直接检查当前树。core `semanticSearch()` 也会自动识别 standalone filename-like query 并跳过 broad lexical `like` supplement，混合查询如 `router/relay-router.go TaskPrivateData` 保持普通 path/symbol 召回。legacy schema 缺 `basename` / `fileExtension` / `relativePath` 时返回可见 re-index 提示或保留 vector results，不把 filename exact verification 升级成搜索失败。
   - 验收：filename-like query 不再递归扫描大仓文件树；basename/path 精确存在性判断仍能返回 stale index 提示；focused tests 已覆盖 path-like、basename、missing tree、missing index、legacy schema、core direct search 和 mixed-query fallback。
   - 验证：`pnpm --filter @hitmux/hitmux-context-engine-core test -- context.lexical-search.test.ts`；`pnpm --dir packages/mcp exec node --import tsx --test src/handlers.args.test.ts`；`pnpm build:mcp`；子代理两轮只读复查后发现的 core direct entry、legacy `fileExtension` 缺字段问题已修复并重新验证。

4. [已完成] 降低增量同步 full scan/hash 成本
   - 瓶颈：`FileSynchronizer.checkForChanges()` 的 fallback full scan 会递归生成所有 file hashes。虽然已有 mtime/size 复用和 watcher fast path，但 fallback 到 full scan 时仍是 O(files)。
   - 状态：`SyncManager` 已把 due full scan 拆成独立后台 reconciliation timer，普通 `low_latency` 搜索只返回 stale 风险提示并排后台任务；project watcher 触发的自动同步默认按低延迟路径处理 dirty paths，即使 fallback scan due 也先调用 `reindexChangedPaths()`，再排后台 full scan。`FileSynchronizer.checkForChanges()` 现在记录 full scan/hash 耗时、遍历目录数、支持文件数、实际 hash 数、mtime/size 复用数和错误计数。
   - 验收：普通编辑后的自动同步优先调用 `reindexChangedPaths()`；fallback full scan 有明确间隔、后台状态和耗时日志；大仓搜索不会因为 full scan due 直接进入秒级阻塞。
   - 验证：`pnpm --dir packages/mcp exec node --import tsx --test src/sync.background.test.ts src/handlers.args.test.ts`；`pnpm --filter @hitmux/hitmux-context-engine-core test -- synchronizer.test.ts`；`pnpm --filter @hitmux/hitmux-context-engine-mcp typecheck`；`pnpm build:mcp`。

5. [已完成] 减少搜索结果格式化阶段重复同步读文件
   - 瓶颈：MCP 格式化每条 search result 时用 `readFileSync` 重新读取源文件补上下文。`limit` 较大或同一文件重复结果多时，会重复读取相同文件。
   - 状态：`handleSearchCode()` 现在在一次请求的格式化阶段创建局部 `SourceFileCache`，按 resolved absolute source path 缓存 `readFileSync` 成功内容或读取失败 `Error`。同一源文件多个结果复用同一份内容；重复缺失文件也只触发一次读取失败；无有效行号、越界行号和 path escape 仍回退到 indexed chunk。
   - 验收：同一文件多结果只读一次源文件；上下文窗口和 stale fallback 语义不变；测试覆盖重复 path、重复缺失 path、缺失文件、行号越界、path escape、unavailable line range 和正常 rehydrate。
   - 验证：`pnpm --dir packages/mcp exec node --import tsx --test src/handlers.args.test.ts`；`pnpm --filter @hitmux/hitmux-context-engine-mcp typecheck`；`pnpm build:mcp`；子代理深入复查未发现必须修复项，随后按建议补充重复缺失 path 的失败读取缓存测试并重新验证。

6. [已完成] 建立 indexing 热点度量，再调整并发和串行点
   - 瓶颈：full indexing 已有 file processing、embedding batch 和 vector insert 并发，但文件发现仍递归串行，chunk 入队有串行队列保护；本机当前配置 `fileProcessingConcurrency = 2`，embedding batch/concurrency 走 provider 默认。盲目提高并发可能转成 provider 限流或 VectorDB 写入压力。
   - 状态：`Context.indexCodebase()` 的 timing summary 现在稳定输出 `totalIndexingMs`、`scanFilesMs`、`fileWeightStatMs`、`readAndSplitMs`、`embeddingMs`、`vectorInsertMs`、`flushLoadMs`、`verifyMs`、`filesPerSecond` 和 `chunksPerSecond`。新增 `pnpm benchmark:indexing -- --project-root <path> --runs <n>`，默认使用 `indexing_baseline_<timestamp>` 临时 collection，多轮结束后写 `benchmark/results/indexing-baseline/report.json`，包含每个阶段 p50/p95/min/max、失败次数和 error rate。runner 限制 collection override 必须带 `indexing_baseline_` 前缀，启动时遇到已存在的临时 collection 默认 fail closed，只有显式 `--allow-drop-existing-baseline` 才允许复用旧 baseline collection。
   - 验收：调参或代码改动前后可用同一命令复跑 baseline 并比较 p50/p95/error rate；baseline runner 默认不复用普通业务 collection；报告明确区分 `totalIndexingMs` / throughput 这类 wall-clock 指标，以及 `readAndSplitMs` / `embeddingMs` / `vectorInsertMs` 这类 accumulated worker/batch time；是否提高 `fileProcessingConcurrency`、调整 batch size/concurrency 或优化扫描队列，必须基于该报告和 provider/VectorDB 错误率再决定。
   - 验证：`pnpm --filter @hitmux/hitmux-context-engine-core test -- context.indexing-lifecycle.test.ts`；`pnpm build:core`；`pnpm --dir packages/mcp exec tsx ../../benchmark/run-indexing-baseline.ts --help`。真实仓库 baseline 需要可用 embedding provider 和 Milvus/Zilliz 连接，本阶段只建立复跑工具和度量口径。

## 验证计划

- 新增或扩展 search latency breakdown，至少区分 `sync-vdb`、`consistency-sync`、`filename-analysis`、`embedding`、`vector-search`、`lexical-query`、`result-rehydrate-format`。
- 针对每个主线任务补 focused tests，优先覆盖 MCP handler 行为和 core sync/search 行为。
- 性能验证分两层：小型 deterministic tests 保证语义不退化；真实仓库 smoke/benchmark 用固定配置记录 p50/p95/max。
- benchmark freshness 仍需和 runtime quality 分开解释，避免把 fixture stale、rescore 或旧索引状态误读为性能变化。
- indexing 并发调参必须先保留 `benchmark:indexing` 报告，再同时看 p50/p95、`embeddingMs`、`vectorInsertMs`、`flushLoadMs` 和 error rate；没有报告时不把并发上调写成性能结论。
