# Troubleshooting

Idioma: [English](troubleshooting.md) | [中文](troubleshooting.zh-CN.md) | Español | [Français](troubleshooting.fr.md) | [Deutsch](troubleshooting.de.md) | [日本語](troubleshooting.ja.md) | [한국어](troubleshooting.ko.md)

## Check Indexing Status First

Pide al MCP client:

```text
Check the indexing status
```

Esto llama a `get_indexing_status` y normalmente muestra progreso, estado completado o el error de indexing más reciente.

## Check Configuration

Hitmux Context Engine lee configuración desde `~/.hitmux-context-engine/config.conf`, `./.hitmux-context-engine/config.conf` y built-in defaults. Las variables de entorno y `~/.hitmux-context-engine/.env` no se usan para opciones MCP.

Checks comunes:

- El `embeddingProvider` activo tiene su API key: `openrouterApiKey`, `openaiApiKey`, `voyageaiApiKey` o `geminiApiKey`.
- Local Milvus usa `milvusAddress = localhost:19530`.
- Remote Milvus usa host y port alcanzables; `milvusToken` solo si el server requiere auth.
- Zilliz Cloud se crea desde https://cloud.zilliz.com/signup y usa public endpoint como `milvusAddress` con Personal Key en `milvusToken`.
- SQLite, Chroma, Qdrant, LanceDB y otros backends no se seleccionan desde `config.conf`.
- `.hitmux-context-engine/config.conf` del proyecto no está sobrescribiendo un secreto global con valor vacío.

## System Proxy

Por defecto no se heredan `http_proxy`, `https_proxy`, `all_proxy`, `grpc_proxy` ni `no_proxy`.

```conf
embeddingUseSystemProxy = false
databaseUseSystemProxy = false
```

`embeddingUseSystemProxy` afecta OpenAI, OpenRouter, VoyageAI, Gemini y Ollama. `databaseUseSystemProxy` afecta conexiones Milvus/Zilliz. Local Milvus y local Ollama normalmente deben quedar en `false`.

Revisa variables proxy:

```bash
env | grep -i proxy
```

Si Local Milvus muestra `14 UNAVAILABLE: No connection established`, confirma primero `databaseUseSystemProxy = false` y luego reconecta o reinicia el MCP server.

## Reconnect After Config Changes

Después de editar `config.conf`, reconecta o reinicia el MCP server.

Claude Code:

```text
/mcp reconnect hitmux-context-engine
```

Gemini CLI:

```text
/mcp refresh
```

Los clientes GUI suelen tener controles de restart, reconnect o enable/disable en MCP settings.

## Get Logs

Claude Code y Gemini CLI:

```bash
claude --debug
gemini --debug
```

Cursor, Windsurf, Cline y Roo Code suelen mostrar logs MCP en un Output panel.

Al reportar un issue, incluye MCP client y versión, server config, `config.conf` redactado, salida de `get_indexing_status` y logs relevantes.

## Windows: `spawn C:\Windows\system32\cmd.exe ENOENT`

El error aparece antes de que Hitmux Context Engine arranque. Comprueba:

```powershell
Test-Path "$env:SystemRoot\System32\cmd.exe"
Get-Command node
Get-Command npm
Get-Command hce
```

Si falta `hce`, ejecuta `npm install -g @hitmux/hce@latest` y reinicia el MCP client. Si el client no resuelve el npm shim global, usa `hce.cmd`.

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

`get_indexing_status` lee snapshot metadata local. Si un estado completado muestra ceros:

1. Confirma que estás revisando la misma ruta absoluta usada al indexar.
2. Ejecuta `clear_index` para esa ruta.
3. Ejecuta `index_codebase` de nuevo para la misma ruta.

## Fully Local Setup

Un setup completamente local puede usar Local Milvus con Ollama:

```conf
embeddingProvider = Ollama
embeddingModel = nomic-embed-text
ollamaHost = http://127.0.0.1:11434
milvusAddress = localhost:19530
```
