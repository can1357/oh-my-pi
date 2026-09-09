use super::layout::{stack_height, stack_measure, stack_place};
use crate::{
	component::{
		Cached, Component, EventCtx, Flow, HitTag, IntoChildren, PaintCtx, Slot, horizontal_inset,
		next_slot, vertical_inset,
	},
	context::UiContext,
	frame::{Rect, Style},
	input::{Key, Mouse, UiEvent},
	markup::Border,
	props::{Prop, PropValue, Props},
};

/// A bordered child stack backing the `<box>` markup tag.
///
/// A direct child with `kind=title` is the box's live title: it lays out on
/// the top border row where the `title` string would paint (after
/// `title-pad` rule cells and one space on each side) instead of in the
/// content stack, so a title can host animated components — a
/// `<spinner>`, a `<time>` badge — that a plain string cannot.
pub struct Boxed {
	props:    Props,
	slot:     Slot,
	/// The title child, when present, is always `children[0]`.
	children: Vec<Cached>,
	titled:   bool,
}

impl Boxed {
	/// Creates an empty box with the default border.
	pub fn new() -> Self {
		Self {
			props:    Props::new().with(Prop::Border, Border::default()),
			slot:     next_slot(),
			children: Vec::new(),
			titled:   false,
		}
	}

	/// The children stacked inside the border.
	fn body(&mut self) -> &mut [Cached] {
		&mut self.children[usize::from(self.titled)..]
	}

	/// Title placement on the top border row: the label origin (after the
	/// leading space) and the cells available to it.
	fn title_rect(&self, content: Rect) -> Rect {
		let x_inset = horizontal_inset(&self.props, true);
		let y_inset = vertical_inset(&self.props, true);
		let chrome_x = content.x.saturating_sub(x_inset);
		let chrome_width = content.width.saturating_add(x_inset.saturating_mul(2));
		let title_pad = self.props.title_pad();
		// Corner cells, the rule before the title, and one space per side.
		let reserved = title_pad.saturating_add(4);
		Rect::new(
			chrome_x.saturating_add(title_pad).saturating_add(2),
			content.y.saturating_sub(y_inset),
			chrome_width.saturating_sub(reserved),
			1,
		)
	}

	/// Sets one box property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one box property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Appends child components to the box; the first `kind=title` child
	/// becomes the live border title.
	pub fn child(mut self, children: impl IntoChildren) -> Self {
		let start = self.children.len();
		children.extend_children(&mut self.children);
		if !self.titled
			&& let Some(index) = self.children[start..].iter().position(|child| {
				child
					.comp()
					.props()
					.str_of(Prop::Kind)
					.is_some_and(|kind| kind == "title")
			}) {
			let title = self.children.remove(start + index);
			self.children.insert(0, title);
			self.titled = true;
		}
		self
	}
}

impl Default for Boxed {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Boxed {
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
		let (min, natural) = stack_measure(ctx, self.body());
		if !self.titled {
			return (min, natural);
		}
		let (_, title) = self.children[0].measure(ctx);
		// The title sits inside the border, so its natural width counts
		// against the content width the border already surrounds.
		let title = title
			.saturating_add(self.props.title_pad())
			.saturating_add(2)
			.saturating_sub(horizontal_inset(&self.props, true).saturating_mul(2));
		(min, natural.max(title))
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		let gap = self.props.gap();
		stack_height(ctx, self.body(), width, gap)
	}

	fn place(&mut self, ctx: &UiContext, content: Rect) {
		if self.titled {
			let rect = self.title_rect(content);
			let (_, natural) = self.children[0].measure(ctx);
			self.children[0].place(ctx, Rect { width: natural.min(rect.width).max(1), ..rect });
		}
		let (gap, valign, align) = (self.props.gap(), self.props.valign(), self.props.align());
		stack_place(ctx, self.body(), content, gap, valign, align);
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, content: Rect) {
		if self.titled && self.children[0].visible {
			let rect = self.title_rect(content);
			let placed = self.children[0].rect;
			if rect.y < pc.clip && rect.width > 0 {
				// Break the rule under the whole title span like a string
				// title does: the child's own layout gaps (a `<row gap>`)
				// paint nothing, so the rule must not show through them.
				let style = Style::new();
				let end = placed.x.saturating_add(placed.width);
				for x in rect.x.saturating_sub(1)..=end {
					pc.frame.put(x, rect.y, " ", style);
				}
				let clip = pc.clip;
				pc.clip = rect.y.saturating_add(1).min(clip);
				self.children[0].paint(pc);
				let gap = Style::new().bg(self.props.style(&pc.ctx.theme).background_color());
				pc.frame.put(end, rect.y, " ", gap);
				pc.clip = clip;
			}
		}
		for child in self.body().iter_mut().filter(|child| child.visible) {
			child.paint(pc);
		}
	}

	/// A focusable, `id`-carrying box presses like a button: Enter emits
	/// [`UiEvent::Pressed`] with its id.
	fn key(&mut self, _ec: &mut EventCtx<'_>, key: Key) -> Flow {
		if key == Key::Enter
			&& self.props.flag(Prop::Focus)
			&& let Some(id) = self.props.id()
		{
			return Flow::Event(UiEvent::Pressed(id.clone()));
		}
		Flow::Skip
	}

	/// Clicking the pointer zone presses the same way.
	fn mouse(
		&mut self,
		_ec: &mut EventCtx<'_>,
		tag: HitTag,
		_at: (u16, u16),
		_rect: Rect,
		mouse: Mouse,
	) -> Flow {
		if tag == HitTag::Zone
			&& mouse == Mouse::Click
			&& self.props.flag(Prop::Focus)
			&& let Some(id) = self.props.id()
		{
			return Flow::Event(UiEvent::Pressed(id.clone()));
		}
		Flow::Skip
	}
}

#[cfg(test)]
mod tests {
	use super::Boxed;
	use crate::{
		component::{Cached, PaintCtx},
		components::{Hr, TextLeaf},
		context::UiContext,
		frame::{Frame, Rect, Size},
		markup::Border,
		props::Prop,
		test_support::frame_row_text,
	};

	#[test]
	fn cached_paints_box_border_and_title() {
		let ctx = UiContext::default();
		let mut root = Cached::new(Box::new(
			Boxed::new()
				.with(Prop::Border, Border::Round)
				.with(Prop::Title, "Panel")
				.child(TextLeaf::new().text("body")),
		));
		let height = root.height(&ctx, 14);
		root.place(&ctx, Rect::new(0, 0, 14, height));
		let mut frame = Frame::new(Size::new(14, height));
		let mut hits = Vec::new();
		root.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));
		assert!(frame_row_text(&frame, 0).starts_with("╭─ Panel "));
		assert_eq!(frame_row_text(&frame, 1), "│body        │");
		assert_eq!(frame_row_text(&frame, height - 1), "╰────────────╯");
	}

	#[test]
	fn child_rule_joins_box_border() {
		let ctx = UiContext::default();
		let mut root = Cached::new(Box::new(
			Boxed::new()
				.with(Prop::Border, Border::Round)
				.child(TextLeaf::new().text("above"))
				.child(
					Hr::new()
						.with(Prop::Title, "Output")
						.with(Prop::TitlePad, 3_u16),
				)
				.child(TextLeaf::new().text("below")),
		));
		let height = root.height(&ctx, 16);
		root.place(&ctx, Rect::new(0, 0, 16, height));
		let mut frame = Frame::new(Size::new(16, height));
		let mut hits = Vec::new();
		root.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));
		assert_eq!(frame_row_text(&frame, 2), "├─── Output ───┤");
	}

	#[test]
	fn title_pad_retains_requested_rule_cells_before_title() {
		let ctx = UiContext::default();
		let mut root = Cached::new(Box::new(
			Boxed::new()
				.with(Prop::Border, Border::Round)
				.with(Prop::Title, "Panel")
				.with(Prop::TitlePad, 3_u16)
				.child(TextLeaf::new().text("body")),
		));
		let height = root.height(&ctx, 16);
		root.place(&ctx, Rect::new(0, 0, 16, height));
		let mut frame = Frame::new(Size::new(16, height));
		let mut hits = Vec::new();
		root.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));
		assert!(frame_row_text(&frame, 0).starts_with("╭─── Panel "));
	}

	#[test]
	fn kind_title_child_paints_on_the_top_border_and_animates() {
		use crate::{
			components::{Row, Spinner},
			ui::Ui,
		};
		let mut ui = Ui::from_root(
			Boxed::new()
				.with(Prop::Border, Border::Round)
				.with(Prop::TitlePad, 3_u16)
				.child(
					Row::new()
						.with(Prop::Kind, "title")
						.with(Prop::Gap, 1_u16)
						.child(Spinner::new().with(Prop::Kind, "status"))
						.child(TextLeaf::new().text("running")),
				)
				.child(TextLeaf::new().text("body")),
			20,
			UiContext::default(),
		);
		assert_eq!(frame_row_text(ui.frame(), 0), "╭─── ⣾ running ────╮");
		assert_eq!(frame_row_text(ui.frame(), 1), "│body              │");
		assert_eq!(ui.height(), 3, "the title takes no content row");
		assert_eq!(ui.next_wake(), Some(std::time::Duration::from_millis(80)));
		ui.tick(std::time::Duration::from_millis(80));
		assert_eq!(frame_row_text(ui.frame(), 0), "╭─── ⣽ running ────╮");
	}

	#[test]
	fn box_title_truncates_between_corner_cells_at_boundary_widths() {
		let ctx = UiContext::default();
		for (width, expected) in [(7, "╭ al… ╮"), (5, "╭ … ╮"), (4, "╭ …╮"), (3, "╭…╮")]
		{
			let mut root = Cached::new(Box::new(
				Boxed::new()
					.with(Prop::Border, Border::Round)
					.with(Prop::Title, "alphabet")
					.child(TextLeaf::new().text("")),
			));
			let height = root.height(&ctx, width);
			root.place(&ctx, Rect::new(0, 0, width, height));
			let mut frame = Frame::new(Size::new(width, height));
			let mut hits = Vec::new();
			root.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));
			assert_eq!(frame_row_text(&frame, 0), expected);
		}
	}
}
