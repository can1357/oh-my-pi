//! Bordered, cancellable loader: a full-width rule, an accent spinner with
//! a muted message, a blank
//! row, a muted cancel hint, a blank row, and a closing rule.
//!
//! The component owns no timer: the spinner glyph derives from
//! [`PaintCtx::now`] and the next repaint is requested with
//! [`PaintCtx::wake`], so it animates only while mounted. Cancellation is
//! the host's business (an escape binding); the loader only paints the hint.

use omp_core::{IntoStr, Str};

use crate::{
	component::{Component, PaintCtx, Slot, next_slot},
	context::UiContext,
	frame::{Rect, Style},
	props::{Prop, PropValue, Props},
	rich::cell_width,
};

/// Rows the loader occupies: two rules, the spinner row, the hint row, and
/// the two blank rows around the hint.
const ROWS: u16 = 6;

/// Cancellable loader wrapped in dynamic borders.
pub struct Loader {
	props:   Props,
	slot:    Slot,
	message: Str,
	hint:    Str,
	rule:    String,
}

impl Loader {
	/// Creates a loader for `message` with the default `esc cancel` hint.
	pub fn new(message: impl IntoStr) -> Self {
		Self {
			props:   Props::new(),
			slot:    next_slot(),
			message: message.into_str(),
			hint:    Str::new_static("esc cancel"),
			rule:    String::new(),
		}
	}

	/// Replaces the cancel hint (empty hides the row's text, not the row).
	pub fn hint(mut self, hint: impl IntoStr) -> Self {
		self.hint = hint.into_str();
		self
	}

	/// Sets one loader property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Replaces the message; returns whether it changed.
	pub fn set_message(&mut self, message: impl IntoStr) -> bool {
		let message = message.into_str();
		if self.message == message {
			return false;
		}
		self.message = message;
		true
	}

	/// Retains the rule row for `width` so repaints never allocate.
	fn refresh_rule(&mut self, glyph: char, width: u16) {
		let cells = usize::from(width);
		if self.rule.chars().count() != cells || !self.rule.starts_with(glyph) {
			self.rule.clear();
			self.rule.extend(std::iter::repeat_n(glyph, cells));
		}
	}
}

impl Component for Loader {
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
		(cell_width(&self.message).saturating_add(2), u16::MAX)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		ROWS
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if rect.width == 0 {
			return;
		}
		let theme = pc.ctx.theme;
		let border = Style::new().fg(theme.border);
		let accent = Style::new().fg(theme.accent);
		let muted = Style::new().fg(theme.muted);
		let glyph = pc.ctx.charset.rule();
		let frames = pc.ctx.charset.spinner();
		let now = pc.now;
		self.refresh_rule(glyph, rect.width);
		let clip = pc.clip;
		let row = |offset: u16| {
			let y = rect.y.saturating_add(offset);
			(y < clip).then_some(y)
		};
		if let Some(y) = row(0) {
			pc.frame.put(rect.x, y, &self.rule, border);
		}
		if let Some(y) = row(1) {
			let column = pc.frame.put(rect.x, y, frames.at(now), accent);
			let column = pc.frame.put(column, y, " ", muted);
			pc.frame.put(column, y, &self.message, muted);
		}
		if let Some(y) = row(3) {
			pc.frame.put(rect.x, y, &self.hint, muted);
		}
		if let Some(y) = row(5) {
			pc.frame.put(rect.x, y, &self.rule, border);
		}
		pc.wake(self.slot, frames.next_change(now));
	}

	fn set_text(&mut self, _ctx: &UiContext, text: Str) -> bool {
		self.set_message(text)
	}
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use super::*;
	use crate::{test_support::frame_row_text, ui::Ui};

	#[test]
	fn loader_paints_rules_spinner_message_and_hint_and_animates() {
		let mut ui = Ui::from_root(Loader::new("Compacting context…"), 24, UiContext::default());
		assert_eq!(frame_row_text(ui.frame(), 0), "─".repeat(24));
		assert_eq!(frame_row_text(ui.frame(), 1), "⠋ Compacting context…");
		assert_eq!(frame_row_text(ui.frame(), 2), "");
		assert_eq!(frame_row_text(ui.frame(), 3), "esc cancel");
		assert_eq!(frame_row_text(ui.frame(), 4), "");
		assert_eq!(frame_row_text(ui.frame(), 5), "─".repeat(24));
		assert_eq!(ui.frame().size().height, 6);
		assert_eq!(ui.next_wake(), Some(Duration::from_millis(80)));
		assert!(ui.tick(Duration::from_millis(80)));
		assert_eq!(frame_row_text(ui.frame(), 1), "⠙ Compacting context…");
	}

	#[test]
	fn loader_hint_and_message_are_replaceable() {
		let mut loader = Loader::new("Retrying").hint("esc to cancel");
		assert!(loader.set_message("Retrying (2/3)"));
		assert!(!loader.set_message("Retrying (2/3)"));
		let ui = Ui::from_root(loader, 30, UiContext::default());
		assert_eq!(frame_row_text(ui.frame(), 1), "⠋ Retrying (2/3)");
		assert_eq!(frame_row_text(ui.frame(), 3), "esc to cancel");
	}
}
