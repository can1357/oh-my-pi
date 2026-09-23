use pi_edit::modes::sloppy::{
	parse::{
		extract_inline_sloppy_regions, ir_to_payload, normalize_input, parse_operations,
		split_sloppy_sections,
	},
	types::OperationRewrite,
};

fn message(input: &str, content: &str) -> String {
	parse_operations(input, content, "a.ts")
		.expect_err("payload must fail")
		.to_string()
}

#[test]
fn parses_delimited_multi_file_bare_and_all_sections() {
	let payload = [
		"*** sm:edit src/config.ts",
		"*** sm:find",
		"const timeout = 1000;",
		"*** sm:put",
		"const timeout = 5000;",
		"*** SM:EDIT",
		"*** SM:FIND",
		"const retries = 3;",
		"*** SM:PUT",
		"const retries = 5;",
		"*** SM:EDIT src/catalog.ts all",
		"*** SM:FIND",
		"logger.debug(",
		"*** SM:PUT",
		"logger.trace(",
	]
	.join("\n");
	let sections = split_sloppy_sections(&payload);
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
		"*** Begin Patch\n*** SM:EDIT \" all \" all\n*** SM:FIND\nold\n*** SM:PUT\nnew\n*** End \
		 Patch",
	);
	assert_eq!(sections.len(), 1);
	assert_eq!(sections[0].path, " all ");
	let operations = parse_operations(&sections[0].body, "old\n", " all ").unwrap();
	assert!(operations[0].all);
}

#[test]
fn headers_are_boundaries_only_when_the_whole_trimmed_line_is_recognized() {
	let input = concat!(
		"*** SM:EDIT src/a.ts\n*** SM:FIND\n",
		"old\n*** SM:PUT trailing text\n<SM:PUT>\nliteral\n",
		"*** SM:PUT\nnew\n",
	);
	let sections = split_sloppy_sections(input);
	let operations = parse_operations(
		&sections[0].body,
		"old\n*** SM:PUT trailing text\n<SM:PUT>\nliteral\n",
		"src/a.ts",
	)
	.unwrap();
	assert_eq!(operations[0].pattern_text, "old\n*** SM:PUT trailing text\n<SM:PUT>\nliteral");
	assert_eq!(operations[0].rewrite, OperationRewrite::Explicit { text: "new".to_owned() });
}

#[test]
fn empty_put_deletes_before_next_find_edit_and_eof() {
	for payload in [
		"*** SM:EDIT a.ts\n*** SM:FIND\nold\n*** SM:PUT\n*** SM:FIND\nkeep\n*** SM:PUT\nkept",
		"*** SM:EDIT a.ts\n*** SM:FIND\nold\n*** SM:PUT\n*** SM:EDIT b.ts\n*** SM:FIND\nother\n*** \
		 SM:PUT\nnext",
		"*** SM:EDIT a.ts\n*** SM:FIND\nold\n*** SM:PUT",
	] {
		let section = &split_sloppy_sections(payload)[0];
		let operation = &parse_operations(&section.body, "old\nkeep\n", "a.ts").unwrap()[0];
		assert_eq!(operation.pattern_text, "old");
		assert_eq!(operation.rewrite, OperationRewrite::Explicit { text: String::new() });
	}
}

#[test]
fn after_preserves_authored_blank_lines_without_a_terminal_phantom() {
	let with_blank = "*** SM:EDIT a.ts\n*** SM:FIND\nanchor\n*** SM:AFTER\n\ninserted\n\n*** \
	                  SM:FIND\nnext\n*** SM:PUT\nchanged";
	let sections = split_sloppy_sections(with_blank);
	let operations = parse_operations(&sections[0].body, "anchor\nnext\n", "a.ts").unwrap();
	assert_eq!(operations[0].rewrite, OperationRewrite::After { text: "\ninserted\n\n".to_owned() });

	for payload in [
		"*** SM:EDIT a.ts\n*** SM:FIND\nanchor\n*** SM:AFTER\ninserted",
		"*** SM:EDIT a.ts\n*** SM:FIND\nanchor\n*** SM:AFTER\ninserted\n",
	] {
		let section = &split_sloppy_sections(payload)[0];
		let operations = parse_operations(&section.body, "anchor\n", "a.ts").unwrap();
		assert_eq!(operations[0].rewrite, OperationRewrite::After { text: "inserted\n".to_owned() });
	}
}

#[test]
fn inline_regions_use_end_patch_as_an_explicit_prose_boundary() {
	let payload = "*** SM:EDIT src/a.ts\n*** SM:FIND\nold();\n*** SM:PUT\nnew();";
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
	let payload = "*** SM:EDIT src/a.ts\n*** SM:FIND\nold();\n*** SM:PUT\nnew();";
	let text = format!("Before.\n{payload}");
	let region = &extract_inline_sloppy_regions(&text)[0];
	assert_eq!(region.payload, payload);
	assert_eq!(region.end, text.encode_utf16().count());
}

#[test]
fn extracts_disjoint_regions_with_explicit_boundaries_and_utf16_offsets() {
	let first = "*** SM:EDIT a.ts\n*** SM:FIND\none();\n*** SM:PUT\ntwo();";
	let second = "*** SM:EDIT b.ts\n*** SM:FIND\nred();\n*** SM:PUT\nblue();";
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
	let text = ["```text", "*** SM:EDIT src/a.ts", "*** SM:FIND", "old", "*** SM:PUT", "new", "```"]
		.join("\n");
	assert!(extract_inline_sloppy_regions(&text).is_empty());
}

#[test]
fn split_sections_coalesces_repeated_paths_in_order() {
	let sections = split_sloppy_sections(concat!(
		"*** SM:EDIT src/a.ts\n*** SM:FIND\none\n*** SM:PUT\n1\n",
		"*** SM:EDIT src/b.ts\n*** SM:FIND\ntwo\n*** SM:PUT\n2\n",
		"*** SM:EDIT src/a.ts\n*** SM:FIND\nthree\n*** SM:PUT\n3",
	));
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
		"*** SM:EDIT src/a.ts\n*** SM:FIND\n",
		"const marker = \"<SM:PUT>\";\n</SM:FIND>\n",
		"*** SM:PUT\nconst marker = \"literal\";",
	);
	let sections = split_sloppy_sections(input);
	let operations =
		parse_operations(&sections[0].body, "const marker = \"<SM:PUT>\";\n</SM:FIND>\n", "src/a.ts")
			.unwrap();
	assert_eq!(operations[0].rewrite, OperationRewrite::Explicit {
		text: "const marker = \"literal\";".to_owned(),
	});
}

#[test]
fn returns_empty_without_a_pathful_leading_edit_header() {
	assert!(split_sloppy_sections("*** SM:FIND\nold\n*** SM:PUT\nnew").is_empty());
	assert!(split_sloppy_sections("*** SM:EDIT\n*** SM:FIND\nold").is_empty());
}

#[test]
fn optional_patch_envelope_is_silent_during_normalization() {
	let input = "\n```text\n*** Begin Patch\n*** SM:EDIT\n*** SM:FIND\nold\n*** SM:PUT\nnew\n*** \
	             End Patch\n```";
	assert_eq!(normalize_input(input), "«\nold\n»\nnew");
}

#[test]
fn copy_ready_correction_preserves_the_complete_atomic_payload() {
	let content = "const a = 1;\nkeep();\n";
	let input = "*** SM:EDIT a.ts\n*** SM:FIND\nconst a = 1;\n*** SM:PUT\nconst a = 2;\n*** \
	             SM:EDIT\n*** SM:FIND\nkeep();";
	let error = message(input, content);
	let start = error.find("*** SM:EDIT").expect("copy-ready payload");
	let completed = error[start..].replace("{new text}", "changed();");
	let sections = split_sloppy_sections(&completed);
	assert_eq!(sections.len(), 1);
	let operations = parse_operations(&sections[0].body, content, "a.ts").unwrap();
	assert_eq!(operations.len(), 2);
	assert_eq!(operations[0].pattern_text, "const a = 1;");
	assert_eq!(operations[1].pattern_text, "keep();");
}

#[test]
fn truncated_register_rewrite_returns_a_parseable_all_match_skeleton() {
	let error = message("«*\nenwlineIndex\n»1", "const first = enwlineIndex;\n");
	let start = error.find("*** SM:EDIT").expect("copy-ready payload");
	let completed = error[start..].replace("{final text}", "newlineIndex");
	let sections = split_sloppy_sections(&completed);
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
			"*** SM:EDIT a.ts all\n*** SM:FIND\nold\n",
			"*** SM:PUT\nnew\n*** SM:EDIT a.ts\n",
			"*** SM:FIND\nx\n",
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
			"*** SM:EDIT a.txt",
			"*** SM:FIND",
			"keep a",
			"keep b",
			notice,
			"*** SM:PUT",
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
			["*** SM:EDIT a.txt", "*** SM:FIND", "keep a", line, "*** SM:PUT", "keep b", line]
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
