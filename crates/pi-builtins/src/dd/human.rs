//! Human-readable sizes with the one option set `dd` uses: autoscaled,
//! round-to-nearest, `B` suffix, space before the unit, `kB`/`KiB` spelling.
//!
//! Neither `uucore::format::human` (rounds up, `1.1K` style) nor uutils dd's
//! `to_magnitude_and_suffix` (float rounding: 1050 bytes is `1.1 kB` where GNU
//! prints `1.0 kB`) produces GNU's statistics line.

/// Unit letters indexed by power of the base.
const POWER_LETTER: [u8; 11] = [0, b'K', b'M', b'G', b'T', b'P', b'E', b'Z', b'Y', b'R', b'Q'];
const EXPONENT_MAX: u32 = 10;

/// `human_readable (n, buf, human_autoscale | human_round_to_nearest |
/// human_space_before_unit | human_SI | human_B [| human_base_1024],
/// from_block_size, to_block_size)`: `n * from / to`, scaled by powers of
/// 1000 (`kB`, `MB`, …) or 1024 (`KiB`, `MiB`, …).
pub(super) fn human_readable(n: u64, base_1024: bool, from: u64, to: u64) -> String {
	let base: u64 = if base_1024 { 1024 } else { 1000 };

	let exact = if to <= from {
		if from.is_multiple_of(to) {
			n.checked_mul(from / to).map(|amt| (amt, 0, 0))
		} else {
			None
		}
	} else if from != 0 && to.is_multiple_of(from) {
		let divisor = to / from;
		let r10 = (n % divisor).wrapping_mul(10);
		let r2 = (r10 % divisor).wrapping_mul(2);
		let rounding = if r2 < divisor { u64::from(0 < r2) } else { 2 + u64::from(divisor < r2) };
		Some((n / divisor, r10 / divisor, rounding))
	} else {
		None
	};

	let (number, exponent) = match exact {
		Some((amt, tenths, rounding)) => integer_scaled(amt, tenths, rounding, base),
		None => float_scaled(n as f64 * (from as f64 / to as f64), base, base_1024),
	};

	let mut out = number;
	out.push(' ');
	if exponent != 0 {
		out.push(if !base_1024 && exponent == 1 {
			'k'
		} else {
			char::from(POWER_LETTER[exponent as usize])
		});
		if base_1024 {
			out.push('i');
		}
	}
	out.push('B');
	out
}

/// The `use_integer_arithmetic` branch: `amt.tenths` plus a rounding state
/// (0 exact, 1 below half, 2 exactly half, 3 above half of a tenth).
fn integer_scaled(mut amt: u64, mut tenths: u64, mut rounding: u64, base: u64) -> (String, u32) {
	let mut exponent = 0;
	let mut fraction = None;

	if base <= amt {
		loop {
			let r10 = (amt % base) * 10 + tenths;
			let r2 = (r10 % base) * 2 + (rounding >> 1);
			amt /= base;
			tenths = r10 / base;
			rounding = if r2 < base {
				u64::from(r2 + rounding != 0)
			} else {
				2 + u64::from(base < r2 + rounding)
			};
			exponent += 1;
			if !(base <= amt && exponent < EXPONENT_MAX) {
				break;
			}
		}

		if amt < 10 {
			if 2 < rounding + (tenths & 1) {
				tenths += 1;
				rounding = 0;
				if tenths == 10 {
					amt += 1;
					tenths = 0;
				}
			}
			if amt < 10 {
				fraction = Some(tenths);
				tenths = 0;
				rounding = 0;
			}
		}
	}

	if 5 < tenths + u64::from(0 < rounding + (amt & 1)) {
		amt += 1;
		if amt == base && exponent < EXPONENT_MAX {
			exponent += 1;
			fraction = Some(0);
			amt = 1;
		}
	}

	let number = match fraction {
		Some(tenths) => format!("{amt}.{tenths}"),
		None => amt.to_string(),
	};
	(number, exponent)
}

/// The floating-point fallback, used when `n * from / to` has no exact
/// integer form (transfer rates).
fn float_scaled(mut value: f64, base: u64, base_1024: bool) -> (String, u32) {
	let base = base as f64;
	let mut scale = 1.0;
	let mut exponent = 0;
	loop {
		scale *= base;
		exponent += 1;
		if !(scale * base <= value && exponent < EXPONENT_MAX) {
			break;
		}
	}
	value /= scale;

	let one_decimal = format!("{value:.1}");
	if 1 + 2 + usize::from(!base_1024) < one_decimal.len() {
		(format!("{:.0}", value * 10.0 / 10.0), exponent)
	} else {
		(one_decimal, exponent)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn byte_counts_scale_like_gnu() {
		assert_eq!(human_readable(0, false, 1, 1), "0 B");
		assert_eq!(human_readable(999, false, 1, 1), "999 B");
		assert_eq!(human_readable(1000, false, 1, 1), "1.0 kB");
		assert_eq!(human_readable(1000, true, 1, 1), "1000 B");
		assert_eq!(human_readable(1024, true, 1, 1), "1.0 KiB");
		assert_eq!(human_readable(1_048_576, false, 1, 1), "1.0 MB");
		assert_eq!(human_readable(1_048_576, true, 1, 1), "1.0 MiB");
		assert_eq!(human_readable(10_485_760, false, 1, 1), "10 MB");
		assert_eq!(human_readable(9_999, false, 1, 1), "10 kB");
		assert_eq!(human_readable(1 << 60, true, 1, 1), "1.0 EiB");
		// Exact halves round to even, which float formatting gets wrong.
		assert_eq!(human_readable(1050, false, 1, 1), "1.0 kB");
		assert_eq!(human_readable(1150, false, 1, 1), "1.2 kB");
		assert_eq!(human_readable(999_001, false, 1, 1), "999 kB");
	}

	#[test]
	fn rates_use_the_floating_point_path() {
		// 2 bytes in 42 µs: 47619 B/s.
		assert_eq!(human_readable(2, false, 1_000_000_000, 42_000), "47.6 kB");
		assert_eq!(human_readable(2, false, 1_000_000_000, 15_000), "133 kB");
		assert_eq!(human_readable(0, false, 1_000_000_000, 17_000), "0.0 kB");
	}
}
