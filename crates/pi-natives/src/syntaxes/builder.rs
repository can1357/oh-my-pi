use syntect::parsing::{SyntaxDefinition, SyntaxSet};

const EXTRA_SYNTAXES: &[(&str, &str)] = &[
	("Julia", include_str!("Julia.sublime-syntax")),
	("Nix", include_str!("Nix.sublime-syntax")),
	("Mermaid", include_str!("Mermaid.sublime-syntax")),
	("TypeScript", include_str!("TypeScript.sublime-syntax")),
	("TypeScriptReact", include_str!("TypeScriptReact.sublime-syntax")),
	("Astro", include_str!("Astro.sublime-syntax")),
	// The later entry shadows syntect's backtracking Markdown grammar.
	("Markdown", include_str!("Markdown.sublime-syntax")),
];

/// Builds the serialized artifact's syntax set from newline-aware defaults and
/// vendored grammars.
///
/// # Panics
///
/// Panics if a vendored grammar cannot be parsed.
pub fn build_syntax_set() -> SyntaxSet {
	let mut builder = SyntaxSet::load_defaults_newlines().into_builder();
	for (name, source) in EXTRA_SYNTAXES {
		let syntax = SyntaxDefinition::load_from_str(source, true, None)
			.unwrap_or_else(|error| panic!("invalid bundled {name} syntax: {error}"));
		builder.add(syntax);
	}
	builder.build()
}
