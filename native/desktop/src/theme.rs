use gpui_kit::component::{Theme as KitTheme, ThemeMode};
use gpui_kit::{
    hsla, point, px, rgb, rgba, App, BoxShadow, Global, Hsla, Pixels, SharedString,
    WindowAppearance,
};

use crate::fonts::Fonts;

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

/// Semantic colours. Views read these and never write a colour of their own.
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
    pub identity: [Hsla; 10],
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
                app: rgb(0x121212).into(),
                panel: rgb(0x0e0e0e).into(),
                raised: rgb(0x202020).into(),
                raised_hover: rgb(0x2c2c2c).into(),
                card: rgb(0x1f1f1f).into(),
                composer: rgb(0x1f1f1f).into(),
                menu: rgb(0x1f1f1f).into(),
                inset: rgb(0x1b1b1b).into(),
                control: rgb(0x282828).into(),
                hairline: rgb(0x383838).into(),
                edge: rgba(0xf5f5f50f).into(),
                ink: rgb(0xf5f5f5).into(),
                ink_secondary: rgba(0xf5f5f5a8).into(),
                ink_tertiary: rgba(0xf5f5f591).into(),
                accent: rgb(0x1084fe).into(),
                accent_text: rgb(0x7fc0ff).into(),
                focus: rgb(0x459ffe).into(),
                bubble_user: rgb(0x5a5a5a).into(),
                bubble_user_ink: rgb(0xf5f5f5).into(),
                success: rgb(0x38d591).into(),
                danger: rgb(0xff5667).into(),
                danger_ink: rgb(0xffffff).into(),
                warning: rgb(0xff9800).into(),
                scrim: hsla(0., 0., 0., 0.55),
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
                ],
                font,
                mono,
            },
            Skin::Daylight => Self {
                skin,
                app: rgb(0xfcfcfc).into(),
                panel: rgb(0xf5f5f5).into(),
                raised: rgb(0xe4e4e4).into(),
                raised_hover: rgb(0xd8d8d8).into(),
                card: rgb(0xefefef).into(),
                composer: rgb(0xffffff).into(),
                menu: rgb(0xffffff).into(),
                inset: rgb(0xe9e9e9).into(),
                control: rgb(0xe3e3e3).into(),
                hairline: rgba(0x1c1c1c3d).into(),
                edge: rgba(0x1c1c1c1f).into(),
                ink: rgb(0x1c1c1c).into(),
                ink_secondary: rgba(0x1c1c1cad).into(),
                ink_tertiary: rgba(0x1c1c1ca6).into(),
                accent: rgb(0x126fd4).into(),
                accent_text: rgb(0x0b69cc).into(),
                focus: rgb(0x0b6dd3).into(),
                bubble_user: rgb(0x1c1c1c).into(),
                bubble_user_ink: rgb(0xfcfcfc).into(),
                success: rgb(0x007a44).into(),
                danger: rgb(0xcd2834).into(),
                danger_ink: rgb(0xffffff).into(),
                warning: rgb(0x9c5b00).into(),
                scrim: hsla(0., 0., 0., 0.32),
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
        Hsla {
            a: opacity,
            ..self.ink
        }
    }

    /// The elevated control fill under the pointer: the composer tone with 7% ink.
    pub fn elevated_hover(&self) -> Hsla {
        mix(self.composer, self.ink, 0.07)
    }

    /// The colour a bot keeps everywhere it appears, chosen by its identity key.
    pub fn identity_for(&self, key: &str) -> Hsla {
        let named = match key {
            "green" => Some(0),
            "blue" => Some(1),
            "red" => Some(2),
            "orange" => Some(3),
            "purple" => Some(4),
            "cyan" => Some(5),
            "pink" => Some(6),
            "yellow" => Some(7),
            "teal" => Some(8),
            "coral" => Some(9),
            _ => None,
        };
        let index = named.unwrap_or_else(|| {
            key.bytes()
                .fold(0usize, |hash, byte| hash.wrapping_mul(31).wrapping_add(byte as usize))
                % self.identity.len()
        });
        self.identity[index]
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
        KitTheme::change(
            if self.is_dark() {
                ThemeMode::Dark
            } else {
                ThemeMode::Light
            },
            None,
            cx,
        );
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
            kit.selection = Hsla {
                a: 0.35,
                ..self.accent
            };
            kit.popover = self.menu;
            kit.popover_foreground = self.ink;
            kit.link = self.accent_text;
            kit.link_hover = self.accent_text;
            kit.link_active = self.accent_text;
            kit.title_bar = self.panel;
            kit.title_bar_border = self.panel;
            kit.scrollbar = Hsla {
                a: 0.,
                ..self.panel
            };
            kit.scrollbar_thumb = self.ink_at(0.18);
            kit.scrollbar_thumb_hover = self.ink_at(0.3);
        });
        cx.set_global(self);
    }
}

pub fn mix(base: Hsla, over: Hsla, amount: f32) -> Hsla {
    let (base, over) = (base.to_rgb(), over.to_rgb());
    let blend = |from: f32, to: f32| from + (to - from) * amount;
    gpui_kit::Rgba {
        r: blend(base.r, over.r),
        g: blend(base.g, over.g),
        b: blend(base.b, over.b),
        a: base.a,
    }
    .into()
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

/// The sidebar with the line where it meets the chat. The window keeps a 1px frame of its own
/// on Windows 11, which puts that line 354px from the edge the person sees.
pub const SIDEBAR_WIDTH: Pixels = px(354.);
pub const CAPTION_WIDTH: Pixels = px(138.);
pub const CAPTION_HEIGHT: Pixels = px(52.);
pub const CHAT_COLUMN: Pixels = px(960.);
pub const BUBBLE_MAX: Pixels = px(560.);
