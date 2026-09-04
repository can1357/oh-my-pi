//! Compact duration and live relative-time presentation.

use std::{fmt::Write as _, time::Duration};

use omp_core::{Str, fmts_mut};
use strum::IntoStaticStr;

use crate::{
	component::{Component, PaintCtx, Slot, next_slot},
	context::UiContext,
	frame::Rect,
	props::{Prop, PropValue, Props},
};

const SECOND_MS: u64 = 1_000;
const MINUTE_MS: u64 = 60 * SECOND_MS;
const HOUR_MS: u64 = 60 * MINUTE_MS;
const DAY_MS: u64 = 24 * HOUR_MS;
const WEEK_MS: u64 = 7 * DAY_MS;
const MONTH_MS: u64 = 30 * DAY_MS;
const YEAR_MS: u64 = 365 * DAY_MS;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
	Duration,
	Relative,
	/// Whole seconds since a presentation-clock instant (`ms`), shown as
	/// ` Ns` in a running tool-card badge.
	Elapsed,
}

#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
enum RelativeUnit {
	#[strum(serialize = "")]
	Now,
	#[strum(serialize = "s")]
	Second,
	#[strum(serialize = "m")]
	Minute,
	#[strum(serialize = "h")]
	Hour,
	#[strum(serialize = "d")]
	Day,
	#[strum(serialize = "w")]
	Week,
	#[strum(serialize = "mo")]
	Month,
	#[strum(serialize = "y")]
	Year,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FormatKey {
	Duration(u64),
	Relative(RelativeUnit, u64),
	Elapsed(u64),
}

/// A compact duration, live relative age, or live elapsed-seconds badge
/// backing the `<time>` markup tag.
///
/// - `<time ms=N/>`: compact duration (`1.2s`, `3m04s`).
/// - `<time kind=relative ms=N/>`: age that keeps counting from first paint.
/// - `<time kind=elapsed ms=N/>`: `Ns` whole seconds since presentation-clock
///   instant `N`, never negative, repainting exactly on each second boundary.
pub struct Time {
	props:  Props,
	slot:   Slot,
	text:   String,
	key:    Option<FormatKey>,
	anchor: Option<(u64, Duration)>,
}

impl Time {
	/// Creates an empty time display; absent `ms` is treated as zero.
	pub fn new() -> Self {
		Self {
			props:  Props::new(),
			slot:   next_slot(),
			text:   String::with_capacity(32),
			key:    None,
			anchor: None,
		}
	}

	/// Sets one time property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	fn mode(&self) -> Mode {
		match self.props.str_of(Prop::Kind).map(Str::as_str) {
			Some("relative") => Mode::Relative,
			Some("elapsed") => Mode::Elapsed,
			_ => Mode::Duration,
		}
	}

	fn source_ms(&self) -> u64 {
		self.props.ms().unwrap_or(0)
	}

	fn age_at(&mut self, now: Duration) -> u64 {
		let source = self.source_ms();
		let (base, started) = match self.anchor {
			Some(anchor) if anchor.0 == source => anchor,
			_ => {
				self.anchor = Some((source, now));
				(source, now)
			},
		};
		let elapsed = u64::try_from(now.saturating_sub(started).as_millis()).unwrap_or(u64::MAX);
		base.saturating_add(elapsed)
	}

	fn sync(&mut self, now: Duration) -> Option<u64> {
		let (key, next) = match self.mode() {
			Mode::Duration => {
				self.anchor = None;
				(FormatKey::Duration(self.source_ms()), None)
			},
			Mode::Relative => {
				let age = self.age_at(now);
				let (unit, value, period) = relative_parts(age);
				let unit_delta = period - age % period;
				// A display-family boundary may precede the next tick of the
				// current unit: `4w` becomes `1mo` at 30 days, not 5 weeks.
				let transition = match unit {
					RelativeUnit::Now => Some(SECOND_MS),
					RelativeUnit::Second => Some(MINUTE_MS),
					RelativeUnit::Minute => Some(HOUR_MS),
					RelativeUnit::Hour => Some(DAY_MS),
					RelativeUnit::Day => Some(WEEK_MS),
					RelativeUnit::Week => Some(MONTH_MS),
					RelativeUnit::Month => Some(YEAR_MS),
					RelativeUnit::Year => None,
				};
				let delta = transition
					.and_then(|at| at.checked_sub(age))
					.filter(|delta| *delta != 0)
					.map_or(unit_delta, |delta| unit_delta.min(delta));
				let next = age.checked_add(delta).map(|_| delta);
				(FormatKey::Relative(unit, value), next)
			},
			Mode::Elapsed => {
				self.anchor = None;
				let since = Duration::from_millis(self.source_ms());
				let elapsed = u64::try_from(now.saturating_sub(since).as_millis()).unwrap_or(u64::MAX);
				// A clock still behind the start instant reads zero until
				// one full second after it.
				let lead = u64::try_from(since.saturating_sub(now).as_millis()).unwrap_or(u64::MAX);
				let seconds = elapsed / SECOND_MS;
				// Wake exactly on the next whole-second boundary since `since`.
				let next = seconds
					.checked_add(1)
					.and_then(|next| next.checked_mul(SECOND_MS))
					.and_then(|at| at.checked_sub(elapsed))
					.and_then(|delta| delta.checked_add(lead));
				(FormatKey::Elapsed(seconds), next)
			},
		};
		if self.key != Some(key) {
			self.text.clear();
			match key {
				FormatKey::Duration(ms) => write_duration(&mut self.text, ms),
				FormatKey::Relative(unit, value) => write_relative(&mut self.text, unit, value),
				FormatKey::Elapsed(seconds) => {
					write!(self.text, "{seconds}s").expect("writing to String cannot fail");
				},
			}
			self.key = Some(key);
		}
		next
	}
}

impl Default for Time {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Time {
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
		self.sync(ctx.now);
		let width = u16::try_from(xutf::width_str(&self.text)).unwrap_or(u16::MAX);
		(width, width)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		1
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		let next = self.sync(pc.now);
		if rect.y >= pc.clip || rect.width == 0 || rect.height == 0 {
			return;
		}
		if let Some(delta_ms) = next
			&& let Some(at) = pc.now.checked_add(Duration::from_millis(delta_ms))
		{
			pc.wake(self.slot, at);
		}
		pc.frame
			.put(rect.x, rect.y, &self.text, self.props.style(&pc.ctx.theme));
	}
}

const fn relative_parts(age: u64) -> (RelativeUnit, u64, u64) {
	if age < SECOND_MS {
		(RelativeUnit::Now, 0, SECOND_MS)
	} else if age < MINUTE_MS {
		(RelativeUnit::Second, age / SECOND_MS, SECOND_MS)
	} else if age < HOUR_MS {
		(RelativeUnit::Minute, age / MINUTE_MS, MINUTE_MS)
	} else if age < DAY_MS {
		(RelativeUnit::Hour, age / HOUR_MS, HOUR_MS)
	} else if age < WEEK_MS {
		(RelativeUnit::Day, age / DAY_MS, DAY_MS)
	} else if age < MONTH_MS {
		(RelativeUnit::Week, age / WEEK_MS, WEEK_MS)
	} else if age < YEAR_MS {
		(RelativeUnit::Month, age / MONTH_MS, MONTH_MS)
	} else {
		(RelativeUnit::Year, age / YEAR_MS, YEAR_MS)
	}
}
/// Formats an elapsed age in milliseconds as the compact relative label the
/// `<time kind=relative>` tag paints ("now", "5s ago", "3mo ago") for plain
/// string contexts that cannot host a live component.
pub fn relative_age(age_ms: u64) -> Str {
	let (unit, value, _) = relative_parts(age_ms);
	match unit {
		RelativeUnit::Now => Str::new_static("now"),
		unit => fmts_mut!("{value}{} ago", <&str>::from(unit)).freeze(),
	}
}

fn write_relative(out: &mut String, unit: RelativeUnit, value: u64) {
	match unit {
		RelativeUnit::Now => out.push_str("now"),
		unit => {
			write!(out, "{value}{} ago", <&str>::from(unit)).expect("writing to String cannot fail");
		},
	}
}

fn write_duration(out: &mut String, ms: u64) {
	if ms < SECOND_MS {
		write!(out, "{ms}ms").expect("writing to String cannot fail");
	} else if ms < MINUTE_MS {
		let tenths = ms / 100;
		write!(out, "{}.{}s", tenths / 10, tenths % 10).expect("writing to String cannot fail");
	} else if ms < HOUR_MS {
		let seconds = ms / SECOND_MS;
		write!(out, "{}m{:02}s", seconds / 60, seconds % 60).expect("writing to String cannot fail");
	} else {
		let minutes = ms / MINUTE_MS;
		write!(out, "{}h{:02}m", minutes / 60, minutes % 60).expect("writing to String cannot fail");
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{Frame, Size, component::Wake, test_support::frame_row_text};

	fn duration(ms: u64) -> Time {
		Time::new().with(Prop::Ms, ms).with(Prop::Kind, "duration")
	}

	fn relative(ms: u64) -> Time {
		Time::new().with(Prop::Ms, ms).with(Prop::Kind, "relative")
	}

	fn elapsed(since_ms: u64) -> Time {
		Time::new()
			.with(Prop::Ms, since_ms)
			.with(Prop::Kind, "elapsed")
	}

	fn paint_at(time: &mut Time, now_ms: u64) -> (String, Vec<Wake>) {
		let mut ctx = UiContext::default();
		ctx.now = Duration::from_millis(now_ms);
		let mut frame = Frame::new(Size::new(32, 1));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
		pc.now = ctx.now;
		time.paint(&mut pc, Rect::new(0, 0, 32, 1));
		(frame_row_text(&frame, 0), wakes)
	}

	#[test]
	fn duration_matches_compact_tui_boundaries() {
		for (ms, expected) in [
			(0, "0ms"),
			(999, "999ms"),
			(1_000, "1.0s"),
			(59_999, "59.9s"),
			(60_000, "1m00s"),
			(3_599_999, "59m59s"),
			(3_600_000, "1h00m"),
		] {
			assert_eq!(paint_at(&mut duration(ms), 8_000).0, expected);
		}
	}

	#[test]
	fn relative_boundaries_and_wakes_follow_visible_units() {
		let cases = [
			(0, "now", 1_000),
			(999, "now", 1),
			(1_000, "1s ago", 1_000),
			(59_999, "59s ago", 1),
			(60_000, "1m ago", 60_000),
			(3_599_999, "59m ago", 1),
			(3_600_000, "1h ago", 3_600_000),
			(86_399_999, "23h ago", 1),
			(86_400_000, "1d ago", 86_400_000),
			(2_591_999_999, "4w ago", 1),
			(2_592_000_000, "1mo ago", 2_592_000_000),
			(5_183_999_999, "1mo ago", 1),
			(31_536_000_000, "1y ago", 31_536_000_000),
			(63_071_999_999, "1y ago", 1),
		];
		for (age, expected, delta) in cases {
			let mut time = relative(age);
			let (text, wakes) = paint_at(&mut time, 500);
			assert_eq!(text, expected);
			assert_eq!(wakes, vec![Wake {
				slot:   time.slot,
				at:     Duration::from_millis(500 + delta),
				layout: false,
			}]);
		}
	}

	#[test]
	fn elapsed_badge_counts_whole_seconds_and_wakes_on_the_boundary() {
		// Started at 2.4 s on the shared clock; painted 350 ms later.
		let mut time = elapsed(2_400);
		let (text, wakes) = paint_at(&mut time, 2_750);
		assert_eq!(text, "0s");
		assert_eq!(wakes, vec![Wake {
			slot:   time.slot,
			at:     Duration::from_millis(3_400),
			layout: false,
		}]);
		// Exactly on the boundary the count flips and the next wake is one
		// full second later — no drift, no sub-second repaints.
		let (text, wakes) = paint_at(&mut time, 3_400);
		assert_eq!(text, "1s");
		assert_eq!(wakes[0].at, Duration::from_millis(4_400));
		let (text, wakes) = paint_at(&mut time, 61_399);
		assert_eq!(text, "58s");
		assert_eq!(wakes[0].at, Duration::from_millis(61_400));
		let pointer = time.text.as_ptr();
		assert_eq!(paint_at(&mut time, 61_399).0, "58s");
		assert_eq!(time.text.as_ptr(), pointer, "an unchanged second re-slices the cached text");
		// A clock behind the start instant reads as zero, never negative.
		let mut future = elapsed(9_000);
		assert_eq!(paint_at(&mut future, 1_000).0, "0s");
		assert_eq!(paint_at(&mut future, 1_000).1[0].at, Duration::from_millis(10_000));
	}

	#[test]
	fn relative_age_advances_from_first_paint_and_saturates() {
		let mut time = relative(999);
		assert_eq!(paint_at(&mut time, 500).0, "now");
		let (text, wakes) = paint_at(&mut time, 501);
		assert_eq!(text, "1s ago");
		assert_eq!(wakes[0].at, Duration::from_millis(1_501));

		for age in [u64::MAX - 1, u64::MAX] {
			let mut saturated = relative(age);
			let (text, wakes) = paint_at(&mut saturated, 10);
			assert_eq!(text, format!("{}y ago", age / YEAR_MS));
			assert!(wakes.is_empty());
			assert_eq!(paint_at(&mut saturated, u64::MAX).0, text);
		}
	}

	#[test]
	fn relative_age_matches_painted_labels() {
		assert_eq!(relative_age(0), "now");
		assert_eq!(relative_age(59_000), "59s ago");
		assert_eq!(relative_age(2_592_000_000), "1mo ago");
		assert_eq!(relative_age(94_608_000_000), "3y ago");
	}

	#[test]
	fn dimensions_and_cached_text_are_stable_between_boundaries() {
		let mut time = relative(1_234);
		let mut ctx = UiContext::default();
		ctx.now = Duration::from_millis(10);
		assert_eq!(time.measure(&ctx), (6, 6));
		assert_eq!(time.height(&ctx, 0), 1);
		let pointer = time.text.as_ptr();
		assert_eq!(paint_at(&mut time, 500).0, "1s ago");
		assert_eq!(paint_at(&mut time, 700).0, "1s ago");
		assert_eq!(time.text.as_ptr(), pointer);
	}
}
