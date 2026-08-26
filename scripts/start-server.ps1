# Start the local transcription service.
#
#   powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1
#
# Binds to 127.0.0.1 only. Nothing it handles leaves this machine, and no code
# path in it writes audio to disk.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
$server = Join-Path $root 'server'

if (-not (Test-Path $venvPython)) {
    Write-Error 'No virtual environment found. Run scripts\install.ps1 first.'
}

Write-Host 'Starting transcription service on ws://127.0.0.1:8765/transcribe' -ForegroundColor Cyan
Write-Host 'Leave this window open during your call block. Ctrl+C to stop.'
Write-Host ''

Push-Location $server
try {
    # The service lowers its own priority once running, so Whisper never
    # competes with Twilio's WebRTC encoder for CPU.
    & $venvPython main.py
}
finally {
    Pop-Location
}
