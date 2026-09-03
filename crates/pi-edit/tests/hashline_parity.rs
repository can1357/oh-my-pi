mod common;

use std::{
	collections::HashMap,
	path::{Path, PathBuf},
};

use common::Workspace;
use pi_edit::{
	EditMode,
	diff_string::{CompactDiffOptions, build_compact_diff_preview},
	modes::{
		engine_for,
		hashline::{
			apply::{ApplyOptions, EmptyPaste, apply_edits},
			format::{format_numbered_lines, split_addressable_file_lines},
			input::{Patch, SplitOptions},
			parser::{parse_patch, parse_patch_streaming},
			tokenizer::parse_lid,
			types::FileOp,
		},
	},
	store::{Clipboard, EditStore, file_hash},
	stream_json::snapshot_from_text,
	text::{LineEnding, detect_line_ending},
};
use serde_json::{Value, json};

const FIXTURES: &[&str] = &[
	"parity_boundary_repair.json",
	"parity_block.json",
	"parity_clipboard.json",
	"parity_core_contracts.json",
	"parity_diff_preview.json",
	"parity_file_ops.json",
	"parity_format_v2.json",
	"parity_landing_shift.json",
	"parity_leniency.json",
	"parity_patcher.json",
	"parity_recovery_session_chain.json",
	"parity_snapshots.json",
];

fn fixture(name: &str) -> Value {
	let path = Path::new(env!("CARGO_MANIFEST_DIR"))
		.join("tests/fixtures/hashline")
		.join(name);
	serde_json::from_str(
		&std::fs::read_to_string(&path)
			.unwrap_or_else(|error| panic!("read {}: {error}", path.display())),
	)
	.unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn legacy_error(message: &str) -> &str {
	message
		.strip_prefix("InvalidAbsoluteRangeError: ")
		.or_else(|| message.strip_prefix("Error: "))
		.unwrap_or(message)
}

fn file_op_value(op: &Option<FileOp>) -> Value {
	match op {
		None => Value::Null,
		Some(FileOp::Rem) => json!({ "kind": "rem" }),
		Some(FileOp::Move { dest }) => json!({ "kind": "move", "dest": dest }),
	}
}

fn check_parse(source: &str, case_name: &str, call: &Value) {
	let input = call["input"].as_str().expect("parse input");
	match (parse_patch(input), call["error"].as_str()) {
		(Ok(parsed), None) => {
			let expected = &call["expect"];
			assert_eq!(
				parsed.edits.len() as u64,
				expected["editCount"].as_u64().expect("editCount"),
				"{source}: {case_name}: edit count for {input:?}"
			);
			assert_eq!(
				file_op_value(&parsed.file_op),
				expected["fileOp"],
				"{source}: {case_name}: file op for {input:?}"
			);
			assert_eq!(
				json!(parsed.warnings),
				expected["warnings"],
				"{source}: {case_name}: parser warnings for {input:?}"
			);
		},
		(Err(error), Some(expected)) => assert_eq!(
			error.to_string(),
			legacy_error(expected),
			"{source}: {case_name}: parse error for {input:?}"
		),
		(Err(error), None) => {
			panic!("{source}: {case_name}: unexpected parse error for {input:?}: {error}")
		},
		(Ok(parsed), Some(expected)) => panic!(
			"{source}: {case_name}: expected parse error {expected:?}, got {} edits",
			parsed.edits.len()
		),
	}
}

fn check_apply(source: &str, case_name: &str, call: &Value) {
	let input = call["input"].as_str().expect("apply input");
	let parsed = parse_patch(input).unwrap_or_else(|error| {
		panic!("{source}: {case_name}: fixture apply input did not parse: {error}")
	});
	let mut clipboard = call.get("clipboard").map(|value| {
		let lines = value["lines"].as_array().map(|lines| {
			lines
				.iter()
				.map(|line| line.as_str().expect("clipboard line").to_owned())
				.collect()
		});
		let named = value["named"].as_object().map(|registers| {
			registers
				.iter()
				.map(|(name, lines)| {
					let lines = lines
						.as_array()
						.expect("register lines")
						.iter()
						.map(|line| line.as_str().expect("register line").to_owned())
						.collect();
					(name.clone(), lines)
				})
				.collect::<HashMap<_, _>>()
		});
		let pending_anon_cuts = value["pendingAnonCuts"].as_array().map(|items| {
			items
				.iter()
				.map(|item| item.as_str().expect("pending cut").to_owned())
				.collect()
		});
		Clipboard { lines, named, pending_anon_cuts }
	});
	let on_empty_paste = if call["onEmptyPaste"].as_str() == Some("drop") {
		EmptyPaste::Drop
	} else {
		EmptyPaste::Throw
	};
	let result =
		apply_edits(call["text"].as_str().expect("apply source text"), &parsed.edits, ApplyOptions {
			clipboard: clipboard.as_mut(),
			path: call["path"].as_str(),
			on_empty_paste,
		});
	match (result, call["error"].as_str()) {
		(Ok(actual), None) => {
			let expected = &call["expect"];
			assert_eq!(
				actual.text,
				expected["text"].as_str().expect("expected text"),
				"{source}: {case_name}: applied text for {input:?}"
			);
			assert_eq!(
				actual.first_changed_line.map(u64::from),
				expected["firstChangedLine"].as_u64(),
				"{source}: {case_name}: first changed line for {input:?}"
			);
			let expected_warnings = expected
				.get("warnings")
				.cloned()
				.unwrap_or_else(|| json!([]));
			assert_eq!(
				json!(actual.warnings),
				expected_warnings,
				"{source}: {case_name}: apply warnings for {input:?}"
			);
		},
		(Err(error), Some(expected)) => assert_eq!(
			error.to_string(),
			legacy_error(expected),
			"{source}: {case_name}: apply error for {input:?}"
		),
		(Err(error), None) => {
			panic!("{source}: {case_name}: unexpected apply error for {input:?}: {error}")
		},
		(Ok(actual), Some(expected)) => {
			panic!("{source}: {case_name}: expected apply error {expected:?}, got {:?}", actual.text)
		},
	}
}

#[test]
fn legacy_parser_and_applier_cases_match_byte_for_byte() {
	let mut covered_names = 0_usize;
	let mut calls = 0_usize;
	for fixture_name in FIXTURES {
		let root = fixture(fixture_name);
		let source = root["source"].as_str().expect("fixture source");
		for case in root["cases"].as_array().expect("fixture cases") {
			covered_names += 1;
			let case_name = case["name"].as_str().expect("case name");
			for call in case["parse"].as_array().into_iter().flatten() {
				calls += 1;
				check_parse(source, case_name, call);
			}
			for call in case["apply"].as_array().into_iter().flatten() {
				calls += 1;
				check_apply(source, case_name, call);
			}
		}
	}
	assert!(
		covered_names >= 249,
		"expected at least the assigned 249 named TS cases, found {covered_names}"
	);
	assert!(calls > covered_names, "parity fixtures must exercise calls, not only list names");
}

#[test]
fn compact_diff_preview_matches_all_diff_preview_cases() {
	let options = CompactDiffOptions::default();
	let cases = [
		(
			"renders current lines and omits removed content while preserving counts",
			" 1|alpha\n-2|beta\n+2|DELTA\n+3|EPSILON\n 3|gamma",
			"1:alpha\n2:DELTA\n3:EPSILON\n4:gamma",
			2,
			1,
		),
		(
			"renumbers context lines against the post-edit file after range expansion",
			" 1|a1\n 2|a2\n-3|a3\n-4|a4\n+3|X\n+4|Y\n+5|Z\n 5|a5\n 6|a6\n 7|a7",
			"1:a1\n2:a2\n3:X\n4:Y\n5:Z\n6:a5\n7:a6\n8:a7",
			3,
			2,
		),
		(
			"collapses long contiguous added runs to head, marker, and tail",
			concat!(
				"+10|line 1\n+11|line 2\n+12|line 3\n+13|line 4\n",
				"+14|line 5\n+15|line 6\n+16|line 7",
			),
			"10:line 1\n11:line 2\n…\n15:line 6\n16:line 7",
			7,
			0,
		),
		(
			"normalizes adjacent elision markers to one unicode marker",
			" 1|alpha\n...\n...\n…\n 20|omega",
			"1:alpha\n…\n20:omega",
			0,
			0,
		),
		(
			"dedupes blank gap rows left adjacent by omitted removed lines and trims edge separators",
			"\n 1|alpha\n\n-5|beta\n\n 9|gamma\n\n-12|omitted",
			"1:alpha\n\n8:gamma",
			0,
			2,
		),
	];
	for (name, diff, preview, added, removed) in cases {
		let actual = build_compact_diff_preview(diff, &options);
		assert_eq!(actual.preview, preview, "{name}");
		assert_eq!(actual.added_lines, added, "{name}");
		assert_eq!(actual.removed_lines, removed, "{name}");
	}
}

#[test]
fn snapshot_store_matches_snapshot_contract_cases() {
	let path = PathBuf::from("/tmp/__hashline-snapshots__.ts");
	let other = PathBuf::from("/tmp/__hashline-other__.ts");

	let store = EditStore::new();
	let text = "L1\nL2\nL3\n";
	let tag = store.record(&path, text, None);
	assert_eq!(
		tag,
		file_hash(text),
		"derives the tag from whole-file content (matches computeFileHash)"
	);
	assert_eq!(tag.len(), 4);

	let first = store.record(&path, text, None);
	let second = store.record(&path, text, None);
	assert_eq!(second, first, "fuses repeated reads of identical content onto one tag");
	assert_eq!(&*store.by_hash(&path, &first).expect("snapshot").text, text);

	let v1 = "one\ntwo\n";
	let v2 = "one\ntwo\nthree\n";
	let tag1 = store.record(&path, v1, None);
	let tag2 = store.record(&path, v2, None);
	assert_ne!(tag1, tag2, "mints a new tag when content changes and retains the prior version");
	assert_eq!(&*store.by_hash(&path, &tag1).expect("prior").text, v1);
	assert_eq!(
		store.record(&path, v1, None),
		tag1,
		"promotes a re-observed older version back to head"
	);
	assert_eq!(store.head(&path).expect("head").hash, tag1);

	let bounded = EditStore::with_limits(8, 2, usize::MAX);
	let tag_a = bounded.record(&path, "A\n", None);
	let tag_b = bounded.record(&path, "B\n", None);
	let tag_c = bounded.record(&path, "C\n", None);
	assert!(
		bounded.by_hash(&path, &tag_a).is_none(),
		"bounds per-path history to maxVersionsPerPath (oldest dropped)"
	);
	assert!(bounded.by_hash(&path, &tag_b).is_some());
	assert!(bounded.by_hash(&path, &tag_c).is_some());

	let bounded = EditStore::with_limits(1, 4, usize::MAX);
	let cold = bounded.record(&path, "first\n", None);
	bounded.record(&other, "second\n", None);
	assert!(
		bounded.by_hash(&path, &cold).is_none(),
		"bounds tracked paths to maxPaths (cold path evicted)"
	);

	let wide = EditStore::new();
	let early = wide.record(&path, "first\n", None);
	for index in 0..100 {
		wide.record(
			&PathBuf::from(format!("/w/other-{index}.ts")),
			&format!("content {index}\n"),
			None,
		);
	}
	assert_eq!(
		&*wide.by_hash(&path, &early).expect("early tag").text,
		"first\n",
		"keeps an early tag resolvable across a wide session at default capacity"
	);
	assert!(wide.by_hash(&other, &early).is_none(), "rejects cross-path lookups");

	let mutating = EditStore::new();
	let old = mutating.record(&path, "A\n", Some(&[1]));
	let keep = mutating.record(&other, "B\n", None);
	mutating.invalidate(&path);
	assert!(
		mutating.by_hash(&path, &old).is_none(),
		"invalidate drops one path; clear drops everything"
	);
	assert!(mutating.by_hash(&other, &keep).is_some());
	mutating.clear();
	assert!(mutating.by_hash(&other, &keep).is_none());

	let relocating = EditStore::new();
	let destination = PathBuf::from("/tmp/__hashline-dest__.ts");
	let moved = relocating.record(&path, "A\n", Some(&[1]));
	relocating.relocate(&path, &destination);
	assert!(
		relocating.by_hash(&path, &moved).is_none(),
		"relocate moves version history and read provenance to a new path"
	);
	let snapshot = relocating.by_hash(&destination, &moved).expect("relocated");
	assert_eq!(&*snapshot.text, "A\n");
	assert_eq!(
		snapshot
			.seen_lines
			.expect("seen")
			.into_iter()
			.collect::<Vec<_>>(),
		vec![1]
	);

	let shared = EditStore::new();
	let shared_text = "shared\n";
	let shared_tag = shared.record(&path, shared_text, None);
	shared.record(&other, shared_text, None);
	let mut matches = shared
		.find_by_hash(&shared_tag)
		.into_iter()
		.map(|snapshot| snapshot.path)
		.collect::<Vec<_>>();
	matches.sort();
	assert_eq!(
		matches,
		vec![other.clone(), path.clone()],
		"findByHash returns every retained version with that tag across paths"
	);

	let collide_a = "line one 263\nline two 4471\n";
	let collide_b = "line one 410\nline two 6970\n";
	assert_eq!(file_hash(collide_a), file_hash(collide_b));
	let collisions = EditStore::new();
	let collision_tag = collisions.record(&path, collide_a, Some(&[1]));
	assert_eq!(collisions.record(&path, collide_b, Some(&[2])), collision_tag);
	assert_eq!(
		&*collisions
			.by_content(&path, collide_a)
			.expect("collision A")
			.text,
		collide_a,
		"keeps two colliding texts as separate versions with separate seenLines"
	);
	assert_eq!(
		&*collisions
			.by_content(&path, collide_b)
			.expect("collision B")
			.text,
		collide_b
	);
	collisions.record(&path, collide_a, Some(&[2]));
	let seen = collisions
		.by_content(&path, collide_a)
		.expect("repeated collision")
		.seen_lines
		.expect("seen lines");
	assert_eq!(
		seen.into_iter().collect::<Vec<_>>(),
		vec![1, 2],
		"still fuses identical repeated reads of one colliding text onto one snapshot"
	);
}

#[test]
fn pure_format_input_and_streaming_contracts_cover_uncaptured_cases() {
	assert_eq!(
		detect_line_ending("a\r\nb\nc"),
		LineEnding::CrLf,
		"preserves the first newline style when restoring mixed-ending files"
	);
	assert_eq!(
		detect_line_ending("a\nb\r\nc"),
		LineEnding::Lf,
		"preserves the first newline style when restoring mixed-ending files"
	);

	let section =
		Patch::parse_single("[src/foo.ts#1A2B]\nPUT 2.=2:\n+BBB", &SplitOptions::default())
			.expect("extracts path, snapshot tag, and diff body from bracket headers");
	assert_eq!(section.path, "src/foo.ts");
	assert_eq!(section.file_hash.as_deref(), Some("1A2B"));
	assert_eq!(section.diff, "PUT 2.=2:\n+BBB");

	let cwd = Path::new("/workspace");
	let patch = Patch::parse("\n[foo.ts]\nPUT <1:\n+x", &SplitOptions::default())
		.expect("normalizes leading blanks, cwd-relative paths, and explicit fallback paths");
	assert_eq!(patch.sections[0].path, "foo.ts");
	let absolute = Patch::parse("[/workspace/src/foo.ts]\nPUT <1:\n+x", &SplitOptions {
		cwd:  Some(cwd),
		path: None,
	})
	.expect("cwd relative");
	assert_eq!(absolute.sections[0].path, "src/foo.ts");
	let fallback = Patch::parse("PUT <1:\n+x", &SplitOptions { cwd: None, path: Some("a.ts") })
		.expect("fallback");
	assert_eq!(fallback.sections[0].path, "a.ts");

	let split = Patch::parse("[a.ts]\nPUT <1:\n+a\n[b.ts]\nPUT >$:\n+b", &SplitOptions::default())
		.expect("splits multiple sections and drops a trailing header without operations");
	assert_eq!(
		split
			.sections
			.iter()
			.map(|section| section.path.as_str())
			.collect::<Vec<_>>(),
		vec!["a.ts", "b.ts"]
	);
	let trailing = Patch::parse("[a.ts]\nPUT <1:\n+a\n[b.ts]", &SplitOptions::default())
		.expect("trailing header");
	assert_eq!(trailing.sections.len(), 1);

	let error = Patch::parse("@@ -1,3 +1,3 @@\nPUT <1:\n+x", &SplitOptions::default())
		.expect_err("rejects unified-diff hunk headers on the first line");
	assert!(error.to_string().contains("unified-diff hunk header"));

	let aborted = Patch::parse(
		"[a.ts]\nPUT >1:\n+a-payload\n*** Abort\n[b.ts]\nPUT >1:\n+never",
		&SplitOptions::default(),
	)
	.expect("stops the input splitter before later sections");
	assert_eq!(aborted.sections.len(), 1);
	assert!(!aborted.sections[0].diff.contains("never"));

	let streaming = parse_patch_streaming("CUT 1\nPUT >$")
		.expect("flushes a trailing bodyless clipboard op in streaming mode");
	assert_eq!(streaming.edits.len(), 3);

	assert!(parse_lid("9007199254740992", 1).is_err());

	assert_eq!(
		split_addressable_file_lines("a\nb\n"),
		vec!["a", "b"],
		"separates terminal newline sentinels from addressable file lines"
	);
	assert_eq!(split_addressable_file_lines("a\nb\n\n"), vec!["a", "b", ""]);
	let selected = split_addressable_file_lines("a\n\nb\n")[..2].join("\n");
	assert_eq!(
		format_numbered_lines(&selected, 1),
		"1:a\n2:",
		"keeps a selected terminal blank line when formatting"
	);
	assert!(
		parse_patch_streaming("PUT 5-5:\n")
			.expect("pending replace")
			.edits
			.is_empty(),
		"does not flush a trailing streaming pending empty replace hunk"
	);
	assert_eq!(
		parse_patch_streaming("CUT 2\nPUT >$:\n")
			.expect("streaming cut")
			.edits
			.len(),
		2,
		"flushes a streaming CUT hunk when another hunk starts"
	);

	for input in [
		"[src/a.ts#1A2B copied from read]\nPUT 1-1:\n+after",
		"[src/a.ts#1A2B:812]\nPUT 1-1:\n+after",
	] {
		assert!(
			Patch::parse(input, &SplitOptions::default())
				.expect_err("rejects trailing junk after a snapshot tag")
				.to_string()
				.contains("Input header must be")
		);
	}
	for input in [
		"[Update File: src/a.ts#1A2B copied from read]\nPUT 1-1:\n+after",
		"[Update File: src/a.ts#1A2B:812]\nPUT 1-1:\n+after",
	] {
		assert!(
			Patch::parse(input, &SplitOptions::default())
				.expect_err("rejects trailing junk after a snapshot tag even with apply_patch noise")
				.to_string()
				.contains("Input header must be")
		);
	}
	for input in [
		"[src/a.ts#1A2]\nPUT 1-1:\n+after",
		"[src/a.ts#1A2G]\nPUT 1-1:\n+after",
		"[src/a.ts#1A2B5]\nPUT 1-1:\n+after",
	] {
		assert!(
			Patch::parse(input, &SplitOptions::default())
				.expect_err("rejects malformed snapshot tags")
				.to_string()
				.contains("Input header must be")
		);
	}
	assert!(
		Patch::parse("[Update File: src/a.ts#1A2G]\nPUT 1-1:\n+after", &SplitOptions::default())
			.expect_err("rejects malformed snapshot tags even with apply_patch noise")
			.to_string()
			.contains("Input header must be")
	);
	let missing = Patch::parse("CUT 38-40", &SplitOptions::default())
		.expect_err("reports bracket syntax with a 4-hex example when the header is missing")
		.to_string();
	assert!(missing.contains("input must begin with \"[PATH#HASH]\""));
	assert!(missing.contains("Example: \"[src/foo.ts#1A2B]\""));

	let lowercase = Patch::parse("[a.ts#1a2b]\nPUT 1-1:\n+A", &SplitOptions::default())
		.expect("normalizes lowercase section tags while parsing");
	assert_eq!(lowercase.sections[0].file_hash.as_deref(), Some("1A2B"));
}

#[test]
fn hashline_inspection_matches_streaming_matcher_cases() {
	let root = fixture("parity_streaming_matcher_paths.json");
	let engine = engine_for(EditMode::Hashline, true, 0.95, false);
	for case in root["cases"].as_array().expect("matcher cases") {
		let name = case["name"].as_str().expect("matcher name");
		let args = json!({ "input": case["input"].as_str().expect("matcher input") }).to_string();
		let inspected = engine.inspect(&snapshot_from_text(&args, false, true));
		let expected_paths = case["paths"]
			.as_array()
			.expect("paths")
			.iter()
			.map(|path| path.as_str().expect("path").to_owned())
			.collect::<Vec<_>>();
		assert_eq!(inspected.paths, expected_paths, "{name}");
		if let Some(entries) = case["entries"].as_array() {
			let expected = entries
				.iter()
				.map(|entry| {
					let pair = entry.as_array().expect("entry pair");
					(
						pair[0].as_str().expect("entry path").to_owned(),
						pair[1].as_str().expect("entry digest").to_owned(),
					)
				})
				.collect::<Vec<_>>();
			assert_eq!(inspected.entries, expected, "{name}");
		}
	}
}

#[tokio::test]
async fn noop_loop_guard_matches_all_session_cases() {
	let root = fixture("parity_hashline_loop_guard.json");
	assert_eq!(root["cases"].as_array().expect("loop cases").len(), 5);

	let workspace = Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "same\n");
	let tag = workspace.snapshot("a.txt", "same\n", None);
	let noop = json!({ "input": format!("[a.txt#{tag}]\nPUT 1.=1:\n+same") });
	for _ in 0..2 {
		let result = workspace
			.apply_json(&noop, &common::DiskWriter::default())
			.await
			.expect("returns the soft hint for the first NOOP_HARD_LIMIT - 1 attempts");
		assert!(result.text.contains("produced no change"));
	}
	let error = workspace
		.apply_json(&noop, &common::DiskWriter::default())
		.await
		.expect_err("escalates to a thrown ToolError on the Nth consecutive byte-identical no-op");
	assert!(
		error
			.to_string()
			.starts_with("STOP. Edits to a.txt have been a byte-identical no-op 3 times in a row")
	);

	let paths = Workspace::new(EditMode::Hashline);
	for name in ["a.txt", "b.txt"] {
		paths.write(name, "same\n");
		let tag = paths.snapshot(name, "same\n", None);
		let args = json!({ "input": format!("[{name}#{tag}]\nPUT 1.=1:\n+same") });
		for _ in 0..2 {
			assert!(
				paths
					.apply_json(&args, &common::DiskWriter::default())
					.await
					.is_ok(),
				"does not accumulate across distinct canonical paths"
			);
		}
	}

	let reset = Workspace::new(EditMode::Hashline);
	reset.write("a.txt", "same\n");
	let old_tag = reset.snapshot("a.txt", "same\n", None);
	let first_noop = json!({ "input": format!("[a.txt#{old_tag}]\nPUT 1.=1:\n+same") });
	assert!(
		reset
			.apply_json(&first_noop, &common::DiskWriter::default())
			.await
			.is_ok()
	);
	let change = json!({ "input": format!("[a.txt#{old_tag}]\nPUT 1.=1:\n+changed") });
	reset
		.apply_json(&change, &common::DiskWriter::default())
		.await
		.expect("resets the counter after a successful (non-noop) commit on the same path");
	let changed_tag = reset.snapshot("a.txt", "changed\n", None);
	let changed_noop = json!({ "input": format!("[a.txt#{changed_tag}]\nPUT 1.=1:\n+changed") });
	for _ in 0..2 {
		assert!(
			reset
				.apply_json(&changed_noop, &common::DiskWriter::default())
				.await
				.is_ok()
		);
	}

	for _ in 0..2 {
		let isolated = Workspace::new(EditMode::Hashline);
		isolated.write("a.txt", "same\n");
		let tag = isolated.snapshot("a.txt", "same\n", None);
		let args = json!({ "input": format!("[a.txt#{tag}]\nPUT 1.=1:\n+same") });
		for _ in 0..2 {
			assert!(
				isolated
					.apply_json(&args, &common::DiskWriter::default())
					.await
					.is_ok(),
				"isolates state per ToolSession (no cross-session leakage)"
			);
		}
	}
}

#[tokio::test]
async fn coding_agent_hashline_executor_cases_run_through_session() {
	let root = fixture("parity_coding_agent_hashline.json");
	assert_eq!(root["cases"].as_array().expect("executor cases").len(), 16);
	assert_eq!(root["skipped"].as_array().expect("TS-only skips").len(), 4);

	let create = Workspace::new(EditMode::Hashline);
	let error = create
		.apply_json(
			&json!({ "input": "[new.ts]\nPUT <1:\n+export const x = 1;\n" }),
			&common::DiskWriter::default(),
		)
		.await
		.expect_err("rejects file creation and directs to the write tool");
	assert!(error.to_string().contains("write tool"));
	assert!(create.read("new.ts").is_none());

	let inserts = Workspace::new(EditMode::Hashline);
	inserts.write("a.ts", "aaa\nbbb\nccc");
	let tag = inserts.snapshot("a.ts", "aaa\nbbb\nccc", None);
	let args = json!({ "input": format!("[a.ts#{tag}]\nPUT >$:\n+bbb\n+ccc\n+NEW\n") });
	let outcome = inserts
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect("applies duplicate pure-insert payload literally");
	assert_eq!(inserts.read("a.ts").as_deref(), Some("aaa\nbbb\nccc\nbbb\nccc\nNEW"));
	assert!(!outcome.text.contains("Auto-dropped"));
	assert!(!outcome.text.contains("Auto-absorbed"));

	let bom = Workspace::new(EditMode::Hashline);
	bom.write("Program.cs", "\u{feff}using A;\n");
	let tag = bom.snapshot("Program.cs", "using A;\n", None);
	let args = json!({ "input": format!("[Program.cs#{tag}]\nPUT 1.=1:\n+using B;\n") });
	bom.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect("preserves UTF-8 BOM bytes when hashline edits decoded text");
	assert_eq!(bom.read("Program.cs").as_deref(), Some("\u{feff}using B;\n"));

	let notebook = Workspace::new(EditMode::Hashline);
	let notebook_json = r##"{"cells":[{"cell_type":"markdown","metadata":{"keep":true},"source":["# Title\n"]}],"metadata":{},"nbformat":4,"nbformat_minor":5}"##;
	notebook.write("notebook.ipynb", &format!("\u{feff}{notebook_json}"));
	let editable = "# %% [markdown] cell:0\n# Title\n";
	let tag = notebook.snapshot("notebook.ipynb", editable, None);
	let args = json!({ "input": format!("[notebook.ipynb#{tag}]\nPUT 2.=2:\n+# Updated\n") });
	notebook
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect("edits BOM-prefixed notebooks through the virtual cell text");
	let updated: Value = serde_json::from_str(
		notebook
			.read("notebook.ipynb")
			.expect("notebook written")
			.trim_start_matches('\u{feff}'),
	)
	.expect("valid notebook");
	assert_eq!(updated["cells"][0]["source"], json!(["# Updated\n"]));
	assert_eq!(updated["cells"][0]["metadata"], json!({ "keep": true }));

	let atomic = Workspace::new(EditMode::Hashline);
	atomic.write("a.ts", "aaa\n");
	atomic.write("b.ts", "bbb\n");
	let a_tag = atomic.snapshot("a.ts", "aaa\n", None);
	let args =
		json!({ "input": format!("[a.ts#{a_tag}]\nPUT 1.=1:\n+AAA\n[b.ts#FFFF]\nPUT 1.=1:\n+BBB") });
	assert!(
		atomic
			.apply_json(&args, &common::DiskWriter::default())
			.await
			.is_err(),
		"preflights every section before writing multi-file edits"
	);
	assert_eq!(atomic.read("a.ts").as_deref(), Some("aaa\n"));
	assert_eq!(atomic.read("b.ts").as_deref(), Some("bbb\n"));

	let duplicate = Workspace::new(EditMode::Hashline);
	duplicate.write("a.ts", "one\ntwo\n");
	let tag = duplicate.snapshot("a.ts", "one\ntwo\n", None);
	let args =
		json!({ "input": format!("[a.ts#{tag}]\nPUT 1.=1:\n+ONE\n[./a.ts#{tag}]\nPUT 2.=2:\n+TWO") });
	let error = duplicate
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect_err("rejects duplicate canonical targets before writing stale section results");
	assert!(error.to_string().contains("resolve to the same file"));
	assert_eq!(duplicate.read("a.ts").as_deref(), Some("one\ntwo\n"));

	let original = (1..=10)
		.map(|line| format!("L{line}"))
		.collect::<Vec<_>>()
		.join("\n")
		+ "\n";
	let sections = Workspace::new(EditMode::Hashline);
	sections.write("a.ts", &original);
	let tag = sections.snapshot("a.ts", &original, None);
	let args = json!({ "input": format!(
		concat!(
			"[a.ts#{tag}]\nPUT 2.=2:\n+L2a\n+L2b\n+L2c\n",
			"+L2d\n+L2e\n+L2f\n+L2g\n+L2h\n+L2i\n[a.ts#{tag}]\n",
			"PUT >8:\n+INSERTED",
		),
		tag = tag
	) });
	sections
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect("applies multiple sections targeting the same file against the original snapshot");
	assert_eq!(
		sections.read("a.ts").as_deref(),
		Some(concat!(
			"L1\nL2a\nL2b\nL2c\nL2d\nL2e\nL2f\nL2g\nL2h\n",
			"L2i\nL3\nL4\nL5\nL6\nL7\nL8\nINSERTED\nL9\n",
			"L10\n",
		))
	);
}

#[tokio::test]
async fn block_replace_cases_resolve_syntax_end_to_end() {
	let root = fixture("parity_block_replace.json");
	assert_eq!(
		root["cases"]
			.as_array()
			.expect("block replacement cases")
			.len(),
		14
	);

	let source = "function x() {\n  if (y) {\n  }\n}\n";
	let inner = Workspace::new(EditMode::Hashline);
	inner.write("x.ts", source);
	let tag = inner.snapshot("x.ts", source, None);
	let args = json!({ "input": format!("[x.ts#{tag}]\nPUT 2*:\n+  if (y || z) {{\n+  }}") });
	let result = inner
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect("resolves the inner `if` block (line 2) and replaces its full span");
	assert_eq!(inner.read("x.ts").as_deref(), Some("function x() {\n  if (y || z) {\n  }\n}\n"));
	assert!(
		result.files[0].diff.contains("if (y || z)"),
		"reports the diff for a resolved block edit"
	);

	let outer = Workspace::new(EditMode::Hashline);
	outer.write("x.ts", source);
	let tag = outer.snapshot("x.ts", source, None);
	let args =
		json!({ "input": format!("[x.ts#{tag}]\nPUT 1*:\n+function x() {{\n+  return 42;\n+}}") });
	let result = outer
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect("resolves the enclosing function block (line 1) and replaces the whole construct");
	assert_eq!(outer.read("x.ts").as_deref(), Some("function x() {\n  return 42;\n}\n"));
	assert!(
		result
			.text
			.contains("PUT 1*: → resolved lines 1-4 (4 lines)"),
		"echoes the resolved span in the result text for PUT N*:"
	);

	let cut = Workspace::new(EditMode::Hashline);
	cut.write("x.ts", source);
	let tag = cut.snapshot("x.ts", source, None);
	let args = json!({ "input": format!("[x.ts#{tag}]\nCUT 2*") });
	let result = cut
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect("deletes the resolved `if` block (line 2) end-to-end via `CUT N*`");
	assert_eq!(cut.read("x.ts").as_deref(), Some("function x() {\n}\n"));
	assert!(
		result
			.text
			.contains("CUT 2* → resolved lines 2-3 (2 lines)"),
		"echoes the resolved span in the result text for CUT N*"
	);

	let invalid = Workspace::new(EditMode::Hashline);
	invalid.write("x.ts", source);
	let tag = invalid.snapshot("x.ts", source, None);
	let args = json!({ "input": format!("[x.ts#{tag}]\nPUT 3*:\n+  }}") });
	let error = invalid
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect_err(
			"rejects a lone closing delimiter (no block begins there) and steers to `SWAP N.=M:`",
		);
	assert!(
		error
			.to_string()
			.contains("could not resolve a syntactic block beginning on line 3")
	);
	assert_eq!(invalid.read("x.ts").as_deref(), Some(source));

	let blank_source = "\nfunction x() {\n  return 1;\n}\n";
	let blank = Workspace::new(EditMode::Hashline);
	blank.write("blank.ts", blank_source);
	let tag = blank.snapshot("blank.ts", blank_source, None);
	let args = json!({ "input": format!("[blank.ts#{tag}]\nPUT 1*:\n+function y() {{}}") });
	let error = blank
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect_err("suggests the next block opener for a blank anchor without modifying the file");
	assert!(
		error
			.to_string()
			.contains("next multi-line block begins at line 2 and ends at line 4")
	);
	assert_eq!(blank.read("blank.ts").as_deref(), Some(blank_source));

	let unknown_source = "alpha\nbeta\ngamma\n";
	let unknown = Workspace::new(EditMode::Hashline);
	unknown.write("data.unknownext", unknown_source);
	let tag = unknown.snapshot("data.unknownext", unknown_source, None);
	let args = json!({ "input": format!("[data.unknownext#{tag}]\nPUT 1*:\n+ALPHA") });
	let error = unknown
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect_err("rejects a block edit on an unrecognized language");
	assert!(
		error
			.to_string()
			.contains("could not resolve a syntactic block")
	);
}

#[tokio::test]
async fn seen_line_guard_rejects_hidden_anchors_and_accepts_seen_anchors() {
	let root = fixture("parity_seen_line_guard.json");
	assert_eq!(root["cases"].as_array().expect("seen line cases").len(), 15);

	let mut hidden = Workspace::new(EditMode::Hashline);
	hidden.config.enforce_seen_lines = true;
	let source = "one\ntwo\nthree\n";
	hidden.write("a.txt", source);
	let tag = hidden.snapshot("a.txt", source, Some(&[2]));
	let args = json!({ "input": format!("[a.txt#{tag}]\nPUT 3.=3:\n+THREE") });
	let error = hidden
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect_err("rejects an edit on a line the partial read never displayed");
	assert!(error.to_string().contains("lines 3"), "{error}");
	assert_eq!(hidden.read("a.txt").as_deref(), Some(source));

	let mut seen = Workspace::new(EditMode::Hashline);
	seen.config.enforce_seen_lines = true;
	seen.write("a.txt", source);
	let tag = seen.snapshot("a.txt", source, Some(&[2]));
	let args = json!({ "input": format!("[a.txt#{tag}]\nPUT 2.=2:\n+TWO") });
	seen
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect("applies an edit on a displayed line");
	assert_eq!(seen.read("a.txt").as_deref(), Some("one\nTWO\nthree\n"));
}

fn preview_for(
	workspace: &Workspace,
	input: String,
	finished: bool,
) -> pi_edit::session::PreviewBatch {
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": input }).to_string());
	if finished {
		session.finish();
	}
	session.preview()
}

#[test]
fn hashline_streaming_preview_cases_preserve_partial_and_final_contracts() {
	let root = fixture("parity_edit_streaming_preview.json");
	let scenarios = root["cases"]
		.as_array()
		.expect("preview cases")
		.iter()
		.map(|case| {
			(case["scenario"].as_str().expect("scenario"), case["name"].as_str().expect("name"))
		})
		.collect::<HashMap<_, _>>();

	let workspace = Workspace::new(EditMode::Hashline);
	let text_a = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
	let text_b = "export const c = 3;\n";
	workspace.write("a.ts", text_a);
	workspace.write("b.ts", text_b);
	let tag_a = workspace.snapshot("a.ts", text_a, None);
	let tag_b = workspace.snapshot("b.ts", text_b, None);
	let header_a = format!("[a.ts#{tag_a}]");
	let header_b = format!("[b.ts#{tag_b}]");

	let batch = preview_for(&workspace, format!("{header_a}\nPUT <1:\n+// new\n{header_b}"), false);
	assert_eq!(batch.files.len(), 1, "{}", scenarios["trailing-header"]);
	assert_eq!(batch.files[0].display, "a.ts");
	assert!(batch.files[0].diff.is_some());
	assert!(batch.files[0].error.is_none());

	let batch =
		preview_for(&workspace, format!("{header_a}\nPUT <1:\n+// new\n{header_b}\n7:bad"), false);
	assert_eq!(batch.files.len(), 1, "{}", scenarios["trailing-error"]);
	assert_eq!(batch.files[0].display, "a.ts");
	assert!(batch.files[0].diff.is_some());

	let batch = preview_for(
		&workspace,
		format!("{header_a}\nPUT <1:\n+// new a\n{header_b}\nPUT <1:\n+// new b"),
		false,
	);
	assert_eq!(batch.files.len(), 2, "{}", scenarios["two-sections"]);
	assert!(
		batch
			.files
			.iter()
			.all(|file| file.diff.is_some() && file.error.is_none())
	);

	let batch = preview_for(&workspace, format!("{header_a}\nPUT 2-2:\n+const b = 22"), false);
	assert_eq!(batch.files.len(), 1, "{}", scenarios["live-line"]);
	assert!(batch.files[0].error.is_none());
	assert!(
		batch.files[0]
			.diff
			.as_deref()
			.is_some_and(|diff| diff.contains("const b = 22"))
	);

	let batch = preview_for(&workspace, "[a.ts#FFFF]\nPUT 2-2:\n+const b = 22".into(), false);
	assert_eq!(batch.files.len(), 1, "{}", scenarios["stream-stale"]);
	assert!(batch.files[0].error.is_none());
	assert!(
		batch.files[0]
			.diff
			.as_deref()
			.is_some_and(|diff| diff.contains("const b = 22"))
	);

	let empty_store = Workspace::new(EditMode::Hashline);
	empty_store.write("a.ts", text_a);
	let live_tag = file_hash(text_a);
	let batch =
		preview_for(&empty_store, format!("[a.ts#{live_tag}]\nPUT 2-2:\n+const b = 22\n"), true);
	assert_eq!(batch.files.len(), 1, "{}", scenarios["live-tag"]);
	assert!(batch.files[0].error.is_none());

	workspace.write("a.ts", &format!("// external\n{text_a}"));
	let batch = preview_for(&workspace, format!("{header_a}\nPUT 2-2:\n+const b = 22\n"), true);
	assert_eq!(batch.files.len(), 1, "{}", scenarios["recover-stale"]);
	assert!(batch.files[0].error.is_none());
	assert!(
		batch.files[0]
			.diff
			.as_deref()
			.is_some_and(|diff| diff.contains("const b = 22"))
	);

	let stale = Workspace::new(EditMode::Hashline);
	stale.write("a.ts", text_a);
	let batch = preview_for(&stale, "[a.ts#FFFF]\nPUT 2-2:\n+const b = 22\n".into(), true);
	assert_eq!(batch.files.len(), 1, "{}", scenarios["final-stale"]);
	assert!(
		batch.files[0]
			.error
			.as_deref()
			.is_some_and(|error| error.contains("not from this session"))
	);

	let batch = preview_for(&workspace, format!("{header_a}\nPUT 2-2:\n"), false);
	assert!(batch.files.is_empty(), "{}", scenarios["empty-body"]);

	let engine = engine_for(EditMode::Hashline, true, 0.95, false);
	let digest_args =
		json!({ "input": "[a.ts#AB12]\nPUT 1-2:\n+const x = 1;\n+const y = 2;\nCUT 5\n" })
			.to_string();
	let inspected = engine.inspect(&snapshot_from_text(&digest_args, false, true));
	assert_eq!(
		inspected.entries,
		vec![("a.ts".into(), "const x = 1;\nconst y = 2;".into())],
		"{}",
		scenarios["digest"]
	);
	let empty_args = json!({ "input": "[a.ts#AB12]\nCUT 3\n" }).to_string();
	let inspected = engine.inspect(&snapshot_from_text(&empty_args, false, true));
	assert_eq!(inspected.paths, vec!["a.ts"], "{}", scenarios["empty-digest"]);
	assert!(inspected.entries.is_empty(), "{}", scenarios["empty-digest"]);

	let recovered = Workspace::new(EditMode::Hashline);
	recovered.write("nested/a.ts", text_a);
	let nested_tag = recovered.snapshot("nested/a.ts", text_a, None);
	let batch =
		preview_for(&recovered, format!("[a.ts#{nested_tag}]\nPUT 1-1:\n+const a = 99;"), false);
	assert_eq!(batch.files.len(), 1, "{}", scenarios["path-recovery-stream"]);
	assert!(batch.files[0].error.is_none());
	assert!(
		batch.files[0]
			.diff
			.as_deref()
			.is_some_and(|diff| diff.contains("const a = 99;"))
	);

	let batch =
		preview_for(&recovered, format!("[a.ts#{nested_tag}]\nPUT 1-1:\n+const a = 99;\n"), true);
	assert_eq!(batch.files.len(), 1, "{}", scenarios["path-recovery-final"]);
	assert!(batch.files[0].error.is_none());
	assert!(
		batch.files[0]
			.diff
			.as_deref()
			.is_some_and(|diff| diff.contains("const a = 99;"))
	);

	let batch = preview_for(&recovered, "[missing.ts#FFFF]\nPUT 1-1:\n+x\n".into(), true);
	assert_eq!(batch.files.len(), 1, "{}", scenarios["path-recovery-miss"]);
	assert!(
		batch.files[0]
			.error
			.as_deref()
			.is_some_and(|error| error.contains("File not found"))
	);
}
