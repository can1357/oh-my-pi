//! End-to-end tests for the journal-backed advisor Director.

use std::{collections::VecDeque, future::Future, sync::Arc};

use omp_agent::{
	DispatchPolicy, Inference, Kernel, RunControl, RuntimeFlags, StaticPrompt, TurnInput, TurnStop,
	directors::advisor::{self, MODEL_SELECTOR},
	find_director, state_bool, state_int, state_str,
};
use omp_ai::{
	ChatEvent, ChatRequest, ChatStream, ContentPart, Error, ErrorDetail, ErrorKind,
	ExecutionReceipt, Role,
};
use omp_con::Ctx;
use omp_core::{Str, sf};
use omp_dom::{KnownTag, PropId, PropKey, Tag, Value};
use omp_journal::{
	blob::BlobStore,
	data::{AdvisorMessage, AdvisorSeverity},
};
use omp_session::{ComponentRegistry, Session};
use parking_lot::Mutex;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

mod support;

use support::{empty_script, registry, streaming, text_script, tool_script};

enum AdvisorReply {
	Events(Vec<ChatEvent>),
	Failure(Error),
	Pending(Arc<Notify>),
}

#[derive(Clone)]
struct Calls {
	primary:   Arc<Mutex<Vec<ChatRequest>>>,
	advisor:   Arc<Mutex<Vec<ChatRequest>>>,
	selectors: Arc<Mutex<Vec<Str>>>,
}

struct RoutedInference {
	primary: VecDeque<Vec<ChatEvent>>,
	advisor: VecDeque<AdvisorReply>,
	calls:   Calls,
}

impl RoutedInference {
	fn new(
		primary: impl IntoIterator<Item = Vec<ChatEvent>>,
		advisor: impl IntoIterator<Item = AdvisorReply>,
	) -> (Self, Calls) {
		let calls = Calls {
			primary:   Arc::new(Mutex::new(Vec::new())),
			advisor:   Arc::new(Mutex::new(Vec::new())),
			selectors: Arc::new(Mutex::new(Vec::new())),
		};
		(
			Self {
				primary: primary.into_iter().collect(),
				advisor: advisor.into_iter().collect(),
				calls:   calls.clone(),
			},
			calls,
		)
	}
}

impl Inference for RoutedInference {
	fn chat(
		&mut self,
		request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		self.calls.primary.lock().push(request);
		let events = self
			.primary
			.pop_front()
			.expect("one primary script per request");
		async move { Ok(streaming(events)) }
	}

	fn chat_on(
		&mut self,
		selector: &str,
		request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		self.calls.selectors.lock().push(Str::new(selector));
		self.calls.advisor.lock().push(request);
		let reply = self
			.advisor
			.pop_front()
			.expect("one advisor script per review");
		async move {
			match reply {
				AdvisorReply::Events(events) => Ok(streaming(events)),
				AdvisorReply::Failure(error) => Err(error),
				AdvisorReply::Pending(started) => {
					started.notify_one();
					std::future::pending::<Result<ChatStream, omp_ai::Error>>().await
				},
			}
		}
	}
}

fn advisor_note(note: &str, severity: &str) -> Vec<ChatEvent> {
	tool_script(
		"advisor-1",
		"advise",
		serde_json::json!({
			"note": note,
			"severity": severity,
		}),
	)
}

fn kernel(inference: RoutedInference, root: &std::path::Path) -> Kernel<RoutedInference> {
	Kernel::new(
		inference,
		registry(std::iter::empty()),
		DispatchPolicy::new(BlobStore::open(root.join("blobs")).expect("blob store")),
		StaticPrompt(sf!("primary system")),
	)
	.with_runtime_flags(RuntimeFlags {
		automatic_compaction:     false,
		goal_enabled:             true,
		autolearn_enabled:        false,
		autolearn_min_tool_calls: 5,
		recover_inline_edits:     true,
	})
}

fn session(root: &std::path::Path) -> Session {
	Session::create(root.join("advisor.oms"), ComponentRegistry::standard()).expect("session")
}

fn request_contains(request: &ChatRequest, role: Role, needle: &str) -> bool {
	request.messages.iter().any(|message| {
		message.role == role
			&& message
				.content
				.iter()
				.any(|part| matches!(part, ContentPart::Text { text, .. } if text.contains(needle)))
	})
}

fn append_completed_turn(session: &mut Session, text: &str) {
	session.begin_turn().expect("turn");
	session
		.user("historical request", Vec::new())
		.expect("user");
	session
		.assistant_start("primary", "scripted", "scripted/primary")
		.expect("assistant");
	let turn = *session
		.dom()
		.children(session.dom().body())
		.last()
		.expect("turn handle");
	let assistant = *session
		.dom()
		.children(turn)
		.iter()
		.find(|handle| {
			session
				.dom()
				.get(**handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Assistant))
		})
		.expect("assistant handle");
	let sid = session
		.stream_open(assistant, PropKey::from(PropId::Text))
		.expect("text stream");
	session.stream_append(sid, text).expect("text");
	session.stream_close(sid).expect("close");
	session.assistant_end("stop").expect("assistant end");
}

#[test]
fn ai_advisor_enabled_controls_idempotent_launch_engagement() {
	let root = tempfile::tempdir().expect("temporary directory");
	let mut session = session(root.path());
	let con = Ctx::new();
	advisor::apply_launch(&mut session, &con).expect("disabled launch");
	assert_eq!(
		session
			.dom()
			.count("directors director[family=advisor]")
			.expect("selector"),
		0
	);
	omp_ai::settings::AI_ADVISOR_ENABLED
		.set(&con, true)
		.expect("enable advisor");
	advisor::apply_launch(&mut session, &con).expect("enabled launch");
	advisor::apply_launch(&mut session, &con).expect("idempotent launch");
	assert_eq!(
		session
			.dom()
			.count("directors director[family=advisor]")
			.expect("selector"),
		1
	);
}

#[tokio::test]
async fn blocker_review_continues_and_reaches_the_main_model() {
	let root = tempfile::tempdir().expect("temporary directory");
	let (inference, calls) =
		RoutedInference::new([text_script("candidate"), text_script("fixed")], [
			AdvisorReply::Events(advisor_note("Verify the failing edge.", "blocker")),
			AdvisorReply::Events(empty_script()),
		]);
	let mut kernel = kernel(inference, root.path());
	let mut session = session(root.path());
	advisor::engage(&mut session).expect("advisor engages");

	let outcome = kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("do the work"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("turn completes");
	assert_eq!(outcome.stop, TurnStop::Completed);
	assert!(outcome.assistant_text.ends_with("fixed"));

	let primary = calls.primary.lock();
	assert_eq!(primary.len(), 2, "the blocker consumes one candidate yield");
	assert!(request_contains(
		&primary[1],
		Role::System,
		"<advisory severity=\"blocker\" guidance=\"weigh, don't blindly obey\">"
	));
	drop(primary);
	let advisor_requests = calls.advisor.lock();
	assert_eq!(advisor_requests.len(), 2, "exactly one isolated review per candidate yield");
	assert_eq!(advisor_requests[0].tools.len(), 1);
	assert_eq!(advisor_requests[0].tools[0].name, "advise");
	assert!(request_contains(&advisor_requests[0], Role::System, "peer-shadow main agent"));
	assert!(request_contains(&advisor_requests[0], Role::User, "### Session update"));
	drop(advisor_requests);
	assert_eq!(calls.selectors.lock().as_slice(), [MODEL_SELECTOR, MODEL_SELECTOR]);
	assert_eq!(
		session
			.dom()
			.count("body turn notice[kind=advisor]")
			.expect("notice selector"),
		1
	);
	let notice = session
		.dom()
		.select("body turn notice[kind=advisor]")
		.expect("notice selector")
		.into_iter()
		.next()
		.and_then(|handle| session.dom().get(handle))
		.expect("advisor notice");
	let Some(Value::Json(data)) = notice.prop(&PropId::Data.into()) else {
		panic!("real advisor producer must journal typed notes");
	};
	let message: AdvisorMessage = serde_json::from_str(data.get()).expect("typed advisor payload");
	assert_eq!(message.notes, [omp_journal::data::AdvisorNote {
		advisor:  Str::new_static("default"),
		severity: AdvisorSeverity::Blocker,
		note:     Str::new_static("Verify the failing edge."),
	}]);
	let (_, node) = find_director(session.dom(), advisor::FAMILY).expect("advisor frame");
	assert_eq!(state_str(node, "status").as_deref(), Some("running"));
	assert!(state_bool(node, "yielded").unwrap_or(false));
	assert_eq!(state_int(node, "completed_turns"), Some(2));
	assert_eq!(state_int(node, "immune_start"), Some(2), "cooldown starts on the next turn");

	let live = session.dom().snapshot();
	drop(session);
	let restored = Session::open(root.path().join("advisor.oms"), ComponentRegistry::standard())
		.expect("advisor session replays");
	assert_eq!(restored.dom().snapshot(), live, "typed advisor notes survive replay exactly");
}

#[tokio::test]
async fn sync_backlog_reviews_before_the_next_primary_request() {
	let root = tempfile::tempdir().expect("temporary directory");
	let (inference, calls) = RoutedInference::new([text_script("done")], [
		AdvisorReply::Events(advisor_note("Check the boundary.", "blocker")),
		AdvisorReply::Events(empty_script()),
	]);
	let con = Arc::new(Ctx::new());
	omp_ai::settings::AI_ADVISOR_SYNC_BACKLOG
		.set(&con, Str::new_static("1"))
		.expect("sync backlog");
	let mut kernel = kernel(inference, root.path()).with_con_context(Arc::clone(&con));
	let mut session = session(root.path());
	append_completed_turn(&mut session, "earlier answer");
	advisor::engage(&mut session).expect("advisor engages");

	let outcome = kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("continue"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("turn completes");
	assert_eq!(outcome.stop, TurnStop::Completed);
	let primary = calls.primary.lock();
	assert_eq!(primary.len(), 1);
	assert!(request_contains(&primary[0], Role::System, "<advisory severity=\"blocker\""));
	drop(primary);
	let advisor_requests = calls.advisor.lock();
	assert_eq!(advisor_requests.len(), 2);
	assert!(request_contains(&advisor_requests[0], Role::User, "[in progress — more steps follow]"));
	assert_eq!(calls.selectors.lock().first().map(Str::as_str), Some(MODEL_SELECTOR));
}

#[tokio::test]
async fn missing_advisor_role_is_journaled_as_unhealthy_without_failing_the_primary() {
	let root = tempfile::tempdir().expect("temporary directory");
	let (inference, _) =
		RoutedInference::new([text_script("candidate")], [AdvisorReply::Failure(Error::planning(
			ErrorKind::TargetNotFound,
			ErrorDetail::target(Str::new_static(MODEL_SELECTOR)),
			ExecutionReceipt::default(),
		))]);
	let mut kernel = kernel(inference, root.path());
	let mut session = session(root.path());
	advisor::engage(&mut session).expect("advisor engages");

	let outcome = kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("finish anyway"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("primary turn completes");
	assert_eq!(outcome.stop, TurnStop::Completed);
	let (_, node) = find_director(session.dom(), advisor::FAMILY).expect("advisor frame");
	assert_eq!(state_str(node, "status").as_deref(), Some("no_model"));
	assert!(state_bool(node, "yielded").unwrap_or(false));
}

#[tokio::test]
async fn turn_cancellation_drops_an_in_flight_advisor_without_journaling_delivery() {
	let root = tempfile::tempdir().expect("temporary directory");
	let started = Arc::new(Notify::new());
	let (inference, calls) =
		RoutedInference::new([text_script("candidate")], [AdvisorReply::Pending(Arc::clone(
			&started,
		))]);
	let mut kernel = kernel(inference, root.path());
	let mut session = session(root.path());
	advisor::engage(&mut session).expect("advisor engages");
	let cancellation = CancellationToken::new();
	let trigger = cancellation.clone();
	tokio::spawn(async move {
		started.notified().await;
		trigger.cancel();
	});

	let outcome = kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("cancel the review"), attachments: Vec::new() },
			RunControl::new(cancellation, None),
		)
		.await
		.expect("cancellation is an outcome");
	assert_eq!(outcome.stop, TurnStop::Cancelled);
	assert_eq!(calls.advisor.lock().len(), 1);
	assert_eq!(
		session
			.dom()
			.count("body turn notice[kind=advisor]")
			.expect("selector"),
		0
	);
	let (_, node) = find_director(session.dom(), advisor::FAMILY).expect("advisor frame");
	assert_eq!(state_str(node, "status").as_deref(), Some("running"));
	assert!(!state_bool(node, "yielded").unwrap_or(false));
}
