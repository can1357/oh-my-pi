//! A failed inference is journaled before the kernel returns the error: the
//! open assistant closes with stop reason `error` and the turn carries a
//! `<notice kind=error>` with the full error chain.

use omp_agent::{
	BoxFut, Director, DirectorError, DirectorRegistry, DirectorStack, DispatchPolicy, Inference,
	Kernel, KernelError, MutDirectorCx, Prepared, PromptSource, RunControl, StaticPrompt, TurnInput,
};
use omp_ai::{
	BlockKind, ChatEvent, ChatRequest, ChatStream, Error, ErrorDetail, ErrorKind, ErrorPhase,
	ExecutionReceipt, ProviderId, ReasonId, RecoveryKind, RecoveryRecord, RequestId, ResponseMeta,
	RetryAction, RouteId,
};
use omp_core::Str;
use omp_dom::{PropId, PropKey, Value};
use omp_journal::blob::BlobStore;
use omp_session::{ComponentRegistry, Session};

mod support;

use support::{assert_all_entries_caused, fresh_session, journal_entries, registry};

const HANDSHAKE_REASON: &str = "anthropic.sse.truncated_before_output";

fn truncated_handshake() -> Error {
	Error::new(
		ErrorKind::StreamCorruption,
		ErrorPhase::Handshake,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.status(Some(200))
	.detail(ErrorDetail::stream_ended(
		ReasonId::new_static(HANDSHAKE_REASON),
		std::time::Duration::from_millis(4_200),
		3,
	))
}

/// Fails at the handshake before any stream exists.
struct HandshakeFailure;

impl Inference for HandshakeFailure {
	fn chat(
		&mut self,
		_request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, Error>> + Send {
		std::future::ready(Err(truncated_handshake()))
	}
}

/// Opens the assistant, reveals some text, then fails mid-stream.
struct MidStreamFailure;

impl Inference for MidStreamFailure {
	fn chat(
		&mut self,
		_request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, Error>> + Send {
		let events = vec![
			Ok(ChatEvent::Started(ResponseMeta {
				request_id:          RequestId::from("scripted-request"),
				provider:            ProviderId::from("scripted"),
				route:               RouteId::from("scripted/test"),
				model:               None,
				provider_request_id: None,
				created_at:          std::time::SystemTime::UNIX_EPOCH,
			})),
			Ok(ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text }),
			Ok(ChatEvent::TextDelta { index: 0, text: Str::new_static("partial") }),
			Err(
				Error::new(
					ErrorKind::Connectivity,
					ErrorPhase::Streaming,
					RetryAction::Never,
					ExecutionReceipt::default(),
				)
				.committed(true)
				.detail(ErrorDetail::protocol(ReasonId::new_static("http-response-body"))),
			),
		];
		std::future::ready(Ok(ChatStream::ordinary(Box::pin(futures::stream::iter(events)))))
	}
}

/// Opens an assistant, then surfaces an exhausted Harmony retry carrying
/// typed recovery evidence.
struct HarmonyFailure;

impl Inference for HarmonyFailure {
	fn chat(
		&mut self,
		_request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, Error>> + Send {
		let receipt = ExecutionReceipt {
			recoveries: vec![RecoveryRecord {
				attempt:     2,
				kind:        RecoveryKind::HarmonyLeakDetection,
				rule:        ReasonId::new_static("harmony/codex/shadow-routing-signal"),
				input_bytes: 64,
				steps:       0,
			}],
			..ExecutionReceipt::default()
		};
		let events = vec![
			Ok(ChatEvent::Started(ResponseMeta {
				request_id:          RequestId::from("harmony-request"),
				provider:            ProviderId::from("openai-codex"),
				route:               RouteId::from("openai-codex/responses"),
				model:               None,
				provider_request_id: None,
				created_at:          std::time::SystemTime::UNIX_EPOCH,
			})),
			Err(
				Error::new(
					ErrorKind::MalformedModelOutput,
					ErrorPhase::Recovery,
					RetryAction::Never,
					receipt,
				)
				.detail(ErrorDetail::protocol(ReasonId::new_static("harmony.provable-leak"))),
			),
		];
		std::future::ready(Ok(ChatStream::ordinary(Box::pin(futures::stream::iter(events)))))
	}
}

fn input(text: &str) -> TurnInput {
	TurnInput { text: Str::new(text), attachments: Vec::new() }
}

fn kernel<C: Inference>(inference: C, directory: &std::path::Path) -> Kernel<C> {
	Kernel::new(
		inference,
		registry(std::iter::empty()),
		DispatchPolicy::new(BlobStore::open(directory.join("blobs")).expect("blob store opens")),
		StaticPrompt(Str::new_static("test system")),
	)
}

fn prop(session: &Session, handle: omp_dom::Handle, prop: PropId) -> Option<Str> {
	session
		.dom()
		.get(handle)
		.and_then(|node| node.prop(&PropKey::from(prop)))
		.and_then(Value::as_str)
		.map(Str::new)
}

fn error_notices(session: &Session) -> Vec<Str> {
	session
		.dom()
		.select("body turn notice")
		.expect("selector parses")
		.filter(|handle| prop(session, *handle, PropId::Kind).as_deref() == Some("error"))
		.filter_map(|handle| {
			session
				.dom()
				.get(handle)
				.and_then(|node| node.content.clone())
		})
		.collect()
}

#[tokio::test]
async fn handshake_failure_is_journaled_as_an_error_notice_before_the_error_returns() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("handshake.oms");
	let mut kernel = kernel(HandshakeFailure, directory.path());
	let mut session = fresh_session(&journal_path);

	let error = kernel
		.run_turn(&mut session, input("hi"), RunControl::default())
		.await
		.expect_err("handshake failure surfaces");
	assert!(matches!(error, KernelError::Inference(_)));

	let notices = error_notices(&session);
	assert_eq!(notices.len(), 1, "exactly one error notice, got {notices:?}");
	assert!(notices[0].contains("StreamCorruption"), "{}", notices[0]);
	assert!(notices[0].contains("[http 200]"), "{}", notices[0]);
	assert!(notices[0].contains("stream ended after 4200 ms"), "{}", notices[0]);
	assert!(notices[0].contains(HANDSHAKE_REASON), "{}", notices[0]);
	assert!(!notices[0].contains('×'), "notice is plain error text, not a miette dump");
	assert_eq!(
		session
			.dom()
			.select("body turn assistant")
			.expect("selector")
			.count(),
		0,
		"no assistant opened before the handshake failed"
	);

	drop(session);
	let entries = journal_entries(&journal_path);
	assert_all_entries_caused(&entries);
	let reopened = Session::open(&journal_path, ComponentRegistry::default()).expect("replays");
	assert_eq!(error_notices(&reopened).len(), 1, "the notice is durable across resume");
}

#[tokio::test]
async fn mid_stream_failure_closes_the_assistant_with_error_and_journals_the_cause() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("midstream.oms");
	let mut kernel = kernel(MidStreamFailure, directory.path());
	let mut session = fresh_session(&journal_path);

	let error = kernel
		.run_turn(&mut session, input("hi"), RunControl::default())
		.await
		.expect_err("stream failure surfaces");
	assert!(matches!(error, KernelError::Inference(_)));

	let assistant = session
		.dom()
		.select("body turn assistant")
		.expect("selector")
		.next()
		.expect("the assistant opened before the stream failed");
	assert_eq!(prop(&session, assistant, PropId::StopReason).as_deref(), Some("error"));
	assert_eq!(
		prop(&session, assistant, PropId::Text).as_deref(),
		Some("partial"),
		"revealed text survives the failure"
	);
	let notices = error_notices(&session);
	assert_eq!(notices.len(), 1, "exactly one error notice, got {notices:?}");
	assert!(notices[0].contains("Connectivity"), "{}", notices[0]);
	assert!(notices[0].contains("http-response-body"), "{}", notices[0]);

	// The failure is fully journaled: replaying the file reproduces the same
	// tree, including the closed assistant and the notice.
	let live = session.dom().snapshot();
	drop(session);
	let entries = journal_entries(&journal_path);
	assert_all_entries_caused(&entries);
	let reopened = Session::open(&journal_path, ComponentRegistry::default()).expect("replays");
	assert_eq!(reopened.dom().snapshot(), live);
}

#[tokio::test]
async fn exhausted_harmony_retry_journals_typed_evidence_and_replays_identically() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("harmony.oms");
	let mut kernel = kernel(HarmonyFailure, directory.path());
	let mut session = fresh_session(&journal_path);

	kernel
		.run_turn(&mut session, input("hi"), RunControl::default())
		.await
		.expect_err("exhausted Harmony leak surfaces");

	let usage = session
		.dom()
		.select("body turn usage")
		.expect("selector")
		.next()
		.expect("failure receipt");
	let recovery = session
		.dom()
		.get(usage)
		.and_then(|node| node.prop(&PropKey::Custom(Str::new_static("recoveries"))));
	let json = match recovery {
		Some(Value::Json(raw)) => {
			serde_json::from_str::<serde_json::Value>(raw.get()).expect("recovery evidence JSON")
		},
		other => panic!("unexpected recovery evidence: {other:?}"),
	};
	assert_eq!(json[0]["kind"], "harmony_leak_detection");
	assert_eq!(json[0]["attempt"], 2);

	let live = session.dom().snapshot();
	drop(session);
	let reopened = Session::open(&journal_path, ComponentRegistry::default()).expect("replays");
	assert_eq!(reopened.dom().snapshot(), live);
}

/// Panics if inference is ever reached: the failures below happen before the
/// assistant opens.
struct UnreachableInference;

impl Inference for UnreachableInference {
	fn chat(
		&mut self,
		_request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, Error>> + Send {
		std::future::ready(Err(Error::new(
			ErrorKind::InternalInvariant,
			ErrorPhase::Handshake,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)))
	}
}

/// An engaged Director whose cold `before_inference` hook fails.
struct FailingDirector;

impl Director for FailingDirector {
	fn id(&self) -> &str {
		"failing-director"
	}

	fn before_inference<'a>(
		&'a self,
		_cx: &'a mut MutDirectorCx<'_>,
		_req: &ChatRequest,
	) -> BoxFut<'a, Result<Prepared, DirectorError>> {
		Box::pin(std::future::ready(Err(DirectorError::ExtensionCallback)))
	}
}

/// A prompt projection that cannot render.
struct BrokenPrompt;

impl PromptSource for BrokenPrompt {
	fn system_items(
		&self,
		_dom: &omp_dom::Dom,
	) -> Result<Vec<omp_proto::thread::v1::Item>, omp_agent::PromptError> {
		Err(omp_agent::PromptError::Template(omp_scribe::Error::UndefinedKey {
			template: Str::new_static("status"),
			path:     Str::new_static("missing-slot"),
			line:     1,
			col:      1,
			snippet:  Str::new_static("{{ missing-slot }}\n^~~~"),
		}))
	}
}

fn assert_pre_inference_failure_journaled(session: Session, journal_path: &std::path::Path) {
	assert_eq!(
		session
			.dom()
			.select("body turn assistant")
			.expect("selector")
			.count(),
		0,
		"no assistant opened before the pre-inference failure"
	);
	let notices = error_notices(&session);
	assert_eq!(notices.len(), 1, "exactly one error notice, got {notices:?}");
	let live = session.dom().snapshot();
	drop(session);
	let entries = journal_entries(journal_path);
	assert_all_entries_caused(&entries);
	let reopened = Session::open(journal_path, ComponentRegistry::default()).expect("replays");
	assert_eq!(reopened.dom().snapshot(), live, "the notice is durable across resume");
}

#[tokio::test]
async fn director_before_inference_failure_is_journaled_before_the_assistant_opens() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("director.oms");
	let mut registry = DirectorRegistry::standard();
	registry.register_extension(Box::new(FailingDirector));
	let mut kernel =
		kernel(UnreachableInference, directory.path()).with_director_registry(registry.clone());
	let mut session = fresh_session(&journal_path);
	DirectorStack::from_dom(session.dom(), &registry)
		.engage(&mut session, Box::new(FailingDirector))
		.expect("director engages");

	let error = kernel
		.run_turn(&mut session, input("hi"), RunControl::default())
		.await
		.expect_err("director failure surfaces");
	assert!(matches!(error, KernelError::Director(DirectorError::ExtensionCallback)), "{error}");
	let notices = error_notices(&session);
	assert!(notices[0].contains("extension Director callback failed"), "{}", notices[0]);
	assert_pre_inference_failure_journaled(session, &journal_path);
}

#[tokio::test]
async fn prompt_projection_failure_is_journaled_with_its_source_chain() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("prompt.oms");
	let mut kernel = Kernel::new(
		UnreachableInference,
		registry(std::iter::empty()),
		DispatchPolicy::new(BlobStore::open(directory.path().join("blobs")).expect("blob store")),
		BrokenPrompt,
	);
	let mut session = fresh_session(&journal_path);

	let error = kernel
		.run_turn(&mut session, input("hi"), RunControl::default())
		.await
		.expect_err("prompt failure surfaces");
	assert!(matches!(error, KernelError::Prompt(_)), "{error}");
	let notices = error_notices(&session);
	assert!(notices[0].contains("system prompt projection failed"), "{}", notices[0]);
	assert!(notices[0].contains("missing-slot"), "source chain names the template: {}", notices[0]);
	assert_pre_inference_failure_journaled(session, &journal_path);
}
