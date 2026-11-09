//! JSON export: the shfmt dialect against `shfmt --ln=bash --to-json`
//! (v3.14.1) output, and the native schema's ids, offsets and escaping.

use crate::bash::syntax::*;

const SHFMT: [(&str, &str); 15] = [
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
	// Compound closers before continued redirections, bare `case` arms, an
	// empty `in` list, indexed array elements, an empty replacement, a
	// substitution in a here-document and an empty one.
	(include_str!("data/shfmt/case15.sh"), include_str!("data/shfmt/case15.json")),
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

struct Alias(&'static [u8], &'static [u8]);

impl AliasLookup for Alias {
	fn alias(&self, name: &[u8]) -> Option<&[u8]> {
		(name == self.0).then_some(self.1)
	}
}

/// The places in `v` that escape their node: a child whose range is not
/// inside its parent's, a position field outside its node. Ranges are
/// `Pos`/`End` objects (shfmt) or `span` arrays (native).
fn escapes(v: &serde_json::Value, outer: Option<(u64, u64)>, path: &str, out: &mut Vec<String>) {
	use serde_json::Value;
	let off = |p: &Value| p.get("Offset").and_then(Value::as_u64);
	match v {
		Value::Object(m) => {
			let own = match (m.get("Pos").and_then(off), m.get("End").and_then(off), m.get("span")) {
				(Some(lo), Some(hi), _) => Some((lo, hi)),
				(_, _, Some(Value::Array(s))) if s.len() == 2 => s[0].as_u64().zip(s[1].as_u64()),
				_ => None,
			};
			if let (Some((lo, hi)), Some((plo, phi))) = (own, outer)
				&& (lo > hi || lo < plo || hi > phi)
			{
				out.push(format!("{path}: [{lo},{hi}] outside [{plo},{phi}]"));
			}
			let inner = own.or(outer);
			for (k, x) in m {
				// A bare position field (`Rparen`, `DonePos`, `OpPos`, …).
				if k != "Pos"
					&& k != "End"
					&& let Some(at) = off(x)
					&& x.as_object().is_some_and(|o| o.len() == 3)
					&& let Some((lo, hi)) = own
					&& !(lo..=hi).contains(&at)
				{
					out.push(format!("{path}.{k}: {at} outside [{lo},{hi}]"));
				}
				escapes(x, inner, &format!("{path}.{k}"), out);
			}
		},
		Value::Array(a) => {
			for (i, x) in a.iter().enumerate() {
				escapes(x, outer, &format!("{path}[{i}]"), out);
			}
		},
		_ => {},
	}
}

/// Text an alias expands to has no bytes of its own: every token in it
/// reports the place after the aliased word. An export that locates a
/// keyword or a closer by scanning or counting in the source reads the
/// bytes of another node there. Every node of an alias-expanded command
/// lies inside its parent and every position inside its node.
#[test]
fn alias_expanded_commands_keep_positions_inside_their_nodes() {
	const VALUES: [&str; 22] = [
		"( echo ok )",
		"{ echo ok; }",
		"f() { echo ok; }",
		"function g { :; }",
		"if a; then b; elif c; then d; else e; fi",
		"while a; do b; done",
		"until a; do b; done",
		"for i in a b; do :; done",
		"for i; do :; done",
		"for ((i = 0; i < 1; i++)); do :; done",
		"select s in a; do :; done",
		"case x in a) b ;; (c) ;& *) esac",
		"[[ a == b && ( -n c ) || ! d ]]",
		"(( 1 + 2 ))",
		"echo 'a' \"b$x\" ${x:-d} ${y/a/b} $(c) $((1 + 2)) <(true) `d`",
		"x=(1 [2]=b) y[1]=2 z+=a",
		": 12>/dev/null <&- 2>&1",
		"coproc c { :; }",
		"time a | b",
		"! a && b || c & d; e",
		"declare -a a=(1 2) b=c",
		"echo $'x' $\"y\" ~/z",
	];
	const USES: [&str; 4] = [
		"check\n",
		"check 99>/dev/null\n",
		"for i in a; do check; done\n",
		"check; echo after_the_alias\n",
	];
	let mut bad = Vec::new();
	for value in VALUES {
		for use_ in USES {
			let src = use_.as_bytes();
			let table = Alias(b"check", value.as_bytes());
			let mut parser = Parser::new(src, Features::NONE, &table);
			let mut commands = Vec::new();
			while let Some(Ok(cc)) = parser.next_command() {
				commands.push(cc);
			}
			let prog = Program { commands };
			for dialect in [JsonDialect::Native, JsonDialect::Shfmt] {
				let v: serde_json::Value =
					serde_json::from_str(&to_json(src, &prog, dialect, Offsets::Bytes)).unwrap();
				let mut out = Vec::new();
				escapes(&v, None, "", &mut out);
				bad.extend(
					out.into_iter()
						.map(|e| format!("{value:?} as {use_:?} ({dialect:?}): {e}")),
				);
			}
		}
	}
	assert!(bad.is_empty(), "{} escapes:\n{}", bad.len(), bad[..bad.len().min(60)].join("\n"));
}
