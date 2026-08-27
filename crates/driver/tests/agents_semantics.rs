//! Proves supervisor ownership, cancellation, admission limits, and
//! cross-session agent visibility.

use std::{
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::{Duration, Instant},
};

use futures::{Stream, stream};
use omp_agent::{
	AgentKind, AgentTree, Broker, Budget, InvokeFrame, Mailbox, TurnClient, TurnInput, TurnOptions,
	TurnSession,
};
use omp_core::{Str, sf};
use omp_driver::subagent::supervisor::{
	ChildReviver, RevivalFuture, SessionSupervisor, SupervisorError,
};
use omp_inference::TurnId;
use tokio::task;

/// Exists because scripting cannot express a turn client that always fails
/// closed before opening a session.
#[derive(Clone)]
struct NeverTurnClient;

struct NeverTurnSession;

impl TurnClient for NeverTurnClient {
	type Session<'client> = NeverTurnSession;

	async fn turn<'client>(
		&'client self,
		_turn_id: TurnId,
		_input: TurnInput,
		_options: &'client TurnOptions,
	) -> Result<Self::Session<'client>, omp_agent::Error> {
		Err(omp_agent::Error::Closed)
	}
}

impl TurnSession for NeverTurnSession {
	fn events(
		&mut self,
	) -> impl Stream<Item = Result<omp_agent::TurnEvent, omp_agent::Error>> + Send + Unpin + '_ {
		stream::empty()
	}

	async fn submit(&mut self, _frame: InvokeFrame) -> Result<(), omp_agent::Error> {
		Ok(())
	}
}

struct CountingReviver(Arc<AtomicUsize>);

impl ChildReviver<NeverTurnClient> for CountingReviver {
	fn revive(&self) -> RevivalFuture<NeverTurnClient> {
		self.0.fetch_add(1, Ordering::SeqCst);
		Box::pin(async { Err(SupervisorError::RevivalFailed { id: sf!("cold-child") }) })
	}
}

fn child(tree: &AgentTree, id: &str, name: &str, session: &str) -> Arc<omp_agent::AgentNode> {
	tree
		.register(
			Str::from(id),
			Str::from(name),
			AgentKind::Subagent,
			None,
			Str::from(session),
			Budget::default(),
		)
		.expect("register child")
}

#[tokio::test]
async fn supervisor_resolves_names_invokes_cold_reviver_and_releases_ownership() {
	let tree = Arc::new(AgentTree::new(4, 2, 3));
	let supervisor = SessionSupervisor::<NeverTurnClient>::new(Arc::clone(&tree));
	let calls = Arc::new(AtomicUsize::new(0));
	supervisor
		.register_parked(
			child(&tree, "cold-child", "NamedChild", "session"),
			Arc::new(CountingReviver(Arc::clone(&calls))),
		)
		.expect("register parked identity");

	assert_eq!(supervisor.resolve("NamedChild").as_deref(), Some("cold-child"));
	assert_eq!(supervisor.resolve("agent://cold-child#0").as_deref(), Some("cold-child"));
	assert!(matches!(
		supervisor.revive("NamedChild").await,
		Err(SupervisorError::RevivalFailed { .. })
	));
	assert_eq!(calls.load(Ordering::SeqCst), 1, "revive must invoke the cold factory");

	let generation = supervisor
		.state("cold-child")
		.expect("retained state")
		.generation()
		.0;
	supervisor
		.release_at_generation("cold-child", generation)
		.await
		.expect("release parked ownership");
	assert!(supervisor.state("cold-child").is_none());
	assert!(supervisor.resolve("NamedChild").is_none());
}

#[tokio::test]
async fn cancellation_retains_the_exact_reason_and_honors_grace() {
	let tree = Arc::new(AgentTree::new(2, 1, 1));
	let supervisor = SessionSupervisor::<NeverTurnClient>::new(Arc::clone(&tree));
	let state = supervisor
		.register_parked(
			child(&tree, "cold-child", "ColdChild", "session"),
			Arc::new(CountingReviver(Arc::new(AtomicUsize::new(0)))),
		)
		.expect("register parked identity");
	state.begin_generation().expect("mark generation active");
	let started = Instant::now();

	supervisor
		.cancel_with_grace(
			"cold-child",
			state.generation().0,
			sf!("extension requested a graceful stop"),
			Duration::from_millis(20),
		)
		.await
		.expect("cancel retained generation");
	assert!(started.elapsed() >= Duration::from_millis(20));
	assert_eq!(
		supervisor.cancellation_reason("cold-child").as_deref(),
		Some("extension requested a graceful stop")
	);
}

#[tokio::test]
async fn limits_are_a_coherent_live_admission_snapshot() {
	let tree = Arc::new(AgentTree::new(7, 1, 2));
	let first = tree.admit(1).await.expect("first permit");
	let waiting_tree = Arc::clone(&tree);
	let waiting = tokio::spawn(async move { waiting_tree.admit(1).await });
	for _ in 0..100 {
		if tree.limits().queued == 1 {
			break;
		}
		task::yield_now().await;
	}
	let limits = tree.limits();
	assert_eq!(limits.max_depth, 7);
	assert_eq!(limits.max_concurrency, 1);
	assert_eq!(limits.active, 1);
	assert_eq!(limits.queued, 1);
	assert_eq!(limits.max_queue, 2);
	drop(first);
	drop(waiting.await.expect("queued task").expect("queued permit"));
	assert_eq!(tree.limits().active, 0);
	assert_eq!(tree.limits().queued, 0);
}

#[test]
fn project_registry_roster_contains_peers_from_every_session() {
	let broker = Broker::new(sf!("project"));
	let first_tree = AgentTree::new(2, 1, 1);
	let second_tree = AgentTree::new(2, 1, 1);
	let first = child(&first_tree, "first", "First", "session-a");
	let second = child(&second_tree, "second", "Second", "session-b");
	broker
		.register(&first, Mailbox::new().sender())
		.expect("first peer");
	broker
		.register(&second, Mailbox::new().sender())
		.expect("second peer");

	let roster = broker.registry().roster(false);
	assert!(
		roster
			.iter()
			.any(|record| record.id == "first" && record.session == "session-a")
	);
	assert!(
		roster
			.iter()
			.any(|record| record.id == "second" && record.session == "session-b")
	);
}
