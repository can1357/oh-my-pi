//! Word-local fuzzy matching.
//!
//! Matching is deliberately word-local: a query like `image provider` never
//! matches a long description only because the letters i-m-a-g-e appear in
//! order across unrelated words. Every space-separated query token must
//! match; whole-phrase and word-start hits earn large bonuses so contiguous
//! literal matches always outrank scattered subsequences. Lower score is
//! better. Scores are fixed-point values scaled by [`SCALE`].

use std::ops::Range;

use smallvec::SmallVec;

/// Fixed-point score scale.
const SCALE: i32 = 100;
const ALPHANUMERIC_SWAP_PENALTY: i32 = 5 * SCALE;
const COMPACT_PHRASE_BONUS: i32 = 1200 * SCALE;
const PHRASE_BONUS: i32 = 1000 * SCALE;
/// Shortest needle worth scanning past its leading occurrence for: one or
/// two characters sit mid-word in nearly every candidate, so rescanning
/// that short would hand the word-start bonus to the whole corpus at once.
const MIN_SHADOW_RESCAN_LENGTH: usize = 3;

/// Splits camel-case, lowercases, and collapses every non-alphanumeric run
/// into one space.
fn normalize(value: &str) -> String {
	let chars: SmallVec<char, 64> = value.chars().collect();
	let mut out = String::with_capacity(value.len());
	let mut pending_space = false;
	for (index, &character) in chars.iter().enumerate() {
		if !character.is_alphanumeric() {
			pending_space = true;
			continue;
		}
		if index > 0 && character.is_uppercase() {
			let previous = chars[index - 1];
			let camel = previous.is_lowercase()
				|| previous.is_numeric()
				|| (previous.is_uppercase()
					&& chars.get(index + 1).is_some_and(|next| next.is_lowercase()));
			pending_space |= camel;
		}
		if pending_space && !out.is_empty() {
			out.push(' ');
		}
		pending_space = false;
		out.extend(character.to_lowercase());
	}
	out
}

#[derive(Clone)]
struct Word {
	/// Byte range within `normalized`.
	span:    Range<usize>,
	ordinal: usize,
}

/// A candidate text prepared once for repeated matching.
#[derive(Clone)]
pub struct SearchIndex {
	normalized:     String,
	compact:        String,
	/// Sorted byte offsets in `compact` where a word starts.
	compact_starts: SmallVec<usize, 8>,
	words:          SmallVec<Word, 8>,
}

impl SearchIndex {
	/// Indexes one candidate text.
	#[must_use]
	pub fn new(text: &str) -> Self {
		let normalized = normalize(text);
		let mut words = SmallVec::new();
		let mut compact_starts = SmallVec::new();
		let mut compact = String::with_capacity(normalized.len());
		if !normalized.is_empty() {
			let mut start = 0;
			for (ordinal, word) in normalized.split(' ').enumerate() {
				compact_starts.push(compact.len());
				compact.push_str(word);
				words.push(Word { span: start..start + word.len(), ordinal });
				start += word.len() + 1;
			}
		}
		Self { normalized, compact, compact_starts, words }
	}

	fn word_text(&self, word: &Word) -> &str {
		&self.normalized[word.span.clone()]
	}

	/// Scores `query` against this text; `None` when it does not match.
	#[must_use]
	pub fn score(&self, query: &Query) -> Option<i32> {
		if self.words.is_empty() {
			return None;
		}
		let mut total = 0;
		if let Some(at) = find_word_boundary_phrase(&self.normalized, &query.normalized) {
			total -= PHRASE_BONUS;
			total += at as i32;
		}
		if let Some(at) = self.find_compact_word_start(&query.compact) {
			total -= COMPACT_PHRASE_BONUS;
			total += at as i32;
		}
		for token in &query.tokens {
			total += self.score_token(&query.normalized[token.clone()])?;
		}
		Some(total)
	}

	/// Offset of the first occurrence of `needle` that starts a word in the
	/// compact text.
	fn find_compact_word_start(&self, needle: &str) -> Option<usize> {
		if needle.is_empty() {
			return None;
		}
		let first = self.compact.find(needle)?;
		if self.compact_starts.binary_search(&first).is_ok() {
			return Some(first);
		}
		if needle.chars().count() < MIN_SHADOW_RESCAN_LENGTH {
			return None;
		}
		let mut from = next_char_boundary(&self.compact, first);
		while let Some(offset) = self.compact[from..].find(needle) {
			let at = from + offset;
			if self.compact_starts.binary_search(&at).is_ok() {
				return Some(at);
			}
			from = next_char_boundary(&self.compact, at);
		}
		None
	}

	fn score_token(&self, token: &str) -> Option<i32> {
		if let Some(score) = self.score_token_direct(token) {
			return Some(score);
		}
		let mut best: Option<i32> = None;
		for variant in alphanumeric_swaps(token) {
			if let Some(score) = self.score_token_direct(&variant) {
				let score = score + ALPHANUMERIC_SWAP_PENALTY;
				best = Some(best.map_or(score, |current| current.min(score)));
			}
		}
		best
	}

	fn score_token_direct(&self, token: &str) -> Option<i32> {
		if token.is_empty() {
			return Some(0);
		}
		let mut best = self
			.find_compact_word_start(token)
			.map(|at| -140 * SCALE + at as i32);
		for word in &self.words {
			if let Some(score) = score_token_against_word(token, self.word_text(word), word.span.start)
				&& best.is_none_or(|current| score < current)
			{
				best = Some(score);
			}
		}
		if let Some(score) = self.score_acronym(token)
			&& best.is_none_or(|current| score < current)
		{
			best = Some(score);
		}
		best
	}

	/// Matches a short token against word initials.
	fn score_acronym(&self, token: &str) -> Option<i32> {
		let length = token.chars().count();
		if !(2..=4).contains(&length) {
			return None;
		}
		let mut wanted = token.chars();
		let mut current = wanted.next()?;
		let mut first: Option<(usize, usize)> = None;
		let mut last_ordinal = 0;
		let mut matched = 0;
		for word in &self.words {
			if !self.word_text(word).starts_with(current) {
				continue;
			}
			if first.is_none() {
				first = Some((word.ordinal, word.span.start));
			}
			last_ordinal = word.ordinal;
			matched += 1;
			match wanted.next() {
				Some(next) => current = next,
				None => break,
			}
		}
		let (first_ordinal, first_index) = first?;
		if matched < length {
			return None;
		}
		let span = last_ordinal - first_ordinal + 1;
		if span > length + 2 {
			return None;
		}
		Some((-30 + span as i32 * 4 - length as i32 * 2) * SCALE + first_index as i32)
	}
}

/// A query normalized and tokenized once for a whole candidate list. `None`
/// when the query has no searchable characters.
pub struct Query {
	normalized: String,
	compact:    String,
	/// Byte ranges of each token within `normalized`.
	tokens:     SmallVec<Range<usize>, 4>,
}

impl Query {
	/// Prepares `query`; `None` for a blank or punctuation-only query,
	/// which matches everything.
	#[must_use]
	pub fn new(query: &str) -> Option<Self> {
		let normalized = normalize(query);
		if normalized.is_empty() {
			return None;
		}
		let mut tokens = SmallVec::new();
		let mut start = 0;
		for token in normalized.split(' ') {
			tokens.push(start..start + token.len());
			start += token.len() + 1;
		}
		let compact = normalized.replace(' ', "");
		Some(Self { normalized, compact, tokens })
	}
}

fn next_char_boundary(text: &str, at: usize) -> usize {
	at + text[at..].chars().next().map_or(1, char::len_utf8)
}

const fn is_word_boundary_phrase(normalized: &str, at: usize, len: usize) -> bool {
	let before = at == 0 || normalized.as_bytes()[at - 1] == b' ';
	let end = at + len;
	let after = end == normalized.len() || normalized.as_bytes()[end] == b' ';
	before && after
}

/// Offset of the first whole-word occurrence of `phrase`: a hit buried
/// inside a word may shadow a later
/// whole-word one, so longer phrases rescan past it.
fn find_word_boundary_phrase(normalized: &str, phrase: &str) -> Option<usize> {
	if phrase.is_empty() {
		return None;
	}
	let first = normalized.find(phrase)?;
	if is_word_boundary_phrase(normalized, first, phrase.len()) {
		return Some(first);
	}
	if first == 0 || normalized.as_bytes()[first - 1] == b' ' {
		return None;
	}
	if phrase.chars().count() < MIN_SHADOW_RESCAN_LENGTH {
		return None;
	}
	let mut from = next_char_boundary(normalized, first);
	while let Some(offset) = normalized[from..].find(phrase) {
		let at = from + offset;
		if is_word_boundary_phrase(normalized, at, phrase.len()) {
			return Some(at);
		}
		from = next_char_boundary(normalized, at);
	}
	None
}

/// Subsequence match of `query` inside one word: contiguous runs score down,
/// gaps and late starts score up. Returns the
/// score and the matched span in characters.
fn score_characters(query: &str, text: &str) -> Option<(i32, usize)> {
	let mut wanted = query.chars();
	let Some(mut current) = wanted.next() else {
		return Some((0, 0));
	};
	if query.chars().count() > text.chars().count() {
		return None;
	}
	let mut score = 0;
	let mut first = None;
	let mut last: Option<usize> = None;
	let mut consecutive = 0;
	let mut complete = false;
	for (index, character) in text.chars().enumerate() {
		if character != current {
			continue;
		}
		if first.is_none() {
			first = Some(index);
		}
		if last.is_some_and(|last| last + 1 == index) {
			consecutive += 1;
			score -= consecutive * 5 * SCALE;
		} else {
			consecutive = 0;
			if let Some(last) = last {
				score += (index - last - 1) as i32 * 2 * SCALE;
			}
		}
		score += index as i32 * 10;
		last = Some(index);
		if let Some(next) = wanted.next() {
			current = next
		} else {
			complete = true;
			break;
		}
	}
	if !complete {
		return None;
	}
	Some((score, last? - first? + 1))
}

fn score_token_against_word(token: &str, word: &str, word_index: usize) -> Option<i32> {
	let position = word_index as i32;
	if word == token {
		return Some(-200 * SCALE + position);
	}
	let token_len = token.chars().count() as i32;
	let word_len = word.chars().count() as i32;
	if word.starts_with(token) {
		return Some(-170 * SCALE + (word_len - token_len) * SCALE / 2 + position);
	}
	if token.starts_with(word) && token_len - word_len <= 2 {
		return Some(-150 * SCALE + (token_len - word_len) * SCALE + position);
	}
	if let Some(at) = word.find(token) {
		let at = word[..at].chars().count() as i32;
		return Some((-20 + at) * SCALE + position);
	}
	let (score, span) = score_characters(token, word)?;
	let max_span = (token_len as usize + 2).max((token_len as f64 * 1.8).ceil() as usize);
	if span > max_span {
		return None;
	}
	Some(-40 * SCALE + score + position)
}

/// Query variants with one adjacent letter/digit pair swapped: `gpt5` also
/// tries `gp5t`-style typos.
fn alphanumeric_swaps(token: &str) -> SmallVec<String, 4> {
	let chars: SmallVec<char, 16> = token.chars().collect();
	let mut variants: SmallVec<String, 4> = SmallVec::new();
	for index in 0..chars.len().saturating_sub(1) {
		let (current, next) = (chars[index], chars[index + 1]);
		let swap = (current.is_ascii_lowercase() && next.is_ascii_digit())
			|| (current.is_ascii_digit() && next.is_ascii_lowercase());
		if !swap {
			continue;
		}
		let mut swapped = chars.clone();
		swapped.swap(index, index + 1);
		let variant: String = swapped.into_iter().collect();
		if !variants.contains(&variant) {
			variants.push(variant);
		}
	}
	variants
}

/// Scores `query` against `text` in one shot; `Some(0)` for a blank query.
#[must_use]
pub fn fuzzy_match(query: &str, text: &str) -> Option<i32> {
	match Query::new(query) {
		None => Some(0),
		Some(query) => SearchIndex::new(text).score(&query),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn normalize_splits_camel_case_and_collapses_punctuation() {
		assert_eq!(normalize("ClaudeOpus4.6-thinking"), "claude opus4 6 thinking");
		assert_eq!(normalize("GPTOss 120B"), "gpt oss 120 b");
		assert_eq!(normalize("  --  "), "");
		assert_eq!(normalize("anthropic/claude-opus-5"), "anthropic claude opus 5");
	}

	#[test]
	fn contiguous_matches_outrank_scattered_subsequences() {
		let opus = fuzzy_match("opus", "Anthropic Claude Opus 5 anthropic/claude-opus-5")
			.expect("whole word");
		assert!(
			fuzzy_match("opus", "OpenRouter Qwen Plus openrouter/qwen/qwen-plus").is_none(),
			"letters scattered across unrelated words never match"
		);
		let gpt_oss = fuzzy_match("opus", "OpenRouter gpt-oss-120b openrouter/openai/gpt-oss-120b");
		assert!(gpt_oss.is_none(), "o-p-u-s across gpt-oss is not word-local: {gpt_oss:?}");
		assert!(opus < -PHRASE_BONUS, "a whole-word phrase earns the phrase bonus: {opus}");
	}

	#[test]
	fn prefix_beats_substring_and_fuzzy_within_a_word() {
		let exact = fuzzy_match("sonnet", "sonnet").expect("exact");
		let prefix = fuzzy_match("son", "sonnet").expect("prefix");
		let inside = fuzzy_match("net", "sonnet").expect("substring");
		let fuzzy = fuzzy_match("snt", "sonnet").expect("subsequence");
		assert!(exact < prefix, "{exact} < {prefix}");
		assert!(prefix < inside, "{prefix} < {inside}");
		assert!(prefix < fuzzy, "{prefix} < {fuzzy}");
		assert!(
			fuzzy_match("st", "sonnet").is_none(),
			"a subsequence wider than the token's span budget is not a match"
		);
	}

	#[test]
	fn every_token_must_match_and_acronyms_count() {
		assert!(fuzzy_match("claude sonnet", "Claude Sonnet 4.5").is_some());
		assert!(fuzzy_match("claude gemini", "Claude Sonnet 4.5").is_none());
		assert!(fuzzy_match("cs", "Claude Sonnet 4.5").is_some(), "acronym over word initials");
	}

	#[test]
	fn whole_word_phrase_is_found_past_a_shadowing_inner_hit() {
		let shadowed = find_word_boundary_phrase("reimage image provider", "image");
		assert_eq!(shadowed, Some(8));
		assert_eq!(find_word_boundary_phrase("experimental", "im"), None);
	}

	#[test]
	fn swapped_alphanumerics_still_match_with_a_penalty() {
		let exact = fuzzy_match("gpt5", "openai/gpt5").expect("exact");
		let swapped = fuzzy_match("gp5t", "openai/gpt5").expect("swap");
		assert!(swapped > exact);
	}

	#[test]
	fn blank_query_matches_everything_at_zero() {
		assert_eq!(fuzzy_match("   ", "anything"), Some(0));
		assert_eq!(fuzzy_match("--", "anything"), Some(0));
		assert!(Query::new("").is_none());
	}
}
