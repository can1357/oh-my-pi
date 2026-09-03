use pi_edit::modes::sloppy::{
	parse::{
		extract_inline_sloppy_regions, ir_to_xml, normalize_input, parse_operations,
		split_sloppy_sections, strip_envelope_noise,
	},
	types::OperationRewrite,
};

fn message(input: &str, content: &str) -> String {
	parse_operations(input, content)
		.expect_err("payload must fail")
		.to_string()
}

#[test]
fn reads_sm_edit_openers_natively_a_bare_sm_edit_continuing_in_the_same_file() {
	let payload = [
		"<SM:EDIT path=\"src/config.ts\">",
		"<SM:FIND>",
		"const timeout = 1000;",
		"</SM:FIND>",
		"<SM:PUT>",
		"const timeout = 5000;",
		"</SM:PUT>",
		"<SM:EDIT>",
		"<SM:FIND>",
		"const retries = 3;",
		"</SM:FIND>",
		"<SM:PUT>",
		"const retries = 5;",
		"</SM:PUT>",
		"<SM:EDIT path=\"src/catalog.ts\" all>",
		"<SM:FIND>",
		"logger.debug(",
		"</SM:FIND>",
		"<SM:PUT>",
		"logger.trace(",
		"</SM:PUT>",
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
	assert!(sections[0].body.contains("«\nconst timeout"));
	assert!(sections[0].body.contains("«\nconst retries"));
	assert!(sections[1].body.starts_with("«*"));
}

#[test]
fn splits_sections_from_a_payload_wrapped_in_a_patch_envelope() {
	let payload = [
		"*** Begin Patch",
		"<SM:EDIT path=\"src/a.ts\">",
		"<SM:FIND>",
		"const x = 1;",
		"</SM:FIND>",
		"<SM:PUT>",
		"const x = 2;",
		"</SM:PUT>",
		"*** End Patch",
	]
	.join("\n");
	assert_eq!(split_sloppy_sections(&payload)[0].path, "src/a.ts");
}

#[test]
fn trims_whitespace_inside_the_path_attribute() {
	let sections =
		split_sloppy_sections("<SM:EDIT path=\" index.ts \">\n<SM:FIND>\nx()\n</SM:FIND>");
	assert_eq!(sections[0].path, "index.ts");
}

#[test]
fn extracts_an_inline_payload_region_without_swallowing_surrounding_prose() {
	let payload = [
		"<SM:EDIT path=\"src/a.ts\">",
		"<SM:FIND>",
		"const x = 1;",
		"</SM:FIND>",
		"<SM:PUT>",
		"const x = 2;",
		"</SM:PUT>",
		"</SM:EDIT>",
	]
	.join("\n");
	let text = format!("I'll fix the constant now.\n\n{payload}\n\nThat updates the default.");
	let regions = extract_inline_sloppy_regions(&text);
	assert_eq!(regions.len(), 1);
	assert_eq!(regions[0].payload, payload);
	let utf16: Vec<u16> = text.encode_utf16().collect();
	let excised =
		String::from_utf16(&[&utf16[..regions[0].start], &utf16[regions[0].end..]].concat()).unwrap();
	assert_eq!(excised, "I'll fix the constant now.\n\n\nThat updates the default.");
}

#[test]
fn ends_an_inline_region_at_trailing_prose_even_without_a_close() {
	let payload = [
		"<SM:EDIT path=\"src/a.ts\">",
		"<SM:FIND>",
		"old();",
		"</SM:FIND>",
		"<SM:PUT>",
		"new();",
		"</SM:PUT>",
	]
	.join("\n");
	let regions =
		extract_inline_sloppy_regions(&format!("{payload}\nDone — the call site now uses new()."));
	assert_eq!(regions.len(), 1);
	assert_eq!(regions[0].payload, payload);
}

#[test]
fn extracts_disjoint_inline_regions_with_narration_between_them() {
	let first = "<SM:EDIT path=\"a.ts\">\n<SM:FIND>\none();\n</SM:FIND>\n<SM:PUT>\ntwo();\n</SM:\
	             PUT>\n</SM:EDIT>";
	let second = concat!(
		"<SM:EDIT path=\"b.ts\">\n<SM:FIND>\nred();\n",
		"</SM:FIND>\n<SM:PUT>\nblue();\n</SM:PUT>",
	);
	let regions = extract_inline_sloppy_regions(&format!("{first}\nNow the second file:\n{second}"));
	assert_eq!(
		regions
			.iter()
			.map(|region| region.payload.as_str())
			.collect::<Vec<_>>(),
		[first, second]
	);
}

#[test]
fn ignores_a_payload_quoted_inside_a_markdown_code_fence() {
	let text = [
		"Here is the payload I would send:",
		"```text",
		"<SM:EDIT path=\"src/a.ts\">",
		"<SM:FIND>",
		"const x = 1;",
		"</SM:FIND>",
		"<SM:PUT>",
		"const x = 2;",
		"</SM:PUT>",
		"```",
	]
	.join("\n");
	assert!(extract_inline_sloppy_regions(&text).is_empty());
}

#[test]
fn drops_an_inline_region_that_compiles_to_no_sections() {
	assert!(
		extract_inline_sloppy_regions("<SM:EDIT path=\"src/a.ts\">\n</SM:EDIT>\nprose").is_empty()
	);
	assert!(
		extract_inline_sloppy_regions(
			"<SM:EDIT>\n<SM:FIND>\nx()\n</SM:FIND>\n<SM:PUT>\ny()\n</SM:PUT>"
		)
		.is_empty()
	);
}

#[test]
fn reports_utf16_offsets_for_inline_regions_after_non_bmp_text() {
	let prefix = "Before 🦀 astral.\n";
	let payload = concat!(
		"<SM:EDIT path=\"emoji.ts\">\n<SM:FIND>x</SM:FIND>\n",
		"<SM:PUT>y</SM:PUT>\n</SM:EDIT>",
	);
	let text = format!("{prefix}{payload}\nafter");
	let region = &extract_inline_sloppy_regions(&text)[0];
	assert_eq!(region.start, prefix.encode_utf16().count());
	assert_eq!(region.end, prefix.encode_utf16().count() + payload.encode_utf16().count() + 1);
	assert_eq!(region.payload, payload);
}

#[test]
fn split_sloppy_sections_splits_a_payload_into_per_file_sections() {
	let input = concat!(
		"<SM:EDIT path=\"src/a.ts\">\n<SM:FIND>\n",
		"old\n</SM:FIND>\n<SM:PUT>\nnew\n</SM:PUT>\n",
		"<SM:EDIT path=\"src/b.ts\">\n<SM:FIND>\n",
		"foo\n</SM:FIND>\n<SM:PUT>\nbar\n</SM:PUT>",
	);
	let sections = split_sloppy_sections(input);
	assert_eq!(
		sections
			.iter()
			.map(|section| section.path.as_str())
			.collect::<Vec<_>>(),
		["src/a.ts", "src/b.ts"]
	);
	assert!(sections[0].body.contains("old"));
	assert!(!sections[0].body.contains("foo"));
	assert!(sections[1].body.contains("bar"));
}

#[test]
fn split_sloppy_sections_merges_repeated_sections_for_the_same_file_in_order() {
	let input = concat!(
		"<SM:EDIT path=\"src/a.ts\">\n<SM:FIND>\n",
		"one\n</SM:FIND>\n<SM:PUT>\n1\n</SM:PUT>\n",
		"<SM:EDIT path=\"src/b.ts\">\n<SM:FIND>\n",
		"two\n</SM:FIND>\n<SM:PUT>\n2\n</SM:PUT>\n",
		"<SM:EDIT path=\"src/a.ts\">\n<SM:FIND>\n",
		"three\n</SM:FIND>\n<SM:PUT>\n3\n</SM:PUT>",
	);
	let sections = split_sloppy_sections(input);
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
fn split_sloppy_sections_keeps_tag_looking_content_lines_inside_their_operation() {
	let input = "<SM:EDIT path=\"src/a.ts\">\n<SM:FIND>\nconst rows =\nrender(\"<SM:PUT>\", \
	             value)\n.flat();\n</SM:FIND>\n<SM:PUT>\nconst rows = value.flat();\n</SM:PUT>";
	let sections = split_sloppy_sections(input);
	assert_eq!(sections.len(), 1);
	assert!(sections[0].body.contains("render(\"<SM:PUT>\", value)"));
}

#[test]
fn split_sloppy_sections_returns_empty_for_a_payload_without_a_leading_header() {
	assert!(split_sloppy_sections("«\nold\n»\nnew").is_empty());
}

#[test]
fn tag_surface_leniency_supports_implicit_find_put_all_and_inline_tags() {
	let sections = split_sloppy_sections(concat!(
		"<SM:EDIT path='a.ts' all>\nold line\n<SM:PUT>new line</SM:PUT>\n",
		"<SM:FIND>x</SM:FIND>\n<SM:PUT />",
	));
	assert_eq!(sections.len(), 1);
	assert_eq!(sections[0].body, "«*\nold line\n»\nnew line\n«*\nx\n»");
	let operations = parse_operations(&sections[0].body, "old line\nx\n").unwrap();
	assert_eq!(operations.len(), 2);
	assert!(operations.iter().all(|operation| operation.all));
	assert!(
		matches!(&operations[0].rewrite, OperationRewrite::Explicit { text } if text == "new line")
	);
}

#[test]
fn envelope_noise_stripping_discards_commentary_until_the_next_opener() {
	let lines = [
		"***",
		"Begin Patch",
		"<SM:EDIT path=\"a.ts\">",
		"<SM:FIND>x</SM:FIND>",
		"*** End Patch",
		"ignored prose",
		"<SM:EDIT path=\"b.ts\">",
		"<SM:FIND>y</SM:FIND>",
	];
	assert_eq!(strip_envelope_noise(lines.into_iter().collect()), [
		"<SM:EDIT path=\"a.ts\">",
		"<SM:FIND>x</SM:FIND>",
		"<SM:EDIT path=\"b.ts\">",
		"<SM:FIND>y</SM:FIND>"
	]);
}

#[test]
fn returns_the_complete_atomic_payload_when_an_operation_lacks_sm_put() {
	let content = "const a = 1;\nkeep();\n";
	let input = "<SM:EDIT>\n<SM:FIND>\nconst a = 1;\n</SM:FIND>\n<SM:PUT>\nconst a = \
	             2;\n</SM:PUT>\n</SM:EDIT>\n<SM:EDIT>\n<SM:FIND>\nkeep();\n</SM:FIND>\n</SM:EDIT>";
	let error = message(input, content);
	assert!(error.contains("Operation 2 has <SM:FIND> but no <SM:PUT>."));
	assert_eq!(error.matches("Copy-ready corrected payload").count(), 1);
	assert!(error.contains(concat!(
		"<SM:EDIT>\n<SM:FIND>\nkeep();\n</SM:FIND>\n",
		"<SM:PUT>\n{new text}\n</SM:PUT>\n</SM:EDIT>",
	)));
}

#[test]
fn hands_back_a_fill_in_skeleton_for_a_truncated_register_rewrite_without_echoing_the_broken_payload()
 {
	let error = message("«*\nenwlineIndex\n»1", "const first = enwlineIndex;\n");
	assert!(
		error.contains("»1 after <SM:FIND> reads as the <SM:PUT> separator, leaving <SM:PUT> empty.")
	);
	assert!(error.contains(concat!(
		"<SM:EDIT all>\n<SM:FIND>\nenwlineIndex\n",
		"</SM:FIND>\n<SM:PUT>\n{final text}\n</SM:PUT>\n",
		"</SM:EDIT>",
	)));
	assert!(!error.contains("enwlineIndex\n»1"));
}

#[test]
fn rejects_a_numbered_opener_and_names_the_two_valid_openers() {
	let error = message(
		"«2\nreturn value;\n»\nreturn nextValue;",
		"function first() {\n  return value;\n}\n",
	);
	assert!(error.contains("«2 is not a valid opener. Use a <SM:FIND> that matches once"));
}

#[test]
fn rejects_malformed_marker_envelopes_at_parse_time() {
	let error = message("«\nconst ⟪value│next\n»\nnext", "const value = 1;\n");
	assert_eq!(error, "Operation 1 has an unclosed selection marker ⟪; add closing ⟫.");
	let error = message("«\nconst ⟪value│next⟫⟫\n»\nnext", "const value = 1;\n");
	assert_eq!(error, "Operation 1 has an unmatched closing selection marker ⟫; add opening ⟪.");
}

#[test]
fn does_not_split_a_register_reference_glued_to_extra_content() {
	let error = message("«\nconst value = oldValue;\n»2 extra", "const value = oldValue;\n");
	assert_eq!(error, "Invalid control line \"»2 extra\"; use only «, «*, », or »N in REWRITE.");
}

#[test]
fn rejects_self_forward_and_match_register_references() {
	let self_reference = message("«\nconst first = oldFirst;\n»\n»1", "const first = oldFirst;\n");
	assert_eq!(self_reference, "»1 must reference an earlier operation, not self/forward.");
	let forward = message(
		"«\nconst first = oldFirst;\n»\n»2\n«\nconst second = oldSecond;\n»",
		"const first = oldFirst;\nconst second = oldSecond;\n",
	);
	assert_eq!(forward, "»2 must reference an earlier operation, not self/forward.");
	let in_match = message("«\n»1\n»\nnext", "const first = oldFirst;\n");
	assert_eq!(in_match, "»1 is valid only in REWRITE, never MATCH.");
}

#[test]
fn normalizes_markdown_fences_patch_envelopes_and_leading_blanks() {
	let input = "\n```xml\n*** Begin \
	             Patch\n<SM:EDIT>\n<SM:FIND>old</SM:FIND>\n<SM:PUT>new</SM:PUT>\n*** End Patch\n```";
	assert_eq!(normalize_input(input), "«\nold\n»\nnew");
}

#[test]
fn drops_a_text_block_the_payload_fully_occupied_leaving_only_the_region() {
	let payload = concat!(
		"<SM:EDIT path=\"src/a.ts\">\n<SM:FIND>x</SM:FIND>\n",
		"<SM:PUT>y</SM:PUT>\n</SM:EDIT>",
	);
	let regions = extract_inline_sloppy_regions(payload);
	assert_eq!(regions.len(), 1);
	assert_eq!((regions[0].start, regions[0].end), (0, payload.encode_utf16().count()));
}

#[test]
fn parses_marker_add_runs_as_inline_insertions_without_consuming_the_next_anchor_twice() {
	let operations =
		parse_operations("«\nfirst();\n＋added();\nlast();", "first();\nlast();\n").unwrap();
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
	)
	.unwrap();
	assert_eq!(operations.len(), 1);
	assert!(
		matches!(&operations[0].rewrite, OperationRewrite::Inline { replacements } if replacements == &["newValue".to_owned()])
	);
	assert!(
		operations[0]
			.recovery_note
			.as_deref()
			.unwrap()
			.contains("listed \u{27ea}old\u{2502}new\u{27eb} directives")
	);
}

#[test]
fn recovers_a_stray_close_typed_as_an_inline_divider() {
	let operations =
		parse_operations("«\nconst \u{27ea}old\u{27eb}new\u{27eb};", "const old;\n").unwrap();
	assert_eq!(operations[0].pattern_text, "const \u{27ea}old\u{27eb};");
	assert!(
		matches!(&operations[0].rewrite, OperationRewrite::Inline { replacements } if replacements == &["new".to_owned()])
	);
	assert!(
		operations[0]
			.recovery_note
			.as_deref()
			.unwrap()
			.contains("where the \u{2502} divider belongs")
	);
}

#[test]
fn auto_splits_a_uniquely_matching_match_prefix_from_an_omitted_separator() {
	let operations = parse_operations(
		"«\nconst value = oldValue;\nconst value = newValue;",
		"const value = oldValue;\nreport(value);\n",
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
	)
	.unwrap();
	assert_eq!(operations.len(), 1);
	assert_eq!(operations[0].pattern_text, "const first = old;");
	assert!(
		matches!(&operations[0].rewrite, OperationRewrite::Explicit { text } if text == "const first = new;")
	);
}

#[test]
fn ir_to_xml_preserves_operation_boundaries_and_all() {
	assert_eq!(
		ir_to_xml(&["«*", "old", "»", "new", "«", "x"]),
		concat!(
			"<SM:EDIT all>\n<SM:FIND>\nold\n</SM:FIND>\n",
			"<SM:PUT>\nnew\n</SM:PUT>\n</SM:EDIT>\n<SM:EDIT>\n",
			"<SM:FIND>\nx\n</SM:FIND>\n</SM:EDIT>",
		)
	);
}
