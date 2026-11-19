use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    thread,
    time::Duration,
};

use super::*;

#[test]
fn scaffold_and_validate_without_overwriting() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugin.json");
    scaffold::write(
        &path,
        "release-notes",
        Some("Release notes".into()),
        scaffold::Template::Skill,
    )
    .unwrap();
    let original = fs::read(&path).unwrap();
    assert!(scaffold::write(&path, "another-plugin", None, scaffold::Template::Skill).is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(
        serde_json::to_value(manifest::read(&path).unwrap()).unwrap()["name"],
        "Release notes"
    );
}

#[test]
fn manifest_matches_registry_constraints() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugin.json");
    let valid = json!({
        "schemaVersion": 1.0, "name": "\u{feff}Release notes ", "description": "Draft notes.",
        "parts": [
            { "kind": "skill", "id": "notes", "instructions": " Summarize the issues. " },
            { "kind": "mcp", "id": "tracker", "transport": "streamable_http", "endpoint": " https://plugin.example.test/mc\np " },
        ]
    });
    fs::write(&path, valid.to_string()).unwrap();
    let normalized = serde_json::to_value(manifest::read(&path).unwrap()).unwrap();
    assert_eq!(normalized["schemaVersion"], 1);
    assert_eq!(normalized["name"], "Release notes");
    assert_eq!(
        normalized["parts"][1]["endpoint"],
        "https://plugin.example.test/mcp"
    );
    assert_eq!(
        normalized["parts"][0]["instructions"],
        "Summarize the issues."
    );

    for (field, value) in [
        ("/schemaVersion", json!(2)),
        ("/name", json!("😀".repeat(61))),
        ("/description", json!(" ")),
        ("/parts", json!([])),
        ("/parts/0/id", json!("double--hyphen")),
        ("/parts/0/instructions", json!("x".repeat(16001))),
        ("/parts/1/id", json!("notes")),
        ("/parts/1/transport", json!("stdio")),
        ("/parts/1/endpoint", json!("http://plugin.example.test/mcp")),
        (
            "/parts/1/endpoint",
            json!("https://plugin.example.test/mcp?"),
        ),
        (
            "/parts/1/endpoint",
            json!("https://plugin.example.test/mcp#"),
        ),
        (
            "/parts/1/endpoint",
            json!("https://user:pass@plugin.example.test/mcp"),
        ),
    ] {
        let mut invalid = valid.clone();
        *invalid.pointer_mut(field).unwrap() = value;
        fs::write(&path, invalid.to_string()).unwrap();
        assert!(manifest::read(&path).is_err(), "{field}");
    }
    let mut invalid = valid;
    invalid["parts"][1]["headers"] = json!({});
    fs::write(&path, invalid.to_string()).unwrap();
    assert!(manifest::read(&path).is_err());
}

#[test]
fn space_selection_rejects_ambiguity_and_accepts_ids() {
    let spaces = [
        Space {
            id: "first".into(),
            name: "Shared".into(),
            shared: true,
        },
        Space {
            id: "second".into(),
            name: "Shared".into(),
            shared: true,
        },
    ];
    assert!(select_space(&spaces, None).is_err());
    assert!(select_space(&spaces, Some("Shared")).is_err());
    assert_eq!(select_space(&spaces, Some("second")).unwrap().id, "second");
    assert_eq!(select_space(&spaces[..1], None).unwrap().id, "first");
}

#[tokio::test]
async fn submit_uses_validated_manifest_and_registry_version_range() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugin.json");
    scaffold::write(&path, "release-notes", None, scaffold::Template::Skill).unwrap();
    let cli = Cli::try_parse_from([
        "superbot-plugin",
        "submit",
        "release-notes",
        "2147483647",
        "--manifest",
        path.to_str().unwrap(),
    ])
    .unwrap();
    let response = json!({ "id": "version", "status": "pending" });
    let (client, server) = fixture(vec![Exchange {
        procedure: "pluginRegistry/submit",
        input: json!({
            "slug": "release-notes",
            "version": 2147483647,
            "manifest": serde_json::to_value(manifest::read(&path).unwrap()).unwrap(),
        }),
        response: response.clone(),
        status: "200 OK",
    }]);
    let result = cli
        .command
        .request()
        .unwrap()
        .execute(&client, "fixture-space")
        .await
        .unwrap();
    assert_eq!(result, response);
    server.join().unwrap();
    for version in ["0", "2147483648"] {
        assert!(
            Cli::try_parse_from(["superbot-plugin", "publish", "release-notes", version]).is_err()
        );
    }
}

struct Exchange {
    procedure: &'static str,
    input: Value,
    response: Value,
    status: &'static str,
}

fn fixture(exchanges: Vec<Exchange>) -> (Client, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = Client::new(&format!("http://{}", listener.local_addr().unwrap()))
        .unwrap()
        .with_token("fixture.signed")
        .unwrap();
    let server = thread::spawn(move || {
        for exchange in exchanges {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&mut socket);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert_eq!(
                line.trim_end(),
                format!("POST /rpc/{} HTTP/1.1", exchange.procedure)
            );
            let mut headers = std::collections::HashMap::new();
            loop {
                line.clear();
                assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
                let (name, value) = line.trim_end().split_once(':').unwrap();
                headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
            }
            assert_eq!(headers["authorization"], "Bearer fixture.signed");
            assert_eq!(headers["x-rakazo-space-id"], "fixture-space");
            let mut body = vec![0; headers["content-length"].parse().unwrap()];
            reader.read_exact(&mut body).unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap(),
                json!({ "json": exchange.input })
            );
            let body = json!({ "json": exchange.response }).to_string();
            write!(socket,
                "HTTP/1.1 {}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                exchange.status, body.len(),
            ).unwrap();
        }
    });
    (client, server)
}

async fn execute(client: &Client, args: &[&str]) -> Result<Value> {
    let cli = Cli::try_parse_from(std::iter::once("superbot-plugin").chain(args.iter().copied()))?;
    cli.command
        .request()?
        .execute(client, "fixture-space")
        .await
}

#[tokio::test]
async fn status_follows_publisher_cursors() {
    let release = json!({ "id": "version", "slug": "release-notes", "status": "pending" });
    let (client, server) = fixture(vec![
        Exchange {
            procedure: "pluginRegistry/mine",
            input: json!({ "limit": 50 }),
            response: json!({ "items": [], "nextAfter": "opaque" }),
            status: "200 OK",
        },
        Exchange {
            procedure: "pluginRegistry/mine",
            input: json!({ "limit": 50, "after": "opaque" }),
            response: json!({ "items": [release], "nextAfter": null }),
            status: "200 OK",
        },
    ]);
    assert_eq!(
        execute(&client, &["status", "version"]).await.unwrap(),
        release
    );
    server.join().unwrap();
}

#[tokio::test]
async fn grants_and_review_use_registry_wire_and_server_authorization() {
    let (client, server) = fixture(vec![
        Exchange {
            procedure: "pluginRegistry/setGrants",
            input: json!({ "installationId": "install", "botId": "bot", "partIds": ["summary"] }),
            response: json!({ "id": "install", "grants": [{ "botId": "bot", "partId": "summary" }] }),
            status: "200 OK",
        },
        Exchange {
            procedure: "pluginRegistry/setGrants",
            input: json!({ "installationId": "install", "botId": "bot", "partIds": [] }),
            response: json!({ "id": "install", "grants": [] }),
            status: "200 OK",
        },
        Exchange {
            procedure: "pluginRegistry/review",
            input: json!({ "versionId": "version", "decision": "rejected", "reason": "Needs edits" }),
            response: json!({ "code": "FORBIDDEN", "message": "Admin access required", "status": 403 }),
            status: "403 Forbidden",
        },
    ]);
    let value = execute(&client, &["grant", "install", "bot", "summary"])
        .await
        .unwrap();
    assert_eq!(value["grants"][0]["partId"], "summary");
    let value = execute(&client, &["grant", "install", "bot"])
        .await
        .unwrap();
    assert_eq!(value["grants"], json!([]));
    let error = execute(
        &client,
        &["review", "version", "rejected", "--reason", " Needs edits "],
    )
    .await
    .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<Error>(),
        Some(Error::Server { status: 403, .. })
    ));
    server.join().unwrap();
}

#[tokio::test]
async fn list_review_install_and_uninstall_use_registry_routes() {
    let page = json!({ "items": [], "nextAfter": "more" });
    let cases = [
        (
            vec![
                "list",
                "discover",
                "--slug",
                "release-notes",
                "--query",
                "  release notes  ",
                "--after",
                "cursor",
                "--limit",
                "7",
            ],
            "pluginRegistry/discover",
            json!({ "slug": "release-notes", "query": "release notes", "after": "cursor", "limit": 7 }),
            page.clone(),
        ),
        (
            vec!["list", "submissions", "--status", "approved"],
            "pluginRegistry/submissions",
            json!({ "status": "approved", "limit": 20 }),
            page.clone(),
        ),
        (
            vec!["review", "version", "approved"],
            "pluginRegistry/review",
            json!({ "versionId": "version", "decision": "approved" }),
            json!({ "status": "approved" }),
        ),
        (
            vec!["install", "version"],
            "pluginRegistry/install",
            json!({ "versionId": "version" }),
            json!({ "id": "install", "grants": [] }),
        ),
        (
            vec!["switch-version", "install", "old-version", "new-version"],
            "pluginRegistry/switchVersion",
            json!({ "installationId": "install", "expectedVersionId": "old-version", "versionId": "new-version" }),
            json!({ "id": "install", "grants": [] }),
        ),
        (
            vec!["list", "installations"],
            "pluginRegistry/installations",
            json!({ "limit": 20 }),
            page,
        ),
        (
            vec!["uninstall", "install"],
            "pluginRegistry/uninstall",
            json!({ "installationId": "install" }),
            json!({ "ok": true }),
        ),
    ];
    let (client, server) = fixture(
        cases
            .iter()
            .map(|(_, procedure, input, response)| Exchange {
                procedure,
                input: input.clone(),
                response: response.clone(),
                status: "200 OK",
            })
            .collect(),
    );
    for (args, _, _, response) in cases {
        assert_eq!(execute(&client, &args).await.unwrap(), response);
    }
    server.join().unwrap();
}

#[test]
fn discover_query_is_bounded_and_restricted_to_discover() {
    for args in [
        vec!["list", "mine", "--query", "test"],
        vec!["list", "discover", "--query", " "],
        vec!["list", "discover", "--query", &"x".repeat(121)],
    ] {
        let command = Cli::try_parse_from(std::iter::once("superbot-plugin").chain(args))
            .unwrap()
            .command;
        assert!(command.request().is_err());
    }
}
