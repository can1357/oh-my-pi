//! Normalization of line prefixes copied from read/search output.

use super::format::is_snapshot_tag;
use crate::scan;

struct LinePrefix<'a> {
	number:           &'a str,
	body:             &'a str,
	is_diff_addition: bool,
}

/// Split a numbered row prefix like `>>> +12:` or `8|` from its body.
fn split_line_prefix(line: &str) -> Option<LinePrefix<'_>> {
	let line = line.trim_start();
	let line = line
		.strip_prefix(">>>")
		.or_else(|| line.strip_prefix(">>"))
		.map_or(line, str::trim_start);
	let plus = line.starts_with('+');
	let line = line
		.strip_prefix(['+', '*', '-'])
		.map_or(line, str::trim_start);
	let (number, rest) = scan::digits(line)?;
	let is_diff_addition = plus && rest.starts_with(':');
	let body = rest.strip_prefix([':', '|'])?;
	Some(LinePrefix { number, body, is_diff_addition })
}

/// Whether a row is a read/search header such as `[src/a.rs#1A2B]`.
fn is_numbered_file_header(line: &str) -> bool {
	let Some((path, tag)) = line
		.trim_start()
		.strip_prefix('[')
		.and_then(|line| line.split_once('#'))
	else {
		return false;
	};
	!path.is_empty()
		&& tag
			.trim_end()
			.strip_suffix(']')
			.is_some_and(is_snapshot_tag)
		&& !path.contains(['\r', '\n'])
}

/// Whether a row announces elision across a positive range, such as `4-12: …`.
fn is_read_range_elision(line: &str) -> bool {
	let Some((start, rest)) = scan::digits(line.trim_start()) else {
		return false;
	};
	if start.starts_with('0') {
		return false;
	}
	let Some((end, rest)) = rest
		.trim_start()
		.strip_prefix('-')
		.and_then(|tail| scan::digits(tail.trim_start()))
	else {
		return false;
	};
	!end.starts_with('0')
		&& rest
			.strip_prefix(':')
			.is_some_and(|body| (body.contains('…') || body.contains("...")) && !body.contains('\n'))
}

/// Whether a row consists only of an elision mark.
fn is_read_single_elision(line: &str) -> bool {
	matches!(line.trim(), "…" | "...")
}

/// Whether a row is a truncation notice emitted by `read`.
pub fn is_read_truncation_notice(line: &str) -> bool {
	let trimmed = line.trim();
	let Some(body) = trimmed.strip_circumfix('[', ']') else {
		return false;
	};
	let showing_notice = body.starts_with("Showing ")
		&& (body.contains(" line") || body.contains("lines ") || body.contains("bytes "))
		&& (body.contains(" of ") || body.contains(" elided"));
	let more_notice = (body.starts_with("More lines in ")
		|| body
			.split_once(" more line")
			.is_some_and(|(count, _)| count.parse::<usize>().is_ok()))
		&& body.contains(" in ")
		&& body.contains(". Use ")
		&& body.ends_with(" to continue");
	let elided_notice = (body.starts_with('…') || body.starts_with("..."))
		&& body.contains("ln elided;")
		&& body.contains("re-read needed ranges");
	let oversized_line_notice =
		body.starts_with("Line ") && body.contains(" exceeds ") && body.contains(" limit.");
	showing_notice || more_notice || elided_notice || oversized_line_notice
}

/// Whether a row is display-only metadata emitted by `read`.
pub fn is_read_metadata_line(line: &str) -> bool {
	is_read_truncation_notice(line) || is_read_range_elision(line) || is_read_single_elision(line)
}

/// Strip repeated numbered prefixes without copying the intermediate rows.
fn strip_leading_hashline_prefixes(mut line: &str) -> String {
	while let Some(prefix) = split_line_prefix(line) {
		line = prefix.body;
	}
	line.to_owned()
}

/// Strip at most one leading read/search line-number prefix.
pub fn strip_one_leading_hashline_prefix(line: &str) -> String {
	split_line_prefix(line)
		.map_or(line, |prefix| prefix.body)
		.to_owned()
}

#[derive(Default)]
struct LinePrefixStats {
	non_empty:                   usize,
	header_count:                usize,
	hash_prefix_count:           usize,
	diff_plus_hash_prefix_count: usize,
	diff_plus_count:             usize,
}

fn collect_line_prefix_stats(lines: &[String]) -> LinePrefixStats {
	let mut stats = LinePrefixStats::default();
	for line in lines {
		if line.is_empty() || is_read_metadata_line(line) {
			continue;
		}
		stats.non_empty += 1;
		if is_numbered_file_header(line) {
			stats.header_count += 1;
			continue;
		}
		if let Some(prefix) = split_line_prefix(line) {
			stats.hash_prefix_count += 1;
			stats.diff_plus_hash_prefix_count += usize::from(prefix.is_diff_addition);
		}
		if line.starts_with('+') && !line.starts_with("++") {
			stats.diff_plus_count += 1;
		}
	}
	stats
}

/// Opportunistically strip a consistent numbered or diff prefix scheme.
pub fn strip_new_line_prefixes(lines: &[String]) -> Vec<String> {
	let stats = collect_line_prefix_stats(lines);
	if stats.non_empty == 0 {
		return lines.to_vec();
	}
	let content_line_count = stats.non_empty - stats.header_count;
	let strip_hash = content_line_count > 0 && stats.hash_prefix_count == content_line_count;
	let strip_plus = !strip_hash
		&& stats.diff_plus_hash_prefix_count == 0
		&& stats.diff_plus_count > 0
		&& (stats.diff_plus_count as f64) >= (stats.non_empty as f64) * 0.5;
	if !strip_hash && !strip_plus && stats.diff_plus_hash_prefix_count == 0 {
		return lines.to_vec();
	}
	lines
		.iter()
		.filter_map(|line| {
			if is_read_metadata_line(line) || (strip_hash && is_numbered_file_header(line)) {
				return None;
			}
			if strip_hash {
				return Some(strip_leading_hashline_prefixes(line));
			}
			if strip_plus && line.starts_with('+') && !line.starts_with("++") {
				return Some(line[1..].to_string());
			}
			if stats.diff_plus_hash_prefix_count > 0
				&& let Some(prefix) = split_line_prefix(line)
				&& prefix.is_diff_addition
			{
				return Some(prefix.body.to_owned());
			}
			Some(line.clone())
		})
		.collect()
}

/// Whether each numbered row's number is one more than the row above it.
/// `read` and `grep` count up by one and mark every skip with a blank,
/// elision or header row, so a jump elsewhere means the numbers are content
/// (addresses in a hex dump, timestamps in a log) or a partial view such as
/// an edit preview, which is not a file's content either way.
fn numbers_count_up_by_one(lines: &[String]) -> bool {
	let mut previous: Option<u64> = None;
	for line in lines {
		if line.is_empty() || is_read_metadata_line(line) || is_numbered_file_header(line) {
			previous = None;
			continue;
		}
		let Some(number) =
			split_line_prefix(line).and_then(|prefix| prefix.number.parse::<u64>().ok())
		else {
			return false;
		};
		if previous.is_some_and(|previous| previous.checked_add(1) != Some(number)) {
			return false;
		}
		previous = Some(number);
	}
	true
}

/// Strip numbered prefixes only when every content row carries one and the
/// numbers run as read and search output number them.
pub fn strip_hashline_prefixes(lines: &[String]) -> Vec<String> {
	let stats = collect_line_prefix_stats(lines);
	if stats.non_empty == 0 {
		return lines.to_vec();
	}
	let content_line_count = stats.non_empty - stats.header_count;
	if content_line_count == 0
		|| stats.hash_prefix_count != content_line_count
		|| !numbers_count_up_by_one(lines)
	{
		return lines.to_vec();
	}
	lines
		.iter()
		.filter(|line| !is_read_metadata_line(line) && !is_numbered_file_header(line))
		.map(|line| strip_leading_hashline_prefixes(line))
		.collect()
}

/// Normalize a multiline text payload into unprefixed rows.
pub fn hashline_parse_text(edit: Option<&str>) -> Vec<String> {
	let Some(edit) = edit else {
		return Vec::new();
	};
	let trimmed = edit.strip_suffix('\n').unwrap_or(edit).replace('\r', "");
	strip_new_line_prefixes(&trimmed.split('\n').map(str::to_owned).collect::<Vec<_>>())
}

/// Normalize an existing row slice into unprefixed rows.
pub fn hashline_parse_lines(edit: Option<&[String]>) -> Vec<String> {
	edit.map_or_default(strip_new_line_prefixes)
}
