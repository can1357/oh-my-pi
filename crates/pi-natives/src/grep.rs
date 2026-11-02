//! Regex search exported via N-API.
//!
//! Provides two layers:
//! - `search()` for in-memory content search.
//! - `grep()` for filesystem search with glob/type filtering.
//!
//! `pi_walker::grep` owns compilation, scanning, walking, and result selection;
//! this module decodes options and converts results.

use std::{path::Path, sync::Arc};

use grep_matcher::Matcher;
use napi::{
	JsString,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
use pi_vfs::Fs;
use pi_walker::grep::Engine;
use tokio::sync::mpsc;

use crate::{shell::vfs::ShellFilesystem, task, utils::clamp_u32};

/// Maximum batches queued between the search and the `onMatches` forwarder.
const GREP_STREAM_QUEUE: usize = 4;
/// Most matches handed to one `onMatches` call.
const STREAM_BATCH: usize = 1024;

/// `onMatches` callback, called without the error-first slot.
type GrepStreamCallback =
	ThreadsafeFunction<Vec<GrepMatch>, UnknownReturnValue, Vec<GrepMatch>, Status, false, false>;

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
#[napi(object, object_to_js = false)]
pub struct GrepOptions<'env> {
	/// Regex pattern to search for.
	pub pattern:            String,
	/// Directory or file to search: a host path or an absolute `scheme://` URL.
	pub path:               String,
	/// Glob filter for file paths (e.g., "*.ts"); a matched directory selects
	/// every file under it.
	pub glob:               Option<String>,
	/// Glob patterns of files and directories to leave out, relative to `path`:
	/// one without `/` matches at any depth (`*.test.ts`, `vendor`), a leading
	/// `/` anchors it to `path` (`/vendor`); a matched directory is not
	/// searched.
	pub exclude:            Option<Vec<String>>,
	/// Match simple glob patterns at any depth (default: true; `*.ts` ->
	/// `**/*.ts`). Set false when `glob` is already relative to `path`.
	pub recursive:          Option<bool>,
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
	/// Filesystem every path is stat'ed, walked, and read through (native when
	/// absent).
	pub filesystem:         Option<ShellFilesystem>,
	/// Stream results instead of returning them: called on the JS thread with
	/// batches (at most 1024 entries, files in no particular order) of what
	/// `matches` would hold, while the search runs. A slow callback pauses the
	/// search instead of buffering. Successful completion waits for every
	/// callback and carries counts with empty `matches`; cancellation also
	/// interrupts delivery waits, though already queued callbacks may still run.
	/// A throw rejects the search with it. Incompatible with `maxCount` and
	/// `offset`.
	#[napi(ts_type = "(matches: GrepMatch[]) => void")]
	pub on_matches:         Option<GrepStreamCallback>,
}

/// A context line (before or after a match).
#[derive(Clone, Debug)]
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
	/// 1-indexed character column where the first match on a truncated line
	/// starts; the truncated `line` shows a window around it.
	pub column:         Option<u32>,
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
	/// 1-indexed character column where the first match on a truncated line
	/// starts; the truncated `line` shows a window around it.
	pub column:         Option<u32>,
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

const fn to_mode(mode: Option<GrepOutputMode>) -> pi_walker::grep::Mode {
	match mode {
		None | Some(GrepOutputMode::Content) => pi_walker::grep::Mode::Content,
		Some(GrepOutputMode::Count) => pi_walker::grep::Mode::Count,
		Some(GrepOutputMode::FilesWithMatches) => pi_walker::grep::Mode::FilesWithMatches,
	}
}

/// Legacy `context` applies only when neither `contextBefore` nor
/// `contextAfter` is given.
fn resolve_context(
	context: Option<u32>,
	context_before: Option<u32>,
	context_after: Option<u32>,
) -> (usize, usize) {
	let (before, after) = if context_before.is_some() || context_after.is_some() {
		(context_before.unwrap_or(0), context_after.unwrap_or(0))
	} else {
		let value = context.unwrap_or(0);
		(value, value)
	};
	(before as usize, after as usize)
}

fn to_context_lines(lines: Vec<pi_walker::grep::ContextLine>) -> Option<Vec<ContextLine>> {
	(!lines.is_empty()).then(|| {
		lines
			.into_iter()
			.map(|line| ContextLine { line_number: clamp_u32(line.line), line: line.text })
			.collect()
	})
}

impl From<pi_walker::grep::Match> for Match {
	fn from(matched: pi_walker::grep::Match) -> Self {
		Self {
			line_number:    clamp_u32(matched.line),
			line:           matched.text,
			context_before: to_context_lines(matched.before),
			context_after:  to_context_lines(matched.after),
			truncated:      matched.truncated.then_some(true),
			column:         matched.column,
		}
	}
}

impl From<pi_walker::grep::Match> for GrepMatch {
	fn from(matched: pi_walker::grep::Match) -> Self {
		Self {
			path:           matched.path,
			line_number:    clamp_u32(matched.line),
			line:           matched.text,
			context_before: to_context_lines(matched.before),
			context_after:  to_context_lines(matched.after),
			truncated:      matched.truncated.then_some(true),
			column:         matched.column,
			match_count:    matched.count.map(clamp_u32),
		}
	}
}

const fn empty_search_result(error: Option<String>) -> SearchResult {
	SearchResult { matches: Vec::new(), match_count: 0, limit_reached: false, error }
}

fn search_sync(content: &[u8], options: SearchOptions) -> SearchResult {
	let multiline = options.multiline.unwrap_or(false);
	let engine =
		match Engine::compile(&options.pattern, options.ignore_case.unwrap_or(false), multiline) {
			Ok(engine) => engine,
			Err(err) => return empty_search_result(Some(Error::from_reason(err).to_string())),
		};
	let (before, after) =
		resolve_context(options.context, options.context_before, options.context_after);
	let opts = pi_walker::grep::SearchOptions {
		multiline,
		mode: to_mode(options.mode),
		before,
		after,
		max_columns: options.max_columns.map(|value| value as usize),
		offset: options.offset.map_or(0, u64::from),
		max_count: options.max_count.map(u64::from),
	};
	match pi_walker::grep::search(&engine, content, &opts) {
		Ok(result) => SearchResult {
			matches:       result.matches.into_iter().map(Match::from).collect(),
			match_count:   clamp_u32(result.match_count),
			limit_reached: result.limit_reached,
			error:         None,
		},
		Err(err) => empty_search_result(Some(err)),
	}
}

/// Decoded [`GrepOptions`] that cross into the filesystem worker.
struct GrepRequest {
	pattern:            String,
	path:               String,
	ignore_case:        bool,
	multiline:          bool,
	glob:               Option<String>,
	exclude:            Vec<String>,
	recursive:          bool,
	file_type:          Option<String>,
	mode:               pi_walker::grep::Mode,
	before:             usize,
	after:              usize,
	max_columns:        Option<usize>,
	offset:             u64,
	max_count:          Option<u64>,
	max_count_per_file: Option<u64>,
	hidden:             bool,
	gitignore:          bool,
}

/// Forward each streamed batch to `onMatches`, awaiting the JS call so the
/// callback's pace back-pressures the search.
async fn forward_matches(
	callback: GrepStreamCallback,
	mut batches: mpsc::Receiver<Vec<pi_walker::grep::Match>>,
) -> Result<()> {
	// Per-file batches already queued ride along in one call, up to
	// `STREAM_BATCH` entries.
	let mut carry = None;
	while let Some(first) = match carry.take() {
		Some(batch) => Some(batch),
		None => batches.recv().await,
	} {
		let mut batch: Vec<GrepMatch> = first.into_iter().map(GrepMatch::from).collect();
		while let Ok(next) = batches.try_recv() {
			if batch.len() + next.len() > STREAM_BATCH {
				carry = Some(next);
				break;
			}
			batch.extend(next.into_iter().map(GrepMatch::from));
		}
		callback.call_async_catch(batch).await?;
	}
	Ok(())
}

async fn grep_async(
	filesystem: Fs,
	request: GrepRequest,
	stream: Option<GrepStreamCallback>,
	on_match: Option<ThreadsafeFunction<GrepMatch>>,
) -> Result<GrepResult> {
	let engine = Engine::compile(&request.pattern, request.ignore_case, request.multiline)
		.map_err(Error::from_reason)?;
	let root = pi_walker::fs::absolute(Path::new(&request.path))
		.map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?;
	let fs = pi_walker::Fs::new(&filesystem, &root);
	let (sink, batches) = match stream {
		Some(callback) => {
			let (sender, receiver) = mpsc::channel(GREP_STREAM_QUEUE);
			(Some(sender), Some((callback, receiver)))
		},
		None => (None, None),
	};
	let opts = pi_walker::grep::GrepOptions {
		multiline: request.multiline,
		glob: request.glob,
		recursive: request.recursive,
		exclude: request.exclude,
		file_type: request.file_type,
		mode: request.mode,
		before: request.before,
		after: request.after,
		max_columns: request.max_columns,
		offset: request.offset,
		max_count: request.max_count,
		max_count_per_file: request.max_count_per_file,
		walk: pi_walker::walk::Options {
			hidden: request.hidden,
			gitignore: request.gitignore,
			..Default::default()
		},
		sink,
		..pi_walker::grep::GrepOptions::new(Arc::new(engine))
	};
	let search = pi_walker::grep::grep(&fs, &root, opts);
	let result = match batches {
		Some((callback, receiver)) => {
			let (result, forwarded) = tokio::join!(search, forward_matches(callback, receiver));
			// A callback failure stops the search with a generic sink error; the
			// callback's own error is the one to report.
			forwarded?;
			result
		},
		None => search.await,
	}
	.map_err(|err| match err {
		pi_walker::grep::GrepError::Walk(err) => task::walk_failure(err),
		err => Error::from_reason(err.to_string()),
	})?;
	let matches: Vec<GrepMatch> = result.matches.into_iter().map(GrepMatch::from).collect();
	if let Some(callback) = on_match {
		for grep_match in &matches {
			callback.call(Ok(grep_match.clone()), ThreadsafeFunctionCallMode::NonBlocking);
		}
	}
	Ok(GrepResult {
		matches,
		total_matches: clamp_u32(result.total_matches),
		files_with_matches: clamp_u32(result.files_with_matches),
		files_searched: clamp_u32(result.files_searched),
		limit_reached: result.limit_reached.then_some(true),
		skipped_oversized: (result.skipped_oversized > 0)
			.then(|| clamp_u32(result.skipped_oversized)),
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

	let engine =
		Engine::compile(pattern_ref, ignore_case.unwrap_or(false), multiline.unwrap_or(false))
			.map_err(Error::from_reason)?;
	Ok(engine.is_match(content_slice).unwrap_or(false))
}

/// Search files for a regex pattern.
///
/// # Arguments
/// - `options`: Pattern, path, filters, and output mode.
/// - `on_match`: Optional callback invoked per returned match/result, after the
///   search (never called when `options.onMatches` streams instead).
///
/// # Returns
/// Aggregated results across matching files.
#[napi]
pub fn grep<'env>(
	env: &'env Env,
	options: GrepOptions<'_>,
	#[napi(ts_arg_type = "((error: Error | null, match: GrepMatch) => void) | undefined | null")]
	on_match: Option<ThreadsafeFunction<GrepMatch>>,
) -> Result<PromiseRaw<'env, GrepResult>> {
	let GrepOptions {
		pattern,
		path,
		glob,
		exclude,
		recursive,
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
		filesystem,
		on_matches,
	} = options;

	let mode = to_mode(mode);
	let (before, after) = if mode == pi_walker::grep::Mode::Content {
		resolve_context(context, context_before, context_after)
	} else {
		(0, 0)
	};
	let request = GrepRequest {
		pattern,
		path,
		ignore_case: ignore_case.unwrap_or(false),
		multiline: multiline.unwrap_or(false),
		glob: glob
			.as_deref()
			.map(str::trim)
			.filter(|value| !value.is_empty())
			.map(str::to_owned),
		exclude: exclude.unwrap_or_default(),
		recursive: recursive.unwrap_or(true),
		file_type: r#type,
		mode,
		before,
		after,
		max_columns: max_columns.map(|value| value as usize),
		offset: offset.map_or(0, u64::from),
		max_count: max_count.map(u64::from),
		max_count_per_file: max_count_per_file.map(u64::from),
		hidden: hidden.unwrap_or(true),
		gitignore: gitignore.unwrap_or(true),
	};

	let ct = task::CancelToken::new(timeout_ms, signal);
	let filesystem = ShellFilesystem::resolve(filesystem);
	task::filesystem_future(env, "grep", ct, filesystem, move |filesystem| {
		grep_async(filesystem, request, on_matches, on_match)
	})
}
