# ============================================================
#  역매공파 무인 자동매매 — Windows 작업 스케줄러 자동시작 등록 (P0-35)
#  최초 1회만:  powershell -ExecutionPolicy Bypass -File scripts\install-yeokmae-autostart.ps1
#  옵션:
#    -WakeToRun          : "작업 실행을 위해 컴퓨터 깨우기" 활성(기본 꺼짐, 사용자 선택)
#    -RunWhenLoggedOff   : 로그오프 상태에서도 실행(Windows 자격증명 필요 → 프롬프트). 기본은 로그온 시 실행.
#  작업명: YeokmaeAutoTrading · 트리거: 로그온 시 · 실패 시 자동재시작 · PC 재부팅 후 자동복구.
#  이미 등록돼 있으면 중복 생성하지 않고 갱신(update).
# ============================================================
param(
  [switch]$WakeToRun,
  [switch]$RunWhenLoggedOff
)
$ErrorActionPreference = 'Stop'
$TaskName    = 'YeokmaeAutoTrading'
$ProjectDir  = 'C:\Users\지숙\Vol'
$Ps1         = Join-Path $ProjectDir 'scripts\start-yeokmae-auto.ps1'

if (-not (Test-Path $ProjectDir)) { Write-Error "프로젝트 폴더 없음: $ProjectDir"; exit 1 }
if (-not (Test-Path $Ps1))        { Write-Error "시작 스크립트 없음: $Ps1"; exit 1 }

$Action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Ps1`"" `
  -WorkingDirectory $ProjectDir

# 로그온 시 시작(홈 PC 기본). 부팅 후 자동로그인/수동로그인 모두 커버.
$Trigger = New-ScheduledTaskTrigger -AtLogOn

# 실패 시 자동재시작 + 배터리/절전에도 유지 + 무제한 실행시간(장시간 daemon) + 중복 인스턴스 금지.
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew
if ($WakeToRun) { $Settings.WakeToRun = $true; Write-Host '[install] WakeToRun 활성(절전에서 작업시각에 깨우기).' }

if ($RunWhenLoggedOff) {
  # 로그오프 상태 실행 — Windows 자격증명 필요(암호 프롬프트). S4U 는 네트워크 제한이 있어 Password 로 등록.
  Write-Host '[install] RunWhenLoggedOff=ON → Windows 계정 암호가 필요합니다(프롬프트).' -ForegroundColor Yellow
  $Cred = Get-Credential -UserName $env:USERNAME -Message '작업 스케줄러 등록용 Windows 계정 암호'
  $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Password -RunLevel Limited
  $params = @{ TaskName=$TaskName; Action=$Action; Trigger=$Trigger; Settings=$Settings; Principal=$Principal;
              Description='역매공파 KR/US 무인 자동매매 supervisor (P0-35)'; User=$Cred.UserName; Password=$Cred.GetNetworkCredential().Password }
} else {
  $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  $params = @{ TaskName=$TaskName; Action=$Action; Trigger=$Trigger; Settings=$Settings; Principal=$Principal;
              Description='역매공파 KR/US 무인 자동매매 supervisor (P0-35)' }
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "[install] 기존 작업 '$TaskName' 발견 → 갱신(update)." -ForegroundColor Cyan
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask @params | Out-Null

Write-Host "[install] 완료: '$TaskName' 등록됨." -ForegroundColor Green
Write-Host "  트리거   : 로그온 시$(if($RunWhenLoggedOff){' + 로그오프 상태 실행(자격증명)'})"
Write-Host "  작업폴더 : $ProjectDir"
Write-Host "  실패시   : 1분 후 자동재시작(최대 999회) · 재부팅 후 자동복구"
Write-Host "  중복방지 : MultipleInstances=IgnoreNew + supervisor 단일 인스턴스 락"
Write-Host ""
Write-Host "지금 즉시 시작하려면: Start-ScheduledTask -TaskName $TaskName"
Write-Host "상태 확인      : npm run yeokmae:auto-status"
Write-Host "자동시작 제거  : powershell -ExecutionPolicy Bypass -File scripts\uninstall-yeokmae-autostart.ps1"
if (-not $RunWhenLoggedOff) {
  Write-Host ""
  Write-Host "[안내] 지금은 '로그온 시 실행'입니다(자격증명 불필요). PC 부팅 후 로그인하면 자동 시작됩니다." -ForegroundColor DarkGray
  Write-Host "       로그인 없이(로그오프 상태)도 돌리려면 -RunWhenLoggedOff 로 재실행(Windows 암호 필요)." -ForegroundColor DarkGray
}
