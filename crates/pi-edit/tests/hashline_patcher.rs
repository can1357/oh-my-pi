mod common;

use pi_edit::{
	EditMode, ModeEngine,
	modes::hashline::{
		HashlineEngine,
		patcher::{no_change_diagnostic, no_change_loop_diagnostic},
	},
	stream_json::ArgSnapshot,
};
use serde_json::json;

#[tokio::test]
async fn patcher_apply_cases() {
	common::run_fixture("hashline/patcher.json", EditMode::Hashline).await;
}

#[test]
fn matcher_paths_accept_partial_sections_and_header_noise() {
	let engine = HashlineEngine { enforce_seen_lines: false, max_columns: 512 };
	let inspected = engine.inspect(&ArgSnapshot {
		input: Some(
			"[one.ts#ABCD]\nPUT 1.=1:\n+one\n[*** Update File: dir with spaces/two.ts#1234]\nPUT \
			 2.=2:\n+two"
				.into(),
		),
		..ArgSnapshot::default()
	});
	assert_eq!(inspected.paths, ["one.ts", "dir with spaces/two.ts"]);
	assert_eq!(inspected.entries, [
		("one.ts".into(), "one".into()),
		("dir with spaces/two.ts".into(), "two".into())
	]);
}

#[test]
fn no_op_diagnostics_preserve_model_guidance() {
	assert_eq!(
		no_change_diagnostic("a.ts"),
		"Edits to a.ts parsed and applied cleanly, but produced no change: your body row(s) are \
		 byte-identical to the file at the targeted lines. The bug is somewhere else — re-read the \
		 file before issuing another edit. Do NOT widen the payload or add lines; verify the anchor \
		 first."
	);
	assert!(
		no_change_loop_diagnostic("a.ts", 3)
			.starts_with("STOP. Edits to a.ts have been a byte-identical no-op 3 times in a row")
	);
}

#[tokio::test]
async fn identical_noop_escalates_on_third_attempt() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "same\n");
	let tag = workspace.snapshot("a.txt", "same\n", None);
	let args = json!({ "input": format!("[a.txt#{tag}]\nPUT 1.=1:\n+same") });
	for _ in 0..2 {
		let outcome = workspace
			.apply_json(&args, &common::DiskWriter::default())
			.await
			.expect("soft no-op");
		assert!(outcome.text.contains("produced no change"));
	}
	let error = workspace
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect_err("third no-op must fail");
	assert!(
		error
			.to_string()
			.starts_with("STOP. Edits to a.txt have been a byte-identical no-op 3 times in a row")
	);
	assert_eq!(error.kind(), "no_change");
}

fn numbered_lines(count: u32) -> String {
	(1..=count)
		.map(|n| format!("line {n}\n"))
		.collect::<Vec<_>>()
		.concat()
}

/// Send `input`, expect a mismatch reply, and return it with the current tag
/// it names.
async fn mismatch_reply(workspace: &common::Workspace, input: &str) -> (String, String) {
	const CURRENT: &str = "current file hashes to #";
	let error = workspace
		.apply_json(&json!({ "input": input }), &common::DiskWriter::default())
		.await
		.expect_err("unknown tag must be rejected")
		.to_string();
	let at = error.find(CURRENT).expect("reply names the current tag") + CURRENT.len();
	let tag = error[at..at + 4].to_owned();
	(error, tag)
}

async fn mismatch_tag(workspace: &common::Workspace, input: &str) -> String {
	mismatch_reply(workspace, input).await.1
}

#[tokio::test]
async fn tag_from_a_mismatch_reply_covers_only_the_rows_it_displayed() {
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let text = numbered_lines(30);
	workspace.write("a.txt", &text);
	let tag = mismatch_tag(&workspace, "[a.txt#0000]\nPUT 5.=5:\n+X\n").await;

	let writer = common::DiskWriter::default();
	let error = workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 20.=20:\n+Y\n") }), &writer)
		.await
		.expect_err("line 20 was never displayed")
		.to_string();
	assert!(error.contains("never displayed"), "{error}");
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("a.txt").as_deref(), Some(text.as_str()));

	// Rows the reply displayed (anchor 5 ± 2) are seen.
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 7.=7:\n+Z\n") }), &writer)
		.await
		.expect("line 7 was displayed");
	assert!(
		workspace
			.read("a.txt")
			.unwrap()
			.contains("line 6\nZ\nline 8\n")
	);
}

#[tokio::test]
async fn mismatch_reply_keeps_the_provenance_of_recorded_content() {
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let text = numbered_lines(30);
	workspace.write("a.txt", &text);
	let read: Vec<u32> = (1..=30).collect();
	let tag = workspace.snapshot("a.txt", &text, Some(&read));
	assert_eq!(mismatch_tag(&workspace, "[a.txt#0000]\nPUT 5.=5:\n+X\n").await, tag);
	workspace
		.apply_json(
			&json!({ "input": format!("[a.txt#{tag}]\nPUT 20.=20:\n+Y\n") }),
			&common::DiskWriter::default(),
		)
		.await
		.expect("the earlier read displayed line 20");
}

#[tokio::test]
async fn each_mismatch_reply_adds_the_rows_it_displayed() {
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let text = numbered_lines(30);
	workspace.write("a.txt", &text);
	mismatch_tag(&workspace, "[a.txt#0000]\nPUT 5.=5:\n+X\n").await;
	let tag = mismatch_tag(&workspace, "[a.txt#0000]\nPUT 20.=20:\n+X\n").await;
	let writer = common::DiskWriter::default();
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 12.=12:\n+Y\n") }), &writer)
		.await
		.expect_err("neither reply displayed line 12");
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 20.=20:\n+Y\n") }), &writer)
		.await
		.expect("the second reply displayed line 20");
}

#[tokio::test]
async fn wide_row_a_mismatch_reply_prints_whole_counts_as_seen() {
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let wide = format!("{}TAIL", "x".repeat(600));
	let text = format!("{}{wide}\n{}", numbered_lines(10), numbered_lines(10));
	workspace.write("a.txt", &text);
	let (error, tag) = mismatch_reply(&workspace, "[a.txt#0000]\nPUT 11.=11:\n+y\n").await;
	assert!(error.contains(&format!("*11:{wide}")), "the reply prints the whole row");
	let writer = common::DiskWriter::default();
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 18.=18:\n+z\n") }), &writer)
		.await
		.expect_err("line 18 was not displayed");
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 11.=11:\n+y\n") }), &writer)
		.await
		.expect("line 11 was printed whole");
}

#[tokio::test]
async fn mismatch_reply_with_no_rows_leaves_every_line_unseen() {
	// The file shrank below the stale anchor: the reply prints no rows, yet
	// hands back the current tag.
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let text = numbered_lines(20);
	workspace.write("a.txt", &text);
	let (error, tag) = mismatch_reply(&workspace, "[a.txt#0000]\nPUT 25.=25:\n+X\n").await;
	assert!(!error.contains(":line "), "{error}");
	let writer = common::DiskWriter::default();
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 10.=10:\n+Y\n") }), &writer)
		.await
		.expect_err("the reply displayed no line");
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("a.txt").as_deref(), Some(text.as_str()));
}

#[test]
fn streaming_preview_keeps_completed_section_when_trailing_header_arrives() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "a\n");
	workspace.write("b.txt", "b\n");
	let tag_a = workspace.snapshot("a.txt", "a\n", None);
	let tag_b = workspace.snapshot("b.txt", "b\n", None);
	let input = format!("[a.txt#{tag_a}]\nPUT 1.=1:\n+A\n[b.txt#{tag_b}]");
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": input }).to_string());
	let batch = session.preview();
	assert!(batch.streaming);
	assert_eq!(batch.files.len(), 1);
	assert_eq!(batch.files[0].display, "a.txt");
	assert!(
		batch.files[0]
			.diff
			.as_deref()
			.is_some_and(|diff| diff.contains("+1|A"))
	);
}

#[tokio::test]
async fn rejection_names_the_path_a_foreign_tag_was_issued_for() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	let worktree = workspace.write("wt/crates/a/mcp.rs", "worktree\n");
	workspace.write("crates/a/mcp.rs", "parent\n");
	let tag = workspace.snapshot("wt/crates/a/mcp.rs", "worktree\n", None);
	let writer = common::DiskWriter::default();
	let input = format!("[crates/a/mcp.rs#{tag}]\nPUT 1.=1:\n+changed\n");
	let error = workspace
		.apply_json(&json!({ "input": input }), &writer)
		.await
		.expect_err("foreign tag must be rejected")
		.to_string();
	let origin = pi_edit::path_policy::canonical_key(&worktree);
	assert!(
		error.contains(&format!("Hash #{tag} was issued in this session for {}.", origin.display())),
		"{error}"
	);
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("crates/a/mcp.rs").as_deref(), Some("parent\n"));
	assert_eq!(workspace.read("wt/crates/a/mcp.rs").as_deref(), Some("worktree\n"));
}

async fn refusal_kind(workspace: &common::Workspace, input: &str) -> &'static str {
	workspace
		.apply_json(&json!({ "input": input }), &common::DiskWriter::default())
		.await
		.expect_err(input)
		.kind()
}

#[tokio::test]
async fn each_refusal_carries_the_kind_of_check_that_made_it() {
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let text = numbered_lines(30);
	workspace.write("a.txt", &text);
	let shown = workspace.snapshot("a.txt", &text, Some(&[1, 2, 3]));
	workspace.write("b.txt", "old\n");
	let stale = workspace.snapshot("b.txt", "old\n", None);
	workspace.write("b.txt", "new\n");
	for (input, kind) in [
		(format!("[a.txt#{shown}]\nPUT 20.=20:\n+X\n"), "unseen_lines"),
		(format!("[b.txt#{stale}]\nPUT 1.=1:\n+X\n"), "stale_tag"),
		(format!("[b.txt#{shown}]\nPUT 1.=1:\n+X\n"), "other_file_tag"),
		("[a.txt#0000]\nPUT 1.=1:\n+X\n".into(), "unknown_tag"),
		("[a.txt]\nPUT 1.=1:\n+X\n".into(), "missing_tag"),
		(format!("[a.txt#{shown}]\n"), "header_only"),
		("[new.txt]\nPUT 1.=1:\n+X\n".into(), "file_not_found"),
		("PUT 1.=1:\n+X\n".into(), "parse"),
	] {
		assert_eq!(refusal_kind(&workspace, &input).await, kind, "{input}");
	}
}

#[tokio::test]
async fn anchors_past_the_end_are_out_of_range_for_puts_cuts_and_pastes() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "one\ntwo\n");
	let tag = workspace.snapshot("a.txt", "one\ntwo\n", None);
	for ops in ["PUT 99.=99:\n+X\n", "CUT 99\n", "CUT 1 @x\nPUT 99.=99 @x\n"] {
		assert_eq!(
			refusal_kind(&workspace, &format!("[a.txt#{tag}]\n{ops}")).await,
			"out_of_range",
			"{ops}"
		);
	}
	assert_eq!(workspace.read("a.txt").as_deref(), Some("one\ntwo\n"));
}

const UNTAGGED_TEXT: &str = "alpha\nbeta\ngamma\n";

#[tokio::test]
async fn untagged_sections_get_the_current_tag_like_an_unknown_one() {
	let current = pi_edit::store::file_hash(UNTAGGED_TEXT);
	for header in ["a.txt#AUTO", "a.txt#????", "a.txt#", "a.txt#PLACEHOLDER", "a.txt"] {
		let workspace = common::Workspace::new(EditMode::Hashline);
		workspace.write("a.txt", UNTAGGED_TEXT);
		let writer = common::DiskWriter::default();
		let error = workspace
			.apply_json(&json!({ "input": format!("[{header}]\nPUT 2.=2:\n+BETA\n") }), &writer)
			.await
			.expect_err("an untagged section must not apply")
			.to_string();
		assert!(
			error.contains(&format!("the header needs this file's current tag, #{current}.")),
			"{header}: {error}"
		);
		assert!(
			error.contains(&format!("The current file hashes to #{current}.")),
			"{header}: {error}"
		);
		assert!(error.contains("*2:beta"), "{header}: {error}");
		assert!(writer.requests.lock().is_empty(), "{header}");
		assert_eq!(workspace.read("a.txt").as_deref(), Some(UNTAGGED_TEXT), "{header}");

		// The returned tag is enough to apply the same body without a read.
		workspace
			.apply_json(&json!({ "input": format!("[a.txt#{current}]\nPUT 2.=2:\n+BETA\n") }), &writer)
			.await
			.expect("resend with the returned tag");
		assert_eq!(workspace.read("a.txt").as_deref(), Some("alpha\nBETA\ngamma\n"), "{header}");
	}
}

#[tokio::test]
async fn untagged_head_and_tail_inserts_do_not_apply() {
	// An unknown hex tag lets a `PUT >$:` through with a drift warning; a
	// section with no tag at all never applies.
	for header in ["a.txt#AUTO", "a.txt"] {
		let workspace = common::Workspace::new(EditMode::Hashline);
		workspace.write("a.txt", UNTAGGED_TEXT);
		let error = workspace
			.apply_json(
				&json!({ "input": format!("[{header}]\nPUT >$:\n+delta\n") }),
				&common::DiskWriter::default(),
			)
			.await
			.expect_err("an untagged append must not apply")
			.to_string();
		assert!(error.contains("the header needs this file's current tag"), "{header}: {error}");
		assert_eq!(workspace.read("a.txt").as_deref(), Some(UNTAGGED_TEXT), "{header}");
	}
}

#[tokio::test]
async fn header_only_input_gets_the_current_tag() {
	let current = pi_edit::store::file_hash(UNTAGGED_TEXT);
	for header in [
		"[a.txt#AUTO]",
		"[a.txt#0000]",
		"[a.txt]",
		&format!("[a.txt#{current}]"),
		"\u{feff}[a.txt#AUTO]",
		&format!("\u{feff}[a.txt#{current}]"),
	] {
		let workspace = common::Workspace::new(EditMode::Hashline);
		workspace.write("a.txt", UNTAGGED_TEXT);
		let writer = common::DiskWriter::default();
		let error = workspace
			.apply_json(&json!({ "input": format!("{header}\n") }), &writer)
			.await
			.expect_err("a header with no ops must not apply")
			.to_string();
		assert!(
			error.starts_with(&format!(
				"Edit rejected for a.txt: no ops follow the header; put them under this file's \
				 current tag, #{current}."
			)),
			"{header}: {error}"
		);
		assert!(
			error.contains(&format!("The current file hashes to #{current}.")),
			"{header}: {error}"
		);
		assert!(writer.requests.lock().is_empty(), "{header}");
	}
}

#[tokio::test]
async fn header_only_reply_records_nothing_so_the_resend_meets_the_unread_guard() {
	// The reply shows no rows, so it records no snapshot: a resend under its
	// tag gets the guard a tag with no retained read gets, which applies short
	// lines and rejects one that may have been shown cut.
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let wide = "x".repeat(600);
	let text = format!("alpha\n{wide}\ngamma\n");
	workspace.write("a.txt", &text);
	let current = pi_edit::store::file_hash(&text);
	let writer = common::DiskWriter::default();
	workspace
		.apply_json(&json!({ "input": "[a.txt#AUTO]\n" }), &writer)
		.await
		.expect_err("a header with no ops must not apply");
	let error = workspace
		.apply_json(&json!({ "input": format!("[a.txt#{current}]\nPUT 2.=2:\n+y\n") }), &writer)
		.await
		.expect_err("a wide line no read showed whole")
		.to_string();
	assert!(error.contains("no retained read shows them in full"), "{error}");
	assert!(writer.requests.lock().is_empty());
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{current}]\nPUT 1.=1:\n+ALPHA\n") }), &writer)
		.await
		.expect("a short line applies under the returned tag");
	assert_eq!(workspace.read("a.txt").unwrap(), format!("ALPHA\n{wide}\ngamma\n"));
}

#[tokio::test]
async fn placeholder_section_does_not_borrow_a_same_path_tag() {
	let current = pi_edit::store::file_hash(UNTAGGED_TEXT);
	for placeholder in ["AUTO", "????", ""] {
		for input in [
			format!("[a.txt#{placeholder}]\nPUT 1.=1:\n+A\n[a.txt#{current}]\nPUT 2.=2:\n+B\n"),
			format!("[a.txt#{current}]\nPUT 1.=1:\n+A\n[a.txt#{placeholder}]\nPUT 2.=2:\n+B\n"),
		] {
			let workspace = common::Workspace::new(EditMode::Hashline);
			workspace.write("a.txt", UNTAGGED_TEXT);
			let writer = common::DiskWriter::default();
			let error = workspace
				.apply_json(&json!({ "input": input }), &writer)
				.await
				.expect_err("a placeholder section must not apply under another header's tag")
				.to_string();
			assert!(
				error.contains(&format!("the header needs this file's current tag, #{current}.")),
				"{input}: {error}"
			);
			assert!(writer.requests.lock().is_empty(), "{input}");
			assert_eq!(workspace.read("a.txt").as_deref(), Some(UNTAGGED_TEXT), "{input}");
		}
	}
}

#[tokio::test]
async fn untagged_section_for_a_missing_file_points_at_write() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	for input in
		["[new.txt#AUTO]\nPUT 1.=1:\n+x\n", "[new.txt]\nPUT 1.=1:\n+x\n", "[new.txt#????]\n"]
	{
		let error = workspace
			.apply_json(&json!({ "input": input }), &common::DiskWriter::default())
			.await
			.expect_err("missing file")
			.to_string();
		assert_eq!(
			error, "File not found: new.txt. Use the write tool to create new files.",
			"{input}"
		);
	}
}

#[test]
fn completed_preview_surfaces_the_current_tag_for_an_untagged_section() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", UNTAGGED_TEXT);
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": "[a.txt#AUTO]\nPUT 1.=1:\n+A\n" }).to_string());
	session.finish();
	let batch = session.preview();
	let current = pi_edit::store::file_hash(UNTAGGED_TEXT);
	let error = batch.files[0].error.as_deref().unwrap_or_default();
	assert!(error.contains(&format!("The current file hashes to #{current}.")), "{error}");
}

#[tokio::test]
async fn recovered_rem_reports_authored_and_deleted_paths() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	let target = workspace.write("correct/target.ts", "const value = 1;\n");
	let tag = workspace.snapshot("correct/target.ts", "const value = 1;\n", None);
	let input = format!("[wrong/target.ts#{tag}]\nREM\n");
	let outcome = workspace
		.apply_json(&json!({ "input": input }), &common::DiskWriter::default())
		.await
		.expect("recovered delete");

	assert!(!target.exists());
	let deleted = pi_edit::path_policy::canonical_key(&target);
	assert!(
		outcome
			.text
			.contains(&format!("Deleted {}", deleted.display())),
		"{}",
		outcome.text
	);
	assert!(
		outcome.text.contains(&format!(
			"Warnings:\nPath \"wrong/target.ts\" does not exist; matched its filename and snapshot \
			 tag #{tag} to {}",
			deleted.display()
		)),
		"{}",
		outcome.text
	);
}

#[test]
fn completed_preview_surfaces_stale_hash_error() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "a\n");
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": "[a.txt#FFFF]\nPUT 1.=1:\n+A\n" }).to_string());
	session.finish();
	let batch = session.preview();
	assert!(!batch.streaming);
	assert!(
		batch.files[0]
			.error
			.as_deref()
			.is_some_and(|error| error.contains("not from this session"))
	);
}

#[tokio::test]
async fn file_ops_reject_a_tag_that_does_not_match_the_file() {
	for op in ["REM", "MV b.txt"] {
		for recorded in [false, true] {
			let workspace = common::Workspace::new(EditMode::Hashline);
			workspace.write("a.txt", "current\n");
			let tag = if recorded {
				workspace.snapshot("a.txt", "old\n", None)
			} else {
				"0000".to_owned()
			};
			assert_ne!(tag, pi_edit::store::file_hash("current\n"));
			let writer = common::DiskWriter::default();
			let error = workspace
				.apply_json(&json!({ "input": format!("[a.txt#{tag}]\n{op}\n") }), &writer)
				.await
				.expect_err("a file op under a non-matching tag must be rejected")
				.to_string();
			let reason = if recorded {
				"file changed between read and edit"
			} else {
				"not from this session"
			};
			assert!(error.contains(reason), "{op} recorded={recorded}: {error}");
			assert!(writer.requests.lock().is_empty());
			assert_eq!(workspace.read("a.txt").as_deref(), Some("current\n"));
			assert_eq!(workspace.read("b.txt"), None);
		}
	}
}

#[tokio::test]
async fn head_insert_still_applies_across_a_stale_tag() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "current\n");
	let tag = workspace.snapshot("a.txt", "old\n", None);
	let outcome = workspace
		.apply_json(
			&json!({ "input": format!("[a.txt#{tag}]\nPUT <1:\n+head\nMV b.txt\n") }),
			&common::DiskWriter::default(),
		)
		.await
		.expect("head insert is content-independent");
	assert_eq!(workspace.read("a.txt"), None);
	assert_eq!(workspace.read("b.txt").as_deref(), Some("head\ncurrent\n"));
	assert!(outcome.text.contains("despite a stale snapshot tag"), "{}", outcome.text);
}

/// A body that restates both neighbouring lines and is too short for its
/// range: `PUT 3.=5:` restates `alive = true;` above and the `isAlive()`
/// header below, with one blank row between them for three range rows. Its
/// repair used to drop only the trailing echo, writing `alive = true;` twice
/// and deleting `constructor() {}` while reporting success. It is refused,
/// the file is left as it was, and the resend the refusal asks for applies.
#[tokio::test]
async fn refuses_a_short_body_that_restates_both_neighbours_and_applies_the_resend() {
	const PROBE: &str = "class Probe {\n\talive = true;\n\n\tconstructor() {}\n\n\tisAlive(): \
	                     boolean {\n\t\treturn this.alive;\n\t}\n}\n";
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("probe.ts", PROBE);
	let tag = workspace.snapshot("probe.ts", PROBE, None);
	let error = workspace
		.apply_json(
			&json!({
				"input": format!(
					"[probe.ts#{tag}]\nPUT 3.=5:\n+\talive = true;\n+\n+\tisAlive(): boolean {{\n"
				)
			}),
			&common::DiskWriter::default(),
		)
		.await
		.expect_err("a body too short between two echoes must not apply")
		.to_string();
	assert!(
		error.contains("`PUT 3.=5:` rejected: the body restates both")
			&& error.contains("they leave out lines 4-5"),
		"{error}"
	);
	assert_eq!(workspace.read("probe.ts").as_deref(), Some(PROBE));
	workspace
		.apply_json(
			&json!({ "input": format!("[probe.ts#{tag}]\nPUT 3.=5:\n+\n") }),
			&common::DiskWriter::default(),
		)
		.await
		.expect("the resend covers exactly the changed lines");
	assert_eq!(
		workspace.read("probe.ts").as_deref(),
		Some(
			"class Probe {\n\talive = true;\n\n\tisAlive(): boolean {\n\t\treturn \
			 this.alive;\n\t}\n}\n"
		)
	);
}

/// Shapes that lost a range row while reporting success, each refused with
/// the file left as it was:
/// - a body that restates the line above twice, in a file with no parser (the
///   first copy was dropped as an echo and the second written as content,
///   deleting `z = 3`);
/// - a one-sided too-short group in a patch whose other group's repair made the
///   file parse (the short group was applied as written, writing `const a = 1;`
///   twice and deleting `const c = 3;`).
#[tokio::test]
async fn refuses_echo_shapes_that_lost_rows_and_leaves_the_file_unchanged() {
	const ROWS: &str = "x = 1\ny = 2\nz = 3\nw = 4\n";
	const MULTI: &str =
		"const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nfunction f() {\n\treturn 1;\n}\n";
	let cases = [
		("r.txt", ROWS, "PUT 2.=3:\n+x = 1\n+x = 1\n+Y = 2\n", "`PUT 2.=3:` rejected"),
		(
			"m.ts",
			MULTI,
			"PUT 2.=3:\n+const a = 1;\n+const B = 2;\nPUT 6.=6:\n+\treturn 1;\n+}\n",
			"`PUT 2.=3:` rejected",
		),
	];
	for (path, text, ops, refusal) in cases {
		let workspace = common::Workspace::new(EditMode::Hashline);
		workspace.write(path, text);
		let tag = workspace.snapshot(path, text, None);
		let error = workspace
			.apply_json(
				&json!({ "input": format!("[{path}#{tag}]\n{ops}") }),
				&common::DiskWriter::default(),
			)
			.await
			.expect_err(path)
			.to_string();
		assert!(error.contains(refusal), "{path}: {error}");
		assert_eq!(workspace.read(path).as_deref(), Some(text), "{path}");
	}
}

/// A repair that keeps a source row outside the restated copy: the copy then
/// sits inside the rows the patch writes, where a check at their edges does
/// not see it. This `PUT 2.=4:` restates the `{children}` line just below the
/// range and is a row short of it. The repair kept the range's `>` row, so
/// the result wrote `{children}` twice and deleted the `style=` attribute,
/// and it parsed, so only this check stops it.
#[tokio::test]
async fn refuses_a_repair_whose_kept_row_hides_a_restated_copy() {
	const GRID: &str = "\t\t<div\n\t\t\tclassName=\"stat-grid \
	                    rise\"\n\t\t\tstyle={min}\n\t\t>\n\t\t\t{children}\n\t\t</div>\n";
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("Stat.tsx", GRID);
	let tag = workspace.snapshot("Stat.tsx", GRID, None);
	let error = workspace
		.apply_json(
			&json!({
				"input": format!(
					"[Stat.tsx#{tag}]\nPUT 2.=4:\n+\t\t\tclassName=\"stat-grid rise\"\n+\t\t\t{{children}}\n"
				)
			}),
			&common::DiskWriter::default(),
		)
		.await
		.expect_err("a repair that keeps a row must not hide the restated copy")
		.to_string();
	assert!(error.contains("`PUT 2.=4:` rejected"), "{error}");
	assert_eq!(workspace.read("Stat.tsx").as_deref(), Some(GRID));
}
