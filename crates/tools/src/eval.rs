//! Python-only, persistent-session evaluation tool.
//!
//! This crate defines the protocol boundary and the child-local embedded
//! kernel. Production composition owns one killable Python child process per
//! eval session, so interpreter globals, imported modules, environment changes,
//! and cancellation are contained by that session's process.

use std::{
	borrow::Cow,
	collections::BTreeMap,
	fmt::Write as _,
	future,
	future::Future,
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::Duration,
};

use async_stream::stream;
use async_trait::async_trait;
use bytes::Bytes;
use dashmap::DashMap;
use futures::{FutureExt, Stream, future::Either, pin_mut};
use omp_core::{CowBytes, Str, sf};
use omp_env::EnvClient;
use omp_proto::inference::v1::{InvokeInput, invoke_input, invoke_input::chunk};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, BlobRef, CommitError, Constraint, DocEffects, Effects, Ev,
	ExecEffects, IncomingParams, InferenceEffects, Interrupt, InterruptWaitError, ParamError, Part,
	PromptCaps, Rev, Tool, ToolSpec, ToolTerminal, Usd,
};
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::{runtime, sync::OnceCell};
use tokio_util::sync::CancellationToken;

use crate::{
	auto_background::{
		DEFAULT_AUTO_BACKGROUND_THRESHOLD, DetachedJob, ForegroundWait, JobWait,
		managed_job_terminal, next_background_name,
	},
	render::TextProjection,
};

/// Runtime-work timeout accounting shared with host bridge scheduling.
pub mod idle_timeout;
/// Embedded CPython implementation of the eval resource boundary.
pub mod kernel;

const EVAL_DESCRIPTION: &str = r#"Run one step of code in a persistent Python kernel. State persists across calls.
__OMP_EVAL_AGENT_ISOLATION__

Work incrementally: imports → define → test → use, each its own cell. Re-run setup ONLY after `reset`, kernel crash.
Cells exceeding the configured foreground wait threshold continue as managed jobs; their results are delivered automatically.
`timeout: 0` disables the cell deadline; otherwise `timeout` sets it without extending foreground waiting.
Parallelize *within* a cell with `parallel(thunks)`, not by batching.

Top-level `await` works; `asyncio.run(…)` raises error.

On error, fix and re-run only the failing step.

<prelude>
Sync; kwargs.
```
display(value) → None        print(value, ...) → None
read(path, offset?=1, limit?=None) → str
write(path, content) → str
env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query=None, offset=None, limit=None) → str | dict | list[dict]
tool.<name>(args) → unknown
    Invoke any session tool; `args` = its parameter object.
completion(prompt, model?="default"|"smol"|"slow", system=None, schema=None) → str | dict
    Oneshot, stateless (no history/tools). `model`: "smol" fast | "default" session | "slow" most capable. `schema` (JSON-Schema) → parsed object.
__OMP_EVAL_AGENT_HELPER__
parallel(thunks) → list     pipeline(items, ...stages) → list
log(message) → None         phase(title) → None
budget → `budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()`; ceiling `+Nk` advisory, `+Nk!` hard.
```
</prelude>
__OMP_EVAL_AGENT_DAG__

<critical>
Prior top-level names survive into the next cell — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
</critical>
__OMP_EVAL_DEFINED_TOOLS__"#;
const EVAL_AGENT_ISOLATION: &str = "Eval `agent()` children use independent kernels.";
const EVAL_AGENT_HELPER: &str = r#"agent(prompt, agent?="task", name=None, outputSchema=None, schemaMode?="permissive", isolated=None, apply=None, merge=None, handle=False) → str | dict
    Run a subagent → final output. `agent` selects a discovered agent; omit it to use `task`. `outputSchema` overrides agent/session schemas; `schemaMode`/`schemaMode`: "permissive" | "strict". Effective schemas return parsed data. `isolated` requests a worktree; `apply`/`merge` control its changes. Background via `local://` files named in the prompt. `handle` → { text, output, handle: "agent://<id>", id, agent }, parsed `data` when structured."#;
const EVAL_AGENT_DAG: &str = r#"<dag>
Acyclic waves via `agent(…, handle=true)` + `pipeline`/`parallel`:
- **Name nodes.** Capture agent result → `handle` (`agent://<id>`) + `output`.
- **Wire edges.** Put upstream `handle`/`output` in downstream prompt. Bulk: `write("local://<name>.md", …)`.
- **`pipeline`** = staged waves, barrier between stages. **`parallel`** = one wave.
- **Isolate failure.** Wrap risky nodes in try/except; a failure degrades only its subtree.
- **Acyclic only.** No node waits on its own descendant.
</dag>"#;
const EVAL_DEFINED_TOOLS: &str = r"<eval-defined-tools>
Additional Python helpers:
```
@tool / tool(fn, name=None, description=None, rev=1)
    Define a process-local tool from type hints. Pass its name in `workpool(tools=[…])`; calls execute in this retained kernel and are fenced across redefine/reset.
workpool(agent=None, *, name=None, context=None, tools=None) → WorkPool
    Queue independent items onto persistent children. `tools` exposes only named eval-defined handlers.
```
</eval-defined-tools>";

/// One live discovered agent projected into eval task guidance.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TaskAgentDescription<'a> {
	/// Stable definition name.
	pub name:        &'a str,
	/// Human-readable role.
	pub description: &'a str,
	/// Whether every declared tool is read-only.
	pub read_only:   bool,
	/// Whether this role executes inline.
	pub blocking:    bool,
}
/// One extension-provided prelude helper projected into eval task guidance.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PreludeHelperDescription<'a> {
	/// Callable signature shown to the model.
	pub signature: &'a str,
	/// Concise description of the helper's behavior.
	pub summary:   &'a str,
}

/// Session facts used to build model-facing task guidance once.
#[derive(Clone, Copy, Debug)]
pub struct TaskDescriptionSnapshot<'a> {
	/// Effective default definition.
	pub default_agent:   &'a str,
	/// Effective discovered roster after disablement; empty means subagent
	/// spawning is unavailable and suppresses child-agent guidance.
	pub agents:          &'a [TaskAgentDescription<'a>],
	/// Extension-provided prelude helpers available in this session.
	pub helpers:         &'a [PreludeHelperDescription<'a>],
	/// Whether child jobs may continue asynchronously.
	pub asynchronous:    bool,
	/// Whether ordered batches are supported.
	pub batch:           bool,
	/// Whether isolated workspaces are enabled.
	pub isolation:       bool,
	/// Whether IRC coordination is enabled.
	pub irc:             bool,
	/// Whether the caller may select effort.
	pub effort:          bool,
	/// Effective maximum fan-out (`0` is unlimited).
	pub max_concurrency: usize,
}

/// Builds the task portion of the eval description from one session snapshot.
pub fn task_description(snapshot: TaskDescriptionSnapshot<'_>) -> Str {
	let subagents_available = !snapshot.agents.is_empty();
	let base = EVAL_DESCRIPTION
		.replace(
			"__OMP_EVAL_AGENT_ISOLATION__",
			if subagents_available {
				EVAL_AGENT_ISOLATION
			} else {
				""
			},
		)
		.replace(
			"__OMP_EVAL_AGENT_HELPER__",
			if subagents_available {
				EVAL_AGENT_HELPER
			} else {
				""
			},
		)
		.replace(
			"__OMP_EVAL_AGENT_DAG__",
			if subagents_available {
				EVAL_AGENT_DAG
			} else {
				""
			},
		)
		.replace(
			"__OMP_EVAL_DEFINED_TOOLS__",
			if subagents_available {
				EVAL_DEFINED_TOOLS
			} else {
				""
			},
		);
	let mut output = String::with_capacity(base.len() + 2_048);
	output.push_str(&base);
	if subagents_available {
		output.push_str("\n\n<task-runtime>\n");
		let _ = writeln!(output, "Default agent: `{}`.", snapshot.default_agent);
		let _ = writeln!(
			output,
			"Execution: {}; batches: {}; isolation: {}; IRC: {}; effort: {}; concurrency: {}.",
			if snapshot.asynchronous {
				"async jobs"
			} else {
				"blocking"
			},
			if snapshot.batch {
				"enabled"
			} else {
				"disabled"
			},
			if snapshot.isolation {
				"enabled"
			} else {
				"disabled"
			},
			if snapshot.irc { "enabled" } else { "disabled" },
			if snapshot.effort {
				"enabled"
			} else {
				"disabled"
			},
			if snapshot.max_concurrency == 0 {
				"unlimited".to_owned()
			} else {
				snapshot.max_concurrency.to_string()
			},
		);
		output.push_str("Available agents:\n");
		for agent in snapshot.agents {
			let _ = writeln!(
				output,
				"- `{}`{}{}: {}",
				agent.name,
				if agent.read_only { " (READ-ONLY)" } else { "" },
				if agent.blocking { " (BLOCKING)" } else { "" },
				agent.description,
			);
		}
		output.push_str(
			"Choose the most specific specialist; omit `agent` only when the default fits. Use \
			 read-only agents only for investigation. For concurrent siblings, assign disjoint \
			 ownership and coordinate shared files over IRC before editing.\n</task-runtime>",
		);
	}
	if !snapshot.helpers.is_empty() {
		output.push_str(
			"\n\n<extension-helpers>\nExtension-provided prelude functions (call like any prelude \
			 helper):\n",
		);
		for helper in snapshot.helpers {
			let _ = writeln!(output, "- `{}` — {}", helper.signature, helper.summary);
		}
		output.push_str("</extension-helpers>");
	}
	Str::from(output)
}

const STANDARD_TASK_AGENTS: &[TaskAgentDescription<'static>] = &[
	TaskAgentDescription {
		name:        "task",
		description: "General-purpose delegated multi-step work",
		read_only:   false,
		blocking:    false,
	},
	TaskAgentDescription {
		name:        "scout",
		description: "Rapid read-only codebase research",
		read_only:   true,
		blocking:    false,
	},
	TaskAgentDescription {
		name:        "sonic",
		description: "Strictly mechanical updates or data collection",
		read_only:   false,
		blocking:    false,
	},
	TaskAgentDescription {
		name:        "designer",
		description: "UI/UX implementation and visual refinement",
		read_only:   false,
		blocking:    false,
	},
	TaskAgentDescription {
		name:        "reviewer",
		description: "Evidence-backed code review",
		read_only:   true,
		blocking:    false,
	},
	TaskAgentDescription {
		name:        "security-reviewer",
		description: "Read-only repository security review",
		read_only:   true,
		blocking:    false,
	},
	TaskAgentDescription {
		name:        "librarian",
		description: "Source-verified external library research",
		read_only:   true,
		blocking:    false,
	},
];

impl TaskDescriptionSnapshot<'static> {
	/// Returns the standard eval task-description snapshot.
	#[must_use]
	pub const fn standard() -> Self {
		Self {
			default_agent:   "task",
			agents:          STANDARD_TASK_AGENTS,
			helpers:         &[],
			asynchronous:    false,
			batch:           true,
			isolation:       true,
			irc:             true,
			effort:          true,
			max_concurrency: 32,
		}
	}
}

fn standard_eval_description() -> Str {
	task_description(TaskDescriptionSnapshot::standard())
}

const MAX_CELL_TIMEOUT: Duration = Duration::from_secs(3_600);

/// Runtime accepted by this build of `eval@1`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
	/// OMP's embedded `CPython` runtime.
	Py,
}

impl JsonSchema for Language {
	fn inline_schema() -> bool {
		true
	}

	fn schema_name() -> Cow<'static, str> {
		"Language".into()
	}

	fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
		json_schema!({
			"type": "string",
			"enum": ["py"]
		})
	}
}

/// Lifetime policy for the Python kernel.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum KernelMode {
	/// Reuse the owner-scoped Python kernel.
	#[default]
	Persistent,
	/// Spawn a clean Python kernel for this call and dispose it at settlement.
	PerCall,
}

/// Complete arguments for one Python cell.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[schemars(description = "")]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// runtime: "py" for the Python kernel
	#[expect(
		clippy::doc_markdown,
		reason = "doc comment is the verbatim model-facing description; backticks would leak"
	)]
	#[schemars(required, description = "runtime: \"py\" for the Python kernel")]
	pub language:    Language,
	/// code to run in this eval call, verbatim. Use top-level await freely.
	#[schemars(
		required,
		with = "String",
		description = "code to run in this eval call, verbatim. Use top-level await freely."
	)]
	pub code:        Str,
	/// short label shown in transcript (e.g. "imports", "load config")
	#[schemars(
		default,
		skip_serializing_if = "Option::is_none",
		with = "String",
		description = "short label shown in transcript (e.g. \"imports\", \"load config\")"
	)]
	pub title:       Option<Str>,
	/// timeout for this eval call in seconds; 0 disables the cell timeout
	#[schemars(
		default,
		skip_serializing_if = "Option::is_none",
		with = "serde_json::Number",
		description = "timeout for this eval call in seconds; 0 disables the cell timeout"
	)]
	pub timeout:     Option<f64>,
	/// wipe this language's kernel before running. Other languages are
	/// untouched.
	#[schemars(
		default,
		skip_serializing_if = "Option::is_none",
		with = "bool",
		description = "wipe this language's kernel before running. Other languages are untouched."
	)]
	pub reset:       Option<bool>,
	/// Select a persistent kernel or an isolated one-shot process.
	#[schemars(default, skip_serializing_if = "Option::is_none")]
	pub kernel_mode: Option<KernelMode>,
}

/// Arguments accepted by the isolated `py_eval@1` expression evaluator.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[schemars(description = "")]
#[serde(deny_unknown_fields)]
pub struct PyEvalParams {
	/// Python expression to evaluate in a fresh namespace.
	#[schemars(required, with = "String", description = "Python expression to evaluate")]
	pub code: Str,
}

/// Durable result of one isolated Python expression.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PyEvalPayload {
	/// JSON-safe expression value, or its Python `repr` when it is not JSON
	/// serializable.
	pub result: Value,
}

/// `py_eval` has no streaming updates.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum PyEvalUpdate {}

/// Typed failure from isolated Python expression evaluation.
#[derive(Clone, Debug, Deserialize, Eq, Error, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PyEvalFault {
	/// The expression was empty.
	#[error("py_eval code must be nonempty")]
	EmptyCode,
	/// The shared eval resource failed.
	#[error("{fault}")]
	Resource {
		/// Typed eval resource failure.
		#[source]
		fault: Fault,
	},
	/// Python raised while evaluating the expression.
	#[error("{name}: {message}")]
	Python {
		/// Python exception class name.
		name:      Str,
		/// Exception message without the class prefix.
		message:   Str,
		/// Formatted traceback lines in Python order.
		traceback: Vec<Str>,
	},
	/// The eval child returned a completion that violates the `py_eval`
	/// protocol.
	#[error("py_eval child returned an invalid result")]
	InvalidResult,
}

/// Ordered text stream emitted by Python.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputChannel {
	/// Python standard output.
	Stdout,
	/// Python standard error.
	Stderr,
}

/// A live, cell-bounded output update.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Update {
	/// Stream that owns these bytes.
	pub channel:  OutputChannel,
	/// Exact bytes captured within this cell.
	#[serde(with = "cow_bytes")]
	pub data:     CowBytes<'static>,
	/// Monotonic sequence within the cell.
	pub sequence: u64,
}

/// Rich output captured from a Python cell.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DisplayOutput {
	/// JSON-compatible display value.
	Json {
		/// Displayed value.
		data: Value,
	},
	/// Bounded encoded image awaiting host persistence.
	ImageData {
		/// Exact encoded PNG or JPEG bytes.
		#[serde(with = "cow_bytes")]
		data:      CowBytes<'static>,
		/// Validated image media type.
		mime_type: Str,
	},
	/// Image already persisted by the host.
	Image {
		/// Durable blob containing the encoded image.
		blob:        BlobRef,
		/// Image media type.
		mime_type:   Str,
		/// Model-visible source/final dimension and encoding note.
		description: Str,
	},
	/// Markdown display value.
	Markdown {
		/// Markdown source.
		text: Str,
	},
	/// Structured progress event emitted by a helper.
	Status {
		/// Helper event object.
		event: Value,
	},
}

/// REPL value of the final expression in a cell.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct CellValue {
	/// Stable plain-text representation.
	pub text: Str,
	/// JSON value when Python's JSON encoder accepts the object.
	pub json: Option<Value>,
}

/// Python exception retained as durable cell truth.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PythonException {
	/// Python exception class name.
	pub name:      Str,
	/// Exception message without the class prefix.
	pub message:   Str,
	/// Formatted traceback lines in Python order.
	pub traceback: Vec<Str>,
}

/// Terminal disposition of a cell.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CellOutcome {
	/// Cell completed normally.
	Complete,
	/// Python raised an exception.
	Error,
	/// Runtime-work timeout expired.
	Timeout,
	/// Invocation owner interrupted the cell.
	Cancelled,
}

/// Terminal cell status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CellStatus {
	/// Stable terminal disposition.
	pub outcome:     CellOutcome,
	/// Process-style status used by transcript consumers (`0` or `1`).
	pub exit_code:   Option<i32>,
	/// Host-measured execution duration.
	pub duration_ms: u64,
	/// Python exception, if any.
	pub exception:   Option<PythonException>,
}

/// Complete terminal result supplied by an eval resource.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct RunCompletion {
	/// Terminal cell status.
	pub status:          CellStatus,
	/// Final REPL value, if the cell produced one.
	pub result:          Option<CellValue>,
	/// Rich display values emitted during execution.
	pub display_outputs: Vec<DisplayOutput>,
}

/// Durable result of one eval call.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct Payload {
	/// Stable identity of the persistent Python session.
	pub session_id:      Bytes,
	/// Host identity of this cell.
	pub cell_id:         Bytes,
	/// Executed runtime.
	pub language:        Language,
	/// Optional caller-provided label.
	pub title:           Option<Str>,
	/// Exact submitted source.
	pub code:            Str,
	/// Whether the namespace was reset immediately before this cell.
	pub reset:           bool,
	/// Whether text was already delivered through ordered output updates.
	pub had_output:      bool,
	/// Final expression value.
	pub result:          Option<CellValue>,
	/// Rich display values.
	pub display_outputs: Vec<DisplayOutput>,
	/// Terminal status.
	pub status:          CellStatus,
}

/// Typed eval resource or validation failure.
#[derive(Clone, Debug, Deserialize, Eq, Error, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// The timeout was negative or not finite.
	#[error("eval timeout must be finite and non-negative")]
	InvalidTimeout,
	/// The environment resource rejected or lost an operation.
	#[error("eval resource operation `{operation}` failed: {message}")]
	Resource {
		/// Operation that failed.
		operation: Str,
		/// Resource-owned diagnostic.
		message:   Str,
	},
	/// A worker ended without a terminal cell event.
	#[error("eval session was lost: {message}")]
	SessionLost {
		/// Resource-owned diagnostic.
		message: Str,
	},
}

/// Opaque handle for one persistent Python session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Session {
	/// Resource-owned stable session identifier.
	pub id: Bytes,
}

/// Host-authorized process state applied immediately before one cell.
///
/// Managed environment entries are deltas: `Some` replaces a value and `None`
/// removes it. The app authority sends every managed key on every run so state
/// cannot leak from a prior owner or session.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct RuntimeSnapshot {
	/// Scoped working directory for this cell.
	pub cwd:         Option<PathBuf>,
	/// Sanitized managed-environment replacements and removals.
	pub managed_env: BTreeMap<Str, Option<Str>>,
}

/// One authenticated, generation-fenced eval-defined tool registration.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EvalToolRegistration {
	/// Model-visible stable name.
	pub name:        Str,
	/// Model-facing purpose and usage guidance.
	pub description: Str,
	/// Closed JSON Schema inferred by the eval kernel.
	pub parameters:  Value,
	/// Author-declared semantic contract revision.
	pub rev:         u16,
	/// Opaque process-local handler identity.
	pub handler:     Str,
	/// Namespace roster generation at description time.
	pub generation:  u64,
	/// Owning eval-session reset epoch.
	#[serde(default)]
	pub epoch:       u64,
}

/// Complete immutable registration snapshot forwarded to one child.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct EvalToolRoster {
	/// Namespace roster generation shared by every registration.
	pub generation: u64,
	/// Registrations in the caller's requested order.
	pub tools:      Vec<EvalToolRegistration>,
	/// Requested names absent from the live namespace.
	#[serde(default)]
	pub missing:    Vec<Str>,
}

/// Terminal result of one eval-defined handler call.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EvalToolResult {
	/// JSON-safe handler result or diagnostic.
	pub value:    Value,
	/// Whether the handler raised or the registration was rejected.
	pub is_error: bool,
}

/// Typed eval-defined registry or invocation failure.
#[derive(Debug, Error)]
pub enum EvalToolControlError {
	/// This environment connection cannot invoke retained eval kernels.
	#[error("eval-defined tool forwarding is unavailable on this environment connection")]
	Unavailable,
	/// The owner has not started a persistent eval kernel.
	#[error("eval kernel for owner `{owner}` is not running")]
	OwnerUnavailable {
		/// Authenticated invocation owner.
		owner: Str,
	},
	/// The forwarded registration belongs to an older reset epoch.
	#[error(
		"eval tool `{name}` registration belongs to stale reset epoch {received}; current epoch is \
		 {current}"
	)]
	StaleEpoch {
		/// Tool name.
		name:     Str,
		/// Current owner epoch.
		current:  u64,
		/// Forwarded epoch.
		received: u64,
	},
	/// The hidden request was cancelled at the kill boundary.
	#[error("eval-defined tool request was cancelled")]
	Cancelled,
	/// The retained kernel returned no valid terminal envelope.
	#[error("eval-defined tool kernel returned an invalid response")]
	InvalidResponse,
	/// JSON protocol encoding or decoding failed.
	#[error("eval-defined tool protocol JSON is invalid")]
	Json {
		/// Serialization error.
		#[source]
		source: serde_json::Error,
	},
	/// The retained eval resource failed.
	#[error(transparent)]
	Eval(#[from] Fault),
}

/// Request to execute one cell in a persistent session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunRequest {
	/// Exact source text.
	pub code:    Str,
	/// Runtime-work timeout. `None` disables the timeout.
	pub timeout: Option<Duration>,
	/// Whether to replace the persistent namespace first.
	pub reset:   bool,
	/// Frozen host-authorized runtime state for this run.
	pub runtime: RuntimeSnapshot,
}

/// Ordered event from an active cell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunEvent {
	/// Resource assigned a cell identity.
	Started {
		/// Stable resource-owned identity.
		cell_id: Bytes,
	},
	/// Cell-bounded stdout or stderr.
	Output(Update),
	/// Terminal result.
	Completed(RunCompletion),
}

enum PendingEval {
	Event(Result<Option<RunEvent>, Fault>),
	Interrupt(Result<Interrupt, InterruptWaitError>),
	Background,
}

/// Request-scoped active Python cell.
pub trait EvalRun: Send {
	/// Reports whether this run started from a fresh persistent namespace.
	fn reset(&self) -> bool;
	/// Waits for the next ordered event.
	fn next_event(&mut self) -> impl Future<Output = Result<Option<RunEvent>, Fault>> + Send + '_;

	/// Interrupts the active cell without disposing its session.
	fn cancel(&self) -> impl Future<Output = Result<(), Fault>> + Send + '_;

	/// Transfers this active cell to a managed background job.
	///
	/// Resource adapters that cannot authoritatively report detached settlement
	/// may retain the default refusal; the tool then keeps waiting in the
	/// foreground.
	fn detach(&self, _name: Str) -> impl Future<Output = Result<DetachedJob, Fault>> + Send + '_ {
		future::ready(Err(Fault::Resource {
			operation: sf!("detach"),
			message:   sf!("eval resource does not support managed detachment"),
		}))
	}
}

/// Zero-box resource boundary used by the native eval executor.
pub trait EvalExec: Clone + Send + Sync + 'static {
	/// Active run handle.
	type Run: EvalRun;

	/// Opens the persistent Python session owned by this tool instance.
	fn open_session(&self) -> impl Future<Output = Result<Session, Fault>> + Send + '_;

	/// Opens a persistent session for an authenticated invocation owner.
	///
	/// Executors that key resources by owner override this method. Child-local
	/// and test executors may use the owner-independent default.
	fn open_session_for(
		&self,
		_owner: &str,
	) -> impl Future<Output = Result<Session, Fault>> + Send + '_ {
		self.open_session()
	}

	/// Freezes the runtime state authorized for one owner/session pair.
	fn runtime_snapshot(&self, _owner: &str, _session: &Session) -> Result<RuntimeSnapshot, Fault> {
		Ok(RuntimeSnapshot::default())
	}

	/// Starts one cell in an existing session.
	fn run<'a>(
		&'a self,
		session: &'a Session,
		request: RunRequest,
	) -> impl Future<Output = Result<Self::Run, Fault>> + Send + 'a;

	/// Starts one cell with an explicit lifetime policy.
	fn run_with_mode<'a>(
		&'a self,
		session: &'a Session,
		request: RunRequest,
		_disposable: bool,
	) -> impl Future<Output = Result<Self::Run, Fault>> + Send + 'a {
		self.run(session, request)
	}

	/// Disposes one persistent session before a reset cell.
	fn dispose_session(
		&self,
		_session: &Session,
	) -> impl Future<Output = Result<(), Fault>> + Send + '_ {
		future::ready(Ok(()))
	}

	/// Requests disposal of every persistent session owned by this executor.
	fn dispose_all(&self) {}
}

fn format_display_json(outputs: &[DisplayOutput]) -> String {
	let mut rendered = Vec::new();
	let mut index = 0usize;
	for output in outputs {
		let DisplayOutput::Json { data } = output else {
			continue;
		};
		index += 1;
		let text = serde_json::to_string_pretty(data).unwrap_or_else(|_| data.to_string());
		rendered.push(format!("display[{index}]:\n{text}"));
	}
	rendered.join("\n\n")
}

/// Isolated `py_eval@1` implementation backed by disposable eval children.
pub struct PyEvalTool<E: EvalExec> {
	exec:     E,
	sessions: Arc<DashMap<Str, Arc<OnceCell<Session>>>>,
	spec:     ToolSpec,
}

/// Python-only `eval@1` implementation retaining one lazy session per owner.
pub struct EvalTool<E: EvalExec> {
	exec: E,
	sessions: Arc<DashMap<Str, Arc<OwnerSession>>>,
	control: EvalSessionControl,
	spec: ToolSpec,
	next_background_name: AtomicU64,
	auto_background_threshold: Duration,
}

struct OwnerSession {
	session:          OnceCell<Session>,
	reset_generation: AtomicU64,
}

#[async_trait]
trait EvalDefinedToolHost: Send + Sync {
	async fn describe(
		&self,
		owner: &str,
		names: &[Str],
		cancellation: CancellationToken,
	) -> Result<EvalToolRoster, EvalToolControlError>;

	async fn invoke(
		&self,
		owner: &str,
		registration: &EvalToolRegistration,
		args: Value,
		cancellation: CancellationToken,
	) -> Result<EvalToolResult, EvalToolControlError>;
}

struct UnavailableEvalDefinedToolHost;

#[async_trait]
impl EvalDefinedToolHost for UnavailableEvalDefinedToolHost {
	async fn describe(
		&self,
		_owner: &str,
		_names: &[Str],
		_cancellation: CancellationToken,
	) -> Result<EvalToolRoster, EvalToolControlError> {
		Err(EvalToolControlError::Unavailable)
	}

	async fn invoke(
		&self,
		_owner: &str,
		_registration: &EvalToolRegistration,
		_args: Value,
		_cancellation: CancellationToken,
	) -> Result<EvalToolResult, EvalToolControlError> {
		Err(EvalToolControlError::Unavailable)
	}
}

struct LocalEvalDefinedToolHost<E: EvalExec> {
	exec:             E,
	sessions:         Arc<DashMap<Str, Arc<OwnerSession>>>,
	reset_generation: Arc<AtomicU64>,
}

impl<E: EvalExec> LocalEvalDefinedToolHost<E> {
	fn owner_session(&self, owner: &str) -> Result<(Str, Arc<OwnerSession>), EvalToolControlError> {
		if let Some(entry) = self.sessions.get(owner) {
			return Ok((entry.key().clone(), Arc::clone(entry.value())));
		}
		let mut found = None;
		for entry in self.sessions.iter() {
			let matches_parent = serde_json::from_str::<(Str, Str)>(entry.key().as_str())
				.is_ok_and(|(session, agent)| session.as_str() == owner && !agent.is_empty());
			if !matches_parent {
				continue;
			}
			if found.is_some() {
				return Err(EvalToolControlError::OwnerUnavailable { owner: Str::new(owner) });
			}
			found = Some((entry.key().clone(), Arc::clone(entry.value())));
		}
		found.ok_or_else(|| EvalToolControlError::OwnerUnavailable { owner: Str::new(owner) })
	}

	async fn request(
		&self,
		owner: &str,
		request: Value,
		cancellation: CancellationToken,
	) -> Result<Value, EvalToolControlError> {
		let (runtime_owner, owned) = self.owner_session(owner)?;
		let session = owned
			.session
			.get()
			.ok_or_else(|| EvalToolControlError::OwnerUnavailable { owner: Str::new(owner) })?
			.clone();
		let request =
			serde_json::to_string(&request).map_err(|source| EvalToolControlError::Json { source })?;
		let literal =
			serde_json::to_string(&request).map_err(|source| EvalToolControlError::Json { source })?;
		let runtime = self
			.exec
			.runtime_snapshot(runtime_owner.as_str(), &session)?;
		let mut run = self
			.exec
			.run(&session, RunRequest {
				code: sf!("__omp_eval_tool_request__(__import__('json').loads({literal}))"),
				timeout: None,
				reset: false,
				runtime,
			})
			.await?;
		loop {
			tokio::select! {
				biased;
				() = cancellation.cancelled() => {
					run.cancel().await?;
					return Err(EvalToolControlError::Cancelled);
				},
				event = run.next_event() => match event? {
					Some(RunEvent::Started { .. } | RunEvent::Output(_)) => {},
					Some(RunEvent::Completed(completion)) => {
						if completion.status.outcome != CellOutcome::Complete {
							return Err(EvalToolControlError::InvalidResponse);
						}
						return completion
							.result
							.and_then(|result| result.json)
							.ok_or(EvalToolControlError::InvalidResponse);
					},
					None => return Err(EvalToolControlError::InvalidResponse),
				},
			}
		}
	}
}

#[async_trait]
impl<E: EvalExec> EvalDefinedToolHost for LocalEvalDefinedToolHost<E> {
	async fn describe(
		&self,
		owner: &str,
		names: &[Str],
		cancellation: CancellationToken,
	) -> Result<EvalToolRoster, EvalToolControlError> {
		let value = self
			.request(owner, serde_json::json!({ "op": "describe", "names": names }), cancellation)
			.await?;
		if value.get("ok").and_then(Value::as_bool) != Some(true) {
			return Err(EvalToolControlError::InvalidResponse);
		}
		let mut roster = serde_json::from_value::<EvalToolRoster>(value)
			.map_err(|source| EvalToolControlError::Json { source })?;
		let epoch = self.reset_generation.load(Ordering::Acquire);
		for tool in &mut roster.tools {
			if tool.generation != roster.generation
				|| tool.name.is_empty()
				|| tool.rev == 0
				|| tool.handler.is_empty()
				|| !tool.parameters.is_object()
			{
				return Err(EvalToolControlError::InvalidResponse);
			}
			tool.epoch = epoch;
		}
		Ok(roster)
	}

	async fn invoke(
		&self,
		owner: &str,
		registration: &EvalToolRegistration,
		mut args: Value,
		cancellation: CancellationToken,
	) -> Result<EvalToolResult, EvalToolControlError> {
		let current = self.reset_generation.load(Ordering::Acquire);
		if registration.epoch != current {
			return Err(EvalToolControlError::StaleEpoch {
				name: registration.name.clone(),
				current,
				received: registration.epoch,
			});
		}
		if let Some(object) = args.as_object_mut() {
			let schema_declares_intent = registration
				.parameters
				.get("properties")
				.and_then(Value::as_object)
				.is_some_and(|properties| properties.contains_key("i"));
			if !schema_declares_intent {
				object.remove("i");
			}
		}
		let value = self
			.request(
				owner,
				serde_json::json!({
					"op": "call",
					"name": registration.name,
					"rev": registration.rev,
					"handler": registration.handler,
					"generation": registration.generation,
					"args": args,
				}),
				cancellation,
			)
			.await?;
		match value.get("ok").and_then(Value::as_bool) {
			Some(true) => Ok(EvalToolResult {
				value:    value.get("value").cloned().unwrap_or(Value::Null),
				is_error: false,
			}),
			Some(false) => Ok(EvalToolResult {
				value:    value
					.get("error")
					.cloned()
					.unwrap_or_else(|| Value::String("eval-defined tool failed".to_owned())),
				is_error: true,
			}),
			None => Err(EvalToolControlError::InvalidResponse),
		}
	}
}

/// External reset and disposal trigger used when chat identity changes.
#[derive(Clone)]
pub struct EvalSessionControl {
	inner: Arc<EvalSessionControlInner>,
}

enum EvalSessionControlInner {
	Local {
		reset_generation: Arc<AtomicU64>,
		dispose_all:      Arc<dyn Fn() + Send + Sync>,
		tool_host:        Arc<dyn EvalDefinedToolHost>,
	},
	Remote {
		client:  EnvClient,
		runtime: runtime::Handle,
	},
}

impl Default for EvalSessionControl {
	fn default() -> Self {
		Self {
			inner: Arc::new(EvalSessionControlInner::Local {
				reset_generation: Arc::new(AtomicU64::new(0)),
				dispose_all:      Arc::new(|| {}),
				tool_host:        Arc::new(UnavailableEvalDefinedToolHost),
			}),
		}
	}
}

impl EvalSessionControl {
	/// Creates a reset capability backed by a remote Environment client.
	///
	/// Calls to [`Self::request_reset`] remain synchronous and schedule exactly
	/// one cold protocol request on the Tokio runtime active at construction.
	#[must_use]
	pub fn from_client(client: EnvClient) -> Self {
		Self {
			inner: Arc::new(EvalSessionControlInner::Remote {
				client,
				runtime: runtime::Handle::current(),
			}),
		}
	}

	/// Seals registrations carried by an authenticated eval bridge call.
	///
	/// The reset epoch is host-owned and cannot be supplied by Python. Namespace
	/// generation and opaque handler identity remain child-owned and are checked
	/// again inside the retained process on every call.
	pub fn seal_registrations(
		&self,
		mut tools: Vec<EvalToolRegistration>,
	) -> Result<EvalToolRoster, EvalToolControlError> {
		let epoch = match self.inner.as_ref() {
			EvalSessionControlInner::Local { reset_generation, .. } => {
				reset_generation.load(Ordering::Acquire)
			},
			EvalSessionControlInner::Remote { .. } => return Err(EvalToolControlError::Unavailable),
		};
		let generation = tools.first().map_or(0, |tool| tool.generation);
		let mut names = std::collections::BTreeSet::new();
		for tool in &mut tools {
			if generation == 0
				|| tool.generation != generation
				|| tool.name.is_empty()
				|| tool.rev == 0
				|| tool.handler.is_empty()
				|| !tool.parameters.is_object()
				|| !names.insert(tool.name.clone())
			{
				return Err(EvalToolControlError::InvalidResponse);
			}
			tool.epoch = epoch;
		}
		Ok(EvalToolRoster { generation, tools, missing: Vec::new() })
	}

	/// Resolves exact eval-defined registrations in requested order.
	///
	/// The returned epoch and handler identities are checked again on every
	/// invocation, so a reset, redefine, or undefine can never retarget an
	/// already-running child.
	pub async fn describe_tools(
		&self,
		owner: &str,
		names: &[Str],
		cancellation: CancellationToken,
	) -> Result<EvalToolRoster, EvalToolControlError> {
		match self.inner.as_ref() {
			EvalSessionControlInner::Local { tool_host, .. } => {
				tool_host.describe(owner, names, cancellation).await
			},
			EvalSessionControlInner::Remote { .. } => Err(EvalToolControlError::Unavailable),
		}
	}

	/// Calls one exact eval-defined handler registration.
	///
	/// Handler failures are returned as [`EvalToolResult::is_error`]; transport,
	/// cancellation, and generation failures remain typed control errors.
	pub async fn invoke_tool(
		&self,
		owner: &str,
		registration: &EvalToolRegistration,
		args: Value,
		cancellation: CancellationToken,
	) -> Result<EvalToolResult, EvalToolControlError> {
		match self.inner.as_ref() {
			EvalSessionControlInner::Local { reset_generation, tool_host, .. } => {
				let current = reset_generation.load(Ordering::Acquire);
				if registration.epoch != current {
					return Err(EvalToolControlError::StaleEpoch {
						name: registration.name.clone(),
						current,
						received: registration.epoch,
					});
				}
				tool_host
					.invoke(owner, registration, args, cancellation)
					.await
			},
			EvalSessionControlInner::Remote { .. } => Err(EvalToolControlError::Unavailable),
		}
	}

	/// Disposes every live process and makes each owner's next cell fresh.
	pub fn request_reset(&self) {
		match self.inner.as_ref() {
			EvalSessionControlInner::Local { reset_generation, dispose_all, .. } => {
				reset_generation.fetch_add(1, Ordering::AcqRel);
				dispose_all();
			},
			EvalSessionControlInner::Remote { client, runtime } => {
				let client = client.clone();
				drop(runtime.spawn(async move {
					if let Err(error) = client.reset_eval().await {
						tracing::warn!(error = ?error, "remote evaluation reset failed");
					}
				}));
			},
		}
	}

	fn reset_generation(&self) -> u64 {
		match self.inner.as_ref() {
			EvalSessionControlInner::Local { reset_generation, .. } => {
				reset_generation.load(Ordering::Acquire)
			},
			EvalSessionControlInner::Remote { .. } => 0,
		}
	}
}

/// Constructs `py_eval@1` over the shared killable eval resource.
///
/// Every invocation runs in a fresh namespace and requests a disposable child;
/// the returned tool never initializes Python in its own process.
pub fn py_eval<E: EvalExec>(exec: E) -> PyEvalTool<E> {
	PyEvalTool { exec, sessions: Arc::new(DashMap::new()), spec: py_eval_spec() }
}

/// Returns the canonical host-free `py_eval@1` declaration.
#[must_use]
pub fn py_eval_spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("py_eval"),
		rev:             Rev { family: Str::default(), n: 1 },
		description:     sf!("Evaluate one Python expression"),
		schema:          Bytes::from_static(
			br#"{"type":"object","properties":{"code":{"type":"string","minLength":1}},"required":["code"],"additionalProperties":false}"#,
		),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         eval_effects(),
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("eval.rs"),
		)
		.into(),
	}
}

/// Constructs `eval@1` over a persistent Python resource.
pub fn eval<E: EvalExec>(exec: E) -> EvalTool<E> {
	eval_controlled(exec).0
}

/// Constructs `eval@1` together with its owning session reset capability.
pub fn eval_controlled<E: EvalExec>(exec: E) -> (EvalTool<E>, EvalSessionControl) {
	eval_controlled_described(exec, standard_eval_description())
}

/// Builds the host-free `eval@1` declaration for a frozen prompt description.
pub fn spec(description: Str) -> ToolSpec {
	ToolSpec {
		name: sf!("eval"),
		rev: Rev { family: Str::default(), n: 1 },
		description,
		schema: omp_tool::schema::<Params>(),
		constraint: Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects: eval_effects(),
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("eval.rs"),
		)
		.into(),
	}
}

fn eval_effects() -> Effects {
	Effects {
		documents: Some(DocEffects {
			read:        true,
			write_globs: [sf!("**")].into_iter().collect(),
		}),
		exec:      Some(ExecEffects { commands: [sf!("*")].into_iter().collect(), network: true }),
		inference: Some(InferenceEffects {
			max_requests: u32::MAX,
			max_usd:      Usd::from_nanos(u64::MAX),
		}),
		desktop:   None,
		subagents: u32::MAX,
	}
}

/// Constructs `eval@1` with task guidance frozen from one live session
/// snapshot.
pub fn eval_controlled_with_task_snapshot<E: EvalExec>(
	exec: E,
	snapshot: TaskDescriptionSnapshot<'_>,
) -> (EvalTool<E>, EvalSessionControl) {
	eval_controlled_described(exec, task_description(snapshot))
}

fn eval_controlled_described<E: EvalExec>(
	exec: E,
	description: Str,
) -> (EvalTool<E>, EvalSessionControl) {
	let disposer = exec.clone();
	let sessions = Arc::new(DashMap::new());
	let reset_generation = Arc::new(AtomicU64::new(0));
	let tool_host: Arc<dyn EvalDefinedToolHost> = Arc::new(LocalEvalDefinedToolHost {
		exec:             exec.clone(),
		sessions:         Arc::clone(&sessions),
		reset_generation: Arc::clone(&reset_generation),
	});
	let control = EvalSessionControl {
		inner: Arc::new(EvalSessionControlInner::Local {
			reset_generation,
			dispose_all: Arc::new(move || disposer.dispose_all()),
			tool_host,
		}),
	};
	let tool = EvalTool {
		exec,
		sessions,
		control: control.clone(),
		next_background_name: AtomicU64::new(1),
		auto_background_threshold: DEFAULT_AUTO_BACKGROUND_THRESHOLD,
		spec: spec(description),
	};
	(tool, control)
}

impl<E: EvalExec> EvalTool<E> {
	/// Overrides how long eval cells wait before managed detachment.
	pub const fn with_auto_background_threshold(mut self, threshold: Duration) -> Self {
		self.auto_background_threshold = threshold;
		self
	}
}

fn py_eval_source(code: &str) -> Str {
	let expression =
		serde_json::to_string(code).expect("serializing a Rust string to JSON cannot fail");
	Str::from(format!(
		r#"import builtins as __omp_py_eval_builtins
import json as __omp_py_eval_json

def __omp_py_eval_pack(value):
	try:
		__omp_py_eval_json.dumps(value, allow_nan=False)
	except BaseException:
		return {{"result": repr(value)}}
	return {{"result": value}}

__omp_py_eval_globals = {{"__builtins__": __omp_py_eval_builtins}}
__omp_py_eval_pack(eval(compile({expression}, "<py_eval>", "eval"), __omp_py_eval_globals, __omp_py_eval_globals))"#
	))
}

fn py_eval_completion(completion: RunCompletion) -> Result<PyEvalPayload, PyEvalFault> {
	if completion.status.outcome != CellOutcome::Complete {
		return match completion.status.exception {
			Some(exception) => Err(PyEvalFault::Python {
				name:      exception.name,
				message:   exception.message,
				traceback: exception.traceback,
			}),
			None => Err(PyEvalFault::InvalidResult),
		};
	}
	let mut value = completion
		.result
		.and_then(|value| value.json)
		.and_then(|value| match value {
			Value::Object(value) => Some(value),
			_ => None,
		})
		.ok_or(PyEvalFault::InvalidResult)?;
	let result = value.remove("result").ok_or(PyEvalFault::InvalidResult)?;
	Ok(PyEvalPayload { result })
}

const fn py_eval_resource(fault: Fault) -> PyEvalFault {
	PyEvalFault::Resource { fault }
}

impl<E: EvalExec> Tool for PyEvalTool<E> {
	type Fault = PyEvalFault;
	type Params = PyEvalParams;
	type Payload = PyEvalPayload;
	type Update = PyEvalUpdate;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		let owner = params
			.owner()
			.cloned()
			.unwrap_or_else(|| sf!("__direct_py_eval_owner__"));
		stream! {
			let args = match params.whole::<PyEvalParams>().await {
				Ok(args) => args,
				Err(error) => {
					yield py_eval_param_event(error);
					return;
				},
			};
			if args.code.is_empty() {
				yield Ev::Done(ToolTerminal::Done {
					result: Err(PyEvalFault::EmptyCode),
					useless: true,
				});
				return;
			}
			if let Err(error) = params.committed().await {
				yield py_eval_commit_event(error);
				return;
			}

			let owned = self
				.sessions
				.entry(owner.clone())
				.or_insert_with(|| Arc::new(OnceCell::new()))
				.clone();
			let session = match owned
				.get_or_try_init(|| self.exec.open_session_for(owner.as_str()))
				.await
			{
				Ok(session) => session.clone(),
				Err(fault) => {
					yield Ev::Done(ToolTerminal::Done {
						result: Err(py_eval_resource(fault)),
						useless: false,
					});
					return;
				},
			};
			let runtime = match self.exec.runtime_snapshot(owner.as_str(), &session) {
				Ok(runtime) => runtime,
				Err(fault) => {
					yield Ev::Done(ToolTerminal::Done {
						result: Err(py_eval_resource(fault)),
						useless: false,
					});
					return;
				},
			};
			let mut run = match self.exec.run_with_mode(
				&session,
				RunRequest {
					code: py_eval_source(args.code.as_str()),
					timeout: None,
					reset: true,
					runtime,
				},
				true,
			).await {
				Ok(run) => run,
				Err(fault) => {
					yield Ev::Done(ToolTerminal::Done {
						result: Err(py_eval_resource(fault)),
						useless: false,
					});
					return;
				},
			};
			let mut cancellation_reason = None;
			loop {
				let event = if cancellation_reason.is_some() {
					run.next_event().await
				} else {
					let next = run.next_event().fuse();
					let interrupt = params.next_interrupt().fuse();
					let selected = {
						pin_mut!(next, interrupt);
						match futures::future::select(interrupt, next).await {
							Either::Left((interrupt, _)) => Either::Left(interrupt),
							Either::Right((event, _)) => Either::Right(event),
						}
					};
					match selected {
						Either::Left(interrupt) => {
							let reason = match interrupt {
								Ok(interrupt) => interrupt.reason,
								Err(InterruptWaitError::Closed) =>
									sf!("invocation owner disappeared"),
								Err(InterruptWaitError::Protocol(reason)) => reason,
							};
							if run.cancel().await.is_err() {
								let _ = self.exec.dispose_session(&session).await;
								yield Ev::Aborted(Abort::EffectsUnknown { reason });
								return;
							}
							cancellation_reason = Some(reason);
							continue;
						},
						Either::Right(event) => event,
					}
				};

				match event {
					Ok(Some(RunEvent::Started { .. } | RunEvent::Output(_))) => {},
					Ok(Some(RunEvent::Completed(completion))) => {
						let disposed = self.exec.dispose_session(&session).await;
						if let Some(reason) = cancellation_reason {
							yield Ev::Aborted(Abort::EffectsUnknown { reason });
						} else if let Err(fault) = disposed {
							yield Ev::Done(ToolTerminal::Done {
								result: Err(py_eval_resource(fault)),
								useless: false,
							});
						} else {
							yield Ev::Done(ToolTerminal::Done {
								result: py_eval_completion(completion),
								useless: false,
							});
						}
						return;
					},
					Ok(None) => {
						let _ = self.exec.dispose_session(&session).await;
						if let Some(reason) = cancellation_reason {
							yield Ev::Aborted(Abort::EffectsUnknown { reason });
						} else {
							yield Ev::Done(ToolTerminal::Done {
								result: Err(PyEvalFault::InvalidResult),
								useless: false,
							});
						}
						return;
					},
					Err(fault) => {
						let _ = self.exec.dispose_session(&session).await;
						if let Some(reason) = cancellation_reason {
							yield Ev::Aborted(Abort::EffectsUnknown { reason });
						} else {
							yield Ev::Done(ToolTerminal::Done {
								result: Err(py_eval_resource(fault)),
								useless: false,
							});
						}
						return;
					},
				}
			}
		}
	}

	fn prompt(&self, view: Result<&PyEvalPayload, &PyEvalFault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text {
			text: match view {
				Ok(payload) => Str::from(
					serde_json::to_string(payload)
						.expect("serializing a JSON-safe py_eval payload cannot fail"),
				),
				Err(fault) => Str::from(fault.to_string()),
			},
		}]
	}
}

impl<E: EvalExec> Tool for EvalTool<E> {
	type Fault = Fault;
	type Params = Params;
	type Payload = Payload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		let owner = params
			.owner()
			.cloned()
			.unwrap_or_else(|| sf!("__direct_eval_owner__"));
		stream! {
			let args = match params.whole::<Params>().await {
				Ok(args) => args,
				Err(error) => {
					yield param_event(error);
					return;
				},
			};
			let timeout = match args.timeout {
				None => Some(Duration::from_secs(30)),
				Some(0.0) => None,
				Some(value) if value.is_finite() && value > 0.0 =>
					Some(Duration::from_secs_f64(value).min(MAX_CELL_TIMEOUT)),
				Some(_) => {
					yield Ev::Done(ToolTerminal::Done { result: Err(Fault::InvalidTimeout), useless: false });
					return;
				},
			};
			if let Err(error) = params.committed().await {
				yield commit_event(error);
				return;
			}

			let reset_generation = self.control.reset_generation();
			let owned = self
				.sessions
				.entry(owner.clone())
				.or_insert_with(|| Arc::new(OwnerSession {
					session: OnceCell::new(),
					reset_generation: AtomicU64::new(reset_generation),
				}))
				.clone();
			let session = match owned
				.session
				.get_or_try_init(|| self.exec.open_session_for(owner.as_str()))
				.await
			{
				Ok(session) => session.clone(),
				Err(fault) => {
					yield Ev::Done(ToolTerminal::Done { result: Err(fault), useless: false });
					return;
				},
			};
			let reset = args.reset.unwrap_or(false)
				|| owned.reset_generation.swap(reset_generation, Ordering::AcqRel) != reset_generation;
			if reset
				&& let Err(fault) = self.exec.dispose_session(&session).await
			{
				yield Ev::Done(ToolTerminal::Done { result: Err(fault), useless: false });
				return;
			}
			let runtime = match self.exec.runtime_snapshot(owner.as_str(), &session) {
				Ok(runtime) => runtime,
				Err(fault) => {
					yield Ev::Done(ToolTerminal::Done { result: Err(fault), useless: false });
					return;
				},
			};
			let disposable = args.kernel_mode == Some(KernelMode::PerCall);
			let mut run = match self.exec.run_with_mode(&session, RunRequest {
				code: args.code.clone(),
				timeout,
				reset,
				runtime,
			}, disposable).await {
				Ok(run) => run,
				Err(fault) => {
					yield Ev::Done(ToolTerminal::Done { result: Err(fault), useless: false });
					return;
				},
			};
			let reset = run.reset();
			let foreground_wait =
				ForegroundWait::new(self.auto_background_threshold, timeout);
			let mut auto_background = true;

			let mut cell_id = Bytes::new();
			let mut had_output = false;
			let mut cancellation_reason: Option<Str> = None;
			loop {
				let event = if cancellation_reason.is_some() {
					run.next_event().await
				} else {
					let selected = if auto_background {
						match foreground_wait
							.race(run.next_event(), params.next_interrupt())
							.await
						{
							JobWait::Settled(event) => PendingEval::Event(event),
							JobWait::Interrupted(interrupt) => PendingEval::Interrupt(interrupt),
							JobWait::Background => PendingEval::Background,
						}
					} else {
						let next = run.next_event().fuse();
						let interrupt = params.next_interrupt().fuse();
						pin_mut!(next, interrupt);
						match futures::future::select(interrupt, next).await {
							Either::Left((interrupt, _)) => PendingEval::Interrupt(interrupt),
							Either::Right((event, _)) => PendingEval::Event(event),
						}
					};
					match selected {
						PendingEval::Background => {
							let name =
								next_background_name("eval", &self.next_background_name);
							if let Ok(job) = run.detach(name).await {
								yield Ev::Done(detached_terminal(job));
								return;
							}
							auto_background = false;
							continue;
						},
						PendingEval::Interrupt(interrupt) => {
							let interrupt = match interrupt {
								Ok(interrupt) => interrupt,
								Err(InterruptWaitError::Closed) => Interrupt {
									class: sf!("closed"),
									reason: sf!("invocation owner disappeared"),
								},
								Err(InterruptWaitError::Protocol(reason)) => Interrupt {
									class: sf!("protocol"),
									reason,
								},
							};
							if interrupt.class == Interrupt::STEERING {
								let name =
									next_background_name("eval", &self.next_background_name);
								if let Ok(job) = run.detach(name).await {
									yield Ev::Done(detached_terminal(job));
									return;
								}
							}
							let reason = interrupt.reason;
							if run.cancel().await.is_err() {
								yield Ev::Aborted(Abort::EffectsUnknown { reason });
								return;
							}
							cancellation_reason = Some(reason);
							continue;
						},
						PendingEval::Event(event) => event,
					}
				};

				match event {
					Ok(Some(RunEvent::Started { cell_id: id })) => cell_id = id,
					Ok(Some(RunEvent::Output(update))) => {
						had_output |= !update.data.is_empty();
						yield Ev::Update(update);
					},
					Ok(Some(RunEvent::Completed(done))) => {
						if let Some(reason) = cancellation_reason {
							yield Ev::Aborted(Abort::EffectsUnknown { reason });
							return;
						}
						yield Ev::Done(ToolTerminal::Done {
							result: Ok(Payload {
								session_id: session.id,
								cell_id,
								language: args.language,
								title: args.title,
								code: args.code,
								reset,
								had_output,
								result: done.result,
								display_outputs: done.display_outputs,
								status: done.status,
							}),
							useless: false,
						});
						return;
					},
					Ok(None) => {
						yield Ev::Aborted(Abort::EffectsUnknown {
							reason: cancellation_reason.unwrap_or_else(|| sf!("eval event stream ended before terminal status")),
						});
						return;
					},
					Err(fault) => {
						if let Some(reason) = cancellation_reason {
							yield Ev::Aborted(Abort::EffectsUnknown { reason });
						} else {
							yield Ev::Done(ToolTerminal::Done { result: Err(fault), useless: false });
						}
						return;
					},
				}
			}
		}
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, caps: &PromptCaps) -> Vec<Part> {
		let payload = match view {
			Ok(payload) => payload,
			Err(fault) => {
				let Some(mut projection) = TextProjection::new(*caps) else {
					return Vec::new();
				};
				let message = match fault {
					Fault::InvalidTimeout => {
						"eval timeout must be a finite non-negative number".to_owned()
					},
					Fault::Resource { operation, message } => {
						format!("eval {operation} failed: {message}")
					},
					Fault::SessionLost { message } => format!("eval session lost: {message}"),
				};
				projection.push(&message);
				return projection.finish();
			},
		};

		let mut stdout = String::new();
		if let Some(result) = &payload.result
			&& !result.text.is_empty()
		{
			stdout.push_str(&result.text);
			if !result.text.ends_with('\n') {
				stdout.push('\n');
			}
		}
		for display in &payload.display_outputs {
			match display {
				DisplayOutput::Markdown { text } => {
					stdout.push_str(text);
					if !text.ends_with('\n') {
						stdout.push('\n');
					}
				},
				DisplayOutput::Image { description, .. } if !description.is_empty() => {
					stdout.push_str(description);
					if !description.ends_with('\n') {
						stdout.push('\n');
					}
				},
				DisplayOutput::Json { .. }
				| DisplayOutput::ImageData { .. }
				| DisplayOutput::Image { .. }
				| DisplayOutput::Status { .. } => {},
			}
		}
		if let Some(exception) = &payload.status.exception {
			if exception.traceback.is_empty() {
				stdout.push_str(&exception.name);
				stdout.push_str(": ");
				stdout.push_str(&exception.message);
				stdout.push('\n');
			} else {
				for line in &exception.traceback {
					stdout.push_str(line);
					if !line.ends_with('\n') {
						stdout.push('\n');
					}
				}
			}
		}

		let stdout = stdout.trim();
		let display_text = format_display_json(&payload.display_outputs);
		let image_count = payload
			.display_outputs
			.iter()
			.filter(|output| {
				matches!(output, DisplayOutput::Image { .. } | DisplayOutput::ImageData { .. })
			})
			.count();
		let visible_display = if display_text.is_empty() && image_count != 0 && stdout.is_empty() {
			format!(
				"(displayed {image_count} image{}; no text output)",
				if image_count == 1 { "" } else { "s" }
			)
		} else {
			display_text
		};
		let stdout_empty = stdout.is_empty();
		let visible_display_empty = visible_display.is_empty();
		let mut text = match (stdout_empty, visible_display_empty) {
			(false, false) => format!("{stdout}\n\n{visible_display}"),
			(false, true) => stdout.to_owned(),
			(true, false) => visible_display,
			(true, true) if payload.had_output => String::new(),
			(true, true) => "(no output)".to_owned(),
		};

		match payload.status.outcome {
			CellOutcome::Error => {
				let code = payload.status.exit_code.unwrap_or(1);
				text = if stdout_empty && visible_display_empty {
					format!("Command exited with code {code}")
				} else {
					format!("{text}\n\nCommand exited with code {code}")
				};
			},
			CellOutcome::Timeout if stdout_empty && visible_display_empty => {
				text.clear();
				text.push_str("Command timed out");
			},
			CellOutcome::Cancelled if stdout_empty && visible_display_empty => {
				text.clear();
				text.push_str("Command aborted");
			},
			CellOutcome::Complete | CellOutcome::Timeout | CellOutcome::Cancelled => {},
		}

		let Some(mut projection) = TextProjection::new(*caps) else {
			return Vec::new();
		};
		projection.push(&text);
		let mut parts = projection.finish();
		if caps.media {
			let mut image_index = 0usize;
			for output in &payload.display_outputs {
				if parts.len() >= usize::from(caps.maximum_parts) {
					break;
				}
				if let DisplayOutput::Image { blob, description, .. } = output {
					image_index += 1;
					parts.push(Part::Blob {
						blob: blob.clone(),
						alt:  Some(if description.is_empty() {
							sf!("display image {image_index}")
						} else {
							description.clone()
						}),
					});
				}
			}
		}
		parts
	}

	fn invoke_input(&self, update: &Update, invocation_id: &str) -> Option<InvokeInput> {
		let channel = match update.channel {
			OutputChannel::Stdout => chunk::Channel::Stdout,
			OutputChannel::Stderr => chunk::Channel::Stderr,
		};
		Some(InvokeInput {
			invocation_id: invocation_id.to_owned(),
			payload:       Some(invoke_input::Payload::Chunk(invoke_input::Chunk {
				channel: channel as i32,
				data:    update.data.clone().into_bytes(),
			})),
		})
	}
}

fn detached_terminal(job: DetachedJob) -> ToolTerminal<Payload, Fault> {
	managed_job_terminal(job, omp_tool::JobKind::Eval, sf!("eval cell settlement"))
}

fn py_eval_param_event(error: ParamError) -> Ev<PyEvalUpdate, PyEvalPayload, PyEvalFault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(reason) => Ev::Args(ArgIssue {
			path:     Vec::new(),
			expected: sf!("one complete py_eval@1 expression object"),
			kind:     ArgIssueKind::Protocol,
			example:  Some(Str::new_static(r#"{"code":"1 + 1"}"#)),
			found:    Some(reason),
		}),
	}
}

fn py_eval_commit_event(error: CommitError) -> Ev<PyEvalUpdate, PyEvalPayload, PyEvalFault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(reason) => Ev::Args(ArgIssue {
			path:     Vec::new(),
			expected: sf!("one complete py_eval@1 expression object"),
			kind:     ArgIssueKind::Protocol,
			example:  Some(Str::new_static(r#"{"code":"1 + 1"}"#)),
			found:    Some(reason),
		}),
	}
}

fn param_event<U, P>(error: ParamError) -> Ev<U, P, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(reason) => Ev::Args(protocol_issue(reason)),
	}
}

fn commit_event<U, P>(error: CommitError) -> Ev<U, P, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(reason) => Ev::Args(protocol_issue(reason)),
	}
}

fn protocol_issue(reason: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one complete eval@1 Python cell object"),
		kind:     ArgIssueKind::Protocol,
		example:  Some(Str::new_static(r#"{"language":"py","code":"1 + 1"}"#)),
		found:    Some(reason),
	}
}

mod cow_bytes {
	use omp_core::CowBytes;
	use serde::{Deserialize, Deserializer, Serialize, Serializer};

	pub(super) fn serialize<S: Serializer>(
		value: &CowBytes<'static>,
		serializer: S,
	) -> Result<S::Ok, S::Error> {
		value.serialize(serializer)
	}

	pub(super) fn deserialize<'de, D: Deserializer<'de>>(
		deserializer: D,
	) -> Result<CowBytes<'static>, D::Error> {
		Vec::<u8>::deserialize(deserializer).map(CowBytes::from)
	}
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::AtomicBool;

	use parking_lot::Mutex;

	use super::*;

	#[derive(Clone)]
	struct EvalToolProtocolExec {
		last_code: Arc<Mutex<Str>>,
		cancelled: Arc<AtomicBool>,
	}

	struct EvalToolProtocolRun {
		event:     Option<RunEvent>,
		pending:   bool,
		cancelled: Arc<AtomicBool>,
	}

	impl EvalRun for EvalToolProtocolRun {
		fn reset(&self) -> bool {
			false
		}

		async fn next_event(&mut self) -> Result<Option<RunEvent>, Fault> {
			if self.pending {
				future::pending().await
			} else {
				Ok(self.event.take())
			}
		}

		async fn cancel(&self) -> Result<(), Fault> {
			self.cancelled.store(true, Ordering::Release);
			Ok(())
		}
	}

	impl EvalExec for EvalToolProtocolExec {
		type Run = EvalToolProtocolRun;

		async fn open_session(&self) -> Result<Session, Fault> {
			Ok(Session { id: Bytes::from_static(b"eval-tools") })
		}

		async fn run<'a>(
			&'a self,
			_session: &'a Session,
			request: RunRequest,
		) -> Result<Self::Run, Fault> {
			let pending = request.code.contains(r#"\"name\":\"hang\""#);
			*self.last_code.lock() = request.code;
			Ok(EvalToolProtocolRun {
				event: Some(RunEvent::Completed(RunCompletion {
					status:          CellStatus {
						outcome:     CellOutcome::Complete,
						exit_code:   Some(0),
						duration_ms: 1,
						exception:   None,
					},
					result:          Some(CellValue {
						text: sf!("ok"),
						json: Some(serde_json::json!({
							"ok": true,
							"value": { "score": 9 }
						})),
					}),
					display_outputs: Vec::new(),
				})),
				pending,
				cancelled: Arc::clone(&self.cancelled),
			})
		}
	}

	fn protocol_control() -> (EvalSessionControl, Arc<Mutex<Str>>, Arc<AtomicBool>) {
		let last_code = Arc::new(Mutex::new(Str::default()));
		let cancelled = Arc::new(AtomicBool::new(false));
		let exec = EvalToolProtocolExec {
			last_code: Arc::clone(&last_code),
			cancelled: Arc::clone(&cancelled),
		};
		let sessions = Arc::new(DashMap::new());
		let owned = Arc::new(OwnerSession {
			session:          OnceCell::new(),
			reset_generation: AtomicU64::new(0),
		});
		owned
			.session
			.set(Session { id: Bytes::from_static(b"eval-tools") })
			.expect("install session");
		sessions.insert(sf!("owner"), owned);
		let reset_generation = Arc::new(AtomicU64::new(0));
		let tool_host: Arc<dyn EvalDefinedToolHost> = Arc::new(LocalEvalDefinedToolHost {
			exec,
			sessions,
			reset_generation: Arc::clone(&reset_generation),
		});
		(
			EvalSessionControl {
				inner: Arc::new(EvalSessionControlInner::Local {
					reset_generation,
					dispose_all: Arc::new(|| {}),
					tool_host,
				}),
			},
			last_code,
			cancelled,
		)
	}

	#[tokio::test]
	async fn forwarded_handler_calls_return_json_strip_harness_intent_and_cancel() {
		let (control, last_code, cancelled) = protocol_control();
		let registration = control
			.seal_registrations(vec![EvalToolRegistration {
				name:        sf!("score"),
				description: sf!("Score"),
				parameters:  serde_json::json!({
					"type": "object",
					"properties": { "value": { "type": "integer" } }
				}),
				rev:         3,
				handler:     sf!("handler"),
				generation:  2,
				epoch:       0,
			}])
			.expect("seal registration")
			.tools
			.remove(0);
		let result = control
			.invoke_tool(
				"owner",
				&registration,
				serde_json::json!({ "i": "Scoring", "value": 4 }),
				CancellationToken::new(),
			)
			.await
			.expect("invoke handler");
		assert_eq!(result, EvalToolResult {
			value:    serde_json::json!({ "score": 9 }),
			is_error: false,
		});
		assert!(!last_code.lock().contains(r#"\"i\""#));

		let mut hanging = registration;
		hanging.name = sf!("hang");
		let stop = CancellationToken::new();
		stop.cancel();
		assert!(matches!(
			control
				.invoke_tool("owner", &hanging, serde_json::json!({}), stop)
				.await,
			Err(EvalToolControlError::Cancelled)
		));
		assert!(cancelled.load(Ordering::Acquire));
	}

	#[test]
	fn standard_task_description_omits_empty_extension_helpers() {
		let description = standard_eval_description();

		assert_eq!(description, task_description(TaskDescriptionSnapshot::standard()));
		assert!(!description.contains("<extension-helpers>"));
		assert!(description.ends_with("</task-runtime>"));
	}

	#[test]
	fn eval_guidance_tracks_subagent_availability_and_timeout_precedence() {
		let available = task_description(TaskDescriptionSnapshot::standard());
		assert!(available.contains("Eval `agent()` children use independent kernels."));
		assert!(available.contains("agent(prompt"));
		assert!(available.contains(
			"`timeout: 0` disables the cell deadline; otherwise `timeout` sets it without extending \
			 foreground waiting."
		));

		let unavailable = task_description(TaskDescriptionSnapshot {
			agents: &[],
			..TaskDescriptionSnapshot::standard()
		});
		assert!(!unavailable.contains("agent(prompt"));
		assert!(!unavailable.contains("agent()"));
		assert!(!unavailable.contains("<dag>"));
		assert!(!unavailable.contains("<task-runtime>"));
	}

	#[test]
	fn task_description_renders_extension_helpers_after_runtime() {
		let helpers = [
			PreludeHelperDescription {
				signature: "merge_patches(patches, *, strategy=\"sequential\")",
				summary:   "Merge patches using the requested strategy.",
			},
			PreludeHelperDescription {
				signature: "workspace_root()",
				summary:   "Return the active workspace root.",
			},
		];
		let description = task_description(TaskDescriptionSnapshot {
			helpers: &helpers,
			..TaskDescriptionSnapshot::standard()
		});

		assert!(description.contains("</task-runtime>\n\n<extension-helpers>"));
		assert!(description.ends_with(
			"<extension-helpers>\nExtension-provided prelude functions (call like any prelude \
			 helper):\n- `merge_patches(patches, *, strategy=\"sequential\")` — Merge patches using \
			 the requested strategy.\n- `workspace_root()` — Return the active workspace \
			 root.\n</extension-helpers>"
		));
	}

	#[test]
	fn params_accept_omitted_optionals_and_reject_invalid_fields() {
		let python: Params = serde_json::from_value(serde_json::json!({
			"language": "py",
			"code": "value = 1"
		}))
		.expect("Python cell parses");
		assert_eq!(python.language, Language::Py);
		assert_eq!(python.title, None);
		assert_eq!(python.timeout, None);
		assert_eq!(python.reset, None);
		assert_eq!(python.kernel_mode, None);
		assert!(
			serde_json::from_value::<Params>(serde_json::json!({
				"language": "js",
				"code": "1 + 1"
			}))
			.is_err()
		);
		assert!(
			serde_json::from_value::<Params>(serde_json::json!({
				"language": "py",
				"code": "1 + 1",
				"extra": true
			}))
			.is_err()
		);
	}

	#[derive(Clone)]
	struct PyEvalProtocolExec {
		completions: Arc<Mutex<std::collections::VecDeque<RunCompletion>>>,
		requests:    Arc<Mutex<Vec<(RunRequest, bool)>>>,
		cancelled:   Arc<AtomicBool>,
		disposals:   Arc<AtomicU64>,
	}

	struct PyEvalProtocolRun {
		completion: Option<RunCompletion>,
		pending:    bool,
		cancelled:  Arc<AtomicBool>,
	}

	impl EvalRun for PyEvalProtocolRun {
		fn reset(&self) -> bool {
			true
		}

		async fn next_event(&mut self) -> Result<Option<RunEvent>, Fault> {
			if self.pending && !self.cancelled.load(Ordering::Acquire) {
				future::pending().await
			}
			Ok(self.completion.take().map(RunEvent::Completed))
		}

		async fn cancel(&self) -> Result<(), Fault> {
			self.cancelled.store(true, Ordering::Release);
			Ok(())
		}
	}

	impl PyEvalProtocolExec {
		fn start(&self, request: RunRequest, disposable: bool) -> PyEvalProtocolRun {
			let pending = request.code.contains("sleep(30)");
			self.requests.lock().push((request, disposable));
			PyEvalProtocolRun {
				completion: self.completions.lock().pop_front(),
				pending,
				cancelled: Arc::clone(&self.cancelled),
			}
		}
	}

	impl EvalExec for PyEvalProtocolExec {
		type Run = PyEvalProtocolRun;

		async fn open_session(&self) -> Result<Session, Fault> {
			Ok(Session { id: Bytes::from_static(b"py-eval-test") })
		}

		async fn run<'a>(
			&'a self,
			_session: &'a Session,
			request: RunRequest,
		) -> Result<Self::Run, Fault> {
			Ok(self.start(request, false))
		}

		async fn run_with_mode<'a>(
			&'a self,
			_session: &'a Session,
			request: RunRequest,
			disposable: bool,
		) -> Result<Self::Run, Fault> {
			Ok(self.start(request, disposable))
		}

		fn dispose_session(
			&self,
			_session: &Session,
		) -> impl Future<Output = Result<(), Fault>> + Send + '_ {
			self.disposals.fetch_add(1, Ordering::AcqRel);
			future::ready(Ok(()))
		}
	}

	fn py_eval_exec(completions: impl IntoIterator<Item = RunCompletion>) -> PyEvalProtocolExec {
		PyEvalProtocolExec {
			completions: Arc::new(Mutex::new(completions.into_iter().collect())),
			requests:    Arc::new(Mutex::new(Vec::new())),
			cancelled:   Arc::new(AtomicBool::new(false)),
			disposals:   Arc::new(AtomicU64::new(0)),
		}
	}

	fn py_eval_completion_with(result: Value) -> RunCompletion {
		RunCompletion {
			status:          CellStatus {
				outcome:     CellOutcome::Complete,
				exit_code:   Some(0),
				duration_ms: 1,
				exception:   None,
			},
			result:          Some(CellValue {
				text: Str::new(result.to_string()),
				json: Some(serde_json::json!({ "result": result })),
			}),
			display_outputs: Vec::new(),
		}
	}

	#[test]
	fn py_eval_spec_preserves_the_canonical_strict_expression_contract() {
		let declaration = py_eval_spec();
		assert_eq!(declaration.name, "py_eval");
		assert_eq!(declaration.rev, Rev { family: Str::default(), n: 1 });
		assert_eq!(declaration.description, "Evaluate one Python expression");
		assert_eq!(
			serde_json::from_slice::<Value>(&declaration.schema).expect("py_eval schema"),
			serde_json::json!({
				"type": "object",
				"properties": { "code": { "type": "string", "minLength": 1 } },
				"required": ["code"],
				"additionalProperties": false,
			})
		);
	}

	#[tokio::test]
	async fn py_eval_returns_json_or_repr_and_always_uses_a_fresh_disposable_namespace() {
		use futures::StreamExt as _;

		let exec = py_eval_exec([
			py_eval_completion_with(serde_json::json!(42)),
			py_eval_completion_with(serde_json::json!("{1, 2, 3}")),
		]);
		let tool = py_eval(exec.clone());
		for (code, expected) in
			[("6 * 7", serde_json::json!(42)), ("{3, 1, 2}", serde_json::json!("{1, 2, 3}"))]
		{
			let (feed, params) = IncomingParams::channel();
			feed
				.args_committed(Str::from(serde_json::json!({ "code": code }).to_string()))
				.expect("py_eval invocation remains live");
			let events = tool.call(params).collect::<Vec<_>>().await;
			assert!(matches!(
				events.as_slice(),
				[Ev::Done(ToolTerminal::Done {
					result: Ok(PyEvalPayload { result }),
					..
				})] if result == &expected
			));
		}

		let requests = exec.requests.lock();
		assert_eq!(requests.len(), 2);
		assert!(
			requests
				.iter()
				.all(|(request, disposable)| request.reset && *disposable)
		);
		assert!(
			requests
				.iter()
				.all(|(request, _)| request.code.contains("__omp_py_eval_globals"))
		);
		assert_eq!(exec.disposals.load(Ordering::Acquire), 2);
	}

	#[tokio::test]
	async fn py_eval_rejects_empty_code_and_reports_python_errors_as_typed_faults() {
		use futures::StreamExt as _;

		let exec = py_eval_exec([RunCompletion {
			status:          CellStatus {
				outcome:     CellOutcome::Error,
				exit_code:   Some(1),
				duration_ms: 1,
				exception:   Some(PythonException {
					name:      sf!("ZeroDivisionError"),
					message:   sf!("division by zero"),
					traceback: vec![sf!("ZeroDivisionError: division by zero\n")],
				}),
			},
			result:          None,
			display_outputs: Vec::new(),
		}]);
		let tool = py_eval(exec);

		let (empty_feed, empty_params) = IncomingParams::channel();
		empty_feed
			.args_committed(Str::new_static(r#"{"code":""}"#))
			.expect("empty invocation remains live");
		assert!(matches!(tool.call(empty_params).collect::<Vec<_>>().await.as_slice(), [Ev::Done(
			ToolTerminal::Done { result: Err(PyEvalFault::EmptyCode), .. }
		)]));

		let (fault_feed, fault_params) = IncomingParams::channel();
		fault_feed
			.args_committed(Str::new_static(r#"{"code":"1 / 0"}"#))
			.expect("failing invocation remains live");
		assert!(matches!(
			tool.call(fault_params).collect::<Vec<_>>().await.as_slice(),
			[Ev::Done(ToolTerminal::Done {
				result: Err(PyEvalFault::Python { name, message, .. }),
				..
			})] if name == "ZeroDivisionError" && message == "division by zero"
		));
	}

	#[tokio::test]
	async fn py_eval_cancellation_waits_for_disposable_session_reaping() {
		use futures::StreamExt as _;

		let exec = py_eval_exec([RunCompletion {
			status:          CellStatus {
				outcome:     CellOutcome::Cancelled,
				exit_code:   None,
				duration_ms: 1,
				exception:   None,
			},
			result:          None,
			display_outputs: Vec::new(),
		}]);
		let tool = py_eval(exec.clone());
		let (feed, params) = IncomingParams::channel();
		feed
			.args_committed(Str::new_static(r#"{"code":"__import__('time').sleep(30)"}"#))
			.expect("sleeping invocation remains live");
		feed
			.interrupt(Interrupt { class: sf!("user"), reason: sf!("stop py_eval") })
			.expect("interrupt py_eval");

		let events = tool.call(params).collect::<Vec<_>>().await;
		assert!(matches!(
			events.as_slice(),
			[Ev::Aborted(Abort::EffectsUnknown { reason })] if reason == "stop py_eval"
		));
		assert!(exec.cancelled.load(Ordering::Acquire));
		assert_eq!(exec.disposals.load(Ordering::Acquire), 1);
		assert!(exec.requests.lock()[0].1, "py_eval did not request a disposable child");
	}

	#[derive(Clone)]
	struct StreamingExec {
		updates: Arc<Vec<Update>>,
	}

	struct StreamingRun {
		events: std::collections::VecDeque<RunEvent>,
	}

	impl EvalRun for StreamingRun {
		fn reset(&self) -> bool {
			false
		}

		async fn next_event(&mut self) -> Result<Option<RunEvent>, Fault> {
			Ok(self.events.pop_front())
		}

		async fn cancel(&self) -> Result<(), Fault> {
			Ok(())
		}
	}

	impl EvalExec for StreamingExec {
		type Run = StreamingRun;

		async fn open_session(&self) -> Result<Session, Fault> {
			Ok(Session { id: Bytes::from_static(b"streaming-test") })
		}

		async fn run<'a>(
			&'a self,
			_session: &'a Session,
			_request: RunRequest,
		) -> Result<Self::Run, Fault> {
			let mut events = std::collections::VecDeque::new();
			events
				.push_back(RunEvent::Started { cell_id: Bytes::from_static(b"streaming-test:cell-1") });
			events.extend(self.updates.iter().cloned().map(RunEvent::Output));
			events.push_back(RunEvent::Completed(RunCompletion {
				status:          CellStatus {
					outcome:     CellOutcome::Complete,
					exit_code:   Some(0),
					duration_ms: 1,
					exception:   None,
				},
				result:          None,
				display_outputs: Vec::new(),
			}));
			Ok(StreamingRun { events })
		}
	}

	#[tokio::test]
	async fn adapter_streams_output_beyond_legacy_limits_exactly_once() {
		use futures::StreamExt as _;

		let mut expected = Vec::new();
		for line in 0..3_101 {
			expected.extend_from_slice(format!("{line:04}:{}\n", "x".repeat(340)).as_bytes());
		}
		assert!(expected.len() > 1024 * 1024);
		let updates = expected
			.chunks(64 * 1024)
			.enumerate()
			.map(|(sequence, chunk)| Update {
				channel:  OutputChannel::Stdout,
				data:     CowBytes::from(chunk.to_vec()),
				sequence: sequence as u64,
			})
			.collect();
		let tool = eval(StreamingExec { updates: Arc::new(updates) });
		let (feed, params) = IncomingParams::channel();
		feed
			.args_committed(Str::new_static(r#"{"language":"py","code":"emit()"}"#))
			.expect("eval invocation remains live");

		let events = tool.call(params).collect::<Vec<_>>().await;
		let mut actual = Vec::new();
		let mut payload = None;
		for event in events {
			match event {
				Ev::Update(update) => actual.extend_from_slice(update.data.as_ref()),
				Ev::Done(ToolTerminal::Done { result: Ok(done), .. }) => payload = Some(done),
				other => panic!("unexpected eval event: {other:?}"),
			}
		}
		assert_eq!(actual, expected);
		assert!(
			!actual
				.windows(b"truncated".len())
				.any(|window| window == b"truncated")
		);
		let payload = payload.expect("terminal payload");
		assert!(payload.had_output);
		let encoded = serde_json::to_value(&payload).expect("payload serializes");
		assert!(encoded.get("frames").is_none());
		assert!(encoded.get("truncated").is_none());
		assert!(encoded.get("spilled_output").is_none());

		let caps = PromptCaps::for_tool(
			omp_tool::CapsBase {
				maximum_parts:      u16::MAX,
				maximum_text_bytes: u32::MAX,
				media:              true,
				model_class:        omp_tool::ModelClass::Standard,
			},
			&tool.spec().rev,
		);
		assert!(tool.prompt(Ok(&payload), &caps).is_empty());
	}

	#[tokio::test]
	async fn local_control_increments_generation_and_fences_forwarded_handlers() {
		let disposals = Arc::new(AtomicU64::new(0));
		let observed = Arc::clone(&disposals);
		let control = EvalSessionControl {
			inner: Arc::new(EvalSessionControlInner::Local {
				reset_generation: Arc::new(AtomicU64::new(0)),
				dispose_all:      Arc::new(move || {
					observed.fetch_add(1, Ordering::AcqRel);
				}),
				tool_host:        Arc::new(UnavailableEvalDefinedToolHost),
			}),
		};

		let roster = control
			.seal_registrations(vec![EvalToolRegistration {
				name:        sf!("score"),
				description: sf!("Score one value"),
				parameters:  serde_json::json!({"type":"object"}),
				rev:         2,
				handler:     sf!("handler-a"),
				generation:  7,
				epoch:       u64::MAX,
			}])
			.expect("registration seals");
		assert_eq!(roster.tools[0].epoch, 0);

		control.request_reset();
		assert_eq!(control.reset_generation(), 1);
		assert_eq!(disposals.load(Ordering::Acquire), 1);
		assert!(matches!(
			control
				.invoke_tool("owner", &roster.tools[0], serde_json::json!({}), CancellationToken::new(),)
				.await,
			Err(EvalToolControlError::StaleEpoch { current: 1, received: 0, .. })
		));
	}

	#[tokio::test]
	async fn remote_control_emits_exactly_one_reset_request() {
		let (client, transport) = EnvClient::in_process(0);
		let (requests, responses) = transport.into_parts();
		let control = EvalSessionControl::from_client(client);
		control.request_reset();

		let request = requests.recv_async().await.expect("receive eval reset");
		assert!(matches!(request.body, Some(omp_proto::env::v1::client_frame::Body::EvalReset(_))));
		responses
			.send_async(omp_proto::env::v1::ServerFrame {
				request_id: request.request_id,
				body: Some(omp_proto::env::v1::server_frame::Body::EvalReset(
					omp_proto::env::v1::EvalResetResponse {},
				)),
				..omp_proto::env::v1::ServerFrame::default()
			})
			.await
			.expect("answer eval reset");
		tokio::task::yield_now().await;
		assert!(requests.try_recv().is_err(), "control emitted more than one reset request");
	}
}
