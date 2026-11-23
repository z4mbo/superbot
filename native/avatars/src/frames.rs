use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use crate::pack::PackError;

/// One frames file: a shape drawn as single-colour SVGs, transparent where it has holes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShapeFile {
    version: u32,
    fps: f32,
    gaze_rate: f32,
    gaze_x: Vec<f32>,
    gaze_y: Vec<f32>,
    holds: Vec<f32>,
    rest: String,
    gaze: Vec<GazeFile>,
    working: Vec<String>,
    working_compact: Vec<String>,
    start: Vec<String>,
    start_join: usize,
    stop: Vec<StopFile>,
}

#[derive(Deserialize)]
struct GazeFile {
    x: f32,
    y: f32,
    frames: Vec<String>,
}

#[derive(Deserialize)]
struct StopFile {
    at: usize,
    frames: Vec<String>,
}

#[derive(Deserialize)]
struct Version {
    version: u32,
}

/// Format 1: each turn as frames at fixed times, and no bridges into or out of work.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShapeFileV1 {
    fps: f32,
    gaze_x: Vec<f32>,
    gaze_y: Vec<f32>,
    ease_ms: Vec<f32>,
    rest: String,
    gaze: Vec<GazeFileV1>,
    working: Vec<String>,
    working_compact: Vec<String>,
}

#[derive(Deserialize)]
struct GazeFileV1 {
    x: f32,
    y: f32,
    approach: Vec<String>,
    settled: String,
    leave: Vec<String>,
}

/// Format 1 files do not record their turn rate. They were all taken from an engine whose turn
/// closes 14% of its gap every 1/60 s.
const V1_GAZE_RATE: f32 = 9.0496;

impl ShapeFileV1 {
    /// The same frames in format 2: a frame taken `t` into a turn shows the hold the turn had
    /// reached by then, `1 - e^(-rate·t)` turning toward the pointer and `e^(-rate·t)` turning back.
    fn upgrade(self) -> Result<ShapeFile, String> {
        let ease = &self.ease_ms;
        if ease.is_empty() || ease[0] <= 0. || ease.windows(2).any(|pair| pair[1] <= pair[0]) {
            return Err("ease steps must rise".into());
        }
        if self.gaze.iter().any(|pose| pose.approach.len() != ease.len() || pose.leave.len() != ease.len()) {
            return Err("every turn needs one frame per ease step".into());
        }
        let left = |ms: f32| (-V1_GAZE_RATE * ms / 1000.).exp();
        let mut levels: Vec<(f32, Taken)> = (0..ease.len())
            .flat_map(|step| [(1. - left(ease[step]), Taken::Approach(step)), (left(ease[step]), Taken::Leave(step))])
            .chain([(1., Taken::Settled)])
            .collect();
        levels.sort_by(|a, b| a.0.total_cmp(&b.0));
        levels.dedup_by(|later, earlier| later.0 - earlier.0 < 1e-4);
        let gaze = self
            .gaze
            .into_iter()
            .map(|pose| GazeFile {
                x: pose.x,
                y: pose.y,
                frames: levels
                    .iter()
                    .map(|(_, taken)| match taken {
                        Taken::Approach(step) => pose.approach[*step].clone(),
                        Taken::Leave(step) => pose.leave[*step].clone(),
                        Taken::Settled => pose.settled.clone(),
                    })
                    .collect(),
            })
            .collect();
        Ok(ShapeFile {
            version: 2,
            fps: self.fps,
            gaze_rate: V1_GAZE_RATE,
            gaze_x: self.gaze_x,
            gaze_y: self.gaze_y,
            holds: levels.iter().map(|(hold, _)| *hold).collect(),
            rest: self.rest,
            gaze,
            working: self.working,
            working_compact: self.working_compact,
            start: Vec::new(),
            start_join: 0,
            stop: Vec::new(),
        })
    }
}

#[derive(Clone, Copy)]
enum Taken {
    Approach(usize),
    Leave(usize),
    Settled,
}

pub type Frame = Arc<[u8]>;

struct Pose {
    x: f32,
    y: f32,
    frames: Vec<Frame>,
}

struct Stop {
    at: usize,
    frames: Vec<Frame>,
}

/// Every frame of one shape, ready to paint.
pub struct Frames {
    pub fps: f32,
    /// How fast a turn closes its gap, per second: the gap left after `t` seconds is `e^(-rate·t)`.
    pub gaze_rate: f32,
    rest: Frame,
    holds: Vec<f32>,
    poses: Vec<Pose>,
    working: Vec<Frame>,
    working_compact: Vec<Frame>,
    start: Vec<Frame>,
    start_join: usize,
    stops: Vec<Stop>,
}

enum Unreadable {
    Parse(serde_json::Error),
    Invalid(String),
}

fn frame(svg: String) -> Frame {
    Arc::from(svg.into_bytes().into_boxed_slice())
}

fn frames(list: Vec<String>) -> Vec<Frame> {
    list.into_iter().map(frame).collect()
}

impl Frames {
    pub fn read(path: &Path) -> Result<Frames, PackError> {
        let bytes = std::fs::read(path).map_err(|error| PackError::Read(path.to_path_buf(), error))?;
        Frames::parse(&bytes).map_err(|error| match error {
            Unreadable::Parse(error) => PackError::Parse(path.to_path_buf(), error),
            Unreadable::Invalid(why) => PackError::Invalid(format!("{}: {why}", path.display())),
        })
    }

    /// A frames file in format 1 or 2.
    fn parse(bytes: &[u8]) -> Result<Frames, Unreadable> {
        let file = match serde_json::from_slice::<Version>(bytes).map_err(Unreadable::Parse)?.version {
            1 => serde_json::from_slice::<ShapeFileV1>(bytes).map_err(Unreadable::Parse)?.upgrade(),
            2 => Ok(serde_json::from_slice::<ShapeFile>(bytes).map_err(Unreadable::Parse)?),
            version => Err(format!("frames version {version} is not supported")),
        };
        file.and_then(Frames::new).map_err(Unreadable::Invalid)
    }

    fn new(file: ShapeFile) -> Result<Frames, String> {
        if file.version != 2 {
            return Err(format!("frames version {} is not supported", file.version));
        }
        if !(file.fps.is_finite() && file.fps > 0.) {
            return Err("fps must be positive".into());
        }
        if !(file.gaze_rate.is_finite() && file.gaze_rate > 0.) {
            return Err("gazeRate must be positive".into());
        }
        if file.working.is_empty() || file.working_compact.is_empty() {
            return Err("a shape needs working frames".into());
        }
        if file.gaze.is_empty() || file.gaze.len() != file.gaze_x.len() * file.gaze_y.len() {
            return Err("gaze poses must fill the gaze grid".into());
        }
        let rising = file.holds.windows(2).all(|pair| pair[1] > pair[0]);
        if file.holds.is_empty() || !rising || file.holds[0] <= 0. || file.holds[file.holds.len() - 1] > 1. {
            return Err("holds must rise from above 0 to at most 1".into());
        }
        if file.gaze.iter().any(|pose| pose.frames.len() != file.holds.len()) {
            return Err("every pose needs one frame per hold".into());
        }
        if file.start_join >= file.working.len() {
            return Err("startJoin must be a working frame".into());
        }
        if file.stop.iter().any(|stop| stop.at >= file.working.len() || stop.frames.is_empty()) {
            return Err("every stop starts at a working frame and has frames".into());
        }
        Ok(Frames {
            fps: file.fps,
            gaze_rate: file.gaze_rate,
            rest: frame(file.rest),
            holds: file.holds,
            poses: file
                .gaze
                .into_iter()
                .map(|pose| Pose { x: pose.x, y: pose.y, frames: frames(pose.frames) })
                .collect(),
            working: frames(file.working),
            working_compact: frames(file.working_compact),
            start: frames(file.start),
            start_join: file.start_join,
            stops: file.stop.into_iter().map(|stop| Stop { at: stop.at, frames: frames(stop.frames) }).collect(),
        })
    }

    pub fn rest(&self) -> &Frame {
        &self.rest
    }

    /// The mark looking toward `(x, y)` (each -1 to 1, y up) with `hold` from 0 (at rest) to 1
    /// (fully turned): the nearest captured pose at the nearest captured hold.
    pub fn look(&self, x: f32, y: f32, hold: f32) -> &Frame {
        if hold < self.holds[0] / 2. {
            return &self.rest;
        }
        let distance = |pose: &Pose| (pose.x - x).powi(2) + (pose.y - y).powi(2);
        let Some(pose) = self.poses.iter().min_by(|a, b| distance(a).total_cmp(&distance(b))) else {
            return &self.rest;
        };
        let level = (0..self.holds.len())
            .min_by(|a, b| (self.holds[*a] - hold).abs().total_cmp(&(self.holds[*b] - hold).abs()))
            .unwrap_or(0);
        &pose.frames[level]
    }

    pub fn working(&self, compact: bool) -> &[Frame] {
        if compact {
            &self.working_compact
        } else {
            &self.working
        }
    }

    /// The working loop's frame at `position`, in loops (only its fraction counts).
    pub fn working_frame(&self, compact: bool, position: f64) -> &Frame {
        let frames = self.working(compact);
        &frames[self.loop_index(compact, position)]
    }

    pub fn loop_index(&self, compact: bool, position: f64) -> usize {
        let frames = self.working(compact);
        ((position.rem_euclid(1.) * frames.len() as f64) as usize).min(frames.len() - 1)
    }

    pub fn loop_length(&self, compact: bool) -> Duration {
        Duration::from_secs_f32(self.working(compact).len() as f32 / self.fps)
    }

    /// The bridge from rest into the working loop, and the loop frame it hands over to.
    pub fn start(&self) -> (&[Frame], usize) {
        (&self.start, self.start_join)
    }

    /// The bridge to rest for a loop at the working frame `index`: the next captured one, and how
    /// many loop frames play before it.
    pub fn stop_from(&self, index: usize) -> Option<(usize, &[Frame])> {
        let len = self.working.len();
        let ahead = |at: usize| (at + len - index % len) % len;
        self.stops.iter().min_by_key(|stop| ahead(stop.at)).map(|stop| (ahead(stop.at), stop.frames.as_slice()))
    }

    pub fn frame_time(&self) -> Duration {
        Duration::from_secs_f32(1. / self.fps)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn svg(label: &str) -> String {
        format!("<svg><title>{label}</title></svg>")
    }

    fn file() -> ShapeFile {
        let holds = vec![0.25, 0.5, 1.];
        let gaze = [1., -1.]
            .iter()
            .flat_map(|y| [-1., 0., 1.].map(move |x| (x, *y)))
            .map(|(x, y): (f32, f32)| GazeFile {
                x,
                y,
                frames: holds.iter().map(|hold| svg(&format!("{x},{y} at {hold}"))).collect(),
            })
            .collect();
        ShapeFile {
            version: 2,
            fps: 10.,
            gaze_rate: 9.,
            gaze_x: vec![-1., 0., 1.],
            gaze_y: vec![1., -1.],
            holds,
            rest: svg("rest"),
            gaze,
            working: (0..10).map(|n| svg(&format!("work {n}"))).collect(),
            working_compact: (0..4).map(|n| svg(&format!("small {n}"))).collect(),
            start: (0..3).map(|n| svg(&format!("start {n}"))).collect(),
            start_join: 6,
            stop: [0, 5]
                .into_iter()
                .map(|at| StopFile { at, frames: (0..2).map(|n| svg(&format!("stop {at} {n}"))).collect() })
                .collect(),
        }
    }

    pub(crate) fn frames() -> Frames {
        Frames::new(file()).unwrap()
    }

    pub(crate) fn text(frame: &Frame) -> &str {
        std::str::from_utf8(frame).unwrap()
    }

    #[test]
    fn a_look_takes_the_nearest_pose_at_the_nearest_hold() {
        let frames = frames();
        assert_eq!(text(frames.look(0.9, 0.2, 1.)), svg("1,1 at 1"));
        assert_eq!(text(frames.look(-0.4, -3., 0.3)), svg("0,-1 at 0.25"));
        assert_eq!(text(frames.look(0.9, 0.2, 0.7)), svg("1,1 at 0.5"));
        assert_eq!(text(frames.look(0.9, 0.2, 0.1)), svg("rest"));
    }

    #[test]
    fn the_working_loop_wraps_and_stops_from_the_nearest_capture() {
        let frames = frames();
        assert_eq!(frames.loop_length(false), Duration::from_secs(1));
        assert_eq!(text(frames.working_frame(false, 0.95)), svg("work 9"));
        assert_eq!(text(frames.working_frame(false, 1.05)), svg("work 0"));
        assert_eq!(text(frames.working_frame(true, 0.5)), svg("small 2"));
        let (wait, bridge) = frames.stop_from(9).unwrap();
        assert_eq!((wait, text(&bridge[0])), (1, svg("stop 0 0").as_str()));
        let (wait, bridge) = frames.stop_from(5).unwrap();
        assert_eq!((wait, text(&bridge[1])), (0, svg("stop 5 1").as_str()));
    }

    #[test]
    fn incomplete_files_are_refused() {
        let mut short = file();
        short.gaze_x.push(2.);
        assert!(Frames::new(short).is_err());
        let mut falling = file();
        falling.holds = vec![0.5, 0.25, 1.];
        assert!(Frames::new(falling).is_err());
        let mut joined = file();
        joined.start_join = 10;
        assert!(Frames::new(joined).is_err());
        let mut unknown = file();
        unknown.version = 3;
        assert!(Frames::new(unknown).is_err());
    }

    /// A format 1 file: two poses, turns taken at 100 and 200 ms.
    pub(crate) const V1: &str = r#"{
        "version": 1, "fps": 10, "gazeX": [-1, 1], "gazeY": [0], "easeMs": [100, 200],
        "rest": "rest",
        "gaze": [
            { "x": -1, "y": 0, "approach": ["to left 1", "to left 2"], "settled": "left", "leave": ["from left 1", "from left 2"] },
            { "x": 1, "y": 0, "approach": ["to right 1", "to right 2"], "settled": "right", "leave": ["from right 1", "from right 2"] }
        ],
        "working": ["work 0", "work 1", "work 2", "work 3"],
        "workingCompact": ["small 0", "small 1"]
    }"#;

    pub(crate) fn v1() -> Frames {
        Frames::parse(V1.as_bytes()).ok().unwrap()
    }

    #[test]
    fn a_format_1_file_keeps_its_frames_with_each_turn_frame_at_its_hold() {
        let frames = v1();
        let left = |ms: f32| (-V1_GAZE_RATE * ms / 1000.).exp();
        assert_eq!(text(frames.rest()), "rest");
        assert_eq!(text(frames.look(0.8, 0.1, 1.)), "right");
        assert_eq!(text(frames.look(-0.8, 0., 1. - left(100.))), "to left 1");
        assert_eq!(text(frames.look(-0.8, 0., 1. - left(200.))), "to left 2");
        assert_eq!(text(frames.look(1., 0., left(100.))), "from right 1");
        assert_eq!(text(frames.look(1., 0., left(200.))), "from right 2");
        assert_eq!(text(frames.look(1., 0., 0.001)), "rest");
        assert_eq!(frames.gaze_rate, V1_GAZE_RATE);
        assert_eq!(text(frames.working_frame(false, 0.6)), "work 2");
        assert_eq!(text(frames.working_frame(true, 0.6)), "small 1");
        assert!(frames.start().0.is_empty());
        assert!(frames.stop_from(1).is_none());
    }

    #[test]
    fn a_format_1_file_with_short_turns_or_falling_steps_is_refused() {
        let short = V1.replace(r#""leave": ["from left 1", "from left 2"]"#, r#""leave": ["from left 1"]"#);
        assert!(Frames::parse(short.as_bytes()).is_err());
        let falling = V1.replace("[100, 200]", "[200, 100]");
        assert!(Frames::parse(falling.as_bytes()).is_err());
        let unknown = V1.replace(r#""version": 1"#, r#""version": 7"#);
        assert!(Frames::parse(unknown.as_bytes()).is_err());
    }
}
