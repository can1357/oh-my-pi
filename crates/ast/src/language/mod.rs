//! Vendored and extended language definitions for ast-grep integration.
//!
//! Originally derived from `ast-grep-language` v0.39.9, stripped of
//! serde/ignore machinery, and extended with additional languages.
//!
//! Upstream: <https://github.com/ast-grep/ast-grep>
//! Copyright (c) 2022 Herrington Darkholme; licensed under MIT.
//! See this package's `NOTICE` and `LICENSE` for attribution and terms.

mod parsers;

use std::{
	borrow::Cow,
	fmt::{self, Display},
	iter,
	path::Path,
	sync::LazyLock,
};

use ast_grep_core::{
	Doc, Language, Node,
	matcher::{KindMatcher, Pattern, PatternBuilder, PatternError},
	meta_var::MetaVariable,
	tree_sitter::{LanguageExt, StrDoc, TSLanguage, TSRange},
};

/// Implements a stub language (no expando / `pre_process_pattern` needed).
/// Use when the language grammar accepts `$VAR` as valid identifiers.
macro_rules! impl_lang {
	($lang:ident, $func:ident) => {
		#[doc = concat!("Ast-grep adapter for ", stringify!($lang), ".")]
		#[derive(Clone, Copy, Debug)]
		pub struct $lang;
		impl Language for $lang {
			fn kind_to_id(&self, kind: &str) -> u16 {
				self.get_ts_language().id_for_node_kind(kind, true)
			}

			fn field_to_id(&self, field: &str) -> Option<u16> {
				self
					.get_ts_language()
					.field_id_for_name(field)
					.map(|f| f.get())
			}

			fn build_pattern(&self, builder: &PatternBuilder) -> Result<Pattern, PatternError> {
				builder.build(|src| StrDoc::try_new(src, *self))
			}
		}
		impl LanguageExt for $lang {
			fn get_ts_language(&self) -> TSLanguage {
				parsers::$func().into()
			}
		}
	};
}

fn pre_process_pattern(expando: char, query: &str) -> Cow<'_, str> {
	if !query.contains('$') {
		return Cow::Borrowed(query);
	}
	let extra_capacity = query
		.bytes()
		.filter(|&byte| byte == b'$')
		.count()
		.saturating_mul(expando.len_utf8().saturating_sub(1));
	let mut ret = String::with_capacity(query.len().saturating_add(extra_capacity));
	let mut dollar_count = 0;
	for c in query.chars() {
		if c == '$' {
			dollar_count += 1;
			continue;
		}
		let need_replace = matches!(c, 'A'..='Z' | '_') || dollar_count == 3;
		let sigil = if need_replace { expando } else { '$' };
		ret.extend(iter::repeat_n(sigil, dollar_count));
		dollar_count = 0;
		ret.push(c);
	}
	let sigil = if dollar_count == 3 { expando } else { '$' };
	ret.extend(iter::repeat_n(sigil, dollar_count));
	Cow::Owned(ret)
}

/// Implements a language with `expando_char` / `pre_process_pattern`.
/// Use when the language does NOT accept `$` as a valid identifier character.
macro_rules! impl_lang_expando {
	($lang:ident, $func:ident, $char:expr) => {
		#[doc = concat!("Ast-grep adapter for ", stringify!($lang), ".")]
		#[derive(Clone, Copy, Debug)]
		pub struct $lang;
		impl Language for $lang {
			fn kind_to_id(&self, kind: &str) -> u16 {
				self.get_ts_language().id_for_node_kind(kind, true)
			}

			fn field_to_id(&self, field: &str) -> Option<u16> {
				self
					.get_ts_language()
					.field_id_for_name(field)
					.map(|f| f.get())
			}

			fn expando_char(&self) -> char {
				$char
			}

			fn pre_process_pattern<'q>(&self, query: &'q str) -> Cow<'q, str> {
				pre_process_pattern(self.expando_char(), query)
			}

			fn build_pattern(&self, builder: &PatternBuilder) -> Result<Pattern, PatternError> {
				builder.build(|src| StrDoc::try_new(src, *self))
			}
		}
		impl LanguageExt for $lang {
			fn get_ts_language(&self) -> TSLanguage {
				parsers::$func().into()
			}
		}
	};
}

// ── Customized languages with expando_char ──────────────────────────────

impl_lang_expando!(C, language_c, '𐀀');
impl_lang_expando!(Cpp, language_cpp, '𐀀');
impl_lang_expando!(CSharp, language_c_sharp, 'µ');
impl_lang_expando!(Cmake, language_cmake, 'µ');
impl_lang_expando!(Css, language_css, '_');
impl_lang_expando!(Dockerfile, language_dockerfile, 'µ');
impl_lang_expando!(Elixir, language_elixir, 'µ');
impl_lang_expando!(Erlang, language_erlang, 'µ');
impl_lang_expando!(Fortran, language_fortran, '𐀀');
impl_lang_expando!(Go, language_go, 'µ');
impl_lang!(Graphql, language_graphql);
impl_lang_expando!(Haskell, language_haskell, 'µ');
impl_lang_expando!(Hcl, language_hcl, 'µ');
impl_lang_expando!(Ini, language_ini, 'µ');
impl_lang_expando!(Just, language_just, 'µ');
impl_lang_expando!(Kotlin, language_kotlin, 'µ');
impl_lang_expando!(Nix, language_nix, '_');
impl_lang_expando!(Ocaml, language_ocaml, 'µ');
impl_lang_expando!(Php, language_php, 'µ');
impl_lang_expando!(Powershell, language_powershell, 'µ');
impl_lang_expando!(Proto, language_proto, 'µ');
impl_lang_expando!(Python, language_python, 'µ');
impl_lang_expando!(R, language_r, 'µ');
impl_lang_expando!(Ruby, language_ruby, 'µ');
impl_lang_expando!(Rust, language_rust, 'µ');
impl_lang_expando!(Sql, language_sql, 'µ');
impl_lang_expando!(Swift, language_swift, 'µ');

// New expando languages
impl_lang_expando!(Make, language_make, 'µ');
impl_lang_expando!(ObjC, language_objc, '𐀀');
impl_lang_expando!(Starlark, language_starlark, 'µ');
impl_lang_expando!(Odin, language_odin, 'µ');
impl_lang_expando!(Julia, language_julia, 'µ');
impl_lang_expando!(Verilog, language_verilog, 'µ');
impl_lang_expando!(Zig, language_zig, 'µ');
impl_lang_expando!(Tlaplus, language_tlaplus, 'µ');

// ── Stub languages ($ accepted in grammar) ──────────────────────────────

impl_lang!(Astro, language_astro);
impl_lang!(Bash, language_bash);
impl_lang!(Clojure, language_clojure);
impl_lang!(Java, language_java);
impl_lang!(JavaScript, language_javascript);
impl_lang!(Json, language_json);
impl_lang!(Lua, language_lua);
impl_lang!(Scala, language_scala);
impl_lang!(Solidity, language_solidity);
impl_lang!(Svelte, language_svelte);
impl_lang!(Tsx, language_tsx);
impl_lang!(TypeScript, language_typescript);
impl_lang!(Vue, language_vue);
impl_lang!(Yaml, language_yaml);

// New stub languages
impl_lang!(Markdown, language_markdown);
impl_lang!(Toml, language_toml);
impl_lang!(Diff, language_diff);
impl_lang!(Xml, language_xml);
impl_lang!(Regex, language_regex);
impl_lang!(Dart, language_dart);
impl_lang!(EmacsLisp, language_elisp);

// ── Html (custom implementation with injection support) ──────────────────

/// HTML language adapter with embedded-language injection support.
#[derive(Clone, Copy, Debug)]
pub struct Html;

impl Language for Html {
	fn expando_char(&self) -> char {
		'z'
	}

	fn pre_process_pattern<'q>(&self, query: &'q str) -> Cow<'q, str> {
		pre_process_pattern(self.expando_char(), query)
	}

	fn kind_to_id(&self, kind: &str) -> u16 {
		self.get_ts_language().id_for_node_kind(kind, true)
	}

	fn field_to_id(&self, field: &str) -> Option<u16> {
		self
			.get_ts_language()
			.field_id_for_name(field)
			.map(|f| f.get())
	}

	fn build_pattern(&self, builder: &PatternBuilder) -> Result<Pattern, PatternError> {
		builder.build(|src| StrDoc::try_new(src, *self))
	}
}

impl LanguageExt for Html {
	fn get_ts_language(&self) -> TSLanguage {
		parsers::language_html()
	}

	fn injectable_languages(&self) -> Option<&'static [&'static str]> {
		Some(&["css", "js", "ts", "tsx", "scss", "less", "stylus", "coffee"])
	}

	fn extract_injections<L: LanguageExt>(
		&self,
		root: Node<StrDoc<L>>,
	) -> Vec<(String, Vec<TSRange>)> {
		let lang = root.lang();
		let mut injections = Vec::new();
		let matcher = KindMatcher::new("script_element", lang.clone());
		for script in root.find_all(matcher) {
			if let Some(content) = script.children().find(|child| child.kind() == "raw_text") {
				push_html_injection(&mut injections, &script, "js", node_to_range(&content));
			}
		}
		let matcher = KindMatcher::new("style_element", lang.clone());
		for style in root.find_all(matcher) {
			if let Some(content) = style.children().find(|child| child.kind() == "raw_text") {
				push_html_injection(&mut injections, &style, "css", node_to_range(&content));
			}
		}
		injections
	}
}

fn push_html_injection<D: Doc>(
	injections: &mut Vec<(String, Vec<TSRange>)>,
	node: &Node<D>,
	default_language: &'static str,
	range: TSRange,
) {
	let html = node.lang();
	let attr_matcher = KindMatcher::new("attribute", html.clone());
	let name_matcher = KindMatcher::new("attribute_name", html.clone());
	let val_matcher = KindMatcher::new("attribute_value", html.clone());
	let value = node.find_all(attr_matcher).find_map(|attr| {
		let name = attr.find(&name_matcher)?;
		(name.text() == "lang")
			.then(|| attr.find(&val_matcher))
			.flatten()
	});
	if let Some(value) = value {
		let language = value.text();
		push_injection_range(injections, language.as_ref(), range);
	} else {
		push_injection_range(injections, default_language, range);
	}
}

fn push_injection_range(
	injections: &mut Vec<(String, Vec<TSRange>)>,
	language: &str,
	range: TSRange,
) {
	if let Some((_, ranges)) = injections.iter_mut().find(|(name, _)| name == language) {
		ranges.push(range);
		return;
	}
	injections.push((language.to_owned(), vec![range]));
}

fn node_to_range<D: Doc>(node: &Node<D>) -> TSRange {
	let r = node.range();
	let start = node.start_pos();
	let sp = start.byte_point();
	let sp = tree_sitter::Point::new(sp.0, sp.1);
	let end = node.end_pos();
	let ep = end.byte_point();
	let ep = tree_sitter::Point::new(ep.0, ep.1);
	TSRange { start_byte: r.start, end_byte: r.end, start_point: sp, end_point: ep }
}

// ── SupportLang enum ────────────────────────────────────────────────────

macro_rules! define_support_langs {
	(
		$(
			$(#[$meta:meta])*
			$variant:ident => $canonical:literal $(| $alias:literal)*
		),* $(,)?
	) => {
		/// All supported languages for ast-grep structural search/replace.
		#[derive(
			Clone,
			Copy,
			Debug,
			PartialEq,
			Eq,
			Hash,
			strum::EnumString,
			strum::IntoStaticStr,
		)]
		#[strum(ascii_case_insensitive)]
		pub enum SupportLang {
			$(
				$(#[$meta])*
				#[strum(to_string = $canonical $(, serialize = $alias)*)]
				$variant,
			)*
		}

		const LANG_ALIASES: &[&str] = &[
			$($canonical, $($alias,)*)*
		];

		impl SupportLang {
			/// Returns every supported language in stable declaration order.
			pub const fn all_langs() -> &'static [Self] {
				&[$(Self::$variant),*]
			}

			/// Converts this language to its canonical lowercase identifier.
			pub const fn into_str(self) -> &'static str {
				match self {
					$(Self::$variant => $canonical,)*
				}
			}

			/// The canonical lowercase name used as a stable key in alias maps,
			/// file-type inference results, and error messages.
			pub const fn canonical_name(self) -> &'static str {
				self.into_str()
			}

			/// Resolves a case-insensitive language alias.
			pub fn from_alias(value: &str) -> Option<Self> {
				value.trim().parse().ok()
			}

			/// Infers a language from a path extension or filename.
			pub fn from_path(path: &Path) -> Option<Self> {
				from_extension(path)
			}
			/// Syntax-highlighter identifier for this parsed language.
			pub const fn highlight_id(self) -> &'static str {
				self.canonical_name()
			}

			/// LSP `textDocument/didOpen` identifier for this language and path.
			///
			/// The path distinguishes dialect extensions such as TSX/JSX and
			/// Terraform from their shared parser language.
			pub fn lsp_id(self, path: &Path) -> &'static str {
				let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("");
				match self {
					Self::Tsx => "typescriptreact",
					Self::JavaScript if extension.eq_ignore_ascii_case("jsx") => "javascriptreact",
					Self::Bash => "shellscript",
					Self::Hcl if extension.eq_ignore_ascii_case("tf") => "terraform",
					Self::Make if path.file_name().and_then(|value| value.to_str()).is_some_and(|name| {
						name.eq_ignore_ascii_case("makefile") || name.eq_ignore_ascii_case("gnumakefile")
					}) => "makefile",
					Self::ObjC
					| Self::Solidity
					| Self::Odin
					| Self::Starlark
					| Self::Verilog
					| Self::Diff
					| Self::Just => "plaintext",
					_ => self.canonical_name(),
				}
			}

			/// Returns every accepted alias in sorted order.
			pub fn sorted_aliases() -> &'static [&'static str] {
				&SORTED_ALIASES
			}
		}
	};
}

define_support_langs! {
	/// Astro.
	Astro => "astro",
	/// Bash.
	Bash => "bash" | "sh" | "zsh" | "ksh" | "bats",
	/// C.
	C => "c" | "h",
	/// `CMake`.
	Cmake => "cmake",
	/// C++.
	Cpp => "cpp" | "c++" | "cc" | "cxx" | "hh" | "hpp" | "cu" | "ino",
	/// C#.
	CSharp => "csharp" | "c#" | "cs",
	/// Dart.
	Dart => "dart",
	/// Clojure.
	Clojure => "clojure" | "clj" | "cljc" | "cljs" | "clojurescript" | "edn",
	/// CSS.
	Css => "css",
	/// Unified diff.
	Diff => "diff" | "patch",
	/// Dockerfile.
	Dockerfile => "dockerfile" | "docker" | "containerfile",
	/// Emacs Lisp.
	EmacsLisp => "emacs-lisp" | "emacslisp" | "elisp" | "el",
	/// Elixir.
	Elixir => "elixir" | "ex" | "exs",
	/// Erlang.
	Erlang => "erlang" | "erl" | "hrl",
	/// Fortran.
	Fortran => "fortran" | "f90" | "f95" | "f03" | "f08",
	/// Go.
	Go => "go" | "golang",
	/// GraphQL.
	Graphql => "graphql" | "gql",
	/// Haskell.
	Haskell => "haskell" | "hs",
	/// HCL.
	Hcl => "hcl" | "tf" | "tfvars" | "terraform",
	/// HTML.
	Html => "html" | "htm" | "xhtml",
	/// INI.
	Ini => "ini" | "cfg" | "conf" | "config" | "properties",
	/// Java.
	Java => "java",
	/// JavaScript.
	JavaScript => "javascript" | "js" | "jsx" | "mjs" | "cjs",
	/// JSON.
	Json => "json",
	/// Just.
	Just => "just" | "justfile",
	/// Julia.
	Julia => "julia" | "jl",
	/// Kotlin.
	Kotlin => "kotlin" | "kt" | "kts" | "ktm",
	/// Lua.
	Lua => "lua",
	/// Make.
	Make => "make" | "makefile" | "gnumake" | "mk" | "mak",
	/// Markdown.
	Markdown => "markdown" | "md" | "mdx",
	/// Nix.
	Nix => "nix",
	/// Objective-C.
	ObjC => "objc" | "obj-c" | "objective-c" | "m" | "mm",
	/// OCaml.
	Ocaml => "ocaml" | "ml",
	/// Odin.
	Odin => "odin",
	/// PHP.
	Php => "php",
	/// PowerShell.
	Powershell => "powershell" | "ps1" | "psm1",
	/// Protocol Buffers.
	Proto => "protobuf" | "proto",
	/// Python.
	Python => "python" | "py" | "py3" | "pyi",
	/// R.
	R => "r",
	/// Regular expressions.
	Regex => "regex" | "re",
	/// Ruby.
	Ruby => "ruby" | "rb" | "rbw" | "gemspec",
	/// Rust.
	Rust => "rust" | "rs",
	/// Scala.
	Scala => "scala" | "sc" | "sbt",
	/// Solidity.
	Solidity => "solidity" | "sol",
	/// SQL.
	Sql => "sql",
	/// Starlark.
	Starlark => "starlark" | "star" | "bzl" | "bazel" | "skylark",
	/// Svelte.
	Svelte => "svelte",
	/// Swift.
	Swift => "swift",
	/// TOML.
	Toml => "toml",
	/// TLA+.
	Tlaplus => "tlaplus" | "tla" | "tla+" | "pluscal" | "pcal",
	/// TSX.
	Tsx => "tsx",
	/// TypeScript.
	TypeScript => "typescript" | "ts" | "mts" | "cts",
	/// Verilog.
	Verilog => "verilog" | "systemverilog" | "sv" | "svh" | "vh" | "v",
	/// Vue.
	Vue => "vue",
	/// XML.
	Xml => "xml" | "xsl" | "xslt" | "svg" | "plist",
	/// YAML.
	Yaml => "yaml" | "yml",
	/// Zig.
	Zig => "zig",
}

static SORTED_ALIASES: LazyLock<Box<[&'static str]>> = LazyLock::new(|| {
	let mut aliases = LANG_ALIASES.to_vec().into_boxed_slice();
	aliases.sort_unstable();
	aliases
});

impl Display for SupportLang {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{self:?}")
	}
}

/// Highlight and language-server identifiers inferred from one path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LanguageIds {
	/// Syntax-highlighter identifier.
	pub highlight: &'static str,
	/// LSP `textDocument/didOpen` identifier.
	pub lsp:       &'static str,
}

/// Infers separate highlighter and LSP identifiers from a path.
///
/// `.env` and `.env.*` are presentation-only text formats and therefore do
/// not pretend to have an AST parser.
pub fn language_ids_from_path(path: &Path) -> Option<LanguageIds> {
	let name = path.file_name()?.to_str()?;
	if name.eq_ignore_ascii_case(".env")
		|| name
			.get(..5)
			.is_some_and(|prefix| prefix.eq_ignore_ascii_case(".env."))
	{
		return Some(LanguageIds { highlight: "env", lsp: "plaintext" });
	}
	let language = SupportLang::from_path(path)?;
	Some(LanguageIds { highlight: language.highlight_id(), lsp: language.lsp_id(path) })
}

/// Returns the syntax-highlighter identifier inferred from `path`.
pub fn highlight_language_id(path: &Path) -> Option<&'static str> {
	language_ids_from_path(path).map(|ids| ids.highlight)
}

/// Returns the LSP language identifier, falling back to `plaintext`.
pub fn lsp_language_id(path: &Path) -> &'static str {
	language_ids_from_path(path).map_or("plaintext", |ids| ids.lsp)
}

// ── Dispatch macro ──────────────────────────────────────────────────────

macro_rules! execute_lang_method {
	($me:expr, $method:ident, $($pname:tt),*) => {
		use SupportLang as S;
		match *$me {
			S::Astro => Astro.$method($($pname,)*),
			S::Bash => Bash.$method($($pname,)*),
			S::C => C.$method($($pname,)*),
			S::Cmake => Cmake.$method($($pname,)*),
			S::Cpp => Cpp.$method($($pname,)*),
			S::CSharp => CSharp.$method($($pname,)*),
			S::Dart => Dart.$method($($pname,)*),
			S::Clojure => Clojure.$method($($pname,)*),
			S::Css => Css.$method($($pname,)*),
			S::Diff => Diff.$method($($pname,)*),
			S::Dockerfile => Dockerfile.$method($($pname,)*),
			S::EmacsLisp => EmacsLisp.$method($($pname,)*),
			S::Elixir => Elixir.$method($($pname,)*),
			S::Erlang => Erlang.$method($($pname,)*),
			S::Fortran => Fortran.$method($($pname,)*),
			S::Go => Go.$method($($pname,)*),
			S::Graphql => Graphql.$method($($pname,)*),
			S::Haskell => Haskell.$method($($pname,)*),
			S::Hcl => Hcl.$method($($pname,)*),
			S::Html => Html.$method($($pname,)*),
			S::Ini => Ini.$method($($pname,)*),
			S::Java => Java.$method($($pname,)*),
			S::JavaScript => JavaScript.$method($($pname,)*),
			S::Json => Json.$method($($pname,)*),
			S::Just => Just.$method($($pname,)*),
			S::Julia => Julia.$method($($pname,)*),
			S::Kotlin => Kotlin.$method($($pname,)*),
			S::Lua => Lua.$method($($pname,)*),
			S::Make => Make.$method($($pname,)*),
			S::Markdown => Markdown.$method($($pname,)*),
			S::Nix => Nix.$method($($pname,)*),
			S::ObjC => ObjC.$method($($pname,)*),
			S::Ocaml => Ocaml.$method($($pname,)*),
			S::Odin => Odin.$method($($pname,)*),
			S::Php => Php.$method($($pname,)*),
			S::Powershell => Powershell.$method($($pname,)*),
			S::Proto => Proto.$method($($pname,)*),
			S::Python => Python.$method($($pname,)*),
			S::R => R.$method($($pname,)*),
			S::Regex => Regex.$method($($pname,)*),
			S::Ruby => Ruby.$method($($pname,)*),
			S::Rust => Rust.$method($($pname,)*),
			S::Scala => Scala.$method($($pname,)*),
			S::Solidity => Solidity.$method($($pname,)*),
			S::Sql => Sql.$method($($pname,)*),
			S::Starlark => Starlark.$method($($pname,)*),
			S::Svelte => Svelte.$method($($pname,)*),
			S::Swift => Swift.$method($($pname,)*),
			S::Toml => Toml.$method($($pname,)*),
			S::Tlaplus => Tlaplus.$method($($pname,)*),
			S::Tsx => Tsx.$method($($pname,)*),
			S::TypeScript => TypeScript.$method($($pname,)*),
			S::Verilog => Verilog.$method($($pname,)*),
			S::Vue => Vue.$method($($pname,)*),
			S::Xml => Xml.$method($($pname,)*),
			S::Yaml => Yaml.$method($($pname,)*),
			S::Zig => Zig.$method($($pname,)*),
		}
	};
}

macro_rules! impl_lang_method {
	($method:ident, ($($pname:tt: $ptype:ty),*) => $return_type:ty) => {
		#[inline]
		fn $method(&self, $($pname: $ptype),*) -> $return_type {
			execute_lang_method! { self, $method, $($pname),* }
		}
	};
}

impl Language for SupportLang {
	impl_lang_method!(kind_to_id, (kind: &str) => u16);

	impl_lang_method!(field_to_id, (field: &str) => Option<u16>);

	impl_lang_method!(meta_var_char, () => char);

	impl_lang_method!(expando_char, () => char);

	impl_lang_method!(extract_meta_var, (source: &str) => Option<MetaVariable>);

	impl_lang_method!(build_pattern, (builder: &PatternBuilder) => Result<Pattern, PatternError>);

	fn pre_process_pattern<'q>(&self, query: &'q str) -> Cow<'q, str> {
		execute_lang_method! { self, pre_process_pattern, query }
	}

	fn from_path<P: AsRef<Path>>(path: P) -> Option<Self> {
		from_extension(path.as_ref())
	}
}

impl LanguageExt for SupportLang {
	impl_lang_method!(get_ts_language, () => TSLanguage);

	impl_lang_method!(injectable_languages, () => Option<&'static [&'static str]>);

	fn extract_injections<L: LanguageExt>(
		&self,
		root: Node<StrDoc<L>>,
	) -> Vec<(String, Vec<TSRange>)> {
		match self {
			Self::Html => Html.extract_injections(root),
			_ => Vec::new(),
		}
	}
}

// ── File extension mapping ──────────────────────────────────────────────

const fn extensions(lang: SupportLang) -> &'static [&'static str] {
	use SupportLang::*;
	match lang {
		Astro => &["astro"],
		Bash => {
			&["bash", "bats", "cgi", "command", "env", "fcgi", "ksh", "sh", "tmux", "tool", "zsh"]
		},
		C => &["c", "h"],
		Cmake => &["cmake"],
		Cpp => &["cc", "hpp", "cpp", "c++", "hh", "cxx", "cu", "ino"],
		CSharp => &["cs"],
		Dart => &["dart"],
		Clojure => &["clj", "cljs", "cljc", "edn"],
		Css => &["css", "scss"],
		Diff => &["diff", "patch"],
		Dockerfile => &["dockerfile"],
		EmacsLisp => &["el"],
		Elixir => &["ex", "exs"],
		Erlang => &["erl", "hrl"],
		Fortran => &["f90", "F90", "f95", "F95", "f03", "F03", "f08", "F08"],
		Go => &["go"],
		Graphql => &["graphql", "gql"],
		Haskell => &["hs"],
		Hcl => &["hcl", "tf", "tfvars"],
		Html => &["html", "htm", "xhtml"],
		Ini => &["ini", "cfg", "conf", "properties"],
		Java => &["java"],
		JavaScript => &["cjs", "js", "mjs", "jsx"],
		Json => &["json"],
		Just => &[],
		Julia => &["jl"],
		Kotlin => &["kt", "ktm", "kts"],
		Lua => &["lua"],
		Make => &["mk", "mak"],
		Markdown => &["md", "markdown", "mdx"],
		Nix => &["nix"],
		ObjC => &["m", "mm"],
		Ocaml => &["ml"],
		Odin => &["odin"],
		Php => &["php"],
		Powershell => &["ps1", "psm1"],
		Proto => &["proto"],
		Python => &["py", "py3", "pyi"],
		R => &["r"],
		Regex => &[],
		Ruby => &["rb", "rbw", "gemspec"],
		Rust => &["rs"],
		Scala => &["scala", "sc", "sbt"],
		Solidity => &["sol"],
		Sql => &["sql"],
		Starlark => &["star", "bzl"],
		Svelte => &["svelte"],
		Swift => &["swift"],
		Toml => &["toml"],
		Tlaplus => &["tla"],
		Tsx => &["tsx"],
		TypeScript => &["ts", "cts", "mts"],
		Verilog => &["v", "sv", "svh", "vh"],
		Vue => &["vue"],
		Xml => &["xml", "xsl", "xslt", "svg", "plist"],
		Yaml => &["yaml", "yml"],
		Zig => &["zig"],
	}
}

/// Guess language from file extension.
fn from_extension(path: &Path) -> Option<SupportLang> {
	let name = path.file_name()?.to_str()?;
	if name == "Makefile" || name == "makefile" || name == "GNUmakefile" {
		return Some(SupportLang::Make);
	}
	if name == "Justfile" || name == "justfile" {
		return Some(SupportLang::Just);
	}
	if name == "CMakeLists.txt" {
		return Some(SupportLang::Cmake);
	}
	if name == "Dockerfile"
		|| name == "dockerfile"
		|| name.starts_with("Dockerfile.")
		|| name.starts_with("dockerfile.")
		|| name == "Containerfile"
		|| name == "containerfile"
	{
		return Some(SupportLang::Dockerfile);
	}
	if name == ".emacs" {
		return Some(SupportLang::EmacsLisp);
	}

	// Extensionless shell rc/profile files. `Path::extension` returns `None`
	// for both bare (`zshrc`) and dotfile (`.zshrc`) forms, so they would
	// otherwise resolve to no language and disable block-aware ops on them.
	let stem = name.strip_prefix('.').unwrap_or(name);
	if matches!(
		stem,
		"zshrc"
			| "zshenv"
			| "zprofile"
			| "zlogin"
			| "zlogout"
			| "zsh_aliases"
			| "bashrc"
			| "bash_profile"
			| "bash_login"
			| "bash_logout"
			| "bash_aliases"
			| "profile"
			| "kshrc"
			| "mkshrc"
			| "shrc"
	) {
		return Some(SupportLang::Bash);
	}

	let ext = path.extension()?.to_str()?;
	SupportLang::all_langs()
		.iter()
		.copied()
		.find(|&l| extensions(l).contains(&ext))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn path_ids_keep_highlight_and_lsp_dialects_separate() {
		assert_eq!(
			language_ids_from_path(Path::new("view.tsx")),
			Some(LanguageIds { highlight: "tsx", lsp: "typescriptreact" })
		);
		assert_eq!(
			language_ids_from_path(Path::new("view.jsx")),
			Some(LanguageIds { highlight: "javascript", lsp: "javascriptreact" })
		);
		assert_eq!(
			language_ids_from_path(Path::new(".env.production")),
			Some(LanguageIds { highlight: "env", lsp: "plaintext" })
		);
		assert_eq!(lsp_language_id(Path::new("unknown.bin")), "plaintext");
	}
	#[test]
	fn extension_inference_selects_starlark_and_objective_cpp_grammars() {
		assert_eq!(from_extension(Path::new("rules.bzl")), Some(SupportLang::Starlark));
		assert_eq!(from_extension(Path::new("bridge.mm")), Some(SupportLang::ObjC));
	}
}
