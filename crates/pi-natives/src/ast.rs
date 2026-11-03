//! N-API bindings for ast-grep structural search and rewrite
//! ([`pi_ast::search`]): option decoding and result conversion.

use std::{
	collections::{BTreeSet, HashMap},
	path::{Path, PathBuf},
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_ast::{
	ops,
	search::{self, MatchStrictness},
};
use pi_vfs::Fs;
use pi_walker::{glob::Selector, walk::WalkError};

use crate::{shell::vfs::ShellFilesystem, task};

const DEFAULT_FIND_LIMIT: u32 = 50;

/// ast-grep pattern strictness (controls how patterns match syntax).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum AstMatchStrictness {
	/// Match at the concrete syntax tree level.
	#[napi(value = "cst")]
	Cst,
	/// Balanced default suitable for most searches.
	#[napi(value = "smart")]
	Smart,
	/// Match at the AST level.
	#[napi(value = "ast")]
	Ast,
	/// More permissive matching.
	#[napi(value = "relaxed")]
	Relaxed,
	/// Match structural signatures.
	#[napi(value = "signature")]
	Signature,
	/// Template-style pattern matching.
	#[napi(value = "template")]
	Template,
}

impl From<AstMatchStrictness> for MatchStrictness {
	fn from(value: AstMatchStrictness) -> Self {
		match value {
			AstMatchStrictness::Cst => Self::Cst,
			AstMatchStrictness::Smart => Self::Smart,
			AstMatchStrictness::Ast => Self::Ast,
			AstMatchStrictness::Relaxed => Self::Relaxed,
			AstMatchStrictness::Signature => Self::Signature,
			AstMatchStrictness::Template => Self::Template,
		}
	}
}

fn resolve_strictness(value: Option<AstMatchStrictness>) -> MatchStrictness {
	value.map_or(MatchStrictness::Smart, Into::into)
}

/// Options for `astGrep`: patterns, scan scope, and match limits.
#[napi(object, object_to_js = false)]
pub struct AstFindOptions<'env> {
	/// ast-grep patterns to search for (OR across patterns).
	pub patterns:     Option<Vec<String>>,
	/// Language override; otherwise inferred from file extension per candidate.
	pub lang:         Option<String>,
	/// Single file or directory to scan (combined with `glob` when set): a
	/// host path or an absolute `scheme://` URL.
	pub path:         Option<String>,
	/// Optional glob filter relative to the search root.
	pub glob:         Option<String>,
	/// Rule selector for multi-rule ast-grep configurations.
	pub selector:     Option<String>,
	/// Pattern strictness; defaults to smart matching when omitted.
	pub strictness:   Option<AstMatchStrictness>,
	/// Maximum matches to return after `offset` (default applies when omitted).
	pub limit:        Option<u32>,
	/// Number of leading matches to skip before applying `limit`.
	pub offset:       Option<u32>,
	/// When true, include meta-variable bindings per match.
	pub include_meta: Option<bool>,
	/// Reserved for contextual snippets; not used by the current native find
	/// path.
	pub context:      Option<u32>,
	/// Optional cancellation handle (library-specific).
	pub signal:       Option<Unknown<'env>>,
	/// Wall-clock timeout for the worker task in milliseconds.
	pub timeout_ms:   Option<u32>,
	/// Filesystem candidates are resolved, walked, and read through (native
	/// when absent).
	pub filesystem:   Option<ShellFilesystem>,
}

/// One ast-grep match with source range and optional meta-variables.
#[napi(object)]
pub struct AstFindMatch {
	/// Display path of the matching file.
	pub path:           String,
	/// Matched source text.
	pub text:           String,
	/// Start byte offset in the file (UTF-8 byte index).
	pub byte_start:     u32,
	/// End byte offset in the file (exclusive UTF-8 byte index).
	pub byte_end:       u32,
	/// 1-based start line.
	pub start_line:     u32,
	/// 1-based start column.
	pub start_column:   u32,
	/// 1-based end line.
	pub end_line:       u32,
	/// 1-based end column.
	pub end_column:     u32,
	/// Meta-variable name to captured text, when `includeMeta` was enabled.
	pub meta_variables: Option<HashMap<String, String>>,
}
/// Aggregated search statistics and any parse or compile diagnostics.
#[napi(object)]
pub struct AstFindResult {
	/// Page of matches after sort, offset, and limit.
	pub matches:            Vec<AstFindMatch>,
	/// Total matches found before paging (can exceed `matches.length`).
	pub total_matches:      u32,
	/// Distinct files that contained at least one match.
	pub files_with_matches: u32,
	/// Files examined for the query.
	pub files_searched:     u32,
	/// True when results were truncated by `limit`.
	pub limit_reached:      bool,
	/// Non-fatal parse or pattern errors collected during the run.
	pub parse_errors:       Option<Vec<String>>,
	/// Languages whose on-demand grammar is not installed; their files were
	/// skipped (see `wasmGrammarFor`).
	pub missing_grammars:   Option<Vec<String>>,
}

/// Options for `astMatch`: run ast-grep patterns against an in-memory source
/// string instead of files on disk.
#[napi(object)]
pub struct AstMatchOptions<'env> {
	/// Source code to match against (parsed in memory, never read from disk).
	pub source:       String,
	/// Language of `source` (required; e.g. "ts", "tsx", "rust", "python").
	pub lang:         String,
	/// ast-grep patterns to search for (OR across patterns).
	pub patterns:     Vec<String>,
	/// Rule selector for multi-rule ast-grep configurations.
	pub selector:     Option<String>,
	/// Pattern strictness; defaults to smart matching when omitted.
	pub strictness:   Option<AstMatchStrictness>,
	/// Maximum matches to return after `offset` (default applies when omitted).
	pub limit:        Option<u32>,
	/// Number of leading matches to skip before applying `limit`.
	pub offset:       Option<u32>,
	/// When true, include meta-variable bindings per match.
	pub include_meta: Option<bool>,
	/// Optional cancellation handle (library-specific).
	pub signal:       Option<Unknown<'env>>,
	/// Wall-clock timeout for the worker task in milliseconds.
	pub timeout_ms:   Option<u32>,
}

/// Result of an in-memory `astMatch` run.
#[napi(object)]
pub struct AstMatchResult {
	/// Page of matches after sort, offset, and limit.
	pub matches:       Vec<AstFindMatch>,
	/// Total matches found before paging (can exceed `matches.length`).
	pub total_matches: u32,
	/// True when results were truncated by `limit`.
	pub limit_reached: bool,
	/// Non-fatal parse or pattern-compile errors collected during the run.
	pub parse_errors:  Option<Vec<String>>,
}

/// Options for `astEdit`: rewrite rules, scan scope, safety limits, and
/// dry-run.
#[napi(object, object_to_js = false)]
pub struct AstReplaceOptions<'env> {
	/// Map of pattern string to replacement template.
	pub rewrites:            Option<HashMap<String, String>>,
	/// Language override applied to every file; otherwise inferred per file, so
	/// mixed-language paths rewrite each file in its own language.
	pub lang:                Option<String>,
	/// Single file or directory to rewrite: a host path or an absolute
	/// `scheme://` URL.
	pub path:                Option<String>,
	/// Optional glob filter within the search root.
	pub glob:                Option<String>,
	/// Rule selector for multi-rule configurations.
	pub selector:            Option<String>,
	/// Pattern strictness for rewrites.
	pub strictness:          Option<AstMatchStrictness>,
	/// When true (default), compute changes without writing files.
	pub dry_run:             Option<bool>,
	/// Cap on replacement applications across all files.
	pub max_replacements:    Option<u32>,
	/// Cap on distinct files that may be modified.
	pub max_files:           Option<u32>,
	/// Fail the operation when a file cannot be parsed for rewriting.
	pub fail_on_parse_error: Option<bool>,
	/// Optional cancellation handle.
	pub signal:              Option<Unknown<'env>>,
	/// Wall-clock timeout for the worker task in milliseconds.
	pub timeout_ms:          Option<u32>,
	/// Filesystem candidates are resolved, walked, read, and written through
	/// (native when absent).
	pub filesystem:          Option<ShellFilesystem>,
}

/// One textual replacement applied to a file (before/after slice and
/// coordinates).
#[napi(object)]
pub struct AstReplaceChange {
	/// File path for this change.
	pub path:           String,
	/// Original matched text.
	pub before:         String,
	/// Replacement text.
	pub after:          String,
	/// Start byte offset of the replaced span.
	pub byte_start:     u32,
	/// End byte offset of the replaced span (exclusive).
	pub byte_end:       u32,
	/// Length of deleted text in bytes (may differ from `byteEnd - byteStart`
	/// for edge cases).
	pub deleted_length: u32,
	/// 1-based start line of the match.
	pub start_line:     u32,
	/// 1-based start column.
	pub start_column:   u32,
	/// 1-based end line.
	pub end_line:       u32,
	/// 1-based end column.
	pub end_column:     u32,
}

/// Per-file replacement count after an `astEdit` run.
#[napi(object)]
pub struct AstReplaceFileChange {
	/// File that had replacements.
	pub path:  String,
	/// Number of replacements in that file.
	pub count: u32,
}

/// Summary of an ast-grep rewrite pass, including whether disk writes occurred.
#[napi(object)]
pub struct AstReplaceResult {
	/// Individual replacement records (may be large).
	pub changes:            Vec<AstReplaceChange>,
	/// Replacement counts grouped by file.
	pub file_changes:       Vec<AstReplaceFileChange>,
	/// Total replacements applied or previewed.
	pub total_replacements: u32,
	/// Files that had at least one replacement.
	pub files_touched:      u32,
	/// Files considered for rewriting.
	pub files_searched:     u32,
	/// False when `dryRun` prevented writing.
	pub applied:            bool,
	/// True when limits stopped further replacements.
	pub limit_reached:      bool,
	/// Parse or pattern errors when not failing the whole operation.
	pub parse_errors:       Option<Vec<String>>,
	/// Languages whose on-demand grammar is not installed; their files were
	/// skipped (see `wasmGrammarFor`).
	pub missing_grammars:   Option<Vec<String>>,
}

fn to_u32(value: usize) -> u32 {
	u32::try_from(value).unwrap_or(u32::MAX)
}

/// The N-API error for a failed search: walk failures and stops report as
/// the token words them.
fn failure(ct: &task::CancelToken, err: search::Error) -> Error {
	match err {
		search::Error::Stopped => ct
			.heartbeat()
			.err()
			.unwrap_or_else(|| Error::from_reason("search stopped")),
		search::Error::Root { path, error } => task::walk_failure(WalkError::Root { path, error }),
		search::Error::Invalid(reason) => Error::from_reason(reason),
	}
}

fn non_empty<T>(items: Vec<T>) -> Option<Vec<T>> {
	(!items.is_empty()).then_some(items)
}

fn missing_grammars(report: &search::Report) -> Option<Vec<String>> {
	non_empty(
		report
			.missing_grammars
			.iter()
			.map(|name| (*name).to_string())
			.collect(),
	)
}

/// Decodes `lang`: trimmed, `None` when blank.
fn explicit_lang(lang: Option<&str>) -> Option<&str> {
	lang.map(str::trim).filter(|lang| !lang.is_empty())
}

/// Candidate files for `path` (default `.`) scoped by `glob`, with the
/// natives' discovery rules: hidden files included, ignore files honoured,
/// `node_modules` entered only when the glob names it.
async fn discover(
	fs: &Fs,
	path: Option<String>,
	glob: Option<&str>,
	lang: Option<&str>,
	ct: &task::CancelToken,
) -> Result<Vec<search::Candidate>> {
	let raw = path.unwrap_or_else(|| ".".to_string());
	let root: PathBuf = pi_walker::fs::absolute(Path::new(raw.trim()))
		.map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?;
	let include = glob
		.map(str::trim)
		.filter(|glob| !glob.is_empty())
		.map(|glob| Selector::scope(glob, false))
		.transpose()
		.map_err(|err| Error::from_reason(format!("Invalid glob pattern: {err}")))?;
	let opts = search::Discover {
		node_modules: include
			.as_ref()
			.is_some_and(Selector::mentions_node_modules),
		include,
		hidden: true,
		gitignore: true,
		any_file: lang.is_some(),
		..Default::default()
	};
	search::discover(fs, &root, &opts)
		.await
		.map_err(|err| failure(ct, err))
}

fn normalize_pattern_list(patterns: Option<Vec<String>>) -> Result<Vec<String>> {
	let mut normalized = Vec::new();
	let mut seen = BTreeSet::new();
	for raw in patterns.unwrap_or_default() {
		let pattern = raw.trim();
		if pattern.is_empty() || seen.contains(pattern) {
			continue;
		}
		let owned = if pattern.len() == raw.len() {
			raw
		} else {
			pattern.to_string()
		};
		seen.insert(owned.clone());
		normalized.push(owned);
	}
	if normalized.is_empty() {
		return Err(Error::from_reason(
			"`patterns` is required and must include at least one non-empty pattern".to_string(),
		));
	}
	Ok(normalized)
}

fn normalize_rewrite_map(
	rewrites: Option<HashMap<String, String>>,
) -> Result<Vec<(String, String)>> {
	let mut normalized = Vec::new();
	for (pattern, rewrite) in rewrites.unwrap_or_default() {
		if pattern.is_empty() {
			return Err(Error::from_reason(
				"`rewrites` keys must be non-empty pattern strings".to_string(),
			));
		}
		normalized.push((pattern, rewrite));
	}
	if normalized.is_empty() {
		return Err(Error::from_reason(
			"`rewrites` is required and must include at least one pattern->rewrite mapping"
				.to_string(),
		));
	}
	normalized.sort_by(|left, right| left.0.cmp(&right.0));
	Ok(normalized)
}

/// The page `offset`/`limit` select (default limit, at least one match).
fn page(offset: Option<u32>, limit: Option<u32>) -> search::Page {
	search::Page {
		offset: to_usize(offset.unwrap_or(0)),
		limit:  to_usize(limit.unwrap_or(DEFAULT_FIND_LIMIT).max(1)),
	}
}

fn to_usize(value: u32) -> usize {
	usize::try_from(value).unwrap_or(usize::MAX)
}

/// Meta-variable bindings as text; a multi-node binding reads `[a, b]`.
fn meta_variables(captures: search::Captures) -> HashMap<String, String> {
	let search::Captures { single, multi } = captures;
	single
		.into_iter()
		.map(|(name, capture)| (name, capture.text))
		.chain(multi.into_iter().map(|(name, captures)| {
			let texts: Vec<_> = captures.into_iter().map(|capture| capture.text).collect();
			(name, format!("[{}]", texts.join(", ")))
		}))
		.collect()
}

fn find_match(path: String, matched: search::Match) -> AstFindMatch {
	let search::Match { span, text, captures } = matched;
	AstFindMatch {
		path,
		text,
		byte_start: to_u32(span.start),
		byte_end: to_u32(span.end),
		start_line: to_u32(span.start_pos.line.saturating_add(1)),
		start_column: to_u32(span.start_pos.column.saturating_add(1)),
		end_line: to_u32(span.end_pos.line.saturating_add(1)),
		end_column: to_u32(span.end_pos.column.saturating_add(1)),
		meta_variables: captures.map(meta_variables),
	}
}

fn replace_change(path: &str, change: search::Change) -> AstReplaceChange {
	let search::Change { span, before, after, deleted_length } = change;
	AstReplaceChange {
		path: path.to_string(),
		before,
		after,
		byte_start: to_u32(span.start),
		byte_end: to_u32(span.end),
		deleted_length: to_u32(deleted_length),
		start_line: to_u32(span.start_pos.line.saturating_add(1)),
		start_column: to_u32(span.start_pos.column.saturating_add(1)),
		end_line: to_u32(span.end_pos.line.saturating_add(1)),
		end_column: to_u32(span.end_pos.column.saturating_add(1)),
	}
}

/// Search source files with ast-grep patterns; returns a promise resolved on a
/// worker thread.
#[napi]
pub fn ast_grep<'env>(
	env: &'env Env,
	options: AstFindOptions<'_>,
) -> Result<PromiseRaw<'env, AstFindResult>> {
	let AstFindOptions {
		patterns,
		lang,
		path,
		glob,
		selector,
		strictness,
		limit,
		offset,
		include_meta,
		context: _,
		signal,
		timeout_ms,
		filesystem,
	} = options;

	let fs = ShellFilesystem::resolve(filesystem);
	let ct = task::CancelToken::new(timeout_ms, signal);
	let page = page(offset, limit);

	let cancel = ct.clone();
	task::filesystem_future(env, "ast_grep", ct, fs, move |fs| async move {
		let patterns = normalize_pattern_list(patterns)?;
		let candidates =
			discover(&fs, path, glob.as_deref(), explicit_lang(lang.as_deref()), &cancel).await?;
		let query = search::Query {
			patterns:   &patterns,
			lang:       explicit_lang(lang.as_deref()),
			selector:   selector.as_deref(),
			strictness: resolve_strictness(strictness),
			captures:   include_meta.unwrap_or(false),
		};
		let found = search::find_page(&fs, candidates, &query, page)
			.await
			.map_err(|err| failure(&cancel, err))?;
		let missing_grammars = missing_grammars(&found.report);
		Ok(AstFindResult {
			matches: found
				.hits
				.into_iter()
				.map(|hit| find_match(hit.display, hit.matched))
				.collect(),
			total_matches: to_u32(found.total_matches),
			files_with_matches: to_u32(found.files_with_matches),
			files_searched: to_u32(found.report.files_searched),
			limit_reached: found.limit_reached,
			parse_errors: non_empty(found.report.warnings),
			missing_grammars,
		})
	})
}

/// Match ast-grep patterns against an in-memory source string; returns a
/// promise resolved on a worker thread.
///
/// This is the file-free counterpart to [`ast_grep`]: callers that already hold
/// the source (streaming buffers, generated code, editor contents) avoid a
/// temp-file round trip. `lang` is required since there is no path to infer it
/// from.
#[napi]
pub fn ast_match(options: AstMatchOptions<'_>) -> task::Promise<AstMatchResult> {
	let AstMatchOptions {
		source,
		lang,
		patterns,
		selector,
		strictness,
		limit,
		offset,
		include_meta,
		signal,
		timeout_ms,
	} = options;

	let ct = task::CancelToken::new(timeout_ms, signal);
	let page = page(offset, limit);

	task::blocking("ast_match", ct, move |ct| {
		let patterns = normalize_pattern_list(Some(patterns))?;
		let Some(lang) = explicit_lang(Some(lang.as_str())) else {
			return Err(Error::from_reason("`lang` is required for ast_match".to_string()));
		};
		let language =
			ops::resolve_supported_lang(lang).map_err(|err| Error::from_reason(err.to_string()))?;
		let query = search::Query {
			patterns:   &patterns,
			lang:       None,
			selector:   selector.as_deref(),
			strictness: resolve_strictness(strictness),
			captures:   include_meta.unwrap_or(false),
		};
		let stop = ct.cancellation();
		let found = search::find_source(&source, language, &query, page, stop.token())
			.map_err(|err| failure(&ct, err))?;
		Ok(AstMatchResult {
			matches:       found
				.matches
				.into_iter()
				.map(|matched| find_match(String::new(), matched))
				.collect(),
			total_matches: to_u32(found.total_matches),
			limit_reached: found.limit_reached,
			parse_errors:  non_empty(found.warnings),
		})
	})
}

/// Apply ast-grep rewrite rules to matching files; honors `dryRun` and returns
/// a promise.
#[napi]
pub fn ast_edit<'env>(
	env: &'env Env,
	options: AstReplaceOptions<'_>,
) -> Result<PromiseRaw<'env, AstReplaceResult>> {
	let AstReplaceOptions {
		rewrites,
		lang,
		path,
		glob,
		selector,
		strictness,
		dry_run,
		max_replacements,
		max_files,
		fail_on_parse_error,
		signal,
		timeout_ms,
		filesystem,
	} = options;

	let fs = ShellFilesystem::resolve(filesystem);
	let ct = task::CancelToken::new(timeout_ms, signal);
	let cancel = ct.clone();
	task::filesystem_future(env, "ast_edit", ct, fs, move |fs| async move {
		let rules = normalize_rewrite_map(rewrites)?;
		let dry_run = dry_run.unwrap_or(true);
		let candidates =
			discover(&fs, path, glob.as_deref(), explicit_lang(lang.as_deref()), &cancel).await?;
		let lang = explicit_lang(lang.as_deref());
		if let Some(lang) = lang {
			ops::resolve_supported_lang(lang).map_err(|err| Error::from_reason(err.to_string()))?;
		} else if candidates.is_empty() {
			return Err(Error::from_reason(
				"ast_edit found no supported source files for the given path/glob".to_string(),
			));
		}

		let rewrite = search::Rewrite {
			rules: &rules,
			lang,
			selector: selector.as_deref(),
			strictness: resolve_strictness(strictness),
			max_replacements: to_usize(max_replacements.unwrap_or(u32::MAX).max(1)),
			max_files: to_usize(max_files.unwrap_or(u32::MAX).max(1)),
			fail_on_parse_error: fail_on_parse_error.unwrap_or(false),
			skip_overlaps: false,
			mode: if dry_run {
				search::Mode::Preview
			} else {
				search::Mode::Write
			},
		};
		let edited = search::rewrite(&fs, candidates, &rewrite)
			.await
			.map_err(|err| failure(&cancel, err))?;
		let missing_grammars = missing_grammars(&edited.report);
		let mut changes = Vec::new();
		let mut file_changes = Vec::with_capacity(edited.files.len());
		for file in edited.files {
			file_changes.push(AstReplaceFileChange {
				path:  file.display.clone(),
				count: to_u32(file.changes.len()),
			});
			changes.extend(
				file
					.changes
					.into_iter()
					.map(|change| replace_change(&file.display, change)),
			);
		}
		Ok(AstReplaceResult {
			total_replacements: to_u32(changes.len()),
			files_touched: to_u32(file_changes.len()),
			files_searched: to_u32(edited.report.files_searched),
			applied: !dry_run,
			limit_reached: edited.limit_reached,
			parse_errors: non_empty(edited.report.warnings),
			missing_grammars,
			changes,
			file_changes,
		})
	})
}
