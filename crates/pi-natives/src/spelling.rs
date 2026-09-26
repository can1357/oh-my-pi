//! macOS spelling (typo ranges, replacement guesses) and autocorrection
//! services. Word completion lives in `pi_predict::apple` behind `TextPredictor`.
//!
//! `AppleSpell` exposes UTF-16 ranges through [`NSSpellChecker`]. JavaScript
//! strings use the same indexing unit, so ranges cross N-API without remapping.
//! Other platforms expose the same API as an unavailable, no-op backend.
//! All `AppKit` work runs serially on the one process-wide spelling thread in
//! `pi_predict::apple::appkit` (shared with the `apple` word-completion
//! engine) so the singleton keeps a stable thread identity.

use napi_derive::napi;

/// A misspelled span measured in JavaScript/UTF-16 code units.
#[napi(object)]
pub struct SpellingRange {
	/// Inclusive UTF-16 start offset.
	pub start:  u32,
	/// UTF-16 length of the misspelled span.
	pub length: u32,
}

#[cfg(target_os = "macos")]
mod platform {
	use napi::{Error, Result, Status};
	use pi_predict::apple::appkit;

	use super::SpellingRange;

	/// Run `work` on the process-wide `AppKit` spelling thread (owned by
	/// `pi_predict::apple::appkit`, shared with the `apple` engine).
	pub async fn run<T: Send + 'static>(
		work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
	) -> Result<T> {
		appkit::run(work)
			.await
			.map_err(|error| Error::new(Status::GenericFailure, format!("{error:#}")))
	}

	pub fn check(text: &str) -> anyhow::Result<Vec<SpellingRange>> {
		Ok(appkit::check(text)?
			.into_iter()
			.map(|range| SpellingRange { start: range.start, length: range.length })
			.collect())
	}
}

/// Whether the host can use Apple's native spelling service.
#[napi(js_name = "macOSSpellCheckerAvailable")]
#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
pub fn macos_spell_checker_available() -> bool {
	cfg!(target_os = "macos")
}

/// Find every misspelled word using the active macOS dictionaries.
///
/// Returns an empty list when Apple's spelling service is unavailable.
/// On macOS, the check runs on the dedicated spelling thread.
#[napi(js_name = "macOSCheckSpelling")]
#[cfg_attr(
	not(target_os = "macos"),
	allow(clippy::unused_async, reason = "napi contract returns a Promise on every platform")
)]
pub async fn macos_check_spelling(text: String) -> napi::Result<Vec<SpellingRange>> {
	#[cfg(target_os = "macos")]
	{
		platform::run(move || platform::check(&text)).await
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = text;
		Ok(Vec::new())
	}
}

/// Return the autocorrection macOS chooses for one completed-word range.
///
/// Returns `null` when no confident correction exists or the service is
/// unavailable.
/// On macOS, the lookup runs on the dedicated spelling thread.
#[napi(js_name = "macOSAutocorrectWord")]
#[cfg_attr(
	not(target_os = "macos"),
	allow(clippy::unused_async, reason = "napi contract returns a Promise on every platform")
)]
pub async fn macos_autocorrect_word(
	text: String,
	start: u32,
	length: u32,
) -> napi::Result<Option<String>> {
	#[cfg(target_os = "macos")]
	{
		platform::run(move || pi_predict::apple::appkit::correction(&text, start, length)).await
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = (text, start, length);
		Ok(None)
	}
}
/// Return macOS replacement guesses for one misspelled-word range.
///
/// Returns an empty list when Apple's spelling service is unavailable.
/// On macOS, the lookup runs on the dedicated spelling thread.
#[napi(js_name = "macOSSpellingGuesses")]
#[cfg_attr(
	not(target_os = "macos"),
	allow(clippy::unused_async, reason = "napi contract returns a Promise on every platform")
)]
pub async fn macos_spelling_guesses(
	text: String,
	start: u32,
	length: u32,
) -> napi::Result<Vec<String>> {
	#[cfg(target_os = "macos")]
	{
		platform::run(move || pi_predict::apple::appkit::guesses(&text, start, length)).await
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = (text, start, length);
		Ok(Vec::new())
	}
}
