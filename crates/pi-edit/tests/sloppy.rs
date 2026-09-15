mod common;

use common::{DiskWriter, Workspace, run_fixture};
use pi_edit::{
	EditMode, EditStore, ModeEngine,
	files::FileCache,
	modes::sloppy::{
		SloppyEngine,
		apply::{ApplyContext, apply_sloppy, normalize_text},
		parse::extract_inline_sloppy_regions,
	},
	path_policy::canonical_key,
	stream_json::ArgSnapshot,
};
use serde_json::json;

#[tokio::test]
async fn apply_fixtures() {
	run_fixture("sloppy/apply.json", EditMode::Sloppy).await;
}

fn after_payload(anchor: &str, insertion: &str) -> String {
	format!(
		"<SM:EDIT path=\"a.txt\">\n<SM:FIND>\n{anchor}\n</SM:FIND>\n<SM:AFTER>\n{insertion}</SM:\
		 AFTER>\n</SM:EDIT>\n"
	)
}

#[tokio::test]
async fn after_preserves_source_bytes_across_lenient_and_gap_matches() {
	let workspace = Workspace::new(EditMode::Sloppy);
	let before = "function run() {\n\tfirst(😀);  \n\tsecond();\t\n}\nnext();\n";
	workspace.write("a.txt", before);
	let input = after_payload("function run() {\n…\n    second();", "\tthird();\n");
	workspace
		.apply_json(&json!({ "input": input }), &DiskWriter::default())
		.await
		.expect("insert after the last matched line");
	assert_eq!(
		workspace.read("a.txt").unwrap(),
		"function run() {\n\tfirst(😀);  \n\tsecond();\t\n\tthird();\n}\nnext();\n"
	);
}

#[tokio::test]
async fn after_preserves_line_endings_and_eof_conventions() {
	for (before, expected) in [
		("anchor\nnext\n", "anchor\nadded\nnext\n"),
		("anchor\r\nnext\r\n", "anchor\r\nadded\r\nnext\r\n"),
		("anchor\n", "anchor\nadded\n"),
		("anchor", "anchor\nadded"),
	] {
		let workspace = Workspace::new(EditMode::Sloppy);
		workspace.write("a.txt", before);
		workspace
			.apply_json(
				&json!({ "input": after_payload("anchor", "added\n") }),
				&DiskWriter::default(),
			)
			.await
			.expect("line insertion");
		assert_eq!(workspace.read("a.txt").unwrap(), expected);
	}
}

#[tokio::test]
async fn after_inserts_literal_blank_lines_and_control_like_text() {
	let workspace = Workspace::new(EditMode::Sloppy);
	workspace.write("a.txt", "anchor\n\nnext\n");
	let insertion = "\n\t+literal <a> & \"b\"\n…\n»1\n＋kept\n*** End Patch\n\n";
	workspace
		.apply_json(&json!({ "input": after_payload("anchor", insertion) }), &DiskWriter::default())
		.await
		.expect("literal insertion");
	assert_eq!(workspace.read("a.txt").unwrap(), format!("anchor\n{insertion}\nnext\n"));

	workspace.write("a.txt", "anchor\nnext\n");
	workspace
		.apply_json(&json!({ "input": after_payload("anchor", "\n") }), &DiskWriter::default())
		.await
		.expect("one blank line is an insertion");
	assert_eq!(workspace.read("a.txt").unwrap(), "anchor\n\nnext\n");
}

#[tokio::test]
async fn after_requires_all_even_when_ambiguous_insertions_have_identical_outcomes() {
	let workspace = Workspace::new(EditMode::Sloppy);
	workspace.write("a.txt", "item\nitem\n");
	let writer = DiskWriter::default();
	let input = after_payload("item", "item\n");
	let error = workspace
		.apply_json(&json!({ "input": input }), &writer)
		.await
		.expect_err("an insertion needs a unique anchor");
	assert!(error.to_string().contains("ambiguous"));
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("a.txt").unwrap(), "item\nitem\n");

	let message = error.to_string();
	let (_, retry) = message
		.split_once("<SM:EDIT all>")
		.expect("all-match retry");
	let (body, _) = retry.split_once("</SM:EDIT>").expect("complete retry");
	let input = format!("<SM:EDIT path=\"a.txt\" all>{body}</SM:EDIT>\n");
	workspace
		.apply_json(&json!({ "input": input }), &writer)
		.await
		.expect("explicitly insert after every match");
	assert_eq!(workspace.read("a.txt").unwrap(), "item\nitem\nitem\nitem\n");
}

#[tokio::test]
async fn after_preview_matches_application_and_supports_inline_payloads() {
	let workspace = Workspace::new(EditMode::Sloppy);
	workspace.write("a.txt", "anchor\nnext\n");
	let input = after_payload("anchor", "first\nsecond\n");
	let regions = extract_inline_sloppy_regions(&format!("Editing now:\n{input}Finished."));
	assert_eq!(regions.len(), 1);
	let engine = SloppyEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 };
	let mut files = FileCache::new(workspace.config.policy.clone());
	let partial = input.split("second\n").next().unwrap();
	let args = ArgSnapshot { input: Some(partial.to_owned()), ..ArgSnapshot::default() };
	let preview = engine.preview(&args, true, &mut files, &workspace.store);
	assert_eq!(preview.len(), 1);
	assert!(preview[0].diff.as_deref().unwrap().contains("+2|first"));
	assert_eq!(workspace.read("a.txt").unwrap(), "anchor\nnext\n");

	let args = ArgSnapshot {
		input: Some(regions[0].payload.clone()),
		complete: true,
		..ArgSnapshot::default()
	};
	let preview = engine.preview(&args, false, &mut files, &workspace.store);
	let staged = engine
		.stage(&args, &mut files, &workspace.store)
		.expect("stage insertion");
	assert_eq!(staged[0].after, "anchor\nfirst\nsecond\nnext\n");
	assert_eq!(preview[0].diff.as_deref(), Some(staged[0].diff.as_str()));
	workspace
		.apply_json(&json!({ "input": args.input }), &DiskWriter::default())
		.await
		.expect("apply insertion");
	assert_eq!(workspace.read("a.txt").unwrap(), staged[0].after);
}

#[tokio::test]
async fn after_and_put_use_original_anchors_and_fail_atomically_across_files() {
	let workspace = Workspace::new(EditMode::Sloppy);
	workspace.write("a.txt", "anchor\nnext\n");
	workspace.write("b.txt", "original\n");
	let input = format!(
		"{}<SM:EDIT \
		 path=\"a.txt\">\n<SM:FIND>\nnext\n</SM:FIND>\n<SM:PUT>\nchanged\n</SM:PUT>\n</SM:EDIT>\n",
		after_payload("anchor", "added\n"),
	);
	let invalid = format!(
		"{input}<SM:EDIT \
		 path=\"b.txt\">\n<SM:FIND>\nmissing\n</SM:FIND>\n<SM:AFTER>\nadded\n</SM:AFTER>\n</SM:\
		 EDIT>\n"
	);
	let writer = DiskWriter::default();
	workspace
		.apply_json(&json!({ "input": invalid }), &writer)
		.await
		.expect_err("a failing sibling prevents every write");
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("a.txt").unwrap(), "anchor\nnext\n");
	assert_eq!(workspace.read("b.txt").unwrap(), "original\n");

	workspace
		.apply_json(&json!({ "input": input }), &writer)
		.await
		.expect("mixed actions apply to the original source");
	assert_eq!(workspace.read("a.txt").unwrap(), "anchor\nadded\nchanged\n");
}

#[tokio::test]
async fn after_rejects_empty_actions_and_missing_anchors_without_writing() {
	for input in [
		after_payload("anchor", ""),
		after_payload("", "added\n"),
		"<SM:EDIT path=\"a.txt\">\n<SM:AFTER>\nadded\n</SM:AFTER>\n</SM:EDIT>\n".to_owned(),
	] {
		let workspace = Workspace::new(EditMode::Sloppy);
		workspace.write("a.txt", "anchor\n");
		let writer = DiskWriter::default();
		let error = workspace
			.apply_json(&json!({ "input": input }), &writer)
			.await
			.expect_err("incomplete insertion must not become replacement or deletion");
		assert!(error.to_string().contains("<SM:AFTER>"));
		assert!(writer.requests.lock().is_empty());
		assert_eq!(workspace.read("a.txt").unwrap(), "anchor\n");
	}
}

#[test]
fn correctly_maps_source_spans_across_multi_byte_astral_characters_emoji() {
	let source = "😀 const oldValue = 1;";
	let normalized = normalize_text(source);
	let old = normalized.text.find("oldValue").expect("normalized token");
	assert_eq!(
		&source[normalized.starts[old]..normalized.ends[old + "oldValue".len() - 1]],
		"oldValue"
	);
}

#[test]
fn escalates_the_third_identical_no_op_with_stop_guidance() {
	let dir = tempfile::tempdir().expect("tempdir");
	let path = dir.path().join("noop.ts");
	std::fs::write(&path, "const value = current;\n").expect("fixture");
	let canonical = canonical_key(&path);
	let store = EditStore::new();
	let input = "«\nconst value = current;\n»\nconst value = current;";
	for attempt in 1..=3 {
		let mut notes = Vec::new();
		let error = apply_sloppy("const value = current;\n", input, ApplyContext {
			path:      "noop.ts",
			notes:     &mut notes,
			store:     &store,
			canonical: &canonical,
		})
		.expect_err("no-op must fail");
		if attempt < 3 {
			assert!(
				error
					.to_string()
					.contains("Operation 1 makes no change to noop.ts.")
			);
		} else {
			assert!(
				error
					.to_string()
					.contains("STOP: identical no-op repeated 3 times for noop.ts.")
			);
		}
	}
}

#[tokio::test]
async fn returns_a_diff_for_an_applicable_section_and_an_error_for_a_miss() {
	let workspace = Workspace::new(EditMode::Sloppy);
	workspace.write("a.ts", "const value = oldValue;\n");
	let mut files = FileCache::new(workspace.config.policy.clone());
	let engine = SloppyEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 };
	let complete = ArgSnapshot {
		input: Some(
			concat!(
				"<SM:EDIT path=\"a.ts\">\n<SM:FIND>\nconst value = oldValue;\n",
				"</SM:FIND>\n<SM:PUT>\nconst value = newValue;\n",
				"</SM:PUT>\n</SM:EDIT>",
			)
			.to_owned(),
		),
		complete: true,
		..ArgSnapshot::default()
	};
	let preview = engine.preview(&complete, false, &mut files, &workspace.store);
	assert_eq!(preview.len(), 1);
	assert!(
		preview[0]
			.diff
			.as_deref()
			.is_some_and(|diff| diff.contains("newValue"))
	);

	let miss = ArgSnapshot {
		input: Some(
			concat!(
				"<SM:EDIT path=\"a.ts\">\n<SM:FIND>\nmissing();\n",
				"</SM:FIND>\n<SM:PUT>\nnew();\n</SM:PUT>\n",
				"</SM:EDIT>",
			)
			.to_owned(),
		),
		complete: true,
		..ArgSnapshot::default()
	};
	let preview = engine.preview(&miss, false, &mut files, &workspace.store);
	assert_eq!(preview.len(), 1);
	assert!(
		preview[0]
			.error
			.as_deref()
			.is_some_and(|error| error.contains("did not match"))
	);

	let partial = ArgSnapshot {
		input: Some("<SM:EDIT path=\"a.ts\">\n<SM:FIND>\nmissing".to_owned()),
		..ArgSnapshot::default()
	};
	let preview = engine.preview(&partial, true, &mut files, &workspace.store);
	assert!(preview.is_empty());
}

#[test]
fn inspect_exposes_matcher_paths_and_entries() {
	let engine = SloppyEngine { allow_fuzzy: false, fuzzy_threshold: 0.95 };
	let args = ArgSnapshot {
		input: Some(
			concat!(
				"<SM:EDIT path=\"a.ts\">\n<SM:FIND>\na\n</SM:FIND>\n",
				"<SM:PUT>\nb\n</SM:PUT>\n</SM:EDIT>\n<SM:EDIT path=\"b.ts\">\n",
				"<SM:FIND>\nx\n</SM:FIND>\n<SM:PUT>\ny\n</SM:PUT>\n",
				"</SM:EDIT>",
			)
			.to_owned(),
		),
		complete: true,
		..ArgSnapshot::default()
	};
	let inspection = engine.inspect(&args);
	assert_eq!(inspection.paths, ["a.ts", "b.ts"]);
	assert_eq!(inspection.entries.len(), 2);
	assert!(inspection.entries[0].1.contains('b'));
}

#[tokio::test]
async fn missing_file_target_uses_the_taught_opener() {
	let workspace = Workspace::new(EditMode::Sloppy);
	let error = workspace
		.apply_json(&json!({ "input": "plain text" }), &DiskWriter::default())
		.await
		.expect_err("missing target");
	assert_eq!(
		error.to_string(),
		"Missing file target: start the payload with <SM:EDIT path=\"relative/path.ts\">."
	);
}
