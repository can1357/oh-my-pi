//! Session-level contracts: streamed previews converge on the applied diff,
//! multi-file payloads stage atomically, and apply never trusts preview reads.

mod common;

use common::{DiskWriter, Workspace};
use pi_edit::{ApplyRequest, EditError, EditMode, FileOp, UrlResolution, session::PreviewBatch};

const SOURCE: &str = "fn main() {\n    let x = 1;\n    println!(\"{x}\");\n}\n";

fn sloppy_payload(path: &str) -> String {
	format!("*** Edit File: {path}\n*** Find\n    let x = 1;\n*** Replace\n    let x = 2;\n")
}

#[tokio::test]
async fn streamed_sloppy_previews_grow_and_match_apply() {
	let ws = Workspace::new(EditMode::Sloppy);
	ws.write("a.rs", SOURCE);
	let payload = sloppy_payload("a.rs");
	let json = serde_json::json!({ "input": payload }).to_string();

	let mut session = ws.session();
	let mut batches: Vec<PreviewBatch> = Vec::new();
	for ch in json.chars() {
		session.push(&ch.to_string());
		let batch = session.preview();
		assert!(batch.streaming);
		assert!(
			batch.files.iter().all(|f| f.error.is_none()),
			"no transient errors while streaming: {batch:?}"
		);
		if !batch.files.is_empty() {
			batches.push(batch);
		}
	}
	assert!(!batches.is_empty(), "streaming produced previews");
	let last = batches.last().unwrap();
	let streamed = last.files[0].diff.as_deref().unwrap_or("");
	assert!(streamed.contains("+2|    let x = 2;"), "streamed diff shows the addition: {streamed}");

	session.finish();
	let final_batch = session.preview();
	assert!(!final_batch.streaming);
	let final_diff = final_batch.files[0].diff.clone().expect("final diff");
	assert!(!session.preview_pending());

	let writer = DiskWriter::default();
	let outcome = session
		.apply(ApplyRequest::default(), &writer)
		.await
		.expect("apply");
	assert_eq!(outcome.files.len(), 1);
	assert_eq!(outcome.files[0].diff, final_diff);
	assert_eq!(ws.read("a.rs").unwrap(), SOURCE.replace("let x = 1;", "let x = 2;"));
}

#[tokio::test]
async fn multi_file_failure_stages_nothing() {
	let ws = Workspace::new(EditMode::Sloppy);
	ws.write("a.rs", SOURCE);
	ws.write("b.rs", "fn other() {}\n");
	let input = format!(
		"{}*** Edit File: b.rs\n*** Find\nfn missing() {{}}\n*** Replace\nfn present() {{}}\n",
		sloppy_payload("a.rs")
	);
	let writer = DiskWriter::default();
	let err = ws
		.apply_json(&serde_json::json!({ "input": input }), &writer)
		.await
		.expect_err("second section fails");
	let message = err.to_string();
	assert!(message.starts_with("[b.rs]: "), "{message}");
	assert!(message.ends_with("No files were modified — sections apply atomically."), "{message}");
	assert_eq!(writer.requests.lock().len(), 0);
	assert_eq!(ws.read("a.rs").unwrap(), SOURCE);
}

#[tokio::test]
async fn apply_rereads_files_changed_after_preview() {
	let ws = Workspace::new(EditMode::Replace);
	ws.write("a.txt", "alpha\nbeta\ngamma\n");
	let mut session = ws.session();
	session.set_args_json(
		&serde_json::json!({ "path": "a.txt", "old_string": "beta", "new_string": "BETA" })
			.to_string(),
	);
	let preview = session.preview();
	assert!(
		preview.files[0]
			.diff
			.as_deref()
			.unwrap()
			.contains("+2|BETA")
	);

	ws.write("a.txt", "zero\nalpha\nbeta\ngamma\n");
	session.finish();
	let writer = DiskWriter::default();
	let outcome = session
		.apply(ApplyRequest::default(), &writer)
		.await
		.expect("apply");
	assert!(outcome.files[0].diff.contains("+3|BETA"), "{}", outcome.files[0].diff);
	assert_eq!(ws.read("a.txt").unwrap(), "zero\nalpha\nBETA\ngamma\n");
}

#[tokio::test]
async fn invalid_utf8_is_rejected_without_rewriting_unrelated_bytes() {
	let ws = Workspace::new(EditMode::Replace);
	let path = ws.cwd().join("legacy.txt");
	let original = b"name=caf\xe9\nalpha\n";
	std::fs::write(&path, original).unwrap();
	let writer = DiskWriter::default();
	let result = ws
		.apply_json(
			&serde_json::json!({ "path": "legacy.txt", "old_string": "alpha", "new_string": "beta" }),
			&writer,
		)
		.await;
	assert_eq!(std::fs::read(&path).unwrap(), original);
	let error = result.expect_err("invalid UTF-8 must be rejected");
	let message = error.to_string();
	assert!(message.contains("legacy.txt"), "{message}");
	assert!(message.contains("byte 8"), "{message}");
	assert!(writer.requests.lock().is_empty());
}

#[tokio::test]
async fn delete_removes_invalid_utf8_file_without_decoding() {
	let ws = Workspace::new(EditMode::Patch);
	let path = ws.cwd().join("legacy.bin");
	std::fs::write(&path, b"name=caf\xe9\n").unwrap();
	let writer = DiskWriter::default();
	let outcome = ws
		.apply_json(
			&serde_json::json!({ "path": "legacy.bin", "edits": [{ "op": "delete" }] }),
			&writer,
		)
		.await
		.expect("delete needs existence, not text");
	assert!(!path.exists(), "invalid UTF-8 file must be deletable");
	assert_eq!(writer.requests.lock().len(), 1);
	assert!(outcome.text.contains("Deleted legacy.bin"), "{}", outcome.text);
}

#[tokio::test]
async fn create_over_invalid_utf8_reports_already_exists() {
	let ws = Workspace::new(EditMode::ApplyPatch);
	let path = ws.cwd().join("legacy.txt");
	let original = b"name=caf\xe9\n";
	std::fs::write(&path, original).unwrap();
	let writer = DiskWriter::default();
	let err = ws
		.apply_raw("*** Begin Patch\n*** Add File: legacy.txt\n+new\n*** End Patch", &writer)
		.await
		.expect_err("existing undecodable file still exists");
	assert!(err.to_string().contains("already exists"), "{err}");
	assert_eq!(std::fs::read(&path).unwrap(), original);
	assert!(writer.requests.lock().is_empty());
}

#[tokio::test]
async fn patch_create_overwrite_preserves_generated_file_guard() {
	for (name, original) in [
		("generated.ts", b"const value = 1;\n".as_slice()),
		("source.ts", b"// @generated\nconst value = 1;\n".as_slice()),
		("legacy.ts", b"// @generated\nname=caf\xe9\n".as_slice()),
	] {
		let ws = Workspace::new(EditMode::Patch);
		let path = ws.cwd().join(name);
		std::fs::write(&path, original).unwrap();
		let mut session = ws.session();
		session.set_args_json(
			&serde_json::json!({ "path": name, "edits": [{ "op": "create", "diff": "+new" }] })
				.to_string(),
		);
		session.finish();
		let preview = session.preview();
		let writer = DiskWriter::default();
		let result = session.apply(ApplyRequest::default(), &writer).await;
		assert_eq!(std::fs::read(&path).unwrap(), original, "{name}");
		let err = result.expect_err("create-overwrite must respect generated-file protection");
		assert!(err.to_string().contains("auto-generated"), "{name}: {err}");
		assert!(writer.requests.lock().is_empty(), "{name}");
		assert!(
			preview.files[0]
				.error
				.as_deref()
				.is_some_and(|error| error.contains("auto-generated")),
			"{name}: {preview:?}"
		);
	}
}

#[tokio::test]
async fn patch_create_overwrites_invalid_utf8_when_policy_allows_it() {
	for (block_auto_generated, original) in
		[(true, b"name=caf\xe9\n".as_slice()), (false, b"// @generated\nname=caf\xe9\n".as_slice())]
	{
		let mut ws = Workspace::new(EditMode::Patch);
		ws.config.policy.block_auto_generated = block_auto_generated;
		let path = ws.cwd().join("legacy.ts");
		std::fs::write(&path, original).unwrap();
		let writer = DiskWriter::default();
		ws.apply_json(
			&serde_json::json!({ "path": "legacy.ts", "edits": [{ "op": "create", "diff": "+new" }] }),
			&writer,
		)
		.await
		.expect("whole-file replacement does not require decoding");
		assert_eq!(std::fs::read(&path).unwrap(), b"new\n");
	}
}

#[tokio::test]
async fn delete_then_create_replaces_invalid_utf8_file() {
	let ws = Workspace::new(EditMode::ApplyPatch);
	let path = ws.cwd().join("a.txt");
	std::fs::write(&path, b"name=caf\xe9\n").unwrap();
	let writer = DiskWriter::default();
	ws.apply_raw(
		"*** Begin Patch\n*** Delete File: a.txt\n*** Add File: a.txt\n+new\n*** End Patch",
		&writer,
	)
	.await
	.expect("delete+create needs existence, not text");
	assert_eq!(std::fs::read(&path).unwrap(), b"new\n");
	assert_eq!(writer.requests.lock().len(), 1);
}

#[tokio::test]
async fn delete_create_update_uses_replacement_text_for_invalid_utf8_file() {
	let ws = Workspace::new(EditMode::ApplyPatch);
	let path = ws.cwd().join("legacy.txt");
	std::fs::write(&path, b"name=caf\xe9\n").unwrap();
	let writer = DiskWriter::default();
	ws.apply_raw(
		"*** Begin Patch\n*** Delete File: legacy.txt\n*** Add File: legacy.txt\n+new\n*** Update \
		 File: legacy.txt\n@@\n-new\n+updated\n*** End Patch",
		&writer,
	)
	.await
	.expect("update must use newly created text");
	assert_eq!(std::fs::read(&path).unwrap(), b"updated\n");
	assert_eq!(writer.requests.lock().len(), 1);
}

#[tokio::test]
async fn create_update_uses_replacement_text_for_invalid_utf8_file() {
	let ws = Workspace::new(EditMode::Patch);
	let path = ws.cwd().join("legacy.txt");
	std::fs::write(&path, b"name=caf\xe9\n").unwrap();
	let writer = DiskWriter::default();
	ws.apply_json(
		&serde_json::json!({ "path": "legacy.txt", "edits": [
			{ "op": "create", "diff": "+new" },
			{ "op": "update", "diff": "@@\n-new\n+updated" }
		] }),
		&writer,
	)
	.await
	.expect("update must use replacement text");
	assert_eq!(std::fs::read(&path).unwrap(), b"updated\n");
	assert_eq!(writer.requests.lock().len(), 1);
}

#[tokio::test]
async fn update_before_create_rejects_invalid_utf8_without_writing() {
	let ws = Workspace::new(EditMode::Patch);
	let path = ws.cwd().join("legacy.txt");
	let original = b"name=caf\xe9\nalpha\n";
	std::fs::write(&path, original).unwrap();
	let writer = DiskWriter::default();
	let result = ws
		.apply_json(
			&serde_json::json!({ "path": "legacy.txt", "edits": [
			{ "op": "update", "diff": "@@\n-alpha\n+beta" },
			{ "op": "create", "diff": "+new" }
		] }),
			&writer,
		)
		.await;
	assert_eq!(std::fs::read(&path).unwrap(), original);
	let err = result.expect_err("initial update needs the original text");
	assert!(err.is_invalid_utf8(), "{err}");
	assert!(writer.requests.lock().is_empty());
}

#[tokio::test]
async fn update_after_delete_rejects_missing_file_without_writing() {
	let ws = Workspace::new(EditMode::Patch);
	let path = ws.cwd().join("legacy.txt");
	let original = b"name=caf\xe9\n";
	std::fs::write(&path, original).unwrap();
	let writer = DiskWriter::default();
	let result = ws
		.apply_json(
			&serde_json::json!({ "path": "legacy.txt", "edits": [
			{ "op": "delete" },
			{ "op": "update", "diff": "@@\n-alpha\n+beta" }
		] }),
			&writer,
		)
		.await;
	assert_eq!(std::fs::read(&path).unwrap(), original);
	let err = result.expect_err("update cannot resurrect a deleted file");
	assert!(err.to_string().contains("File not found"), "{err}");
	assert!(writer.requests.lock().is_empty());
}

#[tokio::test]
async fn hashline_streaming_rem_previews_invalid_utf8_deletion_before_later_sections() {
	let mut ws = Workspace::new(EditMode::Hashline);
	ws.config.raw_input = true;
	let path = ws.cwd().join("legacy.txt");
	std::fs::write(&path, b"name=caf\xe9\n").unwrap();
	ws.write("next.txt", "next\n");
	let tag = ws.snapshot("next.txt", "next\n", None);
	let mut session = ws.session();
	session.push(&format!("[legacy.txt#FFFF]\nREM\n[next.txt#{tag}]\nREM\n"));
	let streaming = session.preview();
	assert!(streaming.streaming);
	let deletion = streaming
		.files
		.iter()
		.find(|file| file.display == "legacy.txt")
		.expect("completed deletion section must remain visible while streaming");
	assert!(deletion.error.is_none(), "{streaming:?}");
	assert_eq!(deletion.op, Some(FileOp::Delete));
	assert!(path.exists(), "preview must not delete the file");

	session.finish();
	let final_preview = session.preview();
	let deletion = final_preview
		.files
		.iter()
		.find(|file| file.display == "legacy.txt")
		.expect("final preview must retain the deletion");
	assert!(deletion.error.is_none(), "{final_preview:?}");
	assert_eq!(deletion.op, Some(FileOp::Delete));
	let writer = DiskWriter::default();
	session
		.apply(ApplyRequest::default(), &writer)
		.await
		.expect("apply deletions");
	assert!(!path.exists());
	assert!(!ws.cwd().join("next.txt").exists());
	assert_eq!(writer.requests.lock().len(), 2);
}

#[tokio::test]
async fn hashline_streaming_utf8_bypass_requires_an_allowed_tagged_rem() {
	for (header, diff, original, expected_error) in [
		("[legacy.ts#FFFF]", "PUT EOF:\n|new", b"name=caf\xe9\n".as_slice(), "UTF-8"),
		("[legacy.ts]", "REM", b"name=caf\xe9\n".as_slice(), "UTF-8"),
		("[legacy.ts#FFFF]", "REM\n|body", b"name=caf\xe9\n".as_slice(), "UTF-8"),
		("[legacy.ts#FFFF]", "REM", b"// @generated\nname=caf\xe9\n".as_slice(), "auto-generated"),
	] {
		let mut ws = Workspace::new(EditMode::Hashline);
		ws.config.raw_input = true;
		let path = ws.cwd().join("legacy.ts");
		std::fs::write(&path, original).unwrap();
		ws.write("next.txt", "next\n");
		let tag = ws.snapshot("next.txt", "next\n", None);
		let mut session = ws.session();
		session.push(&format!("{header}\n{diff}\n[next.txt#{tag}]\nREM\n"));
		let preview = session.preview();
		let rejected = preview
			.files
			.iter()
			.find(|file| file.display == "legacy.ts")
			.expect("completed invalid section must report its error");
		assert!(
			rejected
				.error
				.as_deref()
				.is_some_and(|error| error.contains(expected_error)),
			"{header} {diff}: {preview:?}"
		);
		assert_eq!(rejected.op, None);
		session.finish();
		let writer = DiskWriter::default();
		session
			.apply(ApplyRequest::default(), &writer)
			.await
			.expect_err("invalid deletion must not apply");
		assert_eq!(std::fs::read(&path).unwrap(), original);
		assert_eq!(ws.read("next.txt").as_deref(), Some("next\n"));
		assert!(writer.requests.lock().is_empty());
	}
}

#[tokio::test]
async fn hashline_rem_removes_invalid_utf8_file() {
	let ws = Workspace::new(EditMode::Hashline);
	let path = ws.cwd().join("legacy.txt");
	std::fs::write(&path, b"name=caf\xe9\n").unwrap();
	let writer = DiskWriter::default();
	let outcome = ws
		.apply_json(&serde_json::json!({ "input": "[legacy.txt#FFFF]\nREM" }), &writer)
		.await
		.expect("REM needs existence, not text");
	assert!(!path.exists(), "invalid UTF-8 file must be deletable");
	assert!(outcome.text.contains("Deleted legacy.txt"), "{}", outcome.text);
}

#[tokio::test]
async fn hashline_rem_streaming_preview_does_not_error_on_invalid_utf8() {
	use pi_edit::{
		EditStore, PathPolicy,
		session::{Session, SessionConfig},
	};

	let dir = tempfile::tempdir().expect("tempdir");
	let cwd = dir.path().canonicalize().expect("canonical tempdir");
	std::fs::write(cwd.join("legacy.txt"), b"name=caf\xe9\n").unwrap();
	let config = SessionConfig {
		mode:               EditMode::Hashline,
		policy:             PathPolicy {
			cwd:                  cwd.clone(),
			home_dir:             cwd,
			url_schemes:          Vec::new(),
			url_alias_schemes:    Vec::new(),
			plan_writable_roots:  Vec::new(),
			plan_active:          false,
			block_auto_generated: true,
		},
		allow_fuzzy:        true,
		fuzzy_threshold:    0.95,
		enforce_seen_lines: false,
		raw_input:          false,
	};
	let mut session = Session::new(config, EditStore::new());
	// Completed REM section followed by an incomplete trailing section.
	session.set_args_json(
		&serde_json::json!({ "input": "[legacy.txt#FFFF]\nREM\n[other.txt#FFFF]\nPUT " }).to_string(),
	);
	let batch = session.preview();
	assert!(batch.streaming);
	let completed = batch
		.files
		.iter()
		.find(|file| file.display == "legacy.txt")
		.expect("completed REM section previews");
	assert_eq!(completed.error, None, "{completed:?}");
}

#[tokio::test]
async fn create_over_generated_file_still_rejected() {
	let ws = Workspace::new(EditMode::Patch);
	let path = ws.cwd().join("gen.ts");
	std::fs::write(&path, "// @generated\nold\n").unwrap();
	let writer = DiskWriter::default();
	let err = ws
		.apply_json(
			&serde_json::json!({ "path": "gen.ts", "edits": [{ "op": "create", "diff": "new\n" }] }),
			&writer,
		)
		.await
		.expect_err("generated-file guard must survive the existence-only path");
	assert!(err.to_string().contains("auto-generated"), "{err}");
	assert_eq!(writer.requests.lock().len(), 0);
}

#[tokio::test]
async fn delete_create_update_replaces_invalid_utf8_file() {
	let ws = Workspace::new(EditMode::Patch);
	let path = ws.cwd().join("a.txt");
	std::fs::write(&path, b"name=caf\xe9\n").unwrap();
	let writer = DiskWriter::default();
	ws.apply_json(
		&serde_json::json!({ "path": "a.txt", "edits": [
			{ "op": "delete" },
			{ "op": "create", "diff": "fresh\n" },
			{ "op": "update", "diff": "@@\n-fresh\n+final" },
		] }),
		&writer,
	)
	.await
	.expect("update after create operates on the new content, not the undecodable bytes");
	assert_eq!(std::fs::read(&path).unwrap(), b"final\n");
}

#[tokio::test]
async fn writer_failure_is_surfaced_verbatim() {
	let ws = Workspace::new(EditMode::Replace);
	ws.write("a.txt", "one\n");
	let writer = DiskWriter { fail_at: Some((0, "disk full".into())), ..Default::default() };
	let err = ws
		.apply_json(
			&serde_json::json!({ "path": "a.txt", "old_string": "one", "new_string": "two" }),
			&writer,
		)
		.await
		.expect_err("writer failure");
	assert_eq!(err.to_string(), "disk full");
}

#[tokio::test]
async fn plan_mode_rejects_working_tree_writes_before_writing() {
	let mut ws = Workspace::new(EditMode::Replace);
	ws.config.policy.plan_active = true;
	ws.write("a.txt", "one\n");
	let writer = DiskWriter::default();
	let err = ws
		.apply_json(
			&serde_json::json!({ "path": "a.txt", "old_string": "one", "new_string": "two" }),
			&writer,
		)
		.await
		.expect_err("plan mode");
	assert_eq!(
		err.to_string(),
		"Plan mode: the working tree is read-only. Write your plan to a local://<slug>-plan.md file \
		 instead."
	);
	assert_eq!(writer.requests.lock().len(), 0);
}

#[tokio::test]
async fn internal_url_targets_wait_for_host_answers() {
	let mut ws = Workspace::new(EditMode::Replace);
	ws.config.policy.url_schemes = vec!["local".into()];
	ws.config.policy.plan_active = true;
	let sandbox = tempfile::tempdir().expect("sandbox");
	let backing = sandbox.path().join("plan.md");
	std::fs::write(&backing, "one\n").unwrap();
	let args = r#"{"old_string":"one","new_string":"two","path":"local://plan.md"}"#;
	let writer = DiskWriter::default();

	let mut unprovided = ws.session();
	unprovided.set_args_json(args);
	unprovided.finish();
	let err = unprovided
		.apply(ApplyRequest::default(), &writer)
		.await
		.expect_err("unprovided URL");
	assert!(matches!(&err, EditError::UnresolvedUrl(url) if url == "local://plan.md"), "{err}");
	assert_eq!(writer.requests.lock().len(), 0, "no write before the URL resolves");
	assert_eq!(unprovided.take_unresolved(), ["local://plan.md"]);

	let mut session = ws.session();
	let split = args.len() - r#"an.md"}"#.len();
	session.push(&args[..split]);
	session.preview();
	assert_eq!(
		session.take_unresolved(),
		["local://pl"],
		"streaming passes report their current URL"
	);
	session.push(&args[split..]);
	let batch = session.preview();
	assert_eq!(
		batch.files[0].error.as_deref(),
		Some("Internal URL not resolved yet: local://plan.md")
	);
	assert_eq!(session.take_unresolved(), ["local://plan.md"]);
	assert!(!session.preview_pending());

	session.provide("local://plan.md".into(), UrlResolution {
		absolute:      Some(backing.clone()),
		error:         None,
		plan_writable: true,
	});
	assert!(session.preview_pending());
	let batch = session.preview();
	assert_eq!(batch.files[0].display, "local://plan.md");
	assert!(
		batch.files[0]
			.diff
			.as_deref()
			.is_some_and(|diff| diff.contains("+1|two")),
		"{batch:?}"
	);

	session.finish();
	assert_eq!(session.begin_apply_url_targets(), ["local://plan.md"]);
	session.provide("local://plan.md".into(), UrlResolution {
		absolute:      Some(backing.clone()),
		error:         None,
		plan_writable: true,
	});
	session
		.apply(ApplyRequest::default(), &writer)
		.await
		.expect("plan-writable URL applies in plan mode");
	assert_eq!(writer.requests.lock()[0].absolute, backing);
	assert_eq!(std::fs::read_to_string(&backing).unwrap(), "two\n");
}

#[tokio::test]
async fn apply_never_reuses_url_answers_given_to_previews() {
	let mut ws = Workspace::new(EditMode::Replace);
	ws.config.policy.url_schemes = vec!["local".into()];
	ws.config.policy.url_alias_schemes = vec!["local".into()];
	let sandbox = tempfile::tempdir().expect("sandbox");
	let stale = sandbox.path().join("stale.md");
	let fresh = sandbox.path().join("fresh.md");
	std::fs::write(&stale, "one\n").unwrap();
	std::fs::write(&fresh, "one\n").unwrap();
	let answer = |absolute: &std::path::Path| UrlResolution {
		absolute:      Some(absolute.to_owned()),
		error:         None,
		plan_writable: false,
	};
	let writer = DiskWriter::default();

	let mut session = ws.session();
	session.set_args_json(r#"{"old_string":"one","new_string":"two","path":"local:/plan.md"}"#);
	session.finish();
	session.preview();
	assert_eq!(session.take_unresolved(), ["local://plan.md"]);
	session.provide("local://plan.md".into(), answer(&stale));
	assert!(session.preview().files[0].diff.is_some(), "the preview uses its answer");

	let err = session
		.apply(ApplyRequest::default(), &writer)
		.await
		.expect_err("the preview answer is not reused");
	assert!(matches!(&err, EditError::UnresolvedUrl(url) if url == "local://plan.md"), "{err}");
	assert_eq!(session.take_unresolved(), ["local://plan.md"]);
	session.provide("local://plan.md".into(), answer(&fresh));
	session
		.apply(ApplyRequest::default(), &writer)
		.await
		.expect("apply uses its own answer");
	assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "two\n");
	assert_eq!(std::fs::read_to_string(&stale).unwrap(), "one\n");
}

#[tokio::test]
async fn begin_apply_url_targets_cover_every_url_before_the_first_stage() {
	enum Payload {
		Raw(&'static str),
		Json(serde_json::Value),
	}
	// Every mode that can move a file: section paths plus move destinations.
	let rows = [
		(
			EditMode::ApplyPatch,
			Payload::Raw(
				"*** Begin Patch\n*** Update File: local://a.md\n@@\n-one\n+two\n*** Update File: \
				 local:/b.md\n*** Move to: local://c.md\n@@\n-one\n+two\n*** Update File: \
				 plain.txt\n@@\n-one\n+two\n*** End Patch\n",
			),
			&["local://a.md", "local://b.md", "local://c.md"][..],
		),
		(
			EditMode::Hashline,
			Payload::Json(serde_json::json!({ "input": "[local:/b.md#TAG]\nMV local://c.md" })),
			&["local://b.md", "local://c.md"][..],
		),
		(
			EditMode::Patch,
			Payload::Json(serde_json::json!({ "path": "local:/b.md", "edits": [
				{ "op": "update", "rename": "local://c.md", "diff": "@@\n-one\n+two" },
			] })),
			&["local://b.md", "local://c.md"][..],
		),
	];
	for (mode, payload, expected) in rows {
		let mut ws = Workspace::new(mode);
		ws.config.policy.url_schemes = vec!["local".into()];
		ws.config.policy.url_alias_schemes = vec!["local".into()];
		ws.write("plain.txt", "one\n");
		let sandbox = tempfile::tempdir().expect("sandbox");
		for name in ["a.md", "b.md"] {
			std::fs::write(sandbox.path().join(name), "one\n").unwrap();
		}
		let tag = ws.snapshot(sandbox.path().join("b.md").to_str().unwrap(), "one\n", None);
		let mut session = match payload {
			Payload::Raw(input) => {
				ws.config.raw_input = true;
				let mut session = ws.session();
				session.push(input);
				session
			},
			Payload::Json(args) => {
				let mut session = ws.session();
				session.set_args_json(&args.to_string().replace("#TAG]", &format!("#{tag}]")));
				session
			},
		};
		session.finish();
		let targets = session.begin_apply_url_targets();
		assert_eq!(targets, expected, "{mode:?}");
		for url in targets {
			let name = url.trim_start_matches("local://");
			session.provide(url.clone(), UrlResolution {
				absolute:      Some(sandbox.path().join(name)),
				error:         None,
				plan_writable: false,
			});
		}
		let writer = DiskWriter::default();
		session
			.apply(ApplyRequest::default(), &writer)
			.await
			.unwrap_or_else(|err| panic!("{mode:?}: every URL answered up front, yet {err}"));
		assert!(sandbox.path().join("c.md").exists(), "{mode:?}");
		assert!(!sandbox.path().join("b.md").exists(), "{mode:?}");
	}
}

#[tokio::test]
async fn result_text_uses_compact_preview_and_header() {
	let ws = Workspace::new(EditMode::Replace);
	ws.write("a.txt", "one\ntwo\nthree\n");
	let writer = DiskWriter::default();
	let outcome = ws
		.apply_json(
			&serde_json::json!({ "path": "a.txt", "old_string": "two", "new_string": "TWO" }),
			&writer,
		)
		.await
		.expect("apply");
	assert!(outcome.text.starts_with("[a.txt]\n"), "{}", outcome.text);
	assert!(outcome.text.contains("\n2:TWO\n"), "{}", outcome.text);
	assert!(outcome.files[0].diff.contains("+2|TWO"), "{}", outcome.files[0].diff);
	assert_eq!(outcome.files[0].old_text.as_deref(), Some("one\ntwo\nthree\n"));
	assert_eq!(outcome.files[0].new_text.as_deref(), Some("one\nTWO\nthree\n"));
}
