//! Projection of recovered wire/text fragments into canonical chat events.

use std::{collections::BTreeMap, io::Cursor};

use bytes::{Bytes, BytesMut};
use omp_catalog::{id::WirePolicyId, policy::WirePolicy};
use omp_core::Str;
use xutf::BufReadCharsExt as _;

use super::{
	RecoveryError, Stage,
	dialect::{Dialect, DialectEvent, DialectStage, ToolEnvelope},
	tools::{
		ToolAssembler, ToolAssemblyEvent, ToolAssemblyLimits, ToolFragment, ToolPairing,
		ToolRegistration, ToolResultPairer, ToolResultSource,
	},
};
use crate::{
	call::ToolDefinition,
	codec::ToolInputKind,
	event::{BlockKind, ChatEvent},
	id::ToolCallId,
	receipt::{ReasonId, RecoveryKind, RecoveryRecord},
};

/// Competing source of a model-requested tool call.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ToolChannel {
	/// Structured tool fragments decoded from the provider wire protocol.
	Native,
	/// Tool fragments recovered from model-authored text markup.
	Text,
}

/// Input to the deterministic recovery projector.
#[derive(Clone, Debug)]
pub enum ProjectionInput {
	/// Ordinary scanner-validated model text.
	Text(Bytes),
	/// One partial tool fragment from either channel.
	Tool {
		/// Candidate source channel.
		channel:  ToolChannel,
		/// Next assembly fragment.
		fragment: ToolFragment,
	},
	/// Output from the catalog-selected in-band dialect scanner.
	Dialect(DialectEvent),
	/// A caller/tool-executor result to pair with an authorized call.
	CallerToolResult {
		/// Supplied call identity, absent on repairable wires.
		call: Option<ToolCallId>,
	},
	/// A result-like boundary authored by the model, which must abort
	/// projection.
	ModelToolResult,
}

/// Non-provider recovery failure that permanently stops projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectionFailure {
	/// A complete tool candidate failed assembly or schema authorization.
	ToolAssemblyRejected,
	/// The model attempted to fabricate a result after requesting a real tool.
	FabricatedToolResult,
	/// A caller result could not be paired to exactly one authorized call.
	UnpairedToolResult,
	/// Text bytes were not a valid incrementally assembled UTF-8 stream.
	InvalidUtf8,
	/// A duplicate identity or total-call bound prevented safe result pairing.
	ToolRegistrationRejected,
}

/// Bounded output of one projector operation.
#[derive(Debug, Default)]
pub struct ProjectionBatch {
	/// Canonical events, in stream order.
	pub events:   Vec<ChatEvent>,
	/// A terminal recovery failure, if projection stopped.
	pub failure:  Option<ProjectionFailure>,
	/// Deterministic recovery records produced by completed tool assembly.
	pub evidence: Vec<RecoveryRecord>,
}

/// Catalog evidence and bounds for live in-band tool recovery.
#[derive(Clone, Debug)]
pub struct DialectRecoveryConfig {
	/// Exact compiled wire policy selected for the attempt.
	pub wire_policy:          WirePolicyId,
	/// Catalog-selected model-authored tool syntax, if any.
	pub dialect:              Option<Dialect>,
	/// Whether the route requires whole-attempt Harmony leak auditing.
	pub harmony_mitigation:   bool,
	/// Attempt number written to recovery receipts.
	pub attempt:              u32,
	/// Maximum bytes retained for one model-authored envelope.
	pub max_block_bytes:      usize,
	/// Maximum bounded raw preview retained in an envelope.
	pub max_diagnostic_bytes: usize,
	/// Tool assembly and schema-validation bounds.
	pub tool_limits:          ToolAssemblyLimits,
}

impl DialectRecoveryConfig {
	/// Builds recovery configuration solely from compiled catalog policy.
	pub fn from_wire_policy(wire_policy: WirePolicyId, policy: &WirePolicy, attempt: u32) -> Self {
		let harmony_mitigation = policy.streaming.harmony_leak_mitigation == Some(true);
		let dialect = policy
			.streaming
			.markup_healing_pattern
			.and_then(Dialect::from_markup_pattern)
			.or_else(|| {
				policy
					.reasoning
					.leaked_healer
					.and_then(Dialect::from_healer)
			});
		Self {
			wire_policy,
			dialect,
			harmony_mitigation,
			attempt,
			max_block_bytes: ToolAssemblyLimits::default().max_argument_bytes,
			max_diagnostic_bytes: 128,
			tool_limits: ToolAssemblyLimits::default(),
		}
	}
}

/// Live catalog-selected text recovery with bounded native-channel precedence
/// followed by canonical event projection.
#[derive(Debug)]
pub struct DialectRecoveryPipeline<'a> {
	dialect:                Option<DialectStage>,
	projector:              RecoveryProjector<'a>,
	pending_dialect:        Vec<DialectEvent>,
	pending_dialect_bytes:  usize,
	pending_tool_calls:     usize,
	max_pending_tool_calls: usize,
	max_pending_bytes:      usize,
}

impl<'a> DialectRecoveryPipeline<'a> {
	/// Creates one bounded pipeline for a provider attempt.
	pub fn new(definitions: &'a [ToolDefinition], config: DialectRecoveryConfig) -> Self {
		let dialect = config.dialect.map(|dialect| {
			DialectStage::new(
				dialect,
				config.wire_policy,
				config.attempt,
				config.max_block_bytes,
				config.max_diagnostic_bytes,
			)
		});
		Self {
			dialect,
			projector: RecoveryProjector::new(definitions, config.tool_limits, config.attempt),
			pending_dialect: Vec::new(),
			pending_dialect_bytes: 0,
			pending_tool_calls: 0,
			max_pending_tool_calls: config.tool_limits.max_total_calls,
			max_pending_bytes: config.max_block_bytes,
		}
	}

	/// Feeds visible-channel bytes through configured dialect recognition and
	/// canonical projection.
	pub fn push_text(&mut self, input: Bytes) -> Result<ProjectionBatch, RecoveryError> {
		let mut output = ProjectionBatch::default();
		if let Some(dialect) = self.dialect.as_mut() {
			let mut events = Vec::new();
			dialect.push(input, &mut |event| events.push(event))?;
			self.apply_dialect_events(events, &mut output)?;
		} else {
			append_batch(&mut output, self.projector.push(ProjectionInput::Text(input)));
		}
		Ok(output)
	}

	/// Feeds native provider tool fragments through the same projector, so a
	/// native call deterministically wins over leaked text envelopes.
	pub fn push_native(&mut self, fragment: ToolFragment) -> ProjectionBatch {
		self
			.projector
			.push(ProjectionInput::Tool { channel: ToolChannel::Native, fragment })
	}

	/// Reindexes one canonical event from a channel which does not otherwise
	/// require recovery, reserving its block index in the shared allocator.
	pub fn push_passthrough(&mut self, event: ChatEvent) -> ProjectionBatch {
		self.projector.project_passthrough(event)
	}

	/// Resolves held delimiter suffixes and incomplete projected calls.
	pub fn finish(&mut self) -> Result<ProjectionBatch, RecoveryError> {
		let mut output = ProjectionBatch::default();
		if let Some(dialect) = self.dialect.as_mut() {
			let mut events = Vec::new();
			dialect.finish(&mut |event| events.push(event))?;
			self.apply_dialect_events(events, &mut output)?;
		}
		let native_selected = self.projector.selected_channel == Some(ToolChannel::Native);
		for event in std::mem::take(&mut self.pending_dialect) {
			if native_selected && matches!(&event, DialectEvent::ToolEnvelope(_)) {
				continue;
			}
			append_batch(&mut output, self.projector.push(ProjectionInput::Dialect(event)));
			if output.failure.is_some() {
				break;
			}
		}
		self.pending_dialect_bytes = 0;
		self.pending_tool_calls = 0;
		append_batch(&mut output, self.projector.finish());
		Ok(output)
	}

	fn apply_dialect_events(
		&mut self,
		events: Vec<DialectEvent>,
		output: &mut ProjectionBatch,
	) -> Result<(), RecoveryError> {
		for event in events {
			let starts_pending = matches!(&event, DialectEvent::ToolEnvelope(_));
			if self.pending_dialect.is_empty() && !starts_pending {
				let DialectEvent::Text(bytes) = event else {
					unreachable!("only tool envelopes start deferred dialect output");
				};
				append_batch(output, self.projector.push(ProjectionInput::Text(bytes)));
				continue;
			}
			if starts_pending {
				if self.pending_tool_calls >= self.max_pending_tool_calls {
					return Err(RecoveryError::LimitExceeded {
						stage: "dialect-tool-calls",
						limit: self.max_pending_tool_calls,
					});
				}
				self.pending_tool_calls = self.pending_tool_calls.saturating_add(1);
			}
			let bytes = match &event {
				DialectEvent::Text(bytes) => bytes.len(),
				DialectEvent::ToolEnvelope(envelope) => {
					envelope.raw.len().saturating_add(envelope.arguments.len())
				},
			};
			if self.pending_dialect_bytes.saturating_add(bytes) > self.max_pending_bytes {
				return Err(RecoveryError::LimitExceeded {
					stage: "dialect-precedence",
					limit: self.max_pending_bytes,
				});
			}
			self.pending_dialect_bytes = self.pending_dialect_bytes.saturating_add(bytes);
			self.pending_dialect.push(event);
		}
		Ok(())
	}
}

impl Stage<Bytes, ProjectionBatch> for DialectRecoveryPipeline<'_> {
	fn push(
		&mut self,
		input: Bytes,
		emit: &mut dyn FnMut(ProjectionBatch),
	) -> Result<(), RecoveryError> {
		let output = self.push_text(input)?;
		if batch_has_output(&output) {
			emit(output);
		}
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(ProjectionBatch)) -> Result<(), RecoveryError> {
		let output = DialectRecoveryPipeline::finish(self)?;
		if batch_has_output(&output) {
			emit(output);
		}
		Ok(())
	}
}

/// Stateful projector enforcing one tool channel and fabricated-result
/// rejection.
#[derive(Debug)]
pub struct RecoveryProjector<'a> {
	native:                ToolAssembler<'a>,
	text_tools:            ToolAssembler<'a>,
	selected_channel:      Option<ToolChannel>,
	canonical_indexes:     BTreeMap<(ToolChannel, u32), u32>,
	passthrough_indexes:   BTreeMap<u32, u32>,
	next_index:            u32,
	text_index:            Option<u32>,
	next_text_tool_source: u32,
	calls_started:         usize,
	max_total_calls:       usize,
	pairer:                ToolResultPairer,
	attempt:               u32,
	pending_text:          BytesMut,
	stopped:               bool,
}

impl<'a> RecoveryProjector<'a> {
	/// Creates a projector for one attempt.
	pub fn new(definitions: &'a [ToolDefinition], limits: ToolAssemblyLimits, attempt: u32) -> Self {
		Self {
			native: ToolAssembler::new(definitions, limits, attempt),
			text_tools: ToolAssembler::new(definitions, limits, attempt),
			selected_channel: None,
			canonical_indexes: BTreeMap::new(),
			passthrough_indexes: BTreeMap::new(),
			next_index: 0,
			text_index: None,
			next_text_tool_source: 0,
			pairer: ToolResultPairer::new(limits.max_total_calls),
			calls_started: 0,
			max_total_calls: limits.max_total_calls,
			pending_text: BytesMut::new(),
			stopped: false,
			attempt,
		}
	}

	/// Projects one incremental input. Once stopped, all later input is dropped.
	pub fn push(&mut self, input: ProjectionInput) -> ProjectionBatch {
		if self.stopped {
			return ProjectionBatch::default();
		}
		match input {
			ProjectionInput::Text(bytes) => self.project_text(bytes),
			ProjectionInput::Tool { channel, fragment } => self.project_tool(channel, fragment),
			ProjectionInput::Dialect(event) => self.project_dialect(event),
			ProjectionInput::CallerToolResult { call } => {
				match self.pairer.pair(call.as_deref(), ToolResultSource::Caller) {
					ToolPairing::Paired(_) => ProjectionBatch::default(),
					ToolPairing::Repaired(_) => ProjectionBatch {
						evidence: vec![self.evidence(
							RecoveryKind::ToolResultRepair,
							"tool.result-id-repaired",
							0,
						)],
						..ProjectionBatch::default()
					},
					ToolPairing::RejectedFabricated => {
						let mut output = self.stop(ProjectionFailure::UnpairedToolResult);
						output.evidence.push(self.evidence(
							RecoveryKind::FabricatedResultRejection,
							"tool.result-unpaired-rejected",
							0,
						));
						output
					},
				}
			},
			ProjectionInput::ModelToolResult => {
				let mut output = self.stop(ProjectionFailure::FabricatedToolResult);
				output.evidence.push(self.evidence(
					RecoveryKind::FabricatedResultRejection,
					"tool.fabricated-result-rejected",
					0,
				));
				output
			},
		}
	}

	/// Flushes retained delimiter suffixes and rejects incomplete tool calls.
	pub fn finish(&mut self) -> ProjectionBatch {
		if self.stopped {
			return ProjectionBatch::default();
		}
		let mut output = ProjectionBatch::default();
		self.flush_text(&mut output);
		let selected = self.selected_channel;
		for (channel, events) in [
			(ToolChannel::Native, self.native.finish()),
			(ToolChannel::Text, self.text_tools.finish()),
		] {
			if selected == Some(channel) {
				self.apply_tool_events(channel, events, &mut output);
			}
		}
		output.evidence.extend(self.native.take_evidence());
		output.evidence.extend(self.text_tools.take_evidence());
		output
	}

	/// Reindexes one already-canonical event through the same block allocator
	/// used by recovered text and tool calls.
	pub fn project_passthrough(&mut self, event: ChatEvent) -> ProjectionBatch {
		if self.stopped {
			return ProjectionBatch::default();
		}
		let event = match event {
			ChatEvent::BlockStarted { index, kind } => {
				ChatEvent::BlockStarted { index: self.passthrough_index(index), kind }
			},
			ChatEvent::TextDelta { index, text } => {
				ChatEvent::TextDelta { index: self.passthrough_index(index), text }
			},
			ChatEvent::ThinkingDelta { index, text } => {
				ChatEvent::ThinkingDelta { index: self.passthrough_index(index), text }
			},
			ChatEvent::ToolCallStarted { index, id, name } => {
				ChatEvent::ToolCallStarted { index: self.passthrough_index(index), id, name }
			},
			ChatEvent::ToolArgumentsDelta { index, bytes } => {
				ChatEvent::ToolArgumentsDelta { index: self.passthrough_index(index), bytes }
			},
			ChatEvent::ToolCallReady { index, call } => {
				ChatEvent::ToolCallReady { index: self.passthrough_index(index), call }
			},
			ChatEvent::Artifact { index, artifact } => {
				ChatEvent::Artifact { index: self.passthrough_index(index), artifact }
			},
			event => event,
		};
		ProjectionBatch { events: vec![event], ..ProjectionBatch::default() }
	}

	/// Returns whether a terminal fabricated/unpaired result stopped the stream.
	pub const fn is_stopped(&self) -> bool {
		self.stopped
	}

	fn project_tool(&mut self, channel: ToolChannel, fragment: ToolFragment) -> ProjectionBatch {
		if self.stopped {
			return ProjectionBatch::default();
		}
		if self
			.selected_channel
			.is_some_and(|selected| selected != channel)
		{
			return ProjectionBatch::default();
		}
		let events = match channel {
			ToolChannel::Native => self.native.push(fragment),
			ToolChannel::Text => self.text_tools.push(fragment),
		};
		let mut output = ProjectionBatch::default();
		self.apply_tool_events(channel, events, &mut output);
		output.evidence.extend(match channel {
			ToolChannel::Native => self.native.take_evidence(),
			ToolChannel::Text => self.text_tools.take_evidence(),
		});
		output
	}

	fn project_dialect(&mut self, event: DialectEvent) -> ProjectionBatch {
		match event {
			DialectEvent::Text(bytes) => self.project_text(bytes),
			DialectEvent::ToolEnvelope(envelope) => self.project_envelope(envelope),
		}
	}

	fn project_envelope(&mut self, envelope: ToolEnvelope) -> ProjectionBatch {
		if self.selected_channel == Some(ToolChannel::Native) {
			return ProjectionBatch::default();
		}
		let source_index = self.next_text_tool_source;
		self.next_text_tool_source = self.next_text_tool_source.saturating_add(1);
		let name = envelope
			.name
			.map_or_else(Bytes::new, |name| Bytes::copy_from_slice(name.as_bytes()));
		let mut output = self.project_tool(ToolChannel::Text, ToolFragment::Start {
			source_index,
			id: None,
			name,
			input_kind: ToolInputKind::Json,
		});
		append_batch(
			&mut output,
			self.project_tool(ToolChannel::Text, ToolFragment::ArgumentsDelta {
				source_index,
				bytes: envelope.arguments,
			}),
		);
		append_batch(
			&mut output,
			self.project_tool(ToolChannel::Text, ToolFragment::End { source_index }),
		);
		output.evidence.push(envelope.recovery);
		output
	}

	fn apply_tool_events(
		&mut self,
		channel: ToolChannel,
		events: Vec<ToolAssemblyEvent>,
		output: &mut ProjectionBatch,
	) {
		for event in events {
			match event {
				ToolAssemblyEvent::Started { source_index, id, name } => {
					if self.calls_started >= self.max_total_calls {
						self.stopped = true;
						output.failure = Some(ProjectionFailure::ToolRegistrationRejected);
						output.evidence.push(self.evidence(
							RecoveryKind::ToolAssembly,
							"tool.total-call-limit",
							0,
						));
						continue;
					}
					self.calls_started += 1;
					if self.selected_channel.get_or_insert(channel) != &channel {
						continue;
					}
					let index = self.allocate_tool_index(channel, source_index);
					output
						.events
						.push(ChatEvent::BlockStarted { index, kind: BlockKind::ToolCall });
					output
						.events
						.push(ChatEvent::ToolCallStarted { index, id, name });
				},
				ToolAssemblyEvent::ArgumentsDelta { source_index, bytes } => {
					if self.selected_channel != Some(channel) {
						continue;
					}
					if let Some(&index) = self.canonical_indexes.get(&(channel, source_index)) {
						output
							.events
							.push(ChatEvent::ToolArgumentsDelta { index, bytes });
					}
				},
				ToolAssemblyEvent::Ready { source_index, call } => {
					if self.selected_channel != Some(channel) {
						continue;
					}
					if let Some(index) = self.canonical_indexes.remove(&(channel, source_index)) {
						match self.pairer.register_ready(&call) {
							ToolRegistration::Registered => {
								output.events.push(ChatEvent::ToolCallReady { index, call });
							},
							ToolRegistration::Duplicate | ToolRegistration::LimitExceeded => {
								self.stopped = true;
								output.failure = Some(ProjectionFailure::ToolRegistrationRejected);
								output.evidence.push(self.evidence(
									RecoveryKind::ToolAssembly,
									"tool.registration-rejected",
									0,
								));
							},
						}
					}
				},
				ToolAssemblyEvent::Rejected { source_index, .. } => {
					self.canonical_indexes.remove(&(channel, source_index));
					if self.selected_channel == Some(channel) {
						self.stopped = true;
						output.failure = Some(ProjectionFailure::ToolAssemblyRejected);
						output.evidence.push(self.evidence(
							RecoveryKind::ToolAssembly,
							"tool.assembly-rejected",
							0,
						));
					}
				},
			}
		}
	}

	fn project_text(&mut self, bytes: Bytes) -> ProjectionBatch {
		self.pending_text.extend_from_slice(&bytes);
		let mut output = ProjectionBatch::default();
		if let Some(position) = first_fabricated_opener(&self.pending_text) {
			let examined = self.pending_text.len() as u64;
			let prefix = self.pending_text.split_to(position).freeze();
			if decode_utf8(&prefix).is_none() {
				self.pending_text.clear();
				self.stopped = true;
				output.failure = Some(ProjectionFailure::InvalidUtf8);
				return output;
			}
			self.emit_text(prefix, &mut output);
			self.pending_text.clear();
			self.stopped = true;
			output.failure = Some(ProjectionFailure::FabricatedToolResult);
			output.evidence.push(self.evidence(
				RecoveryKind::FabricatedResultRejection,
				"tool.fabricated-result-marker",
				examined,
			));
			return output;
		}
		let hold = partial_opener_suffix(&self.pending_text);
		let Ok(valid) = valid_utf8_prefix(&self.pending_text) else {
			self.pending_text.clear();
			self.stopped = true;
			output.failure = Some(ProjectionFailure::InvalidUtf8);
			return output;
		};
		let emit = valid.saturating_sub(hold.min(valid));
		if emit != 0 {
			let prefix = self.pending_text.split_to(emit).freeze();
			self.emit_text(prefix, &mut output);
		}
		output
	}

	fn flush_text(&mut self, output: &mut ProjectionBatch) {
		if self.pending_text.is_empty() {
			return;
		}
		if decode_utf8(&self.pending_text).is_none() {
			self.pending_text.clear();
			self.stopped = true;
			output.failure = Some(ProjectionFailure::InvalidUtf8);
			return;
		}
		let text = self.pending_text.split().freeze();
		self.emit_text(text, output);
	}

	fn emit_text(&mut self, bytes: Bytes, output: &mut ProjectionBatch) {
		if bytes.is_empty() {
			return;
		}
		let Some(text) = decode_utf8(&bytes) else {
			return;
		};
		let index = if let Some(index) = self.text_index {
			index
		} else {
			let index = self.allocate_index();
			self.text_index = Some(index);
			output
				.events
				.push(ChatEvent::BlockStarted { index, kind: BlockKind::Text });
			index
		};
		output
			.events
			.push(ChatEvent::TextDelta { index, text: Str::new(text) });
	}

	fn passthrough_index(&mut self, source: u32) -> u32 {
		if let Some(&index) = self.passthrough_indexes.get(&source) {
			return index;
		}
		let index = self.allocate_index();
		self.passthrough_indexes.insert(source, index);
		index
	}

	fn allocate_tool_index(&mut self, channel: ToolChannel, source: u32) -> u32 {
		if let Some(&index) = self.canonical_indexes.get(&(channel, source)) {
			return index;
		}
		let index = self.allocate_index();
		self.canonical_indexes.insert((channel, source), index);
		index
	}

	const fn allocate_index(&mut self) -> u32 {
		let index = self.next_index;
		self.next_index = self.next_index.saturating_add(1);
		index
	}

	fn stop(&mut self, failure: ProjectionFailure) -> ProjectionBatch {
		self.stopped = true;
		ProjectionBatch { failure: Some(failure), ..ProjectionBatch::default() }
	}

	fn evidence(&self, kind: RecoveryKind, rule: &'static str, input_bytes: u64) -> RecoveryRecord {
		RecoveryRecord {
			attempt: self.attempt,
			kind,
			rule: ReasonId(Str::new(rule)),
			input_bytes,
			steps: 1,
		}
	}
}

impl Stage<ProjectionInput, ProjectionBatch> for RecoveryProjector<'_> {
	fn push(
		&mut self,
		input: ProjectionInput,
		emit: &mut dyn FnMut(ProjectionBatch),
	) -> Result<(), RecoveryError> {
		let output = RecoveryProjector::push(self, input);
		if !output.events.is_empty() || output.failure.is_some() || !output.evidence.is_empty() {
			emit(output);
		}
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(ProjectionBatch)) -> Result<(), RecoveryError> {
		let output = RecoveryProjector::finish(self);
		if !output.events.is_empty() || output.failure.is_some() || !output.evidence.is_empty() {
			emit(output);
		}
		Ok(())
	}
}

const fn batch_has_output(batch: &ProjectionBatch) -> bool {
	!batch.events.is_empty() || batch.failure.is_some() || !batch.evidence.is_empty()
}

fn append_batch(target: &mut ProjectionBatch, mut source: ProjectionBatch) {
	target.events.append(&mut source.events);
	if target.failure.is_none() {
		target.failure = source.failure;
	}
	target.evidence.append(&mut source.evidence);
}

const FABRICATED_OPENERS: &[&[u8]] = &[
	b"<tool_response",
	b"<tool_result",
	b"<function_response",
	b"<|tool_response|>",
	"<｜tool▁outputs▁begin｜>".as_bytes(),
	"<｜tool▁output▁begin｜>".as_bytes(),
];

fn valid_utf8_prefix(bytes: &[u8]) -> Result<usize, ()> {
	for held in 0..=bytes.len().min(3) {
		let end = bytes.len() - held;
		if decode_utf8(&bytes[..end]).is_some() {
			return Ok(end);
		}
	}
	Err(())
}

fn decode_utf8(bytes: &[u8]) -> Option<String> {
	let mut reader = Cursor::new(bytes);
	reader.chars().collect::<Result<String, _>>().ok()
}

fn first_fabricated_opener(bytes: &[u8]) -> Option<usize> {
	FABRICATED_OPENERS
		.iter()
		.filter_map(|token| {
			bytes
				.windows(token.len())
				.position(|window| window == *token)
		})
		.min()
}

fn partial_opener_suffix(bytes: &[u8]) -> usize {
	FABRICATED_OPENERS
		.iter()
		.map(|token| {
			let max = bytes.len().min(token.len().saturating_sub(1));
			(1..=max)
				.rev()
				.find(|&length| bytes[bytes.len() - length..] == token[..length])
				.unwrap_or(0)
		})
		.max()
		.unwrap_or(0)
}

#[cfg(test)]
mod tests {
	use omp_core::sf;
	use serde_json::json;

	use super::*;
	use crate::call::{OpaqueJson, ToolInputConstraint};

	fn definition() -> ToolDefinition {
		ToolDefinition {
			name:        sf!("echo"),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(
					json!({"type":"object","required":["text"],"properties":{"text":{"type":"string"}}}),
				),
				strict:     true,
			},
		}
	}

	#[test]
	fn configured_dialect_pipeline_projects_canonical_tool_events() {
		let mut policy = WirePolicy::baseline();
		policy.streaming.markup_healing_pattern =
			Some(omp_catalog::policy::StreamMarkupHealingPattern::Qwen);
		let config =
			DialectRecoveryConfig::from_wire_policy(WirePolicyId::new("qwen-wire"), &policy, 2);
		assert_eq!(config.dialect, Some(Dialect::QwenXml));
		let definitions = [definition()];
		let mut pipeline = DialectRecoveryPipeline::new(&definitions, config);
		let input = b"before<tool_calls><echo text=\"ok\" /></tool_calls>after";
		let mut output = ProjectionBatch::default();
		for chunk in input.chunks(7) {
			append_batch(
				&mut output,
				pipeline
					.push_text(Bytes::copy_from_slice(chunk))
					.expect("configured recovery remains valid"),
			);
		}
		append_batch(&mut output, pipeline.finish().expect("configured recovery finishes"));
		let calls: Vec<_> = output
			.events
			.iter()
			.filter_map(ChatEvent::authorized_tool_call)
			.collect();
		assert_eq!(calls.len(), 1);
		assert_eq!(calls[0].name.as_str(), "echo");
		assert_eq!(calls[0].arguments.as_value(), &json!({"text": "ok"}));
		assert!(
			output
				.evidence
				.iter()
				.any(|record| record.rule.0.as_str() == "dialect/qwen-wire/qwen-xml")
		);
	}

	#[test]
	fn harmony_audit_is_selected_only_by_compiled_policy() {
		let mut policy = WirePolicy::baseline();
		let plain = DialectRecoveryConfig::from_wire_policy(WirePolicyId::new("plain"), &policy, 0);
		assert!(!plain.harmony_mitigation);
		assert_eq!(plain.dialect, None);

		policy.streaming.harmony_leak_mitigation = Some(true);
		let harmony = DialectRecoveryConfig::from_wire_policy(WirePolicyId::new("codex"), &policy, 0);
		assert!(harmony.harmony_mitigation);
		assert_eq!(
			harmony.dialect, None,
			"mitigation audits provider text but does not turn arbitrary fenced examples into calls"
		);
	}

	#[test]
	fn passthrough_and_recovered_blocks_share_one_collision_free_allocator() {
		let definitions = [definition()];
		let config = DialectRecoveryConfig {
			wire_policy:          WirePolicyId::new("hermes-wire"),
			dialect:              Some(Dialect::Hermes),
			harmony_mitigation:   false,
			attempt:              0,
			max_block_bytes:      1024,
			max_diagnostic_bytes: 32,
			tool_limits:          ToolAssemblyLimits::default(),
		};
		let mut pipeline = DialectRecoveryPipeline::new(&definitions, config);
		let thinking = pipeline
			.push_passthrough(ChatEvent::BlockStarted { index: 0, kind: BlockKind::Thinking });
		assert!(matches!(thinking.events.as_slice(), [ChatEvent::BlockStarted {
			index: 0,
			kind:  BlockKind::Thinking,
		}]));
		let pending = pipeline
			.push_text(Bytes::from_static(
				br#"<tool_call>{"name":"echo","arguments":{"text":"ok"}}</tool_call>"#,
			))
			.expect("dialect recovery succeeds");
		assert!(
			pending
				.events
				.iter()
				.all(|event| event.authorized_tool_call().is_none())
		);
		let artifact = pipeline
			.push_passthrough(ChatEvent::BlockStarted { index: 1, kind: BlockKind::Artifact });
		assert!(matches!(artifact.events.as_slice(), [ChatEvent::BlockStarted {
			index: 1,
			kind:  BlockKind::Artifact,
		}]));
		let recovered = pipeline.finish().expect("dialect recovery finishes");
		assert!(
			recovered
				.events
				.iter()
				.any(|event| matches!(event, ChatEvent::ToolCallReady { index: 2, .. }))
		);
	}

	#[test]
	fn configured_pipeline_keeps_native_channel_authoritative() {
		let definitions = [definition()];
		let config = DialectRecoveryConfig {
			wire_policy:          WirePolicyId::new("hermes-wire"),
			dialect:              Some(Dialect::Hermes),
			harmony_mitigation:   false,
			attempt:              0,
			max_block_bytes:      1024,
			max_diagnostic_bytes: 32,
			tool_limits:          ToolAssemblyLimits::default(),
		};
		let mut pipeline = DialectRecoveryPipeline::new(&definitions, config);
		let leaked = pipeline
			.push_text(Bytes::from_static(
				br#"<tool_call>{"name":"echo","arguments":{"text":"leaked"}}</tool_call>"#,
			))
			.expect("dialect scan succeeds");
		assert!(leaked.events.is_empty());
		let native = [
			ToolFragment::Start {
				source_index: 7,
				id:           Some(ToolCallId::new("native")),
				name:         Bytes::from_static(b"echo"),
				input_kind:   ToolInputKind::Json,
			},
			ToolFragment::ArgumentsDelta {
				source_index: 7,
				bytes:        Bytes::from_static(br#"{"text":"native"}"#),
			},
			ToolFragment::End { source_index: 7 },
		];
		let mut native_ready = None;
		for fragment in native {
			native_ready = pipeline
				.push_native(fragment)
				.events
				.into_iter()
				.find_map(|event| event.authorized_tool_call().cloned())
				.or(native_ready);
		}
		assert_eq!(
			native_ready
				.expect("native call becomes authoritative")
				.arguments
				.as_value(),
			&json!({"text": "native"})
		);
		let finished = pipeline.finish().expect("pipeline finishes");
		assert!(
			finished
				.events
				.iter()
				.all(|event| event.authorized_tool_call().is_none()),
			"buffered text calls must be discarded once native output arrives"
		);
	}

	#[test]
	fn completed_invalid_native_call_is_a_terminal_projection_failure() {
		let definitions = [definition()];
		let config = DialectRecoveryConfig {
			wire_policy:          WirePolicyId::new("wire"),
			dialect:              None,
			harmony_mitigation:   false,
			attempt:              0,
			max_block_bytes:      1024,
			max_diagnostic_bytes: 32,
			tool_limits:          ToolAssemblyLimits::default(),
		};
		let mut pipeline = DialectRecoveryPipeline::new(&definitions, config);
		pipeline.push_native(ToolFragment::Start {
			source_index: 3,
			id:           None,
			name:         Bytes::from_static(b"undeclared"),
			input_kind:   ToolInputKind::Json,
		});
		pipeline.push_native(ToolFragment::ArgumentsDelta {
			source_index: 3,
			bytes:        Bytes::from_static(b"{}"),
		});
		let rejected = pipeline.push_native(ToolFragment::End { source_index: 3 });
		assert_eq!(rejected.failure, Some(ProjectionFailure::ToolAssemblyRejected));
		assert!(
			rejected
				.evidence
				.iter()
				.any(|record| record.rule.0.as_str() == "tool.assembly-rejected")
		);
	}

	#[test]
	fn configured_dialect_pipeline_fails_at_its_envelope_bound() {
		let definitions = [definition()];
		let config = DialectRecoveryConfig {
			wire_policy:          WirePolicyId::new("bounded-wire"),
			dialect:              Some(Dialect::Hermes),
			harmony_mitigation:   false,
			attempt:              0,
			max_block_bytes:      24,
			max_diagnostic_bytes: 8,
			tool_limits:          ToolAssemblyLimits::default(),
		};
		let mut pipeline = DialectRecoveryPipeline::new(&definitions, config);
		let error = pipeline
			.push_text(Bytes::from_static(
				b"<tool_call>{\"name\":\"echo\",\"arguments\":{\"text\":\"far too long\"}}",
			))
			.expect_err("an unterminated envelope must not grow beyond its bound");
		assert_eq!(error, RecoveryError::LimitExceeded { stage: "tag-scanner", limit: 24 });
	}

	#[test]
	fn native_channel_wins_and_only_complete_valid_call_is_ready() {
		let definitions = [definition()];
		let mut projector = RecoveryProjector::new(&definitions, ToolAssemblyLimits::default(), 1);
		projector.push(ProjectionInput::Tool {
			channel:  ToolChannel::Native,
			fragment: ToolFragment::Start {
				input_kind:   ToolInputKind::Json,
				source_index: 5,
				id:           Some(ToolCallId::new("n1")),
				name:         Bytes::from_static(b"echo"),
			},
		});
		let ignored = projector.push(ProjectionInput::Tool {
			channel:  ToolChannel::Text,
			fragment: ToolFragment::Start {
				input_kind:   ToolInputKind::Json,
				source_index: 1,
				id:           None,
				name:         Bytes::from_static(b"echo"),
			},
		});
		assert!(ignored.events.is_empty());
		let partial = projector.push(ProjectionInput::Tool {
			channel:  ToolChannel::Native,
			fragment: ToolFragment::ArgumentsDelta {
				source_index: 5,
				bytes:        Bytes::from_static(b"{\"text\":"),
			},
		});
		assert!(
			!partial
				.events
				.iter()
				.any(|event| event.authorized_tool_call().is_some())
		);
		projector.push(ProjectionInput::Tool {
			channel:  ToolChannel::Native,
			fragment: ToolFragment::ArgumentsDelta {
				source_index: 5,
				bytes:        Bytes::from_static(b"\"ok\"}"),
			},
		});
		let ready = projector.push(ProjectionInput::Tool {
			channel:  ToolChannel::Native,
			fragment: ToolFragment::End { source_index: 5 },
		});
		assert_eq!(
			ready
				.events
				.iter()
				.filter(|event| event.authorized_tool_call().is_some())
				.count(),
			1
		);
	}

	#[test]
	fn replay_projection_is_invariant_to_utf8_chunk_boundaries() {
		fn project(chunks: &[&[u8]]) -> String {
			let definitions = [definition()];
			let mut projector = RecoveryProjector::new(&definitions, ToolAssemblyLimits::default(), 1);
			let mut output = String::new();
			for chunk in chunks {
				for event in projector
					.push(ProjectionInput::Text(Bytes::copy_from_slice(chunk)))
					.events
				{
					if let ChatEvent::TextDelta { text, .. } = event {
						output.push_str(text.as_str());
					}
				}
			}
			for event in projector.finish().events {
				if let ChatEvent::TextDelta { text, .. } = event {
					output.push_str(text.as_str());
				}
			}
			output
		}
		let text = "α-beta".as_bytes();
		assert_eq!(project(&[text]), project(&[&text[..1], &text[1..3], &text[3..]]));
	}

	#[test]
	fn fabricated_result_split_across_wire_chunks_aborts_once() {
		let definitions = [definition()];
		let mut projector = RecoveryProjector::new(&definitions, ToolAssemblyLimits::default(), 1);
		let first = projector.push(ProjectionInput::Text(Bytes::from_static(b"visible<tool_res")));
		assert!(first.failure.is_none());
		let second = projector.push(ProjectionInput::Text(Bytes::from_static(b"ponse>fake")));
		assert_eq!(second.failure, Some(ProjectionFailure::FabricatedToolResult));
		assert!(
			projector
				.push(ProjectionInput::Text(Bytes::from_static(b"tail")))
				.events
				.is_empty()
		);
	}
}
