//! `zenafx:host/paint`: rasterize a display list with [`vello_cpu`].
//!
//! The commands are rounded quads, glyph runs, and clip push/pop. Clips are
//! what enforce the compositor's part of the capability model: the runtime
//! emits one for each component's bounds, and the rasterizer discards
//! anything outside it. "Paint" in `docs/design/zenafx-ui.md`.

use vello_cpu::color::{AlphaColor, PremulRgba8, Srgb};
use vello_cpu::kurbo::{Affine, BezPath, Rect as KRect, RoundedRect, Shape, Stroke};
use vello_cpu::{Pixmap, RenderContext, Resources};

use super::text::TextEngine;
use super::types::{Color, Command, Rect};

/// A CPU rasterizer sized to one surface.
pub struct Painter {
    ctx: RenderContext,
    resources: Resources,
    pixmap: Pixmap,
    width: u16,
    height: u16,
}

impl Painter {
    pub fn new(width: u16, height: u16) -> Self {
        let (width, height) = (width.max(1), height.max(1));
        Self {
            ctx: RenderContext::new(width, height),
            resources: Resources::new(),
            pixmap: Pixmap::new(width, height),
            width,
            height,
        }
    }

    pub fn size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    pub fn resize(&mut self, width: u16, height: u16) {
        let (width, height) = (width.max(1), height.max(1));
        if (width, height) == (self.width, self.height) {
            return;
        }
        self.ctx.reset_and_resize(width, height);
        self.pixmap = Pixmap::new(width, height);
        self.width = width;
        self.height = height;
    }

    /// Draw `commands` over `background` and rasterize. The result is
    /// readable through [`Painter::pixels`] until the next call.
    pub fn draw(&mut self, commands: &[Command], background: Color, text: &TextEngine) {
        self.ctx.reset();
        self.ctx.set_paint(alpha(background));
        self.ctx.fill_rect(&KRect::new(
            0.0,
            0.0,
            self.width as f64,
            self.height as f64,
        ));

        // A component may leave clips unbalanced; the rasterizer must not be
        // left holding them, so they are counted and popped at the end.
        let mut clips = 0usize;
        for command in commands {
            match command {
                Command::Quad(q) => {
                    let path = quad_path(&q.bounds, q.corner_radius);
                    if let Some(fill) = q.background {
                        self.ctx.set_paint(alpha(fill));
                        self.ctx.fill_path(&path);
                    }
                    if let (Some(stroke), true) = (q.border_color, q.border_width > 0.0) {
                        // CSS draws a border inside the box, so the stroke is
                        // centred half a width in from the edge.
                        let inset = inset_rect(&q.bounds, q.border_width / 2.0);
                        let path = quad_path(
                            &inset,
                            (q.corner_radius - q.border_width / 2.0).max(0.0),
                        );
                        self.ctx.set_paint(alpha(stroke));
                        self.ctx.set_stroke(Stroke::new(q.border_width as f64));
                        self.ctx.stroke_path(&path);
                    }
                }
                Command::Glyphs(g) => {
                    self.draw_glyphs(g.run, g.x, g.y, text);
                }
                Command::PushClip(r) => {
                    self.ctx.push_clip_path(&quad_path(r, 0.0));
                    clips += 1;
                }
                Command::PopClip => {
                    if clips > 0 {
                        self.ctx.pop_clip_path();
                        clips -= 1;
                    }
                }
            }
        }
        for _ in 0..clips {
            self.ctx.pop_clip_path();
        }

        self.ctx.set_transform(Affine::IDENTITY);
        self.ctx.flush();
        self.ctx.render(&mut self.pixmap, &mut self.resources);
    }

    /// Paint one registered run with its top-left at `(x, y)`.
    ///
    /// The run is painted exactly as it stands: broken at the width the
    /// layout pass settled on, because that is the break `solve` measured and
    /// placed the box for. Re-breaking here at any other width would paint
    /// text that does not match its own bounds.
    fn draw_glyphs(&mut self, run: u32, x: f32, y: f32, text: &TextEngine) {
        let Some(registered) = text.get(run) else {
            return;
        };
        self.ctx
            .set_transform(Affine::translate((x as f64, y as f64)));
        self.ctx.set_paint(alpha(registered.look().color));

        for line in registered.layout().lines() {
            for item in line.items() {
                let parley::PositionedLayoutItem::GlyphRun(glyph_run) = item else {
                    continue;
                };
                let parley_run = glyph_run.run();
                let font = parley_run.font().clone();
                let size = parley_run.font_size();
                let coords = parley_run.normalized_coords();
                self.ctx
                    .glyph_run(&mut self.resources, &font)
                    .font_size(size)
                    .normalized_coords(coords)
                    .hint(true)
                    .fill_glyphs(glyph_run.positioned_glyphs().map(|g| vello_cpu::Glyph {
                        id: g.id,
                        x: g.x,
                        y: g.y,
                    }));
            }
        }
        self.ctx.set_transform(Affine::IDENTITY);
    }

    /// The rasterized frame, premultiplied sRGB, row-major.
    pub fn pixels(&self) -> &[PremulRgba8] {
        self.pixmap.data()
    }

    /// Copy the frame into a `softbuffer` buffer, which wants `0RGB` in a
    /// `u32` per pixel.
    pub fn blit_to(&self, out: &mut [u32]) {
        for (dst, src) in out.iter_mut().zip(self.pixels()) {
            *dst = ((src.r as u32) << 16) | ((src.g as u32) << 8) | src.b as u32;
        }
    }
}

fn alpha(c: Color) -> AlphaColor<Srgb> {
    AlphaColor::new([c.r, c.g, c.b, c.a])
}

fn inset_rect(r: &Rect, by: f32) -> Rect {
    Rect {
        x: r.x + by,
        y: r.y + by,
        width: (r.width - by * 2.0).max(0.0),
        height: (r.height - by * 2.0).max(0.0),
    }
}

fn quad_path(r: &Rect, corner_radius: f32) -> BezPath {
    let (x0, y0) = (r.x as f64, r.y as f64);
    let (x1, y1) = (x0 + r.width as f64, y0 + r.height as f64);
    if corner_radius > 0.0 {
        // The radius cannot exceed half the shorter side, or the corners
        // cross over.
        let max = (r.width.min(r.height) / 2.0) as f64;
        RoundedRect::new(x0, y0, x1, y1, (corner_radius as f64).min(max)).to_path(0.1)
    } else {
        KRect::new(x0, y0, x1, y1).to_path(0.1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::types::{Glyphs, Quad, TextLook};

    const WHITE: Color = Color::rgb(1.0, 1.0, 1.0);

    fn at(p: &Painter, x: u16, y: u16) -> PremulRgba8 {
        p.pixels()[y as usize * p.size().0 as usize + x as usize]
    }

    fn quad(bounds: Rect, background: Color) -> Command {
        Command::Quad(Quad {
            bounds,
            background: Some(background),
            border_color: None,
            border_width: 0.0,
            corner_radius: 0.0,
        })
    }

    #[test]
    fn an_empty_display_list_leaves_the_background() {
        let text = TextEngine::new();
        let mut p = Painter::new(8, 8);
        p.draw(&[], Color::rgb(1.0, 0.0, 0.0), &text);
        let px = at(&p, 4, 4);
        assert_eq!((px.r, px.g, px.b), (255, 0, 0));
    }

    #[test]
    fn a_quad_fills_its_bounds_and_nothing_outside_them() {
        let mut text = TextEngine::new();
        let mut p = Painter::new(20, 20);
        p.draw(
            &[quad(
                Rect {
                    x: 5.0,
                    y: 5.0,
                    width: 10.0,
                    height: 10.0,
                },
                Color::rgb(0.0, 0.0, 1.0),
            )],
            WHITE,
            &mut text,
        );
        let inside = at(&p, 10, 10);
        assert_eq!((inside.r, inside.g, inside.b), (0, 0, 255));
        let outside = at(&p, 1, 1);
        assert_eq!((outside.r, outside.g, outside.b), (255, 255, 255));
    }

    #[test]
    fn a_clip_discards_what_falls_outside_it() {
        let mut text = TextEngine::new();
        let mut p = Painter::new(20, 20);
        let blue = Color::rgb(0.0, 0.0, 1.0);
        // The quad covers the whole surface; the clip admits only its
        // top-left quadrant.
        p.draw(
            &[
                Command::PushClip(Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0,
                }),
                quad(
                    Rect {
                        x: 0.0,
                        y: 0.0,
                        width: 20.0,
                        height: 20.0,
                    },
                    blue,
                ),
                Command::PopClip,
            ],
            WHITE,
            &mut text,
        );
        let clipped_in = at(&p, 5, 5);
        assert_eq!((clipped_in.r, clipped_in.g, clipped_in.b), (0, 0, 255));
        let clipped_out = at(&p, 15, 15);
        assert_eq!((clipped_out.r, clipped_out.g, clipped_out.b), (255, 255, 255));
    }

    /// A component that pushes a clip and never pops it must not leave the
    /// rasterizer holding it.
    #[test]
    fn an_unbalanced_clip_does_not_carry_into_the_next_frame() {
        let mut text = TextEngine::new();
        let mut p = Painter::new(20, 20);
        let full = Rect {
            x: 0.0,
            y: 0.0,
            width: 20.0,
            height: 20.0,
        };
        p.draw(
            &[Command::PushClip(Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            })],
            WHITE,
            &mut text,
        );
        p.draw(&[quad(full, Color::rgb(0.0, 1.0, 0.0))], WHITE, &text);
        let px = at(&p, 15, 15);
        assert_eq!((px.r, px.g, px.b), (0, 255, 0));
    }

    /// A stray `PopClip` must not underflow into popping a clip the runtime
    /// pushed for someone else.
    #[test]
    fn a_stray_pop_is_ignored() {
        let mut text = TextEngine::new();
        let mut p = Painter::new(20, 20);
        p.draw(
            &[
                Command::PopClip,
                Command::PushClip(Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0,
                }),
                quad(
                    Rect {
                        x: 0.0,
                        y: 0.0,
                        width: 20.0,
                        height: 20.0,
                    },
                    Color::rgb(0.0, 0.0, 1.0),
                ),
            ],
            WHITE,
            &mut text,
        );
        let outside = at(&p, 15, 15);
        assert_eq!(
            (outside.r, outside.g, outside.b),
            (255, 255, 255),
            "the push should still have clipped"
        );
    }

    #[test]
    fn a_glyph_run_puts_dark_pixels_inside_its_box() {
        let mut text = TextEngine::new();
        let look = TextLook {
            size: 40.0,
            ..TextLook::default()
        };
        let run = text.register_run("HHHH", &look);
        let m = text.measure_run(run, None);
        let mut p = Painter::new(m.width.ceil() as u16 + 4, m.height.ceil() as u16 + 4);
        p.draw(
            &[Command::Glyphs(Glyphs {
                run,
                x: 2.0,
                y: 2.0,
            })],
            WHITE,
            &mut text,
        );
        let dark = p.pixels().iter().filter(|px| px.r < 128).count();
        assert!(dark > 20, "expected glyph coverage, got {dark} dark pixels");
    }

    /// The painter must draw the break the layout pass settled on. It used to
    /// re-break every run unconstrained, which painted one long line inside a
    /// box that had been sized and placed for a wrapped one — invisible in
    /// the hello demo, whose label never wraps.
    #[test]
    fn a_wrapped_run_paints_wrapped() {
        let mut text = TextEngine::new();
        let look = TextLook {
            size: 20.0,
            ..TextLook::default()
        };
        let run = text.register_run("The quick brown fox jumps over the lazy dog", &look);

        // One line, then the width the solve would have settled on.
        let one_line = text.measure_run(run, None);
        let wrapped = text.measure_run(run, Some(one_line.width / 4.0));
        assert!(
            wrapped.height > one_line.height * 1.5,
            "the fixture must actually wrap: {one_line:?} vs {wrapped:?}"
        );

        let mut p = Painter::new(
            wrapped.width.ceil() as u16,
            wrapped.height.ceil() as u16,
        );
        p.draw(
            &[Command::Glyphs(Glyphs {
                run,
                x: 0.0,
                y: 0.0,
            })],
            WHITE,
            &text,
        );

        // Ink below the first line can only come from the wrapped break.
        let width = p.size().0 as usize;
        let first_line_rows = one_line.height.ceil() as usize;
        let below = p.pixels()[first_line_rows * width..]
            .iter()
            .filter(|px| px.r < 128)
            .count();
        assert!(
            below > 10,
            "expected ink on later lines, got {below} dark pixels below row {first_line_rows}"
        );
    }

    #[test]
    fn blit_packs_pixels_as_0rgb() {
        let text = TextEngine::new();
        let mut p = Painter::new(2, 2);
        p.draw(&[], Color::rgb(1.0, 0.0, 0.0), &text);
        let mut buf = [0u32; 4];
        p.blit_to(&mut buf);
        assert_eq!(buf, [0x00FF_0000; 4]);
    }
}
