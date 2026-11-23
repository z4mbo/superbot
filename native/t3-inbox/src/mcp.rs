use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, WWW_AUTHENTICATE};
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use url::Url;

use crate::endpoint::Http;
use crate::{Grant, T3Error};

/// MCP revision 2025-06-18, Streamable HTTP transport.
const PROTOCOL: &str = "2025-06-18";
const SESSION_HEADER: &str = "mcp-session-id";
const PROTOCOL_HEADER: &str = "mcp-protocol-version";
const MAX_REPLY: usize = 4 << 20;

pub(crate) enum Reply {
    Message {
        message: Value,
        session: Option<String>,
    },
    Accepted,
    Unauthorized {
        challenge: Option<String>,
    },
    /// Any other HTTP failure. A 5xx after a call went out may mean T3 ran it.
    Status(u16),
}

pub(crate) fn initialize_request(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL,
            "capabilities": {},
            "clientInfo": { "name": "superbot-t3-inbox", "version": env!("CARGO_PKG_VERSION") },
        },
    })
}

pub(crate) async fn post(
    http: &Http,
    url: &Url,
    authorization: Option<&HeaderValue>,
    session: Option<&str>,
    body: &Value,
) -> Result<Reply, reqwest::Error> {
    let mut request = http
        .request(Method::POST, url)
        .expect("the endpoint is the configured origin")
        .header(ACCEPT, "application/json, text/event-stream")
        .header(CONTENT_TYPE, "application/json")
        .json(body);
    if let Some(value) = authorization {
        request = request.header(AUTHORIZATION, value.clone());
    }
    if let Some(session) = session {
        request = request.header(SESSION_HEADER, session).header(PROTOCOL_HEADER, PROTOCOL);
    }
    let response = request.send().await?;
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        let challenge =
            response.headers().get(WWW_AUTHENTICATE).and_then(|value| value.to_str().ok()).map(str::to_owned);
        return Ok(Reply::Unauthorized { challenge });
    }
    if status == StatusCode::ACCEPTED {
        return Ok(Reply::Accepted);
    }
    let session_id = response.headers().get(SESSION_HEADER).and_then(|value| value.to_str().ok()).map(str::to_owned);
    let streamed = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|kind| kind.starts_with("text/event-stream"));
    if !status.is_success() {
        return Ok(Reply::Status(status.as_u16()));
    }
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_REPLY {
        return Ok(Reply::Status(status.as_u16()));
    }
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let message =
        if streamed { event_reply(&String::from_utf8_lossy(&bytes), &id) } else { serde_json::from_slice(&bytes).ok() };
    Ok(Reply::Message { message: message.unwrap_or(Value::Null), session: session_id })
}

/// The JSON-RPC response with `id` among server-sent events.
fn event_reply(stream: &str, id: &Value) -> Option<Value> {
    let normalized = stream.replace("\r\n", "\n");
    normalized.split("\n\n").find_map(|event| {
        let data: Vec<&str> = event
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(|data| data.strip_prefix(' ').unwrap_or(data))
            .collect();
        let message: Value = serde_json::from_str(&data.join("\n")).ok()?;
        (message.get("id") == Some(id)).then_some(message)
    })
}

/// A signed-in MCP session with T3.
pub(crate) struct Session {
    http: Http,
    url: Url,
    authorization: HeaderValue,
    session: Option<String>,
    next_id: u64,
}

impl Session {
    pub async fn open(grant: &Grant) -> Result<Self, T3Error> {
        let url = crate::mcp_endpoint(&grant.url)?;
        let http = Http::new(&url)?;
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {}", grant.token)).map_err(|_| T3Error::GrantRejected)?;
        authorization.set_sensitive(true);
        let reply = post(&http, &url, Some(&authorization), None, &initialize_request(1))
            .await
            .map_err(|_| http.unreachable())?;
        let (message, session) = match reply {
            Reply::Message { message, session } => (message, session),
            Reply::Unauthorized { .. } => return Err(T3Error::GrantRejected),
            Reply::Status(status) if status >= 500 => return Err(http.unreachable()),
            Reply::Accepted | Reply::Status(_) => return Err(T3Error::NoSignIn),
        };
        if message.get("result").is_none() {
            return Err(T3Error::Unexpected);
        }
        let opened = Self { http, url, authorization, session, next_id: 2 };
        let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        match opened.send(&initialized).await.map_err(|_| opened.http.unreachable())? {
            Reply::Unauthorized { .. } => return Err(T3Error::GrantRejected),
            Reply::Status(_) => return Err(T3Error::Unexpected),
            Reply::Accepted | Reply::Message { .. } => {}
        }
        Ok(opened)
    }

    async fn send(&self, body: &Value) -> Result<Reply, reqwest::Error> {
        post(&self.http, &self.url, Some(&self.authorization), self.session.as_deref(), body).await
    }

    /// Calls one tool and returns its structured result.
    pub async fn call(&mut self, tool: &'static str, arguments: Value) -> Result<Value, T3Error> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": tool, "arguments": arguments },
        });
        let message = match self.send(&request).await.map_err(|_| T3Error::NoReply(tool))? {
            Reply::Message { message, .. } => message,
            Reply::Unauthorized { .. } => return Err(T3Error::GrantRejected),
            Reply::Accepted => return Err(T3Error::NoReply(tool)),
            Reply::Status(status) if status >= 500 => return Err(T3Error::NoReply(tool)),
            Reply::Status(status) => {
                return Err(T3Error::Tool { tool, detail: format!(" (HTTP {status})"), needs_model: false })
            }
        };
        if message.is_null() {
            return Err(T3Error::NoReply(tool));
        }
        let result = message.get("result");
        let data = result.and_then(|result| result.get("structuredContent")).filter(|data| data.is_object());
        let failed = message.get("error").is_some()
            || result.and_then(|result| result.get("isError")).and_then(Value::as_bool).unwrap_or(false);
        match data {
            Some(data) if !failed && data.get("code").is_none() => Ok(data.clone()),
            _ => {
                let failure = data.cloned().or_else(|| result.and_then(failure_report)).unwrap_or(Value::Null);
                Err(T3Error::Tool { tool, detail: failure_detail(&failure), needs_model: needs_model(&failure) })
            }
        }
    }

    /// Ends the session on the server. A failure leaves only an idle session there.
    pub async fn close(self) {
        if let Some(session) = &self.session {
            if let Ok(request) = self.http.request(Method::DELETE, &self.url) {
                let _ = request
                    .header(AUTHORIZATION, self.authorization.clone())
                    .header(SESSION_HEADER, session)
                    .send()
                    .await;
            }
        }
    }
}

/// T3 Code reports a tool failure as text content holding `{_tag, code, message}`.
fn failure_report(result: &Value) -> Option<Value> {
    result.get("content")?.as_array()?.iter().find_map(|part| {
        serde_json::from_str::<Value>(part.get("text")?.as_str()?).ok().filter(|failure| failure.get("code").is_some())
    })
}

/// The code and T3's own explanation, as one plain line the operator can act on.
fn failure_detail(failure: &Value) -> String {
    let code = failure.get("code").and_then(Value::as_str).filter(|code| safe_code(code));
    let message: String = failure
        .get("message")
        .and_then(Value::as_str)
        .and_then(|message| message.lines().map(str::trim).find(|line| !line.is_empty()))
        .unwrap_or_default()
        .chars()
        .filter(|letter| !letter.is_control())
        .take(200)
        .collect();
    match (code, message.is_empty()) {
        (Some(code), false) => format!(" ({code}): {}", message.trim_end_matches('.')),
        (Some(code), true) => format!(" ({code})"),
        (None, _) => String::new(),
    }
}

/// T3 refuses a launch without `modelSelection` when the project has no default model.
fn needs_model(failure: &Value) -> bool {
    failure.get("code").and_then(Value::as_str) == Some("invalid_request")
        && failure.get("message").and_then(Value::as_str).is_some_and(|message| message.contains("modelSelection"))
}

fn safe_code(code: &str) -> bool {
    (1..=60).contains(&code.len()) && code.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'_')
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{event_reply, failure_detail, failure_report, needs_model, safe_code};

    #[test]
    fn t3s_explanation_is_kept_as_one_plain_line() {
        let text = r#"{"_tag":"OrchestratorMcpFailure","code":"invalid_request","message":"Pass modelSelection: the project has no default model.\nMore"}"#;
        let result = json!({ "isError": true, "content": [{ "type": "text", "text": text }] });
        let failure = failure_report(&result).unwrap();
        assert!(needs_model(&failure));
        assert!(!needs_model(&json!({ "code": "orchestration_error", "message": "modelSelection" })));
        assert_eq!(
            failure_detail(&failure),
            " (invalid_request): Pass modelSelection: the project has no default model"
        );
        assert_eq!(failure_detail(&json!({ "code": "Bad Code", "message": "x" })), "");
        assert_eq!(failure_detail(&json!({ "code": "x", "message": "a\u{1b}[31mb" })), " (x): a[31mb");
    }

    #[test]
    fn the_matching_reply_is_read_from_an_event_stream() {
        let stream = "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\r\n\r\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":3,\ndata: \"result\":{}}\n\n";
        assert_eq!(event_reply(stream, &json!(3)), Some(json!({ "jsonrpc": "2.0", "id": 3, "result": {} })));
        assert_eq!(event_reply(stream, &json!(4)), None);
    }

    #[test]
    fn only_plain_error_codes_reach_the_screen() {
        assert!(safe_code("project_not_found"));
        assert!(!safe_code("Bad <b>code</b>"));
        assert!(!safe_code(""));
    }
}
