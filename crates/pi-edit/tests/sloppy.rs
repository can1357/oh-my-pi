mod common;

use common::{DiskWriter, Workspace, run_fixture};
use pi_edit::{
	EditError, EditMode, EditStore, ModeEngine,
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
	format!("*** Edit File: a.txt\n*** Find\n{anchor}\n*** Insert After\n{insertion}")
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

	let input = copy_ready_payload(&error.to_string(), "*** Edit File: a.txt all");
	workspace
		.apply_json(&json!({ "input": input }), &writer)
		.await
		.expect("explicitly insert after every match");
	assert_eq!(workspace.read("a.txt").unwrap(), "item\nitem\nitem\nitem\n");
}

/// The payload is the final labeled region of this diagnostic and is safe to
/// resend verbatim through the end of the message.
fn copy_ready_payload(message: &str, opener: &str) -> String {
	let start = message.find(opener).expect("pathful copy-ready opener");
	message[start..].to_owned()
}

#[tokio::test]
async fn no_match_correction_resends_verbatim() {
	let workspace = Workspace::new(EditMode::Sloppy);
	workspace.write("a.txt", "const RUNNER = compute(1);\nkeep();\n");
	let writer = DiskWriter::default();
	let input = "*** Edit File: a.txt\n*** Find\nconst RUNNER = computeValue(1);\n*** \
	             Replace\nconst RUNNER = compute(2);\n";
	let error = workspace
		.apply_json(&json!({ "input": input }), &writer)
		.await
		.expect_err("anchor drifted past the fuzzy edit limit");
	let message = error.to_string();
	let input = copy_ready_payload(&message, "*** Edit File: a.txt");
	workspace
		.apply_json(&json!({ "input": input }), &writer)
		.await
		.expect("the correction applies as handed back");
	assert_eq!(workspace.read("a.txt").unwrap(), "const RUNNER = compute(2);\nkeep();\n");
}

#[tokio::test]
async fn before_lands_at_first_anchor_line_start_across_line_endings() {
	let payload = |header: &str, anchor: &str| {
		format!("{header}\n*** Find\n{anchor}\n*** Insert Before\n\tadded\n")
	};
	for (header, before, anchor, expected) in [
		("*** Edit File: a.txt", "\tanchor\nnext\n", "anchor", "\tadded\n\tanchor\nnext\n"),
		("*** Edit File: a.txt", "first\r\nanchor\r\n", "anchor", "first\r\n\tadded\r\nanchor\r\n"),
		("*** Edit File: a.txt", "anchor", "anchor", "\tadded\nanchor"),
		("*** Edit File: a.txt", "a();\nb();\nc();\n", "b();\nc();", "a();\n\tadded\nb();\nc();\n"),
		(
			"*** Edit File: a.txt all",
			"x\nanchor\nanchor\n",
			"anchor",
			"x\n\tadded\nanchor\n\tadded\nanchor\n",
		),
	] {
		let workspace = Workspace::new(EditMode::Sloppy);
		workspace.write("a.txt", before);
		workspace
			.apply_json(&json!({ "input": payload(header, anchor) }), &DiskWriter::default())
			.await
			.expect("insert before the first matched line");
		assert_eq!(workspace.read("a.txt").unwrap(), expected, "{before:?}");
	}
}

#[tokio::test]
async fn before_and_after_on_one_anchor_surround_it() {
	let workspace = Workspace::new(EditMode::Sloppy);
	workspace.write("a.txt", "anchor\n");
	let input = "*** Edit File: a.txt\n*** Find\nanchor\n*** Insert Before\nabove\n*** \
	             Find\nanchor\n*** Insert After\nbelow\n";
	workspace
		.apply_json(&json!({ "input": input }), &DiskWriter::default())
		.await
		.expect("both insertions keep the shared anchor");
	assert_eq!(workspace.read("a.txt").unwrap(), "above\nanchor\nbelow\n");
}

#[tokio::test]
async fn after_preview_matches_application_and_supports_inline_payloads() {
	let workspace = Workspace::new(EditMode::Sloppy);
	workspace.write("a.txt", "anchor\nnext\n");
	let input = after_payload("anchor", "first\nsecond\n");
	let regions =
		extract_inline_sloppy_regions(&format!("Editing now:\n{input}*** End Patch\nFinished."));
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
		"{}*** Edit File: a.txt\n*** Find\nnext\n*** Replace\nchanged\n",
		after_payload("anchor", "added\n"),
	);
	let invalid =
		format!("{input}*** Edit File: b.txt\n*** Find\nmissing\n*** Insert After\nadded\n");
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
		"*** Edit File: a.txt\n*** Insert After\nadded\n".to_owned(),
	] {
		let workspace = Workspace::new(EditMode::Sloppy);
		workspace.write("a.txt", "anchor\n");
		let writer = DiskWriter::default();
		let error = workspace
			.apply_json(&json!({ "input": input }), &writer)
			.await
			.expect_err("incomplete insertion must not become replacement or deletion");
		assert!(error.to_string().contains("*** Insert After"));
		assert!(writer.requests.lock().is_empty());
		assert_eq!(workspace.read("a.txt").unwrap(), "anchor\n");
	}
}

#[tokio::test]
async fn no_op_recovery_respects_utf8_boundaries_in_source_and_replacement() {
	for (before, anchor) in [
		("abcdefgh\n══════\n", "abcdefgh"),
		("══════\nabcdefgh\n", "abcdefgh"),
		("0123456789\nabcdefgh😀\n", "abcdefgh😀"),
		("😀abcdefgh\n0123456789\n", "😀abcdefgh"),
	] {
		let workspace = Workspace::new(EditMode::Sloppy);
		workspace.write("a.txt", before);
		let writer = DiskWriter::default();
		let input = format!("*** Edit File: a.txt\n*** Find\n{anchor}\n*** Replace\n{anchor}\n");
		let error = workspace
			.apply_raw(&input, &writer)
			.await
			.expect_err("an unchanged edit reports a no-op instead of panicking");
		assert!(matches!(error, EditError::Match(_)));
		assert!(writer.requests.lock().is_empty());
		assert_eq!(workspace.read("a.txt").unwrap(), before);
	}
}

#[tokio::test]
async fn overlapping_desired_matches_are_rejected_without_collapsing_source() {
	let workspace = Workspace::new(EditMode::Sloppy);
	let before = "abcabcabc\n";
	workspace.write("a.txt", before);
	let writer = DiskWriter::default();
	let error = workspace
		.apply_raw("*** Edit File: a.txt\nabcabc", &writer)
		.await
		.expect_err("overlapping matches are not adjacent duplicate blocks");
	assert!(matches!(error, EditError::Match(_)));
	assert!(error.to_string().contains("ambiguous"));
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("a.txt").unwrap(), before);
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
			"*** Edit File: a.ts\n*** Find\nconst value = oldValue;\n*** Replace\nconst value = \
			 newValue;\n"
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
		input: Some("*** Edit File: a.ts\n*** Find\nmissing();\n*** Replace\nnew();\n".to_owned()),
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
		input: Some("*** Edit File: a.ts\n*** Find\nmissing".to_owned()),
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
				"*** Edit File: a.ts\n*** Find\na\n*** Replace\nb\n",
				"*** Edit File: b.ts\n*** Find\nx\n*** Replace\ny\n",
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
async fn miss_with_cjk_content_returns_match_error_without_panicking() {
	// `closest_fragment` slides a byte-width window over the normalized line and
	// appends a `len - width` tail fallback. With normalized `ab戸cd` (7 bytes)
	// and a 4-byte needle the tail is byte 3, inside `戸` (bytes 2..5): slicing
	// there panicked instead of reporting the miss.
	let workspace = Workspace::new(EditMode::Sloppy);
	workspace.write("a.txt", "ab戸cd\n");
	let error = workspace
		.apply_json(
			&json!({
				"input": "*** Edit File: a.txt\n*** Find\nwxyz\n*** Replace\nnew();\n",
			}),
			&DiskWriter::default(),
		)
		.await
		.expect_err("CJK miss must surface a match error, not panic");
	assert!(error.to_string().contains("did not match"));
}

#[tokio::test]
async fn overlapping_selection_spans_report_a_miss_without_panicking() {
	// Garbled ⟪…⟫ marker glyphs can resolve overlapping selection spans. Splicing
	// a multibyte (CJK) replacement into the mutated `content[start..end]` rewrite
	// buffer then re-indexes it on a mid-char edge and panicked the worker instead
	// of reporting the miss. The unmappable selection must surface as a match
	// error. (#12529)
	let workspace = Workspace::new(EditMode::Sloppy);
	workspace.write("a.txt", "d");
	let writer = DiskWriter::default();
	let error = workspace
		.apply_raw("*** Edit File: a.txt\n*** Find\n⟫⟪⟫d⟪\n*** Replace\n戸", &writer)
		.await
		.expect_err("an unmappable selection reports a miss instead of panicking");
	assert!(matches!(error, EditError::Match(_)));
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("a.txt").unwrap(), "d");
}
