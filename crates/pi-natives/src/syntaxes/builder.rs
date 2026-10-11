use syntect::parsing::{SyntaxDefinition, SyntaxSet};

const EXTRA_SYNTAXES: &[(&str, &str)] = &[
	("Julia", include_str!("Julia.sublime-syntax")),
	("Nix", include_str!("Nix.sublime-syntax")),
	("Mermaid", include_str!("Mermaid.sublime-syntax")),
	("TypeScript", include_str!("TypeScript.sublime-syntax")),
	("TypeScriptReact", include_str!("TypeScriptReact.sublime-syntax")),
	("Astro", include_str!("Astro.sublime-syntax")),
	("CMake", include_str!("CMake.sublime-syntax")),
	("CMakeCommands", include_str!("CMakeCommands.sublime-syntax")),
	("Dockerfile", include_str!("Dockerfile.sublime-syntax")),
	("Elixir", include_str!("Elixir.sublime-syntax")),
	("Regular Expressions (Elixir)", include_str!("Regular Expressions (Elixir).sublime-syntax")),
	("Git Ignore", include_str!("Git Ignore.sublime-syntax")),
	("GraphQL", include_str!("GraphQL.sublime-syntax")),
	("INI", include_str!("INI.sublime-syntax")),
	("Kotlin", include_str!("Kotlin.sublime-syntax")),
	("PowerShell", include_str!("PowerShell.sublime-syntax")),
	("Protocol Buffer", include_str!("Protobuf.sublime-syntax")),
	("Protocol Buffer (TEXT)", include_str!("ProtobufText.sublime-syntax")),
	("Sass", include_str!("Sass.sublime-syntax")),
	("SCSS", include_str!("SCSS.sublime-syntax")),
	("Swift", include_str!("Swift.sublime-syntax")),
	("Terraform", include_str!("Terraform.sublime-syntax")),
	("TOML", include_str!("TOML.sublime-syntax")),
	("VimL", include_str!("VimL.sublime-syntax")),
	// The later entry shadows syntect's backtracking Markdown grammar.
	("Markdown", include_str!("Markdown.sublime-syntax")),
];

/// Builds the serialized artifact's syntax set from newline-aware defaults and
/// vendored grammars; a grammar without a `name:` key (`CMakeCommands`, linked
/// by scope) takes its name from [`EXTRA_SYNTAXES`].
///
/// # Panics
///
/// Panics if a vendored grammar cannot be parsed.
pub fn build_syntax_set() -> SyntaxSet {
	let mut builder = SyntaxSet::load_defaults_newlines().into_builder();
	for (name, source) in EXTRA_SYNTAXES {
		let syntax = SyntaxDefinition::load_from_str(source, true, Some(name))
			.unwrap_or_else(|error| panic!("invalid bundled {name} syntax: {error}"));
		builder.add(syntax);
	}
	builder.build()
}
