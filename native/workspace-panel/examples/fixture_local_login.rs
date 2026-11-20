use gpui_kit::prelude::*;
use gpui_kit::{
    div, px, size, AppContext, Bounds, Entity, IntoElement, Render, Styled, Window, WindowBounds,
    WindowOptions,
};
use superbot_client::Client;
use superbot_features::local_cli::LocalCli;
use superbot_workspace_panel::{Section, WorkspacePanel};

struct Fixture(Entity<WorkspacePanel>);

impl Render for Fixture {
    fn render(&mut self, _: &mut Window, _: &mut gpui_kit::Context<Self>) -> impl IntoElement {
        div().size_full().child(self.0.clone())
    }
}

fn main() {
    let scope =
        std::env::var_os("SUPERBOT_CONFIG_DIR").expect("set an isolated fixture config directory");
    let scope = std::path::Path::new(&scope);
    assert!(
        scope.is_absolute()
            && scope.file_name().is_some_and(|name| name
                .to_string_lossy()
                .starts_with("superbot-login-fixture-"))
    );
    let client = Client::new("http://127.0.0.1:9")
        .unwrap()
        .with_token("fixture.invalid")
        .unwrap();
    let cli = LocalCli::for_workspace(client.server(), "offline-account", "offline-space").unwrap();
    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(1050.), px(740.)),
                    cx,
                ))),
                ..WindowOptions::default()
            },
            cx,
            |window, cx| {
                window.set_window_title("Superbot local login fixture");
                let panel = WorkspacePanel::build(
                    client,
                    "offline-space",
                    Some(Section::Models),
                    window,
                    cx,
                );
                panel.update(cx, |panel, _| panel.set_local_cli(Some(cli)));
                cx.new(|_| Fixture(panel))
            },
        )
        .unwrap();
    });
}
