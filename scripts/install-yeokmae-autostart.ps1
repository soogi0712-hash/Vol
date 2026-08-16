# ============================================================
#  Yeokmae unattended auto-trading - Windows Task Scheduler autostart installer (P0-35 / P0-35A)
#  Run once:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-yeokmae-autostart.ps1
#  Options:
#    -ProjectDir <path> : override project folder (default = parent of this scripts\ folder)
#    -WakeToRun         : enable "Wake the computer to run this task" (default off; user choice)
#    -RunWhenLoggedOff  : run even when logged off (requires Windows credentials -> prompt).
#                         Default runs at logon (no credentials needed).
#  Task name: YeokmaeAutoTrading | Trigger: at logon | Auto-restart on failure | Recovers after reboot.
#  If the task already exists it is updated (no duplicate).
#  NOTE: ASCII-only on purpose. The project path is derived from this script's own location
#        ($PSScriptRoot\..), so a non-ASCII Windows user name in the path is handled at runtime
#        without ever writing non-ASCII bytes into this file (avoids PS 5.1 UTF-8/BOM parser errors).
# ============================================================
param(
  [string]$ProjectDir,
  [switch]$WakeToRun,
  [switch]$RunWhenLoggedOff
)
$ErrorActionPreference = 'Stop'
$TaskName = 'YeokmaeAutoTrading'

if (-not $ProjectDir -or $ProjectDir -eq '') {
  $ProjectDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
}
$Ps1 = Join-Path $ProjectDir 'scripts\start-yeokmae-auto.ps1'

if (-not (Test-Path -LiteralPath $ProjectDir)) { Write-Error "Project folder not found: $ProjectDir"; exit 1 }
if (-not (Test-Path -LiteralPath $Ps1))        { Write-Error "Start script not found: $Ps1"; exit 1 }

$Action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Ps1`"" `
  -WorkingDirectory $ProjectDir

# At logon (home PC default). Covers boot-then-auto-login and manual login.
$Trigger = New-ScheduledTaskTrigger -AtLogOn

# Auto-restart on failure + keep running on battery + unlimited run time (long-lived daemon) + no duplicate instance.
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew
if ($WakeToRun) { $Settings.WakeToRun = $true; Write-Host '[install] WakeToRun enabled (wake from sleep at task time).' }

if ($RunWhenLoggedOff) {
  # Run while logged off - requires Windows credentials (password prompt). Registered with LogonType Password.
  Write-Host '[install] RunWhenLoggedOff = ON -> your Windows account password is required (prompt).' -ForegroundColor Yellow
  $Cred = Get-Credential -UserName $env:USERNAME -Message 'Windows account password to register the scheduled task'
  $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Password -RunLevel Limited
  $params = @{
    TaskName    = $TaskName
    Action      = $Action
    Trigger     = $Trigger
    Settings    = $Settings
    Principal   = $Principal
    Description = 'Yeokmae KR/US unattended auto-trading supervisor (P0-35)'
    User        = $Cred.UserName
    Password    = $Cred.GetNetworkCredential().Password
  }
} else {
  $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  $params = @{
    TaskName    = $TaskName
    Action      = $Action
    Trigger     = $Trigger
    Settings    = $Settings
    Principal   = $Principal
    Description = 'Yeokmae KR/US unattended auto-trading supervisor (P0-35)'
  }
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "[install] Existing task '$TaskName' found -> updating." -ForegroundColor Cyan
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask @params | Out-Null

Write-Host "[install] Done: '$TaskName' registered." -ForegroundColor Green
Write-Host "  Trigger    : at logon"
Write-Host "  WorkingDir : $ProjectDir"
Write-Host "  On failure : auto-restart after 1 min (up to 999) + recover after reboot"
Write-Host "  No dup     : MultipleInstances=IgnoreNew + supervisor single-instance lock"
Write-Host ""
Write-Host "Start now         : Start-ScheduledTask -TaskName $TaskName"
Write-Host "Check status      : npm run yeokmae:auto-status"
Write-Host "Remove autostart  : powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-yeokmae-autostart.ps1"
if (-not $RunWhenLoggedOff) {
  Write-Host ""
  Write-Host "[note] Current mode runs at logon (no credentials needed). It starts automatically after you log in." -ForegroundColor DarkGray
  Write-Host "       To run without logging in (logged-off), re-run with -RunWhenLoggedOff (Windows password required)." -ForegroundColor DarkGray
}
