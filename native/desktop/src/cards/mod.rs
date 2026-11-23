//! Question cards an agent puts in a conversation: a question answered in the person's own
//! words, one answered by picking an option, a protected value typed into a masked field, and
//! the first-run focus choice. Approvals keep their own card in the transcript.

mod answer;
mod state;
mod view;

use serde_json::Value;

pub use state::Cards;

use crate::transcript::CardAction;

/// A question card the desktop answers itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Question {
    pub text: String,
    pub detail: Option<String>,
    /// The detail is code or data, shown in the mono face.
    pub detail_code: bool,
    pub kind: QuestionKind,
    /// How the server says the card ended; `None` while it waits.
    pub settled: Option<Settled>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QuestionKind {
    /// Answered in the person's own words.
    Typed,
    /// Answered by picking one of the agent's options.
    Options(Vec<CardAction>),
    /// A protected value, typed into a masked field and never shown again.
    Secret(SecretAsk),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretAsk {
    /// The masked field's name: what kind of value it takes.
    pub label: &'static str,
    /// Where the value goes: a site, a command variable, or the site a code is for.
    pub destination: Option<String>,
    /// A one-time code is used once and not saved.
    pub one_time: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Settled {
    /// A typed answer, or the id or label of the chosen option.
    Answered(String),
    /// A protected value the server saved for the agent.
    Saved,
    /// A protected value used for this run only.
    Sent,
    Dismissed,
    /// Nobody answered before the run gave up waiting.
    Expired,
}

/// The first-run focus card: the agent's options, answered once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub question: String,
    pub subtitle: Option<String>,
    pub options: Vec<ChoiceOption>,
    pub chosen: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChoiceOption {
    pub id: String,
    pub letter: String,
    pub label: String,
}

/// What the person sends back.
pub enum Reply {
    Text(String),
    Option(String),
    /// Held only until the request is made; never logged, stored or echoed.
    Secret(String),
    DismissSecret,
}

fn text(block: &Value, key: &str) -> Option<String> {
    block.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
}

/// Kinds of protected value whose form lives in the web app's vault editor.
const VAULT_FORMS: [&str; 3] = ["login", "card", "contact"];

/// An `ask` block this module draws, or `None` for an approval or a vault form, which keep
/// the transcript's own card.
pub fn read_question(block: &Value) -> Option<Question> {
    let approval = ["approvalEffectId", "instructionUpdate", "settingsUpdate", "outgoingDraft", "receipt"]
        .iter()
        .any(|key| block.get(*key).is_some());
    if approval {
        return None;
    }
    let answered = block.get("status").and_then(Value::as_str) == Some("answered");
    let flag = |key: &str| block.get(key).and_then(Value::as_bool) == Some(true);
    let expired = flag("expired");
    let dismissed = flag("dismissed");
    let detail = text(block, "detail");
    let detail_code = block.get("detailFormat").and_then(Value::as_str) != Some("text");

    if block.get("input").and_then(Value::as_str) == Some("secret") {
        let credential = block.get("credential");
        let auth = credential.and_then(|credential| credential.pointer("/auth/type")).and_then(Value::as_str);
        if auth.is_some_and(|auth| VAULT_FORMS.contains(&auth)) {
            return None;
        }
        let code_origin = block.pointer("/oneTimeCode/origin").and_then(Value::as_str);
        let one_time = code_origin.is_some();
        let destination = if let Some(origin) = code_origin {
            Some(format!("Only enter a code {} sent you.", host(origin)))
        } else if auth == Some("command") {
            credential
                .and_then(|credential| credential.get("name"))
                .and_then(Value::as_str)
                .map(|name| format!("Command variable ${}", name.to_uppercase().replace('-', "_")))
        } else {
            credential.and_then(|credential| text(credential, "origin"))
        };
        let label = match block.get("purpose").and_then(Value::as_str) {
            Some("password") => "Password",
            Some("api_key") => "API key",
            _ => "Code",
        };
        let remembered = block.get("remembered").and_then(Value::as_bool) != Some(false);
        let settled = (answered || dismissed || expired).then(|| {
            if dismissed {
                Settled::Dismissed
            } else if expired {
                Settled::Expired
            } else if one_time || !remembered {
                Settled::Sent
            } else {
                Settled::Saved
            }
        });
        return Some(Question {
            text: text(block, "text")?,
            detail: detail.filter(|_| one_time),
            detail_code: false,
            kind: QuestionKind::Secret(SecretAsk { label, destination, one_time }),
            settled,
        });
    }

    let actions: Vec<CardAction> = block
        .get("actions")
        .and_then(Value::as_array)
        .map(|actions| {
            actions
                .iter()
                .filter_map(|action| {
                    Some(CardAction {
                        id: action.get("id")?.as_str()?.to_owned(),
                        label: action.get("label")?.as_str()?.to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let settled = if expired {
        Some(Settled::Expired)
    } else if dismissed {
        Some(Settled::Dismissed)
    } else {
        answered.then(|| Settled::Answered(text(block, "answer").unwrap_or_default()))
    };
    Some(Question {
        text: text(block, "text")?,
        detail,
        detail_code,
        kind: if actions.is_empty() { QuestionKind::Typed } else { QuestionKind::Options(actions) },
        settled,
    })
}

/// A `choice` block, or `None` once the person put it away.
pub fn read_choice(block: &Value) -> Option<Choice> {
    let chosen = text(block, "answerId");
    if chosen.as_deref() == Some("_dismissed") {
        return None;
    }
    let options = block
        .get("options")?
        .as_array()?
        .iter()
        .filter_map(|option| {
            Some(ChoiceOption {
                id: option.get("id")?.as_str()?.to_owned(),
                letter: option.get("letter")?.as_str()?.to_owned(),
                label: option.get("label")?.as_str()?.to_owned(),
            })
        })
        .collect::<Vec<_>>();
    (!options.is_empty()).then(|| Choice {
        question: text(block, "question").unwrap_or_default(),
        subtitle: text(block, "subtitle"),
        options,
        chosen,
    })
}

/// The option an answer names: by id, or by its label as the agent may have been answered in words.
pub fn chosen_option<'a>(answer: &str, options: &'a [CardAction]) -> Option<&'a CardAction> {
    let answer = answer.trim();
    options
        .iter()
        .find(|option| option.id == answer)
        .or_else(|| options.iter().find(|option| option.label.trim().eq_ignore_ascii_case(answer)))
}

fn host(origin: &str) -> &str {
    let rest = origin.split_once("://").map_or(origin, |(_, rest)| rest);
    rest.split(['/', '?', '#']).next().unwrap_or(rest)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{chosen_option, read_choice, read_question, QuestionKind, Settled};
    use crate::transcript::CardAction;

    #[test]
    fn approvals_and_vault_forms_keep_the_transcript_card() {
        let allow = json!({ "kind": "ask", "text": "Use the tool?", "approvalEffectId": "effect",
            "actions": [{ "id": "allow", "label": "Allow once" }, { "id": "deny", "label": "Deny" }] });
        assert_eq!(read_question(&allow), None);
        let login = json!({ "kind": "ask", "text": "Sign in", "input": "secret",
            "credential": { "name": "site", "origin": "https://login.example.test", "auth": { "type": "login" } } });
        assert_eq!(read_question(&login), None);
    }

    #[test]
    fn a_question_is_typed_or_picked_by_its_options() {
        let typed =
            read_question(&json!({ "kind": "ask", "text": "Which city?", "detail": "Reply with one city name.",
            "detailFormat": "text" }))
            .unwrap();
        assert_eq!(typed.kind, QuestionKind::Typed);
        assert!(!typed.detail_code);
        assert_eq!(typed.settled, None);

        let picked = read_question(&json!({ "kind": "ask", "text": "Which city?", "status": "answered",
            "answer": "choice-2", "actions": [{ "id": "choice-1", "label": "Berlin" }, { "id": "choice-2", "label": "Seoul" }] }))
        .unwrap();
        let QuestionKind::Options(options) = &picked.kind else { panic!("options") };
        assert_eq!(picked.settled, Some(Settled::Answered("choice-2".into())));
        assert_eq!(chosen_option("choice-2", options).map(|option| option.label.as_str()), Some("Seoul"));
        assert_eq!(chosen_option(" seoul ", options).map(|option| option.id.as_str()), Some("choice-2"));
        assert_eq!(chosen_option("Paris", options), None::<&CardAction>);
    }

    #[test]
    fn a_secret_names_its_field_and_destination_and_never_its_value() {
        let key = read_question(&json!({ "kind": "ask", "text": "API key", "input": "secret", "purpose": "api_key",
            "credential": { "name": "example_api", "origin": "https://api.example.test", "auth": { "type": "bearer" } } }))
        .unwrap();
        let QuestionKind::Secret(secret) = &key.kind else { panic!("secret") };
        assert_eq!(secret.label, "API key");
        assert_eq!(secret.destination.as_deref(), Some("https://api.example.test"));

        let command = read_question(&json!({ "kind": "ask", "text": "Deploy key", "input": "secret",
            "credential": { "name": "deploy-key", "auth": { "type": "command" } }, "status": "answered" }))
        .unwrap();
        let QuestionKind::Secret(secret) = &command.kind else { panic!("secret") };
        assert_eq!(secret.destination.as_deref(), Some("Command variable $DEPLOY_KEY"));
        assert_eq!(command.settled, Some(Settled::Saved));

        let code = read_question(&json!({ "kind": "ask", "text": "Code", "input": "secret", "purpose": "otp",
            "oneTimeCode": { "origin": "https://shop.example.test" }, "dismissed": true, "status": "answered" }))
        .unwrap();
        let QuestionKind::Secret(secret) = &code.kind else { panic!("secret") };
        assert_eq!(secret.destination.as_deref(), Some("Only enter a code shop.example.test sent you."));
        assert_eq!(code.settled, Some(Settled::Dismissed));
        assert!(!format!("{code:?}").contains("answer\""));
    }

    #[test]
    fn a_dismissed_focus_choice_leaves_the_transcript() {
        let block = json!({ "kind": "choice", "question": "What do you want me on first?",
            "options": [{ "id": "inbox", "letter": "A", "label": "Inbox" }] });
        assert_eq!(read_choice(&block).unwrap().options[0].label, "Inbox");
        let mut dismissed = block.clone();
        dismissed["answerId"] = json!("_dismissed");
        assert_eq!(read_choice(&dismissed), None);
    }
}
