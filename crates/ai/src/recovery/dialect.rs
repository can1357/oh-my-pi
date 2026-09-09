//! Incremental catalog-selected dialect-envelope recognition.

use std::{fmt, str};

use bytes::{Bytes, BytesMut};
use omp_catalog::{
	id::WirePolicyId,
	policy::{LeakedThinkingHealer, StreamMarkupHealingPattern},
};
use omp_core::{Str, sf};
use serde::Deserialize;
use serde_json::{Map, Number, Value};

use super::{
	RecoveryError, Stage,
	scanner::{Delimiter, DelimiterId, TagEvent, TagScanner},
};
use crate::receipt::{ReasonId, RecoveryKind, RecoveryRecord};

static JSON_TAG: &[Delimiter] =
	&[Delimiter { id: DelimiterId("json-tag"), open: b"<tool_call>", close: b"</tool_call>" }];
static QWEN_XML: &[Delimiter] = &[Delimiter {
	id:    DelimiterId("qwen-xml-tool-calls"),
	open:  b"<tool_calls>",
	close: b"</tool_calls>",
}];
static GEMINI: &[Delimiter] =
	&[Delimiter { id: DelimiterId("gemini-tool-code"), open: b"```tool_code\n", close: b"```" }];
static GEMMA: &[Delimiter] = &[Delimiter {
	id:    DelimiterId("gemma-tool-call"),
	open:  b"<|tool_call>",
	close: b"<tool_call|>",
}];
static KIMI: &[Delimiter] = &[Delimiter {
	id:    DelimiterId("kimi-tool-section"),
	open:  b"<|tool_calls_section_begin|><|tool_call_begin|>",
	close: b"<|tool_call_end|><|tool_calls_section_end|>",
}];
static DEEPSEEK: &[Delimiter] = &[Delimiter {
	id:    DelimiterId("deepseek-tool-call"),
	open:  "<｜tool▁call▁begin｜>".as_bytes(),
	close: "<｜tool▁call▁end｜>".as_bytes(),
}];
static HARMONY: &[Delimiter] = &[
	Delimiter {
		id:    DelimiterId("harmony-commentary-tool-call"),
		open:  b"<\x7cstart\x7c>assistant<\x7cchannel\x7c>commentary to=functions.",
		close: b"<\x7ccall\x7c>",
	},
	Delimiter {
		id:    DelimiterId("harmony-analysis-tool-call"),
		open:  b"<\x7cstart\x7c>assistant<\x7cchannel\x7c>analysis to=functions.",
		close: b"<\x7ccall\x7c>",
	},
];
static GLM: &[Delimiter] = &[Delimiter {
	id:    DelimiterId("glm-tool-call"),
	open:  b"<tool_call>",
	close: b"</tool_call>",
}];
static XML: &[Delimiter] =
	&[Delimiter { id: DelimiterId("xml-invoke"), open: b"<invoke", close: b"</invoke>" }];
static ANTHROPIC: &[Delimiter] = &[Delimiter {
	id:    DelimiterId("anthropic-invoke"),
	open:  b"<function_calls><invoke",
	close: b"</invoke></function_calls>",
}];
static MINIMAX: &[Delimiter] = &[Delimiter {
	id:    DelimiterId("minimax-invoke"),
	open:  b"<minimax:tool_call><invoke",
	close: b"</invoke></minimax:tool_call>",
}];

/// Catalog-selected model-authored prompt syntax.
///
/// Selection belongs to the catalog compiler/router. The runtime never derives
/// this value from provider or model names.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Dialect {
	/// GLM keyed XML calls.
	Glm,
	/// Hermes JSON-in-tag calls.
	Hermes,
	/// Kimi token-section calls.
	Kimi,
	/// Generic XML invoke calls.
	Xml,
	/// Anthropic function-call XML.
	Anthropic,
	/// `DeepSeek` token calls.
	DeepSeek,
	/// Harmony recipient messages.
	Harmony,
	/// Qwen 3 JSON-in-tag calls.
	Qwen3,
	/// Qwen self-closing XML calls.
	QwenXml,
	/// Gemini Python fenced calls.
	Gemini,
	/// Gemma token-delimited calls.
	Gemma,
	/// `MiniMax` wrapped XML calls.
	MiniMax,
}

impl Dialect {
	/// Resolves a tool-envelope dialect from catalog-selected stream recovery
	/// policy.
	pub const fn from_markup_pattern(pattern: StreamMarkupHealingPattern) -> Option<Self> {
		match pattern {
			StreamMarkupHealingPattern::Kimi => Some(Self::Kimi),
			StreamMarkupHealingPattern::Dsml => Some(Self::DeepSeek),
			StreamMarkupHealingPattern::Qwen => Some(Self::QwenXml),
			StreamMarkupHealingPattern::Harmony => Some(Self::Harmony),
			StreamMarkupHealingPattern::Thinking => None,
		}
	}

	/// Resolves a tool-envelope dialect from catalog-selected recovery policy.
	pub const fn from_healer(healer: LeakedThinkingHealer) -> Option<Self> {
		match healer {
			LeakedThinkingHealer::Qwen => Some(Self::QwenXml),
			LeakedThinkingHealer::None
			| LeakedThinkingHealer::Thinking
			| LeakedThinkingHealer::Kimi
			| LeakedThinkingHealer::Dsml => None,
		}
	}

	const fn delimiters(self) -> &'static [Delimiter] {
		match self {
			Self::Hermes | Self::Qwen3 => JSON_TAG,
			Self::QwenXml => QWEN_XML,
			Self::Gemini => GEMINI,
			Self::Gemma => GEMMA,
			Self::Kimi => KIMI,
			Self::DeepSeek => DEEPSEEK,
			Self::Harmony => HARMONY,
			Self::Glm => GLM,
			Self::Xml => XML,
			Self::Anthropic => ANTHROPIC,
			Self::MiniMax => MINIMAX,
		}
	}

	const fn rule(self) -> &'static str {
		match self {
			Self::Glm => "glm",
			Self::Hermes => "hermes",
			Self::Kimi => "kimi",
			Self::Xml => "xml",
			Self::Anthropic => "anthropic",
			Self::DeepSeek => "deepseek",
			Self::Harmony => "harmony",
			Self::Qwen3 => "qwen3",
			Self::QwenXml => "qwen-xml",
			Self::Gemini => "gemini",
			Self::Gemma => "gemma",
			Self::MiniMax => "minimax",
		}
	}
}

/// Bounded extracted tool candidate from a complete model-authored envelope.
#[derive(Clone, Eq, PartialEq)]
pub struct ToolEnvelope {
	/// Catalog-selected syntax which recognized the envelope.
	pub dialect:     Dialect,
	/// Extracted tool name, absent when the envelope is malformed.
	pub name:        Option<Str>,
	/// Exact or normalized complete argument JSON bytes.
	pub arguments:   Bytes,
	/// Bounded original envelope evidence.
	pub raw:         Bytes,
	/// Typed recovery evidence.
	pub recovery:    RecoveryRecord,
	/// Interned policy which selected the syntax.
	pub wire_policy: WirePolicyId,
}

impl fmt::Debug for ToolEnvelope {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ToolEnvelope")
			.field("dialect", &self.dialect)
			.field("name", &self.name)
			.field("argument_bytes", &self.arguments.len())
			.field("raw_bytes", &self.raw.len())
			.field("recovery", &self.recovery)
			.field("wire_policy", &self.wire_policy)
			.finish()
	}
}

/// Output from dialect recognition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DialectEvent {
	/// Bytes outside an owned dialect block.
	Text(Bytes),
	/// A complete dialect tool candidate.
	ToolEnvelope(ToolEnvelope),
}

/// Incremental dialect recognizer with bounded envelopes and diagnostics.
#[derive(Debug)]
pub struct DialectStage {
	dialect:              Dialect,
	wire_policy:          WirePolicyId,
	attempt:              u32,
	max_diagnostic_bytes: usize,
	scanner:              TagScanner,
}

impl DialectStage {
	/// Creates a scanner from catalog policy evidence.
	pub fn new(
		dialect: Dialect,
		wire_policy: WirePolicyId,
		attempt: u32,
		max_block_bytes: usize,
		max_diagnostic_bytes: usize,
	) -> Self {
		let delimiters = dialect.delimiters();
		Self {
			dialect,
			wire_policy,
			attempt,
			max_diagnostic_bytes,
			scanner: TagScanner::new(delimiters, max_block_bytes),
		}
	}
}

impl Stage<Bytes, DialectEvent> for DialectStage {
	fn push(
		&mut self,
		input: Bytes,
		emit: &mut dyn FnMut(DialectEvent),
	) -> Result<(), RecoveryError> {
		let dialect = self.dialect;
		let policy = self.wire_policy.clone();
		let attempt = self.attempt;
		let diagnostic = self.max_diagnostic_bytes;
		self.scanner.push(input, &mut |event| {
			project_event(dialect, &policy, attempt, diagnostic, event, emit);
		})
	}

	fn finish(&mut self, emit: &mut dyn FnMut(DialectEvent)) -> Result<(), RecoveryError> {
		let dialect = self.dialect;
		let policy = self.wire_policy.clone();
		let attempt = self.attempt;
		let diagnostic = self.max_diagnostic_bytes;
		self
			.scanner
			.finish(&mut |event| project_event(dialect, &policy, attempt, diagnostic, event, emit))
	}
}

fn project_event(
	dialect: Dialect,
	wire_policy: &WirePolicyId<str>,
	attempt: u32,
	max_diagnostic_bytes: usize,
	event: TagEvent,
	emit: &mut dyn FnMut(DialectEvent),
) {
	match event {
		TagEvent::Text(bytes) => emit(DialectEvent::Text(bytes)),
		TagEvent::Block { raw, .. } => {
			let canonical = canonical_raw(dialect, &raw);
			let mut candidates = parse_candidates(dialect, canonical);
			if candidates.is_empty() {
				candidates.push((None, Bytes::new()));
			}
			let recovered = candidates.iter().filter(|(name, _)| name.is_some()).count() as u32;
			for (name, arguments) in candidates {
				let record = RecoveryRecord {
					attempt,
					kind: RecoveryKind::DialectNormalization,
					rule: ReasonId(sf!("dialect/{}/{}", wire_policy.as_str(), dialect.rule())),
					input_bytes: raw.len() as u64,
					steps: recovered,
				};
				emit(DialectEvent::ToolEnvelope(ToolEnvelope {
					dialect,
					name,
					arguments,
					raw: bound_raw(canonical, max_diagnostic_bytes),
					recovery: record,
					wire_policy: wire_policy.to_owned(),
				}));
			}
		},
	}
}

fn bound_raw(raw: &[u8], limit: usize) -> Bytes {
	if raw.len() <= limit {
		return Bytes::copy_from_slice(raw);
	}
	let head = limit.div_ceil(2);
	let tail = limit.saturating_sub(head);
	let mut bounded = BytesMut::with_capacity(limit);
	bounded.extend_from_slice(&raw[..head]);
	bounded.extend_from_slice(&raw[raw.len() - tail..]);
	bounded.freeze()
}

fn canonical_raw(dialect: Dialect, raw: &[u8]) -> &[u8] {
	match dialect {
		Dialect::Kimi => raw
			.strip_prefix(b"<|tool_calls_section_begin|>")
			.and_then(|body| body.strip_suffix(b"<|tool_calls_section_end|>"))
			.unwrap_or(raw),
		Dialect::Anthropic => raw
			.strip_prefix(b"<function_calls>")
			.and_then(|body| body.strip_suffix(b"</function_calls>"))
			.unwrap_or(raw),
		Dialect::MiniMax => raw
			.strip_prefix(b"<minimax:tool_call>")
			.and_then(|body| body.strip_suffix(b"</minimax:tool_call>"))
			.unwrap_or(raw),
		_ => raw,
	}
}

fn parse_candidates(dialect: Dialect, raw: &[u8]) -> Vec<(Option<Str>, Bytes)> {
	if dialect == Dialect::Gemini {
		let Some(body) = raw
			.strip_prefix(b"```tool_code\n")
			.and_then(|body| body.strip_suffix(b"```"))
		else {
			return Vec::new();
		};
		return python_calls(body)
			.into_iter()
			.filter_map(|(name, arguments)| {
				serde_json::to_vec(&arguments)
					.ok()
					.map(|arguments| (Some(name), Bytes::from(arguments)))
			})
			.collect();
	}
	if dialect == Dialect::QwenXml {
		return parse_qwen_xml(raw);
	}
	parse_envelope(dialect, raw).into_iter().collect()
}

fn parse_envelope(dialect: Dialect, raw: &[u8]) -> Option<(Option<Str>, Bytes)> {
	match dialect {
		Dialect::Hermes | Dialect::Qwen3 => parse_json_tag(raw),
		Dialect::QwenXml => None,
		Dialect::Gemini => None,
		Dialect::Gemma => parse_gemma(raw),
		Dialect::Kimi => parse_token_pair(
			raw,
			b"<|tool_call_begin|>functions.",
			b":0<|tool_call_argument_begin|>",
			b"<|tool_call_end|>",
		),
		Dialect::DeepSeek => parse_token_pair(
			raw,
			"<｜tool▁call▁begin｜>".as_bytes(),
			"<｜tool▁sep｜>".as_bytes(),
			"<｜tool▁call▁end｜>".as_bytes(),
		),
		Dialect::Harmony => [
			b"<\x7cstart\x7c>assistant<\x7cchannel\x7c>commentary to=functions.".as_slice(),
			b"<\x7cstart\x7c>assistant<\x7cchannel\x7c>analysis to=functions.".as_slice(),
		]
		.into_iter()
		.find_map(|open| parse_token_pair(raw, open, b"<\x7cmessage\x7c>", b"<\x7ccall\x7c>")),
		Dialect::Glm => parse_glm(raw),
		Dialect::Xml | Dialect::Anthropic | Dialect::MiniMax => parse_xml(raw),
	}
}
fn parse_qwen_xml(raw: &[u8]) -> Vec<(Option<Str>, Bytes)> {
	let Some(body) = raw
		.strip_prefix(b"<tool_calls>")
		.and_then(|body| body.strip_suffix(b"</tool_calls>"))
	else {
		return Vec::new();
	};
	let Ok(body) = str::from_utf8(body) else {
		return Vec::new();
	};
	let mut calls = Vec::new();
	let mut cursor = 0;
	while let Some(start) = body[cursor..].find('<') {
		let start = cursor + start;
		let Some(relative_end) = body[start..].find('>') else {
			break;
		};
		let end = start + relative_end + 1;
		if let Some((name, arguments)) = parse_qwen_element(&body[start..end])
			&& let Ok(arguments) = serde_json::to_vec(&arguments)
		{
			calls.push((Some(name), Bytes::from(arguments)));
		}
		cursor = end;
	}
	calls
}

fn parse_qwen_element(element: &str) -> Option<(Str, Map<String, Value>)> {
	let body = element.strip_prefix('<')?.strip_suffix('>')?.trim();
	let body = body.strip_suffix('/')?.trim_end();
	let name_end = body
		.char_indices()
		.find_map(|(index, character)| (!qwen_name_character(character, index == 0)).then_some(index))
		.unwrap_or(body.len());
	let name = body.get(..name_end)?;
	if name.is_empty() {
		return None;
	}
	let mut rest = &body[name_end..];
	let mut arguments = Map::new();
	while !rest.trim_start().is_empty() {
		rest = rest.trim_start();
		let key_end = rest
			.char_indices()
			.find_map(|(index, character)| {
				(!qwen_name_character(character, index == 0)).then_some(index)
			})
			.unwrap_or(rest.len());
		let key = rest.get(..key_end)?;
		if key.is_empty() {
			return None;
		}
		rest = rest
			.get(key_end..)?
			.trim_start()
			.strip_prefix('=')?
			.trim_start();
		let quote = rest.chars().next()?;
		if !matches!(quote, '"' | '\'') {
			return None;
		}
		rest = rest.get(quote.len_utf8()..)?;
		let value_end = rest.find(quote)?;
		arguments.insert(key.to_owned(), Value::String(rest[..value_end].to_owned()));
		rest = rest.get(value_end + quote.len_utf8()..)?;
	}
	Some((Str::new(name), arguments))
}

const fn qwen_name_character(character: char, first: bool) -> bool {
	if first {
		character.is_ascii_alphabetic() || character == '_'
	} else {
		character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
	}
}

#[derive(Deserialize)]
struct JsonCall {
	name:      Str,
	arguments: Map<String, Value>,
}
fn parse_json_tag(raw: &[u8]) -> Option<(Option<Str>, Bytes)> {
	let body = raw
		.strip_prefix(b"<tool_call>")?
		.strip_suffix(b"</tool_call>")?;
	let call: JsonCall = serde_json::from_slice(body).ok()?;
	Some((
		(!call.name.trim().is_empty()).then_some(call.name),
		Bytes::from(serde_json::to_vec(&call.arguments).ok()?),
	))
}

fn parse_token_pair(
	raw: &[u8],
	open: &[u8],
	separator: &[u8],
	close: &[u8],
) -> Option<(Option<Str>, Bytes)> {
	let body = raw.strip_prefix(open)?.strip_suffix(close)?;
	let at = body
		.windows(separator.len())
		.position(|window| window == separator)?;
	let name = Str::from_utf8(&body[..at]).ok()?;
	let args = Bytes::copy_from_slice(body[at + separator.len()..].trim_ascii());
	serde_json::from_slice::<Map<String, Value>>(&args).ok()?;
	Some(((!name.trim().is_empty()).then_some(name), args))
}

fn parse_glm(raw: &[u8]) -> Option<(Option<Str>, Bytes)> {
	let body = str::from_utf8(
		raw.strip_prefix(b"<tool_call>")?
			.strip_suffix(b"</tool_call>")?,
	)
	.ok()?;
	let (name, mut rest) = body.split_once('\n')?;
	let name = Str::new(name.trim());
	if name.is_empty() {
		return None;
	}
	let mut arguments = Map::new();
	while let Some(after_key) = rest.strip_prefix("<arg_key>") {
		let (key, after_key) = after_key.split_once("</arg_key>")?;
		let after_value = after_key.strip_prefix("<arg_value>")?;
		let (value, remaining) = after_value.split_once("</arg_value>")?;
		arguments.insert(
			key.to_owned(),
			serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_owned())),
		);
		rest = remaining;
	}
	if !rest.trim().is_empty() {
		return None;
	}
	Some((Some(name), Bytes::from(serde_json::to_vec(&arguments).ok()?)))
}

fn python_calls(body: &[u8]) -> Vec<(Str, Map<String, Value>)> {
	let Ok(text) = str::from_utf8(body) else {
		return Vec::new();
	};
	let bytes = text.as_bytes();
	let needle = b"default_api.";
	let mut at = 0;
	let mut calls = Vec::new();
	while at + needle.len() <= bytes.len() {
		let Some(relative) = bytes[at..]
			.windows(needle.len())
			.position(|window| window == needle)
		else {
			break;
		};
		let start = at + relative + needle.len();
		let name_end = bytes[start..]
			.iter()
			.position(|byte| !byte.is_ascii_alphanumeric() && *byte != b'_')
			.map_or(bytes.len(), |end| start + end);
		if name_end == start || bytes.get(name_end) != Some(&b'(') {
			at = name_end.saturating_add(1);
			continue;
		}
		let Some(end) = matching_delimiter(bytes, name_end, b'(', b')') else {
			break;
		};
		if let Some(args) = parse_python_arguments(&text[name_end + 1..end]) {
			calls.push((Str::new(&text[start..name_end]), args));
		}
		at = end + 1;
	}
	calls
}

fn parse_python_arguments(text: &str) -> Option<Map<String, Value>> {
	let mut args = Map::new();
	for segment in split_top_level(text, b',')? {
		let segment = segment.trim();
		if segment.is_empty() {
			continue;
		}
		let equals = top_level_index(segment, b'=')?;
		let name = segment[..equals].trim();
		if name.is_empty()
			|| !name
				.bytes()
				.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
		{
			return None;
		}
		args.insert(name.to_owned(), parse_python_value(segment[equals + 1..].trim())?);
	}
	Some(args)
}

fn parse_python_value(text: &str) -> Option<Value> {
	if text == "True" {
		return Some(Value::Bool(true));
	}
	if text == "False" {
		return Some(Value::Bool(false));
	}
	if text == "None" {
		return Some(Value::Null);
	}
	if let Some(inner) = quote_body(text) {
		return Some(Value::String(unescape_python(inner, text.as_bytes()[0])?));
	}
	if text.starts_with('[') && text.ends_with(']') {
		let mut values = Vec::new();
		for item in split_top_level(&text[1..text.len() - 1], b',')? {
			if !item.trim().is_empty() {
				values.push(parse_python_value(item.trim())?);
			}
		}
		return Some(Value::Array(values));
	}
	if text.starts_with('{') && text.ends_with('}') {
		let mut values = Map::new();
		for item in split_top_level(&text[1..text.len() - 1], b',')? {
			if item.trim().is_empty() {
				continue;
			}
			let colon = top_level_index(item, b':')?;
			let key = quote_body(item[..colon].trim())
				.and_then(|value| unescape_python(value, item[..colon].trim().as_bytes()[0]))?;
			values.insert(key, parse_python_value(item[colon + 1..].trim())?);
		}
		return Some(Value::Object(values));
	}
	text
		.parse::<i64>()
		.ok()
		.map(Number::from)
		.map(Value::Number)
		.or_else(|| {
			text
				.parse::<f64>()
				.ok()
				.and_then(Number::from_f64)
				.map(Value::Number)
		})
}

fn quote_body(text: &str) -> Option<&str> {
	let bytes = text.as_bytes();
	(bytes.len() >= 2 && matches!(bytes[0], b'\'' | b'"') && bytes[bytes.len() - 1] == bytes[0])
		.then(|| &text[1..text.len() - 1])
}
fn unescape_python(text: &str, quote: u8) -> Option<String> {
	let mut out = String::with_capacity(text.len());
	let mut chars = text.chars();
	while let Some(character) = chars.next() {
		if character != '\\' {
			out.push(character);
			continue;
		}
		let escaped = chars.next()?;
		match escaped {
			'n' => out.push('\n'),
			'r' => out.push('\r'),
			't' => out.push('\t'),
			'\\' => out.push('\\'),
			character if character as u32 == u32::from(quote) => out.push(character),
			other => {
				out.push('\\');
				out.push(other);
			},
		}
	}
	Some(out)
}

fn parse_gemma(raw: &[u8]) -> Option<(Option<Str>, Bytes)> {
	let body = str::from_utf8(
		raw.strip_prefix(b"<|tool_call>")?
			.strip_suffix(b"<tool_call|>")?,
	)
	.ok()?
	.trim();
	let body = body.strip_prefix("call:")?;
	let brace = body.find('{')?;
	let end = matching_delimiter(body.as_bytes(), brace, b'{', b'}')?;
	if !body[end + 1..].trim().is_empty() {
		return None;
	}
	let name = Str::new(body[..brace].trim());
	let args = parse_gemma_object(&body[brace + 1..end])?;
	Some(((!name.is_empty()).then_some(name), Bytes::from(serde_json::to_vec(&args).ok()?)))
}

fn parse_gemma_object(text: &str) -> Option<Map<String, Value>> {
	let mut args = Map::new();
	for segment in split_gemma_top_level(text, b',')? {
		let segment = segment.trim();
		if segment.is_empty() {
			continue;
		}
		let colon = gemma_top_level_index(segment, b':')?;
		let name = segment[..colon].trim();
		if name.is_empty() {
			return None;
		}
		args.insert(name.to_owned(), parse_gemma_value(segment[colon + 1..].trim())?);
	}
	Some(args)
}
fn parse_gemma_value(text: &str) -> Option<Value> {
	const QUOTE: &str = "<|\"|>";
	if let Some(body) = text
		.strip_prefix(QUOTE)
		.and_then(|rest| rest.strip_suffix(QUOTE))
	{
		return Some(Value::String(body.to_owned()));
	}
	if text.starts_with('{') && text.ends_with('}') {
		return Some(Value::Object(parse_gemma_object(&text[1..text.len() - 1])?));
	}
	if text.starts_with('[') && text.ends_with(']') {
		let mut values = Vec::new();
		for item in split_gemma_top_level(&text[1..text.len() - 1], b',')? {
			if !item.trim().is_empty() {
				values.push(parse_gemma_value(item.trim())?);
			}
		}
		return Some(Value::Array(values));
	}
	serde_json::from_str(text).ok()
}

fn split_gemma_top_level(text: &str, separator: u8) -> Option<Vec<&str>> {
	let mut parts = Vec::new();
	let mut start = 0;
	let mut search = 0;
	while let Some(at) = gemma_top_level_index(&text[search..], separator) {
		let absolute = search + at;
		parts.push(&text[start..absolute]);
		start = absolute + 1;
		search = start;
	}
	if gemma_balanced(&text[start..])? {
		parts.push(&text[start..]);
		Some(parts)
	} else {
		None
	}
}

fn gemma_top_level_index(text: &str, target: u8) -> Option<usize> {
	const QUOTE: &[u8] = b"<|\"|>";
	let bytes = text.as_bytes();
	let mut index = 0;
	let mut stack = Vec::new();
	let mut quoted = false;
	while index < bytes.len() {
		if bytes[index..].starts_with(QUOTE) {
			quoted = !quoted;
			index += QUOTE.len();
			continue;
		}
		if quoted {
			index += 1;
			continue;
		}
		match bytes[index] {
			b'[' | b'{' => stack.push(bytes[index]),
			b']' if stack.pop()? == b'[' => {},
			b'}' if stack.pop()? == b'{' => {},
			byte if byte == target && stack.is_empty() => return Some(index),
			_ => {},
		}
		index += 1;
	}
	None
}

fn gemma_balanced(text: &str) -> Option<bool> {
	const QUOTE: &[u8] = b"<|\"|>";
	let bytes = text.as_bytes();
	let mut index = 0;
	let mut stack = Vec::new();
	let mut quoted = false;
	while index < bytes.len() {
		if bytes[index..].starts_with(QUOTE) {
			quoted = !quoted;
			index += QUOTE.len();
			continue;
		}
		if quoted {
			index += 1;
			continue;
		}
		match bytes[index] {
			b'[' | b'{' => stack.push(bytes[index]),
			b']' if stack.pop()? == b'[' => {},
			b'}' if stack.pop()? == b'{' => {},
			b']' | b'}' => return None,
			_ => {},
		}
		index += 1;
	}
	Some(!quoted && stack.is_empty())
}

fn parse_xml(raw: &[u8]) -> Option<(Option<Str>, Bytes)> {
	let text = str::from_utf8(raw).ok()?;
	let name = text
		.split_once("name=\"")
		.and_then(|(_, rest)| rest.split_once('"').map(|(name, _)| name))
		.or_else(|| {
			text
				.split_once("<tool_call>")
				.and_then(|(_, rest)| rest.lines().next())
		})
		.map(str::trim)?;
	if name.is_empty() {
		return None;
	}
	let mut args = Map::new();
	let mut rest = text;
	while let Some((_, after)) = rest.split_once("<parameter name=\"") {
		let (key, after) = after.split_once("\">")?;
		let (value, after) = after.split_once("</parameter>")?;
		args.insert(
			key.to_owned(),
			serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_owned())),
		);
		rest = after;
	}
	Some((Some(Str::new(name)), Bytes::from(serde_json::to_vec(&args).ok()?)))
}

fn split_top_level(text: &str, separator: u8) -> Option<Vec<&str>> {
	let bytes = text.as_bytes();
	let mut result = Vec::new();
	let mut stack = Vec::new();
	let mut quote = None;
	let mut escaped = false;
	let mut start = 0;
	for (index, &byte) in bytes.iter().enumerate() {
		if let Some(active) = quote {
			if escaped {
				escaped = false;
			} else if byte == b'\\' {
				escaped = true;
			} else if byte == active {
				quote = None;
			}
			continue;
		}
		match byte {
			b'\'' | b'"' => quote = Some(byte),
			b'(' | b'[' | b'{' => stack.push(byte),
			b')' if stack.pop()? == b'(' => {},
			b']' if stack.pop()? == b'[' => {},
			b'}' if stack.pop()? == b'{' => {},
			byte if byte == separator && stack.is_empty() => {
				result.push(&text[start..index]);
				start = index + 1;
			},
			_ => {},
		}
	}
	if quote.is_some() || !stack.is_empty() {
		return None;
	}
	result.push(&text[start..]);
	Some(result)
}
fn top_level_index(text: &str, target: u8) -> Option<usize> {
	split_index(text, target)
}
fn split_index(text: &str, target: u8) -> Option<usize> {
	let bytes = text.as_bytes();
	let mut stack = Vec::new();
	let mut quote = None;
	let mut escaped = false;
	for (index, &byte) in bytes.iter().enumerate() {
		if let Some(active) = quote {
			if escaped {
				escaped = false;
			} else if byte == b'\\' {
				escaped = true;
			} else if byte == active {
				quote = None;
			}
			continue;
		}
		match byte {
			b'\'' | b'"' => quote = Some(byte),
			b'(' | b'[' | b'{' => stack.push(byte),
			b')' if stack.pop()? == b'(' => {},
			b']' if stack.pop()? == b'[' => {},
			b'}' if stack.pop()? == b'{' => {},
			byte if byte == target && stack.is_empty() => return Some(index),
			_ => {},
		}
	}
	None
}
fn matching_delimiter(text: &[u8], start: usize, open: u8, close: u8) -> Option<usize> {
	let mut depth = 0usize;
	let mut quote = None;
	let mut escaped = false;
	for (index, &byte) in text.iter().enumerate().skip(start) {
		if let Some(active) = quote {
			if escaped {
				escaped = false;
			} else if byte == b'\\' {
				escaped = true;
			} else if byte == active {
				quote = None;
			}
			continue;
		}
		match byte {
			b'\'' | b'"' => quote = Some(byte),
			b if b == open => depth += 1,
			b if b == close => {
				depth = depth.checked_sub(1)?;
				if depth == 0 {
					return Some(index);
				}
			},
			_ => {},
		}
	}
	None
}

#[cfg(test)]
mod tests {
	use super::*;
	fn calls(dialect: Dialect, input: &[u8], split: usize) -> Vec<(Str, Value)> {
		let mut stage = DialectStage::new(dialect, WirePolicyId::new("wire"), 1, 4096, 128);
		let mut found = Vec::new();
		let mut collect = |event| {
			if let DialectEvent::ToolEnvelope(envelope) = event
				&& let Some(name) = envelope.name
			{
				found.push((name, serde_json::from_slice(&envelope.arguments).unwrap()));
			}
		};
		stage
			.push(Bytes::copy_from_slice(&input[..split]), &mut collect)
			.unwrap();
		stage
			.push(Bytes::copy_from_slice(&input[split..]), &mut collect)
			.unwrap();
		stage.finish(&mut collect).unwrap();
		found
	}
	#[test]
	fn gemini_and_gemma_candidates_are_split_invariant() {
		for (dialect, input) in [(Dialect::Gemini, b"```tool_code\nprint(default_api.run(ok=True, missing=None, n=-2.5, xs=[1, 'two'], cfg={'x': 3}))\n```".as_slice()), (Dialect::Gemma, b"<|tool_call>call:run{x:1, ok:true, missing:null, nested:{items:[1,2]}}<tool_call|>".as_slice())] { let expected = calls(dialect, input, input.len()); assert!(!expected.is_empty()); for split in 0..=input.len() { assert_eq!(calls(dialect, input, split), expected, "split {split}"); } }
	}
	#[test]
	fn every_dialect_candidate_is_split_invariant() {
		let cases: &[(Dialect, &[u8])] = &[
			(Dialect::Glm, b"<tool_call>echo\n<arg_key>x</arg_key><arg_value>1</arg_value></tool_call>"),
			(Dialect::Hermes, b"<tool_call>{\"name\":\"echo\",\"arguments\":{\"x\":1}}</tool_call>"),
			(Dialect::Kimi, b"<|tool_calls_section_begin|><|tool_call_begin|>functions.echo:0<|tool_call_argument_begin|>{\"x\":1}<|tool_call_end|><|tool_calls_section_end|>"),
			(Dialect::Xml, b"<invoke name=\"echo\"><parameter name=\"x\">1</parameter></invoke>"),
			(Dialect::Anthropic, b"<function_calls><invoke name=\"echo\"><parameter name=\"x\">1</parameter></invoke></function_calls>"),
			(Dialect::DeepSeek, "<｜tool▁call▁begin｜>echo<｜tool▁sep｜>{\"x\":1}<｜tool▁call▁end｜>".as_bytes()),
			(Dialect::Harmony, b"<\x7cstart\x7c>assistant<\x7cchannel\x7c>commentary to=functions.echo<\x7cmessage\x7c>{\"x\":1}<\x7ccall\x7c>"),
			(Dialect::Qwen3, b"<tool_call>{\"name\":\"echo\",\"arguments\":{\"x\":1}}</tool_call>"),
			(Dialect::QwenXml, b"<tool_calls><echo x=\"1\" /></tool_calls>"),
			(Dialect::Gemini, b"```tool_code\ndefault_api.echo(x=1)\n```"),
			(Dialect::Gemma, b"<|tool_call>call:echo{x:1}<tool_call|>"),
			(Dialect::MiniMax, b"<minimax:tool_call><invoke name=\"echo\"><parameter name=\"x\">1</parameter></invoke></minimax:tool_call>"),
		];
		for &(dialect, input) in cases {
			let expected = calls(dialect, input, input.len());
			assert_eq!(expected.len(), 1, "{dialect:?}");
			for split in 0..=input.len() {
				assert_eq!(calls(dialect, input, split), expected, "{dialect:?} split {split}");
			}
		}
	}
	#[test]
	fn prose_outside_owned_blocks_never_fabricates_calls() {
		assert!(calls(Dialect::Gemini, b"default_api.search(query='outside')", 1).is_empty());
		assert!(calls(Dialect::Gemma, b"call:search{query:'outside'}", 1).is_empty());
	}
	#[test]
	fn qwen_xml_heals_self_closing_calls_with_quoted_attributes() {
		assert_eq!(Dialect::from_healer(LeakedThinkingHealer::Qwen), Some(Dialect::QwenXml),);
		let input = br#"Before
<tool_calls>
<read path="/etc/hostname" mode='safe' />
<write-file path="a.txt" text="hello" />
</tool_calls>
After"#;
		for split in 0..=input.len() {
			assert_eq!(
				calls(Dialect::QwenXml, input, split),
				vec![
					(sf!("read"), serde_json::json!({"path":"/etc/hostname","mode":"safe"}),),
					(sf!("write-file"), serde_json::json!({"path":"a.txt","text":"hello"}),),
				],
				"split {split}",
			);
		}
	}
}
