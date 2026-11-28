//! Translate POSIX BREs and EREs for the Rust regex engines used by
//! `grep`, `sed`, and `nl`.

#[cfg(any(feature = "util.grep", feature = "util.sed"))]
use std::borrow::Cow;
use std::{iter::Peekable, str::Chars};

/// Whether the target engine supports back-references.
///
/// `sed` compiles with `fancy-regex`, which does; `grep` compiles with
/// `grep-regex` (the `regex` crate), which does not. When back-references are
/// unsupported the sequence is passed through unchanged, leaving the caller's
/// own compilation failure to decide what happens next.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code, reason = "each variant is used by a different utility feature")]
pub(crate) enum Backrefs {
	Supported,
	Unsupported,
}

/// A pattern the BRE dialect cannot express.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[cfg_attr(
	not(any(feature = "util.grep", feature = "util.sed")),
	allow(dead_code, reason = "only grep's ERE validation raises some variants")
)]
pub(crate) enum BreError {
	/// A repetition operator with nothing to repeat, where the tools error
	/// rather than treating the character as a literal.
	RepetitionOperandMissing,
	/// A `[` with no closing `]`, or a `[:`, `[.` or `[=` with no closing partner.
	UnmatchedBracket,
	/// A `[` or `[^` that ends an ERE, which glibc rejects as malformed outright.
	BracketAtEnd,
	/// A `[:name:]` naming no POSIX class.
	InvalidClassName,
	/// A `[.x.]` or `[=x=]` that is not a single character.
	InvalidCollation,
	InvalidCharacterRange,
	/// A `(` (ERE) or `\(` (BRE) that is never closed.
	UnmatchedParen,
	/// A BRE `\)` that closes no group.
	UnmatchedCloseParen,
	/// A BRE `\{` with no closing `\}`.
	UnmatchedBrace,
	/// An ERE interval `{}` or `{n,m}` with `n > m`.
	InvalidInterval,
	/// An ERE interval bound above glibc's `RE_DUP_MAX` (32767).
	IntervalTooBig,
	/// An ERE ending in an unescaped `\`.
	TrailingBackslash,
	/// An ERE back-reference to a group that is not closed before it.
	InvalidBackReference,
}

impl BreError {
	/// The BSD wording `sed` and `nl` print; conditions only grep's ERE
	/// validation raises have no BSD form and use glibc's.
	#[cfg_attr(
		not(any(feature = "util.sed", feature = "util.nl")),
		allow(dead_code, reason = "only sed and nl print the BSD wording")
	)]
	pub(crate) fn message(self) -> &'static str {
		match self {
			Self::RepetitionOperandMissing => "repetition-operator operand invalid",
			Self::UnmatchedBracket | Self::InvalidClassName | Self::InvalidCollation => {
				"invalid character class, equivalence class, or collating element"
			},
			Self::InvalidCharacterRange => "invalid character range",
			_ => self.gnu_message(),
		}
	}

	/// glibc's `regerror` text for this condition, which GNU grep prints.
	pub(crate) fn gnu_message(self) -> &'static str {
		match self {
			Self::RepetitionOperandMissing => "Invalid preceding regular expression",
			Self::UnmatchedBracket => "Unmatched [, [^, [:, [., or [=",
			Self::BracketAtEnd => "Invalid regular expression",
			Self::InvalidClassName => "Invalid character class name",
			Self::InvalidCollation => "Invalid collation character",
			Self::InvalidCharacterRange => "Invalid range end",
			Self::UnmatchedParen => r"Unmatched ( or \(",
			Self::UnmatchedCloseParen => r"Unmatched ) or \)",
			Self::UnmatchedBrace => r"Unmatched \{",
			Self::InvalidInterval => r"Invalid content of \{\}",
			Self::IntervalTooBig => "Regular expression too big",
			Self::TrailingBackslash => "Trailing backslash",
			Self::InvalidBackReference => "Invalid back reference",
		}
	}
}

/// Convert a primitive BRE pattern to a safe ERE-compatible pattern string.
/// - Replaces `\(`, `\)`, `\?`, `\+`, `\|`, `\{` and `\}` with `(`, `)`, `?`,
///   `+`, `|`, `{` and `}`.
/// - Puts single-digit back-references in non-capturing groups.
/// - Escapes ERE-only metacharacters: `+ ? { } | ( )`.
/// - Translates POSIX bracket expressions.
///
/// A repetition character with **no preceding atom** is emitted as a literal,
/// per POSIX: "an asterisk that is the first character of an RE ... shall lose
/// its special meaning". The same applies directly after `^`, `\(` or `\|`.
/// This matters because the target engines accept `^+` and compile it as
/// `(?:^)+`, which matches the empty string at every line start - so a pattern
/// meant to find a few lines silently matches all of them.
///
/// Malformed patterns are refused with glibc's error, as GNU grep and sed do:
/// unbalanced `\(`/`\)`, an unclosed or malformed `\{…\}`, a back-reference
/// to a group not yet closed, a trailing `\`, and bad bracket expressions.
pub(crate) fn bre_to_ere(pattern: &str, backrefs: Backrefs) -> Result<String, BreError> {
	let mut result = String::with_capacity(pattern.len());
	let mut chars = pattern.chars().peekable();
	// Numbers of the groups still open, how many were opened, and a bit per
	// closed group `\1`-`\9` may name.
	let mut open_groups = Vec::new();
	let mut groups = 0u32;
	let mut closed_groups = 0u16;

	// Whether something repeatable precedes the current position. False at the
	// start of the pattern and directly after `\(` or `\|`, which are exactly
	// the positions where a repetition character is not an operator and where
	// `^` IS an anchor. One piece of state answers both questions.
	let mut has_atom = false;
	// Whether a branch-start `^` has already been consumed as an anchor. Only
	// the FIRST caret of a branch anchors: measured, `grep -c '^^'` counts
	// lines beginning with a literal caret and `sed 's/^^/X/'` rewrites only
	// those, so a second caret is an ordinary character. Keyed off `has_atom`
	// alone, both carets became zero-width anchors and every line matched.
	let mut anchored = false;
	while let Some(c) = chars.next() {
		if c == '\\' {
			match chars.peek() {
				Some('(') => {
					chars.next();
					result.push('('); // Group start
					groups += 1;
					open_groups.push(groups);
					has_atom = false;
					anchored = false;
				},
				Some(')') => {
					chars.next();
					let group = open_groups.pop().ok_or(BreError::UnmatchedCloseParen)?;
					if group <= 9 {
						closed_groups |= 1 << group;
					}
					result.push(')'); // Group end
					has_atom = true;
				},
				Some('?') => {
					chars.next();
					if has_atom {
						result.push('?'); // Quantifier 0 or 1
					} else {
						result.push_str(r"\?"); // Nothing to repeat: literal
						has_atom = true;
					}
				},
				Some('+') => {
					chars.next();
					if has_atom {
						result.push('+'); // Quantifier 1 or more
					} else {
						result.push_str(r"\+"); // Nothing to repeat: literal
						has_atom = true;
					}
				},
				Some('|') => {
					chars.next();
					result.push('|'); // Alternation operator
					has_atom = false;
					anchored = false;
				},
				Some('{') => {
					chars.next();
					// A brace quantifier with nothing to repeat is an ERROR in
					// both tools, not a literal brace: measured,
					// `grep '\{1,4\}'` and `sed 's/\{1,3\}/X/'` each report
					// "repetition-operator operand invalid".
					//
					// It cannot simply be emitted as an operator and left to
					// the engine. `^\{1,4\}` becomes `^{1,4}`, which BOTH
					// engines accept as `(?:^){1,4}` - matching the empty
					// string at every line start, so the pattern silently
					// selects every line with a success exit status. That is
					// the same fail-open this module exists to close, and it
					// has to be refused here because no later layer sees it.
					if !has_atom {
						return Err(BreError::RepetitionOperandMissing);
					}
					push_bre_interval(&mut result, &mut chars)?;
				},
				Some('}') => {
					// Closes no interval: an ordinary brace.
					chars.next();
					result.push_str(r"\}");
					has_atom = true;
				},
				Some(v) if v.is_ascii_digit() => {
					// Back-reference.  In sed BREs these are single-digit
					// (\1-\9) whereas fancy_regex supports multi-digit
					// back-references. Put them in a non-capturing group
					// to avoid having the number extend beyond the single
					// digit. Example: In sed \11 matches group 1 followed
					// by '1', not group 11.
					let v = *v;
					chars.next();
					if let Some(group @ 1..=9) = v.to_digit(10)
						&& closed_groups & (1 << group) == 0
					{
						return Err(BreError::InvalidBackReference);
					}
					match backrefs {
						Backrefs::Supported => result.push_str(&format!(r"(?:\{v})")),
						Backrefs::Unsupported => {
							result.push('\\');
							result.push(v);
						},
					}
					has_atom = true;
				},
				Some(&next) => {
					// Preserve other escaped characters.
					chars.next();
					result.push('\\');
					result.push(next);
					has_atom = true;
				},
				None => return Err(BreError::TrailingBackslash),
			}
		} else {
			match c {
				'[' => {
					push_bracket_expression(&mut result, &mut chars)?;
					has_atom = true;
				},
				'+' | '?' | '{' | '}' | '|' | '(' | ')' => {
					// Escape unsupported ERE metacharacters.
					result.push('\\');
					result.push(c);
					has_atom = true;
				},
				'*' => {
					if has_atom {
						result.push('*'); // Quantifier 0 or more
					} else {
						result.push_str(r"\*"); // Nothing to repeat: literal
						has_atom = true;
					}
				},
				'^' if has_atom || anchored => {
					// In a BRE `^` is an ANCHOR only at the start of a branch -
					// the start of the pattern, or directly after `\(` or `\|` -
					// and only ONCE there. Anywhere else, including a second
					// caret at the same branch start, it is a literal.
					//
					// Measured: `grep '\(^alpha\)'` matches on GNU and BSD grep,
					// so start-of-pattern is the wrong test; and `grep -c '^^'`
					// counts lines beginning with a caret while
					// `sed 's/^^/X/'` rewrites only those, so the second caret
					// is not a second anchor.
					//
					// Escaping the literal uses is valid in an ERE:
					// "the ERE "a^b" is valid, but can never match because
					// the 'a' prevents the expression "^b" from matching
					// starting at the first character."
					// POSIX 9.4.9 ERE Expression Anchoring
					result.push('\\');
					result.push(c);
					has_atom = true;
				},
				'$' if !ends_branch(&chars) => {
					// Similarly for `$` appearing not at the end of a branch.
					result.push('\\');
					result.push(c);
					has_atom = true;
				},
				// A branch-start anchor. It is not an atom, so `^*` still sees
				// no operand, but it is consumed: the next caret is a literal.
				'^' => {
					result.push(c);
					anchored = true;
				},
				'$' => result.push(c),
				_ => {
					result.push(c);
					has_atom = true;
				},
			}
		}
	}

	if !open_groups.is_empty() {
		return Err(BreError::UnmatchedParen);
	}
	Ok(result)
}

/// Append a BRE interval as an ERE `{min,max}`; the `\{` is already consumed.
/// Content runs to the first `\}`: glibc reports a missing `\}` as unmatched
/// and anything but `n`, `n,`, `,m` or `n,m` (with `n <= m`) as invalid.
fn push_bre_interval(result: &mut String, chars: &mut Peekable<Chars<'_>>) -> Result<(), BreError> {
	let mut content = String::new();
	loop {
		match chars.next() {
			None => return Err(BreError::UnmatchedBrace),
			Some('\\') if chars.peek() == Some(&'}') => {
				chars.next();
				break;
			},
			Some(c) => content.push(c),
		}
	}
	let (min, max) = match content.split_once(',') {
		Some((min, max)) => (min, Some(max)),
		None => (content.as_str(), None),
	};
	let bound = |text: &str| -> Result<Option<u32>, BreError> {
		if text.is_empty() {
			return Ok(None);
		}
		if !text.bytes().all(|b| b.is_ascii_digit()) {
			return Err(BreError::InvalidInterval);
		}
		let value = text.parse::<u32>().unwrap_or(u32::MAX);
		if value > DUP_MAX { Err(BreError::IntervalTooBig) } else { Ok(Some(value)) }
	};
	let low = bound(min)?;
	let high = match max {
		Some(max) => bound(max)?,
		None if low.is_none() => return Err(BreError::InvalidInterval),
		None => low,
	};
	if let (Some(low), Some(high)) = (low, high)
		&& low > high
	{
		return Err(BreError::InvalidInterval);
	}
	let low = low.unwrap_or(0);
	match (max, high) {
		(None, _) => result.push_str(&format!("{{{low}}}")),
		(Some(_), None) => result.push_str(&format!("{{{low},}}")),
		(Some(_), Some(high)) => result.push_str(&format!("{{{low},{high}}}")),
	}
	Ok(())
}

/// glibc's largest interval bound, `RE_DUP_MAX`.
const DUP_MAX: u32 = 0x7fff;

/// Whether the rest of the pattern ends the current branch.
///
/// `$` is an anchor at the end of a branch, not only at the end of the whole
/// pattern: `grep 'a$\|b'` selects lines ending in `a` as well as lines
/// containing `b`, and the alternation normalization this module replaced
/// preserved that by leaving `$` untouched. Escaping it here made the first
/// branch unmatchable and silently dropped those lines.
///
/// BSD grep differs - it anchors only at the very end of the pattern - but
/// `\|` is itself a GNU extension, so GNU decides its semantics.
fn ends_branch(chars: &Peekable<Chars<'_>>) -> bool {
	let mut rest = chars.clone();
	match rest.next() {
		None => true,
		Some('\\') => matches!(rest.next(), Some('|' | ')')),
		Some(_) => false,
	}
}

/// Append one POSIX bracket expression. The opening `[` is already consumed.
/// An unterminated bracket is refused with glibc's error.
fn push_bracket_expression(result: &mut String, chars: &mut Peekable<Chars<'_>>) -> Result<(), BreError> {
	let mut probe = chars.clone();
	let start = result.len();
	result.push('[');
	if probe.next_if_eq(&'^').is_some() {
		result.push('^');
	}
	let leading_close = probe.next_if_eq(&']').is_some();
	if leading_close {
		result.push_str(r"\]");
	}

	let mut first = !leading_close;
	let mut endpoint = leading_close;
	let mut in_range = false;
	// The last element that can start a range, to reject `[z-a]`.
	let mut range_from = leading_close.then_some(']');
	let mut any = leading_close;
	while let Some(c) = probe.next() {
		any = true;
		if c == ']' {
			result.push(c);
			*chars = probe;
			return Ok(());
		}
		if c == '-' && !first && !in_range && probe.peek().is_some_and(|&next| next != ']') {
			if !endpoint {
				return Err(BreError::InvalidCharacterRange);
			}
			result.push('-');
			in_range = true;
			continue;
		}
		let range_eligible = if c == '[' && matches!(probe.peek(), Some(':' | '.' | '=')) {
			let marker = probe.next().unwrap();
			let body_start = result.len();
			result.push('[');
			result.push(marker);
			loop {
				let next = probe.next().ok_or(BreError::UnmatchedBracket)?;
				if next == marker && probe.next_if_eq(&']').is_some() {
					break;
				}
				result.push(next);
			}
			if marker == ':' {
				// Rust recognizes the POSIX names, but silently falls back
				// to a nested set for unknown names instead of diagnosing them.
				if !matches!(
					&result[body_start + 2..],
					"alnum" | "alpha" | "blank" | "cntrl" | "digit" | "graph" | "lower"
						| "print" | "punct" | "space" | "upper" | "xdigit"
				) {
					return Err(BreError::InvalidClassName);
				}
				result.push_str(":]");
				None
			} else {
				// In the default byte-order collation, a single character is
				// its own collating symbol/equivalence class. Do not hand
				// locale-specific multi-character elements to Rust as sets.
				let mut body = result[body_start + 2..].chars();
				let symbol = body.next().ok_or(BreError::InvalidCollation)?;
				if body.next().is_some() {
					return Err(BreError::InvalidCollation);
				}
				result.truncate(body_start);
				push_class_literal(result, symbol);
				(marker == '.').then_some(symbol)
			}
		} else {
			push_class_literal(result, c);
			Some(c)
		};
		if in_range {
			match (range_from, range_eligible) {
				(Some(from), Some(to)) if from > to => return Err(BreError::InvalidCharacterRange),
				(_, None) => return Err(BreError::InvalidCharacterRange),
				_ => {},
			}
		}
		endpoint = range_eligible.is_some() && !in_range;
		range_from = range_eligible;
		in_range = false;
		first = false;
	}

	result.truncate(start);
	// glibc: a `[` or `[^` that ends the pattern is malformed; any other
	// unclosed bracket is unmatched.
	Err(if any { BreError::UnmatchedBracket } else { BreError::BracketAtEnd })
}

fn push_class_literal(result: &mut String, c: char) {
	// Escape Rust's nested classes and set operators, as well as single
	// backslashes and brackets that POSIX treats as ordinary characters.
	if matches!(c, '[' | ']' | '\\' | '-' | '&' | '~' | '^') {
		result.push('\\');
	}
	result.push(c);
}

/// Translate bracket expressions in an ERE. Grep additionally reads a
/// non-interval `{` and an unopened `)` as literals, and rejects repetition
/// without an operand and the other patterns glibc refuses.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
pub(crate) fn ere_to_rust(pattern: &str, grep: bool) -> Result<Cow<'_, str>, BreError> {
	if !grep && !pattern.contains('[') {
		return Ok(Cow::Borrowed(pattern));
	}

	let mut result = String::with_capacity(pattern.len());
	let mut chars = pattern.chars().peekable();
	let mut has_atom = false;
	// Grep only: numbers of the groups still open, the count opened so far,
	// and a bit per closed group `\1`-`\9` may name.
	let mut open_groups = Vec::new();
	let mut groups = 0u32;
	let mut closed_groups = 0u16;
	while let Some(c) = chars.next() {
		match c {
			'\\' => {
				result.push(c);
				match chars.next() {
					Some(next) => {
						if grep
							&& let Some(group @ 1..=9) = next.to_digit(10)
							&& closed_groups & (1 << group) == 0
						{
							return Err(BreError::InvalidBackReference);
						}
						result.push(next);
					},
					None if grep => return Err(BreError::TrailingBackslash),
					None => {},
				}
				has_atom = true;
				continue;
			},
			'[' => {
				push_bracket_expression(&mut result, &mut chars)?;
				has_atom = true;
				continue;
			},
			'(' if grep => {
				groups += 1;
				open_groups.push(groups);
				has_atom = false;
			},
			')' if grep => {
				match open_groups.pop() {
					Some(group) if group <= 9 => closed_groups |= 1 << group,
					Some(_) => {},
					// GNU grep reads a `)` that closes no group as a literal.
					None => result.push('\\'),
				}
				has_atom = true;
			},
			'(' | '|' | '^' | '$' => has_atom = false,
			'*' | '+' | '?' if grep && !has_atom => {
				return Err(BreError::RepetitionOperandMissing);
			},
			'{' if grep => match classify_brace(chars.clone()) {
				Brace::Interval | Brace::Invalid(BreError::IntervalTooBig) if !has_atom => {
					return Err(BreError::RepetitionOperandMissing);
				},
				// The engine needs the lower bound glibc leaves implicit.
				Brace::Interval if chars.peek() == Some(&',') => {
					result.push_str("{0");
					continue;
				},
				Brace::Interval => {},
				Brace::Invalid(error) if has_atom => return Err(error),
				// glibc reads a brace with nothing to repeat as a literal.
				Brace::Literal | Brace::Invalid(_) => {
					result.push('\\');
					has_atom = true;
				},
			},
			_ => has_atom = true,
		}
		result.push(c);
	}
	if !open_groups.is_empty() {
		return Err(BreError::UnmatchedParen);
	}

	Ok(if result == pattern { Cow::Borrowed(pattern) } else { Cow::Owned(result) })
}

/// How GNU grep reads an ERE `{`.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
enum Brace {
	/// `{n}`, `{n,}`, `{,m}`, `{n,m}` or `{,}`: a repetition.
	Interval,
	/// Never closed, or not numeric: an ordinary character.
	Literal,
	/// Closed but malformed: `{}`, `n > m`, or a bound above 32767.
	Invalid(BreError),
}

/// Classifies the text just past a `{` the way glibc's `parse_dup_op` does,
/// bounds clamped just above `RE_DUP_MAX` as glibc clamps them.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
fn classify_brace(mut chars: Peekable<Chars<'_>>) -> Brace {
	let number = |chars: &mut Peekable<Chars<'_>>| {
		let mut value = None;
		while let Some(digit) = chars.peek().and_then(|c| c.to_digit(10)) {
			chars.next();
			value = Some((value.unwrap_or(0) * 10 + digit).min(DUP_MAX + 1));
		}
		value
	};
	let min = number(&mut chars);
	let max = match chars.next() {
		Some('}') if min.is_some() => min,
		Some('}') => return Brace::Invalid(BreError::InvalidInterval),
		Some(',') => {
			let max = number(&mut chars);
			if chars.next() != Some('}') {
				return Brace::Literal;
			}
			max
		},
		_ => return Brace::Literal,
	};
	let min = min.unwrap_or(0);
	if max.is_some_and(|max| min > max) {
		Brace::Invalid(BreError::InvalidInterval)
	} else if max.unwrap_or(min) > DUP_MAX {
		Brace::Invalid(BreError::IntervalTooBig)
	} else {
		Brace::Interval
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn ere(pattern: &str) -> String {
		bre_to_ere(pattern, Backrefs::Supported).expect("translatable")
	}

	fn ere_err(pattern: &str) -> Option<BreError> {
		bre_to_ere(pattern, Backrefs::Supported).err()
	}

	// Relocated from `sed`, which owned this translation before `grep` shared it.

	#[test]
	fn test_bre_group_translation() {
		assert_eq!(ere(r"\(a\?b\+c\|\)"), "(a?b+c|)");
		assert_eq!(ere(r"a\(b\)c"), "a(b)c");
	}

	#[test]
	fn test_bre_brace_quantifier_translation() {
		assert_eq!(ere(r"a\{1,4\}"), "a{1,4}");
		assert_eq!(ere(r"\(a\)\{1,4\}"), "(a){1,4}");
	}

	#[test]
	fn test_ere_metacharacters_escaped() {
		assert_eq!(ere(r"a+b?c{1}|(d)"), r"a\+b\?c\{1\}\|\(d\)");
	}

	#[test]
	fn test_literal_backslashes_preserved() {
		assert_eq!(ere(r"foo\\bar"), r"foo\\bar");
		assert_eq!(ere(r"\."), r"\.");
	}

	#[test]
	fn posix_brackets_match_their_members_in_both_dialects() {
		for (pattern, input, expected) in [
			(r"[][\.^$*+?(){}|\\]", r"a.b[c]\^$*+?(){}|", r".[]\^$*+?(){}|"),
			(r"[.^$*+?()[{|\\]", r"a.b[c]\^$*+?(){|", r".[\^$*+?(){|"),
			("[.[]", "a[b", "["),
			("[]abc]", "a]zb[c", "a]bc"),
			("[^]abc]", "a]zb[c", "z["),
			("[a-z]", "am-0z", "amz"),
			("[^0-9]", "am-0z", "am-z"),
			("[a-]", "a-_b", "a-"),
			("[[:alpha:]-]", "A-z1_", "A-z"),
			(r"[\\]", r"\n.]", r"\"),
			(r"[\]", r"\n.]", r"\"),
			(r"[\n]", r"\n.", r"\n"),
			("[--0]", "-./01", "-./0"),
			("[---]", "-./01", "-"),
			("[&&~~]", "a&~b", "&~"),
			("[[.].][.[.][=x=]]", "[]y.x", "[]x"),
		] {
			let check = |translated: &str| {
				let re = regex::Regex::new(translated).unwrap_or_else(|err| panic!("{pattern}: {err}"));
				let actual: String = re.find_iter(input).map(|m| m.as_str()).collect();
				assert_eq!(actual, expected, "{pattern} → {translated}");
			};
			check(&ere(pattern));
			#[cfg(any(feature = "util.grep", feature = "util.sed"))]
			check(&ere_to_rust(pattern, false).unwrap());
		}
	}

	#[test]
	fn test_anchors_and_dot_and_star() {
		assert_eq!(ere(r"^a.*b$"), "^a.*b$");
	}

	#[test]
	fn test_trailing_backslash_is_an_error() {
		assert_eq!(ere_err(r"abc\"), Some(BreError::TrailingBackslash));
	}

	#[test]
	fn test_caret_escaped_in_middle() {
		assert_eq!(ere(r"^a^[^x]c"), r"^a\^[^x]c");
	}

	#[test]
	fn test_dollar_escaped_in_middle() {
		assert_eq!(ere(r"a$c$"), r"a\$c$");
	}

	#[test]
	fn test_bre_back_reference() {
		assert_eq!(ere(r"\(.\)\1\(.\)\2"), r"(.)(?:\1)(.)(?:\2)");
	}

	#[test]
	fn back_references_pass_through_when_the_engine_does_not() {
		// THE FALLBACK CONTRACT, stated because `grep` depends on it.
		//
		// `grep-regex` cannot compile a back-reference at all. Rather than
		// inventing a translation, the sequence is emitted unchanged, so the
		// pattern fails to compile and `grep`'s `build_default_matcher`
		// escapes it and matches it LITERALLY - which is exactly what
		// happened before this module existed. The behaviour is unchanged by
		// the refactor; it is not an endorsement of matching `\1` literally.
		assert_eq!(
			bre_to_ere(r"\(a\)\1", Backrefs::Unsupported).expect("translatable"),
			r"(a)\1"
		);
		// The grouping exists only for engines that support them, where a
		// bare `\11` would otherwise read as group 11 instead of group 1
		// followed by a literal '1'.
		assert_eq!(ere(r"\(a\)\11"), r"(a)(?:\1)1");
	}

	// ── Repetition operators with no preceding atom ──────────────────────────
	// POSIX BRE: a repetition character with nothing to repeat is a LITERAL.
	// Emitting it as an operator lets the Rust engine compile `^+` as `(?:^)+`,
	// which matches the empty string at every line start - so the pattern
	// silently matches EVERY line instead of the intended few.

	#[test]
	fn escaped_plus_at_pattern_start_is_a_literal() {
		assert_eq!(ere(r"\+"), r"\+");
	}

	#[test]
	fn escaped_plus_after_anchor_is_a_literal() {
		assert_eq!(ere(r"^\+"), r"^\+");
	}

	#[test]
	fn escaped_question_after_anchor_is_a_literal() {
		assert_eq!(ere(r"^\?"), r"^\?");
	}

	#[test]
	fn escaped_brace_quantifier_with_no_operand_is_rejected() {
		// Neither a literal nor an operator: an ERROR, which is what both
		// tools do. Emitting the operator and leaving it to the engine was
		// measurably wrong - `^{2}` and `^{1,4}` COMPILE as `(?:^){2}`, which
		// matches at every line start, so the pattern silently selected the
		// whole file with exit 0.
		assert_eq!(ere_err(r"^\{2\}"), Some(BreError::RepetitionOperandMissing));
		assert_eq!(ere_err(r"\{1,4\}"), Some(BreError::RepetitionOperandMissing));
		assert_eq!(ere_err(r"\(\{2\}\)"), Some(BreError::RepetitionOperandMissing));
		assert_eq!(ere_err(r"a\|\{2\}"), Some(BreError::RepetitionOperandMissing));
		// With an operand it is an ordinary quantifier.
		assert_eq!(ere_err(r"a\{2\}"), None);
	}

	#[test]
	fn caret_is_an_anchor_after_group_open_and_alternation() {
		// Measured: `grep '\(^alpha\)'` matches on GNU and BSD grep. Keying
		// this off "start of pattern" escaped the anchor and matched nothing.
		assert_eq!(ere(r"\(^a\)"), r"(^a)");
		assert_eq!(ere(r"a\|^b"), r"a|^b");
		assert_eq!(ere(r"\(^a\|^b\)"), r"(^a|^b)");
		// Still a literal where an atom precedes it.
		assert_eq!(ere(r"a^b"), r"a\^b");
		assert_eq!(ere(r"^a^"), r"^a\^");
	}

	#[test]
	fn bare_star_at_pattern_start_is_a_literal() {
		assert_eq!(ere(r"*x"), r"\*x");
	}

	#[test]
	fn bare_star_after_anchor_is_a_literal() {
		assert_eq!(ere(r"^*"), r"^\*");
	}

	#[test]
	fn repetition_after_group_open_is_a_literal() {
		assert_eq!(ere(r"\(\+a\)"), r"(\+a)");
		assert_eq!(ere(r"\(*a\)"), r"(\*a)");
	}

	#[test]
	fn repetition_after_alternation_is_a_literal() {
		assert_eq!(ere(r"a\|\+b"), r"a|\+b");
	}

	// The operator cases these must not break.

	#[test]
	fn repetition_with_an_operand_stays_an_operator() {
		assert_eq!(ere(r"a\+"), r"a+");
		assert_eq!(ere(r"a\?"), r"a?");
		assert_eq!(ere(r"a\{2\}"), r"a{2}");
		assert_eq!(ere(r"a*"), r"a*");
		assert_eq!(ere(r"^a\+"), r"^a+");
		assert_eq!(ere(r"\(a\)\+"), r"(a)+");
		assert_eq!(ere(r"[a-z]\+"), r"[a-z]+");
		assert_eq!(ere(r".\+"), r".+");
	}

	// ── ERE operand validation ───────────────────────────────────────────────

	#[cfg(feature = "util.grep")]
	#[test]
	fn ere_rejects_repetition_with_no_operand() {
		for pattern in ["^+", "^*", "^?", "^{2}", "*x", "+", "(+)", "a|+b", "(|+)"] {
			assert_eq!(ere_to_rust(pattern, true), Err(BreError::RepetitionOperandMissing), "{pattern}");
		}
	}

	#[cfg(feature = "util.grep")]
	#[test]
	fn ere_accepts_repetition_with_an_operand() {
		for pattern in [
			"a+",
			"^a+",
			"a{2}",
			"[a-z]+",
			".*",
			r"\++",     // an escaped plus is a literal, so it IS an operand
			"[^x]*",    // negated class, not an anchor
			"[]]*",     // `]` first in a class is a literal
			"[^]]*",    // and after a negation too
			"(a)+",
			"a|b+",
			"$",
			r"\\",
			// A `{` that opens no interval is a LITERAL, not an operator.
			// Measured: `grep -E '^{'` and `grep -E '{a}'` match nothing and
			// report no error, while `grep -E '{1}'` IS invalid. Rejecting
			// every `{` refused patterns the real tool accepts.
			"^{",
			"{",
			"{a}",
			"^{}",
			"{1a}",
		] {
			assert!(ere_to_rust(pattern, true).is_ok(), "should accept {pattern}");
		}
	}

	#[cfg(feature = "util.grep")]
	#[test]
	fn ere_rejects_only_intervals_that_really_open() {
		for pattern in ["{1}", "^{2}", "{3,}", "{4,5}", "(|{6})", "{,5}"] {
			assert_eq!(ere_to_rust(pattern, true), Err(BreError::RepetitionOperandMissing), "{pattern}");
		}
	}
}
