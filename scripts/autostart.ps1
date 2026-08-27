# Turn "start the transcription server when I log in" on or off.
#
# Easiest way to run this: double-click "Auto-start.cmd" in the project folder,
# which toggles it and tells you which way it went. From a terminal:
#
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1            # report
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Enable
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Disable
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Toggle
#
# This is a shortcut in the user's own Startup folder -- no scheduled task, no
# service, no admin rights, and nothing to uninstall but the shortcut. The
# server window still opens (minimised), which is deliberate: a rep who cannot
# see the server has no way to tell whether transcription is available, and no
# way to stop it.
#
# The tradeoff worth knowing: server startup loads the Whisper model, so an
# idle server holds roughly a gigabyte. That is the point -- the model is warm
# before the first dial instead of loading during it -- but it is a real cost
# on a machine that is short of memory.

[CmdletBinding()]
param(
    [switch]$Enable,
    [switch]$Disable,
    [switch]$Toggle
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root 'Start Server.cmd'
$startup = [Environment]::GetFolderPath('Startup')
$shortcut = Join-Path $startup 'Salesloft Transcription Server.lnk'

if (-not (Test-Path $launcher)) {
    Write-Error "Could not find `"$launcher`". Run this from the project folder."
}

$isOn = Test-Path $shortcut

if ($Toggle) {
    if ($isOn) { $Disable = $true } else { $Enable = $true }
}

if (-not $Enable -and -not $Disable) {
    if ($isOn) {
        Write-Host 'Auto-start is ON. The server starts when you log in.' -ForegroundColor Green
    } else {
        Write-Host 'Auto-start is OFF. Start the server with "Start Server.cmd".' -ForegroundColor Yellow
    }
    return
}

if ($Enable) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($shortcut)
    $link.TargetPath = $launcher
    $link.WorkingDirectory = $root
    $link.Description = 'Salesloft live call transcription server'
    $link.WindowStyle = 7   # minimised: present in the taskbar, not in the way
    $link.Save()
    Write-Host 'Auto-start is now ON.' -ForegroundColor Green
    Write-Host 'The server will start minimised each time you log in.'
    Write-Host 'It is not running yet - double-click "Start Server.cmd" for today.'
} else {
    if ($isOn) { Remove-Item $shortcut -Force }
    Write-Host 'Auto-start is now OFF.' -ForegroundColor Yellow
    Write-Host 'A server already running stays running until you close its window.'
}
