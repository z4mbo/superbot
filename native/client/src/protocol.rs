use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Use an HTTPS Rakazo origin or a local HTTP origin such as http://127.0.0.1:3000")]
    InvalidServer,
    #[error("Sign in to Rakazo first")]
    MissingSession,
    #[error("Rakazo did not provide a valid signed session")]
    InvalidSession,
    #[error("Enter a message between 1 and 100,000 UTF-16 code units")]
    InvalidMessage,
    #[error("Could not reach Rakazo: {0}")]
    Transport(reqwest::Error),
    #[error("Rakazo returned HTTP {status}: {message}")]
    Server {
        status: u16,
        code: Option<String>,
        message: String,
    },
    #[error("Unexpected Rakazo response: {0}")]
    Protocol(&'static str),
    #[error("Could not access your system credential store: {0}")]
    CredentialStore(String),
}

impl Error {
    pub fn is_unauthorized(&self) -> bool {
        matches!(
            self,
            Self::MissingSession | Self::Server { status: 401, .. }
        )
    }

    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::Transport(_)
                | Self::Server {
                    status: 502..=504,
                    ..
                }
        )
    }

    pub(crate) fn transport(error: reqwest::Error) -> Self {
        Self::Transport(error.without_url())
    }

    pub(crate) fn server(status: u16, payload: Value) -> Self {
        let rpc = payload.get("json").unwrap_or(&payload);
        let status = rpc
            .get("status")
            .and_then(Value::as_u64)
            .filter(|status| (400..=599).contains(status))
            .map_or(status, |status| status as u16);
        let code = rpc.get("code").and_then(Value::as_str).map(str::to_owned);
        let message = rpc
            .get("message")
            .or_else(|| rpc.get("error"))
            .and_then(Value::as_str)
            .filter(|message| !message.is_empty())
            .unwrap_or(match status {
                401 => "Session rejected. Sign in again.",
                403 => "Access denied.",
                404 => "The requested endpoint or chat was not found.",
                429 => "Too many requests. Try again later.",
                _ => "Request failed.",
            })
            .to_owned();
        Self::Server {
            status,
            code,
            message,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Space {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub shared: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Agent {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub enum ThreadTarget<'a> {
    #[serde(rename = "botId")]
    Bot(&'a str),
    #[serde(rename = "groupId")]
    Group(&'a str),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct MessageAuthor {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(from = "WireMessage")]
pub struct Message {
    pub id: String,
    pub role: String,
    pub author: Option<MessageAuthor>,
    pub bot_id: Option<String>,
    pub text: String,
    pub seq: i64,
    pub run_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireMessage {
    id: String,
    role: String,
    author: Option<MessageAuthor>,
    bot_id: Option<String>,
    seq: i64,
    run_id: Option<String>,
    blocks: Vec<Value>,
}

impl From<WireMessage> for Message {
    fn from(message: WireMessage) -> Self {
        let text = message
            .blocks
            .iter()
            .filter(|block| block.get("kind").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        Self {
            id: message.id,
            role: message.role,
            author: message.author,
            bot_id: message.bot_id,
            seq: message.seq,
            run_id: message.run_id,
            text,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    pub thread_id: String,
    pub cursor: i64,
    pub messages: Vec<Message>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendReceipt {
    pub task_id: String,
    pub run_id: String,
    pub seq: i64,
    #[serde(default)]
    pub run_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEvent {
    pub id: String,
    pub seq: i64,
    pub bot_id: Option<String>,
    pub run_id: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "payload")]
    pub data: Value,
}

impl ThreadEvent {
    pub fn message(&self) -> Result<Option<Message>, Error> {
        if !matches!(
            self.kind.as_str(),
            "thread.message.created" | "thread.message.updated"
        ) {
            return Ok(None);
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload {
            message_id: Option<String>,
            seq: Option<i64>,
            role: Option<String>,
            author: Option<MessageAuthor>,
            bot_id: Option<String>,
            #[serde(default)]
            blocks: Vec<Value>,
        }
        let payload: Payload = serde_json::from_value(self.data.clone())
            .map_err(|_| Error::Protocol("invalid message event"))?;
        let role = payload.role.unwrap_or_else(|| "bot".into());
        let bot_id = if role == "bot" {
            payload.bot_id.or_else(|| self.bot_id.clone())
        } else {
            payload.bot_id
        };
        Ok(Some(
            WireMessage {
                id: payload.message_id.unwrap_or_else(|| self.id.clone()),
                seq: payload.seq.unwrap_or(self.seq),
                role,
                author: payload.author,
                bot_id,
                run_id: self.run_id.clone(),
                blocks: payload.blocks,
            }
            .into(),
        ))
    }
}
