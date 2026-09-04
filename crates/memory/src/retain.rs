//! Transcript retention formatting, durable cursors, and idempotent suffix
//! commits.

use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

use crate::{
	Result,
	extract::MAX_EXTRACTION_INPUT_BYTES,
	store::{BankStore, RetainedWindow},
};

/// Journal-settled message role.
#[derive(
	Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, PartialEq, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
#[strum(ascii_case_insensitive, serialize_all = "lowercase")]
pub enum RetentionRole {
	/// User-authored input.
	User,
	/// Assistant response.
	Assistant,
	/// Durable tool outcome.
	Tool,
	/// System-authored settled context.
	System,
}

/// Owned settled message used by bounded shutdown retention.
#[derive(Clone, Debug)]
pub struct OwnedRetentionMessage {
	/// Stable journal item id.
	pub stable_id: Str,
	/// Message role.
	pub role:      RetentionRole,
	/// Settled textual content.
	pub content:   Str,
}
/// One journal-durable message eligible for retention.
#[derive(Clone, Copy)]
pub struct RetentionMessage<'a> {
	/// Stable journal item id used for idempotency metadata.
	pub stable_id: &'a str,
	/// Message role.
	pub role:      RetentionRole,
	/// Settled textual content.
	pub content:   &'a str,
}

/// Result of one retention decision.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RetentionOutcome {
	/// Whether a new durable episode was stored.
	pub stored_id:           Option<Str>,
	/// Highest covered user turn after the operation.
	pub retained_through:    u64,
	/// Whether a new durable extraction job was enqueued atomically.
	pub extraction_enqueued: bool,
	/// Marker-free text supplied to embeddings, when substantive.
	pub embedding_text:      Option<Str>,
}

/// Per-session retention coordinator backed by a durable cursor in the bank.
pub struct Retainer<'a> {
	store:                &'a BankStore,
	session_id:           &'a str,
	canonical_root:       &'a str,
	retain_every_n_turns: usize,
	extraction_enabled:   bool,
}

impl<'a> Retainer<'a> {
	/// Creates a coordinator. The turn interval is clamped to at least one.
	pub fn new(
		store: &'a BankStore,
		session_id: &'a str,
		canonical_root: &'a str,
		retain_every_n_turns: usize,
		extraction_enabled: bool,
	) -> Self {
		Self {
			store,
			session_id,
			canonical_root,
			retain_every_n_turns: retain_every_n_turns.max(1),
			extraction_enabled,
		}
	}

	/// Retains only when the configured user-turn interval has elapsed.
	pub fn retain_periodic(&self, messages: &[RetentionMessage<'_>]) -> Result<RetentionOutcome> {
		self.retain(messages, false)
	}

	/// Force-retains the unprocessed suffix, including a short final session
	/// window.
	pub fn retain_force(&self, messages: &[RetentionMessage<'_>]) -> Result<RetentionOutcome> {
		self.retain(messages, true)
	}

	#[tracing::instrument(
		level = "debug",
		name = "memory_retention",
		skip_all,
		fields(force = force, message_count = messages.len())
	)]
	fn retain(&self, messages: &[RetentionMessage<'_>], force: bool) -> Result<RetentionOutcome> {
		let cursor = self.store.retention_cursor(self.session_id)?;
		let user_turns = messages
			.iter()
			.filter(|message| message.role == RetentionRole::User)
			.count() as u64;
		tracing::debug!(
			force,
			user_turns,
			retained_through = cursor,
			interval = self.retain_every_n_turns,
			due = user_turns > cursor
				&& (force || user_turns - cursor >= self.retain_every_n_turns as u64),
			"memory retention evaluated"
		);
		if user_turns <= cursor || (!force && user_turns - cursor < self.retain_every_n_turns as u64)
		{
			return Ok(RetentionOutcome { retained_through: cursor, ..RetentionOutcome::default() });
		}
		let suffix = slice_unretained(messages, cursor);
		let Some(transcript) = format_durable_transcript(suffix) else {
			return Ok(RetentionOutcome { retained_through: cursor, ..RetentionOutcome::default() });
		};
		let extraction_text = self
			.extraction_enabled
			.then(|| format_extraction_text(suffix))
			.flatten();
		let embedding_text = format_embedding_text(suffix);
		let ids = suffix
			.iter()
			.map(|message| message.stable_id)
			.collect::<Vec<_>>();
		let metadata = serde_json::json!({
			"session_id": self.session_id,
			"source_ids": ids,
			"message_count": suffix.len(),
			"retained_through_user_turn": user_turns,
			"primary_root": self.canonical_root,
		});
		let stored_id = self.store.retain_window(RetainedWindow {
			session_id:                 self.session_id,
			transcript:                 transcript.as_str(),
			embed_text:                 embedding_text.as_deref().unwrap_or(transcript.as_str()),
			extraction_text:            extraction_text.as_deref(),
			metadata:                   &metadata,
			retained_through_user_turn: user_turns,
		})?;
		let extraction_enqueued = stored_id.is_some() && extraction_text.is_some();
		tracing::debug!(
			stored = stored_id.is_some(),
			retained_through = user_turns,
			extraction_enqueued,
			"memory retention completed"
		);
		Ok(RetentionOutcome {
			stored_id,
			retained_through: user_turns,
			extraction_enqueued,
			embedding_text,
		})
	}
}

/// Frames all substantive messages with explicit role/end markers.
pub fn format_durable_transcript(messages: &[RetentionMessage<'_>]) -> Option<Str> {
	format_messages(messages.iter().copied(), true)
}

/// Frames only user-authored messages for fact/entity extraction.
pub fn format_extraction_text(messages: &[RetentionMessage<'_>]) -> Option<Str> {
	let text = format_messages(
		messages
			.iter()
			.copied()
			.filter(|message| message.role == RetentionRole::User),
		true,
	)?;
	Some(bound_extraction_text(text))
}

fn bound_extraction_text(text: Str) -> Str {
	if text.len() <= MAX_EXTRACTION_INPUT_BYTES {
		return text;
	}
	const CLOSING_MARKER: &str = "\n[user:end]";
	let mut boundary = MAX_EXTRACTION_INPUT_BYTES - CLOSING_MARKER.len();
	while !text.as_str().is_char_boundary(boundary) {
		boundary -= 1;
	}
	let prefix = text.as_str()[..boundary].trim_end();
	let mut bounded = String::with_capacity(prefix.len() + CLOSING_MARKER.len());
	bounded.push_str(prefix);
	bounded.push_str(CLOSING_MARKER);
	Str::new(bounded)
}

/// Formats every substantive message without protocol markers for embedding and
/// FTS.
pub fn format_embedding_text(messages: &[RetentionMessage<'_>]) -> Option<Str> {
	format_messages(messages.iter().copied(), false)
}

/// Removes retention protocol markers from recalled episode content.
pub fn strip_protocol_markers(content: &str) -> Str {
	let mut output = String::with_capacity(content.len());
	for line in content.lines() {
		let trimmed = line.trim();
		let marker = trimmed.starts_with("[role: ") && trimmed.ends_with(']')
			|| trimmed.starts_with("[user:end]")
			|| trimmed.starts_with("[assistant:end]")
			|| trimmed.starts_with("[tool:end]")
			|| trimmed.starts_with("[system:end]");
		if marker {
			continue;
		}
		if !output.is_empty() {
			output.push('\n');
		}
		output.push_str(line);
	}
	Str::new(output.trim())
}

fn slice_unretained<'a>(
	messages: &'a [RetentionMessage<'a>],
	cursor: u64,
) -> &'a [RetentionMessage<'a>] {
	if cursor == 0 {
		return messages;
	}
	let mut users = 0u64;
	for (index, message) in messages.iter().enumerate() {
		if message.role != RetentionRole::User {
			continue;
		}
		users += 1;
		if users > cursor {
			return &messages[index..];
		}
	}
	&[]
}

fn format_messages<'a>(
	messages: impl Iterator<Item = RetentionMessage<'a>>,
	markers: bool,
) -> Option<Str> {
	let mut output = String::new();
	for message in messages {
		let content = strip_memory_blocks(message.content);
		let content = content.trim();
		if !substantive(content) {
			continue;
		}
		if !output.is_empty() {
			output.push_str("\n\n");
		}
		if markers {
			let role: &'static str = message.role.into();
			output.push_str("[role: ");
			output.push_str(role);
			output.push_str("]\n");
			output.push_str(content);
			output.push('\n');
			output.push('[');
			output.push_str(role);
			output.push_str(":end]");
		} else {
			output.push_str(content);
		}
	}
	if output.trim().len() < 10 {
		None
	} else {
		Some(Str::new(output))
	}
}

fn strip_memory_blocks(content: &str) -> String {
	let mut output = String::with_capacity(content.len());
	let mut inside = false;
	for line in content.lines() {
		let trimmed = line.trim();
		if trimmed.starts_with("<memories>") {
			inside = true;
			continue;
		}
		if trimmed.ends_with("</memories>") {
			inside = false;
			continue;
		}
		if inside {
			continue;
		}
		if !output.is_empty() {
			output.push('\n');
		}
		output.push_str(line);
	}
	output
}

fn substantive(content: &str) -> bool {
	content.chars().any(char::is_alphanumeric)
}
#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn extraction_text_is_utf8_safe_and_hard_bounded() {
		let content = "é".repeat(MAX_EXTRACTION_INPUT_BYTES);
		let messages = [RetentionMessage {
			stable_id: "message",
			role:      RetentionRole::User,
			content:   &content,
		}];
		let extraction = format_extraction_text(&messages).expect("substantive extraction");
		assert!(extraction.len() <= MAX_EXTRACTION_INPUT_BYTES);
		assert!(extraction.as_str().ends_with("[user:end]"));
		assert!(extraction.as_str().is_char_boundary(extraction.len()));
	}
}
