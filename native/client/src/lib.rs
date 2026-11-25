mod conversations;
mod credentials;
mod local_history;
pub use conversations::{BotConversation, BotConversationPatch};
mod protocol;
mod server_selection;

use std::pin::Pin;
use std::time::{Duration, SystemTime};

use eventsource_stream::Eventsource;
use futures_util::{Stream, StreamExt};
use reqwest::{header, Method, Response, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

pub use credentials::{CredentialStore, SavedSession};
pub use local_history::LocalHistoryReceipt;
pub use protocol::{
    Agent, Error, Message, MessageAuthor, SendReceipt, Space, ThreadEvent, ThreadSnapshot,
    ThreadTarget, SERVER_UNREACHABLE,
};
pub use server_selection::{
    remember_server, remember_sign_in_server, selected_server, settings_directory,
};
pub use server_selection::{remember_space, remembered_space};

pub const DEFAULT_SERVER: &str = "http://127.0.0.1:5173";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(65);

pub type EventStream = Pin<Box<dyn Stream<Item = Result<ThreadEvent, Error>> + Send>>;
pub type NotificationStream = Pin<Box<dyn Stream<Item = Result<SpaceNotification, Error>> + Send>>;
pub type RpcStream<T> = Pin<Box<dyn Stream<Item = Result<T, Error>> + Send>>;

/// Content-free hints to read the selected Space with normal authorized RPCs.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SpaceNotification {
    Roster,
    Runs,
    Organizations,
    PluginRegistry,
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct NotificationFrame {
    #[serde(rename = "type")]
    kind: SpaceNotification,
}

#[derive(Deserialize)]
struct SpaceList {
    spaces: Vec<Space>,
}

pub enum SignUpResult {
    SignedIn(Client),
    VerifyEmail,
}

#[derive(Clone)]
pub struct Client {
    server: Url,
    http: reqwest::Client,
    authorization: Option<header::HeaderValue>,
}

fn server_origin(server: &str) -> Result<(Url, bool), Error> {
    let server = Url::parse(server).map_err(|_| Error::InvalidServer)?;
    let loopback = match server.host() {
        Some(url_host) => match url_host.to_string().as_str() {
            "localhost" => true,
            host => host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback()),
        },
        None => false,
    };
    if (server.scheme() != "https" && !(server.scheme() == "http" && loopback))
        || server.host().is_none()
        || !server.username().is_empty()
        || server.password().is_some()
        || server.query().is_some()
        || server.fragment().is_some()
        || server.path() != "/"
    {
        return Err(Error::InvalidServer);
    }
    Ok((server, loopback))
}

impl Client {
    /// Accepts an HTTPS origin, or HTTP on loopback for local Superbot deployments.
    pub fn new(server: &str) -> Result<Self, Error> {
        let (server, loopback) = server_origin(server)?;
        let mut http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(STREAM_IDLE_TIMEOUT)
            .user_agent(concat!("superbot-client/", env!("CARGO_PKG_VERSION")));
        if loopback {
            http = http.no_proxy();
        }
        Ok(Self {
            server,
            http: http.build().map_err(Error::transport)?,
            authorization: None,
        })
    }

    pub fn server(&self) -> &str {
        self.server.as_str()
    }

    /// Attaches the signed session returned by Superbot's native auth API.
    pub fn with_token(&self, token: &str) -> Result<Self, Error> {
        let Some((session, signature)) = token.split_once('.') else {
            return Err(Error::InvalidSession);
        };
        if session.is_empty()
            || signature.is_empty()
            || token.bytes().any(|c| c.is_ascii_whitespace())
        {
            return Err(Error::InvalidSession);
        }
        let mut value = header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| Error::InvalidSession)?;
        value.set_sensitive(true);
        Ok(Self {
            authorization: Some(value),
            ..self.clone()
        })
    }

    pub async fn sign_in(&self, email: &str, password: &str) -> Result<Self, Error> {
        self.authenticate(
            "sign-in/email",
            json!({ "email": email, "password": password }),
        )
        .await
    }

    pub async fn sign_up(
        &self,
        name: &str,
        email: &str,
        password: &str,
    ) -> Result<SignUpResult, Error> {
        let input = json!({ "name": name, "email": email, "password": password });
        let response = self.auth("sign-up/email", input, false).await?;
        if let Some(token) = Self::signed_token(&response) {
            return self.with_token(token).map(SignUpResult::SignedIn);
        }
        let body: Value = response.json().await.map_err(Error::transport)?;
        if body.get("token") == Some(&Value::Null) {
            return Ok(SignUpResult::VerifyEmail);
        }
        Err(Error::InvalidSession)
    }

    pub async fn request_sign_in_code(&self, email: &str) -> Result<(), Error> {
        self.auth(
            "email-otp/send-verification-otp",
            json!({ "email": email, "type": "sign-in" }),
            false,
        )
        .await?;
        Ok(())
    }

    pub async fn sign_in_with_code(&self, email: &str, code: &str) -> Result<Self, Error> {
        self.authenticate("sign-in/email-otp", json!({ "email": email, "otp": code }))
            .await
    }

    async fn authenticate(&self, path: &str, input: Value) -> Result<Self, Error> {
        let response = self.auth(path, input, false).await?;
        self.with_token(Self::signed_token(&response).ok_or(Error::InvalidSession)?)
    }

    fn signed_token(response: &Response) -> Option<&str> {
        response
            .headers()
            .get("set-auth-token")
            .and_then(|value| value.to_str().ok())
            .or_else(|| {
                response
                    .headers()
                    .get_all(header::SET_COOKIE)
                    .iter()
                    .find_map(|value| {
                        let (name, value) =
                            value.to_str().ok()?.split(';').next()?.split_once('=')?;
                        matches!(
                            name,
                            "better-auth.session_token" | "__Secure-better-auth.session_token"
                        )
                        .then_some(value)
                    })
            })
    }

    pub async fn sign_out(&self) -> Result<(), Error> {
        self.auth("sign-out", json!({}), true).await?;
        Ok(())
    }

    async fn auth(&self, path: &str, input: Value, authenticated: bool) -> Result<Response, Error> {
        let mut request = self
            .request(&format!("api/auth/{path}"))
            .header(header::ORIGIN, "rakazo://")
            .timeout(REQUEST_TIMEOUT)
            .json(&input);
        if authenticated {
            request = request.header(header::AUTHORIZATION, self.authorization()?);
        }
        checked(request.send().await.map_err(Error::transport)?).await
    }

    pub async fn list_spaces(&self) -> Result<Vec<Space>, Error> {
        let navigation: SpaceList = self.rpc("spaces/list", None, json!({})).await?;
        self.include_other_spaces(None, navigation.spaces).await
    }

    /// Adds the member's accessible Spaces from organizations outside the selected navigation.
    pub async fn include_other_spaces(
        &self,
        current_space: Option<&str>,
        mut spaces: Vec<Space>,
    ) -> Result<Vec<Space>, Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Organizations {
            active_organization_id: String,
            organizations: Vec<Organization>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Organization {
            id: String,
            default_space_id: String,
            space_ids: Vec<String>,
        }

        let organizations: Organizations = match self
            .rpc("organizations/list", current_space, json!({}))
            .await
        {
            Ok(organizations) => organizations,
            Err(Error::Server { status: 404, .. }) => return Ok(spaces),
            Err(error) => return Err(error),
        };
        let mut seen: std::collections::HashSet<_> =
            spaces.iter().map(|space| space.id.clone()).collect();
        let other_defaults = organizations.organizations.iter().filter(|organization| {
            organization.id != organizations.active_organization_id
                && organization
                    .space_ids
                    .contains(&organization.default_space_id)
        });
        for organization in other_defaults {
            let other: SpaceList = self
                .rpc(
                    "spaces/list",
                    Some(&organization.default_space_id),
                    json!({}),
                )
                .await?;
            spaces.extend(
                other
                    .spaces
                    .into_iter()
                    .filter(|space| seen.insert(space.id.clone())),
            );
        }
        Ok(spaces)
    }

    pub async fn list_agents(&self, space_id: &str) -> Result<Vec<Agent>, Error> {
        self.rpc("bots/list", Some(space_id), json!({})).await
    }

    pub async fn thread(&self, space_id: &str, agent_id: &str) -> Result<ThreadSnapshot, Error> {
        self.rpc("threads/get", Some(space_id), json!({ "botId": agent_id }))
            .await
    }

    pub async fn messages(&self, space_id: &str, agent_id: &str) -> Result<Vec<Message>, Error> {
        #[derive(Deserialize)]
        struct Page {
            messages: Vec<Message>,
        }
        let page: Page = self
            .rpc(
                "threads/messages",
                Some(space_id),
                json!({ "botId": agent_id }),
            )
            .await?;
        Ok(page.messages)
    }

    pub async fn send_message(
        &self,
        space_id: &str,
        agent_id: &str,
        text: &str,
    ) -> Result<SendReceipt, Error> {
        self.send_with_nonce(space_id, agent_id, text, &Uuid::new_v4().to_string())
            .await
    }

    /// Reuse the same nonce and text when retrying a send with an unknown outcome.
    pub async fn send_with_nonce(
        &self,
        space_id: &str,
        agent_id: &str,
        text: &str,
        nonce: &str,
    ) -> Result<SendReceipt, Error> {
        if text.trim().is_empty() || text.encode_utf16().count() > 100_000 {
            return Err(Error::InvalidMessage);
        }
        self.rpc(
            "threads/send",
            Some(space_id),
            json!({ "botId": agent_id, "text": text, "clientNonce": nonce }),
        )
        .await
    }

    /// Replays events strictly after a thread sequence number, then follows live events.
    /// A caller can reconnect using the last non-heartbeat sequence it consumed.
    pub async fn subscribe(
        &self,
        space_id: &str,
        agent_id: &str,
        cursor: i64,
    ) -> Result<EventStream, Error> {
        self.subscribe_thread(space_id, ThreadTarget::Bot(agent_id), cursor)
            .await
    }

    pub async fn subscribe_thread(
        &self,
        space_id: &str,
        target: ThreadTarget<'_>,
        cursor: i64,
    ) -> Result<EventStream, Error> {
        #[derive(Serialize)]
        struct Subscription<'a> {
            #[serde(flatten)]
            target: ThreadTarget<'a>,
            cursor: i64,
        }
        self.subscribe_rpc(
            "threads/subscribe",
            space_id,
            json!(Subscription { target, cursor }),
        )
        .await
    }

    /// Follows account and Space change hints. The server sends catch-up hints on connection.
    pub async fn subscribe_notifications(
        &self,
        space_id: &str,
    ) -> Result<NotificationStream, Error> {
        let events = self
            .subscribe_rpc::<NotificationFrame>("notifications/subscribe", space_id, json!({}))
            .await?;
        Ok(Box::pin(events.filter_map(|event| async {
            match event {
                Ok(NotificationFrame {
                    kind: SpaceNotification::Other,
                }) => None,
                result => Some(result.map(|frame| frame.kind)),
            }
        })))
    }

    /// Opens a Space-scoped oRPC event iterator and yields each event's JSON payload as `T`.
    /// The stream ends when the server closes it; the caller decides whether to reconnect.
    pub async fn subscribe_rpc<T: DeserializeOwned + Send + 'static>(
        &self,
        procedure: &str,
        space_id: &str,
        input: Value,
    ) -> Result<RpcStream<T>, Error> {
        let response = checked(
            self.rpc_request(procedure, Some(space_id), input)?
                .header(header::ACCEPT, "text/event-stream")
                .send()
                .await
                .map_err(Error::transport)?,
        )
        .await?;
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok());
        if !content_type.is_some_and(|value| value.split(';').next() == Some("text/event-stream")) {
            return Err(Error::Protocol("expected a Superbot event stream"));
        }
        Ok(Box::pin(async_stream::try_stream! {
            let mut events = response.bytes_stream().eventsource();
            while let Some(event) = events.next().await {
                let event = match event {
                    Ok(event) => event,
                    Err(eventsource_stream::EventStreamError::Transport(error)) => {
                        Err(Error::transport(error))?
                    }
                    Err(_) => Err(Error::Protocol("invalid event stream"))?,
                };
                match event.event.as_str() {
                    "message" => yield serde_json::from_str::<Envelope<T>>(&event.data)
                        .map_err(|_| Error::Protocol("invalid event payload"))?.json,
                    "error" => Err(Error::server(500, serde_json::from_str(&event.data).unwrap_or_default()))?,
                    "done" => break,
                    _ => {}
                }
            }
        }))
    }

    fn authorization(&self) -> Result<&header::HeaderValue, Error> {
        self.authorization.as_ref().ok_or(Error::MissingSession)
    }

    fn request(&self, path: &str) -> reqwest::RequestBuilder {
        let mut url = self.server.clone();
        url.set_path(path);
        self.http.request(Method::POST, url)
    }

    fn rpc_request(
        &self,
        path: &str,
        space: Option<&str>,
        input: Value,
    ) -> Result<reqwest::RequestBuilder, Error> {
        if !path.split('/').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        }) {
            return Err(Error::Protocol("invalid RPC procedure path"));
        }
        let mut request = self
            .request(&format!("rpc/{path}"))
            .header(header::AUTHORIZATION, self.authorization()?)
            .json(&json!({ "json": input }));
        if let Some(space) = space {
            request = request.header("x-rakazo-space-id", space);
        }
        Ok(request)
    }

    /// Calls an authenticated Superbot oRPC procedure with a JSON input.
    pub async fn rpc<T: DeserializeOwned>(
        &self,
        path: &str,
        space: Option<&str>,
        input: Value,
    ) -> Result<T, Error> {
        let response = checked(
            self.rpc_request(path, space, input)?
                .timeout(REQUEST_TIMEOUT)
                .send()
                .await
                .map_err(Error::transport)?,
        )
        .await?;
        let envelope: Envelope<T> = response.json().await.map_err(|error| {
            if error.is_decode() {
                Error::Protocol("invalid RPC response")
            } else {
                Error::transport(error)
            }
        })?;
        Ok(envelope.json)
    }
}

#[derive(Deserialize)]
struct Envelope<T> {
    json: T,
}

async fn checked(response: Response) -> Result<Response, Error> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    if (502..=504).contains(&status) {
        let retry_after = response
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| protocol::retry_after(value, SystemTime::now()));
        return Err(Error::Unavailable { retry_after });
    }
    let payload = tokio::time::timeout(REQUEST_TIMEOUT, response.json::<Value>()).await;
    Err(Error::server(
        status,
        payload.ok().and_then(Result::ok).unwrap_or_default(),
    ))
}
