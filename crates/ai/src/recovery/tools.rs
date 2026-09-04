//! Incremental tool-call assembly, schema validation, and result pairing.

use std::{
	collections::{BTreeMap, BTreeSet},
	io::Cursor,
	iter, mem, str,
};

use bytes::{Bytes, BytesMut};
use omp_core::{Str, sf};
use serde_json::Value;
use xutf::BufReadCharsExt as _;

use super::{
	RecoveryError, Stage,
	json::{JsonRepairLimits, parse_repaired_value},
};
use crate::{
	call::{FREEFORM_INPUT_PROPERTY, OpaqueJson, ToolDefinition, ToolInputConstraint},
	codec::ToolInputKind,
	event::ToolCall,
	id::ToolCallId,
	receipt::{ReasonId, RecoveryKind, RecoveryRecord},
};

/// Hard bounds applied while assembling one tool call.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ToolAssemblyLimits {
	/// Maximum UTF-8 bytes in a tool name.
	pub max_name_bytes:     usize,
	/// Maximum bytes in encoded arguments.
	pub max_argument_bytes: usize,
	/// Maximum concurrently incomplete or awaiting-result calls.
	pub max_open_calls:     usize,
	/// Maximum calls accepted during one attempt, including completed calls.
	pub max_total_calls:    usize,
	/// Maximum schema/argument nesting depth.
	pub max_schema_depth:   usize,
	/// Maximum schema and argument nodes visited during validation.
	pub max_schema_nodes:   usize,
	/// Maximum tolerant syntax repairs applied to one argument document.
	pub max_repair_steps:   u32,
	/// Maximum recovery records retained by this stage.
	pub max_evidence:       usize,
}

impl Default for ToolAssemblyLimits {
	fn default() -> Self {
		Self {
			max_name_bytes:     256,
			max_argument_bytes: 1024 * 1024,
			max_open_calls:     128,
			max_total_calls:    1024,
			max_schema_depth:   64,
			max_schema_nodes:   65_536,
			max_repair_steps:   128,
			max_evidence:       64,
		}
	}
}

/// A deterministic reason why an incomplete call was not authorized.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolRejection {
	/// The source index was never started or was already completed.
	UnknownCall,
	/// A bound was exceeded.
	LimitExceeded {
		/// Bounded field.
		field: &'static str,
		/// Configured maximum.
		limit: usize,
	},
	/// The assembled name is empty, invalid UTF-8, or undeclared.
	InvalidName,
	/// Argument bytes do not form one complete JSON value.
	MalformedArguments {
		/// Parser column at rejection.
		offset: usize,
		/// Stable sanitized parser explanation.
		reason: Str,
	},
	/// Arguments do not conform to the declared schema.
	SchemaViolation(SchemaViolation),
	/// A second start conflicted with an open call at the same source index.
	ConflictingStart,
}

/// A stable, path-addressed schema violation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SchemaViolation {
	/// JSON Pointer-like location in the argument document.
	pub path:              Str,
	/// Stable validation rule identifier.
	pub rule:              &'static str,
	/// Candidate JSON types reported by a failed `type` check.
	pub expected_types:    Box<[Str]>,
	/// Whether this issue came from a speculative failed union branch.
	///
	/// Lossy repair consumers must ignore speculative issues. A branch uniquely
	/// selected by matching `const`/`enum` discriminators is authoritative and
	/// reports `false`.
	pub from_union_branch: bool,
}

/// One explicitly declared argument type repair.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArgumentCoercion {
	/// Convert common string boolean spellings.
	LooseBool,
	/// Convert an integral string to an integer.
	Integer,
	/// Convert a numeric string to a JSON number.
	Number,
	/// Encode a non-string JSON value as text.
	String,
	/// Wrap one non-array value in a one-element array.
	Singleton,
	/// Parse a string containing a complete JSON value.
	JsonString,
}

/// Ordered coercions declared for one canonical JSON pointer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArgumentCoercionSpec {
	/// Canonical argument location, with `/` denoting the root.
	pub path:      Str,
	/// Type repairs authorized at this exact location.
	pub coercions: Box<[ArgumentCoercion]>,
}

const _: () =
	assert!(std::mem::size_of::<SchemaViolation>() <= 64, "SchemaViolation must stay compact");

/// One incremental input from a native codec or recovered text tool channel.
#[derive(Clone, Debug)]
pub enum ToolFragment {
	/// Begins a call. Names may be completed with [`ToolFragment::NameDelta`].
	Start {
		/// Codec-local call index.
		source_index: u32,
		/// Provider call identity, when usable.
		id:           Option<ToolCallId>,
		/// Complete name or an empty prefix.
		name:         Bytes,
		/// Observed wire syntax of the call's argument bytes.
		input_kind:   ToolInputKind,
	},
	/// Appends bytes to the call name and marks the final name fragment.
	NameDelta {
		/// Codec-local call index.
		source_index: u32,
		/// Next name bytes.
		bytes:        Bytes,
		/// Whether these are the final name bytes.
		complete:     bool,
	},
	/// Appends JSON argument bytes.
	ArgumentsDelta {
		/// Codec-local call index.
		source_index: u32,
		/// Exact argument fragment.
		bytes:        Bytes,
	},
	/// Declares that no more fragments belong to the call.
	End {
		/// Codec-local call index.
		source_index: u32,
	},
}

/// Observable output of tool assembly.
#[derive(Clone, Debug)]
pub enum ToolAssemblyEvent {
	/// A partial call became visible but is not executable.
	Started {
		/// Codec-local call index.
		source_index: u32,
		/// Canonical call identity.
		id:           ToolCallId,
		/// Complete declared name.
		name:         Str,
	},
	/// Argument bytes were accepted for display/telemetry only.
	ArgumentsDelta {
		/// Codec-local call index.
		source_index: u32,
		/// Exact accepted fragment.
		bytes:        Bytes,
	},
	/// The complete call is ready for the authoritative typed tool decoder.
	/// Schema-directed charitable repairs have been applied. Structurally
	/// invalid input is represented by a non-object sentinel that every tool
	/// argument boundary rejects before effects.
	Ready {
		/// Codec-local call index.
		source_index: u32,
		/// Sole executable call authorization.
		call:         ToolCall,
	},
	/// The call ended without authorization.
	Rejected {
		/// Codec-local call index.
		source_index: u32,
		/// Deterministic rejection.
		reason:       ToolRejection,
	},
}

#[derive(Debug)]
struct PartialCall {
	id:              ToolCallId,
	name:            BytesMut,
	arguments:       BytesMut,
	input_kind:      ToolInputKind,
	started_emitted: bool,
}

/// Incrementally assembles calls and emits authorization only after validation.
#[derive(Debug)]
pub struct ToolAssembler<'a> {
	definitions:       &'a [ToolDefinition],
	coercions:         &'a [ArgumentCoercionSpec],
	limits:            ToolAssemblyLimits,
	open:              BTreeMap<u32, PartialCall>,
	accepted_calls:    usize,
	next_generated_id: u64,
	evidence:          Vec<RecoveryRecord>,
	attempt:           u32,
}

impl<'a> ToolAssembler<'a> {
	/// Creates an assembler for the declarations in one request.
	pub const fn new(
		definitions: &'a [ToolDefinition],
		limits: ToolAssemblyLimits,
		attempt: u32,
	) -> Self {
		Self {
			definitions,
			coercions: &[],
			limits,
			open: BTreeMap::new(),
			accepted_calls: 0,
			next_generated_id: 1,
			evidence: Vec::new(),
			attempt,
		}
	}

	/// Creates an assembler with explicit path-addressed argument coercions.
	pub const fn with_coercions(
		definitions: &'a [ToolDefinition],
		coercions: &'a [ArgumentCoercionSpec],
		limits: ToolAssemblyLimits,
		attempt: u32,
	) -> Self {
		Self {
			definitions,
			coercions,
			limits,
			open: BTreeMap::new(),
			accepted_calls: 0,
			next_generated_id: 1,
			evidence: Vec::new(),
			attempt,
		}
	}

	/// Applies one fragment and returns the resulting bounded batch.
	pub fn push(&mut self, fragment: ToolFragment) -> Vec<ToolAssemblyEvent> {
		let examined = match &fragment {
			ToolFragment::Start { name, .. } => name.len() as u64,
			ToolFragment::NameDelta { bytes, .. } | ToolFragment::ArgumentsDelta { bytes, .. } => {
				bytes.len() as u64
			},
			ToolFragment::End { source_index } => self
				.open
				.get(source_index)
				.map_or(0, |call| call.name.len().saturating_add(call.arguments.len()) as u64),
		};
		let events = match fragment {
			ToolFragment::Start { source_index, id, name, input_kind } => {
				self.start(source_index, id, name, input_kind)
			},
			ToolFragment::NameDelta { source_index, bytes, complete } => {
				self.name_delta(source_index, bytes, complete)
			},
			ToolFragment::ArgumentsDelta { source_index, bytes } => {
				self.arguments_delta(source_index, bytes)
			},
			ToolFragment::End { source_index } => vec![self.end(source_index)],
		};
		for event in &events {
			if let ToolAssemblyEvent::Rejected { reason, .. } = event {
				self.record(rejection_rule(reason), examined, 1);
			}
		}
		events
	}

	/// Rejects every call still incomplete at end-of-stream.
	pub fn finish(&mut self) -> Vec<ToolAssemblyEvent> {
		let open = mem::take(&mut self.open);
		let mut events = Vec::with_capacity(open.len());
		for (source_index, call) in open {
			self.record(
				"tool.incomplete",
				call.name.len().saturating_add(call.arguments.len()) as u64,
				1,
			);
			events.push(ToolAssemblyEvent::Rejected {
				source_index,
				reason: ToolRejection::MalformedArguments {
					offset: 0,
					reason: sf!("incomplete tool call"),
				},
			});
		}
		events
	}

	/// Drains bounded, secret-free recovery evidence.
	pub fn take_evidence(&mut self) -> Vec<RecoveryRecord> {
		mem::take(&mut self.evidence)
	}

	fn start(
		&mut self,
		source_index: u32,
		id: Option<ToolCallId>,
		name: Bytes,
		input_kind: ToolInputKind,
	) -> Vec<ToolAssemblyEvent> {
		if self.open.contains_key(&source_index) {
			return vec![ToolAssemblyEvent::Rejected {
				source_index,
				reason: ToolRejection::ConflictingStart,
			}];
		}
		if self.open.len() >= self.limits.max_open_calls {
			return vec![ToolAssemblyEvent::Rejected {
				source_index,
				reason: ToolRejection::LimitExceeded {
					field: "open calls",
					limit: self.limits.max_open_calls,
				},
			}];
		}
		if self.accepted_calls >= self.limits.max_total_calls {
			return vec![ToolAssemblyEvent::Rejected {
				source_index,
				reason: ToolRejection::LimitExceeded {
					field: "total calls",
					limit: self.limits.max_total_calls,
				},
			}];
		}
		if name.len() > self.limits.max_name_bytes {
			return vec![ToolAssemblyEvent::Rejected {
				source_index,
				reason: ToolRejection::LimitExceeded {
					field: "name",
					limit: self.limits.max_name_bytes,
				},
			}];
		}
		let id = id
			.filter(|id| !id.as_str().trim().is_empty())
			.unwrap_or_else(|| {
				let generated = ToolCallId::new(format!("recovered-tool-{}", self.next_generated_id));
				self.next_generated_id += 1;
				generated
			});
		let complete_name = decode_utf8(&name)
			.filter(|value| !value.is_empty())
			.map(Str::new);
		self.open.insert(source_index, PartialCall {
			id: id.clone(),
			name: BytesMut::from(name.as_ref()),
			arguments: BytesMut::new(),
			input_kind,
			started_emitted: complete_name.is_some(),
		});
		self.accepted_calls = self.accepted_calls.saturating_add(1);
		complete_name
			.map_or_else(Vec::new, |name| vec![ToolAssemblyEvent::Started { source_index, id, name }])
	}

	fn name_delta(
		&mut self,
		source_index: u32,
		bytes: Bytes,
		complete: bool,
	) -> Vec<ToolAssemblyEvent> {
		let Some(call) = self.open.get_mut(&source_index) else {
			return vec![ToolAssemblyEvent::Rejected {
				source_index,
				reason: ToolRejection::UnknownCall,
			}];
		};
		if call.name.len().saturating_add(bytes.len()) > self.limits.max_name_bytes {
			self.open.remove(&source_index);
			return vec![ToolAssemblyEvent::Rejected {
				source_index,
				reason: ToolRejection::LimitExceeded {
					field: "name",
					limit: self.limits.max_name_bytes,
				},
			}];
		}
		call.name.extend_from_slice(&bytes);
		if !complete {
			return Vec::new();
		}
		if call.started_emitted {
			return Vec::new();
		}
		let Some(name) = decode_utf8(&call.name) else {
			return Vec::new();
		};
		if name.is_empty() {
			return Vec::new();
		}
		call.started_emitted = true;
		vec![ToolAssemblyEvent::Started { source_index, id: call.id.clone(), name: Str::new(name) }]
	}

	fn arguments_delta(&mut self, source_index: u32, bytes: Bytes) -> Vec<ToolAssemblyEvent> {
		let Some(call) = self.open.get_mut(&source_index) else {
			return vec![ToolAssemblyEvent::Rejected {
				source_index,
				reason: ToolRejection::UnknownCall,
			}];
		};
		if call.arguments.len().saturating_add(bytes.len()) > self.limits.max_argument_bytes {
			self.open.remove(&source_index);
			return vec![ToolAssemblyEvent::Rejected {
				source_index,
				reason: ToolRejection::LimitExceeded {
					field: "arguments",
					limit: self.limits.max_argument_bytes,
				},
			}];
		}
		call.arguments.extend_from_slice(&bytes);
		vec![ToolAssemblyEvent::ArgumentsDelta { source_index, bytes }]
	}

	fn end(&mut self, source_index: u32) -> ToolAssemblyEvent {
		let Some(call) = self.open.remove(&source_index) else {
			return ToolAssemblyEvent::Rejected { source_index, reason: ToolRejection::UnknownCall };
		};
		let Some(name) = decode_utf8(&call.name) else {
			return ToolAssemblyEvent::Rejected { source_index, reason: ToolRejection::InvalidName };
		};
		let Some(definition) = self
			.definitions
			.iter()
			.find(|definition| definition.name.as_str() == name)
		else {
			return ToolAssemblyEvent::Rejected { source_index, reason: ToolRejection::InvalidName };
		};
		let arguments = match call.input_kind {
			ToolInputKind::Json => {
				// A grammar declaration lowered by a schema-only transport
				// arrives as ordinary JSON conforming to its fallback schema.
				let (parameters, strict) = match &definition.input {
					ToolInputConstraint::JsonSchema { parameters, strict } => (parameters, *strict),
					ToolInputConstraint::Grammar { fallback, .. } => {
						self.record("tool.grammar-fallback-arguments", call.arguments.len() as u64, 1);
						(fallback, false)
					},
				};
				let arguments: Value = match parse_repaired_value(&call.arguments, JsonRepairLimits {
					max_bytes:        self.limits.max_argument_bytes,
					max_depth:        self.limits.max_schema_depth,
					max_steps:        self.limits.max_repair_steps,
					diagnostic_bytes: 128,
				}) {
					Ok((arguments, repairs)) => {
						if repairs > 0 {
							self.record(
								"tool.tolerant-argument-repair",
								call.arguments.len() as u64,
								repairs,
							);
						}
						arguments
					},
					Err(error @ RecoveryError::LimitExceeded { .. }) => {
						return ToolAssemblyEvent::Rejected {
							source_index,
							reason: ToolRejection::MalformedArguments {
								offset: 0,
								reason: Str::new(error.to_string()),
							},
						};
					},
					Err(_) => {
						self.record("tool.argument-decode-failure", call.arguments.len() as u64, 1);
						Value::Null
					},
				};
				let (arguments, schema_valid) = match repair_schema_arguments(
					parameters.as_value(),
					&arguments,
					strict,
					self.limits,
					self.coercions,
				) {
					Ok((arguments, repairs)) => {
						if repairs > 0 {
							self.record(
								"tool.schema-directed-argument-repair",
								call.arguments.len() as u64,
								repairs,
							);
						}
						(arguments, true)
					},
					Err((arguments, _reason, repairs)) => {
						if repairs > 0 {
							self.record(
								"tool.schema-directed-argument-repair",
								call.arguments.len() as u64,
								repairs,
							);
						}
						match normalize_flattened_arguments(&arguments).filter(|rebuilt| {
							validate_schema(parameters.as_value(), rebuilt, strict, self.limits).is_ok()
						}) {
							Some(rebuilt) => {
								self.record(
									"tool.flattened-array-arguments",
									call.arguments.len() as u64,
									1,
								);
								(rebuilt, true)
							},
							None => (arguments, false),
						}
					},
				};
				self.record(
					if schema_valid {
						"tool.complete-schema-valid"
					} else {
						"tool.complete-schema-invalid"
					},
					call.arguments.len() as u64,
					1,
				);
				arguments
			},
			ToolInputKind::Freeform => {
				let Ok(arguments) = str::from_utf8(&call.arguments) else {
					return ToolAssemblyEvent::Rejected {
						source_index,
						reason: ToolRejection::MalformedArguments {
							offset: 0,
							reason: sf!("freeform tool input is not UTF-8"),
						},
					};
				};
				// Canonicalize freeform text into the schema's `input` property
				// so journaled calls, history re-encoding, and argument decoding
				// all see the one object shape regardless of wire form.
				let wrapped = Value::Object(serde_json::Map::from_iter([(
					FREEFORM_INPUT_PROPERTY.to_owned(),
					Value::String(arguments.to_owned()),
				)]));
				let (schema, _) = definition.input.wire_schema();
				if let Err(reason) = validate_schema(schema.as_value(), &wrapped, false, self.limits) {
					return ToolAssemblyEvent::Rejected {
						source_index,
						reason: ToolRejection::SchemaViolation(reason),
					};
				}
				self.record("tool.complete-freeform-valid", call.arguments.len() as u64, 1);
				wrapped
			},
		};
		ToolAssemblyEvent::Ready {
			source_index,
			call: ToolCall {
				id:        call.id,
				name:      Str::new(name),
				arguments: OpaqueJson::new(arguments),
			},
		}
	}

	fn record(&mut self, rule: &'static str, input_bytes: u64, steps: u32) {
		if self.evidence.len() < self.limits.max_evidence {
			self.evidence.push(RecoveryRecord {
				attempt: self.attempt,
				kind: RecoveryKind::ToolAssembly,
				rule: ReasonId(Str::new(rule)),
				input_bytes,
				steps,
			});
		}
	}
}

const fn rejection_rule(rejection: &ToolRejection) -> &'static str {
	match rejection {
		ToolRejection::UnknownCall => "tool.unknown-call",
		ToolRejection::LimitExceeded { .. } => "tool.limit-exceeded",
		ToolRejection::InvalidName => "tool.invalid-name",
		ToolRejection::MalformedArguments { .. } => "tool.malformed-arguments",
		ToolRejection::SchemaViolation(_) => "tool.schema-violation",
		ToolRejection::ConflictingStart => "tool.conflicting-start",
	}
}

impl Stage<ToolFragment, ToolAssemblyEvent> for ToolAssembler<'_> {
	fn push(
		&mut self,
		input: ToolFragment,
		emit: &mut dyn FnMut(ToolAssemblyEvent),
	) -> Result<(), RecoveryError> {
		for event in ToolAssembler::push(self, input) {
			emit(event);
		}
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(ToolAssemblyEvent)) -> Result<(), RecoveryError> {
		for event in ToolAssembler::finish(self) {
			emit(event);
		}
		Ok(())
	}
}

/// Validates arguments against the deterministic supported JSON Schema subset.
pub fn validate_schema(
	schema: &Value,
	instance: &Value,
	strict: bool,
	limits: ToolAssemblyLimits,
) -> Result<(), SchemaViolation> {
	let mut budget = limits.max_schema_nodes;
	validate_node(schema, instance, "", strict, 0, limits.max_schema_depth, &mut budget)
}
/// Applies schema-preserving repairs plus only the explicitly declared type
/// coercions.
pub fn repair_schema_arguments(
	schema: &Value,
	instance: &Value,
	strict: bool,
	limits: ToolAssemblyLimits,
	coercions: &[ArgumentCoercionSpec],
) -> Result<(Value, u32), (Value, SchemaViolation, u32)> {
	let mut repaired = instance.clone();
	let mut repairs = 0_u32;
	loop {
		match validate_schema(schema, &repaired, strict, limits) {
			Ok(()) => return Ok((repaired, repairs)),
			Err(issue)
				if repairs < 16
					&& apply_schema_repair(&mut repaired, &issue, declared_at(coercions, &issue)) =>
			{
				repairs = repairs.saturating_add(1);
			},
			Err(issue) => return Err((repaired, issue, repairs)),
		}
	}
}

fn declared_at<'a>(
	coercions: &'a [ArgumentCoercionSpec],
	issue: &SchemaViolation,
) -> &'a [ArgumentCoercion] {
	coercions
		.iter()
		.find(|spec| spec.path == issue.path)
		.map_or(&[], |spec| spec.coercions.as_ref())
}

fn apply_schema_repair(
	instance: &mut Value,
	issue: &SchemaViolation,
	declared: &[ArgumentCoercion],
) -> bool {
	// Charitable decoding: models routinely emit stray arguments; under a
	// strict schema one unknown key would fail the whole call, so drop it and
	// keep the invocation alive. Union-branch violations are exempt — there a
	// "stray" member is evidence the model meant a different branch, and
	// removal would corrupt that shape. Post-repair arguments are the
	// journaled canonical document, so replay sees exactly what executed.
	if issue.rule == "additionalProperties" {
		return !issue.from_union_branch && remove_pointer(instance, issue.path.as_str());
	}
	if issue.rule != "type" {
		return false;
	}
	// Type-changing repairs are never inferred from the target schema type.
	// The exact argument path must opt in using the same stable coercion
	// declarations as the authoritative typed argument decoder.
	let Some(value) = pointer_mut(instance, issue.path.as_str()) else {
		return false;
	};
	if let Value::String(text) = value {
		let trimmed = text.trim();
		if declared.contains(&ArgumentCoercion::JsonString)
			&& (trimmed.starts_with('{') || trimmed.starts_with('['))
			&& let Ok(parsed) = serde_json::from_str::<Value>(trimmed)
			&& issue
				.expected_types
				.iter()
				.any(|kind| matches_type(&parsed, kind))
		{
			*value = parsed;
			return true;
		}
		if declared.contains(&ArgumentCoercion::LooseBool)
			&& issue
				.expected_types
				.iter()
				.any(|kind| kind.as_str() == "boolean")
		{
			let parsed = match trimmed {
				"true" | "yes" | "1" => Some(true),
				"false" | "no" | "0" => Some(false),
				_ => None,
			};
			if let Some(parsed) = parsed {
				*value = Value::Bool(parsed);
				return true;
			}
		}
		if declared.contains(&ArgumentCoercion::Integer)
			&& issue
				.expected_types
				.iter()
				.any(|kind| kind.as_str() == "integer")
			&& let Ok(parsed) = trimmed.parse::<i64>()
		{
			*value = Value::from(parsed);
			return true;
		}
		if declared.contains(&ArgumentCoercion::Number)
			&& issue
				.expected_types
				.iter()
				.any(|kind| kind.as_str() == "number")
		{
			// "300" repairs to the integer 300, not 300.0 — schema "number"
			// admits both and integer keeps the value's spelled fidelity.
			if let Ok(parsed) = trimmed.parse::<i64>() {
				*value = Value::from(parsed);
				return true;
			}
			if let Ok(parsed) = trimmed.parse::<f64>()
				&& let Some(parsed) = serde_json::Number::from_f64(parsed)
			{
				*value = Value::Number(parsed);
				return true;
			}
		}
	}
	if declared.contains(&ArgumentCoercion::String)
		&& issue
			.expected_types
			.iter()
			.any(|kind| kind.as_str() == "string")
		&& !matches!(value, Value::String(_))
	{
		if matches!(value, Value::Array(_) | Value::Object(_)) && issue.from_union_branch {
			return false;
		}
		*value = Value::String(value.to_string());
		return true;
	}
	if declared.contains(&ArgumentCoercion::Singleton)
		&& issue
			.expected_types
			.iter()
			.any(|kind| kind.as_str() == "array")
		&& !matches!(value, Value::Array(_))
		&& !issue.from_union_branch
	{
		*value = Value::Array(vec![value.clone()]);
		return true;
	}
	false
}

fn pointer_mut<'a>(instance: &'a mut Value, path: &str) -> Option<&'a mut Value> {
	if path == "/" {
		Some(instance)
	} else {
		instance.pointer_mut(path)
	}
}
/// Removes the member or element addressed by a JSON pointer; `true` only
/// when something was actually removed.
fn remove_pointer(instance: &mut Value, path: &str) -> bool {
	let Some((parent, leaf)) = path.rsplit_once('/') else {
		return false;
	};
	let parent = if parent.is_empty() { "/" } else { parent };
	let Some(parent) = pointer_mut(instance, parent) else {
		return false;
	};
	let leaf = leaf.replace("~1", "/").replace("~0", "~");
	match parent {
		Value::Object(members) => members.shift_remove(leaf.as_str()).is_some(),
		Value::Array(elements) => {
			let Ok(index) = leaf.parse::<usize>() else {
				return false;
			};
			if index >= elements.len() {
				return false;
			}
			elements.remove(index);
			true
		},
		_ => false,
	}
}

fn validate_node(
	schema: &Value,
	value: &Value,
	path: &str,
	strict: bool,
	depth: usize,
	max_depth: usize,
	budget: &mut usize,
) -> Result<(), SchemaViolation> {
	if depth > max_depth {
		return violation(path, "maxDepth");
	}
	if *budget == 0 {
		return violation(path, "maxNodes");
	}
	*budget -= 1;
	if let Some(boolean) = schema.as_bool() {
		return if boolean {
			Ok(())
		} else {
			violation(path, "falseSchema")
		};
	}
	let Some(object) = schema.as_object() else {
		return violation(path, "schemaType");
	};
	if let Some(constant) = object.get("const")
		&& value != constant
	{
		return violation(path, "const");
	}
	if let Some(values) = object.get("enum").and_then(Value::as_array)
		&& !values.contains(value)
	{
		return violation(path, "enum");
	}
	if let Some(types) = object.get("type") {
		let valid = match types {
			Value::String(kind) => matches_type(value, kind),
			Value::Array(kinds) => kinds
				.iter()
				.filter_map(Value::as_str)
				.any(|kind| matches_type(value, kind)),
			_ => false,
		};
		if !valid {
			let expected_types = match types {
				Value::String(kind) => iter::once(Str::new(kind.as_str())).collect(),
				Value::Array(kinds) => kinds
					.iter()
					.filter_map(Value::as_str)
					.map(Str::new)
					.collect(),
				_ => Box::default(),
			};
			return type_violation(path, expected_types);
		}
	}
	if let Some(all) = object.get("allOf").and_then(Value::as_array) {
		for schema in all {
			validate_node(schema, value, path, strict, depth + 1, max_depth, budget)?;
		}
	}
	if let Some(any) = object.get("anyOf").and_then(Value::as_array) {
		let mut matched = false;
		let mut first_issue = None;
		let mut selected_issue = None;
		let mut selected_count = 0_u32;
		for branch in any {
			let mut branch_budget = *budget;
			let result =
				validate_node(branch, value, path, strict, depth + 1, max_depth, &mut branch_budget);
			let consumed = (*budget).saturating_sub(branch_budget);
			*budget = (*budget).saturating_sub(consumed);
			match result {
				Ok(()) => {
					matched = true;
					break;
				},
				Err(issue) => {
					if first_issue.is_none() {
						first_issue = Some(issue.clone());
					}
					if is_tag_selected_branch(branch, value) {
						selected_count = selected_count.saturating_add(1);
						if selected_count == 1 {
							selected_issue = Some(issue);
						}
					}
				},
			}
		}
		if !matched {
			if selected_count == 1
				&& let Some(issue) = selected_issue
			{
				return Err(issue);
			}
			if let Some(mut issue) = first_issue {
				issue.from_union_branch = true;
				return Err(issue);
			}
			return violation(path, "anyOf");
		}
	}
	if let Some(one) = object.get("oneOf").and_then(Value::as_array) {
		let mut matches = 0_u32;
		let mut first_issue = None;
		let mut selected_issue = None;
		let mut selected_count = 0_u32;
		for branch in one {
			let mut branch_budget = *budget;
			let result =
				validate_node(branch, value, path, strict, depth + 1, max_depth, &mut branch_budget);
			let consumed = (*budget).saturating_sub(branch_budget);
			*budget = (*budget).saturating_sub(consumed);
			match result {
				Ok(()) => matches = matches.saturating_add(1),
				Err(issue) => {
					if first_issue.is_none() {
						first_issue = Some(issue.clone());
					}
					if is_tag_selected_branch(branch, value) {
						selected_count = selected_count.saturating_add(1);
						if selected_count == 1 {
							selected_issue = Some(issue);
						}
					}
				},
			}
		}
		if matches != 1 {
			if matches == 0
				&& selected_count == 1
				&& let Some(issue) = selected_issue
			{
				return Err(issue);
			}
			if matches == 0
				&& let Some(mut issue) = first_issue
			{
				issue.from_union_branch = true;
				return Err(issue);
			}
			return violation(path, "oneOf");
		}
	}
	if let Some(properties) = value.as_object() {
		if let Some(required) = object.get("required").and_then(Value::as_array) {
			for key in required.iter().filter_map(Value::as_str) {
				if !properties.contains_key(key) {
					return violation(&child_path(path, key), "required");
				}
			}
		}
		let declared = object.get("properties").and_then(Value::as_object);
		for (key, item) in properties {
			if let Some(property_schema) = declared.and_then(|schemas| schemas.get(key)) {
				validate_node(
					property_schema,
					item,
					&child_path(path, key),
					strict,
					depth + 1,
					max_depth,
					budget,
				)?;
			} else if object.get("additionalProperties") == Some(&Value::Bool(false)) {
				return violation(&child_path(path, key), "additionalProperties");
			} else if let Some(extra_schema) = object
				.get("additionalProperties")
				.filter(|schema| schema.is_object())
			{
				validate_node(
					extra_schema,
					item,
					&child_path(path, key),
					strict,
					depth + 1,
					max_depth,
					budget,
				)?;
			}
		}
		if let Some(min) = object.get("minProperties").and_then(Value::as_u64)
			&& properties.len() < min as usize
		{
			return violation(path, "minProperties");
		}
		if let Some(max) = object.get("maxProperties").and_then(Value::as_u64)
			&& properties.len() > max as usize
		{
			return violation(path, "maxProperties");
		}
	}
	if let Some(items) = value.as_array() {
		if let Some(item_schema) = object.get("items") {
			for (index, item) in items.iter().enumerate() {
				validate_node(
					item_schema,
					item,
					&child_path(path, &index.to_string()),
					strict,
					depth + 1,
					max_depth,
					budget,
				)?;
			}
		}
		if let Some(min) = object.get("minItems").and_then(Value::as_u64)
			&& items.len() < min as usize
		{
			return violation(path, "minItems");
		}
		if let Some(max) = object.get("maxItems").and_then(Value::as_u64)
			&& items.len() > max as usize
		{
			return violation(path, "maxItems");
		}
		if object.get("uniqueItems") == Some(&Value::Bool(true)) {
			for (index, item) in items.iter().enumerate() {
				if items[..index].contains(item) {
					return violation(path, "uniqueItems");
				}
			}
		}
	}
	if let Some(text) = value.as_str() {
		let length = unicode_scalar_count(text);
		if let Some(min) = object.get("minLength").and_then(Value::as_u64)
			&& length < min as usize
		{
			return violation(path, "minLength");
		}
		if let Some(max) = object.get("maxLength").and_then(Value::as_u64)
			&& length > max as usize
		{
			return violation(path, "maxLength");
		}
	}
	if let Some(number) = value.as_f64() {
		if let Some(min) = object.get("minimum").and_then(Value::as_f64)
			&& number < min
		{
			return violation(path, "minimum");
		}
		if let Some(max) = object.get("maximum").and_then(Value::as_f64)
			&& number > max
		{
			return violation(path, "maximum");
		}
		if let Some(min) = object.get("exclusiveMinimum").and_then(Value::as_f64)
			&& number <= min
		{
			return violation(path, "exclusiveMinimum");
		}
		if let Some(max) = object.get("exclusiveMaximum").and_then(Value::as_f64)
			&& number >= max
		{
			return violation(path, "exclusiveMaximum");
		}
	}
	if strict
		&& object
			.keys()
			.any(|key| !STRICT_KEYWORDS.contains(&key.as_str()))
	{
		return violation(path, "unsupportedKeyword");
	}
	Ok(())
}

/// Every keyword strict validation understands or deliberately treats as a
/// pure annotation (`format` is annotation-only vocabulary in JSON Schema
/// 2020-12). Any other keyword makes strict validation unsound, so
/// [`validate_node`] rejects it and [`schema_within_strict_subset`] reports
/// the schema as outside the subset.
const STRICT_KEYWORDS: &[&str] = &[
	"$id",
	"$schema",
	"$comment",
	"title",
	"description",
	"default",
	"examples",
	"format",
	"type",
	"const",
	"enum",
	"allOf",
	"anyOf",
	"oneOf",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
];

/// Reports whether every reachable node of `schema` stays within the strict
/// validation subset enforced by [`validate_schema`].
///
/// Registries consult this before lowering a tool as `strict: true`: a schema
/// using keywords the validator cannot assert (`if`/`then`, `not`, `$ref`,
/// `patternProperties`, …) would otherwise reject every call at runtime the
/// moment the offending node is visited.
pub fn schema_within_strict_subset(schema: &Value, limits: ToolAssemblyLimits) -> bool {
	let mut budget = limits.max_schema_nodes;
	subset_node(schema, 0, limits.max_schema_depth, &mut budget)
}

fn subset_node(schema: &Value, depth: usize, max_depth: usize, budget: &mut usize) -> bool {
	if depth > max_depth || *budget == 0 {
		return false;
	}
	*budget -= 1;
	if schema.is_boolean() {
		return true;
	}
	let Some(object) = schema.as_object() else {
		return false;
	};
	if object
		.keys()
		.any(|key| !STRICT_KEYWORDS.contains(&key.as_str()))
	{
		return false;
	}
	if let Some(properties) = object.get("properties") {
		let Some(properties) = properties.as_object() else {
			return false;
		};
		if !properties
			.values()
			.all(|property| subset_node(property, depth + 1, max_depth, budget))
		{
			return false;
		}
	}
	if let Some(extra) = object.get("additionalProperties")
		&& !extra.is_boolean()
		&& !subset_node(extra, depth + 1, max_depth, budget)
	{
		return false;
	}
	if let Some(items) = object.get("items")
		&& !subset_node(items, depth + 1, max_depth, budget)
	{
		return false;
	}
	for combinator in ["allOf", "anyOf", "oneOf"] {
		if let Some(branches) = object.get(combinator) {
			let Some(branches) = branches.as_array() else {
				return false;
			};
			if !branches
				.iter()
				.all(|branch| subset_node(branch, depth + 1, max_depth, budget))
			{
				return false;
			}
		}
	}
	true
}

fn unicode_scalar_count(text: &str) -> usize {
	let mut reader = Cursor::new(text.as_bytes());
	reader.chars().filter_map(Result::ok).count()
}

fn decode_utf8(bytes: &[u8]) -> Option<String> {
	let mut reader = Cursor::new(bytes);
	reader.chars().collect::<Result<String, _>>().ok()
}

fn matches_type(value: &Value, kind: &str) -> bool {
	match kind {
		"null" => value.is_null(),
		"boolean" => value.is_boolean(),
		"object" => value.is_object(),
		"array" => value.is_array(),
		"number" => value.is_number(),
		"integer" => {
			value.as_i64().is_some()
				|| value.as_u64().is_some()
				|| value.as_f64().is_some_and(|number| number.fract() == 0.0)
		},
		"string" => value.is_string(),
		_ => false,
	}
}

fn is_tag_selected_branch(branch: &Value, value: &Value) -> bool {
	let (Some(branch), Some(value)) = (branch.as_object(), value.as_object()) else {
		return false;
	};
	let Some(properties) = branch.get("properties").and_then(Value::as_object) else {
		return false;
	};
	let mut matched = false;
	for (key, property) in properties {
		let Some(property) = property.as_object() else {
			continue;
		};
		let constant = property.get("const");
		let variants = property.get("enum").and_then(Value::as_array);
		if constant.is_none() && variants.is_none() {
			continue;
		}
		let Some(candidate) = value.get(key) else {
			return false;
		};
		if let Some(constant) = constant {
			if candidate != constant {
				return false;
			}
		} else if variants.is_some_and(|variants| !variants.contains(candidate)) {
			return false;
		}
		matched = true;
	}
	matched
}

fn type_violation<T>(path: &str, expected_types: Box<[Str]>) -> Result<T, SchemaViolation> {
	Err(SchemaViolation {
		path: Str::new(if path.is_empty() { "/" } else { path }),
		rule: "type",
		expected_types,
		from_union_branch: false,
	})
}

fn child_path(parent: &str, child: &str) -> String {
	format!("{parent}/{}", child.replace('~', "~0").replace('/', "~1"))
}
fn violation<T>(path: &str, rule: &'static str) -> Result<T, SchemaViolation> {
	Err(SchemaViolation {
		path: Str::new(if path.is_empty() { "/" } else { path }),
		rule,
		expected_types: Box::default(),
		from_union_branch: false,
	})
}

// ============================================================================
// Flattened array-argument normalization (LLM quirk).
//
// Some providers (notably Gemini) serialize array tool arguments using
// flattened property paths — `questions[0].id`, `questions[0].options[0].label`
// — instead of a nested `questions` array of objects. The schema sees only
// unrecognized extra keys and rejects the call, so `end` rebuilds the nested
// structure and re-validates before rejecting.
//
// Conservative by design:
//   - runs only after plain validation has already failed;
//   - fires only when at least one key is a well-formed array-index path
//     (`name[i]`, `name[i].prop`, `name[i][j]`); plain keys and non-array
//     dotted keys (`a.b`) never match;
//   - aborts wholesale (`None`) on any shape conflict so genuine schema
//     mistakes still surface as validation errors;
//   - array indices and path depth are capped so a hostile payload cannot
//     allocate oversized arrays or overflow the rebuild recursion.
// ============================================================================

/// Cap on array indices accepted by the flattened-path parser.
const MAX_FLATTENED_INDEX: u64 = 100_000;
/// Cap on build steps per key, aligned with the default schema-depth bound.
const MAX_FLATTENED_STEPS: usize = 64;

/// One parsed step of a flattened argument key such as `questions[0].id`.
#[derive(Clone, Copy)]
enum FlattenedStep<'a> {
	/// Descend into an object property.
	Prop(&'a str),
	/// Descend into an array element.
	Index(usize),
}

/// Partially rebuilt argument tree. `Hole` marks an array slot created by a
/// larger sibling index and never written: descending into one vivifies a
/// fresh container, while descending into an explicit JSON `null` aborts.
enum FlattenedNode {
	/// Unwritten array slot; serializes to `null`.
	Hole,
	/// A JSON value adopted verbatim from a leaf write or a plain sibling key.
	Value(Value),
	/// An object under reconstruction, in first-seen key order.
	Object(Vec<(String, Self)>),
	/// An array under reconstruction.
	Array(Vec<Self>),
}

impl FlattenedNode {
	fn into_value(self) -> Value {
		match self {
			Self::Hole => Value::Null,
			Self::Value(value) => value,
			Self::Object(entries) => Value::Object(
				entries
					.into_iter()
					.map(|(key, node)| (key, node.into_value()))
					.collect(),
			),
			Self::Array(items) => Value::Array(items.into_iter().map(Self::into_value).collect()),
		}
	}
}

const fn is_flattened_ident_start(byte: u8) -> bool {
	byte == b'_' || byte == b'$' || byte.is_ascii_alphabetic()
}
const fn is_flattened_ident_continue(byte: u8) -> bool {
	is_flattened_ident_start(byte) || byte.is_ascii_digit()
}

/// Parses one flattened array-path key into build steps. Returns `None` for
/// keys that are not flattened array paths: no `[<digits>]` index anywhere
/// (`questions`, `a.b`), a malformed or non-numeric index (`foo[bar]`), an
/// index-first path (`[0].x`), or an index outside the safety cap.
fn parse_flattened_path(key: &str) -> Option<Vec<FlattenedStep<'_>>> {
	let bytes = key.as_bytes();
	// The path must start with a property name so `[0].x` / `[0]` are left
	// alone.
	if bytes.is_empty() || !is_flattened_ident_start(bytes[0]) {
		return None;
	}
	let mut end = 1;
	while end < bytes.len() && is_flattened_ident_continue(bytes[end]) {
		end += 1;
	}
	let mut steps = vec![FlattenedStep::Prop(&key[..end])];
	let mut pos = end;
	let mut saw_index = false;
	while pos < bytes.len() {
		if steps.len() >= MAX_FLATTENED_STEPS {
			return None;
		}
		match bytes[pos] {
			b'.' => {
				pos += 1;
				if pos >= bytes.len() || !is_flattened_ident_start(bytes[pos]) {
					return None;
				}
				let start = pos;
				pos += 1;
				while pos < bytes.len() && is_flattened_ident_continue(bytes[pos]) {
					pos += 1;
				}
				steps.push(FlattenedStep::Prop(&key[start..pos]));
			},
			b'[' => {
				pos += 1;
				let start = pos;
				while pos < bytes.len() && bytes[pos].is_ascii_digit() {
					pos += 1;
				}
				if pos == start || pos >= bytes.len() || bytes[pos] != b']' {
					return None;
				}
				let index: u64 = key[start..pos].parse().ok()?;
				if index > MAX_FLATTENED_INDEX {
					return None;
				}
				steps.push(FlattenedStep::Index(index as usize));
				saw_index = true;
				pos += 1;
			},
			// Any other character (lone `[foo]`, whitespace, invalid ident
			// bytes) is not a flattened array path.
			_ => return None,
		}
	}
	saw_index.then_some(steps)
}

/// Writes `value` into the container `node` along `steps`. Returns `false`
/// when an existing node contradicts the path; the caller then abandons the
/// whole rebuild so the ambiguity surfaces as a validation error.
fn build_flattened_path(
	node: &mut FlattenedNode,
	steps: &[FlattenedStep<'_>],
	value: Value,
) -> bool {
	let Some((step, rest)) = steps.split_first() else {
		return false;
	};
	match *step {
		FlattenedStep::Prop(name) => {
			// Adopt an object copied from a plain sibling key.
			if matches!(node, FlattenedNode::Value(Value::Object(_))) {
				let FlattenedNode::Value(Value::Object(map)) = mem::replace(node, FlattenedNode::Hole)
				else {
					unreachable!("matched object value");
				};
				*node = FlattenedNode::Object(
					map.into_iter()
						.map(|(key, entry)| (key, FlattenedNode::Value(entry)))
						.collect(),
				);
			}
			let FlattenedNode::Object(entries) = node else {
				return false;
			};
			let slot = if let Some(position) = entries.iter().position(|(key, _)| key == name) {
				&mut entries[position].1
			} else {
				entries.push((name.to_owned(), FlattenedNode::Hole));
				&mut entries.last_mut().expect("entry just pushed").1
			};
			write_flattened_slot(slot, rest, value)
		},
		FlattenedStep::Index(index) => {
			// Adopt an array copied from a plain sibling key.
			if matches!(node, FlattenedNode::Value(Value::Array(_))) {
				let FlattenedNode::Value(Value::Array(items)) = mem::replace(node, FlattenedNode::Hole)
				else {
					unreachable!("matched array value");
				};
				*node = FlattenedNode::Array(items.into_iter().map(FlattenedNode::Value).collect());
			}
			let FlattenedNode::Array(items) = node else {
				return false;
			};
			if items.len() <= index {
				items.resize_with(index + 1, || FlattenedNode::Hole);
			}
			write_flattened_slot(&mut items[index], rest, value)
		},
	}
}

/// Fills one selected slot: a leaf write overwrites unconditionally, while a
/// deeper path requires the slot to hold (or vivify into) a container whose
/// kind matches the next step.
fn write_flattened_slot(
	slot: &mut FlattenedNode,
	rest: &[FlattenedStep<'_>],
	value: Value,
) -> bool {
	let Some(next) = rest.first() else {
		*slot = FlattenedNode::Value(value);
		return true;
	};
	let next_is_array = matches!(next, FlattenedStep::Index(_));
	match slot {
		FlattenedNode::Hole => {
			*slot = if next_is_array {
				FlattenedNode::Array(Vec::new())
			} else {
				FlattenedNode::Object(Vec::new())
			};
		},
		FlattenedNode::Object(_) | FlattenedNode::Value(Value::Object(_)) if !next_is_array => {},
		FlattenedNode::Array(_) | FlattenedNode::Value(Value::Array(_)) if next_is_array => {},
		_ => return false,
	}
	build_flattened_path(slot, rest, value)
}

/// Rebuilds nested arrays/objects from provider-flattened property paths.
/// Returns `None` when no key is a flattened array path or when any shape
/// conflict makes the rebuild ambiguous.
fn normalize_flattened_arguments(arguments: &Value) -> Option<Value> {
	let source = arguments.as_object()?;
	let mut root = FlattenedNode::Object(Vec::with_capacity(source.len()));
	let mut changed = false;
	for (key, entry) in source {
		let Some(steps) = parse_flattened_path(key) else {
			let FlattenedNode::Object(entries) = &mut root else {
				unreachable!("root stays an object");
			};
			// A plain key colliding with an already-built path is ambiguous —
			// bail to the failure path so genuine schema mistakes surface.
			if entries.iter().any(|(name, _)| name == key) {
				return None;
			}
			entries.push((key.clone(), FlattenedNode::Value(entry.clone())));
			continue;
		};
		if !build_flattened_path(&mut root, &steps, entry.clone()) {
			return None;
		}
		changed = true;
	}
	changed.then(|| root.into_value())
}

/// Origin of a purported tool result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolResultSource {
	/// Supplied by the caller/tool executor.
	Caller,
	/// Appeared in model-generated output and is therefore fabricated.
	ModelOutput,
}

/// Outcome of pairing one result to an authorized call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolPairing {
	/// The supplied identifier matched an outstanding authorized call.
	Paired(ToolCallId),
	/// A missing identifier was repaired because exactly one call was
	/// outstanding.
	Repaired(ToolCallId),
	/// The result is fabricated, duplicate, ambiguous, or references an unknown
	/// call.
	RejectedFabricated,
}

/// Outcome of registering one ready call for later result pairing.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolRegistration {
	/// Call identity was registered.
	Registered,
	/// Call identity was already outstanding or completed.
	Duplicate,
	/// The configured total-call bound was reached.
	LimitExceeded,
}

/// Tracks authorized calls and deterministically pairs caller-supplied results.
#[derive(Debug)]
pub struct ToolResultPairer {
	outstanding: BTreeSet<ToolCallId>,
	completed:   BTreeSet<ToolCallId>,
	max_calls:   usize,
}

impl Default for ToolResultPairer {
	fn default() -> Self {
		Self::new(128)
	}
}

impl ToolResultPairer {
	/// Creates a pairer with a hard total-call bound.
	pub const fn new(max_calls: usize) -> Self {
		Self { outstanding: BTreeSet::new(), completed: BTreeSet::new(), max_calls }
	}

	/// Registers one validated ready call, rejecting duplicate identities and
	/// overflow.
	pub fn register_ready(&mut self, call: &ToolCall) -> ToolRegistration {
		if self.completed.contains(&call.id) || self.outstanding.contains(&call.id) {
			return ToolRegistration::Duplicate;
		}
		if self.outstanding.len().saturating_add(self.completed.len()) >= self.max_calls {
			return ToolRegistration::LimitExceeded;
		}
		self.outstanding.insert(call.id.clone());
		ToolRegistration::Registered
	}

	/// Pairs a result without ever treating model-authored results as trusted.
	pub fn pair(&mut self, id: Option<&ToolCallId<str>>, source: ToolResultSource) -> ToolPairing {
		if source == ToolResultSource::ModelOutput {
			return ToolPairing::RejectedFabricated;
		}
		let (id, repaired) = match id {
			Some(id) if self.outstanding.contains(id) => (id.to_owned(), false),
			Some(_) => return ToolPairing::RejectedFabricated,
			None if self.outstanding.len() == 1 => (
				self
					.outstanding
					.iter()
					.next()
					.expect("length checked")
					.clone(),
				true,
			),
			None => return ToolPairing::RejectedFabricated,
		};
		self.outstanding.remove(&id);
		self.completed.insert(id.clone());
		if repaired {
			ToolPairing::Repaired(id)
		} else {
			ToolPairing::Paired(id)
		}
	}

	/// Returns the number of ready calls still awaiting caller results.
	pub fn outstanding(&self) -> usize {
		self.outstanding.len()
	}
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use serde_json::json;

	use super::*;
	use crate::{
		WirePolicyId,
		recovery::json::{JsonEnforcement, JsonRepairLimits, JsonRepairStage},
	};

	fn definition() -> ToolDefinition {
		ToolDefinition {
			name:        sf!("search"),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(
					json!({"type":"object","properties":{"query":{"type":"string","minLength":1}},"required":["query"],"additionalProperties":false}),
				),
				strict:     true,
			},
		}
	}
	fn grammar_definition(fallback: Value) -> ToolDefinition {
		ToolDefinition {
			name:        sf!("edit"),
			description: None,
			input:       ToolInputConstraint::Grammar {
				grammar:  crate::call::ToolGrammar {
					syntax:     crate::call::ToolGrammarSyntax::Lark,
					definition: sf!("start: LF"),
				},
				fallback: OpaqueJson::new(fallback),
			},
		}
	}

	fn edit_fallback_schema() -> Value {
		json!({
			"type": "object",
			"properties": {"input": {"type": "string"}},
			"required": ["input"],
			"additionalProperties": false,
		})
	}

	fn complete_call(
		assembler: &mut ToolAssembler<'_>,
		input_kind: ToolInputKind,
		arguments: &'static [u8],
	) -> Vec<ToolAssemblyEvent> {
		assembler.push(ToolFragment::Start {
			input_kind,
			source_index: 0,
			id: Some(ToolCallId::new("call-edit")),
			name: Bytes::from_static(b"edit"),
		});
		assembler.push(ToolFragment::ArgumentsDelta {
			source_index: 0,
			bytes:        Bytes::from_static(arguments),
		});
		assembler.push(ToolFragment::End { source_index: 0 })
	}

	#[test]
	fn freeform_input_canonicalizes_into_the_input_property() {
		let definitions = [grammar_definition(edit_fallback_schema())];
		let mut assembler = ToolAssembler::new(&definitions, ToolAssemblyLimits::default(), 1);
		let text = "[src/a.rs#1A2B]\nPUT 1.=1:\n+replacement";
		let output = complete_call(&mut assembler, ToolInputKind::Freeform, text.as_bytes());
		let [ToolAssemblyEvent::Ready { call, .. }] = output.as_slice() else {
			panic!("freeform call must authorize: {output:?}");
		};
		assert_eq!(call.arguments.as_value(), &json!({"input": text}));
		assert!(
			assembler
				.take_evidence()
				.iter()
				.any(|record| record.rule.0 == "tool.complete-freeform-valid")
		);
	}

	#[test]
	fn grammar_tool_accepts_schema_lowered_json_arguments() {
		let definitions = [grammar_definition(edit_fallback_schema())];
		let mut assembler = ToolAssembler::new(&definitions, ToolAssemblyLimits::default(), 1);
		let output = complete_call(&mut assembler, ToolInputKind::Json, br#"{"input":"PUT 1.=1:"}"#);
		let [.., ToolAssemblyEvent::Ready { call, .. }] = output.as_slice() else {
			panic!("fallback JSON call must authorize: {output:?}");
		};
		assert_eq!(call.arguments.as_value(), &json!({"input": "PUT 1.=1:"}));
		assert!(
			assembler
				.take_evidence()
				.iter()
				.any(|record| record.rule.0 == "tool.grammar-fallback-arguments")
		);
	}

	#[test]
	fn grammar_fallback_json_defers_missing_required_input_to_the_tool() {
		let definitions = [grammar_definition(edit_fallback_schema())];
		let mut assembler = ToolAssembler::new(&definitions, ToolAssemblyLimits::default(), 1);
		let output = complete_call(&mut assembler, ToolInputKind::Json, br"{}");
		assert!(
			matches!(output.as_slice(), [.., ToolAssemblyEvent::Ready { call, .. }]
				if call.arguments.as_value() == &json!({})),
			"typed tool decoder must receive non-conforming arguments: {output:?}"
		);
		assert!(
			assembler
				.take_evidence()
				.iter()
				.any(|record| record.rule.0 == "tool.complete-schema-invalid")
		);
	}

	#[test]
	fn freeform_call_without_an_input_property_is_rejected() {
		let definitions = [grammar_definition(
			json!({"type": "object", "properties": {}, "additionalProperties": false}),
		)];
		let mut assembler = ToolAssembler::new(&definitions, ToolAssemblyLimits::default(), 1);
		let output = complete_call(&mut assembler, ToolInputKind::Freeform, b"raw text");
		assert!(
			matches!(output.as_slice(), [.., ToolAssemblyEvent::Rejected {
				reason: ToolRejection::SchemaViolation(_),
				..
			}]),
			"schema without an input property cannot receive freeform calls: {output:?}"
		);
	}
	#[test]
	fn strict_subset_accepts_annotations_and_combinators() {
		let schema = json!({
			"type": "object",
			"properties": {
				"timeout_ms": {"type": ["integer", "null"], "format": "uint64", "minimum": 0},
				"name": {"type": "string", "minLength": 1},
			},
			"required": ["name"],
			"additionalProperties": false,
			"anyOf": [
				{"properties": {"async": {"const": false}}},
				{"required": ["name"]},
			],
		});
		assert!(schema_within_strict_subset(&schema, ToolAssemblyLimits::default()));
	}

	#[test]
	fn strict_subset_rejects_unassertable_keywords_anywhere() {
		let conditional = json!({
			"type": "object",
			"properties": {"command": {"type": "string"}},
			"allOf": [{
				"if": {"properties": {"async": {"const": true}}, "required": ["async"]},
				"then": {"required": ["name"]},
			}],
		});
		assert!(!schema_within_strict_subset(&conditional, ToolAssemblyLimits::default()));
		let nested_ref = json!({
			"type": "object",
			"properties": {"item": {"items": {"$ref": "#/$defs/item"}}},
		});
		assert!(!schema_within_strict_subset(&nested_ref, ToolAssemblyLimits::default()));
	}

	#[test]
	fn strict_validation_treats_format_as_annotation() {
		let schema = json!({
			"type": "object",
			"properties": {"limit": {"type": "integer", "format": "uint32", "minimum": 0}},
			"additionalProperties": false,
		});
		assert!(
			validate_schema(&schema, &json!({"limit": 3}), true, ToolAssemblyLimits::default())
				.is_ok()
		);
		let issue =
			validate_schema(&schema, &json!({"limit": "three"}), true, ToolAssemblyLimits::default())
				.expect_err("type assertion still enforced beside the annotation");
		assert_eq!(issue.rule, "type");
	}

	#[test]
	fn partial_and_wrong_calls_never_authorize() {
		let definitions = Arc::from([definition()]);
		let mut assembler = ToolAssembler::new(&definitions, ToolAssemblyLimits::default(), 1);
		assembler.push(ToolFragment::Start {
			input_kind:   ToolInputKind::Json,
			source_index: 2,
			id:           None,
			name:         Bytes::from_static(b"search"),
		});
		assembler.push(ToolFragment::ArgumentsDelta {
			source_index: 2,
			bytes:        Bytes::from_static(b"{\"query\":"),
		});
		assert!(
			!assembler
				.finish()
				.iter()
				.any(|event| matches!(event, ToolAssemblyEvent::Ready { .. }))
		);
		assembler.push(ToolFragment::Start {
			input_kind:   ToolInputKind::Json,
			source_index: 3,
			id:           None,
			name:         Bytes::from_static(b"wrong"),
		});
		assembler.push(ToolFragment::ArgumentsDelta {
			source_index: 3,
			bytes:        Bytes::from_static(b"{}"),
		});
		assert!(matches!(
			assembler
				.push(ToolFragment::End { source_index: 3 })
				.as_slice(),
			[ToolAssemblyEvent::Rejected { .. }]
		));
	}

	#[test]
	fn complete_valid_fragmented_call_is_the_only_ready_case() {
		let definitions = [definition()];
		let mut assembler = ToolAssembler::new(&definitions, ToolAssemblyLimits::default(), 1);
		assembler.push(ToolFragment::Start {
			input_kind:   ToolInputKind::Json,
			source_index: 0,
			id:           Some(ToolCallId::new("call-1")),
			name:         Bytes::new(),
		});
		assembler.push(ToolFragment::NameDelta {
			source_index: 0,
			bytes:        Bytes::from_static(b"sea"),
			complete:     false,
		});
		assembler.push(ToolFragment::NameDelta {
			source_index: 0,
			bytes:        Bytes::from_static(b"rch"),
			complete:     true,
		});
		assembler.push(ToolFragment::ArgumentsDelta {
			source_index: 0,
			bytes:        Bytes::from_static(b"{\"query\":"),
		});
		assembler.push(ToolFragment::ArgumentsDelta {
			source_index: 0,
			bytes:        Bytes::from_static(b"\"rust\"}"),
		});
		let output = assembler.push(ToolFragment::End { source_index: 0 });
		assert!(
			matches!(output.as_slice(), [ToolAssemblyEvent::Ready { call, .. }] if call.id.as_str() == "call-1")
		);
	}
	#[test]
	fn tolerant_argument_repair_precedes_schema_authorization() {
		let definitions = [definition()];
		let mut assembler = ToolAssembler::new(&definitions, ToolAssemblyLimits::default(), 1);
		assembler.push(ToolFragment::Start {
			input_kind:   ToolInputKind::Json,
			source_index: 4,
			id:           Some(ToolCallId::new("call-slop")),
			name:         Bytes::from_static(b"search"),
		});
		assembler.push(ToolFragment::ArgumentsDelta {
			source_index: 4,
			bytes:        Bytes::from_static(b"{'query':'rust',}"),
		});
		let output = assembler.push(ToolFragment::End { source_index: 4 });
		assert!(matches!(
			output.as_slice(),
			[ToolAssemblyEvent::Ready { call, .. }]
				if call.arguments.as_value() == &json!({"query":"rust"})
		));
		assert!(
			assembler
				.take_evidence()
				.iter()
				.any(|record| record.rule.0.as_str() == "tool.tolerant-argument-repair")
		);
	}

	#[test]
	fn malformed_arguments_and_schema_issues_reach_the_typed_tool() {
		let definitions = [definition()];
		let mut malformed = ToolAssembler::new(&definitions, ToolAssemblyLimits::default(), 1);
		malformed.push(ToolFragment::Start {
			input_kind:   ToolInputKind::Json,
			source_index: 7,
			id:           None,
			name:         Bytes::from_static(b"search"),
		});
		malformed.push(ToolFragment::ArgumentsDelta {
			source_index: 7,
			bytes:        Bytes::from_static(b"{"),
		});
		assert!(matches!(
			malformed
				.push(ToolFragment::End { source_index: 7 })
				.as_slice(),
			[ToolAssemblyEvent::Ready { call, .. }]
				if call.arguments.as_value().is_null()
		));

		let mut schema_invalid = ToolAssembler::new(&definitions, ToolAssemblyLimits::default(), 1);
		schema_invalid.push(ToolFragment::Start {
			input_kind:   ToolInputKind::Json,
			source_index: 8,
			id:           None,
			name:         Bytes::from_static(b"search"),
		});
		schema_invalid.push(ToolFragment::ArgumentsDelta {
			source_index: 8,
			bytes:        Bytes::from_static(br#"{"query":"","extra":true}"#),
		});
		let output = schema_invalid.push(ToolFragment::End { source_index: 8 });
		assert!(matches!(
			output.as_slice(),
			[.., ToolAssemblyEvent::Ready { call, .. }]
				if call.arguments.as_value() == &json!({"query":"","extra":true})
		));
	}
	#[test]
	fn closed_schema_drops_unknown_members_before_the_typed_boundary() {
		let definitions = [definition()];
		let mut assembler = ToolAssembler::new(&definitions, ToolAssemblyLimits::default(), 1);
		assembler.push(ToolFragment::Start {
			input_kind:   ToolInputKind::Json,
			source_index: 9,
			id:           None,
			name:         Bytes::from_static(b"search"),
		});
		assembler.push(ToolFragment::ArgumentsDelta {
			source_index: 9,
			bytes:        Bytes::from_static(br#"{"query":"rust","extra":true}"#),
		});
		let output = assembler.push(ToolFragment::End { source_index: 9 });
		assert!(matches!(
			output.as_slice(),
			[.., ToolAssemblyEvent::Ready { call, .. }]
				if call.arguments.as_value() == &json!({"query":"rust"})
		));
	}
	#[test]
	fn scalar_repair_and_unknown_drop_share_one_canonical_document() {
		let definition = ToolDefinition {
			name:        sf!("count"),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(json!({
					"type": "object",
					"properties": {"count": {"type": "integer"}},
					"required": ["count"],
					"additionalProperties": false,
				})),
				strict:     true,
			},
		};
		let coercions = [ArgumentCoercionSpec {
			path:      sf!("/count"),
			coercions: Box::new([ArgumentCoercion::Integer]),
		}];
		let (events, _) =
			call_with_coercions(definition, &json!({"count": "42", "extra": true}), &coercions);
		assert_eq!(ready_arguments(&events), Some(json!({"count": 42})));
	}

	#[test]
	fn total_call_bound_is_enforced_after_completed_calls() {
		let definitions = [definition()];
		let limits = ToolAssemblyLimits { max_total_calls: 1, ..ToolAssemblyLimits::default() };
		let mut assembler = ToolAssembler::new(&definitions, limits, 1);
		assembler.push(ToolFragment::Start {
			input_kind:   ToolInputKind::Json,
			source_index: 0,
			id:           None,
			name:         Bytes::from_static(b"search"),
		});
		assembler.push(ToolFragment::ArgumentsDelta {
			source_index: 0,
			bytes:        Bytes::from_static(br#"{"query":"one"}"#),
		});
		assert!(matches!(
			assembler
				.push(ToolFragment::End { source_index: 0 })
				.as_slice(),
			[ToolAssemblyEvent::Ready { .. }]
		));
		assert!(matches!(
			assembler
				.push(ToolFragment::Start {
					input_kind:   ToolInputKind::Json,
					source_index: 1,
					id:           None,
					name:         Bytes::from_static(b"search"),
				})
				.as_slice(),
			[ToolAssemblyEvent::Rejected {
				reason: ToolRejection::LimitExceeded { field: "total calls", limit: 1 },
				..
			}]
		));
	}

	#[test]
	fn fabricated_and_duplicate_results_are_rejected() {
		let call = ToolCall {
			id:        ToolCallId::new("call-1"),
			name:      sf!("search"),
			arguments: OpaqueJson::new(json!({"query":"rust"})),
		};
		let mut pairer = ToolResultPairer::default();
		assert_eq!(pairer.register_ready(&call), ToolRegistration::Registered);
		assert_eq!(pairer.pair(None, ToolResultSource::ModelOutput), ToolPairing::RejectedFabricated);
		assert_eq!(
			pairer.pair(None, ToolResultSource::Caller),
			ToolPairing::Repaired(call.id.clone())
		);
		assert_eq!(
			pairer.pair(Some(&call.id), ToolResultSource::Caller),
			ToolPairing::RejectedFabricated
		);
	}

	#[test]
	fn truncated_json_document_is_not_repaired() {
		let mut repair = JsonRepairStage::new(
			JsonEnforcement::NativeOrRepair,
			JsonRepairLimits::default(),
			WirePolicyId::from("test-wire"),
			1,
		);
		let malformed = Bytes::from_static(br"{'query': {'text': 'rust',");
		let mut documents = Vec::new();
		Stage::push(&mut repair, malformed, &mut |_| {}).expect("bounded fragment accepted");
		assert!(matches!(
			Stage::finish(&mut repair, &mut |document| documents.push(document)),
			Err(RecoveryError::InvalidDocument { .. })
		));
		assert!(documents.is_empty());
	}

	#[test]
	fn truncated_tool_arguments_use_rejection_sentinel() {
		let definitions = [definition()];
		let mut assembler = ToolAssembler::new(&definitions, ToolAssemblyLimits::default(), 1);
		assembler.push(ToolFragment::Start {
			input_kind:   ToolInputKind::Json,
			source_index: 9,
			id:           None,
			name:         Bytes::from_static(b"search"),
		});
		assembler.push(ToolFragment::ArgumentsDelta {
			source_index: 9,
			bytes:        Bytes::from_static(br#"{"query":"rust","i":"Truncated"#),
		});
		assert!(matches!(
			assembler
				.push(ToolFragment::End { source_index: 9 })
				.as_slice(),
			[ToolAssemblyEvent::Ready { call, .. }]
				if call.arguments.as_value().is_null()
		));
	}

	#[test]
	fn single_quotes_and_trailing_comma_repair_before_ready() {
		let mut repair = JsonRepairStage::new(
			JsonEnforcement::NativeOrRepair,
			JsonRepairLimits::default(),
			WirePolicyId::from("test-wire"),
			1,
		);
		let mut documents = Vec::new();
		Stage::push(&mut repair, Bytes::from_static(br"{'query':'rust',}"), &mut |_| {})
			.expect("bounded fragment accepted");
		Stage::finish(&mut repair, &mut |document| documents.push(document))
			.expect("repair succeeds");
		let document = documents.pop().expect("one repaired document");
		assert!(document.recovery.is_some());

		let definitions = [definition()];
		let mut assembler = ToolAssembler::new(&definitions, ToolAssemblyLimits::default(), 1);
		assembler.push(ToolFragment::Start {
			input_kind:   ToolInputKind::Json,
			source_index: 10,
			id:           None,
			name:         Bytes::from_static(b"search"),
		});
		assert!(matches!(
			assembler
				.push(ToolFragment::ArgumentsDelta { source_index: 10, bytes: document.bytes })
				.as_slice(),
			[ToolAssemblyEvent::ArgumentsDelta { .. }]
		));
		assert!(matches!(
			assembler
				.push(ToolFragment::End { source_index: 10 })
				.as_slice(),
			[ToolAssemblyEvent::Ready { .. }]
		));
	}

	#[test]
	fn strict_mode_rejects_truncated_nested_arguments_without_output() {
		let mut strict = JsonRepairStage::new(
			JsonEnforcement::Strict,
			JsonRepairLimits::default(),
			WirePolicyId::from("test-wire"),
			1,
		);
		let mut documents = Vec::new();
		Stage::push(&mut strict, Bytes::from_static(br"{'query': {'text': 'rust',"), &mut |_| {})
			.expect("bounded fragment accepted");
		assert!(Stage::finish(&mut strict, &mut |document| documents.push(document)).is_err());
		assert!(documents.is_empty());
	}

	#[test]
	fn pairing_bound_rejects_calls_instead_of_forgetting_duplicates() {
		let first = ToolCall {
			id:        ToolCallId::new("first"),
			name:      sf!("search"),
			arguments: OpaqueJson::new(json!({"query":"one"})),
		};
		let second = ToolCall {
			id:        ToolCallId::new("second"),
			name:      sf!("search"),
			arguments: OpaqueJson::new(json!({"query":"two"})),
		};
		let mut pairer = ToolResultPairer::new(1);
		assert_eq!(pairer.register_ready(&first), ToolRegistration::Registered);
		assert!(matches!(
			pairer.pair(Some(&first.id), ToolResultSource::Caller),
			ToolPairing::Paired(_)
		));
		assert_eq!(pairer.register_ready(&first), ToolRegistration::Duplicate);
		assert_eq!(pairer.register_ready(&second), ToolRegistration::LimitExceeded);
	}

	/// Returns the `ask` tool definition used by the recovery path.
	fn ask_definition() -> ToolDefinition {
		ToolDefinition {
			name:        sf!("ask"),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(json!({
					"type": "object",
					"properties": {
						"questions": {
							"type": "array",
							"minItems": 1,
							"items": {
								"type": "object",
								"properties": {
									"id": {"type": "string"},
									"question": {"type": "string"},
									"options": {
										"type": "array",
										"items": {
											"type": "object",
											"properties": {"label": {"type": "string"}},
											"required": ["label"],
											"additionalProperties": false
										}
									},
									"recommended": {"type": "number"}
								},
								"required": ["id", "question", "options"],
								"additionalProperties": false
							}
						}
					},
					"required": ["questions"]
				})),
				strict:     true,
			},
		}
	}

	fn call_with(
		definition: ToolDefinition,
		arguments: &Value,
	) -> (Vec<ToolAssemblyEvent>, Vec<Str>) {
		call_with_coercions(definition, arguments, &[])
	}

	fn call_with_coercions(
		definition: ToolDefinition,
		arguments: &Value,
		coercions: &[ArgumentCoercionSpec],
	) -> (Vec<ToolAssemblyEvent>, Vec<Str>) {
		let definitions = [definition];
		let mut assembler =
			ToolAssembler::with_coercions(&definitions, coercions, ToolAssemblyLimits::default(), 1);
		assembler.push(ToolFragment::Start {
			input_kind:   ToolInputKind::Json,
			source_index: 0,
			id:           None,
			name:         Bytes::copy_from_slice(definitions[0].name.as_bytes()),
		});
		assembler.push(ToolFragment::ArgumentsDelta {
			source_index: 0,
			bytes:        Bytes::from(serde_json::to_vec(arguments).expect("arguments serialize")),
		});
		let events = assembler.push(ToolFragment::End { source_index: 0 });
		let rules = assembler
			.take_evidence()
			.into_iter()
			.map(|record| record.rule.0)
			.collect();
		(events, rules)
	}

	fn ready_arguments(events: &[ToolAssemblyEvent]) -> Option<Value> {
		events.iter().find_map(|event| match event {
			ToolAssemblyEvent::Ready { call, .. } => Some(call.arguments.as_value().clone()),
			_ => None,
		})
	}

	#[test]
	fn declared_string_coercion_repairs_a_union_target() {
		let definition = ToolDefinition {
			name:        sf!("union_string"),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(json!({
					"type": "object",
					"properties": {"payload": {"type": ["string", "number"]}},
					"required": ["payload"],
					"additionalProperties": false
				})),
				strict:     true,
			},
		};
		let coercions = [ArgumentCoercionSpec {
			path:      sf!("/payload"),
			coercions: Box::new([ArgumentCoercion::String]),
		}];
		let (events, _) = call_with_coercions(definition, &json!({"payload": {"a": 1}}), &coercions);
		assert_eq!(ready_arguments(&events), Some(json!({"payload": "{\"a\":1}"})));
	}

	#[test]
	fn type_changes_require_matching_declared_coercions() {
		let limits = ToolAssemblyLimits::default();
		for (schema, input, expected) in [
			(json!({"type": "string"}), json!({"value": 1}), json!({"value": 1})),
			(json!({"type": "array", "items": {"type": "string"}}), json!("one"), json!("one")),
		] {
			let error = repair_schema_arguments(&schema, &input, true, limits, &[])
				.expect_err("an undeclared type change must be rejected");
			assert_eq!(error.0, expected);
			assert_eq!(error.1.rule, "type");
			assert_eq!(error.2, 0);
		}

		for (schema, input, expected) in [
			(json!({"type": "string"}), json!({"value": 1}), json!("{\"value\":1}")),
			(json!({"type": "array", "items": {"type": "string"}}), json!("one"), json!(["one"])),
		] {
			let coercion = if schema["type"] == "string" {
				ArgumentCoercion::String
			} else {
				ArgumentCoercion::Singleton
			};
			let specs =
				[ArgumentCoercionSpec { path: sf!("/"), coercions: Box::new([coercion]) }];
			let (actual, repairs) = repair_schema_arguments(&schema, &input, true, limits, &specs)
				.expect("the declared coercion must repair to the schema");
			assert_eq!(actual, expected);
			assert_eq!(repairs, 1);
		}
	}

	#[test]
	fn failed_untagged_union_branch_does_not_apply_lossy_repairs() {
		let schema = json!({
			"anyOf": [
				{
					"type": "object",
					"properties": {"payload": {"type": "string"}},
					"required": ["payload"],
					"additionalProperties": false
				},
				{
					"type": "object",
					"properties": {"payload": {"type": "number"}},
					"required": ["payload"],
					"additionalProperties": false
				}
			]
		});
		let value = json!({"payload": {"a": 1}});
		let issue = validate_schema(&schema, &value, true, ToolAssemblyLimits::default())
			.expect_err("untagged branch must fail");
		assert!(issue.from_union_branch);
		assert_eq!(issue.path.as_str(), "/payload");

		let definition = ToolDefinition {
			name:        sf!("untagged"),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(schema),
				strict:     true,
			},
		};
		let (events, _) = call_with(definition, &value);
		assert_eq!(ready_arguments(&events), Some(value));
	}
	#[test]
	fn failed_union_branch_allows_a_declared_scalar_repair() {
		let definition = ToolDefinition {
			name:        sf!("lossless"),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(json!({
					"type": "object",
					"properties": {
						"payload": {
							"anyOf": [
								{"type": "number"},
								{"type": "boolean"}
							]
						}
					},
					"required": ["payload"],
					"additionalProperties": false
				})),
				strict:     true,
			},
		};
		let coercions = [ArgumentCoercionSpec {
			path:      sf!("/payload"),
			coercions: Box::new([ArgumentCoercion::Number]),
		}];
		let (events, _) = call_with_coercions(definition, &json!({"payload": "300"}), &coercions);
		assert_eq!(ready_arguments(&events), Some(json!({"payload": 300})));
	}

	#[test]
	fn failed_union_branch_does_not_delete_keys_or_wrap_singletons() {
		for value in [
			json!({"op": {"kind": "set", "value": 1, "extra": "keep"}}),
			json!({"op": {"items": "one"}}),
		] {
			let property = if value["op"].get("items").is_some() {
				json!({
					"anyOf": [
						{
							"type": "object",
							"properties": {"items": {"type": "array"}},
							"required": ["items"],
							"additionalProperties": false
						},
						{"type": "string"}
					]
				})
			} else {
				json!({
					"anyOf": [
						{
							"type": "object",
							"properties": {
								"kind": {"type": "string"},
								"value": {"type": "number"}
							},
							"required": ["kind", "value"],
							"additionalProperties": false
						},
						{"type": "string"}
					]
				})
			};
			let definition = ToolDefinition {
				name:        sf!("lossy"),
				description: None,
				input:       ToolInputConstraint::JsonSchema {
					parameters: OpaqueJson::new(json!({
						"type": "object",
						"properties": {"op": property},
						"required": ["op"],
						"additionalProperties": false
					})),
					strict:     true,
				},
			};
			let (events, _) = call_with(definition, &value);
			assert_eq!(ready_arguments(&events), Some(value));
		}
	}

	#[test]
	fn uniquely_tag_selected_union_branch_allows_lossy_repairs() {
		let schema = json!({
			"oneOf": [
				{
					"type": "object",
					"properties": {
						"kind": {"const": "text"},
						"payload": {"type": "string"}
					},
					"required": ["kind", "payload"],
					"additionalProperties": false
				},
				{
					"type": "object",
					"properties": {
						"kind": {"enum": ["count"]},
						"payload": {"type": "number"}
					},
					"required": ["kind", "payload"],
					"additionalProperties": false
				}
			]
		});
		let value = json!({"kind": "text", "payload": {"a": 1}});
		let issue = validate_schema(&schema, &value, true, ToolAssemblyLimits::default())
			.expect_err("tag-selected payload still needs repair");
		assert!(!issue.from_union_branch);
		assert_eq!(issue.path.as_str(), "/payload");

		let definition = ToolDefinition {
			name:        sf!("tagged"),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(schema),
				strict:     true,
			},
		};
		let coercions = [ArgumentCoercionSpec {
			path:      sf!("/payload"),
			coercions: Box::new([ArgumentCoercion::String]),
		}];
		let (events, _) = call_with_coercions(definition, &value, &coercions);
		assert_eq!(ready_arguments(&events), Some(json!({"kind": "text", "payload": "{\"a\":1}"})));
	}

	#[test]
	fn flattened_array_paths_rebuild_nested_arguments() {
		let (events, rules) = call_with(
			ask_definition(),
			&json!({
				"questions[0].id": "doc_structure",
				"questions[0].question": "Which format should we adopt?",
				"questions[0].options[0].label": "Structured Markdown",
				"questions[0].options[1].label": "Plain text",
				"questions[0].recommended": 0
			}),
		);
		assert_eq!(
			ready_arguments(&events).expect("call authorizes"),
			json!({
				"questions": [{
					"id": "doc_structure",
					"question": "Which format should we adopt?",
					"options": [{"label": "Structured Markdown"}, {"label": "Plain text"}],
					"recommended": 0
				}]
			})
		);
		assert!(
			rules
				.iter()
				.any(|rule| rule.as_str() == "tool.flattened-array-arguments")
		);
	}

	#[test]
	fn flattened_paths_span_multiple_array_elements() {
		let (events, _) = call_with(
			ask_definition(),
			&json!({
				"questions[0].id": "q1",
				"questions[0].question": "First",
				"questions[0].options[0].label": "A",
				"questions[1].id": "q2",
				"questions[1].question": "Second",
				"questions[1].options[0].label": "B"
			}),
		);
		assert_eq!(
			ready_arguments(&events).expect("call authorizes"),
			json!({
				"questions": [
					{"id": "q1", "question": "First", "options": [{"label": "A"}]},
					{"id": "q2", "question": "Second", "options": [{"label": "B"}]}
				]
			})
		);
	}

	#[test]
	fn flattened_bare_leaf_array_elements_rebuild() {
		let tags = ToolDefinition {
			name:        sf!("tag"),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(json!({
					"type": "object",
					"properties": {"tags": {"type": "array", "minItems": 2, "items": {"type": "string"}}},
					"required": ["tags"]
				})),
				strict:     true,
			},
		};
		let (events, _) = call_with(tags, &json!({"tags[0]": "alpha", "tags[1]": "beta"}));
		assert_eq!(
			ready_arguments(&events).expect("call authorizes"),
			json!({"tags": ["alpha", "beta"]})
		);
	}

	#[test]
	fn flattened_rebuild_preserves_plain_sibling_keys() {
		let mut definition = ask_definition();
		let ToolInputConstraint::JsonSchema { parameters, .. } = &mut definition.input else {
			unreachable!("ask definition declares a JSON schema");
		};
		let mut schema = parameters.as_value().clone();
		schema["properties"]["title"] = json!({"type": "string"});
		*parameters = OpaqueJson::new(schema);
		let (events, _) = call_with(
			definition,
			&json!({
				"title": "Session",
				"questions[0].id": "q",
				"questions[0].question": "Go?",
				"questions[0].options[0].label": "Yes"
			}),
		);
		assert_eq!(
			ready_arguments(&events).expect("call authorizes"),
			json!({
				"title": "Session",
				"questions": [{"id": "q", "question": "Go?", "options": [{"label": "Yes"}]}]
			})
		);
	}

	#[test]
	fn plain_nested_arguments_are_untouched() {
		let arguments =
			json!({"questions": [{"id": "q", "question": "Go?", "options": [{"label": "Yes"}]}]});
		let (events, rules) = call_with(ask_definition(), &arguments);
		assert_eq!(ready_arguments(&events).expect("call authorizes"), arguments);
		assert!(
			!rules
				.iter()
				.any(|rule| rule.as_str() == "tool.flattened-array-arguments")
		);
	}

	#[test]
	fn non_array_dotted_keys_are_untouched() {
		let dotted = ToolDefinition {
			name:        sf!("dot"),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(json!({
					"type": "object",
					"properties": {"a.b": {"type": "number"}, "c": {"type": "number"}},
					"required": ["a.b", "c"]
				})),
				strict:     true,
			},
		};
		let arguments = json!({"a.b": 1, "c": 2});
		let (events, _) = call_with(dotted, &arguments);
		assert_eq!(ready_arguments(&events).expect("call authorizes"), arguments);
	}

	#[test]
	fn malformed_indexed_keys_defer_to_the_typed_tool_decoder() {
		let arguments = json!({"questions[foo]": "nope"});
		let (events, _) = call_with(ask_definition(), &arguments);
		assert_eq!(ready_arguments(&events).expect("call reaches typed decoder"), arguments);
	}

	#[test]
	fn schema_mismatch_without_flattened_keys_defers_to_the_typed_tool_decoder() {
		let arguments = json!({"label": "300"});
		let (events, _) = call_with(ask_definition(), &arguments);
		assert_eq!(ready_arguments(&events).expect("call reaches typed decoder"), arguments);
	}

	#[test]
	fn flattened_path_collision_preserves_arguments_for_the_typed_decoder() {
		let arguments = json!({"questions": [5], "questions[0].id": "x"});
		let (events, _) = call_with(ask_definition(), &arguments);
		assert_eq!(ready_arguments(&events).expect("call reaches typed decoder"), arguments);
	}
}
