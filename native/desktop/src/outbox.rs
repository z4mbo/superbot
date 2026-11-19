//! What a person is about to send: the files they attached, the attempt in flight, and the
//! bots a group message names. Nothing here touches the network or the window.

use std::path::PathBuf;

use crate::api::{GroupMember, Target};
use crate::files::Picked;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attachment {
    /// This attachment within its outbox; never reused.
    pub id: u64,
    pub name: String,
    pub mime_type: &'static str,
    pub size: u64,
    pub path: PathBuf,
    /// The stored file, once the upload has been acknowledged.
    pub artifact_id: Option<String>,
}

/// One message as it was last tried. Trying the same message again reuses its nonce, so the
/// server keeps a single copy whether or not the first try arrived.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Attempt {
    nonce: String,
    text: String,
    files: Vec<u64>,
    mentions: Vec<String>,
}

/// A file to store before the message goes: its place in the outbox and what to upload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Upload {
    pub id: u64,
    pub name: String,
    pub mime_type: &'static str,
    pub path: PathBuf,
    /// Set when an earlier try already stored it.
    pub artifact_id: Option<String>,
    /// The same for every try of this attachment, so the server stores it once.
    pub nonce: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sending {
    pub nonce: String,
    pub text: String,
    pub mentions: Vec<String>,
    pub uploads: Vec<Upload>,
}

#[derive(Debug)]
pub struct Outbox {
    /// Tells this outbox's nonces from every other's.
    salt: String,
    pub attachments: Vec<Attachment>,
    /// A message is on its way; nothing more is sent until it is answered.
    pub sending: bool,
    /// Why the last attach or send did not happen.
    pub problem: Option<String>,
    attached: u64,
    attempts: u64,
    attempt: Option<Attempt>,
}

impl Outbox {
    pub fn new(salt: impl Into<String>) -> Self {
        Self {
            salt: salt.into(),
            attachments: Vec::new(),
            sending: false,
            problem: None,
            attached: 0,
            attempts: 0,
            attempt: None,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.attachments.is_empty() && !self.sending
    }

    /// Attaches a checked file. False when the message is full or the file is already attached.
    pub fn attach(&mut self, picked: Picked, most: usize) -> bool {
        if self.sending || self.attachments.len() >= most || self.attachments.iter().any(|held| held.path == picked.path) {
            return false;
        }
        self.attached += 1;
        self.attachments.push(Attachment {
            id: self.attached,
            name: picked.name,
            mime_type: picked.mime_type,
            size: picked.size,
            path: picked.path,
            artifact_id: None,
        });
        true
    }

    pub fn detach(&mut self, id: u64) {
        if !self.sending {
            self.attachments.retain(|held| held.id != id);
        }
    }

    /// Starts sending what the composer holds. None while a message is on its way, and when
    /// there are neither words nor files.
    pub fn begin(&mut self, text: &str, mentions: Vec<String>) -> Option<Sending> {
        let text = text.trim();
        if self.sending || (text.is_empty() && self.attachments.is_empty()) {
            return None;
        }
        let files: Vec<u64> = self.attachments.iter().map(|held| held.id).collect();
        let unchanged = self
            .attempt
            .as_ref()
            .is_some_and(|last| last.text == text && last.files == files && last.mentions == mentions);
        if !unchanged {
            self.attempts += 1;
            let nonce = format!("{}-message-{}", self.salt, self.attempts);
            self.attempt = Some(Attempt { nonce, text: text.to_owned(), files, mentions: mentions.clone() });
        }
        self.sending = true;
        self.problem = None;
        Some(Sending {
            nonce: self.attempt.as_ref().map(|attempt| attempt.nonce.clone()).unwrap_or_default(),
            text: text.to_owned(),
            mentions,
            uploads: self
                .attachments
                .iter()
                .map(|held| Upload {
                    id: held.id,
                    name: held.name.clone(),
                    mime_type: held.mime_type,
                    path: held.path.clone(),
                    artifact_id: held.artifact_id.clone(),
                    nonce: format!("{}-file-{}", self.salt, held.id),
                })
                .collect(),
        })
    }

    /// Records a stored file, so another try of the message does not upload it again.
    pub fn stored(&mut self, id: u64, artifact_id: String) {
        if let Some(held) = self.attachments.iter_mut().find(|held| held.id == id) {
            held.artifact_id = Some(artifact_id);
        }
    }

    /// The server took the message: what was sent leaves the outbox.
    pub fn acknowledged(&mut self) {
        self.sending = false;
        self.problem = None;
        self.attempt = None;
        self.attachments.clear();
    }

    /// The message did not go. Everything stays as it was, ready to send again.
    pub fn failed(&mut self, problem: impl Into<String>) {
        self.sending = false;
        self.problem = Some(problem.into());
    }
}

/// What is typed and attached in a conversation that is not on screen.
#[derive(Debug)]
pub struct Draft {
    pub text: String,
    pub outbox: Outbox,
}

/// A conversation, named across Spaces.
pub type Place = (String, Target);

/// Drafts of the conversations visited this session, newest last.
#[derive(Debug, Default)]
pub struct Drafts(Vec<(Place, Draft)>);

impl Drafts {
    const MOST: usize = 24;

    /// Keeps what a conversation holds when another one opens. An empty draft is not kept,
    /// and the oldest draft goes once there are more than the bound.
    pub fn keep(&mut self, place: Place, draft: Draft) {
        self.0.retain(|(held, _)| *held != place);
        if draft.text.trim().is_empty() && draft.outbox.is_empty() {
            return;
        }
        self.0.push((place, draft));
        if self.0.len() > Self::MOST {
            // A draft with a message on its way is never the one dropped.
            if let Some(oldest) = self.0.iter().position(|(_, draft)| !draft.outbox.sending) {
                self.0.remove(oldest);
            }
        }
    }

    pub fn take(&mut self, place: &Place) -> Option<Draft> {
        let index = self.0.iter().position(|(held, _)| held == place)?;
        Some(self.0.remove(index).1)
    }

    pub fn get_mut(&mut self, place: &Place) -> Option<&mut Draft> {
        self.0.iter_mut().find(|(held, _)| held == place).map(|(_, draft)| draft)
    }

    pub fn clear(&mut self) {
        self.0.clear();
    }
}

/// An `@` being typed: where it starts and what follows it up to the caret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MentionQuery {
    /// The byte offset of the `@`.
    pub start: usize,
    pub typed: String,
}

/// The mention being typed at the caret, if the caret sits in one: an `@` at the start of the
/// text or after a space, with no line break between it and the caret.
pub fn mention_query(text: &str, caret: usize) -> Option<MentionQuery> {
    let before = text.get(..caret)?;
    let start = before.rfind('@')?;
    let opens = before[..start].chars().next_back().is_none_or(char::is_whitespace);
    let typed = &before[start + 1..];
    (opens && !typed.contains('\n')).then(|| MentionQuery { start, typed: typed.to_owned() })
}

/// The group's bots a typed mention could mean: those whose name, or a word of it, starts
/// with what was typed.
pub fn mention_matches<'a>(members: &'a [GroupMember], typed: &str) -> Vec<&'a GroupMember> {
    let typed = typed.to_lowercase();
    members
        .iter()
        .filter(|member| {
            let name = member.name.to_lowercase();
            name.starts_with(&typed) || name.split_whitespace().any(|word| word.starts_with(&typed))
        })
        .collect()
}

/// The text with the mention being typed completed to `name`, and where the caret goes.
pub fn complete_mention(text: &str, query: &MentionQuery, caret: usize, name: &str) -> (String, usize) {
    let mention = format!("@{name} ");
    let rest = text.get(caret..).unwrap_or_default();
    let rest = rest.strip_prefix(' ').unwrap_or(rest);
    let completed = format!("{}{mention}{rest}", &text[..query.start]);
    (completed, query.start + mention.len())
}

fn names_at(text: &str, at: usize, name: &str) -> bool {
    let rest = &text[at..];
    let named = rest.get(..name.len()).is_some_and(|start| start.eq_ignore_ascii_case(name));
    named && rest[name.len()..].chars().next().is_none_or(|next| !next.is_alphanumeric())
}

/// The bots a message names with `@Name`, in the order they are first named. The longest name
/// wins where one name starts another.
pub fn mentioned(text: &str, members: &[GroupMember]) -> Vec<String> {
    let mut by_length: Vec<&GroupMember> = members.iter().filter(|member| !member.name.is_empty()).collect();
    by_length.sort_by_key(|member| std::cmp::Reverse(member.name.len()));
    let mut ids: Vec<String> = Vec::new();
    for (at, _) in text.match_indices('@') {
        let opens = text[..at].chars().next_back().is_none_or(char::is_whitespace);
        let named = by_length.iter().find(|member| names_at(text, at + 1, &member.name));
        if let Some(member) = named.filter(|member| opens && !ids.contains(&member.bot_id)) {
            ids.push(member.bot_id.clone());
        }
    }
    ids
}

/// The byte ranges of `text` that name one of the group's bots, `@` included.
pub fn mention_ranges(text: &str, members: &[GroupMember]) -> Vec<std::ops::Range<usize>> {
    let mut by_length: Vec<&GroupMember> = members.iter().filter(|member| !member.name.is_empty()).collect();
    by_length.sort_by_key(|member| std::cmp::Reverse(member.name.len()));
    text.match_indices('@')
        .filter(|(at, _)| text[..*at].chars().next_back().is_none_or(char::is_whitespace))
        .filter_map(|(at, _)| {
            let member = by_length.iter().find(|member| names_at(text, at + 1, &member.name))?;
            Some(at..at + 1 + member.name.len())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picked(name: &str) -> Picked {
        Picked { path: PathBuf::from(format!("C:/fixture/{name}")), name: name.into(), mime_type: "text/plain", size: 12 }
    }

    fn members() -> Vec<GroupMember> {
        let member = |bot_id: &str, name: &str| GroupMember { bot_id: bot_id.into(), name: name.into(), color: String::new() };
        vec![member("b1", "Fixture agent"), member("b2", "Support agent"), member("b3", "Support")]
    }

    #[test]
    fn a_message_goes_once_however_often_it_is_tried() {
        let mut outbox = Outbox::new("box");
        assert!(outbox.attach(picked("notes.txt"), 4));
        let first = outbox.begin("  hello  ", vec![]).unwrap();
        assert_eq!(first.text, "hello");
        assert!(outbox.begin("hello", vec![]).is_none(), "nothing more goes while one is on its way");

        outbox.stored(first.uploads[0].id, "artifact-1".into());
        outbox.failed("Couldn't reach the server.");
        assert_eq!(outbox.attachments.len(), 1, "a failed send keeps its files");
        assert_eq!(outbox.problem.as_deref(), Some("Couldn't reach the server."));

        let again = outbox.begin("hello", vec![]).unwrap();
        assert_eq!(again.nonce, first.nonce, "the same message keeps its nonce");
        assert_eq!(again.uploads[0].nonce, first.uploads[0].nonce);
        assert_eq!(again.uploads[0].artifact_id.as_deref(), Some("artifact-1"), "a stored file is not uploaded again");

        outbox.failed("Still unreachable.");
        let edited = outbox.begin("hello there", vec![]).unwrap();
        assert_ne!(edited.nonce, first.nonce, "a changed message is a new message");
        assert_eq!(edited.uploads[0].nonce, first.uploads[0].nonce, "its file is still the same file");

        outbox.acknowledged();
        assert!(outbox.attachments.is_empty() && !outbox.sending && outbox.problem.is_none());
        let next = outbox.begin("hello there", vec![]).unwrap();
        assert_ne!(next.nonce, edited.nonce, "the same words sent later are another message");
    }

    #[test]
    fn files_alone_are_a_message_and_nothing_at_all_is_not() {
        let mut outbox = Outbox::new("box");
        assert!(outbox.begin("   ", vec![]).is_none());
        assert!(outbox.attach(picked("a.txt"), 2));
        assert!(!outbox.attach(picked("a.txt"), 2), "the same file is attached once");
        assert!(outbox.attach(picked("b.txt"), 2));
        assert!(!outbox.attach(picked("c.txt"), 2), "the message is full");
        outbox.detach(1);
        let sending = outbox.begin("", vec![]).unwrap();
        assert_eq!(sending.text, "");
        assert_eq!(sending.uploads.iter().map(|upload| upload.name.as_str()).collect::<Vec<_>>(), ["b.txt"]);
        outbox.detach(2);
        assert_eq!(outbox.attachments.len(), 1, "nothing changes while it is on its way");
    }

    #[test]
    fn drafts_are_kept_per_conversation_and_bounded() {
        let place = |index: usize| ("space".to_owned(), Target::Agent(format!("bot-{index}")));
        let draft = |text: &str| Draft { text: text.into(), outbox: Outbox::new("box") };
        let mut drafts = Drafts::default();
        drafts.keep(place(0), draft("   "));
        assert!(drafts.take(&place(0)).is_none(), "an empty draft is not kept");
        for index in 0..Drafts::MOST + 3 {
            drafts.keep(place(index), draft("unsent"));
        }
        assert_eq!(drafts.0.len(), Drafts::MOST);
        assert!(drafts.take(&place(0)).is_none(), "the oldest went first");
        assert_eq!(drafts.take(&place(Drafts::MOST + 2)).unwrap().text, "unsent");
        assert!(drafts.take(&place(Drafts::MOST + 2)).is_none());
    }

    #[test]
    fn a_mention_is_found_at_the_caret_and_completed_in_place() {
        let text = "ask @sup about it";
        let query = mention_query(text, 8).unwrap();
        assert_eq!(query, MentionQuery { start: 4, typed: "sup".into() });
        assert_eq!(mention_query("mail a@b", 8), None, "an address is not a mention");
        assert_eq!(mention_query("@one\ntwo", 8), None);
        assert_eq!(mention_query("@Fixture ag", 11).unwrap().typed, "Fixture ag");

        let all = members();
        let names = |typed: &str| mention_matches(&all, typed).iter().map(|member| member.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names(""), ["Fixture agent", "Support agent", "Support"]);
        assert_eq!(names("sup"), ["Support agent", "Support"]);
        assert_eq!(names("ag"), ["Fixture agent", "Support agent"]);
        assert_eq!(names("fixture a"), ["Fixture agent"]);
        assert!(names("zed").is_empty());

        let (completed, caret) = complete_mention(text, &query, 8, "Support agent");
        assert_eq!(completed, "ask @Support agent about it");
        assert_eq!(&completed[..caret], "ask @Support agent ");
    }

    #[test]
    fn a_message_names_each_bot_once_and_the_longest_name_wins() {
        let all = members();
        assert_eq!(mentioned("@Support agent and @fixture agent, then @Support agent again", &all), ["b2", "b1"]);
        assert_eq!(mentioned("@Support, are you there?", &all), ["b3"]);
        assert_eq!(mentioned("@Supporters and mail@Support", &all), Vec::<String>::new());
        assert_eq!(mention_ranges("hi @Support agent!", &all), [3..17]);
    }
}
