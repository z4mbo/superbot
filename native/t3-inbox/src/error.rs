/// Why a T3 step failed, worded as what the operator can do next.
#[derive(Debug, thiserror::Error)]
pub enum T3Error {
    #[error("Use the MCP URL from T3 Settings: an https:// address ending in /mcp, or http://127.0.0.1:PORT/mcp on this computer.")]
    InvalidEndpoint,
    #[error("Couldn't reach T3 at {0}. Check that T3 is running and the URL is right.")]
    Unreachable(String),
    #[error("This address didn't ask for a T3 sign-in. Update T3 and copy the MCP URL from its Settings again.")]
    NoSignIn,
    #[error("T3 sent the sign-in to another address. Copy the MCP URL from T3 Settings again.")]
    OtherOrigin,
    #[error("T3 doesn't offer sign-in for other apps here. Update T3 and try again.")]
    SignInUnsupported,
    #[error("The T3 sign-in was denied or took too long. Connect again.")]
    SignInDenied,
    #[error("T3 didn't accept the sign-in. Connect again.")]
    SignInRejected,
    #[error("T3 no longer accepts this connection. Disconnect, then connect again.")]
    GrantRejected,
    #[error("T3 didn't answer {0}. Try again: the same request is reused, so it can't start twice.")]
    NoReply(&'static str),
    #[error("T3 refused {tool}{detail}. Check T3 before trying again.")]
    Tool {
        tool: &'static str,
        detail: String,
        /// T3 refused a launch only because the project has no default model.
        needs_model: bool,
    },
    #[error("This T3 project has no default model, and no provider in T3 can run. Sign in to a provider or set a default model in T3, then try again.")]
    NoRunnableProvider,
    #[error("T3 answered in an unexpected way. Check T3 before trying again.")]
    Unexpected,
    #[error("This request was already started with a different project or brief. Open the first start in T3.")]
    IntentConflict,
    #[error("This request was first started with another T3 connection. Check it in T3 before doing anything else.")]
    ConnectionConflict,
    #[error("Couldn't save T3 Code inbox data on this computer: {0}")]
    Storage(String),
    #[error("Couldn't use your system credential store: {0}")]
    Keychain(String),
}

impl T3Error {
    pub(crate) fn storage(error: impl std::fmt::Display) -> Self {
        Self::Storage(error.to_string())
    }
}
