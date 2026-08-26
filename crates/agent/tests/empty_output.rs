//! Bounded recovery for provider turns that complete without actionable output.

use std::{
	collections::VecDeque,
	env, fs,
	future::{Future, pending, ready},
	mem,
	num::NonZeroU32,
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::{Duration, Instant},
};

use futures::stream;
use omp_agent::{
	AbortDisposition, Agent, AgentError, AgentPhase, AgentSnapshot, AgentState, Error, InvokeFrame,
	Journal, RetryPolicy, TurnClient, TurnId, TurnInput, TurnInputRecord, TurnOptions,
	TurnOptionsRecord, TurnSession, TurnStart,
	testing::{ScriptedTurn, ScriptedTurnClient},
};
use omp_core::{Hash32, Str, sf};
use omp_env::EnvClient;
use omp_proto::{
	inference::v1::{self as pb, turn_error, turn_event},
	thread::v1::{self as thread, Item, item, part},
};
use omp_storage::transcript::{Header, SessionId};
use omp_tool::{CapsBase, ModelClass};
use parking_lot::Mutex;

const RETRY_TEXT: &str = "<system-injection>\nStopped without actionable output; task incomplete. \
                          Continue with a user-visible final answer or the next required tool \
                          call.\nAttempt #1/3\n</system-injection>";
const CAP_DETAIL: &str = "Assistant returned no final output after retry cap; try switching models";

type ScriptOutcome = Result<pb::Outcome, Box<pb::TurnError>>;
type ScriptQueue = Arc<Mutex<VecDeque<ScriptOutcome>>>;

struct OutcomeSession {
	events: Vec<Result<pb::TurnEvent, Error>>,
}

impl TurnSession for OutcomeSession {
	fn events(
		&mut self,
	) -> impl futures::Stream<Item = Result<pb::TurnEvent, Error>> + Send + Unpin + '_ {
		stream::iter(mem::take(&mut self.events))
	}

	fn submit(
		&mut self,
		_frame: InvokeFrame,
	) -> impl Future<Output = Result<(), Error>> + Send + '_ {
		ready(Ok(()))
	}
}

/// Exists because scripting cannot express per-turn timing capture needed here.
#[derive(Clone)]
struct RecoveryClient {
	script: ScriptQueue,
	opened: Arc<Mutex<Vec<(TurnId, Instant, TurnInput)>>>,
}

impl TurnClient for RecoveryClient {
	type Session<'client> = OutcomeSession;

	fn turn<'client>(
		&'client self,
		turn_id: TurnId,
		input: TurnInput,
		_options: &'client TurnOptions,
	) -> impl Future<Output = Result<Self::Session<'client>, Error>> + Send + 'client {
		self.opened.lock().push((turn_id, Instant::now(), input));
		let outcome = self
			.script
			.lock()
			.pop_front()
			.expect("one script entry per turn");
		let event = match outcome {
			Ok(outcome) => Ok(pb::TurnEvent { event: Some(turn_event::Event::Outcome(outcome)) }),
			Err(error) => Err(Error::Terminal(error)),
		};
		ready(Ok(OutcomeSession { events: vec![event] }))
	}
}
/// Exists because scripting cannot express a first-turn crash then hang
/// forever.
#[derive(Clone)]
struct CrashClient {
	opened: flume::Sender<TurnInput>,
	calls:  Arc<AtomicUsize>,
}

impl TurnClient for CrashClient {
	type Session<'client> = OutcomeSession;

	fn turn<'client>(
		&'client self,
		_turn_id: TurnId,
		input: TurnInput,
		_options: &'client TurnOptions,
	) -> impl Future<Output = Result<Self::Session<'client>, Error>> + Send + 'client {
		let opened = self.opened.clone();
		let call = self.calls.fetch_add(1, Ordering::Relaxed);
		async move {
			opened.send_async(input).await.map_err(|_| Error::Closed)?;
			if call == 0 {
				return Ok(OutcomeSession {
					events: vec![Err(Error::Terminal(Box::new(pb::TurnError {
						kind: turn_error::Kind::EmptyOutput as i32,
						detail: "provider detail".to_owned(),
						..pb::TurnError::default()
					})))],
				});
			}
			pending().await
		}
	}
}

fn user_text(text: &str) -> Item {
	Item {
		seq:           0,
		created_at_ms: 1,
		kind:          Some(item::Kind::Message(thread::Message {
			role:  thread::Role::User as i32,
			parts: vec![thread::Part {
				kind: Some(omp_proto::thread::v1::part::Kind::Text(text.to_owned())),
			}],
		})),
		props:         None,
	}
}

fn terminal(kind: turn_error::Kind) -> ScriptOutcome {
	Err(Box::new(pb::TurnError {
		kind: kind as i32,
		detail: "provider detail".to_owned(),
		..pb::TurnError::default()
	}))
}
fn rate_limited(retry_after_ms: u64) -> ScriptOutcome {
	Err(Box::new(pb::TurnError {
		kind: turn_error::Kind::RateLimited as i32,
		detail: "provider detail".to_owned(),
		retry_after_ms,
		..pb::TurnError::default()
	}))
}

fn empty_stop_terminal(code: &str, detail: &str) -> ScriptOutcome {
	Err(Box::new(pb::TurnError {
		kind: turn_error::Kind::EmptyOutput as i32,
		detail: "provider detail".to_owned(),
		diagnostics: vec![pb::Diagnostic {
			provider:     "provider-a".to_owned(),
			model:        "model-a".to_owned(),
			attempt:      1,
			code:         code.to_owned(),
			detail:       detail.to_owned(),
			retryability: pb::Retryability::Never as i32,
		}],
		..pb::TurnError::default()
	}))
}

fn success() -> pb::Outcome {
	pb::Outcome { stop: pb::StopReason::StopEndTurn as i32, ..pb::Outcome::default() }
}

fn input_texts(input: &TurnInput) -> Vec<&str> {
	let items = match input {
		TurnInput::Full(thread) => thread.items.as_slice(),
		TurnInput::Delta(_, delta) => delta.append.as_slice(),
	};
	items
		.iter()
		.flat_map(|item| match item.kind.as_ref() {
			Some(item::Kind::Message(message)) => message.parts.as_slice(),
			_ => &[],
		})
		.filter_map(|part| match part.kind.as_ref() {
			Some(part::Kind::Text(text)) => Some(text.as_str()),
			_ => None,
		})
		.collect()
}
fn scripted_turns(script: Vec<ScriptOutcome>) -> Vec<ScriptedTurn> {
	script
		.into_iter()
		.map(|outcome| match outcome {
			Ok(outcome) => ScriptedTurn::events([pb::TurnEvent {
				event: Some(turn_event::Event::Outcome(outcome)),
			}]),
			Err(error) => ScriptedTurn::results([Err(Error::Terminal(error))]),
		})
		.collect()
}

fn build_agent(
	journal: Journal,
	script: Vec<ScriptOutcome>,
) -> (Agent<ScriptedTurnClient>, ScriptedTurnClient) {
	let client = ScriptedTurnClient::new(scripted_turns(script));
	let opened = client.clone();
	let (env, _transport) = EnvClient::in_process(1);
	let agent =
		Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, CapsBase {
			maximum_parts:      16,
			maximum_text_bytes: 16_384,
			media:              false,
			model_class:        ModelClass::Standard,
		});
	(agent, opened)
}

fn turn_start(id: &str) -> TurnStart {
	TurnStart {
		turn_id:            Str::new(id),
		item_events:        Vec::new(),
		prompt_hash:        Hash32::new([0; 32]),
		prompt_head_events: Vec::new(),
		toolset_hash:       Hash32::new([0; 32]),
		enabled_tools:      Vec::new(),
		sequence_targets:   Vec::new(),
		input:              TurnInputRecord::Full { thread: thread::Thread::default() },
		options:            TurnOptionsRecord {
			context_id: None,
			params:     pb::ChatParams::default(),
			executor:   None,
			props:      None,
		},
	}
}
fn exhausted_journal(path: &Path) -> Journal {
	let mut journal = Journal::create(path, &Header {
		v:       4,
		id:      SessionId(sf!("empty-output-exhausted-test")),
		created: 1,
		cwd:     env::temp_dir(),
	})
	.expect("create journal");
	journal
		.start_turn(2, turn_start("prior-success"))
		.expect("start prior success");
	journal
		.append_arbiter_outcome(3, "prior-success", success())
		.expect("commit prior success");
	let texts = [
		"capped original".to_owned(),
		RETRY_TEXT.to_owned(),
		RETRY_TEXT.replace("Attempt #1/3", "Attempt #2/3"),
		RETRY_TEXT.replace("Attempt #1/3", "Attempt #3/3"),
	];
	for (attempt, text) in texts.into_iter().enumerate() {
		let id = format!("failed-{attempt}");
		let event = journal
			.append_turn_input(4 + attempt as u64 * 2, &id, user_text(&text), None)
			.expect("stage capped-chain input");
		let mut start = turn_start(&id);
		start.item_events = vec![event];
		start.input =
			TurnInputRecord::Full { thread: thread::Thread { items: vec![user_text(&text)] } };
		journal
			.start_turn(5 + attempt as u64 * 2, start)
			.expect("start capped-chain turn");
		let disposition = if attempt < 3 {
			AbortDisposition::Continue
		} else {
			AbortDisposition::Exhausted
		};
		journal
			.abort_turn(6 + attempt as u64 * 2, &id, disposition)
			.expect("abort capped-chain turn");
	}
	journal
}

fn agent(script: Vec<ScriptOutcome>) -> (Agent<ScriptedTurnClient>, ScriptedTurnClient, PathBuf) {
	let path = env::temp_dir().join(format!(
		"omp-agent-empty-output-{}-{}.jsonl",
		std::process::id(),
		omp_core::Ulid::generate()
	));
	let journal = Journal::create(&path, &Header {
		v:       4,
		id:      SessionId(sf!("empty-output-test")),
		created: 1,
		cwd:     env::temp_dir(),
	})
	.expect("create journal");
	let (agent, opened) = build_agent(journal, script);
	(agent, opened, path)
}

#[tokio::test]
async fn empty_output_continues_with_numbered_user_reminder() {
	let (mut agent, opened, path) =
		agent(vec![terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput), Ok(success())]);
	let result = agent
		.submit([user_text("original")], TurnId::new("root"))
		.await
		.expect("recovered submission");
	assert_eq!(result.committed_turns, 1);
	let opened: Vec<_> = opened
		.captures()
		.into_iter()
		.map(|capture| capture.input)
		.collect();
	assert_eq!(opened.len(), 2);
	assert!(input_texts(&opened[1]).contains(&RETRY_TEXT));
	assert!(matches!(&opened[1], TurnInput::Full(_)));
	assert!(input_texts(&opened[1]).contains(&"original"));
	drop(opened);
	drop(agent);
	fs::remove_file(path).expect("remove journal");
}

#[tokio::test]
async fn fourth_empty_output_hits_cap_after_exactly_three_reminders() {
	let (mut agent, opened, path) = agent(vec![
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		Ok(success()),
	]);
	let observed = agent.events().subscribe_lossless();
	let error = agent
		.submit([user_text("original")], TurnId::new("root"))
		.await
		.expect_err("retry cap must fail");
	let AgentError::Turn(Error::Terminal(error)) = error else {
		panic!("expected terminal turn error")
	};
	assert_eq!(error.detail, CAP_DETAIL);
	// Hosts settle in-flight transcript widgets off this bus event; the
	// submit `Err` alone reaches only the submitting caller.
	let mut failed = None;
	while let Ok(event) = observed.try_recv() {
		if let omp_agent::AgentEvent::Failed { turn_id, message } = event.as_ref() {
			failed = Some((turn_id.clone(), message.clone()));
		}
	}
	let (failed_turn, failed_message) = failed.expect("terminal cap publishes AgentEvent::Failed");
	assert_eq!(failed_turn.as_ref().map(|id| id.as_str().to_owned()), Some("root".to_owned()));
	assert!(failed_message.contains("terminal turn error"), "{failed_message}");
	{
		let inputs: Vec<_> = opened
			.captures()
			.into_iter()
			.map(|capture| capture.input)
			.collect();
		assert_eq!(inputs.len(), 4);
		let reminders: Vec<_> = inputs
			.iter()
			.skip(1)
			.map(|input| {
				input_texts(input)
					.into_iter()
					.rfind(|text| {
						text.starts_with("<system-injection>\nStopped without actionable output")
					})
					.expect("follow-up turn contains its reminder")
			})
			.collect();
		assert_eq!(reminders.len(), 3);
		assert!(reminders[0].contains("Attempt #1/3"));
		assert!(reminders[1].contains("Attempt #2/3"));
		assert!(reminders[2].contains("Attempt #3/3"));
	}
	assert_eq!(agent.events().phase(), AgentPhase::Idle);
	agent
		.submit([user_text("fresh after cap")], TurnId::new("fresh"))
		.await
		.expect("fresh prompt succeeds after terminal cap");
	assert_eq!(agent.events().phase(), AgentPhase::Idle);
	assert_eq!(opened.captures().len(), 5);
	drop(agent);
	fs::remove_file(path).expect("remove journal");
}

#[tokio::test]
async fn retry_count_survives_journal_reopen() {
	let path = env::temp_dir().join(format!(
		"omp-agent-empty-output-reopen-{}-{}.jsonl",
		std::process::id(),
		omp_core::Ulid::generate()
	));
	let mut journal = Journal::create(&path, &Header {
		v:       4,
		id:      SessionId(sf!("empty-output-reopen-test")),
		created: 1,
		cwd:     env::temp_dir(),
	})
	.expect("create journal");
	let original = user_text("original");
	let first_event = journal
		.append_turn_input(2, "failed-1", original.clone(), None)
		.expect("stage original input");
	let mut first = turn_start("failed-1");
	first.item_events = vec![first_event];
	first.input = TurnInputRecord::Full { thread: thread::Thread { items: vec![original.clone()] } };
	journal
		.start_turn(3, first)
		.expect("start first failed turn");
	journal
		.abort_turn(4, "failed-1", AbortDisposition::Continue)
		.expect("abort first failed turn");
	let first_reminder = user_text(RETRY_TEXT);
	let second_event = journal
		.append_turn_input(5, "failed-2", first_reminder.clone(), None)
		.expect("stage first reminder");
	let mut second = turn_start("failed-2");
	second.item_events = vec![second_event];
	second.input =
		TurnInputRecord::Full { thread: thread::Thread { items: vec![original, first_reminder] } };
	journal
		.start_turn(6, second)
		.expect("start second failed turn");
	journal
		.abort_turn(7, "failed-2", AbortDisposition::Continue)
		.expect("abort second failed turn");
	drop(journal);

	let reopened = Journal::open(&path).expect("reopen journal");
	let (mut agent, opened) = build_agent(reopened, vec![
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
	]);
	let error = agent
		.submit([], TurnId::new("root"))
		.await
		.expect_err("persisted retry count must reach cap");
	let AgentError::Turn(Error::Terminal(error)) = error else {
		panic!("expected terminal turn error")
	};
	assert_eq!(error.detail, CAP_DETAIL);
	let opened: Vec<_> = opened
		.captures()
		.into_iter()
		.map(|capture| capture.input)
		.collect();
	assert_eq!(opened.len(), 2);
	assert!(
		input_texts(&opened[1])
			.iter()
			.any(|text| text.contains("Attempt #3/3"))
	);
	// The full-reseed projection retains prior reminders; each attempt number
	// must appear exactly once (no duplicated reminder on reopen).
	for attempt in ["Attempt #1/3", "Attempt #2/3", "Attempt #3/3"] {
		let occurrences = input_texts(&opened[1])
			.iter()
			.filter(|text| text.contains(attempt))
			.count();
		assert_eq!(occurrences, 1, "{attempt} duplicated in reopened continuation");
	}
	drop(opened);
	drop(agent);
	fs::remove_file(path).expect("remove journal");
}

#[tokio::test]
async fn crash_after_abort_reclaims_input_under_fresh_full_reseed() {
	let path = env::temp_dir().join(format!(
		"omp-agent-empty-output-abort-gap-{}-{}.jsonl",
		std::process::id(),
		omp_core::Ulid::generate()
	));
	let mut journal = Journal::create(&path, &Header {
		v:       4,
		id:      SessionId(sf!("empty-output-abort-gap-test")),
		created: 1,
		cwd:     env::temp_dir(),
	})
	.expect("create journal");
	let prior_revision = thread::Revision { head: 0, token: vec![1].into() };
	let mut prior = turn_start("prior-success");
	prior.options.context_id = Some(sf!("context"));
	journal
		.start_turn(2, prior)
		.expect("start prior successful turn");
	journal
		.append_arbiter_outcome(3, "prior-success", pb::Outcome {
			stop: pb::StopReason::StopEndTurn as i32,
			revision: Some(prior_revision.clone()),
			..pb::Outcome::default()
		})
		.expect("commit prior successful turn");
	let original = user_text("original");
	let input_event = journal
		.append_turn_input(4, "failed", original.clone(), None)
		.expect("stage original input");
	let mut failed = turn_start("failed");
	failed.item_events = vec![input_event];
	failed.sequence_targets = vec![input_event];
	failed.input = TurnInputRecord::Delta {
		context: pb::ContextRef {
			context_id: "context".to_owned(),
			expected:   Some(prior_revision),
		},
		delta:   pb::ThreadDelta { truncate_to: None, append: vec![original] },
	};
	failed.options.context_id = Some(sf!("context"));
	journal.start_turn(5, failed).expect("start failed turn");
	journal
		.abort_turn(6, "failed", AbortDisposition::Continue)
		.expect("abort failed turn");
	drop(journal);

	let reopened = Journal::open(&path).expect("reopen after abort gap");
	let (recovery_id, recovery_events) = reopened
		.pending_input_submission()
		.expect("released input remains startup-visible");
	assert_ne!(recovery_id.as_str(), "failed");
	assert_eq!(recovery_events, &[input_event]);
	let (mut agent, opened) = build_agent(reopened, vec![
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		Ok(success()),
	]);
	agent
		.submit([], TurnId::new("restart"))
		.await
		.expect("fresh reclaimed submission succeeds");
	let opened: Vec<_> = opened
		.captures()
		.into_iter()
		.map(|capture| capture.input)
		.collect();
	assert_eq!(opened.len(), 2);
	assert!(matches!(&opened[0], TurnInput::Full(_)));

	let first_texts = input_texts(&opened[0]);
	assert!(first_texts.contains(&"original"));
	assert!(first_texts.contains(&RETRY_TEXT));
	assert!(
		input_texts(&opened[1])
			.iter()
			.any(|text| text.contains("Attempt #2/3"))
	);
	drop(opened);
	drop(agent);
	fs::remove_file(path).expect("remove journal");
}
#[tokio::test]
async fn exhausted_chain_is_not_released_and_fresh_user_prompt_resets_cap() {
	let path = env::temp_dir().join(format!(
		"omp-agent-empty-output-exhausted-{}-{}.jsonl",
		std::process::id(),
		omp_core::Ulid::generate()
	));
	let journal = exhausted_journal(&path);
	drop(journal);

	let reopened = Journal::open(&path).expect("reopen exhausted chain");
	assert_eq!(reopened.trailing_aborts(), 0);
	assert!(reopened.pending_turn().is_none());
	assert!(reopened.pending_input_submission().is_none());
	let (mut agent, opened) = build_agent(reopened, vec![
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		Ok(success()),
	]);
	agent
		.submit([user_text("fresh task")], TurnId::new("fresh"))
		.await
		.expect("fresh user task recovers after exhausted chain");
	let opened: Vec<_> = opened
		.captures()
		.into_iter()
		.map(|capture| capture.input)
		.collect();
	assert_eq!(opened.len(), 2);
	let first_texts = input_texts(&opened[0]);
	assert!(first_texts.contains(&"fresh task"));
	assert_eq!(
		first_texts
			.iter()
			.filter(|text| text.contains("Attempt #3/3"))
			.count(),
		1,
		"reopen must not duplicate the final reminder"
	);
	assert_eq!(
		input_texts(&opened[1])
			.iter()
			.filter(|text| **text == RETRY_TEXT)
			.count(),
		2,
		"the fresh epoch must append its own Attempt #1/3 reminder"
	);
	drop(opened);
	drop(agent);
	fs::remove_file(path).expect("remove journal");
}

#[tokio::test]
async fn fresh_epoch_abort_releases_only_fresh_inputs_after_reopen() {
	let path = env::temp_dir().join(format!(
		"omp-agent-empty-output-new-epoch-{}-{}.jsonl",
		std::process::id(),
		omp_core::Ulid::generate()
	));
	let mut journal = exhausted_journal(&path);
	let fresh = user_text("fresh crash task");
	let fresh_event = journal
		.append_turn_input(20, "fresh-failed", fresh.clone(), None)
		.expect("stage fresh epoch input");
	let mut start = turn_start("fresh-failed");
	start.item_events = vec![fresh_event];
	start.input = TurnInputRecord::Full { thread: thread::Thread { items: vec![fresh] } };
	journal
		.start_turn(21, start)
		.expect("start fresh epoch turn");
	journal
		.abort_turn(22, "fresh-failed", AbortDisposition::Continue)
		.expect("abort fresh epoch turn");
	drop(journal);

	let reopened = Journal::open(&path).expect("reopen fresh recovery epoch");
	assert_eq!(reopened.trailing_aborts(), 1);
	let (recovery_id, events) = reopened
		.pending_input_submission()
		.expect("fresh epoch remains startup-visible");
	assert_ne!(recovery_id.as_str(), "fresh-failed");
	assert_eq!(events, &[fresh_event], "old exhausted inputs stay fenced");
	let (mut agent, opened) = build_agent(reopened, vec![
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		Ok(success()),
	]);
	agent
		.submit([], TurnId::new("restart"))
		.await
		.expect("fresh epoch resumes through second reminder");
	let opened: Vec<_> = opened
		.captures()
		.into_iter()
		.map(|capture| capture.input)
		.collect();
	assert_eq!(opened.len(), 2);
	assert!(matches!(&opened[0], TurnInput::Full(_)));
	assert!(input_texts(&opened[0]).contains(&"fresh crash task"));
	assert!(
		input_texts(&opened[1])
			.iter()
			.any(|text| text.contains("Attempt #2/3"))
	);
	drop(opened);
	drop(agent);
	fs::remove_file(path).expect("remove journal");
}

#[tokio::test]
async fn crash_replay_reseeds_original_input_and_preserves_retry_count() {
	let path = env::temp_dir().join(format!(
		"omp-agent-empty-output-crash-{}-{}.jsonl",
		std::process::id(),
		omp_core::Ulid::generate()
	));
	let mut journal = Journal::create(&path, &Header {
		v:       4,
		id:      SessionId(sf!("empty-output-crash-test")),
		created: 1,
		cwd:     env::temp_dir(),
	})
	.expect("create journal");
	journal
		.start_turn(2, turn_start("prior-success"))
		.expect("start prior successful turn");
	journal
		.append_arbiter_outcome(3, "prior-success", success())
		.expect("commit prior successful turn");

	let (opened_tx, opened_rx) = flume::unbounded();
	let client = CrashClient { opened: opened_tx, calls: Arc::new(AtomicUsize::new(0)) };
	let (env, _transport) = EnvClient::in_process(1);
	let mut first_agent =
		Agent::new(client, env, AgentState::new(AgentSnapshot::default()), journal, CapsBase {
			maximum_parts:      16,
			maximum_text_bytes: 16_384,
			media:              false,
			model_class:        ModelClass::Standard,
		});
	let running = tokio::spawn(async move {
		first_agent
			.submit([user_text("original")], TurnId::new("root"))
			.await
	});
	opened_rx
		.recv_async()
		.await
		.expect("observe failed request");
	opened_rx
		.recv_async()
		.await
		.expect("observe live continuation");
	running.abort();
	assert!(
		running
			.await
			.expect_err("crashed task must be cancelled")
			.is_cancelled()
	);

	let reopened = Journal::open(&path).expect("reopen after interrupted continuation");
	assert_eq!(reopened.trailing_aborts(), 1);
	let (mut replayed, opened) = build_agent(reopened, vec![
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
	]);
	let error = replayed
		.submit([], TurnId::new("restart"))
		.await
		.expect_err("persisted abort must count toward cap");
	let AgentError::Turn(Error::Terminal(error)) = error else {
		panic!("expected terminal turn error")
	};
	assert_eq!(error.detail, CAP_DETAIL);
	let opened: Vec<_> = opened
		.captures()
		.into_iter()
		.map(|capture| capture.input)
		.collect();
	assert_eq!(opened.len(), 3);
	assert!(matches!(&opened[0], TurnInput::Full(_)));
	let first_texts = input_texts(&opened[0]);
	assert!(first_texts.contains(&"original"));
	assert!(first_texts.contains(&RETRY_TEXT));
	assert!(
		input_texts(&opened[1])
			.iter()
			.any(|text| text.contains("Attempt #2/3"))
	);
	assert!(
		input_texts(&opened[2])
			.iter()
			.any(|text| text.contains("Attempt #3/3"))
	);
	drop(opened);
	drop(replayed);
	fs::remove_file(path).expect("remove journal");
}

#[tokio::test]
async fn upstream_recovery_replays_same_turn_with_bounded_backoff_then_fails() {
	let path = env::temp_dir().join(format!(
		"omp-agent-upstream-recovery-{}-{}.jsonl",
		std::process::id(),
		omp_core::Ulid::generate()
	));
	let journal = Journal::create(&path, &Header {
		v:       4,
		id:      SessionId(sf!("upstream-recovery-test")),
		created: 1,
		cwd:     env::temp_dir(),
	})
	.expect("create journal");
	let opened = Arc::new(Mutex::new(Vec::new()));
	let client = RecoveryClient {
		script: Arc::new(Mutex::new(
			vec![
				rate_limited(15),
				terminal(omp_proto::inference::v1::turn_error::Kind::Upstream),
				terminal(omp_proto::inference::v1::turn_error::Kind::Upstream),
				terminal(omp_proto::inference::v1::turn_error::Kind::Auth),
				Ok(success()),
			]
			.into(),
		)),
		opened: Arc::clone(&opened),
	};
	let snapshot = AgentSnapshot {
		retry: RetryPolicy::new(
			NonZeroU32::new(3).expect("three is non-zero"),
			Duration::from_millis(10),
			Duration::from_millis(10),
		)
		.expect("constant retry policy"),
		..Default::default()
	};
	let (env, _transport) = EnvClient::in_process(1);
	let mut agent = Agent::new(client, env, AgentState::new(snapshot), journal, CapsBase {
		maximum_parts:      16,
		maximum_text_bytes: 16_384,
		media:              false,
		model_class:        ModelClass::Standard,
	});

	let error = agent
		.submit([user_text("original")], TurnId::new("root"))
		.await
		.expect_err("bounded upstream recovery must surface the final failure");
	assert!(matches!(&error, AgentError::Turn(Error::Terminal(_))));
	assert!(error.to_string().contains("provider detail"));
	{
		let attempts = opened.lock();
		assert_eq!(attempts.len(), 3);
		assert!(
			attempts
				.iter()
				.all(|(turn_id, ..)| turn_id.as_str() == "root")
		);
		assert!(
			attempts[1].1.duration_since(attempts[0].1) >= Duration::from_millis(15),
			"rate limit retry_after must be honored"
		);
		assert!(
			attempts[2].1.duration_since(attempts[1].1) >= Duration::from_millis(10),
			"configured transient backoff must precede the final attempt"
		);
		assert!(attempts.iter().all(|(_, _, input)| {
			!input_texts(input)
				.iter()
				.any(|text| text.contains("Stopped without actionable output"))
		}));
	}
	let auth = agent
		.submit([user_text("auth")], TurnId::new("auth"))
		.await
		.expect_err("authentication failures must surface immediately");
	assert!(matches!(&auth, AgentError::Turn(Error::Terminal(error))
		if omp_proto::inference::v1::turn_error::Kind::try_from(error.kind) == Ok(omp_proto::inference::v1::turn_error::Kind::Auth)));
	assert_eq!(opened.lock().len(), 4, "authentication failure must not retry");
	agent
		.submit([user_text("fresh")], TurnId::new("next"))
		.await
		.expect("terminally failed turns must not block later caller input");
	assert_eq!(opened.lock()[4].0.as_str(), "next");
	drop(agent);
	fs::remove_file(path).expect("remove journal");
}

#[tokio::test]
async fn capped_billed_zero_block_stop_names_the_dropped_output_tokens() {
	let (mut agent, _opened, path) = agent(vec![
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		empty_stop_terminal(omp_agent::empty_stop::BILLED_OUTPUT, "42"),
	]);
	let error = agent
		.submit([user_text("original")], TurnId::new("root"))
		.await
		.expect_err("retry cap must fail");
	let AgentError::Turn(Error::Terminal(error)) = error else {
		panic!("expected terminal turn error")
	};
	assert_eq!(
		error.detail,
		"Assistant returned an empty stop after retry cap, but the provider billed 42 output tokens \
		 for it; content was generated and then dropped before delivery, which usually points to a \
		 provider-side content filter or a lossy API translation rather than a context problem"
	);
	drop(agent);
	fs::remove_file(path).expect("remove journal");
}

#[tokio::test]
async fn capped_empty_stop_without_billed_output_keeps_the_context_hint() {
	let (mut agent, _opened, path) = agent(vec![
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		empty_stop_terminal(omp_agent::empty_stop::EMPTY, ""),
	]);
	let error = agent
		.submit([user_text("original")], TurnId::new("root"))
		.await
		.expect_err("retry cap must fail");
	let AgentError::Turn(Error::Terminal(error)) = error else {
		panic!("expected terminal turn error")
	};
	assert_eq!(
		error.detail,
		"Assistant returned an empty stop after retry cap; try switching models or removing large \
		 attachments from recent context"
	);
	drop(agent);
	fs::remove_file(path).expect("remove journal");
}

#[tokio::test]
async fn capped_thought_only_stop_reports_no_final_output() {
	let (mut agent, _opened, path) = agent(vec![
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		terminal(omp_proto::inference::v1::turn_error::Kind::EmptyOutput),
		empty_stop_terminal(omp_agent::empty_stop::NO_FINAL_OUTPUT, ""),
	]);
	let error = agent
		.submit([user_text("original")], TurnId::new("root"))
		.await
		.expect_err("retry cap must fail");
	let AgentError::Turn(Error::Terminal(error)) = error else {
		panic!("expected terminal turn error")
	};
	assert_eq!(error.detail, CAP_DETAIL);
	drop(agent);
	fs::remove_file(path).expect("remove journal");
}
