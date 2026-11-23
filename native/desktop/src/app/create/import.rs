use std::collections::HashSet;

use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::*;
use serde::Deserialize;
use serde_json::{json, Value};

use super::folder::{self, FolderError, Upload};
use super::{Desktop, Panel};
use crate::api::{self, Target};

const BOT_DESCRIPTION_MAX_LENGTH: usize = 4000;

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Status {
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub stock: bool,
    #[serde(default)]
    pub contains_key: Option<bool>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub status: Option<Status>,
}

impl PlanItem {
    fn holds_key(&self) -> bool {
        self.contains_key == Some(true)
    }

    fn unsupported(&self) -> bool {
        self.status.as_ref().is_some_and(|status| status.kind == "unsupported")
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct PlanModel {
    pub id: String,
    pub title: String,
    pub status: String,
}

/// What `bots.importPreview` found in a folder.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub suggested_name: String,
    #[serde(default)]
    pub suggested_description: String,
    #[serde(default)]
    pub instructions: Vec<PlanItem>,
    #[serde(default)]
    pub memory: Vec<PlanItem>,
    #[serde(default)]
    pub skills: Vec<PlanItem>,
    #[serde(default)]
    pub model: Option<PlanModel>,
    #[serde(default)]
    pub mcp_servers: Vec<PlanItem>,
    #[serde(default)]
    pub routines: Vec<PlanItem>,
    #[serde(default)]
    pub api_keys: Vec<PlanItem>,
    #[serde(default)]
    pub leftovers: Vec<PlanItem>,
    #[serde(default)]
    pub skipped: Vec<serde::de::IgnoredAny>,
}

/// The server's web client's starting choices: everything but untouched defaults the source
/// wrote, skills that run code or bring files, and text that looks like it holds a key.
pub fn left_out(plan: &Plan) -> HashSet<String> {
    let skills = plan
        .skills
        .iter()
        .filter(|item| item.warnings.iter().any(|warning| warning == "runs_code" || warning == "bundled_files"));
    let stock = plan.instructions.iter().chain(&plan.memory).filter(|item| item.stock);
    let keyed = plan.instructions.iter().chain(&plan.memory).chain(&plan.skills).filter(|item| item.holds_key());
    let routines = plan.routines.iter().filter(|item| looks_like_credential(&item.content));
    skills.chain(stock).chain(keyed).chain(routines).map(|item| item.id.clone()).collect()
}

pub fn selection(plan: &Plan, left_out: &HashSet<String>) -> Value {
    let kept = |items: &[PlanItem]| -> Vec<String> {
        items.iter().filter(|item| !left_out.contains(&item.id)).map(|item| item.id.clone()).collect()
    };
    let runnable = |items: &[PlanItem]| -> Vec<String> {
        items
            .iter()
            .filter(|item| !left_out.contains(&item.id) && !item.unsupported())
            .map(|item| item.id.clone())
            .collect()
    };
    let memory: Vec<Value> =
        kept(&plan.memory).into_iter().map(|id| json!({ "id": id, "destination": "bot" })).collect();
    let model = plan.model.as_ref().is_some_and(|model| model.status == "ready" && !left_out.contains(&model.id));
    json!({
        "instructions": kept(&plan.instructions),
        "memory": memory,
        "skills": runnable(&plan.skills),
        "model": model,
        "mcpServers": runnable(&plan.mcp_servers),
        "routines": kept(&plan.routines),
        "apiKeys": kept(&plan.api_keys),
        "leftovers": kept(&plan.leftovers),
    })
}

fn word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn run(bytes: &[u8], from: usize, class: impl Fn(u8) -> bool) -> usize {
    bytes.get(from..).map_or(0, |rest| rest.iter().take_while(|byte| class(**byte)).count())
}

fn random(value: &[u8]) -> bool {
    value.iter().any(u8::is_ascii_alphabetic)
        && value.iter().any(u8::is_ascii_digit)
        && value.iter().collect::<HashSet<_>>().len() > 4
}

/// Text shaped like a well-known credential, as `looksLikeCredential` in the server's core
/// judges it. Never returns the value.
pub fn looks_like_credential(text: &str) -> bool {
    let bytes = text.as_bytes();
    let alnum = |byte: u8| byte.is_ascii_alphanumeric();
    let key = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-';
    (0..bytes.len()).any(|at| {
        let rest = &bytes[at..];
        let before = at.checked_sub(1).map(|index| bytes[index]);
        let boundary = !before.is_some_and(word);
        let prefixed = |prefix: &[u8], least: usize, class: &dyn Fn(u8) -> bool| {
            boundary && rest.starts_with(prefix) && run(bytes, at + prefix.len(), class) >= least
        };
        if rest.starts_with(b"sk-") && !before.is_some_and(|byte| word(byte) || byte == b'-') {
            let body = &rest[3..3 + run(bytes, at + 3, key)];
            let api = body.len() >= 12
                && body.starts_with(b"ant-api")
                && body[7].is_ascii_digit()
                && body[8].is_ascii_digit()
                && body[9] == b'-';
            let prefix = if api {
                10
            } else {
                [&b"ant-"[..], b"or-v1-", b"proj-"]
                    .iter()
                    .find(|prefix| body.starts_with(prefix))
                    .map_or(0, |prefix| prefix.len())
            };
            let captured =
                if body.len() - prefix >= 20 { Some(&body[prefix..]) } else { (body.len() >= 20).then_some(body) };
            if captured.is_some_and(random) {
                return true;
            }
        }
        let github = boundary
            && rest.len() > 4
            && rest.starts_with(b"gh")
            && b"pousr".contains(&rest[2])
            && rest[3] == b'_'
            && run(bytes, at + 4, alnum) >= 36;
        let slack = boundary
            && rest.len() > 4
            && rest.starts_with(b"xox")
            && b"abposr".contains(&rest[3])
            && rest[4] == b'-'
            && run(bytes, at + 5, |byte| byte.is_ascii_alphanumeric() || byte == b'-') >= 10;
        let aws = boundary && (rest.starts_with(b"AKIA") || rest.starts_with(b"ASIA")) && {
            let upper = run(bytes, at + 4, |byte| byte.is_ascii_digit() || byte.is_ascii_uppercase());
            upper >= 16 && !bytes.get(at + 20).copied().is_some_and(word)
        };
        let google = boundary
            && rest.starts_with(b"AIza")
            && run(bytes, at + 4, key) >= 35
            && !bytes.get(at + 39).copied().is_some_and(key);
        let stripe = boundary
            && rest.len() > 8
            && (rest[0] == b'r' || rest[0] == b's')
            && rest[1..].starts_with(b"k_live_")
            && run(bytes, at + 8, alnum) >= 20;
        let private_key = rest.starts_with(b"-----BEGIN ") && {
            let length = run(bytes, at + 11, |byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b' ');
            let named = &rest[11..11 + length];
            named.ends_with(b"PRIVATE KEY") && rest[11 + length..].starts_with(b"-----")
        };
        let bearer = boundary && rest.len() > 6 && rest[..6].eq_ignore_ascii_case(b"bearer") && {
            let gap = run(bytes, at + 6, |byte| byte.is_ascii_whitespace());
            let token = |byte: u8| byte.is_ascii_alphanumeric() || b"._~+/-".contains(&byte);
            let length = run(bytes, at + 6 + gap, token);
            let padding = run(bytes, at + 6 + gap + length, |byte| byte == b'=');
            gap > 0 && length >= 24 && random(&rest[6 + gap..6 + gap + length + padding])
        };
        github
            || prefixed(b"github_pat_", 22, &|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            || slack
            || aws
            || google
            || prefixed(b"glpat-", 20, &key)
            || prefixed(b"hf_", 30, &alnum)
            || stripe
            || private_key
            || bearer
    })
}

pub enum Busy {
    Reading,
    Previewing,
    Adding,
}

pub struct Reviewing {
    pub upload: Upload,
    pub plan: Plan,
    pub left_out: HashSet<String>,
    pub name: Entity<InputState>,
    /// One per import, so a retried create returns the bot the first one made.
    key: String,
    _submit: Subscription,
}

pub enum ImportStep {
    Choose,
    Review(Box<Reviewing>),
}

pub struct Import {
    pub step: ImportStep,
    pub busy: Option<Busy>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct Made {
    id: String,
}

impl Desktop {
    pub fn open_import(&mut self, cx: &mut Context<Self>) {
        self.create.panel = Some(Panel::Import(Import { step: ImportStep::Choose, busy: None, error: None }));
        cx.notify();
    }

    fn import_mut(&mut self) -> Option<&mut Import> {
        match self.create.panel.as_mut() {
            Some(Panel::Import(import)) => Some(import),
            _ => None,
        }
    }

    pub fn choose_import_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(import) = self.import_mut().filter(|import| import.busy.is_none()) else { return };
        import.error = None;
        let chosen = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose folder".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = chosen.await else { return };
            let Some(root) = paths.into_iter().next() else { return };
            let reading = this.update(cx, |this, cx| {
                let Some(import) = this.import_mut().filter(|import| import.busy.is_none()) else { return false };
                import.busy = Some(Busy::Reading);
                cx.notify();
                true
            });
            if !matches!(reading, Ok(true)) {
                return;
            }
            let read = cx.background_executor().spawn(async move { folder::read_agent_folder(&root) }).await;
            this.update_in(cx, |this, window, cx| this.preview_import(read, window, cx)).ok();
        })
        .detach();
    }

    fn preview_import(&mut self, read: Result<Upload, FolderError>, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(import) = self.import_mut() else { return };
        let upload = match read {
            Ok(upload) => upload,
            Err(error) => {
                import.busy = None;
                import.error = Some(error.sentence().into());
                cx.notify();
                return;
            }
        };
        import.busy = Some(Busy::Previewing);
        let input = json!({ "files": upload.files, "includeSecrets": false, "skillFiles": upload.skill_files });
        let work = async move { api.client.rpc::<Plan>("bots/importPreview", Some(&space_id), input).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            let name = match &result {
                Ok(plan) => {
                    let suggested = plan.suggested_name.clone();
                    Some(cx.new(|cx| InputState::new(window, cx).default_value(suggested)))
                }
                Err(_) => None,
            };
            let submit = name.as_ref().map(|name| {
                cx.subscribe_in(name, window, |this, _, event: &InputEvent, window, cx| {
                    if let InputEvent::PressEnter { .. } = event {
                        this.add_import(window, cx);
                    }
                })
            });
            let Some(import) = this.import_mut() else { return };
            import.busy = None;
            match (result, name, submit) {
                (Ok(plan), Some(name), Some(submit)) => {
                    let left_out = left_out(&plan);
                    import.step = ImportStep::Review(Box::new(Reviewing {
                        upload,
                        plan,
                        left_out,
                        name,
                        key: uuid::Uuid::new_v4().to_string(),
                        _submit: submit,
                    }));
                }
                (Err(error), _, _) => import.error = Some(api::explain(&error)),
                _ => {}
            }
        });
        cx.notify();
    }

    pub fn back_to_import(&mut self, cx: &mut Context<Self>) {
        let Some(import) = self.import_mut().filter(|import| import.busy.is_none()) else { return };
        import.step = ImportStep::Choose;
        import.error = None;
        cx.notify();
    }

    pub fn add_import(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(import) = self.import_mut().filter(|import| import.busy.is_none()) else { return };
        let ImportStep::Review(review) = &import.step else { return };
        let name = review.name.read(cx).value().trim().to_owned();
        let description: String =
            review.plan.suggested_description.trim().chars().take(BOT_DESCRIPTION_MAX_LENGTH).collect();
        let input = json!({
            "importKey": review.key,
            "files": review.upload.files,
            "includeSecrets": false,
            "skillFiles": review.upload.skill_files,
            "name": name,
            "description": description,
            "computerMode": "team",
            "selection": selection(&review.plan, &review.left_out),
        });
        if name.is_empty() {
            import.error = Some("Enter a name.".into());
            cx.notify();
            return;
        }
        import.busy = Some(Busy::Adding);
        import.error = None;
        let space = space_id.clone();
        let work = async move {
            let bot: Made = api.client.rpc("bots/importCreate", Some(&space), input).await?;
            Ok((bot.id, api.navigation(Some(&space)).await?))
        };
        self.call(window, cx, work, move |this, result, window, cx| match result {
            Ok((bot_id, navigation)) => {
                this.create.panel = None;
                this.apply_navigation(navigation);
                this.arrived(&space_id, &bot_id);
                this.open(Target::Agent(bot_id), window, cx);
                this.notify("Added", false, None, cx);
            }
            Err(error) => {
                if let Some(import) = this.import_mut() {
                    import.busy = None;
                    import.error = Some(api::explain(&error));
                }
            }
        });
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::{left_out, looks_like_credential, selection, Plan};

    fn plan() -> Plan {
        serde_json::from_str(
            r#"{
            "source": "openclaw",
            "suggestedName": "Molty",
            "instructions": [
                { "id": "i1", "title": "SOUL.md", "content": "", "stock": false },
                { "id": "i2", "title": "AGENTS.md", "content": "", "stock": true },
                { "id": "i3", "title": "TOOLS.md", "content": "", "containsKey": true }
            ],
            "memory": [{ "id": "m1", "title": "MEMORY.md", "content": "", "path": "MEMORY.md", "spacePath": "MEMORY.md" }],
            "skills": [
                { "id": "s1", "title": "a", "name": "a", "description": "", "content": "", "warnings": ["runs_code"] },
                { "id": "s2", "title": "b", "name": "b", "description": "", "content": "", "status": { "kind": "unsupported" } },
                { "id": "s3", "title": "c", "name": "c", "description": "", "content": "" }
            ],
            "model": { "id": "model", "title": "x/y", "provider": "x", "modelId": "y", "status": "ready" },
            "mcpServers": [],
            "routines": [
                { "id": "r1", "title": "Daily", "content": "Every day: sum up" },
                { "id": "r2", "title": "Keyed", "content": "-----BEGIN TEST PRIVATE KEY-----" }
            ],
            "apiKeys": [],
            "leftovers": [{ "id": "l1", "title": "BOOT.md", "content": "" }],
            "skipped": [{ "path": "README.md", "reason": "invalid_file" }]
        }"#,
        )
        .unwrap()
    }

    #[test]
    fn an_import_starts_with_the_web_clients_choices() {
        let plan = plan();
        let out = left_out(&plan);
        let mut ids: Vec<&str> = out.iter().map(String::as_str).collect();
        ids.sort();
        assert_eq!(ids, ["i2", "i3", "r2", "s1"]);
        let expected: Value = serde_json::from_str(
            r#"{ "instructions": ["i1"], "memory": [{ "id": "m1", "destination": "bot" }], "skills": ["s3"],
                 "model": true, "mcpServers": [], "routines": ["r1"], "apiKeys": [], "leftovers": ["l1"] }"#,
        )
        .unwrap();
        assert_eq!(selection(&plan, &out), expected);
    }

    #[test]
    fn credential_shapes_match_the_servers_check() {
        for (prefix, length) in [
            ("sk-", 20),
            ("sk-ant-api03-", 20),
            ("ghp_", 36),
            ("github_pat_", 22),
            ("xoxb-", 10),
            ("AKIA", 16),
            ("AIza", 35),
            ("glpat-", 20),
            ("hf_", 30),
            ("sk_live_", 20),
            ("Bearer ", 24),
        ] {
            let body: String = "TEST012345".chars().cycle().take(length).collect();
            let example = format!("{prefix}{body}");
            assert!(looks_like_credential(&example), "prefix {prefix}");
            if matches!(prefix, "AKIA" | "AIza") {
                assert!(!looks_like_credential(&format!("{example}A")));
            }
        }
        assert!(looks_like_credential("-----BEGIN RSA PRIVATE KEY-----"));
        for plain in [
            "sk-...",
            "sk-your-key-here",
            "Bearer <token>",
            "task-sk-proj-a1b2c3d4e5f6g7h8i9j0k1l2",
            "-----BEGIN PUBLIC KEY-----",
            "Every day: sum up",
        ] {
            assert!(!looks_like_credential(plain), "{plain}");
        }
    }
}
