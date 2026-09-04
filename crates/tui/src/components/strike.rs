//! Struck-through text whose strike can sweep in progressively, backing the
//! `<strike>` markup tag.

use std::time::Duration;

use omp_core::{IntoStr, Str};

use crate::{
	component::{Component, PaintCtx, Slot, next_slot},
	context::UiContext,
	frame::Rect,
	props::{Prop, PropValue, Props},
	rich::cell_width,
};

/// Frames the text holds unstruck before the sweep starts.
pub const STRIKE_HOLD_FRAMES: u32 = 2;
/// Frames the strike takes to cross the whole text.
pub const STRIKE_REVEAL_FRAMES: u32 = 12;
/// Frames from the first paint until the text is fully struck.
pub const STRIKE_TOTAL_FRAMES: u32 = STRIKE_HOLD_FRAMES + STRIKE_REVEAL_FRAMES;

/// One line of struck-through text.
///
/// Without `reveal` this is `<text strike>` on one row. With `reveal`, the
/// strike sweeps across the text on the shared clock over the `reveal`
/// duration split into [`STRIKE_TOTAL_FRAMES`] frames: the text holds plain
/// for [`STRIKE_HOLD_FRAMES`], then each frame strikes a further
/// `ceil(graphemes × k / REVEAL_FRAMES)` prefix until the whole line is
/// struck, where it stays. The sweep anchors at the first paint and asks for
/// a repaint at every frame boundary until settled, so it costs nothing once
/// done or off screen.
pub struct Strike {
	props:  Props,
	slot:   Slot,
	text:   Str,
	/// Grapheme clusters in `text`.
	total:  usize,
	/// Shared-clock instant of the first paint, when a sweep is armed.
	anchor: Option<Duration>,
}

impl Strike {
	/// Creates an empty struck line.
	pub fn new() -> Self {
		Self {
			props:  Props::new(),
			slot:   next_slot(),
			text:   Str::default(),
			total:  0,
			anchor: None,
		}
	}

	/// Sets one property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one property from a string.
	pub fn with_str(self, prop: Prop, value: &str) -> Self {
		self.with(prop, value)
	}

	/// Appends text content.
	pub fn text(mut self, text: impl IntoStr) -> Self {
		let text = text.into_str();
		if self.text.is_empty() {
			self.text = text;
		} else {
			let mut joined = String::with_capacity(self.text.len() + text.len());
			joined.push_str(&self.text);
			joined.push_str(&text);
			self.text = Str::new(joined);
		}
		self.total = xutf::graphemes_str(&self.text).count();
		self
	}

	/// Graphemes struck at `frame` of the sweep.
	pub fn struck_at(total: usize, frame: u32) -> usize {
		if frame <= STRIKE_HOLD_FRAMES {
			return 0;
		}
		let step = (frame - STRIKE_HOLD_FRAMES).min(STRIKE_REVEAL_FRAMES) as usize;
		(total * step).div_ceil(STRIKE_REVEAL_FRAMES as usize)
	}

	/// Byte end of the struck prefix at `now`, plus the next frame boundary
	/// while the sweep is still running.
	fn sweep(&mut self, now: Duration) -> (usize, Option<Duration>) {
		let Some(duration) = self.props.reveal() else {
			self.anchor = None;
			return (self.text.len(), None);
		};
		let anchor = *self.anchor.get_or_insert(now);
		let interval = duration / STRIKE_TOTAL_FRAMES;
		if interval.is_zero() {
			return (self.text.len(), None);
		}
		let elapsed = now.saturating_sub(anchor);
		let frame = u32::try_from(elapsed.as_nanos() / interval.as_nanos()).unwrap_or(u32::MAX);
		if frame >= STRIKE_TOTAL_FRAMES {
			return (self.text.len(), None);
		}
		let struck = Self::struck_at(self.total, frame);
		let end = if struck >= self.total {
			self.text.len()
		} else {
			xutf::graphemes_str(&self.text)
				.take(struck)
				.map(str::len)
				.sum()
		};
		let next = anchor.saturating_add(interval.saturating_mul(frame + 1));
		(end, Some(next))
	}
}

impl Default for Strike {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Strike {
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
		let natural = cell_width(&self.text);
		(natural, natural)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		1
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		let (end, next) = self.sweep(pc.now);
		if rect.y >= pc.clip || rect.width == 0 || rect.height == 0 {
			return;
		}
		let style = self.props.style(&pc.ctx.theme);
		let (struck, rest) = self.text.as_str().split_at(end);
		let limit = rect.x.saturating_add(rect.width);
		let column = pc
			.frame
			.put_clipped(rect.x, rect.y, rect.width, struck, style.strikethrough());
		if !rest.is_empty() && column < limit {
			pc.frame
				.put_clipped(column, rect.y, limit - column, rest, style);
		}
		if let Some(at) = next {
			pc.wake(self.slot, at);
		}
	}

	fn set_text(&mut self, _ctx: &UiContext, text: Str) -> bool {
		if self.text == text {
			return false;
		}
		self.text = text;
		self.total = xutf::graphemes_str(&self.text).count();
		true
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{
		Frame, Size, component::Wake, frame::CellContent, test_support::frame_row_text, ui::Ui,
	};

	/// Per painted cell of row zero, whether it paints struck-through.
	fn struck_row(frame: &Frame) -> Vec<bool> {
		(0..frame.size().width)
			.filter_map(|x| {
				let cell = frame.cell(x, 0);
				matches!(cell.content(), CellContent::Grapheme { .. })
					.then_some(cell.style().strikethrough)
			})
			.collect()
	}

	fn struck_cells(ui: &Ui) -> Vec<bool> {
		struck_row(ui.frame())
	}

	fn paint_at(strike: &mut Strike, now_ms: u64) -> (Frame, Vec<Wake>) {
		let mut ctx = UiContext::default();
		ctx.now = Duration::from_millis(now_ms);
		let mut frame = Frame::new(Size::new(16, 1));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
		pc.now = ctx.now;
		strike.paint(&mut pc, Rect::new(0, 0, 16, 1));
		(frame, wakes)
	}

	#[test]
	fn plain_strike_matches_a_struck_text_leaf() {
		let ui = Ui::from_root(Strike::new().text("Wire workspace"), 20, UiContext::default());
		assert_eq!(frame_row_text(ui.frame(), 0), "Wire workspace");
		assert!(struck_cells(&ui).iter().all(|struck| *struck));
		assert_eq!(ui.next_wake(), None, "a plain strike never animates");
	}

	#[test]
	fn todo_strike_reveals_progressively_then_settles() {
		// Fourteen 65ms frames: two held plain, twelve sweeping.
		let mut ui = Ui::from_root(
			Strike::new()
				.with(Prop::Reveal, "910ms")
				.text("Scaffold crate"),
			20,
			UiContext::default(),
		);
		assert_eq!(frame_row_text(ui.frame(), 0), "Scaffold crate");
		assert!(struck_cells(&ui).iter().all(|struck| !struck), "frame 0 holds plain");
		assert_eq!(ui.next_wake(), Some(Duration::from_millis(65)));

		ui.tick(Duration::from_millis(130));
		assert!(struck_cells(&ui).iter().all(|struck| !struck), "frame 2 still holds");
		assert_eq!(ui.next_wake(), Some(Duration::from_millis(195)));

		// Frame 3: ceil(14 × 1 / 12) = 2 graphemes struck.
		ui.tick(Duration::from_millis(195));
		let cells = struck_cells(&ui);
		assert_eq!(cells.iter().filter(|struck| **struck).count(), 2);
		assert!(cells[..2].iter().all(|struck| *struck), "the strike grows from the start");
		assert_eq!(ui.next_wake(), Some(Duration::from_millis(260)));

		// Frame 8: ceil(14 × 6 / 12) = 7.
		ui.tick(Duration::from_millis(520));
		assert_eq!(struck_cells(&ui).iter().filter(|struck| **struck).count(), 7);

		// Frame 14: fully struck, and the sweep stops asking for frames.
		ui.tick(Duration::from_millis(910));
		assert!(struck_cells(&ui).iter().all(|struck| *struck));
		assert_eq!(ui.next_wake(), None, "a settled sweep stops waking");
		ui.tick(Duration::from_secs(5));
		assert!(struck_cells(&ui).iter().all(|struck| *struck), "it stays struck");
	}

	#[test]
	fn sweep_anchors_at_first_paint_not_at_construction() {
		let mut strike = Strike::new().with(Prop::Reveal, "910ms").text("abc");
		let (frame, wakes) = paint_at(&mut strike, 3_000);
		assert!(struck_row(&frame).iter().all(|struck| !struck));
		assert_eq!(wakes[0].at, Duration::from_millis(3_065));
		// 500 ms in: frame 7, step 5, ceil(3 × 5 / 12) = 2 graphemes struck.
		let (frame, wakes) = paint_at(&mut strike, 3_500);
		assert_eq!(struck_row(&frame), vec![true, true, false]);
		assert_eq!(wakes[0].at, Duration::from_millis(3_520));
		let (frame, wakes) = paint_at(&mut strike, 3_910);
		assert!(struck_row(&frame).iter().all(|struck| *struck));
		assert!(wakes.is_empty());
	}

	#[test]
	fn struck_counts_follow_pi_ceil_law() {
		assert_eq!(Strike::struck_at(14, 0), 0);
		assert_eq!(Strike::struck_at(14, 2), 0);
		assert_eq!(Strike::struck_at(14, 3), 2);
		assert_eq!(Strike::struck_at(14, 14), 14);
		assert_eq!(Strike::struck_at(14, 40), 14);
		assert_eq!(Strike::struck_at(0, 9), 0);
	}
}
