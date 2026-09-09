//! Bounded serialization of `GenAI` message content.
//!
//! Summary capture deliberately follows the JavaScript implementation's limits.
//! In particular, text length is measured in UTF-16 code units (`String.length`
//! in JavaScript), not UTF-8 bytes. Truncation keeps a valid Rust UTF-8 prefix;
//! a boundary that bisects a surrogate pair is therefore rounded down.
//!
//! Credential masking is mandatory and cannot be disabled by capture policy.
//! It is applied to each summarized string before its UTF-16 length bound, and
//! again at final JSON serialization to cover full capture.

use std::{iter, slice};

use opentelemetry::KeyValue;
use serde_json::{Map, Value, json};

use crate::{
	attrs::{gen_ai, omp_gen_ai},
	redact::redact_sensitive_credentials,
	semconv::CaptureMode,
};

/// Maximum number of regular elements retained from a summarized array.
pub const MAX_TELEMETRY_ARRAY_ITEMS: usize = 64;
/// Maximum number of regular messages retained from a request summary.
pub const MAX_TELEMETRY_MESSAGE_COUNT: usize = 16;
/// Maximum recursive depth retained for summarized arrays and objects.
pub const MAX_TELEMETRY_OBJECT_DEPTH: usize = 3;
/// Maximum number of keys retained from a summarized object.
pub const MAX_TELEMETRY_OBJECT_KEYS: usize = 12;
/// Maximum number of UTF-16 code units retained from summarized text.
pub const MAX_TELEMETRY_TEXT_CHARS: usize = 240;

/// Request content consumed by the content-capture serializers.
#[derive(Clone, Copy, Debug, Default)]
pub struct RequestContent<'a> {
	/// System prompt, represented as either a string or an array of strings.
	pub system_prompt: Option<&'a Value>,
	/// Conversation messages in the canonical inference JSON shape.
	pub messages:      &'a [Value],
}

/// Assistant response content consumed by the content-capture serializers.
#[derive(Clone, Copy, Debug, Default)]
pub struct ResponseContent<'a> {
	/// Assistant content parts in the canonical inference JSON shape.
	pub parts:       &'a [Value],
	/// Provider stop reason.
	pub stop_reason: Option<&'a str>,
}

/// Build request-side content attributes for `mode`.
///
/// `None` emits nothing. `Summary` emits only `omp.gen_ai.request.messages`.
/// `Full` additionally emits standard system-instruction and input-message
/// attributes, while retaining the summary attribute.
pub fn request_attributes(mode: CaptureMode, request: RequestContent<'_>) -> Vec<KeyValue> {
	if mode == CaptureMode::None {
		return Vec::new();
	}
	let mut attributes = Vec::with_capacity(if mode == CaptureMode::Full { 3 } else { 1 });
	if let Some(summary) = serialize_request_summary(request) {
		attributes.push(KeyValue::new(omp_gen_ai::REQUEST_MESSAGES, summary));
	}
	if mode == CaptureMode::Full {
		if let Some(instructions) = serialize_full_system_instructions(request.system_prompt) {
			attributes.push(KeyValue::new(gen_ai::SYSTEM_INSTRUCTIONS, instructions));
		}
		if !request.messages.is_empty() {
			let messages = request
				.messages
				.iter()
				.map(message_to_otel_input)
				.collect::<Vec<_>>();
			attributes
				.push(KeyValue::new(gen_ai::INPUT_MESSAGES, json_string(&Value::Array(messages))));
		}
	}
	attributes
}

/// Build response-side content attributes for `mode`.
///
/// Both enabled modes emit bounded text and tool-call summaries when present;
/// `Full` additionally emits `gen_ai.output.messages`.
pub fn response_attributes(mode: CaptureMode, response: ResponseContent<'_>) -> Vec<KeyValue> {
	if mode == CaptureMode::None {
		return Vec::new();
	}
	let mut attributes = Vec::with_capacity(if mode == CaptureMode::Full { 3 } else { 2 });
	let texts = response
		.parts
		.iter()
		.filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
		.filter_map(|part| part.get("text").and_then(Value::as_str));
	if texts.clone().next().is_some() {
		attributes.push(KeyValue::new(
			omp_gen_ai::RESPONSE_TEXT,
			json_string(&Value::Array(summarize_texts(texts))),
		));
	}
	let calls = response
		.parts
		.iter()
		.filter(|part| part.get("type").and_then(Value::as_str) == Some("toolCall"))
		.map(|part| {
			json!({
				"toolCallId": part.get("id").cloned().unwrap_or(Value::Null),
				"toolName": part.get("name").cloned().unwrap_or(Value::Null),
				"input": summarize_value(part.get("arguments").unwrap_or(&Value::Null), 0),
			})
		})
		.collect::<Vec<_>>();
	if !calls.is_empty() {
		attributes.push(KeyValue::new(
			omp_gen_ai::RESPONSE_TOOL_CALLS,
			json_string(&Value::Array(limit_tool_calls(calls))),
		));
	}
	if mode == CaptureMode::Full {
		let output = json!([{
			"role": "assistant",
			"parts": assistant_parts_to_otel(response.parts),
			"finish_reason": map_stop_reason(response.stop_reason).unwrap_or_else(|| response.stop_reason.unwrap_or("stop")),
		}]);
		attributes.push(KeyValue::new(gen_ai::OUTPUT_MESSAGES, json_string(&output)));
	}
	attributes
}

/// Serialize tool-call arguments for an enabled capture mode.
///
/// Summary mode applies the bounded serializer; full mode serializes the value
/// without summarization, preserving the enabled capture mode.
pub fn tool_arguments_attribute(mode: CaptureMode, arguments: &Value) -> Option<KeyValue> {
	serialize_tool_value(mode, gen_ai::TOOL_CALL_ARGUMENTS, arguments)
}

/// Serialize a tool-call result for an enabled capture mode.
pub fn tool_result_attribute(mode: CaptureMode, result: &Value) -> Option<KeyValue> {
	serialize_tool_value(mode, gen_ai::TOOL_CALL_RESULT, result)
}

fn serialize_tool_value(mode: CaptureMode, key: &'static str, value: &Value) -> Option<KeyValue> {
	match mode {
		CaptureMode::None => None,
		CaptureMode::Summary => Some(KeyValue::new(key, json_string(&summarize_value(value, 0)))),
		CaptureMode::Full => Some(KeyValue::new(key, json_string(value))),
	}
}

fn serialize_request_summary(request: RequestContent<'_>) -> Option<String> {
	let mut messages = Vec::new();
	for text in system_prompt_parts(request.system_prompt) {
		messages.push(json!({ "role": "system", "content": summarize_text(text) }));
	}
	for message in request.messages {
		let role = message.get("role").cloned().unwrap_or(Value::Null);
		let content = summarize_value(message.get("content").unwrap_or(&Value::Null), 0);
		messages.push(json!({ "role": role, "content": content }));
	}
	if messages.is_empty() {
		None
	} else {
		Some(json_string(&Value::Array(limit_messages(messages))))
	}
}

fn serialize_full_system_instructions(system_prompt: Option<&Value>) -> Option<String> {
	let parts = system_prompt_parts(system_prompt);
	parts.clone().next()?;
	let instructions = parts
		.into_iter()
		.map(|text| json!({ "type": "text", "content": text }))
		.collect::<Vec<_>>();
	Some(json_string(&Value::Array(instructions)))
}

fn system_prompt_parts(
	system_prompt: Option<&Value>,
) -> impl Clone + DoubleEndedIterator<Item = &str> + iter::FusedIterator + '_ {
	let parts = match system_prompt {
		Some(value @ Value::String(text)) if !text.is_empty() => slice::from_ref(value),
		Some(Value::Array(parts)) => parts.as_slice(),
		_ => &[],
	};
	parts.iter().filter_map(Value::as_str)
}

fn limit_messages(mut messages: Vec<Value>) -> Vec<Value> {
	if messages.len() <= MAX_TELEMETRY_MESSAGE_COUNT {
		return messages;
	}
	let omitted = messages.len() - MAX_TELEMETRY_MESSAGE_COUNT;
	messages.truncate(MAX_TELEMETRY_MESSAGE_COUNT);
	messages.push(json!({
		"role": "system",
		"content": { "kind": "truncated", "omittedMessages": omitted },
	}));
	messages
}

fn limit_tool_calls(mut calls: Vec<Value>) -> Vec<Value> {
	if calls.len() <= MAX_TELEMETRY_ARRAY_ITEMS {
		return calls;
	}
	let omitted = calls.len() - MAX_TELEMETRY_ARRAY_ITEMS;
	calls.truncate(MAX_TELEMETRY_ARRAY_ITEMS);
	calls.push(json!({
		"toolCallId": "[truncated]",
		"toolName": "[truncated]",
		"input": { "kind": "truncated", "omittedToolCalls": omitted },
	}));
	calls
}

fn summarize_texts<'a>(texts: impl Iterator<Item = &'a str> + Clone) -> Vec<Value> {
	let text_count = texts.clone().count();
	let mut summarized = texts
		.take(MAX_TELEMETRY_ARRAY_ITEMS)
		.map(|text| Value::String(summarize_text(text)))
		.collect::<Vec<_>>();
	if text_count > MAX_TELEMETRY_ARRAY_ITEMS {
		summarized.push(Value::String(format!(
			"[{} additional text entries omitted]",
			text_count - MAX_TELEMETRY_ARRAY_ITEMS
		)));
	}
	summarized
}

fn summarize_text(text: &str) -> String {
	// Scrub before applying the bound: truncating first can split a credential
	// so that the sensitive-token grammar no longer recognizes it.
	let text = redact_sensitive_credentials(text);
	let utf16_len = text.encode_utf16().count();
	if utf16_len <= MAX_TELEMETRY_TEXT_CHARS {
		return text;
	}
	let byte_end = text
		.char_indices()
		.scan(0usize, |units, (index, character)| {
			let next = *units + character.len_utf16();
			if next > MAX_TELEMETRY_TEXT_CHARS {
				None
			} else {
				*units = next;
				Some(index + character.len_utf8())
			}
		})
		.last()
		.unwrap_or(0);
	format!("{} [{} chars omitted]", &text[..byte_end], utf16_len - MAX_TELEMETRY_TEXT_CHARS)
}

fn summarize_value(value: &Value, depth: usize) -> Value {
	match value {
		Value::String(text) => Value::String(summarize_text(text)),
		Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
		Value::Array(items) => {
			if depth >= MAX_TELEMETRY_OBJECT_DEPTH {
				return json!({ "kind": "array", "length": items.len() });
			}
			let mut summary = items
				.iter()
				.take(MAX_TELEMETRY_ARRAY_ITEMS)
				.map(|item| summarize_value(item, depth + 1))
				.collect::<Vec<_>>();
			if items.len() > MAX_TELEMETRY_ARRAY_ITEMS {
				summary.push(json!({
					"kind": "truncated",
					"omittedItems": items.len() - MAX_TELEMETRY_ARRAY_ITEMS,
				}));
			}
			Value::Array(summary)
		},
		Value::Object(object) => summarize_object(object, depth),
	}
}

fn summarize_object(object: &Map<String, Value>, depth: usize) -> Value {
	if depth >= MAX_TELEMETRY_OBJECT_DEPTH {
		let keys = object
			.keys()
			.take(MAX_TELEMETRY_OBJECT_KEYS)
			.cloned()
			.map(Value::String)
			.collect::<Vec<_>>();
		let mut summary = Map::new();
		summary.insert("kind".into(), Value::String("object".into()));
		summary.insert("keys".into(), Value::Array(keys));
		if object.len() > MAX_TELEMETRY_OBJECT_KEYS {
			summary.insert(
				"telemetrySummary".into(),
				json!({ "omittedKeys": object.len() - MAX_TELEMETRY_OBJECT_KEYS }),
			);
		}
		return Value::Object(summary);
	}
	let mut summary = Map::new();
	for (key, value) in object.iter().take(MAX_TELEMETRY_OBJECT_KEYS) {
		summary.insert(key.clone(), summarize_value(value, depth + 1));
	}
	if object.len() > MAX_TELEMETRY_OBJECT_KEYS {
		summary.insert(
			"telemetrySummary".into(),
			json!({ "omittedKeys": object.len() - MAX_TELEMETRY_OBJECT_KEYS }),
		);
	}
	Value::Object(summary)
}

fn message_to_otel_input(message: &Value) -> Value {
	let role = message
		.get("role")
		.and_then(Value::as_str)
		.unwrap_or_default();
	if role == "assistant" {
		return json!({ "role": "assistant", "parts": assistant_parts_to_otel(value_array(message.get("content"))) });
	}
	if role == "toolResult" {
		return json!({
			"role": "tool",
			"name": message.get("toolName").cloned().unwrap_or(Value::Null),
			"parts": [{
				"type": "tool_call_response",
				"id": message.get("toolCallId").cloned().unwrap_or(Value::Null),
				"response": {
					"content": text_or_image_to_otel(message.get("content")),
					"details": message.get("details").cloned().unwrap_or(Value::Null),
					"is_error": message.get("isError").cloned().unwrap_or(Value::Null),
				},
			}],
		});
	}
	json!({
		"role": message.get("role").cloned().unwrap_or(Value::Null),
		"parts": text_or_image_to_otel(message.get("content")),
	})
}

fn value_array(value: Option<&Value>) -> &[Value] {
	value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn text_or_image_to_otel(content: Option<&Value>) -> Vec<Value> {
	if let Some(Value::String(text)) = content {
		return vec![json!({ "type": "text", "content": text })];
	}
	assistant_parts_to_otel(value_array(content))
}

fn assistant_parts_to_otel(parts: &[Value]) -> Vec<Value> {
	parts.iter().filter_map(part_to_otel).collect()
}

fn part_to_otel(part: &Value) -> Option<Value> {
	match part.get("type").and_then(Value::as_str)? {
		"text" => Some(
			json!({ "type": "text", "content": part.get("text").cloned().unwrap_or(Value::Null) }),
		),
		"image" => Some(json!({
			"type": "blob",
			"modality": "image",
			"mime_type": part.get("mimeType").cloned().unwrap_or(Value::Null),
			"content": part.get("data").cloned().unwrap_or(Value::Null),
		})),
		"thinking" => Some(
			json!({ "type": "reasoning", "content": part.get("thinking").cloned().unwrap_or(Value::Null) }),
		),
		"redactedThinking" => Some(
			json!({ "type": "reasoning", "content": part.get("data").cloned().unwrap_or(Value::Null) }),
		),
		"toolCall" => Some(json!({
			"type": "tool_call",
			"id": part.get("id").cloned().unwrap_or(Value::Null),
			"name": part.get("name").cloned().unwrap_or(Value::Null),
			"arguments": part.get("arguments").cloned().unwrap_or(Value::Null),
		})),
		_ => None,
	}
}

fn map_stop_reason(reason: Option<&str>) -> Option<&'static str> {
	match reason? {
		"stop" => Some("stop"),
		"length" => Some("length"),
		"toolUse" => Some("tool_calls"),
		"error" | "aborted" => Some("error"),
		_ => None,
	}
}

fn json_string(value: &Value) -> String {
	let serialized =
		serde_json::to_string(value).expect("serializing a serde_json::Value cannot fail");
	// This final boundary also covers full capture, which intentionally bypasses
	// the bounded summary serializer.
	redact_sensitive_credentials(&serialized)
}

#[cfg(test)]
mod tests {

	use std::{env, process};

	use opentelemetry::Value as AttributeValue;
	use serde_json::{Value, json};

	use super::*;

	fn attribute_json(attributes: &[KeyValue], key: &str) -> Value {
		let value = attributes
			.iter()
			.find(|attribute| attribute.key.as_str() == key)
			.unwrap();
		let AttributeValue::String(value) = &value.value else {
			panic!("expected string attribute")
		};
		serde_json::from_str(value.as_str()).unwrap()
	}

	#[test]
	fn text_cap_boundary() {
		let at_limit = "a".repeat(MAX_TELEMETRY_TEXT_CHARS);
		assert_eq!(summarize_text(&at_limit), at_limit);
		let over_limit = "a".repeat(MAX_TELEMETRY_TEXT_CHARS + 1);
		assert_eq!(
			summarize_text(&over_limit),
			format!("{} [1 chars omitted]", &over_limit[..MAX_TELEMETRY_TEXT_CHARS])
		);
	}

	#[test]
	fn array_cap_boundary() {
		let at_limit = Value::Array(
			(0..MAX_TELEMETRY_ARRAY_ITEMS)
				.map(|value| json!(value))
				.collect(),
		);
		assert_eq!(summarize_value(&at_limit, 0), at_limit);
		let over_limit = Value::Array(
			(0..=MAX_TELEMETRY_ARRAY_ITEMS)
				.map(|value| json!(value))
				.collect(),
		);
		let Value::Array(summary) = summarize_value(&over_limit, 0) else {
			panic!("expected array")
		};
		assert_eq!(summary.len(), MAX_TELEMETRY_ARRAY_ITEMS + 1);
		assert_eq!(summary.last(), Some(&json!({ "kind": "truncated", "omittedItems": 1 })));
	}

	#[test]
	fn message_cap_boundary() {
		let at_limit = (0..MAX_TELEMETRY_MESSAGE_COUNT)
			.map(|_| json!({ "role": "user", "content": "x" }))
			.collect::<Vec<_>>();
		assert_eq!(limit_messages(at_limit.clone()), at_limit);
		let mut over_limit = at_limit;
		over_limit.push(json!({ "role": "user", "content": "y" }));
		let summary = limit_messages(over_limit);
		assert_eq!(summary.len(), MAX_TELEMETRY_MESSAGE_COUNT + 1);
		assert_eq!(
			summary.last(),
			Some(
				&json!({ "role": "system", "content": { "kind": "truncated", "omittedMessages": 1 } })
			)
		);
	}

	#[test]
	fn object_depth_cap_boundary() {
		let at_limit = json!({ "a": { "b": { "c": "kept" } } });
		assert_eq!(summarize_value(&at_limit, 0), at_limit);
		let over_limit = json!({ "a": { "b": { "c": { "d": "hidden" } } } });
		assert_eq!(
			summarize_value(&over_limit, 0)["a"]["b"]["c"],
			json!({ "kind": "object", "keys": ["d"] })
		);
	}

	#[test]
	fn object_key_cap_boundary() {
		let at_limit = Value::Object(
			(0..MAX_TELEMETRY_OBJECT_KEYS)
				.map(|index| (format!("k{index:02}"), json!(index)))
				.collect(),
		);
		assert_eq!(summarize_value(&at_limit, 0), at_limit);
		let over_limit = Value::Object(
			(0..=MAX_TELEMETRY_OBJECT_KEYS)
				.map(|index| (format!("k{index:02}"), json!(index)))
				.collect(),
		);
		let summary = summarize_value(&over_limit, 0);
		assert_eq!(summary.as_object().unwrap().len(), MAX_TELEMETRY_OBJECT_KEYS + 1);
		assert_eq!(summary["telemetrySummary"], json!({ "omittedKeys": 1 }));
	}

	#[test]
	fn capture_modes_emit_exact_key_sets() {
		let system = json!("system");
		let messages = [json!({ "role": "user", "content": "hello" })];
		let request = RequestContent { system_prompt: Some(&system), messages: &messages };
		assert!(request_attributes(CaptureMode::None, request).is_empty());
		let summary = request_attributes(CaptureMode::Summary, request);
		assert_eq!(
			summary
				.iter()
				.map(|attribute| attribute.key.as_str())
				.collect::<Vec<_>>(),
			[omp_gen_ai::REQUEST_MESSAGES]
		);
		let full = request_attributes(CaptureMode::Full, request);
		assert_eq!(
			full
				.iter()
				.map(|attribute| attribute.key.as_str())
				.collect::<Vec<_>>(),
			[omp_gen_ai::REQUEST_MESSAGES, gen_ai::SYSTEM_INSTRUCTIONS, gen_ai::INPUT_MESSAGES]
		);

		let parts = [
			json!({ "type": "text", "text": "answer" }),
			json!({ "type": "toolCall", "id": "1", "name": "read", "arguments": {} }),
		];
		let response = ResponseContent { parts: &parts, stop_reason: Some("toolUse") };
		assert!(response_attributes(CaptureMode::None, response).is_empty());
		let summary = response_attributes(CaptureMode::Summary, response);
		assert_eq!(
			summary
				.iter()
				.map(|attribute| attribute.key.as_str())
				.collect::<Vec<_>>(),
			[omp_gen_ai::RESPONSE_TEXT, omp_gen_ai::RESPONSE_TOOL_CALLS]
		);
		let full = response_attributes(CaptureMode::Full, response);
		assert_eq!(
			full
				.iter()
				.map(|attribute| attribute.key.as_str())
				.collect::<Vec<_>>(),
			[omp_gen_ai::RESPONSE_TEXT, omp_gen_ai::RESPONSE_TOOL_CALLS, gen_ai::OUTPUT_MESSAGES]
		);
		assert_eq!(attribute_json(&full, gen_ai::OUTPUT_MESSAGES)[0]["finish_reason"], "tool_calls");

		let tool_value = json!({ "nested": ["value"] });
		assert!(tool_arguments_attribute(CaptureMode::None, &tool_value).is_none());
		assert_eq!(
			tool_arguments_attribute(CaptureMode::Summary, &tool_value)
				.unwrap()
				.key
				.as_str(),
			gen_ai::TOOL_CALL_ARGUMENTS,
		);
		assert_eq!(
			tool_arguments_attribute(CaptureMode::Full, &tool_value)
				.unwrap()
				.key
				.as_str(),
			gen_ai::TOOL_CALL_ARGUMENTS,
		);
		assert!(tool_result_attribute(CaptureMode::None, &tool_value).is_none());
		assert_eq!(
			tool_result_attribute(CaptureMode::Summary, &tool_value)
				.unwrap()
				.key
				.as_str(),
			gen_ai::TOOL_CALL_RESULT,
		);
		assert_eq!(
			tool_result_attribute(CaptureMode::Full, &tool_value)
				.unwrap()
				.key
				.as_str(),
			gen_ai::TOOL_CALL_RESULT,
		);
	}

	fn run_redaction_test_isolated(test_name: &str) -> bool {
		const CHILD_ENV: &str = "OMP_TELEMETRY_REDACTION_TEST_CHILD";
		if env::var_os(CHILD_ENV).is_some() {
			return false;
		}
		let status = process::Command::new(env::current_exe().unwrap())
			.args(["--exact", test_name])
			.env(CHILD_ENV, "1")
			.status()
			.unwrap();
		assert!(status.success(), "isolated redaction test failed");
		true
	}

	fn tool_attribute_json(value: &Value) -> Value {
		let attribute = tool_arguments_attribute(CaptureMode::Summary, value).unwrap();
		let AttributeValue::String(value) = attribute.value else {
			panic!("expected string attribute")
		};
		serde_json::from_str(value.as_str()).unwrap()
	}

	#[test]
	fn captured_messages_and_tool_arguments_scrub_every_token_family() {
		if run_redaction_test_isolated(
			"content::tests::captured_messages_and_tool_arguments_scrub_every_token_family",
		) {
			return;
		}
		for token in [
			format!("gho_{}", "A".repeat(36)),
			format!("ghp_{}", "A".repeat(36)),
			format!("ghu_{}", "A".repeat(36)),
			format!("ghs_{}", "A".repeat(36)),
			format!("ghr_{}", "A".repeat(36)),
			format!("github_pat_{}", "A".repeat(36)),
			format!("glpat-{}", "A".repeat(20)),
			format!("sk-proj-{}", "A".repeat(36)),
			format!("sk-ant-{}", "A".repeat(36)),
			format!("sk-{}", "A".repeat(48)),
		] {
			let messages = [json!({ "role": "user", "content": format!("before {token} after") })];
			let captured = request_attributes(CaptureMode::Summary, RequestContent {
				system_prompt: None,
				messages:      &messages,
			});
			assert_eq!(
				attribute_json(&captured, omp_gen_ai::REQUEST_MESSAGES)[0]["content"],
				"before [REDACTED] after",
				"{token}"
			);
			assert_eq!(
				tool_attribute_json(&json!({ "credential": format!("before {token} after") }))
					["credential"],
				"before [REDACTED] after",
				"{token}"
			);
		}
	}

	#[test]
	fn redaction_precedes_text_truncation() {
		if run_redaction_test_isolated("content::tests::redaction_precedes_text_truncation") {
			return;
		}
		let prefix = "x".repeat(MAX_TELEMETRY_TEXT_CHARS - 11);
		let token = format!("sk-{}", "A".repeat(48));
		let messages = [json!({ "role": "user", "content": format!("{prefix} {token}") })];
		let captured = request_attributes(CaptureMode::Summary, RequestContent {
			system_prompt: None,
			messages:      &messages,
		});
		assert_eq!(
			attribute_json(&captured, omp_gen_ai::REQUEST_MESSAGES)[0]["content"],
			format!("{prefix} [REDACTED]")
		);
	}

	#[test]
	fn token_resemblances_remain_in_captured_content() {
		if run_redaction_test_isolated(
			"content::tests::token_resemblances_remain_in_captured_content",
		) {
			return;
		}
		let short = format!("sk-proj-{}", "A".repeat(35));
		let adjacent = format!("xghp_{}", "A".repeat(36));
		let messages = [json!({
			"role": "user",
			"content": format!("{short} {adjacent}"),
		})];
		let captured = request_attributes(CaptureMode::Summary, RequestContent {
			system_prompt: None,
			messages:      &messages,
		});
		assert_eq!(
			attribute_json(&captured, omp_gen_ai::REQUEST_MESSAGES)[0]["content"],
			format!("{short} {adjacent}")
		);
	}

	#[test]
	fn captured_content_is_redacted_by_default() {
		if run_redaction_test_isolated("content::tests::captured_content_is_redacted_by_default") {
			return;
		}
		let token = format!("gho_{}", "A".repeat(36));
		let messages = [json!({ "role": "user", "content": &token })];
		let captured = request_attributes(CaptureMode::Summary, RequestContent {
			system_prompt: None,
			messages:      &messages,
		});
		assert_eq!(
			attribute_json(&captured, omp_gen_ai::REQUEST_MESSAGES)[0]["content"],
			"[REDACTED]"
		);
	}
}
