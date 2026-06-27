# Hitmux Context Engine

Langue : [English](README.md) | [中文](README.zh-CN.md) | [Español](README.es.md) | Français | [Deutsch](README.de.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

Recherche sémantique de code pour les clients MCP.

Hitmux Context Engine indexe un dépôt dans un stockage vectoriel compatible avec Milvus, puis fournit à Claude Code, OpenAI Codex CLI, OpenCode, Cursor, Windsurf et aux autres clients MCP des outils ciblés pour trouver du code par comportement, symbol, workflow ou rôle de fichier.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![npm - core](https://img.shields.io/npm/v/@hitmux/hitmux-context-engine-core?label=%40hitmux%2Fhitmux-context-engine-core&logo=npm)](https://www.npmjs.com/package/@hitmux/hitmux-context-engine-core)
[![npm - mcp](https://img.shields.io/npm/v/@hitmux/hitmux-context-engine-mcp?label=%40hitmux%2Fhitmux-context-engine-mcp&logo=npm)](https://www.npmjs.com/package/@hitmux/hitmux-context-engine-mcp)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Utilisez-le quand un AI coding agent a besoin de plus qu'un text grep :

- Rechercher du code indexé avec des requêtes en langage naturel ou riches en identifiers.
- Donner la priorité aux fichiers d'implémentation tout en affichant les tests, docs, config et exports liés quand c'est utile.
- Garder la configuration du projet dans de simples fichiers `config.conf`, sans configuration d'environnement répétée par client.

Parcours typique de première utilisation :

```text
hce index .
Check the indexing status
Find the handler that validates MCP tool arguments
```

## Quick Start

Créez ou complétez la configuration runtime :

```bash
npm install -g @hitmux/hce@latest
hce init
```

Modifiez ensuite `~/.hitmux-context-engine/config.conf` et ajoutez la provider key. Vérifiez la configuration locale et la connectivité :

```bash
hce doctor
```

Pour Claude Code, ajoutez le MCP server :

```bash
claude mcp add hitmux-context-engine -- hce
```

Pour OpenAI Codex CLI, ajoutez le MCP server :

```bash
codex mcp add hitmux-context-engine -- hce
```

L'alias complet `@hitmux/hitmux-context-engine` et le package MCP original `@hitmux/hitmux-context-engine-mcp` démarrent le même server.

Note base de données : utilisez Local Milvus avec `milvusAddress = localhost:19530`. Pour un Milvus distant self-hosted, remplacez-le par le host et le port accessibles, et ajoutez `milvusToken` seulement si l'authentification est requise. Pour une base de données gratuite Zilliz Cloud, inscrivez-vous sur https://cloud.zilliz.com/signup, utilisez le cloud public endpoint et ajoutez votre Personal Key dans `milvusToken`. Les autres database backends ne sont pas sélectionnables depuis `config.conf`.

Pour un nouveau dépôt, créez le premier index depuis la racine du dépôt avant de vous appuyer sur MCP search :

```bash
hce index .
```

Ouvrez ensuite votre MCP client dans le dépôt et demandez :

```text
Check the indexing status
Find functions that handle user authentication
```

Vous pouvez aussi vérifier l'état depuis un shell :

```bash
hce status .
```

## CLI Usage

`hce` sans arguments démarre le MCP stdio server pour les clients. Ajoutez des arguments pour l'utiliser directement depuis un shell :

| Tâche | Commande |
| --- | --- |
| Afficher l'aide ou la version | `hce --help`, `hce --version` |
| Créer ou compléter la configuration globale | `hce init` |
| Afficher les chemins de configuration globale et projet | `hce config path` |
| Vérifier configuration et connectivité | `hce doctor`, `hce doctor --no-connectivity` |
| Indexer le dépôt courant | `hce index .` |
| Afficher l'index status | `hce status .`, `hce status . --refresh` |
| Rechercher dans un dépôt indexé | `hce search "query" . --limit 5 --target-role implementation` |
| Gérer indexes et collections | `hce list`, `hce list <name-or-path>`, `hce clear <path>`, `hce repair <path>`, `hce rm <name-or-path>`, `hce index --force <path>` |

D'autres exemples de clients, notamment Cursor, Windsurf, Claude Desktop, Gemini CLI, Qwen Code, VS Code MCP, Cline et Roo Code, sont disponibles dans [docs/quick-start.fr.md](docs/quick-start.fr.md).

Pour un checkout local du code source, exécutez `./scripts/install-local-global.sh` afin de construire le workspace et d'installer une commande utilisateur `hitmux-context-engine-mcp` depuis le checkout courant. Exécutez le script avec `sudo` pour installer la commande globalement. La configuration Claude Code et Codex CLI avec package publié utilise la commande globale `hce` montrée plus haut.

## Configuration

Hitmux Context Engine lit la configuration produit depuis des fichiers conf :

1. `~/.hitmux-context-engine/config.conf`
2. `./.hitmux-context-engine/config.conf`
3. built-in defaults

La configuration projet remplace la configuration globale pour les champs présents. Les variables d'environnement et `~/.hitmux-context-engine/.env` ne sont pas utilisées pour les options produit MCP.

Voir [docs/configuration.fr.md](docs/configuration.fr.md) pour les options provider, Milvus/Zilliz, indexing, sync et file filtering.

## Packages

- `@hitmux/hitmux-context-engine-mcp` : MCP stdio server pour Claude Code et les autres clients MCP.
- `@hitmux/hce` et `@hitmux/hitmux-context-engine` : npm package aliases du MCP server.
- `@hitmux/hitmux-context-engine-core` : package TypeScript d'indexing, splitting, embedding, synchronization et vector database.

Voir [docs/package-reference.fr.md](docs/package-reference.fr.md) pour les tools, l'utilisation des packages et les exemples de core API.

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

Utilisez Node `>=20` et pnpm `>=10`.

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm --filter @hitmux/hitmux-context-engine-core test
pnpm --filter @hitmux/hitmux-context-engine-mcp test
```

Commandes propres aux packages :

```bash
pnpm build:core
pnpm build:mcp
pnpm build:examples
pnpm dev
pnpm example:basic
```

Avant d'ouvrir une PR, décrivez le package modifié, le comportement, les commandes de validation et les notes de configuration ou de migration.

## Documentation

- [docs/configuration.fr.md](docs/configuration.fr.md) : référence canonique de configuration conf.
- [docs/quick-start.fr.md](docs/quick-start.fr.md) : setup de MCP client.
- [docs/troubleshooting.fr.md](docs/troubleshooting.fr.md) : problèmes courants de setup et runtime.
- [docs/package-reference.fr.md](docs/package-reference.fr.md) : MCP tools et utilisation du core package.

## License

MIT. Voir [LICENSE](LICENSE).

## Acknowledgements

Ce projet est basé sur le core de [zilliztech/claude-context](https://github.com/zilliztech/claude-context). Merci à la [Linux Do community](https://linux.do) pour son soutien.

## Captures d'écran

![Capture Hitmux Context Engine 1](img/English_1.jpg)

![Capture Hitmux Context Engine 2](img/English_2.jpg)

![Capture Hitmux Context Engine 3](img/English_3.jpg)
