//! Compaction director integration proofs over the journal-derived session
//! tree.

use std::{collections::VecDeque, path::Path, sync::Arc};

use bytes::Bytes;
use futures::stream;
use omp_agent::{
	AI_COMPACT_THRESHOLD, GateDecision, HookGate, HookPatch, HookPhase, LifecycleHooks, OnFailure,
	SourceRef, When,
	director::{BoxFut, Director, ErasedInference, MutDirectorCx, Prepared, RouteFacts},
	directors::compaction::CompactionDirector,
};
use omp_ai::{
	ChatEvent, ChatRequest, ChatStream, ContentPart, Message, NegotiationPolicy, Role,
	SafetySetting, Sampling, Setting,
	settings::{AI_COMPACTION_KEEP_RECENT_TOKENS, AI_COMPACTION_THRESHOLD_TOKENS},
};
use omp_con::Ctx;
use omp_core::{Str, sf};
use omp_dom::{KnownTag, NodeSpec, Op, PropId, Txn, Value};
use omp_journal::{
	Journal,
	blob::BlobStore,
	data::{Compaction, TurnReceipt},
	kind,
};
use omp_proto::{thread::v1 as thread, toolhost::v1::HookEventId};
use omp_session::{ComponentRegistry, Session, projection::project_thread};
use parking_lot::Mutex;

struct FakeInference {
	replies:  VecDeque<Str>,
	requests: Vec<ChatRequest>,
}

impl FakeInference {
	fn with_reply(reply: &str) -> Self {
		Self { replies: VecDeque::from([Str::new(reply)]), requests: Vec::new() }
	}
}

impl ErasedInference for FakeInference {
	fn execute<'a>(
		&'a mut self,
		request: ChatRequest,
	) -> BoxFut<'a, Result<ChatStream, omp_ai::Error>> {
		self.requests.push(request);
		let reply = self
			.replies
			.pop_front()
			.expect("one summary reply configured");
		Box::pin(async move {
			Ok(ChatStream::ordinary(Box::pin(stream::iter([Ok(ChatEvent::TextDelta {
				index: 0,
				text:  reply,
			})]))))
		})
	}
}

fn request(text: &str) -> ChatRequest {
	ChatRequest {
		messages:          Arc::from([Message {
			role:    Role::User,
			content: Arc::from([ContentPart::Text { text: Str::new(text), proof: None }]),
			name:    None,
		}]),
		tools:             Arc::from([]),
		hosted_tools:      Arc::from([]),
		tool_choice:       Setting::Unset,
		output:            Setting::Unset,
		reasoning:         Setting::Unset,
		verbosity:         Setting::Unset,
		cache_retention:   Setting::Unset,
		service_tier:      Setting::Unset,
		sampling:          Sampling::default(),
		max_output_tokens: None,
		top_logprobs:      None,
		safety:            Arc::<[SafetySetting]>::from([]),
		negotiation:       NegotiationPolicy::default(),
		forced_call:       None,
	}
}

fn route(context_window: u64) -> RouteFacts {
	RouteFacts { context_window, ..Default::default() }
}

fn open(directory: &Path) -> (Session, BlobStore) {
	let blobs = BlobStore::open(directory).expect("blob store");
	let session = Session::create(&directory.join("session.oms"), ComponentRegistry::standard())
		.expect("session");
	(session, blobs)
}

/// A control plane that keeps nothing verbatim, so a tiny test history cuts
/// before the current turn.
fn keep_nothing() -> Ctx {
	let con = Ctx::new();
	AI_COMPACTION_KEEP_RECENT_TOKENS
		.set(&con, 0)
		.expect("keep recent");
	con
}

fn turn_handle(session: &Session) -> omp_dom::Handle {
	*session
		.dom()
		.children(session.dom().body())
		.last()
		.expect("turn is materialized")
}

fn set_compact_threshold(session: &mut Session, threshold: f64) {
	let con = session
		.dom()
		.select("con")
		.expect("con selector")
		.next()
		.expect("con component");
	let after = session.dom().children(con).last().copied();
	session
		.patch(Txn {
			cause: session.head().expect("journal head"),
			label: Some(Str::new_static("test.compaction.threshold")),
			ops:   vec![Op::Ins {
				parent: con,
				after,
				node: NodeSpec::new(KnownTag::Var)
					.with_prop(PropId::Name, Value::Str(Str::new_static(AI_COMPACT_THRESHOLD.name())))
					.with_prop(PropId::Value, Value::Float(threshold)),
			}],
		})
		.expect("threshold patch");
}

fn projected_texts(session: &Session) -> Vec<String> {
	project_thread(session.dom())
		.into_iter()
		.filter_map(|item| match item.kind? {
			thread::item::Kind::Message(message) => {
				message.parts.into_iter().find_map(|part| match part.kind? {
					thread::part::Kind::Text(text) => Some(text),
					_ => None,
				})
			},
			_ => None,
		})
		.collect()
}

fn message_text(message: &Message) -> &str {
	message
		.content
		.iter()
		.find_map(|part| match part {
			ContentPart::Text { text, .. } => Some(text.as_str()),
			_ => None,
		})
		.unwrap_or_default()
}

fn subscription(id: u32, phase: HookPhase) -> omp_agent::hooks::Subscription {
	omp_agent::hooks::Subscription {
		host: sf!("test"),
		source: SourceRef {
			layer:        0,
			publisher:    sf!("test"),
			extension_id: sf!("compaction"),
		},
		id,
		event: HookEventId::HookEventCompaction,
		phase,
		order: 0,
		on_failure: OnFailure::Deny,
		when: When::default(),
	}
}

#[tokio::test]
async fn under_threshold_skips_compaction() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let (mut session, blobs) = open(directory.path());
	session.begin_turn().expect("turn");
	session.user("short", Vec::new()).expect("user");
	let mut inference = FakeInference::with_reply("unused");
	let route = route(16_000);
	let turn = turn_handle(&session);
	let mut cx = MutDirectorCx {
		session: &mut session,
		inference: &mut inference,
		blobs: &blobs,
		route: &route,
		turn,
		director: None,
		events: None,
		con: None,
		hooks: None,
	};
	let prepared = CompactionDirector::new()
		.before_inference(&mut cx, &request("short"))
		.await
		.expect("preparation");
	assert_eq!(prepared, Prepared::Unchanged);
	assert_eq!(session.dom().count("compaction").expect("selector"), 0);
	assert!(inference.requests.is_empty());
}

#[tokio::test]
async fn dom_ai_compact_threshold_controls_compaction() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let (mut session, blobs) = open(directory.path());
	session.begin_turn().expect("turn");
	session.user("oldest history", Vec::new()).expect("user");
	// Without a console, the default retains 20k recent tokens verbatim, so
	// the turn before the prompt must exceed that to hide anything older.
	let recent = "small but configured ".repeat(4_000);
	session.begin_turn().expect("turn");
	session.user(recent.clone(), Vec::new()).expect("user");
	session.begin_turn().expect("turn");
	session.user("prompt", Vec::new()).expect("user");
	set_compact_threshold(&mut session, 0.10);
	let mut inference = FakeInference::with_reply("threshold summary");
	let route = route(512);
	let turn = turn_handle(&session);
	let mut cx = MutDirectorCx {
		session: &mut session,
		inference: &mut inference,
		blobs: &blobs,
		route: &route,
		turn,
		director: None,
		events: None,
		con: None,
		hooks: None,
	};
	assert_eq!(
		CompactionDirector::new()
			.before_inference(&mut cx, &request(&recent))
			.await
			.expect("configured preparation"),
		Prepared::Rebuild
	);
	assert_eq!(session.dom().count("compaction").expect("selector"), 1);
	assert_eq!(projected_texts(&session), vec![
		"threshold summary".to_owned(),
		recent,
		"prompt".to_owned()
	]);
	let summarised = inference.requests[0]
		.messages
		.iter()
		.map(message_text)
		.collect::<Vec<_>>();
	assert_eq!(summarised[1..], ["oldest history"]);
}

#[tokio::test]
async fn automatic_compaction_keeps_the_triggering_prompt_after_the_summary() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let (mut session, blobs) = open(directory.path());
	session.begin_turn().expect("history turn");
	let history = "history ".repeat(100);
	let boundary = session.user(history.clone(), Vec::new()).expect("history");
	let turn_id = session.begin_turn().expect("turn");
	session.user("what next?", Vec::new()).expect("prompt");
	let con = keep_nothing();
	let mut inference = FakeInference::with_reply("durable compacted context");
	let route = route(128);
	let turn = turn_handle(&session);
	let mut cx = MutDirectorCx {
		session: &mut session,
		inference: &mut inference,
		blobs: &blobs,
		route: &route,
		turn,
		director: None,
		events: None,
		con: Some(&con),
		hooks: None,
	};
	let prepared = CompactionDirector::new()
		.before_inference(&mut cx, &request(&history))
		.await
		.expect("preparation");
	assert_eq!(prepared, Prepared::Rebuild);
	let repeated = CompactionDirector::new()
		.before_inference(&mut cx, &request(&history))
		.await
		.expect("re-entrant preparation");
	assert_eq!(repeated, Prepared::Unchanged);
	assert_eq!(session.dom().count("compaction").expect("selector"), 1);
	assert_eq!(inference.requests.len(), 1);
	// The summariser saw only the hidden history, never the pending prompt.
	let summarised = inference.requests[0]
		.messages
		.iter()
		.map(message_text)
		.collect::<Vec<_>>();
	assert_eq!(summarised.len(), 2);
	assert_eq!(summarised[1], history);
	// The model sees the summary and then the prompt that triggered the turn.
	let live_projection = project_thread(session.dom());
	assert_eq!(projected_texts(&session), vec![
		"durable compacted context".to_owned(),
		"what next?".to_owned()
	]);
	let path = session.journal_path().to_path_buf();
	drop(session);

	let entries = Journal::scan(&path).expect("journal reopens");
	let compact_entries = entries
		.iter()
		.filter(|entry| entry.kind.name == kind::COMPACTION && entry.kind.rev == 1)
		.collect::<Vec<_>>();
	assert_eq!(compact_entries.len(), 1);
	assert_eq!(compact_entries[0].by, Some(turn_id));
	let payload: Compaction =
		serde_json::from_str(compact_entries[0].data.as_str()).expect("compaction payload");
	assert_eq!(payload.boundary, boundary);
	assert_eq!(payload.method.as_deref(), Some("auto"));
	assert_eq!(
		blobs.get(&payload.summary).expect("summary blob"),
		b"durable compacted context".as_slice()
	);

	let reopened = Session::open(&path, ComponentRegistry::standard()).expect("session replays");
	assert_eq!(project_thread(reopened.dom()), live_projection);
}

#[tokio::test]
async fn compaction_trigger_uses_receipted_context_tokens_and_threshold_tokens_precedence() {
	// 1000-token window: the fraction path would trigger at 80% of the
	// post-reserve window (680); an explicit `thresholdTokens` of 300 wins.
	let con = keep_nothing();
	AI_COMPACTION_THRESHOLD_TOKENS
		.set(&con, 300)
		.expect("threshold tokens");
	let route = route(1_000);

	// A receipt above the explicit threshold triggers even though the byte
	// estimate of the request is tiny.
	let directory = tempfile::tempdir().expect("temporary directory");
	let (mut session, blobs) = open(directory.path());
	session.begin_turn().expect("history turn");
	session.user("history", Vec::new()).expect("history");
	session
		.receipt(TurnReceipt {
			tokens_in: 200,
			tokens_out: 50,
			cache_read: 100,
			..Default::default()
		})
		.expect("receipt");
	session.begin_turn().expect("turn");
	session.user("tiny", Vec::new()).expect("prompt");
	let mut inference = FakeInference::with_reply("receipted summary");
	let turn = turn_handle(&session);
	let mut cx = MutDirectorCx {
		session: &mut session,
		inference: &mut inference,
		blobs: &blobs,
		route: &route,
		turn,
		director: None,
		events: None,
		con: Some(&con),
		hooks: None,
	};
	assert_eq!(
		CompactionDirector::new()
			.before_inference(&mut cx, &request("tiny"))
			.await
			.expect("receipted preparation"),
		Prepared::Rebuild
	);
	let entries = Journal::scan(session.journal_path()).expect("journal");
	let payload: Compaction = entries
		.iter()
		.find(|entry| entry.kind.name == kind::COMPACTION)
		.map(|entry| serde_json::from_str(entry.data.as_str()).expect("compaction payload"))
		.expect("compaction journaled");
	assert_eq!(payload.tokens_before, Some(350));

	// A receipt at or below the explicit threshold does not trigger, even
	// though the fraction path (ai_compact_threshold 0.1 → 68 tokens) would.
	AI_COMPACT_THRESHOLD.set(&con, 0.1).expect("fraction");
	let directory = tempfile::tempdir().expect("temporary directory");
	let (mut session, blobs) = open(directory.path());
	session.begin_turn().expect("history turn");
	session.user("history", Vec::new()).expect("history");
	session
		.receipt(TurnReceipt { tokens_in: 250, tokens_out: 50, ..Default::default() })
		.expect("receipt");
	session.begin_turn().expect("turn");
	session.user("tiny", Vec::new()).expect("prompt");
	let mut inference = FakeInference::with_reply("unused");
	let turn = turn_handle(&session);
	let mut cx = MutDirectorCx {
		session: &mut session,
		inference: &mut inference,
		blobs: &blobs,
		route: &route,
		turn,
		director: None,
		events: None,
		con: Some(&con),
		hooks: None,
	};
	assert_eq!(
		CompactionDirector::new()
			.before_inference(&mut cx, &request("tiny"))
			.await
			.expect("under-threshold preparation"),
		Prepared::Unchanged
	);
	assert!(inference.requests.is_empty());

	// Without any receipt the byte estimate of the request stands in.
	let directory = tempfile::tempdir().expect("temporary directory");
	let (mut session, blobs) = open(directory.path());
	session.begin_turn().expect("history turn");
	session.user("history", Vec::new()).expect("history");
	session.begin_turn().expect("turn");
	session.user("tiny", Vec::new()).expect("prompt");
	let mut inference = FakeInference::with_reply("estimated summary");
	let turn = turn_handle(&session);
	let mut cx = MutDirectorCx {
		session: &mut session,
		inference: &mut inference,
		blobs: &blobs,
		route: &route,
		turn,
		director: None,
		events: None,
		con: Some(&con),
		hooks: None,
	};
	assert_eq!(
		CompactionDirector::new()
			.before_inference(&mut cx, &request(&"estimate ".repeat(200)))
			.await
			.expect("estimated preparation"),
		Prepared::Rebuild
	);
	assert_eq!(session.dom().count("compaction").expect("selector"), 1);
}

#[tokio::test]
async fn compaction_hook_verdict_can_cancel_or_replace_the_summary() {
	let (gate, receiver) = HookGate::channel();
	let gate = Arc::new(gate);
	let observed = Arc::new(Mutex::new(Vec::new()));
	let replacement = Arc::new(Mutex::new(None::<Str>));
	let responder = {
		let gate = Arc::clone(&gate);
		let observed = Arc::clone(&observed);
		let replacement = Arc::clone(&replacement);
		tokio::spawn(async move {
			while let Ok(dispatch) = receiver.recv_async().await {
				let payload: serde_json::Value =
					serde_json::from_slice(&dispatch.payload).expect("hook payload");
				observed.lock().push((dispatch.event, payload.clone()));
				if dispatch.event != HookEventId::HookEventCompaction {
					continue;
				}
				let decision = match replacement.lock().clone() {
					None => GateDecision::Deny(sf!("extension keeps the context")),
					Some(summary) => {
						let mut transformed = payload;
						transformed["summary"] = serde_json::Value::String(summary.to_string());
						GateDecision::Modify(HookPatch {
							target: None,
							args:   Some(Bytes::from(
								serde_json::to_vec(&transformed).expect("transform"),
							)),
						})
					},
				};
				gate
					.answer(dispatch.dispatch_id, vec![(1, decision)])
					.expect("hook answer");
			}
		})
	};
	let hooks = LifecycleHooks::new(Arc::clone(&gate));
	let con = keep_nothing();
	let route = route(128);
	let history = "history ".repeat(100);

	// A denial cancels this run: nothing is summarised or journaled.
	gate
		.subscribe("test", [subscription(1, HookPhase::Precheck)])
		.expect("precheck subscription");
	let directory = tempfile::tempdir().expect("temporary directory");
	let (mut session, blobs) = open(directory.path());
	session.begin_turn().expect("history turn");
	session.user(history.clone(), Vec::new()).expect("history");
	session.begin_turn().expect("turn");
	session.user("what next?", Vec::new()).expect("prompt");
	let mut inference = FakeInference::with_reply("unused");
	let turn = turn_handle(&session);
	let mut cx = MutDirectorCx {
		session: &mut session,
		inference: &mut inference,
		blobs: &blobs,
		route: &route,
		turn,
		director: None,
		events: None,
		con: Some(&con),
		hooks: Some(&hooks),
	};
	assert_eq!(
		CompactionDirector::new()
			.before_inference(&mut cx, &request(&history))
			.await
			.expect("cancelled preparation"),
		Prepared::Unchanged
	);
	assert!(inference.requests.is_empty());
	assert_eq!(session.dom().count("compaction").expect("selector"), 0);
	let event = observed
		.lock()
		.iter()
		.find(|(event, _)| *event == HookEventId::HookEventCompaction)
		.map(|(_, payload)| payload.clone())
		.expect("compaction gate payload");
	for key in [
		"preparation_id",
		"tier",
		"reason",
		"epoch",
		"tokens_before",
		"target_tokens",
		"suggested_first_kept",
		"to_summarize",
		"to_retain",
		"split_turn",
		"previous_summary",
		"previous_preserve",
		"custom_instructions",
		"deadline",
	] {
		assert!(event.get(key).is_some(), "missing CompactionEvent key {key}");
	}
	assert_eq!(event["reason"], "threshold");
	assert_eq!(event["to_summarize"].as_array().map(Vec::len), Some(1));
	assert_eq!(event["to_summarize"][0]["role"], "user");
	assert_eq!(event["to_retain"].as_array().map(Vec::len), Some(1));
	assert_eq!(event["to_retain"][0]["preview"], "what next?");

	// A transform supplying `summary` replaces the summariser call.
	*replacement.lock() = Some(sf!("extension-authored summary"));
	gate
		.subscribe("test", [subscription(1, HookPhase::Transform)])
		.expect("transform subscription");
	observed.lock().clear();
	let mut inference = FakeInference::with_reply("unused");
	let turn = turn_handle(&session);
	let mut cx = MutDirectorCx {
		session: &mut session,
		inference: &mut inference,
		blobs: &blobs,
		route: &route,
		turn,
		director: None,
		events: None,
		con: Some(&con),
		hooks: Some(&hooks),
	};
	assert_eq!(
		CompactionDirector::new()
			.before_inference(&mut cx, &request(&history))
			.await
			.expect("replaced preparation"),
		Prepared::Rebuild
	);
	drop(cx);
	assert!(inference.requests.is_empty(), "the extension summary skips the summariser");
	assert_eq!(projected_texts(&session), vec![
		"extension-authored summary".to_owned(),
		"what next?".to_owned()
	]);
	responder.abort();
}

#[tokio::test]
async fn compaction_done_reports_the_outcome_to_observers() {
	let (gate, receiver) = HookGate::channel();
	let gate = Arc::new(gate);
	gate
		.subscribe("test", [omp_agent::hooks::Subscription {
			event: HookEventId::HookEventCompactionDone,
			..subscription(1, HookPhase::Observe)
		}])
		.expect("observer subscription");
	let hooks = LifecycleHooks::new(Arc::clone(&gate));
	let con = keep_nothing();
	let route = route(128);
	let history = "history ".repeat(100);
	let directory = tempfile::tempdir().expect("temporary directory");
	let (mut session, blobs) = open(directory.path());
	session.begin_turn().expect("history turn");
	let boundary = session.user(history.clone(), Vec::new()).expect("history");
	let turn_id = session.begin_turn().expect("turn");
	session.user("what next?", Vec::new()).expect("prompt");
	let mut inference = FakeInference::with_reply("observed summary");
	let turn = turn_handle(&session);
	let mut cx = MutDirectorCx {
		session: &mut session,
		inference: &mut inference,
		blobs: &blobs,
		route: &route,
		turn,
		director: None,
		events: None,
		con: Some(&con),
		hooks: Some(&hooks),
	};
	assert_eq!(
		CompactionDirector::new()
			.before_inference(&mut cx, &request(&history))
			.await
			.expect("preparation"),
		Prepared::Rebuild
	);
	let dispatch = receiver.try_recv().expect("compaction_done observation");
	assert_eq!(dispatch.event, HookEventId::HookEventCompactionDone);
	let outcome: serde_json::Value = serde_json::from_slice(&dispatch.payload).expect("payload");
	for key in [
		"preparation_id",
		"tiers_run",
		"from_extension",
		"tokens_before",
		"tokens_after",
		"first_kept_id",
		"epoch",
		"summary_bytes",
		"warning",
	] {
		assert!(outcome.get(key).is_some(), "missing CompactionOutcome key {key}");
	}
	assert_eq!(outcome["preparation_id"], boundary.to_string());
	assert_eq!(outcome["first_kept_id"], turn_id.to_string());
	assert_eq!(outcome["tiers_run"], serde_json::json!(["local"]));
	assert_eq!(outcome["from_extension"], serde_json::Value::Null);
	assert_eq!(outcome["summary_bytes"], "observed summary".len());
	assert_eq!(outcome["epoch"], 0);
}

#[tokio::test]
async fn manual_compaction_carries_focus_and_ignores_threshold() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let (mut session, blobs) = open(directory.path());
	session.begin_turn().expect("turn");
	session.user("small history", Vec::new()).expect("user");
	session.begin_turn().expect("turn");
	session.user("later", Vec::new()).expect("user");
	let con = keep_nothing();
	let mut inference = FakeInference::with_reply("focused context");
	let route = route(1_000_000);
	let turn = turn_handle(&session);
	let mut cx = MutDirectorCx {
		session: &mut session,
		inference: &mut inference,
		blobs: &blobs,
		route: &route,
		turn,
		director: None,
		events: None,
		con: Some(&con),
		hooks: None,
	};
	let prepared = CompactionDirector::manual(Some(Str::new_static("database migration")))
		.with_method("handoff")
		.before_inference(&mut cx, &request("small history"))
		.await
		.expect("manual compaction");
	assert_eq!(prepared, Prepared::Rebuild);
	assert_eq!(session.dom().count("compaction").expect("selector"), 1);
	// Between turns nothing is pending, so a manual run hides the whole
	// (tiny) history: only the summary remains.
	assert_eq!(projected_texts(&session), vec!["focused context".to_owned()]);
	let summary_request = inference.requests.first().expect("summary request");
	assert!(summary_request.tools.is_empty());
	assert!(summary_request.hosted_tools.is_empty());
	assert!(message_text(&summary_request.messages[0]).contains("database migration"));
	assert_eq!(
		summary_request.messages[1..]
			.iter()
			.map(message_text)
			.collect::<Vec<_>>(),
		["small history", "later"]
	);
}
