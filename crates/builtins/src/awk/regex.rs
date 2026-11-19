//! POSIX ERE support: translation of AWK regular expressions to the `regex`
//! crate's syntax, and POSIX leftmost-longest matching.
//!
//! The `regex` crate finds leftmost-first matches; POSIX (and GoAWK, via
//! `Regexp.Longest`) wants the longest match at the leftmost position. The
//! leftmost start is the same under both rules, so a match is found with
//! `regex`, then extended with an anchored `MatchKind::All` lazy DFA search
//! from that start, whose last match is the longest one.

use std::{cell::RefCell, fmt::Write as _};

use regex::bytes::{Regex, RegexBuilder};
use regex_automata::{
	Anchored, Input, MatchKind,
	hybrid::dfa::{Cache, DFA},
	nfa::thompson,
	util::syntax,
};

/// A compiled AWK regular expression.
pub(super) struct AwkRegex {
	re:      Regex,
	longest: Option<Longest>,
}

/// The anchored all-matches DFA that extends a leftmost match to the longest.
struct Longest {
	dfa:   DFA,
	cache: RefCell<Cache>,
}

impl AwkRegex {
	/// Compiles AWK ERE source `src`.
	pub fn new(src: &[u8]) -> Result<Self, String> {
		let pattern = translate(src)?;
		let re = RegexBuilder::new(&pattern)
			.dot_matches_new_line(true)
			.build()
			.map_err(|err| format!("invalid regex {:?}: {}", String::from_utf8_lossy(src), first_line(&err.to_string())))?;
		let longest = if src.iter().any(|c| matches!(c, b'|' | b'*' | b'+' | b'?' | b'{')) {
			DFA::builder()
				.configure(DFA::config().match_kind(MatchKind::All))
				.syntax(syntax::Config::new().dot_matches_new_line(true).utf8(false))
				.thompson(thompson::Config::new().utf8(false))
				.build(&pattern)
				.ok()
				.map(|dfa| {
					let cache = RefCell::new(dfa.create_cache());
					Longest { dfa, cache }
				})
		} else {
			None
		};
		Ok(Self { re, longest })
	}

	/// A regex matching `literal` exactly.
	pub fn literal(literal: &[u8]) -> Result<Self, String> {
		let mut pattern = String::new();
		for chunk in literal.utf8_chunks() {
			pattern.push_str(&regex::escape(chunk.valid()));
			for byte in chunk.invalid() {
				let _ = write!(pattern, "(?-u:\\x{byte:02X})");
			}
		}
		let re = Regex::new(&pattern).map_err(|err| first_line(&err.to_string()))?;
		Ok(Self { re, longest: None })
	}

	pub fn is_match(&self, hay: &[u8]) -> bool {
		self.re.is_match(hay)
	}

	/// The leftmost-longest match starting at or after `start`.
	pub fn find_at(&self, hay: &[u8], start: usize) -> Option<(usize, usize)> {
		let found = self.re.find_at(hay, start)?;
		let (begin, mut end) = (found.start(), found.end());
		if let Some(longest) = &self.longest {
			let input = Input::new(hay).range(begin..).anchored(Anchored::Yes);
			if let Ok(Some(half)) = longest.dfa.try_search_fwd(&mut longest.cache.borrow_mut(), &input) {
				end = end.max(half.offset());
			}
		}
		Some((begin, end))
	}
}

fn first_line(message: &str) -> String {
	message.lines().last().unwrap_or(message).trim().trim_start_matches("error: ").to_owned()
}

/// Whether the quantifier bytes `*+?` can apply to what precedes them.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Prev {
	/// Start of the pattern, after `(`, `|`, `^`: a quantifier is literal.
	Nothing,
	/// An atom: a quantifier applies.
	Atom,
	/// A quantifier: another one merges into it (ERE `a+?` is `(a+)?`, not
	/// the lazy `+?` of the `regex` crate).
	Quant(usize),
}

/// Translates AWK ERE source to `regex` crate syntax.
fn translate(src: &[u8]) -> Result<String, String> {
	let mut out = String::with_capacity(src.len() + 8);
	let mut prev = Prev::Nothing;
	let mut i = 0;
	while i < src.len() {
		let c = src[i];
		match c {
			b'\\' => {
				i += 1;
				if i >= src.len() {
					out.push_str("\\\\");
					break;
				}
				i += push_escape(&mut out, &src[i..], false);
				prev = Prev::Atom;
				continue;
			},
			b'[' => {
				i += push_bracket(&mut out, &src[i..])?;
				prev = Prev::Atom;
				continue;
			},
			b'(' => {
				out.push('(');
				prev = Prev::Nothing;
			},
			b')' => {
				out.push(')');
				prev = Prev::Atom;
			},
			b'|' => {
				out.push('|');
				prev = Prev::Nothing;
			},
			b'^' => {
				out.push('^');
				prev = Prev::Nothing;
			},
			b'$' => {
				out.push('$');
				prev = Prev::Atom;
			},
			b'.' => {
				out.push('.');
				prev = Prev::Atom;
			},
			b'*' | b'+' | b'?' => match prev {
				Prev::Nothing => {
					out.push('\\');
					out.push(c as char);
					prev = Prev::Atom;
				},
				Prev::Atom => {
					prev = Prev::Quant(out.len());
					out.push(c as char);
				},
				Prev::Quant(at) => {
					let merged = match (&out[at..], c) {
						("+", b'+') => '+',
						("?", b'?') => '?',
						_ => '*',
					};
					if out.len() == at + 1 {
						out.truncate(at);
						out.push(merged);
					} else {
						// An interval followed by a quantifier.
						out.push(c as char);
						prev = Prev::Atom;
					}
				},
			},
			b'{' => {
				let interval = interval_len(&src[i..]);
				match (interval, prev) {
					(Some(len), Prev::Atom) => {
						let text = std::str::from_utf8(&src[i..i + len]).unwrap_or("");
						prev = Prev::Quant(out.len());
						out.push_str(text);
						i += len;
						continue;
					},
					_ => {
						out.push_str("\\{");
						prev = Prev::Atom;
					},
				}
			},
			b'}' => {
				out.push_str("\\}");
				prev = Prev::Atom;
			},
			_ => {
				i += push_literal_char(&mut out, &src[i..]);
				prev = Prev::Atom;
				continue;
			},
		}
		i += 1;
	}
	Ok(out)
}

/// Length of an interval expression `{n}`, `{n,}` or `{n,m}` at the start of
/// `src`, if there is one.
fn interval_len(src: &[u8]) -> Option<usize> {
	let mut i = 1;
	let digits = |i: &mut usize| {
		let start = *i;
		while *i < src.len() && src[*i].is_ascii_digit() {
			*i += 1;
		}
		*i > start
	};
	let has_min = digits(&mut i);
	if i < src.len() && src[i] == b',' {
		i += 1;
		digits(&mut i);
	}
	(has_min && i < src.len() && src[i] == b'}').then_some(i + 1)
}

/// Pushes one source character (UTF-8 or a raw byte) as a literal; returns
/// the bytes consumed.
fn push_literal_char(out: &mut String, src: &[u8]) -> usize {
	match decode_char(src) {
		Some((c, len)) => {
			push_escaped(out, c);
			len
		},
		None => {
			let _ = write!(out, "(?-u:\\x{:02X})", src[0]);
			1
		},
	}
}

fn push_escaped(out: &mut String, c: char) {
	let mut buf = [0; 4];
	out.push_str(&regex::escape(c.encode_utf8(&mut buf)));
}

/// The UTF-8 character at the start of `src` and its length.
fn decode_char(src: &[u8]) -> Option<(char, usize)> {
	let len = match src.first()? {
		0x00..=0x7F => 1,
		0xC0..=0xDF => 2,
		0xE0..=0xEF => 3,
		0xF0..=0xF7 => 4,
		_ => return None,
	};
	let text = std::str::from_utf8(src.get(..len)?).ok()?;
	text.chars().next().map(|c| (c, len))
}

/// Pushes the translation of the escape whose character starts `src` (the
/// backslash is already consumed); returns the bytes consumed.
fn push_escape(out: &mut String, src: &[u8], in_bracket: bool) -> usize {
	let c = src[0];
	let byte = |out: &mut String, value: u8| {
		if value < 0x80 || in_bracket {
			let _ = write!(out, "\\x{value:02X}");
		} else {
			let _ = write!(out, "(?-u:\\x{value:02X})");
		}
	};
	match c {
		b'n' => out.push_str("\\n"),
		b't' => out.push_str("\\t"),
		b'r' => out.push_str("\\r"),
		b'f' => out.push_str("\\x0C"),
		b'v' => out.push_str("\\x0B"),
		b'a' => out.push_str("\\x07"),
		b'b' => out.push_str("\\x08"),
		b'/' => out.push('/'),
		b'"' => out.push('"'),
		b'0'..=b'7' => {
			let mut value = u32::from(c - b'0');
			let mut len = 1;
			while len < 3 && len < src.len() && (b'0'..=b'7').contains(&src[len]) {
				value = value * 8 + u32::from(src[len] - b'0');
				len += 1;
			}
			byte(out, (value & 0xFF) as u8);
			return len;
		},
		b'x' => {
			let mut value = 0u8;
			let mut len = 1;
			while len < 3 && len < src.len() && src[len].is_ascii_hexdigit() {
				value = value * 16 + (src[len] as char).to_digit(16).unwrap_or(0) as u8;
				len += 1;
			}
			if len == 1 {
				out.push('x');
			} else {
				byte(out, value);
			}
			return len;
		},
		b's' | b'S' | b'w' | b'W' | b'd' | b'D' => {
			out.push('\\');
			out.push(c as char);
		},
		b'y' if !in_bracket => out.push_str("\\b"),
		b'B' if !in_bracket => out.push_str("\\B"),
		b'<' if !in_bracket => out.push_str("\\b{start}"),
		b'>' if !in_bracket => out.push_str("\\b{end}"),
		b'`' if !in_bracket => out.push_str("\\A"),
		b'\'' if !in_bracket => out.push_str("\\z"),
		_ => return push_literal_char(out, src),
	}
	1
}

/// Pushes the translation of the bracket expression starting at `src[0]`
/// (`[`); returns the bytes consumed.
fn push_bracket(out: &mut String, src: &[u8]) -> Result<usize, String> {
	let mut i = 1;
	out.push('[');
	if src.get(i) == Some(&b'^') {
		out.push('^');
		i += 1;
	}
	let mut first = true;
	let mut last_dash = false;
	loop {
		let Some(&c) = src.get(i) else {
			return Err(format!("invalid regex {:?}: unterminated [", String::from_utf8_lossy(src)));
		};
		if c == b']' && !first {
			out.push(']');
			return Ok(i + 1);
		}
		first = false;
		let mut dash = false;
		match c {
			b'[' if matches!(src.get(i + 1), Some(b':' | b'.' | b'=')) => {
				let kind = src[i + 1];
				let close = [kind, b']'];
				let end = src[i + 2..].windows(2).position(|w| w == &close[..]).map(|p| i + 2 + p);
				match end {
					Some(end) if kind == b':' => {
						let name = std::str::from_utf8(&src[i + 2..end]).unwrap_or("");
						let _ = write!(out, "[:{name}:]");
						i = end + 2;
					},
					Some(end) => {
						for chunk in src[i + 2..end].utf8_chunks() {
							for ch in chunk.valid().chars() {
								push_escaped(out, ch);
							}
						}
						i = end + 2;
					},
					None => {
						out.push_str("\\[");
						i += 1;
					},
				}
				last_dash = false;
				continue;
			},
			b'\\' if i + 1 < src.len() => {
				i += 1;
				i += push_escape(out, &src[i..], true);
				last_dash = false;
				continue;
			},
			b'-' => {
				if last_dash {
					out.push_str("\\-");
				} else {
					out.push('-');
					dash = true;
				}
			},
			b'[' | b']' | b'^' | b'&' | b'~' | b'\\' => {
				out.push('\\');
				out.push(c as char);
			},
			_ => {
				i += match decode_char(&src[i..]) {
					Some((ch, len)) => {
						out.push(ch);
						len
					},
					None => {
						let _ = write!(out, "\\x{:02X}", c);
						1
					},
				};
				last_dash = false;
				continue;
			},
		}
		last_dash = dash;
		i += 1;
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn find(re: &str, hay: &str) -> Option<(usize, usize)> {
		AwkRegex::new(re.as_bytes()).unwrap().find_at(hay.as_bytes(), 0)
	}

	#[test]
	fn translates_ere_quirks() {
		assert_eq!(translate(b"[]a]").unwrap(), "[\\]a]");
		assert_eq!(translate(b"[^]a]").unwrap(), "[^\\]a]");
		assert_eq!(translate(b"a{2,3}").unwrap(), "a{2,3}");
		assert_eq!(translate(b"{x").unwrap(), "\\{x");
		assert_eq!(translate(b"*a").unwrap(), "\\*a");
		assert_eq!(translate(b"a+?").unwrap(), "a*");
		assert_eq!(translate(b"[[:alpha:]_]").unwrap(), "[[:alpha:]_]");
		assert_eq!(translate(b"\\/x\\.").unwrap(), "/x\\.");
	}

	#[test]
	fn matches_leftmost_longest() {
		assert_eq!(find("b|bc", "abcd"), Some((1, 3)));
		assert_eq!(find("(a|ab)(c|bcd)", "abcd"), Some((0, 4)));
		assert_eq!(find("x*", "abc"), Some((0, 0)));
		assert_eq!(find("[0-9]+", "ab123c"), Some((2, 5)));
	}

	#[test]
	fn dot_matches_newline() {
		assert_eq!(find("a.b", "a\nb"), Some((0, 3)));
	}
}
