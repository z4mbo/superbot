use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::*;

use crate::app::Desktop;
use crate::theme::{mix, Theme};

const DURATION: Duration = Duration::from_millis(120);
/// How far the fill moves toward ink under the pointer.
const TINT: f32 = 0.07;

/// The stylesheet's colour transition curve, `cubic-bezier(0.4, 0, 0.2, 1)`.
fn ease(progress: f32) -> f32 {
    const X: (f32, f32) = (0.4, 0.2);
    const Y: (f32, f32) = (0.0, 1.0);
    let along = |(first, second): (f32, f32), t: f32| {
        let rest = 1.0 - t;
        3.0 * rest * rest * t * first + 3.0 * rest * t * t * second + t * t * t
    };
    let progress = progress.clamp(0.0, 1.0);
    let (mut low, mut high) = (0.0_f32, 1.0_f32);
    for _ in 0..24 {
        let middle = (low + high) / 2.0;
        if along(X, middle) < progress {
            low = middle;
        } else {
            high = middle;
        }
    }
    along(Y, (low + high) / 2.0)
}

/// One control's hover tint, moving the way a CSS transition does: 0 at rest, 1 fully tinted.
#[derive(Clone, Copy, Debug)]
pub struct Tint {
    from: f32,
    to: f32,
    began: Option<Instant>,
    span: Duration,
    /// The part of a full transition this one covers. A transition turned back part-way runs
    /// only for as long as it had come (CSS Transitions, "faster reversing").
    share: f32,
}

impl Default for Tint {
    fn default() -> Self {
        Self { from: 0.0, to: 0.0, began: None, span: Duration::ZERO, share: 1.0 }
    }
}

impl Tint {
    fn progress(&self, now: Instant) -> f32 {
        match self.began {
            Some(began) if !self.span.is_zero() => {
                (now.saturating_duration_since(began).as_secs_f32() / self.span.as_secs_f32()).min(1.0)
            }
            _ => 1.0,
        }
    }

    pub fn level(&self, now: Instant) -> f32 {
        self.from + (self.to - self.from) * ease(self.progress(now))
    }

    pub fn moving(&self, now: Instant) -> bool {
        self.progress(now) < 1.0
    }

    /// Heads for tinted or rest from wherever the tint is now. `still` is reduced motion: it arrives at once.
    pub fn aim(&mut self, tinted: bool, now: Instant, still: bool) {
        let to = if tinted { 1.0 } else { 0.0 };
        if to == self.to {
            return;
        }
        if still {
            *self = Self { from: to, to, ..Self::default() };
            return;
        }
        let eased = ease(self.progress(now));
        let share = if self.moving(now) { (eased * self.share + 1.0 - self.share).clamp(0.0, 1.0) } else { 1.0 };
        *self = Self { from: self.level(now), to, began: Some(now), span: DURATION.mul_f32(share), share };
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Corner {
    Search,
    New,
    Plugins,
    Workspace,
}

impl Corner {
    fn id(self) -> &'static str {
        match self {
            Self::Search => "search-toggle",
            Self::New => "new-agent",
            Self::Plugins => "open-store",
            Self::Workspace => "open-workspace",
        }
    }

    fn glyph(self) -> (&'static str, Pixels) {
        match self {
            Self::Search => ("icons/corner-search.svg", px(18.)),
            Self::New => ("icons/corner-plus.svg", px(20.)),
            Self::Plugins => ("icons/apps.svg", px(16.)),
            Self::Workspace => ("icons/settings.svg", px(16.)),
        }
    }
}

/// The tints of the sidebar's round controls.
#[derive(Default)]
pub struct Tints {
    hovered: [bool; 4],
    held: [bool; 4],
    tints: [Tint; 4],
}

impl Tints {
    fn hover(&mut self, corner: Corner, hovered: bool, now: Instant, still: bool) {
        let index = corner as usize;
        self.hovered[index] = hovered;
        self.tints[index].aim(hovered || self.held[index], now, still);
    }

    /// The tint to draw now, and whether it is still on its way. A control keeps its tint while
    /// what it opened stays open.
    fn settle(&mut self, corner: Corner, held: bool, now: Instant, still: bool) -> (f32, bool) {
        let index = corner as usize;
        self.held[index] = held;
        let tint = &mut self.tints[index];
        tint.aim(self.hovered[index] || held, now, still);
        (tint.level(now), tint.moving(now))
    }
}

#[derive(Default)]
struct Glyphs(HashMap<(&'static str, [u8; 4], u32), Arc<RenderImage>>);

impl Global for Glyphs {}

/// How much finer than the screen a glyph is rasterised before it is averaged down. resvg 0.45
/// samples four scanlines per pixel, which leaves a horizontal stroke edge only four levels of
/// coverage; at this factor it has thirty-two.
const OVERSAMPLE: usize = 8;

/// Averages each `factor`-wide block of a straight-alpha four-channel image into one pixel,
/// weighting colour by coverage so that empty texels do not darken an edge.
fn shrink(fine: &[u8], width: usize, factor: usize) -> Vec<u8> {
    let (columns, rows) = (width / factor, fine.len() / 4 / width / factor);
    let mut coarse = Vec::with_capacity(columns * rows * 4);
    for row in 0..rows {
        for column in 0..columns {
            let (mut colour, mut coverage) = ([0_usize; 3], 0_usize);
            for texel in (0..factor * factor)
                .map(|at| ((row * factor + at / factor) * width + column * factor + at % factor) * 4)
            {
                let alpha = fine[texel + 3] as usize;
                coverage += alpha;
                for channel in 0..3 {
                    colour[channel] += fine[texel + channel] as usize * alpha;
                }
            }
            coarse.extend(colour.map(|sum| if coverage == 0 { 0 } else { ((sum + coverage / 2) / coverage) as u8 }));
            coarse.push(((coverage + factor * factor / 2) / (factor * factor)) as u8);
        }
    }
    coarse
}

/// A glyph as an image in its final colour, one image pixel per device pixel.
///
/// GPUI (gpui-pre 0.3.12) draws `svg()` icons through its text pipeline on Windows, whose
/// contrast and gamma correction thickens light strokes on dark fills, and unions overlapping
/// shapes into one mask. An image keeps plain coverage and paints each shape on its own, as a
/// browser does. GPUI rasterises SVG images at `SMOOTH_SVG_SCALE_FACTOR` times the scale asked
/// for, so the scale asked for is divided by it.
fn glyph(path: &'static str, size: Pixels, color: Hsla, window: &Window, cx: &mut App) -> AnyElement {
    let rgba = color.to_rgb();
    let channel = |value: f32| (value * 255.0).round() as u8;
    let key =
        (path, [channel(rgba.r), channel(rgba.g), channel(rgba.b), channel(rgba.a)], window.scale_factor().to_bits());
    let cached = cx.default_global::<Glyphs>().0.get(&key).cloned();
    let image = cached.or_else(|| {
        let source = cx.asset_source().load(path).ok().flatten()?;
        let paint =
            format!(r##"stroke="#{:02x}{:02x}{:02x}" stroke-opacity="{}""##, key.1[0], key.1[1], key.1[2], rgba.a);
        let drawn = String::from_utf8_lossy(&source).replace(r#"stroke="currentColor""#, &paint);
        let scale = window.scale_factor() * OVERSAMPLE as f32 / SMOOTH_SVG_SCALE_FACTOR;
        let fine = cx.svg_renderer().render_single_frame(drawn.as_bytes(), scale).ok()?;
        let width = i32::from(fine.size(0).width) as usize;
        let coarse = shrink(fine.as_bytes(0)?, width, OVERSAMPLE);
        let buffer = image::RgbaImage::from_raw(
            (width / OVERSAMPLE) as u32,
            (coarse.len() * OVERSAMPLE / 4 / width) as u32,
            coarse,
        )?;
        let image = Arc::new(RenderImage::new(vec![image::Frame::new(buffer)]));
        cx.default_global::<Glyphs>().0.insert(key, image.clone());
        Some(image)
    });
    match image {
        Some(image) => img(ImageSource::Render(image)).size(size).flex_shrink_0().into_any_element(),
        None => svg().path(path).size(size).flex_shrink_0().text_color(color).into_any_element(),
    }
}

impl Desktop {
    /// One of the sidebar's round elevated controls. `held` is true while what it opens is open.
    pub fn corner_control(
        &mut self,
        corner: Corner,
        held: bool,
        theme: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let (level, moving) = self.tints.settle(corner, held, Instant::now(), cx.reduce_motion());
        if moving {
            window.request_animation_frame();
        }
        let (path, size) = corner.glyph();
        div()
            .id(corner.id())
            .size_9()
            .flex_shrink_0()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(mix(theme.composer, theme.ink, TINT * level))
            .border_1()
            .border_color(theme.ink_at(0.06))
            .cursor_pointer()
            .occlude()
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                this.tints.hover(corner, *hovered, Instant::now(), cx.reduce_motion());
                cx.notify();
            }))
            .child(glyph(path, size, theme.ink_at(0.9), window, cx))
    }
}

#[cfg(test)]
mod tests {
    use super::{ease, shrink, Corner, Tint, Tints, DURATION};
    use std::time::{Duration, Instant};

    fn near(left: f32, right: f32) -> bool {
        (left - right).abs() < 0.002
    }

    fn after(start: Instant, millis: f32) -> Instant {
        start + Duration::from_secs_f32(millis / 1000.0)
    }

    #[test]
    fn the_curve_is_the_stylesheets_colour_transition() {
        // Points of cubic-bezier(0.4, 0, 0.2, 1) at curve parameters 0, 1/4, 1/2 and 1.
        for (x, y) in [(0.0, 0.0), (0.2125, 0.15625), (0.35, 0.5), (1.0, 1.0)] {
            assert!(near(ease(x), y), "ease({x}) = {} instead of {y}", ease(x));
        }
    }

    #[test]
    fn a_hover_takes_the_whole_duration_and_then_rests() {
        let start = Instant::now();
        let mut tint = Tint::default();
        assert!(!tint.moving(start), "an untouched control asks for no frames");
        tint.aim(true, start, false);
        assert!(near(tint.level(start), 0.0));
        assert!(near(tint.level(after(start, 42.0)), 0.5));
        assert!(tint.moving(after(start, 119.0)));
        assert!(near(tint.level(start + DURATION), 1.0));
        assert!(!tint.moving(start + DURATION));
    }

    #[test]
    fn leaving_part_way_returns_from_there_in_the_time_it_had_come() {
        let start = Instant::now();
        let mut tint = Tint::default();
        tint.aim(true, start, false);
        let left = after(start, 42.0);
        tint.aim(false, left, false);
        assert!(near(tint.level(left), 0.5), "no jump when the pointer leaves");
        assert!(tint.moving(after(left, 59.0)));
        assert!(!tint.moving(after(left, 60.5)), "half the way out takes half the duration back");
        assert!(near(tint.level(after(left, 60.5)), 0.0));
    }

    #[test]
    fn a_shrunk_glyph_keeps_its_colour_and_averages_its_coverage() {
        let (ink, empty) = ([245, 245, 245, 230], [0, 0, 0, 0]);
        let fine: Vec<u8> = [ink, empty, ink, ink, empty, empty, ink, ink].concat();
        assert_eq!(shrink(&fine, 4, 2), [245, 245, 245, 58, 245, 245, 245, 230]);
    }

    #[test]
    fn reduced_motion_arrives_at_once() {
        let start = Instant::now();
        let mut tint = Tint::default();
        tint.aim(true, start, true);
        assert!(near(tint.level(start), 1.0));
        assert!(!tint.moving(start));
    }

    #[test]
    fn a_control_keeps_its_tint_while_what_it_opened_is_open() {
        let start = Instant::now();
        let mut tints = Tints::default();
        tints.hover(Corner::Search, true, start, false);
        let settled = start + DURATION;
        assert!(near(tints.settle(Corner::Search, true, settled, false).0, 1.0));
        tints.hover(Corner::Search, false, settled, false);
        let later = settled + DURATION;
        assert_eq!(tints.settle(Corner::Search, true, later, false), (1.0, false));
        let (level, moving) = tints.settle(Corner::Search, false, later, false);
        assert!(near(level, 1.0) && moving, "closing it starts the way back");
    }
}
