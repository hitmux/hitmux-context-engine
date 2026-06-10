# Quick Start

This page shows MCP client setup. Put product options in `config.jsonc`; MCP client config only needs to start the server.

## Claude Code

Create `~/.hitmux-context-engine/config.jsonc`:

```jsonc
{
    "embeddingProvider": "OpenRouter",
    "embeddingModel": "qwen/qwen3-embedding-4b",
    "openrouterApiKey": "sk-or-your-openrouter-api-key",
    "milvusAddress": "localhost:19530"
}
```

Add the server:

```bash
claude mcp add hitmux-context-engine -- npx @hitmux/hitmux-context-engine-mcp@latest
```

Database note: Use Local Milvus with `"milvusAddress": "localhost:19530"`. For self-hosted remote Milvus, replace it with the reachable host and port, and add `"milvusToken"` only if authentication is required. For Zilliz Cloud, use the cloud public endpoint and add `"milvusToken"` with your Personal Key. Other database backends are not selectable from `config.jsonc`.

## OpenAI Codex CLI

Add the server:

```bash
codex mcp add hitmux-context-engine -- npx @hitmux/hitmux-context-engine-mcp@latest
```

Or add this to `~/.codex/config.toml`:

```toml
[mcp_servers.hitmux-context-engine]
command = "npx"
args = ["@hitmux/hitmux-context-engine-mcp@latest"]
startup_timeout_ms = 20000
```

Use the database settings in `~/.hitmux-context-engine/config.jsonc`.

## Local Source Install

Use `./scripts/install-local-global.sh` when you want MCP clients to run the package from this checkout instead of the published npm package. The script checks Node.js and pnpm versions, installs workspace dependencies with the lockfile, builds `@hitmux/hitmux-context-engine-mcp`, and installs a `hitmux-context-engine-mcp` wrapper that points at the built local `packages/mcp/dist/index.js`.

```bash
./scripts/install-local-global.sh
```

By default, the command is installed for the current user as `$HOME/.local/bin/hitmux-context-engine-mcp`. Run the script with `sudo` to install it globally as `/usr/local/bin/hitmux-context-engine-mcp`. Override the target with `BIN_DIR` or the command name with `COMMAND_NAME`:

```bash
sudo ./scripts/install-local-global.sh
COMMAND_NAME=hce-mcp ./scripts/install-local-global.sh
BIN_DIR="$HOME/bin" ./scripts/install-local-global.sh
```

If the install directory is not on `PATH`, add it to `PATH` or use the installed command's full path in the MCP client command.

After installation, add the local command to MCP clients:

```bash
claude mcp add hitmux-context-engine -- hitmux-context-engine-mcp
codex mcp add hitmux-context-engine -- hitmux-context-engine-mcp
```

## JSON MCP Clients

For clients that use an `mcpServers` JSON object:

```json
{
  "mcpServers": {
    "hitmux-context-engine": {
      "command": "npx",
      "args": ["@hitmux/hitmux-context-engine-mcp@latest"]
    }
  }
}
```

Use `npx.cmd` on Windows clients that cannot resolve the npm shim:

```json
{
  "mcpServers": {
    "hitmux-context-engine": {
      "command": "npx.cmd",
      "args": ["-y", "@hitmux/hitmux-context-engine-mcp@latest"]
    }
  }
}
```

Use the database settings in `~/.hitmux-context-engine/config.jsonc`.

This shape applies to Gemini CLI, Qwen Code, Cursor, Claude Desktop, Windsurf, VS Code MCP extensions, Cline, Roo Code, and similar MCP-compatible clients.

## Other Stdio Clients

Any stdio MCP client can start the server with:

```bash
npx @hitmux/hitmux-context-engine-mcp@latest
```

Use the database settings in `~/.hitmux-context-engine/config.jsonc`.

## Use In A Repository

Open your MCP client in a repository and ask:

```text
Index this codebase
Check the indexing status
Find functions that handle user authentication
```

If you change `config.jsonc`, reconnect the MCP server before testing again.
