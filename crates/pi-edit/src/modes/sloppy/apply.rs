//! Sloppy matching and application: pattern parsing, candidate location,
//! rewrite planning, overlap reconciliation, echo recovery, and the atomic
//! apply.
//!
//! Port of `packages/coding-agent/src/edit/sloppy.ts` lines 1651–4258.

use std::{
	collections::{BTreeMap, BTreeSet, HashMap, HashSet},
	path::Path,
};

use super::{
	parse::{has_marker_lines, missing_unmarked_lines, operation_payload, parse_operations},
	types::{
		ATOMICITY_NOTICE, Candidate, CandidateResult, LiteralFallback, MAX_CANDIDATES,
		MAX_COMBINATIONS, NormalizedText, Occurrence, Operation, OperationRewrite, ParsedPattern,
		PatternToken, PlannedEdit, SelectionPair,
		markers::{GAP, SELECT_CLOSE, SELECT_DIVIDER, SELECT_OPEN},
	},
};
use crate::{
	error::EditError, fuzzy::levenshtein_distance, store::EditStore, text::normalize_unicode,
};

/// State shared by every operation in one file section.
pub struct ApplyContext<'a> {
	pub path:      &'a str,
	pub notes:     &'a mut Vec<String>,
	pub store:     &'a EditStore,
	pub canonical: &'a Path,
}

/// Normalize matching text while retaining source byte boundaries.
pub fn normalize_text(source: &str) -> NormalizedText {
	let mut text = String::with_capacity(source.len());
	let mut starts = Vec::with_capacity(source.len());
	let mut ends = Vec::with_capacity(source.len());
	for (start, character) in source.char_indices() {
		let end = start + character.len_utf8();
		if character.is_ascii_whitespace() {
			continue;
		}
		let normalized = if character.is_ascii() {
			character.to_string()
		} else {
			normalize_unicode(&character.to_string())
		};
		text.push_str(&normalized);
		for _ in normalized.bytes() {
			starts.push(start);
			ends.push(end);
		}
	}
	NormalizedText { text, starts, ends }
}

fn visible_identifier(text: &str) -> bool {
	text
		.chars()
		.any(|character| character.is_alphanumeric() || matches!(character, '_' | '$'))
}

pub(crate) fn parse_pattern(
	pattern: &str,
	operation_number: usize,
) -> Result<ParsedPattern, EditError> {
	if pattern.trim().is_empty() {
		return Err(EditError::matched(format!(
			"Operation {operation_number} has an empty pattern."
		)));
	}
	let open_count = pattern.matches(SELECT_OPEN).count();
	let close_count = pattern.matches(SELECT_CLOSE).count();
	if open_count > close_count {
		return Err(EditError::matched(format!(
			"Operation {operation_number} has an unclosed selection marker {SELECT_OPEN}; add \
			 closing {SELECT_CLOSE}."
		)));
	}
	if close_count > open_count {
		return Err(EditError::matched(format!(
			"Operation {operation_number} has an unmatched closing selection marker {SELECT_CLOSE}; \
			 add opening {SELECT_OPEN}."
		)));
	}
	let has_gap = pattern.contains(GAP);
	let has_selection = pattern.contains(SELECT_OPEN);
	if !has_gap && !has_selection {
		let normalized = normalize_text(pattern).text;
		if normalized.is_empty() {
			return Err(EditError::matched(format!(
				"Operation {operation_number} has no visible current text."
			)));
		}
		return Ok(ParsedPattern {
			tokens:                   vec![PatternToken::Literal {
				text: pattern.to_owned(),
				normalized,
			}],
			selection_start:          0,
			selection_end:            1,
			insertion:                false,
			line_insertion:           false,
			selected_capture_indices: Vec::new(),
			selection_ranges:         Vec::new(),
			selection_pairs:          Vec::new(),
			literal_fallback:         None,
		});
	}

	let mut tokens = Vec::new();
	let mut literal = String::new();
	let mut capture_count = 0;
	let mut selection_boundaries = Vec::new();
	let mut selection_line_starts = Vec::new();
	let mut selection_raw_offsets = Vec::new();
	let flush = |tokens: &mut Vec<PatternToken>, literal: &mut String| {
		if literal.is_empty() {
			return;
		}
		let normalized = normalize_text(literal).text;
		if normalized.is_empty() {
			literal.clear();
		} else {
			tokens.push(PatternToken::Literal { text: std::mem::take(literal), normalized });
		}
	};
	let mut index = 0;
	while index < pattern.len() {
		let rest = &pattern[index..];
		if rest.starts_with(GAP) {
			flush(&mut tokens, &mut literal);
			if matches!(tokens.last(), Some(PatternToken::Gap { .. })) {
				return Err(EditError::matched(format!(
					"Operation {operation_number} has adjacent {GAP}; use one ellipsis."
				)));
			}
			let line_start = pattern[..index].rfind('\n').map_or(0, |at| at + 1);
			let line_end = pattern[index + GAP.len()..]
				.find('\n')
				.map_or(pattern.len(), |at| index + GAP.len() + at);
			let before = pattern[line_start..index]
				.replace(SELECT_OPEN, "")
				.replace(SELECT_CLOSE, "");
			let after = pattern[index + GAP.len()..line_end]
				.replace(SELECT_OPEN, "")
				.replace(SELECT_CLOSE, "");
			tokens.push(PatternToken::Gap {
				capture_index: capture_count,
				line_bounded:  !before.trim().is_empty() && !after.trim().is_empty(),
			});
			capture_count += 1;
			index += GAP.len();
			continue;
		}
		if rest.starts_with(SELECT_OPEN) || rest.starts_with(SELECT_CLOSE) {
			let opening = rest.starts_with(SELECT_OPEN);
			flush(&mut tokens, &mut literal);
			selection_boundaries.push(tokens.len());
			selection_raw_offsets.push(index);
			let line_start = pattern[..index].rfind('\n').map_or(0, |at| at + 1);
			selection_line_starts.push(opening && pattern[line_start..index].trim().is_empty());
			index += if opening {
				SELECT_OPEN.len()
			} else {
				SELECT_CLOSE.len()
			};
			continue;
		}
		let character = rest.chars().next().expect("non-empty suffix");
		literal.push(character);
		index += character.len_utf8();
	}
	flush(&mut tokens, &mut literal);

	let mut stripped_leading = 0;
	while matches!(tokens.first(), Some(PatternToken::Gap { .. })) {
		tokens.remove(0);
		stripped_leading += 1;
	}
	while matches!(tokens.last(), Some(PatternToken::Gap { .. })) {
		tokens.pop();
	}
	for boundary in &mut selection_boundaries {
		*boundary = boundary.saturating_sub(stripped_leading).min(tokens.len());
	}
	let literals = tokens
		.iter()
		.filter_map(|token| match token {
			PatternToken::Literal { normalized, .. } => Some(normalized),
			PatternToken::Gap { .. } => None,
		})
		.collect::<Vec<_>>();
	if literals.is_empty() {
		return Err(EditError::matched(format!(
			"Operation {operation_number} needs visible current text."
		)));
	}
	if !literals.iter().any(|literal| visible_identifier(literal)) {
		return Err(EditError::matched(format!(
			"Operation {operation_number} pattern is too generic; include a distinctive name or \
			 statement."
		)));
	}
	let empty_double =
		selection_boundaries.len() == 2 && selection_boundaries[0] == selection_boundaries[1];
	let insertion = selection_boundaries.len() == 1 || empty_double;
	let explicit_single = selection_boundaries.len() == 2 && !empty_double;
	let selection_start = if insertion || explicit_single {
		selection_boundaries[0]
	} else {
		0
	};
	let selection_end = if insertion {
		selection_start
	} else if explicit_single {
		selection_boundaries[1]
	} else {
		tokens.len()
	};
	let mut selection_pairs = Vec::new();
	if !selection_boundaries.is_empty() && selection_boundaries.len() % 2 == 0 {
		for pair_index in 0..selection_boundaries.len() / 2 {
			let start = selection_boundaries[pair_index * 2];
			let end = selection_boundaries[pair_index * 2 + 1];
			let capture_indices = tokens[start..end]
				.iter()
				.filter_map(|token| match token {
					PatternToken::Gap { capture_index, .. } => Some(*capture_index),
					PatternToken::Literal { .. } => None,
				})
				.collect();
			selection_pairs.push(SelectionPair {
				start,
				end,
				capture_indices,
				line_insertion: start == end
					&& selection_line_starts
						.get(pair_index * 2)
						.copied()
						.unwrap_or(false),
				gap_only: start < end
					&& tokens[start..end]
						.iter()
						.all(|token| matches!(token, PatternToken::Gap { .. })),
			});
		}
	}
	let selection_ranges = if selection_pairs.len() > 1 {
		selection_pairs
			.iter()
			.map(|pair| (pair.start, pair.end))
			.collect()
	} else {
		Vec::new()
	};
	let selected_capture_indices = tokens[selection_start..selection_end]
		.iter()
		.filter_map(|token| match token {
			PatternToken::Gap { capture_index, .. } => Some(*capture_index),
			PatternToken::Literal { .. } => None,
		})
		.collect();
	let literal_fallback = if selection_ranges.is_empty() && pattern.contains(GAP) {
		let fallback = pattern.replace(SELECT_OPEN, "").replace(SELECT_CLOSE, "");
		let normalized = normalize_text(&fallback).text;
		let normalized_offset = |raw: usize| {
			normalize_text(
				&pattern[..raw]
					.replace(SELECT_OPEN, "")
					.replace(SELECT_CLOSE, ""),
			)
			.text
			.len()
		};
		Some(LiteralFallback {
			selection_start: if insertion || explicit_single {
				normalized_offset(selection_raw_offsets[0])
			} else {
				0
			},
			selection_end: if insertion {
				normalized_offset(selection_raw_offsets[0])
			} else if explicit_single {
				normalized_offset(selection_raw_offsets[1])
			} else {
				normalized.len()
			},
			insertion,
			normalized,
		})
	} else {
		None
	};
	Ok(ParsedPattern {
		tokens,
		selection_start,
		selection_end,
		insertion,
		line_insertion: insertion && selection_line_starts.first().copied().unwrap_or(false),
		selected_capture_indices,
		selection_ranges,
		selection_pairs,
		literal_fallback,
	})
}

fn exact_occurrences(content: &str, pattern: &str) -> Vec<Occurrence> {
	if pattern.is_empty() {
		return Vec::new();
	}
	let mut result = Vec::new();
	let mut from = 0;
	while from <= content.len().saturating_sub(pattern.len()) {
		let Some(relative) = content[from..].find(pattern) else {
			break;
		};
		let start = from + relative;
		result.push(Occurrence {
			start,
			end: start + pattern.len(),
			distance: 0,
			punctuation_edits: 0,
		});
		from = start + content[start..].chars().next().map_or(1, char::len_utf8);
	}
	result
}

fn operator_signature(text: &str) -> String {
	text
		.chars()
		.filter(|character| !(character.is_alphanumeric() || matches!(character, '_' | '$')))
		.collect()
}

fn differs_by_one_punctuation_insertion(left: &str, right: &str) -> bool {
	let left = left.chars().collect::<Vec<_>>();
	let right = right.chars().collect::<Vec<_>>();
	if left.len().abs_diff(right.len()) != 1 {
		return false;
	}
	let (shorter, longer) = if left.len() < right.len() {
		(&left, &right)
	} else {
		(&right, &left)
	};
	let mut short_index = 0;
	let mut inserted = None;
	for character in longer {
		if shorter.get(short_index) == Some(character) {
			short_index += 1;
			continue;
		}
		if inserted.is_some() {
			return false;
		}
		inserted = Some(*character);
	}
	inserted.is_some_and(|character| !matches!(character, '{' | '}' | '(' | ')' | '[' | ']'))
}

fn fuzzy_occurrences(content: &str, pattern: &str, allow_punctuation: bool) -> Vec<Occurrence> {
	// These are only work limits. JS measured UTF-16 units; byte lengths are
	// intentionally acceptable here.
	if content.is_empty() || content.len() > 50_000 {
		return Vec::new();
	}
	if pattern.len() < 6 {
		return exact_occurrences(content, pattern);
	}
	let limit = 3.min(1.max(((pattern.len() as f64) * 0.12).floor() as usize));
	let seed_length = 5.min(3.max(pattern.len().saturating_sub(limit)));
	let offsets = [0, (pattern.len() - seed_length) / 2, pattern.len() - seed_length];
	let structural = operator_signature(pattern);
	let mut starts = BTreeSet::new();
	for offset in offsets {
		if !pattern.is_char_boundary(offset) || !pattern.is_char_boundary(offset + seed_length) {
			continue;
		}
		let seed = &pattern[offset..offset + seed_length];
		let mut from = 0;
		while from <= content.len().saturating_sub(seed.len()) {
			let Some(relative) = content[from..].find(seed) else {
				break;
			};
			let found = from + relative;
			for delta in -(limit as isize)..=limit as isize {
				let start = found as isize - offset as isize + delta;
				if start >= 0
					&& (start as usize) < content.len()
					&& content.is_char_boundary(start as usize)
				{
					starts.insert(start as usize);
				}
			}
			from = found + seed.chars().next().map_or(1, char::len_utf8);
		}
	}
	// Same work-limit exception as the TypeScript implementation.
	if starts.is_empty() && content.len() <= 10_000 {
		starts.extend(content.char_indices().map(|(index, _)| index));
	}
	let mut raw = Vec::new();
	for start in starts {
		let mut best: Option<Occurrence> = None;
		for length in pattern.len().saturating_sub(limit).max(1)..=pattern.len() + limit {
			let end = start + length;
			if end > content.len() || !content.is_char_boundary(end) {
				continue;
			}
			let candidate = &content[start..end];
			let signature = operator_signature(candidate);
			let punctuation_edits = usize::from(signature != structural);
			if punctuation_edits != 0
				&& (!allow_punctuation
					|| !differs_by_one_punctuation_insertion(&structural, &signature))
			{
				continue;
			}
			let distance = levenshtein_distance(pattern, candidate);
			if distance > limit || best.is_some_and(|current| distance >= current.distance) {
				continue;
			}
			best = Some(Occurrence { start, end, distance, punctuation_edits });
		}
		if let Some(best) = best {
			raw.push(best);
		}
	}
	raw.sort_by_key(|entry| (entry.distance, entry.start));
	let mut distinct: Vec<Occurrence> = Vec::new();
	for candidate in raw {
		if distinct
			.iter()
			.any(|kept| candidate.start < kept.end && candidate.end > kept.start)
		{
			continue;
		}
		distinct.push(candidate);
	}
	distinct.sort_by_key(|entry| entry.start);
	distinct
}

fn source_start(normalized: &NormalizedText, offset: usize, fallback: usize) -> usize {
	normalized.starts.get(offset).copied().unwrap_or(fallback)
}
fn source_end(normalized: &NormalizedText, offset: usize, fallback: usize) -> usize {
	if offset == 0 {
		0
	} else {
		normalized.ends.get(offset - 1).copied().unwrap_or(fallback)
	}
}
fn preceding_literal(tokens: &[PatternToken], boundary: usize) -> Option<usize> {
	(0..boundary)
		.rev()
		.find(|index| matches!(tokens[*index], PatternToken::Literal { .. }))
}
fn following_literal(tokens: &[PatternToken], boundary: usize) -> Option<usize> {
	(boundary..tokens.len()).find(|index| matches!(tokens[*index], PatternToken::Literal { .. }))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MatchMode {
	Raw,
	Normalized,
	Fuzzy,
}

fn resolve_boundary(
	boundary: usize,
	kind: u8,
	pattern: &ParsedPattern,
	matches: &HashMap<usize, Occurrence>,
	normalized: &NormalizedText,
	mode: MatchMode,
	content: Option<&str>,
) -> usize {
	let previous_index = preceding_literal(&pattern.tokens, boundary);
	let next_index = following_literal(&pattern.tokens, boundary);
	let previous = previous_index.and_then(|index| matches.get(&index));
	let next = next_index.and_then(|index| matches.get(&index));
	let immediate_previous =
		boundary > 0 && matches!(pattern.tokens[boundary - 1], PatternToken::Literal { .. });
	let immediate_next = boundary < pattern.tokens.len()
		&& matches!(pattern.tokens[boundary], PatternToken::Literal { .. });
	let raw = mode == MatchMode::Raw;
	let start_at = |offset| {
		if raw {
			offset
		} else {
			source_start(normalized, offset, content.map_or(normalized.text.len(), str::len))
		}
	};
	let end_at = |offset| {
		if raw {
			offset
		} else {
			source_end(normalized, offset, content.map_or(normalized.text.len(), str::len))
		}
	};
	if kind == 2 {
		if let Some(next) = next {
			return start_at(next.start);
		}
		if let Some(previous) = previous {
			let offset = end_at(previous.end);
			if let Some(content) = content
				&& offset > 0
				&& content.as_bytes().get(offset - 1) != Some(&b'\n')
				&& let Some(newline) = content[offset..].find('\n')
			{
				return offset + newline + 1;
			}
			return offset;
		}
	}
	if kind == 0 {
		if immediate_next && let Some(next) = next {
			return start_at(next.start);
		}
		if let Some(previous) = previous {
			return end_at(previous.end);
		}
		if let Some(next) = next {
			return start_at(next.start);
		}
	}
	if immediate_previous && let Some(previous) = previous {
		return end_at(previous.end);
	}
	if let Some(next) = next {
		return start_at(next.start);
	}
	previous.map_or(0, |entry| end_at(entry.end))
}

fn collect_candidates(
	content: &str,
	normalized: &NormalizedText,
	pattern: &ParsedPattern,
	mode: MatchMode,
	allow_punctuation: bool,
) -> CandidateResult {
	let literal_indices = pattern
		.tokens
		.iter()
		.enumerate()
		.filter_map(|(index, token)| matches!(token, PatternToken::Literal { .. }).then_some(index))
		.collect::<Vec<_>>();
	let mut occurrences = HashMap::new();
	for index in &literal_indices {
		let PatternToken::Literal { text, normalized: needle } = &pattern.tokens[*index] else {
			unreachable!()
		};
		let values = match mode {
			MatchMode::Raw => exact_occurrences(content, text),
			MatchMode::Normalized => exact_occurrences(&normalized.text, needle),
			MatchMode::Fuzzy => fuzzy_occurrences(&normalized.text, needle, allow_punctuation),
		};
		if values.is_empty() {
			return CandidateResult { candidates: Vec::new(), overflow: false };
		}
		occurrences.insert(*index, values);
	}
	struct Search<'a> {
		content:           &'a str,
		normalized:        &'a NormalizedText,
		pattern:           &'a ParsedPattern,
		mode:              MatchMode,
		literal_indices:   &'a [usize],
		occurrences:       &'a HashMap<usize, Vec<Occurrence>>,
		allow_punctuation: bool,
		chosen:            HashMap<usize, Occurrence>,
		candidates:        Vec<Candidate>,
		combinations:      usize,
		overflow:          bool,
	}
	impl Search<'_> {
		fn source_start(&self, offset: usize) -> usize {
			if self.mode == MatchMode::Raw {
				offset
			} else {
				source_start(self.normalized, offset, self.content.len())
			}
		}

		fn source_end(&self, offset: usize) -> usize {
			if self.mode == MatchMode::Raw {
				offset
			} else {
				source_end(self.normalized, offset, self.content.len())
			}
		}

		fn visit(&mut self, position: usize) {
			if self.overflow {
				return;
			}
			if self.candidates.len() >= MAX_CANDIDATES || self.combinations >= MAX_COMBINATIONS {
				self.overflow = true;
				return;
			}
			if position == self.literal_indices.len() {
				if self.allow_punctuation
					&& self
						.literal_indices
						.iter()
						.map(|index| self.chosen[index].punctuation_edits)
						.sum::<usize>()
						> 1
				{
					return;
				}
				self.combinations += 1;
				let content = self.pattern.line_insertion.then_some(self.content);
				let start = resolve_boundary(
					self.pattern.selection_start,
					if self.pattern.insertion { 2 } else { 0 },
					self.pattern,
					&self.chosen,
					self.normalized,
					self.mode,
					content,
				);
				let end = resolve_boundary(
					self.pattern.selection_end,
					if self.pattern.insertion { 2 } else { 1 },
					self.pattern,
					&self.chosen,
					self.normalized,
					self.mode,
					content,
				);
				let first = self.chosen[&self.literal_indices[0]];
				let last = self.chosen[&self.literal_indices[self.literal_indices.len() - 1]];
				if start > end {
					return;
				}
				let capture_count = self
					.pattern
					.tokens
					.iter()
					.filter(|token| matches!(token, PatternToken::Gap { .. }))
					.count();
				let mut captures = vec![String::new(); capture_count];
				for (token_index, token) in self.pattern.tokens.iter().enumerate() {
					let PatternToken::Gap { capture_index, .. } = token else {
						continue;
					};
					let (Some(before_index), Some(after_index)) = (
						preceding_literal(&self.pattern.tokens, token_index),
						following_literal(&self.pattern.tokens, token_index + 1),
					) else {
						return;
					};
					let capture_start = self.source_end(self.chosen[&before_index].end);
					let capture_end = self.source_start(self.chosen[&after_index].start);
					self.content[capture_start..capture_end].clone_into(&mut captures[*capture_index]);
				}
				let selection_spans = self
					.pattern
					.selection_pairs
					.iter()
					.map(|pair| {
						let insertion = pair.start == pair.end;
						let content = pair.line_insertion.then_some(self.content);
						(
							resolve_boundary(
								pair.start,
								if insertion { 2 } else { 0 },
								self.pattern,
								&self.chosen,
								self.normalized,
								self.mode,
								content,
							),
							resolve_boundary(
								pair.end,
								if insertion { 2 } else { 1 },
								self.pattern,
								&self.chosen,
								self.normalized,
								self.mode,
								content,
							),
						)
					})
					.collect::<Vec<_>>();
				if selection_spans.iter().any(|(start, end)| start > end) {
					return;
				}
				let candidate = Candidate {
					start,
					end,
					match_start: self.source_start(first.start),
					match_end: self.source_end(last.end),
					captures,
					selection_spans,
					tuple: self
						.literal_indices
						.iter()
						.map(|index| self.chosen[index].start)
						.collect(),
				};
				if let Some(existing) = self.candidates.iter_mut().find(|existing| {
					existing.start == candidate.start
						&& existing.end == candidate.end
						&& self
							.pattern
							.selected_capture_indices
							.iter()
							.all(|index| existing.captures[*index] == candidate.captures[*index])
				}) {
					if candidate.match_end - candidate.match_start
						< existing.match_end - existing.match_start
					{
						*existing = candidate;
					}
				} else {
					self.candidates.push(candidate);
				}
				return;
			}
			let token_index = self.literal_indices[position];
			let previous_index = position.checked_sub(1).map(|at| self.literal_indices[at]);
			let previous = previous_index.and_then(|index| self.chosen.get(&index).copied());
			let gap_tokens =
				previous_index.map_or(&[][..], |index| &self.pattern.tokens[index + 1..token_index]);
			let has_gap = gap_tokens
				.iter()
				.any(|token| matches!(token, PatternToken::Gap { .. }));
			for occurrence in self.occurrences[&token_index].iter().copied() {
				if let Some(previous) = previous
					&& (if has_gap {
						occurrence.start < previous.end
					} else {
						occurrence.start != previous.end
					}) {
					continue;
				}
				if let Some(previous) = previous
					&& gap_tokens
						.iter()
						.any(|token| matches!(token, PatternToken::Gap { line_bounded: true, .. }))
					&& self.content[self.source_end(previous.end)..self.source_start(occurrence.start)]
						.contains('\n')
				{
					continue;
				}
				self.chosen.insert(token_index, occurrence);
				self.visit(position + 1);
				self.chosen.remove(&token_index);
			}
		}
	}
	let mut search = Search {
		content,
		normalized,
		pattern,
		mode,
		literal_indices: &literal_indices,
		occurrences: &occurrences,
		allow_punctuation,
		chosen: HashMap::new(),
		candidates: Vec::new(),
		combinations: 0,
		overflow: false,
	};
	search.visit(0);
	let all = search.candidates.clone();
	search.candidates.retain(|candidate| {
		!all.iter().any(|other| {
			other.match_start == candidate.match_start && other.match_end < candidate.match_end
		})
	});
	search.candidates.sort_by(|left, right| {
		(left.start, left.match_start, left.match_end, &left.tuple).cmp(&(
			right.start,
			right.match_start,
			right.match_end,
			&right.tuple,
		))
	});
	CandidateResult { candidates: search.candidates, overflow: search.overflow }
}

fn line_number_at(content: &str, offset: usize) -> usize {
	content[..offset.min(content.len())]
		.bytes()
		.filter(|byte| *byte == b'\n')
		.count()
		+ 1
}

fn numbered_preview(content: &str, offset: usize) -> String {
	let lines = content.split('\n').collect::<Vec<_>>();
	let anchor = line_number_at(content, offset.min(content.len())) - 1;
	let mut start = anchor.saturating_sub(4);
	if lines.len().saturating_sub(start) < 10 {
		start = lines.len().saturating_sub(10);
	}
	lines
		.iter()
		.skip(start)
		.take(10)
		.enumerate()
		.map(|(index, line)| format!("{}: {line}", start + index + 1))
		.collect::<Vec<_>>()
		.join("\n")
}

fn display_fragment(text: &str) -> String {
	if text.contains('\n') && text.split('\n').count() <= 8 {
		return format!("\n{text}");
	}
	let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
	let compact = if compact.chars().count() > 80 {
		format!("{}…", compact.chars().take(77).collect::<String>())
	} else {
		compact
	};
	serde_json::to_string(&compact).expect("string serializes")
}

fn first_literal(pattern: &ParsedPattern) -> Option<(&str, &str)> {
	pattern.tokens.iter().find_map(|token| match token {
		PatternToken::Literal { text, normalized } => Some((text.as_str(), normalized.as_str())),
		PatternToken::Gap { .. } => None,
	})
}

fn no_match_error(
	content: &str,
	pattern: &ParsedPattern,
	operation: &Operation,
	operation_number: usize,
	path: &str,
	standalone: bool,
) -> EditError {
	let normalized = normalize_text(content);
	let (literal, needle) =
		first_literal(pattern).unwrap_or((&operation.pattern_text, &operation.pattern_text));
	let occurrences = exact_occurrences(&normalized.text, needle);
	let closest = closest_fragment(content, needle);
	let (reason, offset) = if occurrences.is_empty() {
		(format!("Failed fragment: {} has 0 occurrences.", display_fragment(literal)), closest.1)
	} else {
		(
			format!("Failed fragment: {} could not align.", display_fragment(literal)),
			source_start(&normalized, occurrences[0].start, 0),
		)
	};
	let first = if operation.all {
		format!("Operation {operation_number} <SM:EDIT all> found 0 matches in {path}. {reason}")
	} else {
		format!("Operation {operation_number} did not match {path}. {reason}")
	};
	let missing = if has_marker_lines(&operation.source_pattern_text) {
		let lines = missing_unmarked_lines(content, &operation.source_pattern_text);
		if lines.is_empty() {
			String::new()
		} else {
			let listed = lines
				.iter()
				.take(3)
				.map(|line| display_fragment(line))
				.collect::<Vec<_>>()
				.join(", ");
			let more = if lines.len() > 3 { ", …" } else { "" };
			let verb = if lines.len() == 1 { "does" } else { "do" };
			format!(
				"\nUnmarked MATCH lines must already exist in the file; {listed}{more} {verb} not. \
				 Copy real lines from the file, and mark new lines to insert with ＋."
			)
		}
	} else {
		String::new()
	};
	let correction =
		if occurrences.is_empty() && closest.2 < 0.35 && !closest.0.is_empty() && standalone {
			let corrected = operation.pattern_text.replacen(literal, &closest.0, 1);
			format!(
				"Copy-ready corrected operation:\n{}",
				operation_payload(operation, if operation.all { "*" } else { "" }, Some(&corrected))
			)
		} else if standalone {
			"No copy-ready correction — the closest current text is only a fuzzy match. Re-read the \
			 region above and rebuild <SM:FIND> from the exact current text."
				.to_owned()
		} else {
			"No copy-ready correction — retrying this operation alone would drop sibling operations. \
			 Rebuild it inside the full payload."
				.to_owned()
		};
	EditError::matched(format!(
		"{first}{missing}\nCurrent file content near the closest match (no re-read \
		 needed):\n{}\n{correction}",
		numbered_preview(content, offset)
	))
}

fn closest_fragment(content: &str, pattern: &str) -> (String, usize, f64) {
	let mut ranked = Vec::new();
	let mut offset = 0;
	for line in content.split('\n') {
		let normalized = normalize_text(line);
		if !normalized.text.is_empty() {
			let denominator = pattern.len().max(normalized.text.len()).max(1);
			let score = levenshtein_distance(pattern, &normalized.text) as f64 / denominator as f64;
			ranked.push((line, offset, normalized, score));
			ranked.sort_by(|left, right| left.3.total_cmp(&right.3));
			ranked.truncate(3);
		}
		offset += line.len() + 1;
	}
	let Some(first) = ranked.first() else {
		return (pattern.to_owned(), 0, 1.0);
	};
	let mut best = (first.0.to_owned(), first.1, first.3);
	if pattern.len() <= 160 {
		for (line, line_offset, normalized, _) in ranked {
			let width = pattern.len().min(normalized.text.len());
			for start in normalized
				.text
				.char_indices()
				.map(|(index, _)| index)
				.chain(std::iter::once(normalized.text.len().saturating_sub(width)))
			{
				let end = start + width;
				if end > normalized.text.len() || !normalized.text.is_char_boundary(end) {
					continue;
				}
				let candidate = &normalized.text[start..end];
				let score = levenshtein_distance(pattern, candidate) as f64
					/ pattern.len().max(candidate.len()).max(1) as f64;
				if score >= best.2 {
					continue;
				}
				let raw_start = source_start(&normalized, start, 0);
				let raw_end = source_end(&normalized, end, line.len());
				best = (line[raw_start..raw_end].to_owned(), line_offset + raw_start, score);
			}
		}
	}
	best
}

fn same_rewrite_for_all(
	pattern: &ParsedPattern,
	operation: &Operation,
	candidates: &[Candidate],
) -> bool {
	match &operation.rewrite {
		OperationRewrite::Explicit { text } => {
			let gaps = text.matches(GAP).count();
			pattern
				.selected_capture_indices
				.iter()
				.take(gaps)
				.all(|index| {
					candidates
						.iter()
						.all(|candidate| candidate.captures[*index] == candidates[0].captures[*index])
				})
		},
		OperationRewrite::Inline { replacements } => {
			replacements
				.iter()
				.enumerate()
				.all(|(replacement_index, replacement)| {
					pattern
						.selection_pairs
						.get(replacement_index)
						.is_some_and(|pair| {
							pair
								.capture_indices
								.iter()
								.take(replacement.matches(GAP).count())
								.all(|index| {
									candidates.iter().all(|candidate| {
										candidate.captures[*index] == candidates[0].captures[*index]
									})
								})
						})
				})
		},
	}
}

pub(crate) fn locate(
	content: &str,
	pattern: &ParsedPattern,
	operation: &Operation,
	operation_number: usize,
	path: &str,
	exclusions: &[(usize, usize)],
	standalone_operation: bool,
) -> Result<Vec<Candidate>, EditError> {
	let normalized = normalize_text(content);
	let raw = collect_candidates(content, &normalized, pattern, MatchMode::Raw, false);
	if raw.overflow {
		return Err(EditError::matched(format!(
			"Operation {operation_number} pattern is too broad; add another distinctive {GAP} \
			 fragment."
		)));
	}
	let marker_op = has_marker_lines(&operation.source_pattern_text);
	if raw.candidates.is_empty()
		&& let Some(fallback) = &pattern.literal_fallback
	{
		let exact = exact_occurrences(&normalized.text, &fallback.normalized);
		if !exact.is_empty() && (operation.all || exact.len() == 1) {
			let candidates = exact
				.into_iter()
				.map(|occurrence| {
					let match_start = source_start(&normalized, occurrence.start, 0);
					let match_end = source_end(&normalized, occurrence.end, content.len());
					let fallback_start = occurrence.start + fallback.selection_start;
					let fallback_end = occurrence.start + fallback.selection_end;
					let start = if fallback.selection_start == fallback.normalized.len() {
						match_end
					} else {
						source_start(&normalized, fallback_start, match_end)
					};
					let end = if fallback.selection_end == fallback.normalized.len() {
						match_end
					} else if fallback.insertion {
						source_start(&normalized, fallback_end, match_end)
					} else {
						source_end(&normalized, fallback_end, match_end)
					};
					Candidate {
						start,
						end,
						match_start,
						match_end,
						captures: Vec::new(),
						selection_spans: (pattern.selection_pairs.len() == 1)
							.then_some(vec![(start, end)])
							.unwrap_or_default(),
						tuple: vec![occurrence.start],
					}
				})
				.collect::<Vec<_>>();
			return Ok(if operation.all {
				candidates
			} else {
				vec![candidates[0].clone()]
			});
		}
	}
	let mut result = if raw.candidates.is_empty() {
		collect_candidates(content, &normalized, pattern, MatchMode::Normalized, false)
	} else {
		raw
	};
	if result.candidates.is_empty() && !result.overflow && !marker_op {
		result = collect_candidates(content, &normalized, pattern, MatchMode::Fuzzy, false);
		if result.candidates.is_empty() && !result.overflow && !operation.all {
			let punctuation =
				collect_candidates(content, &normalized, pattern, MatchMode::Fuzzy, true);
			if !punctuation.overflow && punctuation.candidates.len() == 1 {
				result = punctuation;
			}
		}
	}
	if result.overflow {
		return Err(EditError::matched(format!(
			"Operation {operation_number} pattern is too broad; add another distinctive {GAP} \
			 fragment."
		)));
	}
	let mut candidates = result.candidates;
	if !exclusions.is_empty() && candidates.len() > 1 {
		let free = candidates
			.iter()
			.filter(|candidate| {
				!exclusions
					.iter()
					.any(|(start, end)| candidate.match_start < *end && *start < candidate.match_end)
			})
			.cloned()
			.collect::<Vec<_>>();
		if !free.is_empty() {
			candidates = free;
		}
	}
	if operation.all && !candidates.is_empty() {
		return Ok(candidates);
	}
	if candidates.len() == 1 {
		return Ok(candidates);
	}
	if candidates.is_empty() {
		return Err(no_match_error(
			content,
			pattern,
			operation,
			operation_number,
			path,
			standalone_operation,
		));
	}
	if candidates.len() <= 4 && !operation.desired_state {
		let outcomes = candidates
			.iter()
			.map(|candidate| match &operation.rewrite {
				OperationRewrite::Explicit { text } => {
					format!("{}{}{}", &content[..candidate.start], text, &content[candidate.end..])
				},
				OperationRewrite::Inline { replacements } => {
					let mut result = content.to_owned();
					let mut spans = candidate
						.selection_spans
						.iter()
						.copied()
						.zip(replacements)
						.collect::<Vec<_>>();
					spans.sort_by_key(|((start, _), _)| std::cmp::Reverse(*start));
					for ((start, end), replacement) in spans {
						result.replace_range(start..end, replacement);
					}
					result
				},
			})
			.map(|outcome| normalize_text(&outcome).text)
			.collect::<HashSet<_>>();
		if outcomes.len() == 1 {
			return Ok(vec![candidates[0].clone()]);
		}
	}
	let retries = candidates
		.iter()
		.take(2)
		.map(|candidate| {
			format!(
				"Near line {}:\n{}",
				line_number_at(content, candidate.start),
				operation_payload(operation, "", None)
			)
		})
		.collect::<Vec<_>>()
		.join("\n\n");
	let all_retry = if same_rewrite_for_all(pattern, operation, &candidates) {
		format!(
			"All candidates receive the same rewrite; retry every match:\n{}\n\n",
			operation_payload(operation, "*", None)
		)
	} else {
		String::new()
	};
	Err(EditError::matched(format!(
		"Operation {operation_number} is ambiguous: {} ordered tuples match.\n\n{all_retry}Add \
		 context that only the intended match has — one of these:\n\n{retries}",
		candidates.len()
	)))
}

pub(crate) fn closest_desired_block(content: &str, stated_text: &str) -> Option<String> {
	let stated = normalize_text(stated_text).text;
	if !(12..=1000).contains(&stated.len()) {
		return None;
	}
	let count = stated_text.split('\n').count();
	let lines = content.split('\n').collect::<Vec<_>>();
	if lines.len() < count {
		return None;
	}
	let mut scores = Vec::new();
	for index in 0..=lines.len() - count {
		let current = normalize_text(&lines[index..index + count].join("\n")).text;
		let max = stated.len().max(current.len()).max(1);
		let affix = stated.starts_with(&current)
			|| current.starts_with(&stated)
			|| stated.ends_with(&current)
			|| current.ends_with(&stated);
		let score = if current.is_empty()
			|| affix
			|| current.len().abs_diff(stated.len()) as f64 / max as f64 > 0.35
		{
			1.0
		} else {
			levenshtein_distance(&stated, &current) as f64 / max as f64
		};
		scores.push((index, score));
	}
	let best = scores
		.iter()
		.min_by(|left, right| left.1.total_cmp(&right.1))?;
	if best.1 == 0.0 || best.1 > 0.35 {
		return None;
	}
	if scores
		.iter()
		.any(|other| other.0.abs_diff(best.0) >= count && other.1 - best.1 < 0.1)
	{
		return None;
	}
	Some(lines[best.0..best.0 + count].join("\n"))
}

pub(crate) fn is_diff_shaped(pattern_text: &str) -> bool {
	if pattern_text.contains(SELECT_OPEN)
		|| pattern_text
			.lines()
			.any(|line| line.trim_start().starts_with(['＋', '－']))
	{
		return false;
	}
	let minus = pattern_text
		.lines()
		.any(|line| line.starts_with('-') && !line.starts_with("---"));
	minus
		&& pattern_text.lines().any(|line| {
			(line.starts_with('+') && !line.starts_with("+++"))
				|| line.trim().starts_with("@@")
				|| line.starts_with(' ')
					&& line
						.chars()
						.nth(1)
						.is_some_and(|character| !character.is_whitespace())
		})
}

pub(crate) fn diff_shaped_candidates(pattern_text: &str) -> Vec<String> {
	if !is_diff_shaped(pattern_text) {
		return Vec::new();
	}
	let lines = pattern_text.lines().collect::<Vec<_>>();
	let build = |strip_space: bool| {
		let mut out = Vec::new();
		let mut index = 0;
		while index < lines.len() {
			let line = lines[index];
			if line.starts_with("---") || line.starts_with("+++") {
				index += 1;
				continue;
			}
			if line.trim().starts_with("@@") {
				out.push(GAP.to_owned());
				index += 1;
				continue;
			}
			if line.starts_with('-') {
				let mut removed = Vec::new();
				while index < lines.len()
					&& lines[index].starts_with('-')
					&& !lines[index].starts_with("---")
				{
					removed.push(&lines[index][1..]);
					index += 1;
				}
				let mut added = Vec::new();
				while index < lines.len()
					&& lines[index].starts_with('+')
					&& !lines[index].starts_with("+++")
				{
					added.push(&lines[index][1..]);
					index += 1;
				}
				out.push(format!(
					"{SELECT_OPEN}{}{SELECT_DIVIDER}{}{SELECT_CLOSE}",
					removed.join("\n"),
					added.join("\n")
				));
				continue;
			}
			if line.starts_with('+') {
				let mut added = Vec::new();
				while index < lines.len()
					&& lines[index].starts_with('+')
					&& !lines[index].starts_with("+++")
				{
					added.push(&lines[index][1..]);
					index += 1;
				}
				if let Some(previous) = out.last_mut()
					&& previous.as_str() != GAP
					&& !previous.contains(SELECT_OPEN)
					&& !previous.trim().is_empty()
				{
					let old = previous.clone();
					*previous = format!(
						"{SELECT_OPEN}{old}{SELECT_DIVIDER}{}{SELECT_CLOSE}",
						std::iter::once(old.as_str())
							.chain(added.iter().copied())
							.collect::<Vec<_>>()
							.join("\n")
					);
				} else {
					out.extend(added.into_iter().map(|entry| format!("＋{entry}")));
				}
				continue;
			}
			out.push(if strip_space {
				line.strip_prefix(' ').unwrap_or(line).to_owned()
			} else {
				line.to_owned()
			});
			index += 1;
		}
		out.join("\n")
	};
	let spaced = build(true);
	let plain = build(false);
	if spaced == plain {
		vec![spaced]
	} else {
		vec![spaced, plain]
	}
}

fn decode_literal_markers(text: String) -> String {
	text
		.replace("\0V8LITOPEN\0", SELECT_OPEN)
		.replace("\0V8LITCLOSE\0", SELECT_CLOSE)
		.replace("\0V8LITDIV\0", SELECT_DIVIDER)
}

fn render_rewrite(
	rewrite: &str,
	indices: &[usize],
	captures: &[String],
	operation_number: usize,
) -> Result<String, EditError> {
	if rewrite.contains(SELECT_OPEN) || rewrite.contains(SELECT_CLOSE) {
		return Err(EditError::matched(format!(
			"Operation {operation_number} has selection markers in <SM:PUT>; <SM:FIND> is current \
			 text, <SM:PUT> is final text."
		)));
	}
	let mut rendered = String::new();
	let mut marker = 0;
	let mut index = 0;
	while index < rewrite.len() {
		if rewrite[index..].starts_with(GAP) {
			let line_start = rewrite[..index].rfind('\n').map_or(0, |at| at + 1);
			let line_end = rewrite[index + GAP.len()..]
				.find('\n')
				.map_or(rewrite.len(), |at| index + GAP.len() + at);
			let line = &rewrite[line_start..line_end];
			if marker >= indices.len() {
				if line.trim() == GAP {
					return Err(EditError::matched(format!(
						"Operation {operation_number} <SM:PUT> has a whole-line {GAP} with no <SM:FIND> \
						 gap to re-emit. <SM:PUT> is final text written verbatim: type the elided lines \
						 out, or add a matching {GAP} gap to <SM:FIND>. To write a literal {GAP} line, \
						 use the write tool."
					)));
				}
				rendered.push_str(GAP);
			} else {
				let capture = captures.get(indices[marker]).map_or("", String::as_str);
				let open_ended =
					line.trim() == GAP || rewrite[index + GAP.len()..line_end].trim().is_empty();
				if capture.contains('\n') && !open_ended {
					rendered.push_str(GAP);
				} else {
					rendered.push_str(capture);
					marker += 1;
				}
			}
			index += GAP.len();
			continue;
		}
		let character = rewrite[index..].chars().next().expect("non-empty suffix");
		rendered.push(character);
		index += character.len_utf8();
	}
	Ok(decode_literal_markers(rendered))
}

fn align_boundary_echoes(content: &str, candidate: &Candidate, replacement: &str) -> String {
	if replacement.is_empty()
		|| candidate.start == candidate.match_start && candidate.end == candidate.match_end
	{
		return replacement.to_owned();
	}
	let prefix = &content[candidate.match_start..candidate.start];
	let suffix = &content[candidate.end..candidate.match_end];
	let normalized_replacement = normalize_text(replacement);
	let normalized_prefix = normalize_text(prefix).text;
	let normalized_suffix = normalize_text(suffix).text;
	let prefix_echo =
		normalized_prefix.len() >= 3 && normalized_replacement.text.starts_with(&normalized_prefix);
	let suffix_echo = !normalized_suffix.is_empty()
		&& normalized_replacement.text.ends_with(&normalized_suffix)
		&& (normalized_suffix.len() >= 3 || prefix_echo);
	if !prefix_echo && !suffix_echo {
		return replacement.to_owned();
	}
	let mut from = 0;
	let mut to = replacement.len();
	if prefix_echo {
		from = replacement.strip_prefix(prefix).map_or_else(
			|| source_end(&normalized_replacement, normalized_prefix.len(), replacement.len()),
			|rest| replacement.len() - rest.len(),
		);
	}
	if suffix_echo {
		to = replacement.strip_suffix(suffix).map_or_else(
			|| {
				source_start(
					&normalized_replacement,
					normalized_replacement.text.len() - normalized_suffix.len(),
					replacement.len(),
				)
			},
			str::len,
		);
	}
	if from > to {
		return replacement.to_owned();
	}
	let mut aligned = replacement[from..to].to_owned();
	if prefix.chars().last().is_some_and(char::is_whitespace)
		&& aligned.chars().next().is_some_and(char::is_whitespace)
	{
		aligned = aligned.trim_start_matches(char::is_whitespace).to_owned();
	}
	if suffix.chars().next().is_some_and(char::is_whitespace)
		&& aligned.chars().last().is_some_and(char::is_whitespace)
	{
		aligned = aligned.trim_end_matches(char::is_whitespace).to_owned();
	}
	aligned
}

fn expand_full_line_deletion(content: &str, candidate: &Candidate) -> Candidate {
	if candidate.start == candidate.end {
		return candidate.clone();
	}
	let line_start = content[..candidate.start]
		.rfind('\n')
		.map_or(0, |at| at + 1);
	let newline = content[candidate.end..]
		.find('\n')
		.map(|at| candidate.end + at);
	let line_end = newline.unwrap_or(content.len());
	if !content[line_start..candidate.start]
		.bytes()
		.all(|byte| matches!(byte, b' ' | b'\t'))
		|| !content[candidate.end..line_end]
			.bytes()
			.all(|byte| matches!(byte, b' ' | b'\t'))
	{
		return candidate.clone();
	}
	let mut result = candidate.clone();
	result.start = line_start;
	result.end = newline.map_or(line_end, |at| at + 1);
	if line_start > 0 && result.end < content.len() {
		let previous_end = line_start - 1;
		let previous_start = content[..previous_end].rfind('\n').map_or(0, |at| at + 1);
		let next_end = content[result.end..]
			.find('\n')
			.map_or(content.len(), |at| result.end + at);
		let previous_blank = content[previous_start..previous_end].trim().is_empty();
		let next_blank = content[result.end..next_end].trim().is_empty();
		let previous_text = &content[previous_start..previous_end];
		if previous_blank && next_blank {
			result.end = if next_end == content.len() {
				next_end
			} else {
				next_end + 1
			};
		} else if previous_blank
			&& content[result.end..next_end]
				.trim_start()
				.starts_with([')', ']', '}'])
		{
			result.start = previous_start;
		} else if next_blank && previous_text.trim_end().ends_with(['(', '{', '[']) {
			result.end = if next_end == content.len() {
				next_end
			} else {
				next_end + 1
			};
		}
	} else if line_start > 0 && result.end >= content.len() {
		let previous_end = line_start - 1;
		let previous_start = content[..previous_end].rfind('\n').map_or(0, |at| at + 1);
		if content[previous_start..previous_end].trim().is_empty() {
			result.start = previous_start;
		}
	}
	result
}

fn snap_line_insertion_offset(content: &str, offset: usize, hop_blank_lines: bool) -> usize {
	let mut line_start = content[..offset].rfind('\n').map_or(0, |at| at + 1);
	if !content[line_start..offset]
		.bytes()
		.all(|byte| matches!(byte, b' ' | b'\t'))
	{
		return offset;
	}
	while hop_blank_lines && line_start > 0 {
		let previous_end = line_start - 1;
		let previous_start = content[..previous_end].rfind('\n').map_or(0, |at| at + 1);
		if !content[previous_start..previous_end]
			.bytes()
			.all(|byte| matches!(byte, b' ' | b'\t'))
		{
			break;
		}
		line_start = previous_start;
	}
	line_start
}

fn frame_line_insertion(
	content: &str,
	offset: usize,
	desired: &str,
	blank_separated: bool,
) -> String {
	if desired.is_empty() {
		return String::new();
	}
	if offset > 0 && offset == content.len() && content.as_bytes()[offset - 1] != b'\n' {
		return if desired.starts_with('\n') {
			desired.to_owned()
		} else {
			format!("\n{desired}")
		};
	}
	let mut framed = if desired.ends_with('\n') {
		desired.to_owned()
	} else {
		format!("{desired}\n")
	};
	if blank_separated && content.as_bytes().get(offset) != Some(&b'\n') && !framed.ends_with("\n\n")
	{
		framed.push('\n');
	}
	framed
}

fn rewrite_proves_whole_span(content: &str, candidate: &Candidate, rewrite: &str) -> bool {
	let normalized_rewrite = normalize_text(rewrite).text;
	let contexts = candidate
		.selection_spans
		.windows(2)
		.filter_map(|spans| {
			let context = normalize_text(&content[spans[0].1..spans[1].0]).text;
			(!context.is_empty()).then_some(context)
		})
		.collect::<Vec<_>>();
	if contexts.is_empty() {
		return false;
	}
	let mut from = 0;
	for context in contexts {
		let Some(found) = normalized_rewrite[from..].find(&context) else {
			return false;
		};
		from += found + context.len();
	}
	true
}

fn rewrite_selection_spans(
	content: &str,
	candidate: &Candidate,
	replacements: &[String],
) -> String {
	let mut rewritten = content[candidate.start..candidate.end].to_owned();
	let mut indexed = candidate
		.selection_spans
		.iter()
		.copied()
		.zip(replacements)
		.collect::<Vec<_>>();
	indexed.sort_by_key(|((start, _), _)| std::cmp::Reverse(*start));
	for ((start, end), replacement) in indexed {
		rewritten.replace_range(start - candidate.start..end - candidate.start, replacement);
	}
	rewritten
}

fn positional_rewrite_segments(
	rewrite: &str,
	count: usize,
	pattern_has_gaps: bool,
) -> Option<Vec<String>> {
	let lines = rewrite.split('\n').collect::<Vec<_>>();
	if lines.iter().any(|line| line.trim() == GAP) {
		if pattern_has_gaps {
			return None;
		}
		let mut groups = vec![Vec::new()];
		for line in lines {
			if line.trim() == GAP {
				groups.push(Vec::new());
			} else {
				groups.last_mut().expect("one group").push(line);
			}
		}
		return (groups.len() == count)
			.then(|| groups.into_iter().map(|group| group.join("\n")).collect());
	}
	if lines.len() == count {
		return Some(lines.into_iter().map(str::to_owned).collect());
	}
	if !rewrite.contains('\n') {
		let segments = rewrite.split(GAP).map(str::to_owned).collect::<Vec<_>>();
		if segments.len() == count {
			return Some(segments);
		}
	}
	None
}

fn prepare_inline(
	content: &str,
	located: &Candidate,
	span: (usize, usize),
	selection: &SelectionPair,
	rewrite: &str,
	operation_number: usize,
	lenient: bool,
) -> Result<(Candidate, String, Option<String>), EditError> {
	let (mut start, mut end) = span;
	if selection.gap_only {
		if let Some(newline) = content[start..].find('\n').map(|at| start + at)
			&& newline < end
		{
			end = newline;
		}
		while start < end && matches!(content.as_bytes()[start], b' ' | b'\t') {
			start += 1;
		}
		while end > start && matches!(content.as_bytes()[end - 1], b' ' | b'\t') {
			end -= 1;
		}
	}
	if selection.line_insertion && start == end && lenient {
		start = snap_line_insertion_offset(content, start, !rewrite.starts_with('\n'));
		end = start;
	}
	let mut candidate = located.clone();
	candidate.start = start;
	candidate.end = end;
	candidate.match_start = start;
	candidate.match_end = end;
	let stripped_blank = start == end
		&& rewrite.starts_with('\n')
		&& content.as_bytes().get(start.wrapping_sub(1)) == Some(&b'\n');
	let desired = if stripped_blank {
		&rewrite[1..]
	} else {
		rewrite
	};
	let blank_separated = stripped_blank && start >= 2 && content.as_bytes()[start - 2] == b'\n';
	let framed = if selection.line_insertion {
		frame_line_insertion(content, start, desired, blank_separated)
	} else {
		desired.to_owned()
	};
	let replacement =
		render_rewrite(&framed, &selection.capture_indices, &candidate.captures, operation_number)?;
	if replacement.is_empty() && start != end {
		let deleted = content[start..end].to_owned();
		candidate = expand_full_line_deletion(content, &candidate);
		return Ok((candidate, replacement, Some(deleted)));
	}
	Ok((candidate, replacement, None))
}

fn drop_selection_echoes(pattern: &str) -> Option<String> {
	let mut result = String::new();
	let mut run_start = 0;
	let mut changed = false;
	let mut index = 0;
	while index < pattern.len() {
		if pattern[index..].starts_with(GAP) {
			result.push_str(&pattern[run_start..index + GAP.len()]);
			index += GAP.len();
			run_start = index;
			continue;
		}
		if !pattern[index..].starts_with(SELECT_OPEN) {
			index += pattern[index..].chars().next().expect("suffix").len_utf8();
			continue;
		}
		let close =
			pattern[index + SELECT_OPEN.len()..].find(SELECT_CLOSE)? + index + SELECT_OPEN.len();
		let selected = &pattern[index + SELECT_OPEN.len()..close];
		let run = &pattern[run_start..index];
		let normalized_run = normalize_text(run);
		let old = normalize_text(selected).text;
		if !old.is_empty() && normalized_run.text.ends_with(&old) {
			let cut = normalized_run.starts[normalized_run.text.len() - old.len()];
			result.push_str(&pattern[run_start..run_start + cut]);
			changed = true;
		} else {
			result.push_str(run);
		}
		result.push_str(&pattern[index..close + SELECT_CLOSE.len()]);
		index = close + SELECT_CLOSE.len();
		run_start = index;
	}
	result.push_str(&pattern[run_start..]);
	changed.then_some(result)
}

fn echo_line_candidates(pattern: &str) -> Vec<String> {
	let lines = pattern.split('\n').collect::<Vec<_>>();
	let mut result = Vec::new();
	for index in 1..lines.len() {
		let previous = lines[index - 1];
		let line = lines[index];
		if !line.contains(SELECT_OPEN)
			|| previous.contains(SELECT_OPEN)
			|| previous.contains(GAP)
			|| previous.trim().is_empty()
		{
			continue;
		}
		let without_markers = line.replace(SELECT_OPEN, "").replace(SELECT_CLOSE, "");
		if normalize_text(&without_markers).text == normalize_text(previous).text {
			let mut candidate = lines.clone();
			candidate.remove(index - 1);
			result.push(candidate.join("\n"));
		}
	}
	result
}

fn trailing_selection_candidate(pattern: &str) -> Option<String> {
	let mut changed = false;
	let lines = pattern
		.split('\n')
		.map(|line| {
			let Some(open) = line.rfind(SELECT_OPEN) else {
				return line.to_owned();
			};
			let Some(close_relative) = line[open + SELECT_OPEN.len()..].find(SELECT_CLOSE) else {
				return line.to_owned();
			};
			let close = open + SELECT_OPEN.len() + close_relative;
			if !line[close + SELECT_CLOSE.len()..].trim().is_empty()
				|| line[..open].trim().is_empty()
				|| line[..open].contains(SELECT_OPEN)
				|| line[..open].contains(GAP)
			{
				return line.to_owned();
			}
			let old = &line[open + SELECT_OPEN.len()..close];
			let normalized = normalize_text(&line[..open]);
			let old_normalized = normalize_text(old).text;
			let Some(found) = normalized.text.find(&old_normalized) else {
				return line.to_owned();
			};
			if normalized.text[found + old_normalized.len()..].contains(&old_normalized) {
				return line.to_owned();
			}
			let raw_start = normalized.starts[found];
			let raw_end = normalized.ends[found + old_normalized.len() - 1];
			changed = true;
			format!(
				"{}{}{}{}{}{}",
				&line[..raw_start],
				SELECT_OPEN,
				&line[raw_start..raw_end],
				SELECT_CLOSE,
				&line[raw_end..open],
				&line[close + SELECT_CLOSE.len()..]
			)
		})
		.collect::<Vec<_>>();
	changed.then(|| lines.join("\n"))
}

fn recover_pattern_candidates(pattern: &str, inline: bool) -> Vec<String> {
	let mut result = Vec::new();
	let mut push = |candidate: Option<String>| {
		if let Some(candidate) = candidate
			&& candidate != pattern
			&& !result.contains(&candidate)
		{
			result.push(candidate);
		}
	};
	push(drop_selection_echoes(pattern));
	for candidate in echo_line_candidates(pattern) {
		push(Some(candidate));
	}
	let trailing = trailing_selection_candidate(pattern);
	push(trailing.clone());
	if !pattern.contains(GAP) {
		let lines = pattern
			.lines()
			.filter(|line| !line.trim().is_empty())
			.collect::<Vec<_>>();
		if lines.len() >= 2 && (inline && lines.iter().any(|line| line.contains(SELECT_OPEN))) {
			push(Some(lines.join(&format!("\n{GAP}\n"))));
		}
	}
	if let Some(trailing) = trailing
		&& !trailing.contains(GAP)
	{
		let lines = trailing
			.lines()
			.filter(|line| !line.trim().is_empty())
			.collect::<Vec<_>>();
		if lines.len() >= 2 && inline && lines.iter().any(|line| line.contains(SELECT_OPEN)) {
			push(Some(lines.join(&format!("\n{GAP}\n"))));
		}
	}
	result
}

fn punctuation_pair_variants(operation: &Operation) -> Vec<Operation> {
	let OperationRewrite::Inline { replacements } = &operation.rewrite else {
		return Vec::new();
	};
	let mut variants = Vec::new();
	let mut from = 0;
	let mut selection_index = 0;
	while let Some(open_relative) = operation.pattern_text[from..].find(SELECT_OPEN) {
		let open = from + open_relative;
		let selected_start = open + SELECT_OPEN.len();
		let Some(close_relative) = operation.pattern_text[selected_start..].find(SELECT_CLOSE) else {
			break;
		};
		let close = selected_start + close_relative;
		let old = &operation.pattern_text[selected_start..close];
		let next = replacements.get(selection_index).map_or("", String::as_str);
		let punctuation = |text: &str| {
			!text.is_empty()
				&& text.chars().all(|character| {
					!(character.is_alphanumeric()
						|| character.is_whitespace()
						|| matches!(character, '_' | '$'))
				})
		};
		if punctuation(old) && punctuation(next) {
			let mut characters = old.chars().chain(next.chars()).collect::<Vec<_>>();
			characters.sort_unstable();
			characters.dedup();
			if characters.len() == 2 {
				for length in [2, 1, 3] {
					for (left, right) in [(characters[0], characters[1]), (characters[1], characters[0])]
					{
						let old_run = left.to_string().repeat(length);
						let next_run = right.to_string().repeat(length);
						if old_run == old && next_run == next {
							continue;
						}
						let mut pattern_text = operation.pattern_text.clone();
						pattern_text.replace_range(selected_start..close, &old_run);
						let mut next_replacements = replacements.clone();
						next_replacements[selection_index] = next_run;
						let mut variant = operation.clone();
						variant.pattern_text = pattern_text;
						variant.rewrite = OperationRewrite::Inline { replacements: next_replacements };
						variants.push(variant);
					}
				}
			}
		}
		selection_index += 1;
		from = close + SELECT_CLOSE.len();
	}
	variants
}

fn locate_with_recovery(
	content: &str,
	operation: &Operation,
	number: usize,
	path: &str,
	exclusions: &[(usize, usize)],
	standalone: bool,
) -> Result<(Operation, ParsedPattern, Vec<Candidate>), EditError> {
	let pattern = parse_pattern(&operation.pattern_text, number)?;
	match locate(content, &pattern, operation, number, path, exclusions, standalone) {
		Ok(candidates) => {
			let mut resolved = operation.clone();
			if has_marker_lines(&operation.source_pattern_text) {
				let normalized = normalize_text(content);
				let raw = collect_candidates(content, &normalized, &pattern, MatchMode::Raw, false);
				let lenient = raw.candidates.is_empty()
					&& !collect_candidates(content, &normalized, &pattern, MatchMode::Normalized, false)
						.candidates
						.is_empty();
				resolved.whitespace_matched = lenient;
			}
			Ok((resolved, pattern, candidates))
		},
		Err(original) => {
			for candidate in recover_pattern_candidates(
				&operation.pattern_text,
				matches!(operation.rewrite, OperationRewrite::Inline { .. }),
			) {
				let Ok(pattern) = parse_pattern(&candidate, number) else {
					continue;
				};
				let mut recovered = operation.clone();
				recovered.pattern_text = candidate;
				if let Ok(candidates) =
					locate(content, &pattern, &recovered, number, path, exclusions, standalone)
				{
					return Ok((recovered, pattern, candidates));
				}
			}
			for mut variant in punctuation_pair_variants(operation) {
				let Ok(pattern) = parse_pattern(&variant.pattern_text, number) else {
					continue;
				};
				if let Ok(candidates) =
					locate(content, &pattern, &variant, number, path, exclusions, standalone)
				{
					let partial_run = candidates.iter().any(|candidate| {
						candidate.selection_spans.iter().any(|(start, end)| {
							if start >= end {
								return false;
							}
							let character = content[*start..]
								.chars()
								.next()
								.expect("selected character");
							content[..*start].ends_with(character)
								|| content[*end..].starts_with(character)
						})
					});
					if partial_run {
						continue;
					}
					variant.recovery_note = Some(format!(
						"Note: operation {number}'s punctuation selection was garbled by its own marker \
						 glyphs and was resolved against the file. Include a neighboring character next \
						 time (e.g. i{SELECT_OPEN}++){SELECT_DIVIDER}--){SELECT_CLOSE})."
					));
					return Ok((variant, pattern, candidates));
				}
			}
			Err(original)
		},
	}
}

fn normalized_index_at(normalized: &NormalizedText, raw_offset: usize) -> usize {
	normalized
		.starts
		.partition_point(|offset| *offset < raw_offset)
}

fn duplicate_collapse_span(
	content: &str,
	candidate: &Candidate,
	replacement: &str,
) -> Option<(usize, usize)> {
	const MIN_OVERLAP: usize = 8;
	let rewrite = normalize_text(replacement).text;
	if rewrite.len() < MIN_OVERLAP || rewrite.len() > 5000 {
		return None;
	}
	let normalized = normalize_text(content);
	let match_start = normalized_index_at(&normalized, candidate.start);
	let match_end = normalized_index_at(&normalized, candidate.end);
	for overlap in (MIN_OVERLAP..=rewrite.len().min(match_start)).rev() {
		if normalized.text[match_start - overlap..match_start] != rewrite[..overlap] {
			continue;
		}
		let mut start = normalized
			.starts
			.get(match_start - overlap)
			.copied()
			.unwrap_or(candidate.start);
		let line_start = content[..start].rfind('\n').map_or(0, |at| at + 1);
		if content[line_start..start]
			.bytes()
			.all(|byte| matches!(byte, b' ' | b'\t'))
		{
			start = line_start;
		}
		return Some((start, candidate.end));
	}
	for overlap in (MIN_OVERLAP
		..=rewrite
			.len()
			.min(normalized.text.len().saturating_sub(match_end)))
		.rev()
	{
		if normalized.text[match_end..match_end + overlap] != rewrite[rewrite.len() - overlap..] {
			continue;
		}
		let mut end = normalized
			.ends
			.get(match_end + overlap - 1)
			.copied()
			.unwrap_or(candidate.end);
		let line_end = content[end..]
			.find('\n')
			.map_or(content.len(), |at| end + at);
		if content[end..line_end]
			.bytes()
			.all(|byte| matches!(byte, b' ' | b'\t'))
		{
			end = line_end;
		}
		return Some((candidate.start, end));
	}
	None
}

fn resolve_references(rewrite: &str, removed: &[Option<String>]) -> Result<String, EditError> {
	let mut lines = Vec::new();
	for line in rewrite.split('\n') {
		let trimmed = line.trim();
		if let Some(number) = trimmed
			.strip_prefix('»')
			.and_then(|value| value.parse::<usize>().ok())
		{
			let Some(Some(value)) = removed.get(number.saturating_sub(1)) else {
				return Err(EditError::matched(format!(
					"»{number} must reference an earlier deletion operation."
				)));
			};
			lines.push(value.clone());
		} else {
			lines.push(line.to_owned());
		}
	}
	Ok(lines.join("\n"))
}

fn fnv_payload(input: &str) -> u64 {
	let mut hash = 2_166_136_261_u32;
	for unit in input.encode_utf16() {
		hash ^= u32::from(unit);
		hash = hash.wrapping_mul(16_777_619);
	}
	u64::from(hash)
}

fn no_op_error(
	context: &ApplyContext<'_>,
	payload: u64,
	operation: Option<usize>,
	preview: Option<(&str, usize)>,
	match_count: Option<usize>,
	hint: Option<&str>,
) -> EditError {
	let (count, escalated) = context.store.record_noop(context.canonical, payload);
	let base = if escalated {
		format!(
			"STOP: identical no-op repeated {count} times for {}. Re-read current code and send a \
			 changed payload, or move on.",
			context.path
		)
	} else if let Some(operation) = operation {
		if let Some(matches) = match_count {
			format!(
				"Operation {operation} <SM:EDIT all> matched {matches} occurrences but all make no \
				 change to {}.",
				context.path
			)
		} else {
			format!("Operation {operation} makes no change to {}.", context.path)
		}
	} else {
		format!("Edits to {} made no change.", context.path)
	};
	let grounding = preview.map_or(String::new(), |(content, offset)| {
		format!(
			"\nYour rewrite normalized to text identical to these lines. Indentation-only changes \
			 are applied verbatim; adjust the authored <SM:PUT> if another whitespace change was \
			 intended.\nCurrent file content near the closest match (no re-read needed):\n{}",
			numbered_preview(content, offset)
		)
	});
	let hint = hint.map_or(String::new(), |hint| format!("\n{hint}"));
	EditError::matched(format!("{base}{grounding}{hint}"))
}

fn reconcile_overlap(
	content: &str,
	left: &PlannedEdit,
	right: &PlannedEdit,
) -> Option<PlannedEdit> {
	let start = left.start.min(right.start);
	let end = left.end.max(right.end);
	let container = |outer: &PlannedEdit, inner: &PlannedEdit| {
		(outer.replacement.is_empty()
			&& !inner.replacement.is_empty()
			&& inner.start >= outer.start
			&& inner.end <= outer.end)
			.then(|| PlannedEdit {
				start:            outer.start,
				end:              outer.end,
				replacement:      if content.as_bytes().get(outer.end.wrapping_sub(1)) == Some(&b'\n')
					&& !inner.replacement.ends_with('\n')
				{
					format!("{}\n", inner.replacement)
				} else {
					inner.replacement.clone()
				},
				operation_number: inner.operation_number,
			})
	};
	if let Some(result) = container(left, right).or_else(|| container(right, left)) {
		return Some(result);
	}
	let project = |edit: &PlannedEdit| {
		format!("{}{}{}", &content[start..edit.start], edit.replacement, &content[edit.end..end])
	};
	(project(left) == project(right)).then(|| PlannedEdit {
		start,
		end,
		replacement: project(left),
		operation_number: left.operation_number,
	})
}

#[allow(clippy::suspicious_operation_groupings, reason = "paired index bounds are intentional")]
fn apply_operations(
	content: &str,
	input: &str,
	context: &mut ApplyContext<'_>,
) -> Result<String, EditError> {
	let payload = fnv_payload(input);
	let operations = parse_operations(input, content)?;
	let mut removed = vec![None; operations.len()];
	let mut planned = Vec::new();
	let mut recovery_notes = Vec::new();
	let mut deletion_notes = BTreeMap::new();
	let mut last_match = 0;
	let mut queue = (0..operations.len()).collect::<Vec<_>>();
	let mut deferred = HashSet::new();
	let mut cursor = 0;
	while cursor < queue.len() {
		let index = queue[cursor];
		cursor += 1;
		let number = index + 1;
		if let Some(note) = &operations[index].recovery_note {
			recovery_notes.push(note.clone());
		}
		let exclusions = if deferred.contains(&index) {
			planned
				.iter()
				.map(|edit: &PlannedEdit| (edit.start, edit.end))
				.collect::<Vec<_>>()
		} else {
			Vec::new()
		};
		let located = locate_with_recovery(
			content,
			&operations[index],
			number,
			context.path,
			&exclusions,
			operations.len() == 1,
		);
		let (operation, pattern, mut candidates) = match located {
			Ok(value) => value,
			Err(error)
				if !deferred.contains(&index) && error.to_string().contains(" is ambiguous: ") =>
			{
				deferred.insert(index);
				queue.push(index);
				continue;
			},
			Err(error) => return Err(error),
		};
		if operation.whitespace_matched {
			recovery_notes.push(format!(
				"Note: operation {number}'s <SM:FIND> differed from the file in whitespace only and \
				 was matched leniently. Inserted lines are written exactly as authored — verify their \
				 indentation."
			));
		}
		if operation.all {
			candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.start));
		}
		match &operation.rewrite {
			OperationRewrite::Inline { replacements } => {
				let replacements = replacements
					.iter()
					.map(|rewrite| resolve_references(rewrite, &removed))
					.collect::<Result<Vec<_>, _>>()?;
				if pattern.selection_pairs.len() != replacements.len() {
					return Err(EditError::matched(format!(
						"Operation {number} inline replacements do not align with its selections."
					)));
				}
				let mut changes = 0;
				for candidate in &candidates {
					let mut selections = candidate
						.selection_spans
						.iter()
						.copied()
						.enumerate()
						.collect::<Vec<_>>();
					selections.sort_by_key(|(_, (start, _))| std::cmp::Reverse(*start));
					for (selection_index, span) in selections {
						let (prepared, replacement, deleted) = prepare_inline(
							content,
							candidate,
							span,
							&pattern.selection_pairs[selection_index],
							&replacements[selection_index],
							number,
							operation.whitespace_matched,
						)?;
						if content[prepared.start..prepared.end] == replacement {
							continue;
						}
						if candidates.len() == 1
							&& pattern.selection_pairs.len() == 1
							&& let Some(deleted) = deleted
						{
							removed[index] = Some(deleted);
						}
						planned.push(PlannedEdit {
							start: prepared.start,
							end: prepared.end,
							replacement,
							operation_number: number,
						});
						changes += 1;
					}
					last_match = candidate.match_start;
				}
				if changes == 0 {
					return Err(no_op_error(
						context,
						payload,
						Some(number),
						Some((content, candidates[0].match_start)),
						operation.all.then_some(candidates.len()),
						Some(
							"The stated text equals the current text and never changes the file. Restate \
							 the edit with the actual change; do not drop the operation.",
						),
					));
				}
			},
			OperationRewrite::Explicit { text } => {
				let resolved = resolve_references(text, &removed)?;
				let base = if resolved.trim().is_empty() {
					if pattern.insertion {
						"\n".to_owned()
					} else {
						String::new()
					}
				} else {
					resolved
				};
				if pattern.selection_ranges.len() > 1
					&& let Some(segments) = positional_rewrite_segments(
						&base,
						pattern.selection_ranges.len(),
						pattern
							.tokens
							.iter()
							.any(|token| matches!(token, PatternToken::Gap { .. })),
					) {
					let mut changes = 0;
					for candidate in &candidates {
						for ((start, end), replacement) in candidate
							.selection_spans
							.iter()
							.copied()
							.zip(&segments)
							.rev()
						{
							if content[start..end] == *replacement {
								continue;
							}
							planned.push(PlannedEdit {
								start,
								end,
								replacement: replacement.clone(),
								operation_number: number,
							});
							changes += 1;
						}
						last_match = candidate.match_start;
					}
					if changes == 0 {
						return Err(no_op_error(
							context,
							payload,
							Some(number),
							Some((content, candidates[0].match_start)),
							operation.all.then_some(candidates.len()),
							None,
						));
					}
					continue;
				}
				if pattern.selection_ranges.len() > 1
					&& !candidates
						.iter()
						.all(|candidate| rewrite_proves_whole_span(content, candidate, &base))
				{
					let one_line = base.split_whitespace().collect::<Vec<_>>().join(" ");
					let repeated = vec![one_line; pattern.selection_ranges.len()];
					let header = if operation.all {
						"<SM:EDIT all>"
					} else {
						"<SM:EDIT>"
					};
					let candidate = &candidates[0];
					return Err(EditError::matched(
						[
							format!(
								"Operation {number} has {} selections, but <SM:PUT> proves neither \
								 positional substitution nor whole-span replacement.",
								pattern.selection_ranges.len()
							),
							"Copy-ready per-selection interpretation:".to_owned(),
							format!(
								"{header}\n<SM:FIND>\n{}\n</SM:FIND>\n<SM:PUT>\n{}\n</SM:PUT>\n</SM:EDIT>",
								operation.pattern_text,
								repeated.join("\n")
							),
							"Copy-ready whole-span interpretation:".to_owned(),
							format!(
								"{header}\n<SM:FIND>\n{}\n</SM:FIND>\n<SM:PUT>\n{}\n</SM:PUT>\n</SM:EDIT>",
								operation.pattern_text,
								rewrite_selection_spans(content, candidate, &repeated)
							),
						]
						.join("\n"),
					));
				}
				let mut changes = 0;
				for located in &candidates {
					let mut candidate = located.clone();
					if operation.whitespace_matched
						&& pattern.line_insertion
						&& candidate.start == candidate.end
					{
						let snapped =
							snap_line_insertion_offset(content, candidate.start, !base.starts_with('\n'));
						candidate.start = snapped;
						candidate.end = snapped;
					}
					let rewrite = if pattern.line_insertion {
						frame_line_insertion(content, candidate.start, &base, false)
					} else {
						base.clone()
					};
					let rendered = render_rewrite(
						&rewrite,
						if candidate.captures.is_empty() {
							&[]
						} else {
							&pattern.selected_capture_indices
						},
						&candidate.captures,
						number,
					)?;
					let replacement = align_boundary_echoes(content, &candidate, &rendered);
					let deleted = replacement
						.is_empty()
						.then(|| content[candidate.start..candidate.end].to_owned());
					if deleted.is_some() {
						candidate = expand_full_line_deletion(content, &candidate);
					}
					if candidates.len() == 1
						&& let Some(deleted) = &deleted
					{
						removed[index] = Some(deleted.clone());
					}
					if let Some(deleted) = deleted {
						let lines = deleted
							.lines()
							.filter(|line| !line.trim().is_empty())
							.count();
						deletion_notes.insert(
							number,
							if operation.assumed_deletion {
								format!(
									"Note: operation {number} had no <SM:PUT> and was applied as a move \
									 deletion (a later operation re-emits its block)."
								)
							} else {
								format!(
									"Note: operation {number} deleted {lines} line(s); an empty <SM:PUT> \
									 means deletion — resend with the final text if you meant to replace."
								)
							},
						);
					}
					last_match = candidate.match_start;
					let same = content[candidate.start..candidate.end] == replacement
						|| operation.desired_state
							&& normalize_text(&replacement).text
								== normalize_text(&content[candidate.start..candidate.end]).text;
					if same {
						if operation.all {
							continue;
						}
						if let Some((start, end)) =
							duplicate_collapse_span(content, &candidate, &replacement)
						{
							planned.push(PlannedEdit {
								start,
								end,
								replacement,
								operation_number: number,
							});
							changes += 1;
							continue;
						}
						if operation.desired_state {
							recovery_notes.push(format!(
								"Note: operation {number} already matches the file; no change was needed \
								 there."
							));
							changes += 1;
							continue;
						}
						return Err(no_op_error(
							context,
							payload,
							Some(number),
							Some((content, candidate.match_start)),
							None,
							None,
						));
					}
					planned.push(PlannedEdit {
						start: candidate.start,
						end: candidate.end,
						replacement,
						operation_number: number,
					});
					changes += 1;
				}
				if operation.all && changes == 0 {
					return Err(no_op_error(
						context,
						payload,
						Some(number),
						Some((content, candidates[0].match_start)),
						Some(candidates.len()),
						None,
					));
				}
			},
		}
	}
	if planned.is_empty() {
		return Err(no_op_error(context, payload, None, Some((content, last_match)), None, None));
	}
	planned.sort_by_key(|edit| (edit.start, edit.end));
	let mut ordered: Vec<PlannedEdit> = Vec::new();
	for current in planned {
		let Some(previous) = ordered.last().cloned() else {
			ordered.push(current);
			continue;
		};
		let overlaps = current.start < previous.end
			|| current.start == previous.start
				&& current.end == current.start
				&& previous.end == previous.start;
		if !overlaps {
			ordered.push(current);
			continue;
		}
		if let Some(merged) = reconcile_overlap(content, &previous, &current) {
			*ordered.last_mut().expect("present") = merged;
			continue;
		}
		if previous.operation_number == current.operation_number {
			continue;
		}
		let first_line = line_number_at(content, previous.start);
		let second_line = line_number_at(content, current.start);
		return Err(EditError::matched(format!(
			"Operations {} and {} target overlapping original spans near lines {first_line} and \
			 {second_line}.\n\nConflicting candidates:\n\nOperation {} near line \
			 {first_line}:\n{}\n\nOperation {} near line {second_line}:\n{}\n\nKeep whichever states \
			 the intended final text and drop the other.",
			previous.operation_number,
			current.operation_number,
			previous.operation_number,
			operation_payload(&operations[previous.operation_number - 1], "", None),
			current.operation_number,
			operation_payload(&operations[current.operation_number - 1], "", None)
		)));
	}
	let mut result = content.to_owned();
	for edit in ordered.into_iter().rev() {
		result.replace_range(edit.start..edit.end, &edit.replacement);
	}
	if result == content {
		return Err(no_op_error(context, payload, None, Some((content, last_match)), None, None));
	}
	context.store.reset_noop(context.canonical);
	context.notes.extend(recovery_notes);
	context.notes.extend(deletion_notes.into_values());
	Ok(result)
}

/// Parse, locate, and atomically apply one sloppy section.
pub fn apply_sloppy(
	content: &str,
	input: &str,
	mut context: ApplyContext<'_>,
) -> Result<String, EditError> {
	apply_operations(content, input, &mut context).map_err(|error| {
		let mut message = error.to_string();
		if !message.contains(ATOMICITY_NOTICE) {
			message.push('\n');
			message.push_str(ATOMICITY_NOTICE);
		}
		EditError::matched(message)
	})
}
