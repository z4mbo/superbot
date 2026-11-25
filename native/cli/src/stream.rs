//! Live replies: one reducer turns thread events into display updates for the line chat,
//! `send`, and the full-screen view.

use std::io::{self, Write};

use serde_json::Value;
use superbot_client::{Error, Message, MessageAuthor, ThreadEvent};

use crate::terminal_text;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Update {
    /// Text the agent is writing now, to append to what is already shown.
    Draft(String),
    /// The text written so far will not be in the reply.
    DraftWithdrawn,
    /// What the agent is doing while no text is streaming, or `None` once it stops.
    Activity(Option<String>),
    Message(Message),
    RunEnded {
        run_id: String,
        end: RunEnd,
    },
    Cleared,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RunEnd {
    Completed,
    Failed(String),
    Cancelled,
    WaitingInput,
}

/// Follows one thread's live events. Only one draft streams at a time, as in a direct chat.
#[derive(Default)]
pub(crate) struct Reply {
    draft: String,
}

impl Reply {
    pub(crate) fn apply(&mut self, event: &ThreadEvent) -> Result<Vec<Update>, Error> {
        let text = |key: &str| event.data.get(key).and_then(Value::as_str);
        let flag = |key: &str| event.data.get(key).and_then(Value::as_bool) == Some(true);
        let mut updates = Vec::new();
        match event.kind.as_str() {
            "thread.progress" => {
                if flag("reset") && !self.draft.is_empty() {
                    self.draft.clear();
                    updates.push(Update::DraftWithdrawn);
                }
                if flag("streaming") {
                    let next = match (text("text"), text("delta")) {
                        (Some(whole), _) => whole.to_owned(),
                        (None, Some(delta)) => format!("{}{delta}", self.draft),
                        _ => return Ok(updates),
                    };
                    match next.strip_prefix(self.draft.as_str()) {
                        Some("") => {}
                        Some(delta) => updates.push(Update::Draft(delta.to_owned())),
                        None => {
                            updates.push(Update::DraftWithdrawn);
                            updates.push(Update::Draft(next.clone()));
                        }
                    }
                    self.draft = next;
                } else if let Some(status) = text("text").map(str::trim) {
                    if !status.is_empty() {
                        updates.push(Update::Activity(Some(status.to_owned())));
                    }
                }
            }
            "thread.meta" => {
                if let Some(thinking) = event
                    .data
                    .pointer("/activity/thinking")
                    .and_then(Value::as_bool)
                {
                    updates.push(Update::Activity(thinking.then(|| "Thinking…".to_owned())));
                }
            }
            "thread.message.created" | "thread.message.updated" => {
                if let Some(message) = event.message()? {
                    if message.role == "bot" && !message.text.is_empty() {
                        self.draft.clear();
                    }
                    updates.push(Update::Message(message));
                }
            }
            "thread.cleared" => {
                self.draft.clear();
                updates.push(Update::Cleared);
            }
            "run.completed" | "run.failed" | "run.cancelled" | "run.waiting_input" => {
                self.draft.clear();
                updates.push(Update::Activity(None));
                if let Some(run_id) = &event.run_id {
                    let end = match event.kind.as_str() {
                        "run.completed" => RunEnd::Completed,
                        "run.cancelled" => RunEnd::Cancelled,
                        "run.waiting_input" => RunEnd::WaitingInput,
                        _ => RunEnd::Failed(failure_reason(&event.data)),
                    };
                    updates.push(Update::RunEnded {
                        run_id: run_id.clone(),
                        end,
                    });
                }
            }
            _ => {}
        }
        Ok(updates)
    }
}

fn failure_reason(payload: &Value) -> String {
    payload
        .get("error")
        .and_then(|error| error.as_str().or_else(|| error.get("message")?.as_str()))
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("No failure details were provided.")
        .to_owned()
}

/// Who wrote a message, as the transcript names them.
pub(crate) fn speaker<'a>(
    agent_name: &'a str,
    role: &str,
    author: Option<&'a MessageAuthor>,
) -> &'a str {
    match role {
        "user" => author.map_or("Member", |author| author.name.as_str()),
        "bot" => agent_name,
        _ => "Superbot",
    }
}

/// Receives the updates a followed reply produces.
pub(crate) trait Sink {
    fn update(&mut self, update: &Update) -> io::Result<()>;
}

impl<W: Write> Sink for LinePrinter<W> {
    fn update(&mut self, update: &Update) -> io::Result<()> {
        LinePrinter::update(self, update)
    }
}

/// Writes updates as transcript lines, streaming the agent's draft in place on its line.
pub(crate) struct LinePrinter<W: Write> {
    out: W,
    agent_name: String,
    /// `send` prints only the reply; the chat names each speaker.
    named: bool,
    shown: String,
    pub(crate) failed: bool,
}

impl<W: Write> LinePrinter<W> {
    pub(crate) fn new(out: W, agent_name: &str, named: bool) -> Self {
        Self {
            out,
            agent_name: agent_name.to_owned(),
            named,
            shown: String::new(),
            failed: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn into_inner(self) -> W {
        self.out
    }

    pub(crate) fn update(&mut self, update: &Update) -> io::Result<()> {
        match update {
            Update::Draft(delta) => {
                if self.shown.is_empty() && self.named {
                    write!(self.out, "{} > ", terminal_text(&self.agent_name))?;
                }
                write!(self.out, "{}", terminal_text(delta))?;
                self.shown.push_str(delta);
                self.out.flush()?;
            }
            Update::DraftWithdrawn | Update::Cleared => self.end_line()?,
            Update::Activity(_) => {}
            Update::Message(message) => {
                if message.role == "bot" && !self.shown.is_empty() {
                    if let Some(rest) = message.text.strip_prefix(self.shown.as_str()) {
                        writeln!(self.out, "{}", terminal_text(rest))?;
                        self.shown.clear();
                        return Ok(());
                    }
                }
                self.end_line()?;
                if message.text.trim().is_empty() || (!self.named && message.role != "bot") {
                    return Ok(());
                }
                if self.named {
                    let name = speaker(&self.agent_name, &message.role, message.author.as_ref());
                    write!(self.out, "{} > ", terminal_text(name))?;
                }
                writeln!(self.out, "{}", terminal_text(&message.text))?;
            }
            Update::RunEnded { end, .. } => {
                self.end_line()?;
                match end {
                    RunEnd::Failed(reason) => {
                        self.failed = true;
                        eprintln!("Agent run failed. {}", terminal_text(reason));
                    }
                    RunEnd::Cancelled => {
                        self.failed = true;
                        eprintln!("Agent run cancelled.");
                    }
                    RunEnd::Completed | RunEnd::WaitingInput => {}
                }
            }
        }
        Ok(())
    }

    fn end_line(&mut self) -> io::Result<()> {
        if !self.shown.is_empty() {
            writeln!(self.out)?;
            self.shown.clear();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn event(seq: i64, kind: &str, payload: Value) -> ThreadEvent {
        serde_json::from_value(json!({
            "id": format!("event-{seq}"), "seq": seq, "runId": "run-1", "botId": "bot-1",
            "type": kind, "payload": payload,
        }))
        .unwrap()
    }

    fn print(named: bool, events: &[ThreadEvent]) -> (String, Vec<Update>) {
        let mut reply = Reply::default();
        let mut printer = LinePrinter::new(Vec::new(), "Fixture agent", named);
        let mut all = Vec::new();
        for event in events {
            for update in reply.apply(event).unwrap() {
                printer.update(&update).unwrap();
                all.push(update);
            }
        }
        (String::from_utf8(printer.into_inner()).unwrap(), all)
    }

    fn streamed_reply() -> Vec<ThreadEvent> {
        vec![
            event(1, "run.started", json!({})),
            event(
                2,
                "thread.meta",
                json!({ "activity": { "thinking": true } }),
            ),
            event(
                3,
                "thread.progress",
                json!({ "streaming": true, "delta": "The fixture " }),
            ),
            event(
                4,
                "thread.progress",
                json!({ "streaming": true, "delta": "response" }),
            ),
            event(
                5,
                "thread.progress",
                json!({ "streaming": true, "text": "The fixture response is" }),
            ),
            event(
                6,
                "thread.message.created",
                json!({ "messageId": "reply-1", "seq": 3, "role": "bot",
                    "blocks": [{ "kind": "text", "text": "The fixture response is blue." }] }),
            ),
            event(7, "run.completed", json!({})),
        ]
    }

    #[test]
    fn streams_deltas_and_finishes_with_the_saved_text() {
        let (named, updates) = print(true, &streamed_reply());
        assert_eq!(named, "Fixture agent > The fixture response is blue.\n");
        assert!(updates.contains(&Update::Activity(Some("Thinking…".into()))));
        assert_eq!(
            updates
                .iter()
                .filter_map(|update| match update {
                    Update::Draft(delta) => Some(delta.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>(),
            ["The fixture ", "response", " is"]
        );
        let (bare, _) = print(false, &streamed_reply());
        assert_eq!(bare, "The fixture response is blue.\n");
    }

    #[test]
    fn a_withdrawn_draft_ends_its_line_and_the_saved_reply_follows() {
        let (output, updates) = print(
            true,
            &[
                event(
                    1,
                    "thread.progress",
                    json!({ "streaming": true, "delta": "Let me check" }),
                ),
                event(2, "thread.progress", json!({ "reset": true })),
                event(3, "thread.progress", json!({ "text": "Searching the web" })),
                event(
                    4,
                    "thread.message.created",
                    json!({ "role": "bot", "blocks": [{ "kind": "text", "text": "Found it." }] }),
                ),
            ],
        );
        assert_eq!(
            output,
            "Fixture agent > Let me check\nFixture agent > Found it.\n"
        );
        assert!(updates.contains(&Update::Activity(Some("Searching the web".into()))));
    }

    #[test]
    fn run_endings_carry_their_reason_and_mark_failures() {
        let mut reply = Reply::default();
        let failed = reply
            .apply(&event(
                1,
                "run.failed",
                json!({ "error": { "message": "Model unavailable" } }),
            ))
            .unwrap();
        assert_eq!(
            failed.last(),
            Some(&Update::RunEnded {
                run_id: "run-1".into(),
                end: RunEnd::Failed("Model unavailable".into())
            })
        );
        let mut printer = LinePrinter::new(Vec::new(), "Fixture agent", true);
        printer.update(failed.last().unwrap()).unwrap();
        assert!(printer.failed);
        let waiting = reply
            .apply(&event(2, "run.waiting_input", json!({})))
            .unwrap();
        assert!(matches!(
            waiting.last(),
            Some(Update::RunEnded {
                end: RunEnd::WaitingInput,
                ..
            })
        ));
    }

    #[test]
    fn member_messages_are_named_in_chat_and_left_out_of_send() {
        let member = event(
            1,
            "thread.message.created",
            json!({ "role": "user", "author": { "id": "user-2", "name": "Ada" },
                "blocks": [{ "kind": "text", "text": "Hi \u{1b}[31mall" }] }),
        );
        assert_eq!(
            print(true, std::slice::from_ref(&member)).0,
            "Ada > Hi [31mall\n"
        );
        assert_eq!(print(false, &[member]).0, "");
    }
}
