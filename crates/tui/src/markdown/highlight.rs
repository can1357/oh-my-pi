//! Syntect-backed semantic highlighting for fenced code blocks.

use std::sync::LazyLock;

use syntect::{
	parsing::{
		ParseState, Scope, ScopeStack, ScopeStackOp, SyntaxDefinition, SyntaxReference, SyntaxSet,
	},
	util::LinesWithEndings,
};

use crate::{
	context::Theme,
	frame::Style,
	rich::{RichSink, RichText},
};
static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(|| {
	let mut builder = SyntaxSet::load_defaults_newlines().into_builder();
	for source in EXTRA_SYNTAXES {
		if let Ok(definition) = SyntaxDefinition::load_from_str(source, true, None) {
			builder.add(definition);
		}
	}
	builder.build()
});
static SCOPES: LazyLock<ScopeMatchers> = LazyLock::new(ScopeMatchers::new);

const EXTRA_SYNTAXES: &[&str] =
	&[include_str!("syntaxes/Nix.sublime-syntax"), include_str!("syntaxes/Mermaid.sublime-syntax")];

const LANG_ALIASES: &[(&[&str], &str)] = &[
	(&["ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "cjs"], "JavaScript"),
	(&["py", "python"], "Python"),
	(&["rb", "ruby"], "Ruby"),
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

/// Semantic styles applied to parsed syntax scopes.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct HighlightStyles {
	base:        Style,
	comment:     Style,
	keyword:     Style,
	function:    Style,
	variable:    Style,
	string:      Style,
	number:      Style,
	type_name:   Style,
	operator:    Style,
	punctuation: Style,
	inserted:    Style,
	deleted:     Style,
}

impl HighlightStyles {
	/// Derives syntax categories from the shared semantic palette.
	pub(crate) const fn from_theme(theme: &Theme) -> Self {
		Self {
			base:        Style::new(),
			comment:     Style::new().fg(theme.muted),
			keyword:     Style::new().fg(theme.accent),
			function:    Style::new().fg(theme.ok),
			variable:    Style::new().fg(theme.fg),
			string:      Style::new().fg(theme.code_border),
			number:      Style::new().fg(theme.warn),
			type_name:   Style::new().fg(theme.warn),
			operator:    Style::new().fg(theme.accent),
			punctuation: Style::new().fg(theme.output),
			inserted:    Style::new().fg(theme.info),
			deleted:     Style::new().fg(theme.err),
		}
	}

	const fn at(self, index: usize) -> Style {
		match index {
			0 => self.comment,
			1 => self.keyword,
			2 => self.function,
			3 => self.variable,
			4 => self.string,
			5 => self.number,
			6 => self.type_name,
			7 => self.operator,
			8 => self.punctuation,
			9 => self.inserted,
			10 => self.deleted,
			_ => self.base,
		}
	}
}

/// Reports whether `language` resolves to a bundled syntax.
pub fn supports_language(language: &str) -> bool {
	!language.is_empty() && find_syntax(syntaxes(), language).is_some()
}

/// Stateful syntax parser used by paint-budgeted highlighting.
///
/// One instance must be retained for the whole source side so scope state
/// survives batch boundaries.
pub struct HighlightStream {
	parse_state: ParseState,
	scope_stack: ScopeStack,
}

impl HighlightStream {
	/// Starts a stream for one bundled language.
	pub(crate) fn new(language: &str) -> Option<Self> {
		let syntax = find_syntax(syntaxes(), language)?;
		Some(Self { parse_state: ParseState::new(syntax), scope_stack: ScopeStack::new() })
	}

	/// Appends one or more complete source lines to this parser.
	pub(crate) fn render(
		&mut self,
		source: &str,
		line_count: usize,
		styles: &HighlightStyles,
		out: &mut RichText,
	) {
		let mut emitted = 0;
		for raw_line in LinesWithEndings::from(source) {
			let content_len = raw_line.strip_suffix('\n').map_or(raw_line.len(), str::len);
			let Ok(operations) = self.parse_state.parse_line(raw_line, syntaxes()) else {
				out.run(styles.base, &raw_line[..content_len]);
				out.newline();
				emitted += 1;
				continue;
			};

			let mut previous = 0;
			for (offset, operation) in operations {
				let end = offset.min(content_len);
				if end > previous {
					out.run(styles.at(scope_color_index(&self.scope_stack)), &raw_line[previous..end]);
				}
				previous = end;
				apply_scope_op(&mut self.scope_stack, operation);
			}
			if previous < content_len {
				out.run(
					styles.at(scope_color_index(&self.scope_stack)),
					&raw_line[previous..content_len],
				);
			}
			out.newline();
			emitted += 1;
		}

		while emitted < line_count {
			out.newline();
			emitted += 1;
		}
	}
}

pub fn render(
	source: &str,
	language: &str,
	line_count: usize,
	styles: &HighlightStyles,
	out: &mut RichText,
) -> bool {
	let Some(mut stream) = HighlightStream::new(language) else {
		return false;
	};
	stream.render(source, line_count, styles, out);
	true
}

fn syntaxes() -> &'static SyntaxSet {
	&SYNTAXES
}

fn find_syntax<'a>(syntaxes: &'a SyntaxSet, language: &str) -> Option<&'a SyntaxReference> {
	syntaxes
		.find_syntax_by_token(language)
		.or_else(|| syntaxes.find_syntax_by_extension(language))
		.or_else(|| {
			let name = LANG_ALIASES
				.iter()
				.find(|(aliases, _)| {
					aliases
						.iter()
						.any(|alias| language.eq_ignore_ascii_case(alias))
				})
				.map(|(_, name)| *name)?;
			syntaxes
				.find_syntax_by_name(name)
				.or_else(|| syntaxes.find_syntax_by_token(name))
		})
}

fn apply_scope_op(stack: &mut ScopeStack, operation: ScopeStackOp) {
	match operation {
		ScopeStackOp::Push(scope) => stack.push(scope),
		ScopeStackOp::Pop(count) => {
			for _ in 0..count {
				stack.pop();
			}
		},
		ScopeStackOp::Restore | ScopeStackOp::Clear(_) | ScopeStackOp::Noop => {},
	}
}

fn scope_color_index(stack: &ScopeStack) -> usize {
	for scope in stack.as_slice().iter().rev() {
		let index = scope_index(*scope);
		if index != usize::MAX {
			return index;
		}
	}
	usize::MAX
}

fn scope_index(scope: Scope) -> usize {
	let scopes = &*SCOPES;
	if scopes.comment.is_prefix_of(scope) {
		0
	} else if scopes.markup_inserted.is_prefix_of(scope) {
		9
	} else if scopes.markup_deleted.is_prefix_of(scope) {
		10
	} else if scopes.meta_diff_header.is_prefix_of(scope)
		|| scopes.meta_diff_range.is_prefix_of(scope)
	{
		1
	} else if scopes.string.is_prefix_of(scope)
		|| scopes.constant_character.is_prefix_of(scope)
		|| scopes.meta_string.is_prefix_of(scope)
	{
		4
	} else if scopes.constant_numeric.is_prefix_of(scope)
		|| scopes.constant_integer.is_prefix_of(scope)
	{
		5
	} else if scopes.keyword.is_prefix_of(scope)
		|| scopes.storage_type.is_prefix_of(scope)
		|| scopes.storage_modifier.is_prefix_of(scope)
	{
		1
	} else if scopes.entity_name_function.is_prefix_of(scope)
		|| scopes.support_function.is_prefix_of(scope)
		|| scopes.meta_function_call.is_prefix_of(scope)
		|| scopes.variable_function.is_prefix_of(scope)
	{
		2
	} else if scopes.entity_name_type.is_prefix_of(scope)
		|| scopes.support_type.is_prefix_of(scope)
		|| scopes.support_class.is_prefix_of(scope)
		|| scopes.entity_name_class.is_prefix_of(scope)
		|| scopes.entity_name_struct.is_prefix_of(scope)
		|| scopes.entity_name_enum.is_prefix_of(scope)
		|| scopes.entity_name_interface.is_prefix_of(scope)
		|| scopes.entity_name_trait.is_prefix_of(scope)
	{
		6
	} else if scopes.keyword_operator.is_prefix_of(scope)
		|| scopes.punctuation_accessor.is_prefix_of(scope)
	{
		7
	} else if scopes.punctuation.is_prefix_of(scope) {
		8
	} else if scopes.variable.is_prefix_of(scope)
		|| scopes.entity_name.is_prefix_of(scope)
		|| scopes.meta_path.is_prefix_of(scope)
	{
		3
	} else if scopes.constant.is_prefix_of(scope) {
		5
	} else {
		usize::MAX
	}
}

struct ScopeMatchers {
	comment:               Scope,
	string:                Scope,
	constant_character:    Scope,
	meta_string:           Scope,
	constant_numeric:      Scope,
	constant_integer:      Scope,
	constant:              Scope,
	keyword:               Scope,
	storage_type:          Scope,
	storage_modifier:      Scope,
	entity_name_function:  Scope,
	support_function:      Scope,
	meta_function_call:    Scope,
	variable_function:     Scope,
	entity_name_type:      Scope,
	support_type:          Scope,
	support_class:         Scope,
	entity_name_class:     Scope,
	entity_name_struct:    Scope,
	entity_name_enum:      Scope,
	entity_name_interface: Scope,
	entity_name_trait:     Scope,
	keyword_operator:      Scope,
	punctuation_accessor:  Scope,
	punctuation:           Scope,
	variable:              Scope,
	entity_name:           Scope,
	meta_path:             Scope,
	markup_inserted:       Scope,
	markup_deleted:        Scope,
	meta_diff_header:      Scope,
	meta_diff_range:       Scope,
}

impl ScopeMatchers {
	fn new() -> Self {
		Self {
			comment:               scope("comment"),
			string:                scope("string"),
			constant_character:    scope("constant.character"),
			meta_string:           scope("meta.string"),
			constant_numeric:      scope("constant.numeric"),
			constant_integer:      scope("constant.integer"),
			constant:              scope("constant"),
			keyword:               scope("keyword"),
			storage_type:          scope("storage.type"),
			storage_modifier:      scope("storage.modifier"),
			entity_name_function:  scope("entity.name.function"),
			support_function:      scope("support.function"),
			meta_function_call:    scope("meta.function-call"),
			variable_function:     scope("variable.function"),
			entity_name_type:      scope("entity.name.type"),
			support_type:          scope("support.type"),
			support_class:         scope("support.class"),
			entity_name_class:     scope("entity.name.class"),
			entity_name_struct:    scope("entity.name.struct"),
			entity_name_enum:      scope("entity.name.enum"),
			entity_name_interface: scope("entity.name.interface"),
			entity_name_trait:     scope("entity.name.trait"),
			keyword_operator:      scope("keyword.operator"),
			punctuation_accessor:  scope("punctuation.accessor"),
			punctuation:           scope("punctuation"),
			variable:              scope("variable"),
			entity_name:           scope("entity.name"),
			meta_path:             scope("meta.path"),
			markup_inserted:       scope("markup.inserted"),
			markup_deleted:        scope("markup.deleted"),
			meta_diff_header:      scope("meta.diff.header"),
			meta_diff_range:       scope("meta.diff.range"),
		}
	}
}

fn scope(name: &str) -> Scope {
	Scope::new(name).expect("static syntax scope must be valid")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::Color;

	fn color_containing(lines: &RichText, needle: &str) -> Color {
		(0..lines.rows())
			.flat_map(|row| lines.row_runs(row))
			.find_map(|(style, text)| text.contains(needle).then(|| style.foreground_color()))
			.unwrap_or_else(|| panic!("missing syntax segment {needle:?}"))
	}

	#[test]
	fn bundled_syntaxes_and_aliases_resolve() {
		for language in ["rs", "typescript", "nix", "mermaid", "mmd"] {
			assert!(supports_language(language), "{language}");
		}
		assert!(!supports_language(""));
		assert!(!supports_language("not-a-language"));
	}

	#[test]
	fn bundled_syntaxes_apply_semantic_colors() {
		let palette = Theme::default();
		let styles = HighlightStyles::from_theme(&palette);
		let nix = "let message = \"hello\"; in message # greeting";
		let mut rendered = RichText::default();
		assert!(render(nix, "nix", 1, &styles, &mut rendered));
		assert_eq!(color_containing(&rendered, "let"), palette.accent);
		assert_eq!(color_containing(&rendered, "hello"), palette.code_border);
		assert_eq!(color_containing(&rendered, "greeting"), palette.muted);

		let mermaid = "graph TD\n  A[\"Start\"] --> B\n  %% note";
		rendered.clear();
		assert!(render(mermaid, "mermaid", 3, &styles, &mut rendered));
		assert_eq!(color_containing(&rendered, "graph"), palette.accent);
		assert_eq!(color_containing(&rendered, "Start"), palette.code_border);
		assert_eq!(color_containing(&rendered, "-->"), palette.accent);
		assert_eq!(color_containing(&rendered, "note"), palette.muted);
	}
}
