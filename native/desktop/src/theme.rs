use gpui_kit::component::{Theme as KitTheme, ThemeMode};
use gpui_kit::{hsla, point, px, rgb, rgba, App, BoxShadow, Global, Hsla, Pixels, SharedString, WindowAppearance};

#[cfg(target_os = "macos")]
use gpui_kit::Point;

use crate::fonts::Fonts;
use crate::theme_tokens::{DARK, LIGHT};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Skin {
    Midnight,
    Daylight,
}

impl Skin {
    pub fn named(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "midnight" | "dark" => Some(Self::Midnight),
            "daylight" | "light" => Some(Self::Daylight),
            _ => None,
        }
    }

    pub fn for_appearance(appearance: WindowAppearance) -> Self {
        match appearance {
            WindowAppearance::Light | WindowAppearance::VibrantLight => Self::Daylight,
            WindowAppearance::Dark | WindowAppearance::VibrantDark => Self::Midnight,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Identity {
    Green,
    Blue,
    Red,
    Orange,
    Purple,
    Cyan,
    Pink,
    Yellow,
    Teal,
    Coral,
    Bronze,
    Slate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BotColor {
    pub name: &'static str,
    pub hex: &'static str,
    previous_hex: Option<&'static str>,
    identity: Option<Identity>,
}

impl BotColor {
    const fn new(name: &'static str, hex: &'static str, previous_hex: &'static str, identity: Identity) -> Self {
        Self { name, hex, previous_hex: Some(previous_hex), identity: Some(identity) }
    }

    pub fn from_value(value: &str) -> Option<&'static Self> {
        let color = avatar_shape(value).map_or(value, |(color, _)| color);
        let color = color.strip_prefix('#').unwrap_or(color);
        let matches = |hex: &str| color.eq_ignore_ascii_case(&hex[1..]);
        BOT_COLORS.iter().find(|entry| matches(entry.hex) || entry.previous_hex.is_some_and(matches))
    }

    pub fn avatar_value(self, current: &str) -> String {
        match avatar_shape(current) {
            Some((_, shape)) => format!("{}::shape_{shape}", self.hex),
            None => self.hex.to_owned(),
        }
    }
}

/// The wire palette from packages/contracts/src/bots/bot-avatar.ts, in picker order.
pub const BOT_COLORS: [BotColor; 11] = [
    BotColor { name: "Staff White", hex: "#FFFFFF", previous_hex: None, identity: None },
    BotColor::new("Executive Violet", "#A97EFE", "#8B5CF6", Identity::Purple),
    BotColor::new("Emerald", "#00C972", "#10B981", Identity::Green),
    BotColor::new("Forge Orange", "#FF781C", "#F97316", Identity::Orange),
    BotColor::new("Cyber Cyan", "#1CC3B0", "#06B6D4", Identity::Teal),
    BotColor::new("Cobalt Blue", "#2A92FE", "#3B82F6", Identity::Blue),
    BotColor::new("Amber Gold", "#FFAF38", "#EAB308", Identity::Yellow),
    BotColor::new("Caramel Bronze", "#A27952", "#8D6E63", Identity::Bronze),
    BotColor::new("Crimson Red", "#FF3E51", "#EF4444", Identity::Red),
    BotColor::new("Neon Pink", "#FF5EB1", "#EC4899", Identity::Pink),
    BotColor::new("Slate Silver", "#94A3B8", "#64748B", Identity::Slate),
];

fn avatar_shape(value: &str) -> Option<(&str, &str)> {
    value
        .split_once("::shape_")
        .filter(|(_, shape)| !shape.is_empty() && shape.bytes().all(|byte| byte.is_ascii_digit()))
}

const HASH_PALETTE_LEN: usize = Identity::Coral as usize + 1;

/// Semantic colours, from the same palettes as the web app (`theme_tokens.rs`, generated from
/// packages/ui-tokens). Views read these and never write a colour of their own.
#[derive(Clone)]
pub struct Theme {
    pub skin: Skin,
    pub app: Hsla,
    pub panel: Hsla,
    pub raised: Hsla,
    pub raised_hover: Hsla,
    pub card: Hsla,
    pub composer: Hsla,
    pub menu: Hsla,
    pub inset: Hsla,
    pub control: Hsla,
    pub hairline: Hsla,
    pub edge: Hsla,
    pub ink: Hsla,
    pub ink_secondary: Hsla,
    pub ink_tertiary: Hsla,
    pub accent: Hsla,
    pub accent_text: Hsla,
    pub focus: Hsla,
    pub bubble_user: Hsla,
    pub bubble_user_ink: Hsla,
    pub success: Hsla,
    pub danger: Hsla,
    pub danger_ink: Hsla,
    pub warning: Hsla,
    pub scrim: Hsla,
    identity: [Hsla; Identity::Slate as usize + 1],
    pub font: SharedString,
    pub mono: SharedString,
}

impl Global for Theme {}

impl Theme {
    pub fn of(skin: Skin, fonts: &Fonts) -> Self {
        let font = fonts.sans.clone();
        let mono = fonts.mono.clone();
        match skin {
            Skin::Midnight => Self {
                skin,
                app: rgba(DARK.background).into(),
                panel: rgba(DARK.sidebar).into(),
                raised: rgba(DARK.sidebar_accent).into(),
                raised_hover: rgba(DARK.accent).into(),
                card: rgba(DARK.chat_agent).into(),
                composer: rgba(DARK.elevated).into(),
                menu: rgba(DARK.popover).into(),
                inset: rgba(DARK.muted).into(),
                control: rgba(DARK.secondary).into(),
                hairline: rgba(DARK.border).into(),
                edge: rgba(DARK.sidebar_border).into(),
                ink: rgba(DARK.foreground).into(),
                ink_secondary: rgba(DARK.muted_foreground).into(),
                ink_tertiary: rgba(DARK.faint_foreground).into(),
                accent: rgba(DARK.accent_fill).into(),
                accent_text: rgba(DARK.link).into(),
                focus: rgba(DARK.ring).into(),
                bubble_user: rgba(DARK.chat_user).into(),
                bubble_user_ink: rgba(DARK.chat_user_foreground).into(),
                success: rgba(DARK.success).into(),
                danger: rgba(DARK.destructive).into(),
                danger_ink: rgba(DARK.destructive_foreground).into(),
                warning: rgba(DARK.warning).into(),
                scrim: rgba(DARK.overlay).into(),
                identity: [
                    rgb(0x009957).into(),
                    rgb(0x377fe6).into(),
                    rgb(0xd94b52).into(),
                    rgb(0xe78531).into(),
                    rgb(0x8d69ce).into(),
                    rgb(0x0ea5c6).into(),
                    rgb(0xd84f8b).into(),
                    rgb(0xd8a729).into(),
                    rgb(0x01a492).into(),
                    rgb(0xe5634e).into(),
                    rgb(0xa8805a).into(),
                    rgb(0x8a94a6).into(),
                ],
                font,
                mono,
            },
            Skin::Daylight => Self {
                skin,
                app: rgba(LIGHT.background).into(),
                panel: rgba(LIGHT.sidebar).into(),
                raised: rgba(LIGHT.sidebar_accent).into(),
                raised_hover: rgba(LIGHT.accent).into(),
                card: rgba(LIGHT.chat_agent).into(),
                composer: rgba(LIGHT.elevated).into(),
                menu: rgba(LIGHT.popover).into(),
                inset: rgba(LIGHT.muted).into(),
                control: rgba(LIGHT.secondary).into(),
                hairline: rgba(LIGHT.border).into(),
                edge: rgba(LIGHT.sidebar_border).into(),
                ink: rgba(LIGHT.foreground).into(),
                ink_secondary: rgba(LIGHT.muted_foreground).into(),
                ink_tertiary: rgba(LIGHT.faint_foreground).into(),
                accent: rgba(LIGHT.accent_fill).into(),
                accent_text: rgba(LIGHT.link).into(),
                focus: rgba(LIGHT.ring).into(),
                bubble_user: rgba(LIGHT.chat_user).into(),
                bubble_user_ink: rgba(LIGHT.chat_user_foreground).into(),
                success: rgba(LIGHT.success).into(),
                danger: rgba(LIGHT.destructive).into(),
                danger_ink: rgba(LIGHT.destructive_foreground).into(),
                warning: rgba(LIGHT.warning).into(),
                scrim: rgba(LIGHT.overlay).into(),
                identity: [
                    rgb(0x007f48).into(),
                    rgb(0x1b6adc).into(),
                    rgb(0xd12c34).into(),
                    rgb(0xa95914).into(),
                    rgb(0x8057c8).into(),
                    rgb(0x0a7891).into(),
                    rgb(0xca2d72).into(),
                    rgb(0x896a19).into(),
                    rgb(0x017c6f).into(),
                    rgb(0xcd361e).into(),
                    rgb(0x8a6440).into(),
                    rgb(0x5f6b7d).into(),
                ],
                font,
                mono,
            },
        }
    }

    pub fn is_dark(&self) -> bool {
        self.skin == Skin::Midnight
    }

    /// Ink at a low opacity: the hover and pressed fill that works on every surface.
    pub fn ink_at(&self, opacity: f32) -> Hsla {
        Hsla { a: opacity, ..self.ink }
    }

    /// The elevated control fill under the pointer: the composer tone with 7% ink.
    pub fn elevated_hover(&self) -> Hsla {
        mix(self.composer, self.ink, 0.07)
    }

    /// The skin's identity colour for a stored avatar value or a local identity key.
    pub fn identity_for(&self, key: &str) -> Hsla {
        self.identity_paint(key).0
    }

    /// The identity fill and the ink to draw on top of it.
    pub fn identity_paint(&self, key: &str) -> (Hsla, Hsla) {
        if let Some(color) = BotColor::from_value(key) {
            return match color.identity {
                Some(identity) => (self.identity[identity as usize], gpui_kit::white()),
                None => (self.ink, self.app),
            };
        }
        let named = match key {
            "green" => Some(Identity::Green),
            "blue" => Some(Identity::Blue),
            "red" => Some(Identity::Red),
            "orange" => Some(Identity::Orange),
            "purple" => Some(Identity::Purple),
            "cyan" => Some(Identity::Cyan),
            "pink" => Some(Identity::Pink),
            "yellow" => Some(Identity::Yellow),
            "teal" => Some(Identity::Teal),
            "coral" => Some(Identity::Coral),
            _ => None,
        };
        let index = named.map(|identity| identity as usize).unwrap_or_else(|| {
            key.bytes().fold(0usize, |hash, byte| hash.wrapping_mul(31).wrapping_add(byte as usize)) % HASH_PALETTE_LEN
        });
        (self.identity[index], gpui_kit::white())
    }

    pub fn float_shadow(&self) -> Vec<BoxShadow> {
        let strength = if self.is_dark() { 0.5 } else { 0.12 };
        vec![
            BoxShadow {
                color: hsla(0., 0., 0., strength),
                offset: point(px(0.), px(12.)),
                blur_radius: px(32.),
                spread_radius: px(-4.),
                inset: false,
            },
            BoxShadow {
                color: hsla(0., 0., 0., strength * 0.5),
                offset: point(px(0.), px(2.)),
                blur_radius: px(6.),
                spread_radius: px(-1.),
                inset: false,
            },
        ]
    }

    /// Makes the component library's own controls (text fields, scrollbars) wear this skin.
    pub fn install(self, cx: &mut App) {
        KitTheme::change(if self.is_dark() { ThemeMode::Dark } else { ThemeMode::Light }, None, cx);
        KitTheme::update(cx, |kit| {
            kit.font_family = self.font.clone();
            kit.mono_font_family = self.mono.clone();
            kit.font_size = px(16.);
            kit.background = self.app;
            kit.foreground = self.ink;
            kit.muted_foreground = self.ink_tertiary;
            kit.border = self.hairline;
            kit.input = self.hairline;
            kit.ring = self.focus;
            kit.caret = self.ink;
            kit.selection = Hsla { a: 0.35, ..self.accent };
            kit.popover = self.menu;
            kit.popover_foreground = self.ink;
            kit.link = self.accent_text;
            kit.link_hover = self.accent_text;
            kit.link_active = self.accent_text;
            kit.title_bar = self.panel;
            kit.title_bar_border = self.panel;
            kit.scrollbar = Hsla { a: 0., ..self.panel };
            kit.scrollbar_thumb = self.ink_at(0.18);
            kit.scrollbar_thumb_hover = self.ink_at(0.3);
        });
        cx.set_global(self);
    }
}

pub fn mix(base: Hsla, over: Hsla, amount: f32) -> Hsla {
    let (base, over) = (base.to_rgb(), over.to_rgb());
    let blend = |from: f32, to: f32| from + (to - from) * amount;
    gpui_kit::Rgba { r: blend(base.r, over.r), g: blend(base.g, over.g), b: blend(base.b, over.b), a: base.a }.into()
}

pub trait ActiveTheme {
    fn skin(&self) -> &Theme;
}

impl ActiveTheme for App {
    fn skin(&self) -> &Theme {
        self.global::<Theme>()
    }
}

/// The radius scale: pick the step for the element's job, never a value of your own.
pub mod radius {
    use super::{px, Pixels};

    pub const MENU_ROW: Pixels = px(6.);
    pub const FIELD: Pixels = px(8.);
    pub const CARD: Pixels = px(12.);
    pub const DIALOG: Pixels = px(14.);
    pub const BUBBLE: Pixels = px(18.);
    pub const BUBBLE_JOINED: Pixels = px(6.);
    pub const COMPOSER: Pixels = px(22.);
}

/// The sidebar with the line where it meets the chat, as wide as the web roster.
pub const SIDEBAR_WIDTH: Pixels = px(280.);
pub const CAPTION_WIDTH: Pixels = px(138.);

/// Top-left of the macOS close button, in window coordinates.
#[cfg(target_os = "macos")]
pub const TRAFFIC_LIGHTS: Point<Pixels> = point(px(18.), px(19.));

/// Horizontal space for the macOS window buttons and their trailing clearance.
#[cfg(target_os = "macos")]
pub const TRAFFIC_LIGHTS_RESERVE: Pixels = px(84.);
pub const CAPTION_HEIGHT: Pixels = px(52.);
pub const CHAT_COLUMN: Pixels = px(960.);
pub const BUBBLE_MAX: Pixels = px(560.);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_avatar_colors_follow_the_skin_palette() {
        let fonts = Fonts { sans: "Inter Variable".into(), mono: "Geist Mono".into() };
        let midnight = Theme::of(Skin::Midnight, &fonts);
        let daylight = Theme::of(Skin::Daylight, &fonts);
        let cases: [(&[&str], u32, u32); 11] = [
            (&["#FFFFFF"], 0xf5f5f5, 0x1c1c1c),
            (&["#A97EFE", "#8B5CF6"], 0x8d69ce, 0x8057c8),
            (&["#00C972", "#10B981"], 0x009957, 0x007f48),
            (&["#FF781C", "#F97316"], 0xe78531, 0xa95914),
            (&["#1CC3B0", "#06B6D4"], 0x01a492, 0x017c6f),
            (&["#2A92FE", "#3B82F6"], 0x377fe6, 0x1b6adc),
            (&["#FFAF38", "#EAB308"], 0xd8a729, 0x896a19),
            (&["#A27952", "#8D6E63"], 0xa8805a, 0x8a6440),
            (&["#FF3E51", "#EF4444"], 0xd94b52, 0xd12c34),
            (&["#FF5EB1", "#EC4899"], 0xd84f8b, 0xca2d72),
            (&["#94A3B8", "#64748B"], 0x8a94a6, 0x5f6b7d),
        ];
        for (values, dark, light) in cases {
            for value in values {
                for form in [
                    value.to_string(),
                    value.to_ascii_lowercase(),
                    value[1..].to_string(),
                    value[1..].to_ascii_lowercase(),
                ] {
                    for key in [form.clone(), format!("{form}::shape_3")] {
                        for (theme, expected) in [(&midnight, dark), (&daylight, light)] {
                            let eyes = if *value == "#FFFFFF" { theme.app } else { gpui_kit::white() };
                            assert_eq!(theme.identity_paint(&key), (rgb(expected).into(), eyes), "{key}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn named_colors_and_the_original_hash_palette_still_work() {
        let fonts = Fonts { sans: "Inter Variable".into(), mono: "Geist Mono".into() };
        let theme = Theme::of(Skin::Midnight, &fonts);
        assert_eq!(theme.identity_for("green"), rgb(0x009957).into());
        assert_eq!(theme.identity_for("cyan"), rgb(0x0ea5c6).into());
        assert_eq!(theme.identity_for("coral"), rgb(0xe5634e).into());
        assert_eq!(theme.identity_for("xyz"), rgb(0xe78531).into());
        for key in ["#123456", "#123456::shape_3", "#A97EFE::shape_no", ""] {
            let old_hash = key.bytes().fold(0usize, |hash, byte| hash.wrapping_mul(31).wrapping_add(byte as usize));
            assert_eq!(theme.identity_for(key), theme.identity[old_hash % 10], "{key}");
        }
    }
}
