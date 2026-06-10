# Repository Guidelines

## Project Structure & Module Organization

This pnpm workspace keeps main TypeScript packages under `packages/*`:

- `packages/core`: indexing, embedding, splitting, sync, and vector database.
- `packages/mcp`: MCP server integration and request handlers.

Examples are in `examples/*`; docs in `docs/`; evaluation tooling in `evaluation/`; Python helpers in `python/`; shared scripts in `scripts/`. Generated output belongs in package `dist/` directories.

## Build, Test, and Development Commands

Use Node `>=20` and pnpm `>=10`.

- `pnpm install`: install dependencies from `pnpm-lock.yaml`.
- `pnpm build`: build all packages, then examples.
- `pnpm build:core`, `pnpm build:mcp`: build one target.
- `pnpm dev`: run package development watchers.
- `pnpm lint`: run ESLint across workspace packages.
- `pnpm lint:fix`: apply ESLint fixes.
- `pnpm typecheck`: run TypeScript checks without emit.
- `pnpm --filter @hitmux/hitmux-context-engine-core test`: run Jest tests.
- `pnpm --filter @hitmux/hitmux-context-engine-mcp test`: run Node tests.
- `pnpm example:basic`: start the example.

## Coding Style & Naming Conventions

Use TypeScript with `strict` mode and existing 4-space indentation. Prefer named exports for reusable APIs. Use `camelCase` for variables and functions, `PascalCase` for classes and types, and `UPPER_SNAKE_CASE` only for true constants.

ESLint uses `eslint:recommended` plus `@typescript-eslint/recommended`. Unused variables are errors unless intentionally prefixed with `_`; `any` is allowed only with a warning, so prefer explicit types where practical.

## Testing Guidelines

Place tests next to covered code using `*.test.ts`. Core tests use Jest and `ts-jest`; MCP tests use `node --import tsx --test`. Add or update tests for indexing behavior, request handling, embedding providers, splitters, or error paths. Before a PR, run the relevant test command plus `pnpm typecheck`.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit style, for example `chore: release 0.1.14`. Prefer subjects such as `fix: handle aborted indexing` or `feat: add MCP status snapshot`.

Pull requests should describe the changed package, behavior, validation commands, and configuration or migration notes. Link related issues and call out unverified areas.

## Security & Configuration Tips

Do not commit API keys, Milvus tokens, or provider credentials. Pass local values through environment variables such as `OPENAI_API_KEY` and `MILVUS_ADDRESS`, or through extension settings. Keep generated artifacts and dependency caches out of source control.
