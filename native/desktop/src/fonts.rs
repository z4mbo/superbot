use std::borrow::Cow;

use gpui_kit::component::Theme as KitTheme;
use gpui_kit::{App, Result, SharedString, TextSystem};

const SANS: &str = "Geist";
const MONO: &str = "Geist Mono";
const BUNDLED: &[&[u8]] = &[
    include_bytes!("../assets/fonts/Geist-Variable.ttf"),
    include_bytes!("../assets/fonts/Geist-Italic-Variable.ttf"),
    include_bytes!("../assets/fonts/GeistMono-Variable.ttf"),
    include_bytes!("../assets/fonts/GeistMono-Italic-Variable.ttf"),
];

pub struct Fonts {
    pub sans: SharedString,
    pub mono: SharedString,
}

impl Fonts {
    pub fn load(cx: &App) -> Self {
        let kit = KitTheme::global(cx);
        let text_system = cx.text_system();
        if let Err(error) = register(text_system) {
            eprintln!("Could not register bundled desktop fonts: {error:#}");
        }
        let families = text_system.all_font_names();
        let family = |name, fallback: &SharedString| {
            if families.iter().any(|family| family == name) {
                SharedString::new_static(name)
            } else {
                fallback.clone()
            }
        };
        Self { sans: family(SANS, &kit.font_family), mono: family(MONO, &kit.mono_font_family) }
    }
}

fn register(text_system: &TextSystem) -> Result<()> {
    text_system.add_fonts(BUNDLED.iter().copied().map(Cow::Borrowed).collect())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use gpui_kit::{font, px, FontStyle, FontWeight};

    use super::*;

    #[test]
    fn windows_text_system_resolves_bundled_geist_faces() {
        // GPUI 0.3.12 uses NoopTextSystem in Windows headless mode.
        let application = gpui_kit::application();
        let text = application.text_system();
        register(&text).expect("DirectWrite registers the bundled fonts");
        let families = text.all_font_names();
        for family in [SANS, MONO] {
            assert!(families.iter().any(|name| name == family));
            for (weight, style) in [
                (FontWeight::NORMAL, FontStyle::Normal),
                (FontWeight::MEDIUM, FontStyle::Normal),
                (FontWeight::SEMIBOLD, FontStyle::Normal),
                (FontWeight::NORMAL, FontStyle::Italic),
            ] {
                let mut request = font(family);
                request.weight = weight;
                request.style = style;
                let id = text.resolve_font(&request);
                assert_eq!(text.get_font_for_id(id), Some(request));
                let width = |ch| text.advance(id, px(16.), ch).unwrap().width;
                if family == SANS {
                    assert!(width('W') > width('i'));
                } else {
                    assert_eq!(width('W'), width('i'));
                }
            }
        }
    }
}
