use gpui_kit::*;
use superbot_client::Error;

use super::{Reply, Settled};
use crate::api;
use crate::app::Desktop;

/// The vault's fixed refusals: the only server words a secret's failure may show, since any
/// other message could echo the value.
const BLOCKED_ITEM: &str = "This item is blocked for bots. Allow it in the Vault, or dismiss the request.";
const UNCHOSEN_ITEM: &str = "This bot can't use this item. Change it in the Vault, or dismiss the request.";

/// Why an answer did not go through, in words that say what to do. `secret` keeps the
/// server's own message out of it.
pub fn answer_problem(error: &Error, secret: bool) -> String {
    match error {
        Error::Server { status: 409 | 404, .. } => {
            "This question isn't waiting for an answer anymore. It may have been answered somewhere else.".into()
        }
        Error::Server { status: 403, .. } => "Only the person who started this run can answer it.".into(),
        Error::Server { message, .. } if secret && (message == BLOCKED_ITEM || message == UNCHOSEN_ITEM) => {
            message.clone()
        }
        Error::Server { status: 401, .. } | Error::Transport(_) => api::explain(error),
        _ if secret => "Couldn't send this. Try again, or dismiss the request.".into(),
        _ => api::explain(error),
    }
}

impl Desktop {
    /// Sends the person's answer to the card in message `message_id` of run `run_id`.
    pub fn answer_question(
        &mut self,
        run_id: String,
        message_id: String,
        reply: Reply,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(chat) = self.chat.as_mut() else { return };
        if chat.cards.busy.contains(&message_id) {
            return;
        }
        let target = chat.target.clone();
        let secret = matches!(reply, Reply::Secret(_) | Reply::DismissSecret);
        if secret {
            // The field and everything it remembers go with the value.
            chat.cards.fields.remove(&message_id);
        }
        let (answer, dismiss, settled) = match reply {
            Reply::Text(text) => (text.clone(), false, Settled::Answered(text)),
            Reply::Option(id) => (id.clone(), false, Settled::Answered(id)),
            Reply::Secret(value) => (value, false, Settled::Sent),
            Reply::DismissSecret => (String::new(), true, Settled::Dismissed),
        };
        chat.cards.busy.insert(message_id.clone());
        chat.cards.problems.remove(&message_id);
        let answered_id = message_id.clone();
        let work = async move {
            let sent = api.answer_question(&space_id, &target, &run_id, &message_id, &answer, dismiss).await;
            drop(answer);
            sent
        };
        self.call(window, cx, work, move |this, result, _, cx| {
            let message_id = answered_id;
            let Some(chat) = this.chat.as_mut() else { return };
            if !chat.cards.busy.remove(&message_id) {
                return;
            }
            match result {
                Ok(()) => {
                    chat.cards.fields.remove(&message_id);
                    chat.cards.sent.insert(message_id.clone(), settled);
                }
                Err(error) => {
                    if matches!(error, Error::Server { status: 409 | 404, .. }) {
                        chat.cards.mark_stale(&message_id);
                    }
                    chat.cards.problems.insert(message_id.clone(), answer_problem(&error, secret));
                }
            }
            this.remeasure_message(&message_id);
            cx.notify();
        });
        cx.notify();
    }

    /// Picks an option on the first-run focus card, or puts the card away with `None`.
    pub fn choose_focus(
        &mut self,
        bot_id: String,
        message_id: String,
        option: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(chat) = self.chat.as_mut() else { return };
        if !chat.cards.busy.insert(message_id.clone()) {
            return;
        }
        chat.cards.problems.remove(&message_id);
        let chosen = option.clone();
        let work = async move { api.choose_focus(&space_id, &bot_id, option.as_deref()).await };
        self.call(window, cx, work, move |this, result, _, cx| {
            let Some(chat) = this.chat.as_mut() else { return };
            if !chat.cards.busy.remove(&message_id) {
                return;
            }
            match result {
                Ok(()) => {
                    let settled = chosen.map_or(Settled::Dismissed, Settled::Answered);
                    chat.cards.sent.insert(message_id.clone(), settled);
                }
                Err(error) => {
                    chat.cards.problems.insert(message_id.clone(), answer_problem(&error, false));
                }
            }
            this.remeasure_message(&message_id);
            cx.notify();
        });
        cx.notify();
    }

    /// Measures the row of a message again after its card changed height.
    pub fn remeasure_message(&mut self, message_id: &str) {
        let Some(chat) = self.chat.as_mut() else { return };
        if let Some(index) = chat.entries.iter().position(|entry| entry.id == message_id) {
            chat.list.remeasure_items(index + 1..index + 2);
        }
    }
}

#[cfg(test)]
mod tests {
    use superbot_client::Error;

    use super::{answer_problem, BLOCKED_ITEM};

    fn server(status: u16, message: &str) -> Error {
        Error::Server { status, code: None, message: message.into() }
    }

    #[test]
    fn stale_and_role_refusals_say_what_happened() {
        let stale = answer_problem(&server(409, "This prompt is no longer awaiting an answer"), false);
        assert!(stale.contains("isn't waiting for an answer anymore"));
        assert!(answer_problem(&server(403, "Forbidden"), true).starts_with("Only the person"));
    }

    #[test]
    fn a_secret_failure_never_repeats_the_server() {
        let echoed = answer_problem(&server(400, "Value sk-placeholder-1234 is too long"), true);
        assert!(!echoed.contains("sk-placeholder"));
        assert_eq!(answer_problem(&server(400, BLOCKED_ITEM), true), BLOCKED_ITEM);
        assert!(answer_problem(&server(400, "Answer too long"), false).contains("Answer too long"));
    }
}
