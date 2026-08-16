# ============================================================
#  역매공파 무인 자동매매 supervisor 시작 — 창 없이 실행 wrapper (P0-35)
#  Task Scheduler/수동 공용. 프로젝트: C:\Users\지숙\Vol
#  로그: local-runner\logs\auto\YYYY-MM-DD\supervisor-console.log
#  수동 무창 실행 예:
#    powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts\start-yeokmae-auto.ps1
# ============================================================
$ErrorActionPreference = 'Stop'
$ProjectDir = 'C:\Users\지숙\Vol'
if (-not (Test-Path $ProjectDir)) { Write-Error "[YEOKMAE-AUTO] 프로젝트 폴더 없음: $ProjectDir"; exit 1 }
Set-Location $ProjectDir

$Day = Get-Date -Format 'yyyy-MM-dd'
$LogDir = Join-Path $ProjectDir "local-runner\logs\auto\$Day"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Console = Join-Path $LogDir 'supervisor-console.log'

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = 'npm.cmd' }

"[YEOKMAE-AUTO] $(Get-Date -Format o) supervisor 시작 (cwd=$ProjectDir)" | Out-File -FilePath $Console -Append -Encoding utf8
# supervisor 내부에서 KR/US daemon 시작·감시. 콘솔 출력은 파일로(무인).
& $npm run yeokmae:auto *>> $Console
