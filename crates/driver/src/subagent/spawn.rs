//! Journal-first child-kernel spawn composition.

use std::{
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, Instant, SystemTime, SystemTimeError, UNIX_EPOCH},
};

use omp_agent::{
	BackgroundToolCancellation, DirectorError, DirectorRegistry, DirectorStack, ForceUntil,
	JobBoard, JobSettlement, LifecycleHookError, LifecycleHooks, RunControl, SessionTool,
	SessionToolCx, SessionToolFuture, TurnInput, TurnStop, directors::force_tool::ForceTool,
};
use omp_con::{CfgLoader, ConError, Ctx};
use omp_core::{Str, Ulid};
use omp_dom::{PropId, PropKey, Value};
use omp_env::EnvClient;
use omp_proto::{
	env::v1::{CreateWorktree, DestroyWorktree, MergeMode, MergeWorktree},
	toolhost::v1::HookEventId,
};
use omp_session::{
	Session, SessionError,
	components::jobs::{self, JobSpec},
};
use omp_tool::{CallOutcome, ToolSpec};
use omp_tools::{
	output_schema::{self, OutputStatus, SchemaMode},
	task::{
		ChildRequest, ChildResult, Fault as TaskFault, Params as TaskParams, Payload as TaskPayload,
		StartedChild, StructuredOutput, SubagentSpawner, TaskEffort, Update as TaskUpdate,
		WorkspaceOutcome,
	},
};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use super::{
	settings::{
		SV_TASK_RECURSION_DEPTH, TaskEffortCeiling, TaskIsolationMerge, TaskSettings, child_ctx,
	},
	yield_assembly,
};
use crate::headless::{
	HeadlessError,
	kernel::{KernelOptions, compose_kernel},
};

/// Standard prefix when a run ends without a yield.
const WARNING_MISSING_YIELD: &str = "[subagent missing yield] the run ended without finalization";
/// Reminder turns demanded from a schema-bound child that stops without a
/// `yield` call before the run is failed: two soft reminders, then one
/// natively forced choice.
const MAX_YIELD_RETRIES: u32 = 3;
/// Developer reminder appended to a schema-bound child's turn when it stops
/// idle without finalizing.
const YIELD_REMINDER: &str =
	"Last turn had no yield call; the session is idle. Every turn MUST end with a tool call. First \
	 applicable: resume work with the next intended tool if the assignment is incomplete; yield \
	 success through a terminal `yield` with complete `result.data` if genuinely complete; yield \
	 an error only for a real, nameable blocker. NEVER end this turn with text only.";

/// Declaration-only spawner used to place `task@1` in the frozen registry.
///
/// Dispatcher session routing intercepts the call before this value can run.
pub struct TaskDeclarationSpawner;

impl SubagentSpawner for TaskDeclarationSpawner {
	async fn spawn<'a>(
		&'a self,
		_owner: &'a str,
		_request: TaskParams,
		_updates: &'a flume::Sender<TaskUpdate>,
	) -> Result<TaskPayload, TaskFault> {
		Err(TaskFault { message: Str::new_static("task session dispatcher is unavailable") })
	}
}

/// Concrete driver-owned implementation of the tools crate's spawn seam.
///
/// The parent session mutex is an integration boundary, not durable state: all
/// lifecycle truth is committed to its journal and DOM by [`spawn_child`].
pub struct DriverSubagentSpawner {
	/// Parent journal controller.
	pub parent:       Arc<tokio::sync::Mutex<Session>>,
	/// Production data root.
	pub data_dir:     PathBuf,
	/// Parent or isolated project root.
	pub project_root: PathBuf,
	/// Parent sessions directory.
	pub sessions_dir: PathBuf,
	/// Shared live-session routing authority.
	pub sessions:     Arc<crate::sessions::SessionRegistry>,
	/// Parent effective console context.
	pub parent_ctx:   Arc<Ctx>,
	/// Runtime job index paired with the parent DOM.
	pub jobs:         Arc<JobBoard>,
	/// Environment authority for isolated whole-workspace views.
	pub env:          EnvClient,
	/// Configuration script loader.
	pub cfg:          Arc<dyn CfgLoader>,
	/// Model selector used unless a driver policy resolves another route.
	pub model:        Str,
	/// Extension lifecycle gate (`subagent_spawn`); `None` runs ungated.
	pub hooks:        Option<LifecycleHooks>,
}

impl SubagentSpawner for DriverSubagentSpawner {
	async fn spawn<'a>(
		&'a self,
		owner: &'a str,
		request: TaskParams,
		updates: &'a flume::Sender<TaskUpdate>,
	) -> Result<TaskPayload, TaskFault> {
		let started = Instant::now();
		let request = request.into_batch();
		admit_batch(&self.parent_ctx, &self.jobs, &request.tasks)
			.map_err(|source| TaskFault { message: Str::new(source.to_string()) })?;
		let mut pending = Vec::with_capacity(request.tasks.len());
		for child in request.tasks {
			let child = admit_child(self.hooks.as_ref(), &self.parent_ctx, child, &self.model)
				.await
				.map_err(|source| TaskFault { message: Str::new(source.to_string()) })?;
			let announced = child
				.name
				.clone()
				.unwrap_or_else(|| Str::new_static("pending"));
			let _ = updates
				.send_async(TaskUpdate { id: announced, status: Str::new_static("starting") })
				.await;
			let cancel = CancellationToken::new();
			let mut parent = self.parent.lock().await;
			let prepared = prepare_child(&mut parent, SpawnRequest {
				data_dir: &self.data_dir,
				project_root: &self.project_root,
				sessions_dir: &self.sessions_dir,
				sessions: &self.sessions,
				parent_ctx: &self.parent_ctx,
				cfg: self.cfg.as_ref(),
				jobs: &self.jobs,
				env: &self.env,
				cancel: BackgroundToolCancellation::from_token_for_host(cancel.clone()),
				owner,
				context: request.context.as_str(),
				model: self.model.as_str(),
				child,
			})
			.map_err(|source| TaskFault { message: Str::new(source.to_string()) })?;
			let handle = prepared.handle;
			let id = prepared.id.clone();
			let fallback = ChildResult {
				id:           id.clone(),
				agent:        prepared.agent.clone(),
				text:         Str::default(),
				description:  None,
				assignment:   Some(prepared.child.task.clone()),
				stats:        None,
				session_path: Str::new(prepared.session_path.to_string_lossy()),
				tokens_in:    0,
				tokens_out:   0,
				output:       None,
				workspace:    None,
				error:        None,
			};
			let factory = move |cancel| spawn_child_task(prepared.clone(), cancel);
			if !self.jobs.attach_restartable(parent.dom(), handle, factory) {
				return Err(TaskFault {
					message: Str::new_static("subagent job could not be attached"),
				});
			}
			pending.push((id, fallback));
		}
		let mut children = Vec::with_capacity(pending.len());
		for (id, mut fallback) in pending {
			let (record, output) = {
				let mut parent = self.parent.lock().await;
				let record = self
					.jobs
					.wait(&mut parent, Some(std::slice::from_ref(&id)))
					.await
					.map_err(|source| TaskFault { message: Str::new(source.to_string()) })?;
				let output = record
					.as_ref()
					.and_then(|record| record.output.as_deref())
					.map(|output| omp_agent::resolve_output(&parent, output))
					.transpose()
					.map_err(|source| TaskFault { message: Str::new(source.to_string()) })?
					.flatten();
				(record, output)
			};
			let Some(record) = record else {
				fallback.error = Some(Str::new_static("subagent job disappeared before settlement"));
				children.push(fallback);
				continue;
			};
			let result = output
				.and_then(|output| serde_json::from_str::<ChildResult>(output.get()).ok())
				.unwrap_or_else(|| {
					fallback.error = record.error.clone();
					fallback
				});
			let _ = updates
				.send_async(TaskUpdate { id, status: record.status })
				.await;
			children.push(result);
		}
		Ok(TaskPayload::Settled {
			children,
			duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
		})
	}
}

/// Session-owned `task@1` implementation composed by the driver.
pub struct TaskSessionTool {
	data_dir:     PathBuf,
	project_root: PathBuf,
	sessions_dir: PathBuf,
	sessions:     Arc<crate::sessions::SessionRegistry>,
	parent_ctx:   Arc<Ctx>,
	cfg:          Arc<dyn CfgLoader>,
	env:          EnvClient,
	owner:        Str,
	model:        Str,
	spec:         ToolSpec,
}

impl TaskSessionTool {
	/// Creates the task tool using host-owned child composition inputs.
	#[must_use]
	pub fn new(
		data_dir: PathBuf,
		project_root: PathBuf,
		sessions_dir: PathBuf,
		sessions: Arc<crate::sessions::SessionRegistry>,
		parent_ctx: Arc<Ctx>,
		cfg: Arc<dyn CfgLoader>,
		env: EnvClient,
		owner: Str,
		model: Str,
	) -> Self {
		Self {
			data_dir,
			project_root,
			sessions_dir,
			sessions,
			parent_ctx,
			cfg,
			env,
			owner,
			model,
			spec: omp_tools::task::spec(),
		}
	}
}

impl SessionTool for TaskSessionTool {
	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'a>(
		&'a self,
		cx: SessionToolCx<'a>,
		args: Box<serde_json::value::RawValue>,
	) -> SessionToolFuture<'a> {
		Box::pin(async move {
			let mut value: serde_json::Value = serde_json::from_str(args.get())?;
			if let Some(object) = value.as_object_mut() {
				object.remove("i");
			}
			let request: TaskParams = serde_json::from_value(value)?;
			let request = request.into_batch();
			if request.tasks.is_empty() {
				let fault = serde_json::value::to_raw_value(&TaskFault {
					message: Str::new_static("task requires at least one child"),
				})?;
				return Ok(CallOutcome::Faulted(fault));
			}
			if let Err(source) = admit_batch(&self.parent_ctx, cx.jobs, &request.tasks) {
				let fault = serde_json::value::to_raw_value(&TaskFault {
					message: Str::new(source.to_string()),
				})?;
				return Ok(CallOutcome::Faulted(fault));
			}
			let mut jobs = Vec::with_capacity(request.tasks.len());
			for child in request.tasks {
				let child = match admit_child(cx.hooks, &self.parent_ctx, child, &self.model).await {
					Ok(child) => child,
					Err(source) => {
						let fault = serde_json::value::to_raw_value(&TaskFault {
							message: Str::new(source.to_string()),
						})?;
						return Ok(CallOutcome::Faulted(fault));
					},
				};
				let cancel = cx.cancel.token().child_token();
				let prepared = match prepare_child(cx.session, SpawnRequest {
					data_dir: &self.data_dir,
					project_root: &self.project_root,
					sessions_dir: &self.sessions_dir,
					sessions: &self.sessions,
					parent_ctx: &self.parent_ctx,
					cfg: self.cfg.as_ref(),
					jobs: cx.jobs,
					env: &self.env,
					cancel: BackgroundToolCancellation::from_token_for_host(cancel.clone()),
					owner: self.owner.as_str(),
					context: request.context.as_str(),
					model: self.model.as_str(),
					child,
				}) {
					Ok(prepared) => prepared,
					Err(source) => {
						let fault = serde_json::value::to_raw_value(&TaskFault {
							message: Str::new(source.to_string()),
						})?;
						return Ok(CallOutcome::Faulted(fault));
					},
				};
				let handle = prepared.handle;
				let id = prepared.id.clone();
				let agent = prepared.agent.clone();
				let session_path = prepared.session_path.clone();
				let factory = move |cancel| spawn_child_task(prepared.clone(), cancel);
				if !cx
					.jobs
					.attach_restartable(cx.session.dom(), handle, factory)
				{
					let fault = serde_json::value::to_raw_value(&TaskFault {
						message: Str::new_static("subagent job could not be attached"),
					})?;
					return Ok(CallOutcome::Faulted(fault));
				}
				jobs.push(StartedChild {
					id,
					agent,
					session_path: Str::new(session_path.to_string_lossy()),
					status: Str::new_static("running"),
				});
			}
			let payload = serde_json::value::to_raw_value(&TaskPayload::Started { jobs })?;
			Ok(CallOutcome::Ok(payload))
		})
	}
}

/// Failure to configure, journal, compose, or run one child kernel.
#[derive(Debug, Error)]
pub enum SpawnError {
	/// Child convar seeding or cfg execution failed.
	#[error("child console configuration failed")]
	Con(#[from] ConError),
	/// Parent job-tree update failed.
	#[error("parent job projection failed")]
	Session(#[from] SessionError),
	/// Production kernel composition failed.
	#[error("child kernel composition failed")]
	Headless(#[from] HeadlessError),
	/// Child turn failed.
	#[error("child turn failed")]
	Kernel(#[from] omp_agent::KernelError),
	/// Engaging the child's yield-enforcement Director failed.
	#[error("child yield director engagement failed")]
	Director(#[from] DirectorError),
	/// Environment isolation or merge failed.
	#[error("subagent workspace operation failed")]
	Environment(#[from] omp_env::ClientError),
	/// Environment returned an invalid isolated workspace.
	#[error("subagent workspace response was invalid: {message}")]
	Workspace {
		/// Stable protocol defect.
		message: Str,
	},
	/// System clock is unavailable.
	#[error("system clock predates the Unix epoch")]
	Clock(#[from] SystemTimeError),
	/// The parent session has no journal head.
	#[error("parent session has no journal head")]
	MissingParentHead,
	/// The standard jobs component is absent.
	#[error("parent session has no jobs component")]
	MissingJobs,
	/// The child controller disappeared while its host was rebinding transport.
	#[error("child session `{id}` is no longer live")]
	MissingLiveEndpoint {
		/// Stable child session identity.
		id: Str,
	},
	/// The selected agent is disabled by child policy.
	#[error("subagent `{agent}` is disabled by policy")]
	DisabledAgent {
		/// Rejected agent class.
		agent: Str,
	},
	/// The configured concurrent child ceiling is full.
	#[error("subagent concurrency limit {maximum} is already full")]
	Concurrency {
		/// Configured live-child ceiling.
		maximum: usize,
	},
	/// The configured recursive child depth has been reached.
	#[error("subagent recursion depth {depth} reaches configured maximum {maximum}")]
	RecursionDepth {
		/// Current parent depth.
		depth:   u32,
		/// Configured maximum depth.
		maximum: i32,
	},
	/// A `subagent_spawn` hook refused the child.
	#[error("subagent spawn denied by extension: {reason}")]
	Denied {
		/// Stable extension-supplied reason.
		reason: Str,
	},
	/// The `subagent_spawn` gate itself failed (malformed transform, approval
	/// at a lifecycle seam, payload encoding).
	#[error("subagent spawn hook failed")]
	Hook(#[source] LifecycleHookError),
	/// A `subagent_spawn` transform returned a field outside the
	/// `SubagentSpec` contract.
	#[error("subagent spawn transform returned malformed field `{field}`")]
	MalformedTransform {
		/// Dotted field path.
		field: &'static str,
	},
}

/// Runs the `subagent_spawn` gate over one child request (Python
/// `SubagentSpec`): a denial is a typed spawn failure, a transform replaces
/// the request's spec-bearing fields, and an unsubscribed or absent gate
/// returns the request unchanged.
pub async fn admit_child(
	hooks: Option<&LifecycleHooks>,
	parent_ctx: &Ctx,
	child: ChildRequest,
	model: &str,
) -> Result<ChildRequest, SpawnError> {
	let Some(hooks) = hooks else {
		return Ok(child);
	};
	if !hooks
		.hook_gate()
		.subscribed(HookEventId::HookEventSubagentSpawn)
	{
		return Ok(child);
	}
	let payload = subagent_spec(parent_ctx, &child, model);
	match hooks
		.gate(HookEventId::HookEventSubagentSpawn, payload.clone())
		.await
	{
		Ok(effective) => child_from_spec(child, &payload, &effective),
		Err(LifecycleHookError::Denied { reason, .. }) => Err(SpawnError::Denied { reason }),
		Err(error) => Err(SpawnError::Hook(error)),
	}
}

/// The Python `SubagentSpec` view of one child request.
fn subagent_spec(parent_ctx: &Ctx, child: &ChildRequest, model: &str) -> serde_json::Value {
	let settings = TaskSettings::from_con(parent_ctx);
	let depth = SV_TASK_RECURSION_DEPTH.get(parent_ctx);
	let worktree = child
		.isolated
		.unwrap_or(settings.isolation.mode != super::settings::TaskIsolationMode::None);
	let merge = if worktree {
		<&'static str>::from(settings.isolation.merge)
	} else {
		"none"
	};
	serde_json::json!({
		"task": child.task,
		"name": child.name,
		"agent": child.agent.as_deref().unwrap_or("task"),
		"system_prompt": serde_json::Value::Null,
		"model": model,
		"on_model_unavailable": "fail",
		"thinking": child.effort.map(effort_name),
		"allowed_devices": serde_json::Value::Null,
		"disallowed_devices": [],
		"isolation": "clean",
		"max_depth": i64::from(settings.max_recursion_depth).saturating_sub(i64::from(depth)).max(0),
		"cwd": serde_json::Value::Null,
		"worktree": worktree,
		"merge": merge,
		"env_vars": {},
		"background": false,
		"output_schema": child.output_schema,
		"schema_mode": match child.schema_mode {
			Some(SchemaMode::Strict) => "strict",
			Some(SchemaMode::Permissive) | None => "permissive",
		},
		"deadline": serde_json::Value::Null,
		"request_budget": serde_json::Value::Null,
		"budget": serde_json::Value::Null,
		"labels": {},
	})
}

const fn effort_name(effort: TaskEffort) -> &'static str {
	match effort {
		TaskEffort::Lo => "lo",
		TaskEffort::Med => "med",
		TaskEffort::Hi => "hi",
	}
}

/// Reads the spec-bearing fields a transform changed (relative to the
/// `sent` spec) back into the child request; every field is validated,
/// unknown ones are ignored, untouched ones keep the request's own value.
fn child_from_spec(
	mut child: ChildRequest,
	sent: &serde_json::Value,
	effective: &serde_json::Value,
) -> Result<ChildRequest, SpawnError> {
	let effective = serde_json::Value::Object(
		effective
			.as_object()
			.map(|object| {
				object
					.iter()
					.filter(|(name, value)| sent.get(name.as_str()) != Some(*value))
					.map(|(name, value)| (name.clone(), value.clone()))
					.collect()
			})
			.unwrap_or_default(),
	);
	let effective = &effective;
	let field = |name: &'static str| effective.get(name).filter(|value| !value.is_null());
	if let Some(task) = field("task") {
		let task = task
			.as_str()
			.filter(|task| !task.trim().is_empty())
			.ok_or(SpawnError::MalformedTransform { field: "task" })?;
		child.task = Str::new(task);
	}
	match effective.get("name") {
		None => {},
		Some(serde_json::Value::Null) => child.name = None,
		Some(name) => {
			let name = name
				.as_str()
				.filter(|name| {
					let mut chars = name.chars();
					chars
						.next()
						.is_some_and(|first| first.is_ascii_alphabetic())
						&& name.len() <= 32
						&& chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
				})
				.ok_or(SpawnError::MalformedTransform { field: "name" })?;
			child.name = Some(Str::new(name));
		},
	}
	if let Some(agent) = field("agent") {
		let agent = agent
			.as_str()
			.filter(|agent| !agent.trim().is_empty())
			.ok_or(SpawnError::MalformedTransform { field: "agent" })?;
		child.agent = Some(Str::new(agent));
	}
	match effective.get("thinking") {
		None => {},
		Some(serde_json::Value::Null) => child.effort = None,
		Some(thinking) => {
			child.effort = Some(match thinking.as_str() {
				Some("lo" | "off") => TaskEffort::Lo,
				Some("med") => TaskEffort::Med,
				Some("hi") => TaskEffort::Hi,
				_ => return Err(SpawnError::MalformedTransform { field: "thinking" }),
			});
		},
	}
	if let Some(worktree) = field("worktree") {
		child.isolated = Some(
			worktree
				.as_bool()
				.ok_or(SpawnError::MalformedTransform { field: "worktree" })?,
		);
	}
	match effective.get("output_schema") {
		None => {},
		Some(serde_json::Value::Null) => child.output_schema = None,
		Some(schema) => {
			if !schema.is_object() {
				return Err(SpawnError::MalformedTransform { field: "output_schema" });
			}
			child.output_schema = Some(schema.clone());
		},
	}
	if let Some(mode) = field("schema_mode") {
		child.schema_mode = Some(match mode.as_str() {
			Some("strict") => SchemaMode::Strict,
			Some("permissive") => SchemaMode::Permissive,
			_ => return Err(SpawnError::MalformedTransform { field: "schema_mode" }),
		});
	}
	Ok(child)
}

/// Host-owned inputs for one child run.
pub struct SpawnRequest<'a> {
	/// Data root used by production composition and artifact storage.
	pub data_dir:     &'a Path,
	/// Parent project root (or its isolated whole-workspace view).
	pub project_root: &'a Path,
	/// Directory in which the child's `.oms` is created.
	pub sessions_dir: &'a Path,
	/// Shared live-session routing authority.
	pub sessions:     &'a Arc<crate::sessions::SessionRegistry>,
	/// Parent's effective convar context at spawn time.
	pub parent_ctx:   &'a Ctx,
	/// User/project cfg loader.
	pub cfg:          &'a dyn CfgLoader,
	/// Runtime index paired with the parent DOM.
	pub jobs:         &'a JobBoard,
	/// Environment authority used for isolated workspace views.
	pub env:          &'a EnvClient,
	/// Kill boundary for this child.
	pub cancel:       BackgroundToolCancellation,
	/// Parent job owner identity.
	pub owner:        &'a str,
	/// Shared batch context prepended to the child assignment.
	pub context:      &'a str,
	/// Requested model selector.
	pub model:        &'a str,
	/// Typed child request.
	pub child:        ChildRequest,
}

/// Journals a `<subagent>`, runs one independently configured child kernel,
/// then settles the parent element and returns the ordinary task payload row.
pub async fn spawn_child(
	parent: &mut Session,
	request: SpawnRequest<'_>,
) -> Result<ChildResult, SpawnError> {
	let jobs = request.jobs;
	let prepared = prepare_child(parent, request)?;
	let handle = prepared.handle;
	let id = prepared.id.clone();
	let factory = move |cancel| spawn_child_task(prepared.clone(), cancel);
	if !jobs.attach_restartable(parent.dom(), handle, factory) {
		return Err(SpawnError::MissingJobs);
	}
	let record = jobs
		.wait(parent, Some(std::slice::from_ref(&id)))
		.await?
		.ok_or_else(|| SpawnError::Workspace {
			message: Str::new_static("subagent job disappeared before settlement"),
		})?;
	if let Some(output) = record
		.output
		.as_deref()
		.map(|output| omp_agent::resolve_output(parent, output))
		.transpose()?
		.flatten()
	{
		return serde_json::from_str(output.get())
			.map_err(|source| SpawnError::Workspace { message: Str::new(source.to_string()) });
	}
	Err(SpawnError::Workspace {
		message: record
			.error
			.unwrap_or_else(|| Str::new_static("subagent job settled without output")),
	})
}

#[derive(Clone)]
struct PreparedChild {
	data_dir:     PathBuf,
	project_root: PathBuf,
	sessions_dir: PathBuf,
	sessions:     Arc<crate::sessions::SessionRegistry>,
	env:          EnvClient,
	ctx:          Arc<Ctx>,
	settings:     TaskSettings,
	cancel:       BackgroundToolCancellation,
	context:      Str,
	child:        ChildRequest,
	parent:       Str,
	id:           Str,
	agent:        Str,
	session_path: PathBuf,
	handle:       omp_dom::Handle,
	/// Parent-derived initial runtime gate; the child journals its own copy.
	paused:       bool,
}

struct ChildExecution {
	status: Str,
	result: ChildResult,
}

fn admit_batch(
	parent_ctx: &Ctx,
	jobs: &JobBoard,
	children: &[ChildRequest],
) -> Result<(), SpawnError> {
	let settings = TaskSettings::from_con(parent_ctx);
	let depth = SV_TASK_RECURSION_DEPTH.get(parent_ctx);
	if settings.at_recursion_limit(depth) {
		return Err(SpawnError::RecursionDepth {
			depth,
			maximum: i32::from(settings.max_recursion_depth),
		});
	}
	if let Some(agent) = children.iter().find_map(|child| {
		let agent = child.agent.as_deref().unwrap_or("task");
		settings
			.disabled_agents
			.iter()
			.any(|disabled| disabled.as_str().eq_ignore_ascii_case(agent))
			.then(|| Str::new(agent))
	}) {
		return Err(SpawnError::DisabledAgent { agent });
	}
	let active = jobs
		.list()
		.into_iter()
		.filter(|job| {
			job.kind == omp_agent::JobKind::Subagent
				&& matches!(job.status.as_str(), "starting" | "running")
		})
		.count();
	if settings.max_concurrency != 0
		&& active.saturating_add(children.len()) > settings.max_concurrency
	{
		return Err(SpawnError::Concurrency { maximum: settings.max_concurrency });
	}
	Ok(())
}

fn prepare_child(
	parent: &mut Session,
	request: SpawnRequest<'_>,
) -> Result<PreparedChild, SpawnError> {
	let parent_settings = TaskSettings::from_con(request.parent_ctx);
	let parent_depth = SV_TASK_RECURSION_DEPTH.get(request.parent_ctx);
	if parent_settings.at_recursion_limit(parent_depth) {
		return Err(SpawnError::RecursionDepth {
			depth:   parent_depth,
			maximum: i32::from(parent_settings.max_recursion_depth),
		});
	}
	let agent = request
		.child
		.agent
		.clone()
		.unwrap_or_else(|| Str::new_static("task"));
	if parent_settings
		.disabled_agents
		.iter()
		.any(|disabled| disabled.as_str().eq_ignore_ascii_case(agent.as_str()))
	{
		return Err(SpawnError::DisabledAgent { agent });
	}
	let active = request
		.jobs
		.list()
		.into_iter()
		.filter(|job| {
			job.kind == omp_agent::JobKind::Subagent
				&& matches!(job.status.as_str(), "starting" | "running")
		})
		.count();
	if parent_settings.max_concurrency != 0 && active >= parent_settings.max_concurrency {
		return Err(SpawnError::Concurrency { maximum: parent_settings.max_concurrency });
	}
	let requested_id = request
		.child
		.name
		.clone()
		.unwrap_or_else(|| Str::new(Ulid::generate().to_string()));
	let id = allocate_id(parent, normalize_id(requested_id));
	let session_path = child_session_path(request.sessions_dir, &id);
	let ctx = Arc::new(child_ctx(request.parent_ctx, request.cfg, agent.as_str())?);
	SV_TASK_RECURSION_DEPTH
		.set(&ctx, parent_depth.saturating_add(1))
		.map_err(SpawnError::Con)?;
	let settings = TaskSettings::from_con(&ctx);
	configure_child_route(&ctx, &settings, agent.as_str(), request.child.effort)?;
	if omp_agent::AI_MODEL.get(&ctx).is_empty() {
		omp_agent::AI_MODEL
			.set(&ctx, Str::new(request.model))
			.map_err(SpawnError::Con)?;
	}
	let started = SystemTime::now()
		.duration_since(UNIX_EPOCH)?
		.as_millis()
		.to_string();
	let paused = omp_agent::pause_state(parent.dom()).active;
	let cause = parent.head().ok_or(SpawnError::MissingParentHead)?;
	let txn = jobs::insert(parent.dom(), cause, JobSpec {
		id:      id.clone(),
		kind:    Str::new_static("subagent"),
		owner:   Str::new(request.owner),
		started: Str::new(started),
		agent:   Some(agent.clone()),
	})
	.ok_or(SpawnError::MissingJobs)?;
	parent.patch(txn)?;
	let handle = parent
		.dom()
		.select(&format!("jobs subagent[id={id}]"))
		.ok()
		.and_then(|mut values| values.next())
		.ok_or(SpawnError::MissingJobs)?;
	Ok(PreparedChild {
		data_dir: request.data_dir.to_path_buf(),
		project_root: request.project_root.to_path_buf(),
		sessions_dir: request.sessions_dir.to_path_buf(),
		sessions: Arc::clone(request.sessions),
		env: request.env.clone(),
		ctx,
		settings,
		cancel: request.cancel,
		context: Str::new(request.context),
		child: request.child,
		parent: Str::new(request.owner),
		id,
		agent,
		session_path,
		handle,
		paused,
	})
}

fn spawn_child_task(
	mut prepared: PreparedChild,
	cancel: CancellationToken,
) -> tokio::task::JoinHandle<JobSettlement> {
	prepared.cancel = BackgroundToolCancellation::from_token_for_host(cancel);
	tokio::spawn(async move {
		match run_child(prepared).await {
			Ok(execution) => JobSettlement {
				status:     execution.status,
				error:      execution.result.error.clone(),
				output:     serde_json::value::to_raw_value(&execution.result).ok(),
				completion: None,
			},
			Err(source) => JobSettlement {
				status:     Str::new_static("failed"),
				output:     None,
				error:      Some(Str::new(source.to_string())),
				completion: None,
			},
		}
	})
}

async fn run_child(prepared: PreparedChild) -> Result<ChildExecution, SpawnError> {
	let selected_model = omp_agent::AI_MODEL.get(&prepared.ctx);
	// Every composed child receives mutation-capable tools, so ADR 0007
	// requires isolation even when a caller attempts to opt out.
	let isolation = Some(create_isolation(&prepared.env, &prepared.id).await?);
	let run_root = isolation
		.as_ref()
		.map_or_else(|| prepared.project_root.clone(), |isolation| isolation.root.clone());
	let run = async {
		let options = KernelOptions {
			session: Some(prepared.session_path.clone()),
			sessions_dir: Some(prepared.sessions_dir.clone()),
			sessions: Some(Arc::clone(&prepared.sessions)),
			session_name: prepared
				.child
				.name
				.clone()
				.or_else(|| Some(prepared.id.clone())),
			parent_session: Some(prepared.parent.clone()),
			model_override: true,
			output_schema: prepared.child.output_schema.clone(),
			schema_mode: prepared.child.schema_mode,
			..KernelOptions::default()
		};
		let (mut kernel, mut child_session, _) = compose_kernel(
			&prepared.data_dir,
			&run_root,
			selected_model.as_str(),
			Arc::clone(&prepared.ctx),
			options,
		)
		.await?;
		engage_yield_ladder(&prepared.child, &mut child_session)?;
		if prepared.paused {
			omp_agent::set_paused(&mut child_session, true)?;
		}
		let deadline = (prepared.settings.max_runtime_ms != 0).then(|| {
			std::time::Instant::now() + Duration::from_millis(prepared.settings.max_runtime_ms)
		});
		let mut prompt = format!("{}\n\n{}", prepared.context, prepared.child.task);
		if let Some(schema) = prepared.child.output_schema.as_ref() {
			prompt.push_str("\n\n");
			prompt.push_str(&crate::prompt_templates::schema::render(schema));
		}
		let turn = kernel
			.run_turn(
				&mut child_session,
				TurnInput { text: Str::new(prompt), attachments: Vec::new() },
				RunControl::new(prepared.cancel.token(), deadline)
					.with_request_budget(prepared.settings.soft_request_budget)
					.with_request_budget_notice(prepared.settings.soft_request_budget_notice),
			)
			.await?;
		Ok::<_, SpawnError>((turn, child_session))
	}
	.await;
	schedule_idle_park(
		Arc::clone(&prepared.sessions),
		crate::sessions::SessionId::new(prepared.id.clone()),
		prepared.settings.agent_idle_ttl_ms,
	);
	let (turn, child_session) = match run {
		Ok(run) => run,
		Err(source) => {
			if let Some(isolation) = &isolation {
				let _ = destroy_isolation(&prepared.env, isolation.id.as_str()).await;
			}
			return Err(source);
		},
	};
	let (output, schema_error) =
		structured_output(&prepared.child, &child_session, turn.assistant_text.as_str());
	let cancelled =
		(turn.stop == TurnStop::Cancelled).then(|| Str::new_static("subagent was cancelled"));
	let error = cancelled.or(schema_error);
	let workspace = match isolation {
		Some(isolation) if error.is_some() => {
			Some(discard_isolation(&prepared.env, isolation).await?)
		},
		Some(isolation) => {
			Some(finish_isolation(&prepared.env, isolation, &prepared.settings).await?)
		},
		None => None,
	};
	let status = child_status(turn.stop, error.as_ref());
	Ok(ChildExecution {
		status,
		result: ChildResult {
			id: prepared.id,
			agent: prepared.agent,
			text: turn.assistant_text,
			description: None,
			assignment: Some(prepared.child.task.clone()),
			stats: None,
			session_path: Str::new(prepared.session_path.to_string_lossy()),
			tokens_in: turn.tokens_in,
			tokens_out: turn.tokens_out,
			output,
			workspace,
			error,
		},
	})
}

pub(crate) struct IsolationRun {
	pub(crate) id:   Str,
	pub(crate) root: PathBuf,
}

pub(crate) async fn create_isolation(
	env: &EnvClient,
	id: &Str,
) -> Result<IsolationRun, SpawnError> {
	let result = env
		.create_worktree(CreateWorktree {
			name:      format!("subagent-{id}"),
			base:      None,
			paths:     Vec::new(),
			owner_pid: std::process::id(),
			props:     None,
		})
		.await?;
	let worktree = result.worktree.ok_or_else(|| SpawnError::Workspace {
		message: Str::new_static("create omitted worktree metadata"),
	})?;
	let url = url::Url::parse(&worktree.root_uri).map_err(|_| SpawnError::Workspace {
		message: Str::new_static("worktree root is not a URL"),
	})?;
	let root = url.to_file_path().map_err(|()| SpawnError::Workspace {
		message: Str::new_static("worktree root is not a local filesystem URL"),
	})?;
	Ok(IsolationRun { id: Str::new(worktree.id), root })
}

pub(crate) async fn finish_isolation(
	env: &EnvClient,
	isolation: IsolationRun,
	settings: &TaskSettings,
) -> Result<WorkspaceOutcome, SpawnError> {
	let mode = match settings.isolation.merge {
		TaskIsolationMerge::Patch => MergeMode::Patch,
		TaskIsolationMerge::Branch => MergeMode::Branch,
	};
	let result = env
		.merge_worktree(MergeWorktree {
			id:      isolation.id.to_string(),
			dry_run: !settings.isolation.apply,
			mode:    mode as i32,
			props:   None,
		})
		.await?;
	let patch = (!result.artifact_hash.is_empty()).then(|| {
		let digest = result
			.artifact_hash
			.iter()
			.map(|byte| format!("{byte:02x}"))
			.collect::<String>();
		Str::new(format!("artifact://sha256/{digest}"))
	});
	let conflicts = result
		.conflicts
		.into_iter()
		.map(|conflict| Str::new(conflict.path))
		.collect::<Vec<_>>();
	let applied = settings.isolation.apply
		&& settings.isolation.merge == TaskIsolationMerge::Patch
		&& conflicts.is_empty();
	let branch = result.branch.map(Str::new);
	if settings.isolation.merge == TaskIsolationMerge::Patch {
		destroy_isolation(env, isolation.id.as_str()).await?;
	}
	Ok(WorkspaceOutcome { worktree: isolation.id, patch, branch, applied, conflicts })
}

pub(crate) async fn discard_isolation(
	env: &EnvClient,
	isolation: IsolationRun,
) -> Result<WorkspaceOutcome, SpawnError> {
	destroy_isolation(env, isolation.id.as_str()).await?;
	Ok(WorkspaceOutcome {
		worktree:  isolation.id,
		patch:     None,
		branch:    None,
		applied:   false,
		conflicts: Vec::new(),
	})
}

async fn destroy_isolation(env: &EnvClient, id: &str) -> Result<(), SpawnError> {
	env.destroy_worktree(DestroyWorktree { id: id.to_owned(), force: true, props: None })
		.await?;
	Ok(())
}

pub(crate) fn configure_child_route(
	ctx: &Ctx,
	settings: &TaskSettings,
	agent: &str,
	effort: Option<TaskEffort>,
) -> Result<(), SpawnError> {
	if let Some(effort) = effort {
		let thinking = match effort {
			TaskEffort::Lo => "low",
			TaskEffort::Med => "medium",
			TaskEffort::Hi => "high",
		};
		omp_agent::AI_THINKING
			.set(ctx, Str::new_static(thinking))
			.map_err(SpawnError::Con)?;
	}
	clamp_effort(ctx, settings.max_effort)?;
	if let Some(model) = settings
		.agent_model_overrides
		.iter()
		.find(|(name, _)| name.as_str().eq_ignore_ascii_case(agent))
		.map(|(_, model)| model.clone())
	{
		omp_agent::AI_MODEL
			.set(ctx, model)
			.map_err(SpawnError::Con)?;
	} else {
		let task_model = omp_agent::AI_TASK_MODEL.get(ctx);
		if !task_model.is_empty() {
			omp_agent::AI_MODEL
				.set(ctx, task_model)
				.map_err(SpawnError::Con)?;
		}
	}
	Ok(())
}

fn child_status(stop: TurnStop, error: Option<&Str>) -> Str {
	if stop == TurnStop::Cancelled {
		Str::new_static("cancelled")
	} else if error.is_some() {
		Str::new_static("failed")
	} else {
		Str::new_static("completed")
	}
}

fn clamp_effort(ctx: &Ctx, ceiling: TaskEffortCeiling) -> Result<(), SpawnError> {
	let current = omp_agent::AI_THINKING.get(ctx);
	let rank = |value: &str| match value {
		"off" => 0,
		"minimal" => 1,
		"low" => 2,
		"medium" => 3,
		"high" => 4,
		"xhigh" => 5,
		"max" => 6,
		_ => 4,
	};
	let maximum: &'static str = ceiling.into();
	if rank(current.as_str()) > rank(maximum) {
		omp_agent::AI_THINKING
			.set(ctx, Str::new_static(maximum))
			.map_err(SpawnError::Con)?;
	}
	Ok(())
}

/// Engages the yield ladder on a schema-bound child before its first turn: a
/// deferred `ForceTool("yield")` leaves the working requests unforced and,
/// once the child stops idle without finalizing, reminds it
/// [`MAX_YIELD_RETRIES`] times (the last rung natively forced) before the
/// Director fails and the run is classified as a missing yield.
fn engage_yield_ladder(request: &ChildRequest, session: &mut Session) -> Result<(), SpawnError> {
	if request.output_schema.is_none() {
		return Ok(());
	}
	let mut directors = DirectorStack::from_dom(session.dom(), &DirectorRegistry::standard());
	directors.engage(
		session,
		Box::new(
			ForceTool::new(
				"yield",
				ForceUntil::ToolCalled(Str::new_static("yield")),
				Some(Str::new_static(YIELD_REMINDER)),
				MAX_YIELD_RETRIES,
			)
			.deferred(),
		),
	)?;
	Ok(())
}

/// Engages the same bounded yield ladder for a workpool batch, but keeps the
/// Director active until the batch-local yield payload reports every item
/// complete (or one item failed).
pub(super) fn engage_workpool_yield_ladder(session: &mut Session) -> Result<(), SpawnError> {
	let mut directors = DirectorStack::from_dom(session.dom(), &DirectorRegistry::standard());
	directors.engage(
		session,
		Box::new(
			ForceTool::new(
				"yield",
				ForceUntil::TerminalYield,
				Some(Str::new_static(YIELD_REMINDER)),
				MAX_YIELD_RETRIES,
			)
			.deferred(),
		),
	)?;
	Ok(())
}

fn structured_output(
	request: &ChildRequest,
	session: &Session,
	last_turn: &str,
) -> (Option<StructuredOutput>, Option<Str>) {
	let Some(raw_schema) = request.output_schema.as_ref() else {
		return (None, terminal_yield_error(session));
	};
	let mode = request.schema_mode.unwrap_or_default();
	let schema = match output_schema::normalize(raw_schema) {
		Ok(Some(schema)) => schema,
		Ok(None) => return (None, terminal_yield_error(session)),
		Err(error) => {
			let error = Str::new(error.to_string());
			return (
				Some(StructuredOutput {
					mode,
					status: OutputStatus::Unavailable,
					data: None,
					error: Some(error.clone()),
				}),
				(mode == SchemaMode::Strict).then_some(error),
			);
		},
	};
	let (data, explicit_error) = yield_assembly::assemble(
		&yield_assembly::settled_yields(session),
		last_turn,
		&yield_assembly::array_valued_labels(&schema),
	)
	.into_parts();
	if let Some(error) = explicit_error {
		let failure = Str::new(error);
		return (
			Some(StructuredOutput {
				mode,
				status: OutputStatus::Invalid,
				data,
				error: Some(failure.clone()),
			}),
			(mode == SchemaMode::Strict).then_some(failure),
		);
	}
	let Some(data) = data else {
		let failure = Str::new_static(WARNING_MISSING_YIELD);
		return (
			Some(StructuredOutput {
				mode,
				status: OutputStatus::Invalid,
				data: None,
				error: Some(failure.clone()),
			}),
			(mode == SchemaMode::Strict).then_some(failure),
		);
	};
	match output_schema::validate(&schema, &data) {
		Ok(Ok(())) => (
			Some(StructuredOutput {
				mode,
				status: OutputStatus::Valid,
				data: Some(data),
				error: None,
			}),
			None,
		),
		Ok(Err(violation)) => {
			let error = Str::new(violation.to_string());
			(
				Some(StructuredOutput {
					mode,
					status: OutputStatus::Invalid,
					data: Some(data),
					error: Some(error.clone()),
				}),
				(mode == SchemaMode::Strict).then_some(error),
			)
		},
		Err(source) => {
			let error = Str::new(source.to_string());
			(
				Some(StructuredOutput {
					mode,
					status: OutputStatus::Unavailable,
					data: Some(data),
					error: Some(error.clone()),
				}),
				(mode == SchemaMode::Strict).then_some(error),
			)
		},
	}
}

/// The child's explicit failure when no output schema is installed.
fn terminal_yield_error(session: &Session) -> Option<Str> {
	let (_, error) =
		yield_assembly::assemble(&yield_assembly::settled_yields(session), "", &[]).into_parts();
	error.map(Str::new)
}

pub(crate) fn idle_park_delay(ttl_ms: u64) -> Option<Duration> {
	(ttl_ms != 0).then(|| Duration::from_millis(ttl_ms))
}

/// Parks the registration after `ttl_ms` unless a later revival re-registered
/// the same id with a different mailbox: the timer only evicts the run it was
/// scheduled for.
fn schedule_idle_park(
	sessions: Arc<crate::sessions::SessionRegistry>,
	id: crate::sessions::SessionId,
	ttl_ms: u64,
) {
	let Some(delay) = idle_park_delay(ttl_ms) else {
		return;
	};
	let Some(current) = sessions.lookup(&id) else {
		return;
	};
	tokio::spawn(async move {
		tokio::time::sleep(delay).await;
		if sessions
			.lookup(&id)
			.is_some_and(|live| live.up.same_channel(&current.up))
		{
			sessions.remove(&id);
		}
	});
}

fn normalize_id(requested: Str) -> Str {
	let value = requested
		.as_str()
		.chars()
		.filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
		.take(32)
		.collect::<String>();
	if value.is_empty() {
		Str::new(Ulid::generate().to_string())
	} else {
		Str::new(value)
	}
}

fn allocate_id(parent: &Session, requested: Str) -> Str {
	let Some(jobs) = jobs::jobs_handle(parent.dom()) else {
		return requested;
	};
	let exists = |candidate: &str| {
		parent.dom().children(jobs).iter().any(|handle| {
			parent
				.dom()
				.get(*handle)
				.and_then(|node| node.prop(&PropKey::from(PropId::Id)))
				.and_then(Value::as_str)
				.is_some_and(|id| id == candidate)
		})
	};
	if !exists(requested.as_str()) {
		return requested;
	}
	for suffix in 2_u32.. {
		let candidate = Str::new(format!("{requested}-{suffix}"));
		if !exists(candidate.as_str()) {
			return candidate;
		}
	}
	unreachable!("u32 job-name suffix space exhausted")
}

pub(crate) fn child_session_path(sessions_dir: &Path, id: &Str) -> PathBuf {
	let safe = id
		.as_str()
		.chars()
		.map(|ch| {
			if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
				ch
			} else {
				'_'
			}
		})
		.collect::<String>();
	sessions_dir.join(format!("{safe}.oms"))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn request_with_schema(mode: SchemaMode) -> ChildRequest {
		ChildRequest {
			task:          Str::new_static("return an object"),
			name:          None,
			agent:         None,
			effort:        None,
			output_schema: Some(serde_json::json!({
				"type": "object",
				"required": ["ok"],
				"properties": {"ok": {"type": "boolean"}},
			})),
			schema_mode:   Some(mode),
			isolated:      None,
		}
	}

	#[test]
	fn batch_admission_rejects_disabled_agents_before_spawning_any_child() {
		let ctx = Ctx::new();
		super::super::settings::SV_TASK_DISABLED_AGENTS
			.set(&ctx, vec![Str::new_static("review")])
			.expect("disabled agents");
		let children = vec![ChildRequest {
			task:          Str::new_static("work"),
			name:          None,
			agent:         Some(Str::new_static("Review")),
			effort:        None,
			output_schema: None,
			schema_mode:   None,
			isolated:      None,
		}];
		assert!(matches!(
			admit_batch(&ctx, &JobBoard::new(), &children),
			Err(SpawnError::DisabledAgent { .. })
		));
	}

	#[test]
	fn batch_admission_enforces_the_whole_concurrency_request_atomically() {
		let ctx = Ctx::new();
		super::super::settings::SV_TASK_MAX_CONCURRENCY
			.set(&ctx, 1)
			.expect("concurrency");
		let child = ChildRequest {
			task:          Str::new_static("work"),
			name:          None,
			agent:         None,
			effort:        None,
			output_schema: None,
			schema_mode:   None,
			isolated:      None,
		};
		assert!(matches!(
			admit_batch(&ctx, &JobBoard::new(), &[child.clone(), child]),
			Err(SpawnError::Concurrency { maximum: 1 })
		));
	}

	struct SpawnGate {
		hooks:     LifecycleHooks,
		seen:      Arc<parking_lot::Mutex<Vec<serde_json::Value>>>,
		responder: tokio::task::JoinHandle<()>,
	}

	impl Drop for SpawnGate {
		fn drop(&mut self) {
			self.responder.abort();
		}
	}

	fn spawn_gate(
		phase: omp_agent::HookPhase,
		decide: impl Fn(&serde_json::Value) -> omp_agent::GateDecision + Send + 'static,
	) -> SpawnGate {
		let (gate, receiver) = omp_agent::HookGate::channel();
		let gate = Arc::new(gate);
		gate
			.subscribe("test", [omp_agent::hooks::Subscription {
				host: Str::new_static("test"),
				source: omp_agent::SourceRef {
					layer:        0,
					publisher:    Str::new_static("test"),
					extension_id: Str::new_static("spawn"),
				},
				id: 1,
				event: HookEventId::HookEventSubagentSpawn,
				phase,
				order: 0,
				on_failure: omp_agent::OnFailure::Deny,
				when: omp_agent::When::default(),
			}])
			.expect("subscription");
		let seen = Arc::new(parking_lot::Mutex::new(Vec::new()));
		let responder = {
			let gate = Arc::clone(&gate);
			let seen = Arc::clone(&seen);
			tokio::spawn(async move {
				while let Ok(dispatch) = receiver.recv_async().await {
					let separator = dispatch
						.payload
						.iter()
						.position(|byte| *byte == b'\n')
						.map_or(0, |at| at + 1);
					let payload: serde_json::Value =
						serde_json::from_slice(&dispatch.payload[separator..]).expect("spec payload");
					seen.lock().push(payload.clone());
					gate
						.answer(dispatch.dispatch_id, vec![(1, decide(&payload))])
						.expect("answer");
				}
			})
		};
		SpawnGate { hooks: LifecycleHooks::new(gate), seen, responder }
	}

	fn plain_child() -> ChildRequest {
		ChildRequest {
			task:          Str::new_static("summarize the repo"),
			name:          Some(Str::new_static("Summarizer")),
			agent:         Some(Str::new_static("scout")),
			effort:        Some(TaskEffort::Lo),
			output_schema: None,
			schema_mode:   None,
			isolated:      None,
		}
	}

	#[tokio::test]
	async fn subagent_spawn_allow_keeps_the_request_and_exposes_the_spec() {
		let gate = spawn_gate(omp_agent::HookPhase::Review, |_| omp_agent::GateDecision::Allow);
		let ctx = Ctx::new();
		let admitted = admit_child(Some(&gate.hooks), &ctx, plain_child(), "anthropic/claude")
			.await
			.expect("allowed spawn");
		assert_eq!(admitted, plain_child());
		let seen = gate.seen.lock().clone();
		let spec = &seen[0];
		assert_eq!(spec["task"], "summarize the repo");
		assert_eq!(spec["name"], "Summarizer");
		assert_eq!(spec["agent"], "scout");
		assert_eq!(spec["thinking"], "lo");
		assert_eq!(spec["model"], "anthropic/claude");
		assert_eq!(spec["schema_mode"], "permissive");
		for key in ["isolation", "worktree", "merge", "max_depth", "budget", "labels"] {
			assert!(spec.get(key).is_some(), "SubagentSpec field {key} missing");
		}
		let ungated = admit_child(None, &ctx, plain_child(), "m")
			.await
			.expect("no gate");
		assert_eq!(ungated, plain_child());
	}

	#[tokio::test]
	async fn subagent_spawn_deny_is_a_typed_spawn_failure() {
		let gate = spawn_gate(omp_agent::HookPhase::Precheck, |_| {
			omp_agent::GateDecision::Deny(Str::new_static("no scouts today"))
		});
		let ctx = Ctx::new();
		let error = admit_child(Some(&gate.hooks), &ctx, plain_child(), "m")
			.await
			.expect_err("denied spawn");
		assert!(
			matches!(&error, SpawnError::Denied { reason } if reason.as_str() == "no scouts today")
		);
		assert_eq!(error.to_string(), "subagent spawn denied by extension: no scouts today");
	}

	#[tokio::test]
	async fn subagent_spawn_transform_rewrites_the_request_and_rejects_malformed_fields() {
		let gate = spawn_gate(omp_agent::HookPhase::Transform, |spec| {
			let mut effective = spec.clone();
			effective["task"] = "summarize only src/".into();
			effective["name"] = "Scout2".into();
			effective["agent"] = "task".into();
			effective["thinking"] = "hi".into();
			effective["worktree"] = true.into();
			effective["output_schema"] = serde_json::json!({"type": "object"});
			effective["schema_mode"] = "strict".into();
			omp_agent::GateDecision::Modify(omp_agent::HookPatch {
				target: None,
				args:   Some(bytes::Bytes::from(serde_json::to_vec(&effective).expect("patch"))),
			})
		});
		let ctx = Ctx::new();
		let admitted = admit_child(Some(&gate.hooks), &ctx, plain_child(), "m")
			.await
			.expect("transformed spawn");
		assert_eq!(admitted, ChildRequest {
			task:          Str::new_static("summarize only src/"),
			name:          Some(Str::new_static("Scout2")),
			agent:         Some(Str::new_static("task")),
			effort:        Some(TaskEffort::Hi),
			output_schema: Some(serde_json::json!({"type": "object"})),
			schema_mode:   Some(SchemaMode::Strict),
			isolated:      Some(true),
		});
		drop(gate);

		let gate = spawn_gate(omp_agent::HookPhase::Transform, |spec| {
			let mut effective = spec.clone();
			effective["name"] = "9lives".into();
			omp_agent::GateDecision::Modify(omp_agent::HookPatch {
				target: None,
				args:   Some(bytes::Bytes::from(serde_json::to_vec(&effective).expect("patch"))),
			})
		});
		let error = admit_child(Some(&gate.hooks), &ctx, plain_child(), "m")
			.await
			.expect_err("malformed name");
		assert!(matches!(error, SpawnError::MalformedTransform { field: "name" }));
	}

	#[test]
	fn schema_bound_child_engages_force_yield_director() {
		let temp = tempfile::tempdir().expect("temporary directory");
		let mut session =
			Session::create(temp.path().join("child.oms"), omp_session::ComponentRegistry::standard())
				.expect("child session");
		engage_yield_ladder(&request_with_schema(SchemaMode::Strict), &mut session)
			.expect("engage yield ladder");
		let (_, node) = omp_agent::find_director(session.dom(), "force_tool")
			.expect("force-tool director is active before the first turn");
		assert_eq!(omp_agent::state_str(node, "tool").as_deref(), Some("yield"));
		assert_eq!(omp_agent::state_str(node, "until").as_deref(), Some("yield"));
		assert_eq!(omp_agent::state_bool(node, "deferred"), Some(true));
		assert_eq!(omp_agent::state_int(node, "retries"), Some(i64::from(MAX_YIELD_RETRIES)));
		assert_eq!(omp_agent::state_str(node, "reminder").as_deref(), Some(YIELD_REMINDER));
		assert_eq!(
			DirectorStack::from_dom(session.dom(), &DirectorRegistry::standard()).active_ids(),
			vec!["force_tool"]
		);
	}

	#[test]
	fn unbound_child_engages_no_yield_director() {
		let temp = tempfile::tempdir().expect("temporary directory");
		let mut session =
			Session::create(temp.path().join("child.oms"), omp_session::ComponentRegistry::standard())
				.expect("child session");
		let request = ChildRequest { output_schema: None, ..request_with_schema(SchemaMode::Strict) };
		engage_yield_ladder(&request, &mut session).expect("no-op engagement");
		assert!(omp_agent::find_director(session.dom(), "force_tool").is_none());
	}

	#[test]
	fn strict_schema_turn_without_yield_is_a_failed_child() {
		let temp = tempfile::tempdir().expect("temporary directory");
		let session =
			Session::create(temp.path().join("child.oms"), omp_session::ComponentRegistry::standard())
				.expect("child session");
		let (output, error) =
			structured_output(&request_with_schema(SchemaMode::Strict), &session, "plain text");
		assert_eq!(output.expect("schema verdict").status, OutputStatus::Invalid);
		assert!(error.is_some());
	}

	fn settle_yield(session: &mut Session, call_id: &'static str, args: serde_json::Value) {
		let args = serde_json::value::to_raw_value(&args).expect("yield args");
		let call = session
			.call("yield", 2, Str::new_static(call_id), None, Some(args), None)
			.expect("yield call");
		let outcome = serde_json::value::to_raw_value(&serde_json::json!({
			"incremental": true,
			"use_last_turn": false,
			"validation": null,
		}))
		.expect("yield outcome");
		session.settle(call, outcome).expect("yield settles");
	}

	#[test]
	fn incremental_section_yields_assemble_into_the_terminal_result() {
		let temp = tempfile::tempdir().expect("temporary directory");
		let mut session =
			Session::create(temp.path().join("child.oms"), omp_session::ComponentRegistry::standard())
				.expect("child session");
		session.begin_turn().expect("turn");
		session.user("review", Vec::new()).expect("prompt");
		settle_yield(
			&mut session,
			"y1",
			serde_json::json!({"type": ["findings"], "result": {"data": {"title": "first"}}}),
		);
		settle_yield(
			&mut session,
			"y2",
			serde_json::json!({"type": ["findings"], "result": {"data": {"title": "second"}}}),
		);
		settle_yield(&mut session, "y3", serde_json::json!({"type": "result", "result": {}}));
		let request = ChildRequest {
			output_schema: Some(serde_json::json!({
				"type": "object",
				"required": ["findings"],
				"properties": {
					"findings": {
						"type": "array",
						"items": {"type": "object", "required": ["title"]},
					},
				},
			})),
			..request_with_schema(SchemaMode::Strict)
		};
		let (output, error) = structured_output(&request, &session, "done");
		assert_eq!(error, None);
		let output = output.expect("schema verdict");
		assert_eq!(output.status, OutputStatus::Valid);
		assert_eq!(
			output.data,
			Some(serde_json::json!({"findings": [{"title": "first"}, {"title": "second"}]}))
		);
	}

	#[test]
	fn permissive_schema_turn_keeps_invalid_verdict_without_failing_child() {
		let temp = tempfile::tempdir().expect("temporary directory");
		let session =
			Session::create(temp.path().join("child.oms"), omp_session::ComponentRegistry::standard())
				.expect("child session");
		let (output, error) =
			structured_output(&request_with_schema(SchemaMode::Permissive), &session, "plain text");
		assert_eq!(output.expect("schema verdict").status, OutputStatus::Invalid);
		assert!(error.is_none());
	}

	#[test]
	fn agent_model_override_wins_over_task_model_and_effort_is_clamped() {
		let ctx = Ctx::new();
		omp_agent::AI_TASK_MODEL
			.set(&ctx, Str::new_static("task/model"))
			.expect("task model");
		omp_agent::AI_THINKING
			.set(&ctx, Str::new_static("xhigh"))
			.expect("thinking");
		let mut settings =
			TaskSettings { max_effort: TaskEffortCeiling::Low, ..TaskSettings::default() };
		settings
			.agent_model_overrides
			.insert(Str::new_static("Review"), Str::new_static("agent/model"));
		configure_child_route(&ctx, &settings, "review", Some(TaskEffort::Hi)).expect("child route");
		assert_eq!(omp_agent::AI_MODEL.get(&ctx).as_str(), "agent/model");
		assert_eq!(omp_agent::AI_THINKING.get(&ctx).as_str(), "low");
	}

	#[tokio::test]
	async fn idle_ttl_zero_keeps_child_live_and_nonzero_reaps_after_boundary() {
		let temp = tempfile::tempdir().expect("tempdir");
		let session =
			Session::create(temp.path().join("idle.oms"), omp_session::ComponentRegistry::standard())
				.expect("session");
		let registry = Arc::new(crate::sessions::SessionRegistry::new());
		let register = |id: &'static str| {
			let (up, _) = flume::unbounded();
			registry.register(Str::new_static(id), crate::sessions::KernelHandle {
				id:        crate::sessions::SessionId::new(Str::new_static(id)),
				name:      Str::new_static(id),
				up:        up.clone(),
				snapshot:  Arc::new(parking_lot::RwLock::new(session.dom().snapshot())),
				topology:  omp_agent::SessionTopology::main(Str::new_static(id)),
				relay:     crate::sessions::IrcRelayPolicy::default(),
				autoreply: None,
			});
		};
		register("kept");
		schedule_idle_park(
			Arc::clone(&registry),
			crate::sessions::SessionId::new(Str::new_static("kept")),
			0,
		);
		register("reaped");
		schedule_idle_park(
			Arc::clone(&registry),
			crate::sessions::SessionId::new(Str::new_static("reaped")),
			1,
		);
		tokio::time::sleep(Duration::from_millis(10)).await;
		assert!(
			registry
				.lookup(crate::sessions::SessionId::from_ref("kept"))
				.is_some()
		);
		assert!(
			registry
				.lookup(crate::sessions::SessionId::from_ref("reaped"))
				.is_none()
		);
		assert_eq!(idle_park_delay(420_000), Some(Duration::from_secs(420)));
	}

	#[test]
	fn cancelled_child_never_classifies_as_completed() {
		assert_eq!(child_status(TurnStop::Cancelled, None).as_str(), "cancelled");
		assert_eq!(
			child_status(TurnStop::Completed, Some(&Str::new_static("failure"))).as_str(),
			"failed"
		);
		assert_eq!(child_status(TurnStop::Completed, None).as_str(), "completed");
	}
}
