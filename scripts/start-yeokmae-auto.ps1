# ============================================================
#  Yeokmae unattended auto-trading supervisor - no-window launcher (P0-35 / P0-35A)
#  Used by Task Scheduler and manual runs. Project dir is derived from this script location.
#  Logs: local-runner\logs\auto\YYYY-MM-DD\supervisor-console.log
#  Manual no-window run example:
#    powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts\start-yeokmae-auto.ps1
#  NOTE: ASCII-only (avoids Windows PowerShell 5.1 UTF-8/BOM parser errors). No hardcoded non-ASCII path.
# ============================================================
param(
  [string]$ProjectDir
)
$ErrorActionPreference = 'Stop'

if (-not $ProjectDir -or $ProjectDir -eq '') {
  $ProjectDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
}
if (-not (Test-Path -LiteralPath $ProjectDir)) { Write-Error "Project folder not found: $ProjectDir"; exit 1 }
Set-Location -LiteralPath $ProjectDir

$Day = Get-Date -Format 'yyyy-MM-dd'
$LogDir = Join-Path $ProjectDir "local-runner\logs\auto\$Day"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Console = Join-Path $LogDir 'supervisor-console.log'

$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($npmCmd) { $npm = $npmCmd.Source } else { $npm = 'npm.cmd' }

"[YEOKMAE-AUTO] $(Get-Date -Format o) supervisor start (cwd=$ProjectDir)" | Out-File -FilePath $Console -Append -Encoding utf8
# The supervisor starts and monitors the KR/US daemons. Console output goes to the log file (unattended).
& $npm run yeokmae:auto *>> $Console
