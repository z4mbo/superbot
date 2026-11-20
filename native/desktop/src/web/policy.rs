use url::Url;

/// Where a top-level navigation inside the workspace window goes.
#[derive(Debug, PartialEq, Eq)]
pub enum Navigate {
    Here,
    Browser,
    Refuse,
}

/// What happens to a page's request for a new window.
#[derive(Debug, PartialEq, Eq)]
pub enum Popup {
    /// A window of this app, in the same web profile, so the opener can finish a sign-in in it.
    App,
    Browser,
    Refuse,
}

pub fn navigation(server: &Url, target: &str) -> Navigate {
    let Ok(target) = Url::parse(target) else { return Navigate::Refuse };
    match target.scheme() {
        "about" if target.as_str() == "about:blank" => Navigate::Here,
        "http" | "https" if target.origin() == server.origin() => Navigate::Here,
        // A sign-in that redirects through another site and returns. The toolbar names the site.
        "https" => Navigate::Here,
        "http" | "mailto" => Navigate::Browser,
        _ => Navigate::Refuse,
    }
}

/// `sized` is true when the page asked for a window of a given size, as a sign-in popup does.
pub fn popup(server: &Url, target: &str, sized: bool) -> Popup {
    let Ok(target) = Url::parse(target) else { return Popup::Refuse };
    match target.scheme() {
        "about" if target.as_str() == "about:blank" => Popup::App,
        "http" | "https" if target.origin() == server.origin() => Popup::App,
        "https" if sized => Popup::App,
        "http" | "https" | "mailto" => Popup::Browser,
        _ => Popup::Refuse,
    }
}

/// Whether `target` is one of the server's own screen pages, the only thing a screen view loads.
/// Their address carries the screen's capability, so it is checked here and never shown.
pub fn screen_page(server: &Url, target: &str) -> bool {
    if target == "about:blank" {
        return true;
    }
    Url::parse(target).is_ok_and(|target| {
        matches!(target.scheme(), "http" | "https")
            && target.origin() == server.origin()
            && target.path().starts_with("/novnc/session/")
    })
}

pub fn is_server(server: &Url, location: &str) -> bool {
    Url::parse(location).is_ok_and(|location| location.origin() == server.origin())
}

/// The folder name of one native account's web profile on one server. Each account on each
/// origin gets its own cookies, so a web sign-in never carries over to another account. The name
/// is a hash: neither the server nor the account can be read from it.
pub fn profile_key(server: &Url, account: &str) -> Option<String> {
    use sha2::{Digest, Sha256};
    if account.is_empty() {
        return None;
    }
    let origin = server.origin();
    if !origin.is_tuple() {
        return None;
    }
    let digest = Sha256::new()
        .chain_update(b"superbot-workspace-profile\0")
        .chain_update(origin.ascii_serialization().as_bytes())
        .chain_update(b"\0")
        .chain_update(account.as_bytes())
        .finalize();
    Some(digest[..16].iter().map(|byte| format!("{byte:02x}")).collect())
}

/// What "Open in browser" opens: the page on screen when it is a web page, else the workspace.
pub fn browser_target(server: &Url, location: Option<&str>) -> String {
    location
        .and_then(|location| Url::parse(location).ok())
        .filter(|location| matches!(location.scheme(), "http" | "https"))
        .map_or_else(|| home(server), String::from)
}

pub fn home(server: &Url) -> String {
    server.join("/app").map_or_else(|_| server.to_string(), String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> Url {
        Url::parse("http://127.0.0.1:5173").unwrap()
    }

    #[test]
    fn a_screen_view_loads_only_this_servers_screen_pages() {
        let server = server();
        assert!(screen_page(&server, "http://127.0.0.1:5173/novnc/session/view/1.abc/embed.html?x=1"));
        assert!(screen_page(&server, "about:blank"));
        for target in [
            "http://127.0.0.1:5173/app",
            "http://127.0.0.1:5173/novnc/other",
            "http://127.0.0.1:9999/novnc/session/view/1.abc",
            "https://screens.example.com/novnc/session/view/1.abc",
            "file:///C:/novnc/session/view",
            "javascript:alert(1)",
        ] {
            assert!(!screen_page(&server, target), "{target}");
        }
    }

    #[test]
    fn the_server_and_sign_in_redirects_stay_in_the_window() {
        let server = server();
        assert_eq!(navigation(&server, "http://127.0.0.1:5173/app/board"), Navigate::Here);
        assert_eq!(navigation(&server, "about:blank"), Navigate::Here);
        assert_eq!(navigation(&server, "https://id.example.com/authorize?state=x"), Navigate::Here);
    }

    #[test]
    fn plain_http_elsewhere_and_mail_leave_for_the_browser() {
        let server = server();
        assert_eq!(navigation(&server, "http://127.0.0.1:9999/"), Navigate::Browser);
        assert_eq!(navigation(&server, "http://example.com/"), Navigate::Browser);
        assert_eq!(navigation(&server, "mailto:someone@example.test"), Navigate::Browser);
    }

    #[test]
    fn other_schemes_are_refused() {
        let server = server();
        for target in [
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "data:text/html,x",
            "not a url",
        ] {
            assert_eq!(navigation(&server, target), Navigate::Refuse, "{target}");
            assert_eq!(popup(&server, target, true), Popup::Refuse, "{target}");
        }
    }

    #[test]
    fn sign_in_popups_open_in_the_app_and_links_open_in_the_browser() {
        let server = server();
        assert_eq!(popup(&server, "about:blank", false), Popup::App);
        assert_eq!(popup(&server, "http://127.0.0.1:5173/app/artifacts/a1", false), Popup::App);
        assert_eq!(popup(&server, "https://id.example.com/authorize", true), Popup::App);
        assert_eq!(popup(&server, "https://docs.example.com/guide", false), Popup::Browser);
        assert_eq!(popup(&server, "http://id.example.com/authorize", true), Popup::Browser);
    }

    fn key(server: &str, account: &str) -> String {
        profile_key(&Url::parse(server).unwrap(), account).unwrap()
    }

    #[test]
    fn two_accounts_on_one_server_never_share_a_profile() {
        assert_ne!(key("https://rakazo.example.com", "user-a"), key("https://rakazo.example.com", "user-b"));
    }

    #[test]
    fn one_account_keeps_its_profile_at_every_spelling_of_its_server() {
        let canonical = key("https://rakazo.example.com", "user-a");
        assert_eq!(key("https://Rakazo.EXAMPLE.com:443/app/board?x=1", "user-a"), canonical);
        assert_eq!(key("https://rakazo.example.com/", "user-a"), canonical);
        assert_eq!(key("http://[::1]:8080", "user-a"), key("http://[0:0::1]:8080/app", "user-a"));
    }

    #[test]
    fn each_origin_has_its_own_profile() {
        let account = "user-a";
        let keys = [
            key("https://a.example.com", account),
            key("https://a.example.com:8443", account),
            key("http://a.example.com", account),
            key("http://[::1]:8080", account),
            key("http://127.0.0.1:8080", account),
        ];
        for (index, one) in keys.iter().enumerate() {
            assert!(keys[index + 1..].iter().all(|other| other != one), "{one}");
        }
    }

    #[test]
    fn a_profile_name_is_a_fixed_length_hash_without_the_server_or_account() {
        let name = key("https://rakazo.example.com", "user-a");
        assert_eq!(name.len(), 32);
        assert!(name.chars().all(|letter| letter.is_ascii_hexdigit()));
        assert!(!name.contains("rakazo") && !name.contains("user"));
    }

    #[test]
    fn no_profile_without_an_account_or_a_real_origin() {
        assert_eq!(profile_key(&server(), ""), None);
        assert_eq!(profile_key(&Url::parse("data:text/plain,x").unwrap(), "user-a"), None);
    }

    #[test]
    fn the_browser_gets_the_page_on_screen_or_the_workspace() {
        let server = server();
        assert_eq!(browser_target(&server, Some("http://127.0.0.1:5173/app/board")), "http://127.0.0.1:5173/app/board");
        assert_eq!(browser_target(&server, Some("about:blank")), "http://127.0.0.1:5173/app");
        assert_eq!(browser_target(&server, None), "http://127.0.0.1:5173/app");
        assert!(is_server(&server, "http://127.0.0.1:5173/app"));
        assert!(!is_server(&server, "https://id.example.com/"));
    }
}
