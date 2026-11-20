use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use futures::channel::mpsc::UnboundedSender;
use gpui_kit::{Hsla, RenderImage, Rgba, SvgRenderer};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{gradient_svg, Paint};

/// The colour every engine frame is drawn in; the host repaints it in the bot's own.
const INK: &str = "#010203";
/// The engine's own frame rate when nothing limits it.
const TICK: Duration = Duration::from_micros(16_667);
/// How long a look may wait for the engine before the pack decides it instead.
const LOOK_WAIT: Duration = Duration::from_millis(500);

#[derive(Deserialize)]
struct Manifest {
    version: u32,
    module: String,
}

/// A bot's look as the engine decides it.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct EngineLook {
    pub seed: String,
    pub shape: String,
    pub color: String,
}

/// How one mark is drawn: what the engine animates, and how its frames are painted.
#[derive(Clone, Debug, PartialEq)]
pub struct Style {
    pub seed: String,
    pub shape: String,
    pub side: f32,
    pub paint: Paint,
    pub ink: Hsla,
    pub scale: f32,
    /// Whether the person asked for reduced motion.
    pub reduced: bool,
}

enum Command {
    Look { bot: Value, chosen: Value, reply: mpsc::SyncSender<Option<EngineLook>> },
    Mount { key: u64, style: Style, working: bool },
    Update { key: u64, working: bool },
    Pointer { key: u64, rect: [f32; 4], point: [f32; 2] },
    Release { key: u64 },
    Unmount { key: u64 },
}

/// A running local avatar engine: one script runtime on its own thread, shared by every mark.
pub struct Engine {
    commands: Mutex<mpsc::Sender<Command>>,
    images: Mutex<HashMap<u64, Arc<RenderImage>>>,
    failed: AtomicBool,
    next_key: AtomicU64,
}

impl Engine {
    /// Starts the engine in `<avatars>/engine` when one is installed there. `drawn` hears whenever
    /// marks have new frames.
    pub fn start(avatars: &Path, renderer: SvgRenderer, drawn: UnboundedSender<()>) -> Option<Arc<Engine>> {
        let folder = avatars.join("engine");
        let manifest = match std::fs::read(folder.join("engine.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(error) => {
                eprintln!("avatar engine ignored: {error}");
                return None;
            }
        };
        let manifest = match serde_json::from_slice::<Manifest>(&manifest) {
            Ok(manifest) if manifest.version == 1 && module_name(&manifest.module).is_some() => manifest,
            Ok(_) => {
                eprintln!("avatar engine ignored: engine.json version 1 naming a module in its folder is required");
                return None;
            }
            Err(error) => {
                eprintln!("avatar engine ignored: {error}");
                return None;
            }
        };
        let (commands, received) = mpsc::channel();
        let engine = Arc::new(Engine {
            commands: Mutex::new(commands),
            images: Mutex::new(HashMap::new()),
            failed: AtomicBool::new(false),
            next_key: AtomicU64::new(1),
        });
        let running = engine.clone();
        std::thread::Builder::new()
            .name("avatar-engine".into())
            .spawn(move || {
                if let Err(why) = run(&folder, &manifest.module, received, &running, &renderer, &drawn) {
                    eprintln!("avatar engine stopped: {why}");
                }
                running.failed.store(true, Ordering::Release);
                let _ = drawn.unbounded_send(());
            })
            .ok()?;
        Some(engine)
    }

    pub fn running(&self) -> bool {
        !self.failed.load(Ordering::Acquire)
    }

    fn send(&self, command: Command) {
        if let Ok(commands) = self.commands.lock() {
            let _ = commands.send(command);
        }
    }

    /// The engine's look for a bot; `chosen` holds a shape or colour the person chose, if any.
    pub fn look(&self, id: &str, name: &str, color: &str, chosen: (Option<&str>, Option<&str>)) -> Option<EngineLook> {
        if !self.running() {
            return None;
        }
        let (reply, answer) = mpsc::sync_channel(1);
        let bot = json!({ "id": id, "name": name, "color": color });
        let chosen = json!({ "shape": chosen.0, "color": chosen.1 });
        self.send(Command::Look { bot, chosen, reply });
        answer.recv_timeout(LOOK_WAIT).ok().flatten()
    }

    pub fn new_key(&self) -> u64 {
        self.next_key.fetch_add(1, Ordering::Relaxed)
    }

    pub fn mount(&self, key: u64, style: Style, working: bool) {
        self.send(Command::Mount { key, style, working });
    }

    pub fn update(&self, key: u64, working: bool) {
        self.send(Command::Update { key, working });
    }

    /// `rect` is the mark's square and `point` the pointer, both in window pixels.
    pub fn pointer(&self, key: u64, rect: [f32; 4], point: [f32; 2]) {
        self.send(Command::Pointer { key, rect, point });
    }

    pub fn release(&self, key: u64) {
        self.send(Command::Release { key });
    }

    pub fn unmount(&self, key: u64) {
        self.send(Command::Unmount { key });
        if let Ok(mut images) = self.images.lock() {
            images.remove(&key);
        }
    }

    /// The latest frame drawn for a mark.
    pub fn image(&self, key: u64) -> Option<Arc<RenderImage>> {
        self.images.lock().ok()?.get(&key).cloned()
    }
}

/// Security invariant: engine modules are files directly inside the engine folder.
fn module_name(specifier: &str) -> Option<&str> {
    let name = specifier.strip_prefix("./").unwrap_or(specifier);
    let plain = !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\', ':']);
    (plain && name.ends_with(".js")).then_some(name)
}

thread_local! {
    static MODULES: RefCell<Modules> = RefCell::new(Modules::default());
}

#[derive(Default)]
struct Modules {
    folder: PathBuf,
    loaded: HashMap<String, v8::Global<v8::Module>>,
}

fn compile<'s>(scope: &v8::PinScope<'s, '_>, specifier: &str) -> Option<v8::Local<'s, v8::Module>> {
    let name = module_name(specifier)?.to_owned();
    if let Some(module) = MODULES.with(|modules| modules.borrow().loaded.get(&name).cloned()) {
        return Some(v8::Local::new(scope, &module));
    }
    let path = MODULES.with(|modules| modules.borrow().folder.join(&name));
    let text = std::fs::read_to_string(&path).ok()?;
    let code = v8::String::new(scope, &text)?;
    let resource = v8::String::new(scope, &name)?;
    let origin = v8::ScriptOrigin::new(scope, resource.into(), 0, 0, false, 0, None, false, false, true, None);
    let mut source = v8::script_compiler::Source::new(code, Some(&origin));
    let module = v8::script_compiler::compile_module(scope, &mut source)?;
    let global = v8::Global::new(scope, module);
    MODULES.with(|modules| modules.borrow_mut().loaded.insert(name, global));
    Some(module)
}

fn resolve<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    _attributes: v8::Local<'s, v8::FixedArray>,
    _referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    v8::callback_scope!(unsafe scope, context);
    let specifier = specifier.to_rust_string_lossy(scope);
    compile(scope, &specifier)
}

static PLATFORM: Once = Once::new();

/// Bridge functions, as the engine module exports them.
const CALLS: [&str; 7] = ["look", "mount", "update", "pointer", "release", "unmount", "tick"];

fn run(
    folder: &Path,
    module: &str,
    received: mpsc::Receiver<Command>,
    engine: &Engine,
    renderer: &SvgRenderer,
    drawn: &UnboundedSender<()>,
) -> Result<(), String> {
    PLATFORM.call_once(|| {
        v8::V8::initialize_platform(v8::new_default_platform(0, false).make_shared());
        v8::V8::initialize();
    });
    MODULES.with(|modules| modules.borrow_mut().folder = folder.to_path_buf());
    let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
    v8::scope!(let scope, isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);

    let calls = {
        v8::tc_scope!(let scope, scope);
        let failure = |scope: &v8::PinnedRef<v8::TryCatch<v8::HandleScope>>, what: &str| match scope.exception() {
            Some(exception) => format!("{what}: {}", exception.to_rust_string_lossy(scope)),
            None => format!("{what} failed"),
        };
        let bridge = compile(scope, module).ok_or_else(|| failure(scope, "loading the engine"))?;
        if bridge.instantiate_module(scope, resolve) != Some(true) {
            return Err(failure(scope, "linking the engine"));
        }
        bridge.evaluate(scope).ok_or_else(|| failure(scope, "starting the engine"))?;
        scope.perform_microtask_checkpoint();
        if bridge.get_status() != v8::ModuleStatus::Evaluated {
            return Err(format!("starting the engine: {}", bridge.get_exception().to_rust_string_lossy(scope)));
        }
        let exports = v8::Local::<v8::Object>::try_from(bridge.get_module_namespace()).map_err(|e| e.to_string())?;
        let mut calls = HashMap::new();
        for name in CALLS {
            let key = v8::String::new(scope, name).ok_or("out of memory")?;
            let function = exports
                .get(scope, key.into())
                .and_then(|value| v8::Local::<v8::Function>::try_from(value).ok())
                .ok_or_else(|| format!("the engine does not export {name}"))?;
            calls.insert(name, v8::Global::new(scope, function));
        }
        calls
    };

    let started = Instant::now();
    let now = || started.elapsed().as_secs_f64() * 1000.;
    let mut styles: HashMap<u64, Style> = HashMap::new();
    let mut written: HashMap<u64, String> = HashMap::new();
    let mut busy = false;
    let mut due = Instant::now();

    let call = |scope: &mut v8::PinScope, name: &str, args: &[Value]| -> Result<Value, String> {
        v8::scope!(let scope, scope);
        v8::tc_scope!(let scope, scope);
        let function = v8::Local::new(scope, &calls[name]);
        let mut values = Vec::with_capacity(args.len());
        for arg in args {
            let text = v8::String::new(scope, &arg.to_string()).ok_or("out of memory")?;
            values.push(v8::json::parse(scope, text).ok_or("bad argument")?);
        }
        let receiver = v8::undefined(scope).into();
        let Some(result) = function.call(scope, receiver, &values) else {
            let why = scope.exception().map(|e| e.to_rust_string_lossy(scope)).unwrap_or_default();
            return Err(format!("{name}: {why}"));
        };
        if result.is_undefined() {
            return Ok(Value::Null);
        }
        let text = v8::json::stringify(scope, result).ok_or("unreadable result")?;
        serde_json::from_str(&text.to_rust_string_lossy(scope)).map_err(|error| error.to_string())
    };

    loop {
        let first = if busy {
            match received.recv_timeout(due.saturating_duration_since(Instant::now())) {
                Ok(command) => Some(command),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            }
        } else {
            match received.recv() {
                Ok(command) => Some(command),
                Err(_) => return Ok(()),
            }
        };
        let mut restyled = Vec::new();
        for command in first.into_iter().chain(std::iter::from_fn(|| received.try_recv().ok())) {
            match command {
                Command::Look { bot, chosen, reply } => {
                    let look = call(scope, "look", &[bot, chosen])?;
                    let _ = reply.send(serde_json::from_value(look).ok());
                }
                Command::Mount { key, style, working } => {
                    let mark = json!({ "seed": style.seed, "shape": style.shape, "box": style.side, "working": working, "reduced": style.reduced });
                    let remount = styles.get(&key).is_none_or(|old| {
                        old.seed != style.seed
                            || old.shape != style.shape
                            || old.side != style.side
                            || old.reduced != style.reduced
                    });
                    if remount {
                        call(scope, "mount", &[json!(key), mark, json!(now())])?;
                        written.remove(&key);
                    } else {
                        call(scope, "update", &[json!(key), json!(working), json!(now())])?;
                        restyled.push(key);
                    }
                    styles.insert(key, style);
                }
                Command::Update { key, working } => {
                    call(scope, "update", &[json!(key), json!(working), json!(now())])?;
                }
                Command::Pointer { key, rect, point } => {
                    let rect = json!({ "left": rect[0], "top": rect[1], "width": rect[2], "height": rect[3] });
                    call(scope, "pointer", &[json!(key), rect, json!({ "x": point[0], "y": point[1] }), json!(now())])?;
                }
                Command::Release { key } => {
                    call(scope, "release", &[json!(key), json!(now())])?;
                }
                Command::Unmount { key } => {
                    call(scope, "unmount", &[json!(key), json!(now())])?;
                    styles.remove(&key);
                    written.remove(&key);
                    if let Ok(mut images) = engine.images.lock() {
                        images.remove(&key);
                    }
                }
            }
        }
        let ticked = call(scope, "tick", &[json!(now())])?;
        busy = ticked["busy"].as_bool().unwrap_or(false);
        due = Instant::now() + TICK;
        let mut changed = false;
        let fresh = ticked["frames"].as_array().cloned().unwrap_or_default();
        for frame in fresh {
            if let (Some(key), Some(svg)) = (frame[0].as_u64(), frame[1].as_str()) {
                written.insert(key, svg.to_owned());
                restyled.push(key);
            }
        }
        for key in restyled {
            let (Some(style), Some(svg)) = (styles.get(&key), written.get(&key)) else { continue };
            if let Some(image) = raster(renderer, svg, style) {
                if let Ok(mut images) = engine.images.lock() {
                    images.insert(key, image);
                    changed = true;
                }
            }
        }
        if changed {
            let _ = drawn.unbounded_send(());
        }
    }
}

fn hex(color: Hsla) -> String {
    let rgba = Rgba::from(color);
    let channel = |value: f32| (value.clamp(0., 1.) * 255.).round() as u8;
    format!("#{:02x}{:02x}{:02x}", channel(rgba.r), channel(rgba.g), channel(rgba.b))
}

/// An engine frame painted for its mark and rasterised at the window's scale.
fn raster(renderer: &SvgRenderer, svg: &str, style: &Style) -> Option<Arc<RenderImage>> {
    let side = format!(r#"width="{0}" height="{0}""#, style.side);
    let bytes = match &style.paint {
        Paint::Gradient(stops) => gradient_svg(svg.as_bytes(), stops, style.side),
        Paint::Color(color) => {
            svg.replace(INK, &hex(*color)).replace(r#"width="192" height="192""#, &side).into_bytes()
        }
        Paint::Ink => svg.replace(INK, &hex(style.ink)).replace(r#"width="192" height="192""#, &side).into_bytes(),
    };
    renderer.render_single_frame(&bytes, style.scale).ok()
}

#[cfg(test)]
mod tests {
    use super::module_name;

    #[test]
    fn engine_modules_stay_in_their_folder() {
        assert_eq!(module_name("./bridge.js"), Some("bridge.js"));
        assert_eq!(module_name("roster.js"), Some("roster.js"));
        for outside in ["../pack.js", "./sub/x.js", "C:\\x.js", "/etc/x.js", "./x.mjs", "", "./.hidden.js", "c:x.js"] {
            assert_eq!(module_name(outside), None, "{outside} was accepted");
        }
    }
}
