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

struct AliasOne(&'static [u8], &'static [u8]);

impl AliasLookup for AliasOne {
	fn alias(&self, name: &[u8]) -> Option<&[u8]> {
		(name == self.0).then_some(self.1)
	}
}

fn token_range(v: &serde_json::Value) -> Option<(u64, u64)> {
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
				if let Some(o) = bare_offset(child)
					&& let Some(((pos, end), _)) = &here
					&& (o < *pos || o > *end)
				{
					bad.push(format!("{path}.{k} at {o} outside [{pos},{end}]"));
				}
				range_faults(child, here.clone(), &format!("{path}.{k}"), bad);
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

#[test]
fn alias_expanded_compounds_export_ranges_that_contain_their_children() {
	// Every compound command form, including the conditional forms the alias
	// defect was first seen in. A compound's keyword and operator positions
	// are the parser's to record: the text an alias expands to has no bytes
	// in the source, so neither arithmetic on the command's end nor a scan
	// of the source finds them.
	//
	// Word forms are left out, and so is a here-document body: the export
	// locates the positions inside a word by scanning the source, which is
	// the wrong buffer for alias text and for a here-document's inner
	// command substitution at main as well. That is a separate defect with
	// its own change.
	let mut faults = Vec::new();
	for text in [
		&b"[[ ( ! a ) && b ]]"[..] as &'static [u8],
		&b"[[ ! ! a && -n b || ( c ) ]]"[..],
		&b"[[ a && ( b || c ) ]]"[..],
		&b"[[ -n a ]]"[..],
		&b"( echo ok )"[..],
		&b"{ echo ok; }"[..],
		&b"( ( echo ok ) )"[..],
		&b"{ { echo ok; }; }"[..],
		&b"while false; do echo ok; done"[..],
		&b"until true; do echo ok; done"[..],
		&b"for i in a b; do echo ok; done"[..],
		&b"select i in a b; do echo ok; done"[..],
		&b"for (( i = 0; i < 2; i++ )); do echo ok; done"[..],
		&b"case x in a) echo a ;; *) echo b ;; esac"[..],
		&b"case x in x) esac"[..],
		&b"case x in a) echo a ;; *) esac"[..],
		&b"case x in (a|b) echo a ;; esac"[..],
		&b"(( 1 + 1 ))"[..],
		&b"if true; then echo a; elif false; then echo b; else echo c; fi"[..],
		&b"while false; do echo ok; done >/dev/null"[..],
		&b"( echo ok ) >/dev/null"[..],
	] {
		let src = b"check\n";
		let table = AliasOne(b"check", text);
		let mut parser = Parser::new(src, Features::NONE, &table);
		let mut commands = Vec::new();
		while let Some(cmd) = parser.next_command() {
			commands.push(cmd.expect("the aliased text parses"));
		}
		let program = Program { commands };
		for offsets in [Offsets::Bytes, Offsets::Utf16] {
			let json = to_json(src, &program, JsonDialect::Shfmt, offsets);
			let shfmt: serde_json::Value = serde_json::from_str(&json).unwrap();
			let mut bad = Vec::new();
			range_faults(&shfmt, None, "", &mut bad);
			for fault in bad {
				faults.push(format!("{} in {offsets:?}: {fault}", String::from_utf8_lossy(text)));
			}
		}
	}
	// The same texts reached through an alias that stands inside a compound
	// of the source, so each exported node has a real enclosing node with
	// real bytes around it: a position the export scans for can land on a
	// token of the enclosing command rather than of its own.
	for (src, text) in [
		(&b"case x in x) check;; esac\n"[..], &b"case x in x) esac"[..]),
		(&b"case x in x) check;& esac\n"[..], &b"case x in a) echo a ;; *) esac"[..]),
		(&b"for i in a; do check; done\n"[..], &b"case x in x) esac"[..]),
		(&b"{ check; }\n"[..], &b"( echo ok )"[..]),
		// `if true; then check; fi` with a loop aliased into it belongs to
		// the sibling change: the statements inside the loop take their span
		// from a word token, which invents a byte in alias text at upstream
		// main as well (6 faults there, 4 here).
	] {
		let table = AliasOne(b"check", text);
		let mut parser = Parser::new(src, Features::NONE, &table);
		let mut commands = Vec::new();
		while let Some(cmd) = parser.next_command() {
			commands.push(cmd.expect("the source parses"));
		}
		let program = Program { commands };
		for offsets in [Offsets::Bytes, Offsets::Utf16] {
			let json = to_json(src, &program, JsonDialect::Shfmt, offsets);
			let shfmt: serde_json::Value = serde_json::from_str(&json).unwrap();
			let mut bad = Vec::new();
			range_faults(&shfmt, None, "", &mut bad);
			for fault in bad {
				faults.push(format!(
					"{} with {} aliased, in {offsets:?}: {fault}",
					String::from_utf8_lossy(src).escape_debug(),
					String::from_utf8_lossy(text)
				));
			}
		}
	}
	assert!(faults.is_empty(), "{} range faults:\n{}", faults.len(), faults.join("\n"));
}

#[test]
fn word_part_positions_are_read_from_the_buffer_the_part_came_from() {
	// The export locates the positions inside a word by scanning the source
	// with `part_spans`. Two buffers are not the source: the text an alias
	// expanded to, which has no bytes there at all, and a here-document
	// body, whose inner command substitution is parsed out of the body and
	// reports offsets relative to it.
	//
	// A row reached through an alias is parsed from `check`; a row of
	// source text, here-documents included, is parsed as itself.
	let mut faults = Vec::new();
	let through_alias: &[&[u8]] = &[
		b"echo \"a $(echo b) ${v} $((1 + 2))\"",
		b"echo $'a' $\"b\" `echo c`",
		b"cat <(echo a) >(cat)",
		b"a=( 1 2 ); echo ${a[1]} ${a[@]^^}",
		b"b[1]=x",
		b"f() { echo ok; }",
		b"coproc cp { echo ok; }",
	];
	// `if true; then check; fi` with `while false; do echo ok; done` aliased
	// in is NOT in this list, and faults 4 times at this head (6 at upstream
	// main). The statements of the aliased loop end one byte past the loop
	// itself, because `stmt_end` adds a byte after a separator that has
	// none. Correcting it needs the parser to record the separator's own
	// span on `ListItem`; this change records what is inside a word, and
	// that offset is not.
	let nested: &[(&[u8], &[u8])] = &[];
	let as_source: &[&[u8]] = &[
		b"cat <<EOF\n$( [[ ( a ) ]] )\nEOF\n",
		b"cat <<EOF\nx ${v} $(echo b) y\nEOF\n",
		b"cat <<-'EOF'\n\tplain\nEOF\n",
	];
	for (src, text) in through_alias
		.iter()
		.map(|t| (&b"check\n"[..], *t))
		.chain(nested.iter().map(|(s, t)| (*s, *t)))
		.chain(as_source.iter().map(|t| (*t, &b""[..])))
	{
		let table = AliasOne(b"check", text);
		let mut parser = Parser::new(src, Features::NONE, &table);
		let mut commands = Vec::new();
		while let Some(cmd) = parser.next_command() {
			commands.push(cmd.expect("the text parses"));
		}
		let program = Program { commands };
		for offsets in [Offsets::Bytes, Offsets::Utf16] {
			let json = to_json(src, &program, JsonDialect::Shfmt, offsets);
			let shfmt: serde_json::Value = serde_json::from_str(&json).unwrap();
			let mut bad = Vec::new();
			range_faults(&shfmt, None, "", &mut bad);
			for fault in bad {
				faults.push(format!(
					"{} with {} aliased, in {offsets:?}: {fault}",
					String::from_utf8_lossy(src).escape_debug(),
					String::from_utf8_lossy(text).escape_debug()
				));
			}
		}
	}
	assert!(faults.is_empty(), "{} range faults:\n{}", faults.len(), faults.join("\n"));
}
