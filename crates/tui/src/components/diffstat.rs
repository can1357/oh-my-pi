//! Compact, width-safe summary of diff activity.

use core::fmt::Write as _;

use crate::{
	component::{Component, PaintCtx, Slot, next_slot},
	context::UiContext,
	frame::Rect,
	props::{Prop, PropValue, Props},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Field {
	Added,
	Removed,
	Ops,
}

#[derive(Debug, Default)]
struct CountLabel {
	value: Option<u64>,
	text:  String,
}

impl CountLabel {
	fn update(&mut self, value: Option<u64>, field: Field) {
		if self.value == value {
			return;
		}
		self.value = value;
		self.text.clear();
		let Some(value) = value.filter(|value| *value > 0) else {
			return;
		};
		match field {
			Field::Added => write!(self.text, "+{value}"),
			Field::Removed => write!(self.text, "-{value}"),
			Field::Ops if value == 1 => write!(self.text, "1 op"),
			Field::Ops => write!(self.text, "{value} ops"),
		}
		.expect("writing to String cannot fail");
	}

	fn width(&self) -> u16 {
		u16::try_from(self.text.len()).unwrap_or(u16::MAX)
	}
}

/// A retained one-row summary of added lines, removed lines, and operations.
pub struct DiffStat {
	props:   Props,
	slot:    Slot,
	added:   CountLabel,
	removed: CountLabel,
	ops:     CountLabel,
}

impl DiffStat {
	/// Creates an empty diff summary.
	pub fn new() -> Self {
		Self {
			props:   Props::new(),
			slot:    next_slot(),
			added:   CountLabel::default(),
			removed: CountLabel::default(),
			ops:     CountLabel::default(),
		}
	}

	/// Sets one summary property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	fn sync_labels(&mut self) {
		self.added.update(self.props.added(), Field::Added);
		self.removed.update(self.props.removed(), Field::Removed);
		self.ops.update(self.props.ops(), Field::Ops);
	}

	const fn labels(&self) -> [(&CountLabel, Field); 3] {
		[(&self.added, Field::Added), (&self.removed, Field::Removed), (&self.ops, Field::Ops)]
	}

	fn natural_width(&self) -> u16 {
		self
			.labels()
			.into_iter()
			.filter(|(label, _)| !label.text.is_empty())
			.fold((0_u16, false), |(width, any), (label, _)| {
				(
					width
						.saturating_add(label.width())
						.saturating_add(u16::from(any)),
					true,
				)
			})
			.0
	}
}

impl Default for DiffStat {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for DiffStat {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn paints_border(&self) -> bool {
		false
	}

	fn measure(&mut self, _ctx: &UiContext) -> (u16, u16) {
		self.sync_labels();
		(1, self.natural_width().max(1))
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		1
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if rect.width == 0 || rect.height == 0 || rect.y >= pc.clip {
			return;
		}
		self.sync_labels();
		let base = self.props.style(&pc.ctx.theme);
		let mut x = rect.x;
		let right = rect.x.saturating_add(rect.width);
		let mut any = false;
		for (label, field) in self.labels() {
			if label.text.is_empty() {
				continue;
			}
			let gap = u16::from(any);
			if x.saturating_add(gap).saturating_add(label.width()) > right {
				continue;
			}
			if any {
				x = pc.frame.put(x, rect.y, " ", base);
			}
			let color = match field {
				Field::Added => pc.ctx.theme.ok,
				Field::Removed => pc.ctx.theme.err,
				Field::Ops => pc.ctx.theme.muted,
			};
			x = pc.frame.put(x, rect.y, &label.text, base.fg(color));
			any = true;
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{Frame, Size, test_support::frame_row_text};

	fn render(stat: &mut DiffStat, width: u16) -> (Frame, String) {
		let ctx = UiContext::default();
		let mut frame = Frame::new(Size::new(width.max(1), 1));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		{
			let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
			stat.paint(&mut pc, Rect::new(0, 0, width, 1));
		}
		let text = frame_row_text(&frame, 0);
		(frame, text)
	}

	fn stat(added: Option<u64>, removed: Option<u64>, ops: Option<u64>) -> DiffStat {
		let mut stat = DiffStat::new();
		if let Some(value) = added {
			stat.props.set(Prop::Added, value);
		}
		if let Some(value) = removed {
			stat.props.set(Prop::Removed, value);
		}
		if let Some(value) = ops {
			stat.props.set(Prop::Ops, value);
		}
		stat
	}

	#[test]
	fn field_combinations_and_zero_values_are_signal_only() {
		for (values, expected) in [
			((None, None, None), ""),
			((Some(2), None, None), "+2"),
			((None, Some(3), None), "-3"),
			((None, None, Some(4)), "4 ops"),
			((Some(2), Some(3), None), "+2 -3"),
			((Some(2), None, Some(4)), "+2 4 ops"),
			((None, Some(3), Some(4)), "-3 4 ops"),
			((Some(2), Some(3), Some(4)), "+2 -3 4 ops"),
			((Some(0), Some(0), Some(0)), ""),
			((Some(0), Some(3), Some(0)), "-3"),
		] {
			let mut stat = stat(values.0, values.1, values.2);
			assert_eq!(render(&mut stat, 32).1.trim_end(), expected);
		}
	}

	#[test]
	fn operation_label_has_correct_singular_and_plural_forms() {
		assert_eq!(render(&mut stat(None, None, Some(1)), 12).1.trim_end(), "1 op");
		assert_eq!(render(&mut stat(None, None, Some(2)), 12).1.trim_end(), "2 ops");
	}

	#[test]
	fn narrow_rows_only_paint_complete_fields_that_fit() {
		let mut value = stat(Some(123), Some(2), Some(7));
		assert_eq!(render(&mut value, 0).1, "");
		assert_eq!(render(&mut value, 1).1, "");
		assert_eq!(render(&mut value, 2).1, "-2");
		assert_eq!(render(&mut value, 3).1, "-2");
		assert_eq!(render(&mut value, 4).1, "+123");
		assert_eq!(render(&mut value, 5).1, "+123");
		assert_eq!(render(&mut value, 8).1, "+123 -2");
	}

	#[test]
	fn fields_use_semantic_theme_colors() {
		let mut value = stat(Some(1), Some(2), Some(3));
		let (frame, _) = render(&mut value, 16);
		let theme = UiContext::default().theme;
		assert_eq!(frame.cell(0, 0).style().foreground_color(), theme.ok);
		assert_eq!(frame.cell(3, 0).style().foreground_color(), theme.err);
		assert_eq!(frame.cell(6, 0).style().foreground_color(), theme.muted);
	}

	#[test]
	fn unchanged_values_reuse_cached_label_allocations() {
		let mut value = stat(Some(1234), Some(5678), Some(9));
		value.sync_labels();
		let pointers =
			(value.added.text.as_ptr(), value.removed.text.as_ptr(), value.ops.text.as_ptr());
		value.measure(&UiContext::default());
		let _ = render(&mut value, 20);
		assert_eq!(
			pointers,
			(value.added.text.as_ptr(), value.removed.text.as_ptr(), value.ops.text.as_ptr(),)
		);
	}
}
