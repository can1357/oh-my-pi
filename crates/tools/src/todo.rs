//! Phased session task tracking with deterministic state transitions.

use std::{fmt::Write as _, sync::Arc};

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use omp_core::{FastHashMap, FastHashSet, Str, sf};
use omp_tool::{
	ArgIssue, ArgIssueKind, ArgPath, CallOutcome, Constraint, Effects, Ev, IncomingParams,
	LiftedCall, ParamError, Part, PromptCaps, RecordedCall, Rev, Tool, ToolSpec, ToolTerminal,
};
use parking_lot::Mutex;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Model arguments for `todo@3`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Operation to apply.
	#[schemars(description = "operation to apply")]
	pub op:     Op,
	/// Complete phased task list for `init`.
	#[schemars(
		default,
		skip_serializing_if = "Option::is_none",
		description = "phased task list (init)"
	)]
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub list:   Option<Vec<InitListEntry>>,
	/// Verbatim content of the task a single-task operation targets.
	#[schemars(default, skip_serializing_if = "Option::is_none", description = "task content")]
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub task:   Option<Str>,
	/// Phase name for phase-wide operations, `append`, and single-phase `init`.
	#[schemars(default, skip_serializing_if = "Option::is_none", description = "phase name")]
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub phase:  Option<Str>,
	/// Tasks for single-phase `init` or `append`.
	#[schemars(
		default,
		skip_serializing_if = "Option::is_none",
		description = "tasks for single-phase init or append"
	)]
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub items:  Option<Vec<Str>>,
	/// Optional blocker note for `block`.
	#[schemars(
		default,
		skip_serializing_if = "Option::is_none",
		description = "blocker note (block op)"
	)]
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub reason: Option<Str>,
}

/// One phase of an `init` list.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InitListEntry {
	/// Phase name.
	#[schemars(description = "phase name")]
	pub phase: Str,
	/// Task contents for this phase, in order.
	#[schemars(length(min = 1), description = "tasks for this phase")]
	pub items: Vec<Str>,
}

/// Supported todo operations.
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
pub enum Op {
	/// Replaces the complete phased list.
	Init,
	/// Marks one task in progress.
	Start,
	/// Marks one task, one phase, or everything completed.
	Done,
	/// Removes one task, empties one phase, or empties every phase.
	Rm,
	/// Marks one task, one phase, or everything abandoned.
	Drop,
	/// Marks open tasks blocked, optionally with a reason.
	Block,
	/// Returns blocked tasks to pending.
	Unblock,
	/// Adds pending tasks to a phase, creating it when missing.
	Append,
	/// Returns the current state without changing it.
	View,
}

/// One named phase and its ordered tasks.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Phase {
	/// Stable phase name.
	pub name:  Str,
	/// Tasks in their user-defined order.
	pub tasks: Vec<Task>,
}

/// One tracked task.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Task {
	/// Verbatim task content; the task's identity.
	pub content: Str,
	/// Current lifecycle state.
	#[serde(default)]
	pub status:  Status,
	/// Optional note on what a blocked task is waiting for.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub blocker: Option<Str>,
}

/// Durable task state.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Eq,
	JsonSchema,
	PartialEq,
	Serialize,
	strum::AsRefStr,
	strum::Display,
	strum::EnumString,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Status {
	/// Not yet started.
	#[default]
	Pending,
	/// Actively being worked.
	InProgress,
	/// Finished successfully.
	Completed,
	/// Intentionally abandoned.
	Abandoned,
	/// Waiting on an external dependency.
	Blocked,
}

/// One task an operation moved into `completed`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionTransition {
	/// Name of the phase holding the task.
	pub phase:   Str,
	/// Verbatim task content.
	pub content: Str,
}

/// Read-only reference to one actionable todo task.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ActionableTodoRef {
	/// Stable phase name.
	pub phase:   Str,
	/// Verbatim task content.
	pub content: Str,
	/// Actionable lifecycle state (`pending` or `in_progress`).
	pub status:  Status,
}

/// Successful todo state after an operation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Payload {
	/// Operation that produced this snapshot.
	pub op:              Op,
	/// Durable phase tree after the requested operation.
	pub phases:          Vec<Phase>,
	/// Tasks this operation moved into `completed`, in phase order.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub completed_tasks: Vec<CompletionTransition>,
}
/// Todo does not stream progress updates.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Update {}
/// A rejected todo transition; state is left exactly as it was.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// A single-task operation omitted `task`.
	#[error("Missing task content")]
	MissingTask,
	/// `task` looked like a generated identifier instead of task content.
	#[error(
		"Task \"{content}\" not found. Tasks are referenced by content, not by IDs — pass the \
		 task's full text from the previous result."
	)]
	TaskIdReference {
		/// Rejected identifier-shaped reference.
		content: Str,
	},
	/// `task` named no tracked task and nothing is tracked at all.
	#[error(
		"Task \"{content}\" not found (todo list is empty — was it replaced or not yet created?)"
	)]
	TaskNotFoundInEmptyList {
		/// Unmatched task content.
		content: Str,
	},
	/// `task` named no tracked task.
	#[error("Task \"{content}\" not found")]
	TaskNotFound {
		/// Unmatched task content.
		content: Str,
	},
	/// A phase-targeted operation omitted `phase`.
	#[error("Missing phase name")]
	MissingPhase,
	/// `phase` named no tracked phase.
	#[error("Phase \"{name}\" not found")]
	PhaseNotFound {
		/// Unmatched phase name.
		name: Str,
	},
	/// `init` supplied neither `list` nor non-empty `items`.
	#[error("Missing list for init operation")]
	MissingList,
	/// `init` named the same phase twice.
	#[error("Duplicate phase \"{name}\" in init list")]
	DuplicatePhase {
		/// Repeated phase name.
		name: Str,
	},
	/// `init` listed the same task content twice.
	#[error("Duplicate task \"{content}\" in init list")]
	DuplicateTask {
		/// Repeated task content.
		content: Str,
	},
	/// `append` omitted `phase`.
	#[error("Missing phase name for append operation")]
	AppendMissingPhase,
	/// `append` omitted `items` or supplied an empty list.
	#[error("Missing items for append operation")]
	AppendMissingItems,
	/// `append` would create a second task with the same content.
	#[error("Task \"{content}\" already exists")]
	TaskExists {
		/// Task content already tracked or repeated in the batch.
		content: Str,
	},
	/// `block` named neither a task nor a phase.
	#[error("block requires a task or phase target")]
	BlockRequiresTarget,
	/// `unblock` named neither a task nor a phase.
	#[error("unblock requires a task or phase target")]
	UnblockRequiresTarget,
}

/// In-memory todo executor. Session hosts may snapshot `Payload::phases` into
/// their journal.
pub struct Todo {
	phases: Arc<Mutex<Vec<Phase>>>,
	spec:   ToolSpec,
}
/// Creates the core todo slot tool.
pub fn tool() -> Todo {
	Todo { phases: Arc::new(Mutex::new(Vec::new())), spec: spec() }
}

/// Returns the exact `todo@3` declaration shared by native and session-owned
/// execution.
///
/// Production composition routes this identity through a session tool so the
/// current phase tree is selected from `<meta><todo>` for every call. Keeping
/// declaration construction here prevents the session adapter from drifting
/// from the native contract used by revision lifting and isolated tool tests.
#[must_use]
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("todo"),
		rev:             Rev { family: Str::default(), n: 3 },
		description:     sf!(DESCRIPTION),
		schema:          omp_tool::schema::<Params>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         Effects::default(),
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("todo.rs"),
		)
		.into(),
	}
}

const DESCRIPTION: &str =
	"Tracks a phased task list. Tasks are verbatim content strings, NEVER auto-generated IDs; pass \
	 content in `task`. After each successful state-changing op: if nothing is `in_progress`, the \
	 earliest `pending` task (phase order) auto-promotes to `in_progress`; if several are \
	 `in_progress`, only the earliest stays. Blocked tasks NEVER auto-promote: `unblock` first. \
	 Out-of-order completion may move the pointer back to an earlier phase; completed tasks NEVER \
	 revert. Read-only `view` and failed operations never normalize state.\n\nOperations: `init` \
	 (`list: [{phase, items}]`, or flattened `items` with optional `phase`) replaces the list; \
	 `start` (`task`) marks in progress; `done`/`drop` (`task` or `phase`; omit both for every \
	 task) mark completed/abandoned; `block` (`task` or `phase`, optional `reason`) marks open \
	 tasks blocked while awaiting external input and excludes them from incomplete-work reminders; \
	 blocking the active task promotes the next pending task. `unblock` (`task` or `phase`) \
	 returns blocked tasks to pending; `rm` (optional `task` or `phase`; omit both to clear) \
	 removes tasks; `append` (`phase`, `items`) adds tasks and lazily creates the phase; `view` \
	 echoes the list read-only.\n\nTask content: 5-10 words, what not how, unique. Phase name: \
	 short unique noun phrase, never numbered. Keep introduced `task`/`phase` strings stable; when \
	 the exact text is lost, `view` echoes it. Mark tasks done immediately and complete phases in \
	 order. Create a list for work with at least three distinct steps, whenever the user requests \
	 one or supplies multiple items, and when new instructions arrive mid-task. A user-provided \
	 checklist is exhaustive: initialize every item separately, never summarize or track part of \
	 it from memory. Batch todo calls with real work, never as a turn's only call.";

/// Phase name for a flattened `init` that supplies `items` without `phase`.
const DEFAULT_INIT_PHASE: &str = "Tasks";

impl Todo {
	/// Returns pending and in-progress tasks in stable phase/task order.
	pub fn actionable_snapshot(&self) -> Vec<ActionableTodoRef> {
		let phases = self.phases.lock();
		phases
			.iter()
			.flat_map(|phase| {
				phase
					.tasks
					.iter()
					.filter(|&task| matches!(task.status, Status::Pending | Status::InProgress))
					.map(|task| ActionableTodoRef {
						phase:   phase.name.clone(),
						content: task.content.clone(),
						status:  task.status,
					})
			})
			.collect()
	}
}

impl Tool for Todo {
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
			let raw = match params.whole::<serde_json::Value>().await { Ok(value) => value, Err(error) => { yield param_event(error); return; } };
			let has_existing_phases = !self.phases.lock().is_empty();
			let arguments = match resolve_params(raw, has_existing_phases) { Ok(value) => value, Err(issue) => { yield Ev::Args(issue); return; } };
			if let Err(error) = params.interruptable().committed().await { yield commit_event(error); return; }
			let result = apply(&mut self.phases.lock(), arguments);
			yield done(result);
		}
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text { text: Str::from(model_output(view)) }]
	}

	fn lift(&self, from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
		lift_rev1(from, call)
	}
}

/// Execute-time argument shape: `op` may be absent and repaired from an
/// unambiguous payload.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LenientParams {
	#[serde(default)]
	op:     Option<Op>,
	#[serde(default)]
	list:   Option<Vec<InitListEntry>>,
	#[serde(default)]
	task:   Option<Str>,
	#[serde(default)]
	phase:  Option<Str>,
	#[serde(default)]
	items:  Option<Vec<Str>>,
	#[serde(default)]
	reason: Option<Str>,
}

/// Validates execute-time arguments, repairing an omitted `op` when the payload
/// shape is unambiguous: `list` → `init`; `items` + `phase` → `append`; bare
/// `items` with nothing tracked → `init`.
///
/// # Errors
///
/// Returns a structured argument issue when the object is malformed or its
/// missing operation cannot be inferred without risking state loss.
pub fn resolve_params(
	raw: serde_json::Value,
	has_existing_phases: bool,
) -> Result<Params, ArgIssue> {
	let LenientParams { op, list, task, phase, items, reason } = serde_json::from_value(raw)
		.map_err(|_| ArgIssue {
			path:     Vec::new(),
			expected: Str::new_static("todo arguments {op, list?, task?, phase?, items?, reason?}"),
			kind:     ArgIssueKind::Malformed,
			example:  Some(Str::new_static(r#"{"op":"view"}"#)),
			found:    None,
		})?;
	let op = match op {
		Some(op) => op,
		None => infer_op(list.as_deref(), phase.as_deref(), items.as_deref(), has_existing_phases)
			.ok_or_else(|| ArgIssue {
				path:     vec![ArgPath::Key(sf!("op"))],
				expected: sf!("one of init, start, done, rm, drop, block, unblock, append, view"),
				kind:     ArgIssueKind::Missing,
				example:  Some(Str::new_static(r#"{"op":"view"}"#)),
				found:    None,
			})?,
	};
	Ok(Params { op, list, task, phase, items, reason })
}

fn infer_op(
	list: Option<&[InitListEntry]>,
	phase: Option<&str>,
	items: Option<&[Str]>,
	has_existing_phases: bool,
) -> Option<Op> {
	if list.is_some_and(|list| !list.is_empty()) {
		return Some(Op::Init);
	}
	if items.is_some_and(|items| !items.is_empty()) {
		if phase.is_some_and(|phase| !phase.is_empty()) {
			return Some(Op::Append);
		}
		if !has_existing_phases {
			return Some(Op::Init);
		}
	}
	None
}

/// Applies one operation to a phased list.
///
/// A failed operation leaves `phases` untouched. Successful state-changing
/// operations normalize the in-progress pointer; `view` neither mutates nor
/// normalizes.
///
/// # Errors
///
/// Returns the first transition [`Fault`] the operation raises.
pub fn apply(phases: &mut Vec<Phase>, params: Params) -> Result<Payload, Fault> {
	let op = params.op;
	if op == Op::View {
		return Ok(Payload { op, phases: phases.clone(), completed_tasks: Vec::new() });
	}
	let mut next = phases.clone();
	apply_entry(&mut next, params)?;
	normalize_in_progress(&mut next);
	let completed_tasks = completion_transitions(phases, &next);
	*phases = next;
	Ok(Payload { op, phases: phases.clone(), completed_tasks })
}

/// Which tasks an operation addresses: one task, one phase, or every task.
#[derive(Clone, Copy)]
enum Targets {
	All,
	Phase(usize),
	Task(usize, usize),
}

fn apply_entry(phases: &mut Vec<Phase>, params: Params) -> Result<(), Fault> {
	match params.op {
		Op::Init => *phases = init_phases(params)?,
		Op::View => {},
		Op::Append => append_items(phases, params)?,
		Op::Rm => remove_tasks(phases, &params)?,
		Op::Start => {
			let (phase_index, task_index) =
				find_task(phases, present(&params.task).ok_or(Fault::MissingTask)?)
					.ok_or_else(|| task_not_found(phases, &params.task))?;
			for (candidate_phase, phase) in phases.iter_mut().enumerate() {
				for (candidate_task, task) in phase.tasks.iter_mut().enumerate() {
					if task.status == Status::InProgress
						&& (candidate_phase, candidate_task) != (phase_index, task_index)
					{
						task.status = Status::Pending;
					}
				}
			}
			phases[phase_index].tasks[task_index].status = Status::InProgress;
		},
		Op::Done => {
			let targets = resolve_targets(phases, &params)?;
			for_each_target(phases, targets, |task| task.status = Status::Completed);
		},
		Op::Drop => {
			let targets = resolve_targets(phases, &params)?;
			for_each_target(phases, targets, |task| task.status = Status::Abandoned);
		},
		Op::Block => {
			if present(&params.task).is_none() && present(&params.phase).is_none() {
				return Err(Fault::BlockRequiresTarget);
			}
			let targets = resolve_targets(phases, &params)?;
			// Whitespace runs (including newlines) collapse to single spaces so
			// the note rides on one Markdown checklist line and one summary line.
			let blocker = params.reason.as_deref().and_then(normalize_blocker);
			for_each_target(phases, targets, |task| {
				// Only open work can be blocked: blocking a phase never reopens
				// completed/abandoned tasks. An already-blocked task stays
				// eligible so a later block can refine its note.
				if matches!(task.status, Status::Pending | Status::InProgress | Status::Blocked) {
					task.status = Status::Blocked;
					task.blocker.clone_from(&blocker);
				}
			});
		},
		Op::Unblock => {
			if present(&params.task).is_none() && present(&params.phase).is_none() {
				return Err(Fault::UnblockRequiresTarget);
			}
			let targets = resolve_targets(phases, &params)?;
			for_each_target(phases, targets, |task| {
				if task.status == Status::Blocked {
					task.status = Status::Pending;
					task.blocker = None;
				}
			});
		},
	}
	Ok(())
}

fn init_phases(params: Params) -> Result<Vec<Phase>, Fault> {
	// Models routinely flatten a single-phase init into `{op:"init", items}`
	// (optionally with a bare `phase`); synthesize the one-phase list.
	let list = match (params.list, params.items) {
		(Some(list), _) => list,
		(None, Some(items)) if !items.is_empty() => vec![InitListEntry {
			phase: params
				.phase
				.unwrap_or_else(|| Str::new_static(DEFAULT_INIT_PHASE)),
			items,
		}],
		_ => return Err(Fault::MissingList),
	};
	// Duplicate names would be permanently unaddressable (every targeting op
	// resolves the first match), so reject them up front.
	let mut seen_phases = FastHashSet::<&str>::default();
	let mut seen_tasks = FastHashSet::<&str>::default();
	for entry in &list {
		if !seen_phases.insert(entry.phase.as_str()) {
			return Err(Fault::DuplicatePhase { name: entry.phase.clone() });
		}
		for content in &entry.items {
			if !seen_tasks.insert(content.as_str()) {
				return Err(Fault::DuplicateTask { content: content.clone() });
			}
		}
	}
	Ok(list
		.into_iter()
		.map(|entry| Phase {
			name:  entry.phase,
			tasks: entry.items.into_iter().map(pending_task).collect(),
		})
		.collect())
}

fn append_items(phases: &mut Vec<Phase>, params: Params) -> Result<(), Fault> {
	let name = present(&params.phase).ok_or(Fault::AppendMissingPhase)?;
	let items = params
		.items
		.filter(|items| !items.is_empty())
		.ok_or(Fault::AppendMissingItems)?;
	// Validate the whole batch before mutating so nothing lands half-applied.
	let mut seen = FastHashSet::<&str>::default();
	for content in &items {
		if !seen.insert(content.as_str()) || find_task(phases, content).is_some() {
			return Err(Fault::TaskExists { content: content.clone() });
		}
	}
	let phase_index = if let Some(index) = find_phase(phases, name) {
		index
	} else {
		phases.push(Phase { name: Str::new(name), tasks: Vec::new() });
		phases.len() - 1
	};
	phases[phase_index]
		.tasks
		.extend(items.into_iter().map(pending_task));
	Ok(())
}

fn remove_tasks(phases: &mut [Phase], params: &Params) -> Result<(), Fault> {
	match resolve_targets(phases, params)? {
		Targets::Task(phase_index, task_index) => {
			phases[phase_index].tasks.remove(task_index);
		},
		Targets::Phase(phase_index) => phases[phase_index].tasks.clear(),
		Targets::All => {
			for phase in phases {
				phase.tasks.clear();
			}
		},
	}
	Ok(())
}

/// Resolves `task` first, then `phase`, then everything; an empty string
/// counts as absent, as in pi.
fn resolve_targets(phases: &[Phase], params: &Params) -> Result<Targets, Fault> {
	if let Some(content) = present(&params.task) {
		return find_task(phases, content)
			.map(|(phase, task)| Targets::Task(phase, task))
			.ok_or_else(|| task_not_found(phases, &params.task));
	}
	if let Some(name) = present(&params.phase) {
		return find_phase(phases, name)
			.map(Targets::Phase)
			.ok_or_else(|| Fault::PhaseNotFound { name: Str::new(name) });
	}
	Ok(Targets::All)
}

fn for_each_target(phases: &mut [Phase], targets: Targets, mut visit: impl FnMut(&mut Task)) {
	match targets {
		Targets::All => phases
			.iter_mut()
			.flat_map(|phase| &mut phase.tasks)
			.for_each(visit),
		Targets::Phase(phase_index) => phases[phase_index].tasks.iter_mut().for_each(visit),
		Targets::Task(phase_index, task_index) => {
			visit(&mut phases[phase_index].tasks[task_index]);
		},
	}
}

fn present(value: &Option<Str>) -> Option<&str> {
	value.as_deref().filter(|value| !value.is_empty())
}

const fn pending_task(content: Str) -> Task {
	Task { content, status: Status::Pending, blocker: None }
}

fn find_task(phases: &[Phase], content: &str) -> Option<(usize, usize)> {
	phases.iter().enumerate().find_map(|(phase_index, phase)| {
		phase
			.tasks
			.iter()
			.position(|task| task.content == content)
			.map(|task_index| (phase_index, task_index))
	})
}

fn find_phase(phases: &[Phase], name: &str) -> Option<usize> {
	phases.iter().position(|phase| phase.name == name)
}

fn task_not_found(phases: &[Phase], task: &Option<Str>) -> Fault {
	let content = task.clone().unwrap_or_default();
	if looks_like_task_id(&content) {
		return Fault::TaskIdReference { content };
	}
	if phases.iter().all(|phase| phase.tasks.is_empty()) {
		return Fault::TaskNotFoundInEmptyList { content };
	}
	Fault::TaskNotFound { content }
}

/// `task-<digits>`: the auto-generated-id shape models invent.
fn looks_like_task_id(content: &str) -> bool {
	content
		.strip_prefix("task-")
		.is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
}

fn normalize_blocker(reason: &str) -> Option<Str> {
	let mut normalized = String::with_capacity(reason.len());
	for (index, word) in reason.split_whitespace().enumerate() {
		if index > 0 {
			normalized.push(' ');
		}
		normalized.push_str(word);
	}
	(!normalized.is_empty()).then(|| Str::from(normalized))
}

fn normalize_in_progress(phases: &mut [Phase]) {
	let mut found_active = false;
	for task in phases.iter_mut().flat_map(|phase| &mut phase.tasks) {
		if task.status != Status::InProgress {
			continue;
		}
		if found_active {
			task.status = Status::Pending;
		} else {
			found_active = true;
		}
	}
	if found_active {
		return;
	}
	if let Some(task) = phases
		.iter_mut()
		.flat_map(|phase| &mut phase.tasks)
		.find(|task| task.status == Status::Pending)
	{
		task.status = Status::InProgress;
	}
}

fn completion_transitions(previous: &[Phase], updated: &[Phase]) -> Vec<CompletionTransition> {
	let previous_statuses = previous
		.iter()
		.flat_map(|phase| {
			phase
				.tasks
				.iter()
				.map(move |task| ((phase.name.as_str(), task.content.as_str()), task.status))
		})
		.collect::<FastHashMap<_, _>>();
	updated
		.iter()
		.flat_map(|phase| {
			let previous_statuses = &previous_statuses;
			phase
				.tasks
				.iter()
				.filter(|&task| {
					task.status == Status::Completed
						&& previous_statuses
							.get(&(phase.name.as_str(), task.content.as_str()))
							.is_some_and(|status| *status != Status::Completed)
				})
				.map(|task| CompletionTransition {
					phase:   phase.name.clone(),
					content: task.content.clone(),
				})
		})
		.collect()
}

/// Builds the model-facing text for either terminal todo outcome.
#[must_use]
pub fn model_output(view: Result<&Payload, &Fault>) -> String {
	match view {
		Ok(payload) => summary(&payload.phases, payload.op == Op::View),
		Err(fault) => {
			let mut text = String::from("Errors: ");
			let _ = write!(text, "{fault}");
			text
		},
	}
}

/// Model-facing summary of a phase tree: remaining work, overall counts, the
/// active phase, and the full checklist.
pub fn summary(phases: &[Phase], read_only: bool) -> String {
	let total: usize = phases.iter().map(|phase| phase.tasks.len()).sum();
	if total == 0 {
		return String::from(if read_only {
			"Todo list is empty."
		} else {
			"Todo list cleared."
		});
	}
	let is_open = |task: &Task| matches!(task.status, Status::Pending | Status::InProgress);
	let is_closed = |task: &Task| matches!(task.status, Status::Completed | Status::Abandoned);
	let remaining: usize = phases
		.iter()
		.map(|phase| phase.tasks.iter().filter(|task| is_open(task)).count())
		.sum();
	// The active phase is the EARLIEST one still holding open work.
	let current_index = phases
		.iter()
		.position(|phase| phase.tasks.iter().any(is_open))
		.unwrap_or(phases.len() - 1);
	let current = &phases[current_index];
	let done = current.tasks.iter().filter(|task| is_closed(task)).count();

	let mut out = String::new();
	if remaining == 0 {
		out.push_str("Remaining items: none.");
	} else {
		let _ = write!(out, "Remaining items ({remaining}):");
		for phase in phases {
			for task in phase.tasks.iter().filter(|task| is_open(task)) {
				let _ = write!(out, "\n  - {} [{}] ({})", task.content, task.status, phase.name);
			}
		}
	}
	let closed_all: usize = phases
		.iter()
		.map(|phase| phase.tasks.iter().filter(|task| is_closed(task)).count())
		.sum();
	let blocked_all: usize = phases
		.iter()
		.map(|phase| {
			phase
				.tasks
				.iter()
				.filter(|task| task.status == Status::Blocked)
				.count()
		})
		.sum();
	// The in-progress pointer can sit in a phase whose successors already
	// hold completed tasks; explain that backward pointer instead of letting
	// it read as a completed task reverting to pending.
	let worked_ahead = phases
		.iter()
		.skip(current_index + 1)
		.any(|phase| phase.tasks.iter().any(is_closed));
	let _ = write!(out, "\nOverall: {closed_all}/{total} done, {remaining} open");
	if blocked_all > 0 {
		let _ = write!(out, ", {blocked_all} blocked");
	}
	let _ = write!(
		out,
		".\nActive phase {}/{} \"{}\" ({done}/{})",
		current_index + 1,
		phases.len(),
		current.name,
		current.tasks.len()
	);
	out.push_str(if worked_ahead {
		" — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest \
		 open task on each completion, so it can sit behind out-of-order work (nothing was \
		 un-completed)."
	} else {
		"."
	});
	for phase in phases {
		let _ = write!(out, "\n  {}:", phase.name);
		for task in &phase.tasks {
			let checkbox = if task.status == Status::Completed {
				"[X]"
			} else {
				"[ ]"
			};
			let _ = write!(out, "\n    - {checkbox} {}", task.content);
			match task.status {
				Status::InProgress => out.push_str(" (in progress)"),
				Status::Abandoned => out.push_str(" (dropped)"),
				Status::Blocked => match &task.blocker {
					Some(blocker) => {
						let _ = write!(out, " (blocked: {blocker})");
					},
					None => out.push_str(" (blocked)"),
				},
				Status::Pending | Status::Completed => {},
			}
		}
	}
	out
}

/// Formats the durable state as an editable Markdown checklist.
pub fn render(phases: &[Phase]) -> String {
	if phases.is_empty() {
		return "# Todos\n".to_owned();
	}
	let mut output = String::new();
	for (phase_index, phase) in phases.iter().enumerate() {
		if phase_index != 0 {
			output.push('\n');
		}
		output.push_str("# ");
		output.push_str(&phase.name);
		output.push('\n');
		for task in &phase.tasks {
			let marker = match task.status {
				Status::Pending => ' ',
				Status::InProgress => '/',
				Status::Completed => 'x',
				Status::Abandoned => '-',
				Status::Blocked => '!',
			};
			output.push_str("- [");
			output.push(marker);
			output.push_str("] ");
			output.push_str(&task.content);
			// A blocked task's reason rides in a trailing HTML comment:
			// invisible when rendered, unambiguous to parse back.
			if task.status == Status::Blocked
				&& let Some(blocker) = &task.blocker
			{
				output.push_str(" <!-- blocker: ");
				output.push_str(blocker);
				output.push_str(" -->");
			}
			output.push('\n');
		}
	}
	output
}

/// One rejected line of an editable Markdown checklist.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum MarkdownError {
	/// The checklist marker is not one of `[ ]`, `[x]`, `[/]`, `[-]`, `[!]`.
	#[error("Line {line}: unknown status marker \"[{marker}]\" (use [ ], [x], [/], [-], [!])")]
	UnknownMarker {
		/// One-based line number.
		line:   usize,
		/// Rejected marker character.
		marker: char,
	},
	/// The line is neither a heading nor a checklist item.
	#[error("Line {line}: unrecognized syntax")]
	UnrecognizedSyntax {
		/// One-based line number.
		line: usize,
	},
}

/// Parses an editable Markdown checklist into canonical phased todo state,
/// normalizing the in-progress pointer like every state-changing operation.
///
/// # Errors
///
/// Returns the first line that is neither a heading nor a recognized
/// checklist item.
pub fn parse_markdown(markdown: &str) -> Result<Vec<Phase>, MarkdownError> {
	let mut phases = Vec::<Phase>::new();
	for (line_index, raw) in markdown.lines().enumerate() {
		let line = raw.trim();
		if line.is_empty() {
			continue;
		}
		if let Some(name) = parse_heading(line) {
			phases.push(Phase { name: Str::new(name), tasks: Vec::new() });
			continue;
		}
		let Some((marker, content)) = parse_checklist(line) else {
			return Err(MarkdownError::UnrecognizedSyntax { line: line_index + 1 });
		};
		let status = match marker {
			' ' => Status::Pending,
			'/' | '>' => Status::InProgress,
			'x' | 'X' => Status::Completed,
			'-' | '~' => Status::Abandoned,
			'!' => Status::Blocked,
			_ => return Err(MarkdownError::UnknownMarker { line: line_index + 1, marker }),
		};
		if phases.is_empty() {
			phases.push(Phase { name: sf!("Todos"), tasks: Vec::new() });
		}
		let (content, blocker) = if status == Status::Blocked {
			parse_blocker(content)
		} else {
			(content.trim(), None)
		};
		phases
			.last_mut()
			.expect("a default phase was inserted")
			.tasks
			.push(Task { content: Str::new(content), status, blocker: blocker.map(Str::new) });
	}
	normalize_in_progress(&mut phases);
	Ok(phases)
}

fn parse_heading(line: &str) -> Option<&str> {
	let depth = line.bytes().take_while(|byte| *byte == b'#').count();
	if !(1..=6).contains(&depth) {
		return None;
	}
	line
		.get(depth..)
		.map(str::trim)
		.filter(|heading| !heading.is_empty())
}

fn parse_checklist(line: &str) -> Option<(char, &str)> {
	if !matches!(line.as_bytes().first(), Some(b'-' | b'*' | b'+')) {
		return None;
	}
	let mut rest = line.get(1..)?.trim_start();
	rest = rest.strip_prefix('\\').unwrap_or(rest);
	rest = rest.strip_prefix('[')?;
	let marker = rest.chars().next()?;
	rest = rest.get(marker.len_utf8()..)?;
	rest = rest.strip_prefix('\\').unwrap_or(rest);
	rest = rest.strip_prefix(']')?;
	let content = rest.trim_start();
	(!content.is_empty()).then_some((marker, content))
}

fn parse_blocker(content: &str) -> (&str, Option<&str>) {
	let Some(comment) = content.rfind("<!--") else {
		return (content.trim(), None);
	};
	let Some(body) = content
		.get(comment + 4..)
		.and_then(|rest| rest.strip_suffix("-->"))
	else {
		return (content.trim(), None);
	};
	let Some(blocker) = body.trim().strip_prefix("blocker:") else {
		return (content.trim(), None);
	};
	(content[..comment].trim(), Some(blocker.trim()))
}

/// `todo@1` argument shape: `item` instead of `task`, and `list` entries
/// carrying full task objects.
#[derive(Deserialize)]
struct Rev1Params {
	op:      Op,
	#[serde(default)]
	i:       Option<Str>,
	#[serde(default)]
	notrunc: Option<bool>,
	#[serde(default)]
	list:    Option<Vec<Rev1Phase>>,
	#[serde(default)]
	phase:   Option<Str>,
	#[serde(default)]
	item:    Option<Str>,
	#[serde(default)]
	items:   Option<Vec<Str>>,
	#[serde(default)]
	reason:  Option<Str>,
}

/// `todo@1` phase: `phase`/`items` instead of `name`/`tasks`.
#[derive(Deserialize)]
struct Rev1Phase {
	phase: Str,
	items: Vec<Rev1Item>,
}

/// `todo@1` task: `text`/`reason` instead of `content`/`blocker`.
#[derive(Deserialize)]
struct Rev1Item {
	text:   Str,
	#[serde(default)]
	status: Status,
	#[serde(default)]
	reason: Option<Str>,
}

/// `todo@1` payload; its Markdown `rendered` projection is dropped.
#[derive(Deserialize)]
struct Rev1Payload {
	phases: Vec<Rev1Phase>,
}

impl Rev1Phase {
	fn lift(self) -> Phase {
		Phase {
			name:  self.phase,
			tasks: self
				.items
				.into_iter()
				.map(|item| Task { content: item.text, status: item.status, blocker: item.reason })
				.collect(),
		}
	}
}

/// Migrates historical todo calls to `todo@3`. Revision 2 already has the
/// current argument and payload shapes, so its lift is byte-preserving.
/// Revision 1 faulted verdicts carried prose with no typed equivalent and stay
/// transcript data.
fn lift_rev1(from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
	if !from.family.is_empty() {
		return None;
	}
	if from.n == 2 {
		return Some(LiftedCall {
			raw_args: Bytes::copy_from_slice(call.raw_args),
			verdict:  Bytes::copy_from_slice(call.verdict),
		});
	}
	if from.n != 1 {
		return None;
	}
	let args = serde_json::from_slice::<Rev1Params>(call.raw_args).ok()?;
	let outcome =
		serde_json::from_slice::<CallOutcome<Rev1Payload, serde_json::Value>>(call.verdict).ok()?;
	let verdict = match outcome {
		CallOutcome::Ok(payload) => serde_json::to_vec(&CallOutcome::<Payload, Fault>::Ok(Payload {
			op:              args.op,
			phases:          payload.phases.into_iter().map(Rev1Phase::lift).collect(),
			completed_tasks: Vec::new(),
		}))
		.ok()?,
		CallOutcome::Faulted(_) => return None,
		CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. } => call.verdict.to_vec(),
	};
	let params = Params {
		op:     args.op,
		list:   args.list.map(|list| {
			list
				.into_iter()
				.map(|phase| InitListEntry {
					phase: phase.phase,
					items: phase.items.into_iter().map(|item| item.text).collect(),
				})
				.collect()
		}),
		task:   args.item,
		phase:  args.phase,
		items:  args.items,
		reason: args.reason,
	};
	let mut raw_args = serde_json::to_value(&params).ok()?;
	if let Some(object) = raw_args.as_object_mut() {
		if let Some(intent) = args.i {
			object.insert("i".to_owned(), serde_json::Value::String(intent.to_string()));
		}
		if let Some(notrunc) = args.notrunc {
			object.insert("notrunc".to_owned(), serde_json::Value::Bool(notrunc));
		}
	}
	Some(LiftedCall {
		raw_args: Bytes::from(serde_json::to_vec(&raw_args).ok()?),
		verdict:  Bytes::from(verdict),
	})
}

const fn done(result: Result<Payload, Fault>) -> Ev<Update, Payload, Fault> {
	Ev::Done(ToolTerminal::Done { result, useless: false })
}
fn param_event(error: ParamError) -> Ev<Update, Payload, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(omp_tool::Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}
fn commit_event(error: omp_tool::CommitError) -> Ev<Update, Payload, Fault> {
	match error {
		omp_tool::CommitError::Aborted => Ev::Aborted(omp_tool::Abort::InputDropped),
		omp_tool::CommitError::Interrupted(interrupt) => {
			Ev::Aborted(omp_tool::Abort::Interrupted { reason: interrupt.reason })
		},
		omp_tool::CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}
fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  Some(Str::new_static(r#"{"op":"view"}"#)),
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	/// Parses one pi-shaped call so every test exercises the wire field names.
	fn params(json: &str) -> Params {
		serde_json::from_str(json).expect("todo params")
	}

	fn run(phases: &mut Vec<Phase>, json: &str) -> Result<Payload, Fault> {
		apply(phases, params(json))
	}

	fn ok(phases: &mut Vec<Phase>, json: &str) -> Payload {
		run(phases, json).expect("todo operation")
	}

	fn statuses(phases: &[Phase]) -> Vec<Status> {
		phases
			.iter()
			.flat_map(|phase| phase.tasks.iter().map(|task| task.status))
			.collect()
	}

	fn task<'a>(phases: &'a [Phase], content: &str) -> &'a Task {
		let (phase, index) = find_task(phases, content).expect("tracked task");
		&phases[phase].tasks[index]
	}

	fn names(phases: &[Phase]) -> Vec<&str> {
		phases.iter().map(|phase| phase.name.as_str()).collect()
	}

	fn prompt_text(todo: &Todo, view: Result<&Payload, &Fault>) -> String {
		let caps = PromptCaps::for_tool(
			omp_tool::CapsBase {
				maximum_parts:      1,
				maximum_text_bytes: u32::MAX,
				media:              false,
				model_class:        omp_tool::ModelClass::Standard,
			},
			&todo.spec.rev,
		);
		match todo.prompt(view, &caps).remove(0) {
			Part::Text { text } => text.to_string(),
			other => panic!("todo prompt is text: {other:?}"),
		}
	}

	#[test]
	fn params_and_payload_use_pi_field_names() {
		let call = params(
			r#"{"op":"init","list":[{"phase":"A","items":["a1"]}],"task":"a1","phase":"A","items":["x"],"reason":"r"}"#,
		);
		assert_eq!(call.task.as_deref(), Some("a1"));
		assert_eq!(call.list.as_ref().unwrap()[0].items, vec![sf!("a1")]);
		assert!(serde_json::from_str::<Params>(r#"{"op":"done","item":"a1"}"#).is_err());

		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["a","b"]}]}"#);
		let payload = ok(&mut phases, r#"{"op":"block","task":"b","reason":"waiting"}"#);
		assert_eq!(
			serde_json::to_value(&payload).unwrap(),
			json!({
				"op": "block",
				"phases": [{"name": "Work", "tasks": [
					{"content": "a", "status": "in_progress"},
					{"content": "b", "status": "blocked", "blocker": "waiting"},
				]}],
			})
		);
		let decoded: Payload = serde_json::from_value(json!({"op": "view", "phases": []})).unwrap();
		assert!(decoded.completed_tasks.is_empty());
	}

	#[test]
	fn revision_three_schema_is_the_pi_todo_wire_contract() {
		let todo = tool();
		assert_eq!(todo.spec().rev, Rev { family: Str::default(), n: 3 });
		let schema: serde_json::Value =
			serde_json::from_slice(&todo.spec().schema).expect("todo schema is JSON");
		let properties = schema["properties"].as_object().expect("object properties");
		let mut domain_properties = properties
			.keys()
			.filter(|name| !matches!(name.as_str(), "i" | "notrunc"))
			.map(String::as_str)
			.collect::<Vec<_>>();
		domain_properties.sort_unstable();
		assert_eq!(domain_properties, ["items", "list", "op", "phase", "reason", "task"]);
		assert!(properties["op"].is_object());
		for op in ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"] {
			assert!(serde_json::from_value::<Op>(json!(op)).is_ok());
		}
		assert_eq!(properties["items"]["description"], "tasks for single-phase init or append");
		assert_eq!(properties["list"]["description"], "phased task list (init)");
		assert_eq!(properties["reason"]["description"], "blocker note (block op)");
		assert!(properties.get("item").is_none());
		let required = schema["required"].as_array().expect("required fields");
		assert!(required.iter().any(|value| value == "i"));
		assert!(required.iter().any(|value| value == "op"));
		assert!(todo.spec().description.contains("pass content in `task`"));
	}

	#[test]
	fn auto_starts_the_first_task_after_init() {
		let mut phases = Vec::new();
		let payload = ok(
			&mut phases,
			r#"{"op":"init","list":[{"phase":"Execution","items":["status","diagnostics"]}]}"#,
		);
		assert_eq!(statuses(&payload.phases), vec![Status::InProgress, Status::Pending]);
		assert_eq!(
			summary(&payload.phases, false),
			"Remaining items (2):\n  - status [in_progress] (Execution)\n  - diagnostics [pending] \
			 (Execution)\nOverall: 0/2 done, 2 open.\nActive phase 1/1 \"Execution\" (0/2).\n  \
			 Execution:\n    - [ ] status (in progress)\n    - [ ] diagnostics"
		);
	}

	#[test]
	fn auto_promotes_the_next_pending_task_when_the_current_task_is_completed() {
		let mut phases = Vec::new();
		ok(
			&mut phases,
			r#"{"op":"init","list":[{"phase":"Execution","items":["status","diagnostics"]}]}"#,
		);
		let payload = ok(&mut phases, r#"{"op":"done","task":"status"}"#);
		assert_eq!(statuses(&payload.phases), vec![Status::Completed, Status::InProgress]);
		assert_eq!(payload.completed_tasks, vec![CompletionTransition {
			phase:   sf!("Execution"),
			content: sf!("status"),
		}]);
		let text = summary(&payload.phases, false);
		assert!(text.contains("Remaining items (1):"));
		assert!(text.contains("diagnostics [in_progress] (Execution)"));
		let payload = ok(&mut phases, r#"{"op":"done","task":"diagnostics"}"#);
		assert!(summary(&payload.phases, false).contains("Remaining items: none."));
	}

	#[test]
	fn jumps_to_a_specific_task_out_of_order() {
		let mut phases = Vec::new();
		ok(
			&mut phases,
			r#"{"op":"init","list":[{"phase":"Phase A","items":["first","second","third"]}]}"#,
		);
		let payload = ok(&mut phases, r#"{"op":"start","task":"third"}"#);
		assert_eq!(statuses(&payload.phases), vec![
			Status::Pending,
			Status::Pending,
			Status::InProgress
		]);
		assert_eq!(payload.op, Op::Start);
	}

	#[test]
	fn demotes_the_current_in_progress_task_when_starting_another() {
		let mut phases = Vec::new();
		ok(
			&mut phases,
			r#"{"op":"init","list":[{"phase":"A","items":["a1","a2"]},{"phase":"B","items":["b1"]}]}"#,
		);
		let payload = ok(&mut phases, r#"{"op":"start","task":"b1"}"#);
		assert_eq!(statuses(&payload.phases), vec![
			Status::Pending,
			Status::Pending,
			Status::InProgress
		]);
	}

	#[test]
	fn start_requires_task_content() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"A","items":["a1"]}]}"#);
		assert_eq!(run(&mut phases, r#"{"op":"start"}"#), Err(Fault::MissingTask));
		assert_eq!(run(&mut phases, r#"{"op":"start","task":""}"#), Err(Fault::MissingTask));
	}

	#[test]
	fn appends_items_to_an_existing_phase() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["First"]}]}"#);
		let payload = ok(&mut phases, r#"{"op":"append","phase":"Work","items":["Second"]}"#);
		assert_eq!(
			payload.phases[0]
				.tasks
				.iter()
				.map(|task| (task.content.as_str(), task.status))
				.collect::<Vec<_>>(),
			vec![("First", Status::InProgress), ("Second", Status::Pending)]
		);
	}

	#[test]
	fn blocks_a_task_and_unblocks_it() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["a","b"]}]}"#);
		let blocked = ok(&mut phases, r#"{"op":"block","task":"b","reason":"waiting on sign-off"}"#);
		let b = task(&blocked.phases, "b");
		assert_eq!(b.status, Status::Blocked);
		assert_eq!(b.blocker.as_deref(), Some("waiting on sign-off"));
		let text = summary(&blocked.phases, false);
		assert!(text.contains("Remaining items (1):"));
		assert!(text.contains("1 blocked"));
		assert!(text.contains("- [ ] b (blocked: waiting on sign-off)"));

		let unblocked = ok(&mut phases, r#"{"op":"unblock","task":"b"}"#);
		let b = task(&unblocked.phases, "b");
		assert_eq!(b.status, Status::Pending);
		assert_eq!(b.blocker, None);
	}

	#[test]
	fn does_not_auto_promote_a_blocked_task_to_in_progress() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["only"]}]}"#);
		let payload = ok(&mut phases, r#"{"op":"block","task":"only"}"#);
		assert_eq!(payload.phases[0].tasks[0].status, Status::Blocked);
		assert_eq!(payload.phases[0].tasks[0].blocker, None);
		assert!(summary(&payload.phases, false).contains("- [ ] only (blocked)"));
	}

	#[test]
	fn blocking_a_phase_leaves_completed_and_abandoned_tasks_closed() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["a","b","c"]}]}"#);
		ok(&mut phases, r#"{"op":"done","task":"a"}"#);
		ok(&mut phases, r#"{"op":"drop","task":"c"}"#);
		let payload = ok(&mut phases, r#"{"op":"block","phase":"Work","reason":"waiting on infra"}"#);
		assert_eq!(task(&payload.phases, "a").status, Status::Completed);
		assert_eq!(task(&payload.phases, "c").status, Status::Abandoned);
		assert_eq!(task(&payload.phases, "b").status, Status::Blocked);
		assert_eq!(task(&payload.phases, "b").blocker.as_deref(), Some("waiting on infra"));
		assert_eq!(task(&payload.phases, "a").blocker, None);
	}

	#[test]
	fn re_blocking_an_already_blocked_task_refines_its_blocker_note() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["a","b"]}]}"#);
		ok(&mut phases, r#"{"op":"block","task":"b"}"#);
		let first = ok(&mut phases, r#"{"op":"block","task":"b"}"#);
		assert_eq!(task(&first.phases, "b").blocker, None);
		let refined = ok(&mut phases, r#"{"op":"block","task":"b","reason":"waiting on user"}"#);
		assert_eq!(task(&refined.phases, "b").status, Status::Blocked);
		assert_eq!(task(&refined.phases, "b").blocker.as_deref(), Some("waiting on user"));
	}

	#[test]
	fn rejects_a_block_with_neither_task_nor_phase_target() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["a","b"]}]}"#);
		let before = phases.clone();
		assert_eq!(
			run(&mut phases, r#"{"op":"block","reason":"oops"}"#),
			Err(Fault::BlockRequiresTarget)
		);
		assert_eq!(phases, before);
		assert!(
			statuses(&phases)
				.iter()
				.all(|status| *status != Status::Blocked)
		);
		assert_eq!(
			prompt_text(&tool(), Err(&Fault::BlockRequiresTarget)),
			"Errors: block requires a task or phase target"
		);
	}

	#[test]
	fn rejects_an_unblock_with_neither_task_nor_phase_target() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["a"]}]}"#);
		ok(&mut phases, r#"{"op":"block","task":"a","reason":"x"}"#);
		assert_eq!(run(&mut phases, r#"{"op":"unblock"}"#), Err(Fault::UnblockRequiresTarget));
		assert_eq!(phases[0].tasks[0].status, Status::Blocked);
	}

	#[test]
	fn unblock_leaves_non_blocked_tasks_alone() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["a","b"]}]}"#);
		ok(&mut phases, r#"{"op":"done","task":"a"}"#);
		let payload = ok(&mut phases, r#"{"op":"unblock","phase":"Work"}"#);
		assert_eq!(statuses(&payload.phases), vec![Status::Completed, Status::InProgress]);
	}

	#[test]
	fn normalizes_a_multi_line_blocker_reason_so_the_markdown_round_trip_survives() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["a"]}]}"#);
		let blocked = ok(
			&mut phases,
			r#"{"op":"block","task":"a","reason":"waiting on user:\nline two\n\tindented three"}"#,
		);
		assert_eq!(
			task(&blocked.phases, "a").blocker.as_deref(),
			Some("waiting on user: line two indented three")
		);
		let markdown = render(&blocked.phases);
		assert_eq!(
			markdown
				.lines()
				.filter(|line| line.contains("- [!]"))
				.count(),
			1
		);
		let parsed = parse_markdown(&markdown).expect("round-trip");
		assert_eq!(task(&parsed, "a").status, Status::Blocked);
		assert_eq!(
			task(&parsed, "a").blocker.as_deref(),
			Some("waiting on user: line two indented three")
		);
	}

	#[test]
	fn creates_a_phase_when_append_targets_a_missing_phase() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["First"]}]}"#);
		let payload =
			ok(&mut phases, r#"{"op":"append","phase":"Cleanup","items":["Remove dead code"]}"#);
		assert_eq!(names(&payload.phases), vec!["Work", "Cleanup"]);
		assert_eq!(payload.phases[1].tasks[0].content, "Remove dead code");
	}

	#[test]
	fn append_rejects_duplicates_atomically() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["First"]}]}"#);
		let before = phases.clone();
		assert_eq!(
			run(&mut phases, r#"{"op":"append","phase":"Work","items":["New","First"]}"#),
			Err(Fault::TaskExists { content: sf!("First") })
		);
		assert_eq!(
			run(&mut phases, r#"{"op":"append","phase":"Work","items":["Twice","Twice"]}"#),
			Err(Fault::TaskExists { content: sf!("Twice") })
		);
		assert_eq!(phases, before);
	}

	#[test]
	fn append_requires_phase_and_non_empty_items() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["First"]}]}"#);
		assert_eq!(
			run(&mut phases, r#"{"op":"append","items":["Second"]}"#),
			Err(Fault::AppendMissingPhase)
		);
		assert_eq!(
			run(&mut phases, r#"{"op":"append","phase":"Work","items":[]}"#),
			Err(Fault::AppendMissingItems)
		);
		assert_eq!(
			run(&mut phases, r#"{"op":"append","phase":"Work"}"#),
			Err(Fault::AppendMissingItems)
		);
	}

	#[test]
	fn marks_all_tasks_in_a_phase_done() {
		let mut phases = Vec::new();
		ok(
			&mut phases,
			r#"{"op":"init","list":[{"phase":"Work","items":["First","Second"]},{"phase":"Later","items":["Third"]}]}"#,
		);
		let payload = ok(&mut phases, r#"{"op":"done","phase":"Work"}"#);
		assert_eq!(statuses(&payload.phases), vec![
			Status::Completed,
			Status::Completed,
			Status::InProgress
		]);
		assert_eq!(payload.completed_tasks.len(), 2);
	}

	#[test]
	fn done_without_a_target_completes_every_task() {
		let mut phases = Vec::new();
		ok(
			&mut phases,
			r#"{"op":"init","list":[{"phase":"A","items":["a"]},{"phase":"B","items":["b"]}]}"#,
		);
		let payload = ok(&mut phases, r#"{"op":"done"}"#);
		assert_eq!(statuses(&payload.phases), vec![Status::Completed, Status::Completed]);
		assert!(summary(&payload.phases, false).contains("Remaining items: none."));
	}

	#[test]
	fn removes_all_tasks_when_rm_omits_task_and_phase() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["First","Second"]}]}"#);
		let payload = ok(&mut phases, r#"{"op":"rm"}"#);
		assert_eq!(names(&payload.phases), vec!["Work"]);
		assert!(payload.phases[0].tasks.is_empty());
		assert_eq!(summary(&payload.phases, false), "Todo list cleared.");
	}

	#[test]
	fn rm_removes_one_task_or_empties_one_phase() {
		let mut phases = Vec::new();
		ok(
			&mut phases,
			r#"{"op":"init","list":[{"phase":"A","items":["a1","a2"]},{"phase":"B","items":["b1"]}]}"#,
		);
		let payload = ok(&mut phases, r#"{"op":"rm","task":"a1"}"#);
		assert_eq!(payload.phases[0].tasks.len(), 1);
		assert_eq!(payload.phases[0].tasks[0].content, "a2");
		assert_eq!(payload.phases[0].tasks[0].status, Status::InProgress);
		let payload = ok(&mut phases, r#"{"op":"rm","phase":"A"}"#);
		assert_eq!(names(&payload.phases), vec!["A", "B"]);
		assert!(payload.phases[0].tasks.is_empty());
		assert_eq!(payload.phases[1].tasks[0].status, Status::InProgress);
		assert_eq!(
			run(&mut phases, r#"{"op":"rm","phase":"Missing"}"#),
			Err(Fault::PhaseNotFound { name: sf!("Missing") })
		);
	}

	#[test]
	fn drops_all_tasks_in_a_phase() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["First","Second"]}]}"#);
		let payload = ok(&mut phases, r#"{"op":"drop","phase":"Work"}"#);
		assert_eq!(statuses(&payload.phases), vec![Status::Abandoned, Status::Abandoned]);
		assert!(summary(&payload.phases, false).contains("- [ ] First (dropped)"));
	}

	#[test]
	fn view_echoes_state_without_mutating_it() {
		let mut phases = vec![Phase {
			name:  sf!("Work"),
			tasks: vec![pending_task(sf!("First")), pending_task(sf!("Second"))],
		}];
		let before = phases.clone();
		let payload = ok(&mut phases, r#"{"op":"view"}"#);
		assert_eq!(statuses(&payload.phases), vec![Status::Pending, Status::Pending]);
		assert_eq!(phases, before);
		let text = prompt_text(&tool(), Ok(&payload));
		assert!(text.contains("First"));
		assert!(text.contains("Second"));
	}

	#[test]
	fn view_on_an_empty_list_reports_empty_not_cleared() {
		let mut phases = Vec::new();
		let payload = ok(&mut phases, r#"{"op":"view"}"#);
		assert_eq!(prompt_text(&tool(), Ok(&payload)), "Todo list is empty.");
	}

	#[test]
	fn accepts_a_flattened_init_with_bare_items_and_no_phase() {
		let mut phases = Vec::new();
		let payload = ok(&mut phases, r#"{"op":"init","items":["First","Second"]}"#);
		assert_eq!(names(&payload.phases), vec!["Tasks"]);
		assert_eq!(statuses(&payload.phases), vec![Status::InProgress, Status::Pending]);
	}

	#[test]
	fn honors_a_bare_phase_on_a_flattened_init() {
		let mut phases = Vec::new();
		let payload =
			ok(&mut phases, r#"{"op":"init","phase":"Cleanup","items":["Remove dead code"]}"#);
		assert_eq!(names(&payload.phases), vec!["Cleanup"]);
		assert_eq!(payload.phases[0].tasks[0].content, "Remove dead code");
	}

	#[test]
	fn init_errors_without_list_or_items_and_clears_on_an_empty_list() {
		let mut phases = Vec::new();
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["First"]}]}"#);
		let before = phases.clone();
		assert_eq!(run(&mut phases, r#"{"op":"init"}"#), Err(Fault::MissingList));
		assert_eq!(run(&mut phases, r#"{"op":"init","items":[]}"#), Err(Fault::MissingList));
		assert_eq!(phases, before);
		let payload = ok(&mut phases, r#"{"op":"init","list":[]}"#);
		assert!(payload.phases.is_empty());
		assert!(phases.is_empty());
	}

	#[test]
	fn init_rejects_duplicate_phases_and_tasks() {
		let mut phases = Vec::new();
		assert_eq!(
			run(
				&mut phases,
				r#"{"op":"init","list":[{"phase":"A","items":["a"]},{"phase":"A","items":["b"]}]}"#
			),
			Err(Fault::DuplicatePhase { name: sf!("A") })
		);
		assert_eq!(
			run(
				&mut phases,
				r#"{"op":"init","list":[{"phase":"A","items":["a"]},{"phase":"B","items":["a"]}]}"#
			),
			Err(Fault::DuplicateTask { content: sf!("a") })
		);
		assert!(phases.is_empty());
	}

	#[test]
	fn task_lookup_is_exact_and_reports_pi_diagnostics() {
		let mut phases = Vec::new();
		assert_eq!(
			run(&mut phases, r#"{"op":"done","task":"ghost"}"#),
			Err(Fault::TaskNotFoundInEmptyList { content: sf!("ghost") })
		);
		ok(&mut phases, r#"{"op":"init","list":[{"phase":"Work","items":["Port router"]}]}"#);
		assert_eq!(
			run(&mut phases, r#"{"op":"done","task":"port router"}"#),
			Err(Fault::TaskNotFound { content: sf!("port router") })
		);
		assert_eq!(
			run(&mut phases, r#"{"op":"done","task":"task-1"}"#),
			Err(Fault::TaskIdReference { content: sf!("task-1") })
		);
		assert_eq!(
			run(&mut phases, r#"{"op":"done","phase":"work"}"#),
			Err(Fault::PhaseNotFound { name: sf!("work") })
		);
		assert_eq!(
			Fault::TaskIdReference { content: sf!("task-1") }.to_string(),
			"Task \"task-1\" not found. Tasks are referenced by content, not by IDs — pass the \
			 task's full text from the previous result."
		);
		assert_eq!(
			Fault::TaskNotFoundInEmptyList { content: sf!("ghost") }.to_string(),
			"Task \"ghost\" not found (todo list is empty — was it replaced or not yet created?)"
		);
		assert_eq!(statuses(&phases), vec![Status::InProgress]);
	}

	#[test]
	fn task_target_wins_over_phase_and_task_ids_never_resolve() {
		let mut phases = Vec::new();
		ok(
			&mut phases,
			r#"{"op":"init","list":[{"phase":"A","items":["a1"]},{"phase":"B","items":["b1"]}]}"#,
		);
		let payload = ok(&mut phases, r#"{"op":"done","task":"b1","phase":"A"}"#);
		assert_eq!(statuses(&payload.phases), vec![Status::InProgress, Status::Completed]);
	}

	#[test]
	fn failed_operations_never_normalize_state() {
		let mut phases = vec![Phase {
			name:  sf!("Work"),
			tasks: vec![
				Task { content: sf!("first"), status: Status::InProgress, blocker: None },
				Task { content: sf!("second"), status: Status::InProgress, blocker: None },
			],
		}];
		let before = phases.clone();
		assert_eq!(
			run(&mut phases, r#"{"op":"done","task":"missing"}"#),
			Err(Fault::TaskNotFound { content: sf!("missing") })
		);
		assert_eq!(phases, before);
		ok(&mut phases, r#"{"op":"view"}"#);
		assert_eq!(phases, before);
		let payload = ok(&mut phases, r#"{"op":"append","phase":"Work","items":["later"]}"#);
		assert_eq!(statuses(&payload.phases), vec![
			Status::InProgress,
			Status::Pending,
			Status::Pending
		]);
	}

	#[test]
	fn summary_explains_a_backward_pointer_after_out_of_order_work() {
		let mut phases = Vec::new();
		ok(
			&mut phases,
			r#"{"op":"init","list":[{"phase":"A","items":["a1"]},{"phase":"B","items":["b1"]}]}"#,
		);
		let payload = ok(&mut phases, r#"{"op":"done","task":"b1"}"#);
		let text = summary(&payload.phases, false);
		assert!(text.contains("Overall: 1/2 done, 1 open."));
		assert!(text.contains("Active phase 1/2 \"A\" (0/1) — earliest phase with open tasks"));
		assert!(text.contains("    - [X] b1"));
	}

	#[test]
	fn infers_a_missing_op_only_from_unambiguous_shapes() {
		let resolved =
			resolve_params(json!({"list": [{"phase": "Fixes", "items": ["One"]}]}), false).unwrap();
		assert_eq!(resolved.op, Op::Init);
		let resolved = resolve_params(json!({"phase": "Work", "items": ["Second"]}), true).unwrap();
		assert_eq!(resolved.op, Op::Append);
		let resolved = resolve_params(json!({"items": ["Only task"]}), false).unwrap();
		assert_eq!(resolved.op, Op::Init);
		let ambiguous = resolve_params(json!({"items": ["Second"]}), true).unwrap_err();
		assert_eq!(ambiguous.kind, ArgIssueKind::Missing);
		assert_eq!(ambiguous.path, vec![ArgPath::Key(sf!("op"))]);
		let missing = resolve_params(json!({"task": "Something"}), false).unwrap_err();
		assert_eq!(missing.kind, ArgIssueKind::Missing);
		let malformed = resolve_params(json!({"op": "view", "item": "x"}), false).unwrap_err();
		assert_eq!(malformed.kind, ArgIssueKind::Malformed);
		let explicit = resolve_params(json!({"op": "view", "items": []}), true).unwrap();
		assert_eq!(explicit.op, Op::View);
	}

	#[test]
	fn actionable_snapshot_is_ordered_and_excludes_non_actionable_tasks() {
		let todo = tool();
		*todo.phases.lock() = vec![
			Phase {
				name:  sf!("Build"),
				tasks: vec![
					Task { content: sf!("active"), status: Status::InProgress, blocker: None },
					Task {
						content: sf!("blocked"),
						status:  Status::Blocked,
						blocker: Some(sf!("wait")),
					},
					pending_task(sf!("pending")),
				],
			},
			Phase {
				name:  sf!("Ship"),
				tasks: vec![
					Task { content: sf!("done"), status: Status::Completed, blocker: None },
					pending_task(sf!("next")),
					Task { content: sf!("dropped"), status: Status::Abandoned, blocker: None },
				],
			},
		];
		assert_eq!(todo.actionable_snapshot(), vec![
			ActionableTodoRef {
				phase:   sf!("Build"),
				content: sf!("active"),
				status:  Status::InProgress,
			},
			ActionableTodoRef {
				phase:   sf!("Build"),
				content: sf!("pending"),
				status:  Status::Pending,
			},
			ActionableTodoRef { phase: sf!("Ship"), content: sf!("next"), status: Status::Pending },
		]);
	}

	#[test]
	fn editable_markdown_round_trips_every_status_and_blocker() {
		let phases = vec![Phase {
			name:  sf!("Build"),
			tasks: vec![
				pending_task(sf!("pending")),
				Task { content: sf!("active"), status: Status::InProgress, blocker: None },
				Task { content: sf!("done"), status: Status::Completed, blocker: None },
				Task { content: sf!("dropped"), status: Status::Abandoned, blocker: None },
				Task {
					content: sf!("blocked"),
					status:  Status::Blocked,
					blocker: Some(sf!("waiting for owner")),
				},
			],
		}];
		let markdown = render(&phases);
		assert!(markdown.contains("- [!] blocked <!-- blocker: waiting for owner -->"));
		assert_eq!(parse_markdown(&markdown).expect("round-trip"), phases);
		assert_eq!(
			statuses(
				&parse_markdown("# Imported\n* \\[>\\] active\n+ [~] dropped\n").expect("aliases")
			),
			vec![Status::InProgress, Status::Abandoned]
		);
		assert_eq!(
			statuses(&parse_markdown("- [ ] first\n- [ ] second\n").expect("promotes")),
			vec![Status::InProgress, Status::Pending]
		);
		assert_eq!(
			parse_markdown("- [?] odd\n"),
			Err(MarkdownError::UnknownMarker { line: 1, marker: '?' })
		);
	}

	#[test]
	fn lifts_rev_one_calls_to_the_pi_wire() {
		let todo = tool();
		let from = Rev { family: Str::default(), n: 1 };
		let raw_args = br#"{"i":"Tracking","notrunc":true,"op":"init","list":[{"phase":"Build","items":[{"text":"port","status":"pending"}]}],"item":"port"}"#;
		let verdict = br##"{"kind":"ok","value":{"phases":[{"phase":"Build","items":[{"text":"port","status":"blocked","reason":"ci"}]}],"rendered":"# Build\n"}}"##;
		let lifted = todo
			.lift(&from, RecordedCall { raw_args, verdict })
			.expect("rev 1 lifts");
		assert_eq!(
			serde_json::from_slice::<serde_json::Value>(&lifted.raw_args).unwrap(),
			json!({
				"op": "init",
				"list": [{"phase": "Build", "items": ["port"]}],
				"task": "port",
				"i": "Tracking",
				"notrunc": true,
			})
		);
		assert_eq!(
			serde_json::from_slice::<serde_json::Value>(&lifted.verdict).unwrap(),
			json!({"kind": "ok", "value": {"op": "init", "phases": [{"name": "Build", "tasks": [
				{"content": "port", "status": "blocked", "blocker": "ci"},
			]}]}})
		);
		let faulted =
			br#"{"kind":"faulted","value":{"kind":"missing","message":"phase not found: x"}}"#;
		assert!(
			todo
				.lift(&from, RecordedCall { raw_args, verdict: faulted })
				.is_none()
		);
		let rev_two_args = br#"{"i":"Tracking","op":"view","task":"port"}"#;
		let rev_two_verdict =
			br#"{"kind":"ok","value":{"op":"view","phases":[{"name":"Build","tasks":[{"content":"port","status":"in_progress"}]}]}}"#;
		let rev_two = todo
			.lift(&Rev { family: Str::default(), n: 2 }, RecordedCall {
				raw_args: rev_two_args,
				verdict:  rev_two_verdict,
			})
			.expect("rev 2 lifts byte-for-byte");
		assert_eq!(rev_two.raw_args.as_ref(), rev_two_args);
		assert_eq!(rev_two.verdict.as_ref(), rev_two_verdict);
		assert!(
			todo
				.lift(&Rev { family: Str::default(), n: 3 }, RecordedCall { raw_args, verdict })
				.is_none()
		);
	}
}
