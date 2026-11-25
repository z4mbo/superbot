use std::{
    io::{self, IsTerminal, Read},
    time::Duration,
};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use superbot_client::{Client, SendReceipt};
use superbot_features::Features;
use uuid::Uuid;

use crate::stream::{LinePrinter, Reply, RunEnd, Sink, Update};
use crate::{
    approvals, auth_hint, discover, find_agent, follow_until_waiting, local_chat, terminal_text,
    ChatThread, Exit,
};

/// Exit status of a `send` whose reply stopped on a card that needs an answer.
pub(crate) const WAITING_EXIT: u8 = 3;
const REPLY_BUDGET: Duration = Duration::from_secs(600);

pub(crate) struct SendArgs {
    pub(crate) agent: String,
    pub(crate) message: Vec<String>,
    pub(crate) new_conversation: bool,
    pub(crate) conversation: Option<String>,
}

/// Joins the words given on the command line, or reads the message from redirected input.
fn message_text(words: Vec<String>, stdin: impl FnOnce() -> io::Result<String>) -> Result<String> {
    let text = if words.is_empty() {
        stdin().context("Could not read the message from standard input")?
    } else {
        words.join(" ")
    };
    if text.trim().is_empty() {
        bail!("Type a message after the agent name, or pipe one in.");
    }
    Ok(text)
}

/// Records what a reply said for `send --json` instead of printing it as it streams.
#[derive(Default)]
struct Collected {
    messages: Vec<(String, String)>,
    end: Option<RunEnd>,
}

impl Sink for Collected {
    fn update(&mut self, update: &Update) -> io::Result<()> {
        match update {
            Update::Message(message) if message.role == "bot" && !message.text.is_empty() => {
                match self.messages.iter_mut().find(|(id, _)| *id == message.id) {
                    Some((_, text)) => text.clone_from(&message.text),
                    None => self
                        .messages
                        .push((message.id.clone(), message.text.clone())),
                }
            }
            Update::RunEnded { end, .. } if !matches!(self.end, Some(RunEnd::Failed(_))) => {
                self.end = Some(end.clone());
            }
            _ => {}
        }
        Ok(())
    }
}

fn status(end: Option<&RunEnd>) -> &'static str {
    match end {
        Some(RunEnd::Completed) | None => "completed",
        Some(RunEnd::Failed(_)) => "failed",
        Some(RunEnd::Cancelled) => "cancelled",
        Some(RunEnd::WaitingInput) => "waiting",
    }
}

pub(crate) async fn run(
    client: &Client,
    space_name: Option<&str>,
    args: SendArgs,
    json: bool,
) -> Result<()> {
    let text = message_text(args.message, || {
        if io::stdin().is_terminal() {
            return Ok(String::new());
        }
        let mut text = String::new();
        io::stdin().read_to_string(&mut text)?;
        Ok(text)
    })?;
    let catalog = discover(client, space_name).await?;
    let (space, agent) = find_agent(&catalog, &args.agent)?;
    let me: Value = client.rpc("me", None, json!({})).await.map_err(auth_hint)?;
    let account = me["userId"].as_str().unwrap_or_default();
    if local_chat::LocalChat::open(client, account, space, agent, args.conversation.as_deref())
        .map(|chat| chat.selection())
        .transpose()?
        .flatten()
        .is_some()
    {
        bail!("This agent uses a local model on this device. Use superbot chat to talk to it.");
    }
    let features = Features::new(client.clone());
    let space_features = features.space(&space.id);
    let conversation = if args.new_conversation {
        let created = space_features
            .create_bot_conversation(&agent.id)
            .await
            .map_err(auth_hint)?;
        if !json {
            eprintln!("Conversation {}", terminal_text(&created.thread_id));
        }
        Some(created.thread_id)
    } else {
        args.conversation
    };
    let thread = ChatThread {
        space: space_features,
        agent,
        conversation: conversation.as_deref(),
        interactive: false,
    };
    let snapshot = thread
        .space
        .thread(thread.target())
        .await
        .map_err(auth_hint)?;
    if conversation
        .as_deref()
        .is_some_and(|id| id != snapshot.thread_id)
    {
        bail!("The server did not open the requested conversation.");
    }
    let nonce = Uuid::new_v4().to_string();
    let message = superbot_features::SendMessage {
        text: Some(&text),
        client_nonce: Some(&nonce),
        ..Default::default()
    };
    let send = || thread.space.send(thread.target(), &message);
    // The nonce makes a retried send land once.
    let receipt = match send().await {
        Err(error) if error.is_retryable() => send().await,
        result => result,
    }
    .map_err(auth_hint)?;
    let SendReceipt {
        run_id,
        run_ids,
        seq,
        ..
    } = receipt;
    let runs = if run_ids.is_empty() {
        vec![run_id]
    } else {
        run_ids
    };
    let mut pending = runs.clone();
    let mut cursor = snapshot.cursor;
    let mut reply = Reply::default();
    let mut printer = LinePrinter::new(io::stdout(), &agent.name, false);
    let mut collected = Collected::default();
    let sink: &mut dyn Sink = if json { &mut collected } else { &mut printer };
    let waiting = tokio::time::timeout(
        REPLY_BUDGET,
        follow_until_waiting(
            &thread,
            &mut cursor,
            &mut pending,
            Some(seq),
            &mut reply,
            sink,
        ),
    )
    .await
    .map_err(|_| {
        anyhow::anyhow!("Still waiting after 10 minutes. Open the chat to see its latest messages.")
    })??;
    let waiting_card = match &waiting {
        Some(run_id) => Some((
            run_id.clone(),
            thread
                .space
                .thread(thread.target())
                .await
                .map_err(auth_hint)?,
        )),
        None => None,
    };
    if json {
        if waiting.is_some() {
            collected.end = Some(RunEnd::WaitingInput);
        }
        let reply_text = collected
            .messages
            .iter()
            .map(|(_, text)| text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let mut output = json!({
            "threadId": snapshot.thread_id,
            "runIds": runs,
            "status": status(collected.end.as_ref()),
            "reply": reply_text,
        });
        if let Some(RunEnd::Failed(reason)) = &collected.end {
            output["error"] = json!(reason);
        }
        if let Some((run_id, snapshot)) = &waiting_card {
            output["approval"] = approvals::waiting_json(snapshot, run_id);
        }
        println!("{}", serde_json::to_string_pretty(&output)?);
        return match collected.end {
            Some(RunEnd::WaitingInput) => Err(Exit(WAITING_EXIT).into()),
            Some(RunEnd::Failed(_) | RunEnd::Cancelled) => Err(Exit(1).into()),
            _ => Ok(()),
        };
    }
    if let Some((run_id, snapshot)) = &waiting_card {
        approvals::print_waiting(snapshot, run_id);
        return Err(Exit(WAITING_EXIT).into());
    }
    if printer.failed {
        return Err(Exit(1).into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use superbot_client::Message;

    use super::*;

    #[test]
    fn message_comes_from_words_or_redirected_input() {
        let unused = || -> io::Result<String> { panic!("stdin is not read when words are given") };
        assert_eq!(
            message_text(vec!["What".into(), "is".into(), "blue?".into()], unused).unwrap(),
            "What is blue?"
        );
        assert_eq!(
            message_text(Vec::new(), || Ok("From a pipe\n".into())).unwrap(),
            "From a pipe\n"
        );
        assert!(message_text(Vec::new(), || Ok("  \n".into())).is_err());
    }

    fn bot(id: &str, text: &str) -> Update {
        Update::Message(Message {
            id: id.into(),
            role: "bot".into(),
            author: None,
            origin: None,
            bot_id: Some("bot-1".into()),
            text: text.into(),
            seq: 1,
            run_id: Some("run-1".into()),
        })
    }

    #[test]
    fn collected_reply_keeps_each_message_once_and_the_failure() {
        let mut collected = Collected::default();
        for update in [
            bot("m1", "Draft"),
            bot("m1", "Final"),
            bot("m2", ""),
            Update::RunEnded {
                run_id: "run-1".into(),
                end: RunEnd::Failed("Model unavailable".into()),
            },
            Update::RunEnded {
                run_id: "run-2".into(),
                end: RunEnd::Completed,
            },
        ] {
            collected.update(&update).unwrap();
        }
        assert_eq!(collected.messages, [("m1".into(), "Final".into())]);
        assert_eq!(status(collected.end.as_ref()), "failed");
    }
}
