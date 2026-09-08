mod common;

use pi_edit::{EditMode, ModeEngine, modes::patch::PatchEngine, stream_json::ArgSnapshot};

#[tokio::test]
async fn patch_core_fixtures() {
	common::run_fixture("patch/core.json", EditMode::Patch).await;
}

#[test]
fn matcher_digest_uses_added_lines_and_whole_create_content() {
	let engine = PatchEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 };
	let args = ArgSnapshot {
		path: Some("a.txt".into()),
		edits: vec![
			pi_edit::stream_json::EditEntry {
				op: Some("update".into()),
				diff: Some("@@\n-old\n+new".into()),
				closed: true,
				..Default::default()
			},
			pi_edit::stream_json::EditEntry {
				op: Some("create".into()),
				rename: Some("ignored.txt".into()),
				diff: Some("whole content".into()),
				closed: true,
				..Default::default()
			},
		],
		has_edits: true,
		complete: true,
		..Default::default()
	};
	let inspection = engine.inspect(&args);
	assert_eq!(inspection.paths, ["a.txt"]);
	assert_eq!(inspection.entries, [("a.txt".into(), "new\nwhole content".into())]);
	assert!(inspection.file_ops.is_empty());
}

#[tokio::test]
async fn streaming_preview_drops_an_unclosed_first_entry() {
	let workspace = common::Workspace::new(EditMode::Patch);
	workspace.write("a.txt", "old\n");
	let mut session = workspace.session();
	session.push(r#"{"path":"a.txt","edits":[{"op":"update","diff":"@@\n-old\n+new"#);
	let preview = session.preview();
	assert!(preview.streaming);
	assert!(preview.files.is_empty());
}
