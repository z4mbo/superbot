//! `superbot tui`: the full-screen chat. Reads once, then follows the open conversation's live
//! events and the Space's change signals, reading again only when a signal says to.

mod state;
mod view;

use std::time::Duration;

use anyhow::Result;
use crossterm::event::{Event, EventStream};
use futures_util::StreamExt;
use superbot_client::{Agent, Client, SpaceNotification};
use superbot_features::{Features, SendMessage};
use tokio::{sync::mpsc, task::JoinHandle};
use uuid::Uuid;

use crate::stream::Reply;
use crate::{approvals, discover, threads};
use state::{App, Effect, Msg, OpenChat};

const MAX_RECONNECT_WAIT: Duration = Duration::from_secs(5);

pub(crate) async fn run(client: Client, space_name: Option<&str>) -> Result<()> {
    let catalog = discover(&client, space_name).await?;
    let space = catalog
        .into_iter()
        .next()
        .map(|(space, _)| space)
        .ok_or_else(|| anyhow::anyhow!("No spaces found for this account."))?;
    let (sender, mut inbox) = mpsc::unbounded_channel();
    let mut app = App::new(space);
    let mut tasks = Tasks {
        client: client.clone(),
        sender: sender.clone(),
        follow: None,
    };
    let signals = tokio::spawn(follow_signals(client, app.space.id.clone(), sender));
    // Restores the screen on exit and on panic.
    let mut terminal = ratatui::init();
    let mut keys = EventStream::new();
    for effect in app.start() {
        tasks.run(&app, effect);
    }
    let result = loop {
        if let Err(error) = terminal.draw(|frame| view::draw(frame, &app)) {
            break Err(error.into());
        }
        let effects = tokio::select! {
            event = keys.next() => match event {
                Some(Ok(Event::Key(key))) => app.key(key),
                // A resize only needs the redraw at the top of the loop.
                Some(Ok(_)) => Vec::new(),
                Some(Err(error)) => break Err(error.into()),
                None => break Ok(()),
            },
            Some(message) = inbox.recv() => app.message(message),
        };
        for effect in effects {
            tasks.run(&app, effect);
        }
        if app.quit {
            break Ok(());
        }
    };
    ratatui::restore();
    signals.abort();
    if let Some(follow) = tasks.follow.take() {
        follow.abort();
    }
    result
}

/// Runs effects in the background; each reports back through `sender`.
struct Tasks {
    client: Client,
    sender: mpsc::UnboundedSender<Msg>,
    follow: Option<JoinHandle<()>>,
}

impl Tasks {
    fn run(&mut self, app: &App, effect: Effect) {
        let client = self.client.clone();
        let sender = self.sender.clone();
        let space_id = app.space.id.clone();
        match effect {
            Effect::Follow { chat, generation } => {
                if let Some(previous) = self.follow.take() {
                    previous.abort();
                }
                self.follow = Some(tokio::spawn(follow_chat(
                    client, space_id, chat, generation, sender,
                )));
            }
            Effect::LoadApprovals => {
                let catalog = app.catalog();
                tokio::spawn(async move {
                    let features = Features::new(client);
                    let message = match approvals::pending(&features, &catalog).await {
                        Ok(found) => Msg::Approvals(found),
                        Err(error) => Msg::Failed(format!("Could not read approvals. {error}")),
                    };
                    let _ = sender.send(message);
                });
            }
            effect => {
                tokio::spawn(async move {
                    let message = match one_shot(&client, &space_id, effect).await {
                        Ok(Some(message)) => message,
                        Ok(None) => return,
                        Err(error) => Msg::Failed(format!("{error:#}")),
                    };
                    let _ = sender.send(message);
                });
            }
        }
    }
}

async fn one_shot(client: &Client, space_id: &str, effect: Effect) -> Result<Option<Msg>> {
    let features = Features::new(client.clone());
    let space = features.space(space_id);
    Ok(Some(match effect {
        Effect::LoadAgents => Msg::Agents(space.list_bots().await?),
        Effect::LoadConversations { agent_id } => {
            let agent = Agent {
                id: agent_id.clone(),
                name: String::new(),
            };
            let rows = threads::conversations(&space, &agent).await?;
            Msg::Conversations { agent_id, rows }
        }
        Effect::Send { chat, text } => {
            let nonce = Uuid::new_v4().to_string();
            let message = SendMessage {
                text: Some(&text),
                client_nonce: Some(&nonce),
                ..Default::default()
            };
            let target = threads::target_for(&chat.agent_id, chat.thread_id.as_deref());
            let send = || space.send(target, &message);
            // The nonce makes a retried send land once.
            match send().await {
                Err(error) if error.is_retryable() => send().await,
                result => result,
            }
            .map_err(|error| anyhow::anyhow!("Could not send the message. {error}"))?;
            return Ok(None);
        }
        Effect::NewConversation { agent_id } => {
            let created = space.create_bot_conversation(&agent_id).await?;
            Msg::Created {
                agent_id,
                thread_id: created.thread_id,
            }
        }
        Effect::Answer { approval, answer } => {
            match approvals::resolve(&features, &approval, answer).await? {
                approvals::Outcome::Answered => Msg::Answered,
                _ => Msg::Failed("This approval is no longer awaiting an answer.".into()),
            }
        }
        Effect::Follow { .. } | Effect::LoadApprovals => return Ok(None),
    }))
}

/// Reads the conversation, then follows its events from that point, reconnecting from the last
/// event seen. A refused stream (signed out, no access) ends with a notice.
async fn follow_chat(
    client: Client,
    space_id: String,
    chat: OpenChat,
    generation: u64,
    sender: mpsc::UnboundedSender<Msg>,
) {
    let features = Features::new(client);
    let space = features.space(&space_id);
    let target = threads::target_for(&chat.agent_id, chat.thread_id.as_deref());
    let snapshot = match space.thread(target).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let _ = sender.send(Msg::Failed(format!("Could not open the chat. {error}")));
            return;
        }
    };
    let mut cursor = snapshot.cursor;
    let _ = sender.send(Msg::Snapshot {
        generation,
        snapshot: Box::new(snapshot),
    });
    let mut reply = Reply::default();
    let mut failures = 0u32;
    loop {
        match space.subscribe_thread(target, cursor).await {
            Ok(mut events) => {
                while let Some(event) = events.next().await {
                    let event = match event {
                        Ok(event) => event,
                        Err(error) if error.is_retryable() => break,
                        Err(error) => {
                            let _ = sender.send(Msg::Failed(format!("The chat stopped. {error}")));
                            return;
                        }
                    };
                    failures = 0;
                    if event.kind == "heartbeat" || event.seq <= cursor {
                        continue;
                    }
                    cursor = event.seq;
                    if let Ok(updates) = reply.apply(&event) {
                        if !updates.is_empty() {
                            let _ = sender.send(Msg::Updates {
                                generation,
                                updates,
                            });
                        }
                    }
                }
            }
            Err(error) if error.is_retryable() => {}
            Err(error) => {
                let _ = sender.send(Msg::Failed(format!("The chat stopped. {error}")));
                return;
            }
        }
        failures += 1;
        tokio::time::sleep(reconnect_wait(failures)).await;
    }
}

/// Follows the Space's content-free change signals. The stream sends each kind when it opens,
/// so reconnecting also catches up on anything missed.
async fn follow_signals(client: Client, space_id: String, sender: mpsc::UnboundedSender<Msg>) {
    let mut failures = 0u32;
    loop {
        if let Ok(mut signals) = client.subscribe_notifications(&space_id).await {
            while let Some(Ok(signal)) = signals.next().await {
                failures = 0;
                let message = match signal {
                    SpaceNotification::Roster => Msg::RosterChanged,
                    SpaceNotification::Runs => Msg::RunsChanged,
                    _ => continue,
                };
                if sender.send(message).is_err() {
                    return;
                }
            }
        }
        failures += 1;
        tokio::time::sleep(reconnect_wait(failures)).await;
    }
}

fn reconnect_wait(failures: u32) -> Duration {
    (Duration::from_millis(250) * 2u32.saturating_pow(failures.min(5))).min(MAX_RECONNECT_WAIT)
}
