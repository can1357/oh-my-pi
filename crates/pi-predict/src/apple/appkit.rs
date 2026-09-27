//! The one thread that talks to `NSSpellChecker`.
//!
//! `AppKit`'s shared spell checker must keep a stable thread identity, so
//! every caller in the process (the `apple` engine here, typo detection and
//! autocorrect in `pi_natives::spelling`) submits work to this lazily spawned,
//! dedicated thread. Ranges are UTF-16 offsets, the unit both `NSString` and
//! JavaScript strings index by.

use std::sync::LazyLock;

use anyhow::{Context, bail};
use objc2::rc::Retained;
use objc2_app_kit::NSSpellChecker;
use objc2_foundation::{NSArray, NSRange, NSString, NSTextCheckingType};

type Job = Box<dyn FnOnce() + Send + 'static>;

static SPELLING_THREAD: LazyLock<flume::Sender<Job>> = LazyLock::new(|| {
	let (sender, receiver) = flume::unbounded::<Job>();
	std::thread::Builder::new()
		.name("pi-native-spelling".into())
		.spawn(move || {
			while let Ok(job) = receiver.recv() {
				job();
			}
		})
		.expect("failed to spawn the native spelling thread");
	sender
});
static APP_KIT_LOADED: LazyLock<bool> = LazyLock::new(|| {
	// SAFETY: AppKit documents `NSApplicationLoad` as process-global and
	// idempotent; `LazyLock` guarantees this process calls it at most once.
	unsafe { NSApplicationLoad() }
});
const NS_NOT_FOUND: usize = isize::MAX as usize;
const THREAD_STOPPED: &str = "native spelling thread stopped";

#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {
	fn NSApplicationLoad() -> bool;
}

/// A misspelled span in UTF-16 code units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpellingRange {
	/// Inclusive UTF-16 start offset.
	pub start:  u32,
	/// UTF-16 length of the span.
	pub length: u32,
}

fn checker() -> anyhow::Result<Retained<NSSpellChecker>> {
	if !*APP_KIT_LOADED {
		bail!("failed to initialize AppKit");
	}
	let checker = NSSpellChecker::sharedSpellChecker();
	checker.setAutomaticallyIdentifiesLanguages(true);
	Ok(checker)
}

fn submit<T: Send + 'static>(
	work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<flume::Receiver<anyhow::Result<T>>> {
	let (reply, result) = flume::bounded(1);
	SPELLING_THREAD
		.send(Box::new(move || {
			let _ = reply.send(work());
		}))
		.map_err(|_| anyhow::anyhow!(THREAD_STOPPED))?;
	Ok(result)
}

/// Run `work` on the spelling thread and await its result.
///
/// # Errors
/// Returns `work`'s error, or an error when the spelling thread is gone.
pub async fn run<T: Send + 'static>(
	work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
	submit(work)?
		.recv_async()
		.await
		.map_err(|_| anyhow::anyhow!(THREAD_STOPPED))?
}

/// Run `work` on the spelling thread, blocking the calling thread until it
/// finishes. For callers that own a dedicated thread (the `apple` engine).
///
/// # Errors
/// Returns `work`'s error, or an error when the spelling thread is gone.
pub fn run_blocking<T: Send + 'static>(
	work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
	submit(work)?
		.recv()
		.map_err(|_| anyhow::anyhow!(THREAD_STOPPED))?
}

/// Fail unless `AppKit` and the shared spell checker are usable.
/// Call on the spelling thread.
///
/// # Errors
/// Returns an error when `AppKit` cannot be initialized.
pub fn ensure_available() -> anyhow::Result<()> {
	checker().map(|_| ())
}

fn ns_range(start: u32, length: u32) -> anyhow::Result<NSRange> {
	Ok(NSRange {
		location: usize::try_from(start).context("spelling range start is too large")?,
		length:   usize::try_from(length).context("spelling range length is too large")?,
	})
}

/// Every misspelled word in `text`. Call on the spelling thread.
///
/// # Errors
/// Returns an error when `AppKit` is unavailable or a range overflows.
pub fn check(text: &str) -> anyhow::Result<Vec<SpellingRange>> {
	let checker = checker()?;
	let text = NSString::from_str(text);
	let full = NSRange { location: 0, length: text.length() };
	// `checkString:...` honors `automaticallyIdentifiesLanguages`, selecting
	// the dictionary per detected run; the legacy `checkSpellingOfString:`
	// used only the shared checker's single current language (issue #9334).
	// SAFETY: `options`/`orthography` are nil and `word_count` is null, all
	// documented as valid; the returned array is retained by objc2.
	let results = unsafe {
		checker.checkString_range_types_options_inSpellDocumentWithTag_orthography_wordCount(
			&text,
			full,
			NSTextCheckingType::Spelling.bits(),
			None,
			0,
			None,
			std::ptr::null_mut(),
		)
	};
	let mut ranges = Vec::new();
	for result in &results {
		let range = result.range();
		// With `automaticallyIdentifiesLanguages`, `checkString:` also returns
		// an orthography result spanning the entire string; only spelling
		// results mark misspellings (rendering them as typo ranges doubled
		// editor text).
		if result.resultType() != NSTextCheckingType::Spelling {
			continue;
		}
		if range.length == 0 || range.location >= NS_NOT_FOUND {
			continue;
		}
		ranges.push(SpellingRange {
			start:  u32::try_from(range.location).context("spelling range start is too large")?,
			length: u32::try_from(range.length).context("spelling range length is too large")?,
		});
	}
	Ok(ranges)
}

fn strings(values: Option<Retained<NSArray<NSString>>>) -> Vec<String> {
	values
		.map(|values| values.iter().map(|value| value.to_string()).collect())
		.unwrap_or_default()
}

/// Language macOS identifies for a word range, honoring automatic language
/// identification. Falls back to the shared checker's current language when
/// detection is inconclusive (issue #9334).
fn word_language(checker: &NSSpellChecker, text: &NSString, range: NSRange) -> Retained<NSString> {
	checker
		.languageForWordRange_inString_orthography(range, text, None)
		.unwrap_or_else(|| checker.language())
}

/// Dictionary completions for the partial word at `start..start + length`.
/// Call on the spelling thread.
///
/// # Errors
/// Returns an error when `AppKit` is unavailable or a range overflows.
pub fn completions(text: &str, start: u32, length: u32) -> anyhow::Result<Vec<String>> {
	let checker = checker()?;
	let text = NSString::from_str(text);
	let range = ns_range(start, length)?;
	let language = word_language(&checker, &text, range);
	let values = checker.completionsForPartialWordRange_inString_language_inSpellDocumentWithTag(
		range,
		&text,
		Some(&*language),
		0,
	);
	Ok(strings(values))
}

/// Whether the word at `start..start + length` is spelled correctly in the
/// language macOS identifies for it. Call on the spelling thread.
///
/// # Errors
/// Returns an error when `AppKit` is unavailable or a range overflows.
pub fn is_known_word(text: &str, start: u32, length: u32) -> anyhow::Result<bool> {
	let checker = checker()?;
	let text = NSString::from_str(text);
	let range = ns_range(start, length)?;
	let language = word_language(&checker, &text, range);
	let word = text.substringWithRange(range);
	// SAFETY: `word_count` is null, which AppKit documents as valid; the
	// string and language are live retained objects for the whole call.
	let misspelled = unsafe {
		checker.checkSpellingOfString_startingAt_language_wrap_inSpellDocumentWithTag_wordCount(
			&word,
			0,
			Some(&*language),
			false,
			0,
			std::ptr::null_mut(),
		)
	};
	Ok(misspelled.length == 0 || misspelled.location >= NS_NOT_FOUND)
}

/// Replacement guesses for the misspelled word at `start..start + length`.
/// Call on the spelling thread.
///
/// # Errors
/// Returns an error when `AppKit` is unavailable or a range overflows.
pub fn guesses(text: &str, start: u32, length: u32) -> anyhow::Result<Vec<String>> {
	let checker = checker()?;
	let text = NSString::from_str(text);
	let range = ns_range(start, length)?;
	let language = word_language(&checker, &text, range);
	let values = checker.guessesForWordRange_inString_language_inSpellDocumentWithTag(
		range,
		&text,
		Some(&*language),
		0,
	);
	Ok(strings(values))
}

/// The autocorrection macOS would apply to the word at `start..start + length`,
/// if it is confident. Call on the spelling thread.
///
/// # Errors
/// Returns an error when `AppKit` is unavailable or a range overflows.
pub fn correction(text: &str, start: u32, length: u32) -> anyhow::Result<Option<String>> {
	let checker = checker()?;
	let text = NSString::from_str(text);
	let range = ns_range(start, length)?;
	let language = word_language(&checker, &text, range);
	let value = checker
		.correctionForWordRange_inString_language_inSpellDocumentWithTag(range, &text, &language, 0);
	Ok(value.map(|value| value.to_string()))
}
