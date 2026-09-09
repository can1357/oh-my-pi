use omp_core::{IntoStr as _, Str};
use regex::{Regex, RegexBuilder};
use strum::{Display, EnumString, IntoStaticStr};
use thiserror::Error;

use crate::replacement::regex_has_unresolvable_short_match_fallback;

/// Minimum byte length for a reversible plain secret.
pub const MIN_OBFUSCATE_SECRET_LEN: usize = 8;

/// How a declared secret is found.
#[derive(Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum SecretKind {
	/// Match one literal byte string.
	Plain,
	/// Discover matches with a linear-time regular expression.
	Regex,
}

/// What to emit for a secret match.
#[derive(Clone, Copy, Debug, Default, Display, EnumString, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum SecretMode {
	/// Emit a reversible keyed placeholder.
	#[default]
	Obfuscate,
	/// Emit an irreversible replacement.
	Replace,
}

/// A validated secret declaration.
#[derive(Clone, Debug)]
pub struct SecretRule {
	kind:          SecretKind,
	mode:          SecretMode,
	content:       Str,
	replacement:   Option<Str>,
	friendly_name: Option<Str>,
	regex:         Option<Regex>,
	boundary:      bool,
}

impl SecretRule {
	/// Validates and constructs a secret declaration.
	pub fn new(
		kind: SecretKind,
		mode: SecretMode,
		content: impl Into<Str>,
		replacement: Option<Str>,
		flags: Option<&str>,
		friendly_name: Option<Str>,
	) -> Result<Self, SecretRuleError> {
		let content = content.into();
		if content.is_empty() {
			return Err(SecretRuleError::EmptyContent);
		}
		if kind == SecretKind::Plain
			&& mode == SecretMode::Obfuscate
			&& content.len() < MIN_OBFUSCATE_SECRET_LEN
		{
			return Err(SecretRuleError::PlainObfuscateTooShort { actual: content.len() });
		}
		if mode == SecretMode::Obfuscate && replacement.is_some() {
			return Err(SecretRuleError::ReplacementForObfuscate);
		}
		if kind == SecretKind::Plain && flags.is_some_and(|value| !value.is_empty()) {
			return Err(SecretRuleError::FlagsForPlain);
		}
		let regex = (kind == SecretKind::Regex)
			.then(|| compile_secret_regex(content.as_str(), flags))
			.transpose()?;
		if mode == SecretMode::Replace
			&& replacement.is_none()
			&& regex
				.as_ref()
				.is_some_and(regex_has_unresolvable_short_match_fallback)
		{
			return Err(SecretRuleError::UnresolvableRegexReplacement);
		}
		Ok(Self { kind, mode, content, replacement, friendly_name, regex, boundary: false })
	}

	/// Returns the match kind.
	pub const fn kind(&self) -> SecretKind {
		self.kind
	}

	/// Returns the masking mode.
	pub const fn mode(&self) -> SecretMode {
		self.mode
	}

	/// Returns the declared literal or pattern.
	pub fn content(&self) -> &str {
		self.content.as_str()
	}

	/// Returns the optional literal replacement.
	pub fn replacement(&self) -> Option<&str> {
		self.replacement.as_deref()
	}

	/// Returns the optional unsanitized display label.
	pub fn friendly_name(&self) -> Option<&str> {
		self.friendly_name.as_deref()
	}

	/// Returns the compiled expression for a regex rule.
	pub const fn regex(&self) -> Option<&Regex> {
		self.regex.as_ref()
	}

	/// Requires matches to sit on credential-alphabet boundaries.
	///
	/// Enforces `(?<![0-9A-Za-z_*-])(?![0-9A-Za-z_*-])` lookaround semantics,
	/// which the guaranteed linear-time engine cannot express; the obfuscator
	/// rejects matches adjacent to credential-alphabet characters instead.
	pub const fn with_boundary_guard(mut self) -> Self {
		self.boundary = true;
		self
	}

	/// Returns whether matches must sit on credential-alphabet boundaries.
	pub const fn boundary_guard(&self) -> bool {
		self.boundary
	}

	pub(crate) fn into_irreversible(mut self) -> Self {
		if self.mode == SecretMode::Obfuscate {
			self.mode = SecretMode::Replace;
			self.replacement = None;
			self.friendly_name = None;
		}
		self
	}
}

/// Failure to validate a secret declaration.
#[derive(Debug, Error)]
pub enum SecretRuleError {
	/// The declaration has no match content.
	#[error("secret content must not be empty")]
	EmptyContent,
	/// A reversible plain declaration is too short.
	#[error("plain obfuscate secret is {actual} bytes; at least 8 bytes are required")]
	PlainObfuscateTooShort {
		/// Supplied byte length.
		actual: usize,
	},
	/// A replacement was attached to a reversible declaration.
	#[error("replacement is valid only in replace mode")]
	ReplacementForObfuscate,
	/// Regex flags were attached to a literal declaration.
	#[error("regex flags are valid only for regex rules")]
	FlagsForPlain,
	/// The expression uses semantics unavailable in the linear-time engine.
	#[error("secret regex uses unsupported backtracking-dependent construct `{construct}`")]
	UnsupportedRegex {
		/// Rejected syntax fragment.
		construct: Str,
	},
	/// A default replacement cannot differ from every short match.
	#[error(
		"secret regex matches every 1-2 byte replacement candidate; configure an explicit \
		 replacement"
	)]
	UnresolvableRegexReplacement,
	/// A regex flag is unsupported.
	#[error("secret regex flag `{flag}` is unsupported")]
	UnsupportedFlag {
		/// Rejected flag.
		flag: char,
	},
	/// The expression is invalid.
	#[error("invalid secret regex")]
	InvalidRegex(#[from] regex::Error),
}

/// Compiles a declaration with Rust regex's guaranteed linear-time engine.
pub fn compile_secret_regex(pattern: &str, flags: Option<&str>) -> Result<Regex, SecretRuleError> {
	let (pattern, literal_flags) = split_regex_literal(pattern);
	let mut case_insensitive = false;
	let mut multi_line = false;
	let mut dot_matches_new_line = false;
	let mut unicode = true;
	for flag in flags.unwrap_or("").chars().chain(literal_flags.chars()) {
		match flag {
			'g' | 'y' => {},
			'i' => case_insensitive = true,
			'm' => multi_line = true,
			's' => dot_matches_new_line = true,
			'u' => unicode = true,
			other => return Err(SecretRuleError::UnsupportedFlag { flag: other }),
		}
	}
	if let Some(construct) = unsupported_construct(pattern) {
		return Err(SecretRuleError::UnsupportedRegex { construct: construct.to_str() });
	}
	RegexBuilder::new(pattern)
		.case_insensitive(case_insensitive)
		.multi_line(multi_line)
		.dot_matches_new_line(dot_matches_new_line)
		.unicode(unicode)
		.size_limit(10 * 1024 * 1024)
		.dfa_size_limit(10 * 1024 * 1024)
		.build()
		.map_err(SecretRuleError::from)
}

fn split_regex_literal(pattern: &str) -> (&str, &str) {
	if !pattern.starts_with('/') {
		return (pattern, "");
	}
	let bytes = pattern.as_bytes();
	for index in (1..bytes.len()).rev() {
		if bytes[index] != b'/' || is_escaped(bytes, index) {
			continue;
		}
		let flags = &pattern[index + 1..];
		if flags
			.chars()
			.all(|flag| flag == ' ' || "gimsuy".contains(flag))
		{
			return (&pattern[1..index], flags.trim());
		}
	}
	(pattern, "")
}

const fn is_escaped(bytes: &[u8], index: usize) -> bool {
	let mut slash_count = 0;
	let mut cursor = index;
	while cursor > 0 && bytes[cursor - 1] == b'\\' {
		slash_count += 1;
		cursor -= 1;
	}
	slash_count % 2 == 1
}

fn unsupported_construct(pattern: &str) -> Option<&'static str> {
	for (needle, label) in [
		("(?=", "positive lookahead"),
		("(?!", "negative lookahead"),
		("(?<=", "positive lookbehind"),
		("(?<!", "negative lookbehind"),
		("(?>", "atomic group"),
		("(?(", "conditional"),
		("\\k<", "named backreference"),
	] {
		if pattern.contains(needle) {
			return Some(label);
		}
	}
	let bytes = pattern.as_bytes();
	for pair in bytes.windows(2) {
		if pair[0] == b'\\' && pair[1].is_ascii_digit() && pair[1] != b'0' {
			return Some("backreference");
		}
	}
	None
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn rejects_backtracking_constructs() {
		let error = compile_secret_regex(r"(token)\1", None).expect_err("backreference");
		assert!(matches!(error, SecretRuleError::UnsupportedRegex { .. }));
		let error = compile_secret_regex(r"(?<=api=)token", None).expect_err("lookbehind");
		assert!(matches!(error, SecretRuleError::UnsupportedRegex { .. }));
	}

	#[test]
	fn enforces_plain_obfuscate_floor() {
		let error =
			SecretRule::new(SecretKind::Plain, SecretMode::Obfuscate, "1234567", None, None, None)
				.expect_err("short secret");
		assert!(matches!(error, SecretRuleError::PlainObfuscateTooShort { actual: 7 }));
	}
	#[test]
	fn rejects_unresolvable_match_everything_replacement() {
		let error =
			SecretRule::new(SecretKind::Regex, SecretMode::Replace, r"[\s\S]", None, None, None)
				.expect_err("match-everything regex");
		assert!(matches!(error, SecretRuleError::UnresolvableRegexReplacement));
	}
}
