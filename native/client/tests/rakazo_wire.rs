use std::{
    any::Any,
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex, Once},
    thread,
    time::Duration,
};

use futures_util::StreamExt;
use keyring::{
    credential::{Credential, CredentialApi, CredentialBuilderApi},
    mock::MockCredential,
};
use serde_json::{json, Value};
use superbot_client::{
    Client, CredentialStore, Error, SignUpResult, SpaceNotification, ThreadTarget,
    SERVER_UNREACHABLE,
};

struct Request {
    path: String,
    headers: Vec<(String, String)>,
    body: Value,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

struct Exchange {
    path: &'static str,
    status: &'static str,
    headers: &'static str,
    body: &'static str,
}

fn fixture(exchanges: Vec<Exchange>) -> (Client, thread::JoinHandle<Vec<Request>>) {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = Client::new(&format!("http://{}", server.local_addr().unwrap())).unwrap();
    let requests = thread::spawn(move || {
        exchanges
            .into_iter()
            .map(|exchange| {
                let (mut socket, _) = server.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(&mut socket);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut words = line.split_whitespace();
                assert_eq!(words.next(), Some("POST"));
                let path = words.next().unwrap().to_owned();
                assert_eq!(path, exchange.path);
                let mut headers = Vec::new();
                loop {
                    line.clear();
                    assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                    if line == "\r\n" {
                        break;
                    }
                    let (name, value) = line.trim_end().split_once(':').unwrap();
                    headers.push((name.to_owned(), value.trim().to_owned()));
                }
                let length: usize = headers
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .unwrap()
                    .1
                    .parse()
                    .unwrap();
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                write!(
                    socket,
                    "HTTP/1.1 {}\r\nConnection: close\r\nContent-Length: {}\r\n{}\r\n{}",
                    exchange.status,
                    exchange.body.len(),
                    exchange.headers,
                    exchange.body
                )
                .unwrap();
                Request {
                    path,
                    headers,
                    body: serde_json::from_slice(&body).unwrap(),
                }
            })
            .collect()
    });
    (client, requests)
}

fn json_response(path: &'static str, body: &'static str) -> Exchange {
    Exchange {
        path,
        status: "200 OK",
        headers: "Content-Type: application/json\r\n",
        body,
    }
}

// The keyring crate's mock only persists for one entry. Share each mock across
// the entries that CredentialStore opens for the same fixture server.
#[derive(Default)]
struct FixtureKeyring(Mutex<HashMap<String, Arc<MockCredential>>>);

impl CredentialBuilderApi for FixtureKeyring {
    fn build(&self, _: Option<&str>, _: &str, user: &str) -> keyring::Result<Box<Credential>> {
        let mut entries = self.0.lock().unwrap();
        Ok(Box::new(FixtureCredential(
            entries.entry(user.into()).or_default().clone(),
        )))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

struct FixtureCredential(Arc<MockCredential>);

impl CredentialApi for FixtureCredential {
    fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
        self.0.set_secret(secret)
    }

    fn get_secret(&self) -> keyring::Result<Vec<u8>> {
        self.0.get_secret()
    }

    fn delete_credential(&self) -> keyring::Result<()> {
        self.0.delete_credential()
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

async fn remember_fixture_session(client: &Client) {
    static INSTALL_KEYRING: Once = Once::new();
    INSTALL_KEYRING
        .call_once(|| keyring::set_default_credential_builder(Box::<FixtureKeyring>::default()));
    CredentialStore::save(&client.with_token("fixture.signature").unwrap())
        .await
        .unwrap();
}

async fn validate_session(client: Client) -> Result<(Value, Value), Error> {
    let me = client.rpc("me", None, json!({})).await?;
    let navigation = client.rpc("spaces/list", None, json!({})).await?;
    Ok((me, navigation))
}

fn gateway_error(path: &'static str) -> Exchange {
    Exchange {
        path,
        status: "502 Bad Gateway",
        headers: "",
        body: "",
    }
}

#[tokio::test]
async fn restore_recovers_from_empty_gateway_errors_on_both_session_reads() {
    let me = || json_response("/rpc/me", r#"{"json":{"name":"Fixture"}}"#);
    let (client, requests) = fixture(vec![
        gateway_error("/rpc/me"),
        me(),
        gateway_error("/rpc/spaces/list"),
        me(),
        json_response(
            "/rpc/spaces/list",
            r#"{"json":{"spaces":[{"id":"space-1"}]}}"#,
        ),
    ]);
    remember_fixture_session(&client).await;

    let session = CredentialStore::restore(&client, validate_session)
        .await
        .unwrap();
    assert_eq!(
        session,
        Some((
            json!({"name":"Fixture"}),
            json!({"spaces":[{"id":"space-1"}]})
        ))
    );
    assert!(CredentialStore::load(&client).await.unwrap().is_some());
    for request in requests.join().unwrap() {
        assert_eq!(
            request.header("authorization"),
            Some("Bearer fixture.signature")
        );
    }
}

#[tokio::test]
async fn restore_stops_retrying_when_the_next_wait_exceeds_the_budget() {
    let (client, requests) = fixture((0..5).map(|_| gateway_error("/rpc/me")).collect());
    remember_fixture_session(&client).await;

    let error = CredentialStore::restore(&client, validate_session)
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Unavailable { .. }));
    assert_eq!(error.to_string(), SERVER_UNREACHABLE);
    assert!(CredentialStore::load(&client).await.unwrap().is_some());
    requests.join().unwrap();
}

#[tokio::test]
async fn restore_will_not_retry_before_retry_after_even_to_fit_the_budget() {
    let (client, requests) = fixture(vec![Exchange {
        headers: "Retry-After: 30\r\n",
        ..gateway_error("/rpc/me")
    }]);
    remember_fixture_session(&client).await;

    let error = CredentialStore::restore(&client, validate_session)
        .await
        .unwrap_err();
    assert!(
        matches!(error, Error::Unavailable { retry_after: Some(delay) } if delay == Duration::from_secs(30))
    );
    assert!(CredentialStore::load(&client).await.unwrap().is_some());
    requests.join().unwrap();
}

#[tokio::test]
async fn restore_discards_a_session_rejected_with_401_without_retry() {
    let (client, requests) = fixture(vec![Exchange {
        status: "401 Unauthorized",
        ..gateway_error("/rpc/me")
    }]);
    remember_fixture_session(&client).await;

    assert!(CredentialStore::restore(&client, validate_session)
        .await
        .unwrap()
        .is_none());
    assert!(CredentialStore::load(&client).await.unwrap().is_none());
    requests.join().unwrap();
}

#[tokio::test]
async fn gateways_report_unavailability_with_or_without_a_body() {
    let exchanges = [
        "502 Bad Gateway",
        "503 Service Unavailable",
        "504 Gateway Timeout",
    ]
    .into_iter()
    .flat_map(|status| {
        ["", r#"{"json":{"status":401,"message":"Proxy error"}}"#].map(|body| Exchange {
            path: "/rpc/me",
            status,
            headers: "Content-Type: application/json\r\nRetry-After: 3\r\n",
            body,
        })
    })
    .collect();
    let (client, requests) = fixture(exchanges);
    let signed_in = client.with_token("fixture.signature").unwrap();
    for _ in 0..6 {
        let error = signed_in
            .rpc::<Value>("me", None, json!({}))
            .await
            .unwrap_err();
        assert!(
            matches!(error, Error::Unavailable { retry_after: Some(delay) } if delay == Duration::from_secs(3))
        );
        assert!(error.is_retryable());
        assert!(!error.is_unauthorized());
        assert_eq!(error.to_string(), SERVER_UNREACHABLE);
    }
    requests.join().unwrap();
}

#[tokio::test]
async fn sidebar_notifications_are_signed_scoped_and_drop_chat_alerts() {
    let (client, requests) = fixture(vec![
        Exchange {
            path: "/rpc/notifications/subscribe",
            status: "200 OK",
            headers: "Content-Type: text/event-stream\r\n",
            body: concat!(
                "event: message\ndata: {\"json\":{\"type\":\"heartbeat\"}}\n\n",
                "event: message\ndata: {\"json\":{\"type\":\"alert\",\"alert\":{\"body\":\"Private chat text\"}}}\n\n",
                "event: message\ndata: {\"json\":{\"type\":\"roster\"}}\n\n",
                "event: message\ndata: {\"json\":{\"type\":\"runs\"}}\n\n",
                "event: message\ndata: {\"json\":{\"type\":\"organizations\"}}\n\n",
                "event: message\ndata: {\"json\":{\"type\":\"unknownFutureSignal\"}}\n\n",
                "event: done\ndata: {}\n\n",
            ),
        },
        Exchange {
            path: "/rpc/notifications/subscribe",
            status: "401 Unauthorized",
            headers: "Content-Type: application/json\r\n",
            body: r#"{"json":{"status":401,"code":"UNAUTHORIZED"}}"#,
        },
    ]);
    let client = client.with_token("fixture.signature").unwrap();
    let mut events = client.subscribe_notifications("space-1").await.unwrap();
    for expected in [
        SpaceNotification::Roster,
        SpaceNotification::Runs,
        SpaceNotification::Organizations,
    ] {
        assert_eq!(events.next().await.unwrap().unwrap(), expected);
    }
    assert!(events.next().await.is_none());
    let denied = client.subscribe_notifications("space-2").await;
    assert!(matches!(denied, Err(error) if error.is_unauthorized()));

    let requests = requests.join().unwrap();
    for (request, space) in requests.iter().zip(["space-1", "space-2"]) {
        assert_eq!(request.header("x-rakazo-space-id"), Some(space));
        assert_eq!(
            request.header("authorization"),
            Some("Bearer fixture.signature")
        );
        assert_eq!(request.body, json!({ "json": {} }));
    }
}

#[tokio::test]
async fn sign_in_discover_send_follow_and_sign_out() {
    let (client, requests) = fixture(vec![
        Exchange {
            path: "/api/auth/sign-in/email",
            status: "200 OK",
            headers: "Content-Type: application/json\r\nSet-Auth-Token: session.signature%3D\r\n",
            body: r#"{"token":"unsigned-body-token"}"#,
        },
        json_response("/rpc/spaces/list", r#"{"json":{"current":{"id":"space-1"},"spaces":[{"id":"space-1","name":"Personal"}]}}"#),
        json_response("/rpc/organizations/list", r#"{"json":{"activeOrganizationId":"org-1","organizations":[{"id":"org-1","defaultSpaceId":"space-1","spaceIds":["space-1"]},{"id":"org-2","defaultSpaceId":"space-2","spaceIds":["space-2"]}]}}"#),
        json_response("/rpc/spaces/list", r#"{"json":{"spaces":[{"id":"space-2","name":"Team"},{"id":"space-1","name":"Personal"}]}}"#),
        json_response("/rpc/bots/list", r#"{"json":[{"id":"bot-1","name":"Research"}]}"#),
        json_response("/rpc/threads/get", r#"{"json":{"threadId":"thread-1","cursor":4,"messages":[{"id":"m0","seq":1,"role":"bot","blocks":[{"kind":"text","text":"Welcome"}]}]}}"#),
        json_response("/rpc/threads/send", r#"{"json":{"taskId":"task-1","runId":"run-1","runIds":["run-1"],"seq":2}}"#),
        Exchange {
            path: "/rpc/threads/subscribe",
            status: "200 OK",
            headers: "Content-Type: text/event-stream\r\n",
            body: concat!(
                ": keepalive\r\n\r\n",
                "event: message\r\ndata: {\"json\":{\"type\":\"heartbeat\",\"seq\":0,\"id\":\"heartbeat\",\"payload\":{}}}\r\n\r\n",
                "event: message\ndata: {\"json\":{\"type\":\"thread.message.created\",\"seq\":6,\"id\":\"event-1\",\"runId\":\"run-1\",\"payload\":{\"messageId\":\"reply-1\",\"seq\":3,\"role\":\"bot\",\"blocks\":[{\"kind\":\"text\",\"text\":\"Caffè ☕\"}]}}}\n\n",
                "event: message\ndata: {\"json\":{\"type\":\"run.completed\",\"seq\":7,\"id\":\"event-2\",\"runId\":\"run-1\",\"payload\":{}}}\n\n",
                "event: done\ndata: {}\n\n"
            ),
        },
        json_response("/api/auth/sign-out", r#"{"success":true}"#),
    ]);
    let authenticated = client
        .sign_in("fixture@example.test", "fixture-password")
        .await
        .unwrap();
    let spaces = authenticated.list_spaces().await.unwrap();
    assert_eq!(spaces.len(), 2);
    assert_eq!(spaces[1].name, "Team");
    let space = &spaces[0];
    let agent = &authenticated.list_agents(&space.id).await.unwrap()[0];
    assert_eq!((&*space.name, &*agent.name), ("Personal", "Research"));
    let snapshot = authenticated.thread(&space.id, &agent.id).await.unwrap();
    assert_eq!(snapshot.messages[0].text, "Welcome");
    let sent = authenticated
        .send_with_nonce(&space.id, &agent.id, "Hello", "nonce-1")
        .await
        .unwrap();
    assert_eq!(sent.seq, 2);
    let mut stream = authenticated
        .subscribe(&space.id, &agent.id, snapshot.cursor)
        .await
        .unwrap();
    assert_eq!(stream.next().await.unwrap().unwrap().kind, "heartbeat");
    let reply = stream
        .next()
        .await
        .unwrap()
        .unwrap()
        .message()
        .unwrap()
        .unwrap();
    assert_eq!(
        (reply.id.as_str(), reply.seq, reply.text.as_str()),
        ("reply-1", 3, "Caffè ☕")
    );
    let complete = stream.next().await.unwrap().unwrap();
    assert_eq!(complete.kind, "run.completed");
    assert_eq!(complete.run_id.as_deref(), Some(sent.run_id.as_str()));
    assert!(stream.next().await.is_none());
    authenticated.sign_out().await.unwrap();

    let requests = requests.join().unwrap();
    assert_eq!(requests[0].header("origin"), Some("rakazo://"));
    assert_eq!(
        requests[0].body,
        json!({"email":"fixture@example.test","password":"fixture-password"})
    );
    for request in &requests[1..] {
        assert_eq!(
            request.header("authorization"),
            Some("Bearer session.signature%3D")
        );
        assert_eq!(request.header("cookie"), None);
    }
    assert_eq!(requests[3].header("x-rakazo-space-id"), Some("space-2"));
    for request in &requests[4..8] {
        assert_eq!(request.header("x-rakazo-space-id"), Some("space-1"));
    }
    assert_eq!(
        requests[6].body,
        json!({"json":{"botId":"bot-1","text":"Hello","clientNonce":"nonce-1"}})
    );
    assert_eq!(
        requests[7].body,
        json!({"json":{"botId":"bot-1","cursor":4}})
    );
    assert_eq!(requests[8].path, "/api/auth/sign-out");
}

#[tokio::test]
async fn local_history_uses_signed_text_only_requests() {
    let (client, requests) = fixture(vec![
        json_response(
            "/rpc/threads/appendLocalHistory",
            r#"{"json":{"messageIds":["note"]}}"#,
        ),
        json_response(
            "/rpc/threads/appendLocalHistory",
            r#"{"json":{"messageIds":["prompt","reply"]}}"#,
        ),
    ]);
    let client = client.with_token("fixture.signature").unwrap();
    let operation_id = "4f7df854-760b-4aaf-9efe-ed8442d81c43";
    let note = client
        .append_local_note("space", ThreadTarget::Bot("agent"), operation_id, "Note")
        .await
        .unwrap();
    let turn = client
        .append_local_turn(
            "space",
            ThreadTarget::Group("room"),
            operation_id,
            "Prompt",
            "Reply",
        )
        .await
        .unwrap();
    assert_eq!(note.message_ids, ["note"]);
    assert_eq!(turn.message_ids, ["prompt", "reply"]);
    let requests = requests.join().unwrap();
    for request in &requests {
        assert_eq!(
            request.header("authorization"),
            Some("Bearer fixture.signature")
        );
        assert_eq!(request.header("x-rakazo-space-id"), Some("space"));
    }
    assert_eq!(
        requests[0].body,
        json!({"json": {
            "botId": "agent", "operationId": operation_id, "text": "Note"
        }})
    );
    assert_eq!(
        requests[1].body,
        json!({"json": {
            "groupId": "room", "operationId": operation_id, "text": "Prompt", "reply": "Reply"
        }})
    );
}

#[tokio::test]
async fn group_stream_resumes_with_both_speaker_identities() {
    let (client, requests) = fixture(vec![Exchange {
        path: "/rpc/threads/subscribe",
        status: "200 OK",
        headers: "Content-Type: text/event-stream\r\n",
        body: concat!(
            "event: message\ndata: ",
            r#"{"json":{"id":"ev1","seq":14,"type":"thread.message.created","botId":"agent-1","payload":{"messageId":"m1","seq":9,"role":"user","author":{"id":"member-1","name":"Casey"},"blocks":[{"kind":"text","text":"Hello"}]}}}"#,
            "\n\nevent: message\ndata: ",
            r#"{"json":{"id":"ev2","seq":15,"type":"thread.message.created","botId":"agent-1","payload":{"messageId":"m2","seq":10,"role":"bot","blocks":[{"kind":"text","text":"Hi"}]}}}"#,
            "\n\nevent: message\ndata: ",
            r#"{"json":{"id":"ev3","seq":16,"type":"thread.message.created","botId":"thread","payload":{"messageId":"m3","seq":11,"role":"bot","origin":"local_cli","author":{"id":"member-1","name":"Casey"},"blocks":[{"kind":"text","text":"Local reply"}]}}}"#,
            "\n\nevent: done\ndata: {}\n\n"
        ),
    }]);
    let client = client.with_token("fixture.signature").unwrap();
    let mut stream = client
        .subscribe_thread("shared-space", ThreadTarget::Group("room"), 13)
        .await
        .unwrap();
    let human = stream
        .next()
        .await
        .unwrap()
        .unwrap()
        .message()
        .unwrap()
        .unwrap();
    assert_eq!(human.author.unwrap().name, "Casey");
    assert!(human.bot_id.is_none());
    let bot = stream
        .next()
        .await
        .unwrap()
        .unwrap()
        .message()
        .unwrap()
        .unwrap();
    assert_eq!(bot.bot_id.as_deref(), Some("agent-1"));
    let local = stream
        .next()
        .await
        .unwrap()
        .unwrap()
        .message()
        .unwrap()
        .unwrap();
    assert_eq!(local.origin.as_deref(), Some("local_cli"));
    assert_eq!(local.author.unwrap().id, "member-1");
    assert!(local.bot_id.is_none() && local.run_id.is_none());
    assert!(stream.next().await.is_none());
    let received = requests.join().unwrap();
    assert_eq!(
        received[0].body,
        json!({"json":{"groupId":"room","cursor":13}})
    );
    assert_eq!(
        received[0].header("x-rakazo-space-id"),
        Some("shared-space")
    );
}

#[tokio::test]
async fn switching_organizations_preserves_the_other_spaces_in_the_picker() {
    let (client, requests) = fixture(vec![
        json_response(
            "/rpc/organizations/list",
            r#"{"json":{"activeOrganizationId":"team-org","organizations":[{"id":"team-org","defaultSpaceId":"team","spaceIds":["team"]},{"id":"home-org","defaultSpaceId":"home","spaceIds":["home"]}]}}"#,
        ),
        json_response(
            "/rpc/spaces/list",
            r#"{"json":{"spaces":[{"id":"home","name":"Personal"},{"id":"team","name":"Team","shared":true}]}}"#,
        ),
    ]);
    let client = client.with_token("fixture.signature").unwrap();
    let current = superbot_client::Space {
        id: "team".into(),
        name: "Team".into(),
        shared: true,
    };
    let spaces = client
        .include_other_spaces(Some("team"), vec![current])
        .await
        .unwrap();
    assert_eq!(spaces.len(), 2);
    assert!(spaces[0].shared);
    assert_eq!(spaces[1].id, "home");
    let requests = requests.join().unwrap();
    assert_eq!(requests[0].header("x-rakazo-space-id"), Some("team"));
    assert_eq!(requests[1].header("x-rakazo-space-id"), Some("home"));
}

#[tokio::test]
async fn signup_honors_mailbox_verification_and_requires_signed_sessions() {
    let path = "/api/auth/sign-up/email";
    let (client, requests) = fixture(vec![
        Exchange {
            path, status: "200 OK",
            headers: "Content-Type: application/json\r\nSet-Cookie: better-auth.session_token=signed.fixture; HttpOnly\r\n",
            body: r#"{"token":"unsigned","user":{"name":"Alex"}}"#,
        },
        json_response(path, r#"{"token":null,"user":{"name":"Alex"}}"#),
        json_response(path, r#"{"token":"unsigned"}"#),
    ]);
    let signup = || client.sign_up("Alex", "alex@example.test", "fixture-password");
    assert!(matches!(signup().await, Ok(SignUpResult::SignedIn(_))));
    assert!(matches!(signup().await, Ok(SignUpResult::VerifyEmail)));
    assert!(matches!(signup().await, Err(Error::InvalidSession)));
    let requests = requests.join().unwrap();
    assert_eq!(
        requests[0].body,
        json!({"email":"alex@example.test","name":"Alex","password":"fixture-password"})
    );
}

#[tokio::test]
async fn reports_http_and_stream_auth_errors() {
    let (client, requests) = fixture(vec![
        Exchange {
            status: "401 Unauthorized",
            ..json_response("/rpc/spaces/list", r#"{"json":{"status":401,"code":"UNAUTHORIZED","message":"Session expired"}}"#)
        },
        Exchange {
            path: "/rpc/threads/subscribe",
            status: "200 OK",
            headers: "Content-Type: text/event-stream\r\n",
            body: "event: error\ndata: {\"json\":{\"status\":401,\"code\":\"UNAUTHORIZED\",\"message\":\"Session expired\"}}\n\n",
        },
    ]);
    let client = client.with_token("session.signature").unwrap();
    let error = client.list_spaces().await.unwrap_err();
    assert!(error.is_unauthorized());
    assert!(error.to_string().contains("Session expired"));
    let mut stream = client.subscribe("space-1", "bot-1", 4).await.unwrap();
    assert!(stream.next().await.unwrap().unwrap_err().is_unauthorized());
    assert!(stream.next().await.is_none());
    requests.join().unwrap();
}

#[tokio::test]
async fn refuses_unsigned_sessions_and_redirected_sign_in() {
    for remote in [
        "http://example.test",
        "https://example.test/path",
        "https://user@example.test",
    ] {
        assert!(matches!(Client::new(remote), Err(Error::InvalidServer)));
    }
    let (client, requests) = fixture(vec![
        json_response("/api/auth/sign-in/email", r#"{"token":"unsigned"}"#),
        Exchange {
            path: "/api/auth/sign-in/email",
            status: "307 Temporary Redirect",
            headers: "Location: http://127.0.0.1:1/\r\n",
            body: "",
        },
    ]);
    assert!(matches!(
        client
            .sign_in("fixture@example.test", "fixture-password")
            .await,
        Err(Error::InvalidSession)
    ));
    assert!(matches!(
        client
            .sign_in("fixture@example.test", "fixture-password")
            .await,
        Err(Error::Server { status: 307, .. })
    ));
    requests.join().unwrap();
}
