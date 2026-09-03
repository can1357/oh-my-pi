//! Durable N-turn agent policy loop.

use std::{
	collections::{BTreeMap, BTreeSet, VecDeque},
	future::Future,
	pin::Pin,
	str,
	sync::Arc,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use futures::StreamExt;
use omp_core::{Hash32, IntoStr, InvocationPhase, Point, Str, sf};
use omp_env::{EnvClient, InvocationEvent};
use omp_inference::{TurnId, layer::secrets::SecretStreamRestorer, recovery::repetition};
use omp_memory::{
	retain::{OwnedRetentionMessage, RetentionRole},
	session::SessionMemory,
};
use omp_observability::firehose::{
	Branch, BranchOp, Envelope, Event as FirehoseEvent, Firehose, ModelAttempt, ModelRequest,
	ProviderError, ToolCall as FirehoseToolCall, TurnEnd as FirehoseTurnEnd,
	TurnStart as FirehoseTurnStart,
};
use omp_proto::{
	env::v1::InvokeTool,
	inference::v1::{
		self as pb, ContextRef, Outcome, ThreadDelta, part_start, tool_choice, turn_error,
		turn_event, value,
	},
	thread::v1::{self as thread, Item, Thread, item, part},
	toolhost::v1 as hook_pb,
};
use omp_secrets::{
	json::{deobfuscate_json, obfuscate_json},
	message::{MessageTextKind, obfuscate_message_text, restore_message_text},
	obfuscator::SecretObfuscator,
};
use omp_storage::{
	blob::{self, BlobStore},
	gc::{ArtifactCatalog, ArtifactLifetime},
	transcript::{
		CallId, ChildLifecycleEntry, HookOutcome, InvocationTransition, SnapcompactArchive,
	},
};
use omp_tool::{Abort, CallOutcome, CapsBase, Registry as ToolRegistry};
use parking_lot::Mutex;
use serde_json::{Value, value::RawValue};
use thiserror::Error;
use tracing::Instrument as _;

use crate::{
	AgentRegistry, BatchError, CompactionCancellation, CompactionCoordinator, CompactionEvent,
	CompactionMethodOrder, CompactionReason, CompactionResolution, CompactionTier, HookPhase,
	Journal, JournalError, Mailbox, MailboxSender, ManualCompactionMode, ManualCompactionOutcome,
	ManualCompactionRequest, ManualShakeMode, ManualShakeOutcome, PROMPT_CACHE_WARM_SUFFIX_TOKENS,
	ProjectionError, PromptMemoryQuery, PromptMemorySnapshotSource, SnapcompactPreparation,
	StreamSource, StreamingEditGuard, TtsrRegistry, TurnClient, TurnInput, TurnSession,
	YieldPayload, YieldPayloadError, YieldPayloadValidator,
	advisor::{ADVISOR_TOOL_LOOP_THRESHOLD, AdvisorToolLoopAction, AdvisorToolLoopGuard},
	arbiter::{
		Arbiter, PointCx, StreamPart,
		context::{compaction_instruction, recover_checkpoint_state, rewind_background_warning},
		settle::{EmptyOutputRetry, source_candidate},
		stream::{StreamCancel, stream_recovery_item},
	},
	batch::{
		BatchResult, InvocationAdmissionFact, InvocationHookBus, InvocationHookRequest,
		SpeculativeCall, ToolBatch,
	},
	context::{ContextProjection, ContextProjectionHandler, apply_patches, project_context},
	continuation::{
		AgentSettledEvent, Continuation, ContinuationLedger, ContinuationPolicy, ContinuationSource,
		LoopSignal, RedemptionAuthority, RedemptionEvidence, SettledFold, SettledParticipant,
		TodoRef, continues_loop, from_hook,
	},
	control::{
		ControlError, ControlMailbox, ControlMailboxEvent, ControlSender, RegimeControl,
		ScheduledRewind, channel,
	},
	duplex::{DuplexError, DuplexManager},
	events::{AgentEvent, AgentPhase, EventBus},
	hooks::{HookGate, JsonGateOutcome, gate_json, notify_json},
	jobs::{CancelOutcome, JobBoard, JobError},
	journal::{
		AbortDisposition, ReplicationSubscription, TurnInputRecord, TurnOptionsRecord, TurnStart,
	},
	mailbox::DrainPoint,
	project::project_journal,
	prompt::{PromptError, PromptHash},
	state::{
		AgentState, ContextPromotionPolicy, MidTurnCompactionPolicy, SteeringMode, UnexpectedStopMode,
	},
	stateful::StatefulComponent,
	turn::Error as TurnError,
};

const INTERRUPT_GRACE: omp_core::Duration =
	omp_core::Duration::new(500, omp_core::DurationUnit::Milliseconds);
const TOOL_DEADLINE: omp_core::Duration =
	omp_core::Duration::new(300, omp_core::DurationUnit::Seconds);
/// Grace given to background jobs cancelled because a rewind dropped their
/// registration.
const REWIND_JOB_GRACE: omp_core::Duration =
	omp_core::Duration::new(5, omp_core::DurationUnit::Seconds);
const CONTROL_DRAIN_LIMIT: usize = 32;
const MEMORY_RECALL_QUERY_MAX_CHARS: usize = 32 * 1024;
const UNEXPECTED_STOP_RETRY_CAP: u8 = 3;

#[derive(serde::Deserialize)]
struct TodoSnapshotPayload {
	phases: Vec<TodoSnapshotPhase>,
}

#[derive(serde::Deserialize)]
struct TodoSnapshotPhase {
	phase: Str,
	items: Vec<TodoSnapshotItem>,
}

#[derive(serde::Deserialize)]
struct TodoSnapshotItem {
	text:   Str,
	status: Str,
}

/// Typed settlement of one complete caller submission.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
#[repr(u8)]
pub enum RunSettlement {
	/// The assistant completed normally.
	Success,
	/// The assistant completed with non-fatal diagnostics.
	Warning,
	/// The caller explicitly aborted the submission.
	CallerAbort,
	/// Compaction replaced the active context and intentionally produced no
	/// user-visible answer.
	SilentCompactionTransition,
	/// The provider exhausted the output-token budget.
	MaxTokens,
	/// The submission ended in a terminal protocol or provider fault.
	TerminalFault,
}

/// Terminal result of one complete caller submission, including tool
/// follow-ups.
#[derive(Clone, Debug)]
pub struct AgentRunSummary {
	/// Authoritative terminal arbiter outcome of the last committed turn, if
	/// any.
	pub outcome:         Option<Outcome>,
	/// Committed turn count for this submission.
	pub committed_turns: u32,
	/// Whether the submission stopped on a caller abort.
	pub interrupted:     bool,
	/// Typed terminal classification for host exit and presentation policy.
	pub settlement:      RunSettlement,
	final_assistant:     Option<Str>,
}

impl AgentRunSummary {
	/// Projects a committed outcome into the authoritative typed settlement.
	pub fn settled(outcome: Outcome, committed_turns: u32, interrupted: bool) -> Self {
		run_summary(Some(outcome), committed_turns, interrupted)
	}

	/// Constructs the typed terminal-fault projection used when `submit`
	/// returns an error before committing an outcome.
	pub const fn terminal_fault() -> Self {
		Self {
			outcome:         None,
			committed_turns: 0,
			interrupted:     false,
			settlement:      RunSettlement::TerminalFault,
			final_assistant: None,
		}
	}

	/// Constructs an intentional silent compaction transition.
	pub fn silent_compaction_transition(outcome: Option<Outcome>, committed_turns: u32) -> Self {
		let final_assistant = outcome.as_ref().and_then(authoritative_assistant);
		Self {
			outcome,
			committed_turns,
			interrupted: false,
			settlement: RunSettlement::SilentCompactionTransition,
			final_assistant,
		}
	}

	/// Returns the authoritative assistant text projected from the last
	/// committed outcome.
	pub fn final_assistant(&self) -> Option<&str> {
		self.final_assistant.as_deref()
	}

	/// Extracts and verbatim-validates the terminal `yield` call from the last
	/// Extracts and verbatim-validates the terminal `yield` call from the last
	/// subagent turn.
	///
	/// The raw argument bytes are decoded directly here, bypassing generic tool
	/// coercion so the structured deliverable cannot be stringified, wrapped,
	/// or stripped before its own retryable validation path sees it.
	pub fn yield_payload(
		&self,
		validator: &mut YieldPayloadValidator,
	) -> Result<Option<YieldPayload>, YieldPayloadError> {
		let Some(outcome) = self.outcome.as_ref() else {
			return Ok(None);
		};
		let mut payload = None;
		for item in &outcome.output {
			let Some(item::Kind::ToolCall(call)) = item.kind.as_ref() else {
				continue;
			};
			if call.name != "yield" {
				continue;
			}
			let raw = serde_json::from_slice::<Value>(&call.args_json)
				.map_err(|_| YieldPayloadError::InvalidEnvelope)?;
			payload = Some(validator.validate(&raw)?);
		}
		Ok(payload)
	}
}

fn run_summary(
	outcome: Option<Outcome>,
	committed_turns: u32,
	interrupted: bool,
) -> AgentRunSummary {
	let final_assistant = outcome.as_ref().and_then(authoritative_assistant);
	let settlement = if interrupted {
		RunSettlement::CallerAbort
	} else if let Some(outcome) = &outcome {
		match outcome.stop() {
			pb::StopReason::StopEndTurn
				if outcome.diagnostics.is_empty() && outcome.unsupported.is_empty() =>
			{
				RunSettlement::Success
			},
			pb::StopReason::StopEndTurn => RunSettlement::Warning,
			pb::StopReason::StopMaxTokens => RunSettlement::MaxTokens,
			pb::StopReason::StopToolUse => RunSettlement::Warning,
			pb::StopReason::StopUnspecified | pb::StopReason::StopContentFilter => {
				RunSettlement::TerminalFault
			},
		}
	} else {
		RunSettlement::TerminalFault
	};
	AgentRunSummary { outcome, committed_turns, interrupted, settlement, final_assistant }
}

const fn agent_phase_name(phase: AgentPhase) -> &'static str {
	match phase {
		AgentPhase::Idle => "idle",
		AgentPhase::Projecting => "projecting",
		AgentPhase::Turning => "turning",
		AgentPhase::ToolBatch => "tool_batch",
	}
}

const fn stop_reason_name(reason: pb::StopReason) -> &'static str {
	match reason {
		pb::StopReason::StopEndTurn => "end_turn",
		pb::StopReason::StopToolUse => "tool_use",
		pb::StopReason::StopMaxTokens => "max_tokens",
		pb::StopReason::StopContentFilter => "content_filter",
		pb::StopReason::StopUnspecified => "unspecified",
	}
}

fn effort_name(effort: i32) -> &'static str {
	match pb::Effort::try_from(effort).unwrap_or(pb::Effort::Unspecified) {
		pb::Effort::Off => "off",
		pb::Effort::Minimal => "minimal",
		pb::Effort::Low => "low",
		pb::Effort::Medium => "medium",
		pb::Effort::High => "high",
		pb::Effort::Xhigh => "xhigh",
		pb::Effort::Max => "max",
		pb::Effort::Unspecified => "off",
	}
}

fn parse_effort(value: &str) -> Option<pb::Effort> {
	Some(match value {
		"off" => pb::Effort::Off,
		"minimal" => pb::Effort::Minimal,
		"low" => pb::Effort::Low,
		"medium" => pb::Effort::Medium,
		"high" => pb::Effort::High,
		"xhigh" => pb::Effort::Xhigh,
		"max" => pb::Effort::Max,
		_ => return None,
	})
}

fn hook_tool_target(identity: &omp_tool::ToolIdentity, raw_args: &[u8]) -> Value {
	let args = serde_json::from_slice::<Value>(raw_args)
		.ok()
		.filter(Value::is_object)
		.unwrap_or_else(|| Value::Object(serde_json::Map::new()));
	serde_json::json!({
		"kind": "core",
		"name": identity.name,
		"rev": identity.rev.to_string(),
		"args": args,
	})
}

fn hook_model_ref(model: &str) -> Value {
	let (provider, name) = model.split_once('/').unwrap_or(("", model));
	serde_json::json!({"provider": provider, "api": provider, "model": name})
}
fn emit_session_renamed(gate: Option<&HookGate>, session: &str, name: Option<&str>) {
	notify_json(
		hook_pb::HookEventId::HookEventSessionRenamed,
		gate,
		|| serde_json::json!({"session": session, "name": name}),
	);
}

fn emit_fallback_model_changed(
	gate: Option<&HookGate>,
	current: impl FnOnce() -> (String, Option<i32>),
	next: &str,
) {
	let Some(gate) =
		gate.filter(|gate| gate.subscribed(hook_pb::HookEventId::HookEventModelChanged))
	else {
		return;
	};
	let (current, thinking) = current();
	notify_json(hook_pb::HookEventId::HookEventModelChanged, Some(gate), || {
		serde_json::json!({
			"from_model": hook_model_ref(&current),
			"to_model": hook_model_ref(next),
			"previous_thinking": thinking.map(effort_name),
			"thinking": thinking.map(effort_name),
			"role": current.as_str(),
			"reason": "fallback",
		})
	});
}

fn hook_outcome_kind(
	outcome: Option<&CallOutcome<omp_tool::CallOutcomeDetails, omp_tool::CallOutcomeDetails>>,
) -> &'static str {
	match outcome {
		Some(CallOutcome::Ok(_)) => "ok",
		Some(CallOutcome::Faulted(_)) => "faulted",
		Some(CallOutcome::ArgsRejected(_)) => "args_rejected",
		Some(CallOutcome::Aborted { .. }) | None => "aborted",
	}
}

fn apply_tool_result_hook(item: &mut Item, payload: &Value) {
	let Some(item::Kind::ToolResult(result)) = item.kind.as_mut() else {
		return;
	};
	let metadata = result.provider_metadata.get_or_insert_default();
	for field in ["annotate", "spill"] {
		let Some(json_value) = payload.get(field) else {
			continue;
		};
		let Ok(encoded) = serde_json::to_string(json_value) else {
			continue;
		};
		metadata
			.fields
			.insert(format!("omp/hook-{field}"), pb::Value {
				kind: Some(value::Kind::String(encoded)),
			});
	}
}

fn hook_usage(usage: Option<&pb::Usage>) -> Value {
	let usage = usage.cloned().unwrap_or_default();
	serde_json::json!({
		"input_tokens": usage.input_tokens,
		"cached_input_tokens": usage.cache_read_tokens,
		"output_tokens": usage.output_tokens,
		"reasoning_tokens": usage.reasoning_tokens.unwrap_or_default(),
		"cache_write_tokens": usage.cache_write_tokens,
		"requests": 1,
		"cost_usd": 0.0,
		"wall": "0ms",
	})
}

fn hook_item_ref(event_index: u64, item: &Item) -> Value {
	let (kind, role) = match item.kind.as_ref() {
		Some(item::Kind::Message(message)) => ("message", match message.role() {
			thread::Role::User => Some("user"),
			thread::Role::Assistant => Some("assistant"),
			thread::Role::System => Some("system"),
			thread::Role::Unspecified => None,
		}),
		Some(item::Kind::ToolCall(_)) => ("tool_call", None),
		Some(item::Kind::ToolResult(_)) => ("tool_result", Some("tool")),
		None => ("reasoning", None),
	};
	serde_json::json!({
		"event_index": event_index,
		"item_id": item.seq.to_string(),
		"kind": kind,
		"role": role,
	})
}

fn hook_item_text(item: &Item) -> Option<String> {
	let item::Kind::Message(message) = item.kind.as_ref()? else {
		return None;
	};
	let mut text = String::new();
	for part in &message.parts {
		if let Some(part::Kind::Text(value)) = part.kind.as_ref() {
			text.push_str(value);
		}
	}
	Some(text)
}

fn replace_hook_item_text(item: &mut Item, replacement: &str) {
	let Some(item::Kind::Message(message)) = item.kind.as_mut() else {
		return;
	};
	for part in &mut message.parts {
		if let Some(part::Kind::Text(value)) = part.kind.as_mut() {
			replacement.clone_into(value);
			return;
		}
	}
	message
		.parts
		.push(thread::Part { kind: Some(part::Kind::Text(replacement.to_owned())) });
}
fn hook_custom_message_item(value: &Value) -> Option<Item> {
	let text = match value {
		Value::String(text) => text.to_owned(),
		Value::Object(message) => {
			let content = message
				.get("text")
				.or_else(|| message.get("content"))
				.or_else(|| message.get("parts"))?;
			if let Some(text) = content.as_str() {
				text.to_owned()
			} else {
				let parts = content.as_array()?;
				let mut text = String::new();
				for part in parts {
					if let Some(fragment) = part
						.as_str()
						.or_else(|| part.get("text").and_then(Value::as_str))
					{
						text.push_str(fragment);
					}
				}
				text
			}
		},
		_ => return None,
	};
	if text.is_empty() {
		return None;
	}
	Some(Item {
		kind: Some(item::Kind::Message(thread::Message {
			role:  thread::Role::User as i32,
			parts: vec![thread::Part { kind: Some(part::Kind::Text(text)) }],
		})),
		..Item::default()
	})
}
fn append_hook_custom_messages(items: &mut Vec<Item>, values: &[Value], requested: usize) {
	items.extend(
		values
			.iter()
			.skip(requested)
			.filter_map(hook_custom_message_item),
	);
}
const MESSAGE_HOOK_COALESCE: Duration = Duration::from_millis(16);

struct MessageUpdateBatch {
	part_index: u32,
	kind:       &'static str,
	delta:      String,
	coalesced:  u32,
}

struct MessageHookStream {
	gate:        Arc<HookGate>,
	updates:     bool,
	turn_id:     Str,
	parts:       BTreeMap<u32, &'static str>,
	pending:     Option<MessageUpdateBatch>,
	total_chars: usize,
	last_flush:  Instant,
	ended:       bool,
}

impl MessageHookStream {
	fn new(gate: Arc<HookGate>, turn_id: Str) -> Self {
		let updates = gate.subscribed(hook_pb::HookEventId::HookEventMessageUpdate);
		Self {
			gate,
			updates,
			turn_id,
			parts: BTreeMap::new(),
			pending: None,
			total_chars: 0,
			last_flush: Instant::now(),
			ended: false,
		}
	}

	fn start(&mut self, part_index: u32, source: StreamSource) {
		if self.parts.is_empty() {
			notify_json(hook_pb::HookEventId::HookEventMessageStart, Some(self.gate.as_ref()), || {
				serde_json::json!({
					"turn_id": self.turn_id,
					"item_id": self.turn_id,
					"role": "assistant",
					"index": 0,
				})
			});
		}
		self.parts.insert(part_index, stream_part_kind(source));
	}

	fn delta(&mut self, part_index: u32, fragment: &str) {
		if !self.updates {
			return;
		}
		let Some(kind) = self.parts.get(&part_index).copied() else {
			return;
		};
		let fragment_chars = fragment.chars().count();
		if let Some(batch) = self
			.pending
			.as_mut()
			.filter(|batch| batch.part_index == part_index && batch.kind == kind)
		{
			self.total_chars = self.total_chars.saturating_add(fragment_chars);
			batch.delta.push_str(fragment);
			batch.coalesced = batch.coalesced.saturating_add(1);
		} else {
			self.flush();
			self.total_chars = self.total_chars.saturating_add(fragment_chars);
			self.pending =
				Some(MessageUpdateBatch { part_index, kind, delta: fragment.to_owned(), coalesced: 1 });
		}
		if self.last_flush.elapsed() >= MESSAGE_HOOK_COALESCE {
			self.flush();
		}
	}

	fn flush(&mut self) {
		let Some(batch) = self.pending.take() else {
			return;
		};
		notify_json(hook_pb::HookEventId::HookEventMessageUpdate, Some(self.gate.as_ref()), || {
			serde_json::json!({
				"turn_id": self.turn_id,
				"item_id": self.turn_id,
				"part_index": batch.part_index,
				"kind": batch.kind,
				"delta": batch.delta,
				"coalesced": batch.coalesced,
				"total_chars": self.total_chars,
			})
		});
		self.last_flush = Instant::now();
	}

	fn finish(&mut self, reason: &'static str) {
		if self.ended || self.parts.is_empty() {
			return;
		}
		self.flush();
		self.ended = true;
		notify_json(hook_pb::HookEventId::HookEventMessageEnd, Some(self.gate.as_ref()), || {
			serde_json::json!({
				"turn_id": self.turn_id,
				"item_id": self.turn_id,
				"role": "assistant",
				"parts": self.parts.len(),
				"finish": reason,
			})
		});
	}
}

impl Drop for MessageHookStream {
	fn drop(&mut self) {
		self.finish("error");
	}
}

const fn stream_part_kind(source: StreamSource) -> &'static str {
	match source {
		StreamSource::Text => "text",
		StreamSource::Thinking => "reasoning",
		StreamSource::Tool => "tool_args",
	}
}

fn authoritative_assistant(outcome: &Outcome) -> Option<Str> {
	let message = outcome.output.iter().rev().find_map(|item| {
		let Some(item::Kind::Message(message)) = item.kind.as_ref() else {
			return None;
		};
		(message.role() == thread::Role::Assistant).then_some(message)
	})?;
	let mut text = String::new();
	for part in &message.parts {
		if let Some(part::Kind::Text(value)) = part.kind.as_ref() {
			text.push_str(value);
		}
	}
	(!text.is_empty()).then(|| Str::from(text))
}

use std::{future, iter, mem};

use omp_inference::call::ToolChoice;
use omp_snapcompact::archive::DataUrlContext;
use omp_storage::gc;
use tokio::{
	sync::{watch, watch::Receiver},
	task::yield_now,
	time,
};

pub(crate) use crate::arbiter::context::{ActiveCheckpoint, CheckpointState, CompletedCheckpoint};
use crate::{
	AgentSettled, AgentSnapshot, ArbiterError, AutolearnController, AutolearnSettings,
	CaptureDecision, CommittedCall, Interrupt, InterruptClass, InterruptSource, ProviderErrorEvent,
	Regime, RegimeSpec, Resource, RevivalReport, ScopedSetting, SettingSlot, StartOptions,
	StartReceipt, TurnOptions, TurnReceipt, WaitError, WaitSet,
	arbiter::ResolvedEvent,
	attachments, batch, capture_interrupt, demote_interrupted_reasoning, dispatch_tier,
	effects_mutate_environment, execute_snapcompact, hook_event_mask, inject_first_turn_metadata,
	is_capture_item,
	journal::Compact,
	prompt_assets,
	prompt_assets::PromptAssetId,
	prompt_keys,
	regime::{ResolutionKind, SessionStopRegime, evaluate_regime},
	tool_choice::{RejectReason, ToolChoiceQueue},
};

/// A live user message that can be rewound and edited.
#[derive(Clone, Debug, PartialEq)]
pub struct RewindTarget {
	/// Physical event index of the user message.
	pub event: u64,
	/// Previous live item event to retain, or the transcript root.
	pub keep:  Option<u64>,
	/// Typed message text: plain text parts joined by newlines, excluding
	/// `<attachment>`-wrapped pastes.
	pub text:  Str,
	/// Non-prose parts (image blobs and `<attachment>` pastes) in message
	/// order, so hosts can restore the message into an editor.
	pub parts: Vec<thread::Part>,
}

/// Failure while projecting, submitting, recovering, journaling, or executing
/// tools.
#[derive(Debug, Error)]
pub enum AgentError {
	/// Durable journal operation failed.
	#[error(transparent)]
	Journal(#[from] JournalError),
	/// Regime arbitration or lifecycle journaling failed.
	#[error(transparent)]
	Arbiter(#[from] ArbiterError),
	/// Canonical thread projection failed.
	#[error(transparent)]
	Projection(#[from] ProjectionError),
	/// Snapcompact framing or savings admission failed.
	#[error(transparent)]
	Snapcompact(#[from] omp_snapcompact::archive::ArchiveError),
	/// Durable blob placement failed before a journal commit.
	#[error(transparent)]
	Blob(#[from] blob::Error),
	/// Artifact metadata publication failed before a prompt rewrite.
	#[error(transparent)]
	Artifact(#[from] gc::Error),
	/// Deterministic prompt rendering failed.
	#[error(transparent)]
	Prompt(#[from] PromptError),
	/// Live history serialization failed.
	#[error(transparent)]
	LiveHistory(#[from] serde_json::Error),
	/// Arbiter turn failed.
	#[error(transparent)]
	Turn(#[from] TurnError),
	/// Tool execution or lowering failed.
	#[error(transparent)]
	Batch(#[from] BatchError),
	/// A required-deadline regime wait expired or was aborted.
	#[error(transparent)]
	RegimeWait(#[from] WaitError),
	/// Manual compaction was cancelled before its history rewrite committed.
	#[error(transparent)]
	CompactionCancelled(#[from] CompactionCancellation),
	/// Arbiter stream or outcome violated the canonical turn contract.
	#[error("arbiter turn protocol violation: {0}")]
	Protocol(&'static str),
	/// A crash replay cannot reconstruct the exact frozen tool registry.
	#[error("durable turn toolset differs from the authoritative registry")]
	ToolsetMismatch {
		/// Registry identity fixed by the durable turn start.
		durable: Hash32,
		/// Registry identity published when replay was attempted.
		current: Hash32,
	},
	/// An in-turn duplex invocation failed.
	#[error("in-turn invocation failed: {0}")]
	Duplex(Str),
	/// The configured absolute deadline elapsed.
	#[error("agent turn deadline elapsed")]
	Deadline,
	/// The caller aborted the active submission.
	#[error("submission interrupted by caller")]
	Interrupted,
}

const _: () = assert!(std::mem::size_of::<AgentError>() <= 128, "AgentError must stay compact");

/// Cloneable out-of-band stop signal for the active submission.
#[derive(Clone, Debug)]
pub struct AbortHandle {
	tx: Arc<watch::Sender<u64>>,
}

impl AbortHandle {
	/// Aborts the active submission, if any.
	pub fn abort(&self) {
		self
			.tx
			.send_modify(|generation| *generation = generation.wrapping_add(1));
	}
}

/// Host activity assertion scoped to an active inference/tool run.
pub trait RunActivity: Send + Sync + 'static {
	/// Acquires the host activity assertion.
	fn enter(&self);
	/// Releases the host activity assertion.
	fn exit(&self);
}
/// Small-model decision boundary used only by smart unexpected-stop mode.
pub trait UnexpectedStopClassifier: Send + Sync + 'static {
	/// Returns whether a visible text-only stop should be continued.
	fn should_continue<'a>(
		&'a self,
		text: &'a str,
	) -> Pin<Box<dyn Future<Output = Result<bool, Str>> + Send + 'a>>;
}
/// Session-scoped difficulty classification for a newly submitted user turn.
pub trait TurnDifficultyClassifier: Send + Sync + 'static {
	/// Classifies concatenated text from the newly submitted user items.
	fn classify<'a>(
		&'a self,
		user_text: &'a str,
	) -> Pin<Box<dyn Future<Output = pb::Effort> + Send + 'a>>;
}

fn enabled_tools_resolve(registry: &ToolRegistry, names: &[Str]) -> bool {
	names
		.iter()
		.all(|name| registry.resolved_identity(name.as_str()).is_some())
}

fn submitted_user_text(items: &[Item]) -> Option<String> {
	let mut text = String::new();
	for item in items {
		let Some(item::Kind::Message(message)) = item.kind.as_ref() else {
			continue;
		};
		if message.role != thread::Role::User as i32 {
			continue;
		}
		for part in &message.parts {
			let Some(part::Kind::Text(value)) = part.kind.as_ref() else {
				continue;
			};
			if !text.is_empty() {
				text.push('\n');
			}
			text.push_str(value);
		}
	}
	(!text.is_empty()).then_some(text)
}

fn materialize_context_projection(
	projection: ContextProjection,
	base_snapshot_rev: u64,
	handler: Option<&dyn ContextProjectionHandler>,
) -> Thread {
	let (thread, view) = match projection {
		ContextProjection::Unchanged(thread) => return thread,
		ContextProjection::View { thread, view } => (thread, view),
	};
	let Some(handler) = handler else {
		return thread;
	};
	let Ok(patches) = handler.project(base_snapshot_rev, &view) else {
		return thread;
	};
	if patches.base_snapshot_rev() != base_snapshot_rev || patches.derived_ir_revision() == 0 {
		return thread;
	}
	apply_patches(thread, &view, patches.patches()).thread
}

#[must_use]
struct RunActivityGuard(Arc<dyn RunActivity>);

type TurnCompletion =
	(Outcome, BTreeMap<Str, SpeculativeCall>, Option<String>, Arc<AgentSnapshot>, Arc<[Str]>);

enum RunTurnResult {
	Complete(TurnCompletion),
	Cancelled(StreamCancel),
}

enum DriveSessionResult {
	Complete(Outcome, BTreeMap<Str, SpeculativeCall>),
	Cancelled(StreamCancel),
}
/// Cloneable request handle for state owned by the live agent loop.
#[derive(Clone)]
pub struct AgentHostControl {
	commands: flume::Sender<AgentHostCommand>,
}

struct AgentHostCommand {
	operation: Str,
	arguments: serde_json::Map<String, Value>,
	reply:     flume::Sender<Result<Value, Str>>,
}

impl AgentHostControl {
	/// Executes one correlated host lifecycle request on the sole mutable owner.
	pub async fn request(
		&self,
		operation: impl Into<Str>,
		arguments: serde_json::Map<String, Value>,
	) -> Result<Value, Str> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send_async(AgentHostCommand { operation: operation.into(), arguments, reply })
			.await
			.map_err(|_| sf!("agent loop is no longer live"))?;
		response
			.recv_async()
			.await
			.map_err(|_| sf!("agent loop stopped before servicing host lifecycle state"))?
	}
}

impl Drop for RunActivityGuard {
	fn drop(&mut self) {
		self.0.exit();
	}
}

mod receiver_channels {
	use flume::Receiver;

	use super::*;

	pub(super) struct ReceiverChannels {
		pub(super) hook_requests:      Receiver<InvocationHookRequest>,
		pub(super) invocation_fact_rx: Receiver<InvocationAdmissionFact>,
		pub(super) host_commands:      Receiver<AgentHostCommand>,
	}

	impl<C: TurnClient> Agent<C> {
		/// Returns the CONTROL-side receiver for invocation hook handoffs.
		///
		/// Clones compete for messages; one supervisor should own the receiver.
		pub fn hook_requests(&self) -> Receiver<InvocationHookRequest> {
			self.receivers.hook_requests.clone()
		}
	}
}

use receiver_channels::ReceiverChannels;

mod wire_tool_choice {
	use omp_proto::inference::v1::ToolChoice;

	pub(super) fn from_parts(mode: i32, name: String) -> ToolChoice {
		ToolChoice { mode, name, on_unsupported: 0 }
	}
}

/// Which flavor of history rewrite is awaiting reconciliation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HistoryRewriteCause {
	/// User- or extension-initiated rewind/reset: dropped job launches are
	/// cancelled.
	User,
	/// Checkpoint-regime rewind: exploration jobs survive by design.
	Checkpoint,
}

/// A journaled history rewrite whose environment-state reconciliation is
/// still outstanding.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PendingHistoryRewrite {
	/// Retained physical event; `None` when rewound to the root or reset.
	to:    Option<u64>,
	/// Rewrite flavor driving the background-job policy.
	cause: HistoryRewriteCause,
}

/// Durable agent loop composed from transport-neutral Phase 1 foundations.
pub struct Agent<C: TurnClient> {
	client: C,
	env: EnvClient,
	state: AgentState,
	journal: Journal,
	caps: CapsBase,
	events: EventBus,
	hook_bus: InvocationHookBus,
	invocation_fact_tx: flume::Sender<InvocationAdmissionFact>,
	receivers: ReceiverChannels,
	control_tx: ControlSender,
	control_mailbox: ControlMailbox,
	host_control: AgentHostControl,
	checkpoint_state: Arc<Mutex<CheckpointState>>,
	arbiter: Arbiter,
	tool_choices: ToolChoiceQueue,
	waits: WaitSet,
	pending_rewinds: VecDeque<ScheduledRewind>,
	pending_history_rewrite: Option<PendingHistoryRewrite>,
	stateful_components: Vec<Arc<dyn StatefulComponent>>,
	mailbox: Mailbox,
	jobs: Arc<JobBoard>,
	jobs_restored: bool,
	abort_tx: Arc<watch::Sender<u64>>,
	abort_rx: Receiver<u64>,
	phase: AgentPhase,
	context: Option<ContextRef>,
	cumulative_usage: pb::Usage,
	pending_reasoning_demotion: bool,
	prompt_hash: Option<PromptHash>,
	prompt_head_events: Vec<u64>,
	settled_gate: Option<Arc<HookGate>>,
	provider_error_gate: Option<Arc<HookGate>>,
	hook_gate: Option<Arc<HookGate>>,
	continuations: ContinuationLedger,
	continuation_policies: BTreeMap<Str, ContinuationPolicy>,
	session_stop_regime: SessionStopRegime,
	continuation_source: Option<Arc<dyn ContinuationSource>>,
	redemption_authority: Option<Arc<dyn RedemptionAuthority>>,
	loop_signal: LoopSignal,
	last_toolset_hash: Option<Hash32>,
	firehose: Arc<Firehose>,
	run_activity: Option<Arc<dyn RunActivity>>,
	prompt_memory_source: Option<Arc<dyn PromptMemorySnapshotSource>>,
	session_memory: Option<SessionMemory>,
	secret_obfuscator: Option<Arc<Mutex<SecretObfuscator>>>,
	compaction: CompactionCoordinator,
	compaction_running: bool,
	blob_store: Option<BlobStore>,
	artifact_catalog: Option<Arc<Mutex<ArtifactCatalog>>>,
	autolearn: Option<AutolearnController>,
	unexpected_stop_classifier: Option<Arc<dyn UnexpectedStopClassifier>>,
	difficulty_classifier: Option<Arc<dyn TurnDifficultyClassifier>>,
	context_projection_handler: Option<Arc<dyn ContextProjectionHandler>>,
	unexpected_stop_retries: u8,
	streaming_edit_guard: Option<Arc<StreamingEditGuard>>,
	advisor_tool_loop: Option<AdvisorToolLoopGuard>,
}

impl<C: TurnClient + Clone> Agent<C> {
	/// Constructs an agent with stable state, event, mailbox, and job handles.
	pub fn new(
		client: C,
		env: EnvClient,
		state: AgentState,
		journal: Journal,
		caps: CapsBase,
	) -> Self {
		let mailbox = Mailbox::new();
		let events = EventBus::new();
		let jobs = Arc::new(JobBoard::with_events(env.clone(), mailbox.sender(), events.clone()));
		let (abort_tx, abort_rx) = watch::channel(0_u64);
		let (hook_bus, hook_requests) = InvocationHookBus::channel();
		let (invocation_fact_tx, invocation_fact_rx) = flume::unbounded();
		let (control_tx, control_mailbox) = channel();
		let (host_commands_tx, host_commands) = flume::unbounded();
		let host_control = AgentHostControl { commands: host_commands_tx };
		control_tx.bind_host_control(host_control.clone());
		let checkpoint_state = control_tx.checkpoint_state();
		let mut context = None;
		let mut prompt_hash = None;
		let mut prompt_head_events = Vec::new();
		let mut last_toolset_hash = None;
		if let Some(start) = journal.latest_turn_start() {
			prompt_hash = Some(start.prompt_hash.into());
			prompt_head_events.clone_from(&start.prompt_head_events);
			last_toolset_hash = Some(start.toolset_hash);
			if !journal.is_turn_aborted(start.turn_id.as_str()) {
				let context_id = match &start.input {
					TurnInputRecord::Delta { context, .. } => Some(context.context_id.clone()),
					TurnInputRecord::Full { .. } => {
						start.options.context_id.as_ref().map(ToString::to_string)
					},
				};
				let expected = journal
					.latest_receipt()
					.and_then(|receipt| receipt.outcome.revision.clone())
					.or_else(|| match &start.input {
						TurnInputRecord::Delta { context, .. } => context.expected.clone(),
						TurnInputRecord::Full { .. } => None,
					});
				if let (Some(context_id), Some(expected)) = (context_id, expected) {
					context = Some(ContextRef { context_id, expected: Some(expected) });
				}
			}
		} else if let Some(receipt) = journal.latest_receipt() {
			prompt_hash = Some(receipt.prompt_hash.into());
			prompt_head_events.clone_from(&receipt.prompt_head_events);
		}
		if let Some((hash, head_events)) = journal.active_prompt() {
			prompt_hash = Some(hash.into());
			prompt_head_events = head_events.to_vec();
		}
		if let Ok(recovered) = recover_checkpoint_state(&journal) {
			*checkpoint_state.lock() = recovered;
		}
		Self {
			client,
			env,
			state,
			journal,
			caps,
			events,
			hook_bus,
			invocation_fact_tx,
			receivers: ReceiverChannels { hook_requests, invocation_fact_rx, host_commands },
			control_tx,
			control_mailbox,
			host_control,
			checkpoint_state,
			arbiter: Arbiter::new(),
			tool_choices: ToolChoiceQueue::new(),
			waits: WaitSet::default(),
			pending_rewinds: VecDeque::new(),
			pending_history_rewrite: None,
			stateful_components: Vec::new(),
			mailbox,
			jobs,
			jobs_restored: false,
			abort_tx: Arc::new(abort_tx),
			abort_rx,
			phase: AgentPhase::Idle,
			context,
			cumulative_usage: pb::Usage::default(),
			pending_reasoning_demotion: false,
			prompt_hash,
			prompt_head_events,
			settled_gate: None,
			provider_error_gate: None,
			hook_gate: None,
			continuations: ContinuationLedger::new(8),
			continuation_policies: BTreeMap::new(),
			session_stop_regime: SessionStopRegime::default(),
			continuation_source: None,
			redemption_authority: None,
			loop_signal: LoopSignal::default(),
			firehose: Arc::new(Firehose::new()),
			last_toolset_hash,
			run_activity: None,
			prompt_memory_source: None,
			session_memory: None,
			secret_obfuscator: None,
			compaction: CompactionCoordinator::default(),
			compaction_running: false,
			blob_store: None,
			artifact_catalog: None,
			autolearn: None,
			unexpected_stop_classifier: None,
			difficulty_classifier: None,
			context_projection_handler: None,
			unexpected_stop_retries: 0,
			streaming_edit_guard: None,
			advisor_tool_loop: None,
		}
	}

	/// Returns the authoritative configuration handle.
	pub const fn state(&self) -> &AgentState {
		&self.state
	}

	/// Selects one-at-a-time or all-at-once queued steering delivery.
	pub fn set_steering_mode(&self, mode: SteeringMode) {
		self.state.update(|snapshot| snapshot.steering_mode = mode);
	}

	/// Configures larger-context promotion attempted before overflow compaction.
	pub fn set_context_promotion(&self, policy: ContextPromotionPolicy) {
		self
			.state
			.update(|snapshot| snapshot.context_promotion = policy);
	}

	/// Configures synchronous compaction checks at safe tool-loop boundaries.
	pub fn set_mid_turn_compaction(&self, policy: MidTurnCompactionPolicy) {
		self
			.state
			.update(|snapshot| snapshot.mid_turn_compaction = policy);
	}

	/// Returns the named decision arbiter and durable regime owner.
	pub const fn arbiter(&self) -> &Arbiter {
		&self.arbiter
	}

	/// Returns mutable access to the named decision arbiter.
	pub const fn arbiter_mut(&mut self) -> &mut Arbiter {
		&mut self.arbiter
	}

	/// Starts and durably records one regime activation.
	pub fn start_regime(
		&mut self,
		spec: Arc<RegimeSpec>,
		handler: Box<dyn Regime>,
		options: StartOptions,
	) -> Result<StartReceipt, AgentError> {
		Ok(self
			.arbiter
			.start(spec, handler, &mut self.journal, options)?)
	}

	/// Stops and durably records one regime after minimum duration.
	pub fn stop_regime(&mut self, activation: &str, now_ms: u64) -> Result<bool, AgentError> {
		Ok(self.arbiter.stop(activation, now_ms, &mut self.journal)?)
	}

	/// Recovers durable regime activations through an application resolver.
	pub fn recover_regimes<F>(
		&mut self,
		resolve: F,
		now_ms: u64,
	) -> Result<RevivalReport, AgentError>
	where
		F: FnMut(&str) -> Option<(Arc<RegimeSpec>, Box<dyn Regime>)>,
	{
		Ok(self.arbiter.recover(&mut self.journal, resolve, now_ms)?)
	}

	/// Returns mutable access to future-turn tool directives.
	pub const fn tool_choices_mut(&mut self) -> &mut ToolChoiceQueue {
		&mut self.tool_choices
	}

	/// Returns a cloneable handle for resolving required-deadline regime waits.
	pub fn waits(&self) -> WaitSet {
		self.waits.clone()
	}

	/// Returns the ordered event feed handle.
	pub const fn events(&self) -> &EventBus {
		&self.events
	}

	/// Subscribes to a race-free collaboration catch-up and live journal feed.
	pub fn subscribe_collaboration(&mut self) -> Result<ReplicationSubscription, JournalError> {
		self.journal.subscribe_replication()
	}

	/// Returns a producer for asynchronous steering and settlement items.
	pub fn mailbox(&self) -> MailboxSender {
		self.mailbox.sender()
	}

	/// Returns the environment authority used for out-of-band live execution
	/// control.
	pub fn environment(&self) -> EnvClient {
		self.env.clone()
	}

	/// Replaces the registered hook union mask in one atomic publication.
	pub fn replace_hook_mask(&self, mask: u128) {
		self.hook_bus.replace_union_mask(mask);
	}

	/// Returns a sender for authenticated extension CONTROL operations.
	pub fn control(&self) -> ControlSender {
		self.control_tx.clone()
	}

	/// Returns the live host authority for lifecycle state that cannot be
	/// reconstructed from configuration snapshots.
	pub fn host_control(&self) -> AgentHostControl {
		self.host_control.clone()
	}

	/// Installs the fail-open `agent_settled` hook gate for this durable loop.
	pub fn set_agent_settled_gate(&mut self, gate: Arc<HookGate>, cap: u32) {
		self.settled_gate = Some(gate);
		self.continuations = ContinuationLedger::new(cap);
	}

	/// Installs the fail-closed `provider_error` domain hook gate.
	pub fn set_provider_error_gate(&mut self, gate: Arc<HookGate>) {
		self.provider_error_gate = Some(gate);
	}

	/// Installs the catalog hook gate used by agent, message, and tool seams.
	pub fn set_hook_gate(&mut self, gate: Arc<HookGate>) {
		self.hook_gate = Some(gate);
	}

	/// Returns the active regime prompt setting.
	pub fn prompt_slot(&self) -> Option<&str> {
		self
			.arbiter
			.regimes()
			.resources()
			.current(&SettingSlot::PromptSlot)
	}

	fn invocation_mode_props(
		&mut self,
		effects: &omp_tool::Effects,
	) -> Result<pb::ValueMap, AgentError> {
		let mode = self
			.arbiter
			.regimes()
			.resources()
			.current(&SettingSlot::PromptSlot)
			.map(Str::new);
		let mut prewalk_activation = None;
		if effects_mutate_environment(effects)
			&& mode
				.as_ref()
				.is_some_and(|mode| matches!(mode.as_str(), "plan-yolo" | "prewalk"))
		{
			if mode.as_deref() == Some("prewalk") {
				prewalk_activation = self
					.arbiter
					.regimes()
					.resources()
					.owner(&Resource::Mode)
					.map(Str::new);
			} else {
				self
					.arbiter
					.regimes_mut()
					.resources_mut()
					.pop(&SettingSlot::PromptSlot);
			}
		}
		if let Some(activation) = prewalk_activation {
			self.stop_regime(activation.as_str(), now_ms())?;
			if let Some(source) = self.continuation_source.as_ref() {
				source.sync_regimes(self.arbiter.regimes());
			}
		}
		Ok(batch::invocation_mode_props(mode.as_deref(), effects))
	}

	/// Installs one application-owned autonomous-mode continuation source.
	pub fn set_continuation_source(&mut self, source: Arc<dyn ContinuationSource>) {
		self.continuation_source = Some(source);
	}

	/// Installs the cold app-owned provider redemption authority.
	pub fn set_redemption_authority(&mut self, authority: Arc<dyn RedemptionAuthority>) {
		self.redemption_authority = Some(authority);
	}

	/// Installs a bounded provider failover route regime.
	pub fn set_provider_failover_routes(&mut self, routes: Vec<Str>) {
		self.arbiter.set_retry_chain(routes);
	}

	fn apply_provider_failover(&mut self, routes: Vec<Str>) {
		if let Some(next) = routes.first() {
			emit_fallback_model_changed(
				self.hook_gate.as_deref(),
				|| {
					let snapshot = self.state.snapshot();
					(
						snapshot.turn.params.model.clone(),
						snapshot
							.turn
							.params
							.thinking
							.as_ref()
							.map(|thinking| thinking.effort),
					)
				},
				next,
			);
		}
		self.arbiter.set_retry_chain(routes);
	}

	/// Returns Core's latest loop-repetition and progress evidence.
	pub const fn loop_signal(&self) -> &LoopSignal {
		&self.loop_signal
	}

	/// Returns the latest recursive continuation ledger projection.
	pub const fn continuations(&self) -> &ContinuationLedger {
		&self.continuations
	}

	/// Replaces the non-blocking telemetry fan-out used by this loop.
	pub fn set_firehose(&mut self, firehose: Arc<Firehose>) {
		self.firehose = firehose;
	}

	/// Installs the session-local secret transform used only for model-authored
	/// tool arguments.
	pub fn set_secret_obfuscator(&mut self, obfuscator: Arc<Mutex<SecretObfuscator>>) {
		self.secret_obfuscator = Some(obfuscator);
	}

	/// Installs the smart unexpected-stop classifier.
	pub fn set_unexpected_stop_classifier(&mut self, classifier: Arc<dyn UnexpectedStopClassifier>) {
		self.unexpected_stop_classifier = Some(classifier);
	}

	/// Installs the classifier sampled once for each newly submitted user turn.
	pub fn set_difficulty_classifier(&mut self, classifier: Arc<dyn TurnDifficultyClassifier>) {
		self.difficulty_classifier = Some(classifier);
	}

	/// Installs the session-local model-context projection handler.
	pub fn set_context_projection_handler(&mut self, handler: Arc<dyn ContextProjectionHandler>) {
		self.context_projection_handler = Some(handler);
	}

	/// Configures early validation for streamed edit arguments.
	pub fn configure_streaming_edit_guard(&mut self, cwd: std::path::PathBuf, enabled: bool) {
		self.streaming_edit_guard = Some(Arc::new(StreamingEditGuard::new(cwd, enabled)));
	}

	/// Enables the repeated-tool-call safety ladder for an advisor agent.
	///
	/// Hosts must call this only for agents registered as
	/// [`crate::AgentKind::Advisor`].
	pub fn enable_advisor_tool_loop_guard(&mut self) {
		self.advisor_tool_loop = Some(AdvisorToolLoopGuard::new(ADVISOR_TOOL_LOOP_THRESHOLD));
	}

	/// Returns the shared non-blocking telemetry fan-out handle.
	pub fn firehose(&self) -> Arc<Firehose> {
		Arc::clone(&self.firehose)
	}

	/// Returns a cloneable out-of-band stop signal.
	pub fn abort_handle(&self) -> AbortHandle {
		AbortHandle { tx: Arc::clone(&self.abort_tx) }
	}

	/// Returns detached-job settlement state.
	pub const fn jobs(&self) -> &Arc<JobBoard> {
		&self.jobs
	}

	/// Returns the durable journal owner.
	pub const fn journal(&self) -> &Journal {
		&self.journal
	}

	/// Appends one supervisor-owned child lifecycle transition through the
	/// session's sole mutable journal authority.
	pub fn record_child_lifecycle(
		&mut self,
		ts: u64,
		entry: ChildLifecycleEntry,
	) -> Result<u64, JournalError> {
		self.journal.append_child_lifecycle(ts, entry)
	}

	/// Appends one host-selected session model override through the live agent's
	/// sole mutable journal authority.
	pub fn record_model_override(
		&mut self,
		ts: u64,
		model: omp_storage::transcript::ModelChange,
	) -> Result<u64, JournalError> {
		self.journal.model_override(ts, model)
	}

	/// Installs the app-owned content-addressed store used by durable bitmap
	/// compaction. The app is the DI boundary; agent code never opens host
	/// paths.
	pub fn set_blob_store(&mut self, blob_store: BlobStore) {
		self.blob_store = Some(blob_store);
	}

	/// Installs the app-owned artifact metadata authority used by `/shake`.
	pub fn set_artifact_catalog(&mut self, catalog: Arc<Mutex<ArtifactCatalog>>) {
		self.artifact_catalog = Some(catalog);
	}

	/// Applies the mechanical `/shake` tiers while retaining a warm recent tail.
	///
	/// Elided source is put in the app-injected blob authority before its live
	/// prompt part is replaced, so every placeholder remains recoverable.
	pub fn shake_manual(&mut self, mode: ManualShakeMode) -> Result<ManualShakeOutcome, AgentError> {
		if self.journal.pending_turn().is_some() {
			return Err(AgentError::Protocol("cannot shake while a turn is pending"));
		}
		let prompt_hash = self
			.prompt_hash
			.ok_or(AgentError::Protocol("cannot shake before the prompt is assembled"))?;
		let live_events = self.journal.live_item_events()?;
		let mut items = self.journal.items_at(&live_events)?;
		if items.is_empty() {
			return Err(AgentError::Protocol("nothing to shake"));
		}
		if mode == ManualShakeMode::Thinking {
			let mut replaced_regions = 0_u64;
			let mut removed_bytes = 0_u64;
			for item in &mut items {
				let Some(item::Kind::Message(message)) = item.kind.as_mut() else {
					continue;
				};
				if message.role != i32::from(thread::Role::Assistant) {
					continue;
				}
				let mut kept = Vec::with_capacity(message.parts.len());
				for part in mem::take(&mut message.parts) {
					if matches!(part.kind, Some(part::Kind::Thinking(_))) {
						replaced_regions = replaced_regions.saturating_add(1);
						removed_bytes = removed_bytes.saturating_add(
							u64::try_from(serde_json::to_vec(&part)?.len()).unwrap_or(u64::MAX),
						);
					} else {
						kept.push(part);
					}
				}
				message.parts = kept;
			}
			if replaced_regions == 0 {
				return Err(AgentError::Protocol("no thinking blocks found in this session"));
			}
			let rewritten = self
				.journal
				.rewrite_prompt_head(now_ms(), prompt_hash, &items, &[])?;
			self.clear_provider_context();
			self.prompt_hash = None;
			self.prompt_head_events.clone_from(&rewritten);
			self.last_toolset_hash = None;
			return Ok(ManualShakeOutcome {
				mode,
				replaced_regions,
				removed_bytes,
				event: rewritten.last().copied().unwrap_or_default(),
			});
		}
		let tier = match mode {
			ManualShakeMode::Elide => CompactionTier::Elide,
			ManualShakeMode::DropMedia => CompactionTier::DropMedia,
			ManualShakeMode::Thinking => unreachable!("thinking returned after its rewrite"),
		};
		let store = self
			.blob_store
			.as_ref()
			.ok_or(AgentError::Protocol("shake blob store is not configured"))?;
		let catalog = self
			.artifact_catalog
			.as_ref()
			.ok_or(AgentError::Protocol("shake artifact catalog is not configured"))?;
		const PROTECTED_TAIL_BYTES: usize = 16_000;
		let mut tail_bytes = 0usize;
		let mut protected_start = items.len();
		for (index, item) in items.iter().enumerate().rev() {
			if tail_bytes >= PROTECTED_TAIL_BYTES {
				break;
			}
			protected_start = index;
			tail_bytes = tail_bytes.saturating_add(serde_json::to_vec(item)?.len());
		}
		let mut replaced_regions = 0_u64;
		let mut removed_bytes = 0_u64;
		for item in &mut items[..protected_start] {
			shake_item(
				item,
				tier,
				store,
				catalog,
				self.journal.session_id(),
				&mut replaced_regions,
				&mut removed_bytes,
			)?;
		}
		if replaced_regions == 0 {
			return Err(AgentError::Protocol("nothing eligible to shake"));
		}
		let rewritten = self
			.journal
			.rewrite_prompt_head(now_ms(), prompt_hash, &items, &[])?;
		self.clear_provider_context();
		self.prompt_head_events.clone_from(&rewritten);
		Ok(ManualShakeOutcome {
			mode,
			replaced_regions,
			removed_bytes,
			event: rewritten.last().copied().unwrap_or_default(),
		})
	}

	/// Executes and durably commits a one-off manual compaction.
	///
	/// Local and remote modes use an isolated model-driven summarization turn.
	/// Remote mode requests the provider's compaction behavior first and falls
	/// back to the same portable summary contract. Snapcompact renders locally,
	/// puts source and PNG bytes into the injected `BlobStore`, then appends the
	/// only journal reference after every put succeeds.
	pub async fn compact_manual(
		&mut self,
		request: ManualCompactionRequest,
	) -> Result<ManualCompactionOutcome, AgentError> {
		self
			.compact_with_reason(request, CompactionReason::Manual)
			.await
	}

	async fn compact_with_reason(
		&mut self,
		request: ManualCompactionRequest,
		reason: CompactionReason,
	) -> Result<ManualCompactionOutcome, AgentError> {
		if self.compaction_running {
			return Err(AgentError::Protocol("compaction is already running"));
		}
		self.compaction_running = true;
		let preparation_id = Str::new(omp_core::Ulid::generate().to_string());
		let tier = request.mode.map_or("local", |mode| match mode {
			ManualCompactionMode::Soft | ManualCompactionMode::Snapcompact => "local",
			ManualCompactionMode::Remote => "remote",
		});
		let result = self
			.compact_manual_inner(request, preparation_id.clone(), reason)
			.await;
		self.compaction_running = false;
		if let Err(error) = &result {
			let epoch = self.journal.context_position().epoch;
			let warning = error.to_string();
			notify_json(
				hook_pb::HookEventId::HookEventCompactionDone,
				self.hook_gate.as_deref(),
				|| {
					serde_json::json!({
						"preparation_id": preparation_id,
						"tiers_run": [tier],
						"from_extension": Value::Null,
						"tokens_before": 0,
						"tokens_after": 0,
						"first_kept_id": "",
						"epoch": epoch,
						"summary_bytes": 0,
						"warning": warning,
					})
				},
			);
		}
		result
	}

	async fn compact_manual_inner(
		&mut self,
		request: ManualCompactionRequest,
		preparation_id: Str,
		reason: CompactionReason,
	) -> Result<ManualCompactionOutcome, AgentError> {
		if self.journal.pending_turn().is_some() {
			return Err(AgentError::Protocol("cannot compact while a turn is pending"));
		}
		self.abort_rx.mark_unchanged();
		let decision = self
			.compaction
			.begin_manual(request, &CompactionMethodOrder::default());
		let method = decision
			.order
			.as_slice()
			.iter()
			.find(|tier| {
				matches!(
					tier,
					CompactionTier::Local | CompactionTier::Remote | CompactionTier::Snapcompact
				)
			})
			.copied()
			.ok_or(AgentError::Protocol("manual compaction has no available summary method"))?;
		let live_events = self.journal.live_item_events()?;
		let live_items = self.journal.items_at(&live_events)?;
		if live_items.len() < 2 {
			return Err(AgentError::Protocol("nothing to compact"));
		}
		let item_bytes = live_items
			.iter()
			.map(serde_json::to_vec)
			.collect::<Result<Vec<_>, _>>()?;
		let mut suffix_bytes = 0usize;
		let mut prefix_end = live_items.len();
		for (index, bytes) in item_bytes.iter().enumerate().rev() {
			if suffix_bytes >= (PROMPT_CACHE_WARM_SUFFIX_TOKENS as usize).saturating_mul(4) {
				break;
			}
			prefix_end = index;
			suffix_bytes = suffix_bytes.saturating_add(bytes.len());
		}
		if prefix_end == 0 {
			prefix_end = live_items.len() - 1;
			suffix_bytes = item_bytes[prefix_end].len();
		}
		let first_kept = live_events[prefix_end];
		let prefix_bytes = item_bytes[..prefix_end]
			.iter()
			.fold(0usize, |sum, bytes| sum.saturating_add(bytes.len()));
		let total_bytes = prefix_bytes.saturating_add(suffix_bytes);
		let tokens_before = u64::try_from(total_bytes.div_ceil(4)).unwrap_or(u64::MAX);
		let source_tokens = u64::try_from(prefix_bytes.div_ceil(4)).unwrap_or(u64::MAX);
		let mode = match method {
			CompactionTier::Local => ManualCompactionMode::Soft,
			CompactionTier::Remote => ManualCompactionMode::Remote,
			CompactionTier::Snapcompact => ManualCompactionMode::Snapcompact,
			CompactionTier::Prune
			| CompactionTier::DropMedia
			| CompactionTier::Elide
			| CompactionTier::Handoff => {
				return Err(AgentError::Protocol("unsupported manual compaction method"));
			},
		};
		let compaction_event = CompactionEvent {
			preparation_id: preparation_id.clone(),
			tier: method,
			reason,
			epoch: self.journal.context_position().epoch,
			tokens_before,
			target_tokens: u64::try_from(suffix_bytes.div_ceil(4)).unwrap_or(u64::MAX),
			suggested_first_kept: Str::new(first_kept.to_string()),
			to_summarize: live_events[..prefix_end]
				.iter()
				.zip(&live_items[..prefix_end])
				.zip(&item_bytes[..prefix_end])
				.map(|((&event, item), bytes)| compaction_message_ref(event, item, bytes.len()))
				.collect(),
			to_retain: live_events[prefix_end..]
				.iter()
				.zip(&live_items[prefix_end..])
				.zip(&item_bytes[prefix_end..])
				.map(|((&event, item), bytes)| compaction_message_ref(event, item, bytes.len()))
				.collect(),
			split_turn: false,
			previous_summary: None,
			previous_preserve: None,
			custom_instructions: decision.focus.clone(),
			deadline_ms: 30_000,
		};
		let resolution = self.dispatch_compaction_hook(&compaction_event).await;
		let mut delegate = None;
		let mut from_extension = None;
		let mut hook_warning = None;
		let custom = match resolution {
			CompactionResolution::Cancel(cancel) => {
				return Err(CompactionCancellation::ExtensionVeto { reason: cancel.reason }.into());
			},
			CompactionResolution::Custom { mut winner, source, losers } => {
				if !live_events.contains(&winner.compact.first_kept) {
					hook_warning = Some(sf!(
						"extension compaction summary named a non-live first-kept item; used built-in \
						 compaction"
					));
					None
				} else {
					from_extension = source;
					let retained_start = live_events
						.iter()
						.position(|event| *event == winner.compact.first_kept)
						.expect("validated live first-kept item");
					let retained_bytes = item_bytes[retained_start..]
						.iter()
						.fold(0usize, |sum, bytes| sum.saturating_add(bytes.len()));
					let summary_tokens =
						u64::try_from(winner.compact.summary.len().div_ceil(4)).unwrap_or(u64::MAX);
					winner.compact.tokens_before = tokens_before;
					winner.compact.tokens_after = Some(
						summary_tokens
							.saturating_add(u64::try_from(retained_bytes.div_ceil(4)).unwrap_or(u64::MAX)),
					);
					winner.compact.method = Some(sf!("extension"));
					winner.compact.superseded = losers;
					Some(winner.compact)
				}
			},
			CompactionResolution::Delegate(value) => {
				delegate = Some(value);
				None
			},
			CompactionResolution::Default => None,
		};

		let mut compact = if let Some(compact) = custom {
			compact
		} else if mode == ManualCompactionMode::Snapcompact {
			let source = serde_json::to_string(&live_items[..prefix_end])?;
			let source =
				omp_snapcompact::archive::elide_data_urls(&source, DataUrlContext::Source).into_owned();
			let model = self.state.snapshot().turn.params.model.clone();
			let preparation = SnapcompactPreparation {
				text: Str::from(source),
				source_tokens,
				provider: model
					.split_once('/')
					.map(|(provider, _)| Str::new(provider)),
				api: None,
				model_id: Some(Str::from(model)),
				existing_images: 0,
				first_kept,
				tokens_before,
			};
			let mut rendered = execute_snapcompact(&preparation)?;
			let store = self
				.blob_store
				.as_ref()
				.ok_or(AgentError::Protocol("snapcompact blob store is not configured"))?;
			let source_ref = store.put(preparation.text.as_bytes())?;
			let mut frame_refs = Vec::with_capacity(rendered.archive.frames.len());
			for frame in &rendered.archive.frames {
				frame_refs.push(store.put(&frame.png)?);
			}
			let shape = rendered.archive.frames.first().map_or_else(
				|| sf!("empty"),
				|frame| {
					sf!(
						"{}:{}x{}:{}:{}",
						frame.shape.font,
						frame.shape.cell_width,
						frame.shape.cell_height,
						frame.shape.variant,
						frame.shape.frame_size
					)
				},
			);
			rendered.compact.snapcompact = Some(SnapcompactArchive {
				source: source_ref,
				frames: frame_refs,
				source_tokens: rendered.archive.savings.source_tokens,
				image_tokens: rendered.archive.savings.image_tokens,
				png_bytes: u64::try_from(rendered.archive.savings.png_bytes).unwrap_or(u64::MAX),
				truncated_chars: u64::try_from(rendered.archive.truncated_chars).unwrap_or(u64::MAX),
				shape,
			});
			rendered.compact
		} else {
			let mut thread = Thread { items: live_items[..prefix_end].to_vec(), ..Default::default() };
			let focus = decision.focus.as_deref().unwrap_or(
				"Preserve decisions, completed work, open tasks, paths, commands, errors, and \
				 constraints.",
			);
			let remote = mode == ManualCompactionMode::Remote;
			let mut instruction = if remote {
				sf!(
					"Produce a portable provider-compaction summary of the preceding conversation. \
					 Focus: {focus}"
				)
			} else {
				sf!("Summarize the preceding conversation for context continuation. Focus: {focus}")
			};
			if let Some(delegate) = &delegate {
				if !delegate.extra_instructions.is_empty() {
					instruction = sf!(
						"{}\nAdditional extension instructions: {}",
						instruction.as_str(),
						delegate.extra_instructions.as_str()
					);
				}
				if !delegate.focus_ids.is_empty() {
					let ids = delegate
						.focus_ids
						.iter()
						.map(Str::as_str)
						.collect::<Vec<_>>()
						.join(", ");
					instruction = sf!(
						"{}\nPreserve these context item ids in the summary: {ids}",
						instruction.as_str()
					);
				}
			}
			thread.items.push(compaction_instruction(instruction));
			let snapshot = self.state.snapshot();
			let mut options = snapshot.turn.clone();
			options.context_id = None;
			options.executor = None;
			options.params.tools.clear();
			let registry = Arc::new(ToolRegistry::new());
			drop(snapshot);
			let turn_id = TurnId::new(omp_core::Ulid::generate().to_string());
			let mut abort_rx = self.abort_rx.clone();
			let result = {
				let session = self.drive_session(
					turn_id,
					TurnInput::Full(thread),
					&options,
					registry,
					Arc::from([]),
					true,
				);
				tokio::pin!(session);
				tokio::select! {
					biased;
					changed = abort_rx.changed() => {
						changed.map_err(|_| AgentError::Protocol("compaction abort signal closed"))?;
						None
					},
					result = &mut session => Some(result),
				}
			};
			let Some(result) = result else {
				self.abort_rx.mark_unchanged();
				return Err(CompactionCancellation::UserInterrupt.into());
			};
			let result = result?;
			let DriveSessionResult::Complete(outcome, _) = result else {
				return Err(AgentError::Protocol("hidden compaction stream was interrupted"));
			};
			let summary = authoritative_assistant(&outcome)
				.ok_or(AgentError::Protocol("compaction summarizer returned no text"))?;
			let summary_tokens = u64::try_from(summary.len().div_ceil(4)).unwrap_or(u64::MAX);
			Compact {
				summary,
				short: None,
				first_kept,
				tokens_before,
				tokens_after: Some(
					summary_tokens
						.saturating_add(u64::try_from(suffix_bytes.div_ceil(4)).unwrap_or(u64::MAX)),
				),
				method: Some(Str::from(mode.to_string())),
				warning: None,
				snapcompact: None,
				superseded: Vec::new(),
			}
		};
		if compact.warning.is_none() {
			compact.warning = hook_warning;
		}
		let tokens_after = compact.tokens_after.unwrap_or(tokens_before);
		let first_kept = compact.first_kept;
		let summary_bytes = compact.summary.len();
		let warning = compact.warning.clone();
		let frame_count = compact
			.snapcompact
			.as_ref()
			.map_or(0, |archive| archive.frames.len());
		let event = self.journal.compact(now_ms(), compact)?;
		let epoch = self.journal.context_position().epoch;
		notify_json(hook_pb::HookEventId::HookEventCompactionDone, self.hook_gate.as_deref(), || {
			serde_json::json!({
				"preparation_id": preparation_id.clone(),
				"tiers_run": [match mode {
					ManualCompactionMode::Remote => "remote",
					ManualCompactionMode::Soft | ManualCompactionMode::Snapcompact => "local",
				}],
				"from_extension": from_extension.clone(),
				"tokens_before": tokens_before,
				"tokens_after": tokens_after,
				"first_kept_id": first_kept.to_string(),
				"epoch": epoch,
				"summary_bytes": summary_bytes,
				"warning": warning.clone(),
			})
		});
		self.clear_provider_context();
		self.prompt_hash = None;
		self.prompt_head_events.clear();
		self
			.redeem_recovery(RedemptionEvidence::PostCompaction { epoch })
			.await;
		Ok(ManualCompactionOutcome {
			preparation_id,
			method: mode,
			event,
			first_kept,
			epoch,
			tokens_before,
			tokens_after,
			summary_bytes,
			from_extension,
			warning,
			frame_count,
		})
	}

	async fn dispatch_compaction_hook(&mut self, event: &CompactionEvent) -> CompactionResolution {
		let Some(gate) = self.hook_gate.clone() else {
			return CompactionResolution::Default;
		};
		let dispatch = dispatch_tier(&gate, event);
		tokio::pin!(dispatch);
		loop {
			tokio::select! {
				resolution = &mut dispatch => break resolution,
				command = self.receivers.host_commands.recv_async() => {
					match command {
						Ok(command) if command.operation.as_str() == "omp.context.compact" => {
							let _ = command.reply.send(Err(sf!(
								"CompactionBusy: compaction is already running"
							)));
						},
						Ok(command) => self.handle_host_control_sync(command),
						Err(_) => std::future::pending().await,
					}
				},
			}
		}
	}

	fn promote_context_if_enabled(&mut self) -> bool {
		let snapshot = self.state.snapshot();
		let policy = &snapshot.context_promotion;
		let Some(target) = policy.enabled.then_some(policy.target.as_ref()).flatten() else {
			return false;
		};
		if snapshot.turn.params.model == target.as_str() {
			return false;
		}
		let target = target.clone();
		self.state.update(|snapshot| {
			snapshot.turn.params.model = target.to_string();
			snapshot.turn.provider_reset = true;
		});
		self.clear_provider_context();
		self.prompt_hash = None;
		self.prompt_head_events.clear();
		true
	}

	async fn recover_context_overflow(
		&mut self,
		order: &CompactionMethodOrder,
		reason: CompactionReason,
	) -> bool {
		let mode = order.as_slice().iter().find_map(|tier| match tier {
			CompactionTier::Local => Some(ManualCompactionMode::Soft),
			CompactionTier::Snapcompact => Some(ManualCompactionMode::Snapcompact),
			CompactionTier::Remote => Some(ManualCompactionMode::Remote),
			CompactionTier::Prune
			| CompactionTier::DropMedia
			| CompactionTier::Elide
			| CompactionTier::Handoff => None,
		});
		let Some(mode) = mode else {
			return false;
		};
		self
			.compact_with_reason(ManualCompactionRequest { mode: Some(mode), focus: None }, reason)
			.await
			.is_ok()
	}

	// Answers a read-only side projection without mutating provider or journal
	// state.
	fn answer_project_thread(&self, reply: flume::Sender<Result<Thread, ControlError>>) {
		let result: Result<Thread, ControlError> = (|| {
			let view = self.journal.load()?;
			let all_live = self.journal.live_item_events()?;
			let snapshot = self.state.snapshot();
			let projected =
				project_journal(&view, view.as_ref(), snapshot.registry.as_ref(), &self.caps)?;
			Ok(match project_context(projected, &all_live, false) {
				ContextProjection::Unchanged(thread) | ContextProjection::View { thread, .. } => thread,
			})
		})();
		let _ = reply.send(result);
	}

	/// Rewinds the durable session to a live prefix and returns the fresh
	/// projection.
	pub fn rewind(&mut self, to: Option<u64>) -> Result<Vec<Item>, AgentError> {
		let event = self.journal.truncate_to(now_ms(), to)?;
		self.firehose.publish(FirehoseEvent::Branch(Branch {
			envelope:   telemetry_envelope(),
			op:         Some(BranchOp::Switch),
			from_entry: to,
			to_entry:   Some(event),
		}));
		self.mailbox.discard_producer_interrupts();
		self.clear_provider_context();
		self.prompt_hash = None;
		self.prompt_head_events.clear();
		self.last_toolset_hash = None;
		*self.checkpoint_state.lock() = recover_checkpoint_state(&self.journal)?;
		let journal = self.journal.load()?;
		let projected = project_journal(
			&journal,
			journal.as_ref(),
			self.state.snapshot().registry.as_ref(),
			&self.caps,
		)?;
		drop(journal);
		self.pending_history_rewrite =
			Some(PendingHistoryRewrite { to, cause: HistoryRewriteCause::User });
		Ok(projected.items)
	}

	/// Settles a pending history rewrite: restores journal-derived environment
	/// state, applies the background-job policy, and notifies observers.
	///
	/// No-op when no rewrite is outstanding. Environment failures are logged
	/// and never returned; journal failures propagate.
	pub async fn reconcile_history_rewrite(&mut self) -> Result<(), AgentError> {
		let Some(PendingHistoryRewrite { to, cause }) = self.pending_history_rewrite else {
			return Ok(());
		};
		for component in &self.stateful_components {
			component.restore(&self.journal, &self.env).await;
		}
		if !self.jobs_restored {
			for job in self.journal.pending_jobs() {
				self.jobs.register(job.clone());
			}
			self.jobs_restored = true;
		}
		let mut cancelled: Vec<Str> = Vec::new();
		let mut escalate: Vec<Str> = Vec::new();
		if cause == HistoryRewriteCause::User {
			let dropped: Vec<Str> = {
				let log = self.journal.load()?;
				let live = log.as_ref();
				self
					.journal
					.pending_jobs_with_events()
					.filter(|(index, _)| !live.contains(*index))
					.map(|(_, job)| job.id.clone())
					.collect()
			};
			for id in dropped {
				match self.jobs.cancel(&id, REWIND_JOB_GRACE).await {
					Ok(CancelOutcome::Accepted) => cancelled.push(id),
					Ok(CancelOutcome::AlreadySettled | CancelOutcome::Missing) => {},
					Err(JobError::AgentLoopCancellation { .. }) => {
						escalate.push(id.clone());
						cancelled.push(id);
					},
					Err(error) => {
						tracing::warn!(job = id.as_str(), %error, "rewind job cancellation failed");
					},
				}
			}
		}
		let running: Vec<Str> = self
			.journal
			.pending_jobs()
			.map(|job| job.id.clone())
			.filter(|id| !cancelled.contains(id))
			.collect();
		if !running.is_empty() {
			self.journal.append_optimistic(
				now_ms(),
				rewind_background_warning(running.len()),
				self.prompt_hash,
			)?;
		}
		let head = u64::try_from(self.journal.load()?.len().saturating_sub(1))
			.expect("event indexes fit in u64");
		notify_json(hook_pb::HookEventId::HookEventSessionRewound, self.hook_gate.as_deref(), || {
			serde_json::json!({
				"to_event": to,
				"new_head": head,
				"restored_workspace": false,
				"running_jobs": running,
				"cancelled_jobs": cancelled,
			})
		});
		self
			.events
			.publish(AgentEvent::HistoryRewritten { to, head, escalate_jobs: escalate });
		self.pending_history_rewrite = None;
		Ok(())
	}

	/// Seeds resumed sessions with journal-derived environment state.
	///
	/// Stateful components only: `session_start{resumed}` already notifies
	/// extensions, and job watchers lazily re-register on the next submit.
	pub async fn restore_session_state(&mut self) -> Result<(), AgentError> {
		for component in &self.stateful_components {
			component.restore(&self.journal, &self.env).await;
		}
		Ok(())
	}

	/// Registers one journal-derived environment-state component re-seeded
	/// after history rewrites and on session resume.
	pub fn add_stateful_component(&mut self, component: Arc<dyn StatefulComponent>) {
		self.stateful_components.push(component);
	}

	/// Journals the durable snapshot of a user-driven todo edit.
	pub fn append_todo_edit(&mut self, phases: &RawValue) -> Result<u64, AgentError> {
		Ok(self.journal.todo_edit(now_ms(), phases)?)
	}

	/// Lists live user messages from oldest to newest for rewind selection.
	pub fn rewind_targets(&self) -> Result<Vec<RewindTarget>, AgentError> {
		let events = self.journal.live_item_events()?;
		let items = self.journal.items_at(&events)?;
		let mut targets = Vec::new();
		let mut previous = None;
		for (event, item) in events.into_iter().zip(items) {
			let Some(item::Kind::Message(message)) = item.kind.as_ref() else {
				previous = Some(event);
				continue;
			};
			if message.role != thread::Role::User as i32 {
				previous = Some(event);
				continue;
			}
			let synthetic = item
				.props
				.as_ref()
				.is_some_and(|props| props.fields.contains_key(omp_tool::TOOL_REV_PROP));
			let mut text = String::new();
			let mut parts = Vec::new();
			for part in &message.parts {
				match part.kind.as_ref() {
					Some(part::Kind::Text(body)) if body.starts_with("<attachment>") => {
						parts.push(part.clone());
					},
					Some(part::Kind::Text(body)) => {
						if !text.is_empty() {
							text.push('\n');
						}
						text.push_str(body);
					},
					Some(part::Kind::Blob(_)) => parts.push(part.clone()),
					_ => {},
				}
			}
			if !synthetic && !text.starts_with("<system-injection>") {
				targets.push(RewindTarget { event, keep: previous, text: Str::new(text), parts });
			}
			previous = Some(event);
		}
		Ok(targets)
	}

	/// Rewinds to and resubmits the latest live user turn.
	///
	/// Returns `None` when the transcript has no retryable user turn. The
	/// returned items are the fresh rewind projection used to rebuild callers'
	/// transcript views.
	pub async fn retry_last_turn(
		&mut self,
		turn_id: TurnId,
	) -> Result<Option<(Vec<Item>, Str, AgentRunSummary)>, AgentError> {
		let Some(target) = self.rewind_targets()?.pop() else {
			return Ok(None);
		};
		let text = target.text;
		let items = self.rewind(target.keep)?;
		self.reconcile_history_rewrite().await?;
		let item = Item {
			seq:           0,
			created_at_ms: now_ms(),
			kind:          Some(item::Kind::Message(thread::Message {
				role:  i32::from(thread::Role::User),
				parts: vec![thread::Part { kind: Some(part::Kind::Text(text.to_string())) }],
			})),
			props:         None,
		};
		let summary = self.submit([item], turn_id).await?;
		Ok(Some((items, text, summary)))
	}

	/// Submits caller-authored canonical items and runs every tool follow-up.
	pub async fn submit(
		&mut self,
		items: impl IntoIterator<Item = Item>,
		root_turn_id: TurnId,
	) -> Result<AgentRunSummary, AgentError> {
		let starting_prompt_slot = self.prompt_slot().unwrap_or("standard").to_str();
		if let Some(guard) = self.advisor_tool_loop.as_mut() {
			guard.begin_update();
		}
		if let Some(controller) = self.autolearn.as_mut() {
			controller.begin_primary(starting_prompt_slot.as_str());
		}
		let capture_root = root_turn_id.clone();
		let result = self.submit_inner(items, root_turn_id).await;
		notify_json(hook_pb::HookEventId::HookEventAgentEnd, self.hook_gate.as_deref(), || {
			let (summary, error) = match &result {
				Ok(summary) => (
					serde_json::json!({
						"committed_turns": summary.committed_turns,
						"interrupted": summary.interrupted,
						"stop": summary.outcome.as_ref().map(|outcome| stop_reason_name(outcome.stop())),
					}),
					Value::Null,
				),
				Err(error) => (
					serde_json::json!({
						"committed_turns": 0,
						"interrupted": false,
						"stop": Value::Null,
					}),
					Value::String(error.to_string()),
				),
			};
			serde_json::json!({
				"submission_id": capture_root.as_str(),
				"summary": summary,
				"continued": false,
				"error": error,
			})
		});
		let aborted = result.as_ref().map_or(true, |summary| summary.interrupted);
		let ending_prompt_slot = self.prompt_slot().unwrap_or("standard").to_str();
		let mut decision = if let Some(controller) = self.autolearn.as_mut() {
			if aborted {
				controller.abort();
				CaptureDecision::None
			} else {
				controller.finish_primary(ending_prompt_slot.as_str(), false)
			}
		} else {
			CaptureDecision::None
		};
		let mut capture_index = 0_u32;
		while decision == CaptureDecision::Enqueue {
			capture_index = capture_index.saturating_add(1);
			let _ = self.mailbox.sender().try_enqueue(capture_interrupt());
			let turn_id = TurnId::new(sf!("{}-autolearn-{}", capture_root.as_str(), capture_index));
			let capture = self.submit_inner(iter::empty(), turn_id).await;
			let capture_aborted = capture.as_ref().map_or(true, |summary| summary.interrupted);
			if let Err(error) = &capture {
				let _ = error;
			}
			decision = self
				.autolearn
				.as_mut()
				.map_or(CaptureDecision::None, |controller| controller.finish_capture(capture_aborted));
		}
		if let Err(error) = &result {
			// Hosts (chat transcript, print stderr, ACP) settle in-flight
			// presentation off this bus event; the submit `Err` alone reaches
			// only the submitting caller. Interrupts are a caller action, not
			// a failure.
			if !matches!(error, AgentError::Interrupted) {
				self.events.publish(AgentEvent::Failed {
					turn_id: Some(capture_root),
					message: sf!("{error}"),
				});
			}
			self.transition(AgentPhase::Idle);
		}
		result
	}

	fn clear_provider_context(&mut self) {
		self.context = None;
		if let Some(guard) = self.advisor_tool_loop.as_mut() {
			guard.reset();
		}
	}

	fn settle_advisor_tool_loop_abort(
		&mut self,
		outcome: Outcome,
		committed_turns: u32,
		next: Vec<Item>,
		mut immediate: Vec<Interrupt>,
		mut boundary: Vec<Interrupt>,
	) -> Result<AgentRunSummary, AgentError> {
		for item in next {
			self
				.journal
				.append_optimistic(now_ms(), item, self.prompt_hash)?;
		}
		immediate.append(&mut boundary);
		self.mailbox.requeue_front(immediate);
		self.publish_live_history()?;
		self.transition(AgentPhase::Idle);
		Ok(run_summary(Some(outcome), committed_turns, false))
	}

	async fn submit_inner(
		&mut self,
		items: impl IntoIterator<Item = Item>,
		root_turn_id: TurnId,
	) -> Result<AgentRunSummary, AgentError> {
		self.reconcile_history_rewrite().await?;
		let mut abort_generation = *self.abort_rx.borrow_and_update();
		if !self.jobs_restored {
			for job in self.journal.pending_jobs() {
				self.jobs.register(job.clone());
			}
			self.jobs_restored = true;
		}
		let now = now_ms();
		let resumed = self.journal.pending_turn().cloned();
		let staged = self
			.journal
			.pending_input_submission()
			.map(|(turn_id, events)| {
				(
					turn_id.clone(),
					events.to_vec(),
					self.journal.is_released_submission(turn_id.as_str()),
				)
			});
		let mut supplied = items.into_iter();
		let (mut pending_indexes, mut turn_id) = if let Some(start) = resumed {
			if supplied.next().is_some() {
				return Err(AgentError::Protocol(
					"cannot append caller items while resuming a durable turn",
				));
			}
			(start.item_events, TurnId::new(start.turn_id))
		} else if let Some((turn_id, events, released)) = staged {
			if supplied.next().is_some() {
				return Err(AgentError::Protocol(
					"cannot append caller items while resuming durable staged input",
				));
			}
			let mut pending_indexes = self.journal.released_input_events().to_vec();
			pending_indexes.extend(events);
			if released {
				let attempt = u8::try_from(self.journal.trailing_aborts())
					.unwrap_or(u8::MAX)
					.clamp(1, EmptyOutputRetry::CAP);
				pending_indexes.push(self.journal.append_turn_input(
					now,
					turn_id.as_str(),
					EmptyOutputRetry::item(attempt),
					self.prompt_hash,
				)?);
			}
			pending_indexes.sort_unstable();
			pending_indexes.dedup();
			(pending_indexes, TurnId::new(turn_id))
		} else {
			self.drain_control();
			let idle_fold =
				self.resolve_point(Point::Idle, self.point_cx(Some(root_turn_id.as_str())))?;
			self.execute_scheduled_rewinds().await?;
			let snapshot = self.state.snapshot();
			let queued = self.mailbox.drain_steering(
				DrainPoint::Idle,
				snapshot.defer_interrupts,
				snapshot.steering_mode.delivery_limit(),
			);
			let staged_interrupts = queued.len();
			let mut supplied_items = supplied.collect::<Vec<_>>();
			let requested_items = supplied_items.len();
			let text = supplied_items
				.iter()
				.filter_map(hook_item_text)
				.collect::<Vec<_>>()
				.join("\n");
			match gate_json(
				hook_pb::HookEventId::HookEventBeforeAgentStart,
				self.hook_gate.as_deref(),
				|| {
					serde_json::json!({
						"submission_id": root_turn_id.as_str(),
						"text": text,
						"items": supplied_items
							.iter()
							.map(|item| hook_item_ref(0, item))
							.collect::<Vec<_>>(),
						"source": "interactive",
						"prompt_rev": self.prompt_hash.map_or_else(String::new, |hash| hash.to_string()),
						"staged_interrupts": staged_interrupts,
						"resuming": false,
						"schedule_id": Value::Null,
					})
				},
			)
			.await
			{
				JsonGateOutcome::Allow(payload) => {
					if let Some(replacement) = payload.get("text").and_then(Value::as_str)
						&& let Some(item) = supplied_items.first_mut()
					{
						replace_hook_item_text(item, replacement);
					}
					if let Some(items) = payload.get("items").and_then(Value::as_array) {
						append_hook_custom_messages(&mut supplied_items, items, requested_items);
					}
				},
				JsonGateOutcome::Deny { .. } | JsonGateOutcome::Approval => {
					return Err(AgentError::Protocol("before_agent_start hook denied"));
				},
				JsonGateOutcome::Bypassed => {},
			}
			let mut pending_indexes = self.journal.recoverable_input_events().to_vec();
			pending_indexes.extend_from_slice(self.journal.recoverable_settlement_events());
			pending_indexes.sort_unstable();
			pending_indexes.extend(self.stage_interrupts(&root_turn_id, queued, DrainPoint::Idle)?);
			for item in idle_fold.regime.injects {
				pending_indexes.push(self.journal.append_turn_input(
					now,
					root_turn_id.as_str(),
					item,
					self.prompt_hash,
				)?);
			}
			for item in supplied_items {
				pending_indexes.push(self.journal.append_turn_input(
					now,
					root_turn_id.as_str(),
					item,
					self.prompt_hash,
				)?);
			}
			(pending_indexes, root_turn_id)
		};
		notify_json(hook_pb::HookEventId::HookEventAgentStart, self.hook_gate.as_deref(), || {
			serde_json::json!({
				"submission_id": turn_id.as_str(),
				"from_phase": agent_phase_name(self.phase),
				"pending_items": pending_indexes.len(),
			})
		});
		self.publish_live_history()?;
		let mut committed_turns = 0_u32;
		let mut last_outcome = None;
		loop {
			if let Some(guard) = self.streaming_edit_guard.as_ref() {
				guard.reset();
			}
			let turn_index = committed_turns.saturating_add(1);
			self
				.firehose
				.publish(FirehoseEvent::TurnStart(FirehoseTurnStart {
					envelope: telemetry_envelope(),
					turn:     u64::from(turn_index),
				}));
			let turn_span = tracing::debug_span!(
				"turn",
				turn_index,
				turn_id = %turn_id,
				pending_items = pending_indexes.len(),
			);
			let turn = self
				.run_turn(turn_id.clone(), pending_indexes)
				.instrument(turn_span.clone())
				.await;
			let (outcome, mut speculative, submitted_context_id, snapshot, enabled_tools) = match turn
			{
				Ok(RunTurnResult::Complete(turn)) => turn,
				Ok(RunTurnResult::Cancelled(cancel)) => {
					tracing::info!(
						activation = %cancel.activation,
						reason = %cancel.reason,
						"stream regime cancelled the turn"
					);
					self.journal.append_aborted_assistant(
						now_ms(),
						turn_id.as_str(),
						silent_abort_item(cancel.reason.as_str()),
						self.prompt_hash,
					)?;
					self
						.journal
						.abort_turn(now_ms(), turn_id.as_str(), AbortDisposition::Continue)?;
					self.arbiter.flush(&mut self.journal, now_ms())?;
					self.clear_provider_context();
					let next_turn_id = follow_up_id(&turn_id, committed_turns);
					pending_indexes = self.append_pending(&next_turn_id, cancel.injects)?;
					turn_id = next_turn_id;
					continue;
				},
				Err(AgentError::Interrupted) => {
					self
						.journal
						.abort_turn(now_ms(), turn_id.as_str(), AbortDisposition::Exhausted)?;
					self.arbiter.flush(&mut self.journal, now_ms())?;
					self.clear_provider_context();
					self.pending_reasoning_demotion = true;
					abort_generation = *self.abort_rx.borrow_and_update();
					self.drain_control();
					self.execute_scheduled_rewinds().await?;
					let snapshot = self.state.snapshot();
					let drained = self.mailbox.drain_steering(
						DrainPoint::Idle,
						snapshot.defer_interrupts,
						snapshot.steering_mode.delivery_limit(),
					);
					let has_producer = drained
						.iter()
						.any(|interrupt| continues_loop(&interrupt.source));
					tracing::info!(
						turn_index,
						queued_interrupts = drained.len(),
						continues = has_producer,
						"agent turn interrupted"
					);
					let next_turn_id = follow_up_id(&turn_id, committed_turns);
					pending_indexes = self.stage_interrupts(&next_turn_id, drained, DrainPoint::Idle)?;
					if has_producer {
						turn_id = next_turn_id;
						continue;
					}
					self.transition(AgentPhase::Idle);
					return Ok(run_summary(last_outcome, committed_turns, true));
				},
				Err(AgentError::Turn(TurnError::Terminal(mut error)))
					if turn_error::Kind::try_from(error.kind) == Ok(turn_error::Kind::EmptyOutput) =>
				{
					if self.state.snapshot().unexpected_stop == UnexpectedStopMode::None {
						self.journal.abort_turn(
							now_ms(),
							turn_id.as_str(),
							AbortDisposition::Exhausted,
						)?;
						self.arbiter.flush(&mut self.journal, now_ms())?;
						self.clear_provider_context();
						return Err(AgentError::Turn(TurnError::Terminal(error)));
					}
					self
						.redeem_recovery(RedemptionEvidence::Restore {
							turn_id: Str::new(turn_id.as_str()),
						})
						.await;
					let settle_cx = PointCx {
						empty_output: true,
						trailing_aborts: u8::try_from(self.journal.trailing_aborts()).unwrap_or(u8::MAX),
						..self.point_cx(Some(turn_id.as_str()))
					};
					let settle = self.resolve_point(Point::Settle, settle_cx)?;
					let retrying = settle.regime.control == ResolutionKind::Retry
						&& !settle.regime.injects.is_empty();
					let disposition = if retrying {
						AbortDisposition::Continue
					} else {
						AbortDisposition::Exhausted
					};
					self
						.journal
						.abort_turn(now_ms(), turn_id.as_str(), disposition)?;
					self.arbiter.flush(&mut self.journal, now_ms())?;
					self.clear_provider_context();
					if !retrying {
						error.detail = EmptyOutputRetry::cap_detail(&error);
						return Err(AgentError::Turn(TurnError::Terminal(error)));
					}
					let next_turn_id = follow_up_id(&turn_id, committed_turns);
					pending_indexes = self.append_pending(&next_turn_id, settle.regime.injects)?;
					turn_id = next_turn_id;
					continue;
				},
				Err(AgentError::Turn(TurnError::Terminal(error)))
					if turn_error::Kind::try_from(error.kind)
						== Ok(turn_error::Kind::PayloadRejected) =>
				{
					// A different configured model may accept the same bytes or
					// media budget. Consult that chain before any maintenance,
					// but never replay the fixed payload against this model.
					let routes = self
						.provider_failover_routes(turn_id.as_str(), "payload_rejected")
						.await;
					let disposition = if routes.is_empty() {
						AbortDisposition::Exhausted
					} else {
						AbortDisposition::Continue
					};
					self
						.journal
						.abort_turn(now_ms(), turn_id.as_str(), disposition)?;
					self.arbiter.flush(&mut self.journal, now_ms())?;
					self.clear_provider_context();
					if routes.is_empty() {
						// Keep the terminal explanation in the canonical
						// transcript while project_journal excludes this marked
						// error-only frame from future provider context.
						self.journal.append_optimistic(
							now_ms(),
							terminal_error_item(&error),
							self.prompt_hash,
						)?;
						self.publish_live_history()?;
						return Err(AgentError::Turn(TurnError::Terminal(error)));
					}
					self.apply_provider_failover(routes);
					let next_turn_id = follow_up_id(&turn_id, committed_turns);
					pending_indexes = self.append_pending(&next_turn_id, [recovery_prompt_item(
						PromptAssetId::AutoContinue,
					)])?;
					turn_id = next_turn_id;
					continue;
				},
				Err(AgentError::Turn(TurnError::Terminal(error)))
					if turn_error::Kind::try_from(error.kind)
						== Ok(turn_error::Kind::ContextOverflow) =>
				{
					// Usage/token-backed overflow stays on the compaction ladder.
					// It must never consume a configured model-fallback route.
					self
						.journal
						.abort_turn(now_ms(), turn_id.as_str(), AbortDisposition::Exhausted)?;
					self.arbiter.flush(&mut self.journal, now_ms())?;
					self.clear_provider_context();
					if self.promote_context_if_enabled() {
						let next_turn_id = follow_up_id(&turn_id, committed_turns);
						pending_indexes = self.append_pending(&next_turn_id, [recovery_prompt_item(
							PromptAssetId::AutoContinue,
						)])?;
						turn_id = next_turn_id;
						continue;
					}
					let order = self.state.snapshot().compaction.clone();
					if self
						.recover_context_overflow(&order, CompactionReason::Rescue)
						.await
					{
						let next_turn_id = follow_up_id(&turn_id, committed_turns);
						pending_indexes = self.append_pending(&next_turn_id, [recovery_prompt_item(
							PromptAssetId::AutoContinue,
						)])?;
						turn_id = next_turn_id;
						continue;
					}
					return Err(AgentError::Turn(TurnError::Terminal(error)));
				},
				Err(AgentError::Turn(error @ TurnError::Terminal(_))) => {
					let routes = self
						.provider_failover_routes(turn_id.as_str(), "turn_failed")
						.await;
					let disposition = if routes.is_empty() {
						AbortDisposition::Exhausted
					} else {
						AbortDisposition::Continue
					};
					self
						.journal
						.abort_turn(now_ms(), turn_id.as_str(), disposition)?;
					self.arbiter.flush(&mut self.journal, now_ms())?;
					self.clear_provider_context();
					if routes.is_empty() {
						return Err(AgentError::Turn(error));
					}
					self.apply_provider_failover(routes);
					let next_turn_id = follow_up_id(&turn_id, committed_turns);
					pending_indexes = self.append_pending(&next_turn_id, [recovery_prompt_item(
						PromptAssetId::AutoContinue,
					)])?;
					turn_id = next_turn_id;
					continue;
				},
				Err(error) => {
					self.publish_provider_error("turn_failed", Some(Str::new(error.to_string())));
					let routes = self
						.provider_failover_routes(turn_id.as_str(), "turn_failed")
						.await;
					if !routes.is_empty() {
						self.journal.abort_turn(
							now_ms(),
							turn_id.as_str(),
							AbortDisposition::Continue,
						)?;
						self.arbiter.flush(&mut self.journal, now_ms())?;
						self.clear_provider_context();
						self.apply_provider_failover(routes);
						let next_turn_id = follow_up_id(&turn_id, committed_turns);
						pending_indexes = self.append_pending(&next_turn_id, [recovery_prompt_item(
							PromptAssetId::AutoContinue,
						)])?;
						turn_id = next_turn_id;
						continue;
					}
					return Err(error);
				},
			};
			self.publish_model_request(&outcome);
			if let Some(usage) = outcome.usage.as_ref() {
				accumulate_usage(&mut self.cumulative_usage, usage);
			}
			committed_turns = committed_turns.saturating_add(1);
			let stop = outcome.stop();
			self.context = outcome.revision.clone().and_then(|expected| {
				submitted_context_id
					.map(|context_id| ContextRef { context_id, expected: Some(expected) })
			});
			if stop == pb::StopReason::StopMaxTokens && !outcome.output.is_empty() {
				self
					.redeem_recovery(RedemptionEvidence::Salvage { turn_id: Str::new(turn_id.as_str()) })
					.await;
			}

			self.events.publish(AgentEvent::Snapshot(snapshot.clone()));
			notify_json(hook_pb::HookEventId::HookEventTurnEnd, self.hook_gate.as_deref(), || {
				let receipt = self.journal.latest_receipt();
				let item_events = receipt
					.map(|receipt| receipt.item_events.as_slice())
					.unwrap_or(&[]);
				let items = outcome
					.output
					.iter()
					.enumerate()
					.map(|(index, item)| {
						hook_item_ref(item_events.get(index).copied().unwrap_or_default(), item)
					})
					.collect::<Vec<_>>();
				let calls = outcome
					.output
					.iter()
					.filter_map(|item| {
						let item::Kind::ToolCall(call) = item.kind.as_ref()? else {
							return None;
						};
						let identity = snapshot.registry.resolved_identity(&call.name)?;
						Some(serde_json::json!({
							"call_id": call.id,
							"target": hook_tool_target(&identity, &call.args_json),
						}))
					})
					.collect::<Vec<_>>();
				serde_json::json!({
					"turn_id": turn_id.as_str(),
					"turn_index": committed_turns,
					"event_index": item_events.last().copied().unwrap_or_default(),
					"stop": stop_reason_name(outcome.stop()),
					"usage": hook_usage(outcome.usage.as_ref()),
					"session_usage": hook_usage(Some(&self.cumulative_usage)),
					"revision": outcome.revision.as_ref().map(|revision| revision.head.to_string()),
					"calls": calls,
					"items": items,
				})
			});
			self.publish_live_history()?;
			self.retain_session_memory();
			let turn_end =
				self.resolve_point(Point::TurnEnd, self.point_cx(Some(turn_id.as_str())))?;
			for item in turn_end.regime.injects {
				let _ = self.mailbox.sender().try_enqueue(Interrupt {
					class: InterruptClass::Immediate,
					item,
					source: InterruptSource::Continuation { owner: sf!("regime") },
				});
			}
			self.drain_control();
			let (mut immediate, mut boundary): (Vec<_>, Vec<_>) = self
				.mailbox
				.drain_steering(
					DrainPoint::TurnBoundary,
					snapshot.defer_interrupts,
					snapshot.steering_mode.delivery_limit(),
				)
				.into_iter()
				.partition(|interrupt| interrupt.class == InterruptClass::Immediate);
			let tool_call_count = outcome
				.output
				.iter()
				.filter(|item| matches!(item.kind, Some(item::Kind::ToolCall(_))))
				.count();
			if stop == pb::StopReason::StopMaxTokens && tool_call_count != 0 {
				let next = truncated_tool_results(&outcome.output)?;
				immediate.append(&mut boundary);
				let next_turn_id = follow_up_id(&turn_id, committed_turns);
				pending_indexes = self.append_pending(&next_turn_id, next)?;
				pending_indexes.extend(self.stage_interrupts(
					&next_turn_id,
					immediate,
					DrainPoint::TurnBoundary,
				)?);
				self.retain_session_memory();
				last_outcome = Some(outcome);
				turn_id = next_turn_id;
				continue;
			}
			let runnable_tool_calls = tool_call_count != 0
				&& matches!(stop, pb::StopReason::StopToolUse | pb::StopReason::StopEndTurn);
			if runnable_tool_calls {
				let had_immediate = !immediate.is_empty();
				immediate.append(&mut boundary);
				boundary = mem::take(&mut immediate);
				if let Err(error) = self
					.reconcile_speculation(
						&turn_id,
						&outcome.output,
						&mut speculative,
						snapshot.registry.as_ref(),
						enabled_tools.as_ref(),
					)
					.await
				{
					immediate.append(&mut boundary);
					self.mailbox.requeue_front(immediate);
					return Err(error);
				}
				self.drain_invocation_facts()?;
				let calls = match committed_calls(
					&outcome.output,
					&mut speculative,
					self.secret_obfuscator.as_ref(),
				) {
					Ok(calls) => calls,
					Err(error) => {
						immediate.append(&mut boundary);
						self.mailbox.requeue_front(immediate);
						return Err(error);
					},
				};
				let mut calls = calls;
				if calls.len() != tool_call_count {
					tracing::warn!(
						turn_index = committed_turns,
						turn_id = %turn_id,
						expected = tool_call_count,
						actual = calls.len(),
						"tool-call commitment count mismatch"
					);
					return Err(AgentError::Protocol("tool-call commitment count mismatch"));
				}
				for call in &mut calls {
					call.set_cumulative_usage(self.cumulative_usage.clone());
				}
				let edit_call_ids = calls
					.iter()
					.filter(|call| call.identity().name.as_str() == "edit")
					.map(|call| call.call_id().clone())
					.collect::<BTreeSet<_>>();
				let made_environment_effect = calls
					.iter()
					.any(|call| effects_mutate_environment(call.effects()));
				let call_digest = tool_call_digest(&outcome.output);
				let advisor_tool_loop = self
					.advisor_tool_loop
					.as_mut()
					.map_or(AdvisorToolLoopAction::Continue, |guard| guard.observe(call_digest.clone()));
				let call_ids: Vec<Str> = outcome
					.output
					.iter()
					.filter_map(|item| match item.kind.as_ref() {
						Some(item::Kind::ToolCall(call)) => Some(call.id.as_str().to_str()),
						_ => None,
					})
					.collect();
				if let Err(error) =
					self
						.journal
						.authorize_tool_batch(now_ms(), turn_id.as_str(), &call_ids)
				{
					immediate.append(&mut boundary);
					self.mailbox.requeue_front(immediate);
					return Err(error.into());
				}
				for call in &calls {
					self.journal.record_invocation_transition(
						call.authorized_at_ms(),
						InvocationTransition {
							effect_token: Some(call.effect_token().clone()),
							authorized_at: Some(call.authorized_at_ms()),
							effects: Some(call.effects().clone()),
							..empty_invocation_transition(
								call.call_id().clone(),
								CallId(call.call_id().clone()),
								InvocationPhase::EffectsAuthorized,
							)
						},
					)?;
				}
				let batch_fold =
					self.resolve_point(Point::Batch, self.point_cx(Some(turn_id.as_str())))?;
				for item in batch_fold.regime.injects {
					boundary.push(Interrupt {
						class: InterruptClass::Immediate,
						item,
						source: InterruptSource::Continuation { owner: sf!("regime") },
					});
				}
				let (interrupt_tx, interrupt_rx) = watch::channel(None);
				let mut aborted = *self.abort_rx.borrow() != abort_generation;
				if aborted {
					interrupt_tx.send_replace(Some(sf!("user interrupt")));
				} else if had_immediate {
					let reason = boundary
						.first()
						.map_or_else(|| sf!("steering"), |interrupt| interrupt_reason(&interrupt.source));
					interrupt_tx.send_replace(Some(reason));
				}
				let regime_cancel = batch_fold.regime.control == ResolutionKind::Cancel;
				if regime_cancel {
					interrupt_tx.send_replace(Some(sf!("regime cancellation")));
				}
				let mut deadline_elapsed = false;
				let mut abort_rx = self.abort_rx.clone();
				self.transition(AgentPhase::ToolBatch);
				// Publish the batch boundary before polling the batch so event-driven
				// control and abort producers can install their priority signals.
				yield_now().await;
				self.drain_control();
				yield_now().await;
				if !aborted && *self.abort_rx.borrow() != abort_generation {
					aborted = true;
					if !regime_cancel {
						interrupt_tx.send_replace(Some(sf!("user interrupt")));
					}
				}
				let batch_span = tracing::debug_span!(
					parent: &turn_span,
					"tool_batch",
					turn_index = committed_turns,
					turn_id = %turn_id,
					tool_count = calls.len(),
					queued_interrupts = boundary.len(),
					result_count = tracing::field::Empty,
				);
				let results = {
					let caps = self.caps;
					let drive = ToolBatch::new(calls)
						.drive_interruptible(
							snapshot.registry.as_ref(),
							&caps,
							interrupt_rx,
							runtime_duration(INTERRUPT_GRACE),
						)
						.instrument(batch_span.clone());
					tokio::pin!(drive);
					loop {
						tokio::select! {
							results = &mut drive => {
								batch_span.record("result_count", results.len());
								break results;
							},
							() = wait_deadline(snapshot.deadline), if !deadline_elapsed => {
								deadline_elapsed = true;
								interrupt_tx.send_replace(Some(sf!("agent deadline elapsed")));
							},
							_ = abort_rx.changed(), if !aborted => {
								aborted = true;
								interrupt_tx.send_replace(Some(sf!("user interrupt")));
							},
							command = self.receivers.host_commands.recv_async() => {
								if let Ok(command) = command {
									self.handle_host_control(command).await;
								}
							},
							event = self.control_mailbox.handle_next(&mut self.journal) => {
								match event {
									ControlMailboxEvent::Closed => std::future::pending::<()>().await,
									ControlMailboxEvent::JournalHandled => {},
									ControlMailboxEvent::HistoryReset => {
										self.pending_history_rewrite = Some(PendingHistoryRewrite {
											to:    None,
											cause: HistoryRewriteCause::User,
										});
									},
									ControlMailboxEvent::ProjectThread { reply } => {
										self.answer_project_thread(reply);
									},
									ControlMailboxEvent::Rewind(rewind) => self.pending_rewinds.push_back(rewind),
									ControlMailboxEvent::Regime(regime) => Self::handle_regime_control(
										&mut self.arbiter,
										&mut self.journal,
										regime,
									),
								}
							},
							received = self.mailbox.wait() => {
								if received.is_err() { continue; }
								self.drain_control();
								for interrupt in self.mailbox.drain_steering(
									DrainPoint::Immediate,
									snapshot.defer_interrupts,
									snapshot.steering_mode.delivery_limit(),
								) {
									interrupt_tx.send_replace(Some(interrupt_reason(&interrupt.source)));
									boundary.push(interrupt);
								}
							},
						}
					}
				};
				if aborted || deadline_elapsed || regime_cancel || had_immediate {
					tracing::info!(
						turn_index = committed_turns,
						caller_abort = aborted,
						deadline_elapsed,
						regime_cancel,
						steering_interrupt = had_immediate,
						queued_interrupts = boundary.len(),
						"tool batch interrupted"
					);
				}
				drop(batch_span);
				let terminate_after_batch =
					batch_terminates(results.iter().map(BatchResult::terminate));
				let mut next = Vec::with_capacity(results.len() + boundary.len());
				for result in results {
					self
						.firehose
						.publish(FirehoseEvent::ToolCall(Box::new(FirehoseToolCall {
							envelope: telemetry_envelope(),
							tool: result.call_id().clone(),
							..FirehoseToolCall::default()
						})));
					if result.outcome().is_some()
						&& let Some(controller) = self.autolearn.as_mut()
						&& !controller.capture_in_flight()
					{
						controller.observe_settled_tool_execution();
					}
					if result.outcome().is_some()
						&& edit_call_ids.contains(result.call_id())
						&& let Some(guard) = self.streaming_edit_guard.as_ref()
					{
						guard.invalidate_call(result.call_id().as_str());
					}
					if let Some(outcome) = result.outcome().cloned() {
						let call_id = result.call_id().clone();
						self
							.journal
							.record_invocation_transition(now_ms(), InvocationTransition {
								outcome: Some(outcome),
								..empty_invocation_transition(
									call_id.clone(),
									CallId(call_id),
									InvocationPhase::Settled,
								)
							})?;
					}
					let mut result_item = result.item().clone();
					if result.outcome().is_some() {
						let useless = match result_item.kind.as_ref() {
							Some(item::Kind::ToolResult(result)) => result.useless.unwrap_or(false),
							_ => false,
						};
						let target = hook_tool_target(result.identity(), result.raw_args());
						let outcome_kind = hook_outcome_kind(result.outcome());
						match gate_json(
							hook_pb::HookEventId::HookEventToolResult,
							self.hook_gate.as_deref(),
							|| {
								serde_json::json!({
									"call_id": result.call_id(),
									"target": target,
									"outcome": outcome_kind,
									"payload": Value::Null,
									"fault": Value::Null,
									"abort": Value::Null,
									"artifact": Value::Null,
									"useless": useless,
									"annotate": [],
									"spill": Value::Null,
								})
							},
						)
						.await
						{
							JsonGateOutcome::Allow(payload) => {
								apply_tool_result_hook(&mut result_item, &payload);
							},
							JsonGateOutcome::Deny { reason, .. } => {
								self.journal.record_hook_outcome(now_ms(), HookOutcome {
									invocation_id:   Some(result.call_id().clone()),
									event_id:        27,
									dispatch_id:     0,
									subscription_id: None,
									phase:           HookPhase::Review as u8,
									decision:        sf!("deny"),
									reason:          Some(reason),
								})?;
							},
							JsonGateOutcome::Bypassed | JsonGateOutcome::Approval => {},
						}
					}
					next.push(result_item);
					if let Some(job) = result.into_job() {
						let id = job.id.clone();
						self.journal.register_job(now_ms(), job.clone())?;
						if self.jobs.register(job) {
							self
								.events
								.publish(AgentEvent::JobRegistered { job_id: id });
						}
					}
				}
				let batch_settled_cx =
					PointCx { delivered: true, ..self.point_cx(Some(turn_id.as_str())) };
				let batch_settled = self.resolve_point(Point::Batch, batch_settled_cx)?;
				for (index, item) in batch_settled.regime.injects.into_iter().enumerate() {
					next.insert(index, item);
				}
				match advisor_tool_loop {
					AdvisorToolLoopAction::Continue if self.advisor_tool_loop.is_none() => {
						self.loop_signal.observe(
							call_digest,
							made_environment_effect,
							u8::try_from(self.journal.trailing_aborts()).unwrap_or(u8::MAX),
						);
						if self.loop_signal.repeats >= 3 {
							next.insert(
								0,
								tool_loop_redirect_item(
									self.loop_signal.repeats,
									self
										.loop_signal
										.digest
										.as_deref()
										.unwrap_or("identical arguments"),
								),
							);
						}
					},
					AdvisorToolLoopAction::Redirect { count, digest } => {
						next.insert(0, tool_loop_redirect_item(count, digest.as_str()));
					},
					AdvisorToolLoopAction::Abort { .. } => {
						return self.settle_advisor_tool_loop_abort(
							outcome,
							committed_turns,
							next,
							immediate,
							boundary,
						);
					},
					AdvisorToolLoopAction::Continue => {},
				}
				if self.execute_scheduled_rewinds().await? {
					self.transition(AgentPhase::Idle);
					return Ok(run_summary(Some(outcome), committed_turns, false));
				}
				if terminate_after_batch {
					for item in next {
						self
							.journal
							.append_optimistic(now_ms(), item, self.prompt_hash)?;
					}
					self.mailbox.requeue_front(boundary);
					self.publish_live_history()?;
					self.retain_session_memory();
					self.transition(AgentPhase::Idle);
					return Ok(run_summary(Some(outcome), committed_turns, false));
				}
				let next_turn_id = follow_up_id(&turn_id, committed_turns);
				pending_indexes = self.append_pending(&next_turn_id, next)?;
				self.retain_session_memory();
				if mid_turn_compaction_due(snapshot.mid_turn_compaction, outcome.usage.as_ref())
					&& self
						.recover_context_overflow(&snapshot.compaction, CompactionReason::MidTurn)
						.await
				{
					self.clear_provider_context();
				}
				let has_producer = boundary
					.iter()
					.any(|interrupt| continues_loop(&interrupt.source));
				pending_indexes.extend(self.stage_interrupts(
					&next_turn_id,
					mem::take(&mut boundary),
					DrainPoint::Immediate,
				)?);
				if deadline_elapsed {
					return Err(AgentError::Deadline);
				}
				if aborted {
					abort_generation = *self.abort_rx.borrow_and_update();
					if has_producer {
						last_outcome = Some(outcome);
						turn_id = next_turn_id;
						continue;
					}
					self.transition(AgentPhase::Idle);
					return Ok(run_summary(Some(outcome), committed_turns, true));
				}
				last_outcome = Some(outcome);
				turn_id = next_turn_id;
				continue;
			}
			if snapshot.unexpected_stop == UnexpectedStopMode::Smart
				&& self.unexpected_stop_retries < UNEXPECTED_STOP_RETRY_CAP
				&& self.classify_unexpected_stop(&outcome).await
			{
				self.unexpected_stop_retries = self.unexpected_stop_retries.saturating_add(1);
				let next_turn_id = follow_up_id(&turn_id, committed_turns);
				pending_indexes = self.append_pending(&next_turn_id, [recovery_prompt_item(
					PromptAssetId::AutoContinue,
				)])?;
				last_outcome = Some(outcome);
				turn_id = next_turn_id;
				continue;
			}
			self.unexpected_stop_retries = 0;
			immediate.append(&mut boundary);
			boundary = immediate;

			self.drain_control();
			if self.execute_scheduled_rewinds().await? {
				self.transition(AgentPhase::Idle);
				return Ok(run_summary(Some(outcome), committed_turns, false));
			}
			let idle_fold = self.resolve_point(Point::Idle, self.point_cx(Some(turn_id.as_str())))?;
			for item in idle_fold.regime.injects {
				let _ = self.mailbox.sender().try_enqueue(Interrupt {
					class: InterruptClass::Immediate,
					item,
					source: InterruptSource::Continuation { owner: sf!("regime") },
				});
			}
			let mut idle = self.mailbox.drain_steering(
				DrainPoint::Idle,
				snapshot.defer_interrupts,
				snapshot.steering_mode.delivery_limit(),
			);
			boundary.append(&mut idle);
			if !boundary.is_empty() {
				let next_turn_id = follow_up_id(&turn_id, committed_turns);
				pending_indexes = self.stage_interrupts(&next_turn_id, boundary, DrainPoint::Idle)?;
				last_outcome = Some(outcome);
				turn_id = next_turn_id;
				continue;
			}
			self.loop_signal.observe(
				None,
				false,
				u8::try_from(self.journal.trailing_aborts()).unwrap_or(u8::MAX),
			);
			let settled = self.settled_continuation(&turn_id).await?;
			if !settled.is_empty() {
				for interrupt in settled {
					let _ = self.mailbox.sender().try_enqueue(interrupt);
				}
				boundary = self.mailbox.drain_steering(
					DrainPoint::Idle,
					snapshot.defer_interrupts,
					snapshot.steering_mode.delivery_limit(),
				);
				if !boundary.is_empty() {
					let next_turn_id = follow_up_id(&turn_id, committed_turns);
					pending_indexes =
						self.stage_interrupts(&next_turn_id, boundary, DrainPoint::Idle)?;
					last_outcome = Some(outcome);
					turn_id = next_turn_id;
					continue;
				}
			}
			if let Some((queued_turn, events)) = self.journal.pending_input_submission() {
				pending_indexes = events.to_vec();
				last_outcome = Some(outcome);
				turn_id = TurnId::new(queued_turn.clone());
				continue;
			}
			self.transition(AgentPhase::Idle);
			self
				.firehose
				.publish(FirehoseEvent::TurnEnd(Box::new(FirehoseTurnEnd {
					envelope: telemetry_envelope(),
					turn:     u64::from(committed_turns),
					outcome:  None,
				})));
			return Ok(run_summary(Some(outcome), committed_turns, false));
		}
	}

	/// Publishes the current canonical live item projection for `history://`.
	fn publish_live_history(&self) -> Result<(), AgentError> {
		let events = self.journal.live_item_events()?;
		let items = self.journal.items_at(&events)?;
		let mut bytes = Vec::new();
		for item in items {
			serde_json::to_writer(&mut bytes, &item)?;
			bytes.push(b'\n');
		}
		let _ = AgentRegistry::global().set_live_history(self.journal.session_id().0.as_str(), bytes);
		Ok(())
	}

	/// Publishes post-hoc inference facts without participating in durable
	/// billing.
	fn publish_model_request(&self, outcome: &Outcome) {
		self
			.firehose
			.publish(FirehoseEvent::ModelRequest(Box::new(ModelRequest {
				envelope: telemetry_envelope(),
				served_model: Str::new(outcome.model.as_str()),
				provider: Str::new(outcome.provider.as_str()),
				usage: outcome.usage.clone().unwrap_or_default(),
				cost: outcome.cost,
				..ModelRequest::default()
			})));
		for diagnostic in &outcome.diagnostics {
			if diagnostic.retryability != pb::Retryability::Never as i32 {
				self
					.firehose
					.publish(FirehoseEvent::ModelAttempt(ModelAttempt {
						envelope: telemetry_envelope(),
						attempt:  diagnostic.attempt,
						code:     Str::new(diagnostic.code.as_str()),
					}));
			}
		}
	}

	/// Publishes a classified provider failure after the durable abort path ran.
	fn publish_provider_error(&self, code: &'static str, detail: Option<Str>) {
		self
			.firehose
			.publish(FirehoseEvent::ProviderError(Box::new(ProviderError {
				envelope: telemetry_envelope(),
				code: sf!(code),
				detail,
			})));
	}

	async fn provider_failover_routes(&self, turn_id: &str, code: &'static str) -> Vec<Str> {
		let Some(gate) = self.provider_error_gate.as_ref() else {
			return Vec::new();
		};
		gate
			.gate_domain(&ProviderErrorEvent {
				code:    Str::new_static(code),
				turn_id: Str::new(turn_id),
			})
			.await
			.winner
			.routes()
	}

	async fn classify_unexpected_stop(&self, outcome: &Outcome) -> bool {
		if outcome.stop() != pb::StopReason::StopEndTurn
			|| outcome
				.output
				.iter()
				.any(|item| matches!(item.kind.as_ref(), Some(item::Kind::ToolCall(_))))
		{
			return false;
		}
		let Some(text) = authoritative_assistant(outcome) else {
			return false;
		};
		let Some(classifier) = self.unexpected_stop_classifier.as_ref() else {
			return false;
		};
		classifier
			.should_continue(text.as_str())
			.await
			.unwrap_or(false)
	}

	fn append_pending(
		&mut self,
		turn_id: &TurnId<str>,
		items: impl IntoIterator<Item = Item>,
	) -> Result<Vec<u64>, AgentError> {
		let ts = now_ms();
		items
			.into_iter()
			.map(|item| {
				self
					.journal
					.append_turn_input(ts, turn_id.as_str(), item, self.prompt_hash)
					.map_err(Into::into)
			})
			.collect()
	}

	fn resolve_point(&mut self, point: Point, cx: PointCx<'_>) -> Result<ResolvedEvent, AgentError> {
		Ok(self
			.arbiter
			.resolve_and_record(point, &cx, None, &mut self.journal)?)
	}

	/// Builds the baseline facts shared by every loop-resolved point.
	fn point_cx<'a>(&self, turn_id: Option<&'a str>) -> PointCx<'a> {
		PointCx {
			turn_id,
			now_ms: now_ms(),
			checkpoint_active: self.checkpoint_state.lock().active.is_some(),
			..PointCx::default()
		}
	}

	async fn incomplete_todo_snapshot(&self) -> Box<[TodoRef]> {
		let invocation_id = sf!("agent-settled-todos-{}", omp_core::Ulid::generate());
		let Ok(mut invocation) = self
			.env
			.invoke(InvokeTool {
				invocation_id: invocation_id.to_string(),
				name: "todo".to_owned(),
				rev: "1".to_owned(),
				..Default::default()
			})
			.await
		else {
			return Box::new([]);
		};
		if !matches!(invocation.next_event().await, Ok(Some(InvocationEvent::Accepted(_)))) {
			return Box::new([]);
		}
		if invocation
			.commit_args(
				Bytes::from_static(br#"{"op":"view"}"#),
				Bytes::from_static(b"agent-settled"),
				now_ms(),
				None,
			)
			.await
			.is_err()
		{
			return Box::new([]);
		}
		loop {
			match invocation.next_event().await {
				Ok(Some(InvocationEvent::Verdict(verdict))) if !verdict.is_error => {
					let Ok(CallOutcome::Ok(snapshot)) =
						serde_json::from_slice::<CallOutcome<TodoSnapshotPayload, Value>>(&verdict.json)
					else {
						return Box::new([]);
					};
					return snapshot
						.phases
						.into_iter()
						.flat_map(|phase| {
							phase.items.into_iter().filter_map(move |item| {
								matches!(item.status.as_str(), "pending" | "in_progress").then(|| TodoRef {
									phase:  phase.phase.clone(),
									text:   item.text,
									status: item.status,
								})
							})
						})
						.collect();
				},
				Ok(Some(InvocationEvent::Update(_))) => {},
				_ => return Box::new([]),
			}
		}
	}

	/// Runs the settled-boundary domain hook and converts an accepted decision
	/// into a normal mailbox interrupt so `defer_interrupts` remains
	/// authoritative.
	async fn settled_continuation(
		&mut self,
		turn_id: &TurnId<str>,
	) -> Result<Vec<Interrupt>, AgentError> {
		let now = now_ms();
		let mut builtins = SettledFold::new();
		let (candidate, policy) =
			source_candidate(self.continuation_source.as_deref(), &self.loop_signal, now);
		builtins.consider(SettledParticipant::ContinuationSource, candidate, policy);
		if let Some(gate) = self.settled_gate.clone()
			&& gate.subscribed(hook_pb::HookEventId::HookEventAgentSettled)
		{
			let event = AgentSettledEvent {
				agent_id:         sf!("agent"),
				turn_id:          Str::new(turn_id.as_str()),
				incomplete_todos: self.incomplete_todo_snapshot().await,
			};
			let outcome = gate.gate_domain(&event).await;
			let winner = if outcome.winner == AgentSettled::Continue {
				let facts =
					PointCx { turn_id: Some(turn_id.as_str()), now_ms: now, ..PointCx::default() };
				let draft = evaluate_regime(Point::Settle, &facts, "session-stop", 0, |ctx, next| {
					self.session_stop_regime.apply(ctx, next)
				})
				.expect("core session-stop regime is infallible");
				if draft.requests_retry() {
					AgentSettled::Continue
				} else {
					AgentSettled::Settle
				}
			} else {
				self.session_stop_regime = SessionStopRegime::default();
				AgentSettled::Settle
			};
			if winner == AgentSettled::Settle {
				builtins.veto();
			} else {
				builtins.consider(
					SettledParticipant::AgentSettled,
					from_hook(
						winner,
						sf!("agent_settled"),
						recovery_prompt_item(PromptAssetId::AutoContinue),
					),
					ContinuationPolicy::default(),
				);
			}
		}
		let (mut candidate, mut policy) = builtins.into_parts();
		let settle_fold = self.arbiter.resolve_and_record(
			Point::Settle,
			&PointCx { turn_id: Some(turn_id.as_str()), now_ms: now, ..PointCx::default() },
			None,
			&mut self.journal,
		)?;
		// Every committed SETTLE append is delivered in declaration resolution
		// order; effects-only drafts open a boundary turn even without retry
		// control. Items ride the ordinary mailbox drain + stage_interrupts
		// journaling path — never a second durable source of truth.
		let mut interrupts = settle_fold
			.regime
			.injects
			.into_iter()
			.map(|item| Interrupt {
				class: InterruptClass::Immediate,
				item,
				source: InterruptSource::Continuation { owner: sf!("regime") },
			})
			.collect::<Vec<_>>();
		if settle_fold.regime.control == ResolutionKind::Retry
			&& matches!(candidate, Continuation::Settle)
		{
			candidate = Continuation::Continue {
				owner:          settle_fold
					.regime
					.controlling_activation
					.unwrap_or_else(|| sf!("regime")),
				item:           recovery_prompt_item(PromptAssetId::AutoContinue),
				label:          Some(sf!("regime")),
				collapse_prior: false,
			};
			policy = ContinuationPolicy::default();
		}
		if self.loop_signal.no_progress_turns >= 3
			&& let Continuation::Continue { owner, item, .. } = &mut candidate
			&& owner != "loop"
		{
			*item = recovery_prompt_item(PromptAssetId::ThinkingLoopRedirect);
		}
		if let Continuation::Continue { owner, .. } = &candidate
			&& let Some(owner_policy) = self.continuation_policies.get(owner)
		{
			policy = *owner_policy;
		}
		if matches!(&candidate, Continuation::Continue { owner, .. } if owner == "loop") {
			self.continuations.reset_for_user();
		}
		if let Continuation::Continue { owner, item, .. } = self
			.continuations
			.decide_with_policy(candidate, now, policy)
		{
			interrupts.push(Interrupt {
				class: InterruptClass::Immediate,
				item,
				source: InterruptSource::Continuation { owner },
			});
		}
		Ok(interrupts)
	}

	fn stage_interrupts(
		&mut self,
		turn_id: &TurnId<str>,
		interrupts: impl IntoIterator<Item = Interrupt>,
		drain_point: DrainPoint,
	) -> Result<Vec<u64>, AgentError> {
		let ts = now_ms();
		let mut indexes = Vec::new();
		for interrupt in interrupts {
			notify_json(hook_pb::HookEventId::HookEventInterrupt, self.hook_gate.as_deref(), || {
				serde_json::json!({
					"source": if matches!(interrupt.source, InterruptSource::Job { .. }) {
						"job"
					} else {
						"producer"
					},
					"reason": interrupt_reason(&interrupt.source),
					"klass": match interrupt.class {
						InterruptClass::Immediate => "immediate",
						InterruptClass::TurnBoundary => "turn_boundary",
						InterruptClass::Idle => "idle",
					},
					"drain_point": match drain_point {
						DrainPoint::Immediate => "immediate",
						DrainPoint::TurnBoundary => "turn_boundary",
						DrainPoint::Idle => "idle",
					},
					"turn_id": turn_id.as_str(),
				})
			});
			if let InterruptSource::Job { id } = &interrupt.source {
				let Some(settlement) = self.jobs.lease_delivery(id.as_str()) else {
					continue;
				};
				indexes.push(
					self
						.journal
						.settle_job(ts, id.as_str(), settlement.item.clone())?,
				);
				let claimed = settlement.lease.claim();
				debug_assert!(claimed.is_ok(), "delivery lease must remain exclusive through commit");
			} else {
				indexes.push(self.journal.append_turn_input(
					ts,
					turn_id.as_str(),
					interrupt.item,
					self.prompt_hash,
				)?);
			}
		}
		Ok(indexes)
	}

	/// Installs the compiled stream-rule generation used by subsequent turns.
	pub fn set_ttsr_registry(&mut self, registry: TtsrRegistry) {
		self.arbiter.install_ttsr_registry(registry);
	}

	/// Installs a host activity assertion acquired only while a turn is active.
	pub fn set_run_activity(&mut self, activity: Arc<dyn RunActivity>) {
		self.run_activity = Some(activity);
	}

	/// Installs the app/runtime adapter sampled immediately before each fresh
	/// provider prompt is rendered.
	pub fn set_prompt_memory_source(&mut self, source: Arc<dyn PromptMemorySnapshotSource>) {
		self.prompt_memory_source = Some(source);
	}

	/// Installs the sole top-level long-term-memory lifecycle owner.
	pub fn set_session_memory(&mut self, memory: SessionMemory) {
		self.session_memory = Some(memory);
	}

	/// Installs substantive-turn detection and synthetic capture.
	pub fn set_autolearn(&mut self, settings: AutolearnSettings) {
		self.autolearn = settings.enabled.then(|| AutolearnController::new(settings));
	}

	async fn run_turn(
		&mut self,
		turn_id: TurnId,
		pending: Vec<u64>,
	) -> Result<RunTurnResult, AgentError> {
		let turn_started = Instant::now();
		let _activity = self.run_activity.as_ref().map(|activity| {
			activity.enter();
			RunActivityGuard(Arc::clone(activity))
		});
		let durable = self
			.journal
			.pending_turn()
			.filter(|start| start.turn_id.as_str() == turn_id.as_str())
			.cloned();
		let submitted_items = if durable.is_none() {
			self.journal.items_at(&pending)?
		} else {
			Vec::new()
		};
		let capture_turn = submitted_items.iter().any(is_capture_item);
		if durable.is_none()
			&& let Some(source) = &self.prompt_memory_source
		{
			let user_text = self
				.journal
				.bounded_user_text_at(&pending, MEMORY_RECALL_QUERY_MAX_CHARS)?;
			let query = PromptMemoryQuery::new(turn_id.as_str(), &pending, user_text.as_str());
			let memory = source.snapshot(query);
			self.state.update(|snapshot| {
				let values = [
					("memory", memory.memory.content),
					("standing", memory.standing.content),
					("recall", memory.recall.content),
				]
				.into_iter()
				.filter_map(|(name, content)| {
					content.map(|content| (name, omp_scribe::Value::from(content)))
				})
				.collect::<omp_scribe::Value>();
				snapshot.props.set(prompt_keys::MEMORY, values);
			});
		}
		let classified_effort = if capture_turn {
			None
		} else {
			match (
				self.difficulty_classifier.as_ref().map(Arc::clone),
				submitted_user_text(&submitted_items),
			) {
				(Some(classifier), Some(text)) => Some(classifier.classify(&text).await),
				_ => None,
			}
		};
		let snapshot = self.state.snapshot();
		if let Some(start) = durable.as_ref() {
			let current = snapshot.registry.slot_hash();
			if current != start.toolset_hash
				|| !enabled_tools_resolve(snapshot.registry.as_ref(), &start.enabled_tools)
			{
				return Err(AgentError::ToolsetMismatch { durable: start.toolset_hash, current });
			}
		}
		let rendered = if durable.is_none() {
			Some(snapshot.render_prompt()?)
		} else {
			None
		};
		let changed_prompt = rendered
			.as_ref()
			.is_some_and(|rendered| self.prompt_hash.is_some_and(|hash| hash != rendered.hash));
		let mut input_events = durable
			.as_ref()
			.map_or(pending, |start| start.item_events.clone());
		let toolset_hash = durable
			.as_ref()
			.map_or_else(|| snapshot.registry.slot_hash(), |start| start.toolset_hash);
		let changed_toolset = durable.is_none()
			&& self
				.last_toolset_hash
				.is_some_and(|hash| hash != toolset_hash);
		if let Some(rendered) = rendered.as_ref()
			&& (self.prompt_hash.is_none() || changed_prompt)
		{
			let old_head = mem::take(&mut self.prompt_head_events);
			let live = self.journal.live_item_events()?;
			let preserved_tail: Vec<_> = live
				.into_iter()
				.filter(|index| !old_head.contains(index))
				.collect();
			self.prompt_head_events = self.journal.rewrite_prompt_head(
				now_ms(),
				rendered.hash,
				rendered.items.as_ref(),
				&preserved_tail,
			)?;
			if changed_prompt {
				input_events = preserved_tail;
			}
			self.prompt_hash = Some(rendered.hash);
		}
		let mut frozen_enabled_tools: Arc<[Str]> = durable.as_ref().map_or_else(
			|| {
				if capture_turn {
					snapshot
						.enabled_tools
						.iter()
						.filter(|name| matches!(name.as_str(), "manage_skill" | "learn"))
						.cloned()
						.collect::<Vec<_>>()
						.into()
				} else {
					Arc::clone(&snapshot.enabled_tools)
				}
			},
			|start| Arc::from(start.enabled_tools.clone()),
		);
		let mut resume_input = durable.as_ref().map(|start| match &start.input {
			TurnInputRecord::Full { thread } => TurnInput::Full(thread.clone()),
			TurnInputRecord::Delta { context, delta } => {
				TurnInput::Delta(context.clone(), delta.clone())
			},
		});
		let all_live = self.journal.live_item_events()?;
		let mut full = resume_input
			.as_ref()
			.map_or_else(|| self.context.is_none(), |input| matches!(input, TurnInput::Full(_)));
		let mut context = match resume_input.as_ref() {
			Some(TurnInput::Delta(context, _)) => Some(context.clone()),
			_ => self.context.clone(),
		};
		let truncate_to = (changed_prompt || changed_toolset).then_some(0);
		let append_events = if let Some(start) = &durable {
			start.sequence_targets.clone()
		} else if changed_prompt {
			self
				.prompt_head_events
				.iter()
				.chain(&input_events)
				.copied()
				.collect()
		} else if changed_toolset || full {
			all_live.clone()
		} else {
			input_events.clone()
		};
		let sequence_targets = durable.as_ref().map_or_else(
			|| {
				if changed_prompt || changed_toolset || self.context.is_none() {
					append_events.clone()
				} else {
					input_events.clone()
				}
			},
			|start| start.sequence_targets.clone(),
		);
		let mut attempts = 0_u32;
		let mut backoff = snapshot.retry.initial_backoff();
		let mut frozen_options = durable.as_ref().map_or_else(
			|| snapshot.turn.clone(),
			|start| TurnOptions {
				context_id:      start.options.context_id.clone(),
				params:          start.options.params.clone(),
				executor:        start.options.executor.clone(),
				props:           start.options.props.clone(),
				provider_reset:  snapshot.turn.provider_reset,
				stream_watchdog: snapshot.turn.stream_watchdog,
			},
		);
		if let Some(effort) = classified_effort {
			frozen_options.params.thinking =
				Some(pb::Reasoning { effort: effort as i32, ..pb::Reasoning::default() });
		}
		let lifted_reseed = if changed_toolset {
			self.transition(AgentPhase::Projecting);
			let journal = self.journal.load()?;
			Some(project_journal(&journal, journal.as_ref(), snapshot.registry.as_ref(), &self.caps)?)
		} else {
			None
		};
		// Captured once per logical turn so retry attempts (including the
		// held-context replacement below) rebuild the demoted thread instead of
		// resending raw interrupted reasoning.
		let demote_reasoning = mem::take(&mut self.pending_reasoning_demotion);

		loop {
			let latest = self.state.snapshot();
			if latest
				.deadline
				.is_some_and(|deadline| Instant::now() >= deadline)
			{
				let elapsed = turn_started.elapsed();
				notify_json(hook_pb::HookEventId::HookEventDeadline, self.hook_gate.as_deref(), || {
					serde_json::json!({
						"scope": "turn",
						"elapsed": format!("{}ms", elapsed.as_millis()),
						"budget": format!("{}ms", elapsed.as_millis()),
						"turn_id": turn_id.as_str(),
						"call_id": Value::Null,
					})
				});
				return Err(AgentError::Deadline);
			}
			let context_base_revision = self.journal.context_position().revision;
			let input = if let Some(input) = resume_input.as_ref() {
				input.clone()
			} else if full {
				let journal = self.journal.load()?;
				let projected =
					project_journal(&journal, journal.as_ref(), snapshot.registry.as_ref(), &self.caps)?;
				let context_handlers = self.context_projection_handler.is_some()
					|| self.hook_bus.union_mask()
						& hook_event_mask(hook_pb::HookEventId::HookEventThreadProjection)
						!= 0;
				let mut thread = materialize_context_projection(
					project_context(projected, &all_live, context_handlers),
					context_base_revision,
					self.context_projection_handler.as_deref(),
				);
				if let Ok(date) = omp_core::display_time::local_calendar_date(SystemTime::now()) {
					let cwd = snapshot
						.props
						.get(prompt_keys::CWD)
						.and_then(omp_scribe::Value::as_str)
						.unwrap_or_default();
					let _ = inject_first_turn_metadata(&mut thread, &date, cwd);
				}
				if demote_reasoning {
					let _ = demote_interrupted_reasoning(&mut thread, snapshot.reasoning_dialect);
				}
				match context.clone() {
					// The server still holds this context (reseed after an
					// interrupt or cancel): the protocol forbids seeding a live
					// context, so replace its entire history in place.
					Some(held) => TurnInput::Delta(held, ThreadDelta {
						truncate_to: Some(0),
						append:      thread.items,
					}),
					None => TurnInput::Full(thread),
				}
			} else {
				let held = context
					.clone()
					.ok_or(AgentError::Protocol("delta missing context"))?;
				let append = match &lifted_reseed {
					Some(thread) => thread.items.clone(),
					None => self.journal.items_at(&append_events)?,
				};
				let append = if self.context_projection_handler.is_some() {
					materialize_context_projection(
						project_context(Thread { items: append }, &append_events, true),
						context_base_revision,
						self.context_projection_handler.as_deref(),
					)
					.items
				} else {
					append
				};
				TurnInput::Delta(held, ThreadDelta { truncate_to, append })
			};
			let mut provider_input = input.clone();
			if resume_input.is_some() && self.context_projection_handler.is_some() {
				match &mut provider_input {
					TurnInput::Full(thread) => {
						let projected = project_context(mem::take(thread), &all_live, true);
						*thread = materialize_context_projection(
							projected,
							context_base_revision,
							self.context_projection_handler.as_deref(),
						);
					},
					TurnInput::Delta(_, delta) => {
						let projected = project_context(
							Thread { items: mem::take(&mut delta.append) },
							&append_events,
							true,
						);
						delta.append = materialize_context_projection(
							projected,
							context_base_revision,
							self.context_projection_handler.as_deref(),
						)
						.items;
					},
				}
			}
			let checkpoint_active = self.checkpoint_state.lock().active.is_some();
			self
				.arbiter
				.checkpoint_notice_mut()
				.set_active(checkpoint_active);
			let context_fold =
				self.resolve_point(Point::Context, self.point_cx(Some(turn_id.as_str())))?;
			for item in context_fold.regime.injects {
				match &mut provider_input {
					TurnInput::Full(thread) => thread.items.push(item),
					TurnInput::Delta(_, delta) => delta.append.push(item),
				}
			}
			publish_input_attachments(self.journal.session_id().0.as_str(), &provider_input);
			obfuscate_provider_input(&mut provider_input, self.secret_obfuscator.as_ref())?;
			let choice_cx =
				PointCx { turn_id: Some(turn_id.as_str()), now_ms: now_ms(), ..PointCx::default() };
			self.arbiter.resolve_and_record(
				Point::ToolChoice,
				&choice_cx,
				Some(&mut self.tool_choices),
				&mut self.journal,
			)?;
			if let Some(choice) = self.tool_choices.claim_next() {
				let (mode, name) = match choice {
					ToolChoice::Disabled => (tool_choice::Mode::None, String::new()),
					ToolChoice::Auto => (tool_choice::Mode::Auto, String::new()),
					ToolChoice::Required => (tool_choice::Mode::Required, String::new()),
					ToolChoice::Named(name) => (tool_choice::Mode::Named, name.to_string()),
				};
				frozen_options.params.tool_choice =
					Some(wire_tool_choice::from_parts(mode as i32, name));
			}
			let pre_model =
				self.resolve_point(Point::PreModel, self.point_cx(Some(turn_id.as_str())))?;
			for setting in pre_model.regime.settings {
				if let ScopedSetting { slot: SettingSlot::ModelRoute, value } = setting {
					frozen_options.params.model = value.to_string();
				}
			}
			for ticket in pre_model.regime.waits {
				self.waits.insert(ticket)?;
			}
			self.waits.wait_empty(self.abort_rx.clone()).await?;
			let model = frozen_options.params.model.clone();
			let (provider, model_name) = model.split_once('/').unwrap_or(("", model.as_str()));
			let thinking = frozen_options
				.params
				.thinking
				.as_ref()
				.map_or("off", |thinking| effort_name(thinking.effort));
			let deadline_ms = latest.deadline.map(|deadline| {
				u64::try_from(
					deadline
						.saturating_duration_since(Instant::now())
						.as_millis(),
				)
				.unwrap_or(u64::MAX)
			});
			match gate_json(
				hook_pb::HookEventId::HookEventTurnStart,
				self.hook_gate.as_deref(),
				|| {
					serde_json::json!({
						"turn_id": turn_id.as_str(),
						"turn_index": attempts.saturating_add(1),
						"prompt_hash": self.prompt_hash.expect("prompt rendered").to_string(),
						"toolset_hash": toolset_hash.to_string(),
						"enabled_tools": frozen_enabled_tools.iter().map(Str::as_str).collect::<Vec<_>>(),
						"input_mode": if matches!(input, TurnInput::Full(_)) { "full" } else { "delta" },
						"model": {"provider": provider, "api": provider, "model": model_name},
						"route": {"provider": provider, "route": model},
						"thinking": thinking,
						"deadline": deadline_ms.map(|value| format!("{value}ms")),
						"attempt": attempts.saturating_add(1),
						"prompt_changed": changed_prompt,
						"toolset_changed": changed_toolset,
					})
				},
			)
			.await
			{
				JsonGateOutcome::Bypassed => {},
				JsonGateOutcome::Allow(payload) => {
					if let Some(tools) = payload.get("enabled_tools").and_then(Value::as_array) {
						frozen_enabled_tools = tools
							.iter()
							.filter_map(Value::as_str)
							.filter(|tool| {
								frozen_enabled_tools
									.iter()
									.any(|enabled| enabled.as_str() == *tool)
							})
							.map(Str::new)
							.collect::<Vec<_>>()
							.into();
					}
					if let Some(model) = payload.get("model").and_then(Value::as_object) {
						let provider = model
							.get("provider")
							.and_then(Value::as_str)
							.unwrap_or_default();
						let name = model
							.get("model")
							.and_then(Value::as_str)
							.unwrap_or_default();
						if !name.is_empty() {
							frozen_options.params.model = if provider.is_empty() {
								name.to_owned()
							} else {
								format!("{provider}/{name}")
							};
						}
					}
					if let Some(effort) = payload
						.get("thinking")
						.and_then(Value::as_str)
						.and_then(parse_effort)
					{
						frozen_options.params.thinking =
							Some(pb::Reasoning { effort: effort as i32, ..pb::Reasoning::default() });
					}
				},
				JsonGateOutcome::Deny { .. } | JsonGateOutcome::Approval => {
					return Err(AgentError::Protocol("turn_start hook denied"));
				},
			}
			let start = TurnStart {
				turn_id: turn_id.as_str().to_str(),
				item_events: input_events.clone(),
				prompt_hash: self.prompt_hash.expect("prompt rendered").digest(),
				prompt_head_events: self.prompt_head_events.clone(),
				toolset_hash,
				enabled_tools: frozen_enabled_tools.to_vec(),
				sequence_targets: sequence_targets.clone(),
				input: match &input {
					TurnInput::Full(thread) => TurnInputRecord::Full { thread: thread.clone() },
					TurnInput::Delta(context, delta) => {
						TurnInputRecord::Delta { context: context.clone(), delta: delta.clone() }
					},
				},
				options: TurnOptionsRecord {
					context_id: frozen_options.context_id.clone(),
					params:     frozen_options.params.clone(),
					executor:   frozen_options.executor.clone(),
					props:      frozen_options.props.clone(),
				},
			};
			self.journal.start_turn(now_ms(), start)?;
			self.transition(AgentPhase::Turning);
			attempts = attempts.saturating_add(1);
			let submitted_context_id = match &provider_input {
				TurnInput::Full(_) => frozen_options.context_id.as_ref().map(ToString::to_string),
				TurnInput::Delta(context, _) => Some(context.context_id.clone()),
			};
			let stateful = matches!(&provider_input, TurnInput::Delta(..))
				|| matches!(&provider_input, TurnInput::Full(_) if frozen_options.context_id.is_some());

			let selected = {
				let mut abort_rx = self.abort_rx.clone();
				let deadline_hook_gate = self.hook_gate.clone();
				let session = self.drive_session(
					turn_id.clone(),
					provider_input,
					&frozen_options,
					Arc::clone(&snapshot.registry),
					Arc::clone(&frozen_enabled_tools),
					false,
				);
				tokio::pin!(session);
				tokio::select! {
					result = &mut session => Ok(result),
					() = wait_deadline(latest.deadline) => {
						let elapsed = turn_started.elapsed();
						notify_json(hook_pb::HookEventId::HookEventDeadline, deadline_hook_gate.as_deref(), || {
							serde_json::json!({
								"scope": "turn",
								"elapsed": format!("{}ms", elapsed.as_millis()),
								"budget": format!("{}ms", elapsed.as_millis()),
								"turn_id": turn_id.as_str(),
								"call_id": Value::Null,
							})
						});
						Err(AgentError::Deadline)
					},
					_ = abort_rx.changed() => Err(AgentError::Interrupted),
				}
			};
			self.drain_invocation_facts()?;
			let session_result = match selected {
				Ok(result) => result,
				Err(error) => {
					self.publish_attempt_terminal(
						&turn_id,
						turn_error::Kind::Upstream,
						error.to_string(),
					);
					return Err(error);
				},
			};
			if let Err(error) = &session_result {
				if let Some(terminal) = error.turn_error() {
					self.events.publish(AgentEvent::Turn {
						turn_id: turn_id.clone(),
						event:   Box::new(pb::TurnEvent {
							event: Some(turn_event::Event::Error(terminal.clone())),
						}),
					});
				} else {
					self.publish_attempt_terminal(
						&turn_id,
						turn_error::Kind::Upstream,
						error.to_string(),
					);
				}
				self.tool_choices.reject(RejectReason::Error);
			}
			match session_result {
				Ok(DriveSessionResult::Complete(mut outcome, speculative)) => {
					let truncated = outcome.stop() == pb::StopReason::StopMaxTokens;
					restore_provider_output(
						&mut outcome.output,
						self.secret_obfuscator.as_ref(),
						truncated,
					)?;
					validate_outcome(&outcome)?;
					if stateful && outcome.revision.is_none() {
						return Err(AgentError::Protocol("stateful outcome missing revision"));
					}
					// The provider owns the post-commit revision. Its head may
					// include provider-side context that is absent from the
					// client projection; the opaque token is the actual fence.
					// Validate the returned output as its consecutive suffix,
					// then echo the complete revision on the next delta.
					let (receipt, _) = self.journal.append_arbiter_outcome(
						now_ms(),
						turn_id.as_str(),
						outcome.clone(),
					)?;
					for (event_index, item) in receipt.item_events.iter().copied().zip(&outcome.output) {
						notify_json(
							hook_pb::HookEventId::HookEventItemCommitted,
							self.hook_gate.as_deref(),
							|| {
								serde_json::json!({
									"event_index": event_index,
									"turn_id": turn_id.as_str(),
									"item": hook_item_ref(event_index, item),
								})
							},
						);
					}
					self.arbiter.flush(&mut self.journal, now_ms())?;
					if frozen_options.provider_reset {
						self
							.state
							.update(|snapshot| snapshot.turn.provider_reset = false);
					}
					if !truncated {
						self.record_committed_invocations(&outcome, &speculative, &receipt)?;
					}
					self.patch_input_sequences(
						&sequence_targets,
						u64::from(checkpoint_active),
						&outcome,
					)?;
					self.last_toolset_hash = Some(toolset_hash);
					self.tool_choices.resolve();
					return Ok(RunTurnResult::Complete((
						outcome,
						speculative,
						submitted_context_id,
						snapshot.clone(),
						Arc::clone(&frozen_enabled_tools),
					)));
				},
				Ok(DriveSessionResult::Cancelled(cancel)) => {
					self.tool_choices.reject(RejectReason::Aborted);
					return Ok(RunTurnResult::Cancelled(cancel));
				},
				Err(TurnError::Conflict(error)) => {
					if attempts >= latest.retry.max_attempts().get() {
						return Err(TurnError::Conflict(error).into());
					}
					let actual = error
						.actual
						.ok_or(AgentError::Protocol("conflict missing actual revision"))?;
					match context.as_mut() {
						Some(held) => held.expected = Some(actual),
						// A stateful seed conflicted with a context the server
						// still holds: adopt its authoritative revision and retry
						// as a full replacement delta.
						None => {
							let context_id = frozen_options
								.context_id
								.as_ref()
								.ok_or(AgentError::Protocol("conflict on stateless turn"))?;
							context = Some(ContextRef {
								context_id: context_id.to_string(),
								expected:   Some(actual),
							});
						},
					}
					resume_input = None;
				},
				Err(TurnError::NeedFull(error)) => {
					if attempts >= latest.retry.max_attempts().get() {
						return Err(TurnError::NeedFull(error).into());
					}
					full = true;
					context = None;
					resume_input = None;
				},
				Err(TurnError::Terminal(error))
					if matches!(
						turn_error::Kind::try_from(error.kind),
						Ok(turn_error::Kind::RateLimited)
					) && attempts < latest.retry.max_attempts().get() =>
				{
					sleep_with_deadline(Duration::from_millis(error.retry_after_ms), latest.deadline)
						.await?;
				},
				Err(TurnError::Terminal(error))
					if matches!(
						turn_error::Kind::try_from(error.kind),
						Ok(turn_error::Kind::Overloaded | turn_error::Kind::Upstream)
					) && attempts < latest.retry.max_attempts().get() =>
				{
					sleep_with_deadline(backoff, latest.deadline).await?;
					backoff = backoff.saturating_mul(2).min(latest.retry.max_backoff());
				},
				Err(TurnError::Terminal(error)) => {
					return Err(TurnError::Terminal(error).into());
				},
				Err(TurnError::Rpc(_)) if attempts < latest.retry.max_attempts().get() => {
					sleep_with_deadline(backoff, latest.deadline).await?;
					backoff = backoff.saturating_mul(2).min(latest.retry.max_backoff());
				},
				Err(error) => return Err(error.into()),
			}
		}
	}

	fn retain_session_memory(&self) {
		let Some(memory) = self.session_memory.as_ref() else {
			return;
		};
		match settled_retention_messages(&self.journal) {
			Ok(messages) => {
				if let Err(error) = memory.retain_settled(&messages) {
					tracing::warn!(%error, "session memory retention failed");
				}
			},
			Err(error) => tracing::warn!(%error, "session memory projection failed"),
		}
	}

	fn publish_attempt_terminal(&self, turn_id: &TurnId, kind: turn_error::Kind, detail: String) {
		self.events.publish(AgentEvent::Turn {
			turn_id: turn_id.clone(),
			event:   Box::new(pb::TurnEvent {
				event: Some(turn_event::Event::Error(pb::TurnError {
					kind: kind as i32,
					detail,
					..pb::TurnError::default()
				})),
			}),
		});
	}

	async fn drive_session(
		&mut self,
		turn_id: TurnId,
		input: TurnInput,
		options: &TurnOptions,
		registry: Arc<ToolRegistry>,
		enabled_tools: Arc<[Str]>,
		hidden: bool,
	) -> Result<DriveSessionResult, TurnError> {
		// The opened turn future borrows the client for the whole drive, while
		// host control commands need `&mut self`; driving it through a cloned
		// handle keeps those borrows disjoint. Turn clients are cheap-clone
		// handles.
		let pending_tool_results = turn_input_has_tool_results(&input);
		let stream_recovery_mailbox = self.mailbox.sender();
		let streaming_edit_guard = self.streaming_edit_guard.clone();
		let client = self.client.clone();
		let opening = client.turn(turn_id.clone(), input, options);
		tokio::pin!(opening);
		let mut session = loop {
			tokio::select! {
				session = &mut opening => break session?,
				command = self.receivers.host_commands.recv_async() => {
					if let Ok(command) = command {
						self.handle_host_control(command).await;
					}
				},
				event = self.control_mailbox.handle_next(&mut self.journal) => {
					match event {
						ControlMailboxEvent::Closed => std::future::pending::<()>().await,
						ControlMailboxEvent::JournalHandled => {},
						ControlMailboxEvent::HistoryReset => {
							self.pending_history_rewrite = Some(PendingHistoryRewrite {
								to:    None,
								cause: HistoryRewriteCause::User,
							});
						},
						ControlMailboxEvent::ProjectThread { reply } => {
							self.answer_project_thread(reply);
						},
						ControlMailboxEvent::Rewind(rewind) => self.pending_rewinds.push_back(rewind),
						ControlMailboxEvent::Regime(regime) => Self::handle_regime_control(
							&mut self.arbiter,
							&mut self.journal,
							regime,
						),
					}
				},
			}
		};
		let mut duplex = DuplexManager::new(
			self.env.clone(),
			Arc::clone(&registry),
			self.events.clone(),
			self.caps,
			runtime_duration(INTERRUPT_GRACE),
		);
		let mut speculative = BTreeMap::new();
		let mut part_calls: BTreeMap<u32, Str> = BTreeMap::new();
		let mut stream_parts: BTreeMap<u32, (StreamSource, Option<Str>)> = BTreeMap::new();
		let mut secret_streams: BTreeMap<u32, SecretStreamRestorer> = BTreeMap::new();
		let mut message_hooks = self
			.hook_gate
			.as_ref()
			.filter(|gate| {
				[
					hook_pb::HookEventId::HookEventMessageStart,
					hook_pb::HookEventId::HookEventMessageUpdate,
					hook_pb::HookEventId::HookEventMessageEnd,
				]
				.into_iter()
				.any(|event| gate.subscribed(event))
			})
			.map(|gate| MessageHookStream::new(Arc::clone(gate), Str::new(turn_id.as_str())));
		let mut saw_stream_event = false;
		loop {
			let watchdog_ms = if saw_stream_event {
				options.stream_watchdog.idle_ms
			} else {
				options.stream_watchdog.first_event_ms
			};
			let event = if duplex.is_empty() {
				let mut events = session.events();
				tokio::select! {
					event = events.next() => event,
					() = wait_stream_watchdog(watchdog_ms) => {
						return Err(stream_watchdog_error(
							&stream_recovery_mailbox,
							saw_stream_event,
							pending_tool_results,
						));
					},
					abort = wait_streaming_edit_abort(streaming_edit_guard.as_deref()) => {
						return Err(TurnError::Protocol(if abort.path.is_empty() {
							"streaming edit guard rejected streamed edit"
						} else {
							"streaming edit guard found a stale edit target"
						}));
					},
					command = self.receivers.host_commands.recv_async() => {
						match command {
							Ok(command) => {
								self.handle_host_control(command).await;
								continue;
							},
							Err(_) => std::future::pending().await,
						}
					},
					event = self.control_mailbox.handle_next(&mut self.journal) => {
						match event {
							ControlMailboxEvent::Closed => std::future::pending().await,
							ControlMailboxEvent::JournalHandled => {
								continue;
							},
							ControlMailboxEvent::HistoryReset => {
								self.pending_history_rewrite = Some(PendingHistoryRewrite {
									to:    None,
									cause: HistoryRewriteCause::User,
								});
								continue;
							},
							ControlMailboxEvent::ProjectThread { reply } => {
								self.answer_project_thread(reply);
								continue;
							},
							ControlMailboxEvent::Rewind(rewind) => {
								self.pending_rewinds.push_back(rewind);
								continue;
							},
							ControlMailboxEvent::Regime(regime) => {
								Self::handle_regime_control(
									&mut self.arbiter,
									&mut self.journal,
									regime,
								);
								continue;
							},
						}
					},
				}
			} else {
				let completion = {
					let mut events = session.events();
					tokio::select! {
						event = events.next() => Ok(event),
						completion = duplex.next() => Err(completion),
						() = wait_stream_watchdog(watchdog_ms) => {
							return Err(stream_watchdog_error(
								&stream_recovery_mailbox,
								saw_stream_event,
								pending_tool_results,
							));
						},
						abort = wait_streaming_edit_abort(streaming_edit_guard.as_deref()) => {
							return Err(TurnError::Protocol(if abort.path.is_empty() {
								"streaming edit guard rejected streamed edit"
							} else {
								"streaming edit guard found a stale edit target"
							}));
						},
						command = self.receivers.host_commands.recv_async() => {
							match command {
								Ok(command) => {
									self.handle_host_control(command).await;
									continue;
								},
								Err(_) => std::future::pending().await,
							}
						},
						event = self.control_mailbox.handle_next(&mut self.journal) => {
							match event {
								ControlMailboxEvent::Closed => std::future::pending().await,
								ControlMailboxEvent::JournalHandled => {
									continue;
								},
								ControlMailboxEvent::HistoryReset => {
									self.pending_history_rewrite = Some(PendingHistoryRewrite {
										to:    None,
										cause: HistoryRewriteCause::User,
									});
									continue;
								},
								ControlMailboxEvent::ProjectThread { reply } => {
									self.answer_project_thread(reply);
									continue;
								},
								ControlMailboxEvent::Rewind(rewind) => {
									self.pending_rewinds.push_back(rewind);
									continue;
								},
								ControlMailboxEvent::Regime(regime) => {
									Self::handle_regime_control(
										&mut self.arbiter,
										&mut self.journal,
										regime,
									);
									continue;
								},
							}
						},
					}
				};
				match completion {
					Ok(event) => event,
					Err(Some((_id, result))) => {
						let frame = result.map_err(duplex_turn_error)?;
						session.submit(frame).await?;
						continue;
					},
					Err(None) => continue,
				}
			};
			let event = event.ok_or_else(|| tonic::Status::unavailable("turn stream lost"))??;
			saw_stream_event = true;
			let publish = |event: pb::TurnEvent| {
				self
					.events
					.publish(AgentEvent::Turn { turn_id: turn_id.clone(), event: Box::new(event) });
			};
			match event.event.as_ref() {
				Some(turn_event::Event::PartStart(part))
					if part.kind() == part_start::Kind::Text && self.secret_obfuscator.is_some() =>
				{
					secret_streams.insert(part.index, SecretStreamRestorer::new());
					publish(event.clone());
				},
				Some(turn_event::Event::PartDelta(part))
					if secret_streams.contains_key(&part.index) =>
				{
					let fragment = str::from_utf8(&part.chunk)
						.map_err(|_| TurnError::Protocol("stream fragment is not UTF-8"))?;
					let restored = secret_streams
						.get_mut(&part.index)
						.expect("checked stream")
						.push(
							fragment,
							&self
								.secret_obfuscator
								.as_ref()
								.expect("secret stream requires transform")
								.lock(),
						);
					if !restored.is_empty() {
						let mut display = event.clone();
						if let Some(turn_event::Event::PartDelta(delta)) = display.event.as_mut() {
							delta.chunk = bytes::Bytes::from(restored);
						}
						publish(display);
					}
				},
				Some(turn_event::Event::PartEnd(part)) if secret_streams.contains_key(&part.index) => {
					let restored = secret_streams
						.remove(&part.index)
						.expect("checked stream")
						.finish(
							&self
								.secret_obfuscator
								.as_ref()
								.expect("secret stream requires transform")
								.lock(),
						);
					if !restored.is_empty() {
						publish(pb::TurnEvent {
							event: Some(turn_event::Event::PartDelta(pb::PartDelta {
								index: part.index,
								chunk: bytes::Bytes::from(restored),
							})),
						});
					}
					publish(event.clone());
				},
				_ => publish(event.clone()),
			}
			match event.event {
				Some(turn_event::Event::Outcome(outcome)) => {
					if let Some(hooks) = message_hooks.as_mut() {
						let finish = match outcome.stop() {
							pb::StopReason::StopMaxTokens => "truncated",
							pb::StopReason::StopContentFilter => "error",
							_ => "complete",
						};
						hooks.finish(finish);
					}
					return Ok(DriveSessionResult::Complete(outcome, speculative));
				},
				Some(turn_event::Event::Error(error)) => {
					if let Some(hooks) = message_hooks.as_mut() {
						hooks.finish("error");
					}
					return Err(TurnError::Terminal(Box::new(error)));
				},
				Some(turn_event::Event::PartStart(part)) => {
					let source = match part.kind() {
						part_start::Kind::Text => Some(StreamSource::Text),
						part_start::Kind::Thinking => Some(StreamSource::Thinking),
						part_start::Kind::ToolCall => Some(StreamSource::Tool),
						part_start::Kind::Unspecified => None,
					};
					if let Some(source) = source {
						if let Some(hooks) = message_hooks.as_mut() {
							hooks.start(part.index, source);
						}
						stream_parts.insert(
							part.index,
							(
								source,
								(source == StreamSource::Tool).then(|| part.tool_name.as_str().to_str()),
							),
						);
					}
					if part.kind() != part_start::Kind::ToolCall {
						continue;
					}
					if !enabled_tools
						.iter()
						.any(|name| name.as_str() == part.tool_name)
					{
						return Err(TurnError::Protocol("stream named disabled tool"));
					}
					let Some(identity) = registry.resolved_identity(&part.tool_name) else {
						return Err(TurnError::Protocol("stream named unknown tool"));
					};
					let maximum_effects = registry
						.effects_owned(&part.tool_name)
						.map_err(|_| TurnError::Protocol("stream named unknown tool"))?;
					let call_id = part.tool_call_id.as_str().to_str();
					if identity.name.as_str() == "edit"
						&& let Some(guard) = streaming_edit_guard.as_ref()
					{
						guard.start(call_id.clone(), &identity.rev);
					}
					let admission = self
						.arbiter
						.resolve_and_record(
							Point::Admission,
							&PointCx {
								turn_id: Some(turn_id.as_str()),
								invocation_id: Some(call_id.as_str()),
								now_ms: now_ms(),
								..PointCx::default()
							},
							None,
							&mut self.journal,
						)
						.map_err(|_| TurnError::Protocol("failed to journal admission resolution"))?;
					if admission.regime.control == ResolutionKind::Reject {
						return Err(TurnError::Protocol("regime rejected tool admission"));
					}
					for ticket in admission.regime.waits {
						self
							.waits
							.insert(ticket)
							.map_err(|_| TurnError::Protocol("regime admission wait is invalid"))?;
					}
					self
						.waits
						.wait_empty(self.abort_rx.clone())
						.await
						.map_err(|_| TurnError::Protocol("regime admission wait did not resolve"))?;
					let invocation_props = self
						.invocation_mode_props(&maximum_effects)
						.map_err(|_| TurnError::Protocol("prewalk transition could not be recorded"))?;
					let mut opened = SpeculativeCall::open_with_props(
						&self.env,
						&self.events,
						call_id.clone(),
						identity,
						runtime_duration(TOOL_DEADLINE),
						invocation_props,
					)
					.await
					.map_err(|_| TurnError::Protocol("failed to open speculative tool"))?;
					opened
						.attach_runtime(
							self.hook_bus.clone(),
							self.invocation_fact_tx.clone(),
							maximum_effects,
							self.hook_gate.clone(),
							Str::new(turn_id.as_str()),
						)
						.map_err(|_| TurnError::Protocol("failed to attach invocation runtime"))?;
					self
						.journal
						.record_invocation_transition(
							now_ms(),
							empty_invocation_transition(
								call_id.clone(),
								CallId(call_id.clone()),
								InvocationPhase::Open,
							),
						)
						.map_err(|_| TurnError::Protocol("failed to journal invocation open"))?;
					speculative.insert(call_id.clone(), opened);
					part_calls.insert(part.index, call_id);
				},
				Some(turn_event::Event::PartDelta(part)) => {
					let fragment = str::from_utf8(&part.chunk)
						.map_err(|_| TurnError::Protocol("stream fragment is not UTF-8"))?;
					if let Some(hooks) = message_hooks.as_mut() {
						hooks.delta(part.index, fragment);
					}
					if let Some(call_id) = part_calls.get(&part.index)
						&& let Some(guard) = streaming_edit_guard.as_ref()
					{
						guard.push_fragment(call_id.as_str(), fragment);
					}
					let stream_part =
						stream_parts
							.get(&part.index)
							.map(|(source, tool_name)| StreamPart {
								index:     part.index,
								source:    *source,
								tool_name: tool_name.as_deref(),
							});
					let mut stream_fold = self
						.arbiter
						.resolve_and_record(
							Point::Stream,
							&PointCx {
								turn_id: Some(turn_id.as_str()),
								stream_delta: Some(fragment),
								stream_part,
								hidden,
								now_ms: now_ms(),
								..PointCx::default()
							},
							None,
							&mut self.journal,
						)
						.map_err(|_| TurnError::Protocol("failed to journal stream regime resolution"))?;
					if stream_fold.regime.control == ResolutionKind::Cancel {
						if let Some(hooks) = message_hooks.as_mut() {
							hooks.finish("interrupted");
						}
						return Ok(DriveSessionResult::Cancelled(StreamCancel {
							activation: stream_fold
								.regime
								.controlling_activation
								.take()
								.unwrap_or_else(|| sf!("regime")),
							reason:     stream_fold
								.regime
								.cancel_reason
								.take()
								.unwrap_or_else(|| sf!("regime cancelled the stream")),
							injects:    mem::take(&mut stream_fold.regime.injects),
						}));
					}
					if let Some(call_id) = part_calls.get(&part.index) {
						speculative
							.get_mut(call_id)
							.expect("part call owns speculation")
							.relay_fragment(fragment.to_str())
							.await
							.map_err(|_| TurnError::Protocol("failed to relay speculative arguments"))?;
					}
				},
				Some(turn_event::Event::PartEnd(part)) => {
					part_calls.remove(&part.index);
					stream_parts.remove(&part.index);
				},
				Some(turn_event::Event::Invoke(invoke)) => duplex.start(invoke),
				Some(turn_event::Event::InvokeCancel(cancel)) => {
					duplex.cancel(&cancel.invocation_id);
				},
				_ => {},
			}
		}
	}

	async fn reconcile_speculation(
		&mut self,
		turn_id: &TurnId<str>,
		output: &[Item],
		speculative: &mut BTreeMap<Str, SpeculativeCall>,
		registry: &ToolRegistry,
		enabled_tools: &[Str],
	) -> Result<(), AgentError> {
		for item in output {
			let Some(item::Kind::ToolCall(call)) = &item.kind else {
				continue;
			};
			let restored = restored_argument_bytes(&call.args_json, self.secret_obfuscator.as_ref())?;
			if let Some(opened) = speculative.get(call.id.as_str()) {
				if speculation_commits_verbatim(opened.relayed_args(), &restored) {
					continue;
				}
				// The streamed fragments no longer parse to the final arguments
				// (recovery repair or secret restoration), so the invocation
				// consumed a stale prefix. Restart it with the final arguments.
				let stale = speculative
					.remove(call.id.as_str())
					.expect("divergent speculation was just observed");
				stale.abandon().await;
			}
			if !enabled_tools.iter().any(|name| name.as_str() == call.name) {
				return Err(AgentError::Protocol("outcome names disabled tool"));
			}
			let Some(identity) = registry.resolved_identity(&call.name) else {
				return Err(AgentError::Protocol("outcome names unknown tool"));
			};
			let maximum_effects = registry
				.effects_owned(&call.name)
				.map_err(|_| AgentError::Protocol("committed tool effects missing"))?;
			let invocation_props = self.invocation_mode_props(&maximum_effects)?;
			let mut opened = SpeculativeCall::open_with_props(
				&self.env,
				&self.events,
				call.id.as_str().to_str(),
				identity,
				runtime_duration(TOOL_DEADLINE),
				invocation_props,
			)
			.await?;
			opened.attach_runtime(
				self.hook_bus.clone(),
				self.invocation_fact_tx.clone(),
				maximum_effects,
				self.hook_gate.clone(),
				Str::new(turn_id.as_str()),
			)?;
			let fragment = str::from_utf8(&restored)
				.map_err(|_| AgentError::Protocol("tool arguments are not UTF-8"))?;
			opened.relay_fragment(fragment.to_str()).await?;
			speculative.insert(call.id.as_str().to_str(), opened);
		}
		Ok(())
	}

	async fn redeem_recovery(&mut self, evidence: RedemptionEvidence) {
		let Some(authority) = self.redemption_authority.clone() else {
			return;
		};
		if authority.redeem(evidence).await {
			authority.reseed_history().await;
			self.clear_provider_context();
		}
	}

	fn drain_control(&mut self) {
		while let Ok(command) = self.receivers.host_commands.try_recv() {
			if command.operation.as_str() == "omp.context.compact" {
				let _ = command.reply.send(Err(sf!(
					"CompactionBusy: compaction requires an asynchronous agent-loop boundary"
				)));
			} else {
				self.handle_host_control_sync(command);
			}
		}
		let mut regimes = Vec::new();
		let mut projections = Vec::new();
		let mut history_reset = false;
		self.control_mailbox.drain_ready(
			&mut self.journal,
			CONTROL_DRAIN_LIMIT,
			&mut self.pending_rewinds,
			&mut regimes,
			&mut projections,
			&mut history_reset,
		);
		if history_reset {
			self.pending_history_rewrite =
				Some(PendingHistoryRewrite { to: None, cause: HistoryRewriteCause::User });
		}
		for projection in projections {
			self.answer_project_thread(projection);
		}
		for regime in regimes {
			Self::handle_regime_control(&mut self.arbiter, &mut self.journal, regime);
		}
	}

	async fn handle_host_control(&mut self, command: AgentHostCommand) {
		if command.operation.as_str() != "omp.context.compact" {
			self.handle_host_control_sync(command);
			return;
		}
		let result = self.context_control_compact(&command.arguments).await;
		let _ = command.reply.send(result);
	}

	async fn context_control_compact(
		&mut self,
		arguments: &serde_json::Map<String, Value>,
	) -> Result<Value, Str> {
		if self.compaction_running || self.journal.pending_turn().is_some() {
			return Err(sf!("CompactionBusy: compaction is already running or a turn is pending"));
		}
		let mode = match arguments.get("tier") {
			None | Some(Value::Null) => None,
			Some(Value::String(tier)) => match tier.as_str() {
				"local" => Some(ManualCompactionMode::Soft),
				"remote" => Some(ManualCompactionMode::Remote),
				"prune" | "drop_media" | "elide" | "handoff" => {
					return Err(sf!(
						"CompactionRefused: requested tier is not an available summary method"
					));
				},
				_ => return Err(sf!("ContextError: unknown compaction tier")),
			},
			Some(_) => return Err(sf!("ContextError: compaction tier must be a string or null")),
		};
		let focus = match arguments.get("focus") {
			None => None,
			Some(Value::String(focus)) if focus.is_empty() => None,
			Some(Value::String(focus)) => Some(Str::new(focus)),
			Some(_) => return Err(sf!("ContextError: compaction focus must be a string")),
		};
		let outcome = Box::pin(self.compact_with_reason(
			ManualCompactionRequest { mode, focus },
			CompactionReason::Extension,
		))
		.await
		.map_err(|error| sf!("CompactionFailed: {error}"))?;
		Ok(serde_json::json!({
			"preparation_id": outcome.preparation_id,
			"tiers_run": [match outcome.method {
				ManualCompactionMode::Soft => "local",
				ManualCompactionMode::Remote => "remote",
				ManualCompactionMode::Snapcompact => "local",
			}],
			"from_extension": outcome.from_extension,
			"tokens_before": outcome.tokens_before,
			"tokens_after": outcome.tokens_after,
			"first_kept_id": outcome.first_kept.to_string(),
			"epoch": outcome.epoch,
			"summary_bytes": outcome.summary_bytes,
			"warning": outcome.warning,
		}))
	}

	fn handle_host_control_sync(&mut self, command: AgentHostCommand) {
		let result = match command.operation.as_str() {
			"omp.sessions.rename" => (|| {
				let title = command
					.arguments
					.get("title")
					.and_then(Value::as_str)
					.ok_or_else(|| sf!("session title is required"))?;
				let title = title.trim();
				self
					.journal
					.append_title(now_ms(), Str::new(title), omp_storage::transcript::TitleSource::User)
					.map_err(|error| sf!("durable session rename failed: {error}"))?;
				emit_session_renamed(
					self.hook_gate.as_deref(),
					self.journal.session_id().0.as_str(),
					(!title.is_empty()).then_some(title),
				);
				Ok(Value::Null)
			})(),
			"omp.jobs.register" => (|| {
				let value = command
					.arguments
					.get("job")
					.cloned()
					.ok_or_else(|| sf!("durable job descriptor is required"))?;
				let job: omp_tool::JobRef = serde_json::from_value(value)
					.map_err(|error| sf!("invalid durable job descriptor: {error}"))?;
				self
					.journal
					.register_job(now_ms(), job.clone())
					.map_err(|error| sf!("durable job journal failed: {error}"))?;
				self
					.jobs
					.reattach(job.clone())
					.map_err(|error| sf!("durable job board failed: {error}"))?;
				if let Some(existing) = self
					.jobs
					.snapshot()
					.into_iter()
					.find(|existing| existing.id == job.id)
					&& existing != job
				{
					return Err(sf!("durable job id is bound to another descriptor"));
				}
				serde_json::to_value(job).map_err(|error| sf!("durable job response failed: {error}"))
			})(),
			"omp.hooks.record_outcome" => (|| {
				let event_id = command
					.arguments
					.get("event_id")
					.and_then(Value::as_u64)
					.and_then(|value| u8::try_from(value).ok())
					.ok_or_else(|| sf!("hook event id is required"))?;
				let decision = command
					.arguments
					.get("decision")
					.and_then(Value::as_str)
					.map(Str::new)
					.ok_or_else(|| sf!("hook decision is required"))?;
				let invocation_id = command
					.arguments
					.get("invocation_id")
					.and_then(Value::as_str)
					.map(Str::new);
				let reason = command
					.arguments
					.get("reason")
					.and_then(Value::as_str)
					.map(Str::new);
				self
					.journal
					.record_hook_outcome(now_ms(), HookOutcome {
						invocation_id,
						event_id,
						dispatch_id: 0,
						subscription_id: None,
						phase: HookPhase::Review.ordinal(),
						decision,
						reason,
					})
					.map_err(|error| sf!("durable hook outcome failed: {error}"))?;
				Ok(Value::Null)
			})(),
			"omp.context.view" => self.context_control_view(),
			"omp.context.usage" => self.context_control_view().and_then(|view| {
				view
					.get("usage")
					.cloned()
					.ok_or_else(|| sf!("context usage projection is missing"))
			}),
			"omp.context.epoch" => Ok(Value::from(self.journal.context_position().epoch)),
			"omp.journal.entry_kinds" => {
				let extension = command
					.arguments
					.get("extension")
					.and_then(Value::as_str)
					.ok_or_else(|| sf!("extension entry-kind owner is required"));
				extension.map(|extension| {
					Value::Array(
						self
							.journal
							.entry_kind_declarations(extension)
							.into_iter()
							.map(|declaration| {
								serde_json::json!({
									"name": declaration.name,
									"rev": declaration.rev.to_string(),
									"display": declaration.display,
									"projects": declaration.projects,
								})
							})
							.collect(),
					)
				})
			},
			"omp.context.message.parts" => self.context_control_item(&command.arguments).map(|item| {
				let parts = match item.kind.as_ref() {
					Some(item::Kind::Message(message)) => message.parts.as_slice(),
					Some(item::Kind::ToolResult(result)) => result.parts.as_slice(),
					_ => &[],
				};
				Value::Array(parts.iter().filter_map(context_part_json).collect())
			}),
			"omp.context.message.raw_args" => {
				self
					.context_control_item(&command.arguments)
					.map(|item| match item.kind {
						Some(item::Kind::ToolCall(call)) => call.raw.map_or(Value::Null, |raw| {
							serde_json::json!({
								"base64": omp_core::base64::encode(raw.as_ref())
							})
						}),
						_ => Value::Null,
					})
			},
			"omp.context.message.verdict" => {
				self
					.context_control_item(&command.arguments)
					.and_then(|item| {
						let Some(item::Kind::ToolResult(result)) = item.kind else {
							return Err(sf!("NoVerdict: context item is not a tool result"));
						};
						result
							.details
							.as_ref()
							.and_then(context_proto_value_json)
							.ok_or_else(|| sf!("NoVerdict: context item has no structured verdict"))
					})
			},
			"omp.agents.pending_messages" => {
				Ok(Value::from(u64::try_from(self.mailbox.pending_len()).unwrap_or(u64::MAX)))
			},
			"omp.agents.continuations" => Ok(serde_json::json!({
				"consecutive": self.continuations.consecutive,
				"total": self.continuations.total,
				"cap": self.continuations.cap,
				"last_ms": self.continuations.last_ms,
				"refusals": self.continuations.refusals,
				"owner": self.continuations.owner,
			})),
			"omp.agents.loop_signal" => Ok(serde_json::json!({
				"repeats": self.loop_signal.repeats,
				"digest": self.loop_signal.digest,
				"no_progress_turns": self.loop_signal.no_progress_turns,
				"empty_output_retries": self.loop_signal.empty_output_retries,
				"stalled": self.loop_signal.stalled,
			})),
			"omp.agents.set_continuation_policy" => {
				let owner = command
					.arguments
					.get("_owner")
					.and_then(Value::as_str)
					.map(Str::from)
					.ok_or_else(|| sf!("continuation policy owner is required"));
				let policy = command.arguments.get("policy").and_then(Value::as_object);
				match (owner, policy) {
					(Ok(owner), Some(policy)) => {
						let on_exhausted = policy
							.get("on_exhausted")
							.and_then(Value::as_str)
							.unwrap_or("stop");
						self
							.continuation_policies
							.insert(owner, ContinuationPolicy {
								max_consecutive:  policy
									.get("max_consecutive")
									.and_then(Value::as_u64)
									.unwrap_or(8)
									.min(u64::from(u32::MAX)) as u32,
								max_total:        policy.get("max_total").and_then(Value::as_u64),
								min_interval:     Duration::from_millis(
									policy
										.get("min_interval_ms")
										.and_then(Value::as_u64)
										.unwrap_or(0),
								),
								notify_exhausted: on_exhausted == "notify",
							});
						Ok(Value::Null)
					},
					(Err(error), _) => Err(error),
					(_, None) => Err(sf!("continuation policy is required")),
				}
			},
			"omp.agents.rewind_targets" => self
				.rewind_targets()
				.map(|targets| {
					Value::Array(
						targets
							.into_iter()
							.map(|target| {
								serde_json::json!({
									"event": target.event,
									"keep": target.keep,
									"text": target.text,
									"ts_ms": 0,
									"snapshot_id": null,
								})
							})
							.collect(),
					)
				})
				.map_err(|error| Str::from(error.to_string())),
			"omp.agents.rewind" => {
				let target = command.arguments.get("to").and_then(Value::as_u64);
				let before = self
					.rewind_targets()
					.map(|targets| targets.len())
					.unwrap_or(0);
				if command
					.arguments
					.get("dry_run")
					.and_then(Value::as_bool)
					.unwrap_or(false)
				{
					let _ = command.reply.send(Ok(serde_json::json!({
						"head": target.unwrap_or(0),
						"dropped_items": before,
						"scope": "thread",
						"restore": null,
						"dry_run": true,
					})));
					return;
				}
				self
					.rewind(target)
					.map(|items| {
						serde_json::json!({
							"head": target.unwrap_or(0),
							"dropped_items": before.saturating_sub(
								self.rewind_targets().map(|targets| targets.len()).unwrap_or(0),
							),
							"scope": "thread",
							"restore": null,
							"dry_run": command
								.arguments
								.get("dry_run")
								.and_then(Value::as_bool)
								.unwrap_or(false),
							"items": items.len(),
						})
					})
					.map_err(|error| Str::from(error.to_string()))
			},
			_ => Err(sf!("unknown agent host lifecycle operation")),
		};
		let _ = command.reply.send(result);
	}

	fn context_control_view(&self) -> Result<Value, Str> {
		let events = self
			.journal
			.live_item_events()
			.map_err(|error| Str::from(error.to_string()))?;
		let items = self
			.journal
			.items_at(&events)
			.map_err(|error| Str::from(error.to_string()))?;
		let latest = self.journal.latest_receipt();
		let snapshot = latest.and_then(|receipt| receipt.outcome.context_snapshot.as_ref());
		let total_tokens = snapshot.map_or(0, |usage| usage.prompt_tokens);
		let context_window = snapshot
			.and_then(|usage| usage.window_tokens)
			.unwrap_or(total_tokens);
		let model_fallback = self.state.snapshot().turn.params.model.clone();
		let model = latest
			.map(|receipt| receipt.outcome.model.as_str())
			.filter(|model| !model.is_empty())
			.unwrap_or(model_fallback.as_str());
		let provider = latest
			.map(|receipt| receipt.outcome.provider.as_str())
			.filter(|provider| !provider.is_empty())
			.or_else(|| model.split_once('/').map(|(provider, _)| provider))
			.unwrap_or_default();
		let position = self.journal.context_position();
		let messages = events
			.into_iter()
			.zip(items.iter())
			.map(|(event, item)| context_ref_json(event, item))
			.collect::<Result<Vec<_>, _>>()?;
		Ok(serde_json::json!({
			"session_id": self.journal.session_id().0.as_str(),
			"turn_id": latest.map_or("", |receipt| receipt.turn_id.as_str()),
			"model": model,
			"provider": provider,
			"epoch": position.epoch,
			"messages": messages,
			"usage": {
				"total_tokens": total_tokens,
				"context_window": context_window,
				"reserve_tokens": 0,
				"usable_tokens": context_window,
				"fraction": if context_window == 0 {
					0.0
				} else {
					total_tokens as f64 / context_window as f64
				},
				"prompt_head_tokens": snapshot.map_or(0, |usage| usage.non_message_tokens),
				"device_catalog_tokens": 0,
				"message_tokens": snapshot.and_then(|usage| usage.message_tokens).unwrap_or(0),
				"catalog_notice_tokens": 0,
				"media_tokens": 0,
				"compaction_epoch": position.epoch,
				"threshold_fraction": 0.0,
				"in_flight": self.journal.pending_turn().is_some(),
			},
			"prompt_hash": self.prompt_hash.map_or_else(String::new, |hash| hash.to_string()),
			"reset_event": Value::Null,
		}))
	}

	fn context_control_item(&self, arguments: &serde_json::Map<String, Value>) -> Result<Item, Str> {
		let event = arguments
			.get("event")
			.and_then(Value::as_u64)
			.ok_or_else(|| sf!("context message event is required"))?;
		let seq = arguments
			.get("seq")
			.and_then(Value::as_u64)
			.ok_or_else(|| sf!("context message sequence is required"))?;
		if !self
			.journal
			.live_item_events()
			.map_err(|error| Str::from(error.to_string()))?
			.contains(&event)
		{
			return Err(sf!("ContextGone: context item is no longer live"));
		}
		let mut items = self
			.journal
			.items_at(&[event])
			.map_err(|error| Str::from(error.to_string()))?;
		let item = items
			.pop()
			.ok_or_else(|| sf!("ContextGone: context item is no longer live"))?;
		if item.seq != seq {
			return Err(sf!("ContextGone: context item sequence changed"));
		}
		Ok(item)
	}

	fn handle_regime_control(arbiter: &mut Arbiter, journal: &mut Journal, command: RegimeControl) {
		match command {
			RegimeControl::Start { spec, handler, options, reply } => {
				let result = arbiter
					.start(spec, handler, journal, options)
					.map_err(ControlError::from);
				let _ = reply.send(result);
			},
			RegimeControl::Active { reply } => {
				let _ = reply.send(Ok(arbiter.regimes().records()));
			},
			RegimeControl::Stop { activation, now_ms, reply } => {
				let result = arbiter
					.stop(activation.as_str(), now_ms, journal)
					.map_err(ControlError::from);
				let _ = reply.send(result);
			},
			RegimeControl::StopSnapshot { activation, now_ms, reply } => {
				let result = arbiter
					.stop(activation.as_str(), now_ms, journal)
					.map(|stopped| (stopped, arbiter.regimes().records()))
					.map_err(ControlError::from);
				let _ = reply.send(result);
			},
			RegimeControl::Advance { activation, reason, reply } => {
				let _ = reason;
				let result = arbiter
					.advance(activation.as_str(), now_ms(), journal)
					.map_err(ControlError::from);
				let _ = reply.send(result);
			},
			RegimeControl::Cancel { activation, reply } => {
				let result = arbiter
					.cancel(activation.as_str(), now_ms(), journal)
					.map_err(ControlError::from);
				let _ = reply.send(result);
			},
			RegimeControl::UpdateState { activation, payload, reply } => {
				let result = arbiter
					.update_state(activation.as_str(), payload.as_ref(), now_ms(), journal)
					.map_err(ControlError::from);
				let _ = reply.send(result);
			},
		}
	}

	async fn execute_scheduled_rewinds(&mut self) -> Result<bool, AgentError> {
		let mut executed = false;
		while let Some(ScheduledRewind { token, target, report, goal, started_at }) =
			self.pending_rewinds.pop_front()
		{
			self.rewind(Some(target))?;
			self.pending_history_rewrite = Some(PendingHistoryRewrite {
				to:    Some(target),
				cause: HistoryRewriteCause::Checkpoint,
			});
			let rewound_at = now_ms();
			self.journal.rewind_report(
				token.as_str(),
				goal.as_str(),
				report.as_str(),
				started_at,
				rewound_at,
			)?;
			{
				let mut state = self.checkpoint_state.lock();
				if state
					.active
					.as_ref()
					.is_some_and(|active| active.opaque_token == token)
				{
					state.active = None;
					state.last_completed = Some(CompletedCheckpoint {
						opaque_token: token,
						goal,
						report,
						started_at,
						rewound_at,
					});
				}
				state.rewind_scheduled = false;
			}
			self.reconcile_history_rewrite().await?;
			executed = true;
		}
		Ok(executed)
	}

	fn patch_input_sequences(
		&mut self,
		inputs: &[u64],
		transient_inputs: u64,
		outcome: &Outcome,
	) -> Result<(), AgentError> {
		let Some(revision) = outcome.revision.as_ref() else {
			return Ok(());
		};
		let output_len = u64::try_from(outcome.output.len())
			.map_err(|_| AgentError::Protocol("outcome too large"))?;
		let first_output = revision
			.head
			.checked_sub(output_len)
			.ok_or(AgentError::Protocol("outcome exceeds revision"))?
			+ 1;
		let input_count = u64::try_from(inputs.len())
			.map_err(|_| AgentError::Protocol("input too large"))?
			.checked_add(transient_inputs)
			.ok_or(AgentError::Protocol("input count overflow"))?;
		let first_input = first_output
			.checked_sub(input_count)
			.ok_or(AgentError::Protocol("input exceeds revision"))?;
		for (offset, target) in inputs.iter().enumerate() {
			self.journal.amend_seq(
				now_ms(),
				*target,
				first_input + u64::try_from(offset).unwrap_or(u64::MAX),
			)?;
		}
		Ok(())
	}

	fn drain_invocation_facts(&mut self) -> Result<(), AgentError> {
		while let Ok(fact) = self.receivers.invocation_fact_rx.try_recv() {
			let requested =
				restore_canonical_raw(fact.raw.as_bytes(), self.secret_obfuscator.as_ref())?;
			let patch = (!fact.admission.args_patch.is_empty())
				.then(|| canonical_raw(&fact.admission.args_patch))
				.transpose()?;
			let effective = effective_args(&requested, patch.as_deref())?;
			let admission_receipt = serde_json::value::to_raw_value(&serde_json::json!({
				"allow": fact.admission.allow,
			}))
			.map_err(|_| AgentError::Protocol("admission receipt is not canonical JSON"))?;
			let call_id = CallId(fact.invocation_id.clone());
			for transition in [
				empty_invocation_transition(
					fact.invocation_id.clone(),
					call_id.clone(),
					InvocationPhase::Open,
				),
				InvocationTransition {
					requested_args: Some(requested),
					..empty_invocation_transition(
						fact.invocation_id.clone(),
						call_id.clone(),
						InvocationPhase::ArgsFinalized,
					)
				},
				empty_invocation_transition(
					fact.invocation_id.clone(),
					call_id.clone(),
					InvocationPhase::Admission,
				),
				InvocationTransition {
					transformations: Some(patch.into_iter().collect()),
					effective_args: Some(effective),
					admission_receipt: Some(admission_receipt),
					..empty_invocation_transition(fact.invocation_id, call_id, InvocationPhase::Admitted)
				},
			] {
				// A fact drained after later phases were journaled must not
				// replay earlier steps; the journal's richer record wins.
				if self
					.journal
					.invocation_phase(transition.invocation_id.as_str())
					.is_some_and(|current| current > transition.phase)
				{
					continue;
				}
				self
					.journal
					.record_invocation_transition(now_ms(), transition)?;
			}
		}
		Ok(())
	}

	fn record_committed_invocations(
		&mut self,
		outcome: &Outcome,
		speculative: &BTreeMap<Str, SpeculativeCall>,
		receipt: &TurnReceipt,
	) -> Result<(), AgentError> {
		for (position, item) in outcome.output.iter().enumerate() {
			let Some(item::Kind::ToolCall(call)) = item.kind.as_ref() else {
				continue;
			};
			let opened = speculative
				.get(call.id.as_str())
				.ok_or(AgentError::Protocol("committed tool lacked speculation"))?;
			let requested = restore_canonical_raw(&call.args_json, self.secret_obfuscator.as_ref())?;
			let admission = opened.admission();
			let patch = admission
				.filter(|value| !value.args_patch.is_empty())
				.map(|value| canonical_raw(&value.args_patch))
				.transpose()?;
			let effective = effective_args(&requested, patch.as_deref())?;
			let admission_receipt = serde_json::value::to_raw_value(&serde_json::json!({
				"allow": admission.is_none_or(|value| value.allow),
			}))
			.map_err(|_| AgentError::Protocol("admission receipt is not canonical JSON"))?;
			let invocation_id = call.id.as_str().to_str();
			let call_id = CallId(invocation_id.clone());
			for transition in [
				empty_invocation_transition(
					invocation_id.clone(),
					call_id.clone(),
					InvocationPhase::Open,
				),
				InvocationTransition {
					requested_args: Some(requested.clone()),
					..empty_invocation_transition(
						invocation_id.clone(),
						call_id.clone(),
						InvocationPhase::ArgsFinalized,
					)
				},
				empty_invocation_transition(
					invocation_id.clone(),
					call_id.clone(),
					InvocationPhase::Admission,
				),
				InvocationTransition {
					transformations: Some(patch.into_iter().collect()),
					effective_args: Some(effective),
					admission_receipt: Some(admission_receipt),
					..empty_invocation_transition(
						invocation_id.clone(),
						call_id.clone(),
						InvocationPhase::Admitted,
					)
				},
				InvocationTransition {
					assistant_item_event: receipt.item_events.get(position).copied(),
					..empty_invocation_transition(
						invocation_id,
						call_id,
						InvocationPhase::AssistantItemCommitted,
					)
				},
			] {
				// Live admission facts may already have advanced this invocation
				// past the replayed step; the journal's richer record wins.
				if self
					.journal
					.invocation_phase(transition.invocation_id.as_str())
					.is_some_and(|current| current > transition.phase)
				{
					continue;
				}
				self
					.journal
					.record_invocation_transition(now_ms(), transition)?;
			}
		}
		Ok(())
	}

	fn transition(&mut self, to: AgentPhase) {
		if self.phase != to {
			self.events.transition(self.phase, to);
			self.phase = to;
		}
	}
}

const fn empty_invocation_transition(
	invocation_id: Str,
	call_id: CallId,
	phase: InvocationPhase,
) -> InvocationTransition {
	InvocationTransition {
		invocation_id,
		call_id,
		phase,
		requested_args: None,
		transformations: None,
		effective_args: None,
		admission_receipt: None,
		assistant_item_event: None,
		effect_token: None,
		effects: None,
		authorized_at: None,
		outcome: None,
	}
}

fn compaction_message_ref(event: u64, item: &Item, byte_len: usize) -> hook_pb::MessageRef {
	let (kind, role, part_count, media_count, tool, is_error, useless, preview) =
		match item.kind.as_ref() {
			Some(item::Kind::Message(message)) => {
				let role = match thread::Role::try_from(message.role) {
					Ok(thread::Role::System) => "system",
					Ok(thread::Role::User) => "user",
					Ok(thread::Role::Assistant) => "assistant",
					_ => "custom",
				};
				let preview = message
					.parts
					.iter()
					.find_map(|part| match part.kind.as_ref() {
						Some(part::Kind::Text(text)) => Some(text.clone()),
						_ => None,
					});
				(
					hook_pb::MessageKind::Message,
					role,
					message.parts.len(),
					message
						.parts
						.iter()
						.filter(|part| matches!(part.kind, Some(part::Kind::Blob(_))))
						.count(),
					None,
					false,
					false,
					preview.unwrap_or_default(),
				)
			},
			Some(item::Kind::ToolCall(call)) => (
				hook_pb::MessageKind::ToolCall,
				"assistant",
				1,
				0,
				Some(call.name.clone()),
				false,
				false,
				call.name.clone(),
			),
			Some(item::Kind::ToolResult(result)) => (
				hook_pb::MessageKind::ToolResult,
				"user",
				result.parts.len(),
				result
					.parts
					.iter()
					.filter(|part| matches!(part.kind, Some(part::Kind::Blob(_))))
					.count(),
				Some(result.name.clone()),
				result.is_error,
				result.useless.unwrap_or(false),
				result
					.parts
					.iter()
					.find_map(|part| match part.kind.as_ref() {
						Some(part::Kind::Text(text)) => Some(text.clone()),
						_ => None,
					})
					.unwrap_or_default(),
			),
			None => {
				(hook_pb::MessageKind::Reasoning, "assistant", 0, 0, None, false, false, String::new())
			},
		};
	hook_pb::MessageRef {
		id: event.to_string(),
		event,
		seq: item.seq,
		kind: kind as i32,
		role: role.to_owned(),
		turn_id: None,
		created_at_ms: item.created_at_ms,
		tokens: u64::try_from(byte_len.div_ceil(4)).unwrap_or(u64::MAX),
		byte_len: u64::try_from(byte_len).unwrap_or(u64::MAX),
		part_count: u32::try_from(part_count).unwrap_or(u32::MAX),
		media_count: u32::try_from(media_count).unwrap_or(u32::MAX),
		tool,
		is_error,
		useless,
		pinned: false,
		elided: false,
		superseded_by: None,
		artifacts: Vec::new(),
		preview,
		props: None,
	}
}

fn context_ref_json(event: u64, item: &Item) -> Result<Value, Str> {
	let bytes = serde_json::to_vec(item).map_err(|error| Str::from(error.to_string()))?;
	let (kind, role, part_count, media_count, tool, is_error, useless, preview) =
		match item.kind.as_ref() {
			Some(item::Kind::Message(message)) => {
				let role = match thread::Role::try_from(message.role) {
					Ok(thread::Role::System) => "system",
					Ok(thread::Role::User) => "user",
					Ok(thread::Role::Assistant) => "assistant",
					_ => "custom",
				};
				let preview = message
					.parts
					.iter()
					.find_map(|part| match part.kind.as_ref() {
						Some(part::Kind::Text(text)) => Some(text.as_str()),
						_ => None,
					});
				(
					role,
					role,
					message.parts.len(),
					message
						.parts
						.iter()
						.filter(|part| matches!(part.kind, Some(part::Kind::Blob(_))))
						.count(),
					Value::Null,
					false,
					false,
					preview,
				)
			},
			Some(item::Kind::ToolCall(call)) => (
				"tool_call",
				"assistant",
				1,
				0,
				serde_json::json!({"name": call.name, "family": "", "rev": 0}),
				false,
				false,
				Some(call.name.as_str()),
			),
			Some(item::Kind::ToolResult(result)) => (
				"tool_result",
				"user",
				result.parts.len(),
				result
					.parts
					.iter()
					.filter(|part| matches!(part.kind, Some(part::Kind::Blob(_))))
					.count(),
				serde_json::json!({"name": result.name, "family": "", "rev": 0}),
				result.is_error,
				result.useless.unwrap_or(false),
				result
					.parts
					.iter()
					.find_map(|part| match part.kind.as_ref() {
						Some(part::Kind::Text(text)) => Some(text.as_str()),
						_ => None,
					}),
			),
			None => ("custom", "custom", 0, 0, Value::Null, false, false, None),
		};
	Ok(serde_json::json!({
		"id": event.to_string(),
		"event": event,
		"seq": item.seq,
		"kind": kind,
		"role": role,
		"turn_id": Value::Null,
		"created_at_ms": item.created_at_ms,
		"tokens": u64::try_from(bytes.len().div_ceil(4)).unwrap_or(u64::MAX),
		"byte_len": bytes.len(),
		"part_count": part_count,
		"media_count": media_count,
		"tool": tool,
		"is_error": is_error,
		"useless": useless,
		"pinned": false,
		"elided": false,
		"superseded_by": Value::Null,
		"artifacts": [],
		"preview": preview.unwrap_or_default(),
	}))
}

fn context_part_json(part: &thread::Part) -> Option<Value> {
	match part.kind.as_ref()? {
		part::Kind::Text(text) => Some(serde_json::json!({"kind": "text", "text": text})),
		part::Kind::Blob(blob) => Some(serde_json::json!({
			"kind": "blob",
			"hash": omp_core::hex::encode(blob.hash.as_ref()).to_string(),
			"size": blob.size,
			"alt": Value::Null,
		})),
		part::Kind::Thinking(_) | part::Kind::Fallback(_) | part::Kind::ServerTool(_) => None,
	}
}
fn context_proto_value_json(value: &pb::Value) -> Option<Value> {
	Some(match value.kind.as_ref()? {
		value::Kind::Null(_) => Value::Null,
		value::Kind::Bool(value) => Value::Bool(*value),
		value::Kind::Int(value) => Value::from(*value),
		value::Kind::Uint(value) => Value::from(*value),
		value::Kind::Double(value) => serde_json::Number::from_f64(*value)
			.map(Value::Number)
			.unwrap_or(Value::Null),
		value::Kind::String(value) => Value::String(value.clone()),
		value::Kind::List(values) => Value::Array(
			values
				.values
				.iter()
				.filter_map(context_proto_value_json)
				.collect(),
		),
		value::Kind::Map(values) => Value::Object(
			values
				.fields
				.iter()
				.filter_map(|(key, value)| {
					context_proto_value_json(value).map(|value| (key.clone(), value))
				})
				.collect(),
		),
	})
}

fn publish_input_attachments(session: &str, input: &TurnInput) {
	match input {
		TurnInput::Full(thread) => attachments::publish_session_attachments(session, thread),
		TurnInput::Delta(_, delta) => {
			attachments::publish_session_attachments(session, &Thread { items: delta.append.clone() });
		},
	}
}

fn obfuscate_provider_input(
	input: &mut TurnInput,
	secret_obfuscator: Option<&Arc<Mutex<SecretObfuscator>>>,
) -> Result<(), AgentError> {
	let Some(secret_obfuscator) = secret_obfuscator else {
		return Ok(());
	};
	let mut obfuscator = secret_obfuscator.lock();
	let items = match input {
		TurnInput::Full(thread) => &mut thread.items,
		TurnInput::Delta(_, delta) => &mut delta.append,
	};
	for item in items {
		match item.kind.as_mut() {
			Some(item::Kind::Message(message)) => {
				let kind = match thread::Role::try_from(message.role) {
					Ok(thread::Role::User) => MessageTextKind::User,
					Ok(thread::Role::Assistant) => MessageTextKind::AssistantReplay,
					Ok(thread::Role::System | thread::Role::Unspecified) | Err(_) => {
						MessageTextKind::System
					},
				};
				for part in &mut message.parts {
					if let Some(part::Kind::Text(text)) = part.kind.as_mut() {
						let mapped = obfuscate_message_text(&mut obfuscator, kind, text);
						if mapped != *text {
							*text = mapped;
						}
					}
				}
			},
			Some(item::Kind::ToolResult(result)) => {
				for part in &mut result.parts {
					if let Some(part::Kind::Text(text)) = part.kind.as_mut() {
						let mapped =
							obfuscate_message_text(&mut obfuscator, MessageTextKind::ToolResult, text);
						if mapped != *text {
							*text = mapped;
						}
					}
				}
			},
			Some(item::Kind::ToolCall(call)) => {
				let mut value: serde_json::Value = serde_json::from_slice(&call.args_json)
					.map_err(|_| AgentError::Protocol("tool arguments are not one JSON document"))?;
				obfuscate_json(&mut value, &mut obfuscator);
				call.args_json = bytes::Bytes::from(
					serde_json::to_vec(&value)
						.map_err(|_| AgentError::Protocol("tool arguments could not be encoded"))?,
				);
			},
			None => {},
		}
	}
	Ok(())
}

fn restore_provider_output(
	items: &mut [Item],
	secret_obfuscator: Option<&Arc<Mutex<SecretObfuscator>>>,
	allow_incomplete_tool_args: bool,
) -> Result<(), AgentError> {
	let Some(secret_obfuscator) = secret_obfuscator else {
		return Ok(());
	};
	let obfuscator = secret_obfuscator.lock();
	for item in items {
		match item.kind.as_mut() {
			Some(item::Kind::Message(message))
				if thread::Role::try_from(message.role) == Ok(thread::Role::Assistant) =>
			{
				for part in &mut message.parts {
					if let Some(part::Kind::Text(text)) = part.kind.as_mut() {
						let restored =
							restore_message_text(&obfuscator, MessageTextKind::AssistantOutput, text);
						if restored != *text {
							*text = restored;
						}
					}
				}
			},
			Some(item::Kind::ToolCall(call)) => {
				let mut value: serde_json::Value = match serde_json::from_slice(&call.args_json) {
					Ok(value) => value,
					Err(_) if allow_incomplete_tool_args => continue,
					Err(_) => {
						return Err(AgentError::Protocol("tool arguments are not one JSON document"));
					},
				};
				deobfuscate_json(&mut value, &obfuscator);
				call.args_json = bytes::Bytes::from(
					serde_json::to_vec(&value)
						.map_err(|_| AgentError::Protocol("tool arguments could not be encoded"))?,
				);
				if let Some(intent) = call.intent.as_mut() {
					let restored =
						restore_message_text(&obfuscator, MessageTextKind::ModelMetadata, intent);
					if restored != *intent {
						*intent = restored;
					}
				}
			},
			Some(item::Kind::Message(_)) | Some(item::Kind::ToolResult(_)) | None => {},
		}
	}
	Ok(())
}

fn restore_canonical_raw(
	bytes: &[u8],
	secret_obfuscator: Option<&Arc<Mutex<SecretObfuscator>>>,
) -> Result<Box<RawValue>, AgentError> {
	let mut value = serde_json::from_slice::<Value>(bytes)
		.map_err(|_| AgentError::Protocol("tool arguments are not one JSON document"))?;
	if let Some(obfuscator) = secret_obfuscator {
		deobfuscate_json(&mut value, &obfuscator.lock());
	}
	serde_json::value::to_raw_value(&value)
		.map_err(|_| AgentError::Protocol("tool arguments cannot be canonicalized"))
}

fn restored_argument_bytes(
	bytes: &[u8],
	secret_obfuscator: Option<&Arc<Mutex<SecretObfuscator>>>,
) -> Result<bytes::Bytes, AgentError> {
	let restored = restore_canonical_raw(bytes, secret_obfuscator)?;
	Ok(bytes::Bytes::copy_from_slice(restored.get().as_bytes()))
}

/// Whether streamed speculative fragments remain authoritative for the final
/// canonical arguments.
///
/// Empty fragments commit through the feed's seeded path, and byte-diverging
/// fragments stay authoritative while they parse to the same JSON value
/// (providers may stream non-canonical whitespace or escape forms). A
/// value-level difference means recovery repair or secret restoration rewrote
/// the arguments after their prefix was already consumed.
fn speculation_commits_verbatim(relayed: &str, restored: &[u8]) -> bool {
	if relayed.is_empty() || relayed.as_bytes() == restored {
		return true;
	}
	match (serde_json::from_str::<Value>(relayed), serde_json::from_slice::<Value>(restored)) {
		(Ok(streamed), Ok(canonical)) => streamed == canonical,
		_ => false,
	}
}

fn canonical_raw(bytes: &[u8]) -> Result<Box<RawValue>, AgentError> {
	let value = serde_json::from_slice::<Value>(bytes)
		.map_err(|_| AgentError::Protocol("invocation arguments are not one JSON document"))?;
	serde_json::value::to_raw_value(&value)
		.map_err(|_| AgentError::Protocol("invocation arguments cannot be canonicalized"))
}

fn effective_args(
	requested: &RawValue,
	patch: Option<&RawValue>,
) -> Result<Box<RawValue>, AgentError> {
	let mut value = serde_json::from_str::<Value>(requested.get())
		.map_err(|_| AgentError::Protocol("canonical requested arguments became invalid"))?;
	if let Some(patch) = patch {
		let patch = serde_json::from_str::<Value>(patch.get())
			.map_err(|_| AgentError::Protocol("admission patch is not valid JSON"))?;
		apply_merge_patch(&mut value, patch);
	}
	serde_json::value::to_raw_value(&value)
		.map_err(|_| AgentError::Protocol("effective arguments cannot be canonicalized"))
}

fn apply_merge_patch(target: &mut Value, patch: Value) {
	let Value::Object(patch) = patch else {
		*target = patch;
		return;
	};
	if !target.is_object() {
		*target = Value::Object(serde_json::Map::new());
	}
	let target = target
		.as_object_mut()
		.expect("target was normalized to an object");
	for (key, value) in patch {
		if value.is_null() {
			target.remove(&key);
		} else {
			apply_merge_patch(target.entry(key).or_insert(Value::Null), value);
		}
	}
}

fn committed_calls(
	output: &[Item],
	speculative: &mut BTreeMap<Str, SpeculativeCall>,
	secret_obfuscator: Option<&Arc<Mutex<SecretObfuscator>>>,
) -> Result<Vec<CommittedCall>, AgentError> {
	let mut committed = Vec::new();
	for item in output {
		let Some(item::Kind::ToolCall(call)) = &item.kind else {
			continue;
		};
		let opened = speculative
			.remove(call.id.as_str())
			.ok_or(AgentError::Protocol("committed tool lacked speculation"))?;
		if opened.identity().name.as_str() != call.name {
			return Err(AgentError::Protocol("committed tool identity changed"));
		}
		let committed_rev = item
			.props
			.as_ref()
			.and_then(|props| props.fields.get(omp_tool::TOOL_REV_PROP))
			.and_then(|value| value.kind.as_ref())
			.and_then(|kind| match kind {
				value::Kind::String(value) => Some(value.as_str()),
				_ => None,
			})
			.ok_or(AgentError::Protocol("committed tool revision missing"))?;
		if committed_rev != opened.identity().rev.to_string() {
			return Err(AgentError::Protocol("committed tool revision changed"));
		}
		let restored = restored_argument_bytes(&call.args_json, secret_obfuscator)?;
		// The tool's streaming parser consumed the relayed fragments verbatim,
		// so they stay authoritative whenever they parse to the final
		// arguments; providers may stream non-canonical whitespace or escapes
		// that a canonical re-serialization would silently rewrite.
		let raw = match opened.relayed_args() {
			relayed if speculation_commits_verbatim(relayed, &restored) && !relayed.is_empty() => {
				bytes::Bytes::copy_from_slice(relayed.as_bytes())
			},
			_ => restored,
		};
		committed.push(opened.commit(raw));
	}
	Ok(committed)
}

fn validate_outcome(outcome: &Outcome) -> Result<(), AgentError> {
	let mut tool_calls = BTreeSet::new();
	for call in outcome
		.output
		.iter()
		.filter_map(|item| match item.kind.as_ref() {
			Some(item::Kind::ToolCall(call)) => Some(call),
			_ => None,
		}) {
		if !tool_calls.insert(call.id.as_str()) {
			return Err(AgentError::Protocol("outcome contains duplicate tool-call IDs"));
		}
	}
	if outcome.stop() == pb::StopReason::StopToolUse && tool_calls.is_empty() {
		return Err(AgentError::Protocol("tool-use outcome has no tool calls"));
	}
	if let Some(revision) = outcome.revision.as_ref() {
		let count = u64::try_from(outcome.output.len())
			.map_err(|_| AgentError::Protocol("outcome too large"))?;
		let first = revision
			.head
			.checked_sub(count)
			.ok_or(AgentError::Protocol("outcome exceeds revision"))?
			+ 1;
		for (offset, item) in outcome.output.iter().enumerate() {
			if item.seq != first + u64::try_from(offset).unwrap_or(u64::MAX) {
				return Err(AgentError::Protocol("outcome sequences are not a consecutive suffix"));
			}
		}
	}
	Ok(())
}

fn mid_turn_compaction_due(policy: MidTurnCompactionPolicy, usage: Option<&pb::Usage>) -> bool {
	let occupancy = usage
		.map(|usage| {
			usage
				.context_tokens
				.or(usage.total_tokens)
				.unwrap_or(usage.input_tokens)
		})
		.unwrap_or_default();
	policy.enabled && occupancy >= policy.threshold_tokens
}

fn truncated_tool_results(output: &[Item]) -> Result<Vec<Item>, AgentError> {
	output
		.iter()
		.filter(|item| matches!(item.kind, Some(item::Kind::ToolCall(_))))
		.map(|call| {
			crate::project::recovery_tool_result_item(now_ms(), call, Abort::Skipped {
				reason: sf!(
					"tool call was truncated by the output-token limit; retry with smaller, chunked \
					 arguments",
				),
			})
			.map_err(AgentError::from)
		})
		.collect()
}
impl<C: TurnClient> Drop for Agent<C> {
	fn drop(&mut self) {
		let Some(memory) = self.session_memory.as_ref() else {
			return;
		};
		match settled_retention_messages(&self.journal) {
			Ok(messages) => {
				if let Err(error) = memory.shutdown_flush(messages) {
					tracing::warn!(%error, "session memory shutdown flush failed");
				}
			},
			Err(error) => tracing::warn!(%error, "session memory shutdown projection failed"),
		}
	}
}

fn settled_retention_messages(
	journal: &Journal,
) -> Result<Vec<OwnedRetentionMessage>, JournalError> {
	let indexes = journal.live_item_events()?;
	let items = journal.items_at(&indexes)?;
	let mut messages = Vec::new();
	for (index, item) in indexes.into_iter().zip(items) {
		let (role, parts) = match item.kind.as_ref() {
			Some(item::Kind::Message(message)) => {
				let role =
					match thread::Role::try_from(message.role).unwrap_or(thread::Role::Unspecified) {
						thread::Role::User => RetentionRole::User,
						thread::Role::Assistant => RetentionRole::Assistant,
						thread::Role::System => RetentionRole::System,
						thread::Role::Unspecified => continue,
					};
				(role, message.parts.as_slice())
			},
			Some(item::Kind::ToolResult(result)) => (RetentionRole::Tool, result.parts.as_slice()),
			_ => continue,
		};
		let content = parts
			.iter()
			.filter_map(|part| match part.kind.as_ref() {
				Some(part::Kind::Text(text)) => Some(text.as_str()),
				_ => None,
			})
			.collect::<Vec<_>>()
			.join("\n");
		if !content.trim().is_empty() {
			messages.push(OwnedRetentionMessage {
				stable_id: Str::new(index.to_string()),
				role,
				content: Str::new(content),
			});
		}
	}
	Ok(messages)
}
fn telemetry_envelope() -> Envelope {
	Envelope { occurred_at_ms: now_ms(), ..Envelope::default() }
}

async fn wait_deadline(deadline: Option<Instant>) {
	match deadline {
		Some(deadline) => {
			use tokio::time::Instant;

			time::sleep_until(Instant::from_std(deadline)).await
		},
		None => future::pending().await,
	}
}
async fn wait_stream_watchdog(timeout_ms: Option<u64>) {
	match timeout_ms {
		Some(timeout_ms) => time::sleep(Duration::from_millis(timeout_ms)).await,
		None => future::pending().await,
	}
}
async fn wait_streaming_edit_abort(
	guard: Option<&StreamingEditGuard>,
) -> crate::StreamingEditAbort {
	match guard {
		Some(guard) => guard
			.recv_abort()
			.await
			.expect("streaming edit guard worker remains live"),
		None => future::pending().await,
	}
}

fn turn_input_has_tool_results(input: &TurnInput) -> bool {
	let items = match input {
		TurnInput::Full(thread) => thread.items.as_slice(),
		TurnInput::Delta(_, delta) => delta.append.as_slice(),
	};
	items
		.iter()
		.any(|item| matches!(item.kind, Some(item::Kind::ToolResult(_))))
}
fn stream_watchdog_error(
	mailbox: &MailboxSender,
	saw_event: bool,
	pending_tool_results: bool,
) -> TurnError {
	if let Some(kind) =
		repetition::classify_stream_recovery(None, false, saw_event, pending_tool_results)
	{
		let _ = mailbox.try_enqueue(Interrupt {
			class:  InterruptClass::TurnBoundary,
			item:   stream_recovery_item(kind),
			source: InterruptSource::Continuation { owner: sf!("regime") },
		});
	}
	TurnError::Rpc(tonic::Status::deadline_exceeded("stream watchdog elapsed"))
}

async fn sleep_with_deadline(
	duration: Duration,
	deadline: Option<Instant>,
) -> Result<(), AgentError> {
	tokio::select! {
		() = time::sleep(duration) => Ok(()),
		() = wait_deadline(deadline) => Err(AgentError::Deadline),
	}
}

fn shake_item(
	item: &mut Item,
	tier: CompactionTier,
	store: &BlobStore,
	catalog: &Arc<Mutex<ArtifactCatalog>>,
	session: &omp_storage::transcript::SessionId,
	replaced_regions: &mut u64,
	removed_bytes: &mut u64,
) -> Result<(), AgentError> {
	let (parts, tool_result) = match item.kind.as_mut() {
		Some(item::Kind::Message(message)) => (&mut message.parts, false),
		Some(item::Kind::ToolResult(result)) => (&mut result.parts, true),
		_ => return Ok(()),
	};
	for part in parts {
		let replacement = match part.kind.as_ref() {
			Some(part::Kind::Text(text))
				if tier == CompactionTier::Elide
					&& text.len() >= 1_600
					&& (tool_result || shake_block_candidate(text)) =>
			{
				let reference = store.put(text.as_bytes())?;
				let artifact = catalog.lock().adopt(
					session,
					reference.hash.into_bytes(),
					Some(reference.size),
					ArtifactLifetime::Session,
				)?;
				*removed_bytes =
					removed_bytes.saturating_add(u64::try_from(text.len()).unwrap_or(u64::MAX));
				Some(format!(
					"[{} bytes elided by /shake; recover with {}]",
					text.len(),
					artifact.url()
				))
			},
			Some(part::Kind::Blob(blob)) if tier == CompactionTier::DropMedia => {
				let digest = <[u8; 32]>::try_from(blob.hash.as_ref())
					.ok()
					.map(Hash32::new)
					.map(|hash| hash.to_hex().to_string());
				*removed_bytes = removed_bytes.saturating_add(
					blob
						.size
						.max(u64::try_from(blob.inline.len()).unwrap_or(u64::MAX)),
				);
				Some(digest.map_or_else(
					|| String::from("[Media removed by /shake drop-media]"),
					|digest| {
						format!("[Media removed by /shake drop-media; recover with artifact://{digest}]")
					},
				))
			},
			_ => None,
		};
		if let Some(replacement) = replacement {
			part.kind = Some(part::Kind::Text(replacement));
			*replaced_regions = replaced_regions.saturating_add(1);
		}
	}
	Ok(())
}

fn shake_block_candidate(text: &str) -> bool {
	text.contains("```")
		|| text.contains("~~~")
		|| text
			.lines()
			.any(|line| line.starts_with('<') && line.ends_with('>'))
}

fn interrupt_reason(source: &InterruptSource) -> Str {
	match source {
		InterruptSource::Job { id } => format!("job {} settled", id.as_str()).to_str(),
		InterruptSource::Continuation { owner } => {
			format!("continuation from {}", owner.as_str()).to_str()
		},
		InterruptSource::Schedule { id } => format!("schedule {} fired", id.as_str()).to_str(),
		InterruptSource::Peer { from } => format!("peer {} steered", from.as_str()).to_str(),
		InterruptSource::Remote { principal } => {
			sf!("remote guest {} steered", principal.display_name())
		},
		InterruptSource::DeferredDiagnostics { document, revision, .. } => {
			format!("deferred diagnostics for {} at revision {}", document.as_str(), revision).to_str()
		},
		InterruptSource::Producer(name) => name.clone(),
	}
}

fn tool_call_digest(items: &[Item]) -> Option<Str> {
	let mut hasher = Hash32::hasher();
	let mut calls = 0_u32;
	for item in items {
		let Some(item::Kind::ToolCall(call)) = &item.kind else {
			continue;
		};
		calls = calls.saturating_add(1);
		hasher.update((call.name.len() as u64).to_le_bytes());
		hasher.update(call.name.as_bytes());
		hasher.update((call.args_json.len() as u64).to_le_bytes());
		hasher.update(&call.args_json);
	}
	(calls != 0).then(|| Str::new(hasher.finalize().to_string()))
}

fn recovery_prompt_item(id: PromptAssetId) -> Item {
	Item {
		seq:           0,
		created_at_ms: now_ms(),
		kind:          Some(item::Kind::Message(thread::Message {
			role:  thread::Role::User as i32,
			parts: vec![thread::Part {
				kind: Some(part::Kind::Text(format!(
					"<system-injection>\n{}\n</system-injection>",
					crate::prompt_assets::prompt_asset(id).content.trim(),
				))),
			}],
		})),
		props:         None,
	}
}
fn terminal_error_item(error: &pb::TurnError) -> Item {
	Item {
		seq:           0,
		created_at_ms: now_ms(),
		kind:          Some(item::Kind::Message(thread::Message {
			role:  thread::Role::Assistant as i32,
			parts: vec![thread::Part { kind: Some(part::Kind::Text(error.detail.clone())) }],
		})),
		props:         Some(pb::ValueMap {
			fields: BTreeMap::from([(
				crate::journal_kinds::TERMINAL_ERROR_PROP.to_owned(),
				pb::Value { kind: Some(value::Kind::Bool(true)) },
			)]),
		}),
	}
}
/// Builds the structurally suppressed assistant marker retained for one
/// silently aborted, regime-cancelled turn.
fn silent_abort_item(reason: &str) -> Item {
	Item {
		seq:           0,
		created_at_ms: now_ms(),
		kind:          Some(item::Kind::Message(thread::Message {
			role:  thread::Role::Assistant as i32,
			parts: Vec::new(),
		})),
		props:         Some(pb::ValueMap {
			fields: BTreeMap::from([
				(crate::journal_kinds::SILENT_ABORT_PROP.to_owned(), pb::Value {
					kind: Some(value::Kind::Bool(true)),
				}),
				(crate::journal_kinds::ABORT_REASON_PROP.to_owned(), pb::Value {
					kind: Some(value::Kind::String(reason.to_owned())),
				}),
			]),
		}),
	}
}

fn tool_loop_redirect_item(count: u32, digest: &str) -> Item {
	let mut content = String::new();
	prompt_assets::render_tool_call_loop_redirect(&mut content, count, digest);
	Item {
		seq:           0,
		created_at_ms: now_ms(),
		kind:          Some(item::Kind::Message(thread::Message {
			role:  thread::Role::User as i32,
			parts: vec![thread::Part { kind: Some(part::Kind::Text(content)) }],
		})),
		props:         None,
	}
}

fn duplex_turn_error(error: DuplexError) -> TurnError {
	TurnError::Protocol(match error {
		DuplexError::Batch(_) => "duplex tool batch failed",
		DuplexError::Registry(_) => "duplex tool registry failed",
		DuplexError::MissingToolResult => "duplex completion missing tool result",
	})
}
fn follow_up_id(_root: &TurnId<str>, _ordinal: u32) -> TurnId {
	TurnId::new(omp_core::Ulid::generate().to_string())
}
fn batch_terminates(results: impl IntoIterator<Item = bool>) -> bool {
	let mut results = results.into_iter();
	results
		.next()
		.is_some_and(|first| first && results.all(|terminate| terminate))
}

fn accumulate_usage(target: &mut pb::Usage, source: &pb::Usage) {
	target.input_tokens = target.input_tokens.saturating_add(source.input_tokens);
	target.output_tokens = target.output_tokens.saturating_add(source.output_tokens);
	target.cache_read_tokens = target
		.cache_read_tokens
		.saturating_add(source.cache_read_tokens);
	target.cache_write_tokens = target
		.cache_write_tokens
		.saturating_add(source.cache_write_tokens);
	target.reasoning_tokens = match (target.reasoning_tokens, source.reasoning_tokens) {
		(Some(left), Some(right)) => Some(left.saturating_add(right)),
		(left, None) => left,
		(None, right) => right,
	};
	target.total_tokens = match (target.total_tokens, source.total_tokens) {
		(Some(left), Some(right)) => Some(left.saturating_add(right)),
		(left, None) => left,
		(None, right) => right,
	};
}

fn runtime_duration(duration: omp_core::Duration) -> Duration {
	duration
		.to_std()
		.expect("agent runtime duration constants fit std::time::Duration")
}

pub fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or(Duration::ZERO)
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
	use std::{
		collections::{BTreeMap, VecDeque},
		env, fs, future,
		path::PathBuf,
		sync::Arc,
		task,
	};

	use bytes::Bytes;
	use futures::stream;
	use omp_secrets::rule::{SecretKind, SecretMode, SecretRule};
	use omp_storage::transcript::{Entry, Header, Kind, SessionId};
	use omp_tool::{
		Claims, Constraint, Effects, HostToolExecutor, HostToolInvocation, HostToolResult,
		HostToolSpec, HostToolUpdateSink, ModelClass, Precedence, Presentation, Rev, ToolIdentity,
		ToolSpec,
	};
	use parking_lot::Mutex;

	use super::*;
	use crate::{ContextPatchSet, InheritPosition, InvokeFrame, PatchOp};

	type Script = Vec<Result<pb::TurnEvent, TurnError>>;
	fn observe_subscription(event: hook_pb::HookEventId, id: u32) -> crate::Subscription {
		crate::Subscription {
			host: sf!("test"),
			source: crate::SourceRef {
				layer:        0,
				publisher:    sf!("test"),
				extension_id: sf!("stream"),
			},
			id,
			event,
			phase: HookPhase::Observe,
			order: 0,
			on_failure: crate::OnFailure::Defer,
			when: crate::When::default(),
		}
	}

	#[test]
	fn before_agent_start_custom_message_values_lower_to_user_items() {
		let mut items = vec![Item::default()];
		append_hook_custom_messages(
			&mut items,
			&[
				serde_json::json!({"kind": "message", "item_id": "existing"}),
				serde_json::json!({"kind": "message", "content": "extension context"}),
			],
			1,
		);
		assert_eq!(items.len(), 2);
		let item = items.pop().expect("custom message");
		let item::Kind::Message(message) = item.kind.expect("message item") else {
			panic!("expected message");
		};
		assert_eq!(message.role(), thread::Role::User);
		assert!(matches!(
			message.parts.as_slice(),
			[thread::Part { kind: Some(part::Kind::Text(text)) }] if text == "extension context"
		));
	}

	#[test]
	fn message_hooks_coalesce_updates_and_report_running_char_count() {
		let (gate, receiver) = HookGate::channel();
		gate
			.subscribe("test", [
				observe_subscription(hook_pb::HookEventId::HookEventMessageStart, 18),
				observe_subscription(hook_pb::HookEventId::HookEventMessageUpdate, 19),
				observe_subscription(hook_pb::HookEventId::HookEventMessageEnd, 20),
			])
			.unwrap();
		let mut stream = MessageHookStream::new(Arc::new(gate), sf!("turn-1"));
		stream.last_flush = Instant::now() + Duration::from_secs(1);
		stream.start(0, StreamSource::Text);
		stream.delta(0, "hé");
		stream.delta(0, "llo");
		stream.finish("complete");
		let start = receiver.try_recv().unwrap();
		let update = receiver.try_recv().unwrap();
		let end = receiver.try_recv().unwrap();
		assert_eq!(start.event, hook_pb::HookEventId::HookEventMessageStart);
		assert_eq!(update.event, hook_pb::HookEventId::HookEventMessageUpdate);
		assert_eq!(end.event, hook_pb::HookEventId::HookEventMessageEnd);
		let payload = serde_json::from_slice::<Value>(&update.payload).unwrap();
		assert_eq!(payload["delta"], "héllo");
		assert_eq!(payload["coalesced"], 2);
		assert_eq!(payload["total_chars"], 5);
		assert!(receiver.try_recv().is_err());
	}
	#[test]
	fn message_delta_work_stays_empty_without_update_subscription() {
		let (gate, _) = HookGate::channel();
		gate
			.subscribe("test", [observe_subscription(hook_pb::HookEventId::HookEventMessageStart, 18)])
			.unwrap();
		let mut stream = MessageHookStream::new(Arc::new(gate), sf!("turn-1"));
		stream.start(0, StreamSource::Text);
		stream.delta(0, "not accumulated");
		assert_eq!(stream.total_chars, 0);
		assert!(stream.pending.is_none());
	}

	#[test]
	fn fallback_model_change_emits_reason_and_resolved_models_only_when_subscribed() {
		let (gate, receiver) = HookGate::channel();
		let builds = std::sync::atomic::AtomicUsize::new(0);
		emit_fallback_model_changed(
			Some(&gate),
			|| {
				builds.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
				("anthropic/claude".to_owned(), Some(pb::Effort::Low as i32))
			},
			"openai/gpt",
		);
		assert_eq!(builds.load(std::sync::atomic::Ordering::Relaxed), 0);

		gate
			.subscribe("test", [crate::Subscription {
				host:       sf!("test"),
				source:     crate::SourceRef {
					layer:        0,
					publisher:    sf!("test"),
					extension_id: sf!("fallback"),
				},
				id:         45,
				event:      hook_pb::HookEventId::HookEventModelChanged,
				phase:      HookPhase::Observe,
				order:      0,
				on_failure: crate::OnFailure::Defer,
				when:       crate::When::default(),
			}])
			.unwrap();
		emit_fallback_model_changed(
			Some(&gate),
			|| {
				builds.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
				("anthropic/claude".to_owned(), Some(pb::Effort::Low as i32))
			},
			"openai/gpt",
		);
		assert_eq!(builds.load(std::sync::atomic::Ordering::Relaxed), 1);
		let dispatch = receiver
			.try_recv()
			.expect("model_changed fallback observation");
		assert_eq!(dispatch.event, hook_pb::HookEventId::HookEventModelChanged);
		let payload = serde_json::from_slice::<Value>(&dispatch.payload).unwrap();
		assert_eq!(payload["reason"], "fallback");
		assert_eq!(payload["role"], "anthropic/claude");
		assert_eq!(payload["from_model"]["provider"], "anthropic");
		assert_eq!(payload["to_model"]["provider"], "openai");
		assert_eq!(payload["previous_thinking"], "low");
		assert_eq!(payload["thinking"], "low");
	}
	#[test]
	fn session_renamed_observation_is_bitmap_gated() {
		let (gate, receiver) = HookGate::channel();
		emit_session_renamed(Some(&gate), "session-1", Some("First"));
		assert!(receiver.try_recv().is_err());
		gate
			.subscribe("test", [observe_subscription(
				hook_pb::HookEventId::HookEventSessionRenamed,
				66,
			)])
			.unwrap();
		emit_session_renamed(Some(&gate), "session-1", Some("Second"));
		let dispatch = receiver.try_recv().unwrap();
		let payload = serde_json::from_slice::<Value>(&dispatch.payload).unwrap();
		assert_eq!(payload, serde_json::json!({"session": "session-1", "name": "Second"}));
	}

	struct DynamicHostExecutor;

	impl HostToolExecutor for DynamicHostExecutor {
		fn execute(
			&self,
			_invocation: HostToolInvocation,
			_updates: HostToolUpdateSink,
			_cancellation: tokio_util::sync::CancellationToken,
		) -> Pin<Box<dyn Future<Output = Result<HostToolResult, Str>> + Send + 'static>> {
			Box::pin(async { Ok(HostToolResult { result: serde_json::Value::Null, is_error: false }) })
		}
	}

	#[test]
	fn dynamic_host_tool_name_passes_agent_validation() {
		let registry = ToolRegistry::new();
		registry
			.replace_host_tools(
				Str::new_static("rpc-test"),
				1,
				vec![HostToolSpec {
					name:        Str::new_static("rpc_dynamic"),
					description: Str::new_static("dynamic test tool"),
					parameters:  serde_json::json!({ "type": "object" }),
				}],
				Arc::new(DynamicHostExecutor),
			)
			.expect("install dynamic host tool");
		assert!(enabled_tools_resolve(&registry, &[Str::new_static("rpc_dynamic")]));
		assert!(registry.effects_owned("rpc_dynamic").is_ok());
	}

	struct ReplacingContextHandler {
		base_offset: u64,
		derived:     u32,
	}

	impl ContextProjectionHandler for ReplacingContextHandler {
		fn project(
			&self,
			base_snapshot_rev: u64,
			view: &crate::ContextView,
		) -> Result<ContextPatchSet, crate::ContextProjectionError> {
			let target = view
				.refs
				.first()
				.expect("projection has one item")
				.id
				.clone();
			Ok(ContextPatchSet::new(
				base_snapshot_rev.saturating_add(self.base_offset),
				self.derived,
				vec![PatchOp::Replace {
					ids:  smallvec::smallvec![target],
					text: Str::new_static("projected"),
					role: thread::Role::User,
					at:   InheritPosition::First,
				}],
			))
		}
	}

	fn message_text(item: &Item) -> Option<&str> {
		let item::Kind::Message(message) = item.kind.as_ref()? else {
			return None;
		};
		message.parts.iter().find_map(|part| {
			let part::Kind::Text(text) = part.kind.as_ref()? else {
				return None;
			};
			Some(text.as_str())
		})
	}

	#[test]
	fn context_handler_applies_to_full_and_delta_projections() {
		let handler = ReplacingContextHandler { base_offset: 0, derived: 1 };
		let full = project_context(
			Thread {
				items: vec![
					message(thread::Role::User, "full input"),
					message(thread::Role::Assistant, "retained"),
				],
			},
			&[10, 11],
			true,
		);
		let full = materialize_context_projection(full, 4, Some(&handler));
		assert_eq!(full.items.len(), 2);
		assert_eq!(message_text(&full.items[0]), Some("projected"));
		assert_eq!(message_text(&full.items[1]), Some("retained"));

		let delta = project_context(
			Thread { items: vec![message(thread::Role::User, "delta input")] },
			&[12],
			true,
		);
		let delta = materialize_context_projection(delta, 5, Some(&handler));
		assert_eq!(delta.items.len(), 1);
		assert_eq!(message_text(&delta.items[0]), Some("projected"));

		for invalid in
			[ReplacingContextHandler { base_offset: 1, derived: 1 }, ReplacingContextHandler {
				base_offset: 0,
				derived:     0,
			}] {
			let projection = project_context(
				Thread { items: vec![message(thread::Role::User, "unchanged")] },
				&[13],
				true,
			);
			let unchanged = materialize_context_projection(projection, 6, Some(&invalid));
			assert_eq!(message_text(&unchanged.items[0]), Some("unchanged"));
		}
	}
	type OpenedTurn = (TurnId, TurnInput, TurnOptions);
	type OpenedTurns = Vec<OpenedTurn>;
	#[test]
	fn stream_watchdog_classifies_and_queues_recovery_guidance() {
		let mut mailbox = Mailbox::new();
		let sender = mailbox.sender();
		let error = stream_watchdog_error(&sender, false, false);
		assert!(matches!(error, TurnError::Rpc(_)));
		let queued = mailbox.drain(DrainPoint::TurnBoundary, false);
		assert_eq!(queued.len(), 1);
		let Some(item::Kind::Message(message)) = queued[0].item.kind.as_ref() else {
			panic!("watchdog guidance must be a canonical message");
		};
		let text = message
			.parts
			.iter()
			.find_map(|part| match part.kind.as_ref() {
				Some(part::Kind::Text(text)) => Some(text.as_str()),
				_ => None,
			});
		assert!(text.is_some_and(|text| text.contains("no first response event")));
	}

	#[tokio::test]
	async fn observable_rpc_retry_terminates_attempt_before_replay() {
		let (journal, path) = test_journal("observable-retry");
		let opened = Arc::new(Mutex::new(Vec::new()));
		let failed_attempt = vec![
			Ok(pb::TurnEvent {
				event: Some(turn_event::Event::PartStart(pb::PartStart {
					index:        0,
					kind:         part_start::Kind::Text as i32,
					tool_call_id: String::new(),
					tool_name:    String::new(),
				})),
			}),
			Ok(pb::TurnEvent {
				event: Some(turn_event::Event::PartDelta(pb::PartDelta {
					index: 0,
					chunk: Bytes::from_static(b"partial"),
				})),
			}),
			Err(TurnError::Rpc(tonic::Status::unavailable("stream lost"))),
		];
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([
				failed_attempt,
				outcome_script(end_outcome("recovered")),
			]))),
			opened:  Arc::clone(&opened),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		let events = agent.events().subscribe_lossless();
		let summary = agent
			.submit([message(thread::Role::User, "retry")], TurnId::new("retry-turn"))
			.await
			.expect("retry succeeds");
		assert_eq!(summary.committed_turns, 1);
		assert_eq!(opened.lock().len(), 2);
		let observed = (0..events.len())
			.filter_map(|_| events.try_recv().ok())
			.filter_map(|event| match event.as_ref() {
				AgentEvent::Turn { turn_id, event } if turn_id.as_str() == "retry-turn" => {
					Some(event.event.as_ref().map(|event| match event {
						turn_event::Event::Error(_) => "error",
						turn_event::Event::Outcome(_) => "outcome",
						_ => "part",
					}))
				},
				_ => None,
			})
			.flatten()
			.collect::<Vec<_>>();
		let error = observed
			.iter()
			.position(|kind| *kind == "error")
			.expect("attempt terminal");
		let outcome = observed
			.iter()
			.position(|kind| *kind == "outcome")
			.expect("replayed outcome");
		assert!(error < outcome);
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn full_seed_conflict_replaces_held_context_with_truncating_delta() {
		#[derive(Clone)]
		struct SeedConflictClient {
			opened: Arc<Mutex<OpenedTurns>>,
		}

		impl TurnClient for SeedConflictClient {
			type Session<'client> = ScriptedSession;

			fn turn<'client>(
				&'client self,
				turn_id: TurnId,
				input: TurnInput,
				options: &'client TurnOptions,
			) -> impl Future<Output = Result<Self::Session<'client>, TurnError>> + Send + 'client {
				let mut opened = self.opened.lock();
				opened.push((turn_id, input, options.clone()));
				let events: Script = match &opened.last().expect("just pushed").1 {
					TurnInput::Full(_) => vec![Err(TurnError::Conflict(Box::new(pb::TurnError {
						kind: turn_error::Kind::Conflict as i32,
						detail: "seed context is already held".to_owned(),
						actual: Some(thread::Revision { head: 7, token: Bytes::from_static(b"held") }),
						..pb::TurnError::default()
					})))],
					TurnInput::Delta(context, delta) => {
						let base = delta
							.truncate_to
							.unwrap_or_else(|| context.expected.as_ref().expect("expected revision").head);
						let head = base + u64::try_from(delta.append.len()).expect("append length") + 1;
						let mut outcome = end_outcome("recovered");
						for (offset, item) in outcome.output.iter_mut().enumerate() {
							item.seq = head + u64::try_from(offset).expect("offset");
						}
						outcome.revision =
							Some(thread::Revision { head, token: Bytes::from_static(b"next") });
						outcome_script(outcome)
					},
				};
				future::ready(Ok(ScriptedSession { events: events.into() }))
			}
		}

		let (journal, path) = test_journal("seed-conflict");
		let mut snapshot = AgentSnapshot::default();
		snapshot.turn.context_id = Some(sf!("ctx"));
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = SeedConflictClient { opened: Arc::clone(&opened) };
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent = Agent::new(client, env, AgentState::new(snapshot), journal, test_caps());
		let summary = agent
			.submit(
				[message(thread::Role::User, "resume after interrupt")],
				TurnId::new("conflict-turn"),
			)
			.await
			.expect("held-context conflict recovers");
		assert_eq!(summary.committed_turns, 1);
		{
			let opened = opened.lock();
			assert_eq!(opened.len(), 2, "one conflicted seed, one replacement delta");
			let TurnInput::Full(seed) = &opened[0].1 else {
				panic!("first attempt must seed the full thread");
			};
			let TurnInput::Delta(context, delta) = &opened[1].1 else {
				panic!("recovery must replace the held context with a delta");
			};
			assert_eq!(context.context_id, "ctx");
			assert_eq!(context.expected.as_ref().map(|revision| revision.head), Some(7));
			assert_eq!(delta.truncate_to, Some(0));
			assert_eq!(delta.append, seed.items, "replacement resends the entire thread");
		}
		let next = agent
			.submit([message(thread::Role::User, "next")], TurnId::new("next-turn"))
			.await
			.expect("follow-up turn");
		assert_eq!(next.committed_turns, 1);
		{
			let opened = opened.lock();
			assert_eq!(opened.len(), 3);
			let TurnInput::Delta(context, delta) = &opened[2].1 else {
				panic!("recovered context must resume append deltas");
			};
			assert_eq!(context.context_id, "ctx");
			assert!(delta.truncate_to.is_none(), "follow-up appends without truncation");
		}
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}
	#[tokio::test]
	async fn stateful_turn_echoes_provider_owned_revision_without_deriving_its_head() {
		let first_revision =
			thread::Revision { head: 41, token: Bytes::from_static(b"provider-context") };
		let mut first = end_outcome("first");
		first.output[0].seq = first_revision.head;
		first.revision = Some(first_revision.clone());
		let second_revision =
			thread::Revision { head: 73, token: Bytes::from_static(b"provider-context-next") };
		let mut second = end_outcome("second");
		second.output[0].seq = second_revision.head;
		second.revision = Some(second_revision.clone());

		let (journal, path) = test_journal("provider-owned-revision");
		let mut snapshot = AgentSnapshot::default();
		snapshot.turn.context_id = Some(sf!("ctx"));
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([
				outcome_script(first),
				outcome_script(second),
			]))),
			opened:  Arc::clone(&opened),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent = Agent::new(client, env, AgentState::new(snapshot), journal, test_caps());

		agent
			.submit([message(thread::Role::User, "first")], TurnId::new("first-turn"))
			.await
			.expect("provider-owned seed revision is accepted");
		agent
			.submit([message(thread::Role::User, "second")], TurnId::new("second-turn"))
			.await
			.expect("provider-owned delta revision is accepted");

		let opened = opened.lock();
		let TurnInput::Delta(context, _) = &opened[1].1 else {
			panic!("follow-up must echo the provider context as a delta");
		};
		assert_eq!(context.expected.as_ref(), Some(&first_revision));
		assert_eq!(
			agent
				.journal()
				.latest_receipt()
				.and_then(|receipt| receipt.outcome.revision.as_ref()),
			Some(&second_revision),
		);
		drop(opened);
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	#[derive(Clone)]
	struct ScriptedClient {
		scripts: Arc<Mutex<VecDeque<Script>>>,
		opened:  Arc<Mutex<OpenedTurns>>,
	}

	struct ScriptedSession {
		events: VecDeque<Result<pb::TurnEvent, TurnError>>,
	}

	impl TurnSession for ScriptedSession {
		fn events(
			&mut self,
		) -> impl futures::Stream<Item = Result<pb::TurnEvent, TurnError>> + Send + Unpin + '_ {
			stream::poll_fn(move |_| match self.events.pop_front() {
				Some(event) => task::Poll::Ready(Some(event)),
				None => task::Poll::Pending,
			})
		}

		fn submit(
			&mut self,
			_frame: InvokeFrame,
		) -> impl Future<Output = Result<(), TurnError>> + Send + '_ {
			future::ready(Ok(()))
		}
	}

	impl TurnClient for ScriptedClient {
		type Session<'client> = ScriptedSession;

		fn turn<'client>(
			&'client self,
			turn_id: TurnId,
			input: TurnInput,
			options: &'client TurnOptions,
		) -> impl Future<Output = Result<Self::Session<'client>, TurnError>> + Send + 'client {
			self.opened.lock().push((turn_id, input, options.clone()));
			let events = self
				.scripts
				.lock()
				.pop_front()
				.expect("one script per turn");
			future::ready(Ok(ScriptedSession { events: events.into() }))
		}
	}

	fn outcome_script(outcome: Outcome) -> Vec<Result<pb::TurnEvent, TurnError>> {
		vec![Ok(pb::TurnEvent { event: Some(turn_event::Event::Outcome(outcome)) })]
	}

	fn pending_text_script() -> Vec<Result<pb::TurnEvent, TurnError>> {
		vec![
			Ok(pb::TurnEvent {
				event: Some(turn_event::Event::PartStart(pb::PartStart {
					index:        0,
					kind:         part_start::Kind::Text as i32,
					tool_call_id: String::new(),
					tool_name:    String::new(),
				})),
			}),
			Ok(pb::TurnEvent {
				event: Some(turn_event::Event::PartDelta(pb::PartDelta {
					index: 0,
					chunk: Bytes::from_static(b"partial"),
				})),
			}),
		]
	}
	fn pending_tool_script(identity: &ToolIdentity) -> Vec<Result<pb::TurnEvent, TurnError>> {
		let call_id = "pending-call";
		let call = thread::ToolCall {
			id: call_id.to_owned(),
			name: identity.name.to_string(),
			args_json: Bytes::from_static(b"{}"),
			..thread::ToolCall::default()
		};
		let item = Item {
			kind: Some(item::Kind::ToolCall(call)),
			props: Some(pb::ValueMap {
				fields: BTreeMap::from([(omp_tool::TOOL_REV_PROP.to_owned(), pb::Value {
					kind: Some(value::Kind::String(identity.rev.to_string())),
				})]),
			}),
			..Item::default()
		};
		vec![
			Ok(pb::TurnEvent {
				event: Some(turn_event::Event::PartStart(pb::PartStart {
					index:        0,
					kind:         part_start::Kind::ToolCall as i32,
					tool_call_id: call_id.to_owned(),
					tool_name:    identity.name.to_string(),
				})),
			}),
			Ok(pb::TurnEvent {
				event: Some(turn_event::Event::PartDelta(pb::PartDelta {
					index: 0,
					chunk: Bytes::from_static(b"{}"),
				})),
			}),
			Ok(pb::TurnEvent {
				event: Some(turn_event::Event::PartEnd(pb::PartEnd {
					index:     0,
					signature: Bytes::new(),
				})),
			}),
			Ok(pb::TurnEvent {
				event: Some(turn_event::Event::Outcome(Outcome {
					output: vec![item],
					stop: pb::StopReason::StopToolUse as i32,
					..Outcome::default()
				})),
			}),
		]
	}

	fn message(role: thread::Role, text: &str) -> Item {
		Item {
			kind: Some(item::Kind::Message(thread::Message {
				role:  i32::from(role),
				parts: vec![thread::Part { kind: Some(part::Kind::Text(text.to_owned())) }],
			})),
			..Item::default()
		}
	}

	fn end_outcome(text: &str) -> Outcome {
		Outcome {
			output: vec![message(thread::Role::Assistant, text)],
			stop: pb::StopReason::StopEndTurn as i32,
			..Outcome::default()
		}
	}

	fn test_journal(name: &str) -> (Journal, PathBuf) {
		let path = env::temp_dir().join(format!(
			"omp-agent-loop-{name}-{}-{}.jsonl",
			std::process::id(),
			omp_core::Ulid::generate()
		));
		let journal = Journal::create(&path, &Header {
			v:       4,
			id:      SessionId(Str::new(name)),
			created: 1,
			cwd:     env::temp_dir(),
		})
		.expect("create test journal");
		(journal, path)
	}

	fn test_caps() -> CapsBase {
		CapsBase {
			maximum_parts:      16,
			maximum_text_bytes: 16_384,
			media:              false,
			model_class:        ModelClass::Standard,
		}
	}

	async fn wait_for_opened(opened: &Arc<Mutex<OpenedTurns>>, count: usize) {
		for _ in 0..100 {
			if opened.lock().len() >= count {
				return;
			}
			yield_now().await;
		}
		panic!("scripted turn did not open");
	}

	fn input_contains_text(input: &TurnInput, expected: &str) -> bool {
		let items = match input {
			TurnInput::Full(thread) => thread.items.as_slice(),
			TurnInput::Delta(_, delta) => delta.append.as_slice(),
		};
		items.iter().any(|item| {
			matches!(
				item.kind.as_ref(),
				Some(item::Kind::Message(message))
					if message.parts.iter().any(|part| {
						matches!(
							part.kind.as_ref(),
							Some(part::Kind::Text(text)) if text == expected
						)
					})
			)
		})
	}

	fn worker(name: &str) -> ToolSpec {
		ToolSpec {
			name:            Str::new(name),
			rev:             Rev { family: sf!("test"), n: 1 },
			description:     sf!("test worker"),
			schema:          Bytes::from_static(br#"{"type":"object"}"#),
			constraint:      Constraint::None,
			effects:         Effects::empty(),
			projection_code: [0; 32],
		}
	}

	fn worker_claims() -> Claims {
		Claims { precedence: Precedence::DEFAULT, claimant: sf!("test/worker"), replaces: None }
	}

	#[tokio::test]
	async fn resumed_turn_freezes_durable_allowlist_then_fresh_turn_uses_snapshot() {
		let mut registry = ToolRegistry::new();
		registry
			.register_worker(worker("old"), Presentation::Device, worker_claims())
			.expect("register old");
		registry
			.register_worker(worker("new"), Presentation::Device, worker_claims())
			.expect("register new");
		let registry = Arc::new(registry);

		let mut old_options = TurnOptions::default();
		old_options.params.model = "durable-model".to_owned();
		let mut new_options = TurnOptions::default();
		new_options.params.model = "fresh-model".to_owned();
		let state = AgentState::new(AgentSnapshot {
			turn: new_options.clone(),
			enabled_tools: Arc::from([sf!("new")]),
			registry: Arc::clone(&registry),
			..AgentSnapshot::default()
		});

		let path = env::temp_dir().join(format!(
			"omp-agent-loop-allowlist-{}-{}.jsonl",
			std::process::id(),
			omp_core::Ulid::generate()
		));
		let mut journal = Journal::create(&path, &Header {
			v:       4,
			id:      SessionId(sf!("allowlist-test")),
			created: 1,
			cwd:     env::temp_dir(),
		})
		.expect("create journal");
		let durable_input = Thread::default();
		journal
			.start_turn(1, TurnStart {
				turn_id:            sf!("durable-turn"),
				item_events:        Vec::new(),
				prompt_hash:        Hash32::new([7; 32]),
				prompt_head_events: Vec::new(),
				toolset_hash:       registry.slot_hash(),
				enabled_tools:      vec![sf!("old")],
				sequence_targets:   Vec::new(),
				input:              TurnInputRecord::Full { thread: durable_input.clone() },
				options:            TurnOptionsRecord {
					context_id: old_options.context_id.clone(),
					params:     old_options.params.clone(),
					executor:   old_options.executor.clone(),
					props:      old_options.props.clone(),
				},
			})
			.expect("persist durable start");

		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([
				outcome_script(Outcome {
					stop: pb::StopReason::StopEndTurn as i32,
					..Outcome::default()
				}),
				outcome_script(Outcome {
					stop: pb::StopReason::StopEndTurn as i32,
					..Outcome::default()
				}),
			]))),
			opened:  Arc::clone(&opened),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent = Agent::new(client, env, state, journal, test_caps());

		let RunTurnResult::Complete((_, _, _, _, resumed_tools)) = agent
			.run_turn(TurnId::new("durable-turn"), Vec::new())
			.await
			.expect("resume durable turn")
		else {
			panic!("durable turn must complete");
		};
		let RunTurnResult::Complete((_, _, _, _, fresh_tools)) = agent
			.run_turn(TurnId::new("fresh-turn"), Vec::new())
			.await
			.expect("run fresh turn")
		else {
			panic!("fresh turn must complete");
		};

		assert_eq!(resumed_tools.as_ref(), &[sf!("old")]);
		assert_eq!(fresh_tools.as_ref(), &[sf!("new")]);
		let opened = opened.lock();
		assert_eq!(opened.len(), 2);
		assert_eq!(opened[0].0.as_str(), "durable-turn");
		assert!(matches!(&opened[0].1, TurnInput::Full(thread) if thread == &durable_input));
		assert_eq!(opened[0].2.params, old_options.params);
		assert_eq!(opened[1].0.as_str(), "fresh-turn");
		assert_eq!(opened[1].2.params, new_options.params);
		assert_eq!(
			agent
				.journal()
				.latest_turn_start()
				.expect("fresh durable start")
				.enabled_tools,
			vec![sf!("new")]
		);
		drop(opened);
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn compaction_hook_cancel_blocks_the_production_compactor() {
		use omp_proto::prost::Message as _;

		let (mut journal, path) = test_journal("compact-hook-cancel");
		for (ts, (role, text)) in [
			(1, (thread::Role::User, "first request")),
			(2, (thread::Role::Assistant, "first answer")),
			(3, (thread::Role::User, "second request")),
		] {
			journal
				.append_optimistic(ts, message(role, text), None)
				.expect("append compact source");
		}
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client =
			ScriptedClient { scripts: Arc::new(Mutex::new(VecDeque::new())), opened: opened.clone() };
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		let (gate, receiver) = HookGate::channel();
		let gate = Arc::new(gate);
		gate
			.subscribe("test", [crate::Subscription {
				host:       sf!("test"),
				source:     crate::SourceRef {
					layer:        0,
					publisher:    sf!("test"),
					extension_id: sf!("cancel"),
				},
				id:         91,
				event:      hook_pb::HookEventId::HookEventCompaction,
				phase:      HookPhase::Review,
				order:      0,
				on_failure: crate::OnFailure::Defer,
				when:       crate::When::default(),
			}])
			.unwrap();
		agent.set_hook_gate(Arc::clone(&gate));
		let response = async {
			let dispatch = receiver
				.recv_async()
				.await
				.expect("compaction hook dispatch");
			let request = hook_pb::CompactionRequest::decode(dispatch.payload).unwrap();
			assert_eq!(request.tier, "local");
			assert_eq!(request.custom_instructions.as_deref(), Some("retain the decision"));
			gate
				.answer(dispatch.dispatch_id, vec![(
					91,
					crate::GateDecision::Domain(crate::encode_domain_verdict(Some(
						&crate::CompactionVerdict::Cancel(crate::CancelCompaction {
							reason:             sf!("managed externally"),
							suppress_for_turns: 0,
						}),
					))),
				)])
				.unwrap();
		};
		let (result, ()) = tokio::join!(
			agent.compact_manual(ManualCompactionRequest {
				mode:  Some(ManualCompactionMode::Soft),
				focus: Some(sf!("retain the decision")),
			}),
			response,
		);
		assert!(matches!(
			result,
			Err(AgentError::CompactionCancelled(CompactionCancellation::ExtensionVeto {
				reason,
			})) if reason.as_str() == "managed externally"
		));
		assert!(opened.lock().is_empty(), "cancelled hook must prevent the summarizer call");
		assert_eq!(agent.journal().context_position().epoch, 0);
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn compaction_hook_custom_summary_is_the_durable_compact_entry() {
		let (mut journal, path) = test_journal("compact-hook-custom");
		let mut events = Vec::new();
		for (ts, (role, text)) in [
			(1, (thread::Role::User, "first request")),
			(2, (thread::Role::Assistant, "first answer")),
			(3, (thread::Role::User, "second request")),
		] {
			events.push(
				journal
					.append_optimistic(ts, message(role, text), None)
					.expect("append compact source"),
			);
		}
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client =
			ScriptedClient { scripts: Arc::new(Mutex::new(VecDeque::new())), opened: opened.clone() };
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		let (gate, receiver) = HookGate::channel();
		let gate = Arc::new(gate);
		gate
			.subscribe("test", [crate::Subscription {
				host:       sf!("test"),
				source:     crate::SourceRef {
					layer:        0,
					publisher:    sf!("test"),
					extension_id: sf!("summary"),
				},
				id:         92,
				event:      hook_pb::HookEventId::HookEventCompaction,
				phase:      HookPhase::Review,
				order:      0,
				on_failure: crate::OnFailure::Defer,
				when:       crate::When::default(),
			}])
			.unwrap();
		agent.set_hook_gate(Arc::clone(&gate));
		let response = async {
			let dispatch = receiver
				.recv_async()
				.await
				.expect("compaction hook dispatch");
			gate
				.answer(dispatch.dispatch_id, vec![(
					92,
					crate::GateDecision::Domain(crate::encode_domain_verdict(Some(
						&crate::CompactionVerdict::Custom(crate::CustomSummary {
							compact:  Compact {
								summary:       sf!("extension-authored durable summary"),
								short:         Some(sf!("extension summary")),
								first_kept:    events[1],
								tokens_before: 0,
								tokens_after:  None,
								method:        None,
								warning:       None,
								superseded:    Vec::new(),
								snapcompact:   None,
							},
							details:  None,
							preserve: None,
						}),
					))),
				)])
				.unwrap();
		};
		let (outcome, ()) = tokio::join!(
			agent.compact_manual(ManualCompactionRequest {
				mode:  Some(ManualCompactionMode::Soft),
				focus: None,
			}),
			response,
		);
		let outcome = outcome.expect("custom compaction commits");
		assert_eq!(outcome.from_extension.as_deref(), Some("summary"));
		assert!(opened.lock().is_empty(), "custom summary must replace the summarizer call");
		let transcript = agent.journal().load().expect("load compact transcript");
		let Some(Entry::Ok(entry)) = transcript.get(outcome.event) else {
			panic!("compact journal entry");
		};
		let Kind::Compact { summary, first_kept, method, .. } = &entry.kind else {
			panic!("durable custom summary must use the standard Compact entry");
		};
		assert_eq!(summary.as_str(), "extension-authored durable summary");
		assert_eq!(*first_kept, events[1]);
		assert_eq!(method.as_deref(), Some("extension"));
		drop(transcript);
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn compaction_hook_delegate_instructions_reach_the_summary_request() {
		let (mut journal, path) = test_journal("compact-hook-delegate");
		for (ts, (role, text)) in [
			(1, (thread::Role::User, "first request")),
			(2, (thread::Role::Assistant, "first answer")),
			(3, (thread::Role::User, "second request")),
		] {
			journal
				.append_optimistic(ts, message(role, text), None)
				.expect("append compact source");
		}
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([outcome_script(end_outcome(
				"delegated summary",
			))]))),
			opened:  opened.clone(),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		let (gate, receiver) = HookGate::channel();
		let gate = Arc::new(gate);
		gate
			.subscribe("test", [crate::Subscription {
				host:       sf!("test"),
				source:     crate::SourceRef {
					layer:        0,
					publisher:    sf!("test"),
					extension_id: sf!("delegate"),
				},
				id:         94,
				event:      hook_pb::HookEventId::HookEventCompaction,
				phase:      HookPhase::Review,
				order:      0,
				on_failure: crate::OnFailure::Defer,
				when:       crate::When::default(),
			}])
			.unwrap();
		agent.set_hook_gate(Arc::clone(&gate));
		let response = async {
			let dispatch = receiver
				.recv_async()
				.await
				.expect("compaction hook dispatch");
			gate
				.answer(dispatch.dispatch_id, vec![(
					94,
					crate::GateDecision::Domain(crate::encode_domain_verdict(Some(
						&crate::CompactionVerdict::Delegate(crate::DelegateCompaction {
							extra_instructions: sf!("Keep the API choice verbatim."),
							..Default::default()
						}),
					))),
				)])
				.unwrap();
		};
		let (outcome, ()) = tokio::join!(
			agent.compact_manual(ManualCompactionRequest {
				mode:  Some(ManualCompactionMode::Soft),
				focus: None,
			}),
			response,
		);
		outcome.expect("delegated compaction succeeds");
		let opened = opened.lock();
		let TurnInput::Full(thread) = &opened[0].1 else {
			panic!("compaction summarizer receives a full isolated thread");
		};
		assert!(
			hook_item_text(thread.items.last().unwrap())
				.is_some_and(|instruction| { instruction.contains("Keep the API choice verbatim.") })
		);
		drop(opened);
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn failed_compaction_emits_structured_compaction_done_outcome() {
		let (mut journal, path) = test_journal("compact-done-failure");
		journal
			.append_optimistic(1, message(thread::Role::User, "only item"), None)
			.expect("append compact source");
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::new())),
			opened:  Arc::new(Mutex::new(Vec::new())),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		let (gate, receiver) = HookGate::channel();
		gate
			.subscribe("test", [crate::Subscription {
				host:       sf!("test"),
				source:     crate::SourceRef {
					layer:        0,
					publisher:    sf!("test"),
					extension_id: sf!("done"),
				},
				id:         93,
				event:      hook_pb::HookEventId::HookEventCompactionDone,
				phase:      HookPhase::Observe,
				order:      0,
				on_failure: crate::OnFailure::Defer,
				when:       crate::When::default(),
			}])
			.unwrap();
		agent.set_hook_gate(Arc::new(gate));
		assert!(
			agent
				.compact_manual(ManualCompactionRequest {
					mode:  Some(ManualCompactionMode::Soft),
					focus: None,
				})
				.await
				.is_err()
		);
		let dispatch = receiver.try_recv().expect("failure compaction_done event");
		let payload: Value = serde_json::from_slice(&dispatch.payload).unwrap();
		assert_eq!(payload["tiers_run"], serde_json::json!(["local"]));
		assert_eq!(payload["tokens_before"], 0);
		assert_eq!(payload["summary_bytes"], 0);
		assert!(
			payload["warning"]
				.as_str()
				.is_some_and(|warning| !warning.is_empty())
		);
		assert!(
			!payload["preparation_id"]
				.as_str()
				.unwrap_or_default()
				.is_empty()
		);
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn context_compact_host_request_reaches_the_loop_and_returns_outcome() {
		let (mut journal, path) = test_journal("context-compact-request");
		for (ts, (role, text)) in [
			(1, (thread::Role::User, "first request")),
			(2, (thread::Role::Assistant, "first answer")),
			(3, (thread::Role::User, "second request")),
		] {
			journal
				.append_optimistic(ts, message(role, text), None)
				.expect("append compact source");
		}
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([outcome_script(end_outcome(
				"host requested summary",
			))]))),
			opened:  opened.clone(),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		let host = agent.host_control();
		let request = host.request(
			"omp.context.compact",
			serde_json::Map::from_iter([
				("tier".to_owned(), Value::String("local".to_owned())),
				("focus".to_owned(), Value::String("preserve the chosen API".to_owned())),
			]),
		);
		let service = async {
			let command = agent
				.receivers
				.host_commands
				.recv_async()
				.await
				.expect("host compact command");
			agent.handle_host_control(command).await;
		};
		let (response, ()) = tokio::join!(request, service);
		let response = response.expect("context compact response");
		assert_eq!(response["tiers_run"], serde_json::json!(["local"]));
		assert!(
			response["tokens_after"]
				.as_u64()
				.is_some_and(|tokens| tokens > 0)
		);
		let opened = opened.lock();
		let TurnInput::Full(thread) = &opened[0].1 else {
			panic!("compaction summarizer receives a full isolated thread");
		};
		assert!(
			hook_item_text(thread.items.last().unwrap())
				.is_some_and(|instruction| { instruction.contains("preserve the chosen API") })
		);
		drop(opened);
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn pending_messages_host_request_counts_queued_mailbox_items() {
		let (journal, path) = test_journal("pending-messages-request");
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::new())),
			opened:  Arc::new(Mutex::new(Vec::new())),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		agent
			.mailbox()
			.try_enqueue(Interrupt {
				class:  InterruptClass::TurnBoundary,
				item:   message(thread::Role::User, "queued"),
				source: InterruptSource::Producer(sf!("test")),
			})
			.expect("queue message");
		let host = agent.host_control();
		let request = host.request("omp.agents.pending_messages", serde_json::Map::new());
		let service = async {
			let command = agent
				.receivers
				.host_commands
				.recv_async()
				.await
				.expect("host pending-messages command");
			agent.handle_host_control(command).await;
		};
		let (response, ()) = tokio::join!(request, service);
		assert_eq!(response.expect("pending-messages response"), Value::from(1_u64));
		drop(agent);
		if path.exists() {
			fs::remove_file(path).expect("remove journal");
		}
	}

	#[tokio::test]
	async fn manual_compaction_abort_preserves_provenance_and_allows_follow_up() {
		let (mut journal, path) = test_journal("compact-abort-cleanup");
		for (ts, (role, text)) in [
			(1, (thread::Role::User, "first request")),
			(2, (thread::Role::Assistant, "first answer")),
			(3, (thread::Role::User, "second request")),
		] {
			journal
				.append_optimistic(ts, message(role, text), None)
				.expect("append compact source");
		}
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([
				pending_text_script(),
				outcome_script(end_outcome("replacement answer")),
			]))),
			opened:  Arc::clone(&opened),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		let abort = agent.abort_handle();
		let aborting = async {
			wait_for_opened(&opened, 1).await;
			abort.abort();
		};
		let (compaction, ()) = tokio::join!(
			agent.compact_manual(ManualCompactionRequest {
				mode:  Some(ManualCompactionMode::Soft),
				focus: None,
			}),
			aborting,
		);
		assert!(matches!(
			compaction,
			Err(AgentError::CompactionCancelled(CompactionCancellation::UserInterrupt))
		));

		let follow_up = agent
			.submit(
				[message(thread::Role::User, "replacement prompt")],
				TurnId::new("post-compact-abort"),
			)
			.await
			.expect("replacement waits for cancellation cleanup and runs");
		assert!(!follow_up.interrupted);
		assert_eq!(opened.lock().len(), 2);
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	#[test]
	fn thinking_shake_drops_plain_and_redacted_blocks_and_invalidates_prompt_state() {
		let (mut journal, path) = test_journal("shake-thinking");
		let prompt_hash = PromptHash::from([7; 32]);
		let assistant = Item {
			kind: Some(item::Kind::Message(thread::Message {
				role:  i32::from(thread::Role::Assistant),
				parts: vec![
					thread::Part {
						kind: Some(part::Kind::Thinking(thread::Thinking {
							text:      "plain reasoning".to_owned(),
							signature: Bytes::new(),
							redacted:  false,
						})),
					},
					thread::Part {
						kind: Some(part::Kind::Thinking(thread::Thinking {
							text:      String::new(),
							signature: Bytes::from_static(b"opaque"),
							redacted:  true,
						})),
					},
					thread::Part { kind: Some(part::Kind::Text("visible answer".to_owned())) },
				],
			})),
			..Item::default()
		};
		journal
			.append_optimistic(1, message(thread::Role::User, "request"), Some(prompt_hash))
			.expect("append user prompt");
		journal
			.append_optimistic(2, assistant, Some(prompt_hash))
			.expect("append assistant answer");
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::new())),
			opened:  Arc::new(Mutex::new(Vec::new())),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		agent.prompt_hash = Some(prompt_hash);
		let outcome = agent
			.shake_manual(ManualShakeMode::Thinking)
			.expect("thinking shake rewrites history");
		assert_eq!(outcome.replaced_regions, 2);
		assert!(agent.context.is_none());
		assert!(agent.prompt_hash.is_none());
		let events = agent.journal.live_item_events().expect("live item events");
		let items = agent.journal.items_at(&events).expect("rewritten items");
		assert!(items.iter().all(|item| {
			let Some(item::Kind::Message(message)) = item.kind.as_ref() else {
				return true;
			};
			message
				.parts
				.iter()
				.all(|part| !matches!(part.kind, Some(part::Kind::Thinking(_))))
		}));
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn caller_abort_settles_pending_stream_and_allows_follow_up() {
		let (journal, path) = test_journal("stream-abort");
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([
				pending_text_script(),
				outcome_script(end_outcome("after abort")),
			]))),
			opened:  Arc::clone(&opened),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		let events = agent.events().subscribe_lossless();
		let abort = agent.abort_handle();
		let aborting = async {
			wait_for_opened(&opened, 1).await;
			abort.abort();
		};
		let (summary, ()) = tokio::join!(
			agent.submit([message(thread::Role::User, "before abort")], TurnId::new("abort-turn"),),
			aborting,
		);
		let summary = summary.expect("abort returns a summary");
		assert!(summary.interrupted);
		assert!(summary.outcome.is_none());
		assert_eq!(summary.committed_turns, 0);
		assert!(agent.journal().pending_turn().is_none());
		assert!((0..events.len()).any(|_| {
			matches!(
				events.try_recv().ok().as_deref(),
				Some(AgentEvent::Turn { turn_id, event })
					if turn_id.as_str() == "abort-turn"
						&& matches!(event.event.as_ref(), Some(turn_event::Event::Error(_)))
			)
		}));
		let log = agent.journal().load().expect("load aborted journal");
		assert!((0..u64::try_from(log.len()).expect("log length fits")).any(|index| {
			matches!(
				log.get(index),
				Some(Entry::Ok(event))
					if matches!(&event.kind, Kind::TurnAbort(abort) if !abort.recoverable)
			)
		}));
		drop(log);

		let follow_up = agent
			.submit([message(thread::Role::User, "after abort")], TurnId::new("post-abort-turn"))
			.await
			.expect("follow-up submission succeeds");
		assert!(!follow_up.interrupted);
		assert!(follow_up.outcome.is_some());
		drop(agent);

		let reopened = Journal::open(&path).expect("reopen exhausted abort");
		assert!(reopened.pending_turn().is_none());
		assert!(reopened.pending_input_submission().is_none());
		assert!(reopened.recoverable_input_events().is_empty());
		drop(reopened);
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn caller_abort_continues_into_queued_producer_input() {
		let (journal, path) = test_journal("abort-and-send");
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([
				pending_text_script(),
				outcome_script(end_outcome("queued answer")),
			]))),
			opened:  Arc::clone(&opened),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		let abort = agent.abort_handle();
		let mailbox = agent.mailbox();
		let interrupting = async {
			wait_for_opened(&opened, 1).await;
			mailbox
				.try_enqueue(Interrupt {
					class:  InterruptClass::Immediate,
					item:   message(thread::Role::User, "queued user input"),
					source: InterruptSource::Producer(sf!("user")),
				})
				.expect("enqueue producer input");
			abort.abort();
		};
		let (summary, ()) = tokio::join!(
			agent.submit(
				[message(thread::Role::User, "initial user input")],
				TurnId::new("interrupt-and-send"),
			),
			interrupting,
		);

		let summary = summary.expect("continued submission succeeds");
		assert!(!summary.interrupted);
		assert_eq!(summary.committed_turns, 1);
		assert!(summary.outcome.is_some());
		let opened = opened.lock();
		assert_eq!(opened.len(), 2);
		assert!(input_contains_text(&opened[1].1, "queued user input"));
		drop(opened);
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}
	#[tokio::test]
	async fn plan_regime_exit_mid_turn_is_a_caller_abort() {
		let (journal, path) = test_journal("plan-exit-abort");
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([pending_text_script()]))),
			opened:  Arc::clone(&opened),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		let (spec, machine) = crate::core_regime("plan").expect("plan regime");
		let receipt = agent
			.start_regime(spec, machine, StartOptions { now_ms: now_ms(), queue: false })
			.expect("start plan regime");
		let control = agent.control();
		let abort = agent.abort_handle();
		let exiting = async {
			wait_for_opened(&opened, 1).await;
			assert!(
				control
					.stop_regime_snapshot(receipt.activation)
					.await
					.expect("stop live plan regime")
					.0
			);
			abort.abort();
		};
		let (summary, ()) = tokio::join!(
			agent.submit([message(thread::Role::User, "plan this")], TurnId::new("plan-exit-turn"),),
			exiting,
		);
		let summary = summary.expect("plan exit returns a caller-abort summary");
		assert!(summary.interrupted);
		assert_eq!(summary.settlement, RunSettlement::CallerAbort);
		assert_eq!(agent.phase, AgentPhase::Idle);
		assert!(agent.pending_reasoning_demotion);
		assert!(agent.journal().pending_turn().is_none());
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn caller_abort_interrupts_tool_batch_and_stages_results() {
		let (journal, path) = test_journal("batch-abort");
		let identity = ToolIdentity { name: sf!("pending"), rev: Rev { family: sf!("test"), n: 1 } };
		let mut registry = ToolRegistry::new();
		registry
			.register_worker(worker(identity.name.as_str()), Presentation::Device, worker_claims())
			.expect("register pending tool");
		let registry = Arc::new(registry);
		let state = AgentState::new(AgentSnapshot {
			enabled_tools: Arc::from([identity.name.clone()]),
			registry,
			..AgentSnapshot::default()
		});
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([pending_tool_script(&identity)]))),
			opened,
		};
		let (env, transport) = EnvClient::in_process(1);
		let (requests, responses) = transport.into_parts();
		let env_task = tokio::spawn(async move {
			let _responses = responses;
			while requests.recv_async().await.is_ok() {}
		});
		let mut agent = Agent::new(client, env, state, journal, test_caps());
		let abort = agent.abort_handle();
		let events = agent.events().subscribe_lossless();
		let aborting = async {
			loop {
				let event = events.recv().await.expect("agent event");
				if matches!(event.as_ref(), AgentEvent::PhaseChanged { to: AgentPhase::ToolBatch, .. })
				{
					abort.abort();
					break;
				}
			}
		};
		let (summary, ()) = tokio::join!(
			agent.submit(
				[message(thread::Role::User, "run pending tool")],
				TurnId::new("batch-abort-turn"),
			),
			aborting,
		);
		let summary = summary.expect("batch abort returns summary");
		assert!(summary.interrupted);
		assert_eq!(summary.committed_turns, 1);
		assert!(summary.outcome.is_some());
		assert!(agent.journal().pending_turn().is_none());
		assert!(
			agent.journal().pending_input_submission().is_some(),
			"interrupted tool results remain staged"
		);
		drop(agent);
		env_task.abort();
		fs::remove_file(path).expect("remove journal");
	}
	#[tokio::test]
	async fn immediate_steering_during_tool_generation_is_retained_for_follow_up() {
		let (journal, path) = test_journal("tool-steering");
		let identity = ToolIdentity { name: sf!("pending"), rev: Rev { family: sf!("test"), n: 1 } };
		let mut registry = ToolRegistry::new();
		registry
			.register_worker(worker(identity.name.as_str()), Presentation::Device, worker_claims())
			.expect("register pending tool");
		let state = AgentState::new(AgentSnapshot {
			enabled_tools: Arc::from([identity.name.clone()]),
			registry: Arc::new(registry),
			..AgentSnapshot::default()
		});
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([
				pending_tool_script(&identity),
				outcome_script(end_outcome("steered answer")),
			]))),
			opened:  Arc::clone(&opened),
		};
		let (env, transport) = EnvClient::in_process(1);
		let (requests, responses) = transport.into_parts();
		let env_task = tokio::spawn(async move {
			let _responses = responses;
			while requests.recv_async().await.is_ok() {}
		});
		let mut agent = Agent::new(client, env, state, journal, test_caps());
		let events = agent.events().subscribe_lossless();
		let mailbox = agent.mailbox();
		let steering = async {
			loop {
				let event = events.recv().await.expect("agent event");
				if matches!(event.as_ref(), AgentEvent::ToolArgs { .. }) {
					mailbox
						.try_enqueue(Interrupt {
							class:  InterruptClass::Immediate,
							item:   message(thread::Role::User, "preserved steering"),
							source: InterruptSource::Producer(sf!("user")),
						})
						.expect("enqueue steering");
					break;
				}
			}
		};
		let (summary, ()) = tokio::join!(
			agent.submit([message(thread::Role::User, "start tool")], TurnId::new("tool-steer")),
			steering,
		);
		let summary = summary.expect("steered tool turn succeeds");
		assert_eq!(summary.committed_turns, 2);
		let opened = opened.lock();
		assert_eq!(opened.len(), 2);
		assert!(input_contains_text(&opened[1].1, "preserved steering"));
		drop(opened);
		drop(agent);
		env_task.abort();
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn rewind_targets_split_attachment_parts_from_prose() {
		let (journal, path) = test_journal("rewind-attachments");
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([outcome_script(end_outcome("answer"))]))),
			opened:  Arc::clone(&opened),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		let item = Item {
			kind: Some(item::Kind::Message(thread::Message {
				role:  i32::from(thread::Role::User),
				parts: vec![
					thread::Part { kind: Some(part::Kind::Text("look at this".to_owned())) },
					thread::Part {
						kind: Some(part::Kind::Text("<attachment>pasted body</attachment>".to_owned())),
					},
					thread::Part {
						kind: Some(part::Kind::Blob(thread::Blob {
							mime: "image/png".to_owned(),
							inline: bytes::Bytes::from_static(b"png-bytes"),
							..thread::Blob::default()
						})),
					},
					thread::Part { kind: Some(part::Kind::Text("and this".to_owned())) },
				],
			})),
			..Item::default()
		};
		agent
			.submit([item], TurnId::new("rewind-attachments"))
			.await
			.expect("turn");
		let targets = agent.rewind_targets().expect("list rewind targets");
		let target = targets.first().expect("one rewind target");
		assert_eq!(target.text.as_str(), "look at this\nand this");
		assert_eq!(target.parts.len(), 2, "paste and blob split out of prose");
		assert!(matches!(
			target.parts[0].kind.as_ref(),
			Some(part::Kind::Text(text)) if text == "<attachment>pasted body</attachment>"
		));
		assert!(matches!(
			target.parts[1].kind.as_ref(),
			Some(part::Kind::Blob(blob)) if blob.mime == "image/png"
		));
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn rewind_truncates_projection_and_forces_full_post_rewind_turn() {
		let (journal, path) = test_journal("rewind");
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([
				outcome_script(end_outcome("answer one")),
				outcome_script(end_outcome("answer two")),
				outcome_script(end_outcome("replacement answer")),
			]))),
			opened:  Arc::clone(&opened),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		agent
			.submit([message(thread::Role::User, "turn one")], TurnId::new("rewind-one"))
			.await
			.expect("first turn");
		agent
			.submit([message(thread::Role::User, "turn two")], TurnId::new("rewind-two"))
			.await
			.expect("second turn");
		let targets = agent.rewind_targets().expect("list rewind targets");
		assert_eq!(
			targets
				.iter()
				.map(|target| target.text.as_str())
				.collect::<Vec<_>>(),
			vec!["turn one", "turn two"]
		);
		let second = targets.last().expect("second rewind target").clone();
		let projected = agent.rewind(second.keep).expect("rewind second turn");
		assert!(projected.iter().any(|item| {
			matches!(
				item.kind.as_ref(),
				Some(item::Kind::Message(message))
					if message.parts.iter().any(|part| {
						matches!(
							part.kind.as_ref(),
							Some(part::Kind::Text(text)) if text == "turn one"
						)
					})
			)
		}));
		assert!(!projected.iter().any(|item| {
			matches!(
				item.kind.as_ref(),
				Some(item::Kind::Message(message))
					if message.parts.iter().any(|part| {
						matches!(
							part.kind.as_ref(),
							Some(part::Kind::Text(text)) if text == "turn two"
						)
					})
			)
		}));
		agent
			.submit([message(thread::Role::User, "replacement")], TurnId::new("rewind-replacement"))
			.await
			.expect("post-rewind turn");
		assert!(agent.prompt_hash.is_some(), "post-rewind turn re-rendered prompt head");
		let opened = opened.lock();
		assert_eq!(opened.len(), 3);
		assert!(matches!(&opened[2].1, TurnInput::Full(_)));
		assert!(input_contains_text(&opened[2].1, "turn one"));
		assert!(input_contains_text(&opened[2].1, "replacement"));
		drop(opened);

		let cleared = agent.rewind(None).expect("rewind to root");
		assert!(cleared.is_empty());
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	fn loop_job(id: &str) -> omp_tool::JobRef {
		omp_tool::JobRef {
			id:       Str::new(id),
			owner:    omp_tool::JobOwner::AgentLoop { agent_id: sf!("child-agent") },
			metadata: Arc::default(),
			artifact: omp_tool::ExpectedArtifact {
				description: sf!("artifact"),
				media_type:  None,
				lifetime:    omp_tool::ArtifactLifetime::Session,
			},
		}
	}

	/// Serves the slot-invocation protocol the way envd's device host would:
	/// acknowledge InvokeTool, require committed-argument admission, and answer
	/// a terminal ok verdict.
	fn serve_slot_invocations(
		transport: omp_env::InProcessEnvTransport,
	) -> (Arc<Mutex<Vec<(String, serde_json::Value)>>>, tokio::task::JoinHandle<()>) {
		use omp_env::frame::{self, client_frame, server_frame};

		let (requests, responses) = transport.into_parts();
		let commits = Arc::new(Mutex::new(Vec::new()));
		let record = Arc::clone(&commits);
		let server = tokio::spawn(async move {
			let mut invocations: BTreeMap<String, (u64, String)> = BTreeMap::new();
			let mut pending_commits = BTreeMap::new();
			while let Ok(env_frame) = requests.recv_async().await {
				match env_frame.body {
					Some(client_frame::Body::InvokeTool(invoke)) => {
						let _ = responses
							.send_async(frame::ServerFrame {
								request_id: env_frame.request_id,
								body: Some(server_frame::Body::InvocationAccepted(frame::InvokeAccepted {
									invocation_id: invoke.invocation_id.clone(),
									..Default::default()
								})),
								..Default::default()
							})
							.await;
						invocations
							.insert(invoke.invocation_id.clone(), (env_frame.request_id, invoke.name));
					},
					Some(client_frame::Body::ArgsCommitted(committed)) => {
						let Some((request_id, _)) = invocations.get(&committed.invocation_id).cloned()
						else {
							continue;
						};
						let invocation_id = committed.invocation_id.clone();
						pending_commits.insert(invocation_id.clone(), committed);
						let _ = responses
							.send_async(frame::ServerFrame {
								request_id,
								body: Some(server_frame::Body::AdmitInvocation(frame::AdmitInvocation {
									invocation_id,
									..Default::default()
								})),
								..Default::default()
							})
							.await;
					},
					Some(client_frame::Body::Admission(admission)) => {
						assert!(admission.allow, "todo restore admission must be allowed");
						let committed = pending_commits
							.remove(&admission.invocation_id)
							.expect("admission follows committed args");
						let (request_id, name) = invocations
							.get(&admission.invocation_id)
							.cloned()
							.expect("admission names an open invocation");
						record.lock().push((
							name,
							serde_json::from_slice(&committed.raw).expect("committed args decode"),
						));
						let _ = responses
							.send_async(frame::ServerFrame {
								request_id,
								body: Some(server_frame::Body::Verdict(frame::Verdict {
									invocation_id: committed.invocation_id,
									json: Bytes::from_static(
										br#"{"kind":"ok","value":{"phases":[],"rendered":""}}"#,
									),
									..Default::default()
								})),
								..Default::default()
							})
							.await;
					},
					_ => {},
				}
			}
		});
		(commits, server)
	}
	async fn reconcile_with_timeout(agent: &mut Agent<ScriptedClient>) {
		tokio::time::timeout(std::time::Duration::from_secs(1), agent.reconcile_history_rewrite())
			.await
			.expect("todo restore answered admission before the startup deadline")
			.expect("reconcile history rewrite");
	}

	fn history_rewritten_events(
		events: &crate::events::EventSubscription,
	) -> Vec<(Option<u64>, u64, Vec<Str>)> {
		let mut seen = Vec::new();
		while let Ok(event) = events.try_recv() {
			if let AgentEvent::HistoryRewritten { to, head, escalate_jobs } = event.as_ref() {
				seen.push((*to, *head, escalate_jobs.clone()));
			}
		}
		seen
	}

	fn journal_has_rewind_warning(journal: &Journal) -> bool {
		let log = journal.load().expect("load journal");
		(0..u64::try_from(log.len()).expect("indexes fit"))
			.filter_map(|index| match log.get(index) {
				Some(Entry::Ok(event)) => match &event.kind {
					Kind::Item(record) => Some(record.item.clone()),
					_ => None,
				},
				_ => None,
			})
			.any(|item| {
				matches!(
					item.kind.as_ref(),
					Some(item::Kind::Message(message)) if message.parts.iter().any(|part| {
						matches!(
							part.kind.as_ref(),
							Some(part::Kind::Text(text)) if text.contains("Rewind left")
						)
					})
				)
			})
	}

	#[tokio::test]
	async fn user_rewind_reconciles_todo_state_and_cancels_dropped_jobs() {
		use crate::todo_restore::test_support::todo_outcome_item;

		let (mut journal, path) = test_journal("reconcile-user");
		let phases_one = serde_json::json!([
			{"phase": "Build", "items": [{"text": "port", "status": "pending"}]}
		]);
		let phases_two = serde_json::json!([
			{"phase": "Build", "items": [{"text": "port", "status": "completed"}]}
		]);
		journal
			.append_optimistic(1, message(thread::Role::User, "turn one"), None)
			.expect("first user turn");
		let keep = journal
			.append_optimistic(2, todo_outcome_item(&phases_one), None)
			.expect("first todo outcome");
		journal
			.append_optimistic(3, todo_outcome_item(&phases_two), None)
			.expect("second todo outcome");
		journal
			.register_job(4, loop_job("dropped-job"))
			.expect("register dropped job");

		let (env, transport) = EnvClient::in_process(1);
		let (commits, server) = serve_slot_invocations(transport);
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::new())),
			opened:  Arc::new(Mutex::new(Vec::new())),
		};
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		agent.add_stateful_component(Arc::new(crate::TodoRestore));
		let events = agent.events().subscribe_lossless();

		agent.rewind(Some(keep)).expect("rewind to first outcome");
		reconcile_with_timeout(&mut agent).await;
		{
			let commits = commits.lock();
			assert_eq!(commits.len(), 1);
			assert_eq!(commits[0].0, "todo");
			assert_eq!(commits[0].1, serde_json::json!({"op": "init", "list": phases_one}));
		}
		let rewrites = history_rewritten_events(&events);
		assert_eq!(rewrites.len(), 1);
		let (to, head, escalated) = &rewrites[0];
		assert_eq!(*to, Some(keep));
		let expected_head =
			u64::try_from(agent.journal().load().expect("load").len()).expect("head fits") - 1;
		assert_eq!(*head, expected_head);
		assert_eq!(escalated.as_slice(), [Str::new("dropped-job")]);
		assert!(
			!journal_has_rewind_warning(agent.journal()),
			"every pending job was cancelled, so no background warning is appended"
		);

		// A second rewrite to the root clears the slot.
		agent.rewind(None).expect("rewind to root");
		reconcile_with_timeout(&mut agent).await;
		{
			let commits = commits.lock();
			assert_eq!(commits.len(), 2);
			assert_eq!(
				commits[1].1,
				serde_json::json!({"op": "init", "list": serde_json::Value::Array(Vec::new())})
			);
		}
		drop(agent);
		server.abort();
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn checkpoint_rewind_keeps_jobs_and_appends_the_background_warning() {
		use crate::todo_restore::test_support::todo_outcome_item;

		let (mut journal, path) = test_journal("reconcile-checkpoint");
		let phases = serde_json::json!([
			{"phase": "Explore", "items": [{"text": "scout", "status": "pending"}]}
		]);
		let keep = journal
			.append_optimistic(1, todo_outcome_item(&phases), None)
			.expect("todo outcome");
		journal
			.append_optimistic(2, message(thread::Role::User, "explore"), None)
			.expect("user turn");
		journal
			.register_job(3, loop_job("scout-job"))
			.expect("register scout job");

		let (env, transport) = EnvClient::in_process(1);
		let (commits, server) = serve_slot_invocations(transport);
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::new())),
			opened:  Arc::new(Mutex::new(Vec::new())),
		};
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		agent.add_stateful_component(Arc::new(crate::TodoRestore));
		let events = agent.events().subscribe_lossless();

		agent.rewind(Some(keep)).expect("rewind");
		agent.pending_history_rewrite =
			Some(PendingHistoryRewrite { to: Some(keep), cause: HistoryRewriteCause::Checkpoint });
		reconcile_with_timeout(&mut agent).await;

		assert_eq!(commits.lock().len(), 1, "todo restore still runs for checkpoint rewinds");
		let rewrites = history_rewritten_events(&events);
		assert_eq!(rewrites.len(), 1);
		assert!(rewrites[0].2.is_empty(), "checkpoint rewinds cancel nothing");
		assert!(
			journal_has_rewind_warning(agent.journal()),
			"surviving jobs are announced with the background warning"
		);
		drop(agent);
		server.abort();
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn rewind_discards_queued_user_steering_before_next_submission() {
		let (journal, path) = test_journal("rewind-steering");
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([outcome_script(end_outcome(
				"replacement answer",
			))]))),
			opened:  Arc::clone(&opened),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		agent
			.mailbox()
			.try_enqueue(Interrupt {
				class:  InterruptClass::Immediate,
				item:   message(thread::Role::User, "stale steering"),
				source: InterruptSource::Producer(sf!("user")),
			})
			.expect("enqueue stale steering");

		agent.rewind(None).expect("rewind to root");
		agent
			.submit([message(thread::Role::User, "replacement")], TurnId::new("replacement"))
			.await
			.expect("replacement turn");

		let opened = opened.lock();
		assert_eq!(opened.len(), 1);
		assert!(input_contains_text(&opened[0].1, "replacement"));
		assert!(!input_contains_text(&opened[0].1, "stale steering"));
		drop(opened);
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn control_requests_complete_at_idle_and_active_turn_points() {
		let (journal, path) = test_journal("control-mailbox");
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([
				outcome_script(end_outcome("idle drained")),
				pending_text_script(),
			]))),
			opened:  Arc::clone(&opened),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		let control = agent.control();
		let idle_request = tokio::spawn({
			let control = control.clone();
			async move { control.query(Vec::new()).await }
		});
		yield_now().await;
		agent
			.submit([message(thread::Role::User, "idle")], TurnId::new("idle"))
			.await
			.expect("idle turn");
		assert!(
			idle_request
				.await
				.expect("idle CONTROL task")
				.expect("idle CONTROL request")
				.is_empty()
		);

		let abort = agent.abort_handle();
		let active = tokio::spawn(async move {
			let result = agent
				.submit([message(thread::Role::User, "active")], TurnId::new("active"))
				.await;
			(agent, result)
		});
		wait_for_opened(&opened, 2).await;
		let rows = time::timeout(Duration::from_secs(1), control.query(Vec::new()))
			.await
			.expect("active CONTROL timeout")
			.expect("active CONTROL request");
		assert!(rows.is_empty());
		abort.abort();
		let (agent, result) = active.await.expect("active turn task");
		let summary = result.expect("caller abort settles the active turn");
		assert!(summary.interrupted);
		assert_eq!(summary.settlement, RunSettlement::CallerAbort);
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn scheduled_rewind_waits_for_active_tool_batch_boundary() {
		let (journal, path) = test_journal("scheduled-rewind-boundary");
		let identity = ToolIdentity { name: sf!("pending"), rev: Rev { family: sf!("test"), n: 1 } };
		let mut registry = ToolRegistry::new();
		registry
			.register_worker(worker(identity.name.as_str()), Presentation::Device, worker_claims())
			.expect("register pending tool");
		let state = AgentState::new(AgentSnapshot {
			enabled_tools: Arc::from([identity.name.clone()]),
			registry: Arc::new(registry),
			..AgentSnapshot::default()
		});
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([pending_tool_script(&identity)]))),
			opened:  Arc::new(Mutex::new(Vec::new())),
		};
		let (env, transport) = EnvClient::in_process(1);
		let (requests, responses) = transport.into_parts();
		let env_task = tokio::spawn(async move {
			let _responses = responses;
			while requests.recv_async().await.is_ok() {}
		});
		let mut agent = Agent::new(client, env, state, journal, test_caps());
		let control = agent.control();
		let checkpoint = tokio::spawn({
			let control = control.clone();
			async move { control.checkpoint(sf!("before batch")).await }
		});
		yield_now().await;
		agent.drain_control();
		let checkpoint = checkpoint
			.await
			.expect("checkpoint task")
			.expect("checkpoint command");
		let checkpoint_event = agent
			.checkpoint_state
			.lock()
			.active
			.as_ref()
			.expect("active checkpoint")
			.event;

		let events = agent.events().subscribe_lossless();
		let abort = agent.abort_handle();
		let scheduling = async {
			loop {
				let event = events.recv().await.expect("agent event");
				if matches!(event.as_ref(), AgentEvent::PhaseChanged { to: AgentPhase::ToolBatch, .. })
				{
					let ack = control
						.schedule_rewind(checkpoint.token.clone(), sf!("thread"))
						.await
						.expect("schedule rewind");
					assert_eq!(ack.token, checkpoint.token);
					abort.abort();
					break ack;
				}
			}
		};
		let (summary, ack) = tokio::join!(
			agent.submit(
				[message(thread::Role::User, "run pending tool")],
				TurnId::new("scheduled-rewind"),
			),
			scheduling,
		);
		let summary = summary.expect("rewind boundary summary");
		assert_eq!(ack.token, checkpoint.token);
		assert_eq!(summary.committed_turns, 1);

		let log = agent.journal.load().expect("load rewind journal");
		let mut settled = None;
		let mut rewinds = Vec::new();
		for index in 0..u64::try_from(log.len()).expect("journal length") {
			let Some(Entry::Ok(event)) = log.get(index) else {
				continue;
			};
			match &event.kind {
				Kind::InvocationTransition(transition)
					if transition.phase == InvocationPhase::Settled =>
				{
					settled = Some(index);
				},
				Kind::Rewind { to } => rewinds.push((index, *to)),
				_ => {},
			}
		}
		assert_eq!(rewinds.len(), 1, "rewind outcome is journaled exactly once");
		assert_eq!(rewinds[0].1, Some(checkpoint_event));
		assert!(
			settled.is_some_and(|settled| settled < rewinds[0].0),
			"rewind executes only after tool settlement is journaled"
		);
		drop(log);
		drop(agent);
		env_task.abort();
		fs::remove_file(path).expect("remove journal");
	}

	#[tokio::test]
	async fn deadline_wait_wins_over_long_backoff() {
		let deadline = Instant::now() + Duration::from_millis(1);
		let result = sleep_with_deadline(Duration::from_secs(60), Some(deadline)).await;
		assert!(matches!(result, Err(AgentError::Deadline)));
	}
	#[test]
	fn mixed_terminate_batch_stages_automatic_follow_up() {
		assert!(!batch_terminates([true, false]));
	}

	#[test]
	fn unanimous_terminate_batch_skips_automatic_follow_up() {
		assert!(batch_terminates([true, true]));
		assert!(!batch_terminates([]));
	}
	#[test]
	fn advisor_tool_loop_abort_settles_without_terminal_failure() {
		let (journal, path) = test_journal("advisor-tool-loop-abort");
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::new())),
			opened:  Arc::new(Mutex::new(Vec::new())),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		agent.enable_advisor_tool_loop_guard();
		let result = agent
			.settle_advisor_tool_loop_abort(
				Outcome { stop: pb::StopReason::StopToolUse as i32, ..Outcome::default() },
				6,
				vec![message(thread::Role::User, "bounded advisor stop")],
				Vec::new(),
				Vec::new(),
			)
			.expect("advisor loop bound settles cleanly");
		assert!(!result.interrupted);
		assert_eq!(result.settlement, RunSettlement::Warning);
		assert_eq!(agent.phase, AgentPhase::Idle);
		assert!(agent.journal().pending_turn().is_none());
		let items = agent
			.journal()
			.items_at(&agent.journal().live_item_events().expect("live events"))
			.expect("live items");
		assert!(items.iter().any(|item| {
			matches!(
				item.kind.as_ref(),
				Some(item::Kind::Message(message))
					if message.parts.iter().any(|part| {
						matches!(
							part.kind.as_ref(),
							Some(part::Kind::Text(text)) if text == "bounded advisor stop"
						)
					})
			)
		}));
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}
	#[test]
	fn silent_abort_item_carries_structural_suppression_and_reason() {
		let item = silent_abort_item("TTSR matched rule: no-unwrap");
		let props = item.props.expect("silent abort item has properties");
		assert_eq!(
			props
				.fields
				.get(crate::journal_kinds::SILENT_ABORT_PROP)
				.and_then(|value| value.kind.as_ref()),
			Some(&value::Kind::Bool(true))
		);
		assert_eq!(
			props
				.fields
				.get(crate::journal_kinds::ABORT_REASON_PROP)
				.and_then(|value| value.kind.as_ref()),
			Some(&value::Kind::String("TTSR matched rule: no-unwrap".to_owned()))
		);
	}
	#[tokio::test]
	async fn stream_rule_cancel_recovers_with_reminder_turn() {
		let (journal, path) = test_journal("ttsr-cancel");
		let interrupting = vec![
			Ok(pb::TurnEvent {
				event: Some(turn_event::Event::PartStart(pb::PartStart {
					index:        0,
					kind:         part_start::Kind::Text as i32,
					tool_call_id: String::new(),
					tool_name:    String::new(),
				})),
			}),
			Ok(pb::TurnEvent {
				event: Some(turn_event::Event::PartDelta(pb::PartDelta {
					index: 0,
					chunk: Bytes::from_static(b"let value = FORBIDDEN_TOKEN;"),
				})),
			}),
		];
		let scripts = VecDeque::from([interrupting, outcome_script(end_outcome("clean"))]);
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client =
			ScriptedClient { scripts: Arc::new(Mutex::new(scripts)), opened: Arc::clone(&opened) };
		let (env, _transport) = EnvClient::in_process(1);
		let mut agent =
			Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, test_caps());
		let (registry, diagnostics) = TtsrRegistry::from_layers(
			crate::TtsrSettings::default(),
			[crate::TtsrRule {
				name:           sf!("no-forbidden"),
				content:        sf!("Never emit FORBIDDEN_TOKEN."),
				conditions:     vec![sf!("FORBIDDEN_TOKEN")],
				ast_conditions: Vec::new(),
				scopes:         Vec::new(),
				globs:          Vec::new(),
				interrupt_mode: Some(crate::TtsrInterruptMode::Always),
			}],
			[],
		);
		assert!(diagnostics.is_empty(), "test rule compiles cleanly");
		agent.set_ttsr_registry(registry);
		let summary = agent
			.submit([message(thread::Role::User, "write the code")], TurnId::new("turn-ttsr"))
			.await
			.expect("stream cancel recovers into a committed turn");
		assert_eq!(summary.settlement, RunSettlement::Success);
		assert_eq!(summary.committed_turns, 1);
		assert_eq!(summary.final_assistant(), Some("clean"));
		let opened = opened.lock();
		assert_eq!(opened.len(), 2, "cancelled turn is replayed with the reminder");
		let TurnInput::Full(thread) = &opened[1].1 else {
			panic!("recovery turn reseeds a full thread");
		};
		let reminder = thread.items.iter().any(|item| {
			matches!(
				item.kind.as_ref(),
				Some(item::Kind::Message(message)) if message.parts.iter().any(|part| {
					matches!(
						part.kind.as_ref(),
						Some(part::Kind::Text(text)) if text.contains("Rule `no-forbidden`")
					)
				})
			)
		});
		assert!(reminder, "recovery turn carries the stream-rule reminder");
		let log = agent.journal().load().expect("load journal");
		let injections = log
			.as_ref()
			.iter()
			.filter(|index| {
				matches!(
					log.get(*index),
					Some(omp_storage::transcript::Entry::Ok(event))
						if matches!(
							&event.kind,
							omp_storage::transcript::Kind::Custom(custom)
								if custom.kind() == crate::journal_kinds::TTSR_INJECTION_KIND
						)
				)
			})
			.count();
		assert_eq!(injections, 1, "one durable TTSR injection record lands");
		drop(log);
		drop(agent);
		fs::remove_file(path).expect("remove journal");
	}

	#[test]
	fn context_promotion_runs_once_before_compaction() {
		let (journal, path) = test_journal("context-promotion");
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::new())),
			opened:  Arc::new(Mutex::new(Vec::new())),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut snapshot = AgentSnapshot::default();
		snapshot.turn.params.model = "provider/small".to_owned();
		snapshot.context_promotion =
			ContextPromotionPolicy { enabled: true, target: Some(sf!("provider/large")) };
		let mut agent = Agent::new(client, env, AgentState::new(snapshot), journal, test_caps());
		assert!(agent.promote_context_if_enabled());
		let promoted = agent.state().snapshot();
		assert_eq!(promoted.turn.params.model, "provider/large");
		assert!(promoted.turn.provider_reset);
		assert!(!agent.promote_context_if_enabled(), "target promotion is one-shot");
		drop(agent);
		if path.exists() {
			fs::remove_file(path).expect("remove journal");
		}
	}

	#[test]
	fn mid_turn_compaction_is_enabled_and_threshold_gated() {
		let usage =
			pb::Usage { context_tokens: Some(80_000), input_tokens: 70_000, ..pb::Usage::default() };
		assert!(mid_turn_compaction_due(
			MidTurnCompactionPolicy { enabled: true, threshold_tokens: 80_000 },
			Some(&usage),
		));
		assert!(!mid_turn_compaction_due(
			MidTurnCompactionPolicy { enabled: false, threshold_tokens: 1 },
			Some(&usage),
		));
		assert!(!mid_turn_compaction_due(
			MidTurnCompactionPolicy { enabled: true, threshold_tokens: 80_001 },
			Some(&usage),
		));
	}

	#[test]
	fn complete_end_turn_calls_are_valid_and_truncated_calls_receive_pairing_results() {
		let call = Item {
			kind: Some(item::Kind::ToolCall(thread::ToolCall {
				id: "call-1".to_owned(),
				name: "write".to_owned(),
				args_json: Bytes::from_static(br#"{"path":"large","content":"partial"#),
				..thread::ToolCall::default()
			})),
			props: Some(pb::ValueMap {
				fields: BTreeMap::from([(omp_tool::TOOL_REV_PROP.to_owned(), pb::Value {
					kind: Some(value::Kind::String("1".to_owned())),
				})]),
			}),
			..Item::default()
		};
		let end = Outcome {
			output: vec![call.clone()],
			stop: pb::StopReason::StopEndTurn as i32,
			..Outcome::default()
		};
		validate_outcome(&end).expect("complete end-turn calls are runnable");
		let results = truncated_tool_results(&[call]).expect("pair truncated call");
		let Some(item::Kind::ToolResult(result)) = results[0].kind.as_ref() else {
			panic!("truncated call must receive a tool result");
		};
		assert_eq!(result.call_id, "call-1");
		assert!(result.is_error);
		assert!(result.parts.iter().any(|part| {
			matches!(
				part.kind.as_ref(),
				Some(part::Kind::Text(text))
					if text.contains("output-token limit") && text.contains("chunked")
			)
		}));
	}

	#[test]
	fn run_summary_classifies_terminal_outcomes_and_projects_assistant() {
		let success = AgentRunSummary::settled(end_outcome("done"), 1, false);
		assert_eq!(success.settlement, RunSettlement::Success);
		assert_eq!(success.final_assistant(), Some("done"));

		let maximum = AgentRunSummary::settled(
			Outcome { stop: pb::StopReason::StopMaxTokens as i32, ..Outcome::default() },
			1,
			false,
		);
		assert_eq!(maximum.settlement, RunSettlement::MaxTokens);
		let plan_exit = AgentRunSummary::settled(end_outcome("partial"), 0, true);
		assert!(plan_exit.interrupted);
		assert_eq!(plan_exit.settlement, RunSettlement::CallerAbort);
		assert_eq!(
			AgentRunSummary::silent_compaction_transition(None, 1).settlement,
			RunSettlement::SilentCompactionTransition
		);
		assert_eq!(AgentRunSummary::terminal_fault().settlement, RunSettlement::TerminalFault);
	}

	#[test]
	fn run_summary_extracts_yield_arguments_verbatim() {
		let call = thread::ToolCall {
			id: sf!("yield-call").to_string(),
			name: "yield".to_owned(),
			args_json: Bytes::from_static(
				br#"{"result":{"data":{"summary":{"purge":13,"keep":20}}}}"#,
			),
			..thread::ToolCall::default()
		};
		let summary = run_summary(
			Some(Outcome {
				output: vec![Item { kind: Some(item::Kind::ToolCall(call)), ..Item::default() }],
				stop: pb::StopReason::StopEndTurn as i32,
				..Outcome::default()
			}),
			1,
			false,
		);
		let schema = serde_json::json!({
			"type": "object",
			"properties": {"summary": {"type": "string"}},
			"required": ["summary"],
			"additionalProperties": false
		});
		let mut validator = YieldPayloadValidator::new(Some(schema), true);
		assert!(matches!(
			summary.yield_payload(&mut validator),
			Err(YieldPayloadError::SchemaViolation { path, rule: "type" })
				if path.as_str() == "/summary"
		));
	}
	#[tokio::test]
	async fn payload_rejection_is_terminal_once_but_remains_display_durable() {
		let (journal, path) = test_journal("payload-terminal");
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([vec![Ok(pb::TurnEvent {
				event: Some(turn_event::Event::Error(pb::TurnError {
					kind: turn_error::Kind::PayloadRejected as i32,
					detail: "request bytes rejected".to_owned(),
					..pb::TurnError::default()
				})),
			})]]))),
			opened:  Arc::clone(&opened),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let state = AgentState::new(AgentSnapshot::default());
		let mut agent = Agent::new(client, env, state.clone(), journal, test_caps());

		let result = agent
			.submit([message(thread::Role::User, "oversized request")], TurnId::new("payload-turn"))
			.await;
		assert!(matches!(
			result,
			Err(AgentError::Turn(TurnError::Terminal(error)))
				if error.kind == turn_error::Kind::PayloadRejected as i32
		));
		assert_eq!(opened.lock().len(), 1, "same-model retries are forbidden");

		let live = agent
			.journal()
			.live_item_events()
			.expect("live item events");
		let display = agent.journal().items_at(&live).expect("display projection");
		assert!(display.iter().any(|item| {
			matches!(
				item.kind.as_ref(),
				Some(item::Kind::Message(message))
					if message.parts.iter().any(|part| {
						matches!(
							part.kind.as_ref(),
							Some(part::Kind::Text(text)) if text == "oversized request"
						)
					})
			)
		}));
		let log = agent.journal().load().expect("journal log");
		let provider =
			project_journal(&log, log.as_ref(), state.snapshot().registry.as_ref(), &test_caps())
				.expect("provider projection");
		assert_eq!(
			display.len(),
			provider.items.len() + 1,
			"exactly one durable terminal error-only frame stays display-only"
		);
		fs::remove_file(path).expect("remove journal");
	}

	#[derive(Debug)]
	struct ScriptedUnexpectedStopClassifier(Mutex<VecDeque<bool>>);

	impl UnexpectedStopClassifier for ScriptedUnexpectedStopClassifier {
		fn should_continue<'a>(
			&'a self,
			_text: &'a str,
		) -> Pin<Box<dyn Future<Output = Result<bool, Str>> + Send + 'a>> {
			Box::pin(future::ready(Ok(self.0.lock().pop_front().unwrap_or(false))))
		}
	}

	#[tokio::test]
	async fn smart_unexpected_stop_classifies_visible_text() {
		let (journal, path) = test_journal("smart-unexpected-stop");
		let opened = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([
				outcome_script(end_outcome("I will make that change now.")),
				outcome_script(end_outcome("Done.")),
			]))),
			opened:  Arc::clone(&opened),
		};
		let (env, _transport) = EnvClient::in_process(1);
		let mut snapshot = AgentSnapshot::default();
		snapshot.unexpected_stop = UnexpectedStopMode::Smart;
		let mut agent = Agent::new(client, env, AgentState::new(snapshot), journal, test_caps());
		agent.set_unexpected_stop_classifier(Arc::new(ScriptedUnexpectedStopClassifier(Mutex::new(
			VecDeque::from([true, false]),
		))));

		let summary = agent
			.submit([message(thread::Role::User, "finish the task")], TurnId::new("smart-stop"))
			.await
			.expect("smart continuation succeeds");
		assert_eq!(summary.committed_turns, 2);
		assert_eq!(opened.lock().len(), 2);
		fs::remove_file(path).expect("remove journal");
	}

	#[test]
	fn speculation_commits_verbatim_tolerates_formatting_drift_only() {
		// Empty and byte-identical streams commit as-is.
		assert!(speculation_commits_verbatim("", br#"{"path":"src"}"#));
		assert!(speculation_commits_verbatim(r#"{"path":"src"}"#, br#"{"path":"src"}"#));
		// Non-canonical provider whitespace and escapes parse to the same value.
		assert!(speculation_commits_verbatim(
			"{\"path\": \"src\",\n  \"pattern\": \"a|b\"}",
			br#"{"path":"src","pattern":"a|b"}"#
		));
		assert!(speculation_commits_verbatim(r#"{"p": "\u0061"}"#, br#"{"p":"a"}"#));
		// Value drift (recovery repair, secret restoration) is not committable.
		assert!(!speculation_commits_verbatim(r#"{"p": "PLACEHOLDER"}"#, br#"{"p":"real"}"#));
		// A stream that never parsed cannot stay authoritative.
		assert!(!speculation_commits_verbatim(r#"{"p":"src""#, br#"{"p":"src"}"#));
	}

	#[tokio::test]
	async fn committed_calls_commit_streamed_fragments_verbatim() {
		let (client, transport) = EnvClient::in_process(0);
		let (requests, _responses) = transport.into_parts();
		let events = EventBus::new();
		let identity =
			ToolIdentity { name: sf!("grep"), rev: omp_tool::Rev { family: sf!("test"), n: 1 } };
		let mut streamed = SpeculativeCall::open(
			&client,
			&events,
			sf!("call-streamed"),
			identity.clone(),
			Duration::from_secs(1),
		)
		.await
		.expect("open streamed call");
		let _ = requests.recv_async().await.expect("InvokeTool frame");
		// Providers may stream non-canonical whitespace; those exact bytes are
		// what the tool's streaming parser consumed.
		streamed
			.relay_fragment(sf!("{{\"path\": \"src/lib.rs\"}}"))
			.await
			.expect("relay spaced fragment");
		let _ = requests.recv_async().await.expect("ArgText frame");
		let seeded = SpeculativeCall::open(
			&client,
			&events,
			sf!("call-seeded"),
			identity.clone(),
			Duration::from_secs(1),
		)
		.await
		.expect("open seeded call");
		let _ = requests
			.recv_async()
			.await
			.expect("second InvokeTool frame");
		let mut speculative =
			BTreeMap::from([(sf!("call-streamed"), streamed), (sf!("call-seeded"), seeded)]);
		let item = |id: &str, args: &'static [u8]| Item {
			kind: Some(item::Kind::ToolCall(thread::ToolCall {
				id: id.to_owned(),
				name: "grep".to_owned(),
				args_json: Bytes::from_static(args),
				..thread::ToolCall::default()
			})),
			props: Some(pb::ValueMap {
				fields: BTreeMap::from([(omp_tool::TOOL_REV_PROP.to_owned(), pb::Value {
					kind: Some(value::Kind::String(identity.rev.to_string())),
				})]),
			}),
			..Item::default()
		};
		let output = [
			item("call-streamed", br#"{"path":"src/lib.rs"}"#),
			item("call-seeded", b"{\"path\": \"x\"}"),
		];
		let calls = committed_calls(&output, &mut speculative, None).expect("commit calls");
		let raw = |id: &str| {
			calls
				.iter()
				.find(|call| call.call_id().as_str() == id)
				.expect("committed call")
				.raw_args()
				.clone()
		};
		// Streamed fragments stay authoritative byte-for-byte.
		assert_eq!(raw("call-streamed"), Bytes::from_static(b"{\"path\": \"src/lib.rs\"}"));
		// Without fragments the canonical restored form seeds the commitment.
		assert_eq!(raw("call-seeded"), Bytes::from_static(br#"{"path":"x"}"#));
	}

	#[test]
	fn restores_nested_model_arguments_without_changing_operator_values() {
		let rule = SecretRule::new(
			SecretKind::Plain,
			SecretMode::Obfuscate,
			"model-secret",
			None,
			None,
			None,
		)
		.expect("rule");
		let mut obfuscator = SecretObfuscator::new(vec![rule], "K".repeat(43));
		let placeholder = obfuscator.obfuscate("model-secret");
		let arguments = serde_json::to_vec(&serde_json::json!({
			"nested": [placeholder],
			"operator_literal": "model-secret"
		}))
		.expect("arguments");
		let obfuscator = Arc::new(Mutex::new(obfuscator));
		let restored = restored_argument_bytes(&arguments, Some(&obfuscator)).expect("restore");
		let value: Value = serde_json::from_slice(&restored).expect("json");
		assert_eq!(value["nested"][0], "model-secret");
		assert_eq!(value["operator_literal"], "model-secret");
	}
}
