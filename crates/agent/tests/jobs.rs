//! Rewind-to-runtime lifecycle integration for the shared job primitive.

use std::sync::{
	Arc,
	atomic::{AtomicUsize, Ordering},
};

use omp_agent::{JobBoard, JobSettlement};
use omp_core::Str;
use omp_dom::{Op, PropKey, Txn, Value};
use omp_session::{
	ComponentRegistry, Session,
	components::jobs::{self, JobSpec},
};
use tempfile::tempdir;

#[tokio::test]
async fn jobs_rewind_removing_a_subagent_terminates_it() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("parent.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let before = session.head().expect("genesis head");
	let txn = jobs::insert(session.dom(), before, JobSpec {
		id:      Str::new_static("child-1"),
		kind:    Str::new_static("subagent"),
		owner:   Str::new_static("Main"),
		started: Str::new_static("1"),
		agent:   Some(Str::new_static("task")),
		lease:   None,
	})
	.expect("jobs root");
	session.patch(txn).expect("insert subagent");

	let handle = session
		.dom()
		.select("jobs subagent[id=child-1]")
		.expect("valid selector")
		.into_iter()
		.next()
		.expect("subagent element");
	let inserted = session.head().expect("insert head");
	let starts = Arc::new(AtomicUsize::new(0));
	let board = JobBoard::new();
	assert!(board.attach_restartable(session.dom(), handle, {
		let starts = Arc::clone(&starts);
		move |cancel| {
			starts.fetch_add(1, Ordering::SeqCst);
			tokio::spawn(async move {
				cancel.cancelled().await;
				JobSettlement {
					status:     Str::new_static("cancelled"),
					output:     None,
					error:      None,
					completion: None,
					execution:  None,
				}
			})
		}
	}));
	assert_eq!(starts.load(Ordering::SeqCst), 1);

	let work = session.rewind(before).expect("rewind before spawn");
	assert_eq!(work.terminate, vec![handle]);
	board.apply_lifecycle(&session, &work).await;
	assert!(board.list().is_empty());

	let work = session
		.rewind(inserted)
		.expect("rewind onto spawned branch");
	assert_eq!(work.spawn.len(), 1);
	board.apply_lifecycle(&session, &work).await;
	assert_eq!(starts.load(Ordering::SeqCst), 2);
	assert_eq!(board.list().len(), 1);
}

/// A `<job kind=tool>` re-derived without its execution unit (a forward
/// rewind over a detached call, or a restart) can never settle on its own:
/// the board journals it `failed` at the next poll instead of leaving
/// `hub wait` blocked on a phantom `running` job.
#[tokio::test]
async fn jobs_tool_job_without_an_execution_unit_settles_failed_at_poll() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("parent.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let head = session.head().expect("genesis head");
	let txn = jobs::insert(session.dom(), head, JobSpec {
		id:      Str::new_static("bash-timeout-1"),
		kind:    Str::new_static("tool"),
		owner:   Str::new_static("Main"),
		started: Str::new_static("1"),
		agent:   None,
		lease:   None,
	})
	.expect("jobs root");
	session.patch(txn).expect("insert detached tool job");

	let board = JobBoard::new();
	board.rebuild(&session);
	assert!(board.has_finished_units(), "an orphaned tool job wakes the settlement poll");
	let settled = board
		.wait(&mut session, Some(&[Str::new_static("bash-timeout-1")]))
		.await
		.expect("poll commits the orphan")
		.expect("the orphan settles rather than hanging the wait");
	assert_eq!(settled.status.as_str(), "failed");
	assert_eq!(settled.error.as_deref(), Some(omp_agent::ORPHANED_TOOL_JOB));
	assert!(!board.has_finished_units(), "the orphan is journaled exactly once");
}

/// A parent-process restart cannot retain the child execution unit. The stale
/// live node settles before explicit revival so neither `wait` nor revive is
/// permanently fenced by a phantom `running` status.
#[tokio::test]
async fn jobs_restart_settles_orphaned_subagent_and_replay_stays_revivable() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("subagent-restart.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let head = session.head().expect("genesis head");
	let txn = jobs::insert(session.dom(), head, JobSpec {
		id:      Str::new_static("child-restart"),
		kind:    Str::new_static("subagent"),
		owner:   Str::new_static("Main"),
		started: Str::new_static("1"),
		agent:   Some(Str::new_static("task")),
		lease:   None,
	})
	.expect("jobs root");
	session.patch(txn).expect("insert subagent");
	drop(session);

	let mut session = Session::open(&path, ComponentRegistry::standard()).expect("restart session");
	let board = JobBoard::new();
	board.rebuild(&session);
	assert!(board.has_finished_units(), "the missing child wakes settlement");
	let settled = board
		.wait(&mut session, Some(&[Str::new_static("child-restart")]))
		.await
		.expect("orphan settlement")
		.expect("subagent remains addressable");
	assert_eq!(settled.status.as_str(), "failed");
	assert_eq!(settled.error.as_deref(), Some(omp_agent::ORPHANED_SUBAGENT_JOB));
	drop(session);

	let replayed = Session::open(&path, ComponentRegistry::standard()).expect("replay settlement");
	let record = omp_agent::jobs::undelivered(replayed.dom())
		.into_iter()
		.find(|record| record.id == "child-restart")
		.expect("settled child remains deliverable");
	assert_eq!(record.status.as_str(), "failed");
	assert_eq!(record.error.as_deref(), Some(omp_agent::ORPHANED_SUBAGENT_JOB));
}

/// Explicit revival clears stale terminal presentation and re-arms exactly one
/// delivery for the new execution generation.
#[tokio::test]
async fn jobs_revive_rearms_settlement_delivery() {
	let temp = tempdir().expect("temporary session directory");
	let mut session =
		Session::create(temp.path().join("revive-delivery.oms"), ComponentRegistry::standard())
			.expect("create session");
	let head = session.head().expect("genesis head");
	session
		.patch(
			jobs::insert(session.dom(), head, JobSpec {
				id:      Str::new_static("child-revive"),
				kind:    Str::new_static("subagent"),
				owner:   Str::new_static("Main"),
				started: Str::new_static("1"),
				agent:   Some(Str::new_static("task")),
				lease:   None,
			})
			.expect("jobs root"),
		)
		.expect("insert child");
	let handle = session
		.dom()
		.select("jobs subagent[id=child-revive]")
		.expect("selector")
		.into_iter()
		.next()
		.expect("child handle");
	let delivered = session.head().expect("insert head");
	session
		.patch(Txn {
			cause: delivered,
			label: Some(Str::new_static("test.delivered")),
			ops:   vec![Op::Set {
				h:     handle,
				prop:  PropKey::Custom(Str::new_static(omp_agent::jobs::DELIVERED)),
				value: Value::Bool(true),
			}],
		})
		.expect("old delivery marker");
	let restart = session.head().expect("delivered head");
	session
		.patch(jobs::restart(restart, handle, Str::new_static("2")))
		.expect("restart generation");
	let board = JobBoard::new();
	assert!(board.attach_task(
		session.dom(),
		handle,
		tokio_util::sync::CancellationToken::new(),
		tokio::spawn(async {
			JobSettlement {
				status:     Str::new_static("completed"),
				output:     Some(
					serde_json::value::to_raw_value(&serde_json::json!({"text":"revived"}))
						.expect("output"),
				),
				error:      None,
				completion: None,
				execution:  None,
			}
		})
	));
	let settled = board
		.wait(&mut session, Some(&[Str::new_static("child-revive")]))
		.await
		.expect("wait")
		.expect("revived result");
	assert_eq!(settled.status, "completed");
	let pending = omp_agent::jobs::undelivered(session.dom());
	assert_eq!(pending.len(), 1);
	assert_eq!(pending[0].id, "child-revive");
	assert_eq!(
		pending[0]
			.output
			.as_deref()
			.map(serde_json::value::RawValue::get),
		Some(r#"{"text":"revived"}"#)
	);
}

/// Progress after detachment is not a terminal outcome. Restart reconciliation
/// keys off the durable result-entry marker rather than the call's general
/// order marker, so streamed updates cannot be mistaken for completion.
#[tokio::test]
async fn jobs_restart_does_not_adopt_progress_as_a_terminal() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("progress.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	session.begin_turn().expect("turn");
	let call = session
		.call(
			"bash",
			1,
			"call-progress",
			None,
			Some(serde_json::value::to_raw_value(&serde_json::json!({})).expect("args")),
			None,
		)
		.expect("call");
	session
		.settle(
			call,
			serde_json::value::to_raw_value(&serde_json::json!({
				"kind": "detached",
				"id": "job-progress"
			}))
			.expect("detached outcome"),
		)
		.expect("detach");
	session
		.call_update(
			call,
			serde_json::value::to_raw_value(&serde_json::json!({"progress":"still running"}))
				.expect("update"),
		)
		.expect("progress");
	drop(session);

	let mut session = Session::open(&path, ComponentRegistry::standard()).expect("restart session");
	let board = JobBoard::new();
	board.rebuild(&session);
	let jobs = board.poll(&mut session).expect("orphan settlement");
	assert_eq!(jobs.len(), 1);
	assert_eq!(jobs[0].status.as_str(), "failed");
	assert_eq!(jobs[0].error.as_deref(), Some(omp_agent::ORPHANED_TOOL_JOB));
}

/// A supervised-process settlement journals its typed completion and delivery
/// marker in the same patch, so replay shows exactly one launch row and generic
/// async delivery cannot duplicate it after a crash.
#[tokio::test]
async fn process_settlement_journals_one_atomic_replayable_completion() {
	use omp_journal::data::{LaunchCompletion, LaunchDaemonCompletion, LaunchDaemonStatus, Patch};

	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("process.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	session.begin_turn().expect("turn");
	let head = session.head().expect("turn head");
	let txn = jobs::insert(session.dom(), head, JobSpec {
		id:      Str::new_static("web"),
		kind:    Str::new_static("process"),
		owner:   Str::new_static("Main"),
		started: Str::new_static("1"),
		agent:   None,
		lease:   None,
	})
	.expect("jobs root");
	session.patch(txn).expect("insert process job");
	let handle = session
		.dom()
		.select("jobs job[id=web]")
		.expect("valid selector")
		.into_iter()
		.next()
		.expect("process job");

	let board = JobBoard::new();
	assert!(board.attach_task(
		session.dom(),
		handle,
		tokio_util::sync::CancellationToken::new(),
		tokio::spawn(async move {
			JobSettlement {
				status:     Str::new_static("completed"),
				output:     None,
				error:      None,
				completion: Some(LaunchDaemonCompletion {
					name:        Str::new_static("web"),
					status:      LaunchDaemonStatus::Completed,
					exit_code:   Some(0),
					duration_ms: 2_500,
					fault:       None,
				}),
				execution:  None,
			}
		}),
	));
	board
		.wait(&mut session, Some(&[Str::new_static("web")]))
		.await
		.expect("poll")
		.expect("process settles");
	assert_eq!(
		session
			.dom()
			.get(handle)
			.and_then(|node| node.prop(&omp_dom::PropKey::Custom(Str::new_static("delivered")))),
		Some(&omp_dom::Value::Bool(true))
	);
	drop(session);

	let restored = Session::open(&path, ComponentRegistry::standard()).expect("completion replays");
	let rows = restored
		.dom()
		.select("body turn user[launch_completion=true]")
		.expect("valid selector")
		.collect::<Vec<_>>();
	assert_eq!(rows.len(), 1, "exactly one launch row replays");
	let data = restored
		.dom()
		.get(rows[0])
		.and_then(|node| node.prop(&omp_dom::PropId::Data.into()))
		.and_then(|value| match value {
			omp_dom::Value::Json(raw) => Some(raw),
			_ => None,
		})
		.expect("typed completion data");
	let completion: LaunchCompletion = serde_json::from_str(data.get()).expect("completion decodes");
	assert_eq!(completion.daemons[0].name, "web");
	assert_eq!(completion.daemons[0].duration_ms, 2_500);
	drop(restored);

	let (_, entries) = omp_journal::Journal::open(&path).expect("journal opens");
	let settlement = entries
		.iter()
		.filter(|entry| entry.label.as_deref() == Some("jobs.settle"))
		.collect::<Vec<_>>();
	assert_eq!(settlement.len(), 1, "settlement is one journal entry");
	let patch: Patch = serde_json::from_str(settlement[0].data.as_str()).expect("patch payload");
	assert!(patch.ops.get().contains("\"custom:launch_completion\""));
	assert!(patch.ops.get().contains("\"custom:delivered\""));
}

/// ADR 0009: a settlement larger than the central inline bound never lands
/// on the `<subagent>` element verbatim; the full JSON goes to the session
/// CAS and the element carries the artifact address plus a bounded head of
/// the child's text, which `resolve_output` reads back whole.
#[tokio::test]
async fn jobs_oversized_settlement_is_spilled_to_the_cas_and_resolvable() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("parent.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let head = session.head().expect("genesis head");
	let txn = jobs::insert(session.dom(), head, JobSpec {
		id:      Str::new_static("child-big"),
		kind:    Str::new_static("subagent"),
		owner:   Str::new_static("Main"),
		started: Str::new_static("1"),
		agent:   Some(Str::new_static("task")),
		lease:   None,
	})
	.expect("jobs root");
	session.patch(txn).expect("insert subagent");
	let handle = session
		.dom()
		.select("jobs subagent[id=child-big]")
		.expect("valid selector")
		.into_iter()
		.next()
		.expect("subagent element");

	let text = "x".repeat(4_096);
	let full = serde_json::json!({"id": "child-big", "text": text, "error": null});
	let board = JobBoard::new();
	board.set_output_bound(512);
	assert!(board.attach_task(
		session.dom(),
		handle,
		tokio_util::sync::CancellationToken::new(),
		tokio::spawn({
			let full = full.clone();
			async move {
				JobSettlement {
					status:     Str::new_static("completed"),
					output:     serde_json::value::to_raw_value(&full).ok(),
					error:      None,
					completion: None,
					execution:  None,
				}
			}
		}),
	));
	let settled = board
		.wait(&mut session, Some(&[Str::new_static("child-big")]))
		.await
		.expect("poll")
		.expect("settles");
	assert_eq!(settled.status.as_str(), "completed");
	let inline = settled.output.as_deref().expect("inline output");
	assert!(inline.get().len() <= 512, "the element carries a bounded stand-in");
	let spilled: omp_agent::SpilledOutput =
		serde_json::from_str(inline.get()).expect("spilled shape");
	assert!(spilled.artifact.starts_with("artifact://sha256/"));
	assert_eq!(spilled.byte_len, serde_json::to_string(&full).expect("json").len() as u64);
	assert_eq!(spilled.text.as_deref(), Some("x".repeat(128).as_str()));
	let resolved = omp_agent::resolve_output(&session, inline)
		.expect("blob read")
		.expect("addressable");
	assert_eq!(serde_json::from_str::<serde_json::Value>(resolved.get()).expect("json"), full);
}

/// A restart between the terminal `tool.result@1` and `jobs.settle` adopts the
/// call's complete-output artifact instead of failing the job as an orphan.
/// The artifact is copied from the runtime spill namespace into the session
/// namespace before the one durable settlement patch names it.
#[tokio::test]
async fn jobs_restart_adopts_terminal_artifact_and_settles_exactly_once() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("restart.oms");
	let runtime =
		omp_journal::blob::BlobStore::open(temp.path().join("runtime")).expect("runtime CAS");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	session.begin_turn().expect("turn");
	let call = session
		.call(
			"bash",
			1,
			"call-1",
			Some(Str::new_static("run a long command")),
			Some(serde_json::value::to_raw_value(&serde_json::json!({})).expect("args")),
			None,
		)
		.expect("call");
	session
		.settle(
			call,
			serde_json::value::to_raw_value(&serde_json::json!({
				"kind": "detached",
				"id": "job-1"
			}))
			.expect("detached outcome"),
		)
		.expect("detach");
	let full =
		serde_json::value::to_raw_value(&serde_json::json!({"kind":"ok","value":{"text":"done"}}))
			.expect("full outcome");
	let artifact = runtime
		.put(full.get().as_bytes())
		.expect("runtime artifact");
	session
		.settle_projected(
			call,
			serde_json::value::to_raw_value(&serde_json::json!({
				"storage": "spilled",
				"blob": {
					"hash": artifact.to_hex().as_str(),
					"media_type": "application/json",
					"byte_len": artifact.size
				},
				"byte_len": artifact.size
			}))
			.expect("spilled details"),
			serde_json::value::to_raw_value(&serde_json::json!([
				{"kind":"text","text":"artifact-backed completion"}
			]))
			.expect("parts"),
		)
		.expect("terminal result");
	drop(session);

	let mut session = Session::open(&path, ComponentRegistry::standard()).expect("restart session");
	assert!(
		!session.blobs().has(&artifact),
		"runtime and session stores are distinct before adoption"
	);
	let board = JobBoard::new();
	board.set_artifact_store(runtime);
	board.rebuild(&session);
	let jobs = board.poll(&mut session).expect("reconcile");
	assert_eq!(jobs.len(), 1);
	assert_eq!(jobs[0].status.as_str(), "completed");
	assert!(session.blobs().has(&artifact), "settlement pins the artifact in the session CAS");
	let output = jobs[0].output.as_deref().expect("artifact-backed output");
	let spilled: omp_agent::SpilledOutput =
		serde_json::from_str(output.get()).expect("spilled output");
	let address = format!("artifact://sha256/{}", artifact.to_hex());
	assert_eq!(spilled.artifact.as_str(), address.as_str());
	let resolved = omp_agent::resolve_output(&session, output)
		.expect("resolve")
		.expect("full output");
	assert_eq!(resolved.get(), full.get());

	board.poll(&mut session).expect("idempotent reconcile");
	drop(session);
	let (_, entries) = omp_journal::Journal::open(&path).expect("journal");
	assert_eq!(
		entries
			.iter()
			.filter(|entry| entry.label.as_deref() == Some("jobs.settle"))
			.count(),
		1,
		"the recovered terminal is journaled exactly once"
	);
}

/// Counts the rewinds and the session switches it is told about, and keeps
/// the head of the session each one handed it.
#[derive(Default)]
struct Transitions {
	rewinds:  AtomicUsize,
	switches: AtomicUsize,
	heads:    parking_lot::Mutex<Vec<Option<omp_journal::EntryId>>>,
}

impl Transitions {
	fn seen(&self) -> (usize, usize) {
		(self.rewinds.load(Ordering::SeqCst), self.switches.load(Ordering::SeqCst))
	}

	fn heads(&self) -> Vec<Option<omp_journal::EntryId>> {
		self.heads.lock().clone()
	}
}

impl omp_agent::SessionObserver for Transitions {
	fn rewound(&self, session: &Session) {
		self.rewinds.fetch_add(1, Ordering::SeqCst);
		self.heads.lock().push(session.head());
	}

	fn switched(&self, next: &Session) {
		self.switches.fetch_add(1, Ordering::SeqCst);
		self.heads.lock().push(next.head());
	}
}

/// Every rewind applied to the board tells each registered session observer
/// once, whatever the rewind changed, handing it the session already on the
/// branch the rewind left live; every session switch tells each one once as a
/// switch, handing it the next session.
#[tokio::test]
async fn every_rewind_and_switch_tells_the_session_observers() {
	let temp = tempdir().expect("temporary session directory");
	let mut session = Session::create(temp.path().join("rewind.oms"), ComponentRegistry::standard())
		.expect("create session");
	let genesis = session.head().expect("genesis head");
	let txn = jobs::insert(session.dom(), genesis, JobSpec {
		id:      Str::new_static("job-1"),
		kind:    Str::new_static("tool"),
		owner:   Str::new_static("Main"),
		started: Str::new_static("1"),
		agent:   None,
		lease:   None,
	})
	.expect("jobs root");
	session.patch(txn).expect("insert job");
	let board = JobBoard::new();
	let (first, second) = (Arc::new(Transitions::default()), Arc::new(Transitions::default()));
	board.observe_sessions(Arc::clone(&first) as Arc<dyn omp_agent::SessionObserver>);
	board.observe_sessions(Arc::clone(&second) as Arc<dyn omp_agent::SessionObserver>);

	let work = session.rewind(genesis).expect("rewind to genesis");
	board.apply_lifecycle(&session, &work).await;
	let empty = session
		.rewind(genesis)
		.expect("rewind that changes nothing");
	board.apply_lifecycle(&session, &empty).await;
	assert_eq!(first.seen(), (2, 0));
	assert_eq!(second.seen(), (2, 0));

	let next = Session::create(temp.path().join("next.oms"), ComponentRegistry::standard())
		.expect("create the next session");
	board.session_switched(&next);
	assert_eq!(first.seen(), (2, 1), "a switch is told as a switch, never as a rewind");
	assert_eq!(second.seen(), (2, 1));
	let told = [Some(genesis), Some(genesis), next.head()];
	assert_eq!(first.heads(), told, "each transition hands over the session now served");
	assert_eq!(second.heads(), told);
}

#[derive(Clone)]
struct ExecutionTestBackend {
	id:             omp_exec::BackendId,
	capabilities:   omp_exec::BackendCapabilities,
	events:         flume::Receiver<omp_exec::ExecutionEvent>,
	counts:         Arc<ExecutionTestCounts>,
	stall_cancel:   bool,
	start:          TestStart,
	reattach_error: Option<omp_exec::ExecutionError>,
	/// Journal whose submission marker every `start` must already find.
	journal:        Option<std::path::PathBuf>,
}

/// What the fake `start` does after counting the call.
#[derive(Clone)]
enum TestStart {
	/// Returns a run that streams the scripted events.
	Run,
	/// Never returns, as if the process died while `start` ran.
	Stall,
	/// Fails before the backend returned a handle.
	Fail(omp_exec::ExecutionError),
	/// Panics, as if the backend crashed its starting owner.
	Panic,
}

#[derive(Default)]
struct ExecutionTestCounts {
	starts:          AtomicUsize,
	reattaches:      AtomicUsize,
	cancels:         AtomicUsize,
	detaches:        AtomicUsize,
	/// Every `reattach` call's handle and context, in order.
	reattached:      parking_lot::Mutex<Vec<(omp_exec::ReattachHandle, omp_exec::ReattachContext)>>,
	/// Starts that ran before their submission marker was journaled.
	unmarked_starts: AtomicUsize,
}

struct ExecutionTestRun {
	handle:       omp_exec::ReattachHandle,
	events:       flume::Receiver<omp_exec::ExecutionEvent>,
	counts:       Arc<ExecutionTestCounts>,
	stall_cancel: bool,
}

fn execution_test_handle() -> omp_exec::ReattachHandle {
	omp_exec::ReattachHandle::new(
		omp_exec::BackendId::new_static("fake@build.example:443/test"),
		Str::new_static("operations/42"),
		omp_exec::ExecutionId::new_static("exec-42"),
	)
}

fn execution_test_backend(
	stall_cancel: bool,
) -> (ExecutionTestBackend, flume::Sender<omp_exec::ExecutionEvent>) {
	let (sender, events) = flume::bounded(8);
	let capabilities = omp_exec::BackendCapabilities {
		platforms:      [omp_exec::Platform::LINUX_X86_64].into(),
		needs:          Default::default(),
		max_timeout:    None,
		action_cache:   omp_exec::CacheSupport::None,
		cancel:         omp_exec::CancelSupport::BestEffort,
		resume:         omp_exec::ResumeSupport::Reattach,
		max_blob_bytes: None,
		warm_caches:    false,
		enforced:       serde_json::from_str(
			r#"{"write":"read-only","network":"disabled","approval":"always-ask"}"#,
		)
		.expect("posture"),
	};
	(
		ExecutionTestBackend {
			id: omp_exec::BackendId::new_static("fake@build.example:443/test"),
			capabilities,
			events,
			counts: Arc::default(),
			stall_cancel,
			start: TestStart::Run,
			reattach_error: None,
			journal: None,
		},
		sender,
	)
}

impl omp_exec::ExecutionBackend for ExecutionTestBackend {
	type Run = ExecutionTestRun;

	fn id(&self) -> &omp_exec::BackendId<str> {
		&self.id
	}

	fn capabilities(&self) -> &omp_exec::BackendCapabilities {
		&self.capabilities
	}

	async fn start(
		&self,
		request: omp_exec::ExecutionRequest,
	) -> Result<Self::Run, omp_exec::ExecutionError> {
		self.counts.starts.fetch_add(1, Ordering::SeqCst);
		if let Some(journal) = &self.journal
			&& !std::fs::read_to_string(journal)
				.expect("read journal")
				.contains(jobs::EXECUTION_SUBMISSION_STARTED)
		{
			self.counts.unmarked_starts.fetch_add(1, Ordering::SeqCst);
		}
		assert_eq!(request.id, omp_exec::ExecutionId::new_static("exec-42"));
		assert_eq!(request.outputs, omp_exec::OutputSpec::Logs);
		match &self.start {
			TestStart::Run => Ok(ExecutionTestRun {
				handle:       execution_test_handle(),
				events:       self.events.clone(),
				counts:       Arc::clone(&self.counts),
				stall_cancel: self.stall_cancel,
			}),
			TestStart::Stall => std::future::pending().await,
			TestStart::Fail(error) => Err(error.clone()),
			TestStart::Panic => panic!("backend start crashed"),
		}
	}

	async fn reattach(
		&self,
		handle: omp_exec::ReattachHandle,
		context: omp_exec::ReattachContext,
	) -> Result<Self::Run, omp_exec::ExecutionError> {
		self.counts.reattaches.fetch_add(1, Ordering::SeqCst);
		self
			.counts
			.reattached
			.lock()
			.push((handle.clone(), context));
		if let Some(error) = &self.reattach_error {
			return Err(error.clone());
		}
		Ok(ExecutionTestRun {
			handle,
			events: self.events.clone(),
			counts: Arc::clone(&self.counts),
			stall_cancel: self.stall_cancel,
		})
	}
}

impl omp_exec::ExecutionRun for ExecutionTestRun {
	async fn next_event(&mut self) -> Option<omp_exec::ExecutionEvent> {
		self.events.recv_async().await.ok()
	}

	async fn cancel(&self) -> omp_exec::CancelOutcome {
		self.counts.cancels.fetch_add(1, Ordering::SeqCst);
		if self.stall_cancel {
			std::future::pending::<()>().await;
		}
		omp_exec::CancelOutcome::Requested
	}

	fn detach(self) -> omp_exec::ReattachHandle {
		self.counts.detaches.fetch_add(1, Ordering::SeqCst);
		self.handle
	}
}

fn execution_test_request() -> omp_exec::ExecutionRequest {
	omp_exec::ExecutionRequest {
		id:          omp_exec::ExecutionId::new_static("exec-42"),
		intent:      omp_exec::Intent::Test,
		argv:        [Str::new_static("cargo"), Str::new_static("test")].into(),
		cwd:         Str::new_static(""),
		env:         [].into(),
		inputs:      None,
		outputs:     omp_exec::OutputSpec::Logs,
		toolchain:   omp_exec::ToolchainId::new_static("test-toolchain"),
		caches:      [].into(),
		platform:    omp_exec::PlatformRequirement {
			os:            omp_exec::Os::Linux,
			arch:          omp_exec::Arch::X86_64,
			needs_network: false,
			needs:         Default::default(),
		},
		requirement: Default::default(),
		resources:   Default::default(),
		eligibility: omp_exec::Eligibility::RemoteRequired,
		timeout:     std::time::Duration::from_secs(60),
	}
}

/// Inserts the execution job and commits its submission marker: the shape the
/// producer leaves just before `start`.
fn insert_test_execution(session: &mut Session) -> omp_dom::Handle {
	let handle = insert_requested_test_execution(session);
	mark_test_submission(session, handle);
	handle
}

/// Inserts the execution job as `requested`, before any submission marker.
fn insert_requested_test_execution(session: &mut Session) -> omp_dom::Handle {
	let head = session.head().expect("genesis head");
	let txn = jobs::insert_execution(session.dom(), head, jobs::ExecutionSpec {
		id:          Str::new_static("exec-42"),
		owner:       Str::new_static("Main"),
		started:     Str::new_static("1"),
		backend:     Str::new_static("fake@build.example:443/test"),
		request:     Str::new_static(r#"{"recipe":"cargo test"}"#),
		output_mode: Str::new_static(r#""logs""#),
		destination: Str::new_static(TEST_DESTINATION),
		deadline:    Str::new_static("60001"),
		approval:    Str::new_static("approval-1"),
	})
	.expect("jobs root");
	session.patch(txn).expect("insert execution");
	session
		.dom()
		.select("jobs job[id=exec-42]")
		.expect("selector")
		.into_iter()
		.next()
		.expect("execution handle")
}

async fn attach_test_execution(
	session: &Session,
	board: &JobBoard,
	handle: omp_dom::Handle,
	backend: &ExecutionTestBackend,
) {
	use omp_exec::ExecutionBackend;
	let run = backend
		.start(execution_test_request())
		.await
		.expect("start execution");
	assert!(board.attach_execution_run(
		session.dom(),
		handle,
		tokio_util::sync::CancellationToken::new(),
		run
	));
}

async fn wait_for_test_acceptance(
	board: &JobBoard,
	sender: &flume::Sender<omp_exec::ExecutionEvent>,
) {
	sender
		.send(omp_exec::ExecutionEvent::Accepted { handle: execution_test_handle() })
		.expect("send acceptance");
	tokio::time::timeout(std::time::Duration::from_secs(5), board.any_finished())
		.await
		.expect("acceptance wakes board");
	assert!(board.has_finished_units());
	assert!(board.has_finished("exec-42"));
}

fn assert_test_identity(session: &Session, handle: omp_dom::Handle) {
	let node = session.dom().get(handle).expect("execution node");
	let custom = |key: &'static str| {
		node
			.prop(&PropKey::Custom(Str::new_static(key)))
			.and_then(Value::as_str)
	};
	assert_eq!(
		node
			.prop(&omp_dom::PropId::Id.into())
			.and_then(Value::as_str),
		Some("exec-42")
	);
	assert_eq!(
		node
			.prop(&omp_dom::PropId::Kind.into())
			.and_then(Value::as_str),
		Some("execution")
	);
	assert_eq!(
		node
			.prop(&omp_dom::PropId::Name.into())
			.and_then(Value::as_str),
		Some("execution")
	);
	assert_eq!(
		node
			.prop(&omp_dom::PropId::Label.into())
			.and_then(Value::as_str),
		Some("exec-42")
	);
	assert_eq!(custom("owner"), Some("Main"));
	assert_eq!(custom("started"), Some("1"));
	assert_eq!(custom(jobs::EXECUTION_BACKEND), Some("fake@build.example:443/test"));
	assert_eq!(custom(jobs::EXECUTION_REQUEST), Some(r#"{"recipe":"cargo test"}"#));
	assert_eq!(custom(jobs::EXECUTION_OUTPUT_MODE), Some(r#""logs""#));
}

fn assert_test_handle(record: &omp_agent::jobs::JobRecord) {
	assert_eq!(record.id, "exec-42");
	let stored = record.reattach_handle.as_deref().expect("reattach handle");
	assert_eq!(
		stored,
		r#"{"schema":"V1","backend":"fake@build.example:443/test","operation":"operations/42","id":"exec-42"}"#
	);
	assert_eq!(
		serde_json::from_str::<omp_exec::ReattachHandle>(stored).expect("decode handle"),
		execution_test_handle()
	);
}

#[tokio::test]
async fn execution_t2_acceptance_wakes_board_and_survives_replay() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("accepted.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let handle = insert_test_execution(&mut session);
	let board = JobBoard::new();
	let (backend, events) = execution_test_backend(false);
	attach_test_execution(&session, &board, handle, &backend).await;
	assert!(!board.has_finished_units());
	wait_for_test_acceptance(&board, &events).await;
	let records = board.poll(&mut session).expect("commit acceptance");
	assert_eq!(records.len(), 1);
	assert_eq!(records[0].status, "running");
	assert_eq!(records[0].execution_state, Some(omp_exec::ExecutionState::Accepted));
	assert_test_handle(&records[0]);
	assert!(!board.has_finished_units());
	drop(session);
	let mut session =
		Session::open(&path, ComponentRegistry::standard()).expect("reopen accepted session");
	board.rebuild(&session);
	let records = board.list();
	assert_eq!(records.len(), 1);
	assert_eq!(records[0].execution_state, Some(omp_exec::ExecutionState::Accepted));
	assert_eq!(records[0].owner.as_deref(), Some("Main"));
	assert_eq!(records[0].backend.as_deref(), Some("fake@build.example:443/test"));
	assert_eq!(records[0].request.as_deref(), Some(r#"{"recipe":"cargo test"}"#));
	assert_test_handle(&records[0]);
	assert_test_identity(&session, records[0].handle);
	board
		.terminate(&mut session, records[0].handle)
		.await
		.expect("stop test run");
}

#[tokio::test]
async fn execution_t6_backend_effects_unknown_is_not_settled() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("unknown.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let handle = insert_test_execution(&mut session);
	let board = JobBoard::new();
	let (backend, events) = execution_test_backend(false);
	attach_test_execution(&session, &board, handle, &backend).await;
	wait_for_test_acceptance(&board, &events).await;
	board.poll(&mut session).expect("commit acceptance");
	events
		.send(omp_exec::ExecutionEvent::Settled(Err(omp_exec::ExecutionError::EffectsUnknown {
			handle: execution_test_handle(),
		})))
		.expect("send observation loss");
	let record = tokio::time::timeout(
		std::time::Duration::from_secs(5),
		board.wait(&mut session, Some(&[Str::new_static("exec-42")])),
	)
	.await
	.expect("settlement deadline")
	.expect("settlement commit")
	.expect("settled job");
	assert_eq!(record.status, "failed");
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::EffectsUnknown));
	assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::EffectsUnknown));
	assert_test_handle(&record);
	assert_test_identity(&session, handle);
	drop(session);
	let session = Session::open(&path, ComponentRegistry::standard()).expect("reopen settlement");
	board.rebuild(&session);
	let record = board.list().into_iter().next().expect("replayed job");
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::EffectsUnknown));
	assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::EffectsUnknown));
	assert_test_handle(&record);
}

#[tokio::test]
async fn execution_t8_cancel_preserves_accepted_handle_before_and_after_poll_and_abort() {
	for (poll_first, stall_cancel) in [(true, false), (false, false), (false, true)] {
		let temp = tempdir().expect("temporary session directory");
		let path = temp.path().join("cancelled.oms");
		let mut session =
			Session::create(&path, ComponentRegistry::standard()).expect("create session");
		let handle = insert_test_execution(&mut session);
		let board = JobBoard::new();
		let (backend, events) = execution_test_backend(stall_cancel);
		attach_test_execution(&session, &board, handle, &backend).await;
		wait_for_test_acceptance(&board, &events).await;
		if poll_first {
			board.poll(&mut session).expect("commit acceptance");
		}
		assert!(
			tokio::time::timeout(
				std::time::Duration::from_secs(5),
				board.terminate(&mut session, handle)
			)
			.await
			.expect("termination deadline")
			.expect("commit cancellation")
		);
		assert_eq!(backend.counts.cancels.load(Ordering::SeqCst), 1);
		let record = board.list().into_iter().next().expect("cancelled job");
		assert_eq!(record.status, "cancelled");
		assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::EffectsUnknown));
		assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::EffectsUnknown));
		assert_test_handle(&record);
		assert_test_identity(&session, handle);
		drop(session);
		let session =
			Session::open(&path, ComponentRegistry::standard()).expect("reopen cancellation");
		board.rebuild(&session);
		let record = board.list().into_iter().next().expect("replayed job");
		assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::EffectsUnknown));
		assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::EffectsUnknown));
		assert_test_handle(&record);
	}
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn execution_t3_failed_acceptance_append_commits_once_on_retry() {
	const CHILD: &str = "OMP_EXECUTION_T3_CHILD";
	if std::env::var_os(CHILD).is_none() {
		let output = std::process::Command::new("sh")
			.args(["-c", "trap '' XFSZ; exec \"$@\"", "sh"])
			.arg(std::env::current_exe().expect("test executable"))
			.args([
				"--exact",
				"execution_t3_failed_acceptance_append_commits_once_on_retry",
				"--nocapture",
			])
			.env(CHILD, "1")
			.output()
			.expect("run isolated append-failure test");
		assert!(
			output.status.success(),
			"child failed: {}\n{}",
			String::from_utf8_lossy(&output.stdout),
			String::from_utf8_lossy(&output.stderr)
		);
		let stdout = String::from_utf8_lossy(&output.stdout);
		assert!(
			stdout.contains("running 1 test") && stdout.contains("1 passed"),
			"child did not execute T3: {stdout}"
		);
		return;
	}
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("append-failure.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let handle = insert_test_execution(&mut session);
	let board = JobBoard::new();
	let (backend, events) = execution_test_backend(false);
	attach_test_execution(&session, &board, handle, &backend).await;
	wait_for_test_acceptance(&board, &events).await;
	let prior_head = session.head();
	let journal_size = std::fs::metadata(&path).expect("journal metadata").len();
	let limit = format!("--fsize={journal_size}:unlimited");
	assert!(
		std::process::Command::new("prlimit")
			.args(["--pid", &std::process::id().to_string(), &limit])
			.status()
			.expect("set file-size limit")
			.success()
	);
	let failure = board.poll(&mut session);
	assert!(
		std::process::Command::new("prlimit")
			.args(["--pid", &std::process::id().to_string(), "--fsize=unlimited:unlimited"])
			.status()
			.expect("restore file-size limit")
			.success()
	);
	assert!(
		matches!(failure, Err(omp_session::SessionError::Journal(omp_journal::JournalError::Io(_)))),
		"the journal append must fail"
	);
	assert_eq!(session.head(), prior_head);
	assert!(board.has_finished_units(), "uncommitted acceptance remains ready");
	assert_eq!(board.list()[0].execution_state, Some(omp_exec::ExecutionState::Requested));
	let node = session.dom().get(handle).expect("execution node");
	assert!(
		node
			.prop(&PropKey::Custom(Str::new_static(jobs::EXECUTION_HANDLE)))
			.is_none()
	);
	let records = board.poll(&mut session).expect("retry acceptance");
	assert_eq!(records[0].execution_state, Some(omp_exec::ExecutionState::Accepted));
	assert_test_handle(&records[0]);
	assert_test_identity(&session, handle);
	assert_eq!(
		session
			.entries()
			.filter(|entry| entry.label.as_deref() == Some("jobs.settle"))
			.count(),
		1
	);
	board.poll(&mut session).expect("no duplicate acceptance");
	assert_eq!(
		session
			.entries()
			.filter(|entry| entry.label.as_deref() == Some("jobs.settle"))
			.count(),
		1
	);
	board
		.terminate(&mut session, handle)
		.await
		.expect("stop test run");
}

#[tokio::test]
async fn execution_t8_preserves_completed_supervisor_settlement() {
	let temp = tempdir().expect("temporary session directory");
	let mut session =
		Session::create(temp.path().join("completed.oms"), ComponentRegistry::standard())
			.expect("create session");
	let handle = insert_test_execution(&mut session);
	let board = JobBoard::new();
	let cancel = tokio_util::sync::CancellationToken::new();
	let child = cancel.clone();
	let task = tokio::spawn(async move {
		child.cancelled().await;
		JobSettlement {
			status:     Str::new_static("failed"),
			output:     None,
			error:      Some(Str::new_static("terminal backend error")),
			completion: None,
			execution:  Some(omp_agent::jobs::ExecutionSettlement {
				state:  omp_exec::ExecutionState::Settled,
				handle: Some(execution_test_handle()),
				result: None,
				error:  Some(omp_exec::ExecutionError::ResumeUnsupported {
					backend: omp_exec::BackendId::new_static("fake@build.example:443/test"),
				}),
			}),
		}
	});
	assert!(board.attach_execution_task(session.dom(), handle, cancel, task));
	assert!(
		board
			.terminate(&mut session, handle)
			.await
			.expect("commit supervisor settlement")
	);
	let record = board.list().into_iter().next().expect("settled job");
	assert_eq!(record.status, "failed");
	assert_eq!(record.error.as_deref(), Some("terminal backend error"));
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::Settled));
	assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::ResumeUnsupported));
	assert_test_handle(&record);
}

#[tokio::test]
async fn execution_terminate_keeps_a_settled_result() {
	let temp = tempdir().expect("temporary session directory");
	let mut session =
		Session::create(temp.path().join("settled.oms"), ComponentRegistry::standard())
			.expect("create session");
	let handle = insert_test_execution(&mut session);
	let board = JobBoard::new();
	let (backend, events) = execution_test_backend(false);
	attach_test_execution(&session, &board, handle, &backend).await;
	wait_for_test_acceptance(&board, &events).await;
	events
		.send(omp_exec::ExecutionEvent::Settled(Err(omp_exec::ExecutionError::ResumeUnsupported {
			backend: omp_exec::BackendId::new_static("fake@build.example:443/test"),
		})))
		.expect("send typed failure");
	tokio::time::timeout(
		std::time::Duration::from_secs(5),
		board.wait(&mut session, Some(&[Str::new_static("exec-42")])),
	)
	.await
	.expect("settlement deadline")
	.expect("settlement commit")
	.expect("settled job");
	assert!(
		!board
			.terminate(&mut session, handle)
			.await
			.expect("terminate settled job")
	);
	let record = board.list().into_iter().next().expect("settled job");
	assert_eq!(record.status, "failed");
	assert_eq!(record.error.as_deref(), Some("execution failed"));
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::Settled));
	assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::ResumeUnsupported));
	assert_test_handle(&record);
	assert_eq!(
		session
			.entries()
			.filter(|entry| entry.label.as_deref() == Some("jobs.settle"))
			.count(),
		2,
		"acceptance and settlement only; terminate journals nothing"
	);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn execution_failed_cancellation_append_retries_with_one_settlement() {
	const CHILD: &str = "OMP_EXECUTION_CANCEL_APPEND_CHILD";
	if std::env::var_os(CHILD).is_none() {
		let output = std::process::Command::new("sh")
			.args(["-c", "trap '' XFSZ; exec \"$@\"", "sh"])
			.arg(std::env::current_exe().expect("test executable"))
			.args([
				"--exact",
				"execution_failed_cancellation_append_retries_with_one_settlement",
				"--nocapture",
			])
			.env(CHILD, "1")
			.output()
			.expect("run isolated append-failure test");
		assert!(
			output.status.success(),
			"child failed: {}\n{}",
			String::from_utf8_lossy(&output.stdout),
			String::from_utf8_lossy(&output.stderr)
		);
		let stdout = String::from_utf8_lossy(&output.stdout);
		assert!(
			stdout.contains("running 1 test") && stdout.contains("1 passed"),
			"child did not execute the cancellation test: {stdout}"
		);
		return;
	}
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("cancel-append-failure.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let handle = insert_test_execution(&mut session);
	let board = JobBoard::new();
	let (gate, dispatches) = omp_agent::HookGate::channel();
	gate
		.subscribe("test", [omp_agent::hooks::Subscription {
			host:       Str::new_static("test"),
			source:     omp_agent::SourceRef {
				layer:        0,
				publisher:    Str::new_static("test"),
				extension_id: Str::new_static("jobs"),
			},
			id:         1,
			event:      omp_proto::toolhost::v1::HookEventId::HookEventJobSettled,
			phase:      omp_agent::HookPhase::Observe,
			order:      0,
			on_failure: omp_agent::OnFailure::Defer,
			when:       omp_agent::When::default(),
		}])
		.expect("subscribe to settlements");
	board.set_lifecycle_hooks(omp_agent::LifecycleHooks::new(Arc::new(gate)));
	let (backend, events) = execution_test_backend(false);
	attach_test_execution(&session, &board, handle, &backend).await;
	wait_for_test_acceptance(&board, &events).await;
	let prior_head = session.head();
	let journal_size = std::fs::metadata(&path).expect("journal metadata").len();
	let limit = format!("--fsize={journal_size}:unlimited");
	assert!(
		std::process::Command::new("prlimit")
			.args(["--pid", &std::process::id().to_string(), &limit])
			.status()
			.expect("set file-size limit")
			.success()
	);
	let failure = board.terminate(&mut session, handle).await;
	assert!(
		std::process::Command::new("prlimit")
			.args(["--pid", &std::process::id().to_string(), "--fsize=unlimited:unlimited"])
			.status()
			.expect("restore file-size limit")
			.success()
	);
	assert!(
		matches!(failure, Err(omp_session::SessionError::Journal(omp_journal::JournalError::Io(_)))),
		"the journal append must fail"
	);
	assert_eq!(session.head(), prior_head);
	let node = session.dom().get(handle).expect("execution node");
	assert!(
		node
			.prop(&PropKey::Custom(Str::new_static(jobs::EXECUTION_HANDLE)))
			.is_none()
	);
	assert!(
		board
			.terminate(&mut session, handle)
			.await
			.expect("retry cancellation")
	);
	let record = board.list().into_iter().next().expect("cancelled job");
	assert_eq!(record.status, "cancelled");
	assert_eq!(record.error.as_deref(), Some("execution effects are unknown after cancellation"));
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::EffectsUnknown));
	assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::EffectsUnknown));
	assert_test_handle(&record);
	assert_eq!(
		session
			.entries()
			.filter(|entry| entry.label.as_deref() == Some("jobs.settle"))
			.count(),
		1
	);
	assert_eq!(
		dispatches
			.drain()
			.filter(|dispatch| {
				dispatch.event == omp_proto::toolhost::v1::HookEventId::HookEventJobSettled
			})
			.count(),
		1,
		"JobSettled fires once, after the retried append commits"
	);
}

fn mark_test_submission(session: &mut Session, handle: omp_dom::Handle) {
	let cause = session.head().expect("journal head");
	session
		.patch(jobs::mark_execution_submitting(cause, handle))
		.expect("mark submission");
}

#[tokio::test]
async fn execution_t4_restart_after_acceptance_settles_effects_unknown_once() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("accepted-restart.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let handle = insert_requested_test_execution(&mut session);
	mark_test_submission(&mut session, handle);
	let board = JobBoard::new();
	let (backend, events) = execution_test_backend(false);
	attach_test_execution(&session, &board, handle, &backend).await;
	wait_for_test_acceptance(&board, &events).await;
	board.poll(&mut session).expect("commit accepted handle");
	drop(board);
	drop(session);

	let mut session =
		Session::open(&path, ComponentRegistry::standard()).expect("reopen accepted job");
	let board = JobBoard::new();
	board.rebuild(&session);
	let before = session
		.entries()
		.filter(|entry| entry.label.as_deref() == Some("jobs.settle"))
		.count();
	let record = board.poll(&mut session).expect("settle orphan").remove(0);
	assert_eq!(
		session
			.entries()
			.filter(|entry| entry.label.as_deref() == Some("jobs.settle"))
			.count(),
		before + 1
	);
	assert_eq!(record.status, "failed");
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::EffectsUnknown));
	assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::EffectsUnknown));
	assert_eq!(record.error.as_deref(), Some(omp_agent::ORPHANED_EXECUTION_JOB));
	assert_eq!(record.output_mode.as_deref(), Some(r#""logs""#));
	assert_test_handle(&record);
	let settled_head = session.head();
	drop(board);
	drop(session);

	let mut session =
		Session::open(&path, ComponentRegistry::standard()).expect("reopen orphan settlement");
	let board = JobBoard::new();
	board.rebuild(&session);
	let record = board
		.poll(&mut session)
		.expect("poll settled orphan")
		.remove(0);
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::EffectsUnknown));
	assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::EffectsUnknown));
	assert_test_handle(&record);
	assert_eq!(session.head(), settled_head);
}

#[tokio::test]
async fn execution_t5_restart_distinguishes_submitting_from_never_submitted() {
	for submitted in [false, true] {
		let temp = tempdir().expect("temporary session directory");
		let path = temp.path().join("submission-restart.oms");
		let mut session =
			Session::create(&path, ComponentRegistry::standard()).expect("create session");
		let handle = insert_requested_test_execution(&mut session);
		let board = JobBoard::new();
		let (backend, _events) = execution_test_backend(false);
		if submitted {
			mark_test_submission(&mut session, handle);
			attach_test_execution(&session, &board, handle, &backend).await;
		}
		drop(board);
		drop(session);

		let mut session = Session::open(&path, ComponentRegistry::standard()).expect("reopen job");
		let board = JobBoard::new();
		board.rebuild(&session);
		let record = board.poll(&mut session).expect("settle orphan").remove(0);
		let (state, failure) = if submitted {
			(
				omp_exec::ExecutionState::SubmissionUnknown,
				omp_exec::ExecutionErrorKind::SubmissionUnknown,
			)
		} else {
			(omp_exec::ExecutionState::NotSubmitted, omp_exec::ExecutionErrorKind::NotSubmitted)
		};
		assert_eq!(record.status, "failed");
		assert_eq!(record.execution_state, Some(state));
		assert_eq!(record.execution_failure, Some(failure));
		assert_eq!(record.reattach_handle, None);
		assert_eq!(record.error.as_deref(), Some(omp_agent::ORPHANED_EXECUTION_JOB));
		let settled_head = session.head();
		drop(board);
		drop(session);
		let mut session =
			Session::open(&path, ComponentRegistry::standard()).expect("reopen settled job");
		let board = JobBoard::new();
		board.rebuild(&session);
		let record = board
			.poll(&mut session)
			.expect("poll settled job")
			.remove(0);
		assert_eq!(record.execution_state, Some(state));
		assert_eq!(record.execution_failure, Some(failure));
		assert_eq!(session.head(), settled_head);
	}
}

/// A stored handle that does not decode still means the backend accepted the
/// work, so a restart settles it `EffectsUnknown` with a typed decode failure
/// and never reports it as unsubmitted.
#[tokio::test]
async fn execution_restart_with_undecodable_handle_is_effects_unknown() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("invalid-handle.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let handle = insert_test_execution(&mut session);
	let cause = session.head().expect("journal head");
	session
		.patch(Txn {
			cause,
			label: None,
			ops: vec![Op::Set {
				h:     handle,
				prop:  PropKey::Custom(Str::new_static(jobs::EXECUTION_HANDLE)),
				value: Value::Str(Str::new_static("invalid handle")),
			}],
		})
		.expect("record malformed handle");
	drop(session);
	let mut session = Session::open(&path, ComponentRegistry::standard()).expect("reopen job");
	let board = JobBoard::new();
	board.rebuild(&session);
	let record = board.poll(&mut session).expect("settle orphan").remove(0);
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::EffectsUnknown));
	assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::InvalidHandle));
	assert_eq!(record.reattach_handle.as_deref(), Some("invalid handle"));
	assert_eq!(record.error.as_deref(), Some(omp_agent::ORPHANED_EXECUTION_JOB));
}

fn execution_test_result(code: i32) -> omp_exec::ExecutionResult {
	let digest = |size| omp_exec::Digest::new(omp_core::Hash32::default(), size);
	omp_exec::ExecutionResult {
		id:             omp_exec::ExecutionId::new_static("exec-42"),
		backend:        omp_exec::BackendId::new_static("fake@build.example:443/test"),
		outcome:        omp_exec::Outcome::Exited { code },
		logs:           Some(omp_exec::Logs { stdout: digest(11), stderr: digest(12) }),
		artifacts:      [omp_exec::Artifact {
			path:       Str::new_static("target/result"),
			blob:       digest(13),
			executable: true,
			fetched:    true,
		}]
		.into(),
		output_digests: [(Str::new_static("target/result"), digest(13))].into(),
		timing:         omp_exec::Timing {
			queued:    1,
			upload:    2,
			execution: 3,
			download:  4,
			total:     10,
		},
		transfer:       omp_exec::TransferCounts {
			blobs_total:               5,
			cache_hits:                2,
			cache_misses:              3,
			blobs_uploaded:            1,
			bytes_uploaded:            20,
			bytes_uploaded_compressed: 10,
			bytes_downloaded:          30,
		},
		cache_hit:      true,
		fallback:       Some(omp_exec::FallbackCause {
			kind: omp_exec::ExecutionErrorKind::Capacity,
		}),
	}
}

#[tokio::test]
async fn execution_t7_typed_results_and_failures_survive_reopen() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("typed-result.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let handle = insert_test_execution(&mut session);
	let board = JobBoard::new();
	let (backend, events) = execution_test_backend(false);
	attach_test_execution(&session, &board, handle, &backend).await;
	wait_for_test_acceptance(&board, &events).await;
	board.poll(&mut session).expect("commit acceptance");
	let expected = execution_test_result(0);
	events
		.send(omp_exec::ExecutionEvent::Settled(Ok(expected.clone())))
		.expect("send result");
	board
		.wait(&mut session, Some(&[Str::new_static("exec-42")]))
		.await
		.expect("settle result")
		.expect("job");
	drop(board);
	drop(session);
	let session = Session::open(&path, ComponentRegistry::standard()).expect("reopen result");
	let board = JobBoard::new();
	board.rebuild(&session);
	let record = board.list().remove(0);
	assert_eq!(record.status, "completed");
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::Settled));
	assert_eq!(record.output_mode.as_deref(), Some(r#""logs""#));
	let raw = record.execution_result.as_deref().expect("durable result");
	assert_eq!(
		omp_agent::resolve_execution_result(&session, raw).expect("decode result"),
		Some(expected)
	);
	drop(session);

	let path = temp.path().join("typed-failure.oms");
	let mut session =
		Session::create(&path, ComponentRegistry::standard()).expect("create failure session");
	let handle = insert_test_execution(&mut session);
	let board = JobBoard::new();
	let (backend, events) = execution_test_backend(false);
	attach_test_execution(&session, &board, handle, &backend).await;
	wait_for_test_acceptance(&board, &events).await;
	board.poll(&mut session).expect("commit acceptance");
	events
		.send(omp_exec::ExecutionEvent::Settled(Err(omp_exec::ExecutionError::ResumeUnsupported {
			backend: backend.id.clone(),
		})))
		.expect("send failure");
	board
		.wait(&mut session, Some(&[Str::new_static("exec-42")]))
		.await
		.expect("settle failure")
		.expect("job");
	drop(board);
	drop(session);
	let session = Session::open(&path, ComponentRegistry::standard()).expect("reopen failure");
	let board = JobBoard::new();
	board.rebuild(&session);
	let record = board.list().remove(0);
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::Settled));
	assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::ResumeUnsupported));
	assert!(record.execution_result.is_none());
	assert_test_handle(&record);
}

#[tokio::test]
async fn execution_t9_spilled_typed_result_resolves_after_reopen() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("spilled-result.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let handle = insert_test_execution(&mut session);
	let board = JobBoard::new();
	board.set_output_bound(128);
	let (backend, events) = execution_test_backend(false);
	attach_test_execution(&session, &board, handle, &backend).await;
	wait_for_test_acceptance(&board, &events).await;
	board.poll(&mut session).expect("commit acceptance");
	let expected = execution_test_result(7);
	events
		.send(omp_exec::ExecutionEvent::Settled(Ok(expected.clone())))
		.expect("send result");
	board
		.wait(&mut session, Some(&[Str::new_static("exec-42")]))
		.await
		.expect("settle result")
		.expect("job");
	drop(board);
	drop(session);
	let session =
		Session::open(&path, ComponentRegistry::standard()).expect("reopen spilled result");
	let board = JobBoard::new();
	board.rebuild(&session);
	let record = board.list().remove(0);
	assert_eq!(record.status, "failed");
	let raw = record.execution_result.as_deref().expect("durable result");
	assert!(raw.get().len() <= 128);
	let spill: omp_agent::SpilledOutput = serde_json::from_str(raw.get()).expect("spill reference");
	assert!(spill.artifact.starts_with("artifact://sha256/"));
	let resolved = omp_agent::resolve_output(&session, raw)
		.expect("resolve output")
		.expect("spill exists");
	let stored = resolved.get();
	assert_eq!(spill.byte_len, stored.len() as u64);
	assert_eq!(
		spill.artifact.as_str(),
		format!("artifact://sha256/{}", omp_core::Hash32::sum(stored).to_hex())
	);
	assert_eq!(
		omp_agent::resolve_execution_result(&session, raw).expect("decode result"),
		Some(expected)
	);
}

const TEST_SUBJECT: &str = "build.example";
const TEST_KIND: &str = "network";
const TEST_DESTINATION: &str = r#"{"backend":"fake@build.example:443/test","endpoint":"grpcs://build.example:443","instance":"test"}"#;

/// The network requirement a remote run asks the user to approve.
fn test_requirement() -> omp_agent::ApprovalSpec {
	omp_agent::ApprovalSpec {
		title:         Str::new_static("Run cargo test remotely"),
		body:          Str::new_static("cargo test uploads the working tree to build.example."),
		subject:       Str::new_static(TEST_SUBJECT),
		kind:          Str::new_static(TEST_KIND),
		scopes:        vec![Str::new_static("once")],
		default:       None,
		route:         Str::new_static("user"),
		approver:      None,
		timeout_ms:    0,
		unreachable:   Str::new_static("deny"),
		require_human: false,
		pattern:       None,
		evidence:      Vec::new(),
	}
}

/// Journals one prompt for `requirement` through the approval book and answers
/// it with `decision`, or withdraws it without one. Returns the journaled id.
fn journal_test_ticket(
	session: &mut Session,
	requirement: omp_agent::ApprovalSpec,
	decision: Option<omp_agent::ApprovalDecision>,
) -> Str {
	let book = omp_agent::ApprovalBook::new();
	let ticket = book
		.open(session, requirement)
		.expect("open approval")
		.ticket_id;
	match decision {
		Some(decision) => book.decide(session, ticket.as_str(), decision),
		None => book.withdraw(session, ticket.as_str()),
	}
	.expect("answer approval");
	ticket
}

fn test_decision(
	approved: bool,
	source: omp_agent::ApprovalSource,
) -> Option<omp_agent::ApprovalDecision> {
	Some(omp_agent::ApprovalDecision {
		approved,
		scope: omp_agent::ApprovalScope::Once,
		source,
		decided_by: None,
		reason: None,
		audited: approved,
	})
}

/// Mints the proof from the journaled `ticket` for the test destination.
fn authorize_test_ticket(session: &Session, ticket: &str) -> omp_agent::AuthorizedExecution {
	omp_agent::AuthorizedExecution::from_session(
		session,
		ticket,
		TEST_KIND,
		TEST_SUBJECT,
		Str::new_static(TEST_DESTINATION),
	)
	.expect("approved ticket")
}

/// Journals a fresh user approval and mints the proof from it.
fn authorized_test_execution(session: &mut Session) -> omp_agent::AuthorizedExecution {
	let ticket = journal_test_ticket(
		session,
		test_requirement(),
		test_decision(true, omp_agent::ApprovalSource::User),
	);
	authorize_test_ticket(session, ticket.as_str())
}

fn test_submission() -> omp_agent::ExecutionSubmission {
	omp_agent::ExecutionSubmission {
		owner:    Str::new_static("Main"),
		identity: Str::new_static(r#"{"recipe":"cargo test"}"#),
		request:  execution_test_request(),
	}
}

/// The test submission under a fresh execution id.
fn fresh_test_submission() -> omp_agent::ExecutionSubmission {
	let mut submission = test_submission();
	submission.request.id = omp_exec::ExecutionId::new_static("exec-43");
	submission
}

/// Starts the test request through the producer under `authorized`. The
/// backend checks that every `start` finds its submission marker journaled.
fn produce_test_execution(
	session: &mut Session,
	board: &JobBoard,
	backend: &ExecutionTestBackend,
	authorized: omp_agent::AuthorizedExecution,
	submission: omp_agent::ExecutionSubmission,
) -> Result<omp_agent::JobRecord, omp_agent::ExecutionStartError> {
	let mut backend = backend.clone();
	backend.journal = Some(session.journal_path().to_path_buf());
	board.start_execution(session, authorized, backend, submission)
}

fn start_test_execution(
	session: &mut Session,
	board: &JobBoard,
	backend: &ExecutionTestBackend,
) -> omp_agent::JobRecord {
	let authorized = authorized_test_execution(session);
	produce_test_execution(session, board, backend, authorized, test_submission())
		.expect("start execution")
}

async fn wait_for_test_start(backend: &ExecutionTestBackend) {
	tokio::time::timeout(std::time::Duration::from_secs(5), async {
		while backend.counts.starts.load(Ordering::SeqCst) == 0 {
			tokio::time::sleep(std::time::Duration::from_millis(1)).await;
		}
	})
	.await
	.expect("the starting owner calls start");
}

/// Backend calls so far: (start, reattach). Every `start` found its
/// submission marker already journaled.
fn test_calls(backend: &ExecutionTestBackend) -> (usize, usize) {
	assert_eq!(
		backend.counts.unmarked_starts.load(Ordering::SeqCst),
		0,
		"start ran before its submission marker was journaled"
	);
	(backend.counts.starts.load(Ordering::SeqCst), backend.counts.reattaches.load(Ordering::SeqCst))
}

fn settle_entries(session: &Session) -> usize {
	session
		.entries()
		.filter(|entry| entry.label.as_deref() == Some("jobs.settle"))
		.count()
}

/// T1 approval: only a journaled prompt the user approved for the destination's
/// network requirement mints the proof the producer requires, and one approval
/// starts one run, across a restart too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn execution_t1_only_an_approved_ticket_starts_one_run() {
	use omp_agent::{
		ApprovalSource, AuthorizedExecution, ExecutionApprovalError, ExecutionStartError,
	};

	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("approved.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let answered = |session: &mut Session, approved: bool, source: ApprovalSource| {
		journal_test_ticket(session, test_requirement(), test_decision(approved, source))
	};
	let pending = omp_agent::ApprovalBook::new()
		.open(&mut session, test_requirement())
		.expect("open approval")
		.ticket_id;
	let withdrawn = journal_test_ticket(&mut session, test_requirement(), None);
	let denied = answered(&mut session, false, ApprovalSource::User);
	let timed_out = answered(&mut session, true, ApprovalSource::Timeout);
	let unreachable = answered(&mut session, true, ApprovalSource::Unavailable);
	let other_kind = journal_test_ticket(
		&mut session,
		omp_agent::ApprovalSpec { kind: Str::new_static("write"), ..test_requirement() },
		test_decision(true, ApprovalSource::User),
	);
	let approved = answered(&mut session, true, ApprovalSource::User);
	let mint = |session: &Session, ticket: &str, subject: &str| {
		AuthorizedExecution::from_session(
			session,
			ticket,
			TEST_KIND,
			subject,
			Str::new_static(TEST_DESTINATION),
		)
		.err()
	};
	assert_eq!(
		mint(&session, "approval-unknown", TEST_SUBJECT),
		Some(ExecutionApprovalError::UnknownTicket { ticket: Str::new_static("approval-unknown") })
	);
	for (case, ticket) in [
		("pending", &pending),
		("withdrawn", &withdrawn),
		("denied", &denied),
		("timed out", &timed_out),
		("unreachable", &unreachable),
	] {
		assert_eq!(
			mint(&session, ticket.as_str(), TEST_SUBJECT),
			Some(ExecutionApprovalError::NotApproved { ticket: ticket.clone() }),
			"{case} must not authorize a run"
		);
	}
	for (case, ticket, subject) in
		[("other kind", &other_kind, TEST_SUBJECT), ("other host", &approved, "other.example")]
	{
		assert_eq!(
			mint(&session, ticket.as_str(), subject),
			Some(ExecutionApprovalError::NotCovered {
				ticket:  ticket.clone(),
				kind:    Str::new_static(TEST_KIND),
				subject: Str::new(subject),
			}),
			"{case} must not authorize a run"
		);
	}

	let board = JobBoard::new();
	let (backend, _events) = execution_test_backend(false);
	assert_eq!(test_calls(&backend), (0, 0));
	let authorized = authorize_test_ticket(&session, approved.as_str());
	let record =
		produce_test_execution(&mut session, &board, &backend, authorized, test_submission())
			.expect("start execution");
	wait_for_test_start(&backend).await;
	assert_eq!(record.id, "exec-42");
	assert_eq!(record.status, "running");
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::Requested));
	let node = session.dom().get(record.handle).expect("execution node");
	let custom = |key: &'static str| {
		node
			.prop(&PropKey::Custom(Str::new_static(key)))
			.and_then(Value::as_str)
	};
	assert!(matches!(
		node.prop(&PropKey::Custom(Str::new_static(jobs::EXECUTION_SUBMISSION_STARTED))),
		Some(Value::Bool(true))
	));
	assert_eq!(custom("owner"), Some("Main"));
	assert_eq!(custom(jobs::EXECUTION_BACKEND), Some("fake@build.example:443/test"));
	assert_eq!(custom(jobs::EXECUTION_REQUEST), Some(r#"{"recipe":"cargo test"}"#));
	assert_eq!(custom(jobs::EXECUTION_OUTPUT_MODE), Some(r#""logs""#));
	assert_eq!(custom(jobs::EXECUTION_DESTINATION), Some(TEST_DESTINATION));
	assert_eq!(custom(jobs::EXECUTION_APPROVAL), Some(approved.as_str()));
	let millis = |key| {
		custom(key)
			.and_then(|value| value.parse::<u64>().ok())
			.expect("timestamp")
	};
	assert_eq!(millis(jobs::EXECUTION_DEADLINE) - millis("started"), 60_000);

	let authorized = authorized_test_execution(&mut session);
	let duplicate =
		produce_test_execution(&mut session, &board, &backend, authorized, test_submission());
	assert!(matches!(
		duplicate,
		Err(ExecutionStartError::Duplicate { id }) if id == "exec-42"
	));
	let authorized = authorize_test_ticket(&session, approved.as_str());
	let head = session.head();
	let spent =
		produce_test_execution(&mut session, &board, &backend, authorized, fresh_test_submission());
	assert!(matches!(
		&spent,
		Err(ExecutionStartError::ApprovalSpent { ticket }) if ticket == &approved
	));
	assert_eq!(session.head(), head, "a spent approval journals nothing");
	tokio::task::yield_now().await;
	assert_eq!(test_calls(&backend), (1, 0));
	assert!(
		board
			.terminate(&mut session, record.handle)
			.await
			.expect("stop test run")
	);
	drop(board);
	drop(session);

	let mut session =
		Session::open(&path, ComponentRegistry::standard()).expect("reopen spent approval");
	let board = JobBoard::new();
	board.rebuild(&session);
	let authorized = authorize_test_ticket(&session, approved.as_str());
	let respent =
		produce_test_execution(&mut session, &board, &backend, authorized, fresh_test_submission());
	assert!(
		matches!(
			&respent,
			Err(ExecutionStartError::ApprovalSpent { ticket }) if ticket == &approved
		),
		"a restart never refunds an approval"
	);
	assert_eq!(test_calls(&backend), (1, 0));
}

/// T5: a crash after the submission marker and before any handle settles
/// `SubmissionUnknown` from the journal alone, and a restart never starts the
/// request again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn execution_t5_crash_after_the_marker_is_submission_unknown_without_retry() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("submitting.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let board = JobBoard::new();
	let (mut backend, _events) = execution_test_backend(false);
	backend.start = TestStart::Stall;
	start_test_execution(&mut session, &board, &backend);
	wait_for_test_start(&backend).await;
	drop(board);
	drop(session);

	let mut session =
		Session::open(&path, ComponentRegistry::standard()).expect("reopen submitting job");
	let board = JobBoard::new();
	board.rebuild(&session);
	let record = board.poll(&mut session).expect("settle orphan").remove(0);
	assert_eq!(record.status, "failed");
	assert_eq!(record.error.as_deref(), Some(omp_agent::ORPHANED_EXECUTION_JOB));
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::SubmissionUnknown));
	assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::SubmissionUnknown));
	assert_eq!(record.reattach_handle, None);
	let settled = session.head();
	board.poll(&mut session).expect("poll settled job");
	assert_eq!(session.head(), settled);
	assert_eq!(test_calls(&backend), (1, 0));
}

/// T5: `start` failing before any handle settles `SubmissionUnknown` with the
/// typed failure, and neither the live board nor a restart retries it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn execution_t5_start_failure_is_submission_unknown_without_retry() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("start-failure.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let board = JobBoard::new();
	let (mut backend, _events) = execution_test_backend(false);
	backend.start =
		TestStart::Fail(omp_exec::ExecutionError::Capacity { backend: backend.id.clone() });
	start_test_execution(&mut session, &board, &backend);
	let record = tokio::time::timeout(
		std::time::Duration::from_secs(5),
		board.wait(&mut session, Some(&[Str::new_static("exec-42")])),
	)
	.await
	.expect("settlement deadline")
	.expect("settlement commit")
	.expect("settled job");
	assert_eq!(record.status, "failed");
	assert_eq!(record.error.as_deref(), Some(omp_agent::EXECUTION_START_FAILED));
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::SubmissionUnknown));
	assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::Capacity));
	assert_eq!(record.reattach_handle, None);
	let settled = session.head();
	drop(board);
	drop(session);

	let mut session =
		Session::open(&path, ComponentRegistry::standard()).expect("reopen failed job");
	let board = JobBoard::new();
	board.rebuild(&session);
	let record = board
		.poll(&mut session)
		.expect("poll settled job")
		.remove(0);
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::SubmissionUnknown));
	assert_eq!(session.head(), settled);
	assert_eq!(test_calls(&backend), (1, 0));
}

/// A starting owner that panics before any handle settles `SubmissionUnknown`:
/// the backend may hold the request, so it is never started again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn execution_start_panic_is_submission_unknown_without_retry() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("start-panic.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let board = JobBoard::new();
	let (mut backend, _events) = execution_test_backend(false);
	backend.start = TestStart::Panic;
	start_test_execution(&mut session, &board, &backend);
	let record = tokio::time::timeout(
		std::time::Duration::from_secs(5),
		board.wait(&mut session, Some(&[Str::new_static("exec-42")])),
	)
	.await
	.expect("settlement deadline")
	.expect("settlement commit")
	.expect("settled job");
	assert_eq!(record.status, "failed");
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::SubmissionUnknown));
	assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::SubmissionUnknown));
	assert_eq!(record.reattach_handle, None);
	assert_eq!(test_calls(&backend), (1, 0));
}

/// An attached execution task that panics before any handle settles
/// `SubmissionUnknown` too: its marker says the backend may hold the request.
#[tokio::test]
async fn execution_attached_task_panic_is_submission_unknown() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("task-panic.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let handle = insert_test_execution(&mut session);
	let board = JobBoard::new();
	let task: tokio::task::JoinHandle<JobSettlement> =
		tokio::spawn(async { panic!("attached execution task crashed") });
	assert!(board.attach_execution_task(
		session.dom(),
		handle,
		tokio_util::sync::CancellationToken::new(),
		task
	));
	let record = tokio::time::timeout(
		std::time::Duration::from_secs(5),
		board.wait(&mut session, Some(&[Str::new_static("exec-42")])),
	)
	.await
	.expect("settlement deadline")
	.expect("settlement commit")
	.expect("settled job");
	assert_eq!(record.status, "failed");
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::SubmissionUnknown));
	assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::SubmissionUnknown));
	assert_eq!(record.reattach_handle, None);
}

/// A submission marker that fails to commit starts nothing: the `requested`
/// node is indexed again, so the next poll settles it `NotSubmitted` from the
/// journal alone.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn execution_failed_marker_commit_starts_nothing() {
	const CHILD: &str = "OMP_EXECUTION_MARKER_CHILD";
	if std::env::var_os(CHILD).is_none() {
		let output = std::process::Command::new("sh")
			.args(["-c", "trap '' XFSZ; exec \"$@\"", "sh"])
			.arg(std::env::current_exe().expect("test executable"))
			.args(["--exact", "execution_failed_marker_commit_starts_nothing", "--nocapture"])
			.env(CHILD, "1")
			.output()
			.expect("run isolated marker-failure test");
		assert!(
			output.status.success(),
			"child failed: {}\n{}",
			String::from_utf8_lossy(&output.stdout),
			String::from_utf8_lossy(&output.stderr)
		);
		let stdout = String::from_utf8_lossy(&output.stdout);
		assert!(
			stdout.contains("running 1 test") && stdout.contains("1 passed"),
			"child did not execute the marker test: {stdout}"
		);
		return;
	}
	let temp = tempdir().expect("temporary session directory");
	// A twin runs the same producer, so the limit lands exactly where its
	// `requested` node ends and its submission marker would begin.
	let twin_path = temp.path().join("twin.oms");
	let mut twin =
		Session::create(&twin_path, ComponentRegistry::standard()).expect("create twin session");
	let twin_board = JobBoard::new();
	let (mut twin_backend, _twin_events) = execution_test_backend(false);
	twin_backend.start = TestStart::Stall;
	let authorized = authorized_test_execution(&mut twin);
	let ready = std::fs::metadata(&twin_path).expect("twin journal").len();
	let entries = twin.entry_count();
	produce_test_execution(&mut twin, &twin_board, &twin_backend, authorized, test_submission())
		.expect("start twin execution");
	assert_eq!(twin.entry_count(), entries + 2, "the requested node, then its marker");
	let journal = std::fs::read(&twin_path).expect("twin journal");
	let requested = journal[..journal.len() - 2]
		.windows(2)
		.rposition(|pair| pair == b"\n\n")
		.expect("requested frame")
		+ 2;

	let path = temp.path().join("marker-failure.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let authorized = authorized_test_execution(&mut session);
	assert_eq!(
		std::fs::metadata(&path).expect("journal").len(),
		ready,
		"the twin journaled the same bytes"
	);
	let board = JobBoard::new();
	let (backend, _events) = execution_test_backend(false);
	let entries = session.entry_count();
	let pid = std::process::id().to_string();
	let limit = format!("--fsize={requested}:unlimited");
	assert!(
		std::process::Command::new("prlimit")
			.args(["--pid", &pid, &limit])
			.status()
			.expect("set file-size limit")
			.success()
	);
	let failure =
		produce_test_execution(&mut session, &board, &backend, authorized, test_submission());
	assert!(
		std::process::Command::new("prlimit")
			.args(["--pid", &pid, "--fsize=unlimited:unlimited"])
			.status()
			.expect("restore file-size limit")
			.success()
	);
	assert!(
		matches!(
			failure,
			Err(omp_agent::ExecutionStartError::Session(omp_session::SessionError::Journal(
				omp_journal::JournalError::Io(_)
			)))
		),
		"the marker append must fail"
	);
	assert_eq!(session.entry_count(), entries + 1, "only the requested node landed");
	tokio::task::yield_now().await;
	assert_eq!(test_calls(&backend), (0, 0), "start never runs without its marker");
	let indexed = board.list();
	assert_eq!(indexed.len(), 1, "the requested node is indexed");
	assert_eq!(indexed[0].execution_state, Some(omp_exec::ExecutionState::Requested));
	let record = board
		.poll(&mut session)
		.expect("settle unmarked job")
		.remove(0);
	assert_eq!(record.status, "failed");
	assert_eq!(record.error.as_deref(), Some(omp_agent::ORPHANED_EXECUTION_JOB));
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::NotSubmitted));
	assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::NotSubmitted));
	assert_eq!(test_calls(&backend), (0, 0));
}

/// Terminating before any handle settles `SubmissionUnknown`: during `start`
/// and after `start` with a prompt cancel, both well inside the grace period,
/// and after `start` with a cancel that stalls past it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn execution_terminate_before_acceptance_never_invents_a_handle() {
	let prompt = std::time::Duration::from_millis(500);
	for (start, stall_cancel, cancels, deadline) in [
		(TestStart::Stall, false, 0, prompt),
		(TestStart::Run, false, 1, prompt),
		(TestStart::Run, true, 1, std::time::Duration::from_secs(5)),
	] {
		let temp = tempdir().expect("temporary session directory");
		let path = temp.path().join("cancelled-before-acceptance.oms");
		let mut session =
			Session::create(&path, ComponentRegistry::standard()).expect("create session");
		let board = JobBoard::new();
		let (mut backend, _events) = execution_test_backend(stall_cancel);
		backend.start = start;
		let record = start_test_execution(&mut session, &board, &backend);
		wait_for_test_start(&backend).await;
		assert!(
			tokio::time::timeout(deadline, board.terminate(&mut session, record.handle),)
				.await
				.expect("termination deadline")
				.expect("commit cancellation")
		);
		let record = board.list().into_iter().next().expect("cancelled job");
		assert_eq!(record.status, "cancelled");
		assert_eq!(record.error.as_deref(), Some(omp_agent::EXECUTION_CANCELLED_BEFORE_ACCEPTANCE));
		assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::SubmissionUnknown));
		assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::SubmissionUnknown));
		assert_eq!(record.reattach_handle, None);
		assert_eq!(test_calls(&backend), (1, 0));
		assert_eq!(backend.counts.cancels.load(Ordering::SeqCst), cancels);
	}
}

/// T7 through the producer: a literal success and a typed failure each settle
/// once and read back typed after reopen, with one `start` per job.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn execution_t7_produced_results_and_failures_survive_reopen() {
	for failure in [None, Some(omp_exec::ExecutionErrorKind::Capacity)] {
		let temp = tempdir().expect("temporary session directory");
		let path = temp.path().join("produced.oms");
		let mut session =
			Session::create(&path, ComponentRegistry::standard()).expect("create session");
		let board = JobBoard::new();
		let (backend, events) = execution_test_backend(false);
		start_test_execution(&mut session, &board, &backend);
		wait_for_test_acceptance(&board, &events).await;
		board.poll(&mut session).expect("commit acceptance");
		let expected = execution_test_result(0);
		let settled = match failure {
			None => Ok(expected.clone()),
			Some(_) => Err(omp_exec::ExecutionError::Capacity { backend: backend.id.clone() }),
		};
		events
			.send(omp_exec::ExecutionEvent::Settled(settled))
			.expect("send settlement");
		tokio::time::timeout(
			std::time::Duration::from_secs(5),
			board.wait(&mut session, Some(&[Str::new_static("exec-42")])),
		)
		.await
		.expect("settlement deadline")
		.expect("settlement commit")
		.expect("settled job");
		drop(board);
		drop(session);

		let mut session =
			Session::open(&path, ComponentRegistry::standard()).expect("reopen settled job");
		let board = JobBoard::new();
		board.rebuild(&session);
		let settled_head = session.head();
		let record = board
			.poll(&mut session)
			.expect("poll settled job")
			.remove(0);
		assert_eq!(session.head(), settled_head);
		assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::Settled));
		assert_eq!(record.execution_failure, failure);
		assert_test_handle(&record);
		if failure.is_none() {
			assert_eq!(record.status, "completed");
			let raw = record.execution_result.as_deref().expect("durable result");
			assert_eq!(
				omp_agent::resolve_execution_result(&session, raw).expect("decode result"),
				Some(expected)
			);
		} else {
			assert_eq!(record.status, "failed");
			assert!(record.execution_result.is_none());
		}
		assert_eq!(test_calls(&backend), (1, 0));
	}
}

/// A restart after acceptance never calls `start` again: the journal alone
/// settles the job `EffectsUnknown` with the accepted handle, once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn execution_produced_restart_after_acceptance_never_starts_again() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("produced-accepted.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let board = JobBoard::new();
	let (backend, events) = execution_test_backend(false);
	start_test_execution(&mut session, &board, &backend);
	wait_for_test_acceptance(&board, &events).await;
	board.poll(&mut session).expect("commit acceptance");
	assert_eq!(settle_entries(&session), 1);
	drop(board);
	drop(session);

	for _ in 0..2 {
		let mut session =
			Session::open(&path, ComponentRegistry::standard()).expect("reopen accepted job");
		let board = JobBoard::new();
		board.rebuild(&session);
		let record = board.poll(&mut session).expect("settle orphan").remove(0);
		assert_eq!(record.status, "failed");
		assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::EffectsUnknown));
		assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::EffectsUnknown));
		assert_test_handle(&record);
		assert_eq!(settle_entries(&session), 2, "acceptance and one orphan settlement");
	}
	assert_eq!(test_calls(&backend), (1, 0));
}

/// A run or task attaches only after its submission marker is journaled: a
/// unit lost before acceptance would otherwise restart as never submitted.
#[tokio::test]
async fn execution_attach_without_submission_marker_is_refused() {
	use omp_exec::ExecutionBackend;

	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("unmarked.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let handle = insert_requested_test_execution(&mut session);
	let board = JobBoard::new();
	let (backend, _events) = execution_test_backend(false);
	let run = backend
		.start(execution_test_request())
		.await
		.expect("start execution");
	assert!(!board.attach_execution_run(
		session.dom(),
		handle,
		tokio_util::sync::CancellationToken::new(),
		run
	));
	assert!(!board.attach_execution_task(
		session.dom(),
		handle,
		tokio_util::sync::CancellationToken::new(),
		tokio::spawn(std::future::pending::<JobSettlement>()),
	));
	assert!(board.list().is_empty());
	mark_test_submission(&mut session, handle);
	attach_test_execution(&session, &board, handle, &backend).await;
	assert_eq!(board.list().len(), 1);
	assert!(
		board
			.terminate(&mut session, handle)
			.await
			.expect("stop test run")
	);
}

/// The destination identity the operator's configuration reports for the fake
/// backend: the one every test job journals.
fn test_destination() -> serde_json::Value {
	serde_json::from_str(TEST_DESTINATION).expect("destination identity")
}

/// A backend for a resumed run. It shares `backend`'s call counts and streams
/// its own events, so the orphaned first run cannot take them.
fn resume_test_backend(
	backend: &ExecutionTestBackend,
) -> (ExecutionTestBackend, flume::Sender<omp_exec::ExecutionEvent>) {
	let (mut resumer, events) = execution_test_backend(false);
	resumer.counts = Arc::clone(&backend.counts);
	(resumer, events)
}

fn set_test_prop(
	session: &mut Session,
	handle: omp_dom::Handle,
	prop: PropKey,
	value: &'static str,
) {
	let cause = session.head().expect("journal head");
	session
		.patch(Txn {
			cause,
			label: Some(Str::new_static("test.prop")),
			ops: vec![Op::Set { h: handle, prop, value: Value::Str(Str::new_static(value)) }],
		})
		.expect("rewrite job property");
}

fn mark_test_delivered(session: &mut Session, handle: omp_dom::Handle) {
	let cause = session.head().expect("journal head");
	session
		.patch(Txn {
			cause,
			label: Some(Str::new_static("test.delivered")),
			ops: vec![Op::Set {
				h:     handle,
				prop:  PropKey::Custom(Str::new_static(omp_agent::jobs::DELIVERED)),
				value: Value::Bool(true),
			}],
		})
		.expect("delivery marker");
}

/// Produces exec-42, accepts it, and restarts without its watcher, then marks
/// the orphan failure delivered: the state a reattach resumes. Returns the
/// producer's backend.
async fn effects_unknown_test_job(path: &std::path::Path) -> ExecutionTestBackend {
	let mut session = Session::create(path, ComponentRegistry::standard()).expect("create session");
	let board = JobBoard::new();
	let (backend, events) = execution_test_backend(false);
	start_test_execution(&mut session, &board, &backend);
	wait_for_test_acceptance(&board, &events).await;
	board.poll(&mut session).expect("commit acceptance");
	drop(board);
	drop(session);

	let mut session =
		Session::open(path, ComponentRegistry::standard()).expect("reopen accepted job");
	let board = JobBoard::new();
	board.rebuild(&session);
	let record = board.poll(&mut session).expect("settle orphan").remove(0);
	assert_eq!(record.status, "failed");
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::EffectsUnknown));
	assert_eq!(record.execution_failure, Some(omp_exec::ExecutionErrorKind::EffectsUnknown));
	assert_eq!(record.error.as_deref(), Some(omp_agent::ORPHANED_EXECUTION_JOB));
	mark_test_delivered(&mut session, record.handle);
	backend
}

/// Opens `path` as the one writer a reattach needs, with its board rebuilt and
/// reconciled.
fn open_for_reattach(path: &std::path::Path) -> (Session, JobBoard) {
	let mut session =
		Session::open(path, ComponentRegistry::standard()).expect("reopen for reattach");
	let board = JobBoard::new();
	board.rebuild(&session);
	board.poll(&mut session).expect("reconcile");
	(session, board)
}

async fn settle_resumed_test_run(
	session: &mut Session,
	board: &JobBoard,
	events: &flume::Sender<omp_exec::ExecutionEvent>,
) -> omp_agent::JobRecord {
	events
		.send(omp_exec::ExecutionEvent::Settled(Ok(execution_test_result(0))))
		.expect("send result");
	tokio::time::timeout(
		std::time::Duration::from_secs(5),
		board.wait(session, Some(&[Str::new_static("exec-42")])),
	)
	.await
	.expect("resumed run settles")
	.expect("journal settlement")
	.expect("selected job")
}

/// T10: an orphaned accepted job resumes through the reattach entry. The
/// backend sees one `reattach` with the stored handle and output spec and no
/// second `start`, the result is journaled once, and the orphan's failure
/// presentation is gone.
#[tokio::test]
async fn execution_t10_reattach_resumes_and_settles_once() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("resumed.oms");
	let backend = effects_unknown_test_job(&path).await;
	let (mut session, board) = open_for_reattach(&path);
	let settled_before = settle_entries(&session);

	let resume = board
		.prepare_reattach(&session, "exec-42", &test_destination())
		.expect("the job can resume");
	assert_eq!(resume.handle(), &execution_test_handle());
	assert_eq!(resume.context().outputs, omp_exec::OutputSpec::Logs);
	assert!(resume.context().remaining_deadline <= std::time::Duration::from_secs(60));
	assert!(resume.context().remaining_deadline > std::time::Duration::ZERO);
	let (resumer, events) = resume_test_backend(&backend);
	let record = board
		.reattach_execution(&mut session, resume, resumer)
		.await
		.expect("reattach");
	assert_eq!(record.status, "running");
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::Accepted));
	assert_eq!(record.error, None);
	assert_eq!(record.execution_failure, None);
	assert_eq!(test_calls(&backend), (1, 1));
	{
		let reattached = backend.counts.reattached.lock();
		assert_eq!(reattached.len(), 1);
		assert_eq!(reattached[0].0, execution_test_handle());
		assert_eq!(reattached[0].1.outputs, omp_exec::OutputSpec::Logs);
	}
	assert!(matches!(
		board.prepare_reattach(&session, "exec-42", &test_destination()),
		Err(omp_agent::ExecutionReattachError::Watched { .. })
	));

	let settled = settle_resumed_test_run(&mut session, &board, &events).await;
	assert_eq!(settled.status, "completed");
	assert_eq!(settled.execution_state, Some(omp_exec::ExecutionState::Settled));
	assert_eq!(settled.error, None);
	assert_eq!(settled.execution_failure, None);
	assert_test_handle(&settled);
	let raw = settled.execution_result.as_deref().expect("durable result");
	assert_eq!(
		omp_agent::resolve_execution_result(&session, raw).expect("decode result"),
		Some(execution_test_result(0))
	);
	assert_eq!(settle_entries(&session), settled_before + 1);
	assert_eq!(test_calls(&backend), (1, 1));
	assert_eq!(backend.counts.cancels.load(Ordering::SeqCst), 0);
	drop(board);
	drop(session);

	let (session, board) = open_for_reattach(&path);
	let record = board.list().remove(0);
	assert_eq!(record.status, "completed");
	assert_eq!(record.error, None);
	assert_eq!(record.execution_failure, None);
	assert_eq!(settle_entries(&session), settled_before + 1);
}

/// T11: every refusal precedes the backend's `reattach`, calls nothing on the
/// backend, and leaves the journal unchanged.
#[tokio::test]
async fn execution_t11_refusals_make_no_backend_call_and_no_write() {
	use omp_agent::ExecutionReattachError as Refusal;

	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("refused.oms");
	let backend = effects_unknown_test_job(&path).await;
	let (mut session, board) = open_for_reattach(&path);
	let handle = board.list().remove(0).handle;

	let unsupported = |resume| {
		let (mut resumer, _events) = resume_test_backend(&backend);
		resumer.capabilities.resume = resume;
		resumer
	};
	let mut renamed = resume_test_backend(&backend).0;
	renamed.id = omp_exec::BackendId::new_static("other@build.example:443/test");
	for (resumer, expected) in [
		(unsupported(omp_exec::ResumeSupport::Unsupported), "unsupported"),
		(unsupported(omp_exec::ResumeSupport::Snapshot), "snapshot"),
		(renamed, "backend"),
	] {
		let head = session.head();
		let resume = board
			.prepare_reattach(&session, "exec-42", &test_destination())
			.expect("the journal allows the resume");
		let refusal = board
			.reattach_execution(&mut session, resume, resumer)
			.await
			.expect_err("the backend is refused");
		assert!(
			match expected {
				"unsupported" => matches!(refusal, Refusal::Unsupported { .. }),
				"snapshot" => matches!(refusal, Refusal::SnapshotOnly { .. }),
				_ => matches!(refusal, Refusal::BackendMismatch { .. }),
			},
			"{expected}: {refusal:?}"
		);
		assert_eq!(session.head(), head, "{expected} journals nothing");
	}

	let head = session.head();
	let elsewhere: serde_json::Value = serde_json::from_str(
		r#"{"backend":"fake@build.example:443/test","endpoint":"grpcs://other.example:443","instance":"test"}"#,
	)
	.expect("destination identity");
	assert!(matches!(
		board.prepare_reattach(&session, "exec-42", &elsewhere),
		Err(Refusal::DestinationMismatch { .. })
	));
	assert!(matches!(
		board.prepare_reattach(&session, "missing", &test_destination()),
		Err(Refusal::NotFound { .. })
	));
	assert_eq!(session.head(), head);

	let handle_prop = PropKey::Custom(Str::new_static(jobs::EXECUTION_HANDLE));
	for (stored, label) in [
		("invalid handle", "malformed handle"),
		(
			r#"{"schema":"V2","backend":"fake@build.example:443/test","operation":"operations/42","id":"exec-42"}"#,
			"unknown schema",
		),
	] {
		set_test_prop(&mut session, handle, handle_prop.clone(), stored);
		let head = session.head();
		assert!(
			matches!(
				board.prepare_reattach(&session, "exec-42", &test_destination()),
				Err(Refusal::InvalidHandle { .. })
			),
			"{label}"
		);
		assert_eq!(session.head(), head, "{label} journals nothing");
	}

	set_test_prop(&mut session, handle, omp_dom::PropId::Status.into(), "completed");
	set_test_prop(
		&mut session,
		handle,
		PropKey::Custom(Str::new_static(jobs::EXECUTION_STATE)),
		"settled",
	);
	let head = session.head();
	assert!(matches!(
		board.prepare_reattach(&session, "exec-42", &test_destination()),
		Err(Refusal::Finished { .. })
	));

	let cause = session.head().expect("journal head");
	let txn = jobs::insert(session.dom(), cause, JobSpec {
		id:      Str::new_static("tool-1"),
		kind:    Str::new_static("tool"),
		owner:   Str::new_static("Main"),
		started: Str::new_static("1"),
		agent:   None,
		lease:   None,
	})
	.expect("jobs root");
	session.patch(txn).expect("insert tool job");
	let head_with_tool = session.head();
	assert_ne!(head_with_tool, head);
	assert!(matches!(
		board.prepare_reattach(&session, "tool-1", &test_destination()),
		Err(Refusal::NotExecution { .. })
	));
	assert_eq!(session.head(), head_with_tool);
	assert_eq!(test_calls(&backend), (1, 0));
	assert_eq!(backend.counts.cancels.load(Ordering::SeqCst), 0);
}

/// T12: the resumed result is delivered once, and only the session that
/// resumed it writes the journal.
#[tokio::test]
async fn execution_t12_resumed_result_is_delivered_once_by_one_writer() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("delivered.oms");
	let backend = effects_unknown_test_job(&path).await;
	let (mut session, board) = open_for_reattach(&path);
	assert!(
		omp_agent::jobs::undelivered(session.dom()).is_empty(),
		"the orphan failure was delivered"
	);
	let resume = board
		.prepare_reattach(&session, "exec-42", &test_destination())
		.expect("the job can resume");
	let (resumer, events) = resume_test_backend(&backend);
	board
		.reattach_execution(&mut session, resume, resumer)
		.await
		.expect("reattach");
	assert!(matches!(
		Session::open(&path, ComponentRegistry::standard()),
		Err(omp_session::SessionError::Journal(omp_journal::JournalError::Locked { .. }))
	));
	assert!(omp_agent::jobs::undelivered(session.dom()).is_empty(), "a live job is not delivered");

	settle_resumed_test_run(&mut session, &board, &events).await;
	let pending = omp_agent::jobs::undelivered(session.dom());
	assert_eq!(
		pending
			.iter()
			.map(|record| record.id.as_str())
			.collect::<Vec<_>>(),
		["exec-42"]
	);
	mark_test_delivered(&mut session, pending[0].handle);
	let delivered_head = session.head();
	board.poll(&mut session).expect("poll after delivery");
	assert!(omp_agent::jobs::undelivered(session.dom()).is_empty());
	assert_eq!(session.head(), delivered_head, "a settled resume journals nothing more");
	drop(board);
	drop(session);

	let (session, _board) = open_for_reattach(&path);
	assert!(omp_agent::jobs::undelivered(session.dom()).is_empty());
	assert_eq!(session.head(), delivered_head);
	assert_eq!(test_calls(&backend), (1, 1));
}

/// Ctrl-C on `omp jobs attach` detaches: nothing is cancelled, and the job
/// settles `EffectsUnknown` with its handle, ready to reattach again.
#[tokio::test]
async fn execution_detach_keeps_resumed_work_running_and_reattachable() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("detached.oms");
	let backend = effects_unknown_test_job(&path).await;
	let (mut session, board) = open_for_reattach(&path);
	let resume = board
		.prepare_reattach(&session, "exec-42", &test_destination())
		.expect("the job can resume");
	let (resumer, _events) = resume_test_backend(&backend);
	let record = board
		.reattach_execution(&mut session, resume, resumer)
		.await
		.expect("reattach");

	let head = session.head();
	assert!(board.detach(record.handle));
	assert!(!board.detach(record.handle));
	assert_eq!(session.head(), head, "detach only signals; poll commits the settlement");
	let detached =
		tokio::time::timeout(std::time::Duration::from_secs(5), board.wait(&mut session, None))
			.await
			.expect("detach settled")
			.expect("journal settlement")
			.expect("job");
	assert_eq!(detached.status, "failed");
	assert_eq!(detached.execution_state, Some(omp_exec::ExecutionState::EffectsUnknown));
	assert_eq!(detached.execution_failure, Some(omp_exec::ExecutionErrorKind::EffectsUnknown));
	assert_eq!(detached.error.as_deref(), Some(omp_agent::EXECUTION_DETACHED));
	assert_test_handle(&detached);
	assert_eq!(backend.counts.cancels.load(Ordering::SeqCst), 0);
	assert_eq!(backend.counts.detaches.load(Ordering::SeqCst), 1);
	board
		.prepare_reattach(&session, "exec-42", &test_destination())
		.expect("detached job can resume");
	assert_eq!(test_calls(&backend), (1, 1));
}

#[tokio::test]
async fn execution_detach_during_start_does_not_wait_for_acceptance() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("detaching-start.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let board = JobBoard::new();
	let (mut backend, _events) = execution_test_backend(false);
	backend.start = TestStart::Stall;
	let record = start_test_execution(&mut session, &board, &backend);
	wait_for_test_start(&backend).await;
	let head = session.head();
	assert!(board.detach(record.handle));
	assert_eq!(session.head(), head);
	let detached =
		tokio::time::timeout(std::time::Duration::from_secs(5), board.wait(&mut session, None))
			.await
			.expect("stalled start detached")
			.expect("journal settlement")
			.expect("job");
	assert_eq!(detached.execution_state, Some(omp_exec::ExecutionState::SubmissionUnknown));
	assert_eq!(detached.execution_failure, Some(omp_exec::ExecutionErrorKind::SubmissionUnknown));
	assert_eq!(detached.error.as_deref(), Some(omp_agent::EXECUTION_DETACHED_BEFORE_ACCEPTANCE));
	assert_eq!(backend.counts.cancels.load(Ordering::SeqCst), 0);
	assert_eq!(backend.counts.detaches.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn execution_detach_before_acceptance_detaches_the_run() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("detaching-before-acceptance.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let board = JobBoard::new();
	let (backend, _events) = execution_test_backend(false);
	let handle = insert_test_execution(&mut session);
	attach_test_execution(&session, &board, handle, &backend).await;
	assert!(board.detach(handle));
	let detached =
		tokio::time::timeout(std::time::Duration::from_secs(5), board.wait(&mut session, None))
			.await
			.expect("detach settled")
			.expect("journal settlement")
			.expect("job");
	assert_eq!(detached.execution_state, Some(omp_exec::ExecutionState::SubmissionUnknown));
	assert_eq!(detached.error.as_deref(), Some(omp_agent::EXECUTION_DETACHED_BEFORE_ACCEPTANCE));
	assert_eq!(backend.counts.detaches.load(Ordering::SeqCst), 1);
	assert_eq!(backend.counts.cancels.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn execution_reattach_clamps_expired_deadline_to_zero() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("expired.oms");
	let _backend = effects_unknown_test_job(&path).await;
	let (mut session, board) = open_for_reattach(&path);
	let handle = board.list()[0].handle;
	set_test_prop(
		&mut session,
		handle,
		PropKey::Custom(Str::new_static(jobs::EXECUTION_DEADLINE)),
		"1",
	);
	let resume = board
		.prepare_reattach(&session, "exec-42", &test_destination())
		.expect("resume");
	assert_eq!(resume.context().outputs, omp_exec::OutputSpec::Logs);
	assert_eq!(resume.context().remaining_deadline, std::time::Duration::ZERO);
}

#[tokio::test]
async fn execution_reattach_backend_failure_does_not_write() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("reattach-failed.oms");
	let backend = effects_unknown_test_job(&path).await;
	let (mut session, board) = open_for_reattach(&path);
	let resume = board
		.prepare_reattach(&session, "exec-42", &test_destination())
		.expect("resume");
	let (mut resumer, _events) = resume_test_backend(&backend);
	resumer.reattach_error = Some(omp_exec::ExecutionError::SubmissionUnknown);
	let head = session.head();
	assert!(matches!(
		board
			.reattach_execution(&mut session, resume, resumer)
			.await,
		Err(omp_agent::ExecutionReattachError::Backend(_))
	));
	assert_eq!(session.head(), head);
	assert_eq!(test_calls(&backend), (1, 1));
	assert_eq!(backend.counts.cancels.load(Ordering::SeqCst), 0);
}

/// Window 1: crash before `requested` commits. Reopen should find no job
/// and the backend should never be contacted.
#[tokio::test]
async fn execution_no_node_no_start_on_restart() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("no-node.oms");
	// Create a session but don't insert any execution job.
	let session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	// Simulate a crash by dropping without any execution node.
	drop(session);

	// Reopen after "restart".
	let session = Session::open(&path, ComponentRegistry::standard()).expect("reopen session");
	let board = JobBoard::new();
	board.rebuild(&session);
	// No execution jobs exist, so nothing to settle.
	assert!(board.list().is_empty());
	assert!(!board.has_finished_units());
}

/// Window 4: crash between backend acceptance and poll commit. The journal
/// knows of the submission marker but not of acceptance, so restart settles
/// `SubmissionUnknown` without starting again.
#[tokio::test]
async fn execution_t13_crash_between_acceptance_and_commit_is_submission_unknown_without_start() {
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("window4.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("create session");
	let handle = insert_requested_test_execution(&mut session);
	mark_test_submission(&mut session, handle);
	let board = JobBoard::new();
	let (mut backend, events) = execution_test_backend(false);
	// Set the journal path so the backend verifies the submission marker.
	backend.journal = Some(path.clone());
	attach_test_execution(&session, &board, handle, &backend).await;
	// Backend accepts the work.
	wait_for_test_acceptance(&board, &events).await;
	// Simulate crash: drop the board before poll can commit the Accepted state.
	drop(board);
	drop(session);

	// Reopen after "restart".
	let mut session = Session::open(&path, ComponentRegistry::standard()).expect("reopen session");
	let board = JobBoard::new();
	board.rebuild(&session);
	let record = board.poll(&mut session).expect("settle orphan").remove(0);
	// The journal has the submission marker but not the Accepted commit,
	// so the job settles SubmissionUnknown.
	assert_eq!(record.status, "failed");
	assert_eq!(record.execution_state, Some(omp_exec::ExecutionState::SubmissionUnknown));
	assert_eq!(
		record.execution_failure,
		Some(omp_exec::ExecutionErrorKind::SubmissionUnknown)
	);
	assert_eq!(record.reattach_handle, None);
	assert_eq!(record.error.as_deref(), Some(omp_agent::ORPHANED_EXECUTION_JOB));
	// The backend started exactly once; no second start on restart.
	assert_eq!(test_calls(&backend), (1, 0));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn execution_failed_resume_patch_detaches_returned_run() {
	const CHILD: &str = "OMP_EXECUTION_RESUME_PATCH_CHILD";
	if std::env::var_os(CHILD).is_none() {
		let output = std::process::Command::new("sh")
			.args(["-c", "trap '' XFSZ; exec \"$@\"", "sh"])
			.arg(std::env::current_exe().expect("test executable"))
			.args(["--exact", "execution_failed_resume_patch_detaches_returned_run", "--nocapture"])
			.env(CHILD, "1")
			.output()
			.expect("run isolated append-failure test");
		assert!(
			output.status.success(),
			"child failed: {}\n{}",
			String::from_utf8_lossy(&output.stdout),
			String::from_utf8_lossy(&output.stderr)
		);
		let stdout = String::from_utf8_lossy(&output.stdout);
		assert!(
			stdout.contains("running 1 test") && stdout.contains("1 passed"),
			"child did not execute test: {stdout}"
		);
		return;
	}
	let temp = tempdir().expect("temporary session directory");
	let path = temp.path().join("resume-append-failure.oms");
	let backend = effects_unknown_test_job(&path).await;
	let (mut session, board) = open_for_reattach(&path);
	let resume = board
		.prepare_reattach(&session, "exec-42", &test_destination())
		.expect("resume");
	let (resumer, _events) = resume_test_backend(&backend);
	let prior_head = session.head();
	let journal_size = std::fs::metadata(&path).expect("journal metadata").len();
	let limit = format!("--fsize={journal_size}:unlimited");
	assert!(
		std::process::Command::new("prlimit")
			.args(["--pid", &std::process::id().to_string(), &limit])
			.status()
			.expect("set file-size limit")
			.success()
	);
	let result = board
		.reattach_execution(&mut session, resume, resumer)
		.await;
	assert!(
		std::process::Command::new("prlimit")
			.args(["--pid", &std::process::id().to_string(), "--fsize=unlimited:unlimited"])
			.status()
			.expect("restore file-size limit")
			.success()
	);
	assert!(matches!(result, Err(omp_agent::ExecutionReattachError::Session(_))));
	assert_eq!(session.head(), prior_head);
	assert_eq!(backend.counts.detaches.load(Ordering::SeqCst), 1);
	assert_eq!(backend.counts.cancels.load(Ordering::SeqCst), 0);
	assert_eq!(test_calls(&backend), (1, 1));
}
