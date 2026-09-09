//! Breathing starburst activity pulse with an optional throughput badge.
//!
//! One fixed-width starburst cycles through eight
//! facets so the line never shifts, and each facet's dwell eases on a raised
//! cosine between [`Pulse::DWELL_MIN`] and [`Pulse::DWELL_MAX`] — quickest at
//! the cycle start, slowest at its midpoint — so the rotation breathes
//! instead of ticking. Like every animation here it is pure phase
//! arithmetic on the shared paint clock, so several pulses stay in lockstep
//! and a pulse costs nothing once it leaves the tree.
//!
//! Beside the glyph sit a muted label, an optional dimmed counter, and an
//! optional throughput badge fed by a [`SpeedGauge`]: the windowed average
//! rate is sampled per paint frame and its color lifts from the theme's
//! muted tone toward the accent as the rate climbs (`sqrt(rate / max)`), so
//! typical mid-stream rates already read as tinted.

use std::{fmt::Write as _, time::Duration};

use omp_core::{IntoStr, Str};

use crate::{
	anim::Lerp as _,
	component::{Component, PaintCtx, Slot, next_slot},
	context::UiContext,
	frame::{Color, Rect},
	props::{Prop, PropValue, Props},
	rich::cell_width,
};

/// Rolling window over which throughput observations are averaged.
pub const SPEED_WINDOW: Duration = Duration::from_millis(3000);
/// Clamp ceiling for one observation and the rate that maps to full accent.
pub const SPEED_MAX: f32 = 200.0;

/// Windowed-average throughput gauge.
///
/// Observations are instantaneous rates stamped on the presentation clock;
/// [`SpeedGauge::speed`] averages those inside the trailing
/// [`SPEED_WINDOW`] and reports zero once they age out. Each observation is
/// clamped to [`SPEED_MAX`] so a single oversized delta (a buffered reflow
/// tick) cannot poison the average.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SpeedGauge {
	observations: Vec<(Duration, f32)>,
}

impl SpeedGauge {
	/// Records one instantaneous rate at `now`; non-finite or negative rates
	/// are ignored.
	pub fn observe(&mut self, rate: f32, now: Duration) {
		if !rate.is_finite() || rate < 0.0 {
			return;
		}
		self.prune(now);
		self.observations.push((now, rate.min(SPEED_MAX)));
	}

	/// Windowed-average rate at `now`; zero without live observations.
	pub fn speed(&self, now: Duration) -> f32 {
		let threshold = now.saturating_sub(SPEED_WINDOW);
		let mut sum = 0.0_f32;
		let mut count = 0_u32;
		for (at, rate) in &self.observations {
			if *at >= threshold {
				sum += rate;
				count += 1;
			}
		}
		if count == 0 { 0.0 } else { sum / count as f32 }
	}

	/// Drops every observation.
	pub fn reset(&mut self) {
		self.observations.clear();
	}

	/// Whether any observation is still inside the window at `now`.
	pub fn is_live(&self, now: Duration) -> bool {
		let threshold = now.saturating_sub(SPEED_WINDOW);
		self.observations.iter().any(|(at, _)| *at >= threshold)
	}

	fn prune(&mut self, now: Duration) {
		let threshold = now.saturating_sub(SPEED_WINDOW);
		self.observations.retain(|(at, _)| *at >= threshold);
	}
}

/// A breathing starburst with a label, counter, and throughput badge.
pub struct Pulse {
	props: Props,
	slot:  Slot,
	label: Str,
	count: u64,
	unit:  Str,
	gauge: Option<SpeedGauge>,
	text:  String,
}

impl Pulse {
	/// Longest facet dwell, at the cycle midpoint.
	pub const DWELL_MAX: Duration = Duration::from_millis(230);
	/// Shortest facet dwell, at the cycle start.
	pub const DWELL_MIN: Duration = Duration::from_millis(70);
	/// Facets per revolution.
	pub const FACETS: usize = 8;

	/// Creates a bare pulse.
	pub fn new() -> Self {
		Self {
			props: Props::new(),
			slot:  next_slot(),
			label: Str::default(),
			count: 0,
			unit:  Str::default(),
			gauge: None,
			text:  String::with_capacity(48),
		}
	}

	/// Sets the muted label painted right after the glyph.
	pub fn label(mut self, label: impl IntoStr) -> Self {
		self.label = label.into_str();
		self
	}

	/// Sets the dimmed counter shown beside the label; zero hides it.
	pub const fn count(mut self, count: u64) -> Self {
		self.count = count;
		self
	}

	/// Attaches a throughput gauge painted as `· <rate> <unit>` while it has
	/// live observations.
	pub fn gauge(mut self, gauge: SpeedGauge, unit: impl IntoStr) -> Self {
		self.gauge = Some(gauge);
		self.unit = unit.into_str();
		self
	}

	/// Sets one pulse property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Cumulative facet boundaries (ms) across one revolution: dwell `k` is
	/// `DWELL_MIN + (DWELL_MAX - DWELL_MIN) * (1 - cos(2πk / FACETS)) / 2`.
	fn boundaries() -> [f32; Self::FACETS + 1] {
		let min = Self::DWELL_MIN.as_secs_f32() * 1000.0;
		let max = Self::DWELL_MAX.as_secs_f32() * 1000.0;
		let mut out = [0.0_f32; Self::FACETS + 1];
		for facet in 0..Self::FACETS {
			let phase =
				(1.0 - (std::f32::consts::TAU * facet as f32 / Self::FACETS as f32).cos()) / 2.0;
			out[facet + 1] = out[facet] + (max - min).mul_add(phase, min);
		}
		out
	}

	/// The facet index at `now` and the instant of the next facet change.
	pub fn facet_at(now: Duration) -> (usize, Duration) {
		let bounds = Self::boundaries();
		let cycle = bounds[Self::FACETS];
		let now_ms = now.as_secs_f64() * 1000.0;
		let cycles = (now_ms / f64::from(cycle)).floor();
		let phase = cycles.mul_add(-f64::from(cycle), now_ms) as f32;
		let facet = (0..Self::FACETS)
			.rev()
			.find(|facet| phase >= bounds[*facet])
			.unwrap_or(0);
		let next_ms = cycles.mul_add(f64::from(cycle), f64::from(bounds[facet + 1]));
		(facet, Duration::from_secs_f64(next_ms / 1000.0))
	}

	/// Badge color for `rate`: the muted tone lifted toward the accent by
	/// `sqrt(rate / SPEED_MAX)`.
	pub fn rate_color(rate: f32, muted: Color, accent: Color) -> Color {
		let ratio = (rate.clamp(0.0, SPEED_MAX) / SPEED_MAX).sqrt();
		muted.lerp(accent, ratio)
	}

	fn badge(&mut self, now: Duration) -> Option<(f32, usize)> {
		self.text.clear();
		let gauge = self.gauge.as_ref()?;
		if !gauge.is_live(now) {
			return None;
		}
		let rate = gauge.speed(now).min(SPEED_MAX);
		if rate < 0.05 {
			return None;
		}
		let count_end = if self.count > 0 {
			self.text.push_str(" · ");
			write_compact(&mut self.text, self.count);
			self.text.len()
		} else {
			0
		};
		let _ = write!(self.text, " · {rate:.1} {}", self.unit);
		Some((rate, count_end))
	}
}

impl Default for Pulse {
	fn default() -> Self {
		Self::new()
	}
}

/// Compact number examples: `999`, `1.5K`, `25K`, `1.5M`, `25M`, `1.5B`.
pub fn write_compact(out: &mut String, value: u64) {
	let trimmed = |out: &mut String, scaled: f64, suffix: char| {
		let text = format!("{scaled:.1}");
		out.push_str(text.strip_suffix(".0").unwrap_or(&text));
		out.push(suffix);
	};
	match value {
		0..=999 => {
			let _ = write!(out, "{value}");
		},
		1_000..=9_999 => trimmed(out, value as f64 / 1_000.0, 'K'),
		10_000..=999_999 => {
			let _ = write!(out, "{}K", (value as f64 / 1_000.0).round() as u64);
		},
		1_000_000..=9_999_999 => trimmed(out, value as f64 / 1_000_000.0, 'M'),
		10_000_000..=999_999_999 => {
			let _ = write!(out, "{}M", (value as f64 / 1_000_000.0).round() as u64);
		},
		1_000_000_000..=9_999_999_999 => trimmed(out, value as f64 / 1_000_000_000.0, 'B'),
		_ => {
			let _ = write!(out, "{}B", (value as f64 / 1_000_000_000.0).round() as u64);
		},
	}
}

impl Component for Pulse {
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
		self.badge(ctx.now);
		let width = 1_u16
			.saturating_add(cell_width(&self.label))
			.saturating_add(cell_width(&self.text));
		(width, width)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		1
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		let badge = self.badge(pc.now);
		let (facet, next) = Self::facet_at(pc.now);
		pc.wake(self.slot, next);
		if rect.y >= pc.clip || rect.width == 0 || rect.height == 0 {
			return;
		}
		let theme = pc.ctx.theme;
		let glyph = pc.ctx.charset.starburst()[facet % Self::FACETS];
		let style = self.props.style(&theme);
		let muted = style.fg(theme.muted);
		let mut column = pc.frame.put(rect.x, rect.y, glyph, style);
		column = pc.frame.put(column, rect.y, &self.label, muted);
		let Some((rate, count_end)) = badge else {
			return;
		};
		let (count, rate_text) = self.text.split_at(count_end);
		column = pc.frame.put(column, rect.y, count, muted);
		let accent = style.foreground_color();
		let accent = if accent == Color::Default {
			theme.accent
		} else {
			accent
		};
		let tint = Self::rate_color(rate, theme.muted, accent);
		pc.frame.put(column, rect.y, rate_text, style.fg(tint));
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{test_support::frame_row_text, ui::Ui};

	#[test]
	fn facet_dwells_follow_the_raised_cosine_between_70_and_230ms() {
		let bounds = Pulse::boundaries();
		let dwells = (0..Pulse::FACETS)
			.map(|facet| bounds[facet + 1] - bounds[facet])
			.collect::<Vec<_>>();
		assert!((dwells[0] - 70.0).abs() < 0.01, "cycle start is quickest: {dwells:?}");
		assert!((dwells[4] - 230.0).abs() < 0.01, "cycle midpoint is slowest: {dwells:?}");
		assert!((dwells[1] - dwells[7]).abs() < 0.01, "the breath is symmetric");
		assert!((bounds[Pulse::FACETS] - 1200.0).abs() < 0.05, "one revolution is 1.2 s");
		let mean = bounds[Pulse::FACETS] / Pulse::FACETS as f32;
		assert!((mean - 150.0).abs() < 0.05, "mean dwell ≈ 150 ms");
	}

	#[test]
	fn facet_advances_at_the_eased_boundaries_and_wraps() {
		assert_eq!(Pulse::facet_at(Duration::ZERO).0, 0);
		assert_eq!(Pulse::facet_at(Duration::from_millis(69)).0, 0);
		assert_eq!(Pulse::facet_at(Duration::from_millis(70)).0, 1);
		let (facet, next) = Pulse::facet_at(Duration::from_millis(520));
		assert_eq!(facet, 4);
		assert_eq!(next, Duration::from_millis(750));
		assert_eq!(Pulse::facet_at(Duration::from_millis(1200)).0, 0, "wraps after 1.2 s");
		assert_eq!(Pulse::facet_at(Duration::from_millis(1270)).0, 1);
	}

	#[test]
	fn gauge_averages_the_trailing_window_and_clamps_observations() {
		let mut gauge = SpeedGauge::default();
		gauge.observe(1_000.0, Duration::from_millis(0));
		gauge.observe(100.0, Duration::from_millis(1_000));
		gauge.observe(-5.0, Duration::from_millis(1_000));
		gauge.observe(f32::NAN, Duration::from_millis(1_000));
		assert_eq!(gauge.speed(Duration::from_millis(1_000)), 150.0, "1000 clamps to 200");
		assert_eq!(gauge.speed(Duration::from_millis(3_500)), 100.0, "the first ages out");
		assert!(!gauge.is_live(Duration::from_millis(4_100)));
		assert_eq!(gauge.speed(Duration::from_millis(4_100)), 0.0);
	}

	#[test]
	fn rate_color_lifts_muted_toward_accent_by_sqrt() {
		let muted = Color::Rgb(0, 0, 0);
		let accent = Color::Rgb(200, 200, 200);
		assert_eq!(Pulse::rate_color(0.0, muted, accent), muted);
		assert_eq!(Pulse::rate_color(50.0, muted, accent), Color::Rgb(100, 100, 100));
		assert_eq!(Pulse::rate_color(500.0, muted, accent), accent);
	}

	#[test]
	fn compact_numbers_match_pi_format_number() {
		let cases = [
			(999, "999"),
			(1_000, "1K"),
			(1_500, "1.5K"),
			(25_000, "25K"),
			(1_000_000, "1M"),
			(1_500_000, "1.5M"),
			(25_000_000, "25M"),
			(1_500_000_000, "1.5B"),
		];
		for (value, expected) in cases {
			let mut out = String::new();
			write_compact(&mut out, value);
			assert_eq!(out, expected, "{value}");
		}
	}

	#[test]
	fn pulse_paints_glyph_label_counter_and_live_badge_then_drops_the_badge() {
		let mut gauge = SpeedGauge::default();
		gauge.observe(42.0, Duration::from_millis(100));
		let pulse = Pulse::new()
			.label(" Thinking")
			.count(1_234)
			.gauge(gauge, "toks/s");
		let mut ui = Ui::from_root(pulse, 40, UiContext::default());
		ui.tick(Duration::from_millis(100));
		assert_eq!(frame_row_text(ui.frame(), 0).trim_end(), "✼ Thinking · 1.2K · 42.0 toks/s");
		let wake = ui.next_wake().expect("a facet boundary is scheduled");
		assert!(
			wake >= Duration::from_millis(163) && wake < Duration::from_millis(164),
			"next facet boundary at 163.4 ms, got {wake:?}"
		);
		ui.tick(Duration::from_millis(4_000));
		assert_eq!(
			frame_row_text(ui.frame(), 0).trim_end(),
			"❊ Thinking",
			"aged-out observations drop the whole badge"
		);
	}

	#[test]
	fn pulse_without_gauge_is_a_bare_glyph_and_label() {
		let mut ui = Ui::from_root(Pulse::new().label(" Thinking"), 20, UiContext::default());
		ui.tick(Duration::from_millis(0));
		assert_eq!(frame_row_text(ui.frame(), 0).trim_end(), "✻ Thinking");
	}
}
