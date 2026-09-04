//! Child-agent task tool over an injected host-side spawner.
//!
//! This crate owns only the typed tool contract.  Driver composition owns
//! child kernels, convar seeding, cfg execution, journals and filesystem views.

use std::borrow::Cow;

use async_stream::stream;
use futures::Stream;
use omp_core::{Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, Constraint, Effects, Ev, IncomingParams, ParamError, Part,
	PromptCaps, Rev, Tool, ToolSpec, ToolTerminal,
};
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Serialize};

pub use crate::output_schema::{OutputStatus, SchemaMode};

const DESCRIPTION: &str = "Runs one child or a concurrent batch as detached jobs. Each child is \
                           backed by its own session journal and isolated workspace. The call \
                           returns immediately with job ids; each child's final text, structured \
                           output verdict, workspace disposition, session path, and usage are \
                           delivered to you as an async-result follow-up when it settles, and \
                           `hub wait` can block on it.";

/// Non-blocking advisory appended to every started batch so the model knows
/// what it is waiting on.
pub const STARTED_ADVISORY: &str =
	"No polling needed: each child's result auto-delivers as an async-result follow-up when it \
	 settles, unless a settled `hub jobs`/`hub wait` snapshot consumes it first (no duplicate \
	 delivery). Use `hub` to `send` a running child a message by id, `wait` on it, or `cancel` a \
	 stuck one. `completed` means the child yielded; claimed artifacts are unverified.";

/// Coarse per-child reasoning effort.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskEffort {
	/// Lowest reasoning level supported by the selected model.
	Lo,
	/// Middle reasoning level supported by the selected model.
	Med,
	/// Highest reasoning level supported by the selected model.
	Hi,
}

/// One requested child run.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChildRequest {
	/// Complete child assignment.
	pub task:          Str,
	/// Optional stable display name.
	pub name:          Option<Str>,
	/// Agent class; omitted selects the configured default.
	pub agent:         Option<Str>,
	/// Coarse reasoning effort for this child.
	pub effort:        Option<TaskEffort>,
	/// Invocation-specific JSON output schema; its presence overrides the
	/// selected agent's schema.
	#[serde(rename = "outputSchema")]
	pub output_schema: Option<serde_json::Value>,
	/// Validation behavior for a caller-provided or inherited output schema.
	#[serde(rename = "schemaMode")]
	pub schema_mode:   Option<SchemaMode>,
	/// Run this child in an isolated whole-workspace view; omitted selects the
	/// configured default (`sv_task_isolation_mode`).
	pub isolated:      Option<bool>,
}

/// One concurrent batch request.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BatchRequest {
	/// Shared goal, constraints, and interface contract for every child.
	pub context: Str,
	/// Independent child assignments. The driver runs these concurrently.
	pub tasks:   Vec<ChildRequest>,
}

/// Model arguments for `task@2`.
///
/// The flat form preserves the established single-child contract. The batch
/// form adds shared context without forcing simple callers to wrap one item.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Params {
	/// One child request.
	Single(ChildRequest),
	/// Concurrent child requests.
	Batch(BatchRequest),
}

impl JsonSchema for Params {
	fn inline_schema() -> bool {
		true
	}

	fn schema_name() -> Cow<'static, str> {
		"TaskParams".into()
	}

	fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
		json_schema!({
			"type": "object",
			"properties": {
				"name": {"type": "string"},
				"agent": {"type": "string"},
				"task": {"type": "string"},
				"effort": {"type": "string", "enum": ["lo", "med", "hi"]},
				"outputSchema": {
					"oneOf": [
						{"type": "object"},
						{"type": "boolean"},
						{"type": "string"},
						{"type": "null"}
					]
				},
				"schemaMode": {"type": "string", "enum": ["permissive", "strict"]},
				"isolated": {"type": "boolean"},
				"context": {"type": "string"},
				"tasks": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"name": {"type": "string"},
							"agent": {"type": "string"},
							"task": {"type": "string"},
							"effort": {"type": "string", "enum": ["lo", "med", "hi"]},
							"outputSchema": {
								"oneOf": [
									{"type": "object"},
									{"type": "boolean"},
									{"type": "string"},
									{"type": "null"}
								]
							},
							"schemaMode": {
								"type": "string",
								"enum": ["permissive", "strict"]
							},
							"isolated": {"type": "boolean"}
						},
						"required": ["task"],
						"additionalProperties": false
					}
				}
			},
			"oneOf": [
				{"required": ["task"]},
				{"required": ["context", "tasks"]}
			],
			"additionalProperties": false
		})
	}
}

impl Params {
	/// Normalizes either wire shape for the driver scheduler.
	#[must_use]
	pub fn into_batch(self) -> BatchRequest {
		match self {
			Self::Single(child) => BatchRequest { context: Str::new_static(""), tasks: vec![child] },
			Self::Batch(batch) => batch,
		}
	}

	/// Returns the number of requested children without allocating.
	#[must_use]
	pub const fn len(&self) -> usize {
		match self {
			Self::Single(_) => 1,
			Self::Batch(batch) => batch.tasks.len(),
		}
	}

	/// Returns whether the batch form omitted every child.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		matches!(self, Self::Batch(batch) if batch.tasks.is_empty())
	}
}

/// Progress emitted while a child job is live.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct Update {
	/// Stable child identity.
	pub id:     Str,
	/// Journal-derived lifecycle status.
	pub status: Str,
}

/// Validated structured output of one child, present whenever an output
/// schema was in effect.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct StructuredOutput {
	/// Enforcement mode in effect.
	pub mode:   SchemaMode,
	/// Validation verdict.
	pub status: OutputStatus,
	/// Terminal `yield` data as submitted.
	pub data:   Option<serde_json::Value>,
	/// Violation or schema defect when `status` is not `valid`.
	pub error:  Option<Str>,
}

/// Disposition of an isolated child workspace after the child settled.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct WorkspaceOutcome {
	/// Environment worktree identity the child ran in.
	pub worktree:  Str,
	/// Content-addressed patch of the child's changes (`artifact://sha256/…`).
	pub patch:     Option<Str>,
	/// Branch the changes were published to, when the merge mode was `branch`.
	pub branch:    Option<Str>,
	/// Whether the changes were applied to the parent workspace.
	pub applied:   bool,
	/// Paths that conflicted with the parent while applying.
	pub conflicts: Vec<Str>,
}

/// Presentation-safe accounting retained for one settled child.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct ChildStats {
	/// Provider requests completed across the child run.
	pub requests:       u32,
	/// Largest prompt context observed.
	pub context_tokens: u64,
	/// Model context capacity used for the percentage badge.
	pub context_window: u64,
	/// Billed cost in nano-US dollars.
	pub cost_nano_usd:  u64,
	/// Wall-clock runtime.
	pub duration_ms:    u64,
}

/// One settled child result.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct ChildResult {
	/// Stable child identity.
	pub id:           Str,
	/// Agent class used for the run.
	pub agent:        Str,
	/// Final assistant text.
	pub text:         Str,
	/// Tiny-model presentation label generated from the assignment, when
	/// available.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description:  Option<Str>,
	/// Exact assignment handed to the child.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub assignment:   Option<Str>,
	/// Presentation-safe request, context, cost, and timing accounting.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub stats:        Option<ChildStats>,
	/// Child `.oms` journal path.
	pub session_path: Str,
	/// Input tokens consumed by the child.
	pub tokens_in:    u64,
	/// Output tokens consumed by the child.
	pub tokens_out:   u64,
	/// Structured output verdict when an output schema was in effect.
	pub output:       Option<StructuredOutput>,
	/// Isolated workspace disposition when the child ran isolated.
	pub workspace:    Option<WorkspaceOutcome>,
	/// Child failure; `text` then carries the last assistant text, if any.
	pub error:        Option<Str>,
}

/// One child accepted by the runtime job authority.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct StartedChild {
	/// Stable job/child identity used by `hub wait`, `jobs`, and `cancel`.
	pub id:           Str,
	/// Agent class selected for the child.
	pub agent:        Str,
	/// Child `.oms` journal path.
	pub session_path: Str,
	/// Initial job lifecycle state.
	pub status:       Str,
}

/// Task response.
///
/// Foreground backends may return settled children. The production session
/// backend returns started jobs immediately and later delivers their retained
/// `ChildResult` through the shared job authority.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Payload {
	/// Every child settled within this call.
	Settled {
		/// Results in request order.
		children:    Vec<ChildResult>,
		/// Whole batch wall-clock duration including admission and teardown.
		#[serde(default)]
		duration_ms: u64,
	},
	/// Every child was admitted as a detached runtime job.
	Started {
		/// Job identities in request order.
		jobs: Vec<StartedChild>,
	},
}

/// Stable task-spawn failure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct Fault {
	/// Model-facing explanation.
	pub message: Str,
}

/// Host composition seam for child kernels.
///
/// Implementations must seed a child `omp_con::Ctx` from the caller's current
/// effective values, execute `subagent.cfg` then `<agent>.cfg`, create a child
/// `.oms` beneath the parent sessions directory, and journal a `<subagent>`
/// insertion before starting the kernel.
pub trait SubagentSpawner: Send + Sync + 'static {
	/// Spawns every requested child and returns only after they settle.
	fn spawn<'a>(
		&'a self,
		owner: &'a str,
		request: Params,
		updates: &'a flume::Sender<Update>,
	) -> impl Future<Output = Result<Payload, Fault>> + Send + 'a;
}

/// Native task tool over injected driver composition.
pub struct Task<S> {
	spawner: S,
	spec:    ToolSpec,
}

/// Returns the canonical `task@2` declaration shared by registry advertisement
/// and session-owned execution.
#[must_use]
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("task"),
		rev:             Rev { family: Default::default(), n: 2 },
		description:     sf!(DESCRIPTION),
		schema:          omp_tool::schema::<Params>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         Effects { subagents: u32::MAX, ..Effects::default() },
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("task.rs"),
		)
		.into(),
	}
}

/// Constructs `task@2`.
#[must_use]
pub fn tool<S: SubagentSpawner>(spawner: S) -> Task<S> {
	Task { spawner, spec: spec() }
}

impl<S: SubagentSpawner> Tool for Task<S> {
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
	) -> impl Stream<Item = Ev<Update, Payload, Fault>> + Send + 'c {
		stream! {
			let Some(owner) = params.owner().cloned() else {
				yield done(Err(Fault { message: sf!("task requires an authenticated invocation owner") }));
				return;
			};
			let request = match params.whole::<Params>().await {
				Ok(request) => request,
				Err(error) => {
					yield param_event(error);
					return;
				},
			};
			if request.is_empty() {
				yield done(Err(Fault { message: sf!("task requires at least one child") }));
				return;
			}
			if let Err(error) = params.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			let (tx, rx) = flume::bounded(16);
			let spawning = self.spawner.spawn(&owner, request, &tx);
			tokio::pin!(spawning);
			loop {
				match tokio::select! {
					biased;
					result = &mut spawning => Ok(result),
					update = rx.recv_async() => Err(update),
				} {
					Ok(result) => { yield done(result); break; },
					Err(Ok(update)) => yield Ev::Update(update),
					Err(Err(_)) => continue,
				}
			}
		}
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, _caps: &PromptCaps) -> Vec<Part> {
		match view {
			Ok(Payload::Settled { children, .. }) => children.iter().map(child_part).collect(),
			Ok(Payload::Started { jobs }) => started_parts(jobs),
			Err(fault) => vec![Part::Text { text: fault.message.clone() }],
		}
	}
}

/// Projects a started batch: one line per admitted job, then the delivery
/// advisory.
fn started_parts(jobs: &[StartedChild]) -> Vec<Part> {
	jobs
		.iter()
		.map(|job| Part::Text {
			text: sf!("[{}] {} ({}) session={}", job.id, job.status, job.agent, job.session_path),
		})
		.chain(std::iter::once(Part::Text { text: sf!(STARTED_ADVISORY) }))
		.collect()
}

const fn done(result: Result<Payload, Fault>) -> Ev<Update, Payload, Fault> {
	Ev::Done(ToolTerminal::Done { result, useless: false })
}

/// Projects one child result as the model-facing part: structured data wins
/// over free text, and failures or schema violations are named explicitly.
fn child_part(child: &ChildResult) -> Part {
	let mut text = omp_core::StrMut::new("");
	if let Some(error) = &child.error {
		text.push_str("[");
		text.push_str(&child.id);
		text.push_str(" failed] ");
		text.push_str(error);
		if !child.text.is_empty() {
			text.push_str("\n\n");
		}
	}
	match child.output.as_ref() {
		Some(StructuredOutput { status: OutputStatus::Valid, data: Some(data), .. }) => {
			text.push_str(&serde_json::to_string_pretty(data).unwrap_or_default());
		},
		Some(StructuredOutput { status, error: Some(error), data, .. }) => {
			text.push_str("[output ");
			text.push_str(<&'static str>::from(status));
			text.push_str("] ");
			text.push_str(error);
			if let Some(data) = data {
				text.push_str("\n");
				text.push_str(&serde_json::to_string_pretty(data).unwrap_or_default());
			} else {
				text.push_str("\n");
				text.push_str(&child.text);
			}
		},
		_ => text.push_str(&child.text),
	}
	if let Some(workspace) = &child.workspace {
		text.push_str("\n[workspace ");
		text.push_str(&workspace.worktree);
		if let Some(patch) = &workspace.patch {
			text.push_str(" patch=");
			text.push_str(patch);
		}
		if let Some(branch) = &workspace.branch {
			text.push_str(" branch=");
			text.push_str(branch);
		}
		text.push_str(if workspace.applied {
			" applied"
		} else {
			" not applied"
		});
		if !workspace.conflicts.is_empty() {
			text.push_str(" conflicts=");
			text.push_str(&workspace.conflicts.join(","));
		}
		text.push_str("]");
	}
	Part::Text { text: text.freeze() }
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

fn commit_event(error: omp_tool::CommitError) -> Ev<Update, Payload, Fault> {
	match error {
		omp_tool::CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		omp_tool::CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		omp_tool::CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed task@2 single-child or batch argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  Some(sf!(r#"{{"context":"shared","tasks":[{{"task":"inspect"}}]}}"#)),
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use omp_tool::Part;

	use super::{
		DESCRIPTION, Params, Payload, STARTED_ADVISORY, StartedChild, TaskEffort, spec, started_parts,
	};

	#[test]
	fn task_accepts_single_and_batch_wire_shapes() {
		let single: Params = serde_json::from_value(serde_json::json!({
			"name": "one",
			"agent": "task",
			"task": "inspect",
			"effort": "hi",
			"outputSchema": {"type": "object"},
			"schemaMode": "strict",
			"isolated": true
		}))
		.expect("single task shape");
		let single = single.into_batch();
		assert!(single.context.is_empty());
		assert_eq!(single.tasks.len(), 1);
		assert_eq!(single.tasks[0].effort, Some(TaskEffort::Hi));

		let batch: Params = serde_json::from_value(serde_json::json!({
			"context": "shared",
			"tasks": [
				{"task": "first"},
				{"task": "second", "effort": "lo"}
			]
		}))
		.expect("batch task shape");
		let batch = batch.into_batch();
		assert_eq!(batch.context, "shared");
		assert_eq!(batch.tasks.len(), 2);
		assert_eq!(batch.tasks[1].effort, Some(TaskEffort::Lo));
	}

	#[test]
	fn task_rejects_mixed_or_unknown_wire_shapes() {
		assert!(
			serde_json::from_value::<Params>(serde_json::json!({
				"task": "single",
				"context": "batch",
				"tasks": [{"task": "nested"}]
			}))
			.is_err()
		);
		assert!(
			serde_json::from_value::<Params>(serde_json::json!({"task": "single", "detached": true}))
				.is_err()
		);
	}

	#[test]
	fn started_payload_carries_real_job_identity_without_settled_placeholders() {
		let payload = Payload::Started {
			jobs: vec![StartedChild {
				id:           "child-1".into(),
				agent:        "task".into(),
				session_path: "/tmp/child-1.oms".into(),
				status:       "running".into(),
			}],
		};
		let value = serde_json::to_value(payload).unwrap();
		assert_eq!(value["jobs"][0]["id"], "child-1");
		assert!(value.get("children").is_none());
		assert!(value["jobs"][0].get("tokens_in").is_none());
	}

	#[test]
	fn started_projection_states_async_delivery_contract() {
		let parts = started_parts(&[StartedChild {
			id:           "child-1".into(),
			agent:        "task".into(),
			session_path: "/tmp/child-1.oms".into(),
			status:       "running".into(),
		}]);
		let texts = parts
			.iter()
			.map(|part| match part {
				Part::Text { text } => text.as_str(),
				_ => panic!("started projection is text only"),
			})
			.collect::<Vec<_>>();
		assert_eq!(texts, vec![
			"[child-1] running (task) session=/tmp/child-1.oms",
			STARTED_ADVISORY
		]);
		assert!(STARTED_ADVISORY.contains("async-result"));
		assert!(STARTED_ADVISORY.contains("`hub wait`"));
		assert!(DESCRIPTION.contains("returns immediately with job ids"));
		assert!(DESCRIPTION.contains("async-result follow-up"));
	}

	#[test]
	fn task_contract_revision_is_two() {
		assert_eq!(spec().rev.n, 2);
	}
}
