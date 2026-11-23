use std::path::PathBuf;

/// The person's private appearance pack on this computer: `SUPERBOT_APPEARANCE` when set,
/// otherwise `%LOCALAPPDATA%\Superbot\appearance` on Windows and
/// `~/Library/Application Support/Superbot/appearance` on macOS, or the `appearance`
/// directory under the Superbot settings directory on Linux. Paths inside a pack are
/// relative to this folder, so a pack can be copied between computers. Packs are never
/// bundled with the app.
pub fn folder() -> Option<PathBuf> {
    if let Some(folder) = std::env::var_os("SUPERBOT_APPEARANCE") {
        return Some(PathBuf::from(folder));
    }
    let base = if cfg!(target_os = "windows") {
        PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
    } else if cfg!(target_os = "macos") {
        PathBuf::from(std::env::var_os("HOME")?).join("Library").join("Application Support")
    } else if cfg!(target_os = "linux") {
        return Some(superbot_client::settings_directory()?.join("appearance"));
    } else {
        return None;
    };
    Some(base.join("Superbot").join("appearance"))
}
