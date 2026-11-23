//! Profiling hook. With `SUPERBOT_AVATAR_TRACE` naming a file, records one line per event of the
//! live avatar pipeline (frames asked for, drawn by the engine, shown, pointer input), with times in
//! milliseconds since the first event.

use std::fs::File;
use std::io::{LineWriter, Write};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

struct Trace {
    epoch: Instant,
    file: Mutex<LineWriter<File>>,
}

static TRACE: OnceLock<Option<Trace>> = OnceLock::new();

fn trace() -> Option<&'static Trace> {
    TRACE
        .get_or_init(|| {
            let path = std::env::var_os("SUPERBOT_AVATAR_TRACE")?;
            let file = File::create(path).map_err(|error| eprintln!("avatar trace not written: {error}")).ok()?;
            Some(Trace { epoch: Instant::now(), file: Mutex::new(LineWriter::new(file)) })
        })
        .as_ref()
}

pub fn on() -> bool {
    trace().is_some()
}

/// Milliseconds from the first event to `at`.
pub fn ms(at: Instant) -> f64 {
    trace().map(|trace| at.saturating_duration_since(trace.epoch).as_secs_f64() * 1000.).unwrap_or(0.)
}

pub fn event(kind: &str, fields: std::fmt::Arguments) {
    if let Some(trace) = trace() {
        if let Ok(mut file) = trace.file.lock() {
            let _ = writeln!(file, "{kind} {fields}");
        }
    }
}
