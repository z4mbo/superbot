# Install Superbot on Windows

From the checkout root, run the installer with Rust and the Windows build
tools available. It builds the native app and both command-line tools from
the repository's lockfile.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-native.ps1 -StartMenuShortcut
```

Open **Superbot** from Start, or double-click
`%LOCALAPPDATA%\Superbot\app\Superbot.exe`. The optional Start shortcut uses
the Superbot icon, rasterized from the project's licensed logo. The installer
adds the `bin` subdirectory to your user PATH. Open a new terminal and run
`superbot --help` or `superbot-plugin --help`.

Close the installed app and command sessions before running the installer
again to refresh the build. The install directory also contains the licenses
and notices for the app, fonts, and icons. Account sessions remain in Windows
Credential Manager. Start your [local Superbot server](windows-local.md)
before connecting, or sign in to a [hosted server](hosting.md).

To install previously built executables, supply `-BuildDir` with the directory
containing `superbot-desktop.exe`, `superbot.exe`, and `superbot-plugin.exe`.
Use `-InstallDir` and `-SkipPath` to test a copy in a separate directory.

## Preview native UI changes while editing

From the checkout root, run this in a PowerShell terminal and leave it open.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/dev-desktop.ps1
```

The script watches `native/` and the root Cargo manifests. After a successful build it reopens the development window with the updated code. A failed build leaves the last working window open and prints the compiler error in the terminal. Pass `-Server URL` to select a different host for that session, or use your saved server address. Press Ctrl+C to stop the watcher and its window.
