param(
    [switch]$DockerAccess,
    [ValidateRange(1, 65535)][int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
Get-Command codex -ErrorAction Stop | Out-Null
$env:CODEX_BRIDGE_PORT = [string]$Port
$env:CODEX_BRIDGE_HOST = if ($DockerAccess) { '0.0.0.0' } else { '127.0.0.1' }
& $nodeExecutable (Join-Path $PSScriptRoot 'server.mjs')
exit $LASTEXITCODE
