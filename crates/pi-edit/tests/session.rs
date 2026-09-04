//! Session-level contracts: streamed previews converge on the applied diff,
//! multi-file payloads stage atomically, and apply never trusts preview reads.

mod common;

use common::{DiskWriter, Workspace};
use pi_edit::{ApplyRequest, EditMode, session::PreviewBatch};

const SOURCE: &str = "fn main() {\n    let x = 1;\n    println!(\"{x}\");\n}\n";

fn sloppy_payload(path: &str) -> String {
	format!(
		"<SM:EDIT path=\"{path}\">\n<SM:FIND>\n    let x = 1;\n</SM:FIND>\n<SM:PUT>\n    let x = \
		 2;\n</SM:PUT>\n</SM:EDIT>\n"
	)
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
		"{}<SM:EDIT path=\"b.rs\">\n<SM:FIND>\nfn missing() {{}}\n</SM:FIND>\n<SM:PUT>\nfn \
		 present() {{}}\n</SM:PUT>\n</SM:EDIT>\n",
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
