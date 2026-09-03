mod common;

use pi_edit::{
	EditMode, ModeEngine,
	diff_string::parse_diff_hunks,
	files::FileCache,
	fuzzy::{find_context_line, seek_sequence},
	modes::{
		apply_patch::{ApplyPatchEngine, parse_apply_patch, parse_apply_patch_streaming},
		patch::{Operation, PatchEngine},
	},
	stream_json::{ArgSnapshot, ArgStream, EditEntry},
};

#[tokio::test]
async fn patch_core_parity_fixtures() {
	common::run_fixture("patch/parity_core.json", EditMode::Patch).await;
}

#[tokio::test]
async fn patch_adversarial_parity_fixtures() {
	common::run_fixture("patch/parity_adversarial.json", EditMode::Patch).await;
}

#[tokio::test]
async fn apply_patch_envelope_parity_fixtures() {
	common::run_fixture("apply_patch/parity_envelope.json", EditMode::ApplyPatch).await;
}

#[tokio::test]
async fn patch_regression_parity_fixtures() {
	for fixture in [
		"patch/parity_regression_1.json",
		"patch/parity_regression_2.json",
		"patch/parity_regression_3.json",
		"patch/parity_regression_4.json",
		"patch/parity_regression_5.json",
	] {
		common::run_fixture(fixture, EditMode::Patch).await;
	}
}

#[tokio::test]
async fn line_number_anchor_regression() {
	let workspace = common::Workspace::new(EditMode::Patch);
	let mut lines = Vec::new();
	for line in 1..=130 {
		lines.push(match line {
			125 => "\tfuzzyMatch?: boolean; // default: true".into(),
			126 => "\tfuzzyThreshold?: number; // default: 0.95".into(),
			127 => "\tpatchMode?: boolean; // default: false".into(),
			128 => "}".into(),
			_ => format!("// line {line}"),
		});
	}
	workspace.write("settings.ts", &format!("{}\n", lines.join("\n")));
	let args = serde_json::json!({
		"path": "settings.ts",
		"edits": [{
			"op": "update",
			"diff": "@@ line 125\n \tfuzzyMatch?: boolean; // default: true\n \tfuzzyThreshold?: number; // default: 0.95\n-\tpatchMode?: boolean; // default: false\n+\tpatchMode?: boolean; // default: true\n }"
		}]
	});
	workspace
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect("@@ line 125 is parsed as line hint, not literal context search");
	let result = workspace.read("settings.ts").expect("settings result");
	assert!(
		result.contains("patchMode?: boolean; // default: true"),
		"@@ line 125 is parsed as line hint, not literal context search"
	);
	assert!(
		!result.contains("patchMode?: boolean; // default: false"),
		"@@ line 125 is parsed as line hint, not literal context search"
	);
}

#[test]
fn seek_sequence_parity() {
	let exact = seek_sequence(&["foo", "bar", "baz"], &["bar", "baz"], 0, false, true);
	assert_eq!(exact.index, Some(1), "exact match finds sequence");
	let rstrip = seek_sequence(&["foo   ", "bar\t\t"], &["foo", "bar"], 0, false, true);
	assert_eq!(rstrip.index, Some(0), "rstrip match ignores trailing whitespace");
	let trim = seek_sequence(&["    foo   ", "   bar\t"], &["foo", "bar"], 0, false, true);
	assert_eq!(trim.index, Some(0), "trim match ignores leading and trailing whitespace");
	let longer = seek_sequence(&["just one line"], &["too", "many", "lines"], 0, false, true);
	assert_eq!(longer.index, None, "pattern longer than input returns undefined");
	assert_eq!(
		seek_sequence(&["foo", "bar"], &[], 0, false, true).index,
		Some(0),
		"empty pattern returns start"
	);
	assert_eq!(
		seek_sequence(&["foo", "bar"], &[], 5, false, true).index,
		Some(5),
		"empty pattern returns start"
	);
	assert_eq!(
		seek_sequence(&["a", "b", "c", "d", "e"], &["d", "e"], 0, true, true).index,
		Some(3),
		"eof mode prefers end of file"
	);
	assert_eq!(
		seek_sequence(
			&["import asyncio  # local import – avoids top‑level dep"],
			&["import asyncio  # local import - avoids top-level dep"],
			0,
			false,
			true
		)
		.index,
		Some(0),
		"unicode normalization matches dashes"
	);
	let fuzzy = seek_sequence(
		&["function greet() {", "  console.log(\"Hello!\");", "}"],
		&["function greet() {", "  console.log(\"Hello!\")  ", "}"],
		0,
		false,
		true,
	);
	assert_eq!(fuzzy.index, Some(0), "fuzzy match finds sequence with minor differences");
	assert!(fuzzy.confidence >= 0.92, "fuzzy match finds sequence with minor differences");

	let character_lines = [
		"function calculateTotal(items) {",
		"  let sum = 0;",
		"  for (const item of items) {",
		"    sum += item.price * item.quantity;",
		"  }",
		"  return sum;",
		"}",
	];
	let character_pattern =
		["  for (const item of items)  {", "    sum += item.price*item.quantity;"];
	let character = seek_sequence(&character_lines, &character_pattern, 0, false, true);
	assert_eq!(
		character.index,
		Some(2),
		"seekSequence falls back to character-based matching when line-based fails"
	);
	assert!(
		character.confidence > 0.9,
		"seekSequence falls back to character-based matching when line-based fails"
	);
	assert_eq!(
		seek_sequence(
			&["const message = \"Hello – World\";", "console.log(message);"],
			&["const message = \"Hello - World\";"],
			0,
			false,
			true
		)
		.index,
		Some(0),
		"seekSequence handles normalized unicode matching"
	);
	assert_eq!(
		seek_sequence(
			&["  function   foo()  {", "    return   42;", "  }"],
			&["function foo() {", "return 42;"],
			0,
			false,
			true
		)
		.index,
		Some(0),
		"seekSequence finds pattern with whitespace differences"
	);
}

#[tokio::test]
async fn dry_run_preview_does_not_modify_files() {
	let mut workspace = common::Workspace::new(EditMode::Patch);
	workspace.write("dryrun.txt", "original\n");
	let mut session = workspace.session();
	session.set_args_json(
		r#"{"path":"dryrun.txt","edits":[{"op":"update","diff":"@@\n-original\n+modified"}]}"#,
	);
	session.finish();
	let preview = session.preview();
	assert_eq!(
		workspace.read("dryrun.txt").as_deref(),
		Some("original\n"),
		"dry run does not modify files"
	);
	assert!(
		preview.files[0]
			.diff
			.as_deref()
			.unwrap_or_default()
			.contains("modified"),
		"dry run does not modify files"
	);
}

#[test]
fn parse_diff_hunks_parity() {
	let simple =
		parse_diff_hunks("@@ def f():\n-    pass\n+    return 123").expect("parses simple hunk");
	assert_eq!(simple.len(), 1, "parses simple hunk");
	assert_eq!(simple[0].change_context.as_deref(), Some("def f():"), "parses simple hunk");
	assert_eq!(simple[0].old_lines, ["    pass"], "parses simple hunk");
	assert_eq!(simple[0].new_lines, ["    return 123"], "parses simple hunk");
	assert_eq!(
		parse_diff_hunks("@@\n-bar\n+BAR\n@@\n-qux\n+QUX")
			.expect("parses multiple hunks")
			.len(),
		2,
		"parses multiple hunks"
	);
	let context = parse_diff_hunks("@@\n foo\n-bar\n+baz\n qux").expect("parses context lines");
	assert_eq!(context[0].old_lines, ["foo", "bar", "qux"], "parses context lines");
	assert_eq!(context[0].new_lines, ["foo", "baz", "qux"], "parses context lines");
	assert_eq!(
		parse_diff_hunks("@@\n+new line").expect("handles empty @@ marker")[0].change_context,
		None,
		"handles empty @@ marker"
	);
	assert!(
		parse_diff_hunks("@@\n+line\n*** End of File").expect("handles end of file marker")[0]
			.is_end_of_file,
		"handles end of file marker"
	);
}

#[test]
fn production_apply_patch_parser_parity() {
	let wrap = |body: &str| format!("*** Begin Patch\n{body}\n*** End Patch");
	let direct = parse_apply_patch(&wrap("*** Add File: foo.txt\n+hi"))
		.expect("returns PatchInput[] shape directly");
	assert_eq!(direct.len(), 1, "returns PatchInput[] shape directly");
	assert_eq!(direct[0].path, "foo.txt", "returns PatchInput[] shape directly");
	assert_eq!(direct[0].op, Operation::Create, "returns PatchInput[] shape directly");
	assert_eq!(direct[0].diff.as_deref(), Some("hi\n"), "returns PatchInput[] shape directly");
	let rename =
		parse_apply_patch(&wrap("*** Update File: a.py\n*** Move to: b.py\n@@\n-old\n+new"))
			.expect("maps update with rename to op=update + rename field");
	assert_eq!(rename[0].path, "a.py", "maps update with rename to op=update + rename field");
	assert_eq!(
		rename[0].op,
		Operation::Update,
		"maps update with rename to op=update + rename field"
	);
	assert_eq!(
		rename[0].rename.as_deref(),
		Some("b.py"),
		"maps update with rename to op=update + rename field"
	);
	assert!(
		rename[0]
			.diff
			.as_deref()
			.unwrap_or_default()
			.contains("-old"),
		"maps update with rename to op=update + rename field"
	);
	assert!(
		parse_apply_patch(&wrap(""))
			.expect("zero-hunk patch returns empty array")
			.is_empty(),
		"zero-hunk patch returns empty array"
	);
	let double_quoted = format!("<<\"EOF\"\n{}\nEOF", wrap("*** Add File: x.txt\n+content"));
	assert_eq!(
		parse_apply_patch(&double_quoted)
			.expect("heredoc wrapper with double quotes is stripped")
			.len(),
		1,
		"heredoc wrapper with double quotes is stripped"
	);
	let bare = format!("<<EOF\n{}\nEOF", wrap("*** Add File: x.txt\n+content"));
	assert_eq!(
		parse_apply_patch(&bare)
			.expect("heredoc wrapper with bare EOF is stripped")
			.len(),
		1,
		"heredoc wrapper with bare EOF is stripped"
	);
	let mismatched = format!("<<\"EOF'\n{}\nEOF", wrap("*** Add File: x.txt\n+content"));
	assert!(parse_apply_patch(&mismatched).is_err(), "mismatched heredoc quotes are not stripped");
	assert!(
		parse_apply_patch(&wrap("*** Rename File: a"))
			.unwrap_err()
			.to_string()
			.contains("is not a valid hunk header"),
		"unknown file directive is rejected with spec message"
	);
	let eof = parse_apply_patch(&wrap("*** Update File: a.py\n@@\n-x\n+y\n*** End of File"))
		.expect("preserves *** End of File marker inside update body");
	assert!(
		eof[0]
			.diff
			.as_deref()
			.unwrap_or_default()
			.contains("*** End of File"),
		"preserves *** End of File marker inside update body"
	);
}

#[test]
fn streaming_matcher_parity() {
	let patch = PatchEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 };
	let no_path = patch.inspect(&ArgSnapshot::default());
	assert!(no_path.paths.is_empty(), "returns undefined when no path is present");
	let patch_args = ArgSnapshot {
		path: Some("src/bar.ts".into()),
		edits: vec![EditEntry {
			op: Some("update".into()),
			diff: Some("@@\n+y".into()),
			closed: true,
			..Default::default()
		}],
		has_edits: true,
		complete: true,
		..Default::default()
	};
	let patch_inspection = patch.inspect(&patch_args);
	assert_eq!(
		patch_inspection.paths,
		["src/bar.ts"],
		"returns the top-level path for the patch strategy"
	);
	assert_eq!(
		patch_inspection.entries,
		[("src/bar.ts".into(), "y".into())],
		"replace + patch return one (path, digest) entry from the top-level path"
	);

	let apply = ApplyPatchEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 };
	let envelope = [
		"*** Begin Patch",
		"*** Update File: src/a.ts",
		"@@",
		"-old",
		"+new",
		"*** Add File: src/b.ts",
		"+created",
		"*** Delete File: src/c.ts",
		"*** End Patch",
	]
	.join("\n");
	let args = ArgSnapshot { input: Some(envelope), complete: true, ..Default::default() };
	assert_eq!(
		apply.inspect(&args).paths,
		["src/a.ts", "src/b.ts", "src/c.ts"],
		"extracts paths from Update / Add / Delete File markers"
	);
	let partial = ArgSnapshot {
		input: Some("*** Begin Patch\n*** Update File: src/partial.ts\n@@\n+wip".into()),
		complete: false,
		..Default::default()
	};
	assert_eq!(
		apply.inspect(&partial).paths,
		["src/partial.ts"],
		"recovers paths from a streaming partial envelope (no End Patch yet)"
	);
	assert!(
		apply.inspect(&ArgSnapshot::default()).paths.is_empty(),
		"returns undefined when the envelope carries no file markers yet"
	);

	let digest_args = ArgSnapshot {
		input: Some(
			"*** Begin Patch\n*** Update File: a.ts\n@@\n const a = 1;\n-const old = 1;\n+const \
			 fresh = 2;\n*** End Patch\n"
				.into(),
		),
		complete: true,
		..Default::default()
	};
	assert_eq!(
		apply.inspect(&digest_args).entries,
		[("a.ts".into(), "const fresh = 2;".into())],
		"apply_patch: digests added lines, never envelope markers or context"
	);
	let multi_entries = ArgSnapshot {
		input: Some(
			"*** Begin Patch\n*** Update File: src/a.ts\n@@\n-foo\n+const a = 1;\n*** Update File: \
			 README.md\n@@\n-old\n+# Heading\n*** End Patch\n"
				.into(),
		),
		complete: true,
		..Default::default()
	};
	assert_eq!(
		apply.inspect(&multi_entries).entries,
		[("src/a.ts".into(), "const a = 1;".into()), ("README.md".into(), "# Heading".into())],
		"apply_patch splits multi-hunk payloads into one entry per file"
	);
	assert!(
		apply
			.inspect(&ArgSnapshot { input: Some("*** Begin Patch\n".into()), ..Default::default() })
			.entries
			.is_empty(),
		"returns undefined when no entries are recoverable yet"
	);
	let patch_digest = ArgSnapshot {
		path: Some("digest.txt".into()),
		edits: vec![EditEntry {
			diff: Some(" ctx\n-removed line\n+added line\n".into()),
			closed: true,
			..Default::default()
		}],
		has_edits: true,
		complete: true,
		..Default::default()
	};
	assert_eq!(
		patch.inspect(&patch_digest).entries[0].1,
		"added line",
		"patch: digests added lines from diffs and passes create content through whole"
	);
	let delete_digest = ArgSnapshot {
		path: Some("digest.txt".into()),
		edits: vec![EditEntry {
			op: Some("delete".into()),
			diff: Some(" ctx\n-removed line\n".into()),
			closed: true,
			..Default::default()
		}],
		has_edits: true,
		complete: true,
		..Default::default()
	};
	assert_eq!(
		patch.inspect(&delete_digest).entries[0].1,
		"",
		"patch: digests added lines from diffs and passes create content through whole"
	);
	let create_content = "full file content\nwith no diff markers\n";
	let create_digest = ArgSnapshot {
		path: Some("digest.txt".into()),
		edits: vec![EditEntry {
			op: Some("create".into()),
			diff: Some(create_content.into()),
			closed: true,
			..Default::default()
		}],
		has_edits: true,
		complete: true,
		..Default::default()
	};
	assert_eq!(
		patch.inspect(&create_digest).entries[0].1,
		create_content,
		"patch: digests added lines from diffs and passes create content through whole"
	);
}

#[tokio::test]
async fn apply_patch_streaming_preview_parity() {
	let mut workspace = common::Workspace::new(EditMode::ApplyPatch);
	workspace.config.raw_input = true;
	workspace.write("a.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
	let build =
		|body: &str| format!("*** Begin Patch\n*** Update File: a.ts\n@@\n const a = 1;\n{body}");
	let mut streaming = workspace.session();
	streaming.push(&build("-const b = 2;\n+const b = 22"));
	let streaming_diff = streaming.preview().files[0]
		.diff
		.clone()
		.unwrap_or_default();
	streaming.finish();
	let final_diff = streaming.preview().files[0]
		.diff
		.clone()
		.unwrap_or_default();
	assert!(
		!streaming_diff.contains("const b = 22"),
		"ignores a half-typed trailing line while streaming"
	);
	assert!(
		final_diff.contains("const b = 22"),
		"ignores a half-typed trailing line while streaming"
	);

	let engine = ApplyPatchEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 };
	let args_a = ArgSnapshot {
		input: Some(build("-const b = 2;\n+const b = 22;\n")),
		complete: false,
		..Default::default()
	};
	let args_b = ArgSnapshot {
		input: Some(build("-const b = 2;\n+const b = 22;\n-const c = 3;\n")),
		complete: false,
		..Default::default()
	};
	let mut files_a = FileCache::new(workspace.config.policy.clone());
	let diff_a = engine.preview(&args_a, true, &mut files_a, &workspace.store)[0]
		.diff
		.clone()
		.unwrap_or_default();
	let mut files_b = FileCache::new(workspace.config.policy.clone());
	let diff_b = engine.preview(&args_b, true, &mut files_b, &workspace.store)[0]
		.diff
		.clone()
		.unwrap_or_default();
	let pos_a = diff_a
		.lines()
		.position(|line| line.contains("const b = 22;"))
		.expect("addition in frame A");
	let pos_b = diff_b
		.lines()
		.position(|line| line.contains("const b = 22;"))
		.expect("addition in frame B");
	assert_eq!(
		pos_b, pos_a,
		"preserves model's typing order so existing `+added` lines don't reshuffle"
	);
	let c_pos = diff_b
		.lines()
		.position(|line| line.starts_with("-const c"))
		.expect("new removal in frame B");
	assert!(
		c_pos > pos_b,
		"preserves model's typing order so existing `+added` lines don't reshuffle"
	);
}

#[test]
fn partial_json_edit_entries_parity() {
	let complete = pi_edit::stream_json::snapshot_from_text(
		r#"{"path":"a","edits":[{"op":"delete"},{"op":"delete"}]}"#,
		false,
		false,
	);
	assert_eq!(complete.edits.len(), 2, "keeps all entries when the trailing object is closed");
	assert!(
		complete.edits.iter().all(|entry| entry.closed),
		"keeps all entries when the trailing object is closed"
	);

	let trailing_open = pi_edit::stream_json::snapshot_from_text(
		r#"{"path":"a","edits":[{"op":"delete"},{"op":"delete""#,
		false,
		false,
	);
	assert_eq!(
		trailing_open.edits.len(),
		2,
		"drops the last entry when its closing }} has not arrived"
	);
	assert!(
		trailing_open.edits[0].closed,
		"drops the last entry when its closing }} has not arrived"
	);
	assert!(
		!trailing_open.edits[1].closed,
		"drops the last entry when its closing }} has not arrived"
	);

	let newly_opened = pi_edit::stream_json::snapshot_from_text(
		r#"{"path":"a","edits":[{"op":"delete"},{"op""#,
		false,
		false,
	);
	assert_eq!(
		newly_opened.edits.len(),
		2,
		"drops the last entry when a new {{}} has opened after the last close"
	);
	assert!(
		!newly_opened.edits[1].closed,
		"drops the last entry when a new {{}} has opened after the last close"
	);

	let empty = pi_edit::stream_json::snapshot_from_text(r#"{"edits":["#, false, false);
	assert!(empty.edits.is_empty(), "leaves empty edits alone");

	let mut absent = ArgStream::new(false);
	absent.push("{}");
	assert!(absent.snapshot().edits.is_empty(), "keeps all entries when partialJson is undefined");
}

#[test]
fn streaming_parser_accepts_partial_envelope() {
	let parsed =
		parse_apply_patch_streaming("*** Begin Patch\n*** Update File: src/partial.ts\n@@\n+wip")
			.expect("partial envelope");
	assert_eq!(parsed[0].path, "src/partial.ts");
}

#[test]
fn find_context_line_parity() {
	let exact = find_context_line(
		&["function foo() {", "  return 1;", "}"],
		"function foo() {",
		0,
		true,
		false,
	);
	assert_eq!(exact.index, Some(0), "finds exact context line");
	assert_eq!(exact.confidence, 1.0, "finds exact context line");
	let whitespace = find_context_line(
		&["  function foo()  {", "  return 1;", "}"],
		"function foo() {",
		0,
		true,
		false,
	);
	assert_eq!(whitespace.index, Some(0), "finds context line with whitespace differences");
	assert!(whitespace.confidence > 0.9, "finds context line with whitespace differences");
	assert_eq!(
		find_context_line(
			&["const msg = \"Hello – World\";", "return msg;"],
			"const msg = \"Hello - World\";",
			0,
			true,
			false
		)
		.index,
		Some(0),
		"finds context line with unicode normalization"
	);
	let prefix = find_context_line(
		&["function calculateTotalWithTax(items, taxRate) {", "  return 0;", "}"],
		"function calculateTotalWithTax(items",
		0,
		true,
		false,
	);
	assert_eq!(prefix.index, Some(0), "finds context line as prefix match");
	assert!(prefix.confidence > 0.9, "finds context line as prefix match");
	let substring = find_context_line(
		&["// comment: calculateTotal here", "function foo() {}"],
		"calculateTotal",
		0,
		true,
		false,
	);
	assert_eq!(substring.index, Some(0), "finds context line as substring match");
	assert!(substring.confidence > 0.9, "finds context line as substring match");
	let fuzzy = find_context_line(
		&["functoin calclateTotal(itms) {", "  return 0;", "}"],
		"function calculateTotal(items) {",
		0,
		true,
		false,
	);
	assert_eq!(fuzzy.index, Some(0), "falls back to fuzzy match for similar lines");
	assert!(fuzzy.confidence > 0.8, "falls back to fuzzy match for similar lines");
}

#[tokio::test]
async fn patch_file_outcome_text_and_snapshot_parity() {
	let update = common::Workspace::new(EditMode::Patch);
	update.write("foo.txt", "a\n");
	let outcome = update
		.apply_json(
			&serde_json::json!({"path":"foo.txt","edits":[{"op":"update","diff":"@@\n-a\n+b"}]}),
			&common::DiskWriter::default(),
		)
		.await
		.expect("update: oldText is pre-edit content, newText is post-edit content");
	let file = &outcome.files[0];
	assert_eq!(
		file.old_text.as_deref(),
		Some("a\n"),
		"update: oldText is pre-edit content, newText is post-edit content"
	);
	assert_eq!(
		file.new_text.as_deref(),
		Some("b\n"),
		"update: oldText is pre-edit content, newText is post-edit content"
	);
	assert!(
		!file.snapshots_pruned,
		"returns input unchanged when combined snapshot is under the budget"
	);
	assert_eq!(
		file.old_text.as_deref(),
		Some("a\n"),
		"returns input unchanged when combined snapshot is under the budget"
	);
	assert_eq!(
		file.new_text.as_deref(),
		Some("b\n"),
		"returns input unchanged when combined snapshot is under the budget"
	);
	assert!(
		file.diff.contains("-1|a"),
		"update: oldText is pre-edit content, newText is post-edit content"
	);
	assert!(
		file.diff.contains("+1|b"),
		"update: oldText is pre-edit content, newText is post-edit content"
	);
	assert_eq!(
		outcome.text, "[foo.txt]\n1:b",
		"update: oldText is pre-edit content, newText is post-edit content"
	);

	let create = common::Workspace::new(EditMode::Patch);
	let outcome = create
		.apply_json(
			&serde_json::json!({"path":"new.txt","edits":[{"op":"create","diff":"hello\n"}]}),
			&common::DiskWriter::default(),
		)
		.await
		.expect("create: oldText is undefined, newText is the created content");
	let file = &outcome.files[0];
	assert_eq!(file.old_text, None, "create: oldText is undefined, newText is the created content");
	assert_eq!(
		file.new_text.as_deref(),
		Some("hello\n"),
		"create: oldText is undefined, newText is the created content"
	);
	assert!(!file.diff.is_empty(), "create: oldText is undefined, newText is the created content");

	let delete = common::Workspace::new(EditMode::Patch);
	delete.write("gone.txt", "will be deleted\n");
	let outcome = delete
		.apply_json(
			&serde_json::json!({"path":"gone.txt","edits":[{"op":"delete"}]}),
			&common::DiskWriter::default(),
		)
		.await
		.expect("delete: oldText is prior content, newText is undefined");
	let file = &outcome.files[0];
	assert_eq!(
		file.old_text.as_deref(),
		Some("will be deleted\n"),
		"delete: oldText is prior content, newText is undefined"
	);
	assert_eq!(file.new_text, None, "delete: oldText is prior content, newText is undefined");
	assert!(!file.diff.is_empty(), "delete: oldText is prior content, newText is undefined");

	let create_update = common::Workspace::new(EditMode::Patch);
	let outcome = create_update
		.apply_json(
			&serde_json::json!({"path":"created.txt","edits":[
				{"op":"create","diff":"a\n"},
				{"op":"update","diff":"@@\n-a\n+b"}
			]}),
			&common::DiskWriter::default(),
		)
		.await
		.expect("create followed by update preserves create-shaped oldText");
	let file = &outcome.files[0];
	assert_eq!(file.old_text, None, "create followed by update preserves create-shaped oldText");
	assert_eq!(
		file.new_text.as_deref(),
		Some("b\n"),
		"create followed by update preserves create-shaped oldText"
	);
	assert!(!file.diff.is_empty(), "create followed by update preserves create-shaped oldText");

	let update_delete = common::Workspace::new(EditMode::Patch);
	update_delete.write("updated-then-gone.txt", "a\n");
	let outcome = update_delete
		.apply_json(
			&serde_json::json!({"path":"updated-then-gone.txt","edits":[
				{"op":"update","diff":"@@\n-a\n+b"},
				{"op":"delete"}
			]}),
			&common::DiskWriter::default(),
		)
		.await
		.expect("update followed by delete preserves delete-shaped newText");
	let file = &outcome.files[0];
	assert_eq!(
		file.old_text.as_deref(),
		Some("a\n"),
		"update followed by delete preserves delete-shaped newText"
	);
	assert_eq!(file.new_text, None, "update followed by delete preserves delete-shaped newText");
	assert!(!file.diff.is_empty(), "update followed by delete preserves delete-shaped newText");
}

#[tokio::test]
async fn oversized_patch_outcome_prunes_snapshots_but_keeps_diff() {
	let filler = format!("{}\n", "a line of content xxxx yyyy zzzz".repeat(20)).repeat(2_000);
	let workspace = common::Workspace::new(EditMode::Patch);
	workspace.write("big.txt", &format!("{filler}anchor\n{filler}"));
	let outcome = workspace
		.apply_json(
			&serde_json::json!({"path":"big.txt","edits":[{"op":"update","diff":"@@\n-anchor\n+ANCHOR"}]}),
			&common::DiskWriter::default(),
		)
		.await
		.expect("prunes oldText / newText while keeping diff and path");
	let file = &outcome.files[0];
	assert!(file.snapshots_pruned, "prunes oldText / newText while keeping diff and path");
	assert!(
		file.snapshots_pruned,
		"drops oldText and newText when combined size exceeds the budget"
	);
	assert_eq!(file.old_text, None, "prunes oldText / newText while keeping diff and path");
	assert_eq!(
		file.old_text, None,
		"drops oldText and newText when combined size exceeds the budget"
	);
	assert_eq!(file.new_text, None, "prunes oldText / newText while keeping diff and path");
	assert_eq!(
		file.new_text, None,
		"drops oldText and newText when combined size exceeds the budget"
	);
	assert!(file.diff.contains("|anchor"), "prunes oldText / newText while keeping diff and path");
	assert!(file.diff.contains("|ANCHOR"), "prunes oldText / newText while keeping diff and path");
}

#[tokio::test]
async fn multi_file_outcomes_prune_independently() {
	let filler = format!("{}\n", "a line of content xxxx yyyy zzzz".repeat(20)).repeat(2_000);
	let workspace = common::Workspace::new(EditMode::ApplyPatch);
	workspace.write("big.txt", &format!("{filler}anchor\n{filler}"));
	workspace.write("small.txt", "tiny\n");
	let patch = "*** Begin Patch\n*** Update File: big.txt\n@@\n-anchor\n+ANCHOR\n*** Update File: \
	             small.txt\n@@\n-tiny\n+TINY\n*** End Patch";
	let outcome = workspace
		.apply_raw(patch, &common::DiskWriter::default())
		.await
		.expect("prunes snapshots inside perFileResults independently of the aggregate");
	assert_eq!(
		outcome.files.len(),
		2,
		"prunes snapshots inside perFileResults independently of the aggregate"
	);
	assert!(
		outcome.files[0].snapshots_pruned,
		"prunes snapshots inside perFileResults independently of the aggregate"
	);
	assert_eq!(
		outcome.files[0].old_text, None,
		"prunes snapshots inside perFileResults independently of the aggregate"
	);
	assert_eq!(
		outcome.files[0].new_text, None,
		"prunes snapshots inside perFileResults independently of the aggregate"
	);
	assert!(
		!outcome.files[1].snapshots_pruned,
		"prunes snapshots inside perFileResults independently of the aggregate"
	);
	assert_eq!(
		outcome.files[1].old_text.as_deref(),
		Some("tiny\n"),
		"prunes snapshots inside perFileResults independently of the aggregate"
	);
	assert_eq!(
		outcome.files[1].new_text.as_deref(),
		Some("TINY\n"),
		"prunes snapshots inside perFileResults independently of the aggregate"
	);
}

#[tokio::test]
async fn mixed_size_patch_entries_preserve_pruned_aggregate_shape() {
	let filler = format!("{}\n", "a line of content xxxx yyyy zzzz".repeat(20)).repeat(2_000);
	let workspace = common::Workspace::new(EditMode::Patch);
	workspace.write("shrink.txt", &format!("{filler}TAIL\n"));
	let shrink_diff = format!(
		"@@\n{}\n+tiny",
		filler
			.trim_end()
			.lines()
			.map(|line| format!("-{line}"))
			.collect::<Vec<_>>()
			.join("\n")
	);
	let outcome = workspace
		.apply_json(
			&serde_json::json!({"path":"shrink.txt","edits":[
				{"op":"update","diff":shrink_diff},
				{"op":"update","diff":"@@\n-TAIL\n+DONE"}
			]}),
			&common::DiskWriter::default(),
		)
		.await
		.expect("pruned first-entry snapshots suppress aggregate snapshots from a later kept entry");
	let file = &outcome.files[0];
	assert!(
		file.snapshots_pruned,
		"pruned first-entry snapshots suppress aggregate snapshots from a later kept entry"
	);
	assert_eq!(
		file.old_text, None,
		"pruned first-entry snapshots suppress aggregate snapshots from a later kept entry"
	);
	assert_eq!(
		file.new_text, None,
		"pruned first-entry snapshots suppress aggregate snapshots from a later kept entry"
	);
	assert!(
		!file.diff.is_empty(),
		"pruned first-entry snapshots suppress aggregate snapshots from a later kept entry"
	);
}
