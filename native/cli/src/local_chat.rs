use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use superbot_client::{Agent, Client, Space};
use superbot_features::local_cli::{run_local_model, InstalledModel, LocalCli, PendingHistory};
use uuid::Uuid;

use crate::{auth_hint, print_message, ChatThread};

pub(crate) struct LocalChat {
    cli: LocalCli,
    space: String,
    bot: String,
    history_key: String,
}

impl LocalChat {
    pub(crate) fn open(
        client: &Client,
        account: &str,
        space: &Space,
        agent: &Agent,
        conversation: Option<&str>,
    ) -> Option<Self> {
        Some(Self {
            cli: LocalCli::for_workspace(client.server(), account, &space.id)?,
            space: space.id.clone(),
            bot: agent.id.clone(),
            history_key: conversation.map_or_else(|| agent.id.clone(), |id| format!("thread:{id}")),
        })
    }

    pub(crate) fn selection(&self) -> Result<Option<InstalledModel>> {
        self.cli.selection(&self.bot).map_err(anyhow::Error::msg)
    }

    pub(crate) fn has_pending(&self) -> Result<bool> {
        Ok(self.pending()?.is_some())
    }

    fn pending(&self) -> Result<Option<PendingHistory>> {
        self.cli
            .pending_history(&self.history_key)
            .map_err(anyhow::Error::msg)
    }

    pub(crate) async fn handle(
        &self,
        client: &Client,
        thread: &ChatThread<'_>,
        input: &str,
    ) -> Result<bool> {
        let pending = self.pending()?;
        let pending =
            match (input, pending) {
                ("/retry", Some(pending)) => pending,
                (_, Some(_)) => {
                    bail!("Type /retry to save the pending local message before sending another.")
                }
                (_, None) => {
                    let Some(model) = self.selection()? else {
                        return Ok(false);
                    };
                    if input == "/retry" {
                        println!("No local message is waiting to be saved.");
                        return Ok(true);
                    }
                    let snapshot = thread
                        .space
                        .thread(thread.target())
                        .await
                        .map_err(auth_hint)?;
                    let history = snapshot.messages.iter().rev().take(40).rev().filter_map(
                        |message| {
                            let role = match message.role.as_str() {
                                "user" => "user",
                                "bot" => "assistant",
                                _ => return None,
                            };
                            let block = message.blocks.first()?;
                            if block.get("kind")?.as_str()? != "text" {
                                return None;
                            }
                            Some(json!({ "role": role, "content": block.get("text")?.as_str()? }))
                        },
                    );
                    let prompt = if snapshot.messages.is_empty() {
                        input.to_owned()
                    } else {
                        let messages = history
                            .chain([json!({ "role": "user", "content": input })])
                            .collect();
                        format!(
                            "Continue the conversation. Reply to the final user message.\n{}",
                            Value::Array(messages)
                        )
                    };
                    let reply = run_local_model(&self.cli, &model, &prompt)
                        .await
                        .map_err(anyhow::Error::msg)?;
                    let pending = PendingHistory {
                        id: Uuid::new_v4().to_string(),
                        text: input.to_owned(),
                        reply: Some(reply),
                    };
                    self.cli
                        .stage_history(&self.history_key, &pending)
                        .map_err(anyhow::Error::msg)?;
                    pending
                }
            };
        let send = || async {
            match pending.reply.as_deref() {
                Some(reply) => {
                    client
                        .append_local_turn(
                            &self.space,
                            thread.target(),
                            &pending.id,
                            &pending.text,
                            reply,
                        )
                        .await
                }
                None => {
                    client
                        .append_local_note(&self.space, thread.target(), &pending.id, &pending.text)
                        .await
                }
            }
        };
        match send().await {
            Err(error) if error.is_retryable() => send().await,
            result => result,
        }
        .map_err(auth_hint)
        .context("Could not save the local message. Use /retry in this chat to save it")?;
        self.cli
            .clear_history(&self.history_key, &pending)
            .map_err(anyhow::Error::msg)?;
        if let Some(reply) = &pending.reply {
            print_message(thread.agent, "bot", None, reply);
        }
        Ok(true)
    }
}
