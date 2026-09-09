use omp_core::{IntoStr, Str};
use smallvec::SmallVec;

use super::Col;
use crate::{
	Frame,
	component::{
		Cached, Component, EventCtx, Flow, Hit, HitTag, IntoChildren, PaintCtx, Slot, next_slot,
	},
	context::UiContext,
	frame::{Color, Rect, Style},
	input::{Key, Mouse},
	props::{Prop, PropValue, Props},
	rich::cell_width,
};

#[derive(Default)]
struct TabsState {
	titles: SmallVec<Str, 6>,
	icons:  SmallVec<Str, 6>,
	muted:  SmallVec<bool, 6>,
	panes:  Vec<Cached>,
	idx:    u16,
	rule:   String,
}
/// One chip's placement decided by [`Tabs::chip_layout`].
#[derive(Clone, Copy)]
struct Chip {
	index: u16,
	row:   u16,
	start: u16,
	end:   u16,
	/// Whether the label renders; icon-only chips collapse to their glyph.
	full:  bool,
}

/// A switchable pane set backing the `<tabs>` markup tag.
pub struct Tabs {
	props: Props,
	slot:  Slot,
	state: TabsState,
}

impl Tabs {
	/// Creates an empty tab set.
	pub fn new() -> Self {
		Self { props: Props::new(), slot: next_slot(), state: TabsState::default() }
	}

	/// Sets one tab-set property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one tab-set property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Appends an untitled pane.
	pub fn child(self, children: impl IntoChildren) -> Self {
		self.pane("tab", children)
	}

	/// Appends a pane with the supplied title.
	pub fn pane(self, title: impl IntoStr, children: impl IntoChildren) -> Self {
		self.pane_icon("", title, children)
	}

	/// Appends a pane with an icon (an `icons.tsv` name) and title. The icon
	/// leads the chip; when the bar overflows, trailing inactive chips
	/// collapse to their icon alone.
	pub fn pane_icon(
		self,
		icon: impl IntoStr,
		title: impl IntoStr,
		children: impl IntoChildren,
	) -> Self {
		self.pane_icon_muted(icon, title, false, children)
	}

	/// Appends an icon pane whose inactive chip may be visually muted.
	///
	/// Muted panes remain in the focus and pointer order; this is intended
	/// for filters that retain zero-match tabs while de-emphasizing them.
	pub fn pane_icon_muted(
		mut self,
		icon: impl IntoStr,
		title: impl IntoStr,
		muted: bool,
		children: impl IntoChildren,
	) -> Self {
		let mut pane = Vec::new();
		children.extend_children(&mut pane);
		let pane = if pane.len() == 1 {
			pane.pop().expect("one pane child")
		} else {
			Cached::new(Box::new(Col::new().child(pane)))
		};
		self.state.titles.push(title.into_str());
		self.state.icons.push(icon.into_str());
		self.state.muted.push(muted);
		self.state.panes.push(pane);
		self
	}

	/// Selects the active pane; out-of-range indices clamp to the last pane.
	pub const fn select(mut self, index: u16) -> Self {
		self.state.idx = index;
		self
	}

	fn active(&self) -> Option<usize> {
		let index = usize::from(self.state.idx);
		(!self.state.panes.is_empty()).then(|| index.min(self.state.panes.len() - 1))
	}

	/// The chip's rendered icon glyph, or `""` when it has none.
	fn icon_glyph(&self, ctx: &UiContext, index: usize) -> &'static str {
		let name = &self.state.icons[index];
		if name.is_empty() {
			""
		} else {
			ctx.charset.icon_named(name).unwrap_or("")
		}
	}

	/// Chip width with icon and label, including the one-cell caps.
	fn full_width(&self, ctx: &UiContext, index: usize) -> u16 {
		let icon = self.icon_glyph(ctx, index);
		let icon_width = if icon.is_empty() {
			0
		} else {
			cell_width(icon).saturating_add(1)
		};
		icon_width
			.saturating_add(cell_width(&self.state.titles[index]))
			.saturating_add(2)
	}

	/// Collapsed icon-only chip width; chips without an icon cannot shrink.
	fn min_width(&self, ctx: &UiContext, index: usize) -> u16 {
		let icon = self.icon_glyph(ctx, index);
		if icon.is_empty() {
			self.full_width(ctx, index)
		} else {
			cell_width(icon).saturating_add(2)
		}
	}

	/// Places every chip on the bar. Chips render icon+label left to right
	/// while everything still fits on one row; past that point inactive
	/// chips collapse to icon-only (the active chip always keeps its label).
	/// If even the collapsed bar overflows, chips wrap onto further rows.
	/// Returns the number of bar rows.
	fn chip_layout(&self, ctx: &UiContext, width: u16, mut visit: impl FnMut(&Chip)) -> u16 {
		let count = self.state.titles.len();
		if count == 0 {
			return 1;
		}
		let active = usize::from(self.state.idx).min(count - 1);
		// Largest prefix of full-label chips whose bar still fits one row.
		let mut keep = count;
		while keep > 0 {
			let mut total = 2u16;
			for index in 0..count {
				let chip = if index < keep || index == active {
					self.full_width(ctx, index)
				} else {
					self.min_width(ctx, index)
				};
				total = total
					.saturating_add(chip)
					.saturating_add(u16::from(index > 0) * 2);
			}
			if total <= width {
				break;
			}
			keep -= 1;
		}
		let mut row = 0u16;
		let mut x = 2u16;
		for index in 0..count {
			let full = index < keep || index == active;
			let chip = if full {
				self.full_width(ctx, index)
			} else {
				self.min_width(ctx, index)
			};
			if x > 2 && x.saturating_add(chip) > width {
				row = row.saturating_add(1);
				x = 2;
			}
			visit(&Chip { index: index as u16, row, start: x, end: x.saturating_add(chip), full });
			x = x.saturating_add(chip).saturating_add(2);
		}
		row.saturating_add(1)
	}

	/// Bar rows the chip layout needs at `width`.
	fn bar_rows(&self, ctx: &UiContext, width: u16) -> u16 {
		self.chip_layout(ctx, width, |_| ())
	}
}

impl Default for Tabs {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Tabs {
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
		&self.state.panes
	}

	fn children_mut(&mut self) -> &mut [Cached] {
		&mut self.state.panes
	}

	fn measure(&mut self, ctx: &UiContext) -> (u16, u16) {
		let bar = self
			.state
			.titles
			.iter()
			.fold(2u16, |width, title| width.saturating_add(cell_width(title).saturating_add(4)));
		let mut nat = bar;
		for pane in &mut self.state.panes {
			nat = nat.max(pane.measure(ctx).1);
		}
		(bar.min(24), nat)
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		let pane_height = self
			.active()
			.and_then(|index| self.state.panes.get_mut(index))
			.filter(|pane| pane.visible)
			.map_or(0, |pane| pane.height(ctx, width));
		let bar = self.bar_rows(ctx, width).saturating_add(1);
		pane_height.saturating_add(bar)
	}

	fn place(&mut self, ctx: &UiContext, content: Rect) {
		let bar = self.bar_rows(ctx, content.width).saturating_add(1);
		let Some(index) = self.active() else {
			return;
		};
		let pane = &mut self.state.panes[index];
		if !pane.visible {
			return;
		}
		let width = content.width;
		let height = pane.height(ctx, width);
		pane.place(ctx, Rect::new(content.x, content.y.saturating_add(bar), width, height));
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		let focused = pc.focus == Some(self.slot);
		let hover_chip = match pc.hover {
			Some((slot, HitTag::Chip(index))) if slot == self.slot => Some(index),
			_ => None,
		};
		let ctx = pc.ctx;
		if rect.y < pc.clip {
			pc.frame.put(
				rect.x,
				rect.y,
				if focused {
					pc.ctx.charset.cursor()
				} else {
					"  "
				},
				Style::new().fg(pc.ctx.theme.accent),
			);
		}
		let idx = self.state.idx;
		let slot = self.slot;
		let titles = &self.state.titles;
		let icons = &self.state.icons;
		let muted = &self.state.muted;
		let bar_rows = self.chip_layout(ctx, rect.width, |chip| {
			let y = rect.y.saturating_add(chip.row);
			if y >= pc.clip {
				return;
			}
			let index = usize::from(chip.index);
			let title = &titles[index];
			let icon = if icons[index].is_empty() {
				""
			} else {
				ctx.charset.icon_named(&icons[index]).unwrap_or("")
			};
			let x = rect.x.saturating_add(chip.start);
			let active = chip.index == idx;
			let hovered = hover_chip == Some(chip.index);
			let is_muted = muted.get(index).copied().unwrap_or(false);
			if active && !is_muted {
				pill(
					pc.frame,
					x,
					y,
					icon,
					title,
					ctx.theme.accent,
					ctx.theme.contrast,
					ctx.charset.pill_caps(),
					focused || hovered,
				);
			} else {
				let mut style = Style::new().fg(if is_muted {
					ctx.theme.dim
				} else if hovered {
					ctx.theme.fg
				} else {
					ctx.theme.muted
				});
				if hovered {
					style = style.underline();
				}
				let mut text_x = pc.frame.put(x, y, " ", Style::new().fg(ctx.theme.fg));
				if !icon.is_empty() {
					text_x = pc.frame.put(text_x, y, icon, style);
					if chip.full {
						text_x = pc.frame.put(text_x, y, " ", style);
					}
				}
				if chip.full || icon.is_empty() {
					text_x = pc.frame.put(text_x, y, title, style);
				}
				pc.frame.put(text_x, y, " ", Style::new().fg(ctx.theme.fg));
			}
			pc.hits.push(Hit {
				rect: Rect::new(x, y, chip.end.saturating_sub(chip.start), 1),
				slot,
				tag: HitTag::Chip(chip.index),
			});
		});
		if rect.y.saturating_add(bar_rows) < pc.clip {
			self.state.rule.clear();
			for _ in 0..rect.width {
				self.state.rule.push(pc.ctx.charset.rule());
			}
			pc.frame.put(
				rect.x,
				rect.y.saturating_add(bar_rows),
				&self.state.rule,
				Style::new().fg(pc.ctx.theme.muted),
			);
		}
		let Some(index) = self.active() else {
			return;
		};
		let pane = &mut self.state.panes[index];
		if pane.visible {
			pane.paint(pc);
		}
	}

	fn focusable(&self) -> bool {
		true
	}

	fn ring(&self, out: &mut Vec<Slot>) {
		out.push(self.slot);
		if let Some(index) = self.active()
			&& let Some(pane) = self.state.panes.get(index)
			&& pane.visible
		{
			pane.comp().ring(out);
		}
	}

	fn key(&mut self, _ec: &mut EventCtx<'_>, key: Key) -> Flow {
		let len = self.state.titles.len() as u16;
		match key {
			Key::Left if len > 0 => {
				self.state.idx = (self.state.idx + len - 1) % len;
				Flow::Consumed
			},
			Key::Right if len > 0 => {
				self.state.idx = (self.state.idx + 1) % len;
				Flow::Consumed
			},
			_ => Flow::Skip,
		}
	}

	fn mouse(
		&mut self,
		_ec: &mut EventCtx<'_>,
		tag: HitTag,
		_at: (u16, u16),
		_rect: Rect,
		mouse: Mouse,
	) -> Flow {
		match mouse {
			Mouse::Click => {
				let HitTag::Chip(index) = tag else {
					return Flow::Skip;
				};
				if usize::from(index) >= self.state.titles.len() {
					return Flow::Skip;
				}
				self.state.idx = index;
				Flow::Consumed
			},
			Mouse::RightClick
			| Mouse::MiddleClick
			| Mouse::Move
			| Mouse::Drag
			| Mouse::Release
			| Mouse::WheelUp
			| Mouse::WheelDown
			| Mouse::WheelLeft
			| Mouse::WheelRight => Flow::Skip,
		}
	}

	fn value(&self, out: &mut serde_json::Map<String, serde_json::Value>) {
		let Some(id) = self.props.id() else {
			return;
		};
		let value = self
			.state
			.titles
			.get(usize::from(self.state.idx))
			.map_or(serde_json::Value::Null, |title| serde_json::Value::String(title.to_string()));
		out.insert(id.to_string(), value);
	}
}

fn pill(
	frame: &mut Frame,
	x: u16,
	y: u16,
	icon: &str,
	label: &str,
	bg: Color,
	fg: Color,
	caps: (&str, &str),
	highlight: bool,
) -> u16 {
	let bg = if highlight { brighten(bg) } else { bg };
	let cap = Style::new().fg(bg);
	let body = Style::new().fg(fg).bg(bg).bold();
	let mut x = frame.put(x, y, caps.0, cap);
	if !icon.is_empty() {
		x = frame.put(x, y, icon, body);
		x = frame.put(x, y, " ", body);
	}
	x = frame.put(x, y, label, body);
	frame.put(x, y, caps.1, cap)
}

fn brighten(color: Color) -> Color {
	match color {
		Color::Rgb(r, g, b) => Color::Rgb(
			r.saturating_add((255 - u16::from(r)) as u8 / 5),
			g.saturating_add((255 - u16::from(g)) as u8 / 5),
			b.saturating_add((255 - u16::from(b)) as u8 / 5),
		),
		other => other,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{Frame, Size, component::Component, components::Pre, test_support::frame_row_text};

	struct FocusProbe {
		props: Props,
		slot:  Slot,
		text:  &'static str,
	}

	impl FocusProbe {
		fn new(text: &'static str) -> Self {
			Self { props: Props::new(), slot: next_slot(), text }
		}
	}

	impl Component for FocusProbe {
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
			(3, 3)
		}

		fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
			1
		}

		fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
			pc.frame.put(rect.x, rect.y, self.text, Style::default());
		}

		fn focusable(&self) -> bool {
			true
		}
	}

	#[test]
	fn switching_panes_changes_paint_value_and_ring() {
		let ctx = UiContext::default();
		let first = FocusProbe::new("one");
		let first_slot = first.slot;
		let second = FocusProbe::new("two");
		let second_slot = second.slot;
		let mut tabs = Tabs::new()
			.with(Prop::Id, "tab-id")
			.pane("First", first)
			.pane("Second", second);
		let tabs_slot = tabs.slot;
		tabs.place(&ctx, Rect::new(0, 0, 24, 3));
		let mut ring = Vec::new();
		tabs.ring(&mut ring);
		assert_eq!(ring, vec![tabs_slot, first_slot]);

		let mut frame = Frame::new(Size::new(24, 3));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
		tabs.paint(&mut pc, Rect::new(0, 0, 24, 3));
		assert_eq!(frame_row_text(pc.frame, 2), "one");

		let mut ec = EventCtx::new(&ctx, 24, 3);
		assert_eq!(tabs.key(&mut ec, Key::Right), Flow::Consumed);
		tabs.place(&ctx, Rect::new(0, 0, 24, 3));
		pc.frame.clear(Style::default());
		pc.hits.clear();
		tabs.paint(&mut pc, Rect::new(0, 0, 24, 3));
		assert_eq!(frame_row_text(pc.frame, 2), "two");
		ring.clear();
		tabs.ring(&mut ring);
		assert_eq!(ring, vec![tabs_slot, second_slot]);
		let mut values = serde_json::Map::new();
		tabs.value(&mut values);
		assert_eq!(values["tab-id"], serde_json::json!("Second"));
	}

	#[test]
	fn pane_accepts_multiple_children() {
		let tabs = Tabs::new().pane("many", vec![Pre::new().text("a"), Pre::new().text("b")]);
		assert_eq!(tabs.state.panes.len(), 1);
		assert_eq!(tabs.state.panes[0].comp().children().len(), 2);
	}

	#[test]
	fn muted_panes_retain_position_and_paint_with_the_dim_token() {
		let ctx = UiContext::default();
		let mut tabs = Tabs::new()
			.pane_icon("tab.files", "Files", ())
			.pane_icon_muted("tab.tools", "Tools", true, ());
		assert_eq!(tabs.state.titles.as_slice(), ["Files", "Tools"]);
		assert_eq!(tabs.state.muted.as_slice(), [false, true]);
		assert_eq!(tabs.state.panes.len(), 2);

		tabs.place(&ctx, Rect::new(0, 0, 40, 2));
		let mut frame = Frame::new(Size::new(40, 2));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
		tabs.paint(&mut pc, Rect::new(0, 0, 40, 2));
		let tools = (0..40)
			.find(|x| {
				matches!(
					pc.frame.cell(*x, 0).content(),
					crate::CellContent::Grapheme { text, .. } if text == "T"
				)
			})
			.expect("muted Tools label");
		assert_eq!(pc.frame.cell(tools, 0).style().foreground_color(), ctx.theme.dim);
	}
}
