use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{Error, SpaceFeatures};

/// The index every bot keeps. It cannot be deleted, only edited.
pub const MEMORY_INDEX_PATH: &str = "MEMORY.md";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MemoryOwner {
    Bot,
    User,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDocument {
    pub id: String,
    pub scope: MemoryOwner,
    pub bot_id: Option<String>,
    pub path: String,
    pub content: String,
    pub revision: i64,
    pub updated_at: String,
}

impl MemoryDocument {
    pub fn is_index(&self) -> bool {
        self.path == MEMORY_INDEX_PATH
    }

    pub fn deletable(&self) -> bool {
        !self.is_index()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDocumentUse {
    pub path: String,
    pub total_bytes: u64,
    pub included_bytes: u64,
}

/// Which of a bot's memory documents reach its prompt, and what did not fit.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBudget {
    pub limit_bytes: u64,
    pub used_bytes: u64,
    pub documents: Vec<MemoryDocumentUse>,
    pub omitted: Vec<MemoryDocumentUse>,
}

impl MemoryBudget {
    pub fn bytes_left_out(&self) -> u64 {
        let omitted: u64 = self.omitted.iter().map(|entry| entry.total_bytes).sum();
        let cut: u64 = self
            .documents
            .iter()
            .map(|entry| entry.total_bytes.saturating_sub(entry.included_bytes))
            .sum();
        omitted + cut
    }
}

/// One thing a bot remembers: a bullet of a document, or a whole document that has no bullets
/// (`line` is `None`). The index contributes only its bullets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryNote {
    pub document_id: String,
    pub line: Option<usize>,
    pub text: String,
}

fn bullet(line: &str) -> Option<&str> {
    let rest = line.trim_start();
    let rest = rest.strip_prefix('-').or_else(|| rest.strip_prefix('*'))?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let text = rest.trim();
    (!text.is_empty()).then_some(text)
}

pub fn memory_notes(documents: &[MemoryDocument]) -> Vec<MemoryNote> {
    documents
        .iter()
        .flat_map(|document| {
            let bullets: Vec<MemoryNote> = document
                .content
                .split('\n')
                .enumerate()
                .filter_map(|(line, raw)| {
                    bullet(raw).map(|text| MemoryNote {
                        document_id: document.id.clone(),
                        line: Some(line),
                        text: text.to_owned(),
                    })
                })
                .collect();
            if !bullets.is_empty() || document.is_index() {
                return bullets;
            }
            let text = document
                .content
                .split('\n')
                .map(|line| line.trim_start_matches('#').trim())
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            if text.is_empty() {
                Vec::new()
            } else {
                vec![MemoryNote {
                    document_id: document.id.clone(),
                    line: None,
                    text,
                }]
            }
        })
        .collect()
}

/// `content` without `note`, or `None` when its line no longer holds that bullet.
pub fn without_memory_note(content: &str, note: &MemoryNote) -> Option<String> {
    let line = note.line?;
    let mut lines: Vec<&str> = content.split('\n').collect();
    if bullet(lines.get(line)?)? != note.text {
        return None;
    }
    lines.remove(line);
    Some(lines.join("\n"))
}

pub fn with_memory_note(content: &str, note: &str) -> String {
    let body = content.trim_end();
    let note = note.split_whitespace().collect::<Vec<_>>().join(" ");
    if body.is_empty() {
        format!("- {note}\n")
    } else {
        format!("{body}\n- {note}\n")
    }
}

impl SpaceFeatures<'_> {
    /// The bot's own memory documents, not the Space's shared ones.
    pub async fn bot_memory(&self, bot_id: &str) -> Result<Vec<MemoryDocument>, Error> {
        self.call(
            "memory/list",
            json!({ "botId": bot_id, "scope": MemoryOwner::Bot }),
        )
        .await
    }

    pub async fn memory_budget(&self, bot_id: &str) -> Result<MemoryBudget, Error> {
        self.call("memory/budget", json!({ "botId": bot_id })).await
    }

    /// Replaces the document's content. With `expected_revision`, the server refuses with a
    /// `CONFLICT` when the document changed after that revision was read.
    pub async fn update_memory(
        &self,
        document_id: &str,
        content: &str,
        expected_revision: Option<i64>,
    ) -> Result<MemoryDocument, Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Input<'a> {
            document_id: &'a str,
            content: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            expected_revision: Option<i64>,
        }
        self.call(
            "memory/update",
            Input {
                document_id,
                content,
                expected_revision,
            },
        )
        .await
    }

    pub async fn remove_memory(&self, document_id: &str) -> Result<(), Error> {
        self.acknowledge("memory/remove", json!({ "documentId": document_id }))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(id: &str, path: &str, content: &str) -> MemoryDocument {
        MemoryDocument {
            id: id.into(),
            scope: MemoryOwner::Bot,
            bot_id: Some("bot".into()),
            path: path.into(),
            content: content.into(),
            revision: 1,
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn notes_are_bullets_and_bulletless_topic_files() {
        let docs = [
            document(
                "index",
                MEMORY_INDEX_PATH,
                "# Ada\n\n- Prefers tea\n* Lives in Turin\n-not a bullet\n",
            ),
            document("topic", "people.md", "# People\n\nSam runs the shop.\n"),
            document("empty", "empty.md", "# \n"),
            document("seed", MEMORY_INDEX_PATH, "# Seed\n\n"),
        ];
        let notes = memory_notes(&docs);
        let texts: Vec<_> = notes
            .iter()
            .map(|note| (note.document_id.as_str(), note.line, note.text.as_str()))
            .collect();
        assert_eq!(
            texts,
            [
                ("index", Some(2), "Prefers tea"),
                ("index", Some(3), "Lives in Turin"),
                ("topic", None, "People Sam runs the shop."),
            ]
        );
    }

    #[test]
    fn forgetting_removes_only_a_bullet_that_is_still_there() {
        let content = "# Ada\n- tea\n- coffee\n";
        let note = |line, text: &str| MemoryNote {
            document_id: "index".into(),
            line: Some(line),
            text: text.into(),
        };
        assert_eq!(
            without_memory_note(content, &note(1, "tea")).as_deref(),
            Some("# Ada\n- coffee\n")
        );
        assert_eq!(without_memory_note(content, &note(1, "coffee")), None);
        assert_eq!(without_memory_note(content, &note(0, "Ada")), None);
        assert_eq!(without_memory_note(content, &note(9, "tea")), None);
    }

    #[test]
    fn adding_appends_one_bullet_line() {
        assert_eq!(
            with_memory_note("# Ada\n\n", " likes\n  green "),
            "# Ada\n- likes green\n"
        );
        assert_eq!(with_memory_note("", "tea"), "- tea\n");
    }

    #[test]
    fn budget_counts_omitted_and_truncated_bytes() {
        let budget: MemoryBudget = serde_json::from_value(json!({
            "limitBytes": 100, "usedBytes": 100,
            "documents": [{ "scope": "bot", "path": "MEMORY.md", "revision": 1, "totalBytes": 150, "includedBytes": 100, "truncated": true }],
            "omitted": [{ "scope": "bot", "path": "a.md", "revision": 1, "totalBytes": 30, "includedBytes": 0, "truncated": false }],
        }))
        .unwrap();
        assert_eq!(budget.bytes_left_out(), 80);
    }
}
