// Icons are Lucide (ISC); the licence is assets/icons/LICENSE-LUCIDE.

use gpui_kit::component::Icon;
use gpui_kit::{px, Hsla, Styled as _};

macro_rules! glyphs {
    ($($name:ident => $file:literal,)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub(crate) enum Glyph {
            $($name,)*
        }

        impl Glyph {
            fn svg(self) -> &'static [u8] {
                match self {
                    $(Self::$name => include_bytes!(concat!("../assets/icons/", $file, ".svg")),)*
                }
            }
        }
    };
}

glyphs! {
    Activity => "activity",
    Archive => "archive",
    ArchiveRestore => "archive-restore",
    Bot => "bot",
    CalendarClock => "calendar-clock",
    Check => "check",
    ChevronLeft => "chevron-left",
    ChevronRight => "chevron-right",
    CircleAlert => "circle-alert",
    Copy => "copy",
    Cpu => "cpu",
    Download => "download",
    ExternalLink => "external-link",
    File => "file",
    Files => "files",
    Kanban => "kanban",
    KeyRound => "key-round",
    Link => "link",
    LogOut => "log-out",
    Mail => "mail",
    MessageSquare => "message-square",
    Pin => "pin",
    Play => "play",
    Plus => "plus",
    RefreshCw => "refresh-cw",
    Server => "server",
    ShieldCheck => "shield-check",
    Square => "square",
    Trash => "trash",
    Upload => "upload",
    UserMinus => "user-minus",
    UserPlus => "user-plus",
    Users => "users",
    UsersRound => "users-round",
    X => "x",
}

pub(crate) fn icon(glyph: Glyph, size: f32, color: Hsla) -> Icon {
    Icon::default()
        .data(glyph.svg())
        .size(px(size))
        .text_color(color)
}
