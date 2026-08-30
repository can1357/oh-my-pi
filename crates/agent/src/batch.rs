//! Speculative environment invocations and ordered concurrent tool batches.

use std::{
	collections::BTreeMap,
	future,
	sync::{
		Arc, OnceLock,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use flume::Receiver;
use omp_core::{IntoStr, Str, StrMut, ToolPath, sf};
use omp_env::{ClientError, EnvClient, Invocation, InvocationEvent};
use omp_proto::{
	env::v1::{Admission, AdmitInvocation, InvokeTool},
	inference::{
		v1,
		v1::{self as value_pb, value},
	},
	policy::v1::{EffectEnvelope, PolicyDenied as WirePolicyDenied},
	prost::Message as _,
	thread::v1::{Item, Part as CanonicalPart},
	toolhost::v1::HookEventId,
};
use omp_tool::{
	Abort, ArgIssue, ArgPath, CallOutcome, CallOutcomeDetails, CapsBase, Effects, ExecutionMode,
	JobRef, Part, PromptCaps, Registry, ToolIdentity, ToolTerminal,
};
use portable_atomic::AtomicU128;
use serde_json::Value;
use tokio::{sync::Notify, task, time};

use crate::{
	events::{AgentEvent, EventBus, EventProvenance, EventVisibility},
	hooks::{GateEvent, GateOutcome, HookGate, notify_json},
	project::{tool_result_item, tool_result_item_canonical_parts},
};

/// Namespaced invocation property carrying the environment-enforced mode.
pub const EXECUTION_MODE_PROP: &str = "omp/execution-mode";
/// Namespaced authorization for the one plan-to-execution transition.
pub const PLAN_YOLO_PROP: &str = "omp/plan-yolo";
/// Namespaced explanation for an automatic prewalk transition.
pub const PREWALK_REASON_PROP: &str = "omp/prewalk-reason";

/// Builds immutable invocation metadata from the regime-scoped mode setting.
///
/// `plan-yolo` and `prewalk` are one-shot settings removed by the agent before
/// this function is called for their first mutating effect.
pub fn invocation_mode_props(mode: Option<&str>, effects: &Effects) -> value_pb::ValueMap {
	let mode = mode.unwrap_or("standard");
	let mut fields = BTreeMap::new();
	let label = match mode {
		"plan-yolo" => {
			if effects_mutate_environment(effects) {
				fields.insert(PLAN_YOLO_PROP.to_owned(), bool_value(true));
			}
			"plan"
		},
		"prewalk" => {
			if effects_mutate_environment(effects) {
				fields.insert(
					PREWALK_REASON_PROP.to_owned(),
					string_value("first mutating environment effect"),
				);
			}
			"prewalk"
		},
		mode => mode,
	};
	fields.insert(EXECUTION_MODE_PROP.to_owned(), string_value(label));
	value_pb::ValueMap { fields }
}

/// Returns whether an effect envelope may mutate Environment-owned state.
pub fn effects_mutate_environment(effects: &Effects) -> bool {
	effects
		.documents
		.as_ref()
		.is_some_and(|documents| !documents.write_globs.is_empty())
		|| effects.exec.as_ref().is_some_and(|exec| !exec.is_empty())
		|| effects.subagents != 0
}

fn batch_execution_mode<'a>(
	identities: impl IntoIterator<Item = &'a ToolIdentity>,
	registry: &Registry,
) -> ExecutionMode {
	if identities.into_iter().any(|identity| {
		registry
			.execution_mode(&identity.name)
			.is_ok_and(|mode| mode == ExecutionMode::Sequential)
	}) {
		ExecutionMode::Sequential
	} else {
		ExecutionMode::Parallel
	}
}

fn string_value(value: &str) -> value_pb::Value {
	value_pb::Value { kind: Some(value::Kind::String(value.to_owned())) }
}

const fn bool_value(value: bool) -> value_pb::Value {
	value_pb::Value { kind: Some(value::Kind::Bool(value)) }
}

fn target_kind(_: &ToolIdentity) -> &'static str {
	"core"
}

fn tool_target(identity: &ToolIdentity, args: &[u8]) -> Value {
	let args = serde_json::from_slice::<Value>(args)
		.ok()
		.filter(Value::is_object)
		.unwrap_or_else(|| Value::Object(serde_json::Map::new()));
	serde_json::json!({
		"kind": target_kind(identity),
		"name": identity.name,
		"rev": identity.rev.to_string(),
		"args": args,
	})
}

fn hook_policy_denied(
	query: &AdmitInvocation,
	reason: Str,
	policy: Option<Arc<omp_tool::PolicyDenied>>,
) -> Admission {
	let policy = policy
		.map(Arc::unwrap_or_clone)
		.unwrap_or_else(|| omp_tool::PolicyDenied {
			reason:      reason.clone(),
			code:        Some(sf!("hook_denied")),
			decision_id: Str::from(omp_core::Ulid::generate().to_string()),
			rules:       Arc::from([]),
		});
	Admission {
		invocation_id: query.invocation_id.clone(),
		allow: false,
		denied: Some(WirePolicyDenied {
			reason: policy.reason.to_string(),
			code: policy
				.code
				.map_or_else(String::new, |code| code.to_string()),
			decision_id: policy.decision_id.to_string(),
			rules: policy.rules.iter().map(ToString::to_string).collect(),
			..WirePolicyDenied::default()
		}),
		..Admission::default()
	}
}

async fn gate_tool_call(
	gate: &HookGate,
	query: &AdmitInvocation,
	identity: &ToolIdentity,
	raw_args: &[u8],
) -> InvocationAdmission {
	if !gate.subscribed(HookEventId::HookEventToolCall) {
		return InvocationAdmission {
			admission: allowed_admission(query),
			effects:   Effects::empty(),
		};
	}
	let args = serde_json::from_slice::<Value>(raw_args)
		.ok()
		.filter(Value::is_object)
		.unwrap_or_else(|| Value::Object(serde_json::Map::new()));
	let requested_args = args.clone();
	let payload = serde_json::json!({
		"call_id": query.invocation_id,
		"invocation_id": query.invocation_id,
		"target": tool_target(identity, raw_args),
		"kind": target_kind(identity),
		"args": args,
		"raw_args": {
			"$bytes": omp_core::base64::encode(raw_args),
		},
		"repaired": false,
		"turn_id": "",
		"session_id": "",
		"cwd": ".",
		"origin": "model",
		"batch": [],
		"deadline": Value::Null,
		"bash": Value::Null,
		"__omp_bash_proto": query.bash.as_ref().map(|bash| serde_json::json!({
			"$bytes": omp_core::base64::encode(&bash.encode_to_vec()),
		})),
	});
	let encoded = match serde_json::to_vec(&payload) {
		Ok(encoded) => encoded,
		Err(_) => {
			return InvocationAdmission {
				admission: hook_policy_denied(
					query,
					sf!("tool_call hook payload serialization failed"),
					None,
				),
				effects:   Effects::empty(),
			};
		},
	};
	match gate
		.gate(
			HookEventId::HookEventToolCall,
			GateEvent::new(identity.name.clone(), Bytes::from(encoded)),
		)
		.await
	{
		GateOutcome::Allow { event, .. } => {
			let Some(args) = serde_json::from_slice::<Value>(&event.effective_args)
				.ok()
				.and_then(|payload| payload.get("args").cloned())
				.filter(Value::is_object)
			else {
				return InvocationAdmission {
					admission: hook_policy_denied(
						query,
						sf!("tool_call hook returned malformed arguments"),
						None,
					),
					effects:   Effects::empty(),
				};
			};
			let patch = if args == requested_args {
				Bytes::new()
			} else {
				match serde_json::to_vec(&args) {
					Ok(args) => Bytes::from(args),
					Err(_) => {
						return InvocationAdmission {
							admission: hook_policy_denied(
								query,
								sf!("tool_call hook arguments could not be encoded"),
								None,
							),
							effects:   Effects::empty(),
						};
					},
				}
			};
			InvocationAdmission {
				admission: Admission {
					invocation_id: query.invocation_id.clone(),
					allow: true,
					args_patch: patch,
					..Admission::default()
				},
				effects:   Effects::empty(),
			}
		},
		GateOutcome::Deny { reason, policy, .. } => InvocationAdmission {
			admission: hook_policy_denied(query, reason, policy),
			effects:   Effects::empty(),
		},
		GateOutcome::Approval { specs, .. } => {
			let rules = specs
				.into_iter()
				.flat_map(|spec| spec.evidence)
				.collect::<Vec<_>>();
			let reason = sf!("tool_call hook requires unavailable approval");
			InvocationAdmission {
				admission: hook_policy_denied(
					query,
					reason.clone(),
					Some(Arc::new(omp_tool::PolicyDenied {
						reason,
						code: Some(sf!("hook_approval_unavailable")),
						decision_id: Str::from(omp_core::Ulid::generate().to_string()),
						rules: rules.into(),
					})),
				),
				effects:   Effects::empty(),
			}
		},
	}
}

fn outcome_kind(
	outcome: Option<&CallOutcome<CallOutcomeDetails, CallOutcomeDetails>>,
) -> &'static str {
	match outcome {
		Some(CallOutcome::Ok(_)) => "ok",
		Some(CallOutcome::Faulted(_)) => "faulted",
		Some(CallOutcome::ArgsRejected(_)) => "args_rejected",
		Some(CallOutcome::Aborted { .. }) | None => "aborted",
	}
}

fn outcome_storage(
	outcome: Option<&CallOutcome<CallOutcomeDetails, CallOutcomeDetails>>,
) -> (bool, Option<String>) {
	let details = match outcome {
		Some(CallOutcome::Ok(details) | CallOutcome::Faulted(details)) => Some(details),
		_ => None,
	};
	match details {
		Some(CallOutcomeDetails::Spilled { blob, .. }) => {
			(true, Some(format!("blob://{}", blob.hash)))
		},
		_ => (false, None),
	}
}

fn outcome_effects_unknown(
	outcome: Option<&CallOutcome<CallOutcomeDetails, CallOutcomeDetails>>,
) -> bool {
	matches!(outcome, Some(CallOutcome::Aborted { abort: Abort::EffectsUnknown { .. }, .. }))
}

/// Failure to open, relay, decode, project, or lower a tool invocation.
#[derive(Debug, thiserror::Error)]
pub enum BatchError {
	/// The environment channel rejected an operation.
	#[error("environment invocation failed: {0}")]
	Environment(#[source] ClientError),
	/// A terminal environment payload was not a supported structured outcome.
	#[error("invalid tool outcome: {0}")]
	InvalidOutcome(#[source] serde_json::Error),
	/// Canonical result construction failed.
	#[error("canonical tool result failed: {0}")]
	Projection(Str),
	/// The invocation hook bus was already installed.
	#[error("canonical tool result failed: invocation hook bus already set")]
	HookBusAlreadySet,
	/// The invocation catalog hook gate was already installed.
	#[error("canonical tool result failed: invocation catalog hook gate already set")]
	HookGateAlreadySet,
	/// The invocation effect maximum was already installed.
	#[error("canonical tool result failed: invocation effect maximum already set")]
	EffectMaximumAlreadySet,
	/// The invocation fact bus was already installed.
	#[error("canonical tool result failed: invocation fact bus already set")]
	FactBusAlreadySet,
}

impl From<ClientError> for BatchError {
	fn from(error: ClientError) -> Self {
		Self::Environment(error)
	}
}
/// Returns the subscription-mask bit for one stable hook event id.
pub const fn hook_event_mask(event: HookEventId) -> u128 {
	1_u128 << event as u32
}

/// One hook-composed admission answer and its narrowed authority envelope.
#[derive(Clone, Debug)]
pub struct InvocationAdmission {
	/// Environment admission receipt.
	pub admission: Admission,
	/// Authority no wider than the tool revision's declared maximum.
	pub effects:   Effects,
}

/// One allocation-free-negative-path handoff from an invocation to hook
/// CONTROL.
#[derive(Debug)]
pub enum InvocationHookRequest {
	/// Exact raw provider argument text, emitted before the environment document
	/// feed observes the fragment.
	ArgText {
		/// Transcript-visible invocation identity.
		invocation_id: Str,
		/// The one shared fragment clone made for subscribed hooks.
		fragment:      Str,
	},
	/// Per-invocation admission query, declared authority ceiling, and unique
	/// reply channel.
	Admission {
		/// Boxed because `AdmitInvocation` is a foreign generated prost message;
		/// one allocation is paid per hook-subscribed admission.
		query:           Box<AdmitInvocation>,
		/// Maximum authority declared by the resolved tool revision.
		maximum_effects: Effects,
		/// One-shot response consumed only by this invocation.
		reply:           flume::Sender<InvocationAdmission>,
	},
}

/// Atomic union-mask and hook request sender shared by invocation pumps.
#[derive(Clone, Debug)]
pub struct InvocationHookBus {
	union: Arc<AtomicU128>,
	tx:    flume::Sender<InvocationHookRequest>,
}

impl InvocationHookBus {
	/// Creates a hook bus and its single CONTROL-side request receiver.
	pub fn channel() -> (Self, Receiver<InvocationHookRequest>) {
		let (tx, rx) = flume::unbounded();
		(Self { union: Arc::new(AtomicU128::new(0)), tx }, rx)
	}

	/// Replaces the registered union mask in one atomic publication.
	pub fn replace_union_mask(&self, mask: u128) {
		self.union.store(mask, Ordering::Release);
	}

	/// Returns the currently published union mask.
	pub fn union_mask(&self) -> u128 {
		self.union.load(Ordering::Acquire)
	}

	fn subscribed(&self, event: HookEventId) -> bool {
		self.union.load(Ordering::Relaxed) & hook_event_mask(event) != 0
	}

	fn arg_text(&self, invocation_id: &Str, fragment: &Str) {
		if self.subscribed(HookEventId::HookEventToolCall) {
			let _ = self.tx.send(InvocationHookRequest::ArgText {
				invocation_id: invocation_id.clone(),
				fragment:      fragment.clone(),
			});
		}
	}

	async fn admit(&self, query: AdmitInvocation, maximum_effects: Effects) -> InvocationAdmission {
		let (reply, receive) = flume::bounded(1);
		let decision = if self.subscribed(HookEventId::HookEventToolCall) {
			if self
				.tx
				.send(InvocationHookRequest::Admission {
					query: Box::new(query.clone()),
					maximum_effects: maximum_effects.clone(),
					reply,
				})
				.is_ok()
			{
				receive.recv_async().await.ok()
			} else {
				None
			}
		} else {
			Some(InvocationAdmission {
				admission: allowed_admission(&query),
				effects:   maximum_effects.clone(),
			})
		};
		match decision {
			Some(mut decision) if decision.effects.is_subset_of(&maximum_effects) => {
				if !decision.admission.allow {
					decision.effects = Effects::empty();
				}
				decision
			},
			_ => {
				InvocationAdmission { admission: denied_admission(&query), effects: Effects::empty() }
			},
		}
	}
}

fn allowed_admission(query: &AdmitInvocation) -> Admission {
	Admission { invocation_id: query.invocation_id.clone(), allow: true, ..Admission::default() }
}

fn denied_admission(query: &AdmitInvocation) -> Admission {
	Admission { invocation_id: query.invocation_id.clone(), allow: false, ..Admission::default() }
}
#[derive(Clone, Debug)]
pub struct InvocationAdmissionFact {
	pub(crate) invocation_id: Str,
	pub(crate) raw:           Str,
	pub(crate) admission:     Admission,
}

enum PumpCommand {
	ArgText {
		fragment: Str,
		ack:      flume::Sender<Result<(), ClientError>>,
	},
	Authorize {
		raw:              Bytes,
		effect_token:     Bytes,
		authorized_at_ms: u64,
		effects:          Effects,
		ack:              flume::Sender<Result<AuthorizationState, ClientError>>,
	},
	Interrupt {
		reason: Str,
		ack:    flume::Sender<Result<(), ClientError>>,
	},
	Cancel {
		ack: flume::Sender<()>,
	},
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum AuthorizationState {
	Sent,
	DeliveryIndeterminate,
}

struct AuthorizationReceipt(Receiver<Result<AuthorizationState, ClientError>>);

impl AuthorizationReceipt {
	async fn wait(&self) -> Result<AuthorizationState, BatchError> {
		Ok(self
			.0
			.recv_async()
			.await
			.map_err(|_| InvocationPump::closed())??)
	}
}

struct CommandReceipt(Receiver<Result<(), ClientError>>);

impl CommandReceipt {
	async fn wait(&self) -> Result<(), BatchError> {
		self
			.0
			.recv_async()
			.await
			.map_err(|_| InvocationPump::closed())??;
		Ok(())
	}
}

mod pump_terminal {
	use omp_env::ClientError;
	use omp_proto::env::v1;

	pub(super) enum PumpTerminal {
		Verdict(v1::Verdict),
		ClientError(ClientError),
		Closed,
		CancelUnobserved,
	}
}
use pump_terminal::PumpTerminal;

enum PumpOutput {
	Update(Bytes),
	Terminal(PumpTerminal),
}

struct ToolUpdateBatch {
	latest:    Bytes,
	coalesced: u32,
}

impl ToolUpdateBatch {
	const fn new(latest: Bytes) -> Self {
		Self { latest, coalesced: 1 }
	}

	fn push(&mut self, update: Bytes) {
		self.latest = update;
		self.coalesced = self.coalesced.saturating_add(1);
	}
}

struct InterruptRequest {
	reason:       Str,
	acknowledged: flume::Sender<()>,
}

struct InvocationPump {
	commands:        flume::Sender<PumpCommand>,
	outputs:         Receiver<PumpOutput>,
	hooks:           Arc<OnceLock<InvocationHookBus>>,
	hook_gate:       Arc<OnceLock<Option<Arc<HookGate>>>>,
	maximum_effects: Arc<OnceLock<Effects>>,
	maximum_ready:   Arc<Notify>,
	admission:       Arc<OnceLock<Admission>>,
	effects:         Arc<OnceLock<Effects>>,
	facts:           Arc<OnceLock<flume::Sender<InvocationAdmissionFact>>>,
	cancelled:       Arc<AtomicBool>,
}
impl InvocationPump {
	async fn arg_text(&self, fragment: Str) -> Result<(), BatchError> {
		let (ack, reply) = flume::bounded(1);
		self.send(PumpCommand::ArgText { fragment, ack })?;
		reply.recv_async().await.map_err(|_| Self::closed())??;
		Ok(())
	}

	fn begin_authorization(
		&self,
		raw: Bytes,
		effect_token: Bytes,
		authorized_at_ms: u64,
		effects: Effects,
	) -> Result<AuthorizationReceipt, BatchError> {
		let (ack, reply) = flume::bounded(1);
		self.send(PumpCommand::Authorize { raw, effect_token, authorized_at_ms, effects, ack })?;
		Ok(AuthorizationReceipt(reply))
	}

	fn begin_interrupt(&self, reason: Str) -> Result<CommandReceipt, BatchError> {
		let (ack, reply) = flume::bounded(1);
		self.send(PumpCommand::Interrupt { reason, ack })?;
		Ok(CommandReceipt(reply))
	}

	async fn cancel(&self) -> Result<(), BatchError> {
		let (ack, reply) = flume::bounded(1);
		self.send(PumpCommand::Cancel { ack })?;
		reply.recv_async().await.map_err(|_| Self::closed())
	}

	fn send(&self, command: PumpCommand) -> Result<(), BatchError> {
		self.commands.send(command).map_err(|_| Self::closed())
	}

	const fn closed() -> BatchError {
		BatchError::Projection(Str::new_static("environment invocation pump closed"))
	}

	async fn output(&self) -> PumpOutput {
		self
			.outputs
			.recv_async()
			.await
			.unwrap_or(PumpOutput::Terminal(PumpTerminal::Closed))
	}
}

enum InterruptAction {
	Sent(Result<(), ClientError>),
	Cancel(flume::Sender<()>),
	Unsupported,
	Closed,
}

async fn handle_interrupt(
	invocation: &Invocation,
	reason: Str,
	ack: flume::Sender<Result<(), ClientError>>,
	command_rx: &Receiver<PumpCommand>,
) -> bool {
	let action = {
		let sent = invocation.interrupt(reason);
		tokio::pin!(sent);
		tokio::select! {
			result = &mut sent => InterruptAction::Sent(result),
			control = command_rx.recv_async() => match control {
				Ok(PumpCommand::Cancel { ack }) => InterruptAction::Cancel(ack),
				Ok(_) => InterruptAction::Unsupported,
				Err(_) => InterruptAction::Closed,
			},
		}
	};
	match action {
		InterruptAction::Sent(result) => {
			let failed = result.is_err();
			let _ = ack.send(result);
			failed
		},
		InterruptAction::Cancel(cancel_ack) => {
			invocation.guard().cancel();
			let _ = cancel_ack.send(());
			false
		},
		InterruptAction::Unsupported | InterruptAction::Closed => true,
	}
}

enum AuthorizationAction {
	Sent(Result<(), ClientError>),
	Control(PumpCommand),
	Closed,
}

fn spawn_invocation_pump(
	mut invocation: Invocation,
	call_id: Str,
	identity: ToolIdentity,
	events: EventBus,
) -> InvocationPump {
	let (commands, command_rx) = flume::unbounded();
	let (output_tx, outputs) = flume::unbounded();
	let hooks: Arc<OnceLock<InvocationHookBus>> = Arc::new(OnceLock::new());
	let task_hooks = Arc::clone(&hooks);
	let hook_gate: Arc<OnceLock<Option<Arc<HookGate>>>> = Arc::new(OnceLock::new());
	let task_hook_gate = Arc::clone(&hook_gate);
	let maximum_effects: Arc<OnceLock<Effects>> = Arc::new(OnceLock::new());
	let task_maximum_effects = Arc::clone(&maximum_effects);
	let maximum_ready = Arc::new(Notify::new());
	let task_maximum_ready = Arc::clone(&maximum_ready);
	let admission: Arc<OnceLock<Admission>> = Arc::new(OnceLock::new());
	let task_admission = Arc::clone(&admission);
	let effects: Arc<OnceLock<Effects>> = Arc::new(OnceLock::new());
	let task_effects = Arc::clone(&effects);
	let facts: Arc<OnceLock<flume::Sender<InvocationAdmissionFact>>> = Arc::new(OnceLock::new());
	let task_facts = Arc::clone(&facts);
	let cancelled = Arc::new(AtomicBool::new(false));
	let task_cancelled = Arc::clone(&cancelled);
	tokio::spawn(async move {
		let mut args_text = StrMut::default();
		loop {
			tokio::select! {
				command = command_rx.recv_async() => {
					let Ok(command) = command else { break };
					match command {
						PumpCommand::ArgText { fragment, ack } => {
							let fragment_start = args_text.len();
							args_text.push_str(&fragment);
							let result = invocation.arg_text(fragment).await;
							if result.is_ok() {
								let view = omp_slopjson::parse_streaming(args_text.as_str());
								events.publish(AgentEvent::ToolArgs {
									call_id: call_id.clone(),
									fragment: Bytes::copy_from_slice(
										&args_text.as_str().as_bytes()[fragment_start..],
									),
									view,
								});
							} else {
								args_text.truncate(fragment_start);
							}
							let failed = result.is_err();
							let _ = ack.send(result);
							if failed {
								break;
							}
						},
						PumpCommand::Authorize {
							raw,
							effect_token,
							authorized_at_ms,
							effects,
							ack,
						} => {
							if task_hook_gate
								.get()
								.and_then(Option::as_deref)
								.is_some_and(|gate| gate.subscribed(HookEventId::HookEventToolCall))
								&& args_text.as_str().as_bytes() != raw.as_ref()
								&& let Ok(committed) = std::str::from_utf8(&raw)
							{
								args_text.truncate(0);
								args_text.push_str(committed);
							}
							let action = {
								let sent = invocation.commit_args(
									raw,
									effect_token,
									authorized_at_ms,
									Some(EffectEnvelope::from(&effects)),
								);
								tokio::pin!(sent);
								tokio::select! {
									result = &mut sent => AuthorizationAction::Sent(result),
									control = command_rx.recv_async() => match control {
										Ok(control) => AuthorizationAction::Control(control),
										Err(_) => AuthorizationAction::Closed,
									},
								}
							};
							match action {
								AuthorizationAction::Sent(result) => {
									let result = result.map(|()| AuthorizationState::Sent);
									let failed = result.is_err();
									let _ = ack.send(result);
									if failed {
										break;
									}
								},
								AuthorizationAction::Control(command) => match command {
									PumpCommand::Interrupt { reason, ack: interrupt_ack } => {
										let _ = ack.send(Ok(AuthorizationState::DeliveryIndeterminate));
										if handle_interrupt(
											&invocation,
											reason,
											interrupt_ack,
											&command_rx,
										)
										.await
										{
											break;
										}
									},
									PumpCommand::Cancel { ack: cancel_ack } => {
										let _ = ack.send(Ok(AuthorizationState::DeliveryIndeterminate));
										invocation.guard().cancel();
										let _ = cancel_ack.send(());
									},
									command => {
										drop(command);
										drop(ack);
										break;
									},
								},
								AuthorizationAction::Closed => break,
							}
						},
						PumpCommand::Interrupt { reason, ack } => {
							if handle_interrupt(&invocation, reason, ack, &command_rx).await {
								break;
							}
						},
						PumpCommand::Cancel { ack } => {
							invocation.guard().cancel();
							let _ = ack.send(());
						},
					}
				},
				event = invocation.next_event() => {
					match event {
					Ok(Some(InvocationEvent::Accepted(_))) => {},
					Ok(Some(InvocationEvent::Admission(query))) => {
						let maximum = loop {
							if let Some(maximum) = task_maximum_effects.get() {
								break maximum.clone();
							}
							task_maximum_ready.notified().await;
						};
						let decision = match task_hook_gate.get().and_then(Option::as_deref) {
							Some(gate) => {
								let mut decision =
									gate_tool_call(gate, &query, &identity, args_text.as_str().as_bytes()).await;
								decision.effects = if decision.admission.allow { maximum } else { Effects::empty() };
								decision
							},
							None => match task_hooks.get() {
								Some(hooks) => hooks.admit(query.clone(), maximum.clone()).await,
								None => InvocationAdmission {
									admission: allowed_admission(&query),
									effects: maximum,
								},
							},
						};
						let _ = task_admission.set(decision.admission.clone());
						let _ = task_effects.set(decision.effects.clone());
						if let Some(facts) = task_facts.get() {
							let _ = facts.send(InvocationAdmissionFact {
								invocation_id: call_id.clone(),
								raw:           args_text.as_str().to_str(),
								admission:     decision.admission.clone(),
							});
						}
						task::yield_now().await;
						if task_cancelled.load(Ordering::Acquire) {
							invocation.guard().cancel();
							break;
						}
						if let Err(error) = invocation.admit(decision.admission).await {
							let _ = output_tx.send(PumpOutput::Terminal(
								PumpTerminal::ClientError(error),
							));
							break;
						}
					},
					Ok(Some(InvocationEvent::Update(update))) => {
						let json = update.json;
						events.publish(AgentEvent::ToolUpdate {
							call_id: call_id.clone(),
							json: json.clone(),
						});
						let _ = output_tx.send(PumpOutput::Update(json));
					},
					Ok(Some(InvocationEvent::Verdict(verdict))) => {
						let _ = output_tx.send(PumpOutput::Terminal(
							PumpTerminal::Verdict(verdict),
						));
						break;
					},
					Ok(None) => {
						let _ = output_tx.send(PumpOutput::Terminal(PumpTerminal::Closed));
						break;
					},
					Err(error) => {
						let _ = output_tx.send(PumpOutput::Terminal(
							PumpTerminal::ClientError(error),
						));
						break;
					},
					}
				},
			}
		}
	});
	InvocationPump {
		commands,
		outputs,
		hooks,
		hook_gate,
		maximum_effects,
		maximum_ready,
		admission,
		effects,
		facts,
		cancelled,
	}
}

/// An environment invocation opened before its model arguments are committed.
///
/// Relaying fragments may prepare environment-owned resources, but only
/// [`commit`](Self::commit) creates a call eligible to send `ArgsCommitted`.
/// Dropping this handle structurally cancels the uncommitted invocation.
pub struct SpeculativeCall {
	inner: Option<SpeculativeCallInner>,
}

struct SpeculativeCallInner {
	call_id:   Str,
	identity:  ToolIdentity,
	pump:      InvocationPump,
	events:    EventBus,
	relayed:   StrMut,
	hook_gate: Option<Arc<HookGate>>,
}

impl SpeculativeCall {
	/// Opens an environment invocation without mode metadata.
	pub async fn open(
		env: &EnvClient,
		events: &EventBus,
		call_id: Str,
		identity: ToolIdentity,
		deadline: Duration,
	) -> Result<Self, BatchError> {
		Self::open_with_props(env, events, call_id, identity, deadline, Default::default()).await
	}

	/// Opens an invocation carrying immutable environment policy metadata.
	pub async fn open_with_props(
		env: &EnvClient,
		events: &EventBus,
		call_id: Str,
		identity: ToolIdentity,
		deadline: Duration,
		props: value_pb::ValueMap,
	) -> Result<Self, BatchError> {
		let invocation = env
			.invoke(InvokeTool {
				invocation_id: call_id.to_string(),
				name:          identity.name.to_string(),
				rev:           identity.rev.to_string(),
				deadline_ms:   u64::try_from(deadline.as_millis()).unwrap_or(u64::MAX),
				props:         Some(props),
			})
			.await?;
		events.publish(AgentEvent::ToolObserved {
			call_id:            call_id.clone(),
			path:               ToolPath::new(identity.name.clone()).ok(),
			identity:           identity.clone(),
			visibility:         EventVisibility::User,
			provenance:         EventProvenance::Model,
			session_generation: events.session_generation(),
		});
		events.publish(AgentEvent::ToolOpened {
			call_id: call_id.clone(),
			name:    identity.name.clone(),
			rev:     identity.rev.clone(),
		});
		let pump =
			spawn_invocation_pump(invocation, call_id.clone(), identity.clone(), events.clone());
		Ok(Self {
			inner: Some(SpeculativeCallInner {
				call_id,
				identity,
				pump,
				events: events.clone(),
				relayed: StrMut::default(),
				hook_gate: None,
			}),
		})
	}

	/// Returns the stable model-authored call identifier.
	pub const fn call_id(&self) -> &Str {
		&self.inner.as_ref().expect("live speculative call").call_id
	}

	/// Returns the exact live tool identity selected when speculation opened.
	pub const fn identity(&self) -> &ToolIdentity {
		&self.inner.as_ref().expect("live speculative call").identity
	}

	/// Installs the loop-owned hook, authority ceiling, and durable fact bus.
	pub(crate) fn attach_runtime(
		&mut self,
		hooks: InvocationHookBus,
		facts: flume::Sender<InvocationAdmissionFact>,
		maximum_effects: Effects,
		hook_gate: Option<Arc<HookGate>>,
		turn_id: Str,
	) -> Result<(), BatchError> {
		let pump = &self.inner.as_ref().expect("live speculative call").pump;
		pump
			.hooks
			.set(hooks)
			.map_err(|_| BatchError::HookBusAlreadySet)?;
		pump
			.hook_gate
			.set(hook_gate.clone())
			.map_err(|_| BatchError::HookGateAlreadySet)?;
		pump
			.maximum_effects
			.set(maximum_effects)
			.map_err(|_| BatchError::EffectMaximumAlreadySet)?;
		pump
			.facts
			.set(facts)
			.map_err(|_| BatchError::FactBusAlreadySet)?;
		pump.maximum_ready.notify_one();
		let inner = self.inner.as_mut().expect("live speculative call");
		inner.hook_gate = hook_gate;
		notify_json(HookEventId::HookEventCallOpen, inner.hook_gate.as_deref(), || {
			serde_json::json!({
				"call_id": inner.call_id,
				"target": tool_target(&inner.identity, &[]),
				"kind": target_kind(&inner.identity),
				"turn_id": turn_id,
				"place": {"kind": "env", "name": Value::Null},
			})
		});
		Ok(())
	}

	/// Queues one provider argument fragment verbatim for the invocation owner.
	///
	/// Subscribed hooks observe the raw fragment before the environment document
	/// feed. The negative path performs one atomic load and no clone.
	pub async fn relay_fragment(&mut self, fragment: Str) -> Result<(), BatchError> {
		let inner = self.inner.as_mut().expect("live speculative call");
		if let Some(hooks) = inner.pump.hooks.get() {
			hooks.arg_text(&inner.call_id, &fragment);
		}
		inner.pump.arg_text(fragment.clone()).await?;
		inner.relayed.push_str(&fragment);
		Ok(())
	}

	/// Returns the exact concatenation of every relayed argument fragment.
	pub fn relayed_args(&self) -> &str {
		self
			.inner
			.as_ref()
			.expect("live speculative call")
			.relayed
			.as_str()
	}

	/// Cancels this uncommitted invocation and waits for its terminal.
	///
	/// The wait covers the environment's abort verdict (or stream close), so a
	/// replacement invocation may reuse the same invocation id afterwards.
	pub(crate) async fn abandon(mut self) {
		let SpeculativeCallInner { pump, .. } = self.inner.take().expect("live speculative call");
		pump.cancelled.store(true, Ordering::Release);
		if pump.cancel().await.is_err() {
			return;
		}
		while !matches!(pump.output().await, PumpOutput::Terminal(_)) {}
	}

	/// Returns the admission receipt fixed by the environment, when available.
	pub(crate) fn admission(&self) -> Option<&Admission> {
		self
			.inner
			.as_ref()
			.expect("live speculative call")
			.pump
			.admission
			.get()
	}

	/// Records the durable assistant-item commitment for this invocation.
	///
	/// This local transition performs no I/O. Effect authorization is sent only
	/// by [`ToolBatch::drive`] after the loop journals the token and timestamp.
	pub fn commit(mut self, raw_args: Bytes) -> CommittedCall {
		let effect_token = omp_core::Ulid::generate().to_string().to_str();
		let authorized_at_ms = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis()
			.try_into()
			.unwrap_or(u64::MAX);
		let SpeculativeCallInner { call_id, identity, pump, events, hook_gate, .. } =
			self.inner.take().expect("live speculative call");
		let effects = pump.effects.get().cloned().unwrap_or_default();
		CommittedCall {
			call_id,
			identity,
			raw_args,
			effect_token,
			authorized_at_ms,
			effects,
			pump,
			events,
			hook_gate,
			usage: Default::default(),
		}
	}
}

impl Drop for SpeculativeCall {
	fn drop(&mut self) {
		let Some(inner) = self.inner.as_ref() else {
			return;
		};
		inner.pump.cancelled.store(true, Ordering::Release);
		let (acknowledged, _) = flume::bounded(1);
		let _ = inner.pump.send(PumpCommand::Cancel { ack: acknowledged });
	}
}

/// An assistant-item-committed call waiting for effect authorization.
pub struct CommittedCall {
	call_id:          Str,
	identity:         ToolIdentity,
	raw_args:         Bytes,
	effect_token:     Str,
	authorized_at_ms: u64,
	effects:          Effects,
	pump:             InvocationPump,
	events:           EventBus,
	hook_gate:        Option<Arc<HookGate>>,
	usage:            v1::Usage,
}

impl CommittedCall {
	/// Returns the stable model-authored call identifier.
	pub const fn call_id(&self) -> &Str {
		&self.call_id
	}

	/// Returns the exact committed model argument bytes.
	pub const fn raw_args(&self) -> &Bytes {
		&self.raw_args
	}

	/// Returns the tool identity fixed when speculation opened.
	pub const fn identity(&self) -> &ToolIdentity {
		&self.identity
	}

	/// Returns the unforgeable token issued for this invocation's effect scope.
	pub const fn effect_token(&self) -> &Str {
		&self.effect_token
	}

	/// Returns the epoch-millisecond effect-authorization timestamp.
	pub const fn authorized_at_ms(&self) -> u64 {
		self.authorized_at_ms
	}

	/// Returns the exact Core-narrowed authority envelope.
	pub const fn effects(&self) -> &Effects {
		&self.effects
	}

	/// Attaches the cumulative usage receipt observed before tool execution.
	pub fn set_cumulative_usage(&mut self, usage: v1::Usage) {
		self.usage = usage;
	}
}

/// One exact serialized tool update emitted while a batch call is live.
#[derive(Clone, Debug)]
pub struct BatchUpdate {
	pub(crate) call_id:  Str,
	pub(crate) identity: ToolIdentity,
	pub(crate) json:     Bytes,
}

/// One ordered batch completion shared with the event feed.
#[derive(Clone)]
pub struct BatchResult {
	event:     Arc<AgentEvent>,
	job:       Option<JobRef>,
	outcome:   Option<CallOutcome<CallOutcomeDetails, CallOutcomeDetails>>,
	identity:  ToolIdentity,
	raw_args:  Bytes,
	terminate: bool,
}

impl BatchResult {
	/// Borrows the canonical result item carried by this completion's event.
	pub fn item(&self) -> &Item {
		match self.event.as_ref() {
			AgentEvent::ToolFinished { item, .. } => item,
			_ => unreachable!("batch results only retain ToolFinished events"),
		}
	}

	/// Returns the transcript-visible invocation identity.
	pub fn call_id(&self) -> &Str {
		match self.event.as_ref() {
			AgentEvent::ToolFinished { call_id, .. } => call_id,
			_ => unreachable!("batch results only retain ToolFinished events"),
		}
	}

	/// Borrows the already-published immutable result event.
	pub const fn event(&self) -> &Arc<AgentEvent> {
		&self.event
	}

	/// Returns detached job ownership when work outlives the turn.
	pub const fn job(&self) -> Option<&JobRef> {
		self.job.as_ref()
	}

	/// Borrows the canonical four-arm durable outcome fixed at settlement.
	pub const fn outcome(&self) -> Option<&CallOutcome<CallOutcomeDetails, CallOutcomeDetails>> {
		self.outcome.as_ref()
	}

	/// Returns the resolved tool identity for hook projection.
	pub(crate) const fn identity(&self) -> &ToolIdentity {
		&self.identity
	}

	/// Returns the exact committed arguments for hook projection.
	pub(crate) const fn raw_args(&self) -> &Bytes {
		&self.raw_args
	}

	/// Takes detached job ownership for registration with the job board.
	pub fn into_job(self) -> Option<JobRef> {
		self.job
	}

	/// Returns whether this completion transferred work to the job board.
	pub const fn is_detached(&self) -> bool {
		self.job.is_some()
	}

	/// Returns whether this finalized result opts in to ending the tool loop.
	pub const fn terminate(&self) -> bool {
		self.terminate
	}
}

/// A set of committed calls driven under their declared mode and returned in
/// issued order.
pub struct ToolBatch {
	calls: Vec<CommittedCall>,
}

impl ToolBatch {
	/// Creates a batch in model-issued order.
	pub const fn new(calls: Vec<CommittedCall>) -> Self {
		Self { calls }
	}

	/// Returns the number of calls in the batch.
	pub const fn len(&self) -> usize {
		self.calls.len()
	}

	/// Returns whether the batch contains no calls.
	pub const fn is_empty(&self) -> bool {
		self.calls.is_empty()
	}

	/// Sends effect authorizations concurrently unless one declaration requires
	/// issued-order execution.
	///
	/// Results remain in issued order. Once a call is authorized, environment
	/// or lowering failures become canonical `EffectsUnknown` results so every
	/// committed call remains journalable and peer truth is never discarded.
	pub async fn drive(self, registry: &Registry, caps: &CapsBase) -> Vec<BatchResult> {
		self
			.drive_inner(registry, caps, None, Duration::ZERO, None)
			.await
	}
}

mod interruptible {
	use futures::future::join_all;
	use omp_proto::env::v1;
	use tokio::sync::watch::Receiver;

	use super::*;
	pub(super) struct InterruptTarget {
		pub(super) sender: flume::Sender<InterruptRequest>,
	}

	impl ToolBatch {
		/// Drives the batch with one watch-broadcast cooperative interrupt
		/// source.
		pub async fn drive_interruptible(
			self,
			registry: &Registry,
			caps: &CapsBase,
			interrupt: Receiver<Option<Str>>,
			grace: Duration,
		) -> Vec<BatchResult> {
			self
				.drive_inner(registry, caps, Some(interrupt), grace, None)
				.await
		}

		/// Drives an interruptible batch while forwarding each queued update
		/// once.
		pub(crate) async fn drive_streaming(
			self,
			registry: &Registry,
			caps: &CapsBase,
			interrupt: Receiver<Option<Str>>,
			grace: Duration,
			updates: flume::Sender<BatchUpdate>,
		) -> Vec<BatchResult> {
			self
				.drive_inner(registry, caps, Some(interrupt), grace, Some(updates))
				.await
		}

		pub(super) async fn drive_inner(
			self,
			registry: &Registry,
			caps: &CapsBase,
			mut interrupt: Option<Receiver<Option<Str>>>,
			grace: Duration,
			updates: Option<flume::Sender<BatchUpdate>>,
		) -> Vec<BatchResult> {
			if let Some(reason) = interrupt
				.as_mut()
				.and_then(|receiver| receiver.borrow_and_update().clone())
			{
				let reason = format!("interrupted before execution: {reason}").to_str();
				return self
					.calls
					.iter()
					.map(|call| lower_abort_total(call, Abort::Skipped { reason: reason.clone() }))
					.collect();
			}

			let mut interrupt_senders = Vec::with_capacity(self.calls.len());
			let sequential =
				batch_execution_mode(self.calls.iter().map(CommittedCall::identity), registry)
					== ExecutionMode::Sequential;
			let mut calls = Vec::with_capacity(self.calls.len());
			for (index, call) in self.calls.into_iter().enumerate() {
				let force_after_grace = !effects_mutate_environment(call.effects());
				let (interrupt_tx, interrupt_rx) = flume::bounded(1);
				interrupt_senders.push(InterruptTarget { sender: interrupt_tx });
				calls.push((index, call, interrupt_rx, force_after_grace));
			}

			let drive = drive_calls(calls, registry, caps, grace, updates, sequential);
			let results = if let Some(mut interrupt) = interrupt {
				let coordinate = coordinate_interrupts(&mut interrupt, &interrupt_senders, grace);
				tokio::pin!(drive, coordinate);
				tokio::select! {
					results = &mut drive => results,
					() = &mut coordinate => drive.await,
				}
			} else {
				drive.await
			};
			results.into_iter().map(|(_, result)| result).collect()
		}
	}

	async fn drive_calls(
		calls: Vec<(usize, CommittedCall, flume::Receiver<InterruptRequest>, bool)>,
		registry: &Registry,
		caps: &CapsBase,
		grace: Duration,
		updates: Option<flume::Sender<BatchUpdate>>,
		sequential: bool,
	) -> Vec<(usize, BatchResult)> {
		if sequential {
			let mut results = Vec::with_capacity(calls.len());
			for (index, call, interrupt, force_after_grace) in calls {
				results.push(
					run_call(
						index,
						call,
						registry,
						caps,
						interrupt,
						grace,
						force_after_grace,
						updates.clone(),
					)
					.await,
				);
			}
			results
		} else {
			join_all(
				calls
					.into_iter()
					.map(|(index, call, interrupt, force_after_grace)| {
						run_call(
							index,
							call,
							registry,
							caps,
							interrupt,
							grace,
							force_after_grace,
							updates.clone(),
						)
					}),
			)
			.await
		}
	}

	pub(super) async fn coordinate_interrupts(
		source: &mut Receiver<Option<Str>>,
		targets: &[InterruptTarget],
		grace: Duration,
	) {
		let reason = wait_for_interrupt(source).await;
		let acknowledgements = join_all(targets.iter().map(|target| {
			let reason = reason.clone();
			async move {
				let (acknowledged, acknowledgement) = flume::bounded(1);
				target
					.sender
					.send_async(InterruptRequest { reason, acknowledged })
					.await
					.ok()
					.map(|()| acknowledgement)
			}
		}))
		.await;
		let waits = acknowledgements
			.into_iter()
			.flatten()
			.map(|acknowledgement| async move {
				if grace.is_zero() {
					task::yield_now().await;
				} else {
					let _ = time::timeout(grace, acknowledgement.recv_async()).await;
				}
			});
		join_all(waits).await;
	}

	async fn wait_for_interrupt(receiver: &mut Receiver<Option<Str>>) -> Str {
		loop {
			let reason = receiver.borrow_and_update().clone();
			if let Some(reason) = reason {
				return reason;
			}
			if receiver.changed().await.is_err() {
				future::pending::<()>().await;
			}
		}
	}

	pub(super) fn lower_verdict(
		call: &CommittedCall,
		registry: &Registry,
		caps: CapsBase,
		wire: v1::Verdict,
	) -> Result<BatchResult, BatchError> {
		if let Ok(ToolTerminal::Detached(job)) =
			serde_json::from_slice::<ToolTerminal<Value, Value>>(&wire.json)
		{
			return lower_detached(call, wire.json, job);
		}

		let outcome = serde_json::from_slice::<CallOutcome<Value, Value>>(&wire.json)
			.map_err(BatchError::InvalidOutcome)?;
		let durable = durable_outcome(&wire.json, &outcome);
		let is_error = !matches!(outcome, CallOutcome::Ok(_));
		let terminate = wire.terminate.unwrap_or(false);
		let mut result = if let Some(parts) = harness_parts(&outcome) {
			lower_tool_parts(call, &wire.json, is_error, wire.useless, &parts)?
		} else {
			let caps = PromptCaps::for_tool(caps, &call.identity.rev);
			match registry.prompt(&call.identity, &wire.json, &caps) {
				Ok(Some(parts)) => lower_tool_parts(call, &wire.json, is_error, wire.useless, &parts)?,
				Ok(None) => {
					unreachable!("harness outcome branches were handled before registry projection")
				},
				Err(_) => lower_canonical_parts(call, &wire.json, is_error, wire.useless, wire.parts)?,
			}
		};
		result.outcome = Some(durable);
		result.terminate = terminate;
		Ok(result)
	}
}
use interruptible::lower_verdict;

async fn run_call(
	index: usize,
	call: CommittedCall,
	registry: &Registry,
	caps: &CapsBase,
	interrupt: Receiver<InterruptRequest>,
	grace: Duration,
	force_after_grace: bool,
	updates: Option<flume::Sender<BatchUpdate>>,
) -> (usize, BatchResult) {
	let started = Instant::now();
	notify_json(HookEventId::HookEventToolExecutionStart, call.hook_gate.as_deref(), || {
		serde_json::json!({
			"call_id": call.call_id,
			"invocation_id": call.call_id,
			"target": tool_target(&call.identity, &call.raw_args),
			"place": {"kind": "env", "name": Value::Null},
			"deadline": Value::Null,
		})
	});
	let receipt = match call.pump.begin_authorization(
		call.raw_args.clone(),
		Bytes::copy_from_slice(call.effect_token.as_bytes()),
		call.authorized_at_ms,
		call.effects.clone(),
	) {
		Ok(receipt) => receipt,
		Err(error) => {
			let reason = format!("effect authorization delivery failed: {error}").to_str();
			return (index, lower_abort_total(&call, Abort::EffectsUnknown { reason }));
		},
	};
	let mut pending_interrupt = None;
	let mut terminal_during_authorization = None;
	let mut authorization_failure = None;
	let authorization = tokio::select! {
		biased;
		request = wait_for_ordered_interrupt(&interrupt) => {
			match call.pump.begin_interrupt(request.reason) {
				Ok(interrupt_receipt) => {
					pending_interrupt = Some((interrupt_receipt, request.acknowledged));
					receipt.wait().await
				},
				Err(error) => {
					drop(request.acknowledged);
					authorization_failure =
						Some(format!("failed to interrupt pending authorization: {error}").to_str());
					terminal_during_authorization =
						Some(drain_pump(&call, updates.as_ref()).await);
					Ok(AuthorizationState::DeliveryIndeterminate)
				},
			}
		},
		result = receipt.wait() => result,
	};
	let authorization_indeterminate = match authorization {
		Ok(AuthorizationState::Sent) => false,
		Ok(AuthorizationState::DeliveryIndeterminate) => true,
		Err(error) => {
			authorization_failure =
				Some(format!("effect authorization delivery failed: {error}").to_str());
			terminal_during_authorization = Some(drain_pump(&call, updates.as_ref()).await);
			true
		},
	};

	let terminal = if let Some(terminal) = terminal_during_authorization {
		terminal
	} else if let Some((receipt, acknowledged)) = pending_interrupt {
		finish_interrupt_with_grace(
			&call,
			updates.as_ref(),
			receipt,
			acknowledged,
			grace,
			force_after_grace,
		)
		.await
	} else {
		tokio::select! {
			biased;
			request = wait_for_ordered_interrupt(&interrupt) => {
				interrupt_pump_with_grace(
					&call,
					updates.as_ref(),
					request,
					grace,
					force_after_grace,
				)
				.await
			},
			terminal = drain_pump(&call, updates.as_ref()) => terminal,
		}
	};
	let result = match terminal {
		PumpTerminal::Verdict(verdict) => lower_verdict(&call, registry, *caps, verdict)
			.unwrap_or_else(|error| {
				lower_abort_total(&call, Abort::EffectsUnknown {
					reason: format!("failed to lower environment verdict: {error}").to_str(),
				})
			}),
		PumpTerminal::Closed => {
			if let Some(reason) = authorization_failure {
				lower_abort_total(&call, Abort::EffectsUnknown { reason })
			} else if authorization_indeterminate {
				lower_abort_total(&call, Abort::EffectsUnknown {
					reason: sf!(
						"effect authorization delivery became indeterminate during interruption",
					),
				})
			} else {
				lower_abort_total(&call, Abort::MissingOutcome)
			}
		},
		PumpTerminal::CancelUnobserved => lower_abort_total(&call, Abort::EffectsUnknown {
			reason: sf!("environment owner did not report terminal truth after cancellation",),
		}),
		PumpTerminal::ClientError(error) => lower_abort_total(&call, Abort::EffectsUnknown {
			reason: format!("environment invocation failed: {error}").to_str(),
		}),
	};
	let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
	let (spilled, artifact) = outcome_storage(result.outcome());
	notify_json(HookEventId::HookEventToolExecutionEnd, call.hook_gate.as_deref(), || {
		serde_json::json!({
			"call_id": call.call_id,
			"target": tool_target(&call.identity, &call.raw_args),
			"outcome": outcome_kind(result.outcome()),
			"duration": format!("{duration_ms}ms"),
			"spilled": spilled,
			"artifact": artifact,
			"effects_unknown": outcome_effects_unknown(result.outcome()),
		})
	});
	(index, result)
}

async fn drain_pump(
	call: &CommittedCall,
	updates: Option<&flume::Sender<BatchUpdate>>,
) -> PumpTerminal {
	loop {
		match call.pump.output().await {
			PumpOutput::Update(json) => {
				if let Some(updates) = updates {
					let _ = updates.send(BatchUpdate {
						call_id:  call.call_id.clone(),
						identity: call.identity.clone(),
						json:     json.clone(),
					});
				}
				let Some(gate) = call
					.hook_gate
					.as_deref()
					.filter(|gate| gate.subscribed(HookEventId::HookEventToolUpdate))
				else {
					continue;
				};
				let mut batch = ToolUpdateBatch::new(json);
				let mut terminal = None;
				time::sleep(Duration::from_millis(16)).await;
				while let Ok(output) = call.pump.outputs.try_recv() {
					match output {
						PumpOutput::Update(json) => {
							if let Some(updates) = updates {
								let _ = updates.send(BatchUpdate {
									call_id:  call.call_id.clone(),
									identity: call.identity.clone(),
									json:     json.clone(),
								});
							}
							batch.push(json);
						},
						PumpOutput::Terminal(value) => {
							terminal = Some(value);
							break;
						},
					}
				}
				notify_json(HookEventId::HookEventToolUpdate, Some(gate), || {
					serde_json::json!({
						"call_id": call.call_id,
						"target": tool_target(&call.identity, &call.raw_args),
						"update": serde_json::from_slice::<Value>(&batch.latest)
							.unwrap_or(Value::Null),
						"coalesced": batch.coalesced,
					})
				});
				if let Some(terminal) = terminal {
					return terminal;
				}
			},
			PumpOutput::Terminal(terminal) => return terminal,
		}
	}
}

async fn interrupt_pump_with_grace(
	call: &CommittedCall,
	updates: Option<&flume::Sender<BatchUpdate>>,
	request: InterruptRequest,
	grace: Duration,
	force_after_grace: bool,
) -> PumpTerminal {
	let Ok(receipt) = call.pump.begin_interrupt(request.reason) else {
		drop(request.acknowledged);
		return if force_after_grace {
			force_cancel_with_grace(call, updates, grace).await
		} else {
			drain_pump(call, updates).await
		};
	};
	finish_interrupt_with_grace(
		call,
		updates,
		receipt,
		request.acknowledged,
		grace,
		force_after_grace,
	)
	.await
}

async fn finish_interrupt_with_grace(
	call: &CommittedCall,
	updates: Option<&flume::Sender<BatchUpdate>>,
	receipt: CommandReceipt,
	acknowledged: flume::Sender<()>,
	grace: Duration,
	force_after_grace: bool,
) -> PumpTerminal {
	let cooperative = async {
		let result = receipt.wait().await;
		let _ = acknowledged.send(());
		result?;
		Ok::<_, BatchError>(drain_pump(call, updates).await)
	};
	if force_after_grace {
		match time::timeout(grace, cooperative).await {
			Ok(Ok(terminal)) => terminal,
			Ok(Err(_)) | Err(_) => force_cancel_with_grace(call, updates, grace).await,
		}
	} else {
		match cooperative.await {
			Ok(terminal) => terminal,
			Err(_) => drain_pump(call, updates).await,
		}
	}
}

async fn force_cancel_with_grace(
	call: &CommittedCall,
	updates: Option<&flume::Sender<BatchUpdate>>,
	grace: Duration,
) -> PumpTerminal {
	let forced = async {
		let _ = call.pump.cancel().await;
		drain_pump(call, updates).await
	};
	match time::timeout(grace, forced).await {
		Ok(PumpTerminal::Verdict(verdict)) => PumpTerminal::Verdict(verdict),
		Ok(PumpTerminal::ClientError(error)) => PumpTerminal::ClientError(error),
		Ok(PumpTerminal::Closed | PumpTerminal::CancelUnobserved) | Err(_) => {
			PumpTerminal::CancelUnobserved
		},
	}
}

async fn wait_for_ordered_interrupt(receiver: &Receiver<InterruptRequest>) -> InterruptRequest {
	match receiver.recv_async().await {
		Ok(request) => request,
		Err(_) => future::pending().await,
	}
}

fn lower_detached(
	call: &CommittedCall,
	raw: Bytes,
	job: JobRef,
) -> Result<BatchResult, BatchError> {
	let text =
		format!("job started; artifact will land at job://{} ({})", job.id, job.artifact.description)
			.to_str();
	let parts = [Part::Text { text }];
	let item = tool_result_item(0, &call.call_id, &call.identity, &raw, false, false, &parts)
		.map_err(|error| BatchError::Projection(error.to_string().to_str()))?;
	let event = finish_event(call, item);
	Ok(BatchResult {
		event,
		job: Some(job),
		outcome: None,
		identity: call.identity.clone(),
		raw_args: call.raw_args.clone(),
		terminate: false,
	})
}

fn lower_abort(call: &CommittedCall, abort: Abort) -> Result<BatchResult, BatchError> {
	let outcome = CallOutcome::<Value, Value>::aborted(abort);
	let raw = Bytes::from(serde_json::to_vec(&outcome).map_err(BatchError::InvalidOutcome)?);
	let parts = harness_parts(&outcome).expect("aborted outcome always uses the harness renderer");
	let mut result = lower_tool_parts(call, &raw, true, false, &parts)?;
	result.outcome = Some(durable_outcome(&raw, &outcome));
	Ok(result)
}

fn lower_abort_total(call: &CommittedCall, abort: Abort) -> BatchResult {
	lower_abort(call, abort)
		.expect("harness-owned Aborted verdict serialization and canonical lowering are infallible")
}

fn lower_tool_parts(
	call: &CommittedCall,
	verdict: &[u8],
	is_error: bool,
	useless: bool,
	parts: &[Part],
) -> Result<BatchResult, BatchError> {
	let item = tool_result_item(0, &call.call_id, &call.identity, verdict, is_error, useless, parts)
		.map_err(|error| BatchError::Projection(error.to_string().to_str()))?;
	Ok(BatchResult {
		event:     finish_event(call, item),
		job:       None,
		outcome:   None,
		identity:  call.identity.clone(),
		raw_args:  call.raw_args.clone(),
		terminate: false,
	})
}

fn lower_canonical_parts(
	call: &CommittedCall,
	verdict: &[u8],
	is_error: bool,
	useless: bool,
	parts: Vec<CanonicalPart>,
) -> Result<BatchResult, BatchError> {
	let item = tool_result_item_canonical_parts(
		0,
		&call.call_id,
		&call.identity,
		verdict,
		is_error,
		useless,
		parts,
	)
	.map_err(|error| BatchError::Projection(error.to_string().to_str()))?;
	Ok(BatchResult {
		event:     finish_event(call, item),
		job:       None,
		outcome:   None,
		identity:  call.identity.clone(),
		raw_args:  call.raw_args.clone(),
		terminate: false,
	})
}

fn durable_outcome(
	raw: &Bytes,
	outcome: &CallOutcome<Value, Value>,
) -> CallOutcome<CallOutcomeDetails, CallOutcomeDetails> {
	let details = || CallOutcomeDetails::Inline { json: raw.clone() };
	match outcome {
		CallOutcome::Ok(_) => CallOutcome::Ok(details()),
		CallOutcome::Faulted(_) => CallOutcome::Faulted(details()),
		CallOutcome::ArgsRejected(issue) => CallOutcome::ArgsRejected(issue.clone()),
		CallOutcome::Aborted { abort, kind, policy } => {
			CallOutcome::Aborted { abort: abort.clone(), kind: *kind, policy: policy.clone() }
		},
	}
}

fn finish_event(call: &CommittedCall, item: Item) -> Arc<AgentEvent> {
	call.events.publish(AgentEvent::ToolFinished {
		call_id: call.call_id.clone(),
		item,
		usage: call.usage.clone(),
	})
}

fn harness_parts(outcome: &CallOutcome<Value, Value>) -> Option<Vec<Part>> {
	let text = match outcome {
		CallOutcome::ArgsRejected(issue) => render_arg_issue(issue),
		CallOutcome::Aborted { abort, policy: Some(policy), .. } => {
			render_policy_denied(abort, policy)
		},
		CallOutcome::Aborted { abort, policy: None, .. } => render_abort(abort),
		CallOutcome::Ok(_) | CallOutcome::Faulted(_) => return None,
	};
	Some(vec![Part::Text { text }])
}

fn render_arg_issue(issue: &ArgIssue) -> Str {
	let mut path = String::from("$");
	for segment in &issue.path {
		match segment {
			ArgPath::Key(key) => {
				path.push('[');
				path.push_str(&serde_json::to_string(key.as_str()).unwrap_or_else(|_| "\"?\"".into()));
				path.push(']');
			},
			ArgPath::Index(index) => {
				path.push('[');
				path.push_str(&index.to_string());
				path.push(']');
			},
		}
	}
	let kind_json = serde_json::to_string(&issue.kind)
		.expect("serializing a fieldless argument issue kind cannot fail");
	let kind = kind_json.trim_matches('"');
	let mut text = format!("invalid arguments at {path}: expected {} ({kind})", issue.expected);
	if let Some(found) = &issue.found {
		text.push_str("; found ");
		text.push_str(found);
	}
	if let Some(example) = &issue.example {
		text.push_str("; example ");
		text.push_str(example);
	}
	text.to_str()
}

fn render_abort(abort: &Abort) -> Str {
	match abort {
		Abort::Skipped { reason } => format!("skipped: {reason}").to_str(),
		Abort::Interrupted { reason } => format!("interrupted: {reason}").to_str(),
		Abort::EffectsUnknown { reason } => {
			format!("aborted with effects unknown: {reason}").to_str()
		},
		Abort::InputDropped => sf!("aborted: invocation input dropped before commit"),
		Abort::MissingOutcome => {
			sf!("aborted: executor ended without a terminal outcome")
		},
	}
}

fn render_policy_denied(abort: &Abort, policy: &omp_tool::PolicyDenied) -> Str {
	use std::fmt::Write as _;

	let mut text = render_abort(abort).to_string();
	if let Some(code) = &policy.code {
		let _ = write!(text, "\nPolicy code: {code}");
	}
	if !policy.rules.is_empty() {
		text.push_str("\nPolicy rules: ");
		for (index, rule) in policy.rules.iter().enumerate() {
			if index != 0 {
				text.push_str(", ");
			}
			text.push_str(rule);
		}
	}
	Str::from(text)
}

#[cfg(test)]
mod tests {
	use std::collections::HashMap;

	use omp_env::frame::{self, client_frame, server_frame};
	use omp_proto::thread::v1::{Part as ThreadPart, item, part};
	use omp_tool::{ArgIssueKind, ModelClass, Rev};
	use tokio::sync::watch;

	use super::*;

	fn identity(name: &'static str) -> ToolIdentity {
		ToolIdentity { name: sf!(name), rev: Rev { family: sf!("test"), n: 1 } }
	}

	fn caps() -> CapsBase {
		CapsBase {
			maximum_parts:      8,
			maximum_text_bytes: 4096,
			media:              false,
			model_class:        ModelClass::Standard,
		}
	}

	#[test]
	fn serial_worker_declaration_forces_batch_execution_mode() {
		let spec = |name: &str| omp_tool::ToolSpec {
			name:            Str::from(name),
			rev:             Rev { family: sf!("test"), n: 1 },
			description:     sf!("batch mode contract"),
			schema:          Bytes::from_static(br#"{"type":"object","additionalProperties":false}"#),
			constraint:      omp_tool::Constraint::None,
			effects:         Effects::default(),
			projection_code: [3; 32],
		};
		let claims = omp_tool::Claims {
			precedence: omp_tool::Precedence::DEFAULT,
			claimant:   sf!("batch.contract"),
			replaces:   None,
		};
		let mut registry = Registry::new();
		registry
			.register_worker_with_mode(
				spec("parallel_tool"),
				omp_tool::Presentation::Device,
				claims.clone(),
				ExecutionMode::Parallel,
			)
			.expect("register parallel worker");
		registry
			.register_worker_with_mode(
				spec("serial_tool"),
				omp_tool::Presentation::Device,
				claims,
				ExecutionMode::Sequential,
			)
			.expect("register serial worker");
		let parallel = identity("parallel_tool");
		let serial = identity("serial_tool");
		assert_eq!(batch_execution_mode([&parallel], &registry), ExecutionMode::Parallel);
		assert_eq!(batch_execution_mode([&parallel, &serial], &registry), ExecutionMode::Sequential);
	}

	#[test]
	fn tool_update_batch_keeps_latest_payload_and_raw_count() {
		let mut batch = ToolUpdateBatch::new(Bytes::from_static(br#"{"step":1}"#));
		batch.push(Bytes::from_static(br#"{"step":2}"#));
		assert_eq!(batch.latest, Bytes::from_static(br#"{"step":2}"#));
		assert_eq!(batch.coalesced, 2);
	}

	#[test]
	fn policy_denial_prompt_includes_code_and_rules() {
		let outcome = CallOutcome::<Value, Value>::policy_denied(
			Abort::Skipped { reason: sf!("blocked") },
			omp_tool::PolicyDenied {
				reason:      sf!("blocked"),
				code:        Some(sf!("qa_policy_deny")),
				decision_id: sf!("decision"),
				rules:       Arc::from([sf!("qa-approval-rule")]),
			},
		);
		let parts = harness_parts(&outcome).expect("policy denial has harness text");
		let Part::Text { text } = &parts[0] else {
			panic!("policy denial must render as text");
		};
		assert!(text.contains("qa_policy_deny"));
		assert!(text.contains("qa-approval-rule"));
	}

	fn terminal_text(result: &BatchResult) -> &str {
		let Some(item::Kind::ToolResult(result)) = result.item().kind.as_ref() else {
			panic!("batch completion was not a ToolResult");
		};
		let Some(ThreadPart { kind: Some(part::Kind::Text(text)) }) = result.parts.first() else {
			panic!("tool result did not contain text");
		};
		text
	}

	#[test]
	fn hook_mask_zero_path_does_not_clone_or_enqueue_argument_text() {
		let (bus, requests) = InvocationHookBus::channel();
		let invocation_id = sf!("call");
		let fragment = sf!("{{\"value\":");
		bus.arg_text(&invocation_id, &fragment);
		assert!(requests.try_recv().is_err());

		bus.replace_union_mask(hook_event_mask(HookEventId::HookEventToolCall));
		bus.arg_text(&invocation_id, &fragment);
		assert!(matches!(
			requests.try_recv(),
			Ok(InvocationHookRequest::ArgText {
				invocation_id: actual_id,
				fragment: actual_fragment,
			}) if actual_id == invocation_id && actual_fragment == fragment
		));
	}

	#[tokio::test]
	async fn tool_call_gate_denies_and_transforms_before_environment_admission() {
		let query =
			AdmitInvocation { invocation_id: String::from("hooked"), ..AdmitInvocation::default() };
		let tool = identity("bash");
		let (deny_gate, deny_dispatches) = HookGate::delegated_channel();
		deny_gate.replace_union_mask(hook_event_mask(HookEventId::HookEventToolCall));
		let deny_driver = async {
			let dispatch = deny_dispatches.recv_async().await.expect("deny dispatch");
			deny_gate
				.answer(dispatch.dispatch_id, vec![(
					0,
					crate::hooks::GateDecision::Deny(sf!("blocked by hook")),
				)])
				.expect("answer deny");
		};
		let (denied, ()) = tokio::join!(
			gate_tool_call(&deny_gate, &query, &tool, br#"{"command":"original"}"#),
			deny_driver,
		);
		assert!(!denied.admission.allow);
		assert_eq!(
			denied
				.admission
				.denied
				.as_ref()
				.map(|denial| denial.reason.as_str()),
			Some("blocked by hook"),
		);

		let (modify_gate, modify_dispatches) = HookGate::delegated_channel();
		modify_gate.replace_union_mask(hook_event_mask(HookEventId::HookEventToolCall));
		let modify_driver = async {
			let dispatch = modify_dispatches
				.recv_async()
				.await
				.expect("modify dispatch");
			let separator = dispatch
				.payload
				.iter()
				.position(|byte| *byte == b'\n')
				.expect("gate event separator");
			let mut payload =
				serde_json::from_slice::<Value>(&dispatch.payload[separator + 1..]).expect("payload");
			payload["args"]["command"] = Value::String(String::from("modified"));
			modify_gate
				.answer(dispatch.dispatch_id, vec![(
					0,
					crate::hooks::GateDecision::Modify(crate::hooks::HookPatch {
						target: None,
						args:   Some(Bytes::from(
							serde_json::to_vec(&payload).expect("modified payload"),
						)),
					}),
				)])
				.expect("answer modify");
		};
		let (modified, ()) = tokio::join!(
			gate_tool_call(&modify_gate, &query, &tool, br#"{"command":"original"}"#),
			modify_driver,
		);
		assert!(modified.admission.allow);
		assert_eq!(
			serde_json::from_slice::<Value>(&modified.admission.args_patch).expect("argument patch")
				["command"],
			"modified",
		);
	}

	#[tokio::test]
	async fn admission_hooks_cannot_widen_declared_effects() {
		let (bus, requests) = InvocationHookBus::channel();
		bus.replace_union_mask(hook_event_mask(HookEventId::HookEventToolCall));
		let maximum = Effects { subagents: 1, ..Effects::empty() };
		let query = AdmitInvocation { invocation_id: "effects".into(), ..AdmitInvocation::default() };
		let answer = bus.admit(query, maximum.clone());
		let responder = async {
			let InvocationHookRequest::Admission { maximum_effects, reply, .. } =
				requests.recv_async().await.expect("admission request")
			else {
				panic!("expected admission request");
			};
			assert_eq!(maximum_effects, maximum);
			reply
				.send(InvocationAdmission {
					admission: Admission {
						invocation_id: "effects".into(),
						allow: true,
						..Admission::default()
					},
					effects:   Effects { subagents: 2, ..Effects::empty() },
				})
				.expect("admission reply");
		};
		let (decision, ()) = tokio::join!(answer, responder);
		assert!(!decision.admission.allow);
		assert!(decision.effects.is_empty());
	}

	#[test]
	fn durable_outcome_preserves_all_four_terminal_arms() {
		let issue = ArgIssue {
			path:     Vec::new(),
			expected: sf!("object"),
			kind:     ArgIssueKind::Malformed,
			example:  None,
			found:    None,
		};
		let outcomes = [
			CallOutcome::Ok(Value::Null),
			CallOutcome::Faulted(Value::Null),
			CallOutcome::ArgsRejected(issue),
			CallOutcome::aborted(Abort::InputDropped),
		];
		for outcome in outcomes {
			let raw = Bytes::from(serde_json::to_vec(&outcome).expect("serialize outcome"));
			let durable = durable_outcome(&raw, &outcome);
			assert!(matches!(
				(&outcome, durable),
				(CallOutcome::Ok(_), CallOutcome::Ok(_))
					| (CallOutcome::Faulted(_), CallOutcome::Faulted(_))
					| (CallOutcome::ArgsRejected(_), CallOutcome::ArgsRejected(_))
					| (CallOutcome::Aborted { .. }, CallOutcome::Aborted { .. })
			));
		}
	}

	#[tokio::test]
	async fn two_calls_preserve_order_and_malformed_terminal_becomes_effects_unknown() {
		let (client, transport) = EnvClient::in_process(0);
		let (requests, responses) = transport.into_parts();
		let server = tokio::spawn(async move {
			let mut opened = HashMap::new();
			while opened.len() < 2 {
				let frame = requests.recv_async().await.expect("invoke frame");
				let Some(client_frame::Body::InvokeTool(invoke)) = frame.body else {
					continue;
				};
				opened.insert(invoke.invocation_id, frame.request_id);
			}
			let mut committed = HashMap::new();
			while committed.len() < 2 {
				let frame = requests.recv_async().await.expect("commit frame");
				let Some(client_frame::Body::ArgsCommitted(commit)) = frame.body else {
					continue;
				};
				assert!(commit.effects.is_some(), "authorization must carry an explicit envelope");
				committed.insert(commit.invocation_id, frame.request_id);
			}
			let second = committed["second"];
			responses
				.send_async(frame::ServerFrame {
					request_id: second,
					body: Some(server_frame::Body::Verdict(frame::Verdict {
						invocation_id: "second".into(),
						json: Bytes::from_static(b"not-json"),
						..Default::default()
					})),
					..Default::default()
				})
				.await
				.expect("malformed verdict");
			let first = committed["first"];
			responses
				.send_async(frame::ServerFrame {
					request_id: first,
					body: Some(server_frame::Body::Verdict(frame::Verdict {
						invocation_id: "first".into(),
						json: Bytes::from_static(br#"{"kind":"ok","value":{"answer":1}}"#),
						parts: vec![ThreadPart { kind: Some(part::Kind::Text("one".into())) }],
						terminate: Some(true),
						..Default::default()
					})),
					..Default::default()
				})
				.await
				.expect("valid verdict");
		});
		let events = EventBus::new();
		let observed = events.subscribe_lossless();
		let first = SpeculativeCall::open(
			&client,
			&events,
			sf!("first"),
			identity("first_tool"),
			Duration::from_secs(1),
		)
		.await
		.expect("open first");
		let second = SpeculativeCall::open(
			&client,
			&events,
			sf!("second"),
			identity("second_tool"),
			Duration::from_secs(1),
		)
		.await
		.expect("open second");
		let results = ToolBatch::new(vec![
			first.commit(Bytes::from_static(b"{}")),
			second.commit(Bytes::from_static(b"{}")),
		])
		.drive(&Registry::new(), &caps())
		.await;
		server.await.expect("scripted env task");

		assert_eq!(results.len(), 2);
		assert_eq!(terminal_text(&results[0]), "one");
		assert!(results[0].terminate());
		assert!(!results[1].terminate());
		assert!(terminal_text(&results[1]).contains("failed to lower environment verdict"));
		let mut finished = 0;
		while let Ok(event) = observed.try_recv() {
			if matches!(event.as_ref(), AgentEvent::ToolFinished { .. }) {
				finished += 1;
			}
		}
		assert_eq!(finished, 2, "every committed call emits exactly one result");
	}

	#[tokio::test]
	async fn interrupt_before_commit_yields_skipped_without_args_committed() {
		let (client, transport) = EnvClient::in_process(0);
		let (requests, _responses) = transport.into_parts();
		let events = EventBus::new();
		let call = SpeculativeCall::open(
			&client,
			&events,
			sf!("skipped"),
			identity("skipped_tool"),
			Duration::from_secs(1),
		)
		.await
		.expect("open call");
		let opened = requests.recv_async().await.expect("invoke frame");
		assert!(matches!(opened.body, Some(client_frame::Body::InvokeTool(_))));

		let (_interrupt_tx, interrupt_rx) = watch::channel(Some(sf!("user interrupted")));
		let results = ToolBatch::new(vec![call.commit(Bytes::from_static(b"{}"))])
			.drive_interruptible(&Registry::new(), &caps(), interrupt_rx, Duration::from_millis(10))
			.await;
		assert_eq!(results.len(), 1);
		assert!(terminal_text(&results[0]).starts_with("skipped:"));
		while let Ok(frame) = requests.try_recv() {
			assert!(
				!matches!(frame.body, Some(client_frame::Body::ArgsCommitted(_))),
				"interrupted unstarted call sent ArgsCommitted"
			);
		}
	}

	#[tokio::test]
	async fn abandonment_after_admission_never_authorizes_effects() {
		let (client, transport) = EnvClient::in_process(0);
		let (requests, responses) = transport.into_parts();
		let events = EventBus::new();
		let mut call = SpeculativeCall::open(
			&client,
			&events,
			sf!("abandoned"),
			identity("abandoned_tool"),
			Duration::from_secs(1),
		)
		.await
		.expect("open call");
		let (hooks, _hook_requests) = InvocationHookBus::channel();
		let (facts, _fact_receiver) = flume::unbounded();
		call
			.attach_runtime(hooks, facts, Effects::empty(), None, sf!("turn"))
			.expect("attach runtime");
		let opened = requests.recv_async().await.expect("invoke frame");
		responses
			.send_async(frame::ServerFrame {
				request_id: opened.request_id,
				body: Some(server_frame::Body::AdmitInvocation(AdmitInvocation {
					invocation_id: "abandoned".into(),
					..AdmitInvocation::default()
				})),
				..frame::ServerFrame::default()
			})
			.await
			.expect("admit invocation");
		time::timeout(Duration::from_secs(1), async {
			while call.admission().is_none() {
				task::yield_now().await;
			}
		})
		.await
		.expect("admission observed");
		drop(call);

		let cancelled = time::timeout(Duration::from_secs(1), requests.recv_async())
			.await
			.expect("cancel timeout")
			.expect("cancel frame");
		assert!(matches!(cancelled.body, Some(client_frame::Body::Cancel(_))));
		while let Ok(frame) = requests.try_recv() {
			assert!(
				!matches!(frame.body, Some(client_frame::Body::ArgsCommitted(_))),
				"abandoned admitted invocation authorized effects"
			);
		}
	}
	#[tokio::test]
	async fn tool_args_events_accumulate_exact_fragments_and_partial_view() {
		let (client, transport) = EnvClient::in_process(0);
		let (requests, _responses) = transport.into_parts();
		let events = EventBus::new();
		let observed = events.subscribe_lossless();
		let mut call = SpeculativeCall::open(
			&client,
			&events,
			sf!("partial"),
			identity("partial_tool"),
			Duration::from_secs(1),
		)
		.await
		.expect("open call");
		let opened = requests.recv_async().await.expect("invoke frame");
		assert!(matches!(opened.body, Some(client_frame::Body::InvokeTool(_))));

		call
			.relay_fragment(sf!(r#"{{"path":"src/main.rs","#))
			.await
			.expect("relay path fragment");
		let first_wire = requests.recv_async().await.expect("first ArgText");
		assert!(matches!(
			&first_wire.body,
			Some(client_frame::Body::ArgText(args))
				if args.fragment == r#"{"path":"src/main.rs","#
		));
		call
			.relay_fragment(sf!(r#""command":"cargo ch"#))
			.await
			.expect("relay command fragment");
		let second_wire = requests.recv_async().await.expect("second ArgText");
		assert!(matches!(
			&second_wire.body,
			Some(client_frame::Body::ArgText(args))
				if args.fragment == r#""command":"cargo ch"#
		));

		let mut args_events = Vec::new();
		while let Ok(event) = observed.try_recv() {
			if let AgentEvent::ToolArgs { fragment, view, .. } = event.as_ref() {
				args_events.push((fragment.clone(), view.clone()));
			}
		}
		assert_eq!(args_events.len(), 2);
		assert_eq!(args_events[0].0, Bytes::from_static(br#"{"path":"src/main.rs","#));
		assert_eq!(args_events[0].1["path"].as_str(), Some("src/main.rs"));
		assert_eq!(args_events[1].0, Bytes::from_static(br#""command":"cargo ch"#));
		assert_eq!(args_events[1].1["path"].as_str(), Some("src/main.rs"));
		assert_eq!(args_events[1].1["command"].as_str(), Some("cargo ch"));
	}

	#[tokio::test]
	async fn abandon_waits_for_the_environment_terminal() {
		let (client, transport) = EnvClient::in_process(0);
		let (requests, responses) = transport.into_parts();
		let events = EventBus::new();
		let mut call = SpeculativeCall::open(
			&client,
			&events,
			sf!("stale"),
			identity("stale_tool"),
			Duration::from_secs(1),
		)
		.await
		.expect("open call");
		let opened = requests.recv_async().await.expect("InvokeTool frame");
		let request_id = opened.request_id;
		assert!(matches!(opened.body, Some(client_frame::Body::InvokeTool(_))));

		call
			.relay_fragment(sf!(r#"{{"path":"OLD"}}"#))
			.await
			.expect("relay stale fragment");
		assert_eq!(call.relayed_args(), r#"{"path":"OLD"}"#);
		let fragment = requests.recv_async().await.expect("ArgText frame");
		assert!(matches!(fragment.body, Some(client_frame::Body::ArgText(_))));

		let abandon = tokio::spawn(call.abandon());
		let cancelled = requests.recv_async().await.expect("cancel frame");
		assert!(matches!(cancelled.body, Some(client_frame::Body::Cancel(_))));
		// Without a server terminal the invocation id is not yet reusable.
		assert!(!abandon.is_finished());
		responses
			.send_async(frame::ServerFrame {
				request_id,
				body: Some(server_frame::Body::Verdict(frame::Verdict {
					invocation_id: "stale".into(),
					json: Bytes::from_static(
						br#"{"kind":"aborted","value":{"reason":"restarted","kind":"skipped"}}"#,
					),
					..Default::default()
				})),
				..Default::default()
			})
			.await
			.expect("abort verdict");
		time::timeout(Duration::from_secs(1), abandon)
			.await
			.expect("abandon returns after the terminal")
			.expect("abandon task");
	}

	#[tokio::test]
	async fn speculative_update_publishes_before_commit_then_completes_once() {
		let (client, transport) = EnvClient::in_process(0);
		let (requests, responses) = transport.into_parts();
		let events = EventBus::new();
		let observed = events.subscribe_lossless();
		let mut call = SpeculativeCall::open(
			&client,
			&events,
			sf!("preview"),
			identity("preview_tool"),
			Duration::from_secs(1),
		)
		.await
		.expect("open speculative call");
		let opened = requests.recv_async().await.expect("InvokeTool frame");
		let request_id = opened.request_id;
		assert!(matches!(opened.body, Some(client_frame::Body::InvokeTool(_))));

		call
			.relay_fragment(sf!(r#"{{"path":"src/lib.rs"}}"#))
			.await
			.expect("relay speculative arguments");
		let fragment = requests.recv_async().await.expect("ArgText frame");
		assert!(matches!(fragment.body, Some(client_frame::Body::ArgText(_))));
		responses
			.send_async(frame::ServerFrame {
				request_id,
				body: Some(server_frame::Body::Update(frame::Update {
					invocation_id: "preview".into(),
					json: Bytes::from_static(br#"{"diff":"+preview"}"#),
					..Default::default()
				})),
				..Default::default()
			})
			.await
			.expect("speculative update");

		let mut saw_args = false;
		let mut update_count = 0;
		let mut saw_update = false;
		while !saw_update {
			let event = time::timeout(Duration::from_secs(1), observed.recv())
				.await
				.expect("speculative event timeout")
				.expect("event subscriber");
			match event.as_ref() {
				AgentEvent::ToolArgs { .. } => saw_args = true,
				AgentEvent::ToolUpdate { json, .. } => {
					assert!(saw_args, "ToolArgs must precede its speculative ToolUpdate");
					assert_eq!(json, &Bytes::from_static(br#"{"diff":"+preview"}"#));
					update_count += 1;
					saw_update = true;
				},
				_ => {},
			}
		}
		assert!(requests.try_recv().is_err(), "speculative update authorized effects before commit");

		let drive = tokio::spawn(async move {
			ToolBatch::new(vec![call.commit(Bytes::from_static(br#"{"path":"src/lib.rs"}"#))])
				.drive(&Registry::new(), &caps())
				.await
		});
		let commit = requests.recv_async().await.expect("ArgsCommitted frame");
		assert!(matches!(
			&commit.body,
			Some(client_frame::Body::ArgsCommitted(committed))
				if committed.raw == Bytes::from_static(br#"{"path":"src/lib.rs"}"#)
		));
		responses
			.send_async(frame::ServerFrame {
				request_id,
				body: Some(server_frame::Body::Verdict(frame::Verdict {
					invocation_id: "preview".into(),
					json: Bytes::from_static(br#"{"kind":"ok","value":{"applied":true}}"#),
					parts: vec![ThreadPart { kind: Some(part::Kind::Text("applied".into())) }],
					..Default::default()
				})),
				..Default::default()
			})
			.await
			.expect("terminal verdict");
		let results = drive.await.expect("batch task");
		assert_eq!(results.len(), 1);
		assert_eq!(terminal_text(&results[0]), "applied");
		let mut finished = 0;
		while let Ok(event) = observed.try_recv() {
			match event.as_ref() {
				AgentEvent::ToolFinished { .. } => finished += 1,
				AgentEvent::ToolUpdate { .. } => update_count += 1,
				_ => {},
			}
		}
		assert_eq!(finished, 1, "committed call must complete exactly once");
		assert_eq!(update_count, 1, "speculative update must publish exactly once");
	}

	async fn run_backpressured_commit_race(send_verdict: bool) -> Vec<BatchResult> {
		let (client, transport) = EnvClient::in_process(1);
		let (requests, responses) = transport.into_parts();
		let events = EventBus::new();
		let call = SpeculativeCall::open(
			&client,
			&events,
			sf!("raced-commit"),
			identity("raced_tool"),
			Duration::from_secs(1),
		)
		.await
		.expect("open call");
		let opened = requests.recv_async().await.expect("first InvokeTool");
		let request_id = opened.request_id;
		assert!(matches!(opened.body, Some(client_frame::Body::InvokeTool(_))));

		// Occupy the one-slot channel, then let the pump enqueue ArgsCommitted
		// behind it. Receiving the blocker synchronously promotes that queued
		// frame before the current-thread pump can observe send completion.
		let blocker = SpeculativeCall::open(
			&client,
			&events,
			sf!("channel-blocker"),
			identity("blocker_tool"),
			Duration::from_secs(1),
		)
		.await
		.expect("open channel blocker");
		let (interrupt_tx, interrupt_rx) = watch::channel(None);
		let drive = tokio::spawn(async move {
			ToolBatch::new(vec![call.commit(Bytes::from_static(b"{}"))])
				.drive_interruptible(&Registry::new(), &caps(), interrupt_rx, Duration::from_millis(25))
				.await
		});
		task::yield_now().await;
		task::yield_now().await;
		let blocker_frame = requests.recv().expect("queued blocker InvokeTool");
		assert!(matches!(blocker_frame.body, Some(client_frame::Body::InvokeTool(_))));
		let committed_frame = requests
			.try_recv()
			.expect("receiver promoted the backpressured ArgsCommitted frame");
		assert!(matches!(
			&committed_frame.body,
			Some(client_frame::Body::ArgsCommitted(committed))
				if committed.invocation_id == "raced-commit"
		));
		interrupt_tx
			.send(Some(sf!("interrupt after receiver took commit")))
			.expect("interrupt batch");
		if send_verdict {
			responses
				.send(frame::ServerFrame {
					request_id,
					body: Some(server_frame::Body::Verdict(frame::Verdict {
						invocation_id: "raced-commit".into(),
						json: Bytes::from_static(br#"{"kind":"ok","value":{"committed":true}}"#),
						parts: vec![ThreadPart { kind: Some(part::Kind::Text("committed".into())) }],
						..Default::default()
					})),
					..Default::default()
				})
				.expect("authoritative verdict");
		}
		let results = time::timeout(Duration::from_secs(1), drive)
			.await
			.expect("commit race timeout")
			.expect("batch task");
		drop(blocker);
		results
	}

	#[tokio::test]
	async fn interrupt_coordinator_broadcasts_without_per_call_grace_delay() {
		let (source_tx, mut source_rx) = watch::channel::<Option<Str>>(None);
		let mut targets = Vec::new();
		let mut receivers = Vec::new();
		for _ in 0..3 {
			let (target, receiver) = flume::bounded(1);
			targets.push(interruptible::InterruptTarget { sender: target });
			receivers.push(receiver);
		}
		let coordinator = tokio::spawn(async move {
			interruptible::coordinate_interrupts(&mut source_rx, &targets, Duration::from_secs(1))
				.await;
		});
		source_tx
			.send(Some(sf!("stop every call")))
			.expect("interrupt coordinator");

		let first = receivers[0].recv_async().await.expect("first interrupt");
		let second = receivers[1].recv_async().await.expect("second interrupt");
		let third = receivers[2].recv_async().await.expect("third interrupt");
		first.acknowledged.send(()).expect("acknowledge first");
		second.acknowledged.send(()).expect("acknowledge second");
		third.acknowledged.send(()).expect("acknowledge third");
		coordinator.await.expect("coordinator task");
	}

	#[tokio::test(flavor = "current_thread")]
	async fn interrupt_after_receiver_takes_backpressured_commit_is_effects_unknown() {
		let results = run_backpressured_commit_race(false).await;
		assert_eq!(results.len(), 1);
		assert!(terminal_text(&results[0]).starts_with("aborted with effects unknown:"));
		assert!(!terminal_text(&results[0]).starts_with("skipped:"));
	}

	#[tokio::test(flavor = "current_thread")]
	async fn authoritative_verdict_wins_after_pending_commit_interrupt() {
		let results = run_backpressured_commit_race(true).await;
		assert_eq!(results.len(), 1);
		assert_eq!(terminal_text(&results[0]), "committed");
	}
	#[test]
	fn prewalk_metadata_appears_only_on_mutating_effects() {
		let read_only = Effects {
			documents: Some(omp_tool::DocEffects { read: true, write_globs: Arc::default() }),
			..Effects::empty()
		};
		let mutating = Effects {
			documents: Some(omp_tool::DocEffects {
				read:        true,
				write_globs: Arc::from([sf!("**")]),
			}),
			..Effects::empty()
		};
		assert!(
			!invocation_mode_props(Some("prewalk"), &read_only)
				.fields
				.contains_key(PREWALK_REASON_PROP)
		);
		assert!(
			invocation_mode_props(Some("prewalk"), &mutating)
				.fields
				.contains_key(PREWALK_REASON_PROP)
		);
	}

	#[test]
	fn plan_yolo_metadata_authorizes_mutating_effect() {
		let mutating = Effects {
			exec: Some(omp_tool::ExecEffects { commands: Arc::from([sf!("*")]), network: false }),
			..Effects::empty()
		};
		let props = invocation_mode_props(Some("plan-yolo"), &mutating);
		assert!(props.fields.contains_key(PLAN_YOLO_PROP));
		assert_eq!(
			props.fields[EXECUTION_MODE_PROP].kind,
			Some(value_pb::value::Kind::String("plan".to_owned())),
		);
	}
}
