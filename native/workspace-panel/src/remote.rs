use std::future::Future;
use std::sync::{Arc, OnceLock};

use superbot_client::{Client, Error};
use superbot_features::{Features, SpaceFeatures};
use tokio::runtime::{Builder, Handle, Runtime};

/// The signed-in session bound to one Space.
#[derive(Clone)]
pub(crate) struct Remote {
    client: Client,
    features: Features,
    space_id: Arc<str>,
}

impl Remote {
    pub(crate) fn new(client: Client, space_id: &str) -> Self {
        Self {
            features: Features::new(client.clone()),
            client,
            space_id: space_id.into(),
        }
    }

    pub(crate) fn space(&self) -> SpaceFeatures<'_> {
        self.features.space(&*self.space_id)
    }

    pub(crate) fn client(&self) -> &Client {
        &self.client
    }

    pub(crate) fn features(&self) -> &Features {
        &self.features
    }

    pub(crate) fn space_id(&self) -> &str {
        &self.space_id
    }
}

// reqwest (0.12) only runs on a Tokio runtime, and GPUI's executors are not
// one, so requests run here and their results are awaited from the GUI thread.
fn runtime() -> Handle {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    if let Ok(handle) = Handle::try_current() {
        return handle;
    }
    RUNTIME
        .get_or_init(|| {
            Builder::new_multi_thread()
                .worker_threads(2)
                .thread_name("superbot-workspace")
                .enable_all()
                .build()
                .expect("failed to start the workspace panel's network runtime")
        })
        .handle()
        .clone()
}

/// Runs a request off the GUI thread. The returned future is runtime-agnostic
/// and resolves on whichever executor awaits it.
pub(crate) fn request<T, F>(work: F) -> impl Future<Output = Result<T, Error>> + 'static
where
    T: Send + 'static,
    F: Future<Output = Result<T, Error>> + Send + 'static,
{
    let task = runtime().spawn(work);
    async move {
        task.await
            .unwrap_or(Err(Error::Protocol("the request was interrupted")))
    }
}

/// Why a read or a change did not happen, in the terms the panel shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    /// The server answered HTTP 401: the session ended, or this account is
    /// not in the Space. The panel re-checks which before saying so.
    Unauthorized,
    /// The server refused this account (HTTP 403).
    Denied,
    /// The thing was changed or removed by someone else (HTTP 404 or 409).
    Stale(String),
    /// The server could not be reached.
    Offline,
    /// The server rejected the input and said why.
    Rejected(String),
    Other(String),
}

impl Failure {
    pub(crate) fn from_error(error: &Error) -> Self {
        if error.is_unauthorized() {
            return Self::Unauthorized;
        }
        match error {
            Error::Transport(_) => Self::Offline,
            Error::Server { status: 403, .. } => Self::Denied,
            Error::Server {
                status: 404 | 409,
                message,
                ..
            } => Self::Stale(message.clone()),
            Error::Server {
                status: 400 | 422 | 429,
                message,
                ..
            } => Self::Rejected(message.clone()),
            Error::Server {
                status: 502..=504, ..
            } => Self::Offline,
            other => Self::Other(other.to_string()),
        }
    }

    /// One sentence for the person, naming what could not be done.
    pub(crate) fn sentence(&self, action: &str) -> String {
        match self {
            Self::Unauthorized | Self::Denied => {
                format!("You don't have permission to {action}.")
            }
            Self::Offline => format!("Couldn't reach the server to {action}."),
            Self::Stale(message) | Self::Rejected(message) | Self::Other(message) => {
                format!("Couldn't {action}. {message}")
            }
        }
    }
}
