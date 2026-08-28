@echo off
REM Switches "start the server when I log in" on or off. Double-click to flip
REM it; the window tells you which way it went.
title Salesloft Dialer Hotkeys - Auto-start
pushd "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\autostart.ps1" -Toggle
popd
echo.
pause
