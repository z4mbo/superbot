//! Starts operator-approved T3 Code inbox requests in the operator's own T3 Code, over T3's
//! external MCP server and its public-client OAuth sign-in.
//! [T3 outside agents](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md)

mod endpoint;
mod error;
mod ledger;
mod mcp;
mod oauth;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use url::Url;

pub use endpoint::mcp_endpoint;
pub use error::T3Error;
pub use ledger::{Connection, Intent, Ledger, Plan};
pub use oauth::{begin_sign_in, PendingSignIn, CLIENT_NAME};

use ledger::digest;
use mcp::Session;

/// The bundled marketplace version the server seeds. Version IDs are issued by the server, so a
/// community submission can reuse the slug or name but never this ID.
pub const BUNDLED_VERSION_ID: &str = "superbot-t3-code-inbox-v1";
pub const SLUG: &str = "t3-code-inbox";
pub const MANIFEST: &str = include_str!("../../../examples/plugins/t3-coding/manifest.json");
pub const REQUESTS: &str = "requests";
pub const DISPATCHES: &str = "dispatches";

/// An MCP access token T3 issued to this app, and the endpoint it is for.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    pub url: String,
    pub token: String,
}

impl std::fmt::Debug for Grant {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Grant").field("url", &self.url).finish_non_exhaustive()
    }
}

impl Grant {
    fn connection(&self) -> Connection {
        Connection { url: self.url.clone(), grant: digest(&json!(self.token)) }
    }

    /// Where the grant points, as the operator would recognise it.
    pub fn place(&self) -> String {
        Url::parse(&self.url)
            .ok()
            .and_then(|url| {
                url.host_str().map(|host| url.port().map_or(host.to_owned(), |port| format!("{host}:{port}")))
            })
            .unwrap_or_default()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Project {
    pub id: String,
    pub title: String,
}

/// What T3 accepted, as saved to the inbox's Dispatches app.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct Receipt {
    pub request_id: String,
    pub thread_id: String,
    pub run_id: String,
    pub thread_link: String,
    pub status: String,
}

impl Receipt {
    pub fn from_values(values: &Map<String, Value>) -> Option<Self> {
        let receipt: Self = serde_json::from_value(Value::Object(values.clone())).ok()?;
        safe_link(&receipt.thread_link).then_some(receipt)
    }

    pub fn values(&self) -> Map<String, Value> {
        match serde_json::to_value(self) {
            Ok(Value::Object(values)) => values,
            _ => Map::new(),
        }
    }
}

/// One confirmed start: the record, its exact brief, and where it goes.
pub struct Start<'a> {
    pub server: &'a str,
    pub space: &'a str,
    pub installation: &'a str,
    pub record_id: &'a str,
    pub project_id: &'a str,
    pub title: &'a str,
    pub brief: &'a str,
}

#[derive(Debug)]
pub struct Started {
    pub plan: Plan,
    pub receipt: Receipt,
}

pub(crate) fn random_hex() -> Result<String, T3Error> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(T3Error::storage)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn operation_id() -> Result<String, T3Error> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(T3Error::storage)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]))
}

fn is_record_id(id: &str) -> bool {
    let groups: Vec<&str> = id.split('-').collect();
    groups.iter().map(|group| group.len()).eq([8, 4, 4, 4, 12])
        && groups.iter().all(|group| group.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

fn safe_link(link: &str) -> bool {
    Url::parse(link).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path().starts_with("/threads/")
    })
}

fn receipt_from(result: &Value, record_id: &str, project_id: &str) -> Result<Receipt, T3Error> {
    let text = |key: &str| result.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_owned);
    match (text("projectId"), text("threadId"), text("runId"), text("status"), text("link")) {
        (Some(launched), Some(thread_id), Some(run_id), Some(status), Some(link))
            if launched == project_id && safe_link(&link) =>
        {
            Ok(Receipt { request_id: record_id.to_owned(), thread_id, run_id, thread_link: link, status })
        }
        _ => Err(T3Error::Unexpected),
    }
}

async fn with_session<T>(
    grant: &Grant,
    work: impl AsyncFnOnce(&mut Session) -> Result<T, T3Error>,
) -> Result<T, T3Error> {
    let mut session = Session::open(grant).await?;
    let result = work(&mut session).await;
    session.close().await;
    result
}

/// Every project the grant can see, in T3's order.
pub async fn projects(grant: &Grant) -> Result<Vec<Project>, T3Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Page {
        projects: Vec<Project>,
        next_cursor: Option<Value>,
    }
    with_session(grant, async |session| {
        let mut found = Vec::new();
        let mut cursor: Option<Value> = None;
        for _ in 0..20 {
            let mut arguments = json!({ "limit": 50 });
            if let Some(cursor) = &cursor {
                arguments["cursor"] = cursor.clone();
            }
            let page: Page = serde_json::from_value(session.call("t3_project_list", arguments).await?)
                .map_err(|_| T3Error::Unexpected)?;
            found.extend(page.projects);
            match page.next_cursor.filter(|next| !next.is_null()) {
                Some(next) if Some(&next) == cursor.as_ref() => return Err(T3Error::Unexpected),
                Some(next) => cursor = Some(next),
                None => return Ok(found),
            }
        }
        Ok(found)
    })
    .await
}

/// Starts one confirmed request in T3, at most once. A repeat after a lost reply sends the same
/// `clientRequestId` on the same grant; a repeat after T3 answered replays the saved receipt
/// without calling T3. The returned plan's operation ID is the one to save the receipt with.
pub async fn start(ledger: &Ledger, grant: &Grant, start: &Start<'_>) -> Result<Started, T3Error> {
    let record_id = start.record_id.to_ascii_lowercase();
    if !is_record_id(&record_id) || start.title.trim().is_empty() || start.brief.trim().is_empty() {
        return Err(T3Error::Unexpected);
    }
    let key = Ledger::key(start.server, start.space, start.installation, &record_id);
    let intent =
        Intent { project_id: start.project_id.to_owned(), request: digest(&json!([start.title, start.brief])) };
    let mut plan = ledger.plan(&key)?;
    if plan.as_ref().is_some_and(|plan| plan.intent != intent) {
        return Err(T3Error::IntentConflict);
    }
    if let (Some(plan), Some(receipt)) = (plan.clone(), ledger.receipt(&key)?) {
        return Ok(Started { plan, receipt });
    }
    let connection = grant.connection();
    let proposed = Plan { intent: intent.clone(), connection: connection.clone(), operation_id: operation_id()? };
    let kept = ledger.keep_plan(&key, plan.take().as_ref().unwrap_or(&proposed))?;
    if kept.intent != intent {
        return Err(T3Error::IntentConflict);
    }
    if kept.connection != connection {
        return Err(T3Error::ConnectionConflict);
    }
    // No `modelSelection`: the thread runs on the model the operator chose for the project in T3.
    let launch = json!({
        "projectId": start.project_id,
        "title": start.title,
        "message": start.brief,
        "runtimeMode": "approval-required",
        "interactionMode": "default",
        "clientRequestId": kept.operation_id,
    });
    let result = with_session(grant, async |session| match session.call("t3_thread_launch", launch).await {
        Err(T3Error::Tool { needs_model: true, .. }) => Err(T3Error::NoDefaultModel),
        launched => launched,
    })
    .await?;
    let receipt = ledger.keep_receipt(&key, &receipt_from(&result, &record_id, start.project_id)?)?;
    Ok(Started { plan: kept, receipt })
}

const KEYCHAIN_SERVICE: &str = "com.superbot.t3-code-inbox";

/// The T3 grant for one Superbot account on this computer, kept in the system credential store.
pub struct GrantStore {
    account: String,
}

impl GrantStore {
    /// `superbot` is the Superbot origin and `user` the signed-in account, so another server or
    /// account on this computer never sees the grant.
    pub fn new(superbot: &str, user: &str) -> Self {
        Self { account: format!("{superbot} {user}") }
    }

    fn entry(account: &str) -> Result<keyring::Entry, T3Error> {
        if !cfg!(any(target_os = "windows", target_os = "macos", target_os = "linux")) {
            return Err(T3Error::Keychain("no system credential store on this platform".into()));
        }
        keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|error| T3Error::Keychain(error.to_string()))
    }

    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce(keyring::Entry) -> Result<T, T3Error> + Send + 'static,
    ) -> Result<T, T3Error> {
        let account = self.account.clone();
        tokio::task::spawn_blocking(move || work(Self::entry(&account)?))
            .await
            .map_err(|error| T3Error::Keychain(error.to_string()))?
    }

    pub async fn load(&self) -> Result<Option<Grant>, T3Error> {
        self.blocking(|entry| match entry.get_password() {
            Ok(saved) => {
                Ok(serde_json::from_str::<Grant>(&saved).ok().filter(|grant| mcp_endpoint(&grant.url).is_ok()))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(T3Error::Keychain(error.to_string())),
        })
        .await
    }

    pub async fn save(&self, grant: &Grant) -> Result<(), T3Error> {
        let saved = serde_json::to_string(grant).map_err(T3Error::storage)?;
        self.blocking(move |entry| entry.set_password(&saved).map_err(|error| T3Error::Keychain(error.to_string())))
            .await
    }

    pub async fn forget(&self) -> Result<(), T3Error> {
        self.blocking(|entry| match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(T3Error::Keychain(error.to_string())),
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{is_record_id, receipt_from, Grant, Receipt, MANIFEST};

    #[test]
    fn a_receipt_needs_the_chosen_project_and_a_plain_https_thread_link() {
        let launched = json!({
            "threadId": "thread-1", "runId": "run-1", "status": "preparing", "projectId": "project-demo",
            "link": "https://app.example.test/threads/env-1/thread-1",
        });
        let receipt = receipt_from(&launched, "r", "project-demo").unwrap();
        assert_eq!(
            json!(receipt.values()),
            json!({
                "request-id": "r", "thread-id": "thread-1", "run-id": "run-1",
                "thread-link": "https://app.example.test/threads/env-1/thread-1", "status": "preparing",
            })
        );
        assert_eq!(Receipt::from_values(&receipt.values()), Some(receipt));
        assert!(receipt_from(&launched, "r", "project-other").is_err());
        for link in [
            "http://app.example.test/threads/x",
            "https://app.example.test/threads/x?a=1",
            "https://u:p@app.example.test/threads/x",
            "https://app.example.test/x",
        ] {
            let mut changed = launched.clone();
            changed["link"] = json!(link);
            assert!(receipt_from(&changed, "r", "project-demo").is_err(), "{link}");
        }
    }

    #[test]
    fn record_ids_are_lowercase_uuids() {
        assert!(is_record_id("6f1c1a52-6a43-4d1e-9e43-9a1f3f0b2c11"));
        assert!(!is_record_id("6F1C1A52-6A43-4D1E-9E43-9A1F3F0B2C11"));
        assert!(!is_record_id("../../etc"));
    }

    #[test]
    fn a_grant_never_prints_its_token() {
        let grant = Grant { url: "http://127.0.0.1:3773/mcp".into(), token: "secret-token".into() };
        assert!(!format!("{grant:?}").contains("secret-token"));
        assert_eq!(grant.place(), "127.0.0.1:3773");
    }

    #[test]
    fn the_canonical_manifest_declares_requests_and_dispatches() {
        let manifest: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
        let parts: Vec<&str> =
            manifest["parts"].as_array().unwrap().iter().map(|part| part["id"].as_str().unwrap()).collect();
        assert_eq!(parts, ["requests", "dispatches", "request-guide"]);
    }
}
