use crate::{
	Icon,
	component::{Component, EventCtx, Flow, Hit, HitTag, PaintCtx, Slot, next_slot},
	context::UiContext,
	frame::{Rect, Style},
	input::{Key, Mouse},
	props::{Prop, PropValue, Props},
	rich::cell_width,
};

/// A standalone boolean control with a charset-aware check mark.
pub struct Checkbox {
	props:   Props,
	slot:    Slot,
	checked: bool,
}

impl Checkbox {
	/// Creates an unchecked checkbox.
	pub fn new() -> Self {
		Self { props: Props::new(), slot: next_slot(), checked: false }
	}

	/// Sets one checkbox property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		if prop == Prop::Checked {
			self.checked = self.props.flag(Prop::Checked);
		}
		self
	}

	/// Sets one checkbox property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		if prop == Prop::Checked {
			self.checked = self.props.flag(Prop::Checked);
		}
		self
	}

	const fn toggle(&mut self) -> Flow {
		self.checked = !self.checked;
		Flow::Consumed
	}

	fn label(&self) -> &str {
		self
			.props
			.str_of(Prop::Label)
			.map_or("", |value| value.as_str())
	}
}

impl Default for Checkbox {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Checkbox {
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
		let icon = if self.checked {
			Icon::Checked
		} else {
			Icon::Unchecked
		};
		let gap = u16::from(!self.label().is_empty());
		let width = cell_width(ctx.charset.icon(icon))
			.saturating_add(gap)
			.saturating_add(cell_width(self.label()));
		(width, width)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		1
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if rect.y >= pc.clip || rect.width == 0 || rect.height == 0 {
			return;
		}
		pc.hits
			.push(Hit { rect, slot: self.slot, tag: HitTag::Press });
		let focused = pc.focus == Some(self.slot);
		let hovered = matches!(pc.hover, Some((slot, _)) if slot == self.slot);
		let icon = if self.checked {
			Icon::Checked
		} else {
			Icon::Unchecked
		};
		let mut icon_style = Style::new().fg(if self.checked {
			pc.ctx.theme.accent
		} else {
			pc.ctx.theme.muted
		});
		let mut label_style = Style::new().fg(pc.ctx.theme.fg);
		if hovered {
			icon_style = icon_style.bg(pc.ctx.theme.hover);
			label_style = label_style.bg(pc.ctx.theme.hover);
		}
		if focused {
			label_style = label_style.underline();
		}
		let mut x = pc
			.frame
			.put(rect.x, rect.y, pc.ctx.charset.icon(icon), icon_style);
		if !self.label().is_empty() {
			x = pc.frame.put(x, rect.y, " ", label_style);
			pc.frame.put(x, rect.y, self.label(), label_style);
		}
	}

	fn focusable(&self) -> bool {
		true
	}

	fn key(&mut self, _ec: &mut EventCtx<'_>, key: Key) -> Flow {
		match key {
			Key::Enter | Key::Space => self.toggle(),
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
			Mouse::Click if tag == HitTag::Press => self.toggle(),
			Mouse::Click
			| Mouse::RightClick
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
		if let Some(id) = self.props.id() {
			out.insert(id.to_string(), serde_json::Value::Bool(self.checked));
		}
	}
}
