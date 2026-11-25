//! Bot avatars for the native apps. Without a pack every bot shows the built-in face; with a
//! local avatar pack in the person's appearance folder (see `README.md`), bots are drawn as
//! the pack's shapes: still at rest, turning toward the pointer over their row, and moving
//! while they work. Packs are never bundled with the app.

mod blink;
#[cfg(feature = "local-engine")]
mod engine;
pub mod face;
mod face_motion;
mod frames;
pub mod mark;
mod mark_bodies;
mod mark_pumpkin;
mod mark_shapes;
mod motion;
mod pack;
#[cfg(feature = "local-engine")]
mod trace;

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use gpui_kit::*;

pub use blink::conversation_blink;
pub use face_motion::{Face, FaceTiming};
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
    owner: EntityId,
    bounds: Bounds<Pixels>,
    reach: f32,
    rate: f32,
    /// The engine's own mark, when a local avatar engine draws it.
    #[cfg(feature = "local-engine")]
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
    watched_faces: HashMap<SharedString, face_motion::WatchedFace>,
    blinks: HashMap<WindowId, WeakEntity<blink::ConversationBlink>>,
    face_work_pending: HashSet<WindowId>,
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
    #[cfg(feature = "local-engine")]
    pulse: Pulse,
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
            watched_faces: HashMap::new(),
            blinks: HashMap::new(),
            face_work_pending: HashSet::new(),
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
            #[cfg(feature = "local-engine")]
            pulse: Pulse::default(),
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
    let chosen = engine.look(bot.id, pack.engine_name(bot.name), bot.color, (shape.as_deref(), color.as_deref()))?;
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
    if let Some(face) = avatars.watched_faces.get(key) {
        let (bounds, state) = (face.bounds, face.state.upgrade());
        return state.is_some_and(|state| {
            state.update(cx, |state, _| state.follow(bounds, position));
            true
        });
    }
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
    if let Some(state) = watched_face(key, cx) {
        return state.update(cx, |state, _| state.rest());
    }
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
    if cfg!(target_os = "windows") && !window.is_window_hovered() {
        if rest(key, cx) {
            window.on_next_frame(|window, _| window.refresh());
        }
        pulse_for_input(window, cx);
    }
}

/// A packed mark's gaze belongs to the frame state of its visible element.
fn mark_watch_owner(key: &SharedString, window: &mut Window, cx: &mut App) -> EntityId {
    window
        .use_keyed_state("packed-avatar-watch", cx, |_, cx| {
            let key = key.clone();
            let owner = cx.entity_id();
            cx.on_release(move |_, cx| {
                let owns_watch = cx
                    .try_global::<Avatars>()
                    .and_then(|avatars| avatars.watched.get(&key))
                    .is_some_and(|watched| watched.owner == owner);
                if owns_watch {
                    let avatars = cx.global_mut::<Avatars>();
                    let watch = avatars.watched.remove(&key);
                    avatars.gazes.remove(&key);
                    #[cfg(feature = "local-engine")]
                    if avatars.held.remove(&key) {
                        if let (Some(engine), Some(live)) = (avatars.live(), watch.and_then(|watch| watch.live)) {
                            engine.release(live);
                        }
                    }
                    #[cfg(not(feature = "local-engine"))]
                    let _ = watch;
                }
            })
            .detach();
        })
        .entity_id()
}

/// Pointer input for marks the engine draws waits for the next pulse rather than redrawing.
fn pulse_for_input(window: &mut Window, cx: &mut App) {
    #[cfg(feature = "local-engine")]
    if cx.try_global::<Avatars>().and_then(Avatars::live).is_some_and(|engine| engine.animating()) {
        start_pulse(window, cx);
    }
    #[cfg(not(feature = "local-engine"))]
    let _ = (window, cx);
}

fn watched_face(key: &SharedString, cx: &App) -> Option<Entity<face_motion::FaceMotion>> {
    cx.try_global::<Avatars>()?.watched_faces.get(key)?.state.upgrade()
}

fn press_face(key: &SharedString, down: bool, cx: &mut App) -> bool {
    watched_face(key, cx).is_some_and(|state| state.update(cx, |state, _| state.press(down)))
}

/// Applies the avatar reaction to the row, tile or pill that contains it.
pub fn watch_region(region: Stateful<Div>, key: SharedString) -> Stateful<Div> {
    let (down, up, up_out) = (key.clone(), key.clone(), key.clone());
    gaze_region(region, key)
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            let changed = if let Some(state) = watched_face(&down, cx) {
                state.update(cx, |state, _| state.press(true))
            } else {
                rest(&down, cx)
            };
            if changed {
                window.refresh();
            }
            pulse_for_input(window, cx);
        })
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            if press_face(&up, false, cx) {
                window.refresh();
            }
        })
        .on_mouse_up_out(MouseButton::Left, move |_, window, cx| {
            if press_face(&up_out, false, cx) {
                window.refresh();
            }
        })
}

/// A gaze region without a press gesture, for the empty conversation's background.
pub fn gaze_region(region: Stateful<Div>, key: SharedString) -> Stateful<Div> {
    let leaving = key.clone();
    region
        .on_mouse_move(move |event: &MouseMoveEvent, window, cx| {
            if follow(&key, event.position, cx) {
                window.refresh();
            }
            pulse_for_input(window, cx);
        })
        .on_hover(move |hovered, window, cx| {
            if !hovered && rest(&leaving, cx) {
                window.refresh();
            }
            pulse_for_input(window, cx);
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
                            if bounds.intersects(&window.content_mask().bounds)
                                && cx.try_global::<Avatars>().is_some_and(Avatars::has_pack)
                            {
                                let watched = Watched {
                                    owner: mark_watch_owner(&key, window, cx),
                                    bounds,
                                    reach: side / 2.,
                                    rate,
                                    #[cfg(feature = "local-engine")]
                                    live: None,
                                };
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
            traced: None,
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
            let drawn = engine.image(key);
            let image = drawn.as_ref().map(|(image, _)| image.clone()).or_else(|| mark.shown.clone());
            let replaced = match (&mark.shown, &image) {
                (Some(shown), Some(image)) if !Arc::ptr_eq(shown, image) => mark.shown.replace(image.clone()),
                (None, Some(image)) => mark.shown.replace(image.clone()),
                _ => None,
            };
            if trace::on()
                && (replaced.is_some()
                    || mark.shown.is_some() && drawn.is_some() && mark.traced != drawn.as_ref().map(|d| d.1))
            {
                if let Some((_, at)) = &drawn {
                    trace::event("show", format_args!("{:.3} {key} {:.3}", trace::ms(Instant::now()), trace::ms(*at)));
                    mark.traced = Some(*at);
                }
            }
            (image, replaced)
        });
        if let Some(replaced) = replaced {
            cx.drop_image(replaced, Some(window));
        }
        if engine.animating() {
            start_pulse(window, cx);
        }
        let slot = match self.watch.clone() {
            Some(watch) => slot.child(
                canvas(
                    move |bounds, window, cx| {
                        if bounds.intersects(&window.content_mask().bounds) {
                            let owner = mark_watch_owner(&watch, window, cx);
                            let watched = Watched { owner, bounds, reach: side / 2., rate: 0., live: Some(key) };
                            cx.global_mut::<Avatars>().watched.insert(watch.clone(), watched);
                            release_outside_window(&watch, window, cx);
                        }
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

/// How often live marks draw. On faster displays marks draw on every second, third, ... display
/// frame, whichever comes closest to the rate, so they still move evenly.
#[cfg(feature = "local-engine")]
#[derive(Clone, Copy, Debug, PartialEq)]
enum Rate {
    /// Work and everything else: 60 a second, the rate the engines' own animation loops run at.
    Steady,
    /// While the pointer turns a mark, and until it has turned back: up to 120 a second, so on a
    /// 144 Hz display every frame.
    Interacting,
}

#[cfg(feature = "local-engine")]
impl Rate {
    fn target_ms(self) -> f32 {
        match self {
            Rate::Steady => 1000. / 60.,
            Rate::Interacting => 1000. / 120.,
        }
    }
}

/// How long after the last pointer input a turn still counts as interaction: a mark turning back
/// to rest settles within about 0.8 s.
#[cfg(feature = "local-engine")]
const INTERACTION_LINGER: Duration = Duration::from_millis(1000);

#[cfg(feature = "local-engine")]
fn pulse_rate(reduced_motion: bool, last_input: Option<Instant>, now: Instant) -> Rate {
    match last_input {
        Some(at) if !reduced_motion && now.saturating_duration_since(at) < INTERACTION_LINGER => Rate::Interacting,
        _ => Rate::Steady,
    }
}

/// The display pulse that drives live marks: one per app, running only while marks move.
#[cfg(feature = "local-engine")]
#[derive(Default)]
struct Pulse {
    running: bool,
    last: Option<Instant>,
    /// The display's frame interval, learnt from the pulse itself.
    interval_ms: Option<f32>,
    since_frame: u32,
}

#[cfg(feature = "local-engine")]
impl Pulse {
    /// Called once per display frame; whether this one should draw marks.
    fn beat(&mut self, now: Instant, rate: Rate) -> bool {
        if let Some(last) = self.last.replace(now) {
            let measured = (now.saturating_duration_since(last).as_secs_f32() * 1000.).clamp(1., 50.);
            self.interval_ms = Some(match self.interval_ms {
                Some(interval) if (measured - interval).abs() < interval * 0.5 => interval * 0.9 + measured * 0.1,
                Some(interval) => interval,
                None => measured,
            });
        }
        let every = self.interval_ms.map_or(1, |interval| (rate.target_ms() / interval).round().max(1.) as u32);
        self.since_frame += 1;
        if self.since_frame >= every {
            self.since_frame = 0;
            true
        } else {
            false
        }
    }
}

#[cfg(feature = "local-engine")]
fn start_pulse(window: &mut Window, cx: &mut App) {
    let pulse = &mut cx.global_mut::<Avatars>().pulse;
    if !pulse.running {
        *pulse = Pulse { running: true, ..Pulse::default() };
        window.on_next_frame(pulse_frame);
    }
}

/// Runs at the start of each display frame while marks move: on its frames it asks the engine for
/// this moment and redraws, so marks show the latest frame drawn; then it waits for the next.
#[cfg(feature = "local-engine")]
fn pulse_frame(window: &mut Window, cx: &mut App) {
    let now = Instant::now();
    let Some(engine) = cx.try_global::<Avatars>().and_then(|avatars| avatars.live()).cloned() else {
        cx.global_mut::<Avatars>().pulse.running = false;
        return;
    };
    let rate = pulse_rate(cx.reduce_motion(), engine.last_input(), now);
    let avatars = cx.global_mut::<Avatars>();
    if avatars.pulse.beat(now, rate) {
        engine.frame(now);
        window.refresh();
    }
    if engine.animating() {
        window.on_next_frame(pulse_frame);
    } else {
        avatars.pulse.running = false;
        window.refresh();
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
    traced: Option<Instant>,
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

#[cfg(all(test, feature = "local-engine"))]
mod pulse_tests {
    use super::{pulse_rate, Pulse, Rate};
    use std::time::{Duration, Instant};

    /// Which of `count` display frames, `interval_us` apart, draw marks.
    fn beats_at(interval_us: u64, count: u32, rate: Rate) -> Vec<u32> {
        let mut pulse = Pulse::default();
        let start = Instant::now();
        (0..count).filter(|n| pulse.beat(start + Duration::from_micros(interval_us * *n as u64), rate)).collect()
    }

    fn beats(interval_us: u64, count: u32) -> Vec<u32> {
        beats_at(interval_us, count, Rate::Steady)
    }

    /// The steady spacing, in display frames, once the pulse has learnt the display.
    fn spacing(interval_us: u64, rate: Rate) -> u32 {
        let beats = beats_at(interval_us, 200, rate);
        let gaps: Vec<u32> = beats.windows(2).skip(4).map(|pair| pair[1] - pair[0]).collect();
        assert!(gaps.windows(2).all(|pair| pair[0] == pair[1]), "{interval_us} us: uneven {gaps:?}");
        gaps[0]
    }

    #[test]
    fn interaction_draws_up_to_120_a_second_and_every_frame_at_144() {
        assert_eq!(spacing(2_778, Rate::Interacting), 3);
        assert_eq!(spacing(4_167, Rate::Interacting), 2);
        assert_eq!(spacing(6_944, Rate::Interacting), 1);
        assert_eq!(spacing(8_333, Rate::Interacting), 1);
        assert_eq!(spacing(16_683, Rate::Interacting), 1);
        assert_eq!(spacing(2_778, Rate::Steady), 6);
        assert_eq!(spacing(6_944, Rate::Steady), 2);
        assert_eq!(spacing(8_333, Rate::Steady), 2);
    }

    #[test]
    fn interaction_lasts_until_the_turn_back_settles_and_never_under_reduced_motion() {
        let now = Instant::now() + Duration::from_secs(10);
        let ago = |ms| Some(now - Duration::from_millis(ms));
        assert_eq!(pulse_rate(false, ago(0), now), Rate::Interacting);
        assert_eq!(pulse_rate(false, ago(900), now), Rate::Interacting);
        assert_eq!(pulse_rate(false, ago(1100), now), Rate::Steady);
        assert_eq!(pulse_rate(false, None, now), Rate::Steady);
        assert_eq!(pulse_rate(true, ago(0), now), Rate::Steady);
    }

    /// A pinned mark at work on a 360 Hz and a 144 Hz display: the pointer moves over it for 2 s
    /// and leaves; marks draw at the interaction rate until the turn back settles, then at 60.
    #[test]
    fn interaction_then_work_benchmark() {
        for (hz, interacting, steady) in [(360., 120., 60.), (144., 144., 72.), (60., 60., 60.)] {
            let interval = Duration::from_secs_f64(1. / hz);
            let start = Instant::now() + Duration::from_secs(10);
            let last_input = start + Duration::from_secs(2);
            let mut pulse = Pulse::default();
            let (mut during, mut after) = (Vec::new(), Vec::new());
            for n in 0..(hz as u32 * 6) {
                let now = start + interval * n;
                let input = (now <= last_input).then_some(now).unwrap_or(last_input);
                let rate = pulse_rate(false, Some(input), now);
                if pulse.beat(now, rate) {
                    let t = (now - start).as_secs_f64();
                    if (0.5..2.9).contains(&t) {
                        during.push(t);
                    } else if (3.5..6.).contains(&t) {
                        after.push(t);
                    }
                }
            }
            let rate = |frames: &[f64]| (frames.len() - 1) as f64 / (frames[frames.len() - 1] - frames[0]);
            assert!((rate(&during) - interacting).abs() < 1., "{hz} Hz interacting {}", rate(&during));
            assert!((rate(&after) - steady).abs() < 1., "{hz} Hz steady {}", rate(&after));
            println!(
                "{hz} Hz: {:.1} frames/s while interacting, {:.1} frames/s at work after",
                rate(&during),
                rate(&after)
            );
        }
    }

    #[test]
    fn marks_draw_on_every_display_frame_up_to_sixty_a_second() {
        assert_eq!(beats(16_683, 6), vec![0, 1, 2, 3, 4, 5]);
        assert_eq!(beats(16_667, 4), vec![0, 1, 2, 3]);
    }

    #[test]
    fn faster_displays_draw_marks_on_evenly_spaced_frames() {
        let at_120 = beats(8_333, 41);
        assert!(at_120.windows(2).skip(2).all(|pair| pair[1] - pair[0] == 2), "{at_120:?}");
        let at_144 = beats(6_944, 41);
        assert!(at_144.windows(2).skip(2).all(|pair| pair[1] - pair[0] == 2), "{at_144:?}");
        let at_360 = beats(2_778, 61);
        assert!(at_360.windows(2).skip(2).all(|pair| pair[1] - pair[0] == 6), "{at_360:?}");
    }

    #[test]
    fn a_stall_does_not_change_the_display_rate_it_learnt() {
        let mut pulse = Pulse::default();
        let start = Instant::now();
        for n in 0..20u64 {
            pulse.beat(start + Duration::from_micros(2_778 * n), Rate::Steady);
        }
        pulse.beat(start + Duration::from_millis(400), Rate::Steady);
        assert!((pulse.interval_ms.unwrap() - 2.778).abs() < 0.05);
    }
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
