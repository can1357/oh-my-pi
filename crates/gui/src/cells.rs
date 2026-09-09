//! Frame compositing: walks the visible document window plus the z-ordered
//! layer bands and lowers them to rect/glyph instances.
//!
//! Buffers are owned across paints — a frame rebuilds instances in place,
//! never re-allocating the vectors.

use std::{f32::consts, mem, time::Duration};

use omp_tui::{
	Border, Cell, CellContent, Color, DecorFill, DecorKind, Frame, Gradient, Layer, Rect, Size,
	Underline,
};
use smallvec::SmallVec;

pub use crate::fonts::LineMetrics as CellMetrics;
use crate::{
	fonts::Fonts,
	gpu::{Batch, GlyphInst, RectInst},
	scene::SceneFrame,
	theme::{GuiTheme, color4},
};

/// Normalized cell-grid selection over the document frame, in reading order.
///
/// `start` is inclusive on the first row and `end` is exclusive on the last
/// row; middle rows span the full frame width.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selection {
	/// First selected document cell, `(row, column)`.
	pub start: (u16, u16),
	/// Exclusive selection end on the last row, `(row, column)`.
	pub end:   (u16, u16),
}

/// Grid placement and scroll state for one paint.
#[derive(Clone, Copy, Debug)]
pub struct View {
	/// Render target size, physical px.
	pub window:    [f32; 2],
	/// Top-left of the cell grid (letterbox margin), physical px.
	pub origin:    [f32; 2],
	/// Transcript scroll offset away from the tail, physical px.
	pub scroll:    f32,
	/// Whether the caret is in its visible blink phase.
	pub cursor_on: bool,
	/// Shared animation clock elapsed since the host started.
	pub now:       Duration,
	/// Selected cell range in the document frame.
	pub selection: Option<Selection>,
}

/// Instance buffers for one frame, reused across paints.
#[derive(Default)]
pub struct Instances {
	/// SDF rect instances (backdrop, cell backgrounds, carets, scrollbars).
	pub rects:   Vec<RectInst>,
	/// Atlas glyph instances.
	pub glyphs:  Vec<GlyphInst>,
	/// Scissored slices over the two lists.
	pub batches: Vec<Batch>,
}

/// One layer's resolved band, ready to paint.
struct Band<'a> {
	frame:   &'a Frame,
	x:       u16,
	y:       u16,
	src_top: u16,
	rows:    u16,
	active:  bool,
}

/// Per-row background run state: consecutive cells sharing one resolved
/// background merge into a single rect.
#[derive(Default)]
struct BgRun {
	start: u16,
	color: Option<[f32; 4]>,
}

#[derive(Clone, Copy, PartialEq)]
struct PxRect {
	pos:  [f32; 2],
	size: [f32; 2],
}

#[derive(Clone, Copy)]
struct Pass<'a> {
	frame:      &'a Frame,
	col_offset: u16,
	row_offset: f32,
	first:      u16,
	last:       u16,
	bands:      Option<&'a [Band<'a>]>,
	clip:       [u32; 4],
}

/// The frame compositor.
#[derive(Default)]
pub struct Compositor {
	instances: Instances,
}

impl Compositor {
	/// Rebuilds the instance buffers for a single full-window `scene` at
	/// `view` — [`begin`](Self::begin), one [`pane`](Self::pane), and
	/// [`finish`](Self::finish) in one call. Font rasters happen lazily
	/// inside; drain [`Fonts::take_uploads`] before drawing.
	pub fn build(
		&mut self,
		scene: &SceneFrame<'_>,
		fonts: &mut Fonts,
		theme: &GuiTheme,
		view: &View,
		px: f32,
	) -> &Instances {
		self.begin(view.window, theme);
		self.pane(scene, fonts, theme, view, px);
		self.finish()
	}

	/// Starts a frame: clears the instance buffers and emits the window
	/// backdrop.
	pub fn begin(&mut self, window: [f32; 2], theme: &GuiTheme) {
		self.instances.rects.clear();
		self.instances.glyphs.clear();
		self.instances.batches.clear();

		let mut backdrop = RectInst::fill([0.0, 0.0], window, theme.backdrop);
		backdrop.params[0] = theme.corner_radius;
		self.instances.rects.push(backdrop);
		self
			.instances
			.batches
			.push(Batch { clip: None, rects: 0..1, glyphs: 0..0 });
	}

	/// Composites one grid (a pane or a chrome strip) at `view` into the
	/// frame: the visible document window, layer bands, caret, and
	/// scrollbar, all clipped to the grid rect.
	pub fn pane(
		&mut self,
		scene: &SceneFrame<'_>,
		fonts: &mut Fonts,
		theme: &GuiTheme,
		view: &View,
		px: f32,
	) {
		let metrics = fonts.cell_metrics(px);
		let (advance, line_height) = (metrics.advance, metrics.line_height);
		let grid_w = f32::from(scene.viewport.width) * advance;
		let grid_h = f32::from(scene.viewport.height) * line_height;
		let clip = [
			view.origin[0].max(0.0) as u32,
			view.origin[1].max(0.0) as u32,
			grid_w.ceil() as u32,
			grid_h.ceil() as u32,
		];

		let frame = scene.frame;
		let doc_rows = frame.size().height;
		let vp_rows = scene.viewport.height.max(1);
		let scroll_rows = view.scroll.max(0.0) / line_height;
		let end = (doc_rows as f32 - scroll_rows).clamp(0.0, doc_rows as f32);
		let start = (end - vp_rows as f32).max(0.0);
		let first = start.floor() as u16;
		let last = (end.ceil() as u16).min(doc_rows);
		let bands = resolve_bands(scene.layers.as_slice(), scene.viewport);
		self.paint_pass(
			Pass { frame, col_offset: 0, row_offset: -start, first, last, bands: Some(&bands), clip },
			fonts,
			theme,
			view,
			px,
			&metrics,
		);

		for band in &bands {
			let bx = f32::mul_add(f32::from(band.x), advance, view.origin[0]);
			let by = f32::mul_add(f32::from(band.y), line_height, view.origin[1]);
			let bw = f32::from(band.frame.size().width) * advance;
			let bh = f32::from(band.rows) * line_height;
			let starts = self.starts();
			let mut shadow = RectInst::fill([bx, f32::mul_add(line_height, 0.1, by)], [bw, bh], [
				0.0, 0.0, 0.0, 0.35,
			]);
			shadow.params = [line_height * 0.3, line_height * 0.45, 0.0, 0.0];
			self.instances.rects.push(shadow);
			self.finish_batch(Some(clip), starts);

			let clip_x = bx.max(0.0).floor();
			let clip_y = by.max(0.0).floor();
			let band_clip = [
				clip_x as u32,
				clip_y as u32,
				((bx + bw).ceil() - clip_x) as u32,
				((by + bh).ceil() - clip_y) as u32,
			];
			self.paint_pass(
				Pass {
					frame:      band.frame,
					col_offset: band.x,
					row_offset: f32::from(band.y) - f32::from(band.src_top),
					first:      band.src_top,
					last:       band
						.src_top
						.saturating_add(band.rows)
						.min(band.frame.size().height),
					bands:      None,
					clip:       band_clip,
				},
				fonts,
				theme,
				view,
				px,
				&metrics,
			);
		}

		let starts = self.starts();
		if view.cursor_on {
			let layer_cursor = bands
				.iter()
				.rev()
				.filter(|band| band.active)
				.find_map(|band| {
					let (cx, cy) = band.frame.cursor()?;
					let row = band.y.checked_add(cy)?.checked_sub(band.src_top)?;
					(row < band.y + band.rows).then_some((band.x + cx, row))
				});
			let any_active = bands.iter().any(|band| band.active);
			let base_cursor = (!any_active && view.scroll < line_height)
				.then(|| frame.cursor())
				.flatten()
				.and_then(|(cx, cy)| {
					(cy >= first && cy < last)
						.then_some((cx, (cy as f32 - start).mul_add(line_height, view.origin[1])))
				});
			let caret = match (layer_cursor, base_cursor) {
				(Some((cx, row)), _) => Some((
					f32::mul_add(f32::from(cx), advance, view.origin[0]),
					f32::mul_add(f32::from(row), line_height, view.origin[1]),
				)),
				(None, Some((cx, py))) => {
					Some((f32::mul_add(f32::from(cx), advance, view.origin[0]), py))
				},
				(None, None) => None,
			};
			if let Some((cx, py)) = caret {
				let width = (advance * 0.14).max(2.0);
				let pad = line_height * 0.08;
				let mut rect = RectInst::fill(
					[cx, py + pad],
					[width, f32::mul_add(pad, -2.0, line_height)],
					theme.cursor,
				);
				rect.params[0] = width * 0.5;
				self.instances.rects.push(rect);
			}
		}

		let max_scroll = f32::from(doc_rows.saturating_sub(vp_rows)) * line_height;
		if max_scroll > 0.0 {
			let track_w = 2.5_f32;
			let track_x = view.origin[0] + grid_w - track_w - 1.0;
			let thumb_h = (grid_h * f32::from(vp_rows) / f32::from(doc_rows)).max(line_height);
			let progress = (max_scroll - view.scroll.clamp(0.0, max_scroll)) / max_scroll;
			let thumb_y = f32::mul_add(progress, grid_h - thumb_h, view.origin[1]);
			let alpha = if view.scroll > 0.0 { 0.55 } else { 0.22 };
			let mut rect = RectInst::fill([track_x, thumb_y], [track_w, thumb_h], [
				theme.accent[0],
				theme.accent[1],
				theme.accent[2],
				alpha,
			]);
			rect.params[0] = track_w * 0.5;
			self.instances.rects.push(rect);
		}
		self.finish_batch(Some(clip), starts);
	}

	/// Emits unclipped chrome rects (pane dividers) as one batch.
	pub fn rects(&mut self, rects: &[RectInst]) {
		if rects.is_empty() {
			return;
		}
		let starts = self.starts();
		self.instances.rects.extend_from_slice(rects);
		self.finish_batch(None, starts);
	}

	/// Finishes the frame, yielding the assembled instance buffers.
	pub const fn finish(&self) -> &Instances {
		&self.instances
	}

	fn paint_pass(
		&mut self,
		pass: Pass<'_>,
		fonts: &mut Fonts,
		theme: &GuiTheme,
		view: &View,
		px: f32,
		metrics: &CellMetrics,
	) {
		let reveals: SmallVec<(Rect, f32), 2> = pass
			.frame
			.decors()
			.iter()
			.filter_map(|decor| match &decor.kind {
				DecorKind::Reveal { front } => Some((decor.rect, *front)),
				_ => None,
			})
			.collect();
		let starts = self.starts();
		self.paint_decors(pass, theme, view, metrics, false);
		self.finish_batch(Some(pass.clip), starts);

		let starts = self.starts();
		for y in pass.first..pass.last {
			let py = (pass.row_offset + f32::from(y)).mul_add(metrics.line_height, view.origin[1]);
			let mut run = BgRun::default();
			for x in 0..pass.frame.size().width {
				if !Self::visible(pass, x, y) {
					self.flush_run(&mut run, x, pass.col_offset, py, view.origin[0], metrics);
					continue;
				}
				let bg = cell_bg(pass.frame.cell(x, y), theme);
				if bg != run.color {
					self.flush_run(&mut run, x, pass.col_offset, py, view.origin[0], metrics);
					run = BgRun { start: x, color: bg };
				}
			}
			self.flush_run(
				&mut run,
				pass.frame.size().width,
				pass.col_offset,
				py,
				view.origin[0],
				metrics,
			);
		}
		if pass.bands.is_some()
			&& let Some(selection) = view.selection
		{
			self.paint_selection(pass, selection, theme.selection, view, metrics);
		}
		self.finish_batch(Some(pass.clip), starts);

		let starts = self.starts();
		for y in pass.first..pass.last {
			let py = (pass.row_offset + f32::from(y)).mul_add(metrics.line_height, view.origin[1]);
			for x in 0..pass.frame.size().width {
				if Self::visible(pass, x, y) {
					self.paint_image(
						pass.frame.cell(x, y),
						x,
						pass.col_offset,
						py,
						view.origin[0],
						fonts,
						metrics,
					);
				}
			}
		}
		self.finish_batch(Some(pass.clip), starts);

		let starts = self.starts();
		for y in pass.first..pass.last {
			let py = (pass.row_offset + f32::from(y)).mul_add(metrics.line_height, view.origin[1]);
			for x in 0..pass.frame.size().width {
				if !Self::visible(pass, x, y) || Self::wide_seam(pass, x, y) {
					continue;
				}
				self.paint_text(
					pass.frame.cell(x, y),
					x,
					y,
					pass.col_offset,
					py,
					view.origin[0],
					fonts,
					theme,
					px,
					metrics,
					&reveals,
				);
			}
		}
		self.finish_batch(Some(pass.clip), starts);

		let starts = self.starts();
		self.paint_decors(pass, theme, view, metrics, true);
		self.finish_batch(Some(pass.clip), starts);
	}

	const fn starts(&self) -> (u32, u32) {
		(self.instances.rects.len() as u32, self.instances.glyphs.len() as u32)
	}

	fn finish_batch(&mut self, clip: Option<[u32; 4]>, (rects, glyphs): (u32, u32)) {
		let rect_end = self.instances.rects.len() as u32;
		let glyph_end = self.instances.glyphs.len() as u32;
		if rects != rect_end || glyphs != glyph_end {
			self.instances.batches.push(Batch {
				clip,
				rects: rects..rect_end,
				glyphs: glyphs..glyph_end,
			});
		}
	}

	fn visible(pass: Pass<'_>, x: u16, y: u16) -> bool {
		pass
			.bands
			.is_none_or(|bands| !covered(bands, x, pass.row_offset + f32::from(y)))
	}

	fn wide_seam(pass: Pass<'_>, x: u16, y: u16) -> bool {
		let Some(bands) = pass.bands else {
			return false;
		};
		let CellContent::Grapheme { width, .. } = pass.frame.cell(x, y).content() else {
			return false;
		};
		*width > 1
			&& (x + 1..x.saturating_add(*width).min(pass.frame.size().width))
				.any(|cx| covered(bands, cx, pass.row_offset + f32::from(y)))
	}

	fn paint_decors(
		&mut self,
		pass: Pass<'_>,
		theme: &GuiTheme,
		view: &View,
		metrics: &CellMetrics,
		shimmers: bool,
	) {
		if shimmers {
			for decor in pass.frame.decors() {
				let DecorKind::Shimmer { period } = &decor.kind else {
					continue;
				};
				let (pos, size) = decor_box(pass, decor.rect, view, metrics);
				self.paint_shimmer(pos, size, *period, view.now, metrics.advance);
			}
			return;
		}
		for decor in pass.frame.decors() {
			let DecorKind::Fill { fill, rounded } = &decor.kind else {
				continue;
			};
			let (pos, size) = decor_box(pass, decor.rect, view, metrics);
			let whole = PxRect { pos, size };
			let mut fragments: SmallVec<PxRect, 8> = SmallVec::new();
			fragments.push(whole);
			if let Some(bands) = pass.bands {
				let mut scratch: SmallVec<PxRect, 8> = SmallVec::new();
				for band in bands {
					let cut = PxRect {
						pos:  [
							f32::mul_add(f32::from(band.x), metrics.advance, view.origin[0]),
							f32::mul_add(f32::from(band.y), metrics.line_height, view.origin[1]),
						],
						size: [
							f32::from(band.frame.size().width) * metrics.advance,
							f32::from(band.rows) * metrics.line_height,
						],
					};
					scratch.clear();
					for fragment in fragments.drain(..) {
						subtract_rect(fragment, cut, &mut scratch);
					}
					mem::swap(&mut fragments, &mut scratch);
					if fragments.is_empty() {
						break;
					}
				}
			}
			let (color, color2, grad) = decor_fill(*fill, size, theme);
			for fragment in fragments {
				let mut rect = RectInst::fill(fragment.pos, fragment.size, color);
				rect.color2 = color2;
				rect.grad =
					offset_projection(grad, [fragment.pos[0] - pos[0], fragment.pos[1] - pos[1]]);
				rect.params[0] = if *rounded && fragment == whole {
					metrics.line_height * 0.5
				} else {
					0.0
				};
				self.instances.rects.push(rect);
			}
		}
		for decor in pass.frame.decors() {
			let DecorKind::Border { border, ink, glow } = &decor.kind else {
				continue;
			};
			let (pos, size) = decor_box(pass, decor.rect, view, metrics);
			self.paint_border(pos, size, *border, *ink, *glow, metrics, theme);
			self.paint_border_notches(pass, decor.rect, theme, view, metrics);
		}
	}

	fn paint_border(
		&mut self,
		pos: [f32; 2],
		size: [f32; 2],
		border: Border,
		ink: DecorFill,
		glow: Option<(Color, f32)>,
		metrics: &CellMetrics,
		theme: &GuiTheme,
	) {
		let radius = if border == Border::Round {
			metrics.line_height * 0.5
		} else {
			2.0
		};
		if let Some((color, strength)) = glow
			&& let Some(mut color) = color4(color, Some(theme.fg))
		{
			color[3] = 0.35 * strength.clamp(0.0, 1.0);
			let mut halo = RectInst::fill(pos, size, color);
			halo.params = [radius, metrics.line_height * 0.4, 0.0, 0.0];
			self.instances.rects.push(halo);
		}
		let (color, color2, grad) = decor_fill(ink, size, theme);
		let stroke = if border == Border::Heavy { 2.0 } else { 1.0 };
		let dash = if border == Border::Dash {
			metrics.advance * 0.9
		} else {
			0.0
		};
		self.push_border(pos, size, radius, stroke, dash, color, color2, grad);
		if border == Border::Double && size[0] > 6.0 && size[1] > 6.0 {
			self.push_border(
				[pos[0] + 3.0, pos[1] + 3.0],
				[size[0] - 6.0, size[1] - 6.0],
				(radius - 3.0).max(0.0),
				1.0,
				0.0,
				color,
				color2,
				offset_projection(grad, [3.0, 3.0]),
			);
		}
	}

	fn push_border(
		&mut self,
		pos: [f32; 2],
		size: [f32; 2],
		radius: f32,
		stroke: f32,
		dash: f32,
		color: [f32; 4],
		color2: [f32; 4],
		grad: [f32; 4],
	) {
		let mut rect = RectInst::fill(pos, size, [0.0; 4]);
		rect.params = [radius, 0.0, stroke, dash];
		rect.border_color = color;
		rect.color2 = color2;
		rect.grad = grad;
		self.instances.rects.push(rect);
	}

	fn paint_border_notches(
		&mut self,
		pass: Pass<'_>,
		bounds: Rect,
		theme: &GuiTheme,
		view: &View,
		metrics: &CellMetrics,
	) {
		if bounds.width == 0 || bounds.height == 0 {
			return;
		}
		let frame_size = pass.frame.size();
		let right = bounds.x.saturating_add(bounds.width).min(frame_size.width);
		if bounds.x >= right {
			return;
		}
		let bottom = bounds.y.saturating_add(bounds.height - 1);
		let fill = pass.frame.decors().iter().rev().find_map(|decor| {
			if decor.rect != bounds {
				return None;
			}
			match &decor.kind {
				DecorKind::Fill { fill, .. } => Some(*fill),
				_ => None,
			}
		});
		for row in [bounds.y, bottom] {
			if row >= frame_size.height {
				continue;
			}
			let mut start = None;
			for x in bounds.x..=right {
				let title = if x < right {
					let cell = pass.frame.cell(x, row);
					!matches!(cell.content(), CellContent::Blank) && cell_bg(cell, theme).is_none()
				} else {
					false
				};
				match (start, title) {
					(None, true) => start = Some(x),
					(Some(run_start), false) => {
						let run = Rect::new(run_start, row, x - run_start, 1);
						let (pos, size) = decor_box(pass, run, view, metrics);
						let color = fill.map_or_else(
							|| [theme.backdrop[0], theme.backdrop[1], theme.backdrop[2], 1.0],
							|fill| decor_fill_sample(fill, bounds, run, metrics, theme),
						);
						self.instances.rects.push(RectInst::fill(pos, size, color));
						start = None;
					},
					_ => {},
				}
			}
			if bottom == bounds.y {
				break;
			}
		}
	}

	fn paint_shimmer(
		&mut self,
		pos: [f32; 2],
		size: [f32; 2],
		period: Duration,
		now: Duration,
		advance: f32,
	) {
		let padding = 10.0_f32;
		let half_width = 6.0 * advance;
		let length = size[0] / advance.max(f32::EPSILON);
		let track = padding.mul_add(2.0, length);
		let period = period.as_nanos().max(1);
		let phase = (now.as_nanos() % period) as f32 / period as f32;
		let center = phase.mul_add(track, -padding).mul_add(advance, pos[0]);
		let left = pos[0];
		let right = pos[0] + size[0];
		self.push_shimmer_ramp(
			(center - half_width).max(left),
			center.min(right),
			center,
			half_width,
			pos[1],
			size[1],
		);
		self.push_shimmer_ramp(
			center.max(left),
			(center + half_width).min(right),
			center,
			half_width,
			pos[1],
			size[1],
		);
	}

	fn push_shimmer_ramp(
		&mut self,
		start: f32,
		end: f32,
		center: f32,
		half_width: f32,
		y: f32,
		height: f32,
	) {
		if end <= start {
			return;
		}
		let alpha = |x: f32| {
			let distance = (x - center).abs();
			if distance >= half_width {
				0.0
			} else {
				0.1 * (1.0 + (consts::PI * distance / half_width).cos())
			}
		};
		let width = end - start;
		let mut rect = RectInst::fill([start, y], [width, height], [1.0, 1.0, 1.0, alpha(start)]);
		rect.color2 = [1.0, 1.0, 1.0, alpha(end)];
		rect.grad = [1.0, 0.0, 0.0, width.recip()];
		self.instances.rects.push(rect);
	}

	fn flush_run(
		&mut self,
		run: &mut BgRun,
		end: u16,
		col_offset: u16,
		py: f32,
		ox: f32,
		metrics: &CellMetrics,
	) {
		if let Some(color) = run.color
			&& end > run.start
		{
			self.instances.rects.push(RectInst::fill(
				[f32::mul_add(f32::from(col_offset + run.start), metrics.advance, ox), py],
				[f32::from(end - run.start) * metrics.advance, metrics.line_height],
				color,
			));
		}
		run.color = None;
	}

	fn paint_selection(
		&mut self,
		pass: Pass<'_>,
		selection: Selection,
		color: [f32; 4],
		view: &View,
		metrics: &CellMetrics,
	) {
		if selection.start.0 > selection.end.0 || pass.first >= pass.last {
			return;
		}
		let width = pass.frame.size().width;
		let first = selection.start.0.max(pass.first);
		let last = selection.end.0.min(pass.last - 1);
		if first > last {
			return;
		}
		for y in first..=last {
			let start = if y == selection.start.0 {
				selection.start.1
			} else {
				0
			}
			.min(width);
			let end = if y == selection.end.0 {
				selection.end.1
			} else {
				width
			}
			.min(width);
			if start >= end {
				continue;
			}
			// Noselect regions (HUD chrome) punch holes in the highlight.
			let mut segments: SmallVec<(u16, u16), 4> = SmallVec::new();
			segments.push((start, end));
			for hole in pass.frame.noselect() {
				if y < hole.y || y >= hole.y.saturating_add(hole.height) {
					continue;
				}
				let (hole_start, hole_end) = (hole.x, hole.x.saturating_add(hole.width));
				let mut next: SmallVec<(u16, u16), 4> = SmallVec::new();
				for &(seg_start, seg_end) in &segments {
					if hole_end <= seg_start || hole_start >= seg_end {
						next.push((seg_start, seg_end));
						continue;
					}
					if seg_start < hole_start {
						next.push((seg_start, hole_start));
					}
					if hole_end < seg_end {
						next.push((hole_end, seg_end));
					}
				}
				segments = next;
			}
			for (seg_start, seg_end) in segments {
				self.instances.rects.push(RectInst::fill(
					[
						f32::mul_add(
							f32::from(pass.col_offset + seg_start),
							metrics.advance,
							view.origin[0],
						),
						(pass.row_offset + f32::from(y)).mul_add(metrics.line_height, view.origin[1]),
					],
					[f32::from(seg_end - seg_start) * metrics.advance, metrics.line_height],
					color,
				));
			}
		}
	}

	fn paint_image(
		&mut self,
		cell: &Cell,
		x: u16,
		col_offset: u16,
		py: f32,
		ox: f32,
		fonts: &mut Fonts,
		metrics: &CellMetrics,
	) {
		let CellContent::Image { id, row: 0, col: 0, rows, cols } = cell.content() else {
			return;
		};
		let width = f32::from(*cols) * metrics.advance;
		let height = f32::from(*rows) * metrics.line_height;
		let Some((uv, size)) = fonts.image_region(*id, width.ceil() as u32, height.ceil() as u32)
		else {
			return;
		};
		self.instances.glyphs.push(GlyphInst {
			pos: [f32::mul_add(f32::from(col_offset + x), metrics.advance, ox), py],
			size,
			uv,
			color: [1.0; 4],
			slant: 0.0,
			kind: 1.0,
		});
	}

	fn paint_text(
		&mut self,
		cell: &Cell,
		x: u16,
		y: u16,
		col_offset: u16,
		py: f32,
		ox: f32,
		fonts: &mut Fonts,
		theme: &GuiTheme,
		px: f32,
		metrics: &CellMetrics,
		reveals: &[(Rect, f32)],
	) {
		let spec = cell.style().spec();
		let fg_color = if spec.reverse {
			spec.background
		} else {
			spec.foreground
		};
		let mut fg = color4(fg_color, Some(theme.fg)).unwrap_or(theme.fg);
		if spec.dim {
			fg = [fg[0] * 0.65, fg[1] * 0.65, fg[2] * 0.65, fg[3]];
		}
		let baseline = (metrics.line_height + metrics.ascent - metrics.descent)
			.mul_add(0.5, py)
			.round();
		let pen_x = f32::mul_add(f32::from(col_offset + x), metrics.advance, ox);
		let CellContent::Grapheme { text, width } = cell.content() else {
			return;
		};
		if *width == 0 {
			return;
		}
		if !reveals.is_empty() {
			for &(rect, front) in reveals {
				let right = rect.x.saturating_add(rect.width);
				let bottom = rect.y.saturating_add(rect.height);
				if x >= rect.x && x < right && y >= rect.y && y < bottom {
					fg[3] *= ((front - f32::from(x)) / 2.0).clamp(0.0, 1.0);
				}
			}
		}
		let box_width = f32::from(*width) * metrics.advance;
		let slant = if spec.italic && !fonts.has_italic() {
			0.17
		} else {
			0.0
		};
		let (cluster, origin) = fonts.cluster(text, spec.bold, spec.italic, px, pen_x, box_width);
		let origin = origin as f32;
		for glyph in &cluster.glyphs {
			self.instances.glyphs.push(GlyphInst {
				pos: [origin + glyph.offset[0], baseline - glyph.offset[1]],
				size: glyph.size,
				uv: glyph.uv,
				color: fg,
				slant,
				kind: if glyph.color { 1.0 } else { 0.0 },
			});
		}

		let line_h = (metrics.line_height * 0.055).max(1.0);
		match spec.underline {
			Underline::None => {},
			Underline::Straight => {
				let color = color4(spec.underline_color, None).unwrap_or(fg);
				self.instances.rects.push(RectInst::fill(
					[pen_x, metrics.descent.mul_add(0.35, baseline)],
					[box_width, line_h],
					color,
				));
			},
			Underline::Curly => {
				// Zigzag approximation; phase derives from absolute x so the
				// wave stays continuous across adjacent clusters.
				let color = color4(spec.underline_color, None).unwrap_or(fg);
				let y = metrics.descent.mul_add(0.35, baseline);
				let step = (metrics.advance * 0.5).max(1.0);
				let end = pen_x + box_width;
				let first = (pen_x / step).floor() as i64;
				let last = (end / step).ceil() as i64;
				for segment in first..last {
					let left = (segment as f32 * step).max(pen_x);
					let right = ((segment + 1) as f32 * step).min(end);
					if right <= left {
						continue;
					}
					let offset = if segment & 1 == 0 {
						-line_h * 0.6
					} else {
						line_h * 0.6
					};
					self.instances.rects.push(RectInst::fill(
						[left, y + offset],
						[right - left, line_h],
						color,
					));
				}
			},
		}
		if spec.strikethrough {
			self.instances.rects.push(RectInst::fill(
				[pen_x, metrics.ascent.mul_add(-0.3, baseline)],
				[box_width, line_h],
				fg,
			));
		}
	}
}

fn subtract_rect(rect: PxRect, cut: PxRect, out: &mut SmallVec<PxRect, 8>) {
	let rect_right = rect.pos[0] + rect.size[0];
	let rect_bottom = rect.pos[1] + rect.size[1];
	let cut_right = cut.pos[0] + cut.size[0];
	let cut_bottom = cut.pos[1] + cut.size[1];
	let left = rect.pos[0].max(cut.pos[0]);
	let top = rect.pos[1].max(cut.pos[1]);
	let right = rect_right.min(cut_right);
	let bottom = rect_bottom.min(cut_bottom);
	if left >= right || top >= bottom {
		out.push(rect);
		return;
	}
	if rect.pos[1] < top {
		out.push(PxRect { pos: rect.pos, size: [rect.size[0], top - rect.pos[1]] });
	}
	if bottom < rect_bottom {
		out.push(PxRect { pos: [rect.pos[0], bottom], size: [rect.size[0], rect_bottom - bottom] });
	}
	if rect.pos[0] < left {
		out.push(PxRect { pos: [rect.pos[0], top], size: [left - rect.pos[0], bottom - top] });
	}
	if right < rect_right {
		out.push(PxRect { pos: [right, top], size: [rect_right - right, bottom - top] });
	}
}

fn decor_box(
	pass: Pass<'_>,
	rect: Rect,
	view: &View,
	metrics: &CellMetrics,
) -> ([f32; 2], [f32; 2]) {
	(
		[
			f32::mul_add(f32::from(pass.col_offset + rect.x), metrics.advance, view.origin[0]),
			(pass.row_offset + f32::from(rect.y)).mul_add(metrics.line_height, view.origin[1]),
		],
		[f32::from(rect.width) * metrics.advance, f32::from(rect.height) * metrics.line_height],
	)
}

fn decor_fill(fill: DecorFill, size: [f32; 2], theme: &GuiTheme) -> ([f32; 4], [f32; 4], [f32; 4]) {
	match fill {
		DecorFill::Solid(color) => {
			let color = color4(color, Some(theme.fg)).unwrap_or(theme.fg);
			(color, color, [0.0; 4])
		},
		DecorFill::Gradient(gradient) => {
			let start = color4(gradient.start(), Some(theme.fg)).unwrap_or(theme.fg);
			let end = color4(gradient.end(), Some(theme.fg)).unwrap_or(theme.fg);
			(start, end, gradient_projection(gradient, size))
		},
	}
}

fn decor_fill_sample(
	fill: DecorFill,
	bounds: Rect,
	run: Rect,
	metrics: &CellMetrics,
	theme: &GuiTheme,
) -> [f32; 4] {
	let size =
		[f32::from(bounds.width) * metrics.advance, f32::from(bounds.height) * metrics.line_height];
	let (start, end, grad) = decor_fill(fill, size, theme);
	if grad[3] == 0.0 {
		return start;
	}
	let point = [
		(f32::from(run.width) * metrics.advance)
			.mul_add(0.5, f32::from(run.x - bounds.x) * metrics.advance),
		metrics
			.line_height
			.mul_add(0.5, f32::from(run.y - bounds.y) * metrics.line_height),
	];
	let amount =
		((point[1].mul_add(grad[1], point[0] * grad[0]) - grad[2]) * grad[3]).clamp(0.0, 1.0);
	[
		(end[0] - start[0]).mul_add(amount, start[0]),
		(end[1] - start[1]).mul_add(amount, start[1]),
		(end[2] - start[2]).mul_add(amount, start[2]),
		(end[3] - start[3]).mul_add(amount, start[3]),
	]
}

fn gradient_projection(gradient: Gradient, size: [f32; 2]) -> [f32; 4] {
	let (horizontal, vertical) = match gradient.angle() % 360 {
		0 => (1.0, 0.0),
		90 => (0.0, 1.0),
		180 => (-1.0, 0.0),
		270 => (0.0, -1.0),
		angle => {
			let radians = f32::from(angle).to_radians();
			(radians.cos(), radians.sin())
		},
	};
	let horizontal_end = horizontal * size[0];
	let vertical_end = vertical * size[1];
	let min = 0.0_f32
		.min(horizontal_end)
		.min(vertical_end)
		.min(horizontal_end + vertical_end);
	let max = 0.0_f32
		.max(horizontal_end)
		.max(vertical_end)
		.max(horizontal_end + vertical_end);
	let span = max - min;
	[
		horizontal,
		vertical,
		min,
		if span > f32::EPSILON {
			span.recip()
		} else {
			0.0
		},
	]
}

fn offset_projection(mut projection: [f32; 4], offset: [f32; 2]) -> [f32; 4] {
	projection[2] -= offset[1].mul_add(projection[1], offset[0] * projection[0]);
	projection
}

/// The resolved background of one cell after reverse video, `None` for the
/// transparent default.
fn cell_bg(cell: &Cell, theme: &GuiTheme) -> Option<[f32; 4]> {
	let spec = cell.style().spec();
	let bg = if spec.reverse {
		spec.foreground
	} else {
		spec.background
	};
	match bg {
		Color::Default => None,
		color => color4(color, Some(theme.fg)),
	}
}

/// Whether viewport cell (`x`, fractional row `vy`) sits under a layer band.
fn covered(bands: &[Band<'_>], x: u16, vy: f32) -> bool {
	bands.iter().any(|band| {
		x >= band.x
			&& x < band.x + band.frame.size().width
			&& vy >= f32::from(band.y)
			&& vy < f32::from(band.y + band.rows)
	})
}

/// Z-sorts layers and resolves their viewport bands, skipping gated ones.
fn resolve_bands<'a>(layers: &[Layer<'a>], viewport: Size) -> SmallVec<Band<'a>, 4> {
	let mut bands: SmallVec<(i16, Band<'a>), 4> = layers
		.iter()
		.filter_map(|layer| {
			let band = layer.band(viewport);
			(band.rows > 0).then_some((layer.options.z, Band {
				frame:   layer.frame,
				x:       band.x,
				y:       band.y,
				src_top: band.src_top,
				rows:    band.rows,
				active:  layer.active,
			}))
		})
		.collect();
	bands.sort_by_key(|(z, _)| *z);
	bands.into_iter().map(|(_, band)| band).collect()
}
