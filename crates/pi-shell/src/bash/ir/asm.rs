//! Text form of IR units: `obash --ir` output and back-end test input.
//!
//! ```text
//! ; unit 3f…
//! .unit bash 0
//! .source "for i in 1 2; do echo $i; done"
//! .tables 0a00…            ; postcard image of the side tables
//! ; word 0: [Lit("1")]      ; readable rendering of each table entry
//! 0000 Enter a=0 b=0 @2
//! 0001 ForIn a=0 b=0 @2
//! ```
//!
//! Directives: `.unit MODE FEATURES`, `.source STR`, `.line N` (first
//! script line, default 1), `.root NODE` (function bodies), `.tables HEX` (all
//! side tables: aliases, nodes, words, lists, cmds, names, strs, redirs,
//! spawns, pats, ariths, conds, funcs). Code lines are `PC OPCODE a=A b=B @NODE
//! [cond] [ctx] [syntax] [select]`, editable by hand; `;` starts a comment.
//! Strings escape `\\`, `\"`, `\n`, `\t` and other bytes outside printable
//! ASCII as `\xHH`. Op event bits are derived from the opcode; the unit id is
//! recomputed.

use std::fmt::Write as _;

use bstr::BString;
use serde::{Deserialize, Serialize};

use super::{Cmd, CondIr, FuncIr, NodeInfo, Op, Opcode, RedirIr, SpawnIr, Unit, Word};
use crate::bash::ids::ModeId;

/// Malformed IR text.
#[derive(Debug, thiserror::Error)]
#[error("IR text line {line}: {what}")]
pub struct AsmError {
	/// 1-based line.
	pub line: usize,
	/// What is wrong.
	pub what: &'static str,
}

/// Side tables, as one postcard image.
#[derive(Serialize, Deserialize)]
struct Tables {
	aliases: Vec<(BString, BString)>,
	nodes:   Vec<NodeInfo>,
	words:   Vec<Word>,
	lists:   Vec<Vec<u32>>,
	cmds:    Vec<Cmd>,
	names:   Vec<BString>,
	strs:    Vec<BString>,
	redirs:  Vec<Vec<RedirIr>>,
	spawns:  Vec<SpawnIr>,
	pats:    Vec<Vec<u32>>,
	ariths:  Vec<BString>,
	conds:   Vec<CondIr>,
	funcs:   Vec<FuncIr>,
}

/// Render `unit` as IR text.
pub fn disasm(unit: &Unit) -> String {
	let mut out = String::new();
	let mode: &'static str = unit.mode.into();
	let _ = writeln!(out, "; unit {}", unit.id);
	let _ = writeln!(out, ".unit {mode} {}", unit.features);
	let _ = writeln!(out, ".source {}", quote(&unit.source));
	if unit.line != 1 {
		let _ = writeln!(out, ".line {}", unit.line);
	}
	if let Some(root) = unit.root {
		let _ = writeln!(out, ".root {root}");
	}
	let tables = Tables {
		aliases: unit.aliases.clone(),
		nodes:   unit.nodes.clone(),
		words:   unit.words.clone(),
		lists:   unit.lists.clone(),
		cmds:    unit.cmds.clone(),
		names:   unit.names.clone(),
		strs:    unit.strs.clone(),
		redirs:  unit.redirs.clone(),
		spawns:  unit.spawns.clone(),
		pats:    unit.pats.clone(),
		ariths:  unit.ariths.clone(),
		conds:   unit.conds.clone(),
		funcs:   unit.funcs.clone(),
	};
	let image = postcard::to_stdvec(&tables).expect("IR tables serialize");
	out.push_str(".tables ");
	for b in &image {
		let _ = write!(out, "{b:02x}");
	}
	out.push('\n');
	let mut comment = |what: &str, i: usize, v: &dyn std::fmt::Debug| {
		let _ = writeln!(out, "; {what} {i}: {v:?}");
	};
	for (i, w) in unit.words.iter().enumerate() {
		comment("word", i, &w.parts);
	}
	for (i, l) in unit.lists.iter().enumerate() {
		comment("list", i, l);
	}
	for (i, c) in unit.cmds.iter().enumerate() {
		comment("cmd", i, c);
	}
	for (i, n) in unit.names.iter().enumerate() {
		comment("name", i, n);
	}
	for (i, s) in unit.strs.iter().enumerate() {
		comment("str", i, s);
	}
	for (i, r) in unit.redirs.iter().enumerate() {
		comment("redirs", i, r);
	}
	for (i, s) in unit.spawns.iter().enumerate() {
		comment("spawn", i, s);
	}
	for (i, p) in unit.pats.iter().enumerate() {
		comment("pats", i, p);
	}
	for (i, a) in unit.ariths.iter().enumerate() {
		comment("arith", i, a);
	}
	for (i, c) in unit.conds.iter().enumerate() {
		comment("cond", i, c);
	}
	for (i, f) in unit.funcs.iter().enumerate() {
		comment("func", i, &f.name);
	}
	for (pc, op) in unit.ops.iter().enumerate() {
		let _ = write!(out, "{pc:04} {} a={} b={} @{}", op.code, op.a, op.b, op.node);
		for (flag, name) in [
			(Op::COND, " cond"),
			(Op::CONTEXT, " ctx"),
			(Op::SYNTAX, " syntax"),
			(Op::SELECT, " select"),
			(Op::CAT, " cat"),
			(Op::NEGATED, " negated"),
			(Op::MULTI, " multi"),
			(Op::DISOWN, " disown"),
		] {
			if op.flags & flag != 0 {
				out.push_str(name);
			}
		}
		out.push('\n');
	}
	out
}

/// Parse IR text into a unit (id recomputed).
pub fn asm(text: &str) -> Result<Unit, AsmError> {
	let mut unit = Unit::empty(b"", ModeId::Bash, 0);
	for (i, raw) in text.lines().enumerate() {
		let line = raw.split_once(';').map_or(raw, |(code, _)| code).trim();
		// `;` inside a `.source` string is not a comment.
		let line = if raw.trim_start().starts_with(".source") {
			raw.trim()
		} else {
			line
		};
		if line.is_empty() {
			continue;
		}
		let err = |what| AsmError { line: i + 1, what };
		let (head, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
		let rest = rest.trim();
		match head {
			".unit" => {
				let (mode, features) = rest
					.split_once(' ')
					.ok_or_else(|| err("expected MODE FEATURES"))?;
				unit.mode = mode.parse().map_err(|_| err("bad mode"))?;
				unit.features = features.trim().parse().map_err(|_| err("bad features"))?;
			},
			".source" => unit.source = unquote(rest).ok_or_else(|| err("bad string"))?.into(),
			".root" => unit.root = Some(rest.parse().map_err(|_| err("bad root"))?),
			".line" => unit.line = rest.parse().map_err(|_| err("bad line"))?,
			".tables" => {
				let bytes = unhex(rest).ok_or_else(|| err("bad hex"))?;
				let t: Tables = postcard::from_bytes(&bytes).map_err(|_| err("bad tables image"))?;
				unit.aliases = t.aliases;
				unit.nodes = t.nodes;
				unit.words = t.words;
				unit.lists = t.lists;
				unit.cmds = t.cmds;
				unit.names = t.names;
				unit.strs = t.strs;
				unit.redirs = t.redirs;
				unit.spawns = t.spawns;
				unit.pats = t.pats;
				unit.ariths = t.ariths;
				unit.conds = t.conds;
				unit.funcs = t.funcs;
			},
			pc => {
				let pc: usize = pc.parse().map_err(|_| err("unknown directive"))?;
				if pc != unit.ops.len() {
					return Err(err("ops out of order"));
				}
				let mut fields = rest.split_whitespace();
				let code: Opcode = fields
					.next()
					.and_then(|c| c.parse().ok())
					.ok_or_else(|| err("bad opcode"))?;
				let mut op = Op { code, flags: 0, ev: code.ev_bits(), a: 0, b: 0, node: 0 };
				for t in fields {
					let num = |v: &str| v.parse::<u32>().map_err(|_| err("bad operand"));
					if let Some(v) = t.strip_prefix("a=") {
						op.a = num(v)?;
					} else if let Some(v) = t.strip_prefix("b=") {
						op.b = num(v)?;
					} else if let Some(v) = t.strip_prefix('@') {
						op.node = num(v)?;
					} else {
						op.flags |= match t {
							"cond" => Op::COND,
							"ctx" => Op::CONTEXT,
							"syntax" => Op::SYNTAX,
							"select" => Op::SELECT,
							"cat" => Op::CAT,
							"negated" => Op::NEGATED,
							"multi" => Op::MULTI,
							"disown" => Op::DISOWN,
							_ => return Err(err("bad op field")),
						};
					}
				}
				unit.ops.push(op);
			},
		}
	}
	unit.seal();
	Ok(unit)
}

fn unhex(s: &str) -> Option<Vec<u8>> {
	let (pairs, rest) = s.as_bytes().as_chunks::<2>();
	if !rest.is_empty() {
		return None;
	}
	pairs
		.iter()
		.map(|p| u8::from_str_radix(std::str::from_utf8(p).ok()?, 16).ok())
		.collect()
}

/// `"…"` with escapes → bytes.
fn unquote(t: &str) -> Option<Vec<u8>> {
	let body = t.strip_prefix('"')?.strip_suffix('"')?.as_bytes();
	let mut out = Vec::with_capacity(body.len());
	let mut i = 0;
	while i < body.len() {
		let c = body[i];
		if c != b'\\' {
			out.push(c);
			i += 1;
			continue;
		}
		match *body.get(i + 1)? {
			b'n' => out.push(b'\n'),
			b't' => out.push(b'\t'),
			b'x' => {
				let hex = std::str::from_utf8(body.get(i + 2..i + 4)?).ok()?;
				out.push(u8::from_str_radix(hex, 16).ok()?);
				i += 2;
			},
			c => out.push(c),
		}
		i += 2;
	}
	Some(out)
}

/// Bytes → `"…"` with escapes.
fn quote(b: &[u8]) -> String {
	let mut s = String::with_capacity(b.len() + 2);
	s.push('"');
	for &c in b {
		match c {
			b'"' => s.push_str("\\\""),
			b'\\' => s.push_str("\\\\"),
			b'\n' => s.push_str("\\n"),
			b'\t' => s.push_str("\\t"),
			0x20..=0x7e => s.push(c as char),
			_ => {
				let _ = write!(s, "\\x{c:02x}");
			},
		}
	}
	s.push('"');
	s
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::{
		ir::compile,
		syntax::{Features, NO_ALIASES, Parser},
	};

	fn unit(src: &[u8]) -> Unit {
		let cc = Parser::new(src, Features::NONE, NO_ALIASES)
			.next_command()
			.unwrap()
			.unwrap();
		compile(&cc, src, ModeId::Bash, Features::NONE)
	}

	#[test]
	fn disasm_asm_round_trips_every_table() {
		let srcs: [&[u8]; 4] = [
			b"a=1 b+=\"$x\" echo 'q' \"$@\" $1 $? $- \\\" x > f 2>&1; for i in 1 \"\"; do while ! true; do :; done; done",
			b"if a && b || c; then d; elif e; then f; else g; fi",
			b"f() { case $1 in a|b) echo $(x | y);; *) [[ -n $x ]];; esac; }; (( i++ )) &",
			b"for ((i=0; i<3; i++)); do cat <<EOF\nhi $i\nEOF\ndone",
		];
		for src in srcs {
			let u = unit(src);
			let text = disasm(&u);
			let back = asm(&text).unwrap_or_else(|e| panic!("{e}\n{text}"));
			assert_eq!(back, u, "{text}");
		}
	}

	#[test]
	fn quoting_survives_arbitrary_bytes() {
		let bytes: Vec<u8> = (0..=255).collect();
		assert_eq!(unquote(&quote(&bytes)).unwrap(), bytes);
	}

	#[test]
	fn malformed_text_names_the_line() {
		let e = asm(".unit bash 0\n0000 Bogus a=0 b=0 @0\n").unwrap_err();
		assert_eq!(e.line, 2);
		let e = asm(".unit bash 0\n0001 End a=0 b=0 @0\n").unwrap_err();
		assert_eq!(e.what, "ops out of order");
		assert_eq!(asm(".tables 0g\n").unwrap_err().what, "bad hex");
	}
}
