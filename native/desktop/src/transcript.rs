use chrono::TimeZone;
use serde_json::Value;

use crate::api::WireMessage;
use crate::clock::{self, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Speaker {
    Person,
    Agent,
    System,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardAction {
    pub id: String,
    pub label: String,
}

/// A stored file a message carries: enough to show it and to fetch it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileRef {
    pub artifact_id: String,
    pub name: String,
    pub mime_type: String,
    /// In bytes. The server states it for files and leaves it out for images.
    pub size: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Part {
    Text(String),
    Note(String),
    Facts(Vec<(String, String)>),
    Ask {
        text: String,
        detail: Option<String>,
        answer: Option<String>,
        actions: Vec<CardAction>,
        /// The card wants typed text or a secret, which is answered on the web for now.
        needs_typing: bool,
    },
    /// A question the agent waits on: typed, picked from options, or a protected value.
    Question(crate::cards::Question),
    /// The first-run focus card.
    Choice(crate::cards::Choice),
    File(FileRef),
    Steps(String),
    /// A card this app does not draw yet; the label says what it is.
    Elsewhere(&'static str),
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub id: String,
    pub seq: i64,
    pub speaker: Speaker,
    /// Who spoke, when the conversation has more than two voices.
    pub name: Option<String>,
    pub author_id: Option<String>,
    pub agent_id: Option<String>,
    pub run_id: Option<String>,
    pub local_cli: bool,
    /// When it was said. A message that has just arrived on the live stream takes the moment
    /// it arrived, since the stream names no time for it.
    pub at: Option<Instant>,
    /// The words this message answers, shown in a pill above it.
    pub quote: Option<String>,
    pub parts: Vec<Part>,
}

impl Entry {
    /// None for a message the transcript leaves out: the prompt of a delivery, or one with nothing to show.
    pub fn read(message: WireMessage) -> Option<Self> {
        let kind = |block: &Value| block.get("kind").and_then(Value::as_str).map(str::to_owned);
        if message.blocks.iter().any(|block| kind(block).as_deref() == Some("delivery")) {
            return None;
        }
        let parts: Vec<Part> = message.blocks.iter().filter_map(part).collect();
        if parts.is_empty() {
            return None;
        }
        let (name, author_id) = message.author.map_or((None, None), |author| (Some(author.name), author.id));
        Some(Self {
            id: message.id,
            seq: message.seq.unwrap_or_default(),
            speaker: match message.role.as_str() {
                "user" => Speaker::Person,
                "bot" => Speaker::Agent,
                _ => Speaker::System,
            },
            name,
            author_id,
            agent_id: message.bot_id,
            run_id: message.run_id,
            local_cli: message.origin.as_deref() == Some("local_cli"),
            at: message.created_at.as_deref().and_then(clock::instant),
            quote: message.reply_quote.map(|quote| quote.split_whitespace().collect::<Vec<_>>().join(" ")),
            parts,
        })
    }

    /// A message made only of words joins its neighbours into one group of bubbles.
    pub fn is_bubble(&self) -> bool {
        self.speaker != Speaker::System && self.parts.iter().all(|part| matches!(part, Part::Text(_)))
    }
}

fn part(block: &Value) -> Option<Part> {
    let text = |key: &str| {
        block.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
    };
    match block.get("kind")?.as_str()? {
        "text" => text("text").map(Part::Text),
        "meta" => text("text").map(Part::Note),
        "card" => {
            let lines: Vec<_> = block
                .get("lines")?
                .as_array()?
                .iter()
                .filter_map(|line| Some((line.get("k")?.as_str()?.to_owned(), line.get("v")?.as_str()?.to_owned())))
                .collect();
            (!lines.is_empty()).then_some(Part::Facts(lines))
        }
        "ask" => {
            if let Some(question) = crate::cards::read_question(block) {
                return Some(Part::Question(question));
            }
            let pending = block.get("status").and_then(Value::as_str) != Some("answered")
                && block.get("dismissed").is_none()
                && block.get("expired").is_none();
            let actions = block
                .get("actions")
                .and_then(Value::as_array)
                .map(|actions| {
                    actions
                        .iter()
                        .filter_map(|action| {
                            Some(CardAction {
                                id: action.get("id")?.as_str()?.to_owned(),
                                label: action.get("label")?.as_str()?.to_owned(),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(Part::Ask {
                text: text("text")?,
                detail: text("detail"),
                answer: if pending { None } else { Some(text("answer").unwrap_or_else(|| "Answered".into())) },
                needs_typing: pending && actions.is_empty(),
                actions: if pending { actions } else { Vec::new() },
            })
        }
        "choice" => crate::cards::read_choice(block).map(Part::Choice),
        "file" | "image" => Some(Part::File(FileRef {
            artifact_id: text("artifactId")?,
            name: text("name")?,
            mime_type: text("mimeType").unwrap_or_default(),
            size: block.get("size").and_then(Value::as_u64),
        })),
        "routine_event" => text("name").map(|name| Part::Note(format!("Routine · {name}"))),
        "steps" => {
            let steps = block.get("steps")?.as_array()?;
            let labels: Vec<_> = steps.iter().filter_map(|step| step.get("label").and_then(Value::as_str)).collect();
            (!labels.is_empty()).then(|| Part::Steps(labels.join(" · ")))
        }
        "handoff" | "bot_message_sent" | "bot_message_received" | "channel_message" => text("text").map(Part::Text),
        "progress" | "delivery" => None,
        "page" => Some(Part::Elsewhere("Page")),
        "chart" => Some(Part::Elsewhere("Chart")),
        "app" => Some(Part::Elsewhere("App")),
        "computer" => Some(Part::Elsewhere("Computer")),
        "voice_call" | "call_request" => Some(Part::Elsewhere("Call")),
        "connect" | "app_connect" | "mcp_approval" => Some(Part::Elsewhere("Connection")),
        _ => Some(Part::Elsewhere("Card")),
    }
}

/// Which neighbours a bubble joins: the corners on its own side tighten where it meets its group.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Join {
    pub above: bool,
    pub below: bool,
}

/// How one row sits among its neighbours.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Place {
    pub join: Join,
    /// The time is stamped above this row.
    pub stamped: bool,
}

fn same_voice(upper: &Entry, lower: &Entry) -> bool {
    upper.is_bubble()
        && lower.is_bubble()
        && upper.speaker == lower.speaker
        && upper.agent_id == lower.agent_id
        && upper.local_cli == lower.local_cli
        && upper.author_id == lower.author_id
        && upper.name == lower.name
}

fn stamped<Tz: TimeZone>(entries: &[Entry], index: usize, zone: &Tz) -> bool {
    let Some(at) = entries[index].at else { return false };
    let previous = entries[..index].iter().rev().find_map(|entry| entry.at);
    clock::needs_stamp(previous, at, zone)
}

/// Where row `index` sits. A stamp starts a new group of bubbles, as a change of voice does.
pub fn place<Tz: TimeZone>(entries: &[Entry], index: usize, zone: &Tz) -> Place {
    let stamp = stamped(entries, index, zone);
    let above = index > 0 && !stamp && same_voice(&entries[index - 1], &entries[index]);
    let below = entries
        .get(index + 1)
        .is_some_and(|next| same_voice(&entries[index], next) && !stamped(entries, index + 1, zone));
    Place { join: Join { above, below }, stamped: stamp }
}

/// What placing a message did, so the list re-measures only the rows that changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placed {
    Replaced(usize),
    Inserted(usize),
}

/// Places a message read from history or the live stream, replacing an earlier copy of itself.
/// The live stream carries no time for a message, so a new one takes `now` and an updated one
/// keeps the time it had.
pub fn upsert(entries: &mut Vec<Entry>, mut entry: Entry, seq: Option<i64>, now: Instant) -> Placed {
    match entries.iter().position(|existing| existing.id == entry.id) {
        Some(index) => {
            entry.at = entry.at.or(entries[index].at);
            entry.seq = seq.unwrap_or(entries[index].seq);
            entries[index] = entry;
            Placed::Replaced(index)
        }
        None => {
            entry.at = entry.at.or(Some(now));
            // The stream gives some messages their place in the conversation and others none.
            // One without a place is the newest, so it goes after everything already here.
            entry.seq = seq.unwrap_or_else(|| entries.last().map_or(0, |last| last.seq + 1));
            let index = entries.partition_point(|existing| existing.seq <= entry.seq);
            entries.insert(index, entry);
            Placed::Inserted(index)
        }
    }
}

/// The most messages one open conversation keeps in memory.
pub const MOST_ENTRIES: usize = 3_000;

/// Puts an older page in front of what is on screen and says how many rows it added. Messages
/// already present are left as they are, and the page stops where the memory bound is reached,
/// keeping its newest messages so the transcript has no gap.
pub fn prepend(entries: &mut Vec<Entry>, mut older: Vec<Entry>) -> usize {
    older.retain(|entry| entries.iter().all(|existing| existing.id != entry.id));
    older.sort_by_key(|entry| entry.seq);
    let room = MOST_ENTRIES.saturating_sub(entries.len());
    let skipped = older.len().saturating_sub(room);
    let added = older.len() - skipped;
    entries.splice(0..0, older.into_iter().skip(skipped));
    entries.sort_by_key(|entry| entry.seq);
    added
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use serde_json::json;

    fn message(id: &str, seq: i64, role: &str, blocks: Value) -> WireMessage {
        serde_json::from_value(json!({ "id": id, "seq": seq, "role": role, "blocks": blocks })).unwrap()
    }

    fn words(id: &str, seq: i64, role: &str, text: &str) -> Entry {
        Entry::read(message(id, seq, role, json!([{ "kind": "text", "text": text }]))).unwrap()
    }

    #[test]
    fn a_reply_keeps_its_quote_on_one_line() {
        let wire = json!({
            "id": "m", "seq": 1, "role": "user", "replyQuote": "Quale\n  font",
            "blocks": [{ "kind": "text", "text": "Quello" }]
        });
        let entry = Entry::read(serde_json::from_value(wire).unwrap()).unwrap();
        assert_eq!(entry.quote.as_deref(), Some("Quale font"));
        assert_eq!(words("n", 2, "user", "Hi").quote, None);
    }

    fn said_at(mut entry: Entry, rfc3339: &str) -> Entry {
        entry.at = clock::instant(rfc3339);
        entry
    }

    #[test]
    fn leaves_out_a_delivery_prompt() {
        let prompt = message("m1", 1, "user", json!([{ "kind": "delivery" }, { "kind": "text", "text": "wake" }]));
        assert!(Entry::read(prompt).is_none());
    }

    #[test]
    fn a_pending_ask_offers_its_actions_and_an_answered_one_does_not() {
        let pending = json!([{ "kind": "ask", "text": "Send it?", "approvalEffectId": "effect",
            "actions": [{ "id": "allow", "label": "Allow once" }] }]);
        let answered = json!([{ "kind": "ask", "text": "Send it?", "status": "answered", "answer": "allow",
            "approvalEffectId": "effect", "actions": [{ "id": "allow", "label": "Allow once" }] }]);
        let ask = |blocks| Entry::read(message("m", 1, "bot", blocks)).unwrap().parts.remove(0);
        assert!(matches!(ask(pending), Part::Ask { actions, answer: None, .. } if actions.len() == 1));
        assert!(matches!(ask(answered), Part::Ask { actions, answer: Some(_), .. } if actions.is_empty()));
    }

    #[test]
    fn a_file_message_keeps_what_is_needed_to_fetch_it() {
        let blocks = json!([
            { "kind": "file", "artifactId": "a1", "mimeType": "application/pdf", "name": "plan.pdf", "size": 2048 },
            { "kind": "image", "artifactId": "a2", "mimeType": "image/png", "name": "shot.png" },
            { "kind": "file", "mimeType": "text/plain", "name": "no id" }
        ]);
        let entry = Entry::read(message("m", 1, "user", blocks)).unwrap();
        let file = |artifact_id: &str, name: &str, mime_type: &str, size| {
            Part::File(FileRef {
                artifact_id: artifact_id.into(),
                name: name.into(),
                mime_type: mime_type.into(),
                size,
            })
        };
        assert_eq!(
            entry.parts,
            [file("a1", "plan.pdf", "application/pdf", Some(2048)), file("a2", "shot.png", "image/png", None)]
        );
        assert!(!entry.is_bubble());
    }

    #[test]
    fn a_message_reads_the_time_the_server_stored() {
        let stored: WireMessage = serde_json::from_value(json!({
            "id": "m", "seq": 1, "role": "user", "createdAt": "2026-11-19T08:00:00.000Z",
            "blocks": [{ "kind": "text", "text": "hi" }]
        }))
        .unwrap();
        assert_eq!(Entry::read(stored).unwrap().at, clock::instant("2026-11-19T08:00:00Z"));
        assert_eq!(words("live", 2, "bot", "no time on the stream").at, None);
    }

    #[test]
    fn bubbles_join_only_within_one_voice() {
        let entries = vec![words("a", 1, "user", "hi"), words("b", 2, "user", "there"), words("c", 3, "bot", "hello")];
        let joins: Vec<_> = (0..3).map(|index| place(&entries, index, &Utc).join).collect();
        assert!(joins[0].below && joins[1].above);
        assert!(!joins[1].below && !joins[2].above);
    }

    #[test]
    fn a_stamp_starts_a_new_group_of_bubbles() {
        let entries = vec![
            said_at(words("a", 1, "user", "morning"), "2026-11-19T09:00:00Z"),
            said_at(words("b", 2, "user", "still here"), "2026-11-19T09:05:00Z"),
            said_at(words("c", 3, "user", "after lunch"), "2026-11-19T13:00:00Z"),
        ];
        let places: Vec<_> = (0..3).map(|index| place(&entries, index, &Utc)).collect();
        assert_eq!(places.iter().map(|place| place.stamped).collect::<Vec<_>>(), [true, false, true]);
        assert_eq!(places[0].join, Join { above: false, below: true });
        assert_eq!(places[1].join, Join { above: true, below: false });
        assert_eq!(places[2].join, Join::default());
    }

    #[test]
    fn an_updated_message_replaces_itself_and_a_new_one_lands_in_order() {
        let draft = said_at(words("c", 5, "bot", "draft"), "2026-11-19T09:00:00Z");
        let mut entries = vec![words("a", 1, "user", "hi"), draft];
        assert_eq!(upsert(&mut entries, words("c", 5, "bot", "final"), Some(5), 99), Placed::Replaced(1));
        assert_eq!(upsert(&mut entries, words("b", 3, "user", "between"), Some(3), 99), Placed::Inserted(1));
        let ids: Vec<_> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c"]);
        assert_eq!(entries[2].parts, [Part::Text("final".into())]);
        // The update keeps the stored time; the new arrival takes the moment it arrived.
        assert_eq!(entries[2].at, clock::instant("2026-11-19T09:00:00Z"));
        assert_eq!(entries[1].at, Some(99));
    }

    #[test]
    fn a_live_message_without_a_place_goes_last_and_later_ones_follow_it() {
        let mut entries = vec![words("m235", 235, "bot", "earlier")];
        assert_eq!(upsert(&mut entries, words("m236", 0, "user", "fourth"), Some(236), 1), Placed::Inserted(1));
        // The reply names no place of its own; the next message names its real one.
        assert_eq!(upsert(&mut entries, words("reply", 0, "bot", "heard"), None, 2), Placed::Inserted(2));
        assert_eq!(upsert(&mut entries, words("m238", 0, "user", "keep"), Some(238), 3), Placed::Inserted(3));
        assert_eq!(upsert(&mut entries, words("reply-2", 0, "bot", "heard"), None, 4), Placed::Inserted(4));
        let ids: Vec<_> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, ["m235", "m236", "reply", "m238", "reply-2"]);
        // The same reply arriving again, as it does after a reconnect, stays where it is.
        assert_eq!(upsert(&mut entries, words("reply", 0, "bot", "heard"), None, 5), Placed::Replaced(2));
        assert_eq!(entries[2].at, Some(2));
    }

    #[test]
    fn an_older_page_goes_in_front_once_and_stops_at_the_memory_bound() {
        let mut entries = vec![words("m5", 5, "user", "five"), words("m6", 6, "bot", "six")];
        let page =
            vec![words("m4", 4, "bot", "four"), words("m3", 3, "user", "three"), words("m5", 5, "user", "again")];
        assert_eq!(prepend(&mut entries, page), 2);
        let ids: Vec<_> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, ["m3", "m4", "m5", "m6"]);
        assert_eq!(entries[2].parts, [Part::Text("five".into())]);

        let newest = 10..10 + MOST_ENTRIES as i64 - 1;
        let mut full: Vec<Entry> = newest.map(|seq| words(&format!("n{seq}"), seq, "bot", "x")).collect();
        let page = vec![words("o1", 1, "bot", "oldest"), words("o2", 2, "bot", "older")];
        assert_eq!(prepend(&mut full, page), 1);
        assert_eq!(full.len(), MOST_ENTRIES);
        assert_eq!(full[0].id, "o2");
    }
}
