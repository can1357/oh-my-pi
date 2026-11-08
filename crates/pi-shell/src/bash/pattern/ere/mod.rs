//! POSIX extended regular expressions for `[[ string =~ regex ]]`.
//!
//! bash hands the right-hand side of `=~` to the C library's
//! `regcomp(REG_EXTENDED [| REG_ICASE])` and reads the groups `regexec`
//! reports into `BASH_REMATCH`. [`Regex`] reproduces glibc's behaviour,
//! because that is what bash's expected test output records:
//!
//! - Syntax is `RE_SYNTAX_POSIX_EXTENDED`: literals, `.`, bracket expressions
//!   (ranges, `^` negation, a leading `]`, `[:class:]`, `[=c=]`, `[.c.]`), `^`
//!   and `$` anywhere, `( )`, `|`, `* + ?`, `{m}` `{m,}` `{m,n}` `{,n}`,
//!   back-references `\1`..`\9`, and the GNU escapes `\w`, `\W`, `\s`, `\S`,
//!   `\b`, `\B`, `\<`, `\>`, ``\` `` and `\'`. Any other escaped character is
//!   literal. Empty groups and alternatives are allowed; a stray `)` or `}` is
//!   literal; a repetition operator with nothing to repeat is an error. Without
//!   `REG_NEWLINE`, `.` and negated lists match newline, and `^`/`$` only match
//!   at the ends.
//! - The match is the leftmost one, and of those the longest.
//! - Groups follow glibc's `set_regs`, not the POSIX subexpression rules: along
//!   the overall match glibc takes, at each fork, the first branch that can
//!   still complete it, in node order (`a|b` prefers `a`, `X*` another pass, an
//!   empty alternative comes last). So `(a|ab)(c|bcd)(d*)` on `abcd` reports
//!   `a`, `bcd` and the empty string. A repeated group reports its last pass; a
//!   group the match did not pass through is unset.
//! - `REG_ICASE` upper-cases pattern and subject as glibc does: `[[:lower:]]`
//!   and `[[:upper:]]` mean `[[:alpha:]]`, range bounds fold before they are
//!   compared, and a backslash-escaped letter is not folded (glibc reads it
//!   raw, so `\a` never matches under `REG_ICASE`).
//!
//! [`Regex::new`] works on bytes, as in the C locale. [`Regex::with_utf8`]
//! cuts pattern and subject into UTF-8 characters, as in a UTF-8 locale: `.`
//! and bracket expressions match a whole character, classes use Unicode
//! properties, and ranges compare code points (glibc compares collation
//! order in some locales). Unsupported corners: multi-character collating
//! elements (`[[.ch.]]`) and equivalence classes wider than one character
//! (`[[=e=]]` matches only `e`) are rejected or literal, as in the C locale.
//!
//! # Complexity
//!
//! Matching takes O(n·m) time and n·m bits for a subject of n units and a
//! pattern of m nodes (`{m,n}` is unrolled, as glibc does; patterns past
//! 131 072 tree nodes fail with [`RegexErrorKind::Space`]). Patterns with
//! back-references search with backtracking under a fixed step budget; a
//! search that exhausts it reports no match.
//!
//! # Example
//!
//! ```
//! use pi_shell::bash::pattern::Regex;
//!
//! let re = Regex::new(b"([^-]+)-([0-9]+)", false).unwrap();
//! let groups = re.captures(b"pkg-42.tgz").unwrap();
//! assert_eq!(groups, [Some(0..6), Some(0..3), Some(4..6)]);
//! ```

mod exec;
mod nfa;
mod parse;
mod set;
mod unit;

use core::{fmt, ops::Range};

use crate::bash::pattern::ere::{nfa::Prog, unit::Mode};

/// A compiled POSIX extended regular expression.
#[derive(Clone, Debug)]
pub struct Regex {
	prog: Prog,
	mode: Mode,
}

impl Regex {
	/// Compile `pattern` as `regcomp(REG_EXTENDED)` does in the C locale
	/// (byte-wise); `icase` adds `REG_ICASE`.
	pub fn new(pattern: &[u8], icase: bool) -> Result<Self, RegexError> {
		Self::with_utf8(pattern, icase, false)
	}

	/// Compile `pattern`; with `utf8`, pattern and subjects are read as UTF-8
	/// characters (a UTF-8 locale) instead of bytes.
	pub fn with_utf8(pattern: &[u8], icase: bool, utf8: bool) -> Result<Self, RegexError> {
		let mode = Mode { utf8, icase };
		let tree = parse::parse(pattern, mode).map_err(|kind| RegexError { kind })?;
		Ok(Self { prog: Prog::new(tree), mode })
	}

	/// Number of parenthesized groups (`re_nsub`).
	pub const fn groups(&self) -> usize {
		self.prog.groups
	}

	/// Match against `text`: `None` when it does not match, else the byte
	/// ranges of the whole match (`[0]`) and of every group (`[1..]`, `None`
	/// for a group the match did not use): one more entry than
	/// [`Regex::groups`].
	pub fn captures(&self, text: &[u8]) -> Option<Vec<Option<Range<usize>>>> {
		exec::captures(&self.prog, self.mode, text)
	}
}

/// Why a pattern does not compile; glibc's `REG_*` error codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RegexErrorKind {
	/// `REG_BADPAT`: e.g. a `[` that ends the pattern.
	BadPattern,
	/// `REG_ECOLLATE`: `[[.xy.]]`, `[[=xy=]]`.
	Collate,
	/// `REG_ECTYPE`: `[[:nosuch:]]`.
	CharClass,
	/// `REG_EESCAPE`: a trailing `\`.
	Escape,
	/// `REG_ESUBREG`: `\n` before group `n` is closed.
	BackRef,
	/// `REG_EBRACK`: an unclosed bracket expression.
	Bracket,
	/// `REG_EPAREN`: an unclosed `(`.
	Paren,
	/// `REG_EBRACE`: a `{` interval the pattern ends inside.
	Brace,
	/// `REG_BADBR`: a malformed `{m,n}`.
	BadBrace,
	/// `REG_ERANGE`: `[z-a]`, or a class as a range bound.
	Range,
	/// `REG_ESPACE`: the pattern expands past the size or nesting limit.
	Space,
	/// `REG_BADRPT`: `*`, `+`, `?` or `{` with nothing to repeat.
	BadRepeat,
	/// `REG_ESIZE`: a count above 32767.
	Size,
}

impl RegexErrorKind {
	/// glibc's `regerror` text, which bash prints after
	/// ``invalid regular expression `PAT': ``.
	pub const fn message(self) -> &'static str {
		match self {
			Self::BadPattern => "Invalid regular expression",
			Self::Collate => "Invalid collation character",
			Self::CharClass => "Invalid character class name",
			Self::Escape => "Trailing backslash",
			Self::BackRef => "Invalid back reference",
			Self::Bracket => "Unmatched [, [^, [:, [., or [=",
			Self::Paren => "Unmatched ( or \\(",
			Self::Brace => "Unmatched \\{",
			Self::BadBrace => "Invalid content of \\{\\}",
			Self::Range => "Invalid range end",
			Self::Space => "Memory exhausted",
			Self::BadRepeat => "Invalid preceding regular expression",
			Self::Size => "Regular expression too big",
		}
	}
}

/// A pattern that does not compile; displays as glibc's `regerror` text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct RegexError {
	kind: RegexErrorKind,
}

impl RegexError {
	/// What is wrong with the pattern.
	pub const fn kind(&self) -> RegexErrorKind {
		self.kind
	}
}

impl fmt::Display for RegexError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(self.kind.message())
	}
}

impl core::error::Error for RegexError {}

#[cfg(test)]
mod tests;
