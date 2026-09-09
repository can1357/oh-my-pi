//! Foreign transcript import contracts for native journals.

use std::fs;

use omp_app::session_import::{ForeignFormat, import_file};
use omp_journal::{Journal, abandoned};
use omp_session::{ComponentRegistry, Session};

#[test]
fn claude_fixture_imports_to_native_journal() {
	let directory = tempfile::tempdir().expect("tempdir");
	let source = directory.path().join("claude.jsonl");
	let destination = directory.path().join("claude.oms");
	fs::write(
		&source,
		r#"{"type":"user","message":{"role":"user","content":"hello"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"world"}]}}
"#,
	)
	.expect("fixture");
	assert_eq!(import_file(ForeignFormat::Claude, &source, &destination).expect("import"), 2);
	let session = Session::open(&destination, ComponentRegistry::standard()).expect("open");
	assert_eq!(omp_app::print_mode::transcript_text(session.dom()), "world\n");
}

#[test]
fn codex_fixture_imports_to_native_journal() {
	let directory = tempfile::tempdir().expect("tempdir");
	let source = directory.path().join("codex.jsonl");
	let destination = directory.path().join("codex.oms");
	fs::write(
		&source,
		r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"ping"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}}
"#,
	)
	.expect("fixture");
	assert_eq!(import_file(ForeignFormat::Codex, &source, &destination).expect("import"), 2);
	let session = Session::open(&destination, ComponentRegistry::standard()).expect("open");
	assert_eq!(omp_app::print_mode::transcript_text(session.dom()), "pong\n");
}

#[test]
fn claude_import_preserves_blocks_tools_media_usage_errors_and_source_bytes() {
	let directory = tempfile::tempdir().expect("tempdir");
	let source = directory.path().join("claude-rich.jsonl");
	let destination = directory.path().join("claude-rich.oms");
	let fixture = concat!(
		"{\"type\":\"user\",\"uuid\":\"u1\",\"parentUuid\":null,\"timestamp\":\"2026-01-01T00:00:\
		 00Z\",\"cwd\":\"/project\",\"sessionId\":\"session-1\",\"message\":{\"content\":[{\"type\":\
		 \"text\",\"text\":\"look\"},{\"type\":\"image\",\"source\":{\"media_type\":\"image/png\",\"\
		 data\":\"aW1hZ2U=\"}}]}}\n",
		"{not-json\n",
		"{\"type\":\"assistant\",\"uuid\":\"a1\",\"parentUuid\":\"u1\",\"timestamp\":\"\
		 2026-01-01T00:00:01Z\",\"error\":\"provider \
		 warning\",\"apiErrorStatus\":529,\"message\":{\"id\":\"msg-1\",\"model\":\"\
		 claude-sonnet-4-5\",\"stop_reason\":\"tool_use\",\"usage\":{\"input_tokens\":10,\"\
		 output_tokens\":5,\"cache_read_input_tokens\":3,\"cache_creation_input_tokens\":2},\"\
		 content\":[{\"type\":\"thinking\",\"thinking\":\"inspect\",\"signature\":\"signed\"},{\"\
		 type\":\"text\",\"text\":\"working\"},{\"type\":\"tool_use\",\"id\":\"call-1\",\"name\":\"\
		 read\",\"input\":{\"path\":\"a.rs\"}}]}}\n",
		"{\"type\":\"user\",\"uuid\":\"r1\",\"parentUuid\":\"a1\",\"timestamp\":\"2026-01-01T00:00:\
		 02Z\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"call-1\",\"\
		 content\":[{\"type\":\"text\",\"text\":\"contents\"},{\"type\":\"image\",\"source\":{\"\
		 media_type\":\"image/png\",\"data\":\"cmVzdWx0\"}}],\"is_error\":false}]}}\n",
		"{\"type\":\"custom-title\",\"customTitle\":\"Imported title\"}\n",
	);
	fs::write(&source, fixture).expect("fixture");

	assert_eq!(import_file(ForeignFormat::Claude, &source, &destination).expect("import"), 3);
	let journal_text = fs::read_to_string(&destination).expect("journal");
	assert!(journal_text.contains("tool.call@1"));
	assert!(journal_text.contains("tool.result@1"));
	assert!(journal_text.contains("thinking-signature"));
	assert!(journal_text.contains("signed"));
	assert!(journal_text.contains("source-timestamp-ms"));
	assert!(journal_text.contains("cache_read"));
	assert!(journal_text.contains("image/png"));
	assert!(journal_text.contains("malformed_rows"));
	assert!(journal_text.contains("provider warning"));
	assert!(journal_text.contains("Imported title"));

	let session = Session::open(&destination, ComponentRegistry::standard()).expect("open");
	let rendered = omp_app::print_mode::transcript_text(session.dom());
	assert!(rendered.contains("working"));
}

#[test]
fn claude_parent_links_become_native_abandoned_branches() {
	let directory = tempfile::tempdir().expect("tempdir");
	let source = directory.path().join("claude-branch.jsonl");
	let destination = directory.path().join("claude-branch.oms");
	fs::write(
		&source,
		r#"{"type":"user","uuid":"root","parentUuid":null,"message":{"content":"root"}}
{"type":"assistant","uuid":"old","parentUuid":"root","message":{"content":[{"type":"text","text":"abandoned"}]}}
{"type":"assistant","uuid":"live","parentUuid":"root","message":{"content":[{"type":"text","text":"selected"}]}}
"#,
	)
	.expect("fixture");

	import_file(ForeignFormat::Claude, &source, &destination).expect("import");
	let session = Session::open(&destination, ComponentRegistry::standard()).expect("open");
	assert_eq!(omp_app::print_mode::transcript_text(session.dom()), "selected\n");
	drop(session);
	let (_journal, entries) = Journal::open(&destination).expect("journal");
	assert!(abandoned(&entries).any(|entry| entry.data.contains("abandoned")));
	assert!(
		fs::read_to_string(&destination)
			.expect("journal")
			.contains("prior:")
	);
}

#[test]
fn codex_import_preserves_reasoning_tools_failures_roles_usage_and_rollback() {
	let directory = tempfile::tempdir().expect("tempdir");
	let source = directory.path().join("codex-rich.jsonl");
	let destination = directory.path().join("codex-rich.oms");
	fs::write(
		&source,
		r#"{"type":"session_meta","timestamp":"2026-02-01T00:00:00Z","payload":{"id":"codex-1","cwd":"/project","title":"Codex title"}}
truncated {
{"type":"turn_context","timestamp":"2026-02-01T00:00:01Z","payload":{"model":"gpt-5.3-codex"}}
{"type":"response_item","timestamp":"2026-02-01T00:00:02Z","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"policy"}]}}
{"type":"response_item","timestamp":"2026-02-01T00:00:03Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"inspect"},{"type":"input_image","image_url":"data:image/png;base64,aW1hZ2U="}]}}
{"type":"response_item","timestamp":"2026-02-01T00:00:04Z","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"plan"}]}}
{"type":"response_item","timestamp":"2026-02-01T00:00:05Z","payload":{"type":"function_call","call_id":"call-1","name":"read","arguments":"{\"path\":\"a.rs\"}"}}
{"type":"response_item","timestamp":"2026-02-01T00:00:06Z","payload":{"type":"function_call_output","call_id":"call-1","output":"failed","status":"failed"}}
{"type":"event_msg","timestamp":"2026-02-01T00:00:07Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":12,"cached_input_tokens":4,"output_tokens":7}}}}
{"type":"response_item","timestamp":"2026-02-01T00:00:08Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"old answer"}]}}
{"type":"event_msg","timestamp":"2026-02-01T00:00:09Z","payload":{"type":"thread_rolled_back","num_turns":1}}
{"type":"response_item","timestamp":"2026-02-01T00:00:10Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"new branch"}]}}
{"type":"response_item","timestamp":"2026-02-01T00:00:11Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"new answer"}]}}
"#,
	)
	.expect("fixture");

	import_file(ForeignFormat::Codex, &source, &destination).expect("import");
	let journal_text = fs::read_to_string(&destination).expect("journal");
	assert!(journal_text.contains("developer"));
	assert!(journal_text.contains("tool.call@1"));
	assert!(journal_text.contains("tool.result@1"));
	assert!(journal_text.contains("\"fault\""));
	assert!(journal_text.contains("tokens_in"));
	assert!(journal_text.contains("source-timestamp"));
	assert!(journal_text.contains("malformed_rows"));
	assert!(journal_text.contains("foreign-rollback"));
	assert!(journal_text.contains("prior:"));

	let session = Session::open(&destination, ComponentRegistry::standard()).expect("open");
	assert_eq!(omp_app::print_mode::transcript_text(session.dom()), "new answer\n");
	drop(session);
	let (_journal, entries) = Journal::open(&destination).expect("journal");
	assert!(abandoned(&entries).any(|entry| entry.data.contains("old answer")));
}
