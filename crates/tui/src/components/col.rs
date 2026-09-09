use super::{
	layout::{stack_height, stack_measure, stack_place},
	overflow_plan, paint_overflow_footer,
};
use crate::{
	component::{
		Cached, Component, EventCtx, Flow, HitTag, IntoChildren, PaintCtx, Slot, next_slot,
	},
	context::UiContext,
	frame::Rect,
	input::{Key, Mouse, UiEvent},
	props::{Prop, PropValue, Props},
};

/// A vertical child stack backing the `<col>` markup tag.
pub struct Col {
	props:        Props,
	slot:         Slot,
	children:     Vec<Cached>,
	natural_rows: u16,
}

impl Col {
	/// Creates an empty column.
	pub fn new() -> Self {
		Self {
			props:        Props::new(),
			slot:         next_slot(),
			children:     Vec::new(),
			natural_rows: 0,
		}
	}

	/// Sets one column property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one column property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Appends child components to the column.
	pub fn child(mut self, children: impl IntoChildren) -> Self {
		children.extend_children(&mut self.children);
		self
	}
}

impl Default for Col {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Col {
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
		stack_measure(ctx, &mut self.children)
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		self.natural_rows = stack_height(ctx, &mut self.children, width, self.props.gap());
		self
			.props
			.max_rows()
			.map_or(self.natural_rows, |cap| self.natural_rows.min(cap))
	}

	fn place(&mut self, ctx: &UiContext, content: Rect) {
		self.natural_rows = stack_height(ctx, &mut self.children, content.width, self.props.gap());
		let layout = if overflow_plan(&self.props, self.natural_rows, content.height).is_some() {
			Rect::new(content.x, content.y, content.width, self.natural_rows)
		} else {
			content
		};
		stack_place(
			ctx,
			&mut self.children,
			layout,
			self.props.gap(),
			self.props.valign(),
			self.props.align(),
		);
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		let Some(plan) = overflow_plan(&self.props, self.natural_rows, rect.height) else {
			for child in self.children.iter_mut().filter(|child| child.visible) {
				child.paint(pc);
			}
			return;
		};
		let clip = plan.content_rows;
		let original_clip = pc.clip;
		pc.clip = pc.clip.min(rect.y.saturating_add(clip));
		let paint_clip = pc.clip;
		for child in self
			.children
			.iter_mut()
			.filter(|child| child.visible && child.rect.y < paint_clip)
		{
			child.paint(pc);
		}
		pc.clip = original_clip;
		paint_overflow_footer(pc, rect, plan);
	}

	fn key(&mut self, _ec: &mut EventCtx<'_>, key: Key) -> Flow {
		if key == Key::Enter
			&& self.props.flag(Prop::Focus)
			&& let Some(id) = self.props.id()
		{
			return Flow::Event(UiEvent::Pressed(id.clone()));
		}
		Flow::Skip
	}

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
	use super::Col;
	use crate::{
		component::{Cached, PaintCtx},
		components::TextLeaf,
		context::UiContext,
		frame::{Frame, Rect, Size},
		props::Prop,
		test_support::frame_row_text,
	};

	#[test]
	fn stacks_children_with_gap() {
		let ctx = UiContext::default();
		let mut root = Cached::new(Box::new(
			Col::new()
				.with(Prop::Gap, 1_u16)
				.child(TextLeaf::new().text("first"))
				.child(TextLeaf::new().text("second")),
		));
		let height = root.height(&ctx, 12);
		assert_eq!(height, 3);
		root.place(&ctx, Rect::new(0, 0, 12, height));
		let mut frame = Frame::new(Size::new(12, height));
		let mut hits = Vec::new();
		root.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));
		assert_eq!(frame_row_text(&frame, 0), "first");
		assert_eq!(frame_row_text(&frame, 1), "");
		assert_eq!(frame_row_text(&frame, 2), "second");
	}

	#[test]
	fn max_rows_clamps_physical_rows_and_owns_one_footer() {
		let ctx = UiContext::default();
		let mut root = Cached::new(Box::new(
			Col::new()
				.with(Prop::MaxRows, 3_u16)
				.with(Prop::Overflow, "rows")
				.child(TextLeaf::new().text("a\nb\nc\nd")),
		));
		let height = root.height(&ctx, 16);
		assert_eq!(height, 3);
		root.place(&ctx, Rect::new(0, 0, 16, height));
		let mut frame = Frame::new(Size::new(16, height));
		let mut hits = Vec::new();
		root.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));
		assert_eq!(frame_row_text(&frame, 0), "a");
		assert_eq!(frame_row_text(&frame, 1), "b");
		assert_eq!(frame_row_text(&frame, 2), "… 2 more rows");
	}
}
