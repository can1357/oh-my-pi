//! Bounded revision-3 JSON frames in browser-compatible encrypted relay
//! envelopes.

use bytes::Bytes;
use omp_core::base64_url;
use omp_proto::collab::v1::{
	self, AgentCommand, CollabFrame, Hello, ImageAttachment, JournalRecord, PromptRequest,
	SnapshotChunk, Welcome, collab_frame,
};
use serde_json::{Value, json};
use strum::IntoStaticStr;
use thiserror::Error;

use crate::{
	PROTOCOL_REVISION,
	crypto::{CryptoError, NONCE_BYTES, RoomKey, TAG_BYTES},
};

/// Largest plaintext collaboration frame accepted before encryption.
pub const FRAME_MAX_BYTES: usize = 1024 * 1024;
/// Largest relay envelope, including its four-byte peer header.
pub const ENVELOPE_MAX_BYTES: usize = FRAME_MAX_BYTES + NONCE_BYTES + TAG_BYTES + 4;
/// Largest individual nested length-delimited field.
pub const FIELD_MAX_BYTES: usize = 512 * 1024;
/// Largest number of length-delimited fields in one message.
pub const LENGTH_DELIMITED_MAX_COUNT: usize = 4096;
/// Largest repetition count for one length-delimited field.
pub const REPEATED_MAX_COUNT: usize = 1024;
/// Largest collaboration-message nesting depth accepted before decoding.
pub const PROTOBUF_MAX_DEPTH: usize = 16;

/// Clear relay-visible routing metadata.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RelayRoute {
	/// Zero means host/broadcast; positive values identify one relay peer.
	pub peer_id: u32,
}

/// Decoded routing metadata and authenticated frame.
#[derive(Debug)]
pub struct RoutedFrame {
	/// Cleartext relay route.
	pub route: RelayRoute,
	/// Authenticated inner protobuf frame.
	pub frame: CollabFrame,
}

/// Encodes, encrypts, and wraps one collaboration frame.
pub fn encode_envelope(
	key: &RoomKey,
	route: RelayRoute,
	frame: &CollabFrame,
) -> Result<Vec<u8>, CodecError> {
	ensure_revision("CollabFrame", frame.protocol_revision)?;
	let plaintext = serde_json::to_vec(&frame_to_json(frame)?).map_err(CodecError::EncodeJson)?;
	if plaintext.len() > FRAME_MAX_BYTES {
		return Err(CodecError::FrameTooLarge { actual: plaintext.len(), limit: FRAME_MAX_BYTES });
	}
	let sealed_frame = key.seal(&plaintext)?;
	let envelope_len = 4_usize.saturating_add(sealed_frame.len());
	if envelope_len > ENVELOPE_MAX_BYTES {
		return Err(CodecError::EnvelopeTooLarge {
			actual: envelope_len,
			limit:  ENVELOPE_MAX_BYTES,
		});
	}
	let mut envelope = Vec::with_capacity(envelope_len);
	envelope.extend_from_slice(&route.peer_id.to_be_bytes());
	envelope.extend_from_slice(&sealed_frame);
	Ok(envelope)
}

/// Bounds, decrypts, and decodes a browser-compatible relay envelope.
pub fn decode_envelope(key: &RoomKey, encoded: &[u8]) -> Result<RoutedFrame, CodecError> {
	if encoded.len() > ENVELOPE_MAX_BYTES {
		return Err(CodecError::EnvelopeTooLarge {
			actual: encoded.len(),
			limit:  ENVELOPE_MAX_BYTES,
		});
	}
	let (header, sealed) = if encoded.len() >= 4 {
		encoded.split_at(4)
	} else {
		return Err(CodecError::Malformed { offset: 0 });
	};
	let peer_id = u32::from_be_bytes(header.try_into().expect("four-byte envelope header"));
	let plaintext = key.open(sealed)?;
	if plaintext.len() > FRAME_MAX_BYTES {
		return Err(CodecError::FrameTooLarge { actual: plaintext.len(), limit: FRAME_MAX_BYTES });
	}
	let value: Value = serde_json::from_slice(&plaintext).map_err(CodecError::DecodeJson)?;
	let frame = frame_from_json(&value)?;
	Ok(RoutedFrame { route: RelayRoute { peer_id }, frame })
}
fn frame_to_json(frame: &CollabFrame) -> Result<Value, CodecError> {
	let payload = frame.payload.as_ref().ok_or(CodecError::MissingPayload)?;
	Ok(match payload {
		collab_frame::Payload::Hello(value) => json!({
			"t": "hello",
			"proto": value.protocol_revision,
			"name": value.display_name,
			"writeToken": value.write_token.as_ref().map(|token| base64_url::encode_raw(token).into_string()),
		}),
		collab_frame::Payload::Welcome(value) => welcome_json(value)?,
		collab_frame::Payload::Bye(value) => json!({ "t": "bye", "reason": value.reason }),
		collab_frame::Payload::Error(value) => json!({ "t": "error", "message": value.message }),
		collab_frame::Payload::SnapshotChunk(value) => json!({
			"t": "snapshot-chunk",
			"entries": value.entries.iter().filter_map(record_value).collect::<Vec<_>>(),
			"final": value.r#final,
		}),
		collab_frame::Payload::JournalRecord(value) => json!({
			"t": "entry",
			"entry": record_value(value).unwrap_or(Value::Null),
		}),
		collab_frame::Payload::State(value) => {
			let mut state = state_json(value);
			state
				.as_object_mut()
				.expect("state JSON is an object")
				.insert("t".into(), json!("state"));
			state
		},
		collab_frame::Payload::Agents(value) => json!({
			"t": "agents",
			"agents": value.agents.iter().map(agent_json).collect::<Vec<_>>(),
		}),
		collab_frame::Payload::Prompt(value) => json!({
			"t": "prompt",
			"text": value.text,
			"images": value.images.iter().map(|image| json!({
				"type": "image",
				"data": base64_url::encode_raw(&image.data).into_string(),
				"mimeType": image.mime_type,
			})).collect::<Vec<_>>(),
		}),
		collab_frame::Payload::Abort(_) => json!({ "t": "abort" }),
		collab_frame::Payload::AgentCommand(value) => json!({
			"t": "agent-cmd",
			"cmd": match v1::agent_command::Command::try_from(value.command).unwrap_or_default() {
				v1::agent_command::Command::Chat => "chat",
				v1::agent_command::Command::Kill => "kill",
				v1::agent_command::Command::Revive => "revive",
			},
			"agentId": value.agent_id,
			"text": value.text,
		}),
		collab_frame::Payload::UiResponse(value) => json!({
			"t": "ui-response", "reqId": value.request_id, "value": value.value,
		}),
		collab_frame::Payload::TranscriptRequest(value) => json!({
			"t": "fetch-transcript", "reqId": value.request_id,
			"agentId": value.agent_id, "fromByte": value.from_byte,
		}),
		collab_frame::Payload::UiRequest(value) => ui_request_json(value),
		collab_frame::Payload::UiRequestEnd(value) => {
			json!({ "t": "ui-request-end", "reqId": value.request_id })
		},
		collab_frame::Payload::Transcript(value) => json!({
			"t": "transcript", "reqId": value.request_id,
			"text": String::from_utf8_lossy(&value.text_utf8), "newSize": value.new_size,
			"error": value.error,
		}),
		collab_frame::Payload::BusEvent(value) => json!({
			"t": "bus",
			"channel": match v1::bus_event::Channel::try_from(value.channel).unwrap_or_default() {
				v1::bus_event::Channel::TaskSubagentProgress => "task:subagent:progress",
				v1::bus_event::Channel::TaskSubagentLifecycle => "task:subagent:lifecycle",
				v1::bus_event::Channel::Unspecified => "",
			},
			"data": serde_json::from_slice::<Value>(&value.data_json).unwrap_or(Value::Null),
		}),
		collab_frame::Payload::AgentViewRequest(value) => json!({
			"t": "agent-view-request",
			"reqId": value.request_id,
			"agentId": value.agent_id,
		}),
		collab_frame::Payload::AgentViewCancel(value) => json!({
			"t": "agent-view-cancel",
			"reqId": value.request_id,
		}),
		collab_frame::Payload::AgentViewSnapshot(value) => json!({
			"t": "agent-view-snapshot",
			"reqId": value.request_id,
			"index": value.chunk_index,
			"data": base64_url::encode_raw(&value.snapshot_bytes).into_string(),
			"final": value.r#final,
		}),
		collab_frame::Payload::AgentViewEvent(value) => json!({
			"t": "agent-view-event",
			"reqId": value.request_id,
			"event": value.event.as_ref().and_then(record_value),
		}),
		collab_frame::Payload::AgentViewEnd(value) => json!({
			"t": "agent-view-end",
			"reqId": value.request_id,
			"error": value.error.as_ref().map(|error| json!({
				"code": error.code,
				"message": error.message,
			})),
		}),
		collab_frame::Payload::Event(_) => {
			return Err(CodecError::UnsupportedPayload("event".into()));
		},
	})
}

fn frame_from_json(value: &Value) -> Result<CollabFrame, CodecError> {
	let object = value.as_object().ok_or(CodecError::JsonShape("frame"))?;
	let tag = object
		.get("t")
		.and_then(Value::as_str)
		.ok_or(CodecError::JsonShape("frame.t"))?;
	let payload = match tag {
		"hello" => collab_frame::Payload::Hello(Hello {
			protocol_revision: json_u32(object, "proto")?,
			display_name:      json_str(object, "name")?.to_owned(),
			write_token:       object
				.get("writeToken")
				.and_then(Value::as_str)
				.map(decode_base64)
				.transpose()?
				.map(Bytes::from),
			client_version:    String::new(),
		}),
		"welcome" => collab_frame::Payload::Welcome(welcome_from_json(object)?),
		"bye" => collab_frame::Payload::Bye(v1::Bye {
			reason: json_str(object, "reason").unwrap_or_default().to_owned(),
		}),
		"error" => collab_frame::Payload::Error(v1::ErrorMessage {
			code:    String::new(),
			message: json_str(object, "message").unwrap_or_default().to_owned(),
		}),
		"snapshot-chunk" => collab_frame::Payload::SnapshotChunk(SnapshotChunk {
			entries:                 json_entries(object.get("entries"))?,
			r#final:                 object
				.get("final")
				.and_then(Value::as_bool)
				.unwrap_or(false),
			host_revision_watermark: 0,
		}),
		"entry" => collab_frame::Payload::JournalRecord(json_record(
			object
				.get("entry")
				.ok_or(CodecError::JsonShape("entry.entry"))?,
			0,
		)?),
		"state" => collab_frame::Payload::State(state_from_json(object)?),
		"agents" => collab_frame::Payload::Agents(v1::RegistrySnapshot {
			agents: object
				.get("agents")
				.and_then(Value::as_array)
				.into_iter()
				.flatten()
				.map(agent_from_json)
				.collect::<Result<_, _>>()?,
		}),
		"prompt" => collab_frame::Payload::Prompt(PromptRequest {
			text:   json_str(object, "text")?.to_owned(),
			images: object
				.get("images")
				.and_then(Value::as_array)
				.into_iter()
				.flatten()
				.map(image_from_json)
				.collect::<Result<_, _>>()?,
		}),
		"abort" => collab_frame::Payload::Abort(v1::AbortRequest { reason: String::new() }),
		"agent-cmd" => collab_frame::Payload::AgentCommand(AgentCommand {
			command:  match json_str(object, "cmd")? {
				"chat" => v1::agent_command::Command::Chat,
				"kill" => v1::agent_command::Command::Kill,
				"revive" => v1::agent_command::Command::Revive,
				_ => return Err(CodecError::JsonShape("agent-cmd.cmd")),
			} as i32,
			agent_id: json_str(object, "agentId")?.to_owned(),
			text:     object
				.get("text")
				.and_then(Value::as_str)
				.map(str::to_owned),
		}),
		"ui-response" => collab_frame::Payload::UiResponse(v1::UiResponse {
			request_id: json_u32(object, "reqId")?,
			value:      object
				.get("value")
				.and_then(Value::as_str)
				.map(str::to_owned),
		}),
		"fetch-transcript" => collab_frame::Payload::TranscriptRequest(v1::TranscriptRequest {
			request_id: json_u32(object, "reqId")?,
			agent_id:   json_str(object, "agentId")?.to_owned(),
			from_byte:  json_u64(object, "fromByte")?,
		}),
		"agent-view-request" => collab_frame::Payload::AgentViewRequest(v1::AgentViewRequest {
			request_id: json_u32(object, "reqId")?,
			agent_id:   json_str(object, "agentId")?.to_owned(),
		}),
		"agent-view-cancel" => collab_frame::Payload::AgentViewCancel(v1::AgentViewCancel {
			request_id: json_u32(object, "reqId")?,
		}),
		"agent-view-snapshot" => collab_frame::Payload::AgentViewSnapshot(v1::AgentViewSnapshot {
			request_id:     json_u32(object, "reqId")?,
			chunk_index:    json_u32(object, "index")?,
			snapshot_bytes: Bytes::from(decode_base64(json_str(object, "data")?)?),
			r#final:        object
				.get("final")
				.and_then(Value::as_bool)
				.unwrap_or(false),
		}),
		"agent-view-event" => collab_frame::Payload::AgentViewEvent(v1::AgentViewEvent {
			request_id: json_u32(object, "reqId")?,
			event:      object
				.get("event")
				.filter(|value| !value.is_null())
				.map(|value| json_record(value, 0))
				.transpose()?,
		}),
		"agent-view-end" => collab_frame::Payload::AgentViewEnd(v1::AgentViewEnd {
			request_id: json_u32(object, "reqId")?,
			error:      object
				.get("error")
				.and_then(Value::as_object)
				.map(|error| v1::ErrorMessage {
					code:    error
						.get("code")
						.and_then(Value::as_str)
						.unwrap_or_default()
						.to_owned(),
					message: error
						.get("message")
						.and_then(Value::as_str)
						.unwrap_or_default()
						.to_owned(),
				}),
		}),
		other => return Err(CodecError::UnsupportedPayload(other.to_owned())),
	};
	Ok(CollabFrame {
		protocol_revision: PROTOCOL_REVISION,
		payload: Some(payload),
		..Default::default()
	})
}

fn welcome_json(value: &Welcome) -> Result<Value, CodecError> {
	let header = value
		.header
		.as_ref()
		.ok_or(CodecError::JsonShape("welcome.header"))?;
	let state = value
		.initial_state
		.as_ref()
		.ok_or(CodecError::JsonShape("welcome.state"))?;
	let agents = value
		.initial_agents
		.as_ref()
		.map(|value| value.agents.as_slice())
		.unwrap_or_default();
	Ok(json!({
		"t": "welcome", "proto": value.protocol_revision,
		"header": {
			"type": "session", "id": header.session_id, "title": header.title,
			"timestamp": header.created_at_ms.to_string(), "cwd": header.host_cwd,
		},
		"state": state_json(state),
		"agents": agents.iter().map(agent_json).collect::<Vec<_>>(),
		"entryCount": value.total_entry_count,
		"readOnly": value.read_only,
	}))
}

fn welcome_from_json(object: &serde_json::Map<String, Value>) -> Result<Welcome, CodecError> {
	let header = object
		.get("header")
		.and_then(Value::as_object)
		.ok_or(CodecError::JsonShape("welcome.header"))?;
	Ok(Welcome {
		protocol_revision: json_u32(object, "proto")?,
		header:            Some(v1::SessionHeader {
			session_id:    json_str(header, "id")?.to_owned(),
			title:         header
				.get("title")
				.and_then(Value::as_str)
				.unwrap_or_default()
				.to_owned(),
			created_at_ms: header
				.get("timestamp")
				.and_then(Value::as_str)
				.and_then(|v| v.parse().ok())
				.unwrap_or_default(),
			host_cwd:      json_str(header, "cwd")?.to_owned(),
		}),
		initial_state:     Some(state_from_value(
			object
				.get("state")
				.ok_or(CodecError::JsonShape("welcome.state"))?,
		)?),
		initial_agents:    Some(v1::RegistrySnapshot {
			agents: object
				.get("agents")
				.and_then(Value::as_array)
				.into_iter()
				.flatten()
				.map(agent_from_json)
				.collect::<Result<_, _>>()?,
		}),
		total_entry_count: json_u32(object, "entryCount")?,
		read_only:         object
			.get("readOnly")
			.and_then(Value::as_bool)
			.unwrap_or(false),
	})
}

fn state_json(value: &v1::SessionStateUpdate) -> Value {
	json!({
		"isStreaming": value.is_streaming,
		"queuedMessageCount": value.queued_message_count,
		"sessionName": (!value.session_name.is_empty()).then_some(&value.session_name),
		"cwd": value.host_cwd,
		"thinkingLevel": value.thinking_level,
		"participants": value.participants.iter().map(|participant| json!({
			"name": participant.display_name,
			"role": if participant.is_host { "host" } else { "guest" },
			"readOnly": participant.read_only,
		})).collect::<Vec<_>>(),
		"isAborting": value.is_aborting,
	})
}

fn state_from_value(value: &Value) -> Result<v1::SessionStateUpdate, CodecError> {
	state_from_json(value.as_object().ok_or(CodecError::JsonShape("state"))?)
}

fn state_from_json(
	object: &serde_json::Map<String, Value>,
) -> Result<v1::SessionStateUpdate, CodecError> {
	Ok(v1::SessionStateUpdate {
		is_streaming: object
			.get("isStreaming")
			.and_then(Value::as_bool)
			.unwrap_or(false),
		is_aborting: object
			.get("isAborting")
			.and_then(Value::as_bool)
			.unwrap_or(false),
		queued_message_count: object
			.get("queuedMessageCount")
			.and_then(Value::as_u64)
			.and_then(|v| u32::try_from(v).ok())
			.unwrap_or_default(),
		session_name: object
			.get("sessionName")
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_owned(),
		host_cwd: object
			.get("cwd")
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_owned(),
		thinking_level: object
			.get("thinkingLevel")
			.and_then(Value::as_str)
			.map(str::to_owned),
		participants: object
			.get("participants")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
			.map(|value| {
				let item = value
					.as_object()
					.ok_or(CodecError::JsonShape("participant"))?;
				Ok(v1::Participant {
					display_name: json_str(item, "name")?.to_owned(),
					is_host:      json_str(item, "role")? == "host",
					read_only:    item
						.get("readOnly")
						.and_then(Value::as_bool)
						.unwrap_or(false),
					peer_id:      0,
				})
			})
			.collect::<Result<_, CodecError>>()?,
		..Default::default()
	})
}

fn agent_json(value: &v1::AgentSummary) -> Value {
	json!({
		"id": value.id, "displayName": value.display_name,
		"kind": if value.kind == v1::agent_summary::Kind::Sub as i32 { "sub" } else { "main" },
		"parentId": value.parent_id,
		"status": match v1::agent_summary::Status::try_from(value.status).unwrap_or_default() {
			v1::agent_summary::Status::Running => "running",
			v1::agent_summary::Status::Idle => "idle",
			v1::agent_summary::Status::Parked => "parked",
			v1::agent_summary::Status::Aborted => "aborted",
		},
		"hasSessionFile": value.has_session_file,
		"createdAt": value.created_at_ms, "lastActivity": value.last_activity_ms,
	})
}

fn agent_from_json(value: &Value) -> Result<v1::AgentSummary, CodecError> {
	let item = value.as_object().ok_or(CodecError::JsonShape("agent"))?;
	Ok(v1::AgentSummary {
		id:               json_str(item, "id")?.to_owned(),
		display_name:     json_str(item, "displayName")?.to_owned(),
		kind:             i32::from(json_str(item, "kind").unwrap_or("main") == "sub"),
		parent_id:        item
			.get("parentId")
			.and_then(Value::as_str)
			.map(str::to_owned),
		status:           match json_str(item, "status").unwrap_or("idle") {
			"running" => 0,
			"idle" => 1,
			"parked" => 2,
			"aborted" => 3,
			_ => return Err(CodecError::JsonShape("agent.status")),
		},
		has_session_file: item
			.get("hasSessionFile")
			.and_then(Value::as_bool)
			.unwrap_or(false),
		created_at_ms:    item
			.get("createdAt")
			.and_then(Value::as_u64)
			.unwrap_or_default(),
		last_activity_ms: item
			.get("lastActivity")
			.and_then(Value::as_u64)
			.unwrap_or_default(),
	})
}

fn ui_request_json(value: &v1::UiRequest) -> Value {
	let mut request = match value.spec.as_ref() {
		Some(v1::ui_request::Spec::Select(spec)) => json!({
			"kind": "select", "title": value.title,
			"options": spec.options.iter().map(|option| match &option.description {
				Some(description) => json!({"label": option.label, "description": description}),
				None => json!(option.label),
			}).collect::<Vec<_>>(),
			"initialIndex": spec.initial_index,
			"selectionMarker": if spec.marker == v1::select_spec::Marker::Checkbox as i32 { "checkbox" } else { "radio" },
			"checkedIndices": spec.checked_indices, "markableCount": spec.markable_count,
			"helpText": spec.help_text,
		}),
		Some(v1::ui_request::Spec::Editor(spec)) => json!({
			"kind": "editor", "title": value.title, "prefill": spec.prefill,
		}),
		None => json!({ "kind": "editor", "title": value.title }),
	};
	request
		.as_object_mut()
		.expect("request JSON is an object")
		.insert("reqId".into(), json!(value.request_id));
	json!({ "t": "ui-request", "request": request })
}

fn image_from_json(value: &Value) -> Result<ImageAttachment, CodecError> {
	let image = value.as_object().ok_or(CodecError::JsonShape("image"))?;
	Ok(ImageAttachment {
		data:      Bytes::from(decode_base64(json_str(image, "data")?)?),
		mime_type: json_str(image, "mimeType")?.to_owned(),
	})
}

fn decode_base64(value: &str) -> Result<Vec<u8>, CodecError> {
	base64_url::decode_raw(value.trim_end_matches('=').as_bytes())
		.into_vec()
		.map_err(|_| CodecError::JsonShape("base64"))
}

fn record_value(record: &JournalRecord) -> Option<Value> {
	if record.transcript_v4_json.is_empty() {
		None
	} else {
		serde_json::from_slice(&record.transcript_v4_json).ok()
	}
}

fn json_entries(value: Option<&Value>) -> Result<Vec<JournalRecord>, CodecError> {
	value
		.and_then(Value::as_array)
		.ok_or(CodecError::JsonShape("entries"))?
		.iter()
		.enumerate()
		.map(|(index, value)| json_record(value, index as u64 + 1))
		.collect()
}

fn json_record(value: &Value, revision: u64) -> Result<JournalRecord, CodecError> {
	Ok(JournalRecord {
		revision,
		transcript_v4_json: Bytes::from(serde_json::to_vec(value).map_err(CodecError::EncodeJson)?),
		visibility_class: v1::VisibilityClass::PublicTranscript as i32,
	})
}

fn json_str<'a>(
	object: &'a serde_json::Map<String, Value>,
	key: &'static str,
) -> Result<&'a str, CodecError> {
	object
		.get(key)
		.and_then(Value::as_str)
		.ok_or(CodecError::JsonShape(key))
}

fn json_u64(object: &serde_json::Map<String, Value>, key: &'static str) -> Result<u64, CodecError> {
	object
		.get(key)
		.and_then(Value::as_u64)
		.ok_or(CodecError::JsonShape(key))
}

fn json_u32(object: &serde_json::Map<String, Value>, key: &'static str) -> Result<u32, CodecError> {
	u32::try_from(json_u64(object, key)?).map_err(|_| CodecError::JsonShape(key))
}

/// Refuses a malformed or over-bounds encoded collaboration frame before prost
/// allocation.
pub fn validate_collab_frame(encoded: &[u8]) -> Result<(), CodecError> {
	preflight(encoded, Node::CollabFrame, FRAME_MAX_BYTES)
}

const fn ensure_revision(message: &'static str, actual: u32) -> Result<(), CodecError> {
	if actual == PROTOCOL_REVISION {
		Ok(())
	} else {
		Err(CodecError::UnsupportedRevision { message, actual, supported: PROTOCOL_REVISION })
	}
}

/// Collaboration wire decoding and protocol refusal.
#[derive(Debug, Error)]
pub enum CodecError {
	/// A JSON frame could not be serialized.
	#[error("collaboration JSON encode failed")]
	EncodeJson(#[source] serde_json::Error),
	/// An authenticated JSON frame was malformed.
	#[error("collaboration JSON decode failed")]
	DecodeJson(#[source] serde_json::Error),
	/// A required browser-wire field had the wrong shape.
	#[error("collaboration JSON field has invalid shape: {0}")]
	JsonShape(&'static str),
	/// The protobuf payload has no browser-wire equivalent.
	#[error("unsupported collaboration JSON payload: {0}")]
	UnsupportedPayload(String),
	/// A collaboration frame omitted its payload.
	#[error("collaboration frame has no payload")]
	MissingPayload,
	/// An encoded plaintext frame exceeds its pre-encryption ceiling.
	#[error("collaboration frame is {actual} bytes; limit is {limit}")]
	FrameTooLarge {
		/// Actual byte count.
		actual: usize,
		/// Accepted byte count.
		limit:  usize,
	},
	/// An outer envelope exceeds its transport ceiling.
	#[error("relay envelope is {actual} bytes; limit is {limit}")]
	EnvelopeTooLarge {
		/// Actual byte count.
		actual: usize,
		/// Accepted byte count.
		limit:  usize,
	},
	/// A length-delimited field exceeds the allocation bound.
	#[error("{message} field {field} is {actual} bytes; limit is {limit}")]
	FieldTooLarge {
		/// Containing protobuf message.
		message: &'static str,
		/// Field number.
		field:   u32,
		/// Declared field length.
		actual:  usize,
		/// Accepted field length.
		limit:   usize,
	},
	/// One message contains too many allocating fields.
	#[error("{message} has {actual} length-delimited fields; limit is {limit}")]
	TooManyFields {
		/// Containing message.
		message: &'static str,
		/// Observed count.
		actual:  usize,
		/// Accepted count.
		limit:   usize,
	},
	/// A repeated field contains too many elements.
	#[error("{message} field {field} has {actual} values; limit is {limit}")]
	TooManyRepeated {
		/// Containing message.
		message: &'static str,
		/// Field number.
		field:   u32,
		/// Observed count.
		actual:  usize,
		/// Accepted count.
		limit:   usize,
	},
	/// Known nested messages exceed the stack/decode depth bound.
	#[error("collaboration protobuf nesting depth is {actual}; limit is {limit}")]
	TooDeep {
		/// First rejected depth.
		actual: usize,
		/// Accepted depth.
		limit:  usize,
	},
	/// The protobuf wire encoding is malformed.
	#[error("malformed collaboration protobuf at byte {offset}")]
	Malformed {
		/// Byte offset at which parsing failed.
		offset: usize,
	},
	/// A peer requested a revision this binary does not implement.
	#[error("{message} protocol revision {actual} is unsupported; expected {supported}")]
	UnsupportedRevision {
		/// Refusing message type.
		message:   &'static str,
		/// Received revision.
		actual:    u32,
		/// Sole supported revision.
		supported: u32,
	},
	/// Encryption or authentication failed.
	#[error("collaboration frame cryptography failed")]
	Crypto(#[from] CryptoError),
}

#[derive(Clone, Copy, IntoStaticStr)]
enum Node {
	CollabFrame,
	Hello,
	Welcome,
	SessionHeader,
	Bye,
	#[strum(serialize = "ErrorMessage")]
	Error,
	#[strum(serialize = "SnapshotChunk")]
	Snapshot,
	#[strum(serialize = "JournalRecord")]
	Journal,
	StreamEvent,
	ToolExecution,
	Notice,
	#[strum(serialize = "SessionStateUpdate")]
	SessionState,
	ModelMetadata,
	ContextUsage,
	Participant,
	#[strum(serialize = "RegistrySnapshot")]
	Registry,
	AgentSummary,
	#[strum(serialize = "PromptRequest")]
	Prompt,
	#[strum(serialize = "ImageAttachment")]
	Image,
	#[strum(serialize = "AbortRequest")]
	Abort,
	AgentCommand,
	UiRequest,
	SelectSpec,
	SelectOption,
	EditorSpec,
	UiRequestEnd,
	UiResponse,
	TranscriptRequest,
	TranscriptChunk,
	BusEvent,
	AgentViewRequest,
	AgentViewCancel,
	AgentViewSnapshot,
	AgentViewEvent,
	AgentViewEnd,
	#[strum(serialize = "OpaqueImportedMessage")]
	Opaque,
}

impl Node {
	const fn child(self, field: u32) -> Option<Self> {
		match (self, field) {
			(Self::CollabFrame, 10) => Some(Self::Hello),
			(Self::CollabFrame, 11) => Some(Self::Welcome),
			(Self::CollabFrame, 12) => Some(Self::Bye),
			(Self::CollabFrame, 13) => Some(Self::Error),
			(Self::CollabFrame, 15) => Some(Self::Opaque),
			(Self::CollabFrame, 20) => Some(Self::Snapshot),
			(Self::CollabFrame, 21) => Some(Self::Journal),
			(Self::CollabFrame, 22) => Some(Self::StreamEvent),
			(Self::CollabFrame, 23) => Some(Self::SessionState),
			(Self::CollabFrame, 24) => Some(Self::Registry),
			(Self::CollabFrame, 30) => Some(Self::Prompt),
			(Self::CollabFrame, 31) => Some(Self::Abort),
			(Self::CollabFrame, 32) => Some(Self::AgentCommand),
			(Self::CollabFrame, 33) => Some(Self::UiResponse),
			(Self::CollabFrame, 34) => Some(Self::TranscriptRequest),
			(Self::CollabFrame, 40) => Some(Self::UiRequest),
			(Self::CollabFrame, 41) => Some(Self::UiRequestEnd),
			(Self::CollabFrame, 42) => Some(Self::TranscriptChunk),
			(Self::CollabFrame, 43) => Some(Self::BusEvent),
			(Self::CollabFrame, 44) => Some(Self::AgentViewRequest),
			(Self::CollabFrame, 45) => Some(Self::AgentViewCancel),
			(Self::CollabFrame, 46) => Some(Self::AgentViewSnapshot),
			(Self::CollabFrame, 47) => Some(Self::AgentViewEvent),
			(Self::CollabFrame, 48) => Some(Self::AgentViewEnd),
			(Self::Welcome, 2) => Some(Self::SessionHeader),
			(Self::Welcome, 3) => Some(Self::SessionState),
			(Self::Welcome, 4) => Some(Self::Registry),
			(Self::Snapshot, 1) => Some(Self::Journal),
			(Self::Journal, 2) => Some(Self::Opaque),
			(Self::StreamEvent, 2) => Some(Self::Opaque),
			(Self::StreamEvent, 3) => Some(Self::ToolExecution),
			(Self::StreamEvent, 4) => Some(Self::Notice),
			(Self::SessionState, 6) => Some(Self::ModelMetadata),
			(Self::SessionState, 8) => Some(Self::ContextUsage),
			(Self::SessionState, 9) => Some(Self::Participant),
			(Self::Registry, 1) => Some(Self::AgentSummary),
			(Self::Prompt, 2) => Some(Self::Image),
			(Self::UiRequest, 3) => Some(Self::SelectSpec),
			(Self::UiRequest, 4) => Some(Self::EditorSpec),
			(Self::SelectSpec, 1) => Some(Self::SelectOption),
			(Self::AgentViewSnapshot, 3) => Some(Self::Opaque),
			(Self::AgentViewEvent, 2) => Some(Self::Journal),
			(Self::AgentViewEnd, 2) => Some(Self::Error),
			_ => None,
		}
	}
}

fn preflight(encoded: &[u8], node: Node, maximum: usize) -> Result<(), CodecError> {
	if encoded.len() > maximum {
		return Err(CodecError::FrameTooLarge { actual: encoded.len(), limit: maximum });
	}
	scan_message(encoded, node, 0, 0)
}

fn scan_message(encoded: &[u8], node: Node, depth: usize, base: usize) -> Result<(), CodecError> {
	if depth > PROTOBUF_MAX_DEPTH {
		return Err(CodecError::TooDeep { actual: depth, limit: PROTOBUF_MAX_DEPTH });
	}
	if matches!(node, Node::Opaque) {
		return Ok(());
	}
	let mut cursor = 0;
	let mut length_count = 0;
	let mut occurrences = [0_u16; 64];
	while cursor < encoded.len() {
		let key_offset = cursor;
		let key = read_varint(encoded, &mut cursor, base)?;
		let field = u32::try_from(key >> 3)
			.map_err(|_| CodecError::Malformed { offset: base + key_offset })?;
		if field == 0 {
			return Err(CodecError::Malformed { offset: base + key_offset });
		}
		match key & 7 {
			0 => {
				read_varint(encoded, &mut cursor, base)?;
			},
			1 => advance(encoded, &mut cursor, 8, base)?,
			2 => {
				length_count += 1;
				if length_count > LENGTH_DELIMITED_MAX_COUNT {
					return Err(CodecError::TooManyFields {
						message: node.into(),
						actual:  length_count,
						limit:   LENGTH_DELIMITED_MAX_COUNT,
					});
				}
				let length_offset = cursor;
				let length = usize::try_from(read_varint(encoded, &mut cursor, base)?)
					.map_err(|_| CodecError::Malformed { offset: base + length_offset })?;
				let limit = if matches!(node, Node::Journal) && field == 2 {
					FRAME_MAX_BYTES
				} else {
					FIELD_MAX_BYTES
				};
				if length > limit {
					return Err(CodecError::FieldTooLarge {
						message: node.into(),
						field,
						actual: length,
						limit,
					});
				}
				if let Ok(slot) = usize::try_from(field)
					&& let Some(count) = occurrences.get_mut(slot)
				{
					*count = count.saturating_add(1);
					if usize::from(*count) > REPEATED_MAX_COUNT {
						return Err(CodecError::TooManyRepeated {
							message: node.into(),
							field,
							actual: usize::from(*count),
							limit: REPEATED_MAX_COUNT,
						});
					}
				}
				let start = cursor;
				advance(encoded, &mut cursor, length, base)?;
				if matches!(node, Node::SelectSpec) && field == 4 {
					let count = count_packed_varints(&encoded[start..cursor], base + start)?;
					if count > REPEATED_MAX_COUNT {
						return Err(CodecError::TooManyRepeated {
							message: node.into(),
							field,
							actual: count,
							limit: REPEATED_MAX_COUNT,
						});
					}
				}

				if let Some(child) = node.child(field) {
					scan_message(&encoded[start..cursor], child, depth + 1, base + start)?;
				}
			},
			5 => advance(encoded, &mut cursor, 4, base)?,
			_ => return Err(CodecError::Malformed { offset: base + key_offset }),
		}
	}
	Ok(())
}

fn read_varint(encoded: &[u8], cursor: &mut usize, base: usize) -> Result<u64, CodecError> {
	let start = *cursor;
	let mut value = 0_u64;
	for shift in (0..70).step_by(7) {
		let byte = *encoded
			.get(*cursor)
			.ok_or(CodecError::Malformed { offset: base + start })?;
		*cursor += 1;
		if shift == 63 && byte > 1 {
			break;
		}
		value |= u64::from(byte & 0x7f) << shift;
		if byte & 0x80 == 0 {
			return Ok(value);
		}
	}
	Err(CodecError::Malformed { offset: base + start })
}

fn count_packed_varints(encoded: &[u8], base: usize) -> Result<usize, CodecError> {
	let mut cursor = 0;
	let mut count = 0;
	while cursor < encoded.len() {
		read_varint(encoded, &mut cursor, base)?;
		count += 1;
	}
	Ok(count)
}
fn advance(
	encoded: &[u8],
	cursor: &mut usize,
	count: usize,
	base: usize,
) -> Result<(), CodecError> {
	let next = cursor
		.checked_add(count)
		.filter(|next| *next <= encoded.len())
		.ok_or(CodecError::Malformed { offset: base + *cursor })?;
	*cursor = next;
	Ok(())
}
#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn refuses_declared_field_before_allocation() {
		// CollabFrame field 10 (Hello), declaring 524,289 bytes with no payload.
		let encoded = [0x52, 0x81, 0x80, 0x20];
		assert!(matches!(
			validate_collab_frame(&encoded),
			Err(CodecError::FieldTooLarge { message: "CollabFrame", field: 10, .. })
		));
	}

	#[test]
	fn envelope_round_trip_and_revision_refusal() {
		let (key, _) = RoomKey::generate().unwrap();
		let frame = CollabFrame {
			protocol_revision: PROTOCOL_REVISION,
			sequence: 9,
			payload: Some(collab_frame::Payload::Hello(Hello {
				protocol_revision: PROTOCOL_REVISION,
				display_name: "browser".to_owned(),
				..Default::default()
			})),
			..Default::default()
		};
		let encoded = encode_envelope(&key, RelayRoute { peer_id: 7 }, &frame).unwrap();
		assert_eq!(&encoded[..4], &7_u32.to_be_bytes());
		let plaintext = key.open(&encoded[4..]).expect("browser-compatible seal");
		let json: Value = serde_json::from_slice(&plaintext).expect("JSON frame");
		assert_eq!(json["t"], "hello");
		assert_eq!(json["proto"], PROTOCOL_REVISION);
		assert_eq!(json["name"], "browser");
		let decoded = decode_envelope(&key, &encoded).unwrap();
		assert_eq!(decoded.route.peer_id, 7);
		assert!(matches!(decoded.frame.payload, Some(collab_frame::Payload::Hello(_))));
		let old = CollabFrame { protocol_revision: 2, ..Default::default() };
		assert!(matches!(
			encode_envelope(&key, RelayRoute { peer_id: 0 }, &old),
			Err(CodecError::UnsupportedRevision { actual: 2, .. })
		));
	}

	#[test]
	fn native_agent_view_frames_preserve_correlation_and_binary_snapshot_bytes() {
		let (key, _) = RoomKey::generate().unwrap();
		let frame = CollabFrame {
			protocol_revision: PROTOCOL_REVISION,
			sequence: 17,
			payload: Some(collab_frame::Payload::AgentViewSnapshot(v1::AgentViewSnapshot {
				request_id:     9,
				chunk_index:    2,
				snapshot_bytes: Bytes::from_static(b"\0snapshot\xff"),
				r#final:        true,
			})),
			..Default::default()
		};
		let encoded = encode_envelope(&key, RelayRoute { peer_id: 4 }, &frame).unwrap();
		let decoded = decode_envelope(&key, &encoded).unwrap();
		let Some(collab_frame::Payload::AgentViewSnapshot(snapshot)) = decoded.frame.payload else {
			panic!("agent view snapshot");
		};
		assert_eq!(snapshot.request_id, 9);
		assert_eq!(snapshot.chunk_index, 2);
		assert_eq!(snapshot.snapshot_bytes.as_ref(), b"\0snapshot\xff");
		assert!(snapshot.r#final);
	}

	#[test]
	fn refuses_packed_repetition_before_decode() {
		let mut encoded = vec![0x22, 0x81, 0x08];
		encoded.resize(3 + REPEATED_MAX_COUNT + 1, 0);
		assert!(matches!(
			scan_message(&encoded, Node::SelectSpec, 0, 0),
			Err(CodecError::TooManyRepeated {
				message: "SelectSpec",
				field: 4,
				actual,
				..
			}) if actual == REPEATED_MAX_COUNT + 1
		));
	}
}
