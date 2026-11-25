use anyhow::{bail, Result};
use clap::Subcommand;
use serde::Serialize;
use serde_json::json;
use superbot_client::Agent;
use superbot_features::{BotConversation, SpaceFeatures, ThreadSnapshot, ThreadTarget};

use crate::{approvals, auth_hint, stream, terminal_text};

#[derive(Subcommand)]
pub(crate) enum ThreadsCommand {
    /// List an agent's conversations
    List { agent: String },
    /// Print the latest messages of an agent's conversation
    Show {
        agent: String,
        /// A conversation ID from the list; the first conversation when left out
        thread_id: Option<String>,
    },
}

/// One row of an agent's conversation list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Conversation {
    pub(crate) thread_id: String,
    /// The agent's first conversation, which `chat` and `send` open without `--conversation`.
    pub(crate) first: bool,
    pub(crate) title: Option<String>,
    pub(crate) preview: Option<String>,
}

impl Conversation {
    /// The name the conversation lists under, as the desktop names it.
    pub(crate) fn label(&self) -> &str {
        self.title
            .as_deref()
            .or(self.preview.as_deref())
            .filter(|label| !label.trim().is_empty())
            .unwrap_or(if self.first {
                "First conversation"
            } else {
                "New conversation"
            })
    }
}

/// The agent's first conversation, then its added ones that are not archived, newest first.
pub(crate) async fn conversations(
    space: &SpaceFeatures<'_>,
    agent: &Agent,
) -> Result<Vec<Conversation>> {
    let first = space
        .thread_head(ThreadTarget::Bot(&agent.id))
        .await
        .map_err(auth_hint)?;
    let added = space
        .bot_conversations(&agent.id)
        .await
        .map_err(auth_hint)?;
    Ok(list(&first.thread_id, added))
}

fn list(first: &str, added: Vec<BotConversation>) -> Vec<Conversation> {
    let mut rows = vec![Conversation {
        thread_id: first.to_owned(),
        first: true,
        title: None,
        preview: None,
    }];
    rows.extend(
        added
            .into_iter()
            .filter(|conversation| {
                conversation.archived_at.is_none() && conversation.thread_id != first
            })
            .map(|conversation| Conversation {
                thread_id: conversation.thread_id,
                first: false,
                title: conversation.title,
                preview: conversation.preview,
            }),
    );
    rows
}

pub(crate) fn print_conversations(rows: &[Conversation], json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(rows)?);
        return Ok(());
    }
    for row in rows {
        println!(
            "{}  {}",
            row.thread_id,
            list_label(&terminal_text(row.label()))
        );
    }
    Ok(())
}

const LABEL_CHARS: usize = 72;

/// A label's first line, cut to fit one terminal row.
fn list_label(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    if line.chars().count() <= LABEL_CHARS {
        return line.to_owned();
    }
    let cut: String = line.chars().take(LABEL_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

/// The target for an agent's conversation; the first one when no ID is given.
pub(crate) fn target_for<'a>(agent_id: &'a str, thread_id: Option<&'a str>) -> ThreadTarget<'a> {
    match thread_id {
        Some(thread_id) => ThreadTarget::BotConversation {
            bot_id: agent_id,
            thread_id,
        },
        None => ThreadTarget::Bot(agent_id),
    }
}

pub(crate) async fn show(
    space: &SpaceFeatures<'_>,
    agent: &Agent,
    thread_id: Option<&str>,
    json: bool,
) -> Result<()> {
    let snapshot = space
        .thread(target_for(&agent.id, thread_id))
        .await
        .map_err(auth_hint)?;
    if thread_id.is_some_and(|id| id != snapshot.thread_id) {
        bail!("The server did not open the requested conversation.");
    }
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&transcript_json(&snapshot))?
        );
    } else {
        print!("{}", transcript(&snapshot, &agent.name));
    }
    Ok(())
}

/// The snapshot's messages as transcript lines, leaving out messages without text.
pub(crate) fn transcript(snapshot: &ThreadSnapshot, agent_name: &str) -> String {
    let mut lines = String::new();
    for message in &snapshot.messages {
        let text = approvals::message_text(message);
        if text.trim().is_empty() {
            continue;
        }
        let name = stream::speaker(agent_name, &message.role, message.author.as_ref());
        lines.push_str(&format!(
            "{} > {}\n",
            terminal_text(name),
            terminal_text(&text)
        ));
    }
    lines
}

fn transcript_json(snapshot: &ThreadSnapshot) -> serde_json::Value {
    let messages: Vec<_> = snapshot
        .messages
        .iter()
        .map(|message| {
            json!({
                "id": message.id,
                "role": message.role,
                "author": message.author.as_ref().map(|author| json!({ "id": author.id, "name": author.name })),
                "text": approvals::message_text(message),
                "createdAt": message.created_at,
            })
        })
        .collect();
    json!({ "threadId": snapshot.thread_id, "messages": messages })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn added(id: &str, title: Option<&str>, archived: bool) -> BotConversation {
        BotConversation {
            thread_id: id.into(),
            bot_id: "bot-1".into(),
            created_at: "2026-11-20T00:00:00Z".into(),
            title: title.map(Into::into),
            pinned_at: None,
            archived_at: archived.then(|| "2026-11-21T00:00:00Z".into()),
            preview: Some("Last reply".into()),
        }
    }

    #[test]
    fn lists_the_first_conversation_then_open_added_ones() {
        let rows = list(
            "thread-1",
            vec![
                added("thread-3", Some("Launch plan"), false),
                added("thread-2", None, true),
                added("thread-4", None, false),
            ],
        );
        let labels: Vec<_> = rows
            .iter()
            .map(|row| (row.thread_id.as_str(), row.label()))
            .collect();
        assert_eq!(
            labels,
            [
                ("thread-1", "First conversation"),
                ("thread-3", "Launch plan"),
                ("thread-4", "Last reply")
            ]
        );
        assert!(rows[0].first && !rows[1].first);
        let untitled = Conversation {
            thread_id: "thread-5".into(),
            first: false,
            title: None,
            preview: Some("  ".into()),
        };
        assert_eq!(untitled.label(), "New conversation");
        assert_eq!(list_label("Plan\nsecond line"), "Plan");
        let long = list_label(&"word ".repeat(30));
        assert_eq!(long.chars().count(), LABEL_CHARS);
        assert!(long.ends_with("word…") || long.ends_with('…'));
    }

    #[test]
    fn transcript_names_speakers_and_skips_cards() {
        let snapshot: ThreadSnapshot = serde_json::from_value(json!({
            "threadId": "thread-1",
            "cursor": 4,
            "messages": [
                { "id": "m1", "threadId": "thread-1", "seq": 1, "role": "user", "createdAt": "2026-11-20T00:00:00Z",
                  "author": { "id": "user-1", "name": "Ada" }, "blocks": [{ "kind": "text", "text": "Hello" }] },
                { "id": "m2", "threadId": "thread-1", "seq": 2, "role": "bot", "createdAt": "2026-11-20T00:00:01Z",
                  "blocks": [{ "kind": "ask", "text": "Allow?" }] },
                { "id": "m3", "threadId": "thread-1", "seq": 3, "role": "bot", "createdAt": "2026-11-20T00:00:02Z",
                  "blocks": [{ "kind": "text", "text": "Hi Ada" }] },
            ],
        }))
        .unwrap();
        assert_eq!(
            transcript(&snapshot, "Research"),
            "Ada > Hello\nResearch > Hi Ada\n"
        );
        let json = transcript_json(&snapshot);
        assert_eq!(json["messages"][1]["text"], "");
        assert_eq!(json["messages"][0]["author"]["name"], "Ada");
    }
}
