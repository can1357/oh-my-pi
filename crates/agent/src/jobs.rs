//! Runtime supervision index rebuilt from the authoritative `<meta><jobs>`
//! tree.
//!
//! The board deliberately stores no durable job state.  Identities, kinds and
//! lifecycle status live in the session DOM; this module only connects those
//! elements to kill boundaries owned by the runtime.

use std::{
	sync::atomic::{AtomicUsize, Ordering},
	time::{SystemTime, UNIX_EPOCH},
};

use flume::Receiver;
use omp_core::{FastHashMap, Str};
use omp_dom::{Dom, Handle, KnownTag, Op, PropId, PropKey, Tag, Txn, Value};
use omp_journal::{
	EntryId,
	blob::{BlobRef, BlobStore},
	data::LaunchDaemonCompletion,
};
use omp_proto::toolhost::v1::HookEventId;
use omp_session::{LifecycleWork, Session};
use omp_tool::{CallOutcomeDetails, InvocationFeed, RegistryError, ToolIdentity};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use strum::{Display, EnumString, IntoStaticStr};
use tokio::{task::JoinHandle, time};
use tokio_util::sync::CancellationToken;

use crate::dispatch::{Committer, DispatchEvent, DispatchOptions, OutputStream};

/// The three execution shapes represented by the one job primitive.
#[derive(Clone, Copy, Debug, Deserialize, Display, EnumString, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum JobKind {
	/// A detached ordinary tool call.
	Tool,
	/// A child agent kernel.
	Subagent,
	/// A supervised process or daemon.
	Process,
}

#[derive(Clone, Copy, Debug, IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
enum DeliveryJobType {
	Bash,
	Task,
	Tool,
}

impl From<JobKind> for DeliveryJobType {
	fn from(kind: JobKind) -> Self {
		match kind {
			JobKind::Tool => Self::Tool,
			JobKind::Subagent => Self::Task,
			JobKind::Process => Self::Bash,
		}
	}
}

/// Terminal result produced by one owned execution unit.
#[derive(Debug)]
pub struct JobSettlement {
	/// Durable terminal status (`completed`, `cancelled`, or `failed`).
	pub status:     Str,
	/// Bounded typed output, when the job completed with a value.
	pub output:     Option<Box<RawValue>>,
	/// Stable terminal diagnostic, when present.
	pub error:      Option<Str>,
	/// Typed one-shot completion for a supervised process.
	pub completion: Option<LaunchDaemonCompletion>,
}

/// Durable fields projected from one `<job>` or `<subagent>` element.
#[derive(Clone, Debug)]
pub struct JobRecord {
	/// Current DOM handle.
	pub handle:      Handle,
	/// Stable durable identity.
	pub id:          Str,
	/// Shared job kind.
	pub kind:        JobKind,
	/// Journal-derived lifecycle status.
	pub status:      Str,
	/// User-facing execution type (`bash`, `task`, `eval`, or a tool identity).
	pub job_type:    Str,
	/// Nonempty work label captured when the job started.
	pub label:       Str,
	/// Owning session or agent identity, when present.
	pub owner:       Option<Str>,
	/// Start timestamp, when present.
	pub started:     Option<Str>,
	/// Exact elapsed wall time captured by the settlement patch.
	pub duration_ms: Option<u64>,
	/// Bounded serialized output projected from the DOM.
	pub output:      Option<Box<RawValue>>,
	/// Terminal diagnostic projected from the DOM.
	pub error:       Option<Str>,
	/// Tool-call entry owned by this detached job.
	pub call:        Option<EntryId>,
	/// Initial detached `tool.result@1` entry which created this job.
	pub detached_at: Option<EntryId>,
}

/// Live execution state retained after a tool call stops blocking its turn.
///
/// Durable identity and status remain in the DOM; this value owns only the
/// receiver, task and invocation feed needed to keep the execution unit alive.
pub(crate) struct DetachedCall {
	pub(crate) committer: Committer,
	pub(crate) identity:  ToolIdentity,
	pub(crate) call_id:   Str,
	pub(crate) call:      EntryId,
	pub(crate) options:   DispatchOptions,
	pub(crate) events:    Receiver<DispatchEvent>,
	pub(crate) task:      Option<JoinHandle<Result<(), RegistryError>>>,
	pub(crate) feed:      Option<InvocationFeed>,
	pub(crate) output:    OutputStream,
	pub(crate) closed:    bool,
}

type JobFactory = dyn Fn(CancellationToken) -> JoinHandle<JobSettlement> + Send + Sync + 'static;

struct RuntimeJob {
	record:    JobRecord,
	cancel:    CancellationToken,
	task:      Option<JoinHandle<JobSettlement>>,
	_detached: Option<DetachedCall>,
	/// A terminal call outcome recovered before its job settlement patch
	/// landed.
	recovered: Option<RecoveredSettlement>,
	/// A running tool or subagent whose execution unit no longer exists
	/// (re-derived by a forward rewind or process restart): nothing can ever
	/// settle it, so [`JobBoard::poll`] journals it `failed`.
	orphaned:  bool,
}

#[derive(Clone)]
struct RecoveredSettlement {
	is_error: bool,
	status:   Option<Str>,
	artifact: Option<BlobRef>,
	output:   Option<Box<RawValue>>,
	error:    Option<Str>,
}

/// Custom job property carrying the journal-first workpool snapshot used for
/// restart adoption.
pub const WORKPOOL_STATE: &str = "workpool_state";

/// Stable diagnostic journaled on a detached tool call that lost its
/// execution unit.
pub const ORPHANED_TOOL_JOB: &str =
	"detached tool execution was lost across a rewind or restart and cannot settle";
/// Stable diagnostic journaled on a subagent whose execution unit disappeared.
///
/// Settling the stale `running` node is what makes the durable child eligible
/// for the ordinary explicit revive path; leaving it live would make both
/// `wait` and revive hang forever.
pub const ORPHANED_SUBAGENT_JOB: &str =
	"subagent execution was lost across a rewind or restart and can be revived";

/// A disposable runtime index over the authoritative jobs subtree.
///
/// Rebuilding preserves a live execution unit by durable `id`, remaps it to
/// the newly-derived handle, and cancels units absent from the new tree.
pub struct JobBoard {
	jobs:           Mutex<FastHashMap<Handle, RuntimeJob>>,
	factories:      Mutex<FastHashMap<Str, std::sync::Arc<JobFactory>>>,
	hooks:          Mutex<Option<crate::LifecycleHooks>>,
	/// Largest settlement output published inline on a job element; larger
	/// outputs are spilled to the session blob store (ADR 0009: the DOM and
	/// every patch it emits stay bounded, the full result lives in the CAS).
	output_bound:   AtomicUsize,
	/// Dispatcher spill namespace. A detached artifact is copied into the
	/// session namespace before its durable job settlement references it.
	artifact_store: Mutex<Option<BlobStore>>,
}

impl Default for JobBoard {
	fn default() -> Self {
		Self {
			jobs:           Mutex::default(),
			factories:      Mutex::default(),
			hooks:          Mutex::default(),
			output_bound:   AtomicUsize::new(crate::DispatchPolicy::DEFAULT_MAX_OUTPUT_BYTES),
			artifact_store: Mutex::default(),
		}
	}
}

impl JobBoard {
	/// Creates an empty runtime index.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Aligns the inline settlement bound with the dispatcher's central
	/// `max_output_bytes`.
	pub fn set_output_bound(&self, bytes: usize) {
		self.output_bound.store(bytes, Ordering::Relaxed);
	}

	/// Supplies the dispatcher namespace from which detached output is pinned
	/// into the session blob store before the settlement patch is appended.
	pub fn set_artifact_store(&self, store: BlobStore) {
		*self.artifact_store.lock() = Some(store);
	}

	/// Installs the extension observer for `job_registered`/`job_settled`.
	pub fn set_lifecycle_hooks(&self, hooks: crate::LifecycleHooks) {
		*self.hooks.lock() = Some(hooks);
	}

	fn notify_registered(&self, record: &JobRecord) {
		let hooks = self.hooks.lock();
		let Some(hooks) = hooks.as_ref() else {
			return;
		};
		let _ = hooks.notify(
			HookEventId::HookEventJobRegistered,
			serde_json::json!({
				"job_id": record.id,
				"owner": record.owner.as_deref().unwrap_or("kernel"),
				"call_id": serde_json::Value::Null,
				"lifetime": "session",
				"expected_artifact": serde_json::Value::Null,
			}),
		);
	}

	fn notify_settled(&self, record: &JobRecord, settlement: &JobSettlement) {
		let hooks = self.hooks.lock();
		let Some(hooks) = hooks.as_ref() else {
			return;
		};
		let artifact = settlement.output.as_deref().and_then(|output| {
			serde_json::from_str::<serde_json::Value>(output.get())
				.ok()?
				.get("artifact")?
				.as_str()
				.map(str::to_owned)
		});
		let _ = hooks.notify(
			HookEventId::HookEventJobSettled,
			serde_json::json!({
				"job_id": record.id,
				"owner": record.owner.as_deref().unwrap_or("kernel"),
				"artifact": artifact,
				"failed": settlement.status.as_str() != "completed",
				"duration": format!("{}s", elapsed_ms(record.started.as_deref(), now_ms()) / 1_000),
			}),
		);
	}

	/// Attaches the runtime kill boundary for a job already present in the DOM.
	/// Returns false when `handle` is not a lifecycle-bearing job element.
	pub fn attach(&self, dom: &Dom, handle: Handle, cancel: CancellationToken) -> bool {
		let Some(record) = record(dom, handle) else {
			return false;
		};
		self.notify_registered(&record);
		self.jobs.lock().insert(handle, RuntimeJob {
			record,
			cancel,
			task: None,
			_detached: None,
			recovered: None,
			orphaned: false,
		});
		true
	}

	/// Adopts a timed-out tool execution already represented by a `<job>`
	/// element. Retaining its live receiver and task keeps the returned job
	/// reference observable and cancellable after the foreground turn resumes.
	pub(crate) fn adopt_tool_job(
		&self,
		session: &Session,
		id: &Str,
		cancel: CancellationToken,
		detached: DetachedCall,
	) -> bool {
		let Some(record) = records(session.dom())
			.into_iter()
			.find(|record| &record.id == id)
		else {
			return false;
		};
		self.notify_registered(&record);
		self.jobs.lock().insert(record.handle, RuntimeJob {
			record,
			cancel,
			task: None,
			_detached: Some(detached),
			recovered: None,
			orphaned: false,
		});
		true
	}

	/// Attaches an owned execution task to a DOM job.
	pub fn attach_task(
		&self,
		dom: &Dom,
		handle: Handle,
		cancel: CancellationToken,
		task: JoinHandle<JobSettlement>,
	) -> bool {
		let Some(record) = record(dom, handle) else {
			return false;
		};
		self.notify_registered(&record);
		self.jobs.lock().insert(handle, RuntimeJob {
			record,
			cancel,
			task: Some(task),
			_detached: None,
			recovered: None,
			orphaned: false,
		});
		true
	}

	/// Attaches a restartable execution factory for rewind/resume lifecycle.
	pub fn attach_restartable<F>(&self, dom: &Dom, handle: Handle, factory: F) -> bool
	where
		F: Fn(CancellationToken) -> JoinHandle<JobSettlement> + Send + Sync + 'static,
	{
		let Some(record) = record(dom, handle) else {
			return false;
		};
		let factory: std::sync::Arc<JobFactory> = std::sync::Arc::new(factory);
		let cancel = CancellationToken::new();
		let task = factory(cancel.clone());
		self.notify_registered(&record);
		self.factories.lock().insert(record.id.clone(), factory);
		self.jobs.lock().insert(handle, RuntimeJob {
			record,
			cancel,
			task: Some(task),
			_detached: None,
			recovered: None,
			orphaned: false,
		});
		true
	}

	/// Rebuilds the index after open or rewind. The DOM is the source of truth.
	pub fn rebuild(&self, session: &Session) {
		let records = records(session.dom());
		let mut jobs = self.jobs.lock();
		let mut by_id: FastHashMap<Str, RuntimeJob> = std::mem::take(&mut *jobs)
			.into_values()
			.map(|job| (job.record.id.clone(), job))
			.collect();
		for record in records {
			let mut job = by_id.remove(&record.id).unwrap_or_else(|| {
				let recovered = recovered_settlement(session.dom(), &record);
				RuntimeJob {
					// Terminal detached-tool artifacts and drained workpool
					// snapshots are adopted into their job nodes. A genuinely
					// running tool or child without an execution unit is
					// orphaned so wait/revive cannot hang.
					orphaned: restart_orphan(&record, recovered.as_ref()),
					recovered,
					record: record.clone(),
					cancel: CancellationToken::new(),
					task: None,
					_detached: None,
				}
			});
			let retained_live_owner =
				is_live_status(job.record.status.as_str()) && !job.orphaned && job.recovered.is_none();
			job.record = record.clone();
			if !is_live_status(record.status.as_str()) {
				job.recovered = None;
				job.orphaned = false;
			} else if !retained_live_owner && job.task.is_none() && job._detached.is_none() {
				job.recovered = recovered_settlement(session.dom(), &record);
				job.orphaned = restart_orphan(&record, job.recovered.as_ref());
			}
			jobs.insert(record.handle, job);
		}
		for job in by_id.into_values() {
			job.cancel.cancel();
		}
	}

	/// Commits every already-settled owned task to the authoritative job node.
	pub fn poll(&self, session: &mut Session) -> Result<Vec<JobRecord>, omp_session::SessionError> {
		let recovered = {
			let jobs = self.jobs.lock();
			jobs
				.iter()
				.filter_map(|(handle, job)| {
					job.recovered
						.clone()
						.map(|settlement| (*handle, settlement))
				})
				.collect::<Vec<_>>()
		};
		for (handle, settlement) in recovered {
			let settlement = self.materialize_recovered(session, settlement)?;
			self.commit(session, handle, settlement)?;
			if let Some(job) = self.jobs.lock().get_mut(&handle) {
				job.recovered = None;
			}
		}
		let orphaned = {
			let jobs = self.jobs.lock();
			jobs
				.iter()
				.filter(|(_, job)| job.orphaned)
				.map(|(handle, job)| (*handle, job.record.kind))
				.collect::<Vec<_>>()
		};
		for (handle, kind) in orphaned {
			let error = match kind {
				JobKind::Subagent => ORPHANED_SUBAGENT_JOB,
				JobKind::Tool | JobKind::Process => ORPHANED_TOOL_JOB,
			};
			self.commit(session, handle, JobSettlement {
				status:     Str::new_static("failed"),
				output:     None,
				error:      Some(Str::new_static(error)),
				completion: None,
			})?;
			if let Some(job) = self.jobs.lock().get_mut(&handle) {
				job.orphaned = false;
			}
		}
		let detached = {
			let mut jobs = self.jobs.lock();
			jobs
				.iter_mut()
				.filter_map(|(handle, job)| {
					let detached = job._detached.as_mut()?;
					match detached.poll(session) {
						Ok(Some(report)) => {
							job._detached = None;
							let settlement = recovered_settlement(session.dom(), &job.record).unwrap_or(
								RecoveredSettlement {
									is_error: report.is_error,
									status:   None,
									artifact: report.spilled,
									output:   None,
									error:    None,
								},
							);
							job.recovered = Some(settlement.clone());
							Some((*handle, settlement))
						},
						Ok(None) => None,
						Err(error) => {
							tracing::warn!(?error, "detached tool settlement failed");
							job._detached = None;
							let settlement = RecoveredSettlement {
								is_error: true,
								status:   None,
								artifact: None,
								output:   None,
								error:    Some(Str::new_static("detached tool settlement failed")),
							};
							job.recovered = Some(settlement.clone());
							Some((*handle, settlement))
						},
					}
				})
				.collect::<Vec<_>>()
		};
		for (handle, settlement) in detached {
			let settlement = self.materialize_recovered(session, settlement)?;
			self.commit(session, handle, settlement)?;
			if let Some(job) = self.jobs.lock().get_mut(&handle) {
				job.recovered = None;
			}
		}
		let finished = {
			let mut jobs = self.jobs.lock();
			jobs
				.iter_mut()
				.filter(|(_, job)| job.task.as_ref().is_some_and(JoinHandle::is_finished))
				.filter_map(|(handle, job)| job.task.take().map(|task| (*handle, task)))
				.collect::<Vec<_>>()
		};
		for (handle, mut task) in finished {
			let settlement = futures::FutureExt::now_or_never(&mut task)
				.and_then(Result::ok)
				.unwrap_or_else(|| JobSettlement {
					status:     Str::new_static("failed"),
					output:     None,
					error:      Some(Str::new_static("job execution unit ended without a settlement")),
					completion: None,
				});
			self.commit(session, handle, settlement)?;
		}
		self.rebuild(session);
		Ok(self.list())
	}

	/// Whether the named execution unit has finished but has not yet been
	/// committed to its DOM node.
	#[must_use]
	pub fn has_finished(&self, id: &str) -> bool {
		self.jobs.lock().values().any(|job| {
			job.record.id == id
				&& (job.orphaned
					|| job.recovered.is_some()
					|| job.task.as_ref().is_some_and(JoinHandle::is_finished)
					|| job._detached.as_ref().is_some_and(|detached| {
						detached.closed
							|| !detached.events.is_empty()
							|| detached.task.as_ref().is_some_and(JoinHandle::is_finished)
					}))
		})
	}

	/// Whether any owned execution unit has finished but not yet been
	/// committed to its DOM node (a cheap check the turn loop makes before
	/// deciding whether to poll).
	#[must_use]
	pub fn has_finished_units(&self) -> bool {
		self.jobs.lock().values().any(|job| {
			job.orphaned
				|| job.recovered.is_some()
				|| job.task.as_ref().is_some_and(JoinHandle::is_finished)
				|| job._detached.as_ref().is_some_and(|detached| {
					detached.closed
						|| !detached.events.is_empty()
						|| detached.task.as_ref().is_some_and(JoinHandle::is_finished)
				})
		})
	}

	/// Resolves once any owned execution unit finishes (never when none is
	/// live); used by hosts idling between turns.
	pub async fn any_finished(&self) {
		loop {
			if self.has_finished_units() {
				return;
			}
			let live = self.jobs.lock().values().any(|job| {
				job.task.is_some()
					|| job
						._detached
						.as_ref()
						.is_some_and(|detached| !detached.closed)
			});
			if !live {
				std::future::pending::<()>().await;
			}
			time::sleep(std::time::Duration::from_millis(25)).await;
		}
	}

	fn materialize_recovered(
		&self,
		session: &Session,
		settlement: RecoveredSettlement,
	) -> Result<JobSettlement, omp_session::SessionError> {
		let output = match settlement.output {
			Some(output) => Some(output),
			None => settlement
				.artifact
				.map(|artifact| self.pin_artifact(session, artifact))
				.transpose()?
				.map(|artifact| {
					serde_json::value::to_raw_value(&SpilledOutput {
						artifact: Str::new(format!("artifact://sha256/{}", artifact.to_hex())),
						byte_len: artifact.size,
						text:     None,
					})
				})
				.transpose()?,
		};
		Ok(JobSettlement {
			status: settlement.status.unwrap_or_else(|| {
				Str::new_static(if settlement.is_error {
					"failed"
				} else {
					"completed"
				})
			}),
			output,
			error: settlement.error,
			completion: None,
		})
	}

	fn pin_artifact(
		&self,
		session: &Session,
		reference: BlobRef,
	) -> Result<BlobRef, omp_session::SessionError> {
		if session.blobs().has(&reference) {
			if session.blobs().verify(&reference)? {
				return Ok(reference);
			}
			let bytes = session.blobs().get(&reference)?;
			return Err(
				omp_journal::blob::Error::DigestMismatch {
					expected: reference.hash,
					actual:   omp_core::Hash32::sum(&bytes),
				}
				.into(),
			);
		}
		let source = self
			.artifact_store
			.lock()
			.clone()
			.ok_or(omp_journal::blob::Error::NotFound)?;
		let bytes = source.get(&reference)?;
		let actual = omp_core::Hash32::sum(&bytes);
		if actual != reference.hash {
			return Err(
				omp_journal::blob::Error::DigestMismatch { expected: reference.hash, actual }.into(),
			);
		}
		let pinned = session.blobs().put(&bytes)?;
		Ok(pinned)
	}

	fn commit(
		&self,
		session: &mut Session,
		handle: Handle,
		settlement: JobSettlement,
	) -> Result<(), omp_session::SessionError> {
		if let Some(record) = record(session.dom(), handle) {
			self.notify_settled(&record, &settlement);
		}
		commit_settlement(session, handle, settlement, self.output_bound.load(Ordering::Relaxed))
	}

	/// Waits for the first selected job to settle while committing completions.
	pub async fn wait(
		&self,
		session: &mut Session,
		ids: Option<&[Str]>,
	) -> Result<Option<JobRecord>, omp_session::SessionError> {
		loop {
			let records = self.poll(session)?;
			if let Some(record) = records.into_iter().find(|record| {
				!is_live_status(record.status.as_str())
					&& ids.is_none_or(|selected| {
						selected.is_empty() || selected.iter().any(|id| id == &record.id)
					})
			}) {
				return Ok(Some(record));
			}
			let selected_live = self.list().into_iter().any(|record| {
				is_live_status(record.status.as_str())
					&& ids.is_none_or(|selected| {
						selected.is_empty() || selected.iter().any(|id| id == &record.id)
					})
			});
			if !selected_live {
				return Ok(None);
			}
			time::sleep(std::time::Duration::from_millis(10)).await;
		}
	}

	/// Applies lifecycle work returned by `Session::rewind`, then remaps
	/// retained handles. Removed executions are cooperatively cancelled and
	/// their owned tasks are force-aborted after a bounded grace. Added
	/// records are re-derived from `session` rather than left invisible.
	pub fn apply_lifecycle(
		&self,
		session: &Session,
		work: &LifecycleWork,
	) -> impl Future<Output = ()> + Send + 'static {
		let mut terminated = Vec::new();
		{
			let mut jobs = self.jobs.lock();
			for handle in &work.terminate {
				if let Some(job) = jobs.remove(handle) {
					job.cancel.cancel();
					terminated.push(job);
				}
			}
			for (old, new) in &work.retained {
				if let Some(mut job) = jobs.remove(old) {
					job.record.handle = *new;
					jobs.insert(*new, job);
				}
			}
		}
		self.rebuild(session);
		for handle in &work.spawn {
			let Some(record) = record(session.dom(), *handle) else {
				continue;
			};
			let Some(factory) = self.factories.lock().get(&record.id).cloned() else {
				continue;
			};
			let cancel = CancellationToken::new();
			let task = factory(cancel.clone());
			self.jobs.lock().insert(*handle, RuntimeJob {
				record,
				cancel,
				task: Some(task),
				_detached: None,
				recovered: None,
				orphaned: false,
			});
		}
		async move {
			for job in terminated {
				let _ = terminate_runtime(job).await;
			}
		}
	}

	/// Terminates one execution unit and journals `cancelled` on its DOM node.
	pub async fn terminate(
		&self,
		session: &mut Session,
		handle: Handle,
	) -> Result<bool, omp_session::SessionError> {
		let recovered = self
			.jobs
			.lock()
			.get(&handle)
			.and_then(|job| job.recovered.clone());
		if let Some(recovered) = recovered {
			let settlement = self.materialize_recovered(session, recovered)?;
			self.commit(session, handle, settlement)?;
			self.rebuild(session);
			return Ok(true);
		}
		let Some(job) = self.jobs.lock().remove(&handle) else {
			return Ok(false);
		};
		let settlement = terminate_runtime(job).await;
		self.commit(session, handle, settlement)?;
		self.rebuild(session);
		Ok(true)
	}

	/// Returns the current DOM-derived roster.
	#[must_use]
	pub fn list(&self) -> Vec<JobRecord> {
		let mut records = self
			.jobs
			.lock()
			.values()
			.map(|job| job.record.clone())
			.collect::<Vec<_>>();
		records.sort_by(|left, right| left.id.cmp(&right.id));
		records
	}
}

async fn terminate_runtime(mut job: RuntimeJob) -> JobSettlement {
	job.cancel.cancel();
	if let Some(mut task) = job.task.take()
		&& time::timeout(std::time::Duration::from_secs(1), &mut task)
			.await
			.is_err()
	{
		task.abort();
		let _ = task.await;
	}
	if let Some(detached) = &mut job._detached {
		if let Some(feed) = &detached.feed {
			let _ = feed.interrupt(omp_tool::Interrupt {
				class:  Str::new_static(omp_tool::Interrupt::ESCAPE),
				reason: Str::new_static("job removed by session lifecycle diff"),
			});
		}
		if let Some(mut task) = detached.task.take()
			&& time::timeout(std::time::Duration::from_secs(1), &mut task)
				.await
				.is_err()
		{
			task.abort();
			let _ = task.await;
		}
	}
	JobSettlement {
		status:     Str::new_static("cancelled"),
		output:     None,
		error:      None,
		completion: None,
	}
}

fn recovered_settlement(dom: &Dom, record: &JobRecord) -> Option<RecoveredSettlement> {
	recovered_workpool_settlement(dom, record).or_else(|| recovered_tool_settlement(dom, record))
}

fn recovered_workpool_settlement(dom: &Dom, record: &JobRecord) -> Option<RecoveredSettlement> {
	if record.kind != JobKind::Tool || !is_live_status(record.status.as_str()) {
		return None;
	}
	let node = dom.get(record.handle)?;
	let Value::Json(raw) = node.prop(&PropKey::Custom(Str::new_static(WORKPOOL_STATE)))? else {
		return None;
	};
	let state = serde_json::from_str::<serde_json::Value>(raw.get()).ok()?;
	if state.get("closed").and_then(serde_json::Value::as_bool) != Some(true) {
		return None;
	}
	let summary = state.get("summary").and_then(serde_json::Value::as_str)?;
	let status = state
		.get("terminal_status")
		.and_then(serde_json::Value::as_str)
		.filter(|status| matches!(*status, "completed" | "cancelled" | "failed"))
		.map_or_else(|| Str::new_static("completed"), Str::new);
	let is_error = status != "completed";
	let error = match status.as_str() {
		"cancelled" => Some(Str::new_static("workpool was cancelled")),
		"failed" => Some(Str::new_static("workpool failed before settlement delivery")),
		_ => None,
	};
	let output = serde_json::value::to_raw_value(&serde_json::json!({ "text": summary })).ok()?;
	Some(RecoveredSettlement {
		is_error,
		status: Some(status),
		artifact: None,
		output: Some(output),
		error,
	})
}

fn restart_orphan(record: &JobRecord, recovered: Option<&RecoveredSettlement>) -> bool {
	is_live_status(record.status.as_str())
		&& match record.kind {
			JobKind::Tool => recovered.is_none(),
			JobKind::Subagent => true,
			// The environment host owns durable process generations and may
			// reconnect them independently of this disposable board.
			JobKind::Process => false,
		}
}

fn recovered_tool_settlement(dom: &Dom, record: &JobRecord) -> Option<RecoveredSettlement> {
	if record.kind != JobKind::Tool || !is_live_status(record.status.as_str()) {
		return None;
	}
	let call = record.call?;
	let detached_at = record.detached_at?;
	let handle = find_call(dom, dom.body(), call)?;
	let node = dom.get(handle)?;
	let latest = custom(node, "result_entry")?.parse::<EntryId>().ok()?;
	if latest == detached_at {
		return None;
	}
	let is_error = match prop(node, PropId::Status)? {
		"ok" => false,
		"error" => true,
		_ => return None,
	};
	let artifact = call_artifact(dom, handle);
	let error = is_error.then(|| {
		dom.children(handle)
			.iter()
			.rev()
			.filter_map(|handle| dom.get(*handle))
			.find(|child| {
				child.tag == Tag::Known(KnownTag::Diag)
					&& prop(child, PropId::Severity) == Some("error")
			})
			.and_then(|child| prop(child, PropId::Text))
			.map_or_else(|| Str::new_static("detached tool failed"), Str::new)
	});
	Some(RecoveredSettlement { is_error, status: None, artifact, output: None, error })
}

fn find_call(dom: &Dom, parent: Handle, call: EntryId) -> Option<Handle> {
	let call = call.to_string();
	find_call_by_cause(dom, parent, &call)
}

fn find_call_by_cause(dom: &Dom, parent: Handle, call: &str) -> Option<Handle> {
	for handle in dom.children(parent) {
		let node = dom.get(*handle)?;
		if matches!(node.tag, Tag::Custom(_)) && prop(node, PropId::Cause) == Some(call) {
			return Some(*handle);
		}
		if let Some(found) = find_call_by_cause(dom, *handle, call) {
			return Some(found);
		}
	}
	None
}

fn call_artifact(dom: &Dom, call: Handle) -> Option<BlobRef> {
	let node = dom.get(call)?;
	if let (Some(address), Some(size)) =
		(prop(node, PropId::Blob), custom_int(node, "size").and_then(|size| u64::try_from(size).ok()))
		&& let Some(hash) = address.strip_prefix("artifact://sha256/")
	{
		return BlobRef::parse_hex(hash, size).ok();
	}
	let details = dom.children(call).iter().rev().find_map(|handle| {
		let child = dom.get(*handle)?;
		match child.tag {
			Tag::Known(KnownTag::Result) => match child.prop(&PropKey::from(PropId::Outcome)) {
				Some(Value::Json(raw)) => Some(raw),
				_ => None,
			},
			Tag::Known(KnownTag::Diag) => match child.prop(&PropKey::from(PropId::Fault)) {
				Some(Value::Json(raw)) => Some(raw),
				_ => None,
			},
			_ => None,
		}
	})?;
	let CallOutcomeDetails::Spilled { blob, byte_len } =
		serde_json::from_str::<CallOutcomeDetails>(details.get()).ok()?
	else {
		return None;
	};
	BlobRef::parse_hex(blob.hash.as_str(), byte_len).ok()
}

/// Inline shape of a settlement output that exceeded the board's bound: the
/// complete JSON is in the CAS at `artifact`, `text` keeps a bounded head of
/// the child's final text for actors and the async-result notice.
#[derive(Debug, Deserialize, Serialize)]
pub struct SpilledOutput {
	/// `artifact://sha256/<hex>` of the full settlement JSON.
	pub artifact: Str,
	/// Size of the full settlement JSON.
	pub byte_len: u64,
	/// Bounded head of the output's `text`, when it carried one.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub text:     Option<Str>,
}

/// Bounds one settlement output for the DOM: inline when it fits, else the
/// full JSON is spilled and a [`SpilledOutput`] stands in for it.
fn bounded_output(
	session: &Session,
	output: Box<RawValue>,
	bound: usize,
) -> Result<Box<RawValue>, omp_session::SessionError> {
	let raw = output.get();
	if raw.len() <= bound {
		return Ok(output);
	}
	let blob = session.blobs().put(raw.as_bytes())?;
	let text = serde_json::from_str::<serde_json::Value>(raw)
		.ok()
		.and_then(|value| {
			value
				.get("text")
				.and_then(serde_json::Value::as_str)
				.map(|text| Str::new(crate::dispatch::utf8_prefix(text, bound / 4)))
		});
	Ok(serde_json::value::to_raw_value(&SpilledOutput {
		artifact: Str::new(format!("artifact://sha256/{}", blob.to_hex())),
		byte_len: u64::try_from(raw.len()).unwrap_or(u64::MAX),
		text,
	})?)
}

/// Resolves a job's settlement output, reading a spilled one back from the
/// session blob store.
pub fn resolve_output(
	session: &Session,
	output: &RawValue,
) -> Result<Option<Box<RawValue>>, omp_session::SessionError> {
	let Ok(spilled) = serde_json::from_str::<SpilledOutput>(output.get()) else {
		return Ok(Some(RawValue::from_string(output.get().to_owned())?));
	};
	let Some(hex) = spilled.artifact.as_str().strip_prefix("artifact://sha256/") else {
		return Ok(None);
	};
	let reference = omp_journal::blob::BlobRef::parse_hex(hex, spilled.byte_len)?;
	let bytes = session.blobs().get(&reference)?;
	let json = std::str::from_utf8(&bytes)
		.map_err(|source| omp_session::SessionError::JobOutputUtf8 { source })?;
	Ok(Some(RawValue::from_string(json.to_owned())?))
}

fn commit_settlement(
	session: &mut Session,
	handle: Handle,
	settlement: JobSettlement,
	bound: usize,
) -> Result<(), omp_session::SessionError> {
	let cause = session
		.head()
		.ok_or(omp_session::SessionError::NoActiveTurn)?;
	let settled_at_ms = now_ms();
	let duration_ms = settlement.completion.as_ref().map_or_else(
		|| {
			record(session.dom(), handle)
				.map_or(0, |record| elapsed_ms(record.started.as_deref(), settled_at_ms))
		},
		|completion| completion.duration_ms,
	);
	let mut ops = vec![
		Op::Set {
			h:     handle,
			prop:  PropId::Status.into(),
			value: Value::Str(settlement.status.clone()),
		},
		Op::Set {
			h:     handle,
			prop:  PropId::DurationMs.into(),
			value: Value::Int(i64::try_from(duration_ms).unwrap_or(i64::MAX)),
		},
	];
	if let Some(output) = settlement.output {
		let output = bounded_output(session, output, bound)?;
		ops.push(Op::Set { h: handle, prop: PropId::Data.into(), value: Value::Json(output) });
	}
	if let Some(error) = settlement.error {
		ops.push(Op::Set {
			h:     handle,
			prop:  PropKey::Custom(Str::new_static("error")),
			value: Value::Str(error),
		});
	}
	if let Some(completion) = settlement.completion {
		ops.extend(crate::launch_completion_ops(session, handle, &completion)?);
	}
	session.patch(Txn { cause, label: Some(Str::new_static("jobs.settle")), ops })?;
	Ok(())
}

/// Whether a job or subagent owned by this session is still running: its
/// settlement will re-wake the loop with an async-result follow-up, so a
/// candidate yield is a scheduling pause.
#[must_use]
pub fn pending_wake(dom: &Dom) -> bool {
	records(dom)
		.iter()
		.any(|record| is_live_status(record.status.as_str()))
}

/// Settled jobs whose result has not yet been delivered to the model
/// (no `delivered` prop on the element), oldest first.
#[must_use]
pub fn undelivered(dom: &Dom) -> Vec<JobRecord> {
	let mut out = records(dom)
		.into_iter()
		.filter(|record| {
			!is_live_status(record.status.as_str())
				&& !dom
					.get(record.handle)
					.and_then(|node| node.prop(&PropKey::Custom(Str::new_static(DELIVERED))))
					.is_some_and(|value| matches!(value, Value::Bool(true)))
		})
		.collect::<Vec<_>>();
	out.sort_by(|left, right| {
		started_ms(left)
			.cmp(&started_ms(right))
			.then(left.id.cmp(&right.id))
	});
	out
}

/// Prop set on a settled job once its result reached the model.
pub const DELIVERED: &str = "delivered";

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

fn elapsed_ms(started: Option<&str>, settled_at_ms: u64) -> u64 {
	started
		.and_then(|started| started.parse::<u64>().ok())
		.map_or(0, |started_at_ms| settled_at_ms.saturating_sub(started_at_ms))
}

fn started_ms(record: &JobRecord) -> Option<u64> {
	record
		.started
		.as_deref()
		.and_then(|started| started.parse().ok())
}

fn is_live_status(status: &str) -> bool {
	matches!(status, "running" | "starting")
}

fn records(dom: &Dom) -> Vec<JobRecord> {
	let Some(jobs) = dom.children(dom.meta()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Jobs))
	}) else {
		return Vec::new();
	};
	let mut out = Vec::new();
	collect(dom, jobs, &mut out);
	out
}

fn collect(dom: &Dom, parent: Handle, out: &mut Vec<JobRecord>) {
	for handle in dom.children(parent) {
		if let Some(record) = record(dom, *handle) {
			out.push(record);
		}
		collect(dom, *handle, out);
	}
}

fn record(dom: &Dom, handle: Handle) -> Option<JobRecord> {
	let node = dom.get(handle)?;
	let kind = match node.tag {
		Tag::Known(KnownTag::Job) => prop(node, PropId::Kind)
			.and_then(|value| value.parse().ok())
			.unwrap_or(JobKind::Tool),
		Tag::Known(KnownTag::Subagent) => JobKind::Subagent,
		_ => return None,
	};
	Some(JobRecord {
		handle,
		id: prop(node, PropId::Id).map_or_else(|| Str::new(handle.to_string()), Str::new),
		kind,
		status: prop(node, PropId::Status).map_or_else(|| Str::new_static("running"), Str::new),
		job_type: prop(node, PropId::Name)
			.filter(|value| !value.is_empty())
			.map_or_else(|| fallback_job_type(kind), Str::new),
		label: prop(node, PropId::Label)
			.filter(|value| !value.is_empty())
			.map_or_else(
				|| prop(node, PropId::Id).map_or_else(|| Str::new(handle.to_string()), Str::new),
				Str::new,
			),
		owner: custom(node, "owner").map(Str::new),
		started: custom(node, "started").map(Str::new),
		duration_ms: prop_int(node, PropId::DurationMs).and_then(|value| u64::try_from(value).ok()),
		output: node
			.prop(&PropKey::from(PropId::Data))
			.and_then(|value| match value {
				Value::Json(raw) => RawValue::from_string(raw.get().to_owned()).ok(),
				_ => None,
			}),
		error: custom(node, "error").map(Str::new),
		call: custom(node, "call").and_then(|value| value.parse().ok()),
		detached_at: prop(node, PropId::Cause).and_then(|value| value.parse().ok()),
	})
}

fn prop(node: &omp_dom::Node, id: PropId) -> Option<&str> {
	node.prop(&PropKey::from(id)).and_then(Value::as_str)
}

fn custom<'a>(node: &'a omp_dom::Node, key: &'static str) -> Option<&'a str> {
	node
		.prop(&PropKey::Custom(Str::new_static(key)))
		.and_then(Value::as_str)
}

fn prop_int(node: &omp_dom::Node, id: PropId) -> Option<i64> {
	match node.prop(&PropKey::from(id)) {
		Some(Value::Int(value)) => Some(*value),
		_ => None,
	}
}

fn custom_int(node: &omp_dom::Node, key: &'static str) -> Option<i64> {
	match node.prop(&PropKey::Custom(Str::new_static(key))) {
		Some(Value::Int(value)) => Some(*value),
		_ => None,
	}
}

fn fallback_job_type(kind: JobKind) -> Str {
	let job_type: &'static str = DeliveryJobType::from(kind).into();
	Str::new_static(job_type)
}
