[CmdletBinding()]
param(
    [string]$Server
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$native = Join-Path $root 'native'
$exe = Join-Path $root 'target\debug\superbot-desktop.exe'
$launchDir = Join-Path $root ('target\dev-session-' + [guid]::NewGuid())
$launchExe = Join-Path $launchDir 'superbot-desktop.exe'
if ($Server) { $env:SUPERBOT_SERVER = $Server }

function Build-Desktop {
    Write-Host "`n[dev] building..." -ForegroundColor Cyan
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'native.ps1') build --target-dir (Join-Path $root 'target') -p superbot-desktop | Out-Host
    $LASTEXITCODE -eq 0
}

function Start-Desktop {
    Write-Host '[dev] launching' -ForegroundColor Green
    [IO.Directory]::CreateDirectory($launchDir) | Out-Null
    Copy-Item -LiteralPath $exe -Destination $launchExe -Force
    Start-Process -FilePath $launchExe -WorkingDirectory $root -PassThru
}

function Stop-Desktop($Process) {
    if ($Process -and -not $Process.HasExited) {
        if (!$Process.CloseMainWindow() -or !$Process.WaitForExit(4000)) {
            if (!$Process.HasExited) { $Process.Kill() }
        }
        $Process.WaitForExit()
    }
}

$watcher = New-Object IO.FileSystemWatcher $native
$watcher.IncludeSubdirectories = $true
$watcher.NotifyFilter = [IO.NotifyFilters]'LastWrite, FileName'
$manifestWatcher = New-Object IO.FileSystemWatcher $root, 'Cargo.*'
$eventNames = foreach ($eventName in 'Changed', 'Created', 'Renamed', 'Deleted') {
    foreach ($entry in @(@{source=$watcher; id='native'}, @{source=$manifestWatcher; id='manifest'})) {
        $id = "superbot-dev-$($entry.id)-$eventName"
        Register-ObjectEvent $entry.source $eventName -SourceIdentifier $id | Out-Null
        $id
    }
}
$watcher.EnableRaisingEvents = $true
$manifestWatcher.EnableRaisingEvents = $true

$app = $null
try {
    if (Build-Desktop) { $app = Start-Desktop }
    Write-Host "[dev] watching $native (Ctrl+C to stop)" -ForegroundColor Cyan
    while ($true) {
        if (-not (Wait-Event -Timeout 1)) { continue }
        Start-Sleep -Milliseconds 400
        Get-Event | Remove-Event
        if (Build-Desktop) {
            Stop-Desktop $app
            $app = Start-Desktop
        } else {
            Write-Host '[dev] build failed; the last good build keeps running' -ForegroundColor Yellow
        }
    }
} finally {
    $eventNames | ForEach-Object { Unregister-Event -SourceIdentifier $_ }
    $watcher.Dispose()
    $manifestWatcher.Dispose()
    Stop-Desktop $app
    if ([IO.File]::Exists($launchExe)) { [IO.File]::Delete($launchExe) }
    if ([IO.Directory]::Exists($launchDir)) { [IO.Directory]::Delete($launchDir) }
}
