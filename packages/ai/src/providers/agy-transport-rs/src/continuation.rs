use std::{
	borrow::Cow,
	io,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use prost_reflect::Value as ProtoValue;
use rand::RngCore;
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::{
	io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt},
	sync::mpsc,
};

use crate::{
	Result,
	serialize::{CcpaSerializer, decode_checkpoint},
	transport::{OutboundRequest, Transport, UpstreamResponse},
};

pub const MAX_CONTINUATIONS: usize = 32;
pub const MAX_CHECKPOINT_RETRIES: usize = 3;
const FINAL_MAX_TOKENS: &[u8] = br#"{"response":{"candidates":[{"finishReason":"MAX_TOKENS"}]}}"#;

#[derive(Default, Debug)]
pub struct ContinuationState {
	token:           String,
	dirty:           bool,
	finish_hidden:   bool,
	finish:          String,
	continuations:   usize,
	retries:         usize,
	max_output:      i64,
	input:           i64,
	cache:           i64,
	thinking:        i64,
	output:          i64,
	prior_thinking:  i64,
	prior_output:    i64,
	initial_details: Map<String, Value>,
}

pub struct Observed<'a> {
	pub data:           Cow<'a, [u8]>,
	pub upstream_error: bool,
}

#[derive(Debug, Eq, PartialEq)]
pub enum NextLeg {
	Complete,
	FinalMaxTokens,
	Continue,
	Retry { attempt: usize },
}

fn nonnegative(value: &Value) -> i64 {
	value.as_i64().filter(|value| *value >= 0).unwrap_or(0)
}
fn finish_name(value: &Value) -> &str {
	if let Some(value) = value.as_str() {
		return value;
	}
	match value.as_i64() {
		None | Some(0) => "",
		Some(2) => "MAX_TOKENS",
		Some(18) => "CONTINUATION",
		_ => "TERMINAL",
	}
}
fn object(value: &mut Value) -> Result<&mut Map<String, Value>> {
	value
		.as_object_mut()
		.ok_or_else(|| "CCPA event contains a non-object message".into())
}

impl ContinuationState {
	pub fn new(max_output: i64) -> Self {
		Self { max_output, ..Self::default() }
	}

	fn thinking_total(&self) -> i64 {
		self.prior_thinking.wrapping_add(self.thinking)
	}

	fn output_total(&self) -> i64 {
		self.prior_output.wrapping_add(self.output)
	}

	fn budget_allows(&self) -> bool {
		self.max_output <= 0
			|| self.thinking_total().wrapping_add(self.output_total()) < self.max_output
	}

	fn can_continue(&self) -> bool {
		!self.token.is_empty()
			&& !self.dirty
			&& self.continuations < MAX_CONTINUATIONS
			&& self.budget_allows()
			&& matches!(self.finish.as_str(), "CONTINUATION" | "MAX_TOKENS")
	}

	pub fn observe<'a>(&mut self, data: &'a [u8]) -> Result<Observed<'a>> {
		let mut event: Value = serde_json::from_slice(data)?;
		if event.is_null() {
			return Ok(Observed { data: Cow::Borrowed(data), upstream_error: false });
		}
		let event_map = object(&mut event)?;
		if event_map.get("error").is_some_and(|value| !value.is_null()) {
			return Ok(Observed { data: Cow::Borrowed(data), upstream_error: true });
		}
		let Some(response) = event_map
			.get_mut("response")
			.filter(|value| !value.is_null())
		else {
			return Ok(Observed { data: Cow::Borrowed(data), upstream_error: false });
		};
		let response = object(response)?;
		if let Some(usage) = response
			.get_mut("usageMetadata")
			.filter(|value| !value.is_null())
		{
			let usage = object(usage)?;
			if let Some(value) = usage.get("thoughtsTokenCount") {
				self.thinking = nonnegative(value);
			}
			if let Some(value) = usage.get("candidatesTokenCount") {
				self.output = nonnegative(value);
			}
			if self.continuations == 0 && self.retries == 0 {
				let prompt = usage
					.get("promptTokenCount")
					.map(nonnegative)
					.unwrap_or(self.input.wrapping_add(self.cache));
				if let Some(value) = usage.get("cachedContentTokenCount") {
					self.cache = nonnegative(value);
				}
				self.input = prompt.wrapping_sub(self.cache).max(0);
				for key in ["promptTokensDetails", "cacheTokensDetails", "toolUsePromptTokensDetails"] {
					if let Some(value) = usage.get(key) {
						self.initial_details.insert(key.into(), value.clone());
					}
				}
			}
			let prompt = self.input.wrapping_add(self.cache);
			for (key, value) in [
				("promptTokenCount", prompt),
				("cachedContentTokenCount", self.cache),
				("thoughtsTokenCount", self.thinking_total()),
				("candidatesTokenCount", self.output_total()),
				(
					"totalTokenCount",
					prompt
						.wrapping_add(self.thinking_total())
						.wrapping_add(self.output_total()),
				),
			] {
				usage.insert(key.into(), value.into());
			}
			for key in ["promptTokensDetails", "cacheTokensDetails", "toolUsePromptTokensDetails"] {
				if let Some(value) = self.initial_details.get(key) {
					usage.insert(key.into(), value.clone());
				} else {
					usage.remove(key);
				}
			}
		}
		if let Some(candidates) = response
			.get_mut("candidates")
			.filter(|value| !value.is_null())
		{
			let candidates = candidates
				.as_array_mut()
				.ok_or("CCPA candidates must be an array")?;
			let candidate_count = candidates.len();
			for candidate in candidates.iter_mut() {
				if candidate.is_null() {
					continue;
				}
				let candidate = object(candidate)?;
				let token = match candidate.get("continuationToken") {
					None | Some(Value::Null) => "",
					Some(value) => value
						.as_str()
						.ok_or("CCPA continuationToken must be a string")?,
				};
				if !token.is_empty() {
					if candidate_count != 1 {
						return Err(
							"checkpoint continuation with multiple candidates is unsupported".into(),
						);
					}
					decode_checkpoint(token)?;
					self.token.clear();
					self.token.push_str(token);
					self.dirty = false;
				} else if let Some(content) = candidate
					.get_mut("content")
					.filter(|value| !value.is_null())
				{
					let content = object(content)?;
					if let Some(parts) = content.get("parts").filter(|value| !value.is_null()) {
						if !parts
							.as_array()
							.ok_or("CCPA content parts must be an array")?
							.is_empty()
						{
							self.dirty = true;
						}
					}
				}
			}
			if let Some(candidate) = candidates.first_mut().filter(|value| !value.is_null()) {
				let candidate = object(candidate)?;
				let finish = candidate.get("finishReason").map(finish_name).unwrap_or("");
				if !finish.is_empty() {
					self.finish.clear();
					self.finish.push_str(finish);
					if self.can_continue() {
						candidate.remove("finishReason");
						candidate.remove("finishMessage");
						self.finish_hidden = true;
					} else if self.finish == "CONTINUATION"
						&& (!self.budget_allows() || self.continuations >= MAX_CONTINUATIONS)
					{
						candidate.insert("finishReason".into(), "MAX_TOKENS".into());
						self.finish_hidden = false;
					} else {
						self.finish_hidden = false;
					}
				}
			}
		}
		Ok(Observed {
			data:           Cow::Owned(serde_json::to_vec(&event)?),
			upstream_error: false,
		})
	}

	pub fn finish_leg(&mut self, interrupted: bool) -> Result<NextLeg> {
		if !interrupted {
			if !self.can_continue() {
				if self.finish == "CONTINUATION"
					&& self.budget_allows()
					&& self.continuations < MAX_CONTINUATIONS
				{
					return Err(
						"cannot continue without a checkpoint covering all emitted output".into(),
					);
				}
				return Ok(if self.finish_hidden {
					NextLeg::FinalMaxTokens
				} else {
					NextLeg::Complete
				});
			}
			self.continuations += 1;
			Ok(NextLeg::Continue)
		} else {
			if self.dirty
				|| self.token.is_empty()
				|| self.retries >= MAX_CHECKPOINT_RETRIES
				|| !self.budget_allows()
				|| !matches!(self.finish.as_str(), "" | "CONTINUATION" | "MAX_TOKENS")
			{
				return Err("checkpoint recovery is not safe for this stream state".into());
			}
			self.retries += 1;
			Ok(NextLeg::Retry { attempt: self.retries })
		}
	}

	fn begin_leg(&mut self) {
		self.prior_thinking = self.thinking_total();
		self.prior_output = self.output_total();
		self.thinking = 0;
		self.output = 0;
		self.finish.clear();
		self.dirty = false;
		self.token.clear();
		self.finish_hidden = false;
	}
}

/// SSE line parsing deliberately follows the Go helper, not a generic SSE
/// reconnect implementation: comments/ids are ignored, data lines join with LF,
/// and an exact [DONE] terminates the current upstream leg.
pub struct EventReader<R> {
	reader: R,
	line:   Vec<u8>,
	data:   Vec<u8>,
	ended:  bool,
}
impl<R: AsyncBufRead + Unpin> EventReader<R> {
	pub fn new(reader: R) -> Self {
		Self { reader, line: Vec::new(), data: Vec::new(), ended: false }
	}

	pub async fn next(&mut self) -> io::Result<Option<&[u8]>> {
		self.data.clear();
		if self.ended {
			return Ok(None);
		}
		loop {
			self.line.clear();
			let count = self.reader.read_until(b'\n', &mut self.line).await?;
			if self.line.last() == Some(&b'\n') {
				self.line.pop();
			}
			if self.line.last() == Some(&b'\r') {
				self.line.pop();
			}
			if self.line.is_empty() {
				if !self.data.is_empty() {
					if self.data == b"[DONE]" {
						self.ended = true;
						return Ok(None);
					}
					return Ok(Some(&self.data));
				}
			} else if let Some(value) = self.line.strip_prefix(b"data:") {
				let value = value.strip_prefix(b" ").unwrap_or(value);
				if !self.data.is_empty() {
					self.data.push(b'\n');
				}
				self.data.extend_from_slice(value);
			}
			if count == 0 {
				self.ended = true;
				return Ok(
					(!self.data.is_empty() && self.data != b"[DONE]").then_some(self.data.as_slice())
				);
			}
		}
	}
}

pub fn fresh_continuation_request(
	codec: &CcpaSerializer,
	original: &[u8],
	token: &str,
) -> Result<Vec<u8>> {
	let millis = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as i64;
	fresh_request_with(codec, original, token, millis, || {
		let mut bytes = [0_u8; 16];
		rand::rngs::OsRng.try_fill_bytes(&mut bytes)?;
		Ok(bytes)
	})
}

fn fresh_request_with(
	codec: &CcpaSerializer,
	original: &[u8],
	token: &str,
	millis: i64,
	uuid: impl FnOnce() -> Result<[u8; 16]>,
) -> Result<Vec<u8>> {
	let mut message = codec.parse(original)?;
	let id = message
		.get_field_by_name("request_id")
		.ok_or("missing request_id descriptor")?;
	let mut parts: Vec<_> = id
		.as_str()
		.ok_or("request ID is not a string")?
		.split('/')
		.map(Cow::Borrowed)
		.collect();
	match parts.len() {
		4 => parts[1] = Cow::Owned(millis.to_string()),
		5 => parts[2] = Cow::Owned(millis.to_string()),
		2 => {
			let mut bytes = uuid()?;
			bytes[6] = bytes[6] & 15 | 64;
			bytes[8] = bytes[8] & 63 | 128;
			parts[1] = Cow::Owned(format!(
				"{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:\
				 02x}{:02x}{:02x}",
				bytes[0],
				bytes[1],
				bytes[2],
				bytes[3],
				bytes[4],
				bytes[5],
				bytes[6],
				bytes[7],
				bytes[8],
				bytes[9],
				bytes[10],
				bytes[11],
				bytes[12],
				bytes[13],
				bytes[14],
				bytes[15]
			));
		},
		_ => return Err("cannot continue an unrecognized native request ID shape".into()),
	}
	let new_id = parts.join("/");
	drop(parts);
	drop(id);
	message.set_field_by_name("request_id", ProtoValue::String(new_id));
	let request = message
		.get_field_by_name_mut("request")
		.and_then(ProtoValue::as_message_mut)
		.ok_or("missing request descriptor")?;
	request
		.set_field_by_name("continuation_token", ProtoValue::Bytes(decode_checkpoint(token)?.into()));
	codec.encode(&message)
}

pub type EventSender = mpsc::Sender<io::Result<Bytes>>;

pub async fn write_event(sender: &EventSender, event: &[u8]) -> Result<()> {
	let mut bytes = Vec::with_capacity(event.len() + 8);
	bytes.extend_from_slice(b"data: ");
	bytes.extend_from_slice(event);
	bytes.extend_from_slice(b"\n\n");
	sender
		.send(Ok(bytes.into()))
		.await
		.map_err(|_| -> crate::Error {
			io::Error::new(io::ErrorKind::BrokenPipe, "local bridge disconnected").into()
		})
}

#[derive(Default, Serialize)]
pub struct CcpaError {
	#[serde(skip_serializing_if = "is_zero")]
	pub code:    u16,
	pub message: String,
	#[serde(skip_serializing_if = "String::is_empty")]
	pub status:  String,
}
fn is_zero(value: &u16) -> bool {
	*value == 0
}

pub async fn write_error(sender: &EventSender, error: CcpaError) -> Result<()> {
	#[derive(Serialize)]
	struct Envelope {
		error: CcpaError,
	}
	write_event(sender, &serde_json::to_vec(&Envelope { error })?).await
}

async fn write_http_error(sender: &EventSender, response: UpstreamResponse) -> Result<()> {
	let code = response.status.as_u16();
	let fallback = response.status.canonical_reason().unwrap_or("").to_owned();
	let mut failure = CcpaError { code, ..CcpaError::default() };
	match response.decoded_body().await {
		Err(error) => failure.message = error.to_string(),
		Ok(mut reader) => {
			let mut bytes = Vec::new();
			let read_error = (&mut reader)
				.take(64 * 1024 + 1)
				.read_to_end(&mut bytes)
				.await
				.err();
			let truncated = bytes.len() > 64 * 1024;
			bytes.truncate(64 * 1024);
			if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
				failure.message = value["error"]["message"].as_str().unwrap_or("").to_owned();
				failure.status = value["error"]["status"].as_str().unwrap_or("").to_owned();
			}
			if failure.message.is_empty() {
				failure.message = String::from_utf8_lossy(&bytes).trim().to_owned();
			}
			if truncated {
				failure.message.push_str(" (truncated)");
			}
			if failure.message.is_empty()
				&& let Some(error) = read_error
			{
				failure.message = error.to_string();
			}
		},
	}
	if failure.message.is_empty() {
		failure.message = fallback;
	}
	failure.message = format!("continuation HTTP status {code}: {}", failure.message);
	write_error(sender, failure).await
}

/// Cancellation drops the active upstream body/future and cancels retry sleep.
/// There are no detached continuation tasks after the bridge consumer goes
/// away.
pub async fn stream_ccpa(
	transport: &Transport,
	request: &OutboundRequest,
	response: UpstreamResponse,
	original: &[u8],
	codec: &CcpaSerializer,
	sender: &EventSender,
) -> Result<()> {
	tokio::select! {
		 biased;
		 _ = sender.closed() => Ok(()),
		 result = stream_inner(transport, request, response, original, codec, sender) => result,
	}
}

async fn stream_inner(
	transport: &Transport,
	request: &OutboundRequest,
	mut response: UpstreamResponse,
	original: &[u8],
	codec: &CcpaSerializer,
	sender: &EventSender,
) -> Result<()> {
	let envelope: Value = serde_json::from_slice(original)?;
	let mut state = ContinuationState::new(
		envelope["request"]["generationConfig"]["maxOutputTokens"]
			.as_i64()
			.unwrap_or(0),
	);
	loop {
		let mut read_error = None;
		match response.decoded_body().await {
			Err(error) => read_error = Some(error),
			Ok(reader) => {
				let mut events = EventReader::new(reader);
				loop {
					match events.next().await {
						Ok(Some(event)) => {
							let observed = state.observe(event)?;
							write_event(sender, &observed.data).await?;
							if observed.upstream_error {
								return Ok(());
							}
						},
						Ok(None) => break,
						Err(error) => {
							read_error = Some(error);
							break;
						},
					}
				}
			},
		}
		let decision = if let Some(error) = read_error {
			if !crate::transport::recoverable_read_error(&error) {
				return Err(error.into());
			}
			match state.finish_leg(true) {
				Ok(next) => next,
				Err(_) => return Err(error.into()),
			}
		} else {
			state.finish_leg(false)?
		};
		match decision {
			NextLeg::Complete => return Ok(()),
			NextLeg::FinalMaxTokens => return write_event(sender, FINAL_MAX_TOKENS).await,
			NextLeg::Continue => {},
			NextLeg::Retry { attempt } => {
				tokio::time::sleep(retry_delay(attempt)?).await;
			},
		}
		let body = fresh_continuation_request(codec, original, &state.token)?;
		state.begin_leg();
		response = transport.send(request, Bytes::from(body), true).await?;
		if !response.status.is_success() {
			return write_http_error(sender, response).await;
		}
	}
}

fn retry_delay(attempt: usize) -> Result<Duration> {
	let half = (100_u64 << (attempt - 1).min(6)).min(5000) * 1_000_000 / 2;
	// Rejection sampling preserves Go's uniform crypto/rand jitter without
	// turning an OS entropy failure into a panic.
	let threshold = half.wrapping_neg() % half;
	loop {
		let mut bytes = [0_u8; 8];
		rand::rngs::OsRng.try_fill_bytes(&mut bytes)?;
		let sample = u64::from_le_bytes(bytes);
		if sample >= threshold {
			return Ok(Duration::from_nanos(half + sample % half));
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	const ORIGINAL: &[u8] = br#"{"project":"p","requestId":"agent/cascade/1/trajectory/3","request":{"contents":[{"role":"user","parts":[{"text":"wire input"}]}],"labels":{"request_id":"trajectory-1","last_step_index":"2"},"generationConfig":{"maxOutputTokens":256},"sessionId":"-3750763034362895579"},"model":"m","requestType":"agent"}"#;
	const FIRST: &[u8] = br#"{"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"A"}]},"finishReason":"CONTINUATION","continuationToken":"Y2hlY2twb2ludC0x"}],"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":20,"thoughtsTokenCount":2,"candidatesTokenCount":10,"totalTokenCount":112}}}"#;
	const LAST: &[u8] = br#"{"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"B"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":110,"cachedContentTokenCount":25,"thoughtsTokenCount":1,"candidatesTokenCount":5,"totalTokenCount":116}}}"#;
	fn observed(state: &mut ContinuationState, bytes: &[u8]) -> Value {
		serde_json::from_slice(&state.observe(bytes).unwrap().data).unwrap()
	}

	#[test]
	fn continuation_preserves_output_and_counts_initial_prompt_once() {
		let mut state = ContinuationState::new(256);
		let first = observed(&mut state, FIRST);
		assert!(
			first["response"]["candidates"][0]
				.get("finishReason")
				.is_none()
		);
		assert_eq!(state.finish_leg(false).unwrap(), NextLeg::Continue);
		state.begin_leg();
		let last = observed(&mut state, LAST);
		assert_eq!(first["response"]["candidates"][0]["content"]["parts"][0]["text"], "A");
		assert_eq!(last["response"]["candidates"][0]["content"]["parts"][0]["text"], "B");
		assert_eq!(
			last["response"]["usageMetadata"],
			serde_json::json!({"promptTokenCount":100,"cachedContentTokenCount":20,"thoughtsTokenCount":3,"candidatesTokenCount":15,"totalTokenCount":118})
		);
		assert_eq!(state.finish_leg(false).unwrap(), NextLeg::Complete);
	}

	#[test]
	fn usage_snapshots_do_not_double_count_and_trailing_budget_finishes() {
		let mut state = ContinuationState::new(12);
		observed(
			&mut state,
			br#"{"response":{"candidates":[{"finishReason":18,"continuationToken":"YQ=="}]}}"#,
		);
		observed(&mut state, br#"{"response":{"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":20,"thoughtsTokenCount":2,"candidatesTokenCount":8}}}"#);
		let last =
			observed(&mut state, br#"{"response":{"usageMetadata":{"candidatesTokenCount":10}}}"#);
		assert_eq!(last["response"]["usageMetadata"]["totalTokenCount"], 112);
		assert_eq!(state.finish_leg(false).unwrap(), NextLeg::FinalMaxTokens);
	}

	#[test]
	fn dirty_and_consumed_checkpoints_cannot_replay() {
		let mut state = ContinuationState::new(256);
		observed(&mut state, FIRST);
		observed(
			&mut state,
			br#"{"response":{"candidates":[{"content":{"parts":[{"text":"visible tail"}]}}]}}"#,
		);
		assert!(state.finish_leg(true).is_err());
		assert!(state.finish_leg(false).is_err());
		let mut state = ContinuationState::new(256);
		observed(&mut state, FIRST);
		state.finish_leg(false).unwrap();
		state.begin_leg();
		assert!(state.finish_leg(true).is_err());
		observed(&mut state, br#"{"response":{"candidates":[{"finishReason":"CONTINUATION"}]}}"#);
		assert!(state.finish_leg(false).is_err());
	}

	#[test]
	fn independent_leg_and_retry_limits_are_bounded() {
		let mut state = ContinuationState::new(0);
		for _ in 0..MAX_CONTINUATIONS {
			observed(&mut state, FIRST);
			assert_eq!(state.finish_leg(false).unwrap(), NextLeg::Continue);
			state.begin_leg();
		}
		assert_eq!(
			observed(&mut state, FIRST)["response"]["candidates"][0]["finishReason"],
			"MAX_TOKENS"
		);
		assert_eq!(state.finish_leg(false).unwrap(), NextLeg::Complete);
		let mut state = ContinuationState::new(0);
		for attempt in 1..=MAX_CHECKPOINT_RETRIES {
			observed(&mut state, FIRST);
			assert_eq!(state.finish_leg(true).unwrap(), NextLeg::Retry { attempt });
			state.begin_leg();
		}
		observed(&mut state, FIRST);
		assert!(state.finish_leg(true).is_err());
	}

	#[test]
	fn in_band_errors_keep_exact_provider_payload() {
		let error =
			br#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota exhausted"}}"#;
		let result = ContinuationState::new(0).observe(error).unwrap();
		assert!(result.upstream_error);
		assert_eq!(&*result.data, error);
	}

	#[test]
	fn invalid_or_multi_candidate_checkpoints_fail() {
		for data in [
			br#"{"response":{"candidates":[{"continuationToken":"!"}]}}"#.as_slice(),
			br#"{"response":{"candidates":[{"continuationToken":"YQ=="},{}]}}"#,
		] {
			assert!(ContinuationState::new(0).observe(data).is_err());
		}
	}

	#[test]
	fn request_identity_refresh_changes_only_time_and_checkpoint() {
		let codec = CcpaSerializer::new().unwrap();
		let next = fresh_request_with(&codec, ORIGINAL, "-_8", 123456, || {
			panic!("timestamp ID needs no randomness")
		})
		.unwrap();
		let first: Value = serde_json::from_slice(&codec.marshal(ORIGINAL).unwrap()).unwrap();
		let mut next: Value = serde_json::from_slice(&next).unwrap();
		assert_eq!(next["requestId"], "agent/cascade/123456/trajectory/3");
		assert_eq!(next["request"]["continuationToken"], "+/8=");
		next["requestId"] = first["requestId"].clone();
		next["request"]
			.as_object_mut()
			.unwrap()
			.remove("continuationToken");
		assert_eq!(first, next);
		let uuid =
			fresh_request_with(&codec, br#"{"requestId":"chat/old"}"#, "YQ==", 0, || Ok([0; 16]))
				.unwrap();
		assert_eq!(
			serde_json::from_slice::<Value>(&uuid).unwrap()["requestId"],
			"chat/00000000-0000-4000-8000-000000000000"
		);
		assert!(fresh_request_with(&codec, b"{}", "YQ==", 0, || Ok([0; 16])).is_err());
	}

	#[tokio::test]
	async fn sse_handles_multiline_crlf_eof_and_done() {
		let input = b":comment\r\nid: ignored\r\ndata: {\r\ndata: \"response\":{}\r\ndata: }\r\n\r\ndata: [DONE]\n\ndata: ignored\n\n";
		let mut reader = EventReader::new(&input[..]);
		assert_eq!(reader.next().await.unwrap().unwrap(), b"{\n\"response\":{}\n}");
		assert!(reader.next().await.unwrap().is_none());
		let mut reader = EventReader::new(&b"data: final without newline"[..]);
		assert_eq!(reader.next().await.unwrap().unwrap(), b"final without newline");
		assert!(reader.next().await.unwrap().is_none());
	}

	#[test]
	fn initial_modality_details_are_not_replaced_on_later_legs() {
		let mut state = ContinuationState::new(256);
		observed(&mut state, br#"{"response":{"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":20,"promptTokensDetails":[{"modality":"TEXT","tokenCount":100}]}}}"#);
		observed(&mut state, FIRST);
		state.finish_leg(false).unwrap();
		state.begin_leg();
		let event = observed(&mut state, br#"{"response":{"usageMetadata":{"promptTokenCount":999,"cachedContentTokenCount":999,"promptTokensDetails":[{"modality":"IMAGE","tokenCount":999}],"cacheTokensDetails":[{"tokenCount":999}]}}}"#);
		let usage = &event["response"]["usageMetadata"];
		assert_eq!(usage["promptTokenCount"], 100);
		assert_eq!(usage["cachedContentTokenCount"], 20);
		assert_eq!(usage["promptTokensDetails"][0]["modality"], "TEXT");
		assert!(usage.get("cacheTokensDetails").is_none());
	}

	#[test]
	fn exhausted_initial_budget_and_terminal_finishes_cannot_retry() {
		let mut state = ContinuationState::new(12);
		assert_eq!(
			observed(&mut state, FIRST)["response"]["candidates"][0]["finishReason"],
			"MAX_TOKENS"
		);
		assert_eq!(state.finish_leg(false).unwrap(), NextLeg::Complete);
		assert!(state.finish_leg(true).is_err());
		let mut state = ContinuationState::new(256);
		observed(
			&mut state,
			br#"{"response":{"candidates":[{"continuationToken":"YQ==","finishReason":1}]}}"#,
		);
		assert!(state.finish_leg(true).is_err());
	}

	#[tokio::test]
	async fn continuation_http_denial_reaches_the_sse_consumer() {
		let (sender, mut receiver) = mpsc::channel(1);
		let response = UpstreamResponse {
			status:  http::StatusCode::TOO_MANY_REQUESTS,
			headers: http::HeaderMap::new(),
			body:    Box::pin(io::Cursor::new(
				br#"{"error":{"code":429,"message":"quota exhausted","status":"RESOURCE_EXHAUSTED"}}"#
					.to_vec(),
			)),
		};
		write_http_error(&sender, response).await.unwrap();
		let bytes = receiver.recv().await.unwrap().unwrap();
		let mut events = EventReader::new(bytes.as_ref());
		let envelope: Value = serde_json::from_slice(events.next().await.unwrap().unwrap()).unwrap();
		assert_eq!(envelope["error"]["code"], 429);
		assert_eq!(envelope["error"]["status"], "RESOURCE_EXHAUSTED");
		assert_eq!(envelope["error"]["message"], "continuation HTTP status 429: quota exhausted");
	}

	#[tokio::test]
	async fn disconnected_consumers_are_not_silently_accepted() {
		let (sender, receiver) = mpsc::channel(1);
		drop(receiver);
		assert!(write_event(&sender, FIRST).await.is_err());
	}
}
