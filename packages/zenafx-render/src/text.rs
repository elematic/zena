//! `zenafx:host/text`: shaped runs, kept by id.
//!
//! Text is registered, not passed per frame. `register_run` shapes a string
//! under a style and returns an id; the id stands for that run through
//! measurement, painting and hit testing until `release_run`. A glyph run in
//! a display list is then an id and a position, not a string and a font.
//!
//! The engine is [`parley`], which brings `fontique` for font enumeration,
//! `harfrust` for shaping and `skrifa` for outlines.

use parley::fontique::Blob;
use parley::{
    Affinity, Alignment, AlignmentOptions, BoundingBox, Cursor, FontContext, FontFamily, FontStyle,
    FontWeight, GenericFamily, Layout, LayoutContext, LineHeight, Selection, StyleProperty,
};

use super::types::{Color, Flow, Measured, Rect, TextAlign, TextStyle};

/// One stretch of a run's content, in one style.
struct Part {
    /// Where the stretch starts in the run's content, in UTF-8 bytes. It ends
    /// where the next one starts.
    start: usize,
    style: TextStyle,
}

/// A registered run: the source text, the styles it was shaped under, and
/// the parley layout, broken at whatever width it was last measured or
/// painted at.
///
/// A run has one part for a text node by itself, and one for each text node
/// of a flow container, whose texts are joined and laid out as one.
pub struct Run {
    content: String,
    /// At least one, in the order of the content.
    parts: Vec<Part>,
    flow: Flow,
    /// Each glyph is marked with the part it belongs to, which is how the
    /// painter knows its colour.
    layout: Layout<u32>,
    /// The `max_advance` the layout currently reflects. `None` means it was
    /// broken unconstrained.
    broken_at: Option<f32>,
}

impl Run {
    pub fn content(&self) -> &str {
        &self.content
    }

    /// The style of the run's first part, which is its only one for a text
    /// node by itself.
    pub fn style(&self) -> &TextStyle {
        &self.parts[0].style
    }

    /// The colour of the glyphs marked with `part`.
    pub fn color_of(&self, part: u32) -> Color {
        let part = (part as usize).min(self.parts.len() - 1);
        self.parts[part].style.color
    }

    pub fn layout(&self) -> &Layout<u32> {
        &self.layout
    }
}

/// The run table and the font database behind it.
///
/// One of these is shared by the whole process: `FontContext` owns the font
/// collection, and building it is the expensive part.
pub struct TextEngine {
    font_cx: FontContext,
    layout_cx: LayoutContext<u32>,
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

    /// Create a text engine pre-loaded with a bundled font.
    pub fn with_font(bytes: Vec<u8>) -> Self {
        let mut engine = Self::new();
        engine.register_font(bytes);
        engine
    }

    /// Register raw TTF/OTF font bytes with the font collection and wire its
    /// families into the CSS generic fallback families (`system-ui`,
    /// `sans-serif`, `serif`, `monospace`).
    ///
    /// Needed on platforms without OS font discovery (such as `wasm32`), and
    /// useful anywhere an application wants deterministic font metrics.
    /// Returns the number of font faces registered.
    pub fn register_font(&mut self, bytes: Vec<u8>) -> usize {
        let registered = self
            .font_cx
            .collection
            .register_fonts(Blob::from(bytes), None);
        let faces: usize = registered.iter().map(|(_, fonts)| fonts.len()).sum();
        let families: Vec<_> = registered.iter().map(|(id, _)| *id).collect();
        if !families.is_empty() {
            for generic in [
                GenericFamily::SystemUi,
                GenericFamily::SansSerif,
                GenericFamily::UiSansSerif,
                GenericFamily::Serif,
                GenericFamily::Monospace,
            ] {
                self.font_cx
                    .collection
                    .append_generic_families(generic, families.iter().copied());
            }
            // Reshape any runs that were registered before fonts arrived.
            for slot in self.runs.iter_mut().flatten() {
                slot.layout = shape(
                    &mut self.font_cx,
                    &mut self.layout_cx,
                    &slot.content,
                    &slot.parts,
                    &slot.flow,
                    self.scale,
                );
                slot.broken_at = Some(f32::NAN);
            }
        }
        faces
    }

    /// Set the scale factor new and re-shaped runs are built at. Existing
    /// runs are reshaped lazily, the next time they are measured.
    pub fn set_scale(&mut self, scale: f32) {
        if scale != self.scale {
            self.scale = scale;
            for slot in self.runs.iter_mut().flatten() {
                slot.layout = shape(
                    &mut self.font_cx,
                    &mut self.layout_cx,
                    &slot.content,
                    &slot.parts,
                    &slot.flow,
                    scale,
                );
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
        self.register_parts(&[(content, style)], &Flow::default())
    }

    /// Shape several texts as one, each in its own style, and keep the
    /// result: the texts of a flow container, in the order they are read.
    /// `parts` has at least one text. The id is valid until
    /// [`TextEngine::release_run`].
    ///
    /// The texts are joined with nothing between them. Lines are broken
    /// across the whole, so a part can start on one line and end on the
    /// next, and a word that is half in one part and half in another is one
    /// word.
    pub fn register_parts(&mut self, parts: &[(&str, &TextStyle)], flow: &Flow) -> u32 {
        let run = self.shaped(parts, flow);
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
        self.update_parts(id, &[(content, style)], &Flow::default());
    }

    /// Reshape a run of several texts in place, keeping its id.
    pub fn update_parts(&mut self, id: u32, parts: &[(&str, &TextStyle)], flow: &Flow) {
        let run = self.shaped(parts, flow);
        if let Some(slot) = self.runs.get_mut(id as usize).and_then(Option::as_mut) {
            *slot = run;
        }
    }

    /// Join `parts` and shape them. The result is not yet broken into lines.
    fn shaped(&mut self, parts: &[(&str, &TextStyle)], flow: &Flow) -> Run {
        let mut content = String::new();
        let mut starts = Vec::with_capacity(parts.len().max(1));
        for (text, style) in parts {
            starts.push(Part {
                start: content.len(),
                style: (*style).clone(),
            });
            content.push_str(text);
        }
        if starts.is_empty() {
            starts.push(Part {
                start: 0,
                style: TextStyle::default(),
            });
        }
        let layout = shape(
            &mut self.font_cx,
            &mut self.layout_cx,
            &content,
            &starts,
            flow,
            self.scale,
        );
        Run {
            content,
            parts: starts,
            flow: *flow,
            layout,
            // No break has been applied yet; NaN never equals a requested
            // width, so the first measure always breaks.
            broken_at: Some(f32::NAN),
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

    /// The place in `id`'s content nearest a point, in UTF-8 bytes from the
    /// start. The point is measured from the run's top left corner, and the
    /// run is as it was last broken into lines.
    ///
    /// The answer is always between two characters as a reader sees them. A
    /// point before the text gives 0 and one past it the content's length,
    /// so a pointer dragged out of a text field still says where its
    /// selection ends.
    pub fn index_at(&self, id: u32, x: f32, y: f32) -> u32 {
        match self.get(id) {
            Some(run) => Cursor::from_point(&run.layout, x, y).index() as u32,
            None => 0,
        }
    }

    /// The two ends of the word at `index`, a place in `id`'s content in
    /// UTF-8 bytes: what a second press there selects. Between two words it
    /// is the white space between them.
    pub fn word_at(&self, id: u32, index: u32) -> (u32, u32) {
        let Some(run) = self.get(id) else {
            return (0, 0);
        };
        // Parley finds a word from a point, so ask at the middle of the
        // caret the index has.
        let caret = cursor(&run.layout, index).geometry(&run.layout, 0.0);
        let (x, y) = (caret.x0 as f32 + 0.5, ((caret.y0 + caret.y1) / 2.0) as f32);
        let range = Selection::word_from_point(&run.layout, x, y).text_range();
        (range.start as u32, range.end as u32)
    }

    /// Where to draw a caret `width` wide at `index`, a place in `id`'s
    /// content in UTF-8 bytes. Measured from the run's top left corner.
    ///
    /// An index inside a character, or past the end, is moved to the nearest
    /// place a caret can be. A run with no content has a caret too, at its
    /// start and one line high.
    pub fn caret(&self, id: u32, index: u32, width: f32) -> Option<Rect> {
        let run = self.get(id)?;
        let at = cursor(&run.layout, index);
        Some(rect_of(at.geometry(&run.layout, width)))
    }

    /// The boxes that cover `id`'s content between two places, one for each
    /// line the selection touches. Empty when the two are the same place.
    pub fn selection(&self, id: u32, anchor: u32, focus: u32) -> Vec<Rect> {
        let Some(run) = self.get(id) else {
            return Vec::new();
        };
        let (anchor, focus) = (cursor(&run.layout, anchor), cursor(&run.layout, focus));
        if anchor.index() == focus.index() {
            return Vec::new();
        }
        Selection::new(anchor, focus)
            .geometry(&run.layout)
            .into_iter()
            .map(|(bounds, _line)| rect_of(bounds))
            .collect()
    }
}

/// A place a caret can be, at or next to a UTF-8 offset.
fn cursor(layout: &Layout<u32>, index: u32) -> Cursor {
    Cursor::from_byte_index(layout, index as usize, Affinity::Downstream)
}

fn rect_of(bounds: BoundingBox) -> Rect {
    Rect {
        x: bounds.x0 as f32,
        y: bounds.y0 as f32,
        width: (bounds.x1 - bounds.x0) as f32,
        height: (bounds.y1 - bounds.y0) as f32,
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
    let align = match run.flow.align {
        TextAlign::Start => Alignment::Start,
        TextAlign::Center => Alignment::Center,
        TextAlign::End => Alignment::End,
        TextAlign::Justify => Alignment::Justify,
    };
    run.layout.align(align, AlignmentOptions::default());
    run.broken_at = available_width;
}

fn measured_of(layout: &Layout<u32>) -> Measured {
    Measured {
        width: layout.width(),
        height: layout.height(),
        baseline: layout.get(0).map(|line| line.metrics().baseline).unwrap_or(0.0),
    }
}

/// Build a parley layout for one run, each part in its own style. The result
/// is unbroken; a caller breaks it at the width it cares about.
fn shape(
    font_cx: &mut FontContext,
    layout_cx: &mut LayoutContext<u32>,
    content: &str,
    parts: &[Part],
    flow: &Flow,
    scale: f32,
) -> Layout<u32> {
    let mut builder = layout_cx.ranged_builder(font_cx, content, scale, true);
    if let Some(height) = flow.line_height {
        builder.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(
            height,
        )));
    }
    for (index, part) in parts.iter().enumerate() {
        let end = parts
            .get(index + 1)
            .map_or(content.len(), |next| next.start);
        let range = part.start..end;
        let style = &part.style;
        builder.push(StyleProperty::Brush(index as u32), range.clone());
        builder.push(
            StyleProperty::FontFamily(font_family(&style.family)),
            range.clone(),
        );
        builder.push(StyleProperty::FontSize(style.size), range.clone());
        builder.push(
            StyleProperty::FontWeight(FontWeight::new(style.weight as f32)),
            range.clone(),
        );
        if style.italic {
            builder.push(StyleProperty::FontStyle(FontStyle::Italic), range);
        }
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

    /// One line of text, measured, which is how a run is when a frame draws
    /// it.
    fn a_line(text: &mut TextEngine, content: &str) -> (u32, Measured) {
        let id = text.register_run(content, &TextStyle::default());
        let measured = text.measure_run(id, None);
        (id, measured)
    }

    /// A caret moves right as its index grows, stands as tall as the line,
    /// and sits at the two ends of the run for the first and last index.
    #[test]
    fn a_caret_is_where_its_index_is() {
        let mut text = TextEngine::new();
        let (id, line) = a_line(&mut text, "caret");
        let at = |index| text.caret(id, index, 2.0).expect("a run");

        let lefts: Vec<f32> = (0..=5).map(|index| at(index).x).collect();
        assert!(lefts.windows(2).all(|pair| pair[0] < pair[1]), "{lefts:?}");
        assert!(lefts[0].abs() <= 2.0, "{lefts:?}");
        assert!(
            (lefts[5] - line.width).abs() <= 2.0,
            "{lefts:?} in {line:?}"
        );
        assert_eq!(at(2).width, 2.0);
        // The caret covers the line and a pixel or so above and below it.
        assert!((at(2).height - line.height).abs() <= 3.0, "{:?}", at(2));
    }

    /// A point gives the index nearest it: the left half of a letter the
    /// index before the letter, the right half the one after. A point outside
    /// the run gives its nearer end.
    #[test]
    fn a_point_is_nearest_one_index() {
        let mut text = TextEngine::new();
        let (id, line) = a_line(&mut text, "point");
        let middle = line.height / 2.0;
        let edge = |index| text.caret(id, index, 0.0).expect("a run").x;
        let (second, third) = (edge(1), edge(2));
        let quarter = (third - second) / 4.0;

        assert_eq!(text.index_at(id, second + quarter, middle), 1);
        assert_eq!(text.index_at(id, third - quarter, middle), 2);
        assert_eq!(text.index_at(id, -50.0, middle), 0);
        assert_eq!(text.index_at(id, line.width + 50.0, middle), 5);
        assert_eq!(text.index_at(id, line.width + 50.0, -50.0), 5, "above");
    }

    /// Indexes count UTF-8 bytes, and never fall inside a character: `é` is
    /// two bytes and one place to step over.
    #[test]
    fn an_index_counts_bytes_and_keeps_out_of_characters() {
        let mut text = TextEngine::new();
        let (id, line) = a_line(&mut text, "né");
        let at = |index| text.caret(id, index, 0.0).expect("a run").x;

        assert!((at(3) - line.width).abs() <= 1.0, "after the é");
        assert!(
            at(2) == at(1) || at(2) == at(3),
            "an index inside the é is moved to one of its edges"
        );
        assert_eq!(text.index_at(id, line.width + 50.0, 5.0), 3);
    }

    /// A selection covers the text between its two places whichever way
    /// round they are, and nothing when they are the same.
    #[test]
    fn a_selection_covers_what_is_between_its_ends() {
        let mut text = TextEngine::new();
        let (id, _) = a_line(&mut text, "select");
        let edge = |index| text.caret(id, index, 0.0).expect("a run").x;

        let forwards = text.selection(id, 1, 4);
        assert_eq!(forwards.len(), 1, "one line");
        assert!((forwards[0].x - edge(1)).abs() < 0.5, "{forwards:?}");
        assert!((forwards[0].x + forwards[0].width - edge(4)).abs() < 0.5);
        assert_eq!(text.selection(id, 4, 1), forwards, "made backwards");
        assert!(text.selection(id, 3, 3).is_empty());
    }

    /// A run with no content is still a line: it has a height for the box
    /// round it, and a caret at its start. An empty text field depends on
    /// both.
    #[test]
    fn an_empty_run_is_one_line_with_a_caret() {
        let mut text = TextEngine::new();
        let (empty, measured) = a_line(&mut text, "");
        let (_, full) = a_line(&mut text, "x");

        assert_eq!(measured.width, 0.0);
        assert!((measured.height - full.height).abs() < 1.0, "{measured:?}");
        let caret = text.caret(empty, 0, 2.0).expect("a run");
        assert!((caret.height - full.height).abs() <= 3.0, "{caret:?}");
        assert_eq!(text.index_at(empty, 40.0, 5.0), 0);
    }

    /// Several texts shaped as one are one run. Its content is the texts
    /// joined, a part in a larger size makes it wider than the same words in
    /// one size, and its lines break across the parts.
    #[test]
    fn parts_are_shaped_and_broken_as_one() {
        let mut text = TextEngine::new();
        let plain = TextStyle::default();
        let large = TextStyle {
            size: plain.size * 1.5,
            ..TextStyle::default()
        };
        let parts = [
            ("The quick ", &plain),
            ("brown fox jumps", &large),
            (" over the lazy dog", &plain),
        ];
        let flow = Flow::default();

        let id = text.register_parts(&parts, &flow);
        let same_words = text.register_run("The quick brown fox jumps over the lazy dog", &plain);

        let run = text.get(id).expect("a run");
        assert_eq!(run.content(), "The quick brown fox jumps over the lazy dog");
        let (one, other) = (
            text.measure_run(id, None),
            text.measure_run(same_words, None),
        );
        assert!(one.width > other.width, "{one:?} against {other:?}");
        let narrow = text.measure_run(id, Some(one.width / 3.0));
        assert!(narrow.height > one.height * 2.0, "{narrow:?}");
    }

    /// A centred flow starts a short line in from the edge of the width it
    /// was broken at, and one that starts at the start does not.
    #[test]
    fn a_centred_run_starts_its_line_in_from_the_edge() {
        let mut text = TextEngine::new();
        let style = TextStyle::default();
        let centred = Flow {
            align: TextAlign::Center,
            ..Flow::default()
        };
        let at_start = text.register_parts(&[("short", &style)], &Flow::default());
        let in_middle = text.register_parts(&[("short", &style)], &centred);
        let width = text.measure_run(at_start, None).width;
        text.measure_run(at_start, Some(400.0));
        text.measure_run(in_middle, Some(400.0));

        let start = |id| text.caret(id, 0, 0.0).expect("a run").x;
        assert_eq!(start(at_start), 0.0);
        assert!((start(in_middle) - (400.0 - width) / 2.0).abs() < 1.0);
    }

    /// A line height is a multiple of the text size, so twice the size's
    /// worth makes a line about that tall.
    #[test]
    fn a_line_height_sets_how_far_apart_lines_are() {
        let mut text = TextEngine::new();
        let style = TextStyle {
            size: 20.0,
            ..TextStyle::default()
        };
        let tall = Flow {
            line_height: Some(2.0),
            ..Flow::default()
        };
        let id = text.register_parts(&[("one line", &style)], &tall);

        let measured = text.measure_run(id, None);
        assert!((measured.height - 40.0).abs() < 1.0, "{measured:?}");
    }
}
