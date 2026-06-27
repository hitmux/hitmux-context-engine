# Troubleshooting

Langue : [English](troubleshooting.md) | [中文](troubleshooting.zh-CN.md) | [Español](troubleshooting.es.md) | Français | [Deutsch](troubleshooting.de.md) | [日本語](troubleshooting.ja.md) | [한국어](troubleshooting.ko.md)

## Check Indexing Status First

Demandez au MCP client :

```text
Check the indexing status
```

Cela appelle `get_indexing_status` et affiche généralement la progression, l'état completed ou la dernière erreur d'indexing.

## Check Configuration

Hitmux Context Engine lit la configuration depuis `~/.hitmux-context-engine/config.conf`, `./.hitmux-context-engine/config.conf` et built-in defaults. Les variables d'environnement et `~/.hitmux-context-engine/.env` ne sont pas utilisées pour les options MCP.

Checks courants :

- Le `embeddingProvider` actif possède son API key : `openrouterApiKey`, `openaiApiKey`, `voyageaiApiKey` ou `geminiApiKey`.
- Local Milvus utilise `milvusAddress = localhost:19530`.
- Remote Milvus utilise un host et port accessibles ; `milvusToken` seulement si le server demande une auth.
- Zilliz Cloud se crée depuis https://cloud.zilliz.com/signup et utilise le public endpoint comme `milvusAddress`, avec la Personal Key dans `milvusToken`.
- SQLite, Chroma, Qdrant, LanceDB et autres backends ne sont pas sélectionnables via `config.conf`.
- `.hitmux-context-engine/config.conf` du projet ne remplace pas un secret global par une valeur vide.

## System Proxy

Par défaut, `http_proxy`, `https_proxy`, `all_proxy`, `grpc_proxy` et `no_proxy` ne sont pas hérités.

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = false
```

`embeddingUseSystemProxy` affecte OpenAI, OpenRouter, VoyageAI, Gemini et Ollama. `databaseUseSystemProxy` affecte les connexions Milvus/Zilliz. Local Milvus et local Ollama devraient normalement rester à `false`.

Vérifiez les variables proxy :

```bash
env | grep -i proxy
```

Si Local Milvus affiche `14 UNAVAILABLE: No connection established`, confirmez d'abord `databaseUseSystemProxy = false`, puis reconnectez ou redémarrez le MCP server.

## Reconnect After Config Changes

Après modification de `config.conf`, reconnectez ou redémarrez le MCP server.

Claude Code :

```text
/mcp reconnect hitmux-context-engine
```

Gemini CLI :

```text
/mcp refresh
```

Les clients GUI fournissent souvent des contrôles restart, reconnect ou enable/disable dans MCP settings.

## Get Logs

Claude Code et Gemini CLI :

```bash
claude --debug
gemini --debug
```

Cursor, Windsurf, Cline et Roo Code exposent souvent les logs MCP dans un Output panel.

Pour signaler un issue, incluez le client MCP et sa version, la server config, un `config.conf` expurgé, la sortie `get_indexing_status` et les logs pertinents.

## Windows: `spawn C:\Windows\system32\cmd.exe ENOENT`

Cette erreur survient avant le démarrage de Hitmux Context Engine. Vérifiez :

```powershell
Test-Path "$env:SystemRoot\System32\cmd.exe"
Get-Command node
Get-Command npm
Get-Command hce
```

Si `hce` manque, exécutez `npm install -g @hitmux/hce@latest` et redémarrez le MCP client. Si le client ne résout pas le npm shim global, utilisez `hce.cmd`.

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

## Completed Status Shows `0 files, 0 chunks`

`get_indexing_status` lit les snapshot metadata locales. Si un état completed montre des zéros :

1. Confirmez que vous vérifiez le même chemin absolu que lors de l'indexing initial.
2. Exécutez `clear_index` pour ce chemin.
3. Exécutez de nouveau `index_codebase` pour le même chemin.

## Fully Local Setup

Un setup entièrement local peut utiliser Local Milvus avec Ollama :

```conf
embeddingProvider = Ollama
embeddingModel = nomic-embed-text
ollamaHost = http://127.0.0.1:11434
milvusAddress = localhost:19530
```
