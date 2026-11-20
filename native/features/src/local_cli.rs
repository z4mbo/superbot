use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const MAX_OUTPUT: u64 = 1024 * 1024;
const MAX_INPUT: usize = 128 * 1024;
const CLAUDE_SETTINGS: &str =
    r#"{"disableClaudeAiConnectors":true,"disableAllHooks":true,"permissions":{"deny":["*"]}}"#;
const CODEX_FILE_AUTH: &str = r#"cli_auth_credentials_store="file""#;
const MIN_VERSION: (u32, u32, u32) = (2, 1, 280);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(usize)]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    pub const ALL: [Self; 2] = [Self::Claude, Self::Codex];

    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
        }
    }

    pub fn sign_in_label(self) -> &'static str {
        match self {
            Self::Claude => "Sign in with Claude Code",
            Self::Codex => "Sign in with ChatGPT",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    fn executable(self) -> String {
        format!("{}{}", self.id(), std::env::consts::EXE_SUFFIX)
    }

    fn minimum(self) -> (u32, u32, u32) {
        match self {
            Self::Claude => MIN_VERSION,
            Self::Codex => (0, 170, 0),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Missing,
    UnsupportedVersion,
    InstalledCodexUnavailable,
    InstalledCodexInstructions,
    SignedOut,
    Ready,
    Unavailable,
}

impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Self::Missing => "CLI installation missing.",
            Self::UnsupportedVersion => "Update the CLI to use local chat.",
            Self::SignedOut => "Sign in with the installed CLI.",
            Self::Ready => "Signed in on this computer.",
            Self::InstalledCodexUnavailable => {
                "Installed Codex needs a file-backed ChatGPT login and a compatible CLI home."
            }
            Self::InstalledCodexInstructions => {
                "Installed Codex has global instructions. Use a separate sign-in."
            }
            Self::Unavailable => "Couldn't verify CLI sign-in.",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct InstalledModel {
    pub provider: String,
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PendingHistory {
    pub id: String,
    pub text: String,
    pub reply: Option<String>,
}

impl crate::SpaceFeatures<'_> {
    pub async fn local_chat_prompt(
        &self,
        bot_id: &str,
        conversation: String,
    ) -> Result<String, crate::Error> {
        let bot = self.bot(bot_id).await?;
        if bot.instructions.trim().is_empty() {
            return Ok(conversation);
        }
        let instructions = serde_json::Value::String(bot.instructions);
        Ok(format!("Saved working instructions for this agent (JSON string): {instructions}\n\n{conversation}"))
    }
}

pub async fn run_local_model(
    cli: &LocalCli,
    model: &InstalledModel,
    prompt: &str,
) -> Result<String, String> {
    run_local_prompt(cli, model, prompt, PromptScope::Chat).await
}

#[derive(Clone, Copy)]
pub(crate) enum PromptScope {
    Chat,
    AppRecords,
}

pub(crate) fn uses_local_cli_driver(model: &InstalledModel) -> bool {
    Provider::ALL
        .iter()
        .any(|provider| provider.id() == model.provider)
}

pub(crate) async fn run_local_prompt(
    cli: &LocalCli,
    model: &InstalledModel,
    prompt: &str,
    scope: PromptScope,
) -> Result<String, String> {
    if uses_local_cli_driver(model) {
        return cli.reply(model, prompt).await.map_err(str::to_owned);
    }
    use crate::local_acp;
    if matches!(scope, PromptScope::AppRecords)
        && !local_acp::supports_private_prompt(&model.provider)
    {
        return Err("The selected local engine doesn't support private app prompts.".into());
    }
    let engine = local_acp::discover(&model.provider)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "The selected local CLI is missing.".to_owned())?;
    let mut session = match scope {
        PromptScope::Chat => engine.connect().await,
        PromptScope::AppRecords => engine.connect_private_prompt().await,
    }
    .map_err(|error| error.to_string())?;
    let reply = session
        .prompt(Some(&model.id), prompt, |_| {})
        .await
        .map_err(|error| error.to_string())?;
    if reply.text.trim().is_empty() {
        return Err("The local CLI didn't return a reply.".into());
    }
    Ok(reply.text)
}

#[derive(Clone)]
pub struct LocalCli {
    dir: PathBuf,
    #[cfg(test)]
    executables: [Option<PathBuf>; 2],
    #[cfg(test)]
    installed_codex_home: Option<PathBuf>,
}

impl LocalCli {
    pub fn config_dir() -> Option<PathBuf> {
        superbot_client::settings_directory()
    }

    pub fn for_workspace(server: &str, account: &str, space: &str) -> Option<Self> {
        if account.is_empty() {
            return None;
        }
        let data = Self::config_dir()?;
        let mut scope = Sha256::new();
        for value in [server, account, space] {
            scope.update((value.len() as u64).to_be_bytes());
            scope.update(value);
        }
        let dir = data
            .join("local-models")
            .join(format!("{:x}", scope.finalize()));
        Some(Self {
            dir,
            #[cfg(test)]
            executables: Provider::ALL.map(installed_executable),
            #[cfg(test)]
            installed_codex_home: None,
        })
    }

    pub fn uses_installed_codex(&self) -> Result<bool, &'static str> {
        match std::fs::read(self.dir.join("codex-account")) {
            Ok(mode) if mode == b"installed" => Ok(true),
            Ok(mode) if mode == b"separate" => Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            _ => Err("Couldn't read the local Codex account choice."),
        }
    }

    pub fn choose_installed_codex(&self, installed: bool) -> Result<(), &'static str> {
        let problem = "Couldn't save the local Codex account choice.";
        std::fs::create_dir_all(&self.dir).map_err(|_| problem)?;
        let mut file = tempfile::NamedTempFile::new_in(&self.dir).map_err(|_| problem)?;
        file.write_all(if installed { b"installed" } else { b"separate" })
            .map_err(|_| problem)?;
        file.persist(self.dir.join("codex-account"))
            .map_err(|_| problem)?;
        Ok(())
    }

    fn installed_home(&self, provider: Provider) -> Result<Option<PathBuf>, Status> {
        if provider != Provider::Codex
            || !self
                .uses_installed_codex()
                .map_err(|_| Status::Unavailable)?
        {
            return Ok(None);
        }
        #[cfg(test)]
        let home = self.installed_codex_home.clone();
        #[cfg(not(test))]
        let home = std::env::var_os("CODEX_HOME")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
                std::env::var_os(key).map(|home| PathBuf::from(home).join(".codex"))
            });
        let home = home
            .filter(|home| home.is_absolute() && home.is_dir())
            .ok_or(Status::InstalledCodexUnavailable)?;
        // Codex still reads global AGENTS files with --ignore-user-config (openai/codex#55157).
        for name in ["AGENTS.md", "AGENTS.override.md"] {
            match std::fs::symlink_metadata(home.join(name)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(Status::InstalledCodexInstructions),
            }
        }
        Ok(Some(home))
    }

    pub fn selection(&self, bot: &str) -> Result<Option<InstalledModel>, &'static str> {
        let path = self.model_path(bot);
        match std::fs::read(path) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|_| "The local model selection is invalid.")
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("Couldn't read the local model selection."),
        }
    }

    pub fn save_selection(
        &self,
        bot: &str,
        model: Option<&InstalledModel>,
    ) -> Result<(), &'static str> {
        let problem = "Couldn't save the local model selection.";
        std::fs::create_dir_all(&self.dir).map_err(|_| problem)?;
        let mut file = tempfile::NamedTempFile::new_in(&self.dir).map_err(|_| problem)?;
        serde_json::to_writer(&mut file, &model).map_err(|_| problem)?;
        file.flush().map_err(|_| problem)?;
        file.persist(self.model_path(bot)).map_err(|_| problem)?;
        Ok(())
    }

    pub fn pending_history(&self, bot: &str) -> Result<Option<PendingHistory>, &'static str> {
        match std::fs::read(self.history_path(bot)) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|_| "Couldn't read the pending local reply.")
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("Couldn't read the pending local reply."),
        }
    }

    pub fn stage_history(&self, bot: &str, pending: &PendingHistory) -> Result<(), &'static str> {
        let problem = "Couldn't keep this local message for retry.";
        let _lock = self.lock_history(bot).map_err(|_| problem)?;
        let mut file = tempfile::NamedTempFile::new_in(&self.dir).map_err(|_| problem)?;
        serde_json::to_writer(&mut file, pending).map_err(|_| problem)?;
        file.as_file().sync_all().map_err(|_| problem)?;
        match file.persist_noclobber(self.history_path(bot)) {
            Ok(_) => Ok(()),
            Err(error)
                if error.error.kind() == std::io::ErrorKind::AlreadyExists
                    && self.pending_history(bot)?.as_ref() == Some(pending) =>
            {
                Ok(())
            }
            Err(_) => Err(problem),
        }
    }

    pub fn clear_history(&self, bot: &str, pending: &PendingHistory) -> Result<(), &'static str> {
        let problem = "Couldn't clear the saved local retry.";
        let _lock = self.lock_history(bot).map_err(|_| problem)?;
        if self.pending_history(bot)?.as_ref() == Some(pending) {
            std::fs::remove_file(self.history_path(bot)).map_err(|_| problem)?;
        }
        Ok(())
    }

    fn lock_history(&self, bot: &str) -> std::io::Result<std::fs::File> {
        std::fs::create_dir_all(&self.dir)?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.history_path(bot).with_extension("lock"))?;
        file.lock()?;
        Ok(file)
    }

    fn history_path(&self, bot: &str) -> PathBuf {
        self.dir
            .join(format!("pending-{:x}.json", Sha256::digest(bot)))
    }

    fn model_path(&self, bot: &str) -> PathBuf {
        self.dir.join(format!("bot-{:x}.json", Sha256::digest(bot)))
    }

    fn executable(&self, provider: Provider) -> Option<PathBuf> {
        #[cfg(test)]
        return self.executables[provider as usize].clone();
        #[cfg(not(test))]
        installed_executable(provider)
    }

    async fn version(&self, provider: Provider) -> Result<(), Status> {
        if self.executable(provider).is_none() {
            return Err(Status::Missing);
        }
        let output = self
            .run(provider, &["--version"], None, Duration::from_secs(10))
            .await
            .map_err(|_| Status::Unavailable)?;
        let mut parts = output
            .text
            .split_whitespace()
            .find(|part| part.as_bytes().first().is_some_and(u8::is_ascii_digit))
            .unwrap_or_default()
            .split('.');
        let mut part = || parts.next().and_then(|value| value.parse::<u32>().ok());
        match (output.success, part(), part(), part()) {
            (true, Some(major), Some(minor), Some(patch))
                if (major, minor, patch) >= provider.minimum() =>
            {
                Ok(())
            }
            (true, Some(_), Some(_), Some(_)) => Err(Status::UnsupportedVersion),
            _ => Err(Status::Unavailable),
        }
    }

    pub async fn status(&self, provider: Provider) -> Status {
        match self.installed_home(provider) {
            Ok(home) => self.status_at(provider, home.as_deref()).await,
            Err(status) => status,
        }
    }

    async fn status_at(&self, provider: Provider, home: Option<&Path>) -> Status {
        if let Err(status) = self.version(provider).await {
            return status;
        }
        self.auth_status(provider, home).await
    }

    pub async fn catalog(&self, provider: Provider) -> Result<Vec<InstalledModel>, &'static str> {
        let home = self.installed_home(provider).map_err(Status::label)?;
        let status = self.status_at(provider, home.as_deref()).await;
        if status != Status::Ready {
            return Err(status.label());
        }
        let args: &[&str] = match provider {
            Provider::Claude => &[
                "--print",
                "--verbose",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--tools",
                "",
                "--strict-mcp-config",
                "--mcp-config",
                r#"{"mcpServers":{}}"#,
                "--setting-sources",
                "",
                "--permission-mode",
                "dontAsk",
                "--no-session-persistence",
                "--settings",
                CLAUDE_SETTINGS,
            ],
            Provider::Codex => &[
                "-c",
                "features.plugins=false",
                "-c",
                "mcp_servers={}",
                "app-server",
            ],
        };
        let scratch = home
            .is_some()
            .then(|| tempfile::tempdir_in(&self.dir))
            .transpose()
            .map_err(|_| "Couldn't open a temporary CLI profile.")?;
        let (mut child, _work) =
            self.spawn(provider, args, true, scratch.as_ref().map(|dir| dir.path()))?;
        let bad = "Couldn't read the installed model catalog.";
        let stdin = child.stdin.take().ok_or(bad)?;
        let stdout = child.stdout.take().ok_or(bad)?;
        let mut pipe = CatalogPipe {
            stdin,
            stdout: BufReader::new(stdout),
            next: 1,
        };
        let models = tokio::time::timeout(Duration::from_secs(15), pipe.models(provider))
            .await
            .map_err(|_| bad)?
            .ok_or(bad)?;
        Ok(models)
    }

    async fn auth_status(&self, provider: Provider, home: Option<&Path>) -> Status {
        let args: &[&str] = match provider {
            Provider::Claude => &["auth", "status", "--json"],
            Provider::Codex if home.is_some() => &["-c", CODEX_FILE_AUTH, "login", "status"],
            Provider::Codex => &["login", "status"],
        };
        let Ok(output) = self
            .run_at(provider, args, None, Duration::from_secs(10), home)
            .await
        else {
            return Status::Unavailable;
        };
        if provider == Provider::Codex {
            let lines = output.text.lines().chain(output.diagnostics.lines());
            for line in lines {
                let line = line.trim().to_ascii_lowercase();
                if output.success && line.starts_with("logged in using chatgpt") {
                    return Status::Ready;
                }
                if !output.success && line == "not logged in" {
                    return if home.is_some() {
                        Status::InstalledCodexUnavailable
                    } else {
                        Status::SignedOut
                    };
                }
            }
            return Status::Unavailable;
        }
        let Ok(auth) = serde_json::from_str::<AuthStatus>(&output.text) else {
            return Status::Unavailable;
        };
        match (output.success, auth.logged_in, auth.auth_method.as_deref()) {
            (true, true, Some("claude.ai" | "oauth")) => Status::Ready,
            (_, false, _) => Status::SignedOut,
            _ => Status::Unavailable,
        }
    }

    pub async fn sign_in(&self, provider: Provider) -> Result<Status, &'static str> {
        self.require_separate_account(provider)?;
        self.version(provider).await.map_err(Status::label)?;
        let args: &[&str] = match provider {
            Provider::Claude => &["auth", "login"],
            Provider::Codex => &["login"],
        };
        self.run(provider, args, None, Duration::from_secs(180))
            .await?;
        match self.auth_status(provider, None).await {
            Status::Ready => Ok(Status::Ready),
            _ => Err("Provider sign-in didn't finish."),
        }
    }

    fn require_separate_account(&self, provider: Provider) -> Result<(), &'static str> {
        if provider == Provider::Codex && self.uses_installed_codex()? {
            return Err("Choose a separate Codex sign-in to manage it here.");
        }
        Ok(())
    }

    pub async fn sign_out(&self, provider: Provider) -> Result<Status, &'static str> {
        self.require_separate_account(provider)?;
        let args: &[&str] = match provider {
            Provider::Claude => &["auth", "logout"],
            Provider::Codex => &["logout"],
        };
        self.run(provider, args, None, Duration::from_secs(10))
            .await?;
        match self.auth_status(provider, None).await {
            Status::SignedOut => Ok(Status::SignedOut),
            _ => Err("Couldn't verify provider sign-out."),
        }
    }

    pub async fn reply(
        &self,
        model: &InstalledModel,
        prompt: &str,
    ) -> Result<String, &'static str> {
        if prompt.len() > MAX_INPUT {
            return Err("This local conversation is too long. Start a fresh local chat.");
        }
        let provider = Provider::ALL
            .into_iter()
            .find(|provider| provider.id() == model.provider)
            .ok_or("The selected local provider is unavailable.")?;
        if !model_id_ok(&model.id) {
            return Err("The selected local model is invalid.");
        }
        let home = self.installed_home(provider).map_err(Status::label)?;
        let status = self.status_at(provider, home.as_deref()).await;
        if status != Status::Ready {
            return Err(status.label());
        }
        if provider == Provider::Codex {
            return self.codex_reply(&model.id, prompt, home.as_deref()).await;
        }

        let args = [
            "--print",
            "--output-format",
            "json",
            "--model",
            &model.id,
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            r#"{"mcpServers":{}}"#,
            "--setting-sources",
            "",
            "--settings",
            CLAUDE_SETTINGS,
            "--permission-mode",
            "dontAsk",
            "--max-turns",
            "1",
            "--no-session-persistence",
            "--disable-slash-commands",
        ];
        let output = self
            .run(provider, &args, Some(prompt), Duration::from_secs(180))
            .await?;
        let result = serde_json::from_str::<Reply>(&output.text).ok();
        match result {
            Some(result)
                if output.success && !result.is_error && !result.result.trim().is_empty() =>
            {
                Ok(result.result)
            }
            _ => Err(
                "Claude Code didn't return a reply. Check the provider account and model access.",
            ),
        }
    }

    async fn codex_reply(
        &self,
        model: &str,
        prompt: &str,
        home: Option<&Path>,
    ) -> Result<String, &'static str> {
        let mut args = vec![
            "-a",
            "never",
            "exec",
            "--sandbox",
            "read-only",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--ephemeral",
            "--json",
            "--model",
            model,
            #[cfg(windows)]
            "-c",
            #[cfg(windows)]
            "windows.sandbox=\"unelevated\"",
            "-c",
            "features.shell_tool=false",
            "-c",
            "features.shell_snapshot=false",
            "-c",
            "features.apply_patch_freeform=false",
            "-c",
            "features.browser_use=false",
            "-c",
            "features.browser_use_external=false",
            "-c",
            "features.computer_use=false",
            "-c",
            "features.hooks=false",
            "-c",
            "features.multi_agent=false",
            "-c",
            "features.plugins=false",
            "-c",
            "features.apps=false",
            "-c",
            "features.goals=false",
            "-c",
            "mcp_servers={}",
            "-c",
            "web_search=\"disabled\"",
        ];
        if home.is_some() {
            args.extend([
                "-c",
                CODEX_FILE_AUTH,
                "-c",
                "skills.include_instructions=false",
                "-c",
                "project_doc_max_bytes=0",
                "-c",
                "features.skill_mcp_dependency_install=false",
                "-c",
                "features.skill_search=false",
                "-c",
                "features.memories=false",
            ]);
        }
        args.push("-");
        let output = self
            .run_at(
                Provider::Codex,
                &args,
                Some(prompt),
                Duration::from_secs(180),
                home,
            )
            .await?;
        let mut completed = false;
        let mut reply = None;
        for event in output
            .text
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        {
            match event["type"].as_str() {
                Some("item.completed") if event["item"]["type"] == "agent_message" => {
                    reply = event["item"]["text"]
                        .as_str()
                        .filter(|text| !text.trim().is_empty())
                        .map(str::to_owned);
                }
                Some("turn.completed") => completed = true,
                Some("turn.failed") => return Err("The Codex turn failed."),
                _ => {}
            }
        }
        reply.filter(|_| completed && output.success).ok_or(
            "Codex didn't return a reply. Check the provider account, sandbox and model access.",
        )
    }

    fn spawn(
        &self,
        provider: Provider,
        args: &[&str],
        pipe_input: bool,
        codex_home: Option<&Path>,
    ) -> Result<(Child, tempfile::TempDir), &'static str> {
        let executable = self.executable(provider).ok_or(Status::Missing.label())?;
        let profile = self.dir.join(match provider {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        });
        std::fs::create_dir_all(&profile).map_err(|_| "Couldn't open the local CLI profile.")?;
        let work = tempfile::tempdir_in(&self.dir)
            .map_err(|_| "Couldn't open a temporary CLI directory.")?;
        let mut command = Command::new(executable);
        command.args(args).current_dir(work.path()).env_clear();
        for (key, value) in std::env::vars_os().filter(|(key, _)| allowed_env(key)) {
            command.env(key, value);
        }
        command.env("HOME", &profile).env("USERPROFILE", &profile);
        match provider {
            Provider::Claude => command.env("CLAUDE_CONFIG_DIR", &profile),
            Provider::Codex => {
                command.env("CODEX_HOME", codex_home.unwrap_or(&profile));
                if codex_home.is_some() {
                    command.env("CODEX_SQLITE_HOME", work.path());
                }
                &mut command
            }
        };
        let capture_status_diagnostics =
            provider == Provider::Codex && args.ends_with(&["login", "status"]);
        command
            .env("DISABLE_AUTOUPDATER", "1")
            .env("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1")
            .env("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1")
            .env("ENABLE_TOOL_SEARCH", "false")
            .stdin(if pipe_input {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(if capture_status_diagnostics {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let failed = "Couldn't run the installed CLI.";
        Ok((command.spawn().map_err(|_| failed)?, work))
    }

    async fn run(
        &self,
        provider: Provider,
        args: &[&str],
        input: Option<&str>,
        limit: Duration,
    ) -> Result<Output, &'static str> {
        self.run_at(provider, args, input, limit, None).await
    }

    async fn run_at(
        &self,
        provider: Provider,
        args: &[&str],
        input: Option<&str>,
        limit: Duration,
        codex_home: Option<&Path>,
    ) -> Result<Output, &'static str> {
        let (_work, mut child) = {
            let (child, work) = self.spawn(provider, args, input.is_some(), codex_home)?;
            (work, child)
        };
        let failed = "Couldn't run the installed CLI.";
        let mut stdout = child.stdout.take().ok_or(failed)?.take(MAX_OUTPUT + 1);
        let mut bytes = Vec::new();
        let mut diagnostics = Vec::new();
        let mut stderr = child.stderr.take();
        let mut stdin = child.stdin.take();
        let work = async {
            tokio::try_join!(
                async {
                    if let (Some(mut stdin), Some(input)) = (stdin.take(), input) {
                        stdin.write_all(input.as_bytes()).await?;
                        stdin.shutdown().await?;
                    }
                    Ok::<(), std::io::Error>(())
                },
                async {
                    stdout.read_to_end(&mut bytes).await?;
                    if bytes.len() as u64 > MAX_OUTPUT {
                        return Err(std::io::Error::other("output limit reached"));
                    }
                    Ok(())
                },
                async {
                    if let Some(stderr) = stderr.take() {
                        stderr
                            .take(MAX_OUTPUT + 1)
                            .read_to_end(&mut diagnostics)
                            .await?;
                        if diagnostics.len() as u64 > MAX_OUTPUT {
                            return Err(std::io::Error::other("output limit reached"));
                        }
                    }
                    Ok(())
                }
            )?;
            child.wait().await
        };
        let status = tokio::time::timeout(limit, work)
            .await
            .map_err(|_| "The local CLI timed out.")?
            .map_err(|_| failed)?;
        Ok(Output {
            success: status.success(),
            text: String::from_utf8_lossy(&bytes).into_owned(),
            diagnostics: String::from_utf8_lossy(&diagnostics).into_owned(),
        })
    }
}

struct CatalogPipe {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next: i64,
}

impl CatalogPipe {
    async fn send(&mut self, value: serde_json::Value) -> Option<()> {
        let frame = format!("{value}\n");
        self.stdin.write_all(frame.as_bytes()).await.ok()
    }

    async fn receive(&mut self, id: i64, provider: Provider) -> Option<serde_json::Value> {
        use serde_json::Value;
        for _ in 0..128 {
            let mut line = Vec::new();
            let read = (&mut self.stdout)
                .take(MAX_OUTPUT + 1)
                .read_until(b'\n', &mut line)
                .await
                .ok()?;
            if read == 0 || read as u64 > MAX_OUTPUT {
                return None;
            }
            let Ok(frame) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            match provider {
                Provider::Claude if frame["response"]["request_id"] == "catalog" => {
                    return frame["response"].get("response").cloned();
                }
                Provider::Codex if frame["id"] == id => return frame.get("result").cloned(),
                _ => {}
            }
        }
        None
    }

    async fn models(&mut self, provider: Provider) -> Option<Vec<InstalledModel>> {
        use serde_json::{json, Value};
        let mut entries = Vec::new();
        match provider {
            Provider::Claude => {
                self.send(json!({"type":"control_request","request_id":"catalog","request":{"subtype":"initialize"}})).await?;
                entries.extend(
                    self.receive(0, provider).await?["models"]
                        .as_array()?
                        .iter()
                        .cloned(),
                );
            }
            Provider::Codex => {
                self.send(json!({"id":0,"method":"initialize","params":{"clientInfo":{"name":"superbot","version":env!("CARGO_PKG_VERSION")}}})).await?;
                self.receive(0, provider).await?;
                self.send(json!({"method":"initialized"})).await?;
                let mut cursor = Value::Null;
                loop {
                    let id = self.next;
                    self.next += 1;
                    if id > 16 {
                        return None;
                    }
                    self.send(json!({"id":id,"method":"model/list","params":{"includeHidden":false,"limit":100,"cursor":cursor}})).await?;
                    let page = self.receive(id, provider).await?;
                    entries.extend(page["data"].as_array()?.iter().cloned());
                    cursor = page["nextCursor"].clone();
                    if cursor.is_null() {
                        break;
                    }
                }
            }
        }
        let mut ids = std::collections::HashSet::new();
        Some(
            entries
                .into_iter()
                .filter_map(|entry| {
                    let (id_key, label_key) = match provider {
                        Provider::Claude => ("value", "displayName"),
                        Provider::Codex => ("model", "displayName"),
                    };
                    let id = entry[id_key].as_str()?;
                    if !model_id_ok(id) || !ids.insert(id.to_owned()) {
                        return None;
                    }
                    Some(InstalledModel {
                        provider: provider.id().to_owned(),
                        id: id.to_owned(),
                        label: entry[label_key]
                            .as_str()
                            .filter(|label| !label.is_empty())
                            .unwrap_or(id)
                            .to_owned(),
                    })
                })
                .collect(),
        )
    }
}

struct Output {
    success: bool,
    text: String,
    diagnostics: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatus {
    logged_in: bool,
    auth_method: Option<String>,
}

#[derive(Deserialize)]
struct Reply {
    is_error: bool,
    result: String,
}

#[cfg(test)]
mod tests;

fn allowed_env(key: &OsString) -> bool {
    matches!(
        key.to_string_lossy().to_ascii_uppercase().as_str(),
        "PATH"
            | "SYSTEMROOT"
            | "WINDIR"
            | "TEMP"
            | "TMP"
            | "USERPROFILE"
            | "HOMEDRIVE"
            | "HOMEPATH"
            | "TMPDIR"
            | "USER"
            | "LOGNAME"
            | "LC_ALL"
            | "LC_CTYPE"
            | "APPDATA"
            | "LOCALAPPDATA"
            | "PROGRAMDATA"
            | "COMSPEC"
            | "LANG"
            | "HTTP_PROXY"
            | "HTTPS_PROXY"
            | "NO_PROXY"
            | "SSL_CERT_FILE"
            | "SSL_CERT_DIR"
    )
}

fn model_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 180
        && !id.starts_with('-')
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._:/[]".contains(&byte))
}

fn installed_executable(provider: Provider) -> Option<PathBuf> {
    let user_bin = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .map(|profile| profile.join(".local").join("bin"));
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(user_bin)
        .chain(
            [
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
            ]
            .into_iter()
            .filter(|_| cfg!(target_os = "macos")),
        )
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(provider.executable()))
        .find(|file| file.is_file())
}
