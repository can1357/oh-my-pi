use std::ops::Range;

use omp_core::{Str, sf};
use smallvec::SmallVec;

use super::{
	layout::{grid_measure, place_grid_row, solve_columns},
	overflow_plan, paint_overflow_footer,
	text::{Pre, TextLeaf, clip_start_runs, paint_rich},
};
use crate::{
	component::{Cached, Component, IntoChildren, PaintCtx, Slot, next_slot},
	context::UiContext,
	frame::{Color, Rect, Style},
	markup::{Align, Truncate},
	props::{Prop, PropValue, Props},
	rich::{Pipeline, RichSink, RichText},
};

/// A columnar layout backing the `<table>` markup tag.
///
/// Cells align vertically: every column is solved once across all rows
/// (widest cell wins), surplus room goes to `grow` columns, and a deficit
/// shrinks the widest flexible column first — pairing with cell-level
/// `truncate` so a name column collapses with an ellipsis while pinned
/// stat columns keep their alignment. Layout only: rows never capture
/// input; interactive lists wrap cells in `<select>` options instead.
pub struct Table {
	props:        Props,
	slot:         Slot,
	/// Row-major cell containers.
	children:     Vec<Cached>,
	rows:         SmallVec<RowMeta, 8>,
	/// Per-row vertical bands recorded by `place` for row backgrounds.
	bands:        SmallVec<(u16, u16), 8>,
	/// Natural physical row count from the latest width-dependent layout.
	natural_rows: u16,
}

struct RowMeta {
	cells: Range<usize>,
	props: Props,
}

impl Table {
	/// Creates an empty table.
	pub fn new() -> Self {
		Self {
			props:        Props::new(),
			slot:         next_slot(),
			children:     Vec::new(),
			rows:         SmallVec::new(),
			bands:        SmallVec::new(),
			natural_rows: 0,
		}
	}

	/// Sets one table property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one table property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Appends one row of cells.
	pub fn row(mut self, row: TableRow) -> Self {
		let start = self.children.len();
		for cell in row.cells {
			self.children.push(Cached::new(Box::new(cell)));
		}
		self
			.rows
			.push(RowMeta { cells: start..self.children.len(), props: row.props });
		self
	}

	fn spans(&self) -> SmallVec<Range<usize>, 8> {
		self.rows.iter().map(|row| row.cells.clone()).collect()
	}

	/// Spacing between columns: the `gap` prop, defaulting to two cells so
	/// adjacent columns never touch.
	fn column_gap(&self) -> u16 {
		if self.props.contains(Prop::Gap) {
			self.props.gap()
		} else {
			2
		}
	}
}

impl Default for Table {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Table {
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
		let spans = self.spans();
		let gap = self.column_gap();
		grid_measure(ctx, &mut self.children, &spans, gap)
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		let spans = self.spans();
		let gap = self.column_gap();
		let columns = solve_columns(ctx, &mut self.children, &spans, width, gap);
		let mut height = 0_u16;
		for span in &spans {
			let tallest = span
				.clone()
				.enumerate()
				.map(|(column, index)| self.children[index].height(ctx, columns[column].max(1)))
				.max()
				.unwrap_or(0)
				.max(1);
			height = height.saturating_add(tallest);
		}
		self.natural_rows = height;
		self.props.max_rows().map_or(height, |cap| height.min(cap))
	}

	fn place(&mut self, ctx: &UiContext, content: Rect) {
		let spans = self.spans();
		let gap = self.column_gap();
		let columns = solve_columns(ctx, &mut self.children, &spans, content.width, gap);
		self.bands.clear();
		let mut y = content.y;
		for span in spans {
			let row_height =
				place_grid_row(ctx, &mut self.children, span, &columns, content.x, y, gap);
			self.bands.push((y, row_height));
			y = y.saturating_add(row_height);
		}
		self.natural_rows = y.saturating_sub(content.y);
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		let plan = overflow_plan(&self.props, self.natural_rows, rect.height);
		let content_rows = plan.map_or(rect.height, |plan| plan.content_rows);
		let original_clip = pc.clip;
		if plan.is_some() {
			pc.clip = pc.clip.min(rect.y.saturating_add(content_rows));
		}
		let paint_clip = pc.clip;
		for (row, &(top, height)) in self.rows.iter().zip(&self.bands) {
			let background = row.props.style(&pc.ctx.theme).background_color();
			if background != Color::Default && top < pc.clip {
				let rows = height.min(pc.clip.saturating_sub(top));
				pc.frame
					.fill(Rect::new(rect.x, top, rect.width, rows), Style::new().bg(background));
			}
		}
		for child in self
			.children
			.iter_mut()
			.filter(|child| child.visible && (plan.is_none() || child.rect.y < paint_clip))
		{
			child.paint(pc);
		}
		if plan.is_some() {
			pc.clip = original_clip;
		}
		if let Some(plan) = plan {
			paint_overflow_footer(pc, rect, plan);
		}
	}
}

/// One `<tr>` under construction: row props (a `bg=` highlight band) plus
/// its cells in column order.
#[derive(Default)]
pub struct TableRow {
	props: Props,
	cells: SmallVec<TableCell, 8>,
}

impl TableRow {
	/// Creates an empty row.
	pub fn new() -> Self {
		Self::default()
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

	/// Appends one cell.
	pub fn cell(mut self, cell: TableCell) -> Self {
		self.cells.push(cell);
		self
	}
}

/// An inline-flow grid cell backing the `<td>` markup tag.
///
/// Children lay out side by side. With the `truncate` flag the cell
/// flattens text children (`<pre>`/`<text>`, keeping each child's own
/// style) into a single line and clips it with one trailing ellipsis at
/// the cell edge, so multi-toned labels collapse as a unit instead of
/// per-fragment.
pub struct TableCell {
	props:    Props,
	slot:     Slot,
	children: Vec<Cached>,
	rich:     RichText,
	/// Visible children that received room in the last `place`; paint
	/// skips the rest so a squeezed cell never overpaints its neighbor.
	shown:    usize,
}

impl TableCell {
	/// Creates an empty cell.
	pub fn new() -> Self {
		Self {
			props:    Props::new(),
			slot:     next_slot(),
			children: Vec::new(),
			rich:     RichText::default(),
			shown:    0,
		}
	}

	/// Sets one cell property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one cell property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Appends child components to the cell.
	pub fn child(mut self, children: impl IntoChildren) -> Self {
		let first = self.children.len();
		children.extend_children(&mut self.children);
		for child in &mut self.children[first..] {
			child.comp_mut().props_mut().set(Prop::Vertical, true);
			child.invalidate();
		}
		self
	}

	fn truncates(&self) -> Option<Truncate> {
		self.props.truncate()
	}

	/// The `(text, style)` run of a flattenable child; `None` for children
	/// that cannot join a single-line flatten (images, containers).
	fn flatten_run<'a>(child: &'a mut Cached, ctx: &UiContext) -> Option<(&'a Str, Style)> {
		let style = child.comp().props().style(&ctx.theme);
		let comp = child.comp();
		if let Some(pre) = comp.downcast_ref::<Pre>() {
			return Some((pre.content(), style));
		}
		if let Some(text) = comp.downcast_ref::<TextLeaf>() {
			return Some((text.content(), style));
		}
		None
	}

	/// Rebuilds the flattened single-line clip of every text child; `false`
	/// when a child cannot flatten (the cell falls back to placed children).
	fn flatten(&mut self, ctx: &UiContext, width: u16) -> bool {
		let Some(mode) = self.truncates() else {
			return false;
		};
		// Cells are single-line: any hard break renders as a space, and
		// every child keeps its own style through the shared clip.
		let mut runs: SmallVec<(Style, Str), 8> = SmallVec::new();
		for child in self.children.iter_mut().filter(|child| child.visible) {
			let Some((text, style)) = Self::flatten_run(child, ctx) else {
				return false;
			};
			for (index, line) in text.as_str().split('\n').enumerate() {
				if index > 0 {
					runs.push((style, sf!(" ")));
				}
				runs.push((style, text.slice_ref(line)));
			}
		}
		self.rich.clear();
		match mode {
			Truncate::End => {
				let mut clip = (&mut self.rich).clip(width.max(1), Some('…'));
				for (style, text) in &runs {
					clip.run(*style, text);
				}
			},
			Truncate::Start => clip_start_runs(&mut self.rich, width, &runs),
		}
		true
	}
}

impl Default for TableCell {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for TableCell {
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
		let mut min = 0_u16;
		let mut natural = 0_u16;
		for child in self.children.iter_mut().filter(|child| child.visible) {
			let (child_min, child_natural) = child.measure(ctx);
			min = min.saturating_add(child_min);
			natural = natural.saturating_add(child_natural);
		}
		if self.truncates().is_some() {
			// A truncating cell can always collapse to a lone ellipsis.
			return (natural.min(1), natural);
		}
		(min, natural)
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		if self.truncates().is_some() {
			return 1;
		}
		let mut remaining = width;
		let mut tallest = 1_u16;
		for child in self.children.iter_mut().filter(|child| child.visible) {
			if remaining == 0 {
				break;
			}
			let (_, child_natural) = child.measure(ctx);
			let child_width = child_natural.min(remaining).max(1);
			tallest = tallest.max(child.height(ctx, child_width));
			remaining = remaining.saturating_sub(child_width);
		}
		tallest
	}

	fn place(&mut self, ctx: &UiContext, content: Rect) {
		// First pass: the width each child gets, in order, until the room
		// runs out — later children are not placed at all, so a squeezed
		// cell never bleeds into the gap or the next column.
		let mut widths: SmallVec<u16, 8> = SmallVec::new();
		let mut remaining = content.width;
		for child in self.children.iter_mut().filter(|child| child.visible) {
			if remaining == 0 {
				break;
			}
			let (_, child_natural) = child.measure(ctx);
			let width = child_natural.min(remaining).max(1);
			widths.push(width);
			remaining = remaining.saturating_sub(width);
		}
		self.shown = widths.len();
		// Shorter content aligns inside the shared column width, so stat
		// columns right-align under a widest-cell-solved table.
		let slack = remaining;
		let mut cursor = content.x.saturating_add(match self.props.align() {
			Align::Start => 0,
			Align::Center => slack / 2,
			Align::End => slack,
		});
		for (child, &width) in self
			.children
			.iter_mut()
			.filter(|child| child.visible)
			.zip(&widths)
		{
			let height = child.height(ctx, width).min(content.height.max(1));
			child.place(ctx, Rect::new(cursor, content.y, width, height));
			cursor = cursor.saturating_add(width);
		}
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if self.flatten(pc.ctx, rect.width) {
			paint_rich(pc, rect, &self.rich, self.props.align());
			return;
		}
		let mut placed = self.shown;
		for child in self.children.iter_mut().filter(|child| child.visible) {
			if placed == 0 {
				break;
			}
			placed -= 1;
			child.paint(pc);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{
		Frame, Size,
		component::{Cached, PaintCtx},
		context::UiContext,
		test_support::frame_row_text,
	};

	#[test]
	fn max_rows_clamps_table_and_counts_physical_rows() {
		let ctx = UiContext::default();
		let mut table = Table::new()
			.with(Prop::MaxRows, 3_u16)
			.with(Prop::Overflow, "rows");
		for label in ["a", "b", "c", "d"] {
			table =
				table.row(TableRow::new().cell(TableCell::new().child(TextLeaf::new().text(label))));
		}
		let mut root = Cached::new(Box::new(table));
		let height = root.height(&ctx, 20);
		assert_eq!(height, 3);
		root.place(&ctx, Rect::new(0, 0, 20, height));
		let mut frame = Frame::new(Size::new(20, height));
		let mut hits = Vec::new();
		root.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));
		assert_eq!(frame_row_text(&frame, 0), "a");
		assert_eq!(frame_row_text(&frame, 1), "b");
		assert_eq!(frame_row_text(&frame, 2), "… 2 more rows");
	}
}
