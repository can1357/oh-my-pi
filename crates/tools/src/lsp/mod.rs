//! Revisioned model-facing Language Server Protocol tool.

use std::{future::Future, sync::Arc, time::Duration};

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use omp_core::{FastHashSet, Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CallOutcome, CommitError, Constraint, Diag, DiagKind, DocEffects,
	Effects, Ev, IncomingParams, LiftedCall, ParamError, Part, PromptCaps, RecordedCall, Rev, Tool,
	ToolSpec, ToolTerminal, Unit,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub mod actions;
pub mod checkers;
pub mod diagnostics;
pub mod navigation;
pub mod refactor;
pub mod render;

/// One discoverable LSP operation.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	JsonSchema,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Action {
	/// Fresh diagnostics for a file, capped glob, or `*` workspace.
	Diagnostics,
	/// Go to definition.
	Definition,
	/// Go to type definition.
	TypeDefinition,
	/// Go to implementation.
	Implementation,
	/// Find references.
	References,
	/// Resolve hover documentation.
	Hover,
	/// List document or workspace symbols.
	Symbols,
	/// Preview or apply a symbol rename.
	Rename,
	/// Plan and atomically apply a path rename with import updates.
	RenameFile,
	/// List, resolve, or execute code actions.
	CodeActions,
	/// Send an advanced raw LSP request.
	Request,
	/// Report selected server capabilities.
	Capabilities,
	/// Report native daemon and binding status.
	Status,
	/// Reload selected native bindings.
	Reload,
}

impl Action {
	/// Whether the action may mutate workspace state.
	pub const fn mutative(self, apply: Option<bool>) -> bool {
		match self {
			Self::Rename | Self::RenameFile => !matches!(apply, Some(false)),
			Self::CodeActions => matches!(apply, Some(true)),
			Self::Reload => true,
			_ => false,
		}
	}
}

/// Arguments for `lsp@3`.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Operation discriminator.
	pub action:   Action,
	/// Workspace-relative file, glob for diagnostics, or `*` workspace.
	#[serde(default)]
	pub file:     Option<Str>,
	/// One-based source line.
	#[serde(default)]
	pub line:     Option<u32>,
	/// Identifier or `identifier#N` one-based occurrence target. Required for
	/// project-aware definition, references, and rename requests.
	#[serde(default)]
	pub symbol:   Option<Str>,
	/// Workspace symbol query, zero-based code-action index/title substring,
	/// or raw request method.
	#[serde(default)]
	pub query:    Option<Str>,
	/// New identifier for rename, or destination path for `rename_file`.
	#[serde(default)]
	pub new_name: Option<Str>,
	/// Apply a symbol/path rename or code action; false requests a dry-run.
	#[serde(default)]
	pub apply:    Option<bool>,
	/// Wall-clock timeout in seconds, clamped to 5–300 and the configured
	/// maximum.
	#[serde(default)]
	#[schemars(range(min = 5, max = 300))]
	pub timeout:  Option<u64>,
	/// Raw JSON parameters for `request`. When omitted, textDocument and
	/// position are derived from `file`, `line`, and `symbol`.
	#[serde(default)]
	pub payload:  Option<Str>,
}

/// Durable typed result independent of the interactive renderer.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Payload {
	/// Applied action.
	pub action:  Action,
	/// Selected binding names.
	pub servers: Vec<Str>,
	/// Bounded model-visible projection.
	pub output:  Str,
	/// Structured revisioned result used by enhanced views.
	pub data:    Value,
	/// Diagnostic findings excluded from the bounded projection.
	#[serde(default)]
	pub omitted: usize,
}
/// One language-server failure retained during a workspace-symbol fanout.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspaceSymbolFailure {
	/// Configured server name.
	pub server:  Str,
	/// Server or transport failure detail.
	pub message: Str,
}

/// One completed language-server branch of a workspace-symbol fanout.
#[derive(Clone, Debug)]
pub struct WorkspaceSymbolOutcome {
	/// Configured server name.
	pub server: Str,
	/// Successful JSON result or failure detail.
	pub result: Result<Value, Str>,
}

/// LSP operations do not stream intermediate updates.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub enum Update {}

/// Typed LSP tool failure.
#[derive(Clone, Debug, Deserialize, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// Arguments do not describe a valid action.
	#[error("invalid LSP action arguments")]
	InvalidArguments,
	/// No native binding applies.
	#[error("no language server is available for this target")]
	Unavailable,
	/// Environment policy rejected the action tier.
	#[error("LSP action is not authorized")]
	Unauthorized,
	/// Selected binding timed out.
	#[error("LSP action timed out")]
	TimedOut,
	/// Server returned a protocol error.
	#[error("language server request failed")]
	Server,
	/// Every server selected for a workspace-symbol search failed.
	#[error("{message}")]
	WorkspaceSymbols {
		/// Stable per-server failures.
		failures: Vec<WorkspaceSymbolFailure>,
		/// Human-readable aggregate retaining every server name and detail.
		message:  Str,
	},
	/// Transactional workspace edit was rejected or rolled back.
	#[error("LSP workspace edit failed")]
	WorkspaceEdit,
	/// Caller cancelled the action.
	#[error("LSP action was cancelled")]
	Cancelled,
}

impl Fault {
	/// Constructs an all-failed workspace-symbol error without discarding any
	/// server's identifying detail.
	pub fn workspace_symbols(failures: Vec<WorkspaceSymbolFailure>) -> Self {
		let details = workspace_failure_lines(&failures);
		Self::WorkspaceSymbols {
			message: Str::from(format!(
				"Workspace symbol search failed: all language servers failed\nServer failures:\n{}",
				details.join("\n")
			)),
			failures,
		}
	}
}

/// Aggregates workspace-symbol fanout results while retaining partial failures.
///
/// An empty result is still a successful response from that server. Only a
/// fanout in which every branch failed becomes [`Fault::WorkspaceSymbols`].
pub fn aggregate_workspace_symbols(
	query: &str,
	outcomes: Vec<WorkspaceSymbolOutcome>,
) -> Result<Payload, Fault> {
	let mut servers = Vec::new();
	let mut symbols = Vec::new();
	let mut failures = Vec::new();
	for outcome in outcomes {
		match outcome.result {
			Ok(Value::Array(mut result)) => {
				servers.push(outcome.server);
				symbols.append(&mut result);
			},
			Ok(Value::Null) => servers.push(outcome.server),
			Ok(result) => {
				servers.push(outcome.server);
				symbols.push(result);
			},
			Err(message) => {
				failures.push(WorkspaceSymbolFailure { server: outcome.server, message });
			},
		}
	}
	if servers.is_empty() {
		return Err(Fault::workspace_symbols(failures));
	}
	let query_folded = query.trim().to_ascii_lowercase();
	if !query_folded.is_empty() {
		symbols.retain(|symbol| {
			[
				symbol
					.get("name")
					.and_then(Value::as_str)
					.unwrap_or_default(),
				symbol
					.get("containerName")
					.and_then(Value::as_str)
					.unwrap_or_default(),
				symbol
					.pointer("/location/uri")
					.and_then(Value::as_str)
					.unwrap_or_default(),
			]
			.iter()
			.any(|field| field.to_ascii_lowercase().contains(query_folded.as_str()))
		});
	}
	let mut seen = FastHashSet::default();
	symbols.retain(|symbol| {
		let identity = (
			Str::from(
				symbol
					.get("name")
					.and_then(Value::as_str)
					.unwrap_or_default(),
			),
			Str::from(
				symbol
					.get("containerName")
					.and_then(Value::as_str)
					.unwrap_or_default(),
			),
			symbol.get("kind").and_then(Value::as_u64),
			Str::from(
				symbol
					.pointer("/location/uri")
					.and_then(Value::as_str)
					.unwrap_or_default(),
			),
			symbol
				.pointer("/location/range/start/line")
				.and_then(Value::as_u64),
			symbol
				.pointer("/location/range/start/character")
				.and_then(Value::as_u64),
		);
		seen.insert(identity)
	});
	let total = symbols.len();
	let mut output = if symbols.is_empty() {
		format!("No symbols matching \"{query}\"")
	} else {
		format!(
			"Found {total} symbol(s) matching \"{query}\":\n{}",
			render::structured(&Value::Array(symbols.clone()), symbols.len())
		)
	};
	if !failures.is_empty() {
		output.push_str("\nServer failures:\n");
		output.push_str(&workspace_failure_lines(&failures).join("\n"));
	}
	Ok(Payload {
		action: Action::Symbols,
		servers,
		output: Str::from(output),
		data: Value::Array(symbols),
		omitted: 0,
	})
}

fn workspace_failure_lines(failures: &[WorkspaceSymbolFailure]) -> Vec<String> {
	failures
		.iter()
		.map(|failure| {
			format!("  {}: {}", failure.server, failure.message.as_str().replace('\t', "    "))
		})
		.collect()
}

/// Application-owned bridge to the project Environment's document authority.
pub trait LspControl: Clone + Send + Sync + 'static {
	/// Executes one validated action under the supplied bounded deadline.
	fn execute(
		&self,
		params: Params,
		timeout: Duration,
		cancel: CancellationToken,
	) -> impl Future<Output = Result<Payload, Fault>> + Send + '_;
}

/// Frozen LSP tool binding.
pub struct LspTool<C> {
	control: C,
	maximum: Duration,
	spec:    ToolSpec,
}

/// Returns the host-free `lsp@3` specification.
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("lsp"),
		rev:             Rev { family: Str::default(), n: 3 },
		description:     sf!(
			"Symbol-aware language-server diagnostics, navigation, references, hover, symbols, \
			 transactional symbol/path renames, code actions, raw requests, status, and reload. \
			 Position requests use one-based line plus symbol (symbol#N selects an occurrence); \
			 rename and rename_file apply by default, code_actions applies only with apply=true; \
			 diagnostics accepts a path, glob, or * and symbols uses * plus query for workspace \
			 search."
		),
		schema:          omp_tool::schema::<Params>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         Effects {
			documents: Some(DocEffects {
				read:        true,
				write_globs: [sf!("*")].into_iter().collect::<Arc<[_]>>(),
			}),
			exec:      None,
			inference: None,
			desktop:   None,
			subagents: 0,
		},
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("mod.rs"),
		)
		.into(),
	}
}

/// Creates discoverable `lsp@3` with an environment-configured timeout ceiling.
pub fn tool<C: LspControl>(control: C, maximum: Duration) -> LspTool<C> {
	LspTool {
		control,
		maximum: maximum.clamp(Duration::from_secs(5), Duration::from_secs(300)),
		spec: spec(),
	}
}

impl<C: LspControl> Tool for LspTool<C> {
	type Fault = Fault;
	type Params = Params;
	type Payload = Payload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
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
			let timeout = Duration::from_secs(params.timeout.unwrap_or(20).clamp(5, 300)).min(self.maximum);
			let cancel = CancellationToken::new();
			let execution = self.control.execute(params, timeout, cancel.clone());
			let deadline = tokio::time::sleep(timeout);
			tokio::pin!(execution, deadline);
			tokio::select! {
				result = &mut execution => match result {
					Ok(payload) => {
						let useless = matches!(payload.action, Action::Definition | Action::TypeDefinition | Action::Implementation | Action::References | Action::Symbols)
							&& payload.data.as_array().is_some_and(Vec::is_empty);
						if payload.action == Action::Diagnostics && payload.omitted > 0 {
							yield Ev::Diag(
								Diag::info(DiagKind::LimitReached, "diagnostics")
									.omitted(payload.omitted as u64, Unit::Items),
							);
						}
						yield done(Ok(payload), useless);
					},
					Err(fault) => yield done(Err(fault), true),
				},
				interrupt = incoming.next_interrupt() => {
					cancel.cancel();
					if let Ok(interrupt) = interrupt {
						yield Ev::Aborted(Abort::Interrupted { reason: interrupt.reason });
					} else {
						yield Ev::Aborted(Abort::InputDropped);
					}
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

/// Lifts durable `lsp@1` and `lsp@2` calls onto `lsp@3` only when both the
/// historical arguments and verdict satisfy the current typed contract.
/// Revision three adds schema bounds and semantic navigation projection; old
/// successful navigation verdicts are re-projected from their structured data.
fn lift_legacy_call(from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
	if !from.family.is_empty() || !matches!(from.n, 1 | 2) {
		return None;
	}
	let mut raw_args = serde_json::from_slice::<Value>(call.raw_args).ok()?;
	let object = raw_args.as_object_mut()?;
	object.remove("i");
	object.remove("notrunc");
	let params = serde_json::from_value::<Params>(raw_args).ok()?;
	if !valid(&params) {
		return None;
	}
	let mut verdict = serde_json::from_slice::<CallOutcome<Payload, Fault>>(call.verdict).ok()?;
	if let CallOutcome::Ok(payload) = &mut verdict {
		payload.output = match payload.action {
			Action::Definition => navigation::render_locations("definition", &payload.data),
			Action::TypeDefinition => navigation::render_locations("type definition", &payload.data),
			Action::Implementation => navigation::render_locations("implementation", &payload.data),
			Action::References => navigation::render_references(&payload.data),
			_ => payload.output.clone(),
		};
	}
	Some(LiftedCall {
		raw_args: Bytes::copy_from_slice(call.raw_args),
		verdict:  Bytes::from(serde_json::to_vec(&verdict).ok()?),
	})
}

fn valid(params: &Params) -> bool {
	if params.timeout == Some(0) || params.line == Some(0) {
		return false;
	}
	match params.action {
		Action::Diagnostics => params.file.is_some(),
		Action::Status | Action::Capabilities | Action::Reload => true,
		Action::Request => params
			.query
			.as_ref()
			.is_some_and(|method| !method.trim().is_empty()),
		Action::Symbols => params.file.is_some() || params.query.is_some(),
		Action::Rename => {
			params.file.is_some()
				&& params.line.is_some()
				&& params.symbol.is_some()
				&& params.new_name.is_some()
		},
		Action::RenameFile => params.file.is_some() && params.new_name.is_some(),
		_ => params.file.is_some() && params.line.is_some(),
	}
}

#[cfg(test)]
mod tests {
	use std::sync::Mutex;

	use futures::StreamExt as _;

	use super::*;

	#[derive(Clone, Default)]
	struct RecordingControl(Arc<Mutex<Option<Params>>>);

	#[derive(Clone, Default)]
	struct CancellationControl(Arc<Mutex<Option<CancellationToken>>>);

	#[derive(Clone, Copy)]
	struct OmittedDiagnosticsControl;

	impl LspControl for OmittedDiagnosticsControl {
		fn execute(
			&self,
			_: Params,
			_: Duration,
			_: CancellationToken,
		) -> impl Future<Output = Result<Payload, Fault>> + Send + '_ {
			std::future::ready(Ok(Payload {
				action:  Action::Diagnostics,
				servers: Vec::new(),
				output:  sf!("No diagnostics"),
				data:    serde_json::json!({"diagnostics": []}),
				omitted: 7,
			}))
		}
	}

	impl LspControl for CancellationControl {
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

	impl LspControl for RecordingControl {
		fn execute(
			&self,
			params: Params,
			_: Duration,
			_: CancellationToken,
		) -> impl Future<Output = Result<Payload, Fault>> + Send + '_ {
			self.0.lock().expect("recording control").replace(params);
			std::future::ready(Ok(Payload {
				action:  Action::Request,
				servers: vec![sf!("rust-analyzer")],
				output:  sf!("ok"),
				data:    serde_json::json!({"ok": true}),
				omitted: 0,
			}))
		}
	}

	#[tokio::test]
	async fn omitted_diagnostics_are_emitted_as_a_typed_limit() {
		let lsp = tool(OmittedDiagnosticsControl, Duration::from_secs(300));
		let raw = r#"{"action":"diagnostics","file":"src/lib.rs"}"#;
		let (feed, incoming) = IncomingParams::channel();
		feed.arg_text(raw.into()).expect("stream args");
		feed.args_committed(raw.into()).expect("commit args");
		let events = lsp.call(incoming).collect::<Vec<_>>().await;
		let [Ev::Diag(diag), Ev::Done(ToolTerminal::Done { result: Ok(payload), .. })] =
			events.as_slice()
		else {
			panic!("diagnostic followed by terminal payload");
		};
		assert_eq!(diag.native_kind(), Some(DiagKind::LimitReached));
		assert_eq!(diag.severity, omp_tool::Severity::Info);
		assert!(matches!(
			diag.omitted.as_ref(),
			Some(omp_tool::Omitted { count: 7, unit: Unit::Items })
		));
		assert!(!payload.output.contains("omitted"));
	}

	#[test]
	fn schema_matches_the_current_pi_lsp_contract() {
		let schema: Value = serde_json::from_slice(&spec().schema).expect("LSP schema JSON");
		assert_eq!(schema["additionalProperties"], false);
		assert_eq!(schema["required"], serde_json::json!(["i", "action"]));
		assert!(schema["properties"]["action"].is_object());
		for action in [
			"diagnostics",
			"definition",
			"type_definition",
			"implementation",
			"references",
			"hover",
			"symbols",
			"rename",
			"rename_file",
			"code_actions",
			"request",
			"capabilities",
			"status",
			"reload",
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
				"action", "apply", "file", "i", "line", "new_name", "notrunc", "payload", "query",
				"symbol", "timeout",
			]
			.into_iter()
			.collect()
		);
		assert_eq!(schema["properties"]["payload"]["type"], serde_json::json!(["string", "null"]));
		assert_eq!(schema["properties"]["timeout"]["minimum"], 5);
		assert_eq!(schema["properties"]["timeout"]["maximum"], 300);
		// The contract includes the fields above but has no `notrunc` parameter.
		// `notrunc` is injected by omp-tool under ADR 0009, so this LSP
		// conformance test verifies its protocol shape without duplicating the
		// central owner's presentation prose.
		assert_eq!(schema["properties"]["notrunc"]["type"], "boolean");
		assert!(
			schema["properties"]["notrunc"]["description"]
				.as_str()
				.is_some_and(|description| !description.is_empty())
		);
	}

	#[tokio::test]
	async fn request_route_forwards_query_and_string_payload() {
		let control = RecordingControl::default();
		let lsp = tool(control.clone(), Duration::from_secs(300));
		let raw = r#"{"action":"request","query":"rust-analyzer/expandMacro","payload":"{\"x\":1}"}"#;
		let (feed, incoming) = IncomingParams::channel();
		feed.arg_text(raw.into()).expect("stream args");
		feed.args_committed(raw.into()).expect("commit args");
		let events = lsp.call(incoming).collect::<Vec<_>>().await;
		assert!(matches!(events.last(), Some(Ev::Done(ToolTerminal::Done { result: Ok(_), .. }))));
		let recorded = control.0.lock().expect("recording control");
		let params = recorded.as_ref().expect("request executed");
		assert_eq!(params.query.as_deref(), Some("rust-analyzer/expandMacro"));
		assert_eq!(params.payload.as_deref(), Some(r#"{"x":1}"#));
	}

	#[tokio::test]
	async fn caller_interrupt_cancels_the_in_flight_language_server_request() {
		let control = CancellationControl::default();
		let lsp = tool(control.clone(), Duration::from_secs(300));
		let raw = r#"{"action":"status"}"#;
		let (feed, incoming) = IncomingParams::channel();
		feed.arg_text(raw.into()).expect("stream args");
		feed.args_committed(raw.into()).expect("commit args");
		feed
			.interrupt(omp_tool::Interrupt {
				class:  Str::new_static(omp_tool::Interrupt::ESCAPE),
				reason: Str::new_static("user interrupted LSP"),
			})
			.expect("interrupt request");
		let events = lsp.call(incoming).collect::<Vec<_>>().await;
		assert!(matches!(
			events.last(),
			Some(Ev::Aborted(Abort::Interrupted { reason })) if reason == "user interrupted LSP"
		));
		assert!(
			control
				.0
				.lock()
				.expect("cancellation control")
				.as_ref()
				.is_some_and(CancellationToken::is_cancelled),
			"host cancellation token must be raised before the tool settles",
		);
	}

	#[test]
	fn workspace_symbols_keep_results_and_server_failures() {
		let payload = aggregate_workspace_symbols("Target", vec![
			WorkspaceSymbolOutcome {
				server: Str::new_static("broken"),
				result: Err(Str::new_static("server exited with code 7")),
			},
			WorkspaceSymbolOutcome {
				server: Str::new_static("healthy"),
				result: Ok(serde_json::json!([
					{"name": "TargetSymbol", "kind": 12, "location": {"uri": "file:///src/a.rs", "range": {"start": {"line": 3, "character": 1}}}},
					{"name": "TargetSymbol", "kind": 12, "location": {"uri": "file:///src/a.rs", "range": {"start": {"line": 3, "character": 1}}}},
					{"name": "Unrelated", "kind": 12, "location": {"uri": "file:///src/b.rs", "range": {"start": {"line": 1, "character": 1}}}}
				])),
			},
		])
		.expect("one server responded");
		assert_eq!(payload.servers, [Str::new_static("healthy")]);
		assert_eq!(
			payload.data,
			serde_json::json!([
				{"name": "TargetSymbol", "kind": 12, "location": {"uri": "file:///src/a.rs", "range": {"start": {"line": 3, "character": 1}}}}
			])
		);
		assert!(payload.output.contains("TargetSymbol"));
		assert!(payload.output.contains("Server failures:"));
		assert!(payload.output.contains("broken: server exited with code 7"));
	}

	#[test]
	fn legacy_lift_is_shape_checked_and_semantically_reprojects_navigation() {
		let lsp = tool(RecordingControl::default(), Duration::from_secs(300));
		let args =
			br#"{"i":"Finding references","action":"references","file":"src/lib.rs","line":4}"#;
		let verdict = serde_json::to_vec(&CallOutcome::<Payload, Fault>::Ok(Payload {
			action:  Action::References,
			servers: vec![Str::new_static("rust-analyzer")],
			output:  Str::new_static("No references found"),
			data:    serde_json::json!([]),
			omitted: 0,
		}))
		.expect("verdict JSON");
		let lifted = lsp
			.lift(&Rev { family: Str::default(), n: 2 }, RecordedCall {
				raw_args: args,
				verdict:  &verdict,
			})
			.expect("compatible legacy call");
		assert_eq!(lifted.raw_args.as_ref(), args);
		let outcome =
			serde_json::from_slice::<CallOutcome<Payload, Fault>>(&lifted.verdict).expect("lifted");
		let CallOutcome::Ok(payload) = outcome else {
			panic!("successful historical verdict must remain successful");
		};
		assert_eq!(payload.output, "No references found");
		assert!(
			lsp.lift(&Rev { family: Str::default(), n: 1 }, RecordedCall {
				raw_args: br#"{"action":"unknown"}"#,
				verdict:  &verdict,
			},)
				.is_none()
		);
	}

	#[test]
	fn workspace_symbols_name_every_failure_when_all_servers_fail() {
		let error = aggregate_workspace_symbols("Target", vec![
			WorkspaceSymbolOutcome {
				server: Str::new_static("first"),
				result: Err(Str::new_static("first server exited")),
			},
			WorkspaceSymbolOutcome {
				server: Str::new_static("second"),
				result: Err(Str::new_static("second server exited")),
			},
		])
		.expect_err("all servers failed");
		let message = error.to_string();
		assert!(message.contains("all language servers failed"));
		assert!(message.contains("first: first server exited"));
		assert!(message.contains("second: second server exited"));
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
		example:  Some(Str::new_static(r#"{"action":"status","file":"src/lib.rs"}"#)),
		found:    Some(message),
	}
}
