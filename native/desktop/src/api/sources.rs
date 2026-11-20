use serde::Deserialize;
use serde_json::{json, Value};
use superbot_client::Error;
use url::Url;

use super::Api;

/// The stable code the server answers with when an authorization server cannot register a
/// client by itself, so the person has to enter one.
pub const OAUTH_CLIENT_REQUIRED: &str = "MCP_OAUTH_CLIENT_REQUIRED";

/// A service the server offers to connect to directly, without its integration provider.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourcePreset {
    pub id: String,
    pub name: String,
    /// The fixed endpoint; absent when the person enters their own.
    #[serde(default)]
    pub url: Option<String>,
    /// The endpoint offered for the person to keep or change when `url` is absent.
    #[serde(default)]
    pub default_url: Option<String>,
    #[serde(default)]
    pub url_placeholder: Option<String>,
    /// The service signs the person in on its own page. Otherwise it takes a bearer token.
    #[serde(default)]
    pub sign_in: bool,
    /// The provider's instructions for registering an OAuth client for this service.
    #[serde(default)]
    pub oauth_setup_url: Option<String>,
}

impl SourcePreset {
    pub fn endpoint(&self) -> Option<&str> {
        self.url.as_deref().or(self.default_url.as_deref())
    }
}

/// A tool source the person added with a credential the server keeps encrypted.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceInstall {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub source: String,
    #[serde(default)]
    pub config: Value,
}

impl SourceInstall {
    pub fn preset(&self) -> Option<&str> {
        self.config.get("preset").and_then(Value::as_str)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OAuthStatus {
    None,
    Connected,
    Reconnect,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Unknown,
    Installing,
    Ok,
    Error,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub status: HealthStatus,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
}

/// A remote MCP server the person added, as `mcp.servers.list` returns it.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub install_id: Option<String>,
    pub oauth_status: OAuthStatus,
    #[serde(default)]
    pub oauth_client_id: Option<String>,
    pub health: Health,
    pub enabled: bool,
    /// Every agent may use it; when false only the agents assigned to it.
    #[serde(default)]
    pub all_bots: Option<bool>,
}

/// The one state a saved server shows, as every other client derives it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServerState {
    Disabled,
    NeedsClient,
    NeedsSignIn,
    NotWorking,
    Connected,
    NotConnected,
}

impl McpServer {
    pub fn state(&self) -> ServerState {
        if !self.enabled {
            ServerState::Disabled
        } else if self.health.code.as_deref() == Some(OAUTH_CLIENT_REQUIRED) && self.oauth_client_id.is_none() {
            ServerState::NeedsClient
        } else if self.oauth_status == OAuthStatus::Reconnect {
            ServerState::NeedsSignIn
        } else if self.health.status == HealthStatus::Error {
            ServerState::NotWorking
        } else if self.oauth_status == OAuthStatus::Connected || self.health.status == HealthStatus::Ok {
            ServerState::Connected
        } else {
            ServerState::NotConnected
        }
    }

    pub fn serves(&self, endpoint: &str) -> bool {
        self.endpoint.as_deref().is_some_and(|own| same_endpoint(own, endpoint))
    }
}

/// The same address in another spelling ("https://host/" for "https://host") is the same endpoint.
pub fn same_endpoint(left: &str, right: &str) -> bool {
    match (Url::parse(left), Url::parse(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    pub bot_id: String,
    pub server_id: String,
}

/// A sign-in the server started: the page to open, or nothing to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignInStart {
    Open { session_id: String, authorization_url: String },
    Connected,
    NotRequested,
}

impl<'de> Deserialize<'de> for SignInStart {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            status: String,
            session_id: Option<String>,
            authorization_url: Option<String>,
        }
        let wire = Wire::deserialize(deserializer)?;
        Ok(match (wire.status.as_str(), wire.session_id, wire.authorization_url) {
            ("authorization_required", Some(session_id), Some(authorization_url)) => {
                Self::Open { session_id, authorization_url }
            }
            ("already_connected", ..) => Self::Connected,
            ("authorization_not_requested", ..) => Self::NotRequested,
            _ => return Err(serde::de::Error::custom("unknown sign-in status")),
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub sign_in: SignInStart,
}

impl Api {
    pub async fn source_presets(&self, space_id: &str) -> Result<Vec<SourcePreset>, Error> {
        self.client.rpc("capabilities/sourcePresets", Some(space_id), json!({})).await
    }

    /// The MCP tool sources the person added, without plugins, skills and API sources.
    pub async fn mcp_sources(&self, space_id: &str) -> Result<Vec<SourceInstall>, Error> {
        let installs: Vec<SourceInstall> = self.client.rpc("capabilities/list", Some(space_id), json!({})).await?;
        Ok(installs.into_iter().filter(|install| install.kind == "mcp").collect())
    }

    /// Adds a token preset. The server checks the token against the service before storing it
    /// encrypted; it is never returned.
    pub async fn install_preset(
        &self,
        space_id: &str,
        preset: &SourcePreset,
        endpoint: &str,
        credential: String,
    ) -> Result<SourceInstall, Error> {
        let input = json!({
            "kind": "mcp",
            "name": preset.name,
            "source": endpoint,
            "config": { "preset": preset.id },
            "credential": credential,
        });
        self.client.rpc("capabilities/install", Some(space_id), input).await
    }

    pub async fn remove_source(&self, space_id: &str, install_id: &str) -> Result<(), Error> {
        self.done("capabilities/remove", space_id, json!({ "id": install_id })).await
    }

    pub async fn mcp_servers(&self, space_id: &str) -> Result<Vec<McpServer>, Error> {
        self.client.rpc("mcp/servers/list", Some(space_id), json!({})).await
    }

    pub async fn mcp_assignments(&self, space_id: &str) -> Result<Vec<Assignment>, Error> {
        self.client.rpc("mcp/assignments/all", Some(space_id), json!({})).await
    }

    /// Adds the server at `endpoint`, or reuses the one already added, and starts its sign-in on
    /// the server's own callback. The sign-in window reads the code from a loopback return too.
    pub async fn connect_mcp(&self, space_id: &str, name: &str, endpoint: &str) -> Result<Connected, Error> {
        let input = json!({ "name": name, "endpoint": endpoint, "capturesLoopback": true });
        self.client.rpc("mcp/servers/connect", Some(space_id), input).await
    }

    pub async fn begin_mcp_sign_in(&self, space_id: &str, server_id: &str) -> Result<SignInStart, Error> {
        let input = json!({ "serverId": server_id, "capturesLoopback": true });
        self.client.rpc("mcp/oauth/begin", Some(space_id), input).await
    }

    pub async fn complete_mcp_sign_in(&self, space_id: &str, session_id: &str, code: &str) -> Result<(), Error> {
        let input = json!({ "sessionId": session_id, "code": code, "state": session_id });
        self.done("mcp/oauth/complete", space_id, input).await
    }

    /// Saves a client the person registered with the service's authorization server.
    pub async fn set_mcp_oauth_client(
        &self,
        space_id: &str,
        server: &McpServer,
        endpoint: &str,
        client_id: String,
        client_secret: Option<String>,
    ) -> Result<McpServer, Error> {
        let mut client = json!({ "clientId": client_id });
        if let Some(secret) = client_secret {
            client["clientSecret"] = json!(secret);
        }
        let input = json!({
            "id": server.id,
            "config": {
                "slug": server.slug,
                "name": server.name,
                "transport": "streamable_http",
                "endpoint": endpoint,
                "oauthClient": client,
            },
        });
        self.client.rpc("mcp/servers/update", Some(space_id), input).await
    }

    /// Reaches the server once and records how it answered.
    pub async fn check_mcp_server(&self, space_id: &str, server_id: &str) -> Result<McpServer, Error> {
        self.client.rpc("mcp/servers/test", Some(space_id), json!({ "id": server_id })).await
    }

    pub async fn remove_mcp_server(&self, space_id: &str, server_id: &str) -> Result<(), Error> {
        self.done("mcp/servers/remove", space_id, json!({ "id": server_id })).await
    }

    /// Which agents may use the server: all of them, or only `bot_ids`.
    pub async fn set_mcp_agents(
        &self,
        space_id: &str,
        server_id: &str,
        all_bots: bool,
        bot_ids: &[String],
    ) -> Result<(), Error> {
        let input = json!({ "id": server_id, "allBots": all_bots, "botIds": bot_ids });
        self.done("mcp/servers/agents", space_id, input).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(health: Value, oauth: &str, client: Option<&str>) -> McpServer {
        serde_json::from_value(json!({
            "id": "s1", "slug": "integration-1", "name": "Service", "endpoint": "https://mcp.example.test/mcp",
            "oauthStatus": oauth, "oauthClientId": client, "health": health, "enabled": true,
            "spaceId": "space", "transport": "streamable_http", "hasArgs": false, "envKeys": [],
        }))
        .unwrap()
    }

    #[test]
    fn a_server_reads_as_every_client_shows_it() {
        let unknown = json!({ "status": "unknown", "message": null, "toolCount": null, "checkedAt": null });
        let needs_client = json!({ "status": "error", "message": "x", "code": OAUTH_CLIENT_REQUIRED });
        assert_eq!(server(unknown.clone(), "none", None).state(), ServerState::NotConnected);
        assert_eq!(server(unknown.clone(), "connected", None).state(), ServerState::Connected);
        assert_eq!(server(unknown, "reconnect", None).state(), ServerState::NeedsSignIn);
        assert_eq!(server(needs_client.clone(), "none", None).state(), ServerState::NeedsClient);
        assert_eq!(server(needs_client, "none", Some("client")).state(), ServerState::NotWorking);
    }

    #[test]
    fn an_endpoint_matches_in_any_spelling_of_the_same_address() {
        assert!(same_endpoint("https://MCP.example.test", "https://mcp.example.test/"));
        assert!(!same_endpoint("https://mcp.example.test/mcp", "https://mcp.example.test/sse"));
    }

    #[test]
    fn a_sign_in_start_reads_each_status() {
        let open: SignInStart = serde_json::from_value(json!({
            "status": "authorization_required", "sessionId": "s", "authorizationUrl": "https://id.example.test/a",
        }))
        .unwrap();
        assert_eq!(open, SignInStart::Open { session_id: "s".into(), authorization_url: "https://id.example.test/a".into() });
        let done: SignInStart = serde_json::from_value(json!({ "status": "already_connected" })).unwrap();
        assert_eq!(done, SignInStart::Connected);
    }
}
