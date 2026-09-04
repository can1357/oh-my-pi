//! The block-grid brand mark painted through a diagonal gradient, with a
//! one-shot intro sweep.

use std::time::Duration;

use crate::{
	Charset,
	anim::{self, Gradient, Intro},
	component::{Component, PaintCtx, Slot, next_slot},
	context::UiContext,
	frame::{Color, Rect, Style},
	props::{Prop, PropValue, Props},
};

/// Brand mark rows; every non-space cell participates in the same diagonal
/// gradient.
const MARK: [&str; 5] =
	["████████████", "   ██  ██   ", "   ██  ██   ", "   ▒▒  ██   ", "       ██   "];
/// The same mark for a terminal that cannot show block elements
/// ([`Charset::Ascii`]): `#` for the full cell and `:` for the shaded cell.
/// Glyph presentation resolves through the charset (ADR 0032), never by
/// hand-emitting block characters.
const MARK_ASCII: [&str; 5] =
	["############", "   ##  ##   ", "   ##  ##   ", "   ::  ##   ", "       ##   "];
const ROWS: usize = MARK.len();
const COLS: usize = 12;

/// The mark rows for `charset`.
const fn mark(charset: Charset) -> &'static [&'static str; ROWS] {
	match charset {
		Charset::Ascii => &MARK_ASCII,
		Charset::Unicode | Charset::NerdFont => &MARK,
	}
}

/// The brand mark: a 12×5 block grid painted through [`Gradient`].
///
/// With [`intro`](Self::intro) the mark plays a 3000ms sweep on the paint
/// clock — waking every [`anim::FRAME`] until it settles — and then
/// paints the resting frame forever without asking for another wake.
/// Diagonal positions are computed once at construction, so a paint pass
/// allocates nothing.
pub struct Brand {
	props:    Props,
	slot:     Slot,
	/// Per-cell diagonal position before any phase shift.
	diagonal: [[f32; COLS]; ROWS],
	/// Intro time already elapsed when this component's clock started;
	/// `None` paints the resting frame.
	intro:    Option<Duration>,
}

impl Brand {
	/// Creates the mark on its resting frame.
	#[must_use]
	pub fn new() -> Self {
		let mut diagonal = [[0.0; COLS]; ROWS];
		for (y, row) in diagonal.iter_mut().enumerate() {
			for (x, cell) in row.iter_mut().enumerate() {
				*cell = Gradient::diagonal(x as u16, y as u16, COLS as u16, ROWS as u16);
			}
		}
		Self { props: Props::new(), slot: next_slot(), diagonal, intro: None }
	}

	/// Plays the intro. `elapsed` is how far into the 3000ms sweep the
	/// intro already is when this component's clock reads zero — pass
	/// [`Duration::ZERO`] for a fresh start; a host that remounts the mark
	/// mid-sweep passes the time it has already shown.
	#[must_use]
	pub const fn intro(mut self, elapsed: Duration) -> Self {
		self.intro = Some(elapsed);
		self
	}

	/// Sets one property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		let () = self.props.set(prop, value.into());
		self
	}

	/// Cell size of the mark.
	#[must_use]
	pub const fn size() -> (u16, u16) {
		(COLS as u16, ROWS as u16)
	}

	/// Intro time elapsed at `now` on this component's clock.
	fn elapsed(&self, now: Duration) -> Option<Duration> {
		self.intro.map(|offset| offset.saturating_add(now))
	}

	/// Whether the intro has finished (or never ran) at `now`.
	#[must_use]
	pub fn settled(&self, now: Duration) -> bool {
		self.elapsed(now).is_none_or(Intro::done)
	}

	/// The next paint the running intro needs after `now`, if any.
	#[must_use]
	pub fn next_wake(&self, now: Duration) -> Option<Duration> {
		(!self.settled(now)).then(|| now.saturating_add(anim::FRAME))
	}

	/// Paints the mark with its top-left cell at `(x, y)`, clipped by `pc`.
	/// Hosts embedding the mark inside their own paint call this and forward
	/// [`next_wake`](Self::next_wake) to their own slot.
	pub fn paint_at(&self, pc: &mut PaintCtx<'_>, x: u16, y: u16) {
		let (phase, shine) = self.elapsed(pc.now).map_or((0.0, None), Intro::frame);
		let gradient = Gradient::shifted(phase);
		// Terminals without truecolor run a quantized theme (every token
		// indexed); the accent is the tell.
		let truecolor = matches!(pc.ctx.theme.accent, Color::Rgb(..));
		let mut utf8 = [0; 4];
		for (row, line) in mark(pc.ctx.charset).iter().enumerate() {
			let y = y.saturating_add(row as u16);
			if y >= pc.clip {
				return;
			}
			for (column, glyph) in line.chars().enumerate() {
				if glyph == ' ' {
					continue;
				}
				let style =
					Style::new().fg(gradient.color(self.diagonal[row][column], shine, truecolor));
				pc.frame
					.put(x.saturating_add(column as u16), y, glyph.encode_utf8(&mut utf8), style);
			}
		}
	}
}

impl Default for Brand {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Brand {
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
		(COLS as u16, COLS as u16)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		ROWS as u16
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if rect.width == 0 || rect.height == 0 {
			return;
		}
		self.paint_at(pc, rect.x, rect.y);
		if let Some(at) = self.next_wake(pc.now) {
			pc.wake(self.slot, at);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{test_support::frame_row_text, ui::Ui};

	fn fg(ui: &Ui, x: u16, y: u16) -> Color {
		ui.frame().cell(x, y).style().foreground_color()
	}

	#[test]
	fn resting_mark_paints_pi_corners_and_never_wakes() {
		let ui = Ui::from_root(Brand::new(), 12, UiContext::default());
		assert_eq!(frame_row_text(ui.frame(), 0), "████████████");
		assert_eq!(frame_row_text(ui.frame(), 3), "   ▒▒  ██");
		assert_eq!(fg(&ui, 0, 0), Color::Rgb(248, 79, 204));
		assert_eq!(fg(&ui, 11, 0), Color::Rgb(147, 98, 244));
		assert_eq!(
			fg(&ui, 8, 4),
			Gradient::default().color(Gradient::diagonal(8, 4, 12, 5), None, true)
		);
		assert_eq!(
			fg(&ui, 3, 3),
			Gradient::default().color(Gradient::diagonal(3, 3, 12, 5), None, true),
			"shaded cells share the diagonal gradient",
		);
		assert_eq!(ui.next_wake(), None);
	}

	#[test]
	fn intro_wakes_each_frame_until_it_settles() {
		let mut ui = Ui::from_root(Brand::new().intro(Duration::ZERO), 12, UiContext::default());
		let first = fg(&ui, 0, 0);
		assert_eq!(ui.next_wake(), Some(anim::FRAME));
		assert!(ui.tick(Duration::from_millis(1_500)));
		let mid = fg(&ui, 0, 0);
		assert_ne!(first, mid, "the sweep moves the corner color");
		assert_eq!(ui.next_wake(), Some(Duration::from_millis(1_533)));
		assert!(ui.tick(Duration::from_millis(3_000)));
		assert_eq!(fg(&ui, 0, 0), Color::Rgb(248, 79, 204), "resting frame after 3000ms");
		assert_eq!(ui.next_wake(), None, "settled marks stop asking");
	}

	#[test]
	fn intro_offset_resumes_mid_sweep() {
		let brand = Brand::new().intro(Duration::from_millis(2_900));
		assert!(!brand.settled(Duration::from_millis(99)));
		assert!(brand.settled(Duration::from_millis(100)));
		assert_eq!(brand.next_wake(Duration::from_millis(100)), None);
	}

	#[test]
	fn ascii_charset_paints_an_ascii_mark_with_the_same_shape() {
		let ctx = UiContext { charset: Charset::Ascii, ..UiContext::default() };
		let ui = Ui::from_root(Brand::new(), 12, ctx);
		for row in 0..ROWS as u16 {
			let text = frame_row_text(ui.frame(), row);
			assert!(text.is_ascii(), "row {row} is not ASCII: {text:?}");
		}
		assert_eq!(frame_row_text(ui.frame(), 0), "############");
		assert_eq!(frame_row_text(ui.frame(), 3), "   ::  ##");
		assert_eq!(fg(&ui, 0, 0), Color::Rgb(248, 79, 204), "the gradient still paints the mark");
		assert_eq!(
			fg(&ui, 3, 3),
			Gradient::default().color(Gradient::diagonal(3, 3, 12, 5), None, true),
			"ASCII shaded cells share the diagonal gradient",
		);
		for (unicode, ascii) in MARK.iter().zip(MARK_ASCII.iter()) {
			assert_eq!(unicode.chars().count(), ascii.chars().count());
			for (a, b) in unicode.chars().zip(ascii.chars()) {
				assert_eq!(a == ' ', b == ' ', "both marks share one silhouette");
			}
		}
	}

	#[test]
	fn quantized_theme_uses_the_256_ramp() {
		let ctx =
			UiContext { theme: UiContext::default().theme.quantized_256(), ..UiContext::default() };
		let ui = Ui::from_root(Brand::new(), 12, ctx);
		assert_eq!(fg(&ui, 0, 0), Color::Indexed(206));
		assert_eq!(fg(&ui, 8, 4), Color::Indexed(74));
	}
}
