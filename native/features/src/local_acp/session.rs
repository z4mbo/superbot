use super::grok::{self, Headless};
use super::restricted::{literal_prompt, Restricted};
use super::wire::TURN_TIMEOUT;
use super::{
    auth_methods, field, initialize, pi, values, AuthMethod, Disposition, Engine, Error, Model,
    Probe, Reply, Wire,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    future::{pending, Future},
    time::Duration,
};
use tokio::time::{sleep, timeout};

const MAX_REPLY: usize = 4 * 1024 * 1024;

pub struct Session {
    protocol: Protocol,
    catalog: Catalog,
    usable: bool,
}

enum Protocol {
    Acp {
        wire: Wire,
        id: String,
        scope: Option<Restricted>,
    },
    Copilot(Engine),
    Pi(Wire),
    GrokHeadless(Headless),
}

#[derive(Default)]
pub(super) struct Catalog {
    pub(super) models: Vec<Model>,
    pub(super) current: Option<String>,
}

impl Catalog {
    fn acp(result: &Value) -> Self {
        let mut catalog = Self::default();
        if let Some(option) = values(&result["configOptions"]).find(|option| {
            option["type"] == "select" && (option["category"] == "model" || option["id"] == "model")
        }) {
            catalog.current = field(&option["currentValue"]).map(str::to_owned);
            collect_choices(&option["options"], None, 0, &mut catalog.models);
        }
        if catalog.models.is_empty() {
            let models = &result["models"];
            catalog.current = field(&models["currentModelId"])
                .map(str::to_owned)
                .or(catalog.current);
            catalog.models = values(&models["availableModels"])
                .filter_map(|model| {
                    let id = field(&model["modelId"])?;
                    Some(model_entry(id, &model["name"], field(&model["provider"])))
                })
                .collect();
        }
        catalog.dedup();
        catalog
    }

    pub(super) fn dedup(&mut self) {
        let mut seen = HashSet::new();
        self.models.retain(|model| seen.insert(model.id.clone()));
    }

    fn probe(self, auth_methods: Vec<AuthMethod>, needs_auth: bool) -> Probe {
        Probe {
            models: self.models,
            current_model: self.current,
            auth_methods,
            needs_auth,
        }
    }
}

fn collect_choices(raw: &Value, provider: Option<&str>, depth: usize, models: &mut Vec<Model>) {
    if depth > 8 {
        return;
    }
    for choice in values(raw) {
        let provider = field(&choice["provider"]).or(provider);
        if let Some(id) = field(&choice["value"]) {
            models.push(model_entry(id, &choice["name"], provider));
        } else {
            let group = provider
                .or_else(|| field(&choice["name"]))
                .or_else(|| field(&choice["group"]));
            collect_choices(&choice["options"], group, depth + 1, models);
        }
    }
}

fn model_entry(id: &str, label: &Value, provider: Option<&str>) -> Model {
    Model {
        id: id.to_owned(),
        label: field(label).unwrap_or(id).to_owned(),
        provider: provider.map(str::to_owned),
    }
}

impl Session {
    pub(super) async fn probe(engine: &Engine) -> Result<Probe, Error> {
        if engine.provider.id == "grok" && grok::identity(engine).await? == "1.0.89" {
            return Headless::probe(engine).await;
        }
        if engine.provider.id == "cursor" {
            verify_cursor(engine).await?;
        }
        if let Some(restricted) = Restricted::for_engine(engine) {
            restricted.verify(engine).await?;
        }
        let mut wire = Wire::launch(engine)?;
        if engine.provider.disposition == Disposition::PiRpc {
            let catalog = pi::catalog(&mut wire).await?;
            let needs_auth = catalog.models.is_empty();
            return Ok(catalog.probe(Vec::new(), needs_auth));
        }
        let init = initialize(&mut wire).await?;
        if let Some(restricted) = Restricted::for_engine(engine) {
            restricted.verify_agent(&init)?;
        }
        let methods = auth_methods(&init);
        let params = json!({"cwd":wire.cwd(), "mcpServers":[]});
        match wire.request("session/new", params).await {
            Ok(session) => {
                field(&session["sessionId"]).ok_or(Error::Protocol)?;
                let mut catalog = Catalog::acp(&session);
                if catalog.models.is_empty() {
                    catalog = Catalog::acp(&json!({"models":init["_meta"]["modelState"]}));
                }
                Ok(catalog.probe(methods, false))
            }
            Err(Error::Remote(-32000)) => {
                Ok(Catalog::acp(&json!({"models":init["_meta"]["modelState"]}))
                    .probe(methods, true))
            }
            Err(error) => Err(error),
        }
    }

    pub(super) async fn connect_grok_headless(engine: &Engine) -> Result<Self, Error> {
        let (headless, catalog) = Headless::connect(engine).await?;
        Ok(Self {
            protocol: Protocol::GrokHeadless(headless),
            catalog,
            usable: true,
        })
    }

    pub(super) async fn connect(engine: &Engine) -> Result<Self, Error> {
        if engine.provider.id == "grok" {
            match grok::identity(engine).await?.as_str() {
                grok::HEADLESS_VERSION => return Self::connect_grok_headless(engine).await,
                "1.0.41" => {}
                _ => return Err(Error::Unsafe),
            }
        } else if let Some(restricted) = Restricted::for_engine(engine) {
            restricted.verify(engine).await?;
            let mut wire = Wire::launch(engine)?;
            restricted.verify_agent(&initialize(&mut wire).await?)?;
            let params = json!({"cwd":wire.cwd(), "mcpServers":[]});
            let session = wire.request("session/new", params).await.map_err(|error| {
                if error == Error::Remote(-32000) {
                    Error::AuthRequired
                } else {
                    error
                }
            })?;
            let catalog = Catalog::acp(&session);
            if catalog.models.is_empty() {
                return Err(Error::UnknownModel);
            }
            let id = field(&session["sessionId"])
                .ok_or(Error::Protocol)?
                .to_owned();
            if restricted == Restricted::OpenCode && !Restricted::open_code_mode(&session) {
                return Err(Error::Unsafe);
            }
            let protocol = if restricted == Restricted::Copilot {
                Protocol::Copilot(engine.clone())
            } else {
                Protocol::Acp {
                    wire,
                    id,
                    scope: Some(restricted),
                }
            };
            return Ok(Self {
                protocol,
                catalog,
                usable: true,
            });
        } else if engine.provider.disposition != Disposition::PiRpc {
            return Err(Error::Unsafe);
        }
        let mut wire = Wire::launch(engine)?;
        let (protocol, catalog) = if engine.provider.disposition == Disposition::PiRpc {
            let catalog = pi::catalog(&mut wire).await?;
            if catalog.models.is_empty() {
                return Err(Error::AuthRequired);
            }
            (Protocol::Pi(wire), catalog)
        } else {
            let init = initialize(&mut wire).await?;
            let meta = &init["_meta"];
            if meta["grokShell"] != true || meta["agentVersion"] != "1.0.41" {
                return Err(Error::Unsafe);
            }
            // Grok 1.0.41 rejects an empty curated profile. Its denied placeholder keeps the tool set empty.
            let params = json!({
                "cwd":wire.cwd(), "mcpServers":[],
                "_meta":{"agentProfile":{
                    "name":"superbot-prompt", "description":"Prompt only",
                    "injectDefaultTools":false, "discoverSkills":false,
                    "toolConfig":{"tools":[{"id":"GrokBuild:read_file","name_override":"read_file"}]},
                    "tools":[], "disallowedTools":["read_file"]
                }}
            });
            let session = wire.request("session/new", params).await.map_err(|error| {
                if error == Error::Remote(-32000) {
                    Error::AuthRequired
                } else {
                    error
                }
            })?;
            let id = field(&session["sessionId"])
                .ok_or(Error::Protocol)?
                .to_owned();
            confirm_empty_mcp(&mut wire, &id).await?;
            (
                Protocol::Acp {
                    wire,
                    id,
                    scope: None,
                },
                Catalog::acp(&session),
            )
        };
        Ok(Self {
            protocol,
            catalog,
            usable: true,
        })
    }

    pub fn models(&self) -> &[Model] {
        &self.catalog.models
    }

    pub fn current_model(&self) -> Option<&str> {
        self.catalog.current.as_deref()
    }

    pub async fn prompt(
        &mut self,
        model: Option<&str>,
        text: &str,
        on_text: impl FnMut(&str),
    ) -> Result<Reply, Error> {
        self.prompt_until(model, text, on_text, pending()).await
    }

    pub async fn prompt_until(
        &mut self,
        model: Option<&str>,
        text: &str,
        mut on_text: impl FnMut(&str),
        cancelled: impl Future<Output = ()>,
    ) -> Result<Reply, Error> {
        if !self.usable {
            return Err(Error::Closed);
        }
        if let Some(model) = model {
            if !self.catalog.models.iter().any(|entry| entry.id == model) {
                return Err(Error::UnknownModel);
            }
            if matches!(self.protocol, Protocol::Acp { scope: None, .. })
                && self.current_model() != Some(model)
            {
                // Grok 1.0.41 can replace a scoped profile when session/set_model changes the model.
                return Err(Error::Unsafe);
            }
        }
        let model = model.or(self.current_model()).map(str::to_owned);
        self.usable = false;
        let result = tokio::select! {
            biased;
            _ = cancelled => Err(Error::Cancelled),
            result = async {
                match &mut self.protocol {
                    Protocol::Acp { wire, id, scope } => {
                        if let Some(scope) = scope {
                            if let Some(model) = model.as_deref().filter(|model| self.catalog.current.as_deref() != Some(*model)) {
                                scope.select_model(wire, id, model).await?;
                                self.catalog.current = Some(model.to_owned());
                            }
                            prompt_acp(wire, id, &literal_prompt(text), &mut on_text).await
                        } else {
                            confirm_empty_mcp(wire, id).await?;
                            prompt_acp(wire, id, text, &mut on_text).await
                        }
                    }
                    Protocol::Copilot(engine) => {
                        let model = model.as_deref().ok_or(Error::UnknownModel)?;
                        let reply = Restricted::copilot_prompt(engine, model, text).await?;
                        self.catalog.current = Some(model.to_owned());
                        on_text(&reply.text);
                        Ok(reply)
                    }
                    Protocol::Pi(wire) => {
                        if let Some(model) = model.as_deref() {
                            if self.catalog.current.as_deref() != Some(model) {
                                pi::select(wire, model).await?;
                                self.catalog.current = Some(model.to_owned());
                            }
                        }
                        pi::prompt(wire, text, &mut on_text).await
                    }
                    Protocol::GrokHeadless(headless) => {
                        let model = model.as_deref().ok_or(Error::UnknownModel)?;
                        let reply = headless.prompt(model, text).await?;
                        self.catalog.current = Some(model.to_owned());
                        on_text(&reply.text);
                        Ok(reply)
                    }
                }
            } => result,
        };
        if matches!(result, Err(Error::Cancelled)) {
            if let Protocol::Acp { wire, id, .. } = &mut self.protocol {
                let _ = timeout(
                    Duration::from_millis(250),
                    wire.write(json!({
                        "jsonrpc":"2.0", "method":"session/cancel", "params":{"sessionId":id}
                    })),
                )
                .await;
            }
        }
        self.usable = result.is_ok();
        if !self.usable {
            match &mut self.protocol {
                Protocol::Acp { wire, .. } | Protocol::Pi(wire) => wire.terminate(),
                Protocol::GrokHeadless(_) | Protocol::Copilot(_) => {}
            }
        }
        result
    }
}

async fn prompt_acp(
    wire: &mut Wire,
    id: &str,
    text: &str,
    on_text: &mut impl FnMut(&str),
) -> Result<Reply, Error> {
    let mut reply = String::new();
    let result = wire
        .acp(
            "session/prompt",
            json!({"sessionId":id, "prompt":[{"type":"text", "text":text}]}),
            TURN_TIMEOUT,
            |frame| {
                let params = &frame["params"];
                if frame["method"] == "session/update" && params["sessionId"] == id {
                    let update = &params["update"];
                    match update["sessionUpdate"].as_str() {
                        Some("tool_call" | "tool_call_update") => return Err(Error::Unsafe),
                        Some("agent_message_chunk") if update["content"]["type"] == "text" => {
                            if let Some(chunk) = update["content"]["text"].as_str() {
                                append(&mut reply, chunk, on_text)?;
                            }
                        }
                        _ => {}
                    }
                }
                Ok(())
            },
        )
        .await?;
    let stop_reason = field(&result["stopReason"]).ok_or(Error::Protocol)?;
    Ok(Reply {
        text: reply,
        stop_reason: stop_reason.to_owned(),
    })
}

pub(super) fn append(
    reply: &mut String,
    chunk: &str,
    on_text: &mut impl FnMut(&str),
) -> Result<(), Error> {
    if reply.len() + chunk.len() > MAX_REPLY {
        return Err(Error::Limit);
    }
    reply.push_str(chunk);
    on_text(chunk);
    Ok(())
}

async fn confirm_empty_mcp(wire: &mut Wire, id: &str) -> Result<(), Error> {
    timeout(Duration::from_secs(10), async {
        loop {
            let answer = wire
                .request("_x.ai/mcp/list", json!({"sessionId":id,"cache":true}))
                .await?;
            let catalog = answer.get("result").unwrap_or(&answer);
            let servers = catalog["servers"].as_array().ok_or(Error::Unsafe)?;
            if servers
                .iter()
                .any(|server| server["session"]["enabled"] != false)
            {
                return Err(Error::Unsafe);
            }
            if catalog["sessionMcpResolved"] == true {
                return Ok(());
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or(Err(Error::Unsafe))
}

pub(super) async fn verify_cursor(engine: &Engine) -> Result<(), Error> {
    let work = tempfile::tempdir().map_err(|_| Error::Start)?;
    let mut command = engine.command_base(work.path());
    command.arg("--version");
    let output = super::wire::run_command(command, super::wire::REQUEST_TIMEOUT).await?;
    let output = output.trim();
    if !output.bytes().take(4).all(|byte| byte.is_ascii_digit()) || output.get(4..5) != Some(".") {
        return Err(Error::Unsupported);
    }
    Ok(())
}
