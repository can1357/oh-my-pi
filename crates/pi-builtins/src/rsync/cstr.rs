//! Upstream's C-string parsing semantics ("C" locale): NUL-terminated byte
//! strings, `isspace`, and `atol`, for peer and config text upstream reads
//! with the C library.

/// The bytes before the first NUL (all of `bytes` when there is none).
pub(crate) fn until_nul(bytes: &[u8]) -> &[u8] {
	memchr::memchr(0, bytes).map_or(bytes, |end| &bytes[..end])
}

/// C `isspace` in the "C" locale.
pub(crate) fn is_c_space(b: u8) -> bool {
	matches!(b, b' ' | b'\t' | b'\n' | b'\x0b' | b'\x0c' | b'\r')
}

/// C `atol`: leading `isspace`, optional sign, decimal digits (saturating);
/// stops at anything else.
pub(crate) fn atol(s: &[u8]) -> i64 {
	let mut i = 0;
	while s.get(i).is_some_and(|&b| is_c_space(b)) {
		i += 1;
	}
	let neg = match s.get(i) {
		Some(b'-') => {
			i += 1;
			true
		}
		Some(b'+') => {
			i += 1;
			false
		}
		_ => false,
	};
	let mut n: i64 = 0;
	while let Some(d) = s.get(i).filter(|b| b.is_ascii_digit()) {
		n = n.saturating_mul(10).saturating_add(i64::from(d - b'0'));
		i += 1;
	}
	if neg { -n } else { n }
}
