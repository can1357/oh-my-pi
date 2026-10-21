use std::{collections::HashMap, path::Path};

use pi_edit::{
	modes::hashline::{
		apply::{ApplyOptions, EmptyPaste, apply_edits},
		block::{Unresolved, native_block_resolver, resolve_block_edits},
		clipboard::{resolve_clipboard_edits, validate_clipboard_sequence},
		recovery::{RecoveryArgs, try_recover},
		syntax::{enclosing_boundaries, node_chain, parses_cleanly},
		types::{Anchor, BlockMode, Clipboard, Cursor, Edit, ParsedRange, PasteTarget},
	},
	store::{EditStore, file_hash},
};

fn insert_after(line: u32, text: &str, op_line: u32) -> Edit {
	Edit::Insert {
		cursor:      Cursor::AfterAnchor(Anchor { line }),
		text:        text.into(),
		line_num:    op_line,
		index:       0,
		replacement: false,
		block_start: None,
	}
}
fn insert_before(line: u32, text: &str, op_line: u32) -> Edit {
	Edit::Insert {
		cursor:      Cursor::BeforeAnchor(Anchor { line }),
		text:        text.into(),
		line_num:    op_line,
		index:       0,
		replacement: false,
		block_start: None,
	}
}
const fn delete(line: u32, op_line: u32) -> Edit {
	Edit::Delete {
		anchor:        Anchor { line },
		line_num:      op_line,
		index:         0,
		old_assertion: None,
	}
}
fn replacement(start: u32, end: u32, body: &[&str], op_line: u32) -> Vec<Edit> {
	let mut edits = body
		.iter()
		.map(|text| Edit::Insert {
			cursor:      Cursor::BeforeAnchor(Anchor { line: start }),
			text:        (*text).into(),
			line_num:    op_line,
			index:       0,
			replacement: true,
			block_start: None,
		})
		.collect::<Vec<_>>();
	edits.extend((start..=end).map(|line| delete(line, op_line)));
	edits
}
fn apply(
	text: &str,
	edits: &[Edit],
	path: Option<&str>,
) -> pi_edit::modes::hashline::types::ApplyResult {
	apply_edits(text, edits, ApplyOptions {
		clipboard: None,
		path,
		on_empty_paste: EmptyPaste::Throw,
	})
	.unwrap()
}

#[test]
fn inserts_before_after_head_and_tail() {
	let edits = vec![
		Edit::Insert {
			cursor:      Cursor::Bof,
			text:        "head".into(),
			line_num:    1,
			index:       0,
			replacement: false,
			block_start: None,
		},
		insert_before(2, "before", 2),
		insert_after(2, "after", 3),
		Edit::Insert {
			cursor:      Cursor::Eof,
			text:        "tail".into(),
			line_num:    4,
			index:       0,
			replacement: false,
			block_start: None,
		},
	];
	assert_eq!(apply("one\ntwo\n", &edits, None).text, "head\none\nbefore\ntwo\nafter\ntail\n");
}

#[test]
fn ignores_a_delete_of_the_trailing_phantom_line() {
	assert_eq!(apply("one\ntwo\n", &[delete(3, 1)], None).text, "one\ntwo\n");
}

#[test]
fn rejects_an_out_of_bounds_anchor() {
	let error = apply_edits("one\ntwo", &[delete(3, 1)], ApplyOptions {
		clipboard:      None,
		path:           None,
		on_empty_paste: EmptyPaste::Throw,
	})
	.unwrap_err();
	assert_eq!(error.to_string(), "Line 3 does not exist (file has 2 lines)");
}

#[test]
fn restores_a_uniformly_omitted_base_indent_from_unchanged_structural_rows() {
	let file = "fn f() {\n\tlet a = 1;\n\tlet b = 2;\n\tlet c = 3;\n}";
	let result = apply(
		file,
		&replacement(2, 4, &["let a = 1;", "let b = 20;", "let c = 3;"], 1),
		Some("x.rs"),
	);
	assert_eq!(result.text, "fn f() {\n\tlet a = 1;\n\tlet b = 20;\n\tlet c = 3;\n}");
	assert!(
		result
			.warnings
			.iter()
			.any(|warning| warning.contains("Auto-indented"))
	);
}

#[test]
fn preserves_intentional_indentation_only_replacements() {
	let result = apply(
		"    first();\n    second();",
		&replacement(1, 2, &["first();", "second();"], 1),
		Some("x.ts"),
	);
	assert_eq!(result.text, "first();\nsecond();");
	assert!(result.warnings.is_empty());
}

#[test]
fn spares_the_deleted_closing_line_when_the_payload_omits_it() {
	let file = "const handlers = {\n\ta() {\n\t\treturn 1;\n\t},\n};";
	let result =
		apply(file, &replacement(5, 5, &["\tb() {", "\t\treturn 2;", "\t},"], 1), Some("x.ts"));
	assert_eq!(
		result.text,
		"const handlers = {\n\ta() {\n\t\treturn 1;\n\t},\n\tb() {\n\t\treturn 2;\n\t},\n};"
	);
	assert!(
		result
			.warnings
			.iter()
			.any(|warning| warning.contains("Auto-repaired replacement boundaries"))
	);
}

#[test]
fn does_not_spare_a_deleted_closing_line_that_the_payload_restates() {
	let file = "class Foo {\n\tok();\n\t}\n}";
	let result = apply(file, &replacement(1, 4, &["class Foo {", "\tok();", "}"], 1), Some("x.ts"));
	assert_eq!(result.text, "class Foo {\n\tok();\n}");
	assert!(result.warnings.is_empty());
}

fn rejection(text: &str, edits: &[Edit], path: &str) -> String {
	apply_edits(text, edits, ApplyOptions {
		clipboard:      None,
		path:           Some(path),
		on_empty_paste: EmptyPaste::Throw,
	})
	.unwrap_err()
	.to_string()
}

const JSON_LIST: &str = "{\n  \"a\": [\n    \"x\",\n    \"y\"\n  ]\n}\n";

#[test]
fn names_the_trailing_comma_that_keeps_a_one_row_replacement_from_parsing() {
	for body in [&["    \"z\","][..], &["    \"z\",  ", ""]] {
		let error = rejection(JSON_LIST, &replacement(4, 4, body, 1), "x.json");
		assert!(error.contains("`PUT 4.=4:` rejected"), "{error}");
		assert!(error.contains("ends with a comma"), "{error}");
		assert!(!error.contains("body indentation"), "{error}");
	}
}

#[test]
fn keeps_the_placement_rejection_when_dropping_the_comma_does_not_parse() {
	// The comma stands in for a JSON closer, and a non-JSON space after the
	// comma stays when only the comma goes.
	let cases = [
		("{\n  \"a\": [\n    \"x\"\n  ],\n  \"b\": 1\n}\n", "  \"c\": 2,"),
		(JSON_LIST, "    \"z\",\u{a0}"),
	];
	for (file, row) in cases {
		let error = rejection(file, &replacement(4, 4, &[row], 1), "x.json");
		assert!(error.contains("`PUT 4.=4:` rejected"), "{error}");
		assert!(error.contains("body indentation does not establish"), "{error}");
	}
}

#[test]
fn drops_duplicated_leading_and_trailing_boundary_lines_around_a_range_replacement() {
	let file = "function f() {\n  keepA();\n  old1();\n  old2();\n  keepB();\n}";
	let result = apply(
		file,
		&replacement(3, 4, &["  keepA();", "  new1();", "  new2();", "  keepB();"], 1),
		Some("x.ts"),
	);
	assert_eq!(result.text, "function f() {\n  keepA();\n  new1();\n  new2();\n  keepB();\n}");
	assert!(
		result
			.warnings
			.iter()
			.any(|warning| warning.contains("boundary echo"))
	);
}

#[test]
fn rejects_a_leading_keeper_echo_when_the_payload_cannot_fill_the_widened_range() {
	let file = "{\n    auto* handle = payloadFor<PyThreadHandle>(self);\n    if (!handle)\n        \
	            return threadError(globalObject, \"thread not started\");\n    handle.setDone();\n}";
	let error = apply_edits(
		file,
		&replacement(
			3,
			4,
			&[
				"    auto* handle = payloadFor<PyThreadHandle>(self);",
				"    if (!handle || !handle.isStarted())",
			],
			1,
		),
		ApplyOptions {
			clipboard:      None,
			path:           Some("x.cpp"),
			on_empty_paste: EmptyPaste::Throw,
		},
	)
	.unwrap_err();
	assert!(error.to_string().contains("body opens by restating"));
}

#[test]
fn drops_a_trailing_attribute_echo_in_a_single_line_replacement() {
	let file = "/// Old summary.\n#[napi]\npub fn f() {}";
	let result = apply(file, &replacement(1, 1, &["/// New summary.", "#[napi]"], 1), Some("x.rs"));
	assert_eq!(result.text, "/// New summary.\n#[napi]\npub fn f() {}");
}

#[test]
fn keeps_a_trailing_statement_echo_literal_on_a_single_line_range() {
	let result =
		apply("foo();\nold();\nbar();", &replacement(2, 2, &["new();", "bar();"], 1), Some("x.ts"));
	assert_eq!(result.text, "foo();\nnew();\nbar();\nbar();");
}

#[test]
fn slides_a_shallower_body_past_the_closing_line_and_warns() {
	let file = "function f() {\n    if (x) {\n        a();\n    }\n    b();\n}\n";
	let result = apply(file, &[insert_after(3, "    c();", 1)], None);
	assert_eq!(
		result.text,
		"function f() {\n    if (x) {\n        a();\n    }\n    c();\n    b();\n}\n"
	);
	assert!(result.warnings[0].contains("moved past 1 closing line to after line 4"));
}

#[test]
fn crosses_multiple_closer_levels_and_stops_at_the_body_depth() {
	let file = "function f() {\n    if (x) {\n        for (y) {\n            a();\n        }\n    \
	            }\n    b();\n}\n";
	let outer = apply(file, &[insert_after(4, "    c();", 1)], None);
	assert_eq!(outer.text.lines().nth(6), Some("    c();"));
	assert!(outer.warnings[0].contains("moved past 2 closing lines to after line 6"));
	let inner = apply(file, &[insert_after(4, "        c();", 1)], None);
	assert_eq!(inner.text.lines().nth(5), Some("        c();"));
}

#[test]
fn refuses_to_cross_a_line_targeted_by_another_hunk() {
	let file = "function f() {\n    if (x) {\n        a();\n    }\n    b();\n}\n";
	let result = apply(file, &[insert_after(3, "    c();", 1), delete(4, 2)], None);
	assert_eq!(result.text, "function f() {\n    if (x) {\n        a();\n    c();\n    b();\n}\n");
	assert!(result.warnings.is_empty());
}

#[test]
fn inward_block_landing_pulls_a_deeper_body_inside() {
	let file = "function f() {\n    afterEach(() => {\n        destroy();\n    });\n}\n";
	let edit = Edit::Insert {
		cursor:      Cursor::AfterAnchor(Anchor { line: 4 }),
		text:        "        setup();".into(),
		line_num:    1,
		index:       0,
		replacement: false,
		block_start: Some(2),
	};
	let result = apply(file, &[edit], None);
	assert_eq!(
		result.text,
		"function f() {\n    afterEach(() => {\n        destroy();\n        setup();\n    });\n}\n"
	);
	assert!(result.warnings[0].contains("placed inside the block, after line 3"));
}

#[test]
fn native_block_resolver_uses_real_syntax() {
	let text = "fn outer() {\n\tif true {\n\t\twork();\n\t}\n}\n";
	assert_eq!(
		native_block_resolver("x.rs", text, 2).map(|span| (span.start, span.end)),
		Some((2, 4))
	);
	assert_eq!(native_block_resolver("x.rs", text, 4), None);
}

#[test]
fn block_replace_lowers_to_replacement_inserts_and_deletes() {
	let text = "fn outer() {\n\tif true {\n\t\twork();\n\t}\n}\n";
	let edit = Edit::Block {
		anchor:   Anchor { line: 2 },
		payloads: vec!["\tif false {}".into()],
		mode:     None,
		register: None,
		line_num: 1,
		index:    0,
	};
	let mut resolutions = Vec::new();
	let edits = [edit];
	let lowered = resolve_block_edits(
		&edits,
		text,
		"x.rs",
		Unresolved::Throw,
		&mut |resolution| resolutions.push(resolution),
		&mut |_| {},
	)
	.unwrap();
	assert_eq!(resolutions.len(), 1);
	assert_eq!(apply(text, &lowered, Some("x.rs")).text, "fn outer() {\n\tif false {}\n}\n");
}

#[test]
fn unresolved_insert_after_block_lowers_and_warns() {
	let edit = Edit::Block {
		anchor:   Anchor { line: 1 },
		payloads: vec!["next".into()],
		mode:     Some(BlockMode::InsertAfter),
		register: None,
		line_num: 7,
		index:    0,
	};
	let mut warnings = Vec::new();
	let edits = [edit];
	let lowered = resolve_block_edits(
		&edits,
		"plain",
		"x.unknown",
		Unresolved::Throw,
		&mut |_| {},
		&mut |warning| warnings.push(warning),
	)
	.unwrap();
	assert!(matches!(lowered[0], Edit::Insert {
		cursor: Cursor::AfterAnchor(Anchor { line: 1 }),
		..
	}));
	assert_eq!(warnings.len(), 1);
}

#[test]
fn unresolved_block_replacement_reports_context() {
	let edit = Edit::Block {
		anchor:   Anchor { line: 2 },
		payloads: vec!["x".into()],
		mode:     None,
		register: None,
		line_num: 9,
		index:    0,
	};
	let error = resolve_block_edits(
		&[edit],
		"fn f() {}\n\nfn g() {\n}\n",
		"x.rs",
		Unresolved::Throw,
		&mut |_| {},
		&mut |_| {},
	)
	.unwrap_err();
	assert!(error.to_string().starts_with("line 9: Line 2 is blank"));
}

#[test]
fn syntax_helpers_use_pi_ast() {
	let lines = vec!["mod m {", "\t#[test]", "\tfn f() {}", "}"];
	assert!(
		node_chain(&lines, "x.rs", 2)
			.iter()
			.any(|span| span.kind == "attribute_item")
	);
	assert!(enclosing_boundaries(&lines, "x.rs", 1, 1).contains(&4));
	assert!(parses_cleanly(Some("x.rs"), &lines.join("\n")));
	assert!(!parses_cleanly(Some("x.rs"), "fn broken("));
	assert!(!parses_cleanly(None, "fn f() {}"));
}

#[test]
fn clipboard_cut_then_gap_paste_moves_lines() {
	let cut = Edit::Cut {
		range:    ParsedRange { start: Anchor { line: 2 }, end: Anchor { line: 3 } },
		register: None,
		line_num: 1,
		index:    0,
	};
	let paste = Edit::Paste {
		at:          PasteTarget::Gap { cursor: Cursor::AfterAnchor(Anchor { line: 4 }) },
		register:    None,
		line_num:    2,
		index:       1,
		block_start: None,
	};
	let deletes = vec![delete(2, 1), delete(3, 1)];
	let mut edits = vec![cut];
	edits.extend(deletes);
	edits.push(paste);
	let mut clipboard = Clipboard::default();
	let result = apply_edits("a\nb\nc\nd", &edits, ApplyOptions {
		clipboard:      Some(&mut clipboard),
		path:           None,
		on_empty_paste: EmptyPaste::Throw,
	})
	.unwrap();
	assert_eq!(result.text, "a\nd\nb\nc");
}

#[test]
fn repeated_anonymous_pastes_do_not_consume_the_clipboard() {
	let cut = Edit::Cut {
		range:    ParsedRange { start: Anchor { line: 2 }, end: Anchor { line: 2 } },
		register: None,
		line_num: 1,
		index:    0,
	};
	let paste_head = Edit::Paste {
		at:          PasteTarget::Gap { cursor: Cursor::Bof },
		register:    None,
		line_num:    2,
		index:       1,
		block_start: None,
	};
	let paste_tail = Edit::Paste {
		at:          PasteTarget::Gap { cursor: Cursor::Eof },
		register:    None,
		line_num:    3,
		index:       2,
		block_start: None,
	};
	let edits = vec![cut, delete(2, 1), paste_head, paste_tail];
	let mut clipboard = Clipboard::default();
	let result = apply_edits("a\nb\nc", &edits, ApplyOptions {
		clipboard:      Some(&mut clipboard),
		path:           None,
		on_empty_paste: EmptyPaste::Throw,
	})
	.unwrap();
	assert_eq!(result.text, "b\na\nc\nb");
}

#[test]
fn named_registers_swap_two_regions() {
	let range =
		|start, end| ParsedRange { start: Anchor { line: start }, end: Anchor { line: end } };
	let edits = vec![
		Edit::Cut { range: range(1, 2), register: Some("a".into()), line_num: 1, index: 0 },
		delete(1, 1),
		delete(2, 1),
		Edit::Cut { range: range(3, 4), register: Some("b".into()), line_num: 2, index: 3 },
		delete(3, 2),
		delete(4, 2),
		Edit::Paste {
			at:          PasteTarget::Gap { cursor: Cursor::Bof },
			register:    Some("b".into()),
			line_num:    3,
			index:       6,
			block_start: None,
		},
		Edit::Paste {
			at:          PasteTarget::Gap { cursor: Cursor::Eof },
			register:    Some("a".into()),
			line_num:    4,
			index:       7,
			block_start: None,
		},
	];
	let mut clipboard = Clipboard::default();
	let result = apply_edits("a1\na2\nb1\nb2", &edits, ApplyOptions {
		clipboard:      Some(&mut clipboard),
		path:           None,
		on_empty_paste: EmptyPaste::Throw,
	})
	.unwrap();
	assert_eq!(result.text, "b1\nb2\na1\na2");
}

#[test]
fn named_register_gap_paste_warns_and_does_nothing_when_empty() {
	let paste = Edit::Paste {
		at:          PasteTarget::Gap { cursor: Cursor::AfterAnchor(Anchor { line: 1 }) },
		register:    Some("missing".into()),
		line_num:    4,
		index:       0,
		block_start: None,
	};
	let mut clipboard = Clipboard::default();
	let mut warnings = Vec::new();
	let lines = ["a"];
	let edits = [paste];
	let resolved =
		resolve_clipboard_edits(&edits, &lines, &mut clipboard, EmptyPaste::Throw, &mut |warning| {
			warnings.push(warning);
		})
		.unwrap();
	assert!(resolved.is_empty());
	assert!(warnings[0].starts_with("line 4: `@missing` was empty"));
}

#[test]
fn empty_named_span_paste_is_rejected() {
	let paste = Edit::Paste {
		at:          PasteTarget::Span {
			range: ParsedRange { start: Anchor { line: 1 }, end: Anchor { line: 1 } },
		},
		register:    Some("missing".into()),
		line_num:    4,
		index:       0,
		block_start: None,
	};
	let error = resolve_clipboard_edits(
		&[paste],
		&["a"],
		&mut Clipboard::default(),
		EmptyPaste::Throw,
		&mut |_| {},
	)
	.unwrap_err();
	assert!(
		error
			.to_string()
			.contains("pasting it over a range would delete those lines")
	);
}

#[test]
fn ambiguous_anonymous_paste_is_rejected() {
	let range = |line| ParsedRange { start: Anchor { line }, end: Anchor { line } };
	let edits = vec![
		Edit::Cut { range: range(1), register: None, line_num: 1, index: 0 },
		Edit::Cut { range: range(2), register: None, line_num: 2, index: 1 },
		Edit::Paste {
			at:          PasteTarget::Gap { cursor: Cursor::Eof },
			register:    None,
			line_num:    3,
			index:       2,
			block_start: None,
		},
	];
	let error = validate_clipboard_sequence(&edits, &Clipboard::default()).unwrap_err();
	assert!(error.to_string().contains("2 unlabeled `CUT`s are pending"));
}

#[test]
fn empty_paste_drop_removes_the_incomplete_preview_op() {
	let paste = Edit::Paste {
		at:          PasteTarget::Gap { cursor: Cursor::Eof },
		register:    None,
		line_num:    1,
		index:       0,
		block_start: None,
	};
	let edits = [paste];
	let resolved = resolve_clipboard_edits(
		&edits,
		&["a"],
		&mut Clipboard::default(),
		EmptyPaste::Drop,
		&mut |_| {},
	)
	.unwrap();
	assert!(resolved.is_empty());
}

#[test]
fn recovery_remaps_a_uniform_line_shift() {
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery.rs");
	let previous = "fn f() {\n\told();\n}\n";
	let tag = store.record(path, previous, None);
	let edit = replacement(2, 2, &["\tnew();"], 1);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: "// header\nfn f() {\n\told();\n}\n",
		file_hash: &tag,
		edits: &edit,
		clipboard: None,
	})
	.unwrap()
	.unwrap();
	assert_eq!(recovered.text, "// header\nfn f() {\n\tnew();\n}\n");
	assert!(recovered.warnings[0].contains("remapping stale line anchors"));
}

const ERRANDS: &str = "start the engine\ncheck the oil\ndrive home\n";
const SHIFTED_ERRANDS: &str =
	"header one\nheader two\nstart the engine\ncheck the oil\ndrive home\n";

#[test]
fn recovery_refuses_a_remap_of_a_body_written_for_the_current_line() {
	// The agent read line 3 (`start the engine`) from an untagged view of the
	// current file and paired it with the old tag; remapping would replace
	// `drive home`.
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-current-line.txt");
	let tag = store.record(path, ERRANDS, None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: SHIFTED_ERRANDS,
		file_hash: &tag,
		edits: &replacement(3, 3, &["start the engine twice"], 1),
		clipboard: None,
	})
	.unwrap();
	assert!(recovered.is_none());
}

#[test]
fn recovery_remaps_a_body_written_for_the_tagged_line() {
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-tagged-line.txt");
	let tag = store.record(path, ERRANDS, None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: SHIFTED_ERRANDS,
		file_hash: &tag,
		edits: &replacement(3, 3, &["drive home slowly"], 1),
		clipboard: None,
	})
	.unwrap()
	.unwrap();
	assert_eq!(
		recovered.text,
		"header one\nheader two\nstart the engine\ncheck the oil\ndrive home slowly\n"
	);
}

#[test]
fn recovery_skips_the_body_check_past_its_comparison_budget() {
	// The refused shape above at 400 lines: scoring it would be quadratic, so
	// the check abstains and the remap stands.
	let tagged_rows = (0..400)
		.map(|i| format!("tagged {i:04}"))
		.collect::<Vec<_>>();
	let tagged = format!("{}\nend\n", tagged_rows.join("\n"));
	let current_rows = (0..400)
		.map(|i| format!("current row {i} with some ordinary width to it"))
		.collect::<Vec<_>>();
	let body = current_rows
		.iter()
		.map(|row| format!("{row}!"))
		.collect::<Vec<_>>();
	let body = body.iter().map(String::as_str).collect::<Vec<_>>();
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-budget.txt");
	let tag = store.record(path, &tagged, None);
	let current = format!("{}\n{tagged}", current_rows.join("\n"));
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: &current,
		file_hash: &tag,
		edits: &replacement(1, 400, &body, 1),
		clipboard: None,
	})
	.unwrap()
	.unwrap();
	let expected = format!("{}\n{}\nend\n", current_rows.join("\n"), body.join("\n"));
	assert_eq!(recovered.text, expected);
}

#[test]
fn recovery_budgets_the_body_check_in_chars_not_bytes() {
	// 40 rows of 40 CJK chars: within the comparison budget counted in chars,
	// nine times over it counted in UTF-8 bytes.
	let tagged_rows = (0..40)
		.map(|i| format!("{}{i:03}", "タ".repeat(37)))
		.collect::<Vec<_>>();
	let tagged = format!("{}\nend\n", tagged_rows.join("\n"));
	let current_rows = (0..40)
		.map(|i| format!("{}{i:03}", "中".repeat(37)))
		.collect::<Vec<_>>();
	let body = current_rows
		.iter()
		.map(|row| format!("{row}！"))
		.collect::<Vec<_>>();
	let body = body.iter().map(String::as_str).collect::<Vec<_>>();
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-budget-chars.txt");
	let tag = store.record(path, &tagged, None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: &format!("{}\n{tagged}", current_rows.join("\n")),
		file_hash: &tag,
		edits: &replacement(1, 40, &body, 1),
		clipboard: None,
	})
	.unwrap();
	assert!(recovered.is_none());
}

#[test]
fn recovery_shares_one_comparison_budget_across_hunks() {
	// Two 48-row hunks: the first (written for its tagged rows) spends part of
	// the budget, so the second, which alone would be refused, is not scored.
	let rows = |letter: &str| {
		(0..48)
			.map(|i| format!("{}{i:03}", letter.repeat(37)))
			.collect::<Vec<_>>()
	};
	let (header, first, second) = (rows("h"), rows("a"), rows("b"));
	let tagged = format!("{}\n{}\nend\n", first.join("\n"), second.join("\n"));
	let current = format!("{}\n{tagged}", header.join("\n"));
	let first_body = first
		.iter()
		.map(|row| format!("{row}!"))
		.collect::<Vec<_>>();
	let second_body = first
		.iter()
		.map(|row| format!("{row}?"))
		.collect::<Vec<_>>();
	let first_body = first_body.iter().map(String::as_str).collect::<Vec<_>>();
	let second_body = second_body.iter().map(String::as_str).collect::<Vec<_>>();
	let mut edits = replacement(1, 48, &first_body, 1);
	edits.extend(replacement(49, 96, &second_body, 2));
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-shared-budget.txt");
	let tag = store.record(path, &tagged, None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: &current,
		file_hash: &tag,
		edits: &edits,
		clipboard: None,
	})
	.unwrap()
	.unwrap();
	let expected = format!(
		"{}\n{}\n{}\nend\n",
		header.join("\n"),
		first_body.join("\n"),
		second_body.join("\n")
	);
	assert_eq!(recovered.text, expected);
}

#[test]
fn recovery_remaps_a_shifted_range_that_overlaps_its_kept_line() {
	// Shifted by one, the authored window (blank, `alpha line`) shares
	// `alpha line` with the tagged range; the blank must not tip it.
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-overlap.txt");
	let tag = store.record(path, "intro text\n\nalpha line\nobsolete line\nend text\n", None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: "header\nintro text\n\nalpha line\nobsolete line\nend text\n",
		file_hash: &tag,
		edits: &replacement(3, 4, &["alpha line 2"], 1),
		clipboard: None,
	})
	.unwrap()
	.unwrap();
	assert_eq!(recovered.text, "header\nintro text\n\nalpha line 2\nend text\n");
}

#[test]
fn recovery_remaps_a_filled_blank_line_next_to_a_similar_line() {
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-blank-fill.txt");
	let tag = store.record(path, "first line here\n\nthird line here\n", None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: "a header\nfirst line here\n\nthird line here\n",
		file_hash: &tag,
		edits: &replacement(2, 2, &["first line here too"], 1),
		clipboard: None,
	})
	.unwrap()
	.unwrap();
	assert_eq!(recovered.text, "a header\nfirst line here\nfirst line here too\nthird line here\n");
}

#[test]
fn recovery_remaps_a_short_body_next_to_a_short_line() {
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-short.txt");
	let tag = store.record(path, "header\nx\nlong legacy line\ntail\n", None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: "prefix\nheader\nx\nlong legacy line\ntail\n",
		file_hash: &tag,
		edits: &replacement(3, 3, &["x2"], 1),
		clipboard: None,
	})
	.unwrap()
	.unwrap();
	assert_eq!(recovered.text, "prefix\nheader\nx\nx2\ntail\n");
}

#[test]
fn recovery_remaps_a_rewrite_loosely_like_the_neighboring_line() {
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-rewrite.rs");
	let previous = "fn f() -> u32 {\n\tlet computed = 1;\n\tpanic!(\"not implemented\");\n}\n";
	let tag = store.record(path, previous, None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: &format!("// header\n{previous}"),
		file_hash: &tag,
		edits: &replacement(3, 3, &["\treturn computed;"], 1),
		clipboard: None,
	})
	.unwrap()
	.unwrap();
	assert_eq!(
		recovered.text,
		"// header\nfn f() -> u32 {\n\tlet computed = 1;\n\treturn computed;\n}\n"
	);
}

#[test]
fn recovery_refuses_a_shifted_remap_that_breaks_the_parse() {
	// Meant after the current `"z": 0,` (line 2); the remap lands the entry
	// after `"a": 1`, which has no trailing comma.
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-breaks-parse.json");
	let tag = store.record(path, "{\n  \"a\": 1\n}\n", None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: "{\n  \"z\": 0,\n  \"a\": 1\n}\n",
		file_hash: &tag,
		edits: &[insert_after(2, "  \"y\": 9,", 1)],
		clipboard: None,
	})
	.unwrap();
	assert!(recovered.is_none());
}

#[test]
fn recovery_remaps_a_shifted_insert_that_keeps_the_parse() {
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-keeps-parse.json");
	let tag = store.record(path, "{\n  \"a\": 1\n}\n", None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: "{\n  \"z\": 0,\n  \"a\": 1\n}\n",
		file_hash: &tag,
		edits: &[insert_before(2, "  \"y\": 9,", 1)],
		clipboard: None,
	})
	.unwrap()
	.unwrap();
	assert_eq!(recovered.text, "{\n  \"z\": 0,\n  \"y\": 9,\n  \"a\": 1\n}\n");
	assert!(recovered.warnings[0].contains("remapping stale line anchors"));
}

#[test]
fn recovery_parse_refusal_leaves_the_clipboard_untouched() {
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-refused-cut.json");
	let tag = store.record(path, "{\n  \"a\": 1\n}\n", None);
	let cut = Edit::Cut {
		range:    ParsedRange { start: Anchor { line: 2 }, end: Anchor { line: 2 } },
		register: Some("reg".into()),
		line_num: 1,
		index:    0,
	};
	let mut clipboard = Clipboard {
		named: Some(HashMap::from([("reg".to_owned(), vec!["SAVED".to_owned()])])),
		..Clipboard::default()
	};
	let before = clipboard.clone();
	// Cutting the remapped `"a": 1` leaves `"z": 0,` with a trailing comma.
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: "{\n  \"z\": 0,\n  \"a\": 1\n}\n",
		file_hash: &tag,
		edits: &[cut, delete(2, 1)],
		clipboard: Some(&mut clipboard),
	})
	.unwrap();
	assert!(recovered.is_none());
	assert_eq!(clipboard, before);
}

#[test]
fn recovery_publishes_the_registers_of_an_accepted_remap() {
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-accepted-cut.txt");
	let tag = store.record(path, "a\nb\nc\n", None);
	let cut = Edit::Cut {
		range:    ParsedRange { start: Anchor { line: 2 }, end: Anchor { line: 2 } },
		register: Some("reg".into()),
		line_num: 1,
		index:    0,
	};
	let mut clipboard = Clipboard::default();
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: "h\na\nb\nc\n",
		file_hash: &tag,
		edits: &[cut, delete(2, 1)],
		clipboard: Some(&mut clipboard),
	})
	.unwrap()
	.unwrap();
	assert_eq!(recovered.text, "h\na\nc\n");
	assert_eq!(clipboard.named.unwrap()["reg"], vec!["b".to_owned()]);
}

#[test]
fn recovery_rejects_a_changed_anchor() {
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-changed.rs");
	let previous = "a\nold\nc";
	let tag = store.record(path, previous, None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: "a\nchanged\nc",
		file_hash: &tag,
		edits: &replacement(2, 2, &["new"], 1),
		clipboard: None,
	})
	.unwrap();
	assert!(recovered.is_none());
}

#[test]
fn recovery_replays_unchanged_anchor_onto_current_session_text() {
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-session.ts");
	let previous = "L1\nL2\nL3\nL4\nL5\nL6\n";
	let tag = store.record(path, previous, None);
	let current = "L1\nL2\nL3\nL4\nL5-CHANGED\nL6\n";
	store.record(path, current, None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: current,
		file_hash: &tag,
		edits: &replacement(3, 3, &["L3-MODEL"], 1),
		clipboard: None,
	})
	.unwrap()
	.unwrap();
	assert!(recovered.text.contains("L3-MODEL"));
	assert!(recovered.text.contains("L5-CHANGED"));
	assert!(recovered.warnings[0].contains("earlier in-session snapshot"));
}

#[test]
fn recovery_remaps_after_a_prior_deletion() {
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-deletion.ts");
	let previous = "L1\nL2\nL3\nL4\nL5\nL6\n";
	let tag = store.record(path, previous, None);
	let current = "L1\nL3\nL4\nL5\nL6\n";
	store.record(path, current, None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: current,
		file_hash: &tag,
		edits: &replacement(5, 5, &["L5-MODEL"], 1),
		clipboard: None,
	})
	.unwrap()
	.unwrap();
	assert_eq!(recovered.text, "L1\nL3\nL4\nL5-MODEL\nL6\n");
}

#[test]
fn recovery_refuses_an_isolated_unique_line_without_neighbor_offset() {
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-isolated.ts");
	let previous = "L1\nL2\nL3\nL4\nT\nL6\n";
	let tag = store.record(path, previous, None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: "X\nL1\nL2\nL3\nL4\nBEFORE\nT\nAFTER\nL6\n",
		file_hash: &tag,
		edits: &replacement(5, 5, &["MODEL"], 1),
		clipboard: None,
	})
	.unwrap();
	assert!(recovered.is_none());
}

#[test]
fn recovery_remaps_duplicate_range_when_context_matches() {
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-duplicate-valid.ts");
	let previous = "alpha\nDUP\nbeta\nDUP\nomega\n";
	let tag = store.record(path, previous, None);
	let current = "alpha\nINSERTED\nDUP\nbeta\nDUP\nomega\n";
	store.record(path, current, None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: current,
		file_hash: &tag,
		edits: &replacement(3, 4, &["B-MODEL", "MODEL"], 1),
		clipboard: None,
	})
	.unwrap()
	.unwrap();
	assert_eq!(recovered.text, "alpha\nINSERTED\nDUP\nB-MODEL\nMODEL\nomega\n");
}

fn colliding_texts() -> (String, String) {
	let mut tags = HashMap::new();
	for number in 0_u32.. {
		let text = format!("shared head\nunique payload {number}\nshared tail\n");
		let tag = file_hash(&text);
		if let Some(previous) = tags.insert(tag, text.clone()) {
			return (previous, text);
		}
	}
	unreachable!()
}

#[test]
fn recovery_uses_the_most_recent_snapshot_when_tags_collide() {
	let (older, newer) = colliding_texts();
	let tag = file_hash(&older);
	assert_eq!(file_hash(&newer), tag);
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-collision.ts");
	store.record(path, &older, None);
	store.record(path, &newer, None);
	let current = format!("{newer}drifted trailer\n");
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: &current,
		file_hash: &tag,
		edits: &replacement(2, 2, &["model payload"], 1),
		clipboard: None,
	})
	.unwrap()
	.unwrap();
	assert_eq!(recovered.text, "shared head\nmodel payload\nshared tail\ndrifted trailer\n");
}

#[test]
fn recovery_rejects_ambiguous_duplicate_anchor_context() {
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-duplicate.rs");
	let previous = "start\nDUP\nmid\nDUP\ntail";
	let tag = store.record(path, previous, None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: "start\nmid\nDUP\nCHANGED\ntail",
		file_hash: &tag,
		edits: &replacement(4, 4, &["MODEL"], 1),
		clipboard: None,
	})
	.unwrap();
	assert!(recovered.is_none());
}

#[test]
fn recovery_refuses_a_remap_into_a_sibling_construct() {
	// The diff aligns the surviving `"shared",` row of list `a` with the
	// identical row of the newly added list `b`: a uniform offset with
	// matching neighbors, landing the insert in the wrong list.
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-sibling.py");
	let previous = "cfg = {\n    \"a\": [\n        \"shared\",\n    ],\n}\n";
	let current = "cfg = {\n    \"a\": [\n        \"changed\",\n    ],\n    \"b\": [\n        \
	               \"shared\",\n    ],\n}\n";
	let tag = store.record(path, previous, None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: current,
		file_hash: &tag,
		edits: &[insert_after(3, "        \"new\",", 1)],
		clipboard: None,
	})
	.unwrap();
	assert!(recovered.is_none());
}

#[test]
fn recovery_remaps_a_shift_inside_the_same_construct() {
	let store = EditStore::new();
	let path = Path::new("/tmp/recovery-same-construct.py");
	let previous = "def f():\n    old()\n";
	let tag = store.record(path, previous, None);
	let recovered = try_recover(&store, RecoveryArgs {
		path,
		current_text: "import os\n\ndef f():\n    old()\n",
		file_hash: &tag,
		edits: &replacement(2, 2, &["    new()"], 1),
		clipboard: None,
	})
	.unwrap()
	.unwrap();
	assert_eq!(recovered.text, "import os\n\ndef f():\n    new()\n");
}
