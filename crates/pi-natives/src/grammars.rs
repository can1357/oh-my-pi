//! On-demand tree-sitter grammars: where the addon reads them and what the
//! host downloads (see `pi_ast::language::grammar`).

use std::path::{Path, PathBuf};

use napi_derive::napi;
use pi_ast::{
	SupportLang,
	language::{grammar, wasm_grammars},
};

/// Language to look up: an alias, or a path to infer it from.
#[napi(object)]
pub struct WasmGrammarQuery {
	/// Language alias (e.g. `kotlin`, `sv`); wins over `path`.
	pub lang: Option<String>,
	/// File whose extension selects the language.
	pub path: Option<String>,
}

/// A grammar the host downloads on first use.
#[napi(object)]
pub struct WasmGrammarInfo {
	/// Canonical language name, e.g. `verilog`, `csharp`.
	pub language:  String,
	/// stencil-hq/wasm-grammars release tag hosting the grammar, e.g. `v1`.
	pub release:   String,
	/// File name inside the grammar directory; the release asset is
	/// `<file>.zst`.
	pub file:      String,
	/// Lowercase hex SHA-256 of the decompressed `.wasm`.
	pub sha256:    String,
	/// Byte size of the decompressed `.wasm`.
	pub size:      u32,
	/// Whether the grammar is downloaded (or already loaded).
	pub installed: bool,
}

/// Points the addon at the directory holding downloaded wasm grammars
/// (`<dir>/<file>`). The loader (`native/loader-state.js`) calls this once
/// with `<natives dir>/grammars`; grammars then load lazily from it.
#[napi(js_name = "__ompSetGrammarDir")]
pub fn set_grammar_dir(dir: String) {
	grammar::set_grammar_dir(PathBuf::from(dir));
}

/// Wasm grammar backing `lang` (alias) or the language of `path`; `null` for
/// built-in or unknown languages.
#[napi]
pub fn wasm_grammar_for(query: WasmGrammarQuery) -> Option<WasmGrammarInfo> {
	let lang = match query
		.lang
		.as_deref()
		.map(str::trim)
		.filter(|lang| !lang.is_empty())
	{
		Some(lang) => SupportLang::from_alias(lang)?,
		None => SupportLang::from_path(Path::new(query.path?.trim()))?,
	};
	let grammar = lang.wasm_grammar()?;
	Some(WasmGrammarInfo {
		language:  grammar.language.to_owned(),
		release:   wasm_grammars::RELEASE.to_owned(),
		file:      grammar.file.to_owned(),
		sha256:    grammar.sha256.to_owned(),
		size:      u32::try_from(grammar.size).unwrap_or(u32::MAX),
		installed: grammar.is_installed(),
	})
}
