//! `thread_projection`: the `ContextView` / `ContextPatch` domain gate
//! around the model-facing thread projection (Python `omp.context`).
//!
//! Before every inference the kernel projects the session tree into
//! inference messages; a subscribed extension sees a body-free `ContextView`
//! of that projection and may answer with a `ContextPatch` (`prune`,
//! `drop_parts`, `replace`, `insert`, `reorder`).
//! The patch edits one request's working copy only: the journal and DOM are
//! never touched, so replay is unaffected. The family is fail-open: a
//! denial, a malformed reply, or a structurally invalid patch leaves the
//! projection as projected.

use std::sync::Arc;

use omp_ai::{ContentPart, Message, Role};
use omp_core::{Str, sf};
use omp_proto::toolhost::v1::HookEventId;
use serde_json::Value as JsonValue;
use thiserror::Error;

use crate::{LifecycleHookError, LifecycleHooks, directors::compaction::message_ref};

/// Estimated bytes per token shared with the compaction Director.
const BYTES_PER_TOKEN: u64 = 4;

/// Facts a `ContextView` carries besides the projected messages.
#[derive(Clone, Debug, Default)]
pub struct ContextFacts {
	/// Journal stem the session is stored under.
	pub session_id:         Str,
	/// Handle of the turn the request belongs to.
	pub turn_id:            Str,
	/// Catalog model key (`provider/model`) the request targets.
	pub model:              Str,
	/// Compaction epoch: how many `compaction@1` boundaries the live chain
	/// carries.
	pub epoch:              u64,
	/// Catalog context window of the resolved route (`0` when unknown).
	pub context_window:     u64,
	/// `ai_compact_threshold`.
	pub threshold_fraction: f64,
	/// Stable hash of the system prefix.
	pub prompt_hash:        Str,
	/// Estimated tokens of the system prefix.
	pub prompt_head_tokens: u64,
}

/// A `ContextPatch` that cannot be applied structurally (Python
/// `PatchRejected`); nothing is applied.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum ContextPatchError {
	/// An operation named an item that is not in the projection.
	#[error("context patch names unknown item {id}")]
	UnknownItem {
		/// The missing item id.
		id: Str,
	},
	/// A `replace` or `insert` supplied no usable parts.
	#[error("context patch {op} carries no parts")]
	EmptyParts {
		/// Operation name.
		op: &'static str,
	},
	/// A field was not the shape the schema declares.
	#[error("context patch field {field} is malformed")]
	Malformed {
		/// Dotted field path.
		field: &'static str,
	},
	/// An anchor relation outside `before|after|head|tail`.
	#[error("context patch anchor relation {relation} is unknown")]
	UnknownAnchor {
		/// The offered relation.
		relation: Str,
	},
}

/// What the gate did to the working projection.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProjectionOutcome {
	/// Operations applied, in patch order.
	pub applied: usize,
	/// Extension note attached to the patch.
	pub note:    Option<Str>,
}

/// Runs `thread_projection` over `messages`, applying the composed
/// `ContextPatch` in place. The leading system/developer prompt head is
/// immutable and outside the view's id space (`ContextUsage` accounts it as
/// `prompt_head_tokens`); ids number the conversation items after it.
/// Unsubscribed gates return without building the view; every failure keeps
/// the projection as projected.
pub async fn gate_thread_projection(
	hooks: &LifecycleHooks,
	facts: &ContextFacts,
	messages: &mut Vec<Message>,
) -> Result<ProjectionOutcome, LifecycleHookError> {
	if !hooks
		.hook_gate()
		.subscribed(HookEventId::HookEventThreadProjection)
	{
		return Ok(ProjectionOutcome::default());
	}
	let head = prompt_head_len(messages);
	let view = context_view(facts, &messages[head..]);
	let effective = match hooks
		.gate(HookEventId::HookEventThreadProjection, view)
		.await
	{
		Ok(effective) => effective,
		Err(LifecycleHookError::Denied { reason, .. }) => {
			tracing::warn!(%reason, "thread_projection hook denied; projection kept as projected");
			return Ok(ProjectionOutcome::default());
		},
		Err(error) => return Err(error),
	};
	let mut working = messages[head..].to_vec();
	match apply_context_patch(&mut working, &effective) {
		Ok(outcome) => {
			messages.truncate(head);
			messages.extend(working);
			Ok(outcome)
		},
		Err(error) => {
			tracing::warn!(%error, "thread_projection patch rejected; projection kept as projected");
			Ok(ProjectionOutcome::default())
		},
	}
}

/// The body-free `ContextView` of the conversation `messages` (prompt head
/// excluded): one `MessageRef` per projected message, ids being the
/// projection sequence numbers.
#[must_use]
pub fn context_view(facts: &ContextFacts, messages: &[Message]) -> JsonValue {
	let refs = messages
		.iter()
		.enumerate()
		.map(|(seq, message)| message_ref(seq, message))
		.collect::<Vec<_>>();
	let message_tokens = refs
		.iter()
		.filter_map(|item| item.get("tokens").and_then(JsonValue::as_u64))
		.sum::<u64>();
	let media_tokens = messages
		.iter()
		.flat_map(|message| message.content.iter())
		.filter(|part| {
			matches!(part, ContentPart::Image(_) | ContentPart::Audio(_) | ContentPart::Document(_))
		})
		.count() as u64
		* 256;
	let total = facts.prompt_head_tokens.saturating_add(message_tokens);
	let reserve = (facts.context_window as f64 * 0.15).floor() as u64;
	let usable = facts.context_window.saturating_sub(reserve);
	let fraction = if usable == 0 {
		0.0
	} else {
		total as f64 / usable as f64
	};
	let (provider, _) = facts
		.model
		.split_once('/')
		.unwrap_or(("", facts.model.as_str()));
	serde_json::json!({
		"session_id": facts.session_id,
		"turn_id": facts.turn_id,
		"model": facts.model,
		"provider": provider,
		"epoch": facts.epoch,
		"messages": refs,
		"usage": {
			"total_tokens": total,
			"context_window": facts.context_window,
			"reserve_tokens": reserve,
			"usable_tokens": usable,
			"fraction": fraction,
			"prompt_head_tokens": facts.prompt_head_tokens,
			"device_catalog_tokens": 0,
			"message_tokens": message_tokens,
			"catalog_notice_tokens": 0,
			"media_tokens": media_tokens,
			"compaction_epoch": facts.epoch,
			"threshold_fraction": facts.threshold_fraction,
			"in_flight": false,
		},
		"prompt_hash": facts.prompt_hash,
		"reset_event": JsonValue::Null,
	})
}

/// Applies the `ContextPatch` fields found on `patch` to `messages`, in the
/// schema's field order (`prune`, `drop_parts`, `replace`, `insert`,
/// `reorder`). Ids are the projection sequence numbers of the view the
/// patch answered; every operation resolves ids against the *original*
/// projection, so later operations never depend on earlier renumbering.
pub fn apply_context_patch(
	messages: &mut Vec<Message>,
	patch: &JsonValue,
) -> Result<ProjectionOutcome, ContextPatchError> {
	let ops = |field: &'static str| -> Result<&[JsonValue], ContextPatchError> {
		match patch.get(field) {
			None | Some(JsonValue::Null) => Ok(&[]),
			Some(JsonValue::Array(items)) => Ok(items.as_slice()),
			Some(_) => Err(ContextPatchError::Malformed { field }),
		}
	};
	let prune = ops("prune")?;
	let drop_parts = ops("drop_parts")?;
	let replace = ops("replace")?;
	let insert = ops("insert")?;
	let reorder = ops("reorder")?;
	let note = patch
		.get("note")
		.and_then(JsonValue::as_str)
		.filter(|note| !note.is_empty())
		.map(Str::new);
	if prune.is_empty()
		&& drop_parts.is_empty()
		&& replace.is_empty()
		&& insert.is_empty()
		&& reorder.is_empty()
	{
		return Ok(ProjectionOutcome { applied: 0, note });
	}

	// Working rows keep their original id so every op resolves against the
	// projection the extension saw.
	let mut rows: Vec<(Option<usize>, Message)> = messages
		.iter()
		.cloned()
		.enumerate()
		.map(|(seq, message)| (Some(seq), message))
		.collect();
	let bound = messages.len();
	let position =
		|rows: &[(Option<usize>, Message)], id: &JsonValue| -> Result<usize, ContextPatchError> {
			let seq = id
				.as_str()
				.and_then(|id| id.parse::<usize>().ok())
				.filter(|seq| *seq < bound)
				.ok_or_else(|| ContextPatchError::UnknownItem {
					id: Str::new(id.as_str().unwrap_or("")),
				})?;
			rows
				.iter()
				.position(|(row, _)| *row == Some(seq))
				.ok_or_else(|| ContextPatchError::UnknownItem { id: sf!("{seq}") })
		};
	let mut applied = 0;

	for op in prune {
		let ids = ids_of(op, "prune.ids")?;
		let keep_placeholder = op
			.get("keep_placeholder")
			.and_then(JsonValue::as_bool)
			.unwrap_or(true);
		let reason = op.get("reason").and_then(JsonValue::as_str).unwrap_or("");
		let mut first = None;
		for id in ids {
			let at = position(&rows, id)?;
			rows.remove(at);
			first.get_or_insert(at);
		}
		if let (true, Some(at)) = (keep_placeholder, first) {
			let text = if reason.is_empty() {
				Str::new_static("[context pruned]")
			} else {
				sf!("[context pruned: {reason}]")
			};
			rows.insert(at.min(rows.len()), (None, text_message(Role::User, text)));
		}
		applied += 1;
	}

	for op in drop_parts {
		let ids = ids_of(op, "drop_parts.ids")?;
		let reason = op.get("reason").and_then(JsonValue::as_str).unwrap_or("");
		for id in ids {
			let at = position(&rows, id)?;
			let (seq, message) = &rows[at];
			let text = if reason.is_empty() {
				Str::new_static("[content dropped from context]")
			} else {
				sf!("[content dropped from context: {reason}]")
			};
			let kept = message
				.content
				.iter()
				.filter(|part| matches!(part, ContentPart::ToolCall { .. }))
				.cloned()
				.chain(std::iter::once(ContentPart::Text { text, proof: None }))
				.collect::<Vec<_>>();
			let replaced = Message {
				role:    message.role,
				content: Arc::from(kept),
				name:    message.name.clone(),
			};
			rows[at] = (*seq, replaced);
		}
		applied += 1;
	}

	for op in replace {
		let ids = ids_of(op, "replace.ids")?;
		let parts = parts_of(op.get("parts"), "replace")?;
		let role = role_of(op.get("role"))?;
		let last_position = op
			.get("inherit_position")
			.and_then(JsonValue::as_str)
			.is_some_and(|value| value == "last");
		let mut positions = Vec::with_capacity(ids.len());
		for id in ids {
			positions.push(position(&rows, id)?);
		}
		positions.sort_unstable();
		positions.dedup();
		let at = if last_position {
			*positions.last().expect("ids nonempty")
		} else {
			positions[0]
		};
		for removed in positions.iter().rev() {
			rows.remove(*removed);
		}
		let at = if last_position {
			at.saturating_sub(positions.len().saturating_sub(1))
		} else {
			at
		};
		rows.insert(
			at.min(rows.len()),
			(None, Message { role, content: Arc::from(parts), name: None }),
		);
		applied += 1;
	}

	for op in insert {
		let parts = parts_of(op.get("parts"), "insert")?;
		let role = role_of(op.get("role"))?;
		let anchor = op
			.get("anchor")
			.ok_or(ContextPatchError::Malformed { field: "insert.anchor" })?;
		let relation = anchor
			.get("relation")
			.and_then(JsonValue::as_str)
			.ok_or(ContextPatchError::Malformed { field: "insert.anchor.relation" })?;
		let at = match relation {
			"head" => 0,
			"tail" => rows.len(),
			"before" | "after" => {
				let id = anchor
					.get("id")
					.ok_or(ContextPatchError::Malformed { field: "insert.anchor.id" })?;
				let at = position(&rows, id)?;
				if relation == "before" { at } else { at + 1 }
			},
			other => return Err(ContextPatchError::UnknownAnchor { relation: Str::new(other) }),
		};
		rows.insert(at, (None, Message { role, content: Arc::from(parts), name: None }));
		applied += 1;
	}

	for op in reorder {
		let ids = ids_of(op, "reorder.ids")?;
		let before = op
			.get("before")
			.ok_or(ContextPatchError::Malformed { field: "reorder.before" })?;
		let mut moving = Vec::with_capacity(ids.len());
		for id in ids {
			let at = position(&rows, id)?;
			moving.push(rows.remove(at));
		}
		let at = position(&rows, before)?;
		for (offset, row) in moving.into_iter().enumerate() {
			rows.insert(at + offset, row);
		}
		applied += 1;
	}

	*messages = rows.into_iter().map(|(_, message)| message).collect();
	Ok(ProjectionOutcome { applied, note })
}

fn ids_of<'a>(
	op: &'a JsonValue,
	field: &'static str,
) -> Result<&'a [JsonValue], ContextPatchError> {
	match op.get("ids") {
		Some(JsonValue::Array(ids)) if !ids.is_empty() => Ok(ids.as_slice()),
		_ => Err(ContextPatchError::Malformed { field }),
	}
}

fn role_of(value: Option<&JsonValue>) -> Result<Role, ContextPatchError> {
	match value.and_then(JsonValue::as_str).unwrap_or("user") {
		"user" => Ok(Role::User),
		"assistant" => Ok(Role::Assistant),
		"system" => Ok(Role::System),
		"developer" => Ok(Role::Developer),
		_ => Err(ContextPatchError::Malformed { field: "role" }),
	}
}

/// Decodes Python `Part`s (`TextPart {text}`, `JsonPart {json}`, `BlobPart
/// {blob, alt}`) into text content; blob parts contribute their alt text.
fn parts_of(
	value: Option<&JsonValue>,
	op: &'static str,
) -> Result<Vec<ContentPart>, ContextPatchError> {
	let Some(JsonValue::Array(parts)) = value else {
		return Err(ContextPatchError::EmptyParts { op });
	};
	let mut decoded = Vec::with_capacity(parts.len());
	for part in parts {
		let text = if let Some(text) = part.get("text").and_then(JsonValue::as_str) {
			Str::new(text)
		} else if let Some(json) = part.get("json") {
			match json {
				JsonValue::String(text) => Str::new(text.as_str()),
				JsonValue::Object(wrapped) => wrapped
					.get("$bytes")
					.and_then(JsonValue::as_str)
					.and_then(|encoded| omp_core::base64::decode(encoded).into_vec().ok())
					.and_then(|bytes| String::from_utf8(bytes).ok())
					.map_or_else(|| Str::new(json.to_string()), Str::new),
				other => Str::new(other.to_string()),
			}
		} else if let Some(alt) = part.get("alt").and_then(JsonValue::as_str) {
			Str::new(alt)
		} else {
			continue;
		};
		if !text.is_empty() {
			decoded.push(ContentPart::Text { text, proof: None });
		}
	}
	if decoded.is_empty() {
		return Err(ContextPatchError::EmptyParts { op });
	}
	Ok(decoded)
}

fn text_message(role: Role, text: Str) -> Message {
	Message { role, content: Arc::from([ContentPart::Text { text, proof: None }]), name: None }
}

/// Number of leading system/developer messages: the immutable prompt head.
#[must_use]
pub fn prompt_head_len(messages: &[Message]) -> usize {
	messages
		.iter()
		.take_while(|message| matches!(message.role, Role::System | Role::Developer))
		.count()
}

/// Estimated token count of the system prefix of `messages` (the leading
/// system/developer run), at the shared bytes-per-token estimate.
#[must_use]
pub fn prompt_head_tokens(messages: &[Message]) -> u64 {
	messages[..prompt_head_len(messages)]
		.iter()
		.flat_map(|message| message.content.iter())
		.map(|part| match part {
			ContentPart::Text { text, .. } | ContentPart::Reasoning { text, .. } => {
				u64::try_from(text.len()).unwrap_or(u64::MAX)
			},
			_ => 0,
		})
		.sum::<u64>()
		.div_ceil(BYTES_PER_TOKEN)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn user(text: &'static str) -> Message {
		text_message(Role::User, Str::new_static(text))
	}

	fn assistant(text: &'static str) -> Message {
		text_message(Role::Assistant, Str::new_static(text))
	}

	fn texts(messages: &[Message]) -> Vec<&str> {
		messages
			.iter()
			.map(|message| match message.content.first() {
				Some(ContentPart::Text { text, .. }) => text.as_str(),
				_ => "",
			})
			.collect()
	}

	#[test]
	fn view_numbers_messages_by_projection_sequence() {
		let facts = ContextFacts {
			model: Str::new_static("anthropic/claude"),
			context_window: 1000,
			..ContextFacts::default()
		};
		let view = context_view(&facts, &[user("a"), assistant("b")]);
		assert_eq!(view["provider"], "anthropic");
		assert_eq!(view["messages"][0]["id"], "0");
		assert_eq!(view["messages"][1]["id"], "1");
		assert_eq!(view["messages"][1]["role"], "assistant");
		assert_eq!(view["usage"]["context_window"], 1000);
		assert_eq!(view["usage"]["reserve_tokens"], 150);
	}

	#[test]
	fn empty_patch_applies_nothing() {
		let mut messages = vec![user("a"), assistant("b")];
		let outcome = apply_context_patch(&mut messages, &serde_json::json!({"note": "noop"}))
			.expect("empty patch");
		assert_eq!(outcome, ProjectionOutcome { applied: 0, note: Some(Str::new_static("noop")) });
		assert_eq!(texts(&messages), ["a", "b"]);
	}

	#[test]
	fn prune_replace_insert_and_reorder_resolve_original_ids() {
		let mut messages = vec![user("a"), assistant("b"), user("c"), assistant("d")];
		let patch = serde_json::json!({
			"prune": [{"ids": ["1"], "reason": "stale", "keep_placeholder": true}],
			"replace": [{"ids": ["2"], "parts": [{"text": "C!"}], "role": "user"}],
			"insert": [{"parts": [{"text": "note"}], "anchor": {"relation": "before", "id": "3"}, "role": "system"}],
			"reorder": [{"ids": ["3"], "before": "0"}],
		});
		let outcome = apply_context_patch(&mut messages, &patch).expect("patch");
		assert_eq!(outcome.applied, 4);
		assert_eq!(texts(&messages), ["d", "a", "[context pruned: stale]", "C!", "note"]);
		assert_eq!(messages[4].role, Role::System);
	}

	#[test]
	fn drop_parts_keeps_tool_calls_and_replaces_bodies() {
		let mut messages = vec![Message {
			role:    Role::Assistant,
			content: Arc::from([
				ContentPart::Text { text: Str::new_static("thinking aloud"), proof: None },
				ContentPart::ToolCall {
					call:      omp_ai::ToolCallId::from("call-1"),
					name:      Str::new_static("read"),
					arguments: omp_ai::OpaqueJson::new(serde_json::json!({})),
					proof:     None,
				},
			]),
			name:    None,
		}];
		apply_context_patch(
			&mut messages,
			&serde_json::json!({
				"drop_parts": [{"ids": ["0"], "reason": "large"}],
			}),
		)
		.expect("drop parts");
		assert!(matches!(messages[0].content[0], ContentPart::ToolCall { .. }));
		assert!(matches!(
			&messages[0].content[1],
			ContentPart::Text { text, .. } if text.as_str() == "[content dropped from context: large]"
		));
	}

	#[test]
	fn invalid_patch_is_rejected_atomically() {
		let mut messages = vec![user("a"), assistant("b")];
		let patch = serde_json::json!({
			"prune": [{"ids": ["0"]}],
			"reorder": [{"ids": ["1"], "before": "9"}],
		});
		assert_eq!(
			apply_context_patch(&mut messages, &patch),
			Err(ContextPatchError::UnknownItem { id: Str::new_static("9") })
		);
		assert_eq!(texts(&messages), ["a", "b"]);
		assert_eq!(
			apply_context_patch(
				&mut messages,
				&serde_json::json!({"insert": [{"parts": [], "anchor": {"relation": "tail"}}]})
			),
			Err(ContextPatchError::EmptyParts { op: "insert" })
		);
		assert_eq!(
			apply_context_patch(
				&mut messages,
				&serde_json::json!({"insert": [{"parts": [{"text": "x"}], "anchor": {"relation": "middle"}}]})
			),
			Err(ContextPatchError::UnknownAnchor { relation: Str::new_static("middle") })
		);
	}
}
