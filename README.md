# Hitmux Context Engine

Hitmux Context Engine is an MCP server and TypeScript indexing engine for semantic code search. It indexes a repository into Milvus-compatible vector storage, including Local Milvus, self-hosted remote Milvus, or Zilliz Cloud, then lets Claude Code and other MCP clients search code with natural language queries.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![npm - core](https://img.shields.io/npm/v/@hitmux/hitmux-context-engine-core?label=%40hitmux%2Fhitmux-context-engine-core&logo=npm)](https://www.npmjs.com/package/@hitmux/hitmux-context-engine-core)
[![npm - mcp](https://img.shields.io/npm/v/@hitmux/hitmux-context-engine-mcp?label=%40hitmux%2Fhitmux-context-engine-mcp&logo=npm)](https://www.npmjs.com/package/@hitmux/hitmux-context-engine-mcp)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Quick Start

Create the runtime config:

```bash
mkdir -p ~/.hitmux-context-engine
cat > ~/.hitmux-context-engine/config.jsonc << 'EOF'
{
    "embeddingProvider": "OpenRouter",
    "embeddingModel": "qwen/qwen3-embedding-4b",
    "openrouterApiKey": "sk-or-your-openrouter-api-key",
    "milvusAddress": "localhost:19530"
}
EOF
```

Add the MCP server to Claude Code:

```bash
claude mcp add hitmux-context-engine -- npx @hitmux/hitmux-context-engine-mcp@latest
```

Or add it to OpenAI Codex CLI:

```bash
codex mcp add hitmux-context-engine -- npx @hitmux/hitmux-context-engine-mcp@latest
```

Database note: Use Local Milvus with `"milvusAddress": "localhost:19530"`. For self-hosted remote Milvus, replace it with the reachable host and port, and add `"milvusToken"` only if authentication is required. For Zilliz Cloud, use the cloud public endpoint and add `"milvusToken"` with your Personal Key. Other database backends are not selectable from `config.jsonc`.

Then open your MCP client in a repository and ask:

```text
Index this codebase
Check the indexing status
Find functions that handle user authentication
```

More client examples are in [docs/quick-start.md](docs/quick-start.md).

For a local source checkout, run `./scripts/install-local-global.sh` to build the workspace and install a user-level `hitmux-context-engine-mcp` command from the current checkout. Run the script with `sudo` to install the command globally. Then use that command in MCP clients, for example `claude mcp add hitmux-context-engine -- hitmux-context-engine-mcp` or `codex mcp add hitmux-context-engine -- hitmux-context-engine-mcp`.

## Configuration

Hitmux Context Engine reads product configuration from JSONC files:

1. `~/.hitmux-context-engine/config.jsonc`
2. `./.hitmux-context-engine/config.jsonc`
3. built-in defaults

Project config overrides global config for fields that are present. Environment variables and `~/.hitmux-context-engine/.env` are not used for MCP product options.

See [docs/configuration.md](docs/configuration.md) for provider, Milvus/Zilliz, indexing, sync, and file filtering options.

## Packages

- `@hitmux/hitmux-context-engine-mcp`: MCP stdio server for Claude Code and other MCP clients.
- `@hitmux/hitmux-context-engine-core`: TypeScript indexing, splitting, embedding, synchronization, and vector database package.

See [docs/package-reference.md](docs/package-reference.md) for tools, package usage, and core API examples.

## Repository Layout

```text
packages/core     Core indexing engine
packages/mcp      MCP server
docs              Flat documentation
examples          Local usage examples
evaluation        Evaluation scripts and raw case-study data
python            Python bridge helpers
```

## Development

Use Node `>=20` and pnpm `>=10`.

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm --filter @hitmux/hitmux-context-engine-core test
pnpm --filter @hitmux/hitmux-context-engine-mcp test
```

Package-specific commands:

```bash
pnpm build:core
pnpm build:mcp
pnpm build:examples
pnpm dev
pnpm example:basic
```

Before opening a PR, describe the changed package, behavior, validation commands, and any configuration or migration notes.

## Documentation

- [docs/quick-start.md](docs/quick-start.md): MCP client setup.
- [docs/configuration.md](docs/configuration.md): canonical JSONC configuration reference.
- [docs/troubleshooting.md](docs/troubleshooting.md): common setup and runtime problems.
- [docs/package-reference.md](docs/package-reference.md): MCP tools and core package usage.

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgements

This project is based on the core of [zilliztech/claude-context](https://github.com/zilliztech/claude-context). Thanks to the [Linux Do community](https://linux.do) for its support.
