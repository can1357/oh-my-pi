//! Text/sequence matching primitives shared by `replace`, `patch`, and
//! `sloppy`: Levenshtein similarity, whole-block fuzzy search,
//! line-sequence placement, and context-line placement.

use std::collections::{BTreeMap, HashMap};

use crate::{
	error::EditError,
	text::{
		FoldedDifference, adjust_indentation, count_leading_indent, folded_differences,
		is_non_empty_line, js_trim, js_trim_end, js_trim_start, normalize_for_fuzzy, normalize_to_lf,
		normalize_unicode, utf16_len,
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

/// [`levenshtein_distance`] over pre-collected chars, or `None` above `max`.
///
/// Only the `2·max + 1` diagonals that can stay within `max` are computed,
/// so the cost is O(len·max) instead of O(len²).
pub fn levenshtein_within(a: &[char], b: &[char], max: usize) -> Option<usize> {
	if a == b {
		return Some(0);
	}
	let shared = a
		.iter()
		.zip(b)
		.take_while(|(left, right)| left == right)
		.count();
	let (a, b) = (&a[shared..], &b[shared..]);
	let shared = a
		.iter()
		.rev()
		.zip(b.iter().rev())
		.take_while(|(left, right)| left == right)
		.count();
	let (a, b) = (&a[..a.len() - shared], &b[..b.len() - shared]);
	let (longer, shorter) = if a.len() >= b.len() { (a, b) } else { (b, a) };
	let (rows, columns) = (longer.len(), shorter.len());
	if rows - columns > max {
		return None;
	}
	if columns == 0 {
		return Some(rows);
	}
	// No distance exceeds `rows`; capping keeps `over` from overflowing.
	let max = max.min(rows);
	let over = max + 1;
	let mut previous: Vec<usize> = (0..=columns).map(|column| column.min(over)).collect();
	let mut current = vec![over; columns + 1];
	for row in 1..=rows {
		let low = row.saturating_sub(max).max(1);
		let high = (row + max).min(columns);
		current[0] = row.min(over);
		if low > 1 {
			current[low - 1] = over;
		}
		let mut row_min = current[0];
		let character = longer[row - 1];
		for column in low..=high {
			let substitute = previous[column - 1] + usize::from(character != shorter[column - 1]);
			let value = substitute
				.min(previous[column] + 1)
				.min(current[column - 1] + 1)
				.min(over);
			current[column] = value;
			row_min = row_min.min(value);
		}
		if high < columns {
			current[high + 1] = over;
		}
		if row_min > max {
			return None;
		}
		std::mem::swap(&mut previous, &mut current);
	}
	let distance = previous[columns];
	(distance <= max).then_some(distance)
}

/// [`levenshtein_distance`] from one fixed pattern to many texts.
///
/// Myers' bit-parallel algorithm with Hyyrö's 64-row blocks costs
/// O(text · ⌈pattern / 64⌉) word operations once the pattern's character
/// masks are built.
pub struct PatternDistance {
	len:      usize,
	words:    usize,
	/// Masks for ASCII characters, `words` per code point.
	ascii:    Vec<u64>,
	other:    HashMap<char, Vec<u64>>,
	zeros:    Vec<u64>,
	/// The last pattern row's bit in the last word.
	last_bit: u64,
}

impl PatternDistance {
	pub fn new(pattern: &[char]) -> Self {
		let len = pattern.len();
		let words = len.div_ceil(64).max(1);
		let mut ascii = vec![0; 128 * words];
		let mut other: HashMap<char, Vec<u64>> = HashMap::new();
		for (row, &character) in pattern.iter().enumerate() {
			let (word, bit) = (row / 64, 1u64 << (row % 64));
			if character.is_ascii() {
				ascii[character as usize * words + word] |= bit;
			} else {
				other.entry(character).or_insert_with(|| vec![0; words])[word] |= bit;
			}
		}
		let last_bit = 1u64 << (len.saturating_sub(1) % 64);
		Self { len, words, ascii, other, zeros: vec![0; words], last_bit }
	}

	/// Edit distance between the pattern and `text`.
	pub fn distance(&self, text: &[char]) -> usize {
		if self.len == 0 {
			return text.len();
		}
		let words = self.words;
		// Vertical deltas between adjacent rows: all +1 in column 0.
		let mut positive = vec![!0u64; words];
		let mut negative = vec![0u64; words];
		let mut score = self.len;
		for &character in text {
			let masks = if character.is_ascii() {
				&self.ascii[character as usize * words..][..words]
			} else {
				self
					.other
					.get(&character)
					.map_or(&self.zeros[..], Vec::as_slice)
			};
			// Global distance: the top row grows by one per text character.
			let (mut carry_positive, mut carry_negative) = (true, false);
			for word in 0..words {
				let (vertical_positive, vertical_negative) = (positive[word], negative[word]);
				let mut equal = masks[word];
				let vertical = equal | vertical_negative;
				if carry_negative {
					equal |= 1;
				}
				let horizontal = ((equal & vertical_positive).wrapping_add(vertical_positive)
					^ vertical_positive)
					| equal;
				let mut horizontal_positive = vertical_negative | !(horizontal | vertical_positive);
				let mut horizontal_negative = vertical_positive & horizontal;
				let high = if word + 1 == words {
					self.last_bit
				} else {
					1 << 63
				};
				let out_positive = horizontal_positive & high != 0;
				let out_negative = horizontal_negative & high != 0;
				horizontal_positive = (horizontal_positive << 1) | u64::from(carry_positive);
				horizontal_negative = (horizontal_negative << 1) | u64::from(carry_negative);
				positive[word] = horizontal_negative | !(vertical | horizontal_positive);
				negative[word] = horizontal_positive & vertical;
				(carry_positive, carry_negative) = (out_positive, out_negative);
			}
			if carry_positive {
				score += 1;
			} else if carry_negative {
				score -= 1;
			}
		}
		score
	}
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
				.count()
				+ 1;
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
		.map(|line| count_leading_indent(line))
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

/// Maximum number of body differences named in a match-error hint.
const MAX_HINTED_DIFFERENCES: usize = 8;

/// Codepoint-level hint for a diff pair whose characters differ in forms the
/// fuzzy matcher folds together (typographic quotes, dashes, fullwidth
/// variants) or in whitespace the terminal renders as blank space. Terminals
/// render both sides alike, so the printed pair reads as identical and leaves
/// the caller no actionable difference.
///
/// Only exact mode reports the hint: with fuzzy matching enabled both sides
/// are normalized before scoring, so a folded variant is free and can never be
/// the reason the match was rejected — naming it would point at a difference
/// the matcher does not charge for.
///
/// The body of the two lines is compared the way the matcher compares it:
/// through the same folding, so the characters line up even when one of the
/// two lines inserted or deleted whitespace in front of a difference. The
/// leading and trailing whitespace are compared separately: the matcher trims
/// them away, but an exact match charges for them, so trimming them here
/// would hide a difference the caller has to reproduce. The reported position
/// is a character index into the expected line's body, not a display column.
///
/// Returns `None` when the pair differs nowhere the caller cannot see: no
/// folded difference in the body and no differing boundary codepoint.
fn folded_difference_hint(expected: &str, actual: &str, allow_fuzzy: bool) -> Option<String> {
	if allow_fuzzy {
		return None;
	}
	let (expected_leading, expected_body, expected_trailing) = split_boundary_whitespace(expected);
	let (actual_leading, actual_body, actual_trailing) = split_boundary_whitespace(actual);
	let mut hints: Vec<String> = Vec::new();
	hints.extend(boundary_difference_hint("start", expected_leading, actual_leading));
	let mut body_hints = 0usize;
	let mut omitted = 0usize;
	for difference in folded_differences(expected_body, actual_body) {
		if body_hints == MAX_HINTED_DIFFERENCES {
			omitted += 1;
			continue;
		}
		body_hints += 1;
		hints.push(folded_difference_line(difference));
	}
	hints.extend(boundary_difference_hint("end", expected_trailing, actual_trailing));
	if hints.is_empty() {
		return None;
	}
	if omitted > 0 {
		hints.push(format!("  ... and {omitted} more differences"));
	}
	Some(hints.join("\n"))
}

/// The hint for one folded difference.
///
/// A whitespace glyph is left out: it renders as blank space — a tab renders
/// as a hole once the renderer replaces it — so the codepoints alone tell the
/// caller what to reproduce.
///
/// A difference one side has and the other one does not — the codepoints a
/// longer whitespace run has in excess — is reported with its count and the
/// side it is on.
fn folded_difference_line(difference: FoldedDifference) -> String {
	let index = difference.index + 1;
	match (difference.expected, difference.actual) {
		(Some(expected_char), Some(actual_char))
			if expected_char.is_whitespace() || actual_char.is_whitespace() =>
		{
			format!(
				"  differs at char {index}: U+{:04X} vs U+{:04X}",
				expected_char as u32, actual_char as u32
			)
		},
		(Some(expected_char), Some(actual_char)) => {
			format!(
				"  differs at char {index}: U+{:04X} {expected_char} vs U+{:04X} {actual_char}",
				expected_char as u32, actual_char as u32
			)
		},
		(Some(expected_char), None) => {
			format!(
				"  differs at char {index}: U+{:04X} x{} only in the - line",
				expected_char as u32, difference.count
			)
		},
		(None, Some(actual_char)) => {
			format!(
				"  differs at char {index}: U+{:04X} x{} only in the + line",
				actual_char as u32, difference.count
			)
		},
		(None, None) => String::new(),
	}
}

/// Split a line into its leading whitespace, its body and its trailing
/// whitespace.
///
/// `js_trim` erases the boundary whitespace, but an exact match charges for
/// it, so the regions are kept to report the codepoints that differ.
fn split_boundary_whitespace(line: &str) -> (&str, &str, &str) {
	let start = line.len() - js_trim_start(line).len();
	let end = js_trim_end(line).len();
	if start >= end {
		// The line is nothing but whitespace.
		return (line, "", "");
	}
	(&line[..start], &line[start..end], &line[end..])
}

/// The boundary whitespace that differs between the two lines. The glyphs are
/// omitted: whitespace renders as blank space, so only the codepoint tells
/// the caller what to reproduce.
///
/// Every unequal pair counts, not only the ones the matcher folds together.
/// The boundary whitespace is trimmed away before the match is scored, so an
/// exact match is the only thing that charges for it — and it charges for the
/// codepoint, not for the shape: a no-break space (`U+00A0`), a tab and the
/// ideographic space (`U+3000`) all render as blank space.
///
/// One line can carry boundary whitespace the other one does not have at all.
/// The paired comparison never reaches those characters, so they are reported
/// with their codepoint and count.
fn boundary_difference_hint(position: &str, expected: &str, actual: &str) -> Vec<String> {
	let expected_chars: Vec<char> = expected.chars().collect();
	let actual_chars: Vec<char> = actual.chars().collect();
	let mut hints = Vec::new();
	if let Some((expected_char, actual_char)) = expected_chars
		.iter()
		.copied()
		.zip(actual_chars.iter().copied())
		.find(|(expected_char, actual_char)| expected_char != actual_char)
	{
		hints.push(format!(
			"  differs at the {position}: U+{:04X} vs U+{:04X}",
			expected_char as u32, actual_char as u32
		));
		return hints;
	}
	// The characters left over after the paired comparison: one line has
	// boundary whitespace where the other has none.
	let (leftover, side) = if expected_chars.len() > actual_chars.len() {
		(&expected_chars[actual_chars.len()..], "-")
	} else if actual_chars.len() > expected_chars.len() {
		(&actual_chars[expected_chars.len()..], "+")
	} else {
		return hints;
	};
	let mut counts: BTreeMap<char, usize> = BTreeMap::new();
	for ch in leftover {
		*counts.entry(*ch).or_insert(0) += 1;
	}
	let codepoints = counts
		.iter()
		.map(|(ch, count)| format!("U+{:04X} x{count}", *ch as u32))
		.collect::<Vec<_>>()
		.join(", ");
	hints.push(format!("  differs at the {position}: {codepoints} only in the {side} line"));
	hints
}

/// Format `EditMatchError.formatMessage` byte-for-byte, plus a codepoint hint
/// when fuzzy matching is disabled and the printed diff pair differs in
/// characters the matcher folds together.
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
	// The matcher compares the text with the line endings normalized to LF, so
	// the printed pair is built from the same text: a `\r` the matcher folded
	// away is not a difference the caller has to reproduce, and reporting it
	// would hide the difference that is.
	let normalized_search = normalize_to_lf(search_text);
	let normalized_actual = normalize_to_lf(&closest.actual_text);
	let search_lines: Vec<&str> = normalized_search.split('\n').collect();
	let actual_lines: Vec<&str> = normalized_actual.split('\n').collect();
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
	let difference_hint = folded_difference_hint(old_line, new_line, allow_fuzzy)
		.map_or_else(String::new, |hint| format!("{hint}\n"));
	format!(
		"{heading}\n\nClosest match ({similarity_percent}% similar) at line {}:\n  - {old_line}\n  \
		 + {new_line}\n{difference_hint}{hint}",
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

/// What [`replace_text`] did.
#[derive(Debug, Clone, PartialEq)]
pub enum ReplaceOutcome {
	/// At least one replacement.
	Replaced(ReplaceResult),
	/// Nothing replaced: the search found several exact occurrences, no
	/// match, or only a match the replacement leaves unchanged. Callers
	/// format their error from it instead of searching again.
	Missed(MatchOutcome),
}

#[derive(Debug)]
struct Replacement {
	start: usize,
	end:   usize,
	text:  String,
}

/// Find and replace text using the same exact/fuzzy behavior as `replaceText`.
pub fn replace_text(
	content: &str,
	old_text: &str,
	new_text: &str,
	fuzzy: bool,
	all: bool,
	threshold: Option<f64>,
) -> Result<ReplaceOutcome, EditError> {
	if old_text.is_empty() {
		return Err(EditError::apply("oldText must not be empty."));
	}
	let threshold = threshold.unwrap_or(DEFAULT_FUZZY_THRESHOLD);
	let normalized_content = normalize_to_lf(content);
	let normalized_old = normalize_to_lf(old_text);
	let normalized_new = normalize_to_lf(new_text);
	if all {
		let exact_count = normalized_content
			.match_indices(normalized_old.as_ref())
			.count();
		if exact_count > 0 {
			return Ok(ReplaceOutcome::Replaced(ReplaceResult {
				content: normalized_content.replace(normalized_old.as_ref(), normalized_new.as_ref()),
				count:   exact_count,
			}));
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
				.as_ref()
				.or_else(|| outcome.closest.as_ref().filter(|_| should_use_closest));
			let adjusted = matched.map(|matched| {
				adjust_indentation(
					normalized_old.as_ref(),
					&matched.actual_text,
					normalized_new.as_ref(),
				)
			});
			let (Some(matched), Some(adjusted)) = (matched, adjusted) else {
				if replacements.is_empty() {
					return Ok(ReplaceOutcome::Missed(outcome));
				}
				break;
			};
			if adjusted == matched.actual_text {
				if replacements.is_empty() {
					return Ok(ReplaceOutcome::Missed(outcome));
				}
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
		return Ok(ReplaceOutcome::Replaced(ReplaceResult {
			content: output,
			count:   replacements.len(),
		}));
	}

	let outcome = find_match(&normalized_content, normalized_old.as_ref(), &FindMatchOptions {
		allow_fuzzy:     fuzzy,
		threshold:       Some(threshold),
		excluded_ranges: &[],
	});
	let matched = match &outcome.matched {
		Some(matched) if outcome.occurrences.is_none_or(|count| count <= 1) => matched,
		_ => return Ok(ReplaceOutcome::Missed(outcome)),
	};
	let adjusted =
		adjust_indentation(normalized_old.as_ref(), &matched.actual_text, normalized_new.as_ref());
	let mut output =
		String::with_capacity(normalized_content.len() - matched.actual_text.len() + adjusted.len());
	output.push_str(&normalized_content[..matched.start_index]);
	output.push_str(&adjusted);
	output.push_str(&normalized_content[matched.start_index + matched.actual_text.len()..]);
	Ok(ReplaceOutcome::Replaced(ReplaceResult { content: output, count: 1 }))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::modes::replace::ReplaceEngine;

	#[test]
	fn fast_distances_match_reference_across_block_boundaries() {
		// Patterns straddling the 64-row word boundaries of the bit-parallel
		// distance, with non-ASCII rows and texts shorter, equal and longer.
		let mut state = 0x5eed_u64;
		let mut next = |bound: usize| {
			state = state
				.wrapping_mul(6_364_136_223_846_793_005)
				.wrapping_add(1);
			((state >> 33) as usize) % bound
		};
		let alphabet = ['a', 'b', 'é', '界'];
		for pattern_len in [0, 1, 63, 64, 65, 127, 128, 129] {
			for _ in 0..40 {
				let pattern: Vec<char> = (0..pattern_len).map(|_| alphabet[next(4)]).collect();
				let mut text = pattern.clone();
				for _ in 0..next(12) {
					let at = next(text.len() + 1);
					match next(3) {
						0 => text.insert(at, alphabet[next(4)]),
						1 if at < text.len() => drop(text.remove(at)),
						_ if at < text.len() => text[at] = alphabet[next(4)],
						_ => {},
					}
				}
				let expected = levenshtein_chars(&pattern, &text);
				assert_eq!(PatternDistance::new(&pattern).distance(&text), expected);
				for max in [0, expected.saturating_sub(1), expected, expected + 3] {
					assert_eq!(
						levenshtein_within(&pattern, &text, max),
						(expected <= max).then_some(expected),
						"len {pattern_len} max {max}"
					);
				}
			}
		}
	}

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
	fn match_error_names_folded_codepoint_differences() {
		// Exact mode charges for the folded difference, so the error names the
		// codepoints the terminal renders identically.
		assert_eq!(
			exact_edit_error("foo（bar）＝1", "foo(bar)=1", "x"),
			concat!(
				"Could not find the exact text in a.ts.\n\nClosest match (100% similar) at line 1:\n",
				"  - foo(bar)=1\n",
				"  + foo（bar）＝1\n",
				"  differs at char 4: U+0028 ( vs U+FF08 （\n",
				"  differs at char 8: U+0029 ) vs U+FF09 ）\n",
				"  differs at char 9: U+003D = vs U+FF1D ＝\n",
				"Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept \
				 high-confidence matches."
			)
		);
	}

	#[test]
	fn match_error_names_folded_differences_ignoring_indentation() {
		// The matcher compares trimmed lines, so an indentation difference must
		// not shift the character positions of the folded pairs.
		assert_eq!(
			exact_edit_error("\tfoo（bar）＝1", "  foo(bar)=1", "x"),
			concat!(
				"Could not find the exact text in a.ts.\n\nClosest match (100% similar) at line 1:\n",
				"  -   foo(bar)=1\n",
				"  + \tfoo（bar）＝1\n",
				"  differs at the start: U+0020 vs U+0009\n",
				"  differs at char 4: U+0028 ( vs U+FF08 （\n",
				"  differs at char 8: U+0029 ) vs U+FF09 ）\n",
				"  differs at char 9: U+003D = vs U+FF1D ＝\n",
				"Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept \
				 high-confidence matches."
			)
		);
	}

	#[test]
	fn match_error_omits_folded_difference_hint_in_fuzzy_mode() {
		// With fuzzy matching enabled a folded variant is free, so it cannot be
		// the reason the match was rejected and must not be named.
		let error = fuzzy_edit_error("foo（bar）＝2", "foo(bar)=1", "x");
		assert!(error.starts_with("Could not find a close enough match in a.ts."), "{error}");
		assert!(error.contains("Closest match was below the 95% similarity threshold."), "{error}");
		assert!(!error.contains("differs at"), "{error}");
	}

	#[test]
	fn match_error_names_folded_boundary_difference() {
		// The matcher trims the boundary whitespace but an exact match charges
		// for it, so the codepoints of the invisible boundary difference have
		// to be named.
		assert_eq!(
			exact_edit_error("foo\u{3000}", "foo\u{20}", "x"),
			concat!(
				"Could not find the exact text in a.ts.\n\nClosest match (100% similar) at line 1:\n",
				"  - foo\u{20}\n",
				"  + foo\u{3000}\n",
				"  differs at the end: U+0020 vs U+3000\n",
				"Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept \
				 high-confidence matches."
			)
		);
		assert_eq!(
			exact_edit_error("\u{3000}foo", "\u{20}foo", "x"),
			concat!(
				"Could not find the exact text in a.ts.\n\nClosest match (100% similar) at line 1:\n",
				"  - \u{20}foo\n",
				"  + \u{3000}foo\n",
				"  differs at the start: U+0020 vs U+3000\n",
				"Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept \
				 high-confidence matches."
			)
		);
	}

	#[test]
	fn match_error_names_boundary_whitespace_codepoints() {
		// Every unequal boundary codepoint has to be named, not only the ones
		// the matcher folds together: a no-break space and a tab render as
		// blank space just like the ideographic space, and the exact match
		// charges for them all the same.
		assert_eq!(
			exact_edit_error("foo\u{00A0}", "foo\u{20}", "x"),
			concat!(
				"Could not find the exact text in a.ts.\n\nClosest match (100% similar) at line 1:\n",
				"  - foo\u{20}\n",
				"  + foo\u{00A0}\n",
				"  differs at the end: U+0020 vs U+00A0\n",
				"Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept \
				 high-confidence matches."
			)
		);
		assert_eq!(
			exact_edit_error("foo\t", "foo\u{20}", "x"),
			concat!(
				"Could not find the exact text in a.ts.\n\nClosest match (100% similar) at line 1:\n",
				"  - foo\u{20}\n",
				"  + foo\t\n",
				"  differs at the end: U+0020 vs U+0009\n",
				"Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept \
				 high-confidence matches."
			)
		);
		assert_eq!(
			exact_edit_error("\u{00A0}foo", "\u{20}foo", "x"),
			concat!(
				"Could not find the exact text in a.ts.\n\nClosest match (100% similar) at line 1:\n",
				"  - \u{20}foo\n",
				"  + \u{00A0}foo\n",
				"  differs at the start: U+0020 vs U+00A0\n",
				"Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept \
				 high-confidence matches."
			)
		);
	}

	#[test]
	fn match_error_names_folded_interior_whitespace() {
		// The matcher folds a tab onto a space, so the two lines are the same
		// line — but the renderer replaces the tab, so the printed pair reads
		// as identical. The codepoints have to be named.
		assert_eq!(
			exact_edit_error("foo\tbar", "foo bar", "x"),
			concat!(
				"Could not find the exact text in a.ts.\n\nClosest match (100% similar) at line 1:\n",
				"  - foo bar\n",
				"  + foo\tbar\n",
				"  differs at char 4: U+0020 vs U+0009\n",
				"Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept \
				 high-confidence matches."
			)
		);
	}

	#[test]
	fn match_error_names_unpaired_boundary_whitespace() {
		// One line carries boundary whitespace the other one does not have at
		// all: the paired comparison never reaches those characters, so they
		// have to be named with their codepoint and count.
		assert_eq!(
			exact_edit_error("foo\u{3000}\nbar", "foo\nbar", "x"),
			concat!(
				"Could not find the exact text in a.ts.\n\nClosest match (100% similar) at line 1:\n",
				"  - foo\n",
				"  + foo\u{3000}\n",
				"  differs at the end: U+3000 x1 only in the + line\n",
				"Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept \
				 high-confidence matches."
			)
		);
	}

	#[test]
	fn match_error_names_folded_differences_after_collapsed_whitespace() {
		// The matcher folds the whitespace run away, so the fullwidth parens
		// line up with the halfwidth ones — the raw character positions do
		// not. The run is compared codepoint by codepoint, so the space the
		// file has in excess is named as well.
		assert_eq!(
			exact_edit_error("a  （x）", "a (x)", "x"),
			concat!(
				"Could not find the exact text in a.ts.\n\nClosest match (100% similar) at line 1:\n",
				"  - a (x)\n",
				"  + a  （x）\n",
				"  differs at char 3: U+0020 x1 only in the + line\n",
				"  differs at char 3: U+0028 ( vs U+FF08 （\n",
				"  differs at char 5: U+0029 ) vs U+FF09 ）\n",
				"Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept \
				 high-confidence matches."
			)
		);
	}

	#[test]
	fn fuzzy_match_accepts_boundary_whitespace_difference() {
		// With fuzzy matching enabled the boundary whitespace is free, so the
		// edit is accepted instead of rejected.
		let result = ReplaceEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 }
			.replace("foo\u{3000}", "foo\u{20}", "bar", false, "a.ts")
			.expect("fuzzy matching accepts the boundary whitespace");
		assert_eq!(result, ReplaceResult { content: "bar".to_owned(), count: 1 });
	}

	#[test]
	fn replace_folds_fullwidth_punctuation() {
		let result = replaced(
			replace_text(
				"let x = foo（bar）＝1;\n",
				"let x = foo(bar)=1;",
				"let x = 2;",
				true,
				false,
				Some(0.95),
			)
			.expect("halfwidth anchor must match fullwidth content"),
		);
		assert_eq!(result.content, "let x = 2;\n");
		assert_eq!(result.count, 1);
	}

	#[test]
	fn replace_keeps_indentation_when_ideographic_space_is_folded() {
		// The fuzzy matcher folds the ideographic space onto an ASCII space,
		// so this anchor matches the line — but the replacement has to keep
		// the indentation of the line it replaces.
		let result = replaced(
			replace_text("\u{3000}foo", " foo", " bar", true, false, None)
				.expect("the folded anchor must match the line"),
		);
		assert_eq!(result, ReplaceResult { content: " bar".to_owned(), count: 1 });
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
	fn match_error_names_the_codepoint_inside_a_folded_whitespace_run() {
		// The matcher collapses the whitespace run into a single space, so the
		// two lines are the same line — but the tab the file holds renders as
		// blank space, so its codepoint has to be named.
		assert_eq!(
			exact_edit_error("foo \tbar", "foo     bar", "x"),
			concat!(
				"Could not find the exact text in a.ts.\n\nClosest match (100% similar) at line 1:\n",
				"  - foo     bar\n",
				"  + foo \tbar\n",
				"  differs at char 5: U+0020 vs U+0009\n",
				"Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept \
				 high-confidence matches."
			)
		);
	}

	#[test]
	fn match_error_normalizes_the_line_endings_before_naming_the_difference() {
		// The matcher folds the carriage return away, so it is not a
		// difference the caller has to reproduce: the difference behind it
		// has to be named instead.
		let error = exact_edit_error("foo\nbaz", "foo\r\nbar", "x");
		assert!(error.contains("  - bar\n  + baz"), "{error}");
		assert!(!error.contains('\r'), "{error}");
		assert!(!error.contains("U+000D"), "{error}");
	}

	fn replaced(outcome: ReplaceOutcome) -> ReplaceResult {
		match outcome {
			ReplaceOutcome::Replaced(result) => result,
			ReplaceOutcome::Missed(outcome) => panic!("expected a replacement, missed: {outcome:?}"),
		}
	}

	/// The error a rejected exact edit shows the model.
	fn exact_edit_error(content: &str, old_string: &str, new_string: &str) -> String {
		ReplaceEngine { allow_fuzzy: false, fuzzy_threshold: 0.95 }
			.replace(content, old_string, new_string, false, "a.ts")
			.expect_err("the exact edit must be rejected")
			.to_string()
	}

	/// The error a rejected fuzzy edit shows the model.
	fn fuzzy_edit_error(content: &str, old_string: &str, new_string: &str) -> String {
		ReplaceEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 }
			.replace(content, old_string, new_string, false, "a.ts")
			.expect_err("the fuzzy edit must be rejected")
			.to_string()
	}

	#[test]
	fn replace_text_adjusts_indentation() {
		let result = replaced(
			replace_text("    foo\n    bar", "foo\nbar", "foo\nbaz\nbar", true, false, None).unwrap(),
		);
		assert_eq!(result, ReplaceResult {
			content: "    foo\n    baz\n    bar".to_owned(),
			count:   1,
		});

		let deindented = replaced(
			replace_text(
				"    foo\n    bar",
				"        foo\n        bar",
				"        foo\n        baz",
				true,
				false,
				Some(0.9),
			)
			.unwrap(),
		);
		assert_eq!(deindented.content, "    foo\n    baz");
	}

	#[test]
	fn replace_text_all_exact_and_fuzzy() {
		assert_eq!(
			replaced(replace_text("foo foo", "foo", "bar", false, true, None).unwrap()),
			ReplaceResult { content: "bar bar".to_owned(), count: 2 }
		);
		let old = "a".repeat(50);
		let first = format!("{}b", "a".repeat(49));
		let second = format!("{}cccccc", "a".repeat(44));
		let new = format!("{old}\nexpanded");
		assert_eq!(
			replaced(
				replace_text(&format!("{first}\n{second}"), &old, &new, true, true, Some(0.8)).unwrap()
			),
			ReplaceResult { content: format!("{new}\n{new}"), count: 2 }
		);
	}

	#[test]
	fn replace_text_misses_on_ambiguity_and_normalizes_line_endings() {
		let ReplaceOutcome::Missed(ambiguous) =
			replace_text("foo\nbar\nfoo", "foo", "x", false, false, None).unwrap()
		else {
			panic!("two exact occurrences must not be replaced");
		};
		assert_eq!(ambiguous.occurrences, Some(2));
		assert_eq!(
			replaced(replace_text("a\r\nb", "a\r\nb", "c\r\nd", false, false, None).unwrap()),
			ReplaceResult { content: "c\nd".to_owned(), count: 1 }
		);
		let ReplaceOutcome::Missed(missing) =
			replace_text("abc", "missing", "x", false, false, None).unwrap()
		else {
			panic!("an absent string must not be replaced");
		};
		assert!(missing.matched.is_none());
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
