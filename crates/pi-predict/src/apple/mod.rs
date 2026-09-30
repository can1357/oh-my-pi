//! `NSSpellChecker` word completion (macOS only).
//!
//! Candidate selection is the pre-daemon `MacOSSpellingProvider`'s: Apple sees
//! only the current line, and the ghost text is the first candidate longer
//! than the prefix that case-insensitively extends it. Apple has no score, so
//! the confidence is a constant, lowered when the prefix is already a
//! dictionary word (`the|re`, `is|sue`), where a ghost is usually wrong; the
//! default show threshold hides those. Nothing is learned or persisted.
//!
//! Parity eval (research harness replaying held-out history.db prompts,
//! full `test` split, static), KSR % at wrong ghosts per 100 words:
//! - every candidate (threshold ≤ 0.25): 15.30 at 139.1, identical to the
//!   `macos-native` baseline (15.30 at 139.1);
//! - finished-word gate (default, threshold 1.0): 10.36 at 50.2. It keeps 68%
//!   of the savings at 36% of the noise and is the only operating point inside
//!   the balanced (≤ 70) budget, so it ships as the default.
//!
//! Latency through N-API: p50 2.2 ms, p99 5.0 ms.

use crate::{Config, Predictor};

#[cfg(target_os = "macos")]
pub mod appkit;

/// Open the Apple engine.
///
/// # Errors
/// Returns an error when `AppKit` cannot be initialized.
#[cfg(target_os = "macos")]
pub fn open(config: &Config) -> anyhow::Result<Box<dyn Predictor>> {
	appkit::run_blocking(appkit::ensure_available)?;
	Ok(Box::new(macos::Apple {
		show_threshold: config
			.show_threshold
			.unwrap_or(macos::DEFAULT_SHOW_THRESHOLD),
	}))
}

/// Open the Apple engine.
///
/// # Errors
/// Always: `NSSpellChecker` exists only on macOS.
#[cfg(not(target_os = "macos"))]
pub fn open(_config: &Config) -> anyhow::Result<Box<dyn Predictor>> {
	anyhow::bail!("the apple text prediction engine is macOS-only")
}

#[cfg(target_os = "macos")]
mod macos {
	use super::appkit;
	use crate::{Predictor, Query, Suggestion};

	/// Confidence of a completion for a prefix that is not itself a word.
	const COMPLETION_CONFIDENCE: f32 = 1.0;
	/// Confidence of a completion for a prefix that is already a word.
	const FINISHED_WORD_CONFIDENCE: f32 = 0.25;
	/// Tuned show threshold: hides completions of finished words.
	pub const DEFAULT_SHOW_THRESHOLD: f32 = COMPLETION_CONFIDENCE;
	/// Apple completes only prefixes of at least this many characters (the
	/// pre-daemon client never asked for shorter ones).
	const MIN_PREFIX_CHARS: usize = 2;

	pub struct Apple {
		pub show_threshold: f32,
	}

	fn utf16_len(text: &str) -> anyhow::Result<u32> {
		u32::try_from(text.encode_utf16().count())
			.map_err(|_| anyhow::anyhow!("line is too long for NSSpellChecker"))
	}

	/// First candidate that is longer than `prefix` and case-insensitively
	/// extends it, as the remaining characters.
	fn first_extension(candidates: &[String], prefix: &str) -> Option<String> {
		let lower_prefix = prefix.to_lowercase();
		let prefix_chars = prefix.chars().count();
		candidates.iter().find_map(|candidate| {
			(candidate.chars().count() > prefix_chars
				&& candidate.to_lowercase().starts_with(&lower_prefix))
			.then(|| candidate.chars().skip(prefix_chars).collect())
		})
	}

	fn lookup(before: &str, prefix: &str) -> anyhow::Result<Option<Suggestion>> {
		// Apple only ever saw the current line, cursor at the word's end.
		let line_start = before.rfind('\n').map_or(0, |newline| newline + 1);
		let line = format!("{}{prefix}", &before[line_start..]);
		let start = utf16_len(&before[line_start..])?;
		let length = utf16_len(prefix)?;
		let prefix = prefix.to_owned();
		let found = appkit::run_blocking(move || {
			let candidates = appkit::completions(&line, start, length)?;
			let Some(suffix) = first_extension(&candidates, &prefix) else {
				return Ok(None);
			};
			let finished = appkit::is_known_word(&line, start, length)?;
			Ok(Some((suffix, finished)))
		})?;
		Ok(found.map(|(suffix, finished)| Suggestion {
			suffix,
			confidence: if finished {
				FINISHED_WORD_CONFIDENCE
			} else {
				COMPLETION_CONFIDENCE
			},
		}))
	}

	impl Predictor for Apple {
		fn complete(&mut self, query: &Query<'_>) -> Option<Suggestion> {
			if query.prefix.chars().count() < MIN_PREFIX_CHARS {
				return None;
			}
			// `open` already proved AppKit works; a failed lookup (e.g. a line
			// longer than NSRange allows) simply shows nothing.
			lookup(query.before, query.prefix)
				.ok()
				.flatten()
				.filter(|suggestion| suggestion.confidence >= self.show_threshold)
		}

		fn observe(&mut self, _prompt: &str) {}

		fn feedback(&mut self, _query: &Query<'_>, _suggestion: &str, _accepted: bool) {}

		fn persist(&mut self) -> anyhow::Result<()> {
			Ok(())
		}
	}

	#[cfg(test)]
	mod tests {
		use super::*;

		#[test]
		fn single_letter_prefixes_get_no_completion() {
			let mut apple = Apple { show_threshold: f32::NEG_INFINITY };
			for prefix in ["o", "é", ""] {
				assert_eq!(apple.complete(&Query { before: "figure ", prefix }), None, "{prefix:?}");
			}
		}
	}
}
