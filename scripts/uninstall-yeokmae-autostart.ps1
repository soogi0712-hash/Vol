# ============================================================
#  Yeokmae unattended auto-trading - remove Windows Task Scheduler autostart (P0-35 / P0-35A)
#  Run:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-yeokmae-autostart.ps1
#  (Does not stop a running supervisor - only removes the autostart entry. To stop now, press Ctrl+C
#   in the supervisor window.)
#  NOTE: ASCII-only (avoids Windows PowerShell 5.1 UTF-8/BOM parser errors).
# ============================================================
$ErrorActionPreference = 'Stop'
$TaskName = 'YeokmaeAutoTrading'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "[uninstall] Autostart task '$TaskName' removed." -ForegroundColor Green
} else {
  Write-Host "[uninstall] Task '$TaskName' not found (already removed)."
}
Write-Host "A running supervisor keeps running until you Ctrl+C it; it will not autostart after the next reboot."
