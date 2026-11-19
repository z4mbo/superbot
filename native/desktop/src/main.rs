#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod api;
mod app;
mod assets;
mod cards;
mod clock;
mod files;
mod fonts;
mod outbox;
mod runtime;
mod theme;
mod transcript;
mod ui;
mod web;

use gpui_kit::*;

use crate::app::Desktop;
use crate::theme::{Skin, Theme};

const APP_NAME: &str = "Superbot";

fn main() {
    let server = std::env::var("SUPERBOT_SERVER")
        .ok()
        .filter(|server| !server.trim().is_empty())
        .unwrap_or_else(|| superbot_client::DEFAULT_SERVER.to_owned());
    let chosen_skin = std::env::var("SUPERBOT_SKIN").ok().and_then(|name| Skin::named(&name));

    gpui_kit::application().with_assets(assets::Assets).run(move |cx| {
        gpui_kit::init(cx);
        let fonts = fonts::Fonts::load(cx);
        let skin = chosen_skin.unwrap_or_else(|| Skin::for_appearance(cx.window_appearance()));
        Theme::of(skin, &fonts).install(cx);

        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1280.), px(820.)), cx))),
            window_min_size: Some(size(px(760.), px(520.))),
            titlebar: Some(TitlebarOptions {
                title: Some(APP_NAME.into()),
                appears_transparent: true,
                traffic_light_position: None,
            }),
            ..Default::default()
        };
        let (window, desktop) =
            gpui_kit::open_window(options, cx, |window, cx| cx.new(|cx| Desktop::new(server, window, cx)))
                .expect("the main window opens");

        if chosen_skin.is_none() {
            window
                .update(cx, |_, window, cx| {
                    desktop.update(cx, |_, cx| {
                        cx.observe_window_appearance(window, move |_, window, cx| {
                            Theme::of(Skin::for_appearance(window.appearance()), &fonts).install(cx);
                            cx.refresh_windows();
                        })
                        .detach();
                    });
                })
                .ok();
        }
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.activate(true);
    });
}
