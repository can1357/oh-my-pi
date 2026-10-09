//! Where each language's tree-sitter grammar comes from.
//!
//! Common languages link their grammar into the addon (`super::parsers`). The
//! rest are compiled to `.wasm` by
//! [stencil-hq/wasm-grammars](https://github.com/stencil-hq/wasm-grammars) and
//! published as `<file>.zst` assets of its
//! [`RELEASE`](super::wasm_grammars::RELEASE), which `bun run gen:grammars`
//! pins in [`super::wasm_grammars`]. The host
//! downloads a module into the directory set with [`set_grammar_dir`] the first
//! time it needs the language; [`WasmGrammar::load`] then reads it and keeps
//! the language for the life of the process.
//!
//! Only lexing runs in wasm: tree-sitter copies the parse tables into native
//! memory, so the resulting trees are ordinary native trees. A parser needs a
//! [`WasmStore`] to run a wasm grammar; [`parse`] keeps one per thread, and
//! every parse in this crate goes through it.
//!
//! `LanguageExt::get_ts_language` and `LanguageExt::ast_grep` panic for a wasm
//! grammar that is not installed, like ast-grep's own parse failures. Entry
//! points check [`GrammarSource::load`] first and treat
//! [`GrammarError::NotInstalled`] as "no tree" or report it.

use std::{
	cell::RefCell,
	error::Error,
	fmt,
	path::PathBuf,
	sync::{LazyLock, Mutex, OnceLock, PoisonError, RwLock},
};

use anyhow::{Context, Result};
use tree_sitter::{Language, Parser, Tree, WasmStore, wasmtime::Engine};

/// Where a language's grammar comes from.
#[derive(Clone, Copy, Debug)]
pub enum GrammarSource {
	/// Linked into the addon.
	Native(fn() -> Language),
	/// Downloaded on demand (see the module docs).
	Wasm(&'static WasmGrammar),
}

impl GrammarSource {
	/// The grammar's language.
	///
	/// # Errors
	/// Only for [`Self::Wasm`]; see [`WasmGrammar::load`].
	pub fn load(self) -> Result<Language, GrammarError> {
		match self {
			Self::Native(language) => Ok(language()),
			Self::Wasm(grammar) => grammar.load(),
		}
	}
}

/// Languages whose grammar comes from a [`GrammarSource`].
pub trait LanguageGrammar {
	fn grammar(&self) -> GrammarSource;
}

/// A grammar published as a WebAssembly module (see the module docs).
#[derive(Debug)]
pub struct WasmGrammar {
	/// `SupportLang::canonical_name` of the language.
	pub language: &'static str,
	/// Name the module exports its language under (`tree_sitter_<symbol>`).
	pub symbol:   &'static str,
	/// File name in the grammar directory; the release asset is `<file>.zst`.
	pub file:     &'static str,
	/// Lowercase hex SHA-256 of the module.
	pub sha256:   &'static str,
	/// Byte size of the module.
	pub size:     u64,
	loaded:       OnceLock<Language>,
}

/// Why a wasm grammar is not available.
#[derive(Debug)]
pub enum GrammarError {
	/// No grammar directory is set, or the module is not in it yet.
	NotInstalled { language: &'static str },
	/// The module could not be read or is not a tree-sitter grammar.
	Invalid { language: &'static str, reason: String },
}

impl fmt::Display for GrammarError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::NotInstalled { language } => write!(f, "the {language} grammar is not installed"),
			Self::Invalid { language, reason } => {
				write!(f, "the {language} grammar is invalid: {reason}")
			},
		}
	}
}

impl Error for GrammarError {}

static ENGINE: LazyLock<Engine> = LazyLock::new(Engine::default);
static GRAMMAR_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);
/// Serializes module loads: compiling one takes tens of milliseconds, which
/// every thread needing the grammar would otherwise repeat.
static LOAD_LOCK: Mutex<()> = Mutex::new(());

thread_local! {
	/// Parser holding a wasm store. Creating a store instantiates
	/// tree-sitter's wasm C library, so each thread keeps its first one.
	static WASM_PARSER: RefCell<Option<Parser>> = const { RefCell::new(None) };
}

/// Sets the directory wasm grammars are read from (`<dir>/<file>`).
pub fn set_grammar_dir(dir: PathBuf) {
	*GRAMMAR_DIR.write().unwrap_or_else(PoisonError::into_inner) = Some(dir);
}

fn module_path(file: &str) -> Option<PathBuf> {
	let dir = GRAMMAR_DIR.read().unwrap_or_else(PoisonError::into_inner);
	Some(dir.as_ref()?.join(file)).filter(|path| path.is_file())
}

impl WasmGrammar {
	/// Describes a published module; the generated `wasm_grammars` table is
	/// built from these.
	pub const fn new(
		language: &'static str,
		symbol: &'static str,
		file: &'static str,
		sha256: &'static str,
		size: u64,
	) -> Self {
		Self { language, symbol, file, sha256, size, loaded: OnceLock::new() }
	}

	/// Whether [`Self::load`] can succeed without a download.
	pub fn is_installed(&self) -> bool {
		self.loaded.get().is_some() || module_path(self.file).is_some()
	}

	/// The grammar's language, loading the module on first use.
	///
	/// # Errors
	/// [`GrammarError::NotInstalled`] when no grammar directory is set or the
	/// module is not in it; [`GrammarError::Invalid`] when the module cannot be
	/// read or loaded.
	pub fn load(&self) -> Result<Language, GrammarError> {
		if let Some(language) = self.loaded.get() {
			return Ok(language.clone());
		}
		#[cfg(test)]
		if let Some(language) = test_stand_in(self.language) {
			return Ok(self.loaded.get_or_init(|| language).clone());
		}
		let _guard = LOAD_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
		if let Some(language) = self.loaded.get() {
			return Ok(language.clone());
		}
		let path =
			module_path(self.file).ok_or(GrammarError::NotInstalled { language: self.language })?;
		let invalid = |reason: String| GrammarError::Invalid { language: self.language, reason };
		let bytes = std::fs::read(&path)
			.map_err(|err| invalid(format!("reading {}: {err}", path.display())))?;
		let mut store = WasmStore::new(&ENGINE).map_err(|err| invalid(err.to_string()))?;
		let language = store
			.load_language(self.symbol, &bytes)
			.map_err(|err| invalid(err.to_string()))?;
		Ok(self.loaded.get_or_init(|| language).clone())
	}

	/// Uses `language` for this grammar instead of a downloaded module; tests
	/// register the natively compiled grammar crates this way. Returns `false`
	/// when the grammar was already loaded.
	pub fn register(&self, language: Language) -> bool {
		self.loaded.set(language).is_ok()
	}
}

/// Natively compiled grammar crates (dev-dependencies) standing in for the
/// wasm grammars this crate's tests parse, so they run without downloads.
#[cfg(test)]
fn test_stand_in(language: &str) -> Option<Language> {
	Some(match language {
		"emacs-lisp" => tree_sitter_elisp::LANGUAGE.into(),
		"fortran" => tree_sitter_fortran::LANGUAGE.into(),
		"ruby" => tree_sitter_ruby::LANGUAGE.into(),
		"swift" => tree_sitter_swift::LANGUAGE.into(),
		_ => return None,
	})
}

/// Parses `source` as `language`, on this thread's wasm-capable parser when
/// `language` is a wasm grammar.
///
/// # Errors
/// When the parser rejects `language` (incompatible ABI) or the thread's wasm
/// store cannot be created.
pub fn parse(language: &Language, source: &str) -> Result<Option<Tree>> {
	if !language.is_wasm() {
		let mut parser = Parser::new();
		parser.set_language(language)?;
		return Ok(parser.parse(source, None));
	}
	WASM_PARSER.with_borrow_mut(|slot| {
		let mut parser = if let Some(parser) = slot.take() {
			parser
		} else {
			let mut parser = Parser::new();
			parser.set_wasm_store(WasmStore::new(&ENGINE).context("creating a wasm store")?)?;
			parser
		};
		let tree = parser
			.set_language(language)
			.map(|()| parser.parse(source, None));
		*slot = Some(parser);
		Ok(tree?)
	})
}

#[cfg(test)]
mod tests {
	use ast_grep_core::{MatchStrictness, tree_sitter::LanguageExt};

	use super::*;
	use crate::{
		SupportLang,
		language::wasm_grammars::INI,
		ops,
		summary::{SummaryOptions, summarize_code},
	};

	/// `tree-sitter-ini` 1.4.0 as built by stencil-hq/wasm-grammars.
	const INI_WASM: &[u8] = include_bytes!("testdata/ini.wasm");
	const SOURCE: &str = "[core]\nname = pi\nmode = fast\n";

	fn summary_parsed() -> bool {
		summarize_code(SummaryOptions {
			code:               SOURCE.to_owned(),
			lang:               Some("ini".to_owned()),
			path:               None,
			min_body_lines:     None,
			min_comment_lines:  None,
			unfold_until_lines: None,
			unfold_limit_lines: None,
		})
		.expect("summary succeeds")
		.parsed
	}

	#[test]
	fn wasm_grammar_parses_once_its_module_is_installed() {
		let dir = std::env::temp_dir().join(format!("pi-ast-grammars-{}", std::process::id()));
		std::fs::create_dir_all(&dir).expect("create grammar dir");
		set_grammar_dir(dir.clone());

		assert!(!INI.is_installed());
		assert!(matches!(INI.load(), Err(GrammarError::NotInstalled { language: "ini" })));
		assert!(!summary_parsed(), "a missing grammar summarizes like an unsupported language");

		std::fs::write(dir.join(INI.file), INI_WASM).expect("install module");
		assert!(INI.is_installed());
		assert!(INI.load().expect("module loads").is_wasm());
		assert!(summary_parsed());

		// INI settings only parse inside a section, so the pattern brings one and
		// selects the setting.
		let pattern = ops::compile_pattern(
			"[any]\nmode = fast\n",
			Some("setting"),
			&MatchStrictness::Smart,
			SupportLang::Ini,
		)
		.expect("pattern compiles through the wasm grammar");
		let matches: Vec<String> = SupportLang::Ini
			.ast_grep(SOURCE)
			.root()
			.find_all(pattern)
			.map(|node| node.text().into_owned())
			.collect();
		assert_eq!(matches, ["mode = fast\n"]);

		std::fs::remove_dir_all(dir).ok();
	}
}
