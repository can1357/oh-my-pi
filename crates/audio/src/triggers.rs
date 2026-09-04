//! Speech-to-text submit-trigger evaluation.

use strum::{Display, EnumString, IntoStaticStr};

/// Automatic composer-submission policy for one completed utterance.
#[derive(Clone, Copy, Debug, Default, Display, EnumString, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum SubmitTrigger {
	/// Insert dictation and remain in the editor.
	#[default]
	Never,
	/// Submit on release when at least two words were recognized.
	Release,
	/// Submit on release only for sentence-terminal punctuation.
	ReleaseComplete,
	/// Submit when the final spoken word contains `submit`, removing that word.
	SaySubmit,
}

/// Result of evaluating a submit trigger.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SubmitDecision {
	/// Whether the composer should submit.
	pub submit:        bool,
	/// Number of trailing UTF-8 bytes to remove from the original utterance.
	pub trim_trailing: usize,
}

/// Evaluates one completed utterance without modifying it.
pub fn evaluate_submit_trigger(utterance: &str, trigger: SubmitTrigger) -> SubmitDecision {
	let trimmed = utterance.trim();
	if trimmed.is_empty() || trigger == SubmitTrigger::Never {
		return SubmitDecision::default();
	}
	match trigger {
		SubmitTrigger::Never => SubmitDecision::default(),
		SubmitTrigger::Release => SubmitDecision {
			submit:        trimmed.split_whitespace().take(2).count() >= 2,
			trim_trailing: 0,
		},
		SubmitTrigger::ReleaseComplete => SubmitDecision {
			submit:        trimmed
				.chars()
				.next_back()
				.is_some_and(|ch| matches!(ch, '.' | '?' | '!' | '…' | '。' | '？' | '！')),
			trim_trailing: 0,
		},
		SubmitTrigger::SaySubmit => say_submit(utterance),
	}
}

fn say_submit(utterance: &str) -> SubmitDecision {
	let end = utterance
		.trim_end_matches(char::is_whitespace)
		.trim_end_matches(['.', '?', '!', '…', '。', '？', '！'])
		.len();
	let head = &utterance[..end];
	let start = head
		.char_indices()
		.rev()
		.find_map(|(index, ch)| ch.is_whitespace().then_some(index + ch.len_utf8()))
		.unwrap_or(0);
	let word = &utterance[start..end];
	if word.to_lowercase().contains("submit") {
		let trim_start = utterance[..start].trim_end().len();
		SubmitDecision { submit: true, trim_trailing: utterance.len() - trim_start }
	} else {
		SubmitDecision::default()
	}
}
