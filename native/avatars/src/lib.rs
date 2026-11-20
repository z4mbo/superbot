//! Bot avatars for the native apps. Without a pack every bot shows the built-in face; with a
//! local avatar pack in the person's appearance folder (see `README.md`), bots are drawn as
//! the pack's shapes: still at rest, turning toward the pointer over their row, and moving
//! while they work. Packs are never bundled with the app.

#[cfg(feature = "local-engine")]
mod engine;
mod frames;
mod motion;
mod pack;

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use gpui_kit::*;

pub use frames::{Frame, Frames};
pub use motion::{Gaze, Work};
pub use pack::{parse_hex, ChatTone, Choices, Look, Pack, PackError, PackFile, Paint, Picked};

/// A bot as the server describes it.
#[derive(Clone, Copy, Debug)]
pub struct Bot<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub color: &'a str,
    pub picked: Picked<'a>,
}

struct Watched {
    bounds: Bounds<Pixels>,
    reach: f32,
    rate: f32,
    /// The engine's own mark, when a local avatar engine draws it.
    live: Option<u64>,
}

/// Gradient marks rasterised for one scale, kept so each frame is drawn the moment it is shown.
type Rasters = Arc<Mutex<HashMap<(u64, u32), Arc<RenderImage>>>>;

/// More gradient rasters than this are dropped together and drawn again as needed.
const RASTER_LIMIT: usize = 1500;

/// The installed pack, if any, and where each watched mark is looking.
pub struct Avatars {
    pack: Option<Arc<Pack>>,
    shapes: HashMap<String, Arc<OnceLock<Option<Arc<Frames>>>>>,
    gazes: HashMap<SharedString, Gaze>,
    watched: HashMap<SharedString, Watched>,
    epoch: Instant,
    rasters: Rasters,
    #[cfg(feature = "local-engine")]
    engine: Option<Arc<engine::Engine>>,
    #[cfg(feature = "local-engine")]
    looks: Mutex<HashMap<(String, String, String, Option<String>, Option<String>), Look>>,
    /// Watched marks the engine is turning toward the pointer.
    #[cfg(feature = "local-engine")]
    held: std::collections::HashSet<SharedString>,
    /// Frames of marks no longer drawn, freed at the next draw.
    #[cfg(feature = "local-engine")]
    orphans: Arc<Mutex<Vec<Arc<RenderImage>>>>,
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
        #[cfg(feature = "local-engine")]
        let engine = start_engine(appearance, pack.is_some(), cx);
        #[cfg_attr(not(feature = "local-engine"), allow(unused_mut))]
        let mut avatars = Avatars::with_pack(pack);
        #[cfg(feature = "local-engine")]
        {
            avatars.engine = engine;
        }
        cx.set_global(avatars);
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
        Avatars {
            pack,
            shapes,
            gazes: HashMap::new(),
            watched: HashMap::new(),
            epoch: Instant::now(),
            rasters: Rasters::default(),
            #[cfg(feature = "local-engine")]
            engine: None,
            #[cfg(feature = "local-engine")]
            looks: Mutex::default(),
            #[cfg(feature = "local-engine")]
            held: Default::default(),
            #[cfg(feature = "local-engine")]
            orphans: Arc::default(),
        }
    }

    #[cfg(feature = "local-engine")]
    fn live(&self) -> Option<&Arc<engine::Engine>> {
        self.engine.as_ref().filter(|engine| engine.running())
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

/// Starts the local avatar engine beside the pack, and redraws the windows whenever it draws.
#[cfg(feature = "local-engine")]
fn start_engine(appearance: Option<&Path>, has_pack: bool, cx: &mut App) -> Option<Arc<engine::Engine>> {
    use futures::StreamExt;
    let avatars = appearance.filter(|_| has_pack)?.join("avatars");
    let (drawn, mut frames) = futures::channel::mpsc::unbounded();
    let engine = engine::Engine::start(&avatars, cx.svg_renderer(), drawn)?;
    cx.spawn(async move |cx| {
        while frames.next().await.is_some() {
            cx.update(|cx| cx.refresh_windows());
        }
    })
    .detach();
    Some(engine)
}

/// How the pack draws this bot, or `None` to use the built-in face.
pub fn look(bot: Bot, cx: &App) -> Option<Look> {
    let avatars = cx.try_global::<Avatars>()?;
    let pack = avatars.pack.as_ref()?;
    #[cfg(feature = "local-engine")]
    if let Some(look) = engine_look(avatars, pack, bot) {
        return Some(look);
    }
    let look = pack.look(bot.id, bot.name, bot.color, bot.picked);
    avatars.frames(&look.shape).map(|_| look)
}

/// The engine's look for a bot, in the pack's colours: a shape or colour the person picked,
/// else the pack's choice for its name, else the engine decides.
#[cfg(feature = "local-engine")]
fn engine_look(avatars: &Avatars, pack: &Pack, bot: Bot) -> Option<Look> {
    let engine = avatars.live()?;
    let named = pack.choice(bot.name);
    let shape = bot.picked.shape.filter(|shape| pack.draws(shape)).map(str::to_owned).or_else(|| named?.shape.clone());
    let color = bot
        .picked
        .color
        .filter(|color| pack.paint(color).is_some())
        .map(str::to_owned)
        .or_else(|| named?.color.clone());
    let key = (bot.id.to_owned(), bot.name.to_owned(), bot.color.to_owned(), shape.clone(), color.clone());
    if let Some(look) = avatars.looks.lock().ok()?.get(&key) {
        return Some(look.clone());
    }
    let chosen = engine.look(bot.id, bot.name, bot.color, (shape.as_deref(), color.as_deref()))?;
    let (paint, hue) = pack.paint(&chosen.color)?;
    let fallback = pack.look(bot.id, bot.name, bot.color, bot.picked);
    let look = Look { shape: chosen.shape, paint, hue, phase: fallback.phase, seed: chosen.seed };
    avatars.looks.lock().ok()?.insert(key, look.clone());
    Some(look)
}

/// What the appearance editor offers, when a pack is installed.
pub fn choices(cx: &App) -> Option<Choices> {
    Some(cx.try_global::<Avatars>()?.pack.as_ref()?.choices())
}

/// Whether this bot occupies the appearance pack's primary tile.
pub fn primary_tile(name: &str, cx: &App) -> bool {
    cx.try_global::<Avatars>().and_then(|avatars| avatars.pack.as_ref()).is_some_and(|pack| pack.primary_tile(name))
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
    #[cfg(feature = "local-engine")]
    if let (Some(live), Some(engine)) = (watched.live, avatars.live()) {
        let (x, y, reach) = (f32::from(center.x), f32::from(center.y), watched.reach);
        engine.pointer(
            live,
            [x - reach, y - reach, reach * 2., reach * 2.],
            [f32::from(position.x), f32::from(position.y)],
        );
        cx.global_mut::<Avatars>().held.insert(key.clone());
        return false;
    }
    let x = (f32::from(position.x - center.x) / watched.reach).clamp(-1., 1.);
    let y = (-f32::from(position.y - center.y) / watched.reach).clamp(-1., 1.);
    let rate = watched.rate;
    let now = Instant::now();
    let gaze = cx.global_mut::<Avatars>().gazes.entry(key.clone()).or_insert_with(|| Gaze::new(rate, now));
    gaze.look(x, y, now);
    true
}

/// Turns the watched mark `key` back to rest. Returns whether it changed.
pub fn rest(key: &SharedString, cx: &mut App) -> bool {
    #[cfg(feature = "local-engine")]
    if let Some(avatars) = cx.try_global::<Avatars>() {
        if let (Some(live), Some(engine)) = (avatars.watched.get(key).and_then(|watched| watched.live), avatars.live())
        {
            let engine = engine.clone();
            if cx.global_mut::<Avatars>().held.remove(key) {
                engine.release(live);
            }
            return false;
        }
    }
    let Some(gaze) = cx.try_global::<Avatars>().and_then(|avatars| avatars.gazes.get(key)) else { return false };
    if !gaze.holding() {
        return false;
    }
    let now = Instant::now();
    if let Some(gaze) = cx.global_mut::<Avatars>().gazes.get_mut(key) {
        gaze.release(now);
    }
    true
}

/// Turns a watched mark back to rest once the pointer has left the window. On Windows,
/// gpui-pre-windows 0.3.12 reports leaving the window only as the window's hover state and never
/// as a mouse exit, so a region the pointer left by the window edge would stay hovered.
fn release_outside_window(key: &SharedString, window: &mut Window, cx: &mut App) {
    if cfg!(target_os = "windows") && !window.is_window_hovered() && rest(key, cx) {
        window.on_next_frame(|window, _| window.refresh());
    }
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
    /// `ink` is the skin's text colour, for colours the pack draws in it unless the pack sets its own.
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
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let slot = div().id(self.id.clone()).size(self.size).flex_shrink_0().relative();
        let Some(avatars) = cx.try_global::<Avatars>() else { return slot };
        let skin_is_dark = self.ink.l > 0.5;
        if let Some(ink) = avatars.pack.as_ref().and_then(|pack| pack.ink(skin_is_dark)) {
            self.ink = ink;
        }
        #[cfg(feature = "local-engine")]
        if let (Some(engine), Some(pack)) = (avatars.live().cloned(), avatars.pack.clone()) {
            return self.render_live(slot, engine, pack, window, cx);
        }
        let (Some(pack), Some(frames)) = (avatars.pack.clone(), avatars.frames(&self.look.shape)) else { return slot };
        let (epoch, rasters) = (avatars.epoch, avatars.rasters.clone());
        let now = Instant::now();
        let side = pack.mark_box(f32::from(self.size));
        let compact = side < pack.file.compact_below;
        let phase = self.look.phase;

        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| Work::shown(self.working));
        let mut work = *state.read(cx);
        if work.working != self.working {
            work.change(self.working, &frames, epoch, phase, now);
            state.update(cx, |state, _| *state = work);
            if let (Some(key), Some(end)) = (&self.watch, work.resting_from(&frames)) {
                if let Some(gaze) = cx.global_mut::<Avatars>().gazes.get_mut(key) {
                    gaze.restart(end);
                }
            }
        }
        let gaze = self.watch.as_ref().and_then(|key| cx.global::<Avatars>().gazes.get(key).copied());

        let overfull = rasters.lock().map(|mut rasters| match rasters.len() > RASTER_LIMIT {
            true => rasters.drain().map(|(_, image)| image).collect(),
            false => Vec::new(),
        });
        for image in overfull.unwrap_or_default() {
            cx.drop_image(image, Some(window));
        }
        let draw = Drawing {
            paint: self.look.paint.clone(),
            ink: self.ink,
            side,
            offset: (f32::from(self.size) - side) / 2.,
            scale: window.scale_factor(),
            renderer: cx.svg_renderer(),
            rasters,
        };
        let slot = match &self.watch {
            Some(key) => {
                let key = key.clone();
                let rate = frames.gaze_rate;
                slot.child(
                    canvas(
                        move |bounds, window, cx| {
                            release_outside_window(&key, window, cx);
                            if cx.try_global::<Avatars>().is_some_and(Avatars::has_pack) {
                                let watched = Watched { bounds, reach: side / 2., rate, live: None };
                                cx.global_mut::<Avatars>().watched.insert(key, watched);
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
        let moving = work.moving(&frames, now) || gaze.is_some_and(|gaze| !gaze.settled(now));
        let pick = move |now: Instant| -> Frame {
            match work.frame(&frames, compact, epoch, phase, now) {
                Some(frame) => frame.clone(),
                None => match gaze {
                    Some(gaze) => gaze.frame(&frames, now).clone(),
                    None => frames.rest().clone(),
                },
            }
        };
        let layer = div().absolute().size_full();
        let drawn = if moving && !cx.reduce_motion() {
            layer
                .with_animation(
                    "motion",
                    Animation::new(Duration::from_secs(1)).repeat().with_max_fps(fps),
                    move |layer, _| layer.child(draw.frame(&pick(Instant::now()))),
                )
                .into_any_element()
        } else {
            let settled = if moving { now + Duration::from_secs(60) } else { now };
            layer.child(draw.frame(&pick(settled))).into_any_element()
        };
        slot.child(drawn)
    }
}

#[cfg(feature = "local-engine")]
impl Mark {
    /// The mark as the local avatar engine draws it, frame by frame on its own thread.
    fn render_live(
        self,
        slot: Stateful<Div>,
        engine: Arc<engine::Engine>,
        pack: Arc<Pack>,
        window: &mut Window,
        cx: &mut App,
    ) -> Stateful<Div> {
        let side = pack.mark_box(f32::from(self.size));
        let offset = (f32::from(self.size) - side) / 2.;
        let style = engine::Style {
            seed: self.look.seed.clone(),
            shape: self.look.shape.clone(),
            side,
            paint: self.look.paint.clone(),
            ink: self.ink,
            scale: window.scale_factor(),
            reduced: cx.reduce_motion(),
        };
        let orphans = cx.global::<Avatars>().orphans.clone();
        for image in orphans.lock().map(|mut orphans| std::mem::take(&mut *orphans)).unwrap_or_default() {
            cx.drop_image(image, Some(window));
        }
        let mark = window.use_keyed_state(self.id.clone(), cx, |_, _| LiveMark {
            key: engine.new_key(),
            engine: engine.clone(),
            orphans,
            style: None,
            working: false,
            shown: None,
        });
        let (key, restyled, rework) = {
            let mark = mark.read(cx);
            (mark.key, mark.style.as_ref() != Some(&style), mark.working != self.working)
        };
        if restyled {
            engine.mount(key, style.clone(), self.working);
        } else if rework {
            engine.update(key, self.working);
        }
        let working = self.working;
        let (image, replaced) = mark.update(cx, |mark, _| {
            mark.style = Some(style);
            mark.working = working;
            let image = engine.image(key).or_else(|| mark.shown.clone());
            let replaced = match (&mark.shown, &image) {
                (Some(shown), Some(image)) if !Arc::ptr_eq(shown, image) => mark.shown.replace(image.clone()),
                (None, Some(image)) => mark.shown.replace(image.clone()),
                _ => None,
            };
            (image, replaced)
        });
        if let Some(replaced) = replaced {
            cx.drop_image(replaced, Some(window));
        }
        let slot = match self.watch.clone() {
            Some(watch) => slot.child(
                canvas(
                    move |bounds, window, cx| {
                        let watched = Watched { bounds, reach: side / 2., rate: 0., live: Some(key) };
                        cx.global_mut::<Avatars>().watched.insert(watch.clone(), watched);
                        release_outside_window(&watch, window, cx);
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            ),
            None => slot,
        };
        match image {
            Some(image) => {
                slot.child(img(ImageSource::Render(image)).absolute().left(px(offset)).top(px(offset)).size(px(side)))
            }
            None => slot,
        }
    }
}

/// One mark the local avatar engine animates, for as long as its element is drawn.
#[cfg(feature = "local-engine")]
struct LiveMark {
    key: u64,
    engine: Arc<engine::Engine>,
    orphans: Arc<Mutex<Vec<Arc<RenderImage>>>>,
    style: Option<engine::Style>,
    working: bool,
    shown: Option<Arc<RenderImage>>,
}

#[cfg(feature = "local-engine")]
impl Drop for LiveMark {
    fn drop(&mut self) {
        self.engine.unmount(self.key);
        if let (Some(shown), Ok(mut orphans)) = (self.shown.take(), self.orphans.lock()) {
            orphans.push(shown);
        }
    }
}

#[derive(Clone)]
struct Drawing {
    paint: Paint,
    ink: Hsla,
    side: f32,
    offset: f32,
    scale: f32,
    renderer: SvgRenderer,
    rasters: Rasters,
}

impl Drawing {
    fn frame(&self, frame: &Frame) -> AnyElement {
        match &self.paint {
            Paint::Color(color) => self.place(svg().data(frame).text_color(*color)),
            Paint::Ink => self.place(svg().data(frame).text_color(self.ink)),
            Paint::Gradient(stops) => match self.raster(frame, stops) {
                Some(image) => self.place(img(ImageSource::Render(image))),
                None => div().into_any_element(),
            },
        }
    }

    /// A gradient frame drawn now rather than through the asset loader, which (gpui-pre 0.3.12)
    /// draws nothing until each new image has decoded in the background.
    fn raster(&self, frame: &Frame, stops: &[Hsla]) -> Option<Arc<RenderImage>> {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        frame.hash(&mut hasher);
        (self.side.to_bits(), stops.len()).hash(&mut hasher);
        let key = (hasher.finish(), self.scale.to_bits());
        if let Some(image) = self.rasters.lock().ok()?.get(&key) {
            return Some(image.clone());
        }
        let bytes = gradient_svg(frame, stops, self.side);
        let image = self.renderer.render_single_frame(&bytes, self.scale).ok()?;
        self.rasters.lock().ok()?.insert(key, image.clone());
        Some(image)
    }

    fn place<E: Styled + IntoElement>(&self, element: E) -> AnyElement {
        element.absolute().left(px(self.offset)).top(px(self.offset)).size(px(self.side)).into_any_element()
    }
}

/// A single-colour frame repainted with a top-to-bottom gradient, sized for its square so the
/// image is rasterised near the size it is shown at.
pub(crate) fn gradient_svg(frame: &[u8], stops: &[Hsla], side: f32) -> Vec<u8> {
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
