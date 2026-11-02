mod common;

use pi_edit::{
	EditMode,
	modes::apply_patch::{parse_apply_patch, parse_apply_patch_streaming},
};

fn update(body: &str) -> String {
	format!("*** Begin Patch\n*** Update File: fixture.txt\n{body}\n*** End Patch")
}

#[tokio::test]
async fn rejects_materially_unmatched_lines_without_writes() {
	for (before, body) in [
		(
			"{\n    \"sha\": \"a\",\n    \"ref\": \"b\"\n}\n",
			"@@\n-    sha=\"a\",\n-    ref=\"b\"\n+    sha=\"c\",\n+    ref=\"d\"",
		),
		(
			"void configure(int first, int middle, int last);\n",
			"@@\n-void configure(int first, int last);\n+void configure(int first, int last, bool \
			 enabled);",
		),
		(
			"def configure(\n    first,\n    middle,\n    last,\n):\n    pass\n",
			"@@\n def configure(\n     first,\n-    last,\n+    final,\n ):",
		),
		("// named states\n", "@@\n-named states\n+79 named states"),
		("69 named states\n", "@@\n-named states\n+79 named states"),
		(
			"void configure(int first, int middle);\n    run();\n",
			"@@ void configure(int first);\n-    run();\n+    stop();",
		),
		("unrelated header\nold\n", "@@\n absent header\n-old\n+new"),
	] {
		let mut workspace = common::Workspace::new(EditMode::ApplyPatch);
		workspace.config.fuzzy_threshold = 0.8;
		workspace.write("fixture.txt", before);
		let input = update(body);
		let mut session = workspace.session();
		session.set_args_json(&serde_json::json!({"input": input}).to_string());
		session.finish();
		let preview = session.preview();
		assert!(preview.files[0].error.is_some(), "preview accepted {body}");
		let writer = common::DiskWriter::default();
		let result = workspace.apply_raw(&input, &writer).await;
		assert!(result.is_err(), "applied unmatched lines: {body}");
		assert!(writer.requests.lock().is_empty());
		assert_eq!(workspace.read("fixture.txt").as_deref(), Some(before));
	}
}

#[tokio::test]
async fn matches_only_complete_lines_through_codex_normalization_passes() {
	for (before, body, expected) in [
		("69 named states\n", "@@\n-69 named states\n+79 named states", "79 named states\n"),
		("old   \n", "@@\n-old\n+new", "new\n"),
		("    old\n", "@@\n-old\n+new", "    new\n"),
		("", "@@\n+first", "first"),
		("head", "@@\n+tail", "head\ntail"),
		(
			"message = \"hello – world\"\n",
			"@@\n-message = \"hello - world\"\n+message = \"goodbye\"",
			"message = \"goodbye\"\n",
		),
		("old\nold\n", "@@\n-old\n+first\n@@\n-old\n+second", "first\nsecond\n"),
	] {
		let workspace = common::Workspace::new(EditMode::ApplyPatch);
		workspace.write("fixture.txt", before);
		workspace
			.apply_raw(&update(body), &common::DiskWriter::default())
			.await
			.unwrap();
		assert_eq!(workspace.read("fixture.txt").as_deref(), Some(expected));
	}
}

#[tokio::test]
async fn wrong_context_in_a_later_file_rejects_the_entire_envelope() {
	let workspace = common::Workspace::new(EditMode::ApplyPatch);
	workspace.write("first.txt", "before\n");
	workspace.write("fixture.txt", "void configure(int first, int middle, int last);\n");
	let input = "*** Begin Patch\n*** Update File: first.txt\n@@\n-before\n+after\n*** Update \
	             File: fixture.txt\n@@\n-void configure(int first, int last);\n+void configure(int \
	             first, int last, bool enabled);\n*** End Patch";
	let writer = common::DiskWriter::default();
	assert!(workspace.apply_raw(input, &writer).await.is_err());
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("first.txt").as_deref(), Some("before\n"));
	assert_eq!(
		workspace.read("fixture.txt").as_deref(),
		Some("void configure(int first, int middle, int last);\n")
	);
}

#[tokio::test]
async fn line_deletion_removes_its_terminator_and_preserves_other_empty_lines() {
	for ending in ["\n", "\r\n"] {
		for final_newline in [false, true] {
			for (lines, index) in [
				(vec!["first", "remove", "last"], 1),
				(vec!["remove", "middle", "last"], 0),
				(vec!["first", "middle", "remove"], 2),
				(vec!["remove"], 0),
				(vec!["first", "", "remove", "", "last"], 2),
			] {
				let mut before = lines.join(ending);
				if final_newline {
					before.push_str(ending);
				}
				let mut remaining = lines;
				remaining.remove(index);
				let mut expected = remaining.join(ending);
				if final_newline && !remaining.is_empty() {
					expected.push_str(ending);
				}
				let workspace = common::Workspace::new(EditMode::ApplyPatch);
				let path = workspace.write("fixture.txt", &before);
				workspace
					.apply_raw(&update("@@\n-remove"), &common::DiskWriter::default())
					.await
					.unwrap();
				assert_eq!(std::fs::read(path).unwrap(), expected.as_bytes(), "{before:?}");
			}
		}
	}
}

#[tokio::test]
async fn deleting_an_import_line_does_not_leave_an_empty_row() {
	let workspace = common::Workspace::new(EditMode::ApplyPatch);
	let path = workspace.write("fixture.txt", "from x import (\n    A,\n    B,\n)\n");
	workspace
		.apply_raw(&update("@@\n-    A,"), &common::DiskWriter::default())
		.await
		.unwrap();
	assert_eq!(std::fs::read(&path).unwrap(), b"from x import (\n    B,\n)\n");
	workspace
		.apply_raw(&update("@@\n-    B,\n+    C,"), &common::DiskWriter::default())
		.await
		.unwrap();
	assert_eq!(std::fs::read(path).unwrap(), b"from x import (\n    C,\n)\n");
}

const MOVE_ONLY: &str =
	"*** Begin Patch\n*** Update File: fixture.txt\n*** Move to: moved.txt\n*** End Patch";

#[tokio::test]
async fn move_only_parse_preview_and_apply_preserve_source_bytes() {
	assert_eq!(
		parse_apply_patch(MOVE_ONLY).unwrap(),
		parse_apply_patch_streaming(MOVE_ONLY).unwrap()
	);
	for before in ["alpha\n", "alpha", "\u{feff}alpha\r\nbeta\r\n", ""] {
		let workspace = common::Workspace::new(EditMode::ApplyPatch);
		workspace.write("fixture.txt", before);
		let mut session = workspace.session();
		session.set_args_json(&serde_json::json!({"input": MOVE_ONLY}).to_string());
		session.finish();
		let preview = session.preview();
		assert!(preview.files[0].error.is_none(), "{preview:?}");
		assert_eq!(preview.files[0].rename.as_deref(), Some("moved.txt"));
		let outcome = workspace
			.apply_raw(MOVE_ONLY, &common::DiskWriter::default())
			.await
			.unwrap();
		assert_eq!(outcome.files[0].old_text.as_deref(), Some(before));
		assert_eq!(outcome.files[0].new_text.as_deref(), Some(before));
		assert!(!workspace.cwd().join("fixture.txt").exists());
		assert_eq!(std::fs::read(workspace.cwd().join("moved.txt")).unwrap(), before.as_bytes());
	}
}

#[tokio::test]
async fn move_only_keeps_missing_source_collision_and_same_path_guards() {
	for (source, destination, input, error) in [
		(None, None, MOVE_ONLY, "File not found"),
		(Some("source\n"), Some("destination\n"), MOVE_ONLY, "destination already exists"),
		(
			Some("source\n"),
			None,
			"*** Begin Patch\n*** Update File: fixture.txt\n*** Move to: ./fixture.txt\n*** End Patch",
			"same as source",
		),
	] {
		let workspace = common::Workspace::new(EditMode::ApplyPatch);
		if let Some(before) = source {
			workspace.write("fixture.txt", before);
		}
		if let Some(before) = destination {
			workspace.write("moved.txt", before);
		}
		let writer = common::DiskWriter::default();
		let result = workspace.apply_raw(input, &writer).await.unwrap_err();
		assert!(result.to_string().contains(error), "{result}");
		assert!(writer.requests.lock().is_empty());
		assert_eq!(workspace.read("fixture.txt").as_deref(), source);
		assert_eq!(workspace.read("moved.txt").as_deref(), destination);
	}
}

#[tokio::test]
async fn a_later_invalid_hunk_does_not_commit_a_move_only_section() {
	let workspace = common::Workspace::new(EditMode::ApplyPatch);
	workspace.write("fixture.txt", "alpha\n");
	workspace.write("other.txt", "other\n");
	let input = "*** Begin Patch\n*** Update File: fixture.txt\n*** Move to: moved.txt\n*** Update \
	             File: other.txt\n@@\n-missing\n+new\n*** End Patch";
	let writer = common::DiskWriter::default();
	assert!(workspace.apply_raw(input, &writer).await.is_err());
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("fixture.txt").as_deref(), Some("alpha\n"));
	assert_eq!(workspace.read("other.txt").as_deref(), Some("other\n"));
	assert!(!workspace.cwd().join("moved.txt").exists());
}

#[tokio::test]
async fn move_only_retains_the_existing_non_utf8_update_rejection() {
	let workspace = common::Workspace::new(EditMode::ApplyPatch);
	let path = workspace.cwd().join("fixture.txt");
	std::fs::write(&path, [0xff, 0x00, 0x0a]).unwrap();
	let writer = common::DiskWriter::default();
	let error = workspace.apply_raw(MOVE_ONLY, &writer).await.unwrap_err();
	assert_eq!(error.kind(), "invalid_utf8");
	assert!(writer.requests.lock().is_empty());
	assert_eq!(std::fs::read(path).unwrap(), [0xff, 0x00, 0x0a]);
	assert!(!workspace.cwd().join("moved.txt").exists());
}

#[tokio::test]
async fn a_move_vacates_its_source_before_a_later_add() {
	for change in ["", "@@\n-old\n+moved\n"] {
		let workspace = common::Workspace::new(EditMode::ApplyPatch);
		workspace.write("a.txt", "old\n");
		let input = format!(
			"*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n{change}*** Add File: \
			 ./a.txt\n+replacement\n*** End Patch"
		);
		let mut session = workspace.session();
		session.set_args_json(&serde_json::json!({"input": input}).to_string());
		session.finish();
		assert!(
			session
				.preview()
				.files
				.iter()
				.all(|file| file.error.is_none())
		);
		workspace
			.apply_raw(&input, &common::DiskWriter::default())
			.await
			.unwrap();
		assert_eq!(workspace.read("a.txt").as_deref(), Some("replacement\n"));
		assert_eq!(
			workspace.read("b.txt").as_deref(),
			Some(if change.is_empty() {
				"old\n"
			} else {
				"moved\n"
			})
		);
	}
}

#[tokio::test]
async fn later_sections_can_edit_and_move_virtual_destinations() {
	let workspace = common::Workspace::new(EditMode::ApplyPatch);
	workspace.write("a.txt", "old\n");
	let input = "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** Update File: \
	             ./b.txt\n@@\n-old\n+edited\n*** Update File: b.txt\n*** Move to: c.txt\n*** Add \
	             File: a.txt\n+replacement\n*** End Patch";
	workspace
		.apply_raw(input, &common::DiskWriter::default())
		.await
		.unwrap();
	assert_eq!(workspace.read("c.txt").as_deref(), Some("edited\n"));
	assert_eq!(workspace.read("a.txt").as_deref(), Some("replacement\n"));
	assert!(!workspace.cwd().join("b.txt").exists());
}

#[tokio::test]
async fn ordered_moves_can_swap_files_through_a_vacant_path() {
	let workspace = common::Workspace::new(EditMode::ApplyPatch);
	workspace.write("a.txt", "A\n");
	workspace.write("b.txt", "B\n");
	let input = "*** Begin Patch\n*** Update File: a.txt\n*** Move to: temporary.txt\n*** Update \
	             File: b.txt\n*** Move to: a.txt\n*** Update File: temporary.txt\n*** Move to: \
	             b.txt\n*** End Patch";
	workspace
		.apply_raw(input, &common::DiskWriter::default())
		.await
		.unwrap();
	assert_eq!(workspace.read("a.txt").as_deref(), Some("B\n"));
	assert_eq!(workspace.read("b.txt").as_deref(), Some("A\n"));
	assert!(!workspace.cwd().join("temporary.txt").exists());
}

#[tokio::test]
async fn virtual_namespace_collisions_and_later_failure_write_nothing() {
	for tail in [
		"*** Update File: other.txt\n*** Move to: ./b.txt",
		"*** Add File: b.txt\n+collision",
		"*** Update File: a.txt\n@@\n-old\n+invalid",
		"*** Update File: b.txt\n@@\n-missing\n+invalid",
	] {
		let workspace = common::Workspace::new(EditMode::ApplyPatch);
		workspace.write("a.txt", "old\n");
		workspace.write("other.txt", "other\n");
		let input = format!(
			"*** Begin Patch\n*** Update File: a.txt\n*** Move to: \
			 b.txt\n@@\n-old\n+moved\n{tail}\n*** End Patch"
		);
		let mut session = workspace.session();
		session.set_args_json(&serde_json::json!({"input": input}).to_string());
		session.finish();
		assert!(
			session
				.preview()
				.files
				.iter()
				.any(|file| file.error.is_some())
		);
		let writer = common::DiskWriter::default();
		assert!(workspace.apply_raw(&input, &writer).await.is_err());
		assert!(writer.requests.lock().is_empty());
		assert_eq!(workspace.read("a.txt").as_deref(), Some("old\n"));
		assert_eq!(workspace.read("other.txt").as_deref(), Some("other\n"));
		assert!(!workspace.cwd().join("b.txt").exists());
	}
}

#[tokio::test]
async fn delete_then_add_keeps_its_replacement_semantics() {
	let workspace = common::Workspace::new(EditMode::ApplyPatch);
	workspace.write("fixture.txt", "old\n");
	workspace
		.apply_raw(
			"*** Begin Patch\n*** Delete File: fixture.txt\n*** Add File: \
			 fixture.txt\n+replacement\n*** End Patch",
			&common::DiskWriter::default(),
		)
		.await
		.unwrap();
	assert_eq!(workspace.read("fixture.txt").as_deref(), Some("replacement\n"));
}
