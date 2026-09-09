//! Reversible private-use glyph projection at the provider wire boundary.

use std::{collections::BTreeMap, mem, str, sync};

use bytes::Bytes;
use omp_core::{Str, sf};
use serde_json::{Map, Value};

use super::{
	Decoder, DecoderState, ProviderControlInput, RawEvent, ToolInputKind, UnvalidatedToolCall,
};
use crate::{
	call::{
		ContentPart, Message, OpaqueJson, OperationCall, Role, ToolDefinition, ToolResultContent,
	},
	error::Error,
	event::ChatEvent,
	transport::Frame,
};

const NOTICE: &str = "<glyph-tokens>\nSome content in this session contains icon characters \
                      (private-use Unicode, e.g. nerd font glyphs) that cannot be shown to you \
                      directly. Each such character appears as an opaque token like ⟦Ue0a0⟧ — one \
                      token is exactly one character. When copying, moving, or preserving \
                      surrounding text, copy each token byte-for-byte. Never invent tokens, alter \
                      their hex digits, or expand them into anything else. Writing a token in \
                      tool arguments writes the original character. To write the literal text \
                      ⟦Ue0a0⟧ rather than the character, escape it as ⟦E⟧Ue0a0⟧.\n</glyph-tokens>";
const OPEN: &str = "⟦";
const ESCAPE: &str = "⟦E⟧";

/// Returns whether a canonical operation contains provider-bound glyph text.
pub fn operation_active(operation: &OperationCall) -> bool {
	let OperationCall::Chat(request) = operation else {
		return false;
	};
	request.messages.iter().any(message_active)
		|| request
			.tools
			.iter()
			.any(|tool| tool.description.as_deref().is_some_and(text_needs_encoding))
}

/// Encodes one chat operation without mutating canonical history.
pub fn encode_operation(operation: &OperationCall) -> Option<OperationCall> {
	let OperationCall::Chat(request) = operation else {
		return None;
	};
	if !operation_active(operation) {
		return None;
	}
	let mut encoded = (**request).clone();
	let mut notice_added = false;
	let mut messages = request.messages.to_vec();
	for role_group in [true, false] {
		for message in &mut messages {
			if matches!(message.role, Role::System | Role::Developer) != role_group {
				continue;
			}
			encode_message(message, &mut notice_added);
		}
		if role_group {
			let mut tools = request.tools.to_vec();
			for tool in &mut tools {
				encode_tool(tool, &mut notice_added);
			}
			encoded.tools = tools.into();
		}
	}
	encoded.messages = messages.into();
	Some(OperationCall::Chat(sync::Arc::new(encoded)))
}

/// Wraps an ordinary decoder so provider-authored glyph tokens become canonical
/// text and tool arguments again.
pub fn wrap_decoder(inner: DecoderState) -> DecoderState {
	Box::new(GlyphDecoder { inner, text: BTreeMap::new() })
}

fn message_active(message: &Message) -> bool {
	message.content.iter().any(|part| match part {
		ContentPart::Text { text, .. } => text_needs_encoding(text),
		ContentPart::ToolCall { arguments, .. } => value_active(arguments.as_value()),
		ContentPart::ToolResult { content, .. } => content.iter().any(|item| match item {
			ToolResultContent::Text(text) => text_needs_encoding(text),
			ToolResultContent::Json(value) => value_active(value.as_value()),
			ToolResultContent::Image(_) | ToolResultContent::Document(_) => false,
		}),
		ContentPart::Reasoning { .. }
		| ContentPart::Image(_)
		| ContentPart::Audio(_)
		| ContentPart::Document(_)
		| ContentPart::CachePoint(_) => false,
	})
}

fn value_active(value: &Value) -> bool {
	match value {
		Value::String(text) => text_needs_encoding(text),
		Value::Array(items) => items.iter().any(value_active),
		Value::Object(fields) => fields
			.iter()
			.any(|(key, value)| text_needs_encoding(key) || value_active(value)),
		Value::Null | Value::Bool(_) | Value::Number(_) => false,
	}
}

fn encode_tool(tool: &mut ToolDefinition, notice_added: &mut bool) {
	let Some(description) = tool.description.as_ref() else {
		return;
	};
	if let Some(encoded) = encode_with_notice(description, notice_added) {
		tool.description = Some(encoded);
	}
}

fn encode_message(message: &mut Message, notice_added: &mut bool) {
	let mut content = message.content.to_vec();
	let mut changed = false;
	for part in &mut content {
		match part {
			ContentPart::Text { text, .. } => {
				if let Some(encoded) = encode_with_notice(text, notice_added) {
					*text = encoded;
					changed = true;
				}
			},
			ContentPart::ToolCall { arguments, .. } => {
				if let Some(encoded) = encode_value(arguments.as_value(), notice_added) {
					*arguments = OpaqueJson::new(encoded);
					changed = true;
				}
			},
			ContentPart::ToolResult { content: result, .. } => {
				let mut items = result.to_vec();
				let mut result_changed = false;
				for item in &mut items {
					match item {
						ToolResultContent::Text(text) => {
							if let Some(encoded) = encode_with_notice(text, notice_added) {
								*text = encoded;
								result_changed = true;
							}
						},
						ToolResultContent::Json(value) => {
							if let Some(encoded) = encode_value(value.as_value(), notice_added) {
								*value = OpaqueJson::new(encoded);
								result_changed = true;
							}
						},
						ToolResultContent::Image(_) | ToolResultContent::Document(_) => {},
					}
				}
				if result_changed {
					*result = items.into();
					changed = true;
				}
			},
			ContentPart::Reasoning { .. }
			| ContentPart::Image(_)
			| ContentPart::Audio(_)
			| ContentPart::Document(_)
			| ContentPart::CachePoint(_) => {},
		}
	}
	if changed {
		message.content = content.into();
	}
}

fn encode_value(value: &Value, notice_added: &mut bool) -> Option<Value> {
	match value {
		Value::String(text) => {
			encode_with_notice(text, notice_added).map(|text| Value::String(text.to_string()))
		},
		Value::Array(items) => {
			let mut output = items.clone();
			let mut changed = false;
			for (output, item) in output.iter_mut().zip(items) {
				if let Some(encoded) = encode_value(item, notice_added) {
					*output = encoded;
					changed = true;
				}
			}
			changed.then_some(Value::Array(output))
		},
		Value::Object(fields) => {
			let mut output = Map::new();
			let mut changed = false;
			for (key, value) in fields {
				let encoded_key = encode_with_notice(key, notice_added);
				let encoded_value = encode_value(value, notice_added);
				changed |= encoded_key.is_some() || encoded_value.is_some();
				output.insert(
					encoded_key.map_or_else(|| key.clone(), |key| key.to_string()),
					encoded_value.unwrap_or_else(|| value.clone()),
				);
			}
			changed.then_some(Value::Object(output))
		},
		Value::Null | Value::Bool(_) | Value::Number(_) => None,
	}
}

fn encode_with_notice(text: &str, notice_added: &mut bool) -> Option<Str> {
	let encoded = encode_text(text)?;
	if *notice_added {
		return Some(encoded);
	}
	*notice_added = true;
	Some(sf!("{encoded}\n\n{NOTICE}"))
}

fn text_needs_encoding(text: &str) -> bool {
	text.char_indices().any(|(index, character)| {
		is_private_use(character) || character == '⟦' && literal_token(&text[index..]).is_some()
	})
}

const fn is_private_use(character: char) -> bool {
	matches!(character as u32, 0xe000..=0xf8ff | 0xf0000..=0xffffd | 0x100000..=0x10fffd)
}

fn literal_token(text: &str) -> Option<usize> {
	let rest = text.strip_prefix(OPEN)?;
	if rest.starts_with("E⟧") {
		return Some(OPEN.len() + "E⟧".len());
	}
	let hex = rest.strip_prefix('U')?;
	let digits = hex
		.bytes()
		.take_while(|byte| byte.is_ascii_hexdigit())
		.count();
	(4..=6)
		.contains(&digits)
		.then(|| hex.get(digits..))
		.flatten()
		.and_then(|tail| {
			tail
				.starts_with('⟧')
				.then_some(OPEN.len() + 1 + digits + '⟧'.len_utf8())
		})
}

fn encode_text(text: &str) -> Option<Str> {
	if !text_needs_encoding(text) {
		return None;
	}
	let mut output = String::with_capacity(text.len());
	let mut copied = 0;
	for (index, character) in text.char_indices() {
		if is_private_use(character) {
			output.push_str(&text[copied..index]);
			output.push_str("⟦U");
			use std::fmt::Write as _;
			write!(output, "{:x}", character as u32).expect("writing to String cannot fail");
			output.push('⟧');
			copied = index + character.len_utf8();
		} else if character == '⟦' && literal_token(&text[index..]).is_some() {
			output.push_str(&text[copied..index]);
			output.push_str(ESCAPE);
			copied = index + character.len_utf8();
		}
	}
	output.push_str(&text[copied..]);
	Some(Str::new(output))
}

fn decode_text(text: &str) -> Str {
	let Some(first) = text.find(OPEN) else {
		return Str::new(text);
	};
	let mut output = String::with_capacity(text.len());
	output.push_str(&text[..first]);
	let mut cursor = first;
	while cursor < text.len() {
		let Some(relative) = text[cursor..].find(OPEN) else {
			output.push_str(&text[cursor..]);
			break;
		};
		let start = cursor + relative;
		output.push_str(&text[cursor..start]);
		let tail = &text[start..];
		if tail.starts_with(ESCAPE) {
			output.push('⟦');
			cursor = start + ESCAPE.len();
			continue;
		}
		if let Some(length) = literal_token(tail) {
			let token = &tail[..length];
			if let Some(hex) = token
				.strip_prefix("⟦U")
				.and_then(|value| value.strip_suffix('⟧'))
				&& let Ok(codepoint) = u32::from_str_radix(hex, 16)
				&& let Some(character) = char::from_u32(codepoint)
			{
				output.push(character);
				cursor = start + length;
				continue;
			}
		}
		output.push('⟦');
		cursor = start + '⟦'.len_utf8();
	}
	Str::new(output)
}

fn decode_value(value: &mut Value) {
	match value {
		Value::String(text) => *text = decode_text(text).to_string(),
		Value::Array(items) => items.iter_mut().for_each(decode_value),
		Value::Object(fields) => {
			let old = mem::take(fields);
			for (key, mut value) in old {
				decode_value(&mut value);
				fields.insert(decode_text(&key).to_string(), value);
			}
		},
		Value::Null | Value::Bool(_) | Value::Number(_) => {},
	}
}

#[derive(Debug, Default)]
struct StreamingTextDecoder {
	held: String,
}

impl StreamingTextDecoder {
	fn push(&mut self, text: &str) -> Option<Str> {
		self.held.push_str(text);
		let split = held_suffix_start(&self.held).unwrap_or(self.held.len());
		if split == 0 {
			return None;
		}
		let suffix = self.held.split_off(split);
		let visible = mem::replace(&mut self.held, suffix);
		Some(decode_text(&visible))
	}

	fn finish(&mut self) -> Option<Str> {
		(!self.held.is_empty()).then(|| decode_text(&mem::take(&mut self.held)))
	}
}

fn held_suffix_start(text: &str) -> Option<usize> {
	let start = text.rfind(OPEN)?;
	let tail = &text[start..];
	if tail == OPEN
		|| tail.strip_prefix(OPEN).is_some_and(|rest| {
			rest == "E"
				|| rest == "U"
				|| rest.strip_prefix('U').is_some_and(|hex| {
					hex.len() <= 6 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
				})
		}) {
		Some(start)
	} else {
		None
	}
}

struct GlyphDecoder {
	inner: DecoderState,
	text:  BTreeMap<u32, StreamingTextDecoder>,
}

impl GlyphDecoder {
	fn emit(&mut self, event: RawEvent, emit: &mut dyn FnMut(RawEvent)) {
		match event {
			RawEvent::Chat(ChatEvent::TextDelta { index, text }) => {
				if let Some(text) = self.text.entry(index).or_default().push(&text)
					&& !text.is_empty()
				{
					emit(RawEvent::Chat(ChatEvent::TextDelta { index, text }));
				}
			},
			RawEvent::Chat(ChatEvent::ToolCallReady { index, mut call }) => {
				let mut arguments = call.arguments.as_value().clone();
				decode_value(&mut arguments);
				call.arguments = OpaqueJson::new(arguments);
				emit(RawEvent::Chat(ChatEvent::ToolCallReady { index, call }));
			},
			RawEvent::ToolCallComplete { index, mut call } => {
				decode_unvalidated_call(&mut call);
				emit(RawEvent::ToolCallComplete { index, call });
			},
			RawEvent::Completion(completion) => {
				self.flush_text(emit);
				emit(RawEvent::Completion(completion));
			},
			RawEvent::Failure(error) => {
				self.flush_text(emit);
				emit(RawEvent::Failure(error));
			},
			other => emit(other),
		}
	}

	fn flush_text(&mut self, emit: &mut dyn FnMut(RawEvent)) {
		for (index, decoder) in &mut self.text {
			if let Some(text) = decoder.finish()
				&& !text.is_empty()
			{
				emit(RawEvent::Chat(ChatEvent::TextDelta { index: *index, text }));
			}
		}
		self.text.clear();
	}
}

fn decode_unvalidated_call(call: &mut UnvalidatedToolCall) {
	// Freeform inputs are opaque text; JSON sniffing could reserialize and
	// silently reformat grammar-constrained payloads that happen to parse.
	if call.input_kind == ToolInputKind::Freeform {
		if let Ok(text) = str::from_utf8(&call.arguments) {
			call.arguments = Bytes::copy_from_slice(decode_text(text).as_bytes());
		}
		return;
	}
	if let Ok(mut value) = serde_json::from_slice::<Value>(&call.arguments) {
		decode_value(&mut value);
		if let Ok(arguments) = serde_json::to_vec(&value) {
			call.arguments = Bytes::from(arguments);
		}
	} else if let Ok(text) = str::from_utf8(&call.arguments) {
		call.arguments = Bytes::copy_from_slice(decode_text(text).as_bytes());
	}
}

impl Decoder for GlyphDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let mut events = Vec::new();
		self.inner.push(frame, &mut |event| events.push(event))?;
		for event in events {
			self.emit(event, emit);
		}
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let mut events = Vec::new();
		self.inner.finish(&mut |event| events.push(event))?;
		for event in events {
			self.emit(event, emit);
		}
		self.flush_text(emit);
		Ok(())
	}

	fn is_complete(&self) -> bool {
		self.inner.is_complete()
	}

	fn prepare_browser_retry(&mut self) -> bool {
		self.inner.prepare_browser_retry()
	}

	fn supports_control(&self) -> bool {
		self.inner.supports_control()
	}

	fn encode_control(&mut self, input: ProviderControlInput) -> Result<Option<Bytes>, Error> {
		self.inner.encode_control(input)
	}
}

#[cfg(test)]
mod tests {
	use super::{super::ToolInputKind as SuperToolInputKind, *};
	use crate::{
		call::{ChatRequest, NegotiationPolicy, Sampling, Setting},
		id::ToolCallId as IdToolCallId,
	};

	#[test]
	fn glyph_text_round_trips_private_use_planes_and_literal_tokens() {
		let source = "icons: \u{e0a0} \u{f0001} \u{100001}; literal ⟦Ue0a0⟧ and ⟦E⟧";
		let encoded = encode_text(source).expect("glyphs require encoding");
		assert_eq!(encoded, "icons: ⟦Ue0a0⟧ ⟦Uf0001⟧ ⟦U100001⟧; literal ⟦E⟧Ue0a0⟧ and ⟦E⟧E⟧");
		assert_eq!(decode_text(&encoded), source);
	}

	#[test]
	fn operation_encoding_is_non_mutating_and_adds_one_notice() {
		let request = ChatRequest {
			messages:          vec![Message {
				role:    Role::User,
				content: vec![ContentPart::Text { text: sf!("open \u{e0a0}"), proof: None }].into(),
				name:    None,
			}]
			.into(),
			tools:             vec![ToolDefinition {
				name:        sf!("read"),
				description: Some(sf!("read \u{e0a1}")),
				input:       crate::call::ToolInputConstraint::JsonSchema {
					parameters: OpaqueJson::new(serde_json::json!({"type":"object"})),
					strict:     false,
				},
			}]
			.into(),
			hosted_tools:      sync::Arc::from([]),
			tool_choice:       Setting::Unset,
			output:            Setting::Unset,
			reasoning:         Setting::Unset,
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          Sampling::default(),
			max_output_tokens: None,
			top_logprobs:      None,
			safety:            sync::Arc::from([]),
			negotiation:       NegotiationPolicy::default(),
			forced_call:       None,
		};
		let operation = OperationCall::Chat(sync::Arc::new(request));
		let OperationCall::Chat(encoded) = encode_operation(&operation).expect("active codec") else {
			unreachable!()
		};
		assert!(
			encoded.tools[0]
				.description
				.as_deref()
				.unwrap()
				.contains(NOTICE)
		);
		assert!(!encoded.messages[0].content.iter().any(|part| matches!(
			part,
			ContentPart::Text { text, .. } if text.contains(NOTICE)
		)));
		let OperationCall::Chat(original) = operation else {
			unreachable!()
		};
		assert_eq!(original.tools[0].description.as_deref(), Some("read \u{e0a1}"));
	}

	#[test]
	fn streaming_decoder_reassembles_split_tokens() {
		let mut decoder = StreamingTextDecoder::default();
		assert_eq!(decoder.push("a⟦Ue0"), Some(sf!("a")));
		assert_eq!(decoder.push("a0⟧b⟦E"), Some(sf!("\u{e0a0}b")));
		assert_eq!(decoder.push("⟧c"), Some(sf!("⟦c")));
		assert_eq!(decoder.finish(), None);
	}

	#[test]
	fn tool_argument_values_and_keys_decode_recursively() {
		let mut call = UnvalidatedToolCall {
			id:         IdToolCallId::new("call"),
			name:       sf!("write"),
			input_kind: SuperToolInputKind::Json,
			arguments:  Bytes::from_static(r#"{"⟦Ue0a0⟧":"path/⟦Ue0a1⟧"}"#.as_bytes()),
		};
		decode_unvalidated_call(&mut call);
		assert_eq!(
			serde_json::from_slice::<Value>(&call.arguments).unwrap(),
			serde_json::json!({"\u{e0a0}": "path/\u{e0a1}"})
		);
	}
}
