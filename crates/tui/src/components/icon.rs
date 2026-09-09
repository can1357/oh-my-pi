use omp_core::{IntoStr, Str};

use crate::{
	UiContext,
	component::{Component, PaintCtx, Slot, next_slot},
	frame::Rect,
	props::{Prop, PropValue, Props},
	rich::cell_width,
};

/// A theme-resolved glyph backing the `<icon>` markup tag.
pub struct Icon {
	props: Props,
	slot:  Slot,
	name:  Str,
}

impl Icon {
	/// Creates an icon with no assigned name.
	pub fn new() -> Self {
		Self { props: Props::new(), slot: next_slot(), name: Str::default() }
	}

	/// Creates an icon with the requested theme glyph name.
	pub fn named(name: impl IntoStr) -> Self {
		Self { name: name.into_str(), ..Self::new() }
	}

	/// Sets one icon property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one icon property from a string.
	pub fn with_str(self, prop: Prop, value: &str) -> Self {
		self.with(prop, value)
	}

	fn glyph<'a>(&'a self, ctx: &'a UiContext) -> &'a str {
		ctx.charset.icon_named(&self.name).unwrap_or(&self.name)
	}
}

impl Default for Icon {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Icon {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn measure(&mut self, ctx: &UiContext) -> (u16, u16) {
		let width = cell_width(self.glyph(ctx));
		(width, width)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		1
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if rect.y >= pc.clip || rect.width == 0 || rect.height == 0 {
			return;
		}
		let glyph = self.glyph(pc.ctx);
		let mut style = self.props.style(&pc.ctx.theme);
		if !self.props.contains(Prop::Fg) {
			style = style.fg(match self.name.as_str() {
				"error" => pc.ctx.theme.err,
				"done" | "success" => pc.ctx.theme.ok,
				"pending" => pc.ctx.theme.output,
				_ => pc.ctx.theme.accent,
			});
		}
		let room = rect.width;
		if cell_width(glyph) <= room {
			pc.frame.put(rect.x, rect.y, glyph, style);
		}
	}
}
