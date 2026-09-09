//! `write@2` schema, guards, transactions, and exact output contracts.

use std::{future, future::Future, sync::Arc, time::Duration};

use futures::{StreamExt, executor::block_on};
use omp_core::{Str, sf};
use omp_tool::{
	Abort, CapsBase, Diag, DiagKind, Ev, IncomingParams, Interrupt, ModelClass, Part, PromptCaps,
	Severity, Tool, ToolTerminal,
};
use omp_tools::{
	read::selector::LiteralPathProbe,
	write::{
		self, Fault, PlainWriteRequest, PlainWriteResult, SpecialWriteControl, WriteCommitError,
		WriteDisposition, WriteDocuments, WriteOperation, backends,
	},
};
use parking_lot::Mutex;
use serde_json::json;
use tokio::time;

#[derive(Clone)]
struct FakeDocuments {
	probe:    LiteralPathProbe,
	result:   Result<PlainWriteResult, WriteCommitError>,
	probed:   Arc<Mutex<Vec<Str>>>,
	requests: Arc<Mutex<Vec<PlainWriteRequest>>>,
}

impl FakeDocuments {
	fn success(probe: LiteralPathProbe, result: PlainWriteResult) -> Self {
		Self { probe, result: Ok(result), probed: Arc::default(), requests: Arc::default() }
	}
}

impl WriteDocuments for FakeDocuments {
	fn probe_literal(
		&self,
		path: Str,
	) -> impl Future<Output = Result<LiteralPathProbe, Fault>> + Send + '_ {
		let probe = self.probe;
		let probed = Arc::clone(&self.probed);
		async move {
			probed.lock().push(path);
			Ok(probe)
		}
	}

	fn write_plain(
		&self,
		request: PlainWriteRequest,
	) -> impl Future<Output = Result<PlainWriteResult, WriteCommitError>> + Send + '_ {
		let result = self.result.clone();
		let requests = Arc::clone(&self.requests);
		async move {
			requests.lock().push(request);
			result
		}
	}
}
#[derive(Clone, Copy)]
enum StalledPhase {
	BeforeEffects,
	AfterEffects,
}

#[derive(Clone)]
struct StalledSpecialDocuments {
	phase:   StalledPhase,
	started: flume::Sender<()>,
}

impl WriteDocuments for StalledSpecialDocuments {
	fn probe_literal(
		&self,
		_path: Str,
	) -> impl Future<Output = Result<LiteralPathProbe, Fault>> + Send + '_ {
		future::ready(Ok(LiteralPathProbe::Unknown))
	}

	fn write_plain(
		&self,
		_request: PlainWriteRequest,
	) -> impl Future<Output = Result<PlainWriteResult, WriteCommitError>> + Send + '_ {
		future::ready(Err(WriteCommitError::Rejected(Fault::Document {
			message: "plain write unexpectedly reached".into(),
		})))
	}

	fn write_archive_member(
		&self,
		_display_path: Str,
		_content: bytes::Bytes,
		control: SpecialWriteControl,
	) -> impl Future<Output = Result<Option<backends::ResultPayload>, backends::Fault>> + Send + '_
	{
		let phase = self.phase;
		let started = self.started.clone();
		async move {
			if matches!(phase, StalledPhase::AfterEffects) {
				assert!(control.begin_effects());
			}
			started.send(()).expect("test observes special write phase");
			future::pending().await
		}
	}
}

struct Invocation {
	result:  Result<write::Payload, Fault>,
	useless: bool,
	text:    String,
	diags:   Vec<Diag>,
}

fn committed(
	disposition: WriteDisposition,
	byte_len: u64,
	made_executable: bool,
	snapshot_tag: Option<&'static str>,
) -> PlainWriteResult {
	PlainWriteResult {
		resolved_path: "/workspace/out.txt".into(),
		display_path: "out.txt".into(),
		byte_len,
		disposition,
		made_executable,
		snapshot_tag: snapshot_tag.map(Str::new_static),
	}
}

fn invoke(documents: FakeDocuments, raw: &str) -> Invocation {
	let tool = write::tool(documents);
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(Str::new(raw))
		.expect("invocation consumer remains live");
	let events = block_on(tool.call(params).collect::<Vec<_>>());
	let Some((terminal, preceding)) = events.split_last() else {
		panic!("expected a terminal write outcome");
	};
	let diags = preceding
		.iter()
		.map(|event| match event {
			Ev::Diag(diag) => diag.clone(),
			_ => panic!("expected diagnostics before terminal write outcome: {events:?}"),
		})
		.collect();
	let Ev::Done(ToolTerminal::Done { result, useless }) = terminal else {
		panic!("expected terminal write outcome last: {events:?}");
	};
	let parts = tool.prompt(
		result.as_ref(),
		&PromptCaps::for_tool(
			CapsBase {
				maximum_parts:      1,
				maximum_text_bytes: 64 * 1024,
				media:              false,
				model_class:        ModelClass::Standard,
			},
			&tool.spec().rev,
		),
	);
	let text = parts
		.into_iter()
		.map(|part| match part {
			Part::Text { text } => text.to_string(),
			Part::Json { .. } => panic!("write must project text only"),
			Part::Blob { .. } => panic!("write must never project blobs"),
		})
		.collect();
	Invocation { result: result.clone(), useless: *useless, text, diags }
}

#[test]
fn generated_schema_definition_and_revision_are_exact() {
	let documents = FakeDocuments::success(
		LiteralPathProbe::Missing,
		committed(WriteDisposition::Created, 0, false, Some("0000")),
	);
	let tool = write::tool(documents);
	assert_eq!(tool.spec().name, "write");
	assert_eq!(tool.spec().rev.to_string(), "2");
	assert_eq!(
		tool.spec().schema.as_ref(),
		omp_tool::schema::<write::Params>().as_ref(),
		"tool schema must be generated directly from Params",
	);
	assert_eq!(
		serde_json::from_slice::<serde_json::Value>(&tool.spec().schema).expect("write schema JSON"),
		json!({
			"type": "object",
			"additionalProperties": false,
			"required": ["i", "path", "content"],
			"properties": {
				"path": {"type": "string", "description": "file path"},
				"content": {"type": "string", "description": "file content"},
				"i": {
					"type": "string",
					"description": "Short present-participle intent for this call."
				},
				"notrunc": {
					"type": "boolean",
					"description": "Prefer complete output inline up to the host security ceiling; overflow or transport backpressure remains available through its artifact."
				}
			}
		})
	);
	assert!(
		serde_json::from_value::<write::Params>(
			json!({"path": "out.txt", "content": "text", "extra": true})
		)
		.is_err(),
		"write params must reject unknown fields"
	);
	assert_eq!(
		tool.spec().description.as_str(),
		"Creates or overwrites file at specified path.\n\n<conditions>\n- Creating new files \
		 explicitly required by task\n- Replacing entire file contents when editing would be more \
		 complex\n- Supports `.zip` (and ZIP-based `.jar`/`.war`/`.ear`/`.apk`), `.tar`, \
		 `.tar.gz`/`.tgz`, and `.tar.zst` archive entries via `archive.ext:path/inside/archive`; \
		 other archive formats (including `.asar`) are read-only\n- Supports SQLite row operations \
		 via `db.sqlite:table` (insert), `db.sqlite:table:key` (update with JSON content, delete \
		 with empty content)\n- Supports whole-file writes to configured or Obsidian-discovered \
		 `vault://<name>/path` resources; Obsidian operations use `?op=create[&overwrite]`, \
		 `?op=move&to=<path>`, `?op=delete[&permanent]`, or `?op=open[&newtab]` (the latter three \
		 require empty content); partial selectors remain read-only\n- Supports registered \
		 merge-conflict splices via `conflict://<id>` and \
		 `@ours`/`@base`/`@theirs`/`@both`\n</conditions>\n\n<critical>\n- You SHOULD use Edit tool \
		 for modifying existing files\n- You NEVER create documentation files (*.md, README) unless \
		 explicitly requested\n- You NEVER use emojis unless requested\n</critical>"
	);
}

#[test]
fn create_records_exact_request_payload_and_hashline_output() {
	let documents = FakeDocuments::success(
		LiteralPathProbe::Missing,
		committed(WriteDisposition::Created, 6, false, Some("A1B2")),
	);
	let requests = Arc::clone(&documents.requests);
	let invocation = invoke(documents, r#"{"path":"out.txt","content":"hello\n"}"#);
	assert_eq!(invocation.text, "[out.txt#A1B2]\nSuccessfully wrote 6 bytes to out.txt");
	assert!(!invocation.useless);
	let payload = invocation.result.expect("write succeeds");
	assert_eq!(payload.resolved_path, "/workspace/out.txt");
	assert_eq!(payload.display_path, "out.txt");
	assert_eq!(payload.byte_len, 6);
	assert_eq!(payload.reported_len, 6);
	assert_eq!(payload.disposition, WriteDisposition::Created);
	assert_eq!(payload.operation, WriteOperation::Plain);
	assert_eq!(payload.snapshot_tag.as_deref(), Some("A1B2"));
	assert!(!payload.stripped_wrapper);
	assert!(!payload.made_executable);
	assert_eq!(requests.lock().as_slice(), [PlainWriteRequest {
		path:            "out.txt".into(),
		content:         "hello\n".into(),
		format_policy:   omp_tools::edit::FormatPolicy::BestEffort,
		guard_generated: true,
	}]);
}

#[test]
fn overwrite_has_the_same_pi_success_line_and_retains_disposition_truth() {
	let documents = FakeDocuments::success(
		LiteralPathProbe::Exists,
		committed(WriteDisposition::Overwrote, 3, false, None),
	);
	let invocation = invoke(documents, r#"{"path":"out.txt","content":"new"}"#);
	assert_eq!(invocation.text, "Successfully wrote 3 bytes to out.txt");
	assert_eq!(
		invocation.result.expect("overwrite succeeds").disposition,
		WriteDisposition::Overwrote
	);
}

#[test]
fn success_count_matches_javascript_utf16_length_while_payload_keeps_utf8_bytes() {
	let documents = FakeDocuments::success(
		LiteralPathProbe::Missing,
		committed(WriteDisposition::Created, 6, false, None),
	);
	let invocation = invoke(documents, r#"{"path":"out.txt","content":"é😀"}"#);
	assert_eq!(invocation.text, "Successfully wrote 3 bytes to out.txt");
	let payload = invocation.result.expect("Unicode write succeeds");
	assert_eq!(payload.byte_len, 6);
	assert_eq!(payload.reported_len, 3);
}

#[test]
fn copied_hashline_display_emits_content_normalized_diag() {
	let documents = FakeDocuments::success(
		LiteralPathProbe::Missing,
		committed(WriteDisposition::Created, 13, false, Some("BEEF")),
	);
	let requests = Arc::clone(&documents.requests);
	let invocation = invoke(
		documents,
		r#"{"path":"[out.txt#1234]","content":"[source.txt#ABCD]\n1:first\n2:second\n"}"#,
	);
	assert_eq!(invocation.text, "[out.txt#BEEF]\nSuccessfully wrote 13 bytes to out.txt");
	assert_eq!(invocation.diags.len(), 1);
	assert_eq!(invocation.diags[0].native_kind(), Some(DiagKind::ContentNormalized));
	assert_eq!(invocation.diags[0].severity, Severity::Info);
	assert_eq!(invocation.diags[0].continuation, None);
	assert_eq!(invocation.diags[0].artifact, None);
	assert_eq!(invocation.diags[0].omitted, None);
	assert!(
		invocation
			.result
			.expect("stripped write succeeds")
			.stripped_wrapper
	);
	assert_eq!(requests.lock().as_slice(), [PlainWriteRequest {
		path:            "out.txt".into(),
		content:         "first\nsecond\n".into(),
		format_policy:   omp_tools::edit::FormatPolicy::BestEffort,
		guard_generated: true,
	}]);
}

#[test]
fn shebang_execute_bits_emit_made_executable_diag() {
	let documents = FakeDocuments::success(
		LiteralPathProbe::Missing,
		committed(WriteDisposition::Created, 18, true, Some("C0DE")),
	);
	let invocation = invoke(documents, r##"{"path":"out.txt","content":"#!/bin/sh\necho hi\n"}"##);
	assert_eq!(invocation.text, "[out.txt#C0DE]\nSuccessfully wrote 18 bytes to out.txt");
	assert_eq!(invocation.diags.len(), 1);
	assert_eq!(invocation.diags[0].native_kind(), Some(DiagKind::MadeExecutable));
	assert_eq!(invocation.diags[0].severity, Severity::Info);
	assert_eq!(invocation.diags[0].continuation, None);
	assert_eq!(invocation.diags[0].artifact, None);
	assert_eq!(invocation.diags[0].omitted, None);
	assert!(
		invocation
			.result
			.expect("shebang write succeeds")
			.made_executable
	);
}

#[test]
fn missing_empty_selector_target_fails_closed_with_exact_read_guidance() {
	let documents = FakeDocuments::success(
		LiteralPathProbe::Missing,
		committed(WriteDisposition::Created, 0, false, None),
	);
	let requests = Arc::clone(&documents.requests);
	let target = "src/LoraSelector.tsx:1-260:raw";
	let invocation = invoke(documents, r#"{"path":"src/LoraSelector.tsx:1-260:raw","content":""}"#);
	assert_eq!(
		invocation.text,
		format!(
			"write target '{target}' ends with a read-tool selector ':1-260:raw' and no such file \
			 exists — refusing to create a literal file by that name. If you meant to read it, use \
			 read({{ path: \"{target}\" }}). If you truly intend to create this file, pass its \
			 contents in `content` (a non-empty write is never blocked)."
		)
	);
	assert!(invocation.result.is_err());
	assert!(requests.lock().is_empty());
}

#[test]
fn selector_list_fails_closed_even_with_nonempty_content() {
	let documents = FakeDocuments::success(
		LiteralPathProbe::Missing,
		committed(WriteDisposition::Created, 0, false, None),
	);
	let requests = Arc::clone(&documents.requests);
	let target = "a.txt:1-2;b/c.txt:3-4";
	let invocation = invoke(documents, r#"{"path":"a.txt:1-2;b/c.txt:3-4","content":"{}"}"#);
	assert_eq!(
		invocation.text,
		format!(
			"write target '{target}' is a semicolon-joined list of 2 read-tool selectors, not a \
			 filesystem path — refusing to create it. write creates a single file; issue one read() \
			 per path to read these ranges (e.g. read({{ path: \"<one path>:<range>\" }}))."
		)
	);
	assert!(requests.lock().is_empty());
}

#[test]
fn existing_ambiguous_and_nonempty_selector_shaped_names_remain_writable() {
	for (probe, content) in [
		(LiteralPathProbe::Exists, ""),
		(LiteralPathProbe::Unknown, ""),
		(LiteralPathProbe::Missing, "intentional"),
	] {
		let result = committed(
			if probe == LiteralPathProbe::Exists {
				WriteDisposition::Overwrote
			} else {
				WriteDisposition::Created
			},
			content.len() as u64,
			false,
			None,
		);
		let documents = FakeDocuments::success(probe, result);
		let requests = Arc::clone(&documents.requests);
		let raw = serde_json::to_string(&json!({"path":"log:1-5", "content":content})).unwrap();
		let invocation = invoke(documents, &raw);
		assert!(invocation.result.is_ok());
		assert_eq!(requests.lock().len(), 1);
	}
}

#[test]
fn unsupported_uri_is_rejected_before_any_document_probe() {
	let documents = FakeDocuments::success(
		LiteralPathProbe::Missing,
		committed(WriteDisposition::Created, 0, false, None),
	);
	let probed = Arc::clone(&documents.probed);
	let requests = Arc::clone(&documents.requests);
	let invocation = invoke(documents, r#"{"path":"skill://private","content":"secret"}"#);
	assert_eq!(invocation.text, "skill:// targets are not supported yet");
	assert!(invocation.result.is_err());
	assert!(probed.lock().is_empty());
	assert!(requests.lock().is_empty());
}

#[test]
fn uri_like_device_target_is_rejected_with_dyn_builtin_guidance() {
	let target = "device:/custom_tool";
	let documents = FakeDocuments::success(
		LiteralPathProbe::Missing,
		committed(WriteDisposition::Created, 0, false, None),
	);
	let probed = Arc::clone(&documents.probed);
	let requests = Arc::clone(&documents.requests);
	let raw = serde_json::to_string(&json!({
		"path": target,
		"content": "payload"
	}))
	.unwrap();
	let invocation = invoke(documents, &raw);

	assert!(invocation.result.is_err());
	assert!(probed.lock().is_empty());
	assert!(requests.lock().is_empty());

	let text = &invocation.text;
	assert!(text.starts_with("Unknown URI-like write target 'device:/custom_tool'."));
	assert!(text.contains("`dyn` runs in the bash tool"));
	assert!(text.contains("`dyn` lists devices"));
	assert!(text.contains("`dyn custom_tool --help` shows usage"));
	assert!(text.contains("`dyn custom_tool [args…]` invokes"));
}

async fn interrupt_stalled_special_write(
	phase: StalledPhase,
) -> Vec<Ev<write::Update, write::Payload, Fault>> {
	let (started, observed) = flume::bounded(1);
	let tool = write::tool(StalledSpecialDocuments { phase, started });
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(sf!(r#"{{"path":"fixture.zip:member.txt","content":"replacement"}}"#,))
		.expect("write invocation remains live");
	let events = tool.call(params).collect::<Vec<_>>();
	tokio::pin!(events);
	tokio::select! {
		result = &mut events => panic!("stalled special write completed unexpectedly: {result:?}"),
		started = observed.recv_async() => started.expect("special write reports its phase"),
	}
	feed
		.interrupt(Interrupt { class: sf!("immediate"), reason: sf!("stop special write") })
		.expect("write invocation accepts interruption");
	time::timeout(Duration::from_secs(1), &mut events)
		.await
		.expect("special write interruption remains responsive")
}

#[tokio::test(flavor = "current_thread")]
async fn pre_effect_special_write_interruption_is_clean() {
	let events = interrupt_stalled_special_write(StalledPhase::BeforeEffects).await;
	assert!(
		matches!(
			events.as_slice(),
			[Ev::Aborted(Abort::Interrupted { reason })] if reason == "stop special write"
		),
		"pre-effect interruption truth changed: {events:?}"
	);
}

#[tokio::test(flavor = "current_thread")]
async fn post_start_special_write_interruption_is_effects_unknown() {
	let events = interrupt_stalled_special_write(StalledPhase::AfterEffects).await;
	assert!(
		matches!(
			events.as_slice(),
			[Ev::Aborted(Abort::EffectsUnknown { reason })] if reason == "stop special write"
		),
		"post-start interruption truth changed: {events:?}"
	);
}
