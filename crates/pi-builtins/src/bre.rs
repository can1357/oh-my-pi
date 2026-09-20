//! Shared POSIX basic-regular-expression translation.
//!
//! `grep` and `sed` both accept BREs but compile them with different engines
//! (`grep-regex` and `fancy-regex` respectively), neither of which implements
//! BRE syntax. This module converts a BRE into the ERE-compatible form those
//! engines accept, so the dialect is defined in exactly one place.

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
pub(crate) enum BreError {
	/// A repetition operator with nothing to repeat, where the tools error
	/// rather than treating the character as a literal.
	RepetitionOperandMissing,
}

impl BreError {
	/// The message GNU and BSD grep both use for this condition.
	pub(crate) fn message(self) -> &'static str {
		match self {
			Self::RepetitionOperandMissing => "repetition-operator operand invalid",
		}
	}
}

/// Convert a primitive BRE pattern to a safe ERE-compatible pattern string.
/// - Replaces `\(`, `\)`, `\?`, `\+`, `\|`, `\{` and `\}` with `(`, `)`, `?`,
///   `+`, `|`, `{` and `}`.
/// - Puts single-digit back-references in non-capturing groups..
/// - Escapes ERE-only metacharacters: `+ ? { } | ( )`.
/// - Leaves all other characters as-is.
///
/// A repetition character with **no preceding atom** is emitted as a literal,
/// per POSIX: "an asterisk that is the first character of an RE ... shall lose
/// its special meaning". The same applies directly after `^`, `\(` or `\|`.
/// This matters because the target engines accept `^+` and compile it as
/// `(?:^)+`, which matches the empty string at every line start - so a pattern
/// meant to find a few lines silently matches all of them.
pub(crate) fn bre_to_ere(pattern: &str, backrefs: Backrefs) -> Result<String, BreError> {
	let mut result = String::with_capacity(pattern.len());
	let mut chars = pattern.chars().peekable();

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
					has_atom = false;
					anchored = false;
				},
				Some(')') => {
					chars.next();
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
					result.push('{'); // Brace quantifier start
				},
				Some('}') => {
					chars.next();
					result.push('}'); // Brace quantifier end
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
				None => {
					// Trailing backslash; keep it.
					result.push('\\');
					has_atom = true;
				},
			}
		} else {
			match c {
				'[' => {
					// A bracket expression is NOT BRE syntax: inside it, `\`,
					// `(`, `|` and `*` are ordinary characters. Translating
					// through it turned `[\(]` into a group opener and broke
					// compilation, so the whole expression is scanned as
					// bracket syntax and copied across.
					match take_bracket_expression(&mut chars, true) {
						Some(body) => {
							result.push('[');
							result.push_str(&body);
						},
						// Unterminated. Measured, both tools reject it -
						// "brackets ([ ]) not balanced" - so the half-open
						// `[` is passed through for the engine to refuse.
						None => result.push('['),
					}
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

	Ok(result)
}

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
fn ends_branch(chars: &std::iter::Peekable<std::str::Chars<'_>>) -> bool {
	let mut rest = chars.clone();
	match rest.next() {
		None => true,
		Some('\\') => matches!(rest.next(), Some('|' | ')')),
		Some(_) => false,
	}
}

/// Consume a bracket expression's body, returning it without the outer `[]`.
///
/// The opening `[` is already consumed. Returns `None` - advancing nothing -
/// when the expression is unterminated.
///
/// With `normalize`, the body is rewritten so the engine reads it the way
/// POSIX does: `\` has no special meaning inside a bracket expression, so it
/// is doubled to stay a literal, and a leading `]` is escaped rather than
/// closing the expression. Measured, `grep -c '[\(]'` selects lines holding a
/// backslash OR a parenthesis, and `grep -c '[]x]'` selects lines holding a
/// bracket or an `x`.
///
/// Without it the body is copied verbatim, which is what an already-extended
/// pattern needs: the caller is only locating the expression so it can skip
/// over it, and must not change how it matches.
fn take_bracket_expression(
	chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
	normalize: bool,
) -> Option<String> {
	let mut probe = chars.clone();
	let mut body = String::new();

	// A leading `^` negates, and a `]` immediately after that is the literal
	// `]` rather than the terminator.
	if probe.peek() == Some(&'^') {
		body.push(probe.next()?);
	}
	if probe.peek() == Some(&']') {
		body.push_str(if normalize { r"\]" } else { "]" });
		probe.next();
	}

	while let Some(c) = probe.next() {
		match c {
			']' => {
				*chars = probe;
				return Some(body + "]");
			},
			// `\` is an ordinary character here; keep it one.
			'\\' => body.push_str(if normalize { r"\\" } else { "\\" }),
			// `[:alpha:]`, `[.x.]` and `[=x=]` carry their own terminators, so
			// the `]` that closes them does not close the bracket expression.
			'[' if matches!(probe.peek(), Some(':' | '.' | '=')) => {
				let kind = probe.next()?;
				body.push('[');
				body.push(kind);
				let mut previous = None;
				loop {
					let next = probe.next()?;
					body.push(next);
					if previous == Some(kind) && next == ']' {
						break;
					}
					previous = Some(next);
				}
			},
			_ => body.push(c),
		}
	}
	None
}

/// Make an ERE's non-interval `{` the literal both real tools treat it as.
///
/// POSIX leaves a `{` that opens no interval undefined, and both GNU and BSD
/// grep take it literally, while the `regex` crate rejects the pattern
/// outright. Measured against /usr/bin/grep:
///
/// ```text
/// grep -Ec '{a}'    1, literal          regex: "repetition operator missing expression"
/// grep -Ec 'a{'     2, literal          regex: "repetition quantifier expects a valid decimal"
/// grep -Ec '{foo'   1, literal          regex: "repetition operator missing expression"
/// grep -Ec 'a{1,2'  "braces not balanced"   regex: "unclosed counted repetition"
/// ```
///
/// The last line is why this cannot simply escape every brace that fails to
/// open an interval: an unterminated interval is an ERROR in both tools, and
/// escaping it would turn a diagnosed mistake into a silent literal match.
/// A digit after `{` is what separates the two - it marks an attempted
/// interval, which is left for the engine to accept or reject.
#[cfg(feature = "util.grep")]
pub(crate) fn ere_literalize_braces(pattern: &str) -> std::borrow::Cow<'_, str> {
	if !pattern.contains('{') {
		return std::borrow::Cow::Borrowed(pattern);
	}

	let mut result = String::with_capacity(pattern.len());
	let mut chars = pattern.chars().peekable();
	let mut rewrote = false;

	while let Some(c) = chars.next() {
		match c {
			// An escape already spells out its own meaning; copy the pair.
			'\\' => {
				result.push('\\');
				if let Some(escaped) = chars.next() {
					result.push(escaped);
				}
			},
			// A brace inside a bracket expression is already a literal.
			'[' => match take_bracket_expression(&mut chars, false) {
				Some(body) => {
					result.push('[');
					result.push_str(&body);
				},
				None => result.push('['),
			},
			'{' if !chars.peek().is_some_and(char::is_ascii_digit) => {
				result.push_str(r"\{");
				rewrote = true;
			},
			_ => result.push(c),
		}
	}

	if rewrote { std::borrow::Cow::Owned(result) } else { std::borrow::Cow::Borrowed(pattern) }
}

/// True when an ERE contains a repetition operator with nothing to repeat.
///
/// POSIX leaves this undefined and both GNU and BSD grep reject it:
/// `grep -E '^+'` is "repetition-operator operand invalid". The `regex` crate
/// instead compiles `^+` as `(?:^)+`, which matches the empty string at every
/// line start, so without this check an invalid pattern silently selects every
/// line - a wrong answer with a success exit status.
#[cfg(feature = "util.grep")]
pub(crate) fn ere_repetition_operand_missing(pattern: &str) -> bool {
	let mut chars = pattern.chars().peekable();
	let mut has_atom = false;
	while let Some(c) = chars.next() {
		match c {
			// An escaped character is a literal, and therefore an atom.
			'\\' => {
				if chars.next().is_none() {
					return false;
				}
				has_atom = true;
			},
			// A bracket expression is one atom. `]` immediately after the
			// opening bracket (or its negation) is a literal, not the close.
			'[' => {
				if chars.peek() == Some(&'^') {
					chars.next();
				}
				if chars.peek() == Some(&']') {
					chars.next();
				}
				for inner in chars.by_ref() {
					if inner == ']' {
						break;
					}
				}
				has_atom = true;
			},
			'(' | '|' => has_atom = false,
			')' => has_atom = true,
			// Anchors are not atoms and break adjacency to any earlier atom:
			// `a^+` repeats the anchor, not `a`. Clear the operand state so
			// repetition after an anchor is rejected wherever it appears.
			'^' | '$' => has_atom = false,
			'*' | '+' | '?' if !has_atom => return true,
			// A `{` is only a repetition operator when it actually opens an
			// interval. Measured: `grep -E '^{'` matches nothing and reports
			// no error, because a `{` that cannot be parsed as `{n}`, `{n,}`
			// or `{n,m}` is an ordinary literal - while `grep -E '{1}'` IS
			// "repetition-operator operand invalid". Flagging every `{` here
			// rejected patterns the real tool accepts.
			'{' => {
				let rest: String = chars.clone().collect();
				if opens_interval(&rest) {
					if !has_atom {
						return true;
					}
				} else {
					has_atom = true;
				}
			},
			_ => has_atom = true,
		}
	}
	false
}

/// Whether `rest`, the text just past a `{`, completes a valid interval:
/// `n}`, `n,}` or `n,m}`. Anything else leaves the `{` a literal.
#[cfg(feature = "util.grep")]
fn opens_interval(rest: &str) -> bool {
	let mut chars = rest.chars().peekable();
	let mut digits = 0usize;
	while chars.peek().is_some_and(char::is_ascii_digit) {
		chars.next();
		digits += 1;
	}
	if digits == 0 {
		return false;
	}
	if chars.peek() == Some(&',') {
		chars.next();
		while chars.peek().is_some_and(char::is_ascii_digit) {
			chars.next();
		}
	}
	chars.next() == Some('}')
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
	fn test_character_classes_unchanged() {
		assert_eq!(ere(r"[a-z]"), "[a-z]");
		assert_eq!(ere(r"[^0-9]"), "[^0-9]");
	}

	#[test]
	fn test_anchors_and_dot_and_star() {
		assert_eq!(ere(r"^a.*b$"), "^a.*b$");
	}

	#[test]
	fn test_trailing_backslash_is_preserved() {
		assert_eq!(ere(r"abc\"), r"abc\");
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
			assert!(ere_repetition_operand_missing(pattern), "should reject {pattern}");
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
			r"a\",      // trailing backslash: not our error to report
			// A `{` that opens no interval is a LITERAL, not an operator.
			// Measured: `grep -E '^{'` and `grep -E '{a}'` match nothing and
			// report no error, while `grep -E '{1}'` IS invalid. Rejecting
			// every `{` refused patterns the real tool accepts.
			"^{",
			"{",
			"{a}",
			"{,5}",
			"^{}",
			"{1a}",
		] {
			assert!(!ere_repetition_operand_missing(pattern), "should accept {pattern}");
		}
	}

	#[cfg(feature = "util.grep")]
	#[test]
	fn ere_rejects_only_intervals_that_really_open() {
		for pattern in ["{1}", "^{2}", "{3,}", "{4,5}", "(|{6})"] {
			assert!(ere_repetition_operand_missing(pattern), "should reject {pattern}");
		}
	}
}
