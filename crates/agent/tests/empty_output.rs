//! Bounded empty-output recovery as durable developer nudges and a terminal
//! notice.

use std::sync::{
	Arc,
	atomic::{AtomicBool, Ordering},
};

use omp_agent::{
	Director, DirectorCx, DirectorRegistry, DirectorStack, DispatchPolicy, Kernel, RunControl,
	StaticPrompt, TurnInput, TurnStop, TurnView, Verdict,
};
use omp_ai::{BlockKind, ChatEvent, ContentPart, FinishReason, Role};
use omp_core::Str;
use omp_dom::{PropId, PropKey};
use omp_journal::blob::BlobStore;

mod support;

use support::{
	ScriptedInference, assert_all_entries_caused, completed, empty_script, fresh_session,
	journal_entries, registry, text_script,
};

const RETRY_PREFIX: &str =
	"<system-injection>\nStopped without actionable output; task incomplete.";
const CAP_NOTICE: &str = "Assistant returned no final output after retry cap; try switching models";

struct EmptyObserver(Arc<AtomicBool>);

impl Director for EmptyObserver {
	fn id(&self) -> &str {
		"empty_observer"
	}

	fn on_yield(&self, _: &DirectorCx<'_>, turn: &TurnView) -> Verdict {
		assert!(turn.assistant_text.is_empty());
		self.0.store(true, Ordering::SeqCst);
		Verdict::Yield
	}
}

fn input(text: &str) -> TurnInput {
	TurnInput { text: Str::new(text), attachments: Vec::new() }
}

fn policy(path: &std::path::Path) -> DispatchPolicy {
	DispatchPolicy::new(BlobStore::open(path).expect("blob store opens"))
}

fn request_has_text(request: &omp_ai::ChatRequest, role: Role, expected: &str) -> bool {
	request.messages.iter().any(|message| {
		message.role == role
			&& message
				.content
				.iter()
				.any(|part| matches!(part, ContentPart::Text { text, .. } if text.as_str() == expected))
	})
}

fn contents(session: &omp_session::Session, selector: &str) -> Vec<Str> {
	session
		.dom()
		.select(selector)
		.expect("selector parses")
		.filter_map(|handle| {
			session
				.dom()
				.get(handle)
				.and_then(|node| node.content.clone())
		})
		.collect()
}

#[tokio::test]
async fn empty_output_continues_with_numbered_developer_nudge() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("recover.oms");
	let (inference, requests) = ScriptedInference::new([empty_script(), text_script("recovered")]);
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let mut session = fresh_session(&journal_path);

	let outcome = kernel
		.run_turn(&mut session, input("original"), RunControl::default())
		.await
		.expect("empty output recovers");

	assert_eq!(outcome.stop, TurnStop::Completed);
	assert_eq!(outcome.assistant_text, "recovered");
	let requests = requests.lock();
	assert_eq!(requests.len(), 2);
	assert!(request_has_text(&requests[1], Role::User, "original"));
	let retry = requests[1]
		.messages
		.iter()
		.filter(|message| message.role == Role::System)
		.flat_map(|message| message.content.iter())
		.find_map(|part| match part {
			ContentPart::Text { text, .. } if text.starts_with(RETRY_PREFIX) => Some(text),
			_ => None,
		})
		.expect("second request contains recovery nudge");
	assert!(retry.contains("Attempt #1/3"));
	assert!(
		requests[1]
			.messages
			.iter()
			.all(|message| message.role != Role::Assistant || !message.content.is_empty()),
		"the empty assistant turn is dropped from the retry request"
	);
	drop(requests);
	let developers = contents(&session, "body turn developer");
	assert_eq!(developers.len(), 1);
	assert!(developers[0].contains("Attempt #1/3"));
	assert_eq!(
		session
			.dom()
			.select("body turn notice")
			.expect("selector")
			.count(),
		0
	);

	drop(session);
	let entries = journal_entries(&journal_path);
	assert_all_entries_caused(&entries);
	assert_eq!(
		entries
			.iter()
			.filter(|entry| entry.label.as_deref() == Some("kernel.empty-output-retry"))
			.count(),
		1
	);
}

#[tokio::test]
async fn fourth_empty_output_yields_after_exactly_three_nudges_with_error_notice() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("capped.oms");
	let (inference, requests) =
		ScriptedInference::new([empty_script(), empty_script(), empty_script(), empty_script()]);
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let mut session = fresh_session(&journal_path);

	let outcome = kernel
		.run_turn(&mut session, input("original"), RunControl::default())
		.await
		.expect("retry cap yields visibly");

	assert_eq!(outcome.stop, TurnStop::Completed);
	assert_eq!(outcome.assistant_text, "");
	assert_eq!(requests.lock().len(), 4);
	let developers = contents(&session, "body turn developer");
	assert_eq!(developers.len(), 3);
	for (index, developer) in developers.iter().enumerate() {
		assert!(developer.starts_with(RETRY_PREFIX));
		assert!(developer.contains(&format!("Attempt #{}/3", index + 1)));
	}
	let notices = contents(&session, "body turn notice");
	assert_eq!(notices.as_slice(), [CAP_NOTICE]);
	let notice = session
		.dom()
		.select("body turn notice")
		.expect("selector")
		.next()
		.expect("cap notice exists");
	let kind = PropKey::from(PropId::Kind);
	assert_eq!(
		session
			.dom()
			.get(notice)
			.and_then(|node| node.prop(&kind))
			.and_then(omp_dom::Value::as_str),
		Some("error")
	);

	drop(session);
	let entries = journal_entries(&journal_path);
	assert_all_entries_caused(&entries);
	assert_eq!(
		entries
			.iter()
			.filter(|entry| entry.label.as_deref() == Some("kernel.empty-output-retry"))
			.count(),
		3
	);
	assert_eq!(
		entries
			.iter()
			.filter(|entry| entry.label.as_deref() == Some("kernel.notice"))
			.count(),
		1
	);
}

#[tokio::test]
async fn empty_output_exhaustion_is_offered_to_the_director_stack() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("director-empty.oms");
	let (inference, _) =
		ScriptedInference::new([empty_script(), empty_script(), empty_script(), empty_script()]);
	let observed = Arc::new(AtomicBool::new(false));
	let mut directors = DirectorRegistry::standard();
	directors.register_extension(Box::new(EmptyObserver(Arc::clone(&observed))));
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	)
	.with_director_registry(directors.clone());
	let mut session = fresh_session(&journal_path);
	let mut stack = DirectorStack::from_dom(session.dom(), &directors);
	stack
		.engage_registered(&mut session, "empty_observer")
		.expect("observer engages");
	kernel
		.run_turn(&mut session, input("empty"), RunControl::default())
		.await
		.expect("turn yields through Director");
	assert!(observed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn thought_only_completion_is_empty_until_visible_output_arrives() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("thought-only.oms");
	let thought_only = vec![
		ChatEvent::BlockStarted { index: 0, kind: BlockKind::Thinking },
		ChatEvent::ThinkingDelta { index: 0, text: Str::new_static("private reasoning") },
		completed(FinishReason::Stop, 1),
	];
	let (inference, requests) =
		ScriptedInference::new([thought_only, text_script("visible answer")]);
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let mut session = fresh_session(&journal_path);

	let outcome = kernel
		.run_turn(&mut session, input("answer visibly"), RunControl::default())
		.await
		.expect("thought-only completion recovers");

	assert_eq!(outcome.assistant_text, "visible answer");
	assert_eq!(requests.lock().len(), 2);
	assert_eq!(contents(&session, "body turn developer").len(), 1);
	assert_eq!(
		session
			.dom()
			.select("body turn assistant")
			.expect("selector")
			.count(),
		2
	);
	drop(session);
	assert_all_entries_caused(&journal_entries(&journal_path));
}

#[tokio::test]
async fn fresh_user_turn_resets_the_empty_output_retry_cap() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("fresh-turn.oms");
	let (inference, requests) = ScriptedInference::new([
		empty_script(),
		empty_script(),
		empty_script(),
		empty_script(),
		empty_script(),
		text_script("fresh recovered"),
	]);
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let mut session = fresh_session(&journal_path);

	let capped = kernel
		.run_turn(&mut session, input("first"), RunControl::default())
		.await
		.expect("first turn reaches cap");
	assert_eq!(capped.assistant_text, "");
	let recovered = kernel
		.run_turn(&mut session, input("fresh"), RunControl::default())
		.await
		.expect("fresh turn gets a fresh retry budget");

	assert_eq!(recovered.assistant_text, "fresh recovered");
	assert_eq!(requests.lock().len(), 6);
	assert_eq!(session.dom().select("body turn").expect("selector").count(), 2);
	let attempt_one = contents(&session, "body turn developer")
		.into_iter()
		.filter(|text| text.contains("Attempt #1/3"))
		.count();
	assert_eq!(attempt_one, 2);
	drop(session);
	assert_all_entries_caused(&journal_entries(&journal_path));
}
