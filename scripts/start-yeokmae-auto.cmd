@echo off
REM ============================================================
REM  Yeokmae unattended auto-trading supervisor launcher (P0-35 / P0-35A)
REM  For double-click / CMD. Project dir is derived from this file location (scripts\..).
REM  Logs: local-runner\logs\auto\YYYY-MM-DD\supervisor-console.log
REM  ASCII-only to avoid console code-page issues.
REM ============================================================
setlocal
REM %~dp0 = ...\scripts\  ->  parent is the project root (handles non-ASCII user names at runtime)
pushd "%~dp0.." || (echo [YEOKMAE-AUTO] cannot enter project dir & pause & exit /b 1)
set "PROJECT_DIR=%CD%"

REM Date folder via PowerShell (locale-independent)
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "DAY=%%i"
set "LOGDIR=%PROJECT_DIR%\local-runner\logs\auto\%DAY%"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

echo [YEOKMAE-AUTO] starting supervisor (cwd=%PROJECT_DIR%)
echo [YEOKMAE-AUTO] console log: %LOGDIR%\supervisor-console.log
call npm run yeokmae:auto 1>>"%LOGDIR%\supervisor-console.log" 2>&1
popd
endlocal
