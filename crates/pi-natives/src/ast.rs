//! AST-aware structural search and rewrite powered by ast-grep.

use std::{
	cmp::Ordering,
	collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap},
	path::{Path, PathBuf},
};

use ast_grep_core::{MatchStrictness, matcher::Pattern, source::Edit, tree_sitter::LanguageExt};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_ast::{
	SupportLang,
	ops::{self as shared_ops},
};

use crate::{glob_util, iofs, task};

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
#[napi(object)]
pub struct AstFindOptions<'env> {
	/// ast-grep patterns to search for (OR across patterns).
	pub patterns:     Option<Vec<String>>,
	/// Language override; otherwise inferred from file extension per candidate.
	pub lang:         Option<String>,
	/// Single file or directory to scan (combined with `glob` when set).
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

#[derive(Clone, Eq, PartialEq)]
struct AstFindOrderKey {
	path:         String,
	start_line:   u32,
	start_column: u32,
	end_line:     u32,
	end_column:   u32,
	byte_start:   u32,
	byte_end:     u32,
	sequence:     u64,
}

impl Ord for AstFindOrderKey {
	fn cmp(&self, other: &Self) -> Ordering {
		self
			.path
			.cmp(&other.path)
			.then(self.start_line.cmp(&other.start_line))
			.then(self.start_column.cmp(&other.start_column))
			.then(self.end_line.cmp(&other.end_line))
			.then(self.end_column.cmp(&other.end_column))
			.then(self.byte_start.cmp(&other.byte_start))
			.then(self.byte_end.cmp(&other.byte_end))
			.then(self.sequence.cmp(&other.sequence))
	}
}

impl PartialOrd for AstFindOrderKey {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

#[derive(Eq, PartialEq)]
struct RetainedAstFindMatch {
	key:            AstFindOrderKey,
	text:           String,
	meta_variables: Option<HashMap<String, String>>,
}

impl Ord for RetainedAstFindMatch {
	fn cmp(&self, other: &Self) -> Ordering {
		self.key.cmp(&other.key)
	}
}

impl PartialOrd for RetainedAstFindMatch {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

fn retained_find_capacity(offset: u32, limit: u32) -> usize {
	usize::try_from(offset.saturating_add(limit).saturating_add(1)).unwrap_or(usize::MAX)
}

fn should_retain_match(
	retained: &BinaryHeap<RetainedAstFindMatch>,
	capacity: usize,
	key: &AstFindOrderKey,
) -> bool {
	if retained.len() < capacity {
		return true;
	}
	retained
		.peek()
		.is_some_and(|worst_retained| key.cmp(&worst_retained.key).is_lt())
}

fn retain_bounded_match(
	retained: &mut BinaryHeap<RetainedAstFindMatch>,
	capacity: usize,
	candidate: RetainedAstFindMatch,
) {
	if retained.len() < capacity {
		retained.push(candidate);
		return;
	}
	if let Some(mut worst_retained) = retained.peek_mut()
		&& candidate.key.cmp(&worst_retained.key).is_lt()
	{
		*worst_retained = candidate;
	}
}

fn page_retained_matches(
	retained: BinaryHeap<RetainedAstFindMatch>,
	offset: u32,
	limit: u32,
) -> (Vec<RetainedAstFindMatch>, bool) {
	let mut retained_matches = retained.into_vec();
	retained_matches.sort_by(|left, right| left.key.cmp(&right.key));
	let offset = usize::try_from(offset).unwrap_or(usize::MAX);
	let limit = usize::try_from(limit).unwrap_or(usize::MAX);
	let limit_reached = retained_matches.len().saturating_sub(offset) > limit;
	let matches = retained_matches
		.into_iter()
		.skip(offset)
		.take(limit)
		.collect::<Vec<_>>();
	(matches, limit_reached)
}

fn retained_to_find_match(retained: RetainedAstFindMatch) -> AstFindMatch {
	let RetainedAstFindMatch { key, text, meta_variables } = retained;
	AstFindMatch {
		path: key.path,
		text,
		byte_start: key.byte_start,
		byte_end: key.byte_end,
		start_line: key.start_line,
		start_column: key.start_column,
		end_line: key.end_line,
		end_column: key.end_column,
		meta_variables,
	}
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
#[napi(object)]
pub struct AstReplaceOptions<'env> {
	/// Map of pattern string to replacement template.
	pub rewrites:            Option<HashMap<String, String>>,
	/// Language override applied to every file; otherwise inferred per file, so
	/// mixed-language paths rewrite each file in its own language.
	pub lang:                Option<String>,
	/// Single file or directory to rewrite.
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
}

struct FileCandidate {
	absolute_path: PathBuf,
	display_path:  String,
}

struct PendingFileChange {
	change: AstReplaceChange,
	edit:   Edit<String>,
}

struct PendingWrite {
	absolute_path: PathBuf,
	output:        String,
}

fn to_u32(value: usize) -> u32 {
	value.min(u32::MAX as usize) as u32
}

fn resolve_supported_lang(value: &str) -> Result<SupportLang> {
	shared_ops::resolve_supported_lang(value).map_err(|err| Error::from_reason(err.to_string()))
}

fn resolve_language(lang: Option<&str>, file_path: &Path) -> Result<SupportLang> {
	shared_ops::resolve_language(lang, file_path).map_err(|err| Error::from_reason(err.to_string()))
}

/// Returns true if the file's extension resolves to a supported language.
/// When `lang` is explicitly provided, all files are considered candidates
/// (the user chose to treat them as that language). When `lang` is None,
/// only files with recognizable code extensions are included.
fn is_supported_file(file_path: &Path, explicit_lang: Option<&str>) -> bool {
	shared_ops::is_supported_file(file_path, explicit_lang)
}

fn normalize_search_path(path: Option<String>) -> Result<PathBuf> {
	let raw = path.unwrap_or_else(|| ".".to_string());
	let candidate = PathBuf::from(raw.trim());
	let absolute = if candidate.is_absolute() {
		candidate
	} else {
		std::env::current_dir()
			.map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?
			.join(candidate)
	};
	Ok(std::fs::canonicalize(&absolute).unwrap_or(absolute))
}

fn collect_candidates(
	path: Option<String>,
	glob: Option<&str>,
	ct: &task::CancelToken,
) -> Result<Vec<FileCandidate>> {
	let search_path = normalize_search_path(path)?;
	let metadata = std::fs::metadata(&search_path)
		.map_err(|err| Error::from_reason(format!("Path not found: {err}")))?;
	if metadata.is_file() {
		let display_path = search_path
			.file_name()
			.and_then(|name| name.to_str())
			.map_or_else(
				|| search_path.to_string_lossy().into_owned(),
				std::string::ToString::to_string,
			);
		return Ok(vec![FileCandidate { absolute_path: search_path, display_path }]);
	}
	if !metadata.is_dir() {
		return Err(Error::from_reason(format!(
			"Search path must be a file or directory: {}",
			search_path.display()
		)));
	}

	let mentions_node_modules = glob.is_some_and(|value| value.contains("node_modules"));
	let mut filter =
		pi_walker::WalkFilter::files_only().node_modules_unless_mentioned(mentions_node_modules);
	if let Some(glob) = glob.map(str::trim).filter(|value| !value.is_empty()) {
		let pattern = glob_util::build_glob_pattern(glob, false);
		let compiled = pi_walker::CompiledWalkGlob::new([pattern])
			.map_err(|err| Error::from_reason(format!("Invalid glob pattern: {err}")))?;
		filter = filter.glob(compiled);
	}
	let request = pi_walker::WalkRequest::new(&search_path)
		.hidden(true)
		.gitignore(true)
		.skip_git(true)
		.follow_links(pi_walker::FollowLinks::Never)
		.detail(pi_walker::WalkDetail::Minimal)
		.order(pi_walker::WalkOrder::Path)
		.emit_root(false)
		.depth(1, usize::MAX)
		.directory_errors(pi_walker::DirectoryErrorMode::SkipSkippable)
		.cache(true)
		.empty_recheck(pi_walker::EmptyRecheck::Configured)
		.filter(filter);
	let mut files: Vec<_> = request
		.collect_files_with_heartbeat(|| ct.heartbeat())
		.map_err(iofs::map_walker_error)?
		.into_iter()
		.map(|entry| FileCandidate {
			absolute_path: entry.absolute_path(&search_path),
			display_path:  entry.path,
		})
		.collect();

	files.sort_by(|a, b| a.display_path.cmp(&b.display_path));
	Ok(files)
}

fn compile_pattern(
	pattern: &str,
	selector: Option<&str>,
	strictness: &MatchStrictness,
	lang: SupportLang,
) -> Result<Pattern> {
	shared_ops::compile_pattern(pattern, selector, strictness, lang)
		.map_err(|err| Error::from_reason(err.to_string()))
}

fn apply_edits(content: &str, edits: &[Edit<String>]) -> Result<String> {
	shared_ops::apply_edits(content, edits).map_err(|err| Error::from_reason(err.to_string()))
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
struct CompiledFindPattern {
	pattern:                String,
	compiled_by_lang:       HashMap<String, Pattern>,
	compile_errors_by_lang: HashMap<String, String>,
}

/// A rewrite rule compiled for every language discovered among the candidate
/// files. A rule that fails to parse in one language of a mixed tree skips
/// that language's files (reported as parse errors) instead of failing the
/// whole call.
struct CompiledRewriteRule {
	pattern:                String,
	rewrite:                String,
	compiled_by_lang:       HashMap<String, Pattern>,
	compile_errors_by_lang: HashMap<String, String>,
}

struct ResolvedCandidate {
	candidate:      FileCandidate,
	language:       Option<SupportLang>,
	language_error: Option<String>,
}

fn resolve_candidates_for_find(
	candidates: Vec<FileCandidate>,
	lang: Option<&str>,
	ct: &task::CancelToken,
) -> Result<(Vec<ResolvedCandidate>, HashMap<String, SupportLang>)> {
	let mut resolved = Vec::with_capacity(candidates.len());
	let mut languages = HashMap::new();

	for candidate in candidates {
		ct.heartbeat()?;
		match resolve_language(lang, &candidate.absolute_path) {
			Ok(language) => {
				let key = language.canonical_name().to_string();
				languages.entry(key).or_insert(language);
				resolved.push(ResolvedCandidate {
					candidate,
					language: Some(language),
					language_error: None,
				});
			},
			Err(err) => {
				resolved.push(ResolvedCandidate {
					candidate,
					language: None,
					language_error: Some(err.to_string()),
				});
			},
		}
	}

	Ok((resolved, languages))
}

fn compile_find_patterns(
	patterns: &[String],
	languages: &HashMap<String, SupportLang>,
	selector: Option<&str>,
	strictness: &MatchStrictness,
	ct: &task::CancelToken,
) -> Result<Vec<CompiledFindPattern>> {
	let mut compiled = Vec::with_capacity(patterns.len());

	for pattern in patterns {
		ct.heartbeat()?;
		let mut compiled_by_lang = HashMap::with_capacity(languages.len());
		let mut compile_errors_by_lang = HashMap::new();

		for (lang_key, &language) in languages {
			ct.heartbeat()?;
			match compile_pattern(pattern, selector, strictness, language) {
				Ok(compiled_pattern) => {
					compiled_by_lang.insert(lang_key.clone(), compiled_pattern);
				},
				Err(err) => {
					compile_errors_by_lang.insert(lang_key.clone(), err.to_string());
				},
			}
		}

		compiled.push(CompiledFindPattern {
			pattern: pattern.clone(),
			compiled_by_lang,
			compile_errors_by_lang,
		});
	}

	Ok(compiled)
}
/// Search source files with ast-grep patterns; returns a promise resolved on a
/// worker thread.
#[napi]
pub fn ast_grep(options: AstFindOptions<'_>) -> task::Promise<AstFindResult> {
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
	} = options;

	let ct = task::CancelToken::new(timeout_ms, signal);
	let normalized_limit = limit.unwrap_or(DEFAULT_FIND_LIMIT).max(1);
	let normalized_offset = offset.unwrap_or(0);

	task::blocking("ast_grep", ct, move |ct| {
		let patterns = normalize_pattern_list(patterns)?;
		let strictness = resolve_strictness(strictness);
		let include_meta = include_meta.unwrap_or(false);
		let lang_str = lang.as_deref().map(str::trim).filter(|v| !v.is_empty());
		let candidates: Vec<_> = collect_candidates(path, glob.as_deref(), &ct)?
			.into_iter()
			.filter(|candidate| is_supported_file(&candidate.absolute_path, lang_str))
			.collect();

		let (resolved_candidates, languages) =
			resolve_candidates_for_find(candidates, lang_str, &ct)?;
		let compiled_patterns =
			compile_find_patterns(&patterns, &languages, selector.as_deref(), &strictness, &ct)?;
		let files_searched = to_u32(resolved_candidates.len());

		let retained_capacity = retained_find_capacity(normalized_offset, normalized_limit);
		let mut retained_matches = BinaryHeap::new();
		let mut parse_errors = Vec::new();
		let mut total_matches = 0u32;
		let mut match_sequence = 0u64;
		let mut files_with_matches = BTreeSet::new();
		for resolved in resolved_candidates {
			ct.heartbeat()?;
			let ResolvedCandidate { candidate, language, language_error } = resolved;

			if let Some(error) = language_error.as_deref() {
				for compiled in &compiled_patterns {
					parse_errors
						.push(format!("{}: {}: {error}", compiled.pattern, candidate.display_path));
				}
				continue;
			}

			let Some(language) = language else {
				continue;
			};
			let lang_key = language.canonical_name();
			let source = match std::fs::read_to_string(&candidate.absolute_path) {
				Ok(source) => source,
				Err(err) => {
					for compiled in &compiled_patterns {
						parse_errors
							.push(format!("{}: {}: {err}", compiled.pattern, candidate.display_path));
					}
					continue;
				},
			};

			let mut runnable_patterns: Vec<(&str, &Pattern)> = Vec::new();
			for compiled in &compiled_patterns {
				ct.heartbeat()?;
				if let Some(error) = compiled.compile_errors_by_lang.get(lang_key) {
					parse_errors
						.push(format!("{}: {}: {error}", compiled.pattern, candidate.display_path));
					continue;
				}
				if let Some(pattern) = compiled.compiled_by_lang.get(lang_key) {
					runnable_patterns.push((compiled.pattern.as_str(), pattern));
				}
			}
			if runnable_patterns.is_empty() {
				continue;
			}

			let ast = language.ast_grep(source);
			if ast.root().dfs().any(|node| node.is_error()) {
				parse_errors.push(format!(
					"{}: parse error (syntax tree contains error nodes)",
					candidate.display_path
				));
			}

			let mut file_had_match = false;
			for (_, pattern) in runnable_patterns {
				ct.heartbeat()?;
				for matched in ast.root().find_all(pattern.clone()) {
					ct.heartbeat()?;
					total_matches = total_matches.saturating_add(1);
					if !file_had_match {
						files_with_matches.insert(candidate.display_path.clone());
						file_had_match = true;
					}
					let range = matched.range();
					let start = matched.start_pos();
					let end = matched.end_pos();
					let key = AstFindOrderKey {
						path:         candidate.display_path.clone(),
						start_line:   to_u32(start.line().saturating_add(1)),
						start_column: to_u32(start.column(matched.get_node()).saturating_add(1)),
						end_line:     to_u32(end.line().saturating_add(1)),
						end_column:   to_u32(end.column(matched.get_node()).saturating_add(1)),
						byte_start:   to_u32(range.start),
						byte_end:     to_u32(range.end),
						sequence:     match_sequence,
					};
					match_sequence = match_sequence.saturating_add(1);
					if should_retain_match(&retained_matches, retained_capacity, &key) {
						let meta_variables = if include_meta {
							Some(HashMap::<String, String>::from(matched.get_env().clone()))
						} else {
							None
						};
						retain_bounded_match(
							&mut retained_matches,
							retained_capacity,
							RetainedAstFindMatch {
								key,
								text: matched.text().into_owned(),
								meta_variables,
							},
						);
					}
				}
			}
		}

		let (matches, limit_reached) =
			page_retained_matches(retained_matches, normalized_offset, normalized_limit);
		let matches = matches
			.into_iter()
			.map(retained_to_find_match)
			.collect::<Vec<_>>();

		Ok(AstFindResult {
			matches,
			total_matches,
			files_with_matches: to_u32(files_with_matches.len()),
			files_searched,
			limit_reached,
			parse_errors: (!parse_errors.is_empty()).then_some(parse_errors),
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
	let normalized_limit = limit.unwrap_or(DEFAULT_FIND_LIMIT).max(1);
	let normalized_offset = offset.unwrap_or(0);

	task::blocking("ast_match", ct, move |ct| {
		let patterns = normalize_pattern_list(Some(patterns))?;
		let strictness = resolve_strictness(strictness);
		let include_meta = include_meta.unwrap_or(false);
		let lang_str = lang.trim();
		if lang_str.is_empty() {
			return Err(Error::from_reason("`lang` is required for ast_match".to_string()));
		}
		let language = resolve_supported_lang(lang_str)?;

		let mut parse_errors = Vec::new();
		let mut compiled_patterns = Vec::with_capacity(patterns.len());
		for pattern in &patterns {
			ct.heartbeat()?;
			match compile_pattern(pattern, selector.as_deref(), &strictness, language) {
				Ok(compiled) => compiled_patterns.push(compiled),
				Err(err) => parse_errors.push(format!("{pattern}: {err}")),
			}
		}

		let retained_capacity = retained_find_capacity(normalized_offset, normalized_limit);
		let mut retained_matches = BinaryHeap::new();
		let mut total_matches = 0u32;
		let mut match_sequence = 0u64;
		if !compiled_patterns.is_empty() {
			let ast = language.ast_grep(&source);
			if ast.root().dfs().any(|node| node.is_error()) {
				parse_errors.push("parse error (syntax tree contains error nodes)".to_string());
			}
			for pattern in &compiled_patterns {
				ct.heartbeat()?;
				for matched in ast.root().find_all(pattern.clone()) {
					ct.heartbeat()?;
					total_matches = total_matches.saturating_add(1);
					let range = matched.range();
					let start = matched.start_pos();
					let end = matched.end_pos();
					let key = AstFindOrderKey {
						path:         String::new(),
						start_line:   to_u32(start.line().saturating_add(1)),
						start_column: to_u32(start.column(matched.get_node()).saturating_add(1)),
						end_line:     to_u32(end.line().saturating_add(1)),
						end_column:   to_u32(end.column(matched.get_node()).saturating_add(1)),
						byte_start:   to_u32(range.start),
						byte_end:     to_u32(range.end),
						sequence:     match_sequence,
					};
					match_sequence = match_sequence.saturating_add(1);
					if should_retain_match(&retained_matches, retained_capacity, &key) {
						let meta_variables = if include_meta {
							Some(HashMap::<String, String>::from(matched.get_env().clone()))
						} else {
							None
						};
						retain_bounded_match(
							&mut retained_matches,
							retained_capacity,
							RetainedAstFindMatch {
								key,
								text: matched.text().into_owned(),
								meta_variables,
							},
						);
					}
				}
			}
		}

		let (matches, limit_reached) =
			page_retained_matches(retained_matches, normalized_offset, normalized_limit);
		let matches = matches
			.into_iter()
			.map(retained_to_find_match)
			.collect::<Vec<_>>();

		Ok(AstMatchResult {
			matches,
			total_matches,
			limit_reached,
			parse_errors: (!parse_errors.is_empty()).then_some(parse_errors),
		})
	})
}

/// Apply ast-grep rewrite rules to matching files; honors `dryRun` and returns
/// a promise.
#[napi]
pub fn ast_edit(options: AstReplaceOptions<'_>) -> task::Promise<AstReplaceResult> {
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
	} = options;

	let ct = task::CancelToken::new(timeout_ms, signal);
	task::blocking("ast_edit", ct, move |ct| {
		ast_edit_blocking(
			ct,
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
		)
	})
}

#[allow(
	clippy::too_many_arguments,
	reason = "napi-exposed wrapper mirrors the JS-facing argument list"
)]
fn ast_edit_blocking(
	ct: task::CancelToken,
	rewrites: Option<HashMap<String, String>>,
	lang: Option<String>,
	path: Option<String>,
	glob: Option<String>,
	selector: Option<String>,
	strictness: Option<AstMatchStrictness>,
	dry_run: Option<bool>,
	max_replacements: Option<u32>,
	max_files: Option<u32>,
	fail_on_parse_error: Option<bool>,
) -> Result<AstReplaceResult> {
	let rewrite_rules = normalize_rewrite_map(rewrites)?;
	let strictness = resolve_strictness(strictness);
	let dry_run = dry_run.unwrap_or(true);
	let max_replacements = max_replacements.unwrap_or(u32::MAX).max(1);
	let max_files = max_files.unwrap_or(u32::MAX).max(1);
	let fail_on_parse_error = fail_on_parse_error.unwrap_or(false);

	let lang_str = lang.as_deref().map(str::trim).filter(|v| !v.is_empty());
	let candidates: Vec<_> = collect_candidates(path, glob.as_deref(), &ct)?
		.into_iter()
		.filter(|candidate| is_supported_file(&candidate.absolute_path, lang_str))
		.collect();
	if let Some(explicit) = lang_str {
		resolve_supported_lang(explicit)?;
	} else if candidates.is_empty() {
		return Err(Error::from_reason(
			"ast_edit found no supported source files for the given path/glob".to_string(),
		));
	}

	let (resolved_candidates, languages) = resolve_candidates_for_find(candidates, lang_str, &ct)?;
	let files_searched = to_u32(resolved_candidates.len());

	let mut parse_errors = Vec::new();
	let mut compiled_rules: Vec<CompiledRewriteRule> = Vec::with_capacity(rewrite_rules.len());
	for (pattern, rewrite) in rewrite_rules {
		ct.heartbeat()?;
		let mut compiled_by_lang = HashMap::with_capacity(languages.len());
		let mut compile_errors_by_lang = HashMap::new();
		for (lang_key, &language) in &languages {
			ct.heartbeat()?;
			match compile_pattern(&pattern, selector.as_deref(), &strictness, language) {
				Ok(compiled) => {
					compiled_by_lang.insert(lang_key.clone(), compiled);
				},
				Err(err) => {
					compile_errors_by_lang.insert(lang_key.clone(), err.to_string());
				},
			}
		}
		// A pattern that parses in NO discovered language is a genuine pattern
		// error; failing in only some languages of a mixed tree is expected (the
		// pattern targets one language) and surfaces per skipped file below.
		if compiled_by_lang.is_empty() && !languages.is_empty() {
			let mut entries: Vec<_> = compile_errors_by_lang.iter().collect();
			entries.sort_by_key(|(lang_key, _)| lang_key.as_str());
			if fail_on_parse_error {
				let (_, err) = entries
					.first()
					.expect("compile failure recorded for every language");
				return Err(Error::from_reason(format!("{pattern}: {err}")));
			}
			for (lang_key, err) in entries {
				parse_errors.push(if languages.len() > 1 {
					format!("{pattern} ({lang_key}): {err}")
				} else {
					format!("{pattern}: {err}")
				});
			}
			continue;
		}
		compiled_rules.push(CompiledRewriteRule {
			pattern,
			rewrite,
			compiled_by_lang,
			compile_errors_by_lang,
		});
	}
	if compiled_rules.is_empty() {
		return Ok(AstReplaceResult {
			file_changes: vec![],
			total_replacements: 0,
			files_touched: 0,
			files_searched,
			applied: !dry_run,
			limit_reached: false,
			parse_errors: (!parse_errors.is_empty()).then_some(parse_errors),
			changes: vec![],
		});
	}

	let mut changes = Vec::new();
	let mut file_counts: BTreeMap<String, u32> = BTreeMap::new();
	let mut files_touched = 0u32;
	let mut limit_reached = false;
	// Stage writes in memory so a later compute error cannot leave earlier
	// files partially modified on disk; flush only after the whole pass succeeds.
	let mut pending_writes: Vec<PendingWrite> = Vec::new();

	for resolved in &resolved_candidates {
		ct.heartbeat()?;
		let ResolvedCandidate { candidate, language, language_error } = resolved;
		if let Some(error) = language_error.as_deref() {
			if fail_on_parse_error {
				return Err(Error::from_reason(format!("{}: {error}", candidate.display_path)));
			}
			parse_errors.push(format!("{}: {error}", candidate.display_path));
			continue;
		}
		let Some(language) = *language else {
			continue;
		};
		let lang_key = language.canonical_name();

		let mut runnable_rules: Vec<(&str, &Pattern)> = Vec::new();
		for rule in &compiled_rules {
			ct.heartbeat()?;
			if let Some(error) = rule.compile_errors_by_lang.get(lang_key) {
				parse_errors.push(format!("{}: {}: {error}", rule.pattern, candidate.display_path));
				continue;
			}
			if let Some(compiled) = rule.compiled_by_lang.get(lang_key) {
				runnable_rules.push((rule.rewrite.as_str(), compiled));
			}
		}
		if runnable_rules.is_empty() {
			continue;
		}

		let source = match std::fs::read_to_string(&candidate.absolute_path) {
			Ok(source) => source,
			Err(err) => {
				if fail_on_parse_error {
					return Err(Error::from_reason(format!("{}: {err}", candidate.display_path)));
				}
				parse_errors.push(format!("{}: {err}", candidate.display_path));
				continue;
			},
		};

		let ast = language.ast_grep(&source);
		if ast.root().dfs().any(|node| node.is_error()) {
			let parse_issue =
				format!("{}: parse error (syntax tree contains error nodes)", candidate.display_path);
			if fail_on_parse_error {
				return Err(Error::from_reason(parse_issue));
			}
			parse_errors.push(parse_issue);
			continue;
		}

		let mut file_changes = Vec::new();
		let mut reached_max_replacements = false;
		'patterns: for &(rewrite, compiled) in &runnable_rules {
			for matched in ast.root().find_all(compiled.clone()) {
				ct.heartbeat()?;
				let edit = matched.replace_by(rewrite);
				// Multiple rules matching the same node with the same output are one
				// deterministic edit; list and count it once instead of staging a
				// duplicate that trips the apply-time overlap check.
				let duplicate = file_changes.iter().any(|entry: &PendingFileChange| {
					entry.edit.position == edit.position
						&& entry.edit.deleted_length == edit.deleted_length
						&& entry.edit.inserted_text == edit.inserted_text
				});
				if duplicate {
					continue;
				}
				if changes.len() + file_changes.len() >= max_replacements as usize {
					limit_reached = true;
					reached_max_replacements = true;
					break 'patterns;
				}
				let range = matched.range();
				let start = matched.start_pos();
				let end = matched.end_pos();
				let after = String::from_utf8(edit.inserted_text.clone()).map_err(|err| {
					Error::from_reason(format!(
						"{}: replacement text is not valid UTF-8: {err}",
						candidate.display_path
					))
				})?;
				file_changes.push(PendingFileChange {
					change: AstReplaceChange {
						path: candidate.display_path.clone(),
						before: matched.text().into_owned(),
						after,
						byte_start: to_u32(range.start),
						byte_end: to_u32(range.end),
						deleted_length: to_u32(edit.deleted_length),
						start_line: to_u32(start.line().saturating_add(1)),
						start_column: to_u32(start.column(matched.get_node()).saturating_add(1)),
						end_line: to_u32(end.line().saturating_add(1)),
						end_column: to_u32(end.column(matched.get_node()).saturating_add(1)),
					},
					edit,
				});
			}
		}

		if file_changes.is_empty() {
			if reached_max_replacements {
				break;
			}
			continue;
		}
		if files_touched >= max_files {
			limit_reached = true;
			break;
		}
		files_touched = files_touched.saturating_add(1);
		file_counts.insert(candidate.display_path.clone(), to_u32(file_changes.len()));

		if !dry_run {
			let edits: Vec<Edit<String>> = file_changes
				.iter()
				.map(|entry| Edit {
					position:       entry.edit.position,
					deleted_length: entry.edit.deleted_length,
					inserted_text:  entry.edit.inserted_text.clone(),
				})
				.collect();
			let output = apply_edits(&source, &edits)?;
			if output != source {
				pending_writes
					.push(PendingWrite { absolute_path: candidate.absolute_path.clone(), output });
			}
		}

		changes.extend(file_changes.into_iter().map(|entry| entry.change));
		if reached_max_replacements {
			break;
		}
	}

	if !dry_run {
		for write in &pending_writes {
			ct.heartbeat()?;
			std::fs::write(&write.absolute_path, &write.output).map_err(|err| {
				Error::from_reason(format!("Failed to write {}: {err}", write.absolute_path.display()))
			})?;
		}
	}

	let file_changes = file_counts
		.into_iter()
		.map(|(path, count)| AstReplaceFileChange { path, count })
		.collect::<Vec<_>>();

	Ok(AstReplaceResult {
		file_changes,
		total_replacements: to_u32(changes.len()),
		files_touched,
		files_searched,
		applied: !dry_run,
		limit_reached,
		parse_errors: (!parse_errors.is_empty()).then_some(parse_errors),
		changes,
	})
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		path::PathBuf,
		time::{SystemTime, UNIX_EPOCH},
	};

	use super::*;

	struct TempTree {
		root: PathBuf,
	}

	impl Drop for TempTree {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.root);
		}
	}

	fn make_temp_tree() -> TempTree {
		let unique = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system time should be after UNIX_EPOCH")
			.as_nanos();
		let root = std::env::temp_dir().join(format!("pi-ast-glob-test-{unique}"));
		fs::create_dir_all(root.join("nested")).expect("temp nested dir should be created");
		fs::write(root.join("a.ts"), "const a = 1;\n").expect("temp file a.ts should be written");
		fs::write(root.join("nested").join("b.ts"), "const b = 2;\n")
			.expect("temp file nested/b.ts should be written");
		TempTree { root }
	}

	fn retained_test_match(line: u32) -> RetainedAstFindMatch {
		RetainedAstFindMatch {
			key:            AstFindOrderKey {
				path:         "file.ts".to_string(),
				start_line:   line,
				start_column: 1,
				end_line:     line,
				end_column:   2,
				byte_start:   line - 1,
				byte_end:     line,
				sequence:     u64::from(line),
			},
			text:           String::new(),
			meta_variables: None,
		}
	}

	#[test]
	fn retained_find_matches_keep_only_page_window() {
		let capacity = retained_find_capacity(1, 2);
		let mut retained = BinaryHeap::new();
		let mut materialized_payloads = 0usize;
		for line in 1..=100 {
			let candidate = retained_test_match(line);
			if should_retain_match(&retained, capacity, &candidate.key) {
				materialized_payloads += 1;
				retain_bounded_match(&mut retained, capacity, candidate);
			}
		}

		let (page, limit_reached) = page_retained_matches(retained, 1, 2);
		let lines = page
			.into_iter()
			.map(|retained| retained.key.start_line)
			.collect::<Vec<_>>();

		assert_eq!(materialized_payloads, capacity);
		assert!(limit_reached);
		assert_eq!(lines, vec![2, 3]);
	}

	#[test]
	fn glob_star_matches_only_direct_children() {
		let tree = make_temp_tree();
		let ct = task::CancelToken::default();
		let candidates =
			collect_candidates(Some(tree.root.to_string_lossy().into_owned()), Some("*.ts"), &ct)
				.expect("candidate collection should succeed");
		let paths = candidates
			.into_iter()
			.map(|file| file.display_path)
			.collect::<Vec<_>>();
		assert_eq!(paths, vec!["a.ts".to_string()]);
	}

	#[test]
	fn glob_double_star_matches_recursively() {
		let tree = make_temp_tree();
		let ct = task::CancelToken::default();
		let candidates =
			collect_candidates(Some(tree.root.to_string_lossy().into_owned()), Some("**/*.ts"), &ct)
				.expect("candidate collection should succeed");
		let paths = candidates
			.into_iter()
			.map(|file| file.display_path)
			.collect::<Vec<_>>();
		assert_eq!(paths, vec!["a.ts".to_string(), "nested/b.ts".to_string()]);
	}

	fn make_mixed_temp_tree() -> TempTree {
		let unique = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system time should be after UNIX_EPOCH")
			.as_nanos();
		let root = std::env::temp_dir().join(format!("pi-ast-mixed-lang-test-{unique}"));
		fs::create_dir_all(&root).expect("temp mixed-lang dir should be created");
		fs::write(root.join("a.ts"), "const f = (x) => x;\n")
			.expect("temp file a.ts should be written");
		fs::write(root.join("b.rs"), "fn main() {}\n").expect("temp file b.rs should be written");
		TempTree { root }
	}

	#[test]
	fn ast_edit_rewrites_mixed_language_tree_per_file() {
		let tree = make_mixed_temp_tree();
		let a_path = tree.root.join("a.ts");
		let b_path = tree.root.join("b.rs");

		// The arrow pattern only matches TypeScript; the Rust file is searched in
		// its own language and left untouched instead of failing the whole call.
		let mut rewrites = HashMap::new();
		rewrites.insert("($X) => $X".to_string(), "identity".to_string());

		let result = ast_edit_blocking(
			task::CancelToken::default(),
			Some(rewrites),
			None,
			Some(tree.root.to_string_lossy().into_owned()),
			None,
			None,
			None,
			Some(false),
			None,
			None,
			None,
		)
		.expect("mixed-language tree should rewrite per file");

		assert_eq!(result.total_replacements, 1, "only the TypeScript file matches");
		assert_eq!(result.files_searched, 2);
		assert_eq!(
			fs::read_to_string(&a_path).expect("a.ts should be readable"),
			"const f = identity;\n",
		);
		assert_eq!(
			fs::read_to_string(&b_path).expect("b.rs should be readable"),
			"fn main() {}\n",
			"the Rust file must be untouched",
		);
	}

	#[test]
	fn resolves_supported_language_aliases() {
		assert_eq!(resolve_supported_lang("ts").ok(), Some(SupportLang::TypeScript));
		assert_eq!(resolve_supported_lang("jsx").ok(), Some(SupportLang::JavaScript));
		assert_eq!(resolve_supported_lang("rs").ok(), Some(SupportLang::Rust));
		assert_eq!(resolve_supported_lang("kotlin").ok(), Some(SupportLang::Kotlin));
		assert_eq!(resolve_supported_lang("bash").ok(), Some(SupportLang::Bash));
		assert_eq!(resolve_supported_lang("c").ok(), Some(SupportLang::C));
		assert_eq!(resolve_supported_lang("cpp").ok(), Some(SupportLang::Cpp));
		assert_eq!(resolve_supported_lang("tla").ok(), Some(SupportLang::Tlaplus));
		assert_eq!(resolve_supported_lang("pluscal").ok(), Some(SupportLang::Tlaplus));
		assert_eq!(resolve_supported_lang("emacs-lisp").ok(), Some(SupportLang::EmacsLisp));
		assert_eq!(resolve_supported_lang("elisp").ok(), Some(SupportLang::EmacsLisp));
		assert_eq!(resolve_supported_lang("el").ok(), Some(SupportLang::EmacsLisp));
		assert_eq!(resolve_supported_lang("f90").ok(), Some(SupportLang::Fortran));
		assert!(resolve_supported_lang("brainfuck").is_err());
	}

	#[test]
	fn applies_non_overlapping_edits() {
		let source = "const answer = 41;";
		let edits = vec![
			Edit::<String> { position: 6, deleted_length: 6, inserted_text: b"value".to_vec() },
			Edit::<String> { position: 15, deleted_length: 2, inserted_text: b"42".to_vec() },
		];
		let output = apply_edits(source, &edits).expect("edits should apply");
		assert_eq!(output, "const value = 42;");
	}

	#[test]
	fn rejects_overlapping_edits() {
		let source = "abcdef";
		let edits = vec![
			Edit::<String> { position: 1, deleted_length: 3, inserted_text: b"x".to_vec() },
			Edit::<String> { position: 2, deleted_length: 1, inserted_text: b"y".to_vec() },
		];
		assert!(apply_edits(source, &edits).is_err());
	}

	#[test]
	fn dedupes_byte_identical_edits() {
		let source = "abcdef";
		let edits = vec![
			Edit::<String> { position: 1, deleted_length: 3, inserted_text: b"x".to_vec() },
			Edit::<String> { position: 1, deleted_length: 3, inserted_text: b"x".to_vec() },
		];
		let output = apply_edits(source, &edits).expect("identical edits should collapse to one");
		assert_eq!(output, "axef");
	}

	#[test]
	fn ast_edit_dedupes_identical_matches_across_rules() {
		let unique = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system time should be after UNIX_EPOCH")
			.as_nanos();
		let root = std::env::temp_dir().join(format!("pi-ast-dedupe-{unique}"));
		fs::create_dir_all(&root).expect("temp dedupe dir should be created");
		let tree = TempTree { root };
		let file_path = tree.root.join("a.ts");
		fs::write(&file_path, "const b = foo(bar);\n").expect("temp file a.ts should be written");

		// Both rules match the same call node and produce the byte-identical
		// replacement; the deterministic edit must apply once, not error as an
		// ambiguous overlap.
		let mut rewrites = HashMap::new();
		rewrites.insert("foo($X)".to_string(), "qux($X)".to_string());
		rewrites.insert("foo(bar)".to_string(), "qux(bar)".to_string());

		let result = ast_edit_blocking(
			task::CancelToken::default(),
			Some(rewrites),
			Some("ts".to_string()),
			Some(tree.root.to_string_lossy().into_owned()),
			None,
			None,
			None,
			Some(false),
			None,
			None,
			None,
		)
		.expect("identical duplicate matches should apply cleanly");

		assert_eq!(result.total_replacements, 1, "duplicate match must be counted once");
		assert_eq!(
			fs::read_to_string(&file_path).expect("a.ts should be readable"),
			"const b = qux(bar);\n",
		);
	}

	fn make_apply_failure_tree() -> TempTree {
		let unique = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system time should be after UNIX_EPOCH")
			.as_nanos();
		let root = std::env::temp_dir().join(format!("pi-ast-apply-fail-{unique}"));
		fs::create_dir_all(&root).expect("temp apply-fail dir should be created");
		// `a.ts` rewrites cleanly under both rules (one applies, the other doesn't
		// match).
		fs::write(root.join("a.ts"), "const a = bar;\n").expect("temp file a.ts should be written");
		// `b.ts` matches both rules with nested ranges (`foo(bar)` contains `bar`),
		// so `apply_edits` rejects the combined edit set with an overlap error.
		fs::write(root.join("b.ts"), "const b = foo(bar);\n")
			.expect("temp file b.ts should be written");
		TempTree { root }
	}

	#[test]
	fn ast_edit_does_not_partially_write_when_apply_fails() {
		let tree = make_apply_failure_tree();
		let a_path = tree.root.join("a.ts");
		let b_path = tree.root.join("b.ts");
		let a_before = fs::read_to_string(&a_path).expect("a.ts should be readable");
		let b_before = fs::read_to_string(&b_path).expect("b.ts should be readable");

		let mut rewrites = HashMap::new();
		rewrites.insert("bar".to_string(), "baz".to_string());
		rewrites.insert("foo($X)".to_string(), "qux($X)".to_string());

		let result = ast_edit_blocking(
			task::CancelToken::default(),
			Some(rewrites),
			Some("ts".to_string()),
			Some(tree.root.to_string_lossy().into_owned()),
			None,
			None,
			None,
			Some(false),
			None,
			None,
			None,
		);
		assert!(result.is_err(), "expected ast_edit to error on overlapping edits");

		assert_eq!(
			fs::read_to_string(&a_path).expect("a.ts should still be readable"),
			a_before,
			"a.ts must not be written when the apply pass fails on a later file",
		);
		assert_eq!(
			fs::read_to_string(&b_path).expect("b.ts should still be readable"),
			b_before,
			"b.ts must remain unmodified after apply failure",
		);
	}
}
