# Hitmux Context Engine

Language: [English](README.md) | [中文](README.zh-CN.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [日本語](README.ja.md) | 한국어

MCP 클라이언트를 위한 시맨틱 코드 검색.

Hitmux Context Engine은 repository를 Milvus-compatible vector storage에 index한 뒤 Claude Code, OpenAI Codex CLI, OpenCode, Cursor, Windsurf 및 기타 MCP clients가 behavior, symbol, workflow, file role 기준으로 코드를 찾을 수 있는 focused tools를 제공합니다.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![npm - core](https://img.shields.io/npm/v/@hitmux/hitmux-context-engine-core?label=%40hitmux%2Fhitmux-context-engine-core&logo=npm)](https://www.npmjs.com/package/@hitmux/hitmux-context-engine-core)
[![npm - mcp](https://img.shields.io/npm/v/@hitmux/hitmux-context-engine-mcp?label=%40hitmux%2Fhitmux-context-engine-mcp&logo=npm)](https://www.npmjs.com/package/@hitmux/hitmux-context-engine-mcp)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

AI coding agent가 text grep보다 더 나은 검색이 필요할 때 사용합니다.

- 자연어 또는 identifiers가 포함된 query로 index된 코드를 검색합니다.
- 구현 파일을 우선하되, 필요한 경우 관련 tests, docs, config, exports도 함께 보여줍니다.
- 클라이언트별 환경 변수 설정 대신 간단한 `config.conf` 파일에 project configuration을 둡니다.

일반적인 첫 사용 흐름:

```text
hce index .
Check the indexing status
Find the handler that validates MCP tool arguments
```

## Quick Start

runtime config를 만들거나 보완합니다.

```bash
npm install -g @hitmux/hce@latest
hce init
```

그다음 `~/.hitmux-context-engine/config.conf`를 편집해 provider key를 입력합니다. 로컬 설정과 연결 상태를 확인합니다.

```bash
hce doctor
```

Claude Code에 MCP server를 추가합니다.

```bash
claude mcp add hitmux-context-engine -- hce
```

OpenAI Codex CLI에 MCP server를 추가합니다.

```bash
codex mcp add hitmux-context-engine -- hce
```

전체 package alias `@hitmux/hitmux-context-engine`와 원래 MCP package `@hitmux/hitmux-context-engine-mcp`는 같은 server를 시작합니다.

데이터베이스 참고: Local Milvus는 `milvusAddress = localhost:19530`을 사용합니다. self-hosted remote Milvus는 접근 가능한 host와 port로 바꾸고, 인증이 필요한 경우에만 `milvusToken`을 추가합니다. 무료 Zilliz Cloud database는 https://cloud.zilliz.com/signup 에서 가입한 뒤 cloud public endpoint를 사용하고 Personal Key를 `milvusToken`에 추가합니다. `config.conf`에서는 다른 database backends를 선택할 수 없습니다.

새 repository에서는 MCP search를 사용하기 전에 repository root에서 첫 index를 생성합니다.

```bash
hce index .
```

그다음 repository에서 MCP client를 열고 질문합니다.

```text
Check the indexing status
Find functions that handle user authentication
```

shell에서도 상태를 확인할 수 있습니다.

```bash
hce status .
```

Cursor, Windsurf, Claude Desktop, Gemini CLI, Qwen Code, VS Code MCP, Cline, Roo Code를 포함한 더 많은 client examples는 [docs/quick-start.ko.md](docs/quick-start.ko.md)에 있습니다.

로컬 source checkout에서는 `./scripts/install-local-global.sh`를 실행하면 workspace를 build하고 현재 checkout에서 user-level `hitmux-context-engine-mcp` 명령을 설치합니다. `sudo`로 실행하면 전역으로 설치합니다. Published package를 쓰는 Claude Code와 Codex CLI setup은 위의 global `hce` 명령을 사용합니다.

## Configuration

Hitmux Context Engine은 conf 파일에서 product configuration을 읽습니다.

1. `~/.hitmux-context-engine/config.conf`
2. `./.hitmux-context-engine/config.conf`
3. built-in defaults

Project config는 존재하는 field에 대해 global config를 override합니다. 환경 변수와 `~/.hitmux-context-engine/.env`는 MCP product options에 사용되지 않습니다.

provider, Milvus/Zilliz, indexing, sync, file filtering options는 [docs/configuration.ko.md](docs/configuration.ko.md)를 참고하세요.

## Packages

- `@hitmux/hitmux-context-engine-mcp`: Claude Code 및 기타 MCP clients용 MCP stdio server.
- `@hitmux/hce`와 `@hitmux/hitmux-context-engine`: MCP server의 npm package aliases.
- `@hitmux/hitmux-context-engine-core`: indexing, splitting, embedding, synchronization, vector database용 TypeScript package.

tools, package usage, core API examples는 [docs/package-reference.ko.md](docs/package-reference.ko.md)를 참고하세요.

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

Node `>=20`와 pnpm `>=10`을 사용합니다.

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

PR을 열기 전에 변경한 package, behavior, validation commands, configuration 또는 migration notes를 설명하세요.

## Documentation

- [docs/configuration.ko.md](docs/configuration.ko.md): canonical conf configuration reference.
- [docs/quick-start.ko.md](docs/quick-start.ko.md): MCP client setup.
- [docs/troubleshooting.ko.md](docs/troubleshooting.ko.md): 일반적인 setup 및 runtime problems.
- [docs/package-reference.ko.md](docs/package-reference.ko.md): MCP tools 및 core package usage.

## License

MIT. [LICENSE](LICENSE)를 참고하세요.

## Acknowledgements

이 프로젝트는 [zilliztech/claude-context](https://github.com/zilliztech/claude-context)의 core를 기반으로 합니다. 지원해 준 [Linux Do community](https://linux.do)에 감사드립니다.

## 스크린샷

![Hitmux Context Engine 스크린샷 1](img/English_1.jpg)

![Hitmux Context Engine 스크린샷 2](img/English_2.jpg)

![Hitmux Context Engine 스크린샷 3](img/English_3.jpg)
