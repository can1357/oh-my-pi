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

#[test]
fn logical_json_keeps_binary_rhs_nesting_and_source_positions() {
	let src = b"[[ a && b && c || d || e ]]";
	let program = parse_all(src, Features::NONE).unwrap();
	let native: serde_json::Value =
		serde_json::from_str(&to_json(src, &program, JsonDialect::Native, Offsets::Bytes)).unwrap();
	let expr = &native["commands"][0]["list"][0]["and_or"]["first"]["stages"][0]["cmd"]["expr"];
	assert_eq!(expr["type"], "or");
	assert_eq!(expr["lhs"]["type"], "and");
	assert_eq!(expr["lhs"]["rhs"]["type"], "and");
	assert_eq!(expr["rhs"]["type"], "or");
	assert_eq!(expr["rhs"]["rhs"]["word"]["parts"][0]["value"], "e");
	let shfmt: serde_json::Value =
		serde_json::from_str(&to_json(src, &program, JsonDialect::Shfmt, Offsets::Bytes)).unwrap();
	let expr = &shfmt["Stmts"][0]["Cmd"]["X"];
	assert_eq!(expr["Op"], "||");
	assert_eq!(expr["OpPos"]["Offset"], 15);
	assert_eq!(expr["X"]["Y"]["Op"], "&&");
	assert_eq!(expr["X"]["Y"]["OpPos"]["Offset"], 10);
	assert_eq!(expr["Y"]["Op"], "||");
	assert_eq!(expr["Y"]["OpPos"]["Offset"], 20);
	assert_eq!(expr["Y"]["Y"]["Parts"][0]["Value"], "e");
}

#[test]
fn long_logical_chains_export_native_json_without_stack_growth() {
	for features in [Features::NONE, Features::ZSH] {
		for (op, kind) in [(" && ", "and"), (" || ", "or")] {
			let src = format!("[[ {} ]]", vec!["a"; 100_000].join(op));
			let program = parse_all(src.as_bytes(), features).unwrap();
			let json = to_json(src.as_bytes(), &program, JsonDialect::Native, Offsets::Bytes);
			assert_eq!(json.matches(&format!("\"type\":\"{kind}\"")).count(), 99_999);
			let field = if features.contains(Features::ZSH) {
				"text"
			} else {
				"value"
			};
			assert_eq!(json.matches(&format!("\"{field}\":\"a\"")).count(), 100_000);
		}
	}
}

#[test]
fn bang_runs_export_one_not_per_bang_at_its_own_position() {
	// Two blanks after the inner `!`: each `!` keeps the offset it has in the
	// source.
	let src = b"[[ ! !  a ]]";
	let program = parse_all(src, Features::NONE).unwrap();
	let shfmt: serde_json::Value =
		serde_json::from_str(&to_json(src, &program, JsonDialect::Shfmt, Offsets::Bytes)).unwrap();
	let expr = &shfmt["Stmts"][0]["Cmd"]["X"];
	assert_eq!(expr["Op"], "!");
	assert_eq!(expr["OpPos"]["Offset"], 3);
	assert_eq!(expr["X"]["Op"], "!");
	assert_eq!(expr["X"]["OpPos"]["Offset"], 5);
	assert_eq!(expr["X"]["X"]["Parts"][0]["Value"], "a");
	let native: serde_json::Value =
		serde_json::from_str(&to_json(src, &program, JsonDialect::Native, Offsets::Bytes)).unwrap();
	let expr = &native["commands"][0]["list"][0]["and_or"]["first"]["stages"][0]["cmd"]["expr"];
	assert_eq!(expr["type"], "not");
	assert_eq!(expr["expr"]["type"], "not");
	assert_eq!(expr["expr"]["expr"]["type"], "word");
}

#[test]
fn long_bang_runs_export_json_without_stack_growth() {
	let src = format!("[[ {}a ]]", "! ".repeat(100_000));
	for features in [Features::NONE, Features::ZSH] {
		let program = parse_all(src.as_bytes(), features).unwrap();
		let json = to_json(src.as_bytes(), &program, JsonDialect::Native, Offsets::Bytes);
		assert_eq!(json.matches("\"type\":\"not\"").count(), 100_000);
	}
	// The shfmt dialect indents each level, so its size grows with the square
	// of the depth: a shorter run keeps the output small.
	let src = format!("[[ {}a ]]", "! ".repeat(5_000));
	let program = parse_all(src.as_bytes(), Features::NONE).unwrap();
	let json = to_json(src.as_bytes(), &program, JsonDialect::Shfmt, Offsets::Bytes);
	assert_eq!(json.matches("\"Op\": \"!\"").count(), 5_000);
}

#[test]
fn a_conditional_chain_starts_where_its_operators_are_written() {
	// Two blanks after the inner `!` and two before the unary operand: the
	// enclosing `&&` must start at the first `!` and its right operand at
	// `-n`, read from the source, not estimated at a fixed width per
	// operator. A consumer slicing the source with these offsets otherwise
	// gets a condition with one negation missing.
	let src = b"[[ ! !  a && -n  b ]]";
	let program = parse_all(src, Features::NONE).unwrap();
	let shfmt: serde_json::Value =
		serde_json::from_str(&to_json(src, &program, JsonDialect::Shfmt, Offsets::Bytes)).unwrap();
	let expr = &shfmt["Stmts"][0]["Cmd"]["X"];
	assert_eq!(expr["Op"], "&&");
	assert_eq!(expr["Pos"]["Offset"], 3, "chain starts at the outer `!`");
	assert_eq!(expr["End"]["Offset"], 18, "chain ends after `b`");
	assert_eq!(expr["X"]["Pos"]["Offset"], 3, "left operand starts at the outer `!`");
	assert_eq!(expr["Y"]["Pos"]["Offset"], 13, "right operand starts at `-n`");
	assert_eq!(expr["Y"]["OpPos"]["Offset"], 13);
}

#[test]
fn a_conditional_chain_ends_where_its_group_closes() {
	// Blanks inside the parentheses: the enclosing `&&` must end at the
	// group's `)`, read from the source, not two bytes after the operand.
	// A consumer otherwise gets a parent range that does not contain its
	// own right operand.
	let src = b"[[ b &&  (  a  ) ]]";
	let program = parse_all(src, Features::NONE).unwrap();
	let shfmt: serde_json::Value =
		serde_json::from_str(&to_json(src, &program, JsonDialect::Shfmt, Offsets::Bytes)).unwrap();
	let expr = &shfmt["Stmts"][0]["Cmd"]["X"];
	assert_eq!(expr["Op"], "&&");
	assert_eq!(expr["Pos"]["Offset"], 3, "chain starts at `b`");
	assert_eq!(expr["End"]["Offset"], 16, "chain ends after the group's `)`");
	assert_eq!(expr["Y"]["Rparen"]["Offset"], 15);
	assert_eq!(expr["Y"]["End"]["Offset"], 16);
}

#[test]
fn a_conditional_chain_starts_where_its_operators_are_written_across_trivia() {
	// A `\newline` and a comment stand between an operator and its operand
	// as freely as a blank does. The exported range of the chain must
	// still start at the operator: a consumer slicing the source with a
	// range that starts after it runs a different condition.
	for (src, pos, end) in [
		(&b"[[ !\\\n a && b ]]"[..], 3u32, 13u32),
		(&b"[[ ! # c\n a && b ]]"[..], 3, 16),
		(&b"[[ (\\\n a ) && b ]]"[..], 3, 15),
	] {
		let program = parse_all(src, Features::NONE).unwrap();
		let json = to_json(src, &program, JsonDialect::Shfmt, Offsets::Bytes);
		let shfmt: serde_json::Value = serde_json::from_str(&json).unwrap();
		let expr = &shfmt["Stmts"][0]["Cmd"]["X"];
		let text = String::from_utf8_lossy(src).into_owned();
		assert_eq!(expr["Op"], "&&", "{text}");
		assert_eq!(expr["Pos"]["Offset"], pos, "chain starts at its first operator in {text}");
		assert_eq!(expr["X"]["Pos"]["Offset"], pos, "left operand starts there too in {text}");
		assert_eq!(expr["End"]["Offset"], end, "chain ends after its last operand in {text}");
	}
}

#[test]
fn an_exported_conditional_keeps_its_operators_whatever_stands_before_them() {
	// The offset of an operator is the parser's, not a guess made by
	// reading the source backwards: a quote closed on an earlier line, a
	// comment right after `(`, and an operator split by `\newline` all
	// defeat such a guess, and the exported range then selects a
	// condition that answers differently from the one written.
	for (src, stmt, pos, end) in [
		(&b": 'start\nend'; [[ ! # c\n a && b ]]"[..], 1usize, 18u32, 31u32),
		(&b"[[ (# c\n a ) && b ]]"[..], 0, 3, 17),
		(&b"[[ -\\\nz a && b ]]"[..], 0, 3, 14),
	] {
		let program = parse_all(src, Features::NONE).unwrap();
		let json = to_json(src, &program, JsonDialect::Shfmt, Offsets::Bytes);
		let shfmt: serde_json::Value = serde_json::from_str(&json).unwrap();
		let expr = &shfmt["Stmts"][stmt]["Cmd"]["X"];
		let text = String::from_utf8_lossy(src).into_owned();
		assert_eq!(expr["Op"], "&&", "{text}");
		assert_eq!(expr["Pos"]["Offset"], pos, "chain starts at its first operator in {text}");
		assert_eq!(expr["X"]["Pos"]["Offset"], pos, "left operand starts there too in {text}");
		assert_eq!(expr["End"]["Offset"], end, "chain ends after its last operand in {text}");
	}
}

struct OneAlias(&'static [u8], &'static [u8]);

impl AliasLookup for OneAlias {
	fn alias(&self, name: &[u8]) -> Option<&[u8]> {
		(name == self.0).then_some(self.1)
	}
}

/// Record every node of `v` whose `End` offset is before its `Pos` offset.
fn backwards_ranges(v: &serde_json::Value, path: &str, bad: &mut Vec<String>) {
	match v {
		serde_json::Value::Object(map) => {
			let at = |k: &str| map.get(k)?.get("Offset")?.as_u64();
			if let (Some(pos), Some(end)) = (at("Pos"), at("End"))
				&& end < pos
			{
				bad.push(format!("{path}: Pos {pos} > End {end}"));
			}
			for (k, child) in map {
				backwards_ranges(child, &format!("{path}.{k}"), bad);
			}
		},
		serde_json::Value::Array(items) => {
			for (i, child) in items.iter().enumerate() {
				backwards_ranges(child, &format!("{path}[{i}]"), bad);
			}
		},
		_ => {},
	}
}

#[test]
fn an_alias_expanded_conditional_exports_no_backwards_range() {
	// The text an alias expands to is not in the source, so no position
	// inside it can be found by reading the source. Every `!` of a run and
	// every `&&` / `||` of a chain carries the offset the parser read it
	// at, which for alias text is the alias word's own position. Before
	// that, the export kept only the first `!` and scanned the source
	// forward for the later ones: the scan walked off the alias word and
	// the second `!` was exported with its end before its start, around a
	// child inside it. A consumer that slices the source with such a range
	// panics or selects nothing.
	let src = b"check\n";
	let table = OneAlias(b"check", b"[[ ! ! a && -n b || ( c ) ]]");
	let mut parser = Parser::new(src, Features::NONE, &table);
	let mut commands = Vec::new();
	while let Some(cmd) = parser.next_command() {
		commands.push(cmd.expect("the aliased conditional parses"));
	}
	let program = Program { commands };
	for offsets in [Offsets::Bytes, Offsets::Utf16] {
		let json = to_json(src, &program, JsonDialect::Shfmt, offsets);
		let shfmt: serde_json::Value = serde_json::from_str(&json).unwrap();
		assert_eq!(shfmt["Stmts"][0]["Cmd"]["X"]["Op"], "||", "the aliased chain is exported");
		let mut bad = Vec::new();
		backwards_ranges(&shfmt, "", &mut bad);
		assert!(bad.is_empty(), "{offsets:?}: {} backwards ranges: {bad:?}\n{json}", bad.len());
	}
}

struct AliasOne<'a>(&'a [u8], &'a [u8]);

impl AliasLookup for AliasOne<'_> {
	fn alias(&self, name: &[u8]) -> Option<&[u8]> {
		(name == self.0).then_some(self.1)
	}
}

fn token_range(v: &serde_json::Value) -> Option<(u64, u64)> {
	if let Some(span) = v.get("span") {
		return Some((span.get(0)?.as_u64()?, span.get(1)?.as_u64()?));
	}
	let pos = v.get("Pos")?.get("Offset")?.as_u64()?;
	let end = v.get("End")?.get("Offset")?.as_u64()?;
	Some((pos, end))
}

/// A bare position field (`Lparen`, `DoPos`, `Esac`, …): an offset that
/// carries no range of its own, and must lie inside the node that holds it.
fn bare_offset(v: &serde_json::Value) -> Option<u64> {
	if v.get("Pos").is_some() || v.get("End").is_some() {
		return None;
	}
	v.get("Offset")?.as_u64()
}

fn range_faults(
	v: &serde_json::Value,
	parent: Option<((u64, u64), String)>,
	path: &str,
	bad: &mut Vec<String>,
) {
	let mut here = parent.clone();
	match v {
		serde_json::Value::Object(map) => {
			if let Some((pos, end)) = token_range(v) {
				if end < pos {
					bad.push(format!("{path}: backwards [{pos},{end}]"));
				}
				if let Some(((ppos, pend), ppath)) = &parent
					&& (pos < *ppos || end > *pend)
				{
					bad.push(format!("{path} [{pos},{end}] outside {ppath} [{ppos},{pend}]"));
				}
				here = Some(((pos, end), path.to_string()));
			}
			for (k, child) in map {
				if k.ends_with("_span")
					&& let (Some(lo), Some(hi)) = (
						child.get(0).and_then(serde_json::Value::as_u64),
						child.get(1).and_then(serde_json::Value::as_u64),
					)
					&& let Some(((pos, end), _)) = &here
					&& (lo < *pos || hi > *end || hi < lo)
				{
					bad.push(format!("{path}.{k} [{lo},{hi}] outside [{pos},{end}]"));
				}
				if let Some(o) = bare_offset(child)
					&& let Some(((pos, end), _)) = &here
					&& (o < *pos || o > *end)
				{
					bad.push(format!("{path}.{k} at {o} outside [{pos},{end}]"));
				}
				// shfmt attaches leading/trailing comments to a statement,
				// but they are trivia, outside its syntactic source range.
				let enclosing = if k == "Comments" { None } else { here.clone() };
				range_faults(child, enclosing, &format!("{path}.{k}"), bad);
			}
		},
		serde_json::Value::Array(items) => {
			for (i, child) in items.iter().enumerate() {
				range_faults(child, here.clone(), &format!("{path}[{i}]"), bad);
			}
		},
		_ => {},
	}
}

/// Decode an exported unit offset independently of the exporter's OffMap.
fn byte_offset(src: &[u8], off: u64, offsets: Offsets) -> Option<usize> {
	if offsets == Offsets::Bytes {
		return usize::try_from(off).ok().filter(|&i| i <= src.len());
	}
	let text = core::str::from_utf8(src).ok()?;
	let mut units = 0;
	for (i, c) in text.char_indices() {
		if units == off {
			return Some(i);
		}
		units += c.len_utf16() as u64;
	}
	(units == off).then_some(src.len())
}

/// The closing token a node kind ends with, and whether the node's own `End`
/// is just after it. A closer that does not end its node (a C-style loop's
/// header `))`, which the loop's body follows) is anchored differently.
fn closing_delimiter(v: &serde_json::Value) -> Option<(&'static str, &'static [u8], bool)> {
	Some(match v.get("Type")?.as_str()? {
		"DblQuoted" => ("Right", b"\"".as_slice(), true),
		"SglQuoted" => ("Right", b"'", true),
		"CmdSubst" if v["Backquotes"] == true => ("Right", b"`", true),
		"CmdSubst" if v["TempFile"] == true || v["ReplyVar"] == true => ("Right", b"}", true),
		"CmdSubst" => ("Right", b")", true),
		"ArithmExp" if v["Bracket"] == true => ("Right", b"]", true),
		"ArithmExp" | "ArithmCmd" => ("Right", b"))", true),
		"TestClause" => ("Right", b"]]", true),
		"CStyleLoop" => ("Rparen", b"))", false),
		"Subshell" | "ParenTest" | "ProcSubst" | "ArrayExpr" => ("Rparen", b")", true),
		"Block" => ("Rbrace", b"}", true),
		"ParamExp" if v.get("Rbrace").is_some() => ("Rbrace", b"}", true),
		// Keyword closers (`DonePos`, `FiPos`, `Esac`) are deliberately out:
		// the same node closes with `done`, with `}` for a brace body, and
		// with `end` in zsh's short forms, so a byte check on them asserts
		// the dialect's spelling rather than the position. They are covered
		// by containment and by the fixtures compared with real shfmt.
		_ => return None,
	})
}

/// Read `token` at `at`, allowing the line continuations bash removes, and
/// report the offset just after its last byte. `None` when the buffer does
/// not hold that token there.
fn token_end(src: &[u8], at: usize, token: &[u8]) -> Option<usize> {
	let mut i = at;
	for &want in token {
		while src.get(i) == Some(&b'\\') && src.get(i + 1) == Some(&b'\n') {
			i += 2;
		}
		if src.get(i) != Some(&want) {
			return None;
		}
		i += 1;
	}
	Some(i)
}

/// The ordinary buffer must really hold the claimed delimiter THERE, and the
/// token must be the one that closes this node: where a node ends with its
/// closer, the token read at the exported offset must end exactly at the
/// node's own `End`, so a similarly spelled token nested inside it — the
/// inner `))` of `(( ((1)) + 2 ))` — cannot satisfy the check. A C-style
/// loop's header `))` does not end its node, and is anchored after the last
/// header expression instead. For an alias, the independently expanded
/// buffer supplies the reference position, which is mapped back through the
/// replacement: bytes the alias owns belong to the position just after
/// `check`, never to a similarly spelled token elsewhere in the source.
fn delimiter_faults(
	v: &serde_json::Value,
	src: &[u8],
	offsets: Offsets,
	alias: Option<(&serde_json::Value, &[u8], usize, usize)>,
	path: &str,
	bad: &mut Vec<String>,
) {
	if let Some((key, delimiter, ends_node)) = closing_delimiter(v)
		&& !v[key].is_null()
	{
		let at = v[key]["Offset"]
			.as_u64()
			.and_then(|o| byte_offset(src, o, offsets));
		// Where the node itself ends, in the same buffer and unit.
		let node_end = v["End"]["Offset"]
			.as_u64()
			.and_then(|o| byte_offset(src, o, offsets));
		// A loop or clause whose body is written `{ … }` closes with the
		// brace rather than its keyword.
		let spellings: &[&[u8]] = if delimiter[0].is_ascii_alphabetic() {
			&[delimiter, b"}"]
		} else {
			core::slice::from_ref(&delimiter)
		};
		let anchored = |buffer: &[u8], i: usize, end: Option<usize>| -> bool {
			let Some(after) = spellings
				.iter()
				.find_map(|token| token_end(buffer, i, token))
			else {
				return false;
			};
			if ends_node {
				return end == Some(after);
			}
			// A header closer: it must follow the last header expression.
			let last = ["Post", "Cond", "Init"].iter().find_map(|k| {
				v[k]["End"]["Offset"]
					.as_u64()
					.and_then(|o| byte_offset(buffer, o, offsets))
			});
			last.is_none_or(|e| i >= e)
		};
		let valid = if let Some((reference, expanded, start, len)) = alias {
			let expected = reference[key]["Offset"]
				.as_u64()
				.and_then(|o| byte_offset(expanded, o, offsets));
			let reference_end = reference["End"]["Offset"]
				.as_u64()
				.and_then(|o| byte_offset(expanded, o, offsets));
			expected.is_some_and(|i| {
				anchored(expanded, i, reference_end)
					&& at
						== Some(if i < start {
							i
						} else if i < start + len {
							start + b"check".len()
						} else {
							i - len + b"check".len()
						})
			})
		} else {
			at.is_some_and(|i| anchored(src, i, node_end))
		};
		if !valid {
			bad.push(format!(
				"{path}.{key}: {:?} is not the position of this node's own {:?}",
				v[key]["Offset"],
				String::from_utf8_lossy(delimiter)
			));
		}
	}
	if v.get("Hdoc").is_some() {
		let reference = alias.map_or(v, |(r, ..)| r);
		let mut delimiter = String::new();
		if let Some(parts) = reference["Word"]["Parts"].as_array() {
			for part in parts {
				if let Some(value) = part["Value"].as_str() {
					delimiter.push_str(value);
				}
			}
		}
		let end = v["Hdoc"]["End"]["Offset"]
			.as_u64()
			.and_then(|o| byte_offset(src, o, offsets));
		let (check, buffer) = alias.map_or((end, src), |(r, expanded, ..)| {
			(
				r["Hdoc"]["End"]["Offset"]
					.as_u64()
					.and_then(|o| byte_offset(expanded, o, offsets)),
				expanded,
			)
		});
		let valid_bytes = check.is_some_and(|i| {
			i.checked_sub(delimiter.len())
				.and_then(|start| buffer.get(start..i))
				== Some(delimiter.as_bytes())
		});
		let valid_provenance = alias.is_none_or(|(_, _, start, len)| {
			check.is_some_and(|i| {
				end == Some(if i <= start {
					i
				} else if i <= start + len {
					start + 5
				} else {
					i - len + 5
				})
			})
		});
		if !valid_bytes || !valid_provenance {
			bad.push(format!(
				"{path}.Hdoc.End: {end:?} does not end delimiter {delimiter:?} at its \
				 source/provenance position"
			));
		}
	}
	match v {
		serde_json::Value::Object(map) => {
			for (k, child) in map {
				let next = alias.map(|(r, s, start, len)| (&r[k], s, start, len));
				delimiter_faults(child, src, offsets, next, &format!("{path}.{k}"), bad);
			}
		},
		serde_json::Value::Array(items) => {
			for (i, child) in items.iter().enumerate() {
				let next = alias.map(|(r, s, start, len)| (&r[i], s, start, len));
				delimiter_faults(child, src, offsets, next, &format!("{path}[{i}]"), bad);
			}
		},
		_ => {},
	}
}

#[test]
fn delimiter_oracle_rejects_a_contained_but_wrong_delimiter() {
	let src = b"for ((i=0; i<3; i++)); do :; done";
	let program = parse_all(src, Features::NONE).unwrap();
	let mut document: serde_json::Value =
		serde_json::from_str(&to_json(src, &program, JsonDialect::Shfmt, Offsets::Bytes)).unwrap();
	document["Stmts"][0]["Cmd"]["Loop"]["Rparen"]["Offset"] = 16.into();
	let mut ranges = Vec::new();
	range_faults(&document, None, "", &mut ranges);
	assert!(ranges.is_empty(), "mutation stays contained: {ranges:?}");
	let mut bad = Vec::new();
	delimiter_faults(&document, src, Offsets::Bytes, None, "", &mut bad);
	assert_eq!(bad.len(), 1, "{bad:?}");
	assert!(bad[0].contains("Loop.Rparen"), "{bad:?}");
	eprintln!("contained delimiter mutation: {}", bad[0]);
}

#[test]
fn delimiter_oracle_rejects_a_continuation_before_the_delimiter() {
	// An offset at the preceding backslash is contained and reaches the
	// same token end, but it is not the delimiter's first byte.
	for (src, key, recorded, wrong) in [
		(b"( : \\\n)".as_slice(), "Rparen", 6, 4),
		(b"[[ a \\\n]]".as_slice(), "Right", 7, 5),
	] {
		let program = parse_all(src, Features::NONE).unwrap();
		let cmd = &program.commands[0].list.items[0].and_or.first.stages[0].cmd;
		assert_eq!(cmd.close, Some(recorded));
		for offsets in [Offsets::Bytes, Offsets::Utf16] {
			let mut document: serde_json::Value =
				serde_json::from_str(&to_json(src, &program, JsonDialect::Shfmt, offsets)).unwrap();
			let mut bad = Vec::new();
			delimiter_faults(&document, src, offsets, None, "", &mut bad);
			assert!(bad.is_empty(), "unmodified {key}: {bad:?}");
			document["Stmts"][0]["Cmd"][key]["Offset"] = wrong.into();
			let mut ranges = Vec::new();
			range_faults(&document, None, "", &mut ranges);
			assert!(ranges.is_empty(), "mutation stays contained: {ranges:?}");
			delimiter_faults(&document, src, offsets, None, "", &mut bad);
			assert_eq!(bad.len(), 1, "{key} {offsets:?}: {bad:?}");
			assert!(bad[0].contains(&format!("Cmd.{key}:")), "{bad:?}");
			eprintln!("continued-delimiter mutation {key} {offsets:?}: {}", bad[0]);
		}
	}
}

#[test]
fn delimiter_oracle_rejects_both_wrong_try_closers() {
	// The first closer must not select a nested block's identical `}`;
	// the second must not point inside the always body.
	for (src, key, recorded, wrong) in [
		(b"{ { : } } always { : }".as_slice(), "Rbrace", 8, 6),
		(b"{ : } always { { : } }".as_slice(), "AlwaysEnd", 21, 18),
		(b"{ : } always { { : } }".as_slice(), "AlwaysEnd", 21, 19),
	] {
		let program = parse_all(src, zsh_features()).unwrap();
		let cmd = &program.commands[0].list.items[0].and_or.first.stages[0].cmd;
		let CommandKind::Try(clause) = &cmd.kind else {
			panic!("a try clause");
		};
		let position = if key == "Rbrace" { Some(clause.rbrace) } else { cmd.close };
		assert_eq!(position, Some(recorded));
		for offsets in [Offsets::Bytes, Offsets::Utf16] {
			let mut document: serde_json::Value =
				serde_json::from_str(&to_json(src, &program, JsonDialect::Shfmt, offsets)).unwrap();
			let mut bad = Vec::new();
			delimiter_faults(&document, src, offsets, None, "", &mut bad);
			assert!(bad.is_empty(), "unmodified {key}: {bad:?}");
			document["Stmts"][0]["Cmd"][key]["Offset"] = wrong.into();
			let mut ranges = Vec::new();
			range_faults(&document, None, "", &mut ranges);
			assert!(ranges.is_empty(), "mutation stays contained: {ranges:?}");
			delimiter_faults(&document, src, offsets, None, "", &mut bad);
			assert_eq!(bad.len(), 1, "{key} {offsets:?}: {bad:?}");
			assert!(bad[0].contains(&format!("Cmd.{key}:")), "{bad:?}");
			eprintln!("try-closer mutation {key} {offsets:?}: {}", bad[0]);
		}
	}
}

#[test]
fn delimiter_oracle_accepts_continuations_between_delimiter_bytes() {
	let src = b"[[ a ]\\\n]";
	let program = parse_all(src, Features::NONE).unwrap();
	let document = serde_json::from_str(&to_json(src, &program, JsonDialect::Shfmt, Offsets::Bytes))
		.unwrap();
	let mut bad = Vec::new();
	delimiter_faults(&document, src, Offsets::Bytes, None, "", &mut bad);
	assert!(bad.is_empty(), "{bad:?}");
}

#[test]
fn arithmetic_delimiters_keep_consumed_source_and_alias_positions() {
	let mut bad = Vec::new();
	for (name, source, text, close, utf16_close) in [
		("ordinary", "# 😀\nfor ((i=0; i<3; i++)); do :; done\n", "", 26, 24),
		("mixed-alias", "# 😀\ncheck i++)); do :; done\n", "for ((i=0; i<3; ", 16, 14),
		("whole-alias", "# 😀\ncheck\n", "for ((i=0; i<3; i++)); do :; done", 12, 10),
	] {
		let table = AliasOne(b"check", text.as_bytes());
		let mut parser = Parser::new(source.as_bytes(), zsh_features(), &table);
		let commands = std::iter::from_fn(|| parser.next_command())
			.collect::<Result<Vec<_>, _>>()
			.unwrap();
		let program = Program { commands };
		for (offsets, want) in [(Offsets::Bytes, close), (Offsets::Utf16, utf16_close)] {
			let json = to_json(source.as_bytes(), &program, JsonDialect::Shfmt, offsets);
			let document: serde_json::Value = serde_json::from_str(&json).unwrap();
			let got = &document["Stmts"][0]["Cmd"]["Loop"]["Rparen"]["Offset"];
			eprintln!("delimiter-row {name} {offsets:?}: Rparen={got}, want={want}");
			if got != want {
				bad.push(format!("{name} {offsets:?}: Rparen={got}, want={want}"));
			}
		}
	}
	assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn arithmetic_command_body_does_not_add_bytes_to_alias_text() {
	let source = "# 😀\ncheck + 2 ))\n".as_bytes();
	let table = AliasOne(b"check", b"(( 1");
	let mut parser = Parser::new(source, zsh_features(), &table);
	let program = Program {
		commands: std::iter::from_fn(|| parser.next_command())
			.collect::<Result<Vec<_>, _>>()
			.unwrap(),
	};
	let mut bad = Vec::new();
	for (offsets, want) in [(Offsets::Bytes, (12, 17)), (Offsets::Utf16, (10, 15))] {
		let json = to_json(source, &program, JsonDialect::Native, offsets);
		let document: serde_json::Value = serde_json::from_str(&json).unwrap();
		let expr = &document["commands"][0]["list"][0]["and_or"]["first"]["stages"][0]["cmd"]["expr"];
		let got = token_range(expr);
		eprintln!("delimiter-row arithmetic-command {offsets:?}: span={got:?}, want={want:?}");
		if got != Some(want) {
			bad.push(format!("{offsets:?}: span={got:?}, want={want:?}"));
		}
	}
	assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn heredoc_delimiter_oracle_checks_the_source_terminator() {
	let src = "# 😀\ncat <<EOF\nbody\nEOF\n".as_bytes();
	for features in [Features::NONE, zsh_features()] {
		let program = parse_all(src, features).unwrap();
		for (offsets, wrong) in [(Offsets::Bytes, 24), (Offsets::Utf16, 22)] {
			let mut document: serde_json::Value =
				serde_json::from_str(&to_json(src, &program, JsonDialect::Shfmt, offsets)).unwrap();
			let mut bad = Vec::new();
			delimiter_faults(&document, src, offsets, None, "", &mut bad);
			assert!(bad.is_empty(), "{features:?} {offsets:?}: {bad:?}");
			document["Stmts"][0]["Redirs"][0]["Hdoc"]["End"]["Offset"] = wrong.into();
			delimiter_faults(&document, src, offsets, None, "", &mut bad);
			assert_eq!(bad.len(), 1, "{features:?} {offsets:?}: {bad:?}");
			assert!(bad[0].contains("Hdoc.End"), "{bad:?}");
		}
	}
}

fn word_part_faults(v: &serde_json::Value, path: &str, bad: &mut Vec<String>) {
	match v {
		serde_json::Value::Object(map) => {
			if let Some(serde_json::Value::Array(parts)) = map.get("Parts") {
				for (i, part) in parts.iter().enumerate() {
					if part
						.get("Type")
						.and_then(serde_json::Value::as_str)
						.is_none()
					{
						bad.push(format!("{path}.Parts[{i}] has no Type"));
					}
				}
			}
			for (k, child) in map {
				word_part_faults(child, &format!("{path}.{k}"), bad);
			}
		},
		serde_json::Value::Array(items) => {
			for (i, child) in items.iter().enumerate() {
				word_part_faults(child, &format!("{path}[{i}]"), bad);
			}
		},
		_ => {},
	}
}

/// Name every [`CommandKind`] variant. The match is exhaustive, so a
/// command form added to the tree does not compile until it is named here,
/// and the coverage assertion below then fails until a sample produces it.
fn command_kind_name(k: &CommandKind) -> &'static str {
	match k {
		CommandKind::Simple(_) => "Simple",
		CommandKind::Brace(_) => "Brace",
		CommandKind::Subshell(_) => "Subshell",
		CommandKind::If(_) => "If",
		CommandKind::While(_) => "While",
		CommandKind::For(_) => "For",
		CommandKind::ArithFor(_) => "ArithFor",
		CommandKind::Select(_) => "Select",
		CommandKind::Case(_) => "Case",
		CommandKind::Arith(_) => "Arith",
		CommandKind::Cond(_) => "Cond",
		CommandKind::FuncDef(_) => "FuncDef",
		CommandKind::Coproc(_) => "Coproc",
		CommandKind::Repeat(_) => "Repeat",
		CommandKind::Try(_) => "Try",
		CommandKind::AnonFunc(_) => "AnonFunc",
	}
}

/// Name every [`WordPart`] variant, on the same contract.
fn word_part_name(p: &WordPart) -> &'static str {
	match p {
		WordPart::Lit(_) => "Lit",
		WordPart::Escaped(_) => "Escaped",
		WordPart::SQuote(_) => "SQuote",
		WordPart::DQuote(_) => "DQuote",
		WordPart::AnsiC(_) => "AnsiC",
		WordPart::Locale(_) => "Locale",
		WordPart::Param(_) => "Param",
		WordPart::Comsub(_) => "Comsub",
		WordPart::Arith(_) => "Arith",
		WordPart::ProcSub(_) => "ProcSub",
		WordPart::Compound(_) => "Compound",
		WordPart::BadSubst(_) => "BadSubst",
		WordPart::BadComsub(_) => "BadComsub",
		WordPart::DroppedQuote => "DroppedQuote",
		WordPart::Zsh(_) => "Zsh",
	}
}

/// Every name [`command_kind_name`] can return.
const ALL_COMMAND_KINDS: [&str; 16] = [
	"Simple", "Brace", "Subshell", "If", "While", "For", "ArithFor", "Select", "Case", "Arith",
	"Cond", "FuncDef", "Coproc", "Repeat", "Try", "AnonFunc",
];

/// Every name [`word_part_name`] can return.
const ALL_WORD_PARTS: [&str; 15] = [
	"Lit",
	"Escaped",
	"SQuote",
	"DQuote",
	"AnsiC",
	"Locale",
	"Param",
	"Comsub",
	"Arith",
	"ProcSub",
	"Compound",
	"BadSubst",
	"BadComsub",
	"DroppedQuote",
	"Zsh",
];

/// Which change owns the positions a sample exports.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Owner {
	/// This change: the sample must export no containment fault.
	Here,
	/// Positions outside this command-node change: word/expression interiors
	/// and structural pipeline operators. The alias sample must still fault,
	/// so its marker is removed by the change that repairs those positions.
	Sibling,
}

/// One sample: the text the alias `check` expands to, the source that
/// reaches it, the dialect, and who owns its exported positions.
struct Sample<'a> {
	src:   &'a [u8],
	text:  &'a [u8],
	zsh:   bool,
	owner: Owner,
}

const fn bash(text: &'static [u8]) -> Sample<'static> {
	Sample { src: b"check\n", text, zsh: false, owner: Owner::Here }
}

/// A bash sample whose only faults are inside a word.
const fn word(text: &'static [u8]) -> Sample<'static> {
	Sample { src: b"check\n", text, zsh: false, owner: Owner::Sibling }
}

const fn zsh(text: &'static [u8]) -> Sample<'static> {
	Sample { src: b"check\n", text, zsh: true, owner: Owner::Here }
}

/// An alias standing inside a compound of the source, so every exported
/// node has a real enclosing node with real bytes around it: a position the
/// export scans for can then land on a token of the enclosing command.
const fn nested(src: &'static [u8], text: &'static [u8]) -> Sample<'static> {
	Sample { src, text, zsh: false, owner: Owner::Here }
}

/// The same, in zsh grammar.
const fn nested_zsh(src: &'static [u8], text: &'static [u8]) -> Sample<'static> {
	Sample { src, text, zsh: true, owner: Owner::Here }
}

/// Every command form and every word form, in both dialects. The list is
/// held exhaustive by the assertion below rather than by a reviewer naming
/// the row that broke: every variant of [`CommandKind`] and [`WordPart`]
/// must be produced by a sample here.
const SAMPLES: &[Sample<'static>] = &[
	// Command forms, bash.
	bash(b"echo ok"),
	bash(b"{ echo ok; }"),
	bash(b"( echo ok )"),
	bash(b"{ { echo ok; }; }"),
	bash(b"( ( echo ok ) )"),
	bash(b"if true; then echo a; elif false; then echo b; else echo c; fi"),
	bash(b"while false; do echo ok; done"),
	bash(b"until true; do echo ok; done"),
	bash(b"case x in a) echo a ;; *) echo b ;; esac"),
	bash(b"case x in x) esac"),
	bash(b"case x in a) echo a ;; *) esac"),
	bash(b"case x in (a|b) echo a ;; esac"),
	// A `case` arm is one variant with two parser branches: zsh records an
	// arm's `)` on the branch `a)` takes and not on the branch `(a)` takes,
	// so one sample per variant reached only the first.
	bash(b"case x in (x) esac"),
	zsh(b"case x in (x) esac"),
	zsh(b"case x in x) esac"),
	bash(b"(( 1 + 1 ))"),
	bash(b"[[ -n a ]]"),
	bash(b"[[ ( ! a ) && b ]]"),
	bash(b"[[ ! ! a && -n b || ( c ) ]]"),
	bash(b"[[ a && ( b || c ) ]]"),
	bash(b"f() { echo ok; }"),
	bash(b"function f { echo ok; }"),
	bash(b"coproc c { echo ok; }"),
	bash(b"coproc f\\\noo { :; }"),
	bash(b": 12>/dev/null"),
	bash(b": 0012>/dev/null"),
	bash(b": {fd}>/dev/null"),
	nested(b"check 99>/dev/null\n", b": 12>/dev/null"),
	nested(b": '\xf0\x9f\x98\x80'; check 99>/dev/null\n", b": 12>/dev/null"),
	bash(b"while false; do echo ok; done >/dev/null"),
	bash(b"( echo ok ) >/dev/null"),
	nested(b"case x in x) check;; esac\n", b"case x in x) esac"),
	nested(b"case x in x) check;& esac\n", b"case x in a) echo a ;; *) esac"),
	nested(b"for i in a; do check; done\n", b"case x in x) esac"),
	nested(b"{ check; }\n", b"( echo ok )"),
	// Command forms zsh alone has, and zsh's extra names.
	zsh(b"repeat 2 do echo ok; done"),
	zsh(b"{ echo ok } always { echo done }"),
	zsh(b"() { echo ok }"),
	// Round 4's rows: the aliased construct stands inside a source compound
	// whose own `do` and `}` a forward scan reaches. The bodies are written
	// without `;` because a statement separator inside alias text is the
	// sibling change's row, not this one's.
	nested_zsh(b"for i in a; do check; done\n", b"repeat 0 { : }"),
	nested_zsh(b"for i in a; do check; done\n", b"{ : } always { : }"),
	zsh(b"function f g { echo ok }"),
	zsh(b"f g () { echo ok }"),
	zsh(b"if true; then echo a; else echo b; fi"),
	zsh(b"while false; do echo ok; done"),
	zsh(b": 12>/dev/null"),
	zsh(b": 0012>/dev/null"),
	zsh(b": {fd}>/dev/null"),
	nested_zsh(b"check 99>/dev/null\n", b": 12>/dev/null"),
	nested_zsh(b": '\xf0\x9f\x98\x80'; check 99>/dev/null\n", b": 12>/dev/null"),
	zsh(b"case x in a) echo a ;; esac"),
	zsh(b"(( 1 + 1 ))"),
	zsh(b"[[ -n a ]]"),
	zsh(b"f() { echo ok }"),
	zsh(b"( echo ok )"),
	zsh(b"echo ok"),
	// Word forms. A quoted or substituted word still derives the positions
	// inside itself, which is the sibling change's defect, so those rows
	// are marked and must keep faulting until it lands.
	bash(b"echo a\\bc"),
	bash(b"echo ${a b}"),
	word(b"echo 'a'"),
	word(b"echo \"a\""),
	word(b"echo $'a'"),
	word(b"echo $\"a\""),
	word(b"echo ${x:-d}"),
	word(b"echo $(x)"),
	word(b"echo $(( 1 + 1 ))"),
	word(b"echo $[1 + 1]"),
	word(b"echo `x`"),
	zsh(b"echo \"a\" $((1)) $[1] $(x) `x`"),
	word(b"cat <(x)"),
	word(b"declare -a a=(1 2)"),
	word(b"echo \"${a+'$('\\'}\""),
	word(b"echo \"${x-'\"'y}\""),
	Sample { src: b"check | :\n", text: b": | :", zsh: false, owner: Owner::Sibling },
];

/// Cross the loop grammar's header alternatives with its body alternatives.
/// The exhaustive node/operand walk below checks that these parsed samples
/// also produce every `CommandKind` and `WordPart` variant.
fn for_each_sample(mut visit: impl FnMut(&Sample<'_>)) {
	for sample in SAMPLES {
		visit(sample);
	}
	for zsh in [false, true] {
		let bodies: &[&str] = if zsh {
			&["; do :; done", "\ndo :; done", "; { : }", "; :\n"]
		} else {
			&["; do :; done", "\ndo :; done"]
		};
		for keyword in ["for", "select"] {
			let names: &[&str] = if zsh && keyword == "for" {
				&["i", "a b"]
			} else {
				&["i"]
			};
			for name in names {
				for words in ["", " in", " in a b", " i\\\nn"] {
					for body in bodies {
						let text = format!("{keyword} {name}{words}{body}");
						visit(&Sample {
							src: b"check\n",
							text: text.as_bytes(),
							zsh,
							owner: Owner::Here,
						});
					}
				}
			}
		}
		for expressions in ["; ;", "i = 0; i < 2; i++"] {
			let text = format!("for (( {expressions} )); do :; done");
			// Bash's arithmetic operands still derive their own native spans.
			let owner = if zsh { Owner::Here } else { Owner::Sibling };
			visit(&Sample { src: b"check\n", text: text.as_bytes(), zsh, owner });
		}
		if zsh {
			for name in ["i", "a b"] {
				for words in ["( )", "(a b)"] {
					let text = format!("for {name} {words}; do :; done");
					visit(&Sample { src: b"check\n", text: text.as_bytes(), zsh, owner: Owner::Here });
				}
				for words in ["()", "( )", "(a b)"] {
					let text = format!("foreach {name} {words}\n:; end");
					visit(&Sample { src: b"check\n", text: text.as_bytes(), zsh, owner: Owner::Here });
				}
			}
		}
	}
}

fn collect_cmd_names(cmd: &Command, kinds: &mut Vec<&'static str>, parts: &mut Vec<&'static str>) {
	kinds.push(command_kind_name(&cmd.kind));
	match &cmd.kind {
		CommandKind::Simple(s) => {
			for a in &s.assigns {
				match &a.value {
					AssignValue::Scalar(w) => collect_part_names(&w.parts, parts),
					AssignValue::Array(elems) => {
						for e in elems {
							collect_part_names(&e.value.parts, parts);
						}
					},
				}
			}
			for w in &s.words {
				collect_part_names(&w.parts, parts);
			}
		},
		CommandKind::If(i) => {
			for arm in &i.arms {
				collect_list_names(&arm.cond, kinds, parts);
				collect_list_names(&arm.body, kinds, parts);
			}
			if let Some(e) = &i.else_body {
				collect_list_names(e, kinds, parts);
			}
		},
		CommandKind::While(w) => {
			collect_list_names(&w.cond, kinds, parts);
			collect_list_names(&w.body, kinds, parts);
		},
		CommandKind::For(f) | CommandKind::Select(f) => {
			for w in f.words.iter().flatten() {
				collect_part_names(&w.parts, parts);
			}
			collect_list_names(&f.body, kinds, parts);
		},
		CommandKind::ArithFor(f) => collect_list_names(&f.body, kinds, parts),
		CommandKind::Case(c) => {
			collect_part_names(&c.word.parts, parts);
			for arm in &c.arms {
				for p in &arm.patterns {
					collect_part_names(&p.parts, parts);
				}
				collect_list_names(&arm.body, kinds, parts);
			}
		},
		CommandKind::Brace(l) | CommandKind::Subshell(l) => collect_list_names(l, kinds, parts),
		CommandKind::Arith(_) => {},
		CommandKind::Cond(e) => collect_cond_names(e, parts),
		CommandKind::FuncDef(f) => collect_cmd_names(&f.body, kinds, parts),
		CommandKind::Coproc(c) => collect_cmd_names(&c.body, kinds, parts),
		CommandKind::Repeat(r) => {
			collect_part_names(&r.count.parts, parts);
			collect_list_names(&r.body, kinds, parts);
		},
		CommandKind::Try(t) => {
			collect_list_names(&t.body, kinds, parts);
			collect_list_names(&t.always, kinds, parts);
		},
		CommandKind::AnonFunc(a) => {
			collect_cmd_names(&a.body, kinds, parts);
			for w in &a.args {
				collect_part_names(&w.parts, parts);
			}
		},
	}
	for r in &cmd.redirs {
		if let RedirTarget::Word(w) = &r.target {
			collect_part_names(&w.parts, parts);
		}
	}
}

fn collect_list_names(l: &List, kinds: &mut Vec<&'static str>, parts: &mut Vec<&'static str>) {
	for it in &l.items {
		for stage in it
			.and_or
			.rest
			.iter()
			.map(|(_, p)| p)
			.chain(core::iter::once(&it.and_or.first))
			.flat_map(|p| &p.stages)
		{
			collect_cmd_names(&stage.cmd, kinds, parts);
		}
	}
}

fn collect_cond_names(e: &CondExpr, parts: &mut Vec<&'static str>) {
	match e {
		CondExpr::Word(w) | CondExpr::Unary { arg: w, .. } => collect_part_names(&w.parts, parts),
		CondExpr::Binary { lhs, rhs, .. } => {
			collect_part_names(&lhs.parts, parts);
			collect_part_names(&rhs.parts, parts);
		},
		CondExpr::Not { expr, .. } | CondExpr::Group { expr, .. } => collect_cond_names(expr, parts),
		CondExpr::And(terms, _) | CondExpr::Or(terms, _) => {
			for term in terms {
				collect_cond_names(term, parts);
			}
		},
	}
}

fn collect_part_names(ps: &[WordPart], parts: &mut Vec<&'static str>) {
	for p in ps {
		parts.push(word_part_name(p));
		match p {
			WordPart::DQuote(inner) | WordPart::Locale(inner) => collect_part_names(inner, parts),
			WordPart::Param(pp) => match &pp.op {
				ParamOp::Default { word, .. }
				| ParamOp::Assign { word, .. }
				| ParamOp::Alt { word, .. } => collect_part_names(&word.parts, parts),
				ParamOp::Error { word: Some(w), .. } | ParamOp::Trim { pat: w, .. } => {
					collect_part_names(&w.parts, parts);
				},
				ParamOp::Replace { pat, rep, .. } => {
					collect_part_names(&pat.parts, parts);
					if let Some(r) = rep {
						collect_part_names(&r.parts, parts);
					}
				},
				ParamOp::Case { pat: Some(w), .. } => collect_part_names(&w.parts, parts),
				_ => {},
			},
			WordPart::Comsub(c) => {
				let (mut k, mut q) = (Vec::new(), Vec::new());
				collect_list_names(&c.body, &mut k, &mut q);
				parts.append(&mut q);
			},
			WordPart::ProcSub(ps) => {
				let (mut k, mut q) = (Vec::new(), Vec::new());
				collect_list_names(&ps.body, &mut k, &mut q);
				parts.append(&mut q);
			},
			WordPart::Compound(elems) => {
				for e in elems {
					collect_part_names(&e.value.parts, parts);
				}
			},
			_ => {},
		}
	}
}

/// zsh's defaults for the parse-affecting options of a non-interactive
/// shell.
fn zsh_features() -> Features {
	Features::ZSH
		| Features::ZSH_SHORT_LOOPS
		| Features::ZSH_MULTI_FUNC_DEF
		| Features::ZSH_INTERACTIVE_COMMENTS
}

/// Parse the sample as ordinary source or as the expansion of `check`.
fn parse_sample(sample: &Sample<'_>, aliased: bool) -> Program {
	let table = AliasOne(b"check", sample.text);
	let features = if sample.zsh {
		zsh_features()
	} else {
		Features::NONE
	};
	let src = if aliased { sample.src } else { sample.text };
	let aliases: &dyn AliasLookup = if aliased { &table } else { NO_ALIASES };
	let mut parser = Parser::new(src, features, aliases);
	let mut commands = Vec::new();
	while let Some(cmd) = parser.next_command() {
		commands.push(
			cmd.unwrap_or_else(|e| panic!("{} parses: {e}", String::from_utf8_lossy(sample.text))),
		);
	}
	Program { commands }
}

#[test]
fn every_node_kind_has_an_alias_sample() {
	// The fixture list used to grow only when a reviewer named the row that
	// broke, so a form nobody thought of (zsh's `repeat`, its `always`, a
	// bare `case` arm) stayed uncovered until the round after it broke.
	// Coverage is now a property of the list: every variant the tree can
	// hold must be produced by a sample, in whichever dialect parses it.
	let (mut kinds, mut parts) = (Vec::new(), Vec::new());
	let mut exported_samples = Vec::new();
	for_each_sample(|sample| {
		exported_samples.push(serde_json::json!({
			"src": String::from_utf8_lossy(sample.src),
			"text": String::from_utf8_lossy(sample.text),
			"zsh": sample.zsh,
			"sibling": sample.owner == Owner::Sibling,
		}));
		for unit in &parse_sample(sample, true).commands {
			collect_list_names(&unit.list, &mut kinds, &mut parts);
		}
	});
	if let Some(path) = std::env::var_os("EXPORT_SAMPLES_FILE") {
		std::fs::write(path, serde_json::to_vec(&exported_samples).unwrap()).unwrap();
	}
	let missing_kinds: Vec<&str> = ALL_COMMAND_KINDS
		.into_iter()
		.filter(|k| !kinds.contains(k))
		.collect();
	let missing_parts: Vec<&str> = ALL_WORD_PARTS
		.into_iter()
		.filter(|p| !parts.contains(p))
		.collect();
	assert!(
		missing_kinds.is_empty() && missing_parts.is_empty(),
		"no alias sample produces command kinds {missing_kinds:?} or word parts {missing_parts:?}"
	);
}

#[test]
fn exported_nodes_contain_their_children_in_source_and_alias_text() {
	// Alias expansion collapses positions and can hide an undersized range
	// in ordinary source. Check both buffers for every parser branch.
	let mut faults = Vec::new();
	let mut clean_siblings = Vec::new();
	for_each_sample(|sample| {
		let start = sample.src.windows(5).position(|s| s == b"check").unwrap();
		let mut expanded = sample.src[..start].to_vec();
		expanded.extend_from_slice(sample.text);
		expanded.extend_from_slice(&sample.src[start + 5..]);
		let features = if sample.zsh {
			zsh_features()
		} else {
			Features::NONE
		};
		let reference = parse_all(&expanded, features).expect("expanded sample parses");
		for aliased in [false, true] {
			let program = parse_sample(sample, aliased);
			let src = if aliased { sample.src } else { sample.text };
			let mut here = Vec::new();
			for offsets in [Offsets::Bytes, Offsets::Utf16] {
				for dialect in [JsonDialect::Native, JsonDialect::Shfmt] {
					let json = to_json(src, &program, dialect, offsets);
					let document: serde_json::Value = serde_json::from_str(&json).unwrap();
					let mut bad = Vec::new();
					range_faults(&document, None, "", &mut bad);
					if dialect == JsonDialect::Shfmt {
						let reference: serde_json::Value =
							serde_json::from_str(&to_json(&expanded, &reference, dialect, offsets))
								.unwrap();
						let alias =
							aliased.then_some((&reference, expanded.as_slice(), start, sample.text.len()));
						delimiter_faults(&document, src, offsets, alias, "", &mut bad);
					}
					for fault in bad {
						here.push(format!(
							"{} with {} (aliased={aliased}), {dialect:?}, {offsets:?}: {fault}",
							String::from_utf8_lossy(src).escape_debug(),
							String::from_utf8_lossy(sample.text)
						));
					}
				}
			}
			match (sample.owner, aliased) {
				(Owner::Sibling, true) if here.is_empty() => {
					clean_siblings.push(String::from_utf8_lossy(sample.text).into_owned());
				},
				(Owner::Sibling, true) => {},
				_ => faults.append(&mut here),
			}
		}
	});
	assert!(faults.is_empty(), "{} range faults:\n{}", faults.len(), faults.join("\n"));
	assert!(
		clean_siblings.is_empty(),
		"these samples no longer fault, so they are this change's now, not the word change's: {}",
		clean_siblings.join(", ")
	);
}

#[test]
fn compound_ranges_do_not_borrow_their_redirections() {
	let mut faults = Vec::new();
	let mut sibling_faults = Vec::new();
	let mut documents = 0;
	let mut rejected = 0;
	let mut rows = Vec::new();
	for_each_sample(|sample| {
		if sample.owner != Owner::Here {
			return;
		}
		let program = parse_sample(sample, false);
		let cmd = &program.commands[0].list.items[0].and_or.first.stages[0].cmd;
		if matches!(cmd.kind, CommandKind::Simple(_)) {
			return;
		}
		let text = String::from_utf8_lossy(sample.text);
		for zsh in [false, true] {
			let features = if zsh { zsh_features() } else { Features::NONE };
			let mut base = Parser::new(sample.text, features, NO_ALIASES);
			let base_valid = std::iter::from_fn(|| base.next_command()).all(|cmd| cmd.is_ok());
			for leading in [false, true] {
				let redirected = if leading {
					format!(">/dev/null {text}")
				} else {
					format!("{text} >/dev/null")
				};
				// Source alone, alias alone, and a source redirection beside an
				// aliased compound. The last must not collapse the redirection's
				// position together with the compound's positions.
				for (src, alias) in [
					(format!("# 😀\n{redirected}\n"), ""),
					("# 😀\ncheck\n".to_owned(), redirected.as_str()),
					(
						if leading {
							"# 😀\n>/dev/null check\n".to_owned()
						} else {
							"# 😀\ncheck >/dev/null\n".to_owned()
						},
						text.as_ref(),
					),
				] {
					let table = AliasOne(b"check", alias.as_bytes());
					let mut parser = Parser::new(src.as_bytes(), features, &table);
					let commands: Result<Vec<_>, _> =
						std::iter::from_fn(|| parser.next_command()).collect();
					let Ok(commands) = commands else {
						// Bash does not accept a redirection before a compound.
						// In zsh, coproc is a pipeline prefix, not a par_cmd form.
						assert!(
							!base_valid
								|| (leading && (!zsh || matches!(cmd.kind, CommandKind::Coproc(_)))),
							"unexpected rejection: {src:?}, alias={alias:?}"
						);
						rejected += 1;
						continue;
					};
					let program = Program { commands };
					for offsets in [Offsets::Bytes, Offsets::Utf16] {
						for dialect in [JsonDialect::Native, JsonDialect::Shfmt] {
							let owner = if sample.text.starts_with(b"for ((")
								&& !zsh
								&& !alias.is_empty()
								&& dialect == JsonDialect::Native
							{
								Owner::Sibling
							} else {
								Owner::Here
							};
							rows.push(serde_json::json!({
								"src": src, "alias": alias, "zsh": zsh,
								"utf16": offsets == Offsets::Utf16, "native": dialect == JsonDialect::Native,
								"sibling_operands": owner == Owner::Sibling,
							}));
							documents += 1;
							let json = to_json(src.as_bytes(), &program, dialect, offsets);
							let document: serde_json::Value = serde_json::from_str(&json).unwrap();
							let mut bad = Vec::new();
							range_faults(&document, None, "", &mut bad);
							if owner == Owner::Sibling {
								assert_eq!(
									bad.len(),
									3,
									"stale arithmetic operand marker: {json}\n{bad:?}"
								);
								for operand in ["init", "cond", "step"] {
									let cause = format!(
										".commands[0].list[0].and_or.first.stages[0].cmd.{operand}: \
										 backwards ["
									);
									assert!(
										bad.iter().any(|fault| fault.starts_with(&cause)),
										"wrong arithmetic operand fault: {bad:?}"
									);
								}
								sibling_faults.extend(bad);
								continue;
							}
							for fault in bad {
								faults.push(format!(
									"{src:?}, alias={alias:?}, zsh={}, {dialect:?}, {offsets:?}: {fault}",
									zsh
								));
							}
						}
					}
				}
			}
		}
	});
	assert_eq!(sibling_faults.len(), 24, "arithmetic operand marker coverage changed");
	if let Some(path) = std::env::var_os("EXPORT_REDIRECTION_FAULTS") {
		std::fs::write(
			path,
			serde_json::to_vec(&serde_json::json!({
				"documents": documents, "rejected": rejected, "faults": faults, "rows": rows,
				"sibling_faults": sibling_faults,
			}))
			.unwrap(),
		)
		.unwrap();
	}
	assert!(
		faults.is_empty(),
		"{} range faults in {documents} documents ({rejected} rejected):\n{}",
		faults.len(),
		faults.join("\n")
	);
}

#[test]
fn compound_openers_do_not_point_at_leading_redirections() {
	for (text, end, opening, closing, close) in [
		("{ : }", 16, "Lbrace", "Rbrace", 15),
		("( : )", 16, "Lparen", "Rparen", 15),
		("for i in a; do :; done", 33, "ForPos", "DonePos", 29),
		("[[ -n a ]]", 21, "Left", "Right", 19),
		("(( 1 ))", 18, "Left", "Right", 16),
	] {
		for zsh in [false, true] {
			for (src, alias, byte_range, utf16_range) in [
				(format!(">/dev/null {text}"), "", (11, end, close), (11, end, close)),
				("# 😀\ncheck\n".to_owned(), text, (12, 12, 12), (10, 10, 10)),
				("# 😀\n>/dev/null check\n".to_owned(), text, (23, 23, 23), (21, 21, 21)),
			] {
				if !zsh && (alias.is_empty() || src.contains(">/dev/null") || text == "{ : }") {
					continue; // Bash rejects leading redirections and an unseparated `}`.
				}
				let table = AliasOne(b"check", alias.as_bytes());
				let features = if zsh { zsh_features() } else { Features::NONE };
				let mut parser = Parser::new(src.as_bytes(), features, &table);
				let commands = std::iter::from_fn(|| parser.next_command())
					.collect::<Result<Vec<_>, _>>()
					.expect("compound parses");
				let program = Program { commands };
				for (offsets, (lo, hi, close)) in
					[(Offsets::Bytes, byte_range), (Offsets::Utf16, utf16_range)]
				{
					let json = to_json(src.as_bytes(), &program, JsonDialect::Shfmt, offsets);
					let document: serde_json::Value = serde_json::from_str(&json).unwrap();
					let cmd = &document["Stmts"][0]["Cmd"];
					assert_eq!(token_range(cmd), Some((lo, hi)), "{json}");
					assert_eq!(cmd[opening]["Offset"], lo, "{json}");
					assert_eq!(cmd[closing]["Offset"], close, "{json}");
				}
			}
		}
	}
}

#[test]
fn every_exported_word_part_has_a_type_discriminator() {
	let mut faults = Vec::new();
	for_each_sample(|sample| {
		for aliased in [false, true] {
			let program = parse_sample(sample, aliased);
			let src = if aliased { sample.src } else { sample.text };
			for offsets in [Offsets::Bytes, Offsets::Utf16] {
				let json = to_json(src, &program, JsonDialect::Shfmt, offsets);
				let shfmt: serde_json::Value = serde_json::from_str(&json).unwrap();
				let mut bad = Vec::new();
				word_part_faults(&shfmt, "", &mut bad);
				for fault in bad {
					faults.push(format!(
						"{} (aliased={aliased}), {offsets:?}: {fault}",
						String::from_utf8_lossy(sample.text)
					));
				}
			}
		}
	});
	assert!(faults.is_empty(), "{} schema faults:\n{}", faults.len(), faults.join("\n"));
}

#[test]
fn redirection_descriptors_keep_the_parsed_text_and_their_own_operator() {
	for (zsh, text, value) in [
		(false, b": 12>/dev/null".as_slice(), "12"),
		(false, b": 0012>/dev/null".as_slice(), "0012"),
		(false, b": 0\\\n12>/dev/null".as_slice(), "012"),
		(false, b": {fd}>/dev/null".as_slice(), "{fd}"),
		(true, b": 2>/dev/null".as_slice(), "2"),
		(true, b": {fd}>/dev/null".as_slice(), "{fd}"),
	] {
		for src in [b"check\n".as_slice(), b"check 99>/dev/null\n".as_slice()] {
			let sample = Sample { src, text, zsh, owner: Owner::Here };
			let program = parse_sample(&sample, true);
			for offsets in [Offsets::Bytes, Offsets::Utf16] {
				let json = to_json(src, &program, JsonDialect::Shfmt, offsets);
				let shfmt: serde_json::Value = serde_json::from_str(&json).unwrap();
				let redir = &shfmt["Stmts"][0]["Redirs"][0];
				assert_eq!(redir["N"]["Value"], value, "{zsh:?}, {offsets:?}: {json}");
				assert_eq!(redir["OpPos"]["Offset"], 5, "{json}");
				assert_eq!(token_range(&redir["N"]), Some((5, 5)), "{json}");
			}
		}
	}
}

#[test]
fn an_exported_name_carries_the_text_the_parser_read() {
	// The containment walk checks a node's RANGE, never the text it
	// exports, so a node can carry a correct span around the wrong bytes:
	// the coprocess name was built by slicing the source between the
	// recorded offsets, which is the parser's buffer only when the name
	// holds no quoting and came from the source. A consumer that reads
	// `Value` to learn the coprocess's name — the variable it must read
	// the file descriptors from — gets the wrong name.
	let value = |src: &[u8], program: &Program| -> String {
		let json = to_json(src, program, JsonDialect::Shfmt, Offsets::Bytes);
		let shfmt: serde_json::Value = serde_json::from_str(&json).unwrap();
		shfmt["Stmts"][0]["Cmd"]["Name"]["Parts"][0]["Value"]
			.as_str()
			.unwrap_or("<missing>")
			.to_owned()
	};

	// A line continuation inside the name: bash joins it, so the
	// coprocess is `foo` and the two source bytes are not part of it.
	let src = b"coproc f\\\noo { :; }\n".as_slice();
	let program = parse_all(src, Features::NONE).expect("the coprocess parses");
	assert_eq!(
		value(src, &program),
		"foo",
		"the name is the text the parser read, not the source slice"
	);

	// The same name through an alias, where the source holds none of it.
	let sample = bash(b"coproc named { :; }");
	assert_eq!(value(sample.src, &parse_sample(&sample, true)), "named");
}

#[test]
fn unrecorded_conditional_keywords_are_not_replaced_with_operand_positions() {
	let src = b"if :; then :; elif :; then :; else :; fi";
	for features in [Features::NONE, Features::ZSH] {
		let mut program = parse_all(src, features).unwrap();
		let CommandKind::If(clause) = &mut program.commands[0].list.items[0].and_or.first.stages[0]
			.cmd
			.kind
		else {
			panic!("an if clause");
		};
		clause.arms[1].kw_pos = None;
		clause.else_pos = None;
		for offsets in [Offsets::Bytes, Offsets::Utf16] {
			let json = to_json(src, &program, JsonDialect::Shfmt, offsets);
			let document: serde_json::Value = serde_json::from_str(&json).unwrap();
			let elif = &document["Stmts"][0]["Cmd"]["Else"];
			let otherwise = &elif["Else"];
			for clause in [elif, otherwise] {
				assert!(clause.get("Position").is_none(), "{json}");
				assert!(clause.get("Pos").is_none(), "{json}");
			}
			assert_eq!(elif["Cond"][0]["Cmd"]["Args"][0]["Parts"][0]["Value"], ":");
			assert_eq!(otherwise["Then"][0]["Cmd"]["Args"][0]["Parts"][0]["Value"], ":");
		}
	}
}
