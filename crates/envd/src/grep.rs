//! Binding-free regex search over in-memory bytes and workspace files.
//!
//! Matching is implemented with ripgrep's regex engine and falls back to PCRE2
//! for look-around, backreferences, and other constructs unsupported by Rust's
//! regex automata. Filesystem traversal and parallel worker ownership remain in
//! [`omp_walker`].

use std::{
	borrow::Cow,
	convert, env, error,
	fmt::{self, Display},
	fs,
	fs::File,
	io::{self, Read},
	iter,
	path::{Path, PathBuf},
	str,
	sync::{
		LazyLock,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, Instant},
};

use bytecount::count;
use grep_matcher::Matcher;
use grep_pcre2::{RegexMatcher as PcreMatcher, RegexMatcherBuilder as PcreMatcherBuilder};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use omp_core::Str;
use omp_walker::{
	CompiledWalkGlob, DirectoryErrorMode, FileCandidate, FollowLinks, SizeHintPolicy, WalkDetail,
	WalkFilter, WalkOrder, WalkRequest,
};
use smallvec::SmallVec;
use thiserror::Error;

/// Maximum number of bytes searched from any one file.
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

const FILE_CLASSIFICATION_READ_BYTES: u64 = MAX_FILE_BYTES + 1;

/// Whether PCRE2 JIT is enabled for fallback matchers.
///
/// `OMP_PCRE2_JIT=0` and `OMP_PCRE2_JIT=false` disable JIT. Any other non-empty
/// value enables it. When unset, JIT is enabled except on macOS, where PCRE2's
/// executable allocator is not reliable in every host process.
static PCRE2_JIT_ENABLED: LazyLock<bool> = LazyLock::new(|| match env::var("OMP_PCRE2_JIT") {
	Ok(value) if !value.is_empty() => value != "0" && !value.eq_ignore_ascii_case("false"),
	_ => !cfg!(target_os = "macos"),
});

/// Output mode used by [`search`] and [`grep`].
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum GrepOutputMode {
	/// Return matched lines and requested context.
	#[default]
	Content,
	/// Return one result entry per matching file and count every match.
	Count,
	/// Return one result entry per matching file.
	FilesWithMatches,
}

/// Options shared by in-memory and filesystem searches.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GrepOptions {
	/// Regex pattern to search for.
	pub pattern:            Str,
	/// File or directory to search, or the display path for [`search`].
	pub path:               Str,
	/// Optional recursive glob filter for filesystem searches.
	pub glob:               Option<Str>,
	/// Match without regard to case.
	pub ignore_case:        bool,
	/// Enable multiline matching; multiline-looking patterns enable it as well.
	pub multiline:          bool,
	/// Include dot-prefixed files and directories.
	pub hidden:             bool,
	/// Respect ignore files and repository excludes.
	pub gitignore:          bool,
	/// Maximum number of returned matches across all files.
	pub max_count:          Option<u32>,
	/// Maximum number of returned content matches from each file.
	pub max_count_per_file: Option<u32>,
	/// Number of context lines to retain before each match.
	pub context_before:     u32,
	/// Number of context lines to retain after each match.
	pub context_after:      u32,
	/// Maximum line length in UTF-8 bytes, including a three-byte ellipsis.
	pub max_columns:        Option<u32>,
	/// Shape of returned match entries.
	pub mode:               GrepOutputMode,
	/// Deadline in milliseconds from the start of the operation.
	pub timeout_ms:         Option<u32>,
}

impl Default for GrepOptions {
	fn default() -> Self {
		Self {
			pattern:            Str::new(""),
			path:               Str::new("."),
			glob:               None,
			ignore_case:        false,
			multiline:          false,
			hidden:             true,
			gitignore:          true,
			max_count:          None,
			max_count_per_file: None,
			context_before:     0,
			context_after:      0,
			max_columns:        None,
			mode:               GrepOutputMode::Content,
			timeout_ms:         Some(30_000),
		}
	}
}

/// One source line retained around a match.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextLine {
	/// One-indexed line number in the source.
	pub line_number: u32,
	/// Source text with its line ending removed.
	pub line:        Str,
}

/// One content match or one file marker in a non-content output mode.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GrepMatch {
	/// Search-root-relative path, or the caller-provided path for [`search`].
	pub path:           Str,
	/// One-indexed source line, or zero for non-content output modes.
	pub line_number:    u32,
	/// Matched line text, or an empty string for non-content output modes.
	pub line:           Str,
	/// Whether `line` was shortened to `GrepOptions::max_columns`.
	pub truncated:      bool,
	/// Context retained before the match.
	pub context_before: SmallVec<ContextLine, 8>,
	/// Context retained after the match.
	pub context_after:  SmallVec<ContextLine, 8>,
}

/// Aggregated result of an in-memory or filesystem search.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GrepResult {
	/// Returned content matches or matching-file markers.
	pub matches:            Vec<GrepMatch>,
	/// Matches observed across searched files before the global output cap.
	pub total_matches:      u32,
	/// Number of searched files containing at least one match.
	pub files_with_matches: u32,
	/// Number of files successfully read and searched.
	pub files_searched:     u32,
	/// Whether a global or per-file output cap omitted matches.
	pub limit_reached:      bool,
	/// Oversized files whose leading window could not be read.
	pub skipped_oversized:  u32,
}

/// Failure from matcher compilation, traversal, or searching.
#[derive(Debug, Error)]
pub enum GrepError {
	/// Both the Rust regex engine and PCRE2 rejected the pattern.
	#[error("invalid regex: {regex}; PCRE2 fallback: {pcre2}")]
	InvalidRegex {
		/// Rust regex compilation diagnostic.
		regex: Str,
		/// PCRE2 compilation diagnostic.
		pcre2: Str,
	},
	/// The filesystem target does not exist.
	#[error("path not found: {path}")]
	PathNotFound {
		/// Caller-provided path.
		path: Str,
	},
	/// A filename glob was invalid.
	#[error("invalid glob pattern: {message}")]
	InvalidGlob {
		/// Glob compiler diagnostic.
		message: Str,
	},
	/// Workspace traversal failed.
	#[error("filesystem traversal failed: {message}")]
	Walk {
		/// Walker diagnostic.
		message: Str,
	},
	/// A readable input could not be searched.
	#[error("search failed: {message}")]
	Search {
		/// Searcher diagnostic.
		message: Str,
	},
	/// The configured operation deadline elapsed.
	#[error("grep timed out after {timeout_ms}ms")]
	Timeout {
		/// Configured timeout.
		timeout_ms: u32,
	},
	/// The caller cancelled the search.
	#[error("grep was cancelled")]
	Cancelled,
}
/// Regex-engine options used when compiling a [`CompiledGrep`].
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RegexOptions {
	/// Match without regard to case.
	pub ignore_case: bool,
	/// Permit matches to span line boundaries.
	pub multiline:   bool,
}

/// Per-buffer controls for [`CompiledGrep::search_slice`].
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StreamOptions {
	/// Maximum number of records emitted from this buffer.
	pub max_count:      Option<u64>,
	/// Number of complete source lines exposed before a match.
	pub context_before: u32,
	/// Number of complete source lines exposed after a match.
	pub context_after:  u32,
}

/// Backpressure decision returned by a [`GrepSink`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GrepControl {
	/// Continue searching.
	Continue,
	/// Stop successfully after the current callback.
	Stop,
	/// Stop because the caller cancelled the operation.
	Cancel,
}

/// Why a streaming search ended.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum GrepStreamStatus {
	/// The complete requested input was searched.
	#[default]
	Complete,
	/// The sink requested an early successful stop.
	Stopped,
	/// The sink reported cancellation.
	Cancelled,
	/// A configured match limit stopped the search.
	LimitReached,
}

/// Statistics from a streaming search.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct GrepStreamSummary {
	/// Number of match records delivered to the sink.
	pub matches:            u64,
	/// Number of searched files containing at least one match.
	pub files_with_matches: u64,
	/// Number of files successfully read and searched.
	pub files_searched:     u64,
	/// Oversized files whose bounded leading window could not be read.
	pub skipped_oversized:  u64,
	/// Why the search ended.
	pub status:             GrepStreamStatus,
}

/// One borrowed exact regex match.
///
/// Every byte slice borrows the searched input and remains valid only for the
/// duration of the sink callback.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GrepMatchRef<'a> {
	/// Caller-provided display path.
	pub path:                 &'a str,
	/// One-based line containing the first byte of the match.
	pub line_number:          u64,
	/// Absolute byte offset of the first byte of the match.
	pub byte_offset:          u64,
	/// Absolute byte offset immediately after the match.
	pub match_end:            u64,
	/// Absolute byte offset of the containing line.
	pub line_byte_offset:     u64,
	/// Complete containing line, excluding its line-feed delimiter.
	pub line_bytes:           &'a [u8],
	/// Exact bytes selected by the regex.
	pub matched_bytes:        &'a [u8],
	/// Contiguous complete lines preceding the containing line.
	pub context_before_bytes: &'a [u8],
	/// One-based line number of the first line in `context_before_bytes`.
	pub context_before_line:  u64,
	/// Contiguous complete lines following all lines touched by the match.
	pub context_after_bytes:  &'a [u8],
	/// One-based line number of the first line in `context_after_bytes`.
	pub context_after_line:   u64,
}

/// Synchronous, backpressured receiver for streaming grep records.
///
/// [`GrepSink::control`] is called between records and is the cancellation
/// heartbeat. Returning from [`GrepSink::matched`] provides backpressure
/// without allocating a channel or erased future.
pub trait GrepSink {
	/// Error raised by this sink.
	type Error;

	/// Check for cancellation or an out-of-band early stop.
	fn control(&mut self) -> Result<GrepControl, Self::Error> {
		Ok(GrepControl::Continue)
	}

	/// Consume one borrowed match.
	fn matched(&mut self, matched: GrepMatchRef<'_>) -> Result<GrepControl, Self::Error>;
}

/// Error from a compiled streaming search.
#[derive(Debug)]
pub enum GrepStreamError<E> {
	/// Matcher, traversal, read, or deadline failure.
	Grep(GrepError),
	/// Failure returned by the caller's sink.
	Sink(E),
}

impl<E: Display> Display for GrepStreamError<E> {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Grep(error) => error.fmt(formatter),
			Self::Sink(error) => write!(formatter, "grep sink failed: {error}"),
		}
	}
}

impl<E> error::Error for GrepStreamError<E>
where
	E: error::Error + 'static,
{
	fn source(&self) -> Option<&(dyn error::Error + 'static)> {
		match self {
			Self::Grep(error) => Some(error),
			Self::Sink(error) => Some(error),
		}
	}
}

/// A compiled ripgrep-regex matcher with automatic PCRE2 fallback.
///
/// Compilation is performed once and the resulting matcher can be shared
/// across file workers.
pub struct CompiledGrep {
	matcher: CompiledMatcher,
}

impl CompiledGrep {
	/// Compile `pattern`, falling back to PCRE2 when Rust regex rejects it.
	pub fn new(pattern: &str, options: RegexOptions) -> Result<Self, GrepError> {
		let multiline = infer_multiline(pattern, options.multiline);
		let matcher = build_matcher(pattern, options.ignore_case, multiline)?;
		Ok(Self { matcher })
	}

	/// Emit exact matches from one borrowed byte slice in offset order.
	pub fn search_slice<S: GrepSink>(
		&self,
		path: &str,
		content: &[u8],
		options: StreamOptions,
		sink: &mut S,
	) -> Result<GrepStreamSummary, GrepStreamError<S::Error>> {
		stream_search_slice(&self.matcher, path, content, options, sink)
	}

	/// Read and search one file with the crate's bounded full-read/prefix
	/// policy.
	///
	/// Files larger than [`MAX_FILE_BYTES`] are searched through the same
	/// bounded leading window used by [`grep`]. Unreadable and binary files emit
	/// no records.
	pub fn search_file<S: GrepSink>(
		&self,
		path: &Path,
		display_path: &str,
		options: StreamOptions,
		sink: &mut S,
	) -> Result<GrepStreamSummary, GrepStreamError<S::Error>> {
		match sink.control().map_err(GrepStreamError::Sink)? {
			GrepControl::Continue => {},
			GrepControl::Stop => {
				return Ok(GrepStreamSummary {
					status: GrepStreamStatus::Stopped,
					..GrepStreamSummary::default()
				});
			},
			GrepControl::Cancel => {
				return Ok(GrepStreamSummary {
					status: GrepStreamStatus::Cancelled,
					..GrepStreamSummary::default()
				});
			},
		}
		let size_hint = fs::metadata(path).ok().map(|metadata| metadata.len());
		let mut buffer = Vec::new();
		let mut skipped_oversized = 0;
		let mut searched = false;
		let read = read_file_bytes_with_size(path, size_hint, &mut buffer);
		match read {
			Ok(ReadFile::Read) => searched = true,
			Ok(ReadFile::Oversized) => {
				match sink.control().map_err(GrepStreamError::Sink)? {
					GrepControl::Continue => {},
					GrepControl::Stop => {
						return Ok(GrepStreamSummary {
							status: GrepStreamStatus::Stopped,
							..GrepStreamSummary::default()
						});
					},
					GrepControl::Cancel => {
						return Ok(GrepStreamSummary {
							status: GrepStreamStatus::Cancelled,
							..GrepStreamSummary::default()
						});
					},
				}
				match read_file_prefix(path, &mut buffer) {
					Ok(ReadFile::Read) => searched = true,
					_ => skipped_oversized = 1,
				}
			},
			Ok(ReadFile::Skipped) | Err(_) => {},
		}
		if !searched {
			return Ok(GrepStreamSummary { skipped_oversized, ..GrepStreamSummary::default() });
		}
		let mut summary = self.search_slice(display_path, &buffer, options, sink)?;
		summary.files_searched = 1;
		summary.files_with_matches = u64::from(summary.matches != 0);
		summary.skipped_oversized = skipped_oversized;
		Ok(summary)
	}
}

fn stream_search_slice<S: GrepSink>(
	matcher: &CompiledMatcher,
	path: &str,
	content: &[u8],
	options: StreamOptions,
	sink: &mut S,
) -> Result<GrepStreamSummary, GrepStreamError<S::Error>> {
	if options.max_count == Some(0) {
		return Ok(GrepStreamSummary {
			status: GrepStreamStatus::LimitReached,
			..GrepStreamSummary::default()
		});
	}
	if content.contains(&0) {
		return Ok(GrepStreamSummary::default());
	}

	let mut summary = GrepStreamSummary::default();
	let mut sink_error = None;
	let mut status = GrepStreamStatus::Complete;
	let mut counted_through = 0usize;
	let mut line_number = 1u64;
	let result = matcher.find_iter(content, |matched| {
		match sink.control() {
			Ok(GrepControl::Continue) => {},
			Ok(GrepControl::Stop) => {
				status = GrepStreamStatus::Stopped;
				return false;
			},
			Ok(GrepControl::Cancel) => {
				status = GrepStreamStatus::Cancelled;
				return false;
			},
			Err(error) => {
				sink_error = Some(error);
				return false;
			},
		}

		let start = matched.start();
		let end = matched.end();
		let line_start = content[..start]
			.iter()
			.rposition(|byte| *byte == b'\n')
			.map_or(0, |newline| newline + 1);
		while counted_through < line_start {
			let Some(relative) = content[counted_through..line_start]
				.iter()
				.position(|byte| *byte == b'\n')
			else {
				break;
			};
			counted_through += relative + 1;
			line_number = line_number.saturating_add(1);
		}
		let line_end = content[start..]
			.iter()
			.position(|byte| *byte == b'\n')
			.map_or(content.len(), |relative| start + relative);
		let context_before_start = context_before_start(content, line_start, options.context_before);
		let last_match_byte = end.saturating_sub(1).max(start).min(content.len());
		let touched_line_end = content[last_match_byte..]
			.iter()
			.position(|byte| *byte == b'\n')
			.map_or(content.len(), |relative| last_match_byte + relative);
		let context_after_start = if touched_line_end < content.len() {
			touched_line_end + 1
		} else {
			content.len()
		};
		let context_after_end =
			context_after_end(content, context_after_start, options.context_after);
		let before_lines = u64::try_from(count(&content[context_before_start..line_start], b'\n'))
			.expect("line count fits in u64");
		let after_line = line_number.saturating_add(
			u64::try_from(count(&content[line_start..context_after_start], b'\n'))
				.expect("line count fits in u64"),
		);
		let record = GrepMatchRef {
			path,
			line_number,
			byte_offset: start as u64,
			match_end: end as u64,
			line_byte_offset: line_start as u64,
			line_bytes: &content[line_start..line_end],
			matched_bytes: &content[start..end],
			context_before_bytes: &content[context_before_start..line_start],
			context_before_line: line_number.saturating_sub(before_lines),
			context_after_bytes: &content[context_after_start..context_after_end],
			context_after_line: after_line,
		};
		summary.matches = summary.matches.saturating_add(1);
		match sink.matched(record) {
			Ok(GrepControl::Continue) => {},
			Ok(GrepControl::Stop) => {
				status = GrepStreamStatus::Stopped;
				return false;
			},
			Ok(GrepControl::Cancel) => {
				status = GrepStreamStatus::Cancelled;
				return false;
			},
			Err(error) => {
				sink_error = Some(error);
				return false;
			},
		}
		if options
			.max_count
			.is_some_and(|maximum| summary.matches >= maximum)
		{
			status = GrepStreamStatus::LimitReached;
			return false;
		}
		true
	});
	if let Some(error) = sink_error {
		return Err(GrepStreamError::Sink(error));
	}
	result.map_err(|error| {
		GrepStreamError::Grep(GrepError::Search { message: Str::from(error.to_string()) })
	})?;
	summary.status = status;
	Ok(summary)
}

fn context_before_start(content: &[u8], line_start: usize, count: u32) -> usize {
	let mut start = line_start;
	for _ in 0..count {
		if start == 0 {
			break;
		}
		let preceding_end = start - 1;
		start = content[..preceding_end]
			.iter()
			.rposition(|byte| *byte == b'\n')
			.map_or(0, |newline| newline + 1);
	}
	start
}

fn context_after_end(content: &[u8], start: usize, count: u32) -> usize {
	let mut end = start;
	for _ in 0..count {
		if end >= content.len() {
			break;
		}
		end = content[end..]
			.iter()
			.position(|byte| *byte == b'\n')
			.map_or(content.len(), |relative| end + relative + 1);
	}
	end
}

#[derive(Clone, Copy)]
struct Deadline {
	started:    Instant,
	timeout_ms: Option<u32>,
}

impl Deadline {
	fn new(timeout_ms: Option<u32>) -> Self {
		Self { started: Instant::now(), timeout_ms }
	}

	fn check(self) -> Result<(), GrepError> {
		let Some(timeout_ms) = self.timeout_ms else {
			return Ok(());
		};
		if self.started.elapsed() >= Duration::from_millis(u64::from(timeout_ms)) {
			return Err(GrepError::Timeout { timeout_ms });
		}
		Ok(())
	}

	fn expired(self) -> bool {
		self.timeout_ms.is_some_and(|timeout_ms| {
			self.started.elapsed() >= Duration::from_millis(u64::from(timeout_ms))
		})
	}
}

enum ReadFile {
	Read,
	Oversized,
	Skipped,
}

enum CompiledMatcher {
	Rust(RegexMatcher),
	Pcre2(PcreMatcher),
}

#[derive(Debug)]
enum CompiledMatcherError {
	Rust(grep_matcher::NoError),
	Pcre2(grep_pcre2::Error),
}

impl Display for CompiledMatcherError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Rust(error) => error.fmt(formatter),
			Self::Pcre2(error) => error.fmt(formatter),
		}
	}
}

impl Matcher for CompiledMatcher {
	type Captures = grep_matcher::NoCaptures;
	type Error = CompiledMatcherError;

	fn find_at(
		&self,
		haystack: &[u8],
		at: usize,
	) -> Result<Option<grep_matcher::Match>, Self::Error> {
		match self {
			Self::Rust(matcher) => matcher
				.find_at(haystack, at)
				.map_err(CompiledMatcherError::Rust),
			Self::Pcre2(matcher) => matcher
				.find_at(haystack, at)
				.map_err(CompiledMatcherError::Pcre2),
		}
	}

	fn new_captures(&self) -> Result<Self::Captures, Self::Error> {
		Ok(grep_matcher::NoCaptures::new())
	}
}

/// Search an in-memory byte slice.
///
/// The `path` option is copied into returned matches as their display path.
#[tracing::instrument(
	level = "debug",
	name = "grep_search_memory",
	skip_all,
	fields(
		root = %options.path,
		pattern_bytes = options.pattern.len(),
		multiline = options.multiline,
		ignore_case = options.ignore_case,
		byte_count = content.len(),
		match_count = tracing::field::Empty
	)
)]
pub fn search(content: &[u8], options: &GrepOptions) -> Result<GrepResult, GrepError> {
	search_inner(content, options, None)
}

/// Search in-memory bytes while observing a caller-owned cancellation flag.
pub fn search_with_cancellation(
	content: &[u8],
	options: &GrepOptions,
	cancelled: &AtomicBool,
) -> Result<GrepResult, GrepError> {
	search_inner(content, options, Some(cancelled))
}

fn search_inner(
	content: &[u8],
	options: &GrepOptions,
	cancelled: Option<&AtomicBool>,
) -> Result<GrepResult, GrepError> {
	check_cancelled(cancelled)?;
	let deadline = Deadline::new(options.timeout_ms);
	deadline.check()?;
	let matcher = CompiledGrep::new(options.pattern.as_str(), RegexOptions {
		ignore_case: options.ignore_case,
		multiline:   options.multiline,
	})?;
	let mut collector = AggregateGrepCollector::new(options);
	let mut controlled = CancellationSink { sink: &mut collector, cancelled };
	let mut summary = match matcher.search_slice(
		options.path.as_str(),
		content,
		StreamOptions {
			max_count:      None,
			context_before: options.context_before,
			context_after:  options.context_after,
		},
		&mut controlled,
	) {
		Ok(summary) => summary,
		Err(GrepStreamError::Grep(error)) => return Err(error),
		Err(GrepStreamError::Sink(error)) => match error {},
	};
	check_cancelled(cancelled)?;
	deadline.check()?;
	if summary.status == GrepStreamStatus::Cancelled {
		return Err(GrepError::Cancelled);
	}
	summary.files_searched = 1;
	let result = collector.finish(summary);
	tracing::Span::current().record("match_count", result.total_matches);
	Ok(result)
}

/// Stream exact matches from a file or directory in deterministic path and
/// byte-offset order.
///
/// Candidate discovery may run in parallel inside [`WalkRequest`], while file
/// delivery follows its explicit [`WalkOrder::Path`] sequence. The function
/// never collects match records or performs a terminal match sort.
#[tracing::instrument(
	level = "debug",
	name = "grep_search",
	skip_all,
	fields(
		root = %options.path,
		pattern_bytes = options.pattern.len(),
		multiline = options.multiline,
		ignore_case = options.ignore_case,
		candidate_count = tracing::field::Empty,
		files_searched = tracing::field::Empty,
		match_count = tracing::field::Empty
	)
)]
pub fn grep_stream<S: GrepSink>(
	options: &GrepOptions,
	sink: &mut S,
) -> Result<GrepStreamSummary, GrepStreamError<S::Error>> {
	grep_stream_inner(options, sink, None)
}

fn grep_stream_inner<S: GrepSink>(
	options: &GrepOptions,
	sink: &mut S,
	cancelled: Option<&AtomicBool>,
) -> Result<GrepStreamSummary, GrepStreamError<S::Error>> {
	let deadline = Deadline::new(options.timeout_ms);
	deadline.check().map_err(GrepStreamError::Grep)?;
	let target = resolve_search_path(options.path.as_str()).map_err(GrepStreamError::Grep)?;
	let metadata = fs::metadata(&target)
		.map_err(|_| GrepStreamError::Grep(GrepError::PathNotFound { path: options.path.clone() }))?;
	let matcher = CompiledGrep::new(options.pattern.as_str(), RegexOptions {
		ignore_case: options.ignore_case,
		multiline:   options.multiline,
	})
	.map_err(GrepStreamError::Grep)?;
	if !metadata.is_file() && !metadata.is_dir() {
		tracing::Span::current().record("candidate_count", 0);
		let summary = GrepStreamSummary::default();
		record_stream_summary(&summary);
		return Ok(summary);
	}

	let mut summary = GrepStreamSummary::default();
	let candidates = if metadata.is_file() {
		vec![FileCandidate {
			path:     target,
			relative: options.path.as_str().to_owned(),
			mtime:    None,
			size:     Some(metadata.len() as f64),
		}]
	} else {
		build_walk_request(&target, options)
			.map_err(GrepStreamError::Grep)?
			.collect_file_candidates_with_heartbeat(|| {
				check_cancelled(cancelled)?;
				deadline.check()
			})
			.map_err(|error| {
				GrepStreamError::Grep(if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
					GrepError::Cancelled
				} else if deadline.expired() {
					GrepError::Timeout { timeout_ms: options.timeout_ms.unwrap_or(0) }
				} else {
					GrepError::Walk { message: Str::from(error.to_string()) }
				})
			})?
	};
	tracing::Span::current().record("candidate_count", candidates.len());
	let mut saw_limit = false;
	for candidate in &candidates {
		check_cancelled(cancelled).map_err(GrepStreamError::Grep)?;
		deadline.check().map_err(GrepStreamError::Grep)?;
		let remaining = options
			.max_count
			.map(u64::from)
			.map(|maximum| maximum.saturating_sub(summary.matches));
		if remaining == Some(0) {
			summary.status = GrepStreamStatus::LimitReached;
			record_stream_summary(&summary);
			return Ok(summary);
		}
		let mode_limit = if options.mode == GrepOutputMode::FilesWithMatches {
			Some(1)
		} else {
			options.max_count_per_file.map(u64::from)
		};
		let max_count = match (remaining, mode_limit) {
			(Some(global), Some(per_file)) => Some(global.min(per_file)),
			(global, per_file) => global.or(per_file),
		};
		let mut controlled = CancellationSink { sink: &mut *sink, cancelled };
		let file = matcher.search_file(
			&candidate.path,
			&candidate.relative,
			StreamOptions {
				max_count,
				context_before: options.context_before,
				context_after: options.context_after,
			},
			&mut controlled,
		)?;
		summary.matches = summary.matches.saturating_add(file.matches);
		summary.files_searched = summary.files_searched.saturating_add(file.files_searched);
		summary.files_with_matches = summary
			.files_with_matches
			.saturating_add(file.files_with_matches);
		summary.skipped_oversized = summary
			.skipped_oversized
			.saturating_add(file.skipped_oversized);
		match file.status {
			GrepStreamStatus::Stopped | GrepStreamStatus::Cancelled => {
				summary.status = file.status;
				record_stream_summary(&summary);
				return Ok(summary);
			},
			GrepStreamStatus::LimitReached => saw_limit = true,
			GrepStreamStatus::Complete => {},
		}
		if options
			.max_count
			.is_some_and(|maximum| summary.matches >= u64::from(maximum))
		{
			summary.status = GrepStreamStatus::LimitReached;
			record_stream_summary(&summary);
			return Ok(summary);
		}
	}
	check_cancelled(cancelled).map_err(GrepStreamError::Grep)?;
	deadline.check().map_err(GrepStreamError::Grep)?;
	summary.status = if saw_limit {
		GrepStreamStatus::LimitReached
	} else {
		GrepStreamStatus::Complete
	};
	record_stream_summary(&summary);
	Ok(summary)
}

fn check_cancelled(cancelled: Option<&AtomicBool>) -> Result<(), GrepError> {
	if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
		Err(GrepError::Cancelled)
	} else {
		Ok(())
	}
}

struct CancellationSink<'a, S> {
	sink:      &'a mut S,
	cancelled: Option<&'a AtomicBool>,
}

impl<S: GrepSink> GrepSink for CancellationSink<'_, S> {
	type Error = S::Error;

	fn control(&mut self) -> Result<GrepControl, Self::Error> {
		if self
			.cancelled
			.is_some_and(|flag| flag.load(Ordering::Relaxed))
		{
			Ok(GrepControl::Cancel)
		} else {
			self.sink.control()
		}
	}

	fn matched(&mut self, matched: GrepMatchRef<'_>) -> Result<GrepControl, Self::Error> {
		if self
			.cancelled
			.is_some_and(|flag| flag.load(Ordering::Relaxed))
		{
			Ok(GrepControl::Cancel)
		} else {
			self.sink.matched(matched)
		}
	}
}

fn record_stream_summary(summary: &GrepStreamSummary) {
	let span = tracing::Span::current();
	span.record("files_searched", summary.files_searched);
	span.record("match_count", summary.matches);
}

/// Search a file or directory synchronously and collect the streaming records.
pub fn grep(options: &GrepOptions) -> Result<GrepResult, GrepError> {
	grep_inner(options, None)
}

/// Search while observing a caller-owned cancellation flag.
///
/// The flag is checked during candidate discovery, before every file, and
/// between match records. Dropping an asynchronous owner can therefore stop
/// the blocking traversal instead of merely abandoning its join handle.
pub fn grep_with_cancellation(
	options: &GrepOptions,
	cancelled: &AtomicBool,
) -> Result<GrepResult, GrepError> {
	grep_inner(options, Some(cancelled))
}

fn grep_inner(
	options: &GrepOptions,
	cancelled: Option<&AtomicBool>,
) -> Result<GrepResult, GrepError> {
	let mut collector = AggregateGrepCollector::new(options);
	let mut streaming_options = options.clone();
	streaming_options.max_count = None;
	streaming_options.max_count_per_file = None;
	let summary = match grep_stream_inner(&streaming_options, &mut collector, cancelled) {
		Ok(summary) => summary,
		Err(GrepStreamError::Grep(error)) => return Err(error),
		Err(GrepStreamError::Sink(error)) => match error {},
	};
	if summary.status == GrepStreamStatus::Cancelled {
		return Err(GrepError::Cancelled);
	}
	Ok(collector.finish(summary))
}

fn infer_multiline(pattern: &str, requested: bool) -> bool {
	requested || pattern.contains('\n') || pattern.contains("\\n")
}

fn resolve_search_path(path: &str) -> Result<PathBuf, GrepError> {
	let path = PathBuf::from(path);
	if path.is_absolute() {
		return Ok(path);
	}
	env::current_dir()
		.map(|cwd| cwd.join(path))
		.map_err(|error| GrepError::Walk { message: Str::from(error.to_string()) })
}

fn build_walk_request(target: &Path, options: &GrepOptions) -> Result<WalkRequest, GrepError> {
	let mut filter = WalkFilter::files_only();
	if let Some(glob) = options
		.glob
		.as_ref()
		.map(Str::as_str)
		.map(str::trim)
		.filter(|glob| !glob.is_empty())
	{
		let pattern = normalize_recursive_glob(glob);
		let compiled = CompiledWalkGlob::new([pattern])
			.map_err(|error| GrepError::InvalidGlob { message: Str::from(error.to_string()) })?;
		filter = filter.glob(compiled);
	}
	let mentions_node_modules = options
		.glob
		.as_ref()
		.is_some_and(|glob| glob.as_str().contains("node_modules"));
	Ok(WalkRequest::new(target)
		.hidden(options.hidden)
		.gitignore(options.gitignore)
		.skip_git(true)
		.skip_node_modules(!mentions_node_modules)
		.follow_links(FollowLinks::Never)
		.detail(WalkDetail::Minimal)
		.size_hints(SizeHintPolicy::Always)
		.order(WalkOrder::Path)
		.emit_root(false)
		.depth(1, usize::MAX)
		.directory_errors(DirectoryErrorMode::SkipSkippable)
		.cache(false)
		.filter(filter))
}

fn normalize_recursive_glob(glob: &str) -> String {
	let normalized = glob.replace('\\', "/");
	let mut pattern = if normalized.contains('/')
		|| normalized.starts_with("**")
		|| is_exact_brace_union(&normalized)
	{
		normalized
	} else {
		format!("**/{normalized}")
	};
	let opens = pattern.bytes().filter(|byte| *byte == b'{').count();
	let closes = pattern.bytes().filter(|byte| *byte == b'}').count();
	if opens > closes {
		pattern.extend(iter::repeat_n('}', opens - closes));
	}
	pattern
}

fn is_exact_brace_union(pattern: &str) -> bool {
	if !(pattern.starts_with('{') && pattern.ends_with('}')) {
		return false;
	}
	let inner = &pattern[1..pattern.len() - 1];
	!inner.is_empty()
		&& !inner
			.chars()
			.any(|character| matches!(character, '*' | '?' | '[' | ']' | '{' | '}'))
}

fn build_regex_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> Result<RegexMatcher, grep_regex::Error> {
	let build = |line_terminated| {
		let mut builder = RegexMatcherBuilder::new();
		builder.case_insensitive(ignore_case).multi_line(multiline);
		if line_terminated {
			builder.line_terminator(Some(b'\n'));
		}
		builder.build(pattern)
	};
	if !multiline && let Ok(matcher) = build(true) {
		return Ok(matcher);
	}
	build(false)
}

fn build_pcre_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> Result<PcreMatcher, grep_pcre2::Error> {
	let mut builder = PcreMatcherBuilder::new();
	builder
		.caseless(ignore_case)
		.multi_line(multiline)
		.utf(true)
		.ucp(true)
		.jit_if_available(*PCRE2_JIT_ENABLED);
	builder.build(pattern)
}

/// Quotes literal parentheses after both regex engines report invalid group
/// syntax, while preserving already escaped parentheses and all other regex
/// operators.
fn escape_unescaped_parentheses(pattern: &str) -> Cow<'_, str> {
	let bytes = pattern.as_bytes();
	if !bytes.contains(&b'(') && !bytes.contains(&b')') {
		return Cow::Borrowed(pattern);
	}

	let mut escaped = String::with_capacity(pattern.len() + 4);
	let mut modified = false;
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'\\' && index + 1 < bytes.len() {
			escaped.push('\\');
			index += 1;
			let character = pattern[index..].chars().next().expect("non-empty suffix");
			escaped.push(character);
			index += character.len_utf8();
			continue;
		}
		let character = pattern[index..].chars().next().expect("non-empty suffix");
		if matches!(character, '(' | ')') {
			escaped.push('\\');
			modified = true;
		}
		escaped.push(character);
		index += character.len_utf8();
	}
	if modified {
		Cow::Owned(escaped)
	} else {
		Cow::Borrowed(pattern)
	}
}

fn build_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> Result<CompiledMatcher, GrepError> {
	let sanitized = sanitize_braces(pattern);
	let regex_error = match build_regex_matcher(sanitized.as_ref(), ignore_case, multiline) {
		Ok(matcher) => return Ok(CompiledMatcher::Rust(matcher)),
		Err(error) => error,
	};
	let pcre2_error = match build_pcre_matcher(sanitized.as_ref(), ignore_case, multiline) {
		Ok(matcher) => {
			tracing::debug!("using PCRE2 regex fallback");
			return Ok(CompiledMatcher::Pcre2(matcher));
		},
		Err(error) => error,
	};

	let message = regex_error.to_string();
	if message.contains("unclosed group") || message.contains("unopened group") {
		let escaped = escape_unescaped_parentheses(sanitized.as_ref());
		if escaped.as_ref() != sanitized.as_ref() {
			if let Ok(matcher) = build_regex_matcher(escaped.as_ref(), ignore_case, multiline) {
				tracing::warn!("repaired invalid regex parentheses");
				return Ok(CompiledMatcher::Rust(matcher));
			}
			if let Ok(matcher) = build_pcre_matcher(escaped.as_ref(), ignore_case, multiline) {
				tracing::warn!("repaired invalid regex parentheses with PCRE2");
				return Ok(CompiledMatcher::Pcre2(matcher));
			}
		}
	}

	match build_regex_matcher(&regex::escape(pattern), ignore_case, multiline) {
		Ok(matcher) => {
			tracing::warn!("using literal fallback for invalid regex");
			Ok(CompiledMatcher::Rust(matcher))
		},
		Err(_) => Err(GrepError::InvalidRegex {
			regex: Str::from(message),
			pcre2: Str::from(pcre2_error.to_string()),
		}),
	}
}

fn sanitize_braces(pattern: &str) -> Cow<'_, str> {
	let bytes = pattern.as_bytes();
	if !bytes.contains(&b'{') && !bytes.contains(&b'}') {
		return Cow::Borrowed(pattern);
	}
	let mut output = String::with_capacity(pattern.len() + 8);
	let mut modified = false;
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'\\' && index + 1 < bytes.len() {
			output.push('\\');
			index += 1;
			let character = pattern[index..].chars().next().expect("non-empty suffix");
			output.push(character);
			index += character.len_utf8();
			if matches!(character, 'p' | 'P' | 'x' | 'u')
				&& index < bytes.len()
				&& bytes[index] == b'{'
			{
				if let Some(end) = find_braced_escape_end(bytes, index) {
					output.push_str(&pattern[index..=end]);
					index = end + 1;
				} else {
					output.push_str(&pattern[index..]);
					index = bytes.len();
				}
			}
			continue;
		}
		if bytes[index] == b'{' {
			if let Some(end) = find_valid_repetition(bytes, index) {
				output.push_str(&pattern[index..=end]);
				index = end + 1;
				continue;
			}
			output.push_str("\\{");
			index += 1;
			modified = true;
			continue;
		}
		if bytes[index] == b'}' {
			output.push_str("\\}");
			index += 1;
			modified = true;
			continue;
		}
		let character = pattern[index..].chars().next().expect("non-empty suffix");
		output.push(character);
		index += character.len_utf8();
	}
	if modified {
		Cow::Owned(output)
	} else {
		Cow::Borrowed(pattern)
	}
}

const fn find_valid_repetition(bytes: &[u8], start: usize) -> Option<usize> {
	let mut index = start + 1;
	if index >= bytes.len() || !bytes[index].is_ascii_digit() {
		return None;
	}
	while index < bytes.len() && bytes[index].is_ascii_digit() {
		index += 1;
	}
	if index >= bytes.len() {
		return None;
	}
	if bytes[index] == b'}' {
		return Some(index);
	}
	if bytes[index] != b',' {
		return None;
	}
	index += 1;
	while index < bytes.len() && bytes[index].is_ascii_digit() {
		index += 1;
	}
	if index < bytes.len() && bytes[index] == b'}' {
		Some(index)
	} else {
		None
	}
}

const fn find_braced_escape_end(bytes: &[u8], start: usize) -> Option<usize> {
	let mut index = start + 1;
	while index < bytes.len() {
		if bytes[index] == b'}' {
			return Some(index);
		}
		index += 1;
	}
	None
}

fn context_lines(
	bytes: &[u8],
	first_line: u64,
	max_columns: Option<usize>,
) -> SmallVec<ContextLine, 8> {
	let mut lines = SmallVec::new();
	let mut line_number = first_line;
	for bytes in bytes.split_inclusive(|byte| *byte == b'\n') {
		if bytes.is_empty() {
			continue;
		}
		let (line, _) = truncate_line(bytes_to_trimmed_str(bytes), max_columns);
		lines.push(ContextLine { line_number: clamp_u32(line_number), line });
		line_number = line_number.saturating_add(1);
	}
	lines
}
struct AggregateGrepCollector {
	mode:               GrepOutputMode,
	max_count:          Option<u64>,
	max_count_per_file: Option<u64>,
	max_columns:        Option<usize>,
	matches:            Vec<GrepMatch>,
	total_matches:      u64,
	files_with_matches: u64,
	emitted:            u64,
	current_path:       Str,
	current_line:       Option<u64>,
	current_file_count: u64,
	limit_reached:      bool,
}

impl AggregateGrepCollector {
	fn new(options: &GrepOptions) -> Self {
		Self {
			mode:               options.mode,
			max_count:          options.max_count.map(u64::from),
			max_count_per_file: options.max_count_per_file.map(u64::from),
			max_columns:        options.max_columns.map(|columns| columns as usize),
			matches:            Vec::new(),
			total_matches:      0,
			files_with_matches: 0,
			emitted:            0,
			current_path:       Str::new(""),
			current_line:       None,
			current_file_count: 0,
			limit_reached:      false,
		}
	}

	fn finish(self, summary: GrepStreamSummary) -> GrepResult {
		GrepResult {
			matches:            self.matches,
			total_matches:      clamp_u32(self.total_matches),
			files_with_matches: clamp_u32(self.files_with_matches),
			files_searched:     clamp_u32(summary.files_searched),
			limit_reached:      self.limit_reached
				|| matches!(summary.status, GrepStreamStatus::Stopped | GrepStreamStatus::LimitReached),
			skipped_oversized:  clamp_u32(summary.skipped_oversized),
		}
	}
}

impl GrepSink for AggregateGrepCollector {
	type Error = convert::Infallible;

	fn control(&mut self) -> Result<GrepControl, Self::Error> {
		if self.max_count == Some(0) {
			self.limit_reached = true;
			return Ok(GrepControl::Stop);
		}
		Ok(GrepControl::Continue)
	}

	fn matched(&mut self, matched: GrepMatchRef<'_>) -> Result<GrepControl, Self::Error> {
		if self.current_path.as_str() != matched.path {
			self.current_path = Str::new(matched.path);
			self.current_line = None;
			self.current_file_count = 0;
		}
		if self.current_line == Some(matched.line_byte_offset) {
			return Ok(GrepControl::Continue);
		}
		self.current_line = Some(matched.line_byte_offset);
		if self.current_file_count == 0 {
			self.files_with_matches = self.files_with_matches.saturating_add(1);
		}
		self.current_file_count = self.current_file_count.saturating_add(1);
		self.total_matches = self.total_matches.saturating_add(1);

		if self.mode == GrepOutputMode::Content
			&& self
				.max_count_per_file
				.is_some_and(|maximum| self.current_file_count > maximum)
		{
			self.limit_reached = true;
			return Ok(GrepControl::Continue);
		}
		match self.mode {
			GrepOutputMode::Content => {
				let (line, truncated) =
					truncate_line(bytes_to_trimmed_str(matched.line_bytes), self.max_columns);
				self.matches.push(GrepMatch {
					path: self.current_path.clone(),
					line_number: clamp_u32(matched.line_number),
					line,
					truncated,
					context_before: context_lines(
						matched.context_before_bytes,
						matched.context_before_line,
						self.max_columns,
					),
					context_after: context_lines(
						matched.context_after_bytes,
						matched.context_after_line,
						self.max_columns,
					),
				});
				self.emitted = self.emitted.saturating_add(1);
			},
			GrepOutputMode::Count if self.current_file_count == 1 => {
				self.matches.push(file_marker(self.current_path.clone()));
				self.emitted = self.emitted.saturating_add(1);
			},
			GrepOutputMode::FilesWithMatches if self.current_file_count == 1 => {
				self.matches.push(file_marker(self.current_path.clone()));
				self.emitted = self.emitted.saturating_add(1);
			},
			GrepOutputMode::Count | GrepOutputMode::FilesWithMatches => {},
		}
		let consumed = match self.mode {
			GrepOutputMode::Content => self.emitted,
			GrepOutputMode::Count => self.total_matches,
			GrepOutputMode::FilesWithMatches => self.files_with_matches,
		};
		if self.max_count.is_some_and(|maximum| consumed >= maximum) {
			self.limit_reached = true;
			return Ok(GrepControl::Stop);
		}
		Ok(GrepControl::Continue)
	}
}

fn read_file_bytes_with_size(
	path: &Path,
	size_hint: Option<u64>,
	buffer: &mut Vec<u8>,
) -> io::Result<ReadFile> {
	let file = match File::open(path) {
		Ok(file) => file,
		Err(error)
			if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied) =>
		{
			return Ok(ReadFile::Skipped);
		},
		Err(error) => return Err(error),
	};
	let size = if let Some(size) = size_hint {
		size
	} else {
		let metadata = file.metadata()?;
		if !metadata.is_file() {
			return Ok(ReadFile::Skipped);
		}
		metadata.len()
	};
	if size > MAX_FILE_BYTES {
		return Ok(ReadFile::Oversized);
	}
	read_owned_prefix(file, FILE_CLASSIFICATION_READ_BYTES, size, buffer)?;
	if u64::try_from(buffer.len()).map_or(true, |length| length > MAX_FILE_BYTES) {
		return Ok(ReadFile::Oversized);
	}
	Ok(ReadFile::Read)
}

fn read_file_prefix(path: &Path, buffer: &mut Vec<u8>) -> io::Result<ReadFile> {
	let file = match File::open(path) {
		Ok(file) => file,
		Err(error)
			if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied) =>
		{
			return Ok(ReadFile::Skipped);
		},
		Err(error) => return Err(error),
	};
	let metadata = file.metadata()?;
	if !metadata.is_file() {
		return Ok(ReadFile::Skipped);
	}
	let window = metadata.len().min(MAX_FILE_BYTES);
	read_owned_prefix(file, window, window, buffer)?;
	Ok(ReadFile::Read)
}

fn read_owned_prefix(
	mut file: File,
	limit: u64,
	capacity_hint: u64,
	buffer: &mut Vec<u8>,
) -> io::Result<()> {
	buffer.clear();
	let capacity = usize::try_from(capacity_hint.min(limit)).expect("bounded capacity fits usize");
	buffer.reserve(capacity);
	file.by_ref().take(limit).read_to_end(buffer)?;
	Ok(())
}

fn file_marker(path: Str) -> GrepMatch {
	GrepMatch {
		path,
		line_number: 0,
		line: Str::new(""),
		truncated: false,
		context_before: SmallVec::new(),
		context_after: SmallVec::new(),
	}
}

fn truncate_line(line: Str, max_columns: Option<usize>) -> (Str, bool) {
	match max_columns {
		Some(maximum) if line.len() > maximum => {
			let mut boundary = maximum.saturating_sub(3).min(line.len());
			while !line.as_str().is_char_boundary(boundary) {
				boundary -= 1;
			}
			(Str::from(format!("{}...", &line.as_str()[..boundary])), true)
		},
		_ => (line, false),
	}
}

fn bytes_to_trimmed_str(bytes: &[u8]) -> Str {
	match str::from_utf8(bytes) {
		Ok(text) => Str::new(text.trim_end()),
		Err(_) => Str::new(String::from_utf8_lossy(bytes).trim_end()),
	}
}

const fn clamp_u32(value: u64) -> u32 {
	if value > u32::MAX as u64 {
		u32::MAX
	} else {
		value as u32
	}
}

#[cfg(test)]
mod tests {
	use std::{
		fs, mem,
		sync::atomic::{AtomicU64, Ordering},
	};

	use super::*;

	fn options(pattern: &str) -> GrepOptions {
		GrepOptions { pattern: Str::new(pattern), timeout_ms: None, ..GrepOptions::default() }
	}

	struct TempDir(PathBuf);

	impl TempDir {
		fn new() -> Self {
			static NEXT: AtomicU64 = AtomicU64::new(0);
			let path = env::temp_dir().join(format!(
				"omp-grep-{}-{}",
				std::process::id(),
				NEXT.fetch_add(1, Ordering::Relaxed)
			));
			fs::create_dir_all(&path).expect("create temp directory");
			Self(path)
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	type RecordedMatch = (Str, u64, u64, u64, Vec<u8>, Vec<u8>);

	#[derive(Default)]
	struct RecordingSink {
		records: Vec<RecordedMatch>,
	}

	impl GrepSink for RecordingSink {
		type Error = convert::Infallible;

		fn matched(&mut self, matched: GrepMatchRef<'_>) -> Result<GrepControl, Self::Error> {
			self.records.push((
				Str::new(matched.path),
				matched.line_number,
				matched.byte_offset,
				matched.match_end,
				matched.line_bytes.to_vec(),
				matched.matched_bytes.to_vec(),
			));
			Ok(GrepControl::Continue)
		}
	}

	#[derive(Default)]
	struct CountingSink {
		matches: usize,
	}

	impl GrepSink for CountingSink {
		type Error = convert::Infallible;

		fn matched(&mut self, _matched: GrepMatchRef<'_>) -> Result<GrepControl, Self::Error> {
			self.matches += 1;
			Ok(GrepControl::Continue)
		}
	}

	#[test]
	fn in_memory_search_collects_context_and_truncates() {
		let mut options = options("needle");
		options.path = Str::new("memory");
		options.context_before = 1;
		options.context_after = 1;
		options.max_columns = Some(9);
		let result = search(b"before line\nneedle payload\nafter\n", &options).unwrap();
		assert_eq!(result.total_matches, 1);
		assert_eq!(result.matches[0].line.as_str(), "needle...");
		assert!(result.matches[0].truncated);
		assert_eq!(result.matches[0].context_before[0].line.as_str(), "before...");
		assert_eq!(result.matches[0].context_after[0].line.as_str(), "after");
	}

	#[test]
	fn pcre2_fallback_handles_lookaround() {
		let matcher = build_matcher(r"foo(?=bar)", false, false).unwrap();
		assert!(matches!(matcher, CompiledMatcher::Pcre2(_)));
		let result = search(b"foobar\nfoobaz\n", &options(r"foo(?=bar)")).unwrap();
		assert_eq!(result.total_matches, 1);
	}

	#[test]
	fn pcre2_fallback_honors_case_and_cross_line_options() {
		let mut options = options(r"(?<=alpha)\nbeta");
		options.ignore_case = true;
		let matcher = build_matcher(options.pattern.as_str(), options.ignore_case, true).unwrap();
		assert!(matches!(matcher, CompiledMatcher::Pcre2(_)));
		let result = search(b"ALPHA\nBETA\n", &options).unwrap();
		assert_eq!(result.total_matches, 1);
	}

	#[test]
	fn rust_regex_case_matching_is_explicit() {
		let sensitive = search(b"Needle\n", &options("needle")).unwrap();
		assert_eq!(sensitive.total_matches, 0);

		let mut insensitive = options("needle");
		insensitive.ignore_case = true;
		let insensitive = search(b"Needle\n", &insensitive).unwrap();
		assert_eq!(insensitive.total_matches, 1);
	}

	#[test]
	fn invalid_regex_falls_back_to_literal() {
		for (pattern, haystack, miss) in [
			("foo[bar", &b"x foo[bar y"[..], &b"foobar"[..]),
			("+++", &b"a+++b"[..], &b"ab"[..]),
			("fail)", &b"(1 fail)"[..], &b"failure"[..]),
		] {
			let matcher = build_matcher(pattern, false, false)
				.unwrap_or_else(|error| panic!("`{pattern}` should be literal: {error}"));
			assert!(matcher.is_match(haystack).expect("match succeeds"));
			assert!(!matcher.is_match(miss).expect("miss succeeds"));
		}
	}

	#[test]
	fn stray_parenthesis_retry_preserves_surrounding_regex() {
		assert_eq!(escape_unescaped_parentheses(r"foo\(bar\)").as_ref(), r"foo\(bar\)");
		let matcher = build_matcher("foo.*(bar", false, false).expect("parenthesis retry");
		assert!(matcher.is_match(b"fooXYZ(bar").expect("match succeeds"));
		assert!(!matcher.is_match(b"foobar").expect("miss succeeds"));
	}

	#[test]
	fn directory_search_counts_normal_and_oversized_files() {
		let root = TempDir::new();
		fs::write(root.0.join("small.txt"), "needle\n").unwrap();
		let mut large = Vec::with_capacity(MAX_FILE_BYTES as usize + 1);
		large.extend_from_slice(b"needle in prefix\n");
		large.resize(MAX_FILE_BYTES as usize + 1, b'x');
		fs::write(root.0.join("large.txt"), large).unwrap();
		let mut options = options("needle");
		options.path = Str::from(root.0.to_string_lossy());
		let result = grep(&options).unwrap();
		assert_eq!(result.files_searched, 2);
		assert_eq!(result.files_with_matches, 2);
		assert_eq!(result.skipped_oversized, 0);
		assert_eq!(result.matches[0].path.as_str(), "large.txt");
		assert_eq!(result.matches[1].path.as_str(), "small.txt");
	}

	#[test]
	fn nul_marks_binary_content() {
		let result = search(b"needle\0needle\n", &options("needle")).unwrap();
		assert_eq!(result.total_matches, 0);
		assert!(result.matches.is_empty());
	}

	#[test]
	fn literal_backslash_n_infers_multiline_mode() {
		let result = search(b"alpha\nbeta\n", &options(r"alpha\nbeta")).unwrap();
		assert_eq!(result.total_matches, 1);
	}

	#[test]
	fn directory_caps_are_applied_after_path_ordering() {
		let root = TempDir::new();
		fs::write(root.0.join("b.txt"), "needle\nneedle\n").unwrap();
		fs::write(root.0.join("a.txt"), "needle\nneedle\n").unwrap();
		let mut options = options("needle");
		options.path = Str::from(root.0.to_string_lossy());
		options.max_count_per_file = Some(1);
		options.max_count = Some(2);
		let result = grep(&options).unwrap();
		assert_eq!(result.matches.len(), 2);
		assert_eq!(result.matches[0].path.as_str(), "a.txt");
		assert_eq!(result.matches[1].path.as_str(), "b.txt");
		assert!(result.limit_reached);
	}

	#[test]
	fn global_budget_stops_after_first_path_ordered_file() {
		let root = TempDir::new();
		fs::write(root.0.join("small.txt"), "needle\n").unwrap();
		let mut large = Vec::with_capacity(MAX_FILE_BYTES as usize + 1);
		large.extend_from_slice(b"needle in prefix\n");
		large.resize(MAX_FILE_BYTES as usize + 1, b'x');
		fs::write(root.0.join("large.txt"), large).unwrap();
		let mut options = options("needle");
		options.path = Str::from(root.0.to_string_lossy());
		options.max_count = Some(1);
		let result = grep(&options).unwrap();
		assert_eq!(result.files_searched, 1);
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path.as_str(), "large.txt");
	}

	#[test]
	fn caller_cancellation_stops_before_workspace_traversal() {
		let root = TempDir::new();
		fs::write(root.0.join("needle.txt"), "needle\n").unwrap();
		let mut options = options("needle");
		options.path = Str::from(root.0.to_string_lossy());
		let cancelled = AtomicBool::new(true);
		assert!(matches!(grep_with_cancellation(&options, &cancelled), Err(GrepError::Cancelled)));
	}

	#[test]
	fn compiled_stream_handles_rust_regex_and_pcre2_features() {
		fn assert_send_sync<T: Send + Sync>() {}
		assert_send_sync::<CompiledGrep>();
		let mut rust = RecordingSink::default();
		CompiledGrep::new(r"\bfoo\d+", RegexOptions::default())
			.unwrap()
			.search_slice("rust", b"foo42\nbar\n", StreamOptions::default(), &mut rust)
			.unwrap();
		assert_eq!(rust.records[0].5, b"foo42");

		let mut pcre = RecordingSink::default();
		CompiledGrep::new(r"(?<=foo)bar", RegexOptions::default())
			.unwrap()
			.search_slice("pcre", b"foobar\n", StreamOptions::default(), &mut pcre)
			.unwrap();
		assert_eq!(pcre.records[0].5, b"bar");
	}

	#[test]
	fn streaming_records_report_exact_offsets_and_borrowed_line_bytes() {
		let mut sink = RecordingSink::default();
		let summary = CompiledGrep::new("needle", RegexOptions::default())
			.unwrap()
			.search_slice("memory", b"zero\nxx needle yy\n", StreamOptions::default(), &mut sink)
			.unwrap();
		assert_eq!(summary.matches, 1);
		assert_eq!(sink.records[0].1, 2);
		assert_eq!(sink.records[0].2, 8);
		assert_eq!(sink.records[0].3, 14);
		assert_eq!(sink.records[0].4, b"xx needle yy");
	}

	#[test]
	fn sink_stop_and_cancellation_are_distinct() {
		struct StopSink;
		impl GrepSink for StopSink {
			type Error = convert::Infallible;

			fn matched(&mut self, _matched: GrepMatchRef<'_>) -> Result<GrepControl, Self::Error> {
				Ok(GrepControl::Stop)
			}
		}
		struct CancelSink {
			heartbeats: usize,
			matches:    usize,
		}
		impl GrepSink for CancelSink {
			type Error = convert::Infallible;

			fn control(&mut self) -> Result<GrepControl, Self::Error> {
				self.heartbeats += 1;
				Ok(if self.heartbeats > 1 {
					GrepControl::Cancel
				} else {
					GrepControl::Continue
				})
			}

			fn matched(&mut self, _matched: GrepMatchRef<'_>) -> Result<GrepControl, Self::Error> {
				self.matches += 1;
				Ok(GrepControl::Continue)
			}
		}

		let matcher = CompiledGrep::new("x", RegexOptions::default()).unwrap();
		let stopped = matcher
			.search_slice("memory", b"x\nx\n", StreamOptions::default(), &mut StopSink)
			.unwrap();
		assert_eq!(stopped.status, GrepStreamStatus::Stopped);
		assert_eq!(stopped.matches, 1);
		let mut cancel = CancelSink { heartbeats: 0, matches: 0 };
		let cancelled = matcher
			.search_slice("memory", b"x\nx\n", StreamOptions::default(), &mut cancel)
			.unwrap();
		assert_eq!(cancelled.status, GrepStreamStatus::Cancelled);
		assert_eq!(cancel.matches, 1);

		let mut limited_sink = CountingSink::default();
		let limited = matcher
			.search_slice(
				"memory",
				b"x\nx\nx\n",
				StreamOptions { max_count: Some(2), ..StreamOptions::default() },
				&mut limited_sink,
			)
			.unwrap();
		assert_eq!(limited.status, GrepStreamStatus::LimitReached);
		assert_eq!(limited_sink.matches, 2);
	}

	#[test]
	fn streaming_directory_order_is_stable_after_parallel_walk() {
		let root = TempDir::new();
		fs::write(root.0.join("b.txt"), "x\nx\n").unwrap();
		fs::write(root.0.join("a.txt"), "x\nx\n").unwrap();
		let mut options = options("x");
		options.path = Str::from(root.0.to_string_lossy());
		let mut first = RecordingSink::default();
		grep_stream(&options, &mut first).unwrap();
		let mut second = RecordingSink::default();
		grep_stream(&options, &mut second).unwrap();
		let order = |sink: &RecordingSink| {
			sink
				.records
				.iter()
				.map(|record| (record.0.clone(), record.2))
				.collect::<Vec<_>>()
		};
		assert_eq!(order(&first), order(&second));
		assert_eq!(first.records[0].0.as_str(), "a.txt");
		assert_eq!(first.records[2].0.as_str(), "b.txt");
	}

	#[test]
	fn non_collecting_sink_memory_is_bounded_by_its_state() {
		let mut content = Vec::new();
		for _ in 0..10_000 {
			content.extend_from_slice(b"x\n");
		}
		let mut sink = CountingSink::default();
		let bytes_before = mem::size_of_val(&sink);
		let summary = CompiledGrep::new("x", RegexOptions::default())
			.unwrap()
			.search_slice("memory", &content, StreamOptions::default(), &mut sink)
			.unwrap();
		assert_eq!(sink.matches, 10_000);
		assert_eq!(summary.matches, 10_000);
		assert_eq!(size_of_val(&sink), bytes_before);
	}

	#[test]
	fn zero_timeout_is_typed() {
		let mut options = options("needle");
		options.timeout_ms = Some(0);
		assert!(matches!(search(b"needle", &options), Err(GrepError::Timeout { timeout_ms: 0 })));
	}
}
