#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod api;
mod app;
mod appearance;
mod assets;
mod cards;
mod clock;
mod control;
mod files;
mod fonts;
mod outbox;
mod runtime;
mod terminal;
#[cfg(all(test, target_os = "linux"))]
mod test_support;
mod theme;
mod theme_tokens;
mod transcript;
mod ui;
mod web;

use gpui_kit::*;

use crate::app::Desktop;
use crate::theme::{Skin, Theme};

const APP_NAME: &str = "Superbot";

#[cfg(target_os = "macos")]
actions!(superbot, [Quit]);

fn main() {
    let server = superbot_client::selected_server(std::env::var("SUPERBOT_SERVER").ok().as_deref());
    let chosen_skin = std::env::var("SUPERBOT_SKIN").ok().and_then(|name| Skin::named(&name));

    gpui_kit::application().with_assets(assets::Assets).run(move |cx| {
        gpui_kit::init(cx);
        #[cfg(target_os = "macos")]
        {
            cx.on_action(|_: &Quit, cx| cx.quit());
            cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
            cx.set_menus([Menu::new(APP_NAME).items([MenuItem::action("Quit Superbot", Quit)])]);
        }
        let fonts = fonts::Fonts::load(cx);
        let skin = chosen_skin.unwrap_or_else(|| Skin::for_appearance(cx.window_appearance()));
        Theme::of(skin, &fonts).install(cx);
        #[cfg(target_os = "macos")]
        cx.set_window_appearance(chosen_skin.map(|skin| match skin {
            Skin::Midnight => WindowAppearance::Dark,
            Skin::Daylight => WindowAppearance::Light,
        }));
        superbot_avatars::Avatars::install(appearance::folder().as_deref(), cx);

        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1280.), px(820.)), cx))),
            window_min_size: Some(size(px(760.), px(520.))),
            titlebar: Some(TitlebarOptions {
                title: Some(APP_NAME.into()),
                appears_transparent: true,
                #[cfg(target_os = "macos")]
                traffic_light_position: Some(theme::TRAFFIC_LIGHTS),
                #[cfg(not(target_os = "macos"))]
                traffic_light_position: None,
            }),
            #[cfg(target_os = "macos")]
            app_owns_titlebar_drag: true,
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
