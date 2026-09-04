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
			}
		}),
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
