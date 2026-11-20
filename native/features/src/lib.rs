mod approvals;
mod artifacts;
mod boards;
mod bots;
mod computers;
mod conversation_content;
mod conversations;
pub use superbot_client::{BotConversation, BotConversationPatch};
pub mod local_acp;
pub mod local_app_records;
pub mod local_cli;
mod models;
pub mod plugin_manifest;
mod routines;
mod spaces;
mod threads;

pub use approvals::*;
pub use artifacts::*;
pub use boards::*;
pub use bots::*;
pub use computers::*;
pub use conversation_content::*;
pub use models::*;
pub use routines::*;
pub use spaces::*;
pub use threads::*;

use serde::{de::DeserializeOwned, Deserialize, Serialize, Serializer};
use serde_json::Value;
use superbot_client::Client;
pub use superbot_client::Error;

#[derive(Clone)]
pub struct Features {
    client: Client,
}

impl Features {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    pub fn space(&self, id: impl Into<String>) -> SpaceFeatures<'_> {
        SpaceFeatures {
            features: self,
            id: id.into(),
        }
    }

    async fn call<T: DeserializeOwned>(
        &self,
        path: &str,
        scope: Option<&str>,
        input: impl Serialize,
    ) -> Result<T, Error> {
        let input =
            serde_json::to_value(input).map_err(|_| Error::Protocol("invalid feature request"))?;
        self.client.rpc(path, scope, input).await
    }
}

#[derive(Clone)]
pub struct SpaceFeatures<'a> {
    features: &'a Features,
    id: String,
}

impl SpaceFeatures<'_> {
    async fn call<T: DeserializeOwned>(
        &self,
        path: &str,
        input: impl Serialize,
    ) -> Result<T, Error> {
        self.features.call(path, Some(&self.id), input).await
    }
}

#[derive(Deserialize)]
struct Acknowledgement {
    ok: bool,
}

impl Acknowledgement {
    fn validate(self) -> Result<(), Error> {
        if self.ok {
            Ok(())
        } else {
            Err(Error::Protocol("expected successful acknowledgement"))
        }
    }
}

impl SpaceFeatures<'_> {
    async fn acknowledge(&self, path: &str, input: impl Serialize) -> Result<(), Error> {
        self.call::<Acknowledgement>(path, input).await?.validate()
    }
}

/// A nullable update field. Use serde's skip_serializing_if with Unchanged.
#[derive(Clone, Debug, Default)]
pub enum Patch<T> {
    #[default]
    Unchanged,
    Clear,
    Set(T),
}

impl<T> Patch<T> {
    pub fn is_unchanged(&self) -> bool {
        matches!(self, Self::Unchanged)
    }
}

impl<T: Serialize> Serialize for Patch<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Set(value) => serializer.serialize_some(value),
            Self::Clear => serializer.serialize_none(),
            Self::Unchanged => Err(serde::ser::Error::custom(
                "unchanged fields must be omitted",
            )),
        }
    }
}

fn empty() -> Value {
    serde_json::json!({})
}
