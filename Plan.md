# MCP indexing 远端状态与写锁重构计划

## 当前结论

`get_indexing_status` 的问题不是“是否访问远端”，而是状态查询把三类不同责任混在了一起：

* 当前远端事实：collection 是否存在、绑定的 codebasePath、远端 chunk 行数、索引是否仍可查询。
* 本地执行状态：active indexing progress、job error、sync warning、snapshot 中记录的 indexed file count。
* 修复性恢复：从 chunk metadata 全表扫描中反推出 codebasePath、distinct file count，并回写 snapshot。

用户查询远端状态时应看到当前远端事实，不能退化成只读本地 snapshot。真正需要移出默认路径的是修复性恢复，尤其是：

```ts
query(collectionName, "", ["metadata"], rowCount)
query(collectionName, "", ["relativePath", "metadata"], rowCount)
```

这类 row-level metadata scan 的复杂度随 chunk 数增长，不适合由 `get_indexing_status` 在每次查询时临时执行。

## 设计审查结论

以下方案不作为主线：

* 只调小 `vectorDatabaseSyncTimeoutMs`：只能把卡顿变成固定等待，不能降低正常路径成本。
* 默认只读本地状态：响应快，但不满足用户查看当前远端状态的预期。
* 默认只做轻量远端 probe 且不提供精确远端文件数：能省时间，但如果产品承诺远端状态完整性，属于信息降级。

可行主线是把远端状态变成一等数据：

* 新增远端 status manifest，记录 codebasePath、collectionName、index generation、indexedFiles、totalChunks、schemaVersion、metadataVersion、updatedAt、status。
* `get_indexing_status` 实时读取 manifest，并用目标 collection 的 `hasCollection()`、`getCollectionDescription()`、`getCollectionRowCount()` 做一致性校验。
* chunk metadata 全表扫描只在显式 migration / repair 流程中执行，用来给旧 collection 生成 manifest 或修复损坏状态。
* 新索引和增量 sync 必须同步维护 manifest；status 查询不再临时从 chunk 行恢复业务事实。

## 目标行为

`get_indexing_status` 默认仍访问远端，并返回当前远端事实：

* 目标 collection 当前是否存在。
* collection description 中声明的 codebasePath。
* 远端 manifest 中记录的 status、indexedFiles、totalChunks、generation、updatedAt。
* collection 当前 `count(*)` 与 manifest totalChunks 是否一致。
* 本地 snapshot / job state 中的 active progress、last error、sync warning。

默认状态查询不得执行 row-level metadata scan。遇到缺失 manifest 的旧 collection 时，应明确报告：

* collection 当前存在。
* manifest 缺失或过期。
* 需要运行显式 migration / repair 才能获得精确远端 file-level 状态。

这不是把远端状态降级为本地状态，而是把“旧数据缺少远端 manifest”作为真实状态暴露出来。

## 分阶段修复

### Phase 1: 远端 status manifest 与状态查询边界

状态：已完成。

已落地：

* 新增远端 manifest 结构和读写路径，字段包含 `codebasePath`、`collectionName`、`status`、`indexedFiles`、`totalChunks`、`schemaVersion`、`metadataVersion`、`generation`、`updatedAt`。
* `get_indexing_status` 默认执行 collection-level probe：`hasCollection()`、`getCollectionDescription()`、`getCollectionRowCount()`，并读取远端 manifest。
* 默认 status、search snapshot recovery、index validation、vector DB sync 都不再执行 chunk row-level metadata scan；manifest 缺失时返回 repair 指引或跳过隐式恢复。
* collection probe 和 manifest read 都有 in-flight dedupe；同一 collection 的并发 status 只产生一组 collection-level probe。
* `count(*)` 只作为远端 chunk count / mismatch 校验来源；精确 file count 来自 manifest。

验收状态：

* 已覆盖 manifest 缺失、description mismatch、row count mismatch、并发 probe dedupe、默认 status 不跑 metadata query。
* `query(collectionName, "", ["metadata"], rowCount)` 和 `query(collectionName, "", ["relativePath", "metadata"], rowCount)` 只保留在显式 repair 路径。

### Phase 2: manifest 写入与 legacy migration / repair

状态：已完成。

已落地：

* full indexing 完成后写入远端 manifest；空索引也写入 0/0 manifest，但本地 snapshot 仍保留原有 0/0 completed 防护。
* incremental sync 有变化和无变化时都会通过当前 Merkle tracked file count 与 collection row count 更新 manifest 的 `indexedFiles`、`totalChunks`、`generation`、`updatedAt`。
* CLI `hce index` 对已有 index 做 sync 后只读取远端 manifest 回填 snapshot；manifest 缺失时提示运行 repair，不再从 chunk metadata 反推统计。
* `clear_index` 删除 collection 后同步删除请求路径和同 collection 已跟踪 sibling paths 的 manifest。
* 新增显式 `repair_index_manifest`，持有 writer lock，按阶段暴露 repair progress，只在该入口执行一次性 row-level metadata scan，为旧 collection 写入 manifest。
* shared collection / 多 codebase 场景按 `(collectionName, codebasePath)` manifest key 表达归属；默认路径不再靠 chunk metadata 反查。

验收状态：

* 新索引和增量 sync 后，status 可从 manifest 返回完整远端状态。
* 旧 collection 只有运行 `repair_index_manifest` 后才会获得精确 file-level 远端状态。
* repair 失败不会写 0/0 completed；manifest 与 collection row count 不一致时 status 报告 mismatch。
* search/index/sync 的隐式 snapshot recovery 改为 manifest-only，缺 manifest 时不执行 legacy scan。
* `clear_index` 的 manifest 删除失败只作为 cleanup warning，不会阻断 collection drop 后的 snapshot 和 sibling manifest 清理。

### Phase 3: writer lock 可观测性和短期误伤修正

状态：已完成。

已落地：

* writer lock busy message 会返回当前 owner 信息：`label`、`pid`、`acquiredAt`、`heartbeatAt`、锁路径和已持锁时长。
* manual `index_codebase`、`clear_index`、`repair_index_manifest` 和 strong `search_code` pre-search sync 遇到锁时，错误信息会说明目标 collection 当前由哪个操作占用。
* automatic sync 遇到目标 collection 锁忙时只跳过该 codebase，写入 snapshot `syncWarning`，整轮日志报告 completed with warnings，不把锁忙误报成全量成功。
* 锁回收逻辑已收紧：dead pid lock 仍可自动回收；pid 仍存活时，不再仅因 `heartbeatAt` 过期抢锁。

验收状态：

* 用户无需手动读取 `~/.hitmux-context-engine/locks/collections/<collection>.lock/owner.json` 即可知道锁来源。
* 活进程 stale heartbeat、dead pid lock、owner 详情输出均有 targeted tests 覆盖。

修改范围：

* `packages/mcp/src/sync-lock.ts`
* `packages/mcp/src/handlers.ts`
* `packages/mcp/src/sync.ts`
* 对应 MCP lock/concurrency 测试

任务：

* 后续如增加跨 collection migration，需要复用 global maintenance lock，不要回到单个 `$HOME` 级长 writer lock。

验收标准：

* 已满足。

### Phase 4: 锁粒度拆分

状态：已完成。

已落地：

* `$HOME` 级长 writer lock 已拆成 per-collection writer lock，路径位于 `~/.hitmux-context-engine/locks/collections/<collection>.lock`。
* `index_codebase`、`clear_index`、manual/automatic sync、strong `search_code` pre-search sync 和 manifest repair/update 都按目标 collection 互斥。
* full indexing 只持有目标 collection lock；不同 collection 的 manual indexing 可以并行启动。
* automatic sync 按 codebase 单独尝试 collection lock；锁忙只跳过该 codebase，继续同步其他 collection。
* snapshot 仍使用独立短锁保护 snapshot 文件原子读改写；长时间 indexing 不再持有 snapshot lock。
* `clear_index` 对目标 collection 获取独占 lock，并保留同进程 active indexing job 的取消与等待逻辑；如果取消后 collection lock 被其他 writer 抢占，刚取消的本地 indexing snapshot 会转为 `indexfailed`，避免永久停在 `indexing`。

验收状态：

* 两个不同 collection 的 manual indexing 并行启动已有 targeted test 覆盖。
* 同一 collection 的同 path / 不同 path `index_codebase` 互斥，以及 sync/clear/manifest update 的 collection lock 行为已有 targeted tests 覆盖。
* automatic sync 锁忙跳过单个 collection、继续其他 collection，并持久化 `syncWarning` 已有 targeted test 覆盖。

修改范围：

* `packages/mcp/src/sync-lock.ts`
* `packages/mcp/src/handlers.ts`
* `packages/mcp/src/sync.ts`
* `packages/mcp/src/snapshot.ts`

验收标准：

* 已满足。

### Phase 5: indexing worker 隔离

状态：已完成。

已落地：

* full indexing 的真实 `Context` 路径已从 MCP server 主执行流移到 `worker_threads`，worker 内通过共享 runtime context 工厂重建 embedding、Milvus vector DB 和 `Context`。
* MCP server 负责启动 job、持有目标 collection writer lock、转发取消信号、接收 progress / completed / failed / cancelled 消息，并在 worker 收尾后释放锁。
* 新增独立 job state 文件 `~/.hitmux-context-engine/jobs/<jobId>.json`，记录 `jobId`、`codebasePath`、`collectionName`、worker thread、progress、最终 stats 或 error。
* full indexing progress 写入 job state，并只更新内存里的 indexing progress；不再为高频 progress 周期性重写全局 snapshot。
* `get_indexing_status` 会合并 job state、remote manifest 和 collection-level probe；运行中 job 显示 worker progress，失败或 stale job 会直接在状态文本中暴露。
* 即使全局 snapshot 初始保存失败或缺失，只要 job state 存在，`get_indexing_status` 仍会报告 running / failed / cancelled job，不会退化成单纯 `not indexed`。
* worker 成功后由主线程提交最终 snapshot；worker 失败时写 `indexfailed` 和 error message；`clear_index` 继续通过 active task 取消目标 worker 并等待收尾。
* worker 收到 completed / failed / cancelled 终态后会关闭 `MessagePort`，parent runner 会 terminate worker；取消时先 cooperative abort，超时后强制 terminate，避免 worker thread 泄漏或 `clear_index` 无限等待。
* fake context / 单元测试路径保留 inline fallback，用于不依赖真实 provider/Milvus 的 targeted tests。

修改范围：

* `packages/mcp/src/handlers.ts`
* `packages/mcp/src/indexing-worker.ts`
* `packages/mcp/src/indexing-worker-runner.ts`
* `packages/mcp/src/indexing-job-state.ts`
* `packages/mcp/src/runtime-context.ts`
* 对应 MCP job state、index concurrency 和 status tests

验收标准：

* 已满足。

### Phase 6: snapshot 写入去阻塞

状态：已完成。

已落地：

* `SnapshotManager.acquireLock()` 已移除同步 busy wait；同步兼容方法只做即时尝试和 stale lock 清理，不再阻塞 event loop。
* 新增 `saveCodebaseSnapshotAsync()`，使用 async backoff 等待短期锁竞争，写入临时文件后通过 atomic rename 提交 snapshot。
* handler、automatic sync 和 CLI 管理命令的生产保存路径已改为 `await saveCodebaseSnapshotAsync()`。
* 全局 snapshot 仍保存 indexed / indexing / failed 的最终业务状态；full indexing 高频 progress 已移到独立 job state 文件。
* snapshot 保存继续做 read-merge，保留其他进程已写入且当前进程未知的 codebase entry，避免普通并发保存互相覆盖。
* snapshot v2 增加 `removedCodebases` tombstone；一个进程执行 `clear_index` 后，其他持有旧内存的进程保存 snapshot 时不会把已删除 codebase resurrect。

修改范围：

* `packages/mcp/src/snapshot.ts`
* `packages/mcp/src/handlers.ts`
* `packages/mcp/src/sync.ts`
* `packages/mcp/src/cli-manage.ts`
* 对应 snapshot concurrency、job state、handler 和 CLI tests

验收标准：

* 已满足。

## 当前风险

* 旧 collection 没有 manifest 时，想获得精确远端 file-level 状态仍需要一次性 `repair_index_manifest`；这个成本无法通过普通 status 查询消失。
* manifest 与 collection 更新不是 Milvus 原子事务；当前用 per-collection writer lock、generation 和 status mismatch 报告降低误判。
* per-collection lock 已替代 `$HOME` 级长 writer lock；后续新增全局 migration / repair 时仍需单独设计 maintenance lock，避免重新阻塞普通 collection indexing。
* 在没有 fencing token 的情况下，仍不应抢占 pid 存活的 stale heartbeat lock。
* worker 隔离当前使用 worker thread，不是独立 daemon；MCP server 进程退出时 worker 会随进程结束，重启后的旧 running job 以 stale 状态暴露。
* snapshot read-merge 与 deletion tombstone 能保住未知 entry 并防止已删除 entry 被旧内存恢复，但还不是严格 compare-and-swap；极端跨进程同时修改同一 codebase entry 时仍以后写入者为准。

## 建议验证命令

优先按阶段运行 targeted tests：

```bash
pnpm --dir packages/mcp exec node --import tsx --test src/handlers.get-indexing-status.test.ts
pnpm --dir packages/mcp exec node --import tsx --test src/handlers.args.test.ts src/handlers.clear-index.test.ts
pnpm --dir packages/mcp exec node --import tsx --test src/indexing-job-state.test.ts src/indexing-worker-runner.test.ts src/snapshot.concurrent.test.ts src/handlers.index-concurrency.test.ts src/cli-manage.test.ts
pnpm --filter @hitmux/hitmux-context-engine-core test -- --runTestsByPath src/context.indexing-lifecycle.test.ts
pnpm --dir packages/mcp exec node --import tsx --test src/sync-lock.test.ts src/handlers.index-concurrency.test.ts src/handlers.clear-index.test.ts
```

跨阶段改完后再运行：

```bash
pnpm typecheck
pnpm test
```
