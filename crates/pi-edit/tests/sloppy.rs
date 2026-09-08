mod common;

use common::{DiskWriter, Workspace, run_fixture};
use pi_edit::{
	EditMode, EditStore, ModeEngine,
	files::FileCache,
	modes::sloppy::{
		SloppyEngine,
		apply::{ApplyContext, apply_sloppy, normalize_text},
	},
	path_policy::canonical_key,
	stream_json::ArgSnapshot,
};
use serde_json::json;

#[tokio::test]
async fn apply_fixtures() {
	run_fixture("sloppy/apply.json", EditMode::Sloppy).await;
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
