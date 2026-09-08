//! Model-facing diff rendering and unified-diff hunk parsing.

use std::{collections::BTreeSet, sync::LazyLock};

use pi_ast::block::{EnclosingBoundaryOptions, LineRange, enclosing_block_boundaries};
use regex::Regex;

use crate::error::EditError;

const DIFF_GAP_ROW: &str = "";
const EOF_MARKER: &str = "*** End of File";
const CHANGE_CONTEXT_MARKER: &str = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER: &str = "@@";
const MULTI_FILE_MARKERS: [&str; 4] =
	["*** Update File:", "*** Add File:", "*** Delete File:", "diff --git "];
const DIFF_METADATA_PREFIXES: [&str; 15] = [
	"*** Update File:",
	"*** Add File:",
	"*** Delete File:",
	"diff --git ",
	"index ",
	"--- ",
	"+++ ",
	"new file mode ",
	"deleted file mode ",
	"rename from ",
	"rename to ",
	"similarity index ",
	"dissimilarity index ",
	"old mode ",
	"new mode ",
];
const PATCH_WRAPPER_PREFIXES: [&str; 2] = ["*** Begin Patch", "*** End Patch"];
const DEFAULT_ADDED_RUN_CONTEXT_LINES: usize = 2;
const PREVIEW_ELISION_MARKER: &str = "…";
const PREVIEW_GAP_ROW: &str = "";

/// Rendered diff plus the 1-indexed first changed line in the new text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiffOutput {
	/// Numbered diff rows.
	pub diff:               String,
	/// First line affected in the new text.
	pub first_changed_line: Option<u32>,
}

/// Where the source came from, so tree-sitter can pick a grammar.
#[derive(Debug, Clone, Default)]
pub struct BlockContextSource<'a> {
	/// File path used for language inference.
	pub path: Option<&'a str>,
	/// Explicit language alias.
	pub lang: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiffPrefix {
	Added,
	Removed,
	Context,
}

#[derive(Debug)]
struct ParsedNumberedDiffRow {
	prefix:      DiffPrefix,
	line_number: u32,
}

fn format_numbered_diff_line(prefix: char, line_number: u32, content: &str) -> String {
	format!("{prefix}{line_number}|{content}")
}

fn parse_numbered_diff_row(row: &str) -> Option<ParsedNumberedDiffRow> {
	let (prefix, body) = match row.as_bytes().first().copied()? {
		b'+' => (DiffPrefix::Added, &row[1..]),
		b'-' => (DiffPrefix::Removed, &row[1..]),
		b' ' => (DiffPrefix::Context, &row[1..]),
		_ => return None,
	};
	let separator = body.find('|')?;
	let line_number = body[..separator].parse().ok()?;
	Some(ParsedNumberedDiffRow { prefix, line_number })
}

fn is_diff_change_row(row: Option<&String>) -> bool {
	row.is_some_and(|value| value.starts_with('+') || value.starts_with('-'))
}

fn parse_source_row_line_number(row: &str) -> Option<u32> {
	let parsed = parse_numbered_diff_row(row)?;
	(parsed.prefix != DiffPrefix::Added).then_some(parsed.line_number)
}

fn normalize_diff_gap_rows(rows: &mut Vec<String>) {
	let mut kept = Vec::with_capacity(rows.len());
	for (index, row) in rows.iter().enumerate() {
		if row != DIFF_GAP_ROW {
			kept.push(row.clone());
			continue;
		}
		if kept.is_empty() || kept.last().is_some_and(String::is_empty) {
			continue;
		}
		let before = kept
			.iter()
			.rev()
			.find_map(|candidate| parse_source_row_line_number(candidate));
		let after = rows[index + 1..]
			.iter()
			.filter(|candidate| !candidate.is_empty())
			.find_map(|candidate| parse_source_row_line_number(candidate));
		if matches!((before, after), (Some(left), Some(right)) if right > left + 1) {
			kept.push(String::new());
		}
	}
	*rows = kept;
}

fn adjusted_context_insert_index(rows: &[String], index: usize) -> usize {
	let mut start = index;
	while start > 0 && is_diff_change_row(rows.get(start - 1)) {
		start -= 1;
	}
	let mut end = index;
	while end < rows.len() && is_diff_change_row(rows.get(end)) {
		end += 1;
	}
	if index > start && index < end {
		end
	} else {
		index
	}
}

fn insert_bracket_context_rows(
	rows: &mut Vec<String>,
	context_lines: Vec<(u32, String)>,
	seen_rows: &mut BTreeSet<String>,
) {
	for (line_number, text) in context_lines {
		let row = format_numbered_diff_line(' ', line_number, &text);
		if seen_rows.contains(&row) {
			continue;
		}

		let mut insert_index = rows.len();
		let mut previous_source_line = None;
		let mut next_source_line = None;
		for (index, candidate) in rows.iter().enumerate() {
			let Some(parsed) = parse_numbered_diff_row(candidate) else {
				continue;
			};
			if parsed.prefix == DiffPrefix::Added {
				continue;
			}
			if parsed.line_number < line_number {
				previous_source_line = Some(parsed.line_number);
				continue;
			}
			next_source_line = Some(parsed.line_number);
			insert_index = index;
			break;
		}

		let mut chunk = Vec::with_capacity(3);
		if previous_source_line.is_some_and(|previous| line_number > previous + 1) {
			chunk.push(String::new());
		}
		chunk.push(row.clone());
		if next_source_line.is_some_and(|next| next > line_number + 1) {
			chunk.push(String::new());
		}

		let insert_index = adjusted_context_insert_index(rows, insert_index);
		rows.splice(insert_index..insert_index, chunk);
		seen_rows.insert(row);
	}
}

fn add_matching_bracket_context_rows(
	rows: &mut Vec<String>,
	old_lines: &[&str],
	new_lines: &[&str],
	source: &BlockContextSource<'_>,
) {
	let mut old_visible = Vec::new();
	let mut new_visible = Vec::new();
	let mut seen_rows = rows.iter().cloned().collect::<BTreeSet<_>>();
	let mut changes: Vec<(i64, i64)> = Vec::new();
	let mut offset = 0_i64;

	for row in rows.iter() {
		let Some(parsed) = parse_numbered_diff_row(row) else {
			continue;
		};
		match parsed.prefix {
			DiffPrefix::Removed => {
				old_visible.push(parsed.line_number);
				changes.push((i64::from(parsed.line_number) + offset, -1));
				offset -= 1;
			},
			DiffPrefix::Added => {
				new_visible.push(parsed.line_number);
				changes.push((i64::from(parsed.line_number), 1));
				offset += 1;
			},
			DiffPrefix::Context => {
				old_visible.push(parsed.line_number);
				let shifted = i64::from(parsed.line_number) + offset;
				if let Ok(line) = u32::try_from(shifted) {
					new_visible.push(line);
				}
			},
		}
	}

	let to_old_line_number = |new_line_number: u32| {
		let new_line_number = i64::from(new_line_number);
		let shift: i64 = changes
			.iter()
			.filter(|(new_position, _)| *new_position <= new_line_number)
			.map(|(_, delta)| delta)
			.sum();
		u32::try_from(new_line_number - shift).ok()
	};

	let mut context_rows = find_block_context_lines(old_lines, &old_visible, source)
		.into_iter()
		.collect::<std::collections::BTreeMap<_, _>>();
	for (line_number, text) in find_block_context_lines(new_lines, &new_visible, source) {
		if let Some(old_line_number) = to_old_line_number(line_number) {
			context_rows.entry(old_line_number).or_insert(text);
		}
	}
	insert_bracket_context_rows(rows, context_rows.into_iter().collect(), &mut seen_rows);
	normalize_diff_gap_rows(rows);
}

/// Generate a numbered diff with nearby and enclosing-block context.
pub fn generate_diff_string(
	old: &str,
	new: &str,
	context_lines: Option<usize>,
	source: &BlockContextSource<'_>,
) -> DiffOutput {
	let parts = pi_diff::line_changes_str(old, new);
	let context_lines = context_lines.unwrap_or(2);
	let mut output = Vec::new();
	let mut old_line_number = 1_u32;
	let mut new_line_number = 1_u32;
	let mut last_was_change = false;
	let mut first_changed_line = None;

	for (index, part) in parts.iter().enumerate() {
		let mut raw = part.value.split('\n').collect::<Vec<_>>();
		if raw.last() == Some(&"") {
			raw.pop();
		}

		if part.added || part.removed {
			first_changed_line.get_or_insert(new_line_number);
			for line in raw {
				if part.added {
					output.push(format_numbered_diff_line('+', new_line_number, line));
					new_line_number += 1;
				} else {
					output.push(format_numbered_diff_line('-', old_line_number, line));
					old_line_number += 1;
				}
			}
			last_was_change = true;
		} else {
			let next_part_is_change = parts
				.get(index + 1)
				.is_some_and(|next| next.added || next.removed);
			if last_was_change || next_part_is_change {
				let mut leading_skip = 0;
				let mut middle_skip = 0;
				let mut trailing_skip = 0;
				let lines_to_show;

				if last_was_change && next_part_is_change {
					if raw.len() > context_lines * 2 {
						middle_skip = raw.len() - context_lines * 2;
						lines_to_show = raw[..context_lines]
							.iter()
							.chain(&raw[raw.len() - context_lines..])
							.copied()
							.collect::<Vec<_>>();
					} else {
						lines_to_show = raw.clone();
					}
				} else if next_part_is_change {
					leading_skip = raw.len().saturating_sub(context_lines);
					lines_to_show = raw[leading_skip..].to_vec();
				} else {
					trailing_skip = raw.len().saturating_sub(context_lines);
					lines_to_show = raw[..raw.len().min(context_lines)].to_vec();
				}

				old_line_number += u32::try_from(leading_skip).unwrap_or(u32::MAX);
				new_line_number += u32::try_from(leading_skip).unwrap_or(u32::MAX);
				let first_chunk_length = if middle_skip > 0 {
					context_lines
				} else {
					lines_to_show.len()
				};
				for line in &lines_to_show[..first_chunk_length] {
					output.push(format_numbered_diff_line(' ', old_line_number, line));
					old_line_number += 1;
					new_line_number += 1;
				}
				if middle_skip > 0 {
					old_line_number += u32::try_from(middle_skip).unwrap_or(u32::MAX);
					new_line_number += u32::try_from(middle_skip).unwrap_or(u32::MAX);
					for line in &lines_to_show[first_chunk_length..] {
						output.push(format_numbered_diff_line(' ', old_line_number, line));
						old_line_number += 1;
						new_line_number += 1;
					}
				}
				old_line_number += u32::try_from(trailing_skip).unwrap_or(u32::MAX);
				new_line_number += u32::try_from(trailing_skip).unwrap_or(u32::MAX);
			} else {
				let skipped = u32::try_from(raw.len()).unwrap_or(u32::MAX);
				old_line_number += skipped;
				new_line_number += skipped;
			}
			last_was_change = false;
		}
	}

	let old_lines = old.split('\n').collect::<Vec<_>>();
	let new_lines = new.split('\n').collect::<Vec<_>>();
	add_matching_bracket_context_rows(&mut output, &old_lines, &new_lines, source);
	DiffOutput { diff: output.join("\n"), first_changed_line }
}

/// Generate numbered unified hunks without file headers.
pub fn generate_unified_diff_string(
	old: &str,
	new: &str,
	context_lines: Option<usize>,
	source: &BlockContextSource<'_>,
) -> DiffOutput {
	let old_utf16 = old.encode_utf16().collect::<Vec<_>>();
	let new_utf16 = new.encode_utf16().collect::<Vec<_>>();
	let context_lines = context_lines.unwrap_or(3);
	let hunks = pi_diff::structured_patch_hunks_u16(
		&old_utf16,
		&new_utf16,
		Some(u32::try_from(context_lines).unwrap_or(u32::MAX)),
	);
	let mut output = Vec::new();
	let mut first_changed_line = None;
	for hunk in hunks {
		output.push(format!(
			"@@ -{},{} +{},{} @@",
			hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
		));
		let mut old_line = hunk.old_start;
		let mut new_line = hunk.new_start;
		for encoded in hunk.lines {
			let line = String::from_utf16(&encoded).expect("hunk text originates from valid UTF-8");
			if let Some(content) = line.strip_prefix('-') {
				first_changed_line.get_or_insert(new_line);
				output.push(format_numbered_diff_line('-', old_line, content));
				old_line += 1;
			} else if let Some(content) = line.strip_prefix('+') {
				first_changed_line.get_or_insert(new_line);
				output.push(format_numbered_diff_line('+', new_line, content));
				new_line += 1;
			} else if let Some(content) = line.strip_prefix(' ') {
				output.push(format_numbered_diff_line(' ', old_line, content));
				old_line += 1;
				new_line += 1;
			} else {
				output.push(line);
			}
		}
	}
	let old_lines = old.split('\n').collect::<Vec<_>>();
	let new_lines = new.split('\n').collect::<Vec<_>>();
	add_matching_bracket_context_rows(&mut output, &old_lines, &new_lines, source);
	DiffOutput { diff: output.join("\n"), first_changed_line }
}

#[derive(Clone, Copy, Debug)]
struct LineSpan {
	start_line: u32,
	end_line:   u32,
}

fn visible_set_to_spans(visible: &BTreeSet<u32>) -> Vec<LineSpan> {
	let mut spans: Vec<LineSpan> = Vec::new();
	for &line in visible {
		if let Some(previous) = spans.last_mut()
			&& line <= previous.end_line.saturating_add(1)
		{
			previous.end_line = line;
		} else {
			spans.push(LineSpan { start_line: line, end_line: line });
		}
	}
	spans
}

fn native_block_context(
	full_lines: &[&str],
	visible: &BTreeSet<u32>,
	source: &BlockContextSource<'_>,
) -> Option<Vec<(u32, String)>> {
	if source.path.is_none() && source.lang.is_none() {
		return None;
	}
	let ranges = visible_set_to_spans(visible);
	if ranges.is_empty() {
		return Some(Vec::new());
	}
	let options = EnclosingBoundaryOptions {
		code:   full_lines.join("\n"),
		lang:   source.lang.map(str::to_owned),
		path:   source.path.map(str::to_owned),
		ranges: ranges
			.into_iter()
			.map(|range| LineRange { start_line: range.start_line, end_line: range.end_line })
			.collect(),
	};
	let boundaries = enclosing_block_boundaries(options).ok()??;
	Some(
		boundaries
			.into_iter()
			.filter(|line_number| !visible.contains(line_number))
			.map(|line_number| {
				let text = usize::try_from(line_number - 1)
					.ok()
					.and_then(|index| full_lines.get(index))
					.copied()
					.unwrap_or_default()
					.to_owned();
				(line_number, text)
			})
			.collect(),
	)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScannerMode {
	Code,
	Single,
	Double,
	Template,
	BlockComment,
}

#[derive(Debug)]
struct StackEntry {
	opener:      char,
	line_number: u32,
	text:        String,
	visible:     bool,
}

fn is_hash_comment_start(line: &str, byte_index: usize) -> bool {
	line.as_bytes().get(byte_index) == Some(&b'#')
		&& line.as_bytes()[..byte_index]
			.iter()
			.all(|byte| matches!(byte, b' ' | b'\t'))
}

fn lexical_bracket_context(full_lines: &[&str], visible: &BTreeSet<u32>) -> Vec<(u32, String)> {
	let mut context = std::collections::BTreeMap::new();
	let mut stack: Vec<StackEntry> = Vec::new();
	let mut mode = ScannerMode::Code;
	let mut escaped = false;

	for (line_index, &line) in full_lines.iter().enumerate() {
		let line_number = u32::try_from(line_index + 1).unwrap_or(u32::MAX);
		let line_visible = visible.contains(&line_number);
		let mut chars = line.char_indices().peekable();
		while let Some((byte_index, character)) = chars.next() {
			let next = chars.peek().map(|(_, value)| *value);
			if mode == ScannerMode::BlockComment {
				if character == '*' && next == Some('/') {
					mode = ScannerMode::Code;
					chars.next();
				}
				continue;
			}
			if matches!(mode, ScannerMode::Single | ScannerMode::Double | ScannerMode::Template) {
				if escaped {
					escaped = false;
					continue;
				}
				if character == '\\' {
					escaped = true;
					continue;
				}
				if (mode == ScannerMode::Single && character == '\'')
					|| (mode == ScannerMode::Double && character == '"')
					|| (mode == ScannerMode::Template && character == '`')
				{
					mode = ScannerMode::Code;
				}
				continue;
			}
			if character == '/' && next == Some('/') {
				break;
			}
			if character == '/' && next == Some('*') {
				mode = ScannerMode::BlockComment;
				chars.next();
				continue;
			}
			if character == '#' && is_hash_comment_start(line, byte_index) {
				break;
			}
			if character == '\'' {
				mode = ScannerMode::Single;
				escaped = false;
				continue;
			}
			if character == '"' {
				mode = ScannerMode::Double;
				escaped = false;
				continue;
			}
			if character == '`' {
				mode = ScannerMode::Template;
				escaped = false;
				continue;
			}
			if matches!(character, '(' | '[' | '{') {
				stack.push(StackEntry {
					opener: character,
					line_number,
					text: line.to_owned(),
					visible: line_visible,
				});
				continue;
			}
			let opener = match character {
				')' => Some('('),
				']' => Some('['),
				'}' => Some('{'),
				_ => None,
			};
			if let Some(opener) = opener
				&& let Some(match_index) = stack.iter().rposition(|entry| entry.opener == opener)
			{
				let matched = stack.remove(match_index);
				stack.truncate(match_index);
				if line_visible && !matched.visible {
					context.insert(matched.line_number, matched.text);
				}
				if matched.visible && !line_visible {
					context.insert(line_number, line.to_owned());
				}
			}
		}
		if matches!(mode, ScannerMode::Single | ScannerMode::Double) {
			mode = ScannerMode::Code;
			escaped = false;
		}
	}
	for line_number in visible {
		context.remove(line_number);
	}
	context.into_iter().collect()
}

/// Resolve off-window block-boundary lines for a visible window.
pub fn find_block_context_lines(
	full_lines: &[&str],
	visible: &[u32],
	source: &BlockContextSource<'_>,
) -> Vec<(u32, String)> {
	let visible = visible.iter().copied().collect::<BTreeSet<_>>();
	if visible.is_empty() || (!full_lines.is_empty() && visible.len() >= full_lines.len()) {
		return Vec::new();
	}
	native_block_context(full_lines, &visible, source)
		.unwrap_or_else(|| lexical_bracket_context(full_lines, &visible))
}

/// Compact preview of a numbered diff for the model-visible result.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CompactDiffPreview {
	/// Current-file numbered preview.
	pub preview:       String,
	/// Number of added rows in the source diff.
	pub added_lines:   usize,
	/// Number of removed rows in the source diff.
	pub removed_lines: usize,
}

/// Options for [`build_compact_diff_preview`].
#[derive(Debug, Clone, Default)]
pub struct CompactDiffOptions {
	/// Added lines kept on each side of a long added run.
	pub max_added_run_context: Option<usize>,
	/// Back-compatible alias for `max_added_run_context`.
	pub max_unchanged_run:     Option<usize>,
}

fn is_preview_separator(line: &str) -> bool {
	line == PREVIEW_ELISION_MARKER || line == PREVIEW_GAP_ROW
}

fn append_preview_line(output: &mut Vec<String>, line: &str) {
	let normalized = if matches!(line, "..." | PREVIEW_ELISION_MARKER | "+…") {
		PREVIEW_ELISION_MARKER
	} else {
		line
	};
	if is_preview_separator(normalized)
		&& (output.is_empty() || output.last().is_some_and(|last| is_preview_separator(last)))
	{
		return;
	}
	output.push(normalized.to_owned());
}

#[derive(Debug)]
struct ParsedCompactDiffLine<'a> {
	kind:        DiffPrefix,
	line_number: i64,
	content:     &'a str,
}

fn parse_integer_prefix(value: &str) -> Option<i64> {
	let value = value.trim_start();
	let (negative, digits) = if let Some(rest) = value.strip_prefix('-') {
		(true, rest)
	} else if let Some(rest) = value.strip_prefix('+') {
		(false, rest)
	} else {
		(false, value)
	};
	let digit_count = digits.bytes().take_while(u8::is_ascii_digit).count();
	if digit_count == 0 {
		return None;
	}
	let magnitude = digits[..digit_count].parse::<i64>().ok()?;
	if negative {
		magnitude.checked_neg()
	} else {
		Some(magnitude)
	}
}

fn parse_compact_diff_line(line: &str) -> Option<ParsedCompactDiffLine<'_>> {
	let (kind, body) = match line.as_bytes().first().copied()? {
		b'+' => (DiffPrefix::Added, &line[1..]),
		b'-' => (DiffPrefix::Removed, &line[1..]),
		b' ' => (DiffPrefix::Context, &line[1..]),
		_ => return None,
	};
	let separator = body.find('|')?;
	let line_number = parse_integer_prefix(&body[..separator])?;
	Some(ParsedCompactDiffLine { kind, line_number, content: &body[separator + 1..] })
}

fn append_added_run(output: &mut Vec<String>, run: &[String], edge_lines: usize) {
	if run.is_empty() {
		return;
	}
	let collapse_threshold = edge_lines * 2 + 1;
	if run.len() <= collapse_threshold {
		for line in run {
			append_preview_line(output, line);
		}
		return;
	}
	for line in &run[..edge_lines] {
		append_preview_line(output, line);
	}
	append_preview_line(output, PREVIEW_ELISION_MARKER);
	for line in &run[run.len() - edge_lines..] {
		append_preview_line(output, line);
	}
}

/// Build a compact current-file preview from numbered diff rows.
pub fn build_compact_diff_preview(diff: &str, options: &CompactDiffOptions) -> CompactDiffPreview {
	let lines = if diff.is_empty() {
		Vec::new()
	} else {
		diff.split('\n').collect::<Vec<_>>()
	};
	let added_run_context = options
		.max_added_run_context
		.or(options.max_unchanged_run)
		.unwrap_or(DEFAULT_ADDED_RUN_CONTEXT_LINES)
		.max(1);
	let mut added_lines = 0_usize;
	let mut removed_lines = 0_usize;
	let mut formatted = Vec::new();
	let mut added_run = Vec::new();

	for line in lines {
		let Some(parsed) = parse_compact_diff_line(line) else {
			append_added_run(&mut formatted, &added_run, added_run_context);
			added_run.clear();
			append_preview_line(&mut formatted, line);
			continue;
		};
		match parsed.kind {
			DiffPrefix::Added => {
				added_lines += 1;
				added_run.push(format!("{}:{}", parsed.line_number, parsed.content));
			},
			DiffPrefix::Removed => {
				append_added_run(&mut formatted, &added_run, added_run_context);
				added_run.clear();
				removed_lines += 1;
			},
			DiffPrefix::Context => {
				append_added_run(&mut formatted, &added_run, added_run_context);
				added_run.clear();
				let new_line_number = parsed.line_number
					+ i64::try_from(added_lines).unwrap_or(i64::MAX)
					- i64::try_from(removed_lines).unwrap_or(i64::MAX);
				append_preview_line(&mut formatted, &format!("{new_line_number}:{}", parsed.content));
			},
		}
	}
	append_added_run(&mut formatted, &added_run, added_run_context);
	while formatted
		.last()
		.is_some_and(|line| is_preview_separator(line))
	{
		formatted.pop();
	}
	CompactDiffPreview { preview: formatted.join("\n"), added_lines, removed_lines }
}

/// One hunk of a `patch`-mode diff body.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiffHunk {
	/// Optional textual or symbolic hunk anchor.
	pub change_context:    Option<String>,
	/// Optional 1-indexed old-file line hint.
	pub old_start_line:    Option<u32>,
	/// Optional 1-indexed new-file line hint.
	pub new_start_line:    Option<u32>,
	/// Whether the hunk contains unchanged context.
	pub has_context_lines: bool,
	/// Expected old-file lines.
	pub old_lines:         Vec<String>,
	/// Replacement new-file lines.
	pub new_lines:         Vec<String>,
	/// Whether the hunk carries an end-of-file marker.
	pub is_end_of_file:    bool,
}

fn is_diff_content_line(line: &str) -> bool {
	match line.as_bytes().first() {
		Some(b' ') => true,
		Some(b'+') => !line.starts_with("+++ "),
		Some(b'-') => !line.starts_with("--- "),
		_ => false,
	}
}

fn matches_trimmed_prefix(line: &str, prefixes: &[&str]) -> bool {
	prefixes.iter().any(|prefix| line.starts_with(prefix))
}

fn is_patch_wrapper_line(line: &str) -> bool {
	line == "***" || matches_trimmed_prefix(line, &PATCH_WRAPPER_PREFIXES)
}

/// Strip wrapper/metadata lines and trailing blank rows from a diff body.
pub fn normalize_diff(diff: &str) -> String {
	let mut lines = diff.split('\n').collect::<Vec<_>>();
	while let Some(last_line) = lines.last().copied() {
		if last_line.is_empty() || (last_line.trim().is_empty() && !is_diff_content_line(last_line)) {
			lines.pop();
		} else {
			break;
		}
	}
	if lines
		.first()
		.is_some_and(|line| is_patch_wrapper_line(line.trim()))
	{
		lines.remove(0);
	}
	if lines
		.last()
		.is_some_and(|line| is_patch_wrapper_line(line.trim()))
	{
		lines.pop();
	}
	lines.retain(|line| {
		is_diff_content_line(line) || !matches_trimmed_prefix(line.trim(), &DIFF_METADATA_PREFIXES)
	});
	lines.join("\n")
}

/// Strip a uniform `+` prefix from create-file content.
pub fn normalize_create_content(content: &str) -> String {
	let lines = content.split('\n').collect::<Vec<_>>();
	let non_empty_lines = lines
		.iter()
		.filter(|line| !line.is_empty())
		.collect::<Vec<_>>();
	if !non_empty_lines.is_empty() && non_empty_lines.iter().all(|line| line.starts_with('+')) {
		return lines
			.into_iter()
			.map(|line| {
				line
					.strip_prefix("+ ")
					.or_else(|| line.strip_prefix('+'))
					.unwrap_or(line)
			})
			.collect::<Vec<_>>()
			.join("\n");
	}
	content.to_owned()
}

#[derive(Debug)]
struct UnifiedHunkHeader {
	old_start_line: u32,
	new_start_line: u32,
	change_context: Option<String>,
}

static UNIFIED_HUNK_HEADER_REGEX: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@(?:\s*(.*))?$")
		.expect("valid unified hunk header regex")
});
static LINE_HINT_REGEX: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"(?i)^lines?\s+(\d+)(?:\s*-\s*(\d+))?(?:\s*@@)?$").expect("valid line hint regex")
});
static TOP_OF_FILE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"(?i)^(top|start|beginning)\s+of\s+file$").expect("valid top-of-file regex")
});
static NUMBERED_LINE_REGEX: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\s*(\d{1,6})\s+(.+)$").expect("valid numbered-line regex"));

fn parse_unified_hunk_header(line: &str) -> Option<UnifiedHunkHeader> {
	let captures = UNIFIED_HUNK_HEADER_REGEX.captures(line)?;
	let old_start_line = captures.get(1)?.as_str().parse().ok()?;
	let new_start_line = captures.get(3)?.as_str().parse().ok()?;
	let change_context = captures
		.get(5)
		.map(|value| value.as_str().trim())
		.filter(|value| !value.is_empty())
		.map(str::to_owned);
	Some(UnifiedHunkHeader { old_start_line, new_start_line, change_context })
}

fn parse_error(message: impl AsRef<str>, line_number: u32) -> EditError {
	EditError::Parse {
		message: format!("Line {line_number}: {}", message.as_ref()),
		line:    Some(line_number),
	}
}

fn strip_line_number_prefixes(hunk: &mut DiffHunk) {
	let all_lines = hunk
		.old_lines
		.iter()
		.chain(&hunk.new_lines)
		.filter(|line| !line.trim().is_empty())
		.collect::<Vec<_>>();
	if all_lines.len() < 2 {
		return;
	}
	let number_matches = all_lines
		.iter()
		.filter_map(|line| NUMBERED_LINE_REGEX.captures(line))
		.collect::<Vec<_>>();
	// Math.ceil(length * 0.6), without floating point.
	let minimum_matches = 2_usize.max((all_lines.len() * 6).div_ceil(10));
	if number_matches.len() < minimum_matches {
		return;
	}
	let numbers = number_matches
		.iter()
		.filter_map(|captures| captures.get(1)?.as_str().parse::<u32>().ok())
		.collect::<Vec<_>>();
	let sequential = numbers
		.windows(2)
		.filter(|pair| pair[1] == pair[0] + 1)
		.count();
	if numbers.len() >= 3 && sequential < 1_usize.max(numbers.len() - 2) {
		return;
	}
	let strip = |line: &String| {
		NUMBERED_LINE_REGEX
			.captures(line)
			.and_then(|captures| captures.get(2).map(|value| value.as_str().to_owned()))
			.unwrap_or_else(|| line.clone())
	};
	hunk.old_lines = hunk.old_lines.iter().map(strip).collect();
	hunk.new_lines = hunk.new_lines.iter().map(strip).collect();
}

struct ParseHunkResult {
	hunk:           DiffHunk,
	lines_consumed: usize,
}

fn parse_one_hunk(
	lines: &[&str],
	line_number: u32,
	allow_missing_context: bool,
) -> Result<ParseHunkResult, EditError> {
	if lines.is_empty() {
		return Err(parse_error("Diff does not contain any lines", line_number));
	}
	let mut change_contexts = Vec::new();
	let mut old_start_line = None;
	let mut new_start_line = None;
	let mut start_index;
	let header_line = lines[0];
	let header_trimmed = header_line.trim_end();
	let is_header_line = header_line.starts_with("@@");
	let unified_header = is_header_line
		.then(|| parse_unified_hunk_header(header_trimmed))
		.flatten();
	let is_empty_context_marker = header_trimmed
		.strip_prefix("@@")
		.and_then(|rest| rest.strip_suffix("@@"))
		.is_some_and(|middle| middle.trim().is_empty());

	if is_header_line && (header_trimmed == EMPTY_CHANGE_CONTEXT_MARKER || is_empty_context_marker) {
		start_index = 1;
	} else if let Some(unified_header) = unified_header {
		if unified_header.old_start_line < 1 || unified_header.new_start_line < 1 {
			return Err(parse_error("Line numbers in @@ header must be >= 1", line_number));
		}
		if let Some(change_context) = unified_header.change_context {
			change_contexts.push(change_context);
		}
		old_start_line = Some(unified_header.old_start_line);
		new_start_line = Some(unified_header.new_start_line);
		start_index = 1;
	} else if is_header_line && header_trimmed.starts_with(CHANGE_CONTEXT_MARKER) {
		let context_value = &header_trimmed[CHANGE_CONTEXT_MARKER.len()..];
		let trimmed_context_value = context_value.trim();
		let normalized_context_value = trimmed_context_value
			.strip_prefix("@@")
			.map_or(trimmed_context_value, str::trim_start);
		if let Some(captures) = LINE_HINT_REGEX.captures(normalized_context_value) {
			let value = captures
				.get(1)
				.expect("line hint capture")
				.as_str()
				.parse::<u32>()
				.unwrap_or(0);
			old_start_line = Some(value);
			new_start_line = Some(value);
			if value < 1 {
				return Err(parse_error("Line hint must be >= 1", line_number));
			}
		} else if TOP_OF_FILE_REGEX.is_match(normalized_context_value) {
			old_start_line = Some(1);
			new_start_line = Some(1);
		} else if !trimmed_context_value.is_empty() {
			change_contexts.push(context_value.to_owned());
		}
		start_index = 1;
	} else if is_header_line {
		let context_value = header_trimmed[2..].trim();
		if !context_value.is_empty() {
			change_contexts.push(context_value.to_owned());
		}
		start_index = 1;
	} else {
		if !allow_missing_context {
			return Err(parse_error(
				format!("Expected hunk to start with @@ context marker, got: '{}'", lines[0]),
				line_number,
			));
		}
		start_index = 0;
	}

	if old_start_line.is_some_and(|value| value < 1) {
		return Err(parse_error(
			format!("Line numbers must be >= 1 (got {})", old_start_line.unwrap_or_default()),
			line_number,
		));
	}
	if new_start_line.is_some_and(|value| value < 1) {
		return Err(parse_error(
			format!("Line numbers must be >= 1 (got {})", new_start_line.unwrap_or_default()),
			line_number,
		));
	}

	while start_index < lines.len() {
		let next_line = lines[start_index];
		if !next_line.starts_with("@@") {
			break;
		}
		let trimmed = next_line.trim_end();
		if let Some(nested_context) = trimmed.strip_prefix(CHANGE_CONTEXT_MARKER) {
			if !nested_context.trim().is_empty() {
				change_contexts.push(nested_context.to_owned());
			}
			start_index += 1;
		} else if trimmed == EMPTY_CHANGE_CONTEXT_MARKER {
			start_index += 1;
		} else {
			break;
		}
	}
	if start_index >= lines.len() {
		return Err(parse_error("Hunk does not contain any lines", line_number + 1));
	}

	let mut hunk = DiffHunk {
		change_context: (!change_contexts.is_empty()).then(|| change_contexts.join("\n")),
		old_start_line,
		new_start_line,
		..DiffHunk::default()
	};
	let mut parsed_lines = 0_usize;
	for index in start_index..lines.len() {
		let line = lines[index];
		let trimmed = line.trim();
		let next_line = lines.get(index + 1).copied();
		if line.is_empty()
			&& parsed_lines > 0
			&& next_line.is_some_and(|next| next.trim_start().starts_with("@@"))
		{
			break;
		}
		if !is_diff_content_line(line)
			&& line.trim_end() == EOF_MARKER
			&& line.starts_with(EOF_MARKER)
		{
			if parsed_lines == 0 {
				return Err(parse_error("Hunk does not contain any lines", line_number + 1));
			}
			hunk.is_end_of_file = true;
			parsed_lines += 1;
			break;
		}
		if matches!(trimmed, "..." | "…") {
			hunk.has_context_lines = true;
			parsed_lines += 1;
			continue;
		}
		match line.as_bytes().first().copied() {
			None => {
				hunk.has_context_lines = true;
				hunk.old_lines.push(String::new());
				hunk.new_lines.push(String::new());
			},
			Some(b' ') => {
				hunk.has_context_lines = true;
				hunk.old_lines.push(line[1..].to_owned());
				hunk.new_lines.push(line[1..].to_owned());
			},
			Some(b'+') => hunk.new_lines.push(line[1..].to_owned()),
			Some(b'-') => hunk.old_lines.push(line[1..].to_owned()),
			_ if !line.starts_with("@@") => {
				hunk.has_context_lines = true;
				hunk.old_lines.push(line.to_owned());
				hunk.new_lines.push(line.to_owned());
			},
			_ if parsed_lines == 0 => {
				return Err(parse_error(
					format!(
						"Unexpected line in hunk: '{line}'. Lines must start with ' ' (context), '+' \
						 (add), or '-' (remove)"
					),
					line_number + 1,
				));
			},
			_ => break,
		}
		parsed_lines += 1;
	}
	if parsed_lines == 0 {
		return Err(parse_error(
			"Hunk does not contain any lines",
			line_number + u32::try_from(start_index).unwrap_or(u32::MAX),
		));
	}
	strip_line_number_prefixes(&mut hunk);
	Ok(ParseHunkResult { hunk, lines_consumed: parsed_lines + start_index })
}

fn extract_marker_path(line: &str) -> Option<String> {
	if let Some(rest) = line.strip_prefix("diff --git ") {
		let parts = rest.split_whitespace().collect::<Vec<_>>();
		let candidate = parts.get(1).or_else(|| parts.first())?;
		return Some(
			candidate
				.strip_prefix("a/")
				.or_else(|| candidate.strip_prefix("b/"))
				.unwrap_or(candidate)
				.to_string(),
		);
	}
	for marker in &MULTI_FILE_MARKERS[..3] {
		if let Some(path) = line.strip_prefix(marker) {
			return Some(path.trim().to_owned());
		}
	}
	None
}

fn count_multi_file_markers(diff: &str) -> usize {
	let mut counts = std::collections::BTreeMap::<&str, usize>::new();
	let mut paths = BTreeSet::new();
	for line in diff.split('\n') {
		if is_diff_content_line(line) {
			continue;
		}
		let trimmed = line.trim();
		for marker in MULTI_FILE_MARKERS {
			if trimmed.starts_with(marker) {
				if let Some(path) = extract_marker_path(trimmed)
					&& !path.is_empty()
				{
					paths.insert(path);
				}
				*counts.entry(marker).or_default() += 1;
				break;
			}
		}
	}
	if paths.is_empty() {
		counts.values().copied().max().unwrap_or_default()
	} else {
		paths.len()
	}
}

fn is_unified_diff_metadata_line(line: &str) -> bool {
	DIFF_METADATA_PREFIXES
		.iter()
		.filter(|prefix| !prefix.starts_with("*** "))
		.any(|prefix| line.starts_with(prefix))
}

/// Parse a diff body into hunks.
pub fn parse_diff_hunks(diff: &str) -> Result<Vec<DiffHunk>, EditError> {
	let multi_file_count = count_multi_file_markers(diff);
	if multi_file_count > 1 {
		return Err(EditError::Apply(format!(
			"Diff contains {multi_file_count} file markers. Single-file patches cannot contain \
			 multi-file markers."
		)));
	}
	let normalized_diff = normalize_diff(diff);
	let lines = normalized_diff.split('\n').collect::<Vec<_>>();
	let mut hunks = Vec::new();
	let mut index = 0_usize;
	while index < lines.len() {
		let line = lines[index];
		let trimmed = line.trim();
		if trimmed.is_empty() {
			index += 1;
			continue;
		}
		let is_diff_content = matches!(line.as_bytes().first(), Some(b' ' | b'+' | b'-'));
		if !is_diff_content && is_unified_diff_metadata_line(trimmed) {
			index += 1;
			continue;
		}
		if trimmed.starts_with("@@") && lines[index + 1..].iter().all(|next| next.trim().is_empty()) {
			break;
		}
		let parsed =
			parse_one_hunk(&lines[index..], u32::try_from(index + 1).unwrap_or(u32::MAX), true)?;
		hunks.push(parsed.hunk);
		index += parsed.lines_consumed;
	}
	Ok(hunks)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn source(path: &str) -> BlockContextSource<'_> {
		BlockContextSource { path: Some(path), lang: None }
	}

	#[test]
	fn collapses_unchanged_lines_between_distant_edits() {
		let old_lines = (1..=20)
			.map(|line| format!("line {line}"))
			.collect::<Vec<_>>();
		let mut new_lines = old_lines.clone();
		new_lines[1] = "line 2 changed".to_owned();
		new_lines[17] = "line 18 changed".to_owned();
		let result = generate_diff_string(
			&old_lines.join("\n"),
			&new_lines.join("\n"),
			Some(2),
			&BlockContextSource::default(),
		);
		let lines = result.diff.split('\n').collect::<Vec<_>>();
		assert!(
			!lines
				.iter()
				.any(|line| line.ends_with("|...") || line.ends_with("|…"))
		);
		let line_four = lines.iter().position(|line| *line == " 4|line 4").unwrap();
		assert_eq!(lines[line_four + 1], " 16|line 16");
		assert!(lines.contains(&"-2|line 2"));
		assert!(lines.contains(&"+2|line 2 changed"));
		assert!(lines.contains(&"-18|line 18"));
		assert!(lines.contains(&"+18|line 18 changed"));
		assert!(!lines.contains(&" 8|line 8"));
		assert!(!lines.contains(&" 12|line 12"));
	}

	#[test]
	fn adds_matching_bracket_line_beyond_context() {
		let old = [
			"function outer() {",
			"  const value = 1;",
			"  const two = 2;",
			"  const three = 3;",
			"  const four = 4;",
			"  return value + two + three + four;",
			"}",
		];
		let mut new = old;
		new[0] = "function renamed() {";
		let result =
			generate_diff_string(&old.join("\n"), &new.join("\n"), Some(1), &source("sample.ts"));
		let lines = result.diff.split('\n').collect::<Vec<_>>();
		assert!(lines.contains(&"-1|function outer() {"));
		assert!(lines.contains(&"+1|function renamed() {"));
		assert!(lines.contains(&""));
		assert!(!lines.contains(&"..."));
		assert!(lines.contains(&" 7|}"));
		assert!(!lines.contains(&" 5|  const four = 4;"));
		assert!(!lines.contains(&" 6|  return value + two + three + four;"));
	}

	#[test]
	fn normalizes_gap_rows_around_block_context() {
		let old = [
			"function alpha() {",
			"  const a1 = 1;",
			"  const a2 = 2;",
			"  const a3 = 3;",
			"  const a4 = 4;",
			"  return a1;",
			"}",
			"// spacer",
			"function beta() {",
			"  const b1 = 1;",
			"  const b2 = 2;",
			"  const b3 = 3;",
			"  const b4 = 4;",
			"  return b1;",
			"}",
		];
		let mut new = old;
		new[1] = "  const a1 = 100;";
		new[13] = "  return b1 + 1;";
		let result =
			generate_diff_string(&old.join("\n"), &new.join("\n"), Some(1), &source("sample.ts"));
		let lines = result.diff.split('\n').collect::<Vec<_>>();
		let closer = lines.iter().position(|line| *line == " 7|}").unwrap();
		let opener = lines
			.iter()
			.position(|line| *line == " 9|function beta() {")
			.unwrap();
		assert!(opener > closer);
		assert_eq!(lines[closer - 1], "");
		assert_eq!(lines[closer + 1], "");
		assert_eq!(lines[opener - 1], "");
		assert_eq!(lines[opener + 1], "");
		assert!(!lines.windows(2).any(|pair| pair == ["", ""]));
		assert_ne!(lines.first(), Some(&""));
		assert_ne!(lines.last(), Some(&""));
	}

	#[test]
	fn drops_gap_between_contiguous_boundaries() {
		let old = [
			"function alpha() {",
			"  const a1 = 1;",
			"  const a2 = 2;",
			"  const a3 = 3;",
			"  const a4 = 4;",
			"  return a1;",
			"}",
			"function beta() {",
			"  const b1 = 1;",
			"  const b2 = 2;",
			"  const b3 = 3;",
			"  const b4 = 4;",
			"  return b1;",
			"}",
		];
		let mut new = old;
		new[1] = "  const a1 = 100;";
		new[12] = "  return b1 + 1;";
		let result =
			generate_diff_string(&old.join("\n"), &new.join("\n"), Some(1), &source("sample.ts"));
		let lines = result.diff.split('\n').collect::<Vec<_>>();
		let closer = lines.iter().position(|line| *line == " 7|}").unwrap();
		let opener = lines
			.iter()
			.position(|line| *line == " 8|function beta() {")
			.unwrap();
		assert_eq!(opener, closer + 1);
	}

	#[test]
	fn translates_new_block_context_to_old_line_numbers() {
		let old = [
			"function outer() {",
			"  const a = 1;",
			"  const keep = 2;",
			"  const b = 3;",
			"  return a + keep + b;",
			"}",
		];
		let new = [
			"function outer() {",
			"  const a = 10;",
			"  const a2 = 11;",
			"  const keep = 2;",
			"  const b = 30;",
			"  const b2 = 31;",
			"  return a + keep + b;",
			"}",
		];
		let result =
			generate_diff_string(&old.join("\n"), &new.join("\n"), Some(1), &source("sample.ts"));
		let lines = result.diff.split('\n').collect::<Vec<_>>();
		assert_eq!(
			lines
				.iter()
				.filter(|line| line.ends_with("|}"))
				.copied()
				.collect::<Vec<_>>(),
			[" 6|}"]
		);
		let context_numbers = lines
			.iter()
			.filter(|line| line.starts_with(' '))
			.map(|line| line[1..].split('|').next().unwrap().parse::<u32>().unwrap())
			.collect::<Vec<_>>();
		let mut sorted = context_numbers.clone();
		sorted.sort_unstable();
		assert_eq!(context_numbers, sorted);
		assert_eq!(
			lines
				.iter()
				.filter(|line| line.contains("|  const keep = 2;"))
				.copied()
				.collect::<Vec<_>>(),
			[" 3|  const keep = 2;"]
		);
	}

	#[test]
	fn compact_preview_counts_and_renumbers() {
		let diff = [" 1|alpha", "-2|beta", "+2|DELTA", "+3|EPSILON", " 3|gamma"].join("\n");
		let preview = build_compact_diff_preview(&diff, &CompactDiffOptions::default());
		assert_eq!(preview.preview, "1:alpha\n2:DELTA\n3:EPSILON\n4:gamma");
		assert_eq!(preview.added_lines, 2);
		assert_eq!(preview.removed_lines, 1);
	}

	#[test]
	fn compact_preview_renumbers_after_range_expansion() {
		let diff =
			[" 1|a1", " 2|a2", "-3|a3", "-4|a4", "+3|X", "+4|Y", "+5|Z", " 5|a5", " 6|a6", " 7|a7"]
				.join("\n");
		let preview = build_compact_diff_preview(&diff, &CompactDiffOptions::default());
		assert_eq!(preview.preview.split('\n').collect::<Vec<_>>(), [
			"1:a1", "2:a2", "3:X", "4:Y", "5:Z", "6:a5", "7:a6", "8:a7"
		]);
	}

	#[test]
	fn compact_preview_collapses_long_added_runs() {
		let diff = (0..7)
			.map(|index| format!("+{}|line {}", 10 + index, index + 1))
			.collect::<Vec<_>>()
			.join("\n");
		let preview = build_compact_diff_preview(&diff, &CompactDiffOptions::default());
		assert_eq!(preview.preview, "10:line 1\n11:line 2\n…\n15:line 6\n16:line 7");
		assert_eq!((preview.added_lines, preview.removed_lines), (7, 0));
	}

	#[test]
	fn compact_preview_honors_added_run_options() {
		let diff = (0..8)
			.map(|index| format!("+{}|line {}", 1 + index, index + 1))
			.collect::<Vec<_>>()
			.join("\n");
		let options =
			CompactDiffOptions { max_added_run_context: Some(1), max_unchanged_run: Some(3) };
		assert_eq!(build_compact_diff_preview(&diff, &options).preview, "1:line 1\n…\n8:line 8");
		let alias =
			CompactDiffOptions { max_added_run_context: None, max_unchanged_run: Some(1) };
		assert_eq!(build_compact_diff_preview(&diff, &alias).preview, "1:line 1\n…\n8:line 8");
	}

	#[test]
	fn compact_preview_normalizes_separators() {
		let preview = build_compact_diff_preview(
			" 1|alpha\n...\n...\n…\n 20|omega",
			&CompactDiffOptions::default(),
		);
		assert_eq!(preview.preview, "1:alpha\n…\n20:omega");
		let preview = build_compact_diff_preview(
			"\n 1|alpha\n\n-5|beta\n\n 9|gamma\n\n-12|omitted",
			&CompactDiffOptions::default(),
		);
		assert_eq!(preview.preview, "1:alpha\n\n8:gamma");
		assert_eq!(preview.removed_lines, 2);
	}

	#[test]
	fn parses_simple_and_multiple_hunks() {
		let hunks = parse_diff_hunks("@@ def f():\n-    pass\n+    return 123").unwrap();
		assert_eq!(hunks.len(), 1);
		assert_eq!(hunks[0].change_context.as_deref(), Some("def f():"));
		assert_eq!(hunks[0].old_lines, ["    pass"]);
		assert_eq!(hunks[0].new_lines, ["    return 123"]);
		assert_eq!(
			parse_diff_hunks("@@\n-bar\n+BAR\n@@\n-qux\n+QUX")
				.unwrap()
				.len(),
			2
		);
	}

	#[test]
	fn parses_context_and_eof_markers() {
		let hunks = parse_diff_hunks("@@\n foo\n-bar\n+baz\n qux").unwrap();
		assert_eq!(hunks[0].old_lines, ["foo", "bar", "qux"]);
		assert_eq!(hunks[0].new_lines, ["foo", "baz", "qux"]);
		assert!(
			parse_diff_hunks("@@\n+new line").unwrap()[0]
				.change_context
				.is_none()
		);
		assert!(parse_diff_hunks("@@\n+line\n*** End of File").unwrap()[0].is_end_of_file);
	}

	#[test]
	fn parses_headers_hints_and_wrappers() {
		let hunk = parse_diff_hunks(
			"*** Begin Patch\n*** Update File: a.txt\n@@ -12,2 +13,3 @@ name\n-old\n+new\n*** End \
			 Patch",
		)
		.unwrap()
		.remove(0);
		assert_eq!((hunk.old_start_line, hunk.new_start_line), (Some(12), Some(13)));
		assert_eq!(hunk.change_context.as_deref(), Some("name"));
		let hint = parse_diff_hunks("@@ lines 7-9\n-a\n+b").unwrap().remove(0);
		assert_eq!((hint.old_start_line, hint.new_start_line), (Some(7), Some(7)));
		let top = parse_diff_hunks("@@ top of file\n-a\n+b")
			.unwrap()
			.remove(0);
		assert_eq!((top.old_start_line, top.new_start_line), (Some(1), Some(1)));
	}

	#[test]
	fn normalizes_diff_and_create_content() {
		assert_eq!(
			normalize_diff("*** Begin Patch\n*** Update File: a\n@@\n-old\n+new\n*** End Patch\n"),
			"@@\n-old\n+new"
		);
		assert_eq!(normalize_create_content("+ one\n+two\n"), "one\ntwo\n");
		assert_eq!(normalize_create_content("one\n+two"), "one\n+two");
	}

	#[test]
	fn rejects_multi_file_diff() {
		let error =
			parse_diff_hunks("diff --git a/a b/a\n@@\n-a\n+b\ndiff --git a/b b/b\n@@\n-c\n+d")
				.unwrap_err();
		assert_eq!(
			error.to_string(),
			"Diff contains 2 file markers. Single-file patches cannot contain multi-file markers."
		);
	}

	#[test]
	fn generates_numbered_unified_diff() {
		let result = generate_unified_diff_string(
			"a\nb\nc\n",
			"a\nB\nc\n",
			Some(1),
			&BlockContextSource::default(),
		);
		assert_eq!(result.diff, "@@ -1,3 +1,3 @@\n 1|a\n-2|b\n+2|B\n 3|c");
		assert_eq!(result.first_changed_line, Some(2));
	}
}
