use std::io;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};
use superbot_client::{Client, NotificationStream, SpaceNotification};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    tokio::time::timeout(Duration::from_secs(90), verify())
        .await
        .expect("timed out waiting for fixture notifications");
}

async fn verify() {
    let mut args = std::env::args().skip(1);
    let origin = args.next().expect("fixture origin");
    let space = args.next().expect("fixture Space ID");
    assert!(
        origin
            .strip_prefix("http://127.0.0.1:")
            .and_then(|port| port.parse::<u16>().ok())
            .is_some(),
        "the probe requires an isolated loopback origin"
    );
    let mut session = String::new();
    io::stdin()
        .read_line(&mut session)
        .expect("fixture session");
    let client = Client::new(&origin)
        .and_then(|client| client.with_token(session.trim()))
        .expect("signed fixture client");
    let mut events = client
        .subscribe_notifications(&space)
        .await
        .expect("signed notifications subscription");
    let (mut roster, mut runs) = (false, false);
    while !roster || !runs {
        match next(&mut events).await {
            SpaceNotification::Roster => roster = true,
            SpaceNotification::Runs => runs = true,
            _ => {}
        }
    }
    println!("READY");

    for (kind, collection, name, marker) in [
        (
            SpaceNotification::Roster,
            "bots",
            "Fixture agent",
            "AGENT_CREATED",
        ),
        (
            SpaceNotification::Roster,
            "bots",
            "Renamed fixture support",
            "AGENT_RENAMED",
        ),
        (
            SpaceNotification::Roster,
            "groups",
            "Fixture discussion",
            "GROUP_CREATED",
        ),
        (
            SpaceNotification::Roster,
            "groups",
            "Renamed fixture discussion",
            "GROUP_RENAMED",
        ),
        (
            SpaceNotification::Runs,
            "groups",
            "Renamed fixture discussion",
            "GROUP_PREVIEW",
        ),
    ] {
        loop {
            if next(&mut events).await != kind {
                continue;
            }
            let nav: Value = client
                .rpc("spaces/list", Some(&space), json!({}))
                .await
                .expect("scoped Space navigation");
            assert_eq!(nav["current"]["id"].as_str(), Some(space.as_str()));
            let entries = nav["current"][collection]
                .as_array()
                .expect("sidebar entries");
            if entries.iter().any(|entry| {
                entry["name"].as_str() == Some(name)
                    && (kind == SpaceNotification::Roster
                        || entry["preview"]
                            .as_str()
                            .is_some_and(|preview| !preview.is_empty()))
            }) {
                println!("{marker}");
                break;
            }
        }
    }
}

async fn next(events: &mut NotificationStream) -> SpaceNotification {
    events
        .next()
        .await
        .expect("notification stream ended")
        .expect("notification stream failed")
}
