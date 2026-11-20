//! Embedded Superbot workspace on Windows and agent computer screen on Windows and macOS.

#[cfg(any(target_os = "windows", target_os = "macos", test))]
mod policy;
pub mod screen;
#[cfg(target_os = "windows")]
mod sign_in;
#[cfg(target_os = "windows")]
mod window;

use gpui_kit::*;

/// How a sign-in window ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Returned {
    /// The provider sent this sign-in back with its authorization code.
    Code(String),
    /// The provider sent it back without one, with its reason when it gave one.
    Refused(Option<String>),
    /// The person chose to finish it in their browser instead.
    Browser,
    Closed,
}

/// Opens `authorization_url` in a sign-in window with its own web profile for `account` on
/// `server`: the provider's pages load there, and its return to the address the request names
/// is taken by the app before the page loads, so the code never reaches a web session and no
/// session of the app's reaches the provider. `done` runs once. False when there is no
/// embedded web view, or the request names no return the window can take.
pub fn sign_in(
    server: &str,
    account: &str,
    authorization_url: &str,
    done: impl FnOnce(Returned, &mut App) + 'static,
    cx: &mut App,
) -> bool {
    #[cfg(target_os = "windows")]
    {
        let Ok(server) = url::Url::parse(server) else { return false };
        let Some(profile) = policy::profile_key(&server, account) else { return false };
        let Some(expected) = policy::Return::from_authorization(authorization_url) else { return false };
        if !window::runtime_installed() {
            return false;
        }
        sign_in::open(format!("{profile}-sign-in"), authorization_url.to_owned(), expected, Box::new(done), cx);
        true
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (server, account, authorization_url, done, cx);
        false
    }
}

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
