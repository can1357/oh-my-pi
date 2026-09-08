mod common;

use std::{
	collections::BTreeMap,
	path::{Path, PathBuf},
};

use pi_edit::{
	EditMode, ModeEngine,
	modes::apply_patch::{ApplyPatchEngine, parse_apply_patch, parse_apply_patch_streaming},
};

fn files_under(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
	fn visit(root: &Path, current: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
		for entry in std::fs::read_dir(current).expect("read fixture directory") {
			let entry = entry.expect("fixture entry");
			let path = entry.path();
			if path.is_dir() {
				visit(root, &path, files);
			} else {
				files.insert(
					path.strip_prefix(root).unwrap().to_owned(),
					std::fs::read(path).expect("read fixture file"),
				);
			}
		}
	}
	let mut files = BTreeMap::new();
	if root.exists() {
		visit(root, root, &mut files);
	}
	files
}

fn copy_tree(from: &Path, to: &Path) {
	for (relative, bytes) in files_under(from) {
		let target = to.join(relative);
		if let Some(parent) = target.parent() {
			std::fs::create_dir_all(parent).expect("create fixture parent");
		}
		std::fs::write(target, bytes).expect("copy fixture file");
	}
}

#[tokio::test]
async fn core_fixture_cases() {
	common::run_fixture("apply_patch/core.json", EditMode::ApplyPatch).await;
}

#[tokio::test]
async fn applies_all_21_portable_scenarios() {
	let scenarios =
		Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/apply_patch/scenarios");
	let mut directories = std::fs::read_dir(&scenarios)
		.expect("scenario directory")
		.filter_map(Result::ok)
		.filter(|entry| entry.path().is_dir())
		.collect::<Vec<_>>();
	directories.sort_by_key(std::fs::DirEntry::file_name);
	assert_eq!(directories.len(), 21, "portable scenario count changed");

	let error_prefixes = ["005_", "006_", "007_", "008_", "009_", "010_", "011_", "012_", "013_"];
	for scenario in directories {
		let name = scenario.file_name().to_string_lossy().into_owned();
		let workspace = common::Workspace::new(EditMode::ApplyPatch);
		copy_tree(&scenario.path().join("input"), workspace.cwd());
		let patch =
			std::fs::read_to_string(scenario.path().join("patch.txt")).expect("scenario patch");
		let result = workspace
			.apply_raw(&patch, &common::DiskWriter::default())
			.await;
		if error_prefixes.iter().any(|prefix| name.starts_with(prefix)) {
			assert!(result.is_err(), "scenario {name} unexpectedly succeeded");
		} else if let Err(error) = result {
			panic!("scenario {name} failed: {error}");
		}
		assert_eq!(
			files_under(workspace.cwd()),
			files_under(&scenario.path().join("expected")),
			"scenario {name} final tree differs"
		);
	}
}

#[test]
fn rejects_invalid_first_line() {
	assert_eq!(
		parse_apply_patch("bad").unwrap_err().to_string(),
		"The first line of the patch must be '*** Begin Patch'"
	);
}

#[test]
fn rejects_missing_end_marker() {
	assert_eq!(
		parse_apply_patch("*** Begin Patch\nbad")
			.unwrap_err()
			.to_string(),
		"The last line of the patch must be '*** End Patch'"
	);
}

#[test]
fn parses_add_file_with_whitespace_padded_markers() {
	let parsed =
		parse_apply_patch("*** Begin Patch \n*** Add File: foo\n+hi\n *** End Patch").unwrap();
	assert_eq!(parsed.len(), 1);
	assert_eq!(parsed[0].path, "foo");
	assert_eq!(parsed[0].diff.as_deref(), Some("hi\n"));
}

#[test]
fn rejects_empty_update_file_hunk() {
	let error =
		parse_apply_patch("*** Begin Patch\n*** Update File: test.py\n*** End Patch").unwrap_err();
	assert_eq!(error.to_string(), "Line 3: Update file hunk for path 'test.py' is empty");
}

#[test]
fn parses_empty_patch() {
	assert!(
		parse_apply_patch("*** Begin Patch\n*** End Patch")
			.unwrap()
			.is_empty()
	);
}

#[test]
fn parses_full_patch_with_all_operations() {
	let parsed = parse_apply_patch(
		"*** Begin Patch\n*** Add File: add.txt\n+new\n*** Update File: old.txt\n*** Move to: \
		 moved.txt\n@@\n-old\n+changed\n*** Delete File: gone.txt\n*** End Patch",
	)
	.unwrap();
	assert_eq!(parsed.len(), 3);
	assert_eq!(parsed[1].rename.as_deref(), Some("moved.txt"));
}

#[test]
fn parses_heredoc_wrapped_patch() {
	let parsed = parse_apply_patch(
		"<<EOF\n*** Begin Patch\n*** Add File: test.txt\n+hello\n*** End Patch\nEOF",
	)
	.unwrap();
	assert_eq!(parsed[0].diff.as_deref(), Some("hello\n"));
}

#[test]
fn streaming_parser_tolerates_an_incomplete_update() {
	let parsed = parse_apply_patch_streaming("*** Begin Patch\n*** Update File: a.txt\n").unwrap();
	assert_eq!(parsed.len(), 1);
	assert_eq!(parsed[0].diff.as_deref(), Some(""));
}

#[test]
fn matcher_paths_entries_and_file_ops_follow_the_envelope() {
	let engine = ApplyPatchEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 };
	let args = pi_edit::stream_json::ArgSnapshot {
		input: Some(
			"*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-old\n+new\n*** Delete \
			 File: c.txt\n*** End Patch"
				.into(),
		),
		complete: true,
		..Default::default()
	};
	let inspection = engine.inspect(&args);
	assert_eq!(inspection.paths, ["a.txt", "c.txt"]);
	assert_eq!(inspection.entries, [("a.txt".into(), "new".into())]);
	assert_eq!(inspection.file_ops.len(), 2);
}

#[tokio::test]
async fn streaming_preview_keeps_body_rows_in_input_order() {
	let mut workspace = common::Workspace::new(EditMode::ApplyPatch);
	workspace.config.raw_input = true;
	workspace.write("a.txt", "old one\nold two\n");
	let mut session = workspace.session();
	session.push(
		"*** Begin Patch\n*** Update File: a.txt\n@@\n-old one\n+new one\n-old two\n+new two\n",
	);
	let preview = session.preview();
	assert!(preview.streaming);
	assert_eq!(preview.files.len(), 1);
	assert_eq!(preview.files[0].diff.as_deref(), Some("@@\n-old one\n+new one\n-old two\n+new two"));
}
