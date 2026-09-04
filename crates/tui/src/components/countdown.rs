//! Reusable presentation-clock countdown for dialogs and approval prompts.

use std::time::Duration;

use omp_core::{IntoStr, Str, sf};

use crate::{
	component::{Component, PaintCtx, Slot, next_slot},
	context::UiContext,
	frame::Rect,
	props::Props,
};

/// One allocation-free countdown driven by [`UiContext::now`].
pub struct Countdown {
	props:    Props,
	slot:     Slot,
	label:    Str,
	text:     Str,
	shown:    u64,
	started:  Duration,
	duration: Duration,
}

impl Countdown {
	/// Creates a countdown beginning at presentation time `started`.
	pub fn new(label: impl IntoStr, started: Duration, duration: Duration) -> Self {
		let label = label.into_str();
		let millis = duration.as_millis();
		let shown = u64::try_from(millis.saturating_add(999) / 1000).unwrap_or(u64::MAX);
		let text = sf!("{} · {shown}s", label);
		Self { props: Props::new(), slot: next_slot(), label, text, shown, started, duration }
	}

	/// Returns the remaining whole seconds, rounding a partial second up.
	pub fn remaining(&self, now: Duration) -> u64 {
		let left = self
			.duration
			.saturating_sub(now.saturating_sub(self.started));
		let millis = left.as_millis();
		u64::try_from(millis.saturating_add(999) / 1000).unwrap_or(u64::MAX)
	}

	/// Reports whether the deadline has elapsed.
	pub fn expired(&self, now: Duration) -> bool {
		now.saturating_sub(self.started) >= self.duration
	}
}

impl Component for Countdown {
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
		let width = xutf::width_str(&self.label).saturating_add(8);
		(1, u16::try_from(width).unwrap_or(u16::MAX))
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		1
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		let now = pc.ctx.now;
		let remaining = self.remaining(now);
		if remaining != self.shown {
			self.shown = remaining;
			self.text = sf!("{} · {remaining}s", self.label);
		}
		// Use a one-second cadence until the deadline; the next label change
		// lands exactly on the next whole-second
		// boundary of the remaining time.
		if !self.expired(now) {
			let elapsed = now.saturating_sub(self.started);
			let left = self.duration.saturating_sub(elapsed);
			let into_second =
				Duration::from_nanos(u64::try_from(left.as_nanos() % 1_000_000_000).unwrap_or(0));
			let step = if into_second.is_zero() {
				Duration::from_secs(1)
			} else {
				into_second
			};
			pc.wake(self.slot, now.saturating_add(step));
		}
		let color = if remaining <= 5 {
			pc.ctx.theme.err
		} else {
			pc.ctx.theme.warn
		};
		pc.frame
			.put(rect.x, rect.y, &self.text, self.props.style(&pc.ctx.theme).fg(color));
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{Frame, Size, test_support::frame_row_text};

	fn render_at(countdown: &mut Countdown, now: Duration) -> String {
		let mut ctx = UiContext::default();
		ctx.now = now;
		let mut frame = Frame::new(Size::new(24, 1));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
		countdown.paint(&mut pc, Rect::new(0, 0, 24, 1));
		frame_row_text(&frame, 0)
	}

	#[test]
	fn rounds_partial_seconds_and_expires_at_deadline() {
		let countdown =
			Countdown::new("Retrying", Duration::from_secs(10), Duration::from_millis(2500));
		assert_eq!(countdown.remaining(Duration::from_secs(10)), 3);
		assert_eq!(countdown.remaining(Duration::from_secs(12)), 1);
		assert!(!countdown.expired(Duration::from_millis(12_499)));
		assert!(countdown.expired(Duration::from_millis(12_500)));
	}

	#[test]
	fn presentation_clock_ticks_retry_message_down_and_clamps_at_zero() {
		let mut countdown =
			Countdown::new("Retrying", Duration::from_secs(10), Duration::from_millis(2500));

		assert!(render_at(&mut countdown, Duration::from_secs(10)).contains("Retrying · 3s"));
		assert!(render_at(&mut countdown, Duration::from_secs(12)).contains("Retrying · 1s"));
		assert!(render_at(&mut countdown, Duration::from_secs(30)).contains("Retrying · 0s"));
	}

	#[test]
	fn wakes_on_whole_second_boundaries_until_expiry() {
		let wakes_at = |now: Duration| {
			let mut countdown =
				Countdown::new("Retrying", Duration::from_secs(10), Duration::from_millis(2500));
			let mut ctx = UiContext::default();
			ctx.now = now;
			let mut frame = Frame::new(Size::new(24, 1));
			let mut hits = Vec::new();
			let mut wakes = Vec::new();
			let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
			countdown.paint(&mut pc, Rect::new(0, 0, 24, 1));
			wakes.first().map(|wake| wake.at)
		};
		// 2.5s left: the label flips to 2s after 500ms.
		assert_eq!(wakes_at(Duration::from_secs(10)), Some(Duration::from_millis(10_500)));
		// Exactly 2s left: next flip in a full second.
		assert_eq!(wakes_at(Duration::from_millis(10_500)), Some(Duration::from_millis(11_500)));
		assert_eq!(wakes_at(Duration::from_secs(30)), None, "an expired countdown stops waking");
	}
}
