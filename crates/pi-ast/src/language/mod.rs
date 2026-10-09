//! Vendored and extended language definitions for ast-grep integration.
//!
//! Originally derived from `ast-grep-language` v0.39.9, stripped of
//! serde/ignore machinery, and extended with additional languages. Grammars
//! are either linked in or downloaded as WebAssembly; see [`grammar`].

pub mod grammar;
mod parsers;
pub mod wasm_grammars;

use std::{borrow::Cow, collections::HashMap, fmt, path::Path, sync::LazyLock};

use ast_grep_core::{
	AstGrep, Doc, Language, Node,
	matcher::{KindMatcher, Pattern, PatternBuilder, PatternError},
	meta_var::MetaVariable,
	tree_sitter::{LanguageExt, StrDoc, TSLanguage, TSRange},
};
use phf::phf_map;

use self::grammar::{GrammarSource, LanguageGrammar, WasmGrammar};

/// Grammar source of a language: `native <parsers fn>` or `wasm <wasm_grammars
/// static>`.
macro_rules! grammar {
	(native $func:ident) => {
		GrammarSource::Native(parsers::$func)
	};
	(wasm $grammar:ident) => {
		GrammarSource::Wasm(&wasm_grammars::$grammar)
	};
}

/// Parses `src` into a [`StrDoc`]. ast-grep's own `StrDoc::try_new` uses a
/// bare parser, which cannot run wasm grammars.
fn parse_doc<L: LanguageExt + LanguageGrammar>(src: &str, lang: L) -> Result<StrDoc<L>, String> {
	let language = lang.grammar().load().map_err(|err| err.to_string())?;
	let tree = grammar::parse(&language, src)
		.map_err(|err| err.to_string())?
		.ok_or("tree-sitter produced no tree")?;
	Ok(StrDoc { src: src.to_owned(), lang, tree })
}

/// `LanguageExt::ast_grep` through [`parse_doc`]; panics when parsing fails,
/// like ast-grep's default.
fn ast_grep_doc<L: LanguageExt + LanguageGrammar>(src: &str, lang: L) -> AstGrep<StrDoc<L>> {
	AstGrep::doc(parse_doc(src, lang).unwrap_or_else(|err| panic!("{err}")))
}

/// `LanguageExt::get_ts_language` for `lang`; panics when its wasm grammar is
/// not installed (see [`grammar`]).
fn loaded_language(lang: &impl LanguageGrammar) -> TSLanguage {
	lang.grammar().load().unwrap_or_else(|err| panic!("{err}"))
}

/// Implements a stub language (no expando / `pre_process_pattern` needed).
/// Use when the language grammar accepts `$VAR` as valid identifiers.
macro_rules! impl_lang {
	($lang:ident, $($grammar:tt)+) => {
		#[derive(Clone, Copy, Debug)]
		pub struct $lang;
		impl LanguageGrammar for $lang {
			fn grammar(&self) -> GrammarSource {
				grammar!($($grammar)+)
			}
		}
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
				builder.build(|src| parse_doc(src, *self))
			}
		}
		impl LanguageExt for $lang {
			fn ast_grep<S: AsRef<str>>(&self, source: S) -> AstGrep<StrDoc<Self>> {
				ast_grep_doc(source.as_ref(), *self)
			}

			fn get_ts_language(&self) -> TSLanguage {
				loaded_language(self)
			}
		}
	};
}

fn pre_process_pattern(expando: char, query: &str) -> Cow<'_, str> {
	let mut ret = Vec::with_capacity(query.len());
	let mut dollar_count = 0;
	for c in query.chars() {
		if c == '$' {
			dollar_count += 1;
			continue;
		}
		let need_replace = matches!(c, 'A'..='Z' | '_') || dollar_count == 3;
		let sigil = if need_replace { expando } else { '$' };
		ret.extend(std::iter::repeat_n(sigil, dollar_count));
		dollar_count = 0;
		ret.push(c);
	}
	let sigil = if dollar_count == 3 { expando } else { '$' };
	ret.extend(std::iter::repeat_n(sigil, dollar_count));
	Cow::Owned(ret.into_iter().collect())
}

/// Implements a language with `expando_char` / `pre_process_pattern`.
/// Use when the language does NOT accept `$` as a valid identifier character.
macro_rules! impl_lang_expando {
	($lang:ident, $char:expr, $($grammar:tt)+) => {
		#[derive(Clone, Copy, Debug)]
		pub struct $lang;
		impl LanguageGrammar for $lang {
			fn grammar(&self) -> GrammarSource {
				grammar!($($grammar)+)
			}
		}
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
				builder.build(|src| parse_doc(src, *self))
			}
		}
		impl LanguageExt for $lang {
			fn ast_grep<S: AsRef<str>>(&self, source: S) -> AstGrep<StrDoc<Self>> {
				ast_grep_doc(source.as_ref(), *self)
			}

			fn get_ts_language(&self) -> TSLanguage {
				loaded_language(self)
			}
		}
	};
}

// ── Customized languages with expando_char ──────────────────────────────

impl_lang_expando!(C, '𐀀', native language_c);
impl_lang_expando!(Cpp, '𐀀', native language_cpp);
impl_lang_expando!(CSharp, 'µ', wasm CSHARP);
impl_lang_expando!(Cmake, 'µ', wasm CMAKE);
impl_lang_expando!(Css, '_', native language_css);
impl_lang_expando!(Dockerfile, 'µ', wasm DOCKERFILE);
impl_lang_expando!(Elixir, 'µ', wasm ELIXIR);
impl_lang_expando!(Erlang, 'µ', wasm ERLANG);
impl_lang_expando!(Fortran, '𐀀', wasm FORTRAN);
impl_lang_expando!(Go, 'µ', native language_go);
impl_lang!(Graphql, wasm GRAPHQL);
impl_lang_expando!(Haskell, 'µ', wasm HASKELL);
impl_lang_expando!(Hcl, 'µ', wasm HCL);
impl_lang_expando!(Ini, 'µ', wasm INI);
impl_lang_expando!(Just, 'µ', wasm JUST);
impl_lang_expando!(Kotlin, 'µ', wasm KOTLIN);
impl_lang_expando!(Nix, '_', wasm NIX);
impl_lang_expando!(Ocaml, 'µ', wasm OCAML);
impl_lang_expando!(Php, 'µ', wasm PHP);
impl_lang_expando!(Powershell, 'µ', wasm POWERSHELL);
impl_lang_expando!(Proto, 'µ', wasm PROTOBUF);
impl_lang_expando!(Python, 'µ', native language_python);
impl_lang_expando!(R, 'µ', wasm R);
impl_lang_expando!(Ruby, 'µ', wasm RUBY);
impl_lang_expando!(Rust, 'µ', native language_rust);
impl_lang_expando!(Sql, 'µ', wasm SQL);
impl_lang_expando!(Swift, 'µ', wasm SWIFT);

// New expando languages
impl_lang_expando!(Make, 'µ', wasm MAKE);
impl_lang_expando!(ObjC, '𐀀', wasm OBJC);
impl_lang_expando!(Starlark, 'µ', wasm STARLARK);
impl_lang_expando!(Odin, 'µ', wasm ODIN);
impl_lang_expando!(Julia, 'µ', wasm JULIA);
impl_lang_expando!(Verilog, 'µ', wasm VERILOG);
impl_lang_expando!(Zig, 'µ', wasm ZIG);
impl_lang_expando!(Tlaplus, 'µ', wasm TLAPLUS);

// ── Stub languages ($ accepted in grammar) ──────────────────────────────

impl_lang!(Astro, wasm ASTRO);
impl_lang!(Bash, native language_bash);
impl_lang!(Clojure, wasm CLOJURE);
impl_lang!(Java, native language_java);
impl_lang!(JavaScript, native language_javascript);
impl_lang!(Json, native language_json);
impl_lang!(Lua, wasm LUA);
impl_lang!(Scala, wasm SCALA);
impl_lang!(Solidity, wasm SOLIDITY);
impl_lang!(Svelte, wasm SVELTE);
impl_lang!(Tsx, native language_tsx);
impl_lang!(TypeScript, native language_typescript);
impl_lang!(Vue, wasm VUE);
impl_lang!(Yaml, native language_yaml);

// New stub languages
impl_lang!(Markdown, native language_markdown);
impl_lang!(Toml, native language_toml);
impl_lang!(Diff, native language_diff);
impl_lang!(Xml, wasm XML);
impl_lang!(Regex, native language_regex);
impl_lang!(Dart, wasm DART);
impl_lang!(EmacsLisp, wasm EMACS_LISP);

// ── Html (custom implementation with injection support) ──────────────────

#[derive(Clone, Copy, Debug)]
pub struct Html;

impl LanguageGrammar for Html {
	fn grammar(&self) -> GrammarSource {
		grammar!(native language_html)
	}
}

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
		builder.build(|src| parse_doc(src, *self))
	}
}

impl LanguageExt for Html {
	fn ast_grep<S: AsRef<str>>(&self, source: S) -> AstGrep<StrDoc<Self>> {
		ast_grep_doc(source.as_ref(), *self)
	}

	fn get_ts_language(&self) -> TSLanguage {
		loaded_language(self)
	}

	fn injectable_languages(&self) -> Option<&'static [&'static str]> {
		Some(&["css", "js", "ts", "tsx", "scss", "less", "stylus", "coffee"])
	}

	fn extract_injections<L: LanguageExt>(
		&self,
		root: Node<StrDoc<L>>,
	) -> HashMap<String, Vec<TSRange>> {
		let lang = root.lang();
		let mut map = HashMap::new();
		let matcher = KindMatcher::new("script_element", lang.clone());
		for script in root.find_all(matcher) {
			let injected = find_html_lang(&script).unwrap_or_else(|| "js".into());
			let content = script.children().find(|c| c.kind() == "raw_text");
			if let Some(content) = content {
				map.entry(injected)
					.or_insert_with(Vec::new)
					.push(node_to_range(&content));
			}
		}
		let matcher = KindMatcher::new("style_element", lang.clone());
		for style in root.find_all(matcher) {
			let injected = find_html_lang(&style).unwrap_or_else(|| "css".into());
			let content = style.children().find(|c| c.kind() == "raw_text");
			if let Some(content) = content {
				map.entry(injected)
					.or_insert_with(Vec::new)
					.push(node_to_range(&content));
			}
		}
		map
	}
}

fn find_html_lang<D: Doc>(node: &Node<D>) -> Option<String> {
	let html = node.lang();
	let attr_matcher = KindMatcher::new("attribute", html.clone());
	let name_matcher = KindMatcher::new("attribute_name", html.clone());
	let val_matcher = KindMatcher::new("attribute_value", html.clone());
	node.find_all(attr_matcher).find_map(|attr| {
		let name = attr.find(&name_matcher)?;
		if name.text() != "lang" {
			return None;
		}
		let val = attr.find(&val_matcher)?;
		Some(val.text().to_string())
	})
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

/// All supported languages for ast-grep structural search/replace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SupportLang {
	Astro,
	Bash,
	C,
	Cmake,
	Cpp,
	CSharp,
	Dart,
	Clojure,
	Css,
	Diff,
	Dockerfile,
	EmacsLisp,
	Elixir,
	Erlang,
	Fortran,
	Go,
	Graphql,
	Haskell,
	Hcl,
	Html,
	Ini,
	Java,
	JavaScript,
	Json,
	Just,
	Julia,
	Kotlin,
	Lua,
	Make,
	Markdown,
	Nix,
	ObjC,
	Ocaml,
	Odin,
	Php,
	Powershell,
	Proto,
	Python,
	R,
	Regex,
	Ruby,
	Rust,
	Scala,
	Solidity,
	Sql,
	Starlark,
	Svelte,
	Swift,
	Toml,
	Tlaplus,
	Tsx,
	TypeScript,
	Verilog,
	Vue,
	Xml,
	Yaml,
	Zig,
}

static SORTED_ALIASES: LazyLock<Box<[&'static str]>> = LazyLock::new(|| {
	let mut aliases = LANG_ALIASES.keys().copied().collect::<Box<[_]>>();
	aliases.sort_unstable();
	aliases
});

impl SupportLang {
	pub const fn all_langs() -> &'static [Self] {
		use SupportLang::*;
		&[
			Astro, Bash, C, Cmake, Cpp, CSharp, Dart, Clojure, Css, Diff, Dockerfile, EmacsLisp,
			Elixir, Erlang, Fortran, Go, Graphql, Haskell, Hcl, Html, Ini, Java, JavaScript, Json,
			Just, Julia, Kotlin, Lua, Make, Markdown, Nix, ObjC, Ocaml, Odin, Php, Powershell, Proto,
			Python, R, Regex, Ruby, Rust, Scala, Solidity, Sql, Starlark, Svelte, Swift, Toml,
			Tlaplus, Tsx, TypeScript, Verilog, Vue, Xml, Yaml, Zig,
		]
	}

	/// The canonical lowercase name used as a stable key in alias maps,
	/// file-type inference results, and error messages.
	pub const fn canonical_name(self) -> &'static str {
		match self {
			Self::Astro => "astro",
			Self::Bash => "bash",
			Self::C => "c",
			Self::Cmake => "cmake",
			Self::Cpp => "cpp",
			Self::CSharp => "csharp",
			Self::Dart => "dart",
			Self::Clojure => "clojure",
			Self::Css => "css",
			Self::Diff => "diff",
			Self::Dockerfile => "dockerfile",
			Self::EmacsLisp => "emacs-lisp",
			Self::Elixir => "elixir",
			Self::Erlang => "erlang",
			Self::Fortran => "fortran",
			Self::Go => "go",
			Self::Graphql => "graphql",
			Self::Haskell => "haskell",
			Self::Hcl => "hcl",
			Self::Html => "html",
			Self::Ini => "ini",
			Self::Java => "java",
			Self::JavaScript => "javascript",
			Self::Json => "json",
			Self::Just => "just",
			Self::Julia => "julia",
			Self::Kotlin => "kotlin",
			Self::Lua => "lua",
			Self::Make => "make",
			Self::Markdown => "markdown",
			Self::Nix => "nix",
			Self::ObjC => "objc",
			Self::Ocaml => "ocaml",
			Self::Odin => "odin",
			Self::Php => "php",
			Self::Powershell => "powershell",
			Self::Proto => "protobuf",
			Self::Python => "python",
			Self::R => "r",
			Self::Regex => "regex",
			Self::Ruby => "ruby",
			Self::Rust => "rust",
			Self::Scala => "scala",
			Self::Solidity => "solidity",
			Self::Sql => "sql",
			Self::Starlark => "starlark",
			Self::Svelte => "svelte",
			Self::Swift => "swift",
			Self::Toml => "toml",
			Self::Tlaplus => "tlaplus",
			Self::Tsx => "tsx",
			Self::TypeScript => "typescript",
			Self::Verilog => "verilog",
			Self::Vue => "vue",
			Self::Xml => "xml",
			Self::Yaml => "yaml",
			Self::Zig => "zig",
		}
	}

	pub fn from_alias(value: &str) -> Option<Self> {
		let lowered = value.trim().to_ascii_lowercase();
		LANG_ALIASES.get(lowered.as_str()).copied()
	}

	pub fn from_path(path: &Path) -> Option<Self> {
		from_extension(path)
	}

	pub fn sorted_aliases() -> &'static [&'static str] {
		&SORTED_ALIASES
	}

	/// The WebAssembly grammar this language downloads on demand; `None` when
	/// its grammar is linked into the addon.
	pub fn wasm_grammar(self) -> Option<&'static WasmGrammar> {
		match self.grammar() {
			GrammarSource::Wasm(grammar) => Some(grammar),
			GrammarSource::Native(_) => None,
		}
	}
}

impl fmt::Display for SupportLang {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{self:?}")
	}
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

impl LanguageGrammar for SupportLang {
	impl_lang_method!(grammar, () => GrammarSource);
}

impl LanguageExt for SupportLang {
	impl_lang_method!(get_ts_language, () => TSLanguage);

	impl_lang_method!(injectable_languages, () => Option<&'static [&'static str]>);

	fn ast_grep<S: AsRef<str>>(&self, source: S) -> AstGrep<StrDoc<Self>> {
		ast_grep_doc(source.as_ref(), *self)
	}

	fn extract_injections<L: LanguageExt>(
		&self,
		root: Node<StrDoc<L>>,
	) -> HashMap<String, Vec<TSRange>> {
		match self {
			Self::Html => Html.extract_injections(root),
			_ => HashMap::new(),
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
		Cpp => &["cc", "hpp", "cpp", "c++", "hh", "cxx", "cu", "cuh", "ino"],
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
		ObjC => &["m"],
		Ocaml => &["ml"],
		Odin => &["odin"],
		Php => &["php"],
		Powershell => &["ps1", "psm1"],
		Proto => &["proto"],
		Python => &["py", "py3", "pyi", "bzl"],
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

static LANG_ALIASES: phf::Map<&'static str, SupportLang> = phf_map! {
"astro"          => SupportLang::Astro,
"bash"           => SupportLang::Bash,
"sh"             => SupportLang::Bash,
"zsh"            => SupportLang::Bash,
"ksh"            => SupportLang::Bash,
"bats"           => SupportLang::Bash,
"c"              => SupportLang::C,
"h"              => SupportLang::C,
"cmake"          => SupportLang::Cmake,
"cpp"            => SupportLang::Cpp,
"c++"            => SupportLang::Cpp,
"cc"             => SupportLang::Cpp,
"cxx"            => SupportLang::Cpp,
"hh"             => SupportLang::Cpp,
"hpp"            => SupportLang::Cpp,
"cu"             => SupportLang::Cpp,
"cuh"            => SupportLang::Cpp,
"ino"            => SupportLang::Cpp,
"csharp"         => SupportLang::CSharp,
"c#"             => SupportLang::CSharp,
"cs"             => SupportLang::CSharp,
"dart"           => SupportLang::Dart,
"css"            => SupportLang::Css,
"clj"            => SupportLang::Clojure,
"cljc"           => SupportLang::Clojure,
"cljs"           => SupportLang::Clojure,
"clojure"        => SupportLang::Clojure,
"clojurescript"  => SupportLang::Clojure,
"edn"            => SupportLang::Clojure,
"diff"           => SupportLang::Diff,
"patch"          => SupportLang::Diff,
"docker"         => SupportLang::Dockerfile,
"dockerfile"     => SupportLang::Dockerfile,
"containerfile"  => SupportLang::Dockerfile,
"emacs-lisp"     => SupportLang::EmacsLisp,
"emacslisp"      => SupportLang::EmacsLisp,
"elisp"          => SupportLang::EmacsLisp,
"el"             => SupportLang::EmacsLisp,
"elixir"         => SupportLang::Elixir,
"ex"             => SupportLang::Elixir,
"exs"            => SupportLang::Elixir,
"erlang"         => SupportLang::Erlang,
"erl"            => SupportLang::Erlang,
"hrl"            => SupportLang::Erlang,
"fortran"        => SupportLang::Fortran,
"f90"            => SupportLang::Fortran,
"f95"            => SupportLang::Fortran,
"f03"            => SupportLang::Fortran,
"f08"            => SupportLang::Fortran,
"go"             => SupportLang::Go,
"golang"         => SupportLang::Go,
"graphql"        => SupportLang::Graphql,
"gql"            => SupportLang::Graphql,
"haskell"        => SupportLang::Haskell,
"hs"             => SupportLang::Haskell,
"hcl"            => SupportLang::Hcl,
"tf"             => SupportLang::Hcl,
"tfvars"         => SupportLang::Hcl,
"terraform"      => SupportLang::Hcl,
"html"           => SupportLang::Html,
"htm"            => SupportLang::Html,
"xhtml"          => SupportLang::Html,
"ini"            => SupportLang::Ini,
"cfg"            => SupportLang::Ini,
"conf"           => SupportLang::Ini,
"config"         => SupportLang::Ini,
"properties"     => SupportLang::Ini,
"java"           => SupportLang::Java,
"javascript"     => SupportLang::JavaScript,
"js"             => SupportLang::JavaScript,
"jsx"            => SupportLang::JavaScript,
"mjs"            => SupportLang::JavaScript,
"cjs"            => SupportLang::JavaScript,
"json"           => SupportLang::Json,
"just"           => SupportLang::Just,
"justfile"       => SupportLang::Just,
"julia"          => SupportLang::Julia,
"jl"             => SupportLang::Julia,
"kotlin"         => SupportLang::Kotlin,
"kt"             => SupportLang::Kotlin,
"kts"            => SupportLang::Kotlin,
"ktm"            => SupportLang::Kotlin,
"lua"            => SupportLang::Lua,
"make"           => SupportLang::Make,
"makefile"       => SupportLang::Make,
"gnumake"        => SupportLang::Make,
"mk"             => SupportLang::Make,
"mak"            => SupportLang::Make,
"markdown"       => SupportLang::Markdown,
"md"             => SupportLang::Markdown,
"mdx"            => SupportLang::Markdown,
"nix"            => SupportLang::Nix,
"objc"           => SupportLang::ObjC,
"obj-c"          => SupportLang::ObjC,
"objective-c"    => SupportLang::ObjC,
"m"              => SupportLang::ObjC,
"mm"             => SupportLang::ObjC,
"ocaml"          => SupportLang::Ocaml,
"ml"             => SupportLang::Ocaml,
"odin"           => SupportLang::Odin,
"php"            => SupportLang::Php,
"powershell"     => SupportLang::Powershell,
"ps1"            => SupportLang::Powershell,
"psm1"           => SupportLang::Powershell,
"protobuf"       => SupportLang::Proto,
"proto"          => SupportLang::Proto,
"python"         => SupportLang::Python,
"py"             => SupportLang::Python,
"py3"            => SupportLang::Python,
"pyi"            => SupportLang::Python,
"r"              => SupportLang::R,
"regex"          => SupportLang::Regex,
"re"             => SupportLang::Regex,
"ruby"           => SupportLang::Ruby,
"rb"             => SupportLang::Ruby,
"rbw"            => SupportLang::Ruby,
"gemspec"        => SupportLang::Ruby,
"rust"           => SupportLang::Rust,
"rs"             => SupportLang::Rust,
"scala"          => SupportLang::Scala,
"sc"             => SupportLang::Scala,
"sbt"            => SupportLang::Scala,
"solidity"       => SupportLang::Solidity,
"sol"            => SupportLang::Solidity,
"sql"            => SupportLang::Sql,
"starlark"       => SupportLang::Starlark,
"star"           => SupportLang::Starlark,
"bzl"            => SupportLang::Starlark,
"bazel"          => SupportLang::Starlark,
"skylark"        => SupportLang::Starlark,
"svelte"         => SupportLang::Svelte,
"swift"          => SupportLang::Swift,
"toml"           => SupportLang::Toml,
"tla"            => SupportLang::Tlaplus,
"tla+"           => SupportLang::Tlaplus,
"tlaplus"        => SupportLang::Tlaplus,
"pluscal"        => SupportLang::Tlaplus,
"pcal"           => SupportLang::Tlaplus,
"tsx"            => SupportLang::Tsx,
"typescript"     => SupportLang::TypeScript,
"ts"             => SupportLang::TypeScript,
"mts"            => SupportLang::TypeScript,
"cts"            => SupportLang::TypeScript,
"verilog"        => SupportLang::Verilog,
"systemverilog"  => SupportLang::Verilog,
"sv"             => SupportLang::Verilog,
"svh"            => SupportLang::Verilog,
"vh"             => SupportLang::Verilog,
"v"              => SupportLang::Verilog,
"vue"            => SupportLang::Vue,
"xml"            => SupportLang::Xml,
"xsl"            => SupportLang::Xml,
"xslt"           => SupportLang::Xml,
"svg"            => SupportLang::Xml,
"plist"          => SupportLang::Xml,
"yaml"           => SupportLang::Yaml,
"yml"            => SupportLang::Yaml,
"zig"            => SupportLang::Zig,
};

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn infers_cuda_sources_and_headers_as_cpp() {
		assert_eq!(SupportLang::from_path(Path::new("kernel.cu")), Some(SupportLang::Cpp));
		assert_eq!(SupportLang::from_path(Path::new("kernel.cuh")), Some(SupportLang::Cpp));
	}

	#[test]
	fn resolves_cuda_language_aliases_as_cpp() {
		assert_eq!(SupportLang::from_alias("cu"), Some(SupportLang::Cpp));
		assert_eq!(SupportLang::from_alias("cuh"), Some(SupportLang::Cpp));
	}
}
