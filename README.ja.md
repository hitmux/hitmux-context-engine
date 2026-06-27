# Hitmux Context Engine

Language: [English](README.md) | [中文](README.zh-CN.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | 日本語 | [한국어](README.ko.md)

MCP クライアント向けのセマンティックコード検索。

Hitmux Context Engine はリポジトリを Milvus 互換のベクトルストレージに index し、Claude Code、OpenAI Codex CLI、OpenCode、Cursor、Windsurf などの MCP クライアントに、挙動、symbol、workflow、ファイルの役割からコードを探すための focused tools を提供します。

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![npm - core](https://img.shields.io/npm/v/@hitmux/hitmux-context-engine-core?label=%40hitmux%2Fhitmux-context-engine-core&logo=npm)](https://www.npmjs.com/package/@hitmux/hitmux-context-engine-core)
[![npm - mcp](https://img.shields.io/npm/v/@hitmux/hitmux-context-engine-mcp?label=%40hitmux%2Fhitmux-context-engine-mcp&logo=npm)](https://www.npmjs.com/package/@hitmux/hitmux-context-engine-mcp)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

AI coding agent が text grep 以上の検索を必要とするときに使います。

- 自然言語または identifiers を含むクエリで index 済みコードを検索する。
- 実装ファイルを優先しつつ、必要に応じて関連する tests、docs、config、exports も表示する。
- クライアントごとの環境変数設定ではなく、シンプルな `config.conf` でプロジェクト設定を管理する。

初回利用の典型的な流れ:

```text
hce index .
Check the indexing status
Find the handler that validates MCP tool arguments
```

## Quick Start

runtime config を作成または補完します。

```bash
npm install -g @hitmux/hce@latest
hce init
```

次に `~/.hitmux-context-engine/config.conf` を編集し、provider key を設定します。ローカル設定と接続を確認します。

```bash
hce doctor
```

Claude Code に MCP server を追加します。

```bash
claude mcp add hitmux-context-engine -- hce
```

OpenAI Codex CLI に MCP server を追加します。

```bash
codex mcp add hitmux-context-engine -- hce
```

完全な package alias `@hitmux/hitmux-context-engine` と元の MCP package `@hitmux/hitmux-context-engine-mcp` は同じ server を起動します。

データベースについて: Local Milvus では `milvusAddress = localhost:19530` を使います。self-hosted remote Milvus では到達可能な host と port に置き換え、認証が必要な場合だけ `milvusToken` を追加します。無料の Zilliz Cloud database は https://cloud.zilliz.com/signup で登録し、cloud public endpoint と Personal Key を `milvusToken` に設定します。`config.conf` から他の database backends は選択できません。

新しいリポジトリでは、MCP search に頼る前にリポジトリ root で最初の index を作成します。

```bash
hce index .
```

その後、リポジトリで MCP client を開いて質問します。

```text
Check the indexing status
Find functions that handle user authentication
```

shell から status を確認することもできます。

```bash
hce status .
```

Cursor、Windsurf、Claude Desktop、Gemini CLI、Qwen Code、VS Code MCP、Cline、Roo Code などの client examples は [docs/quick-start.ja.md](docs/quick-start.ja.md) にあります。

ローカル source checkout では `./scripts/install-local-global.sh` を実行すると、workspace を build し、現在の checkout から user-level の `hitmux-context-engine-mcp` コマンドをインストールします。`sudo` 付きで実行すると global にインストールします。公開 package を使う Claude Code と Codex CLI の setup では、上で示した global `hce` コマンドを使います。

## Configuration

Hitmux Context Engine は conf ファイルから product configuration を読み込みます。

1. `~/.hitmux-context-engine/config.conf`
2. `./.hitmux-context-engine/config.conf`
3. built-in defaults

project config は、存在するフィールドについて global config を上書きします。環境変数と `~/.hitmux-context-engine/.env` は MCP product options には使われません。

provider、Milvus/Zilliz、indexing、sync、file filtering の options は [docs/configuration.ja.md](docs/configuration.ja.md) を参照してください。

## Packages

- `@hitmux/hitmux-context-engine-mcp`: Claude Code とその他 MCP clients 向けの MCP stdio server。
- `@hitmux/hce` と `@hitmux/hitmux-context-engine`: MCP server の npm package aliases。
- `@hitmux/hitmux-context-engine-core`: indexing、splitting、embedding、synchronization、vector database の TypeScript package。

tools、package usage、core API examples は [docs/package-reference.ja.md](docs/package-reference.ja.md) を参照してください。

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

Node `>=20` と pnpm `>=10` を使います。

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

PR を開く前に、変更した package、behavior、validation commands、configuration または migration notes を記載してください。

## Documentation

- [docs/configuration.ja.md](docs/configuration.ja.md): conf configuration reference。
- [docs/quick-start.ja.md](docs/quick-start.ja.md): MCP client setup。
- [docs/troubleshooting.ja.md](docs/troubleshooting.ja.md): よくある setup と runtime problems。
- [docs/package-reference.ja.md](docs/package-reference.ja.md): MCP tools と core package usage。

## License

MIT。詳しくは [LICENSE](LICENSE) を参照してください。

## Acknowledgements

このプロジェクトは [zilliztech/claude-context](https://github.com/zilliztech/claude-context) の core をベースにしています。[Linux Do community](https://linux.do) のサポートに感謝します。

## スクリーンショット

![Hitmux Context Engine スクリーンショット 1](img/English_1.jpg)

![Hitmux Context Engine スクリーンショット 2](img/English_2.jpg)

![Hitmux Context Engine スクリーンショット 3](img/English_3.jpg)
