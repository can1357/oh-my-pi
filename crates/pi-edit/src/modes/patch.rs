//! `patch` mode: JSON `edits[]` of `{op, rename?, diff?}` hunks against one
//! path. Port of `packages/coding-agent/src/edit/modes/patch.ts`.

use std::{collections::HashSet, fmt::Write, sync::Arc};

use crate::{
	diff_string::{
		BlockContextSource, DiffHunk, generate_diff_string, generate_unified_diff_string,
		normalize_create_content, parse_diff_hunks,
	},
	engine::{
		EditMode, FileOp, FileOpIntent, HeaderKind, Inspection, ModeEngine, PreviewFile, Resolved,
		StagedFile,
	},
	error::EditError,
	files::{FileRead, FileSource, persist_new},
	fuzzy::{
		ContextLineResult, ContextMatchStrategy, FindMatchOptions, SequenceMatchStrategy,
		SequenceSearchResult, find_closest_sequence_match, find_context_line, find_match,
		seek_sequence,
	},
	store::EditStore,
	stream_json::{ArgSnapshot, EditEntry},
	text::{
		adjust_indentation, convert_leading_tabs_to_spaces, count_leading_whitespace,
		get_leading_whitespace, js_trim, normalize_for_fuzzy,
	},
};

const AMBIGUITY_HINT_WINDOW: usize = 200;
const MATCH_PREVIEW_CONTEXT: usize = 2;
const MATCH_PREVIEW_MAX_LEN: usize = 80;

/// Patch operation selected by an entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
	/// Create a complete file from `diff`.
	Create,
	/// Delete an existing file.
	Delete,
	/// Apply unified hunks to an existing file.
	Update,
}

impl Operation {
	fn parse(value: Option<&str>) -> Result<Self, EditError> {
		match value.unwrap_or("update") {
			"create" => Ok(Self::Create),
			"delete" => Ok(Self::Delete),
			"update" => Ok(Self::Update),
			other => Err(EditError::apply(format!("Invalid patch operation: {other}"))),
		}
	}
}

/// One normalized single-file patch request.
pub struct PatchInput<'a> {
	/// Authored source path.
	pub path:   &'a str,
	/// Requested file operation.
	pub op:     Operation,
	/// Optional update destination.
	pub rename: Option<&'a str>,
	/// Full create content or update hunks.
	pub diff:   Option<&'a str>,
}

/// JSON patch mode engine.
pub struct PatchEngine {
	/// Whether inexact hunk placement is allowed.
	pub allow_fuzzy:     bool,
	/// Minimum confidence for character-level fallback matching.
	pub fuzzy_threshold: f64,
}

#[derive(Debug, Clone)]
struct Replacement {
	start_index: usize,
	old_len:     usize,
	new_lines:   Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HunkVariantKind {
	TrimCommon,
	DedupeShared,
	CollapseRepeated,
	SingleLine,
}

#[derive(Debug, Clone)]
struct HunkVariant {
	old_lines: Vec<String>,
	new_lines: Vec<String>,
	kind:      HunkVariantKind,
}

fn is_blank_line(line: &str) -> bool {
	js_trim(line).is_empty()
}

fn equal_trimmed(left: &[String], right: &[String]) -> bool {
	left.len() == right.len()
		&& left
			.iter()
			.zip(right)
			.all(|(a, b)| js_trim(a) == js_trim(b))
}

fn indent_char(lines: &[String]) -> char {
	lines
		.iter()
		.find_map(|line| get_leading_whitespace(line).chars().next())
		.unwrap_or(' ')
}

fn apply_indent_delta(lines: &[String], delta: isize, indent: char) -> Vec<String> {
	lines
		.iter()
		.map(|line| {
			if is_blank_line(line) {
				return line.clone();
			}
			if delta > 0 {
				return format!("{}{}", indent.to_string().repeat(delta as usize), line);
			}
			let remove = (-delta) as usize;
			let remove = remove.min(count_leading_whitespace(line));
			line[remove..].to_owned()
		})
		.collect()
}

fn adjust_lines_indentation(
	pattern: &[String],
	actual: &[String],
	new_lines: &[String],
) -> Vec<String> {
	if pattern.is_empty() || actual.is_empty() || new_lines.is_empty() || pattern == actual {
		return new_lines.to_vec();
	}
	if equal_trimmed(pattern, new_lines) {
		return new_lines.to_vec();
	}

	let pattern_tab_only = pattern
		.iter()
		.filter(|line| !is_blank_line(line))
		.all(|line| !get_leading_whitespace(line).contains(' '));
	let actual_space_only = actual
		.iter()
		.filter(|line| !is_blank_line(line))
		.all(|line| !get_leading_whitespace(line).contains('\t'));
	let pattern_space_only = pattern
		.iter()
		.filter(|line| !is_blank_line(line))
		.all(|line| !get_leading_whitespace(line).contains('\t'));
	let actual_tab_only = actual
		.iter()
		.filter(|line| !is_blank_line(line))
		.all(|line| !get_leading_whitespace(line).contains(' '));
	let pattern_mixed = pattern.iter().any(|line| {
		let ws = get_leading_whitespace(line);
		ws.contains(' ') && ws.contains('\t')
	});
	let actual_mixed = actual.iter().any(|line| {
		let ws = get_leading_whitespace(line);
		ws.contains(' ') && ws.contains('\t')
	});
	if !pattern_mixed && !actual_mixed && pattern_tab_only && actual_space_only {
		let mut ratio = None;
		let mut consistent = true;
		for (old, found) in pattern.iter().zip(actual) {
			if is_blank_line(old) || is_blank_line(found) {
				continue;
			}
			let old_indent = count_leading_whitespace(old);
			let found_indent = count_leading_whitespace(found);
			if old_indent == 0 {
				continue;
			}
			if !found_indent.is_multiple_of(old_indent) {
				consistent = false;
				break;
			}
			let next = found_indent / old_indent;
			if ratio.is_some_and(|value| value != next) {
				consistent = false;
				break;
			}
			ratio = Some(next);
		}
		if consistent && ratio.is_some_and(|value| value > 0) {
			let ratio = ratio.unwrap();
			let valid = pattern.iter().zip(actual).all(|(old, found)| {
				is_blank_line(old)
					|| is_blank_line(found)
					|| get_leading_whitespace(old).is_empty()
					|| count_leading_whitespace(found) == count_leading_whitespace(old) * ratio
			});
			if valid {
				return convert_leading_tabs_to_spaces(&new_lines.join("\n"), ratio)
					.split('\n')
					.map(str::to_owned)
					.collect();
			}
		}
	}

	if !pattern_mixed && !actual_mixed && pattern_space_only && actual_tab_only {
		let mut samples = std::collections::BTreeMap::<usize, usize>::new();
		let mut consistent = true;
		for (old, found) in pattern.iter().zip(actual) {
			if is_blank_line(old) || is_blank_line(found) {
				continue;
			}
			let spaces = count_leading_whitespace(old);
			let tabs = count_leading_whitespace(found);
			if tabs == 0 {
				continue;
			}
			if samples
				.insert(tabs, spaces)
				.is_some_and(|prior| prior != spaces)
			{
				consistent = false;
				break;
			}
		}
		if consistent && !samples.is_empty() {
			let (width, offset) = if samples.len() == 1 {
				let (&tabs, &spaces) = samples.first_key_value().unwrap();
				(spaces.checked_div(tabs).filter(|_| spaces % tabs == 0), 0_isize)
			} else {
				let mut values = samples.iter();
				let (&tabs_a, &spaces_a) = values.next().unwrap();
				let (&tabs_b, &spaces_b) = values.next().unwrap();
				let tabs_delta = tabs_b as isize - tabs_a as isize;
				let spaces_delta = spaces_b as isize - spaces_a as isize;
				if tabs_delta != 0 && spaces_delta > 0 && spaces_delta % tabs_delta == 0 {
					let width = spaces_delta / tabs_delta;
					let offset = spaces_a as isize - tabs_a as isize * width;
					let valid = width > 0
						&& samples
							.iter()
							.all(|(&tabs, &spaces)| tabs as isize * width + offset == spaces as isize);
					(valid.then_some(width as usize), offset)
				} else {
					(None, 0)
				}
			};
			if let Some(width) = width.filter(|width| *width > 0) {
				return new_lines
					.iter()
					.map(|line| {
						if is_blank_line(line) {
							return line.clone();
						}
						let spaces = count_leading_whitespace(line);
						if spaces == 0 {
							return line.clone();
						}
						let adjusted = spaces as isize - offset;
						if adjusted < 0 {
							return line.clone();
						}
						let tabs = adjusted as usize / width;
						let remainder = adjusted as usize - tabs * width;
						format!("{}{}{}", "\t".repeat(tabs), " ".repeat(remainder), &line[spaces..])
					})
					.collect();
			}
		}
	}

	let mut deltas = pattern
		.iter()
		.zip(actual)
		.filter(|(a, b)| !is_blank_line(a) && !is_blank_line(b))
		.map(|(a, b)| count_leading_whitespace(b) as isize - count_leading_whitespace(a) as isize);
	let delta = deltas
		.next()
		.filter(|first| deltas.all(|value| value == *first));
	let pattern_min = pattern
		.iter()
		.filter(|line| !is_blank_line(line))
		.map(|line| count_leading_whitespace(line))
		.min()
		.unwrap_or(0);
	let mut by_content = std::collections::HashMap::<String, Vec<&String>>::new();
	for line in actual.iter().filter(|line| !is_blank_line(line)) {
		by_content
			.entry(js_trim(line).to_owned())
			.or_default()
			.push(line);
	}
	let mut used = std::collections::HashMap::<String, usize>::new();
	let indent = indent_char(actual);
	new_lines
		.iter()
		.enumerate()
		.map(|(line_index, line)| {
			if is_blank_line(line) {
				return line.clone();
			}
			let trimmed = js_trim(line).to_owned();
			if let Some(matches) = by_content.get(&trimmed) {
				if matches.len() == 1 {
					return (*matches[0]).clone();
				}
				if matches.iter().any(|candidate| candidate.as_str() == line) {
					return line.clone();
				}
				let index = used.entry(trimmed).or_default();
				if let Some(found) = matches.get(*index) {
					*index += 1;
					return (**found).clone();
				}
			}
			if pattern.len() == new_lines.len()
				&& let (Some(pattern_line), Some(actual_line)) =
					(pattern.get(line_index), actual.get(line_index))
				&& !is_blank_line(pattern_line)
				&& !is_blank_line(actual_line)
			{
				let local_delta = count_leading_whitespace(actual_line) as isize
					- count_leading_whitespace(pattern_line) as isize;
				if local_delta != 0
					&& count_leading_whitespace(line) == count_leading_whitespace(pattern_line)
				{
					return apply_indent_delta(std::slice::from_ref(line), local_delta, indent)
						.remove(0);
				}
			}
			if let Some(delta) = delta.filter(|value| *value != 0)
				&& count_leading_whitespace(line) == pattern_min
			{
				return apply_indent_delta(std::slice::from_ref(line), delta, indent).remove(0);
			}
			line.clone()
		})
		.collect()
}

#[allow(clippy::suspicious_operation_groupings, reason = "paired index bounds are intentional")]
fn trim_common_context(old: &[String], new: &[String]) -> Option<HunkVariant> {
	let mut start = 0;
	let mut old_end = old.len();
	let mut new_end = new.len();
	while start < old_end && start < new_end && old[start] == new[start] {
		start += 1;
	}
	while old_end > start && new_end > start && old[old_end - 1] == new[new_end - 1] {
		old_end -= 1;
		new_end -= 1;
	}
	if start == 0 && old_end == old.len() && new_end == new.len() {
		return None;
	}
	let old_lines = old[start..old_end].to_vec();
	let new_lines = new[start..new_end].to_vec();
	(!old_lines.is_empty() || !new_lines.is_empty()).then_some(HunkVariant {
		old_lines,
		new_lines,
		kind: HunkVariantKind::TrimCommon,
	})
}

fn collapse_consecutive_shared(old: &[String], new: &[String]) -> Option<HunkVariant> {
	let new_set = new.iter().collect::<HashSet<_>>();
	let shared = old
		.iter()
		.filter(|line| new_set.contains(*line))
		.collect::<HashSet<_>>();
	let collapse = |lines: &[String]| {
		let mut output = Vec::new();
		let mut index = 0;
		while index < lines.len() {
			output.push(lines[index].clone());
			let mut next = index + 1;
			while next < lines.len() && lines[next] == lines[index] && shared.contains(&lines[index]) {
				next += 1;
			}
			index = next;
		}
		output
	};
	let old_lines = collapse(old);
	let new_lines = collapse(new);
	(old_lines.len() != old.len() || new_lines.len() != new.len()).then_some(HunkVariant {
		old_lines,
		new_lines,
		kind: HunkVariantKind::DedupeShared,
	})
}

fn collapse_repeated_blocks(old: &[String], new: &[String]) -> Option<HunkVariant> {
	let new_set = new.iter().collect::<HashSet<_>>();
	let shared = old
		.iter()
		.filter(|line| new_set.contains(*line))
		.collect::<HashSet<_>>();
	let collapse = |lines: &[String]| {
		let mut output = lines.to_vec();
		let mut changed = false;
		let mut index = 0;
		while index < output.len() {
			let mut collapsed = false;
			if shared.contains(&output[index]) {
				for size in (2..=(output.len() - index) / 2).rev() {
					if (0..size).all(|offset| {
						output[index + offset] == output[index + size + offset]
							&& shared.contains(&output[index + offset])
					}) {
						output.drain(index + size..index + size * 2);
						changed = true;
						collapsed = true;
						break;
					}
				}
			}
			if !collapsed {
				index += 1;
			}
		}
		(changed, output)
	};
	let (old_changed, old_lines) = collapse(old);
	let (new_changed, new_lines) = collapse(new);
	(old_changed || new_changed).then_some(HunkVariant {
		old_lines,
		new_lines,
		kind: HunkVariantKind::CollapseRepeated,
	})
}

fn reduce_single_line(old: &[String], new: &[String]) -> Option<HunkVariant> {
	if old.is_empty() || old.len() != new.len() {
		return None;
	}
	let changed = old
		.iter()
		.zip(new)
		.enumerate()
		.filter(|(_, (a, b))| a != b)
		.map(|(i, _)| i)
		.collect::<Vec<_>>();
	(changed.len() == 1).then(|| HunkVariant {
		old_lines: vec![old[changed[0]].clone()],
		new_lines: vec![new[changed[0]].clone()],
		kind:      HunkVariantKind::SingleLine,
	})
}

fn fallback_variants(hunk: &DiffHunk, aggressive: bool) -> Vec<HunkVariant> {
	let mut variants = Vec::new();
	let trimmed = trim_common_context(&hunk.old_lines, &hunk.new_lines);
	if let Some(value) = &trimmed {
		variants.push(value.clone());
	}
	let base_old = trimmed
		.as_ref()
		.map_or(hunk.old_lines.as_slice(), |value| value.old_lines.as_slice());
	let base_new = trimmed
		.as_ref()
		.map_or(hunk.new_lines.as_slice(), |value| value.new_lines.as_slice());
	let deduped = collapse_consecutive_shared(base_old, base_new);
	if let Some(value) = &deduped {
		variants.push(value.clone());
	}
	let collapse_old = deduped
		.as_ref()
		.map_or(base_old, |value| value.old_lines.as_slice());
	let collapse_new = deduped
		.as_ref()
		.map_or(base_new, |value| value.new_lines.as_slice());
	if let Some(value) = collapse_repeated_blocks(collapse_old, collapse_new) {
		variants.push(value);
	}
	if let Some(value) = reduce_single_line(base_old, base_new) {
		variants.push(value);
	}
	let mut seen = HashSet::new();
	variants.retain(|variant| {
		(aggressive
			|| !matches!(
				variant.kind,
				HunkVariantKind::CollapseRepeated | HunkVariantKind::SingleLine
			)) && seen.insert(format!(
			"{}||{}",
			variant.old_lines.join("\n"),
			variant.new_lines.join("\n")
		))
	});
	variants
}

const fn sequence_strategy_label(strategy: SequenceMatchStrategy) -> &'static str {
	match strategy {
		SequenceMatchStrategy::Exact => "exact",
		SequenceMatchStrategy::TrimTrailing => "trim-trailing",
		SequenceMatchStrategy::Trim => "trim",
		SequenceMatchStrategy::CommentPrefix => "comment-prefix",
		SequenceMatchStrategy::Unicode => "unicode",
		SequenceMatchStrategy::Prefix => "prefix",
		SequenceMatchStrategy::Substring => "substring",
		SequenceMatchStrategy::Fuzzy => "fuzzy",
		SequenceMatchStrategy::FuzzyDominant => "fuzzy-dominant",
		SequenceMatchStrategy::Character => "character",
	}
}

const fn context_strategy_label(strategy: ContextMatchStrategy) -> &'static str {
	match strategy {
		ContextMatchStrategy::Exact => "exact",
		ContextMatchStrategy::Trim => "trim",
		ContextMatchStrategy::Unicode => "unicode",
		ContextMatchStrategy::Prefix => "prefix",
		ContextMatchStrategy::Substring => "substring",
		ContextMatchStrategy::Fuzzy => "fuzzy",
	}
}

fn sequence_preview(lines: &[&str], index: usize) -> String {
	let start = index.saturating_sub(MATCH_PREVIEW_CONTEXT);
	let end = lines.len().min(index + MATCH_PREVIEW_CONTEXT + 1);
	lines[start..end]
		.iter()
		.enumerate()
		.map(|(offset, line)| {
			let truncated = if line.chars().count() > MATCH_PREVIEW_MAX_LEN {
				format!(
					"{}…",
					line
						.chars()
						.take(MATCH_PREVIEW_MAX_LEN - 1)
						.collect::<String>()
				)
			} else {
				(*line).to_owned()
			};
			format!("  {} | {truncated}", start + offset + 1)
		})
		.collect::<Vec<_>>()
		.join("\n")
}

fn sequence_previews(
	lines: &[&str],
	indices: Option<&[usize]>,
	count: Option<usize>,
) -> Option<String> {
	let indices = indices.filter(|value| !value.is_empty())?;
	let mut output = indices
		.iter()
		.map(|index| sequence_preview(lines, *index))
		.collect::<Vec<_>>()
		.join("\n\n");
	if let Some(count) = count
		&& count > indices.len()
	{
		let _ = write!(output, " (showing first {} of {})", indices.len(), count);
	}
	Some(output)
}

fn find_sequence_with_hint(
	lines: &[&str],
	pattern: &[&str],
	current: usize,
	hint: Option<usize>,
	eof: bool,
	allow_fuzzy: bool,
) -> SequenceSearchResult {
	let primary = seek_sequence(lines, pattern, current, eof, allow_fuzzy);
	if primary.match_count.is_some_and(|count| count > 1)
		&& hint.is_some_and(|value| value != current)
	{
		let hinted = seek_sequence(lines, pattern, hint.unwrap(), eof, allow_fuzzy);
		if hinted.index.is_some() || hinted.match_count.is_some_and(|count| count > 1) {
			return hinted;
		}
	}
	if primary.index.is_some() || primary.match_count.is_some_and(|count| count > 1) {
		return primary;
	}
	if let Some(hint) = hint.filter(|value| *value != current) {
		let hinted = seek_sequence(lines, pattern, hint, eof, allow_fuzzy);
		if hinted.index.is_some() || hinted.match_count.is_some_and(|count| count > 1) {
			return hinted;
		}
	}
	if current != 0 {
		let from_start = seek_sequence(lines, pattern, 0, eof, allow_fuzzy);
		if from_start.index.is_some() || from_start.match_count.is_some_and(|count| count > 1) {
			return from_start;
		}
	}
	primary
}

fn attempt_sequence_fallback(
	lines: &[&str],
	hunk: &DiffHunk,
	current: usize,
	hint: Option<usize>,
	allow_fuzzy: bool,
	aggressive: bool,
) -> Option<usize> {
	if hunk.old_lines.is_empty() {
		return None;
	}
	let pattern = hunk
		.old_lines
		.iter()
		.map(String::as_str)
		.collect::<Vec<_>>();
	let result = find_sequence_with_hint(lines, &pattern, current, hint, false, allow_fuzzy);
	if let Some(found) = result
		.index
		.filter(|_| result.match_count.unwrap_or(1) <= 1)
	{
		let next = found + 1;
		if next <= lines.len().saturating_sub(pattern.len())
			&& seek_sequence(lines, &pattern, next, false, allow_fuzzy)
				.index
				.is_some()
		{
			return None;
		}
		return Some(found);
	}
	for variant in fallback_variants(hunk, aggressive) {
		if variant.old_lines.is_empty() {
			continue;
		}
		let pattern = variant
			.old_lines
			.iter()
			.map(String::as_str)
			.collect::<Vec<_>>();
		let result = find_sequence_with_hint(lines, &pattern, current, hint, false, allow_fuzzy);
		if result.match_count.unwrap_or(1) <= 1
			&& let Some(found) = result.index
		{
			return Some(found);
		}
	}
	None
}

fn space_hierarchy(
	lines: &[&str],
	parts: &[&str],
	start: usize,
	allow_fuzzy: bool,
) -> Option<ContextLineResult> {
	if parts.len() < 2 {
		return None;
	}
	let outer = parts[..parts.len() - 1].join(" ");
	let inner = parts[parts.len() - 1];
	let outer_result = find_context_line(lines, &outer, start, allow_fuzzy, false);
	if outer_result.match_count.is_some_and(|count| count > 1) {
		return Some(ContextLineResult { index: None, ..outer_result });
	}
	let outer_index = outer_result.index?;
	let inner_result = find_context_line(lines, inner, outer_index + 1, allow_fuzzy, false);
	if inner_result.index.is_some() {
		return Some(if inner_result.match_count.is_some_and(|count| count > 1) {
			ContextLineResult {
				match_count: Some(1),
				match_indices: inner_result.index.map(|index| vec![index]),
				..inner_result
			}
		} else {
			inner_result
		});
	}
	if inner_result.match_count.is_some_and(|count| count > 1) {
		return Some(ContextLineResult {
			match_count: Some(1),
			match_indices: inner_result
				.index
				.map(|index| vec![index])
				.or_else(|| inner_result.match_indices.clone()),
			..inner_result
		});
	}
	Some(inner_result)
}

fn find_hierarchical_context(
	lines: &[&str],
	context: &str,
	start: usize,
	hint: Option<usize>,
	allow_fuzzy: bool,
) -> ContextLineResult {
	let parts = context
		.split('\n')
		.map(js_trim)
		.filter(|part| !part.is_empty())
		.collect::<Vec<_>>();
	if parts.len() > 1 {
		let mut current = start;
		for (index, part) in parts.iter().enumerate() {
			let last = index + 1 == parts.len();
			let result = find_context_line(lines, part, current, allow_fuzzy, false);
			if last
				&& (result.index.is_none() || result.match_count.is_some_and(|count| count > 1))
				&& let Some(hint_start) = hint
					.map(|value| value.saturating_sub(1))
					.filter(|value| *value >= current)
			{
				let hinted = find_context_line(lines, part, hint_start, allow_fuzzy, false);
				if hinted.index.is_some() {
					return ContextLineResult {
						match_count: Some(1),
						match_indices: hinted.index.map(|i| vec![i]),
						..hinted
					};
				}
			}
			let Some(found) = result.index else {
				return result;
			};
			if result.match_count.is_some_and(|count| count > 1) {
				return ContextLineResult { index: None, ..result };
			}
			if last {
				return result;
			}
			current = found + 1;
		}
	}

	let space_parts = context.split_whitespace().collect::<Vec<_>>();
	let has_signature = context
		.chars()
		.any(|ch| matches!(ch, '(' | ')' | '{' | '}' | '[' | ']'));
	if !has_signature
		&& space_parts.len() > 2
		&& let Some(result) = space_hierarchy(lines, &space_parts, start, allow_fuzzy)
		&& (result.index.is_some() || result.match_count.is_some_and(|count| count > 1))
	{
		return result;
	}

	let mut result = find_context_line(lines, context, start, allow_fuzzy, false);
	if (result.index.is_none() || result.match_count.is_some_and(|count| count > 1))
		&& let Some(hint) = hint
	{
		let hinted = find_context_line(lines, context, hint.saturating_sub(1), allow_fuzzy, false);
		if hinted.index.is_some() {
			return ContextLineResult {
				match_count: Some(1),
				match_indices: hinted.index.map(|i| vec![i]),
				..hinted
			};
		}
	}
	if result.index.is_some() && result.match_count.unwrap_or(0) <= 1 {
		return result;
	}
	if result.match_count.is_some_and(|count| count > 1) {
		return result;
	}
	if result.index.is_none() && start != 0 {
		let from_start = find_context_line(lines, context, 0, allow_fuzzy, false);
		if from_start.index.is_some() && from_start.match_count.unwrap_or(0) <= 1 {
			return from_start;
		}
		if from_start.match_count.is_some_and(|count| count > 1) {
			return from_start;
		}
	}
	if !has_signature
		&& space_parts.len() > 1
		&& let Some(hierarchical) = space_hierarchy(lines, &space_parts, start, allow_fuzzy)
	{
		result = hierarchical;
	}
	result
}

fn find_context_relative(
	lines: &[&str],
	pattern: &str,
	context: usize,
	prefer_second: bool,
) -> Option<usize> {
	let pattern = js_trim(pattern);
	let forward = (context + 1..lines.len())
		.filter(|index| js_trim(lines[*index]) == pattern)
		.collect::<Vec<_>>();
	if !forward.is_empty() {
		return Some(if prefer_second && forward.len() > 1 {
			forward[1]
		} else {
			forward[0]
		});
	}
	(0..context)
		.rev()
		.find(|index| js_trim(lines[*index]) == pattern)
}

fn character_match(
	content: &str,
	path: &str,
	hunk: &DiffHunk,
	threshold: f64,
	allow_fuzzy: bool,
) -> Result<(String, Vec<String>), EditError> {
	let old_text = hunk.old_lines.join("\n");
	let new_text = hunk.new_lines.join("\n");
	let mut outcome = find_match(content, &old_text, &FindMatchOptions {
		allow_fuzzy,
		threshold: Some(threshold),
		excluded_ranges: &[],
	});
	if outcome.matched.is_none() && allow_fuzzy {
		let relaxed = threshold.min(0.92);
		if relaxed < threshold {
			let next = find_match(content, &old_text, &FindMatchOptions {
				allow_fuzzy,
				threshold: Some(relaxed),
				excluded_ranges: &[],
			});
			if next.matched.is_some() {
				outcome = next;
			}
		}
	}
	if outcome.occurrences.is_some_and(|count| count > 1) {
		let count = outcome.occurrences.unwrap();
		let previews = outcome
			.occurrence_previews
			.as_deref()
			.unwrap_or_default()
			.join("\n\n");
		let more = if count > 5 {
			format!(" (showing first 5 of {count})")
		} else {
			String::new()
		};
		return Err(EditError::apply(format!(
			"Found {count} occurrences in {path}{more}:\n\n{previews}\n\nAdd more context lines to \
			 disambiguate."
		)));
	}
	if outcome.fuzzy_matches.is_some_and(|count| count > 1) {
		return Err(EditError::apply(format!(
			"Found {} high-confidence matches in {path}. The text must be unique. Please provide \
			 more context to make it unique.",
			outcome.fuzzy_matches.unwrap()
		)));
	}
	let Some(found) = outcome.matched else {
		if let Some(closest) = outcome.closest {
			return Err(EditError::apply(format!(
				"Could not find a close enough match in {path}. Closest match ({:.0}% similar) at \
				 line {}.",
				closest.confidence * 100.0,
				closest.start_line
			)));
		}
		return Err(EditError::apply(format!(
			"Failed to find expected lines in {path}:\n{old_text}"
		)));
	};
	let adjusted = adjust_indentation(&old_text, &found.actual_text, &new_text);
	let mut warnings = Vec::new();
	if outcome.dominant_fuzzy == Some(true) {
		warnings.push(format!(
			"Dominant fuzzy match selected in {path} near line {} ({:.0}% similar).",
			found.start_line,
			found.confidence * 100.0
		));
	}
	let mut result = String::with_capacity(content.len() + adjusted.len());
	result.push_str(&content[..found.start_index]);
	result.push_str(&adjusted);
	result.push_str(&content[found.start_index + found.actual_text.len()..]);
	Ok((result, warnings))
}

fn assert_partial_match(
	path: &str,
	pattern: &[String],
	matched: &[&str],
	new_lines: &[String],
	start: usize,
) -> Result<(), EditError> {
	let new_normalized = new_lines
		.iter()
		.map(|line| normalize_for_fuzzy(line))
		.collect::<Vec<_>>()
		.join("\n");
	for (offset, (expected, actual)) in pattern.iter().zip(matched).enumerate() {
		let actual = normalize_for_fuzzy(actual);
		let expected = normalize_for_fuzzy(expected);
		if actual == expected {
			continue;
		}
		let Some(at) = actual.find(&expected) else {
			continue;
		};
		for discarded in [&actual[..at], &actual[at + expected.len()..]] {
			let discarded = discarded.trim();
			if !discarded.is_empty() && !new_normalized.contains(discarded) {
				return Err(EditError::apply(format!(
					"Refusing partial-line match in {path} at line {}: the file line also contains \
					 {:?}, which the replacement would silently drop. Provide the complete line in the \
					 hunk.",
					start + offset + 1,
					discarded
				)));
			}
		}
	}
	Ok(())
}

fn compute_replacements(
	lines: &[&str],
	path: &str,
	hunks: &[DiffHunk],
	allow_fuzzy: bool,
) -> Result<(Vec<Replacement>, Vec<String>), EditError> {
	let mut replacements = Vec::new();
	let mut warnings = Vec::new();
	let mut line_index = 0;
	for hunk in hunks {
		if hunk.old_start_line == Some(0) {
			return Err(EditError::apply(format!(
				"Line hint 0 is out of range for {path} (line numbers start at 1)"
			)));
		}
		if hunk.new_start_line == Some(0) {
			return Err(EditError::apply(format!(
				"Line hint 0 is out of range for {path} (line numbers start at 1)"
			)));
		}
		let line_hint = hunk.old_start_line;
		let aggressive = hunk.change_context.is_some() || line_hint.is_some() || hunk.is_end_of_file;
		let variants = fallback_variants(hunk, aggressive);
		if let Some(hint) = line_hint
			&& hunk.change_context.is_none()
			&& !hunk.has_context_lines
		{
			line_index = (hint.saturating_sub(1) as usize).min(lines.len().saturating_sub(1));
		}
		let mut context_index = None;
		if let Some(context) = &hunk.change_context {
			let result = find_hierarchical_context(
				lines,
				context,
				line_index,
				line_hint.map(|value| value as usize),
				allow_fuzzy,
			);
			context_index = result.index;
			if let Some(found) = result.index
				&& result.match_count.is_none_or(|count| count <= 1)
			{
				let first = hunk.old_lines.first().map(|line| js_trim(line));
				let final_context = context.split('\n').next_back().map(js_trim);
				let hierarchical = context.contains('\n') || context.split_whitespace().count() > 2;
				line_index = if first == final_context || hierarchical {
					found
				} else {
					found + 1
				};
			} else {
				let fallback = attempt_sequence_fallback(
					lines,
					hunk,
					line_index,
					line_hint.map(|value| value.saturating_sub(1) as usize),
					allow_fuzzy,
					aggressive,
				);
				if let Some(found) = fallback {
					line_index = found;
				} else if let Some(count) = result.match_count
					&& count > 1
				{
					let display = context.split('\n').next_back().unwrap_or(context);
					let strategy = result
						.strategy
						.map(context_strategy_label)
						.map_or(String::new(), |value| format!(" Matching strategy: {value}."));
					let preview =
						sequence_previews(lines, result.match_indices.as_deref(), result.match_count)
							.map_or(String::new(), |value| format!("\n\n{value}"));
					return Err(EditError::apply(format!(
						"Found {count} matches for context '{display}' in \
						 {path}.{strategy}{preview}\n\nAdd more surrounding context or additional @@ \
						 anchors to make it unique."
					)));
				} else {
					return Err(EditError::apply(format!(
						"Failed to find context '{}' in {path}",
						context.replace('\n', " > ")
					)));
				}
			}
		}

		if hunk.old_lines.is_empty() {
			let insertion = if hunk.change_context.is_some() {
				line_index
			} else if let Some(hint) = hunk.old_start_line.or(hunk.new_start_line) {
				if hint < 1 {
					return Err(EditError::apply(format!(
						"Line hint {hint} is out of range for insertion in {path} (line numbers start \
						 at 1)"
					)));
				}
				if hint as usize > lines.len() + 1 {
					return Err(EditError::apply(format!(
						"Line hint {hint} is out of range for insertion in {path} (file has {} lines)",
						lines.len()
					)));
				}
				hint.saturating_sub(1) as usize
			} else if lines.last() == Some(&"") {
				lines.len() - 1
			} else {
				lines.len()
			};
			replacements.push(Replacement {
				start_index: insertion,
				old_len:     0,
				new_lines:   hunk.new_lines.clone(),
			});
			continue;
		}

		let mut pattern = hunk.old_lines.clone();
		let mut new_lines = hunk.new_lines.clone();
		let match_hint = hunk
			.old_start_line
			.map(|value| value.saturating_sub(1) as usize)
			.filter(|value| *value >= line_index);
		let mut result = find_sequence_with_hint(
			lines,
			&pattern.iter().map(String::as_str).collect::<Vec<_>>(),
			line_index,
			match_hint,
			hunk.is_end_of_file,
			allow_fuzzy,
		);
		if result.index.is_none() && pattern.last().is_some_and(String::is_empty) {
			pattern.pop();
			if new_lines.last().is_some_and(String::is_empty) {
				new_lines.pop();
			}
			result = find_sequence_with_hint(
				lines,
				&pattern.iter().map(String::as_str).collect::<Vec<_>>(),
				line_index,
				match_hint,
				hunk.is_end_of_file,
				allow_fuzzy,
			);
		}
		if result.index.is_none() || result.match_count.is_some_and(|count| count > 1) {
			for variant in &variants {
				if variant.old_lines.is_empty() {
					continue;
				}
				let candidate = find_sequence_with_hint(
					lines,
					&variant
						.old_lines
						.iter()
						.map(String::as_str)
						.collect::<Vec<_>>(),
					line_index,
					match_hint,
					hunk.is_end_of_file,
					allow_fuzzy,
				);
				if candidate.index.is_some() && candidate.match_count.unwrap_or(1) <= 1 {
					pattern.clone_from(&variant.old_lines);
					new_lines.clone_from(&variant.new_lines);
					result = candidate;
					break;
				}
			}
		}
		if result.index.is_none()
			&& let Some(context) = context_index
		{
			for variant in variants
				.iter()
				.filter(|variant| variant.old_lines.len() == 1 && variant.new_lines.len() == 1)
			{
				if let Some(found) = find_context_relative(
					lines,
					&variant.old_lines[0],
					context,
					hunk
						.new_lines
						.iter()
						.any(|line| js_trim(line) == js_trim(&variant.old_lines[0])),
				) {
					pattern.clone_from(&variant.old_lines);
					new_lines.clone_from(&variant.new_lines);
					result.index = Some(found);
					result.confidence = 0.95;
					break;
				}
			}
		}
		if result.index.is_some()
			&& let Some(context) = context_index
			&& pattern.len() == 1
		{
			let duplicate_count = lines
				.iter()
				.filter(|line| js_trim(line) == js_trim(&pattern[0]))
				.count();
			if duplicate_count > 1 {
				let prefer_second = hunk
					.new_lines
					.iter()
					.any(|line| js_trim(line) == js_trim(&pattern[0]));
				if let Some(found) = find_context_relative(lines, &pattern[0], context, prefer_second) {
					result.index = Some(found);
				}
			}
		}
		if result.match_count.is_some_and(|count| count > 1) {
			let hint = match_hint.or_else(|| line_hint.map(|value| value.saturating_sub(1) as usize));
			if let Some(hint) = hint {
				let candidates = result
					.match_indices
					.as_deref()
					.unwrap_or_default()
					.iter()
					.copied()
					.filter(|value| value.abs_diff(hint) <= AMBIGUITY_HINT_WINDOW)
					.collect::<Vec<_>>();
				if candidates.len() == 1 {
					result.index = Some(candidates[0]);
					result.match_count = Some(1);
				}
			}
		}
		let Some(found) = result.index else {
			if result.match_count.is_some_and(|count| count > 1) {
				let count = result.match_count.unwrap();
				let strategy = result
					.strategy
					.map(sequence_strategy_label)
					.map_or(String::new(), |value| format!(" Matching strategy: {value}."));
				let preview =
					sequence_previews(lines, result.match_indices.as_deref(), result.match_count)
						.map_or(String::new(), |value| format!("\n\n{value}"));
				return Err(EditError::apply(format!(
					"Found {count} matches for the text in {path}.{strategy}{preview}\n\nAdd more \
					 surrounding context or additional @@ anchors to make it unique."
				)));
			}
			let refs = pattern.iter().map(String::as_str).collect::<Vec<_>>();
			let (closest, confidence, _) =
				find_closest_sequence_match(lines, &refs, Some(line_index), hunk.is_end_of_file);
			if let Some(closest) = closest.filter(|_| confidence > 0.0) {
				return Err(EditError::apply(format!(
					"Failed to find expected lines in {path}:\n{}\n\nClosest match ({:.0}% similar) \
					 near line {}:\n{}",
					hunk.old_lines.join("\n"),
					confidence * 100.0,
					closest + 1,
					sequence_preview(lines, closest)
				)));
			}
			return Err(EditError::apply(format!(
				"Failed to find expected lines in {path}:\n{}",
				hunk.old_lines.join("\n")
			)));
		};
		if let Some(strategy) = result.strategy {
			if strategy == SequenceMatchStrategy::FuzzyDominant {
				warnings.push(format!(
					"Dominant fuzzy match selected in {path} near line {} ({:.0}% similar).",
					found + 1,
					result.confidence * 100.0
				));
			} else if matches!(
				strategy,
				SequenceMatchStrategy::CommentPrefix
					| SequenceMatchStrategy::Prefix
					| SequenceMatchStrategy::Substring
					| SequenceMatchStrategy::Fuzzy
					| SequenceMatchStrategy::Character
			) {
				warnings.push(format!(
					"Inexact match in {path} near line {}: matched via {} strategy ({:.0}% similar). \
					 Re-read the file if the result is not what you intended.",
					found + 1,
					sequence_strategy_label(strategy),
					result.confidence * 100.0
				));
			}
		}
		if hunk.change_context.is_none()
			&& !hunk.has_context_lines
			&& !hunk.is_end_of_file
			&& line_hint.is_none()
		{
			let refs = pattern.iter().map(String::as_str).collect::<Vec<_>>();
			let second = seek_sequence(lines, &refs, found + 1, false, allow_fuzzy);
			if let Some(second) = second.index {
				return Err(EditError::apply(format!(
					"Found 2 occurrences in {path}:\n\n{}\n\n{}\n\nAdd more context lines to \
					 disambiguate.",
					sequence_preview(lines, found),
					sequence_preview(lines, second)
				)));
			}
		}
		if pattern == new_lines {
			line_index = found + pattern.len();
			continue;
		}
		let matched = &lines[found..(found + pattern.len()).min(lines.len())];
		if matches!(
			result.strategy,
			Some(SequenceMatchStrategy::Prefix | SequenceMatchStrategy::Substring)
		) {
			assert_partial_match(path, &pattern, matched, &new_lines, found)?;
		}
		replacements.push(Replacement {
			start_index: found,
			old_len:     pattern.len(),
			new_lines:   adjust_lines_indentation(
				&pattern,
				&matched
					.iter()
					.map(|line| (*line).to_owned())
					.collect::<Vec<_>>(),
				&new_lines,
			),
		});
		line_index = found + pattern.len();
	}
	replacements.sort_by_key(|a| a.start_index);
	for pair in replacements.windows(2) {
		let [left, right] = pair else { unreachable!() };
		if right.start_index < left.start_index + left.old_len {
			let range = |replacement: &Replacement| {
				if replacement.old_len == 0 {
					format!("{} (insertion)", replacement.start_index + 1)
				} else {
					format!(
						"{}-{}",
						replacement.start_index + 1,
						replacement.start_index + replacement.old_len
					)
				}
			};
			return Err(EditError::apply(format!(
				"Overlapping hunks detected in {path} at lines {} and {}. Split hunks or add more \
				 context to avoid overlap.",
				range(left),
				range(right)
			)));
		}
	}
	Ok((replacements, warnings))
}

fn apply_hunks(
	content: &str,
	path: &str,
	hunks: &[DiffHunk],
	threshold: f64,
	allow_fuzzy: bool,
) -> Result<(String, Vec<String>), EditError> {
	let had_newline = content.ends_with('\n');
	if hunks.len() == 1 {
		let hunk = &hunks[0];
		if hunk.change_context.is_none()
			&& !hunk.has_context_lines
			&& !hunk.old_lines.is_empty()
			&& hunk.old_start_line.is_none()
			&& !hunk.is_end_of_file
		{
			let (mut next, warnings) = character_match(content, path, hunk, threshold, allow_fuzzy)?;
			if had_newline && !next.ends_with('\n') {
				next.push('\n');
			} else if !had_newline {
				next.truncate(next.trim_end_matches('\n').len());
			}
			return Ok((next, warnings));
		}
	}
	let mut lines = content.split('\n').collect::<Vec<_>>();
	let stripped = had_newline && lines.last() == Some(&"");
	if stripped {
		lines.pop();
	}
	let (replacements, warnings) = compute_replacements(&lines, path, hunks, allow_fuzzy)?;
	let mut result = lines.into_iter().map(str::to_owned).collect::<Vec<_>>();
	for replacement in replacements.iter().rev() {
		result.splice(
			replacement.start_index..replacement.start_index + replacement.old_len,
			replacement.new_lines.clone(),
		);
	}
	if stripped {
		result.push(String::new());
	}
	let mut next = result.join("\n");
	if had_newline && !next.ends_with('\n') {
		next.push('\n');
	} else if !had_newline {
		next.truncate(next.trim_end_matches('\n').len());
	}
	Ok((next, warnings))
}

fn validate_rename(
	input: &PatchInput<'_>,
	source: &Resolved,
	files: &mut dyn FileSource,
) -> Result<Option<Resolved>, EditError> {
	let Some(rename) = input.rename else {
		return Ok(None);
	};
	let destination = files.resolve(rename, false)?;
	if destination.absolute == source.absolute {
		return Err(EditError::apply("rename path is the same as source path"));
	}
	if files.exists(&destination.absolute) {
		return Err(EditError::apply(format!(
			"Cannot rename {} to {rename}: destination already exists.",
			input.path
		)));
	}
	Ok(Some(destination))
}

fn stage_from_parts(
	input: &PatchInput<'_>,
	resolved: Resolved,
	read: Option<Arc<FileRead>>,
	after: Option<String>,
	warnings: Vec<String>,
	move_to: Option<Resolved>,
	use_new_encoding: bool,
) -> Result<StagedFile, EditError> {
	let before = read
		.as_ref()
		.map_or_else(String::new, |value| value.text.clone());
	let comparison_after = after.as_deref().unwrap_or("");
	let source_path = move_to
		.as_ref()
		.map_or(input.path, |value| value.display.as_str());
	let unified =
		generate_unified_diff_string(&before, comparison_after, None, &BlockContextSource {
			path: Some(source_path),
			lang: None,
		});
	let preview = generate_diff_string(&before, comparison_after, None, &BlockContextSource {
		path: Some(source_path),
		lang: None,
	});
	let op = match input.op {
		Operation::Create => FileOp::Create,
		Operation::Delete => FileOp::Delete,
		Operation::Update => FileOp::Update,
	};
	let persisted = match after.as_deref() {
		Some(text) if use_new_encoding || read.is_none() => Some(persist_new(&resolved, text)?),
		Some(text) => Some(read.as_ref().unwrap().persist(text)?),
		None => None,
	};
	let mut staged = StagedFile::new(resolved.display.clone(), resolved.absolute, op);
	staged.move_to = move_to;
	staged.existed = read.is_some();
	staged.before_raw = read.as_ref().map(|value| value.raw.clone());
	staged.before = before;
	staged.after = after.unwrap_or_else(|| staged.before.clone());
	staged.persisted = persisted;
	staged.diff = unified.diff;
	staged.preview_diff = Some(preview.diff);
	staged.first_changed_line = unified.first_changed_line;
	staged.header = HeaderKind::Path;
	staged.warnings = warnings;
	Ok(staged)
}

/// Stage one patch entry without writing to disk.
pub fn stage_patch(
	input: PatchInput<'_>,
	files: &mut dyn FileSource,
	allow_fuzzy: bool,
	threshold: f64,
	allow_create_overwrite: bool,
) -> Result<StagedFile, EditError> {
	let must_exist = input.op != Operation::Create;
	let resolved = files.resolve(input.path, must_exist)?;
	let move_to = validate_rename(&input, &resolved, files)?;
	match input.op {
		Operation::Create => {
			let diff = input
				.diff
				.ok_or_else(|| EditError::apply("Create operation requires diff (file content)"))?;
			let read = files.try_read(&resolved)?;
			if read.is_some() && !allow_create_overwrite {
				return Err(EditError::apply(format!(
					"Cannot create {}: file already exists. Use *** Update File to modify it in place.",
					input.path
				)));
			}
			let normalized = normalize_create_content(diff);
			let content = if normalized.ends_with('\n') {
				normalized
			} else {
				format!("{normalized}\n")
			};
			stage_from_parts(&input, resolved, None, Some(content), Vec::new(), None, true)
		},
		Operation::Delete => {
			let read = files.read(input.path)?;
			stage_from_parts(&input, read.resolved.clone(), Some(read), None, Vec::new(), None, false)
		},
		Operation::Update => {
			let diff = input
				.diff
				.ok_or_else(|| EditError::apply("Update operation requires diff (hunks)"))?;
			let read = files.read(input.path)?;
			let hunks = parse_diff_hunks(diff)?;
			if hunks.is_empty() {
				return Err(EditError::apply("Diff contains no hunks"));
			}
			let (after, warnings) =
				apply_hunks(&read.text, input.path, &hunks, threshold, allow_fuzzy)?;
			stage_from_parts(
				&input,
				read.resolved.clone(),
				Some(read),
				Some(after),
				warnings,
				move_to,
				false,
			)
		},
	}
}

/// Preview one patch entry, returning its error as model-facing text.
pub fn preview_patch(
	input: PatchInput<'_>,
	files: &mut dyn FileSource,
	allow_fuzzy: bool,
	threshold: f64,
	allow_create_overwrite: bool,
) -> PreviewFile {
	let display = input.path.to_owned();
	let rename = input.rename.map(str::to_owned);
	match stage_patch(input, files, allow_fuzzy, threshold, allow_create_overwrite) {
		Ok(staged) => PreviewFile {
			display:            staged.display,
			diff:               staged.preview_diff,
			first_changed_line: staged.first_changed_line,
			error:              None,
			op:                 Some(staged.op),
			rename:             staged.move_to.map(|value| value.display),
		},
		Err(error) => {
			PreviewFile { display, error: Some(error.to_string()), rename, ..PreviewFile::default() }
		},
	}
}

fn entry_input<'a>(path: &'a str, entry: &'a EditEntry) -> Result<PatchInput<'a>, EditError> {
	Ok(PatchInput {
		path,
		op: Operation::parse(entry.op.as_deref())?,
		rename: entry.rename.as_deref(),
		diff: entry.diff.as_deref(),
	})
}

fn extract_added_lines(text: &str, whole_on_empty: bool) -> String {
	let added = text
		.split('\n')
		.filter_map(|line| line.strip_prefix('+').filter(|_| !line.starts_with("+++ ")))
		.collect::<Vec<_>>();
	if added.is_empty() && whole_on_empty {
		text.to_owned()
	} else {
		added.join("\n")
	}
}

impl ModeEngine for PatchEngine {
	fn mode(&self) -> EditMode {
		EditMode::Patch
	}

	fn preview(
		&self,
		args: &ArgSnapshot,
		streaming: bool,
		files: &mut dyn FileSource,
		_store: &EditStore,
	) -> Vec<PreviewFile> {
		let Some(path) = args.path.as_deref() else {
			return Vec::new();
		};
		let Some(entry) = args.edits.iter().find(|entry| !streaming || entry.closed) else {
			return Vec::new();
		};
		match entry_input(path, entry) {
			Ok(input) => {
				vec![preview_patch(input, files, self.allow_fuzzy, self.fuzzy_threshold, true)]
			},
			Err(error) => vec![PreviewFile {
				display: path.to_owned(),
				error: Some(error.to_string()),
				..PreviewFile::default()
			}],
		}
	}

	fn stage(
		&self,
		args: &ArgSnapshot,
		files: &mut dyn FileSource,
		_store: &EditStore,
	) -> Result<Vec<StagedFile>, EditError> {
		let path = args
			.path
			.as_deref()
			.ok_or_else(|| EditError::parse("Patch path is required"))?;
		let entries = args
			.edits
			.iter()
			.filter(|entry| entry.closed || args.complete)
			.collect::<Vec<_>>();
		if entries.is_empty() {
			return Err(EditError::apply("No files were modified."));
		}
		if entries.len() == 1 {
			return Ok(vec![stage_patch(
				entry_input(path, entries[0])?,
				files,
				self.allow_fuzzy,
				self.fuzzy_threshold,
				true,
			)?]);
		}

		let first = entry_input(path, entries[0])?;
		let initial_resolved = files.resolve(path, first.op != Operation::Create)?;
		let initial = files.try_read(&initial_resolved)?;
		let initial_before = initial
			.as_ref()
			.map_or_else(String::new, |read| read.text.clone());
		let mut current = initial_before;
		let mut exists = initial.is_some();
		let mut final_op = FileOp::Update;
		let mut warnings = Vec::new();
		let mut move_to = None;
		let mut use_new_encoding = false;
		for entry in entries {
			let input = entry_input(path, entry)?;
			if let Some(rename) = input.rename {
				let destination = files.resolve(rename, false)?;
				if destination.absolute == initial_resolved.absolute {
					return Err(EditError::apply("rename path is the same as source path"));
				}
				if files.exists(&destination.absolute) {
					return Err(EditError::apply(format!(
						"Cannot rename {path} to {rename}: destination already exists."
					)));
				}
				if input.op == Operation::Update {
					move_to = Some(destination);
				}
			}
			match input.op {
				Operation::Create => {
					let diff = input.diff.ok_or_else(|| {
						EditError::apply("Create operation requires diff (file content)")
					})?;
					let normalized = normalize_create_content(diff);
					current = if normalized.ends_with('\n') {
						normalized
					} else {
						format!("{normalized}\n")
					};
					exists = true;
					final_op = FileOp::Create;
					use_new_encoding = true;
				},
				Operation::Delete => {
					if !exists {
						return Err(EditError::apply(format!("File not found: {path}")));
					}
					exists = false;
					final_op = FileOp::Delete;
				},
				Operation::Update => {
					if !exists {
						return Err(EditError::apply(format!("File not found: {path}")));
					}
					let diff = input
						.diff
						.ok_or_else(|| EditError::apply("Update operation requires diff (hunks)"))?;
					let hunks = parse_diff_hunks(diff)?;
					if hunks.is_empty() {
						return Err(EditError::apply("Diff contains no hunks"));
					}
					let (next, mut next_warnings) =
						apply_hunks(&current, path, &hunks, self.fuzzy_threshold, self.allow_fuzzy)?;
					current = next;
					warnings.append(&mut next_warnings);
					final_op = FileOp::Update;
				},
			}
		}
		let synthetic = PatchInput {
			path,
			op: match final_op {
				FileOp::Create => Operation::Create,
				FileOp::Delete => Operation::Delete,
				_ => Operation::Update,
			},
			rename: None,
			diff: None,
		};
		let after = exists.then_some(current);
		Ok(vec![stage_from_parts(
			&synthetic,
			initial_resolved,
			initial,
			after,
			warnings,
			move_to,
			use_new_encoding,
		)?])
	}

	fn inspect(&self, args: &ArgSnapshot) -> Inspection {
		let Some(path) = args.path.as_ref().filter(|path| !path.is_empty()) else {
			return Inspection::default();
		};
		let mut digest = None::<String>;
		let mut file_ops = Vec::new();
		for entry in &args.edits {
			if let Some(diff) = &entry.diff {
				let added = extract_added_lines(diff, entry.op.as_deref() == Some("create"));
				digest = Some(match digest {
					Some(current) => format!("{current}\n{added}"),
					None => added,
				});
			}
			if entry.op.as_deref() == Some("delete") {
				file_ops.push(FileOpIntent::Delete { path: path.clone() });
			}
			if let Some(rename) = &entry.rename
				&& entry.op.as_deref().is_none_or(|op| op == "update")
			{
				file_ops.push(FileOpIntent::Move { from: path.clone(), to: rename.clone() });
			}
		}
		Inspection {
			paths: vec![path.clone()],
			entries: digest
				.map(|value| vec![(path.clone(), value)])
				.unwrap_or_default(),
			file_ops,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn strips_create_prefixes() {
		assert_eq!(extract_added_lines("+one\n+two", true), "one\ntwo");
		assert_eq!(extract_added_lines("one\ntwo", true), "one\ntwo");
	}

	#[test]
	fn trailing_newline_policy_is_preserved() {
		let hunk = DiffHunk {
			change_context:    None,
			old_start_line:    None,
			new_start_line:    None,
			has_context_lines: false,
			old_lines:         vec!["one".into()],
			new_lines:         vec!["two".into()],
			is_end_of_file:    false,
		};
		assert_eq!(
			apply_hunks("one\n", "a.txt", &[hunk.clone()], 0.95, true)
				.unwrap()
				.0,
			"two\n"
		);
		assert_eq!(apply_hunks("one", "a.txt", &[hunk], 0.95, true).unwrap().0, "two");
	}
}
