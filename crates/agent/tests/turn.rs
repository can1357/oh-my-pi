//! Journal and DOM contracts for complete, tool-using, steered, and interrupted
//! turns.

use std::{
	future::{Future, ready},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::{Duration, SystemTime},
};

use omp_agent::{
	DispatchPolicy, Inference, Kernel, KernelEvent, RunControl, StaticPrompt, ToolScopedAbortReason,
	TurnInput, TurnStop, Up,
};
use omp_ai::{
	BlockKind, ChatEvent, ChatRequest, ChatStream, ContentPart, FinishReason, ProviderId, RequestId,
	ResponseMeta, Role, RouteId, ToolCall, ToolCallId, call::OpaqueJson,
};
use omp_core::Str;
use omp_dom::{PropId, PropKey};
use omp_journal::{blob::BlobStore, kind};

mod support;
use support::{
	ScriptedInference, assert_all_entries_caused, completed, fresh_session, journal_entries,
	registry, spec, text_script, tool_script,
};

struct PendingCallInference;

impl Inference for PendingCallInference {
	fn chat(
		&mut self,
		_: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		ready(Ok(ChatStream::ordinary(Box::pin(async_stream::stream! {
			yield Ok(ChatEvent::Started(ResponseMeta {
				request_id: RequestId::from("cancel-pending"),
				provider: ProviderId::from("scripted"),
				route: RouteId::from("scripted/test"),
				model: None,
				provider_request_id: None,
				created_at: SystemTime::UNIX_EPOCH,
			}));
			yield Ok(ChatEvent::ToolCallStarted {
				index: 0,
				id: ToolCallId::from("pending-1"),
				name: Str::new_static("echo"),
			});
			futures::future::pending::<()>().await;
		}))))
	}
}

struct ScopedAbortInference {
	ready: Arc<tokio::sync::Notify>,
}

impl Inference for ScopedAbortInference {
	fn chat(
		&mut self,
		_: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		let calls_ready = Arc::clone(&self.ready);
		ready(Ok(ChatStream::ordinary(Box::pin(async_stream::stream! {
			yield Ok(ChatEvent::Started(ResponseMeta {
				request_id: RequestId::from("scoped-abort"),
				provider: ProviderId::from("scripted"),
				route: RouteId::from("scripted/test"),
				model: None,
				provider_request_id: None,
				created_at: SystemTime::UNIX_EPOCH,
			}));
			yield Ok(ChatEvent::ToolCallReady {
				index: 0,
				call: ToolCall {
					id: ToolCallId::from("innocent-read"),
					name: Str::new_static("read"),
					arguments: OpaqueJson::new(serde_json::json!({})),
				},
			});
			yield Ok(ChatEvent::ToolCallReady {
				index: 1,
				call: ToolCall {
					id: ToolCallId::from("invalid-edit"),
					name: Str::new_static("edit"),
					arguments: OpaqueJson::new(serde_json::json!({})),
				},
			});
			calls_ready.notify_one();
			std::future::pending::<()>().await;
		}))))
	}
}

fn input(text: &str) -> TurnInput {
	TurnInput { text: Str::new(text), attachments: Vec::new() }
}

fn pause_script(text: &str) -> Vec<ChatEvent> {
	vec![
		ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text },
		ChatEvent::TextDelta { index: 0, text: Str::new(text) },
		completed(FinishReason::Other(Str::new_static("pause_turn")), 1),
	]
}

fn policy(path: &std::path::Path) -> DispatchPolicy {
	DispatchPolicy::new(BlobStore::open(path).expect("blob store opens"))
}

fn prop_text<'a>(session: &'a omp_session::Session, selector: &str, prop: PropId) -> &'a str {
	let handle = session
		.dom()
		.select(selector)
		.expect("selector parses")
		.next()
		.expect("node exists");
	let key = PropKey::from(prop);
	session
		.dom()
		.get(handle)
		.expect("node materializes")
		.prop(&key)
		.and_then(omp_dom::Value::as_str)
		.expect("text property exists")
}

#[tokio::test]
async fn user_turn_journals_assistant_text_in_the_explicit_turn() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("text.oms");
	let (inference, requests) = ScriptedInference::new([text_script("pong")]);
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let mut session = fresh_session(&journal_path);

	let outcome = kernel
		.run_turn(&mut session, input("reply once"), RunControl::default())
		.await
		.expect("turn completes");

	assert_eq!(outcome.stop, TurnStop::Completed);
	assert_eq!(outcome.assistant_text, "pong");
	assert_eq!(requests.lock().len(), 1);
	assert_eq!(
		session
			.dom()
			.select("body turn user")
			.expect("selector")
			.count(),
		1
	);
	assert_eq!(
		session
			.dom()
			.select("body turn assistant")
			.expect("selector")
			.count(),
		1
	);
	assert_eq!(prop_text(&session, "body turn assistant", PropId::Text), "pong");
	// The receipt needs TTFT and duration; both are kernel-clock measurements
	// the projection cannot derive later.
	let usage = session
		.dom()
		.select("body turn usage")
		.expect("selector")
		.next()
		.expect("receipt materializes");
	let usage = session.dom().get(usage).expect("usage node");
	assert!(matches!(usage.prop(&PropKey::from(PropId::DurationMs)), Some(omp_dom::Value::Int(_))));
	assert!(matches!(usage.prop(&PropKey::from(PropId::TtftMs)), Some(omp_dom::Value::Int(_))));
	assert!(matches!(usage.prop(&PropKey::from(PropId::CacheRead)), Some(omp_dom::Value::Int(0))));

	drop(session);
	let entries = journal_entries(&journal_path);
	assert_all_entries_caused(&entries);
	for required in [
		kind::TURN_START,
		kind::MSG_USER,
		kind::MSG_ASSISTANT_START,
		kind::MSG_ASSISTANT_END,
		kind::TURN_RECEIPT,
	] {
		assert!(
			entries
				.iter()
				.any(|entry| entry.kind.name.as_str() == required),
			"missing {required}"
		);
	}
}

#[tokio::test]
async fn paused_completion_resamples_and_replays_durable_evidence() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("paused.oms");
	let (inference, requests) =
		ScriptedInference::new([pause_script("Scanning first."), text_script("All done.")]);
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let mut session = fresh_session(&journal_path);

	let outcome = kernel
		.run_turn(&mut session, input("inspect"), RunControl::default())
		.await
		.expect("paused completion continues");
	assert_eq!(outcome.stop, TurnStop::Completed);
	let requests = requests.lock();
	assert_eq!(requests.len(), 2);
	assert!(requests[1].messages.iter().any(|message| {
		message.role == Role::Assistant
			&& message.content.iter().any(
				|part| matches!(part, ContentPart::Text { text, .. } if text.as_str() == "Scanning first."),
			)
	}));
	drop(requests);
	let paused = session
		.dom()
		.select("body turn assistant[stop-reason=pause_turn]")
		.expect("selector")
		.next()
		.expect("paused assistant");
	let paused = session.dom().get(paused).expect("assistant materializes");
	assert_eq!(
		paused
			.prop(&PropKey::Custom(Str::new_static("continuation-decision")))
			.and_then(omp_dom::Value::as_str),
		Some("scheduled")
	);
	assert!(matches!(
		paused.prop(&PropKey::Custom(Str::new_static("continuation-attempt"))),
		Some(omp_dom::Value::Int(1))
	));

	let live = session.dom().snapshot();
	drop(session);
	let replayed =
		omp_session::Session::open(&journal_path, omp_session::ComponentRegistry::default())
			.expect("journal replays");
	assert_eq!(replayed.dom().snapshot().as_bytes(), live.as_bytes());
	let paused = replayed
		.dom()
		.select("body turn assistant[stop-reason=pause_turn]")
		.expect("selector")
		.next()
		.expect("paused assistant replays");
	let paused = replayed.dom().get(paused).expect("replayed assistant");
	assert_eq!(
		paused
			.prop(&PropKey::Custom(Str::new_static("continuation-decision")))
			.and_then(omp_dom::Value::as_str),
		Some("scheduled")
	);
}

#[tokio::test]
async fn paused_completion_caps_consecutive_resamples_without_spinning() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("paused-cap.oms");
	let scripts = (0..9).map(|_| pause_script(""));
	let (inference, requests) = ScriptedInference::new(scripts);
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let mut session = fresh_session(&journal_path);

	let outcome = kernel
		.run_turn(&mut session, input("inspect"), RunControl::default())
		.await
		.expect("cap yields cleanly");
	assert_eq!(outcome.stop, TurnStop::Completed);
	assert_eq!(requests.lock().len(), 9, "initial sample plus eight continuations");
	assert_eq!(
		session
			.dom()
			.count("body turn assistant[stop-reason=pause_turn]")
			.expect("selector"),
		9
	);
	let last = session
		.dom()
		.select("body turn assistant[stop-reason=pause_turn]")
		.expect("selector")
		.last()
		.expect("last paused assistant");
	let last = session.dom().get(last).expect("assistant materializes");
	assert_eq!(
		last
			.prop(&PropKey::Custom(Str::new_static("continuation-decision")))
			.and_then(omp_dom::Value::as_str),
		Some("capped")
	);
	assert!(matches!(
		last.prop(&PropKey::Custom(Str::new_static("continuation-attempt"))),
		Some(omp_dom::Value::Int(8))
	));
}

#[tokio::test]
async fn tool_progress_rearms_paused_completion_cap() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("paused-rearm.oms");
	let mut scripts = (0..8)
		.map(|_| pause_script("phase one"))
		.collect::<Vec<_>>();
	scripts.push(tool_script("echo-1", "echo", serde_json::json!({})));
	scripts.extend((0..8).map(|_| pause_script("phase two")));
	scripts.push(text_script("done"));
	let (inference, requests) = ScriptedInference::new(scripts);
	let mut kernel = Kernel::new(
		inference,
		registry([spec("echo", 1, "progress")]),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let mut session = fresh_session(&journal_path);

	let outcome = kernel
		.run_turn(&mut session, input("inspect"), RunControl::default())
		.await
		.expect("tool progress rearms continuation cap");
	assert_eq!(outcome.stop, TurnStop::Completed);
	assert_eq!(requests.lock().len(), 18);
	let attempts =
		session
			.dom()
			.select("body turn assistant[stop-reason=pause_turn]")
			.expect("selector")
			.map(|handle| {
				match session.dom().get(handle).and_then(|node| {
					node.prop(&PropKey::Custom(Str::new_static("continuation-attempt")))
				}) {
					Some(omp_dom::Value::Int(attempt)) => *attempt,
					_ => panic!("paused completion carries an attempt"),
				}
			})
			.collect::<Vec<_>>();
	assert_eq!(attempts, [1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8]);
}

#[tokio::test]
async fn queued_follow_up_blocks_paused_completion_resample() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("paused-pending.oms");
	let (inference, requests) = ScriptedInference::new([pause_script("waiting")]);
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	kernel
		.mailbox()
		.send(Up::Queue { text: Str::new_static("next user turn"), attachments: Vec::new() })
		.expect("follow-up queues");
	let mut session = fresh_session(&journal_path);

	let outcome = kernel
		.run_turn(&mut session, input("inspect"), RunControl::default())
		.await
		.expect("pending input yields");
	assert_eq!(outcome.stop, TurnStop::Completed);
	assert_eq!(requests.lock().len(), 1);
	let paused = session
		.dom()
		.select("body turn assistant[stop-reason=pause_turn]")
		.expect("selector")
		.next()
		.expect("paused assistant");
	assert_eq!(
		session.dom().get(paused).and_then(|node| {
			node
				.prop(&PropKey::Custom(Str::new_static("continuation-decision")))
				.and_then(omp_dom::Value::as_str)
		}),
		Some("pending-input")
	);
}

#[tokio::test]
async fn runtime_pause_blocks_paused_completion_provider_admission() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("paused-runtime.oms");
	let (inference, requests) =
		ScriptedInference::new([pause_script("waiting"), text_script("done")]);
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let up = kernel.mailbox();
	up.send(Up::Pause { active: true }).expect("pause queues");
	let mut session = fresh_session(&journal_path);
	let run = kernel.run_turn(&mut session, input("inspect"), RunControl::default());
	tokio::pin!(run);

	assert!(
		tokio::time::timeout(Duration::from_millis(25), &mut run)
			.await
			.is_err(),
		"paused runtime must hold the turn"
	);
	assert!(requests.lock().is_empty(), "pause prevents provider admission");
	up.send(Up::Pause { active: false }).expect("resume queues");
	let outcome = tokio::time::timeout(Duration::from_secs(2), &mut run)
		.await
		.expect("resumed turn settles")
		.expect("resumed turn succeeds");
	assert_eq!(outcome.stop, TurnStop::Completed);
	assert_eq!(requests.lock().len(), 2);
}

#[tokio::test]
async fn tool_call_round_settles_in_the_dom_then_runs_second_inference() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("tool.oms");
	let mut tool_round = vec![
		ChatEvent::BlockStarted { index: 0, kind: BlockKind::Thinking },
		ChatEvent::ThinkingDelta { index: 0, text: Str::new_static("unsigned reasoning") },
	];
	tool_round.extend(tool_script("echo-1", "echo", serde_json::json!({})));
	let (inference, requests) = ScriptedInference::new([tool_round, text_script("hello from tool")]);
	let mut kernel = Kernel::new(
		inference,
		registry([spec("echo", 1, "hello").streaming("progress", Duration::ZERO)]),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let events = kernel.subscribe();
	let mut session = fresh_session(&journal_path);

	let outcome = kernel
		.run_turn(&mut session, input("use echo"), RunControl::default())
		.await
		.expect("tool turn completes");

	assert_eq!(outcome.stop, TurnStop::Completed);
	assert_eq!(outcome.assistant_text, "hello from tool");
	let events = events.try_iter().collect::<Vec<_>>();
	assert_eq!(events, [
		KernelEvent::InferenceStarted,
		KernelEvent::ThinkingDelta(Str::new_static("unsigned reasoning")),
		KernelEvent::ToolReady {
			call_id: Str::new_static("echo-1"),
			name:    Str::new_static("echo"),
		},
		KernelEvent::ToolUpdate { call_id: Str::new_static("echo-1") },
		KernelEvent::ToolSettled { call_id: Str::new_static("echo-1"), is_error: false },
		KernelEvent::InferenceStarted,
		KernelEvent::TextDelta(Str::new_static("hello from tool")),
		KernelEvent::TurnEnded { stop: TurnStop::Completed },
	]);
	let requests = requests.lock();
	assert_eq!(requests.len(), 2);
	assert!(!requests[1].messages.iter().any(|message| {
		message
			.content
			.iter()
			.any(|part| matches!(part, ContentPart::Reasoning { proof: None, .. }))
	}));
	assert!(requests[1].messages.iter().any(|message| {
		message.content.iter().any(|part| matches!(part, ContentPart::ToolResult { content, .. }
			if content.iter().any(|part| matches!(part, omp_ai::ToolResultContent::Text(text) if text == "hello"))))
	}));
	drop(requests);
	assert_eq!(
		session
			.dom()
			.select("body turn echo")
			.expect("selector")
			.count(),
		1
	);
	assert_eq!(
		session
			.dom()
			.select("body turn echo input")
			.expect("selector")
			.count(),
		1
	);
	assert_eq!(
		session
			.dom()
			.select("body turn echo result")
			.expect("selector")
			.count(),
		1
	);
	assert_eq!(prop_text(&session, "body turn echo result", PropId::Text), "progress");

	drop(session);
	let entries = journal_entries(&journal_path);
	assert_all_entries_caused(&entries);
	let call = entries
		.iter()
		.find(|entry| entry.kind.name.as_str() == kind::TOOL_CALL)
		.expect("tool call journals");
	let result = entries
		.iter()
		.find(|entry| entry.kind.name.as_str() == kind::TOOL_RESULT)
		.expect("tool result journals");
	assert_eq!(result.by, Some(call.id));
}

#[tokio::test]
async fn scoped_stream_abort_labels_siblings_in_call_order_and_replays() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("scoped-stream-abort.oms");
	let ready = Arc::new(tokio::sync::Notify::new());
	let mut kernel = Kernel::new(
		ScopedAbortInference { ready: Arc::clone(&ready) },
		registry([spec("read", 1, "unused"), spec("edit", 1, "unused")]),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let up = kernel.mailbox();
	let mut session = fresh_session(&journal_path);

	let outcome = {
		let run = kernel.run_turn(&mut session, input("stream two calls"), RunControl::default());
		tokio::pin!(run);
		tokio::select! {
			() = ready.notified() => {},
			result = &mut run => panic!("turn ended before both calls were authorized: {result:?}"),
		}
		up.send(Up::AbortTools(ToolScopedAbortReason::one(
			"invalid-edit",
			"TTSR matched rule: no-unwrap",
			"TTSR interrupt on another tool call",
		)))
		.expect("scoped abort queues");
		(&mut run)
			.await
			.expect("scoped abort is a terminal turn outcome")
	};
	assert_eq!(outcome.stop, TurnStop::Cancelled);
	let innocent_text = support::result_text(&session, "innocent-read");
	assert!(
		innocent_text[0].contains("TTSR interrupt on another tool call"),
		"innocent sibling receives the neutral label"
	);
	assert!(
		!innocent_text[0].contains("TTSR matched rule"),
		"innocent sibling is not blamed for the matching call"
	);
	assert!(
		support::result_text(&session, "invalid-edit")[0].contains("TTSR matched rule: no-unwrap"),
		"matching call receives its own abort reason"
	);

	let entries = journal_entries(&journal_path);
	let calls = entries
		.iter()
		.filter(|entry| entry.kind.name.as_str() == kind::TOOL_CALL)
		.map(|entry| entry.id)
		.collect::<Vec<_>>();
	let results = entries
		.iter()
		.filter(|entry| entry.kind.name.as_str() == kind::TOOL_RESULT)
		.map(|entry| entry.by.expect("result is caused by its call"))
		.collect::<Vec<_>>();
	assert_eq!(results, calls, "placeholder settlement follows provider call order");
	let execution_started = PropKey::Custom(Str::new_static("execution-started"));
	for selector in ["body turn read[id=innocent-read]", "body turn edit[id=invalid-edit]"] {
		let call = session
			.dom()
			.select(selector)
			.expect("selector parses")
			.next()
			.expect("call materializes");
		let node = session.dom().get(call).expect("call remains materialized");
		assert_eq!(
			node.prop(&execution_started),
			None,
			"inference placeholders must not claim execution started"
		);
		assert_eq!(
			node
				.prop(&PropKey::from(PropId::Status))
				.and_then(omp_dom::Value::as_str),
			Some("error")
		);
	}
	assert!(
		!entries
			.iter()
			.any(|entry| entry.kind.name.as_str() == kind::TURN_RECEIPT),
		"an aborted inference is never recorded as a completed request"
	);

	let live = session.dom().snapshot();
	drop(session);
	let replayed =
		omp_session::Session::open(&journal_path, omp_session::ComponentRegistry::default())
			.expect("journal replays");
	assert_eq!(replayed.dom().snapshot(), live);
	assert!(
		support::result_text(&replayed, "innocent-read")[0]
			.contains("TTSR interrupt on another tool call")
	);
	assert!(
		support::result_text(&replayed, "invalid-edit")[0].contains("TTSR matched rule: no-unwrap")
	);
}

#[tokio::test]
async fn independent_calls_from_one_turn_execute_concurrently() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let first = ToolCall {
		id:        ToolCallId::from("first"),
		name:      Str::new_static("first"),
		arguments: OpaqueJson::new(serde_json::json!({})),
	};
	let second = ToolCall {
		id:        ToolCallId::from("second"),
		name:      Str::new_static("second"),
		arguments: OpaqueJson::new(serde_json::json!({})),
	};
	let tool_round = vec![
		ChatEvent::ToolCallReady { index: 0, call: first },
		ChatEvent::ToolCallReady { index: 1, call: second },
		completed(omp_ai::FinishReason::ToolCalls, 2),
	];
	let (inference, _) = ScriptedInference::new([tool_round, text_script("done")]);
	let barrier = Arc::new(tokio::sync::Barrier::new(3));
	let started = Arc::new(AtomicUsize::new(0));
	let mut kernel = Kernel::new(
		inference,
		registry([
			spec("first", 1, "one").concurrency_probe(Arc::clone(&started), Arc::clone(&barrier)),
			spec("second", 1, "two").concurrency_probe(Arc::clone(&started), Arc::clone(&barrier)),
		]),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let mut session = fresh_session(&directory.path().join("parallel.oms"));
	let turn = kernel.run_turn(&mut session, input("parallel"), RunControl::default());
	tokio::pin!(turn);
	let settled = tokio::time::timeout(Duration::from_secs(1), async {
		tokio::select! {
			_ = barrier.wait() => None,
			result = &mut turn => Some(result),
		}
	})
	.await
	.expect("both independent calls must start before either settles");
	assert_eq!(started.load(Ordering::SeqCst), 2);
	if let Some(result) = settled {
		result.expect("parallel calls settle");
	} else {
		turn.await.expect("parallel calls settle");
	}
}

#[tokio::test]
async fn steering_is_drained_after_tool_results_before_the_yield_decision() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("steer.oms");
	let (inference, requests) = ScriptedInference::new([
		tool_script("echo-1", "echo", serde_json::json!({})),
		text_script("steered answer"),
	]);
	let mut kernel = Kernel::new(
		inference,
		registry([spec("echo", 1, "tool settled")]),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	kernel
		.mailbox()
		.send(Up::Steer {
			text:        Str::new_static("include the settled result"),
			attachments: Vec::new(),
		})
		.expect("steering queues");
	let mut session = fresh_session(&journal_path);

	let outcome = kernel
		.run_turn(&mut session, input("use echo"), RunControl::default())
		.await
		.expect("steered turn completes");

	assert_eq!(outcome.stop, TurnStop::Steered);
	let requests = requests.lock();
	assert_eq!(requests.len(), 2);
	let second = &requests[1];
	assert!(second.messages.iter().any(|message| {
		message.role == Role::Tool
			&& message
				.content
				.iter()
				.any(|part| matches!(part, ContentPart::ToolResult { .. }))
	}));
	assert!(second.messages.iter().any(|message| {
		message.role == Role::User
			&& message.content.iter().any(|part| {
				matches!(part,
					ContentPart::Text { text, .. } if text.contains("include the settled result"))
			})
	}));
	drop(requests);
	assert_eq!(
		session
			.dom()
			.select("queues steering user")
			.expect("selector")
			.count(),
		0
	);
	assert_eq!(
		session
			.dom()
			.select("body turn user")
			.expect("selector")
			.count(),
		2
	);

	drop(session);
	assert_all_entries_caused(&journal_entries(&journal_path));
}

#[tokio::test]
async fn cancellation_settles_a_streamed_tool_call_with_a_synthetic_result() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("pending-call-cancel.oms");
	let mut kernel = Kernel::new(
		PendingCallInference,
		registry([spec("echo", 1, "unused")]),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let cancellation = tokio_util::sync::CancellationToken::new();
	let trigger = cancellation.clone();
	tokio::spawn(async move {
		tokio::time::sleep(Duration::from_millis(10)).await;
		trigger.cancel();
	});
	let mut session = fresh_session(&journal_path);
	let outcome = kernel
		.run_turn(&mut session, input("cancel pending call"), RunControl::new(cancellation, None))
		.await
		.expect("cancellation settles");
	assert_eq!(outcome.stop, TurnStop::Cancelled);
	let call = session
		.dom()
		.select("body turn echo")
		.expect("selector")
		.next()
		.expect("streamed call remains");
	assert_eq!(
		session
			.dom()
			.get(call)
			.and_then(|node| node.prop(&PropKey::from(PropId::Status)))
			.and_then(omp_dom::Value::as_str),
		Some("error")
	);
	let entries = journal_entries(&journal_path);
	let call_entry = entries
		.iter()
		.find(|entry| entry.kind.name.as_str() == kind::TOOL_CALL)
		.expect("call entry");
	assert!(entries.iter().any(|entry| {
		entry.kind.name.as_str() == kind::TOOL_RESULT && entry.by == Some(call_entry.id)
	}));
}

#[tokio::test]
async fn soft_request_budget_notice_grants_one_final_request_only_when_enabled() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("soft-budget.oms");
	let (inference, requests) = ScriptedInference::new([text_script("wrapped")]);
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let mut session = fresh_session(&journal_path);
	let outcome = kernel
		.run_turn(
			&mut session,
			input("bounded child"),
			RunControl::default()
				.with_request_budget(0)
				.with_request_budget_notice(true),
		)
		.await
		.expect("budget wrap-up settles");
	assert_eq!(outcome.assistant_text, "wrapped");
	assert_eq!(requests.lock().len(), 1);
	assert_eq!(session.dom().count("body turn notice").expect("selector"), 1);
}

#[tokio::test]
async fn request_budget_prevents_the_first_disallowed_provider_call() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("request-budget.oms");
	let (inference, requests) = ScriptedInference::new(Vec::<Vec<ChatEvent>>::new());
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let mut session = fresh_session(&journal_path);
	let outcome = kernel
		.run_turn(
			&mut session,
			input("bounded child"),
			RunControl::default()
				.with_request_budget(0)
				.with_request_budget_notice(false),
		)
		.await
		.expect("budget settles");
	assert_eq!(outcome.stop, TurnStop::Completed);
	assert!(requests.lock().is_empty());
	assert_eq!(
		session
			.dom()
			.select("body turn notice")
			.expect("selector")
			.count(),
		1
	);
}

#[tokio::test]
async fn interrupt_returns_cancelled_without_journaling_a_false_completion() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("interrupt.oms");
	let (inference, _requests) =
		ScriptedInference::new([vec![completed(omp_ai::FinishReason::Stop, 0)]]);
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	kernel
		.mailbox()
		.send(Up::Interrupt)
		.expect("interrupt queues");
	let mut session = fresh_session(&journal_path);

	let outcome = kernel
		.run_turn(&mut session, input("cancel me"), RunControl::default())
		.await
		.expect("interrupt settles turn");

	assert_eq!(outcome.stop, TurnStop::Cancelled);
	assert_eq!(outcome.assistant_text, "");
	assert_eq!(session.dom().select("body turn").expect("selector").count(), 1);
	assert_eq!(
		session
			.dom()
			.select("body turn assistant")
			.expect("selector")
			.count(),
		0
	);
	drop(session);
	let entries = journal_entries(&journal_path);
	assert_all_entries_caused(&entries);
	assert!(
		!entries
			.iter()
			.any(|entry| entry.kind.name.as_str() == kind::MSG_ASSISTANT_END)
	);
	assert!(
		!entries
			.iter()
			.any(|entry| entry.kind.name.as_str() == kind::TURN_RECEIPT)
	);
}

/// R2Kernel #1: a subagent/detached job settling while the parent idles is
/// journaled from the turn loop and delivered to the model as an async-result
/// follow-up, so the parent never has to `hub wait`.
#[tokio::test]
async fn settled_background_job_is_delivered_to_the_model_as_a_follow_up_turn() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("deliver.oms");
	let (inference, requests) =
		ScriptedInference::new([text_script("delegated; waiting"), text_script("child says hello")]);
	let mut kernel = Kernel::new(
		inference,
		registry([spec("echo", 1, "tool settled")]),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let mut session = fresh_session(&journal_path);
	let before = session.head().expect("genesis head");
	let txn = omp_session::components::jobs::insert(
		session.dom(),
		before,
		omp_session::components::jobs::JobSpec {
			id:      Str::new_static("child-1"),
			kind:    Str::new_static("subagent"),
			owner:   Str::new_static("Main"),
			started: Str::new_static("1"),
			agent:   Some(Str::new_static("task")),
		},
	)
	.expect("jobs root");
	session.patch(txn).expect("insert subagent");
	let handle = session
		.dom()
		.select("jobs subagent[id=child-1]")
		.expect("valid selector")
		.into_iter()
		.next()
		.expect("subagent element");
	let (done_tx, done_rx) = flume::bounded::<()>(1);
	assert!(kernel.jobs().attach_task(
		session.dom(),
		handle,
		tokio_util::sync::CancellationToken::new(),
		tokio::spawn(async move {
			let _ = done_rx.recv_async().await;
			omp_agent::JobSettlement {
				status:     Str::new_static("completed"),
				output:     Some(
					serde_json::value::to_raw_value(&serde_json::json!({"text": "hello from child"}))
						.expect("raw"),
				),
				error:      None,
				completion: None,
			}
		}),
	));
	// The child settles shortly after the parent reaches its candidate yield.
	tokio::spawn(async move {
		tokio::time::sleep(Duration::from_millis(60)).await;
		let _ = done_tx.send(());
	});
	let outcome = kernel
		.run_turn(&mut session, input("delegate"), RunControl::default())
		.await
		.expect("turn completes after delivery");
	assert_eq!(outcome.stop, TurnStop::Completed);
	let requests = requests.lock();
	assert_eq!(requests.len(), 2, "the settlement re-woke the loop for one follow-up request");
	assert!(requests[1].messages.iter().any(|message| {
		message.role == Role::User
			&& message.content.iter().any(|part| {
				matches!(part, ContentPart::Text { text, .. }
					if text.contains("Background job child-1 has completed") && text.contains("hello from child"))
			})
	}));
	drop(requests);
	let node = session.dom().get(handle).expect("subagent element");
	assert_eq!(
		node
			.prop(&PropKey::from(PropId::Status))
			.and_then(omp_dom::Value::as_str),
		Some("completed"),
		"the settlement was journaled from the turn loop"
	);
	assert!(
		node
			.prop(&PropKey::Custom(Str::new_static(omp_agent::DELIVERED)))
			.is_some(),
		"delivery is a journaled fact, so a resumed session never re-delivers"
	);
	assert!(
		session
			.dom()
			.select("body turn user[async_result=true]")
			.expect("selector")
			.count()
			== 1
	);
}

/// R2 (Fx2Transcript): an interrupted tool tail is re-executable without a
/// model round trip: the journal rewinds past the aborted result, the same
/// call id runs again, and the live chain ends with exactly one
/// `tool.result@1` for it.
#[tokio::test]
async fn retry_tool_tail_reruns_the_aborted_call_and_continues_the_turn() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("retry-tail.oms");
	let mut kernel = Kernel::new(
		PendingCallInference,
		registry([spec("echo", 1, "tool settled")]),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let cancellation = tokio_util::sync::CancellationToken::new();
	let trigger = cancellation.clone();
	tokio::spawn(async move {
		tokio::time::sleep(Duration::from_millis(10)).await;
		trigger.cancel();
	});
	let mut session = fresh_session(&journal_path);
	let outcome = kernel
		.run_turn(&mut session, input("use echo"), RunControl::new(cancellation, None))
		.await
		.expect("cancellation settles");
	assert_eq!(outcome.stop, TurnStop::Cancelled);
	let turn = *session
		.dom()
		.children(session.dom().body())
		.last()
		.expect("turn");
	assert!(omp_agent::aborted_tool_tail(session.dom(), turn), "the tail is retryable");

	let (inference, requests) = ScriptedInference::new([text_script("after retry")]);
	let mut kernel = Kernel::new(
		inference,
		registry([spec("echo", 1, "tool settled")]),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	);
	let outcome = kernel
		.retry_tool_tail(&mut session, RunControl::default())
		.await
		.expect("retry succeeds");
	assert_eq!(outcome.stop, TurnStop::Completed);
	assert_eq!(outcome.assistant_text.as_str(), "after retry");
	assert!(!omp_agent::aborted_tool_tail(session.dom(), turn));
	assert_eq!(
		prop_text(&session, "body turn echo", PropId::Status),
		"ok",
		"the replayed call settled normally"
	);
	assert_eq!(requests.lock().len(), 1, "no model round trip before the replay");
	let entries = journal_entries(&journal_path);
	let live = omp_journal::live_chain(&entries).collect::<Vec<_>>();
	let results = live
		.iter()
		.filter(|entry| entry.kind.name.as_str() == kind::TOOL_RESULT)
		.count();
	assert_eq!(results, 1, "the live chain carries exactly one result for the call");
	assert!(
		live.len() < entries.len(),
		"the aborted result and interrupt notice are abandoned, not deleted"
	);
	assert!(matches!(
		kernel
			.retry_tool_tail(&mut session, RunControl::default())
			.await,
		Err(omp_agent::KernelError::NothingToRetry)
	));
}

/// A user image attachment reaches the provider with the blob's bytes inline
/// and its journaled MIME, read from the session's blob store at request build
/// (no process-local attachment index); the resumed session projects the same
/// request.
#[tokio::test]
async fn user_image_attachment_reaches_the_request_with_its_bytes_and_mime() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("image.oms");
	let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x04\0\0\0\x03";
	let (inference, requests) = ScriptedInference::new([text_script("a tiny png")]);
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	)
	.with_route_facts(omp_agent::RouteFacts { image_input: true, ..Default::default() });
	let mut session = fresh_session(&journal_path);
	let attachment = session
		.store_attachment("image/png", png)
		.expect("attachment stores");

	let outcome = kernel
		.run_turn(
			&mut session,
			TurnInput {
				text:        Str::new_static("what is this? [Image #1, 4x3]"),
				attachments: vec![attachment.clone()],
			},
			RunControl::default(),
		)
		.await
		.expect("turn completes");
	assert_eq!(outcome.stop, TurnStop::Completed);

	let images = |request: &ChatRequest| {
		request
			.messages
			.iter()
			.filter(|message| message.role == Role::User)
			.flat_map(|message| message.content.iter())
			.filter_map(|part| match part {
				ContentPart::Image(omp_ai::MediaInput::Bytes { media_type, data }) => {
					Some((media_type.clone(), data.clone()))
				},
				ContentPart::Image(other) => panic!("image must be inline bytes, got {other:?}"),
				_ => None,
			})
			.collect::<Vec<_>>()
	};
	let live = {
		let requests = requests.lock();
		assert_eq!(requests.len(), 1);
		images(&requests[0])
	};
	assert_eq!(live.len(), 1);
	assert_eq!(live[0].0, "image/png");
	assert_eq!(live[0].1.as_ref(), png);
	let user_texts = requests.lock()[0]
		.messages
		.iter()
		.filter(|message| message.role == Role::User)
		.flat_map(|message| message.content.iter())
		.filter_map(|part| match part {
			ContentPart::Text { text, .. } => Some(text.clone()),
			_ => None,
		})
		.collect::<Vec<_>>();
	assert_eq!(user_texts, ["what is this? [Image #1, 4x3]"]);

	// The journal carries the MIME beside the reference, so a resumed
	// session builds the identical media part.
	let journal = std::fs::read_to_string(&journal_path).expect("journal reads");
	assert!(
		journal.contains(&format!(
			r#""h":"{}","n":{},"mime":"image/png""#,
			attachment.blob,
			png.len()
		)),
		"{journal}"
	);
	drop(session);
	let restored =
		omp_session::Session::open(&journal_path, omp_session::ComponentRegistry::default())
			.expect("session restores");
	let (inference, requests) = ScriptedInference::new([text_script("still a png")]);
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	)
	.with_route_facts(omp_agent::RouteFacts { image_input: true, ..Default::default() });
	let mut restored = restored;
	kernel
		.run_turn(&mut restored, input("and now?"), RunControl::default())
		.await
		.expect("resumed turn completes");
	assert_eq!(images(&requests.lock()[0]), live);
}

/// A steering aside with an image keeps its attachment through the queue and
/// the safe point: the second request's steered user message carries the
/// bytes and MIME, not a dangling marker.
#[tokio::test]
async fn steered_image_attachment_reaches_the_next_request() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("steer-image.oms");
	let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x02\0\0\0\x02";
	let (inference, requests) = ScriptedInference::new([
		tool_script("echo-1", "echo", serde_json::json!({})),
		text_script("steered answer"),
	]);
	let mut kernel = Kernel::new(
		inference,
		registry([spec("echo", 1, "tool settled")]),
		policy(&directory.path().join("blobs")),
		StaticPrompt(Str::new_static("test system")),
	)
	.with_route_facts(omp_agent::RouteFacts { image_input: true, ..Default::default() });
	let mut session = fresh_session(&journal_path);
	let attachment = session
		.store_attachment("image/png", png)
		.expect("attachment stores");
	kernel
		.mailbox()
		.send(Up::Steer {
			text:        Str::new_static("also look at [Image #1, 2x2]"),
			attachments: vec![attachment],
		})
		.expect("steering queues");

	let outcome = kernel
		.run_turn(&mut session, input("use echo"), RunControl::default())
		.await
		.expect("steered turn completes");
	assert_eq!(outcome.stop, TurnStop::Steered);

	let requests = requests.lock();
	assert_eq!(requests.len(), 2);
	let steered = requests[1]
		.messages
		.iter()
		.find(|message| {
			message.role == Role::User
				&& message.content.iter().any(
					|part| matches!(part, ContentPart::Text { text, .. } if text.contains("also look at")),
				)
		})
		.expect("steered user message");
	let image = steered
		.content
		.iter()
		.find_map(|part| match part {
			ContentPart::Image(omp_ai::MediaInput::Bytes { media_type, data }) => {
				Some((media_type.as_str(), data.as_ref()))
			},
			_ => None,
		})
		.expect("steered message carries the image inline");
	assert_eq!(image, ("image/png", png.as_slice()));
}
