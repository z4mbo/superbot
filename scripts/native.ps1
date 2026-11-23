$CargoArguments = $args
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$cargoCommand = Get-Command cargo.exe -ErrorAction SilentlyContinue
$cargoExe = if ($cargoCommand) { $cargoCommand.Source } else { Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe' }
if (-not (Test-Path -LiteralPath $cargoExe)) {
    throw 'Install Rust with rustup, then run this command again.'
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path -LiteralPath $vswhere) {
    $install = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($install) {
        $cmakeRoot = Join-Path $install 'Common7\IDE\CommonExtensions\Microsoft\CMake'
        $llvmBin = Join-Path $install 'VC\Tools\Llvm\x64\bin'
        $buildTools = @((Split-Path -Parent $cargoExe), (Join-Path $cmakeRoot 'CMake\bin'), (Join-Path $cmakeRoot 'Ninja'), $llvmBin)
        $env:PATH = (($buildTools | Where-Object { Test-Path -LiteralPath $_ }) -join ';') + ';' + $env:PATH
        if (!$env:LIBCLANG_PATH -and (Test-Path -LiteralPath (Join-Path $llvmBin 'libclang.dll'))) {
            $env:LIBCLANG_PATH = $llvmBin
        }
    }
}

Push-Location -LiteralPath $repoRoot
try {
    if (!$CargoArguments) { $CargoArguments = @('run', '-p', 'superbot-desktop') }
    & $cargoExe @CargoArguments
    $cargoExit = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $cargoExit
