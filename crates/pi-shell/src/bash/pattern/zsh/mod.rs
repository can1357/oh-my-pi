//! zsh pattern matching: a port of zsh 5.9's pattern
//! compiler and matcher (`Src/pattern.c`) and of the string-matching half
//! of `Src/glob.c` behind `${x#p}`, `${x/p/r}`, `${x:#p}` and their flags.
//!
//! Patterns and subjects are zsh strings: metafied bytes in which unquoted
//! pattern characters are tokens ([`crate::bash::syntax::zsh::tok`]). The zsh
//! lexer produces them for literal patterns; [`tokenize`] and
//! [`shtokenize`] turn expansion results into patterns (`${~x}`,
//! `GLOB_SUBST`), [`remnulargs`] drops the quote tokens.
//!
//! - [`Pattern::compile`] is zsh's `patcompile`: `*`, `?`, `[...]` with POSIX
//!   and zsh classes (`[[:alpha:]]`, `[[:IDENT:]]`, `[[:IFS:]]`, `[[:WORD:]]`
//!   …), `<n-m>` numeric ranges, `(a|b)` (unless `SH_GLOB`), `#`, `##`, `~`,
//!   `^` under `EXTENDED_GLOB`, `@( ) *( ) +( ) ?( ) !( )` under `KSH_GLOB`,
//!   the globbing flags `(#i) (#I) (#l) (#b) (#B) (#m) (#M) (#s) (#e) (#u) (#U)
//!   (#aN) (#cN,M)`, and `(#q…)` glob qualifiers, which the pattern skips. A
//!   [`Pattern`] is immutable, `Clone`, `Send` and `Sync`, and depends only on
//!   (text, [`PatFlags`], [`Opts`]), so it can be cached by that key.
//! - [`Pattern::matches`] / [`Pattern::try_match`] are `pattry` / `pattryrefs`:
//!   whole-string matching, the match length under [`PatFlags::NOANCH`], and
//!   the `(#b)`/`(#m)` [`Captures`] as character and byte offsets.
//!   [`Pattern::try_file`] matches one file-name segment for the engine's
//!   globbing, with the path so far for `~` exclusions and the shared
//!   approximation state ([`Approx`]).
//! - [`getmatch`], [`getmatcharr`] and [`getmatchlist`] are `glob.c`'s
//!   `getmatch` family with every [`SubFlags`] combination.
//! - [`haswilds`] decides whether a word is subject to filename generation.
//!
//! The module never reads shell state: the options pattern code consults
//! arrive in [`Opts`], `$IFS`/`$WORDCHARS` in a [`CharEnv`]. A malformed
//! pattern is a [`BadPattern`], which the caller reports as zsh's
//! `bad pattern: TEXT`. Matching allocates only for closures and
//! exclusions (zsh's per-node scratch strings) and for subjects that
//! contain metafied bytes.
//!
//! # Example
//!
//! ```
//! use pi_shell::bash::{
//! 	pattern::zsh::{Captures, CharEnv, Opts, PatFlags, Pattern, tokenize},
//! 	syntax::zsh::tok::metafy,
//! };
//!
//! let opts = Opts { extended_glob: true, ..Opts::default() };
//! let mut text = metafy(b"(#b)a(?)c");
//! tokenize(&mut text);
//! let pat = Pattern::compile(&text, PatFlags::NONE, &opts).unwrap();
//! let mut caps = Captures::default();
//! assert!(
//! 	pat.try_match(b"abc", &CharEnv::DEFAULT, Some(&mut caps))
//! 		.is_some()
//! );
//! let b = caps.groups.unwrap().get(0).unwrap();
//! assert_eq!((b.begin, b.end), (1, 2)); // $mbegin[1] = 2, $mend[1] = 2
//! ```
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

mod class;
mod compile;
mod exec;
mod getmatch;
mod mbchar;
mod prog;
mod token;

#[cfg(test)]
mod tests;

use core::{fmt, ops};

/// For the completion matchers (`compmatch.c`'s `mb_patmatchrange` on
/// `parse_class` strings).
pub(crate) use self::{
	class::{mb_class, pp_name, range_type},
	mbchar::metacharinc,
};
pub use self::{
	compile::{FileGlobState, Pattern},
	exec::{Approx, Captures, Groups, Span},
	getmatch::{GetMatch, Replace, SubFlags, getmatch, getmatcharr, getmatchlist},
	token::{haswilds, remnulargs, shtokenize, tokenize},
};

/// The options pattern code reads (zsh `isset()` in `pattern.c` and the
/// matching half of `glob.c`), plus the `disable -p` state. Default: zsh's
/// defaults in zsh emulation, with `multibyte` off.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Opts {
	/// `EXTENDED_GLOB`: `~`, `^` and `#` are pattern operators.
	pub extended_glob: bool,
	/// `KSH_GLOB`: `@( ) *( ) +( ) ?( ) !( )`.
	pub ksh_glob:      bool,
	/// `SH_GLOB`: `(` and `<` are not pattern characters (grouping and
	/// numeric ranges off; `|` stays, for `case`).
	pub sh_glob:       bool,
	/// `CASE_GLOB`: file patterns are case-sensitive (default on).
	pub case_glob:     bool,
	/// `CASE_PATHS`: directory components are case-sensitive even without
	/// `CASE_GLOB`.
	pub case_paths:    bool,
	/// The `MULTIBYTE` option in a UTF-8 locale: characters are UTF-8
	/// sequences; off, every byte is a character.
	pub multibyte:     bool,
	/// Pattern characters turned off with `disable -p` (zsh
	/// `zpc_disables`).
	pub disables:      Disables,
}

impl Default for Opts {
	fn default() -> Self {
		Self {
			extended_glob: false,
			ksh_glob:      false,
			sh_glob:       false,
			case_glob:     true,
			case_paths:    false,
			multibyte:     false,
			disables:      Disables::NONE,
		}
	}
}

/// Index of `/` in zsh's special pattern characters (`ZPC_SLASH`).
const ZPC_SLASH: usize = 0;
/// Index of `|` (`ZPC_BAR`).
const ZPC_BAR: usize = 2;
/// Index of `~` (`ZPC_TILDE`).
const ZPC_TILDE: usize = 4;
/// Number of characters that end a pattern segment (`ZPC_SEG_COUNT`).
const ZPC_SEG_COUNT: usize = 5;
/// Index of `(` (`ZPC_INPAR`).
const ZPC_INPAR: usize = 5;
/// Index of `?` (`ZPC_QUEST`).
const ZPC_QUEST: usize = 6;
/// Index of `*` (`ZPC_STAR`).
const ZPC_STAR: usize = 7;
/// Index of `[` (`ZPC_INBRACK`).
const ZPC_INBRACK: usize = 8;
/// Index of `<` (`ZPC_INANG`).
const ZPC_INANG: usize = 9;
/// Index of `^` (`ZPC_HAT`).
const ZPC_HAT: usize = 10;
/// Index of `#` (`ZPC_HASH`).
const ZPC_HASH: usize = 11;
/// Number of characters that end a pure string (`ZPC_NO_KSH_GLOB`).
const ZPC_NO_KSH_GLOB: usize = 13;
/// Index of `?` before `(` under `KSH_GLOB` (`ZPC_KSH_QUEST`).
const ZPC_KSH_QUEST: usize = 13;
/// Index of `*(` (`ZPC_KSH_STAR`).
const ZPC_KSH_STAR: usize = 14;
/// Index of `+(` (`ZPC_KSH_PLUS`).
const ZPC_KSH_PLUS: usize = 15;
/// Index of `!(`, tokenized (`ZPC_KSH_BANG`).
const ZPC_KSH_BANG: usize = 16;
/// Index of `!(`, untokenized (`ZPC_KSH_BANG2`).
const ZPC_KSH_BANG2: usize = 17;
/// Index of `@(` (`ZPC_KSH_AT`).
const ZPC_KSH_AT: usize = 18;
/// Number of special pattern characters (`ZPC_COUNT`).
const ZPC_COUNT: usize = 19;

/// The `disable -p` names, space separated and indexed like zsh's special
/// characters (zsh `zpc_strings`; `.` cannot be disabled). One string, not
/// a table of slices: no dynamic relocations at process start.
const ZPC_STRINGS: &str = ". . | . ~ ( ? * [ < ^ # . ?( *( +( !( \\!( @(";

/// The [`ZPC_STRINGS`] entries, `None` for one that cannot be disabled.
fn zpc_strings() -> impl Iterator<Item = Option<&'static str>> {
	ZPC_STRINGS.split(' ').map(|s| (s != ".").then_some(s))
}

/// Pattern characters turned off by `disable -p` (zsh `zpc_disables`, one
/// bit per special character). The `disable`/`enable` builtins and
/// `LOCAL_PATTERNS` own the state; patterns read it through [`Opts`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Disables(u32);

impl Disables {
	/// Nothing disabled.
	pub const NONE: Self = Self(0);

	/// The character `disable -p NAME` turns off (zsh `pat_enables`), or
	/// `None` for zsh's `invalid pattern: NAME`.
	pub fn from_name(name: &[u8]) -> Option<Self> {
		zpc_strings()
			.position(|s| s.is_some_and(|s| s.as_bytes() == name))
			.map(|i| Self(1 << i))
	}

	/// The names `disable -p` (`disabled`) or `enable -p` (not `disabled`)
	/// lists, in zsh's order (zsh `pat_enables` without arguments).
	pub fn names(self, disabled: bool) -> impl Iterator<Item = &'static str> {
		zpc_strings()
			.enumerate()
			.filter_map(move |(i, s)| s.filter(|_| self.has(i) == disabled))
	}

	/// Whether the special character with zsh index `i` is disabled.
	const fn has(self, i: usize) -> bool {
		self.0 & (1 << i) != 0
	}
}

impl ops::BitOr for Disables {
	type Output = Self;

	fn bitor(self, rhs: Self) -> Self {
		Self(self.0 | rhs.0)
	}
}

impl ops::Sub for Disables {
	type Output = Self;

	fn sub(self, rhs: Self) -> Self {
		Self(self.0 & !rhs.0)
	}
}

/// `PAT_*` flags of a compiled pattern (zsh `zsh.h`): passed to
/// [`Pattern::compile`] by callers, some set by the compiler.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct PatFlags(u16);

impl PatFlags {
	/// Match anything (a cheap `*` segment, see
	/// [`Pattern::compile_segment`]).
	pub const ANY: Self = Self(0x0004);
	/// The pattern is a file-name segment: `/` ends it, flags carry over
	/// between segments ([`Pattern::compile_segment`]).
	pub const FILE: Self = Self(0x0001);
	/// A top-level file pattern: a top-level `~` excludes against the
	/// whole path ([`Pattern::try_file`]).
	pub const FILET: Self = Self(0x0002);
	/// Set by the compiler: a top-level `~` of a [`Self::FILET`] pattern
	/// excludes against the whole path.
	pub const HAS_EXCLUDP: Self = Self(0x0800);
	/// Lower case in the pattern matches upper case, as `(#l)`.
	pub const LCMATCHUC: Self = Self(0x1000);
	/// Not anchored at the end: a prefix match, whose length the match
	/// reports.
	pub const NOANCH: Self = Self(0x0008);
	/// Do not match a leading `.` (no `GLOB_DOTS`).
	pub const NOGLD: Self = Self(0x0010);
	/// No flags: a whole-string pattern (`case`, `[[ = ]]`).
	pub const NONE: Self = Self(0);
	/// The end of the subject is not the real end: `(#e)` fails there.
	pub const NOTEND: Self = Self(0x0400);
	/// The start of the subject is not the real start: `(#s)` fails there.
	pub const NOTSTART: Self = Self(0x0200);
	/// Set by the compiler: the pattern is a plain string
	/// ([`Pattern::pure`]).
	pub const PURES: Self = Self(0x0020);
	/// The caller scans for a match itself: skip the must-match test.
	pub const SCAN: Self = Self(0x0080);
	/// zsh's static compile buffer; accepted for zsh's call sites, no
	/// effect on a reference-counted [`Pattern`].
	pub const STATIC: Self = Self(0x0040);

	/// Whether every flag of `other` is set.
	pub const fn contains(self, other: Self) -> bool {
		self.0 & other.0 == other.0
	}

	/// These flags without those of `other`.
	pub const fn without(self, other: Self) -> Self {
		Self(self.0 & !other.0)
	}
}

impl ops::BitOr for PatFlags {
	type Output = Self;

	fn bitor(self, rhs: Self) -> Self {
		Self(self.0 | rhs.0)
	}
}

impl ops::BitOrAssign for PatFlags {
	fn bitor_assign(&mut self, rhs: Self) {
		self.0 |= rhs.0;
	}
}

/// The shell values zsh's own character classes read at match time:
/// `[[:IFS:]]`, `[[:IFSSPACE:]]`, `[[:WORD:]]`, `[[:IDENT:]]` (zsh
/// `typtab`, `ifs_wide`, `wordchars_wide`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CharEnv<'a> {
	/// `$IFS`, unmetafied.
	pub ifs:               &'a [u8],
	/// `$WORDCHARS`, unmetafied.
	pub wordchars:         &'a [u8],
	/// `POSIX_IDENTIFIERS`: non-ASCII letters are not identifier
	/// characters.
	pub posix_identifiers: bool,
}

impl CharEnv<'static> {
	/// zsh's defaults: `IFS=$' \t\n\0'`, `WORDCHARS='*?_-.[]~=/&;!#$%^(){}<>'`.
	pub const DEFAULT: Self = Self {
		ifs:               b" \t\n\0",
		wordchars:         b"*?_-.[]~=/&;!#$%^(){}<>",
		posix_identifiers: false,
	};
}

impl Default for CharEnv<'static> {
	fn default() -> Self {
		Self::DEFAULT
	}
}

/// A malformed pattern (zsh's `patcompile` returning NULL); the caller
/// prints `bad pattern: TEXT` with the pattern as written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BadPattern;

impl fmt::Display for BadPattern {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("bad pattern")
	}
}

impl core::error::Error for BadPattern {}
