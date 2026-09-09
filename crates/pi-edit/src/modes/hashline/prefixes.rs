//! Normalization of line prefixes copied from read/search output.

use std::sync::LazyLock;

use regex::Regex;

static HL_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"^\s*(?:(?:>>>|>>)\s*)?(?:[+*-]\s*)?\d+[:|]").expect("valid regex")
});
static HL_PREFIX_PLUS_RE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\s*(?:(?:>>>|>>)\s*)?\+\s*\d+:").expect("valid regex"));
static HL_HEADER_RE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\s*\[[^#\r\n]+#[0-9a-fA-F]{4}\]\s*$").expect("valid regex"));
static READ_TRUNCATION_NOTICE_RE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
	r"^\s*\[(?:(?:Showing lines \d+-\d+ of \d+|\d+ more lines? in (?:file|\S+))\b.*\bUse :L?\d+|(?:…|\.\.\.)?\d+\s*ln elided;\s*re-read needed ranges with .+)\]\s*$",
).expect("valid regex")
});
static READ_RANGE_ELISION_RE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"^\s*[1-9]\d*\s*-\s*[1-9]\d*:.*(?:…|\.\.\.).*$").expect("valid regex")
});
static READ_SINGLE_ELISION_RE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\s*(?:…|\.\.\.)\s*$").expect("valid regex"));

/// Whether a row is display-only metadata emitted by `read`.
pub fn is_read_metadata_line(line: &str) -> bool {
	let trimmed = line.trim();
	let read_notice = trimmed.starts_with("[Showing lines ")
		&& trimmed.contains(" of ")
		&& trimmed.contains("Use :")
		&& trimmed.ends_with(']');
	let more_notice = trimmed.starts_with('[')
		&& trimmed.contains(" more line")
		&& trimmed.contains(" in ")
		&& trimmed.contains("Use :")
		&& trimmed.ends_with(']');
	let elided_notice = trimmed.starts_with('[')
		&& trimmed.contains("ln elided;")
		&& trimmed.contains("re-read needed ranges")
		&& trimmed.ends_with(']');
	read_notice
		|| more_notice
		|| elided_notice
		|| READ_TRUNCATION_NOTICE_RE.is_match(line)
		|| READ_RANGE_ELISION_RE.is_match(line)
		|| READ_SINGLE_ELISION_RE.is_match(line)
}

fn strip_leading_hashline_prefixes(line: &str) -> String {
	let mut result = line.to_string();
	loop {
		let next = HL_PREFIX_RE.replace(&result, "").into_owned();
		if next == result {
			return result;
		}
		result = next;
	}
}

/// Strip at most one leading read/search line-number prefix.
pub fn strip_one_leading_hashline_prefix(line: &str) -> String {
	HL_PREFIX_RE.replace(line, "").into_owned()
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
		if HL_HEADER_RE.is_match(line) {
			stats.header_count += 1;
			continue;
		}
		if HL_PREFIX_RE.is_match(line) {
			stats.hash_prefix_count += 1;
		}
		if HL_PREFIX_PLUS_RE.is_match(line) {
			stats.diff_plus_hash_prefix_count += 1;
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
			if is_read_metadata_line(line) || (strip_hash && HL_HEADER_RE.is_match(line)) {
				return None;
			}
			if strip_hash {
				return Some(strip_leading_hashline_prefixes(line));
			}
			if strip_plus && line.starts_with('+') && !line.starts_with("++") {
				return Some(line[1..].to_string());
			}
			if stats.diff_plus_hash_prefix_count > 0 && HL_PREFIX_PLUS_RE.is_match(line) {
				return Some(strip_one_leading_hashline_prefix(line));
			}
			Some(line.clone())
		})
		.collect()
}

/// Strip numbered prefixes only when every content row carries one.
pub fn strip_hashline_prefixes(lines: &[String]) -> Vec<String> {
	let stats = collect_line_prefix_stats(lines);
	if stats.non_empty == 0 {
		return lines.to_vec();
	}
	let content_line_count = stats.non_empty - stats.header_count;
	if content_line_count == 0 || stats.hash_prefix_count != content_line_count {
		return lines.to_vec();
	}
	lines
		.iter()
		.filter(|line| !is_read_metadata_line(line) && !HL_HEADER_RE.is_match(line))
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
	edit.map_or_else(Vec::new, strip_new_line_prefixes)
}
