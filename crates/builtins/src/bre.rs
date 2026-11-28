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

/// Whether a `*` or `\{…\}` may follow another repetition (`a**`, `a\+*`).
///
/// GNU sed refuses it ("Invalid preceding regular expression"); GNU grep and
/// `nl` accept it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code, reason = "each variant is used by a different utility feature")]
pub(crate) enum StackedRepeats {
	Allowed,
	Refused,
}

/// How a bracket range reads where case does not matter. glibc checks the
/// range against the upper case of its ends, in the locale's rules, and
/// refuses one whose upper-cased ends run backwards: `[Z-a]`, and in a UTF-8
/// locale `[Z-ı]`, whose `ı` upper-cases to `I`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code, reason = "each variant is used by a different utility feature")]
pub(crate) enum RangeCase {
	/// Case matters: a range runs between its ends as written.
	Exact,
	/// glibc's reading in a UTF-8 locale, GNU grep's `-i` and GNU sed's `I`
	/// there: a character is in the range where its upper case runs between
	/// the upper-cased ends, so `[a-Z]` holds `b`, and `[A-z]` and `[Z-~]` hold
	/// no `_` and no `a`.
	Folded,
	/// GNU grep's `-i` in the C locale, and GNU sed's `I` there on an address
	/// with `M`, where GNU's dfa alone reads a range, as written, in a bracket
	/// that holds no equivalence class and no collating symbol: `[A-z]` holds
	/// `_`, and `[a-Z]` holds nothing.
	Written,
	/// GNU sed's `I` in the C locale. A range reads as written, as under
	/// `Written`, unless its list holds one that runs backwards. Such a list
	/// reads whole, by GNU's dfa as written with both cases of each letter,
	/// and by glibc with each range read by its upper-cased ends: a plain
	/// list holds what both readings hold, so `[@-aa-Z]` holds no `_`, and a
	/// negated one leaves out what either holds, so `[^a-Z]` holds no letter.
	/// A list that holds such a range and a member outside ASCII is refused.
	Filtered,
	/// glibc's reading in the C locale: as `Folded`, in ASCII's case rules.
	/// GNU's dfa leaves a bracket that holds an equivalence class or a
	/// collating symbol to glibc, so under `Written` and `Filtered` such a
	/// bracket reads so: `[[=a=]a-Z]` holds `b`, and `[[=a=]A-z]` no `_`.
	FoldedAscii,
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
	/// A `)` (sed's ERE) or `\)` (BRE) that closes no group.
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
	/// The BSD wording `nl` prints; conditions only the ERE validation raises
	/// have no BSD form and use glibc's.
	#[cfg_attr(not(feature = "util.nl"), allow(dead_code, reason = "only nl prints the BSD wording"))]
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
/// `case` says how a bracket range reads ([`RangeCase`]).
pub(crate) fn bre_to_ere(
	pattern: &str,
	backrefs: Backrefs,
	stacked: StackedRepeats,
	case: RangeCase,
) -> Result<String, BreError> {
	let mut result = String::with_capacity(pattern.len());
	let mut chars = pattern.chars().peekable();
	// Numbers of the groups still open, how many were opened, and a bit per
	// closed group `\1`-`\9` may name.
	let mut open_groups = Vec::new();
	let mut groups = 0u32;
	let mut closed_groups = 0u16;
	// Where each open group starts in `result`, and where the last repeatable
	// piece starts: a quantifier stacked on another wraps that piece.
	let mut group_starts = Vec::new();
	let mut piece_start = 0usize;

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
	// Whether the previous token was a repetition operator, for `stacked`.
	let mut after_repeat = false;
	while let Some(c) = chars.next() {
		let token_start = result.len();
		let was_repeat = after_repeat;
		let stacking = was_repeat && stacked == StackedRepeats::Refused;
		after_repeat = false;
		// Set by tokens that are not atoms of their own: anchors, and a group
		// end, whose piece starts at its `(`.
		let mut not_atom = false;
		if c == '\\' {
			match chars.peek() {
				Some('(') => {
					chars.next();
					group_starts.push(result.len());
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
					piece_start = group_starts.pop().unwrap_or(token_start);
					not_atom = true;
					has_atom = true;
				},
				Some('?') => {
					chars.next();
					if has_atom {
						group_stacked(&mut result, piece_start, was_repeat);
						result.push('?'); // Quantifier 0 or 1
						after_repeat = true;
					} else {
						result.push_str(r"\?"); // Nothing to repeat: literal
						has_atom = true;
					}
				},
				Some('+') => {
					chars.next();
					if has_atom {
						group_stacked(&mut result, piece_start, was_repeat);
						result.push('+'); // Quantifier 1 or more
						after_repeat = true;
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
					if !has_atom || stacking {
						return Err(BreError::RepetitionOperandMissing);
					}
					group_stacked(&mut result, piece_start, was_repeat);
					push_bre_interval(&mut result, &mut chars)?;
					after_repeat = true;
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
					push_bracket_expression(&mut result, &mut chars, case)?;
					has_atom = true;
				},
				'+' | '?' | '{' | '}' | '|' | '(' | ')' => {
					// Escape unsupported ERE metacharacters.
					result.push('\\');
					result.push(c);
					has_atom = true;
				},
				'*' => {
					if stacking {
						return Err(BreError::RepetitionOperandMissing);
					}
					if has_atom {
						group_stacked(&mut result, piece_start, was_repeat);
						result.push('*'); // Quantifier 0 or more
						after_repeat = true;
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
					not_atom = true;
				},
				'$' => {
					result.push(c);
					not_atom = true;
				},
				_ => {
					result.push(c);
					has_atom = true;
				},
			}
		}
		if has_atom && !after_repeat && !not_atom {
			piece_start = token_start;
		}
	}

	if !open_groups.is_empty() {
		return Err(BreError::UnmatchedParen);
	}
	Ok(result)
}

/// Wraps the piece at `start` in a non-capturing group when the quantifier
/// about to follow is `stacked` on another: POSIX reads `a*\?` as `(a*)?`,
/// while the target engines read `a*?` as a lazy star.
fn group_stacked(result: &mut String, start: usize, stacked: bool) {
	if stacked {
		result.insert_str(start, "(?:");
		result.push(')');
	}
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

/// Append one POSIX bracket expression, its ranges as `case` reads them. The
/// opening `[` is already consumed. An unterminated bracket is refused with
/// glibc's error.
fn push_bracket_expression(
	result: &mut String,
	chars: &mut Peekable<Chars<'_>>,
	case: RangeCase,
) -> Result<(), BreError> {
	let mut probe = chars.clone();
	let start = result.len();
	result.push('[');
	let negated = probe.next_if_eq(&'^').is_some();
	if negated {
		result.push('^');
	}
	// GNU's dfa leaves a bracket that holds an equivalence class or a
	// collating symbol to glibc.
	let case = match case {
		RangeCase::Written | RangeCase::Filtered if holds_collating_element(probe.clone()) => {
			RangeCase::FoldedAscii
		},
		_ => case,
	};
	let mut filtered = (case == RangeCase::Filtered).then(FilteredList::default);
	// Where the members start.
	let members = result.len();
	let leading_close = probe.next_if_eq(&']').is_some();
	if leading_close {
		result.push_str(r"\]");
		if let Some(list) = &mut filtered {
			list.member(']');
		}
	}

	let mut first = !leading_close;
	let mut endpoint = leading_close;
	let mut in_range = false;
	// The last element that can start a range, to reject `[z-a]`, and where
	// it was written.
	let mut range_from = leading_close.then_some(']');
	let mut from_at = members;
	let mut any = leading_close;
	while let Some(c) = probe.next() {
		any = true;
		if c == ']' {
			// Under `Filtered`, a list that holds a range that runs backwards
			// is written whole as its ASCII members, so one that also holds a
			// member outside ASCII is refused.
			if let Some(list) = filtered && list.backward {
				if list.outside_ascii {
					return Err(BreError::InvalidCharacterRange);
				}
				let held = list.held(negated);
				result.truncate(members);
				push_ascii_members(result, |c| held & (1 << c) != 0);
			}
			if result.len() == members {
				// The list holds no character: a list of none, or a negated
				// one of every character.
				result.truncate(start);
				result.push_str(if negated { r"[\s\S]" } else { r"[^\s\S]" });
			} else {
				result.push(c);
			}
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
		let member_at = result.len();
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
				if let Some(list) = &mut filtered {
					list.class(&result[body_start + 2..]);
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
				(Some(from), Some(to)) => {
					case.write_range(result, from_at, from, to)?;
					if let Some(list) = &mut filtered {
						list.range(from, to);
					}
				},
				(_, None) => return Err(BreError::InvalidCharacterRange),
				(None, Some(_)) => {},
			}
		} else if let (Some(list), Some(c)) = (&mut filtered, range_eligible) {
			list.member(c);
		}
		endpoint = range_eligible.is_some() && !in_range;
		range_from = range_eligible;
		from_at = member_at;
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

impl RangeCase {
	/// Checks the range `from`-`to`, which `result` holds from `at` on, and
	/// writes it as this reading reads it.
	fn write_range(
		self,
		result: &mut String,
		at: usize,
		from: char,
		to: char,
	) -> Result<(), BreError> {
		if self == Self::Exact {
			return if from > to { Err(BreError::InvalidCharacterRange) } else { Ok(()) };
		}
		let (low, high) = (upper(from, self == Self::Folded), upper(to, self == Self::Folded));
		if low > high {
			return Err(BreError::InvalidCharacterRange);
		}
		let folded = |c: u8| (low..=high).contains(&char::from(c.to_ascii_uppercase()));
		match self {
			Self::Folded | Self::FoldedAscii if low.is_ascii() && high.is_ascii() => {
				result.truncate(at);
				push_ascii_members(result, folded);
			},
			// A range with an end outside ASCII is left to the engine as
			// written; one that runs backwards is refused, as the engine
			// would refuse it.
			Self::Folded if from > to => return Err(BreError::InvalidCharacterRange),
			// Any other range in the C locale reads as written, where one that
			// runs backwards holds nothing; under `Filtered` its list is then
			// written whole at its `]`.
			Self::Written | Self::Filtered | Self::FoldedAscii if from > to => result.truncate(at),
			_ => {},
		}
		Ok(())
	}
}

/// `c`'s upper case in the locale's rules: Unicode's, where that is one
/// character, in a UTF-8 locale (`utf8`), else ASCII's.
fn upper(c: char, utf8: bool) -> char {
	if !utf8 {
		return c.to_ascii_uppercase();
	}
	let mut upper = c.to_uppercase();
	match (upper.next(), upper.next()) {
		(Some(upper), None) => upper,
		_ => c,
	}
}

/// Appends, as members of a bracket expression, the ASCII characters that
/// `held` holds.
fn push_ascii_members(result: &mut String, held: impl Fn(u8) -> bool) {
	let mut c = 0u8;
	while c.is_ascii() {
		if held(c) {
			let first = c;
			while (c + 1).is_ascii() && held(c + 1) {
				c += 1;
			}
			push_class_literal(result, char::from(first));
			if c > first {
				result.push('-');
				push_class_literal(result, char::from(c));
			}
		}
		c += 1;
	}
}

/// Whether the bracket expression that `chars` reads, past its `[` and any
/// `^`, holds an equivalence class or a collating symbol.
fn holds_collating_element(mut chars: Peekable<Chars<'_>>) -> bool {
	chars.next_if_eq(&']');
	while let Some(c) = chars.next() {
		match c {
			']' => return false,
			'[' if chars.next_if(|&marker| marker == '.' || marker == '=').is_some() => return true,
			'[' if chars.next_if_eq(&':').is_some() => {
				// Past the class name, which `:]` closes.
				while let Some(c) = chars.next() {
					if c == ':' && chars.next_if_eq(&']').is_some() {
						break;
					}
				}
			},
			_ => {},
		}
	}
	false
}

/// What a list holds of ASCII under `RangeCase::Filtered`, one bit per
/// character, by the two readings GNU sed's `I` joins in the C locale: GNU's
/// dfa reads a range as written, with both cases of each letter in it, and
/// glibc by its upper-cased ends.
#[derive(Clone, Copy, Default)]
struct FilteredList {
	/// The characters and classes, which both readings hold.
	members: u128,
	/// The last character, a member unless a range starts at it.
	last: u128,
	/// The ranges as the dfa reads them, and as glibc does.
	written: u128,
	ends: u128,
	/// Whether a range runs backwards as written.
	backward: bool,
	/// Whether a member is outside ASCII.
	outside_ascii: bool,
}

impl FilteredList {
	fn member(&mut self, c: char) {
		self.members |= self.last;
		self.last = with_both_cases(|x| char::from(x) == c);
		self.outside_ascii |= !c.is_ascii();
	}

	fn class(&mut self, name: &str) {
		self.members |= self.last | with_both_cases(|x| class_holds(name, x));
		self.last = 0;
	}

	fn range(&mut self, from: char, to: char) {
		self.last = 0;
		self.written |= with_both_cases(|x| (from..=to).contains(&char::from(x)));
		let (low, high) = (from.to_ascii_uppercase(), to.to_ascii_uppercase());
		self.ends |= ascii_set(|x| (low..=high).contains(&char::from(x.to_ascii_uppercase())));
		self.backward |= from > to;
		self.outside_ascii |= !from.is_ascii() || !to.is_ascii();
	}

	/// The ASCII characters the list holds: in a plain list what both readings
	/// hold, and in a negated one what either holds.
	fn held(self, negated: bool) -> u128 {
		let members = self.members | self.last;
		if negated {
			members | self.written | self.ends
		} else {
			members | (self.written & self.ends)
		}
	}
}

/// The ASCII characters that `held` holds, one bit each.
fn ascii_set(held: impl Fn(u8) -> bool) -> u128 {
	(0..0x80u8).filter(|&c| held(c)).fold(0, |set, c| set | (1 << c))
}

/// The ASCII characters that `held` holds in either case.
fn with_both_cases(held: impl Fn(u8) -> bool) -> u128 {
	ascii_set(|c| held(c) || (c.is_ascii_alphabetic() && held(c ^ 0x20)))
}

/// Whether the C locale's class `name` holds the ASCII character `c`.
fn class_holds(name: &str, c: u8) -> bool {
	match name {
		"alnum" => c.is_ascii_alphanumeric(),
		"alpha" => c.is_ascii_alphabetic(),
		"blank" => matches!(c, b' ' | b'\t'),
		"cntrl" => c.is_ascii_control(),
		"digit" => c.is_ascii_digit(),
		"graph" => c.is_ascii_graphic(),
		"lower" => c.is_ascii_lowercase(),
		"print" => c == b' ' || c.is_ascii_graphic(),
		"punct" => c.is_ascii_punctuation(),
		"space" => matches!(c, b'\t'..=b'\r' | b' '),
		"upper" => c.is_ascii_uppercase(),
		"xdigit" => c.is_ascii_hexdigit(),
		_ => false,
	}
}

/// Rewrites `pattern`, a translation of this module or an escaped `-F`
/// string, so that case-insensitive matching in a UTF-8 locale, where `fold`
/// says it runs, holds the dotless `ı` as glibc's does. Its upper-case mapping
/// takes `ı` to `I`, so `ı` is a case of `I` and `i`, which Unicode's simple case
/// folding keeps apart: a list that holds one of them, as a member, in a range
/// or in a class, holds all three. A bracket expression opens at the only `[`
/// the translation leaves unescaped, and an unescaped `-` in it joins a range.
/// `ı` is written outside a list that is not negated, `(?:[Ii]|ı)`, so that
/// sed's single-byte engine, which reads a line that is not UTF-8, takes its
/// two bytes together and never one alone.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
pub(crate) fn fold_dotless_i(pattern: Cow<'_, str>, fold: bool) -> Cow<'_, str> {
	if !fold || !pattern.contains(['[', 'I', 'i', DOTLESS_I]) {
		return pattern;
	}
	let mut written = String::with_capacity(pattern.len() + 8);
	let mut chars = pattern.chars().peekable();
	while let Some(c) = chars.next() {
		match c {
			'\\' => {
				written.push(c);
				written.extend(chars.next());
			},
			'[' => {
				if !push_bracket_folding_dotless_i(&mut written, &mut chars) {
					return pattern;
				}
			},
			'I' | 'i' | DOTLESS_I => written.push_str(CASES_OF_I_APART),
			_ => written.push(c),
		}
	}
	Cow::Owned(written)
}

/// `ı`, which glibc's upper-case mapping takes to `I`.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
const DOTLESS_I: char = '\u{131}';

/// The letters glibc matches with any one of them under case folding.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
const CASES_OF_I: &str = "Ii\u{131}";

/// [`CASES_OF_I`] with `ı` outside the list.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
const CASES_OF_I_APART: &str = "(?:[Ii]|\u{131})";

/// Appends the rest of a translated bracket expression whose `[` `chars` has
/// passed, as [`fold_dotless_i`] reads it, and tells whether a `]` closed it.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
fn push_bracket_folding_dotless_i(written: &mut String, chars: &mut Peekable<Chars<'_>>) -> bool {
	let start = written.len();
	written.push('[');
	let negated = chars.next_if_eq(&'^').is_some();
	if negated {
		written.push('^');
	}
	// Whether the list holds one of `CASES_OF_I`, which then needs them all.
	let mut holds_i = false;
	while let Some(c) = chars.next() {
		let low = match c {
			']' => {
				if !holds_i {
					written.push(c);
				} else if negated {
					written.push_str(CASES_OF_I);
					written.push(c);
				} else {
					written.insert_str(start, "(?:");
					written.push_str("Ii]|\u{131})");
				}
				return true;
			},
			'[' => {
				// A class name, `[:alpha:]`.
				let name_start = written.len();
				written.push(c);
				for c in chars.by_ref() {
					written.push(c);
					if c == ']' {
						break;
					}
				}
				holds_i |= matches!(
					&written[name_start..],
					"[:alnum:]" | "[:alpha:]" | "[:graph:]" | "[:lower:]" | "[:print:]" | "[:upper:]"
				);
				continue;
			},
			'\\' => match chars.next() {
				Some(escaped) => escaped,
				None => return false,
			},
			_ => c,
		};
		if chars.next_if_eq(&'-').is_none() {
			holds_i |= CASES_OF_I.contains(low);
			// A list that is not negated gets `ı` outside it.
			if negated || low != DOTLESS_I {
				push_class_literal(written, low);
			}
			continue;
		}
		let high = match chars.next() {
			Some('\\') => chars.next(),
			high => high,
		};
		let Some(high) = high else {
			return false;
		};
		holds_i |= CASES_OF_I.chars().any(|c| (low..=high).contains(&c));
		push_class_literal(written, low);
		written.push('-');
		push_class_literal(written, high);
	}
	false
}

/// Translate bracket expressions in an ERE, their ranges as `case` reads them
/// ([`RangeCase`]), rejecting repetition without an operand and the other
/// patterns glibc refuses. Both tools read a non-interval `{` as a literal;
/// grep also reads an unopened `)` as one, where sed rejects it.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
pub(crate) fn ere_to_rust(
	pattern: &str,
	grep: bool,
	case: RangeCase,
) -> Result<Cow<'_, str>, BreError> {
	let mut result = String::with_capacity(pattern.len());
	let mut chars = pattern.chars().peekable();
	let mut has_atom = false;
	// Numbers of the groups still open, the count opened so far, and a bit
	// per closed group `\1`-`\9` may name.
	let mut open_groups = Vec::new();
	let mut groups = 0u32;
	let mut closed_groups = 0u16;
	// Where each open group starts in `result`, where the last repeatable
	// piece starts, and whether the previous token was a quantifier: glibc
	// reads `a*?` as `(a*)?`, the target engines as a lazy star.
	let mut group_starts = Vec::new();
	let mut piece_start = 0usize;
	let mut after_repeat = false;
	while let Some(c) = chars.next() {
		let token_start = result.len();
		let was_repeat = std::mem::take(&mut after_repeat);
		match c {
			'\\' => {
				result.push(c);
				match chars.next() {
					Some(next) => {
						if let Some(group @ 1..=9) = next.to_digit(10)
							&& closed_groups & (1 << group) == 0
						{
							return Err(BreError::InvalidBackReference);
						}
						result.push(next);
					},
					None => return Err(BreError::TrailingBackslash),
				}
				has_atom = true;
				piece_start = token_start;
				continue;
			},
			'[' => {
				push_bracket_expression(&mut result, &mut chars, case)?;
				has_atom = true;
				piece_start = token_start;
				continue;
			},
			'(' => {
				groups += 1;
				open_groups.push(groups);
				group_starts.push(token_start);
				has_atom = false;
			},
			')' => {
				match open_groups.pop() {
					Some(group) => {
						if group <= 9 {
							closed_groups |= 1 << group;
						}
						piece_start = group_starts.pop().unwrap_or(token_start);
					},
					// GNU grep reads a `)` that closes no group as a literal.
					None if grep => {
						result.push('\\');
						piece_start = token_start;
					},
					None => return Err(BreError::UnmatchedCloseParen),
				}
				has_atom = true;
			},
			'|' | '^' | '$' => has_atom = false,
			'*' | '+' | '?' if !has_atom => {
				return Err(BreError::RepetitionOperandMissing);
			},
			'*' | '+' | '?' => {
				group_stacked(&mut result, piece_start, was_repeat);
				after_repeat = true;
			},
			'{' => match classify_brace(chars.clone()) {
				Brace::Interval | Brace::Invalid(BreError::IntervalTooBig) if !has_atom => {
					return Err(BreError::RepetitionOperandMissing);
				},
				Brace::Interval => {
					group_stacked(&mut result, piece_start, was_repeat);
					result.push('{');
					// The engine needs the lower bound glibc leaves implicit.
					if chars.peek() == Some(&',') {
						result.push('0');
					}
					for next in chars.by_ref() {
						result.push(next);
						if next == '}' {
							break;
						}
					}
					after_repeat = true;
					continue;
				},
				Brace::Invalid(error) if has_atom => return Err(error),
				// glibc reads a brace with nothing to repeat as a literal.
				Brace::Literal | Brace::Invalid(_) => {
					result.push('\\');
					has_atom = true;
					piece_start = token_start;
				},
			},
			_ => {
				has_atom = true;
				piece_start = token_start;
			},
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
		bre_to_ere(pattern, Backrefs::Supported, StackedRepeats::Allowed, RangeCase::Exact).expect("translatable")
	}

	fn ere_err(pattern: &str) -> Option<BreError> {
		bre_to_ere(pattern, Backrefs::Supported, StackedRepeats::Allowed, RangeCase::Exact).err()
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
			check(&ere_to_rust(pattern, false, RangeCase::Exact).unwrap());
		}
	}

	#[test]
	fn test_anchors_and_dot_and_star() {
		assert_eq!(ere(r"^a.*b$"), "^a.*b$");
	}

	// Failure: `a*\?` became `a*?`, a lazy star that matches the empty string
	// where POSIX's `(a*)?` takes every `a`.
	#[test]
	fn stacked_quantifiers_group_the_piece_before_them() {
		assert_eq!(ere(r"a*\?"), "(?:a*)?");
		assert_eq!(ere("a**"), "(?:a*)*");
		assert_eq!(ere(r"x\(ab\)*\+"), "x(?:(ab)*)+");
		assert_eq!(ere(r"[ab]\{2\}*\?"), "(?:(?:[ab]{2})*)?");
		assert_eq!(ere(r"^**"), r"^\**");
		let sed = |pattern| bre_to_ere(pattern, Backrefs::Supported, StackedRepeats::Refused, RangeCase::Exact);
		assert_eq!(sed(r"a**"), Err(BreError::RepetitionOperandMissing));
		assert_eq!(sed(r"a\?\{2\}"), Err(BreError::RepetitionOperandMissing));
		assert_eq!(sed(r"a*\+").as_deref(), Ok("(?:a*)+"));
	}

	// Failure: the ERE `a*?` reached the engine as a lazy star.
	#[cfg(any(feature = "util.grep", feature = "util.sed"))]
	#[test]
	fn stacked_ere_quantifiers_group_the_piece_before_them() {
		for (pattern, rust) in [("a*?", "(?:a*)?"), ("a+*", "(?:a+)*"), ("(ab)?+", "(?:(ab)?)+"), ("a{2}*", "(?:a{2})*")] {
			assert_eq!(ere_to_rust(pattern, true, RangeCase::Exact).as_deref(), Ok(rust), "{pattern}");
		}
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
			bre_to_ere(r"\(a\)\1", Backrefs::Unsupported, StackedRepeats::Allowed, RangeCase::Exact)
				.expect("translatable"),
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
			assert_eq!(
				ere_to_rust(pattern, true, RangeCase::Exact),
				Err(BreError::RepetitionOperandMissing),
				"{pattern}"
			);
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
			assert!(ere_to_rust(pattern, true, RangeCase::Exact).is_ok(), "should accept {pattern}");
		}
	}

	#[cfg(feature = "util.sed")]
	#[test]
	fn sed_ere_rejects_what_glibc_refuses() {
		// `sed -E 's/a)/x/'` must fail like GNU sed, not match a literal `)`.
		for (pattern, error) in [
			("a)", BreError::UnmatchedCloseParen),
			("(a", BreError::UnmatchedParen),
			("*a", BreError::RepetitionOperandMissing),
			("a|*b", BreError::RepetitionOperandMissing),
			("{1}", BreError::RepetitionOperandMissing),
			(r"(a)\2", BreError::InvalidBackReference),
		] {
			assert_eq!(ere_to_rust(pattern, false, RangeCase::Exact), Err(error), "{pattern}");
		}
		assert!(ere_to_rust("(a)+{1}|b**", false, RangeCase::Exact).is_ok());
	}

	#[cfg(feature = "util.grep")]
	#[test]
	fn ere_rejects_only_intervals_that_really_open() {
		for pattern in ["{1}", "^{2}", "{3,}", "{4,5}", "(|{6})", "{,5}"] {
			assert_eq!(
				ere_to_rust(pattern, true, RangeCase::Exact),
				Err(BreError::RepetitionOperandMissing),
				"{pattern}"
			);
		}
	}
}
