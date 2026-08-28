@echo off
REM Starts the transcription server. Double-click before your call block and
REM leave this window open -- closing it stops transcription.
title Transcription server - leave this window open
pushd "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\start-server.ps1"
set SERVER_EXIT=%ERRORLEVEL%
popd
echo.
if %SERVER_EXIT% NEQ 0 (
  echo ----------------------------------------------------------------
  echo  The server could not start. If it says to run setup first,
  echo  double-click Install.cmd.
  echo ----------------------------------------------------------------
) else (
  echo Server stopped. Transcription is off until you start it again.
)
echo.
pause
