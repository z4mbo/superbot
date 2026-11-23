[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Superbot\app'),
    [string]$BuildDir,
    [switch]$StartMenuShortcut,
    [switch]$SkipPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$destination = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir))
$bin = Join-Path $destination 'bin'
$desktop = Join-Path $destination 'Superbot.exe'
$icon = Join-Path $destination 'Superbot.ico'

function Add-UserPath($Directory) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
        $path = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $entries = @($path.Split(';') | Where-Object {
            [Environment]::ExpandEnvironmentVariables($_.Trim('"')).TrimEnd('\') -ne $Directory.TrimEnd('\') -and $_
        })
        $updated = (@($Directory) + $entries) -join ';'
        if ($updated -eq $path) { return }
        $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { 'ExpandString' }
        $key.SetValue('Path', $updated, $kind)
    } finally { $key.Dispose() }
    if (-not ('Superbot.Win32Environment' -as [type])) {
        Add-Type -Namespace Superbot -Name Win32Environment -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr window, uint message, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);
'@
    }
    $result = [UIntPtr]::Zero
    [void][Superbot.Win32Environment]::SendMessageTimeout([IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 2, 1000, [ref]$result)
}

function Install-Shortcut {
    $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    [void][IO.Directory]::CreateDirectory($programs)
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path $programs 'Superbot.lnk'))
    $shortcut.TargetPath = $desktop
    $shortcut.WorkingDirectory = $destination
    $shortcut.IconLocation = "$icon,0"
    $shortcut.Save()
}

if (-not $BuildDir) {
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'native.ps1') build --locked --release --target-dir (Join-Path $root 'target') -p superbot-desktop -p superbot-cli -p superbot-plugin-kit
    if ($LASTEXITCODE -ne 0) { throw 'Superbot build failed. The existing installation was left in place.' }
    $BuildDir = Join-Path $root 'target\release'
}

$files = @{
    'Superbot.exe' = Join-Path $BuildDir 'superbot-desktop.exe'
    'bin\superbot.exe' = Join-Path $BuildDir 'superbot.exe'
    'bin\superbot-plugin.exe' = Join-Path $BuildDir 'superbot-plugin.exe'
    'Superbot.ico' = Join-Path $root 'native\desktop\assets\superbot.ico'
    'LICENSE' = Join-Path $root 'LICENSE'
    'NOTICE' = Join-Path $root 'NOTICE'
    'licenses\Geist-OFL.txt' = Join-Path $root 'native\desktop\assets\fonts\OFL.txt'
    'licenses\Lucide-ISC.txt' = Join-Path $root 'native\workspace-panel\assets\icons\LICENSE-LUCIDE'
    'licenses\Design-NOTICE.txt' = Join-Path $root 'superbot-site\NOTICE.txt'
    'licenses\Apache-2.0.txt' = Join-Path $root 'superbot-site\licenses\Apache-2.0.txt'
}
foreach ($source in $files.Values) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing distribution file $source." }
}

[void][IO.Directory]::CreateDirectory($destination)
$lock = [IO.File]::Open((Join-Path $destination 'install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $executables = @($desktop, (Join-Path $bin 'superbot.exe'), (Join-Path $bin 'superbot-plugin.exe'))
    foreach ($process in Get-Process Superbot, superbot-plugin -ErrorAction SilentlyContinue) {
        if ($process.Path -in $executables) { throw 'Close the installed Superbot app and commands before refreshing.' }
    }
    foreach ($file in $files.Keys) {
        $target = Join-Path $destination $file
        if ((Test-Path -LiteralPath $target) -and
            (Get-FileHash -LiteralPath $files[$file]).Hash -eq (Get-FileHash -LiteralPath $target).Hash) { continue }
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $target))
        $pending = "$target.installing"
        try {
            [IO.File]::Copy((Resolve-Path -LiteralPath $files[$file]).Path, $pending, $true)
            if ([IO.File]::Exists($target)) {
                $backup = "$target.previous-install"
                [IO.File]::Replace($pending, $target, $backup)
                [IO.File]::Delete($backup)
            } else {
                [IO.File]::Move($pending, $target)
            }
        } finally { [IO.File]::Delete($pending) }
    }

    if ($StartMenuShortcut) { Install-Shortcut }
    if (-not $SkipPath) { Add-UserPath $bin }
    Write-Output "Superbot installed to $destination"
} finally { $lock.Dispose() }
