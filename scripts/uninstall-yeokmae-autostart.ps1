# ============================================================
#  역매공파 무인 자동매매 — Windows 작업 스케줄러 자동시작 제거 (P0-35)
#  실행:  powershell -ExecutionPolicy Bypass -File scripts\uninstall-yeokmae-autostart.ps1
#  (실행 중인 supervisor 는 종료하지 않음 — 자동시작 등록만 제거. 즉시 종료는 supervisor 창에서 Ctrl+C.)
# ============================================================
$ErrorActionPreference = 'Stop'
$TaskName = 'YeokmaeAutoTrading'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "[uninstall] '$TaskName' 자동시작 등록 제거 완료." -ForegroundColor Green
} else {
  Write-Host "[uninstall] '$TaskName' 작업이 없습니다(이미 제거됨)."
}
Write-Host "실행 중인 supervisor 는 별도로 Ctrl+C 하거나, 다음 재부팅부터 자동시작되지 않습니다."
