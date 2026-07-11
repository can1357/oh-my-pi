// Copyright 2022 Tavian Barnes
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

use onig::{Regex, RegexOptions, Syntax};

/// Parse a string as a POSIX Basic Regular Expression.
fn parse_bre(expr: &str, options: RegexOptions) -> Result<Regex, onig::Error> {
	let bre = Syntax::posix_basic();
	Regex::with_options(expr, bre.options() | options, bre)
}

/// Push a literal character onto a regex, escaping it if necessary.
fn regex_push_literal(regex: &mut String, ch: char) {
	// https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap09.html#tag_09_03_03
	if matches!(ch, '.' | '[' | '\\' | '*' | '^' | '$') {
		regex.push('\\');
	}
	regex.push(ch);
}

/// Extracts a bracket expression from a glob.
fn extract_bracket_expr(pattern: &str) -> Option<(String, &str)> {
	// https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#tag_18_13_01
	//
	//     If an open bracket introduces a bracket expression as in XBD RE Bracket
	// Expression,     except that the <exclamation-mark> character ( '!' ) shall
	// replace the <circumflex>     character ( '^' ) in its role in a non-matching
	// list in the regular expression notation,     it shall introduce a pattern
	// bracket expression. A bracket expression starting with an     unquoted
	// <circumflex> character produces unspecified results. Otherwise, '[' shall
	// match     the character itself.
	//
	// To check for valid bracket expressions, we scan for the closing bracket and
	// attempt to parse that segment as a regex.  If that fails, we treat the '['
	// literally.

	let mut expr = "[".to_string();

	let mut chars = pattern.chars();
	let mut next = chars.next();

	// https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap09.html#tag_09_03_05
	//
	//     3. A non-matching list expression begins with a <circumflex> ( '^' ) ...
	//
	// (but in a glob, '!' is used instead of '^')
	if next == Some('!') {
		expr.push('^');
		next = chars.next();
	}

	// https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap09.html#tag_09_03_05
	//
	//     1. ... The <right-square-bracket> ( ']' ) shall lose its special meaning
	//        and represent itself in a bracket expression if it occurs first in the
	//        list (after an initial <circumflex> ( '^' ), if any).
	if next == Some(']') {
		expr.push(']');
		next = chars.next();
	}

	while let Some(ch) = next {
		expr.push(ch);

		match ch {
			'[' => {
				// https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap09.html#tag_09_03_05
				//
				//     4. A collating symbol is a collating element enclosed within
				//        bracket-period ( "[." and ".]" ) delimiters. ...
				//
				//     5. An equivalence class expression shall ... be expressed by enclosing
				//        any one of the collating elements in the equivalence class within
				//        bracket- equal ( "[=" and "=]" ) delimiters.
				//
				//     6. ...  A character class expression is expressed as a character class
				//        name enclosed within bracket- <colon> ( "[:" and ":]" ) delimiters.
				next = chars.next();
				if let Some(delim) = next {
					expr.push(delim);

					if matches!(delim, '.' | '=' | ':') {
						let rest = chars.as_str();
						let end = rest.find([delim, ']'])? + 2;
						expr.push_str(&rest[..end]);
						chars = rest[end..].chars();
					}
				}
			},
			']' => {
				// https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap09.html#tag_09_03_05
				//
				//     1. ... The <right-square-bracket> ( ']' ) shall ... terminate the bracket
				//        expression, unless it appears in a collating symbol (such as "[.].]" )
				//        or is the ending <right-square-bracket> for a collating symbol,
				//        equivalence class, or character class.
				break;
			},
			_ => {},
		}

		next = chars.next();
	}

	if parse_bre(&expr, RegexOptions::REGEX_OPTION_NONE).is_ok() {
		Some((expr, chars.as_str()))
	} else {
		None
	}
}

/// Converts a POSIX glob into a POSIX Basic Regular Expression
fn glob_to_regex(pattern: &str) -> Option<String> {
	let mut regex = String::new();

	let mut chars = pattern.chars();
	while let Some(ch) = chars.next() {
		// https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#tag_18_13
		match ch {
			'?' => regex.push('.'),
			'*' => regex.push_str(".*"),
			'\\' => {
				let ch = chars.next()?;
				regex_push_literal(&mut regex, ch);
			},
			'[' => {
				if let Some((expr, rest)) = extract_bracket_expr(chars.as_str()) {
					regex.push_str(&expr);
					chars = rest.chars();
				} else {
					regex_push_literal(&mut regex, ch);
				}
			},
			_ => regex_push_literal(&mut regex, ch),
		}
	}

	Some(regex)
}

/// An fnmatch()-style glob matcher.
pub struct Pattern {
	regex: Option<Regex>,
}

impl Pattern {
	/// Parse an fnmatch()-style glob.
	pub fn new(pattern: &str, caseless: bool) -> Self {
		let options = if caseless {
			RegexOptions::REGEX_OPTION_IGNORECASE
		} else {
			RegexOptions::REGEX_OPTION_NONE
		};

		// As long as glob_to_regex() is correct, this should never fail
		let regex = glob_to_regex(pattern).map(|r| parse_bre(&r, options).unwrap());
		Self { regex }
	}

	/// Test if this pattern matches a string.
	pub fn matches(&self, string: &str) -> bool {
		self.regex.as_ref().is_some_and(|r| r.is_match(string))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[track_caller]
	fn assert_glob_regex(glob: &str, regex: &str) {
		assert_eq!(glob_to_regex(glob).as_deref(), Some(regex));
	}

	#[test]
	fn literals() {
		assert_glob_regex(r"foo.bar", r"foo\.bar");
	}

	#[test]
	fn regex_special() {
		assert_glob_regex(r"^foo.bar$", r"\^foo\.bar\$");
	}

	#[test]
	fn wildcards() {
		assert_glob_regex(r"foo?bar*baz", r"foo.bar.*baz");
	}

	#[test]
	fn escapes() {
		assert_glob_regex(r"fo\o\?bar\*baz\\", r"foo?bar\*baz\\");
	}

	#[test]
	fn valid_brackets() {
		assert_glob_regex(r"foo[bar][!baz]", r"foo[bar][^baz]");
	}

	#[test]
	fn complex_brackets() {
		assert_glob_regex(r"[!]!.*[\[.].][=]=][:space:]-]", r"[^]!.*[\[.].][=]=][:space:]-]");
	}

	#[test]
	fn invalid_brackets() {
		assert_glob_regex(r"foo[bar[!baz", r"foo\[bar\[!baz");
	}

	#[test]
	fn incomplete_escape() {
		assert_eq!(glob_to_regex(r"foo\"), None);
	}

	#[test]
	fn pattern_matches() {
		assert!(Pattern::new(r"foo*bar", false).matches("foo--bar"));

		assert!(!Pattern::new(r"foo*bar", false).matches("bar--foo"));
	}

	#[test]
	fn caseless_matches() {
		assert!(Pattern::new(r"foo*BAR", true).matches("FOO--bar"));

		assert!(!Pattern::new(r"foo*BAR", true).matches("BAR--foo"));
	}

	#[test]
	fn incomplete_escape_matches() {
		assert!(!Pattern::new(r"foo\", false).matches("\n"));
	}
}
