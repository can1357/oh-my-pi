//! Horizontal and vertical rules, including width-safe docked labels.

use std::iter;

use xutf::Text as _;

use crate::{
	component::{Component, PaintCtx, Slot, next_slot},
	context::UiContext,
	frame::{CellContent, Rect, Style},
	markup::{Align, Border},
	props::{Prop, PropValue, Props},
};

/// A display-width-limited string prefix.
///
/// When [`ellipsis`](Self::ellipsis) is true, callers should append a
/// one-cell ellipsis after [`text`](Self::text); [`width`](Self::width)
/// includes that ellipsis.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TruncatedText<'a> {
	/// Grapheme-boundary prefix of the original text.
	pub text:     &'a str,
	/// Display width of the prefix plus its optional ellipsis.
	pub width:    u16,
	/// Whether a one-cell ellipsis must follow the prefix.
	pub ellipsis: bool,
}

/// Truncates `text` to `max_width` terminal cells without allocating.
///
/// The returned prefix always ends on a grapheme boundary. When truncation is
/// necessary and at least one cell is available, one cell is reserved for an
/// ellipsis that the caller paints as a separate span.
pub fn truncate_to_width(text: &str, max_width: u16) -> TruncatedText<'_> {
	let max_width = usize::from(max_width);
	let prefix_limit = max_width.saturating_sub(1);
	let mut full_width = 0_usize;
	let mut prefix_width = 0_usize;
	let mut prefix_end = 0;
	for grapheme in text.graphemes() {
		let width = grapheme.visible_width();
		let next = full_width.saturating_add(width);
		if next > max_width {
			if max_width == 0 {
				return TruncatedText { text: "", width: 0, ellipsis: false };
			}
			return TruncatedText {
				text:     &text[..prefix_end],
				width:    u16::try_from(prefix_width + 1).unwrap_or(u16::MAX),
				ellipsis: true,
			};
		}
		full_width = next;
		if full_width <= prefix_limit {
			prefix_width = full_width;
			prefix_end += grapheme.len();
		}
	}
	TruncatedText { text, width: u16::try_from(full_width).unwrap_or(u16::MAX), ellipsis: false }
}

/// A horizontal or vertical divider backing `<hr>`, with an optional docked
/// `label` (`title` remains a compatibility fallback).
pub struct Hr {
	props: Props,
	slot:  Slot,
	bar:   String,
}

impl Hr {
	/// Creates a divider with default styling.
	pub fn new() -> Self {
		Self { props: Props::new(), slot: next_slot(), bar: String::new() }
	}

	/// Sets one divider property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one divider property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self
	}
}

impl Default for Hr {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Hr {
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

	fn stretch_in_row(&self) -> bool {
		true
	}

	fn measure(&mut self, _ctx: &UiContext) -> (u16, u16) {
		if self.props.flag(Prop::Vertical) {
			(1, 1)
		} else {
			(1, 4)
		}
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		1
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		let border = self.props.border().unwrap_or(Border::Square);
		let (.., horizontal, vertical) = pc.ctx.charset.border(border);
		let style = self.props.style(&pc.ctx.theme);
		// An unstyled rule takes the theme's border tone; `fg=`/`bc=` win.
		let line = self.props.edge(&pc.ctx.theme).map_or_else(
			|| {
				if self.props.has_foreground() {
					style.dim()
				} else {
					style.fg(pc.ctx.theme.border)
				}
			},
			|color| style.fg(color),
		);
		if self.props.flag(Prop::Vertical) {
			self.bar.clear();
			repeated_char(&mut self.bar, vertical, 1);
			for row in 0..rect.height {
				let y = rect.y.saturating_add(row);
				if y >= pc.clip {
					break;
				}
				pc.frame.put(rect.x, y, &self.bar, line);
			}
			return;
		}
		if rect.y >= pc.clip {
			return;
		}
		let join_left = find_border_left(pc.frame, rect.x, rect.y, vertical);
		let join_right =
			find_border_right(pc.frame, rect.x.saturating_add(rect.width), rect.y, vertical);
		let line_x = join_left.map_or(rect.x, |edge| edge.saturating_add(1));
		let line_right = join_right.unwrap_or_else(|| rect.x.saturating_add(rect.width));
		let rect = Rect::new(line_x, rect.y, line_right.saturating_sub(line_x), rect.height);
		self.bar.clear();
		repeated_char(&mut self.bar, horizontal, usize::from(rect.width));
		pc.frame.put(rect.x, rect.y, &self.bar, line);
		let middle = pc.ctx.charset.grid().middle;
		if let Some(edge) = join_left {
			let mut encoded = [0; 4];
			pc.frame
				.put(edge, rect.y, middle.0.encode_utf8(&mut encoded), line);
		}
		if let Some(edge) = join_right {
			let mut encoded = [0; 4];
			pc.frame
				.put(edge, rect.y, middle.2.encode_utf8(&mut encoded), line);
		}
		// `label` is the canonical section-header spelling. Keep `title` as a
		// compatibility fallback because it also supplies the established
		// alignment contract.
		if let Some(label) = self
			.props
			.str_of(Prop::Label)
			.or_else(|| self.props.title())
			.filter(|label| !label.is_empty())
			&& rect.width > 2
		{
			// The outermost rule cells are inviolable. Padding collapses only
			// at widths where retaining it would drop the label altogether.
			let interior = rect.width - 2;
			let left_pad = interior >= 2;
			let title_pad = self.props.title_pad();
			let mut right_pad = interior >= 3;
			let fit = if title_pad > 1 {
				interior
					.saturating_sub(u16::from(left_pad))
					.saturating_sub(u16::from(right_pad))
					.saturating_sub(title_pad)
			} else {
				interior
					.saturating_sub(u16::from(left_pad))
					.saturating_sub(u16::from(right_pad))
			};
			let authored = label;
			let mut label = truncate_to_width(authored, fit);
			if title_pad > 1 && label.ellipsis {
				right_pad = false;
				let fit = interior
					.saturating_sub(u16::from(left_pad))
					.saturating_sub(title_pad);
				label = truncate_to_width(authored, fit);
			}
			let total = label
				.width
				.saturating_add(u16::from(left_pad))
				.saturating_add(u16::from(right_pad));
			let x = match self.props.title_align() {
				Align::Start => rect
					.x
					.saturating_add(self.props.title_pad())
					.saturating_add(u16::from(join_left.is_none())),
				Align::Center => rect.x.saturating_add(rect.width.saturating_sub(total) / 2),
				Align::End => rect
					.x
					.saturating_add(rect.width.saturating_sub(2).saturating_sub(total)),
			}
			.clamp(
				rect.x.saturating_add(1),
				rect
					.x
					.saturating_add(rect.width.saturating_sub(1).saturating_sub(total)),
			);
			let gap_style = Style::new().bg(style.background_color());
			let label_style = if self.props.has_foreground() {
				style
			} else {
				gap_style
			};
			let mut end = x;
			if left_pad {
				end = pc.frame.put(end, rect.y, " ", gap_style);
			}
			end = pc.frame.put(end, rect.y, label.text, label_style);
			if label.ellipsis {
				end = pc.frame.put(end, rect.y, "…", label_style);
			}
			if right_pad {
				pc.frame.put(end, rect.y, " ", gap_style);
			}
		}
	}
}

fn find_border_left(frame: &crate::Frame, from: u16, y: u16, vertical: char) -> Option<u16> {
	let mut x = from;
	while x > 0 {
		x -= 1;
		let content = frame.cell(x, y).content();
		if is_vertical_border(content, vertical) {
			return Some(x);
		}
		if !is_blank(content) {
			return None;
		}
	}
	None
}

fn find_border_right(frame: &crate::Frame, mut x: u16, y: u16, vertical: char) -> Option<u16> {
	while x < frame.size().width {
		let content = frame.cell(x, y).content();
		if is_vertical_border(content, vertical) {
			return Some(x);
		}
		if !is_blank(content) {
			return None;
		}
		x += 1;
	}
	None
}

fn is_vertical_border(content: &CellContent, vertical: char) -> bool {
	matches!(
		content,
		CellContent::Grapheme { text, width: 1 }
			if {
				let mut chars = text.chars();
				chars.next() == Some(vertical) && chars.next().is_none()
			}
	)
}

fn is_blank(content: &CellContent) -> bool {
	matches!(content, CellContent::Blank)
		|| matches!(content, CellContent::Grapheme { text, width: 1 } if text.as_str() == " ")
}

/// Flexible blank space backing the `<spacer>` markup tag.
pub struct Spacer {
	props: Props,
	slot:  Slot,
}

impl Spacer {
	/// Creates an empty spacer.
	pub fn new() -> Self {
		Self { props: Props::new(), slot: next_slot() }
	}

	/// Sets one spacer property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one spacer property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self
	}
}

impl Default for Spacer {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Spacer {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn measure(&mut self, _ctx: &UiContext) -> (u16, u16) {
		(1, 4)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		1
	}

	fn paint(&mut self, _pc: &mut PaintCtx<'_>, _rect: Rect) {}
}

fn repeated_char(output: &mut String, character: char, count: usize) {
	output.reserve(count.saturating_mul(character.len_utf8()));
	output.extend(iter::repeat_n(character, count));
}

#[cfg(test)]
mod tests {
	use super::{Hr, truncate_to_width};
	use crate::{
		Style,
		component::{Cached, Component, PaintCtx},
		context::UiContext,
		frame::{Frame, Rect, Size},
		props::Prop,
		test_support::frame_row_text,
	};

	#[test]
	fn fills_horizontal_rule_with_charset_glyph() {
		let ctx = UiContext::default();
		let mut hr = Cached::new(Box::new(Hr::new()));
		assert_eq!(hr.measure(&ctx), (1, 4));
		hr.place(&ctx, Rect::new(0, 0, 6, 1));
		let mut frame = Frame::new(Size::new(6, 1));
		let mut hits = Vec::new();
		hr.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));
		assert_eq!(frame_row_text(&frame, 0), "──────");
	}

	#[test]
	fn canonical_label_truncates_between_boundary_cells() {
		let ctx = UiContext::default();
		for (width, expected) in [(7, "─ al… ─"), (3, "─…─"), (2, "──"), (1, "─")] {
			let mut hr = Cached::new(Box::new(Hr::new().with(Prop::Label, "alphabet")));
			hr.place(&ctx, Rect::new(0, 0, width, 1));
			let mut frame = Frame::new(Size::new(width, 1));
			let mut hits = Vec::new();
			hr.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));
			assert_eq!(frame_row_text(&frame, 0), expected);
		}
	}

	#[test]
	fn label_uses_theme_hierarchy_and_takes_precedence_over_title() {
		let ctx = UiContext::default();
		let mut hr = Hr::new()
			.with(Prop::Label, "Output")
			.with(Prop::Title, "Legacy");
		let mut frame = Frame::new(Size::new(12, 1));
		let mut hits = Vec::new();
		hr.paint(
			&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()),
			Rect::new(0, 0, 12, 1),
		);
		assert_eq!(frame_row_text(&frame, 0), "── Output ──");
		assert_eq!(frame.cell(3, 0).style, Style::new());
	}

	#[test]
	fn title_remains_a_compatible_label_fallback() {
		let ctx = UiContext::default();
		let mut hr = Hr::new().with(Prop::Title, "Legacy");
		let mut frame = Frame::new(Size::new(10, 1));
		let mut hits = Vec::new();
		hr.paint(
			&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()),
			Rect::new(0, 0, 10, 1),
		);
		assert_eq!(frame_row_text(&frame, 0), "─ Legacy ─");
	}

	#[test]
	fn wide_label_keeps_both_rule_endpoints() {
		let ctx = UiContext::default();
		let mut hr = Hr::new().with(Prop::Label, "界界");
		let mut frame = Frame::new(Size::new(7, 1));
		let mut hits = Vec::new();
		hr.paint(
			&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()),
			Rect::new(0, 0, 7, 1),
		);
		assert_eq!(frame_row_text(&frame, 0), "─ 界… ─");
	}

	#[test]
	fn title_truncation_respects_wide_grapheme_boundaries() {
		assert_eq!(truncate_to_width("界ab", 3), super::TruncatedText {
			text:     "界",
			width:    3,
			ellipsis: true,
		},);
		assert_eq!(truncate_to_width("界a", 3), super::TruncatedText {
			text:     "界a",
			width:    3,
			ellipsis: false,
		},);
	}

	#[test]
	fn vertical_rule_uses_one_column_and_fills_height() {
		let ctx = UiContext::default();
		let mut hr = Hr::new()
			.with(Prop::Vertical, true)
			.with(Prop::Label, "ignored");
		assert_eq!(hr.measure(&ctx), (1, 1));
		let mut frame = Frame::new(Size::new(1, 3));
		let mut hits = Vec::new();
		hr.paint(
			&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()),
			Rect::new(0, 0, 1, 3),
		);
		assert_eq!(frame_row_text(&frame, 0), "│");
		assert_eq!(frame_row_text(&frame, 1), "│");
		assert_eq!(frame_row_text(&frame, 2), "│");
	}
}
