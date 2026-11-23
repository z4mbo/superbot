#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    Acp,
    PiRpc,
    LocalConfiguration,
    SeparateLocalDriver,
    Connection,
    Unsupported,
}

#[derive(Debug, Clone, Copy)]
pub struct Provider {
    pub id: &'static str,
    pub label: &'static str,
    pub executable: Option<&'static str>,
    pub disposition: Disposition,
    pub sign_in: Option<&'static str>,
    pub interactive_sign_in: bool,
    pub detail: &'static str,
    pub(super) args: &'static [&'static str],
}

const fn row(
    id: &'static str,
    label: &'static str,
    disposition: Disposition,
    executable: Option<&'static str>,
    args: &'static [&'static str],
    sign_in: Option<&'static str>,
    detail: &'static str,
) -> Provider {
    Provider {
        id,
        label,
        executable,
        disposition,
        sign_in,
        detail,
        args,
        interactive_sign_in: false,
    }
}

const fn acp(
    id: &'static str,
    label: &'static str,
    executable: &'static str,
    args: &'static [&'static str],
    sign_in: &'static str,
) -> Provider {
    row(
        id,
        label,
        Disposition::Acp,
        Some(executable),
        args,
        Some(sign_in),
        "Native ACP discovery. Prompt availability depends on runtime tool controls.",
    )
}

const fn connection(id: &'static str, label: &'static str) -> Provider {
    row(
        id,
        label,
        Disposition::Connection,
        None,
        &[],
        None,
        "Use a model connection.",
    )
}

use Disposition::*;

static INVENTORY: &[Provider] = &[
    acp("grok", "Grok", "grok", &["--permission-mode", "default", "agent", "--no-leader", "stdio"], "grok login"),
    acp("kimi", "Kimi", "kimi", &["acp"], "kimi login"),
    acp("droid", "Droid", "droid", &["exec", "-o", "acp"], "droid"),
    Provider { interactive_sign_in: true, ..acp("cursor", "Cursor", "cursor-agent", &["acp"], "cursor-agent login") },
    Provider { detail: "Restricted turns require Copilot CLI 1.0.114.", ..acp("githubCopilot", "GitHub Copilot", "copilot", &["--acp", "--stdio"], "Set COPILOT_GITHUB_TOKEN in Superbot's environment.") },
    acp("commandCode", "Command Code", "command-code", &["acp"], "cmd login"),
    acp("kiro", "Kiro", "kiro-cli", &["acp", "--agent-engine=v3", "--auth-method=cli"], "kiro-cli login"),
    acp("devin", "Devin", "devin", &["acp"], "devin auth login"),
    row("claude", "Claude", SeparateLocalDriver, Some("claude"), &[], None, "Claude local CLI driver."),
    row("codex", "Codex", SeparateLocalDriver, Some("codex"), &[], None, "Codex local CLI driver."),
    row("chatgpt", "ChatGPT plan", Unsupported, None, &[], None, "Separate plan OAuth and Responses transport."),
    row("antigravity", "Google Gemini (Antigravity)", Unsupported, None, &[], None, "Requires the managed ACP runtime and OAuth callback."),
    Provider { detail: "Restricted turns require OpenCode 1.19.6 on Windows or Linux, without managed configuration.", ..acp("opencodeGo", "OpenCode", "opencode", &["acp"], "Set the model provider's API key in Superbot's environment.") },
    connection("openaiCompat", "OpenAI-compatible"),
    connection("mistral", "Mistral API"),
    Provider { interactive_sign_in: true, ..acp("mistralVibe", "Mistral (Vibe)", "vibe-acp", &[], "Sign in through Vibe or configure MISTRAL_API_KEY locally.") },
    connection("cerebras", "Cerebras"),
    connection("groq", "Groq"),
    connection("greenference", "Greenference"),
    connection("modelgo", "ModelGo"),
    connection("meta", "Meta Muse API"),
    acp("deepseek", "DeepSeek Harness", "dsh", &["--profile", "acp"], "Configure DEEPSEEK_API_KEY locally."),
    row("museCode", "Muse Code", Unsupported, Some("muse"), &[], None, "Uses muse serve RPC and requires separate native tool controls."),
    connection("openai", "OpenAI"),
    connection("claudeApi", "Claude API"),
    connection("xaiApi", "xAI"),
    connection("openrouter", "OpenRouter"),
    acp("qwen", "Qwen", "qwen", &["--acp"], "Configure the local Qwen CLI account or model provider."),
    acp("hermes", "Hermes", "hermes", &["acp"], "hermes setup"),
    acp("cline", "Cline", "cline", &["--acp", "--auto-approve", "false"], "cline auth"),
    row("pi", "Pi", PiRpc, Some("pi"),
        &["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-mcp", "--no-approve", "--no-skills", "--no-prompt-templates", "--no-context-files"],
        Some("Configure a provider in Pi or run /login in Pi."), "Native Pi JSON RPC with built-in tools and extensions disabled."),
    acp("omp", "OMP", "omp", &["acp"], "omp login"),
    connection("google-ai-studio", "Google AI Studio"),
    Provider { detail: "Restricted turns require Gemini CLI 0.70.0.", ..acp("gemini", "Gemini CLI", "gemini", &["--acp"], "Set GEMINI_API_KEY or configure Vertex AI credentials in Superbot's environment.") },
    row("custom-acp", "Custom ACP", LocalConfiguration, None, &[], None, "Requires an operator-configured local executable. Catalog only."),
    connection("ollama", "Ollama"),
    row("claudeEndpoint", "Claude endpoints", Connection, None, &[], None, "Uses the Claude driver with a compatible endpoint."),
    row("claudeBedrock", "Claude via Amazon Bedrock", Connection, None, &[], None, "Uses the Claude driver with Bedrock credentials."),
    row("codexEndpoint", "Codex endpoints", Connection, None, &[], None, "Uses the Codex driver with a compatible endpoint."),
];

pub fn inventory() -> &'static [Provider] {
    INVENTORY
}
