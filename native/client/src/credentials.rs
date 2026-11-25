use std::{
    collections::BTreeMap,
    fs,
    future::Future,
    io::{self, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use tokio::time::{sleep, timeout_at, Instant};

use crate::{settings_directory, Client, Error};

const SERVICE: &str = "com.superbot.rakazo.session";
const RESTORE_BUDGET: Duration = Duration::from_secs(10);
const FIRST_RETRY: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(4);

pub struct CredentialStore;

/// Where a saved session went. The file is used only when this device has no system
/// credential store, such as a Linux server without a Secret Service.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SavedSession {
    SystemStore,
    File(PathBuf),
}

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
            Err(keyring::Error::NoEntry) => file_token(&server),
            Err(error) if no_system_store(&error) => file_token(&server),
            Err(error) => Err(storage_error(error)),
        })
        .await
        .map_err(storage_error)??;
        token.map(|token| client.with_token(&token)).transpose()
    }

    pub async fn save(client: &Client) -> Result<SavedSession, Error> {
        let server = client.server().to_owned();
        let authorization = client.authorization()?.clone();
        tokio::task::spawn_blocking(move || {
            let token = authorization
                .to_str()
                .ok()
                .and_then(|value| value.strip_prefix("Bearer "))
                .ok_or(Error::InvalidSession)?;
            match entry(&server)?.set_password(token) {
                Ok(()) => {
                    // Tidies a session saved earlier without a system store. Loading reads the
                    // system store first, so a file that cannot be tidied never wins.
                    if let Some(path) = session_file() {
                        let _ = forget_token(&path, &server);
                    }
                    Ok(SavedSession::SystemStore)
                }
                Err(error) if no_system_store(&error) => {
                    let path = session_file().ok_or_else(|| storage_error(error))?;
                    save_token(&path, &server, token).map_err(storage_error)?;
                    Ok(SavedSession::File(path))
                }
                Err(error) => Err(storage_error(error)),
            }
        })
        .await
        .map_err(storage_error)?
    }

    pub async fn delete(client: &Client) -> Result<(), Error> {
        let server = client.server().to_owned();
        tokio::task::spawn_blocking(move || {
            match entry(&server)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(error) if no_system_store(&error) => {}
                Err(error) => return Err(storage_error(error)),
            }
            if let Some(path) = session_file() {
                forget_token(&path, &server).map_err(storage_error)?;
            }
            Ok(())
        })
        .await
        .map_err(storage_error)?
    }
}

/// True when the device has no usable system credential store, rather than a store that
/// refused this one request.
fn no_system_store(error: &keyring::Error) -> bool {
    matches!(
        error,
        keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_)
    )
}

fn session_file() -> Option<PathBuf> {
    Some(settings_directory()?.join("sessions.json"))
}

fn file_token(server: &str) -> Result<Option<String>, Error> {
    let Some(path) = session_file() else {
        return Ok(None);
    };
    Ok(read_tokens(&path).map_err(storage_error)?.remove(server))
}

fn read_tokens(path: &Path) -> io::Result<BTreeMap<String, String>> {
    match fs::read_to_string(path) {
        Ok(saved) => serde_json::from_str(&saved)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(error),
    }
}

fn save_token(path: &Path, server: &str, token: &str) -> io::Result<()> {
    let mut tokens = read_tokens(path)?;
    tokens.insert(server.to_owned(), token.to_owned());
    write_tokens(path, &tokens)
}

fn forget_token(path: &Path, server: &str) -> io::Result<()> {
    let mut tokens = read_tokens(path)?;
    if tokens.remove(server).is_none() {
        return Ok(());
    }
    if tokens.is_empty() {
        return match fs::remove_file(path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        };
    }
    write_tokens(path, &tokens)
}

/// Replaces the file atomically. The temporary file starts readable only by this user, and
/// the mode is set again so the saved file never widens it.
fn write_tokens(path: &Path, tokens: &BTreeMap<String, String>) -> io::Result<()> {
    let directory = path
        .parent()
        .expect("session file has a settings directory");
    fs::create_dir_all(directory)?;
    let mut pending = tempfile::NamedTempFile::new_in(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        pending
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    serde_json::to_writer(&mut pending, tokens)?;
    pending.flush()?;
    pending.persist(path).map_err(|error| error.error)?;
    Ok(())
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
    fn session_file_keeps_one_private_token_per_server() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/sessions.json");
        save_token(&path, "https://one.example.test", "one.signature").unwrap();
        save_token(&path, "https://two.example.test", "two.signature").unwrap();
        save_token(&path, "https://one.example.test", "one.renewed").unwrap();
        let tokens = read_tokens(&path).unwrap();
        assert_eq!(tokens["https://one.example.test"], "one.renewed");
        assert_eq!(tokens["https://two.example.test"], "two.signature");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        forget_token(&path, "https://one.example.test").unwrap();
        assert!(!read_tokens(&path)
            .unwrap()
            .contains_key("https://one.example.test"));
        forget_token(&path, "https://two.example.test").unwrap();
        assert!(!path.exists());
        forget_token(&path, "https://two.example.test").unwrap();
        assert!(read_tokens(&path).unwrap().is_empty());
    }

    #[test]
    fn only_a_missing_system_store_falls_back_to_the_file() {
        let failure = || Box::<dyn std::error::Error + Send + Sync>::from("no secret service");
        assert!(no_system_store(&keyring::Error::PlatformFailure(failure())));
        assert!(no_system_store(&keyring::Error::NoStorageAccess(failure())));
        assert!(!no_system_store(&keyring::Error::NoEntry));
        assert!(!no_system_store(&keyring::Error::TooLong(
            "token".into(),
            1
        )));
    }

    #[test]
    fn unreadable_session_file_is_an_error_not_an_empty_store() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sessions.json");
        fs::write(&path, "not json").unwrap();
        assert!(read_tokens(&path).is_err());
        assert!(save_token(&path, "https://one.example.test", "token").is_err());
    }

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
