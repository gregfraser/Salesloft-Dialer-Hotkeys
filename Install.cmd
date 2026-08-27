@echo off
REM Sets up the transcription server. Double-click this once, then use
REM "Start Server.cmd" before each call block.
REM
REM This exists so nobody has to open PowerShell and type a command with
REM -ExecutionPolicy Bypass in it. It does nothing the documented command
REM does not do.
title Salesloft Dialer Hotkeys - Setup
pushd "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\install.ps1"
set SETUP_EXIT=%ERRORLEVEL%
popd
echo.
if %SETUP_EXIT% NEQ 0 (
  echo ----------------------------------------------------------------
  echo  Setup did not finish. The message above says what went wrong.
  echo  docs\troubleshooting.md has a Setup section for the common ones.
  echo ----------------------------------------------------------------
) else (
  echo You can close this window. Use "Start Server.cmd" before your calls.
)
echo.
pause
