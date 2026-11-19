//! The full Rakazo web client in a window this app owns, for the surfaces the native views do not
//! draw. It is the server's own web app in Microsoft Edge WebView2, never a native view.

#[cfg(any(target_os = "windows", test))]
mod policy;
#[cfg(target_os = "windows")]
mod window;

use gpui_kit::*;

/// Opens `url` on `server` in a workspace window for the signed-in native `account`, or brings
/// forward the one already showing it. False when there is no embedded web view to use, so the
/// caller opens the browser instead.
pub fn open(server: &str, account: &str, url: &str, cx: &mut App) -> bool {
    #[cfg(target_os = "windows")]
    {
        let Ok(server) = url::Url::parse(server) else { return false };
        let Some(profile) = policy::profile_key(&server, account) else { return false };
        window::open(server, profile, url.to_owned(), cx);
        true
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (server, account, url, cx);
        false
    }
}

/// Closes every workspace window of `account` on `server`, when that native session ends.
pub fn close(server: &str, account: &str, cx: &mut App) {
    #[cfg(target_os = "windows")]
    if let Some(profile) = url::Url::parse(server).ok().and_then(|server| policy::profile_key(&server, account)) {
        window::close(&profile, cx);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (server, account, cx);
}
