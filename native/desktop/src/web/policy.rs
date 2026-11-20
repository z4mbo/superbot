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

/// The address a sign-in returns to and the state that marks it as this sign-in, both read from
/// the authorization request the server built.
#[derive(Clone, Debug)]
pub struct Return {
    redirect: Url,
    state: String,
}

impl Return {
    pub fn from_authorization(authorization_url: &str) -> Option<Self> {
        let url = Url::parse(authorization_url).ok()?;
        let query = |name: &str| url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned());
        let redirect = Url::parse(&query("redirect_uri")?).ok()?;
        let state = query("state").filter(|state| !state.is_empty())?;
        matches!(redirect.scheme(), "http" | "https").then_some(Self { redirect, state })
    }

    pub fn redirect(&self) -> &Url {
        &self.redirect
    }
}

/// Where a navigation inside a sign-in window goes.
#[derive(Debug, PartialEq, Eq)]
pub enum SignInStep {
    Here,
    /// The provider sent this sign-in back. The page itself is never loaded.
    Returned(super::Returned),
    Browser,
    Refuse,
}

pub fn sign_in_navigation(expected: &Return, target: &str) -> SignInStep {
    let Ok(target) = Url::parse(target) else { return SignInStep::Refuse };
    if target.origin() == expected.redirect.origin() && target.path() == expected.redirect.path() {
        let query = |name: &str| target.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned());
        if query("state").as_deref() != Some(expected.state.as_str()) {
            return SignInStep::Refuse;
        }
        return SignInStep::Returned(match query("code").filter(|code| !code.is_empty()) {
            Some(code) => super::Returned::Code(code),
            None => super::Returned::Refused(query("error_description").or_else(|| query("error"))),
        });
    }
    match target.scheme() {
        "about" if target.as_str() == "about:blank" => SignInStep::Here,
        "https" => SignInStep::Here,
        // RFC 8252 sign-ins and a provider running on this machine answer on loopback.
        "http" if is_loopback(&target) => SignInStep::Here,
        "http" | "mailto" => SignInStep::Browser,
        _ => SignInStep::Refuse,
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
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

    fn sign_in() -> Return {
        Return::from_authorization(
            "https://id.example.test/authorize?client_id=c&redirect_uri=https%3A%2F%2Fapp.example.test%2Fmcp%2Foauth%2Fcallback&state=s1",
        )
        .unwrap()
    }

    #[test]
    fn a_sign_in_return_is_read_from_the_authorization_request() {
        assert_eq!(sign_in().redirect().as_str(), "https://app.example.test/mcp/oauth/callback");
        assert!(Return::from_authorization("https://id.example.test/authorize?state=s1").is_none());
        assert!(Return::from_authorization("https://id.example.test/authorize?redirect_uri=https%3A%2F%2Fa.test%2Fcb").is_none());
        assert!(Return::from_authorization("https://id.example.test/a?redirect_uri=rakazo%3A%2F%2Fx&state=s").is_none());
    }

    #[test]
    fn the_providers_return_is_taken_before_its_page_loads() {
        let expected = sign_in();
        assert_eq!(
            sign_in_navigation(&expected, "https://app.example.test/mcp/oauth/callback?code=abc&state=s1"),
            SignInStep::Returned(super::super::Returned::Code("abc".into()))
        );
        assert_eq!(
            sign_in_navigation(&expected, "https://app.example.test/mcp/oauth/callback?error=access_denied&state=s1"),
            SignInStep::Returned(super::super::Returned::Refused(Some("access_denied".into())))
        );
    }

    #[test]
    fn a_return_for_another_sign_in_is_refused() {
        let expected = sign_in();
        for target in [
            "https://app.example.test/mcp/oauth/callback?code=abc&state=other",
            "https://app.example.test/mcp/oauth/callback?code=abc",
        ] {
            assert_eq!(sign_in_navigation(&expected, target), SignInStep::Refuse, "{target}");
        }
    }

    #[test]
    fn a_sign_in_window_stays_on_https_and_loopback_pages() {
        let expected = sign_in();
        assert_eq!(sign_in_navigation(&expected, "https://id.example.test/consent"), SignInStep::Here);
        assert_eq!(sign_in_navigation(&expected, "https://app.example.test/app"), SignInStep::Here);
        assert_eq!(sign_in_navigation(&expected, "http://127.0.0.1:8765/authorize"), SignInStep::Here);
        assert_eq!(sign_in_navigation(&expected, "http://localhost:8765/authorize"), SignInStep::Here);
        assert_eq!(sign_in_navigation(&expected, "http://id.example.test/"), SignInStep::Browser);
        assert_eq!(sign_in_navigation(&expected, "javascript:alert(1)"), SignInStep::Refuse);
        assert_eq!(sign_in_navigation(&expected, "file:///C:/Windows/win.ini"), SignInStep::Refuse);
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
