@echo off
setlocal

cd /d "%~dp0apps\desktop"
where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found on PATH.
  pause
  exit /b 1
)

call pnpm run dev
set "exitCode=%errorlevel%"
if not "%exitCode%"=="0" pause
exit /b %exitCode%
