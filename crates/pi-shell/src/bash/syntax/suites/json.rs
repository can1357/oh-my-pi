//! JSON export: the shfmt dialect against `shfmt --ln=bash --to-json`
//! (v3.14.1) output, and the native schema's ids, offsets and escaping.

use crate::bash::syntax::*;

const SHFMT: [(&str, &str); 14] = [
	(include_str!("data/shfmt/case1.sh"), include_str!("data/shfmt/case1.json")),
	(include_str!("data/shfmt/case2.sh"), include_str!("data/shfmt/case2.json")),
	(include_str!("data/shfmt/case3.sh"), include_str!("data/shfmt/case3.json")),
	(include_str!("data/shfmt/case4.sh"), include_str!("data/shfmt/case4.json")),
	(include_str!("data/shfmt/case5.sh"), include_str!("data/shfmt/case5.json")),
	(include_str!("data/shfmt/case6.sh"), include_str!("data/shfmt/case6.json")),
	(include_str!("data/shfmt/case7.sh"), include_str!("data/shfmt/case7.json")),
	(include_str!("data/shfmt/case8.sh"), include_str!("data/shfmt/case8.json")),
	(include_str!("data/shfmt/case9.sh"), include_str!("data/shfmt/case9.json")),
	(include_str!("data/shfmt/case10.sh"), include_str!("data/shfmt/case10.json")),
	(include_str!("data/shfmt/case11.sh"), include_str!("data/shfmt/case11.json")),
	(include_str!("data/shfmt/case12.sh"), include_str!("data/shfmt/case12.json")),
	(include_str!("data/shfmt/case13.sh"), include_str!("data/shfmt/case13.json")),
	(include_str!("data/shfmt/case14.sh"), include_str!("data/shfmt/case14.json")),
];

#[test]
fn shfmt_dialect_matches_shfmt_output() {
	let mut failures = Vec::new();
	for (src, want) in SHFMT {
		let prog = parse_all(src.as_bytes(), Features::NONE).expect("parses");
		let got = to_json(src.as_bytes(), &prog, JsonDialect::Shfmt, Offsets::Bytes);
		if got != want {
			failures.push(format!("{src:?}\n--- shfmt\n{want}\n--- ours\n{got}"));
		}
	}
	assert!(failures.is_empty(), "{} differ:\n\n{}", failures.len(), failures.join("\n\n"));
}

#[test]
fn native_json_carries_ids_and_spans() {
	let src = b"a=1 echo \"$x\" | cat\n";
	let prog = parse_all(src, Features::NONE).unwrap();
	let json = to_json(src, &prog, JsonDialect::Native, Offsets::Bytes);
	assert!(json.starts_with("{\"commands\":[{\"span\":[0,19],\"line\":1,"), "{json}");
	assert!(json.contains("\"node_count\":"), "{json}");
	for id in 0..prog.commands[0].node_count {
		assert!(json.contains(&format!("\"id\":{id},")), "id {id} in {json}");
	}
	assert!(json.contains("\"type\":\"param\",\"name\":\"x\""), "{json}");
}

#[test]
fn utf16_offsets_count_code_units() {
	let src = "echo é 😀 x".as_bytes();
	let prog = parse_all(src, Features::NONE).unwrap();
	let bytes = to_json(src, &prog, JsonDialect::Native, Offsets::Bytes);
	let units = to_json(src, &prog, JsonDialect::Native, Offsets::Utf16);
	// `x` starts at byte 13 and at UTF-16 index 10.
	assert!(bytes.contains("\"span\":[13,14]"), "{bytes}");
	assert!(units.contains("\"span\":[10,11]"), "{units}");
}

#[test]
fn json_strings_escape_controls_and_replace_invalid_utf8() {
	let src = b"echo $'\\t' \xff \"a\\\"b\"\n";
	let prog = parse_all(src, Features::NONE).unwrap();
	let json = to_json(src, &prog, JsonDialect::Native, Offsets::Bytes);
	assert!(json.contains("\u{fffd}"), "{json}");
	assert!(json.contains("\"value\":\"\\\\t\""), "{json}");
	assert!(json.contains("\\\""), "{json}");
	assert!(!json.contains('\n'), "native JSON is one line");
}

#[test]
fn empty_program_is_a_bare_file_in_the_shfmt_dialect() {
	let prog = parse_all(b"", Features::NONE).unwrap();
	assert_eq!(
		to_json(b"", &prog, JsonDialect::Shfmt, Offsets::Bytes),
		"{\n\t\"Type\": \"File\"\n}\n"
	);
}
