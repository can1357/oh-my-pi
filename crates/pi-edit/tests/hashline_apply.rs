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
	let lowered = resolve_block_edits(
		&[edit],
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
	let lowered = resolve_block_edits(
		&[edit],
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
	let lines = vec!["mod m {".into(), "\t#[test]".into(), "\tfn f() {}".into(), "}".into()];
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
	let lines = vec!["a".into()];
	let resolved = resolve_clipboard_edits(
		&[paste],
		&lines,
		&mut clipboard,
		EmptyPaste::Throw,
		&mut |warning| warnings.push(warning),
	)
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
		&["a".into()],
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
	let resolved = resolve_clipboard_edits(
		&[paste],
		&["a".into()],
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
