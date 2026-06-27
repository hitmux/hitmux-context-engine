# Hitmux Context Engine

Idioma: [English](README.md) | [中文](README.zh-CN.md) | Español | [Français](README.fr.md) | [Deutsch](README.de.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

Búsqueda semántica de código para clientes MCP.

Hitmux Context Engine indexa un repositorio en almacenamiento vectorial compatible con Milvus y ofrece a Claude Code, OpenAI Codex CLI, OpenCode, Cursor, Windsurf y otros clientes MCP herramientas enfocadas para encontrar código por comportamiento, symbol, workflow o responsabilidad de archivo.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![npm - core](https://img.shields.io/npm/v/@hitmux/hitmux-context-engine-core?label=%40hitmux%2Fhitmux-context-engine-core&logo=npm)](https://www.npmjs.com/package/@hitmux/hitmux-context-engine-core)
[![npm - mcp](https://img.shields.io/npm/v/@hitmux/hitmux-context-engine-mcp?label=%40hitmux%2Fhitmux-context-engine-mcp&logo=npm)](https://www.npmjs.com/package/@hitmux/hitmux-context-engine-mcp)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Úsalo cuando un AI coding agent necesite más que text grep:

- Buscar código indexado con consultas en lenguaje natural o con identifiers.
- Priorizar archivos de implementación y mostrar tests, docs, config y exports relacionados cuando sean útiles.
- Mantener la configuración del proyecto en archivos simples `config.conf`, sin repetir variables de entorno en cada cliente.

Flujo típico de primer uso:

```text
hce index .
Check the indexing status
Find the handler that validates MCP tool arguments
```

## Quick Start

Crea o completa la configuración de runtime:

```bash
npm install -g @hitmux/hce@latest
hce init
```

Después edita `~/.hitmux-context-engine/config.conf` y añade la provider key. Comprueba la configuración local y la conectividad:

```bash
hce doctor
```

Para Claude Code, añade el MCP server:

```bash
claude mcp add hitmux-context-engine -- hce
```

Para OpenAI Codex CLI, añade el MCP server:

```bash
codex mcp add hitmux-context-engine -- hce
```

El alias completo `@hitmux/hitmux-context-engine` y el package MCP original `@hitmux/hitmux-context-engine-mcp` inician el mismo server.

Nota de base de datos: usa Local Milvus con `milvusAddress = localhost:19530`. Para un Milvus remoto self-hosted, reemplázalo por el host y port accesibles, y añade `milvusToken` solo si se requiere autenticación. Para una base de datos gratuita de Zilliz Cloud, regístrate en https://cloud.zilliz.com/signup, usa el cloud public endpoint y añade tu Personal Key en `milvusToken`. No se pueden elegir otros database backends desde `config.conf`.

Para un repositorio nuevo, crea el primer índice desde la raíz antes de usar MCP search:

```bash
hce index .
```

Después abre tu MCP client en el repositorio y pregunta:

```text
Check the indexing status
Find functions that handle user authentication
```

También puedes consultar el estado desde shell:

```bash
hce status .
```

Más ejemplos de clientes, incluidos Cursor, Windsurf, Claude Desktop, Gemini CLI, Qwen Code, VS Code MCP, Cline y Roo Code, están en [docs/quick-start.es.md](docs/quick-start.es.md).

Para un checkout local del código fuente, ejecuta `./scripts/install-local-global.sh` para construir el workspace e instalar un comando de usuario `hitmux-context-engine-mcp` desde el checkout actual. Ejecuta el script con `sudo` para instalarlo globalmente. La configuración de Claude Code y Codex CLI con package publicado usa el comando global `hce` mostrado arriba.

## Configuration

Hitmux Context Engine lee la configuración del producto desde archivos conf:

1. `~/.hitmux-context-engine/config.conf`
2. `./.hitmux-context-engine/config.conf`
3. built-in defaults

La configuración del proyecto sobrescribe la global para los campos presentes. Las variables de entorno y `~/.hitmux-context-engine/.env` no se usan para opciones del producto MCP.

Consulta [docs/configuration.es.md](docs/configuration.es.md) para opciones de provider, Milvus/Zilliz, indexing, sync y file filtering.

## Packages

- `@hitmux/hitmux-context-engine-mcp`: MCP stdio server para Claude Code y otros clientes MCP.
- `@hitmux/hce` y `@hitmux/hitmux-context-engine`: npm package aliases para el MCP server.
- `@hitmux/hitmux-context-engine-core`: package TypeScript de indexing, splitting, embedding, synchronization y vector database.

Consulta [docs/package-reference.es.md](docs/package-reference.es.md) para tools, uso de packages y ejemplos de core API.

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

Usa Node `>=20` y pnpm `>=10`.

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm --filter @hitmux/hitmux-context-engine-core test
pnpm --filter @hitmux/hitmux-context-engine-mcp test
```

Comandos por package:

```bash
pnpm build:core
pnpm build:mcp
pnpm build:examples
pnpm dev
pnpm example:basic
```

Antes de abrir un PR, describe el package modificado, el comportamiento, los comandos de validación y cualquier nota de configuración o migración.

## Documentation

- [docs/configuration.es.md](docs/configuration.es.md): referencia canónica de configuración conf.
- [docs/quick-start.es.md](docs/quick-start.es.md): setup de MCP client.
- [docs/troubleshooting.es.md](docs/troubleshooting.es.md): problemas comunes de setup y runtime.
- [docs/package-reference.es.md](docs/package-reference.es.md): MCP tools y uso del core package.

## License

MIT. Consulta [LICENSE](LICENSE).

## Acknowledgements

Este proyecto se basa en el core de [zilliztech/claude-context](https://github.com/zilliztech/claude-context). Gracias a la [Linux Do community](https://linux.do) por su apoyo.

## Capturas

![Captura de Hitmux Context Engine 1](img/English_1.jpg)

![Captura de Hitmux Context Engine 2](img/English_2.jpg)

![Captura de Hitmux Context Engine 3](img/English_3.jpg)
