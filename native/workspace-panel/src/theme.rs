//! Colour, type and shape tokens from `superbot-site/DESKTOP-DESIGN.md` §3.

use gpui_kit::component::ActiveTheme as _;
use gpui_kit::{px, rgba, App, Global, Hsla, Pixels};

/// The two skins of the desktop design.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Skin {
    Midnight,
    Daylight,
}

/// The colour tokens the panel draws with. Field names are the token names in
/// `DESKTOP-DESIGN.md` §3.1.
#[derive(Clone, Copy, Debug)]
pub struct Tokens {
    pub skin: Skin,
    pub app: Hsla,
    pub panel: Hsla,
    pub raised: Hsla,
    pub raised_hover: Hsla,
    pub card: Hsla,
    pub inset: Hsla,
    pub control: Hsla,
    pub menu: Hsla,
    pub hairline: Hsla,
    pub edge: Hsla,
    pub ink: Hsla,
    pub ink_secondary: Hsla,
    pub ink_tertiary: Hsla,
    pub accent: Hsla,
    pub accent_text: Hsla,
    pub accent_ink: Hsla,
    pub focus: Hsla,
    pub success: Hsla,
    pub warning: Hsla,
    pub danger: Hsla,
    pub danger_ink: Hsla,
}

fn hex(value: u32) -> Hsla {
    rgba(value).into()
}

impl Tokens {
    pub fn midnight() -> Self {
        Self {
            skin: Skin::Midnight,
            app: hex(0x121212ff),
            panel: hex(0x0e0e0eff),
            raised: hex(0x202020ff),
            raised_hover: hex(0x2c2c2cff),
            card: hex(0x1f1f1fff),
            inset: hex(0x1b1b1bff),
            control: hex(0x282828ff),
            menu: hex(0x1f1f1fff),
            hairline: hex(0x383838ff),
            edge: hex(0xf5f5f50f),
            ink: hex(0xf5f5f5ff),
            ink_secondary: hex(0xf5f5f5a8),
            ink_tertiary: hex(0xf5f5f591),
            accent: hex(0x1084feff),
            accent_text: hex(0x7fc0ffff),
            accent_ink: hex(0xffffffff),
            focus: hex(0x459ffeff),
            success: hex(0x38d591ff),
            warning: hex(0xff9800ff),
            danger: hex(0xff5667ff),
            danger_ink: hex(0xffffffff),
        }
    }

    pub fn daylight() -> Self {
        Self {
            skin: Skin::Daylight,
            app: hex(0xfcfcfcff),
            panel: hex(0xf5f5f5ff),
            raised: hex(0xe4e4e4ff),
            raised_hover: hex(0xd8d8d8ff),
            card: hex(0xefefefff),
            inset: hex(0xe9e9e9ff),
            control: hex(0xe3e3e3ff),
            menu: hex(0xffffffff),
            hairline: hex(0x1c1c1c3d),
            edge: hex(0x1c1c1c1f),
            ink: hex(0x1c1c1cff),
            ink_secondary: hex(0x1c1c1cad),
            ink_tertiary: hex(0x1c1c1ca6),
            accent: hex(0x126fd4ff),
            accent_text: hex(0x0b69ccff),
            accent_ink: hex(0xffffffff),
            focus: hex(0x0b6dd3ff),
            success: hex(0x007a44ff),
            warning: hex(0x9c5b00ff),
            danger: hex(0xcd2834ff),
            danger_ink: hex(0xffffffff),
        }
    }

    pub fn for_skin(skin: Skin) -> Self {
        match skin {
            Skin::Midnight => Self::midnight(),
            Skin::Daylight => Self::daylight(),
        }
    }

    /// `ink` at 6% alpha: the hover fill on every surface.
    pub fn hover(&self) -> Hsla {
        self.ink.alpha(0.06)
    }

    /// `ink` at 8% alpha: the pressed fill on every surface.
    pub fn pressed(&self) -> Hsla {
        self.ink.alpha(0.08)
    }

    pub fn is_dark(&self) -> bool {
        self.skin == Skin::Midnight
    }

    /// The colour a bot keeps everywhere it appears, chosen by its identity
    /// key: one of the ten palette names (`DESKTOP-DESIGN.md` §3.2), else a
    /// stable entry derived from the key. `native/desktop` resolves the same
    /// key to the same entry, so a bot looks alike in the sidebar and here.
    pub fn identity_for(&self, key: &str) -> Hsla {
        let palette = match self.skin {
            Skin::Midnight => &IDENTITY_MIDNIGHT,
            Skin::Daylight => &IDENTITY_DAYLIGHT,
        };
        let named = IDENTITY_NAMES.iter().position(|name| *name == key);
        let index = named.unwrap_or_else(|| {
            key.bytes().fold(0usize, |hash, byte| {
                hash.wrapping_mul(31).wrapping_add(byte as usize)
            }) % palette.len()
        });
        rgba((palette[index] << 8) | 0xff).into()
    }
}

const IDENTITY_NAMES: [&str; 10] = [
    "green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral",
];
const IDENTITY_MIDNIGHT: [u32; 10] = [
    0x009957, 0x377fe6, 0xd94b52, 0xe78531, 0x8d69ce, 0x0ea5c6, 0xd84f8b, 0xd8a729, 0x01a492,
    0xe5634e,
];
const IDENTITY_DAYLIGHT: [u32; 10] = [
    0x007f48, 0x1b6adc, 0xd12c34, 0xa95914, 0x8057c8, 0x0a7891, 0xca2d72, 0x896a19, 0x017c6f,
    0xcd361e,
];

struct SkinOverride(Skin);

impl Global for SkinOverride {}

/// Pins the panel to one skin, or with `None` returns it to following the
/// host's GPUI Kit theme mode.
pub fn set_skin(skin: Option<Skin>, cx: &mut App) {
    match skin {
        Some(skin) => cx.set_global(SkinOverride(skin)),
        None => {
            if cx.has_global::<SkinOverride>() {
                cx.remove_global::<SkinOverride>();
            }
        }
    }
    cx.refresh_windows();
}

/// The tokens for the current skin: the override from [`set_skin`], else
/// Midnight when the host's GPUI Kit theme is dark and Daylight otherwise.
pub fn tokens(cx: &App) -> Tokens {
    let skin = match cx.try_global::<SkinOverride>() {
        Some(SkinOverride(skin)) => *skin,
        None if cx.theme().mode.is_dark() => Skin::Midnight,
        None => Skin::Daylight,
    };
    Tokens::for_skin(skin)
}

pub(crate) fn mono_font(cx: &App) -> gpui_kit::SharedString {
    cx.theme().mono_font_family.clone()
}

pub(crate) const RADIUS_MENU_ROW: Pixels = px(6.);
pub(crate) const RADIUS_FIELD: Pixels = px(8.);
pub(crate) const RADIUS_CARD: Pixels = px(12.);
pub(crate) const RADIUS_FULL: Pixels = px(9999.);

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(value: u32) -> Hsla {
        rgba((value << 8) | 0xff).into()
    }

    #[test]
    fn identity_keys_resolve_as_the_desktop_shell_resolves_them() {
        let midnight = Tokens::midnight();
        assert_eq!(midnight.identity_for("yellow"), hex(0xd8a729));
        assert_eq!(midnight.identity_for("cyan"), hex(0x0ea5c6));
        assert_eq!(Tokens::daylight().identity_for("yellow"), hex(0x896a19));
        // Any other key takes the entry at its 31-multiplier hash modulo ten.
        assert_eq!(midnight.identity_for(""), hex(0x009957));
        assert_eq!(midnight.identity_for("b"), hex(0x01a492));
        assert_eq!(
            midnight.identity_for("#FFAF38"),
            midnight.identity_for("#FFAF38")
        );
    }
}
