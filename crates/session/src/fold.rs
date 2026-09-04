use omp_core::{Str, StrMut};
use omp_dom::{
	Applied, Dom, Handle, KnownTag, NodeSpec, Op, PropId, PropKey, StreamOp, Tag, Txn, Value,
};
use omp_journal::{
	Entry, EntryId,
	blob::BlobRef,
	data::{
		Compaction, MsgAssistantEnd, MsgAssistantStart, MsgUser, Patch, Stream, ToolCall, ToolResult,
		ToolUpdate, TurnReceipt,
	},
	kind,
};
use omp_tool::{Diag, Part as ToolPart};
use serde::Deserialize;
use serde_json::value::RawValue;

use crate::{Draft, Session, SessionError};

impl Session {
	pub(crate) fn apply(&mut self, entry: &Entry) -> Result<(), SessionError> {
		self.entry_patch_published = false;
		match (entry.kind.name.as_str(), entry.kind.rev) {
			(kind::JOURNAL, 1) => self.fold_genesis(entry)?,
			(kind::TURN_START, 1) => self.fold_turn_start(entry)?,
			(kind::MSG_USER, 1) => self.fold_user(entry)?,
			(kind::MSG_ASSISTANT_START, 1) => self.fold_assistant_start(entry)?,
			(kind::STREAM, 1) => self.fold_stream(entry)?,
			(kind::MSG_ASSISTANT_END, 1) => self.fold_assistant_end(entry)?,
			(kind::TOOL_CALL, 1) => self.fold_tool_call(entry)?,
			(kind::TOOL_UPDATE, 1) => self.fold_tool_update(entry)?,
			(kind::TOOL_RESULT, 1) => self.fold_tool_result(entry)?,
			(kind::TURN_RECEIPT, 1) => self.fold_receipt(entry)?,
			(kind::PATCH, 1) => self.fold_patch(entry)?,
			(kind::COMPACTION, 1) => self.fold_compaction(entry)?,
			_ => {},
		}

		let mut draft = Draft::new();
		for component in self.components.iter_mut() {
			if component.interested(&entry.kind) {
				component.apply(entry, &self.dom, &mut draft);
			}
		}
		if !draft.is_empty() {
			self.apply_entry_ops(entry, draft.into_ops())?;
		}
		self.head = Some(entry.id);
		Ok(())
	}

	fn fold_genesis(&mut self, entry: &Entry) -> Result<(), SessionError> {
		let meta = self.dom.meta();
		let queues = self.dom.queues();
		let mut ops = Vec::with_capacity(6);
		for tag in [KnownTag::Todo, KnownTag::Jobs, KnownTag::Directors, KnownTag::Con] {
			ops.push(Op::Ins { parent: meta, after: None, node: NodeSpec::new(tag) });
		}
		for tag in [KnownTag::Steering, KnownTag::Prompts] {
			ops.push(Op::Ins { parent: queues, after: None, node: NodeSpec::new(tag) });
		}
		self.apply_ops(entry, ops)
	}

	fn fold_turn_start(&mut self, entry: &Entry) -> Result<(), SessionError> {
		let body = self.dom.body();
		let after = self.dom.children(body).last().copied();
		let ordinal = i64::try_from(self.dom.children(body).len() + 1).unwrap_or(i64::MAX);
		let node = entry_node(KnownTag::Turn, entry).with_prop(PropId::Turn, Value::Int(ordinal));
		let applied = self.apply_entry_ops(entry, vec![Op::Ins { parent: body, after, node }])?;
		self.current_turn = Some(entry.id);
		self.current_assistant = None;
		if applied.minted.is_empty() {
			return Err(SessionError::NoActiveTurn);
		}
		Ok(())
	}

	fn fold_user(&mut self, entry: &Entry) -> Result<(), SessionError> {
		let payload: MsgUser = serde_json::from_str(entry.data.as_str())?;
		let turn = self.current_turn_handle()?;
		let mut node = entry_node(KnownTag::User, entry).with_content(payload.text);
		if !payload.attachments.is_empty() {
			let raw = serde_json::value::to_raw_value(&payload.attachments)?;
			node = node.with_prop(PropId::Data, Value::Json(raw));
		}
		if let Some(author) = payload.author {
			node = node.with_prop(PropId::Author, Value::Str(author));
		}
		self.insert_last(entry, turn, node)?;
		Ok(())
	}

	fn fold_assistant_start(&mut self, entry: &Entry) -> Result<(), SessionError> {
		let payload: MsgAssistantStart = serde_json::from_str(entry.data.as_str())?;
		let turn = self.current_turn_handle()?;
		let node = entry_node(KnownTag::Assistant, entry)
			.with_prop(PropId::Model, Value::Str(payload.model))
			.with_prop(PropId::Provider, Value::Str(payload.provider))
			.with_prop(PropId::Route, Value::Str(payload.route));
		self.insert_last(entry, turn, node)?;
		self.current_assistant = Some(entry.id);
		Ok(())
	}

	fn fold_stream(&mut self, entry: &Entry) -> Result<(), SessionError> {
		let payload: Stream = serde_json::from_str(entry.data.as_str())?;
		self.next_sid = self.next_sid.max(payload.sid);
		match payload.op {
			omp_journal::data::StreamOp::Open => {
				let value = payload.node.ok_or(SessionError::InvalidStreamFrame)?;
				let node = Handle::new(value).ok_or(SessionError::InvalidHandle { value })?;
				let prop = payload
					.prop
					.map(|value| Self::decode_stream_prop(value.as_str()))
					.ok_or(SessionError::InvalidStreamFrame)?;
				if payload.text.is_some() {
					return Err(SessionError::InvalidStreamFrame);
				}
				self.apply_stream(entry, payload.sid, StreamOp::Open, Some(node), Some(prop), None)?;
				self.stream_targets.insert(payload.sid, node);
				self.set_stream_order(entry, node)
			},
			omp_journal::data::StreamOp::Append => {
				if payload.node.is_some() || payload.prop.is_some() {
					return Err(SessionError::InvalidStreamFrame);
				}
				let text = payload.text.ok_or(SessionError::InvalidStreamFrame)?;
				let node = self.stream_target(payload.sid)?;
				self.apply_stream(entry, payload.sid, StreamOp::Append, None, None, Some(text))?;
				self.set_stream_order(entry, node)
			},
			omp_journal::data::StreamOp::Close => {
				if payload.node.is_some() || payload.prop.is_some() || payload.text.is_some() {
					return Err(SessionError::InvalidStreamFrame);
				}
				let node = self.stream_target(payload.sid)?;
				self.apply_stream(entry, payload.sid, StreamOp::Close, None, None, None)?;
				self.stream_targets.remove(&payload.sid);
				self.set_stream_order(entry, node)
			},
		}
	}

	fn fold_assistant_end(&mut self, entry: &Entry) -> Result<(), SessionError> {
		let payload: MsgAssistantEnd = serde_json::from_str(entry.data.as_str())?;
		let assistant = self.current_assistant_handle()?;
		let (text, thinking) = self.aggregate_assistant_content(assistant);
		let mut ops = vec![
			Op::Set {
				h:     assistant,
				prop:  PropId::StopReason.into(),
				value: Value::Str(payload.stop_reason),
			},
			Op::Set {
				h:     assistant,
				prop:  PropId::Order.into(),
				value: Value::Str(Str::new(entry.id.to_string())),
			},
		];
		if let Some(text) = text {
			ops.push(Op::Set {
				h:     assistant,
				prop:  PropId::Text.into(),
				value: Value::Str(text),
			});
		}
		if let Some(thinking) = thinking {
			ops.push(Op::Set {
				h:     assistant,
				prop:  PropId::Thinking.into(),
				value: Value::Str(thinking),
			});
		}
		self.apply_ops(entry, ops)?;
		self.current_assistant = None;
		Ok(())
	}

	/// Materializes the legacy aggregate assistant properties exactly once at
	/// finalization. Ordered children remain authoritative; the aggregates are
	/// a compatibility projection for consumers that have not yet learned the
	/// provider-content child shape.
	fn aggregate_assistant_content(&self, assistant: Handle) -> (Option<Str>, Option<Str>) {
		let mut children = self
			.dom
			.children(assistant)
			.iter()
			.enumerate()
			.filter_map(|(position, handle)| {
				let node = self.dom.get(*handle)?;
				let Tag::Custom(tag) = &node.tag else {
					return None;
				};
				if tag.as_str() != crate::ASSISTANT_CONTENT_TAG {
					return None;
				}
				let index = node
					.prop(&PropKey::Custom(Str::new_static(crate::PROVIDER_BLOCK_INDEX_PROP)))
					.and_then(|value| match value {
						Value::Int(index) => Some(*index),
						_ => None,
					})
					.unwrap_or(i64::MAX);
				Some((index, position, *handle))
			})
			.collect::<Vec<_>>();
		children.sort_by_key(|(index, position, _)| (*index, *position));

		let mut text = None::<StrMut>;
		let mut thinking = None::<StrMut>;
		for (_, _, handle) in children {
			let Some(node) = self.dom.get(handle) else {
				continue;
			};
			let Some(value) = self
				.dom
				.stream_text(handle, &PropId::Text.into())
				.or_else(|| node.prop(&PropId::Text.into()).and_then(Value::as_str))
			else {
				continue;
			};
			let target = match node.prop(&PropId::Kind.into()).and_then(Value::as_str) {
				Some("text") => &mut text,
				Some("thinking") => &mut thinking,
				_ => continue,
			};
			target
				.get_or_insert_with(|| StrMut::new(""))
				.push_str(value);
		}
		(text.map(StrMut::freeze), thinking.map(StrMut::freeze))
	}

	fn fold_tool_call(&mut self, entry: &Entry) -> Result<(), SessionError> {
		let payload: ToolCall = serde_json::from_str(entry.data.as_str())?;
		let turn = self.current_turn_handle()?;
		let start = self.dom.high_water() + 1;
		let tool = Handle::new(start).ok_or(SessionError::InvalidHandle { value: start })?;
		let input = Handle::new(start + 1).ok_or(SessionError::InvalidHandle { value: start + 1 })?;
		let status = if payload.sid.is_some() {
			"arguments"
		} else {
			"running"
		};
		let mut tool_node = NodeSpec::new(Tag::Custom(payload.name.clone()))
			.with_prop(PropId::Id, Value::Str(payload.call_id.clone()))
			.with_prop(PropId::Cause, Value::Str(Str::new(entry.id.to_string())))
			.with_prop(PropId::Order, Value::Str(Str::new(entry.id.to_string())))
			.with_prop(PropId::Status, Value::Str(Str::new(status)))
			.with_prop(PropId::Rev, Value::Int(i64::from(payload.rev)));
		if let Some(intent) = payload.i {
			tool_node = tool_node.with_prop(PropId::I, Value::Str(intent));
		}
		let stream_sid = payload.sid;
		let input_node = match payload.args {
			Some(args) => NodeSpec::new(KnownTag::Input).with_content(args.get()),
			None => {
				NodeSpec::new(KnownTag::Input).with_prop(PropId::Text, Value::Str(Str::new_static("")))
			},
		};
		let after = self.dom.children(turn).last().copied();
		let ops = vec![
			Op::Ins { parent: turn, after, node: tool_node },
			Op::Ins { parent: tool, after: None, node: input_node },
			Op::Ins { parent: tool, after: Some(input), node: NodeSpec::new(KnownTag::Result) },
			Op::Ins {
				parent: tool,
				after:  Handle::new(start + 2),
				node:   NodeSpec::new(KnownTag::Usage),
			},
		];
		self.apply_ops(entry, ops)?;
		self.call_handles.insert(entry.id, tool);
		if let Some(sid) = stream_sid {
			self.next_sid = self.next_sid.max(sid);
			self.apply_stream(
				entry,
				sid,
				StreamOp::Open,
				Some(input),
				Some(PropId::Text.into()),
				None,
			)?;
			self.stream_targets.insert(sid, input);
		}
		Ok(())
	}

	fn fold_tool_update(&mut self, entry: &Entry) -> Result<(), SessionError> {
		let ToolUpdate(update): ToolUpdate = serde_json::from_str(entry.data.as_str())?;
		let call = self.entry_call_handle(entry)?;
		let value: serde_json::Value = serde_json::from_str(update.get())?;
		match value.get("kernel").and_then(serde_json::Value::as_str) {
			Some("ready") => return self.fold_tool_ready(entry, call, &value),
			Some("started") => {
				return self.apply_ops(entry, vec![
					Op::Set {
						h:     call,
						prop:  PropKey::Custom(Str::new_static("execution-started")),
						value: Value::Bool(true),
					},
					Op::Set {
						h:     call,
						prop:  PropId::Order.into(),
						value: Value::Str(Str::new(entry.id.to_string())),
					},
				]);
			},
			_ => {},
		}
		let mut ops = vec![Op::Set {
			h:     call,
			prop:  PropId::Order.into(),
			value: Value::Str(Str::new(entry.id.to_string())),
		}];
		project_update(&self.dom, call, &value, &mut ops)?;
		self.apply_ops(entry, ops)
	}

	fn fold_tool_ready(
		&mut self,
		entry: &Entry,
		call: Handle,
		value: &serde_json::Value,
	) -> Result<(), SessionError> {
		let input =
			child_with_tag(&self.dom, call, KnownTag::Input).ok_or(SessionError::NoActiveTurn)?;
		let args = value.get("args").ok_or(SessionError::InvalidStreamFrame)?;
		let raw = serde_json::value::to_raw_value(args)?;
		if let Some(sid) = self
			.stream_targets
			.iter()
			.find_map(|(sid, target)| (*target == input).then_some(*sid))
		{
			self.apply_stream(entry, sid, StreamOp::Close, None, None, None)?;
			self.stream_targets.remove(&sid);
		}
		let mut ops = vec![
			Op::Set {
				h:     call,
				prop:  PropId::Order.into(),
				value: Value::Str(Str::new(entry.id.to_string())),
			},
			Op::Set {
				h:     call,
				prop:  PropId::Status.into(),
				value: Value::Str(Str::new_static("running")),
			},
			Op::Set { h: input, prop: PropId::Text.into(), value: Value::Str(json_text(&raw)) },
			Op::Set { h: input, prop: PropId::Data.into(), value: Value::Json(raw) },
		];
		if let Some(i) = value.get("i").and_then(serde_json::Value::as_str) {
			ops.push(Op::Set { h: call, prop: PropId::I.into(), value: Value::Str(Str::new(i)) });
		}
		self.apply_ops(entry, ops)
	}

	fn fold_tool_result(&mut self, entry: &Entry) -> Result<(), SessionError> {
		let payload: ToolResult = serde_json::from_str(entry.data.as_str())?;
		let call = self.entry_call_handle(entry)?;
		let (status, raw, prompt_parts, source_blob) = match payload {
			ToolResult::Outcome { outcome, prompt_parts, source_blob } => {
				("ok", outcome, prompt_parts, source_blob)
			},
			ToolResult::Fault { fault, prompt_parts, source_blob } => {
				("error", fault, prompt_parts, source_blob)
			},
		};
		let text = prompt_parts
			.as_deref()
			.map(prompt_parts_text)
			.transpose()?
			.unwrap_or_else(|| outcome_text(&raw));
		let mut ops = vec![
			Op::Set {
				h:     call,
				prop:  PropId::Order.into(),
				value: Value::Str(Str::new(entry.id.to_string())),
			},
			Op::Set {
				h:     call,
				prop:  PropId::Status.into(),
				value: Value::Str(Str::new_static(status)),
			},
			Op::Set {
				h:     call,
				prop:  PropKey::Custom(Str::new_static("result_entry")),
				value: Value::Str(Str::new(entry.id.to_string())),
			},
		];
		if let Some(source_blob) = source_blob {
			ops.extend([
				Op::Set {
					h:     call,
					prop:  PropId::Blob.into(),
					value: Value::Str(blob_address(&source_blob)),
				},
				Op::Set {
					h:     call,
					prop:  PropId::Mime.into(),
					value: Value::Str(Str::new_static("application/json")),
				},
				Op::Set {
					h:     call,
					prop:  PropKey::Custom(Str::new_static("size")),
					value: unsigned(source_blob.size),
				},
			]);
		}
		if status == "error" {
			// A fault is its own `<diag severity=error>` (ADR 0008): it never
			// overwrites a warning the tool emitted earlier.
			let mut node = NodeSpec::new(KnownTag::Diag)
				.with_prop(PropId::Severity, Value::Str(Str::new_static("error")))
				.with_prop(PropId::Text, Value::Str(text))
				.with_prop(PropId::Fault, Value::Json(raw));
			if let Some(prompt_parts) = prompt_parts {
				node = node.with_prop(PropId::Data, Value::Json(prompt_parts));
			}
			ops.push(Op::Ins { parent: call, after: self.dom.children(call).last().copied(), node });
		} else {
			let child = child_with_tag(&self.dom, call, KnownTag::Result)
				.ok_or(SessionError::UnknownCall { id: entry.by.expect("journal enforces causes") })?;
			let has_streamed_text = self.dom.get(child).is_some_and(|node| {
				node.content.as_ref().is_some_and(|value| !value.is_empty())
					|| node
						.prop(&PropKey::from(PropId::Text))
						.and_then(Value::as_str)
						.is_some_and(|value| !value.is_empty())
			});
			if !has_streamed_text {
				ops.push(Op::Set { h: child, prop: PropId::Text.into(), value: Value::Str(text) });
			}
			// The tool's durable truth (ADR 0008: the element carries the
			// payload); `data` stays the model-facing projection.
			ops.push(Op::Set { h: child, prop: PropId::Outcome.into(), value: Value::Json(raw) });
			if let Some(prompt_parts) = prompt_parts {
				ops.push(Op::Set {
					h:     child,
					prop:  PropId::Data.into(),
					value: Value::Json(prompt_parts),
				});
			}
		}
		self.apply_ops(entry, ops)
	}

	fn fold_receipt(&mut self, entry: &Entry) -> Result<(), SessionError> {
		let payload: TurnReceipt = serde_json::from_str(entry.data.as_str())?;
		let turn = self.current_turn_handle()?;
		let recoveries = (!payload.recoveries.is_empty())
			.then(|| serde_json::value::to_raw_value(&payload.recoveries))
			.transpose()?;
		let mut node = entry_node(KnownTag::Usage, entry)
			.with_prop(PropId::TokensIn, unsigned(payload.tokens_in))
			.with_prop(PropId::TokensOut, unsigned(payload.tokens_out))
			.with_prop(PropId::CostNanoUsd, unsigned(payload.cost_nano_usd))
			.with_prop(PropId::CacheRead, unsigned(payload.cache_read))
			.with_prop(PropId::CacheWrite, unsigned(payload.cache_write));
		if payload.premium_requests_millionths != 0 {
			node =
				node.with_prop(PropId::PremiumRequests, unsigned(payload.premium_requests_millionths));
		}
		if let Some(recoveries) = recoveries {
			node =
				node.with_prop(PropKey::Custom(Str::new_static("recoveries")), Value::Json(recoveries));
		}
		if let Some(identity) = payload.identity {
			let kind: &'static str = identity.role.into();
			node = node
				.with_prop(PropId::Kind, Value::Str(Str::new_static(kind)))
				.with_prop(PropId::Provider, Value::Str(identity.provider))
				.with_prop(PropId::Model, Value::Str(identity.model));
		}
		if let Some(ttft) = payload.ttft_ms {
			node = node.with_prop(PropId::TtftMs, unsigned(ttft));
		}
		if let Some(duration) = payload.duration_ms {
			node = node.with_prop(PropId::DurationMs, unsigned(duration));
		}
		self.insert_last(entry, turn, node)?;
		Ok(())
	}

	fn fold_patch(&mut self, entry: &Entry) -> Result<(), SessionError> {
		let payload: Patch = serde_json::from_str(entry.data.as_str())?;
		let ops: Vec<Op> = serde_json::from_str(payload.ops.get())?;
		let Some(boundary) = self.head else {
			return self.apply_ops(entry, ops);
		};
		let meta = self.dom.meta();
		let after = self.dom.children(meta).last().copied();
		let ops = ops
			.into_iter()
			.map(|op| match op {
				Op::Ins { parent, after: sibling, node } => match legacy_handoff_document(&node) {
					Some(summary) => Op::Ins {
						parent: meta,
						after,
						node: NodeSpec::new(KnownTag::Compaction)
							.with_prop(PropId::Id, Value::Str(Str::new(entry.id.to_string())))
							.with_prop(PropId::Cause, Value::Str(Str::new(entry.id.to_string())))
							.with_prop(PropId::Boundary, Value::Str(Str::new(boundary.to_string())))
							.with_prop(PropId::Summary, Value::Str(summary))
							.with_prop(PropId::Method, Value::Str(Str::new_static("handoff"))),
					},
					None => Op::Ins { parent, after: sibling, node },
				},
				other => other,
			})
			.collect();
		self.apply_ops(entry, ops)
	}

	fn fold_compaction(&mut self, entry: &Entry) -> Result<(), SessionError> {
		let payload: Compaction = serde_json::from_str(entry.data.as_str())?;
		self.validate_compaction_frames(&payload)?;
		let summary = self.compaction_summary(&payload.summary)?;
		let frames = (!payload.frames.is_empty())
			.then(|| serde_json::value::to_raw_value(&payload.frames))
			.transpose()?;
		let frame_count = u64::try_from(payload.frame_count()).unwrap_or(u64::MAX);
		let meta = self.dom.meta();
		let mut node = NodeSpec::new(KnownTag::Compaction)
			.with_prop(PropId::Id, Value::Str(Str::new(entry.id.to_string())))
			.with_prop(PropId::Cause, Value::Str(Str::new(entry.id.to_string())))
			.with_prop(PropId::Boundary, Value::Str(Str::new(payload.boundary.to_string())))
			.with_prop(PropId::Summary, Value::Str(summary))
			.with_prop(PropId::Blob, Value::Str(blob_address(&payload.summary)));
		if let Some(method) = payload.method {
			node = node.with_prop(PropId::Method, Value::Str(method));
		}
		if let Some(before) = payload.tokens_before {
			node = node.with_prop(PropId::TokensBefore, unsigned(before));
		}
		if let Some(after) = payload.tokens_after {
			node = node.with_prop(PropId::TokensAfter, unsigned(after));
		}
		if let Some(frames) = frames {
			node = node
				.with_prop(PropId::Frames, Value::Json(frames))
				.with_prop(PropId::FrameCount, unsigned(frame_count));
		}
		if let Some(warning) = payload.warning {
			node = node.with_prop(PropId::Warning, Value::Str(warning));
		}
		self.insert_last(entry, meta, node)?;
		Ok(())
	}

	fn insert_last(
		&mut self,
		entry: &Entry,
		parent: Handle,
		node: NodeSpec,
	) -> Result<Handle, SessionError> {
		let after = self.dom.children(parent).last().copied();
		let applied = self.apply_entry_ops(entry, vec![Op::Ins { parent, after, node }])?;
		Ok(applied.minted[0])
	}

	fn apply_ops(&mut self, entry: &Entry, ops: Vec<Op>) -> Result<(), SessionError> {
		self.apply_entry_ops(entry, ops)?;
		Ok(())
	}

	fn apply_entry_ops(&mut self, entry: &Entry, ops: Vec<Op>) -> Result<Applied, SessionError> {
		let prior = (!self.entry_patch_published)
			.then_some(entry.prior)
			.flatten();
		let txn = Txn { cause: entry.id, label: entry.label.clone(), ops };
		let applied = self.dom.apply_with_prior(&txn, prior)?;
		self.entry_patch_published = true;
		Ok(applied)
	}

	fn apply_stream(
		&mut self,
		entry: &Entry,
		sid: u32,
		op: StreamOp,
		node: Option<Handle>,
		prop: Option<PropKey>,
		text: Option<Str>,
	) -> Result<(), SessionError> {
		match op {
			StreamOp::Open => self.dom.stream_open_with_id(
				entry.id,
				sid,
				node.ok_or(SessionError::InvalidStreamFrame)?,
				prop.ok_or(SessionError::InvalidStreamFrame)?,
			)?,
			StreamOp::Append => self.dom.stream_append(
				entry.id,
				sid,
				text.as_deref().ok_or(SessionError::InvalidStreamFrame)?,
			)?,
			StreamOp::Close => self.dom.stream_close(entry.id, sid)?,
		}
		self.entry_patch_published = true;
		Ok(())
	}

	fn stream_target(&self, sid: u32) -> Result<Handle, SessionError> {
		self
			.stream_targets
			.get(&sid)
			.copied()
			.ok_or_else(|| omp_dom::DomError::MissingStream { sid }.into())
	}

	fn set_stream_order(&mut self, entry: &Entry, node: Handle) -> Result<(), SessionError> {
		self.apply_ops(entry, vec![Op::Set {
			h:     node,
			prop:  PropId::Order.into(),
			value: Value::Str(Str::new(entry.id.to_string())),
		}])
	}

	pub(crate) fn current_turn_handle(&self) -> Result<Handle, SessionError> {
		let id = self.current_turn.ok_or(SessionError::NoActiveTurn)?;
		find_entry_node(&self.dom, self.dom.body(), id).ok_or(SessionError::NoActiveTurn)
	}

	pub(crate) fn current_assistant_handle(&self) -> Result<Handle, SessionError> {
		let id = self
			.current_assistant
			.ok_or(SessionError::NoActiveAssistant)?;
		find_entry_node(&self.dom, self.dom.body(), id).ok_or(SessionError::NoActiveAssistant)
	}

	fn entry_call_handle(&self, entry: &Entry) -> Result<Handle, SessionError> {
		self.call_handle(entry.by.expect("journal enforces causes"))
	}

	/// Returns the DOM element materialized for a live tool-call entry.
	pub fn call_handle(&self, id: EntryId) -> Result<Handle, SessionError> {
		self
			.call_handles
			.get(&id)
			.copied()
			.ok_or(SessionError::UnknownCall { id })
	}
}

fn entry_node(tag: KnownTag, entry: &Entry) -> NodeSpec {
	NodeSpec::new(tag)
		.with_prop(PropId::Id, Value::Str(Str::new(entry.id.to_string())))
		.with_prop(PropId::Order, Value::Str(Str::new(entry.id.to_string())))
		.with_prop(
			PropId::Cause,
			entry
				.by
				.map_or(Value::Null, |id| Value::Str(Str::new(id.to_string()))),
		)
}

fn find_entry_node(dom: &Dom, root: Handle, id: EntryId) -> Option<Handle> {
	let wanted = id.to_string();
	descendants(dom, root).find(|handle| {
		dom.get(*handle)
			.and_then(|node| node.prop(&PropKey::from(PropId::Id)))
			.and_then(Value::as_str)
			.is_some_and(|value| value == wanted)
	})
}

fn descendants(dom: &Dom, root: Handle) -> impl Iterator<Item = Handle> + '_ {
	dom.handles().filter(move |handle| {
		let mut at = Some(*handle);
		while let Some(current) = at {
			if current == root {
				return true;
			}
			at = dom.parent(current);
		}
		false
	})
}

fn child_with_tag(dom: &Dom, parent: Handle, tag: KnownTag) -> Option<Handle> {
	dom.children(parent).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(tag))
	})
}

fn last_child_with_tag(dom: &Dom, parent: Handle, tag: KnownTag) -> Option<Handle> {
	dom.children(parent).iter().rev().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(tag))
	})
}

fn project_update(
	dom: &Dom,
	call: Handle,
	value: &serde_json::Value,
	ops: &mut Vec<Op>,
) -> Result<(), SessionError> {
	let object = value.as_object();
	// Ordered output bytes are revealed by the dispatcher's bounded DOM stream.
	// Its journaled typed update retains only metadata plus an emptied `data`
	// field and must not overwrite or prefix that authoritative stream.
	if object.is_some_and(|map| {
		map.get("sequence")
			.and_then(serde_json::Value::as_u64)
			.is_some()
			&& map.get("data").is_some_and(|data| match data {
				serde_json::Value::String(text) => text.is_empty(),
				serde_json::Value::Array(bytes) => bytes.is_empty(),
				_ => false,
			})
	}) {
		return Ok(());
	}
	if let Some(raw) = object.and_then(|map| map.get("diag").or_else(|| map.get("diagnostic"))) {
		// Every diagnostic is its own structured child (ADR 0008); a tool
		// that emits several keeps all of them on the element and on replay.
		// Data remains the typed authority. Text is only the human projection:
		// serializing the object there leaks transport JSON into every card.
		// Extension tools may send a bare string or a loosely shaped object;
		// `Diag` decodes both leniently.
		let diag = match raw {
			serde_json::Value::String(text) => Diag { text: Str::new(text), ..Diag::default() },
			_ => Diag::deserialize(raw)?,
		};
		let mut node = NodeSpec::new(KnownTag::Diag)
			.with_prop(PropId::Severity, Value::Str(Str::new_static(diag.severity.into())))
			.with_prop(PropId::Kind, Value::Str(diag.kind.clone()))
			.with_prop(PropId::Data, Value::Json(RawValue::from_string(serde_json::to_string(raw)?)?));
		if !diag.text.is_empty() {
			node = node.with_prop(PropId::Text, Value::Str(diag.text.clone()));
		}
		if let Some(continuation) = &diag.continuation {
			node = node.with_prop(PropId::Continuation, Value::Str(continuation.clone()));
		}
		if let Some(artifact) = &diag.artifact {
			node = node.with_prop(PropId::Recovery, Value::Str(artifact.clone()));
		}
		if let Some(omitted) = diag.omitted {
			node = node
				.with_prop(
					PropId::Omitted,
					Value::Int(i64::try_from(omitted.count).unwrap_or(i64::MAX)),
				)
				.with_prop(PropId::Unit, Value::Str(Str::new_static(omitted.unit.into())));
		}
		ops.push(Op::Ins {
			parent: call,
			after: last_child_with_tag(dom, call, KnownTag::Diag)
				.or_else(|| dom.children(call).last().copied()),
			node,
		});
		return Ok(());
	}
	let (target, severity, projected) = if let Some(usage) = object.and_then(|map| map.get("usage"))
	{
		(KnownTag::Usage, None, usage)
	} else {
		let result = object
			.and_then(|map| {
				map.get("result")
					.or_else(|| map.get("output"))
					.or_else(|| map.get("text"))
			})
			.unwrap_or(value);
		(KnownTag::Result, None, result)
	};
	let child = child_with_tag(dom, call, target).ok_or(SessionError::NoActiveTurn)?;
	let text = match projected {
		serde_json::Value::String(text) => Str::new(text),
		_ => Str::new(serde_json::to_string(projected)?),
	};
	ops.push(Op::Set { h: child, prop: PropId::Text.into(), value: Value::Str(text) });
	ops.push(Op::Set {
		h:     child,
		prop:  PropId::Data.into(),
		value: Value::Json(RawValue::from_string(serde_json::to_string(projected)?)?),
	});
	if let Some(severity) = severity {
		ops.push(Op::Set {
			h:     child,
			prop:  PropId::Severity.into(),
			value: Value::Str(Str::new_static(severity)),
		});
	}
	Ok(())
}

fn json_text(raw: &RawValue) -> Str {
	serde_json::from_str::<Str>(raw.get()).unwrap_or_else(|_| Str::new(raw.get()))
}

/// Text projection of a journaled outcome when no prompt parts were
/// recorded: the `value` of a `CallOutcome` envelope
/// (`{"kind":…,"value":…}`), else the raw JSON.
fn outcome_text(raw: &RawValue) -> Str {
	#[derive(Deserialize)]
	struct Envelope<'a> {
		#[expect(dead_code, reason = "presence proves the envelope shape")]
		kind:  &'a str,
		value: Option<Box<RawValue>>,
	}
	match serde_json::from_str::<Envelope<'_>>(raw.get()) {
		Ok(Envelope { value: Some(value), .. }) => json_text(&value),
		Ok(Envelope { value: None, .. }) | Err(_) => json_text(raw),
	}
}

pub fn prompt_parts_text(raw: &RawValue) -> Result<Str, SessionError> {
	let parts: Vec<ToolPart> = serde_json::from_str(raw.get())?;
	let mut text = String::new();
	for part in parts {
		match part {
			ToolPart::Text { text: part } => text.push_str(part.as_str()),
			ToolPart::Json { json } => {
				let part = std::str::from_utf8(&json)
					.map_err(|source| SessionError::ToolPartUtf8 { source })?;
				text.push_str(part);
			},
			ToolPart::Blob { alt: Some(part), .. } => text.push_str(part.as_str()),
			ToolPart::Blob { alt: None, .. } => {},
		}
	}
	Ok(Str::new(text))
}

/// Recognizes both custom-message DOM shapes used by prior omp journals:
/// `<developer kind=custom name=handoff>` and the older
/// `<notice kind=custom name=handoff>`.
fn legacy_handoff_document(node: &NodeSpec) -> Option<Str> {
	if !matches!(&node.tag, Tag::Known(KnownTag::Developer | KnownTag::Notice)) {
		return None;
	}
	let prop = |key: PropKey| {
		node
			.props
			.iter()
			.find_map(|(candidate, value)| (candidate == &key).then_some(value))
	};
	if prop(PropId::Kind.into()).and_then(Value::as_str) != Some("custom")
		|| prop(PropId::Name.into()).and_then(Value::as_str) != Some("handoff")
		|| matches!(
			prop(PropKey::Custom(Str::new_static(crate::custom_message::DISPLAY_PROP))),
			Some(Value::Bool(false))
		) {
		return None;
	}
	Some(node.content.as_ref().map_or_else(Str::default, |body| {
		let document = crate::custom_message::extract_handoff_document(body.as_str());
		body.slice_ref(document)
	}))
}

fn unsigned(value: u64) -> Value {
	Value::Int(i64::try_from(value).unwrap_or(i64::MAX))
}

fn blob_address(blob: &BlobRef) -> Str {
	Str::new(format!("artifact://sha256/{}", blob.to_hex()))
}
