use smallvec::SmallVec;
use smol_bitmap::SmolBitmap;

use super::layout::{Track, distribute};
use crate::{
	component::{Cached, Component, IntoChildren, PaintCtx, Slot, next_slot},
	context::UiContext,
	frame::Rect,
	markup::{Align, Dim, Justify, VAlign},
	props::{Prop, PropValue, Props},
};

/// A horizontal child stack backing the `<row>` markup tag.
///
/// With the `wrap` flag set the row flows children into as many lines as
/// the width allows; each line is solved and justified independently, so a
/// wrapping row of fixed-width children behaves as a responsive grid.
pub struct Row {
	props:      Props,
	slot:       Slot,
	children:   Vec<Cached>,
	separators: SmallVec<Rect, 8>,
}

impl Row {
	/// Creates an empty row.
	pub fn new() -> Self {
		Self {
			props:      Props::new(),
			slot:       next_slot(),
			children:   Vec::new(),
			separators: SmallVec::new(),
		}
	}

	/// Sets one row property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one row property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Appends child components to the row.
	pub fn child(mut self, children: impl IntoChildren) -> Self {
		let first = self.children.len();
		children.extend_children(&mut self.children);
		for child in &mut self.children[first..] {
			child.comp_mut().props_mut().set(Prop::Vertical, true);
			child.invalidate();
		}
		self
	}

	fn visible(&self) -> SmallVec<usize, 8> {
		self
			.children
			.iter()
			.enumerate()
			.filter_map(|(index, child)| child.visible.then_some(index))
			.collect()
	}

	fn separator_width(&self) -> u16 {
		self
			.props
			.str_of(Prop::Sep)
			.map_or(0, |separator| u16::try_from(xutf::width_str(separator)).unwrap_or(u16::MAX))
	}

	fn child_has_paint_content(&mut self, ctx: &UiContext, index: usize) -> bool {
		let (minimum, natural) = self.children[index].measure(ctx);
		let width = minimum.max(natural);
		width > 0 && self.children[index].height(ctx, width) > 0
	}

	fn child_has_layout_geometry(&mut self, ctx: &UiContext, index: usize) -> bool {
		let (minimum, natural) = self.children[index].measure(ctx);
		let requested = self.children[index].w(ctx);
		minimum > 0
			|| natural > 0
			|| self.children[index].comp().props().grow().is_some()
			|| matches!(requested, Some(Dim::Cells(cells)) if cells > 0)
			|| matches!(requested, Some(Dim::Pct(percent)) if percent > 0)
	}

	fn pack_width(&mut self, ctx: &UiContext, index: usize, width: u16) -> u16 {
		let (measured_min, measured_natural) = self.children[index].measure(ctx);
		let request = self.children[index].w(ctx);
		let props = self.children[index].comp().props();
		let minimum = measured_min.max(props.min().unwrap_or(0));
		let cap = props.max().unwrap_or(u16::MAX);
		let base = match request {
			Some(Dim::Pct(percent)) => ((u32::from(width) * u32::from(percent)) / 100).max(1) as u16,
			Some(Dim::Cells(cells)) => cells,
			None if props.grow().is_some() => minimum,
			None => measured_natural.min(width),
		};
		base.min(cap).max(minimum)
	}

	fn wrap_lines(
		&mut self,
		ctx: &UiContext,
		visible: &[usize],
		width: u16,
		gap: u16,
		separator: u16,
	) -> SmallVec<usize, 8> {
		let mut ends: SmallVec<usize, 8> = SmallVec::new();
		let mut used = 0_u16;
		let mut count = 0_usize;
		let mut active = 0_usize;
		for (position, &index) in visible.iter().enumerate() {
			let pack = self.pack_width(ctx, index, width);
			let paints = pack > 0
				&& self.child_has_paint_content(ctx, index)
				&& self.children[index].height(ctx, pack) > 0;
			let chrome = if paints && active > 0 { separator } else { 0 };
			let extended = used
				.saturating_add(gap)
				.saturating_add(chrome)
				.saturating_add(pack);
			if count > 0 && extended > width {
				ends.push(position);
				used = pack;
				count = 1;
				active = usize::from(paints);
			} else {
				used = if count == 0 { pack } else { extended };
				count += 1;
				active += usize::from(paints);
			}
		}
		if count > 0 {
			ends.push(visible.len());
		}
		ends
	}

	fn line_height(
		&mut self,
		ctx: &UiContext,
		line: &[usize],
		width: u16,
		gap: u16,
		separator: u16,
	) -> u16 {
		let mut widths =
			self.solve_row(ctx, line, width, gap, separator, line.len().saturating_sub(1));
		let mut heights: SmallVec<u16, 8> = line
			.iter()
			.zip(&widths)
			.map(|(&index, &child_width)| self.children[index].height(ctx, child_width))
			.collect();
		let mut active = 0_usize;
		for (position, &index) in line.iter().enumerate() {
			if widths[position] > 0
				&& heights[position] > 0
				&& self.child_has_paint_content(ctx, index)
			{
				active += 1;
			}
		}
		if active < line.len() {
			widths = self.solve_row(ctx, line, width, gap, separator, active.saturating_sub(1));
			heights = line
				.iter()
				.zip(&widths)
				.map(|(&index, &child_width)| self.children[index].height(ctx, child_width))
				.collect();
		}
		heights.into_iter().max().unwrap_or(0)
	}

	fn solve_row(
		&mut self,
		ctx: &UiContext,
		visible: &[usize],
		available: u16,
		gap: u16,
		separator: u16,
		separator_count: usize,
	) -> SmallVec<u16, 8> {
		let count = visible.len();
		let room = available
			.saturating_sub(
				gap.saturating_mul(u16::try_from(count.saturating_sub(1)).unwrap_or(u16::MAX)),
			)
			.saturating_sub(
				separator.saturating_mul(u16::try_from(separator_count).unwrap_or(u16::MAX)),
			);
		let mut tracks: SmallVec<Track, 8> = SmallVec::new();
		for &index in visible {
			let (measured_min, measured_natural) = self.children[index].measure(ctx);
			let width_request = self.children[index].w(ctx);
			let props = self.children[index].comp().props();
			let mut track = Track {
				base:     0,
				min:      measured_min.max(props.min().unwrap_or(0)),
				cap:      props.max().unwrap_or(u16::MAX),
				grow:     None,
				flexible: false,
			};
			track.base = match width_request {
				Some(Dim::Pct(percent)) => {
					track.flexible = true;
					(u32::from(room) * u32::from(percent) / 100).max(1) as u16
				},
				Some(Dim::Cells(cells)) => cells,
				None => {
					if let Some(weight) = props.grow() {
						track.grow = Some(weight);
						track.min
					} else {
						track.flexible = true;
						measured_natural.min(room)
					}
				},
			};
			track.base = track.base.min(track.cap).max(track.min);
			tracks.push(track);
		}
		distribute(&mut tracks, room);
		if separator > 0 {
			for (position, &index) in visible.iter().enumerate() {
				if !self.child_has_layout_geometry(ctx, index) {
					tracks[position].base = 0;
				}
			}
		}
		tracks.iter().map(|track| track.base).collect()
	}

	fn align_cross_axis(
		&mut self,
		ctx: &UiContext,
		visible: &[usize],
		row: Option<VAlign>,
		top: u16,
		tallest: u16,
	) {
		for &index in visible {
			let mode = if self.children[index].comp().stretch_in_row() {
				VAlign::Stretch
			} else {
				row.unwrap_or(VAlign::Stretch)
			};
			let mut rect = self.children[index].rect;
			let slack = tallest.saturating_sub(rect.height);
			if slack == 0 {
				continue;
			}
			match mode {
				VAlign::Start => {},
				VAlign::Center => {
					rect.y = top.saturating_add(slack / 2);
					self.children[index].place(ctx, rect);
				},
				VAlign::End => {
					rect.y = top.saturating_add(slack);
					self.children[index].place(ctx, rect);
				},
				VAlign::Stretch => {
					rect.height = tallest;
					self.children[index].place(ctx, rect);
				},
			}
		}
	}

	fn place_line(
		&mut self,
		ctx: &UiContext,
		line: &[usize],
		x: u16,
		y: u16,
		width: u16,
		gap: u16,
		separator: u16,
	) -> u16 {
		let mut widths =
			self.solve_row(ctx, line, width, gap, separator, line.len().saturating_sub(1));
		let mut heights: SmallVec<u16, 8> = line
			.iter()
			.zip(&widths)
			.map(|(&index, &child_width)| self.children[index].height(ctx, child_width))
			.collect();
		let mut active = 0_usize;
		for (position, &index) in line.iter().enumerate() {
			if widths[position] > 0
				&& heights[position] > 0
				&& self.child_has_paint_content(ctx, index)
			{
				active += 1;
			}
		}
		if active < line.len() {
			widths = self.solve_row(ctx, line, width, gap, separator, active.saturating_sub(1));
			heights = line
				.iter()
				.zip(&widths)
				.map(|(&index, &child_width)| self.children[index].height(ctx, child_width))
				.collect();
		}
		let mut active_children = SmolBitmap::with_capacity(line.len());
		for (position, &index) in line.iter().enumerate() {
			active_children.set(
				position,
				widths[position] > 0
					&& heights[position] > 0
					&& self.child_has_paint_content(ctx, index),
			);
		}
		let separator_count = (0..line.len())
			.filter(|&position| active_children.get(position))
			.count()
			.saturating_sub(1);
		let used = widths
			.iter()
			.copied()
			.fold(0_u16, u16::saturating_add)
			.saturating_add(
				gap.saturating_mul(u16::try_from(line.len().saturating_sub(1)).unwrap_or(0)),
			)
			.saturating_add(
				separator.saturating_mul(u16::try_from(separator_count).unwrap_or(u16::MAX)),
			);
		let slack = width.saturating_sub(used);
		let justify = match self.props.get(Prop::Justify) {
			Some(PropValue::Justify(value)) => value,
			_ => Justify::Start,
		};
		let mut cursor = x.saturating_add(match justify {
			Justify::Between => 0,
			Justify::Center => slack / 2,
			Justify::End => slack,
			Justify::Start => match self.props.align() {
				Align::Start => 0,
				Align::Center => slack / 2,
				Align::End => slack,
			},
		});
		let between = u16::try_from(line.len().saturating_sub(1)).unwrap_or(0);
		let (gap_extra, gap_remainder) = if justify == Justify::Between && between > 0 {
			(slack / between, slack % between)
		} else {
			(0, 0)
		};
		let mut tallest = 0_u16;
		let mut saw_active = false;
		for (position, ((&index, child_width), height)) in
			line.iter().zip(widths).zip(heights).enumerate()
		{
			let active = active_children.get(position);
			if position > 0 {
				let remainder =
					u16::from(u16::try_from(position - 1).unwrap_or(u16::MAX) < gap_remainder);
				cursor = cursor
					.saturating_add(gap)
					.saturating_add(gap_extra)
					.saturating_add(remainder);
			}
			if active && saw_active && separator > 0 {
				self.separators.push(Rect::new(cursor, y, separator, 1));
				cursor = cursor.saturating_add(separator);
			}
			self.children[index].place(ctx, Rect::new(cursor, y, child_width, height));
			tallest = tallest.max(height);
			cursor = cursor.saturating_add(child_width);
			saw_active |= active;
		}
		self.align_cross_axis(ctx, line, self.props.valign(), y, tallest);
		tallest
	}
}

impl Default for Row {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Row {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn children(&self) -> &[Cached] {
		&self.children
	}

	fn children_mut(&mut self) -> &mut [Cached] {
		&mut self.children
	}

	fn measure(&mut self, ctx: &UiContext) -> (u16, u16) {
		let visible = self.visible();
		let gaps = self
			.props
			.gap()
			.saturating_mul(u16::try_from(visible.len().saturating_sub(1)).unwrap_or(u16::MAX));
		let separator = self.separator_width();
		let wraps = self.props.flag(Prop::Wrap);
		let mut minimum = if wraps { 0 } else { gaps };
		let mut natural = gaps;
		let mut active = 0_usize;
		for index in visible {
			let (child_minimum, child_natural) = self.children[index].measure(ctx);
			let child_minimum =
				child_minimum.max(self.children[index].comp().props().min().unwrap_or(0));
			if wraps {
				minimum = minimum.max(child_minimum);
			} else {
				minimum = minimum.saturating_add(child_minimum);
			}
			natural = natural.saturating_add(child_natural);
			let requested = match self.children[index].w(ctx) {
				Some(Dim::Cells(cells)) => cells,
				Some(Dim::Pct(_)) => 1,
				None => 0,
			};
			let paint_width = child_natural.max(child_minimum).max(requested);
			if paint_width > 0 && self.children[index].height(ctx, paint_width) > 0 {
				active += 1;
			}
		}
		let separators =
			separator.saturating_mul(u16::try_from(active.saturating_sub(1)).unwrap_or(u16::MAX));
		if !wraps {
			minimum = minimum.saturating_add(separators);
		}
		(minimum, natural.saturating_add(separators))
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		let visible = self.visible();
		let gap = self.props.gap();
		let separator = self.separator_width();
		if self.props.flag(Prop::Wrap) {
			let ends = self.wrap_lines(ctx, &visible, width, gap, separator);
			let mut total = 0_u16;
			let mut start = 0_usize;
			for &end in &ends {
				total = total.saturating_add(self.line_height(
					ctx,
					&visible[start..end],
					width,
					gap,
					separator,
				));
				start = end;
			}
			return total;
		}
		self.line_height(ctx, &visible, width, gap, separator)
	}

	fn place(&mut self, ctx: &UiContext, content: Rect) {
		self.separators.clear();
		let visible = self.visible();
		let gap = self.props.gap();
		let separator = self.separator_width();
		if self.props.flag(Prop::Wrap) {
			let ends = self.wrap_lines(ctx, &visible, content.width, gap, separator);
			let mut top = content.y;
			let mut start = 0_usize;
			for &end in &ends {
				let tallest = self.place_line(
					ctx,
					&visible[start..end],
					content.x,
					top,
					content.width,
					gap,
					separator,
				);
				top = top.saturating_add(tallest);
				start = end;
			}
			return;
		}
		self.place_line(ctx, &visible, content.x, content.y, content.width, gap, separator);
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if rect.height == 0 || rect.width == 0 {
			return;
		}
		for child in self.children.iter_mut().filter(|child| child.visible) {
			child.paint(pc);
		}
		if let Some(separator) = self.props.str_of(Prop::Sep) {
			let style = self.props.style(&pc.ctx.theme);
			for &separator_rect in &self.separators {
				if separator_rect.y >= pc.clip {
					continue;
				}
				pc.frame.put_clipped(
					separator_rect.x,
					separator_rect.y,
					separator_rect.width,
					separator,
					style,
				);
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::Row;
	use crate::{
		component::{Component, PaintCtx},
		components::TextLeaf,
		context::UiContext,
		frame::{Frame, Rect, Size},
		markup::Dim,
		props::Prop,
		test_support::frame_row_text,
	};

	fn paint(row: &mut Row, width: u16) -> Frame {
		let ctx = UiContext::default();
		let height = row.height(&ctx, width);
		row.place(&ctx, Rect::new(0, 0, width, height));
		let mut frame = Frame::new(Size::new(width, height));
		let mut hits = Vec::new();
		row.paint(
			&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()),
			Rect::new(0, 0, width, height),
		);
		frame
	}

	#[test]
	fn solves_percent_and_grow_widths_without_heap_scratch_for_small_rows() {
		let ctx = UiContext::default();
		let mut row = Row::new()
			.child(TextLeaf::new().text("pct").with(Prop::W, Dim::Pct(50)))
			.child(TextLeaf::new().text("grow").with(Prop::Grow, 1.0_f32));
		assert_eq!(row.measure(&ctx), (7, 7));
		row.place(&ctx, Rect::new(0, 0, 20, 1));
		assert_eq!(row.children()[0].rect, Rect::new(0, 0, 10, 1));
		assert_eq!(row.children()[1].rect, Rect::new(10, 0, 10, 1));
	}
	#[test]
	fn separator_is_chrome_between_nonzero_children() {
		let mut row = Row::new()
			.with(Prop::Sep, " · ")
			.child(TextLeaf::new().text("A"))
			.child(TextLeaf::new().text(""))
			.child(TextLeaf::new().text("B"));
		let slots: Vec<_> = row
			.children()
			.iter()
			.map(|child| child.comp().slot())
			.collect();

		let frame = paint(&mut row, 8);

		assert_eq!(frame_row_text(&frame, 0).trim_end(), "A · B");
		assert_eq!(row.children().len(), 3);
		assert_eq!(
			row.children()
				.iter()
				.map(|child| child.comp().slot())
				.collect::<Vec<_>>(),
			slots
		);
	}

	#[test]
	fn hidden_and_edge_empty_children_do_not_add_separators() {
		let mut row = Row::new()
			.with(Prop::Sep, " · ")
			.child(TextLeaf::new().text(""))
			.child(TextLeaf::new().text("A"))
			.child(TextLeaf::new().text("hidden"))
			.child(TextLeaf::new().text(""));
		row.children_mut()[2].visible = false;

		let frame = paint(&mut row, 8);

		assert_eq!(frame_row_text(&frame, 0).trim_end(), "A");
	}

	#[test]
	fn narrow_rows_reserve_separator_chrome_before_flex_layout() {
		let mut row = Row::new()
			.with(Prop::Sep, " · ")
			.child(TextLeaf::new().text("A").with(Prop::Grow, 1.0_f32))
			.child(TextLeaf::new().text("B").with(Prop::Grow, 1.0_f32));

		let frame = paint(&mut row, 5);

		assert_eq!(frame_row_text(&frame, 0), "A · B");
		assert_eq!(row.children()[0].rect.width, 1);
		assert_eq!(row.children()[1].rect.width, 1);
	}

	#[test]
	fn wrapping_never_paints_a_separator_across_lines() {
		let mut row = Row::new()
			.with(Prop::Sep, " · ")
			.with(Prop::Wrap, true)
			.child(TextLeaf::new().text("aa").with(Prop::W, 2_u16))
			.child(TextLeaf::new().text("bb").with(Prop::W, 2_u16));

		let frame = paint(&mut row, 5);

		assert_eq!(frame_row_text(&frame, 0).trim_end(), "aa");
		assert_eq!(frame_row_text(&frame, 1).trim_end(), "bb");
	}
}
