//! Retained semantic number and byte-count leaves.

use core::fmt::{self, Write as _};

use omp_core::Str;

use crate::{
	component::{Component, PaintCtx, Slot, next_slot},
	context::UiContext,
	frame::Rect,
	props::{Prop, PropValue, Props},
	rich::cell_width,
};

/// Writes a count using the status line's compact `K`/`M`/`B` convention.
///
/// A single leading digit keeps one decimal unless it is `.0`; larger
/// values round to a whole unit: `999`, `1K`, `1.5K`, `25K`, `1M`, `1.5M`.
pub fn write_compact_count(out: &mut impl fmt::Write, value: u64) -> fmt::Result {
	const UNITS: [(u64, char); 3] = [(1_000_000_000, 'B'), (1_000_000, 'M'), (1_000, 'K')];
	for (scale, unit) in UNITS {
		if value < scale {
			continue;
		}
		let scaled = value as f64 / scale as f64;
		if scaled < 10.0 {
			// One decimal, dropping a trailing `.0`.
			let tenths = (scaled * 10.0).round() as u64;
			return if tenths.is_multiple_of(10) {
				write!(out, "{}{unit}", tenths / 10)
			} else {
				write!(out, "{}.{}{unit}", tenths / 10, tenths % 10)
			};
		}
		return write!(out, "{}{unit}", scaled.round() as u64);
	}
	write!(out, "{value}")
}

/// Writes a byte count using the tool renderer's decimal `B`/`K`/`M`/`G`/`T`
/// convention.
///
/// Scaled values below 100 retain one decimal unless already near an integer;
/// larger values round to a whole unit.
pub fn write_byte_count(out: &mut impl fmt::Write, value: u64) -> fmt::Result {
	const UNITS: [&str; 4] = ["K", "M", "G", "T"];
	if value < 1_000 {
		return write!(out, "{value}B");
	}

	let mut scaled = value as f64 / 1_000.0;
	let mut unit = 0usize;
	while scaled >= 1_000.0 && unit + 1 < UNITS.len() {
		scaled /= 1_000.0;
		unit += 1;
	}
	if scaled >= 1_000.0 || scaled.fract() < 0.05 || scaled >= 100.0 {
		write!(out, "{}{}", scaled.round() as u64, UNITS[unit])
	} else {
		write!(out, "{scaled:.1}{}", UNITS[unit])
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NumberKind {
	Number,
	Bytes,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct SignedMagnitude {
	negative:  bool,
	magnitude: u64,
}

impl SignedMagnitude {
	fn from_prop(value: Option<PropValue>) -> Self {
		match value {
			Some(PropValue::I64(value)) => {
				Self { negative: value.is_negative(), magnitude: value.unsigned_abs() }
			},
			Some(PropValue::U64(value)) => Self { negative: false, magnitude: value },
			Some(PropValue::U16(value)) => Self { negative: false, magnitude: u64::from(value) },
			Some(PropValue::F32(value)) if value.is_finite() => {
				let negative = value.is_sign_negative();
				let magnitude = f64::from(value).abs().trunc().min(u64::MAX as f64) as u64;
				Self { negative: negative && magnitude != 0, magnitude }
			},
			Some(PropValue::Bool(value)) => {
				Self { negative: false, magnitude: u64::from(u8::from(value)) }
			},
			Some(PropValue::Str(value)) => parse_saturating_integer(&value),
			_ => Self::default(),
		}
	}
}

fn parse_saturating_integer(value: &str) -> SignedMagnitude {
	let value = value.trim();
	let (negative, digits) = value
		.strip_prefix('-')
		.map_or_else(|| (false, value.strip_prefix('+').unwrap_or(value)), |digits| (true, digits));
	if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
		return SignedMagnitude::default();
	}
	let magnitude = digits.bytes().fold(0u64, |magnitude, byte| {
		magnitude
			.saturating_mul(10)
			.saturating_add(u64::from(byte - b'0'))
	});
	SignedMagnitude { negative: negative && magnitude != 0, magnitude }
}

/// Retained leaf backing `<num>` and `<bytes>` markup.
///
/// The formatted text and its width are recomputed only when the semantic
/// value or `compact` flag changes; paint reuses that cached output.
pub struct NumberLeaf {
	props:             Props,
	slot:              Slot,
	kind:              NumberKind,
	cached:            Option<(SignedMagnitude, bool)>,
	text:              Str,
	width:             u16,
	#[cfg(test)]
	formatting_passes: usize,
}

impl NumberLeaf {
	/// Creates a number leaf; the `compact` property selects abbreviated output.
	pub fn new() -> Self {
		Self::of_kind(NumberKind::Number)
	}

	/// Creates a byte-count leaf using the established tool-renderer convention.
	pub fn bytes() -> Self {
		Self::of_kind(NumberKind::Bytes)
	}

	fn of_kind(kind: NumberKind) -> Self {
		Self {
			props: Props::new(),
			slot: next_slot(),
			kind,
			cached: None,
			text: Str::default(),
			width: 0,
			#[cfg(test)]
			formatting_passes: 0,
		}
	}

	/// Sets one number property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	fn refresh(&mut self) {
		let value = SignedMagnitude::from_prop(self.props.get(Prop::Value));
		let compact = self.kind == NumberKind::Number && self.props.flag(Prop::Compact);
		if self.cached == Some((value, compact)) {
			return;
		}

		let mut text = String::new();
		if value.negative {
			text.push('-');
		}
		let result = match self.kind {
			NumberKind::Number if compact => write_compact_count(&mut text, value.magnitude),
			NumberKind::Number => write!(&mut text, "{}", value.magnitude),
			NumberKind::Bytes => write_byte_count(&mut text, value.magnitude),
		};
		debug_assert!(result.is_ok(), "writing to String cannot fail");
		self.width = cell_width(&text);
		self.text = text.into();
		self.cached = Some((value, compact));
		#[cfg(test)]
		{
			self.formatting_passes += 1;
		}
	}
}

impl Default for NumberLeaf {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for NumberLeaf {
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
		self.refresh();
		(self.width, self.width)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		self.refresh();
		1
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		self.refresh();
		if rect.y >= pc.clip || rect.height == 0 || rect.width < self.width {
			return;
		}
		pc.frame
			.put(rect.x, rect.y, &self.text, self.props.style(&pc.ctx.theme));
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{Frame, Size};

	fn compact(value: u64) -> String {
		let mut out = String::new();
		write_compact_count(&mut out, value).unwrap();
		out
	}

	fn bytes(value: u64) -> String {
		let mut out = String::new();
		write_byte_count(&mut out, value).unwrap();
		out
	}

	#[test]
	fn compact_counts_keep_status_thresholds_and_rounding() {
		assert_eq!(compact(0), "0");
		assert_eq!(compact(999), "999");
		assert_eq!(compact(1_000), "1K");
		assert_eq!(compact(1_499), "1.5K");
		assert_eq!(compact(1_550), "1.6K");
		assert_eq!(compact(9_950), "10K");
		assert_eq!(compact(25_000), "25K");
		assert_eq!(compact(999_999), "1000K");
		assert_eq!(compact(1_000_000), "1M");
		assert_eq!(compact(1_500_000), "1.5M");
		assert_eq!(compact(200_000), "200K");
		assert_eq!(compact(2_500_000_000), "2.5B");
		assert_eq!(compact(u64::MAX), "18446744074B");
	}

	#[test]
	fn byte_counts_keep_tool_thresholds_rounding_and_t_unit_saturation() {
		assert_eq!(bytes(0), "0B");
		assert_eq!(bytes(999), "999B");
		assert_eq!(bytes(1_000), "1K");
		assert_eq!(bytes(2_400), "2.4K");
		assert_eq!(bytes(103_000), "103K");
		assert_eq!(bytes(1_200_000), "1.2M");
		assert_eq!(bytes(u64::MAX), "18446744T");
	}

	#[test]
	fn leaves_accept_negative_numbers_and_saturate_large_markup_values() {
		let mut number = NumberLeaf::new()
			.with(Prop::Value, "-1500")
			.with(Prop::Compact, true);
		number.refresh();
		assert_eq!(number.text.as_str(), "-1.5K");

		let mut byte_count = NumberLeaf::bytes().with(Prop::Value, "-1536");
		byte_count.refresh();
		assert_eq!(byte_count.text.as_str(), "-1.5K");

		let mut saturated = NumberLeaf::new().with(Prop::Value, "999999999999999999999999999");
		saturated.refresh();
		assert_eq!(saturated.text.as_str(), "18446744073709551615");

		let mut typed_max = NumberLeaf::bytes().with(Prop::Value, u64::MAX);
		typed_max.refresh();
		assert_eq!(typed_max.text.as_str(), "18446744T");
	}

	#[test]
	fn unchanged_measure_height_and_paint_reuse_cached_output() {
		let mut number = NumberLeaf::new()
			.with(Prop::Value, 1_500_000i64)
			.with(Prop::Compact, true);
		let ctx = UiContext::default();
		assert_eq!(number.measure(&ctx), (4, 4));
		assert_eq!(number.height(&ctx, 4), 1);

		let mut frame = Frame::new(Size::new(12, 1));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
		number.paint(&mut pc, Rect::new(0, 0, 12, 1));
		number.paint(&mut pc, Rect::new(0, 0, 12, 1));
		assert_eq!(number.formatting_passes, 1);

		number.props_mut().set(Prop::Value, 2_000_000i64);
		number.paint(&mut pc, Rect::new(0, 0, 12, 1));
		assert_eq!(number.text.as_str(), "2M");
		assert_eq!(number.formatting_passes, 2);
	}
}
