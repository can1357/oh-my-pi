//! Joined proof for live-session hub routing.

use std::{
	future::ready,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::SystemTime,
};

use futures::stream;
use omp_agent::{
	AutoreplyRequest, EnvEvent, Inference, Kernel, PeerAutoreply, RunControl, SessionTopology,
	StaticPrompt, TurnInput, Up,
};
use omp_ai::{
	BlockKind, ChatEvent, ChatRequest, ChatStream, Completion, ExecutionReceipt, FinishReason,
	RequestId, ResponseMeta, Usage,
};
use omp_catalog::{ProviderId, RouteId};
use omp_core::Str;
use omp_dom::{KnownTag, NodeSpec, Op, PropId, PropKey, Tag, Txn, Value};
use omp_driver::{
	sessions::{IrcRelayPolicy, KernelHandle, SessionId, SessionRegistry},
	subagent::hub::SessionHub,
};
use omp_journal::data::{IrcDirection, IrcTraffic};
use omp_session::{ComponentRegistry, Session};
use omp_tool::Registry;
use parking_lot::{Mutex, RwLock};

struct CaptureAutoreply {
	request: Mutex<Option<AutoreplyRequest>>,
}

impl PeerAutoreply for CaptureAutoreply {
	fn generation(&self) -> Str {
		Str::new_static("capture")
	}

	fn start(&self, request: AutoreplyRequest) -> bool {
		*self.request.lock() = Some(request);
		true
	}

	fn rebind(&self, _blobs: omp_journal::blob::BlobStore) {}

	fn cancel(&self) {}
}

struct OneTurn;

impl Inference for OneTurn {
	fn chat(
		&mut self,
		_request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		let events = [
			ChatEvent::Started(ResponseMeta {
				request_id:          RequestId::from("hub-test"),
				provider:            ProviderId::from("test"),
				route:               RouteId::from("test/route"),
				model:               None,
				provider_request_id: None,
				created_at:          SystemTime::UNIX_EPOCH,
			}),
			ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text },
			ChatEvent::TextDelta { index: 0, text: Str::new_static("done") },
			ChatEvent::Completed(Completion {
				reason:  FinishReason::Stop,
				blocks:  1,
				usage:   Usage::default(),
				receipt: ExecutionReceipt::default().into(),
			}),
		]
		.into_iter()
		.map(Ok);
		ready(Ok(ChatStream::ordinary(Box::pin(stream::iter(events)))))
	}
}

#[test]
fn await_send_hands_authenticated_envelope_to_recipient_actor() {
	let sessions = SessionRegistry::new();
	let (main_up, main_inbox) = flume::unbounded();
	let (child_up, child_inbox) = flume::unbounded();
	let actor = Arc::new(CaptureAutoreply { request: Mutex::new(None) });
	sessions.register(Str::new_static("Main"), KernelHandle {
		id:        SessionId::new("main-id"),
		name:      Str::new_static("Main"),
		up:        main_up,
		snapshot:  Arc::new(RwLock::new(omp_dom::Dom::new().snapshot())),
		topology:  SessionTopology::main(Str::new_static("main-id")),
		relay:     IrcRelayPolicy::default(),
		autoreply: None,
	});
	sessions.register(Str::new_static("Child"), KernelHandle {
		id:        SessionId::new("child-id"),
		name:      Str::new_static("Child"),
		up:        child_up,
		snapshot:  Arc::new(RwLock::new(omp_dom::Dom::new().snapshot())),
		topology:  SessionTopology::child(Str::new_static("main-id"), Str::new_static("main-id")),
		relay:     IrcRelayPolicy::default(),
		autoreply: Some(actor.clone()),
	});

	SessionHub::send_expecting_reply(
		&sessions,
		"main-id",
		"Child",
		Str::new_static("question"),
		Some(Str::new_static("prior-message")),
	)
	.expect("await send");
	let request = actor.request.lock().clone().expect("autoreply obligation");
	assert!(!request.message_id.is_empty());
	assert_eq!(request.from_id, "main-id");
	assert_eq!(request.from, "Main");
	assert_eq!(request.to_id, "child-id");
	assert_eq!(request.to, "Child");
	assert_eq!(request.body, "question");
	assert_eq!(request.reply_to.as_deref(), Some("prior-message"));
	assert!(matches!(child_inbox.recv().expect("incoming observation"), Up::Env(_)));
	assert!(matches!(
		child_inbox.recv().expect("ordinary delivery"),
		Up::Peer(body) if body == "question"
	));
	assert!(child_inbox.try_recv().is_err());
	assert!(main_inbox.try_recv().is_err(), "main sender is never relayed back to itself");
}

#[test]
fn third_party_relay_is_authenticated_display_only_and_replay_stable() {
	let sessions = SessionRegistry::new();
	let enabled = Arc::new(AtomicBool::new(true));
	let (main_up, main_inbox) = flume::unbounded();
	let (alpha_up, alpha_inbox) = flume::unbounded();
	let (beta_up, beta_inbox) = flume::unbounded();
	let policy = {
		let enabled = Arc::clone(&enabled);
		IrcRelayPolicy::new(move || enabled.load(Ordering::Acquire))
	};
	sessions.register(Str::new_static("Console"), KernelHandle {
		id:        SessionId::new("root-1"),
		name:      Str::new_static("Console"),
		up:        main_up.clone(),
		snapshot:  Arc::new(RwLock::new(omp_dom::Dom::new().snapshot())),
		topology:  SessionTopology::main(Str::new_static("root-1")),
		relay:     policy.clone(),
		autoreply: None,
	});
	sessions.register(Str::new_static("Alpha"), KernelHandle {
		id:        SessionId::new("alpha-id"),
		name:      Str::new_static("Alpha"),
		up:        alpha_up,
		snapshot:  Arc::new(RwLock::new(omp_dom::Dom::new().snapshot())),
		topology:  SessionTopology::child(Str::new_static("root-1"), Str::new_static("root-1")),
		relay:     IrcRelayPolicy::default(),
		autoreply: None,
	});
	sessions.register(Str::new_static("Beta"), KernelHandle {
		id:        SessionId::new("beta-id"),
		name:      Str::new_static("Beta"),
		up:        beta_up,
		snapshot:  Arc::new(RwLock::new(omp_dom::Dom::new().snapshot())),
		topology:  SessionTopology::child(Str::new_static("alpha-id"), Str::new_static("root-1")),
		relay:     IrcRelayPolicy::default(),
		autoreply: None,
	});

	SessionHub::send(
		&sessions,
		"alpha-id",
		"Beta",
		Str::new_static("peer body"),
		Some(Str::new_static("thread-7")),
	)
	.expect("third-party send");
	let Up::Env(EnvEvent::IrcTraffic { payload: incoming }) =
		beta_inbox.recv().expect("recipient observation")
	else {
		panic!("recipient receives typed IRC traffic");
	};
	assert_eq!(incoming.direction, IrcDirection::Incoming);
	assert_eq!(incoming.from.as_deref(), Some("Alpha"));
	assert_eq!(incoming.to.as_deref(), Some("Beta"));
	assert_eq!(incoming.reply_to.as_deref(), Some("thread-7"));
	assert!(matches!(
		beta_inbox.recv().expect("ordinary peer input"),
		Up::Peer(body) if body == "peer body"
	));
	assert!(beta_inbox.try_recv().is_err());

	let Up::Env(EnvEvent::IrcTraffic { payload: relay }) =
		main_inbox.recv().expect("main relay observation")
	else {
		panic!("main receives one display-only relay");
	};
	assert_eq!(relay.direction, IrcDirection::Relay);
	assert_eq!(relay.from.as_deref(), Some("Alpha"));
	assert_eq!(relay.to.as_deref(), Some("Beta"));
	assert_eq!(relay.reply_to.as_deref(), Some("thread-7"));
	assert_eq!(relay.body, "peer body");
	assert!(main_inbox.try_recv().is_err(), "relay must not become model input");

	let temp = tempfile::tempdir().expect("temporary directory");
	let path = temp.path().join("relay.oms");
	let mut main = Session::create(&path, ComponentRegistry::standard()).expect("main session");
	main.begin_turn().expect("turn");
	let turn = *main
		.dom()
		.children(main.dom().body())
		.last()
		.expect("active turn");
	omp_agent::append_irc_traffic(&mut main, turn, relay.as_ref()).expect("journal relay");
	assert!(
		omp_session::project_thread(main.dom()).is_empty(),
		"display-only relay must not enter the model projection"
	);
	drop(main);
	let replayed = Session::open(&path, ComponentRegistry::standard()).expect("replay relay");
	let notice = replayed
		.dom()
		.select("notice[kind=irc]")
		.expect("valid selector")
		.next()
		.and_then(|handle| replayed.dom().get(handle))
		.expect("replayed IRC notice");
	let Some(Value::Json(data)) = notice.prop(&PropKey::from(PropId::Data)) else {
		panic!("typed relay data");
	};
	let restored: IrcTraffic = serde_json::from_str(data.get()).expect("deserialize relay");
	assert_eq!(restored, *relay);

	enabled.store(false, Ordering::Release);
	SessionHub::send(&sessions, "Alpha", "beta-id", Str::new_static("policy off"), None)
		.expect("ordinary delivery remains enabled");
	assert!(matches!(beta_inbox.recv().expect("incoming while disabled"), Up::Env(_)));
	assert!(matches!(beta_inbox.recv().expect("peer while disabled"), Up::Peer(_)));
	assert!(main_inbox.try_recv().is_err());

	enabled.store(true, Ordering::Release);
	sessions.remove(SessionId::from_ref("root-1"));
	SessionHub::send(&sessions, "Alpha", "Beta", Str::new_static("root disconnected"), None)
		.expect("peer delivery survives root disconnect");
	assert!(matches!(beta_inbox.recv().expect("disconnected incoming"), Up::Env(_)));
	assert!(matches!(beta_inbox.recv().expect("disconnected peer"), Up::Peer(_)));
	assert!(main_inbox.try_recv().is_err());

	sessions.register(Str::new_static("Console"), KernelHandle {
		id:        SessionId::new("root-1"),
		name:      Str::new_static("Console"),
		up:        main_up.clone(),
		snapshot:  Arc::new(RwLock::new(omp_dom::Dom::new().snapshot())),
		topology:  SessionTopology::main(Str::new_static("root-1")),
		relay:     policy.clone(),
		autoreply: None,
	});
	sessions.register(Str::new_static("Console 2"), KernelHandle {
		id:        SessionId::new("root-2"),
		name:      Str::new_static("Console 2"),
		up:        main_up,
		snapshot:  Arc::new(RwLock::new(omp_dom::Dom::new().snapshot())),
		topology:  SessionTopology::main(Str::new_static("root-2")),
		relay:     policy,
		autoreply: None,
	});
	sessions.remove(SessionId::from_ref("root-1"));
	assert_eq!(
		sessions
			.lookup(SessionId::from_ref("beta-id"))
			.expect("live beta")
			.topology
			.main_id,
		"root-2"
	);
	SessionHub::send(&sessions, "Alpha", "Beta", Str::new_static("after session switch"), None)
		.expect("delivery after root switch");
	assert!(matches!(beta_inbox.recv().expect("switched incoming"), Up::Env(_)));
	assert!(matches!(beta_inbox.recv().expect("switched peer"), Up::Peer(_)));
	assert!(matches!(
		main_inbox.recv().expect("relay after switch"),
		Up::Env(EnvEvent::IrcTraffic { payload }) if payload.direction == IrcDirection::Relay
	));
	assert!(main_inbox.try_recv().is_err());

	SessionHub::send(&sessions, "Alpha", "all", Str::new_static("broadcast"), None)
		.expect("broadcast");
	let Up::Env(EnvEvent::IrcTraffic { payload }) =
		main_inbox.recv().expect("main direct broadcast")
	else {
		panic!("main receives the broadcast directly");
	};
	assert_eq!(payload.direction, IrcDirection::Incoming);
	assert!(matches!(main_inbox.recv().expect("main broadcast input"), Up::Peer(_)));
	assert!(main_inbox.try_recv().is_err(), "broadcast sibling legs suppress relay");
	assert!(matches!(alpha_inbox.recv().expect("sender observation"), Up::Env(_)));
	assert!(matches!(alpha_inbox.recv().expect("sender broadcast input"), Up::Peer(_)));
	assert!(matches!(beta_inbox.recv().expect("beta observation"), Up::Env(_)));
	assert!(matches!(beta_inbox.recv().expect("beta broadcast input"), Up::Peer(_)));

	sessions.remove(SessionId::from_ref("beta-id"));
	assert!(
		SessionHub::send(&sessions, "Alpha", "Beta", Str::new_static("cancelled target"), None,)
			.is_err()
	);
	assert!(main_inbox.try_recv().is_err());
}

#[tokio::test]
async fn send_lands_in_child_steering_and_inbox_reads_it() {
	let temp = tempfile::tempdir().expect("temporary directory");
	let mut child = Session::create(temp.path().join("child.oms"), ComponentRegistry::standard())
		.expect("child session");
	let spill =
		omp_journal::blob::BlobStore::open(temp.path().join("artifacts")).expect("artifact store");
	let mut kernel = Kernel::new(
		OneTurn,
		Arc::new(Registry::new()),
		omp_agent::DispatchPolicy::new(spill),
		StaticPrompt(Str::new_static("test")),
	);
	let sessions = SessionRegistry::new();
	let (main_up, _main_inbox) = flume::unbounded();
	sessions.register(Str::new_static("Main"), KernelHandle {
		id:        SessionId::new("main"),
		name:      Str::new_static("Main"),
		up:        main_up,
		snapshot:  Arc::new(RwLock::new(child.dom().snapshot())),
		topology:  SessionTopology::main(Str::new_static("main")),
		relay:     IrcRelayPolicy::default(),
		autoreply: None,
	});
	sessions.register(Str::new_static("Child"), KernelHandle {
		id:        SessionId::new("child"),
		name:      Str::new_static("Child"),
		up:        kernel.mailbox(),
		snapshot:  Arc::new(RwLock::new(child.dom().snapshot())),
		topology:  SessionTopology::child(Str::new_static("main"), Str::new_static("main")),
		relay:     IrcRelayPolicy::default(),
		autoreply: None,
	});

	SessionHub::send(&sessions, "Main", "child", Str::new_static("please adjust"), None)
		.expect("hub send");
	kernel
		.run_turn(
			&mut child,
			TurnInput { text: Str::new_static("work"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("child turn");

	let response = SessionHub::inbox(&mut child, true).expect("hub inbox");
	assert!(response.text.as_str().contains("please adjust"));
	let drained = SessionHub::inbox(&mut child, false).expect("hub drain");
	assert!(drained.text.as_str().contains("please adjust"));
	assert!(
		SessionHub::inbox(&mut child, true)
			.expect("empty inbox")
			.useless
	);
}

/// `hub inbox` is the peer bus: it drains `hub=true` queue items only. User
/// steering shares `<queues><steering>` but belongs to the kernel safe point.
#[test]
fn hub_inbox_leaves_user_steering_queued() {
	let temp = tempfile::tempdir().expect("temporary directory");
	let mut session =
		Session::create(temp.path().join("s.oms"), ComponentRegistry::standard()).expect("session");
	let steering = session
		.dom()
		.children(session.dom().queues())
		.iter()
		.copied()
		.find(|handle| {
			session
				.dom()
				.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Steering))
		})
		.expect("steering queue");
	let queued =
		|node: NodeSpec| node.with_prop(PropId::Status, Value::Str(Str::new_static("queued")));
	let cause = session.head().expect("journal head");
	session
		.patch(Txn {
			cause,
			label: None,
			ops: vec![
				Op::Ins {
					parent: steering,
					after:  None,
					node:   queued(NodeSpec::new(KnownTag::User))
						.with_prop(PropKey::Custom(Str::new_static("hub")), Value::Bool(true))
						.with_content(Str::new_static("peer says hi")),
				},
				Op::Ins {
					parent: steering,
					after:  None,
					node:   queued(NodeSpec::new(KnownTag::User))
						.with_content(Str::new_static("user redirect")),
				},
			],
		})
		.expect("queue both items");

	let peeked = SessionHub::inbox(&mut session, true).expect("peek");
	assert!(peeked.text.as_str().contains("peer says hi"));
	assert!(!peeked.text.as_str().contains("user redirect"));

	let drained = SessionHub::inbox(&mut session, false).expect("drain");
	assert!(drained.text.as_str().contains("peer says hi"));
	assert!(!drained.text.as_str().contains("user redirect"));

	let remaining = session
		.dom()
		.children(steering)
		.iter()
		.filter_map(|handle| session.dom().get(*handle)?.content.clone())
		.collect::<Vec<_>>();
	assert_eq!(remaining, vec![Str::new_static("user redirect")]);
	assert!(
		SessionHub::inbox(&mut session, true)
			.expect("peer inbox is empty")
			.useless
	);
}
