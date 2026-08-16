@echo off
REM ============================================================
REM  역매공파 무인 자동매매 supervisor 시작 (P0-35)
REM  더블클릭/CMD 실행용. 프로젝트: C:\Users\지숙\Vol
REM  로그: local-runner\logs\auto\YYYY-MM-DD\supervisor-console.log
REM ============================================================
setlocal
set "PROJECT_DIR=C:\Users\지숙\Vol"
cd /d "%PROJECT_DIR%" || (echo [YEOKMAE-AUTO] 프로젝트 폴더 없음: %PROJECT_DIR% & pause & exit /b 1)

REM 날짜 폴더는 로케일 영향 없는 PowerShell 로 산출
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "DAY=%%i"
set "LOGDIR=%PROJECT_DIR%\local-runner\logs\auto\%DAY%"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

echo [YEOKMAE-AUTO] supervisor 시작 (cwd=%PROJECT_DIR%)
echo [YEOKMAE-AUTO] 콘솔로그: %LOGDIR%\supervisor-console.log
call npm run yeokmae:auto 1>>"%LOGDIR%\supervisor-console.log" 2>&1
endlocal
