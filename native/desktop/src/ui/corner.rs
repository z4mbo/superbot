use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use gpui_kit::*;

use crate::app::Desktop;
use crate::theme::Theme;
use crate::ui::motion::Colors;
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum Corner {
    Search,
    New,
    Plugins,
}

impl Corner {
    fn id(self) -> &'static str {
        match self {
            Self::Search => "search-toggle",
            Self::New => "new-agent",
            Self::Plugins => "open-store",
        }
    }

    fn glyph(self) -> (&'static str, Pixels) {
        match self {
            Self::Search => ("icons/corner-search.svg", px(16.)),
            Self::New => ("icons/corner-plus.svg", px(20.)),
            Self::Plugins => ("icons/apps.svg", px(16.)),
        }
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
            .bg(Colors::elevated(theme).sample(level))
            .border_1()
            .border_color(theme.ink_at(0.06))
            .cursor_pointer()
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, _, _, cx| {
                    this.tints.press(corner, true, Instant::now(), cx.reduce_motion());
                    cx.notify();
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(move |this, _, _, cx| {
                    if this.tints.press(corner, false, Instant::now(), cx.reduce_motion()) {
                        cx.notify();
                    }
                }),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(move |this, _, _, cx| {
                    if this.tints.press(corner, false, Instant::now(), cx.reduce_motion()) {
                        cx.notify();
                    }
                }),
            )
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                this.tints.hover(corner, *hovered, Instant::now(), cx.reduce_motion());
                cx.notify();
            }))
            .child(glyph(path, size, theme.ink_at(0.9), window, cx))
    }
}

#[cfg(test)]
mod tests {
    use super::{shrink, Corner};
    use crate::ui::motion::{Tint, Tints, HOVER, STANDARD};
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
            assert!(near(STANDARD.sample(x), y), "ease({x}) = {} instead of {y}", STANDARD.sample(x));
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
        assert!(near(tint.level(start + HOVER), 1.0));
        assert!(!tint.moving(start + HOVER));
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
        let settled = start + HOVER;
        assert!(near(tints.settle(Corner::Search, true, settled, false).0.hover, 1.0));
        tints.hover(Corner::Search, false, settled, false);
        let later = settled + HOVER;
        let (levels, moving) = tints.settle(Corner::Search, true, later, false);
        assert!(near(levels.hover, 1.0) && !moving);
        let (level, moving) = tints.settle(Corner::Search, false, later, false);
        assert!(near(level.hover, 1.0) && moving, "closing it starts the way back");
    }
}
