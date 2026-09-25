//! Text/sequence matching primitives shared by `replace`, `patch`, and
//! `sloppy`: Levenshtein similarity, whole-block fuzzy search,
//! line-sequence placement, and context-line placement.

use crate::{
	error::EditError,
	text::{
		adjust_indentation, count_leading_whitespace, is_non_empty_line, js_trim, js_trim_end,
		js_trim_start, normalize_for_fuzzy, normalize_to_lf, normalize_unicode, utf16_len,
	},
};

/// Default similarity threshold for fuzzy matching.
pub const DEFAULT_FUZZY_THRESHOLD: f64 = 0.95;
/// Threshold for sequence-based fuzzy matching.
pub const SEQUENCE_FUZZY_THRESHOLD: f64 = 0.92;
/// Fallback threshold for line-based matching without indentation depth.
pub const FALLBACK_THRESHOLD: f64 = 0.8;
/// Threshold for context-line fuzzy matching.
pub const CONTEXT_FUZZY_THRESHOLD: f64 = 0.8;
/// Minimum normalized pattern length for partial matching.
pub const PARTIAL_MATCH_MIN_LENGTH: usize = 6;
/// Minimum pattern-to-line ratio for ambiguous substring matching.
pub const PARTIAL_MATCH_MIN_RATIO: f64 = 0.3;
/// Number of surrounding lines in occurrence previews.
pub const OCCURRENCE_PREVIEW_CONTEXT: usize = 5;
/// Maximum displayed line length in occurrence previews.
pub const OCCURRENCE_PREVIEW_MAX_LEN: usize = 80;
/// Occurrence previews and indices recorded before truncation.
pub const MAX_RECORDED_MATCHES: usize = 5;
/// A fuzzy hit at or above this confidence can dominate weaker siblings.
pub const DOMINANT_FUZZY_MIN_CONFIDENCE: f64 = 0.97;
/// Minimum confidence gap for a dominant fuzzy hit.
pub const DOMINANT_FUZZY_DELTA: f64 = 0.08;
/// Threshold for the final character-level sequence fallback.
pub const CHARACTER_MATCH_THRESHOLD: f64 = 0.92;

/// A located block of text.
#[derive(Debug, Clone, PartialEq)]
pub struct FuzzyMatch {
	pub actual_text: String,
	/// Byte offset of the match start in the searched content.
	pub start_index: usize,
	/// 1-indexed line of the match start.
	pub start_line:  u32,
	pub confidence:  f64,
}

/// Outcome of [`find_match`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MatchOutcome {
	pub matched:             Option<FuzzyMatch>,
	pub closest:             Option<FuzzyMatch>,
	pub occurrences:         Option<usize>,
	pub occurrence_lines:    Option<Vec<u32>>,
	pub occurrence_previews: Option<Vec<String>>,
	pub fuzzy_matches:       Option<usize>,
	pub dominant_fuzzy:      Option<bool>,
}

/// A byte range excluded from matching.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExcludedRange {
	pub start_index: usize,
	pub end_index:   usize,
}

/// Knobs for [`find_match`].
#[derive(Debug, Clone, Default)]
pub struct FindMatchOptions<'a> {
	pub allow_fuzzy:     bool,
	/// Defaults to [`DEFAULT_FUZZY_THRESHOLD`].
	pub threshold:       Option<f64>,
	pub excluded_ranges: &'a [ExcludedRange],
}

/// Strategy which located a line sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SequenceMatchStrategy {
	Exact,
	TrimTrailing,
	Trim,
	CommentPrefix,
	Unicode,
	Prefix,
	Substring,
	Fuzzy,
	FuzzyDominant,
	Character,
}

/// Result of a line-sequence search.
#[derive(Debug, Clone, PartialEq)]
pub struct SequenceSearchResult {
	pub index:         Option<usize>,
	pub confidence:    f64,
	pub match_count:   Option<usize>,
	pub match_indices: Option<Vec<usize>>,
	pub strategy:      Option<SequenceMatchStrategy>,
}

/// Strategy which located a context line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextMatchStrategy {
	Exact,
	Trim,
	Unicode,
	Prefix,
	Substring,
	Fuzzy,
}

/// Result of a context-line search.
#[derive(Debug, Clone, PartialEq)]
pub struct ContextLineResult {
	pub index:         Option<usize>,
	pub confidence:    f64,
	pub match_count:   Option<usize>,
	pub match_indices: Option<Vec<usize>>,
	pub strategy:      Option<ContextMatchStrategy>,
}

#[derive(Debug, Default)]
struct IndexedMatches {
	first_match:   Option<usize>,
	match_count:   usize,
	match_indices: Vec<usize>,
}

fn collect_indexed_matches(
	start: usize,
	end_inclusive: usize,
	mut predicate: impl FnMut(usize) -> bool,
) -> IndexedMatches {
	let mut matches = IndexedMatches::default();
	if start > end_inclusive {
		return matches;
	}
	for index in start..=end_inclusive {
		if !predicate(index) {
			continue;
		}
		matches.first_match.get_or_insert(index);
		matches.match_count += 1;
		if matches.match_indices.len() < MAX_RECORDED_MATCHES {
			matches.match_indices.push(index);
		}
	}
	matches
}

fn sequence_result(
	matches: &IndexedMatches,
	confidence: f64,
	strategy: SequenceMatchStrategy,
	ambiguous: bool,
) -> Option<SequenceSearchResult> {
	Some(SequenceSearchResult {
		index: Some(matches.first_match?),
		confidence,
		match_count: ambiguous.then_some(matches.match_count),
		match_indices: ambiguous.then(|| matches.match_indices.clone()),
		strategy: Some(strategy),
	})
}

fn context_result(
	matches: &IndexedMatches,
	confidence: f64,
	strategy: ContextMatchStrategy,
) -> Option<ContextLineResult> {
	Some(ContextLineResult {
		index: Some(matches.first_match?),
		confidence,
		match_count: Some(matches.match_count),
		match_indices: Some(matches.match_indices.clone()),
		strategy: Some(strategy),
	})
}

const fn no_sequence_match(confidence: f64, match_count: Option<usize>) -> SequenceSearchResult {
	SequenceSearchResult {
		index: None,
		confidence,
		match_count,
		match_indices: None,
		strategy: None,
	}
}

const fn no_context_match(confidence: f64) -> ContextLineResult {
	ContextLineResult {
		index: None,
		confidence,
		match_count: None,
		match_indices: None,
		strategy: None,
	}
}

#[allow(clippy::suspicious_operation_groupings, reason = "paired index bounds are intentional")]
fn levenshtein_chars(a: &[char], b: &[char]) -> usize {
	if a == b {
		return 0;
	}
	let mut start = 0;
	let shared_limit = a.len().min(b.len());
	while start < shared_limit && a[start] == b[start] {
		start += 1;
	}
	let mut a_end = a.len();
	let mut b_end = b.len();
	while a_end > start && b_end > start && a[a_end - 1] == b[b_end - 1] {
		a_end -= 1;
		b_end -= 1;
	}
	let mut longer = &a[start..a_end];
	let mut shorter = &b[start..b_end];
	if longer.is_empty() {
		return shorter.len();
	}
	if shorter.is_empty() {
		return longer.len();
	}
	if shorter.len() > longer.len() {
		std::mem::swap(&mut longer, &mut shorter);
	}

	let mut row: Vec<usize> = (0..=shorter.len()).collect();
	for (line, &a_char) in longer.iter().enumerate() {
		let mut diagonal = row[0];
		row[0] = line + 1;
		for (column, &b_char) in shorter.iter().enumerate() {
			let cell = column + 1;
			let above = row[cell];
			row[cell] = if a_char == b_char {
				diagonal
			} else {
				(above + 1).min(row[cell - 1] + 1).min(diagonal + 1)
			};
			diagonal = above;
		}
	}
	row[shorter.len()]
}

/// Levenshtein edit distance over Unicode scalar values.
///
/// The TypeScript source used UTF-16 code units. Rust deliberately uses
/// Unicode scalar values, so astral characters count as one element.
pub fn levenshtein_distance(a: &str, b: &str) -> usize {
	let a_chars: Vec<char> = a.chars().collect();
	let b_chars: Vec<char> = b.chars().collect();
	levenshtein_chars(&a_chars, &b_chars)
}

/// Similarity in `[0, 1]`: `1 - distance / max_len`.
pub fn similarity(a: &str, b: &str) -> f64 {
	let a_chars: Vec<char> = a.chars().collect();
	let b_chars: Vec<char> = b.chars().collect();
	let max_len = a_chars.len().max(b_chars.len());
	if max_len == 0 {
		return 1.0;
	}
	1.0 - levenshtein_chars(&a_chars, &b_chars) as f64 / max_len as f64
}

fn format_preview_window(lines: &[&str], center_index: usize) -> String {
	let start = center_index.saturating_sub(OCCURRENCE_PREVIEW_CONTEXT);
	let end = lines
		.len()
		.min(center_index + OCCURRENCE_PREVIEW_CONTEXT + 1);
	lines[start..end]
		.iter()
		.enumerate()
		.map(|(offset, line)| {
			let truncated = if utf16_len(line) > OCCURRENCE_PREVIEW_MAX_LEN {
				let mut units = 0;
				let mut text = String::new();
				for ch in line.chars() {
					let width = ch.len_utf16();
					if units + width > OCCURRENCE_PREVIEW_MAX_LEN - 1 {
						break;
					}
					text.push(ch);
					units += width;
				}
				text.push('…');
				text
			} else {
				(*line).to_owned()
			};
			format!("  {} | {truncated}", start + offset + 1)
		})
		.collect::<Vec<_>>()
		.join("\n")
}

fn overlaps_excluded(start: usize, end: usize, ranges: &[ExcludedRange]) -> bool {
	ranges
		.iter()
		.any(|range| start < range.end_index && end > range.start_index)
}

fn find_exact_match_outcome(
	content: &str,
	target: &str,
	excluded_ranges: &[ExcludedRange],
) -> Option<MatchOutcome> {
	let mut first_index = None;
	let mut occurrences = 0;
	let mut recorded_indices = Vec::new();
	let mut search_start = 0;
	while search_start <= content.len().saturating_sub(target.len()) {
		let Some(relative) = content[search_start..].find(target) else {
			break;
		};
		let index = search_start + relative;
		let end_index = index + target.len();
		if !overlaps_excluded(index, end_index, excluded_ranges) {
			first_index.get_or_insert(index);
			occurrences += 1;
			if recorded_indices.len() < MAX_RECORDED_MATCHES {
				recorded_indices.push(index);
			}
		}
		search_start = end_index;
	}
	let first_index = first_index?;
	if occurrences > 1 {
		let content_lines: Vec<&str> = content.split('\n').collect();
		let mut occurrence_lines = Vec::with_capacity(recorded_indices.len());
		let mut occurrence_previews = Vec::with_capacity(recorded_indices.len());
		for index in recorded_indices {
			let line_number = content[..index]
				.bytes()
				.filter(|byte| *byte == b'\n')
				.count() + 1;
			occurrence_lines.push(line_number as u32);
			occurrence_previews.push(format_preview_window(&content_lines, line_number - 1));
		}
		return Some(MatchOutcome {
			occurrences: Some(occurrences),
			occurrence_lines: Some(occurrence_lines),
			occurrence_previews: Some(occurrence_previews),
			..MatchOutcome::default()
		});
	}
	let start_line = content[..first_index]
		.bytes()
		.filter(|byte| *byte == b'\n')
		.count() as u32
		+ 1;
	Some(MatchOutcome {
		matched: Some(FuzzyMatch {
			actual_text: target.to_owned(),
			start_index: first_index,
			start_line,
			confidence: 1.0,
		}),
		..MatchOutcome::default()
	})
}

fn relative_indent_depths(lines: &[&str]) -> Vec<usize> {
	let indents: Vec<usize> = lines
		.iter()
		.map(|line| count_leading_whitespace(line))
		.collect();
	let non_empty_indents: Vec<usize> = lines
		.iter()
		.zip(&indents)
		.filter_map(|(line, indent)| is_non_empty_line(line).then_some(*indent))
		.collect();
	let min_indent = non_empty_indents.iter().copied().min().unwrap_or(0);
	let indent_unit = non_empty_indents
		.iter()
		.filter_map(|indent| indent.checked_sub(min_indent))
		.filter(|step| *step > 0)
		.min()
		.unwrap_or(1);
	lines
		.iter()
		.zip(indents)
		.map(|(line, indent)| {
			if !is_non_empty_line(line) || indent_unit == 0 {
				0
			} else {
				((indent - min_indent) as f64 / indent_unit as f64).round() as usize
			}
		})
		.collect()
}

fn normalize_lines(lines: &[&str], include_depth: bool) -> Vec<String> {
	let depths = include_depth.then(|| relative_indent_depths(lines));
	lines
		.iter()
		.enumerate()
		.map(|(index, line)| {
			let trimmed = js_trim(line);
			let prefix = depths
				.as_ref()
				.map_or_else(|| "|".to_owned(), |values| format!("{}|", values[index]));
			if trimmed.is_empty() {
				prefix
			} else {
				prefix + &normalize_for_fuzzy(trimmed)
			}
		})
		.collect()
}

fn line_offsets(lines: &[&str]) -> Vec<usize> {
	let mut offsets = Vec::with_capacity(lines.len());
	let mut offset = 0;
	for (index, line) in lines.iter().enumerate() {
		offsets.push(offset);
		offset += line.len() + usize::from(index + 1 < lines.len());
	}
	offsets
}

#[derive(Debug)]
struct BestFuzzyMatch {
	best:                  Option<FuzzyMatch>,
	above_threshold_count: usize,
	second_best_score:     f64,
}

fn best_fuzzy_match_core(
	content_lines: &[&str],
	target_lines: &[&str],
	offsets: &[usize],
	threshold: f64,
	include_depth: bool,
	excluded_ranges: &[ExcludedRange],
) -> BestFuzzyMatch {
	let target_normalized = normalize_lines(target_lines, include_depth);
	let mut best = None;
	let mut best_score = -1.0;
	let mut second_best_score = -1.0;
	let mut above_threshold_count = 0;
	for start in 0..=content_lines.len() - target_lines.len() {
		let start_index = offsets[start];
		let end_line = start + target_lines.len() - 1;
		let end_index = (offsets[end_line] + content_lines[end_line].len()).max(start_index + 1);
		if overlaps_excluded(start_index, end_index, excluded_ranges) {
			continue;
		}
		let window = &content_lines[start..start + target_lines.len()];
		let window_normalized = normalize_lines(window, include_depth);
		let score = target_normalized
			.iter()
			.zip(&window_normalized)
			.map(|(target, actual)| similarity(target, actual))
			.sum::<f64>()
			/ target_lines.len() as f64;
		if score >= threshold {
			above_threshold_count += 1;
		}
		if score > best_score {
			second_best_score = best_score;
			best_score = score;
			best = Some(FuzzyMatch {
				actual_text: window.join("\n"),
				start_index,
				start_line: start as u32 + 1,
				confidence: score,
			});
		} else if score > second_best_score {
			second_best_score = score;
		}
	}
	BestFuzzyMatch { best, above_threshold_count, second_best_score }
}

fn best_fuzzy_match(
	content: &str,
	target: &str,
	threshold: f64,
	excluded_ranges: &[ExcludedRange],
) -> BestFuzzyMatch {
	let content_lines: Vec<&str> = content.split('\n').collect();
	let target_lines: Vec<&str> = target.split('\n').collect();
	if target.is_empty() || target_lines.len() > content_lines.len() {
		return BestFuzzyMatch {
			best:                  None,
			above_threshold_count: 0,
			second_best_score:     0.0,
		};
	}
	let offsets = line_offsets(&content_lines);
	let mut result = best_fuzzy_match_core(
		&content_lines,
		&target_lines,
		&offsets,
		threshold,
		true,
		excluded_ranges,
	);
	if result
		.best
		.as_ref()
		.is_some_and(|best| best.confidence < threshold && best.confidence >= FALLBACK_THRESHOLD)
	{
		let without_depth = best_fuzzy_match_core(
			&content_lines,
			&target_lines,
			&offsets,
			threshold,
			false,
			excluded_ranges,
		);
		if without_depth.best.as_ref().is_some_and(|candidate| {
			result
				.best
				.as_ref()
				.is_none_or(|best| candidate.confidence > best.confidence)
		}) {
			result = without_depth;
		}
	}
	result
}

/// Locate `target` in `content`: exact first, then fuzzy when allowed.
/// Excluded ranges are invisible to both passes.
pub fn find_match(content: &str, target: &str, options: &FindMatchOptions<'_>) -> MatchOutcome {
	if target.is_empty() {
		return MatchOutcome::default();
	}
	if let Some(exact) = find_exact_match_outcome(content, target, options.excluded_ranges) {
		return exact;
	}
	let threshold = options.threshold.unwrap_or(DEFAULT_FUZZY_THRESHOLD);
	let result = best_fuzzy_match(content, target, threshold, options.excluded_ranges);
	let Some(best) = result.best else {
		return MatchOutcome::default();
	};
	if options.allow_fuzzy && best.confidence >= threshold {
		if result.above_threshold_count == 1 {
			return MatchOutcome {
				matched: Some(best.clone()),
				closest: Some(best),
				..MatchOutcome::default()
			};
		}
		if result.above_threshold_count > 1
			&& best.confidence >= DOMINANT_FUZZY_MIN_CONFIDENCE
			&& best.confidence - result.second_best_score >= DOMINANT_FUZZY_DELTA
		{
			return MatchOutcome {
				matched: Some(best.clone()),
				closest: Some(best),
				fuzzy_matches: Some(result.above_threshold_count),
				dominant_fuzzy: Some(true),
				..MatchOutcome::default()
			};
		}
	}
	MatchOutcome {
		closest: Some(best),
		fuzzy_matches: Some(result.above_threshold_count),
		..MatchOutcome::default()
	}
}

fn matches_at<T>(
	lines: &[T],
	pattern: &[T],
	index: usize,
	mut compare: impl FnMut(&T, &T) -> bool,
) -> bool {
	pattern
		.iter()
		.enumerate()
		.all(|(offset, expected)| compare(&lines[index + offset], expected))
}

fn fuzzy_score_at(lines: &[String], pattern: &[String], index: usize, min_score: f64) -> f64 {
	let count = pattern.len();
	let mut total = 0.0;
	for (offset, pat) in pattern.iter().enumerate() {
		let line = &lines[index + offset];
		if line == pat {
			total += 1.0;
			continue;
		}
		let remaining = count - offset - 1;
		let line_len = line.chars().count();
		let pat_len = pat.chars().count();
		let max_len = line_len.max(pat_len);
		let upper_bound = if max_len == 0 {
			1.0
		} else {
			1.0 - line_len.abs_diff(pat_len) as f64 / max_len as f64
		};
		if (total + upper_bound + remaining as f64) / (count as f64) < min_score {
			return total / count as f64;
		}
		if upper_bound > 0.0 {
			total += similarity(line, pat);
		}
		if (total + remaining as f64) / (count as f64) < min_score {
			return total / count as f64;
		}
	}
	total / count as f64
}

fn norm_starts_with(line: &str, pattern: &str) -> bool {
	if pattern.is_empty() {
		line.is_empty()
	} else {
		line.starts_with(pattern)
	}
}

fn norm_includes(line: &str, pattern: &str) -> bool {
	let pattern_len = pattern.chars().count();
	let line_len = line.chars().count();
	if pattern.is_empty() {
		return line.is_empty();
	}
	pattern_len >= PARTIAL_MATCH_MIN_LENGTH
		&& line.contains(pattern)
		&& pattern_len as f64 / line_len.max(1) as f64 >= PARTIAL_MATCH_MIN_RATIO
}

fn strip_comment_prefix(line: &str) -> &str {
	let trimmed = js_trim_start(line);
	let without = if let Some(rest) = trimmed.strip_prefix("/*") {
		rest
	} else if let Some(rest) = trimmed.strip_prefix("*/") {
		rest
	} else if let Some(rest) = trimmed.strip_prefix("//") {
		rest
	} else if let Some(rest) = trimmed.strip_prefix('*') {
		rest
	} else if let Some(rest) = trimmed.strip_prefix('#') {
		rest
	} else if let Some(rest) = trimmed.strip_prefix(';') {
		rest
	} else if let Some(rest) = trimmed.strip_prefix("/ ") {
		rest
	} else {
		trimmed
	};
	js_trim_start(without)
}

fn run_sequence_passes(
	lines: &[&str],
	pattern: &[&str],
	from: usize,
	to: usize,
	allow_fuzzy: bool,
	lines_normalized: &[String],
	pattern_normalized: &[String],
) -> Option<SequenceSearchResult> {
	let exact =
		collect_indexed_matches(from, to, |index| matches_at(lines, pattern, index, |a, b| a == b));
	if let Some(result) = sequence_result(&exact, 1.0, SequenceMatchStrategy::Exact, false) {
		return Some(result);
	}
	let trailing = collect_indexed_matches(from, to, |index| {
		matches_at(lines, pattern, index, |a, b| js_trim_end(a) == js_trim_end(b))
	});
	if let Some(result) =
		sequence_result(&trailing, 0.99, SequenceMatchStrategy::TrimTrailing, false)
	{
		return Some(result);
	}
	let trimmed = collect_indexed_matches(from, to, |index| {
		matches_at(lines, pattern, index, |a, b| js_trim(a) == js_trim(b))
	});
	if let Some(result) = sequence_result(&trimmed, 0.98, SequenceMatchStrategy::Trim, false) {
		return Some(result);
	}
	let comments = collect_indexed_matches(from, to, |index| {
		matches_at(lines, pattern, index, |a, b| strip_comment_prefix(a) == strip_comment_prefix(b))
	});
	if let Some(result) =
		sequence_result(&comments, 0.975, SequenceMatchStrategy::CommentPrefix, false)
	{
		return Some(result);
	}
	let unicode = collect_indexed_matches(from, to, |index| {
		matches_at(lines, pattern, index, |a, b| normalize_unicode(a) == normalize_unicode(b))
	});
	if let Some(result) = sequence_result(&unicode, 0.97, SequenceMatchStrategy::Unicode, false) {
		return Some(result);
	}
	if !allow_fuzzy {
		return None;
	}
	let prefix = collect_indexed_matches(from, to, |index| {
		matches_at(lines_normalized, pattern_normalized, index, |a, b| norm_starts_with(a, b))
	});
	if let Some(result) = sequence_result(&prefix, 0.965, SequenceMatchStrategy::Prefix, true) {
		return Some(result);
	}
	let substring = collect_indexed_matches(from, to, |index| {
		matches_at(lines_normalized, pattern_normalized, index, |a, b| norm_includes(a, b))
	});
	sequence_result(&substring, 0.94, SequenceMatchStrategy::Substring, true)
}

/// Locate `pattern` lines through the exact-to-character fallback ladder.
pub fn seek_sequence(
	lines: &[&str],
	pattern: &[&str],
	start: usize,
	eof: bool,
	allow_fuzzy: bool,
) -> SequenceSearchResult {
	if pattern.is_empty() {
		return SequenceSearchResult {
			index:         Some(start),
			confidence:    1.0,
			match_count:   None,
			match_indices: None,
			strategy:      Some(SequenceMatchStrategy::Exact),
		};
	}
	if pattern.len() > lines.len() {
		return no_sequence_match(0.0, None);
	}
	let max_start = lines.len() - pattern.len();
	let search_start = if eof { max_start } else { start };
	let lines_normalized: Vec<String> = lines.iter().map(|line| normalize_for_fuzzy(line)).collect();
	let pattern_normalized: Vec<String> = pattern
		.iter()
		.map(|line| normalize_for_fuzzy(line))
		.collect();
	if let Some(result) = run_sequence_passes(
		lines,
		pattern,
		search_start,
		max_start,
		allow_fuzzy,
		&lines_normalized,
		&pattern_normalized,
	) {
		return result;
	}
	if eof
		&& search_start > start
		&& let Some(result) = run_sequence_passes(
			lines,
			pattern,
			start,
			max_start,
			allow_fuzzy,
			&lines_normalized,
			&pattern_normalized,
		) {
		return result;
	}
	if !allow_fuzzy {
		return no_sequence_match(0.0, None);
	}

	let mut best_score = 0.0;
	let mut second_best_score = 0.0;
	let mut best_index = None;
	let mut fuzzy_matches = IndexedMatches::default();
	let fuzzy_bail = SEQUENCE_FUZZY_THRESHOLD - DOMINANT_FUZZY_DELTA;
	let mut score_range = |from: usize, to: usize| {
		if from > to {
			return;
		}
		for index in from..=to {
			let score = fuzzy_score_at(&lines_normalized, &pattern_normalized, index, fuzzy_bail);
			if score >= SEQUENCE_FUZZY_THRESHOLD {
				fuzzy_matches.first_match.get_or_insert(index);
				fuzzy_matches.match_count += 1;
				if fuzzy_matches.match_indices.len() < MAX_RECORDED_MATCHES {
					fuzzy_matches.match_indices.push(index);
				}
			}
			if score > best_score {
				second_best_score = best_score;
				best_score = score;
				best_index = Some(index);
			} else if score > second_best_score {
				second_best_score = score;
			}
		}
	};
	score_range(search_start, max_start);
	if eof && search_start > start {
		score_range(start, search_start - 1);
	}
	if let Some(index) = best_index.filter(|_| best_score >= SEQUENCE_FUZZY_THRESHOLD) {
		let dominant = fuzzy_matches.match_count > 1
			&& best_score >= DOMINANT_FUZZY_MIN_CONFIDENCE
			&& best_score - second_best_score >= DOMINANT_FUZZY_DELTA;
		return SequenceSearchResult {
			index:         Some(index),
			confidence:    best_score,
			match_count:   Some(if dominant {
				1
			} else {
				fuzzy_matches.match_count
			}),
			match_indices: Some(fuzzy_matches.match_indices),
			strategy:      Some(if dominant {
				SequenceMatchStrategy::FuzzyDominant
			} else {
				SequenceMatchStrategy::Fuzzy
			}),
		};
	}

	let pattern_text = pattern.join("\n");
	let content_text = lines.get(start..).unwrap_or_default().join("\n");
	let outcome = find_match(&content_text, &pattern_text, &FindMatchOptions {
		allow_fuzzy:     true,
		threshold:       Some(CHARACTER_MATCH_THRESHOLD),
		excluded_ranges: &[],
	});
	if let Some(matched) = outcome.matched {
		let line_index = start
			+ content_text[..matched.start_index]
				.bytes()
				.filter(|byte| *byte == b'\n')
				.count();
		return SequenceSearchResult {
			index:         Some(line_index),
			confidence:    matched.confidence,
			match_count:   Some(outcome.occurrences.or(outcome.fuzzy_matches).unwrap_or(1)),
			match_indices: None,
			strategy:      Some(SequenceMatchStrategy::Character),
		};
	}
	no_sequence_match(best_score, outcome.occurrences.or(outcome.fuzzy_matches))
}

/// Best-scoring placement of `pattern` regardless of threshold.
pub fn find_closest_sequence_match(
	lines: &[&str],
	pattern: &[&str],
	start: Option<usize>,
	eof: bool,
) -> (Option<usize>, f64, SequenceMatchStrategy) {
	let start = start.unwrap_or(0);
	if pattern.is_empty() {
		return (Some(start), 1.0, SequenceMatchStrategy::Exact);
	}
	if pattern.len() > lines.len() {
		return (None, 0.0, SequenceMatchStrategy::Fuzzy);
	}
	let max_start = lines.len() - pattern.len();
	let search_start = if eof { max_start } else { start };
	let lines_normalized: Vec<String> = lines.iter().map(|line| normalize_for_fuzzy(line)).collect();
	let pattern_normalized: Vec<String> = pattern
		.iter()
		.map(|line| normalize_for_fuzzy(line))
		.collect();
	let mut best_index = None;
	let mut best_score = 0.0;
	if search_start <= max_start {
		for index in search_start..=max_start {
			let score = fuzzy_score_at(&lines_normalized, &pattern_normalized, index, best_score);
			if score > best_score {
				best_score = score;
				best_index = Some(index);
			}
		}
	}
	if eof && search_start > start {
		for index in start..search_start {
			let score = fuzzy_score_at(&lines_normalized, &pattern_normalized, index, best_score);
			if score > best_score {
				best_score = score;
				best_index = Some(index);
			}
		}
	}
	(best_index, best_score, SequenceMatchStrategy::Fuzzy)
}

/// Locate a single `@@ context` line at or after `start_from`.
pub fn find_context_line(
	lines: &[&str],
	context: &str,
	start_from: usize,
	allow_fuzzy: bool,
	skip_function_fallback: bool,
) -> ContextLineResult {
	if lines.is_empty() || start_from >= lines.len() {
		return no_context_match(0.0);
	}
	let end = lines.len() - 1;
	let trimmed_context = js_trim(context);
	let exact = collect_indexed_matches(start_from, end, |index| lines[index] == context);
	if let Some(result) = context_result(&exact, 1.0, ContextMatchStrategy::Exact) {
		return result;
	}
	let trimmed =
		collect_indexed_matches(start_from, end, |index| js_trim(lines[index]) == trimmed_context);
	if let Some(result) = context_result(&trimmed, 0.99, ContextMatchStrategy::Trim) {
		return result;
	}
	let normalized_context = normalize_unicode(context);
	let unicode = collect_indexed_matches(start_from, end, |index| {
		normalize_unicode(lines[index]) == normalized_context
	});
	if let Some(result) = context_result(&unicode, 0.98, ContextMatchStrategy::Unicode) {
		return result;
	}
	if !allow_fuzzy {
		return no_context_match(0.0);
	}
	let context_normalized = normalize_for_fuzzy(context);
	if !context_normalized.is_empty() {
		let prefix = collect_indexed_matches(start_from, end, |index| {
			normalize_for_fuzzy(lines[index]).starts_with(&context_normalized)
		});
		if let Some(result) = context_result(&prefix, 0.96, ContextMatchStrategy::Prefix) {
			return result;
		}
	}
	if context_normalized.chars().count() >= PARTIAL_MATCH_MIN_LENGTH {
		let context_len = context_normalized.chars().count();
		let all_substrings: Vec<(usize, f64)> = (start_from..lines.len())
			.filter_map(|index| {
				let normalized = normalize_for_fuzzy(lines[index]);
				normalized
					.contains(&context_normalized)
					.then(|| (index, context_len as f64 / normalized.chars().count().max(1) as f64))
			})
			.collect();
		let match_indices: Vec<usize> = all_substrings
			.iter()
			.take(MAX_RECORDED_MATCHES)
			.map(|(index, _)| *index)
			.collect();
		if all_substrings.len() == 1 {
			return ContextLineResult {
				index:         Some(all_substrings[0].0),
				confidence:    0.94,
				match_count:   Some(1),
				match_indices: Some(match_indices),
				strategy:      Some(ContextMatchStrategy::Substring),
			};
		}
		let qualifying: Vec<usize> = all_substrings
			.iter()
			.filter_map(|(index, ratio)| (*ratio >= PARTIAL_MATCH_MIN_RATIO).then_some(*index))
			.collect();
		if let Some(&first) = qualifying.first() {
			return ContextLineResult {
				index:         Some(first),
				confidence:    0.94,
				match_count:   Some(qualifying.len()),
				match_indices: Some(match_indices),
				strategy:      Some(ContextMatchStrategy::Substring),
			};
		}
		if all_substrings.len() > 1 {
			return ContextLineResult {
				index:         Some(all_substrings[0].0),
				confidence:    0.94,
				match_count:   Some(all_substrings.len()),
				match_indices: Some(match_indices),
				strategy:      Some(ContextMatchStrategy::Substring),
			};
		}
	}

	let mut best_index = None;
	let mut best_score = 0.0;
	let mut fuzzy_matches = IndexedMatches::default();
	for (index, &line) in lines.iter().enumerate().skip(start_from) {
		let score = similarity(&normalize_for_fuzzy(line), &context_normalized);
		if score >= CONTEXT_FUZZY_THRESHOLD {
			fuzzy_matches.first_match.get_or_insert(index);
			fuzzy_matches.match_count += 1;
			if fuzzy_matches.match_indices.len() < MAX_RECORDED_MATCHES {
				fuzzy_matches.match_indices.push(index);
			}
		}
		if score > best_score {
			best_score = score;
			best_index = Some(index);
		}
	}
	if let Some(index) = best_index.filter(|_| best_score >= CONTEXT_FUZZY_THRESHOLD) {
		return ContextLineResult {
			index:         Some(index),
			confidence:    best_score,
			match_count:   Some(fuzzy_matches.match_count),
			match_indices: Some(fuzzy_matches.match_indices),
			strategy:      Some(ContextMatchStrategy::Fuzzy),
		};
	}
	if !skip_function_fallback && trimmed_context.ends_with("()") {
		let base = trimmed_context
			.strip_suffix("()")
			.unwrap_or(trimmed_context);
		let with_paren = format!("{base}(");
		let result = find_context_line(lines, &with_paren, start_from, allow_fuzzy, true);
		if result.index.is_some() || result.match_count.unwrap_or(0) > 0 {
			return result;
		}
		return find_context_line(lines, base, start_from, allow_fuzzy, true);
	}
	no_context_match(best_score)
}

fn first_different_line<'a>(old_lines: &'a [&str], new_lines: &'a [&str]) -> (&'a str, &'a str) {
	for index in 0..old_lines.len().max(new_lines.len()) {
		let old = old_lines.get(index).copied().unwrap_or("");
		let new = new_lines.get(index).copied().unwrap_or("");
		if old != new {
			return (old, new);
		}
	}
	(old_lines.first().copied().unwrap_or(""), new_lines.first().copied().unwrap_or(""))
}

/// Format `EditMatchError.formatMessage` byte-for-byte.
pub fn format_match_error(
	path: &str,
	search_text: &str,
	closest: Option<&FuzzyMatch>,
	allow_fuzzy: bool,
	threshold: f64,
	fuzzy_matches: Option<usize>,
) -> String {
	let Some(closest) = closest else {
		return if allow_fuzzy {
			format!("Could not find a close enough match in {path}.")
		} else {
			format!(
				"Could not find the exact text in {path}. The old text must match exactly including \
				 all whitespace and newlines."
			)
		};
	};
	let similarity_percent = (closest.confidence * 100.0).round() as i64;
	let threshold_percent = (threshold * 100.0).round() as i64;
	let search_lines: Vec<&str> = search_text.split('\n').collect();
	let actual_lines: Vec<&str> = closest.actual_text.split('\n').collect();
	let (old_line, new_line) = first_different_line(&search_lines, &actual_lines);
	let hint = if allow_fuzzy {
		if fuzzy_matches.is_some_and(|count| count > 1) {
			format!(
				"Found {} high-confidence matches. Provide more context to make it unique.",
				fuzzy_matches.unwrap_or(0)
			)
		} else {
			format!("Closest match was below the {threshold_percent}% similarity threshold.")
		}
	} else {
		"Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept high-confidence \
		 matches."
			.to_owned()
	};
	let heading = if allow_fuzzy {
		format!("Could not find a close enough match in {path}.")
	} else {
		format!("Could not find the exact text in {path}.")
	};
	format!(
		"{heading}\n\nClosest match ({similarity_percent}% similar) at line {}:\n  - {old_line}\n  \
		 + {new_line}\n{hint}",
		closest.start_line
	)
}

/// Format `formatOccurrenceError` byte-for-byte.
pub fn format_occurrence_error(path: &str, outcome: &MatchOutcome) -> String {
	let occurrences = outcome.occurrences.unwrap_or(0);
	let previews = outcome
		.occurrence_previews
		.as_ref()
		.map_or_else(String::new, |items| items.join("\n\n"));
	let more = if occurrences > MAX_RECORDED_MATCHES {
		format!(" (showing first {MAX_RECORDED_MATCHES} of {occurrences})")
	} else {
		String::new()
	};
	format!(
		"Found {occurrences} occurrences in {path}{more}:\n\n{previews}\n\nAdd more context lines \
		 to disambiguate."
	)
}

/// Result of [`replace_text`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaceResult {
	pub content: String,
	pub count:   usize,
}

#[derive(Debug)]
struct Replacement {
	start: usize,
	end:   usize,
	text:  String,
}

fn pathless_occurrence_error(outcome: &MatchOutcome) -> String {
	let occurrences = outcome.occurrences.unwrap_or(0);
	let previews = outcome
		.occurrence_previews
		.as_ref()
		.map_or_else(String::new, |items| items.join("\n\n"));
	let more = if occurrences > MAX_RECORDED_MATCHES {
		format!(" (showing first {MAX_RECORDED_MATCHES} of {occurrences})")
	} else {
		String::new()
	};
	format!(
		"Found {occurrences} occurrences{more}:\n\n{previews}\n\nAdd more context lines to \
		 disambiguate."
	)
}

/// Find and replace text using the same exact/fuzzy behavior as `replaceText`.
pub fn replace_text(
	content: &str,
	old_text: &str,
	new_text: &str,
	fuzzy: bool,
	all: bool,
	threshold: Option<f64>,
) -> Result<ReplaceResult, EditError> {
	if old_text.is_empty() {
		return Err(EditError::apply("oldText must not be empty."));
	}
	let threshold = threshold.unwrap_or(DEFAULT_FUZZY_THRESHOLD);
	let normalized_content = normalize_to_lf(content).into_owned();
	let normalized_old = normalize_to_lf(old_text);
	let normalized_new = normalize_to_lf(new_text);
	if all {
		let exact_count = normalized_content
			.match_indices(normalized_old.as_ref())
			.count();
		if exact_count > 0 {
			return Ok(ReplaceResult {
				content: normalized_content.replace(normalized_old.as_ref(), normalized_new.as_ref()),
				count:   exact_count,
			});
		}
		let mut replacements: Vec<Replacement> = Vec::new();
		loop {
			let excluded: Vec<ExcludedRange> = replacements
				.iter()
				.map(|replacement| ExcludedRange {
					start_index: replacement.start,
					end_index:   replacement.end,
				})
				.collect();
			let outcome =
				find_match(&normalized_content, normalized_old.as_ref(), &FindMatchOptions {
					allow_fuzzy:     fuzzy,
					threshold:       Some(threshold),
					excluded_ranges: &excluded,
				});
			let should_use_closest = fuzzy
				&& outcome
					.closest
					.as_ref()
					.is_some_and(|matched| matched.confidence >= threshold)
				&& outcome.fuzzy_matches.is_none_or(|count| count <= 1);
			let matched = outcome
				.matched
				.or_else(|| should_use_closest.then_some(outcome.closest).flatten());
			let Some(matched) = matched else {
				break;
			};
			let adjusted = adjust_indentation(
				normalized_old.as_ref(),
				&matched.actual_text,
				normalized_new.as_ref(),
			);
			if adjusted == matched.actual_text {
				break;
			}
			replacements.push(Replacement {
				start: matched.start_index,
				// JavaScript's `substring` clamps this synthetic one-byte span
				// when an empty fuzzy window lands at EOF.
				end:   (matched.start_index + matched.actual_text.len().max(1))
					.min(normalized_content.len()),
				text:  adjusted,
			});
		}
		replacements.sort_by_key(|replacement| replacement.start);
		let mut output = String::with_capacity(normalized_content.len());
		let mut source_index = 0;
		for replacement in &replacements {
			output.push_str(&normalized_content[source_index..replacement.start]);
			output.push_str(&replacement.text);
			source_index = replacement.end;
		}
		output.push_str(&normalized_content[source_index..]);
		return Ok(ReplaceResult { content: output, count: replacements.len() });
	}

	let outcome = find_match(&normalized_content, normalized_old.as_ref(), &FindMatchOptions {
		allow_fuzzy:     fuzzy,
		threshold:       Some(threshold),
		excluded_ranges: &[],
	});
	if outcome.occurrences.is_some_and(|count| count > 1) {
		return Err(EditError::apply(pathless_occurrence_error(&outcome)));
	}
	let Some(matched) = outcome.matched else {
		return Ok(ReplaceResult { content: normalized_content, count: 0 });
	};
	let adjusted =
		adjust_indentation(normalized_old.as_ref(), &matched.actual_text, normalized_new.as_ref());
	let mut output =
		String::with_capacity(normalized_content.len() - matched.actual_text.len() + adjusted.len());
	output.push_str(&normalized_content[..matched.start_index]);
	output.push_str(&adjusted);
	output.push_str(&normalized_content[matched.start_index + matched.actual_text.len()..]);
	Ok(ReplaceResult { content: output, count: 1 })
}

#[cfg(test)]
mod tests {
	use super::*;

	fn options(allow_fuzzy: bool) -> FindMatchOptions<'static> {
		FindMatchOptions { allow_fuzzy, threshold: None, excluded_ranges: &[] }
	}

	#[test]
	fn exact_match_and_multiple_occurrences() {
		let found = find_match("line1\nline2\nline3", "line2", &options(false));
		assert_eq!(found.matched.as_ref().map(|matched| matched.start_line), Some(2));
		assert_eq!(found.matched.as_ref().map(|matched| matched.confidence), Some(1.0));

		let multiple = find_match("foo\nbar\nfoo", "foo", &options(false));
		assert!(multiple.matched.is_none());
		assert_eq!(multiple.occurrences, Some(2));
		assert_eq!(multiple.occurrence_lines, Some(vec![1, 3]));
		assert_eq!(multiple.occurrence_previews.as_ref().map(Vec::len), Some(2));
	}

	#[test]
	fn tab_space_and_internal_whitespace_normalization() {
		for (content, target) in [
			("\tfoo\n\t\tbar\n\tbaz", "  foo\n    bar\n  baz"),
			("  foo\n    bar\n  baz", "\tfoo\n\t\tbar\n\tbaz"),
			("   foo\n      bar\n   baz", "  foo\n    bar\n  baz"),
			("foo   bar    baz", "foo bar baz"),
		] {
			let outcome = find_match(content, target, &options(true));
			assert!(outcome.matched.is_some(), "failed to match {target:?}");
			assert!(outcome.matched.unwrap().confidence >= DEFAULT_FUZZY_THRESHOLD);
		}
	}

	#[test]
	fn fallback_ignores_inconsistent_indentation() {
		let outcome = find_match(
			"\t\t\tline1\n\t\t\tline2\n\t\tline3\n\t\t\tline4",
			"      line1\n      line2\n      line3\n      line4",
			&options(true),
		);
		assert!(outcome.matched.is_some());

		let varied =
			find_match("  a\n    b\n   c\n    d", "  a\n    b\n    c\n    d", &options(true));
		assert!(varied.matched.is_some());
	}

	#[test]
	fn single_line_trailing_space_and_empty_line_cases() {
		let single =
			find_match("prefix\n\t\t\t\"value\",\nsuffix", "          \"value\",", &options(true));
		assert!(single.matched.is_some());
		let trailing = find_match("line1  \nline2\t", "line1\nline2", &options(true));
		assert!(trailing.matched.is_some());
		let empty_line = find_match("line1\n\nline3", "line1\n\nline3", &options(false));
		assert_eq!(
			empty_line
				.matched
				.as_ref()
				.map(|matched| matched.confidence),
			Some(1.0)
		);
		assert_eq!(find_match("some content", "", &options(true)), MatchOutcome::default());
		assert!(
			find_match("short", "this is much longer than the content", &options(true))
				.matched
				.is_none()
		);
	}

	#[test]
	fn threshold_and_dominant_fuzzy_match() {
		let strict = FindMatchOptions {
			allow_fuzzy:     true,
			threshold:       Some(0.99),
			excluded_ranges: &[],
		};
		assert!(
			find_match("function foo() {}", "function bar() {}", &strict)
				.matched
				.is_none()
		);
		let lenient = FindMatchOptions {
			allow_fuzzy:     true,
			threshold:       Some(0.7),
			excluded_ranges: &[],
		};
		assert!(
			find_match("function foo() {}", "function bar() {}", &lenient)
				.matched
				.is_some()
		);

		let target = "a".repeat(50);
		let content = format!("{}b\n{}cccccc", "a".repeat(49), "a".repeat(44));
		let dominant = find_match(&content, &target, &FindMatchOptions {
			allow_fuzzy:     true,
			threshold:       Some(0.8),
			excluded_ranges: &[],
		});
		assert_eq!(dominant.dominant_fuzzy, Some(true));
		assert_eq!(dominant.fuzzy_matches, Some(2));
	}

	#[test]
	fn excluded_ranges_hide_exact_and_fuzzy_candidates() {
		let range = ExcludedRange { start_index: 0, end_index: 3 };
		let exact = find_match("foo\nfoo", "foo", &FindMatchOptions {
			allow_fuzzy:     false,
			threshold:       None,
			excluded_ranges: &[range],
		});
		assert_eq!(exact.matched.as_ref().map(|matched| matched.start_index), Some(4));

		let fuzzy = find_match("food\nfool", "foox", &FindMatchOptions {
			allow_fuzzy:     true,
			threshold:       Some(0.7),
			excluded_ranges: &[ExcludedRange { start_index: 0, end_index: 4 }],
		});
		assert_eq!(fuzzy.matched.as_ref().map(|matched| matched.start_line), Some(2));
	}

	#[test]
	fn sequence_matching_ladder() {
		assert_eq!(
			seek_sequence(&["foo", "bar", "baz"], &["bar", "baz"], 0, false, true).index,
			Some(1)
		);
		assert_eq!(
			seek_sequence(&["foo   ", "bar\t\t"], &["foo", "bar"], 0, false, true).strategy,
			Some(SequenceMatchStrategy::TrimTrailing)
		);
		assert_eq!(
			seek_sequence(&["    foo   ", "   bar\t"], &["foo", "bar"], 0, false, true).strategy,
			Some(SequenceMatchStrategy::Trim)
		);
		assert_eq!(
			seek_sequence(&["a", "b", "c", "d", "e"], &["d", "e"], 0, true, true).index,
			Some(3)
		);
		assert_eq!(
			seek_sequence(
				&["import asyncio  # local import – avoids top‑level dep"],
				&["import asyncio  # local import - avoids top-level dep"],
				0,
				false,
				true
			)
			.strategy,
			Some(SequenceMatchStrategy::Unicode)
		);
		assert_eq!(seek_sequence(&["foo", "bar"], &[], 5, false, true).index, Some(5));
		assert_eq!(seek_sequence(&["one"], &["too", "many"], 0, false, true).index, None);
		let minor = seek_sequence(
			&["function greet() {", "  console.log(\"Hello!\");", "}"],
			&["function greet() {", "  console.log(\"Hello!\")  ", "}"],
			0,
			false,
			true,
		);
		assert_eq!(minor.index, Some(0));
		assert!(minor.confidence >= SEQUENCE_FUZZY_THRESHOLD);
	}

	#[test]
	fn sequence_fuzzy_and_character_fallback() {
		let lines = [
			"function calculateTotal(items) {",
			"  let sum = 0;",
			"  for (const item of items) {",
			"    sum += item.price * item.quantity;",
			"  }",
			"  return sum;",
			"}",
		];
		let result = seek_sequence(
			&lines,
			&["  for (const item of items)  {", "    sum += item.price*item.quantity;"],
			0,
			false,
			true,
		);
		assert_eq!(result.index, Some(2));
		assert!(result.confidence > 0.9);
	}

	#[test]
	fn context_matching_ladder() {
		assert_eq!(
			find_context_line(&["function foo() {"], "function foo() {", 0, true, false).strategy,
			Some(ContextMatchStrategy::Exact)
		);
		assert_eq!(
			find_context_line(&["  function foo()  {"], "function foo() {", 0, true, false).strategy,
			Some(ContextMatchStrategy::Prefix)
		);
		assert_eq!(
			find_context_line(
				&["const msg = \"Hello – World\";"],
				"const msg = \"Hello - World\";",
				0,
				true,
				false
			)
			.index,
			Some(0)
		);
		assert_eq!(
			find_context_line(
				&["function calculateTotalWithTax(items, taxRate) {"],
				"function calculateTotalWithTax(items",
				0,
				true,
				false
			)
			.strategy,
			Some(ContextMatchStrategy::Prefix)
		);
		assert_eq!(
			find_context_line(&["// comment: calculateTotal here"], "calculateTotal", 0, true, false)
				.strategy,
			Some(ContextMatchStrategy::Substring)
		);
		let fuzzy = find_context_line(
			&["functoin calclateTotal(itms) {"],
			"function calculateTotal(items) {",
			0,
			true,
			false,
		);
		assert_eq!(fuzzy.strategy, Some(ContextMatchStrategy::Fuzzy));
		assert!(fuzzy.confidence > 0.8);
	}

	#[test]
	fn match_error_matches_typescript_formatter() {
		let closest = FuzzyMatch {
			actual_text: "alpha\ngamma".to_owned(),
			start_index: 10,
			start_line:  4,
			confidence:  0.874,
		};
		assert_eq!(
			format_match_error("src/a.ts", "alpha\nbeta", Some(&closest), true, 0.95, None),
			"Could not find a close enough match in src/a.ts.\n\nClosest match (87% similar) at line \
			 4:\n  - beta\n  + gamma\nClosest match was below the 95% similarity threshold."
		);
		assert_eq!(
			format_match_error("src/a.ts", "x", None, false, 0.95, None),
			"Could not find the exact text in src/a.ts. The old text must match exactly including \
			 all whitespace and newlines."
		);
		assert_eq!(
			format_match_error("src/a.ts", "alpha\nbeta", Some(&closest), true, 0.95, Some(3)),
			"Could not find a close enough match in src/a.ts.\n\nClosest match (87% similar) at line \
			 4:\n  - beta\n  + gamma\nFound 3 high-confidence matches. Provide more context to make \
			 it unique."
		);
		assert_eq!(
			format_match_error("src/a.ts", "alpha\nbeta", Some(&closest), false, 0.95, None),
			"Could not find the exact text in src/a.ts.\n\nClosest match (87% similar) at line 4:\n  \
			 - beta\n  + gamma\nFuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to \
			 accept high-confidence matches."
		);
		assert_eq!(
			format_match_error("src/a.ts", "x", None, true, 0.95, None),
			"Could not find a close enough match in src/a.ts."
		);
	}

	#[test]
	fn occurrence_error_includes_preview_limit_suffix() {
		let outcome = MatchOutcome {
			occurrences: Some(7),
			occurrence_previews: Some(vec!["preview".to_owned()]),
			..MatchOutcome::default()
		};
		assert_eq!(
			format_occurrence_error("a.ts", &outcome),
			"Found 7 occurrences in a.ts (showing first 5 of 7):\n\npreview\n\nAdd more context \
			 lines to disambiguate."
		);
	}

	#[test]
	fn replace_text_adjusts_indentation() {
		let result =
			replace_text("    foo\n    bar", "foo\nbar", "foo\nbaz\nbar", true, false, None).unwrap();
		assert_eq!(result, ReplaceResult {
			content: "    foo\n    baz\n    bar".to_owned(),
			count:   1,
		});

		let deindented = replace_text(
			"    foo\n    bar",
			"        foo\n        bar",
			"        foo\n        baz",
			true,
			false,
			Some(0.9),
		)
		.unwrap();
		assert_eq!(deindented.content, "    foo\n    baz");
	}

	#[test]
	fn replace_text_all_exact_and_fuzzy() {
		assert_eq!(
			replace_text("foo foo", "foo", "bar", false, true, None).unwrap(),
			ReplaceResult { content: "bar bar".to_owned(), count: 2 }
		);
		let old = "a".repeat(50);
		let first = format!("{}b", "a".repeat(49));
		let second = format!("{}cccccc", "a".repeat(44));
		let new = format!("{old}\nexpanded");
		assert_eq!(
			replace_text(&format!("{first}\n{second}"), &old, &new, true, true, Some(0.8)).unwrap(),
			ReplaceResult { content: format!("{new}\n{new}"), count: 2 }
		);
	}

	#[test]
	fn replace_text_reports_ambiguity_and_normalizes_line_endings() {
		let error = replace_text("foo\nbar\nfoo", "foo", "x", false, false, None).unwrap_err();
		assert!(error.to_string().starts_with("Found 2 occurrences:"));
		assert_eq!(
			replace_text("a\r\nb", "a\r\nb", "c\r\nd", false, false, None).unwrap(),
			ReplaceResult { content: "c\nd".to_owned(), count: 1 }
		);
		assert_eq!(replace_text("abc", "missing", "x", false, false, None).unwrap(), ReplaceResult {
			content: "abc".to_owned(),
			count:   0,
		});
	}

	#[test]
	fn empty_old_text_is_an_apply_error() {
		assert_eq!(
			replace_text("x", "", "y", false, false, None)
				.unwrap_err()
				.to_string(),
			"oldText must not be empty."
		);
	}
}
