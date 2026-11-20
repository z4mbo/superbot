mod catalog;
mod discovery;
mod grok;
mod pi;
mod restricted;
mod session;
mod wire;

pub use catalog::{inventory, Disposition, Provider};
pub use discovery::discover;
use discovery::executable;
pub use session::Session;

use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    fmt, fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::process::Command;
use wire::Wire;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Unsupported,
    InvalidLocalConfig,
    Start,
    Closed,
    Timeout,
    Limit,
    Protocol,
    Remote(i64),
    AuthRequired,
    Unsafe,
    UnknownModel,
    Cancelled,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Unsupported => "This provider has no supported local action.",
            Self::InvalidLocalConfig => "Check the local ACP configuration and executable path.",
            Self::Start => "Could not start the local engine.",
            Self::Closed => "The local engine connection closed.",
            Self::Timeout => "The local engine took too long to respond.",
            Self::Limit => "The local engine exceeded a message size limit.",
            Self::Protocol => "The local engine returned an unexpected protocol message.",
            Self::Remote(_) => "The local engine refused the request.",
            Self::AuthRequired => "Sign in to the local engine and check again.",
            Self::Unsafe => "The local engine could not enforce prompt-only operation.",
            Self::UnknownModel => "The selected model is unavailable in this local session.",
            Self::Cancelled => "The local engine request was cancelled.",
        };
        f.write_str(message)
    }
}

impl std::error::Error for Error {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Model {
    pub id: String,
    pub label: String,
    pub provider: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthMethod {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct Probe {
    pub models: Vec<Model>,
    pub current_model: Option<String>,
    pub auth_methods: Vec<AuthMethod>,
    pub needs_auth: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub text: String,
    pub stop_reason: String,
}

#[derive(Clone)]
pub struct Engine {
    provider: &'static Provider,
    executable: PathBuf,
    launcher_args: Vec<OsString>,
    args: Vec<OsString>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalConfig {
    executable: PathBuf,
    #[serde(default)]
    args: Vec<String>,
}

/// Read custom ACP settings from the operator's application configuration directory.
pub fn load_custom(local_config_dir: &Path) -> Result<Option<Engine>, Error> {
    if !local_config_dir.is_absolute() {
        return Err(Error::InvalidLocalConfig);
    }
    let file = match fs::File::open(local_config_dir.join("local-acp.json")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Error::InvalidLocalConfig),
    };
    let mut data = Vec::new();
    file.take(65_537)
        .read_to_end(&mut data)
        .map_err(|_| Error::InvalidLocalConfig)?;
    if data.len() > 65_536 {
        return Err(Error::InvalidLocalConfig);
    }
    let config: LocalConfig =
        serde_json::from_slice(&data).map_err(|_| Error::InvalidLocalConfig)?;
    if config.args.iter().any(|arg| arg.contains('\0')) {
        return Err(Error::InvalidLocalConfig);
    }
    let executable = executable(&config.executable).ok_or(Error::InvalidLocalConfig)?;
    let provider = inventory()
        .iter()
        .find(|row| row.disposition == Disposition::LocalConfiguration)
        .ok_or(Error::Unsupported)?;
    Ok(Some(Engine {
        provider,
        executable,
        launcher_args: Vec::new(),
        args: config.args.into_iter().map(OsString::from).collect(),
    }))
}

impl Engine {
    pub fn provider(&self) -> &'static Provider {
        self.provider
    }

    pub async fn probe(&self) -> Result<Probe, Error> {
        Session::probe(self).await
    }

    pub async fn connect(&self) -> Result<Session, Error> {
        Session::connect(self).await
    }

    pub async fn safe_to_run(&self) -> Result<bool, Error> {
        if !matches!(self.provider.id, "grok" | "pi")
            && restricted::Restricted::for_engine(self).is_none()
        {
            return Ok(false);
        }
        match self.connect().await {
            Ok(_) => Ok(true),
            Err(Error::Unsafe | Error::AuthRequired | Error::Unsupported) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Run the provider's supported authentication action after the operator explicitly selects it.
    pub async fn sign_in(&self) -> Result<(), Error> {
        if self.provider.id == "grok" {
            return grok::sign_in(self).await;
        }
        if self.provider.id == "cursor" {
            session::verify_cursor(self).await?;
            let work = tempfile::tempdir().map_err(|_| Error::Start)?;
            let mut command = self.command_base(work.path());
            command.arg("login");
            wire::run_command(command, Duration::from_secs(300)).await?;
            return Ok(());
        }
        if !self.provider.interactive_sign_in {
            return Err(Error::Unsupported);
        }
        let mut wire = Wire::launch(self)?;
        let init = initialize(&mut wire).await?;
        if !auth_methods(&init)
            .iter()
            .any(|method| method.id == "browser-auth")
        {
            return Err(Error::Unsupported);
        }
        wire.acp(
            "authenticate",
            json!({"methodId":"browser-auth"}),
            Duration::from_secs(300),
            |_| Ok(()),
        )
        .await?;
        Ok(())
    }

    fn command(&self, cwd: &Path) -> Result<Command, Error> {
        let mut command = if self.provider.id == "grok" {
            grok::scoped_command(self, cwd)
        } else if let Some(restricted) = restricted::Restricted::for_engine(self) {
            restricted.command(self, cwd)?
        } else {
            self.command_base(cwd)
        };
        command.args(&self.args);
        Ok(command)
    }

    fn command_base(&self, cwd: &Path) -> Command {
        const PLATFORM: &[&str] = &[
            "PATH",
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
            "LANG",
            "LC_ALL",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "XDG_RUNTIME_DIR",
            "DBUS_SESSION_BUS_ADDRESS",
        ];
        let credentials: &[&str] = match self.provider.id {
            "githubCopilot" => &["COPILOT_GITHUB_TOKEN"],
            "cursor" => &["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],
            "opencodeGo" => &[
                "OPENCODE_API_KEY",
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "GEMINI_API_KEY",
            ],
            "grok" => &["GROK_HOME", "XAI_API_KEY"],
            "droid" => &["FACTORY_API_KEY"],
            "commandCode" => &["COMMAND_CODE_API_KEY"],
            "kiro" => &["KIRO_API_KEY"],
            "devin" => &["WINDSURF_API_KEY"],
            "mistralVibe" => &["MISTRAL_API_KEY"],
            "deepseek" => &["DEEPSEEK_API_KEY"],
            "gemini" => &[
                "GEMINI_API_KEY",
                "GOOGLE_API_KEY",
                "GOOGLE_APPLICATION_CREDENTIALS",
                "GOOGLE_CLOUD_PROJECT",
                "GOOGLE_CLOUD_LOCATION",
            ],
            _ => &[],
        };
        let mut command = Command::new(&self.executable);
        command
            .args(&self.launcher_args)
            .current_dir(cwd)
            .env_clear();
        for key in PLATFORM.iter().chain(credentials) {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
    }
}

async fn initialize(wire: &mut Wire) -> Result<Value, Error> {
    let response = wire.request("initialize", json!({
        "protocolVersion":1,
        "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},
        "clientInfo":{"name":"superbot","version":env!("CARGO_PKG_VERSION")}
    })).await?;
    if response["protocolVersion"] != 1 {
        return Err(Error::Protocol);
    }
    Ok(response)
}

fn auth_methods(response: &Value) -> Vec<AuthMethod> {
    values(&response["authMethods"])
        .filter_map(|entry| {
            let id = field(&entry["id"])?;
            Some(AuthMethod {
                id: id.to_owned(),
                label: field(&entry["name"]).unwrap_or(id).to_owned(),
            })
        })
        .collect()
}

fn field(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.trim().is_empty())
}

fn values(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}

#[cfg(test)]
mod tests;
