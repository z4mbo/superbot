use super::{
    wire::{run_command, REQUEST_TIMEOUT, TURN_TIMEOUT},
    Engine, Error, Reply,
};
use serde_json::json;
use std::{fs, path::Path};
use tokio::process::Command;

const COPILOT_SCOPE: &[&str] = &[
    "--available-tools=superbot_no_tools",
    "--disable-builtin-mcps",
    "--no-custom-instructions",
    "--no-experimental",
    "--sync-session=off",
    "--disallow-temp-dir",
];

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Restricted {
    Copilot,
    Gemini,
    OpenCode,
}

impl Restricted {
    pub(super) fn for_engine(engine: &Engine) -> Option<Self> {
        match engine.provider.id {
            "githubCopilot" => Some(Self::Copilot),
            "gemini" => Some(Self::Gemini),
            "opencodeGo" => Some(Self::OpenCode),
            _ => None,
        }
    }

    pub(super) async fn verify(self, engine: &Engine) -> Result<(), Error> {
        #[cfg(unix)]
        if matches!(self, Self::Copilot | Self::OpenCode) {
            use std::io::Read;
            let mut header = [0; 2];
            fs::File::open(&engine.executable)
                .and_then(|mut file| file.read_exact(&mut header))
                .map_err(|_| Error::Start)?;
            if header == *b"#!" {
                return Err(Error::Unsafe);
            }
        }
        let work = tempfile::tempdir().map_err(|_| Error::Start)?;
        let mut command = isolated(engine, work.path());
        if self == Self::Gemini {
            command.env("GEMINI_CLI_NO_RELAUNCH", "1");
        }
        command.arg("--version");
        let version = run_command(command, REQUEST_TIMEOUT).await?;
        let supported = match self {
            Self::Copilot => version.lines().next() == Some("GitHub Copilot CLI 1.0.114."),
            Self::Gemini => version.trim() == "0.70.0",
            Self::OpenCode => version.trim() == "1.19.6",
        };
        if !supported {
            return Err(Error::Unsafe);
        }
        Ok(())
    }

    pub(super) fn verify_agent(self, init: &serde_json::Value) -> Result<(), Error> {
        let (name, version) = match self {
            Self::Copilot => ("Copilot", "1.0.114"),
            Self::Gemini => ("gemini-cli", "0.70.0"),
            Self::OpenCode => ("OpenCode", "1.19.6"),
        };
        let info = &init["agentInfo"];
        if info["name"] != name || info["version"] != version {
            return Err(Error::Unsafe);
        }
        Ok(())
    }

    pub(super) fn command(self, engine: &Engine, cwd: &Path) -> Result<Command, Error> {
        let mut command = isolated(engine, cwd);
        match self {
            Self::Copilot => {
                command
                    .env("COPILOT_HOME", cwd.join("copilot"))
                    .args(COPILOT_SCOPE);
            }
            Self::Gemini => {
                let settings = cwd.join("settings.json");
                let vertex = std::env::var_os("GOOGLE_CLOUD_PROJECT").is_some()
                    && std::env::var_os("GEMINI_API_KEY").is_none()
                    && std::env::var_os("GOOGLE_API_KEY").is_none();
                let auth = if vertex {
                    "vertex-ai"
                } else {
                    "gemini-api-key"
                };
                let workspace = cwd
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or(Error::Start)?;
                let config = json!({
                    "security":{"auth":{"selectedType":auth},"disableYoloMode":true},
                    "admin":{"mcp":{"enabled":false},"extensions":{"enabled":false}},
                    "tools":{"core":[]},
                    "context":{"fileName":format!(".superbot-context-{workspace}")},
                    "skills":{"enabled":false},
                    "hooksConfig":{"enabled":false},
                    "experimental":{"enableAgents":false,"autoMemory":false},
                    "telemetry":{"enabled":false}
                });
                fs::write(&settings, config.to_string()).map_err(|_| Error::Start)?;
                command
                    .env("GEMINI_CLI_NO_RELAUNCH", "1")
                    .env("GEMINI_CLI_HOME", cwd.join("home"))
                    .env("GEMINI_CLI_SYSTEM_SETTINGS_PATH", settings)
                    .env("GEMINI_CLI_SYSTEM_DEFAULTS_PATH", cwd.join("defaults.json"))
                    .args(["--extensions", "none"]);
            }
            Self::OpenCode => {
                let managed = match std::env::consts::OS {
                    "windows" => Path::new(r"C:\ProgramData\opencode"),
                    "linux" => Path::new("/etc/opencode"),
                    _ => return Err(Error::Unsafe),
                };
                if !matches!(managed.try_exists(), Ok(false)) {
                    return Err(Error::Unsafe);
                }
                if let Some(program_data) = std::env::var_os("ProgramData") {
                    if !matches!(
                        Path::new(&program_data).join("opencode").try_exists(),
                        Ok(false)
                    ) {
                        return Err(Error::Unsafe);
                    }
                }
                let config = json!({
                    "default_agent":"superbot-prompt",
                    "agent":{"superbot-prompt":{"mode":"primary","permission":{"*":"deny"}}},
                    "permission":{"*":"deny"},
                    "autoupdate":false,
                    "share":"disabled",
                    "mcp":{},
                    "plugin":[],
                    "lsp":false
                });
                command
                    .env("OPENCODE_CONFIG_CONTENT", config.to_string())
                    .env("OPENCODE_DISABLE_PROJECT_CONFIG", "1")
                    .env("OPENCODE_DISABLE_DEFAULT_PLUGINS", "1")
                    .env("OPENCODE_DISABLE_CLAUDE_CODE", "1");
            }
        }
        Ok(command)
    }

    pub(super) async fn select_model(
        self,
        wire: &mut super::Wire,
        id: &str,
        model: &str,
    ) -> Result<(), Error> {
        match self {
            Self::Gemini => {
                wire.request(
                    "session/set_model",
                    json!({"sessionId":id, "modelId":model}),
                )
                .await?;
            }
            Self::OpenCode => {
                let response = wire
                    .request(
                        "session/set_config_option",
                        json!({"sessionId":id, "configId":"model", "value":model}),
                    )
                    .await?;
                if !Self::open_code_mode(&response) {
                    return Err(Error::Unsafe);
                }
                if !super::values(&response["configOptions"])
                    .any(|option| option["id"] == "model" && option["currentValue"] == model)
                {
                    return Err(Error::UnknownModel);
                }
            }
            Self::Copilot => return Err(Error::Unsupported),
        }
        Ok(())
    }

    pub(super) fn open_code_mode(session: &serde_json::Value) -> bool {
        super::values(&session["configOptions"])
            .any(|option| option["id"] == "mode" && option["currentValue"] == "superbot-prompt")
    }

    pub(super) async fn copilot_prompt(
        engine: &Engine,
        model: &str,
        text: &str,
    ) -> Result<Reply, Error> {
        if text.len() > 24_000 || text.contains('\0') {
            return Err(Error::Limit);
        }
        let work = tempfile::tempdir().map_err(|_| Error::Start)?;
        let mut command = Self::Copilot.command(engine, work.path())?;
        command
            .arg("--silent")
            .arg(format!("--model={model}"))
            .arg(format!("--prompt={}", literal_prompt(text)));
        let text = run_command(command, TURN_TIMEOUT).await?;
        let text = text.trim_end().to_owned();
        if text.is_empty() {
            return Err(Error::Protocol);
        }
        Ok(Reply {
            text,
            stop_reason: "end_turn".to_owned(),
        })
    }
}

fn isolated(engine: &Engine, cwd: &Path) -> Command {
    let mut command = engine.command_base(cwd);
    for key in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
    ] {
        command.env(key, cwd);
    }
    command.env("NO_COLOR", "1");
    command
}

pub(super) fn literal_prompt(text: &str) -> String {
    if text.trim_start().starts_with(['/', '$']) {
        format!("User message:\n{text}")
    } else {
        text.to_owned()
    }
}
