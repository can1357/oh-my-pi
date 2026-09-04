//! `#<number>` GitHub references: a
//! standalone `#3164` token at the cursor offers `pr://3164` and
//! `issue://3164`; a `pr`/`pull`/`issue` word before the `#` constrains the
//! kind. No network at suggestion time.

use omp_core::{Str, sf};
use omp_tui::{EditorCompletion, Icon, Suggestion, Suggestions};

use super::is_token_start;

/// Candidate kinds, in display order.
const KINDS: [Kind; 2] = [
	Kind {
		qualifier:   "pr",
		label:       "PR",
		description: "GitHub pull request",
		icon:        Icon::Pr,
	},
	Kind {
		qualifier:   "issue",
		label:       "Issue",
		description: "GitHub issue",
		icon:        Icon::Issue,
	},
];

#[derive(Clone, Copy)]
struct Kind {
	qualifier:   &'static str,
	label:       &'static str,
	description: &'static str,
	icon:        Icon,
}

/// A `[pr|pull|issue] #<number>` token ending at `cursor`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefContext {
	/// Byte offset of the token start (the qualifier word or the `#`).
	pub start:     usize,
	/// Kind the user named (`pr`/`pull` → `pr`, `issue`), or `None` for both.
	pub qualifier: Option<&'static str>,
	/// The numeric reference, e.g. `3164`.
	pub number:    Str,
}

/// Parses the GitHub reference token ending at `cursor`, if any.
#[must_use]
pub fn ref_context(text: &str, cursor: usize) -> Option<RefContext> {
	let before = text.get(..cursor)?;
	let hash = before.rfind('#')?;
	let digits = &before[hash + 1..];
	if digits.is_empty()
		|| !digits.bytes().all(|byte| byte.is_ascii_digit())
		|| digits.starts_with('0')
	{
		return None;
	}
	let head = &before[..hash];
	let word_end = head.trim_end_matches(char::is_whitespace).len();
	let qualified = word_end < head.len();
	// The boundary before the qualifier word may be a multibyte glyph (a
	// nerd-font chip such as `\u{f15c} #1`), so step past its whole encoding.
	let word_start = head[..word_end]
		.char_indices()
		.rev()
		.find(|(_, character)| !character.is_ascii_alphabetic())
		.map_or(0, |(at, character)| at + character.len_utf8());
	let word = &head[word_start..word_end];
	let qualifier = match (qualified, word.to_ascii_lowercase().as_str()) {
		(true, "pr" | "pull") if is_token_start(text, word_start) => Some("pr"),
		(true, "issue") if is_token_start(text, word_start) => Some("issue"),
		_ => None,
	};
	if qualifier.is_none() && !is_token_start(text, hash) {
		return None;
	}
	Some(RefContext {
		start: if qualifier.is_some() {
			word_start
		} else {
			hash
		},
		qualifier,
		number: Str::new(digits),
	})
}

/// GitHub reference completion.
pub struct GithubRefs;

impl EditorCompletion for GithubRefs {
	fn suggest(&mut self, text: &str, cursor: usize) -> Option<Suggestions> {
		let context = ref_context(text, cursor)?;
		let items = KINDS
			.iter()
			.filter(|kind| {
				context
					.qualifier
					.is_none_or(|wanted| wanted == kind.qualifier)
			})
			.map(|kind| {
				Suggestion::new(
					sf!("{}://{} ", kind.qualifier, context.number),
					sf!("{} #{}", kind.label, context.number),
				)
				.with_description(kind.description)
				.with_icon(kind.icon)
			})
			.collect();
		Some(Suggestions { range: context.start..cursor, items })
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn standalone_number_offers_both_kinds() {
		let mut refs = GithubRefs;
		let suggestions = refs.suggest("see #3164", 9).expect("ref rows");
		assert_eq!(suggestions.range, 4..9);
		assert_eq!(suggestions.items.len(), 2);
		assert_eq!(suggestions.items[0].value(), "pr://3164 ");
		assert_eq!(suggestions.items[1].value(), "issue://3164 ");
	}

	#[test]
	fn qualifier_word_constrains_the_kind_and_extends_the_range() {
		let mut refs = GithubRefs;
		let suggestions = refs.suggest("fix issue #12", 13).expect("issue row");
		assert_eq!(suggestions.range, 4..13);
		assert_eq!(suggestions.items.len(), 1);
		assert_eq!(suggestions.items[0].value(), "issue://12 ");
		let pull = refs.suggest("Pull  #7", 8).expect("pull row");
		assert_eq!(pull.items[0].value(), "pr://7 ");
	}

	#[test]
	fn embedded_hashes_and_non_numbers_never_match() {
		let mut refs = GithubRefs;
		assert!(refs.suggest("owner/repo#12", 13).is_none());
		assert!(refs.suggest("C#12", 4).is_none());
		assert!(refs.suggest("#copy", 5).is_none());
		assert!(refs.suggest("#012", 4).is_none());
		assert!(refs.suggest("#", 1).is_none());
	}

	/// A collapsed-paste chip (`<nerd glyph> #1`) puts a three-byte glyph
	/// right before the `#`: the qualifier scan must land on a char boundary.
	#[test]
	fn multibyte_glyph_before_the_hash_never_panics() {
		let mut refs = GithubRefs;
		let chip = "\u{f15c} #1";
		let suggestions = refs
			.suggest(chip, chip.len())
			.expect("standalone #1 still offers rows");
		assert_eq!(suggestions.range, 4..chip.len());
		assert!(refs.suggest("\u{f15c}#1", "\u{f15c}#1".len()).is_none());
		assert!(refs.suggest("日本 pr #1", "日本 pr #1".len()).is_some());
	}
}
