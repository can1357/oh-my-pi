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
	if let Some(span) = v.get("span").and_then(serde_json::Value::as_array) {
		return Some((span.first()?.as_u64()?, span.get(1)?.as_u64()?));
	}
	Some((v.get("Pos")?.get("Offset")?.as_u64()?, v.get("End")?.get("Offset")?.as_u64()?))
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

/// Recognize only the disclosed separator-byte fault, not an arbitrary child
/// escaping a flat parent (nested backquotes used to do exactly that).
fn separator_faults(
	v: &serde_json::Value,
	parent: Option<((u64, u64), String)>,
	path: &str,
	bad: &mut Vec<String>,
) {
	let mut here = parent.clone();
	match v {
		serde_json::Value::Object(map) => {
			if let Some((pos, end)) = token_range(v) {
				if let Some(((ppos, pend), ppath)) = parent
					&& pos == ppos
					&& pos == pend
					&& end == pos + 1
					&& v.get("Semicolon").and_then(bare_offset) == Some(pos)
				{
					bad.push(format!("{path} [{pos},{end}] outside {ppath} [{ppos},{pend}]"));
				}
				here = Some(((pos, end), path.to_owned()));
			}
			for (key, child) in map {
				separator_faults(child, here.clone(), &format!("{path}.{key}"), bad);
			}
		},
		serde_json::Value::Array(items) => {
			for (i, child) in items.iter().enumerate() {
				separator_faults(child, here.clone(), &format!("{path}[{i}]"), bad);
			}
		},
		_ => {},
	}
}

fn flat_separator(list: &List) -> bool {
	list.items.iter().any(|item| {
		matches!(item.sep, Sep::Semi | Sep::Amp | Sep::Disown)
			&& item.and_or.span.lo == item.and_or.span.hi
	})
}

const ITERATOR_IN: &str = "#18193 empty iterator InPos";
const ITERATOR_NAMES: &str = "#18193 extra iterator names";
const CASE_CLOSE: &str = "#18193 empty case arm closer";

fn command_boundary_faults(v: &serde_json::Value, path: &str, cause: &str, bad: &mut Vec<String>) {
	match v {
		serde_json::Value::Object(map) => {
			if map.get("Type").and_then(serde_json::Value::as_str) == Some("WordIter") {
				if let Some((pos, end)) = token_range(v) {
					if cause == ITERATOR_IN {
						if let Some(at) = map.get("InPos").and_then(bare_offset)
							&& (at < pos || at > end)
						{
							bad.push(format!("{path}.InPos at {at} outside [{pos},{end}]"));
						}
					}
					if cause == ITERATOR_NAMES {
						if let Some(names) = map.get("ExtraNames").and_then(serde_json::Value::as_array) {
							for (i, name) in names.iter().enumerate() {
								if let Some((lo, hi)) = token_range(name)
									&& (lo < pos || hi > end)
								{
									bad.push(format!(
										"{path}.ExtraNames[{i}] [{lo},{hi}] outside {path} [{pos},{end}]"
									));
								}
							}
						}
					}
				}
			}
			if cause == CASE_CLOSE
				&& map.get("Type").and_then(serde_json::Value::as_str) == Some("CaseClause")
			{
				if let Some((pos, end)) = token_range(v)
					&& let Some(items) = map.get("Items").and_then(serde_json::Value::as_array)
				{
					for (i, item) in items.iter().enumerate() {
						if item.get("Stmts").is_none()
							&& item.get("OpPos").is_none()
							&& let Some((lo, hi)) = token_range(item)
							&& (lo < pos || hi > end)
						{
							bad.push(format!(
								"{path}.Items[{i}] [{lo},{hi}] outside {path} [{pos},{end}]"
							));
						}
					}
				}
			}
			for (key, child) in map {
				command_boundary_faults(child, &format!("{path}.{key}"), cause, bad);
			}
		},
		serde_json::Value::Array(items) => {
			for (i, child) in items.iter().enumerate() {
				command_boundary_faults(child, &format!("{path}[{i}]"), cause, bad);
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
		WordPart::DroppedQuote { .. } => "DroppedQuote",
		WordPart::Zsh(_) => "Zsh",
	}
}

fn param_op_name(op: &ParamOp) -> &'static str {
	match op {
		ParamOp::None => "None",
		ParamOp::Length => "Length",
		ParamOp::Indirect => "Indirect",
		ParamOp::PrefixNames { .. } => "PrefixNames",
		ParamOp::Default { .. } => "Default",
		ParamOp::Assign { .. } => "Assign",
		ParamOp::Error { .. } => "Error",
		ParamOp::Alt { .. } => "Alt",
		ParamOp::Substr { .. } => "Substr",
		ParamOp::Trim { .. } => "Trim",
		ParamOp::Replace { .. } => "Replace",
		ParamOp::Case { .. } => "Case",
		ParamOp::Transform { .. } => "Transform",
	}
}

/// One sample: the text the alias `check` expands to, the source that
/// reaches it, and the dialect that parses it. Every sample must export a
/// tree with no containment fault: #18193 owns a command node's own
/// positions, this change owns the positions inside a word, and between
/// them that is every row.
struct Sample {
	src:  &'static [u8],
	text: &'static [u8],
	zsh:  bool,
}

const fn bash(text: &'static [u8]) -> Sample {
	Sample { src: b"check\n", text, zsh: false }
}

const fn zsh(text: &'static [u8]) -> Sample {
	Sample { src: b"check\n", text, zsh: true }
}

/// An alias standing inside a compound of the source, so every exported
/// node has a real enclosing node with real bytes around it: a position the
/// export scans for can then land on a token of the enclosing command.
const fn nested(src: &'static [u8], text: &'static [u8]) -> Sample {
	Sample { src, text, zsh: false }
}

/// The same, in zsh grammar.
const fn nested_zsh(src: &'static [u8], text: &'static [u8]) -> Sample {
	Sample { src, text, zsh: true }
}

/// Every command form and every word form, in both dialects. The list is
/// held exhaustive by the assertion below rather than by a reviewer naming
/// the row that broke: every variant of [`CommandKind`] and [`WordPart`]
/// must be produced by a sample here.
const SAMPLES: &[Sample] = &[
	// Command forms, bash.
	bash(b"echo ok"),
	bash(b"{ echo ok; }"),
	bash(b"( echo ok )"),
	bash(b"{ { echo ok; }; }"),
	bash(b"( ( echo ok ) )"),
	bash(b"if true; then echo a; elif false; then echo b; else echo c; fi"),
	bash(b"while false; do echo ok; done"),
	bash(b"until true; do echo ok; done"),
	bash(b"for i in a b; do echo ok; done"),
	bash(b"for (( i = 0; i < 2; i++ )); do echo ok; done"),
	bash(b"select i in a b; do echo ok; done"),
	bash(b"case x in a) echo a ;; *) echo b ;; esac"),
	bash(b"case x in x) esac"),
	bash(b"case x in a) echo a ;; *) esac"),
	bash(b"case x in (a|b) echo a ;; esac"),
	bash(b"(( 1 + 1 ))"),
	bash(b"[[ -n a ]]"),
	bash(b"[[ ( ! a ) && b ]]"),
	bash(b"[[ ! ! a && -n b || ( c ) ]]"),
	bash(b"[[ a && ( b || c ) ]]"),
	bash(b"f() { echo ok; }"),
	bash(b"function f { echo ok; }"),
	bash(b"coproc c { echo ok; }"),
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
	zsh(b"for a b in 1 2; do echo ok; done"),
	zsh(b"if true; then echo a; else echo b; fi"),
	zsh(b"while false; do echo ok; done"),
	zsh(b"for i in a b; do echo ok; done"),
	zsh(b"for (( i = 0; i < 2; i++ )); do echo ok; done"),
	zsh(b"select i in a b; do echo ok; done"),
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
	// Round 1 of this change's review found two operand positions that no
	// sample reached: a transform's operator letter and an anchored
	// replacement's `#`/`%`. The unanchored form is the control.
	bash(b"echo ${x@Q}"),
	bash(b"echo ${x@P}"),
	bash(b"echo ${x/#a/b}"),
	bash(b"echo ${x/%a/b}"),
	bash(b"echo ${x//a/b}"),
	bash(b"echo ${x/#${y}/b}"),
	bash(b"echo ${x/%${y}/b}"),
	bash(b"echo ${x:-$[1]}"),
	bash(b"echo ${x:-$((1+2))}"),
	bash(b"echo `echo \\`echo ${x@Q}\\``"),
	bash(b"echo `echo \\`echo ${x/#a/b}\\``"),
	nested(b"for i in a; do check; done\n", b"echo `echo \\`echo ${x@Q}\\``"),
	nested(b"for i in a; do check; done\n", b"echo `echo \\`echo ${x/#a/b}\\``"),
	bash(b"echo 'a'"),
	bash(b"echo \"a\""),
	bash(b"echo $'a'"),
	bash(b"echo $\"a\""),
	bash(b"echo ${x:-d}"),
	bash(b"echo $(x)"),
	bash(b"echo $(( 1 + 1 ))"),
	bash(b"cat <(x)"),
	bash(b"declare -a a=(1 2)"),
	bash(b"echo \"${a+'$('\\'}\""),
	bash(b"echo \"${x-'\"'y}\""),
];

fn collect_cmd_names(cmd: &Command, kinds: &mut Vec<&'static str>, parts: &mut Vec<&'static str>) {
	kinds.push(command_kind_name(&cmd.kind));
	match &cmd.kind {
		CommandKind::Simple(s) => {
			for a in &s.assigns {
				match &a.value {
					AssignValue::Scalar(w) => collect_part_names(&w.parts, parts),
					AssignValue::Array(elems) => {
						for e in elems.iter() {
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
			WordPart::Param(pp) => {
				parts.push(param_op_name(&pp.op));
				if let Some(Subscript::Expr(w)) = &pp.index {
					collect_part_names(&w.parts, parts);
				}
				match &pp.op {
					ParamOp::Default { word, .. }
					| ParamOp::Assign { word, .. }
					| ParamOp::Alt { word, .. } => collect_part_names(&word.parts, parts),
					ParamOp::Error { word, .. } | ParamOp::Case { pat: word, .. } => {
						if let Some(w) = word {
							collect_part_names(&w.parts, parts);
						}
					},
					ParamOp::Trim { pat, .. } => collect_part_names(&pat.parts, parts),
					ParamOp::Replace { pat, rep, .. } => {
						collect_part_names(&pat.parts, parts);
						if let Some(r) = rep {
							collect_part_names(&r.parts, parts);
						}
					},
					ParamOp::None
					| ParamOp::Length
					| ParamOp::Indirect
					| ParamOp::PrefixNames { .. }
					| ParamOp::Substr { .. }
					| ParamOp::Transform { .. } => {},
				}
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
				for e in elems.iter() {
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

/// Parse `sample`'s source with `check` aliased to its text.
fn parse_sample(sample: &Sample) -> Program {
	let table = AliasOne(b"check", sample.text);
	let features = if sample.zsh {
		zsh_features()
	} else {
		Features::NONE
	};
	let mut parser = Parser::new(sample.src, features, &table);
	let mut commands = Vec::new();
	while let Some(cmd) = parser.next_command() {
		commands.push(
			cmd.unwrap_or_else(|e| panic!("{} parses: {e}", String::from_utf8_lossy(sample.text))),
		);
	}
	Program { commands }
}

// The generated gate below covers ordinary text as well as these historical
// alias regressions. Keep the fourteen independently recorded shfmt fixtures.

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
		b"a=( [1]=x )",
		b"prefix=long; a=( [1]=x [2]=y )",
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
			for dialect in [JsonDialect::Shfmt, JsonDialect::Native] {
				let json = to_json(src, &program, dialect, offsets);
				let tree: serde_json::Value = serde_json::from_str(&json).unwrap();
				let mut bad = Vec::new();
				range_faults(&tree, None, "", &mut bad);
				for fault in bad {
					faults.push(format!(
						"{} with {} aliased, in {dialect:?}/{offsets:?}: {fault}",
						String::from_utf8_lossy(src).escape_debug(),
						String::from_utf8_lossy(text).escape_debug()
					));
				}
			}
		}
	}
	assert!(faults.is_empty(), "{} range faults:\n{}", faults.len(), faults.join("\n"));
}

#[test]
fn exported_literals_keep_the_parsed_bytes_in_alias_text() {
	let mut faults = Vec::new();
	for (text, want) in [
		(&b"echo ${x/#${y}/b}"[..], &["echo", "x", "#", "y", "b"][..]),
		(&b"echo ${x/%${y}/b}"[..], &["echo", "x", "%", "y", "b"][..]),
		(&b"echo ${x/#a/b}"[..], &["echo", "x", "#a", "b"][..]),
		(&b"echo ${x/%a/b}"[..], &["echo", "x", "%a", "b"][..]),
		(
			&b"echo a\\bc '$' \"literal\" ${x:-fallback}"[..],
			&["echo", "a\\bc", "literal", "x", "fallback"][..],
		),
		(&b"echo ${a b} $ "[..], &["echo", "${a b}", "$"][..]),
		("echo é 😀; echo ${x/#a/b}".as_bytes(), &["echo", "é", "😀", "echo", "x", "#a", "b"][..]),
	] {
		for src in [&b"check\n"[..], text] {
			let program = parse_sample(&Sample { src, text, zsh: false });
			for offsets in [Offsets::Bytes, Offsets::Utf16] {
				let actual: serde_json::Value =
					serde_json::from_str(&to_json(src, &program, JsonDialect::Shfmt, offsets)).unwrap();
				let mut got = Vec::new();
				ordered_lit_values(&actual, &mut got);
				if got != want {
					faults.push(format!(
						"{} / {} {offsets:?}: {got:?}, expected {want:?}",
						String::from_utf8_lossy(src),
						String::from_utf8_lossy(text)
					));
				}
			}
		}
	}
	assert!(faults.is_empty(), "{} literal faults:\n{}", faults.len(), faults.join("\n"));
}

/// Ask the AST's derived Deserialize implementation for its complete variant
/// table. This is metadata from the actual enum, not a second list to maintain.
fn variants<T: serde::de::DeserializeOwned>() -> &'static [&'static str] {
	struct Names(Option<&'static [&'static str]>);
	impl<'de> serde::Deserializer<'de> for &mut Names {
		type Error = serde::de::value::Error;

		serde::forward_to_deserialize_any! {
			bool i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 char str string
			bytes byte_buf option unit unit_struct newtype_struct seq tuple
			tuple_struct map struct identifier ignored_any
		}

		fn deserialize_any<V: serde::de::Visitor<'de>>(self, _: V) -> Result<V::Value, Self::Error> {
			Err(serde::de::Error::custom("only enum metadata is requested"))
		}

		fn deserialize_enum<V: serde::de::Visitor<'de>>(
			self,
			_: &'static str,
			names: &'static [&'static str],
			_: V,
		) -> Result<V::Value, Self::Error> {
			self.0 = Some(names);
			Err(serde::de::Error::custom("variant table recorded"))
		}
	}
	let mut names = Names(None);
	let _ = T::deserialize(&mut names);
	names.0.expect("the parser type is an enum")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Owner {
	Words,
	/// Command positions belong to #18193; separator ends are explicitly
	/// deferred. These faults must remain visible, not silently skipped.
	Sibling(&'static str),
}

struct Generated {
	label: String,
	text: String,
	zsh: bool,
	context: &'static [u8],
	// Generated from the Case pattern/body/terminator branch, independently of
	// whether today's parser remembered to record its closing token.
	empty_parenthesized_case: bool,
}

fn generated_samples() -> Vec<Generated> {
	let mut out = Vec::new();
	for zsh in [false, true] {
		let mut add = |label: String, text: String| {
			let empty_parenthesized_case = zsh && label.starts_with("Case/(") && label.ends_with("//");
			out.push(Generated {
				label,
				text,
				zsh,
				context: b"for i in a; do check; done\n",
				empty_parenthesized_case,
			})
		};
		for &kind in variants::<CommandKind>() {
			let examples: &[&str] = match kind {
				"Simple" => &["echo plain", "a=( [1]=one [2]=two )", "declare -a a=( [1]=one )"],
				"Brace" => &["{ echo body; }"],
				"Subshell" => &["( echo body )"],
				"If" => &["if true; then echo first; elif false; then echo second; else echo last; fi"],
				"While" => &["while false; do echo body; done", "until true; do echo body; done"],
				"For" | "Select" => {
					let keyword = if kind == "For" { "for" } else { "select" };
					for names in if zsh && kind == "For" {
						&["i", "i j"][..]
					} else {
						&["i"][..]
					} {
						for words in ["", " in", " in one two"] {
							add(
								format!("{kind}/{names}/{words}"),
								format!("{keyword} {names}{words}; do echo body; done"),
							);
						}
					}
					if zsh && kind == "For" {
						for words in ["", "one two"] {
							add(
								format!("For/foreach/{words}"),
								format!("foreach i ({words})\necho body\nend"),
							);
						}
						add("For/braces".into(), "for i in one; { echo body }".into());
					}
					&[]
				},
				"ArithFor" => {
					for init in ["", "i=0"] {
						for cond in ["", "i<2"] {
							for step in ["", "i++"] {
								add(
									format!("ArithFor/{init}/{cond}/{step}"),
									format!("for (({init};{cond};{step})); do echo body; done"),
								);
							}
						}
					}
					&[]
				},
				"Case" => {
					for pattern in ["one", "(one)", "(one|two)"] {
						let pattern = if pattern.starts_with('(') {
							pattern.to_owned()
						} else {
							format!("{pattern})")
						};
						for body in ["", "echo body"] {
							for term in
								std::iter::once("").chain(variants::<CaseTerm>().iter().map(|name| {
									match *name {
										"Break" => ";;",
										"FallThrough" => ";&",
										"Continue" => {
											if zsh {
												";|"
											} else {
												";;&"
											}
										},
										other => panic!("no case terminator generator for {other}"),
									}
								})) {
								add(
									format!("Case/{pattern}/{body}/{term}"),
									format!("case subject in {pattern} {body}\n{term} esac"),
								);
							}
						}
					}
					&[]
				},
				"Arith" => &["(( 1 + 2 ))"],
				"Cond" => {
					&["[[ -n word ]]", "[[ left == right ]]", "[[ ! ! word && ( other || last ) ]]"]
				},
				"FuncDef" => {
					if zsh {
						&["f() { echo body }", "function f g { echo body }"]
					} else {
						&["f() { echo body; }", "function f { echo body; }"]
					}
				},
				"Coproc" => {
					if zsh {
						&["coproc { echo body; }"]
					} else {
						&["coproc { echo body; }", "coproc named { echo body; }"]
					}
				},
				"Repeat" => {
					if zsh {
						&["repeat 2 do echo body; done", "repeat 2 { echo body }"]
					} else {
						&[]
					}
				},
				"Try" => {
					if zsh {
						&["{ echo body } always { echo always }"]
					} else {
						&[]
					}
				},
				"AnonFunc" => {
					if zsh {
						&["() { echo body } argument"]
					} else {
						&[]
					}
				},
				other => panic!("no command generator for {other}"),
			};
			for text in examples {
				add(kind.into(), (*text).into());
			}
		}
		for &kind in variants::<WordPart>() {
			for word in word_payloads(kind) {
				let text = if kind == "Compound" {
					format!("declare -a a={word}")
				} else {
					format!("echo {word}")
				};
				// These intentionally deferred bash quote errors are not zsh
				// grammar.
				if zsh && matches!(kind, "BadComsub" | "DroppedQuote") {
					continue;
				}
				add(format!("WordPart/{kind}"), text);
			}
		}
		for &kind in variants::<ParamOp>() {
			for expression in param_payloads(kind) {
				add(format!("ParamOp/{kind}"), format!("echo {expression}"));
			}
		}
	}
	// Preserve the pre-existing nested source contexts as well as their text.
	out
}

fn word_payloads(kind: &str) -> Vec<String> {
	let words: &[&str] = match kind {
		"Lit" => &["plain", "é😀", "$"],
		"Escaped" => &["a\\bc", "\\$"],
		"SQuote" => &["'quoted'", "''"],
		"DQuote" => &["\"quoted ${y}\"", "\"\""],
		"AnsiC" => &["$'ansi\\t'", "$''"],
		"Locale" => &["$\"locale ${y}\"", "$\"\""],
		"Param" => &["${y}", "${a[@]}", "${a[*]}", "${a[${i}]}"],
		"Comsub" => {
			return variants::<ComsubKind>()
				.iter()
				.flat_map(|kind| match *kind {
					"Dollar" => vec!["$(echo sub)", "$(echo $(echo nested))"],
					"Backtick" => {
						vec!["`echo sub`", "`echo \\`echo ${x@Q}\\``", "`echo \\`echo ${x/#a/b}\\``"]
					},
					"NoFork" => vec!["${ echo sub; }"],
					"ValueSub" => vec!["${| REPLY=value; }"],
					other => panic!("no command substitution generator for {other}"),
				})
				.map(str::to_owned)
				.collect();
		},
		"Arith" => &["$[1]", "$((1+2))"],
		"ProcSub" => &["<(echo input)", ">(echo output)"],
		"Compound" => &["(one two)", "( [1]=one [2]=two )"],
		"BadSubst" => &["${a b}"],
		"BadComsub" => &["\"${a+'$('\\'}\""],
		"DroppedQuote" => &["\"${x-'\"'y}\""],
		"Zsh" => &["zsh*", "'zsh quoted'"],
		other => panic!("no word payload generator for {other}"),
	};
	words.iter().map(|s| (*s).into()).collect()
}

fn param_payloads(kind: &str) -> Vec<String> {
	// Every operand position receives every expanding word payload. Compound
	// arrays and deferred quote errors have their own grammatical contexts
	// above.
	let operands: Vec<String> = std::iter::once(String::new())
		.chain(
			variants::<WordPart>()
				.iter()
				.filter(|k| {
					!matches!(**k, "Compound" | "BadComsub" | "DroppedQuote" | "Zsh" | "Comsub")
				})
				.flat_map(|kind| word_payloads(kind)),
		)
		.chain(["$(echo operand)".into(), "`echo \\`echo ${y}\\``".into()])
		.collect();
	let mut out = Vec::new();
	match kind {
		"None" => {
			for name in variants::<ParamName>() {
				match *name {
					"Var" => out.extend(["$x", "${x}"].map(str::to_owned)),
					"Positional" => out.extend(["$1", "${10}"].map(str::to_owned)),
					"Special" => {
						for special in variants::<Special>() {
							let token = match *special {
								"At" => '@',
								"Star" => '*',
								"Count" => '#',
								"Status" => '?',
								"Flags" => '-',
								"ShellPid" => '$',
								"LastBg" => '!',
								other => panic!("no special parameter generator for {other}"),
							};
							out.push(format!("${token}"));
						}
					},
					other => panic!("no parameter name generator for {other}"),
				}
			}
			for subscript in variants::<Subscript>() {
				let text = match *subscript {
					"At" => "@",
					"Star" => "*",
					"Expr" => "${i}",
					other => panic!("no subscript generator for {other}"),
				};
				out.push(format!("${{a[{text}]}}"));
			}
		},
		"Length" => out.push("${#x}".into()),
		"Indirect" => out.extend(["${!x}", "${!a[@]}"].map(str::to_owned)),
		"PrefixNames" => {
			for suffix in ["*", "@"] {
				out.push(format!("${{!prefix{suffix}}}"));
			}
		},
		"Default" | "Assign" | "Error" | "Alt" => {
			let op = match kind {
				"Default" => '-',
				"Assign" => '=',
				"Error" => '?',
				"Alt" => '+',
				_ => unreachable!(),
			};
			for colon in ["", ":"] {
				for word in &operands {
					out.push(format!("${{x{colon}{op}{word}}}"));
				}
			}
		},
		"Substr" => {
			for offset in ["1", "1+2", " -1"] {
				for len in ["", ":2", ":2+3"] {
					out.push(format!("${{x:{offset}{len}}}"));
				}
			}
		},
		"Trim" => {
			for op in ["#", "##", "%", "%%"] {
				for pat in &operands {
					out.push(format!("${{x{op}{pat}}}"));
				}
			}
		},
		"Replace" => {
			for mode in variants::<ReplaceMode>() {
				let op = match *mode {
					"First" => "/",
					"All" => "//",
					"Prefix" => "/#",
					"Suffix" => "/%",
					other => panic!("no replacement generator for {other}"),
				};
				// Vary each operand independently, not just one row per variant.
				for operand in &operands {
					out.push(format!("${{x{op}{operand}/replacement}}"));
					out.push(format!("${{x{op}pattern/{operand}}}"));
					out.push(format!("${{x{op}{operand}}}"));
				}
			}
		},
		"Case" => {
			for mode in variants::<CaseMode>() {
				let op = match *mode {
					"Upper" => "^",
					"Lower" => ",",
					"Toggle" => "~",
					other => panic!("no case conversion generator for {other}"),
				};
				for doubled in [false, true] {
					for pat in &operands {
						out.push(format!("${{x{op}{}{pat}}}", if doubled { op } else { "" }));
					}
				}
			}
		},
		"Transform" => {
			for op in "QEPAaKkUuL".chars() {
				out.push(format!("${{x@{op}}}"));
			}
		},
		other => panic!("no parameter generator for {other}"),
	}
	out
}

struct DynamicAlias<'a>(&'a [u8]);
impl AliasLookup for DynamicAlias<'_> {
	fn alias(&self, name: &[u8]) -> Option<&[u8]> {
		(name == b"check").then_some(self.0)
	}
}

fn parse_generated(src: &[u8], text: &[u8], zsh: bool) -> Result<Program, String> {
	let alias = DynamicAlias(text);
	let mut parser = Parser::new(src, if zsh { zsh_features() } else { Features::NONE }, &alias);
	let mut commands = Vec::new();
	while let Some(command) = parser.next_command() {
		commands.push(command.map_err(|e| e.to_string())?);
	}
	Ok(Program { commands })
}

fn parts_schema_faults(v: &serde_json::Value, path: &str, bad: &mut Vec<String>) {
	match v {
		serde_json::Value::Object(map) => {
			if let Some(parts) = map.get("Parts").and_then(serde_json::Value::as_array) {
				for (i, part) in parts.iter().enumerate() {
					if !part.is_object() || !part.get("Type").is_some_and(serde_json::Value::is_string) {
						bad.push(format!("{path}.Parts[{i}]: missing Type discriminator"));
					}
				}
			}
			if let Some(word) = map.get("Hdoc")
				&& word
					.get("Parts")
					.and_then(serde_json::Value::as_array)
					.is_none_or(Vec::is_empty)
			{
				bad.push(format!(
					"{path}.Hdoc: empty optional word must be omitted, not sent to shfmt's printer"
				));
			}
			if map.get("Type").and_then(serde_json::Value::as_str) == Some("ParamExp")
				&& let Some(replacement) = map.get("Repl").and_then(serde_json::Value::as_object)
			{
				for key in ["Orig", "With"] {
					if let Some(word) = replacement.get(key)
						&& word
							.get("Parts")
							.and_then(serde_json::Value::as_array)
							.is_none_or(Vec::is_empty)
					{
						bad.push(format!(
							"{path}.Repl.{key}: empty optional word must be omitted, not sent to shfmt's \
							 printer"
						));
					}
				}
			}
			for (key, child) in map {
				parts_schema_faults(child, &format!("{path}.{key}"), bad);
			}
		},
		serde_json::Value::Array(items) => {
			for (i, child) in items.iter().enumerate() {
				parts_schema_faults(child, &format!("{path}[{i}]"), bad);
			}
		},
		_ => {},
	}
}

#[derive(Debug)]
enum ShfmtRejection {
	Node(&'static str),
	ExtraNames(&'static str),
	Toggle(bool),
}

impl ShfmtRejection {
	fn matches(&self, error: &str) -> bool {
		match self {
			Self::Node(kind) => {
				error
					.strip_prefix("unknown type: \"")
					.and_then(|s| s.strip_suffix('"'))
					== Some(*kind)
			},
			Self::ExtraNames(kind) => {
				error
					.strip_prefix("unknown field for syntax.")
					.and_then(|s| s.strip_suffix(": \"ExtraNames\""))
					== Some(*kind)
			},
			Self::Toggle(all) => {
				error
					.strip_prefix("invalid ParExpOperator: \"")
					.and_then(|s| s.strip_suffix('"'))
					== Some(if *all { "~~" } else { "~" })
			},
		}
	}
}

/// Compare literals in parser field order, including multiplicities. A bag of
/// values would accept two swapped operands. This oracle never reads source
/// slices, and equal alias positions do not erase a value's place in the walk.
#[derive(Default)]
struct ParsedLiterals(Vec<String>, bool, Vec<ShfmtRejection>, Vec<&'static str>);

impl ParsedLiterals {
	fn bytes(&mut self, bytes: &[u8]) {
		self.0.push(String::from_utf8_lossy(bytes).into_owned());
	}

	fn arith(&mut self, a: &ArithText) {
		let text = String::from_utf8_lossy(&a.src);
		let text = text.trim_matches([' ', '\t', '\n']);
		if !text.is_empty() {
			self.0.push(text.into());
		}
	}

	fn word(&mut self, w: &Word) {
		self.parts(&w.parts, Vec::new());
	}

	fn parts(&mut self, parts: &[WordPart], mut run: Vec<u8>) {
		let anchored = !run.is_empty();
		for part in parts {
			match part {
				WordPart::Lit(value) => {
					for &byte in value.iter() {
						if byte == b'$' && !anchored {
							if !run.is_empty() {
								self.bytes(&run);
								run.clear();
							}
							self.bytes(b"$");
						} else {
							run.push(byte);
						}
					}
					continue;
				},
				WordPart::Escaped(_)
				| WordPart::BadSubst(_)
				| WordPart::BadComsub(_)
				| WordPart::DroppedQuote { .. }
				| WordPart::Zsh(_) => {
					crate::bash::syntax::print::parts_text(core::slice::from_ref(part), &mut run);
					continue;
				},
				_ => {},
			}
			if !run.is_empty() {
				self.bytes(&run);
				run.clear();
			}
			match part {
				WordPart::SQuote(_) | WordPart::AnsiC(_) => {},
				WordPart::DQuote(inner) | WordPart::Locale(inner) => self.parts(inner, Vec::new()),
				WordPart::Param(p) => self.param(p),
				WordPart::Comsub(c) => {
					self.1 |= flat_separator(&c.body);
					self.list(&c.body);
				},
				WordPart::Arith(a) => self.arith(a),
				WordPart::ProcSub(p) => {
					self.1 |= flat_separator(&p.body);
					self.list(&p.body);
				},
				WordPart::Compound(elems) => self.array(elems),
				WordPart::Lit(_)
				| WordPart::Escaped(_)
				| WordPart::BadSubst(_)
				| WordPart::BadComsub(_)
				| WordPart::DroppedQuote { .. }
				| WordPart::Zsh(_) => unreachable!(),
			}
		}
		if !run.is_empty() {
			self.bytes(&run);
		}
	}

	fn array(&mut self, elems: &[ArrayElem]) {
		for elem in elems {
			if let Some(key) = &elem.key {
				self.word(key);
			}
			self.word(&elem.value);
		}
	}

	fn param(&mut self, p: &Param) {
		if let ParamOp::Case { mode: CaseMode::Toggle, all, .. } = &p.op {
			self.2.push(ShfmtRejection::Toggle(*all));
		}
		match &p.name {
			ParamName::Var(name) => self.bytes(name),
			ParamName::Positional(n) => self.0.push(n.to_string()),
			ParamName::Special(s) => self.bytes(match s {
				Special::At => b"@",
				Special::Star => b"*",
				Special::Count => b"#",
				Special::Status => b"?",
				Special::Flags => b"-",
				Special::ShellPid => b"$",
				Special::LastBg => b"!",
			}),
		}
		match &p.index {
			Some(Subscript::At) => self.bytes(b"@"),
			Some(Subscript::Star) => self.bytes(b"*"),
			Some(Subscript::Expr(w)) => self.word(w),
			None => {},
		}
		match &p.op {
			ParamOp::None | ParamOp::Length | ParamOp::Indirect | ParamOp::PrefixNames { .. } => {},
			ParamOp::Default { word, .. }
			| ParamOp::Assign { word, .. }
			| ParamOp::Alt { word, .. } => self.word(word),
			ParamOp::Error { word, .. } | ParamOp::Case { pat: word, .. } => {
				if let Some(w) = word {
					self.word(w);
				}
			},
			ParamOp::Trim { pat, .. } => self.word(pat),
			ParamOp::Substr { offset, len } => {
				self.arith(offset);
				if let Some(len) = len {
					self.arith(len);
				}
			},
			ParamOp::Replace { mode, pat, rep, .. } => {
				let anchor = match mode {
					ReplaceMode::Prefix => vec![b'#'],
					ReplaceMode::Suffix => vec![b'%'],
					ReplaceMode::First | ReplaceMode::All => Vec::new(),
				};
				self.parts(&pat.parts, anchor);
				if let Some(rep) = rep {
					self.word(rep);
				}
			},
			ParamOp::Transform { op, .. } => self.bytes(&[*op]),
		}
	}

	fn list(&mut self, list: &List) {
		for item in &list.items {
			for pipeline in
				std::iter::once(&item.and_or.first).chain(item.and_or.rest.iter().map(|(_, p)| p))
			{
				for stage in &pipeline.stages {
					self.command(&stage.cmd);
				}
			}
		}
	}

	fn cond(&mut self, e: &CondExpr) {
		match e {
			CondExpr::Word(w) | CondExpr::Unary { arg: w, .. } => self.word(w),
			CondExpr::Binary { lhs, rhs, .. } => {
				self.word(lhs);
				self.word(rhs);
			},
			CondExpr::Not { expr, .. } | CondExpr::Group { expr, .. } => self.cond(expr),
			CondExpr::And(terms, _) | CondExpr::Or(terms, _) => {
				for term in terms {
					self.cond(term);
				}
			},
		}
	}

	fn command(&mut self, command: &Command) {
		match &command.kind {
			CommandKind::For(f) | CommandKind::Select(f) => {
				if f.words.as_ref().is_some_and(Vec::is_empty)
					&& f.in_pos.is_some_and(|pos| pos > f.var_span.hi)
				{
					self.3.push(ITERATOR_IN);
				}
				if f.words.as_ref().is_none_or(Vec::is_empty)
					&& f.extra_vars.iter().any(|name| name.span.hi > f.var_span.hi)
				{
					self.3.push(ITERATOR_NAMES);
				}
			},
			_ => {},
		}
		if let Some(extension) = shfmt_extension(&command.kind) {
			self.2.push(extension);
		}
		if command.span.lo == command.span.hi {
			self.1 |= match &command.kind {
				CommandKind::Brace(l) | CommandKind::Subshell(l) => flat_separator(l),
				CommandKind::If(i) => {
					i.arms
						.iter()
						.any(|a| flat_separator(&a.cond) || flat_separator(&a.body))
						|| i.else_body.as_ref().is_some_and(flat_separator)
				},
				CommandKind::While(w) => flat_separator(&w.cond) || flat_separator(&w.body),
				CommandKind::For(f) | CommandKind::Select(f) => flat_separator(&f.body),
				CommandKind::ArithFor(f) => flat_separator(&f.body),
				CommandKind::Case(c) => c.arms.iter().any(|a| flat_separator(&a.body)),
				CommandKind::Repeat(r) => flat_separator(&r.body),
				CommandKind::Try(t) => flat_separator(&t.body) || flat_separator(&t.always),
				CommandKind::Simple(_)
				| CommandKind::Arith(_)
				| CommandKind::Cond(_)
				| CommandKind::FuncDef(_)
				| CommandKind::Coproc(_)
				| CommandKind::AnonFunc(_) => false,
			};
		}
		match &command.kind {
			CommandKind::Simple(s) => {
				for a in &s.assigns {
					self.bytes(&a.name);
					if let Some(index) = &a.index {
						self.word(index);
					}
					match &a.value {
						AssignValue::Scalar(w) => self.word(w),
						AssignValue::Array(elems) => self.array(elems),
					}
				}
				let declaration = s.assigns.is_empty() && s.words.first().is_some_and(|w| matches!(&w.parts[..], [WordPart::Lit(name)] if matches!(&name[..], b"declare" | b"local" | b"export" | b"readonly" | b"typeset" | b"nameref")) || matches!(&w.parts[..], [WordPart::Zsh(name)] if matches!(&name[..], b"declare" | b"local" | b"export" | b"readonly" | b"typeset" | b"nameref")));
				for (i, w) in s.words.iter().enumerate() {
					if declaration && i > 0 {
						if let Some(prefix) = w.parts.first().and_then(|part| match part {
							WordPart::Lit(bytes) => Some(&bytes[..]),
							WordPart::Zsh(bytes) => Some(&bytes[..]),
							_ => None,
						}) {
							if let Some(eq) = prefix.iter().position(|&c| c == b'=') {
								self.bytes(prefix[..eq].strip_suffix(b"+").unwrap_or(&prefix[..eq]));
								let tail = prefix[eq + 1..].to_vec();
								self.parts(&w.parts[1..], tail);
								continue;
							}
						}
					}
					self.word(w);
				}
			},
			CommandKind::Brace(l) | CommandKind::Subshell(l) => self.list(l),
			CommandKind::If(i) => {
				for arm in &i.arms {
					self.list(&arm.cond);
					self.list(&arm.body);
				}
				if let Some(body) = &i.else_body {
					self.list(body);
				}
			},
			CommandKind::While(w) => {
				self.list(&w.cond);
				self.list(&w.body);
			},
			CommandKind::For(f) | CommandKind::Select(f) => {
				self.bytes(&f.var);
				for n in &f.extra_vars {
					self.bytes(&n.text);
				}
				for w in f.words.iter().flatten() {
					self.word(w);
				}
				self.list(&f.body);
			},
			CommandKind::ArithFor(f) => {
				self.arith(&f.init);
				self.arith(&f.cond);
				self.arith(&f.step);
				self.list(&f.body);
			},
			CommandKind::Case(c) => {
				self.word(&c.word);
				for arm in &c.arms {
					for p in &arm.patterns {
						self.word(p);
					}
					self.list(&arm.body);
				}
			},
			CommandKind::Arith(a) => self.arith(a),
			CommandKind::Cond(e) => self.cond(e),
			CommandKind::FuncDef(f) => {
				self.bytes(&f.name);
				for name in &f.extra_names {
					self.bytes(&name.text);
				}
				self.command(&f.body);
			},
			CommandKind::Coproc(c) => {
				if let Some(name) = &c.name {
					self.bytes(&name.text);
				}
				self.command(&c.body);
			},
			CommandKind::Repeat(r) => {
				self.word(&r.count);
				self.list(&r.body);
			},
			CommandKind::Try(t) => {
				self.list(&t.body);
				self.list(&t.always);
			},
			CommandKind::AnonFunc(a) => {
				self.command(&a.body);
				for w in &a.args {
					self.word(w);
				}
			},
		}
		for redir in &command.redirs {
			if let Some(fd) = &redir.fd {
				match fd {
					RedirFd::Num(n) => self.0.push(n.to_string()),
					RedirFd::Var(v) => self.bytes(v),
				}
			}
			match &redir.target {
				RedirTarget::Word(w) => self.word(w),
				RedirTarget::HereDoc(_) => {
					panic!("add the heredoc value contract before generating heredocs")
				},
			}
		}
	}
}

/// Visit the consumer's fields in the same semantic order as the typed AST
/// oracle, independently of serde_json's alphabetical object-key order. Names
/// precede indices and values; patterns precede replacements; conditions
/// precede bodies; a command precedes its redirections. Array order is never
/// changed.
fn ordered_lit_values<'a>(v: &'a serde_json::Value, values: &mut Vec<&'a str>) {
	const FIELDS: &[&str] = &[
		"Cmd",
		"Variant",
		"Assigns",
		"Name",
		"ExtraNames",
		"Param",
		"Index",
		"Loop",
		"Count",
		"Init",
		"Cond",
		"Post",
		"Word",
		"Patterns",
		"Items",
		"Then",
		"Else",
		"Body",
		"Do",
		"Always",
		"Stmt",
		"Args",
		"Value",
		"Array",
		"Elems",
		"Exp",
		"Slice",
		"Offset",
		"Length",
		"Repl",
		"Orig",
		"With",
		"X",
		"Y",
		"Parts",
		"Stmts",
		"Redirs",
	];
	match v {
		serde_json::Value::Object(map) => {
			if map.contains_key("ValuePos")
				|| map.get("Type").and_then(serde_json::Value::as_str) == Some("Lit")
				|| (!map.contains_key("Type")
					&& map.get("Value").is_some_and(serde_json::Value::is_string))
			{
				values.push(
					map.get("Value")
						.and_then(serde_json::Value::as_str)
						.unwrap_or(""),
				);
				return;
			}
			for key in FIELDS {
				if let Some(child) = map.get(*key) {
					ordered_lit_values(child, values);
				}
			}
			// A newly exported field must not become invisible to the oracle.
			for (key, child) in map {
				if !FIELDS.contains(&key.as_str()) {
					ordered_lit_values(child, values);
				}
			}
		},
		serde_json::Value::Array(items) => {
			for child in items {
				ordered_lit_values(child, values);
			}
		},
		_ => {},
	}
}

fn literal_value_faults(tree: &serde_json::Value, expected: &[String], bad: &mut Vec<String>) {
	let mut actual = Vec::new();
	ordered_lit_values(tree, &mut actual);
	if actual != expected {
		bad.push(format!("Lit values {actual:?}, expected parsed bytes {expected:?}"));
	}
}

fn read_with_real_shfmt(binary: &std::ffi::OsStr, json: &str) -> std::process::Output {
	use std::io::Write;
	let mut child = std::process::Command::new(binary)
		.arg("--from-json")
		.stdin(std::process::Stdio::piped())
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::piped())
		.spawn()
		.expect("start real shfmt");
	child
		.stdin
		.take()
		.unwrap()
		.write_all(json.as_bytes())
		.unwrap();
	child.wait_with_output().unwrap()
}

#[test]
fn empty_heredocs_omit_the_optional_consumer_word_and_end_at_the_delimiter() {
	let oracle = std::env::var_os("SHFMT_BIN");
	let mut faults = Vec::new();
	let mut oracle_calls = 0;
	let mut delimiter_comparisons = [0usize; 2];
	for zsh in [false, true] {
		for strip_tabs in [false, true] {
			for delimiter in ["EOF", "'EOF'"] {
				let op = match (RedirOp::HereDoc { strip_tabs }) {
					RedirOp::HereDoc { strip_tabs: false } => "<<",
					RedirOp::HereDoc { strip_tabs: true } => "<<-",
					_ => unreachable!(),
				};
				let source = format!("cat{op}{delimiter}\nEOF\n");
				let program = parse_generated(source.as_bytes(), b"", zsh).unwrap();
				for offsets in [Offsets::Bytes, Offsets::Utf16] {
					for dialect in [JsonDialect::Native, JsonDialect::Shfmt] {
						let json = to_json(source.as_bytes(), &program, dialect, offsets);
						let tree: serde_json::Value = serde_json::from_str(&json).unwrap();
						let mut bad = Vec::new();
						range_faults(&tree, None, "", &mut bad);
						if dialect == JsonDialect::Shfmt {
							parts_schema_faults(&tree, "", &mut bad);
							let redir = &tree["Stmts"][0]["Redirs"][0];
							if redir.get("Hdoc").is_some() {
								bad.push("empty body must omit Hdoc".into());
							}
							let delimiter_end =
								source.bytes().position(|byte| byte == b'\n').unwrap() as u64;
							if bare_offset(&redir["End"]) != Some(delimiter_end) {
								bad.push(format!(
									"absent body must leave Redirect.End at delimiter end {delimiter_end}, \
									 got {}",
									redir["End"]
								));
							}
							if let Some(word_end) = redir["Word"].get("End") {
								delimiter_comparisons[usize::from(zsh)] += 1;
								if redir["End"] != *word_end {
									bad.push(
										"absent body must leave Redirect.End equal to recorded Word.End"
											.into(),
									);
								}
							}
							if let Some(binary) = &oracle {
								let output = read_with_real_shfmt(binary, &json);
								oracle_calls += 1;
								if !output.status.success() {
									bad.push(format!(
										"shfmt exit {:?}: {}",
										output.status.code(),
										String::from_utf8_lossy(&output.stderr)
									));
								}
							}
						}
						for fault in bad {
							faults.push(format!("{source:?} zsh={zsh} {dialect:?}/{offsets:?}: {fault}"));
						}
					}
				}
			}
		}
	}
	for (dialect, comparisons) in ["bash", "zsh"].into_iter().zip(delimiter_comparisons) {
		if comparisons != 8 {
			faults.push(format!(
				"{dialect}: all 8 generated delimiter endpoints must be recorded and compared, got \
				 {comparisons}"
			));
		}
	}
	eprintln!(
		"empty heredocs: 8 source cases, 32 documents, {oracle_calls} real shfmt calls, recorded \
		 delimiter comparisons {delimiter_comparisons:?}, {} faults",
		faults.len()
	);
	assert!(faults.is_empty(), "{}", faults.join("\n"));
}

#[test]
fn the_literal_oracle_rejects_swapped_parameter_operands() {
	let src = b"echo ${x/pattern/replacement}";
	let program = parse_all(src, Features::NONE).unwrap();
	let mut expected = ParsedLiterals::default();
	for command in &program.commands {
		expected.list(&command.list);
	}
	let mut tree: serde_json::Value =
		serde_json::from_str(&to_json(src, &program, JsonDialect::Shfmt, Offsets::Bytes)).unwrap();
	let mut faults = Vec::new();
	literal_value_faults(&tree, &expected.0, &mut faults);
	assert!(faults.is_empty(), "unmodified export: {faults:?}");
	let replacement = &mut tree["Stmts"][0]["Cmd"]["Args"][1]["Parts"][0]["Repl"];
	let pattern = replacement["Orig"]["Parts"][0]["Value"].take();
	let value = replacement["With"]["Parts"][0]["Value"].take();
	replacement["Orig"]["Parts"][0]["Value"] = value;
	replacement["With"]["Parts"][0]["Value"] = pattern;
	literal_value_faults(&tree, &expected.0, &mut faults);
	assert_eq!(faults.len(), 1, "swapped operands must not pass: {tree}");
}

/// Exhaustive over the parser enum, not a list of fixture strings. Adding a
/// command kind requires choosing its consumer contract here too.
fn shfmt_extension(kind: &CommandKind) -> Option<ShfmtRejection> {
	match kind {
		CommandKind::Repeat(_) => Some(ShfmtRejection::Node("RepeatClause")),
		CommandKind::Try(_) => Some(ShfmtRejection::Node("TryClause")),
		CommandKind::AnonFunc(_) => Some(ShfmtRejection::Node("AnonFuncDecl")),
		CommandKind::For(f) | CommandKind::Select(f) if !f.extra_vars.is_empty() => {
			Some(ShfmtRejection::ExtraNames("WordIter"))
		},
		CommandKind::FuncDef(f) if !f.extra_names.is_empty() => {
			Some(ShfmtRejection::ExtraNames("FuncDecl"))
		},
		CommandKind::Simple(_)
		| CommandKind::Brace(_)
		| CommandKind::Subshell(_)
		| CommandKind::If(_)
		| CommandKind::While(_)
		| CommandKind::For(_)
		| CommandKind::ArithFor(_)
		| CommandKind::Select(_)
		| CommandKind::Case(_)
		| CommandKind::Arith(_)
		| CommandKind::Cond(_)
		| CommandKind::FuncDef(_)
		| CommandKind::Coproc(_) => None,
	}
}

#[test]
fn generated_nodes_preserve_ranges_schema_and_parsed_literal_values() {
	let mut faults = Vec::new();
	let mut documents = 0;
	let mut oracle_exits = std::collections::BTreeMap::new();
	let mut sibling_fault_count = 0;
	let mut sibling_causes = std::collections::BTreeMap::new();
	let mut sibling_documents = std::collections::BTreeMap::new();
	let mut oracle_kinds = std::collections::BTreeMap::new();
	let oracle = std::env::var_os("SHFMT_BIN");
	let mut corpus = std::env::var_os("EXPORT_SAMPLES_FILE")
		.map(|path| std::fs::File::create(path).expect("create requested generated corpus"));
	let mut samples = generated_samples();
	for sample in SAMPLES {
		samples.push(Generated {
			label: format!("historical/{}", String::from_utf8_lossy(sample.src)),
			text: String::from_utf8_lossy(sample.text).into_owned(),
			zsh: sample.zsh,
			context: sample.src,
			empty_parenthesized_case: false,
		});
	}
	let (mut kinds, mut parts) = (Vec::new(), Vec::new());
	for sample in &samples {
		let ordinary = format!(": é 😀; {}", sample.text);
		// item() reaches stmt_end's separator branch only if the original
		// source has a separator at the flat alias cursor. Padding alone does
		// not make that branch reachable; keep both `;` and bytes beyond it.
		let alias_source = b"check; :\n";
		let nested_source = if sample.context == b"check\n" {
			&alias_source[..]
		} else {
			sample.context
		};
		for (source_kind, src, alias) in [
			("ordinary", ordinary.as_bytes(), &b""[..]),
			("alias", &alias_source[..], sample.text.as_bytes()),
			("nested alias", &nested_source[..], sample.text.as_bytes()),
		] {
			let context =
				format!("{} zsh={} {source_kind}: {:?}", sample.label, sample.zsh, sample.text);
			let program = match parse_generated(src, alias, sample.zsh) {
				Ok(program) => program,
				Err(error) => {
					faults.push(format!("{context}: parse: {error}"));
					continue;
				},
			};
			let mut expected = ParsedLiterals::default();
			for command in &program.commands {
				expected.list(&command.list);
			}
			if sample.empty_parenthesized_case && source_kind != "ordinary" {
				expected.3.push(CASE_CLOSE);
			}
			let mut owners = Vec::new();
			if expected.1 {
				owners.push(Owner::Sibling("stmt_end separator byte"));
			}
			expected.3.sort_unstable();
			expected.3.dedup();
			owners.extend(expected.3.iter().map(|&cause| Owner::Sibling(cause)));
			if owners.is_empty() {
				owners.push(Owner::Words);
			}
			if let Some(file) = &mut corpus {
				use std::io::Write;
				let row = serde_json::json!({ "src": String::from_utf8_lossy(src), "alias": String::from_utf8_lossy(alias), "zsh": sample.zsh, "owner": format!("{owners:?}") });
				writeln!(file, "{row}").expect("write requested generated corpus");
			}
			for command in &program.commands {
				collect_list_names(&command.list, &mut kinds, &mut parts);
			}
			for offsets in [Offsets::Bytes, Offsets::Utf16] {
				for dialect in [JsonDialect::Native, JsonDialect::Shfmt] {
					let json = to_json(src, &program, dialect, offsets);
					let tree: serde_json::Value = serde_json::from_str(&json).unwrap();
					let mut bad = Vec::new();
					range_faults(&tree, None, "", &mut bad);
					if dialect == JsonDialect::Shfmt {
						for owner in &owners {
							let Owner::Sibling(cause) = owner else {
								continue;
							};
							let mut sibling = Vec::new();
							if *cause == "stmt_end separator byte" {
								separator_faults(&tree, None, "", &mut sibling);
								// OffMap may clamp a correct parser span at EOF, so
								// all alias sources above deliberately have padding.
							} else {
								command_boundary_faults(&tree, "", cause, &mut sibling);
							}
							if sibling.is_empty() {
								bad.push(format!(
									"stale {owner:?} marker: the row must STILL fault for this cause"
								));
							}
							sibling_fault_count += sibling.len();
							*sibling_causes.entry(*cause).or_insert(0usize) += sibling.len();
							*sibling_documents.entry(*cause).or_insert(0usize) +=
								usize::from(!sibling.is_empty());
							bad.retain(|fault| !sibling.contains(fault));
						}
					}
					if dialect == JsonDialect::Shfmt {
						parts_schema_faults(&tree, "", &mut bad);
						literal_value_faults(&tree, &expected.0, &mut bad);
						if let Some(binary) = &oracle {
							let output = read_with_real_shfmt(binary, &json);
							*oracle_exits.entry(output.status.code()).or_insert(0usize) += 1;
							let extensions = &expected.2;
							*oracle_kinds
								.entry(if extensions.is_empty() {
									"decode".to_owned()
								} else {
									format!("reject {extensions:?}")
								})
								.or_insert(0usize) += 1;
							let error = String::from_utf8_lossy(&output.stderr);
							if extensions.is_empty() {
								if !output.status.success() {
									bad.push(format!(
										"shfmt --from-json {:?}: {error}",
										output.status.code()
									));
								}
							} else if output.status.code() != Some(1)
								|| !extensions
									.iter()
									.any(|feature| feature.matches(error.trim()))
							{
								bad.push(format!(
									"shfmt must reject exactly the unsupported features {extensions:?}, \
									 got {:?}: {error}",
									output.status.code()
								));
							}
						}
					}
					documents += 1;
					for fault in bad {
						faults.push(format!("{context} {dialect:?}/{offsets:?}: {fault}"));
					}
				}
			}
		}
	}
	for &kind in variants::<CommandKind>() {
		assert!(kinds.contains(&kind), "no generated command {kind}");
	}
	for &part in variants::<WordPart>() {
		assert!(parts.contains(&part), "no generated word part {part}");
	}
	for &op in variants::<ParamOp>() {
		assert!(parts.contains(&op), "no generated parameter operator {op}");
	}
	eprintln!(
		"generated gate: {} samples, {documents} documents, {} unexpected faults, \
		 {sibling_fault_count} sibling faults {sibling_causes:?} in documents \
		 {sibling_documents:?}; real shfmt exits {oracle_exits:?}, required outcomes \
		 {oracle_kinds:?}",
		samples.len(),
		faults.len()
	);
	assert!(faults.is_empty(), "{} generated faults:\n{}", faults.len(), faults.join("\n"));
}
