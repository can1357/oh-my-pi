//! Environment-owned durable schedule journal and delivery loop.
//!
//! Schedule declarations and firing transitions are an append-only SQLite
//! journal. The in-memory projection is rebuilt solely by replay, so process
//! restart follows the same path as normal operation. A firing intent is
//! synced before the delivery backend is entered; the backend receives the
//! stable idempotency key and is required to deduplicate a replay after an
//! ambiguous process exit.

use std::{
	collections::{BTreeMap, BTreeSet},
	fs,
	path::Path,
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use omp_core::{Str, sf};

pub use crate::schedule_plan::BudgetReservation;
use crate::schedule_plan::{BudgetUsage, MAX_BACKFILL_RECOVERY, budget_allows, next_occurrence};

#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display, strum::EnumString)]
#[strum(serialize_all = "snake_case")]
enum MissedRunPolicy {
	Skip,
	Coalesce,
	Backfill,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, strum::Display, strum::EnumString)]
#[strum(serialize_all = "snake_case")]
enum UpgradePolicy {
	#[default]
	Pinned,
	Auto,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display, strum::EnumString)]
#[strum(serialize_all = "snake_case")]
enum ScheduleScope {
	Session,
	Project,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Trigger {
	Cron { expr: Str, timezone: Str },
	Every { interval: Duration, jitter: Duration, align: bool },
	At { epoch_ms: u64 },
	AfterIdle { idle: Duration },
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum AgentDelivery {
	Inject { prompt: Str },
	Spawn { spec_id: Str },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ScheduleBudget {
	pub(crate) max_usd_per_firing_micros: Option<u64>,
	pub(crate) max_usd_per_window_micros: Option<u64>,
	pub(crate) window:                    Duration,
	pub(crate) max_requests_per_firing:   Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display, strum::EnumString)]
#[strum(serialize_all = "snake_case")]
enum FiringOutcome {
	Injected,
	Spawned,
	Skipped,
	Failed,
	Duplicate,
	BudgetRefused,
}
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use thiserror::Error;

const MAX_RECOVERED_OCCURRENCES: usize = 100_000;
const DEFAULT_HISTORY_LIMIT: usize = 20;

/// Authenticated owner fields captured with a schedule declaration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduleCaller {
	/// Durable agent/session identity that owns the declaration name.
	pub owner:              Str,
	/// Authenticated extension identity.
	pub extension_owner:    Str,
	/// Principal charged for unattended work.
	pub principal:          Str,
	/// Admitted extension artifact digest.
	pub artifact_digest:    Str,
	/// Extension-host generation fence.
	pub host_generation:    u64,
	/// Agent-session generation fence.
	pub session_generation: u64,
}

/// Durable schedule projection returned by CONTROL operations.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduleRow {
	/// Stable declaration identity.
	pub id:                 Str,
	/// Owner-local declaration name.
	pub name:               Str,
	/// Tagged cron/every/at/after-idle trigger.
	pub trigger:            Value,
	/// Tagged inject/spawn target.
	pub delivery:           Value,
	/// Session or project persistence scope.
	pub scope:              Str,
	/// Whether clock delivery is armed.
	pub enabled:            bool,
	/// Durable Agent identity receiving delivery.
	pub owner:              Str,
	/// Authenticated extension owning mutation rights.
	pub extension_owner:    Str,
	/// Principal charged for work.
	pub principal:          Str,
	/// Pinned declaration artifact digest.
	pub artifact_digest:    Str,
	/// Pinned or automatic artifact upgrade policy.
	pub upgrade:            Str,
	/// Skip, coalesce, or backfill recovery policy.
	pub missed:             Str,
	/// Optional hard unattended-work budget.
	pub budget:             Value,
	/// Skip or queue overlap policy.
	pub overlap:            Str,
	/// Durable declaration timestamp.
	pub created_ms:         u64,
	/// Next nominal occurrence.
	pub next_ms:            Option<u64>,
	/// Latest completed nominal occurrence.
	pub last_ms:            Option<u64>,
	/// Completed non-duplicate firing count.
	pub fire_count:         u64,
	/// Missed or overlap-skipped occurrence count.
	pub miss_count:         u64,
	/// Declaration replacement generation.
	pub generation:         u64,
	/// Creating extension-host generation.
	pub host_generation:    u64,
	/// Creating Agent-session generation.
	pub session_generation: u64,
}

/// Stable request passed to the host delivery owner.
#[derive(Clone, Debug)]
pub struct ScheduleDeliveryRequest {
	/// Full declaration projection.
	pub schedule:             ScheduleRow,
	/// Stable `(schedule_id, scheduled_at_ms)` deduplication key.
	pub idempotency_key:      Str,
	/// Nominal occurrence time.
	pub at_ms:                u64,
	/// Durable scheduler-owner generation.
	pub scheduler_generation: u64,
	/// Declaration generation fence.
	pub schedule_generation:  u64,
}

/// Delivery result persisted with the firing outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduleDeliveryReceipt {
	/// Public manual-fire receipt (`delivered`, `woken`, `revived`, `buffered`).
	pub receipt:     Str,
	/// Durable run identity for spawn delivery.
	pub run_id:      Option<Str>,
	/// Actual receipt cost in millionths of one US dollar.
	pub cost_micros: u64,
	/// Actual provider request count.
	pub requests:    u64,
}

/// Host boundary used by the environment scheduler.
///
/// Implementations MUST attach an already-open owner agent or start its
/// durable session when absent. `deliver` MUST deduplicate by
/// [`ScheduleDeliveryRequest::idempotency_key`]; this closes the unavoidable
/// crash interval between external delivery and the journaled outcome.
#[async_trait::async_trait]
pub trait ScheduleDeliveryBackend: Send + Sync + 'static {
	/// Returns when the owner Agent most recently became settled.
	///
	/// `None` means the owner is active or unavailable. The default keeps
	/// `after_idle` declarations armed without firing until a lifecycle-aware
	/// host owner is installed.
	async fn settled_since_ms(&self, _schedule: &ScheduleRow) -> Result<Option<u64>, Str> {
		Ok(None)
	}

	/// Returns a conservative reservation before any unattended work starts.
	async fn estimate(&self, request: &ScheduleDeliveryRequest) -> Result<BudgetReservation, Str>;

	/// Starts, attaches, or injects through the existing Agent control surface.
	async fn deliver(
		&self,
		request: ScheduleDeliveryRequest,
	) -> Result<ScheduleDeliveryReceipt, Str>;
}

/// Scheduler storage, authentication, or delivery failure.
#[derive(Debug, Error)]
pub enum DurableScheduleError {
	/// SQLite journal or replay failed.
	#[error("schedule storage failed: {0}")]
	Storage(Str),
	/// Declaration identity is absent.
	#[error("schedule was not found")]
	NotFound,
	/// Caller does not own the declaration.
	#[error("schedule is not owned by this caller")]
	NotOwned,
	/// A replaced durable scheduler owner received a command.
	#[error("stale scheduler generation (expected {expected}, active {active})")]
	StaleGeneration {
		/// Scheduler generation captured by the command-producing handle.
		expected: u64,
		/// Generation currently owned by the durable scheduler task.
		active:   u64,
	},
	/// A declaration or operation field is invalid.
	#[error("invalid schedule field `{field}`: {reason}")]
	Invalid {
		/// Static wire-field name rejected by schedule validation.
		field:  &'static str,
		/// Human-readable validation failure produced by the scheduler.
		reason: Str,
	},
	/// The host delivery owner is absent or refused routing.
	#[error("schedule delivery owner is unavailable: {0}")]
	Delivery(Str),
	/// The durable owner task exited.
	#[error("durable scheduler owner stopped")]
	Closed,
}

impl From<rusqlite::Error> for DurableScheduleError {
	fn from(error: rusqlite::Error) -> Self {
		Self::Storage(Str::from(error.to_string()))
	}
}

impl From<serde_json::Error> for DurableScheduleError {
	fn from(error: serde_json::Error) -> Self {
		Self::Storage(Str::from(error.to_string()))
	}
}

/// Cloneable generation-fenced handle to the environment-owned scheduler.
#[derive(Clone)]
pub struct DurableScheduleHandle {
	commands:   flume::Sender<Command>,
	generation: u64,
}

impl DurableScheduleHandle {
	/// Active durable owner generation captured by this handle.
	pub const fn generation(&self) -> u64 {
		self.generation
	}

	/// Routes one authenticated agents schedule CONTROL operation.
	pub async fn request(
		&self,
		caller: ScheduleCaller,
		operation: impl Into<Str>,
		arguments: Map<String, Value>,
	) -> Result<Value, DurableScheduleError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send_async(Command::Request {
				expected_generation: self.generation,
				caller,
				operation: operation.into(),
				arguments,
				reply,
			})
			.await
			.map_err(|_| DurableScheduleError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| DurableScheduleError::Closed)?
	}

	/// Replaces the host delivery owner without replacing durable state.
	pub async fn bind_delivery(
		&self,
		backend: Arc<dyn ScheduleDeliveryBackend>,
	) -> Result<(), DurableScheduleError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send_async(Command::BindDelivery { expected_generation: self.generation, backend, reply })
			.await
			.map_err(|_| DurableScheduleError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| DurableScheduleError::Closed)?
	}

	/// Processes every occurrence due through `now_ms`.
	///
	/// This is a deterministic smoke/test hook and the same path used by the
	/// owned wall-clock loop.
	pub async fn process_due(&self, now_ms: u64) -> Result<(), DurableScheduleError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send_async(Command::ProcessDue {
				expected_generation: self.generation,
				now_ms,
				recovering: false,
				reply: Some(reply),
			})
			.await
			.map_err(|_| DurableScheduleError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| DurableScheduleError::Closed)?
	}

	/// Durably removes every session-scoped declaration when its owning Agent
	/// session lease ends. Project declarations are intentionally untouched.
	pub async fn expire_session(&self) -> Result<(), DurableScheduleError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send_async(Command::ExpireSession { expected_generation: self.generation, reply })
			.await
			.map_err(|_| DurableScheduleError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| DurableScheduleError::Closed)?
	}
}

/// Opens the journal, replays its projection, and starts the owned clock loop.
pub fn open_durable_scheduler(
	path: &Path,
	backend: Arc<dyn ScheduleDeliveryBackend>,
) -> Result<DurableScheduleHandle, DurableScheduleError> {
	open_scheduler(path, Some(backend), true)
}

/// Opens the same durable authority without a wall-clock task.
///
/// Intended for deterministic hosts and focused recovery tests.
pub fn open_durable_scheduler_manual(
	path: &Path,
	backend: Arc<dyn ScheduleDeliveryBackend>,
) -> Result<DurableScheduleHandle, DurableScheduleError> {
	open_scheduler(path, Some(backend), false)
}
/// Opens a durable authority whose clock remains disarmed until a host
/// delivery owner is bound.
pub fn open_durable_scheduler_unbound(
	path: &Path,
) -> Result<DurableScheduleHandle, DurableScheduleError> {
	open_scheduler(path, None, true)
}

fn open_scheduler(
	path: &Path,
	backend: Option<Arc<dyn ScheduleDeliveryBackend>>,
	run_clock: bool,
) -> Result<DurableScheduleHandle, DurableScheduleError> {
	let mut journal = ScheduleJournal::open(path)?;
	let generation = journal.bump_generation()?;
	let projection = journal.replay()?;
	let (commands, receiver) = flume::unbounded();
	let handle = DurableScheduleHandle { commands: commands.clone(), generation };
	let mut owner = Owner { journal, projection, generation, backend, busy_until: BTreeMap::new() };
	tokio::spawn(async move {
		if owner.backend.is_some() {
			let _ = owner.process_due(now_ms(), true).await;
		}
		loop {
			let deadline = (run_clock && owner.backend.is_some())
				.then(|| owner.projection.next_deadline())
				.flatten();
			if let Some(deadline) = deadline {
				tokio::select! {
					command = receiver.recv_async() => {
						let Ok(command) = command else { break };
						owner.handle(command).await;
					},
					() = tokio::time::sleep(Duration::from_millis(deadline.saturating_sub(now_ms()))) => {
						if let Err(error) = owner.process_due(now_ms(), false).await {
							tracing::warn!(%error, "durable schedule clock iteration failed");
							tokio::time::sleep(Duration::from_secs(1)).await;
						}
					},
				}
			} else {
				let Ok(command) = receiver.recv_async().await else {
					break;
				};
				owner.handle(command).await;
			}
		}
	});
	Ok(handle)
}

enum Command {
	Request {
		expected_generation: u64,
		caller:              ScheduleCaller,
		operation:           Str,
		arguments:           Map<String, Value>,
		reply:               flume::Sender<Result<Value, DurableScheduleError>>,
	},
	BindDelivery {
		expected_generation: u64,
		backend:             Arc<dyn ScheduleDeliveryBackend>,
		reply:               flume::Sender<Result<(), DurableScheduleError>>,
	},
	ProcessDue {
		expected_generation: u64,
		now_ms:              u64,
		recovering:          bool,
		reply:               Option<flume::Sender<Result<(), DurableScheduleError>>>,
	},
	ExpireSession {
		expected_generation: u64,
		reply:               flume::Sender<Result<(), DurableScheduleError>>,
	},
}

struct Owner {
	journal:    ScheduleJournal,
	projection: Projection,
	generation: u64,
	backend:    Option<Arc<dyn ScheduleDeliveryBackend>>,
	busy_until: BTreeMap<Str, u64>,
}

impl Owner {
	async fn handle(&mut self, command: Command) {
		match command {
			Command::Request { expected_generation, caller, operation, arguments, reply } => {
				let resume = operation.as_str() == "omp.agents.schedule.resume";
				let result = self
					.check_generation(expected_generation)
					.and_then(|()| self.authorize_generation(&caller))
					.and_then(|()| Ok(()));
				let result = match result {
					Ok(()) => self.request(caller, operation.as_str(), arguments).await,
					Err(error) => Err(error),
				};
				if resume && result.is_ok() {
					let _ = self.process_due(now_ms(), true).await;
				}
				let _ = reply.send(result);
			},
			Command::BindDelivery { expected_generation, backend, reply } => {
				let result = self.check_generation(expected_generation);
				if result.is_ok() {
					self.backend = Some(backend);
					let _ = self.process_due(now_ms(), true).await;
				}
				let _ = reply.send(result);
			},
			Command::ProcessDue { expected_generation, now_ms, recovering, reply } => {
				let result = self
					.check_generation(expected_generation)
					.and_then(|()| Ok(()));
				let result = match result {
					Ok(()) => self.process_due(now_ms, recovering).await,
					Err(error) => Err(error),
				};
				if let Some(reply) = reply {
					let _ = reply.send(result);
				}
			},
			Command::ExpireSession { expected_generation, reply } => {
				let result = self.check_generation(expected_generation).and_then(|()| {
					let ids: Vec<_> = self
						.projection
						.rows
						.values()
						.filter(|row| row.scope.as_str() == "session")
						.map(|row| row.id.clone())
						.collect();
					for id in ids {
						self.append(Event::Delete { id })?;
					}
					Ok(())
				});
				let _ = reply.send(result);
			},
		}
	}

	fn check_generation(&self, expected: u64) -> Result<(), DurableScheduleError> {
		let active = self.journal.active_generation()?;
		if expected == self.generation && self.generation == active {
			Ok(())
		} else {
			Err(DurableScheduleError::StaleGeneration { expected, active })
		}
	}

	fn authorize_generation(&self, caller: &ScheduleCaller) -> Result<(), DurableScheduleError> {
		let _ = caller;
		Ok(())
	}

	async fn request(
		&mut self,
		caller: ScheduleCaller,
		operation: &str,
		arguments: Map<String, Value>,
	) -> Result<Value, DurableScheduleError> {
		match operation {
			"omp.agents.schedule" => self.upsert(caller, arguments),
			"omp.agents.schedules" => self.list(&caller, &arguments),
			"omp.agents.unschedule" => self.unschedule(&caller, &arguments),
			"omp.agents.schedule.info" => self.info(&caller, &arguments),
			"omp.agents.schedule.history" => self.history(&caller, &arguments),
			"omp.agents.schedule.pause" => self.set_enabled(&caller, &arguments, false),
			"omp.agents.schedule.resume" => self.set_enabled(&caller, &arguments, true),
			"omp.agents.schedule.delete" => self.delete(&caller, &arguments),
			"omp.agents.schedule.fire_now" => {
				let id = required_string(&arguments, "schedule_id")?;
				let row = self.owned(&caller, id)?.clone();
				if !row.enabled {
					return Ok(Value::String("failed".to_owned()));
				}
				let result = self.fire(row.id.clone(), now_ms(), now_ms()).await?;
				Ok(Value::String(result.receipt.to_string()))
			},
			_ => Err(DurableScheduleError::Invalid {
				field:  "operation",
				reason: sf!("unsupported scheduler operation {operation}"),
			}),
		}
	}

	fn upsert(
		&mut self,
		caller: ScheduleCaller,
		arguments: Map<String, Value>,
	) -> Result<Value, DurableScheduleError> {
		let name = required_string(&arguments, "name")?;
		if name.is_empty() {
			return Err(invalid("name", "schedule name must be non-empty"));
		}
		let trigger = arguments.get("trigger").cloned().unwrap_or(Value::Null);
		let delivery = arguments.get("delivery").cloned().unwrap_or(Value::Null);
		let parsed_trigger = parse_trigger(&trigger)?;
		let parsed_delivery = parse_delivery(&delivery)?;
		let scope = arguments
			.get("scope")
			.and_then(Value::as_str)
			.unwrap_or("session");
		let parsed_scope = parse_scope(scope)?;
		let budget = arguments.get("budget").cloned().unwrap_or(Value::Null);
		let parsed_budget = parse_budget(&budget)?;
		if parsed_scope == ScheduleScope::Project
			&& matches!(parsed_delivery, AgentDelivery::Spawn { .. })
			&& parsed_budget.is_none()
		{
			return Err(invalid("budget", "project spawn schedules require a hard budget"));
		}
		if parsed_scope == ScheduleScope::Project
			&& matches!(parsed_delivery, AgentDelivery::Spawn { .. })
			&& parsed_budget.is_some_and(|budget| {
				budget.max_usd_per_firing_micros.is_none()
					&& budget.max_usd_per_window_micros.is_none()
					&& budget.max_requests_per_firing.is_none()
			}) {
			return Err(invalid("budget", "project spawn budget must contain a hard limit"));
		}
		let missed = arguments
			.get("missed")
			.and_then(Value::as_str)
			.unwrap_or("coalesce");
		parse_missed(missed)?;
		let upgrade = arguments
			.get("upgrade")
			.and_then(Value::as_str)
			.unwrap_or("pinned");
		parse_upgrade(upgrade)?;
		let overlap = arguments
			.get("overlap")
			.and_then(Value::as_str)
			.unwrap_or("skip");
		if !matches!(overlap, "skip" | "queue") {
			return Err(invalid("overlap", "expected skip or queue"));
		}
		let now = now_ms();
		let existing = self
			.projection
			.rows
			.values()
			.find(|row| {
				row.owner == caller.owner
					&& row.extension_owner == caller.extension_owner
					&& row.name.as_str() == name
			})
			.cloned();
		let id = existing
			.as_ref()
			.map_or_else(|| Str::from(omp_core::Ulid::generate().to_string()), |row| row.id.clone());
		let created_ms = existing.as_ref().map_or(now, |row| row.created_ms);
		let next_ms = initial_occurrence(&parsed_trigger, id.as_str(), created_ms, now)?;
		let row = ScheduleRow {
			id: id.clone(),
			name: Str::from(name),
			trigger,
			delivery,
			scope: Str::from(scope),
			enabled: true,
			owner: caller.owner,
			extension_owner: caller.extension_owner,
			principal: caller.principal,
			artifact_digest: caller.artifact_digest,
			upgrade: Str::from(upgrade),
			missed: Str::from(missed),
			budget,
			overlap: Str::from(overlap),
			created_ms,
			next_ms,
			last_ms: existing.as_ref().and_then(|row| row.last_ms),
			fire_count: existing.as_ref().map_or(0, |row| row.fire_count),
			miss_count: existing.as_ref().map_or(0, |row| row.miss_count),
			generation: existing
				.as_ref()
				.map_or(1, |row| row.generation.saturating_add(1)),
			host_generation: caller.host_generation,
			session_generation: caller.session_generation,
		};
		self.append(Event::Upsert { row: row.clone() })?;
		Ok(json!({"id": id, "name": name}))
	}

	fn list(
		&self,
		caller: &ScheduleCaller,
		arguments: &Map<String, Value>,
	) -> Result<Value, DurableScheduleError> {
		let scope = arguments.get("scope").and_then(Value::as_str);
		let owner = arguments.get("owner").and_then(Value::as_str);
		let rows = self
			.projection
			.rows
			.values()
			.filter(|row| self.can_read(caller, row))
			.filter(|row| scope.is_none_or(|scope| row.scope.as_str() == scope))
			.filter(|row| owner.is_none_or(|owner| row.owner.as_str() == owner))
			.map(serde_json::to_value)
			.collect::<Result<Vec<_>, _>>()?;
		Ok(Value::Array(rows))
	}

	fn unschedule(
		&mut self,
		caller: &ScheduleCaller,
		arguments: &Map<String, Value>,
	) -> Result<Value, DurableScheduleError> {
		let reference = required_string(arguments, "name_or_id")?;
		let id = self
			.projection
			.rows
			.values()
			.find(|row| {
				(row.id.as_str() == reference || row.name.as_str() == reference)
					&& self.can_read(caller, row)
			})
			.map(|row| row.id.clone());
		let Some(id) = id else {
			return Ok(Value::Bool(false));
		};
		self.append(Event::Delete { id })?;
		Ok(Value::Bool(true))
	}

	fn info(
		&self,
		caller: &ScheduleCaller,
		arguments: &Map<String, Value>,
	) -> Result<Value, DurableScheduleError> {
		let row = self.owned(caller, required_string(arguments, "schedule_id")?)?;
		Ok(serde_json::to_value(row)?)
	}

	fn history(
		&self,
		caller: &ScheduleCaller,
		arguments: &Map<String, Value>,
	) -> Result<Value, DurableScheduleError> {
		let id = required_string(arguments, "schedule_id")?;
		self.owned(caller, id)?;
		let limit = arguments
			.get("limit")
			.and_then(Value::as_u64)
			.and_then(|value| usize::try_from(value).ok())
			.unwrap_or(DEFAULT_HISTORY_LIMIT);
		Ok(Value::Array(
			self
				.projection
				.history
				.get(id)
				.into_iter()
				.flatten()
				.rev()
				.take(limit)
				.map(FiringRecord::public_json)
				.collect(),
		))
	}

	fn set_enabled(
		&mut self,
		caller: &ScheduleCaller,
		arguments: &Map<String, Value>,
		enabled: bool,
	) -> Result<Value, DurableScheduleError> {
		let id = required_string(arguments, "schedule_id")?;
		let mut row = self.owned(caller, id)?.clone();
		row.enabled = enabled;
		row.generation = row.generation.saturating_add(1);
		if enabled && row.next_ms.is_none() {
			let trigger = parse_trigger(&row.trigger)?;
			row.next_ms = initial_occurrence(&trigger, row.id.as_str(), row.created_ms, now_ms())?;
		}
		self.append(Event::Upsert { row })?;
		Ok(Value::Null)
	}

	fn delete(
		&mut self,
		caller: &ScheduleCaller,
		arguments: &Map<String, Value>,
	) -> Result<Value, DurableScheduleError> {
		let id = required_string(arguments, "schedule_id")?;
		self.owned(caller, id)?;
		self.append(Event::Delete { id: Str::from(id) })?;
		Ok(Value::Null)
	}

	fn owned<'a>(
		&'a self,
		caller: &ScheduleCaller,
		id: &str,
	) -> Result<&'a ScheduleRow, DurableScheduleError> {
		let row = self
			.projection
			.rows
			.get(id)
			.ok_or(DurableScheduleError::NotFound)?;
		if self.can_read(caller, row) {
			Ok(row)
		} else {
			Err(DurableScheduleError::NotOwned)
		}
	}

	fn can_read(&self, caller: &ScheduleCaller, row: &ScheduleRow) -> bool {
		row.owner == caller.owner && row.extension_owner == caller.extension_owner
	}

	async fn process_due(&mut self, now: u64, recovering: bool) -> Result<(), DurableScheduleError> {
		let pending: Vec<_> = self.projection.pending.values().cloned().collect();
		for firing in pending {
			let schedule_id = firing.schedule_id.clone();
			let at_ms = firing.at_ms;
			let result = self.finish_pending(firing, now).await?;
			if result.outcome != FiringOutcome::Duplicate
				&& let Some(mut row) = self.projection.rows.get(schedule_id.as_str()).cloned()
				&& row.next_ms == Some(at_ms)
			{
				let trigger = parse_trigger(&row.trigger)?;
				row.next_ms = next_occurrence(&trigger, row.id.as_str(), row.created_ms, at_ms)
					.map_err(|error| invalid("trigger", error.to_string()))?;
				if matches!(trigger, Trigger::At { .. }) {
					row.enabled = false;
				}
				self.append(Event::Upsert { row })?;
			}
		}
		let ids: Vec<_> = self
			.projection
			.rows
			.values()
			.filter(|row| row.enabled && row.next_ms.is_some_and(|next| next <= now))
			.map(|row| row.id.clone())
			.collect();
		for id in ids {
			self
				.process_schedule_due(id.as_str(), now, recovering)
				.await?;
		}
		Ok(())
	}

	async fn process_schedule_due(
		&mut self,
		id: &str,
		now: u64,
		recovering: bool,
	) -> Result<(), DurableScheduleError> {
		let mut row = self
			.projection
			.rows
			.get(id)
			.cloned()
			.ok_or(DurableScheduleError::NotFound)?;
		let trigger = parse_trigger(&row.trigger)?;
		if let Trigger::AfterIdle { idle } = &trigger {
			let backend =
				self.backend.as_ref().map(Arc::clone).ok_or_else(|| {
					DurableScheduleError::Delivery(Str::from("delivery owner is absent"))
				})?;
			let settled_since = backend
				.settled_since_ms(&row)
				.await
				.map_err(DurableScheduleError::Delivery)?;
			let idle_ms = u64::try_from(idle.as_millis()).unwrap_or(u64::MAX);
			let target = settled_since.and_then(|since| since.checked_add(idle_ms));
			if target.is_none()
				|| target.is_some_and(|target| row.last_ms.is_some_and(|last| last >= target))
			{
				row.next_ms = Some(now.saturating_add(idle_ms.max(1_000)));
				self.append(Event::Upsert { row })?;
				return Ok(());
			}
			if let Some(target) = target
				&& target > now
			{
				row.next_ms = Some(target);
				self.append(Event::Upsert { row })?;
				return Ok(());
			}
			row.next_ms = target;
		}
		let mut due = Vec::new();
		let Some(mut cursor) = row.next_ms else {
			return Ok(());
		};
		while cursor <= now && due.len() < MAX_RECOVERED_OCCURRENCES {
			due.push(cursor);
			let Some(next) = next_occurrence(&trigger, id, row.created_ms, cursor)
				.map_err(|error| invalid("trigger", error.to_string()))?
			else {
				break;
			};
			cursor = next;
		}
		if due.len() == MAX_RECOVERED_OCCURRENCES && cursor <= now {
			return Err(invalid("trigger", "too many missed occurrences to recover safely"));
		}
		let mut selected = due.clone();
		let mut skipped = 0_u64;
		let mut journaled_skips = 0_u64;
		if !recovering
			&& row.overlap.as_str() == "skip"
			&& let Some(busy_until) = self.busy_until.get(id).copied()
		{
			let overlapping: Vec<_> = selected
				.iter()
				.copied()
				.filter(|at_ms| *at_ms <= busy_until)
				.collect();
			selected.retain(|at_ms| *at_ms > busy_until);
			for at_ms in overlapping {
				self.skip_occurrence(
					&row,
					at_ms,
					now,
					"previous firing was still active at this occurrence",
				)?;
				skipped = skipped.saturating_add(1);
				journaled_skips = journaled_skips.saturating_add(1);
			}
		}
		let missed_context =
			recovering || matches!(&trigger, Trigger::At { epoch_ms } if *epoch_ms < row.created_ms);
		if missed_context {
			match parse_missed(row.missed.as_str())? {
				MissedRunPolicy::Skip => {
					skipped = due.len() as u64;
					selected.clear();
				},
				MissedRunPolicy::Coalesce if due.len() > 1 => {
					skipped = (due.len() - 1) as u64;
					selected = due.last().copied().into_iter().collect();
				},
				MissedRunPolicy::Backfill if due.len() > MAX_BACKFILL_RECOVERY => {
					selected.truncate(MAX_BACKFILL_RECOVERY);
					if let Some(last) = due.last().copied()
						&& selected.last().copied() != Some(last)
					{
						selected.push(last);
					}
					skipped = (due.len() - selected.len()) as u64;
				},
				_ => {},
			}
		}
		for at_ms in selected {
			if !missed_context
				&& row.overlap.as_str() == "skip"
				&& self
					.busy_until
					.get(id)
					.is_some_and(|busy_until| at_ms <= *busy_until)
			{
				self.skip_occurrence(
					&row,
					at_ms,
					now,
					"previous firing was still active at this occurrence",
				)?;
				skipped = skipped.saturating_add(1);
				journaled_skips = journaled_skips.saturating_add(1);
				continue;
			}
			let _ = self.fire(row.id.clone(), at_ms, now).await?;
		}
		let mut updated = self
			.projection
			.rows
			.get(id)
			.cloned()
			.unwrap_or_else(|| row.clone());
		updated.miss_count = updated
			.miss_count
			.saturating_add(skipped.saturating_sub(journaled_skips));
		updated.next_ms = next_occurrence(&trigger, id, row.created_ms, *due.last().unwrap_or(&now))
			.map_err(|error| invalid("trigger", error.to_string()))?;
		if let Trigger::AfterIdle { idle } = &trigger {
			updated.next_ms = Some(
				now.saturating_add(
					u64::try_from(idle.as_millis())
						.unwrap_or(u64::MAX)
						.max(1_000),
				),
			);
		}
		if matches!(trigger, Trigger::At { .. }) {
			updated.enabled = false;
		}
		if let Some(current) = self.projection.rows.get(id)
			&& current.generation == row.generation
		{
			self.append(Event::Upsert { row: updated })?;
		}
		Ok(())
	}

	fn skip_occurrence(
		&mut self,
		row: &ScheduleRow,
		at_ms: u64,
		now: u64,
		detail: &str,
	) -> Result<(), DurableScheduleError> {
		let key = sf!("{}:{at_ms}", row.id.as_str());
		if self.projection.completed.contains(key.as_str()) {
			return Ok(());
		}
		let intent = FiringRecord::intent(row, key, at_ms, now, self.generation);
		self.append(Event::FiringIntent { firing: intent.clone() })?;
		let outcome = intent.finished(FiringOutcome::Skipped, None, Some(Str::from(detail)), 0, 0);
		self.append(Event::FiringOutcome { firing: outcome })
	}

	async fn fire(
		&mut self,
		schedule_id: Str,
		at_ms: u64,
		now: u64,
	) -> Result<FireResult, DurableScheduleError> {
		let row = self
			.projection
			.rows
			.get(schedule_id.as_str())
			.cloned()
			.ok_or(DurableScheduleError::NotFound)?;
		let key = sf!("{}:{at_ms}", schedule_id.as_str());
		if self.projection.completed.contains(key.as_str()) {
			let firing = FiringRecord::outcome(
				&row,
				key,
				at_ms,
				now,
				FiringOutcome::Duplicate,
				None,
				Some(Str::from("completed firing replay was deduplicated")),
				0,
				0,
				self.generation,
			);
			self.append(Event::FiringOutcome { firing })?;
			return Ok(FireResult {
				receipt: Str::from("delivered"),
				outcome: FiringOutcome::Duplicate,
			});
		}
		let firing = FiringRecord::intent(&row, key, at_ms, now, self.generation);
		self.append(Event::FiringIntent { firing: firing.clone() })?;
		self.finish_pending(firing, now).await
	}

	async fn finish_pending(
		&mut self,
		firing: FiringRecord,
		now: u64,
	) -> Result<FireResult, DurableScheduleError> {
		if self
			.projection
			.completed
			.contains(firing.idempotency_key.as_str())
		{
			return Ok(FireResult {
				receipt: Str::from("delivered"),
				outcome: FiringOutcome::Duplicate,
			});
		}
		let Some(row) = self
			.projection
			.rows
			.get(firing.schedule_id.as_str())
			.cloned()
		else {
			let outcome = firing.finished(
				FiringOutcome::Failed,
				None,
				Some(Str::from("schedule was deleted before pending intent recovery")),
				0,
				0,
			);
			self.append(Event::FiringOutcome { firing: outcome })?;
			return Ok(FireResult { receipt: Str::from("failed"), outcome: FiringOutcome::Failed });
		};
		if row.generation != firing.schedule_generation {
			let outcome = firing.finished(
				FiringOutcome::Skipped,
				None,
				Some(Str::from("declaration generation was replaced before delivery")),
				0,
				0,
			);
			self.append(Event::FiringOutcome { firing: outcome })?;
			return Ok(FireResult { receipt: Str::from("failed"), outcome: FiringOutcome::Skipped });
		}
		let request = ScheduleDeliveryRequest {
			schedule:             row.clone(),
			idempotency_key:      firing.idempotency_key.clone(),
			at_ms:                firing.at_ms,
			scheduler_generation: self.generation,
			schedule_generation:  row.generation,
		};
		let Some(backend) = self.backend.as_ref().map(Arc::clone) else {
			return Err(DurableScheduleError::Delivery(Str::from(
				"delivery owner has not been bound",
			)));
		};
		let reservation = match backend.estimate(&request).await {
			Ok(reservation) => reservation,
			Err(error) => {
				let outcome = firing.finished(FiringOutcome::Failed, None, Some(error), 0, 0);
				self.append(Event::FiringOutcome { firing: outcome })?;
				return Ok(FireResult { receipt: Str::from("failed"), outcome: FiringOutcome::Failed });
			},
		};
		if let Some(budget) = parse_budget(&row.budget)? {
			let window_ms = u64::try_from(budget.window.as_millis()).unwrap_or(u64::MAX);
			let usage = self
				.projection
				.budget_usage(row.id.as_str(), now.saturating_sub(window_ms));
			if !budget_allows(budget, usage, reservation) {
				let outcome = firing.finished(
					FiringOutcome::BudgetRefused,
					None,
					Some(Str::from("hard schedule budget refused delivery reservation")),
					0,
					0,
				);
				self.append(Event::FiringOutcome { firing: outcome })?;
				return Ok(FireResult {
					receipt: Str::from("failed"),
					outcome: FiringOutcome::BudgetRefused,
				});
			}
		}
		let delivery = backend.deliver(request).await;
		self.busy_until.insert(row.id.clone(), now_ms());
		match delivery {
			Ok(receipt) => {
				let parsed = parse_delivery(&row.delivery)?;
				let durable_outcome = match parsed {
					AgentDelivery::Inject { .. } => FiringOutcome::Injected,
					AgentDelivery::Spawn { .. } => FiringOutcome::Spawned,
				};
				let public_receipt = receipt.receipt.clone();
				let outcome = firing.finished(
					durable_outcome,
					receipt.run_id,
					None,
					receipt.cost_micros,
					receipt.requests,
				);
				self.append(Event::FiringOutcome { firing: outcome })?;
				Ok(FireResult { receipt: public_receipt, outcome: durable_outcome })
			},
			Err(error) => {
				let outcome = firing.finished(FiringOutcome::Failed, None, Some(error), 0, 0);
				self.append(Event::FiringOutcome { firing: outcome })?;
				Ok(FireResult { receipt: Str::from("failed"), outcome: FiringOutcome::Failed })
			},
		}
	}

	fn append(&mut self, event: Event) -> Result<(), DurableScheduleError> {
		self.journal.append(self.generation, &event)?;
		self.projection.apply(event);
		Ok(())
	}
}

struct FireResult {
	receipt: Str,
	outcome: FiringOutcome,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct FiringRecord {
	schedule_id:          Str,
	idempotency_key:      Str,
	at_ms:                u64,
	late_ms:              u64,
	outcome:              Option<Str>,
	artifact_digest:      Str,
	principal:            Str,
	run_id:               Option<Str>,
	detail:               Option<Str>,
	cost_micros:          u64,
	requests:             u64,
	#[serde(default)]
	completed_ms:         u64,
	scheduler_generation: u64,
	schedule_generation:  u64,
}

impl FiringRecord {
	fn intent(row: &ScheduleRow, key: Str, at_ms: u64, now: u64, scheduler_generation: u64) -> Self {
		Self {
			schedule_id: row.id.clone(),
			idempotency_key: key,
			at_ms,
			late_ms: now.saturating_sub(at_ms),
			outcome: None,
			artifact_digest: row.artifact_digest.clone(),
			principal: row.principal.clone(),
			run_id: None,
			detail: None,
			cost_micros: 0,
			requests: 0,
			completed_ms: 0,
			scheduler_generation,
			schedule_generation: row.generation,
		}
	}

	#[allow(clippy::too_many_arguments)]
	fn outcome(
		row: &ScheduleRow,
		key: Str,
		at_ms: u64,
		now: u64,
		outcome: FiringOutcome,
		run_id: Option<Str>,
		detail: Option<Str>,
		cost_micros: u64,
		requests: u64,
		scheduler_generation: u64,
	) -> Self {
		Self::intent(row, key, at_ms, now, scheduler_generation).finished(
			outcome,
			run_id,
			detail,
			cost_micros,
			requests,
		)
	}

	fn finished(
		mut self,
		outcome: FiringOutcome,
		run_id: Option<Str>,
		detail: Option<Str>,
		cost_micros: u64,
		requests: u64,
	) -> Self {
		self.outcome = Some(Str::from(outcome.to_string()));
		self.run_id = run_id;
		self.detail = detail;
		self.cost_micros = cost_micros;
		self.requests = requests;
		self.completed_ms = now_ms();
		self
	}

	fn public_json(&self) -> Value {
		json!({
			"schedule_id": self.schedule_id,
			"idempotency_key": self.idempotency_key,
			"at_ms": self.at_ms,
			"late_ms": self.late_ms,
			"outcome": self.outcome,
			"artifact_digest": self.artifact_digest,
			"principal": self.principal,
			"run_id": self.run_id,
			"detail": self.detail,
		})
	}
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Event {
	Upsert { row: ScheduleRow },
	Delete { id: Str },
	FiringIntent { firing: FiringRecord },
	FiringOutcome { firing: FiringRecord },
}

#[derive(Default)]
struct Projection {
	rows:      BTreeMap<Str, ScheduleRow>,
	history:   BTreeMap<Str, Vec<FiringRecord>>,
	pending:   BTreeMap<Str, FiringRecord>,
	completed: BTreeSet<Str>,
}

impl Projection {
	fn apply(&mut self, event: Event) {
		match event {
			Event::Upsert { row } => {
				self.rows.insert(row.id.clone(), row);
			},
			Event::Delete { id } => {
				self.rows.remove(id.as_str());
			},
			Event::FiringIntent { firing } => {
				if !self.completed.contains(firing.idempotency_key.as_str()) {
					self.pending.insert(firing.idempotency_key.clone(), firing);
				}
			},
			Event::FiringOutcome { firing } => {
				self.pending.remove(firing.idempotency_key.as_str());
				if firing.outcome.as_deref() != Some("duplicate") {
					self.completed.insert(firing.idempotency_key.clone());
					if let Some(row) = self.rows.get_mut(firing.schedule_id.as_str()) {
						row.fire_count = row.fire_count.saturating_add(1);
						row.last_ms = Some(
							row.last_ms
								.map_or(firing.at_ms, |last| last.max(firing.at_ms)),
						);
						if firing.outcome.as_deref() == Some("skipped") {
							row.miss_count = row.miss_count.saturating_add(1);
						}
					}
				}
				self
					.history
					.entry(firing.schedule_id.clone())
					.or_default()
					.push(firing);
			},
		}
	}

	fn next_deadline(&self) -> Option<u64> {
		if !self.pending.is_empty() {
			return Some(0);
		}
		self
			.rows
			.values()
			.filter(|row| row.enabled)
			.filter_map(|row| row.next_ms)
			.min()
	}

	fn budget_usage(&self, schedule_id: &str, since_ms: u64) -> BudgetUsage {
		self
			.history
			.get(schedule_id)
			.into_iter()
			.flatten()
			.filter(|firing| firing.completed_ms >= since_ms)
			.fold(BudgetUsage::default(), |usage, firing| BudgetUsage {
				cost_micros: usage.cost_micros.saturating_add(firing.cost_micros),
				requests:    usage.requests.saturating_add(firing.requests),
			})
	}
}

struct ScheduleJournal {
	connection: Connection,
}

impl ScheduleJournal {
	fn open(path: &Path) -> Result<Self, DurableScheduleError> {
		if let Some(parent) = path.parent() {
			fs::create_dir_all(parent)
				.map_err(|error| DurableScheduleError::Storage(Str::from(error.to_string())))?;
		}
		let connection = Connection::open(path)?;
		connection.execute_batch(
			"PRAGMA journal_mode=WAL;
			 PRAGMA synchronous=FULL;
			 CREATE TABLE IF NOT EXISTS schedule_meta (
			   key TEXT PRIMARY KEY NOT NULL,
			   value INTEGER NOT NULL
			 );
			 CREATE TABLE IF NOT EXISTS schedule_journal (
			   sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			   owner_generation INTEGER NOT NULL,
			   written_ms INTEGER NOT NULL,
			   event_json TEXT NOT NULL
			 );",
		)?;
		Ok(Self { connection })
	}

	fn bump_generation(&mut self) -> Result<u64, DurableScheduleError> {
		let transaction = self.connection.transaction()?;
		let current = transaction
			.query_row("SELECT value FROM schedule_meta WHERE key = 'owner_generation'", [], |row| {
				row.get::<_, u64>(0)
			})
			.optional()?
			.unwrap_or(0);
		let next = current.saturating_add(1);
		transaction.execute(
			"INSERT INTO schedule_meta(key, value) VALUES('owner_generation', ?1)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			[next],
		)?;
		transaction.commit()?;
		Ok(next)
	}

	fn active_generation(&self) -> Result<u64, DurableScheduleError> {
		Ok(self.connection.query_row(
			"SELECT value FROM schedule_meta WHERE key = 'owner_generation'",
			[],
			|row| row.get(0),
		)?)
	}

	fn replay(&self) -> Result<Projection, DurableScheduleError> {
		let mut statement = self
			.connection
			.prepare("SELECT event_json FROM schedule_journal ORDER BY sequence")?;
		let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
		let mut projection = Projection::default();
		for row in rows {
			projection.apply(serde_json::from_str(&row?)?);
		}
		Ok(projection)
	}

	fn append(&mut self, generation: u64, event: &Event) -> Result<(), DurableScheduleError> {
		let payload = serde_json::to_string(event)?;
		let transaction = self.connection.transaction()?;
		let active = transaction.query_row(
			"SELECT value FROM schedule_meta WHERE key = 'owner_generation'",
			[],
			|row| row.get::<_, u64>(0),
		)?;
		if active != generation {
			return Err(DurableScheduleError::StaleGeneration { expected: generation, active });
		}
		transaction.execute(
			"INSERT INTO schedule_journal(owner_generation, written_ms, event_json)
			 VALUES(?1, ?2, ?3)",
			params![generation, now_ms(), payload],
		)?;
		transaction.commit()?;
		Ok(())
	}
}

fn initial_occurrence(
	trigger: &Trigger,
	id: &str,
	created_ms: u64,
	now: u64,
) -> Result<Option<u64>, DurableScheduleError> {
	if let Trigger::At { epoch_ms } = trigger {
		return Ok(Some(*epoch_ms));
	}
	next_occurrence(trigger, id, created_ms, now)
		.map_err(|error| invalid("trigger", error.to_string()))
}

fn parse_trigger(value: &Value) -> Result<Trigger, DurableScheduleError> {
	let object = value
		.as_object()
		.ok_or_else(|| invalid("trigger", "expected object"))?;
	match object.get("kind").and_then(Value::as_str) {
		Some("at") => Ok(Trigger::At { epoch_ms: required_u64(object, "epoch_ms", "trigger")? }),
		Some("every") => {
			let interval = required_u64(object, "interval_ms", "trigger")?;
			if interval == 0 {
				return Err(invalid("trigger", "every interval must be non-zero"));
			}
			Ok(Trigger::Every {
				interval: Duration::from_millis(interval),
				jitter:   Duration::from_millis(
					object.get("jitter_ms").and_then(Value::as_u64).unwrap_or(0),
				),
				align:    object
					.get("align")
					.and_then(Value::as_bool)
					.unwrap_or(false),
			})
		},
		Some("after_idle") => Ok(Trigger::AfterIdle {
			idle: Duration::from_millis(required_u64(object, "idle_ms", "trigger")?),
		}),
		Some("cron") => Ok(Trigger::Cron {
			expr:     Str::from(required_object_string(object, "expr", "trigger")?),
			timezone: Str::from(
				object
					.get("timezone")
					.and_then(Value::as_str)
					.unwrap_or("UTC"),
			),
		}),
		_ => Err(invalid("trigger", "unknown trigger kind")),
	}
}

fn parse_delivery(value: &Value) -> Result<AgentDelivery, DurableScheduleError> {
	let object = value
		.as_object()
		.ok_or_else(|| invalid("delivery", "expected object"))?;
	match object.get("kind").and_then(Value::as_str) {
		Some("inject") => Ok(AgentDelivery::Inject {
			prompt: Str::from(required_object_string(object, "prompt", "delivery")?),
		}),
		Some("spawn") => {
			let spec = object
				.get("spec")
				.ok_or_else(|| invalid("delivery", "spawn spec is required"))?;
			let spec_id = spec
				.as_object()
				.and_then(|spec| spec.get("id").or_else(|| spec.get("name")))
				.and_then(Value::as_str)
				.unwrap_or("inline");
			Ok(AgentDelivery::Spawn { spec_id: Str::from(spec_id) })
		},
		_ => Err(invalid("delivery", "unknown delivery kind")),
	}
}

fn parse_budget(value: &Value) -> Result<Option<ScheduleBudget>, DurableScheduleError> {
	if value.is_null() {
		return Ok(None);
	}
	let object = value
		.as_object()
		.ok_or_else(|| invalid("budget", "expected object"))?;
	let window_ms = object.get("window_ms").and_then(Value::as_u64).unwrap_or(0);
	let max_usd_per_firing_micros = optional_usd_micros(object, "max_usd_per_firing")?;
	let max_usd_per_window_micros = optional_usd_micros(object, "max_usd_per_window")?;
	if max_usd_per_window_micros.is_some() && window_ms == 0 {
		return Err(invalid("budget", "window_ms must be non-zero for a rolling limit"));
	}
	let max_requests_per_firing = match object.get("max_requests_per_firing") {
		None | Some(Value::Null) => None,
		Some(value) => Some(
			value
				.as_u64()
				.ok_or_else(|| invalid("budget", "max_requests_per_firing must be non-negative"))?,
		),
	};
	Ok(Some(ScheduleBudget {
		max_usd_per_firing_micros,
		max_usd_per_window_micros,
		window: Duration::from_millis(window_ms),
		max_requests_per_firing,
	}))
}

fn optional_usd_micros(
	object: &Map<String, Value>,
	name: &'static str,
) -> Result<Option<u64>, DurableScheduleError> {
	let Some(value) = object.get(name) else {
		return Ok(None);
	};
	if value.is_null() {
		return Ok(None);
	}
	let usd = value
		.as_f64()
		.filter(|usd| usd.is_finite() && *usd >= 0.0)
		.ok_or_else(|| invalid("budget", sf!("{name} must be a finite non-negative number")))?;
	let micros = (usd * 1_000_000.0).ceil();
	if micros > u64::MAX as f64 {
		return Err(invalid("budget", sf!("{name} exceeds the supported range")));
	}
	Ok(Some(micros as u64))
}

fn parse_scope(value: &str) -> Result<ScheduleScope, DurableScheduleError> {
	match value {
		"session" => Ok(ScheduleScope::Session),
		"project" => Ok(ScheduleScope::Project),
		_ => Err(invalid("scope", "expected session or project")),
	}
}

fn parse_missed(value: &str) -> Result<MissedRunPolicy, DurableScheduleError> {
	match value {
		"skip" => Ok(MissedRunPolicy::Skip),
		"coalesce" => Ok(MissedRunPolicy::Coalesce),
		"backfill" => Ok(MissedRunPolicy::Backfill),
		_ => Err(invalid("missed", "expected skip, coalesce, or backfill")),
	}
}

fn parse_upgrade(value: &str) -> Result<UpgradePolicy, DurableScheduleError> {
	match value {
		"pinned" => Ok(UpgradePolicy::Pinned),
		"auto" => Ok(UpgradePolicy::Auto),
		_ => Err(invalid("upgrade", "expected pinned or auto")),
	}
}

fn required_string<'a>(
	arguments: &'a Map<String, Value>,
	name: &'static str,
) -> Result<&'a str, DurableScheduleError> {
	arguments
		.get(name)
		.and_then(Value::as_str)
		.ok_or_else(|| invalid(name, "expected string"))
}

fn required_object_string<'a>(
	arguments: &'a Map<String, Value>,
	name: &'static str,
	field: &'static str,
) -> Result<&'a str, DurableScheduleError> {
	arguments
		.get(name)
		.and_then(Value::as_str)
		.ok_or_else(|| invalid(field, sf!("{name} must be a string")))
}

fn required_u64(
	arguments: &Map<String, Value>,
	name: &'static str,
	field: &'static str,
) -> Result<u64, DurableScheduleError> {
	arguments
		.get(name)
		.and_then(Value::as_u64)
		.ok_or_else(|| invalid(field, sf!("{name} must be a non-negative integer")))
}

fn invalid(field: &'static str, reason: impl Into<Str>) -> DurableScheduleError {
	DurableScheduleError::Invalid { field, reason: reason.into() }
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}
