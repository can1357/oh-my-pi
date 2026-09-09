//! Agent reactions. A reply that opens
//! with a complete emoji grapheme reacts to the transcript block before it:
//! the emoji and immediately following whitespace are lifted out of the prose
//! and shown as a badge on that block instead. While the reply streams, an
//! incomplete emoji run is withheld until it resolves or proves to be ordinary
//! text, so the emoji never flashes inside the reply.
//!
//! Reactions are derived from the journaled assistant text, never stored, so
//! a rebuilt transcript reproduces them exactly (ADR 0005).

use std::sync::LazyLock;

use regex::Regex;

/// Longest emoji grapheme (UTF-16 units) still worth
/// withholding for.
const MAX_REACTION_UNITS: usize = 32;

/// One emoji grapheme (`\p{RGI_Emoji}` spelled out as the
/// RGI sequence grammar): a pictograph, a flag (two regional indicators), or
/// a keycap, followed by any run of presentation selectors, skin tones, tag
/// letters, and ZWJ-joined pictographs.
static REACTION: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"(?x)^
		(?:\p{Extended_Pictographic}|\p{Regional_Indicator}\p{Regional_Indicator}|[0-9\#*]\x{FE0F}?\x{20E3})
		(?:\x{FE0F}|\x{20E3}|\p{Emoji_Modifier}|[\x{E0020}-\x{E007F}]
		  |\x{200D}\p{Extended_Pictographic}(?:\x{FE0F}|\p{Emoji_Modifier})?)*
		$",
	)
	.expect("reaction grammar")
});

/// A still-streaming run that can only ever be an emoji grapheme plus
/// trailing blanks.
static REACTION_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"(?x)^
		(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\x{E0020}-\x{E007F}]
		  |\x{FE0F}|\x{200D}|\x{20E3})*
		[\ \t]*$",
	)
	.expect("reaction prefix grammar")
});

/// The reaction line split off the front of assistant text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReactionSplit<'a> {
	/// The reaction emoji when the text opens with an emoji grapheme.
	pub emoji:   Option<&'a str>,
	/// Text with the reaction line removed; the input when there is none.
	pub body:    &'a str,
	/// True while the (newline-less) text could still grow into a reaction
	/// line.
	pub pending: bool,
}

/// Splits a complete opening reaction emoji off assistant text.
///
/// Leading whitespace is tolerated. Horizontal whitespace or one line ending
/// immediately after the emoji is consumed before the remaining body.
#[must_use]
pub fn split_reaction(text: &str) -> ReactionSplit<'_> {
	let start = text.len() - text.trim_start().len();
	let head = &text[start..];
	if head.is_empty() {
		return ReactionSplit { emoji: None, body: text, pending: true };
	}
	let Some(emoji) = xutf::graphemes_str(head).next() else {
		return ReactionSplit { emoji: None, body: text, pending: true };
	};
	if REACTION.is_match(emoji) {
		let rest = &head[emoji.len()..];
		return ReactionSplit { emoji: Some(emoji), body: reaction_body(rest), pending: false };
	}
	ReactionSplit {
		emoji:   None,
		body:    text,
		pending: units(head) <= MAX_REACTION_UNITS && REACTION_PREFIX.is_match(head),
	}
}

/// Removes the whitespace associated with an opening reaction.
fn reaction_body(rest: &str) -> &str {
	let horizontal = rest
		.bytes()
		.take_while(|byte| matches!(byte, b' ' | b'\t'))
		.count();
	let after = &rest[horizontal..];
	after
		.strip_prefix("\r\n")
		.or_else(|| after.strip_prefix('\n'))
		.unwrap_or(after)
}

/// UTF-16 code units.
fn units(text: &str) -> usize {
	text.encode_utf16().count()
}

#[cfg(test)]
mod tests {
	use super::*;

	/// A lone emoji line lifts off as the reaction and
	/// the body is what follows it; emoji sequences (flags, skin tones,
	/// keycaps, ZWJ families) count as one grapheme.
	#[test]
	fn lone_emoji_lines_split_off_as_reactions() {
		assert_eq!(split_reaction("👍\nDone."), ReactionSplit {
			emoji:   Some("👍"),
			body:    "Done.",
			pending: false,
		});
		assert_eq!(split_reaction("  🎉  \n\nParty"), ReactionSplit {
			emoji:   Some("🎉"),
			body:    "\nParty",
			pending: false,
		});
		for emoji in ["🇺🇸", "👍🏽", "1️⃣", "👨‍👩‍👧", "👩🏽‍❤️‍👨🏻", "❤️", "🏴󠁧󠁢󠁳󠁣󠁴󠁿"]
		{
			let text = format!("{emoji}\nbody");
			assert_eq!(split_reaction(&text).emoji, Some(emoji), "{emoji}");
		}
	}

	/// Ordinary prose does not react. Once an opening emoji is complete, any
	/// following non-whitespace is the reply body (including another emoji or
	/// punctuation), matching the prefix split.
	#[test]
	fn prose_stays_plain_and_content_after_an_emoji_becomes_the_body() {
		for text in ["Sure 👍\nDone.", "hello\nworld", "\nDone."] {
			let split = split_reaction(text);
			assert_eq!(split.emoji, None, "{text:?}");
			assert_eq!(split.body, text);
			assert!(!split.pending);
		}
		assert_eq!(split_reaction("👍👍\nDone."), ReactionSplit {
			emoji:   Some("👍"),
			body:    "👍\nDone.",
			pending: false,
		});
		assert_eq!(split_reaction("👍!\nDone."), ReactionSplit {
			emoji:   Some("👍"),
			body:    "!\nDone.",
			pending: false,
		});
	}

	/// A complete emoji resolves immediately even without a newline. Only an
	/// incomplete emoji-prefix run remains pending and withheld.
	#[test]
	fn newline_less_complete_emoji_resolves_immediately() {
		assert_eq!(split_reaction("👍"), ReactionSplit {
			emoji:   Some("👍"),
			body:    "",
			pending: false,
		});
		assert_eq!(split_reaction("  👍 "), ReactionSplit {
			emoji:   Some("👍"),
			body:    "",
			pending: false,
		});
		assert!(split_reaction("").pending, "an empty stream may still open with a reaction");
		assert!(!split_reaction("👍 yes").pending);
		assert_eq!(split_reaction("👍 yes").body, "yes");
		assert!(!split_reaction("Sure").pending);
	}
}
