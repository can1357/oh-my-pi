mod common;

use common::{DiskWriter, Workspace, run_fixture};
use pi_edit::{EditMode, ModeEngine, modes::replace::ReplaceEngine, stream_json::ArgSnapshot};
use serde_json::json;

#[tokio::test]
async fn replace_core_fixtures() {
	run_fixture("replace/core.json", EditMode::Replace).await;
}

#[tokio::test]
async fn replace_old_text_new_text_and_rendered_preview() {
	let workspace = Workspace::new(EditMode::Replace);
	let original = "line one\nline two\nline three\n";
	workspace.write("bar.txt", original);
	let outcome = workspace
		.apply_json(
			&json!({ "path": "bar.txt", "old_string": "line two", "new_string": "line TWO" }),
			&DiskWriter::default(),
		)
		.await
		.unwrap();
	let file = &outcome.files[0];
	assert_eq!(file.absolute, workspace.cwd().join("bar.txt"));
	assert_eq!(file.old_text.as_deref(), Some(original));
	assert_eq!(file.new_text.as_deref(), Some("line one\nline TWO\nline three\n"));
	assert!(
		file
			.text
			.contains("[bar.txt]\n1:line one\n2:line TWO\n3:line three")
	);
	assert!(!file.text.starts_with("[bar.txt#"));
}

#[tokio::test]
async fn prunes_old_text_new_text_while_keeping_diff() {
	let workspace = Workspace::new(EditMode::Replace);
	let filler = "filler line that makes the source large\n".repeat(500);
	workspace.write("big.txt", &format!("{filler}LINE A\n{filler}"));
	let outcome = workspace
		.apply_json(
			&json!({ "path": "big.txt", "old_string": "LINE A", "new_string": "LINE B" }),
			&DiskWriter::default(),
		)
		.await
		.unwrap();
	let file = &outcome.files[0];
	assert_eq!(file.absolute, workspace.cwd().join("big.txt"));
	assert!(file.snapshots_pruned);
	assert!(file.old_text.is_none());
	assert!(file.new_text.is_none());
	assert!(file.diff.contains("+501|LINE B"));
}

#[tokio::test]
async fn applies_cursor_batch_sequentially_with_one_aggregate_diff() {
	let workspace = Workspace::new(EditMode::Replace);
	workspace.write("a.ts", "one\ntwo\nthree\n");
	let outcome = workspace
		.apply_json(
			&json!({
				"path": "a.ts",
				"edits": [
					{ "old_string": "one", "new_string": "ONE" },
					{ "old_string": "two", "new_string": "TWO" }
				]
			}),
			&DiskWriter::default(),
		)
		.await
		.unwrap();
	assert_eq!(workspace.read("a.ts").as_deref(), Some("ONE\nTWO\nthree\n"));
	assert_eq!(outcome.files.len(), 1);
	assert!(outcome.files[0].diff.contains("-1|one"));
	assert!(outcome.files[0].diff.contains("+1|ONE"));
	assert!(outcome.files[0].diff.contains("-2|two"));
	assert!(outcome.files[0].diff.contains("+2|TWO"));
}

#[tokio::test]
async fn cursor_batch_failure_stages_nothing() {
	let workspace = Workspace::new(EditMode::Replace);
	workspace.write("a.ts", "one\ntwo\n");
	let writer = DiskWriter::default();
	let error = workspace
		.apply_json(
			&json!({
				"path": "a.ts",
				"edits": [
					{ "old_string": "one", "new_string": "ONE" },
					{ "old_string": "missing", "new_string": "MISSING" }
				]
			}),
			&writer,
		)
		.await
		.unwrap_err();
	assert!(error.to_string().contains("match in a.ts"));
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("a.ts").as_deref(), Some("one\ntwo\n"));
}

#[test]
fn replace_matcher_entries_use_top_level_path_and_new_string() {
	let engine = ReplaceEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 };
	let snapshot = ArgSnapshot {
		path: Some("src/foo.ts".into()),
		new_string: Some("x = 1".into()),
		..ArgSnapshot::default()
	};
	assert_eq!(engine.inspect(&snapshot).paths, vec!["src/foo.ts"]);
	assert_eq!(engine.inspect(&snapshot).entries, vec![("src/foo.ts".into(), "x = 1".into())]);
}

#[test]
fn replace_matcher_omits_incomplete_entries() {
	let engine = ReplaceEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 };
	let snapshot = ArgSnapshot { path: Some("src/foo.ts".into()), ..ArgSnapshot::default() };
	assert_eq!(engine.inspect(&snapshot).paths, vec!["src/foo.ts"]);
	assert!(engine.inspect(&snapshot).entries.is_empty());
}

#[test]
fn streaming_preview_waits_until_new_string_is_present() {
	let workspace = Workspace::new(EditMode::Replace);
	workspace.write("a.txt", "alpha\n");
	let mut session = workspace.session();
	session.push(r#"{"path":"a.txt","old_string":"alp"#);
	assert!(session.preview().files.is_empty());
	session.push(r#"ha","new_string":"beta"}"#);
	let preview = session.preview();
	assert_eq!(preview.files.len(), 1);
	assert!(
		preview.files[0]
			.diff
			.as_deref()
			.is_some_and(|diff| diff.contains("+1|beta"))
	);
}

#[test]
fn preview_uses_compute_edit_diff_error_strings() {
	let workspace = Workspace::new(EditMode::Replace);
	workspace.write("a.txt", "alpha\n");
	let mut empty = workspace.session();
	empty.push(r#"{"path":"a.txt","old_string":"","new_string":"beta"}"#);
	assert_eq!(empty.preview().files[0].error.as_deref(), Some("oldText must not be empty."));

	let mut local_url = workspace.session();
	local_url.push(r#"{"path":"local:/PLAN.md","old_string":"old","new_string":"new"}"#);
	assert!(
		local_url.preview().files[0]
			.error
			.as_deref()
			.is_some_and(|error| error.contains("local://"))
	);
}
