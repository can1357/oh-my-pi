//! Debug-session lifecycle, tree coordination, breakpoint serialization, and
//! output retention.

use std::{
	collections::{BTreeMap, VecDeque},
	fs, io,
	path::{Path, PathBuf},
	process::Stdio,
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use futures::future::join_all;
use omp_core::Str;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use serde_json::{Map, Value, json};
use strum::{EnumString, IntoStaticStr};
use thiserror::Error;
use tokio::{
	io::{AsyncRead, AsyncReadExt},
	process::{self, Child},
	sync::{Mutex as AsyncMutex, broadcast::Receiver},
	time,
	time::MissedTickBehavior,
};

use crate::docserver::{
	dap_adapter::SKIP_ATTACH_REQUEST,
	dap_protocol::{DapInbound, DapProtocol, DapProtocolError, SpawnedDap},
};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT_BYTES: usize = 128 * 1024;
const IDLE_TIMEOUT: Duration = Duration::from_mins(10);
const LIVENESS_INTERVAL: Duration = Duration::from_secs(5);
const SWEEP_INTERVALS: u8 = 6;

/// Stable DAP lifecycle state.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum DapSessionState {
	/// Adapter process and initialize request are starting.
	Launching,
	/// Launch/attach accepted; breakpoints are being configured.
	Configuring,
	/// Debuggee is suspended.
	Stopped,
	/// Debuggee is executing.
	Running,
	/// Adapter or debuggee ended.
	Terminated,
}

/// Debug action exposed to policy and tool layers.
#[derive(Clone, Copy, Debug, EnumString, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum DapAction {
	/// Start a program.
	Launch,
	/// Attach to an existing program.
	Attach,
	/// Add or replace a source breakpoint.
	SetBreakpoint,
	/// Remove a source breakpoint.
	RemoveBreakpoint,
	/// Add or replace a function breakpoint.
	SetFunctionBreakpoint,
	/// Remove a function breakpoint.
	RemoveFunctionBreakpoint,
	/// Add an instruction breakpoint.
	SetInstructionBreakpoint,
	/// Remove an instruction breakpoint.
	RemoveInstructionBreakpoint,
	/// Query a data breakpoint identifier.
	DataBreakpointInfo,
	/// Add a data breakpoint.
	SetDataBreakpoint,
	/// Remove a data breakpoint.
	RemoveDataBreakpoint,
	/// Resume execution.
	Continue,
	/// Step over.
	#[strum(serialize = "step_over", serialize = "next")]
	StepOver,
	/// Step into.
	#[strum(serialize = "step_in", serialize = "stepIn")]
	StepIn,
	/// Step out.
	#[strum(serialize = "step_out", serialize = "stepOut")]
	StepOut,
	/// Suspend execution.
	Pause,
	/// Evaluate an expression.
	Evaluate,
	/// Inspect stack frames.
	#[strum(serialize = "stack_trace", serialize = "stackTrace")]
	StackTrace,
	/// Inspect threads.
	Threads,
	/// Inspect scopes.
	Scopes,
	/// Inspect variables.
	Variables,
	/// Inspect instructions.
	Disassemble,
	/// Read process memory.
	#[strum(serialize = "read_memory", serialize = "readMemory")]
	ReadMemory,
	/// Write process memory.
	#[strum(serialize = "write_memory", serialize = "writeMemory")]
	WriteMemory,
	/// Inspect modules.
	Modules,
	/// Inspect loaded sources.
	#[strum(serialize = "loaded_sources", serialize = "loadedSources")]
	LoadedSources,
	/// Send an adapter extension request.
	CustomRequest,
	/// Read buffered output.
	Output,
	/// End a session tree.
	Terminate,
	/// List live sessions.
	Sessions,
}

/// Environment-side approval tier attached to each debug action.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DapApprovalTier {
	/// Cannot mutate debuggee or adapter state.
	ReadOnly,
	/// May launch, resume, mutate, or terminate.
	Execution,
}

impl DapAction {
	/// Returns immutable env-side tier data; presentation layers do not decide
	/// it.
	pub const fn approval_tier(self) -> DapApprovalTier {
		match self {
			Self::StackTrace
			| Self::Threads
			| Self::Scopes
			| Self::Variables
			| Self::Disassemble
			| Self::ReadMemory
			| Self::Modules
			| Self::LoadedSources
			| Self::Output
			| Self::Sessions => DapApprovalTier::ReadOnly,
			Self::Launch
			| Self::Attach
			| Self::SetBreakpoint
			| Self::RemoveBreakpoint
			| Self::SetFunctionBreakpoint
			| Self::RemoveFunctionBreakpoint
			| Self::SetInstructionBreakpoint
			| Self::RemoveInstructionBreakpoint
			| Self::SetDataBreakpoint
			| Self::RemoveDataBreakpoint
			| Self::Continue
			| Self::StepOver
			| Self::StepIn
			| Self::StepOut
			| Self::Pause
			| Self::Evaluate
			| Self::DataBreakpointInfo
			| Self::WriteMemory
			| Self::CustomRequest
			| Self::Terminate => DapApprovalTier::Execution,
		}
	}

	/// Returns the standard DAP command for direct request actions.
	pub const fn command(self) -> Option<&'static str> {
		match self {
			Self::Continue => Some("continue"),
			Self::StepOver => Some("next"),
			Self::StepIn => Some("stepIn"),
			Self::StepOut => Some("stepOut"),
			Self::Pause => Some("pause"),
			Self::Evaluate => Some("evaluate"),
			Self::StackTrace => Some("stackTrace"),
			Self::Threads => Some("threads"),
			Self::Scopes => Some("scopes"),
			Self::Variables => Some("variables"),
			Self::Disassemble => Some("disassemble"),
			Self::ReadMemory => Some("readMemory"),
			Self::WriteMemory => Some("writeMemory"),
			Self::Modules => Some("modules"),
			Self::LoadedSources => Some("loadedSources"),
			Self::DataBreakpointInfo => Some("dataBreakpointInfo"),
			_ => None,
		}
	}
}

/// Stop context returned after a stepping or pause transition completes.
#[derive(Clone, Debug, Serialize)]
pub struct DapStopSnapshot {
	/// Action that produced this state.
	pub action:      DapAction,
	/// Adapter stop reason.
	pub reason:      Str,
	/// Selected thread identity when supplied by the adapter.
	pub thread_id:   Option<i64>,
	/// Top stack frame, including source and line fields.
	pub frame:       Option<Value>,
	/// Requested stepping granularity.
	pub granularity: Option<Str>,
	/// Stable session state after the event.
	pub state:       DapSessionState,
	/// Whether execution remained live through the bounded stop wait.
	pub timed_out:   bool,
}

/// Session handshake, state, or protocol failure.
#[derive(Debug, Error)]
pub enum DapSessionError {
	/// Framing or adapter request failure.
	#[error(transparent)]
	Protocol(#[from] DapProtocolError),
	/// Lifecycle transition violated the state machine.
	#[error("invalid DAP session transition {from:?} -> {to:?}")]
	InvalidTransition {
		/// Current state.
		from: DapSessionState,
		/// Rejected next state.
		to:   DapSessionState,
	},
	/// This action requires a higher-level operation.
	#[error("debug action {0:?} has no direct protocol command")]
	UnsupportedAction(DapAction),
	/// The adapter did not advertise a required capability.
	#[error("debug action {action:?} requires adapter capability {capability}")]
	MissingCapability {
		/// Rejected action.
		action:     DapAction,
		/// DAP initialize capability key.
		capability: &'static str,
	},
	/// Adapter process ownership failed.
	#[error("DAP adapter process failed")]
	Process(#[from] io::Error),
	/// Parent-child registration would create a cycle.
	#[error("debug session tree cannot contain a cycle")]
	SessionTreeCycle,
	/// Session identity is absent.
	#[error("debug session {0:?} was not found")]
	NotFound(Str),
	/// Adapter supplied an invalid reverse-request payload.
	#[error("invalid DAP reverse request")]
	InvalidReverseRequest,
}

/// Authority callback for adapter-to-client reverse requests.
#[async_trait]
pub trait DapReverseRequestHandler: Send + Sync + 'static {
	/// Handles one reverse request and returns the DAP response body.
	async fn handle(
		&self,
		session: Arc<DapSession>,
		command: &str,
		arguments: Value,
	) -> Result<Value, Str>;
}

struct RejectReverseRequests;

#[async_trait]
impl DapReverseRequestHandler for RejectReverseRequests {
	async fn handle(
		&self,
		_session: Arc<DapSession>,
		_command: &str,
		_arguments: Value,
	) -> Result<Value, Str> {
		Err(Str::new_static("DAP reverse requests are not configured"))
	}
}

#[derive(Clone, Debug)]
struct StoppedState {
	reason:    Str,
	thread_id: Option<i64>,
	frame:     Option<Value>,
}

/// One live DAP session and its child-session subtree.
pub struct DapSession {
	id: Str,
	adapter: Str,
	protocol: DapProtocol,
	process: Option<Arc<AsyncMutex<Child>>>,
	adapter_process_id: Option<u32>,
	debuggee_process_id: AtomicU64,
	terminal_processes: Mutex<Vec<Arc<AsyncMutex<Child>>>>,
	cleanup_path: Option<PathBuf>,
	attached: bool,
	state: Mutex<DapSessionState>,
	stopped: Mutex<Option<StoppedState>>,
	capabilities: RwLock<Value>,
	output: Mutex<VecDeque<u8>>,
	last_activity_ms: AtomicU64,
	revision: AtomicU64,
	event_sequence: AtomicU64,
	read_granted: AtomicBool,
	execute_granted: AtomicBool,
	event_byte_limit: AtomicU64,
	parent: Mutex<Option<Weak<Self>>>,
	children: Mutex<Vec<Weak<Self>>>,
	breakpoint_mutation: AsyncMutex<()>,
	breakpoint_intent_mutation: AsyncMutex<()>,
	source_breakpoints: Mutex<BTreeMap<Str, Vec<Value>>>,
	function_breakpoints: Mutex<Vec<Value>>,
	instruction_breakpoints: Mutex<Vec<Value>>,
	data_breakpoints: Mutex<Vec<Value>>,
	handler: Arc<dyn DapReverseRequestHandler>,
}

impl DapSession {
	/// Runs initialize, an optional launch/attach request, and the adapter's
	/// supported configuration handshake with initialized-event
	/// pre-subscription.
	pub async fn start(
		id: impl AsRef<str>,
		adapter: impl AsRef<str>,
		protocol: DapProtocol,
		attach: bool,
		arguments: Map<String, Value>,
		handler: Option<Arc<dyn DapReverseRequestHandler>>,
	) -> Result<Arc<Self>, DapSessionError> {
		Self::start_owned(id, adapter, protocol, None, None, None, attach, arguments, handler).await
	}

	/// Starts a session while retaining ownership of its spawned adapter.
	pub async fn start_spawned(
		id: impl AsRef<str>,
		adapter: impl AsRef<str>,
		spawned: SpawnedDap,
		attach: bool,
		arguments: Map<String, Value>,
		handler: Option<Arc<dyn DapReverseRequestHandler>>,
	) -> Result<Arc<Self>, DapSessionError> {
		let adapter_process_id = spawned.child.lock().await.id();
		Self::start_owned(
			id,
			adapter,
			spawned.protocol,
			Some(spawned.child),
			adapter_process_id,
			spawned.cleanup_path,
			attach,
			arguments,
			handler,
		)
		.await
	}

	#[tracing::instrument(
		name = "dap_session_start",
		level = "debug",
		skip_all,
		fields(session_id = %id.as_ref(), adapter = %adapter.as_ref(), attach = attach)
	)]
	async fn start_owned(
		id: impl AsRef<str>,
		adapter: impl AsRef<str>,
		protocol: DapProtocol,
		process: Option<Arc<AsyncMutex<Child>>>,
		adapter_process_id: Option<u32>,
		cleanup_path: Option<PathBuf>,
		attach: bool,
		arguments: Map<String, Value>,
		handler: Option<Arc<dyn DapReverseRequestHandler>>,
	) -> Result<Arc<Self>, DapSessionError> {
		let initialized = protocol.subscribe();
		let mut arguments = arguments;
		let debuggee_process_id = arguments
			.get("processId")
			.or_else(|| arguments.get("pid"))
			.and_then(Value::as_u64)
			.and_then(|pid| u32::try_from(pid).ok());
		let skip_attach_request = attach
			&& arguments
				.remove(SKIP_ATTACH_REQUEST)
				.and_then(|value| value.as_bool())
				.unwrap_or(false);
		let session = Arc::new(Self {
			id: Str::new(id.as_ref()),
			adapter: Str::new(adapter.as_ref()),
			protocol,
			process,
			adapter_process_id,
			debuggee_process_id: AtomicU64::new(debuggee_process_id.map_or(0, u64::from)),
			terminal_processes: Mutex::new(Vec::new()),
			cleanup_path,
			attached: attach,
			state: Mutex::new(DapSessionState::Launching),
			stopped: Mutex::new(None),
			capabilities: RwLock::new(Value::Null),
			output: Mutex::new(VecDeque::with_capacity(MAX_OUTPUT_BYTES)),
			last_activity_ms: AtomicU64::new(now_ms()),
			revision: AtomicU64::new(1),
			event_sequence: AtomicU64::new(0),
			read_granted: AtomicBool::new(false),
			execute_granted: AtomicBool::new(false),
			event_byte_limit: AtomicU64::new(0),
			parent: Mutex::new(None),
			children: Mutex::new(Vec::new()),
			breakpoint_mutation: AsyncMutex::new(()),
			breakpoint_intent_mutation: AsyncMutex::new(()),
			source_breakpoints: Mutex::new(BTreeMap::new()),
			function_breakpoints: Mutex::new(Vec::new()),
			instruction_breakpoints: Mutex::new(Vec::new()),
			data_breakpoints: Mutex::new(Vec::new()),
			handler: handler.unwrap_or_else(|| Arc::new(RejectReverseRequests)),
		});
		Self::spawn_event_loop(&session);
		let capabilities = session
			.protocol
			.request(
				"initialize",
				json!({
					"clientID": "omp",
					"clientName": "Oh My Pi",
					"adapterID": session.adapter,
					"pathFormat": "path",
					"linesStartAt1": true,
					"columnsStartAt1": true,
					"supportsRunInTerminalRequest": true,
					"supportsStartDebuggingRequest": true
				}),
			)
			.await?;
		let supports_configuration_done = capabilities
			.get("supportsConfigurationDoneRequest")
			.and_then(Value::as_bool)
			.unwrap_or(false);
		*session.capabilities.write() = capabilities;
		session.transition(DapSessionState::Configuring)?;
		let launch = if skip_attach_request {
			None
		} else {
			let launch_protocol = session.protocol.clone();
			let command = if attach { "attach" } else { "launch" };
			Some(tokio::spawn(async move {
				launch_protocol
					.request(command, Value::Object(arguments))
					.await
			}))
		};
		if supports_configuration_done {
			DapProtocol::wait_for_event(initialized, "initialized", HANDSHAKE_TIMEOUT).await?;
			session
				.protocol
				.request("configurationDone", json!({}))
				.await?;
		}
		if let Some(launch) = launch {
			launch
				.await
				.map_err(|_| DapProtocolError::TransportClosed)??;
		}
		if session.state() == DapSessionState::Configuring {
			session.transition(DapSessionState::Running)?;
		}
		Self::spawn_maintenance(&session);
		tracing::info!("DAP session ready");
		Ok(session)
	}

	fn spawn_maintenance(session: &Arc<Self>) {
		let weak = Arc::downgrade(session);
		tokio::spawn(async move {
			let mut interval = time::interval(LIVENESS_INTERVAL);
			interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
			let mut intervals = 0_u8;
			loop {
				interval.tick().await;
				let Some(session) = weak.upgrade() else { break };
				if session.state() == DapSessionState::Terminated || session.protocol.is_closed() {
					break;
				}
				if let Some(process) = &session.process
					&& process.lock().await.try_wait().ok().flatten().is_some()
				{
					tracing::info!(
						session_id = %session.id,
						adapter = %session.adapter,
						"DAP adapter process exited"
					);
					*session.state.lock() = DapSessionState::Terminated;
					session.protocol.shutdown();
					break;
				}
				if let Err(error) = session.protocol.request("threads", json!({})).await {
					tracing::warn!(
						session_id = %session.id,
						adapter = %session.adapter,
						%error,
						"DAP liveness request failed; stopping session"
					);
					*session.state.lock() = DapSessionState::Terminated;
					session.protocol.shutdown();
					break;
				}
				intervals = intervals.saturating_add(1);
				if intervals == SWEEP_INTERVALS {
					intervals = 0;
					if !session.attached && session.is_idle(now_ms()) {
						let _ = session.terminate().await;
						break;
					}
				}
			}
		});
	}

	fn spawn_event_loop(session: &Arc<Self>) {
		let weak = Arc::downgrade(session);
		let mut events = session.protocol.subscribe();
		tokio::spawn(async move {
			loop {
				let Some(session) = weak.upgrade() else { break };
				tokio::select! {
					() = session.protocol.closed() => {
						*session.state.lock() = DapSessionState::Terminated;
						break;
					},
					event = events.recv() => match event {
						Ok(event) => Self::handle_inbound(&session, event).await,
						Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
							tracing::warn!(
								session_id = %session.id,
								skipped,
								"DAP event subscriber lagged"
							);
						},
						Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
					},
				}
			}
		});
	}

	async fn handle_inbound(session: &Arc<Self>, inbound: DapInbound) {
		session.touch();
		match inbound {
			DapInbound::Event { event, body } => match event.as_str() {
				"stopped" => {
					*session.state.lock() = DapSessionState::Stopped;
					let thread_id = body.get("threadId").and_then(Value::as_i64);
					let frame = if let Some(thread_id) = thread_id {
						session
							.protocol
							.request(
								"stackTrace",
								json!({"threadId": thread_id, "startFrame": 0, "levels": 1}),
							)
							.await
							.ok()
							.and_then(|response| {
								response
									.get("stackFrames")
									.and_then(Value::as_array)
									.and_then(|frames| frames.first())
									.cloned()
							})
					} else {
						None
					};
					*session.stopped.lock() = Some(StoppedState {
						reason: Str::new(
							body
								.get("reason")
								.and_then(Value::as_str)
								.unwrap_or("stopped"),
						),
						thread_id,
						frame,
					});
				},
				"continued" => {
					*session.state.lock() = DapSessionState::Running;
					*session.stopped.lock() = None;
				},
				"terminated" | "exited" => {
					*session.state.lock() = DapSessionState::Terminated;
					*session.stopped.lock() = None;
				},
				"output" => {
					if let Some(output) = body.get("output").and_then(Value::as_str) {
						session.push_output(output.as_bytes());
					}
				},
				"process" => {
					if let Some(process_id) = body
						.get("systemProcessId")
						.or_else(|| body.get("processId"))
						.and_then(Value::as_u64)
					{
						session
							.debuggee_process_id
							.store(process_id, Ordering::Release);
					}
				},
				_ => {},
			},
			DapInbound::ReverseRequest { seq, command, arguments } => {
				let result = session
					.handler
					.handle(Arc::clone(session), command.as_str(), arguments)
					.await;
				let (success, body, message) = match result {
					Ok(body) => (true, body, None),
					Err(message) => {
						tracing::warn!(
							session_id = %session.id,
							command = %command,
							"DAP reverse request rejected"
						);
						(false, Value::Null, Some(message))
					},
				};
				if let Err(error) = session
					.protocol
					.respond_reverse(seq, command.as_str(), success, body, message)
					.await
				{
					tracing::warn!(
						session_id = %session.id,
						command = %command,
						%error,
						"DAP reverse response delivery failed"
					);
				}
			},
		}
	}

	fn transition(&self, to: DapSessionState) -> Result<(), DapSessionError> {
		let mut state = self.state.lock();
		let valid = matches!(
			(*state, to),
			(DapSessionState::Launching, DapSessionState::Configuring | DapSessionState::Terminated)
				| (
					DapSessionState::Configuring,
					DapSessionState::Running | DapSessionState::Stopped | DapSessionState::Terminated
				) | (DapSessionState::Running, DapSessionState::Stopped | DapSessionState::Terminated)
				| (DapSessionState::Stopped, DapSessionState::Running | DapSessionState::Terminated)
		);
		if !valid {
			return Err(DapSessionError::InvalidTransition { from: *state, to });
		}
		*state = to;
		self.touch();
		Ok(())
	}

	/// Returns the most recently active live child, or this root when no child
	/// has taken over execution.
	pub fn active_target(self: &Arc<Self>) -> Arc<Self> {
		let mut selected = Arc::clone(self);
		let mut pending = self
			.children
			.lock()
			.iter()
			.filter_map(Weak::upgrade)
			.collect::<Vec<_>>();
		while let Some(candidate) = pending.pop() {
			pending.extend(candidate.children.lock().iter().filter_map(Weak::upgrade));
			let candidate_state = candidate.state();
			let selected_state = selected.state();
			let candidate_rank = (
				candidate_state == DapSessionState::Stopped,
				candidate_state == DapSessionState::Running,
				candidate.last_activity_ms.load(Ordering::Acquire),
			);
			let selected_rank = (
				selected_state == DapSessionState::Stopped,
				selected_state == DapSessionState::Running,
				selected.last_activity_ms.load(Ordering::Acquire),
			);
			if candidate_state != DapSessionState::Terminated && candidate_rank >= selected_rank {
				selected = candidate;
			}
		}
		selected
	}

	/// Returns the stable session identity.
	pub fn id(&self) -> &str {
		self.id.as_str()
	}

	/// Returns the selected adapter name.
	pub fn adapter(&self) -> &str {
		self.adapter.as_str()
	}

	/// Returns the current lifecycle state.
	pub fn state(&self) -> DapSessionState {
		*self.state.lock()
	}

	/// Returns the owned adapter process id, when the adapter was spawned.
	pub const fn adapter_process_id(&self) -> Option<u32> {
		self.adapter_process_id
	}

	/// Returns the attached or adapter-reported debuggee process id.
	pub fn debuggee_process_id(&self) -> Option<u32> {
		u32::try_from(self.debuggee_process_id.load(Ordering::Acquire))
			.ok()
			.filter(|pid| *pid != 0)
	}

	/// Returns one semantic session/process snapshot for diagnostics and tools.
	pub fn snapshot(&self) -> Value {
		let stopped = self.stopped.lock().clone();
		let parent = self
			.parent
			.lock()
			.as_ref()
			.and_then(Weak::upgrade)
			.map(|parent| parent.id.clone());
		let children = self
			.children
			.lock()
			.iter()
			.filter_map(Weak::upgrade)
			.map(|child| child.id.clone())
			.collect::<Vec<_>>();
		json!({
			"id": self.id,
			"adapter": self.adapter,
			"state": Into::<&'static str>::into(self.state()),
			"revision": self.revision(),
			"adapterProcessId": self.adapter_process_id(),
			"processId": self.debuggee_process_id(),
			"parentSessionId": parent,
			"childSessionIds": children,
			"stop": stopped.map(|stopped| json!({
				"reason": stopped.reason,
				"threadId": stopped.thread_id,
				"frame": stopped.frame,
			})),
		})
	}

	/// Returns the adapter initialize capabilities.
	pub fn capabilities(&self) -> Value {
		self.capabilities.read().clone()
	}

	/// Rejects actions whose optional DAP capability was not advertised.
	pub fn ensure_action_supported(&self, action: DapAction) -> Result<(), DapSessionError> {
		let capability = match action {
			DapAction::SetFunctionBreakpoint | DapAction::RemoveFunctionBreakpoint => {
				Some("supportsFunctionBreakpoints")
			},
			DapAction::SetInstructionBreakpoint | DapAction::RemoveInstructionBreakpoint => {
				Some("supportsInstructionBreakpoints")
			},
			DapAction::DataBreakpointInfo
			| DapAction::SetDataBreakpoint
			| DapAction::RemoveDataBreakpoint => Some("supportsDataBreakpoints"),
			DapAction::Disassemble => Some("supportsDisassembleRequest"),
			DapAction::ReadMemory => Some("supportsReadMemoryRequest"),
			DapAction::WriteMemory => Some("supportsWriteMemoryRequest"),
			DapAction::Modules => Some("supportsModulesRequest"),
			DapAction::LoadedSources => Some("supportsLoadedSourcesRequest"),
			_ => None,
		};
		let Some(capability) = capability else {
			return Ok(());
		};
		if self
			.capabilities
			.read()
			.get(capability)
			.and_then(Value::as_bool)
			.unwrap_or(false)
		{
			Ok(())
		} else {
			Err(DapSessionError::MissingCapability { action, capability })
		}
	}

	/// Returns the current revision fence.
	pub fn revision(&self) -> u64 {
		self.revision.load(Ordering::Acquire)
	}

	/// Installs immutable capabilities and the session event byte ceiling.
	pub fn set_wire_grants(&self, read: bool, execute: bool, event_byte_limit: u32) {
		self.read_granted.store(read, Ordering::Release);
		self.execute_granted.store(execute, Ordering::Release);
		self
			.event_byte_limit
			.store(u64::from(event_byte_limit), Ordering::Release);
	}

	/// Reports whether the launch contract granted this action tier.
	pub fn grants(&self, tier: DapApprovalTier) -> bool {
		match tier {
			DapApprovalTier::ReadOnly => self.read_granted.load(Ordering::Acquire),
			DapApprovalTier::Execution => self.execute_granted.load(Ordering::Acquire),
		}
	}

	/// Returns the bounded event payload ceiling set at launch.
	pub fn event_byte_limit(&self) -> usize {
		usize::try_from(self.event_byte_limit.load(Ordering::Acquire)).unwrap_or(usize::MAX)
	}

	/// Advances and returns the current revision after a completed action.
	pub fn advance_revision(&self) -> u64 {
		self
			.revision
			.fetch_add(1, Ordering::AcqRel)
			.saturating_add(1)
	}

	/// Allocates the next contiguous output/event sequence.
	pub fn next_event_sequence(&self) -> u64 {
		self
			.event_sequence
			.fetch_add(1, Ordering::AcqRel)
			.saturating_add(1)
	}

	/// Subscribes to adapter events before starting an action.
	pub fn subscribe(&self) -> Receiver<DapInbound> {
		self.protocol.subscribe()
	}

	/// Executes one direct action; callers can inspect `approval_tier` first.
	#[tracing::instrument(
		name = "dap_request",
		level = "debug",
		skip_all,
		fields(action = ?action)
	)]
	pub async fn execute(
		&self,
		action: DapAction,
		mut arguments: Value,
	) -> Result<Value, DapSessionError> {
		let command = action
			.command()
			.ok_or(DapSessionError::UnsupportedAction(action))?;
		self.fill_stopped_defaults(action, &mut arguments);
		if action == DapAction::StackTrace {
			self.fill_thread_from_adapter(&mut arguments).await?;
		}
		self.touch();
		Ok(self.protocol.request(command, arguments).await?)
	}

	/// Sends an adapter-specific request without rewriting its payload.
	/// Continues, pauses, or steps and awaits the corresponding lifecycle event.
	#[tracing::instrument(
		name = "dap_request",
		level = "debug",
		skip_all,
		fields(action = ?action)
	)]
	pub async fn control(
		&self,
		action: DapAction,
		mut arguments: Value,
		stop_timeout: Duration,
	) -> Result<DapStopSnapshot, DapSessionError> {
		let command = action
			.command()
			.ok_or(DapSessionError::UnsupportedAction(action))?;
		if !matches!(
			action,
			DapAction::Continue
				| DapAction::Pause
				| DapAction::StepOver
				| DapAction::StepIn
				| DapAction::StepOut
		) {
			return Err(DapSessionError::UnsupportedAction(action));
		}
		if action == DapAction::Pause
			&& self.state() == DapSessionState::Stopped
			&& let Some(stopped) = self.stopped.lock().clone()
		{
			return Ok(DapStopSnapshot {
				action,
				reason: stopped.reason,
				thread_id: stopped.thread_id,
				frame: stopped.frame,
				granularity: None,
				state: DapSessionState::Stopped,
				timed_out: false,
			});
		}
		self.fill_stopped_defaults(action, &mut arguments);
		self.fill_thread_from_adapter(&mut arguments).await?;
		let events = self.protocol.subscribe();
		let granularity = arguments
			.get("granularity")
			.and_then(Value::as_str)
			.map(Str::new);
		self.touch();
		let response = self.protocol.request(command, arguments).await?;
		let awaited = time::timeout(stop_timeout, async {
			let mut events = events;
			loop {
				match events.recv().await {
					Ok(DapInbound::Event { event, body })
						if matches!(event.as_str(), "stopped" | "terminated" | "exited") =>
					{
						return Ok((event, body));
					},
					Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {},
					Err(tokio::sync::broadcast::error::RecvError::Closed) => {
						return Err(DapProtocolError::TransportClosed);
					},
				}
			}
		})
		.await;
		let (event_name, body, timed_out) = match awaited {
			Ok(Ok((event, body))) => (event, body, false),
			Ok(Err(error)) => return Err(error.into()),
			Err(_) => (
				Str::new_static("running"),
				json!({"reason": "timeout", "threadId": response.get("threadId")}),
				true,
			),
		};
		let thread_id = body.get("threadId").and_then(Value::as_i64);
		let frame = if event_name.as_str() == "stopped" {
			if let Some(thread_id) = thread_id {
				self
					.protocol
					.request("stackTrace", json!({"threadId": thread_id, "startFrame": 0, "levels": 1}))
					.await?
					.get("stackFrames")
					.and_then(Value::as_array)
					.and_then(|frames| frames.first())
					.cloned()
			} else {
				None
			}
		} else {
			None
		};
		if matches!(event_name.as_str(), "terminated" | "exited") {
			*self.state.lock() = DapSessionState::Terminated;
			*self.stopped.lock() = None;
		}
		let reason = Str::new(
			body
				.get("reason")
				.and_then(Value::as_str)
				.unwrap_or(event_name.as_str()),
		);
		if event_name.as_str() == "stopped" {
			*self.stopped.lock() =
				Some(StoppedState { reason: reason.clone(), thread_id, frame: frame.clone() });
		}
		Ok(DapStopSnapshot {
			action,
			reason,
			thread_id,
			frame,
			granularity,
			state: self.state(),
			timed_out,
		})
	}

	async fn fill_thread_from_adapter(&self, arguments: &mut Value) -> Result<(), DapSessionError> {
		let Some(arguments) = arguments.as_object_mut() else {
			return Ok(());
		};
		if arguments.contains_key("threadId") {
			return Ok(());
		}
		let thread_id = self
			.protocol
			.request("threads", json!({}))
			.await?
			.get("threads")
			.and_then(Value::as_array)
			.and_then(|threads| threads.first())
			.and_then(|thread| thread.get("id"))
			.and_then(Value::as_i64);
		if let Some(thread_id) = thread_id {
			arguments.insert("threadId".to_owned(), json!(thread_id));
		}
		Ok(())
	}

	fn fill_stopped_defaults(&self, action: DapAction, arguments: &mut Value) {
		let Some(arguments) = arguments.as_object_mut() else {
			return;
		};
		let stopped = self.stopped.lock();
		let Some(stopped) = stopped.as_ref() else {
			return;
		};
		if matches!(
			action,
			DapAction::Continue
				| DapAction::StepOver
				| DapAction::StepIn
				| DapAction::StepOut
				| DapAction::Pause
				| DapAction::StackTrace
		) && !arguments.contains_key("threadId")
			&& let Some(thread_id) = stopped.thread_id
		{
			arguments.insert("threadId".to_owned(), json!(thread_id));
		}
		if matches!(action, DapAction::Scopes | DapAction::Evaluate | DapAction::DataBreakpointInfo)
			&& !arguments.contains_key("frameId")
			&& let Some(frame_id) = stopped
				.frame
				.as_ref()
				.and_then(|frame| frame.get("id"))
				.and_then(Value::as_i64)
		{
			arguments.insert("frameId".to_owned(), json!(frame_id));
		}
		if action == DapAction::Disassemble
			&& !arguments.contains_key("memoryReference")
			&& let Some(reference) = stopped
				.frame
				.as_ref()
				.and_then(|frame| frame.get("instructionPointerReference"))
				.and_then(Value::as_str)
		{
			arguments.insert("memoryReference".to_owned(), json!(reference));
		}
	}

	/// Sends an adapter-specific request without rewriting its payload.
	pub async fn custom_request(
		&self,
		command: &str,
		arguments: Value,
	) -> Result<Value, DapSessionError> {
		self.touch();
		Ok(self.protocol.request(command, arguments).await?)
	}

	/// Replaces source breakpoints atomically and synchronizes every live child.
	pub async fn set_source_breakpoints(
		self: &Arc<Self>,
		source: impl AsRef<str>,
		breakpoints: Vec<Value>,
	) -> Result<Value, DapSessionError> {
		let source = Str::new(source.as_ref());
		let (response, mut pending) = self
			.replace_source_breakpoints(&source, &breakpoints)
			.await?;
		pending.reverse();
		while let Some(session) = pending.pop() {
			let (_, children) = session
				.replace_source_breakpoints(&source, &breakpoints)
				.await?;
			pending.extend(children.into_iter().rev());
		}
		Ok(response)
	}

	/// Adds, replaces, or removes one source breakpoint without discarding
	/// sibling intent.
	pub async fn mutate_source_breakpoint(
		self: &Arc<Self>,
		source: impl AsRef<str>,
		breakpoint: Value,
		remove: bool,
	) -> Result<Value, DapSessionError> {
		let _intent_guard = self.breakpoint_intent_mutation.lock().await;
		let source = Str::new(source.as_ref());
		let mut breakpoints = self
			.source_breakpoints
			.lock()
			.get(&source)
			.cloned()
			.unwrap_or_default();
		breakpoints.retain(|existing| !same_breakpoint(existing, &breakpoint, &["line", "column"]));
		if !remove {
			breakpoints.push(breakpoint);
		}
		self
			.set_source_breakpoints(source.as_str(), breakpoints)
			.await
	}

	async fn replace_source_breakpoints(
		&self,
		source: &Str,
		breakpoints: &[Value],
	) -> Result<(Value, Vec<Arc<Self>>), DapSessionError> {
		let _guard = self.breakpoint_mutation.lock().await;
		self
			.source_breakpoints
			.lock()
			.insert(source.clone(), breakpoints.to_vec());
		let response = self
			.protocol
			.request("setBreakpoints", json!({"source": {"path": source}, "breakpoints": breakpoints}))
			.await?;
		let children = self
			.children
			.lock()
			.iter()
			.filter_map(Weak::upgrade)
			.collect();
		drop(_guard);
		Ok((response, children))
	}

	/// Adds a child and replays current source breakpoints before exposing it.
	pub async fn add_child(self: &Arc<Self>, child: &Arc<Self>) -> Result<(), DapSessionError> {
		let _intent_guard = self.breakpoint_intent_mutation.lock().await;
		if Arc::ptr_eq(self, child) || self.has_ancestor(child) {
			return Err(DapSessionError::SessionTreeCycle);
		}
		*child.parent.lock() = Some(Arc::downgrade(self));
		self.children.lock().push(Arc::downgrade(child));
		let breakpoints = self.source_breakpoints.lock().clone();
		for (source, values) in breakpoints {
			child
				.set_source_breakpoints(source.as_str(), values)
				.await?;
		}
		let function_breakpoints = self.function_breakpoints.lock().clone();
		let instruction_breakpoints = self.instruction_breakpoints.lock().clone();
		let data_breakpoints = self.data_breakpoints.lock().clone();
		if !function_breakpoints.is_empty()
			&& child.supports_breakpoint_command("setFunctionBreakpoints")
		{
			child.set_function_breakpoints(function_breakpoints).await?;
		}
		if !instruction_breakpoints.is_empty()
			&& child.supports_breakpoint_command("setInstructionBreakpoints")
		{
			child
				.set_instruction_breakpoints(instruction_breakpoints)
				.await?;
		}
		if !data_breakpoints.is_empty() && child.supports_breakpoint_command("setDataBreakpoints") {
			child.set_data_breakpoints(data_breakpoints).await?;
		}
		Ok(())
	}

	/// Replaces function-breakpoint intent throughout the session tree.
	pub async fn set_function_breakpoints(
		self: &Arc<Self>,
		breakpoints: Vec<Value>,
	) -> Result<Value, DapSessionError> {
		self
			.replace_tree_breakpoints("setFunctionBreakpoints", breakpoints)
			.await
	}

	/// Adds, replaces, or removes one function breakpoint.
	pub async fn mutate_function_breakpoint(
		self: &Arc<Self>,
		breakpoint: Value,
		remove: bool,
	) -> Result<Value, DapSessionError> {
		let _intent_guard = self.breakpoint_intent_mutation.lock().await;
		let mut breakpoints = self.function_breakpoints.lock().clone();
		breakpoints.retain(|existing| !same_breakpoint(existing, &breakpoint, &["name"]));
		if !remove {
			breakpoints.push(breakpoint);
		}
		self.set_function_breakpoints(breakpoints).await
	}

	/// Replaces instruction-breakpoint intent throughout the session tree.
	pub async fn set_instruction_breakpoints(
		self: &Arc<Self>,
		breakpoints: Vec<Value>,
	) -> Result<Value, DapSessionError> {
		self
			.replace_tree_breakpoints("setInstructionBreakpoints", breakpoints)
			.await
	}

	/// Adds, replaces, or removes one instruction breakpoint.
	pub async fn mutate_instruction_breakpoint(
		self: &Arc<Self>,
		breakpoint: Value,
		remove: bool,
	) -> Result<Value, DapSessionError> {
		let _intent_guard = self.breakpoint_intent_mutation.lock().await;
		let mut breakpoints = self.instruction_breakpoints.lock().clone();
		breakpoints.retain(|existing| {
			!same_breakpoint(existing, &breakpoint, &["instructionReference", "offset"])
		});
		if !remove {
			breakpoints.push(breakpoint);
		}
		self.set_instruction_breakpoints(breakpoints).await
	}

	/// Replaces data-breakpoint intent throughout the session tree.
	pub async fn set_data_breakpoints(
		self: &Arc<Self>,
		breakpoints: Vec<Value>,
	) -> Result<Value, DapSessionError> {
		self
			.replace_tree_breakpoints("setDataBreakpoints", breakpoints)
			.await
	}

	/// Adds, replaces, or removes one data breakpoint.
	pub async fn mutate_data_breakpoint(
		self: &Arc<Self>,
		breakpoint: Value,
		remove: bool,
	) -> Result<Value, DapSessionError> {
		let _intent_guard = self.breakpoint_intent_mutation.lock().await;
		let mut breakpoints = self.data_breakpoints.lock().clone();
		breakpoints.retain(|existing| !same_breakpoint(existing, &breakpoint, &["dataId"]));
		if !remove {
			breakpoints.push(breakpoint);
		}
		self.set_data_breakpoints(breakpoints).await
	}

	async fn replace_tree_breakpoints(
		self: &Arc<Self>,
		command: &'static str,
		breakpoints: Vec<Value>,
	) -> Result<Value, DapSessionError> {
		let mut pending = vec![Arc::clone(self)];
		let mut root_response = Value::Null;
		while let Some(session) = pending.pop() {
			let _guard = session.breakpoint_mutation.lock().await;
			match command {
				"setFunctionBreakpoints" => *session.function_breakpoints.lock() = breakpoints.clone(),
				"setInstructionBreakpoints" => {
					*session.instruction_breakpoints.lock() = breakpoints.clone()
				},
				"setDataBreakpoints" => *session.data_breakpoints.lock() = breakpoints.clone(),
				_ => return Err(DapSessionError::UnsupportedAction(DapAction::SetBreakpoint)),
			}
			let children = session
				.children
				.lock()
				.iter()
				.filter_map(Weak::upgrade)
				.collect::<Vec<_>>();
			if !Arc::ptr_eq(&session, self) && !session.supports_breakpoint_command(command) {
				pending.extend(children);
				continue;
			}
			let response = session
				.protocol
				.request(command, json!({"breakpoints": breakpoints}))
				.await?;
			if Arc::ptr_eq(&session, self) {
				root_response = response;
			}
			pending.extend(children);
		}
		Ok(root_response)
	}

	fn supports_breakpoint_command(&self, command: &str) -> bool {
		let capability = match command {
			"setFunctionBreakpoints" => "supportsFunctionBreakpoints",
			"setInstructionBreakpoints" => "supportsInstructionBreakpoints",
			"setDataBreakpoints" => "supportsDataBreakpoints",
			_ => return true,
		};
		self
			.capabilities
			.read()
			.get(capability)
			.and_then(Value::as_bool)
			.unwrap_or(false)
	}

	/// Cascades termination through children, then disconnects this adapter.
	#[tracing::instrument(
		name = "dap_session_stop",
		level = "debug",
		skip_all,
		fields(session_id = %self.id, adapter = %self.adapter)
	)]
	pub async fn terminate(self: &Arc<Self>) -> Result<(), DapSessionError> {
		let children = self
			.children
			.lock()
			.iter()
			.filter_map(Weak::upgrade)
			.collect::<Vec<_>>();
		let terminations = children
			.into_iter()
			.map(|child| async move { Box::pin(child.terminate()).await });
		for result in join_all(terminations).await {
			result?;
		}
		if self.state() != DapSessionState::Terminated {
			let _ = time::timeout(
				Duration::from_secs(1),
				self
					.protocol
					.request("terminate", json!({"restart": false})),
			)
			.await;
			let _ = time::timeout(
				Duration::from_secs(1),
				self
					.protocol
					.request("disconnect", json!({"restart": false, "terminateDebuggee": true})),
			)
			.await;
			*self.state.lock() = DapSessionState::Terminated;
		}
		self.protocol.shutdown();
		if let Some(process) = &self.process {
			let mut process = process.lock().await;
			terminate_process_group(&mut process).await?;
		}
		let terminal_processes = self.terminal_processes.lock().clone();
		for process in terminal_processes {
			let mut process = process.lock().await;
			terminate_process_group(&mut process).await?;
		}
		if let Some(path) = &self.cleanup_path {
			match tokio::fs::remove_file(path).await {
				Ok(()) => {},
				Err(error) if error.kind() == io::ErrorKind::NotFound => {},
				Err(error) => return Err(DapSessionError::Process(error)),
			}
		}
		tracing::info!("DAP session stopped");
		Ok(())
	}

	/// Runs an adapter-requested terminal process inside the workspace, captures
	/// output, and binds its lifetime to this session tree.
	pub async fn run_in_terminal(
		self: &Arc<Self>,
		workspace: &Path,
		arguments: &Value,
	) -> Result<Value, DapSessionError> {
		let argv = arguments
			.get("args")
			.and_then(Value::as_array)
			.ok_or(DapSessionError::InvalidReverseRequest)?;
		let (program, rest) = argv
			.split_first()
			.ok_or(DapSessionError::InvalidReverseRequest)?;
		let program = program
			.as_str()
			.ok_or(DapSessionError::InvalidReverseRequest)?;
		let cwd = arguments
			.get("cwd")
			.and_then(Value::as_str)
			.map(PathBuf::from)
			.unwrap_or_else(|| workspace.to_path_buf());
		let cwd = tokio::fs::canonicalize(cwd).await?;
		let workspace = tokio::fs::canonicalize(workspace).await?;
		if !cwd.starts_with(&workspace) {
			return Err(DapSessionError::InvalidReverseRequest);
		}
		let mut command = process::Command::new(program);
		command
			.args(rest.iter().map(|value| value.as_str().unwrap_or_default()))
			.current_dir(cwd)
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.kill_on_drop(true)
			.env("CI", "1")
			.env("GIT_TERMINAL_PROMPT", "0");
		if let Some(environment) = arguments.get("env").and_then(Value::as_object) {
			for (name, value) in environment {
				if let Some(value) = value.as_str() {
					command.env(name, value);
				}
			}
		}
		#[cfg(unix)]
		{
			// SAFETY: `setsid` is async-signal-safe and touches no shared Rust state.
			unsafe {
				command.pre_exec(|| {
					if libc::setsid() < 0 {
						Err(io::Error::last_os_error())
					} else {
						Ok(())
					}
				})
			};
		}
		let mut child = command.spawn()?;
		let process_id = child.id().map(u64::from);
		if let Some(stdout) = child.stdout.take() {
			spawn_output_reader(Arc::downgrade(self), stdout);
		}
		if let Some(stderr) = child.stderr.take() {
			spawn_output_reader(Arc::downgrade(self), stderr);
		}
		self
			.terminal_processes
			.lock()
			.push(Arc::new(AsyncMutex::new(child)));
		Ok(json!({"processId": process_id, "shellProcessId": process_id}))
	}

	/// Returns the retained tail of adapter/debuggee output.
	pub fn output_snapshot(&self) -> Vec<u8> {
		self.output.lock().iter().copied().collect()
	}

	fn push_output(&self, bytes: &[u8]) {
		let mut output = self.output.lock();
		let overflow = output
			.len()
			.saturating_add(bytes.len())
			.saturating_sub(MAX_OUTPUT_BYTES);
		let retained = overflow.min(output.len());
		output.drain(..retained);
		if bytes.len() >= MAX_OUTPUT_BYTES {
			output.extend(bytes[bytes.len() - MAX_OUTPUT_BYTES..].iter().copied());
		} else {
			output.extend(bytes.iter().copied());
		}
	}

	fn has_ancestor(self: &Arc<Self>, candidate: &Arc<Self>) -> bool {
		let mut cursor = self.parent.lock().as_ref().and_then(Weak::upgrade);
		while let Some(ancestor) = cursor {
			if Arc::ptr_eq(&ancestor, candidate) {
				return true;
			}
			cursor = ancestor.parent.lock().as_ref().and_then(Weak::upgrade);
		}
		false
	}

	fn touch(&self) {
		self.last_activity_ms.store(now_ms(), Ordering::Relaxed);
	}

	fn is_idle(&self, now: u64) -> bool {
		now.saturating_sub(self.last_activity_ms.load(Ordering::Relaxed))
			> IDLE_TIMEOUT.as_millis() as u64
	}
}

impl Drop for DapSession {
	fn drop(&mut self) {
		if let Some(path) = &self.cleanup_path {
			let _ = fs::remove_file(path);
		}
	}
}

/// Project-scoped live debug-session registry.
#[derive(Default)]
pub struct DapSessionRegistry {
	sessions: RwLock<BTreeMap<Str, Arc<DapSession>>>,
}

impl DapSessionRegistry {
	/// Installs or replaces one stable session identity.
	pub fn insert(&self, session: Arc<DapSession>) -> Option<Arc<DapSession>> {
		self.sessions.write().insert(session.id.clone(), session)
	}

	/// Looks up one session.
	pub fn get(&self, id: &str) -> Result<Arc<DapSession>, DapSessionError> {
		self
			.sessions
			.read()
			.get(id)
			.cloned()
			.ok_or_else(|| DapSessionError::NotFound(Str::new(id)))
	}

	/// Lists sessions in stable identity order.
	pub fn list(&self) -> Vec<Arc<DapSession>> {
		self.sessions.read().values().cloned().collect()
	}

	/// Removes terminated sessions and idle sessions whose transport is already
	/// closed.
	/// Removes terminated sessions and inactive non-attached sessions after the
	/// ten-minute idle ceiling.
	pub fn cleanup(&self) -> Vec<Str> {
		let now = now_ms();
		let removed = self
			.sessions
			.read()
			.iter()
			.filter(|&(_id, session)| {
				(session.state() == DapSessionState::Terminated)
					|| (session.is_idle(now) && !session.attached)
			})
			.map(|(id, _session)| id.clone())
			.collect::<Vec<_>>();
		let mut sessions = self.sessions.write();
		for id in &removed {
			sessions.remove(id);
		}
		removed
	}
}

async fn terminate_process_group(child: &mut Child) -> io::Result<()> {
	if child.try_wait()?.is_some() {
		return Ok(());
	}
	#[cfg(unix)]
	if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
		// SAFETY: adapter and runInTerminal children call `setsid` before exec,
		// so the negated child pid addresses only that owned process group.
		unsafe {
			libc::kill(-pid, libc::SIGKILL);
		}
		match time::timeout(Duration::from_secs(2), child.wait()).await {
			Ok(result) => {
				result?;
				return Ok(());
			},
			Err(_) => {},
		}
	}
	child.kill().await
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
}

fn spawn_output_reader<R>(session: Weak<DapSession>, mut reader: R)
where
	R: AsyncRead + Unpin + Send + 'static,
{
	tokio::spawn(async move {
		let mut buffer = [0_u8; 4096];
		loop {
			match reader.read(&mut buffer).await {
				Ok(0) | Err(_) => break,
				Ok(read) => {
					let Some(session) = session.upgrade() else {
						break;
					};
					session.push_output(&buffer[..read]);
					session.touch();
				},
			}
		}
	});
}

fn same_breakpoint(left: &Value, right: &Value, identity: &[&str]) -> bool {
	identity
		.iter()
		.all(|field| left.get(*field) == right.get(*field))
}

#[cfg(test)]
mod tests {
	use omp_core::sf;
	use tokio::{io, task::JoinHandle};

	use super::*;
	use crate::docserver::{
		dap_adapter::DapAdapterSpec,
		lsp_process::{read_frame, write_frame},
	};

	#[test]
	fn policy_tiers_are_environment_data() {
		assert_eq!("variables".parse::<DapAction>().unwrap(), DapAction::Variables);
		assert_eq!("readMemory".parse::<DapAction>().unwrap(), DapAction::ReadMemory);
		assert_eq!("stackTrace".parse::<DapAction>().unwrap(), DapAction::StackTrace);
		assert_eq!(DapAction::Variables.approval_tier(), DapApprovalTier::ReadOnly);
		assert_eq!(DapAction::Evaluate.approval_tier(), DapApprovalTier::Execution);
		assert_eq!(DapAction::Continue.approval_tier(), DapApprovalTier::Execution);
		assert_eq!(DapAction::SetBreakpoint.approval_tier(), DapApprovalTier::Execution);
	}

	fn fake_adapter(
		supports_configuration_done: bool,
	) -> (DapProtocol, Arc<Mutex<Vec<Str>>>, JoinHandle<()>) {
		let (client, mut adapter) = io::duplex(16 * 1024);
		let (reader, writer) = io::split(client);
		let protocol = DapProtocol::from_streams(reader, writer);
		let requests = Arc::new(Mutex::new(Vec::new()));
		let request_log = Arc::clone(&requests);
		let task = tokio::spawn(async move {
			loop {
				let Ok(body) = read_frame(&mut adapter, 8 * 1024, 16 * 1024 * 1024).await else {
					break;
				};
				let request: Value = serde_json::from_slice(&body).unwrap();
				let request_seq = request["seq"].as_i64().unwrap();
				let command = request["command"].as_str().unwrap();
				request_log.lock().push(Str::new(command));
				let response_body = if command == "initialize" {
					json!({"supportsConfigurationDoneRequest": supports_configuration_done})
				} else {
					json!({})
				};
				let response = json!({
					"seq": 100,
					"type": "response",
					"request_seq": request_seq,
					"command": command,
					"success": true,
					"body": response_body,
				});
				let body = serde_json::to_vec(&response).unwrap();
				write_frame(&mut adapter, &body).await.unwrap();
				if command == "initialize" && supports_configuration_done {
					let event = serde_json::to_vec(&json!({
						"seq": 101,
						"type": "event",
						"event": "initialized",
						"body": {},
					}))
					.unwrap();
					write_frame(&mut adapter, &event).await.unwrap();
				}
			}
		});
		(protocol, requests, task)
	}

	fn adapter_arguments(skip_attach_request: bool) -> Map<String, Value> {
		let mut spec = DapAdapterSpec::new("test", "test").unwrap();
		spec
			.attach_defaults
			.insert("request".to_owned(), Value::String("attach".to_owned()));
		if skip_attach_request {
			spec
				.attach_defaults
				.insert(SKIP_ATTACH_REQUEST.to_owned(), Value::Bool(true));
		}
		spec.merged_arguments(true, &Map::new())
	}

	async fn stop_fake_adapter(session: &DapSession, task: JoinHandle<()>) {
		session.protocol.shutdown();
		task.abort();
		let _ = task.await;
	}

	fn handshake_requests(requests: &Mutex<Vec<Str>>) -> Vec<Str> {
		requests
			.lock()
			.iter()
			.filter(|command| {
				matches!(command.as_str(), "initialize" | "attach" | "launch" | "configurationDone")
			})
			.cloned()
			.collect()
	}

	#[tokio::test]
	async fn output_ring_keeps_only_the_newest_bytes() {
		let (stream, _) = io::duplex(64);
		let (reader, writer) = io::split(stream);
		let session = DapSession {
			id: sf!("test"),
			adapter: sf!("test"),
			protocol: DapProtocol::from_streams(reader, writer),
			process: None,
			adapter_process_id: None,
			debuggee_process_id: AtomicU64::new(0),
			terminal_processes: Mutex::new(Vec::new()),
			cleanup_path: None,
			attached: false,
			state: Mutex::new(DapSessionState::Running),
			stopped: Mutex::new(None),
			capabilities: RwLock::new(Value::Null),
			output: Mutex::new(VecDeque::new()),
			last_activity_ms: AtomicU64::new(0),
			revision: AtomicU64::new(1),
			event_sequence: AtomicU64::new(0),
			read_granted: AtomicBool::new(false),
			execute_granted: AtomicBool::new(false),
			event_byte_limit: AtomicU64::new(0),
			parent: Mutex::new(None),
			children: Mutex::new(Vec::new()),
			breakpoint_mutation: AsyncMutex::new(()),
			breakpoint_intent_mutation: AsyncMutex::new(()),
			source_breakpoints: Mutex::new(BTreeMap::new()),
			function_breakpoints: Mutex::new(Vec::new()),
			instruction_breakpoints: Mutex::new(Vec::new()),
			data_breakpoints: Mutex::new(Vec::new()),
			handler: Arc::new(RejectReverseRequests),
		};
		session.push_output(&vec![b'a'; MAX_OUTPUT_BYTES]);
		session.push_output(b"tail");
		let output = session.output_snapshot();
		assert_eq!(output.len(), MAX_OUTPUT_BYTES);
		assert_eq!(&output[output.len() - 4..], b"tail");
	}

	#[tokio::test]
	async fn preattached_session_without_configuration_done_starts_running_immediately() {
		let (protocol, requests, adapter) = fake_adapter(false);
		let session =
			DapSession::start("preattached", "test", protocol, true, adapter_arguments(true), None)
				.await
				.unwrap();

		assert_eq!(session.state(), DapSessionState::Running);
		assert_eq!(handshake_requests(&requests), vec![Str::new_static("initialize")]);
		stop_fake_adapter(&session, adapter).await;
	}

	#[tokio::test]
	async fn preattached_session_completes_configuration_without_attach_request() {
		let (protocol, requests, adapter) = fake_adapter(true);
		let session =
			DapSession::start("preattached", "test", protocol, true, adapter_arguments(true), None)
				.await
				.unwrap();

		assert_eq!(session.state(), DapSessionState::Running);
		assert_eq!(handshake_requests(&requests), vec![
			Str::new_static("initialize"),
			Str::new_static("configurationDone"),
		]);
		stop_fake_adapter(&session, adapter).await;
	}

	#[tokio::test]
	async fn normal_attach_request_and_configuration_handshake_are_unchanged() {
		let (protocol, requests, adapter) = fake_adapter(true);
		let session =
			DapSession::start("attached", "test", protocol, true, adapter_arguments(false), None)
				.await
				.unwrap();

		assert_eq!(session.state(), DapSessionState::Running);
		let requests = handshake_requests(&requests);
		assert_eq!(
			requests
				.iter()
				.filter(|command| command.as_str() == "attach")
				.count(),
			1
		);
		assert!(
			requests
				.iter()
				.any(|command| command.as_str() == "configurationDone")
		);
		stop_fake_adapter(&session, adapter).await;
	}
}
