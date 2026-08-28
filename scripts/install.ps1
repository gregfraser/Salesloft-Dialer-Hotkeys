# Salesloft Live Transcriber - one-time server setup (Windows 11).
#
# Creates a virtual environment, installs the CPU-only dependencies, and
# pre-downloads the Whisper model so the first call is not spent waiting.
#
# Easiest way to run this: double-click Install.cmd in the project folder.
# From a terminal:
#
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#
# Every step below checks $LASTEXITCODE. That is not belt-and-braces: this is
# Windows PowerShell 5.1, where $ErrorActionPreference only governs PowerShell's
# own errors. A native command (python.exe, pip.exe) that exits nonzero raises
# nothing at all, so without these checks a failed step falls through to the
# next one and the script still ends with "Setup complete." in green.
# PowerShell 7.3+ has $PSNativeCommandUseErrorActionPreference for exactly this;
# 5.1 does not, so the checks stay until this script drops 5.1 support.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root '.venv'
$requirements = Join-Path $root 'server\requirements.txt'
$venvPython = Join-Path $venv 'Scripts\python.exe'

Write-Host 'Salesloft Live Transcriber - server setup' -ForegroundColor Cyan

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Error 'Python not found. Install Python 3.10 or newer from python.org and re-run.'
}

$version = & python -c "import sys; print('.'.join(map(str, sys.version_info[:2])))"
if ($LASTEXITCODE -ne 0 -or -not $version) {
    # The usual cause on Windows 11 is the Microsoft Store alias: a stub named
    # python.exe that Get-Command finds, opens the Store, and exits without
    # running anything.
    Write-Error @'
Could not run Python. If typing "python" opens the Microsoft Store, that stub is
shadowing a real install: Settings > Apps > Advanced app settings > App execution
aliases, switch off both python entries, then install Python 3.10 or newer from
python.org and re-run.
'@
}

Write-Host "Using Python $version"
# Compared as versions, not strings -- "3.9" sorts after "3.10" as text.
if ([version]$version -lt [version]'3.10') {
    Write-Error "Python $version is too old. Install 3.10 or newer from python.org and re-run."
}

# Probe the interpreter rather than the directory: a .venv folder can exist and
# be empty or half-built, and reusing one is how an interrupted setup gets
# layered on top of instead of repaired. --clear rebuilds it from scratch.
if (-not (Test-Path $venvPython)) {
    Write-Host 'Creating virtual environment...'
    & python -m venv --clear $venv
    if ($LASTEXITCODE -ne 0) { Write-Error 'Could not create the virtual environment in .venv.' }
}

# Always "python -m pip", never Scripts\pip.exe. That .exe is a generated
# console-script shim, rewritten whenever pip is installed or upgraded, and
# pip cannot overwrite files it is running from -- so upgrading pip on Windows
# renames its own package to ~ip, unpacks the new copy, and regenerates the
# shim. Interrupt that and pip.exe is simply gone while python -m pip still
# works. The interpreter is a real file that no install step ever rewrites.
Write-Host 'Upgrading pip...'
& $venvPython -m pip install --upgrade pip --quiet
if ($LASTEXITCODE -ne 0) { Write-Error 'Could not upgrade pip. See docs/troubleshooting.md, "Setup".' }

# Torch first, from the CPU index. The default PyPI wheel pulls roughly 2.5GB
# of CUDA libraries that this service will never touch.
Write-Host 'Installing PyTorch (CPU-only build)...'
& $venvPython -m pip install torch --index-url https://download.pytorch.org/whl/cpu --quiet
if ($LASTEXITCODE -ne 0) {
    # Stopping here matters more than it looks. requirements.txt lists
    # torch>=2.0, so carrying on would leave the next step to satisfy it from
    # default PyPI -- quietly installing the ~2.5GB CUDA build and still
    # reporting success.
    Write-Error 'CPU-only PyTorch install failed. Stopping: continuing would pull the ~2.5GB CUDA build from PyPI instead.'
}

Write-Host 'Installing remaining dependencies...'
& $venvPython -m pip install -r $requirements --quiet
if ($LASTEXITCODE -ne 0) { Write-Error 'Dependency install failed.' }

# Confirm what actually landed. The check above covers a failed CPU install,
# but not a resolver that decided to replace it while satisfying something
# else -- and a CUDA build is invisible until someone wonders why .venv is 3GB.
& $venvPython -c "import torch, sys; sys.exit(0 if torch.version.cuda is None else 1)"
if ($LASTEXITCODE -ne 0) {
    Write-Error 'torch is either a CUDA build or will not import. Delete the .venv folder and re-run this script.'
}

# Pull the model now so it is cached before the first call rather than during it.
$model = 'small.en'
$configPath = Join-Path $root 'server\config.yaml'
if (Test-Path $configPath) {
    # Indentation-blind, so it finds the key nested under "transcription:".
    # Keep model: unique in this file -- a second one anywhere would win on
    # file order instead.
    $match = Select-String -Path $configPath -Pattern '^\s*model:\s*(\S+)' | Select-Object -First 1
    if ($match) { $model = $match.Matches[0].Groups[1].Value }
}

Write-Host "Pre-downloading Whisper model: $model"
& $venvPython -c "from faster_whisper import WhisperModel; WhisperModel('$model', device='cpu', compute_type='int8')"
if ($LASTEXITCODE -ne 0) {
    # Not skippable. Whatever is not cached here is downloaded on the first
    # WhisperModel construction instead -- which happens when the server starts
    # transcribing, i.e. during a live call.
    Write-Error "Could not pre-download the '$model' model. Do not skip this: the download would otherwise happen during a call."
}

Write-Host ''
Write-Host 'Setup complete.' -ForegroundColor Green
Write-Host 'Start the server by double-clicking "Start Server.cmd", or with:'
Write-Host '  powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1'
