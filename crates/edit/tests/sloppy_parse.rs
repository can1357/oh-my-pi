mod common;

use common::{DiskWriter, Workspace};
use omp_edit::{
	EditMode, ModeEngine,
	files::FileCache,
	modes::sloppy::{
		SloppyEngine,
		parse::{
			extract_inline_sloppy_regions, ir_to_payload, normalize_input, operation_payload,
			parse_operations, split_sloppy_sections,
		},
		types::{OperationRewrite, Placement},
	},
	stream_json::ArgSnapshot,
};

fn message(input: &str, content: &str) -> String {
	parse_operations(input, content, "a.ts")
		.expect_err("payload must fail")
		.to_string()
}

#[test]
fn parses_delimited_multi_file_bare_and_all_sections() {
	let payload = [
		"*** edit file: src/config.ts",
		"*** find",
		"const timeout = 1000;",
		"*** replace",
		"const timeout = 5000;",
		"*** Edit File:",
		"*** Find",
		"const retries = 3;",
		"*** Replace",
		"const retries = 5;",
		"*** Edit File: src/catalog.ts all",
		"*** Find",
		"logger.debug(",
		"*** Replace",
		"logger.trace(",
	]
	.join("\n");
	let sections = split_sloppy_sections(&payload).unwrap();
	assert_eq!(
		sections
			.iter()
			.map(|section| section.path.as_str())
			.collect::<Vec<_>>(),
		["src/config.ts", "src/catalog.ts"]
	);
	let config = parse_operations(
		&sections[0].body,
		"const timeout = 1000;\nconst retries = 3;\n",
		"src/config.ts",
	)
	.unwrap();
	assert_eq!(config.len(), 2);
	assert!(config.iter().all(|operation| !operation.all));
	let catalog =
		parse_operations(&sections[1].body, "logger.debug(a);\nlogger.debug(b);\n", "src/catalog.ts")
			.unwrap();
	assert_eq!(catalog.len(), 1);
	assert!(catalog[0].all);
}

#[test]
fn accepts_begin_patch_and_trims_or_quotes_ambiguous_paths() {
	let sections = split_sloppy_sections(
		"*** Begin Patch\n*** Edit File: \" all \" all\n*** Find\nold\n*** Replace\nnew\n*** End \
		 Patch",
	)
	.unwrap();
	assert_eq!(sections.len(), 1);
	assert_eq!(sections[0].path, " all ");
	let operations = parse_operations(&sections[0].body, "old\n", " all ").unwrap();
	assert!(operations[0].all);
}

#[test]
fn headers_are_boundaries_only_when_the_whole_trimmed_line_is_recognized() {
	let input = concat!(
		"*** Edit File: src/a.ts\n*** Find\n",
		"old\n*** Replace trailing text\n<Replace>\nliteral\n",
		"*** Replace\nnew\n",
	);
	let sections = split_sloppy_sections(input).unwrap();
	let operations = parse_operations(
		&sections[0].body,
		"old\n*** Replace trailing text\n<Replace>\nliteral\n",
		"src/a.ts",
	)
	.unwrap();
	assert_eq!(operations[0].pattern_text, "old\n*** Replace trailing text\n<Replace>\nliteral");
	assert_eq!(operations[0].rewrite, OperationRewrite::Explicit { text: "new".to_owned() });
}

#[test]
fn empty_put_deletes_before_next_find_edit_and_eof() {
	for payload in [
		"*** Edit File: a.ts\n*** Find\nold\n*** Replace\n*** Find\nkeep\n*** Replace\nkept",
		"*** Edit File: a.ts\n*** Find\nold\n*** Replace\n*** Edit File: b.ts\n*** Find\nother\n*** \
		 Replace\nnext",
		"*** Edit File: a.ts\n*** Find\nold\n*** Replace",
	] {
		let section = &split_sloppy_sections(payload).unwrap()[0];
		let operation = &parse_operations(&section.body, "old\nkeep\n", "a.ts").unwrap()[0];
		assert_eq!(operation.pattern_text, "old");
		assert_eq!(operation.rewrite, OperationRewrite::Explicit { text: String::new() });
	}
}

#[test]
fn after_preserves_authored_blank_lines_without_a_terminal_phantom() {
	let with_blank = "*** Edit File: a.ts\n*** Find\nanchor\n*** Insert After\n\ninserted\n\n*** \
	                  Find\nnext\n*** Replace\nchanged";
	let sections = split_sloppy_sections(with_blank).unwrap();
	let operations = parse_operations(&sections[0].body, "anchor\nnext\n", "a.ts").unwrap();
	assert_eq!(operations[0].rewrite, OperationRewrite::Insert {
		text: "\ninserted\n\n".to_owned(),
		at:   Placement::After,
	});

	for payload in [
		"*** Edit File: a.ts\n*** Find\nanchor\n*** Insert After\ninserted",
		"*** Edit File: a.ts\n*** Find\nanchor\n*** Insert After\ninserted\n",
	] {
		let section = &split_sloppy_sections(payload).unwrap()[0];
		let operations = parse_operations(&section.body, "anchor\n", "a.ts").unwrap();
		assert_eq!(operations[0].rewrite, OperationRewrite::Insert {
			text: "inserted\n".to_owned(),
			at:   Placement::After,
		});
	}
}

#[test]
fn inline_regions_use_end_patch_as_an_explicit_prose_boundary() {
	let payload = "*** Edit File: src/a.ts\n*** Find\nold();\n*** Replace\nnew();";
	let text = format!("Before.\n{payload}\n*** End Patch\nAfter.");
	let regions = extract_inline_sloppy_regions(&text);
	assert_eq!(regions.len(), 1);
	assert_eq!(regions[0].payload, payload);
	let utf16: Vec<u16> = text.encode_utf16().collect();
	let excised =
		String::from_utf16(&[&utf16[..regions[0].start], &utf16[regions[0].end..]].concat()).unwrap();
	assert_eq!(excised, "Before.\n*** End Patch\nAfter.");
}

#[test]
fn inline_region_without_an_explicit_boundary_runs_to_eof() {
	let payload = "*** Edit File: src/a.ts\n*** Find\nold();\n*** Replace\nnew();";
	let text = format!("Before.\n{payload}");
	let region = &extract_inline_sloppy_regions(&text)[0];
	assert_eq!(region.payload, payload);
	assert_eq!(region.end, text.encode_utf16().count());
}

#[test]
fn extracts_disjoint_regions_with_explicit_boundaries_and_utf16_offsets() {
	let first = "*** Edit File: a.ts\n*** Find\none();\n*** Replace\ntwo();";
	let second = "*** Edit File: b.ts\n*** Find\nred();\n*** Replace\nblue();";
	let prefix = "Before 🦀.\n";
	let text = format!("{prefix}{first}\n*** End Patch\nBetween.\n{second}");
	let regions = extract_inline_sloppy_regions(&text);
	assert_eq!(regions.len(), 2);
	assert_eq!(regions[0].start, prefix.encode_utf16().count());
	assert_eq!(regions[0].payload, first);
	assert_eq!(regions[1].payload, second);
}

#[test]
fn ignores_payloads_quoted_in_markdown_fences() {
	let text =
		["```text", "*** Edit File: src/a.ts", "*** Find", "old", "*** Replace", "new", "```"]
			.join("\n");
	assert!(extract_inline_sloppy_regions(&text).is_empty());
}

#[test]
fn split_sections_coalesces_repeated_paths_in_order() {
	let sections = split_sloppy_sections(concat!(
		"*** Edit File: src/a.ts\n*** Find\none\n*** Replace\n1\n",
		"*** Edit File: src/b.ts\n*** Find\ntwo\n*** Replace\n2\n",
		"*** Edit File: src/a.ts\n*** Find\nthree\n*** Replace\n3",
	))
	.unwrap();
	assert_eq!(
		sections
			.iter()
			.map(|section| section.path.as_str())
			.collect::<Vec<_>>(),
		["src/a.ts", "src/b.ts"]
	);
	assert!(sections[0].body.find("three") > sections[0].body.find("one"));
}

#[test]
fn old_xml_looking_lines_are_literal_body_content() {
	let input = concat!(
		"*** Edit File: src/a.ts\n*** Find\n",
		"const marker = \"<Replace>\";\n</Find>\n",
		"*** Replace\nconst marker = \"literal\";",
	);
	let sections = split_sloppy_sections(input).unwrap();
	let operations =
		parse_operations(&sections[0].body, "const marker = \"<Replace>\";\n</Find>\n", "src/a.ts")
			.unwrap();
	assert_eq!(operations[0].rewrite, OperationRewrite::Explicit {
		text: "const marker = \"literal\";".to_owned(),
	});
}

#[test]
fn returns_empty_without_a_pathful_leading_edit_header() {
	assert!(
		split_sloppy_sections("*** Find\nold\n*** Replace\nnew")
			.unwrap()
			.is_empty()
	);
	assert!(
		split_sloppy_sections("*** Edit File:\n*** Find\nold")
			.unwrap()
			.is_empty()
	);
}

#[test]
fn a_second_operator_on_one_find_is_rejected_instead_of_discarding_the_staged_body() {
	let error = split_sloppy_sections(concat!(
		"*** Edit File: src/a.ts\n*** Find\nold\n*** Insert Before\nstaged\n",
		"*** Replace\nnew\n",
	))
	.unwrap_err();
	let message = error.to_string();
	assert!(message.contains("*** Insert Before"), "{message}");
	assert!(message.contains("*** Replace"), "{message}");

	// The mirrored order names the same two operators.
	let reversed = split_sloppy_sections(concat!(
		"*** Edit File: src/a.ts\n*** Find\nold\n*** Replace\nnew\n",
		"*** Insert After\nstaged\n",
	))
	.unwrap_err()
	.to_string();
	assert!(reversed.contains("*** Replace"), "{reversed}");
	assert!(reversed.contains("*** Insert After"), "{reversed}");
}

#[test]
fn conflicting_operators_payload_is_still_an_inline_region_for_the_pipeline_to_report() {
	let payload = concat!(
		"*** Edit File: src/a.ts\n*** Find\nold\n*** Insert Before\nstaged\n",
		"*** Replace\nnew\n",
	);
	let text = format!("Before.\n{payload}*** End Patch\nAfter.");
	let regions = extract_inline_sloppy_regions(&text);
	assert_eq!(regions.len(), 1);
	assert_eq!(regions[0].payload, payload.trim_end_matches('\n'));
}

#[test]
fn optional_patch_envelope_is_silent_during_normalization() {
	let input = "\n```text\n*** Begin Patch\n*** Edit File:\n*** Find\nold\n*** Replace\nnew\n*** \
	             End Patch\n```";
	assert_eq!(normalize_input(input).unwrap(), "«\nold\n»\nnew");
}

#[tokio::test]
async fn a_plain_find_without_an_action_rejects_the_whole_call_before_writes() {
	let workspace = Workspace::new(EditMode::Sloppy);
	let content = "const result = computeValue();\nreport(result);\n";
	workspace.write("a.ts", content);
	workspace.write("b.ts", "one();\n");
	let writer = DiskWriter::default();
	for input in [
		// Exact context, a plausible near-match, and purported old/new text.
		"*** Edit File: a.ts\n*** Find\nconst result = computeValue();\nreport(result);",
		"*** Edit File: a.ts\n*** Find all\nconst result = computeValues();",
		"*** Edit File: a.ts\n*** Find\nreport(result);\nreport(other);",
		// Earlier completed work (including another file) cannot be staged.
		"*** Edit File: b.ts\n*** Find\none();\n*** Replace\ntwo();\n*** Edit File: a.ts\n*** \
		 Find\nconst result = computeValue();",
		// The next Find cannot stand in for a missing action, even if empty.
		"*** Edit File: a.ts\n*** Find\n*** Find\nreport(result);\n*** Replace\nlog(result);",
		"*** Edit File: a.ts\n*** Find\nreport(result);\n*** Edit File: b.ts\n*** Find\none();\n*** \
		 Replace\ntwo();",
	] {
		let error = workspace
			.apply_raw(input, &writer)
			.await
			.unwrap_err()
			.to_string();
		assert!(error.contains("Send one complete pair"), "{error}");
		assert!(!error.contains("computeValue") && !error.contains("report("), "{error}");
		assert!(writer.requests.lock().is_empty());
		assert_eq!(workspace.read("a.ts").as_deref(), Some(content));
		assert_eq!(workspace.read("b.ts").as_deref(), Some("one();\n"));
	}
}

#[test]
fn an_incomplete_find_is_reported_by_both_normalization_and_inline_extraction() {
	let input = "*** Edit File: a.ts\n*** Find\nold\n*** Replace\nnew\n*** Find\ncontext";
	assert!(message(input, "old\ncontext\n").contains("Send one complete pair"));
	let regions = extract_inline_sloppy_regions(input);
	assert_eq!(regions.len(), 1);
	assert_eq!(regions[0].payload, input);
}

#[test]
fn an_embedded_edit_stays_one_operation_across_both_normalization_passes() {
	let input = "*** Edit File: a.ts\n*** Find all\nbefore\n«\nvalue = \u{27ea}1│2\u{27eb}";
	let sections = split_sloppy_sections(input).unwrap();
	let ops = parse_operations(&sections[0].body, "before\n«\nvalue = 1\n", "a.ts").unwrap();
	assert_eq!(ops.len(), 1);
	assert!(ops[0].all);
	assert_eq!(ops[0].pattern_text, "before\n«\nvalue = \u{27ea}1\u{27eb}");
	assert!(
		matches!(&ops[0].rewrite, OperationRewrite::Inline { replacements } if replacements == &["2"])
	);
}

#[test]
fn block_selectors_and_replacements_round_trip_as_literal_data() {
	let selector = "  fn open(arg: \"»1 …\"): {  ";
	let replacement = "«\n»9\n＋literal\n…\n";
	let input = format!("*** Edit File: a.ts\n*** Replace Block: {selector}\n{replacement}\n");
	let sections = split_sloppy_sections(&input).unwrap();
	let ops = parse_operations(&sections[0].body, "", "a.ts").unwrap();
	assert_eq!(ops.len(), 1);
	let op = &ops[0];
	assert!(op.block && !op.all);
	assert_eq!(op.pattern_text, selector);
	assert_eq!(op.rewrite, OperationRewrite::Explicit { text: replacement.to_owned() });
	let rendered = ir_to_payload(&sections[0].body.lines().collect::<Vec<_>>(), "a.ts");
	assert_eq!(rendered, input);
	let corrected = operation_payload(op, "a.ts", true, Some("ignore fuzzy suggestions"));
	assert_eq!(parse_operations(&corrected, "", "a.ts").unwrap(), ops);
	let regions = extract_inline_sloppy_regions(&format!("Before.\n{input}*** End Patch\nAfter."));
	assert_eq!(parse_operations(&regions[0].payload, "", "a.ts").unwrap(), ops);
}

#[test]
fn block_moves_link_to_the_cut_operation_without_copying_its_selector() {
	for (paste, at) in [("Paste Before", Placement::Before), ("Paste After", Placement::After)] {
		let input = format!(
			"*** Edit File: a.ts\n*** Find all\nold\n*** Replace\nnew\n*** Cut Block: function \
			 first\n*** {paste} Block: function last\n*** Delete Block: function unused\n"
		);
		let ops = parse_operations(&input, "old\n", "a.ts").unwrap();
		assert_eq!(ops.len(), 4);
		assert!(ops[0].all && !ops[0].block);
		assert!(ops[1..].iter().all(|op| op.block && !op.all));
		assert_eq!(ops[1].rewrite, OperationRewrite::Cut);
		assert_eq!(ops[2].rewrite, OperationRewrite::Paste { cut: 2, at });
		assert_eq!(ops[3].rewrite, OperationRewrite::Explicit { text: String::new() });
		let rendered = ops
			.iter()
			.map(|op| operation_payload(op, "a.ts", op.all, None))
			.collect::<Vec<_>>()
			.join("\n");
		assert_eq!(parse_operations(&rendered, "old\n", "a.ts").unwrap(), ops);
		assert_eq!(
			operation_payload(&ops[3], "a.ts", false, None),
			"*** Edit File: a.ts\n*** Delete Block: function unused\n"
		);
		let ir = normalize_input(&input).unwrap();
		let payload = ir_to_payload(&ir.lines().collect::<Vec<_>>(), "a.ts");
		assert_eq!(parse_operations(&payload, "old\n", "a.ts").unwrap(), ops);
	}
}

#[test]
fn a_structural_header_requires_a_supported_action_and_one_literal_selector() {
	for (body, diagnostic) in [
		("*** Block\nfunction first", "standalone *** Block"),
		("*** Block\nfirst\n*** Replace\nnew", "standalone *** Block"),
		("*** Delete Block:  \t", "nonblank opening-line prefix"),
		("*** Replace Block first\nnew", "colon"),
		("*** Insert Before Block: first\nnew", "for insertion use *** Find"),
		("*** Insert Block: first\nnew", "for insertion use *** Find"),
		("*** Replace Block: first\nnew\n*** Insert After\nnew", "already names its action"),
		("*** Replace Block: first\n*** Find\nx\n*** Replace\ny", "nonempty replacement body"),
	] {
		let input = format!("*** Edit File: a.ts\n{body}");
		assert!(message(&input, "").contains(diagnostic), "{input}");
	}
	for action in ["Cut", "Paste Before", "Paste After", "Delete", "Replace"] {
		let input = format!("*** Edit File: a.ts all\n*** {action} Block: function first");
		assert!(message(&input, "").contains("drop all"), "{input}");
	}
	for action in ["Cut", "Paste Before", "Paste After", "Delete"] {
		let input = format!("*** Edit File: a.ts\n*** {action} Block: function first\nstray");
		assert_eq!(
			message(&input, ""),
			format!(
				"Invalid block edit: *** {action} Block takes no body. Start the next operation with \
				 a new header."
			)
		);
		let regions =
			extract_inline_sloppy_regions(&format!("Before.\n{input}\n*** End Patch\nAfter."));
		assert_eq!(regions[0].payload, input);
	}
}

#[tokio::test]
async fn incomplete_block_replacement_never_becomes_a_deletion() {
	let workspace = Workspace::new(EditMode::Sloppy);
	let content = "alpha\nfunction keep() {\n  beta();\n}\n";
	workspace.write("a.ts", content);
	let input = "*** Edit File: a.ts\n*** Find\nalpha\n*** Replace\nALPHA\n*** Replace Block: \
	             function keep";
	let partial = ArgSnapshot { input: Some(input.to_owned()), ..ArgSnapshot::default() };
	let engine = SloppyEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 };
	let mut files = FileCache::new(workspace.config.policy.clone());
	let preview = engine.preview(&partial, true, &mut files, &workspace.store);
	let diff = preview[0].diff.as_deref().expect("finished Find should preview");
	assert!(diff.contains("+1|ALPHA") && !diff.contains("-2|function keep"), "{diff}");
	let writer = DiskWriter::default();
	let error = workspace
		.apply_raw(input, &writer)
		.await
		.unwrap_err()
		.to_string();
	assert!(error.contains("*** Replace Block needs a nonempty replacement body"), "{error}");
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("a.ts").as_deref(), Some(content));
	assert_eq!(extract_inline_sloppy_regions(input)[0].payload, input);
}

#[test]
fn truncated_register_rewrite_returns_a_parseable_all_match_skeleton() {
	let error = message("«*\nenwlineIndex\n»1", "const first = enwlineIndex;\n");
	let start = error.find("*** Edit File:").expect("copy-ready payload");
	let completed = error[start..].replace("{final text}", "newlineIndex");
	let sections = split_sloppy_sections(&completed).unwrap();
	let operations =
		parse_operations(&sections[0].body, "const first = enwlineIndex;\n", "a.ts").unwrap();
	assert_eq!(operations.len(), 1);
	assert!(operations[0].all);
	assert_eq!(operations[0].pattern_text, "enwlineIndex");
}

#[test]
fn rejects_a_numbered_internal_opener() {
	assert!(
		parse_operations(
			"«2\nreturn value;\n»\nreturn nextValue;",
			"function first() {\n  return value;\n}\n",
			"a.ts",
		)
		.is_err()
	);
}

#[test]
fn rejects_malformed_markers_and_register_references() {
	for input in [
		"«\nconst ⟪value│next\n»\nnext",
		"«\nconst ⟪value│next⟫⟫\n»\nnext",
		"«\nconst value = oldValue;\n»2 extra",
		"«\nconst first = oldFirst;\n»\n»1",
		"«\nconst first = oldFirst;\n»\n»2\n«\nconst second = oldSecond;\n»",
		"«\n»1\n»\nnext",
	] {
		assert!(
			parse_operations(
				input,
				"const value = oldValue;\nconst first = oldFirst;\nconst second = oldSecond;\n",
				"a.ts",
			)
			.is_err()
		);
	}
}
#[test]
fn parses_marker_add_runs_as_inline_insertions_without_consuming_the_next_anchor_twice() {
	let operations =
		parse_operations("«\nfirst();\n＋added();\nlast();", "first();\nlast();\n", "a.ts").unwrap();
	assert_eq!(operations.len(), 1);
	assert!(
		matches!(&operations[0].rewrite, OperationRewrite::Inline { replacements } if replacements == &["added();\n".to_owned()])
	);
	assert_eq!(operations[0].pattern_text, "first();\n\u{27ea}\u{27eb}last();");
}

#[test]
fn recovers_a_rewrite_written_as_a_selection_directive_list() {
	let operations = parse_operations(
		"«\nconst value = oldValue;\n»\n⟪oldValue│newValue⟫",
		"const value = oldValue;\n",
		"a.ts",
	)
	.unwrap();
	assert_eq!(operations.len(), 1);
	assert!(
		matches!(&operations[0].rewrite, OperationRewrite::Inline { replacements } if replacements == &["newValue".to_owned()])
	);
}

#[test]
fn recovers_a_stray_close_typed_as_an_inline_divider() {
	let operations =
		parse_operations("«\nconst \u{27ea}old\u{27eb}new\u{27eb};", "const old;\n", "a.ts").unwrap();
	assert_eq!(operations[0].pattern_text, "const \u{27ea}old\u{27eb};");
	assert!(
		matches!(&operations[0].rewrite, OperationRewrite::Inline { replacements } if replacements == &["new".to_owned()])
	);
}

#[test]
fn auto_splits_a_uniquely_matching_match_prefix_from_an_omitted_separator() {
	let operations = parse_operations(
		"«\nconst value = oldValue;\nconst value = newValue;",
		"const value = oldValue;\nreport(value);\n",
		"a.ts",
	)
	.unwrap();
	assert_eq!(operations[0].pattern_text, "const value = oldValue;");
	assert!(
		matches!(&operations[0].rewrite, OperationRewrite::Explicit { text } if text == "const value = newValue;")
	);
}

#[test]
fn recovers_guillemets_used_as_brackets_around_old_and_new_blocks() {
	let operations = parse_operations(
		"«\nconst first = old;\n»\n«\nconst first = new;\n»",
		"const first = old;\n",
		"a.ts",
	)
	.unwrap();
	assert_eq!(operations.len(), 1);
	assert_eq!(operations[0].pattern_text, "const first = old;");
	assert!(
		matches!(&operations[0].rewrite, OperationRewrite::Explicit { text } if text == "const first = new;")
	);
}

#[test]
fn ir_to_payload_preserves_operation_boundaries_all_and_terminal_newline() {
	assert_eq!(
		ir_to_payload(&["«*", "old", "»", "new", "«", "x"], "a.ts"),
		concat!(
			"*** Edit File: a.ts\n*** Find all\nold\n",
			"*** Replace\nnew\n*** Edit File: a.ts\n",
			"*** Find\nx\n",
		)
	);
}

/// `read` emits three truncation-notice families, and a projection copied into
/// an edit body must lose all of them alike. The `[N more lines in ...]` family
/// used to survive normalization, so the copied row became part of the matched
/// pattern -- and of the text written back -- instead of being dropped like the
/// other two. Each label names a different entity read can truncate.
#[test]
fn drops_a_copied_more_lines_notice_like_the_other_read_notices() {
	for notice in [
		"[Showing lines 1-2 of 8. Use :3 to continue]",
		"[6 more lines in file. Use :3 to continue]",
		"[6 more lines in notebook. Use :3 to continue]",
		"[6 more lines in archive entry. Use :3 to continue]",
		"[6 more lines in artifact. Use https://omp.sh/a:3 to continue]",
		"[More lines in artifact (1.2 MB total; not scanned to EOF). Use https://omp.sh/a:3 to \
		 continue]",
		"[\u{2026}6ln elided; re-read needed ranges with a.txt:3-8]",
	] {
		let payload = [
			"*** Edit File: a.txt",
			"*** Find",
			"keep a",
			"keep b",
			notice,
			"*** Replace",
			"keep a",
			"changed b",
			notice,
		]
		.join("\n");
		let operations = parse_operations(&payload, "keep a\nkeep b\n", "a.ts")
			.unwrap_or_else(|error| panic!("{notice} defeated matching: {error}"));
		assert_eq!(
			operations[0].pattern_text, "keep a\nkeep b",
			"the copied row reached the pattern: {notice}"
		);
		assert_eq!(
			operations[0].rewrite,
			OperationRewrite::Explicit { text: "keep a\nchanged b".to_owned() },
			"the copied row reached the rewrite: {notice}"
		);
	}
}

/// Only read's actual notice shape counts: a label, then `. Use ... to
/// continue`. Ordinary content that merely contains the phrase has to survive,
/// or the filter would silently delete real lines from the pattern or the
/// rewrite.
#[test]
fn keeps_content_that_only_resembles_a_more_lines_notice() {
	for line in ["[3 more lines in the appendix]", "[More lines in artifact]"] {
		let payload =
			["*** Edit File: a.txt", "*** Find", "keep a", line, "*** Replace", "keep b", line]
				.join("\n");
		let operations = parse_operations(&payload, &format!("keep a\n{line}\n"), "a.ts")
			.unwrap_or_else(|error| panic!("{line} broke matching: {error}"));
		assert_eq!(
			operations[0].pattern_text,
			format!("keep a\n{line}"),
			"a content line was filtered as a notice: {line}"
		);
		assert_eq!(
			operations[0].rewrite,
			OperationRewrite::Explicit { text: format!("keep b\n{line}") },
			"a content line was filtered out of the rewrite: {line}"
		);
	}
}
