//! Visual proof sheet for the built-in sphere. Run with `daylight` for the light skin.
//! Pass `failed` as the second argument to inspect the failure pose offline.

use gpui_kit::*;
use superbot_avatars::face::{face, pose, FacePaint, FaceState, Pose};

// Reference body colours from the desktop design. The application supplies its own theme.
const PALETTE: [(&str, u32, u32); 13] = [
    ("Green", 0x009957, 0x007f48),
    ("Blue", 0x377fe6, 0x1b6adc),
    ("Red", 0xd94b52, 0xd12c34),
    ("Orange", 0xe78531, 0xa95914),
    ("Purple", 0x8d69ce, 0x8057c8),
    ("Cyan", 0x0ea5c6, 0x0a7891),
    ("Pink", 0xd84f8b, 0xca2d72),
    ("Yellow", 0xd8a729, 0x896a19),
    ("Teal", 0x01a492, 0x017c6f),
    ("Coral", 0xe5634e, 0xcd361e),
    ("Bronze", 0xa8805a, 0x8a6440),
    ("Slate", 0x8a94a6, 0x5f6b7d),
    ("Staff White", 0xf5f5f5, 0x1c1c1c),
];
const DIAMETERS: [f32; 20] =
    [14.96, 16., 17.68, 18., 20., 22., 24., 26., 28., 28.56, 32., 36., 40., 42., 43.52, 44., 48., 56., 60., 64.];

struct Sheet {
    dark: bool,
    pose: Pose,
}

impl Render for Sheet {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let (surface, app, ink) =
            if self.dark { (0x0e0e0e, 0x121212, 0xf5f5f5) } else { (0xf5f5f5, 0xfcfcfc, 0x1c1c1c) };
        let cell = || div().size(px(72.)).flex().items_center().justify_center();
        div()
            .size_full()
            .bg(rgb(surface))
            .text_color(rgb(ink))
            .text_size(px(13.))
            .px_4()
            .child(
                div()
                    .h(px(35.))
                    .flex()
                    .items_center()
                    .child(div().w(px(96.)).child(if self.dark { "Midnight" } else { "Daylight" }))
                    .children(DIAMETERS.map(|d| cell().h_full().child(d.to_string()))),
            )
            .children(PALETTE.map(|(name, dark, light)| {
                let paint = FacePaint {
                    body: rgb(if self.dark { dark } else { light }).into(),
                    eyes: if name == "Staff White" { rgb(app).into() } else { white() },
                    dark: self.dark,
                    shape: superbot_avatars::mark::Shape::Circle,
                };
                div()
                    .flex()
                    .items_center()
                    .child(div().w(px(96.)).child(name))
                    .children(DIAMETERS.map(|d| cell().child(face(px(d), paint, self.pose))))
            }))
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let dark = args.next().as_deref() != Some("daylight");
    let pose = if args.next().as_deref() == Some("failed") {
        pose(FaceState::Failed, ((0., 0.), 0.), 0., 1., 0., 0)
    } else {
        Pose::default()
    };
    gpui_kit::application().run(move |cx| {
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1570.), px(980.)), cx))),
            titlebar: Some(TitlebarOptions { title: Some("Superbot Faces".into()), ..Default::default() }),
            ..Default::default()
        };
        cx.open_window(options, |_, cx| cx.new(|_| Sheet { dark, pose })).expect("open face proof sheet");
        cx.activate(true);
    });
}
