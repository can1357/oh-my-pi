//! Ripgrep-backed search engine exported via N-API.
//!
//! Provides two layers:
//! - `search()` for in-memory content search.
//! - `grep()` for filesystem search with glob/type filtering.
//!
//! The filesystem search matches the previous JS wrapper behavior, including
//! global offsets, optional match limits, and per-file match summaries.

use std::{
	borrow::Cow,
	fs::File,
	io::{self, Read},
	path::{Path, PathBuf},
	sync::{
		Arc, Mutex,
		atomic::{AtomicU64, AtomicUsize, Ordering},
	},
};

use globset::GlobSet;
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{
	BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkContextKind, SinkMatch,
};
use ignore::{ParallelVisitor, ParallelVisitorBuilder, WalkState};
use napi::{
	JsString,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use smallvec::SmallVec;

use crate::{fs_cache, glob_util, task};

const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const SMALL_FILE_READ_BYTES: u64 = 128 * 1024;

static ACTIVE_STREAMING_GREPS: AtomicUsize = AtomicUsize::new(0);

struct ActiveStreamingGrep;

impl ActiveStreamingGrep {
	fn enter() -> (Self, usize) {
		let active = ACTIVE_STREAMING_GREPS.fetch_add(1, Ordering::Relaxed) + 1;
		(Self, active)
	}
}

impl Drop for ActiveStreamingGrep {
	fn drop(&mut self) {
		ACTIVE_STREAMING_GREPS.fetch_sub(1, Ordering::Relaxed);
	}
}

/// Output mode for [`search`] and [`grep`] (string values match JS callers).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum GrepOutputMode {
	/// Emit matched lines (and optional context lines).
	#[napi(value = "content")]
	Content,
	/// Emit per-file or total counts instead of line content.
	#[napi(value = "count")]
	Count,
	/// Emit one row per file that matched, without line content.
	#[napi(value = "filesWithMatches")]
	FilesWithMatches,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OutputMode {
	Content,
	Count,
	FilesWithMatches,
}

/// Options for searching file content.
#[napi(object)]
pub struct SearchOptions {
	/// Regex pattern to search for.
	pub pattern:        String,
	/// Case-insensitive search.
	pub ignore_case:    Option<bool>,
	/// Enable multiline matching.
	pub multiline:      Option<bool>,
	/// Maximum number of matches to return.
	pub max_count:      Option<u32>,
	/// Skip first N matches.
	pub offset:         Option<u32>,
	/// Lines of context before matches.
	pub context_before: Option<u32>,
	/// Lines of context after matches.
	pub context_after:  Option<u32>,
	/// Lines of context before/after matches (legacy).
	pub context:        Option<u32>,
	/// Truncate lines longer than this (characters).
	pub max_columns:    Option<u32>,
	/// Output mode (content or count).
	pub mode:           Option<GrepOutputMode>,
}

/// Options for searching files on disk.
#[napi(object)]
pub struct GrepOptions<'env> {
	/// Regex pattern to search for.
	pub pattern:            String,
	/// Directory or file to search.
	pub path:               String,
	/// Glob filter for filenames (e.g., "*.ts").
	pub glob:               Option<String>,
	/// Filter by file type (e.g., "js", "py", "rust").
	pub r#type:             Option<String>,
	/// Case-insensitive search.
	pub ignore_case:        Option<bool>,
	/// Enable multiline matching.
	pub multiline:          Option<bool>,
	/// Include hidden files (default: true).
	pub hidden:             Option<bool>,
	/// Respect .gitignore files (default: true).
	pub gitignore:          Option<bool>,
	/// Maximum number of matches to return.
	pub max_count:          Option<u32>,
	/// Skip first N matches.
	pub offset:             Option<u32>,
	/// Lines of context before matches.
	pub context_before:     Option<u32>,
	/// Lines of context after matches.
	pub context_after:      Option<u32>,
	/// Lines of context before/after matches (legacy).
	pub context:            Option<u32>,
	/// Truncate lines longer than this (characters).
	pub max_columns:        Option<u32>,
	/// Output mode (content, filesWithMatches, or count).
	pub mode:               Option<GrepOutputMode>,
	/// Maximum matches collected per file (content mode). Keeps one hot file
	/// from exhausting the global `max_count` budget before other files are
	/// reached.
	pub max_count_per_file: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:             Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms:         Option<u32>,
}

/// A context line (before or after a match).
#[derive(Clone)]
#[napi(object)]
pub struct ContextLine {
	/// 1-indexed line number in the source file.
	pub line_number: u32,
	/// Raw line content (trimmed line ending).
	pub line:        String,
}

/// A single match in the content.
#[napi(object)]
pub struct Match {
	/// 1-indexed line number.
	pub line_number:    u32,
	/// The matched line content.
	pub line:           String,
	/// Context lines before the match.
	pub context_before: Option<Vec<ContextLine>>,
	/// Context lines after the match.
	pub context_after:  Option<Vec<ContextLine>>,
	/// Whether the line was truncated.
	pub truncated:      Option<bool>,
}

/// Result of searching content.
#[napi(object)]
pub struct SearchResult {
	/// All matches found.
	pub matches:       Vec<Match>,
	/// Total number of matches (may exceed `matches.len()` due to offset/limit).
	pub match_count:   u32,
	/// Whether the limit was reached.
	pub limit_reached: bool,
	/// Error message, if any.
	pub error:         Option<String>,
}

/// A single match in a grep result.
#[derive(Clone)]
#[napi(object)]
pub struct GrepMatch {
	/// File path for the match (relative for directory searches).
	pub path:           String,
	/// 1-indexed line number (0 for count-only entries).
	pub line_number:    u32,
	/// The matched line content (empty for count-only entries).
	pub line:           String,
	/// Context lines before the match.
	pub context_before: Option<Vec<ContextLine>>,
	/// Context lines after the match.
	pub context_after:  Option<Vec<ContextLine>>,
	/// Whether the line was truncated.
	pub truncated:      Option<bool>,
	/// Per-file match count (count mode only).
	pub match_count:    Option<u32>,
}

/// Result of searching files.
#[napi(object)]
pub struct GrepResult {
	/// Matches or per-file counts, depending on output mode.
	pub matches:            Vec<GrepMatch>,
	/// Total matches across all files, or matched file count in filesWithMatches
	/// mode.
	pub total_matches:      u32,
	/// Number of files with at least one match.
	pub files_with_matches: u32,
	/// Number of files searched.
	pub files_searched:     u32,
	/// Whether the limit/offset stopped the search early.
	pub limit_reached:      Option<bool>,
	/// Number of files skipped because they exceed the size limit.
	pub skipped_oversized:  Option<u32>,
}

enum TypeFilter {
	Known { exts: &'static [&'static str], names: &'static [&'static str] },
	Custom(String),
}

impl TypeFilter {
	fn match_ext(&self, ext: &str) -> bool {
		match self {
			Self::Known { exts, .. } => exts.iter().any(|e| ext.eq_ignore_ascii_case(e)),
			Self::Custom(custom_ext) => ext.eq_ignore_ascii_case(custom_ext),
		}
	}

	fn match_name(&self, name: &str) -> bool {
		match self {
			Self::Known { names, .. } => names.iter().any(|n| name.eq_ignore_ascii_case(n)),
			Self::Custom(ext) => ext.eq_ignore_ascii_case(name),
		}
	}
}

// ---------------------------------------------------------------------------
// Internal match collection
// ---------------------------------------------------------------------------

struct MatchCollector {
	matches:         Vec<CollectedMatch>,
	match_count:     u64,
	collected_count: u64,
	max_count:       Option<u64>,
	offset:          u64,
	skipped:         u64,
	limit_reached:   bool,
	max_columns:     Option<usize>,
	collect_matches: bool,
	context_before:  SmallVec<[ContextLine; 8]>,
}

struct CollectedMatch {
	line_number:    u64,
	line:           String,
	context_before: SmallVec<[ContextLine; 8]>,
	context_after:  SmallVec<[ContextLine; 8]>,
	truncated:      bool,
}

struct SearchResultInternal {
	matches:       Vec<CollectedMatch>,
	match_count:   u64,
	collected:     u64,
	limit_reached: bool,
}

struct FileSearchResult {
	relative_path: String,
	matches:       Vec<CollectedMatch>,
	match_count:   u64,
	limit_reached: bool,
}

enum FileBytes {
	Mapped(memmap2::Mmap),
	Owned(Vec<u8>),
}

/// Outcome of attempting to read a file for searching.
enum ReadFile {
	Bytes(FileBytes),
	/// File exceeds [`MAX_FILE_BYTES`]; callers count these so the skip can be
	/// surfaced instead of silently returning no matches.
	Oversized,
	/// Unreadable or not a regular file; silently skipped.
	Skipped,
}

impl FileBytes {
	fn as_slice(&self) -> &[u8] {
		match self {
			Self::Mapped(mapped) => mapped.as_ref(),
			Self::Owned(bytes) => bytes.as_slice(),
		}
	}
}

impl MatchCollector {
	fn new(
		max_count: Option<u64>,
		offset: u64,
		max_columns: Option<usize>,
		collect_matches: bool,
	) -> Self {
		Self {
			matches: Vec::new(),
			match_count: 0,
			collected_count: 0,
			max_count,
			offset,
			skipped: 0,
			limit_reached: false,
			max_columns,
			collect_matches,
			context_before: SmallVec::new(),
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn truncate_line(line: String, max_columns: Option<usize>) -> (String, bool) {
	match max_columns {
		Some(max) if line.len() > max => {
			let cut = max.saturating_sub(3);
			let boundary = line.floor_char_boundary(cut);
			(format!("{}...", &line[..boundary]), true)
		},
		_ => (line, false),
	}
}

fn bytes_to_trimmed_string(bytes: &[u8]) -> String {
	match std::str::from_utf8(bytes) {
		Ok(text) => text.trim_end().to_string(),
		Err(_) => String::from_utf8_lossy(bytes).trim_end().to_string(),
	}
}

// ---------------------------------------------------------------------------
// Sink implementation for grep-searcher
// ---------------------------------------------------------------------------

impl Sink for MatchCollector {
	type Error = io::Error;

	fn matched(
		&mut self,
		_searcher: &Searcher,
		mat: &SinkMatch<'_>,
	) -> std::result::Result<bool, Self::Error> {
		self.match_count += 1;

		if self.limit_reached {
			return Ok(false);
		}

		if self.skipped < self.offset {
			self.skipped += 1;
			self.context_before.clear();
			return Ok(true);
		}

		if self.collect_matches {
			let raw_line = bytes_to_trimmed_string(mat.bytes());
			let (line, truncated) = truncate_line(raw_line, self.max_columns);
			let line_number = mat.line_number().unwrap_or(0);

			self.matches.push(CollectedMatch {
				line_number,
				line,
				context_before: std::mem::take(&mut self.context_before),
				context_after: SmallVec::new(),
				truncated,
			});
		} else {
			self.context_before.clear();
		}

		self.collected_count += 1;

		if let Some(max) = self.max_count
			&& self.collected_count >= max
		{
			self.limit_reached = true;
		}

		Ok(true)
	}

	fn context(
		&mut self,
		_searcher: &Searcher,
		ctx: &SinkContext<'_>,
	) -> std::result::Result<bool, Self::Error> {
		if !self.collect_matches {
			return Ok(true);
		}

		let raw_line = bytes_to_trimmed_string(ctx.bytes());
		let (line, _) = truncate_line(raw_line, self.max_columns);
		let line_number = ctx.line_number().unwrap_or(0);

		match ctx.kind() {
			SinkContextKind::Before => {
				self
					.context_before
					.push(ContextLine { line_number: crate::utils::clamp_u32(line_number), line });
			},
			SinkContextKind::After => {
				if let Some(last_match) = self.matches.last_mut() {
					last_match
						.context_after
						.push(ContextLine { line_number: crate::utils::clamp_u32(line_number), line });
				}
			},
			SinkContextKind::Other => {},
		}

		Ok(true)
	}
}

// ---------------------------------------------------------------------------
// Option resolution
// ---------------------------------------------------------------------------

const fn parse_output_mode(mode: Option<GrepOutputMode>) -> OutputMode {
	match mode {
		None | Some(GrepOutputMode::Content) => OutputMode::Content,
		Some(GrepOutputMode::Count) => OutputMode::Count,
		Some(GrepOutputMode::FilesWithMatches) => OutputMode::FilesWithMatches,
	}
}

fn resolve_search_path(path: &str) -> Result<PathBuf> {
	let candidate = PathBuf::from(path);
	if candidate.is_absolute() {
		return Ok(candidate);
	}
	let cwd = std::env::current_dir()
		.map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?;
	Ok(cwd.join(candidate))
}

fn resolve_type_filter(type_name: Option<&str>) -> Option<TypeFilter> {
	let normalized = type_name
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(|value| value.trim_start_matches('.').to_lowercase())?;

	let (exts, names): (&[&str], &[&str]) = match normalized.as_str() {
		"js" | "javascript" => (&["js", "jsx", "mjs", "cjs"], &[]),
		"ts" | "typescript" => (&["ts", "tsx", "mts", "cts"], &[]),
		"json" => (&["json", "jsonc", "json5"], &[]),
		"yaml" | "yml" => (&["yaml", "yml"], &[]),
		"toml" => (&["toml"], &[]),
		"md" | "markdown" => (&["md", "markdown", "mdx"], &[]),
		"py" | "python" => (&["py", "pyi"], &[]),
		"rs" | "rust" => (&["rs"], &[]),
		"go" => (&["go"], &[]),
		"java" => (&["java"], &[]),
		"kt" | "kotlin" => (&["kt", "kts"], &[]),
		"c" => (&["c", "h"], &[]),
		"cpp" | "cxx" => (&["cpp", "cc", "cxx", "hpp", "hxx", "hh"], &[]),
		"cs" | "csharp" => (&["cs", "csx"], &[]),
		"php" => (&["php", "phtml"], &[]),
		"rb" | "ruby" => (&["rb", "rake", "gemspec"], &[]),
		"sh" | "bash" => (&["sh", "bash", "zsh"], &[]),
		"zsh" => (&["zsh"], &[]),
		"fish" => (&["fish"], &[]),
		"html" => (&["html", "htm"], &[]),
		"css" => (&["css"], &[]),
		"scss" => (&["scss"], &[]),
		"sass" => (&["sass"], &[]),
		"less" => (&["less"], &[]),
		"xml" => (&["xml"], &[]),
		"docker" | "dockerfile" => (&[], &["dockerfile"]),
		"make" | "makefile" => (&[], &["makefile"]),
		_ => {
			return Some(TypeFilter::Custom(normalized));
		},
	};

	Some(TypeFilter::Known { exts, names })
}

fn matches_type_filter(path: &Path, filter: &TypeFilter) -> bool {
	let base_name = path
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or("");
	if filter.match_name(base_name) {
		return true;
	}
	let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
	if ext.is_empty() {
		return false;
	}
	filter.match_ext(ext)
}

fn resolve_context(
	context: Option<u32>,
	context_before: Option<u32>,
	context_after: Option<u32>,
) -> (u32, u32) {
	if context_before.is_some() || context_after.is_some() {
		(context_before.unwrap_or(0), context_after.unwrap_or(0))
	} else {
		let value = context.unwrap_or(0);
		(value, value)
	}
}

// ---------------------------------------------------------------------------
// Search engine
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct SearchParams {
	context_before:     u32,
	context_after:      u32,
	max_columns:        Option<u32>,
	mode:               OutputMode,
	max_count:          Option<u64>,
	max_count_per_file: Option<u64>,
	offset:             u64,
	multiline:          bool,
}

fn run_search(
	matcher: &grep_regex::RegexMatcher,
	content: &[u8],
	params: SearchParams,
) -> io::Result<SearchResultInternal> {
	run_search_slice(&mut build_searcher_for_params(params), matcher, content, params)
}

fn run_search_slice(
	searcher: &mut Searcher,
	matcher: &grep_regex::RegexMatcher,
	content: &[u8],
	params: SearchParams,
) -> io::Result<SearchResultInternal> {
	let mut collector = MatchCollector::new(
		params.max_count,
		params.offset,
		params.max_columns.map(|v| v as usize),
		params.mode == OutputMode::Content,
	);
	searcher.search_slice(matcher, content, &mut collector)?;
	Ok(SearchResultInternal {
		matches:       collector.matches,
		match_count:   collector.match_count,
		collected:     collector.collected_count,
		limit_reached: collector.limit_reached,
	})
}

fn build_searcher_for_params(params: SearchParams) -> Searcher {
	let collect_content = params.mode == OutputMode::Content;
	build_searcher(
		if collect_content {
			params.context_before
		} else {
			0
		},
		if collect_content {
			params.context_after
		} else {
			0
		},
		params.multiline,
		collect_content,
	)
}

fn build_searcher(
	context_before: u32,
	context_after: u32,
	multiline: bool,
	line_number: bool,
) -> Searcher {
	SearcherBuilder::new()
		.binary_detection(BinaryDetection::quit(b'\x00'))
		.line_number(line_number)
		.multi_line(multiline)
		.before_context(context_before as usize)
		.after_context(context_after as usize)
		.build()
}

/// Read file bytes, distinguishing oversized files from other skips.
fn read_file_bytes(path: &Path) -> io::Result<ReadFile> {
	let file = match File::open(path) {
		Ok(file) => file,
		Err(err)
			if matches!(err.kind(), io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied) =>
		{
			return Ok(ReadFile::Skipped);
		},
		Err(err) => return Err(err),
	};
	let metadata = file.metadata()?;
	if !metadata.is_file() {
		return Ok(ReadFile::Skipped);
	}
	let size = metadata.len();
	if size > MAX_FILE_BYTES {
		return Ok(ReadFile::Oversized);
	} else if size == 0 {
		return Ok(ReadFile::Bytes(FileBytes::Owned(Vec::new())));
	}
	if size <= SMALL_FILE_READ_BYTES {
		let mut buffer = Vec::with_capacity(size as usize);
		let mut handle = file;
		handle.read_to_end(&mut buffer)?;
		return Ok(ReadFile::Bytes(FileBytes::Owned(buffer)));
	}

	let mapping = unsafe {
		// SAFETY: The mapping is read-only and tied to the opened file handle.
		// We do not mutate through this view; the map is dropped immediately
		// after search for each file.
		memmap2::Mmap::map(&file)
	};

	let bytes = if let Ok(mapped) = mapping {
		FileBytes::Mapped(mapped)
	} else {
		let mut buffer = Vec::with_capacity(size as usize);
		let mut handle = file;
		handle.read_to_end(&mut buffer)?;
		FileBytes::Owned(buffer)
	};

	Ok(ReadFile::Bytes(bytes))
}

// ---------------------------------------------------------------------------
// Result conversion
// ---------------------------------------------------------------------------

fn to_public_match(matched: CollectedMatch) -> Match {
	let context_before = if matched.context_before.is_empty() {
		None
	} else {
		Some(matched.context_before.into_vec())
	};
	let context_after = if matched.context_after.is_empty() {
		None
	} else {
		Some(matched.context_after.into_vec())
	};
	Match {
		line_number: crate::utils::clamp_u32(matched.line_number),
		line: matched.line,
		context_before,
		context_after,
		truncated: if matched.truncated { Some(true) } else { None },
	}
}

fn to_grep_match(path: String, matched: CollectedMatch) -> GrepMatch {
	let context_before = if matched.context_before.is_empty() {
		None
	} else {
		Some(matched.context_before.into_vec())
	};
	let context_after = if matched.context_after.is_empty() {
		None
	} else {
		Some(matched.context_after.into_vec())
	};
	GrepMatch {
		path,
		line_number: crate::utils::clamp_u32(matched.line_number),
		line: matched.line,
		context_before,
		context_after,
		truncated: if matched.truncated { Some(true) } else { None },
		match_count: None,
	}
}

fn push_content_matches(
	matches: &mut Vec<GrepMatch>,
	path: String,
	collected_matches: Vec<CollectedMatch>,
) {
	let last_index = collected_matches.len().saturating_sub(1);
	let mut path = Some(path);
	for (index, matched) in collected_matches.into_iter().enumerate() {
		let match_path = if index == last_index {
			path.take().expect("path is available for final match")
		} else {
			path
				.as_ref()
				.expect("path is available for cloned matches")
				.clone()
		};
		matches.push(to_grep_match(match_path, matched));
	}
}

const fn empty_search_result(error: Option<String>) -> SearchResult {
	SearchResult { matches: Vec::new(), match_count: 0, limit_reached: false, error }
}

/// Internal configuration for grep, extracted from options.
struct GrepConfig {
	pattern:            String,
	path:               String,
	glob:               Option<String>,
	type_filter:        Option<String>,
	ignore_case:        Option<bool>,
	multiline:          Option<bool>,
	hidden:             Option<bool>,
	gitignore:          Option<bool>,
	max_count:          Option<u32>,
	offset:             Option<u32>,
	context_before:     Option<u32>,
	context_after:      Option<u32>,
	context:            Option<u32>,
	max_columns:        Option<u32>,
	mode:               Option<GrepOutputMode>,
	max_count_per_file: Option<u32>,
}

// ---------------------------------------------------------------------------
// Regex brace sanitization
// ---------------------------------------------------------------------------

/// Check if `bytes[start]` (which must be `b'{'`) begins a valid repetition
/// quantifier: `{N}`, `{N,}`, or `{N,M}` where N and M are decimal digits.
/// Returns the byte index of the closing `}` if valid.
fn find_valid_repetition(bytes: &[u8], start: usize) -> Option<usize> {
	let len = bytes.len();
	let mut i = start + 1;
	// Must start with at least one digit.
	if i >= len || !bytes[i].is_ascii_digit() {
		return None;
	}
	while i < len && bytes[i].is_ascii_digit() {
		i += 1;
	}
	if i >= len {
		return None;
	}
	if bytes[i] == b'}' {
		return Some(i);
	}
	if bytes[i] != b',' {
		return None;
	}
	i += 1;
	if i >= len {
		return None;
	}
	// After comma: optional digits then `}`.
	while i < len && bytes[i].is_ascii_digit() {
		i += 1;
	}
	if i < len && bytes[i] == b'}' {
		return Some(i);
	}
	None
}

fn find_braced_escape_end(bytes: &[u8], start: usize) -> Option<usize> {
	let mut i = start + 1;
	while i < bytes.len() {
		if bytes[i] == b'}' {
			return Some(i);
		}
		i += 1;
	}
	None
}

/// Escape `{` and `}` that don't form valid repetition quantifiers.
///
/// Patterns like `${platform}` or `a{b}` contain braces the regex engine
/// rejects as malformed repetitions. Since such braces can never be valid
/// regex syntax, turning them into `\{` / `\}` is semantics-preserving
/// and avoids confusing error messages for callers who pass literal text
/// fragments (e.g. JS template strings).
fn sanitize_braces(pattern: &str) -> Cow<'_, str> {
	let bytes = pattern.as_bytes();
	if !bytes.contains(&b'{') && !bytes.contains(&b'}') {
		return Cow::Borrowed(pattern);
	}

	let len = bytes.len();
	let mut result = String::with_capacity(len + 8);
	let mut modified = false;
	let mut i = 0;

	while i < len {
		// Pass escaped characters through unchanged.
		if bytes[i] == b'\\' && i + 1 < len {
			result.push('\\');
			i += 1;
			// The next character is the escaped literal; push it regardless.
			// Safety: index is in bounds (checked above).
			let ch = pattern[i..]
				.chars()
				.next()
				.expect("non-empty slice has a char");
			result.push(ch);
			i += ch.len_utf8();
			if matches!(ch, 'p' | 'P' | 'x' | 'u') && i < len && bytes[i] == b'{' {
				if let Some(end) = find_braced_escape_end(bytes, i) {
					result.push_str(&pattern[i..=end]);
					i = end + 1;
				} else {
					result.push_str(&pattern[i..]);
					i = len;
				}
			}
			continue;
		}

		if bytes[i] == b'{' {
			if let Some(end) = find_valid_repetition(bytes, i) {
				result.push_str(&pattern[i..=end]);
				i = end + 1;
				continue;
			}
			result.push_str("\\{");
			i += 1;
			modified = true;
			continue;
		}

		if bytes[i] == b'}' {
			result.push_str("\\}");
			i += 1;
			modified = true;
			continue;
		}

		let ch = pattern[i..]
			.chars()
			.next()
			.expect("non-empty slice has a char");
		result.push(ch);
		i += ch.len_utf8();
	}

	if modified {
		Cow::Owned(result)
	} else {
		Cow::Borrowed(pattern)
	}
}

/// Escape unescaped parentheses after a group-syntax regex error.
///
/// Search patterns like `fetchAnthropicProvider(` are common literal snippets,
/// but the regex engine parses the trailing `(` as the start of a capture
/// group. When the parser already reported invalid group syntax, escaping any
/// remaining literal parentheses preserves useful search behavior without
/// changing valid regexes.
fn escape_unescaped_parentheses(pattern: &str) -> Cow<'_, str> {
	let bytes = pattern.as_bytes();
	if !bytes.contains(&b'(') && !bytes.contains(&b')') {
		return Cow::Borrowed(pattern);
	}

	let mut result = String::with_capacity(pattern.len() + 4);
	let mut modified = false;
	let mut i = 0;

	while i < bytes.len() {
		if bytes[i] == b'\\' && i + 1 < bytes.len() {
			result.push('\\');
			i += 1;
			let ch = pattern[i..]
				.chars()
				.next()
				.expect("non-empty slice has a char");
			result.push(ch);
			i += ch.len_utf8();
			continue;
		}

		let ch = pattern[i..]
			.chars()
			.next()
			.expect("non-empty slice has a char");
		if matches!(ch, '(' | ')') {
			result.push('\\');
			modified = true;
		}
		result.push(ch);
		i += ch.len_utf8();
	}

	if modified {
		Cow::Owned(result)
	} else {
		Cow::Borrowed(pattern)
	}
}

fn build_regex_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> std::result::Result<grep_regex::RegexMatcher, grep_regex::Error> {
	RegexMatcherBuilder::new()
		.case_insensitive(ignore_case)
		.multi_line(multiline)
		.build(pattern)
}

fn build_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> Result<grep_regex::RegexMatcher> {
	let sanitized = sanitize_braces(pattern);
	match build_regex_matcher(sanitized.as_ref(), ignore_case, multiline) {
		Ok(matcher) => Ok(matcher),
		Err(err) => {
			let message = err.to_string();
			if message.contains("unclosed group") || message.contains("unopened group") {
				let escaped = escape_unescaped_parentheses(sanitized.as_ref());
				if escaped.as_ref() != sanitized.as_ref() {
					return build_regex_matcher(escaped.as_ref(), ignore_case, multiline)
						.map_err(|retry_err| Error::from_reason(format!("Regex error: {retry_err}")));
				}
			}
			Err(Error::from_reason(format!("Regex error: {message}")))
		},
	}
}

// ---------------------------------------------------------------------------
// File / directory search orchestration
// ---------------------------------------------------------------------------
const ORDERED_STREAMING_STOP_MAX_COUNT: u64 = 64;

fn per_file_params(params: SearchParams) -> SearchParams {
	let file_limit = match params.mode {
		OutputMode::Content => {
			let global = params
				.max_count
				.map(|max| max.saturating_add(params.offset));
			match (global, params.max_count_per_file) {
				(Some(global), Some(per_file)) => Some(global.min(per_file)),
				(global, per_file) => global.or(per_file),
			}
		},
		OutputMode::Count => None,
		OutputMode::FilesWithMatches => Some(1),
	};
	SearchParams { max_count: file_limit, offset: 0, ..params }
}

fn streaming_stop_after(params: SearchParams) -> Option<u64> {
	if params.mode != OutputMode::Content || params.offset != 0 {
		return None;
	}
	params.max_count.filter(|max| *max > 0)
}

struct StreamingGrepVisitor<'a> {
	root:               &'a Path,
	matcher:            &'a grep_regex::RegexMatcher,
	glob_set:           Option<&'a GlobSet>,
	type_filter:        Option<&'a TypeFilter>,
	params:             SearchParams,
	searcher:           Searcher,
	results:            Vec<FileSearchResult>,
	shared_results:     Arc<Mutex<Vec<Vec<FileSearchResult>>>>,
	error:              Arc<Mutex<Option<String>>>,
	skipped_oversized:  Arc<AtomicU64>,
	files_searched:     Arc<AtomicU64>,
	stop_after_matches: Option<u64>,
	emitted:            Arc<AtomicU64>,
	ct:                 &'a task::CancelToken,
	visited:            usize,
}

impl Drop for StreamingGrepVisitor<'_> {
	fn drop(&mut self) {
		if self.results.is_empty() {
			return;
		}
		let results = std::mem::take(&mut self.results);
		self
			.shared_results
			.lock()
			.expect("grep result collection lock poisoned")
			.push(results);
	}
}

impl ParallelVisitor for StreamingGrepVisitor<'_> {
	fn visit(&mut self, entry: std::result::Result<ignore::DirEntry, ignore::Error>) -> WalkState {
		if let Some(stop) = self.stop_after_matches
			&& self.emitted.load(Ordering::Relaxed) >= stop
		{
			return WalkState::Quit;
		}
		if self.visited == 0 || self.visited >= 128 {
			self.visited = 0;
			if let Err(err) = self.ct.heartbeat() {
				*self.error.lock().expect("error lock poisoned") = Some(err.to_string());
				return WalkState::Quit;
			}
		}
		self.visited += 1;

		let Ok(entry) = entry else {
			return WalkState::Continue;
		};
		if !entry
			.file_type()
			.is_some_and(|file_type| file_type.is_file())
		{
			return WalkState::Continue;
		}

		let relative = fs_cache::normalize_relative_path(self.root, entry.path());
		if relative.is_empty() {
			return WalkState::Continue;
		}
		if let Some(glob_set) = self.glob_set
			&& !glob_set.is_match(Path::new(relative.as_ref()))
		{
			return WalkState::Continue;
		}
		if let Some(filter) = self.type_filter
			&& !matches_type_filter(entry.path(), filter)
		{
			return WalkState::Continue;
		}

		let bytes = match read_file_bytes(entry.path()) {
			Ok(ReadFile::Bytes(bytes)) => bytes,
			Ok(ReadFile::Oversized) => {
				self.skipped_oversized.fetch_add(1, Ordering::Relaxed);
				return WalkState::Continue;
			},
			Ok(ReadFile::Skipped) | Err(_) => return WalkState::Continue,
		};
		self.files_searched.fetch_add(1, Ordering::Relaxed);
		let search = if self.params.mode == OutputMode::FilesWithMatches {
			let Ok(matched) = self.matcher.is_match(bytes.as_slice()) else {
				return WalkState::Continue;
			};
			SearchResultInternal {
				matches:       Vec::new(),
				match_count:   u64::from(matched),
				collected:     u64::from(matched),
				limit_reached: false,
			}
		} else {
			let Ok(search) =
				run_search_slice(&mut self.searcher, self.matcher, bytes.as_slice(), self.params)
			else {
				return WalkState::Continue;
			};
			search
		};

		if search.match_count == 0 {
			return WalkState::Continue;
		}
		let matched_count = search.match_count;
		// Budget on matches we actually return (post per-file cap), mirroring the
		// sequential path and the aggregator's page accounting. `match_count` can
		// exceed `collected` by one when a file overflows its per-file cap, which
		// would stop the walk short of the requested page.
		let collected = search.collected;
		self.results.push(FileSearchResult {
			relative_path: relative.into_owned(),
			matches:       search.matches,
			match_count:   matched_count,
			limit_reached: search.limit_reached,
		});
		if let Some(stop) = self.stop_after_matches {
			let previous = self.emitted.fetch_add(collected, Ordering::Relaxed);
			if previous.saturating_add(collected) >= stop {
				return WalkState::Quit;
			}
		}
		WalkState::Continue
	}
}

struct StreamingGrepVisitorBuilder<'a> {
	root:               &'a Path,
	matcher:            &'a grep_regex::RegexMatcher,
	glob_set:           Option<&'a GlobSet>,
	type_filter:        Option<&'a TypeFilter>,
	params:             SearchParams,
	shared_results:     Arc<Mutex<Vec<Vec<FileSearchResult>>>>,
	error:              Arc<Mutex<Option<String>>>,
	skipped_oversized:  Arc<AtomicU64>,
	files_searched:     Arc<AtomicU64>,
	stop_after_matches: Option<u64>,
	emitted:            Arc<AtomicU64>,
	ct:                 &'a task::CancelToken,
}

impl<'a> ParallelVisitorBuilder<'a> for StreamingGrepVisitorBuilder<'a> {
	fn build(&mut self) -> Box<dyn ParallelVisitor + 'a> {
		Box::new(StreamingGrepVisitor {
			root:               self.root,
			matcher:            self.matcher,
			glob_set:           self.glob_set,
			type_filter:        self.type_filter,
			params:             self.params,
			searcher:           build_searcher_for_params(self.params),
			results:            Vec::new(),
			shared_results:     Arc::clone(&self.shared_results),
			error:              Arc::clone(&self.error),
			skipped_oversized:  Arc::clone(&self.skipped_oversized),
			files_searched:     Arc::clone(&self.files_searched),
			stop_after_matches: self.stop_after_matches,
			emitted:            Arc::clone(&self.emitted),
			ct:                 self.ct,
			visited:            0,
		})
	}
}

fn run_sequential_grep(
	search_path: &Path,
	matcher: &grep_regex::RegexMatcher,
	glob_set: Option<&GlobSet>,
	type_filter: Option<&TypeFilter>,
	params: SearchParams,
	include_hidden: bool,
	use_gitignore: bool,
	skip_node_modules: bool,
	ct: &task::CancelToken,
	stop_after_matches: Option<u64>,
) -> Result<(Vec<FileSearchResult>, u64, u64)> {
	let builder =
		fs_cache::build_walker(search_path, include_hidden, use_gitignore, skip_node_modules, false);
	let file_params = per_file_params(params);
	let mut searcher = build_searcher_for_params(file_params);
	let mut results = Vec::new();
	let mut skipped_oversized = 0u64;
	let mut files_searched = 0u64;
	let mut visited = 0usize;
	let mut emitted = 0u64;

	ct.heartbeat()?;
	for entry in builder.build() {
		if visited == 0 || visited >= 128 {
			visited = 0;
			ct.heartbeat()?;
		}
		visited += 1;

		let Ok(entry) = entry else {
			continue;
		};
		if !entry
			.file_type()
			.is_some_and(|file_type| file_type.is_file())
		{
			continue;
		}

		let relative = fs_cache::normalize_relative_path(search_path, entry.path());
		if relative.is_empty() {
			continue;
		}
		if let Some(glob_set) = glob_set
			&& !glob_set.is_match(Path::new(relative.as_ref()))
		{
			continue;
		}
		if let Some(filter) = type_filter
			&& !matches_type_filter(entry.path(), filter)
		{
			continue;
		}

		let bytes = match read_file_bytes(entry.path()) {
			Ok(ReadFile::Bytes(bytes)) => bytes,
			Ok(ReadFile::Oversized) => {
				skipped_oversized = skipped_oversized.saturating_add(1);
				continue;
			},
			Ok(ReadFile::Skipped) | Err(_) => continue,
		};
		files_searched = files_searched.saturating_add(1);
		let search = if file_params.mode == OutputMode::FilesWithMatches {
			let Ok(matched) = matcher.is_match(bytes.as_slice()) else {
				continue;
			};
			SearchResultInternal {
				matches:       Vec::new(),
				match_count:   u64::from(matched),
				collected:     u64::from(matched),
				limit_reached: false,
			}
		} else {
			let Ok(search) = run_search_slice(&mut searcher, matcher, bytes.as_slice(), file_params)
			else {
				continue;
			};
			search
		};

		if search.match_count == 0 {
			continue;
		}
		let emitted_in_file = search.collected;
		results.push(FileSearchResult {
			relative_path: relative.into_owned(),
			matches:       search.matches,
			match_count:   search.match_count,
			limit_reached: search.limit_reached,
		});
		if let Some(stop_after_matches) = stop_after_matches {
			emitted = emitted.saturating_add(emitted_in_file);
			if emitted >= stop_after_matches {
				break;
			}
		}
	}

	results.sort_unstable_by(|a, b| a.relative_path.cmp(&b.relative_path));
	Ok((results, skipped_oversized, files_searched))
}

fn run_streaming_grep(
	search_path: &Path,
	matcher: &grep_regex::RegexMatcher,
	glob_set: Option<&GlobSet>,
	type_filter: Option<&TypeFilter>,
	params: SearchParams,
	include_hidden: bool,
	use_gitignore: bool,
	skip_node_modules: bool,
	ct: &task::CancelToken,
) -> Result<(Vec<FileSearchResult>, u64, u64)> {
	let (_active_guard, active_greps) = ActiveStreamingGrep::enter();
	let workers = fs_cache::grep_workers();
	let stop_after_matches = streaming_stop_after(params);
	let small_budget = stop_after_matches.is_some_and(|max| max <= ORDERED_STREAMING_STOP_MAX_COUNT);
	// Sequential path: forced workers, contended pool, or a small first-page
	// budget where strict path-order matters. The parallel path below also
	// honors `stop_after_matches`, so larger budgets bound work without losing
	// parallelism.
	if workers == 1 || small_budget || (workers > 1 && active_greps > 1) {
		return run_sequential_grep(
			search_path,
			matcher,
			glob_set,
			type_filter,
			params,
			include_hidden,
			use_gitignore,
			skip_node_modules,
			ct,
			stop_after_matches,
		);
	}
	let file_params = per_file_params(params);
	let mut builder =
		fs_cache::build_walker(search_path, include_hidden, use_gitignore, skip_node_modules, false);
	if workers > 0 {
		builder.threads(workers);
	}
	let shared_results = Arc::new(Mutex::new(Vec::new()));
	let error = Arc::new(Mutex::new(None));
	let skipped_oversized = Arc::new(AtomicU64::new(0));
	let files_searched = Arc::new(AtomicU64::new(0));
	let emitted = Arc::new(AtomicU64::new(0));
	let mut visitor_builder = StreamingGrepVisitorBuilder {
		root: search_path,
		matcher,
		glob_set,
		type_filter,
		params: file_params,
		shared_results: Arc::clone(&shared_results),
		error: Arc::clone(&error),
		skipped_oversized: Arc::clone(&skipped_oversized),
		files_searched: Arc::clone(&files_searched),
		stop_after_matches,
		emitted: Arc::clone(&emitted),
		ct,
	};
	ct.heartbeat()?;
	builder.build_parallel().visit(&mut visitor_builder);

	let walk_error = error.lock().expect("error lock poisoned").take();
	if let Some(error) = walk_error {
		return Err(Error::from_reason(error));
	}

	let mut results: Vec<FileSearchResult> = shared_results
		.lock()
		.expect("grep result collection lock poisoned")
		.drain(..)
		.flatten()
		.collect();
	results.sort_unstable_by(|a, b| a.relative_path.cmp(&b.relative_path));
	Ok((results, skipped_oversized.load(Ordering::Relaxed), files_searched.load(Ordering::Relaxed)))
}

fn push_count_match(matches: &mut Vec<GrepMatch>, path: String, match_count: u64) {
	matches.push(GrepMatch {
		path,
		line_number: 0,
		line: String::new(),
		context_before: None,
		context_after: None,
		truncated: None,
		match_count: Some(crate::utils::clamp_u32(match_count)),
	});
}

fn push_file_match(matches: &mut Vec<GrepMatch>, path: String) {
	matches.push(GrepMatch {
		path,
		line_number: 0,
		line: String::new(),
		context_before: None,
		context_after: None,
		truncated: None,
		match_count: None,
	});
}

fn aggregate_parallel_results(
	results: Vec<FileSearchResult>,
	params: SearchParams,
	files_searched: u64,
) -> (Vec<GrepMatch>, u64, u32, u32, bool) {
	let SearchParams { mode, max_count, offset, .. } = params;
	let mut matches = Vec::new();
	let mut total_matches = 0u64;
	let mut files_with_matches = 0u32;
	let files_searched = crate::utils::clamp_u32(files_searched);
	let mut skipped = 0u64;
	let mut emitted = 0u64;
	let mut limit_reached = false;

	for result in results {
		if result.match_count == 0 {
			continue;
		}

		let file_match_start = total_matches;
		let file_match_count = result.match_count;
		files_with_matches = files_with_matches.saturating_add(1);
		total_matches = total_matches.saturating_add(file_match_count);

		match mode {
			OutputMode::Content => {
				let mut selected_matches = Vec::new();
				for matched in result.matches {
					if skipped < offset {
						skipped += 1;
						continue;
					}
					if let Some(max) = max_count
						&& emitted >= max
					{
						limit_reached = true;
						break;
					}
					selected_matches.push(matched);
					emitted += 1;
				}
				if !selected_matches.is_empty() {
					push_content_matches(&mut matches, result.relative_path, selected_matches);
				}
				if result.limit_reached && skipped >= offset {
					limit_reached = true;
				}
			},
			OutputMode::Count => {
				let skipped_in_file = offset
					.saturating_sub(file_match_start)
					.min(file_match_count);
				let available = file_match_count.saturating_sub(skipped_in_file);
				if available == 0 {
					continue;
				}
				if let Some(max) = max_count
					&& emitted >= max
				{
					limit_reached = true;
					continue;
				}
				let remaining = max_count.map_or(available, |max| max.saturating_sub(emitted));
				if remaining == 0 {
					limit_reached = true;
					continue;
				}
				push_count_match(&mut matches, result.relative_path, result.match_count);
				let selected = available.min(remaining);
				emitted = emitted.saturating_add(selected);
				if selected < available {
					limit_reached = true;
				}
			},
			OutputMode::FilesWithMatches => {
				if skipped < offset {
					skipped += 1;
					continue;
				}
				if let Some(max) = max_count
					&& emitted >= max
				{
					limit_reached = true;
					continue;
				}
				push_file_match(&mut matches, result.relative_path);
				emitted += 1;
			},
		}
	}

	if let Some(max) = max_count
		&& emitted >= max
	{
		limit_reached = true;
	}

	if max_count == Some(0) {
		limit_reached = files_with_matches > 0;
	}

	(matches, total_matches, files_with_matches, files_searched, limit_reached)
}

// ---------------------------------------------------------------------------
// Sync entry points
// ---------------------------------------------------------------------------

fn search_sync(content: &[u8], options: SearchOptions) -> SearchResult {
	let ignore_case = options.ignore_case.unwrap_or(false);
	let multiline = options.multiline.unwrap_or(false);
	let mode = parse_output_mode(options.mode);
	let matcher = match build_matcher(&options.pattern, ignore_case, multiline) {
		Ok(matcher) => matcher,
		Err(err) => return empty_search_result(Some(err.to_string())),
	};

	let (context_before, context_after) =
		resolve_context(options.context, options.context_before, options.context_after);
	let max_columns = options.max_columns;
	let max_count = options.max_count.map(u64::from);
	let offset = options.offset.unwrap_or(0) as u64;
	let params = SearchParams {
		context_before,
		context_after,
		max_columns,
		mode,
		max_count,
		max_count_per_file: None,
		offset,
		multiline,
	};
	let result = match run_search(&matcher, content, params) {
		Ok(result) => result,
		Err(err) => return empty_search_result(Some(err.to_string())),
	};

	SearchResult {
		matches:       result.matches.into_iter().map(to_public_match).collect(),
		match_count:   crate::utils::clamp_u32(result.match_count),
		limit_reached: result.limit_reached,
		error:         None,
	}
}

fn grep_sync(
	options: GrepConfig,
	on_match: Option<&ThreadsafeFunction<GrepMatch>>,
	ct: task::CancelToken,
) -> Result<GrepResult> {
	let search_path = resolve_search_path(&options.path)?;
	let metadata = std::fs::metadata(&search_path)
		.map_err(|err| Error::from_reason(format!("Path not found: {err}")))?;
	let ignore_case = options.ignore_case.unwrap_or(false);
	let multiline = options.multiline.unwrap_or(false);
	let output_mode = parse_output_mode(options.mode);
	let matcher = build_matcher(&options.pattern, ignore_case, multiline)?;

	let (context_before, context_after) =
		resolve_context(options.context, options.context_before, options.context_after);
	let (context_before, context_after) = if output_mode == OutputMode::Content {
		(context_before, context_after)
	} else {
		(0, 0)
	};
	let max_columns = options.max_columns;
	let max_count = options.max_count.map(u64::from);
	let offset = options.offset.unwrap_or(0) as u64;
	let include_hidden = options.hidden.unwrap_or(true);
	let use_gitignore = options.gitignore.unwrap_or(true);
	let glob_set = glob_util::try_compile_glob(options.glob.as_deref(), true)?;
	let type_filter = resolve_type_filter(options.type_filter.as_deref());

	let params = SearchParams {
		context_before,
		context_after,
		max_columns,
		mode: output_mode,
		max_count,
		max_count_per_file: options.max_count_per_file.map(u64::from),
		offset,
		multiline,
	};

	if !metadata.is_file() && !metadata.is_dir() {
		return Ok(GrepResult {
			matches:            Vec::new(),
			total_matches:      0,
			files_with_matches: 0,
			files_searched:     0,
			limit_reached:      None,
			skipped_oversized:  None,
		});
	}

	if metadata.is_file() {
		if let Some(filter) = type_filter.as_ref()
			&& !matches_type_filter(&search_path, filter)
		{
			return Ok(GrepResult {
				matches:            Vec::new(),
				total_matches:      0,
				files_with_matches: 0,
				files_searched:     0,
				limit_reached:      None,
				skipped_oversized:  None,
			});
		}

		let bytes = match read_file_bytes(&search_path) {
			Ok(ReadFile::Bytes(bytes)) => bytes,
			Ok(ReadFile::Oversized) => {
				return Ok(GrepResult {
					matches:            Vec::new(),
					total_matches:      0,
					files_with_matches: 0,
					files_searched:     0,
					limit_reached:      None,
					skipped_oversized:  Some(1),
				});
			},
			Ok(ReadFile::Skipped) | Err(_) => {
				return Ok(GrepResult {
					matches:            Vec::new(),
					total_matches:      0,
					files_with_matches: 0,
					files_searched:     0,
					limit_reached:      None,
					skipped_oversized:  None,
				});
			},
		};

		if output_mode == OutputMode::FilesWithMatches && max_count.is_none() && offset == 0 {
			let matched = matcher
				.is_match(bytes.as_slice())
				.map_err(|err| Error::from_reason(format!("Search failed: {err}")))?;
			if !matched {
				return Ok(GrepResult {
					matches:            Vec::new(),
					total_matches:      0,
					files_with_matches: 0,
					files_searched:     1,
					limit_reached:      None,
					skipped_oversized:  None,
				});
			}

			let path_string = search_path.to_string_lossy().into_owned();
			return Ok(GrepResult {
				matches:            vec![GrepMatch {
					path:           path_string,
					line_number:    0,
					line:           String::new(),
					context_before: None,
					context_after:  None,
					truncated:      None,
					match_count:    None,
				}],
				total_matches:      1,
				files_with_matches: 1,
				files_searched:     1,
				limit_reached:      None,
				skipped_oversized:  None,
			});
		}

		let search = run_search(&matcher, bytes.as_slice(), params)
			.map_err(|err| Error::from_reason(format!("Search failed: {err}")))?;

		if search.match_count == 0 {
			return Ok(GrepResult {
				matches:            Vec::new(),
				total_matches:      0,
				files_with_matches: 0,
				files_searched:     1,
				limit_reached:      None,
				skipped_oversized:  None,
			});
		}

		let path_string = search_path.to_string_lossy().into_owned();
		let mut matches = Vec::new();
		match output_mode {
			OutputMode::Content => {
				push_content_matches(&mut matches, path_string, search.matches);
			},
			OutputMode::Count => {
				matches.push(GrepMatch {
					path:           path_string,
					line_number:    0,
					line:           String::new(),
					context_before: None,
					context_after:  None,
					truncated:      None,
					match_count:    Some(crate::utils::clamp_u32(search.match_count)),
				});
			},
			OutputMode::FilesWithMatches => {
				matches.push(GrepMatch {
					path:           path_string,
					line_number:    0,
					line:           String::new(),
					context_before: None,
					context_after:  None,
					truncated:      None,
					match_count:    None,
				});
			},
		}

		let limit_reached =
			search.limit_reached || max_count.is_some_and(|max| search.collected >= max);

		return Ok(GrepResult {
			matches,
			total_matches: crate::utils::clamp_u32(search.match_count),
			files_with_matches: 1,
			files_searched: 1,
			limit_reached: if limit_reached { Some(true) } else { None },
			skipped_oversized: None,
		});
	}

	let mentions_node_modules = options
		.glob
		.as_deref()
		.is_some_and(|g| g.contains("node_modules"));
	let results = run_streaming_grep(
		&search_path,
		&matcher,
		glob_set.as_ref(),
		type_filter.as_ref(),
		params,
		include_hidden,
		use_gitignore,
		!mentions_node_modules,
		&ct,
	)?;
	let (results, skipped_oversized, files_searched) = results;
	let (matches, total_matches, files_with_matches, files_searched, limit_reached) =
		aggregate_parallel_results(results, params, files_searched);

	// Fire callbacks after aggregation so offset/limit semantics match returned
	// results.
	if let Some(callback) = on_match {
		for grep_match in &matches {
			callback.call(Ok(grep_match.clone()), ThreadsafeFunctionCallMode::NonBlocking);
		}
	}

	Ok(GrepResult {
		matches,
		total_matches: crate::utils::clamp_u32(total_matches),
		files_with_matches,
		files_searched,
		limit_reached: if limit_reached { Some(true) } else { None },
		skipped_oversized: if skipped_oversized > 0 {
			Some(crate::utils::clamp_u32(skipped_oversized))
		} else {
			None
		},
	})
}

// ---------------------------------------------------------------------------
// N-API exports
// ---------------------------------------------------------------------------

/// Search content for a pattern (one-shot, compiles pattern each time).
/// For repeated searches with the same pattern, use [`grep`] with file filters.
///
/// # Arguments
/// - `content`: `Uint8Array`/`Buffer` (zero-copy) or `string` (UTF-8).
/// - `options`: Regex settings, context, and output mode.
///
/// # Returns
/// Match list plus counts/limit status; errors are surfaced in `error`.
#[napi]
pub fn search(content: Either<JsString, Uint8Array>, options: SearchOptions) -> SearchResult {
	match &content {
		Either::A(js_str) => {
			let utf8 = match js_str.into_utf8() {
				Ok(utf8) => utf8,
				Err(err) => return empty_search_result(Some(err.to_string())),
			};
			search_sync(utf8.as_slice(), options)
		},
		Either::B(buf) => search_sync(buf.as_ref(), options),
	}
}

/// Quick check if content matches a pattern.
///
/// # Arguments
/// - `content`: `Uint8Array`/`Buffer` (zero-copy) or `string` (UTF-8).
/// - `pattern`: `Uint8Array`/`Buffer` (zero-copy) or `string` (UTF-8).
/// - `ignore_case`: Case-insensitive matching.
/// - `multiline`: Enable multiline regex mode.
///
/// # Returns
/// True if any match exists; false on no match.
#[napi]
pub fn has_match(
	content: Either<JsString, Uint8Array>,
	pattern: Either<JsString, Uint8Array>,
	ignore_case: Option<bool>,
	multiline: Option<bool>,
) -> Result<bool> {
	// Hold JsStringUtf8 on the stack and borrow - no copy
	let content_utf8;
	let content_slice: &[u8] = match &content {
		Either::A(js_str) => {
			content_utf8 = js_str.into_utf8()?;
			content_utf8.as_slice()
		},
		Either::B(buf) => buf.as_ref(),
	};

	let pattern_utf8;
	let pattern_string;
	let pattern_ref: &str = match &pattern {
		Either::A(js_str) => {
			pattern_utf8 = js_str.into_utf8()?;
			pattern_utf8.as_str()?
		},
		Either::B(buf) => {
			pattern_string = std::str::from_utf8(buf.as_ref())
				.map_err(|err| Error::from_reason(format!("Invalid UTF-8 in pattern: {err}")))?
				.to_owned();
			&pattern_string
		},
	};

	let matcher =
		build_matcher(pattern_ref, ignore_case.unwrap_or(false), multiline.unwrap_or(false))?;
	Ok(matcher.is_match(content_slice).unwrap_or(false))
}

/// Search files for a regex pattern.
///
/// # Arguments
/// - `options`: Pattern, path, filters, and output mode.
/// - `on_match`: Optional callback invoked per match/result.
///
/// # Returns
/// Aggregated results across matching files.
#[napi]
pub fn grep(
	options: GrepOptions<'_>,
	#[napi(ts_arg_type = "((error: Error | null, match: GrepMatch) => void) | undefined | null")]
	on_match: Option<ThreadsafeFunction<GrepMatch>>,
) -> task::Promise<GrepResult> {
	let GrepOptions {
		pattern,
		path,
		glob,
		r#type,
		ignore_case,
		multiline,
		hidden,
		gitignore,
		max_count,
		offset,
		context_before,
		context_after,
		context,
		max_columns,
		mode,
		max_count_per_file,
		timeout_ms,
		signal,
	} = options;

	let config = GrepConfig {
		pattern,
		path,
		glob,
		type_filter: r#type,
		ignore_case,
		multiline,
		hidden,
		gitignore,
		max_count,
		max_count_per_file,
		offset,
		context_before,
		context_after,
		context,
		max_columns,
		mode,
	};
	let ct = task::CancelToken::new(timeout_ms, signal);
	task::blocking("grep", ct, move |ct| grep_sync(config, on_match.as_ref(), ct))
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::{ffi::CString, os::unix::ffi::OsStrExt};
	#[cfg(unix)]
	use std::{
		fs,
		path::{Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	#[cfg(unix)]
	use super::{GrepConfig, GrepOutputMode, grep_sync};
	use super::{escape_unescaped_parentheses, sanitize_braces};
	#[cfg(unix)]
	use crate::task;

	#[cfg(unix)]
	struct TempDirGuard(PathBuf);

	#[cfg(unix)]
	impl TempDirGuard {
		fn new() -> Self {
			static COUNTER: AtomicU64 = AtomicU64::new(0);
			let nanos = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time is after UNIX_EPOCH")
				.as_nanos();
			let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
			let pid = std::process::id();
			let path = std::env::temp_dir().join(format!("pi-grep-test-{pid}-{nanos}-{seq}"));
			fs::create_dir_all(&path).expect("create temp test directory");
			Self(path)
		}

		fn path(&self) -> &Path {
			&self.0
		}
	}

	#[cfg(unix)]
	impl Drop for TempDirGuard {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	#[cfg(unix)]
	fn write_file(path: &Path, content: &str) {
		if let Some(parent) = path.parent() {
			fs::create_dir_all(parent).expect("create parent directories for test file");
		}
		fs::write(path, content).expect("write test file");
	}

	#[cfg(unix)]
	fn make_fifo(path: &Path) {
		let fifo_path =
			CString::new(path.as_os_str().as_bytes()).expect("fifo path has no NUL bytes");
		// SAFETY: `fifo_path` is a valid CString (NUL-terminated, no interior NULs),
		// so `as_ptr()` yields a valid C string pointer. `0o600` is a valid mode.
		// The CString is alive for the duration of the call.
		let rc = unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) };
		assert_eq!(rc, 0, "create fifo: {}", std::io::Error::last_os_error());
	}

	#[cfg(unix)]
	fn base_grep_config(path: &Path) -> GrepConfig {
		GrepConfig {
			pattern:            "needle".to_string(),
			path:               path.to_string_lossy().into_owned(),
			glob:               None,
			type_filter:        None,
			ignore_case:        None,
			multiline:          None,
			hidden:             None,
			gitignore:          Some(false),
			max_count:          None,
			offset:             None,
			context_before:     None,
			context_after:      None,
			context:            None,
			max_columns:        None,
			mode:               None,
			max_count_per_file: None,
		}
	}

	#[test]
	fn preserves_unicode_property_escapes() {
		assert_eq!(sanitize_braces(r"\p{Greek}").as_ref(), r"\p{Greek}");
	}

	#[test]
	fn preserves_hex_brace_escapes() {
		assert_eq!(sanitize_braces(r"\x{41}").as_ref(), r"\x{41}");
	}

	#[test]
	fn preserves_malformed_braced_escapes() {
		assert_eq!(sanitize_braces(r"\p{Greek").as_ref(), r"\p{Greek");
	}

	#[test]
	fn escapes_non_quantifier_braces() {
		assert_eq!(sanitize_braces("${platform}").as_ref(), "$\\{platform\\}");
	}

	#[test]
	fn preserves_valid_quantifiers() {
		assert_eq!(sanitize_braces("a{2,4}").as_ref(), "a{2,4}");
	}

	#[test]
	fn preserves_escaped_parentheses() {
		assert_eq!(escape_unescaped_parentheses(r"foo\(bar\)").as_ref(), r"foo\(bar\)");
	}

	#[test]
	fn escapes_literal_parentheses() {
		assert_eq!(
			escape_unescaped_parentheses("fetchAnthropicProvider(").as_ref(),
			r"fetchAnthropicProvider\("
		);
		assert_eq!(
			escape_unescaped_parentheses("fetchAnthropicProvider()").as_ref(),
			r"fetchAnthropicProvider\(\)"
		);
	}

	#[cfg(unix)]
	#[test]
	fn grep_directory_skips_fifo_entries() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("regular.txt"), "needle\n");
		make_fifo(&root.path().join("skip-me.fifo"));

		let result = grep_sync(base_grep_config(root.path()), None, task::CancelToken::default())
			.expect("directory grep should succeed");

		assert_eq!(result.total_matches, 1);
		assert_eq!(result.files_with_matches, 1);
		assert_eq!(result.files_searched, 1);
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, "regular.txt");
	}

	#[cfg(unix)]
	#[test]
	fn grep_directory_counts_searched_files_without_storing_no_match_results() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("a.txt"), "needle\n");
		write_file(&root.path().join("b.txt"), "haystack\n");

		let result = grep_sync(base_grep_config(root.path()), None, task::CancelToken::default())
			.expect("directory grep should succeed");

		assert_eq!(result.total_matches, 1);
		assert_eq!(result.files_with_matches, 1);
		assert_eq!(result.files_searched, 2);
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, "a.txt");
	}

	#[cfg(unix)]
	#[test]
	fn grep_files_with_matches_counts_all_searched_files_when_none_match() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("a.txt"), "haystack a\n");
		write_file(&root.path().join("b.txt"), "haystack b\n");

		let mut config = base_grep_config(root.path());
		config.mode = Some(GrepOutputMode::FilesWithMatches);

		let result = grep_sync(config, None, task::CancelToken::default())
			.expect("directory grep should succeed");

		assert_eq!(result.total_matches, 0);
		assert_eq!(result.files_with_matches, 0);
		assert_eq!(result.files_searched, 2);
		assert!(result.matches.is_empty());
	}

	#[cfg(unix)]
	#[test]
	fn grep_directory_applies_offset_and_limit_in_walker_order() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("a.txt"), "needle a1\nneedle a2\n");
		write_file(&root.path().join("b.txt"), "needle b1\n");
		write_file(&root.path().join("c.txt"), "haystack\n");

		let mut config = base_grep_config(root.path());
		config.max_count = Some(2);
		config.offset = Some(1);

		let result = grep_sync(config, None, task::CancelToken::default())
			.expect("directory grep should succeed");

		assert_eq!(result.total_matches, 3);
		assert_eq!(result.files_with_matches, 2);
		assert_eq!(result.limit_reached, Some(true));
		assert_eq!(result.matches.len(), 2);
		assert_eq!(result.matches[0].path, "a.txt");
		assert_eq!(result.matches[0].line, "needle a2");
		assert_eq!(result.matches[1].path, "b.txt");
		assert_eq!(result.matches[1].line, "needle b1");
	}

	#[cfg(unix)]
	#[test]
	fn grep_count_mode_limit_applies_to_matches_not_files() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("a.txt"), "needle a1\nneedle a2\n");
		write_file(&root.path().join("b.txt"), "needle b1\n");

		let mut config = base_grep_config(root.path());
		config.mode = Some(GrepOutputMode::Count);
		config.max_count = Some(2);

		let result = grep_sync(config, None, task::CancelToken::default())
			.expect("directory grep should succeed");

		assert_eq!(result.total_matches, 3);
		assert_eq!(result.files_with_matches, 2);
		assert_eq!(result.limit_reached, Some(true));
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, "a.txt");
		assert_eq!(result.matches[0].match_count, Some(2));
	}

	#[cfg(unix)]
	#[test]
	fn grep_streaming_respects_pre_cancelled_token() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("regular.txt"), "needle\n");

		let ct = task::CancelToken::new(Some(0), None);
		std::thread::sleep(Duration::from_millis(1));
		let result = grep_sync(base_grep_config(root.path()), None, ct);

		let Err(err) = result else {
			panic!("pre-cancelled grep should fail before returning matches");
		};
		assert!(
			err.to_string().contains("Timeout"),
			"expected timeout cancellation error, got: {err}"
		);
	}

	#[cfg(unix)]
	#[test]
	fn grep_special_root_path_returns_empty_result() {
		let root = TempDirGuard::new();
		let fifo = root.path().join("direct.fifo");
		make_fifo(&fifo);

		let result = grep_sync(base_grep_config(&fifo), None, task::CancelToken::default())
			.expect("special-file grep should return an empty result");

		assert!(result.matches.is_empty());
		assert_eq!(result.total_matches, 0);
		assert_eq!(result.files_with_matches, 0);
		assert_eq!(result.files_searched, 0);
		assert_eq!(result.limit_reached, None);
	}

	#[cfg(unix)]
	#[test]
	fn grep_multiline_matches_cross_line_patterns() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("code.txt"), "fn foo() {\n  return 1;\n}\n");

		let mut config = base_grep_config(root.path());
		config.pattern = r"foo\(\) \{\n  return".to_string();
		config.multiline = Some(true);

		let result = grep_sync(config, None, task::CancelToken::default())
			.expect("multiline grep should succeed");

		assert_eq!(result.total_matches, 1, "cross-line pattern should match across lines");
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, "code.txt");
		assert_eq!(result.matches[0].line_number, 1);
	}

	#[cfg(unix)]
	#[test]
	fn grep_per_file_max_count_preserves_file_diversity() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("a.txt"), "needle 1\nneedle 2\nneedle 3\nneedle 4\nneedle 5\n");
		write_file(&root.path().join("z.txt"), "needle z\n");

		let mut config = base_grep_config(root.path());
		config.max_count = Some(4);
		config.max_count_per_file = Some(2);

		let result = grep_sync(config, None, task::CancelToken::default())
			.expect("directory grep should succeed");

		let paths: Vec<&str> = result
			.matches
			.iter()
			.map(|matched| matched.path.as_str())
			.collect();
		assert_eq!(paths, ["a.txt", "a.txt", "z.txt"], "hot file must not starve later files");
		assert_eq!(result.files_with_matches, 2);
		assert_eq!(result.limit_reached, Some(true));
	}

	#[cfg(unix)]
	fn content_search_params(
		max_count: u64,
		max_count_per_file: Option<u64>,
	) -> super::SearchParams {
		super::SearchParams {
			context_before: 0,
			context_after: 0,
			max_columns: None,
			mode: super::OutputMode::Content,
			max_count: Some(max_count),
			max_count_per_file,
			offset: 0,
			multiline: false,
		}
	}

	#[cfg(unix)]
	#[test]
	fn streaming_grep_stops_after_first_page_content_budget() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("a.txt"), "needle a1\nneedle a2\n");
		write_file(&root.path().join("z.txt"), "needle z\n");
		let matcher = super::build_matcher("needle", false, false).expect("build test matcher");
		let params = content_search_params(1, None);

		let (results, skipped_oversized, files_searched) = super::run_streaming_grep(
			root.path(),
			&matcher,
			None,
			None,
			params,
			true,
			false,
			true,
			&task::CancelToken::default(),
		)
		.expect("streaming grep should succeed");

		assert_eq!(skipped_oversized, 0);
		assert_eq!(files_searched, 1);
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].matches.len(), 1);
		assert_eq!(results[0].relative_path, "a.txt");
	}

	#[cfg(unix)]
	#[test]
	fn streaming_grep_budget_counts_returned_matches_under_per_file_cap() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("a.txt"), "needle a1\nneedle a2\n");
		write_file(&root.path().join("b.txt"), "needle b1\nneedle b2\n");
		write_file(&root.path().join("c.txt"), "needle c1\nneedle c2\n");
		let matcher = super::build_matcher("needle", false, false).expect("build test matcher");
		let params = content_search_params(3, Some(1));

		let (results, skipped_oversized, files_searched) = super::run_streaming_grep(
			root.path(),
			&matcher,
			None,
			None,
			params,
			true,
			false,
			true,
			&task::CancelToken::default(),
		)
		.expect("streaming grep should succeed");

		assert_eq!(skipped_oversized, 0);
		assert_eq!(files_searched, 3);
		assert_eq!(results.len(), 3);
		assert_eq!(
			results
				.iter()
				.map(|result| result.matches.len())
				.sum::<usize>(),
			3
		);
	}

	#[cfg(unix)]
	#[test]
	fn streaming_grep_quits_parallel_after_large_budget() {
		let root = TempDirGuard::new();
		let budget = super::ORDERED_STREAMING_STOP_MAX_COUNT + 1;
		let file_count = (budget * 3) as usize;
		for index in 0..file_count {
			write_file(&root.path().join(format!("{index:05}.txt")), "needle\n");
		}
		let matcher = super::build_matcher("needle", false, false).expect("build test matcher");
		let params = content_search_params(budget, None);

		let (results, skipped_oversized, files_searched) = super::run_streaming_grep(
			root.path(),
			&matcher,
			None,
			None,
			params,
			true,
			false,
			true,
			&task::CancelToken::default(),
		)
		.expect("streaming grep should succeed");

		assert_eq!(skipped_oversized, 0);
		// The parallel walker honors the budget; tail-race may produce up to one
		// extra file per worker, but it must not scan the whole tree.
		assert!(
			files_searched < file_count as u64,
			"expected early stop, scanned {files_searched} of {file_count} files",
		);
		assert!(
			results.len() < file_count,
			"expected early stop, collected {} of {file_count} files",
			results.len(),
		);
	}
}
