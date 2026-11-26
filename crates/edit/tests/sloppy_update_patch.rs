mod common;

use common::{DiskWriter, Workspace};
use omp_edit::{
	ApplyRequest, ArgSnapshot, EditMode, FileOp, ModeEngine, modes::sloppy::SloppyEngine,
};
use serde_json::json;

const ENGINE: SloppyEngine = SloppyEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 };

#[tokio::test]
async fn wrapped_and_bare_updates_have_the_same_targets_preview_and_written_bytes() {
	for begin in ["*** Begin Patch\n", ""] {
		let ws = Workspace::new(EditMode::Sloppy);
		ws.write("a.txt", "\u{feff}same\r\n*** Update File: literal\r\nsame\r\n");
		ws.write("b.txt", "first\nkeep\nlast");
		let input = format!(
			"{begin}*** Update File: a.txt\n@@\n *** Update File: \
			 literal\n-same\n+⟪literal│marker⟫\n+*** Find\n++++ addition  \n*** Update File: \
			 b.txt\n@@\n-first\n@@\n last\n+new\n*** End Patch"
		);
		let inspection = ENGINE.inspect(&ArgSnapshot {
			input: Some(input.clone()),
			complete: true,
			..ArgSnapshot::default()
		});
		assert_eq!(inspection.paths, ["a.txt", "b.txt"]);
		assert_eq!(inspection.entries, [
			("a.txt".to_owned(), "⟪literal│marker⟫\n*** Find\n+++ addition  ".to_owned()),
			("b.txt".to_owned(), "new".to_owned()),
		]);
		assert!(inspection.file_ops.is_empty());
		let mut session = ws.session();
		session.set_args_json(&json!({"input": input}).to_string());
		session.finish();
		let previews = session.preview().files;
		let writer = DiskWriter::default();
		let result = session
			.apply(ApplyRequest::default(), &writer)
			.await
			.unwrap();
		assert_eq!(previews.len(), 2);
		assert_eq!(result.files.len(), 2);
		for ((preview, applied), path) in previews.iter().zip(&result.files).zip(inspection.paths) {
			assert_eq!(applied.display, path);
			assert_eq!(preview.display, path);
			assert_eq!(preview.op, Some(FileOp::Update));
			assert_eq!(preview.diff.as_deref(), Some(applied.diff.as_str()));
		}
		assert_eq!(
			ws.read("a.txt").unwrap(),
			"\u{feff}same\r\n*** Update File: literal\r\n⟪literal│marker⟫\r\n*** Find\r\n+++ \
			 addition  \r\n"
		);
		assert_eq!(ws.read("b.txt").unwrap(), "keep\nlast\nnew");
	}
}

#[tokio::test]
async fn malformed_or_unsafe_tail_cannot_preview_or_commit_a_valid_prefix() {
	let ws = Workspace::new(EditMode::Sloppy);
	ws.write("a.txt", "alpha\n");
	ws.write("b.txt", "b\nrepeat\nrepeat\n  exact\n");
	let prefix = "*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+beta\n";
	for tail in [
		"", // truncated envelope
		"*** End Patch\nignored",
		"*** Update File: b.txt\n@@\n-repeat\n+ambiguous\n*** End Patch",
		"*** Update File: b.txt\n@@\n-exact\n+fuzzy\n*** End Patch",
		"*** Update File: b.txt\n@@\n missing context\n-b\n+new\n*** End Patch",
		"*** Update File: b.txt\n@@\n+unanchored\n*** End Patch",
		"*** Update File: b.txt\n@@\n b\n*** End Patch",
		"*** Update File: b.txt\n@@\n*** End Patch",
		"@@\n-alpha\n+overlap\n*** End Patch",
		"*** Edit File: b.txt\n*** Find\nb\n*** Replace\nnew\n*** End Patch",
		"*** Update File: b.txt\n*** Find\nb\n*** Replace\nnew\n*** End Patch",
		"*** Update File: b.txt\n@@\n-b\n+new\nstray text\n*** End Patch",
		"*** Add File: extra\n+new\n*** End Patch",
		"*** Delete File: b.txt\n*** End Patch",
		"*** Move to: extra\n*** End Patch",
		"*** Update File: ./a.txt\n@@\n-alpha\n+duplicate target\n*** End Patch",
		"*** Update File: \n@@\n-b\n+new\n*** End Patch",
	] {
		let input = format!("{prefix}{tail}");
		let mut session = ws.session();
		session.set_args_json(&json!({"input": input}).to_string());
		session.finish();
		let previews = session.preview().files;
		assert!(previews.iter().all(|p| p.diff.is_none()), "{tail}");
		assert!(previews.iter().any(|p| p.error.is_some()), "{tail}");
		let writer = DiskWriter::default();
		assert!(
			session
				.apply(ApplyRequest::default(), &writer)
				.await
				.is_err(),
			"{tail}"
		);
		assert!(writer.requests.lock().is_empty(), "{tail}");
	}
}

#[tokio::test]
async fn missing_target_does_not_request_suffix_recovery() {
	let ws = Workspace::new(EditMode::Sloppy);
	ws.write("elsewhere/a.txt", "old\n");
	let mut session = ws.session();
	session.set_args_json(
		&json!({"input": "*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch"}).to_string(),
	);
	session.finish();
	assert!(session.apply_recovery_misses().is_empty());
	let writer = DiskWriter::default();
	let error = session
		.apply(ApplyRequest::default(), &writer)
		.await
		.unwrap_err();
	assert!(error.to_string().contains("File not found: a.txt"));
	assert!(writer.requests.lock().is_empty());
}

#[test]
fn approval_sees_an_incomplete_second_target_but_not_literal_headers() {
	let args = ArgSnapshot {
		input: Some(
			"*** Update File: a.txt\n@@\n *** Update File: literal\n-old\n+new\n*** Update File: \
			 b.txt"
				.into(),
		),
		..ArgSnapshot::default()
	};
	assert_eq!(ENGINE.inspect(&args).paths, ["a.txt", "b.txt"]);
}
