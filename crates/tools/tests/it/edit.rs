//! Exact model-facing contracts for hashline edit execution and projection.

use std::{collections::HashMap, future, path::Path, sync::Arc};

use bytes::Bytes;
use futures::StreamExt;
use omp_core::Str;
use omp_edit::{
	modes::hashline::{
		mismatch::{MismatchDetails, format_mismatch_message},
		patcher::{no_change_diagnostic, no_change_loop_diagnostic},
	},
	store::{Clipboard, EditStore, file_hash, payload_hash},
};
use omp_tool::{
	CapsBase, Diag, DiagKind, Ev, IncomingParams, ModelClass, Part, PromptCaps, Severity, Tool,
	ToolTerminal,
};
use omp_tools::edit::{
	self, CommitResult, CommittedSection, Conflict, EditAction, EditCommitError, EditDocuments,
	EditPrepared, EditProposal, Fault, FormatPolicy, NoopResult, PrepareRequest, RejectionReason,
	apply_patch_tool, legacy_replace_tool_with_observer, observer::EditObserver, patch_tool,
	replace_tool, tool,
};
use parking_lot::Mutex;

#[derive(Default)]
struct State {
	prepared:       Vec<PrepareRequest>,
	edit_store:     EditStore,
	commits:        Vec<EditProposal>,
	commit_batches: Vec<usize>,
}

#[derive(Clone)]
struct Fake {
	files:    Arc<HashMap<Str, Bytes>>,
	authored: Arc<HashMap<Str, Bytes>>,
	state:    Arc<Mutex<State>>,
	fault:    Option<Fault>,
}

impl Fake {
	fn with_files(files: &[(&str, &'static [u8])]) -> Self {
		Self {
			files:    Arc::new(
				files
					.iter()
					.map(|(path, bytes)| (Str::new(*path), Bytes::from_static(bytes)))
					.collect(),
			),
			authored: Arc::default(),
			state:    Arc::default(),
			fault:    None,
		}
	}

	fn with_stale(path: &str, authored: &'static [u8], live: &'static [u8]) -> Self {
		Self {
			files:    Arc::new(
				[(Str::new(path), Bytes::from_static(live))]
					.into_iter()
					.collect(),
			),
			authored: Arc::new(
				[(Str::new(path), Bytes::from_static(authored))]
					.into_iter()
					.collect(),
			),
			state:    Arc::default(),
			fault:    None,
		}
	}
}

struct Lease {
	path:     Str,
	revision: Str,
	base:     Bytes,
	authored: Bytes,
}

impl EditPrepared for Lease {
	fn path(&self) -> &Str {
		&self.path
	}

	fn base_revision(&self) -> &Str {
		&self.revision
	}

	fn base_bytes(&self) -> &Bytes {
		&self.base
	}

	fn authored_bytes(&self) -> &Bytes {
		&self.authored
	}
}

impl EditDocuments for Fake {
	type Prepared = Lease;

	fn prepare(
		&self,
		request: PrepareRequest,
	) -> impl Future<Output = Result<Self::Prepared, Fault>> + Send + '_ {
		self.state.lock().prepared.push(request.clone());
		if let Some(fault) = &self.fault {
			return future::ready(Err(fault.clone()));
		}
		let Some(content) = self.files.get(&request.path).cloned() else {
			return future::ready(Err(Fault {
				reason:    RejectionReason::InvalidPatch { message: "file not found".into() },
				conflicts: Vec::new(),
			}));
		};
		let authored = self
			.authored
			.get(&request.path)
			.cloned()
			.unwrap_or_else(|| content.clone());
		future::ready(Ok(Lease {
			path: request.path,
			revision: "r1".into(),
			base: content,
			authored,
		}))
	}

	fn record_noop(&self, canonical_path: &str, display_path: &str, input: Bytes) -> NoopResult {
		let (count, escalate) = self.state.lock().edit_store.record_noop(
			Path::new(canonical_path),
			payload_hash(std::str::from_utf8(&input).expect("test edit payload is UTF-8")),
		);
		let diagnostic = if escalate {
			no_change_loop_diagnostic(display_path, count)
		} else {
			no_change_diagnostic(display_path)
		};
		NoopResult { diagnostic: diagnostic.into(), escalate }
	}

	fn reset_noop(&self, canonical_path: &str) {
		self
			.state
			.lock()
			.edit_store
			.reset_noop(Path::new(canonical_path));
	}

	fn start_clipboard_batch(&self) -> Clipboard {
		Clipboard::default()
	}

	fn commit<'a>(
		&'a self,
		_prepared: Vec<&'a mut Self::Prepared>,
		proposals: Vec<EditProposal>,
		_clipboard: Clipboard,
	) -> impl Future<Output = Result<CommitResult, EditCommitError>> + Send + 'a {
		let sections = proposals
			.iter()
			.map(|proposal| CommittedSection {
				new_revision:         (!matches!(proposal.action, EditAction::Delete))
					.then(|| "r2".into()),
				rebased:              false,
				content:              match &proposal.action {
					EditAction::Write { content } | EditAction::Move { content, .. } => {
						Some(content.clone())
					},
					EditAction::Delete => None,
				},
				diagnostics:          Vec::new(),
				diagnostics_complete: true,
			})
			.collect();
		let mut state = self.state.lock();
		state.commit_batches.push(proposals.len());
		state.commits.extend(proposals);
		future::ready(Ok(CommitResult { sections }))
	}
}

fn tag(bytes: &[u8]) -> String {
	file_hash(std::str::from_utf8(bytes).expect("test document is UTF-8"))
}

fn caps(tool: &impl Tool) -> PromptCaps {
	PromptCaps::for_tool(
		CapsBase {
			maximum_parts:      1,
			maximum_text_bytes: 16 * 1024,
			media:              false,
			model_class:        ModelClass::Standard,
		},
		&tool.spec().rev,
	)
}

async fn invoke(fake: Fake, input: &str) -> (edit::Payload, Vec<Part>, Vec<Diag>) {
	let edit = tool(fake, FormatPolicy::BestEffort);
	let raw = serde_json::json!({ "input": input }).to_string();
	let (feed, incoming) = IncomingParams::channel();
	feed.arg_text(raw.clone().into()).unwrap();
	feed.args_committed(raw.into()).unwrap();
	let events = edit.call(incoming).collect::<Vec<_>>().await;
	let diags = events
		.iter()
		.filter_map(|event| match event {
			Ev::Diag(diag) => Some(diag.clone()),
			_ => None,
		})
		.collect();
	let payload = events
		.into_iter()
		.find_map(|event| match event {
			Ev::Done(ToolTerminal::Done { result: Ok(payload), .. }) => Some(payload),
			_ => None,
		})
		.expect("successful edit payload");
	let parts = edit.prompt(Ok(&payload), &caps(&edit));
	(payload, parts, diags)
}

fn text(parts: &[Part]) -> &str {
	match parts {
		[Part::Text { text }] => text,
		_ => panic!("expected one text part"),
	}
}

#[test]
fn generated_schema_is_semantically_the_pi_edit_schema() {
	let edit = tool(Fake::with_files(&[]), FormatPolicy::BestEffort);
	let actual: serde_json::Value =
		serde_json::from_slice(&edit.spec().schema).expect("edit schema JSON");
	assert_eq!(
		edit.spec().schema.as_ref(),
		omp_tool::schema::<omp_tools::edit::Params>().as_ref(),
		"tool schema must be generated directly from Params",
	);
	assert_eq!(
		actual,
		serde_json::json!({
			"type": "object",
			"additionalProperties": false,
			"required": ["i", "input"],
			"properties": {
				"input": {"type": "string"},
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
	let replace_schema: serde_json::Value = serde_json::from_slice(
		&replace_tool(Fake::with_files(&[]), FormatPolicy::BestEffort)
			.spec()
			.schema,
	)
	.expect("replace schema");
	assert_eq!(
		replace_schema["required"],
		serde_json::json!(["i", "path", "old_string", "new_string"])
	);
	assert_eq!(
		replace_schema["properties"]
			.as_object()
			.expect("replace properties")
			.keys()
			.map(String::as_str)
			.collect::<std::collections::BTreeSet<_>>(),
		["i", "new_string", "notrunc", "old_string", "path", "replace_all"]
			.into_iter()
			.collect()
	);
	assert_eq!(replace_schema["additionalProperties"], serde_json::Value::Bool(false));

	let patch_schema: serde_json::Value = serde_json::from_slice(
		&patch_tool(Fake::with_files(&[]), FormatPolicy::BestEffort)
			.spec()
			.schema,
	)
	.expect("patch schema");
	assert_eq!(patch_schema["required"], serde_json::json!(["i", "path", "edits"]));
	assert_eq!(
		patch_schema["properties"]
			.as_object()
			.expect("patch properties")
			.keys()
			.map(String::as_str)
			.collect::<std::collections::BTreeSet<_>>(),
		["edits", "i", "notrunc", "path"].into_iter().collect()
	);
	let entry = &patch_schema["properties"]["edits"]["items"];
	assert_eq!(entry["additionalProperties"], false);
	assert_eq!(
		entry["properties"]
			.as_object()
			.expect("entry properties")
			.keys()
			.map(String::as_str)
			.collect::<std::collections::BTreeSet<_>>(),
		["diff", "op", "rename"].into_iter().collect()
	);
	for operation in ["create", "delete", "update"] {
		assert!(
			serde_json::from_value::<omp_tools::edit::PatchOp>(serde_json::Value::String(
				operation.to_owned()
			))
			.is_ok()
		);
	}

	for legacy in [
		serde_json::json!({"path": "a.txt", "patch": "PUT 1.=1:\n+x"}),
		serde_json::json!({"input": "[a.txt#A1B2]", "path": "a.txt"}),
	] {
		assert!(
			serde_json::from_value::<omp_tools::edit::Params>(legacy).is_err(),
			"edit params must reject legacy fields"
		);
	}
}

#[tokio::test]
async fn current_replace_and_patch_routes_apply_the_pi_argument_forms() {
	let replace_fake = Fake::with_files(&[("a.txt", b"alpha\n")]);
	let replace = replace_tool(replace_fake.clone(), FormatPolicy::BestEffort);
	let replace_raw =
		r#"{"path":"a.txt","old_string":"alpha","new_string":"beta","replace_all":false}"#;
	let (replace_feed, replace_incoming) = IncomingParams::channel();
	replace_feed
		.arg_text(replace_raw.into())
		.expect("stream replace");
	replace_feed
		.args_committed(replace_raw.into())
		.expect("commit replace");
	let replace_events = replace.call(replace_incoming).collect::<Vec<_>>().await;
	assert!(matches!(
		replace_events.last(),
		Some(Ev::Done(ToolTerminal::Done { result: Ok(_), .. }))
	));
	assert!(matches!(
		&replace_fake.state.lock().commits[0].action,
		EditAction::Write { content } if content.as_ref() == b"beta\n"
	));

	let patch_fake = Fake::with_files(&[("a.txt", b"alpha\n")]);
	let patch = patch_tool(patch_fake.clone(), FormatPolicy::BestEffort);
	let patch_raw = r#"{"path":"a.txt","edits":[{"op":"update","diff":"@@\n-alpha\n+beta\n"}]}"#;
	let (patch_feed, patch_incoming) = IncomingParams::channel();
	patch_feed.arg_text(patch_raw.into()).expect("stream patch");
	patch_feed
		.args_committed(patch_raw.into())
		.expect("commit patch");
	let patch_events = patch.call(patch_incoming).collect::<Vec<_>>().await;
	assert!(matches!(patch_events.last(), Some(Ev::Done(ToolTerminal::Done { result: Ok(_), .. }))));
	assert!(matches!(
		&patch_fake.state.lock().commits[0].action,
		EditAction::Write { content } if content.as_ref() == b"beta\n"
	));
}

#[tokio::test]
async fn host_edit_policy_overrides_legacy_fuzzy_request_and_requires_seen() {
	let denied_fake = Fake::with_files(&[("a.txt", b"function foo() {}\n")]);
	let denied = legacy_replace_tool_with_observer(
		denied_fake.clone(),
		FormatPolicy::BestEffort,
		EditObserver::default(),
		true,
		false,
		true,
	);
	let raw = r#"{"edits":[{"path":"a.txt","old":"function bar() {}","new":"replaced","allow_fuzzy":true,"threshold":0.7}]}"#;
	let (feed, incoming) = IncomingParams::channel();
	feed.arg_text(raw.into()).expect("stream denied fuzzy call");
	feed
		.args_committed(raw.into())
		.expect("commit denied fuzzy call");
	let denied_events = denied.call(incoming).collect::<Vec<_>>().await;
	assert!(matches!(
		denied_events.last(),
		Some(Ev::Done(ToolTerminal::Done { result: Err(_), .. }))
	));
	assert!(denied_fake.state.lock().commits.is_empty());
	assert!(!denied_fake.state.lock().prepared[0].allow_unpinned);

	let allowed_fake = Fake::with_files(&[("a.txt", b"function foo() {}\n")]);
	let allowed = legacy_replace_tool_with_observer(
		allowed_fake.clone(),
		FormatPolicy::BestEffort,
		EditObserver::default(),
		true,
		true,
		false,
	);
	let (feed, incoming) = IncomingParams::channel();
	feed
		.arg_text(raw.into())
		.expect("stream allowed fuzzy call");
	feed
		.args_committed(raw.into())
		.expect("commit allowed fuzzy call");
	let allowed_events = allowed.call(incoming).collect::<Vec<_>>().await;
	assert!(matches!(
		allowed_events.last(),
		Some(Ev::Done(ToolTerminal::Done { result: Ok(_), .. }))
	));
	assert!(allowed_fake.state.lock().prepared[0].allow_unpinned);
}

#[tokio::test]
async fn committed_unknown_fields_are_rejected_before_edit_effects() {
	let fake = Fake::with_files(&[("a.txt", b"one\n")]);
	let edit = tool(fake.clone(), FormatPolicy::BestEffort);
	let tag = tag(b"one\n");
	let raw = serde_json::json!({
		"input": format!("[a.txt#{tag}]\nPUT 1.=1:\n+two"),
		"path": "legacy.txt"
	})
	.to_string();
	let (feed, incoming) = IncomingParams::channel();
	feed.arg_text(raw.clone().into()).unwrap();
	feed.args_committed(raw.into()).unwrap();
	let events = edit.call(incoming).collect::<Vec<_>>().await;

	assert!(
		events.iter().any(|event| matches!(event, Ev::Args(_))),
		"unknown sibling did not produce an argument issue: {events:?}"
	);
	assert!(fake.state.lock().commits.is_empty());
}

#[tokio::test]
async fn put_and_cut_render_exact_post_edit_headers_and_previews() {
	let fake = Fake::with_files(&[("a.txt", b"one\ntwo\nthree\n"), ("b.txt", b"alpha\nbeta\n")]);
	let a_tag = tag(b"one\ntwo\nthree\n");
	let b_tag = tag(b"alpha\nbeta\n");
	let input = format!("[a.txt#{a_tag}]\nPUT 2.=2:\n+TWO\n[b.txt#{b_tag}]\nCUT 1.=1");
	let (payload, parts, _) = invoke(fake.clone(), &input).await;
	let a_after = b"one\nTWO\nthree\n";
	let b_after = b"beta\n";
	assert_eq!(
		text(&parts),
		format!(
			"[a.txt#{}]\n1:one\n2:TWO\n3:three\n\n[b.txt#{}]\n1:beta",
			tag(a_after),
			tag(b_after)
		)
	);
	assert_eq!(payload.sections.len(), 2);
	let state = fake.state.lock();
	let commits = &state.commits;
	assert!(
		matches!(&commits[0].action, EditAction::Write { content } if content.as_ref() == a_after)
	);
	assert!(
		matches!(&commits[1].action, EditAction::Write { content } if content.as_ref() == b_after)
	);
}

#[tokio::test]
async fn named_cut_register_moves_text_across_sections_in_one_batch() {
	let fake =
		Fake::with_files(&[("source.txt", b"carry\nstay\n"), ("destination.txt", b"before\n")]);
	let source_tag = tag(b"carry\nstay\n");
	let destination_tag = tag(b"before\n");
	let input = format!(
		"[source.txt#{source_tag}]\nCUT 1.=1 @carry\n[destination.txt#{destination_tag}]\nPUT >1 \
		 @carry"
	);
	let _ = invoke(fake.clone(), &input).await;

	let state = fake.state.lock();
	assert_eq!(state.commits.len(), 2);
	assert!(matches!(
		&state.commits[0].action,
		EditAction::Write { content } if content.as_ref() == b"stay\n"
	));
	assert!(matches!(
		&state.commits[1].action,
		EditAction::Write { content } if content.as_ref() == b"before\ncarry\n"
	));
}

#[tokio::test]
async fn rem_and_mv_render_exact_file_operation_text() {
	let fake = Fake::with_files(&[("old.txt", b"one\ntwo\n"), ("gone.txt", b"bye\n")]);
	let old_tag = tag(b"one\ntwo\n");
	let gone_tag = tag(b"bye\n");
	let input = format!("[old.txt#{old_tag}]\nMV new.txt\n[gone.txt#{gone_tag}]\nREM");
	let (_, parts, _) = invoke(fake.clone(), &input).await;
	assert_eq!(
		text(&parts),
		format!("[new.txt#{}]\nMoved to new.txt\n\nDeleted gone.txt", tag(b"one\ntwo\n"))
	);
	let state = fake.state.lock();
	let commits = &state.commits;
	assert!(
		matches!(&commits[0].action, EditAction::Move { destination, content } if destination == "new.txt" && content.as_ref() == b"one\ntwo\n")
	);
	assert!(matches!(&commits[1].action, EditAction::Delete));
}

#[tokio::test]
async fn edits_followed_by_mv_form_one_move_with_final_content() {
	let fake = Fake::with_files(&[("old.txt", b"one\ntwo\n")]);
	let old_tag = tag(b"one\ntwo\n");
	let input = format!("[old.txt#{old_tag}]\nPUT 2.=2:\n+TWO\nMV new.txt");
	let _ = invoke(fake.clone(), &input).await;
	let edited = b"one\nTWO\n";
	let state = fake.state.lock();
	assert_eq!(state.commits.len(), 1);
	assert!(matches!(
		&state.commits[0].action,
		EditAction::Move { destination, content }
			if destination == "new.txt" && content.as_ref() == edited
	));
}

#[tokio::test]
async fn byte_identical_put_escalates_from_exact_soft_diagnostic_to_loop_guard_failure() {
	let fake = Fake::with_files(&[("a.txt", b"same\n")]);
	let tag = tag(b"same\n");
	let input = format!("[a.txt#{tag}]\nPUT 1.=1:\n+same");
	for _ in 0..2 {
		let (_, parts, _) = invoke(fake.clone(), &input).await;
		assert_eq!(
			text(&parts),
			"Edits to a.txt parsed and applied cleanly, but produced no change: your body row(s) are \
			 byte-identical to the file at the targeted lines. The bug is somewhere else — re-read \
			 the file before issuing another edit. Do NOT widen the payload or add lines; verify the \
			 anchor first."
		);
	}

	let edit = tool(fake.clone(), FormatPolicy::BestEffort);
	let raw = serde_json::json!({ "input": input }).to_string();
	let (feed, incoming) = IncomingParams::channel();
	feed.arg_text(raw.clone().into()).unwrap();
	feed.args_committed(raw.into()).unwrap();
	let events = edit.call(incoming).collect::<Vec<_>>().await;
	let fault = events
		.into_iter()
		.find_map(|event| match event {
			Ev::Done(ToolTerminal::Done { result: Err(fault), .. }) => Some(fault),
			_ => None,
		})
		.expect("third identical no-op must fail");
	assert_eq!(
		text(&edit.prompt(Err(&fault), &caps(&edit))),
		"STOP. Edits to a.txt have been a byte-identical no-op 3 times in a row — the patch body \
		 matches the file at the targeted lines and the soft hint did not break the cycle. Cease \
		 re-issuing this payload. Either the intended change is already on disk (move on), or your \
		 anchor is wrong (re-read the file with `read` to observe the current line numbers and tag, \
		 then author a different edit). This exact payload will keep being rejected until it \
		 changes."
	);
	assert!(fake.state.lock().commits.is_empty());
}

#[tokio::test]
async fn stale_tag_and_transaction_conflict_messages_are_projected_verbatim() {
	let mismatch = format_mismatch_message(&MismatchDetails {
		path:               Some("a.txt".into()),
		expected_file_hash: "1A2B".into(),
		actual_file_hash:   "C3D4".into(),
		file_lines:         vec!["one".into(), "two".into(), "three".into()],
		anchor_lines:       vec![2],
		hash_recognized:    true,
	});
	let stale = Fault {
		reason:    RejectionReason::StaleUnrecoverable { message: mismatch.clone().into() },
		conflicts: Vec::new(),
	};
	let edit = tool(Fake::with_files(&[]), FormatPolicy::BestEffort);
	assert_eq!(text(&edit.prompt(Err(&stale), &caps(&edit))), mismatch);

	let conflict = Fault {
		reason:    RejectionReason::Conflict,
		conflicts: vec![Conflict {
			start_line: 4,
			end_line:   6,
			message:    "overlapping concurrent edit".into(),
		}],
	};
	assert_eq!(
		text(&edit.prompt(Err(&conflict), &caps(&edit))),
		"Edit rejected: conflict (1 overlapping range(s))\n4-6: overlapping concurrent edit"
	);
}

#[tokio::test]
async fn malformed_and_headerless_input_never_commit_and_preserve_parser_diagnostics() {
	let fake = Fake::with_files(&[("a.txt", b"one\n")]);
	let edit = tool(fake.clone(), FormatPolicy::BestEffort);
	for (input, expected) in [
		("", "No hashline sections found in input."),
		(
			"@@ -1,1 +1,1 @@\n-old\n+new",
			"unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. File sections \
			 start with `[path#HASH]`; use `replace`, `delete`, or `insert` ops.",
		),
		(
			"[a.txt#1A2B]\nPUT 1.=:\n+x",
			"line 1: payload line has no preceding hunk header. Use `PUT N.=M:`, `CUT N.=M`, or `PUT \
			 <N:`/`PUT >N:` above the body. Got \"PUT 1.=:\".",
		),
		(
			"[a.txt#1A2B]\nPUT 1.=2:\n+X\nPUT 2.=3:\n+Y",
			"line 3: anchor line 2 is already targeted by another hunk on line 1. Issue ONE hunk per \
			 range; payload is only the final desired content, never a before/after pair.",
		),
	] {
		let raw = serde_json::json!({ "input": input }).to_string();
		let (feed, incoming) = IncomingParams::channel();
		feed.arg_text(raw.clone().into()).unwrap();
		feed.args_committed(raw.into()).unwrap();
		let events = edit.call(incoming).collect::<Vec<_>>().await;
		let rendered = events
			.iter()
			.find_map(|event| match event {
				Ev::Done(ToolTerminal::Done { result: Err(fault), .. }) => {
					Some(text(&edit.prompt(Err(fault), &caps(&edit))).to_owned())
				},
				Ev::Args(issue) => issue.found.as_deref().map(str::to_owned),
				_ => None,
			})
			.unwrap_or_else(|| panic!("diagnostic event for {input:?}: {events:?}"));
		assert_eq!(rendered, expected);
	}
	assert!(fake.state.lock().commits.is_empty());
}

#[tokio::test]
async fn apply_patch_commits_every_file_in_one_document_transaction() {
	let fake = Fake::with_files(&[("a.txt", b"one\n"), ("b.txt", b"two\n")]);
	let edit = apply_patch_tool(fake.clone(), FormatPolicy::BestEffort);
	let input = "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+ONE\n*** Update File: \
	             b.txt\n@@\n-two\n+TWO\n*** End Patch\n";
	let raw = serde_json::json!({ "input": input }).to_string();
	let (feed, incoming) = IncomingParams::channel();
	feed.arg_text(raw.clone().into()).unwrap();
	feed.args_committed(raw.into()).unwrap();
	let events = edit.call(incoming).collect::<Vec<_>>().await;
	assert!(matches!(events.last(), Some(Ev::Done(ToolTerminal::Done { result: Ok(_), .. }))));
	let state = fake.state.lock();
	assert_eq!(state.commit_batches, [2]);
	assert_eq!(state.commits.len(), 2);
}

#[tokio::test]
async fn stale_recovery_rejects_a_changed_authored_duplicate_line() {
	let authored = b"same\nsame\nsame\nsame\n";
	let live = b"same\nsame\nchanged\nsame\n";
	let fake = Fake::with_stale("a.txt", authored, live);
	let edit = tool(fake.clone(), FormatPolicy::BestEffort);
	let input = format!("[a.txt#{}]\nCUT 3.=3", tag(authored));
	let raw = serde_json::json!({ "input": input }).to_string();
	let (feed, incoming) = IncomingParams::channel();
	feed.arg_text(raw.clone().into()).unwrap();
	feed.args_committed(raw.into()).unwrap();
	let events = edit.call(incoming).collect::<Vec<_>>().await;
	assert!(matches!(
		events.last(),
		Some(Ev::Done(ToolTerminal::Done {
			result: Err(Fault { reason: RejectionReason::StaleUnrecoverable { .. }, .. }),
			..
		}))
	));
	assert!(fake.state.lock().commits.is_empty());
}

#[tokio::test]
async fn stale_head_insert_applies_to_live_bytes_and_emits_drift_diag() {
	let authored = b"old first\nbody\n";
	let live = b"new first\nbody\n";
	let fake = Fake::with_stale("a.txt", authored, live);
	let input = format!("[a.txt#{}]\nPUT <1:\n+prefix", tag(authored));
	let (_, _, diags) = invoke(fake.clone(), &input).await;
	assert!(diags.iter().any(|diag| {
		diag.native_kind() == Some(DiagKind::AnchorDrift) && diag.severity == Severity::Warn
	}));
	let state = fake.state.lock();
	assert!(matches!(
		&state.commits[0].action,
		EditAction::Write { content } if content.as_ref() == b"prefix\nnew first\nbody\n"
	));
}

#[tokio::test]
async fn copied_read_elision_is_ignored_and_emits_an_advisory_diag() {
	let fake = Fake::with_files(&[("a.txt", b"one\ntwo\n")]);
	let tag = tag(b"one\ntwo\n");
	let input = format!(
		"[a.txt#{tag}]\n[…8ln elided; re-read needed ranges with |, e.g. a.txt:10-17]\nPUT \
		 1.=1:\n+ONE"
	);
	let (_, parts, diags) = invoke(fake, &input).await;
	let output = text(&parts);
	assert!(!output.contains("Warnings:"), "{output:?}");
	assert!(diags.iter().any(|diag| {
		diag.native_kind() == Some(DiagKind::Advisory) && diag.severity == Severity::Warn
	}));
}
