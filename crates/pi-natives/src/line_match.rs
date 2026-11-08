//! Multi-pattern line matching with named captures.
//!
//! With several patterns a [`RegexSet`] prefilters each line, and only the
//! patterns it reports run their full [`Regex`]; a single pattern runs
//! directly. Results come back column-wise as typed arrays (line, rule, and
//! the span of every named group) so a batch of matches crosses into JS
//! without one object or string per match: the caller slices the captures out
//! of the lines it already holds.

use napi::{
	Error, Result, Status,
	bindgen_prelude::{Int32Array, Uint32Array},
};
use napi_derive::napi;
use regex::{CaptureLocations, Regex, RegexBuilder, RegexSet, RegexSetBuilder};

/// Compiled-program size cap so hostile patterns error instead of exhausting
/// memory.
const SIZE_LIMIT: usize = 4 * 1024 * 1024;

/// One pattern's compiled regex and where its named groups sit.
struct Pattern {
	regex: Regex,
	/// Capture slot of each named group, in pattern order.
	slots: Vec<usize>,
	names: Vec<String>,
}

/// Matches of one batch, column-wise; see [`LineMatcherCore::match_lines`].
#[derive(Debug, Default, PartialEq, Eq)]
pub struct LineMatchColumns {
	pub lines: Vec<u32>,
	pub rules: Vec<u32>,
	pub spans: Vec<i32>,
}

/// UTF-16 offset of byte offset `byte` in `line` (the unit JS strings index
/// by).
#[allow(
	clippy::cast_possible_truncation,
	clippy::cast_possible_wrap,
	reason = "lines are far shorter than 2 GiB"
)]
fn utf16_offset(line: &str, ascii: bool, byte: usize) -> i32 {
	(if ascii {
		byte
	} else {
		line[..byte].chars().map(char::len_utf16).sum()
	}) as i32
}

/// Pure-Rust matcher core wrapped by [`LineMatcher`].
pub struct LineMatcherCore {
	/// Prefilter; `None` with a single pattern, which runs on its own.
	set:      Option<RegexSet>,
	patterns: Vec<Pattern>,
}

impl LineMatcherCore {
	/// Compile every pattern.
	///
	/// # Errors
	/// Returns `pattern N: <regex error>` for the first pattern that fails.
	pub fn new(patterns: &[String]) -> std::result::Result<Self, String> {
		let compiled = patterns
			.iter()
			.enumerate()
			.map(|(index, pattern)| {
				let regex = RegexBuilder::new(pattern)
					.size_limit(SIZE_LIMIT)
					.build()
					.map_err(|error| format!("pattern {index}: {error}"))?;
				let (slots, names) = regex
					.capture_names()
					.enumerate()
					.filter_map(|(slot, name)| name.map(|name| (slot, name.to_owned())))
					.unzip();
				Ok(Pattern { regex, slots, names })
			})
			.collect::<std::result::Result<Vec<_>, String>>()?;
		let set = if compiled.len() > 1 {
			Some(
				RegexSetBuilder::new(patterns)
					.size_limit(SIZE_LIMIT)
					.build()
					.map_err(|error| format!("pattern set: {error}"))?,
			)
		} else {
			None
		};
		Ok(Self { set, patterns: compiled })
	}

	/// Named groups of each pattern, in pattern order.
	#[must_use]
	pub fn group_names(&self) -> Vec<Vec<String>> {
		self
			.patterns
			.iter()
			.map(|pattern| pattern.names.clone())
			.collect()
	}

	/// Match every `\n`-separated line (a trailing `\r` dropped) against every
	/// pattern. Each match appends its line and pattern index, then a
	/// `start, end` pair per named group of that pattern: the capture's UTF-16
	/// offsets within its line, or `-1, -1` when the group did not participate.
	#[must_use]
	pub fn match_lines(&self, text: &str) -> LineMatchColumns {
		let mut out = LineMatchColumns::default();
		if self.patterns.is_empty() {
			return out;
		}
		let mut locations: Vec<CaptureLocations> = self
			.patterns
			.iter()
			.map(|pattern| pattern.regex.capture_locations())
			.collect();
		let mut record = |rule: usize, line_index: usize, line: &str, out: &mut LineMatchColumns| {
			let pattern = &self.patterns[rule];
			let locs = &mut locations[rule];
			if pattern.regex.captures_read(locs, line).is_none() {
				return;
			}
			#[allow(clippy::cast_possible_truncation, reason = "line and rule counts fit u32")]
			let (line_index, rule) = (line_index as u32, rule as u32);
			out.lines.push(line_index);
			out.rules.push(rule);
			let ascii = line.is_ascii();
			for &slot in &pattern.slots {
				match locs.get(slot) {
					Some((start, end)) => {
						out.spans.push(utf16_offset(line, ascii, start));
						out.spans.push(utf16_offset(line, ascii, end));
					},
					None => out.spans.extend([-1, -1]),
				}
			}
		};
		for (line_index, line) in text.split('\n').enumerate() {
			let line = line.strip_suffix('\r').unwrap_or(line);
			match &self.set {
				Some(set) => {
					for rule in &set.matches(line) {
						record(rule, line_index, line, &mut out);
					}
				},
				None => record(0, line_index, line, &mut out),
			}
		}
		out
	}
}

/// Matches of one [`LineMatcher::match_lines`] call, column-wise.
///
/// Match `i` is on line `lines[i]` for pattern `rules[i]`, and its named
/// groups (in [`LineMatcher::group_names`] order for that pattern) are the
/// next `start, end` pairs of `spans`.
#[napi(object)]
pub struct LineMatches {
	/// 0-based line index per match.
	pub lines: Uint32Array,
	/// Pattern index per match.
	pub rules: Uint32Array,
	/// Per match and named group: UTF-16 start and end within the line, `-1, -1`
	/// when the group did not participate.
	pub spans: Int32Array,
}

/// Native multi-pattern line matcher returning named captures per line.
#[napi]
pub struct LineMatcher {
	core: LineMatcherCore,
}

#[napi]
impl LineMatcher {
	/// Throws when a pattern fails to compile; message names the failing index
	/// and the regex error, e.g. `pattern 2: regex parse error: ...`.
	///
	/// # Errors
	/// Returns an error when any pattern fails to compile.
	#[napi(constructor)]
	pub fn new(patterns: Vec<String>) -> Result<Self> {
		LineMatcherCore::new(&patterns)
			.map(|core| Self { core })
			.map_err(|error| Error::new(Status::InvalidArg, error))
	}

	/// Named groups of each pattern, in pattern order: the layout of a match's
	/// `start, end` pairs in [`LineMatches::spans`].
	#[napi]
	#[must_use]
	pub fn group_names(&self) -> Vec<Vec<String>> {
		self.core.group_names()
	}

	/// Matches every line (split on `\n`) against every pattern; first match
	/// per line per pattern; ordered by line then pattern index.
	#[napi]
	#[must_use]
	pub fn match_lines(&self, text: String) -> LineMatches {
		let columns = self.core.match_lines(&text);
		LineMatches {
			lines: Uint32Array::new(columns.lines),
			rules: Uint32Array::new(columns.rules),
			spans: Int32Array::new(columns.spans),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn core(patterns: &[&str]) -> LineMatcherCore {
		LineMatcherCore::new(&patterns.iter().map(|p| (*p).to_owned()).collect::<Vec<_>>()).unwrap()
	}

	#[test]
	fn line_match_named_groups_both_syntaxes() {
		let matcher = core(&[r"req (?P<n>\d+) rps=(?<rps>[\d.]+)"]);
		assert_eq!(matcher.group_names(), vec![vec!["n".to_owned(), "rps".to_owned()]]);
		assert_eq!(matcher.match_lines("x\nreq 8 rps=56\r\n"), LineMatchColumns {
			lines: vec![1],
			rules: vec![0],
			spans: vec![4, 5, 10, 12],
		});
	}

	#[test]
	fn line_match_multiple_rules_ordered() {
		let m = core(&[r"b(?<x>\d)", r"a(?<y>\d)"]).match_lines("a1 b2\nnone\nb3");
		assert_eq!(m, LineMatchColumns {
			lines: vec![0, 0, 2],
			rules: vec![0, 1, 0],
			spans: vec![4, 5, 1, 2, 1, 2],
		});
	}

	#[test]
	fn line_match_first_match_only_and_optional_groups() {
		let m = core(&[r"(?<d>\d)(?<opt>z)?"]).match_lines("1 2z 3");
		assert_eq!(m, LineMatchColumns { lines: vec![0], rules: vec![0], spans: vec![0, 1, -1, -1] });
	}

	#[test]
	fn line_match_unnamed_groups_are_not_reported() {
		let m = core(&[r"^(\w+) (?<v>\d+)"]).match_lines("rps 12");
		assert_eq!(m.spans, vec![4, 6]);
	}

	#[test]
	fn line_match_spans_count_utf16_units() {
		// `✓` is 3 bytes and 1 UTF-16 unit; `𝄞` is 4 bytes and 2 units.
		let m = core(&[r"(?<mark>\S) (?<name>\S+) (?<n>\d+)"]).match_lines("✓ lint 7\n𝄞 x 12");
		assert_eq!(m.spans, vec![0, 1, 2, 6, 7, 8, 0, 2, 3, 4, 5, 7]);
	}

	#[test]
	fn line_match_empty_patterns_match_nothing() {
		assert_eq!(core(&[]).match_lines("anything\n"), LineMatchColumns::default());
	}

	#[test]
	fn line_match_invalid_pattern_names_index() {
		let error = LineMatcherCore::new(&["ok".to_owned(), "x".to_owned(), "(".to_owned()])
			.err()
			.unwrap();
		assert!(error.starts_with("pattern 2: regex parse error"), "{error}");
		let error = LineMatcherCore::new(&["(".to_owned()]).err().unwrap();
		assert!(error.starts_with("pattern 0: regex parse error"), "{error}");
	}
}
