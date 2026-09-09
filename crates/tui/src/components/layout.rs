use std::ops::Range;

use smallvec::SmallVec;

use crate::{
	component::Cached,
	context::UiContext,
	frame::Rect,
	markup::{Align, Dim, VAlign},
};

pub(super) fn stack_measure(ctx: &UiContext, children: &mut [Cached]) -> (u16, u16) {
	let mut min = 0;
	let mut natural = 0;
	for child in children.iter_mut().filter(|child| child.visible) {
		let (child_min, child_natural) = child.measure(ctx);
		min = min.max(child_min);
		natural = natural.max(child_natural);
	}
	(min, natural)
}

pub(super) fn stack_height(ctx: &UiContext, children: &mut [Cached], width: u16, gap: u16) -> u16 {
	let mut height = 0_u16;
	let mut count = 0_u16;
	for child in children.iter_mut().filter(|child| child.visible) {
		height = height.saturating_add(child.height(ctx, width.max(1)));
		count = count.saturating_add(1);
	}
	height.saturating_add(gap.saturating_mul(count.saturating_sub(1)))
}

pub(super) fn stack_place(
	ctx: &UiContext,
	children: &mut [Cached],
	content: Rect,
	gap: u16,
	valign: Option<VAlign>,
	align: Align,
) {
	let visible: SmallVec<usize, 8> = children
		.iter()
		.enumerate()
		.filter_map(|(index, child)| child.visible.then_some(index))
		.collect();
	let mut cursor = content.y;
	for (position, &index) in visible.iter().enumerate() {
		if position > 0 {
			cursor = cursor.saturating_add(gap);
		}
		let height = children[index].height(ctx, content.width.max(1));
		children[index].place(ctx, Rect::new(content.x, cursor, content.width.max(1), height));
		cursor = cursor.saturating_add(height);
	}

	let used = cursor.saturating_sub(content.y);
	let slack = content.height.saturating_sub(used);
	distribute_column_slack(ctx, children, &visible, valign, slack);
	align_children(ctx, children, &visible, align, content.x, content.width.max(1));
}

fn distribute_column_slack(
	ctx: &UiContext,
	children: &mut [Cached],
	visible: &[usize],
	valign: Option<VAlign>,
	slack: u16,
) {
	let weights: f32 = visible
		.iter()
		.filter_map(|&index| children[index].comp().props().grow())
		.sum();
	if weights > 0.0 {
		let mut shift = 0_u16;
		for &index in visible {
			let mut rect = children[index].rect;
			rect.y = rect.y.saturating_add(shift);
			if let Some(weight) = children[index].comp().props().grow() {
				let share = (f32::from(slack) * weight / weights) as u16;
				rect.height = rect.height.saturating_add(share);
				shift = shift.saturating_add(share);
			}
			children[index].place(ctx, rect);
		}
		return;
	}
	let offset = match valign.unwrap_or(VAlign::Start) {
		VAlign::Start | VAlign::Stretch => return,
		VAlign::Center => slack / 2,
		VAlign::End => slack,
	};
	for &index in visible {
		let mut rect = children[index].rect;
		rect.y = rect.y.saturating_add(offset);
		children[index].place(ctx, rect);
	}
}

fn align_children(
	ctx: &UiContext,
	children: &mut [Cached],
	visible: &[usize],
	align: Align,
	inner_x: u16,
	inner_width: u16,
) {
	if align == Align::Start {
		return;
	}
	for &index in visible {
		let (_, natural) = children[index].measure(ctx);
		let width = natural.min(inner_width).max(1);
		if width >= inner_width {
			continue;
		}
		let offset = match align {
			Align::Start => 0,
			Align::Center => (inner_width - width) / 2,
			Align::End => inner_width - width,
		};
		let mut rect = children[index].rect;
		rect.x = inner_x.saturating_add(offset);
		rect.width = width;
		children[index].place(ctx, rect);
	}
}

/// One solvable width share: a row child or a shared grid column.
pub(super) struct Track {
	/// Starting width, already clamped to `min..=cap`.
	pub base:     u16,
	/// Floor honored by the first shrink pass.
	pub min:      u16,
	/// Ceiling honored while growing.
	pub cap:      u16,
	/// Flexible growth weight claiming surplus room.
	pub grow:     Option<f32>,
	/// Whether overflow may shrink this track below `base` toward `min`.
	pub flexible: bool,
}

/// Distributes `room` across `tracks` in place: grow tracks absorb surplus
/// (weight scaled by what each already received), then overflow shrinks the
/// widest flexible-or-grow track above its floor, falling back to any track
/// wider than one cell. Every track lands at one cell or more.
pub(super) fn distribute(tracks: &mut [Track], room: u16) {
	let count = tracks.len();
	let total = tracks
		.iter()
		.map(|track| track.base)
		.fold(0_u16, u16::saturating_add);
	let mut remaining = room.saturating_sub(total);
	while remaining > 0 {
		let candidate = (0..count)
			.filter(|&index| tracks[index].grow.is_some() && tracks[index].base < tracks[index].cap)
			.max_by(|&left, &right| {
				let score =
					|track: &Track| track.grow.unwrap_or(0.0) / f32::from(track.base - track.min + 1);
				score(&tracks[left]).total_cmp(&score(&tracks[right]))
			});
		let Some(index) = candidate else { break };
		tracks[index].base += 1;
		remaining -= 1;
	}
	while tracks
		.iter()
		.map(|track| u32::from(track.base))
		.sum::<u32>()
		> u32::from(room)
	{
		let candidate = (0..count)
			.filter(|&index| {
				let track = &tracks[index];
				(track.flexible || track.grow.is_some()) && track.base > track.min
			})
			.max_by_key(|&index| tracks[index].base)
			.or_else(|| {
				(0..count)
					.filter(|&index| tracks[index].base > 1)
					.max_by_key(|&index| tracks[index].base)
			});
		let Some(index) = candidate else { break };
		tracks[index].base -= 1;
	}
	for track in tracks {
		track.base = track.base.max(1);
	}
}

/// Aggregated width bounds of one grid column across every row.
#[derive(Clone, Copy, Default)]
struct ColumnBounds {
	min:     u16,
	natural: u16,
}

/// Sums per-column minimum and natural widths across `spans` (row-major
/// cell ranges into `cells`), including `gap` between columns — the grid
/// counterpart of [`stack_measure`].
pub(super) fn grid_measure(
	ctx: &UiContext,
	cells: &mut [Cached],
	spans: &[Range<usize>],
	gap: u16,
) -> (u16, u16) {
	let bounds = column_bounds(ctx, cells, spans);
	let gaps = gap.saturating_mul(bounds.len().saturating_sub(1) as u16);
	let min = bounds
		.iter()
		.fold(0_u16, |sum, column| sum.saturating_add(column.min));
	let natural = bounds
		.iter()
		.fold(0_u16, |sum, column| sum.saturating_add(column.natural));
	(min.saturating_add(gaps), natural.saturating_add(gaps))
}

fn column_bounds(
	ctx: &UiContext,
	cells: &mut [Cached],
	spans: &[Range<usize>],
) -> SmallVec<ColumnBounds, 8> {
	let columns = spans.iter().map(Range::len).max().unwrap_or(0);
	let mut bounds: SmallVec<ColumnBounds, 8> =
		(0..columns).map(|_| ColumnBounds::default()).collect();
	for span in spans {
		for (column, index) in span.clone().enumerate() {
			let (cell_min, cell_natural) = cells[index].measure(ctx);
			let props = cells[index].comp().props();
			let entry = &mut bounds[column];
			entry.min = entry.min.max(cell_min.max(props.min().unwrap_or(0)));
			entry.natural = entry.natural.max(cell_natural);
		}
	}
	bounds
}

/// Solves shared column widths for row-major `cells` grouped by `spans`, so
/// cells align vertically across every row. Column bounds aggregate across
/// rows; a `grow` cell marks its column as the surplus absorber, and the
/// deficit pass shrinks the widest flexible column first, which pairs with
/// cell-level `truncate` for compact name collapse.
pub(super) fn solve_columns(
	ctx: &UiContext,
	cells: &mut [Cached],
	spans: &[Range<usize>],
	width: u16,
	gap: u16,
) -> SmallVec<u16, 8> {
	let columns = spans.iter().map(Range::len).max().unwrap_or(0);
	if columns == 0 {
		return SmallVec::new();
	}
	let room = width.saturating_sub(gap.saturating_mul(columns.saturating_sub(1) as u16));
	let mut tracks: SmallVec<Track, 8> = (0..columns)
		.map(|_| Track {
			base:     0,
			min:      0,
			cap:      u16::MAX,
			grow:     None,
			flexible: false,
		})
		.collect();
	for span in spans {
		for (column, index) in span.clone().enumerate() {
			let (cell_min, cell_natural) = cells[index].measure(ctx);
			let request = cells[index].w(ctx);
			let props = cells[index].comp().props();
			let track = &mut tracks[column];
			track.min = track.min.max(cell_min.max(props.min().unwrap_or(0)));
			if let Some(cap) = props.max() {
				track.cap = track.cap.min(cap);
			}
			if let Some(weight) = props.grow() {
				track.grow = Some(track.grow.unwrap_or(0.0).max(weight));
			}
			let base = match request {
				Some(Dim::Pct(percent)) => {
					track.flexible = true;
					((u32::from(room) * u32::from(percent)) / 100).max(1) as u16
				},
				Some(Dim::Cells(cells)) => cells,
				// Grow columns start at natural width so a deficit is paid
				// by them (truncating) before pinned stat columns move.
				None => {
					if props.grow().is_none() {
						track.flexible = true;
					}
					cell_natural.min(room)
				},
			};
			track.base = track.base.max(base);
		}
	}
	for track in &mut tracks {
		track.base = track.base.min(track.cap).max(track.min);
	}
	distribute(&mut tracks, room);
	tracks.iter().map(|track| track.base).collect()
}

/// Places one grid row's cells at the solved column widths, returning the
/// row height (its tallest cell, at least one row).
pub(super) fn place_grid_row(
	ctx: &UiContext,
	cells: &mut [Cached],
	span: Range<usize>,
	columns: &[u16],
	x: u16,
	y: u16,
	gap: u16,
) -> u16 {
	let mut heights: SmallVec<u16, 8> = SmallVec::new();
	for (column, index) in span.clone().enumerate() {
		heights.push(cells[index].height(ctx, columns[column].max(1)));
	}
	let row_height = heights.iter().copied().max().unwrap_or(0).max(1);
	let mut cursor = x;
	for (column, index) in span.enumerate() {
		let width = columns[column].max(1);
		cells[index].place(ctx, Rect::new(cursor, y, width, row_height));
		cursor = cursor.saturating_add(width).saturating_add(gap);
	}
	row_height
}
