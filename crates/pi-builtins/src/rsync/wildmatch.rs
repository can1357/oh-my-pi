//! rsync's wildcard matcher.
//!
//! Semantics (documented in rsync(1), "PATTERN MATCHING RULES"):
//!
//! - `?` matches one byte other than `/`.
//! - `*` matches any run of bytes that contains no `/`.
//! - `**` (two or more stars) matches any run of bytes, slashes included.
//! - `[...]` matches one byte (never `/`) from a set: ranges `a-z`, the POSIX classes
//!   `[:alnum:]`, `[:alpha:]`, `[:blank:]`, `[:cntrl:]`, `[:digit:]`, `[:graph:]`,
//!   `[:lower:]`, `[:print:]`, `[:punct:]`, `[:space:]`, `[:upper:]`, `[:xdigit:]` (ASCII
//!   only), negation with a leading `!` or `^`, a leading `]` taken literally, and
//!   backslash escapes inside the set. An unterminated set or an unknown class name makes
//!   the whole pattern fail to match.
//! - `\x` matches `x` literally.
//!
//! Matching is byte-oriented. Whether a pattern is matched against the whole path, its
//! trailing components, or at any slash boundary is decided by the caller ([`Where`]);
//! `filter.rs` makes that choice from the rule's anchoring and slash count.

/// Where in the text a pattern may start matching.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Where {
	/// Only at the start of the text.
	Start,
	/// Against the last `n` slash-separated components of the text (`n >= 1`).
	Trailing(usize),
	/// At the start of the text or right after any `/` in it.
	AnySlash,
}

/// Outcome of one matching attempt. The two "give up" outcomes let enclosing star loops
/// stop early: `Exhausted` means no later starting point can match either, `SlashWall`
/// means a single `*` ran into a `/` (so only an enclosing `**` may keep trying).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
	Match,
	Mismatch,
	Exhausted,
	SlashWall,
}

/// Matches `pattern` against the whole of `text`.
pub(crate) fn wildmatch(pattern: &[u8], text: &[u8]) -> bool {
	attempt(pattern, text) == Outcome::Match
}

/// Matches `pattern` against `text` starting where `place` allows.
pub(crate) fn wildmatch_at(pattern: &[u8], text: &[u8], place: Where) -> bool {
	let text = match place {
		Where::Trailing(n) => match trailing_components(text, n) {
			Some(t) => t,
			None => return false,
		},
		Where::Start | Where::AnySlash => text,
	};
	let first = attempt(pattern, text);
	if first == Outcome::Match || place != Where::AnySlash || first == Outcome::Exhausted {
		return first == Outcome::Match;
	}
	for (i, &b) in text.iter().enumerate() {
		if b != b'/' {
			continue;
		}
		match attempt(pattern, &text[i + 1..]) {
			Outcome::Match => return true,
			Outcome::Exhausted => return false,
			Outcome::Mismatch | Outcome::SlashWall => {}
		}
	}
	false
}

/// Literal (wildcard-free) comparison of `literal` with `text`, honoring `place` like
/// [`wildmatch_at`] (`AnySlash` is treated as `Start`; rsync never asks for it).
pub(crate) fn litmatch_at(literal: &[u8], text: &[u8], place: Where) -> bool {
	match place {
		Where::Trailing(n) => trailing_components(text, n) == Some(literal),
		Where::Start | Where::AnySlash => text == literal,
	}
}

/// The suffix of `text` made of its last `n` slash-separated components, or `None` when
/// the text has fewer components.
fn trailing_components(text: &[u8], n: usize) -> Option<&[u8]> {
	if n == 0 {
		return None;
	}
	let mut needed = n;
	for (i, &b) in text.iter().enumerate().rev() {
		if b == b'/' {
			needed -= 1;
			if needed == 0 {
				return Some(&text[i + 1..]);
			}
		}
	}
	(needed == 1).then_some(text)
}

/// One anchored attempt: `pattern` must consume all of `text`.
fn attempt(pattern: &[u8], text: &[u8]) -> Outcome {
	let mut pi = 0;
	let mut ti = 0;
	while pi < pattern.len() {
		let pc = pattern[pi];
		if ti >= text.len() && pc != b'*' {
			return Outcome::Exhausted;
		}
		match pc {
			b'?' => {
				if text[ti] == b'/' {
					return Outcome::Mismatch;
				}
				pi += 1;
				ti += 1;
			}
			b'*' => return star(&pattern[pi..], &text[ti..]),
			b'[' => match class(&pattern[pi + 1..], text[ti]) {
				ClassResult::Matched(consumed) => {
					pi += 1 + consumed;
					ti += 1;
				}
				ClassResult::NoMatch => return Outcome::Mismatch,
				ClassResult::Malformed => return Outcome::Exhausted,
			},
			b'\\' => {
				// A trailing backslash compares against "no byte" and so never matches.
				match pattern.get(pi + 1) {
					Some(&lit) if lit == text[ti] => {
						pi += 2;
						ti += 1;
					}
					_ => return Outcome::Mismatch,
				}
			}
			lit => {
				if lit != text[ti] {
					return Outcome::Mismatch;
				}
				pi += 1;
				ti += 1;
			}
		}
	}
	if ti == text.len() { Outcome::Match } else { Outcome::Mismatch }
}

/// `pattern` starts with one or more `*`.
fn star(pattern: &[u8], text: &[u8]) -> Outcome {
	let stars = pattern.iter().take_while(|&&b| b == b'*').count();
	let crosses_slash = stars >= 2;
	let rest = &pattern[stars..];
	if rest.is_empty() {
		return if crosses_slash || !text.contains(&b'/') {
			Outcome::Match
		} else {
			Outcome::Mismatch
		};
	}
	for k in 0..text.len() {
		match attempt(rest, &text[k..]) {
			Outcome::Mismatch => {
				if !crosses_slash && text[k] == b'/' {
					return Outcome::SlashWall;
				}
			}
			Outcome::SlashWall if crosses_slash => {}
			other => return other,
		}
	}
	// `rest` needs at least one more byte, and the text is used up.
	Outcome::Exhausted
}

enum ClassResult {
	/// The byte is in the set; the value is how many pattern bytes the set used,
	/// including its closing `]`.
	Matched(usize),
	NoMatch,
	Malformed,
}

/// Evaluates a bracket expression; `body` starts right after the `[`.
fn class(body: &[u8], byte: u8) -> ClassResult {
	let at = |i: usize| body.get(i).copied().unwrap_or(0);
	let mut i = 0;
	let negated = matches!(at(0), b'!' | b'^');
	if negated {
		i += 1;
	}
	let mut matched = false;
	// The previous set member, usable as a range start; 0 when none is.
	let mut prev: u8 = 0;
	// The first member is consumed before the closing-bracket test, so a leading `]` is
	// literal.
	loop {
		let c = at(i);
		if c == 0 {
			return ClassResult::Malformed;
		}
		let mut member = c;
		if c == b'\\' {
			i += 1;
			member = at(i);
			if member == 0 {
				return ClassResult::Malformed;
			}
			if byte == member {
				matched = true;
			}
		} else if c == b'-' && prev != 0 && at(i + 1) != 0 && at(i + 1) != b']' {
			i += 1;
			let mut hi = at(i);
			if hi == b'\\' {
				i += 1;
				hi = at(i);
				if hi == 0 {
					return ClassResult::Malformed;
				}
			}
			if byte >= prev && byte <= hi {
				matched = true;
			}
			member = 0;
		} else if c == b'[' && at(i + 1) == b':' {
			let name_start = i + 2;
			let Some(close) = body[name_start.min(body.len())..].iter().position(|&b| b == b']')
			else {
				return ClassResult::Malformed;
			};
			let close = name_start + close;
			if close < name_start + 1 || body[close - 1] != b':' {
				// Not a "[:name:]" class: the `[` is an ordinary member.
				if byte == b'[' {
					matched = true;
				}
			} else {
				match posix_class(&body[name_start..close - 1], byte) {
					Some(true) => matched = true,
					Some(false) => {}
					None => return ClassResult::Malformed,
				}
				i = close;
				member = 0;
			}
		} else if byte == c {
			matched = true;
		}
		prev = member;
		i += 1;
		if at(i) == b']' {
			break;
		}
	}
	if matched == negated || byte == b'/' {
		ClassResult::NoMatch
	} else {
		ClassResult::Matched(i + 1)
	}
}

/// ASCII ctype classes; `None` for an unknown class name.
fn posix_class(name: &[u8], b: u8) -> Option<bool> {
	Some(match name {
		b"alnum" => b.is_ascii_alphanumeric(),
		b"alpha" => b.is_ascii_alphabetic(),
		b"blank" => b == b' ' || b == b'\t',
		b"cntrl" => b.is_ascii_control(),
		b"digit" => b.is_ascii_digit(),
		b"graph" => b.is_ascii_graphic(),
		b"lower" => b.is_ascii_lowercase(),
		b"print" => b.is_ascii_graphic() || b == b' ',
		b"punct" => b.is_ascii_punctuation(),
		b"space" => matches!(b, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r'),
		b"upper" => b.is_ascii_uppercase(),
		b"xdigit" => b.is_ascii_hexdigit(),
		_ => return None,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn wm(p: &str, t: &str) -> bool {
		wildmatch(p.as_bytes(), t.as_bytes())
	}

	#[test]
	fn basic_wildcards() {
		assert!(wm("foo", "foo"));
		assert!(!wm("foo", "bar"));
		assert!(wm("", ""));
		assert!(wm("???", "foo"));
		assert!(!wm("??", "foo"));
		assert!(wm("*", "foo"));
		assert!(wm("f*", "foo"));
		assert!(!wm("*f", "foo"));
		assert!(wm("*foo*", "foo"));
		assert!(wm("*ob*a*r*", "foobar"));
		assert!(wm("*ab", "aaaaaaabababab"));
		assert!(wm("foo\\*", "foo*"));
		assert!(!wm("foo\\*bar", "foobar"));
		assert!(wm("f\\\\oo", "f\\oo"));
		assert!(!wm("foo\\", "foo\\"));
		assert!(wm("*[al]?", "ball"));
		assert!(!wm("[ten]", "ten"));
		assert!(wm("**[!te]", "ten"));
		assert!(!wm("**[!ten]", "ten"));
		assert!(wm("t[a-g]n", "ten"));
		assert!(!wm("t[!a-g]n", "ten"));
		assert!(wm("t[!a-g]n", "ton"));
		assert!(wm("t[^a-g]n", "ton"));
		assert!(wm("a[]]b", "a]b"));
		assert!(wm("a[]-]b", "a-b"));
		assert!(wm("a[]-]b", "a]b"));
		assert!(!wm("a[]-]b", "aab"));
		assert!(wm("a[]a-]b", "aab"));
		assert!(wm("]", "]"));
	}

	#[test]
	fn slashes() {
		assert!(!wm("foo*bar", "foo/baz/bar"));
		assert!(!wm("foo?bar", "foo/bar"));
		assert!(!wm("foo[/]bar", "foo/bar"));
		assert!(wm("foo**bar", "foo/baz/bar"));
		assert!(wm("foo/**/bar", "foo/baz/bar"));
		assert!(wm("foo/**/bar", "foo/b/a/z/bar"));
		assert!(!wm("foo/**/bar", "foo/bar"));
		assert!(wm("foo/**", "foo/x/y"));
		assert!(!wm("foo/*", "foo/x/y"));
		assert!(wm("**/foo", "x/y/foo"));
		assert!(wm("*/foo", "x/foo"));
		assert!(!wm("*/foo", "x/y/foo"));
		assert!(wm("XXX/*/*/*/XXX", "XXX/adobe/courier/bold/XXX"));
		assert!(!wm("XXX/*/*/*/XXX", "XXX/adobe/courier/bold/o/XXX"));
		assert!(wm("XXX/**/XXX", "XXX/adobe/courier/bold/o/XXX"));
		assert!(wm("dir/***", "dir/"));
		assert!(wm("dir/***", "dir/a/b"));
	}

	#[test]
	fn classes() {
		assert!(wm("[[:alpha:]][[:digit:]][[:upper:]]", "a1B"));
		assert!(!wm("[[:digit:][:upper:][:space:]]", "a"));
		assert!(wm("[[:digit:][:upper:][:space:]]", "A"));
		assert!(wm("[[:digit:][:upper:][:space:]]", "1"));
		assert!(!wm("[[:digit:][:upper:][:spaci:]]", "1"));
		assert!(wm("[[:digit:][:upper:][:space:]]", " "));
		assert!(wm("[[:space:]]", "\u{0b}"));
		assert!(!wm("[[:digit:][:upper:][:space:]]", "."));
		assert!(wm("[[:digit:][:punct:][:space:]]", "."));
		assert!(wm("[[:xdigit:]]", "5"));
		assert!(wm("[[:xdigit:]]", "f"));
		assert!(wm("[[:xdigit:]]", "D"));
		assert!(wm("[[:alnum:][:alpha:][:blank:][:cntrl:][:digit:][:graph:][:lower:][:print:][:punct:][:space:][:upper:][:xdigit:]]", "_"));
		assert!(wm("[^[:alnum:][:alpha:][:blank:][:digit:][:graph:][:lower:][:print:][:punct:][:space:][:upper:][:xdigit:]]", "\u{1}"));
		assert!(!wm("[[:cntrl:]]", " "));
		assert!(wm("[a-c[:digit:]x-z]", "5"));
		assert!(wm("[a-c[:digit:]x-z]", "b"));
		assert!(wm("[a-c[:digit:]x-z]", "y"));
		assert!(!wm("[a-c[:digit:]x-z]", "q"));
		// "[:" without a closing ":]" is an ordinary bracket member.
		assert!(wm("[[:]x", "[x"));
		assert!(!wm("[\\-^]", "]"));
		assert!(wm("[\\]]", "]"));
		assert!(wm("[\\-_]", "-"));
		assert!(wm("[\\\\-^]", "]"));
		assert!(wm("[\\1-\\3]", "2"));
		assert!(wm("[[-\\]]", "\\"));
		assert!(wm("[[-\\]]", "["));
		assert!(wm("[[-\\]]", "]"));
		assert!(wm("[,]", ","));
		assert!(wm("[\\\\,]", "\\"));
		assert!(wm("[!]-]", "a"));
		assert!(!wm("[!]-]", "]"));
	}

	#[test]
	fn malformed_patterns_never_match() {
		assert!(!wm("[ab", "a"));
		assert!(!wm("[[:alpha:]", "a"));
		assert!(!wm("[[:nope:]]", "a"));
		assert!(!wm("a[", "ab"));
		assert!(!wm("[\\", "a"));
		assert!(!wm("[a-\\", "a"));
		// With no text left the pattern fails before the bracket is examined.
		assert!(!wm("a[", "a"));
	}

	#[test]
	fn placement() {
		let t = b"bar/deep/y.o";
		assert!(wildmatch_at(b"deep/*.o", t, Where::Trailing(2)));
		assert!(!wildmatch_at(b"deep/*.o", t, Where::Start));
		assert!(!wildmatch_at(b"bar/*.o", t, Where::Trailing(2)));
		assert!(!wildmatch_at(b"a/b/c/d", t, Where::Trailing(4)));
		assert!(wildmatch_at(b"deep/**", t, Where::AnySlash));
		assert!(wildmatch_at(b"bar/**", t, Where::AnySlash));
		assert!(!wildmatch_at(b"y/**", t, Where::AnySlash));
		assert!(wildmatch_at(b"y.*", b"y.o", Where::Trailing(1)));
		assert!(litmatch_at(b"deep/y.o", t, Where::Trailing(2)));
		assert!(!litmatch_at(b"eep/y.o", t, Where::Trailing(2)));
		assert!(litmatch_at(b"bar/deep/y.o", t, Where::Trailing(3)));
		assert!(litmatch_at(b"bar/deep/y.o", t, Where::Start));
	}

	#[test]
	fn pathological_patterns_finish() {
		let text = "a".repeat(64);
		let pat = "*a".repeat(20) + "b";
		assert!(!wm(&pat, &text));
		let pat2 = "**a".repeat(20) + "b";
		assert!(!wm(&pat2, &text));
	}
}
