use super::session::Catalog;
use super::wire::{run_command, REQUEST_TIMEOUT, TURN_TIMEOUT};
use super::{field, Engine, Error, Model, Probe, Reply};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::process::Command;

const MAX_OUTPUT: u64 = 4 * 1024 * 1024;

pub(super) struct Headless {
    engine: Engine,
}

impl Headless {
    pub(super) async fn connect(engine: &Engine) -> Result<(Self, Catalog), Error> {
        let headless = Self {
            engine: engine.clone(),
        };
        let work = tempfile::tempdir().map_err(|_| Error::Start)?;
        headless.check_scope(work.path()).await?;
        let probe = headless.models(work.path()).await?;
        if probe.needs_auth {
            return Err(Error::AuthRequired);
        }
        Ok((
            headless,
            Catalog {
                models: probe.models,
                current: probe.current_model,
            },
        ))
    }

    pub(super) async fn probe(engine: &Engine) -> Result<Probe, Error> {
        let headless = Self {
            engine: engine.clone(),
        };
        let work = tempfile::tempdir().map_err(|_| Error::Start)?;
        headless.check_scope(work.path()).await?;
        headless.models(work.path()).await
    }

    async fn models(&self, cwd: &Path) -> Result<Probe, Error> {
        let mut command = self.command(cwd);
        command.arg("models");
        let output = run_command(command, REQUEST_TIMEOUT).await?;
        parse_models(&output)
    }

    async fn check_scope(&self, cwd: &Path) -> Result<(), Error> {
        let mut command = self.command(cwd);
        command.args(["inspect", "--json"]);
        let output = run_command(command, REQUEST_TIMEOUT).await?;
        let inspection: Value = serde_json::from_str(&output).map_err(|_| Error::Protocol)?;
        let empty = |value: &Value| value.as_array().is_some_and(Vec::is_empty);
        if inspection["grokVersion"] != "1.0.89"
            || ![
                "hooks",
                "skills",
                "plugins",
                "marketplaces",
                "mcpServers",
                "lspServers",
                "projectInstructions",
            ]
            .iter()
            .all(|key| empty(&inspection[*key]))
            || !empty(&inspection["configSources"]["layers"])
        {
            return Err(Error::Unsafe);
        }
        Ok(())
    }

    pub(super) async fn prompt(&self, model: &str, text: &str) -> Result<Reply, Error> {
        let work = tempfile::tempdir().map_err(|_| Error::Start)?;
        self.check_scope(work.path()).await?;
        if text.len() as u64 > MAX_OUTPUT {
            return Err(Error::Limit);
        }
        let file = work.path().join("prompt.txt");
        std::fs::write(&file, text).map_err(|_| Error::Start)?;
        let mut command = self.command(work.path());
        command
            .args([
                "--model",
                model,
                "--verbatim",
                "--output-format",
                "json",
                "--max-turns",
                "1",
                "--permission-mode",
                "dontAsk",
                "--deny",
                "Bash,Read,Edit,Write,Grep,WebFetch,MCPTool",
                "--sandbox",
                "strict",
                "--no-subagents",
                "--disable-web-search",
                "--no-plan",
                "--tools",
                "read_file",
                "--disallowed-tools",
                "read_file,hashline_read,search_tool,use_tool,Agent",
                "--prompt-file",
            ])
            .arg(file);
        let output = run_command(command, TURN_TIMEOUT).await?;
        let result: Value = serde_json::from_str(&output).map_err(|_| Error::Protocol)?;
        let text = result["text"].as_str().ok_or(Error::Protocol)?.to_owned();
        let stop_reason = field(&result["stopReason"])
            .ok_or(Error::Protocol)?
            .to_owned();
        if matches!(stop_reason.as_str(), "tool_use" | "toolUse" | "error") {
            return Err(Error::Unsafe);
        }
        Ok(Reply { text, stop_reason })
    }

    fn command(&self, cwd: &Path) -> Command {
        scoped_command(&self.engine, cwd)
    }
}

pub(super) fn scoped_command(engine: &Engine, cwd: &Path) -> Command {
    let mut command = engine.command_base(cwd);
    command
        .env("HOME", cwd)
        .env("USERPROFILE", cwd)
        .env("APPDATA", cwd)
        .env("LOCALAPPDATA", cwd)
        .env("XDG_CONFIG_HOME", cwd)
        .env("XDG_DATA_HOME", cwd)
        .env("XDG_CACHE_HOME", cwd)
        .env("GROK_HOME", cwd)
        .env("GROK_DISABLE_AUTOUPDATER", "1")
        .env("GROK_TELEMETRY_ENABLED", "0")
        .env("GROK_CURSOR_MCPS_ENABLED", "0")
        .env("GROK_CLAUDE_MCPS_ENABLED", "0")
        .env("GROK_CURSOR_HOOKS_ENABLED", "0")
        .env("GROK_CLAUDE_HOOKS_ENABLED", "0")
        .env("GROK_MEMORY", "0");
    if let Some(path) = auth_path() {
        command.env("GROK_AUTH_PATH", path);
    }
    command
}

fn auth_path() -> Option<PathBuf> {
    let home = std::env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|home| PathBuf::from(home).join(".grok"))
        })?;
    let path = home.join("auth.json");
    (path.is_absolute() && path.is_file()).then_some(path)
}

pub(super) async fn identity(engine: &Engine) -> Result<String, Error> {
    let work = tempfile::tempdir().map_err(|_| Error::Start)?;
    let mut command = engine.command_base(work.path());
    command.arg("--version");
    let output = run_command(command, REQUEST_TIMEOUT).await?;
    let mut fields = output.split_whitespace();
    if fields.next() != Some("grok") {
        return Err(Error::Unsupported);
    }
    fields.next().map(str::to_owned).ok_or(Error::Protocol)
}

pub(super) async fn sign_in(engine: &Engine) -> Result<(), Error> {
    identity(engine).await?;
    let work = tempfile::tempdir().map_err(|_| Error::Start)?;
    let mut command = engine.command_base(work.path());
    command.args(["login", "--oauth"]);
    run_command(command, Duration::from_secs(300)).await?;
    Ok(())
}

fn parse_models(output: &str) -> Result<Probe, Error> {
    let mut catalog = Catalog::default();
    let mut in_catalog = false;
    let mut needs_auth = false;
    for line in output.lines().map(str::trim) {
        if line == "You are not authenticated." {
            needs_auth = true;
        } else if let Some(id) = line
            .strip_prefix("Default model: ")
            .filter(|id| valid_id(id))
        {
            catalog.current = Some(id.to_owned());
        } else if line == "Available models:" {
            in_catalog = true;
        } else if in_catalog {
            if let Some(id) = line
                .strip_prefix("* ")
                .or_else(|| line.strip_prefix("- "))
                .and_then(|line| line.split_whitespace().next())
                .filter(|id| valid_id(id))
            {
                catalog.models.push(Model {
                    id: id.to_owned(),
                    label: id.to_owned(),
                    provider: None,
                });
            }
        }
    }
    if !in_catalog || catalog.models.is_empty() {
        return Err(Error::Protocol);
    }
    catalog.dedup();
    Ok(Probe {
        models: catalog.models,
        current_model: catalog.current,
        auth_methods: Vec::new(),
        needs_auth,
    })
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('-')
        && id.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/' | b':')
        })
}
