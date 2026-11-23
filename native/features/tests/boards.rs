use serde_json::{json, Value};
use superbot_client::Client;
use superbot_features::{
    BoardChange, CreateTicket, Features, Labs, Patch, TicketPriority, TicketStatus, TicketUpdate,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// Answers one RPC on loopback after checking its path, Space scope and JSON input.
async fn fixture(
    path: &'static str,
    scope: Option<&'static str>,
    input: Value,
    response: Value,
) -> (Features, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let client = Client::new(&origin)
        .unwrap()
        .with_token("fixture.signature")
        .unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(stream.read_u8().await.unwrap());
        }
        let head = String::from_utf8(head).unwrap();
        let mut lines = head.lines();
        assert_eq!(lines.next().unwrap(), format!("POST /rpc/{path} HTTP/1.1"));
        let headers: std::collections::HashMap<_, _> = lines
            .filter_map(|line| line.split_once(": "))
            .map(|(key, value)| (key.to_ascii_lowercase(), value))
            .collect();
        assert_eq!(headers.get("x-rakazo-space-id").copied(), scope);
        let mut body = vec![0; headers["content-length"].parse().unwrap()];
        stream.read_exact(&mut body).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({ "json": input })
        );
        let body = json!({ "json": response }).to_string();
        stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    (Features::new(client), server)
}

const SPACE: Option<&str> = Some("team");

fn ticket(status: &str) -> Value {
    json!({
        "id": "t1", "boardId": "b1", "spaceId": "team", "number": 3, "ref": "T-3",
        "title": "Draft release notes", "description": null, "status": status, "priority": "high",
        "assigneeBotId": "bot", "createdByBotId": null, "createdByUserId": "user",
        "createdAt": "2026-11-19T10:00:00.000Z", "updatedAt": "2026-11-19T10:05:00.000Z", "completedAt": null
    })
}

#[tokio::test]
async fn tickets_list_unwraps_the_envelope_and_reads_every_status() {
    let tickets: Vec<Value> = ["todo", "doing", "review", "blocked", "done", "closed"]
        .into_iter()
        .map(ticket)
        .collect();
    let (features, server) = fixture(
        "tickets/list",
        SPACE,
        json!({}),
        json!({ "tickets": tickets }),
    )
    .await;
    let listed = features.space("team").list_tickets().await.unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|ticket| ticket.status)
            .collect::<Vec<_>>(),
        TicketStatus::ALL
    );
    assert_eq!(listed[0].reference, "T-3");
    assert_eq!(listed[0].priority, TicketPriority::High);
    server.await.unwrap();
}

#[tokio::test]
async fn a_new_ticket_names_its_owner_and_omits_an_empty_description() {
    let (features, server) = fixture(
        "tickets/create",
        SPACE,
        json!({ "title": "Draft release notes", "priority": "normal", "assigneeBotId": "bot" }),
        ticket("todo"),
    )
    .await;
    let input = CreateTicket {
        title: "Draft release notes",
        description: None,
        priority: TicketPriority::Normal,
        assignee_bot_id: "bot",
    };
    assert_eq!(
        features
            .space("team")
            .create_ticket(&input)
            .await
            .unwrap()
            .status,
        TicketStatus::Todo
    );
    server.await.unwrap();
}

#[tokio::test]
async fn an_update_sends_only_changed_fields_and_clears_a_description_with_null() {
    let (features, server) = fixture(
        "tickets/update",
        SPACE,
        json!({ "id": "t1", "description": null, "priority": "urgent" }),
        ticket("todo"),
    )
    .await;
    let update = TicketUpdate {
        description: Patch::Clear,
        priority: Some(TicketPriority::Urgent),
        ..Default::default()
    };
    assert!(!update.is_empty());
    features
        .space("team")
        .update_ticket("t1", &update)
        .await
        .unwrap();
    server.await.unwrap();
    assert!(TicketUpdate::default().is_empty());
}

#[tokio::test]
async fn a_move_uses_the_move_procedure_with_the_wire_status() {
    let (features, server) = fixture(
        "tickets/move",
        SPACE,
        json!({ "id": "t1", "status": "closed" }),
        ticket("closed"),
    )
    .await;
    let moved = features
        .space("team")
        .move_ticket("t1", TicketStatus::Closed)
        .await
        .unwrap();
    assert_eq!(moved.status, TicketStatus::Closed);
    server.await.unwrap();
}

#[tokio::test]
async fn comments_are_posted_and_read_per_ticket() {
    let comment = json!({
        "id": "c1", "ticketId": "t1", "body": "Looks good", "authorBotId": null, "authorUserId": "user",
        "authorName": "Ada", "createdAt": "2026-11-19T10:06:00.000Z", "updatedAt": "2026-11-19T10:06:00.000Z"
    });
    let (features, server) = fixture(
        "tickets/comment",
        SPACE,
        json!({ "ticketId": "t1", "body": "Looks good" }),
        comment.clone(),
    )
    .await;
    assert_eq!(
        features
            .space("team")
            .comment_ticket("t1", "Looks good")
            .await
            .unwrap()
            .author_name
            .as_deref(),
        Some("Ada")
    );
    server.await.unwrap();
    let (features, server) = fixture(
        "tickets/comments",
        SPACE,
        json!({ "ticketId": "t1" }),
        json!([comment]),
    )
    .await;
    assert_eq!(
        features
            .space("team")
            .ticket_comments("t1")
            .await
            .unwrap()
            .len(),
        1
    );
    server.await.unwrap();
}

#[tokio::test]
async fn turning_board_on_keeps_other_labs_and_is_account_scoped() {
    let current = Labs {
        labs: vec!["future".into()],
        labs_available: vec!["board".into()],
    };
    assert!(current.board_switchable() && !current.board_on());
    let (features, server) = fixture(
        "preferences/update",
        None,
        json!({ "labs": ["future", "board"] }),
        json!({ "labs": ["board"], "labsAvailable": ["board"], "ticketBoardEnabled": true }),
    )
    .await;
    assert!(features
        .set_board_lab(&current, true)
        .await
        .unwrap()
        .board_on());
    server.await.unwrap();
}

#[test]
fn a_heartbeat_names_no_board_or_ticket() {
    let heartbeat: BoardChange =
        serde_json::from_value(json!({ "spaceId": "team", "createdAt": "now" })).unwrap();
    let change: BoardChange = serde_json::from_value(
        json!({ "spaceId": "team", "boardId": "b1", "ticketId": "t1", "createdAt": "now" }),
    )
    .unwrap();
    assert!(heartbeat.is_heartbeat());
    assert!(!change.is_heartbeat());
}
