use std::collections::{HashMap, HashSet};

use gpui_kit::component::input::InputState;
use gpui_kit::{Entity, Subscription};
use serde_json::Value;
use superbot_client::ThreadEvent;

use super::Settled;
use crate::api::Snapshot;
use crate::transcript::{Entry, Part};

/// A card's text field, and its Enter that sends what it holds.
pub(super) struct Field {
    pub input: Entity<InputState>,
    pub _enter: Subscription,
}

/// Whether the person on this device may answer a card now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Turn {
    Yours,
    /// The run is someone else's: only the person who started it answers its cards.
    Theirs,
    /// The run is no longer waiting for an answer.
    Closed,
}

/// The cards of the open conversation: which runs wait for an answer and from whom, and what
/// the person has typed or sent. A secret's field is dropped as soon as its value is sent.
#[derive(Default)]
pub struct Cards {
    /// Runs waiting for an answer, with the user who started each when the server says.
    waiting: HashMap<String, Option<String>>,
    pub(super) fields: HashMap<String, Field>,
    pub(super) busy: HashSet<String>,
    stale: HashSet<String>,
    pub(super) problems: HashMap<String, String>,
    /// Answers sent from here, shown until the server's copy of the card arrives.
    pub(super) sent: HashMap<String, Settled>,
}

impl Cards {
    /// The waiting runs a freshly read conversation names. After a restart, this is what makes
    /// a card that is still pending answerable again.
    pub fn read(&mut self, snapshot: &Snapshot) {
        self.waiting.clear();
        let runs = snapshot.active_runs.iter().flatten().chain(snapshot.run.iter());
        for run in runs.filter(|run| run.status == "waiting_input") {
            if let Some(id) = &run.id {
                self.waiting.insert(id.clone(), run.user_id.clone());
            }
        }
    }

    /// Follows a run's state on the live stream.
    pub fn follow(&mut self, event: &ThreadEvent) {
        let Some(run_id) = event.run_id.as_deref() else { return };
        match event.kind.as_str() {
            "run.waiting_input" => {
                let user = event.data.get("userId").and_then(Value::as_str).filter(|id| !id.is_empty());
                self.waiting.insert(run_id.to_owned(), user.map(str::to_owned));
            }
            "run.started" | "run.completed" | "run.cancelled" | "run.failed" => {
                self.waiting.remove(run_id);
            }
            _ => {}
        }
    }

    pub(super) fn mark_stale(&mut self, message_id: &str) {
        self.fields.remove(message_id);
        self.stale.insert(message_id.to_owned());
    }

    pub fn turn(&self, message_id: &str, run_id: Option<&str>, me: Option<&str>) -> Turn {
        if self.stale.contains(message_id) {
            return Turn::Closed;
        }
        match run_id.and_then(|run_id| self.waiting.get(run_id)) {
            None => Turn::Closed,
            Some(Some(owner)) if me.is_some_and(|me| !me.is_empty() && me != owner) => Turn::Theirs,
            Some(_) => Turn::Yours,
        }
    }

    /// Forgets what was sent from here once the server's copy of the card shows it settled.
    pub fn caught_up(&mut self, entry: &Entry) {
        let settled = entry.parts.iter().any(|part| match part {
            Part::Question(question) => question.settled.is_some(),
            Part::Choice(choice) => choice.chosen.is_some(),
            _ => false,
        });
        if settled {
            self.forget(&entry.id);
        }
    }

    pub fn forget(&mut self, id: &str) {
        self.fields.remove(id);
        self.busy.remove(id);
        self.problems.remove(id);
        self.sent.remove(id);
        self.stale.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use superbot_client::ThreadEvent;

    use super::{Cards, Turn};
    use crate::api::Snapshot;

    fn event(kind: &str, run: &str, data: serde_json::Value) -> ThreadEvent {
        serde_json::from_value(
            json!({ "id": "e", "seq": 1, "botId": null, "runId": run, "type": kind, "payload": data }),
        )
        .unwrap()
    }

    #[test]
    fn a_pending_card_is_answerable_again_after_a_restart() {
        let snapshot: Snapshot = serde_json::from_value(json!({
            "cursor": 4, "messages": [],
            "activeRuns": [
                { "id": "mine", "status": "waiting_input", "userId": "me" },
                { "id": "theirs", "status": "waiting_input", "userId": "teammate" },
                { "id": "busy", "status": "running", "userId": "me" },
            ],
        }))
        .unwrap();
        let mut cards = Cards::default();
        cards.read(&snapshot);
        assert_eq!(cards.turn("a", Some("mine"), Some("me")), Turn::Yours);
        assert_eq!(cards.turn("b", Some("theirs"), Some("me")), Turn::Theirs);
        assert_eq!(cards.turn("c", Some("busy"), Some("me")), Turn::Closed);
        assert_eq!(cards.turn("d", None, Some("me")), Turn::Closed);
    }

    #[test]
    fn the_live_stream_opens_and_closes_runs() {
        let mut cards = Cards::default();
        cards.follow(&event("run.waiting_input", "run", json!({ "userId": "me" })));
        assert_eq!(cards.turn("a", Some("run"), Some("me")), Turn::Yours);
        cards.follow(&event("run.started", "run", json!({})));
        assert_eq!(cards.turn("a", Some("run"), Some("me")), Turn::Closed);
        cards.follow(&event("run.waiting_input", "other", json!({})));
        assert_eq!(cards.turn("b", Some("other"), Some("me")), Turn::Yours, "an unnamed owner is left to the server");
    }

    #[test]
    fn a_late_refusal_does_not_close_the_next_prompt_of_the_same_run() {
        let mut cards = Cards::default();
        cards.follow(&event("run.waiting_input", "run", json!({ "userId": "me" })));
        cards.mark_stale("answered");
        assert_eq!(cards.turn("answered", Some("run"), Some("me")), Turn::Closed);
        assert_eq!(cards.turn("next", Some("run"), Some("me")), Turn::Yours);
    }

    #[test]
    fn an_authoritative_event_retires_the_pending_response() {
        use crate::{api::WireMessage, transcript::Entry};
        let mut cards = Cards::default();
        cards.busy.insert("key".into());
        let message: WireMessage = serde_json::from_value(json!({ "id": "key", "role": "bot",
            "blocks": [{ "kind": "ask", "input": "secret", "text": "API key", "status": "answered" }]
        }))
        .unwrap();
        cards.caught_up(&Entry::read(message).unwrap());
        assert!(!cards.busy.contains("key"));
    }
}
