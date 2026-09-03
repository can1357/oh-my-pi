use std::path::{Path, PathBuf};

use anyhow::{Result, anyhow};
use ast_grep_core::{
	MatchStrictness,
	matcher::{Pattern, PatternError},
	source::Edit,
	tree_sitter::LanguageExt,
};
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;

use crate::language::SupportLang;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AstMatchStrictness {
	Cst,
	Smart,
	Ast,
	Relaxed,
	Signature,
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

#[derive(Debug, Clone)]
pub struct AstMatch {
	pub line:       usize,
	pub column:     usize,
	pub end_line:   usize,
	pub end_column: usize,
	pub byte_start: usize,
	pub byte_end:   usize,
	pub text:       String,
}

#[derive(Debug, Clone)]
pub struct MatchedFile {
	pub absolute_path: PathBuf,
	pub relative_path: String,
}

#[derive(Debug, Clone)]
pub struct CompiledRewrite {
	pub out:      String,
	pub patterns: Vec<Pattern>,
}

#[must_use]
pub fn resolve_strictness(value: Option<AstMatchStrictness>) -> MatchStrictness {
	value.map_or(MatchStrictness::Smart, Into::into)
}

#[must_use]
pub fn supported_lang_list() -> String {
	SupportLang::sorted_aliases().join(", ")
}

pub fn resolve_supported_lang(value: &str) -> Result<SupportLang> {
	SupportLang::from_alias(value).ok_or_else(|| {
		anyhow!("Unsupported language '{value}'. Supported: {}", supported_lang_list())
	})
}

pub fn resolve_language(lang: Option<&str>, file_path: &Path) -> Result<SupportLang> {
	if let Some(lang) = lang.map(str::trim).filter(|lang| !lang.is_empty()) {
		return resolve_supported_lang(lang);
	}
	SupportLang::from_path(file_path).ok_or_else(|| {
		anyhow!(
			"Unable to infer language from file extension: {}. Specify `lang` explicitly.",
			file_path.display()
		)
	})
}

#[must_use]
pub fn is_supported_file(file_path: &Path, explicit_lang: Option<&str>) -> bool {
	if explicit_lang.is_some() {
		return true;
	}
	resolve_language(None, file_path).is_ok()
}

pub fn compile_pattern(
	pattern: &str,
	selector: Option<&str>,
	strictness: &MatchStrictness,
	lang: SupportLang,
) -> Result<Pattern> {
	let selector = selector.map(str::trim).filter(|s| !s.is_empty());
	let mut compiled = if let Some(selector) = selector {
		Pattern::contextual(pattern, selector, lang)
			.map_err(|err| anyhow!("Invalid pattern: {err}"))?
	} else {
		match Pattern::try_new(pattern, lang) {
			Ok(compiled) => compiled,
			// A fragment like `"key": $V` parses to multiple root nodes and is
			// rejected as `MultipleNode`; auto-wrap it in a single-node context
			// before giving up. Any other error, or a failed fallback, keeps the
			// original message so genuinely-bad patterns behave as before.
			Err(err @ PatternError::MultipleNode(_)) => {
				match compile_wrapped_fallback(pattern, strictness, lang) {
					Some(compiled) => return Ok(compiled),
					None => return Err(anyhow!("Invalid pattern: {err}")),
				}
			},
			Err(err) => return Err(anyhow!("Invalid pattern: {err}")),
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

pub fn compile_search_patterns(
	pattern: &str,
	language: SupportLang,
) -> Result<Vec<Pattern>, PatternError> {
	let mut compiled = match Pattern::try_new(pattern, language) {
		Ok(compiled) => vec![compiled],
		// Multi-node fragments (e.g. `"key": $V`) get the same auto-wrap fallback
		// as the edit path; other errors propagate unchanged.
		Err(err @ PatternError::MultipleNode(_)) => {
			match compile_wrapped_fallback(pattern, &MatchStrictness::Smart, language) {
				Some(compiled) => vec![compiled],
				None => return Err(err),
			}
		},
		Err(err) => return Err(err),
	};
	if language == SupportLang::Rust {
		let trimmed = pattern.trim_end();
		if let Some(contextual) = compile_rust_contextual_pattern(trimmed) {
			compiled.push(contextual);
		}
	}
	Ok(compiled)
}

pub fn compile_rewrite_rules(
	rules: &[(String, String)],
	language: SupportLang,
) -> Result<Vec<CompiledRewrite>, (usize, PatternError)> {
	rules
		.iter()
		.enumerate()
		.map(|(index, (pattern, out))| {
			compile_search_patterns(pattern, language)
				.map(|patterns| CompiledRewrite { out: out.clone(), patterns })
				.map_err(|error| (index, error))
		})
		.collect()
}

#[must_use]
pub fn collect_matches(source: &str, language: SupportLang, patterns: &[Pattern]) -> Vec<AstMatch> {
	let ast = language.ast_grep(source);
	let mut matches = Vec::new();
	for pattern in patterns {
		for matched in ast.root().find_all(pattern.clone()) {
			let start = matched.start_pos();
			let end = matched.end_pos();
			let range = matched.range();
			let node = matched.get_node();
			matches.push(AstMatch {
				line:       start.line() + 1,
				column:     start.column(node) + 1,
				end_line:   end.line() + 1,
				end_column: end.column(node) + 1,
				byte_start: range.start,
				byte_end:   range.end,
				text:       matched.text().into_owned(),
			});
		}
	}
	matches
}

pub fn rewrite_source(
	source: &str,
	language: SupportLang,
	ops: &[CompiledRewrite],
) -> Result<(String, u32), String> {
	let mut ast = language.ast_grep(source);
	let mut replacements = 0_u32;
	for op in ops {
		for pattern in &op.patterns {
			let edits = ast.root().replace_all(pattern.clone(), op.out.as_str());
			if edits.is_empty() {
				continue;
			}
			replacements = replacements.saturating_add(edits.len() as u32);
			let updated =
				apply_edits(ast.root().text().as_ref(), &edits).map_err(|error| error.to_string())?;
			ast = language.ast_grep(updated);
		}
	}
	Ok((ast.root().text().into_owned(), replacements))
}

pub fn apply_edits(content: &str, edits: &[Edit<String>]) -> Result<String> {
	let mut sorted: Vec<&Edit<String>> = edits.iter().collect();
	sorted.sort_by(|a, b| {
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
	for edit in &sorted {
		if edit.position < prev_end {
			return Err(anyhow!(
				"Overlapping replacements detected; refine pattern to avoid ambiguous edits"
			));
		}
		prev_end = edit.position.saturating_add(edit.deleted_length);
	}

	let mut output = content.to_string();
	for edit in sorted.into_iter().rev() {
		let start = edit.position;
		let end = edit.position.saturating_add(edit.deleted_length);
		if end > output.len() || start > end {
			return Err(anyhow!("Computed edit range is out of bounds"));
		}
		let replacement = std::str::from_utf8(&edit.inserted_text)
			.map_err(|err| anyhow!("Replacement text is not valid UTF-8: {err}"))?;
		output.replace_range(start..end, replacement);
	}
	Ok(output)
}

pub fn collect_matched_files(
	cwd: &Path,
	patterns: &[String],
) -> Result<Vec<MatchedFile>, std::io::Error> {
	let globset = build_globset(patterns)?;
	let mut builder = WalkBuilder::new(cwd);
	builder
		.hidden(false)
		.git_ignore(true)
		.git_global(true)
		.git_exclude(true);
	let mut files = Vec::new();
	for entry in builder.build() {
		let entry = match entry {
			Ok(entry) => entry,
			Err(error) => return Err(std::io::Error::other(error)),
		};
		if !entry.file_type().is_some_and(|ft| ft.is_file()) {
			continue;
		}
		let absolute_path = entry.into_path();
		let relative_path = absolute_path
			.strip_prefix(cwd)
			.unwrap_or(&absolute_path)
			.to_string_lossy()
			.replace('\\', "/");
		if globset.is_match(&relative_path)
			|| patterns.iter().any(|pattern| pattern == &relative_path)
		{
			files.push(MatchedFile { absolute_path, relative_path });
		}
	}
	files.sort_unstable_by(|left, right| left.relative_path.cmp(&right.relative_path));
	Ok(files)
}

fn build_globset(patterns: &[String]) -> Result<GlobSet, std::io::Error> {
	let mut builder = GlobSetBuilder::new();
	for pattern in patterns {
		if has_glob_syntax(pattern) {
			let glob = Glob::new(pattern).map_err(|error| {
				std::io::Error::new(
					std::io::ErrorKind::InvalidInput,
					format!("invalid glob `{pattern}`: {error}"),
				)
			})?;
			builder.add(glob);
		}
	}
	builder.build().map_err(std::io::Error::other)
}

#[must_use]
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

	use super::{SupportLang, apply_edits, compile_search_patterns};

	#[test]
	fn compile_search_patterns_compiles_rust_patterns() {
		let patterns = compile_search_patterns("foo($$$ARGS)", SupportLang::Rust)
			.expect("rust pattern should compile");
		assert!(!patterns.is_empty());
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
