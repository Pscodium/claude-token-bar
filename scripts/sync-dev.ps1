# Copia o mod deste repo para uma pasta de mods carregada pelo Claude Code (hot reload).
# Uso: ./scripts/sync-dev.ps1 -Dest "C:\Users\<voce>\.claude\dev-mods\<sessao>\token-bar"
# Sem -Dest, usa a variavel de ambiente TOKEN_BAR_DEV_DIR.
param([string]$Dest = $env:TOKEN_BAR_DEV_DIR)

$ErrorActionPreference = 'Stop'
if (-not $Dest) { throw 'Informe -Dest ou defina TOKEN_BAR_DEV_DIR.' }

$root = Split-Path -Parent $PSScriptRoot
foreach ($dir in 'hooks', 'types', '.claude-plugin') {
  New-Item -ItemType Directory -Force (Join-Path $Dest $dir) | Out-Null
}
Copy-Item "$root/hooks/*" "$Dest/hooks/" -Force
Copy-Item "$root/types/*" "$Dest/types/" -Force
Copy-Item "$root/.claude-plugin/plugin.json" "$Dest/.claude-plugin/plugin.json" -Force
Copy-Item "$root/tsconfig.json" "$Dest/tsconfig.json" -Force
Write-Host "Sincronizado em $Dest (recarrega quando o turno do Claude terminar)."
