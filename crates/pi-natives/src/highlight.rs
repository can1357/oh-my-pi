//! Syntax highlighting using syntect.
//!
//! Provides ANSI-colored output for code blocks. Takes theme colors as input
//! and maps syntect scopes to 11 semantic categories:
//! - comment, keyword, function, variable, string, number, type, operator,
//!   punctuation, inserted, deleted

use std::{cell::RefCell, collections::HashMap, sync::OnceLock};

use napi_derive::napi;
use syntect::parsing::{
	ParseState, Scope, ScopeStack, ScopeStackOp, SyntaxDefinition, SyntaxReference, SyntaxSet,
};

static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
static SCOPE_MATCHERS: OnceLock<ScopeMatchers> = OnceLock::new();

// Thread-local cache for scope -> color index lookups
thread_local! {
	static SCOPE_COLOR_CACHE: RefCell<HashMap<Scope, usize>> = RefCell::new(HashMap::with_capacity(256));
}

/// Syntaxes bundled in addition to syntect's defaults: syntect ships none of
/// these, so we vendor their `.sublime-syntax` sources and fold them into the
/// set.
const EXTRA_SYNTAXES: &[&str] = &[
	include_str!("syntaxes/Julia.sublime-syntax"),
	include_str!("syntaxes/Nix.sublime-syntax"),
	include_str!("syntaxes/Mermaid.sublime-syntax"),
];

fn get_syntax_set() -> &'static SyntaxSet {
	SYNTAX_SET.get_or_init(build_syntax_set)
}

/// Load syntect's newline-aware defaults and add the vendored extra syntaxes.
/// A vendored syntax that fails to parse is skipped rather than breaking all
/// highlighting; the bundled-language tests guard against silent absence.
fn build_syntax_set() -> SyntaxSet {
	let mut builder = SyntaxSet::load_defaults_newlines().into_builder();
	for src in EXTRA_SYNTAXES {
		if let Ok(def) = SyntaxDefinition::load_from_str(src, true, None) {
			builder.add(def);
		}
	}
	builder.build()
}

/// Pre-compiled scope patterns for fast matching.
struct ScopeMatchers {
	// Comment (index 0)
	comment: Scope,

	// String (index 4)
	string:             Scope,
	constant_character: Scope,
	meta_string:        Scope,

	// Number (index 5)
	constant_numeric: Scope,
	constant_integer: Scope,
	constant:         Scope,

	// Keyword (index 1)
	keyword:          Scope,
	storage_type:     Scope,
	storage_modifier: Scope,

	// Function (index 2)
	entity_name_function: Scope,
	support_function:     Scope,
	meta_function_call:   Scope,
	variable_function:    Scope,

	// Type (index 6)
	entity_name_type:      Scope,
	support_type:          Scope,
	support_class:         Scope,
	entity_name_class:     Scope,
	entity_name_struct:    Scope,
	entity_name_enum:      Scope,
	entity_name_interface: Scope,
	entity_name_trait:     Scope,

	// Operator (index 7)
	keyword_operator:     Scope,
	punctuation_accessor: Scope,

	// Punctuation (index 8)
	punctuation: Scope,

	// Variable (index 3)
	variable:    Scope,
	entity_name: Scope,
	meta_path:   Scope,

	// Diff (indices 9, 10)
	markup_inserted:  Scope,
	markup_deleted:   Scope,
	meta_diff_header: Scope,
	meta_diff_range:  Scope,
}

impl ScopeMatchers {
	fn new() -> Self {
		Self {
			comment:               Scope::new("comment").unwrap(),
			string:                Scope::new("string").unwrap(),
			constant_character:    Scope::new("constant.character").unwrap(),
			meta_string:           Scope::new("meta.string").unwrap(),
			constant_numeric:      Scope::new("constant.numeric").unwrap(),
			constant_integer:      Scope::new("constant.integer").unwrap(),
			constant:              Scope::new("constant").unwrap(),
			keyword:               Scope::new("keyword").unwrap(),
			storage_type:          Scope::new("storage.type").unwrap(),
			storage_modifier:      Scope::new("storage.modifier").unwrap(),
			entity_name_function:  Scope::new("entity.name.function").unwrap(),
			support_function:      Scope::new("support.function").unwrap(),
			meta_function_call:    Scope::new("meta.function-call").unwrap(),
			variable_function:     Scope::new("variable.function").unwrap(),
			entity_name_type:      Scope::new("entity.name.type").unwrap(),
			support_type:          Scope::new("support.type").unwrap(),
			support_class:         Scope::new("support.class").unwrap(),
			entity_name_class:     Scope::new("entity.name.class").unwrap(),
			entity_name_struct:    Scope::new("entity.name.struct").unwrap(),
			entity_name_enum:      Scope::new("entity.name.enum").unwrap(),
			entity_name_interface: Scope::new("entity.name.interface").unwrap(),
			entity_name_trait:     Scope::new("entity.name.trait").unwrap(),
			keyword_operator:      Scope::new("keyword.operator").unwrap(),
			punctuation_accessor:  Scope::new("punctuation.accessor").unwrap(),
			punctuation:           Scope::new("punctuation").unwrap(),
			variable:              Scope::new("variable").unwrap(),
			entity_name:           Scope::new("entity.name").unwrap(),
			meta_path:             Scope::new("meta.path").unwrap(),
			markup_inserted:       Scope::new("markup.inserted").unwrap(),
			markup_deleted:        Scope::new("markup.deleted").unwrap(),
			meta_diff_header:      Scope::new("meta.diff.header").unwrap(),
			meta_diff_range:       Scope::new("meta.diff.range").unwrap(),
		}
	}
}

fn get_scope_matchers() -> &'static ScopeMatchers {
	SCOPE_MATCHERS.get_or_init(ScopeMatchers::new)
}

/// Theme colors for syntax highlighting.
/// Each color is an ANSI escape sequence (e.g., "\x1b[38;2;255;0;0m").
#[derive(Debug)]
#[napi(object)]
pub struct HighlightColors {
	/// ANSI color for comments.
	pub comment:     String,
	/// ANSI color for keywords.
	pub keyword:     String,
	/// ANSI color for function names.
	pub function:    String,
	/// ANSI color for variables and identifiers.
	pub variable:    String,
	/// ANSI color for string literals.
	pub string:      String,
	/// ANSI color for numeric literals.
	pub number:      String,
	/// ANSI color for type identifiers.
	pub r#type:      String,
	/// ANSI color for operators.
	pub operator:    String,
	/// ANSI color for punctuation tokens.
	pub punctuation: String,
	/// ANSI color for diff inserted lines.
	pub inserted:    Option<String>,
	/// ANSI color for diff deleted lines.
	pub deleted:     Option<String>,
}

/// Language alias mappings: (aliases, target syntax name).
/// Used for languages not in syntect's default set or with non-standard names.
const LANG_ALIASES: &[(&[&str], &str)] = &[
	(&["ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "cjs"], "JavaScript"),
	(&["py", "python"], "Python"),
	(&["rb", "ruby"], "Ruby"),
	(&["jl", "julia"], "Julia"),
	(&["nix"], "Nix"),
	(&["mermaid", "mmd"], "Mermaid"),
	(&["rs", "rust"], "Rust"),
	(&["go", "golang"], "Go"),
	(&["java"], "Java"),
	(&["kt", "kotlin"], "Java"),
	(&["swift"], "Objective-C"),
	(&["c", "h"], "C"),
	(&["cpp", "cc", "cxx", "c++", "hpp", "hxx", "hh"], "C++"),
	(&["cs", "csharp"], "C#"),
	(&["php"], "PHP"),
	(&["sh", "bash", "zsh", "shell"], "Bash"),
	(&["ps1", "powershell"], "PowerShell"),
	(&["html", "htm", "astro", "vue", "svelte"], "HTML"),
	(&["css"], "CSS"),
	(&["scss"], "SCSS"),
	(&["sass"], "Sass"),
	(&["less"], "LESS"),
	(&["json"], "JSON"),
	(&["yaml", "yml"], "YAML"),
	(&["toml"], "TOML"),
	(&["xml"], "XML"),
	(&["md", "markdown"], "Markdown"),
	(&["sql"], "SQL"),
	(&["lua"], "Lua"),
	(&["perl", "pl", "pm"], "Perl"),
	(&["r"], "R"),
	(&["scala"], "Scala"),
	(&["clj", "clojure"], "Clojure"),
	(&["el", "elisp", "emacs-lisp", "emacslisp"], "Lisp"),
	(&["ex", "exs", "elixir"], "Ruby"),
	(&["erl", "erlang"], "Erlang"),
	(&["hs", "haskell"], "Haskell"),
	(&["ml", "ocaml"], "OCaml"),
	(&["vim"], "VimL"),
	(&["graphql", "gql"], "GraphQL"),
	(&["proto", "protobuf"], "Protocol Buffers"),
	(&["tf", "hcl", "terraform"], "Terraform"),
	(&["dockerfile", "docker", "containerfile"], "Dockerfile"),
	(&["makefile", "make", "just", "justfile"], "Makefile"),
	(&["cmake", "cmakelists"], "CMake"),
	(&["ini", "cfg", "conf", "config", "properties"], "INI"),
	(&["diff", "patch"], "Diff"),
	(&["gitignore", "gitattributes", "gitmodules"], "Git Ignore"),
];

/// Find syntax name from alias table using case-insensitive comparison.
#[inline]
fn find_alias(lang: &str) -> Option<&'static str> {
	LANG_ALIASES
		.iter()
		.find(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
		.map(|(_, target)| *target)
}

/// Check if language is in the alias table.
#[inline]
fn is_known_alias(lang: &str) -> bool {
	LANG_ALIASES
		.iter()
		.any(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
}

/// Compute the color index for a single scope (uncached).
#[inline]
fn compute_scope_color(s: Scope) -> usize {
	let m = get_scope_matchers();

	// Comment (index 0)
	if m.comment.is_prefix_of(s) {
		return 0;
	}

	// Diff inserted (index 9)
	if m.markup_inserted.is_prefix_of(s) {
		return 9;
	}

	// Diff deleted (index 10)
	if m.markup_deleted.is_prefix_of(s) {
		return 10;
	}

	// Diff header/range -> keyword (index 1)
	if m.meta_diff_header.is_prefix_of(s) || m.meta_diff_range.is_prefix_of(s) {
		return 1;
	}

	// String (index 4)
	if m.string.is_prefix_of(s)
		|| m.constant_character.is_prefix_of(s)
		|| m.meta_string.is_prefix_of(s)
	{
		return 4;
	}

	// Number (index 5)
	if m.constant_numeric.is_prefix_of(s) || m.constant_integer.is_prefix_of(s) {
		return 5;
	}

	// Keyword (index 1)
	if m.keyword.is_prefix_of(s)
		|| m.storage_type.is_prefix_of(s)
		|| m.storage_modifier.is_prefix_of(s)
	{
		return 1;
	}

	// Function (index 2)
	if m.entity_name_function.is_prefix_of(s)
		|| m.support_function.is_prefix_of(s)
		|| m.meta_function_call.is_prefix_of(s)
		|| m.variable_function.is_prefix_of(s)
	{
		return 2;
	}

	// Type (index 6)
	if m.entity_name_type.is_prefix_of(s)
		|| m.support_type.is_prefix_of(s)
		|| m.support_class.is_prefix_of(s)
		|| m.entity_name_class.is_prefix_of(s)
		|| m.entity_name_struct.is_prefix_of(s)
		|| m.entity_name_enum.is_prefix_of(s)
		|| m.entity_name_interface.is_prefix_of(s)
		|| m.entity_name_trait.is_prefix_of(s)
	{
		return 6;
	}

	// Operator (index 7)
	if m.keyword_operator.is_prefix_of(s) || m.punctuation_accessor.is_prefix_of(s) {
		return 7;
	}

	// Punctuation (index 8)
	if m.punctuation.is_prefix_of(s) {
		return 8;
	}

	// Variable (index 3)
	if m.variable.is_prefix_of(s) || m.entity_name.is_prefix_of(s) || m.meta_path.is_prefix_of(s) {
		return 3;
	}

	// Generic constant -> number (index 5)
	if m.constant.is_prefix_of(s) {
		return 5;
	}

	// No match
	usize::MAX
}

/// Determine the semantic color category from a scope stack.
/// Uses per-scope caching to avoid repeated prefix checks.
#[inline]
fn scope_to_color_index(scope: &ScopeStack) -> usize {
	SCOPE_COLOR_CACHE.with(|cache| {
		let mut cache = cache.borrow_mut();

		// Walk from innermost to outermost scope
		for s in scope.as_slice().iter().rev() {
			let color_idx = *cache.entry(*s).or_insert_with(|| compute_scope_color(*s));
			if color_idx != usize::MAX {
				return color_idx;
			}
		}

		usize::MAX
	})
}

/// Find the appropriate syntax for a language name.
fn find_syntax<'a>(ss: &'a SyntaxSet, lang: &str) -> Option<&'a SyntaxReference> {
	// Direct name/token match (syntect APIs are case-insensitive)
	if let Some(syn) = ss.find_syntax_by_token(lang) {
		return Some(syn);
	}

	// Extension-based match
	if let Some(syn) = ss.find_syntax_by_extension(lang) {
		return Some(syn);
	}

	// Alias lookup for languages not in syntect's default set
	let alias = find_alias(lang)?;

	ss.find_syntax_by_name(alias)
		.or_else(|| ss.find_syntax_by_token(alias))
}

/// Highlight code and return ANSI-colored lines.
///
/// # Arguments
/// * `code` - The source code to highlight
/// * `lang` - Language identifier (e.g., "rust", "typescript", "python")
/// * `colors` - Theme colors as ANSI escape sequences
///
/// # Returns
/// Highlighted code with ANSI color codes, or the original code if highlighting
/// fails.
#[napi]
pub fn highlight_code(code: String, lang: Option<String>, colors: HighlightColors) -> String {
	let inserted = colors.inserted.as_deref().unwrap_or("");
	let deleted = colors.deleted.as_deref().unwrap_or("");

	// Color palette as array for quick indexing
	let palette = [
		colors.comment.as_str(),     // 0
		colors.keyword.as_str(),     // 1
		colors.function.as_str(),    // 2
		colors.variable.as_str(),    // 3
		colors.string.as_str(),      // 4
		colors.number.as_str(),      // 5
		colors.r#type.as_str(),      // 6
		colors.operator.as_str(),    // 7
		colors.punctuation.as_str(), // 8
		inserted,                    // 9
		deleted,                     // 10
	];

	let ss = get_syntax_set();

	// Find syntax for the language
	let syntax = match &lang {
		Some(l) => find_syntax(ss, l),
		None => None,
	}
	.unwrap_or_else(|| ss.find_syntax_plain_text());

	let mut parse_state = ParseState::new(syntax);
	let mut scope_stack = ScopeStack::new();
	let mut result = String::with_capacity(code.len() * 2);

	for line in syntect::util::LinesWithEndings::from(code.as_str()) {
		let Ok(ops) = parse_state.parse_line(line, ss) else {
			// Parse error - append unhighlighted line and continue
			result.push_str(line);
			continue;
		};

		let mut prev_end = 0;
		for (offset, op) in ops {
			let offset = offset.min(line.len());

			// Output text BEFORE this operation using current scope
			if offset > prev_end {
				let text = &line[prev_end..offset];
				let color_idx = scope_to_color_index(&scope_stack);

				if color_idx < palette.len() && !palette[color_idx].is_empty() {
					result.push_str(palette[color_idx]);
					result.push_str(text);
					result.push_str("\x1b[39m");
				} else {
					result.push_str(text);
				}
			}
			prev_end = offset;

			// Now apply scope operation for NEXT segment
			match op {
				ScopeStackOp::Push(scope) => {
					scope_stack.push(scope);
				},
				ScopeStackOp::Pop(count) => {
					for _ in 0..count {
						scope_stack.pop();
					}
				},
				ScopeStackOp::Restore | ScopeStackOp::Clear(_) | ScopeStackOp::Noop => {},
			}
		}

		// Output remaining text with current scope
		if prev_end < line.len() {
			let text = &line[prev_end..];
			let color_idx = scope_to_color_index(&scope_stack);

			if color_idx < palette.len() && !palette[color_idx].is_empty() {
				result.push_str(palette[color_idx]);
				result.push_str(text);
				result.push_str("\x1b[39m");
			} else {
				result.push_str(text);
			}
		}
	}

	result
}

/// Check if a language is supported for highlighting.
/// Returns true if the language has either direct support or a fallback
/// mapping.
#[napi]
pub fn supports_language(lang: String) -> bool {
	if is_known_alias(&lang) {
		return true;
	}

	// Fall back to direct syntax lookup
	let ss = get_syntax_set();
	find_syntax(ss, &lang).is_some()
}

/// Get list of supported languages.
#[napi]
pub fn get_supported_languages() -> Vec<String> {
	let ss = get_syntax_set();
	ss.syntaxes().iter().map(|s| s.name.clone()).collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn test_colors() -> HighlightColors {
		HighlightColors {
			comment:     "<c>".to_string(),
			keyword:     "<k>".to_string(),
			function:    "<f>".to_string(),
			variable:    "<v>".to_string(),
			string:      "<s>".to_string(),
			number:      "<n>".to_string(),
			r#type:      "<t>".to_string(),
			operator:    "<o>".to_string(),
			punctuation: "<p>".to_string(),
			inserted:    None,
			deleted:     None,
		}
	}

	#[test]
	fn highlights_nix_vendored_syntax() {
		assert!(get_supported_languages().contains(&"Nix".to_string()));
		assert!(supports_language("nix".to_string()));

		let out = highlight_code(
			"{ pkgs ? import <nixpkgs> {} }:\nlet message = \"hello\"; in pkgs.writeText \"msg\" \
			 message # greeting\n"
				.to_string(),
			Some("nix".to_string()),
			test_colors(),
		);
		assert!(out.contains("<k>let"));
		assert!(out.contains("<s>hello"));
		assert!(out.contains("<c># greeting"));
	}

	#[test]
	fn highlights_mermaid_vendored_syntax() {
		assert!(get_supported_languages().contains(&"Mermaid".to_string()));
		assert!(supports_language("mermaid".to_string()));
		assert!(supports_language("mmd".to_string()));

		let out = highlight_code(
			"graph TD\n  A[\"Start\"] --> B\n  %% note\n".to_string(),
			Some("mermaid".to_string()),
			test_colors(),
		);
		assert!(out.contains("<k>graph"));
		assert!(out.contains("<s>Start"));
		assert!(out.contains("<k>-->"));
		assert!(out.contains("<c> note"));
	}
}
