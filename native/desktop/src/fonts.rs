use std::borrow::Cow;
use std::path::{Component, Path};

use gpui_kit::component::Theme as KitTheme;
use gpui_kit::{App, Result, SharedString, TextSystem};
use serde::Deserialize;

const SANS: &str = "Inter";
const MONO: &str = "Geist Mono";
const BUNDLED: &[&[u8]] = &[
    include_bytes!("../assets/fonts/InterVariable.ttf"),
    include_bytes!("../assets/fonts/InterVariable-Italic.ttf"),
    include_bytes!("../assets/fonts/GeistMono-Variable.ttf"),
    include_bytes!("../assets/fonts/GeistMono-Italic-Variable.ttf"),
];

pub struct Fonts {
    pub sans: SharedString,
    pub mono: SharedString,
}

/// `typography.json` in the appearance folder. For each role, the OpenType file that provides it
/// (relative to that folder) and the family names it may go by, best first: DirectWrite and
/// CoreText name the faces of one variable font differently, so the first name this computer
/// knows is used. Either role may be left out.
#[derive(Deserialize, Default)]
struct Typography {
    sans: Option<Face>,
    mono: Option<Face>,
}

#[derive(Deserialize)]
struct Face {
    families: Vec<String>,
    file: String,
}

impl Fonts {
    pub fn load(cx: &App) -> Self {
        let kit = KitTheme::global(cx);
        let text_system = cx.text_system();
        let pack = crate::appearance::folder().map(|folder| read_pack(&folder)).unwrap_or_default();
        if let Err(error) = register(text_system, pack.files) {
            eprintln!("Could not register desktop fonts: {error:#}");
        }
        let families = text_system.all_font_names();
        let available = |name: &str| families.iter().any(|family| family == name);
        let pick = |chosen: Vec<String>, bundled: &'static str, fallback: &SharedString| match chosen
            .iter()
            .find(|family| available(family))
        {
            Some(family) => SharedString::from(family.clone()),
            None => {
                if !chosen.is_empty() {
                    eprintln!("None of the appearance pack's font families {chosen:?} loaded; using {bundled}.");
                }
                if available(bundled) {
                    SharedString::new_static(bundled)
                } else {
                    fallback.clone()
                }
            }
        };
        Self { sans: pick(pack.sans, SANS, &kit.font_family), mono: pick(pack.mono, MONO, &kit.mono_font_family) }
    }
}

#[derive(Default)]
struct Pack {
    sans: Vec<String>,
    mono: Vec<String>,
    files: Vec<Vec<u8>>,
}

fn read_pack(folder: &Path) -> Pack {
    let Ok(text) = std::fs::read_to_string(folder.join("typography.json")) else {
        return Pack::default();
    };
    let typography: Typography = match serde_json::from_str(&text) {
        Ok(typography) => typography,
        Err(error) => {
            eprintln!("Ignoring the appearance pack's typography.json: {error}");
            return Pack::default();
        }
    };
    let mut pack = Pack::default();
    for (face, role) in [(typography.sans, &mut pack.sans), (typography.mono, &mut pack.mono)] {
        let Some(face) = face else { continue };
        match read_face(folder, &face.file) {
            Ok(bytes) => {
                pack.files.push(bytes);
                *role = face.families;
            }
            Err(error) => eprintln!("Ignoring the appearance pack's font {}: {error}", face.file),
        }
    }
    pack
}

fn read_face(folder: &Path, file: &str) -> std::result::Result<Vec<u8>, String> {
    let relative = Path::new(file);
    if !relative.components().all(|part| matches!(part, Component::Normal(_))) {
        return Err("the path must stay inside the appearance folder".into());
    }
    let bytes = std::fs::read(folder.join(relative)).map_err(|error| error.to_string())?;
    match bytes.get(..4) {
        Some([0, 1, 0, 0] | b"OTTO" | b"true") => Ok(bytes),
        _ => Err("only TrueType and OpenType files load; convert WOFF and WOFF2 first".into()),
    }
}

fn register(text_system: &TextSystem, pack: Vec<Vec<u8>>) -> Result<()> {
    let bundled = BUNDLED.iter().copied().map(Cow::Borrowed);
    text_system.add_fonts(bundled.chain(pack.into_iter().map(Cow::Owned)).collect())
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
        register(&text, Vec::new()).expect("DirectWrite registers the bundled fonts");
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

    #[test]
    fn pack_files_must_be_opentype_inside_the_folder() {
        let folder = std::env::temp_dir().join(format!("superbot-fonts-test-{}", std::process::id()));
        std::fs::create_dir_all(folder.join("fonts")).unwrap();
        std::fs::write(folder.join("fonts").join("web.woff2"), b"wOF2rest").unwrap();
        std::fs::write(folder.join("fonts").join("ok.ttf"), [0u8, 1, 0, 0, 9]).unwrap();
        assert!(read_face(&folder, "fonts/web.woff2").is_err());
        assert!(read_face(&folder, "../outside.ttf").is_err());
        assert!(read_face(&folder, "fonts/ok.ttf").is_ok());
        std::fs::write(
            folder.join("typography.json"),
            r#"{"sans":{"families":["Pack Sans Text","Pack Sans"],"file":"fonts/ok.ttf"},"mono":{"families":["Pack Mono"],"file":"fonts/web.woff2"}}"#,
        )
        .unwrap();
        let pack = read_pack(&folder);
        assert_eq!(pack.sans, ["Pack Sans Text", "Pack Sans"]);
        assert!(pack.mono.is_empty());
        assert_eq!(pack.files.len(), 1);
        std::fs::remove_dir_all(folder).unwrap();
    }

    /// Run with `SUPERBOT_APPEARANCE` naming a real pack, or none for this computer's own:
    /// `cargo test -p superbot-desktop fonts::tests::local_pack -- --ignored --nocapture`.
    #[test]
    #[ignore = "needs a private appearance pack"]
    fn local_pack_resolves_its_own_families() {
        let folder = crate::appearance::folder().expect("an appearance folder");
        let pack = read_pack(&folder);
        let application = gpui_kit::application();
        let text = application.text_system();
        register(&text, pack.files).unwrap();
        let families = text.all_font_names();
        for chosen in [pack.sans, pack.mono] {
            let family = chosen.iter().find(|name| families.contains(name));
            let family = family.unwrap_or_else(|| panic!("none of {chosen:?} is among {families:?}"));
            for weight in [FontWeight::NORMAL, FontWeight::MEDIUM, FontWeight::SEMIBOLD] {
                let mut request = font(family.clone());
                request.weight = weight;
                let id = text.resolve_font(&request);
                let at = |size: f32, words: &str| -> f32 {
                    words.chars().map(|ch| f32::from(text.advance(id, px(size), ch).unwrap().width)).sum()
                };
                println!(
                    "{family} {}: cap {:.3} x {:.3} ascent {:.3} descent {:.3} at 13px; advances \"Fixture agent\" 13px {:.3}, \"The fixture heard you.\" 15px {:.3}",
                    weight.0,
                    f32::from(text.cap_height(id, px(13.))),
                    f32::from(text.x_height(id, px(13.))),
                    f32::from(text.ascent(id, px(13.))),
                    f32::from(text.descent(id, px(13.))),
                    at(13., "Fixture agent"),
                    at(15., "The fixture heard you."),
                );
            }
        }
    }
}
