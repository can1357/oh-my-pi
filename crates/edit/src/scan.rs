//! Prefix scanners shared by the edit-format parsers.
//!
//! Each strips one lexical element off the front of a `&str` and returns what
//! follows, so a line grammar reads as a chain of `?`s:
//!
//! ```ignore
//! // `@@ -12,3 …`
//! let rest = scan::space(line.strip_prefix("@@")?)?;
//! let (start, rest) = scan::digits(rest.strip_prefix('-')?)?;
//! ```

use xutf::{GeneralCategory, Ucd};

/// Splits a non-empty run of ASCII digits off the front of `s`.
pub(crate) fn digits(s: &str) -> Option<(&str, &str)> {
	let len = s.bytes().take_while(u8::is_ascii_digit).count();
	(len > 0).then(|| s.split_at(len))
}

/// Strips one or more whitespace chars off the front of `s`.
pub(crate) fn space(s: &str) -> Option<&str> {
	let rest = s.trim_start();
	(rest.len() < s.len()).then_some(rest)
}

/// Strips `word` off the front of `s`, ignoring ASCII case.
pub(crate) fn keyword<'a>(s: &'a str, word: &str) -> Option<&'a str> {
	let (head, rest) = s.split_at_checked(word.len())?;
	head.eq_ignore_ascii_case(word).then_some(rest)
}

/// Whether `c` can be part of a word: a letter, mark, decimal or letter
/// number, connector punctuation, joiner, or enclosed-letter symbol.
pub(crate) fn is_word(c: char) -> bool {
	c.is_ascii_alphanumeric()
		|| c == '_'
		|| !c.is_ascii()
			&& (matches!(
				c.general_category(),
				GeneralCategory::UppercaseLetter
					| GeneralCategory::LowercaseLetter
					| GeneralCategory::TitlecaseLetter
					| GeneralCategory::ModifierLetter
					| GeneralCategory::OtherLetter
					| GeneralCategory::NonspacingMark
					| GeneralCategory::SpacingMark
					| GeneralCategory::EnclosingMark
					| GeneralCategory::DecimalNumber
					| GeneralCategory::LetterNumber
					| GeneralCategory::ConnectorPunctuation
			) || matches!(
				c,
				'\u{200c}' | '\u{200d}'
					| '\u{24b6}'..='\u{24e9}'
					| '\u{1f130}'..='\u{1f149}'
					| '\u{1f150}'..='\u{1f169}'
					| '\u{1f170}'..='\u{1f189}'
			))
}

/// Whether a word ending just before `s` stops there: `s` is empty or starts
/// with a non-word char.
pub(crate) fn ends_word(s: &str) -> bool {
	!s.chars().next().is_some_and(is_word)
}

/// Whether a word starting at the end of `s` begins there: `s` is empty or
/// ends with a non-word char.
pub(crate) fn starts_word(s: &str) -> bool {
	!s.chars().next_back().is_some_and(is_word)
}
