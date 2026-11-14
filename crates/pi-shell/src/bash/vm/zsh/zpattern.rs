//! zsh patterns as the shell uses them: the options pattern code reads
//! (zsh `isset()` in `pattern.c` and `glob.c`), the character classes'
//! shell values, a compiled-pattern cache, and the capture variables a
//! match sets (`(#b)`: `match mbegin mend`; `(#m)`: `MATCH MBEGIN MEND`).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::sync::Arc;

use bstr::BString;
use hashbrown::HashMap;
use parking_lot::Mutex;

use super::params::{self, opt};
use crate::bash::{
	diag::Diag,
	pattern::zsh::{Captures, CharEnv, Disables, Opts, PatFlags, Pattern},
	store::{Key, MiscKey, Record},
	syntax::zsh::tok::{unmetafy, untokenize},
	vm::{
		expand::{Expander, Stop, X},
		state,
	},
	zshopt::ZshOpt,
};

/// A cached pattern's key: its text, flags and options.
type CacheKey = (Vec<u8>, PatFlags, Opts);

/// Compiled zsh patterns by text, flags and options. Compiling depends on
/// nothing else, so the shells of one engine share the results
/// ([`Engine`](crate::bash::Engine) holds it). Cleared when it grows past
/// [`CACHE_MAX`].
#[derive(Default)]
pub struct Cache {
	map: Mutex<HashMap<CacheKey, Arc<Pattern>>>,
}

impl Cache {
	/// zsh `patcompile` of `text` under `flags` and `o`, compiled on a miss;
	/// `None` when `text` is not a pattern.
	fn get(&self, text: &[u8], flags: PatFlags, o: &Opts) -> Option<Arc<Pattern>> {
		let key = (text.to_vec(), flags, *o);
		if let Some(p) = self.map.lock().get(&key) {
			return Some(Arc::clone(p));
		}
		let p = Arc::new(Pattern::compile(text, flags, o).ok()?);
		let mut map = self.map.lock();
		if map.len() >= CACHE_MAX {
			map.clear();
		}
		map.insert(key, Arc::clone(&p));
		Some(p)
	}
}

/// Entries the cache holds before it starts over.
const CACHE_MAX: usize = 2048;

/// The pattern options for the vproc the expander runs in.
///
/// # Errors
/// [`Stop::Store`] when an option cannot be read.
pub fn opts(ex: &mut Expander<'_, '_>) -> X<Opts> {
	let mut disables = Disables::NONE;
	if let Some(Record::Words(w)) =
		state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshPatDisables))?
	{
		for name in w {
			if let Some(d) = Disables::from_name(name) {
				disables = disables | d;
			}
		}
	}
	let multibyte =
		opt(ex, ZshOpt::Multibyte)? && crate::bash::vm::locale::is_utf8(ex.k, ex.cx.store, ex.vp);
	Ok(Opts {
		extended_glob: opt(ex, ZshOpt::Extendedglob)?,
		ksh_glob: opt(ex, ZshOpt::Kshglob)?,
		sh_glob: opt(ex, ZshOpt::Shglob)?,
		case_glob: opt(ex, ZshOpt::Caseglob)?,
		case_paths: opt(ex, ZshOpt::Casepaths)?,
		multibyte,
		disables,
	})
}

/// The shell values zsh's own character classes read, owned.
#[derive(Clone, Debug, Default)]
pub struct CharEnvBuf {
	/// `$IFS`, unmetafied (zsh's default when unset).
	pub ifs:               Vec<u8>,
	/// `$WORDCHARS`, unmetafied (zsh's default when unset).
	pub wordchars:         Vec<u8>,
	/// `POSIX_IDENTIFIERS`.
	pub posix_identifiers: bool,
}

impl CharEnvBuf {
	/// The borrowed form the matcher takes.
	pub fn env(&self) -> CharEnv<'_> {
		CharEnv {
			ifs:               &self.ifs,
			wordchars:         &self.wordchars,
			posix_identifiers: self.posix_identifiers,
		}
	}
}

/// The character-class environment for the vproc the expander runs in.
///
/// # Errors
/// [`Stop::Store`] when a variable cannot be read.
pub fn char_env(ex: &mut Expander<'_, '_>) -> X<CharEnvBuf> {
	let ifs = state::lookup(&ex.k.root, ex.cx.store, ex.vp, b"IFS")?.map_or_else(
		|| CharEnv::DEFAULT.ifs.to_vec(),
		|v| v.as_scalar().unwrap_or_default().to_vec(),
	);
	let wordchars = state::lookup(&ex.k.root, ex.cx.store, ex.vp, b"WORDCHARS")?.map_or_else(
		|| CharEnv::DEFAULT.wordchars.to_vec(),
		|v| v.as_scalar().unwrap_or_default().to_vec(),
	);
	Ok(CharEnvBuf { ifs, wordchars, posix_identifiers: opt(ex, ZshOpt::Posixidentifiers)? })
}

/// zsh `patcompile` of `text` (metafied, tokenized), cached. A malformed
/// pattern is `bad pattern: TEXT` (the text as written).
///
/// # Errors
/// [`Diag::BadPattern`], or a store failure reading the options.
pub fn compile(ex: &mut Expander<'_, '_>, text: &[u8], flags: PatFlags) -> X<Arc<Pattern>> {
	try_compile(ex, text, flags)?.ok_or_else(|| bad_pattern(text))
}

/// zsh `patcompile` of `text` (metafied, tokenized), cached; `None` for a
/// malformed pattern, which callers such as subscript flags take as
/// matching nothing.
///
/// # Errors
/// A store failure reading the options.
pub fn try_compile(
	ex: &mut Expander<'_, '_>,
	text: &[u8],
	flags: PatFlags,
) -> X<Option<Arc<Pattern>>> {
	let o = opts(ex)?;
	Ok(ex.k.engine.zsh_patterns().get(text, flags, &o))
}

/// zsh `patcompile` of `text` (metafied, tokenized) under the options `o`
/// a pattern was compiled with earlier (zsh keeps compiled patterns:
/// `zstyle`'s), cached; `None` for a malformed pattern.
pub fn compile_with(
	ex: &Expander<'_, '_>,
	text: &[u8],
	flags: PatFlags,
	o: &Opts,
) -> Option<Arc<Pattern>> {
	ex.k.engine.zsh_patterns().get(text, flags, o)
}

/// `bad pattern: TEXT` for the tokenized pattern `text`.
pub fn bad_pattern(text: &[u8]) -> Stop {
	let mut t = text.to_vec();
	untokenize(&mut t);
	Stop::Fail(Diag::BadPattern { pattern: BString::from(unmetafy(&t)) })
}

/// Whether `pat` matches `subject` (raw bytes) entirely (zsh `pattry`);
/// the capture variables are set from a successful match.
///
/// # Errors
/// A store failure setting the capture variables.
pub fn matches(ex: &mut Expander<'_, '_>, pat: &Pattern, subject: &[u8]) -> X<bool> {
	let s = crate::bash::syntax::zsh::tok::metafy(subject);
	let env = char_env(ex)?;
	let mut caps = Captures::default();
	let want = pat.npar() > 0 || pat.sets_match();
	let ok = if want {
		pat.try_match(&s, &env.env(), Some(&mut caps)).is_some()
	} else {
		pat.matches(&s, &env.env())
	};
	if ok && want {
		set_match_vars(ex, &s, &caps)?;
	}
	Ok(ok)
}

/// Set `MATCH MBEGIN MEND` (from `caps.whole`) and `match mbegin mend`
/// (from `caps.groups`) after a successful match against `subject`
/// (metafied), as zsh's `patmatch` does at the end of a match; indexes are
/// 1-based unless `ksharrays`.
///
/// # Errors
/// A store failure.
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's set_match_vars")]
pub fn set_match_vars(ex: &mut Expander<'_, '_>, subject: &[u8], caps: &Captures) -> X<()> {
	let ksh = i64::from(opt(ex, ZshOpt::Ksharrays)?);
	let n = |v: usize| i64::try_from(v).unwrap_or(0);
	if let Some(w) = caps.whole {
		let text = subject
			.get(w.byte_begin..w.byte_end.min(subject.len()))
			.unwrap_or_default();
		params::assignsparam(ex, b"MATCH", &unmetafy(text), 0)?;
		params::assignsparam(ex, b"MBEGIN", (n(w.begin) + 1 - ksh).to_string().as_bytes(), 0)?;
		params::assignsparam(ex, b"MEND", (n(w.end) - ksh).to_string().as_bytes(), 0)?;
	}
	if let Some(g) = caps.groups {
		let mut m = Vec::with_capacity(g.len());
		let mut b = Vec::with_capacity(g.len());
		let mut e = Vec::with_capacity(g.len());
		for span in g.iter() {
			if let Some(s) = span {
				let text = subject
					.get(s.byte_begin..s.byte_end.min(subject.len()))
					.unwrap_or_default();
				m.push(BString::from(unmetafy(text)));
				b.push(BString::from((n(s.begin) + 1 - ksh).to_string()));
				e.push(BString::from((n(s.end) - ksh).to_string()));
			} else {
				m.push(BString::default());
				b.push(BString::from("-1"));
				e.push(BString::from("-1"));
			}
		}
		params::assignaparam(ex, b"match", m, 0)?;
		params::assignaparam(ex, b"mbegin", b, 0)?;
		params::assignaparam(ex, b"mend", e, 0)?;
	}
	Ok(())
}
