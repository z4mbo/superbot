use anyhow::{bail, Result};
use futures_util::future::try_join_all;
use serde::Serialize;
use serde_json::Value;
use superbot_client::{Agent, Space};
use superbot_features::{
    Error, Features, SpaceFeatures, ThreadMessage, ThreadSnapshot, ThreadTarget,
};

use crate::{auth_hint, terminal_text};

#[derive(clap::Subcommand)]
pub(crate) enum ApprovalCommand {
    /// Allow the action once
    Allow { id: String },
    /// Deny the action
    Deny { id: String },
}

pub(crate) async fn run(
    features: &Features,
    catalog: &[(Space, Vec<Agent>)],
    command: Option<ApprovalCommand>,
    json: bool,
) -> Result<()> {
    let found = pending(features, catalog).await.map_err(auth_hint)?;
    let (id, answer) = match command {
        None if json => return crate::print_json(&found),
        None => {
            if found.is_empty() {
                println!("No approvals are waiting.");
            }
            for approval in &found {
                print!("{}", approval.lines());
            }
            return Ok(());
        }
        Some(ApprovalCommand::Allow { id }) => (id, "allow"),
        Some(ApprovalCommand::Deny { id }) => (id, "deny"),
    };
    let Some(approval) = found.iter().find(|approval| approval.id == id.trim()) else {
        bail!("No approval {id:?} is waiting. Run superbot approvals to list them.");
    };
    match resolve(features, approval, answer)
        .await
        .map_err(auth_hint)?
    {
        Outcome::Answered => {
            println!(
                "{}",
                if answer == "allow" {
                    "Allowed."
                } else {
                    "Denied."
                }
            );
            Ok(())
        }
        Outcome::Stale | Outcome::LeftPending => {
            bail!("This approval is no longer awaiting an answer.")
        }
    }
}

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

    fn card(&self) -> String {
        let mut card = String::from("Approval required\n");
        let mut detail = |value: &str| {
            for line in terminal_text(value).lines() {
                card.push_str(&format!("  {line}\n"));
            }
        };
        detail(self.title);
        if let Some(site) = self.site {
            detail(&format!("Site: {site}"));
        }
        if let Some(value) = self.detail {
            detail(value);
        }
        card
    }

    fn print(&self) {
        print!("{}", self.card());
        for (index, (_, label)) in self.actions.iter().enumerate() {
            println!("  {}. {}", index + 1, terminal_text(label));
        }
    }

    fn print_to_stderr(&self) {
        eprint!("{}", self.card());
    }
}

fn pending_ask(block: &Value) -> bool {
    block["kind"] == "ask"
        && (block["status"].is_null() || block["status"] == "pending")
        && ["answer", "dismissed", "expired"]
            .iter()
            .all(|key| block[*key].is_null())
}

/// The approval card a waiting run shows, when it is one this client can answer.
fn approval_in<'a>(snapshot: &'a ThreadSnapshot, run_id: &str) -> Option<Approval<'a>> {
    snapshot
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
        .and_then(Approval::from_message)
}

/// A card waiting on the signed-in person, wherever it is in the selected Spaces.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingApproval {
    /// The card's message ID, which `approvals allow` and `approvals deny` take.
    pub(crate) id: String,
    pub(crate) space_id: String,
    pub(crate) space_name: String,
    pub(crate) agent_id: String,
    pub(crate) agent_name: String,
    pub(crate) thread_id: String,
    /// Set for an added conversation; the agent's first conversation leaves it out.
    #[serde(skip)]
    pub(crate) conversation: Option<String>,
    pub(crate) run_id: String,
    pub(crate) title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) detail: Option<String>,
}

impl PendingApproval {
    pub(crate) fn target(&self) -> ThreadTarget<'_> {
        match &self.conversation {
            Some(thread_id) => ThreadTarget::BotConversation {
                bot_id: &self.agent_id,
                thread_id,
            },
            None => ThreadTarget::Bot(&self.agent_id),
        }
    }

    /// The text form of a card in a list: where it is, then what it asks.
    pub(crate) fn lines(&self) -> String {
        let mut lines = format!(
            "{}  {} / {}\n",
            self.id,
            terminal_text(&self.space_name),
            terminal_text(&self.agent_name)
        );
        for line in terminal_text(&self.title).lines() {
            lines.push_str(&format!("  {line}\n"));
        }
        if let Some(site) = &self.site {
            lines.push_str(&format!("  Site: {}\n", terminal_text(site)));
        }
        lines
    }
}

/// Collects the waiting approvals in one conversation's snapshot.
pub(crate) fn pending_in(
    snapshot: &ThreadSnapshot,
    space: &Space,
    agent: &Agent,
    conversation: Option<&str>,
) -> Vec<PendingApproval> {
    waiting_runs(snapshot)
        .filter_map(|run_id| {
            let approval = approval_in(snapshot, run_id)?;
            Some(PendingApproval {
                id: approval.message_id.to_owned(),
                space_id: space.id.clone(),
                space_name: space.name.clone(),
                agent_id: agent.id.clone(),
                agent_name: agent.name.clone(),
                thread_id: snapshot.thread_id.clone(),
                conversation: conversation.map(str::to_owned),
                run_id: run_id.to_owned(),
                title: approval.title.to_owned(),
                site: approval.site.map(str::to_owned),
                detail: approval.detail.map(str::to_owned),
            })
        })
        .collect()
}

/// Reads every open conversation of every agent in the catalog, agents side by side, and
/// returns the approvals waiting in them.
pub(crate) async fn pending(
    features: &Features,
    catalog: &[(Space, Vec<Agent>)],
) -> Result<Vec<PendingApproval>, Error> {
    let agents = catalog
        .iter()
        .flat_map(|(space, agents)| agents.iter().map(move |agent| (space, agent)));
    let found = try_join_all(agents.map(|(space, agent)| async move {
        let features = features.space(&space.id);
        let first = features.thread(ThreadTarget::Bot(&agent.id)).await?;
        let mut found = pending_in(&first, space, agent, None);
        for conversation in features.bot_conversations(&agent.id).await? {
            if conversation.archived_at.is_some() || conversation.thread_id == first.thread_id {
                continue;
            }
            let target = ThreadTarget::BotConversation {
                bot_id: &agent.id,
                thread_id: &conversation.thread_id,
            };
            let snapshot = features.thread(target).await?;
            found.extend(pending_in(
                &snapshot,
                space,
                agent,
                Some(&conversation.thread_id),
            ));
        }
        Ok::<_, Error>(found)
    }))
    .await?;
    Ok(found.into_iter().flatten().collect())
}

/// Answers a listed card with `allow` or `deny`.
pub(crate) async fn resolve(
    features: &Features,
    approval: &PendingApproval,
    answer: &str,
) -> Result<Outcome, Error> {
    match features
        .space(&approval.space_id)
        .answer_thread_card(approval.target(), &approval.run_id, &approval.id, answer)
        .await
    {
        Ok(()) => Ok(Outcome::Answered),
        Err(Error::Server { status: 409, .. }) => Ok(Outcome::Stale),
        Err(error) => Err(error),
    }
}

/// Prints the card for a reply that stopped on it, with the commands that answer it.
pub(crate) fn print_waiting(snapshot: &ThreadSnapshot, run_id: &str) {
    match approval_in(snapshot, run_id) {
        Some(approval) => {
            approval.print_to_stderr();
            eprintln!(
                "Answer with superbot approvals allow {id} or superbot approvals deny {id}",
                id = approval.message_id
            );
        }
        None => eprintln!("The agent is waiting for input. Open Superbot to answer this card."),
    }
}

/// The waiting card as `send --json` reports it.
pub(crate) fn waiting_json(snapshot: &ThreadSnapshot, run_id: &str) -> Value {
    approval_in(snapshot, run_id).map_or(Value::Null, |approval| {
        serde_json::json!({
            "id": approval.message_id,
            "title": approval.title,
            "site": approval.site,
            "detail": approval.detail,
        })
    })
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
    let Some(approval) = approval_in(snapshot, run_id) else {
        eprintln!("The agent is waiting for input. Open Superbot to answer this card.");
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
