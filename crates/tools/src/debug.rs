//! Revisioned model-facing Debug Adapter Protocol tool.

use std::{collections::BTreeMap, future::Future, time::Duration};

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use omp_core::{Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CallOutcome, CommitError, Constraint, Diag, Effects, Ev,
	ExecEffects, ExecutionMode, IncomingParams, LiftedCall, ParamError, Part, PromptCaps,
	RecordedCall, Rev, Tool, ToolSpec, ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// One discoverable debugger operation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, strum::Display)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Action {
	/// Launch a program under a discovered adapter.
	Launch,
	/// Attach to a configured process or remote adapter.
	Attach,
	/// Add or replace a source breakpoint.
	SetBreakpoint,
	/// Remove a source breakpoint.
	RemoveBreakpoint,
	/// Add or replace an instruction breakpoint.
	SetInstructionBreakpoint,
	/// Remove an instruction breakpoint.
	RemoveInstructionBreakpoint,
	/// Resolve a data-breakpoint identifier.
	DataBreakpointInfo,
	/// Add or replace a data breakpoint.
	SetDataBreakpoint,
	/// Remove a data breakpoint.
	RemoveDataBreakpoint,
	/// Continue execution.
	Continue,
	/// Pause execution.
	Pause,
	/// Step over the current statement.
	StepOver,
	/// Step into the current statement.
	StepIn,
	/// Step out of the current frame.
	StepOut,
	/// List threads.
	Threads,
	/// Read stack frames.
	StackTrace,
	/// Read frame scopes.
	Scopes,
	/// Read variables with paging.
	Variables,
	/// Evaluate an expression.
	Evaluate,
	/// Disassemble instructions.
	Disassemble,
	/// Read process memory.
	ReadMemory,
	/// Write process memory.
	WriteMemory,
	/// List loaded modules.
	Modules,
	/// List loaded sources.
	LoadedSources,
	/// Send an adapter extension request.
	CustomRequest,
	/// Read the bounded output tail.
	Output,
	/// List live sessions.
	Sessions,
	/// Terminate a session tree.
	Terminate,
}

impl Action {
	/// Whether the Environment classifies this action as inspection-only.
	pub const fn read_only(self) -> bool {
		matches!(
			self,
			Self::Threads
				| Self::StackTrace
				| Self::Scopes
				| Self::Variables
				| Self::Disassemble
				| Self::ReadMemory
				| Self::Modules
				| Self::LoadedSources
				| Self::Output
				| Self::Sessions
		)
	}
}

/// Data-breakpoint access mode.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, strum::Display)]
pub enum AccessType {
	/// Break on reads.
	#[serde(rename = "read")]
	#[strum(serialize = "read")]
	Read,
	/// Break on writes.
	#[serde(rename = "write")]
	#[strum(serialize = "write")]
	Write,
	/// Break on reads and writes.
	#[serde(rename = "readWrite")]
	#[strum(serialize = "readWrite")]
	ReadWrite,
}

/// Arguments for `debug@2`; fields mirror the current pi DAP contract.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Operation discriminator.
	pub action:                Action,
	/// Debug target path; Delve accepts package directories.
	#[serde(default)]
	pub program:               Option<Str>,
	/// Program arguments.
	#[serde(default)]
	pub args:                  Option<Vec<Str>>,
	/// Adapter name for launch or attach.
	#[serde(default)]
	pub adapter:               Option<Str>,
	/// Launch or attach working directory.
	#[serde(default)]
	pub cwd:                   Option<Str>,
	/// Source file for source breakpoints.
	#[serde(default)]
	pub file:                  Option<Str>,
	/// One-based source line.
	#[serde(default)]
	pub line:                  Option<u32>,
	/// Function-breakpoint name.
	#[serde(default)]
	pub function:              Option<Str>,
	/// Variable or data name for `data_breakpoint_info`.
	#[serde(default)]
	pub name:                  Option<Str>,
	/// Breakpoint condition.
	#[serde(default)]
	pub condition:             Option<Str>,
	/// Breakpoint hit condition.
	#[serde(default)]
	pub hit_condition:         Option<Str>,
	/// Expression to evaluate.
	#[serde(default)]
	pub expression:            Option<Str>,
	/// Evaluation context.
	#[serde(default)]
	pub context:               Option<Str>,
	/// Frame identity; omitted values use the current stopped frame.
	#[serde(default)]
	pub frame_id:              Option<i64>,
	/// Scope variables reference.
	#[serde(default)]
	pub scope_id:              Option<i64>,
	/// Variable reference, preferred over `scope_id`.
	#[serde(default)]
	pub variable_ref:          Option<i64>,
	/// Process identity for attach.
	#[serde(default)]
	pub pid:                   Option<u32>,
	/// Configured remote adapter port.
	#[serde(default)]
	pub port:                  Option<u16>,
	/// Configured remote adapter host.
	#[serde(default)]
	pub host:                  Option<Str>,
	/// Maximum stack-frame count.
	#[serde(default)]
	pub levels:                Option<u32>,
	/// Adapter memory reference.
	#[serde(default)]
	pub memory_reference:      Option<Str>,
	/// Instruction address/reference for instruction breakpoints.
	#[serde(default)]
	pub instruction_reference: Option<Str>,
	/// Number of instructions to disassemble.
	#[serde(default)]
	pub instruction_count:     Option<u32>,
	/// Instruction offset relative to the memory reference.
	#[serde(default)]
	pub instruction_offset:    Option<i64>,
	/// Requested memory byte count.
	#[serde(default)]
	pub count:                 Option<u32>,
	/// Base64 bytes for `write_memory`.
	#[serde(default)]
	pub data:                  Option<Str>,
	/// Data-breakpoint identifier.
	#[serde(default)]
	pub data_id:               Option<Str>,
	/// Data-breakpoint access type.
	#[serde(default)]
	pub access_type:           Option<AccessType>,
	/// Adapter-specific request command.
	#[serde(default)]
	pub command:               Option<Str>,
	/// Raw custom-request fields.
	#[serde(default)]
	pub arguments:             Option<BTreeMap<Str, Value>>,
	/// Instruction or memory offset.
	#[serde(default)]
	pub offset:                Option<i64>,
	/// Ask the adapter to resolve symbols while disassembling.
	#[serde(default)]
	pub resolve_symbols:       Option<bool>,
	/// Permit a partial memory write.
	#[serde(default)]
	pub allow_partial:         Option<bool>,
	/// Module-page start.
	#[serde(default)]
	pub start_module:          Option<u32>,
	/// Module-page count.
	#[serde(default)]
	pub module_count:          Option<u32>,
	/// Wall-clock timeout in seconds, clamped to 5–300.
	#[serde(default)]
	pub timeout:               Option<f64>,
}

/// Durable debug result independent of the renderer.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Payload {
	/// Applied action.
	pub action:   Action,
	/// Current session identity, when applicable.
	pub session:  Option<Str>,
	/// Current revision fence.
	pub revision: Option<u64>,
	/// Bounded model projection.
	pub output:   Str,
	/// Structured snapshot for enhanced views.
	pub data:     Value,
	/// Harness diagnostics produced while bounding the projection.
	#[serde(skip)]
	pub diags:    Vec<Diag>,
}

/// Debug operations do not stream speculative updates.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub enum Update {}

/// Typed debug tool failure.
#[derive(Clone, Debug, Deserialize, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// Arguments do not satisfy the selected action.
	#[error("invalid debug action arguments")]
	InvalidArguments,
	/// No compatible adapter or session is available.
	#[error("debug adapter or session is unavailable")]
	Unavailable,
	/// Environment policy rejected the action tier.
	#[error("debug action is not authorized")]
	Unauthorized,
	/// Session revision no longer matches.
	#[error("debug session revision is stale")]
	Stale,
	/// Adapter request failed.
	#[error("debug adapter request failed")]
	Adapter,
	/// Bounded deadline elapsed.
	#[error("debug action timed out")]
	TimedOut,
	/// Caller cancelled the action.
	#[error("debug action was cancelled")]
	Cancelled,
}

/// Application-owned env/v1 bridge.
pub trait DebugControl: Clone + Send + Sync + 'static {
	/// Executes one validated action exclusively through the Environment DAP
	/// wire.
	fn execute(
		&self,
		params: Params,
		timeout: Duration,
		cancel: CancellationToken,
	) -> impl Future<Output = Result<Payload, Fault>> + Send + '_;
}

/// Frozen `debug@2` binding.
pub struct DebugTool<C> {
	control: C,
	maximum: Duration,
	spec:    ToolSpec,
}

/// Returns the host-free `debug@2` specification.
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("debug"),
		rev:             Rev { family: Str::default(), n: 2 },
		description:     sf!(
			"Launches or attaches native debug adapters; manages all breakpoint families, execution, \
			 stack and variable inspection, disassembly, memory, output, sessions, custom requests, \
			 and termination."
		),
		schema:          omp_tool::schema::<Params>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         Effects {
			documents: None,
			exec:      Some(ExecEffects {
				commands: [sf!("*")].into_iter().collect(),
				network:  false,
			}),
			inference: None,
			desktop:   None,
			subagents: 0,
		},
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("debug.rs"),
		)
		.into(),
	}
}

/// Creates the revisioned debug tool.
pub fn tool<C: DebugControl>(control: C, maximum: Duration) -> DebugTool<C> {
	DebugTool {
		control,
		maximum: maximum.clamp(Duration::from_secs(5), Duration::from_secs(300)),
		spec: spec(),
	}
}

impl<C: DebugControl> Tool for DebugTool<C> {
	type Fault = Fault;
	type Params = Params;
	type Payload = Payload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn execution_mode(&self) -> ExecutionMode {
		ExecutionMode::Sequential
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, Payload, Fault>> + Send + 'c {
		stream! {
			let params = match incoming.interruptable().whole::<Params>().await {
				Ok(params) => params,
				Err(error) => { yield param_event(error); return; },
			};
			if !valid(&params) {
				yield done(Err(Fault::InvalidArguments), true);
				return;
			}
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			let timeout = Duration::from_secs_f64(params.timeout.unwrap_or(30.0).clamp(5.0, 300.0))
				.min(self.maximum);
			let cancel = CancellationToken::new();
			let execution = self.control.execute(params, timeout, cancel.clone());
			let deadline = tokio::time::sleep(timeout);
			tokio::pin!(execution, deadline);
			tokio::select! {
				biased;
				interrupt = incoming.next_interrupt() => {
					cancel.cancel();
					if let Ok(interrupt) = interrupt {
						yield Ev::Aborted(Abort::Interrupted { reason: interrupt.reason });
					} else {
						yield Ev::Aborted(Abort::InputDropped);
					}
				},
				result = &mut execution => match result {
					Ok(mut payload) => {
						for diag in payload.diags.drain(..) {
							yield Ev::Diag(diag);
						}
						yield done(Ok(payload), false);
					},
					Err(fault) => yield done(Err(fault), true),
				},
				() = &mut deadline => {
					cancel.cancel();
					yield done(Err(Fault::TimedOut), true);
				},
			}
		}
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, _: &PromptCaps) -> Vec<Part> {
		let text = match view {
			Ok(payload) => payload.output.clone(),
			Err(fault) => Str::new(fault.to_string()),
		};
		vec![Part::Text { text }]
	}

	fn lift(&self, from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
		lift_legacy_call(from, call)
	}
}

fn lift_legacy_call(from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
	if !from.family.is_empty() || from.n != 1 {
		return None;
	}
	let mut raw_args = serde_json::from_slice::<Value>(call.raw_args).ok()?;
	let object = raw_args.as_object_mut()?;
	let intent = object.remove("i");
	let notrunc = object.remove("notrunc");
	object.remove("session");
	let legacy_function_action = match object.get("action").and_then(Value::as_str) {
		Some("set_function_breakpoint") => Some("set_breakpoint"),
		Some("remove_function_breakpoint") => Some("remove_breakpoint"),
		_ => None,
	};
	if let Some(action) = legacy_function_action {
		object.insert("action".to_owned(), Value::String(action.to_owned()));
	}
	if let Some(path) = object.remove("path") {
		let action = object.get("action").and_then(Value::as_str)?;
		object.insert(
			if action == "launch" {
				"program"
			} else {
				"file"
			}
			.to_owned(),
			path,
		);
	}
	if let Some(reference) = object.remove("variables_reference") {
		object.insert("variable_ref".to_owned(), reference);
	}
	if let Some(count) = object.get("count").cloned()
		&& object.get("action").and_then(Value::as_str) == Some("disassemble")
	{
		object.insert("instruction_count".to_owned(), count);
	}
	let params = serde_json::from_value::<Params>(raw_args.clone()).ok()?;
	if !valid(&params) {
		return None;
	}
	let mut raw_verdict = serde_json::from_slice::<Value>(call.verdict).ok()?;
	if let Some(action) = legacy_function_action
		&& let Some(value) = raw_verdict.get_mut("value")
	{
		value["action"] = Value::String(action.to_owned());
	}
	let verdict = serde_json::from_value::<CallOutcome<Payload, Fault>>(raw_verdict).ok()?;
	let lifted = raw_args.as_object_mut()?;
	if let Some(intent) = intent {
		lifted.insert("i".to_owned(), intent);
	}
	if let Some(notrunc) = notrunc {
		lifted.insert("notrunc".to_owned(), notrunc);
	}
	Some(LiftedCall {
		raw_args: Bytes::from(serde_json::to_vec(&raw_args).ok()?),
		verdict:  Bytes::from(serde_json::to_vec(&verdict).ok()?),
	})
}

fn valid(params: &Params) -> bool {
	if params.line == Some(0) {
		return false;
	}
	match params.action {
		Action::Launch => params
			.program
			.as_ref()
			.is_some_and(|value| !value.is_empty()),
		Action::Attach => {
			params
				.adapter
				.as_ref()
				.is_some_and(|value| !value.is_empty())
				|| params.pid.is_some()
				|| params.port.is_some()
		},
		Action::Sessions | Action::Output | Action::Terminate => true,
		Action::SetBreakpoint | Action::RemoveBreakpoint => {
			params
				.function
				.as_ref()
				.is_some_and(|value| !value.is_empty())
				|| (params.file.is_some() && params.line.is_some())
		},
		Action::SetInstructionBreakpoint | Action::RemoveInstructionBreakpoint => {
			params.instruction_reference.is_some()
		},
		Action::SetDataBreakpoint | Action::RemoveDataBreakpoint => params.data_id.is_some(),
		Action::DataBreakpointInfo => params.name.is_some(),
		Action::Variables => params.variable_ref.is_some() || params.scope_id.is_some(),
		Action::Evaluate => params.expression.is_some(),
		Action::Disassemble => params.instruction_count.is_some(),
		Action::ReadMemory => params.memory_reference.is_some() && params.count.is_some(),
		Action::WriteMemory => params.memory_reference.is_some() && params.data.is_some(),
		Action::CustomRequest => params.command.is_some(),
		Action::Continue
		| Action::Pause
		| Action::StepOver
		| Action::StepIn
		| Action::StepOut
		| Action::Threads
		| Action::StackTrace
		| Action::Scopes
		| Action::Modules
		| Action::LoadedSources => true,
	}
}

const fn done(result: Result<Payload, Fault>, useless: bool) -> Ev<Update, Payload, Fault> {
	Ev::Done(ToolTerminal::Done { result, useless })
}

fn param_event(error: ParamError) -> Ev<Update, Payload, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn commit_event(error: CommitError) -> Ev<Update, Payload, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  Some(Str::new_static(r#"{"action":"sessions"}"#)),
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use std::sync::{Arc, Mutex};

	use futures::StreamExt as _;

	use super::*;

	#[derive(Clone, Default)]
	struct CancellationControl(Arc<Mutex<Option<CancellationToken>>>);

	impl DebugControl for CancellationControl {
		fn execute(
			&self,
			_: Params,
			_: Duration,
			cancel: CancellationToken,
		) -> impl Future<Output = Result<Payload, Fault>> + Send + '_ {
			self
				.0
				.lock()
				.expect("cancellation control")
				.replace(cancel.clone());
			async move {
				cancel.cancelled().await;
				Err(Fault::Cancelled)
			}
		}
	}

	#[test]
	fn schema_matches_current_pi_action_and_argument_vocabulary() {
		let schema: Value = serde_json::from_slice(&spec().schema).expect("debug schema JSON");
		assert_eq!(spec().rev.n, 2);
		assert_eq!(
			tool(CancellationControl::default(), Duration::from_secs(300)).execution_mode(),
			ExecutionMode::Sequential
		);
		assert_eq!(schema["additionalProperties"], false);
		assert_eq!(schema["required"], serde_json::json!(["i", "action"]));
		for action in [
			"launch",
			"attach",
			"set_breakpoint",
			"remove_breakpoint",
			"set_instruction_breakpoint",
			"remove_instruction_breakpoint",
			"data_breakpoint_info",
			"set_data_breakpoint",
			"remove_data_breakpoint",
			"continue",
			"step_over",
			"step_in",
			"step_out",
			"pause",
			"evaluate",
			"stack_trace",
			"threads",
			"scopes",
			"variables",
			"disassemble",
			"read_memory",
			"write_memory",
			"modules",
			"loaded_sources",
			"custom_request",
			"output",
			"terminate",
			"sessions",
		] {
			assert!(serde_json::from_value::<Action>(serde_json::json!(action)).is_ok());
		}
		let properties = schema["properties"].as_object().expect("properties object");
		assert_eq!(
			properties
				.keys()
				.map(String::as_str)
				.collect::<std::collections::BTreeSet<_>>(),
			[
				"access_type",
				"action",
				"adapter",
				"allow_partial",
				"args",
				"arguments",
				"command",
				"condition",
				"context",
				"count",
				"cwd",
				"data",
				"data_id",
				"expression",
				"file",
				"frame_id",
				"function",
				"hit_condition",
				"host",
				"i",
				"instruction_count",
				"instruction_offset",
				"instruction_reference",
				"levels",
				"line",
				"memory_reference",
				"module_count",
				"name",
				"notrunc",
				"offset",
				"pid",
				"port",
				"program",
				"resolve_symbols",
				"scope_id",
				"start_module",
				"timeout",
				"variable_ref",
			]
			.into_iter()
			.collect()
		);
		assert_eq!(schema["properties"]["arguments"]["type"], serde_json::json!(["object", "null"]));
		assert!(schema["properties"]["timeout"].get("minimum").is_none());
		assert!(schema["properties"]["timeout"].get("maximum").is_none());
	}

	#[tokio::test]
	async fn caller_interrupt_cancels_the_in_flight_adapter_request() {
		let control = CancellationControl::default();
		let debug = tool(control.clone(), Duration::from_secs(300));
		let raw = r#"{"action":"sessions"}"#;
		let (feed, incoming) = IncomingParams::channel();
		feed.arg_text(raw.into()).expect("stream args");
		feed.args_committed(raw.into()).expect("commit args");
		feed
			.interrupt(omp_tool::Interrupt {
				class:  Str::new_static(omp_tool::Interrupt::ESCAPE),
				reason: Str::new_static("user interrupted debug"),
			})
			.expect("interrupt request");
		let events = debug.call(incoming).collect::<Vec<_>>().await;
		assert!(matches!(
			events.last(),
			Some(Ev::Aborted(Abort::Interrupted { reason })) if reason == "user interrupted debug"
		));
		assert!(
			control
				.0
				.lock()
				.expect("cancellation control")
				.as_ref()
				.is_some_and(CancellationToken::is_cancelled),
		);
	}

	#[test]
	fn legacy_revision_lifts_only_valid_calls_and_renames_fields() {
		let debug = tool(CancellationControl::default(), Duration::from_secs(300));
		let args =
			br#"{"i":"Reading memory","action":"read_memory","session":"old","memory_reference":"0x10","count":8}"#;
		let verdict = serde_json::to_vec(&CallOutcome::<Payload, Fault>::Ok(Payload {
			action:   Action::ReadMemory,
			session:  Some(Str::new_static("old")),
			revision: Some(4),
			output:   Str::new_static("0x10+0000  00"),
			data:     serde_json::json!({"address":"0x10","data":"AA=="}),
			diags:    Vec::new(),
		}))
		.expect("verdict JSON");
		let lifted = debug
			.lift(&Rev { family: Str::default(), n: 1 }, RecordedCall {
				raw_args: args,
				verdict:  &verdict,
			})
			.expect("compatible debug@1 call");
		let lifted_args: Value = serde_json::from_slice(&lifted.raw_args).expect("lifted args");
		assert_eq!(lifted_args["i"], "Reading memory");
		assert!(lifted_args.get("session").is_none());
		assert!(
			debug
				.lift(&Rev { family: Str::default(), n: 1 }, RecordedCall {
					raw_args: br#"{"action":"launch"}"#,
					verdict:  &verdict,
				},)
				.is_none()
		);
	}

	#[tokio::test]
	async fn semantic_projection_is_bounded_after_formatting() {
		#[derive(Clone)]
		struct ImmediateControl {
			data: Value,
		}

		impl DebugControl for ImmediateControl {
			fn execute(
				&self,
				_: Params,
				_: Duration,
				_: CancellationToken,
			) -> impl Future<Output = Result<Payload, Fault>> + Send + '_ {
				let rendered = debug_render::render(Action::Variables, &self.data);
				std::future::ready(Ok(Payload {
					action:   Action::Variables,
					session:  None,
					revision: None,
					output:   rendered.text,
					data:     self.data.clone(),
					diags:    rendered.diags,
				}))
			}
		}

		let huge = "x".repeat(128 * 1024);
		let debug = tool(
			ImmediateControl {
				data: serde_json::json!({
					"variables": [{
						"name":"value",
						"type":"str",
						"value":huge,
						"variablesReference":0
					}]
				}),
			},
			Duration::from_secs(300),
		);
		let raw = r#"{"action":"variables","variable_ref":1}"#;
		let (feed, incoming) = IncomingParams::channel();
		feed.arg_text(raw.into()).expect("stream args");
		feed.args_committed(raw.into()).expect("commit args");
		let events = debug.call(incoming).collect::<Vec<_>>().await;
		let diag = events
			.iter()
			.find_map(|event| match event {
				Ev::Diag(diag) => Some(diag),
				_ => None,
			})
			.expect("output-bounded diagnostic");
		assert_eq!(diag.native_kind(), Some(omp_tool::DiagKind::OutputBounded));
		assert_eq!(diag.severity, omp_tool::Severity::Info);
		assert!(matches!(
			diag.omitted.as_ref(),
			Some(omp_tool::Omitted { count, unit: omp_tool::Unit::Bytes }) if *count > 0
		));
		let output = events
			.iter()
			.find_map(|event| match event {
				Ev::Done(ToolTerminal::Done { result: Ok(payload), .. }) => Some(&payload.output),
				_ => None,
			})
			.expect("terminal debug payload");
		assert!(output.len() < 34 * 1024);
		assert!(!output.contains("omitted"));
		assert!(!output.contains("truncated"));
	}
}
