use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};

use gpui_kit::{Hsla, Rgba};
use serde::Deserialize;

/// `avatars/pack.json` in the appearance folder. Every path in it is relative to the folder
/// that holds it, so a pack can be copied between computers.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackFile {
    /// Format version; this build reads 1.
    pub version: u32,
    /// The mark is drawn in a square this many times the avatar's size, centred on it.
    #[serde(default = "default_mark_scale")]
    pub mark_scale: f32,
    /// Exact mark squares for particular avatar sizes, overriding `markScale`.
    #[serde(default)]
    pub mark_boxes: HashMap<String, f32>,
    /// Marks drawn in a smaller square than this use the compact working frames.
    #[serde(default = "default_compact_below")]
    pub compact_below: f32,
    /// Colour name to `#rgb`, `#rrggbb` or `#rrggbbaa`.
    pub palette: BTreeMap<String, String>,
    /// A bot colour the server sends, to the palette colour that stands for it.
    #[serde(default)]
    pub aliases: HashMap<String, String>,
    /// Palette colours drawn in the skin's text colour instead of their own.
    #[serde(default)]
    pub ink_colors: Vec<String>,
    /// What `inkColors` are drawn in per skin, when not the skin's text colour.
    #[serde(default)]
    pub ink: Option<SkinInk>,
    /// Colours drawn as a top-to-bottom gradient of these stops.
    #[serde(default)]
    pub gradients: HashMap<String, Vec<String>>,
    /// Colour name to the `tint` hue its chat uses; a colour not listed uses its own name.
    #[serde(default)]
    pub hues: HashMap<String, String>,
    /// The chat colours of each hue, per skin. Without it chats keep the app's own colours.
    #[serde(default)]
    pub tint: Option<Tints>,
    /// Shape name to the frames file that draws it.
    pub shapes: BTreeMap<String, String>,
    /// How a bot the pack does not name is drawn: picked by its id, so it never changes.
    pub fallback: Fallback,
    /// Bot name (any case) to its look; either field may be left out.
    #[serde(default)]
    pub bots: HashMap<String, Choice>,
    /// What the appearance editor offers, in its order. Without it the editor offers every
    /// shape and colour the pack draws.
    #[serde(default)]
    pub picker: Option<PickerFile>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SkinInk {
    pub light: String,
    pub dark: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct PickerFile {
    #[serde(default)]
    pub shapes: Vec<String>,
    #[serde(default)]
    pub colors: Vec<String>,
}

/// A shape and colour a person picked for one bot, by the names packs use. A name this pack
/// does not draw (picked on another computer, or a removed shape) is ignored.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Picked<'a> {
    pub shape: Option<&'a str>,
    pub color: Option<&'a str>,
}

/// The shapes and colours the appearance editor offers, in order.
#[derive(Clone, Debug, PartialEq)]
pub struct Choices {
    pub shapes: Vec<String>,
    pub colors: Vec<(String, Paint)>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Tints {
    pub light: HashMap<String, Tone>,
    pub dark: HashMap<String, Tone>,
}

/// One hue's chat colours.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tone {
    /// The person's own bubbles.
    pub bubble: String,
    /// Text on those bubbles.
    pub ink: String,
    /// The Send button.
    pub fill: String,
    pub hover: String,
    /// Text and glyphs on the Send button.
    pub fill_ink: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Fallback {
    pub shapes: Vec<String>,
    pub colors: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub shape: Option<String>,
    pub color: Option<String>,
    #[serde(default)]
    pub primary_tile: bool,
}

fn default_mark_scale() -> f32 {
    1.55
}

fn default_compact_below() -> f32 {
    48.
}

#[derive(Clone, Debug, PartialEq)]
pub enum Paint {
    Color(Hsla),
    /// The skin's text colour.
    Ink,
    Gradient(Vec<Hsla>),
}

/// How one bot is drawn.
#[derive(Clone, Debug, PartialEq)]
pub struct Look {
    pub shape: String,
    pub paint: Paint,
    pub hue: String,
    /// Where this bot starts in a shared animation loop, from 0 to 1, so bots at work move
    /// out of step with each other.
    pub phase: f32,
    /// What a local avatar engine varies this bot's motion by.
    pub seed: String,
}

#[derive(Debug)]
pub enum PackError {
    Read(PathBuf, std::io::Error),
    Parse(PathBuf, serde_json::Error),
    Invalid(String),
}

impl std::fmt::Display for PackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PackError::Read(path, error) => write!(f, "cannot read {}: {error}", path.display()),
            PackError::Parse(path, error) => write!(f, "cannot parse {}: {error}", path.display()),
            PackError::Invalid(why) => write!(f, "{why}"),
        }
    }
}

/// A checked pack: every colour parsed, every shape file inside the pack folder.
#[derive(Debug)]
pub struct Pack {
    pub folder: PathBuf,
    pub file: PackFile,
    colors: HashMap<String, Paint>,
    bots: HashMap<String, Choice>,
}

impl Pack {
    pub fn read(folder: &Path) -> Result<Pack, PackError> {
        let path = folder.join("pack.json");
        let bytes = std::fs::read(&path).map_err(|error| PackError::Read(path.clone(), error))?;
        let file: PackFile = serde_json::from_slice(&bytes).map_err(|error| PackError::Parse(path, error))?;
        Pack::new(folder.to_path_buf(), file)
    }

    pub fn new(folder: PathBuf, file: PackFile) -> Result<Pack, PackError> {
        if file.version != 1 {
            return Err(PackError::Invalid(format!("pack version {} is not supported", file.version)));
        }
        for (shape, relative) in &file.shapes {
            if !stays_inside(relative) {
                return Err(PackError::Invalid(format!("shape {shape} points outside the pack folder")));
            }
        }
        let mut colors = HashMap::new();
        for (name, hex) in &file.palette {
            let paint = if file.ink_colors.contains(name) { Paint::Ink } else { Paint::Color(parse_hex(hex)?) };
            colors.insert(name.clone(), paint);
        }
        for (name, stops) in &file.gradients {
            let stops = stops.iter().map(|hex| parse_hex(hex)).collect::<Result<Vec<_>, _>>()?;
            if stops.len() < 2 {
                return Err(PackError::Invalid(format!("gradient {name} needs two stops")));
            }
            colors.insert(name.clone(), Paint::Gradient(stops));
        }
        let fallback_shapes: Vec<_> =
            file.fallback.shapes.iter().filter(|shape| file.shapes.contains_key(*shape)).collect();
        let fallback_colors: Vec<_> = file.fallback.colors.iter().filter(|color| colors.contains_key(*color)).collect();
        if fallback_shapes.is_empty() || fallback_colors.is_empty() {
            return Err(PackError::Invalid("the fallback needs a shape and a colour the pack draws".into()));
        }
        if let Some(ink) = &file.ink {
            parse_hex(&ink.light)?;
            parse_hex(&ink.dark)?;
        }
        if let Some(tints) = &file.tint {
            for tone in tints.light.values().chain(tints.dark.values()) {
                for hex in [&tone.bubble, &tone.ink, &tone.fill, &tone.hover, &tone.fill_ink] {
                    parse_hex(hex)?;
                }
            }
        }
        let bots = file.bots.iter().map(|(name, choice)| (fold(name), choice.clone())).collect();
        Ok(Pack { folder, file, colors, bots })
    }

    pub fn shape_path(&self, shape: &str) -> Option<PathBuf> {
        self.file.shapes.get(shape).map(|relative| self.folder.join(relative))
    }

    pub fn primary_tile(&self, name: &str) -> bool {
        self.bots.get(&fold(name)).is_some_and(|choice| choice.primary_tile)
    }

    /// The look of a bot: what a person picked for it, else the pack's own choice for its name,
    /// otherwise its server colour when the pack has it, and a shape and colour picked by its id.
    pub fn look(&self, id: &str, name: &str, color: &str, picked: Picked) -> Look {
        let hash = fnv1a(id.as_bytes());
        let chosen = self.bots.get(&fold(name));
        let fallback = &self.file.fallback;
        let picked_shape = picked.shape.filter(|shape| self.file.shapes.contains_key(*shape)).map(str::to_owned);
        let picked_color = picked.color.filter(|color| self.colors.contains_key(*color)).map(str::to_owned);
        let shape = picked_shape
            .or_else(|| {
                chosen.and_then(|choice| choice.shape.clone()).filter(|shape| self.file.shapes.contains_key(shape))
            })
            .unwrap_or_else(|| {
                let shapes: Vec<_> = fallback.shapes.iter().filter(|s| self.file.shapes.contains_key(*s)).collect();
                shapes[hash as usize % shapes.len()].clone()
            });
        let server = self.file.aliases.get(color).map(String::as_str).unwrap_or(color);
        let color = picked_color
            .or_else(|| chosen.and_then(|choice| choice.color.clone()).filter(|color| self.colors.contains_key(color)))
            .or_else(|| self.colors.contains_key(server).then(|| server.to_owned()))
            .or_else(|| self.nearest(server))
            .unwrap_or_else(|| {
                let colors: Vec<_> = fallback.colors.iter().filter(|c| self.colors.contains_key(*c)).collect();
                colors[(hash >> 8) as usize % colors.len()].clone()
            });
        let hue = self.file.hues.get(&color).cloned().unwrap_or_else(|| color.clone());
        Look {
            shape,
            paint: self.colors[&color].clone(),
            hue,
            phase: (hash >> 16) as f32 / 65536.,
            seed: id.to_owned(),
        }
    }

    /// The pack's own choice for a bot's name (any case, surrounding spaces ignored).
    pub fn choice(&self, name: &str) -> Option<&Choice> {
        self.bots.get(&fold(name))
    }

    /// How the pack paints a colour name, and the chat hue that colour uses.
    pub fn paint(&self, color: &str) -> Option<(Paint, String)> {
        let hue = self.file.hues.get(color).cloned().unwrap_or_else(|| color.to_owned());
        self.colors.get(color).map(|paint| (paint.clone(), hue))
    }

    /// The colour `inkColors` are drawn in for this skin, when the pack sets one.
    pub fn ink(&self, dark: bool) -> Option<Hsla> {
        let ink = self.file.ink.as_ref()?;
        parse_hex(if dark { &ink.dark } else { &ink.light }).ok()
    }

    /// Whether the pack draws a shape of this name.
    pub fn draws(&self, shape: &str) -> bool {
        self.file.shapes.contains_key(shape)
    }

    /// The fallback colour closest to a server colour sent as `#rrggbb`.
    fn nearest(&self, server: &str) -> Option<String> {
        let wanted = Rgba::from(parse_hex(server).ok()?);
        let distance = |color: &Hsla| {
            let color = Rgba::from(*color);
            (color.r - wanted.r).powi(2) + (color.g - wanted.g).powi(2) + (color.b - wanted.b).powi(2)
        };
        self.file
            .fallback
            .colors
            .iter()
            .filter_map(|name| match self.colors.get(name) {
                Some(Paint::Color(color)) => Some((name, distance(color))),
                _ => None,
            })
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(name, _)| name.clone())
    }

    /// What the appearance editor offers: the pack's `picker` order, keeping only names it
    /// draws, or every shape and colour it draws in name order.
    pub fn choices(&self) -> Choices {
        let picker = self.file.picker.clone().unwrap_or_default();
        let mut shapes: Vec<String> =
            picker.shapes.into_iter().filter(|shape| self.file.shapes.contains_key(shape)).collect();
        if shapes.is_empty() {
            shapes = self.file.shapes.keys().cloned().collect();
        }
        let mut names: Vec<String> =
            picker.colors.into_iter().filter(|color| self.colors.contains_key(color)).collect();
        if names.is_empty() {
            names = self.colors.keys().cloned().collect();
            names.sort();
        }
        let mut seen = std::collections::HashSet::new();
        shapes.retain(|shape| seen.insert(shape.clone()));
        seen.clear();
        names.retain(|color| seen.insert(color.clone()));
        let colors = names.into_iter().map(|name| (name.clone(), self.colors[&name].clone())).collect();
        Choices { shapes, colors }
    }

    pub fn tone(&self, hue: &str, dark: bool) -> Option<ChatTone> {
        let tints = self.file.tint.as_ref()?;
        let tone = if dark { tints.dark.get(hue) } else { tints.light.get(hue) }?;
        let hex = |hex: &str| parse_hex(hex).expect("checked when the pack was read");
        Some(ChatTone {
            bubble: hex(&tone.bubble),
            bubble_ink: hex(&tone.ink),
            fill: hex(&tone.fill),
            fill_hover: hex(&tone.hover),
            fill_ink: hex(&tone.fill_ink),
        })
    }

    /// The side of the square the mark is drawn in, for an avatar of `size` pixels.
    pub fn mark_box(&self, size: f32) -> f32 {
        let key = format!("{}", size.round() as i64);
        self.file.mark_boxes.get(&key).copied().unwrap_or_else(|| (size * self.file.mark_scale).round())
    }
}

/// A chat recoloured for its bot.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChatTone {
    pub bubble: Hsla,
    pub bubble_ink: Hsla,
    pub fill: Hsla,
    pub fill_hover: Hsla,
    pub fill_ink: Hsla,
}

fn fold(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Security invariant: a pack names files only inside its own folder.
fn stays_inside(relative: &str) -> bool {
    let path = Path::new(relative);
    !relative.is_empty() && path.components().all(|component| matches!(component, Component::Normal(_)))
}

pub(crate) fn fnv1a(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c9dc5u32, |hash, byte| (hash ^ *byte as u32).wrapping_mul(0x01000193))
}

pub fn parse_hex(hex: &str) -> Result<Hsla, PackError> {
    let invalid = || PackError::Invalid(format!("{hex} is not a colour"));
    let digits = hex.strip_prefix('#').ok_or_else(invalid)?;
    let expanded: String = match digits.len() {
        3 | 4 => digits.chars().flat_map(|c| [c, c]).collect(),
        6 | 8 => digits.to_owned(),
        _ => return Err(invalid()),
    };
    let value = u32::from_str_radix(&expanded, 16).map_err(|_| invalid())?;
    let rgba = if expanded.len() == 6 { (value << 8) | 0xff } else { value };
    Ok(Hsla::from(Rgba {
        r: ((rgba >> 24) & 0xff) as f32 / 255.,
        g: ((rgba >> 16) & 0xff) as f32 / 255.,
        b: ((rgba >> 8) & 0xff) as f32 / 255.,
        a: (rgba & 0xff) as f32 / 255.,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pack(extra: serde_json::Value) -> Result<Pack, PackError> {
        let mut file = json!({
            "version": 1,
            "palette": { "ink": "#000", "lime": "#00ff00", "plum": "#8e4585" },
            "inkColors": ["ink"],
            "gradients": { "steel": ["#ffffff", "#808080", "#000000"] },
            "aliases": { "green": "lime" },
            "hues": { "ink": "neutral", "steel": "neutral" },
            "shapes": { "round": "shapes/round.json", "drop": "shapes/drop.json" },
            "fallback": { "shapes": ["round", "drop"], "colors": ["lime", "plum"] },
            "bots": { "Captain Example": { "shape": "drop", "color": "steel" }, "only shape": { "shape": "round" } }
        });
        for (key, value) in extra.as_object().unwrap() {
            file[key] = value.clone();
        }
        Pack::new(PathBuf::from("pack"), serde_json::from_value(file).unwrap())
    }

    #[test]
    fn primary_tile_is_an_optional_name_match() {
        let pack = pack(json!({ "bots": { "Guide": { "primaryTile": true }, "Peer": { "color": "lime" } } })).unwrap();
        assert!(pack.primary_tile(" guide "));
        assert!(!pack.primary_tile("Peer"));
        assert!(!pack.primary_tile("Unknown"));
    }

    #[test]
    fn a_named_bot_takes_the_pack_choice_in_any_case_and_spacing() {
        let pack = pack(json!({})).unwrap();
        let look = pack.look("id-1", "  captain EXAMPLE ", "green", Picked::default());
        assert_eq!(look.shape, "drop");
        assert!(matches!(look.paint, Paint::Gradient(ref stops) if stops.len() == 3));
        assert_eq!(look.hue, "neutral");
    }

    #[test]
    fn a_partial_choice_keeps_the_server_colour_through_its_alias() {
        let pack = pack(json!({})).unwrap();
        let look = pack.look("id-2", "Only Shape", "green", Picked::default());
        assert_eq!(look.shape, "round");
        assert_eq!(look.paint, Paint::Color(parse_hex("#00ff00").unwrap()));
        assert_eq!(look.hue, "lime");
    }

    #[test]
    fn an_unknown_bot_is_drawn_the_same_way_every_time_from_its_id() {
        let pack = pack(json!({})).unwrap();
        let first = pack.look("4f1c", "Somebody New", "no-such-colour", Picked::default());
        assert_eq!(first, pack.look("4f1c", "Renamed Later", "no-such-colour", Picked::default()));
        assert!(["round", "drop"].contains(&first.shape.as_str()));
        assert!(matches!(first.paint, Paint::Color(_)));
        let spread: std::collections::HashSet<_> =
            (0..64).map(|n| pack.look(&format!("bot-{n}"), "x", "", Picked::default()).shape).collect();
        assert_eq!(spread.len(), 2);
    }

    #[test]
    fn a_server_colour_sent_as_hex_keeps_its_nearest_pack_colour() {
        let pack = pack(json!({})).unwrap();
        assert_eq!(
            pack.look("a", "New", "#20e020", Picked::default()).paint,
            Paint::Color(parse_hex("#00ff00").unwrap())
        );
        assert_eq!(pack.look("b", "New", "#9a3d8a", Picked::default()).hue, "plum");
    }

    #[test]
    fn ink_colours_follow_the_skin() {
        let pack = pack(json!({ "bots": { "night": { "color": "ink" } } })).unwrap();
        assert_eq!(pack.look("id", "Night", "", Picked::default()).paint, Paint::Ink);
    }

    #[test]
    fn mark_boxes_scale_the_avatar_unless_a_size_is_pinned() {
        let pack = pack(json!({ "markBoxes": { "42": 56 } })).unwrap();
        assert_eq!(pack.mark_box(42.), 56.);
        assert_eq!(pack.mark_box(56.), 87.);
        assert_eq!(pack.mark_box(22.), 34.);
    }

    #[test]
    fn shape_files_must_stay_inside_the_pack() {
        for escape in ["../outside.json", "/etc/shape.json", "C:\\shape.json", ""] {
            let error = pack(json!({ "shapes": { "round": escape, "drop": "shapes/drop.json" } })).unwrap_err();
            assert!(matches!(error, PackError::Invalid(_)), "{escape} was accepted");
        }
    }

    #[test]
    fn a_pack_without_a_drawable_fallback_is_refused() {
        assert!(pack(json!({ "fallback": { "shapes": ["missing"], "colors": ["lime"] } })).is_err());
        assert!(pack(json!({ "fallback": { "shapes": ["round"], "colors": ["missing"] } })).is_err());
    }

    #[test]
    fn tints_are_read_per_skin_with_translucent_colours() {
        let tone =
            json!({ "bubble": "#f5f5f52e", "ink": "#fff", "fill": "#123456", "hover": "#234567", "fillInk": "#000" });
        let pack = pack(json!({ "tint": { "light": { "lime": tone }, "dark": { "lime": tone } } })).unwrap();
        let chat = pack.tone("lime", true).unwrap();
        assert!((chat.bubble.a - 0x2e as f32 / 255.).abs() < 1e-3);
        assert!(pack.tone("plum", false).is_none());
    }

    #[test]
    fn a_picked_look_wins_over_the_pack_choice_and_the_server_colour() {
        let pack = pack(json!({})).unwrap();
        let picked = Picked { shape: Some("round"), color: Some("plum") };
        let look = pack.look("id-1", "Captain Example", "green", picked);
        assert_eq!(look.shape, "round");
        assert_eq!(look.hue, "plum");
        let only_colour = pack.look("id-1", "Captain Example", "green", Picked { shape: None, color: Some("steel") });
        assert_eq!(only_colour.shape, "drop");
        assert!(matches!(only_colour.paint, Paint::Gradient(_)));
    }

    #[test]
    fn a_picked_name_this_pack_does_not_draw_falls_back_as_if_nothing_was_picked() {
        let pack = pack(json!({})).unwrap();
        let unknown = Picked { shape: Some("comet"), color: Some("chartreuse") };
        assert_eq!(
            pack.look("id-9", "Somebody", "green", unknown),
            pack.look("id-9", "Somebody", "green", Picked::default())
        );
    }

    #[test]
    fn the_editor_offers_the_picker_order_and_only_what_the_pack_draws() {
        let pack = pack(json!({ "picker": { "shapes": ["drop", "comet", "round", "drop"], "colors": ["steel", "ink", "nope", "lime"] } })).unwrap();
        let choices = pack.choices();
        assert_eq!(choices.shapes, ["drop", "round"]);
        let names: Vec<&str> = choices.colors.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["steel", "ink", "lime"]);
        assert_eq!(choices.colors[1].1, Paint::Ink);
    }

    #[test]
    fn without_a_picker_the_editor_offers_everything_in_name_order() {
        let choices = pack(json!({})).unwrap().choices();
        assert_eq!(choices.shapes, ["drop", "round"]);
        let names: Vec<&str> = choices.colors.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["ink", "lime", "plum", "steel"]);
    }
    #[test]
    fn ink_colours_take_the_pack_ink_of_each_skin_when_set() {
        assert_eq!(pack(json!({})).unwrap().ink(true), None);
        let pack = pack(json!({ "ink": { "light": "#000", "dark": "#fff" } })).unwrap();
        assert_eq!(pack.ink(true), Some(parse_hex("#ffffff").unwrap()));
        assert_eq!(pack.ink(false), Some(parse_hex("#000000").unwrap()));
        assert!(super::Pack::new(
            PathBuf::from("pack"),
            serde_json::from_value(json!({
                "version": 1, "palette": { "lime": "#0f0" }, "shapes": { "round": "r.json" },
                "fallback": { "shapes": ["round"], "colors": ["lime"] }, "ink": { "light": "#000", "dark": "white" }
            }))
            .unwrap()
        )
        .is_err());
    }

    #[test]
    fn hex_colours_accept_short_and_alpha_forms() {
        assert_eq!(parse_hex("#fff").unwrap(), parse_hex("#ffffff").unwrap());
        assert!(parse_hex("ffffff").is_err());
        assert!(parse_hex("#ggg").is_err());
    }
}
