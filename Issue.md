# Issue.md

## 当前状态

2026-06-15 已逐一修复 2026-06-14 只读审查留下的 P2 问题：

- `scripts/mcp-status-smoke.mjs` 默认命令已与 `scripts/install-local-global.sh` 的本地安装 wrapper 对齐。
- `pnpm build:examples` 已先构建 core，再构建 `examples/*`。
- core 和 MCP 发布包已包含 `src`，使 `dist/*.map` 与 `.d.ts.map` 指向的源码路径在包内可用。
- Python E2E 已固定从脚本所在目录解析 `test_context.ts`，失败时返回非 0 退出码，并明确标记为 legacy core-only smoke。
- CannonWar search-quality runner 已把 `databaseUseSystemProxy` 传给 `MilvusVectorDatabase`，与 MCP runtime 的数据库代理配置一致。
- 已补充轻量 tooling 回归测试覆盖上述脚本、package 配置和 benchmark proxy 参数。

已执行验证：

```bash
node --test scripts/build-benchmark.test.js scripts/p2-tooling.test.js
pnpm build:examples
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @hitmux/hitmux-context-engine-core pack --dry-run
pnpm --filter @hitmux/hitmux-context-engine-mcp pack --dry-run
```

结果：通过。

未执行真实 Milvus/Zilliz endpoint smoke；涉及真实远端连接、凭据和代理环境的 live reproduction 为 `not verified`。

当前没有待处理问题。
