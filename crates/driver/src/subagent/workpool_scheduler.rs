//! Persistent workpool scheduling over the shared job primitive.
//!
//! The scheduler owns queueing and worker selection, while worker execution is
//! supplied by the driver composition that owns child kernels. Durable
//! aggregate settlement remains a [`JobBoard`] transaction; workpool IRC
//! notices are display-only projections emitted by the authenticated producer.

use std::{
	collections::VecDeque,
	sync::Arc,
	time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
pub use omp_agent::jobs::WORKPOOL_STATE;
use omp_agent::{JobBoard, JobSettlement};
use omp_core::{FastHashMap, Str, sf};
use omp_dom::{Handle, KnownTag, Op, PropId, PropKey, Tag, Txn, Value};
use omp_journal::blob::BlobStore;
use omp_session::{Session, components::jobs};
use omp_tools::eval::{
	EvalSessionControl, EvalToolControlError, EvalToolRegistration, EvalToolRoster,
};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value as Json, json, value::RawValue};
use thiserror::Error;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub use super::workpool_runtime::KernelWorkpoolLauncher;
use super::{
	spawn::SpawnError,
	workpool::{WorkpoolProducer, WorkpoolProducerError, WorkpoolReceipt, WorkpoolRegistry},
};

/// Reads the latest durable pool snapshot from a live or replayed session.
///
/// The payload is intentionally self-describing JSON so status, cards, and
/// recovery diagnostics never depend on the disposable scheduler actor.
/// Oversized snapshots are a bounded envelope naming their full session-CAS
/// artifact.
#[must_use]
pub fn replayed_state<'a>(session: &'a Session, id: &str) -> Option<&'a RawValue> {
	let handle = job_handle(session, id)?;
	let node = session.dom().get(handle)?;
	match node.prop(&PropKey::Custom(Str::new_static(WORKPOOL_STATE))) {
		Some(Value::Json(raw)) => Some(raw),
		_ => None,
	}
}

/// Typed request route into the kernel actor that exclusively owns the
/// authoritative session writer.
#[derive(Clone)]
pub struct SessionMutator {
	up: flume::Sender<omp_agent::Up>,
}

impl SessionMutator {
	/// Binds mutations to one exact kernel mailbox generation.
	#[must_use]
	pub fn new(up: flume::Sender<omp_agent::Up>) -> Self {
		Self { up }
	}

	pub(super) async fn mutate<R, F>(
		&self,
		cancel: &CancellationToken,
		apply: F,
	) -> Result<R, WorkpoolSchedulerError>
	where
		R: Send + 'static,
		F: FnOnce(&mut Session) -> Result<R, WorkpoolSchedulerError> + Send + 'static,
	{
		let (reply, receive) = flume::bounded(1);
		let request = omp_agent::SessionMutation::new(move |session| {
			let _ = reply.send(apply(session));
		});
		tokio::select! {
			biased;
			() = cancel.cancelled() => {
				return Err(WorkpoolSchedulerError::MutationCancelled);
			},
			result = self.up.send_async(omp_agent::Up::SessionMutation(request)) => {
				result.map_err(|_| WorkpoolSchedulerError::MutationDisconnected)?;
			},
		}
		tokio::select! {
			biased;
			() = cancel.cancelled() => Err(WorkpoolSchedulerError::MutationCancelled),
			result = receive.recv_async() => {
				result.map_err(|_| WorkpoolSchedulerError::MutationDisconnected)?
			},
		}
	}
}

/// Live scheduling policy. Reading the limit at each dispatch lets convar
/// changes take effect without replacing a pool.
pub trait WorkpoolPolicy: Send + Sync {
	/// Maximum concurrently live workers. Zero means unlimited.
	fn concurrency_limit(&self) -> usize;
	/// Whether every item receives a newly spawned worker.
	fn fresh_agents(&self) -> bool;
	/// Whether eval-defined handlers may cross into child registries.
	fn eval_tools_enabled(&self) -> bool;
}

/// Convar-backed production policy.
pub struct ConWorkpoolPolicy {
	ctx: Arc<omp_con::Ctx>,
}

impl ConWorkpoolPolicy {
	/// Binds scheduling decisions to a live parent convar context.
	#[must_use]
	pub fn new(ctx: Arc<omp_con::Ctx>) -> Self {
		Self { ctx }
	}
}

impl WorkpoolPolicy for ConWorkpoolPolicy {
	fn concurrency_limit(&self) -> usize {
		usize::try_from(super::settings::SV_TASK_MAX_CONCURRENCY.get(&self.ctx)).unwrap_or(usize::MAX)
	}

	fn fresh_agents(&self) -> bool {
		omp_tools::settings::SV_EVAL_WORKPOOL_FRESH_AGENTS.get(&self.ctx)
	}

	fn eval_tools_enabled(&self) -> bool {
		omp_tools::settings::SV_EVAL_TOOLS_ENABLED.get(&self.ctx)
	}
}

/// One batch sent to a persistent worker kernel.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerBatch {
	/// Stable batch identity.
	pub id:      Str,
	/// Ordered item identities and prompts.
	pub items:   Vec<(Str, Str)>,
	/// Optional context supplied when the pool was created.
	pub context: Option<Str>,
}

/// Driver-owned live worker returned after its child endpoint is registered.
pub struct WorkerHandle {
	/// Authenticated child-session id.
	pub id:       Str,
	/// Batch input for the persistent kernel.
	pub batches:  flume::Sender<WorkerBatch>,
	/// Kill boundary for the worker execution unit.
	pub cancel:   CancellationToken,
	/// Closes only after the worker's ordinary [`JobSettlement`] has been
	/// handed to the shared [`JobBoard`].
	pub finished: flume::Receiver<()>,
	/// Force boundary paired with the same task owned by [`JobBoard`].
	pub abort:    tokio::task::AbortHandle,
}

/// Terminal event for one worker turn or execution unit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkerEvent {
	/// One batch settled and the worker remains reusable when `alive` is true.
	Settled {
		/// Worker id.
		worker:         Str,
		/// Batch id.
		batch:          Str,
		/// Complete bounded-or-artifact-backed result projection.
		output:         Str,
		/// Whether the batch succeeded.
		success:        bool,
		/// Whether the worker endpoint remains live.
		alive:          bool,
		/// Current projected context usage.
		context_tokens: Option<u64>,
		/// Route context window when known.
		context_window: Option<u64>,
	},
	/// The execution unit died before settling its active batch.
	Dead {
		/// Worker id.
		worker: Str,
		/// Typed diagnostic retained in the failed batch.
		error:  Str,
	},
}

/// Production composition seam that starts persistent/revivable child kernels.
///
/// `spawn` returns only after the child is registered in the shared
/// [`omp_agent::SessionAuthority`], so authenticated workpool observations
/// cannot race worker admission. The launcher also inserts and attaches the
/// worker's `<subagent>` to the parent's [`JobBoard`]; the returned
/// cancellation token is that same execution unit's kill boundary, never a
/// second worker lifecycle.
#[async_trait]
pub trait WorkpoolLauncher: Send + Sync {
	/// Starts or revives one named worker and connects it to `events`.
	async fn spawn(
		&self,
		request: WorkerSpawn,
		events: flume::Sender<WorkerEvent>,
	) -> Result<WorkerHandle, WorkpoolSchedulerError>;
}

/// Immutable worker admission request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerSpawn {
	/// Owning session id.
	pub owner:      Str,
	/// Pool name.
	pub pool:       Str,
	/// Stable requested worker id.
	pub id:         Str,
	/// Discovered agent class.
	pub agent:      Str,
	/// Optional pool-wide context.
	pub context:    Option<Str>,
	/// Exact authenticated eval-tool roster installed for this worker.
	pub eval_tools: Option<Arc<EvalToolRoster>>,
}

/// Workpool creation request already authorized by the parent host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkpoolCreate {
	/// Unique pool name within its owner.
	pub name:    Str,
	/// Discovered agent class.
	pub agent:   Str,
	/// Optional pool-wide context.
	pub context: Option<Str>,
}

/// One aggregate status snapshot.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct WorkpoolStatus {
	/// Pool identity.
	pub name:         Str,
	/// Agent class.
	pub agent:        Str,
	/// Current live worker ceiling (`0` means unlimited).
	pub limit:        usize,
	/// Whether the pool accepts more items.
	pub closed:       bool,
	/// Fresh-worker policy captured for this pool.
	#[serde(rename = "freshAgents")]
	pub fresh_agents: bool,
	/// Current workers.
	pub agents:       Vec<WorkpoolAgentStatus>,
	/// Item counts by lifecycle state.
	pub items:        WorkpoolItemCounts,
	/// Number of attempted batches, including retries after worker death.
	pub batches:      usize,
}

/// One worker row in [`WorkpoolStatus`].
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct WorkpoolAgentStatus {
	/// Child id.
	pub id:             Str,
	/// `running` or `idle`.
	pub state:          Str,
	/// Items waiting behind the active batch.
	pub queued:         usize,
	/// Settled turns.
	pub turns:          u32,
	/// Context use when reported by the worker.
	#[serde(rename = "contextTokens", skip_serializing_if = "Option::is_none")]
	pub context_tokens: Option<u64>,
	/// Context window when reported by the worker.
	#[serde(rename = "contextWindow", skip_serializing_if = "Option::is_none")]
	pub context_window: Option<u64>,
	/// Active batch id.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub current:        Option<Str>,
}

/// Lifecycle counts for pool items.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
pub struct WorkpoolItemCounts {
	/// Waiting for a worker or follow-up batch.
	pub queued:    usize,
	/// In an active worker batch.
	pub running:   usize,
	/// Successfully settled.
	pub completed: usize,
	/// Settled with a failure.
	pub failed:    usize,
	/// Dropped by close/cancellation.
	pub cancelled: usize,
}

/// Non-consuming batch snapshot. Calling this never marks the aggregate job
/// delivered.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct WorkpoolPeek {
	/// Attempted batches in creation order.
	pub batches: Vec<WorkpoolBatchStatus>,
	/// Queued plus running item count.
	pub pending: usize,
}

/// One batch row in [`WorkpoolPeek`].
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct WorkpoolBatchStatus {
	/// Batch id.
	pub id:     Str,
	/// Worker id.
	pub agent:  Str,
	/// Item ids.
	pub items:  Vec<Str>,
	/// `running`, `completed`, `failed`, or `cancelled`.
	pub status: Str,
	/// Settled output when available.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub output: Option<Str>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
enum ItemState {
	Queued,
	Running,
	Completed,
	Failed,
	Cancelled,
}

struct Item {
	id:     Str,
	text:   Str,
	state:  ItemState,
	output: Option<Str>,
}

struct Worker {
	handle:         WorkerHandle,
	queue:          VecDeque<usize>,
	active:         Option<Str>,
	turns:          u32,
	context_tokens: Option<u64>,
	context_window: Option<u64>,
	last_receipt:   WorkpoolReceipt,
}

struct Batch {
	id:     Str,
	worker: Str,
	items:  Vec<usize>,
	status: Str,
	output: Option<Str>,
}

struct Snapshot {
	started:         bool,
	closed:          bool,
	terminal_status: Option<Str>,
	items:           Vec<Item>,
	workers:         Vec<Worker>,
	batches:         Vec<Batch>,
	next_seq:        u64,
	next_worker:     u64,
	rr_cursor:       usize,
	last_receipt:    Option<WorkpoolReceipt>,
}

impl Default for Snapshot {
	fn default() -> Self {
		Self {
			started:         false,
			closed:          false,
			terminal_status: None,
			items:           Vec::new(),
			workers:         Vec::new(),
			batches:         Vec::new(),
			next_seq:        1,
			next_worker:     1,
			rr_cursor:       0,
			last_receipt:    None,
		}
	}
}

enum Command {
	Push(Vec<Str>, flume::Sender<Result<Vec<Str>, WorkpoolSchedulerError>>),
	Close(flume::Sender<Vec<Str>>),
}

/// Handle for one active scheduler actor.
pub struct Workpool {
	owner:        Str,
	name:         Str,
	agent:        Str,
	policy:       Arc<dyn WorkpoolPolicy>,
	fresh_agents: bool,
	state:        Arc<Mutex<Snapshot>>,
	commands:     flume::Sender<Command>,
	cancel:       CancellationToken,
	parent:       SessionMutator,
	jobs:         Arc<JobBoard>,
	task:         Mutex<Option<JoinHandle<JobSettlement>>>,
}

impl Workpool {
	/// Queues items and returns stable ids in input order.
	pub async fn push(&self, items: Vec<Str>) -> Result<Vec<Str>, WorkpoolSchedulerError> {
		if self.state.lock().closed {
			return Err(WorkpoolSchedulerError::Closed { pool: self.name.clone() });
		}
		if items.is_empty() {
			return Ok(Vec::new());
		}
		self.ensure_aggregate_job().await?;
		let (tx, rx) = flume::bounded(1);
		self
			.commands
			.send_async(Command::Push(items, tx))
			.await
			.map_err(|_| WorkpoolSchedulerError::Closed { pool: self.name.clone() })?;
		rx.recv_async()
			.await
			.map_err(|_| WorkpoolSchedulerError::Closed { pool: self.name.clone() })?
	}

	/// Returns the current non-consuming status snapshot.
	#[must_use]
	pub fn status(&self) -> WorkpoolStatus {
		let state = self.state.lock();
		let mut counts = WorkpoolItemCounts::default();
		for item in &state.items {
			match item.state {
				ItemState::Queued => counts.queued += 1,
				ItemState::Running => counts.running += 1,
				ItemState::Completed => counts.completed += 1,
				ItemState::Failed => counts.failed += 1,
				ItemState::Cancelled => counts.cancelled += 1,
			}
		}
		WorkpoolStatus {
			name:         self.name.clone(),
			agent:        self.agent.clone(),
			limit:        self.policy.concurrency_limit(),
			closed:       state.closed,
			fresh_agents: self.fresh_agents,
			agents:       state
				.workers
				.iter()
				.map(|worker| WorkpoolAgentStatus {
					id:             worker.handle.id.clone(),
					state:          Str::new_static(if worker.active.is_some() {
						"running"
					} else {
						"idle"
					}),
					queued:         worker.queue.len(),
					turns:          worker.turns,
					context_tokens: worker.context_tokens,
					context_window: worker.context_window,
					current:        worker.active.clone(),
				})
				.collect(),
			items:        counts,
			batches:      state.batches.len(),
		}
	}

	/// Returns batch results without consuming the aggregate JobBoard result.
	#[must_use]
	pub fn peek(&self) -> WorkpoolPeek {
		let state = self.state.lock();
		WorkpoolPeek {
			batches: state
				.batches
				.iter()
				.map(|batch| WorkpoolBatchStatus {
					id:     batch.id.clone(),
					agent:  batch.worker.clone(),
					items:  batch
						.items
						.iter()
						.map(|index| state.items[*index].id.clone())
						.collect(),
					status: batch.status.clone(),
					output: batch.output.clone(),
				})
				.collect(),
			pending: state
				.items
				.iter()
				.filter(|item| matches!(item.state, ItemState::Queued | ItemState::Running))
				.count(),
		}
	}

	/// Stops accepting work, drops queued items, and lets active turns settle.
	pub async fn close(&self) -> Result<Vec<Str>, WorkpoolSchedulerError> {
		if self.state.lock().closed {
			return Ok(Vec::new());
		}
		let (tx, rx) = flume::bounded(1);
		self
			.commands
			.send_async(Command::Close(tx))
			.await
			.map_err(|_| WorkpoolSchedulerError::Closed { pool: self.name.clone() })?;
		Ok(rx
			.recv_async()
			.await
			.map_err(|_| WorkpoolSchedulerError::Closed { pool: self.name.clone() })?)
	}

	/// Cancels aggregate and worker execution units at their shared kill
	/// boundary.
	pub fn cancel(&self) {
		self.cancel.cancel();
	}

	async fn ensure_aggregate_job(&self) -> Result<(), WorkpoolSchedulerError> {
		let Some(task) = self.task.lock().take() else {
			return Ok(());
		};
		let id = self.name.clone();
		let owner = self.owner.clone();
		let jobs = Arc::clone(&self.jobs);
		let execution_cancel = self.cancel.clone();
		let request_cancel = self.cancel.clone();
		let result = self
			.parent
			.mutate(&self.cancel, move |parent| {
				if request_cancel.is_cancelled() {
					return Err(WorkpoolSchedulerError::MutationCancelled);
				}
				if job_handle(parent, id.as_str()).is_some() {
					return Err(WorkpoolSchedulerError::JobCollision { id });
				}
				let cause = parent
					.head()
					.ok_or(WorkpoolSchedulerError::MissingParentHead)?;
				let txn = jobs::insert(parent.dom(), cause, jobs::JobSpec {
					id: id.clone(),
					kind: Str::new_static("tool"),
					owner,
					started: Str::new(now_ms().to_string()),
					agent: None,
				})
				.ok_or(WorkpoolSchedulerError::MissingJobs)?;
				parent.patch(txn)?;
				let handle =
					job_handle(parent, id.as_str()).ok_or(WorkpoolSchedulerError::MissingJobs)?;
				if !jobs.attach_task(parent.dom(), handle, execution_cancel, task) {
					return Err(WorkpoolSchedulerError::MissingJobs);
				}
				Ok(())
			})
			.await;
		if result.is_err() {
			self.cancel.cancel();
		}
		result
	}
}

/// Owner-scoped scheduler registry used by the authenticated eval bridge.
pub struct SchedulerRegistry {
	owner:     Str,
	parent:    SessionMutator,
	jobs:      Arc<JobBoard>,
	spill:     BlobStore,
	producers: Arc<WorkpoolRegistry>,
	launcher:  Arc<dyn WorkpoolLauncher>,
	policy:    Arc<dyn WorkpoolPolicy>,
	eval:      EvalSessionControl,
	pools:     Mutex<FastHashMap<Str, Arc<Workpool>>>,
}

impl SchedulerRegistry {
	/// Creates the single workpool owner for one live parent-session binding.
	#[must_use]
	pub fn new(
		owner: Str,
		parent: SessionMutator,
		jobs: Arc<JobBoard>,
		spill: BlobStore,
		producers: Arc<WorkpoolRegistry>,
		launcher: Arc<dyn WorkpoolLauncher>,
		policy: Arc<dyn WorkpoolPolicy>,
		eval: EvalSessionControl,
	) -> Self {
		Self {
			owner,
			parent,
			jobs,
			spill,
			producers,
			launcher,
			policy,
			eval,
			pools: Mutex::default(),
		}
	}

	/// Creates a unique pool and its dormant aggregate task. The JobBoard node
	/// is inserted atomically on the first non-empty push.
	pub fn create(&self, request: WorkpoolCreate) -> Result<Arc<Workpool>, WorkpoolSchedulerError> {
		self.create_with_roster(request, None)
	}

	fn create_with_roster(
		&self,
		request: WorkpoolCreate,
		eval_tools: Option<Arc<EvalToolRoster>>,
	) -> Result<Arc<Workpool>, WorkpoolSchedulerError> {
		let name = Str::new(request.name.trim());
		if name.is_empty() {
			return Err(WorkpoolSchedulerError::EmptyName);
		}
		let mut pools = self.pools.lock();
		if pools.contains_key(&name) {
			return Err(WorkpoolSchedulerError::Duplicate { pool: name });
		}
		let producer = self.producers.create(self.owner.as_str(), name.clone())?;
		let fresh_agents = self.policy.fresh_agents();
		let state = Arc::new(Mutex::new(Snapshot::default()));
		// Concurrent eval callers backpressure at the actor boundary instead of
		// building an unbounded second work queue beside the durable item list.
		let (commands, command_rx) = flume::bounded(64);
		let cancel = CancellationToken::new();
		let actor = PoolActor {
			owner: self.owner.clone(),
			name: name.clone(),
			agent: request.agent.clone(),
			context: request.context,
			eval_tools,
			producer,
			spill: self.spill.clone(),
			launcher: Arc::clone(&self.launcher),
			policy: Arc::clone(&self.policy),
			fresh_agents,
			state: Arc::clone(&state),
			commands: command_rx,
			events: flume::unbounded(),
			cancel: cancel.clone(),
			retired: Vec::new(),
			parent: self.parent.clone(),
		};
		let task = tokio::spawn(actor.run());
		let pool = Arc::new(Workpool {
			owner: self.owner.clone(),
			name: name.clone(),
			agent: request.agent,
			policy: Arc::clone(&self.policy),
			fresh_agents,
			state,
			commands,
			cancel,
			parent: self.parent.clone(),
			jobs: Arc::clone(&self.jobs),
			task: Mutex::new(Some(task)),
		});
		pools.insert(name, Arc::clone(&pool));
		Ok(pool)
	}

	/// Looks up a pool without allocating a key.
	#[must_use]
	pub fn get(&self, name: &str) -> Option<Arc<Workpool>> {
		self
			.pools
			.lock()
			.iter()
			.find(|(key, _)| key.as_str() == name)
			.map(|(_, pool)| Arc::clone(pool))
	}

	/// Cancels and forgets every pool when its parent binding is reset or
	/// replaced. Worker and aggregate tasks settle through their JobBoard kill
	/// boundaries; producer generations are released in the same operation.
	pub fn release_owner(&self) {
		let pools = std::mem::take(&mut *self.pools.lock());
		for pool in pools.into_values() {
			pool.cancel();
		}
		self.producers.release_owner(self.owner.as_str());
	}

	/// Adapts this scheduler to [`omp_envd::eval::ParentSessionHost::workpool`]
	/// and publishes one correlated status only after the operation commits.
	pub async fn bridge_host_call(
		&self,
		args: Json,
		progress: &dyn omp_envd::eval::BridgeProgressSink,
	) -> Result<Json, omp_envd::eval::BridgeHostError> {
		let op = args
			.get("op")
			.and_then(Json::as_str)
			.map_or_else(|| Str::new_static("unknown"), Str::new);
		let pool = args.get("name").and_then(Json::as_str).map(Str::new);
		let result = self
			.bridge_call(args)
			.await
			.map_err(|error| omp_envd::eval::BridgeHostError::message(error.to_string()))?;
		progress.progress(json!({
			"op": "workpool",
			"action": op,
			"pool": pool,
		}))?;
		Ok(result)
	}

	/// Validates and executes one `__workpool__` bridge operation.
	pub async fn bridge_call(&self, args: Json) -> Result<Json, WorkpoolSchedulerError> {
		let object = args
			.as_object()
			.ok_or(WorkpoolSchedulerError::ArgumentsObject)?;
		let op = required_string(object, "op")?;
		if op == "create" {
			let agent = optional_string(object, "agent")?.unwrap_or_else(|| Str::new_static("task"));
			let context = optional_string(object, "context")?;
			let tools = optional_strings(object, "tools")?.unwrap_or_default();
			if !tools.is_empty() && !self.policy.eval_tools_enabled() {
				return Err(WorkpoolSchedulerError::EvalToolsDisabled);
			}
			let eval_tools = self.seal_eval_tools(object, &tools)?;
			let requested = optional_string(object, "name")?;
			let name = requested.unwrap_or_else(|| self.available_name(agent.as_str()));
			let pool = self.create_with_roster(
				WorkpoolCreate { name, agent, context },
				eval_tools.map(Arc::new),
			)?;
			let status = pool.status();
			return Ok(json!({ "name": status.name, "agent": status.agent, "limit": status.limit }));
		}
		let name = required_string(object, "name")?;
		let pool = self
			.get(name.as_str())
			.ok_or_else(|| WorkpoolSchedulerError::Unknown { pool: name.clone() })?;
		match op.as_str() {
			"push" => {
				let items = required_strings(object, "items")?;
				Ok(json!({ "ids": pool.push(items).await? }))
			},
			"status" => serde_json::to_value(pool.status()).map_err(WorkpoolSchedulerError::Json),
			"peek" => serde_json::to_value(pool.peek()).map_err(WorkpoolSchedulerError::Json),
			"close" => Ok(json!({ "dropped": pool.close().await? })),
			_ => Err(WorkpoolSchedulerError::UnknownOperation { op }),
		}
	}

	fn seal_eval_tools(
		&self,
		object: &serde_json::Map<String, Json>,
		names: &[Str],
	) -> Result<Option<EvalToolRoster>, WorkpoolSchedulerError> {
		let registrations = object.get("tool_registrations");
		if names.is_empty() {
			if registrations.is_some_and(|value| {
				value
					.as_array()
					.is_none_or(|registrations| !registrations.is_empty())
			}) {
				return Err(WorkpoolSchedulerError::EvalToolRegistrationMismatch);
			}
			return Ok(None);
		}
		let registrations = registrations
			.cloned()
			.ok_or(WorkpoolSchedulerError::MissingField { field: "tool_registrations" })
			.and_then(|value| {
				serde_json::from_value::<Vec<EvalToolRegistration>>(value)
					.map_err(WorkpoolSchedulerError::Json)
			})?;
		if registrations.len() != names.len()
			|| registrations
				.iter()
				.zip(names)
				.any(|(registration, name)| registration.name.as_str() != name.as_str())
		{
			return Err(WorkpoolSchedulerError::EvalToolRegistrationMismatch);
		}
		self
			.eval
			.seal_registrations(registrations)
			.map(Some)
			.map_err(|source| WorkpoolSchedulerError::EvalToolControl { source })
	}

	fn available_name(&self, agent: &str) -> Str {
		let base = sf!("{agent}-pool");
		if self.get(base.as_str()).is_none() {
			return base;
		}
		for suffix in 2_u64.. {
			let candidate = sf!("{base}-{suffix}");
			if self.get(candidate.as_str()).is_none() {
				return candidate;
			}
		}
		unreachable!("u64 pool suffix space exhausted")
	}
}

impl Drop for SchedulerRegistry {
	fn drop(&mut self) {
		self.release_owner();
	}
}

/// Minimal parent capability owner used by production compositions whose
/// completion/agent helpers are not installed. Workpool is layered over this
/// host without granting a second session authority.
pub struct WorkpoolSessionHost {
	cwd: std::path::PathBuf,
}

impl WorkpoolSessionHost {
	/// Captures the environment-authorized project directory.
	#[must_use]
	pub fn new(cwd: std::path::PathBuf) -> Self {
		Self { cwd }
	}
}

#[async_trait]
impl omp_envd::eval::ParentSessionHost for WorkpoolSessionHost {
	fn eval_session_config(
		&self,
	) -> Result<omp_envd::eval::EvalSessionConfig, omp_envd::eval::BridgeHostError> {
		Ok(omp_envd::eval::EvalSessionConfig {
			cwd:              self.cwd.clone(),
			local_roots_json: None,
		})
	}

	fn completion_available(&self) -> bool {
		false
	}

	async fn completion(
		&self,
		_args: Json,
		_progress: &dyn omp_envd::eval::BridgeProgressSink,
	) -> Result<Json, omp_envd::eval::BridgeHostError> {
		Err(omp_envd::eval::BridgeHostError::message(
			"eval completion is unavailable for this parent session",
		))
	}

	fn agent_available(&self) -> bool {
		false
	}

	async fn agent(
		&self,
		_args: Json,
		_progress: &dyn omp_envd::eval::BridgeProgressSink,
	) -> Result<Json, omp_envd::eval::BridgeHostError> {
		Err(omp_envd::eval::BridgeHostError::message(
			"eval agent is unavailable for this parent session",
		))
	}

	fn concurrency_available(&self) -> bool {
		false
	}

	async fn concurrency(&self, _args: Json) -> Result<Json, omp_envd::eval::BridgeHostError> {
		Err(omp_envd::eval::BridgeHostError::message(
			"eval concurrency is unavailable for this parent session",
		))
	}

	fn budget_available(&self) -> bool {
		false
	}

	async fn budget(&self, _args: Json) -> Result<Json, omp_envd::eval::BridgeHostError> {
		Err(omp_envd::eval::BridgeHostError::message(
			"eval budget is unavailable for this parent session",
		))
	}
}

/// Parent-session bridge decorator that installs exactly one authenticated
/// `__workpool__` route while delegating the existing completion/agent/control
/// operations to the original host.
pub struct WorkpoolParentHost<P> {
	inner:     P,
	scheduler: Arc<SchedulerRegistry>,
}

impl<P> WorkpoolParentHost<P> {
	/// Wraps a live parent host with its owner-scoped scheduler.
	#[must_use]
	pub fn new(inner: P, scheduler: Arc<SchedulerRegistry>) -> Self {
		Self { inner, scheduler }
	}
}

#[async_trait]
impl<P> omp_envd::eval::ParentSessionHost for WorkpoolParentHost<P>
where
	P: omp_envd::eval::ParentSessionHost,
{
	fn eval_session_config(
		&self,
	) -> Result<omp_envd::eval::EvalSessionConfig, omp_envd::eval::BridgeHostError> {
		self.inner.eval_session_config()
	}

	fn release_eval_owner(&self) {
		self.scheduler.release_owner();
		self.inner.release_eval_owner();
	}

	fn completion_available(&self) -> bool {
		self.inner.completion_available()
	}

	async fn completion(
		&self,
		args: Json,
		progress: &dyn omp_envd::eval::BridgeProgressSink,
	) -> Result<Json, omp_envd::eval::BridgeHostError> {
		self.inner.completion(args, progress).await
	}

	fn agent_available(&self) -> bool {
		self.inner.agent_available()
	}

	async fn agent(
		&self,
		args: Json,
		progress: &dyn omp_envd::eval::BridgeProgressSink,
	) -> Result<Json, omp_envd::eval::BridgeHostError> {
		self.inner.agent(args, progress).await
	}

	fn workpool_available(&self) -> bool {
		true
	}

	async fn workpool(
		&self,
		args: Json,
		progress: &dyn omp_envd::eval::BridgeProgressSink,
	) -> Result<Json, omp_envd::eval::BridgeHostError> {
		self.scheduler.bridge_host_call(args, progress).await
	}

	fn concurrency_available(&self) -> bool {
		self.inner.concurrency_available()
	}

	async fn concurrency(&self, args: Json) -> Result<Json, omp_envd::eval::BridgeHostError> {
		self.inner.concurrency(args).await
	}

	fn budget_available(&self) -> bool {
		self.inner.budget_available()
	}

	async fn budget(&self, args: Json) -> Result<Json, omp_envd::eval::BridgeHostError> {
		self.inner.budget(args).await
	}
}

struct PoolActor {
	owner:        Str,
	name:         Str,
	agent:        Str,
	context:      Option<Str>,
	eval_tools:   Option<Arc<EvalToolRoster>>,
	producer:     Arc<WorkpoolProducer>,
	spill:        BlobStore,
	launcher:     Arc<dyn WorkpoolLauncher>,
	policy:       Arc<dyn WorkpoolPolicy>,
	fresh_agents: bool,
	state:        Arc<Mutex<Snapshot>>,
	commands:     flume::Receiver<Command>,
	events:       (flume::Sender<WorkerEvent>, flume::Receiver<WorkerEvent>),
	cancel:       CancellationToken,
	retired:      Vec<(flume::Receiver<()>, tokio::task::AbortHandle)>,
	parent:       SessionMutator,
}

impl PoolActor {
	fn durable_state(&self) -> Json {
		let state = self.state.lock();
		let summary = state.closed.then(|| aggregate(&self.name, &state));
		json!({
			"version": 1,
			"name": self.name,
			"agent": self.agent,
			"fresh_agents": self.fresh_agents,
			"started": state.started,
			"closed": state.closed,
			"terminal_status": state.terminal_status,
			"summary": summary,
			"next_seq": state.next_seq,
			"next_worker": state.next_worker,
			"rr_cursor": state.rr_cursor,
			"items": state.items.iter().map(|item| {
				let status: &'static str = item.state.into();
				json!({
					"id": item.id,
					"text": item.text,
					"status": status,
					"output": item.output,
				})
			}).collect::<Vec<_>>(),
			"workers": state.workers.iter().map(|worker| json!({
				"id": worker.handle.id,
				"queued": worker.queue.iter().map(|index| &state.items[*index].id).collect::<Vec<_>>(),
				"active": worker.active,
				"turns": worker.turns,
				"context_tokens": worker.context_tokens,
				"context_window": worker.context_window,
			})).collect::<Vec<_>>(),
			"batches": state.batches.iter().map(|batch| json!({
				"id": batch.id,
				"worker": batch.worker,
				"items": batch.items.iter().map(|index| &state.items[*index].id).collect::<Vec<_>>(),
				"status": batch.status,
				"output": batch.output,
			})).collect::<Vec<_>>(),
		})
	}

	async fn persist(&self, label: &'static str) -> Result<(), WorkpoolSchedulerError> {
		self.persist_with(label, &self.cancel).await
	}

	async fn persist_with(
		&self,
		label: &'static str,
		cancel: &CancellationToken,
	) -> Result<(), WorkpoolSchedulerError> {
		let state = self.durable_state();
		let mut data = serde_json::value::to_raw_value(&state)?;
		if data.get().len() > omp_agent::DispatchPolicy::DEFAULT_MAX_OUTPUT_BYTES {
			let byte_len = data.get().len();
			let artifact = self.spill.put(data.get().as_bytes())?;
			data = serde_json::value::to_raw_value(&json!({
				"version": 1,
				"closed": state.get("closed"),
				"terminal_status": state.get("terminal_status"),
				"summary": state.get("summary"),
				"artifact": sf!("artifact://sha256/{}", artifact.to_hex()),
				"byte_len": byte_len,
			}))?;
		}
		let id = self.name.clone();
		let request_cancel = cancel.clone();
		self
			.parent
			.mutate(cancel, move |parent| {
				if request_cancel.is_cancelled() {
					return Err(WorkpoolSchedulerError::MutationCancelled);
				}
				let handle =
					job_handle(parent, id.as_str()).ok_or(WorkpoolSchedulerError::MissingJobs)?;
				let cause = parent
					.head()
					.ok_or(WorkpoolSchedulerError::MissingParentHead)?;
				parent.patch(Txn {
					cause,
					label: Some(Str::new_static(label)),
					ops: vec![Op::Set {
						h:     handle,
						prop:  PropKey::Custom(Str::new_static(WORKPOOL_STATE)),
						value: Value::Json(data),
					}],
				})?;
				Ok(())
			})
			.await
	}

	async fn run(mut self) -> JobSettlement {
		loop {
			let should_finish = {
				let state = self.state.lock();
				state.started
					&& !state
						.items
						.iter()
						.any(|item| matches!(item.state, ItemState::Queued | ItemState::Running))
			};
			if should_finish {
				return self.finish(false).await;
			}
			tokio::select! {
				biased;
				() = self.cancel.cancelled() => return self.finish(true).await,
				// Settlement frees a worker and is finite; process it before
				// accepting more pushes so a hot producer cannot starve the
				// existing queue or its result delivery.
				event = self.events.1.recv_async() => match event {
					Ok(event) => self.worker_event(event).await,
					Err(_) => return self.finish(true).await,
				},
				command = self.commands.recv_async() => match command {
					Ok(command) => self.command(command).await,
					Err(_) => return self.finish(true).await,
				},
			}
		}
	}

	async fn command(&mut self, command: Command) {
		match command {
			Command::Push(texts, reply) => {
				if self.state.lock().closed {
					let _ = reply.send(Err(WorkpoolSchedulerError::Closed { pool: self.name.clone() }));
					return;
				}
				let (ids, indices) = {
					let mut state = self.state.lock();
					state.started = true;
					let start = state.items.len();
					let ids = texts
						.into_iter()
						.map(|text| {
							let id = sf!("{}#{}", self.name, state.next_seq);
							state.next_seq += 1;
							state.items.push(Item {
								id: id.clone(),
								text,
								state: ItemState::Queued,
								output: None,
							});
							id
						})
						.collect::<Vec<_>>();
					let indices = (start..state.items.len()).collect::<Vec<_>>();
					(ids, indices)
				};
				if let Err(error) = self.persist("workpool.push").await {
					let _ = reply.send(Err(error));
					self.cancel.cancel();
					return;
				}
				let _ = reply.send(Ok(ids));
				for index in indices {
					self.schedule(index).await;
				}
			},
			Command::Close(reply) => {
				let dropped = {
					let mut state = self.state.lock();
					state.closed = true;
					let mut dropped = Vec::new();
					for item in &mut state.items {
						if item.state == ItemState::Queued {
							item.state = ItemState::Cancelled;
							dropped.push(item.id.clone());
						}
					}
					for worker in &mut state.workers {
						worker.queue.clear();
					}
					dropped
				};
				if self.persist("workpool.close").await.is_err() {
					self.cancel.cancel();
				}
				let _ = reply.send(dropped);
			},
		}
	}

	async fn schedule(&mut self, item: usize) {
		if self
			.state
			.lock()
			.items
			.get(item)
			.is_none_or(|item| item.state != ItemState::Queued)
		{
			return;
		}
		let fresh = self.fresh_agents;
		let limit = match self.policy.concurrency_limit() {
			0 => usize::MAX,
			limit => limit,
		};
		if !fresh {
			let idle = {
				let state = self.state.lock();
				state
					.workers
					.iter()
					.enumerate()
					.filter(|(_, worker)| worker.active.is_none())
					.min_by(|(_, left), (_, right)| context_load(left).total_cmp(&context_load(right)))
					.map(|(index, _)| index)
			};
			if let Some(worker) = idle {
				self.dispatch(worker, vec![item], false).await;
				return;
			}
		}
		if self.state.lock().workers.len() < limit {
			match self.spawn_worker().await {
				Ok(worker) => self.dispatch(worker, vec![item], false).await,
				Err(_) => self.state.lock().items[item].state = ItemState::Failed,
			}
			return;
		}
		if fresh {
			return;
		}
		let worker = {
			let mut state = self.state.lock();
			let live = state.workers.len();
			if live == 0 {
				None
			} else {
				let selected = state.rr_cursor % live;
				state.rr_cursor = (selected + 1) % live;
				let receipt = state.workers[selected].last_receipt.clone();
				state.workers[selected].queue.push_back(item);
				Some((selected, receipt))
			}
		};
		if let Some((worker, prior)) = worker {
			if self.persist("workpool.item.queued").await.is_err() {
				self.cancel.cancel();
				return;
			}
			let (id, text, target) = {
				let state = self.state.lock();
				(
					state.items[item].id.clone(),
					state.items[item].text.clone(),
					state.workers[worker].handle.id.clone(),
				)
			};
			let body = sf!("[{id}] {text}");
			if let Ok(receipt) = self
				.deliver(self.producer.queued(target.as_str(), body, &prior))
				.await
			{
				let mut state = self.state.lock();
				state.workers[worker].last_receipt = receipt.clone();
				state.last_receipt = Some(receipt);
			}
		}
	}

	async fn spawn_worker(&mut self) -> Result<usize, WorkpoolSchedulerError> {
		let requested = {
			let mut state = self.state.lock();
			let id = sf!("{}-{}", self.name, state.next_worker);
			state.next_worker += 1;
			id
		};
		let spawn = self.launcher.spawn(
			WorkerSpawn {
				owner:      self.owner.clone(),
				pool:       self.name.clone(),
				id:         requested,
				agent:      self.agent.clone(),
				context:    self.context.clone(),
				eval_tools: self.eval_tools.clone(),
			},
			self.events.0.clone(),
		);
		let handle = tokio::select! {
			() = self.cancel.cancelled() => {
				return Err(WorkpoolSchedulerError::Cancelled { pool: self.name.clone() });
			},
			result = spawn => result?,
		};
		let staged = self
			.producer
			.spawned(handle.id.as_str(), sf!("Worker {} admitted", handle.id))?;
		let receipt = self.deliver(Ok(staged)).await?;
		let worker = {
			let mut state = self.state.lock();
			state.last_receipt = Some(receipt.clone());
			state.workers.push(Worker {
				handle,
				queue: VecDeque::new(),
				active: None,
				turns: 0,
				context_tokens: None,
				context_window: None,
				last_receipt: receipt,
			});
			state.workers.len() - 1
		};
		if let Err(error) = self.persist("workpool.worker.spawned").await {
			if let Some(worker) = self.state.lock().workers.pop() {
				worker.handle.cancel.cancel();
				self.retired.push((worker.handle.finished, worker.handle.abort));
			}
			return Err(error);
		}
		Ok(worker)
	}

	async fn dispatch(&mut self, worker: usize, items: Vec<usize>, follow_up: bool) {
		let (batch, prior, sender, target) = {
			let mut state = self.state.lock();
			if worker >= state.workers.len() {
				return;
			}
			let turn = state.workers[worker].turns + 1;
			let worker_id = state.workers[worker].handle.id.clone();
			let id = sf!("{worker_id}-b{turn}");
			for index in &items {
				state.items[*index].state = ItemState::Running;
			}
			state.workers[worker].active = Some(id.clone());
			state.batches.push(Batch {
				id:     id.clone(),
				worker: worker_id,
				items:  items.clone(),
				status: Str::new_static("running"),
				output: None,
			});
			let batch = WorkerBatch {
				id,
				items: items
					.iter()
					.map(|index| (state.items[*index].id.clone(), state.items[*index].text.clone()))
					.collect(),
				context: self.context.clone(),
			};
			(
				batch,
				state.workers[worker].last_receipt.clone(),
				state.workers[worker].handle.batches.clone(),
				state.workers[worker].handle.id.clone(),
			)
		};
		if self.persist("workpool.batch.running").await.is_err() {
			self.cancel.cancel();
			return;
		}
		let summary = batch
			.items
			.iter()
			.map(|(id, text)| sf!("[{id}] {text}"))
			.collect::<Vec<_>>()
			.join("\n");
		let staged = if follow_up {
			self
				.producer
				.batch(target.as_str(), Str::new(summary), &prior)
		} else {
			self
				.producer
				.dispatched(target.as_str(), Str::new(summary), &prior)
		};
		if let Ok(receipt) = self.deliver(staged).await {
			let mut state = self.state.lock();
			if let Some(live) = state.workers.get_mut(worker) {
				live.last_receipt = receipt.clone();
			}
			state.last_receipt = Some(receipt);
		}
		if sender.send_async(batch).await.is_err() {
			let _ = self
				.events
				.0
				.send_async(WorkerEvent::Dead {
					worker: target,
					error:  Str::new_static("worker batch channel closed"),
				})
				.await;
		}
	}

	async fn worker_event(&mut self, event: WorkerEvent) {
		match event {
			WorkerEvent::Settled {
				worker,
				batch,
				output,
				success,
				alive,
				context_tokens,
				context_window,
			} => {
				let (retained, retained_ok) = match self.spill.put(output.as_bytes()) {
					Ok(artifact) => (sf!("artifact://sha256/{}", artifact.to_hex()), true),
					Err(_) => (Str::new_static("worker output could not be retained"), false),
				};
				let success = success && retained_ok;
				let (worker_index, receipt, queued) = {
					let mut state = self.state.lock();
					let Some(worker_index) = state
						.workers
						.iter()
						.position(|candidate| candidate.handle.id == worker)
					else {
						return;
					};
					let Some(batch_index) = state
						.batches
						.iter()
						.position(|candidate| candidate.id == batch)
					else {
						return;
					};
					let item_indices = state.batches[batch_index].items.clone();
					state.batches[batch_index].status =
						Str::new_static(if success { "completed" } else { "failed" });
					state.batches[batch_index].output = Some(retained.clone());
					for item in item_indices {
						state.items[item].state = if success {
							ItemState::Completed
						} else {
							ItemState::Failed
						};
						state.items[item].output = Some(retained.clone());
					}
					let live = &mut state.workers[worker_index];
					live.turns += 1;
					live.active = None;
					live.context_tokens = context_tokens;
					live.context_window = context_window;
					let receipt = live.last_receipt.clone();
					let queued = live.queue.drain(..).collect::<Vec<_>>();
					(worker_index, receipt, queued)
				};
				if self.persist("workpool.batch.settled").await.is_err() {
					self.cancel.cancel();
					return;
				}
				let body =
					sf!("Batch {batch} {}\n{retained}", if success { "completed" } else { "failed" });
				if self
					.producer
					.deliver_result_once(worker.as_str(), body, &receipt, &self.cancel)
					.await
					.is_err()
				{
					self.cancel.cancel();
					return;
				}
				if self.fresh_agents || !alive {
					self.remove_worker(worker_index, queued, !alive).await;
				} else if !queued.is_empty() {
					self.dispatch(worker_index, queued, true).await;
				}
				self.fill_fresh_slots().await;
			},
			WorkerEvent::Dead { worker, error } => {
				let found = {
					self
						.state
						.lock()
						.workers
						.iter()
						.position(|candidate| candidate.handle.id == worker)
				};
				if let Some(index) = found {
					let queued = {
						let mut state = self.state.lock();
						let mut items = state.workers[index].queue.drain(..).collect::<Vec<_>>();
						if let Some(batch) = state.workers[index].active.take()
							&& let Some(batch_index) = state
								.batches
								.iter()
								.position(|candidate| candidate.id == batch)
						{
							state.batches[batch_index].status = Str::new_static("failed");
							state.batches[batch_index].output = Some(error);
							items.extend(state.batches[batch_index].items.clone());
						}
						items
					};
					self.remove_worker(index, queued, true).await;
					self.fill_fresh_slots().await;
				}
			},
		}
	}

	async fn remove_worker(&mut self, index: usize, requeue: Vec<usize>, retry: bool) {
		let worker = {
			let mut state = self.state.lock();
			if index >= state.workers.len() {
				return;
			}
			let worker = state.workers.remove(index);
			for item in &requeue {
				if retry && state.items[*item].state != ItemState::Cancelled {
					state.items[*item].state = ItemState::Queued;
				}
			}
			worker
		};
		if self.persist("workpool.worker.removed").await.is_err() {
			self.cancel.cancel();
		}
		if retry {
			worker.handle.cancel.cancel();
		}
		self
			.retired
			.push((worker.handle.finished, worker.handle.abort));
		if retry {
			for item in requeue {
				self.schedule(item).await;
			}
		}
	}

	async fn fill_fresh_slots(&mut self) {
		if !self.fresh_agents {
			return;
		}
		let limit = match self.policy.concurrency_limit() {
			0 => usize::MAX,
			value => value,
		};
		loop {
			let next = {
				let state = self.state.lock();
				if state.workers.len() >= limit {
					None
				} else {
					state
						.items
						.iter()
						.position(|item| item.state == ItemState::Queued)
				}
			};
			let Some(item) = next else {
				break;
			};
			match self.spawn_worker().await {
				Ok(worker) => self.dispatch(worker, vec![item], false).await,
				Err(_) => {
					self.state.lock().items[item].state = ItemState::Failed;
				},
			}
		}
	}

	async fn finish(&mut self, cancelled: bool) -> JobSettlement {
		let (last, workers, summary) = {
			let mut state = self.state.lock();
			state.closed = true;
			state.terminal_status =
				Some(Str::new_static(if cancelled { "cancelled" } else { "completed" }));
			if cancelled {
				for item in &mut state.items {
					if matches!(item.state, ItemState::Queued | ItemState::Running) {
						item.state = ItemState::Cancelled;
					}
				}
				for batch in &mut state.batches {
					if batch.status == "running" {
						batch.status = Str::new_static("cancelled");
					}
				}
			}
			let last = state.last_receipt.clone();
			let mut workers = Vec::with_capacity(state.workers.len());
			for worker in &mut state.workers {
				let (replacement_batches, replacement_batch_rx) = flume::unbounded();
				drop(replacement_batch_rx);
				let batches = std::mem::replace(&mut worker.handle.batches, replacement_batches);
				let (replacement_finished_tx, replacement_finished) = flume::unbounded();
				drop(replacement_finished_tx);
				let finished = std::mem::replace(&mut worker.handle.finished, replacement_finished);
				workers.push((
					worker.handle.cancel.clone(),
					batches,
					finished,
					worker.handle.abort.clone(),
				));
			}
			let summary = aggregate(&self.name, &state);
			(last, workers, summary)
		};
		let terminal_cancel = CancellationToken::new();
		let terminal_persist = self.persist_with(
			if cancelled {
				"workpool.cancelled"
			} else {
				"workpool.completed"
			},
			&terminal_cancel,
		);
		let _ = tokio::time::timeout(std::time::Duration::from_secs(1), terminal_persist).await;
		let mut completions = std::mem::take(&mut self.retired);
		for (cancel, batches, finished, abort) in workers {
			if cancelled {
				cancel.cancel();
			}
			drop(batches);
			completions.push((finished, abort));
		}
		let cancellation_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
		for (completion, abort) in completions {
			if cancelled {
				let remaining =
					cancellation_deadline.saturating_duration_since(tokio::time::Instant::now());
				if tokio::time::timeout(remaining, completion.recv_async())
					.await
					.is_err()
				{
					abort.abort();
				}
			} else {
				let _ = completion.recv_async().await;
			}
		}
		if cancelled {
			let staged = self
				.producer
				.cancelled(sf!("Pool `{}` cancelled", self.name), last.as_ref());
			self.deliver_terminal(staged).await;
		} else if let Some(last) = last {
			let staged = self
				.producer
				.completed(sf!("Pool `{}` drained", self.name), &last);
			self.deliver_terminal(staged).await;
		}
		JobSettlement {
			status:     Str::new_static(if cancelled { "cancelled" } else { "completed" }),
			output:     serde_json::value::to_raw_value(&json!({ "text": summary })).ok(),
			error:      cancelled.then(|| Str::new_static("workpool was cancelled")),
			completion: None,
		}
	}

	async fn deliver_terminal(
		&self,
		staged: Result<super::workpool::StagedWorkpoolObservation, WorkpoolProducerError>,
	) {
		let Ok(staged) = staged else {
			return;
		};
		let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
		loop {
			match self.producer.try_deliver(&staged) {
				Ok(_) => return,
				Err(WorkpoolProducerError::MailboxFull { .. })
					if tokio::time::Instant::now() < deadline =>
				{
					tokio::time::sleep(std::time::Duration::from_millis(5)).await;
				},
				Err(_) => return,
			}
		}
	}

	async fn deliver(
		&self,
		staged: Result<super::workpool::StagedWorkpoolObservation, WorkpoolProducerError>,
	) -> Result<WorkpoolReceipt, WorkpoolSchedulerError> {
		let staged = staged?;
		loop {
			match self.producer.try_deliver(&staged) {
				Ok(receipt) => return Ok(receipt),
				Err(WorkpoolProducerError::MailboxFull { .. }) => {
					tokio::select! {
						() = self.cancel.cancelled() => return Err(WorkpoolSchedulerError::Cancelled {
							pool: self.name.clone(),
						}),
						() = tokio::time::sleep(std::time::Duration::from_millis(5)) => {},
					}
				},
				Err(error) => return Err(error.into()),
			}
		}
	}
}

fn context_load(worker: &Worker) -> f64 {
	let tokens = worker.context_tokens.unwrap_or(0) as f64;
	worker
		.context_window
		.filter(|window| *window > 0)
		.map_or(tokens, |window| tokens / window as f64)
}

fn aggregate(name: &str, state: &Snapshot) -> String {
	let mut output = format!(
		"Pool `{name}` completed ({} item(s), {} batch(es)).",
		state.items.len(),
		state.batches.len()
	);
	output.push_str("\n\n## Items");
	for item in &state.items {
		let status: &'static str = item.state.into();
		output.push_str(&format!(
			"\n- [{}] {status} — {}",
			item.id,
			item.text.lines().next().unwrap_or_default()
		));
		if let Some(result) = &item.output {
			output.push_str("\n  Result: ");
			output.push_str(result);
		}
	}
	output.push_str("\n\n## Batch attempts");
	for batch in &state.batches {
		output
			.push_str(&format!("\n\n## {} · agent `{}` · {}", batch.id, batch.worker, batch.status));
		for item in &batch.items {
			let item = &state.items[*item];
			output.push_str(&format!(
				"\n- [{}] {}",
				item.id,
				item.text.lines().next().unwrap_or_default()
			));
		}
		if let Some(result) = &batch.output {
			output.push_str("\n\n");
			output.push_str(result);
		}
		output.push_str(&format!(
			"\nTranscript: history://{} · full output: agent://{}",
			batch.worker, batch.worker
		));
	}
	output.push_str("\n\nPool queue drained.");
	output
}

pub(super) fn job_handle(session: &Session, id: &str) -> Option<Handle> {
	let root = jobs::jobs_handle(session.dom())?;
	session.dom().children(root).iter().copied().find(|handle| {
		session.dom().get(*handle).is_some_and(|node| {
			matches!(node.tag, Tag::Known(KnownTag::Job | KnownTag::Subagent))
				&& node
					.prop(&PropKey::from(PropId::Id))
					.and_then(Value::as_str)
					== Some(id)
		})
	})
}

fn required_string(
	object: &serde_json::Map<String, Json>,
	key: &'static str,
) -> Result<Str, WorkpoolSchedulerError> {
	optional_string(object, key)?.ok_or(WorkpoolSchedulerError::MissingField { field: key })
}

fn optional_string(
	object: &serde_json::Map<String, Json>,
	key: &'static str,
) -> Result<Option<Str>, WorkpoolSchedulerError> {
	let Some(value) = object.get(key) else {
		return Ok(None);
	};
	let value = value
		.as_str()
		.ok_or(WorkpoolSchedulerError::StringField { field: key })?
		.trim();
	if value.is_empty() {
		return Err(WorkpoolSchedulerError::StringField { field: key });
	}
	Ok(Some(Str::new(value)))
}

fn optional_strings(
	object: &serde_json::Map<String, Json>,
	key: &'static str,
) -> Result<Option<Vec<Str>>, WorkpoolSchedulerError> {
	let Some(value) = object.get(key) else {
		return Ok(None);
	};
	let values = value
		.as_array()
		.ok_or(WorkpoolSchedulerError::StringArrayField { field: key })?;
	let mut output = Vec::with_capacity(values.len());
	for value in values {
		let value = value
			.as_str()
			.filter(|value| !value.is_empty())
			.ok_or(WorkpoolSchedulerError::StringArrayField { field: key })?;
		output.push(Str::new(value));
	}
	Ok(Some(output))
}

fn required_strings(
	object: &serde_json::Map<String, Json>,
	key: &'static str,
) -> Result<Vec<Str>, WorkpoolSchedulerError> {
	optional_strings(object, key)?.ok_or(WorkpoolSchedulerError::MissingField { field: key })
}

pub(super) fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

/// Typed scheduler and bridge failures.
#[derive(Debug, Error)]
pub enum WorkpoolSchedulerError {
	/// Bridge arguments were not an object.
	#[error("workpool() arguments must be an object")]
	ArgumentsObject,
	/// Required field is absent.
	#[error("workpool operation requires `{field}`")]
	MissingField {
		/// Required bridge field.
		field: &'static str,
	},
	/// String field is empty or has the wrong type.
	#[error("workpool `{field}` must be a non-empty string")]
	StringField {
		/// Malformed bridge field.
		field: &'static str,
	},
	/// String-array field is malformed.
	#[error("workpool `{field}` must be an array of non-empty strings")]
	StringArrayField {
		/// Malformed string-array field.
		field: &'static str,
	},
	/// Eval-defined tools are disabled by the live parent policy.
	#[error("eval-defined tools are disabled; set eval.tools.enabled=true to expose them")]
	EvalToolsDisabled,
	/// Requested names and authenticated registrations differ.
	#[error("workpool eval-tool registrations do not match the requested names")]
	EvalToolRegistrationMismatch,
	/// Retained eval-kernel registration control failed.
	#[error("workpool eval-tool registration failed")]
	EvalToolControl {
		/// Typed eval-kernel control failure.
		#[source]
		source: EvalToolControlError,
	},
	/// Pool name is empty.
	#[error("workpool name must not be empty")]
	EmptyName,
	/// Pool already exists for this owner.
	#[error("workpool `{pool}` already exists")]
	Duplicate {
		/// Conflicting pool name.
		pool: Str,
	},
	/// Pool does not exist for this owner.
	#[error("unknown workpool `{pool}`")]
	Unknown {
		/// Requested pool name.
		pool: Str,
	},
	/// Pool no longer accepts work.
	#[error("workpool `{pool}` is closed")]
	Closed {
		/// Closed pool name.
		pool: Str,
	},
	/// Pool scheduling was cancelled while delivering a transition.
	#[error("workpool `{pool}` was cancelled")]
	Cancelled {
		/// Cancelled pool name.
		pool: Str,
	},
	/// Unknown bridge operation.
	#[error("unknown workpool operation `{op}`")]
	UnknownOperation {
		/// Rejected bridge operation.
		op: Str,
	},
	/// A forwarded tool conflicted with or violated the child registry contract.
	#[error("workpool worker `{id}` eval-tool registry is invalid")]
	EvalRegistry {
		/// Worker whose child registry could not be constructed.
		id:     Str,
		/// Typed registry failure.
		#[source]
		source: omp_tool::RegistryError,
	},
	/// A child failed during production composition.
	#[error("workpool worker `{id}` failed to start")]
	WorkerSpawn {
		/// Requested worker id.
		id:     Str,
		/// Typed child-composition failure.
		#[source]
		source: Arc<SpawnError>,
	},
	/// A child exited before reporting successful admission.
	#[error("workpool worker `{id}` exited during startup")]
	WorkerExited {
		/// Worker that exited.
		id: Str,
	},
	/// Parent has no journal head.
	#[error("workpool parent session has no journal head")]
	MissingParentHead,
	/// Parent jobs component is unavailable.
	#[error("workpool parent jobs component is unavailable")]
	MissingJobs,
	/// Aggregate id collides with an existing job.
	#[error("workpool aggregate job id `{id}` already exists")]
	JobCollision {
		/// Conflicting aggregate job id.
		id: Str,
	},
	/// Authenticated observation producer rejected a transition.
	#[error(transparent)]
	Producer(#[from] WorkpoolProducerError),
	/// Kernel actor stopped before applying a requested session mutation.
	#[error("workpool session mutation actor is disconnected")]
	MutationDisconnected,
	/// Pool cancellation won before a requested session mutation committed.
	#[error("workpool session mutation was cancelled")]
	MutationCancelled,
	/// Parent journal mutation failed.
	#[error(transparent)]
	Session(#[from] omp_session::SessionError),
	/// Workpool snapshot retention failed.
	#[error(transparent)]
	Blob(#[from] omp_journal::blob::Error),
	/// JSON projection failed.
	#[error(transparent)]
	Json(#[from] serde_json::Error),
}
