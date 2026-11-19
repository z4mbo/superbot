use crate::{Client, Error};

const SERVICE: &str = "com.superbot.rakazo.session";

pub struct CredentialStore;

impl CredentialStore {
    pub async fn load(client: &Client) -> Result<Option<Client>, Error> {
        let server = client.server().to_owned();
        let token = tokio::task::spawn_blocking(move || match entry(&server)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(storage_error(error)),
        })
        .await
        .map_err(storage_error)??;
        token.map(|token| client.with_token(&token)).transpose()
    }

    pub async fn save(client: &Client) -> Result<(), Error> {
        let server = client.server().to_owned();
        let authorization = client.authorization()?.clone();
        tokio::task::spawn_blocking(move || {
            let token = authorization
                .to_str()
                .ok()
                .and_then(|value| value.strip_prefix("Bearer "))
                .ok_or(Error::InvalidSession)?;
            entry(&server)?.set_password(token).map_err(storage_error)
        })
        .await
        .map_err(storage_error)?
    }

    pub async fn delete(client: &Client) -> Result<(), Error> {
        let server = client.server().to_owned();
        tokio::task::spawn_blocking(move || match entry(&server)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(storage_error(error)),
        })
        .await
        .map_err(storage_error)?
    }
}

fn entry(server: &str) -> Result<keyring::Entry, Error> {
    if !cfg!(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    )) {
        return Err(Error::CredentialStore(
            "No system credential store is supported on this platform".into(),
        ));
    }
    keyring::Entry::new(SERVICE, server).map_err(storage_error)
}

fn storage_error(error: impl std::fmt::Display) -> Error {
    Error::CredentialStore(error.to_string())
}
