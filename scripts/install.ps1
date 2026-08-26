# Salesloft Live Transcriber - one-time server setup (Windows 11).
#
# Creates a virtual environment, installs the CPU-only dependencies, and
# pre-downloads the Whisper model so the first call is not spent waiting.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root '.venv'
$requirements = Join-Path $root 'server\requirements.txt'

Write-Host 'Salesloft Live Transcriber - server setup' -ForegroundColor Cyan

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Error 'Python not found. Install Python 3.10 or newer from python.org and re-run.'
}

$version = & python -c "import sys; print('.'.join(map(str, sys.version_info[:2])))"
Write-Host "Using Python $version"

if (-not (Test-Path $venv)) {
    Write-Host 'Creating virtual environment...'
    & python -m venv $venv
}

$pip = Join-Path $venv 'Scripts\pip.exe'
$venvPython = Join-Path $venv 'Scripts\python.exe'

Write-Host 'Upgrading pip...'
& $venvPython -m pip install --upgrade pip --quiet

# Torch first, from the CPU index. The default PyPI wheel pulls roughly 2.5GB
# of CUDA libraries that this service will never touch.
Write-Host 'Installing PyTorch (CPU-only build)...'
& $pip install torch --index-url https://download.pytorch.org/whl/cpu --quiet

Write-Host 'Installing remaining dependencies...'
& $pip install -r $requirements --quiet

# Pull the model now so it is cached before the first call rather than during it.
$model = 'small.en'
$configPath = Join-Path $root 'server\config.yaml'
if (Test-Path $configPath) {
    $match = Select-String -Path $configPath -Pattern '^\s*model:\s*(\S+)' | Select-Object -First 1
    if ($match) { $model = $match.Matches[0].Groups[1].Value }
}

Write-Host "Pre-downloading Whisper model: $model"
& $venvPython -c "from faster_whisper import WhisperModel; WhisperModel('$model', device='cpu', compute_type='int8')"

Write-Host ''
Write-Host 'Setup complete.' -ForegroundColor Green
Write-Host 'Start the server with:  powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1'
Write-Host ''
Write-Host 'Before your first live call, read docs\compliance.md.' -ForegroundColor Yellow
