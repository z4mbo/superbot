use serde::{Deserialize, Serialize};
use serde_json::json;
use superbot_client::RpcStream;

use crate::{empty, Error, Features, Patch, SpaceFeatures};

/// Where a ticket is in its work. Upstream `TICKET_STATUSES`, in board order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TicketStatus {
    Todo,
    Doing,
    Review,
    Blocked,
    Done,
    /// Terminal: the work will not be done.
    Closed,
}

impl TicketStatus {
    pub const ALL: [Self; 6] = [
        Self::Todo,
        Self::Doing,
        Self::Review,
        Self::Blocked,
        Self::Done,
        Self::Closed,
    ];

    /// The words the web board uses for each column.
    pub fn label(self) -> &'static str {
        match self {
            Self::Todo => "To do",
            Self::Doing => "In progress",
            Self::Review => "In review",
            Self::Blocked => "Blocked",
            Self::Done => "Done",
            Self::Closed => "Won't do",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TicketPriority {
    Low,
    #[default]
    Normal,
    High,
    Urgent,
}

impl TicketPriority {
    pub const ALL: [Self; 4] = [Self::Low, Self::Normal, Self::High, Self::Urgent];

    pub fn label(self) -> &'static str {
        match self {
            Self::Low => "Low",
            Self::Normal => "Normal",
            Self::High => "High",
            Self::Urgent => "Urgent",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub id: String,
    pub space_id: String,
    pub name: String,
    pub ticket_prefix: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    pub id: String,
    pub board_id: String,
    pub space_id: String,
    pub number: u32,
    /// The reference people type, such as `T-12`.
    #[serde(rename = "ref")]
    pub reference: String,
    pub title: String,
    pub description: Option<String>,
    pub status: TicketStatus,
    pub priority: TicketPriority,
    pub assignee_bot_id: Option<String>,
    pub created_by_bot_id: Option<String>,
    pub created_by_user_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketComment {
    pub id: String,
    pub ticket_id: String,
    pub body: String,
    pub author_bot_id: Option<String>,
    pub author_user_id: Option<String>,
    pub author_name: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A new ticket. Every ticket is owned by a bot the account can reach.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTicket<'a> {
    pub title: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<&'a str>,
    pub priority: TicketPriority,
    pub assignee_bot_id: &'a str,
}

/// Only the fields that are set are sent, so a change never overwrites the others.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketUpdate<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<&'a str>,
    #[serde(skip_serializing_if = "Patch::is_unchanged")]
    pub description: Patch<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<TicketPriority>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<TicketStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_bot_id: Option<&'a str>,
}

impl TicketUpdate<'_> {
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.description.is_unchanged()
            && self.priority.is_none()
            && self.status.is_none()
            && self.assignee_bot_id.is_none()
    }
}

/// A signal that the Space's board changed. It carries no content: read the tickets again.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardChange {
    pub space_id: String,
    pub board_id: Option<String>,
    pub ticket_id: Option<String>,
    pub created_at: String,
}

impl BoardChange {
    /// The server's keep-alive frame, sent after a quiet period. It names no board or ticket.
    pub fn is_heartbeat(&self) -> bool {
        self.board_id.is_none() && self.ticket_id.is_none()
    }
}

/// The account's Labs choices. Board answers "not found" until it is on for the account,
/// unless the deployment turns it on for everyone.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Labs {
    #[serde(default)]
    pub labs: Vec<String>,
    /// What this account may switch; features the deployment turns on are not listed.
    #[serde(default)]
    pub labs_available: Vec<String>,
}

pub const BOARD_LAB: &str = "board";

impl Labs {
    pub fn board_on(&self) -> bool {
        self.labs.iter().any(|lab| lab == BOARD_LAB)
    }

    pub fn board_switchable(&self) -> bool {
        self.labs_available.iter().any(|lab| lab == BOARD_LAB)
    }
}

impl Features {
    pub async fn labs(&self) -> Result<Labs, Error> {
        self.call("me", None, empty()).await
    }

    /// Replaces the account's Labs list, keeping every other choice it already made.
    pub async fn set_board_lab(&self, current: &Labs, on: bool) -> Result<Labs, Error> {
        let mut labs: Vec<&str> = current
            .labs
            .iter()
            .map(String::as_str)
            .filter(|lab| *lab != BOARD_LAB)
            .collect();
        if on {
            labs.push(BOARD_LAB);
        }
        self.call("preferences/update", None, json!({ "labs": labs }))
            .await
    }
}

impl SpaceFeatures<'_> {
    pub async fn board(&self) -> Result<Board, Error> {
        self.call("boards/get", empty()).await
    }

    /// Every ticket on the Space's board, most recently changed first.
    pub async fn list_tickets(&self) -> Result<Vec<Ticket>, Error> {
        #[derive(Deserialize)]
        struct Output {
            tickets: Vec<Ticket>,
        }
        let output: Output = self.call("tickets/list", empty()).await?;
        Ok(output.tickets)
    }

    pub async fn create_ticket(&self, input: &CreateTicket<'_>) -> Result<Ticket, Error> {
        self.call("tickets/create", input).await
    }

    pub async fn update_ticket(
        &self,
        id: &str,
        update: &TicketUpdate<'_>,
    ) -> Result<Ticket, Error> {
        #[derive(Serialize)]
        struct Input<'a> {
            id: &'a str,
            #[serde(flatten)]
            update: &'a TicketUpdate<'a>,
        }
        self.call("tickets/update", Input { id, update }).await
    }

    pub async fn move_ticket(&self, id: &str, status: TicketStatus) -> Result<Ticket, Error> {
        self.call("tickets/move", json!({ "id": id, "status": status }))
            .await
    }

    pub async fn comment_ticket(
        &self,
        ticket_id: &str,
        body: &str,
    ) -> Result<TicketComment, Error> {
        self.call(
            "tickets/comment",
            json!({ "ticketId": ticket_id, "body": body }),
        )
        .await
    }

    /// A ticket's comments, oldest first.
    pub async fn ticket_comments(&self, ticket_id: &str) -> Result<Vec<TicketComment>, Error> {
        self.call("tickets/comments", json!({ "ticketId": ticket_id }))
            .await
    }

    /// Follows the board's change signals until the server closes the stream.
    pub async fn subscribe_board(&self) -> Result<RpcStream<BoardChange>, Error> {
        self.features
            .client
            .subscribe_rpc("boards/subscribe", &self.id, empty())
            .await
    }
}
