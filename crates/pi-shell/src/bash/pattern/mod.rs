//! bash pattern matching for `case`, `[[ == ]]`, `${x#pat}`, `${x/pat/r}`
//! and pathname expansion.
//!
//! A [`Pattern`] is compiled once from pattern bytes in which every quoted
//! character arrives backslash-escaped (the engine's job, as bash's
//! `quote_string_for_globbing`), and then matched against byte strings by a
//! port of bash's own matcher (`lib/glob/sm_loop.c`), quirks included:
//! an unclosed `[` matches itself, an unclosed extglob group compares as
//! text, collating symbols and equivalence classes follow bash's tables.
//!
//! With [`PatOpts::utf8`] (a UTF-8 locale), a pattern and subject that
//! contain multibyte characters are matched character by character, as
//! bash's wide-character matcher does; text that is not valid UTF-8 falls
//! back to bytes, as bash does. Ranges compare code points (bash's
//! `globasciiranges` default for ASCII; locale collation order otherwise
//! is not modelled).
//!
//! Patterns made of literal text with at most a leading and a trailing `*`
//! (`foo`, `*.c`, `x*`, `*/*`) skip the matcher: whole-string, prefix,
//! suffix and search queries are a byte comparison or one substring scan.
//!
//! [`Regex`] is the POSIX extended regular expression engine behind
//! `[[ string =~ regex ]]`, matching as glibc's `regcomp`/`regexec` do.
//!
//! # Example
//!
//! ```
//! use pi_shell::bash::pattern::{PatOpts, Pattern};
//!
//! let p = Pattern::compile(b"*.r[sb]", PatOpts::default());
//! assert!(p.matches(b"lib.rs"));
//! assert!(!p.matches(b"lib.rt"));
//! let ext = Pattern::compile(b"@(foo|ba?)", PatOpts { extglob: true, ..PatOpts::default() });
//! assert!(ext.matches(b"bar"));
//! let path = Pattern::compile(b"*/", PatOpts::default());
//! assert_eq!(path.prefix(b"/usr/lib/x.so", true), Some(9));
//! ```

#![forbid(unsafe_code)]

mod class;
mod ere;
pub mod glob;
mod strmatch;
pub mod zsh;

use core::ops::Range;

pub use crate::bash::pattern::ere::{Regex, RegexError, RegexErrorKind};
use crate::bash::pattern::strmatch::{CASEFOLD, DOTDOT, EXTMATCH, PATHNAME, PERIOD, strmatch};

/// Options that change how a pattern compiles or matches (bash's `FNM_*`
/// flags plus the locale).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct PatOpts {
	/// `shopt -s extglob`: recognise `?( ) *( ) +( ) @( ) !( )`
	/// (`FNM_EXTMATCH`).
	pub extglob:  bool,
	/// `nocasematch` / `nocaseglob`: case-insensitive (`FNM_CASEFOLD`).
	pub nocase:   bool,
	/// The locale's character set is UTF-8: multibyte text matches by
	/// character.
	pub utf8:     bool,
	/// `FNM_PATHNAME`: wildcards and bracket expressions never match `/`.
	pub pathname: bool,
	/// `FNM_PERIOD`: a leading `.` (also after `/` with `pathname`) must be
	/// matched by a literal `.`.
	pub period:   bool,
	/// `FNM_DOTDOT`: wildcards never match a leading `.` or `..`.
	pub dotdot:   bool,
}

impl PatOpts {
	/// `case`, `[[ == ]]`, `${x#…}` and `${x/…}`: bash's `strmatch` with
	/// `FNMATCH_EXTFLAG | FNMATCH_IGNCASE`, no pathname rules.
	pub const fn shell(extglob: bool, nocase: bool, utf8: bool) -> Self {
		Self { extglob, nocase, utf8, pathname: false, period: false, dotdot: false }
	}

	/// These options for one pathname component in pathname expansion
	/// (bash's `glob_vector`): adds `FNM_PATHNAME` and `FNM_PERIOD`
	/// (`FNM_DOTDOT` under `dotglob`). Start from [`PatOpts::shell`] with
	/// `nocaseglob` as `nocase`.
	pub const fn in_pathname(self, dotglob: bool) -> Self {
		Self { pathname: true, period: !dotglob, dotdot: dotglob, ..self }
	}

	/// A `GLOBIGNORE` pattern against a whole expanded path:
	/// `FNM_PATHNAME`, `FNM_EXTMATCH` for `extglob`, `FNM_CASEFOLD` for
	/// `nocaseglob`.
	pub const fn globignore(extglob: bool, nocase: bool, utf8: bool) -> Self {
		Self { extglob, nocase, utf8, pathname: true, period: false, dotdot: false }
	}

	/// The `strmatch` loadable builtin: `FNM_PATHNAME | FNM_PERIOD |
	/// FNM_EXTMATCH`.
	pub const fn strmatch(utf8: bool) -> Self {
		Self { extglob: true, nocase: false, utf8, pathname: true, period: true, dotdot: false }
	}

	const fn flags(self) -> u32 {
		let mut f = 0;
		if self.extglob {
			f |= EXTMATCH;
		}
		if self.nocase {
			f |= CASEFOLD;
		}
		if self.pathname {
			f |= PATHNAME;
		}
		if self.period {
			f |= PERIOD;
		}
		if self.dotdot {
			f |= DOTDOT;
		}
		f
	}
}

/// How a pattern is matched: by the general matcher, or by a byte scan for
/// literal text with at most a leading and a trailing `*`.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Shape {
	/// Anything else.
	General,
	/// `text`.
	Literal(Box<[u8]>),
	/// `text*`.
	Prefix(Box<[u8]>),
	/// `*text`.
	Suffix(Box<[u8]>),
	/// `*text*`.
	Contains(Box<[u8]>),
	/// `*`.
	Any,
}

impl Shape {
	/// The shape of `src`; flags that change how `*` or literals match
	/// (case folding, leading dots, slashes) force [`Shape::General`].
	fn of(src: &[u8], opts: PatOpts) -> Self {
		if opts.nocase || opts.pathname || opts.period || opts.dotdot {
			return Self::General;
		}
		let stars = |from: usize| src[from..].iter().take_while(|&&c| c == b'*').count();
		let lead = stars(0);
		if opts.extglob && lead > 0 && src.get(lead) == Some(&b'(') {
			return Self::General;
		}
		let mut lit = Vec::with_capacity(src.len());
		let mut i = lead;
		while let Some(&c) = src.get(i) {
			match c {
				b'*' => break,
				b'?' | b'[' => return Self::General,
				b'+' | b'@' | b'!' if opts.extglob && src.get(i + 1) == Some(&b'(') => {
					return Self::General;
				},
				// After `*`, bash compares the next subject unit with the
				// NUL that follows a final `\`: `*\` matches nothing.
				b'\\' if lead > 0 && i == lead && i + 1 == src.len() => return Self::General,
				b'\\' => {
					// A trailing backslash matches itself at the very end.
					lit.push(src.get(i + 1).copied().unwrap_or(b'\\'));
					i += 2;
					continue;
				},
				_ => lit.push(c),
			}
			i += 1;
		}
		let i = i.min(src.len());
		if i + stars(i) != src.len() {
			return Self::General;
		}
		let lit = lit.into_boxed_slice();
		match (lead > 0, i < src.len()) {
			(true, _) if lit.is_empty() => Self::Any,
			(false, false) => Self::Literal(lit),
			(false, true) => Self::Prefix(lit),
			(true, false) => Self::Suffix(lit),
			(true, true) => Self::Contains(lit),
		}
	}
}

/// First occurrence of `needle` in `hay`.
fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
	match needle {
		[] => Some(0),
		[b] => hay.iter().position(|c| c == b),
		_ => hay.windows(needle.len()).position(|w| w == needle),
	}
}

/// Last occurrence of `needle` in `hay`.
fn rfind_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
	match needle {
		[] => Some(hay.len()),
		[b] => hay.iter().rposition(|c| c == b),
		_ => hay.windows(needle.len()).rposition(|w| w == needle),
	}
}

/// Whether `b` has a UTF-8 continuation byte (bash's `mbsmbchar` in a
/// UTF-8 locale).
fn has_multibyte(b: &[u8]) -> bool {
	b.iter().any(|&c| c & 0xc0 == 0x80)
}

/// A subject cut into matching units.
enum Units<'a> {
	/// Bytes.
	Bytes(&'a [u8]),
	/// Characters, with the pattern's characters and the byte offset of
	/// every character boundary (`offsets.len() == chars.len() + 1`).
	Wide { pat: &'a [u32], chars: Vec<u32>, offsets: Vec<usize> },
}

impl Units<'_> {
	/// Number of units.
	const fn len(&self) -> usize {
		match self {
			Self::Bytes(b) => b.len(),
			Self::Wide { chars, .. } => chars.len(),
		}
	}

	/// Byte offset of unit boundary `i`.
	fn offset(&self, i: usize) -> usize {
		match self {
			Self::Bytes(_) => i,
			Self::Wide { offsets, .. } => offsets[i],
		}
	}

	/// Unit boundary at byte offset `at` (the next one if `at` is inside a
	/// character).
	fn index(&self, at: usize) -> usize {
		match self {
			Self::Bytes(_) => at,
			Self::Wide { offsets, .. } => offsets.partition_point(|&o| o < at),
		}
	}
}

/// A compiled bash pattern.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pattern {
	src:   Box<[u8]>,
	/// The pattern as characters, when `utf8` is on and it is valid UTF-8.
	wide:  Option<Box<[u32]>>,
	/// The pattern has a multibyte character.
	mb:    bool,
	flags: u32,
	shape: Shape,
}

impl Pattern {
	/// Compile pattern bytes (quoted characters backslash-escaped).
	pub fn compile(src: &[u8], opts: PatOpts) -> Self {
		let wide = if opts.utf8 {
			core::str::from_utf8(src)
				.ok()
				.map(|s| s.chars().map(u32::from).collect())
		} else {
			None
		};
		Self {
			src: src.into(),
			wide,
			mb: has_multibyte(src),
			flags: opts.flags(),
			shape: Shape::of(src, opts),
		}
	}

	/// `s` cut the way bash's matcher would see it: characters when the
	/// locale is UTF-8, pattern and subject are valid UTF-8 and one of them
	/// has a multibyte character; bytes otherwise.
	fn units<'a>(&'a self, s: &'a [u8]) -> Units<'a> {
		if let Some(pat) = self.wide.as_deref()
			&& (self.mb || has_multibyte(s))
			&& let Ok(text) = core::str::from_utf8(s)
		{
			let mut chars = Vec::with_capacity(text.len());
			let mut offsets = Vec::with_capacity(text.len() + 1);
			for (at, c) in text.char_indices() {
				offsets.push(at);
				chars.push(u32::from(c));
			}
			offsets.push(text.len());
			return Units::Wide { pat, chars, offsets };
		}
		Units::Bytes(s)
	}

	/// Whether units `range` of `u` match the whole pattern.
	fn run(&self, u: &Units<'_>, range: Range<usize>) -> bool {
		match u {
			Units::Bytes(b) => strmatch(&self.src, &b[range], self.flags),
			Units::Wide { pat, chars, .. } => strmatch(pat, &chars[range], self.flags),
		}
	}

	/// Whether the whole of `s` matches.
	pub fn matches(&self, s: &[u8]) -> bool {
		match &self.shape {
			Shape::Literal(l) => s == &**l,
			Shape::Prefix(l) => s.starts_with(l),
			Shape::Suffix(l) => s.ends_with(l),
			Shape::Contains(l) => find_sub(s, l).is_some(),
			Shape::Any => true,
			Shape::General => {
				let u = self.units(s);
				self.run(&u, 0..u.len())
			},
		}
	}

	/// `${s#pat}` / `${s##pat}`: the end of the shortest (`longest`: the
	/// longest) prefix of `s` that matches, if any.
	pub fn prefix(&self, s: &[u8], longest: bool) -> Option<usize> {
		match &self.shape {
			Shape::Literal(l) => s.starts_with(l).then_some(l.len()),
			Shape::Prefix(l) => s
				.starts_with(l)
				.then_some(if longest { s.len() } else { l.len() }),
			Shape::Suffix(l) => {
				let at = if longest {
					rfind_sub(s, l)
				} else {
					find_sub(s, l)
				};
				at.map(|at| at + l.len())
			},
			Shape::Contains(l) => {
				find_sub(s, l).map(|at| if longest { s.len() } else { at + l.len() })
			},
			Shape::Any => Some(if longest { s.len() } else { 0 }),
			Shape::General => {
				let u = self.units(s);
				let hit = |&end: &usize| self.run(&u, 0..end);
				let end = if longest {
					(0..=u.len()).rev().find(hit)
				} else {
					(0..=u.len()).find(hit)
				};
				end.map(|end| u.offset(end))
			},
		}
	}

	/// `${s%pat}` / `${s%%pat}`: the start of the shortest (`longest`: the
	/// longest) suffix of `s` that matches, if any.
	pub fn suffix(&self, s: &[u8], longest: bool) -> Option<usize> {
		match &self.shape {
			Shape::Literal(l) => s.ends_with(l).then(|| s.len() - l.len()),
			Shape::Prefix(l) => {
				if longest {
					find_sub(s, l)
				} else {
					rfind_sub(s, l)
				}
			},
			Shape::Suffix(l) => s
				.ends_with(l)
				.then(|| if longest { 0 } else { s.len() - l.len() }),
			Shape::Contains(l) => {
				if longest {
					find_sub(s, l).map(|_| 0)
				} else {
					rfind_sub(s, l)
				}
			},
			Shape::Any => Some(if longest { 0 } else { s.len() }),
			Shape::General => {
				let u = self.units(s);
				let n = u.len();
				let hit = |&start: &usize| self.run(&u, start..n);
				let start = if longest {
					(0..=n).find(hit)
				} else {
					(0..=n).rev().find(hit)
				};
				start.map(|start| u.offset(start))
			},
		}
	}

	/// `${s/pat/r}`'s search: the leftmost match starting at or after byte
	/// `from`, and of those the longest (bash's `match_pattern` with
	/// `MATCH_ANY`). The match may be empty.
	pub fn find(&self, s: &[u8], from: usize) -> Option<Range<usize>> {
		let rest = s.get(from..)?;
		match &self.shape {
			Shape::Literal(l) => find_sub(rest, l).map(|at| from + at..from + at + l.len()),
			Shape::Prefix(l) => find_sub(rest, l).map(|at| from + at..s.len()),
			Shape::Suffix(l) => rfind_sub(rest, l).map(|at| from..from + at + l.len()),
			Shape::Contains(l) => find_sub(rest, l).map(|_| from..s.len()),
			Shape::Any => Some(from..s.len()),
			Shape::General => {
				let u = self.units(s);
				let n = u.len();
				(u.index(from)..=n).find_map(|start| {
					(start..=n)
						.rev()
						.find(|&end| self.run(&u, start..end))
						.map(|end| u.offset(start)..u.offset(end))
				})
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn m(p: &str, s: &str) -> bool {
		Pattern::compile(p.as_bytes(), PatOpts { extglob: true, ..PatOpts::default() })
			.matches(s.as_bytes())
	}

	#[test]
	fn star_question_and_escapes() {
		assert!(m("*", ""));
		assert!(m("a*b*c", "aXXbYc"));
		assert!(!m("a*b*c", "aXXbY"));
		assert!(m("a?c", "abc"));
		assert!(!m("a?c", "ac"));
		assert!(m("\\*", "*"));
		assert!(!m("\\*", "x"));
		assert!(m("a\\", "a\\"), "a trailing backslash is literal");
	}

	#[test]
	fn unclosed_bracket_and_group_are_literal() {
		assert!(m("[ab", "[ab"));
		assert!(m("@(a", "@(a"));
	}

	#[test]
	fn brackets_ranges_negation_and_classes() {
		assert!(m("[a-c]x", "bx"));
		assert!(!m("[!a-c]x", "bx"));
		assert!(m("[^a-c]x", "dx"));
		assert!(m("[]]", "]"));
		assert!(m("[[:digit:]][[:alpha:]]", "1a"));
		assert!(!m("[[:upper:]]", "a"));
	}

	/// bash 5.3 in the C locale (posixpat.tests and neighbours).
	#[test]
	fn collating_symbols_equivalence_classes_and_odd_brackets() {
		for (pat, s, want) in [
			("[[.hyphen.]-9]", "-", true),
			("[[.a.]-[.z.]]", "p", true),
			("[[.space.]]", " ", true),
			("[[.grave-accent.]]", " ", false),
			("[[.-.]-9]", "4", true),
			("[[.yyz.]-[.z.]]", "c", false),
			("[[.yyz.][.a.]-z]", "c", true),
			("[[.a.]-[.Z.]]", "p", false),
			("[[.a.]-[.zz.]p]", "p", true),
			("[[.aa.]-[.z.]p]", "p", true),
			("[[.cb.]a-Za]*", "abc", true),
			("[[.space.][.tab.][.newline.]]", "\t", true),
			("[[:alpha:]][[=b=]][[:ascii:]]", "abc", true),
			("[[:alpha:]][[=B=]][[:ascii:]]", "abc", false),
			("[[=b=]", "a", false),
			("[[=b=]", "[=b=]", false),
			("[[:al:]", "a", false),
			("[[:al:]x]", "x", true),
			("[:al:]", "a", true),
			("[[:alpha:]123]", "1", true),
			("[[:alpha:]\\]", "a", false),
			("[[=space=]]", " ", true),
			("[[.].]]", "]", true),
			("[a-[:alpha:]]", ":", false),
			("[]-a]", "^", true),
			("[!]]", "a", true),
			("[\\]]", "]", true),
			("[a\\-z]", "-", true),
			("[[:upper:]]", "a", false),
		] {
			assert_eq!(m(pat, s), want, "{pat:?} vs {s:?}");
		}
		assert!(
			Pattern::compile(b"[[.zz.]]", PatOpts::default()).matches(&[0xff]),
			"an unknown symbol is byte 0xff"
		);
	}

	/// `nocasematch` folds bytes and range bounds, not class tests.
	#[test]
	fn nocase_brackets_fold_like_bash() {
		let nc = |p: &str, s: &str| {
			Pattern::compile(p.as_bytes(), PatOpts { nocase: true, ..PatOpts::default() })
				.matches(s.as_bytes())
		};
		assert!(!nc("[[:upper:]]", "a"));
		assert!(nc("[A-Z]", "q"));
		assert!(!nc("[Z-a]", "z"));
		assert!(nc("[[=A=]]", "a"));
	}

	#[test]
	fn extglob_forms() {
		assert!(m("@(ab|cd)", "cd"));
		assert!(!m("@(ab|cd)", "abcd"));
		assert!(m("?(ab)c", "c"));
		assert!(m("?(ab)c", "abc"));
		assert!(m("*(ab)c", "ababc"));
		assert!(!m("+(ab)c", "c"));
		assert!(m("+(ab)c", "abc"));
		assert!(m("!(foo)", "bar"));
		assert!(!m("!(foo)", "foo"));
		assert!(m("!(foo)*", "foo"), "`!(foo)` may match the empty prefix");
		assert!(m("x@(a|b*(c))y", "xbcccy"));
	}

	#[test]
	fn extglob_off_keeps_operators_literal() {
		let p = Pattern::compile(b"@(a|b)", PatOpts::default());
		assert!(p.matches(b"@(a|b)"));
		assert!(!p.matches(b"a"));
	}

	#[test]
	fn nocase_matches_both_cases() {
		let p = Pattern::compile(b"ab[c]", PatOpts { nocase: true, ..PatOpts::default() });
		assert!(p.matches(b"ABC"));
	}

	/// Brute force over every split, straight through the matcher.
	fn brute(p: &Pattern, s: &[u8]) -> [Option<usize>; 4] {
		let m = |t: &[u8]| strmatch(&p.src, t, p.flags);
		let n = s.len();
		[
			(0..=n).find(|&i| m(&s[..i])),
			(0..=n).rev().find(|&i| m(&s[..i])),
			(0..=n).rev().find(|&i| m(&s[i..])),
			(0..=n).find(|&i| m(&s[i..])),
		]
	}

	/// The literal/`*` fast paths answer exactly what the matcher does.
	#[test]
	fn fast_shapes_agree_with_the_matcher() {
		let pats = ["", "*", "**", "a", "ab", "a*", "*b", "*/", ".*", "*a*", "a\\*", "\\*x", "x\\"];
		let subjects =
			["", "a", "ab", "ba", "aXbYab", "/usr/lib/x.so", "a.b.c", "*x", "x\\", "aa*", "\\"];
		for pat in pats {
			let p = Pattern::compile(pat.as_bytes(), PatOpts::default());
			assert_ne!(p.shape, Shape::General, "{pat:?} has a fast shape");
			for s in subjects {
				let s = s.as_bytes();
				let [sp, lp, ss, ls] = brute(&p, s);
				let ctx = (pat, String::from_utf8_lossy(s));
				assert_eq!(p.matches(s), strmatch(&p.src, s, p.flags), "{ctx:?}");
				assert_eq!(p.prefix(s, false), sp, "{ctx:?}");
				assert_eq!(p.prefix(s, true), lp, "{ctx:?}");
				assert_eq!(p.suffix(s, false), ss, "{ctx:?}");
				assert_eq!(p.suffix(s, true), ls, "{ctx:?}");
				for from in 0..=s.len() {
					let want = (from..=s.len()).find_map(|a| {
						(a..=s.len())
							.rev()
							.find(|&b| strmatch(&p.src, &s[a..b], p.flags))
							.map(|b| a..b)
					});
					assert_eq!(p.find(s, from), want, "{ctx:?} from {from}");
				}
			}
		}
		assert_eq!(Shape::of(b"a?", PatOpts::default()), Shape::General);
		assert_eq!(Shape::of(b"*\\", PatOpts::default()), Shape::General, "`*\\` matches nothing");
		assert!(!Pattern::compile(b"*\\", PatOpts::default()).matches(b"a\\"));
		assert_eq!(
			Shape::of(b"*(a)", PatOpts { extglob: true, ..PatOpts::default() }),
			Shape::General
		);
		assert_eq!(Shape::of(b"*(a)", PatOpts::default()), Shape::Suffix(b"(a)"[..].into()));
	}

	/// In a UTF-8 locale `?` and brackets take a whole character, and
	/// positions stay on character boundaries.
	#[test]
	fn utf8_matches_by_character() {
		let u = PatOpts { utf8: true, ..PatOpts::default() };
		assert!(Pattern::compile(b"a?b", u).matches("aéb".as_bytes()));
		assert!(!Pattern::compile(b"a?b", PatOpts::default()).matches("aéb".as_bytes()));
		assert!(Pattern::compile("[é]".as_bytes(), u).matches("é".as_bytes()));
		assert!(Pattern::compile(b"[[:alpha:]]", u).matches("é".as_bytes()));
		assert!(!Pattern::compile(b"[[:alpha:]]", PatOpts::default()).matches("é".as_bytes()));
		let q = Pattern::compile(b"?", u);
		assert_eq!(q.prefix("éa".as_bytes(), false), Some(2));
		assert_eq!(q.suffix("aé".as_bytes(), false), Some(1));
		assert_eq!(q.find("éé".as_bytes(), 0), Some(0..2));
		let nc = PatOpts { nocase: true, ..u };
		assert!(Pattern::compile("É".as_bytes(), nc).matches("é".as_bytes()));
		// Invalid UTF-8 falls back to bytes.
		assert!(Pattern::compile(b"a??", u).matches(b"a\xc3\x28"));
	}
}
