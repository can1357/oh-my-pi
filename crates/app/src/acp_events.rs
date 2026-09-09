//! Projection of the authoritative session DOM into Agent Client Protocol
//! updates.

use std::path::{Path, PathBuf};

use omp_core::{FastHashMap, Str, base64};
use omp_dom::{Dom, Event, Handle, KnownTag, Node, PropId, PropKey, Sid, StreamOp, Tag, Value};
use omp_journal::{blob::BlobStore, data::Attachment};
use serde_json::{Value as JsonValue, json};
use thiserror::Error;

const ACP_TEXT_LIMIT: usize = 4_000;

/// A failure while applying or projecting one ordered DOM event.
#[derive(Debug, Error)]
pub enum AcpEventError {
	/// The actor replica rejected an event from its controller.
	#[error("ACP session replica rejected a controller event")]
	Dom(#[from] omp_dom::DomError),
	/// Durable JSON on a session element was malformed.
	#[error("ACP session element contained malformed JSON")]
	Json(#[from] serde_json::Error),
	/// A referenced attachment could not be read from the session blob store.
	#[error("ACP session attachment could not be read")]
	Blob(#[from] omp_journal::blob::Error),
}

#[derive(Clone, Debug, PartialEq)]
struct ToolProjection {
	name:       Str,
	call_id:    Str,
	intent:     Option<Str>,
	status:     Str,
	raw_input:  JsonValue,
	raw_output: JsonValue,
	content:    Vec<JsonValue>,
	locations:  Vec<JsonValue>,
}

/// Stateful actor projection. The replica, not the journal, is the only input.
pub struct AcpEventMapper {
	dom:     Dom,
	streams: FastHashMap<Sid, (Handle, PropKey)>,
	cwd:     PathBuf,
	blobs:   BlobStore,
}

impl AcpEventMapper {
	/// Starts from the snapshot paired with a session subscription.
	#[must_use]
	pub fn new(snapshot: &omp_dom::Snapshot, cwd: PathBuf, blobs: BlobStore) -> Self {
		Self { dom: Dom::from_snapshot(snapshot), streams: FastHashMap::default(), cwd, blobs }
	}

	/// Replays the selected branch through the same ACP update vocabulary used
	/// live.
	pub fn replay_updates(&self) -> Result<Vec<JsonValue>, AcpEventError> {
		let mut updates = Vec::new();
		for turn in self.dom.children(self.dom.body()) {
			let Some(turn_node) = self.dom.get(*turn) else {
				continue;
			};
			if turn_node.tag != Tag::Known(KnownTag::Turn) {
				continue;
			}
			for handle in &turn_node.kids {
				let Some(node) = self.dom.get(*handle) else {
					continue;
				};
				match &node.tag {
					Tag::Known(KnownTag::User | KnownTag::Developer) => {
						let message_id = node_id(node, *handle);
						if let Some(text) = node.content.as_deref().filter(|text| !text.is_empty()) {
							updates.push(message_chunk("user_message_chunk", text, &message_id));
						}
						if let Some(Value::Json(raw)) = node.prop(&PropId::Data.into()) {
							let attachments: Vec<Attachment> = serde_json::from_str(raw.get())?;
							for attachment in attachments {
								let bytes = self.blobs.get(&attachment.blob)?;
								updates.push(json!({
									"sessionUpdate": "user_message_chunk",
									"content": {
										"type": "image",
										"data": base64::encode(bytes.as_ref()).into_string(),
										"mimeType": attachment.mime,
									},
									"messageId": message_id,
								}));
							}
						}
					},
					Tag::Known(KnownTag::Assistant) => {
						self.replay_assistant(*handle, node, &mut updates);
					},
					Tag::Custom(_) if is_tool_node(&self.dom, *handle, node) => {
						if let Some(tool) = project_tool(&self.dom, *handle, &self.cwd) {
							updates.push(tool_start(&tool));
							if matches!(tool.status.as_str(), "ok" | "error") {
								updates.push(tool_update(&tool));
							}
						}
					},
					_ => {},
				}
			}
		}
		let plan = plan_update(&self.dom);
		if plan["entries"]
			.as_array()
			.is_some_and(|entries| !entries.is_empty())
		{
			updates.push(plan);
		}
		Ok(updates)
	}

	fn replay_assistant(&self, handle: Handle, node: &Node, updates: &mut Vec<JsonValue>) {
		let message_id = node_id(node, handle);
		let mut blocks = self
			.dom
			.children(handle)
			.iter()
			.enumerate()
			.filter_map(|(position, child)| {
				let node = self.dom.get(*child)?;
				if !matches!(&node.tag, Tag::Custom(tag) if matches!(tag.as_str(), omp_session::ASSISTANT_CONTENT_TAG | "artifact")) {
					return None;
				}
				let index = node
					.prop(&PropKey::Custom(Str::new_static(omp_session::PROVIDER_BLOCK_INDEX_PROP)))
					.and_then(|value| match value { Value::Int(index) => Some(*index), _ => None })
					.unwrap_or(i64::MAX);
				Some((index, position, *child))
			})
			.collect::<Vec<_>>();
		blocks.sort_by_key(|(index, position, _)| (*index, *position));
		let mut emitted_text = false;
		for (_, _, child) in blocks {
			let Some(block) = self.dom.get(child) else {
				continue;
			};
			if matches!(&block.tag, Tag::Custom(tag) if tag.as_str() == "artifact") {
				if let Some(update) = self.artifact_update(block, &message_id) {
					updates.push(update);
				}
				continue;
			}
			let Some(text) = self
				.dom
				.stream_text(child, &PropId::Text.into())
				.or_else(|| block.prop(&PropId::Text.into()).and_then(Value::as_str))
				.filter(|text| !text.is_empty())
			else {
				continue;
			};
			let update = match block.prop(&PropId::Kind.into()).and_then(Value::as_str) {
				Some("thinking") => "agent_thought_chunk",
				Some("text") => {
					emitted_text = true;
					"agent_message_chunk"
				},
				_ => continue,
			};
			updates.push(message_chunk(update, text, &message_id));
		}
		if !emitted_text
			&& let Some(text) = node
				.prop(&PropId::Text.into())
				.and_then(Value::as_str)
				.filter(|text| !text.is_empty())
		{
			updates.push(message_chunk("agent_message_chunk", text, &message_id));
		}
	}

	fn artifact_update(&self, node: &Node, message_id: &Str) -> Option<JsonValue> {
		let uri = node.prop(&PropId::Blob.into()).and_then(Value::as_str)?;
		let mime = node.prop(&PropId::Mime.into()).and_then(Value::as_str)?;
		let kind = node.prop(&PropId::Kind.into()).and_then(Value::as_str)?;
		let size = match node.prop(&PropKey::Custom(Str::new_static("size"))) {
			Some(Value::Int(size)) => u64::try_from(*size).ok(),
			_ => None,
		};
		let data = size.and_then(|size| {
			let url = omp_core::ArtifactUrl::new(Str::new(uri)).ok()?;
			let reference = omp_journal::blob::BlobRef::parse_hex(url.digest()?, size).ok()?;
			self
				.blobs
				.get(&reference)
				.ok()
				.map(|bytes| base64::encode(bytes.as_ref()).into_string())
		});
		let content = match kind {
			"image" => json!({
				"type": "image",
				"data": data.as_deref().unwrap_or(uri),
				"mimeType": mime,
			}),
			"audio" => json!({
				"type": "audio",
				"data": data.as_deref().unwrap_or(uri),
				"mimeType": mime,
			}),
			_ => json!({
				"type": "resource_link",
				"uri": uri,
				"name": "artifact",
				"mimeType": mime,
				"size": size,
			}),
		};
		Some(json!({
			"sessionUpdate": "agent_message_chunk",
			"content": content,
			"messageId": message_id,
		}))
	}

	/// Applies one event and returns zero or more schema-valid ACP updates.
	pub fn map_event(&mut self, event: &Event) -> Result<Vec<JsonValue>, AcpEventError> {
		if let Event::Stream { sid, op: StreamOp::Append, text: Some(text), .. } = event {
			let target = self.streams.get(sid).cloned();
			self.dom.apply_event(event)?;
			let Some((handle, prop)) = target else {
				return Ok(Vec::new());
			};
			if prop != PropKey::from(PropId::Text) {
				return Ok(Vec::new());
			}
			let Some(node) = self.dom.get(handle) else {
				return Ok(Vec::new());
			};
			if !matches!(&node.tag, Tag::Custom(tag) if tag.as_str() == omp_session::ASSISTANT_CONTENT_TAG)
			{
				return Ok(Vec::new());
			}
			let Some(assistant) = self.dom.parent(handle) else {
				return Ok(Vec::new());
			};
			let Some(assistant_node) = self.dom.get(assistant) else {
				return Ok(Vec::new());
			};
			let kind = match node.prop(&PropId::Kind.into()).and_then(Value::as_str) {
				Some("text") => "agent_message_chunk",
				Some("thinking") => "agent_thought_chunk",
				_ => return Ok(Vec::new()),
			};
			return Ok(vec![message_chunk(kind, text.as_str(), &node_id(assistant_node, assistant))]);
		}

		let before_high_water = self.dom.high_water();
		let before_plan = matches!(event, Event::Patch(_)).then(|| plan_update(&self.dom));
		let mut before = FastHashMap::default();
		if let Event::Patch(patch) = event {
			for op in &patch.ops {
				let handle = match op {
					omp_dom::Op::Rm(handle) => Some(*handle),
					omp_dom::Op::Set { h, .. } | omp_dom::Op::Mv { h, .. } => Some(*h),
					omp_dom::Op::Ins { parent, .. } => Some(*parent),
				};
				if let Some(handle) = handle.and_then(|handle| tool_ancestor(&self.dom, handle))
					&& !before.contains_key(&handle)
					&& let Some(tool) = project_tool(&self.dom, handle, &self.cwd)
				{
					before.insert(handle, tool);
				}
			}
		}
		self.dom.apply_event(event)?;
		match event {
			Event::Stream { sid, op: StreamOp::Open, node: Some(node), prop: Some(prop), .. } => {
				self.streams.insert(*sid, (*node, prop.clone()));
				return Ok(Vec::new());
			},
			Event::Stream { sid, op: StreamOp::Close, .. } => {
				self.streams.remove(sid);
				return Ok(Vec::new());
			},
			Event::Reset { snapshot } => {
				self.streams.clear();
				let replacement = Self::new(snapshot, self.cwd.clone(), self.blobs.clone());
				*self = replacement;
				return self.replay_updates();
			},
			Event::Stream { .. } => return Ok(Vec::new()),
			Event::Patch(_) => {},
		}

		let mut affected = before.keys().copied().collect::<Vec<_>>();
		for raw in before_high_water.saturating_add(1)..=self.dom.high_water() {
			let Some(handle) = Handle::new(raw) else {
				continue;
			};
			if let Some(tool) = tool_ancestor(&self.dom, handle)
				&& !affected.contains(&tool)
			{
				affected.push(tool);
			}
		}
		if let Event::Patch(patch) = event {
			for op in &patch.ops {
				let handle = match op {
					omp_dom::Op::Rm(_) => None,
					omp_dom::Op::Set { h, .. } | omp_dom::Op::Mv { h, .. } => Some(*h),
					omp_dom::Op::Ins { parent, .. } => Some(*parent),
				};
				if let Some(tool) = handle.and_then(|handle| tool_ancestor(&self.dom, handle))
					&& !affected.contains(&tool)
				{
					affected.push(tool);
				}
			}
		}

		let mut updates = Vec::new();
		for handle in affected {
			let after = project_tool(&self.dom, handle, &self.cwd);
			match (before.get(&handle), after) {
				(None, Some(tool)) if tool.status.as_str() != "arguments" => {
					updates.push(tool_start(&tool));
				},
				(Some(previous), Some(tool))
					if previous.status.as_str() == "arguments"
						&& tool.status.as_str() != "arguments" =>
				{
					updates.push(tool_start(&tool));
				},
				(Some(previous), Some(tool)) if previous != &tool => updates.push(tool_update(&tool)),
				_ => {},
			}
		}
		for raw in before_high_water.saturating_add(1)..=self.dom.high_water() {
			let Some(handle) = Handle::new(raw) else {
				continue;
			};
			let Some(node) = self.dom.get(handle) else {
				continue;
			};
			if matches!(&node.tag, Tag::Custom(tag) if tag.as_str() == "artifact")
				&& let Some(assistant) = self.dom.parent(handle)
				&& let Some(assistant_node) = self.dom.get(assistant)
				&& assistant_node.tag == Tag::Known(KnownTag::Assistant)
				&& let Some(update) = self.artifact_update(node, &node_id(assistant_node, assistant))
			{
				updates.push(update);
			}
		}
		if let Some(before_plan) = before_plan {
			let after_plan = plan_update(&self.dom);
			if before_plan != after_plan {
				updates.push(after_plan);
			}
		}
		Ok(updates)
	}
}

fn plan_update(dom: &Dom) -> JsonValue {
	let todo = dom.children(dom.meta()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Todo))
	});
	let entries = todo
		.into_iter()
		.flat_map(|todo| dom.children(todo))
		.filter_map(|handle| dom.get(*handle))
		.filter(|node| node.tag == Tag::Known(KnownTag::Item))
		.filter_map(|node| {
			let content = node.prop(&PropId::Label.into()).and_then(Value::as_str)?;
			let status = match node.prop(&PropId::Status.into()).and_then(Value::as_str) {
				Some("in_progress") => "in_progress",
				Some("completed" | "abandoned") => "completed",
				_ => "pending",
			};
			Some(json!({"content": content, "priority": "medium", "status": status}))
		})
		.collect::<Vec<_>>();
	json!({"sessionUpdate": "plan", "entries": entries})
}

fn message_chunk(kind: &'static str, text: &str, message_id: &Str) -> JsonValue {
	json!({
		"sessionUpdate": kind,
		"content": {"type": "text", "text": text},
		"messageId": message_id,
	})
}

fn node_id(node: &Node, handle: Handle) -> Str {
	node
		.prop(&PropId::Cause.into())
		.and_then(Value::as_str)
		.or_else(|| node.prop(&PropId::Id.into()).and_then(Value::as_str))
		.map_or_else(|| Str::new(handle.get().to_string()), Str::new)
}

fn is_tool_node(dom: &Dom, handle: Handle, node: &Node) -> bool {
	matches!(&node.tag, Tag::Custom(_))
		&& node
			.prop(&PropId::Id.into())
			.and_then(Value::as_str)
			.is_some()
		&& dom
			.parent(handle)
			.and_then(|parent| dom.get(parent))
			.is_some_and(|parent| parent.tag == Tag::Known(KnownTag::Turn))
}

fn tool_ancestor(dom: &Dom, mut handle: Handle) -> Option<Handle> {
	loop {
		let node = dom.get(handle)?;
		if is_tool_node(dom, handle, node) {
			return Some(handle);
		}
		handle = dom.parent(handle)?;
	}
}

fn project_tool(dom: &Dom, handle: Handle, cwd: &Path) -> Option<ToolProjection> {
	let node = dom.get(handle)?;
	if !is_tool_node(dom, handle, node) {
		return None;
	}
	let Tag::Custom(name) = &node.tag else {
		return None;
	};
	let call_id = node
		.prop(&PropId::Id.into())
		.and_then(Value::as_str)
		.map(Str::new)
		.unwrap_or_default();
	let status = node
		.prop(&PropId::Status.into())
		.and_then(Value::as_str)
		.map(Str::new)
		.unwrap_or_else(|| Str::new_static("running"));
	let intent = node
		.prop(&PropId::I.into())
		.and_then(Value::as_str)
		.map(Str::new);
	let input = child(dom, handle, KnownTag::Input);
	let result = child(dom, handle, KnownTag::Result);
	let raw_input = input
		.and_then(|node| json_prop(node, PropId::Data))
		.or_else(|| input.and_then(node_text_json))
		.unwrap_or_else(|| json!({}));
	if is_internal_hub(name.as_str(), &raw_input) {
		return None;
	}
	let mut raw_output = result
		.and_then(|node| json_prop(node, PropId::Outcome))
		.or_else(|| result.and_then(|node| json_prop(node, PropId::Data)))
		.or_else(|| result.and_then(node_text_json))
		.unwrap_or(JsonValue::Null);
	if status.as_str() == "error" {
		if let Some(fault) = dom
			.children(handle)
			.iter()
			.filter_map(|child| dom.get(*child))
			.find(|node| node.tag == Tag::Known(KnownTag::Diag))
			.and_then(|node| json_prop(node, PropId::Fault))
		{
			raw_output = fault;
		}
	}
	let content = tool_content(name.as_str(), &raw_input, &raw_output);
	let locations = tool_locations(name.as_str(), &raw_input, &raw_output, cwd);
	Some(ToolProjection {
		name: name.clone(),
		call_id,
		intent,
		status,
		raw_input,
		raw_output,
		content,
		locations,
	})
}

fn child(dom: &Dom, parent: Handle, tag: KnownTag) -> Option<&Node> {
	dom.children(parent)
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.find(|node| node.tag == Tag::Known(tag))
}

fn json_prop(node: &Node, prop: PropId) -> Option<JsonValue> {
	match node.prop(&prop.into())? {
		Value::Json(raw) => serde_json::from_str(raw.get()).ok(),
		value => serde_json::to_value(value).ok(),
	}
}

fn node_text_json(node: &Node) -> Option<JsonValue> {
	let text = node
		.content
		.as_deref()
		.or_else(|| node.prop(&PropId::Text.into()).and_then(Value::as_str))?;
	serde_json::from_str(text)
		.ok()
		.or_else(|| Some(JsonValue::String(text.to_owned())))
}

fn tool_start(tool: &ToolProjection) -> JsonValue {
	let title = tool_title(tool);
	let kind = tool_kind(tool.name.as_str(), &tool.raw_input);
	let mut update = json!({
		"sessionUpdate": "tool_call",
		"toolCallId": tool.call_id,
		"title": title,
		"kind": kind,
		"status": "pending",
		"rawInput": tool.raw_input,
	});
	if !tool.content.is_empty() {
		update["content"] = JsonValue::Array(tool.content.clone());
	}
	if !tool.locations.is_empty() {
		update["locations"] = JsonValue::Array(tool.locations.clone());
	}
	update
}

fn tool_update(tool: &ToolProjection) -> JsonValue {
	let status = match tool.status.as_str() {
		"ok" => "completed",
		"error" => "failed",
		_ => "in_progress",
	};
	let mut update = json!({
		"sessionUpdate": "tool_call_update",
		"toolCallId": tool.call_id,
		"status": status,
		"rawOutput": tool.raw_output,
	});
	if !tool.content.is_empty() {
		update["content"] = JsonValue::Array(tool.content.clone());
	}
	if !tool.locations.is_empty() {
		update["locations"] = JsonValue::Array(tool.locations.clone());
	}
	update
}

fn is_internal_hub(name: &str, input: &JsonValue) -> bool {
	if name == "hub" {
		return hub_op_is_internal(input);
	}
	if !matches!(name, "write" | "read")
		|| input.get("path").and_then(JsonValue::as_str) != Some("xd://hub")
	{
		return false;
	}
	input
		.get("content")
		.and_then(JsonValue::as_str)
		.and_then(|content| serde_json::from_str::<JsonValue>(content).ok())
		.is_some_and(|hub| hub_op_is_internal(&hub))
}

fn hub_op_is_internal(hub: &JsonValue) -> bool {
	match hub.get("op").and_then(JsonValue::as_str) {
		Some("list" | "inbox" | "send") => true,
		Some("wait") => {
			hub.get("from").and_then(JsonValue::as_str).is_some() && hub.get("ids").is_none()
		},
		_ => false,
	}
}

fn tool_kind(name: &str, input: &JsonValue) -> &'static str {
	if name == "write"
		&& input
			.get("path")
			.and_then(JsonValue::as_str)
			.is_some_and(|path| path.starts_with("xd://"))
	{
		return "execute";
	}
	match name {
		"read" => "read",
		"write" | "edit" => "edit",
		"delete" => "delete",
		"move" => "move",
		"bash" | "shell" | "exec" | "eval" => "execute",
		"grep" | "glob" | "ast_grep" => "search",
		"web_search" => "fetch",
		"todo" => "think",
		_ => "other",
	}
}

fn tool_title(tool: &ToolProjection) -> Str {
	if matches!(tool.name.as_str(), "bash" | "shell" | "exec")
		&& let Some(command) = tool.raw_input.get("command").and_then(JsonValue::as_str)
	{
		return Str::new(limit_text(&format!("$ {command}")));
	}
	if let Some(intent) = tool
		.intent
		.as_deref()
		.map(str::trim)
		.filter(|intent| !intent.is_empty())
	{
		return Str::new(intent);
	}
	for key in ["path", "command", "pattern", "query"] {
		if let Some(subject) = tool.raw_input.get(key).and_then(JsonValue::as_str) {
			return if subject.contains("://") {
				Str::new(subject)
			} else {
				Str::new(format!("{}: {subject}", tool.name))
			};
		}
	}
	tool.name.clone()
}

fn tool_content(name: &str, input: &JsonValue, output: &JsonValue) -> Vec<JsonValue> {
	let mut content = Vec::new();
	if matches!(name, "bash" | "shell" | "exec")
		&& let Some(command) = input.get("command").and_then(JsonValue::as_str)
	{
		content.push(text_content(&limit_text(&format!("$ {command}"))));
	}
	if let Some(terminal_id) = find_string(output, "terminalId") {
		content.push(json!({"type": "terminal", "terminalId": terminal_id}));
	}
	for diff in find_diffs(output) {
		content.push(diff);
	}
	let blocks = output
		.as_array()
		.or_else(|| output.get("content").and_then(JsonValue::as_array));
	if let Some(blocks) = blocks {
		for block in blocks {
			if let Some(kind) = block.get("type").and_then(JsonValue::as_str) {
				if matches!(kind, "text" | "image" | "audio" | "resource" | "resource_link") {
					content.push(json!({"type": "content", "content": block}));
				}
			}
		}
	}
	if let Some(images) = output
		.pointer("/details/images")
		.and_then(JsonValue::as_array)
	{
		for image in images {
			if image.get("type").and_then(JsonValue::as_str) == Some("image")
				&& !content.iter().any(|item| {
					item.get("type").and_then(JsonValue::as_str) == Some("content")
						&& item.get("content") == Some(image)
				}) {
				content.push(json!({"type": "content", "content": image}));
			}
		}
	}
	if let Some(text) = readable_text(output)
		&& !content.iter().any(|item| {
			item.get("type").and_then(JsonValue::as_str) == Some("content")
				&& item.pointer("/content/text").and_then(JsonValue::as_str) == Some(text)
		}) {
		content.push(text_content(&limit_text(text)));
	} else if blocks.is_none()
		&& find_string(output, "terminalId").is_none()
		&& output
			.pointer("/details/images")
			.and_then(JsonValue::as_array)
			.is_none()
		&& !output.is_null()
		&& let Ok(text) = serde_json::to_string(output)
	{
		content.push(text_content(&limit_text(&text)));
	}
	content
}

fn text_content(text: &str) -> JsonValue {
	json!({"type": "content", "content": {"type": "text", "text": text}})
}

fn readable_text(value: &JsonValue) -> Option<&str> {
	if let Some(text) = value.as_str() {
		return Some(text);
	}
	for key in ["text", "output", "errorMessage", "message"] {
		if let Some(text) = value.get(key).and_then(JsonValue::as_str) {
			return Some(text);
		}
	}
	if let Some(content) = value.get("content").and_then(JsonValue::as_str) {
		return Some(content);
	}
	None
}

fn find_string<'a>(value: &'a JsonValue, key: &str) -> Option<&'a str> {
	value.get(key).and_then(JsonValue::as_str).or_else(|| {
		value
			.get("details")
			.and_then(|details| details.get(key))
			.and_then(JsonValue::as_str)
	})
}

fn find_diffs(value: &JsonValue) -> Vec<JsonValue> {
	let details = value.get("details").unwrap_or(value);
	let entries = details
		.get("perFileResults")
		.and_then(JsonValue::as_array)
		.map(Vec::as_slice)
		.unwrap_or_else(|| std::slice::from_ref(details));
	entries.iter().filter_map(|entry| {
		if entry.get("isError").and_then(JsonValue::as_bool) == Some(true) { return None; }
		let path = entry.get("path").and_then(JsonValue::as_str)?;
		let old = entry.get("oldText");
		let new = entry.get("newText");
		if old.is_none() && new.is_none() { return None; }
		Some(json!({"type": "diff", "path": path, "oldText": old.cloned().unwrap_or(JsonValue::Null), "newText": new.and_then(JsonValue::as_str).unwrap_or_default()}))
	}).collect()
}

fn tool_locations(name: &str, input: &JsonValue, output: &JsonValue, cwd: &Path) -> Vec<JsonValue> {
	let mut paths = Vec::<PathBuf>::new();
	for value in [input, output.get("details").unwrap_or(output)] {
		for key in ["path", "oldPath", "newPath", "resolvedPath"] {
			let Some(raw) = value.get(key).and_then(JsonValue::as_str) else {
				continue;
			};
			if raw.contains("://") {
				continue;
			}
			let path = if Path::new(raw).is_absolute() {
				PathBuf::from(raw)
			} else {
				cwd.join(raw)
			};
			if (name != "read" || path.is_file()) && !paths.contains(&path) {
				paths.push(path);
			}
		}
	}
	if let Some(entries) = output
		.pointer("/details/perFileResults")
		.and_then(JsonValue::as_array)
	{
		for entry in entries {
			let Some(raw) = entry.get("path").and_then(JsonValue::as_str) else {
				continue;
			};
			let path = if Path::new(raw).is_absolute() {
				PathBuf::from(raw)
			} else {
				cwd.join(raw)
			};
			if !paths.contains(&path) {
				paths.push(path);
			}
		}
	}
	paths
		.into_iter()
		.map(|path| json!({"path": path}))
		.collect()
}

fn limit_text(text: &str) -> String {
	if text.chars().count() <= ACP_TEXT_LIMIT {
		return text.to_owned();
	}
	let mut limited = text.chars().take(ACP_TEXT_LIMIT - 1).collect::<String>();
	limited.push('…');
	limited
}

#[cfg(test)]
mod tests {
	use omp_dom::{NodeSpec, Op, Txn};
	use omp_session::{ComponentRegistry, Session};

	use super::*;

	#[test]
	fn live_dom_events_map_to_acp_chunks_and_tool_lifecycle() {
		let root = tempfile::tempdir().expect("tempdir");
		let mut session = Session::create(root.path().join("acp.oms"), ComponentRegistry::standard())
			.expect("session");
		let (snapshot, events) = session.subscribe();
		let mut mapper =
			AcpEventMapper::new(&snapshot, root.path().to_path_buf(), session.blobs().clone());
		session.begin_turn().expect("turn");
		session.assistant_start("m", "p", "r").expect("assistant");
		let assistant = *session
			.dom()
			.children(
				*session
					.dom()
					.children(session.dom().body())
					.last()
					.expect("turn"),
			)
			.last()
			.expect("assistant");
		session
			.patch(Txn {
				cause: session.head().expect("head"),
				label: Some(Str::new_static("assistant.content")),
				ops:   vec![Op::Ins {
					parent: assistant,
					after:  None,
					node:   NodeSpec::new(Tag::Custom(Str::new_static(
						omp_session::ASSISTANT_CONTENT_TAG,
					)))
					.with_prop(PropId::Kind, Value::Str(Str::new_static("text")))
					.with_prop(PropId::Text, Value::Str(Str::new_static(""))),
				}],
			})
			.expect("content node");
		let content = *session.dom().children(assistant).last().expect("content");
		let sid = session
			.stream_open(content, PropId::Text.into())
			.expect("open");
		session.stream_append(sid, "hello").expect("append");
		let args = serde_json::value::to_raw_value(&json!({"command": "printf ok"})).expect("args");
		let call = session
			.call("bash", 1, "call-1", None, Some(args), None)
			.expect("call");
		let outcome = serde_json::value::to_raw_value(&json!({"text": "ok", "terminalId": "term-1"}))
			.expect("outcome");
		session.settle(call, outcome).expect("settle");

		let updates = events
			.try_iter()
			.flat_map(|event| mapper.map_event(&event).expect("map"))
			.collect::<Vec<_>>();
		assert!(updates.iter().any(|update| {
			update["sessionUpdate"] == "agent_message_chunk"
				&& update["content"]["text"] == "hello"
				&& update["messageId"].is_string()
		}));
		let start = updates
			.iter()
			.find(|update| update["sessionUpdate"] == "tool_call")
			.expect("tool start");
		assert_eq!(start["toolCallId"], "call-1");
		assert_eq!(start["title"], "$ printf ok");
		assert_eq!(start["kind"], "execute");
		let end = updates
			.iter()
			.rev()
			.find(|update| update["sessionUpdate"] == "tool_call_update")
			.expect("tool end");
		assert_eq!(end["status"], "completed");
		assert!(end["content"].as_array().is_some_and(|content| {
			content
				.iter()
				.any(|item| item["type"] == "terminal" && item["terminalId"] == "term-1")
		}));
	}
}
