//! Pure inference-thread projection from the authoritative DOM.

use std::{
	collections::{BTreeMap, BTreeSet},
	fmt::Write as _,
	str,
	str::FromStr,
};

use bytes::Bytes;
use omp_core::{Str, encoding::hex};
use omp_dom::{Dom, Handle, KnownTag, Node, PropId, PropKey, Tag, Value};
use omp_journal::{
	EntryId,
	data::{Attachment, FileMentions, MentionedFile, MentionedFileState},
};
use omp_proto::{
	inference::v1 as inference,
	thread::v1::{self as thread, Item, item, part},
};
use omp_tool::{
	CapsBase, Part as ToolPart, ProjectedCall, PromptCaps, RecordedCallOwned,
	Registry as ToolRegistry, Rev, TOOL_REV_PROP, ToolIdentity,
};
use thiserror::Error;

/// Durable property carrying an explicit provider-session reset request.
pub const PROVIDER_RESET_PROP: &str = "omp/session-provider-reset";

/// Structural tag for one provider-ordered assistant text or thinking block.
///
/// The child carries [`PropId::Kind`] (`text` or `thinking`),
/// [`PROVIDER_BLOCK_INDEX_PROP`], and a streamed [`PropId::Text`].
pub const ASSISTANT_CONTENT_TAG: &str = "assistant-content";

/// Provider content-array index shared by assistant content and artifact
/// children.
pub const PROVIDER_BLOCK_INDEX_PROP: &str = "index";

/// Prop marking a `<user>` turn child that carries a typed auto-read
/// [`omp_journal::data::FileMentions`] payload.
pub const FILE_MENTION_PROP: &str = "file_mention";

/// Prop marking a `<user>` turn child that arrived as steering at a safe point.
pub const STEERING_PROP: &str = "steering";

/// Notice prepended to every steering user message at projection time. The
/// journaled text stays raw; the wrapper is a pure function of the element so
/// the wire bytes never change once the reply buries the interjection.
pub const STEERING_ENVELOPE: &str = "<system-notice>\nUser interjection during work: priority; \
                                     supersedes conflicting prior instructions. Re-read; ensure \
                                     current work reflects user intent.\n</system-notice>\n";

/// Stable diagnostics for provider turns that settle without usable output.
pub mod empty_stop {
	/// Provider returned no final output.
	pub const NO_FINAL_OUTPUT: &str = "empty_stop.no_final_output";
	/// Provider returned no content.
	pub const EMPTY: &str = "empty_stop.empty";
	/// Provider billed output tokens but returned no usable block.
	pub const BILLED_OUTPUT: &str = "empty_stop.billed_output";
}

/// Historical protobuf projection failure.
#[derive(Debug, Error)]
pub enum ProjectionError {
	/// A committed tool revision property had the wrong shape.
	#[error("omp/tool-rev must be a string")]
	RevisionType,
	/// A committed tool revision string was malformed.
	#[error("omp/tool-rev contains an invalid revision")]
	InvalidRevision,
	/// Structured tool call-outcome JSON was invalid.
	#[error("invalid tool call-outcome JSON")]
	OutcomeJson(#[from] serde_json::Error),
	/// A model-facing JSON part was not UTF-8.
	#[error("tool JSON part is not UTF-8")]
	PartUtf8(#[from] str::Utf8Error),
	/// A model-facing blob hash was not hexadecimal.
	#[error("tool blob hash is not valid hexadecimal")]
	BlobHash,
	/// The live tool could not deterministically render a lifted verdict.
	#[error("tool projection failed")]
	Tool(#[from] omp_tool::RegistryError),
}

/// Re-expresses historical tool calls through complete live revision lifts.
///
/// Calls without a complete lift path are retained exactly. Calls already at
/// the live revision preserve their original bytes and field presence.
pub fn project_thread_history(
	source: &thread::Thread,
	tool_registry: &ToolRegistry,
	caps: &CapsBase,
) -> Result<thread::Thread, ProjectionError> {
	let mut projected = source.clone();
	for call_index in 0..projected.items.len() {
		let Some(item::Kind::ToolCall(call)) = projected.items[call_index].kind.as_ref() else {
			continue;
		};
		let Some(rev) = tool_revision(&projected.items[call_index])? else {
			continue;
		};
		let call_id = call.id.clone();
		let name = call.name.clone();
		let Some(live_identity) = tool_registry.resolved_identity(&name) else {
			continue;
		};
		if live_identity.rev == rev {
			continue;
		}
		let Some(result_index) = projected
			.items
			.iter()
			.enumerate()
			.skip(call_index + 1)
			.find_map(|(index, item)| {
				matches!(
					item.kind.as_ref(),
					Some(item::Kind::ToolResult(result))
						if result.call_id == call_id && result.details.is_some()
				)
				.then_some(index)
			})
		else {
			continue;
		};
		let Some(item::Kind::ToolResult(result)) = projected.items[result_index].kind.as_ref() else {
			unreachable!("result index came from tool-result items")
		};
		let Some(verdict) = proto_json_bytes(
			result
				.details
				.as_ref()
				.expect("selected result has structured details"),
		) else {
			continue;
		};
		let original = RecordedCallOwned {
			identity: ToolIdentity { name: Str::new(&name), rev: rev.clone() },
			raw_args: Bytes::copy_from_slice(&call.args_json),
			verdict,
		};
		let ProjectedCall::Live(live) = tool_registry.project(original) else {
			continue;
		};
		let prompt_caps = PromptCaps::for_tool(*caps, &live.identity.rev);
		let rendered = tool_registry.project_verdict(
			&live.identity,
			&live.verdict,
			result.useless.unwrap_or(false),
			&prompt_caps,
		)?;
		let lifted_details =
			json_proto_value(serde_json::from_slice::<serde_json::Value>(&live.verdict)?);
		let lifted_parts = history_tool_parts(&rendered.parts)?;

		let Some(item::Kind::ToolCall(call)) = projected.items[call_index].kind.as_mut() else {
			unreachable!("call index came from tool-call items")
		};
		call.args_json = live.raw_args.clone();
		projected.items[call_index]
			.props
			.get_or_insert_default()
			.fields
			.insert(TOOL_REV_PROP.to_owned(), inference::Value {
				kind: Some(inference::value::Kind::String(live.identity.rev.to_string())),
			});
		projected.items[result_index]
			.props
			.get_or_insert_default()
			.fields
			.insert(TOOL_REV_PROP.to_owned(), inference::Value {
				kind: Some(inference::value::Kind::String(live.identity.rev.to_string())),
			});
		let Some(item::Kind::ToolResult(result)) = projected.items[result_index].kind.as_mut() else {
			unreachable!("result index came from tool-result items")
		};
		result.details = Some(lifted_details);
		result.parts = lifted_parts;
		result.is_error = rendered.is_error;
		result.useless = Some(rendered.useless);
	}
	Ok(projected)
}

fn tool_revision(value: &Item) -> Result<Option<Rev>, ProjectionError> {
	let Some(value) = value
		.props
		.as_ref()
		.and_then(|props| props.fields.get(TOOL_REV_PROP))
	else {
		return Ok(None);
	};
	let Some(inference::value::Kind::String(value)) = value.kind.as_ref() else {
		return Err(ProjectionError::RevisionType);
	};
	value
		.parse::<Rev>()
		.map(Some)
		.map_err(|_| ProjectionError::InvalidRevision)
}

fn proto_json_bytes(value: &inference::Value) -> Option<Bytes> {
	serde_json::to_vec(&proto_json_value(value)?)
		.ok()
		.map(Bytes::from)
}

fn proto_json_value(value: &inference::Value) -> Option<serde_json::Value> {
	match value.kind.as_ref()? {
		inference::value::Kind::Null(_) => Some(serde_json::Value::Null),
		inference::value::Kind::Int(value) => Some((*value).into()),
		inference::value::Kind::Uint(value) => Some((*value).into()),
		inference::value::Kind::Double(value) => {
			serde_json::Number::from_f64(*value).map(serde_json::Value::Number)
		},
		inference::value::Kind::Bool(value) => Some((*value).into()),
		inference::value::Kind::String(value) => Some(value.clone().into()),
		inference::value::Kind::List(values) => values
			.values
			.iter()
			.map(proto_json_value)
			.collect::<Option<Vec<_>>>()
			.map(serde_json::Value::Array),
		inference::value::Kind::Map(fields) => fields
			.fields
			.iter()
			.map(|(key, value)| Some((key.clone(), proto_json_value(value)?)))
			.collect::<Option<serde_json::Map<_, _>>>()
			.map(serde_json::Value::Object),
	}
}

fn json_proto_value(value: serde_json::Value) -> inference::Value {
	let kind = match value {
		serde_json::Value::Null => inference::value::Kind::Null(true),
		serde_json::Value::Bool(value) => inference::value::Kind::Bool(value),
		serde_json::Value::Number(value) => {
			if let Some(value) = value.as_i64() {
				inference::value::Kind::Int(value)
			} else if let Some(value) = value.as_u64() {
				inference::value::Kind::Uint(value)
			} else {
				inference::value::Kind::Double(value.as_f64().expect("JSON numbers are finite"))
			}
		},
		serde_json::Value::String(value) => inference::value::Kind::String(value),
		serde_json::Value::Array(values) => inference::value::Kind::List(inference::ValueList {
			values: values.into_iter().map(json_proto_value).collect(),
		}),
		serde_json::Value::Object(fields) => inference::value::Kind::Map(inference::ValueMap {
			fields: fields
				.into_iter()
				.map(|(key, value)| (key, json_proto_value(value)))
				.collect::<BTreeMap<_, _>>(),
		}),
	};
	inference::Value { kind: Some(kind) }
}

fn history_tool_parts(parts: &[ToolPart]) -> Result<Vec<thread::Part>, ProjectionError> {
	let mut projected = Vec::with_capacity(parts.len());
	for value in parts {
		match value {
			ToolPart::Text { text } => {
				projected.push(thread::Part { kind: Some(part::Kind::Text(text.as_str().to_owned())) });
			},
			ToolPart::Json { json } => projected
				.push(thread::Part { kind: Some(part::Kind::Text(str::from_utf8(json)?.to_owned())) }),
			ToolPart::Blob { blob, alt } => {
				if let Some(alt) = alt {
					projected
						.push(thread::Part { kind: Some(part::Kind::Text(alt.as_str().to_owned())) });
				}
				let hash = hex::decode(blob.hash.as_str())
					.into_vec()
					.map_err(|_| ProjectionError::BlobHash)?;
				if hash.len() != 32 {
					return Err(ProjectionError::BlobHash);
				}
				projected.push(thread::Part {
					kind: Some(part::Kind::Blob(thread::Blob {
						hash: hash.into(),
						mime: blob.media_type.as_str().to_owned(),
						size: blob.byte_len,
						..Default::default()
					})),
				});
			},
		}
	}
	Ok(projected)
}

/// Projects the selected session body into canonical inference thread items.
///
/// The function reads only the DOM. If a compaction marker exists, older
/// turns are omitted and its content-addressed summary plus ordered
/// snapcompact frame references are prepended as a synthetic user message.
#[must_use]
pub fn project_thread(dom: &Dom) -> Vec<Item> {
	let (boundary, compaction) = newest_compaction(dom);
	let mut items = Vec::new();
	if let Some(compaction) = compaction
		&& let Some(summary) = prop_text(compaction, PropId::Summary)
	{
		items.push(compaction_message_item(summary, &compaction_frames(compaction)));
	}
	project_window(dom, Window { after: boundary, through: None }, &mut items);
	items
}

/// Projects only the body elements journaled at or before `through` (and
/// after the newest compaction boundary), without the synthetic summary:
/// the material a compaction summarises, never the kept tail.
#[must_use]
pub fn project_thread_through(dom: &Dom, through: EntryId) -> Vec<Item> {
	let (boundary, _) = newest_compaction(dom);
	let mut items = Vec::new();
	project_window(dom, Window { after: boundary, through: Some(through) }, &mut items);
	items
}

/// Journal-entry window a projection admits: elements after `after` (the
/// newest compaction boundary) and, when set, at or before `through`.
#[derive(Clone, Copy)]
struct Window {
	after:   Option<EntryId>,
	through: Option<EntryId>,
}

fn project_window(dom: &Dom, window: Window, items: &mut Vec<Item>) {
	for turn in dom.children(dom.body()) {
		if !is_tag(dom, *turn, KnownTag::Turn) {
			continue;
		}
		// A tool element before any message in its turn is a local run (the
		// host's `!`/`$` prefix modes): no assistant issued it, so the model
		// sees what ran as a user message.
		let mut local = true;
		let children = dom.children(*turn);
		let mut receipts = BTreeMap::new();
		let mut awaiting_receipt = None;
		// Assistants that issued at least one tool call stay in the projection
		// even without text. An assistant with nothing at all is omitted with
		// its receipt.
		let mut issuing = BTreeSet::new();
		let mut last_assistant = None;
		for child in children {
			let Some(node) = dom.get(*child) else {
				continue;
			};
			if !element_in_window(node, window) {
				continue;
			}
			match &node.tag {
				Tag::Known(KnownTag::Assistant) => {
					awaiting_receipt = Some(*child);
					last_assistant = Some(*child);
				},
				Tag::Known(KnownTag::User | KnownTag::Developer) => last_assistant = None,
				Tag::Known(KnownTag::Usage) => {
					if let Some(assistant) = awaiting_receipt.take()
						&& let Some(usage) = usage_of(node)
					{
						receipts.insert(assistant, usage);
					}
				},
				Tag::Custom(_) => {
					if let Some(assistant) = last_assistant {
						issuing.insert(assistant);
					}
				},
				_ => {},
			}
		}
		for child in children {
			let Some(node) = dom.get(*child) else {
				continue;
			};
			if matches!(
				node.tag,
				Tag::Known(KnownTag::User | KnownTag::Developer | KnownTag::Assistant)
			) {
				local = false;
			}
			if !element_in_window(node, window) {
				continue;
			}
			match &node.tag {
				Tag::Known(KnownTag::User) => {
					if let Some(mentions) = file_mentions(node) {
						project_file_mentions(&mentions, items);
					} else {
						project_message(node, thread::Role::User, items);
					}
				},
				Tag::Known(KnownTag::Developer) => {
					project_message(node, thread::Role::System, items);
				},
				Tag::Known(KnownTag::Assistant) => {
					// Receipts are consumed one-for-one in ordered turn
					// sequence; no completion can reuse another's accounting.
					project_assistant(
						dom,
						*child,
						node,
						receipts.remove(child),
						issuing.contains(child),
						items,
					);
				},
				Tag::Custom(name) if local => {
					project_local_tool(dom, *child, name.as_str(), node, items);
				},
				Tag::Custom(name) => project_tool(dom, *child, name.as_str(), node, items),
				_ => {},
			}
		}
	}
}

/// Prop a local run carries when the host excludes it from the model's context
/// (`!!` / `$$`).
pub const LOCAL_CONTEXT_PROP: &str = "context";
/// [`LOCAL_CONTEXT_PROP`] value hiding the run.
pub const LOCAL_CONTEXT_EXCLUDED: &str = "excluded";

/// Projects a host-run tool element as a user message. A run still in flight
/// or one excluded from context contributes nothing.
fn project_local_tool(dom: &Dom, handle: Handle, name: &str, node: &Node, items: &mut Vec<Item>) {
	let excluded = node
		.prop(&PropKey::Custom(Str::new_static(LOCAL_CONTEXT_PROP)))
		.and_then(Value::as_str)
		== Some(LOCAL_CONTEXT_EXCLUDED);
	let status = prop_text(node, PropId::Status).unwrap_or("running");
	if excluded || matches!(status, "arguments" | "running") {
		return;
	}
	let args = child(dom, handle, KnownTag::Input)
		.and_then(|handle| dom.get(handle))
		.and_then(node_text)
		.and_then(|input| serde_json::from_str::<serde_json::Value>(input).ok())
		.unwrap_or(serde_json::Value::Null);
	let result_node = terminal_node(dom, handle, status);
	let mut output = String::new();
	let parts = result_node
		.and_then(projected_tool_parts)
		.unwrap_or_else(|| {
			let result = result_node.and_then(node_text).unwrap_or_default();
			vec![thread::Part { kind: Some(part::Kind::Text(result.to_owned())) }]
		});
	for part in parts {
		if let Some(part::Kind::Text(text)) = part.kind {
			if !output.is_empty() {
				output.push('\n');
			}
			output.push_str(&text);
		}
	}
	let output = output.trim_end();
	let mut text = match name {
		"bash" => format!("Ran `{}`\n", args["command"].as_str().unwrap_or_default()),
		"eval" => {
			format!("Ran Python:\n```python\n{}\n```\n", args["code"].as_str().unwrap_or_default())
		},
		other => format!("Ran `{other}` with `{args}`\n"),
	};
	if output.is_empty() {
		text.push_str("(no output)");
	} else {
		if name != "bash" {
			text.push_str("Output:\n");
		}
		text.push_str("```\n");
		text.push_str(output);
		text.push_str("\n```");
	}
	match status {
		"cancelled" | "aborted" => text.push_str(if name == "bash" {
			"\n\n(command cancelled)"
		} else {
			"\n\n(execution cancelled)"
		}),
		"error" => text.push_str(if name == "bash" {
			"\n\nCommand failed"
		} else {
			"\n\nExecution failed"
		}),
		_ => {},
	}
	items.push(message_item(thread::Role::User, &text, None, false));
}

/// Decodes a typed auto-read file-mention payload from its journal-derived
/// `<user>` element.
#[must_use]
pub fn file_mentions(node: &Node) -> Option<FileMentions> {
	if node.tag != Tag::Known(KnownTag::User)
		|| node.prop(&PropKey::Custom(Str::new_static(FILE_MENTION_PROP))) != Some(&Value::Bool(true))
	{
		return None;
	}
	let Value::Json(data) = node.prop(&PropId::Data.into())? else {
		return None;
	};
	serde_json::from_str(data.get()).ok()
}

fn append_mentioned_file(out: &mut String, file: &MentionedFile) {
	if !out.is_empty() {
		out.push('\n');
	}
	let _ = write!(out, "<file path=\"{}\">\n{}\n</file>", file.path, file.content);
}

fn project_file_mentions(payload: &FileMentions, items: &mut Vec<Item>) {
	let mut text = String::new();
	let mut image_text = String::new();
	let mut images = Vec::new();
	for file in &payload.files {
		if let MentionedFileState::Image { attachment } = &file.state {
			append_mentioned_file(&mut image_text, file);
			images.push(attachment);
		} else {
			append_mentioned_file(&mut text, file);
		}
	}
	if !text.is_empty() {
		items.push(message_item(thread::Role::System, &text, None, false));
	}
	if image_text.is_empty() {
		return;
	}
	let mut parts = Vec::with_capacity(images.len() + 1);
	parts.push(thread::Part { kind: Some(part::Kind::Text(image_text)) });
	parts.extend(images.into_iter().map(|attachment| thread::Part {
		kind: Some(part::Kind::Blob(thread::Blob {
			hash: attachment.blob.hash.as_bytes().to_vec().into(),
			mime: attachment.mime.as_str().to_owned(),
			size: attachment.blob.size,
			..Default::default()
		})),
	}));
	items.push(Item {
		seq:           0,
		created_at_ms: 0,
		kind:          Some(item::Kind::Message(thread::Message {
			role: thread::Role::User as i32,
			parts,
			synthetic: Some(false),
			..Default::default()
		})),
		props:         None,
	});
}

fn is_steering(node: &Node) -> bool {
	node.prop(&PropKey::Custom(Str::new_static(STEERING_PROP))) == Some(&Value::Bool(true))
}

fn project_message(node: &Node, role: thread::Role, items: &mut Vec<Item>) {
	let mut parts = Vec::new();
	if let Some(text) = node
		.content
		.as_deref()
		.or_else(|| prop_text(node, PropId::Text))
	{
		// An empty steering interjection is sent as-is.
		let text = if is_steering(node) && !text.is_empty() {
			let mut wrapped = String::with_capacity(STEERING_ENVELOPE.len() + text.len());
			wrapped.push_str(STEERING_ENVELOPE);
			wrapped.push_str(text);
			wrapped
		} else {
			text.to_owned()
		};
		parts.push(thread::Part { kind: Some(part::Kind::Text(text)) });
	}
	// Journaled attachments become typed media parts: the reference and its MIME
	// are the projection's whole output; the kernel resolves the bytes at
	// request time so this stays a pure function of the tree.
	if let Some(Value::Json(raw)) = node.prop(&PropKey::from(PropId::Data))
		&& let Ok(attachments) = serde_json::from_str::<Vec<Attachment>>(raw.get())
	{
		parts.extend(attachments.into_iter().map(|attachment| thread::Part {
			kind: Some(part::Kind::Blob(thread::Blob {
				hash: attachment.blob.hash.as_bytes().to_vec().into(),
				mime: attachment.mime.as_str().to_owned(),
				size: attachment.blob.size,
				..Default::default()
			})),
		}));
	}
	items.push(Item {
		seq:           0,
		created_at_ms: 0,
		kind:          Some(item::Kind::Message(thread::Message {
			role: role as i32,
			parts,
			..Default::default()
		})),
		props:         None,
	});
}

fn project_assistant(
	dom: &Dom,
	handle: Handle,
	node: &Node,
	usage: Option<inference::Usage>,
	issued_calls: bool,
	items: &mut Vec<Item>,
) {
	let parts = assistant_parts(dom, handle, node);
	// An assistant that produced neither content nor a call is omitted before
	// retrying; providers reject empty assistant content and its receipt belongs
	// to no surviving message.
	if parts.is_empty() && !issued_calls {
		return;
	}
	items.push(Item {
		seq:           0,
		created_at_ms: 0,
		kind:          Some(item::Kind::Message(thread::Message {
			role: thread::Role::Assistant as i32,
			parts,
			usage,
			..Default::default()
		})),
		props:         None,
	});
}

/// Projects assistant content-array children in provider order. Legacy
/// sessions without `<assistant-content>` children retain the former
/// thinking → text → artifact projection.
fn assistant_parts(dom: &Dom, assistant: Handle, node: &Node) -> Vec<thread::Part> {
	let children = dom.children(assistant);
	let ordered = children
		.iter()
		.any(|handle| dom.get(*handle).is_some_and(is_assistant_content));
	let mut parts = Vec::new();
	if !ordered {
		if let Some(thinking) = prop_text(node, PropId::Thinking).filter(|text| !text.is_empty()) {
			parts.push(thinking_part(thinking));
		}
		if let Some(text) = node
			.content
			.as_deref()
			.or_else(|| prop_text(node, PropId::Text))
			.filter(|text| !text.is_empty())
		{
			parts.push(text_part(text));
		}
	}
	let mut content = children
		.iter()
		.enumerate()
		.filter_map(|(position, handle)| {
			let node = dom.get(*handle)?;
			(ordered && is_assistant_content(node) || is_artifact(node)).then_some((
				provider_block_index(node),
				position,
				*handle,
				node,
			))
		})
		.collect::<Vec<_>>();
	content.sort_by_key(|(index, position, ..)| (*index, *position));
	for (_, _, handle, child) in content {
		if is_assistant_content(child) {
			let Some(text) = dom
				.stream_text(handle, &PropId::Text.into())
				.or_else(|| prop_text(child, PropId::Text))
				.filter(|text| !text.is_empty())
			else {
				continue;
			};
			match prop_text(child, PropId::Kind) {
				Some("thinking") => parts.push(thinking_part(text)),
				Some("text") => parts.push(text_part(text)),
				_ => {},
			}
		} else if let Some(part) = artifact_part(child) {
			parts.push(part);
		}
	}
	parts
}

fn is_assistant_content(node: &Node) -> bool {
	matches!(&node.tag, Tag::Custom(tag) if tag.as_str() == ASSISTANT_CONTENT_TAG)
}

fn is_artifact(node: &Node) -> bool {
	matches!(&node.tag, Tag::Custom(tag) if tag.as_str() == "artifact")
}

fn provider_block_index(node: &Node) -> i64 {
	node
		.prop(&PropKey::Custom(Str::new_static(PROVIDER_BLOCK_INDEX_PROP)))
		.and_then(|value| match value {
			Value::Int(index) => Some(*index),
			_ => None,
		})
		.unwrap_or(i64::MAX)
}

fn text_part(text: &str) -> thread::Part {
	thread::Part { kind: Some(part::Kind::Text(text.to_owned())) }
}

fn thinking_part(text: &str) -> thread::Part {
	thread::Part {
		kind: Some(part::Kind::Thinking(thread::Thinking {
			text: text.to_owned(),
			..Default::default()
		})),
	}
}

fn artifact_part(artifact: &Node) -> Option<thread::Part> {
	let uri = prop_text(artifact, PropId::Blob)?;
	let mime = prop_text(artifact, PropId::Mime).unwrap_or("application/octet-stream");
	let size = artifact
		.prop(&PropKey::Custom(Str::new_static("size")))
		.and_then(|value| match value {
			Value::Int(value) => u64::try_from(*value).ok(),
			_ => None,
		})
		.unwrap_or_default();
	let Some(encoded) = uri.strip_prefix("artifact://sha256/") else {
		return Some(text_part(uri));
	};
	let Ok(hash) = hex::decode(encoded).into_vec() else {
		return Some(text_part(uri));
	};
	if hash.len() != 32 {
		return Some(text_part(uri));
	}
	Some(thread::Part {
		kind: Some(part::Kind::Blob(thread::Blob {
			hash: hash.into(),
			mime: mime.to_owned(),
			size,
			..Default::default()
		})),
	})
}

fn project_tool(dom: &Dom, handle: Handle, name: &str, node: &Node, items: &mut Vec<Item>) {
	let id = prop_text(node, PropId::Id).unwrap_or_default().to_owned();
	let status = prop_text(node, PropId::Status).unwrap_or("running");
	// A live in-flight call is not history yet. Omit it until the writable
	// controller journals its terminal state during process-disappearance
	// recovery. This defensive path keeps any
	// direct DOM projection acceptable to providers that require every call
	// to have a matching result without inventing lifecycle state.
	if matches!(status, "arguments" | "running") {
		return;
	}
	let input = child(dom, handle, KnownTag::Input)
		.and_then(|handle| dom.get(handle))
		.and_then(node_text)
		.unwrap_or_default();
	items.push(Item {
		seq:           0,
		created_at_ms: 0,
		kind:          Some(item::Kind::ToolCall(thread::ToolCall {
			id: id.clone(),
			name: name.to_owned(),
			args_json: input.as_bytes().to_vec().into(),
			intent: prop_text(node, PropId::I).map(str::to_owned),
			..Default::default()
		})),
		props:         None,
	});
	let result_node = terminal_node(dom, handle, status);
	let mut parts = result_node
		.and_then(projected_tool_parts)
		.unwrap_or_else(|| {
			let result = result_node.and_then(node_text).unwrap_or_default();
			vec![thread::Part { kind: Some(part::Kind::Text(result.to_owned())) }]
		});
	// Every non-terminal `<diag>` reaches the model as one uniform trailing
	// part (ADR 0008/0009): never interpolated into the result body, never
	// dropped on the floor.
	parts.extend(
		dom.children(handle)
			.iter()
			.filter_map(|child| dom.get(*child))
			.filter(|node| {
				node.tag == Tag::Known(KnownTag::Diag)
					&& !result_node.is_some_and(|terminal| std::ptr::eq(terminal, *node))
			})
			.map(|node| thread::Part { kind: Some(part::Kind::Text(render_diag(node))) }),
	);
	items.push(Item {
		seq:           0,
		created_at_ms: 0,
		kind:          Some(item::Kind::ToolResult(thread::ToolResult {
			call_id: id,
			name: name.to_owned(),
			is_error: status == "error",
			parts,
			attribution: thread::tool_result::Attribution::Agent as i32,
			..Default::default()
		})),
		props:         None,
	});
}

/// The child carrying a settled call's model-facing terminal: `<result>` for
/// success, the `<diag>` carrying the fault for an error (a tool's earlier
/// warnings are separate diag children and never the terminal).
fn terminal_node<'a>(dom: &'a Dom, call: Handle, status: &str) -> Option<&'a Node> {
	if status != "error" {
		return child(dom, call, KnownTag::Result).and_then(|handle| dom.get(handle));
	}
	let diags = dom
		.children(call)
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.filter(|node| node.tag == Tag::Known(KnownTag::Diag))
		.collect::<Vec<_>>();
	diags
		.iter()
		.rev()
		.find(|node| node.prop(&PropKey::from(PropId::Fault)).is_some())
		.or_else(|| diags.first())
		.copied()
}

/// Model-facing rendering of one `<diag>`: fixed attribute vocabulary so the
/// model learns a single notice shape across every tool.
fn render_diag(node: &Node) -> String {
	let mut text = String::from("<diag");
	for prop in [PropId::Severity, PropId::Kind, PropId::Continuation, PropId::Recovery] {
		if let Some(value) = prop_text(node, prop) {
			let name = match prop {
				PropId::Recovery => "artifact",
				other => <&'static str>::from(other),
			};
			let _ = write!(text, " {name}=\"{value}\"");
		}
	}
	if let Some(Value::Int(count)) = node.prop(&PropKey::from(PropId::Omitted)) {
		let _ = write!(text, " omitted=\"{count}");
		if let Some(unit) = prop_text(node, PropId::Unit) {
			let _ = write!(text, " {unit}");
		}
		text.push('"');
	}
	text.push('>');
	text.push_str(prop_text(node, PropId::Text).unwrap_or_default());
	text.push_str("</diag>");
	text
}

fn projected_tool_parts(node: &Node) -> Option<Vec<thread::Part>> {
	let Value::Json(raw) = node.prop(&PropKey::from(PropId::Data))? else {
		return None;
	};
	let parts: Vec<ToolPart> = serde_json::from_str(raw.get()).ok()?;
	let mut projected = Vec::with_capacity(parts.len());
	for part in parts {
		match part {
			ToolPart::Text { text } => {
				projected.push(thread::Part { kind: Some(part::Kind::Text(text.as_str().to_owned())) });
			},
			ToolPart::Json { json } => projected.push(thread::Part {
				kind: Some(part::Kind::Text(std::str::from_utf8(&json).ok()?.to_owned())),
			}),
			ToolPart::Blob { blob, alt } => {
				if let Some(alt) = alt {
					projected
						.push(thread::Part { kind: Some(part::Kind::Text(alt.as_str().to_owned())) });
				}
				let hash = hex::decode(blob.hash.as_str()).into_vec().ok()?;
				if hash.len() != 32 {
					return None;
				}
				projected.push(thread::Part {
					kind: Some(part::Kind::Blob(thread::Blob {
						hash: hash.into(),
						mime: blob.media_type.as_str().to_owned(),
						size: blob.byte_len,
						..Default::default()
					})),
				});
			},
		}
	}
	Some(projected)
}

/// Ordered snapcompact frame references materialized on a `<compaction>`.
///
/// Invalid extension-authored JSON projects as no frames; journal-authored
/// compactions always carry the typed [`Attachment`] encoding.
#[must_use]
pub fn compaction_frames(node: &Node) -> Vec<Attachment> {
	let Some(Value::Json(raw)) = node.prop(&PropKey::from(PropId::Frames)) else {
		return Vec::new();
	};
	serde_json::from_str(raw.get()).unwrap_or_default()
}

/// Number of snapcompact frames exposed by a `<compaction>`.
#[must_use]
pub fn compaction_frame_count(node: &Node) -> usize {
	node
		.prop(&PropKey::from(PropId::FrameCount))
		.and_then(|value| match value {
			Value::Int(count) => usize::try_from(*count).ok(),
			_ => None,
		})
		.unwrap_or_else(|| compaction_frames(node).len())
}

fn compaction_message_item(summary: &str, frames: &[Attachment]) -> Item {
	let mut parts = Vec::with_capacity(frames.len().saturating_add(1));
	parts.push(thread::Part { kind: Some(part::Kind::Text(summary.to_owned())) });
	parts.extend(frames.iter().map(|frame| thread::Part {
		kind: Some(part::Kind::Blob(thread::Blob {
			hash: frame.blob.hash.as_bytes().to_vec().into(),
			mime: frame.mime.as_str().to_owned(),
			size: frame.blob.size,
			..Default::default()
		})),
	}));
	Item {
		seq:           0,
		created_at_ms: 0,
		kind:          Some(item::Kind::Message(thread::Message {
			role: thread::Role::User as i32,
			parts,
			synthetic: Some(true),
			..Default::default()
		})),
		props:         None,
	}
}

fn message_item(
	role: thread::Role,
	text: &str,
	usage: Option<inference::Usage>,
	synthetic: bool,
) -> Item {
	Item {
		seq:           0,
		created_at_ms: 0,
		kind:          Some(item::Kind::Message(thread::Message {
			role: role as i32,
			parts: vec![thread::Part { kind: Some(part::Kind::Text(text.to_owned())) }],
			synthetic: Some(synthetic),
			usage,
			..Default::default()
		})),
		props:         None,
	}
}

fn newest_compaction(dom: &Dom) -> (Option<EntryId>, Option<&Node>) {
	let mut result = (None, None);
	for handle in dom.children(dom.meta()) {
		let Some(node) = dom.get(*handle) else {
			continue;
		};
		if node.tag.as_str() != "compaction" {
			continue;
		}
		let boundary =
			prop_text(node, PropId::Boundary).and_then(|value| EntryId::from_str(value).ok());
		result = (boundary, Some(node));
	}
	result
}

fn element_in_window(node: &Node, window: Window) -> bool {
	if window.after.is_none() && window.through.is_none() {
		return true;
	}
	prop_text(node, PropId::Order)
		.or_else(|| prop_text(node, PropId::Id))
		.or_else(|| prop_text(node, PropId::Cause))
		.and_then(|id| EntryId::from_str(id).ok())
		.is_some_and(|id| {
			window.after.is_none_or(|after| id > after)
				&& window.through.is_none_or(|through| id <= through)
		})
}

fn usage_of(usage: &Node) -> Option<inference::Usage> {
	let input_tokens = prop_u64(usage, PropId::TokensIn).unwrap_or_default();
	let output_tokens = prop_u64(usage, PropId::TokensOut).unwrap_or_default();
	Some(inference::Usage {
		input_tokens,
		output_tokens,
		total_tokens: Some(input_tokens.saturating_add(output_tokens)),
		..Default::default()
	})
}

fn child(dom: &Dom, parent: Handle, tag: KnownTag) -> Option<Handle> {
	dom.children(parent)
		.iter()
		.copied()
		.find(|handle| is_tag(dom, *handle, tag))
}

fn is_tag(dom: &Dom, handle: Handle, tag: KnownTag) -> bool {
	dom.get(handle)
		.is_some_and(|node| node.tag == Tag::Known(tag))
}

fn prop_text(node: &Node, prop: PropId) -> Option<&str> {
	node.prop(&PropKey::from(prop)).and_then(Value::as_str)
}

fn prop_u64(node: &Node, prop: PropId) -> Option<u64> {
	match node.prop(&PropKey::from(prop))? {
		Value::Int(value) => u64::try_from(*value).ok(),
		_ => None,
	}
}

fn node_text(node: &Node) -> Option<&str> {
	node
		.content
		.as_deref()
		.or_else(|| prop_text(node, PropId::Text))
}
