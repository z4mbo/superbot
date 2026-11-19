//! Opens the workspace panel for one space of a signed-in account.
//!
//! ```sh
//! SUPERBOT_EMAIL=owner@example.test SUPERBOT_PASSWORD=… \
//!   cargo run -p superbot-workspace-panel --example workspace
//! ```
//!
//! `SUPERBOT_SERVER` defaults to the local hosting origin. `SUPERBOT_SPACE`
//! picks a space by name or id (default: the first). `SUPERBOT_SECTION` is a
//! section name such as `people`. `SUPERBOT_SKIN` is `midnight` or `daylight`.

use std::env;

use gpui_kit::component::{Theme, ThemeMode};
use superbot_client::{Client, DEFAULT_SERVER};
use superbot_workspace_panel::{open, PanelEvent, Section};

fn main() {
    let server = env::var("SUPERBOT_SERVER").unwrap_or_else(|_| DEFAULT_SERVER.into());
    let email = env::var("SUPERBOT_EMAIL").expect("set SUPERBOT_EMAIL");
    let password = env::var("SUPERBOT_PASSWORD").expect("set SUPERBOT_PASSWORD");
    let wanted_space = env::var("SUPERBOT_SPACE").ok();
    let section = env::var("SUPERBOT_SECTION").ok().and_then(|name| {
        Section::ALL
            .into_iter()
            .find(|section| section.label().eq_ignore_ascii_case(&name))
    });
    let daylight =
        env::var("SUPERBOT_SKIN").is_ok_and(|skin| skin.eq_ignore_ascii_case("daylight"));

    let runtime = tokio::runtime::Runtime::new().expect("failed to start Tokio");
    let (client, space) = runtime.block_on(async {
        let client = Client::new(&server)
            .expect("invalid server")
            .sign_in(&email, &password)
            .await
            .expect("sign-in failed");
        let spaces = client.list_spaces().await.expect("could not list spaces");
        let space = match &wanted_space {
            Some(wanted) => spaces
                .into_iter()
                .find(|space| space.id == *wanted || space.name == *wanted)
                .expect("no such space"),
            None => spaces.into_iter().next().expect("the account has no space"),
        };
        (client, space)
    });
    println!("space: {} ({})", space.name, space.id);
    let _network = runtime.enter();

    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            let mode = if daylight {
                ThemeMode::Light
            } else {
                ThemeMode::Dark
            };
            Theme::change(mode, None, cx);
            let panel = open(client, space.id, section, cx).expect("failed to open the panel");
            cx.subscribe(&panel, |_, event: &PanelEvent, _| {
                println!("event: {event:?}")
            })
            .detach();
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            cx.activate(true);
        });
}
