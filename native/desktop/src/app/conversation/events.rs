use serde_json::Value;
use superbot_client::ThreadEvent;

use super::Chat;
use crate::transcript::{upsert, Entry, Placed};
use crate::{api, clock};

/// Applies one live event to the open conversation. True when the sidebar should be read again.
pub(super) fn apply_event(chat: &mut Chat, event: &ThreadEvent) -> bool {
    let text = |key: &str| event.data.get(key).and_then(Value::as_str);
    let flag = |key: &str| event.data.get(key).and_then(Value::as_bool).unwrap_or(false);
    let last = Chat::row_of(chat.entries.len());
    chat.cards.follow(event);
    match event.kind.as_str() {
        "thread.message.created" | "thread.message.updated" => {
            let Some(message) = api::message_from_event(event) else { return false };
            let seq = message.seq;
            let id = message.id.clone();
            let full_update = event.kind == "thread.message.updated" && !message.blocks.is_empty();
            if let Some(entry) = Entry::read(message) {
                chat.cards.caught_up(&entry);
                if entry.speaker == crate::transcript::Speaker::Agent {
                    chat.draft.clear();
                }
                // Only the rows that changed are measured again, so a person reading older
                // history stays where they are.
                match upsert(&mut chat.entries, entry, seq, clock::now()) {
                    Placed::Replaced(index) => {
                        let row = Chat::row_of(index);
                        chat.list.remeasure_items(row..row + 1);
                    }
                    Placed::Inserted(index) => {
                        let row = Chat::row_of(index);
                        chat.list.splice(row..row, 1);
                        // Its neighbours' joined corners and time stamps can change with it.
                        chat.list.remeasure_items(row - 1..row);
                        chat.list.remeasure_items(row + 1..row + 2);
                    }
                }
                let now = Chat::row_of(chat.entries.len());
                chat.list.remeasure_items(now..now + 1);
            } else if full_update {
                chat.cards.forget(&id);
                if let Some(index) = chat.entries.iter().position(|entry| entry.id == id) {
                    chat.entries.remove(index);
                    let row = Chat::row_of(index);
                    chat.list.splice(row..row + 1, 0);
                    chat.list.remeasure_items(row.saturating_sub(1)..row + 1);
                }
            }
            false
        }
        "thread.cleared" => {
            chat.entries.clear();
            chat.cards = crate::cards::Cards::default();
            chat.draft.clear();
            chat.conversation.older = None;
            chat.conversation.capped = false;
            chat.list.reset(chat.rows());
            false
        }
        "thread.progress" => {
            if flag("reset") {
                chat.draft.clear();
            }
            if flag("streaming") {
                match (text("text"), text("delta")) {
                    (Some(whole), _) => chat.draft = whole.to_owned(),
                    (None, Some(delta)) => chat.draft.push_str(delta),
                    _ => {}
                }
            } else if let Some(status) = text("text") {
                chat.activity = Some(status.to_owned());
            }
            chat.working = true;
            chat.list.splice(last..last + 1, 1);
            false
        }
        "thread.meta" => {
            if let Some(thinking) = event.data.pointer("/activity/thinking").and_then(Value::as_bool) {
                chat.working = true;
                chat.activity = thinking.then(|| "Thinking…".to_owned());
                chat.list.splice(last..last + 1, 1);
            }
            false
        }
        "run.started" => {
            chat.working = true;
            chat.error = None;
            chat.list.splice(last..last + 1, 1);
            true
        }
        "run.completed" | "run.cancelled" | "run.waiting_input" | "run.failed" => {
            chat.working = false;
            chat.activity = None;
            chat.draft.clear();
            if event.kind == "run.failed" {
                let reason = event
                    .data
                    .get("error")
                    .and_then(|error| error.as_str().or_else(|| error.get("message").and_then(Value::as_str)))
                    .unwrap_or("The agent couldn't finish. Send your message again.");
                chat.error = Some(reason.to_owned());
            }
            chat.list.splice(last..last + 1, 1);
            true
        }
        "bot.updated" | "bot.archived" | "bot.deleted" | "bot.spawned" | "group.updated" | "group.created" => true,
        _ => false,
    }
}
