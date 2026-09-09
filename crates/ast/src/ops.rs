use std::{
	collections::BTreeSet,
	fs, io,
	path::{Path, PathBuf},
	str,
};

use ast_grep_core::{
	MatchStrictness,
	matcher::{Pattern, PatternError},
	meta_var::MetaVariable,
	source::Edit,
	tree_sitter::LanguageExt,
};
use ignore::WalkBuilder;
use omp_core::Str;
use omp_walker::glob::CompiledGlobSet;
use smallvec::SmallVec;

use crate::{AstError, Result, language::SupportLang};

/// Pattern matching strictness exposed by the AST API.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AstMatchStrictness {
	/// Exact concrete-syntax matching.
	Cst,
	/// Ast-grep smart matching.
	Smart,
	/// Named AST-node matching.
	Ast,
	/// Relaxed AST matching.
	Relaxed,
	/// Signature-level matching.
	Signature,
	/// Template-style matching.
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

/// One structural source match and its source coordinates.
#[derive(Debug, Clone)]
pub struct AstMatch {
	/// One-based start line.
	pub line:       usize,
	/// One-based start column.
	pub column:     usize,
	/// One-based end line.
	pub end_line:   usize,
	/// One-based end column.
	pub end_column: usize,
	/// Inclusive start byte offset.
	pub byte_start: usize,
	/// Exclusive end byte offset.
	pub byte_end:   usize,
	/// Matched source text.
	pub text:       Str,
	/// Deterministically ordered metavariable captures.
	pub bindings:   Vec<AstBinding>,
}

/// One metavariable captured by a structural match.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct AstBinding {
	/// Pattern spelling, including `$` or `$$$`.
	pub name:  Str,
	/// Exact source text captured for the metavariable.
	pub value: Str,
}

/// A filesystem match with absolute and workspace-relative paths.
#[derive(Debug, Clone)]
pub struct MatchedFile {
	/// Absolute file path.
	pub absolute_path: PathBuf,
	/// Workspace-relative slash-separated path.
	pub relative_path: Str,
}

/// A replacement template paired with its compiled search patterns.
#[derive(Debug, Clone)]
pub struct CompiledRewrite {
	/// Replacement template.
	pub out:      Str,
	/// Compiled patterns that trigger this replacement.
	pub patterns: SmallVec<Pattern, 2>,
}

/// Resolves an optional API strictness to ast-grep strictness.
pub fn resolve_strictness(value: Option<AstMatchStrictness>) -> MatchStrictness {
	value.map_or(MatchStrictness::Smart, Into::into)
}

/// Returns supported language aliases as a comma-separated list.
pub fn supported_lang_list() -> String {
	SupportLang::sorted_aliases().join(", ")
}

/// Resolves a language alias or returns a descriptive error.
pub fn resolve_supported_lang(value: &str) -> Result<SupportLang> {
	SupportLang::from_alias(value).ok_or_else(|| AstError::UnsupportedLanguage {
		value:     Str::new(value),
		supported: Str::from(supported_lang_list()),
	})
}

/// Resolves an explicit language or infers one from a file path.
pub fn resolve_language(lang: Option<&str>, file_path: &Path) -> Result<SupportLang> {
	if let Some(lang) = lang.map(str::trim).filter(|lang| !lang.is_empty()) {
		return resolve_supported_lang(lang);
	}
	SupportLang::from_path(file_path)
		.ok_or_else(|| AstError::InferLanguageFailed { path: file_path.to_path_buf() })
}

/// Reports whether a file has an explicit or inferable language.
pub fn is_supported_file(file_path: &Path, explicit_lang: Option<&str>) -> bool {
	if explicit_lang.is_some() {
		return true;
	}
	resolve_language(None, file_path).is_ok()
}

/// Compiles one structural pattern with optional contextual selection.
pub fn compile_pattern(
	pattern: &str,
	selector: Option<&str>,
	strictness: &MatchStrictness,
	lang: SupportLang,
) -> Result<Pattern> {
	let selector = selector.map(str::trim).filter(|s| !s.is_empty());
	let mut compiled = if let Some(selector) = selector {
		Pattern::contextual(pattern, selector, lang)
			.map_err(|source| AstError::InvalidPattern { source })?
	} else {
		match Pattern::try_new(pattern, lang) {
			Ok(compiled) => compiled,
			Err(err @ PatternError::MultipleNode(_)) => {
				match compile_wrapped_fallback(pattern, strictness, lang) {
					Some(compiled) => return Ok(compiled),
					None => return Err(AstError::InvalidPattern { source: err }),
				}
			},
			Err(err) => return Err(AstError::InvalidPattern { source: err }),
		}
	};
	compiled.strictness = strictness.clone();
	Ok(compiled)
}

/// Language-specific wrapper template used to turn a multi-node fragment into a
/// single selectable node. `None` for languages without a template — those keep
/// the original `MultipleNode` error.
const fn wrapper_template(lang: SupportLang) -> Option<(&'static str, &'static str, &'static str)> {
	// (prefix, suffix, selector-kind); the fragment is spliced between
	// prefix/suffix.
	match lang {
		SupportLang::Json => Some(("{", "}", "pair")),
		_ => None,
	}
}

/// Retry a fragment that failed as `MultipleNode` by wrapping it in a minimal
/// valid context and selecting the node kind that spans it. Returns the
/// compiled pattern (with `strictness` applied) or `None` if this language has
/// no template or the wrapped form still fails to compile.
fn compile_wrapped_fallback(
	pattern: &str,
	strictness: &MatchStrictness,
	lang: SupportLang,
) -> Option<Pattern> {
	let (prefix, suffix, selector) = wrapper_template(lang)?;
	// JSON only accepts a bare `$V` inside a string, so quote value-position
	// metavars; ast-grep still reads the quoted `"$V"` as capture `V`.
	let prepared = if lang == SupportLang::Json {
		quote_bare_metavars(pattern)
	} else {
		pattern.to_string()
	};
	let context = format!("{prefix} {prepared} {suffix}");
	let mut compiled = Pattern::contextual(&context, selector, lang).ok()?;
	compiled.strictness = strictness.clone();
	Some(compiled)
}

/// Wrap bare `$NAME` / `$$$NAME` metavars in double quotes so a JSON wrapper
/// parses. Metavars already inside a string literal (including `"$V"`) are left
/// untouched; a quote toggles in/out of string context.
fn quote_bare_metavars(pattern: &str) -> String {
	let bytes = pattern.as_bytes();
	let mut out = String::with_capacity(pattern.len() + 4);
	let mut in_string = false;
	let mut index = 0;
	while index < bytes.len() {
		let byte = bytes[index];
		if byte == b'"' && (index == 0 || bytes[index - 1] != b'\\') {
			in_string = !in_string;
			out.push('"');
			index += 1;
			continue;
		}
		if byte == b'$' && !in_string {
			// Consume `$`, an optional `$$` ellipsis, then the identifier.
			let start = index;
			index += 1;
			if bytes[index..].starts_with(b"$$") {
				index += 2;
			}
			while index < bytes.len() && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
			{
				index += 1;
			}
			out.push('"');
			out.push_str(&pattern[start..index]);
			out.push('"');
			continue;
		}
		// Copy this byte's full UTF-8 char so multi-byte content is preserved.
		let char_end = next_char_boundary(bytes, index);
		out.push_str(&pattern[index..char_end]);
		index = char_end;
	}
	out
}

/// Byte index of the end of the UTF-8 character starting at `index`.
const fn next_char_boundary(bytes: &[u8], index: usize) -> usize {
	let mut end = index + 1;
	while end < bytes.len() && (bytes[end] & 0b1100_0000) == 0b1000_0000 {
		end += 1;
	}
	end
}

/// Compiles search patterns, including language-specific contextual variants.
pub fn compile_search_patterns(
	pattern: &str,
	language: SupportLang,
) -> Result<SmallVec<Pattern, 2>, PatternError> {
	let mut compiled = SmallVec::new();
	match Pattern::try_new(pattern, language) {
		Ok(compiled_pattern) => compiled.push(compiled_pattern),
		// Multi-node fragments (e.g. `"key": $V`) get the same auto-wrap fallback
		// as the edit path; other errors propagate unchanged.
		Err(err @ PatternError::MultipleNode(_)) => {
			match compile_wrapped_fallback(pattern, &MatchStrictness::Smart, language) {
				Some(pattern) => compiled.push(pattern),
				None => return Err(err),
			}
		},
		Err(err) => return Err(err),
	}
	if language == SupportLang::Rust {
		let trimmed = pattern.trim_end();
		if let Some(contextual) = compile_rust_contextual_pattern(trimmed) {
			compiled.push(contextual);
		}
	}
	if compiled.iter().any(Pattern::has_error) {
		return Err(PatternError::Parse(pattern.to_owned()));
	}
	Ok(compiled)
}

/// Compiles ordered pattern/replacement rules.
pub fn compile_rewrite_rules(
	rules: &[(String, String)],
	language: SupportLang,
) -> Result<Vec<CompiledRewrite>, (usize, PatternError)> {
	rules
		.iter()
		.enumerate()
		.map(|(index, (pattern, out))| {
			compile_search_patterns(pattern, language)
				.map(|patterns| CompiledRewrite { out: Str::new(out), patterns })
				.map_err(|error| (index, error))
		})
		.collect()
}

/// Collects all matches for compiled patterns in source order per pattern.
///
/// The boolean reports whether the parsed syntax tree contains error nodes;
/// callers surface that as a non-fatal parse advisory while retaining matches
/// from the valid parts of the tree.
pub fn collect_matches_with_parse_status(
	source: &str,
	language: SupportLang,
	patterns: &[Pattern],
) -> (Vec<AstMatch>, bool) {
	let ast = language.ast_grep(source);
	let has_parse_errors = ast.root().dfs().any(|node| node.is_error());
	let mut matches = Vec::new();
	for pattern in patterns {
		for matched in ast.root().find_all(pattern.clone()) {
			let start = matched.start_pos();
			let end = matched.end_pos();
			let range = matched.range();
			let node = matched.get_node();
			let environment = matched.get_env();
			let mut bindings = environment
				.get_matched_variables()
				.filter_map(|variable| {
					let name = match &variable {
						MetaVariable::Capture(name, _) => format!("${name}"),
						MetaVariable::MultiCapture(name) => format!("$$${name}"),
						MetaVariable::Dropped(_) | MetaVariable::Multiple => return None,
					};
					let value = environment.get_var_bytes(&variable)?;
					Some(AstBinding {
						name:  Str::new(name),
						value: Str::new(String::from_utf8_lossy(value)),
					})
				})
				.collect::<Vec<_>>();
			bindings.sort_unstable_by(|left, right| left.name.cmp(&right.name));
			matches.push(AstMatch {
				line: start.line() + 1,
				column: start.column(node) + 1,
				end_line: end.line() + 1,
				end_column: end.column(node) + 1,
				byte_start: range.start,
				byte_end: range.end,
				text: Str::new(matched.text()),
				bindings,
			});
		}
	}
	(matches, has_parse_errors)
}

/// Collects all matches for compiled patterns in source order per pattern.
pub fn collect_matches(source: &str, language: SupportLang, patterns: &[Pattern]) -> Vec<AstMatch> {
	collect_matches_with_parse_status(source, language, patterns).0
}

/// Applies compiled rewrite operations and returns source plus replacement
/// count.
pub fn rewrite_source(
	source: &str,
	language: SupportLang,
	ops: &[CompiledRewrite],
) -> Result<(String, u32)> {
	rewrite_source_with_parse_status(source, language, ops)
		.map(|(source, replacements, _)| (source, replacements))
}

/// Applies compiled rewrite operations and reports whether the original syntax
/// tree contained parser error nodes.
///
/// Rewrites still apply to structurally valid subtrees when the surrounding
/// file has parser errors; callers can surface the parse status separately
/// from the exact replacement result.
pub fn rewrite_source_with_parse_status(
	source: &str,
	language: SupportLang,
	ops: &[CompiledRewrite],
) -> Result<(String, u32, bool)> {
	let ast = language.ast_grep(source);
	let has_parse_errors = ast.root().dfs().any(|node| node.is_error());
	let mut edits = Vec::new();
	for op in ops {
		for pattern in &op.patterns {
			edits.extend(ast.root().replace_all(pattern.clone(), op.out.as_str()));
		}
	}
	let (updated, replacements) = apply_edits_count(source, &edits)?;
	Ok((updated, replacements, has_parse_errors))
}

/// Applies deterministic, non-overlapping ast-grep edits to UTF-8 content.
pub fn apply_edits(content: &str, edits: &[Edit<String>]) -> Result<String> {
	apply_edits_count(content, edits).map(|(output, _)| output)
}

/// Applies deterministic edits and returns the number of unique replacements.
fn apply_edits_count(content: &str, edits: &[Edit<String>]) -> Result<(String, u32)> {
	let mut sorted: SmallVec<&Edit<String>, 8> = edits.iter().collect();
	sorted.sort_unstable_by(|a, b| {
		a.position
			.cmp(&b.position)
			.then(a.deleted_length.cmp(&b.deleted_length))
			.then(a.inserted_text.cmp(&b.inserted_text))
	});
	// Byte-identical edits (same span, same replacement) are one deterministic
	// edit: multiple patterns matching the same node collapse instead of
	// tripping the overlap check. Only divergent overlaps are ambiguous.
	sorted.dedup_by(|a, b| {
		a.position == b.position
			&& a.deleted_length == b.deleted_length
			&& a.inserted_text == b.inserted_text
	});
	let mut prev_end = 0usize;
	let mut prev_start = None;
	for edit in &sorted {
		if prev_start == Some(edit.position) || edit.position < prev_end {
			return Err(AstError::OverlappingReplacements);
		}
		let end = edit
			.position
			.checked_add(edit.deleted_length)
			.ok_or(AstError::EditRangeOutOfBounds)?;
		if end > content.len()
			|| !content.is_char_boundary(edit.position)
			|| !content.is_char_boundary(end)
		{
			return Err(AstError::EditRangeOutOfBounds);
		}
		str::from_utf8(&edit.inserted_text)
			.map_err(|source| AstError::NonUtf8Replacement { source })?;
		prev_start = Some(edit.position);
		prev_end = end;
	}

	let replacements = u32::try_from(sorted.len()).unwrap_or(u32::MAX);
	let mut output = content.to_string();
	for edit in sorted.into_iter().rev() {
		let end = edit.position + edit.deleted_length;
		let replacement = str::from_utf8(&edit.inserted_text)
			.expect("replacement UTF-8 was validated before applying edits");
		output.replace_range(edit.position..end, replacement);
	}
	Ok((output, replacements))
}

/// Walks files, directories, and glob targets, optionally intersecting every
/// target with a walk-relative glob filter.
pub fn collect_matched_files_filtered(
	cwd: &Path,
	patterns: &[String],
	filter: Option<&str>,
) -> Result<Vec<MatchedFile>, io::Error> {
	collect_matched_files_filtered_bounded(cwd, patterns, filter, usize::MAX)
}

/// Walks files, directories, and glob targets, retaining at most `maximum + 1`
/// files so callers can report a breached bound without traversing the rest of
/// the tree.
pub fn collect_matched_files_filtered_bounded(
	cwd: &Path,
	patterns: &[String],
	filter: Option<&str>,
	maximum: usize,
) -> Result<Vec<MatchedFile>, io::Error> {
	let root = fs::canonicalize(cwd)?;
	let filter = filter
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(|value| {
			CompiledGlobSet::new([value])
				.map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))
		})
		.transpose()?;
	let mut paths = BTreeSet::new();
	let mut saw_existing_root = false;
	let default = ".".to_owned();
	let patterns = if patterns.is_empty() {
		std::slice::from_ref(&default)
	} else {
		patterns
	};

	for pattern in patterns {
		let pattern = pattern.trim();
		if pattern.is_empty() {
			continue;
		}
		if has_glob_syntax(pattern) {
			let matcher = CompiledGlobSet::new([pattern])
				.map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
			let limit_reached =
				collect_walk_files(&root, &root, Some(&matcher), filter.as_ref(), &mut paths, maximum)?;
			saw_existing_root = true;
			if limit_reached {
				break;
			}
			continue;
		}

		let candidate = Path::new(pattern);
		let candidate = if candidate.is_absolute() {
			candidate.to_path_buf()
		} else {
			root.join(candidate)
		};
		let candidate = match fs::canonicalize(&candidate) {
			Ok(candidate) if candidate.starts_with(&root) => candidate,
			Ok(_) => {
				return Err(io::Error::new(
					io::ErrorKind::PermissionDenied,
					"AST target escapes the workspace root",
				));
			},
			Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
			Err(error) => return Err(error),
		};
		let metadata = fs::metadata(&candidate)?;
		saw_existing_root = true;
		if metadata.is_file() {
			let relative = candidate.strip_prefix(&root).unwrap_or(&candidate);
			let file_name = candidate
				.file_name()
				.and_then(|name| name.to_str())
				.unwrap_or_default();
			if filter.as_ref().is_none_or(|matcher| {
				matcher.matches(&relative.to_string_lossy()) || matcher.matches(file_name)
			}) {
				paths.insert(candidate);
				if paths.len() > maximum {
					break;
				}
			}
		} else if metadata.is_dir()
			&& collect_walk_files(&root, &candidate, None, filter.as_ref(), &mut paths, maximum)?
		{
			break;
		}
	}

	if !saw_existing_root {
		return Err(io::Error::new(io::ErrorKind::NotFound, "no AST search target exists"));
	}

	Ok(paths
		.into_iter()
		.map(|absolute_path| {
			let relative_path = absolute_path
				.strip_prefix(&root)
				.unwrap_or(&absolute_path)
				.to_string_lossy();
			let relative_path = if relative_path.contains('\\') {
				Str::from(relative_path.replace('\\', "/"))
			} else {
				Str::new(relative_path.as_ref())
			};
			MatchedFile { absolute_path, relative_path }
		})
		.collect())
}

/// Walks a directory and collects files matched by paths or glob patterns.
pub fn collect_matched_files(
	cwd: &Path,
	patterns: &[String],
) -> Result<Vec<MatchedFile>, io::Error> {
	collect_matched_files_filtered(cwd, patterns, None)
}

fn collect_walk_files(
	root: &Path,
	walk_root: &Path,
	target: Option<&CompiledGlobSet>,
	filter: Option<&CompiledGlobSet>,
	files: &mut BTreeSet<PathBuf>,
	maximum: usize,
) -> Result<bool, io::Error> {
	let mut builder = WalkBuilder::new(walk_root);
	builder
		.hidden(false)
		.git_ignore(true)
		.git_global(true)
		.git_exclude(true);
	for entry in builder.build() {
		let entry = entry.map_err(io::Error::other)?;
		if !entry.file_type().is_some_and(|kind| kind.is_file()) {
			continue;
		}
		let absolute = entry.into_path();
		let root_relative = absolute.strip_prefix(root).unwrap_or(&absolute);
		let walk_relative = absolute.strip_prefix(walk_root).unwrap_or(&absolute);
		let root_relative = root_relative.to_string_lossy();
		let walk_relative = walk_relative.to_string_lossy();
		if target.is_some_and(|matcher| !matcher.matches(&root_relative)) {
			continue;
		}
		if filter.is_some_and(|matcher| {
			!matcher.matches(&walk_relative)
				&& !absolute
					.file_name()
					.and_then(|name| name.to_str())
					.is_some_and(|name| matcher.matches(name))
		}) {
			continue;
		}
		files.insert(absolute);
		if files.len() > maximum {
			return Ok(true);
		}
	}
	Ok(false)
}

/// Reports whether a path pattern contains supported glob syntax.
pub fn has_glob_syntax(pattern: &str) -> bool {
	pattern.contains('*') || pattern.contains('?') || pattern.contains('[')
}

fn compile_rust_contextual_pattern(pattern: &str) -> Option<Pattern> {
	let language = SupportLang::Rust;
	let context = format!("fn __rwp_wrapper() {{ {pattern}; }}");
	let ast = language.ast_grep(&context);
	let selector = ast.root().find("expression_statement")?;
	Pattern::contextual(pattern, selector.kind().as_ref(), language).ok()
}

#[cfg(test)]
mod tests {
	use ast_grep_core::source::Edit;
	use omp_core::Str;

	use super::{
		SupportLang, apply_edits, compile_rewrite_rules, compile_search_patterns,
		rewrite_source_with_parse_status,
	};

	#[test]
	fn compile_search_patterns_compiles_rust_patterns() {
		let patterns = compile_search_patterns("foo($$$ARGS)", SupportLang::Rust)
			.expect("rust pattern should compile");
		assert!(!patterns.is_empty());
	}

	#[test]
	fn collect_matches_retains_sorted_metavariable_bindings() {
		let patterns = compile_search_patterns("const $NAME = $VALUE", SupportLang::TypeScript)
			.expect("TypeScript pattern should compile");
		let matches =
			super::collect_matches("const answer = 42;", SupportLang::TypeScript, &patterns);
		assert_eq!(matches.len(), 1);
		assert_eq!(matches[0].bindings, [
			super::AstBinding { name: Str::new("$NAME"), value: Str::new("answer") },
			super::AstBinding { name: Str::new("$VALUE"), value: Str::new("42") },
		]);
	}

	#[test]
	fn repeated_metavariable_requires_identical_structure_during_rewrite() {
		let rules = compile_rewrite_rules(
			&[("$A && $A()".to_owned(), "$A?.()".to_owned())],
			SupportLang::TypeScript,
		)
		.expect("rewrite compiles");
		let (updated, replacements, parse_errors) = rewrite_source_with_parse_status(
			"same && same(); left && right();",
			SupportLang::TypeScript,
			&rules,
		)
		.expect("rewrite succeeds");
		assert_eq!(updated, "same?.(); left && right();");
		assert_eq!(replacements, 1);
		assert!(!parse_errors);
	}

	#[test]
	fn rewrite_ops_are_one_exact_non_cascading_transaction() {
		let rules = compile_rewrite_rules(
			&[
				("old($A)".to_owned(), "middle($A)".to_owned()),
				("middle($A)".to_owned(), "new($A)".to_owned()),
			],
			SupportLang::TypeScript,
		)
		.expect("rewrites compile");
		let (updated, replacements, _) =
			rewrite_source_with_parse_status("old(1);", SupportLang::TypeScript, &rules)
				.expect("rewrite succeeds");
		assert_eq!(updated, "middle(1);");
		assert_eq!(replacements, 1);
	}

	#[test]
	fn rewrite_reports_original_parser_error_nodes() {
		let rules = compile_rewrite_rules(
			&[("old($A)".to_owned(), "new($A)".to_owned())],
			SupportLang::TypeScript,
		)
		.expect("rewrite compiles");
		let (_, _, parse_errors) = rewrite_source_with_parse_status(
			"old(1); const broken = ;",
			SupportLang::TypeScript,
			&rules,
		)
		.expect("valid subtree rewrites");
		assert!(parse_errors);
	}

	#[test]
	fn apply_edits_rejects_overlaps() {
		let source = "abcdef";
		let edits = vec![
			Edit::<String> { position: 1, deleted_length: 3, inserted_text: b"x".to_vec() },
			Edit::<String> { position: 2, deleted_length: 1, inserted_text: b"y".to_vec() },
		];
		assert!(apply_edits(source, &edits).is_err());
	}

	#[test]
	fn apply_edits_rejects_divergent_insertions_at_one_position() {
		let source = "ab";
		let edits = vec![
			Edit::<String> { position: 1, deleted_length: 0, inserted_text: b"x".to_vec() },
			Edit::<String> { position: 1, deleted_length: 0, inserted_text: b"y".to_vec() },
		];
		assert!(apply_edits(source, &edits).is_err());
	}

	#[test]
	fn apply_edits_dedupes_identical_edits() {
		let source = "abcdef";
		let edits = vec![
			Edit::<String> { position: 1, deleted_length: 3, inserted_text: b"x".to_vec() },
			Edit::<String> { position: 1, deleted_length: 3, inserted_text: b"x".to_vec() },
		];
		let output = apply_edits(source, &edits).expect("identical edits should collapse to one");
		assert_eq!(output, "axef");
	}
}
