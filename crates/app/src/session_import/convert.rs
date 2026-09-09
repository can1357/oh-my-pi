use std::{
	fs,
	path::Path,
	time::{SystemTime, UNIX_EPOCH},
};

use miette::{IntoDiagnostic as _, miette};
use omp_core::{FastHashMap, FastHashSet, Str, base64};
use omp_dom::{Handle, KnownTag, NodeSpec, Op, PropId, PropKey, Tag, Txn, Value as DomValue};
use omp_journal::{
	EntryId,
	data::{Attachment, TurnReceipt},
};
use omp_session::{ComponentRegistry, Session};
use omp_tool::Part as ToolPart;
use serde_json::{Map, Value, json, value::RawValue};

use super::ForeignFormat;

struct SourceRecord {
	line:  usize,
	value: Value,
}

#[derive(Default)]
struct SourceMetadata {
	id:         Option<Str>,
	cwd:        Option<Str>,
	title:      Option<Str>,
	created_ms: Option<u64>,
	updated_ms: Option<u64>,
	records:    usize,
	malformed:  usize,
}

struct ImportState {
	model:       Str,
	provider:    &'static str,
	route:       &'static str,
	messages:    usize,
	fallback_ms: u64,
}

pub(super) fn import_file(
	format: ForeignFormat,
	source: &Path,
	destination: &Path,
) -> miette::Result<usize> {
	if destination.extension().and_then(|value| value.to_str()) != Some("oms") {
		return Err(miette!("native session destination must use the .oms extension"));
	}
	if let Some(parent) = destination.parent() {
		fs::create_dir_all(parent).into_diagnostic()?;
	}
	let bytes = fs::read(source).into_diagnostic()?;
	let (records, mut metadata) = parse_records(&bytes);
	let file_metadata = fs::metadata(source).into_diagnostic()?;
	let fallback_ms = system_time_millis(file_metadata.modified().unwrap_or(UNIX_EPOCH));
	scan_metadata(&records, fallback_ms, &mut metadata);

	let mut session =
		Session::create(destination, ComponentRegistry::standard()).into_diagnostic()?;
	let source_blob = session
		.store_attachment("application/x-ndjson", &bytes)
		.into_diagnostic()?;
	let source_hash = Str::new(source_blob.blob.to_hex().as_str());
	let source_address = Str::new(format!("artifact://sha256/{source_hash}"));
	let format_name = format.to_string().to_ascii_lowercase();
	let provenance = json!({
		"format": format_name.as_str(),
		"source_path": source.to_string_lossy(),
		"source_id": metadata.id.as_deref(),
		"source_cwd": metadata.cwd.as_deref(),
		"title": metadata.title.as_deref(),
		"created_ms": metadata.created_ms,
		"updated_ms": metadata.updated_ms,
		"records": metadata.records,
		"malformed_rows": metadata.malformed,
		"source_blob": {
			"h": source_hash,
			"n": source_blob.blob.size,
			"mime": source_blob.mime.clone(),
		},
	});
	let meta = session.dom().meta();
	let cause = head(&session)?;
	let provenance_raw = serde_json::value::to_raw_value(&provenance).into_diagnostic()?;
	session
		.patch(Txn {
			cause,
			label: Some(Str::new_static("session.import")),
			ops: vec![
				Op::Set {
					h:     meta,
					prop:  PropKey::Custom(Str::new_static("import-source")),
					value: DomValue::Str(Str::new(source.to_string_lossy())),
				},
				Op::Set {
					h:     meta,
					prop:  PropKey::Custom(Str::new_static("import-format")),
					value: DomValue::Str(Str::new(format_name.as_str())),
				},
				Op::Set {
					h:     meta,
					prop:  PropKey::Custom(Str::new_static("import-source-blob")),
					value: DomValue::Str(source_address.clone()),
				},
				Op::Ins {
					parent: meta,
					after:  session.dom().children(meta).last().copied(),
					node:   NodeSpec::new(Tag::Custom(Str::new_static("foreign-import")))
						.with_prop(PropId::Data, DomValue::Json(provenance_raw))
						.with_prop(PropId::Blob, DomValue::Str(source_address))
						.with_prop(PropId::Mime, DomValue::Str(source_blob.mime))
						.with_prop(
							PropKey::Custom(Str::new_static("size")),
							DomValue::Int(i64::try_from(source_blob.blob.size).unwrap_or(i64::MAX)),
						),
				},
			],
		})
		.into_diagnostic()?;
	let mut metadata_ops = Vec::new();
	if let Some(title) = &metadata.title {
		metadata_ops.push(Op::Set {
			h:     meta,
			prop:  PropId::Name.into(),
			value: DomValue::Str(title.clone()),
		});
	}
	if let Some(id) = &metadata.id {
		metadata_ops.push(Op::Set {
			h:     meta,
			prop:  PropKey::Custom(Str::new_static("import-source-id")),
			value: DomValue::Str(id.clone()),
		});
	}
	if let Some(cwd) = &metadata.cwd {
		metadata_ops.push(Op::Set {
			h:     meta,
			prop:  PropKey::Custom(Str::new_static("import-source-cwd")),
			value: DomValue::Str(cwd.clone()),
		});
	}
	if !metadata_ops.is_empty() {
		let cause = head(&session)?;
		session
			.patch(Txn {
				cause,
				label: Some(Str::new_static("session.import.metadata")),
				ops: metadata_ops,
			})
			.into_diagnostic()?;
	}
	let base = head(&session)?;
	let mut state = ImportState {
		model: Str::new_static(match format {
			ForeignFormat::Claude => "unknown",
			ForeignFormat::Codex => "codex",
		}),
		provider: match format {
			ForeignFormat::Claude => "anthropic",
			ForeignFormat::Codex => "openai-codex",
		},
		route: match format {
			ForeignFormat::Claude => "anthropic-messages",
			ForeignFormat::Codex => "openai-codex-responses",
		},
		messages: 0,
		fallback_ms,
	};
	match format {
		ForeignFormat::Claude => import_claude(&mut session, &records, base, &mut state)?,
		ForeignFormat::Codex => import_codex(&mut session, &records, base, &mut state)?,
	}
	session
		.record_exit(omp_session::ExitCause::Normal)
		.into_diagnostic()?;
	Ok(state.messages)
}

fn parse_records(bytes: &[u8]) -> (Vec<SourceRecord>, SourceMetadata) {
	let mut records = Vec::new();
	let mut metadata = SourceMetadata::default();
	for (index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
		let line = line.strip_suffix(b"\r").unwrap_or(line);
		if line.iter().all(u8::is_ascii_whitespace) {
			continue;
		}
		match serde_json::from_slice::<Value>(line) {
			Ok(value) if value.is_object() => {
				records.push(SourceRecord { line: index + 1, value });
			},
			Ok(_) | Err(_) => metadata.malformed += 1,
		}
	}
	metadata.records = records.len();
	(records, metadata)
}

fn scan_metadata(records: &[SourceRecord], fallback_ms: u64, metadata: &mut SourceMetadata) {
	for record in records {
		let value = object(&record.value);
		let payload = value
			.get("payload")
			.and_then(Value::as_object)
			.unwrap_or(value);
		metadata.id = metadata.id.take().or_else(|| {
			string(value, "sessionId")
				.or_else(|| string(value, "session_id"))
				.or_else(|| {
					(value.get("type").and_then(Value::as_str) == Some("session_meta"))
						.then(|| string(payload, "id"))
						.flatten()
				})
		});
		metadata.cwd = metadata
			.cwd
			.take()
			.or_else(|| string(value, "cwd").or_else(|| string(payload, "cwd")));
		if value.get("type").and_then(Value::as_str) == Some("custom-title") {
			metadata.title = string(value, "customTitle").or(metadata.title.take());
		} else if value.get("type").and_then(Value::as_str) == Some("ai-title") {
			metadata.title = metadata.title.take().or_else(|| string(value, "aiTitle"));
		} else if payload.get("type").and_then(Value::as_str) == Some("thread_name_updated") {
			metadata.title = string(payload, "thread_name").or(metadata.title.take());
		} else {
			metadata.title = metadata
				.title
				.take()
				.or_else(|| string(value, "title").or_else(|| string(payload, "title")));
		}
		let timestamp = source_timestamp(&record.value, fallback_ms);
		metadata.created_ms = Some(
			metadata
				.created_ms
				.map_or(timestamp.ms, |old| old.min(timestamp.ms)),
		);
		metadata.updated_ms = Some(
			metadata
				.updated_ms
				.map_or(timestamp.ms, |old| old.max(timestamp.ms)),
		);
	}
	if records.is_empty() {
		metadata.created_ms = Some(fallback_ms);
		metadata.updated_ms = Some(fallback_ms);
	}
}

fn import_claude(
	session: &mut Session,
	records: &[SourceRecord],
	base: EntryId,
	state: &mut ImportState,
) -> miette::Result<()> {
	let mut parents = FastHashMap::<Str, Option<Str>>::default();
	for record in records {
		let value = object(&record.value);
		if let Some(id) = string(value, "uuid") {
			parents.insert(id, string(value, "parentUuid"));
		}
	}
	let mut tails = FastHashMap::<Str, EntryId>::default();
	for record in records {
		let value = object(&record.value);
		if value.get("isSidechain").and_then(Value::as_bool) == Some(true)
			|| value.get("isMeta").and_then(Value::as_bool) == Some(true)
		{
			continue;
		}
		let kind = value.get("type").and_then(Value::as_str);
		if !matches!(kind, Some("user" | "assistant")) {
			continue;
		}
		let Some(message) = value.get("message").and_then(Value::as_object) else {
			continue;
		};
		let id = string(value, "uuid").unwrap_or_else(|| Str::new(format!("line-{}", record.line)));
		let parent = string(value, "parentUuid");
		let target = if value.contains_key("parentUuid") {
			resolve_parent(parent.as_ref(), &parents, &tails, base)
		} else {
			head(session)?
		};
		if head(session)? != target {
			session.rewind(target).into_diagnostic()?;
		}
		let stamp = source_timestamp(&record.value, state.fallback_ms);
		match kind {
			Some("user") => {
				import_claude_user(session, record, message, &id, parent.as_ref(), &stamp, state)?
			},
			Some("assistant") => {
				import_claude_assistant(session, record, message, &id, parent.as_ref(), &stamp, state)?
			},
			_ => {},
		}
		tails.insert(id, head(session)?);
	}
	Ok(())
}

fn import_claude_user(
	session: &mut Session,
	record: &SourceRecord,
	message: &Map<String, Value>,
	source_id: &Str,
	parent: Option<&Str>,
	stamp: &SourceTimestamp,
	state: &mut ImportState,
) -> miette::Result<()> {
	let content = message.get("content").unwrap_or(&Value::Null);
	let mut user_blocks = Vec::new();
	let mut tool_results = Vec::new();
	if let Some(blocks) = content.as_array() {
		for block in blocks {
			if block.get("type").and_then(Value::as_str) == Some("tool_result") {
				tool_results.push(block);
			} else {
				user_blocks.push(block.clone());
			}
		}
	}
	for block in tool_results {
		import_tool_result(
			session,
			record,
			block.get("tool_use_id").and_then(Value::as_str),
			None,
			block.get("content").unwrap_or(&Value::Null),
			block.get("is_error").and_then(Value::as_bool) == Some(true),
			stamp,
			state,
		)?;
	}
	let visible = if content.is_string() {
		content.clone()
	} else {
		Value::Array(user_blocks)
	};
	let (text, attachments) = materialize_content(session, &visible)?;
	if !text.is_empty() || !attachments.is_empty() {
		session.begin_turn().into_diagnostic()?;
		session.user(text, attachments).into_diagnostic()?;
		let user = last_child_with_tag(session, last_turn(session)?, KnownTag::User)?;
		patch_record(session, user, record, Some(source_id), parent, stamp, "foreign.message")?;
		state.messages += 1;
	}
	Ok(())
}

fn import_claude_assistant(
	session: &mut Session,
	record: &SourceRecord,
	message: &Map<String, Value>,
	source_id: &Str,
	parent: Option<&Str>,
	stamp: &SourceTimestamp,
	state: &mut ImportState,
) -> miette::Result<()> {
	ensure_turn(session)?;
	if let Some(model) = string(message, "model") {
		state.model = model;
	}
	session
		.assistant_start(state.model.clone(), state.provider, state.route)
		.into_diagnostic()?;
	let assistant = last_child_with_tag(session, last_turn(session)?, KnownTag::Assistant)?;
	let mut block_index = 0_i64;
	if let Some(text) = message.get("content").and_then(Value::as_str) {
		insert_assistant_content(
			session,
			assistant,
			"text",
			text,
			block_index,
			message.get("content").expect("content was present"),
		)?;
	} else if let Some(blocks) = message.get("content").and_then(Value::as_array) {
		for block in blocks {
			match block.get("type").and_then(Value::as_str) {
				Some("text") => {
					if let Some(text) = block.get("text").and_then(Value::as_str) {
						insert_assistant_content(session, assistant, "text", text, block_index, block)?;
						block_index += 1;
					}
				},
				Some("thinking") => {
					if let Some(text) = block.get("thinking").and_then(Value::as_str) {
						insert_assistant_content(
							session,
							assistant,
							"thinking",
							text,
							block_index,
							block,
						)?;
						block_index += 1;
					}
				},
				Some("tool_use") => {
					import_tool_call(session, record, block, stamp, Some(block_index))?;
					block_index += 1;
				},
				_ => {},
			}
		}
	}
	let stop = message
		.get("stop_reason")
		.and_then(Value::as_str)
		.unwrap_or("stop");
	session.assistant_end(stop).into_diagnostic()?;
	patch_record(session, assistant, record, Some(source_id), parent, stamp, "foreign.message")?;
	if let Some(response_id) = message.get("id").and_then(Value::as_str) {
		patch_string(session, assistant, "foreign-response-id", response_id, "foreign.response")?;
	}
	if let Some(error) = object(&record.value).get("error").and_then(Value::as_str) {
		let status = object(&record.value)
			.get("apiErrorStatus")
			.and_then(Value::as_i64);
		append_assistant_error(session, assistant, error, status, record)?;
	}
	if let Some(usage) = message.get("usage").and_then(Value::as_object) {
		append_receipt(session, usage, stamp, state.provider, state.model.as_str())?;
	}
	state.messages += 1;
	Ok(())
}

fn import_codex(
	session: &mut Session,
	records: &[SourceRecord],
	base: EntryId,
	state: &mut ImportState,
) -> miette::Result<()> {
	let canonical = codex_canonical(records);
	let mut turn_bases = Vec::<EntryId>::new();
	for record in records {
		let value = object(&record.value);
		let Some(payload) = value.get("payload").and_then(Value::as_object) else {
			continue;
		};
		let stamp = source_timestamp(&record.value, state.fallback_ms);
		match value.get("type").and_then(Value::as_str) {
			Some("turn_context") => {
				if let Some(model) = string(payload, "model") {
					state.model = model;
				}
			},
			Some("response_item") => {
				import_codex_response(session, record, payload, &stamp, state, &mut turn_bases)?
			},
			Some("event_msg") => import_codex_event(
				session,
				record,
				payload,
				&stamp,
				state,
				&canonical,
				&mut turn_bases,
				base,
			)?,
			Some("compacted") => append_foreign_meta(session, record, "foreign-compaction", &stamp)?,
			Some("session_meta") => {},
			Some(_) | None => append_foreign_meta(session, record, "foreign-entry", &stamp)?,
		}
	}
	Ok(())
}

#[derive(Default)]
struct Canonical {
	users:      FastHashSet<Str>,
	assistants: FastHashSet<Str>,
	calls:      FastHashSet<Str>,
}

fn codex_canonical(records: &[SourceRecord]) -> Canonical {
	let mut out = Canonical::default();
	for record in records {
		let value = object(&record.value);
		if value.get("type").and_then(Value::as_str) != Some("response_item") {
			continue;
		}
		let Some(payload) = value.get("payload").and_then(Value::as_object) else {
			continue;
		};
		let kind = payload
			.get("type")
			.and_then(Value::as_str)
			.unwrap_or_default();
		if kind == "message" {
			let text = content_text(payload.get("content").unwrap_or(&Value::Null));
			match payload.get("role").and_then(Value::as_str) {
				Some("user") if !text.is_empty() => {
					out.users.insert(Str::new(text));
				},
				Some("assistant") if !text.is_empty() => {
					out.assistants.insert(Str::new(text));
				},
				_ => {},
			}
		}
		if kind.contains("call") {
			if let Some(id) = payload
				.get("call_id")
				.and_then(Value::as_str)
				.or_else(|| payload.get("id").and_then(Value::as_str))
			{
				out.calls.insert(Str::new(id));
			}
		}
	}
	out
}

fn import_codex_response(
	session: &mut Session,
	record: &SourceRecord,
	payload: &Map<String, Value>,
	stamp: &SourceTimestamp,
	state: &mut ImportState,
	turn_bases: &mut Vec<EntryId>,
) -> miette::Result<()> {
	let kind = payload
		.get("type")
		.and_then(Value::as_str)
		.unwrap_or_default();
	match kind {
		"message" => {
			let role = payload
				.get("role")
				.and_then(Value::as_str)
				.unwrap_or("unknown");
			match role {
				"user" => append_user(
					session,
					record,
					payload.get("content").unwrap_or(&Value::Null),
					stamp,
					state,
					turn_bases,
				)?,
				"assistant" => append_assistant(
					session,
					record,
					payload.get("content").unwrap_or(&Value::Null),
					stamp,
					state,
					"stop",
				)?,
				_ => append_foreign_role(
					session,
					record,
					role,
					payload.get("content").unwrap_or(&Value::Null),
					stamp,
				)?,
			}
		},
		"reasoning" => {
			let mut blocks = Vec::new();
			for key in ["summary", "content"] {
				if let Some(items) = payload.get(key).and_then(Value::as_array) {
					for item in items {
						if let Some(text) = item.get("text").and_then(Value::as_str) {
							blocks.push(json!({"type":"thinking", "text":text}));
						}
					}
				}
			}
			append_assistant(session, record, &Value::Array(blocks), stamp, state, "stop")?;
		},
		"function_call" | "custom_tool_call" | "web_search_call" | "tool_search_call" => {
			ensure_turn(session)?;
			ensure_assistant_for_call(session, record, payload, stamp, state)?;
		},
		"function_call_output" | "custom_tool_call_output" | "tool_search_output" => {
			let output = payload
				.get("output")
				.or_else(|| payload.get("tools"))
				.unwrap_or(&Value::Null);
			import_tool_result(
				session,
				record,
				payload.get("call_id").and_then(Value::as_str),
				None,
				output,
				payload.get("status").and_then(Value::as_str) == Some("failed"),
				stamp,
				state,
			)?;
		},
		other if other.ends_with("_call") => {
			ensure_turn(session)?;
			ensure_assistant_for_call(session, record, payload, stamp, state)?;
		},
		other if other.ends_with("_output") => {
			import_tool_result(
				session,
				record,
				payload
					.get("call_id")
					.and_then(Value::as_str)
					.or_else(|| payload.get("id").and_then(Value::as_str)),
				None,
				payload
					.get("output")
					.or_else(|| payload.get("result"))
					.unwrap_or(&Value::Null),
				payload.get("status").and_then(Value::as_str) == Some("failed"),
				stamp,
				state,
			)?;
		},
		_ => append_foreign_meta(session, record, "foreign-entry", stamp)?,
	}
	Ok(())
}

fn import_codex_event(
	session: &mut Session,
	record: &SourceRecord,
	payload: &Map<String, Value>,
	stamp: &SourceTimestamp,
	state: &mut ImportState,
	canonical: &Canonical,
	turn_bases: &mut Vec<EntryId>,
	base: EntryId,
) -> miette::Result<()> {
	let kind = payload
		.get("type")
		.and_then(Value::as_str)
		.unwrap_or_default();
	match kind {
		"user_message" => {
			if let Some(text) = payload.get("message").and_then(Value::as_str) {
				if !canonical.users.contains(text) {
					append_user(
						session,
						record,
						&Value::String(text.to_owned()),
						stamp,
						state,
						turn_bases,
					)?;
				}
			}
		},
		"agent_message" | "agent_reasoning" => {
			let text = payload
				.get("message")
				.or_else(|| payload.get("text"))
				.and_then(Value::as_str);
			if let Some(text) = text {
				if !canonical.assistants.contains(text) {
					let block_kind = if kind == "agent_reasoning" {
						"thinking"
					} else {
						"text"
					};
					append_assistant(
						session,
						record,
						&json!([{"type":block_kind,"text":text}]),
						stamp,
						state,
						"stop",
					)?;
				}
			}
		},
		"dynamic_tool_call_request" => {
			let call_id = payload
				.get("callId")
				.and_then(Value::as_str)
				.or_else(|| payload.get("call_id").and_then(Value::as_str));
			if call_id.is_none_or(|id| !canonical.calls.contains(id)) {
				ensure_turn(session)?;
				ensure_assistant_for_call(session, record, payload, stamp, state)?;
			}
		},
		"dynamic_tool_call_response" => {
			let call_id = payload
				.get("call_id")
				.and_then(Value::as_str)
				.or_else(|| payload.get("callId").and_then(Value::as_str));
			if call_id.is_none_or(|id| !canonical.calls.contains(id)) {
				let error = payload.get("error").and_then(Value::as_str);
				let content = error
					.map(|error| Value::String(error.to_owned()))
					.or_else(|| payload.get("content_items").cloned())
					.unwrap_or(Value::Null);
				import_tool_result(
					session,
					record,
					call_id,
					payload.get("tool").and_then(Value::as_str),
					&content,
					error.is_some() || payload.get("success").and_then(Value::as_bool) == Some(false),
					stamp,
					state,
				)?;
			}
		},
		"web_search_end" => {
			import_terminal_tool_event(session, record, payload, "web_search", stamp, state)?
		},
		"mcp_tool_call_end" => {
			let name = payload
				.get("invocation")
				.and_then(Value::as_object)
				.and_then(|invocation| {
					Some(format!("{}/{}", string(invocation, "server")?, string(invocation, "tool")?))
				});
			import_terminal_tool_event(
				session,
				record,
				payload,
				name.as_deref().unwrap_or("mcp"),
				stamp,
				state,
			)?;
		},
		"token_count" => {
			ensure_turn(session)?;
			let usage = payload
				.get("info")
				.and_then(Value::as_object)
				.and_then(|info| info.get("total_token_usage").and_then(Value::as_object))
				.unwrap_or(payload);
			append_receipt(session, usage, stamp, state.provider, state.model.as_str())?;
		},
		"thread_rolled_back" => {
			let turns = payload
				.get("num_turns")
				.and_then(Value::as_u64)
				.unwrap_or(0) as usize;
			if turns > 0 {
				let keep = turn_bases.len().saturating_sub(turns);
				let target = if keep == 0 { base } else { turn_bases[keep] };
				session.rewind(target).into_diagnostic()?;
				turn_bases.truncate(keep);
			}
			append_foreign_meta(session, record, "foreign-rollback", stamp)?;
		},
		"thread_name_updated" => append_foreign_meta(session, record, "foreign-title", stamp)?,
		"error" | "turn_aborted" | "stream_error" => {
			append_error_notice(session, record, payload, stamp)?
		},
		_ => append_foreign_meta(session, record, "foreign-entry", stamp)?,
	}
	Ok(())
}

fn append_user(
	session: &mut Session,
	record: &SourceRecord,
	content: &Value,
	stamp: &SourceTimestamp,
	state: &mut ImportState,
	turn_bases: &mut Vec<EntryId>,
) -> miette::Result<()> {
	let parent = head(session)?;
	let (text, attachments) = materialize_content(session, content)?;
	if text.is_empty() && attachments.is_empty() {
		return Ok(());
	}
	turn_bases.push(parent);
	session.begin_turn().into_diagnostic()?;
	session.user(text, attachments).into_diagnostic()?;
	let user = last_child_with_tag(session, last_turn(session)?, KnownTag::User)?;
	patch_record(session, user, record, None, None, stamp, "foreign.message")?;
	state.messages += 1;
	Ok(())
}

fn append_assistant(
	session: &mut Session,
	record: &SourceRecord,
	content: &Value,
	stamp: &SourceTimestamp,
	state: &mut ImportState,
	stop: &str,
) -> miette::Result<()> {
	ensure_turn(session)?;
	session
		.assistant_start(state.model.clone(), state.provider, state.route)
		.into_diagnostic()?;
	let assistant = last_child_with_tag(session, last_turn(session)?, KnownTag::Assistant)?;
	let blocks = content
		.as_array()
		.cloned()
		.unwrap_or_else(|| vec![content.clone()]);
	let mut index = 0_i64;
	for block in &blocks {
		let kind = block.get("type").and_then(Value::as_str).unwrap_or("text");
		let text = block
			.get("text")
			.and_then(Value::as_str)
			.or_else(|| block.as_str());
		if let Some(text) = text {
			let semantic = if kind.contains("reason") || kind == "thinking" {
				"thinking"
			} else {
				"text"
			};
			insert_assistant_content(session, assistant, semantic, text, index, block)?;
			index += 1;
		}
	}
	session.assistant_end(stop).into_diagnostic()?;
	patch_record(session, assistant, record, None, None, stamp, "foreign.message")?;
	state.messages += 1;
	Ok(())
}

fn ensure_assistant_for_call(
	session: &mut Session,
	record: &SourceRecord,
	payload: &Map<String, Value>,
	stamp: &SourceTimestamp,
	state: &mut ImportState,
) -> miette::Result<()> {
	session
		.assistant_start(state.model.clone(), state.provider, state.route)
		.into_diagnostic()?;
	let assistant = last_child_with_tag(session, last_turn(session)?, KnownTag::Assistant)?;
	import_tool_call(session, record, &Value::Object(payload.clone()), stamp, None)?;
	session.assistant_end("toolUse").into_diagnostic()?;
	patch_record(session, assistant, record, None, None, stamp, "foreign.message")?;
	state.messages += 1;
	Ok(())
}

fn import_tool_call(
	session: &mut Session,
	record: &SourceRecord,
	block: &Value,
	stamp: &SourceTimestamp,
	provider_index: Option<i64>,
) -> miette::Result<EntryId> {
	let object = object(block);
	let kind = object
		.get("type")
		.and_then(Value::as_str)
		.unwrap_or("tool_call");
	let call_id = object
		.get("id")
		.and_then(Value::as_str)
		.or_else(|| object.get("call_id").and_then(Value::as_str))
		.or_else(|| object.get("callId").and_then(Value::as_str))
		.unwrap_or("foreign-call");
	let name = object
		.get("name")
		.and_then(Value::as_str)
		.or_else(|| object.get("tool").and_then(Value::as_str))
		.unwrap_or_else(|| kind.strip_suffix("_call").unwrap_or("foreign-tool"));
	let arguments = object
		.get("input")
		.or_else(|| object.get("arguments"))
		.or_else(|| object.get("action"))
		.or_else(|| object.get("command"))
		.cloned()
		.unwrap_or_else(|| Value::Object(Map::new()));
	let arguments = if let Some(text) = arguments.as_str() {
		serde_json::from_str(text).unwrap_or_else(|_| json!({"input": text}))
	} else {
		arguments
	};
	let args = serde_json::value::to_raw_value(&arguments).into_diagnostic()?;
	let call = session
		.call(name, 1, call_id, None, Some(args), None)
		.into_diagnostic()?;
	let handle = tool_handle(session, call)?;
	patch_record(session, handle, record, None, None, stamp, "foreign.tool-call")?;
	patch_value(
		session,
		handle,
		"foreign-tool-block",
		DomValue::Json(serde_json::value::to_raw_value(block).into_diagnostic()?),
		"foreign.tool-call",
	)?;
	if let Some(index) = provider_index {
		patch_value(
			session,
			handle,
			omp_session::PROVIDER_BLOCK_INDEX_PROP,
			DomValue::Int(index),
			"foreign.tool-call",
		)?;
	}
	Ok(call)
}

fn import_tool_result(
	session: &mut Session,
	record: &SourceRecord,
	call_id: Option<&str>,
	name: Option<&str>,
	content: &Value,
	is_error: bool,
	stamp: &SourceTimestamp,
	state: &mut ImportState,
) -> miette::Result<()> {
	ensure_turn(session)?;
	let call_id = call_id.unwrap_or("foreign-call");
	let call = match session
		.unsettled_calls()
		.into_iter()
		.rev()
		.find(|call| call.call_id.as_str() == call_id)
	{
		Some(call) => call.entry,
		None => {
			session
				.assistant_start(state.model.clone(), state.provider, state.route)
				.into_diagnostic()?;
			let call = session
				.call(name.unwrap_or("unknown"), 1, call_id, None, Some(raw(json!({}))?), None)
				.into_diagnostic()?;
			session.assistant_end("toolUse").into_diagnostic()?;
			call
		},
	};
	let parts = materialize_tool_parts(session, content)?;
	let prompt = serde_json::value::to_raw_value(&parts).into_diagnostic()?;
	let envelope = raw(json!({"kind":"foreign", "value": content, "source_line": record.line}))?;
	if is_error {
		session
			.fail_projected(call, envelope, prompt)
			.into_diagnostic()?;
	} else {
		session
			.settle_projected(call, envelope, prompt)
			.into_diagnostic()?;
	}
	let tool = tool_handle(session, call)?;
	let terminal = if is_error {
		session
			.dom()
			.children(tool)
			.iter()
			.rev()
			.copied()
			.find(|handle| {
				session
					.dom()
					.get(*handle)
					.is_some_and(|node| node.tag == Tag::Known(KnownTag::Diag))
			})
	} else {
		session.dom().children(tool).iter().copied().find(|handle| {
			session
				.dom()
				.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Result))
		})
	}
	.ok_or_else(|| miette!("imported tool terminal node is absent"))?;
	patch_record(session, terminal, record, None, None, stamp, "foreign.tool-result")?;
	state.messages += 1;
	Ok(())
}

fn import_terminal_tool_event(
	session: &mut Session,
	record: &SourceRecord,
	payload: &Map<String, Value>,
	name: &str,
	stamp: &SourceTimestamp,
	state: &mut ImportState,
) -> miette::Result<()> {
	let call_id = payload
		.get("call_id")
		.and_then(Value::as_str)
		.or_else(|| payload.get("callId").and_then(Value::as_str))
		.unwrap_or("foreign-call");
	if !session
		.unsettled_calls()
		.iter()
		.any(|call| call.call_id.as_str() == call_id)
	{
		ensure_turn(session)?;
		session
			.assistant_start(state.model.clone(), state.provider, state.route)
			.into_diagnostic()?;
		let args = payload
			.get("action")
			.or_else(|| payload.get("query"))
			.or_else(|| payload.get("invocation"))
			.cloned()
			.unwrap_or_else(|| json!({}));
		session
			.call(name, 1, call_id, None, Some(raw(args)?), None)
			.into_diagnostic()?;
		session.assistant_end("toolUse").into_diagnostic()?;
	}
	let result = payload
		.get("results")
		.or_else(|| payload.get("result"))
		.or_else(|| payload.get("query"))
		.unwrap_or(&Value::Null);
	let error = result.get("Err").and_then(Value::as_str);
	let content = if let Some(error) = error {
		Value::String(error.to_owned())
	} else if let Some(ok) = result.get("Ok") {
		ok.get("content").unwrap_or(ok).clone()
	} else {
		result.clone()
	};
	import_tool_result(
		session,
		record,
		Some(call_id),
		Some(name),
		&content,
		error.is_some(),
		stamp,
		state,
	)
}

fn append_receipt(
	session: &mut Session,
	usage: &Map<String, Value>,
	stamp: &SourceTimestamp,
	provider: &str,
	model: &str,
) -> miette::Result<()> {
	let tokens_in = integer(usage, &["input_tokens", "input", "total_input_tokens"]);
	let tokens_out = integer(usage, &["output_tokens", "output", "total_output_tokens"]);
	let cache_read =
		integer(usage, &["cache_read_input_tokens", "cached_input_tokens", "cache_read"]);
	let cache_write = integer(usage, &["cache_creation_input_tokens", "cache_write"]);
	session
		.receipt(TurnReceipt {
			tokens_in,
			tokens_out,
			cache_read,
			cache_write,
			..TurnReceipt::default()
		})
		.into_diagnostic()?;
	let usage_handle = last_child_with_tag(session, last_turn(session)?, KnownTag::Usage)?;
	patch_value(
		session,
		usage_handle,
		"foreign-usage",
		DomValue::Json(serde_json::value::to_raw_value(usage).into_diagnostic()?),
		"foreign.usage",
	)?;
	patch_value(
		session,
		usage_handle,
		"source-timestamp-ms",
		DomValue::Int(i64::try_from(stamp.ms).unwrap_or(i64::MAX)),
		"foreign.timestamp",
	)?;
	patch_string(session, usage_handle, "foreign-provider", provider, "foreign.usage")?;
	patch_string(session, usage_handle, "foreign-model", model, "foreign.usage")?;
	Ok(())
}

fn materialize_content(
	session: &Session,
	content: &Value,
) -> miette::Result<(Str, Vec<Attachment>)> {
	if let Some(text) = content.as_str() {
		return Ok((Str::new(text), Vec::new()));
	}
	let mut text = String::new();
	let mut attachments = Vec::new();
	for block in content.as_array().into_iter().flatten() {
		if let Some(value) = block
			.get("text")
			.and_then(Value::as_str)
			.or_else(|| block.as_str())
		{
			text.push_str(value);
			continue;
		}
		if let Some((mime, bytes)) = image_bytes(block) {
			let attachment = session.store_attachment(mime, &bytes).into_diagnostic()?;
			attachments.push(attachment);
			if !text.is_empty() && !text.ends_with('\n') {
				text.push('\n');
			}
			text.push_str(&format!("[Image #{}]", attachments.len()));
		}
	}
	Ok((Str::new(text), attachments))
}

fn materialize_tool_parts(session: &Session, content: &Value) -> miette::Result<Vec<ToolPart>> {
	if let Some(text) = content.as_str() {
		return Ok(vec![ToolPart::Text { text: Str::new(text) }]);
	}
	let mut parts = Vec::new();
	if let Some(items) = content.as_array() {
		for item in items {
			if let Some(text) = item
				.get("text")
				.and_then(Value::as_str)
				.or_else(|| item.as_str())
			{
				parts.push(ToolPart::Text { text: Str::new(text) });
			} else if let Some((mime, bytes)) = image_bytes(item) {
				let attachment = session.store_attachment(mime, &bytes).into_diagnostic()?;
				let hash = attachment.blob.to_hex();
				parts.push(ToolPart::Blob {
					blob: omp_tool::BlobRef {
						hash:       Str::new(hash.as_str()),
						media_type: attachment.mime,
						byte_len:   attachment.blob.size,
					},
					alt:  Some(Str::new_static("[Imported image]")),
				});
			}
		}
	}
	if parts.is_empty() && !content.is_null() {
		parts.push(ToolPart::Text {
			text: Str::new(serde_json::to_string(content).into_diagnostic()?),
		});
	}
	Ok(parts)
}

fn image_bytes(value: &Value) -> Option<(&str, Vec<u8>)> {
	if value.get("type").and_then(Value::as_str) == Some("image") {
		let source = value.get("source")?.as_object()?;
		let mime = source.get("media_type")?.as_str()?;
		let data = source.get("data")?.as_str()?;
		return base64::decode(data.as_bytes())
			.into_vec()
			.ok()
			.map(|bytes| (mime, bytes));
	}
	if value.get("type").and_then(Value::as_str) == Some("input_image") {
		let url = value.get("image_url")?.as_str()?;
		let rest = url.strip_prefix("data:")?;
		let (mime, encoded) = rest.split_once(";base64,")?;
		return base64::decode(encoded.as_bytes())
			.into_vec()
			.ok()
			.map(|bytes| (mime, bytes));
	}
	None
}

fn insert_assistant_content(
	session: &mut Session,
	assistant: Handle,
	kind: &'static str,
	text: &str,
	index: i64,
	raw_block: &Value,
) -> miette::Result<()> {
	let mut node = NodeSpec::new(Tag::Custom(Str::new_static(omp_session::ASSISTANT_CONTENT_TAG)))
		.with_prop(PropId::Kind, DomValue::Str(Str::new_static(kind)))
		.with_prop(PropId::Text, DomValue::Str(Str::new(text)))
		.with_prop(
			PropKey::Custom(Str::new_static(omp_session::PROVIDER_BLOCK_INDEX_PROP)),
			DomValue::Int(index),
		)
		.with_prop(
			PropKey::Custom(Str::new_static("foreign-block")),
			DomValue::Json(serde_json::value::to_raw_value(raw_block).into_diagnostic()?),
		);
	if let Some(signature) = raw_block.get("signature").and_then(Value::as_str) {
		node = node.with_prop(
			PropKey::Custom(Str::new_static("thinking-signature")),
			DomValue::Str(Str::new(signature)),
		);
	}
	let cause = head(session)?;
	session
		.patch(Txn {
			cause,
			label: Some(Str::new_static("assistant.content")),
			ops: vec![Op::Ins {
				parent: assistant,
				after: session.dom().children(assistant).last().copied(),
				node,
			}],
		})
		.into_diagnostic()?;
	Ok(())
}

fn append_foreign_role(
	session: &mut Session,
	record: &SourceRecord,
	role: &str,
	content: &Value,
	stamp: &SourceTimestamp,
) -> miette::Result<()> {
	ensure_turn(session)?;
	let (text, _) = materialize_content(session, content)?;
	let turn = last_turn(session)?;
	let node = NodeSpec::new(KnownTag::Developer)
		.with_content(text)
		.with_prop(PropKey::Custom(Str::new_static("role")), DomValue::Str(Str::new(role)))
		.with_prop(
			PropKey::Custom(Str::new_static("foreign-record")),
			DomValue::Json(serde_json::value::to_raw_value(&record.value).into_diagnostic()?),
		);
	let cause = head(session)?;
	session
		.patch(Txn {
			cause,
			label: Some(Str::new_static("foreign.message")),
			ops: vec![Op::Ins {
				parent: turn,
				after: session.dom().children(turn).last().copied(),
				node,
			}],
		})
		.into_diagnostic()?;
	let handle = *session
		.dom()
		.children(turn)
		.last()
		.ok_or_else(|| miette!("foreign role node is absent"))?;
	patch_timestamp(session, handle, record.line, stamp, "foreign.timestamp")
}

fn append_foreign_meta(
	session: &mut Session,
	record: &SourceRecord,
	tag: &'static str,
	stamp: &SourceTimestamp,
) -> miette::Result<()> {
	let meta = session.dom().meta();
	let node = NodeSpec::new(Tag::Custom(Str::new_static(tag))).with_prop(
		PropKey::Custom(Str::new_static("foreign-record")),
		DomValue::Json(serde_json::value::to_raw_value(&record.value).into_diagnostic()?),
	);
	let cause = head(session)?;
	session
		.patch(Txn {
			cause,
			label: Some(Str::new_static("foreign.entry")),
			ops: vec![Op::Ins {
				parent: meta,
				after: session.dom().children(meta).last().copied(),
				node,
			}],
		})
		.into_diagnostic()?;
	let handle = *session
		.dom()
		.children(meta)
		.last()
		.ok_or_else(|| miette!("foreign metadata node is absent"))?;
	patch_timestamp(session, handle, record.line, stamp, "foreign.timestamp")
}

fn append_assistant_error(
	session: &mut Session,
	assistant: Handle,
	message: &str,
	status: Option<i64>,
	record: &SourceRecord,
) -> miette::Result<()> {
	let mut node = NodeSpec::new(KnownTag::Diag)
		.with_prop(PropId::Severity, DomValue::Str(Str::new_static("error")))
		.with_prop(PropId::Text, DomValue::Str(Str::new(message)))
		.with_prop(
			PropKey::Custom(Str::new_static("foreign-record")),
			DomValue::Json(serde_json::value::to_raw_value(&record.value).into_diagnostic()?),
		);
	if let Some(status) = status {
		node = node.with_prop(PropKey::Custom(Str::new_static("status")), DomValue::Int(status));
	}
	let cause = head(session)?;
	session
		.patch(Txn {
			cause,
			label: Some(Str::new_static("foreign.error")),
			ops: vec![Op::Ins {
				parent: assistant,
				after: session.dom().children(assistant).last().copied(),
				node,
			}],
		})
		.into_diagnostic()?;
	Ok(())
}

fn append_error_notice(
	session: &mut Session,
	record: &SourceRecord,
	payload: &Map<String, Value>,
	stamp: &SourceTimestamp,
) -> miette::Result<()> {
	let parent = session
		.dom()
		.children(session.dom().body())
		.last()
		.copied()
		.unwrap_or(session.dom().meta());
	let text = payload
		.get("message")
		.and_then(Value::as_str)
		.or_else(|| payload.get("error").and_then(Value::as_str))
		.unwrap_or("Imported foreign session error");
	let node = NodeSpec::new(KnownTag::Notice)
		.with_prop(PropId::Kind, DomValue::Str(Str::new_static("error")))
		.with_prop(PropId::Text, DomValue::Str(Str::new(text)))
		.with_prop(
			PropKey::Custom(Str::new_static("foreign-record")),
			DomValue::Json(serde_json::value::to_raw_value(&record.value).into_diagnostic()?),
		);
	let cause = head(session)?;
	session
		.patch(Txn {
			cause,
			label: Some(Str::new_static("foreign.error")),
			ops: vec![Op::Ins { parent, after: session.dom().children(parent).last().copied(), node }],
		})
		.into_diagnostic()?;
	let handle = *session
		.dom()
		.children(parent)
		.last()
		.ok_or_else(|| miette!("foreign error node is absent"))?;
	patch_timestamp(session, handle, record.line, stamp, "foreign.timestamp")
}

fn patch_record(
	session: &mut Session,
	handle: Handle,
	record: &SourceRecord,
	source_id: Option<&Str>,
	parent: Option<&Str>,
	stamp: &SourceTimestamp,
	label: &'static str,
) -> miette::Result<()> {
	let mut ops = vec![
		Op::Set {
			h:     handle,
			prop:  PropKey::Custom(Str::new_static("foreign-record")),
			value: DomValue::Json(serde_json::value::to_raw_value(&record.value).into_diagnostic()?),
		},
		Op::Set {
			h:     handle,
			prop:  PropKey::Custom(Str::new_static("source-line")),
			value: DomValue::Int(i64::try_from(record.line).unwrap_or(i64::MAX)),
		},
		Op::Set {
			h:     handle,
			prop:  PropKey::Custom(Str::new_static("source-timestamp-ms")),
			value: DomValue::Int(i64::try_from(stamp.ms).unwrap_or(i64::MAX)),
		},
	];
	if let Some(raw) = &stamp.raw {
		ops.push(Op::Set {
			h:     handle,
			prop:  PropKey::Custom(Str::new_static("source-timestamp")),
			value: DomValue::Str(raw.clone()),
		});
	}
	if let Some(id) = source_id {
		ops.push(Op::Set {
			h:     handle,
			prop:  PropKey::Custom(Str::new_static("source-id")),
			value: DomValue::Str(id.clone()),
		});
	}
	if let Some(parent) = parent {
		ops.push(Op::Set {
			h:     handle,
			prop:  PropKey::Custom(Str::new_static("source-parent-id")),
			value: DomValue::Str(parent.clone()),
		});
	}
	let cause = head(session)?;
	session
		.patch(Txn { cause, label: Some(Str::new_static(label)), ops })
		.into_diagnostic()?;
	Ok(())
}

fn patch_timestamp(
	session: &mut Session,
	handle: Handle,
	line: usize,
	stamp: &SourceTimestamp,
	label: &'static str,
) -> miette::Result<()> {
	let mut ops = vec![
		Op::Set {
			h:     handle,
			prop:  PropKey::Custom(Str::new_static("source-line")),
			value: DomValue::Int(i64::try_from(line).unwrap_or(i64::MAX)),
		},
		Op::Set {
			h:     handle,
			prop:  PropKey::Custom(Str::new_static("source-timestamp-ms")),
			value: DomValue::Int(i64::try_from(stamp.ms).unwrap_or(i64::MAX)),
		},
	];
	if let Some(raw) = &stamp.raw {
		ops.push(Op::Set {
			h:     handle,
			prop:  PropKey::Custom(Str::new_static("source-timestamp")),
			value: DomValue::Str(raw.clone()),
		});
	}
	let cause = head(session)?;
	session
		.patch(Txn { cause, label: Some(Str::new_static(label)), ops })
		.into_diagnostic()?;
	Ok(())
}

fn patch_string(
	session: &mut Session,
	handle: Handle,
	key: &'static str,
	value: &str,
	label: &'static str,
) -> miette::Result<()> {
	patch_value(session, handle, key, DomValue::Str(Str::new(value)), label)
}

fn patch_value(
	session: &mut Session,
	handle: Handle,
	key: &'static str,
	value: DomValue,
	label: &'static str,
) -> miette::Result<()> {
	let cause = head(session)?;
	session
		.patch(Txn {
			cause,
			label: Some(Str::new_static(label)),
			ops: vec![Op::Set { h: handle, prop: PropKey::Custom(Str::new_static(key)), value }],
		})
		.into_diagnostic()?;
	Ok(())
}

fn ensure_turn(session: &mut Session) -> miette::Result<()> {
	if session.dom().children(session.dom().body()).is_empty() {
		session.begin_turn().into_diagnostic()?;
		session.user("", Vec::new()).into_diagnostic()?;
	}
	Ok(())
}

fn last_turn(session: &Session) -> miette::Result<Handle> {
	session
		.dom()
		.children(session.dom().body())
		.last()
		.copied()
		.ok_or_else(|| miette!("imported turn is absent"))
}

fn last_child_with_tag(session: &Session, parent: Handle, tag: KnownTag) -> miette::Result<Handle> {
	session
		.dom()
		.children(parent)
		.iter()
		.rev()
		.copied()
		.find(|handle| {
			session
				.dom()
				.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(tag))
		})
		.ok_or_else(|| miette!("imported {tag:?} node is absent"))
}

fn tool_handle(session: &Session, call: EntryId) -> miette::Result<Handle> {
	let call = call.to_string();
	for turn in session.dom().children(session.dom().body()).iter().rev() {
		for handle in session.dom().children(*turn).iter().rev() {
			let Some(node) = session.dom().get(*handle) else {
				continue;
			};
			if node.prop(&PropId::Cause.into()).and_then(DomValue::as_str) == Some(call.as_str()) {
				return Ok(*handle);
			}
		}
	}
	Err(miette!("imported tool call node is absent"))
}

fn resolve_parent(
	parent: Option<&Str>,
	parents: &FastHashMap<Str, Option<Str>>,
	tails: &FastHashMap<Str, EntryId>,
	base: EntryId,
) -> EntryId {
	let mut cursor = parent;
	let mut seen = FastHashSet::<Str>::default();
	while let Some(id) = cursor {
		if let Some(tail) = tails.get(id) {
			return *tail;
		}
		if !seen.insert(id.clone()) {
			break;
		}
		cursor = parents.get(id).and_then(Option::as_ref);
	}
	base
}

struct SourceTimestamp {
	raw: Option<Str>,
	ms:  u64,
}

fn source_timestamp(value: &Value, fallback: u64) -> SourceTimestamp {
	let field = value.get("timestamp").or_else(|| value.get("ts"));
	if let Some(number) = field
		.and_then(Value::as_f64)
		.filter(|number| number.is_finite() && *number >= 0.0)
	{
		let number = number as u64;
		return SourceTimestamp {
			raw: field.map(|value| Str::new(value.to_string())),
			ms:  if number < 10_000_000_000 {
				number.saturating_mul(1000)
			} else {
				number
			},
		};
	}
	if let Some(text) = field.and_then(Value::as_str) {
		let parsed = text
			.parse::<jiff::Timestamp>()
			.ok()
			.and_then(|value| u64::try_from(value.as_millisecond()).ok())
			.unwrap_or(fallback);
		return SourceTimestamp { raw: Some(Str::new(text)), ms: parsed };
	}
	SourceTimestamp { raw: None, ms: fallback }
}

fn system_time_millis(time: SystemTime) -> u64 {
	time
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}

fn object(value: &Value) -> &Map<String, Value> {
	value.as_object().expect("source records are objects")
}

fn string(record: &Map<String, Value>, key: &str) -> Option<Str> {
	record
		.get(key)
		.and_then(Value::as_str)
		.filter(|value| !value.is_empty())
		.map(Str::new)
}

fn integer(record: &Map<String, Value>, keys: &[&str]) -> u64 {
	keys
		.iter()
		.find_map(|key| record.get(*key).and_then(Value::as_u64))
		.unwrap_or(0)
}

fn content_text(value: &Value) -> String {
	if let Some(text) = value.as_str() {
		return text.to_owned();
	}
	value
		.as_array()
		.into_iter()
		.flatten()
		.filter_map(|part| {
			part
				.get("text")
				.and_then(Value::as_str)
				.or_else(|| part.as_str())
		})
		.collect()
}

fn raw(value: Value) -> miette::Result<Box<RawValue>> {
	serde_json::value::to_raw_value(&value).into_diagnostic()
}

fn head(session: &Session) -> miette::Result<EntryId> {
	session
		.head()
		.ok_or_else(|| miette!("imported session has no journal head"))
}
