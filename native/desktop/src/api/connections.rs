use serde::Deserialize;
use serde_json::json;
use superbot_client::Error;

use super::Api;

/// An app the server's connectors can sign the person in to.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogApp {
    pub connector_id: String,
    pub slug: String,
    pub name: String,
    /// Connected through the connector itself, which may know of accounts this server has no
    /// row for yet.
    pub connected: bool,
    /// Connects without a sign-in page.
    pub no_auth: bool,
}

impl CatalogApp {
    pub fn key(&self) -> String {
        format!("{}:{}", self.connector_id, self.slug)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionStatus {
    Pending,
    Connected,
    Revoked,
    Error,
}

/// One account the person connected, or began connecting, to a catalog app.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub connector_id: String,
    pub provider: String,
    pub display_name: String,
    pub status: ConnectionStatus,
}

impl Connection {
    pub fn belongs_to(&self, app: &CatalogApp) -> bool {
        self.connector_id == app.connector_id && self.provider == app.slug
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BegunConnection {
    pub connection_id: String,
    /// The page that signs the person in, when the app needs one.
    pub authorization_url: Option<String>,
}

impl Api {
    /// Every app the server's configured connectors offer. Empty when the deployment has none.
    pub async fn connection_catalog(&self, space_id: &str) -> Result<Vec<CatalogApp>, Error> {
        self.client.rpc("connections/catalog", Some(space_id), json!({})).await
    }

    pub async fn connections(&self, space_id: &str) -> Result<Vec<Connection>, Error> {
        self.client.rpc("connections/list", Some(space_id), json!({})).await
    }

    pub async fn begin_connection(
        &self,
        space_id: &str,
        app: &CatalogApp,
        display_name: &str,
    ) -> Result<BegunConnection, Error> {
        let input = json!({ "connectorId": app.connector_id, "provider": app.slug, "displayName": display_name });
        self.client.rpc("connections/begin", Some(space_id), input).await
    }

    /// Asks whether a sign-in begun with [`Api::begin_connection`] has finished.
    pub async fn complete_connection(&self, space_id: &str, connection_id: &str) -> Result<Connection, Error> {
        self.client.rpc("connections/complete", Some(space_id), json!({ "connectionId": connection_id })).await
    }

    pub async fn revoke_connection(&self, space_id: &str, connection_id: &str) -> Result<(), Error> {
        self.done("connections/revoke", space_id, json!({ "connectionId": connection_id })).await
    }
}

/// The name for a new account: the app's own, then numbered past the names already in use.
pub fn next_account_label(app: &CatalogApp, connections: &[Connection]) -> String {
    let accounts: Vec<&Connection> = connections
        .iter()
        .filter(|row| {
            row.belongs_to(app) && matches!(row.status, ConnectionStatus::Connected | ConnectionStatus::Pending)
        })
        .collect();
    let mut number = accounts.iter().filter(|row| row.status == ConnectionStatus::Connected).count() + 1;
    let label = |number: usize| if number == 1 { app.name.clone() } else { format!("{} {number}", app.name) };
    while accounts.iter().any(|row| row.display_name == label(number)) {
        number += 1;
    }
    label(number)
}

#[cfg(test)]
mod tests {
    use super::{next_account_label, CatalogApp, Connection, ConnectionStatus};

    fn app() -> CatalogApp {
        CatalogApp {
            connector_id: "managed".into(),
            slug: "mail".into(),
            name: "Mail".into(),
            connected: false,
            no_auth: false,
        }
    }

    fn row(name: &str, status: ConnectionStatus) -> Connection {
        Connection {
            id: name.into(),
            connector_id: "managed".into(),
            provider: "mail".into(),
            display_name: name.into(),
            status,
        }
    }

    #[test]
    fn a_new_account_is_numbered_past_names_in_use() {
        assert_eq!(next_account_label(&app(), &[]), "Mail");
        assert_eq!(next_account_label(&app(), &[row("Mail", ConnectionStatus::Connected)]), "Mail 2");
        let busy = [row("Mail", ConnectionStatus::Connected), row("Mail 2", ConnectionStatus::Pending)];
        assert_eq!(next_account_label(&app(), &busy), "Mail 3");
        assert_eq!(next_account_label(&app(), &[row("Mail", ConnectionStatus::Revoked)]), "Mail");
    }
}
