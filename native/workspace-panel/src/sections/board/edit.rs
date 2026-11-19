use superbot_features::{Patch, Ticket, TicketPriority};

/// The parts of a ticket the form edits. Status is not here: moving a ticket is saved at once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Fields {
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) owner: Option<String>,
    pub(crate) priority: TicketPriority,
}

impl Fields {
    pub(crate) fn of(ticket: &Ticket) -> Self {
        Self {
            title: ticket.title.clone(),
            description: ticket.description.clone().unwrap_or_default(),
            owner: ticket.assignee_bot_id.clone(),
            priority: ticket.priority,
        }
    }
}

/// The form once the server's copy moved from `base` to `incoming` while the person edited.
///
/// A field the person has not touched follows the server. A touched field keeps what they
/// typed; the flag is true when the server changed that same field to something else, so
/// saving would replace the other person's change.
pub(crate) fn rebase(local: &Fields, base: &Fields, incoming: &Fields) -> (Fields, bool) {
    let mut conflict = false;
    let title = if same_title(&local.title, &base.title) {
        incoming.title.clone()
    } else {
        conflict |= base.title != incoming.title && !same_title(&local.title, &incoming.title);
        local.title.clone()
    };
    let description = merge(
        &local.description,
        &base.description,
        &incoming.description,
        &mut conflict,
    );
    let owner = merge(&local.owner, &base.owner, &incoming.owner, &mut conflict);
    let priority = merge(
        &local.priority,
        &base.priority,
        &incoming.priority,
        &mut conflict,
    );
    (
        Fields {
            title,
            description,
            owner,
            priority,
        },
        conflict,
    )
}

fn merge<T: Clone + PartialEq>(local: &T, base: &T, incoming: &T, conflict: &mut bool) -> T {
    if local == base {
        return incoming.clone();
    }
    *conflict |= base != incoming && local != incoming;
    local.clone()
}

/// The server trims titles, so spaces at the ends are not an edit.
fn same_title(typed: &str, saved: &str) -> bool {
    typed.trim() == saved
}

/// What saving sends: only the fields that differ from the server's copy.
#[derive(Debug, Default)]
pub(crate) struct Changes {
    pub(crate) title: Option<String>,
    pub(crate) description: Patch<String>,
    pub(crate) owner: Option<String>,
    pub(crate) priority: Option<TicketPriority>,
}

impl Changes {
    pub(crate) fn between(local: &Fields, saved: &Fields) -> Self {
        let title = local.title.trim();
        Self {
            title: (!same_title(title, &saved.title)).then(|| title.to_owned()),
            description: if local.description == saved.description {
                Patch::Unchanged
            } else if local.description.trim().is_empty() {
                Patch::Clear
            } else {
                Patch::Set(local.description.clone())
            },
            owner: local
                .owner
                .clone()
                .filter(|owner| saved.owner.as_ref() != Some(owner)),
            priority: (local.priority != saved.priority).then_some(local.priority),
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.description.is_unchanged()
            && self.owner.is_none()
            && self.priority.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(title: &str, description: &str, owner: &str, priority: TicketPriority) -> Fields {
        Fields {
            title: title.into(),
            description: description.into(),
            owner: Some(owner.into()),
            priority,
        }
    }

    #[test]
    fn untouched_fields_follow_the_other_members_change() {
        let base = fields("Draft notes", "", "ada", TicketPriority::Normal);
        let incoming = fields(
            "Draft the notes",
            "Use the changelog",
            "ben",
            TicketPriority::High,
        );
        let (merged, conflict) = rebase(&base, &base, &incoming);
        assert_eq!(merged, incoming);
        assert!(!conflict);
    }

    #[test]
    fn a_field_being_edited_keeps_what_was_typed() {
        let base = fields("Draft notes", "", "ada", TicketPriority::Normal);
        let local = fields(
            "Draft notes",
            "My unsaved description",
            "ada",
            TicketPriority::Normal,
        );
        let incoming = fields("Draft notes", "", "ada", TicketPriority::Urgent);
        let (merged, conflict) = rebase(&local, &base, &incoming);
        assert_eq!(merged.description, "My unsaved description");
        assert_eq!(merged.priority, TicketPriority::Urgent);
        assert!(!conflict);
    }

    #[test]
    fn the_same_field_changed_on_both_sides_is_a_conflict_that_keeps_the_local_text() {
        let base = fields("Draft notes", "", "ada", TicketPriority::Normal);
        let local = fields("Mine", "", "ada", TicketPriority::Normal);
        let incoming = fields("Theirs", "", "ada", TicketPriority::Normal);
        let (merged, conflict) = rebase(&local, &base, &incoming);
        assert_eq!(merged.title, "Mine");
        assert!(conflict);
    }

    #[test]
    fn both_sides_making_the_same_change_is_not_a_conflict() {
        let base = fields("Draft notes", "", "ada", TicketPriority::Normal);
        let local = fields("Draft notes", "", "ada", TicketPriority::High);
        let (merged, conflict) = rebase(&local, &base, &local);
        assert_eq!(merged, local);
        assert!(!conflict);
    }

    #[test]
    fn spaces_around_a_title_are_not_an_edit() {
        let base = fields("Draft notes", "", "ada", TicketPriority::Normal);
        let local = fields("  Draft notes ", "", "ada", TicketPriority::Normal);
        let incoming = fields("Theirs", "", "ada", TicketPriority::Normal);
        let (merged, conflict) = rebase(&local, &base, &incoming);
        assert_eq!(merged.title, "Theirs");
        assert!(!conflict);
        assert!(Changes::between(&local, &base).is_empty());
    }

    #[test]
    fn saving_sends_only_what_differs_and_clears_an_emptied_description() {
        let saved = fields("Draft notes", "Old", "ada", TicketPriority::Normal);
        let local = fields("Draft notes", "  ", "ben", TicketPriority::Normal);
        let changes = Changes::between(&local, &saved);
        assert_eq!(changes.title, None);
        assert!(matches!(changes.description, Patch::Clear));
        assert_eq!(changes.owner.as_deref(), Some("ben"));
        assert_eq!(changes.priority, None);
        assert!(Changes::between(&saved, &saved).is_empty());
    }

    #[test]
    fn an_unknown_owner_is_never_sent_as_a_change() {
        let mut saved = fields("Draft notes", "", "ada", TicketPriority::Normal);
        saved.owner = Some("archived-bot".into());
        let mut local = saved.clone();
        local.owner = None;
        assert!(Changes::between(&local, &saved).is_empty());
    }
}
