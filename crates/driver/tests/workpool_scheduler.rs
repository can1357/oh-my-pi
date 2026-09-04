//! Joined workpool scheduling, persistence, and owner-lifecycle contracts.

use std::{
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
	time::Duration,
};

use async_trait::async_trait;
use omp_agent::{JobBoard, SessionTopology, Up, jobs::undelivered};
use omp_core::{Str, sf};
use omp_driver::{
	sessions::{IrcRelayPolicy, KernelHandle, SessionId, SessionRegistry},
	subagent::{
		workpool::WorkpoolRegistry,
		workpool_scheduler::{
			SchedulerRegistry, SessionMutator, WorkerBatch, WorkerEvent, WorkerHandle, WorkerSpawn,
			WorkpoolCreate, WorkpoolLauncher, WorkpoolParentHost, WorkpoolPolicy,
			WorkpoolSchedulerError, WorkpoolSessionHost,
		},
	},
};
use omp_envd::eval::ParentSessionHost as _;
use omp_session::{ComponentRegistry, Session};
use parking_lot::RwLock;
use serde_json::json;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

struct Policy {
	limit: usize,
	fresh: bool,
}

impl WorkpoolPolicy for Policy {
	fn concurrency_limit(&self) -> usize {
		self.limit
	}

	fn fresh_agents(&self) -> bool {
		self.fresh
	}

	fn eval_tools_enabled(&self) -> bool {
		true
	}
}

struct Launcher {
	sessions:  Arc<SessionRegistry>,
	snapshot:  Arc<RwLock<omp_dom::Snapshot>>,
	main:      Str,
	spawned:   AtomicUsize,
	active:    Arc<AtomicUsize>,
	maximum:   Arc<AtomicUsize>,
	die_once:  Arc<AtomicBool>,
	forwarded: Arc<RwLock<Option<Arc<omp_tools::eval::EvalToolRoster>>>>,
}

#[async_trait]
impl WorkpoolLauncher for Launcher {
	async fn spawn(
		&self,
		request: WorkerSpawn,
		events: flume::Sender<WorkerEvent>,
	) -> Result<WorkerHandle, WorkpoolSchedulerError> {
		self.spawned.fetch_add(1, Ordering::Relaxed);
		*self.forwarded.write() = request.eval_tools.clone();
		let (batches, batch_rx) = flume::unbounded::<WorkerBatch>();
		let cancel = CancellationToken::new();
		let (mailbox, mailbox_rx) = flume::unbounded::<Up>();
		self.sessions.register(request.id.clone(), KernelHandle {
			id:        SessionId::new(request.id.clone()),
			name:      request.id.clone(),
			up:        mailbox,
			snapshot:  Arc::clone(&self.snapshot),
			topology:  SessionTopology::child(request.owner.clone(), self.main.clone()),
			relay:     IrcRelayPolicy::fixed(true),
			autoreply: None,
		});
		let id = request.id.clone();
		let child_cancel = cancel.clone();
		let (finished_tx, finished) = flume::bounded(1);
		let active = Arc::clone(&self.active);
		let maximum = Arc::clone(&self.maximum);
		let die_once = Arc::clone(&self.die_once);
		let task = tokio::spawn(async move {
			let _mailbox_rx = mailbox_rx;
			loop {
				let batch = tokio::select! {
					() = child_cancel.cancelled() => break,
					batch = batch_rx.recv_async() => match batch {
						Ok(batch) => batch,
						Err(_) => break,
					},
				};
				let width = active.fetch_add(1, Ordering::SeqCst) + 1;
				maximum.fetch_max(width, Ordering::SeqCst);
				let delay = if batch
					.items
					.iter()
					.any(|(_, text)| text.as_str() == "running")
				{
					250
				} else {
					15
				};
				tokio::time::sleep(Duration::from_millis(delay)).await;
				active.fetch_sub(1, Ordering::SeqCst);
				if batch.items.iter().any(|(_, text)| text.as_str() == "die")
					&& die_once.swap(false, Ordering::SeqCst)
				{
					let _ = events
						.send_async(WorkerEvent::Dead {
							worker: id.clone(),
							error:  Str::new_static("simulated worker death"),
						})
						.await;
					break;
				}
				let success = !batch.items.iter().any(|(_, text)| text.as_str() == "fail");
				let output = batch
					.items
					.iter()
					.map(|(item, text)| sf!("{item}: {text}"))
					.collect::<Vec<_>>()
					.join("\n");
				let _ = events
					.send_async(WorkerEvent::Settled {
						worker: id.clone(),
						batch: batch.id,
						output: Str::new(output),
						success,
						alive: true,
						context_tokens: Some(100),
						context_window: Some(1_000),
					})
					.await;
			}
			let _ = finished_tx.send(());
		});
		let abort = task.abort_handle();
		Ok(WorkerHandle { id: request.id, batches, cancel, finished, abort })
	}
}

struct Harness {
	registry:    Arc<SchedulerRegistry>,
	parent:      Arc<Mutex<Session>>,
	jobs:        Arc<JobBoard>,
	launcher:    Arc<Launcher>,
	producers:   Arc<WorkpoolRegistry>,
	owner_actor: tokio::task::JoinHandle<()>,
}

impl Harness {
	/// Closes every owner mailbox and joins the sole session actor before
	/// replay.
	async fn release_session_owner(self) -> std::path::PathBuf {
		let Self { registry, parent, jobs, launcher, producers, owner_actor } = self;
		registry.release_owner();
		launcher.sessions.remove(&SessionId::new(sf!("owner")));
		drop(registry);
		drop(jobs);
		drop(producers);
		drop(launcher);
		let path = parent.lock().await.journal_path().to_path_buf();
		drop(parent);
		owner_actor
			.await
			.expect("owner actor stops after its mailbox closes");
		path
	}
}

fn harness(limit: usize, fresh: bool, die_once: bool) -> Harness {
	let temp = tempfile::tempdir().expect("temporary directory");
	let path = temp.keep().join("owner.oms");
	let parent = Session::create(path, ComponentRegistry::standard()).expect("parent session");
	let spill = parent.blobs().clone();
	let snapshot = Arc::new(RwLock::new(parent.dom().snapshot()));
	let sessions = Arc::new(SessionRegistry::new());
	let (mailbox, owner_inbox) = flume::unbounded();
	sessions.register(sf!("owner"), KernelHandle {
		id:        SessionId::new(sf!("owner")),
		name:      sf!("owner"),
		up:        mailbox.clone(),
		snapshot:  Arc::clone(&snapshot),
		topology:  SessionTopology::main(sf!("owner")),
		relay:     IrcRelayPolicy::fixed(true),
		autoreply: None,
	});
	let authority: Arc<dyn omp_agent::SessionAuthority> = sessions.clone();
	let producers = Arc::new(WorkpoolRegistry::new(authority));
	let launcher = Arc::new(Launcher {
		sessions,
		snapshot,
		main: sf!("owner"),
		spawned: AtomicUsize::new(0),
		active: Arc::new(AtomicUsize::new(0)),
		maximum: Arc::new(AtomicUsize::new(0)),
		die_once: Arc::new(AtomicBool::new(die_once)),
		forwarded: Arc::new(RwLock::new(None)),
	});
	let parent = Arc::new(Mutex::new(parent));
	let actor_parent = Arc::clone(&parent);
	let owner_actor = tokio::spawn(async move {
		while let Ok(message) = owner_inbox.recv_async().await {
			if let Up::SessionMutation(request) = message {
				request.apply(&mut *actor_parent.lock().await);
			}
		}
	});
	let jobs = Arc::new(JobBoard::new());
	let registry = Arc::new(SchedulerRegistry::new(
		sf!("owner"),
		SessionMutator::new(mailbox),
		Arc::clone(&jobs),
		spill,
		Arc::clone(&producers),
		launcher.clone(),
		Arc::new(Policy { limit, fresh }),
		omp_tools::eval::EvalSessionControl::default(),
	));
	Harness { registry, parent, jobs, launcher, producers, owner_actor }
}

async fn wait_pending(pool: &omp_driver::subagent::workpool_scheduler::Workpool, expected: usize) {
	for _ in 0..200 {
		if pool.peek().pending == expected {
			return;
		}
		tokio::time::sleep(Duration::from_millis(5)).await;
	}
	panic!("pool did not reach pending={expected}");
}

async fn wait_closed(pool: &omp_driver::subagent::workpool_scheduler::Workpool) {
	for _ in 0..200 {
		if pool.status().closed {
			return;
		}
		tokio::time::sleep(Duration::from_millis(5)).await;
	}
	panic!("pool did not close after draining");
}

async fn wait_finished(jobs: &JobBoard, id: &str) {
	for _ in 0..200 {
		if jobs.has_finished(id) {
			return;
		}
		tokio::time::sleep(Duration::from_millis(5)).await;
	}
	panic!("aggregate execution did not finish");
}

#[tokio::test]
async fn eval_parent_host_routes_workpool_mutations_through_the_kernel_actor() {
	let harness = harness(1, false, false);
	let host = WorkpoolParentHost::new(
		WorkpoolSessionHost::new(std::path::PathBuf::from("/project")),
		Arc::clone(&harness.registry),
	);
	let progress = omp_envd::eval::NoopBridgeProgress;
	let created = host
		.workpool(json!({"op":"create","name":"eval-live","agent":"task"}), &progress)
		.await
		.expect("eval parent create");
	assert_eq!(created["name"], "eval-live");
	let pushed = host
		.workpool(json!({"op":"push","name":"eval-live","items":["one"]}), &progress)
		.await
		.expect("eval parent push");
	assert_eq!(pushed["ids"], json!(["eval-live#1"]));
	let pool = harness.registry.get("eval-live").expect("live routed pool");
	wait_closed(&pool).await;
	assert!(
		omp_driver::subagent::workpool_scheduler::replayed_state(
			&*harness.parent.lock().await,
			"eval-live",
		)
		.is_some(),
		"kernel actor committed durable workpool state"
	);
}

#[tokio::test]
async fn authenticated_eval_registrations_reach_each_child_with_exact_identity() {
	let harness = harness(1, false, false);
	harness
		.registry
		.bridge_call(json!({
			"op": "create",
			"name": "eval-pool",
			"agent": "task",
			"tools": ["score"],
			"tool_registrations": [{
				"name": "score",
				"description": "Score one candidate",
				"parameters": {
					"type": "object",
					"properties": { "candidate": { "type": "string" } },
					"required": ["candidate"],
					"additionalProperties": false
				},
				"rev": 7,
				"handler": "0123456789abcdef0123456789abcdef",
				"generation": 4
			}]
		}))
		.await
		.expect("authenticated bridge registration");
	let pool = harness.registry.get("eval-pool").expect("created pool");
	pool.push(vec![sf!("candidate")]).await.expect("queue item");
	wait_pending(&pool, 0).await;

	let forwarded = harness.launcher.forwarded.read();
	let roster = forwarded.as_ref().expect("forwarded roster");
	assert_eq!(roster.generation, 4);
	assert_eq!(roster.tools.len(), 1);
	assert_eq!(roster.tools[0].name, "score");
	assert_eq!(roster.tools[0].rev, 7);
	assert_eq!(roster.tools[0].handler, "0123456789abcdef0123456789abcdef");
	assert_eq!(roster.tools[0].parameters["required"], json!(["candidate"]));
	drop(forwarded);
	pool.close().await.expect("close pool");

	assert!(matches!(
		harness
			.registry
			.bridge_call(json!({
				"op": "create",
				"name": "forged",
				"tools": ["score"],
				"tool_registrations": []
			}))
			.await,
		Err(WorkpoolSchedulerError::EvalToolRegistrationMismatch)
	));
}

#[tokio::test]
async fn persistent_workers_batch_queue_and_aggregate_delivery_stays_atomic() {
	let harness = harness(1, false, false);
	let pool = harness
		.registry
		.create(WorkpoolCreate {
			name:    sf!("audit"),
			agent:   sf!("task"),
			context: Some(sf!("shared context")),
		})
		.expect("create pool");
	assert_eq!(
		pool
			.push(vec![sf!("one"), sf!("two"), sf!("three")])
			.await
			.expect("push")
			.len(),
		3
	);
	wait_pending(&pool, 0).await;
	let status = pool.status();
	assert_eq!(status.agents.len(), 1);
	assert_eq!(status.agents[0].turns, 2);
	assert_eq!(status.batches, 2);
	assert_eq!(status.items.completed, 3);
	assert!(undelivered(harness.parent.lock().await.dom()).is_empty());
	wait_closed(&pool).await;
	wait_finished(&harness.jobs, "audit").await;
	let mut parent = harness.parent.lock().await;
	let settled = harness
		.jobs
		.wait(&mut parent, Some(&[sf!("audit")]))
		.await
		.expect("wait aggregate")
		.expect("aggregate job");
	drop(parent);
	assert_eq!(settled.status, "completed");
	assert!(pool.status().closed, "the aggregate closes itself when the queue drains");
	assert!(matches!(
		pool.push(vec![sf!("late")]).await,
		Err(WorkpoolSchedulerError::Closed { .. })
	));
	assert!(pool.close().await.expect("idempotent close").is_empty());
	let aggregate: serde_json::Value =
		serde_json::from_str(settled.output.as_deref().expect("aggregate output").get())
			.expect("aggregate JSON");
	let text = aggregate["text"].as_str().expect("aggregate text");
	let first = text.find("[audit#1]").expect("first item");
	let second = text.find("[audit#2]").expect("second item");
	let third = text.find("[audit#3]").expect("third item");
	assert!(first < second && second < third, "aggregate preserves push order");
	assert!(
		text.find("## Items").expect("item section")
			< text.find("## Batch attempts").expect("attempts")
	);
	let pending = undelivered(harness.parent.lock().await.dom());
	assert_eq!(pending.len(), 1);
	assert_eq!(pending[0].id, "audit");
	let _ = pool.peek();
	let path = {
		let parent = harness.parent.lock().await;
		assert_eq!(undelivered(parent.dom()).len(), 1);
		let durable = omp_driver::subagent::workpool_scheduler::replayed_state(&parent, "audit")
			.expect("durable pool state")
			.get()
			.to_owned();
		assert!(durable.contains(r#""closed":true"#), "{durable}");
		assert!(durable.contains(r#""status":"completed""#), "{durable}");
		parent.journal_path().to_path_buf()
	};
	drop(pool);
	let released_path = harness.release_session_owner().await;
	assert_eq!(released_path, path);
	let replayed = Session::open(path, ComponentRegistry::standard()).expect("replay pool state");
	let durable = omp_driver::subagent::workpool_scheduler::replayed_state(&replayed, "audit")
		.expect("replayed pool state")
		.get();
	assert!(durable.contains(r#""closed":true"#), "{durable}");
	assert!(durable.contains(r#""audit#3""#), "{durable}");
}

#[tokio::test]
async fn restart_adopts_durable_drained_pool_before_settlement_patch() {
	let harness = harness(1, false, false);
	let pool = harness
		.registry
		.create(WorkpoolCreate { name: sf!("adopt"), agent: sf!("task"), context: None })
		.expect("create pool");
	pool.push(vec![sf!("one")]).await.expect("push");
	wait_closed(&pool).await;
	wait_finished(&harness.jobs, "adopt").await;
	let path = harness.parent.lock().await.journal_path().to_path_buf();
	assert_eq!(
		harness
			.jobs
			.list()
			.into_iter()
			.find(|record| record.id == "adopt")
			.expect("live aggregate")
			.status,
		"running",
		"simulate a crash before JobBoard poll commits settlement"
	);
	drop(pool);
	let released_path = harness.release_session_owner().await;
	assert_eq!(released_path, path);

	let mut replayed = Session::open(path, ComponentRegistry::standard()).expect("restart parent");
	let board = JobBoard::new();
	board.rebuild(&replayed);
	let adopted = board
		.wait(&mut replayed, Some(&[sf!("adopt")]))
		.await
		.expect("adopt settlement")
		.expect("durable pool remains addressable");
	assert_eq!(adopted.status, "completed");
	let output = adopted.output.as_deref().expect("adopted aggregate output");
	assert!(output.get().contains("Pool `adopt` completed"), "{}", output.get());
}

#[tokio::test]
async fn failed_batch_marks_every_correlated_item_failed() {
	let harness = harness(1, false, false);
	let pool = harness
		.registry
		.create(WorkpoolCreate { name: sf!("failure"), agent: sf!("task"), context: None })
		.expect("create pool");
	let ids = pool
		.push(vec![sf!("first"), sf!("fail"), sf!("third")])
		.await
		.expect("push");
	wait_pending(&pool, 0).await;
	assert_eq!(ids, vec![sf!("failure#1"), sf!("failure#2"), sf!("failure#3")]);
	let status = pool.status();
	assert_eq!(status.items.completed, 1);
	assert_eq!(status.items.failed, 2);
	assert_eq!(status.items.cancelled, 0);
}

#[tokio::test]
async fn dead_worker_requeues_active_work_on_a_replacement() {
	let harness = harness(1, false, true);
	let pool = harness
		.registry
		.create(WorkpoolCreate { name: sf!("recovery"), agent: sf!("task"), context: None })
		.expect("create pool");
	pool.push(vec![sf!("die")]).await.expect("push");
	wait_pending(&pool, 0).await;
	let status = pool.status();
	assert_eq!(status.items.completed, 1);
	assert_eq!(status.batches, 2);
	assert_eq!(harness.launcher.spawned.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn fresh_policy_honors_concurrency_and_uses_one_worker_per_item() {
	let harness = harness(2, true, false);
	let pool = harness
		.registry
		.create(WorkpoolCreate { name: sf!("fresh"), agent: sf!("task"), context: None })
		.expect("create pool");
	pool
		.push(vec![sf!("a"), sf!("b"), sf!("c"), sf!("d")])
		.await
		.expect("push");
	wait_pending(&pool, 0).await;
	wait_closed(&pool).await;
	wait_finished(&harness.jobs, "fresh").await;
	assert_eq!(harness.launcher.spawned.load(Ordering::Relaxed), 4);
	assert!(harness.launcher.maximum.load(Ordering::Relaxed) <= 2);
	let status = pool.status();
	assert_eq!(status.items.completed, 4);
	assert!(status.agents.is_empty(), "fresh workers retire after exactly one item");
	let mut parent = harness.parent.lock().await;
	let settled = harness
		.jobs
		.wait(&mut parent, Some(&[sf!("fresh")]))
		.await
		.expect("wait fresh aggregate")
		.expect("fresh aggregate");
	assert_eq!(settled.status, "completed");
}

#[tokio::test]
async fn owner_release_cancels_pool_and_revokes_its_authenticated_producer() {
	let harness = harness(1, false, false);
	let pool = harness
		.registry
		.create(WorkpoolCreate { name: sf!("reset"), agent: sf!("task"), context: None })
		.expect("create pool");
	pool.push(vec![sf!("running")]).await.expect("push");
	for _ in 0..200 {
		if !pool.peek().batches.is_empty() {
			break;
		}
		tokio::time::sleep(Duration::from_millis(5)).await;
	}
	assert!(!pool.peek().batches.is_empty(), "active batch was dispatched");
	harness.registry.release_owner();
	wait_finished(&harness.jobs, "reset").await;
	let mut parent = harness.parent.lock().await;
	let settled = harness
		.jobs
		.wait(&mut parent, Some(&[sf!("reset")]))
		.await
		.expect("wait cancelled")
		.expect("aggregate job");
	drop(parent);
	assert_eq!(settled.status, "cancelled");
	let status = pool.status();
	assert_eq!(status.items.cancelled, 1);
	assert_eq!(pool.peek().batches[0].status, "cancelled");
	assert!(harness.producers.get("owner", "reset").is_none());
}
