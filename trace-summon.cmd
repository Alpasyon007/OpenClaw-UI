@echo off
rem ─────────────────────────────────────────────────────────────────────────
rem  Capture a launcher summon trace.
rem
rem  1. Run this file. It closes any running OpenClaw UI and relaunches it
rem     with window diagnostics enabled.
rem  2. Reproduce the problem: click into another app, then press
rem     Ctrl+Shift+K a few times so the jump happens.
rem  3. Come back here and press a key. The trace is written to
rem     summon-trace.txt next to this file, and opened for you.
rem ─────────────────────────────────────────────────────────────────────────

set "APP=%~dp0release\win-unpacked\OpenClaw UI.exe"
set "LOG=%USERPROFILE%\.clui-debug.log"
set "OUT=%~dp0summon-trace.txt"

if not exist "%APP%" (
  echo Could not find "%APP%".
  echo Run "npm run dist:win" first.
  pause
  exit /b 1
)

echo Closing any running instance...
taskkill /IM "OpenClaw UI.exe" /F >nul 2>&1
timeout /t 2 /nobreak >nul

del "%LOG%" >nul 2>&1

echo Launching with diagnostics...
set CLUI_SPACES_DEBUG=1
start "" "%APP%"

echo.
echo   Now reproduce the problem:
echo     - click into another window
echo     - press Ctrl+Shift+K a few times
echo.
pause

findstr /C:"[spaces]" "%LOG%" > "%OUT%" 2>nul
echo Trace written to "%OUT%"
start "" notepad "%OUT%"
