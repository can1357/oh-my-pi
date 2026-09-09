//! Generated journal replay and branching law.
//!
//! Generator shape ported from
//! `/work/o2/crates/world/tests/replay_prop.rs:11-158` and `/work/o3/crates/
//! world/tests/world.rs:134-170`; event names and APIs are the omp2 session
//! contract rather than either donor's vocabulary.

use omp_core::{Hash32, Str};
use omp_dom::{KnownTag, Op, PropId, Tag, Txn, Value};
use omp_journal::{Journal, kind};
use omp_session::{ComponentRegistry, Session};
use proptest::prelude::*;
use serde_json::value::RawValue;

#[derive(Clone, Debug)]
enum Action {
	Turn,
	User(u16),
	Assistant(u16),
	Tool(u16),
	Patch(u16),
	Rewind(u8),
}

fn actions() -> impl Strategy<Value = Vec<Action>> {
	prop::collection::vec(
		prop_oneof![
			Just(Action::Turn),
			any::<u16>().prop_map(Action::User),
			any::<u16>().prop_map(Action::Assistant),
			any::<u16>().prop_map(Action::Tool),
			any::<u16>().prop_map(Action::Patch),
			any::<u8>().prop_map(Action::Rewind),
		],
		1..40,
	)
}

fn raw(value: serde_json::Value) -> Box<RawValue> {
	serde_json::value::to_raw_value(&value).expect("test JSON serializes")
}

fn jobs_handle(session: &Session) -> omp_dom::Handle {
	session
		.dom()
		.children(session.dom().meta())
		.iter()
		.copied()
		.find(|handle| {
			session
				.dom()
				.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Jobs))
		})
		.expect("jobs component exists")
}

fn latest_assistant(session: &Session) -> Option<omp_dom::Handle> {
	let turn = session
		.dom()
		.children(session.dom().body())
		.last()
		.copied()?;
	session
		.dom()
		.children(turn)
		.iter()
		.rev()
		.copied()
		.find(|handle| {
			session
				.dom()
				.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Assistant))
		})
}

fn assert_journal_unchanged(path: &std::path::Path, before: &[u8]) {
	assert_eq!(std::fs::read(path).expect("journal reads"), before);
	// The writer under test still holds the journal lock; the read-only scan
	// proves the committed prefix remains decodable.
	omp_journal::Journal::scan(path).expect("journal remains replayable");
}

#[test]
fn failing_writes_never_poison_the_journal() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("preflight.oms");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("turn starts");
	let before = std::fs::read(&path).expect("journal reads");

	let unknown_call = omp_journal::EntryId::from(omp_core::Ulid::generate());
	assert!(
		session
			.call_update(unknown_call, raw(serde_json::json!({})))
			.is_err()
	);
	assert_journal_unchanged(&path, &before);
	assert!(
		session
			.settle(unknown_call, raw(serde_json::json!({})))
			.is_err()
	);
	assert_journal_unchanged(&path, &before);
	assert!(
		session
			.fail(unknown_call, raw(serde_json::json!({})))
			.is_err()
	);
	assert_journal_unchanged(&path, &before);

	assert!(session.stream_append(99, "orphan").is_err());
	assert_journal_unchanged(&path, &before);
	assert!(session.stream_close(99).is_err());
	assert_journal_unchanged(&path, &before);
	assert!(
		session
			.call("read", 1, "bad-stream", None, None, Some(99))
			.is_err()
	);
	assert_journal_unchanged(&path, &before);

	let invalid_handle = omp_dom::Handle::new(999_999).expect("nonzero handle");
	assert!(
		session
			.stream_open(invalid_handle, PropId::Text.into())
			.is_err()
	);
	assert_journal_unchanged(&path, &before);

	let cause = session.head().expect("session head");
	assert!(
		session
			.patch(Txn {
				cause,
				label: None,
				ops: vec![Op::Set {
					h:     invalid_handle,
					prop:  PropId::Data.into(),
					value: Value::Int(1),
				}],
			})
			.is_err()
	);
	assert_journal_unchanged(&path, &before);

	let missing =
		omp_journal::blob::BlobRef { hash: omp_core::Hash32::sum(b"not stored"), size: 10 };
	assert!(
		session
			.compaction(omp_journal::data::Compaction::new(missing, cause))
			.is_err()
	);
	assert_journal_unchanged(&path, &before);
}

#[test]
fn json_object_patch_validates_the_wire_form_and_replays() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("json-patch.oms");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	let cause = session.head().expect("genesis");
	session
		.patch(Txn {
			cause,
			label: Some(Str::new_static("json.patch")),
			ops: vec![Op::Set {
				h:     session.dom().queues(),
				prop:  PropId::Data.into(),
				value: Value::Json(raw(serde_json::json!({
					"nested": {"array": [1, true, null]}
				}))),
			}],
		})
		.expect("JSON object patch appends");
	let live = session.dom().snapshot();
	drop(session);
	let restored = Session::open(path, ComponentRegistry::default()).expect("JSON patch replays");
	assert_eq!(restored.dom().snapshot().as_bytes(), live.as_bytes());
}

#[test]
fn thirty_nested_rewinds_replay_within_one_second() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("thirty-nested.oms");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("turn starts");
	session
		.assistant_start("model", "provider", "route")
		.expect("assistant starts");
	for depth in 0..30 {
		let target = session.head().expect("nested target");
		session
			.user(format!("abandoned-{depth}"), Vec::new())
			.expect("abandoned work");
		session.rewind(target).expect("nested rewind");
		let cause = session.head().expect("rewound head");
		session
			.patch(Txn {
				cause,
				label: None,
				ops: vec![Op::Ins {
					parent: jobs_handle(&session),
					after:  None,
					node:   omp_dom::NodeSpec::new(KnownTag::Job)
						.with_prop(PropId::Id, Value::Str(Str::new(format!("job-{depth}")))),
				}],
			})
			.expect("nested non-root patch");
		let assistant = latest_assistant(&session).expect("assistant survives rewind");
		let prop = omp_dom::PropKey::Custom(Str::new(format!("nested-{depth}")));
		let sid = session.stream_open(assistant, prop).expect("stream opens");
		session.stream_append(sid, "x").expect("stream appends");
	}
	let live = session.dom().snapshot();
	drop(session);
	let started = std::time::Instant::now();
	let restored = Session::open(path, ComponentRegistry::default()).expect("nested journal opens");
	assert_eq!(restored.dom().snapshot().as_bytes(), live.as_bytes());
	assert!(started.elapsed() < std::time::Duration::from_secs(1));
}

#[test]
fn custom_stream_property_keeps_its_wire_discriminator() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("custom-prop.oms");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("turn starts");
	session
		.call("read", 1, "call-1", None, Some(raw(serde_json::json!({}))), None)
		.expect("call starts");
	let turn = *session
		.dom()
		.children(session.dom().body())
		.last()
		.expect("turn");
	let tool = session
		.dom()
		.children(turn)
		.iter()
		.copied()
		.find(|handle| {
			session
				.dom()
				.get(*handle)
				.is_some_and(|node| matches!(node.tag, Tag::Custom(_)))
		})
		.expect("tool node");
	let before = std::fs::read(&path).expect("journal reads");
	assert!(session.stream_open(tool, PropId::Rev.into()).is_err());
	assert_journal_unchanged(&path, &before);

	let custom = omp_dom::PropKey::Custom(Str::new_static("rev"));
	let sid = session
		.stream_open(tool, custom.clone())
		.expect("custom stream opens");
	session
		.stream_append(sid, "custom")
		.expect("custom stream appends");
	session.stream_close(sid).expect("custom stream closes");
	let node = session.dom().get(tool).expect("tool remains");
	assert_eq!(node.prop(&custom).and_then(omp_dom::Value::as_str), Some("custom"));
	assert!(matches!(node.prop(&omp_dom::PropKey::from(PropId::Rev)), Some(Value::Int(1))));
	let call = session
		.unsettled_calls()
		.first()
		.expect("call remains unsettled")
		.entry;
	session
		.settle(call, raw(serde_json::json!({"ok": true})))
		.expect("call settles before replay");
	let live = session.dom().snapshot();
	drop(session);
	let restored = Session::open(path, ComponentRegistry::default()).expect("session replays");
	assert_eq!(restored.dom().snapshot().as_bytes(), live.as_bytes());
}

#[test]
fn nested_rewind_replays_reminted_patch_and_stream_handles() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("nested-handles.oms");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("turn starts");
	let assistant_entry = session
		.assistant_start("model", "provider", "route")
		.expect("assistant starts");
	session.rewind(assistant_entry).expect("assistant rewind");
	let assistant = latest_assistant(&session).expect("reminted assistant");
	let sid = session
		.stream_open(assistant, PropId::Text.into())
		.expect("stream opens");
	session
		.stream_append(sid, "branch text")
		.expect("stream appends");
	session.stream_close(sid).expect("stream closes");
	let cause = session.head().expect("stream close is head");
	let first_patch = session
		.patch(Txn {
			cause,
			label: None,
			ops: vec![Op::Ins {
				parent: jobs_handle(&session),
				after:  None,
				node:   omp_dom::NodeSpec::new(KnownTag::Job)
					.with_prop(PropId::Id, Value::Str(Str::new_static("first-job"))),
			}],
		})
		.expect("patch under reminted jobs");
	session
		.user("abandoned", Vec::new())
		.expect("later work appends");
	session
		.rewind(first_patch)
		.expect("nested rewind replays first patch");
	let cause = session.head().expect("patch is selected head");
	session
		.patch(Txn {
			cause,
			label: None,
			ops: vec![Op::Ins {
				parent: jobs_handle(&session),
				after:  None,
				node:   omp_dom::NodeSpec::new(KnownTag::Job)
					.with_prop(PropId::Id, Value::Str(Str::new_static("second-job"))),
			}],
		})
		.expect("nested branch patch");
	let live = session.dom().snapshot();
	drop(session);
	let restored = Session::open(path, ComponentRegistry::default()).expect("nested branch replays");
	assert_eq!(restored.dom().snapshot().as_bytes(), live.as_bytes());
}

#[test]
fn write_api_assigns_the_declared_causes() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("causes.oms");
	let store = omp_journal::blob::BlobStore::open(directory.path()).expect("blob store opens");
	let summary = store.put(b"summary").expect("summary stores");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	let genesis = session.head().expect("genesis");
	let turn = session.begin_turn().expect("turn");
	session.user("user", Vec::new()).expect("user");
	session
		.assistant_start("model", "provider", "route")
		.expect("assistant");
	let assistant = latest_assistant(&session).expect("assistant handle");
	let sid = session
		.stream_open(assistant, PropId::Text.into())
		.expect("stream open");
	session.stream_append(sid, "delta").expect("stream append");
	session.stream_close(sid).expect("stream close");
	session.assistant_end("stop").expect("assistant end");
	let call = session
		.call("read", 1, "call-1", None, Some(raw(serde_json::json!({}))), None)
		.expect("call");
	session
		.call_update(call, raw(serde_json::json!({"progress":1})))
		.expect("update");
	session
		.settle(call, raw(serde_json::json!({"text":"done"})))
		.expect("result");
	let receipt = session
		.receipt(omp_journal::data::TurnReceipt::tokens(1, 2, 3))
		.expect("receipt");
	session
		.patch(Txn {
			cause: receipt,
			label: None,
			ops:   vec![Op::Set {
				h:     session.dom().queues(),
				prop:  PropId::Data.into(),
				value: Value::Int(1),
			}],
		})
		.expect("patch");
	session
		.compaction(omp_journal::data::Compaction::new(summary, receipt))
		.expect("compaction");
	drop(session);

	let (_, entries) = Journal::open(path).expect("journal opens");
	assert_eq!(entries[0].kind.name.as_str(), kind::JOURNAL);
	assert_eq!(entries[0].by, None);
	for entry in &entries[1..] {
		let expected = match entry.kind.name.as_str() {
			kind::TURN_START => genesis,
			kind::TOOL_UPDATE | kind::TOOL_RESULT => call,
			kind::PATCH => receipt,
			_ => turn,
		};
		assert_eq!(entry.by, Some(expected), "wrong cause for {}", entry.kind);
	}
}

/// Receipt timing/cache facts and compaction method/token facts are element
/// props on the live tree and read back identically from a reopened journal
/// (the transcript's usage row and maintenance dividers project only these).
#[test]
fn receipt_and_compaction_facts_materialize_and_survive_reopen() {
	use omp_journal::data::{
		Compaction, InferenceRecovery, InferenceRecoveryKind, ReceiptIdentity, ReceiptRole,
		TurnReceipt,
	};
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("facts.oms");
	let store = omp_journal::blob::BlobStore::open(directory.path()).expect("blob store opens");
	let summary = store.put(b"# Summary").expect("summary stores");
	let frame = store.put(b"snapcompact png").expect("frame stores");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("turn");
	session.user("user", Vec::new()).expect("user");
	let receipt = session
		.receipt(TurnReceipt {
			tokens_in:                   1_000,
			tokens_out:                  200,
			cost_nano_usd:               5,
			cache_read:                  800,
			cache_write:                 100,
			ttft_ms:                     Some(420),
			duration_ms:                 Some(3_100),
			premium_requests_millionths: 330_000,
			identity:                    None,
			recoveries:                  vec![InferenceRecovery {
				attempt:     1,
				kind:        InferenceRecoveryKind::HarmonyLeakRepair,
				rule:        Str::new_static("harmony/codex/final"),
				input_bytes: 48,
				steps:       1,
			}],
		})
		.expect("receipt");
	session
		.receipt(TurnReceipt {
			cost_nano_usd: 80_000_000,
			identity: Some(ReceiptIdentity {
				role:     ReceiptRole::Advisor,
				provider: Str::new_static("anthropic"),
				model:    Str::new_static("claude-sonnet-4-5"),
			}),
			..TurnReceipt::default()
		})
		.expect("advisor receipt");
	session
		.compaction(Compaction {
			summary,
			boundary: receipt,
			method: Some(Str::new_static("snapcompact")),
			tokens_before: Some(256_000),
			tokens_after: Some(20_000),
			warning: Some(Str::new_static("dead end")),
			frames: vec![omp_journal::data::Attachment {
				blob: frame,
				mime: Str::new_static("image/png"),
			}],
		})
		.expect("compaction");
	let live = session.dom().snapshot();
	drop(session);

	let reopened = Session::open(&path, ComponentRegistry::default()).expect("session reopens");
	assert_eq!(reopened.dom().snapshot(), live);
	let dom = reopened.dom();
	let mut usages = dom.select("body turn usage").expect("selector");
	let usage = usages.next().expect("usage");
	let usage = dom.get(usage).expect("usage node");
	let int = |node: &omp_dom::Node, prop: PropId| match node.prop(&prop.into()) {
		Some(Value::Int(value)) => *value,
		other => panic!("{prop:?} is {other:?}"),
	};
	assert_eq!(int(usage, PropId::CacheRead), 800);
	assert_eq!(int(usage, PropId::CacheWrite), 100);
	assert_eq!(int(usage, PropId::TtftMs), 420);
	assert_eq!(int(usage, PropId::DurationMs), 3_100);
	let recoveries = match usage.prop(&omp_dom::PropKey::Custom(Str::new_static("recoveries"))) {
		Some(Value::Json(raw)) => {
			serde_json::from_str::<serde_json::Value>(raw.get()).expect("typed recovery evidence")
		},
		other => panic!("recovery evidence is {other:?}"),
	};
	assert_eq!(
		recoveries
			.as_array()
			.and_then(|items| items.first())
			.and_then(|item| item.get("kind"))
			.and_then(serde_json::Value::as_str),
		Some("harmony_leak_repair")
	);
	let advisor = dom
		.get(usages.next().expect("advisor usage"))
		.expect("advisor usage node");
	assert_eq!(advisor.prop(&PropId::Kind.into()).and_then(Value::as_str), Some("advisor"));
	assert_eq!(
		advisor
			.prop(&PropId::Provider.into())
			.and_then(Value::as_str),
		Some("anthropic")
	);
	assert_eq!(
		advisor.prop(&PropId::Model.into()).and_then(Value::as_str),
		Some("claude-sonnet-4-5")
	);
	assert_eq!(int(advisor, PropId::CostNanoUsd), 80_000_000);
	let compaction = dom
		.select("meta compaction")
		.expect("selector")
		.next()
		.expect("compaction");
	let compaction = dom.get(compaction).expect("compaction node");
	assert_eq!(
		compaction
			.prop(&PropId::Method.into())
			.and_then(Value::as_str),
		Some("snapcompact")
	);
	assert_eq!(int(compaction, PropId::TokensBefore), 256_000);
	assert_eq!(int(compaction, PropId::TokensAfter), 20_000);
	assert_eq!(
		compaction
			.prop(&PropId::Warning.into())
			.and_then(Value::as_str),
		Some("dead end")
	);
	assert_eq!(int(compaction, PropId::FrameCount), 1);
	let frames = omp_session::compaction_frames(compaction);
	assert_eq!(frames, vec![omp_journal::data::Attachment {
		blob: frame,
		mime: Str::new_static("image/png"),
	}]);
	let projected = omp_session::project_thread(dom);
	let message = projected
		.first()
		.and_then(|item| match item.kind.as_ref()? {
			omp_proto::thread::v1::item::Kind::Message(message) => Some(message),
			_ => None,
		})
		.expect("compaction summary message");
	assert_eq!(message.parts.len(), 2, "summary text is followed by the retained frame");
	let blob = message.parts[1]
		.kind
		.as_ref()
		.and_then(|part| match part {
			omp_proto::thread::v1::part::Kind::Blob(blob) => Some(blob),
			_ => None,
		})
		.expect("frame blob");
	assert_eq!(blob.hash.as_ref(), frame.hash.as_bytes());
	assert_eq!(blob.size, frame.size);
}

#[test]
fn compaction_rejects_frame_count_and_byte_payloads_beyond_durable_bounds() {
	use omp_journal::{
		blob::BlobRef,
		data::{Attachment, Compaction, MAX_SNAPCOMPACT_FRAME_BYTES, MAX_SNAPCOMPACT_FRAMES},
	};
	let directory = tempfile::tempdir().expect("temporary session directory");
	let mut session =
		Session::create(directory.path().join("frame-bounds.oms"), ComponentRegistry::default())
			.expect("session creates");
	session.begin_turn().expect("turn");
	let boundary = session.user("old", Vec::new()).expect("user");
	let summary = session.blobs().put(b"summary").expect("summary");

	let frame = Attachment {
		blob: BlobRef { hash: Hash32::sum(b"frame"), size: 1 },
		mime: Str::new_static("image/png"),
	};
	let mut too_many = Compaction::new(summary, boundary);
	too_many.frames = vec![frame; MAX_SNAPCOMPACT_FRAMES + 1];
	assert!(matches!(
		session.compaction(too_many),
		Err(omp_session::SessionError::TooManyCompactionFrames {
			actual,
			maximum: MAX_SNAPCOMPACT_FRAMES,
		}) if actual == MAX_SNAPCOMPACT_FRAMES + 1
	));

	let mut too_large = Compaction::new(summary, boundary);
	too_large.frames.push(Attachment {
		blob: BlobRef { hash: Hash32::sum(b"large frame"), size: MAX_SNAPCOMPACT_FRAME_BYTES + 1 },
		mime: Str::new_static("image/png"),
	});
	assert!(matches!(
		session.compaction(too_large),
		Err(omp_session::SessionError::CompactionFramesTooLarge {
			actual,
			maximum: MAX_SNAPCOMPACT_FRAME_BYTES,
		}) if actual == MAX_SNAPCOMPACT_FRAME_BYTES + 1
	));
}

proptest! {
	#![proptest_config(ProptestConfig::with_cases(64))]

	#[test]
	fn replay_journal_equals_live_state_over_arbitrary_branched_sessions(actions in actions()) {
		let directory = tempfile::tempdir().expect("temporary session directory");
		let path = directory.path().join("replay.oms");
		let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
		let mut heads = vec![session.head().expect("genesis is the head")];
		heads.push(session.begin_turn().expect("initial turn starts"));

		for action in actions {
			let result = match action {
				Action::Turn => session.begin_turn(),
				Action::User(seed) => session.user(format!("user-{seed}"), Vec::new()),
				Action::Assistant(seed) => {
					let start = session.assistant_start("model", "provider", "route");
					if start.is_ok() {
						if let Some(handle) = latest_assistant(&session) {
							let sid = session.stream_open(handle, PropId::Text.into()).expect("stream opens");
							session.stream_append(sid, &format!("assistant-{seed}")).expect("delta appends");
							session.stream_close(sid).expect("stream closes");
						}
						session.assistant_end("stop")
					} else {
						start
					}
				},
				Action::Tool(seed) => {
					let call = session.call(
						"read",
						1,
						format!("call-{seed}"),
						Some(Str::new_static("read fixture")),
						Some(raw(serde_json::json!({"path": format!("file-{seed}")}))),
						None,
					);
					match call {
						Ok(call) => session.settle(call, raw(serde_json::json!({"text": format!("result-{seed}")}))),
						Err(error) => Err(error),
					}
				},
				Action::Patch(seed) => {
					let cause = session.head().expect("nonempty session");
					session.patch(Txn {
						cause,
						label: Some(Str::new_static("generated.patch")),
						ops: vec![Op::Ins {
							parent: jobs_handle(&session),
							after: None,
							node: omp_dom::NodeSpec::new(KnownTag::Job).with_prop(
								PropId::Id,
								Value::Str(Str::new(format!("generated-{seed}"))),
							),
						}],
					})
				},
				Action::Rewind(seed) => {
					let target = heads[usize::from(seed) % heads.len()];
					session.rewind(target).expect("retained head rewinds");
					session.begin_turn()
				},
			};
			if let Ok(id) = result {
				heads.push(id);
			}
		}

		let live = session.dom().snapshot();
		let live_head = session.head();
		drop(session);
		let reopened = Session::open(&path, ComponentRegistry::default()).expect("session replays");
		prop_assert_eq!(reopened.head(), live_head);
		let reopened_snapshot = reopened.dom().snapshot();
		prop_assert_eq!(reopened_snapshot.as_bytes(), live.as_bytes());
	}
}
