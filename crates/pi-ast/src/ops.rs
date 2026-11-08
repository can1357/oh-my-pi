//! Language resolution, pattern compilation, and edit application shared by
//! the structural search engine ([`crate::search`]) and grammar checks.

use std::path::Path;

use anyhow::{Result, anyhow};
use ast_grep_core::{
	MatchStrictness,
	matcher::{Pattern, PatternError},
	source::Edit,
};

use crate::language::SupportLang;

/// Every language alias, sorted and comma-separated.
#[must_use]
pub fn supported_lang_list() -> String {
	SupportLang::sorted_aliases().join(", ")
}

/// The language an alias names.
///
/// # Errors
/// The alias is unknown; the message lists the supported ones.
pub fn resolve_supported_lang(value: &str) -> Result<SupportLang> {
	SupportLang::from_alias(value).ok_or_else(|| {
		anyhow!("Unsupported language '{value}'. Supported: {}", supported_lang_list())
	})
}

/// The explicit `lang` alias when given, else the language of `file_path`'s
/// name.
///
/// # Errors
/// The alias is unknown, or the file name maps to no language.
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

/// `pattern` compiled for `lang` with `strictness`, parsed as a `selector`
/// node when given. A multi-node fragment is retried inside a wrapper where
/// the language has one.
///
/// # Errors
/// The pattern does not parse (`Invalid pattern: …`).
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

/// `content` with `edits` applied; byte-identical edits count once.
///
/// # Errors
/// Edits overlap, fall outside `content`, or insert invalid UTF-8.
pub fn apply_edits<'e>(
	content: &str,
	edits: impl IntoIterator<Item = &'e Edit<String>>,
) -> Result<String> {
	let mut sorted: Vec<&Edit<String>> = edits.into_iter().collect();
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
	let mut capacity = content.len();
	for edit in &sorted {
		if edit.position < prev_end {
			return Err(anyhow!(
				"Overlapping replacements detected; refine pattern to avoid ambiguous edits"
			));
		}
		prev_end = edit.position.saturating_add(edit.deleted_length);
		capacity = (capacity + edit.inserted_text.len()).saturating_sub(edit.deleted_length);
	}

	// Edits are sorted and disjoint: copy the gaps and replacements forward
	// once instead of shifting the tail of the string for every edit.
	let mut output = String::with_capacity(capacity);
	let mut copied = 0;
	for edit in sorted {
		let start = edit.position;
		let end = edit.position.saturating_add(edit.deleted_length);
		if end > content.len() || !content.is_char_boundary(start) || !content.is_char_boundary(end) {
			return Err(anyhow!("Computed edit range is out of bounds"));
		}
		let replacement = std::str::from_utf8(&edit.inserted_text)
			.map_err(|err| anyhow!("Replacement text is not valid UTF-8: {err}"))?;
		output.push_str(&content[copied..start]);
		output.push_str(replacement);
		copied = end;
	}
	output.push_str(&content[copied..]);
	Ok(output)
}

#[cfg(test)]
mod tests {
	use std::collections::HashMap;

	use ast_grep_core::{MatchStrictness, source::Edit, tree_sitter::LanguageExt};
	use tokio_util::sync::CancellationToken;

	use super::{SupportLang, apply_edits, compile_pattern, resolve_supported_lang};
	use crate::search::{self, Mode, Rewrite};

	#[test]
	fn emacs_lisp_pattern_binds_metavariables() {
		let lang = SupportLang::EmacsLisp;
		let pattern = compile_pattern("(defun $NAME $$$BODY)", None, &MatchStrictness::Smart, lang)
			.expect("elisp pattern should compile");
		let ast = lang.ast_grep("(defun greet (name)\n  (message \"Hello %s\" name)\n)");
		let matched = ast.root().find(pattern).expect("defun should match");
		let env = HashMap::<String, String>::from(matched.get_env().clone());
		assert_eq!(env.get("NAME").map(String::as_str), Some("greet"));
	}

	#[test]
	fn emacs_lisp_rewrite_substitutes_captures() {
		let rules =
			[("(message $FORMAT $ARG)".to_owned(), "(format-message $FORMAT $ARG)".to_owned())];
		let rewrite = Rewrite {
			rules:               &rules,
			lang:                None,
			selector:            None,
			strictness:          MatchStrictness::Smart,
			max_replacements:    usize::MAX,
			max_files:           usize::MAX,
			fail_on_parse_error: false,
			skip_overlaps:       false,
			mode:                Mode::Render,
		};
		let edit = search::rewrite_source(
			"(defun greet (name)\n  (message \"Hello %s\" name))\n",
			SupportLang::EmacsLisp,
			&rewrite,
			&CancellationToken::new(),
		)
		.expect("rewrite succeeds");
		assert_eq!(edit.changes.len(), 1);
		assert_eq!(edit.content, "(defun greet (name)\n  (format-message \"Hello %s\" name))\n");
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
	fn apply_edits_applies_non_overlapping_edits() {
		let source = "const answer = 41;";
		let edits = vec![
			Edit::<String> { position: 6, deleted_length: 6, inserted_text: b"value".to_vec() },
			Edit::<String> { position: 15, deleted_length: 2, inserted_text: b"42".to_vec() },
		];
		let output = apply_edits(source, &edits).expect("edits should apply");
		assert_eq!(output, "const value = 42;");
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
