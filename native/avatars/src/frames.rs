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
    gaze_x: Vec<f32>,
    gaze_y: Vec<f32>,
    ease_ms: Vec<f32>,
    rest: String,
    gaze: Vec<GazeFile>,
    working: Vec<String>,
    working_compact: Vec<String>,
}

#[derive(Deserialize)]
struct GazeFile {
    x: f32,
    y: f32,
    approach: Vec<String>,
    settled: String,
    leave: Vec<String>,
}

pub type Frame = Arc<[u8]>;

struct Pose {
    x: f32,
    y: f32,
    approach: Vec<Frame>,
    settled: Frame,
    leave: Vec<Frame>,
}

/// Every frame of one shape, ready to paint.
pub struct Frames {
    pub fps: f32,
    rest: Frame,
    ease: Vec<Duration>,
    poses: Vec<Pose>,
    working: Vec<Frame>,
    working_compact: Vec<Frame>,
}

/// Where a mark is looking, and since when relative to the transition's own clock.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Glance {
    Rest,
    /// Turning to look at gaze pose `to`; `progress` runs from 0 to 1 over [`Frames::turn`].
    Toward {
        to: usize,
        progress: f32,
    },
    /// Turning back to rest from gaze pose `from`.
    Away {
        from: usize,
        progress: f32,
    },
}

impl Frames {
    pub fn read(path: &Path) -> Result<Frames, PackError> {
        let bytes = std::fs::read(path).map_err(|error| PackError::Read(path.to_path_buf(), error))?;
        let file: ShapeFile =
            serde_json::from_slice(&bytes).map_err(|error| PackError::Parse(path.to_path_buf(), error))?;
        Frames::new(file).map_err(|why| PackError::Invalid(format!("{}: {why}", path.display())))
    }

    fn new(file: ShapeFile) -> Result<Frames, String> {
        let frame = |svg: String| -> Frame { Arc::from(svg.into_bytes().into_boxed_slice()) };
        let frames = |list: Vec<String>| list.into_iter().map(frame).collect::<Vec<_>>();
        if file.version != 1 {
            return Err(format!("frames version {} is not supported", file.version));
        }
        if !(file.fps.is_finite() && file.fps > 0.) {
            return Err("fps must be positive".into());
        }
        if file.working.is_empty() || file.working_compact.is_empty() {
            return Err("a shape needs working frames".into());
        }
        if file.gaze.len() != file.gaze_x.len() * file.gaze_y.len() {
            return Err("gaze poses must fill the gaze grid".into());
        }
        if file
            .gaze
            .iter()
            .any(|pose| pose.approach.len() != file.ease_ms.len() || pose.leave.len() != file.ease_ms.len())
        {
            return Err("every turn needs one frame per ease step".into());
        }
        if file.ease_ms.windows(2).any(|pair| pair[1] <= pair[0]) || file.ease_ms.first().is_some_and(|ms| *ms <= 0.) {
            return Err("ease steps must rise".into());
        }
        Ok(Frames {
            fps: file.fps,
            rest: frame(file.rest),
            ease: file.ease_ms.iter().map(|ms| Duration::from_micros((ms * 1000.).round() as u64)).collect(),
            poses: file
                .gaze
                .into_iter()
                .map(|pose| Pose {
                    x: pose.x,
                    y: pose.y,
                    approach: frames(pose.approach),
                    settled: frame(pose.settled),
                    leave: frames(pose.leave),
                })
                .collect(),
            working: frames(file.working),
            working_compact: frames(file.working_compact),
        })
    }

    /// How long turning toward a point, or back to rest, takes.
    pub fn turn(&self) -> Duration {
        match self.ease.as_slice() {
            [] => Duration::ZERO,
            [only] => *only,
            [.., before, last] => *last + (*last - *before),
        }
    }

    /// The gaze pose closest to `(x, y)`, each from -1 to 1 with y pointing up.
    pub fn pose_toward(&self, x: f32, y: f32) -> usize {
        let distance = |pose: &Pose| (pose.x - x).powi(2) + (pose.y - y).powi(2);
        (0..self.poses.len())
            .min_by(|a, b| distance(&self.poses[*a]).total_cmp(&distance(&self.poses[*b])))
            .unwrap_or(0)
    }

    pub fn glance(&self, glance: Glance) -> &Frame {
        let step = |progress: f32| {
            let at = self.turn().mul_f32(progress.clamp(0., 1.));
            self.ease.iter().take_while(|ease| **ease <= at).count()
        };
        match glance {
            Glance::Rest => &self.rest,
            Glance::Toward { to, progress } => match self.poses.get(to) {
                None => &self.rest,
                Some(pose) => match step(progress) {
                    0 => &self.rest,
                    n if n > pose.approach.len() || progress >= 1. => &pose.settled,
                    n => &pose.approach[n - 1],
                },
            },
            Glance::Away { from, progress } => match self.poses.get(from) {
                None => &self.rest,
                Some(pose) => match step(progress) {
                    0 => &pose.settled,
                    n if n > pose.leave.len() || progress >= 1. => &self.rest,
                    n => &pose.leave[n - 1],
                },
            },
        }
    }

    pub fn working(&self, compact: bool) -> &[Frame] {
        if compact {
            &self.working_compact
        } else {
            &self.working
        }
    }

    /// A working loop's frame, `progress` from 0 to 1 through the loop and `phase` where this
    /// bot starts in it.
    pub fn working_frame(&self, compact: bool, progress: f32, phase: f32) -> &Frame {
        let frames = self.working(compact);
        let position = (progress + phase).rem_euclid(1.) * frames.len() as f32;
        &frames[(position as usize).min(frames.len() - 1)]
    }

    pub fn loop_length(&self, compact: bool) -> Duration {
        Duration::from_secs_f32(self.working(compact).len() as f32 / self.fps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svg(label: &str) -> String {
        format!("<svg><title>{label}</title></svg>")
    }

    fn frames() -> Frames {
        let ease = vec![100., 200., 400.];
        let gaze = [1., -1.]
            .iter()
            .flat_map(|y| [-1., 0., 1.].map(move |x| (x, *y)))
            .map(|(x, y): (f32, f32)| GazeFile {
                x,
                y,
                approach: (0..3).map(|n| svg(&format!("to {x},{y} #{n}"))).collect(),
                settled: svg(&format!("at {x},{y}")),
                leave: (0..3).map(|n| svg(&format!("from {x},{y} #{n}"))).collect(),
            })
            .collect();
        Frames::new(ShapeFile {
            version: 1,
            fps: 10.,
            gaze_x: vec![-1., 0., 1.],
            gaze_y: vec![1., -1.],
            ease_ms: ease,
            rest: svg("rest"),
            gaze,
            working: (0..10).map(|n| svg(&format!("work {n}"))).collect(),
            working_compact: (0..4).map(|n| svg(&format!("small {n}"))).collect(),
        })
        .unwrap()
    }

    fn text(frame: &Frame) -> &str {
        std::str::from_utf8(frame).unwrap()
    }

    #[test]
    fn the_pointer_picks_the_nearest_pose() {
        let frames = frames();
        assert_eq!(
            text(frames.glance(Glance::Toward { to: frames.pose_toward(0.9, 0.2), progress: 1. })),
            svg("at 1,1")
        );
        assert_eq!(
            text(frames.glance(Glance::Toward { to: frames.pose_toward(-0.4, -3.), progress: 1. })),
            svg("at 0,-1")
        );
    }

    #[test]
    fn turning_steps_through_the_captured_frames_at_their_times() {
        let frames = frames();
        assert_eq!(frames.turn(), Duration::from_millis(600));
        let toward = |progress| text(frames.glance(Glance::Toward { to: 2, progress })).to_owned();
        assert_eq!(toward(0.), svg("rest"));
        assert_eq!(toward(0.2), svg("to 1,1 #0"));
        assert_eq!(toward(0.5), svg("to 1,1 #1"));
        assert_eq!(toward(0.7), svg("to 1,1 #2"));
        assert_eq!(toward(1.), svg("at 1,1"));
        let away = |progress| text(frames.glance(Glance::Away { from: 2, progress })).to_owned();
        assert_eq!(away(0.), svg("at 1,1"));
        assert_eq!(away(0.4), svg("from 1,1 #1"));
        assert_eq!(away(1.), svg("rest"));
    }

    #[test]
    fn working_loops_with_each_bot_at_its_own_place() {
        let frames = frames();
        assert_eq!(frames.loop_length(false), Duration::from_secs(1));
        assert_eq!(text(frames.working_frame(false, 0., 0.)), svg("work 0"));
        assert_eq!(text(frames.working_frame(false, 0.95, 0.)), svg("work 9"));
        assert_eq!(text(frames.working_frame(false, 0.95, 0.1)), svg("work 0"));
        assert_eq!(text(frames.working_frame(true, 0.5, 0.)), svg("small 2"));
    }

    #[test]
    fn incomplete_files_are_refused() {
        let mut file: ShapeFile = serde_json::from_str(
            r#"{"version":1,"fps":30,"gazeX":[0],"gazeY":[0],"easeMs":[100],"rest":"r",
                "gaze":[{"x":0,"y":0,"approach":["a"],"settled":"s","leave":["l"]}],
                "working":["w"],"workingCompact":["c"]}"#,
        )
        .unwrap();
        file.gaze_x.push(1.);
        assert!(Frames::new(file).is_err());
    }
}
