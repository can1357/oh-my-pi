//! Durable session substrate behavior tests.

use std::{env, fs, fs::OpenOptions, io::Write as _};

use omp_core::{Str, sf};
use omp_storage::{
	transcript,
	transcript::{
		DiagnosticKind, Event, Header, Kind, MAX_PERSISTED_CHARS, Msg, SessionId, UserBlock, Writer,
		import::import_pi_file, load, visit_batched,
	},
};
use tempfile::tempdir;
use xutf::Utf8;

fn header() -> Header {
	Header {
		v:       4,
		id:      SessionId(sf!("session-p1")),
		created: 1,
		cwd:     env::temp_dir(),
	}
}

fn user(text: Str) -> Event {
	Event {
		ts:   2,
		kind: Kind::Msg(Msg::User {
			content:     vec![UserBlock::Text { text }],
			synthetic:   false,
			steering:    false,
			attribution: None,
		}),
	}
}

fn message_text(event: &Event) -> &str {
	let Kind::Msg(Msg::User { content, .. }) = &event.kind else {
		panic!("expected user message")
	};
	let UserBlock::Text { text } = &content[0] else {
		panic!("expected text block")
	};
	text
}

#[test]
fn lazy_first_append_materializes_header_and_event_together() {
	let directory = tempdir().expect("temporary directory");
	let path = directory.path().join("session.jsonl");
	let mut untouched = Writer::create_lazy(&path, &header()).expect("create lazy writer");
	assert!(!path.exists());
	drop(untouched);
	assert!(!path.exists());

	untouched = Writer::create_lazy(&path, &header()).expect("create second lazy writer");
	untouched
		.append_atomic(&[user(sf!("first"))])
		.expect("append first event");
	let log = load(&path).expect("load materialized journal");
	assert_eq!(log.header(), &header());
	assert_eq!(log.len(), 1);
}

#[test]
fn bounded_visitor_preserves_indexes_and_reports_malformed_tail() {
	let directory = tempdir().expect("temporary directory");
	let path = directory.path().join("large.jsonl");
	let mut writer = Writer::create(&path, &header()).expect("create journal");
	let payload = "x".repeat(1_024);
	let events = (0..8_300)
		.map(|ordinal| user(Str::new(format!("{ordinal}:{payload}"))))
		.collect::<Vec<_>>();
	writer.append_many(&events).expect("append large batch");
	drop(writer);
	let mut file = OpenOptions::new()
		.append(true)
		.open(&path)
		.expect("open tail");
	file
		.write_all(b"{malformed}\n{truncated")
		.expect("append damaged records");
	drop(file);
	let mut indexes = Vec::new();
	let mut batches = 0;
	let report = visit_batched(
		&path,
		1_024,
		|index, _| {
			indexes.push(index);
			true
		},
		|| batches += 1,
	)
	.expect("visit journal");
	assert_eq!(indexes.first(), Some(&0));
	// `{malformed}` is the last visited record; the unterminated `{truncated`
	// tail is reported, not visited, matching the incremental Reader.
	assert_eq!(indexes.last(), Some(&8_300));
	assert_eq!(report.counters.malformed, 1);
	assert_eq!(report.counters.truncated, 1);
	assert!(batches >= 8);
	assert_eq!(
		report.diagnostics.last().map(|diagnostic| diagnostic.kind),
		Some(DiagnosticKind::Truncated)
	);
}

#[test]
fn pi_v1_import_retains_source_and_records_dropped_fields() {
	let directory = tempdir().expect("temporary directory");
	let source = directory.path().join("pi-v1.jsonl");
	let destination = directory.path().join("v4.jsonl");
	let bytes = concat!(
		r#"{"type":"session","id":"legacy","cwd":"/tmp","provider":"anthropic"}"#,
		"\n",
		r#"{"type":"message","timestamp":2,"message":{"role":"user","content":[{"type":"text","text":"hello"}]}}"#,
		"\n",
	);
	fs::write(&source, bytes).expect("write source");
	let report = import_pi_file(&source, &destination, &header()).expect("import pi v1");
	assert_eq!(std::fs::read(&source).expect("source remains"), bytes.as_bytes());
	assert_eq!(report.migration.source_version, 1);
	assert!(
		report
			.migration
			.dropped_fields
			.iter()
			.any(|field| field == "provider")
	);
	let log = load(&destination).expect("load v4 output");
	assert!(log.len() >= 3, "migration record plus message provenance");
}

#[test]
fn unicode_truncation_preserves_newlines_and_is_replay_stable() {
	let directory = tempdir().expect("temporary directory");
	let first = directory.path().join("first.jsonl");
	let second = directory.path().join("second.jsonl");
	let original = format!("{}\n{}\nend", "😀".repeat(MAX_PERSISTED_CHARS), "z".repeat(64));
	let mut writer = Writer::create(&first, &header()).expect("create first");
	writer
		.append(&user(Str::new(&original)))
		.expect("append oversized message");
	drop(writer);
	let first_log = load(&first).expect("load bounded message");
	let transcript::Entry::Ok(first_event) = first_log.get(0).expect("first event") else {
		panic!("decoded event")
	};
	let persisted = message_text(first_event);
	assert_eq!(xutf::codepoints::<Utf8>(persisted.as_bytes()).count(), MAX_PERSISTED_CHARS);
	assert_eq!(persisted.bytes().filter(|byte| *byte == b'\n').count(), 4);

	let mut replay = Writer::create(&second, &header()).expect("create replay");
	replay.append(first_event).expect("replay bounded event");
	drop(replay);
	let replay_log = load(&second).expect("load replay");
	let transcript::Entry::Ok(replayed) = replay_log.get(0).expect("replayed event") else {
		panic!("decoded replay")
	};
	assert_eq!(message_text(replayed), persisted);
}
