use std::path::Path;

use pi_edit::modes::hashline::{
	format::{
		format_cut_header, format_hashline_header, format_numbered_line, format_numbered_lines,
		format_replace_header, split_addressable_file_lines,
	},
	input::{Patch, SplitOptions, contains_recognizable_hashline_operations},
	mismatch::{MismatchDetails, format_mismatch_message},
	parser::{AbsoluteRangeOp, ParseFailure, parse_patch, parse_patch_streaming},
	prefixes::{
		hashline_parse_text, is_read_metadata_line, strip_hashline_prefixes, strip_new_line_prefixes,
		strip_one_leading_hashline_prefix,
	},
	tokenizer::{BlockTarget, Token, Tokenizer, op_labels, parse_lid, split_hashline_lines},
	types::{BlockMode, Cursor, Edit, FileOp, PasteTarget},
};

const fn options<'a>() -> SplitOptions<'a> {
	SplitOptions { cwd: None, path: None }
}

#[test]
fn formats_hashline_v4_rows_and_headers() {
	assert_eq!(format_hashline_header("src/a.ts", "1A2B"), "[src/a.ts#1A2B]");
	assert_eq!(format_replace_header(5, 9), "PUT 5.=9:");
	assert_eq!(format_cut_header(5, 9), "CUT 5.=9");
	assert_eq!(format_numbered_line(7, "hello"), "7:hello");
	assert_eq!(format_numbered_lines("a\nb\n", 4), "4:a\n5:b\n6:");
	assert_eq!(split_addressable_file_lines("a\nb\n"), vec!["a", "b"]);
	assert_eq!(split_addressable_file_lines(""), vec![""]);
}

#[test]
fn tokenizer_recognizes_headers_ops_payloads_and_envelope() {
	let mut tokenizer = Tokenizer::new();
	let tokens = tokenizer
		.tokenize_all("*** Begin Patch\n[a b.ts#1a2b]\nPUT 2.=3:\n+x\nCUT 5*\n*** End Patch\n")
		.unwrap();
	assert!(matches!(&tokens[0], Token::EnvelopeBegin { line_num: 1 }));
	assert!(
		matches!(&tokens[1], Token::Header { path, file_hash: Some(hash), .. } if path == "a b.ts" && hash == "1A2B")
	);
	assert!(matches!(&tokens[2], Token::OpBlock {
		target: BlockTarget::Replace { .. },
		had_colon: true,
		..
	}));
	assert!(matches!(&tokens[3], Token::PayloadLiteral { text, .. } if text == "x"));
	assert!(matches!(&tokens[4], Token::OpBlock { target: BlockTarget::CutBlock { .. }, .. }));
	assert!(matches!(&tokens[5], Token::EnvelopeEnd { .. }));
}

#[test]
fn tokenizer_streams_crlf_and_final_lines() {
	let mut tokenizer = Tokenizer::new();
	assert!(tokenizer.feed("PUT 2:\r").unwrap().is_empty());
	let tokens = tokenizer.feed("\n+x").unwrap();
	assert!(matches!(tokens.as_slice(), [Token::OpBlock { line_num: 1, .. }]));
	assert!(
		matches!(tokenizer.end().as_slice(), [Token::PayloadLiteral { line_num: 2, text }] if text == "x")
	);
	assert_eq!(split_hashline_lines("a\r\nb\n"), vec!["a", "b"]);
}

#[test]
fn parses_lids_and_rejects_unsafe_values() {
	assert_eq!(parse_lid(" 42 ", 3).unwrap().line, 42);
	let error = parse_lid("0", 3).unwrap_err().to_string();
	assert!(error.contains("line 3: expected a line number"));
	assert!(!Tokenizer::new().is_op("PUT 9007199254740992.=9007199254740992:"));
}

#[test]
fn parses_literal_replace_in_textual_order() {
	let parsed = parse_patch("PUT 2.=3:\n+B\n+C").unwrap();
	assert_eq!(parsed.edits.len(), 4);
	assert!(
		matches!(&parsed.edits[0], Edit::Insert { cursor: Cursor::BeforeAnchor(a), text, replacement: true, .. } if a.line == 2 && text == "B")
	);
	assert!(matches!(&parsed.edits[1], Edit::Insert { text, .. } if text == "C"));
	assert!(matches!(&parsed.edits[2], Edit::Delete { anchor, .. } if anchor.line == 2));
	assert!(matches!(&parsed.edits[3], Edit::Delete { anchor, .. } if anchor.line == 3));
}

#[test]
fn accepts_lenient_range_separators_and_dangling_ranges() {
	for header in ["PUT 2-3:", "PUT 2=3:", "PUT 2..3:", "PUT 2…3:", "PUT 2 3:"] {
		let parsed = parse_patch(&format!("{header}\n+X")).unwrap();
		assert_eq!(
			parsed
				.edits
				.iter()
				.filter(|edit| matches!(edit, Edit::Delete { .. }))
				.count(),
			2,
			"{header}"
		);
	}
	for header in ["PUT 2.=:", "PUT 2-:"] {
		assert_eq!(parse_patch(&format!("{header}\n+X")).unwrap().edits.len(), 2);
	}
	assert!(parse_patch("PUT 2.= junk:\n+X").is_err());
}

#[test]
fn parses_all_gap_and_block_targets() {
	let parsed =
		parse_patch("PUT <2:\n+a\nPUT >3:\n+b\nPUT <1:\n+c\nPUT >$:\n+d\nPUT 4*:\n+e\nPUT >5*:\n+f")
			.unwrap();
	assert!(
		matches!(&parsed.edits[0], Edit::Insert { cursor: Cursor::BeforeAnchor(a), .. } if a.line == 2)
	);
	assert!(parsed.edits.iter().any(
		|edit| matches!(edit, Edit::Insert { cursor: Cursor::AfterAnchor(a), .. } if a.line == 3)
	));
	assert!(
		parsed
			.edits
			.iter()
			.any(|edit| matches!(edit, Edit::Insert { cursor: Cursor::Bof, .. }))
	);
	assert!(
		parsed
			.edits
			.iter()
			.any(|edit| matches!(edit, Edit::Insert { cursor: Cursor::Eof, .. }))
	);
	assert!(
		parsed
			.edits
			.iter()
			.any(|edit| matches!(edit, Edit::Block { anchor, mode: None, .. } if anchor.line == 4))
	);
	assert!(parsed.edits.iter().any(|edit| matches!(edit, Edit::Block { anchor, mode: Some(BlockMode::InsertAfter), .. } if anchor.line == 5)));
}

#[test]
fn parses_cut_clipboard_and_register_pastes() {
	let parsed = parse_patch("CUT 2.=3 @hold\nPUT <1 @hold\nPUT >$\nPUT 4.=5 @hold").unwrap();
	assert!(matches!(&parsed.edits[0], Edit::Cut { register: Some(name), .. } if name == "hold"));
	assert_eq!(
		parsed
			.edits
			.iter()
			.filter(|edit| matches!(edit, Edit::Delete { .. }))
			.count(),
		2
	);
	assert!(parsed.edits.iter().any(|edit| matches!(edit, Edit::Paste { at: PasteTarget::Gap { cursor: Cursor::Bof }, register: Some(name), .. } if name == "hold")));
	assert!(parsed.edits.iter().any(|edit| matches!(edit, Edit::Paste {
		at: PasteTarget::Gap { cursor: Cursor::Eof },
		register: None,
		..
	})));
	assert!(parsed.edits.iter().any(|edit| matches!(edit, Edit::Paste { at: PasteTarget::Span { range }, .. } if range.start.line == 4 && range.end.line == 5)));
}

#[test]
fn rejects_body_rows_for_bodyless_ops() {
	assert!(
		parse_patch("CUT 2\n+replacement")
			.unwrap_err()
			.to_string()
			.contains("takes no body rows")
	);
	assert!(
		parse_patch("PUT >2 @name:")
			.unwrap_err()
			.to_string()
			.contains("never takes `:`")
	);
	assert!(
		parse_patch("PUT <2\n+X")
			.unwrap_err()
			.to_string()
			.contains("without `:` is clipboard-backed")
	);
}

#[test]
fn empty_put_deletes_but_empty_insert_is_rejected() {
	let parsed = parse_patch("PUT 2.=3:").unwrap();
	assert_eq!(parsed.edits.len(), 2);
	assert!(
		parsed
			.warnings
			.iter()
			.any(|warning| warning.contains("empty `PUT` body as deletion"))
	);
	assert!(
		parse_patch("PUT >$:")
			.unwrap_err()
			.to_string()
			.contains("promises body rows")
	);
}

#[test]
fn reports_invalid_absolute_ranges_and_limits() {
	let error = parse_patch("CUT 5.=2").unwrap_err();
	let ParseFailure::InvalidAbsoluteRange(details) = error else {
		panic!("wrong error")
	};
	assert_eq!(details.op, AbsoluteRangeOp::Cut);
	assert!(details.message().contains("For one line use `CUT 5`"));
	assert!(
		details
			.message()
			.contains("For 2 lines starting at 5, use `CUT 5.=6`")
	);
	assert!(
		parse_patch("PUT 1.=100001:\n+x")
			.unwrap_err()
			.to_string()
			.contains("maximum is 100000")
	);
}

#[test]
fn recovers_bare_snapshot_rows_and_rejects_duplicates() {
	let parsed = parse_patch("2:B\n4|D").unwrap();
	assert_eq!(parsed.edits.len(), 4);
	assert!(
		parsed
			.warnings
			.iter()
			.any(|warning| warning.contains("snapshot row"))
	);
	let error = parse_patch("2:B\n4:first\n4:second")
		.unwrap_err()
		.to_string();
	assert!(error.contains("name line 4") && error.contains("keep only the last row"));
}

#[test]
fn bare_body_prefix_stripping_is_uniform_and_single_pass() {
	let parsed = parse_patch("PUT 2.=3:\n2:foo\n3:bar").unwrap();
	let text: Vec<_> = parsed
		.edits
		.iter()
		.filter_map(|edit| {
			if let Edit::Insert { text, .. } = edit {
				Some(text.as_str())
			} else {
				None
			}
		})
		.collect();
	assert_eq!(text, ["foo", "bar"]);
	let parsed = parse_patch("PUT 2.=3:\n3:keep\nplain").unwrap();
	let text: Vec<_> = parsed
		.edits
		.iter()
		.filter_map(|edit| {
			if let Edit::Insert { text, .. } = edit {
				Some(text.as_str())
			} else {
				None
			}
		})
		.collect();
	assert_eq!(text, ["3:keep", "plain"]);
	let parsed = parse_patch("PUT 2:\n2:42:hello").unwrap();
	assert!(matches!(&parsed.edits[0], Edit::Insert { text, .. } if text == "42:hello"));
}

#[test]
fn preserves_numeric_keyed_bodies() {
	let parsed = parse_patch("PUT 2.=3:\n1: \"one\",\n2: \"two\",").unwrap();
	assert!(matches!(&parsed.edits[0], Edit::Insert { text, .. } if text == "1: \"one\","));
	assert!(matches!(&parsed.edits[1], Edit::Insert { text, .. } if text == "2: \"two\","));
}

#[test]
fn handles_minus_rows_and_markdown_bullets() {
	assert!(
		parse_patch("PUT 2:\n-old")
			.unwrap_err()
			.to_string()
			.contains("`-` rows are not valid")
	);
	let parsed = parse_patch("PUT 2:\n- item\n  - nested").unwrap();
	assert!(
		parsed
			.warnings
			.iter()
			.any(|warning| warning.contains("bullet row"))
	);
	let parsed = parse_patch("PUT 2:\n-old\n+new").unwrap();
	assert!(
		parsed
			.warnings
			.iter()
			.any(|warning| warning.contains("Ignored unified-diff `-old`"))
	);
	assert!(matches!(&parsed.edits[0], Edit::Insert { text, .. } if text == "new"));
}

#[test]
fn warns_when_literal_payload_is_an_op() {
	let parsed = parse_patch("PUT >1:\n+inserted();\n+CUT 2.=3").unwrap();
	assert!(
		parsed
			.warnings
			.iter()
			.any(|warning| warning.contains("itself a valid hunk header"))
	);
}

#[test]
fn rejects_contaminated_patch_syntax() {
	assert!(
		parse_patch("*** Update File: a.ts\nPUT 2:\n+X")
			.unwrap_err()
			.to_string()
			.contains("apply_patch sentinel")
	);
	assert!(
		parse_patch("@@ -1,3 +1,3 @@\nPUT 2:\n+X")
			.unwrap_err()
			.to_string()
			.contains("unified-diff hunk header")
	);
	assert!(
		parse_patch("2\n+B")
			.unwrap_err()
			.to_string()
			.contains("hunk headers need a verb")
	);
	assert!(
		parse_patch("2 3\n+X")
			.unwrap_err()
			.to_string()
			.contains("Hunk headers need a verb")
	);
}

#[test]
fn recovers_bare_range_header_as_implicit_put() {
	let parsed = parse_patch("2.=3:\n+X").unwrap();
	assert_eq!(
		parsed
			.edits
			.iter()
			.filter(|edit| matches!(edit, Edit::Delete { .. }))
			.count(),
		2
	);
	assert!(
		parsed
			.warnings
			.iter()
			.any(|warning| warning.contains("bare `N.=M:` header"))
	);
}

#[test]
fn ignores_copied_read_elisions() {
	let parsed = parse_patch(
		"1:a\n2-3: omitted() { … }\n4:d\n[…2ln elided; re-read needed ranges with a.ts:2-3]",
	)
	.unwrap();
	assert_eq!(
		parsed
			.edits
			.iter()
			.filter(|edit| matches!(edit, Edit::Insert { .. }))
			.count(),
		2
	);
	assert!(
		parsed
			.warnings
			.iter()
			.any(|warning| warning.contains("Ignored copied read-output elision"))
	);
}

#[test]
fn accepts_harmless_cut_colon_with_warning() {
	let parsed = parse_patch("CUT 2.=3:").unwrap();
	assert!(
		parsed
			.warnings
			.iter()
			.any(|warning| warning.contains("Ignored a trailing `:`"))
	);
}

#[test]
fn cut_supersedes_placeholder_put_on_exact_range() {
	let parsed = parse_patch("PUT 2.=3:\n+// moved block removed\nCUT 2.=3 @block").unwrap();
	assert!(parsed.edits.iter().all(|edit| edit.line_num() != 1));
	assert!(
		parsed
			.edits
			.iter()
			.any(|edit| matches!(edit, Edit::Cut { register: Some(name), .. } if name == "block"))
	);
}

#[test]
fn preserves_explicit_and_interior_blank_payload_rows() {
	let parsed = parse_patch("PUT 2:\n+\n+\nPUT 4:\n+D").unwrap();
	let payloads: Vec<_> = parsed
		.edits
		.iter()
		.filter_map(|edit| {
			if let Edit::Insert { text, .. } = edit {
				Some(text.as_str())
			} else {
				None
			}
		})
		.collect();
	assert_eq!(payloads, ["", "", "D"]);
	let parsed = parse_patch("PUT 2:\nfirst\n\nsecond").unwrap();
	let payloads: Vec<_> = parsed
		.edits
		.iter()
		.filter_map(|edit| {
			if let Edit::Insert { text, .. } = edit {
				Some(text.as_str())
			} else {
				None
			}
		})
		.collect();
	assert_eq!(payloads, ["first", "", "second"]);
}

#[test]
fn drops_trailing_bare_blank_before_next_hunk() {
	let parsed = parse_patch("PUT 2:\nfoo\n\nPUT 4:\nbaz").unwrap();
	let payloads: Vec<_> = parsed
		.edits
		.iter()
		.filter_map(|edit| {
			if let Edit::Insert { text, .. } = edit {
				Some(text.as_str())
			} else {
				None
			}
		})
		.collect();
	assert_eq!(payloads, ["foo", "baz"]);
}

#[test]
fn abort_terminates_parser_without_warning() {
	let parsed = parse_patch("PUT >1:\n+HELLO\n*** Abort\nPUT >99:\n+never").unwrap();
	assert_eq!(parsed.edits.len(), 1);
	assert!(matches!(&parsed.edits[0], Edit::Insert { text, .. } if text == "HELLO"));
	assert!(parsed.warnings.is_empty());
}

#[test]
fn abort_stops_input_before_later_sections() {
	let patch =
		Patch::parse("[a.ts]\nPUT >1:\n+a\n*** Abort\n[b.ts]\nPUT >1:\n+never", &options()).unwrap();
	assert_eq!(patch.sections.len(), 1);
	assert_eq!(patch.sections[0].path, "a.ts");
	assert!(!patch.sections[0].diff.contains("never"));
}

#[test]
fn removed_del_and_copy_headers_are_orphan_rows() {
	for header in ["DEL 2", "DEL.BLK 2", "COPY 2", "COPY.BLK 2"] {
		assert!(
			parse_patch(header)
				.unwrap_err()
				.to_string()
				.contains("payload line has no preceding hunk header")
		);
	}
}

#[test]
fn detects_and_coalesces_overlapping_hunks() {
	let error = parse_patch("PUT 2.=4:\n+A\nPUT 3.=5:\n+B")
		.unwrap_err()
		.to_string();
	assert!(error.contains("anchor line 3 is already targeted by another hunk on line 1"));
	let parsed = parse_patch("2:b\nPUT 2:\n+B").unwrap();
	assert!(parsed.edits.iter().all(|edit| edit.line_num() != 1));
	assert!(
		parsed
			.warnings
			.iter()
			.any(|warning| warning.contains("kept only the last"))
	);
}

#[test]
fn streaming_drops_incomplete_empty_body_but_keeps_bodyless_ops() {
	assert!(parse_patch_streaming("PUT 2.=").unwrap().edits.is_empty());
	let parsed = parse_patch_streaming("CUT 1\nPUT >$").unwrap();
	assert_eq!(
		parsed
			.edits
			.iter()
			.map(|edit| match edit {
				Edit::Cut { .. } => "cut",
				Edit::Delete { .. } => "delete",
				Edit::Paste { .. } => "paste",
				_ => "other",
			})
			.collect::<Vec<_>>(),
		["cut", "delete", "paste"]
	);
}

#[test]
fn parses_file_ops_and_rejects_invalid_combinations() {
	assert_eq!(parse_patch("REM").unwrap().file_op, Some(FileOp::Rem));
	assert_eq!(
		parse_patch("MV next.ts").unwrap().file_op,
		Some(FileOp::Move { dest: "next.ts".into() })
	);
	assert!(
		parse_patch("PUT 1:\n+x\nREM")
			.unwrap_err()
			.to_string()
			.contains("REM")
	);
	assert!(
		parse_patch("REM\nMV b.ts")
			.unwrap_err()
			.to_string()
			.contains("only one file-level op")
	);
}

#[test]
fn input_splits_sections_and_normalizes_tags() {
	let patch = Patch::parse(
		"\n*** Begin Patch\n[a.ts#1a2b]\nPUT 2:\n+B\n[b.ts]\nCUT 3\n*** End Patch\n[c.ts]\nCUT 1",
		&options(),
	)
	.unwrap();
	assert_eq!(patch.sections.len(), 2);
	assert_eq!(patch.sections[0].path, "a.ts");
	assert_eq!(patch.sections[0].file_hash.as_deref(), Some("1A2B"));
	assert_eq!(patch.sections[0].diff, "PUT 2:\n+B");
	assert_eq!(patch.sections[1].path, "b.ts");
}

#[test]
fn input_recovers_apply_patch_header_noise_and_spaces() {
	let patch =
		Patch::parse("[*** Update File: dir with spaces/a.ts#1A2B]\nPUT 1:\n+x", &options()).unwrap();
	assert_eq!(patch.sections[0].path, "dir with spaces/a.ts");
	assert_eq!(patch.sections[0].file_hash.as_deref(), Some("1A2B"));
}

#[test]
fn input_rejects_malformed_tags_and_missing_headers() {
	for header in ["[a.ts#1A2]", "[a.ts#1A2G]", "[a.ts#1A2B5]", "[a.ts#1A2B copied]"] {
		assert!(
			Patch::parse(&format!("{header}\nPUT 1:\n+x"), &options())
				.unwrap_err()
				.to_string()
				.contains("Input header must be"),
			"{header}"
		);
	}
	let error = Patch::parse("CUT 38.=40", &options())
		.unwrap_err()
		.to_string();
	assert!(
		error.contains("input must begin with \"[PATH#HASH]\"")
			&& error.contains("[src/foo.ts#1A2B]")
	);
}

#[test]
fn input_supports_fallback_path_and_absolute_paths_in_cwd() {
	let fallback = SplitOptions { cwd: None, path: Some("a.ts") };
	let patch = Patch::parse("PUT <1:\n+x", &fallback).unwrap();
	assert_eq!(patch.sections[0].path, "a.ts");
	let cwd = Path::new("/tmp/work");
	let options = SplitOptions { cwd: Some(cwd), path: None };
	let patch = Patch::parse("[/tmp/work/src/a.ts]\nPUT <1:\n+x", &options).unwrap();
	assert_eq!(patch.sections[0].path, "src/a.ts");
	assert!(Patch::parse("plain text", &fallback).is_err());
}

#[test]
fn input_merges_same_path_sections_and_conflicting_tags_fail() {
	let patch =
		Patch::parse("[a.ts#1A2B]\nCUT 1\n[b.ts]\nCUT 2\n[a.ts#1A2B]\nCUT 3", &options()).unwrap();
	assert_eq!(patch.sections.len(), 2);
	assert_eq!(patch.sections[0].diff, "CUT 1\nCUT 3");
	let error = patch.sections[0].parse().unwrap_err().to_string();
	assert!(error.contains("cannot be used in a file whose sections are interleaved"));
	assert!(
		Patch::parse("[a.ts#1A2B]\nCUT 1\n[a.ts#3C4D]\nCUT 2", &options())
			.unwrap_err()
			.to_string()
			.contains("Conflicting hashline snapshot tags")
	);
}

#[test]
fn section_reports_anchor_scope_and_sorted_lines() {
	let patch = Patch::parse("[a.ts]\nCUT 5.=6\nPUT >2:\n+x", &options()).unwrap();
	let section = &patch.sections[0];
	assert!(section.has_anchor_scoped_edit().unwrap());
	assert_eq!(section.collect_anchor_lines().unwrap(), [2, 5, 6]);
	let rebased = section.with_path("b.ts");
	assert_eq!(rebased.path, "b.ts");
	assert_eq!(rebased.edits().unwrap(), section.edits().unwrap());
}

#[test]
fn prefix_helpers_strip_read_and_diff_shapes() {
	assert_eq!(strip_one_leading_hashline_prefix(" >>> + 42:hello"), "hello");
	let lines = vec!["[a.ts#1A2B]".into(), "1:one".into(), "2:two".into()];
	assert_eq!(strip_hashline_prefixes(&lines), ["one", "two"]);
	assert_eq!(strip_new_line_prefixes(&["+one".into(), "+two".into()]), ["one", "two"]);
	assert_eq!(hashline_parse_text(Some("1:one\r\n2:two\n")), ["one", "two"]);
	assert!(is_read_metadata_line("[Showing lines 1-2 of 8. Use :3 to continue]"));
	assert!(is_read_metadata_line("2-4: omitted …"));
	assert!(is_read_metadata_line("..."));
}

#[test]
fn prefix_helpers_leave_mixed_content_unchanged() {
	let lines = vec!["1:one".into(), "plain".into()];
	assert_eq!(strip_hashline_prefixes(&lines), lines);
	assert_eq!(strip_new_line_prefixes(&lines), lines);
}

#[test]
fn mismatch_messages_distinguish_stale_and_unrecognized_hashes() {
	let stale = MismatchDetails {
		path:               Some("a.ts".into()),
		expected_file_hash: "1A2B".into(),
		actual_file_hash:   "3C4D".into(),
		file_lines:         vec!["one".into(), "two".into(), "three".into()],
		anchor_lines:       vec![2],
		hash_recognized:    true,
	};
	let message = format_mismatch_message(&stale);
	assert!(message.contains("Edit rejected for a.ts: file changed between read and edit."));
	assert!(message.contains("*2:two"));
	let unknown = MismatchDetails { hash_recognized: false, ..stale };
	let message = format_mismatch_message(&unknown);
	assert!(message.contains("hash #1A2B is not from this session"));
	assert!(message.contains("never invent the tag"));
}

#[test]
fn recognizes_operations_and_emits_canonical_labels() {
	assert!(contains_recognizable_hashline_operations("partial\nPUT 2:\n"));
	assert!(!contains_recognizable_hashline_operations("plain text"));
	assert_eq!(op_labels("PUT 2:\nPUT 2\nPUT >3 @x\nCUT 2.=3:\nREM\nMV x"), [
		"PUT N.=N:",
		"PUT N.=N (invalid)",
		"PUT >N @reg",
		"CUT N.=M: (invalid)",
		"REM",
		"MV"
	]);
}
