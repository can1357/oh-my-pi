//! Contract suite for JSON parsing, plus Rust-specific coverage (surrogate
//! escapes, integer fidelity, serialization, and depth limits).

use std::borrow::Cow;

use omp_core::slopjson::{
	JsonPrefixState, ParseError, RawValue, Value, classify_json_prefix, from_str, json, parse,
	parse_streaming, repair_json,
};

const fn empty_object() -> Value {
	json!({})
}

// ── repair_json ──────────────────────────────────────────────────────────────

#[test]
fn repair_leaves_valid_string_escapes_unchanged() {
	let input = r#"{"text":"quote: \" unicode: \u2028 slash: \/ newline: \n"}"#;
	let repaired = repair_json(input);
	assert!(matches!(repaired, Cow::Borrowed(_)), "no repair must borrow the input");
	assert_eq!(repaired, input);
	assert_eq!(
		parse(input).unwrap(),
		json!({ "text": "quote: \" unicode: \u{2028} slash: / newline: \n" })
	);
}

#[test]
fn repair_escapes_raw_control_characters_inside_strings() {
	let input = "{\"text\":\"a\nb\u{1}c\"}";
	assert_eq!(repair_json(input), r#"{"text":"a\nb\u0001c"}"#);
	assert_eq!(parse(input).unwrap(), json!({ "text": "a\nb\u{1}c" }));
}

#[test]
fn repair_preserves_invalid_simple_escapes_as_literal_backslashes() {
	let input = r#"{"value":"a\qb"}"#;
	assert_eq!(repair_json(input), r#"{"value":"a\\qb"}"#);
	assert_eq!(parse(input).unwrap(), json!({ "value": r"a\qb" }));
}

// ── classify_json_prefix ─────────────────────────────────────────────────────

#[test]
fn classify_complete_prefix_and_invalid_buffers() {
	use JsonPrefixState::{Complete, Invalid, Prefix};
	let cases: &[(&str, &str, JsonPrefixState)] = &[
		("empty buffer waits for a value", "", Prefix),
		("whitespace-only buffer waits for a value", " \t\n\r", Prefix),
		(
			"object with an unfinished string value is still extendable",
			r#"{"command":"echo "#,
			Prefix,
		),
		("complete object with brace text inside a string", r#"{"command":"echo {1..3}"}"#, Complete),
		("complete nested arrays and objects", r#"{"a":[1,{"b":true},null]}"#, Complete),
		("nested array value can stop mid-object", r#"{"a":[1,{"b":"#, Prefix),
		("raw control character inside a string is invalid", "{\"command\":\"echo hello\n", Invalid),
		("second top-level value after a complete object", r#"{"a":1}{"#, Invalid),
		("brace expansion syntax is not JSON object grammar", "{1..3}", Invalid),
		("escape sequence can split after the backslash", r#"{"a":"\"#, Prefix),
		("unicode escape can split in the hex digits", r#"{"a":"\u12"#, Prefix),
		("bad escape is invalid", r#"{"a":"\q"}"#, Invalid),
		("leading-zero number is invalid strict JSON", r#"{"a":01}"#, Invalid),
		("top-level number at EOF is complete", "12", Complete),
	];
	for (name, input, expected) in cases {
		assert_eq!(classify_json_prefix(input), *expected, "{name}");
	}
}

#[test]
fn classify_detects_a_corrupting_delta_against_a_valid_prefix() {
	// The stream guard drops a delta exactly when appending it turns an
	// extendable buffer invalid; legal continuations must keep
	// classifying as a prefix.
	let partial = r#"{"command":"echo "#;
	assert_eq!(classify_json_prefix(partial), JsonPrefixState::Prefix);
	let legal = format!("{partial}hello");
	assert_eq!(classify_json_prefix(&legal), JsonPrefixState::Prefix);
	let corrupted = format!("{partial}\n");
	assert_eq!(classify_json_prefix(&corrupted), JsonPrefixState::Invalid);
}

// ── parse (relaxed final parsing) ────────────────────────────────────────────

#[test]
fn parses_strict_json_exactly() {
	assert_eq!(
		parse(r#"{"a":[1,-2,2.5,"x"],"b":null,"c":{"d":false}}"#).unwrap(),
		json!({ "a": [1, -2, 2.5, "x"], "b": null, "c": { "d": false } })
	);
}

#[test]
fn accepts_single_quoted_strings_and_keys() {
	assert_eq!(parse("{'path': 'a.ts'}").unwrap(), json!({ "path": "a.ts" }));
}

#[test]
fn accepts_unquoted_object_keys() {
	assert_eq!(parse(r#"{path: "a.ts", count: 2}"#).unwrap(), json!({ "path": "a.ts", "count": 2 }));
}

#[test]
fn strips_trailing_and_stray_commas() {
	assert_eq!(parse(r#"{"a":1,}"#).unwrap(), json!({ "a": 1 }));
	assert_eq!(parse("[1, 2, ]").unwrap(), json!([1, 2]));
}

#[test]
fn coerces_python_literals_to_json_literals() {
	assert_eq!(
		parse(r#"{"ok": True, "no": False, "nil": None}"#).unwrap(),
		json!({ "ok": true, "no": false, "nil": null })
	);
}

#[test]
fn recovers_unescaped_apostrophe_inside_single_quoted_string() {
	assert_eq!(parse("{'msg': 'it's fine'}").unwrap(), json!({ "msg": "it's fine" }));
}

#[test]
fn ignores_line_and_block_comments() {
	assert_eq!(
		parse("{\"a\":1 /* c */, \"b\":2 // trailing\n}").unwrap(),
		json!({ "a": 1, "b": 2 })
	);
}

#[test]
fn comments_directly_after_closing_quotes_do_not_reopen_strings() {
	assert_eq!(parse("{'a'/*c*/: 1}").unwrap(), json!({ "a": 1 }));
	assert_eq!(parse_streaming("{\"a\"/*c*/: 1}"), json!({ "a": 1 }));
	assert_eq!(parse_streaming("{'a': 'v' // note\n}"), json!({ "a": "v" }));
	assert_eq!(parse_streaming("{\"a\": \"v\"/*c*/}"), json!({ "a": "v" }));
}

#[test]
fn does_not_swallow_structure_through_unescaped_double_quotes() {
	assert!(parse(r#"{"a":"x" "b":1}"#).is_err());
}

#[test]
fn rejects_js_only_non_finite_atoms() {
	assert!(parse(r#"{"a": NaN}"#).is_err());
	assert!(parse(r#"{"a": Infinity}"#).is_err());
}

#[test]
fn rejects_trailing_garbage_after_complete_value() {
	assert!(parse(r#"{"a":1} then prose"#).is_err());
}

#[test]
fn recovers_unquoted_bareword_string_value() {
	assert_eq!(
		parse(r#"{"paths": packages/coding-agent/src/stt/*, "i": "Listing stt module files"}"#)
			.unwrap(),
		json!({ "paths": "packages/coding-agent/src/stt/*", "i": "Listing stt module files" })
	);
}

#[test]
fn recovers_barewords_in_array_position_and_trims_trailing_whitespace() {
	assert_eq!(
		parse(r#"{"paths": [src/a/*, src/b/* ], "n": 3}"#).unwrap(),
		json!({ "paths": ["src/a/*", "src/b/*"], "n": 3 })
	);
	assert_eq!(
		parse(r#"{"i": Listing stt files   , "b": true}"#).unwrap(),
		json!({ "i": "Listing stt files", "b": true })
	);
}

#[test]
fn recovers_url_and_windows_path_colons_and_apostrophes_in_barewords() {
	assert_eq!(
		parse(r#"{"url": https://example.com/x?y=1}"#).unwrap(),
		json!({ "url": "https://example.com/x?y=1" })
	);
	assert_eq!(parse(r#"{"p": C:\Users\x}"#).unwrap(), json!({ "p": r"C:\Users\x" }));
	assert_eq!(
		parse(r#"{"msg": it's fine, "b": 1}"#).unwrap(),
		json!({ "msg": "it's fine", "b": 1 })
	);
}

#[test]
fn rejects_truncated_barewords_and_swallowed_structure() {
	assert!(parse(r#"{"a": packages/foo"#).is_err());
	assert!(parse(r#"{"a": foo "b": 1}"#).is_err());
	assert!(parse("{a: foo b: 1}").is_err());
	assert!(parse(r#"{"a": foo {"b": 1}}"#).is_err());
	assert!(parse(r#"{"a": foo [1]}"#).is_err());
}

#[test]
fn rejects_key_like_colons_and_undefined_in_value_position() {
	assert!(parse(r#"{"addr": localhost:8080}"#).is_err());
	assert!(parse(r#"{"a": undefined}"#).is_err());
}

#[test]
fn duplicate_keys_last_wins() {
	assert_eq!(parse(r#"{"a":1,"a":2}"#).unwrap(), json!({ "a": 2 }));
}

// ── parse_streaming (partial parsing) ────────────────────────────────────────

#[test]
fn streaming_returns_empty_object_for_whitespace_only_input() {
	assert_eq!(parse_streaming(" \t\n\r"), empty_object());
	assert_eq!(parse_streaming(""), empty_object());
}

#[test]
fn streaming_auto_closes_truncated_object_and_string() {
	assert_eq!(parse_streaming(r#"{"a":1"#), json!({ "a": 1 }));
	assert_eq!(parse_streaming(r#"{"q":"hel"#), json!({ "q": "hel" }));
}

#[test]
fn streaming_rolls_back_incomplete_trailing_keyword() {
	assert_eq!(parse_streaming(r#"{"a":1,"b":tru"#), json!({ "a": 1 }));
	assert_eq!(parse_streaming(r#"{"a":tru"#), empty_object());
}

#[test]
fn streaming_never_surfaces_non_finite_numbers() {
	assert_eq!(parse_streaming(r#"{"a":1.5e"#), empty_object());
	assert_eq!(parse_streaming(r#"{"a":NaN}"#), empty_object());
	assert_eq!(parse_streaming(r#"{"a":Truex}"#), empty_object());
	assert_eq!(parse_streaming(r#"{"a":1e999}"#), empty_object());
}

#[test]
fn streaming_rolls_back_barewords_instead_of_committing_junk() {
	assert_eq!(parse_streaming(r#"{"paths": packages/coding-agent/src/stt/*"#), empty_object());
	assert_eq!(
		parse_streaming(r#"{"paths": packages/coding-agent/src/stt/*, "i": "Listing st"#),
		empty_object()
	);
}

#[test]
fn streaming_recovers_null_values() {
	assert_eq!(parse_streaming("null"), Value::Null);
	assert_eq!(parse_streaming("None"), Value::Null);
}

#[test]
fn streaming_surfaces_partial_string_that_looks_like_structure() {
	// A mid-stream todo payload can contain a string such as `{ ops: "[{" }`;
	// structure characters inside a string must surface as a string, while a real
	// open array yields empty structure.
	assert_eq!(parse_streaming(r#"{"ops": "[{"#), json!({ "ops": "[{" }));
	assert_eq!(parse_streaming(r#"{"ops": [{"#), json!({ "ops": [{}] }));
	assert_eq!(parse_streaming("[nul"), json!([]));
}

// ── Rust-specific coverage ───────────────────────────────────────────────────

#[test]
fn combines_surrogate_pair_escapes() {
	assert_eq!(parse(r#"{"e": "\uD83D\uDE00"}"#).unwrap(), json!({ "e": "😀" }));
}

#[test]
fn replaces_lone_surrogate_escapes() {
	assert_eq!(parse(r#"{"e": "\uD83D!"}"#).unwrap(), json!({ "e": "\u{FFFD}!" }));
	assert_eq!(parse(r#"{"e": "\uDE00"}"#).unwrap(), json!({ "e": "\u{FFFD}" }));
}

#[test]
fn keeps_invalid_unicode_escape_literal() {
	assert_eq!(parse(r#"{"e": "\u12x"}"#).unwrap(), json!({ "e": "\\u12x" }));
}

#[test]
fn parses_hex_and_binary_literals_like_js_number() {
	assert_eq!(parse(r#"{"a": 0x1A, "b": 0b101}"#).unwrap(), json!({ "a": 26, "b": 5 }));
	assert!(parse(r#"{"a": 0x}"#).is_err());
}

#[test]
fn preserves_large_integers_exactly() {
	assert_eq!(
		parse("{n: 9007199254740993, m: -9007199254740993}").unwrap(),
		json!({ "n": 9_007_199_254_740_993i64, "m": -9_007_199_254_740_993i64 })
	);
	assert_eq!(parse("{n: 18446744073709551615}").unwrap()["n"].as_u64(), Some(u64::MAX));
}

#[test]
fn rejects_overflow_to_infinity() {
	assert!(parse("{n: 1e999}").is_err());
}

#[test]
fn depth_limit_fails_strict_and_rolls_back_partial() {
	let deep = "[".repeat(300);
	assert!(parse(&deep).is_err());
	// Streaming must neither fail nor overflow the stack; it yields the
	// auto-closed prefix up to the depth limit.
	assert!(parse_streaming(&deep).is_array());
}

#[test]
fn display_serializes_compact_json_that_roundtrips() {
	let value = json!({ "a": [1, 2.5, "x\n\u{1}\"\\"], "b": null, "c": { "k": true } });
	let text = value.to_string();
	assert_eq!(text, r#"{"a":[1,2.5,"x\n\u0001\"\\"],"b":null,"c":{"k":true}}"#);
	assert_eq!(parse(&text).unwrap(), value);
	// Integral floats stay recognizably float.
	assert_eq!(parse("[1.0]").unwrap().to_string(), "[1.0]");
}

#[test]
fn object_equality_ignores_member_order() {
	assert_eq!(parse(r#"{"a":1,"b":2}"#).unwrap(), parse(r#"{"b":2,"a":1}"#).unwrap());
	assert_ne!(parse(r#"{"a":1,"b":2}"#).unwrap(), parse(r#"{"a":1,"b":3}"#).unwrap());
}

// ── typed deserialization (from_str) ─────────────────────────────────────────

#[derive(Debug, PartialEq, serde::Deserialize)]
struct Args {
	path:    String,
	count:   u32,
	tags:    Vec<String>,
	dry_run: Option<bool>,
	mode:    Mode,
}

#[derive(Debug, PartialEq, serde::Deserialize)]
enum Mode {
	Fast,
	Careful { retries: u8 },
}

#[test]
fn typed_from_str_over_slop() {
	let args: Args = from_str(
		"{path: 'a.ts', count: 2, tags: [src/x/*, 'b'], dry_run: None, mode: 'Fast', // done\n}",
	)
	.unwrap();
	assert_eq!(args, Args {
		path:    "a.ts".into(),
		count:   2,
		tags:    vec!["src/x/*".into(), "b".into()],
		dry_run: None,
		mode:    Mode::Fast,
	});
}

#[test]
fn typed_option_bool_distinguishes_null_none_and_true() {
	#[derive(Debug, PartialEq, serde::Deserialize)]
	struct Flags {
		a: Option<bool>,
		b: Option<bool>,
		c: Option<bool>,
	}
	// eat_null must not consume `true`/`false` while probing for null.
	let flags: Flags = from_str("{a: true, b: null, c: None}").unwrap();
	assert_eq!(flags, Flags { a: Some(true), b: None, c: None });
	let flags: Flags = from_str("{'a': False, 'b': True, 'c': null}").unwrap();
	assert_eq!(flags, Flags { a: Some(false), b: Some(true), c: None });
}

#[test]
fn typed_enum_struct_variant_from_map_form() {
	let mode: Mode = from_str("{'Careful': {retries: 3,}}").unwrap();
	assert_eq!(mode, Mode::Careful { retries: 3 });
}

#[test]
fn typed_borrowed_str_is_zero_copy() {
	#[derive(Debug, PartialEq, serde::Deserialize)]
	struct Borrowed<'a> {
		path: &'a str,
	}
	// A clean literal must reach the visitor borrowed from the input.
	let input = r#"{"path": "packages/utils/src/json-parse.ts"}"#;
	let borrowed: Borrowed<'_> = from_str(input).unwrap();
	assert_eq!(borrowed.path, "packages/utils/src/json-parse.ts");
	// Escaped literals cannot borrow and must fail for &str, not corrupt.
	assert!(from_str::<Borrowed<'_>>(r#"{"path": "a\tb"}"#).is_err());
}

#[test]
fn typed_mismatch_surfaces_custom_error() {
	assert!(matches!(from_str::<u32>("true"), Err(ParseError::Custom(_))));
	assert!(matches!(from_str::<Vec<u8>>("{}"), Err(ParseError::Custom(_))));
}

#[test]
fn typed_rejects_trailing_garbage_and_truncation() {
	assert!(from_str::<Value>("{\"a\":1} nope").is_err());
	assert!(from_str::<Vec<u32>>("[1, 2").is_err());
}

// ── RawValue ─────────────────────────────────────────────────────────────────

#[test]
fn raw_value_borrows_verbatim_span_including_slop() {
	#[derive(serde::Deserialize)]
	struct Envelope<'a> {
		kind:    &'a str,
		#[serde(borrow)]
		payload: &'a RawValue,
	}

	// Slop payload survives verbatim and re-parses to the normalized tree.
	let input = "{kind: 'edit', payload: {'path': 'a.ts', strict: True,}, after: 1}";
	let env: Envelope<'_> = from_str(input).unwrap();
	assert_eq!(env.kind, "edit");
	assert_eq!(env.payload.get(), "{'path': 'a.ts', strict: True,}");
	assert_eq!(parse(env.payload.get()).unwrap(), json!({ "path": "a.ts", "strict": true }));
	// Zero-copy: the span points into the original input.
	let span = env.payload.get();
	assert!(input.as_bytes().as_ptr_range().contains(&span.as_ptr()));
}

#[test]
fn raw_value_bareword_span_is_verbatim_but_not_standalone() {
	#[derive(serde::Deserialize)]
	struct Args<'a> {
		#[serde(borrow)]
		paths: &'a RawValue,
	}

	// Barewords are grammatical only in value position: the span is captured
	// verbatim, but does not re-parse as a standalone document.
	let args: Args<'_> = from_str("{\"paths\": packages/foo/* , \"x\": 1}").unwrap();
	assert_eq!(args.paths.get(), "packages/foo/*");
	assert!(parse(args.paths.get()).is_err());
}

#[test]
fn raw_value_captures_every_value_kind_exactly() {
	for (input, expected) in [
		("\"str\"", "\"str\""),
		("  -12.5e3 ", "-12.5e3"),
		("null", "null"),
		("[1, [2], {\"a\": 3}]", "[1, [2], {\"a\": 3}]"),
		("[1,]", "[1,]"),
	] {
		let raw: &RawValue = from_str(input).unwrap();
		assert_eq!(raw.get(), expected, "input: {input}");
	}
	// Owned capture copies the same span.
	let boxed: Box<RawValue> = from_str("[1, 2]").unwrap();
	assert_eq!(boxed.get(), "[1, 2]");
	assert_eq!(boxed.get(), "[1, 2]");
}

#[test]
fn raw_value_still_rejects_truncation_and_garbage() {
	assert!(from_str::<&omp_core::slopjson::RawValue>("{\"a\": ").is_err());
	assert!(from_str::<&omp_core::slopjson::RawValue>("[1] nope").is_err());
}

#[test]
fn value_deserializes_borrowed_typed_views_without_text_round_trip() {
	#[derive(Debug, PartialEq, serde::Deserialize)]
	struct View<'a> {
		name:  &'a str,
		items: Vec<u64>,
		flag:  Option<bool>,
	}

	let value = parse(r#"{"name":"borrowed","items":[1,2,3],"flag":true}"#).unwrap();
	let view: View<'_> = value.deserialize_into().unwrap();
	assert_eq!(view, View { name: "borrowed", items: vec![1, 2, 3], flag: Some(true) });
	assert_eq!(view.name.as_ptr(), value["name"].as_str().unwrap().as_ptr());
}
