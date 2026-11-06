//! Content search: the engine behind the `grep`, `search`, and `hasMatch`
//! natives.
//!
//! Patterns compile in pi's dialect ([`Engine::compile`]). Matching is line
//! oriented: a match is a line (in multiline mode, a block of lines)
//! containing a match, reported with optional context lines, trailing
//! whitespace trimmed, invalid UTF-8 replaced, and lines wider than
//! `max_columns` cut to a window around their first match. A NUL byte in the
//! first 64 KiB makes a file binary (searched, no matches); past that, a
//! reported line holding a NUL ends the file's search.
//!
//! Directory searches read and scan files inside one parallel walk when
//! results are unbounded; with a match budget a path-ordered walk streams
//! candidates into a parallel search that consumes them in that order, and
//! both stop once the budget is settled. Either way results are in path
//! order — files over 4 MiB, searched over their first 4 MiB, after all
//! others — and identical from run to run. With a sink, results are
//! delivered per file, as they complete, instead of returned. Dropping the
//! [`grep`] future cancels the search.
//!
//! ```ignore
//! let engine = Arc::new(Engine::compile(r"impl\s+\w+ for", false, false)?);
//! let result = grep::grep(&fs, root, GrepOptions {
//!     glob: Some("*.rs".into()),
//!     before: 1, after: 1,
//!     ..GrepOptions::new(engine)
//! }).await?;
//! ```

mod engine;
mod render;
mod run;
mod scan;
#[cfg(test)]
mod tests;
mod types;

use std::{fmt, io, path::Path, sync::Arc};

pub use engine::{Engine, EngineError, pcre2_jit_enabled};
use scan::{ScanParams, Scanner};

use crate::{
	fs::Fs,
	pattern::PatternError,
	walk::{self, WalkError},
};

/// Largest prefix of a file that is searched; longer files are searched over
/// this window after every shorter file.
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// What a search reports.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
	/// Matching lines with their context.
	#[default]
	Content,
	/// One entry per matching file with its match count.
	Count,
	/// One entry per matching file.
	FilesWithMatches,
}

/// A line reported around a match.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextLine {
	/// 1-based line number.
	pub line: u64,
	/// Line text, rendered like [`Match::text`] (cut, not windowed).
	pub text: String,
}

/// One result entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Match {
	/// Walk-relative path (`/`-separated, invalid UTF-8 replaced); for a root
	/// that is a file, the root's own spelling. Empty from [`search`].
	pub path:      String,
	/// 1-based number of the matching line (a block's first line); 0
	/// outside [`Mode::Content`].
	pub line:      u64,
	/// The matching line (a multiline block's lines joined by `\n`); empty
	/// outside [`Mode::Content`].
	pub text:      String,
	/// Context lines before the match.
	pub before:    Vec<ContextLine>,
	/// Context lines after the match.
	pub after:     Vec<ContextLine>,
	/// `max_columns` cut the line.
	pub truncated: bool,
	/// For a cut line, the 1-based character column where its first match
	/// starts; the cut `text` shows a window around it.
	pub column:    Option<u32>,
	/// The file's match count ([`Mode::Count`] only).
	pub count:     Option<u64>,
}

/// Options of an in-memory [`search`].
#[derive(Clone, Debug, Default)]
pub struct SearchOptions {
	/// The engine was compiled for multiline matching.
	pub multiline:   bool,
	/// [`Mode::Content`] returns matches; the other modes only count.
	pub mode:        Mode,
	/// Context lines before each match.
	pub before:      usize,
	/// Context lines after each match.
	pub after:       usize,
	/// Cut reported lines longer than this many bytes.
	pub max_columns: Option<usize>,
	/// Skip this many matches.
	pub offset:      u64,
	/// Return at most this many matches after `offset`.
	pub max_count:   Option<u64>,
}

/// Outcome of [`search`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SearchResult {
	/// Selected matches ([`Mode::Content`]), `path` empty.
	pub matches:       Vec<Match>,
	/// Matches found; the scan stops one match past `offset + max_count`.
	pub match_count:   u64,
	/// `max_count` matches were returned.
	pub limit_reached: bool,
}

/// Searches one in-memory buffer with the scanner and selection rules of
/// [`grep`].
///
/// # Errors
/// A PCRE2 search error (match limit, JIT stack).
pub fn search(
	engine: &Engine,
	content: &[u8],
	opts: &SearchOptions,
) -> Result<SearchResult, String> {
	let content_mode = opts.mode == Mode::Content;
	let params = ScanParams {
		content:     content_mode,
		before:      if content_mode { opts.before } else { 0 },
		after:       if content_mode { opts.after } else { 0 },
		max_columns: opts.max_columns,
		offset:      opts.offset,
		cap:         opts.max_count,
		probe:       true,
	};
	let spans = engine.spans_lines();
	let mut matches = Vec::new();
	let mut scanner = Scanner::default();
	let outcome = match engine {
		Engine::Rust(m) => scanner
			.scan(m, opts.multiline, spans, content, &params, &mut matches)
			.map_err(|err| err.to_string()),
		Engine::Pcre(m) => scanner
			.scan(m, opts.multiline, spans, content, &params, &mut matches)
			.map_err(|err| err.to_string()),
	}?;
	Ok(SearchResult { matches, match_count: outcome.count, limit_reached: outcome.limit_reached })
}

/// Options of a [`grep`] search.
#[derive(Clone)]
pub struct GrepOptions {
	/// Compiled pattern.
	pub engine:             Arc<Engine>,
	/// The engine was compiled for multiline matching.
	pub multiline:          bool,
	/// Restrict directory searches to [`crate::glob::Selector::scope`] of `glob`
	/// and `recursive`; ignored for a file root.
	pub glob:               Option<String>,
	/// See [`crate::glob::Selector::new`].
	pub recursive:          bool,
	/// [`crate::glob::Selector::exclude`] patterns; ignored for a file root.
	pub exclude:            Vec<String>,
	/// Keep files of one type from pi's table (`rust`, `ts`, `py`, …); any
	/// other value is a case-insensitive extension or exact file name. A
	/// leading `.` is ignored.
	pub file_type:          Option<String>,
	/// What to report.
	pub mode:               Mode,
	/// Context lines before each match ([`Mode::Content`]).
	pub before:             usize,
	/// Context lines after each match ([`Mode::Content`]).
	pub after:              usize,
	/// Cut reported lines longer than this many bytes.
	pub max_columns:        Option<usize>,
	/// Skip this many results in path order (matches in content and count
	/// mode, files in files-with-matches mode).
	pub offset:             u64,
	/// Return at most this many results after `offset`; the search stops as
	/// soon as they are known.
	pub max_count:          Option<u64>,
	/// Keep at most this many matches per file ([`Mode::Content`]).
	pub max_count_per_file: Option<u64>,
	/// Traversal: `hidden`, `gitignore`, `workers`, `cache` are honoured;
	/// `.git` is always pruned and `node_modules` unless the glob names it.
	pub walk:               walk::Options,
	/// Deliver results per file (batches of at most 1024 entries, all from
	/// one file) instead of returning them; a full channel pauses the search.
	/// Incompatible with `offset` and `max_count`.
	pub sink:               Option<tokio::sync::mpsc::Sender<Vec<Match>>>,
}

impl GrepOptions {
	/// Content search of every file, hidden ones and ignore rules included,
	/// with no limits.
	pub fn new(engine: Arc<Engine>) -> Self {
		Self {
			engine,
			multiline: false,
			glob: None,
			recursive: true,
			exclude: Vec::new(),
			file_type: None,
			mode: Mode::Content,
			before: 0,
			after: 0,
			max_columns: None,
			offset: 0,
			max_count: None,
			max_count_per_file: None,
			walk: walk::Options { hidden: true, gitignore: true, ..walk::Options::default() },
			sink: None,
		}
	}
}

/// Outcome of a [`grep`] search.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GrepResult {
	/// Selected results in path order; empty when streamed.
	pub matches:            Vec<Match>,
	/// Matches found in the searched files (in files-with-matches mode, the
	/// matching files); exact unless a budget stopped the search.
	pub total_matches:      u64,
	/// Searched files with at least one match.
	pub files_with_matches: u64,
	/// Files read and searched (binary and match-free files included).
	pub files_searched:     u64,
	/// Results were left out by `max_count` or `max_count_per_file`.
	pub limit_reached:      bool,
	/// Files over [`MAX_FILE_BYTES`] that could not be read.
	pub skipped_oversized:  u64,
}

/// Why a [`grep`] failed.
#[derive(Debug)]
pub enum GrepError {
	/// The glob is malformed.
	Glob(PatternError),
	/// An exclude pattern is malformed.
	Exclude(PatternError),
	/// `sink` with `offset` or `max_count`.
	StreamLimits,
	/// The root does not exist.
	NotFound(io::Error),
	/// Walking failed or was stopped.
	Walk(WalkError),
	/// The sink failed.
	Sink(String),
	/// Searching a file root failed (a PCRE2 limit, or a line over 64 MiB in
	/// a streamed oversized file).
	Search(String),
}

impl fmt::Display for GrepError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Glob(err) => write!(f, "Invalid glob pattern: {err}"),
			Self::Exclude(err) => write!(f, "Invalid exclude pattern: {err}"),
			Self::StreamLimits => {
				f.write_str("Streaming grep (onMatches) does not support maxCount or offset")
			},
			Self::NotFound(err) => write!(f, "Path not found: {err}"),
			Self::Walk(err) => err.fmt(f),
			Self::Sink(reason) => f.write_str(reason),
			Self::Search(reason) => write!(f, "Search failed: {reason}"),
		}
	}
}

impl std::error::Error for GrepError {}

/// Searches the files below `root` (or `root` itself if it is a file; any
/// other kind of root yields an empty result).
///
/// Takes `opts` by value so every sink sender is dropped when it returns.
///
/// # Errors
/// See [`GrepError`]; unreadable files and directories below `root` are
/// skipped, and a closed sink receiver is [`GrepError::Sink`].
pub async fn grep(fs: &Fs, root: &Path, opts: GrepOptions) -> Result<GrepResult, GrepError> {
	run::grep(fs, root, opts).await
}
