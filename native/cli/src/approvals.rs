use anyhow::Result;
use serde_json::Value;
use superbot_features::{Error, SpaceFeatures, ThreadMessage, ThreadSnapshot, ThreadTarget};

use crate::terminal_text;

pub(crate) enum Outcome {
    Answered,
    LeftPending,
    Stale,
}

pub(crate) fn waiting_runs(snapshot: &ThreadSnapshot) -> impl Iterator<Item = &str> {
    snapshot
        .active_runs
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|run| run["status"] == "waiting_input")
        .filter_map(|run| run["id"].as_str())
}

pub(crate) fn message_text(message: &ThreadMessage) -> String {
    message
        .blocks
        .iter()
        .filter(|block| block["kind"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

struct Approval<'a> {
    message_id: &'a str,
    title: &'a str,
    site: Option<&'a str>,
    detail: Option<&'a str>,
    actions: [(&'a str, &'a str); 2],
}

impl<'a> Approval<'a> {
    fn from_message(message: &'a ThreadMessage) -> Option<Self> {
        let block = message.blocks.iter().find(|block| pending_ask(block))?;
        if message
            .blocks
            .iter()
            .filter(|block| pending_ask(block))
            .count()
            != 1
            || block["approvalEffectId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .is_none()
            || !block["input"].is_null()
            || [
                "receipt",
                "outgoingDraft",
                "instructionUpdate",
                "settingsUpdate",
                "credential",
                "oneTimeCode",
                "loginFields",
            ]
            .iter()
            .any(|key| !block[*key].is_null())
        {
            return None;
        }
        let actions = block["actions"].as_array()?;
        let action = |id, label| {
            let mut matches = actions.iter().filter(|action| action["id"] == id);
            let action = matches.next()?;
            if matches.next().is_some() || action["label"] != label {
                return None;
            }
            Some((action["id"].as_str()?, action["label"].as_str()?))
        };
        Some(Self {
            message_id: &message.id,
            title: block["text"].as_str()?,
            site: block["site"].as_str(),
            detail: block["detail"].as_str(),
            actions: [action("allow", "Allow once")?, action("deny", "Deny")?],
        })
    }

    fn print(&self) {
        println!("Approval required");
        print_detail(self.title);
        if let Some(site) = self.site {
            print_detail(&format!("Site: {site}"));
        }
        if let Some(detail) = self.detail {
            print_detail(detail);
        }
        for (index, (_, label)) in self.actions.iter().enumerate() {
            println!("  {}. {}", index + 1, terminal_text(label));
        }
    }
}

fn print_detail(value: &str) {
    for line in terminal_text(value).lines() {
        println!("  {line}");
    }
}

fn pending_ask(block: &Value) -> bool {
    block["kind"] == "ask"
        && (block["status"].is_null() || block["status"] == "pending")
        && ["answer", "dismissed", "expired"]
            .iter()
            .all(|key| block[*key].is_null())
}

pub(crate) async fn offer(
    space: &SpaceFeatures<'_>,
    target: ThreadTarget<'_>,
    snapshot: &ThreadSnapshot,
    run_id: &str,
    interactive: bool,
    read: &mut impl AsyncFnMut() -> Result<Option<String>>,
) -> Result<Outcome, Error> {
    if !waiting_runs(snapshot).any(|id| id == run_id) {
        return Ok(Outcome::Stale);
    }
    let approval = snapshot
        .messages
        .iter()
        .filter(|message| {
            message.run_id.as_deref() == Some(run_id)
                && message.role == "bot"
                && message.blocks.iter().any(|block| {
                    matches!(
                        block["kind"].as_str(),
                        Some(
                            "ask"
                                | "choice"
                                | "tool_question"
                                | "mcp_approval"
                                | "app_connect"
                                | "connect"
                        )
                    )
                })
        })
        .max_by_key(|message| message.seq)
        .and_then(Approval::from_message);
    let Some(approval) = approval else {
        eprintln!("The agent is waiting for input. Open Rakazo to answer this card.");
        return Ok(Outcome::LeftPending);
    };
    approval.print();
    if !interactive {
        eprintln!("Approval left pending. Reopen the chat in an interactive terminal to answer.");
        return Ok(Outcome::LeftPending);
    }

    let decision = match read().await {
        Ok(decision) => decision,
        Err(error) => {
            eprintln!(
                "Could not read the approval choice. {}",
                terminal_text(&format!("{error:#}"))
            );
            return Ok(Outcome::LeftPending);
        }
    };
    let selected = match decision.as_deref().map(str::trim) {
        Some("1") => Some(approval.actions[0].0),
        Some("2") => Some(approval.actions[1].0),
        _ => None,
    };
    let Some(selected) = selected else {
        eprintln!("Approval left pending.");
        return Ok(Outcome::LeftPending);
    };
    match space
        .answer_thread_card(target, run_id, approval.message_id, selected)
        .await
    {
        Ok(()) => Ok(Outcome::Answered),
        Err(Error::Server { status: 409, .. }) => {
            eprintln!("This approval is no longer awaiting an answer.");
            Ok(Outcome::LeftPending)
        }
        Err(error) => Err(error),
    }
}
