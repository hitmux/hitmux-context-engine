# Quick Start

Language: [English](quick-start.md) | 中文 | [Español](quick-start.es.md) | [Français](quick-start.fr.md) | [Deutsch](quick-start.de.md) | [日本語](quick-start.ja.md) | [한국어](quick-start.ko.md)

本页说明如何从 MCP clients 启动 Hitmux Context Engine。产品配置位于 `~/.hitmux-context-engine/config.conf`，或项目内的 `.hitmux-context-engine/config.conf`。MCP client 配置只负责启动 stdio server。

## Product Config

全局安装短 CLI，并创建或补全运行时配置：

```bash
npm install -g @hitmux/hce@latest
hce init
```

然后编辑 `~/.hitmux-context-engine/config.conf`，填入 provider key，并运行 `hce doctor` 检查配置解析以及 embedding/vector database 连通性。只做本地检查时使用 `hce doctor --no-connectivity`。

数据库说明：Local Milvus 使用 `milvusAddress = localhost:19530`。self-hosted remote Milvus 使用可访问的 host 和 port；只有服务端要求认证时才设置 `milvusToken`。免费 Zilliz Cloud 数据库可在 https://cloud.zilliz.com/signup 注册，然后把 cloud public endpoint 用作 `milvusAddress`，并把 Personal Key 写入 `milvusToken`。`config.conf` 不能切换到 SQLite、Chroma、Qdrant、LanceDB 或其他数据库 backend。

Hitmux Context Engine 默认不继承系统代理环境变量。只有 embedding provider 或 vector database 必须走代理时，才配置 `embeddingUseSystemProxy` 和 `databaseUseSystemProxy`；见 [Configuration](configuration.zh-CN.md#system-proxy)。

`@hitmux/hce`、`@hitmux/hitmux-context-engine` 和 `@hitmux/hitmux-context-engine-mcp` 都启动同一个 MCP server。不带参数的 `hce` 是客户端使用的 MCP stdio server mode：

```bash
hce
```

索引后如需在 shell 中诊断，可在仓库根目录运行 `hce status .`。

## Claude Code

全局安装并添加 server：

```bash
npm install -g @hitmux/hce@latest
claude mcp add hitmux-context-engine -- hce
```

编辑 `config.conf` 后，重新连接 server：

```text
/mcp reconnect hitmux-context-engine
```

## OpenAI Codex CLI

全局安装并添加 server：

```bash
npm install -g @hitmux/hce@latest
codex mcp add hitmux-context-engine -- hce
```

也可以直接编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.hitmux-context-engine]
command = "hce"
args = []
startup_timeout_sec = 20
```

## OpenCode

OpenCode config 在 `opencode.json` 或 `opencode.jsonc` 中使用 `mcp` object。全局设置编辑 `~/.config/opencode/opencode.json`。项目级设置在项目根目录添加 `opencode.json`。

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "hitmux-context-engine": {
      "type": "local",
      "command": ["hce"],
      "enabled": true
    }
  }
}
```

OpenCode 会合并全局和项目配置。如果同名 MCP server 出现在多个配置文件中，优先级更高的配置值生效。

## CC Switch

CC Switch 从 MCP panel 管理 MCP servers，并同步到 Claude Code、Codex、Gemini CLI、OpenCode 和 Hermes 等支持的 app。

把 Hitmux Context Engine 添加为 custom local stdio server：

| Field | Value |
| --- | --- |
| Server ID | `hitmux-context-engine` |
| Name | `Hitmux Context Engine` |
| Transport Type | `stdio` |
| Command | `hce` |
| Arguments | |

为需要由 CC Switch 管理的客户端启用 app toggles。CC Switch 会在同步时写入对应 client config；修改 MCP settings 后重启目标 CLI。

## Cursor, Windsurf, Claude Desktop, Gemini CLI, Qwen Code, Cline, Roo Code

这些 clients 通常使用 `mcpServers` JSON config。不同 client 的 settings 入口名称不同，但 server snippet 相同。

标准配置：

```json
{
  "mcpServers": {
    "hitmux-context-engine": {
      "command": "hce",
      "args": []
    }
  }
}
```

Windows 上如果 client 找不到全局 npm shim，把 `command` 改成 `hce.cmd`：

```json
{
  "mcpServers": {
    "hitmux-context-engine": {
      "command": "hce.cmd",
      "args": []
    }
  }
}
```

常见 settings 位置：

| Client | Configuration location |
| --- | --- |
| Cursor | Settings 中的 MCP settings，或 project / user-level MCP JSON |
| Windsurf | Cascade / MCP Servers settings |
| Claude Desktop | `claude_desktop_config.json` |
| Gemini CLI | Gemini CLI settings JSON |
| Qwen Code | Qwen Code settings JSON |
| Cline | VS Code extension 中的 MCP Servers settings |
| Roo Code | VS Code extension 中的 MCP Servers settings |

## VS Code MCP

VS Code native MCP config 通常使用 `servers` structure。下面是 user-level 或 workspace-level `.vscode/mcp.json` 示例：

```json
{
  "servers": {
    "hitmux-context-engine": {
      "type": "stdio",
      "command": "hce",
      "args": []
    }
  }
}
```

## Local Source Install

如果希望 MCP client 运行当前 checkout，而不是 npm registry 中发布的 package，使用：

```bash
./scripts/install-local-global.sh
```

该脚本会检查 Node.js 和 pnpm 版本，按 lockfile 安装 workspace dependencies，构建 `@hitmux/hitmux-context-engine-mcp`，并安装指向本地 `packages/mcp/dist/index.js` 的 `hitmux-context-engine-mcp` wrapper。

默认会为当前用户安装到 `$HOME/.local/bin/hitmux-context-engine-mcp`。使用 `sudo` 运行会安装到 `/usr/local/bin/hitmux-context-engine-mcp`。也可以修改 command name 或 install directory：

```bash
sudo ./scripts/install-local-global.sh
COMMAND_NAME=hce-mcp ./scripts/install-local-global.sh
BIN_DIR="$HOME/bin" ./scripts/install-local-global.sh
```

如果 install directory 不在 `PATH` 中，把它加入 `PATH`，或在 MCP client 的 `command` 中使用 wrapper 的绝对路径。

Local wrapper examples:

```bash
hitmux-context-engine-mcp
```

JSON clients:

```json
{
  "mcpServers": {
    "hitmux-context-engine": {
      "command": "hitmux-context-engine-mcp",
      "args": []
    }
  }
}
```

OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "hitmux-context-engine": {
      "type": "local",
      "command": ["hitmux-context-engine-mcp"],
      "enabled": true
    }
  }
}
```

CC Switch:

| Field | Value |
| --- | --- |
| Server ID | `hitmux-context-engine` |
| Name | `Hitmux Context Engine` |
| Transport Type | `stdio` |
| Command | `hitmux-context-engine-mcp` |
| Arguments | |

## Use In A Repository

新仓库先在仓库根目录创建首次索引：

```bash
hce index .
```

然后在仓库中打开 MCP client 并提问：

```text
Check the indexing status
Find functions that handle user authentication
```

编辑 `config.conf` 后，重新连接或重启 MCP server。
