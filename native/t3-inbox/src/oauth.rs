use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

use crate::endpoint::Http;
use crate::mcp::{initialize_request, post, Reply};
use crate::{Grant, T3Error};

pub const CLIENT_NAME: &str = "Superbot T3 Code inbox";
const SIGN_IN_WINDOW: Duration = Duration::from_secs(5 * 60);

#[derive(Deserialize)]
struct ResourceMetadata {
    resource: Option<String>,
    #[serde(default)]
    authorization_servers: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

#[derive(Deserialize)]
struct ServerMetadata {
    issuer: Option<String>,
    #[serde(default)]
    authorization_response_iss_parameter_supported: bool,
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
    #[serde(default)]
    code_challenge_methods_supported: Vec<String>,
}

#[derive(Deserialize)]
struct Registration {
    client_id: String,
}

#[derive(Deserialize)]
struct Tokens {
    access_token: String,
}

/// A sign-in waiting for the operator to approve it in T3.
pub struct PendingSignIn {
    http: Http,
    endpoint: Url,
    listener: TcpListener,
    redirect_uri: String,
    state: String,
    /// RFC 9207: the issuer the callback must name, and whether it must name one.
    issuer: String,
    issuer_required: bool,
    verifier: String,
    client_id: String,
    token_endpoint: Url,
    resource: String,
    pub authorization_url: Url,
}

fn random_text() -> Result<String, T3Error> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(T3Error::storage)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// The `resource_metadata` parameter of a Bearer challenge.
fn resource_metadata(challenge: &str) -> Option<&str> {
    let start = challenge.find("resource_metadata=")? + "resource_metadata=".len();
    let rest = &challenge[start..];
    match rest.strip_prefix('"') {
        Some(quoted) => quoted.split('"').next(),
        None => rest.split([',', ' ']).next(),
    }
}

/// RFC 8414 and OpenID discovery addresses for an issuer, path inserted after the well-known part.
fn server_metadata_urls(issuer: &Url) -> Vec<Url> {
    let path = issuer.path().trim_end_matches('/');
    let mut urls = Vec::new();
    for well_known in ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"] {
        if let Ok(url) = issuer.join(&format!("{well_known}{path}")) {
            urls.push(url);
        }
    }
    if !path.is_empty() {
        if let Ok(url) = issuer.join(&format!("{path}/.well-known/openid-configuration")) {
            urls.push(url);
        }
    }
    urls
}

async fn get_json<T: for<'de> Deserialize<'de>>(http: &Http, url: &Url) -> Result<Option<T>, T3Error> {
    let response = http.request(Method::GET, url)?.send().await.map_err(|_| http.unreachable())?;
    if !response.status().is_success() {
        return Ok(None);
    }
    Ok(response.json::<T>().await.ok())
}

/// Starts T3's public-client sign-in: discovers its authorization server on the same origin,
/// registers this app with a loopback redirect, and returns the page the operator approves.
pub async fn begin_sign_in(endpoint: &str) -> Result<PendingSignIn, T3Error> {
    let endpoint = crate::mcp_endpoint(endpoint)?;
    let http = Http::new(&endpoint)?;
    let challenge_header = match post(&http, &endpoint, None, None, &initialize_request(1)).await {
        Ok(Reply::Unauthorized { challenge }) => challenge,
        Ok(_) => return Err(T3Error::NoSignIn),
        Err(_) => return Err(http.unreachable()),
    };

    let mut metadata_urls = Vec::new();
    if let Some(found) = challenge_header.as_deref().and_then(resource_metadata) {
        metadata_urls.push(endpoint.join(found).map_err(|_| T3Error::Unexpected)?);
    }
    for path in ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"] {
        metadata_urls.push(endpoint.join(path).expect("a fixed path joins"));
    }
    let mut resource = None;
    for url in &metadata_urls {
        if let Some(found) = get_json::<ResourceMetadata>(&http, url).await? {
            resource = Some(found);
            break;
        }
    }
    let issuer = match resource.as_ref().and_then(|found| found.authorization_servers.first()) {
        Some(issuer) => Url::parse(issuer).map_err(|_| T3Error::Unexpected)?,
        None => endpoint.join("/").expect("the origin joins"),
    };
    http.same_origin(&issuer)?;

    let mut server = None;
    for url in server_metadata_urls(&issuer) {
        if let Some(found) = get_json::<ServerMetadata>(&http, &url).await? {
            server = Some(found);
            break;
        }
    }
    let server = server.ok_or(T3Error::SignInUnsupported)?;
    let issuer_name = server.issuer.clone().unwrap_or_else(|| issuer.as_str().trim_end_matches('/').to_owned());
    http.same_origin(&Url::parse(&issuer_name).map_err(|_| T3Error::Unexpected)?)?;
    if !server.code_challenge_methods_supported.is_empty()
        && !server.code_challenge_methods_supported.iter().any(|method| method == "S256")
    {
        return Err(T3Error::SignInUnsupported);
    }
    let authorization_endpoint = Url::parse(&server.authorization_endpoint).map_err(|_| T3Error::Unexpected)?;
    let token_endpoint = Url::parse(&server.token_endpoint).map_err(|_| T3Error::Unexpected)?;
    let registration_endpoint = Url::parse(server.registration_endpoint.as_deref().ok_or(T3Error::SignInUnsupported)?)
        .map_err(|_| T3Error::Unexpected)?;
    for url in [&authorization_endpoint, &token_endpoint, &registration_endpoint] {
        http.same_origin(url)?;
    }

    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(T3Error::storage)?;
    let port = listener.local_addr().map_err(T3Error::storage)?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let registration = http
        .request(Method::POST, &registration_endpoint)?
        .json(&json!({
            "client_name": CLIENT_NAME,
            "redirect_uris": [redirect_uri],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
        }))
        .send()
        .await
        .map_err(|_| http.unreachable())?;
    if !registration.status().is_success() {
        return Err(T3Error::SignInUnsupported);
    }
    let client_id = registration.json::<Registration>().await.map_err(|_| T3Error::Unexpected)?.client_id;

    let state = random_text()?;
    let verifier = random_text()?;
    let resource_id = resource
        .as_ref()
        .and_then(|found| found.resource.clone())
        .filter(|declared| Url::parse(declared).is_ok_and(|declared| declared.origin() == endpoint.origin()))
        .unwrap_or_else(|| endpoint.to_string());
    let mut authorization_url = authorization_endpoint;
    {
        let mut query = authorization_url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &client_id)
            .append_pair("code_challenge", &challenge(&verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("state", &state)
            .append_pair("resource", &resource_id);
        if let Some(found) = resource.as_ref().filter(|found| !found.scopes_supported.is_empty()) {
            query.append_pair("scope", &found.scopes_supported.join(" "));
        }
    }
    Ok(PendingSignIn {
        http,
        endpoint,
        listener,
        redirect_uri,
        state,
        issuer: issuer_name,
        issuer_required: server.authorization_response_iss_parameter_supported,
        verifier,
        client_id,
        token_endpoint,
        resource: resource_id,
        authorization_url,
    })
}

#[derive(Debug, PartialEq)]
enum Callback {
    Code(String),
    Denied,
    /// The response names another issuer, or none where T3 promised one: a mix-up.
    WrongIssuer,
    Other,
}

/// What a request to the loopback listener means for this sign-in.
fn callback_from(method: &str, target: &str, state: &str, issuer: &str, issuer_required: bool) -> Callback {
    let Some(url) = Url::parse("http://127.0.0.1").and_then(|base| base.join(target)).ok() else {
        return Callback::Other;
    };
    let param = |name: &str| url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned());
    if method != "GET" || url.path() != "/callback" || param("state").as_deref() != Some(state) {
        return Callback::Other;
    }
    match param("iss") {
        Some(named) if named.trim_end_matches('/') != issuer.trim_end_matches('/') => return Callback::WrongIssuer,
        None if issuer_required => return Callback::WrongIssuer,
        _ => {}
    }
    match param("code") {
        Some(code) if !code.is_empty() => Callback::Code(code),
        _ => Callback::Denied,
    }
}

async fn answer(stream: &mut TcpStream, state: &str, issuer: &str, issuer_required: bool) -> Callback {
    let mut buffer = vec![0u8; 8192];
    let mut read = 0;
    let line = loop {
        match tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buffer[read..])).await {
            Ok(Ok(0)) | Err(_) | Ok(Err(_)) => return Callback::Other,
            Ok(Ok(count)) => read += count,
        }
        if let Some(end) = buffer[..read].windows(2).position(|pair| pair == b"\r\n") {
            break String::from_utf8_lossy(&buffer[..end]).into_owned();
        }
        if read == buffer.len() {
            return Callback::Other;
        }
    };
    let mut parts = line.split(' ');
    let (method, target) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
    let callback = callback_from(method, target, state, issuer, issuer_required);
    let (status, text) = match callback {
        Callback::Code(_) => ("200 OK", "Signed in. Return to Superbot."),
        Callback::Denied | Callback::WrongIssuer => ("400 Bad Request", "Sign-in denied. Return to Superbot."),
        Callback::Other => ("404 Not Found", "Not found."),
    };
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
    let _ = stream.write_all(reply.as_bytes()).await;
    let _ = stream.shutdown().await;
    callback
}

impl PendingSignIn {
    /// Waits for T3 to send the operator back, then exchanges the code for an MCP token.
    pub async fn finish(self) -> Result<Grant, T3Error> {
        let wait = async {
            loop {
                let Ok((mut stream, _)) = self.listener.accept().await else { continue };
                match answer(&mut stream, &self.state, &self.issuer, self.issuer_required).await {
                    Callback::Code(code) => return Ok(code),
                    Callback::Denied => return Err(T3Error::SignInDenied),
                    Callback::WrongIssuer => return Err(T3Error::SignInRejected),
                    Callback::Other => continue,
                }
            }
        };
        let code = tokio::time::timeout(SIGN_IN_WINDOW, wait).await.map_err(|_| T3Error::SignInDenied)??;
        drop(self.listener);
        let response = self
            .http
            .request(Method::POST, &self.token_endpoint)?
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code.as_str()),
                ("code_verifier", self.verifier.as_str()),
                ("redirect_uri", self.redirect_uri.as_str()),
                ("client_id", self.client_id.as_str()),
                ("resource", self.resource.as_str()),
            ])
            .send()
            .await
            .map_err(|_| self.http.unreachable())?;
        if !response.status().is_success() {
            return Err(T3Error::SignInRejected);
        }
        let tokens: Value = response.json().await.map_err(|_| T3Error::SignInRejected)?;
        let tokens: Tokens = serde_json::from_value(tokens).map_err(|_| T3Error::SignInRejected)?;
        if tokens.access_token.is_empty() || tokens.access_token.bytes().any(|byte| byte.is_ascii_whitespace()) {
            return Err(T3Error::SignInRejected);
        }
        Ok(Grant { url: self.endpoint.to_string(), token: tokens.access_token })
    }
}

#[cfg(test)]
mod tests {
    use url::Url;

    use super::{callback_from, challenge, resource_metadata, server_metadata_urls, Callback};

    #[test]
    fn the_callback_must_name_the_discovered_issuer() {
        let issuer = "http://127.0.0.1:3773";
        let back = |query: &str, required| callback_from("GET", &format!("/callback?{query}"), "s1", issuer, required);
        let code = Callback::Code("c1".into());
        assert_eq!(back("code=c1&state=s1&iss=http%3A%2F%2F127.0.0.1%3A3773", true), code);
        assert_eq!(back("code=c1&state=s1", false), code);
        assert_eq!(back("code=c1&state=s1", true), Callback::WrongIssuer);
        assert_eq!(back("code=c1&state=s1&iss=https%3A%2F%2Fevil.example", false), Callback::WrongIssuer);
        assert_eq!(back("error=access_denied&state=s1&iss=http%3A%2F%2F127.0.0.1%3A3773", true), Callback::Denied);
        assert_eq!(back("code=c1&state=other", true), Callback::Other);
        assert_eq!(callback_from("POST", "/callback?code=c1&state=s1", "s1", issuer, false), Callback::Other);
    }

    #[test]
    fn the_pkce_challenge_is_the_rfc_7636_example() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn the_resource_metadata_address_is_read_from_the_challenge() {
        assert_eq!(
            resource_metadata(
                r#"Bearer error="invalid_token", resource_metadata="http://127.0.0.1:3773/.well-known/oauth-protected-resource/mcp""#
            ),
            Some("http://127.0.0.1:3773/.well-known/oauth-protected-resource/mcp")
        );
        assert_eq!(resource_metadata("Bearer realm=t3"), None);
    }

    #[test]
    fn issuer_paths_go_after_the_well_known_segment() {
        let root = server_metadata_urls(&Url::parse("https://t3.example.com/").unwrap());
        assert_eq!(root[0].as_str(), "https://t3.example.com/.well-known/oauth-authorization-server");
        let tenant = server_metadata_urls(&Url::parse("https://t3.example.com/oauth").unwrap());
        assert_eq!(tenant[0].as_str(), "https://t3.example.com/.well-known/oauth-authorization-server/oauth");
        assert_eq!(tenant[2].as_str(), "https://t3.example.com/oauth/.well-known/openid-configuration");
    }
}
