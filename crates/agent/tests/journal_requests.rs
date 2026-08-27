//! Integration coverage for journal request persistence and recovery.

use std::{
	env, fs,
	path::PathBuf,
	sync::atomic::{AtomicU64, Ordering},
};

use omp_agent::{
	EntryKindDecl, EntryKindError, Journal, JournalAuthor, JournalError, JournalGenerations,
	JournalRequestStamp, PendingCustomEntry, SessionStateWatchEvent, SessionStateWatchTerminal,
};
use omp_core::{ArtifactDigest, Hash32, InvocationPhase, Principal, Provenance, Str, sf};
use omp_storage::{
	state::{DurableRequest, GenerationFence, StateAuthority, StateRevision},
	transcript::{
		CallId, Header, InvocationTransition, Kind, SessionId, TurnInputRecord, TurnOptionsRecord,
		TurnStart,
	},
};
use serde_json::{json, value::to_raw_value};

static NEXT_PATH: AtomicU64 = AtomicU64::new(0);

fn path(name: &str) -> PathBuf {
	env::temp_dir().join(format!(
		"omp-journal-requests-{name}-{}-{}.jsonl",
		std::process::id(),
		NEXT_PATH.fetch_add(1, Ordering::Relaxed),
	))
}

fn header() -> Header {
	Header {
		v:       4,
		id:      SessionId(sf!("session")),
		created: 1,
		cwd:     PathBuf::from("/tmp"),
	}
}
fn author(extension: &str, generation: u64) -> JournalAuthor {
	JournalAuthor {
		principal:  Principal::new(sf!("os:test"), sf!("Test User")),
		provenance: Provenance::new(
			sf!("publisher"),
			Str::new(extension),
			sf!("1.0.0"),
			ArtifactDigest::new([7; 32]),
			sf!("workspace"),
			sf!("trusted"),
			generation,
		),
	}
}

fn stamp(key: &str, generation: u64) -> JournalRequestStamp {
	JournalRequestStamp {
		request_id:         sf!("request-{key}"),
		idempotency_key:    Str::new(key),
		host_generation:    generation,
		session_generation: 3,
	}
}

fn entry(value: i64) -> PendingCustomEntry {
	PendingCustomEntry {
		kind:    sf!("dev.example.fact"),
		rev:     sf!("v.2"),
		data:    Some(to_raw_value(&json!({ "value": value })).expect("raw JSON")),
		context: None,
		display: None,
	}
}

fn declare(journal: &mut Journal, extension: &str) {
	journal
		.declare_entry_kinds(extension, [EntryKindDecl::parse(
			"dev.example.fact",
			"v.2",
			true,
			false,
			None,
		)
		.expect("revision")])
		.expect("declare entry kind");
}

#[test]
fn atomic_replay_returns_recorded_indexes_and_core_stamps_authorship() {
	let path = path("atomic-replay");
	let mut journal = Journal::create(&path, &header()).expect("create journal");
	journal.set_generations(JournalGenerations { host: 7, session: 3 });
	declare(&mut journal, "dev.example");
	let author = author("dev.example", 7);
	let stamp = stamp("atomic", 7);

	let indexes = journal
		.append_custom_atomic(10, vec![entry(1), entry(2)], &stamp, &author)
		.expect("atomic append");
	assert_eq!(indexes, vec![1, 2]);
	let bytes = fs::read(&path).expect("journal bytes");

	let replayed = journal
		.append_custom_atomic(99, vec![entry(1), entry(2)], &stamp, &author)
		.expect("same-owner replay");
	assert_eq!(replayed, indexes);
	assert_eq!(std::fs::read(&path).expect("replayed bytes"), bytes);

	drop(journal);
	let mut reopened = Journal::open(&path).expect("reopen journal");
	reopened.set_generations(JournalGenerations { host: 7, session: 3 });
	declare(&mut reopened, "dev.example");
	assert_eq!(
		reopened
			.append_custom_atomic(100, vec![entry(1), entry(2)], &stamp, &author)
			.expect("cross-restart replay"),
		indexes,
	);
	let view = reopened.load().expect("load journal");
	let customs = view
		.log()
		.custom(view.live(), "dev.example.fact")
		.collect::<Vec<_>>();
	assert_eq!(customs.len(), 2);
	let Kind::Custom(first) = &customs[0].1.kind else {
		panic!("custom event");
	};
	assert_eq!(first.rev(), Some("v.2"));
	assert_eq!(first.source(), Some("dev.example"));
	assert_eq!(first.principal().id(), "os:test");
	assert_eq!(first.provenance().extension_id(), "dev.example");
}
fn state_authority() -> StateAuthority {
	StateAuthority::new_core(
		Principal::new(sf!("os:test"), sf!("Test User")),
		Provenance::new(
			sf!("publisher"),
			sf!("dev.example"),
			sf!("1.0.0"),
			ArtifactDigest::new([7; 32]),
			sf!("workspace"),
			sf!("trusted"),
			7,
		),
		"dev.example",
		"session",
		"project",
		GenerationFence { host: 7, session: 3 },
	)
	.expect("state authority")
}

#[test]
fn session_state_cas_uses_physical_journal_revision_and_replays() {
	let path = path("session-state");
	let mut journal = Journal::create(&path, &header()).expect("create journal");
	journal.set_generations(JournalGenerations { host: 7, session: 3 });
	let authority = state_authority();
	let request = DurableRequest::new("state-request", Some(sf!("state-key")), GenerationFence {
		host:    7,
		session: 3,
	})
	.expect("durable request");
	let value = to_raw_value(&json!({ "enabled": true })).expect("state value");
	let installed = journal
		.compare_exchange_session_state(10, &authority, sf!("feature"), None, value.clone(), &request)
		.expect("install state");
	assert_eq!(installed.revision, StateRevision::new(1));
	let replayed = journal
		.compare_exchange_session_state(11, &authority, sf!("feature"), None, value, &request)
		.expect("replay state");
	assert_eq!(replayed.revision, installed.revision);
	assert_eq!(
		journal
			.latest_session_state(&authority, "feature")
			.expect("read state")
			.expect("state present")
			.revision,
		installed.revision,
	);
	let watch = journal
		.subscribe_session_state(&authority, sf!("feature"), None)
		.expect("subscribe state");
	assert!(matches!(
		watch.recv().expect("catch-up value"),
		SessionStateWatchEvent::Value(value) if value.revision == installed.revision
	));
	let request_two =
		DurableRequest::new("state-request-two", Some(sf!("state-key-two")), GenerationFence {
			host:    7,
			session: 3,
		})
		.expect("second durable request");
	let second = journal
		.compare_exchange_session_state(
			12,
			&authority,
			sf!("feature"),
			Some(installed.revision),
			to_raw_value(&json!({ "enabled": false })).expect("second value"),
			&request_two,
		)
		.expect("second state");
	assert!(matches!(
		watch.recv().expect("ordered value"),
		SessionStateWatchEvent::Value(value) if value.revision == second.revision
	));

	let lagged = journal
		.subscribe_session_state(&authority, sf!("feature"), Some(second.revision))
		.expect("lag subscription");
	let request_three =
		DurableRequest::new("state-request-three", Some(sf!("state-key-three")), GenerationFence {
			host:    7,
			session: 3,
		})
		.expect("third durable request");
	let third = journal
		.compare_exchange_session_state(
			13,
			&authority,
			sf!("feature"),
			Some(second.revision),
			to_raw_value(&json!({ "n": 3 })).expect("third value"),
			&request_three,
		)
		.expect("third state");
	let request_four =
		DurableRequest::new("state-request-four", Some(sf!("state-key-four")), GenerationFence {
			host:    7,
			session: 3,
		})
		.expect("fourth durable request");
	let fourth = journal
		.compare_exchange_session_state(
			14,
			&authority,
			sf!("feature"),
			Some(third.revision),
			to_raw_value(&json!({ "n": 4 })).expect("fourth value"),
			&request_four,
		)
		.expect("fourth state");
	assert!(matches!(
		lagged.recv().expect("last queued value"),
		SessionStateWatchEvent::Value(value) if value.revision == third.revision
	));
	assert!(matches!(
		lagged.recv().expect("typed lag terminal"),
		SessionStateWatchEvent::Terminal(SessionStateWatchTerminal::Lagged {
			after: Some(revision),
		}) if revision == third.revision
	));
	let closed = journal
		.subscribe_session_state(&authority, sf!("feature"), Some(fourth.revision))
		.expect("close subscription");
	drop(journal);
	assert!(matches!(
		closed.recv().expect("typed close terminal"),
		SessionStateWatchEvent::Terminal(SessionStateWatchTerminal::Closed)
	));
}

#[test]
fn declaration_conflict_and_namespace_reads_fail_closed() {
	let mut registry = omp_agent::EntryKindRegistry::new();
	let declaration =
		EntryKindDecl::parse("dev.example.fact", "v.1", false, false, None).expect("revision");
	registry
		.declare_extension("dev.example", [declaration.clone()])
		.expect("first declaration");
	registry
		.declare_extension("dev.example", [declaration])
		.expect("exact declaration is idempotent");
	assert!(matches!(
		registry.declare_extension("dev.other", [EntryKindDecl::parse(
			"dev.example.fact",
			"v.1",
			false,
			false,
			None
		)
		.expect("revision")],),
		Err(EntryKindError::Conflict(_)),
	));
	assert!(matches!(
		registry.authorize_read("dev.other", std::iter::empty(), "dev.example.fact"),
		Err(EntryKindError::AccessDenied { .. }),
	));
	registry
		.authorize_read("dev.other", ["dev.example"], "dev.example.fact")
		.expect("manifest grant authorizes namespace");
}

#[test]
fn pending_turn_target_and_generation_guards_run_before_staging() {
	let path = path("guards");
	let mut journal = Journal::create(&path, &header()).expect("create journal");
	journal.set_generations(JournalGenerations { host: 7, session: 3 });
	declare(&mut journal, "dev.example");
	let author = author("dev.example", 7);
	let good = stamp("guard", 7);
	let stale = stamp("stale", 6);
	assert!(matches!(
		journal.append_custom(2, entry(1), &stale, &author),
		Err(JournalError::StaleGeneration { .. }),
	));
	assert!(matches!(
		journal.label(2, 99, None, &good, &author),
		Err(JournalError::InvalidTarget(99)),
	));

	journal
		.start_turn(3, TurnStart {
			turn_id:            sf!("turn"),
			item_events:        Vec::new(),
			prompt_hash:        Hash32::new([0; 32]),
			prompt_head_events: Vec::new(),
			toolset_hash:       Hash32::new([0; 32]),
			enabled_tools:      Vec::new(),
			sequence_targets:   Vec::new(),
			input:              TurnInputRecord::Full { thread: Default::default() },
			options:            TurnOptionsRecord {
				context_id: None,
				params:     Default::default(),
				executor:   None,
				props:      None,
			},
		})
		.expect("start pending turn");
	assert!(matches!(
		journal.append_custom(4, entry(2), &good, &author),
		Err(JournalError::WriteWhilePending),
	));
}

fn transition(id: &str, phase: InvocationPhase) -> InvocationTransition {
	InvocationTransition {
		invocation_id: Str::new(id),
		call_id: CallId(sf!("call")),
		phase,
		requested_args: (phase == InvocationPhase::ArgsFinalized)
			.then(|| to_raw_value(&json!({ "x": 1 })).expect("raw args")),
		transformations: None,
		effective_args: None,
		admission_receipt: None,
		assistant_item_event: None,
		effect_token: None,
		authorized_at: None,
		effects: None,
		outcome: None,
	}
}

#[test]
fn invocation_transitions_are_adjacent_and_idempotent() {
	let path = path("invocation");
	let mut journal = Journal::create(&path, &header()).expect("create journal");
	let open = transition("inv", InvocationPhase::Open);
	let index = journal
		.record_invocation_transition(1, open.clone())
		.expect("record open");
	assert_eq!(
		journal
			.record_invocation_transition(2, open)
			.expect("idempotent open"),
		index,
	);
	assert!(matches!(
		journal.record_invocation_transition(3, transition("inv", InvocationPhase::Admission)),
		Err(JournalError::InvalidInvocationTransition { .. }),
	));
	journal
		.record_invocation_transition(4, transition("inv", InvocationPhase::ArgsFinalized))
		.expect("adjacent args-finalized");
}
