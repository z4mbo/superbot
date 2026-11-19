//! Bot avatars for the native apps. Without a pack every bot shows the built-in face; with a
//! local avatar pack in the person's appearance folder (see `README.md`), bots are drawn as
//! the pack's shapes: still at rest, turning toward the pointer over their row, and moving
//! while they work. Packs are never bundled with the app.

mod frames;
mod pack;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use gpui_kit::*;

pub use frames::{Frame, Frames, Glance};
pub use pack::{parse_hex, ChatTone, Look, Pack, PackError, PackFile, Paint};

/// A bot as the server describes it.
#[derive(Clone, Copy, Debug)]
pub struct Bot<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub color: &'a str,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Turn {
    Toward { to: usize, serial: u64 },
    Held { at: usize },
    Away { from: usize, serial: u64 },
}

struct Watched {
    bounds: Bounds<Pixels>,
    reach: f32,
    frames: Arc<Frames>,
}

/// The installed pack, if any, and where each watched mark is looking.
#[derive(Default)]
pub struct Avatars {
    pack: Option<Arc<Pack>>,
    shapes: HashMap<String, Arc<OnceLock<Option<Arc<Frames>>>>>,
    turns: HashMap<SharedString, Turn>,
    watched: HashMap<SharedString, Watched>,
    serial: u64,
}

impl Global for Avatars {}

impl Avatars {
    /// Reads `<appearance>/avatars/pack.json`. A missing pack is the normal case; a broken
    /// one is reported and ignored, so bots keep the built-in face.
    pub fn install(appearance: Option<&Path>, cx: &mut App) {
        let pack = appearance.map(|folder| folder.join("avatars")).and_then(|folder| match Pack::read(&folder) {
            Ok(pack) => Some(Arc::new(pack)),
            Err(PackError::Read(_, error)) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                eprintln!("avatar pack ignored: {error}");
                None
            }
        });
        cx.set_global(Avatars::with_pack(pack));
    }

    pub fn with_pack(pack: Option<Arc<Pack>>) -> Avatars {
        let shapes = pack
            .iter()
            .flat_map(|pack| pack.file.shapes.keys())
            .map(|shape| (shape.clone(), Arc::new(OnceLock::new())))
            .collect::<HashMap<_, _>>();
        if let Some(pack) = &pack {
            let pack = pack.clone();
            let shapes = shapes.clone();
            std::thread::Builder::new()
                .name("avatar-pack".into())
                .spawn(move || {
                    for (shape, slot) in &shapes {
                        load(&pack, shape, slot);
                    }
                })
                .ok();
        }
        Avatars { pack, shapes, ..Default::default() }
    }

    pub fn has_pack(&self) -> bool {
        self.pack.is_some()
    }

    fn frames(&self, shape: &str) -> Option<Arc<Frames>> {
        let pack = self.pack.as_ref()?;
        load(pack, shape, self.shapes.get(shape)?)
    }
}

fn load(pack: &Pack, shape: &str, slot: &OnceLock<Option<Arc<Frames>>>) -> Option<Arc<Frames>> {
    slot.get_or_init(|| {
        let path = pack.shape_path(shape)?;
        Frames::read(&path).map(Arc::new).map_err(|error| eprintln!("avatar shape {shape} ignored: {error}")).ok()
    })
    .clone()
}

/// How the pack draws this bot, or `None` to use the built-in face.
pub fn look(bot: Bot, cx: &App) -> Option<Look> {
    let avatars = cx.try_global::<Avatars>()?;
    let look = avatars.pack.as_ref()?.look(bot.id, bot.name, bot.color);
    avatars.frames(&look.shape).map(|_| look)
}

/// This bot's chat colours in the given skin, when the pack recolours chats.
pub fn chat_tone(look: &Look, dark: bool, cx: &App) -> Option<ChatTone> {
    cx.try_global::<Avatars>()?.pack.as_ref()?.tone(&look.hue, dark)
}

/// Turns the watched mark `key` toward the pointer. Returns whether it changed, so the caller
/// knows to redraw.
pub fn follow(key: &SharedString, position: Point<Pixels>, cx: &mut App) -> bool {
    let Some(avatars) = cx.try_global::<Avatars>() else { return false };
    let Some(watched) = avatars.watched.get(key) else { return false };
    let center = watched.bounds.center();
    let x = (f32::from(position.x - center.x) / watched.reach).clamp(-1., 1.);
    let y = (-f32::from(position.y - center.y) / watched.reach).clamp(-1., 1.);
    let to = watched.frames.pose_toward(x, y);
    let next = match avatars.turns.get(key) {
        Some(Turn::Toward { to: now, .. }) | Some(Turn::Held { at: now }) if *now == to => return false,
        Some(Turn::Toward { .. }) | Some(Turn::Held { .. }) => Turn::Held { at: to },
        None | Some(Turn::Away { .. }) => Turn::Toward { to, serial: avatars.serial + 1 },
    };
    let avatars = cx.global_mut::<Avatars>();
    avatars.serial += 1;
    avatars.turns.insert(key.clone(), next);
    true
}

/// Turns the watched mark `key` back to rest. Returns whether it changed.
pub fn rest(key: &SharedString, cx: &mut App) -> bool {
    let Some(avatars) = cx.try_global::<Avatars>() else { return false };
    let from = match avatars.turns.get(key) {
        Some(Turn::Toward { to, .. }) | Some(Turn::Held { at: to }) => *to,
        _ => return false,
    };
    let avatars = cx.global_mut::<Avatars>();
    avatars.serial += 1;
    let serial = avatars.serial;
    avatars.turns.insert(key.clone(), Turn::Away { from, serial });
    true
}

/// Makes `region` (the row, tile or pill around a watched mark) turn the mark toward the pointer
/// while it is over the region, and back to rest when it leaves or presses.
pub fn watch_region(region: Stateful<Div>, key: SharedString) -> Stateful<Div> {
    let (leaving, pressing) = (key.clone(), key.clone());
    region
        .on_mouse_move(move |event: &MouseMoveEvent, window, cx| {
            if follow(&key, event.position, cx) {
                window.refresh();
            }
        })
        .on_hover(move |hovered, window, cx| {
            if !hovered && rest(&leaving, cx) {
                window.refresh();
            }
        })
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            if rest(&pressing, cx) {
                window.refresh();
            }
        })
}

/// One bot's mark in an avatar slot of `size`. The mark is drawn in the pack's larger square,
/// centred on the slot, so it may reach past it.
#[derive(IntoElement)]
pub struct Mark {
    id: ElementId,
    look: Look,
    size: Pixels,
    ink: Hsla,
    working: bool,
    watch: Option<SharedString>,
}

impl Mark {
    /// `ink` is the skin's text colour, for colours the pack draws in it.
    pub fn new(id: impl Into<ElementId>, look: Look, size: Pixels, ink: Hsla) -> Mark {
        Mark { id: id.into(), look, size, ink, working: false, watch: None }
    }

    pub fn working(mut self, working: bool) -> Mark {
        self.working = working;
        self
    }

    /// Lets [`follow`] and [`rest`] turn this mark, under `key`.
    pub fn watch(mut self, key: impl Into<SharedString>) -> Mark {
        self.watch = Some(key.into());
        self
    }
}

impl RenderOnce for Mark {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let slot = div().id(self.id).size(self.size).flex_shrink_0().relative();
        let Some(avatars) = cx.try_global::<Avatars>() else { return slot };
        let (Some(pack), Some(frames)) = (avatars.pack.clone(), avatars.frames(&self.look.shape)) else { return slot };
        let side = pack.mark_box(f32::from(self.size));
        let compact = side < pack.file.compact_below;
        let draw =
            Drawing { paint: self.look.paint.clone(), ink: self.ink, side, offset: (f32::from(self.size) - side) / 2. };
        let turn = self.watch.as_ref().and_then(|key| avatars.turns.get(key).copied());
        let slot = match &self.watch {
            Some(key) => {
                let key = key.clone();
                let watched_frames = frames.clone();
                slot.child(
                    canvas(
                        move |bounds, _, cx| {
                            if let Some(avatars) = cx.try_global::<Avatars>() {
                                if avatars.has_pack() {
                                    let watched = Watched { bounds, reach: side / 2., frames: watched_frames };
                                    cx.global_mut::<Avatars>().watched.insert(key, watched);
                                }
                            }
                        },
                        |_, _, _, _| {},
                    )
                    .absolute()
                    .size_full(),
                )
            }
            None => slot,
        };
        let fps = frames.fps;
        let phase = self.look.phase;
        let layer = div().absolute().size_full();
        let drawn = if self.working {
            let length = frames.loop_length(compact);
            layer
                .with_animation(
                    "working",
                    Animation::new(length).repeat_synced().with_max_fps(fps),
                    move |layer, progress| layer.child(draw.frame(frames.working_frame(compact, progress, phase))),
                )
                .into_any_element()
        } else {
            match turn {
                Some(Turn::Toward { to, serial }) => {
                    turning(layer, frames, draw, ("toward", serial), move |progress| Glance::Toward { to, progress })
                }
                Some(Turn::Away { from, serial }) => {
                    turning(layer, frames, draw, ("away", serial), move |progress| Glance::Away { from, progress })
                }
                Some(Turn::Held { at }) => {
                    layer.child(draw.frame(frames.glance(Glance::Toward { to: at, progress: 1. }))).into_any_element()
                }
                None => layer.child(draw.frame(frames.glance(Glance::Rest))).into_any_element(),
            }
        };
        slot.child(drawn)
    }
}

fn turning(
    layer: Div,
    frames: Arc<Frames>,
    draw: Drawing,
    id: (&'static str, u64),
    glance: impl Fn(f32) -> Glance + 'static,
) -> AnyElement {
    let length = frames.turn().max(Duration::from_millis(1));
    let fps = frames.fps;
    layer
        .with_animation(
            ElementId::NamedInteger(id.0.into(), id.1),
            Animation::new(length).with_max_fps(fps),
            move |layer, progress| layer.child(draw.frame(frames.glance(glance(progress)))),
        )
        .into_any_element()
}

#[derive(Clone)]
struct Drawing {
    paint: Paint,
    ink: Hsla,
    side: f32,
    offset: f32,
}

impl Drawing {
    fn frame(&self, frame: &Frame) -> AnyElement {
        match &self.paint {
            Paint::Color(color) => self.place(svg().data(frame).text_color(*color)),
            Paint::Ink => self.place(svg().data(frame).text_color(self.ink)),
            Paint::Gradient(stops) => {
                let bytes = gradient_svg(frame, stops, self.side);
                self.place(img(ImageSource::Image(Arc::new(Image::from_bytes(ImageFormat::Svg, bytes)))))
            }
        }
    }

    fn place<E: Styled + IntoElement>(&self, element: E) -> AnyElement {
        element.absolute().left(px(self.offset)).top(px(self.offset)).size(px(self.side)).into_any_element()
    }
}

/// A single-colour frame repainted with a top-to-bottom gradient, sized for its square so the
/// image is rasterised near the size it is shown at.
fn gradient_svg(frame: &Frame, stops: &[Hsla], side: f32) -> Vec<u8> {
    let svg = String::from_utf8_lossy(frame);
    let Some(open_end) = svg.find('>') else { return frame.to_vec() };
    let count = stops.len().max(2) - 1;
    let stops: String = stops
        .iter()
        .enumerate()
        .map(|(index, color)| {
            let rgba = Rgba::from(*color);
            let channel = |value: f32| (value.clamp(0., 1.) * 255.).round() as u8;
            format!(
                r##"<stop offset="{}" stop-color="#{:02x}{:02x}{:02x}"/>"##,
                index as f32 / count as f32,
                channel(rgba.r),
                channel(rgba.g),
                channel(rgba.b)
            )
        })
        .collect();
    let defs =
        format!(r#"<defs><linearGradient id="paint" x1="0" y1="0" x2="0.4" y2="1">{stops}</linearGradient></defs>"#);
    let head = svg[..open_end].replace(r#"width="192" height="192""#, &format!(r#"width="{side}" height="{side}""#));
    let body = recolor_body(&svg[open_end + 1..]);
    format!("{head}>{defs}{body}").into_bytes()
}

/// Every frame draws its body in one fill, the one used outside `<mask>`; masks keep theirs.
fn recolor_body(body: &str) -> String {
    let (before, after) = match body.find("</defs>") {
        Some(end) => body.split_at(end + "</defs>".len()),
        None => ("", body),
    };
    let recolored = match after.find("fill=\"#") {
        Some(start) => {
            let value_end = after[start + 6..].find('"').map(|end| start + 6 + end).unwrap_or(after.len());
            format!("{}fill=\"url(#paint)\"{}", &after[..start], &after[value_end + 1..])
        }
        None => after.to_owned(),
    };
    format!("{before}{recolored}")
}

#[cfg(test)]
mod tests {
    use super::{gradient_svg, parse_hex, recolor_body, Arc, Frame};

    #[test]
    fn a_gradient_repaints_only_the_body_and_sizes_the_image() {
        let frame: Frame = Arc::from(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><defs><mask id="holes"><rect fill="#fff"/><path fill="#000"/></mask></defs><g><use href="#body" fill="#010203" mask="url(#holes)"/></g></svg>"##
                .as_bytes(),
        );
        let stops = [parse_hex("#ffffff").unwrap(), parse_hex("#000000").unwrap()];
        let out = String::from_utf8(gradient_svg(&frame, &stops, 87.)).unwrap();
        assert!(out.contains(r#"width="87" height="87""#));
        assert!(out.contains(r##"<rect fill="#fff"/><path fill="#000"/>"##));
        assert!(out.contains(r##"<use href="#body" fill="url(#paint)" mask="url(#holes)"/>"##));
        assert!(out.contains(r##"<stop offset="1" stop-color="#000000"/>"##));
    }

    #[test]
    fn a_frame_without_masks_is_repainted_too() {
        let body = r##"<path d="M0 0Z" fill="#010203" fill-rule="evenodd"/></svg>"##;
        assert_eq!(recolor_body(body), r##"<path d="M0 0Z" fill="url(#paint)" fill-rule="evenodd"/></svg>"##);
    }
}
