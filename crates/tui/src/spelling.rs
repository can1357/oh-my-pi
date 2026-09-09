//! Non-blocking platform spelling assistance for editor components.
//!
//! One background worker serves typo detection, replacement guesses,
//! partial-word completions (ghost text), and confident autocorrections.

use std::{ops::Range, sync::Arc, thread};

use flume::{Receiver, Sender};
use omp_core::{Str, str::IntoStr};
use parking_lot::Mutex;
use smallvec::SmallVec;

const MAX_CHECK_BYTES: usize = 20_000;
#[cfg(target_os = "macos")]
const MAX_SUGGESTIONS: usize = 10;
/// Independently configurable native spelling features.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SpellingFeatures {
	/// Decorate misspelled words.
	pub typo_detection: bool,
	/// Offer native word completion.
	pub autocomplete:   bool,
	/// Apply confident native corrections at word boundaries.
	pub autocorrect:    bool,
}

impl Default for SpellingFeatures {
	fn default() -> Self {
		Self { typo_detection: true, autocomplete: true, autocorrect: false }
	}
}

/// One misspelled UTF-8 byte range.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TypoRange {
	/// Inclusive byte offset.
	pub start: usize,
	/// Exclusive byte offset.
	pub end:   usize,
}

/// A spelling result paired with the dictionary language selected by the host.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SpellingResult {
	/// Misspelled ranges, sorted and non-overlapping.
	pub typos:    Vec<TypoRange>,
	/// Active dictionary language, when identified.
	pub language: Option<Str>,
}

#[derive(Debug)]
enum Request {
	Check { generation: u64, source: Str, masked: Str },
	Guesses { generation: u64, text: Str, range: Range<usize> },
	Complete { generation: u64, text: Str, range: Range<usize> },
	Correct { generation: u64, text: Str, range: Range<usize> },
}

#[derive(Debug)]
enum Response {
	Checked {
		generation: u64,
		text:       Str,
		result:     SpellingResult,
	},
	Guesses {
		generation: u64,
		text:       Str,
		range:      Range<usize>,
		items:      SmallVec<Str, 8>,
	},
	Complete {
		generation: u64,
		text:       Str,
		range:      Range<usize>,
		suffix:     Option<Str>,
	},
	Correct {
		generation: u64,
		text:       Str,
		range:      Range<usize>,
		correction: Option<Str>,
	},
}

/// Latest-only request slots, one per lane, drained by the worker between
/// platform calls so keystroke bursts coalesce to the newest request.
#[derive(Debug, Default)]
struct PendingRequests {
	check:    Option<Request>,
	complete: Option<Request>,
	correct:  Option<Request>,
	guesses:  Option<Request>,
}

impl PendingRequests {
	fn put(&mut self, request: Request) {
		let slot = match request {
			Request::Check { .. } => &mut self.check,
			Request::Complete { .. } => &mut self.complete,
			Request::Correct { .. } => &mut self.correct,
			Request::Guesses { .. } => &mut self.guesses,
		};
		*slot = Some(request);
	}

	fn take(&mut self) -> Option<Request> {
		self
			.correct
			.take()
			.or_else(|| self.guesses.take())
			.or_else(|| self.complete.take())
			.or_else(|| self.check.take())
	}
}

/// One partial-word completion: the source text, the prefix range, and the
/// ghost suffix once the platform answers.
#[derive(Debug)]
struct WordCompletion {
	text:     Str,
	range:    Range<usize>,
	suffix:   Option<Str>,
	resolved: bool,
}

/// Latest-only asynchronous spelling client. Platform calls always execute on
/// one dedicated worker; each request lane (check, completion, correction,
/// guesses) coalesces bursts to its newest request.
pub struct SpellingAssist {
	request:         Sender<Request>,
	response:        Receiver<Response>,
	pending:         Arc<Mutex<PendingRequests>>,
	generation:      u64,
	check_ticket:    Option<u64>,
	check_source:    Option<Str>,
	guesses_ticket:  Option<u64>,
	complete_ticket: Option<u64>,
	correct_ticket:  Option<u64>,
	checked_text:    Str,
	typos:           Vec<TypoRange>,
	projected:       Vec<TypoRange>,
	language:        Option<Str>,
	guesses:         Option<(Str, Range<usize>, SmallVec<Str, 8>)>,
	completion:      Option<WordCompletion>,
	correction:      Option<(Range<usize>, Str)>,
}

impl SpellingAssist {
	/// Starts the platform worker. Unsupported hosts return an inert client.
	pub fn new() -> Self {
		let (request_tx, request_rx) = flume::bounded(1);
		let (response_tx, response_rx) = flume::unbounded();
		let pending = Arc::new(Mutex::new(PendingRequests::default()));
		let worker_pending = Arc::clone(&pending);
		thread::Builder::new()
			.name("omp-spelling".into())
			.spawn(move || worker(request_rx, response_tx, worker_pending))
			.expect("spelling worker thread");
		Self {
			request: request_tx,
			response: response_rx,
			pending,
			generation: 0,
			check_ticket: None,
			check_source: None,
			guesses_ticket: None,
			complete_ticket: None,
			correct_ticket: None,
			checked_text: Str::default(),
			typos: Vec::new(),
			projected: Vec::new(),
			language: None,
			guesses: None,
			completion: None,
			correction: None,
		}
	}

	fn send(&self, request: Request) {
		if let Err(flume::TrySendError::Full(request) | flume::TrySendError::Disconnected(request)) =
			self.request.try_send(request)
		{
			self.pending.lock().put(request);
		}
	}

	/// Schedules a latest-only check and keeps prior ranges projected while it
	/// runs.
	pub fn check(&mut self, text: &str, masked: &[Range<usize>]) {
		if text.len() > MAX_CHECK_BYTES {
			self.check_ticket = None;
			self.check_source = None;
			self.checked_text = Str::default();
			self.typos.clear();
			self.projected.clear();
			self.language = None;
			return;
		}
		if text == self.checked_text.as_str() {
			// Returning to the last checked text obsoletes any in-flight
			// check for an intervening edit. Its projected ranges describe
			// that edit, not the restored source.
			self.check_ticket = None;
			self.check_source = None;
			self.projected.clear();
			return;
		}
		if self.check_source.as_deref() == Some(text) {
			return;
		}
		self.generation += 1;
		self.check_ticket = Some(self.generation);
		self.projected = project_ranges(&self.checked_text, text, &self.typos);
		let source = text.into_str();
		self.check_source = Some(source.clone());
		let masked = mask_ranges(text, masked);
		self.send(Request::Check { generation: self.generation, source, masked: masked.into_str() });
	}

	/// Requests replacements for the word under the cursor.
	pub fn request_guesses(&mut self, text: &str, range: Range<usize>) {
		if text.len() > MAX_CHECK_BYTES || range.start >= range.end || range.end > text.len() {
			return;
		}
		self.generation += 1;
		self.guesses_ticket = Some(self.generation);
		self.guesses = None;
		self.send(Request::Guesses { generation: self.generation, text: text.into_str(), range });
	}

	/// Requests the platform completion for the partial word at `range`,
	/// coalescing repeats for the same text and range.
	pub fn request_completion(&mut self, text: &str, range: Range<usize>) {
		if text.len() > MAX_CHECK_BYTES || range.start >= range.end || range.end > text.len() {
			return;
		}
		if self
			.completion
			.as_ref()
			.is_some_and(|completion| completion.range == range && completion.text.as_str() == text)
		{
			return;
		}
		self.generation += 1;
		self.complete_ticket = Some(self.generation);
		let source = text.into_str();
		self.completion = Some(WordCompletion {
			text:     source.clone(),
			range:    range.clone(),
			suffix:   None,
			resolved: false,
		});
		self.send(Request::Complete { generation: self.generation, text: source, range });
	}

	/// Requests a confident correction for the completed word at `range`.
	pub fn request_correction(&mut self, text: &str, range: Range<usize>) {
		if text.len() > MAX_CHECK_BYTES || range.start >= range.end || range.end > text.len() {
			return;
		}
		self.generation += 1;
		self.correct_ticket = Some(self.generation);
		self.correction = None;
		self.send(Request::Correct { generation: self.generation, text: text.into_str(), range });
	}

	/// Drains completed work, dropping results stale against `text`.
	pub fn poll(&mut self, text: &str) -> bool {
		let mut changed = false;
		while let Ok(response) = self.response.try_recv() {
			match response {
				Response::Checked { generation, text: checked, result }
					if self.check_ticket == Some(generation) =>
				{
					self.check_ticket = None;
					self.check_source = None;
					if checked.as_str() == text {
						self.checked_text = checked;
						self.typos = result.typos;
						self.language = result.language;
						self.projected.clear();
						changed = true;
					}
				},
				Response::Guesses { generation, text: source, range, items }
					if self.guesses_ticket == Some(generation) =>
				{
					self.guesses_ticket = None;
					if source.as_str() == text {
						self.guesses = Some((source, range, items));
						changed = true;
					}
				},
				Response::Complete { generation, text: source, range, suffix }
					if self.complete_ticket == Some(generation) =>
				{
					self.complete_ticket = None;
					if source.as_str() == text
						&& let Some(completion) = &mut self.completion
						&& completion.range == range
					{
						// A ghost appearing changes rendered output; a null
						// suffix leaves the current paint correct.
						changed |= suffix.is_some();
						completion.suffix = suffix;
						completion.resolved = true;
					}
				},
				Response::Correct { generation, text: source, range, correction }
					if self.correct_ticket == Some(generation) =>
				{
					self.correct_ticket = None;
					if source.as_str() == text
						&& let Some(correction) = correction
					{
						self.correction = Some((range, correction));
						changed = true;
					}
				},
				_ => {},
			}
		}
		changed
	}

	/// Current typo ranges, including edit-projected ranges during recheck.
	pub fn typo_ranges(&self) -> &[TypoRange] {
		if self.projected.is_empty() {
			&self.typos
		} else {
			&self.projected
		}
	}

	/// Clears cached state and invalidates outstanding results.
	pub fn clear(&mut self) {
		*self.pending.lock() = PendingRequests::default();
		self.check_ticket = None;
		self.check_source = None;
		self.guesses_ticket = None;
		self.complete_ticket = None;
		self.correct_ticket = None;
		self.checked_text = Str::default();
		self.typos.clear();
		self.projected.clear();
		self.language = None;
		self.guesses = None;
		self.completion = None;
		self.correction = None;
	}

	/// Active dictionary language reported by the platform.
	pub fn language(&self) -> Option<&str> {
		self.language.as_deref()
	}

	/// Whether a platform response is still outstanding.
	pub const fn awaiting(&self) -> bool {
		self.check_ticket.is_some()
			|| self.guesses_ticket.is_some()
			|| self.complete_ticket.is_some()
			|| self.correct_ticket.is_some()
	}

	/// Takes the latest replacement candidates.
	pub fn take_guesses(&mut self) -> Option<(Range<usize>, SmallVec<Str, 8>)> {
		self.guesses.take().map(|(_, range, items)| (range, items))
	}

	/// Resolved ghost suffix for the partial word at `range` of `text`.
	pub fn completion(&self, text: &str, range: &Range<usize>) -> Option<Str> {
		let completion = self.completion.as_ref()?;
		(completion.resolved && completion.range == *range && completion.text.as_str() == text)
			.then(|| completion.suffix.clone())
			.flatten()
	}

	/// Takes the latest confident correction: the word range and replacement.
	pub const fn take_correction(&mut self) -> Option<(Range<usize>, Str)> {
		self.correction.take()
	}

	#[cfg(test)]
	pub(crate) fn seed_completion(&mut self, text: &str, range: Range<usize>, suffix: &str) {
		self.completion = Some(WordCompletion {
			text: Str::new(text),
			range,
			suffix: Some(Str::new(suffix)),
			resolved: true,
		});
	}

	#[cfg(test)]
	pub(crate) fn seed_correction(&mut self, range: Range<usize>, replacement: &str) {
		self.correction = Some((range, Str::new(replacement)));
	}

	#[cfg(test)]
	pub(crate) fn seed_guesses(
		&mut self,
		text: &str,
		range: Range<usize>,
		items: impl IntoIterator<Item = &'static str>,
	) {
		self.guesses = Some((Str::new(text), range, items.into_iter().map(Str::new).collect()));
	}

	#[cfg(test)]
	pub(crate) fn seed_typos(&mut self, text: &str, ranges: impl IntoIterator<Item = Range<usize>>) {
		self.check_ticket = None;
		self.check_source = None;
		self.checked_text = Str::new(text);
		self.typos = ranges
			.into_iter()
			.map(|range| TypoRange { start: range.start, end: range.end })
			.collect();
		self.projected.clear();
	}
}

impl Default for SpellingAssist {
	fn default() -> Self {
		Self::new()
	}
}

fn worker(rx: Receiver<Request>, tx: Sender<Response>, pending: Arc<Mutex<PendingRequests>>) {
	while let Ok(mut request) = rx.recv() {
		loop {
			let response = match request {
				Request::Check { generation, ref source, ref masked } => Response::Checked {
					generation,
					text: source.clone(),
					result: platform::check(masked),
				},
				Request::Guesses { generation, ref text, ref range } => Response::Guesses {
					generation,
					text: text.clone(),
					range: range.clone(),
					items: platform::guesses(text, range.clone()),
				},
				Request::Complete { generation, ref text, ref range } => Response::Complete {
					generation,
					text: text.clone(),
					range: range.clone(),
					suffix: completion_suffix(
						&text[range.clone()],
						platform::completions(text, range.clone()),
					),
				},
				Request::Correct { generation, ref text, ref range } => {
					// An echo of the typed word is not a correction.
					let correction = platform::correction(text, range.clone()).filter(|correction| {
						!correction.is_empty() && correction.as_str() != &text[range.clone()]
					});
					Response::Correct {
						generation,
						text: text.clone(),
						range: range.clone(),
						correction,
					}
				},
			};
			let _ = tx.send(response);
			let Some(next) = pending.lock().take() else {
				break;
			};
			request = next;
		}
	}
}

/// First platform completion that extends `prefix` case-insensitively,
/// returned as the ghost-text suffix.
fn completion_suffix(prefix: &str, completions: impl IntoIterator<Item = Str>) -> Option<Str> {
	let lower_prefix = prefix.to_lowercase();
	completions.into_iter().find_map(|completion| {
		let head = completion.get(..prefix.len())?;
		(completion.len() > prefix.len() && head.to_lowercase() == lower_prefix)
			.then(|| completion.slice(prefix.len()..))
	})
}

fn mask_ranges(text: &str, ranges: &[Range<usize>]) -> String {
	let mut bytes = text.as_bytes().to_vec();
	for range in ranges {
		let start = range.start.min(bytes.len());
		let end = range.end.min(bytes.len());
		bytes[start..end].fill(b' ');
	}
	String::from_utf8(bytes).unwrap_or_else(|_| text.to_owned())
}

fn project_ranges(previous: &str, next: &str, ranges: &[TypoRange]) -> Vec<TypoRange> {
	if previous.is_empty() || ranges.is_empty() {
		return Vec::new();
	}
	let prefix = previous
		.bytes()
		.zip(next.bytes())
		.take_while(|(a, b)| a == b)
		.count();
	let suffix = previous[prefix..]
		.bytes()
		.rev()
		.zip(next[prefix..].bytes().rev())
		.take_while(|(a, b)| a == b)
		.count();
	if prefix + suffix + 1 < previous.len() {
		return Vec::new();
	}
	let old_end = previous.len().saturating_sub(suffix);
	let delta = next.len() as isize - previous.len() as isize;
	ranges
		.iter()
		.filter_map(|range| {
			let (start, end) = if range.end <= prefix {
				(range.start, range.end)
			} else if range.start >= old_end {
				(range.start.checked_add_signed(delta)?, range.end.checked_add_signed(delta)?)
			} else {
				(
					range.start.min(prefix),
					range
						.end
						.checked_add_signed(delta)?
						.max(next.len() - suffix),
				)
			};
			(start < end && end <= next.len()).then_some(TypoRange { start, end })
		})
		.collect()
}

#[cfg(target_os = "macos")]
mod platform {
	use std::sync::LazyLock;

	use objc2::rc::Retained;
	use objc2_app_kit::NSSpellChecker;
	use objc2_foundation::{NSRange, NSString, NSTextCheckingType};
	use smallvec::SmallVec;

	use super::{MAX_SUGGESTIONS, Range, SpellingResult, Str, TypoRange};
	static APP_KIT_LOADED: LazyLock<bool> = LazyLock::new(|| unsafe { NSApplicationLoad() });

	#[link(name = "AppKit", kind = "framework")]
	unsafe extern "C" {
		fn NSApplicationLoad() -> bool;
	}

	fn checker() -> Option<Retained<NSSpellChecker>> {
		(*APP_KIT_LOADED).then(|| {
			let checker = NSSpellChecker::sharedSpellChecker();
			checker.setAutomaticallyIdentifiesLanguages(true);
			checker
		})
	}

	/// Language macOS identifies for a word range, falling back to the shared
	/// checker's current language when detection is inconclusive.
	fn word_language(
		checker: &NSSpellChecker,
		text: &NSString,
		range: NSRange,
	) -> Retained<NSString> {
		checker
			.languageForWordRange_inString_orthography(range, text, None)
			.unwrap_or_else(|| checker.language())
	}

	pub fn check(text: &str) -> SpellingResult {
		let Some(checker) = checker() else {
			return SpellingResult::default();
		};
		let string = NSString::from_str(text);
		let full = NSRange { location: 0, length: string.length() };
		let results = unsafe {
			checker.checkString_range_types_options_inSpellDocumentWithTag_orthography_wordCount(
				&string,
				full,
				NSTextCheckingType::Spelling.bits(),
				None,
				0,
				None,
				std::ptr::null_mut(),
			)
		};
		let mut typos = Vec::new();
		for result in &results {
			if result.resultType() != NSTextCheckingType::Spelling {
				continue;
			}
			if let Some(range) = utf16_to_bytes(text, result.range()) {
				typos.push(range);
			}
		}
		typos.sort_unstable_by_key(|range| range.start);
		let mut prior_end = 0;
		typos.retain(|range| {
			if range.start < prior_end {
				return false;
			}
			prior_end = range.end;
			true
		});
		let language = checker
			.languageForWordRange_inString_orthography(full, &string, None)
			.map(|value| Str::new(value.to_string()));
		SpellingResult { typos, language }
	}

	pub fn guesses(text: &str, range: Range<usize>) -> SmallVec<Str, 8> {
		let Some(checker) = checker() else {
			return SmallVec::new();
		};
		let string = NSString::from_str(text);
		let Some(ns_range) = bytes_to_utf16(text, range) else {
			return SmallVec::new();
		};
		let language = word_language(&checker, &string, ns_range);
		checker
			.guessesForWordRange_inString_language_inSpellDocumentWithTag(
				ns_range,
				&string,
				Some(&*language),
				0,
			)
			.map(|values| {
				let mut items = SmallVec::new();
				for value in &values {
					let item = Str::new(value.to_string());
					if item.is_empty() || items.iter().any(|seen| seen == &item) {
						continue;
					}
					items.push(item);
					if items.len() == MAX_SUGGESTIONS {
						break;
					}
				}
				items
			})
			.unwrap_or_default()
	}

	pub fn completions(text: &str, range: Range<usize>) -> SmallVec<Str, 8> {
		let Some(checker) = checker() else {
			return SmallVec::new();
		};
		let string = NSString::from_str(text);
		let Some(ns_range) = bytes_to_utf16(text, range) else {
			return SmallVec::new();
		};
		let language = word_language(&checker, &string, ns_range);
		checker
			.completionsForPartialWordRange_inString_language_inSpellDocumentWithTag(
				ns_range,
				&string,
				Some(&*language),
				0,
			)
			.map(|values| {
				values
					.iter()
					.take(MAX_SUGGESTIONS)
					.map(|value| Str::new(value.to_string()))
					.collect()
			})
			.unwrap_or_default()
	}

	pub fn correction(text: &str, range: Range<usize>) -> Option<Str> {
		let checker = checker()?;
		let string = NSString::from_str(text);
		let ns_range = bytes_to_utf16(text, range)?;
		let language = word_language(&checker, &string, ns_range);
		checker
			.correctionForWordRange_inString_language_inSpellDocumentWithTag(
				ns_range, &string, &language, 0,
			)
			.map(|value| Str::new(value.to_string()))
	}

	fn utf16_to_bytes(text: &str, range: NSRange) -> Option<TypoRange> {
		let start = byte_at_utf16(text, range.location)?;
		let end = byte_at_utf16(text, range.location.checked_add(range.length)?)?;
		(start < end).then_some(TypoRange { start, end })
	}

	fn bytes_to_utf16(text: &str, range: Range<usize>) -> Option<NSRange> {
		if !text.is_char_boundary(range.start) || !text.is_char_boundary(range.end) {
			return None;
		}
		Some(NSRange {
			location: text[..range.start].encode_utf16().count(),
			length:   text[range].encode_utf16().count(),
		})
	}

	fn byte_at_utf16(text: &str, wanted: usize) -> Option<usize> {
		let mut units = 0;
		for (byte, character) in text.char_indices() {
			if units == wanted {
				return Some(byte);
			}
			units += character.len_utf16();
			if units > wanted {
				return None;
			}
		}
		(units == wanted).then_some(text.len())
	}
}

#[cfg(not(target_os = "macos"))]
mod platform {
	use smallvec::SmallVec;

	use super::{Range, SpellingResult, Str};
	pub fn check(_text: &str) -> SpellingResult {
		SpellingResult::default()
	}
	pub fn guesses(_text: &str, _range: Range<usize>) -> SmallVec<Str, 8> {
		SmallVec::new()
	}
	pub fn completions(_text: &str, _range: Range<usize>) -> SmallVec<Str, 8> {
		SmallVec::new()
	}
	pub fn correction(_text: &str, _range: Range<usize>) -> Option<Str> {
		None
	}
}

#[cfg(test)]
mod tests {
	use smallvec::SmallVec;

	use super::{SpellingAssist, Str, TypoRange, completion_suffix, mask_ranges, project_ranges};

	#[test]
	fn masking_preserves_offsets() {
		assert_eq!(mask_ranges("say `code` now", &[4..10]), "say        now");
	}

	#[test]
	fn typo_ranges_project_across_tail_edits() {
		let ranges = [TypoRange { start: 0, end: 8 }];
		assert_eq!(project_ranges("recieved", "recieved!", &ranges), ranges);
	}

	#[test]
	fn repeated_paints_coalesce_one_check_and_restoring_checked_text_invalidates_it() {
		let mut assist = SpellingAssist::new();
		assist.seed_typos("eac", [0..3]);
		assist.check("each", &[]);
		let ticket = assist.check_ticket;
		assert!(ticket.is_some());
		assist.check("each", &[]);
		assert_eq!(assist.check_ticket, ticket, "same source must not enqueue again");
		assist.check("eac", &[]);
		assert_eq!(assist.check_ticket, None);
		assert_eq!(assist.check_source, None);
		assert_eq!(assist.typo_ranges(), &[TypoRange { start: 0, end: 3 }]);
	}

	#[test]
	fn completion_suffix_extends_prefix_case_insensitively() {
		let completions: SmallVec<Str, 8> = ["par", "Paris", "parliament"]
			.iter()
			.map(Str::new)
			.collect();
		// "par" is not longer than the prefix; "Paris" matches ignoring case.
		assert_eq!(completion_suffix("par", completions).as_deref(), Some("is"));
	}

	#[test]
	fn completion_suffix_skips_non_extensions() {
		let completions: SmallVec<Str, 8> = ["félin"].iter().map(Str::new).collect();
		assert_eq!(completion_suffix("fé", completions.clone()).as_deref(), Some("lin"));
		// A prefix length that splits a candidate's multi-byte character must
		// skip the candidate rather than panic.
		assert_eq!(completion_suffix("fe", completions.clone()), None);
		assert_eq!(completion_suffix("cat", completions), None);
		assert_eq!(completion_suffix("word", SmallVec::<Str, 8>::new()), None);
	}
}
