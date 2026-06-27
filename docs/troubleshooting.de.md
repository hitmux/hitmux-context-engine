# Troubleshooting

Sprache: [English](troubleshooting.md) | [中文](troubleshooting.zh-CN.md) | [Español](troubleshooting.es.md) | [Français](troubleshooting.fr.md) | Deutsch | [日本語](troubleshooting.ja.md) | [한국어](troubleshooting.ko.md)

## Check Indexing Status First

Den MCP client ausführen lassen:

```text
Check the indexing status
```

Das ruft `get_indexing_status` auf und zeigt meist indexing progress, completed state oder den neuesten indexing error.

## Check Configuration

Hitmux Context Engine liest Konfiguration aus `~/.hitmux-context-engine/config.conf`, `./.hitmux-context-engine/config.conf` und built-in defaults. Umgebungsvariablen und `~/.hitmux-context-engine/.env` werden nicht für MCP options verwendet.

Häufige Checks:

- Der aktive `embeddingProvider` hat den passenden API key: `openrouterApiKey`, `openaiApiKey`, `voyageaiApiKey` oder `geminiApiKey`.
- Local Milvus nutzt `milvusAddress = localhost:19530`.
- Remote Milvus nutzt erreichbaren host und port; `milvusToken` nur bei erforderlicher auth.
- Zilliz Cloud wird über https://cloud.zilliz.com/signup erstellt und nutzt public endpoint als `milvusAddress` sowie Personal Key in `milvusToken`.
- SQLite, Chroma, Qdrant, LanceDB und andere backends sind nicht über `config.conf` auswählbar.
- Projektlokales `.hitmux-context-engine/config.conf` überschreibt kein globales Secret mit leerem Wert.

## System Proxy

Standardmäßig werden `http_proxy`, `https_proxy`, `all_proxy`, `grpc_proxy` und `no_proxy` nicht geerbt.

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = false
```

`embeddingUseSystemProxy` betrifft OpenAI, OpenRouter, VoyageAI, Gemini und Ollama. `databaseUseSystemProxy` betrifft Milvus/Zilliz-Verbindungen. Local Milvus und local Ollama sollten normalerweise `false` bleiben.

Proxy-Variablen prüfen:

```bash
env | grep -i proxy
```

Wenn Local Milvus `14 UNAVAILABLE: No connection established` meldet, zuerst `databaseUseSystemProxy = false` bestätigen und danach MCP server neu verbinden oder neu starten.

## Reconnect After Config Changes

Nach Änderungen an `config.conf` den MCP server neu verbinden oder neu starten.

Claude Code:

```text
/mcp reconnect hitmux-context-engine
```

Gemini CLI:

```text
/mcp refresh
```

GUI-Clients bieten meist restart-, reconnect- oder enable/disable-Kontrollen in MCP settings.

## Get Logs

Claude Code und Gemini CLI:

```bash
claude --debug
gemini --debug
```

Cursor, Windsurf, Cline und Roo Code zeigen MCP logs meist in einem Output panel.

Bei einem Issue bitte MCP client und Version, server config, redigiertes `config.conf`, `get_indexing_status` output und relevante debug logs angeben.

## Windows: `spawn C:\Windows\system32\cmd.exe ENOENT`

Dieser Fehler entsteht, bevor Hitmux Context Engine startet. Prüfen:

```powershell
Test-Path "$env:SystemRoot\System32\cmd.exe"
Get-Command node
Get-Command npm
Get-Command hce
```

Wenn `hce` fehlt, `npm install -g @hitmux/hce@latest` ausführen und MCP client neu starten. Wenn der Client den globalen npm shim nicht auflöst, `hce.cmd` verwenden.

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

`get_indexing_status` liest lokale snapshot metadata. Wenn ein completed entry Nullwerte zeigt:

1. Bestätigen, dass derselbe absolute Pfad wie beim ursprünglichen indexing geprüft wird.
2. `clear_index` für diesen Pfad ausführen.
3. `index_codebase` erneut für denselben Pfad ausführen.

## Fully Local Setup

Ein vollständig lokales Setup kann Local Milvus mit Ollama verwenden:

```conf
embeddingProvider = Ollama
embeddingModel = nomic-embed-text
ollamaHost = http://127.0.0.1:11434
milvusAddress = localhost:19530
```
