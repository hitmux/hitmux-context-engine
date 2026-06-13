# AGENTS.md

## 语言与协作方式

* 面向用户的回复、文档和本文件默认使用中文；代码、标识符、API 名称、CLI 参数、错误文本和配置键保持英文原文。
* 回复要直接、简洁，说明实际改动、验证结果和剩余风险。不要写空泛总结或无法证明的结论。
* 开始开发前先确认目标、范围和验收标准。需求不清、互相冲突或会影响公开 API/数据兼容性时，先把可选方案说清楚再继续。
* 不要使用本仓库自己的 `hitmux-context-engine` / MCP search_context 工具来分析或修改本仓库，除非用户明确要求。常规定位使用 `rg`、`rg --files`、`find`、`ls` 和直接读取文件。
* 除非用户明确要求，不要使用 `git` 命令，包括只读查看命令。

## 仓库结构

这是一个 pnpm workspace，根目录只放工作区配置、共享脚本、文档和评测工具。主要代码在：

* `packages/core`: 核心 TypeScript 包，负责项目索引、文件收集、ignore 规则、splitter、embedding、向量库、搜索和 `Context` API。
* `packages/mcp`: MCP server 包，负责工具参数校验、配置解析、embedding provider 适配、handler、snapshot、sync 和 server 入口。
* `examples/basic-usage`: 本地示例，依赖 workspace 内的 core 包。
* `docs`: 用户文档，包括 quick start、configuration、package reference 和 troubleshooting。
* `evaluation`: Python/uv 评测代码、MCP/grep/read/edit server 对比、case study 日志和结果。
* `python`: 轻量 Python 辅助和端到端测试脚本。
* `scripts`: 共享 Node 或 shell 脚本，例如 benchmark 和本地全局安装脚本。

生成文件放在各包的 `dist/` 下。不要手改 `dist/`、`node_modules/`、`*.tsbuildinfo` 或评测输出，除非任务明确要求处理生成物。

## 常用命令

要求 Node `>=20`、pnpm `>=10`。

* `pnpm install`: 按 `pnpm-lock.yaml` 安装依赖。
* `pnpm build`: 构建 `packages/*`。
* `pnpm build:core`: 构建 `@hitmux/hitmux-context-engine-core`。
* `pnpm build:mcp`: 构建 `@hitmux/hitmux-context-engine-mcp`。
* `pnpm build:examples`: 构建 `examples/*`。
* `pnpm dev`: 启动 `packages/*` 的 watch。
* `pnpm dev:core`: 启动 core 的 `tsc --watch`。
* `pnpm dev:mcp`: 使用 `tsx --watch` 启动 MCP server。
* `pnpm lint`: 对 `packages/*` 运行 ESLint。
* `pnpm lint:fix`: 对 `packages/*` 应用 ESLint 自动修复。
* `pnpm typecheck`: 对 `packages/*` 运行 `tsc --noEmit`。
* `pnpm --filter @hitmux/hitmux-context-engine-core test`: 运行 core 的 Jest 测试。
* `pnpm --filter @hitmux/hitmux-context-engine-mcp test`: 运行 MCP 的 Node test 测试。
* `pnpm example:basic`: 启动 basic example。
* `pnpm benchmark`: 运行 `scripts/build-benchmark.js`。

根 `pnpm build` 当前不构建 examples；需要示例构建时单独运行 `pnpm build:examples`。

## 编码规范

* TypeScript 使用 strict mode 和现有 4 空格缩进。
* 可复用 API 优先使用 named exports。
* 命名遵循 `camelCase` 变量/函数、`PascalCase` class/type/interface、`UPPER_SNAKE_CASE` 真常量。
* ESLint 以根目录 `eslint.config.js` 为准；`.eslintrc.js` 若存在，只当兼容遗留文件处理。
* 未使用变量是错误；确实需要保留时用 `_` 前缀。`any` 只在边界类型无法合理表达时使用，并尽量收窄作用域。
* 新增功能优先放在已有责任边界内。文件接近 500 行或职责明显混杂时，优先拆分为小模块。
* 不要随意移动、重命名或删除用户已有内容。

## 测试与验证

* 测试文件放在被测代码旁边，命名为 `*.test.ts`。
* core 使用 Jest 和 `ts-jest`，配置在 `packages/core/jest.config.cjs`。
* MCP 使用 Node 内置 test runner，通过 `node --import tsx --test "src/**/*.test.ts"` 运行。
* 修改 core 的索引、ignore、splitter、embedding、向量库或搜索逻辑时，至少运行 core 测试；如果 public types 或构建输出会受影响，再运行 `pnpm build:core` 或 `pnpm typecheck`。
* 修改 MCP 的配置解析、tool args、handler、snapshot、sync、path resolution 或 server 入口时，至少运行 MCP 测试；如果改动依赖 core 的导出，先运行 `pnpm build:core` 再验证 MCP。
* 修改跨包 API、workspace 配置或依赖时，运行 `pnpm typecheck`，必要时再运行 `pnpm build`。
* 修改 docs/examples 时，验证对应文档中的命令仍存在；修改 example 时运行 `pnpm build:examples` 或 `pnpm example:basic` 中最贴近的命令。
* 如果验证不能执行或依赖外部服务/API key，报告 `not verified`，并说明缺少的条件。

## 配置与安全

* 不要提交 API key、Milvus/Zilliz token、provider credential、私有 endpoint 或本地绝对机密路径。
* provider、embedding、Milvus/Zilliz、OpenAI-compatible endpoint 等行为先查 `packages/core/src` 和 `packages/mcp/src/config.ts` 的真实代码，不要按 README 或旧文档猜。
* 调外部 API 或 CLI 前，先确认当前文档中的 model name、endpoint 和参数语法；无法确认时明确说明不确定。
* 本地环境值通过环境变量或用户已有配置传入，不要为了测试把凭据写进仓库文件。

## 文档维护

* 没有用户明确要求时，不新增 `.md`、README 或其他 Markdown 文档。
* 编辑既有文档时，保留其用途，删掉重复和含糊内容，让结果读起来像最终版。
* 更新规划类文档时，把已完成内容压缩为事实状态，把篇幅留给未完成范围、风险、验收状态和下一步。
* 文档中的命令、包名、路径和环境变量必须来自当前仓库事实。

## 发布与构建产物

* `release:core` 和 `release:mcp` 会构建并执行 npm publish，只有用户明确要求发布时才运行。
* 构建产物位于 `packages/core/dist`、`packages/mcp/dist` 和 `examples/basic-usage/dist`。完成报告只有在任务产生或更新构建产物时才列出绝对路径。
* 不要把 generated artifacts 当作源码修复入口；源码在 `src/`。

## 默认提交身份

用户明确要求提交或发 PR 时，默认使用：

```text
Email: caokai674@gmail.com
```
