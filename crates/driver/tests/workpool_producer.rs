//! Joined proof for authenticated work-pool observations.

use std::sync::Arc;

use omp_agent::{EnvEvent, SessionTopology, Up};
use omp_core::Str;
use omp_driver::{
	sessions::{IrcRelayPolicy, KernelHandle, SessionId, SessionRegistry},
	subagent::workpool::{WorkpoolProducerError, WorkpoolRegistry},
};
use omp_journal::data::{IrcDirection, IrcTraffic};
use omp_session::{ComponentRegistry, Session};
use parking_lot::RwLock;

fn register(
	sessions: &SessionRegistry,
	id: &'static str,
	name: &'static str,
	up: flume::Sender<Up>,
	topology: SessionTopology,
) {
	sessions.register(Str::new_static(name), KernelHandle {
		id: SessionId::new(id),
		name: Str::new_static(name),
		up,
		snapshot: Arc::new(RwLock::new(omp_dom::Dom::new().snapshot())),
		topology,
		relay: IrcRelayPolicy::default(),
		autoreply: None,
	});
}

fn receive_workpool(rx: &flume::Receiver<Up>) -> Arc<IrcTraffic> {
	let Up::Env(EnvEvent::IrcTraffic { payload }) = rx.recv().expect("workpool observation") else {
		panic!("producer emits only a typed environment observation");
	};
	assert_eq!(payload.direction, IrcDirection::Workpool);
	payload
}

#[tokio::test]
async fn workpool_producer_authenticates_topology_retries_once_and_replays() {
	let temp = tempfile::tempdir().expect("temporary directory");
	let path = temp.path().join("workpool.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("owner session");
	session.begin_turn().expect("active turn");
	let turn = *session
		.dom()
		.children(session.dom().body())
		.last()
		.expect("turn handle");

	let sessions = Arc::new(SessionRegistry::new());
	let (owner_up, owner_inbox) = flume::bounded(2);
	let (worker_a_up, _worker_a_inbox) = flume::unbounded();
	let (worker_b_up, _worker_b_inbox) = flume::unbounded();
	let (outsider_up, _outsider_inbox) = flume::unbounded();
	register(
		&sessions,
		"owner-id",
		"Owner",
		owner_up.clone(),
		SessionTopology::main(Str::new_static("owner-id")),
	);
	register(
		&sessions,
		"worker-a",
		"WorkerA",
		worker_a_up,
		SessionTopology::child(Str::new_static("owner-id"), Str::new_static("owner-id")),
	);
	register(
		&sessions,
		"worker-b",
		"WorkerB",
		worker_b_up,
		SessionTopology::child(Str::new_static("owner-id"), Str::new_static("owner-id")),
	);
	register(
		&sessions,
		"outsider",
		"Outsider",
		outsider_up,
		SessionTopology::child(Str::new_static("other-root"), Str::new_static("other-root")),
	);

	let authority: Arc<dyn omp_agent::SessionAuthority> = sessions.clone();
	let pools = WorkpoolRegistry::new(authority);
	let pool = pools
		.create("owner-id", Str::new_static("audit"))
		.expect("bind producer");
	assert!(matches!(
		pools.create("owner-id", Str::new_static("audit")),
		Err(WorkpoolProducerError::Duplicate { .. })
	));
	let spawned = pool
		.spawned("worker-a", Str::new_static("[audit#1] inspect parser"))
		.expect("stage spawn");

	owner_up
		.send(Up::Peer(Str::new_static("mailbox pressure one")))
		.expect("fill mailbox");
	owner_up
		.send(Up::Peer(Str::new_static("mailbox pressure two")))
		.expect("fill mailbox");
	assert!(matches!(pool.try_deliver(&spawned), Err(WorkpoolProducerError::MailboxFull { .. })));
	assert!(matches!(
		owner_inbox.recv().expect("first queued message"),
		Up::Peer(body) if body == "mailbox pressure one"
	));
	assert!(matches!(
		owner_inbox.recv().expect("second queued message"),
		Up::Peer(body) if body == "mailbox pressure two"
	));
	let spawned_receipt = pool.try_deliver(&spawned).expect("retry succeeds");
	let first = receive_workpool(&owner_inbox);
	pool
		.try_deliver(&spawned)
		.expect("successful retry is idempotent");
	assert!(owner_inbox.try_recv().is_err(), "successful observation is delivered once");
	assert_eq!(first.pool.as_deref(), Some("audit"));
	assert_eq!(first.mode.as_deref(), Some("spawned"));
	assert_eq!(first.from.as_deref(), Some("pool:audit"));
	assert_eq!(first.to.as_deref(), Some("WorkerA"));
	assert_eq!(first.reply_to, None);

	let mut observations = vec![first];
	let mut prior = spawned_receipt;
	let expected_reply = prior.id().to_owned();
	let staged = pool
		.queued("worker-b", Str::new_static("[audit#2] inspect lexer"), &prior)
		.expect("stage queued transition");
	prior = pool
		.try_deliver(&staged)
		.expect("deliver queued transition");
	let payload = receive_workpool(&owner_inbox);
	assert_eq!(payload.reply_to.as_deref(), Some(expected_reply.as_str()));
	observations.push(payload);

	let expected_reply = prior.id().to_owned();
	let staged = pool
		.dispatched("worker-a", Str::new_static("[audit#3] inspect AST"), &prior)
		.expect("stage dispatched transition");
	prior = pool
		.try_deliver(&staged)
		.expect("deliver dispatched transition");
	let payload = receive_workpool(&owner_inbox);
	assert_eq!(payload.reply_to.as_deref(), Some(expected_reply.as_str()));
	observations.push(payload);

	let expected_reply = prior.id().to_owned();
	let staged = pool
		.batch("worker-b", Str::new_static("batch audit-worker-b-b2"), &prior)
		.expect("stage batch transition");
	prior = pool.try_deliver(&staged).expect("deliver batch transition");
	let payload = receive_workpool(&owner_inbox);
	assert_eq!(payload.reply_to.as_deref(), Some(expected_reply.as_str()));
	observations.push(payload);

	assert!(matches!(
		pool.queued("outsider", Str::new_static("not ours"), &prior),
		Err(WorkpoolProducerError::InvalidTarget { .. })
	));
	let other = pools
		.create("owner-id", Str::new_static("other"))
		.expect("second producer");
	let other_stage = other
		.spawned("worker-a", Str::new_static("other work"))
		.expect("other stage");
	let other_receipt = other.try_deliver(&other_stage).expect("other delivery");
	let _ = receive_workpool(&owner_inbox);
	assert!(matches!(
		pool.batch("worker-a", Str::new_static("spoofed thread"), &other_receipt,),
		Err(WorkpoolProducerError::ForeignReply { .. })
	));

	let cancel = tokio_util::sync::CancellationToken::new();
	owner_up
		.send(Up::Peer(Str::new_static("pressure-1")))
		.expect("fill owner mailbox");
	owner_up
		.send(Up::Peer(Str::new_static("pressure-2")))
		.expect("fill owner mailbox");
	let delivery = tokio::spawn({
		let pool = Arc::clone(&pool);
		let prior = prior.clone();
		let cancel = cancel.clone();
		async move {
			pool
				.deliver_result_once(
					"worker-a",
					Str::new_static("ordinary aggregate result"),
					&prior,
					&cancel,
				)
				.await
		}
	});
	tokio::task::yield_now().await;
	assert!(!delivery.is_finished(), "full owner mailbox backpressures result delivery");
	assert!(matches!(owner_inbox.recv().expect("first pressure row"), Up::Peer(_)));
	assert!(matches!(owner_inbox.recv().expect("second pressure row"), Up::Peer(_)));
	delivery
		.await
		.expect("delivery task")
		.expect("ordinary result delivery");
	let Up::Env(EnvEvent::IrcTraffic { payload: incoming }) =
		owner_inbox.recv().expect("ordinary result observation")
	else {
		panic!("ordinary result has typed incoming observation");
	};
	assert_eq!(incoming.direction, IrcDirection::Incoming);
	assert_eq!(incoming.reply_to.as_deref(), Some(prior.id()));
	assert!(matches!(
		owner_inbox.recv().expect("ordinary result"),
		Up::Peer(body) if body == "ordinary aggregate result"
	));
	assert!(owner_inbox.try_recv().is_err(), "ordinary result delivers exactly once");
	pool
		.deliver_result_once(
			"worker-a",
			Str::new_static("ordinary aggregate result"),
			&prior,
			&cancel,
		)
		.await
		.expect("successful result retry is idempotent");
	assert!(owner_inbox.try_recv().is_err(), "result retry must not duplicate input");

	let completed = pool
		.completed(Str::new_static("Pool `audit` drained"), &prior)
		.expect("stage completion");
	pool.try_deliver(&completed).expect("deliver completion");
	observations.push(receive_workpool(&owner_inbox));
	assert!(matches!(
		pool.dispatched("worker-a", Str::new_static("late work"), &prior),
		Err(WorkpoolProducerError::Closed { mode: omp_journal::data::WorkpoolMode::Completed, .. })
	));
	for pair in observations.windows(2) {
		assert!(pair[0].timestamp_ms < pair[1].timestamp_ms);
	}

	for payload in &observations {
		omp_agent::append_irc_traffic(&mut session, turn, payload).expect("journal observation");
	}
	drop(session);
	let replayed = Session::open(&path, ComponentRegistry::standard()).expect("replay owner");
	let restored = replayed
		.dom()
		.select("notice[kind=irc]")
		.expect("valid selector")
		.map(|handle| {
			let node = replayed.dom().get(handle).expect("notice");
			let Some(omp_dom::Value::Json(data)) =
				node.prop(&omp_dom::PropKey::from(omp_dom::PropId::Data))
			else {
				panic!("typed data");
			};
			serde_json::from_str::<IrcTraffic>(data.get()).expect("typed replay")
		})
		.collect::<Vec<_>>();
	assert_eq!(
		restored,
		observations
			.iter()
			.map(|value| value.as_ref().clone())
			.collect::<Vec<_>>()
	);
	assert!(
		restored
			.iter()
			.all(|traffic| omp_journal::data::WorkpoolObservation::try_from(traffic).is_ok())
	);
	assert!(omp_session::project_thread(replayed.dom()).is_empty());

	let (reset_up, _reset_inbox) = flume::unbounded();
	register(
		&sessions,
		"owner-id",
		"Owner",
		reset_up,
		SessionTopology::main(Str::new_static("owner-id")),
	);
	let rebound = pools
		.create("owner-id", Str::new_static("audit"))
		.expect("session reset replaces stale producer");
	assert!(Arc::ptr_eq(&pools.get("owner-id", "audit").expect("rebound producer"), &rebound,));
	assert!(matches!(
		pool.dispatched("worker-a", Str::new_static("stale owner"), &prior),
		Err(WorkpoolProducerError::StaleOwner { .. })
	));
}

#[test]
fn workpool_cancellation_is_terminal_and_observed_once() {
	let sessions = Arc::new(SessionRegistry::new());
	let (owner_up, owner_inbox) = flume::unbounded();
	let (worker_up, _worker_inbox) = flume::unbounded();
	register(&sessions, "owner", "Owner", owner_up, SessionTopology::main(Str::new_static("owner")));
	register(
		&sessions,
		"worker",
		"Worker",
		worker_up,
		SessionTopology::child(Str::new_static("owner"), Str::new_static("owner")),
	);
	let authority: Arc<dyn omp_agent::SessionAuthority> = sessions;
	let pools = WorkpoolRegistry::new(authority);
	let pool = pools
		.create("owner", Str::new_static("cancelled"))
		.expect("producer");
	pool
		.cancel(Str::new_static("cancel queued work"), None)
		.expect("cancel observation");
	let payload = receive_workpool(&owner_inbox);
	assert_eq!(payload.mode.as_deref(), Some("cancelled"));
	assert_eq!(payload.to.as_deref(), Some("Owner"));
	assert!(owner_inbox.try_recv().is_err());
	assert!(matches!(
		pool.spawned("worker", Str::new_static("late work")),
		Err(WorkpoolProducerError::Closed { mode: omp_journal::data::WorkpoolMode::Cancelled, .. })
	));
	pools.release_owner("owner");
	assert!(pools.get("owner", "cancelled").is_none());
}
