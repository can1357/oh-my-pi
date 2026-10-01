//! Pre-tokenization: per-family piece splitting.
//!
//! Families use HF `Split` semantics with `behavior: Isolated` — every
//! match becomes its own piece and unmatched gaps survive as pieces too.
//! Every family runs a hand-written codepoint scanner ([`crate::utok::scan`])
//! natively over any UTF flavor. The regex chain ([`Splitter::Regex`]) is
//! test-only: it is the differential oracle the scanners are validated
//! against, and fancy-regex is a dev-dependency.

use crate::utok::{scan, utf::Unit};

/// A family's piece splitter.
pub enum Splitter {
	/// Compiled regex chain (test-only differential oracle; UTF-8 input).
	#[cfg(test)]
	Regex(Vec<fancy_regex::Regex>),
	/// tiktoken `o200k_base` scanner.
	O200k,
	/// tiktoken `cl100k_base` scanner.
	Cl100k,
	/// `DeepSeek` V3..V4 three-stage chain scanner.
	DeepSeek,
	/// Kimi K2/K3 scanner.
	Kimi,
	/// Qwen3 scanner.
	Qwen,
}

impl Splitter {
	/// Compile a regex chain oracle. Panics on invalid patterns
	/// (compile-time constants).
	#[cfg(test)]
	pub fn new(patterns: &[&str]) -> Self {
		Self::Regex(
			patterns
				.iter()
				.map(|p| fancy_regex::Regex::new(p).expect("utoken: invalid split pattern"))
				.collect(),
		)
	}

	/// Whether this splitter needs `&str` input (the engine transcodes
	/// non-UTF-8 flavors before calling in).
	#[cfg(test)]
	pub const fn is_regex(&self) -> bool {
		matches!(self, Self::Regex(_))
	}

	/// Feed every piece of `units` to `f`, in order, covering the input
	/// exactly. `Regex` requires `U = u8` holding valid UTF-8.
	pub fn for_each_piece<U: Unit>(&self, units: &[U], mut f: impl FnMut(&[U])) {
		match self {
			Self::O200k => scan_loop(units, &mut f, scan::o200k::next_piece),
			Self::Cl100k => scan_loop(units, &mut f, scan::cl100k::next_piece),
			Self::DeepSeek => scan::deepseek::for_each_piece(units, &mut f),
			Self::Kimi => scan_loop(units, &mut f, scan::kimi::next_piece),
			Self::Qwen => scan_loop(units, &mut f, scan::qwen::next_piece),
			#[cfg(test)]
			Self::Regex(_) => {
				let bytes = U::as_utf8(units).expect("utoken: regex splitter requires UTF-8 input");
				let text =
					std::str::from_utf8(bytes).expect("utoken: regex splitter requires valid UTF-8");
				let base = text.as_ptr() as usize;
				for piece in self.split(text) {
					let a = piece.as_ptr() as usize - base;
					f(&units[a..a + piece.len()]);
				}
			},
		}
	}

	/// Split `text` into pieces (any variant; `&str` view). Test-only:
	/// scanner differentials compare piece lists against the regex oracle.
	#[cfg(test)]
	pub fn split<'t>(&self, text: &'t str) -> Vec<&'t str> {
		match self {
			#[cfg(test)]
			Self::Regex(stages) => {
				let mut pieces = vec![text];
				for re in stages {
					let mut next = Vec::with_capacity(pieces.len());
					for piece in pieces {
						let mut last = 0usize;
						for m in re.find_iter(piece) {
							let m = m.expect("utoken: regex engine error");
							if m.start() > last {
								next.push(&piece[last..m.start()]);
							}
							if !m.as_str().is_empty() {
								next.push(m.as_str());
							}
							last = m.end();
						}
						if last < piece.len() {
							next.push(&piece[last..]);
						}
					}
					pieces = next;
				}
				pieces
			},
			_ => {
				let mut pieces = Vec::new();
				// Scanner boundaries are codepoint boundaries, so byte
				// ranges are valid `str` slices.
				self.for_each_piece(text.as_bytes(), |p| {
					let a = p.as_ptr() as usize - text.as_ptr() as usize;
					pieces.push(&text[a..a + p.len()]);
				});
				pieces
			},
		}
	}
}

/// Drive a single-stage scanner over `units`.
pub(crate) fn scan_loop<U: Unit>(
	units: &[U],
	f: &mut impl FnMut(&[U]),
	next: impl Fn(&[U], usize) -> usize,
) {
	let mut pos = 0;
	while pos < units.len() {
		let end = next(units, pos);
		debug_assert!(pos < end && end <= units.len(), "utoken: scanner must advance within bounds");
		f(&units[pos..end]);
		pos = end;
	}
}

/// NFC-normalize (Qwen3 input contract). Borrows when no work is needed:
/// ASCII short-circuit (std `is_ascii` is word-vectorized; cf. xutf's SIMD
/// ASCII kernels) then the NFC quick-check, so only text that actually
/// needs recomposition allocates.
pub fn nfc(text: &str) -> std::borrow::Cow<'_, str> {
	use xutf::ToUnicodeNormalized;
	if text.is_ascii() || xutf::is_nfc(text) {
		return std::borrow::Cow::Borrowed(text);
	}
	std::borrow::Cow::Owned(text.to_nfc())
}
