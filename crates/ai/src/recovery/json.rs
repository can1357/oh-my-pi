//! Deterministic bounded JSON syntax recovery.

use bytes::{Bytes, BytesMut};
use omp_catalog::id::WirePolicyId;
use omp_core::{
	sf,
	slopjson::{Deserializer as SlopDeserializer, repair_json},
};
use serde::Deserialize as _;
use serde_json::Value;

use super::{DiagnosticContext, RecoveryError, Stage};
use crate::receipt::{ReasonId, RecoveryKind, RecoveryRecord};

/// Structured-output enforcement selected during planning.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JsonEnforcement {
	/// Accept only provider-native valid JSON; never repair syntax.
	Strict,
	/// Accept native JSON or deterministically repair it within declared bounds.
	NativeOrRepair,
}

/// Explicit resource bounds for JSON decoding and repair.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct JsonRepairLimits {
	/// Maximum input bytes retained for one document.
	pub max_bytes:        usize,
	/// Maximum object/array nesting depth.
	pub max_depth:        usize,
	/// Maximum individual deterministic transformations.
	pub max_steps:        u32,
	/// Maximum malformed-byte preview retained in an error.
	pub diagnostic_bytes: usize,
}

impl Default for JsonRepairLimits {
	fn default() -> Self {
		Self {
			max_bytes:        1 << 20,
			max_depth:        64,
			max_steps:        128,
			diagnostic_bytes: 128,
		}
	}
}

/// Successfully decoded JSON and its auditable recovery evidence.
#[derive(Clone, Debug)]
pub struct JsonDocument {
	/// Canonically serialized valid JSON.
	pub bytes:    Bytes,
	/// Parsed opaque JSON value.
	pub value:    Value,
	/// Recovery evidence, absent when the input was natively valid.
	pub recovery: Option<RecoveryRecord>,
}

/// Incremental bounded JSON document stage.
///
/// `push` validates depth and strings only over newly arrived bytes. Parsing
/// and optional repair happen once, at `finish`; no chunk causes full-prefix
/// reparsing.
#[derive(Debug)]
pub struct JsonRepairStage {
	enforcement: JsonEnforcement,
	limits:      JsonRepairLimits,
	wire_policy: WirePolicyId,
	attempt:     u32,
	input:       BytesMut,
	scan_at:     usize,
	stack:       Vec<u8>,
	string:      Option<u8>,
	escaped:     bool,
}

impl JsonRepairStage {
	/// Creates a repair stage with catalog policy evidence and explicit limits.
	pub fn new(
		enforcement: JsonEnforcement,
		limits: JsonRepairLimits,
		wire_policy: WirePolicyId,
		attempt: u32,
	) -> Self {
		Self {
			enforcement,
			limits,
			wire_policy,
			attempt,
			input: BytesMut::new(),
			scan_at: 0,
			stack: Vec::new(),
			string: None,
			escaped: false,
		}
	}

	fn scan_new(&mut self) -> Result<(), RecoveryError> {
		if self.input.len() > self.limits.max_bytes {
			return Err(RecoveryError::LimitExceeded { stage: "json", limit: self.limits.max_bytes });
		}
		while self.scan_at < self.input.len() {
			let byte = self.input[self.scan_at];
			self.scan_at += 1;
			if let Some(quote) = self.string {
				if self.escaped {
					self.escaped = false;
					continue;
				}
				if byte == b'\\' {
					self.escaped = true;
				} else if byte == quote {
					self.string = None;
				}
				continue;
			}
			match byte {
				b'\'' | b'"' => self.string = Some(byte),
				b'{' | b'[' => {
					self.stack.push(byte);
					if self.stack.len() > self.limits.max_depth {
						return Err(RecoveryError::LimitExceeded {
							stage: "json-depth",
							limit: self.limits.max_depth,
						});
					}
				},
				b'}' if self.stack.last() == Some(&b'{') => {
					self.stack.pop();
				},
				b']' if self.stack.last() == Some(&b'[') => {
					self.stack.pop();
				},
				_ => {},
			}
		}
		Ok(())
	}

	fn finish_document(&mut self) -> Result<JsonDocument, RecoveryError> {
		self.scan_new()?;
		if let Ok(value) = serde_json::from_slice::<Value>(&self.input) {
			let bytes =
				Bytes::from(serde_json::to_vec(&value).map_err(|_| RecoveryError::InvalidInput {
					stage:  "json",
					reason: sf!("valid JSON could not be serialized"),
				})?);
			self.reset();
			return Ok(JsonDocument { bytes, value, recovery: None });
		}
		let diagnostic = DiagnosticContext::capture(&self.input, self.limits.diagnostic_bytes);
		if self.enforcement == JsonEnforcement::Strict {
			self.reset();
			return Err(RecoveryError::RepairRejected { stage: "json", diagnostic });
		}
		let (value, steps) = parse_repaired_value(&self.input, self.limits).map_err(|_| {
			RecoveryError::InvalidDocument {
				stage:      "json",
				reason:     sf!("bounded deterministic repair did not produce valid JSON"),
				diagnostic: diagnostic.clone(),
			}
		})?;
		let bytes =
			Bytes::from(serde_json::to_vec(&value).map_err(|_| RecoveryError::InvalidInput {
				stage:  "json",
				reason: sf!("repaired JSON could not be serialized"),
			})?);
		let recovery = RecoveryRecord {
			attempt: self.attempt,
			kind: RecoveryKind::JsonRepair,
			rule: ReasonId(sf!("json-repair/{}", self.wire_policy.as_str())),
			input_bytes: diagnostic.input_bytes() as u64,
			steps,
		};
		self.reset();
		Ok(JsonDocument { bytes, value, recovery: Some(recovery) })
	}

	fn reset(&mut self) {
		self.input.clear();
		self.scan_at = 0;
		self.stack.clear();
		self.string = None;
		self.escaped = false;
	}
}

impl Stage<Bytes, JsonDocument> for JsonRepairStage {
	fn push(
		&mut self,
		input: Bytes,
		_emit: &mut dyn FnMut(JsonDocument),
	) -> Result<(), RecoveryError> {
		self.input.extend_from_slice(&input);
		self.scan_new()
	}

	fn finish(&mut self, emit: &mut dyn FnMut(JsonDocument)) -> Result<(), RecoveryError> {
		emit(self.finish_document()?);
		Ok(())
	}
}

fn repair(input: &[u8], limits: JsonRepairLimits) -> Result<(Vec<u8>, u32), RecoveryError> {
	let trimmed = trim_ascii(input);
	let body = trimmed
		.strip_prefix(b"```json")
		.or_else(|| trimmed.strip_prefix(b"```JSON"))
		.map(|rest| {
			rest
				.strip_prefix(b"\r\n")
				.or_else(|| rest.strip_prefix(b"\n"))
				.unwrap_or(rest)
		})
		.and_then(|rest| rest.strip_suffix(b"```"))
		.map_or(trimmed, trim_ascii);
	let mut steps = u32::from(body.len() != trimmed.len());
	let mut output = Vec::with_capacity(body.len().saturating_add(16));
	let mut stack: Vec<u8> = Vec::new();
	let mut index = 0;
	let mut expecting_key = false;
	while index < body.len() {
		let byte = body[index];
		match byte {
			b'"' | b'\'' => {
				let quote = byte;
				if quote == b'\'' {
					bump(&mut steps, limits.max_steps)?;
				}
				output.push(b'"');
				index += 1;
				let mut closed = false;
				while index < body.len() {
					let current = body[index];
					index += 1;
					if current == b'\\' {
						output.push(current);
						if let Some(&escaped) = body.get(index) {
							output.push(escaped);
							index += 1;
						}
						continue;
					}
					if current == quote {
						closed = true;
						break;
					}
					if quote == b'\'' && current == b'"' {
						output.extend_from_slice(b"\\\"");
					} else {
						output.push(current);
					}
				}
				if !closed {
					return Err(RecoveryError::Incomplete { stage: "json-string" });
				}
				output.push(b'"');
				expecting_key = false;
			},
			b'{' => {
				output.push(byte);
				stack.push(byte);
				ensure_depth(&stack, limits.max_depth)?;
				expecting_key = true;
				index += 1;
			},
			b'[' => {
				output.push(byte);
				stack.push(byte);
				ensure_depth(&stack, limits.max_depth)?;
				expecting_key = false;
				index += 1;
			},
			b'}' | b']' => {
				while output.last().is_some_and(u8::is_ascii_whitespace) {
					output.pop();
				}
				if output.last() == Some(&b',') {
					output.pop();
					bump(&mut steps, limits.max_steps)?;
				}
				let expected = if byte == b'}' { b'{' } else { b'[' };
				if stack.last() == Some(&expected) {
					stack.pop();
					output.push(byte);
				} else {
					bump(&mut steps, limits.max_steps)?;
				}
				index += 1;
				expecting_key = false;
			},
			b',' => {
				output.push(byte);
				index += 1;
				expecting_key = stack.last() == Some(&b'{');
			},
			b':' => {
				output.push(byte);
				index += 1;
				expecting_key = false;
			},
			_ if expecting_key && is_identifier_start(byte) => {
				let start = index;
				index += 1;
				while index < body.len() && is_identifier_continue(body[index]) {
					index += 1;
				}
				let mut look = index;
				while body.get(look).is_some_and(u8::is_ascii_whitespace) {
					look += 1;
				}
				if body.get(look) == Some(&b':') {
					output.push(b'"');
					output.extend_from_slice(&body[start..index]);
					output.push(b'"');
					bump(&mut steps, limits.max_steps)?;
				} else {
					output.extend_from_slice(&body[start..index]);
				}
				expecting_key = false;
			},
			_ => {
				output.push(byte);
				index += 1;
			},
		}
	}
	while output.last().is_some_and(u8::is_ascii_whitespace) {
		output.pop();
	}
	if output.last() == Some(&b',') {
		output.pop();
		bump(&mut steps, limits.max_steps)?;
	}
	if !stack.is_empty() {
		return Err(RecoveryError::Incomplete { stage: "json-container" });
	}
	if output.len() > limits.max_bytes {
		return Err(RecoveryError::LimitExceeded { stage: "json", limit: limits.max_bytes });
	}
	let output = str::from_utf8(&output).map_err(|_| RecoveryError::InvalidInput {
		stage:  "json",
		reason: sf!("JSON repair input is not UTF-8"),
	})?;
	let escape_repairs = count_escape_repairs(output);
	for _ in 0..escape_repairs {
		bump(&mut steps, limits.max_steps)?;
	}
	let output = repair_json(output).into_owned().into_bytes();
	if output.len() > limits.max_bytes {
		return Err(RecoveryError::LimitExceeded { stage: "json", limit: limits.max_bytes });
	}
	Ok((output, steps))
}
pub(crate) fn parse_repaired_value(
	input: &[u8],
	limits: JsonRepairLimits,
) -> Result<(Value, u32), RecoveryError> {
	let (repaired, mut steps) = repair(input, limits)?;
	let repaired = str::from_utf8(&repaired).map_err(|_| RecoveryError::InvalidInput {
		stage:  "json",
		reason: sf!("JSON repair output is not UTF-8"),
	})?;
	let mut deserializer = SlopDeserializer::new(repaired);
	let value = Value::deserialize(&mut deserializer).map_err(|_| RecoveryError::InvalidInput {
		stage:  "json",
		reason: sf!("tolerant JSON parser rejected repaired input"),
	})?;
	deserializer
		.end()
		.map_err(|_| RecoveryError::InvalidInput {
			stage:  "json",
			reason: sf!("tolerant JSON parser found trailing input"),
		})?;
	for _ in 0..deserializer.repairs().len() {
		bump(&mut steps, limits.max_steps)?;
	}
	Ok((value, steps))
}

fn count_escape_repairs(input: &str) -> u32 {
	let bytes = input.as_bytes();
	let mut count = 0u32;
	let mut in_string = false;
	let mut index = 0usize;
	while index < bytes.len() {
		let byte = bytes[index];
		if !in_string {
			if byte == b'"' {
				in_string = true;
			}
			index += 1;
			continue;
		}
		match byte {
			b'"' => {
				in_string = false;
				index += 1;
			},
			b'\\' => {
				let valid = match bytes.get(index + 1).copied() {
					Some(b'u') => {
						index + 6 <= bytes.len()
							&& bytes[index + 2..index + 6]
								.iter()
								.all(u8::is_ascii_hexdigit)
					},
					Some(next) => matches!(next, b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't'),
					None => false,
				};
				if valid {
					index += if bytes.get(index + 1) == Some(&b'u') {
						6
					} else {
						2
					};
				} else {
					count = count.saturating_add(1);
					index += 1;
				}
			},
			control if control < 0x20 => {
				count = count.saturating_add(1);
				index += 1;
			},
			_ => index += 1,
		}
	}
	count
}

const fn bump(steps: &mut u32, limit: u32) -> Result<(), RecoveryError> {
	*steps = steps.saturating_add(1);
	if *steps > limit {
		Err(RecoveryError::LimitExceeded { stage: "json-steps", limit: limit as usize })
	} else {
		Ok(())
	}
}
const fn ensure_depth(stack: &[u8], limit: usize) -> Result<(), RecoveryError> {
	if stack.len() > limit {
		Err(RecoveryError::LimitExceeded { stage: "json-depth", limit })
	} else {
		Ok(())
	}
}
const fn is_identifier_start(byte: u8) -> bool {
	byte == b'_' || byte.is_ascii_alphabetic()
}
const fn is_identifier_continue(byte: u8) -> bool {
	is_identifier_start(byte) || byte.is_ascii_digit() || byte == b'-'
}
fn trim_ascii(mut input: &[u8]) -> &[u8] {
	while input.first().is_some_and(u8::is_ascii_whitespace) {
		input = &input[1..];
	}
	while input.last().is_some_and(u8::is_ascii_whitespace) {
		input = &input[..input.len() - 1];
	}
	input
}

#[cfg(test)]
mod tests {
	use super::*;
	fn run(
		input: &[u8],
		enforcement: JsonEnforcement,
		split: usize,
	) -> Result<JsonDocument, RecoveryError> {
		let mut stage = JsonRepairStage::new(
			enforcement,
			JsonRepairLimits {
				max_bytes:        1024,
				max_depth:        8,
				max_steps:        16,
				diagnostic_bytes: 8,
			},
			WirePolicyId::new("wire"),
			2,
		);
		let mut out = Vec::new();
		stage.push(Bytes::copy_from_slice(&input[..split]), &mut |document| out.push(document))?;
		stage.push(Bytes::copy_from_slice(&input[split..]), &mut |document| out.push(document))?;
		stage.finish(&mut |document| out.push(document))?;
		Ok(out.pop().unwrap())
	}
	#[test]
	fn native_or_repair_is_deterministic_across_splits() {
		let input = b"```json\n{answer:'yes',items:[1,2,],}\n```";
		let expected = run(input, JsonEnforcement::NativeOrRepair, input.len())
			.unwrap()
			.bytes;
		for split in 0..=input.len() {
			let document = run(input, JsonEnforcement::NativeOrRepair, split).unwrap();
			assert_eq!(document.bytes, expected, "split {split}");
			assert!(document.recovery.is_some());
		}
	}
	#[test]
	fn strict_rejects_the_same_repairable_document() {
		let error = run(b"{answer:'yes'}", JsonEnforcement::Strict, 4).unwrap_err();
		assert!(matches!(error, RecoveryError::RepairRejected { .. }));
		assert!(!format!("{error:?}").contains("answer"));
	}
	#[test]
	fn shared_repair_handles_invalid_escapes_and_raw_controls() {
		let document =
			run(b"{\"value\":\"bad\\q\ntruncated\\u12\"}", JsonEnforcement::NativeOrRepair, 11)
				.expect("escape and control hazards repair");
		assert_eq!(document.value, serde_json::json!({"value":"bad\\q\ntruncated\\u12"}),);
		assert!(document.recovery.is_some());
	}
	#[test]
	fn structural_truncation_is_never_repaired() {
		for input in
			[b"{\"command\":\"echo never\",\"i\":\"Truncated".as_slice(), b"{answer:'yes'".as_slice()]
		{
			assert!(matches!(
				run(input, JsonEnforcement::NativeOrRepair, input.len()),
				Err(RecoveryError::InvalidDocument { .. })
			));
		}
	}

	#[test]
	fn depth_and_step_limits_are_typed() {
		assert!(matches!(
			run(b"[[[[[[[[[[]]]]]]]]]]", JsonEnforcement::NativeOrRepair, 2),
			Err(RecoveryError::LimitExceeded { stage: "json-depth", .. })
		));
		let input = b"{a:'x',b:'y',c:'z'}";
		assert!(matches!(
			repair(input, JsonRepairLimits { max_steps: 2, ..JsonRepairLimits::default() }),
			Err(RecoveryError::LimitExceeded { stage: "json-steps", .. })
		));
	}
}
