---
name: hitmux-context-engine
description: 使用 Hitmux Context Engine 的 hitmux-context-engine CLI 为当前代码仓库建立索引、检查索引状态并进行语义代码搜索。用户要求查找实现、定位 workflow、理解项目结构或检查索引时使用；优先走 CLI，不需要启动 MCP server。
---

# Hitmux Context Engine

使用 `hitmux-context-engine` CLI 查询仓库上下文。`hce` 只是可选 alias，不应假定已经安装。这个 Skill 面向 shell 调用，适用于没有 MCP 或希望把搜索结果交给脚本继续处理的 agent。所有由 Agent 执行的命令都显式使用 `--json`，避免 PTY 环境被识别为交互终端。

## 工作流

1. 先确认 CLI 可用：

   ```bash
   hitmux-context-engine --json --version
   ```

2. 首次使用或配置变更后先运行本地诊断：

   ```bash
   hitmux-context-engine --json doctor --no-connectivity
   ```

   需要访问 embedding provider 或 Milvus 时再运行 `hitmux-context-engine doctor`。不要把 provider key、Milvus token 或完整 `config.conf` 内容写入对话或日志。

3. 在目标仓库根目录检查索引：

   ```bash
   hitmux-context-engine --json status "$PWD"
   ```

   如果返回 `not indexed`，先运行：

   ```bash
   hitmux-context-engine --json index "$PWD"
   ```

   索引是远程 embedding 和 vector database 操作，开始前确认目标路径正确。索引完成后再次运行 `hitmux-context-engine --json status "$PWD"`。

4. 用自然语言和标识符组合查询：

   ```bash
   hitmux-context-engine --json search "handler that validates MCP tool arguments" "$PWD" --scope code --limit 8
   ```

   `--scope` 可选 `all`、`docs`、`code`。省略 `--limit` 时使用自动 TopK；需要脚本稳定处理结果时传入正整数。

5. 代码发生变化后，先检查状态；需要立即读取远程状态时加 `--refresh`：

   ```bash
   hitmux-context-engine --json status "$PWD" --refresh
   ```

## 输出格式与 JSON

CLI 的自动模式会在非 TTY stdout 输出 JSON，在交互终端输出文本。Skill 和脚本必须显式传 `--json`；需要强制人类可读文本时传 `--text`：

```json
{"ok":true,"command":"search","exitCode":0,"output":"...","data":{"pagination":{"truncated":true,"continuationToken":"..."}}}
```

失败时 `ok` 为 `false`，错误位于 `error`，进程也会返回非零 exit code。脚本应先检查 `ok` 或 exit code。`output` 是可读文本，不能依赖其排版；handler 返回的机器可读内容位于 `data`。搜索存在下一页时读取 `.data.pagination.continuationToken`，并使用同一个 query、path 和 scope 继续查询：

```bash
hitmux-context-engine --json search "handler that validates MCP tool arguments" "$PWD" --scope code --continuation-token "$TOKEN"
```

也可以使用 `--format json|text`，或设置 `HCE_OUTPUT_FORMAT=json|text`。

常用命令：

```bash
hitmux-context-engine status [path] [--refresh] [--details]
hitmux-context-engine search <query> [path] [--limit n] [--scope all|docs|code] [--continuation-token token]
hitmux-context-engine list [collection-name|repo-path]
hitmux-context-engine index [path]
hitmux-context-engine doctor [--no-connectivity]
```

需要提取文本时可使用 `jq -r '.output // .error'`，提取下一页 token 时可使用 `jq -r '.data.pagination.continuationToken // empty'`。索引进度等 stderr 诊断会收集到 `error` 字段，即使命令成功也可能存在；它们不会污染 stdout 的 JSON envelope。`--json` 可以放在 command 前或后。

## 约束

- 不要直接运行不带参数的 `hitmux-context-engine`；它会进入 MCP stdio server 模式并保持进程运行。
- 不要为了普通搜索使用 `clear`、`rm` 或 `index --force`。这些命令会删除数据或重建索引，只有用户明确要求时才执行。
- `hitmux-context-engine init` 会创建全局配置，并安装或更新 collection lease reaper user service；执行前确认这是期望的安装行为。
- `status`、`search` 和 `index` 省略路径时默认当前工作目录；`clear` 和 `repair` 仍要求显式路径。Skill 应优先传入仓库根目录的绝对路径，避免在不同工作目录下命中错误的 collection。
- 退出码 `0` 表示成功，`1` 表示运行或配置失败，`2` 表示参数错误。
