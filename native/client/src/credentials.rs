use std::{future::Future, time::Duration};

use tokio::time::{sleep, timeout_at, Instant};

use crate::{Client, Error};

const SERVICE: &str = "com.superbot.rakazo.session";
const RESTORE_BUDGET: Duration = Duration::from_secs(10);
const FIRST_RETRY: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(4);

pub struct CredentialStore;

impl CredentialStore {
    /// Restores a saved session using read-only validation. Only rejection by the
    /// server removes the credential. The network budget covers requests and waits.
    pub async fn restore<T, F>(
        client: &Client,
        mut validate: impl FnMut(Client) -> F,
    ) -> Result<Option<T>, Error>
    where
        F: Future<Output = Result<T, Error>>,
    {
        let Some(client) = Self::load(client).await? else {
            return Ok(None);
        };
        let deadline = Instant::now() + RESTORE_BUDGET;
        let result = timeout_at(deadline, async {
            let mut backoff = FIRST_RETRY;
            loop {
                let error = match validate(client.clone()).await {
                    Ok(value) => return Ok(value),
                    Err(error) => error,
                };
                let Some(delay) = retry_delay(&error, backoff, deadline - Instant::now()) else {
                    return Err(error);
                };
                sleep(delay).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        })
        .await
        .unwrap_or(Err(Error::Unavailable { retry_after: None }));

        match result {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.is_unauthorized() => {
                Self::delete(&client).await.ok();
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

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

fn retry_delay(error: &Error, backoff: Duration, remaining: Duration) -> Option<Duration> {
    if !error.is_retryable() {
        return None;
    }
    let delay = match error {
        Error::Unavailable {
            retry_after: Some(minimum),
        } => backoff.max(*minimum),
        _ => backoff,
    };
    (delay < remaining).then_some(delay)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delay_respects_backoff_server_minimum_and_deadline() {
        let unavailable = |seconds| Error::Unavailable {
            retry_after: Some(Duration::from_secs(seconds)),
        };
        assert_eq!(
            retry_delay(&unavailable(0), FIRST_RETRY, RESTORE_BUDGET),
            Some(FIRST_RETRY)
        );
        assert_eq!(
            retry_delay(&unavailable(6), MAX_BACKOFF, RESTORE_BUDGET),
            Some(Duration::from_secs(6))
        );
        assert_eq!(
            retry_delay(&unavailable(10), FIRST_RETRY, RESTORE_BUDGET),
            None
        );
        assert_eq!(retry_delay(&unavailable(0), MAX_BACKOFF, FIRST_RETRY), None);
        assert_eq!(
            retry_delay(&Error::MissingSession, FIRST_RETRY, RESTORE_BUDGET),
            None
        );
    }
}
