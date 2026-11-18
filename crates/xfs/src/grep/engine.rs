//! Regex engines and pi's pattern dialect.
//!
//! [`Engine`] is a pattern compiled by one of two engines: Rust `regex` (via
//! `grep-regex`), or PCRE2 for syntax it lacks (look-around,
//! back-references). Hot loops match on the variant and run monomorphised per
//! engine; the [`Matcher`] impl serves one-shot callers. The shell's `rg` and
//! `grep` build their engines with their own flags; [`Engine::compile`] is the
//! agent dialect with its repairs.

use std::{borrow::Cow, fmt, sync::LazyLock};

use grep_matcher::Matcher;
use grep_pcre2::{RegexMatcher as PcreMatcher, RegexMatcherBuilder as PcreMatcherBuilder};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};

/// `OMP_PCRE2_JIT` from the process environment, read once.
static PCRE2_JIT: LazyLock<bool> =
	LazyLock::new(|| pcre2_jit_enabled(std::env::var("OMP_PCRE2_JIT").ok().as_deref()));

/// A compiled pattern.
pub enum Engine {
	/// Rust `regex`.
	Rust(RegexMatcher),
	/// PCRE2.
	Pcre(PcreMatcher),
}

/// Search error from either engine behind an [`Engine`].
#[derive(Debug)]
pub enum EngineError {
	/// Rust `regex` (never fails at search time).
	Rust(grep_matcher::NoError),
	/// PCRE2 (match limits, JIT stack exhaustion).
	Pcre(grep_pcre2::Error),
}

impl fmt::Display for EngineError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Rust(err) => err.fmt(f),
			Self::Pcre(err) => err.fmt(f),
		}
	}
}

impl std::error::Error for EngineError {}

impl Engine {
	/// Whether matches of this engine can span lines when scanned in
	/// multiline mode (grep-searcher's `multi_line_with_matcher`): a pattern
	/// that can never match `\n` is scanned line by line even then.
	pub(crate) fn spans_lines(&self) -> bool {
		match self {
			Self::Rust(m) => {
				m.line_terminator().is_none()
					&& m
						.non_matching_bytes()
						.is_none_or(|bytes| !bytes.contains(b'\n'))
			},
			Self::Pcre(m) => {
				m.line_terminator().is_none()
					&& m
						.non_matching_bytes()
						.is_none_or(|bytes| !bytes.contains(b'\n'))
			},
		}
	}
}

impl Matcher for Engine {
	type Captures = grep_matcher::NoCaptures;
	type Error = EngineError;

	fn find_at(
		&self,
		haystack: &[u8],
		at: usize,
	) -> Result<Option<grep_matcher::Match>, Self::Error> {
		match self {
			Self::Rust(matcher) => matcher.find_at(haystack, at).map_err(EngineError::Rust),
			Self::Pcre(matcher) => matcher.find_at(haystack, at).map_err(EngineError::Pcre),
		}
	}

	fn new_captures(&self) -> Result<Self::Captures, Self::Error> {
		Ok(grep_matcher::NoCaptures::new())
	}

	fn is_match_at(&self, haystack: &[u8], at: usize) -> Result<bool, Self::Error> {
		match self {
			Self::Rust(matcher) => matcher.is_match_at(haystack, at).map_err(EngineError::Rust),
			Self::Pcre(matcher) => matcher.is_match_at(haystack, at).map_err(EngineError::Pcre),
		}
	}
}

/// PCRE2 JIT toggle for an `OMP_PCRE2_JIT` value.
///
/// `1` forces JIT on,
/// `0`/`false` forces it off. Unset or empty, JIT stays on everywhere except
/// macOS, where PCRE2's SLJIT executable allocator can fault while compiling
/// patterns (issue #7399). The shell reads the variable from its own
/// environment (exported shell variables are not in the process
/// environment); [`Engine::compile`] reads the process environment once.
pub fn pcre2_jit_enabled(setting: Option<&str>) -> bool {
	match setting {
		Some(value) if !value.is_empty() => value != "0" && !value.eq_ignore_ascii_case("false"),
		_ => !cfg!(target_os = "macos"),
	}
}

impl Engine {
	/// Compiles `pattern` in the agent dialect: braces that open no
	/// repetition or braced escape are literal (`${x}`), then Rust `regex`
	/// (line-terminated unless `multiline`), then PCRE2, then — after a group
	/// error — the pattern with its stray parentheses escaped, and finally the
	/// pattern as literal text.
	///
	/// `^` and `$` always anchor at line boundaries: line-mode scanning
	/// searches whole buffers, where a haystack anchor would only match at
	/// the start or end of the file.
	///
	/// # Errors
	/// `Regex error: …` only when even the literal fails to compile.
	pub fn compile(pattern: &str, ignore_case: bool, multiline: bool) -> Result<Self, String> {
		let sanitized = sanitize_braces(pattern);
		let err = match build_rust(&sanitized, ignore_case, multiline) {
			Ok(matcher) => return Ok(Self::Rust(matcher)),
			Err(err) => err,
		};
		// PCRE2 has what Rust `regex` omits: look-around, back-references.
		if let Ok(matcher) = build_pcre(&sanitized, ignore_case) {
			return Ok(Self::Pcre(matcher));
		}
		// A stray `(`/`)` in an otherwise valid regex (`fetchProvider(`):
		// escape the parentheses, keep the rest a regex.
		let message = err.to_string();
		if message.contains("unclosed group") || message.contains("unopened group") {
			let escaped = escape_unescaped_parentheses(&sanitized);
			if escaped != sanitized {
				if let Ok(matcher) = build_rust(&escaped, ignore_case, multiline) {
					return Ok(Self::Rust(matcher));
				}
				if let Ok(matcher) = build_pcre(&escaped, ignore_case) {
					return Ok(Self::Pcre(matcher));
				}
			}
		}
		build_rust(&regex::escape(pattern), ignore_case, multiline)
			.map(Self::Rust)
			.map_err(|_| format!("Regex error: {message}"))
	}
}

/// Rust `regex`, terminated at `\n` outside multiline mode when the pattern
/// allows it.
fn build_rust(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> Result<RegexMatcher, grep_regex::Error> {
	let build = |line_terminated: bool| {
		let mut builder = RegexMatcherBuilder::new();
		builder.case_insensitive(ignore_case).multi_line(true);
		if line_terminated {
			builder.line_terminator(Some(b'\n'));
		}
		builder.build(pattern)
	};
	if !multiline && let Ok(matcher) = build(true) {
		return Ok(matcher);
	}
	build(false)
}

/// PCRE2 with UTF and Unicode properties, JIT per [`PCRE2_JIT`].
fn build_pcre(pattern: &str, ignore_case: bool) -> Result<PcreMatcher, grep_pcre2::Error> {
	PcreMatcherBuilder::new()
		.caseless(ignore_case)
		.multi_line(true)
		.utf(true)
		.ucp(true)
		.jit_if_available(*PCRE2_JIT)
		.build(pattern)
}

/// Index of the `}` closing a repetition `{N}`, `{N,}`, or `{N,M}` that
/// starts at `bytes[start] == b'{'`.
fn find_valid_repetition(bytes: &[u8], start: usize) -> Option<usize> {
	let digits = |from: usize| {
		from
			+ bytes[from..]
				.iter()
				.take_while(|b| b.is_ascii_digit())
				.count()
	};
	let i = digits(start + 1);
	if i == start + 1 || i >= bytes.len() {
		return None;
	}
	match bytes[i] {
		b'}' => Some(i),
		b',' => {
			let j = digits(i + 1);
			(j < bytes.len() && bytes[j] == b'}').then_some(j)
		},
		_ => None,
	}
}

/// Escapes `{` and `}` that open no repetition and no braced escape
/// (`\p{…}`, `\x{…}`, `\u{…}`): `${platform}` becomes `$\{platform\}`.
fn sanitize_braces(pattern: &str) -> Cow<'_, str> {
	let bytes = pattern.as_bytes();
	if !bytes.iter().any(|&b| b == b'{' || b == b'}') {
		return Cow::Borrowed(pattern);
	}
	let mut out = String::with_capacity(pattern.len() + 8);
	let mut modified = false;
	let mut i = 0;
	while i < bytes.len() {
		match bytes[i] {
			b'\\' if i + 1 < bytes.len() => {
				let ch = next_char(pattern, i + 1);
				out.push('\\');
				out.push(ch);
				i += 1 + ch.len_utf8();
				if matches!(ch, 'p' | 'P' | 'x' | 'u') && bytes.get(i) == Some(&b'{') {
					let end = memchr::memchr(b'}', &bytes[i..]).map_or(bytes.len(), |off| i + off + 1);
					out.push_str(&pattern[i..end]);
					i = end;
				}
			},
			b'{' => {
				if let Some(end) = find_valid_repetition(bytes, i) {
					out.push_str(&pattern[i..=end]);
					i = end + 1;
				} else {
					out.push_str("\\{");
					i += 1;
					modified = true;
				}
			},
			b'}' => {
				out.push_str("\\}");
				i += 1;
				modified = true;
			},
			_ => {
				let ch = next_char(pattern, i);
				out.push(ch);
				i += ch.len_utf8();
			},
		}
	}
	if modified {
		Cow::Owned(out)
	} else {
		Cow::Borrowed(pattern)
	}
}

/// Escapes every unescaped `(` and `)`.
fn escape_unescaped_parentheses(pattern: &str) -> Cow<'_, str> {
	let bytes = pattern.as_bytes();
	if !bytes.iter().any(|&b| b == b'(' || b == b')') {
		return Cow::Borrowed(pattern);
	}
	let mut out = String::with_capacity(pattern.len() + 4);
	let mut modified = false;
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'\\' && i + 1 < bytes.len() {
			let ch = next_char(pattern, i + 1);
			out.push('\\');
			out.push(ch);
			i += 1 + ch.len_utf8();
			continue;
		}
		let ch = next_char(pattern, i);
		if matches!(ch, '(' | ')') {
			out.push('\\');
			modified = true;
		}
		out.push(ch);
		i += ch.len_utf8();
	}
	if modified {
		Cow::Owned(out)
	} else {
		Cow::Borrowed(pattern)
	}
}

/// The character starting at byte `at` of `s` (a character boundary).
fn next_char(s: &str, at: usize) -> char {
	s[at..].chars().next().unwrap_or('\0')
}

#[cfg(test)]
mod tests {
	use grep_matcher::Matcher;

	use super::*;

	#[test]
	fn preserves_unicode_property_escapes() {
		assert_eq!(sanitize_braces(r"\p{Greek}"), r"\p{Greek}");
		assert_eq!(sanitize_braces(r"\x{41}"), r"\x{41}");
		assert_eq!(sanitize_braces(r"\p{Greek"), r"\p{Greek");
	}

	#[test]
	fn escapes_non_quantifier_braces() {
		assert_eq!(sanitize_braces("${platform}"), "$\\{platform\\}");
		assert_eq!(sanitize_braces("a{b}"), "a\\{b\\}");
		assert_eq!(sanitize_braces("x{2"), "x\\{2");
	}

	#[test]
	fn preserves_valid_quantifiers() {
		for pattern in ["a{2,4}", "a{2}", "a{2,}", "é{3}"] {
			assert_eq!(sanitize_braces(pattern), pattern);
		}
	}

	#[test]
	fn preserves_escaped_parentheses() {
		assert_eq!(escape_unescaped_parentheses(r"foo\(bar\)"), r"foo\(bar\)");
	}

	#[test]
	fn escapes_literal_parentheses() {
		assert_eq!(
			escape_unescaped_parentheses("fetchAnthropicProvider("),
			r"fetchAnthropicProvider\("
		);
		assert_eq!(
			escape_unescaped_parentheses("fetchAnthropicProvider()"),
			r"fetchAnthropicProvider\(\)"
		);
	}

	#[test]
	fn invalid_regex_falls_back_to_literal() {
		for (pattern, hay, miss) in [
			("foo[bar", &b"x foo[bar y"[..], &b"foobar"[..]),
			("+++", &b"a+++b"[..], &b"ab"[..]),
			("fail)", &b"(1 fail)"[..], &b"failure"[..]),
		] {
			let engine = Engine::compile(pattern, false, false)
				.unwrap_or_else(|e| panic!("`{pattern}` should fall back to literal, got: {e}"));
			assert!(engine.is_match(hay).unwrap(), "`{pattern}` should match {hay:?}");
			assert!(!engine.is_match(miss).unwrap(), "`{pattern}` should not match {miss:?}");
		}
	}

	#[test]
	fn stray_parenthesis_preserves_surrounding_regex() {
		let engine = Engine::compile("foo.*(bar", false, false).expect("retry with escaped paren");
		assert!(engine.is_match(b"fooXYZ(bar").unwrap());
		assert!(!engine.is_match(b"foobar").unwrap());
	}

	#[test]
	fn valid_regex_is_not_escaped() {
		let engine = Engine::compile("fo+", false, false).expect("valid regex");
		assert!(matches!(engine, Engine::Rust(_)));
		assert!(engine.is_match(b"foooo").unwrap());
		assert!(!engine.is_match(b"bar").unwrap());
	}

	#[test]
	fn pcre2_serves_lookaround_and_backreferences() {
		for (pattern, hit, miss) in [
			(r"foo(?=bar)", &b"foobar"[..], &b"foobaz"[..]),
			(r"(?<=x)foo", b"xfoo", b"yfoo"),
			(r"\b(\w+)\s+\1\b", b"same same", b"same other"),
		] {
			let engine = Engine::compile(pattern, false, false).expect("PCRE2 pattern");
			assert!(matches!(engine, Engine::Pcre(_)), "{pattern}");
			assert!(engine.is_match(hit).unwrap(), "{pattern}");
			assert!(!engine.is_match(miss).unwrap(), "{pattern}");
		}
	}

	#[test]
	fn ignore_case_applies_to_both_engines() {
		for pattern in ["needle", r"needle(?=s)"] {
			let engine = Engine::compile(pattern, true, false).expect("compile");
			assert!(engine.is_match(b"NEEDLES").unwrap(), "{pattern}");
		}
	}

	#[test]
	fn jit_setting_parses_overrides() {
		assert!(pcre2_jit_enabled(Some("1")));
		assert!(!pcre2_jit_enabled(Some("0")));
		assert!(!pcre2_jit_enabled(Some("FALSE")));
		assert_eq!(pcre2_jit_enabled(Some("")), !cfg!(target_os = "macos"));
	}
}
