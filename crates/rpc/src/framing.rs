//! Newline-delimited JSON transport framing and protocol-v2 logical frame
//! chunking.

use std::{
	collections::HashSet,
	error,
	fmt::{self, Display},
	hash::BuildHasher,
	mem, str,
};

use omp_core::base64;
use serde_json::{Map, Value, json};

/// Maximum UTF-8 size of one physical JSON line, including the trailing
/// newline.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
/// Maximum size of a reassembled protocol-v2 JSON payload.
pub const MAX_REASSEMBLED_BYTES: usize = 64 * 1024 * 1024;
/// Number of unencoded JSON bytes carried by one protocol-v2 chunk.
pub const RPC_CHUNK_BYTES: usize = 256 * 1024;

/// A recoverable transport-decoder resynchronization notice.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FramingDiagnostic {
	/// Number of bytes discarded while recovering the stream.
	pub skipped_bytes: usize,
	/// Stable, human-readable reason for discarding the bytes.
	pub reason:        &'static str,
}

/// Frames and recovery notices produced by one incremental decoder call.
#[derive(Debug, Default, Eq, PartialEq)]
pub struct DecodeBatch {
	/// Complete physical payloads, without their trailing newlines.
	pub frames:      Vec<Vec<u8>>,
	/// Non-fatal stream recovery notices.
	pub diagnostics: Vec<FramingDiagnostic>,
}

/// Incremental decoder for newline-delimited JSON streams.
///
/// Empty lines are ignored. Lines exceeding [`MAX_FRAME_BYTES`] are discarded
/// through their next newline and reported without poisoning subsequent frames.
#[derive(Debug, Default)]
pub struct JsonLineDecoder {
	buffer:     Vec<u8>,
	discarding: bool,
}

impl JsonLineDecoder {
	/// Creates an empty decoder.
	pub fn new() -> Self {
		Self::default()
	}

	/// Appends bytes and returns each complete non-empty JSON line.
	pub fn push(&mut self, input: &[u8]) -> DecodeBatch {
		self.buffer.extend_from_slice(input);
		let mut output = DecodeBatch::default();
		while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
			let mut line = self.buffer.drain(..=end).collect::<Vec<_>>();
			line.pop();
			if line.last() == Some(&b'\r') {
				line.pop();
			}
			if self.discarding {
				self.discarding = false;
				continue;
			}
			if line.is_empty() {
				continue;
			}
			if line.len().saturating_add(1) > MAX_FRAME_BYTES {
				output.diagnostics.push(FramingDiagnostic {
					skipped_bytes: line.len(),
					reason:        "JSON line exceeds transport limit",
				});
				continue;
			}
			output.frames.push(line);
		}
		if self.buffer.len() >= MAX_FRAME_BYTES && !self.discarding {
			let skipped_bytes = self.buffer.len();
			self.buffer.clear();
			self.discarding = true;
			output
				.diagnostics
				.push(FramingDiagnostic { skipped_bytes, reason: "JSON line exceeds transport limit" });
		}
		output
	}

	/// Returns buffered bytes that do not yet form a complete line.
	pub fn remainder(&self) -> &[u8] {
		&self.buffer
	}
}

/// A physical or logical framing error.
#[derive(Debug)]
pub enum FramingError {
	/// A physical frame exceeds [`MAX_FRAME_BYTES`].
	FrameTooLarge {
		/// Actual serialized payload size.
		bytes: usize,
	},
	/// A logical protocol-v2 frame exceeds [`MAX_REASSEMBLED_BYTES`].
	LogicalFrameTooLarge {
		/// Actual or declared logical payload size.
		bytes: usize,
	},
	/// JSON serialization or parsing failed.
	Json(serde_json::Error),
	/// A protocol-v2 chunk envelope is malformed or inconsistent.
	InvalidChunk(&'static str),
	/// A protocol-v2 chunk arrived out of sequence.
	ChunkOutOfOrder {
		/// Next required zero-based index.
		expected: usize,
		/// Received zero-based index.
		actual:   usize,
	},
}

impl Display for FramingError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::FrameTooLarge { bytes } => {
				write!(f, "physical RPC frame is {bytes} bytes; limit is {MAX_FRAME_BYTES}")
			},
			Self::LogicalFrameTooLarge { bytes } => {
				write!(f, "logical RPC frame is {bytes} bytes; limit is {MAX_REASSEMBLED_BYTES}")
			},
			Self::Json(error) => write!(f, "invalid RPC JSON: {error}"),
			Self::InvalidChunk(reason) => write!(f, "invalid RPC chunk: {reason}"),
			Self::ChunkOutOfOrder { expected, actual } => {
				write!(f, "RPC chunk index {actual} arrived; expected {expected}")
			},
		}
	}
}

impl error::Error for FramingError {
	fn source(&self) -> Option<&(dyn error::Error + 'static)> {
		match self {
			Self::Json(error) => Some(error),
			_ => None,
		}
	}
}

impl From<serde_json::Error> for FramingError {
	fn from(error: serde_json::Error) -> Self {
		Self::Json(error)
	}
}

/// Incremental decoder for `Content-Length: n\r\n\r\n<payload>` streams.
///
/// Corrupt header blocks and oversized frames are discarded and reported in
/// [`DecodeBatch::diagnostics`]; decoding then continues at the next header.
#[derive(Debug, Default)]
pub struct ContentLengthDecoder {
	buffer:            Vec<u8>,
	body_length:       Option<(usize, usize)>,
	discard_remaining: usize,
	resync_count:      u64,
}

impl ContentLengthDecoder {
	/// Creates an empty decoder.
	pub fn new() -> Self {
		Self::default()
	}

	/// Appends bytes and returns every newly completed payload and diagnostic.
	pub fn push(&mut self, input: &[u8]) -> DecodeBatch {
		self.buffer.extend_from_slice(input);
		let mut output = DecodeBatch::default();
		loop {
			if self.discard_remaining != 0 {
				let remove = self.discard_remaining.min(self.buffer.len());
				self.buffer.drain(..remove);
				self.discard_remaining -= remove;
				if self.discard_remaining != 0 {
					break;
				}
			}
			if let Some((header_length, body_length)) = self.body_length {
				let frame_length = header_length + body_length;
				if self.buffer.len() < frame_length {
					break;
				}
				self.buffer.drain(..header_length);
				output
					.frames
					.push(self.buffer.drain(..body_length).collect());
				self.body_length = None;
				continue;
			}
			let Some(header_end) = find_bytes(&self.buffer, b"\r\n\r\n") else {
				if self.buffer.len() > MAX_FRAME_BYTES {
					let keep_from = find_ascii_case_insensitive(&self.buffer[1..], b"content-length:")
						.map_or_else(|| self.buffer.len().saturating_sub(3), |offset| offset + 1);
					self.buffer.drain(..keep_from);
					self.resync(&mut output, keep_from, "unterminated header exceeds transport limit");
					continue;
				}
				break;
			};
			let block_end = header_end + 4;
			let length = parse_content_length(&self.buffer[..header_end]);
			match length {
				Some(length) if length <= MAX_FRAME_BYTES => {
					self.body_length = Some((block_end, length));
				},
				Some(length) => {
					self.buffer.drain(..block_end);
					self.discard_remaining = length;
					self.resync(&mut output, block_end, "Content-Length exceeds transport limit");
				},
				None => {
					self.buffer.drain(..block_end);
					self.resync(&mut output, block_end, "header block has no valid Content-Length");
				},
			}
		}
		output
	}

	fn resync(&mut self, output: &mut DecodeBatch, skipped_bytes: usize, reason: &'static str) {
		self.resync_count += 1;
		output
			.diagnostics
			.push(FramingDiagnostic { skipped_bytes, reason });
	}

	/// Returns buffered bytes that do not yet form a complete frame.
	pub fn remainder(&self) -> &[u8] {
		&self.buffer
	}

	/// Removes and returns the buffered incomplete remainder.
	pub fn take_remainder(&mut self) -> Vec<u8> {
		self.body_length = None;
		self.discard_remaining = 0;
		mem::take(&mut self.buffer)
	}

	/// Returns the lifetime number of non-fatal resynchronizations.
	pub const fn resync_count(&self) -> u64 {
		self.resync_count
	}
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	haystack
		.windows(needle.len())
		.position(|window| window == needle)
}

fn find_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	haystack
		.windows(needle.len())
		.position(|window| window.eq_ignore_ascii_case(needle))
}

fn parse_content_length(header: &[u8]) -> Option<usize> {
	header.split(|byte| *byte == b'\n').find_map(|line| {
		let line = line.strip_suffix(b"\r").unwrap_or(line);
		let colon = line.iter().position(|byte| *byte == b':')?;
		let (name, value) = line.split_at(colon);
		if !name.eq_ignore_ascii_case(b"content-length") {
			return None;
		}
		str::from_utf8(&value[1..]).ok()?.trim().parse().ok()
	})
}

/// Adds a Content-Length header to one physical payload.
pub fn encode_content_length(payload: &[u8]) -> Result<Vec<u8>, FramingError> {
	if payload.len() > MAX_FRAME_BYTES {
		return Err(FramingError::FrameTooLarge { bytes: payload.len() });
	}
	let header = format!("Content-Length: {}\r\n\r\n", payload.len());
	let mut framed = Vec::with_capacity(header.len() + payload.len());
	framed.extend_from_slice(header.as_bytes());
	framed.extend_from_slice(payload);
	Ok(framed)
}

/// Serializes a JSON value for protocol v2, chunking logical frames when
/// needed.
///
/// Returned elements are complete newline-terminated physical messages.
pub fn encode_json_v2(value: &Value, sequence_id: &str) -> Result<Vec<Vec<u8>>, FramingError> {
	encode_json_v2_payload(value, sequence_id)
}

/// Serializes protocol-v2 JSON after removing already-streamed terminal
/// messages.
///
/// This is equivalent to [`encode_json_v2`] for non-`agent_end` values.
pub fn encode_json_v2_with_streamed<S: BuildHasher>(
	value: &Value,
	sequence_id: &str,
	streamed_message_ids: &HashSet<String, S>,
) -> Result<Vec<Vec<u8>>, FramingError> {
	let mut compacted = value.clone();
	strip_streamed_agent_end_messages(&mut compacted, streamed_message_ids);
	encode_json_v2_payload(&compacted, sequence_id)
}

fn encode_json_v2_payload(value: &Value, sequence_id: &str) -> Result<Vec<Vec<u8>>, FramingError> {
	let payload = serde_json::to_vec(value)?;
	if payload.len() > MAX_REASSEMBLED_BYTES {
		return Err(FramingError::LogicalFrameTooLarge { bytes: payload.len() });
	}
	if payload.len().saturating_add(1) <= MAX_FRAME_BYTES {
		return Ok(vec![encode_json_line(&payload)?]);
	}
	let count = payload.len().div_ceil(RPC_CHUNK_BYTES);
	payload
		.chunks(RPC_CHUNK_BYTES)
		.enumerate()
		.map(|(index, chunk)| {
			let envelope = json!({
				"type": "rpc_chunk",
				"chunkId": sequence_id,
				"index": index,
				"count": count,
				"byteLength": payload.len(),
				"data": base64::encode(chunk).into_string(),
			});
			encode_json_line(&serde_json::to_vec(&envelope)?)
		})
		.collect()
}

fn encode_json_line(payload: &[u8]) -> Result<Vec<u8>, FramingError> {
	if payload.len().saturating_add(1) > MAX_FRAME_BYTES {
		return Err(FramingError::FrameTooLarge { bytes: payload.len().saturating_add(1) });
	}
	let mut framed = Vec::with_capacity(payload.len() + 1);
	framed.extend_from_slice(payload);
	framed.push(b'\n');
	Ok(framed)
}

#[derive(Debug)]
struct ChunkSequence {
	id:          String,
	count:       usize,
	byte_length: usize,
	next_index:  usize,
	bytes:       Vec<u8>,
}

/// Incrementally reassembles protocol-v2 `rpc_chunk` envelopes.
#[derive(Debug, Default)]
pub struct RpcFrameDecoder {
	sequence: Option<ChunkSequence>,
}

impl RpcFrameDecoder {
	/// Creates an empty logical frame decoder.
	pub fn new() -> Self {
		Self::default()
	}

	/// Consumes one physical JSON payload.
	///
	/// Direct JSON frames are returned immediately. Incomplete chunk sequences
	/// return `Ok(None)`.
	pub fn push_frame(&mut self, payload: &[u8]) -> Result<Option<Value>, FramingError> {
		let value: Value = serde_json::from_slice(payload)?;
		if value.get("type").and_then(Value::as_str) != Some("rpc_chunk") {
			if self.sequence.is_some() {
				return Err(FramingError::InvalidChunk("direct frame interrupted chunk sequence"));
			}
			return Ok(Some(value));
		}
		let object = value
			.as_object()
			.ok_or(FramingError::InvalidChunk("envelope is not an object"))?;
		let id = object
			.get("chunkId")
			.and_then(Value::as_str)
			.ok_or(FramingError::InvalidChunk("missing chunkId"))?;
		let index = json_usize(object, "index")?;
		let count = json_usize(object, "count")?;
		let byte_length = json_usize(object, "byteLength")?;
		if id.is_empty() || id.len() > 128 {
			return Err(FramingError::InvalidChunk("invalid chunkId"));
		}
		if count < 2 || count > MAX_REASSEMBLED_BYTES.div_ceil(RPC_CHUNK_BYTES) {
			return Err(FramingError::InvalidChunk("invalid chunk count"));
		}
		if !(MAX_FRAME_BYTES..=MAX_REASSEMBLED_BYTES).contains(&byte_length) {
			return Err(FramingError::LogicalFrameTooLarge { bytes: byte_length });
		}
		if index >= count {
			return Err(FramingError::InvalidChunk("chunk index is outside count"));
		}
		let encoded = object
			.get("data")
			.and_then(Value::as_str)
			.ok_or(FramingError::InvalidChunk("missing chunk data"))?;
		if encoded.is_empty() {
			return Err(FramingError::InvalidChunk("empty chunk data"));
		}
		let chunk = base64::decode(encoded)
			.into_vec()
			.map_err(|_| FramingError::InvalidChunk("invalid base64 data"))?;
		if chunk.len() > RPC_CHUNK_BYTES {
			return Err(FramingError::InvalidChunk("chunk exceeds raw chunk limit"));
		}

		if self.sequence.is_none() {
			if index != 0 {
				return Err(FramingError::ChunkOutOfOrder { expected: 0, actual: index });
			}
			self.sequence = Some(ChunkSequence {
				id: id.to_owned(),
				count,
				byte_length,
				next_index: 0,
				bytes: Vec::with_capacity(byte_length),
			});
		}
		let sequence = self.sequence.as_mut().expect("sequence initialized");
		if sequence.id != id || sequence.count != count || sequence.byte_length != byte_length {
			return Err(FramingError::InvalidChunk("chunk metadata changed within sequence"));
		}
		if index != sequence.next_index {
			return Err(FramingError::ChunkOutOfOrder {
				expected: sequence.next_index,
				actual:   index,
			});
		}
		if sequence.bytes.len() + chunk.len() > sequence.byte_length {
			return Err(FramingError::InvalidChunk("chunk data exceeds declared byteLength"));
		}
		sequence.bytes.extend_from_slice(&chunk);
		sequence.next_index += 1;
		if sequence.next_index != sequence.count {
			return Ok(None);
		}
		let complete = self.sequence.take().expect("completed sequence exists");
		if complete.bytes.len() != complete.byte_length {
			return Err(FramingError::InvalidChunk("reassembled length differs from byteLength"));
		}
		Ok(Some(serde_json::from_slice(&complete.bytes)?))
	}

	/// Discards an incomplete chunk sequence.
	pub fn reset(&mut self) {
		self.sequence = None;
	}
}

fn json_usize(object: &Map<String, Value>, key: &'static str) -> Result<usize, FramingError> {
	object
		.get(key)
		.and_then(Value::as_u64)
		.and_then(|value| usize::try_from(value).ok())
		.ok_or(FramingError::InvalidChunk(key))
}

/// Serializes one protocol-v1 JSON frame with deterministic progressive
/// shrinking.
///
/// For terminal `agent_end` values, messages whose `id` is present in
/// `streamed_message_ids` are removed before sizing. If shrinking cannot fit
/// the frame, a small structured overflow frame matching the original kind is
/// returned.
pub fn encode_json_v1<S: BuildHasher>(
	value: &Value,
	streamed_message_ids: &HashSet<String, S>,
) -> Vec<u8> {
	if value.get("type").and_then(Value::as_str) == Some("agent_end") {
		let mut candidate = value.clone();
		strip_streamed_agent_end_messages(&mut candidate, streamed_message_ids);
		return encode_json_v1_candidate(&candidate);
	}
	encode_json_v1_candidate(value)
}

fn encode_json_v1_candidate(candidate: &Value) -> Vec<u8> {
	if let Some(frame) = serialize_fitting(candidate) {
		return frame;
	}
	const PASSES: &[(usize, usize, usize)] = &[
		(256 * 1024, 512, 512),
		(64 * 1024, 256, 256),
		(16 * 1024, 128, 128),
		(4 * 1024, 64, 64),
		(1_024, 32, 32),
		(256, 8, 16),
		(64, 1, 8),
	];
	for &(strings, arrays, keys) in PASSES {
		let shrunk = shrink_value(candidate, strings, arrays, keys);
		if let Some(frame) = serialize_fitting(&shrunk) {
			return frame;
		}
	}
	encode_overflow(candidate)
}

fn serialize_fitting(value: &Value) -> Option<Vec<u8>> {
	let payload = serde_json::to_vec(value).ok()?;
	encode_json_line(&payload).ok()
}

fn encode_overflow(value: &Value) -> Vec<u8> {
	let overflow = match value.get("type").and_then(Value::as_str) {
		Some("response") => json!({
			"id": metadata_string(value.get("id")),
			"type": "response",
			"command": metadata_string(value.get("command")).unwrap_or_else(|| "unknown".into()),
			"success": false,
			"error": "RPC response exceeded the transport limit",
		}),
		Some("agent_end") => json!({
			"type": "agent_end",
			"messages": [],
			"messageCount": value.get("messageCount").and_then(Value::as_u64).unwrap_or(0),
		}),
		kind => json!({
			"type": "rpc_frame_error",
			"originalType": kind.map(|kind| truncate_string(kind, 1024)),
			"error": "RPC frame exceeded the transport limit",
		}),
	};
	encode_json_line(&serde_json::to_vec(&overflow).expect("overflow frame serializes"))
		.expect("overflow frame fits transport limit")
}

fn metadata_string(value: Option<&Value>) -> Option<String> {
	value
		.and_then(Value::as_str)
		.map(|value| truncate_string(value, 1024))
}

fn truncate_string(value: &str, cap: usize) -> String {
	let length = value.chars().count();
	if length <= cap {
		return value.to_owned();
	}
	let head_length = cap.saturating_sub(80);
	let head: String = value.chars().take(head_length).collect();
	format!("{head}\n…[{} chars elided for RPC frame]", length - head_length)
}

fn strip_streamed_agent_end_messages<S: BuildHasher>(
	value: &mut Value,
	streamed: &HashSet<String, S>,
) {
	if value.get("type").and_then(Value::as_str) != Some("agent_end") {
		return;
	}
	let Some(messages) = value.get_mut("messages").and_then(Value::as_array_mut) else {
		return;
	};
	let message_count = messages.len();
	messages.retain(|message| {
		message
			.get("id")
			.and_then(Value::as_str)
			.is_none_or(|id| !streamed.contains(id))
	});
	if let Some(object) = value.as_object_mut() {
		object.insert("messageCount".into(), json!(message_count));
	}
}

fn shrink_value(value: &Value, max_string: usize, max_array: usize, max_keys: usize) -> Value {
	match value {
		Value::String(string) if string.chars().count() > max_string => {
			Value::String(truncate_string(string, max_string))
		},
		Value::Array(array) => {
			let mut shrunk: Vec<_> = array
				.iter()
				.take(max_array)
				.map(|item| shrink_value(item, max_string, max_array, max_keys))
				.collect();
			if array.len() > max_array {
				shrunk.push(Value::String(format!(
					"…[{} items elided for RPC frame]",
					array.len() - max_array
				)));
			}
			Value::Array(shrunk)
		},
		Value::Object(object) => {
			let mut shrunk = Map::new();
			for (key, item) in object.iter().take(max_keys) {
				shrunk.insert(key.clone(), shrink_value(item, max_string, max_array, max_keys));
			}
			if object.len() > max_keys {
				shrunk.insert("rpcFrameElidedKeys".into(), json!(object.len() - max_keys));
			}
			Value::Object(shrunk)
		},
		_ => value.clone(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn split_header_and_body_preserve_remainder() {
		let mut decoder = ContentLengthDecoder::new();
		assert!(decoder.push(b"content-LE").frames.is_empty());
		assert_eq!(decoder.remainder(), b"content-LE");
		assert!(decoder.push(b"ngth: 5\r\n\r\nhe").frames.is_empty());
		assert_eq!(decoder.remainder(), b"content-LEngth: 5\r\n\r\nhe");
		let remainder = decoder.take_remainder();
		let mut restarted = ContentLengthDecoder::new();
		assert!(restarted.push(&remainder).frames.is_empty());
		assert_eq!(restarted.push(b"llo").frames, vec![b"hello".to_vec()]);
		assert_eq!(restarted.remainder(), b"");
	}

	#[test]
	fn junk_block_resynchronizes_to_valid_frame() {
		let mut decoder = ContentLengthDecoder::new();
		let batch = decoder.push(b"garbage: yes\r\n\r\nContent-Length: 2\r\n\r\n{}");
		assert_eq!(batch.frames, vec![b"{}".to_vec()]);
		assert_eq!(batch.diagnostics.len(), 1);
		assert_eq!(decoder.resync_count(), 1);
	}
	#[test]
	fn json_lines_decode_fragmented_and_batched_frames() {
		let mut decoder = JsonLineDecoder::new();
		assert!(decoder.push(br#"{"type":"pro"#).frames.is_empty());
		let batch = decoder.push(b"mpt\"}\n\n{\"type\":\"abort\"}\r\n");
		assert_eq!(batch.frames, vec![
			br#"{"type":"prompt"}"#.to_vec(),
			br#"{"type":"abort"}"#.to_vec(),
		]);
	}

	#[test]
	fn physical_limit_is_reported_and_oversized_input_is_discarded() {
		assert!(matches!(
			encode_content_length(&vec![0; MAX_FRAME_BYTES + 1]),
			Err(FramingError::FrameTooLarge { .. })
		));
		let mut decoder = ContentLengthDecoder::new();
		let header = format!("Content-Length: {}\r\n\r\n", MAX_FRAME_BYTES + 1);
		let batch = decoder.push(header.as_bytes());
		assert_eq!(batch.diagnostics.len(), 1);
		assert!(batch.frames.is_empty());
	}

	#[test]
	fn v2_round_trips_json_larger_than_physical_limit() {
		let original = json!({"type":"large", "text":"x".repeat(MAX_FRAME_BYTES + 123_456)});
		let encoded = encode_json_v2(&original, "sequence-1").unwrap();
		assert!(encoded.len() > 1);
		let mut physical = JsonLineDecoder::new();
		let mut logical = RpcFrameDecoder::new();
		let mut decoded = None;
		for wire in encoded {
			for payload in physical.push(&wire).frames {
				decoded = logical.push_frame(&payload).unwrap().or(decoded);
			}
		}
		assert_eq!(decoded, Some(original));
	}

	#[test]
	fn v2_rejects_out_of_order_chunk() {
		let envelope = json!({
			"type":"rpc_chunk",
			"chunkId":"s",
			"index":1,
			"count":2,
			"byteLength":MAX_FRAME_BYTES,
			"data":base64::encode(b"x").into_string(),
		});
		let mut decoder = RpcFrameDecoder::new();
		assert!(matches!(
			decoder.push_frame(&serde_json::to_vec(&envelope).unwrap()),
			Err(FramingError::ChunkOutOfOrder { .. })
		));
	}

	#[test]
	fn v1_terminal_frame_drops_streamed_messages() {
		let value =
			json!({"type":"agent_end","messages":[{"id":"sent","text":"a"},{"id":"new","text":"b"}]});
		let wire = encode_json_v1(&value, &HashSet::from(["sent".to_owned()]));
		let mut decoder = JsonLineDecoder::new();
		let frames = decoder.push(&wire).frames;
		let decoded: Value = serde_json::from_slice(&frames[0]).unwrap();
		assert_eq!(decoded["messages"].as_array().unwrap().len(), 1);
		assert_eq!(decoded["messages"][0]["id"], "new");
		assert_eq!(decoded["messageCount"], 2);
	}

	#[test]
	fn v1_oversized_response_shrinks_before_overflow() {
		let value = json!({
			"id": "request-1",
			"type": "response",
			"command": "large",
			"success": true,
			"result": "x".repeat(MAX_FRAME_BYTES + 1),
		});
		let wire = encode_json_v1(&value, &HashSet::new());
		let frames = JsonLineDecoder::new().push(&wire).frames;
		let decoded: Value = serde_json::from_slice(&frames[0]).unwrap();
		assert_eq!(decoded["type"], "response");
		assert_eq!(decoded["success"], true);
		assert!(decoded.get("error").is_none());
		assert!(
			decoded["result"]
				.as_str()
				.unwrap()
				.contains("elided for RPC frame")
		);
	}
}
