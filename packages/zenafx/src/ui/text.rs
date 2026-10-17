//! `zenafx:host/text`: shaped runs, kept by id.
//!
//! Text is registered, not passed per frame. `register_run` shapes a string
//! under a style and returns an id; the id stands for that run through
//! measurement, painting and hit testing until `release_run`. A glyph run in
//! a display list is then an id and a position, not a string and a font.
//!
//! The engine is [`parley`], which brings `fontique` for font enumeration,
//! `harfrust` for shaping and `skrifa` for outlines.

use parley::{
    Alignment, AlignmentOptions, FontContext, FontFamily, FontStyle, FontWeight, GenericFamily,
    Layout, LayoutContext, StyleProperty,
};

use super::types::{Measured, TextStyle};

/// A registered run: the source text, the style it was shaped under, and the
/// parley layout, broken at whatever width it was last measured or painted
/// at.
pub struct Run {
    content: String,
    style: TextStyle,
    layout: Layout<()>,
    /// The `max_advance` the layout currently reflects. `None` means it was
    /// broken unconstrained.
    broken_at: Option<f32>,
}

impl Run {
    pub fn content(&self) -> &str {
        &self.content
    }

    pub fn style(&self) -> &TextStyle {
        &self.style
    }

    pub fn layout(&self) -> &Layout<()> {
        &self.layout
    }
}

/// The run table and the font database behind it.
///
/// One of these is shared by the whole process: `FontContext` owns the font
/// collection, and building it is the expensive part.
pub struct TextEngine {
    font_cx: FontContext,
    layout_cx: LayoutContext<()>,
    /// Slot `i` holds run id `i as u32`. Released slots hold `None` and are
    /// reused, so ids stay small and dense.
    runs: Vec<Option<Run>>,
    free: Vec<u32>,
    /// Physical pixels per logical pixel, applied when shaping.
    scale: f32,
}

impl Default for TextEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl TextEngine {
    pub fn new() -> Self {
        Self {
            font_cx: FontContext::new(),
            layout_cx: LayoutContext::new(),
            runs: Vec::new(),
            free: Vec::new(),
            scale: 1.0,
        }
    }

    /// Set the scale factor new and re-shaped runs are built at. Existing
    /// runs are reshaped lazily, the next time they are measured.
    pub fn set_scale(&mut self, scale: f32) {
        if scale != self.scale {
            self.scale = scale;
            for slot in self.runs.iter_mut().flatten() {
                slot.layout =
                    shape(&mut self.font_cx, &mut self.layout_cx, &slot.content, &slot.style, scale);
                slot.broken_at = Some(f32::NAN);
            }
        }
    }

    pub fn scale(&self) -> f32 {
        self.scale
    }

    /// Shape `content` under `style` and keep it. The id is valid until
    /// [`TextEngine::release_run`].
    pub fn register_run(&mut self, content: &str, style: &TextStyle) -> u32 {
        let run = Run {
            content: content.to_owned(),
            style: style.clone(),
            layout: shape(
                &mut self.font_cx,
                &mut self.layout_cx,
                content,
                style,
                self.scale,
            ),
            // No break has been applied yet; NaN never equals a requested
            // width, so the first measure always breaks.
            broken_at: Some(f32::NAN),
        };
        match self.free.pop() {
            Some(id) => {
                self.runs[id as usize] = Some(run);
                id
            }
            None => {
                self.runs.push(Some(run));
                (self.runs.len() - 1) as u32
            }
        }
    }

    /// Reshape a run in place, keeping its id.
    pub fn update_run(&mut self, id: u32, content: &str, style: &TextStyle) {
        let layout = shape(
            &mut self.font_cx,
            &mut self.layout_cx,
            content,
            style,
            self.scale,
        );
        if let Some(slot) = self.runs.get_mut(id as usize).and_then(Option::as_mut) {
            slot.content = content.to_owned();
            slot.style = style.clone();
            slot.layout = layout;
            slot.broken_at = Some(f32::NAN);
        }
    }

    pub fn release_run(&mut self, id: u32) {
        if let Some(slot) = self.runs.get_mut(id as usize) {
            if slot.take().is_some() {
                self.free.push(id);
            }
        }
    }

    pub fn get(&self, id: u32) -> Option<&Run> {
        self.runs.get(id as usize).and_then(Option::as_ref)
    }

    /// Break `id` at `available_width` and report what it occupies. `None`
    /// asks for the unconstrained size.
    ///
    /// This is the call taffy's measure closure makes mid-solve, so it has to
    /// be cheap when the width has not moved: re-breaking is skipped when the
    /// layout already reflects the requested width.
    pub fn measure_run(&mut self, id: u32, available_width: Option<f32>) -> Measured {
        let Some(run) = self.runs.get_mut(id as usize).and_then(Option::as_mut) else {
            return Measured {
                width: 0.0,
                height: 0.0,
                baseline: 0.0,
            };
        };
        break_at(run, available_width);
        measured_of(&run.layout)
    }

    /// The width `id`'s layout is currently broken at, or `None` if it is
    /// unconstrained. This is what the layout pass last asked for.
    pub fn broken_at(&self, id: u32) -> Option<f32> {
        self.get(id).and_then(|r| r.broken_at)
    }

    /// The narrowest and widest this run can be: the width with every soft
    /// break taken, and with none taken.
    ///
    /// A solve asks for these when a box shrinks to fit, because the box's
    /// own width is then whatever the content settles on.
    pub fn content_widths(&self, id: u32) -> Option<(f32, f32)> {
        self.get(id).map(|r| {
            let w = r.layout.calculate_content_widths();
            (w.min, w.max)
        })
    }
}

/// Re-break `run` if it does not already reflect `available_width`.
fn break_at(run: &mut Run, available_width: Option<f32>) {
    let same = match (run.broken_at, available_width) {
        (Some(a), Some(b)) => a == b,
        (None, None) => true,
        _ => false,
    };
    if same {
        return;
    }
    run.layout.break_all_lines(available_width);
    run.layout.align(Alignment::Start, AlignmentOptions::default());
    run.broken_at = available_width;
}

fn measured_of(layout: &Layout<()>) -> Measured {
    Measured {
        width: layout.width(),
        height: layout.height(),
        baseline: layout.get(0).map(|line| line.metrics().baseline).unwrap_or(0.0),
    }
}

/// Build a parley layout for one run. The result is unbroken; a caller
/// breaks it at the width it cares about.
fn shape(
    font_cx: &mut FontContext,
    layout_cx: &mut LayoutContext<()>,
    content: &str,
    style: &TextStyle,
    scale: f32,
) -> Layout<()> {
    let mut builder = layout_cx.ranged_builder(font_cx, content, scale, true);
    builder.push_default(StyleProperty::FontFamily(font_family(&style.family)));
    builder.push_default(StyleProperty::FontSize(style.size));
    builder.push_default(StyleProperty::FontWeight(FontWeight::new(
        style.weight as f32,
    )));
    if style.italic {
        builder.push_default(StyleProperty::FontStyle(FontStyle::Italic));
    }
    builder.build(content)
}

/// Resolve a family name, mapping the CSS generic names a stylesheet is
/// likely to use onto fontique's generics so they hit the system defaults.
/// Anything else is taken as the name of an installed family.
fn font_family(family: &str) -> FontFamily<'_> {
    let generic = match family {
        "system-ui" => Some(GenericFamily::SystemUi),
        "serif" => Some(GenericFamily::Serif),
        "sans-serif" => Some(GenericFamily::SansSerif),
        "monospace" => Some(GenericFamily::Monospace),
        "cursive" => Some(GenericFamily::Cursive),
        "fantasy" => Some(GenericFamily::Fantasy),
        _ => None,
    };
    match generic {
        Some(g) => FontFamily::from(g),
        None => FontFamily::named(family),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_registered_run_measures_wider_than_tall() {
        let mut text = TextEngine::new();
        let id = text.register_run("Hello, world", &TextStyle::default());
        let m = text.measure_run(id, None);
        assert!(m.width > 0.0, "width was {}", m.width);
        assert!(m.height > 0.0, "height was {}", m.height);
        assert!(
            m.width > m.height,
            "one unwrapped line should be wider than tall, got {m:?}"
        );
        assert!(m.baseline > 0.0 && m.baseline <= m.height, "baseline {m:?}");
    }

    /// The reason measurement lives inside the solve: the same string is one
    /// line at its natural width and several at a fraction of it.
    #[test]
    fn a_narrow_width_wraps_and_grows_taller() {
        let mut text = TextEngine::new();
        let id = text.register_run(
            "The quick brown fox jumps over the lazy dog",
            &TextStyle::default(),
        );
        let wide = text.measure_run(id, None);
        let narrow = text.measure_run(id, Some(wide.width / 4.0));
        assert!(narrow.height > wide.height, "wide {wide:?} narrow {narrow:?}");
        assert!(narrow.width <= wide.width, "wide {wide:?} narrow {narrow:?}");
    }

    #[test]
    fn measuring_back_at_the_old_width_restores_the_old_size() {
        let mut text = TextEngine::new();
        let id = text.register_run("The quick brown fox jumps over", &TextStyle::default());
        let wide = text.measure_run(id, None);
        text.measure_run(id, Some(wide.width / 3.0));
        assert_eq!(text.measure_run(id, None), wide);
    }

    /// The two intrinsic widths a shrink-to-fit box chooses between: the
    /// longest word, and the whole string unwrapped.
    #[test]
    fn min_content_is_narrower_than_max_content() {
        let mut text = TextEngine::new();
        let id = text.register_run(
            "The quick brown fox jumps over the lazy dog",
            &TextStyle::default(),
        );
        let (min, max) = text.content_widths(id).expect("a registered run");
        assert!(min > 0.0 && min < max, "min {min} max {max}");

        // max-content is the unconstrained measurement.
        let unconstrained = text.measure_run(id, None);
        assert!(
            (unconstrained.width - max).abs() < 1.0,
            "unconstrained {unconstrained:?} vs max {max}"
        );

        // At min-content the text wraps as hard as it can, so it is tallest.
        let narrow = text.measure_run(id, Some(min));
        assert!(narrow.height > unconstrained.height, "{narrow:?}");
    }

    #[test]
    fn a_released_id_is_reused() {
        let mut text = TextEngine::new();
        let a = text.register_run("a", &TextStyle::default());
        text.release_run(a);
        assert!(text.get(a).is_none());
        assert_eq!(text.register_run("b", &TextStyle::default()), a);
        assert_eq!(text.get(a).map(Run::content), Some("b"));
    }

    #[test]
    fn update_keeps_the_id_and_changes_the_size() {
        let mut text = TextEngine::new();
        let id = text.register_run("x", &TextStyle::default());
        let short = text.measure_run(id, None);
        text.update_run(id, "xxxxxxxxxxxxxxxx", &TextStyle::default());
        let long = text.measure_run(id, None);
        assert!(long.width > short.width, "short {short:?} long {long:?}");
    }

    #[test]
    fn a_bigger_size_measures_bigger() {
        let mut text = TextEngine::new();
        let small = TextStyle {
            size: 12.0,
            ..TextStyle::default()
        };
        let large = TextStyle {
            size: 48.0,
            ..TextStyle::default()
        };
        let a = text.register_run("Hello", &small);
        let b = text.register_run("Hello", &large);
        let (a, b) = (text.measure_run(a, None), text.measure_run(b, None));
        assert!(b.width > a.width && b.height > a.height, "{a:?} vs {b:?}");
    }
}
