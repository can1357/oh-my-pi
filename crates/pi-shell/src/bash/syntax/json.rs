//! JSON export (see [`to_json`](crate::bash::syntax::to_json) for the schemas).

use alloc::{string::String, vec, vec::Vec};

use crate::bash::syntax::{
	JsonDialect, Offsets,
	ast::*,
	parser::{TextMode, parse_text},
	span::Span,
};

// ---- value tree and writer
// ----------------------------------------------------

enum V {
	Null,
	Bool(bool),
	Num(u64),
	Str(Vec<u8>),
	Arr(Vec<Self>),
	Obj(Vec<(&'static str, Self)>),
}

fn s(b: &[u8]) -> V {
	V::Str(b.to_vec())
}

fn write_str(out: &mut String, b: &[u8]) {
	out.push('"');
	for ch in String::from_utf8_lossy(b).chars() {
		match ch {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			'\u{8}' => out.push_str("\\b"),
			'\u{c}' => out.push_str("\\f"),
			'\u{2028}' => out.push_str("\\u2028"),
			'\u{2029}' => out.push_str("\\u2029"),
			c if (c as u32) < 0x20 || c == '\u{7f}' => {
				const HEX: &[u8; 16] = b"0123456789abcdef";
				let n = c as u32;
				out.push_str("\\u00");
				out.push(HEX[(n >> 4) as usize] as char);
				out.push(HEX[(n & 0xf) as usize] as char);
			},
			c => out.push(c),
		}
	}
	out.push('"');
}

fn write_num(out: &mut String, n: u64) {
	out.push_str(n.format_into(&mut core::fmt::NumBuffer::new()));
}

fn write(out: &mut String, v: &V, pretty: bool, depth: usize) {
	let nl = |out: &mut String, d: usize| {
		if pretty {
			out.push('\n');
			for _ in 0..d {
				out.push('\t');
			}
		}
	};
	match v {
		V::Null => out.push_str("null"),
		V::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
		V::Num(n) => write_num(out, *n),
		V::Str(b) => write_str(out, b),
		V::Arr(items) => {
			out.push('[');
			for (i, it) in items.iter().enumerate() {
				if i > 0 {
					out.push(',');
				}
				nl(out, depth + 1);
				write(out, it, pretty, depth + 1);
			}
			if !items.is_empty() {
				nl(out, depth);
			}
			out.push(']');
		},
		V::Obj(fields) => {
			out.push('{');
			for (i, (k, it)) in fields.iter().enumerate() {
				if i > 0 {
					out.push(',');
				}
				nl(out, depth + 1);
				write_str(out, k.as_bytes());
				out.push(':');
				if pretty {
					out.push(' ');
				}
				write(out, it, pretty, depth + 1);
			}
			if !fields.is_empty() {
				nl(out, depth);
			}
			out.push('}');
		},
	}
}

/// Serialize a program as JSON.
///
/// `src` is the source the program was parsed from (offsets, line/column
/// numbers and shfmt's literal values come from it).
///
/// # Native schema
///
/// Compact JSON. Spans are `[lo, hi]` offsets (bytes or UTF-16 units, see
/// [`Offsets`](crate::bash::syntax::Offsets)); every node that has a
/// [`NodeId`](crate::bash::syntax::NodeId) carries `"id"`. Field names follow
/// the Rust AST:
///
/// ```text
/// {"commands":[{"span":[lo,hi],"line":N,"node_count":N,
///   "aliases":[{"name":S,"value":S}],"warnings":[{"line":N,"msg":S}],
///   "list":LIST}]}
/// LIST  = [{"sep":";"|"&"|"&|"|"\n"|"","and_or":ANDOR}]
/// ANDOR = {"id","span","first":PIPE,"rest":[{"op":"&&"|"||","pipeline":PIPE}]}
/// PIPE  = {"id","span","bang":B,"time":null|{"posix":B},"stages":[{"pipe_stderr":B,"cmd":CMD}]}
/// CMD   = {"id","span","type":T, …fields of the kind…, "redirs":[REDIR]}
///   T = simple{assigns,words} | brace{body} | subshell{body} | if{arms:[{cond,body}],else}
///     | while{until,cond,body} | for{var,[extra_vars],var_span,words,body} | select{…}
///     | arith_for{init,cond,step,body} | case{word,arms:[{patterns,body,term}]}
///     | arith{expr} | cond{expr} | function{name,[extra_names],keyword,body}
///     | coproc{name,body} | repeat{count,body} | try{body,always} | anon_func{body,args}
///   (`extra_vars`/`extra_names`: zsh, present only when non-empty)
/// REDIR = {"span","fd":null|N|"{var}","op":OP,"target":WORD|{"heredoc":{delim,delim_raw,quoted,text}}}
/// ASSIGN= {"id","span","name","index":WORD|null,"append":B,"value":WORD|{"array":[ELEM]}}
/// ELEM  = {"key":WORD|null,"append":B,"value":WORD}
/// ARITH = {"span","src":S}
/// COND  = {"type":"unary"|"binary"|"word"|"not"|"and"|"or"|"group", …}
/// WORD  = {"id","span","parts":[PART]}
/// PART  = {"type":"lit"|"escaped"|"squote"|"ansic"|"bad_subst","value":S}
///       | {"type":"dquote"|"locale","parts":[PART]}
///       | {"type":"param","name":S,"name_kind":"var"|"positional"|"special","braced":B,
///          "indirect":B,"index":null|"@"|"*"|WORD,"op":{"type":…}}
///       | {"type":"comsub","kind":"dollar"|"backtick"|"nofork"|"valuesub","text":S,"body":LIST}
///       | {"type":"arith","expr":ARITH} | {"type":"procsub","output":B,"body":LIST}
///       | {"type":"compound","elems":[ELEM]}
///       | {"type":"zsh","text":S}   (zsh word, untokenized and unmetafied)
/// ```
///
/// Strings are the bytes as UTF-8 with invalid sequences replaced by U+FFFD.
///
/// # shfmt schema
///
/// The JSON `shfmt --ln=bash --to-json` writes (mvdan.cc/sh v3 `syntax`
/// nodes, `Pos` objects with `Offset`/`Line`/`Col`, tab-indented), as
/// consumed by bash-viz. Arithmetic expressions are emitted as a single
/// `Word` leaf holding the expression text rather than shfmt's operator
/// tree, comments are not emitted, and extglob groups stay inside `Lit`.
/// zsh words are `Lit` leaves holding their source text; zsh-only commands
/// use node types shfmt lacks (`RepeatClause`, `TryClause`, `AnonFuncDecl`),
/// `&|` sets `Background` and `Disown`, and extra loop variables or function
/// names are listed in `ExtraNames`.
pub fn to_json(src: &[u8], program: &Program, dialect: JsonDialect, offsets: Offsets) -> String {
	let map = OffMap::new(src, offsets);
	let mut out = String::new();
	match dialect {
		JsonDialect::Native => {
			let v = native::program(&map, program);
			write(&mut out, &v, false, 0);
		},
		JsonDialect::Shfmt => {
			let v = shfmt::program(&map, src, program);
			write(&mut out, &v, true, 0);
			out.push('\n');
		},
	}
	out
}

/// Offset conversion and line/column lookup.
struct OffMap {
	line_starts: Vec<u32>,
	utf16:       Option<Vec<u32>>,
	len:         u32,
}

impl OffMap {
	fn new(src: &[u8], offsets: Offsets) -> Self {
		let mut line_starts = vec![0u32];
		for (i, &c) in src.iter().enumerate() {
			if c == b'\n' {
				line_starts.push(i as u32 + 1);
			}
		}
		let utf16 = (offsets == Offsets::Utf16).then(|| {
			let mut m = Vec::with_capacity(src.len() + 1);
			let mut u = 0u32;
			for &c in src {
				m.push(u);
				match c {
					0x80..=0xbf => {},
					0xf0..=0xf7 => u += 2,
					_ => u += 1,
				}
			}
			m.push(u);
			m
		});
		Self { line_starts, utf16, len: src.len() as u32 }
	}

	fn off(&self, o: u32) -> u64 {
		let o = o.min(self.len);
		match &self.utf16 {
			Some(m) => u64::from(m[o as usize]),
			None => u64::from(o),
		}
	}

	fn num(&self, o: u32) -> V {
		V::Num(self.off(o))
	}

	fn span(&self, sp: Span) -> V {
		V::Arr(vec![self.num(sp.lo), self.num(sp.hi)])
	}

	/// shfmt `Pos`.
	fn pos(&self, o: u32) -> V {
		let o = o.min(self.len);
		let line = self.line_starts.partition_point(|&s| s <= o);
		let start = self.line_starts[line - 1];
		V::Obj(vec![
			("Offset", self.num(o)),
			("Line", V::Num(line as u64)),
			("Col", V::Num(self.off(o) - self.off(start) + 1)),
		])
	}
}

// ---- native
// ---------------------------------------------------------------------

mod native {
	use super::*;

	pub(super) fn program(m: &OffMap, p: &Program) -> V {
		let cmds = p
			.commands
			.iter()
			.map(|cc| {
				V::Obj(vec![
					("span", m.span(cc.span)),
					("line", V::Num(u64::from(cc.line))),
					("node_count", V::Num(u64::from(cc.node_count))),
					(
						"aliases",
						V::Arr(
							cc.aliases
								.iter()
								.map(|a| V::Obj(vec![("name", s(&a.name)), ("value", s(&a.value))]))
								.collect(),
						),
					),
					(
						"warnings",
						V::Arr(
							cc.warnings
								.iter()
								.map(|w| {
									V::Obj(vec![
										("line", V::Num(u64::from(w.line))),
										("msg", s(&w.bash_msg)),
									])
								})
								.collect(),
						),
					),
					("list", list(m, &cc.list)),
				])
			})
			.collect();
		V::Obj(vec![("commands", V::Arr(cmds))])
	}

	fn list(m: &OffMap, l: &List) -> V {
		V::Arr(
			l.items
				.iter()
				.map(|it| {
					let sep: &[u8] = match it.sep {
						Sep::Semi => b";",
						Sep::Amp => b"&",
						Sep::Disown => b"&|",
						Sep::Newline => b"\n",
						Sep::None => b"",
					};
					V::Obj(vec![("sep", s(sep)), ("and_or", and_or(m, &it.and_or))])
				})
				.collect(),
		)
	}

	fn id(n: crate::bash::syntax::span::NodeId) -> V {
		V::Num(u64::from(n.0))
	}

	fn and_or(m: &OffMap, ao: &AndOr) -> V {
		let rest = ao
			.rest
			.iter()
			.map(|(op, p)| {
				let op: &[u8] = if *op == AndOrOp::And { b"&&" } else { b"||" };
				V::Obj(vec![("op", s(op)), ("pipeline", pipeline(m, p))])
			})
			.collect();
		V::Obj(vec![
			("id", id(ao.id)),
			("span", m.span(ao.span)),
			("first", pipeline(m, &ao.first)),
			("rest", V::Arr(rest)),
		])
	}

	fn pipeline(m: &OffMap, p: &Pipeline) -> V {
		let time = match p.time {
			Some(t) => V::Obj(vec![("posix", V::Bool(t.posix))]),
			None => V::Null,
		};
		let stages = p
			.stages
			.iter()
			.map(|st| {
				V::Obj(vec![("pipe_stderr", V::Bool(st.pipe_stderr)), ("cmd", command(m, &st.cmd))])
			})
			.collect();
		V::Obj(vec![
			("id", id(p.id)),
			("span", m.span(p.span)),
			("bang", V::Bool(p.bang)),
			("time", time),
			("stages", V::Arr(stages)),
		])
	}

	fn opt_list(m: &OffMap, l: Option<&List>) -> V {
		l.map_or(V::Null, |l| list(m, l))
	}

	fn words(m: &OffMap, ws: &[Word]) -> V {
		V::Arr(ws.iter().map(|w| word(m, w)).collect())
	}

	fn arith(m: &OffMap, a: &ArithText) -> V {
		V::Obj(vec![("span", m.span(a.span)), ("src", s(&a.src))])
	}

	fn command(m: &OffMap, c: &Command) -> V {
		let mut f: Vec<(&'static str, V)> = vec![("id", id(c.id)), ("span", m.span(c.span))];
		let ty: &[u8] = match &c.kind {
			CommandKind::Simple(sc) => {
				f.push(("assigns", V::Arr(sc.assigns.iter().map(|a| assign(m, a)).collect())));
				f.push(("words", words(m, &sc.words)));
				b"simple"
			},
			CommandKind::Brace(l) => {
				f.push(("body", list(m, l)));
				b"brace"
			},
			CommandKind::Subshell(l) => {
				f.push(("body", list(m, l)));
				b"subshell"
			},
			CommandKind::If(i) => {
				let arms = i
					.arms
					.iter()
					.map(|a| V::Obj(vec![("cond", list(m, &a.cond)), ("body", list(m, &a.body))]))
					.collect();
				f.push(("arms", V::Arr(arms)));
				f.push(("else", opt_list(m, i.else_body.as_ref())));
				b"if"
			},
			CommandKind::While(w) => {
				f.push(("until", V::Bool(w.until)));
				f.push(("cond", list(m, &w.cond)));
				f.push(("body", list(m, &w.body)));
				b"while"
			},
			CommandKind::For(fr) | CommandKind::Select(fr) => {
				f.push(("var", s(&fr.var)));
				if !fr.extra_vars.is_empty() {
					f.push(("extra_vars", V::Arr(fr.extra_vars.iter().map(|v| s(v)).collect())));
				}
				f.push(("var_span", m.span(fr.var_span)));
				f.push(("words", fr.words.as_ref().map_or(V::Null, |w| words(m, w))));
				f.push(("body", list(m, &fr.body)));
				if matches!(c.kind, CommandKind::For(_)) {
					b"for"
				} else {
					b"select"
				}
			},
			CommandKind::ArithFor(a) => {
				f.push(("init", arith(m, &a.init)));
				f.push(("cond", arith(m, &a.cond)));
				f.push(("step", arith(m, &a.step)));
				f.push(("body", list(m, &a.body)));
				b"arith_for"
			},
			CommandKind::Case(cs) => {
				f.push(("word", word(m, &cs.word)));
				let arms = cs
					.arms
					.iter()
					.map(|a| {
						let term: &[u8] = match a.term {
							CaseTerm::Break => b";;",
							CaseTerm::FallThrough => b";&",
							CaseTerm::Continue => b";;&",
						};
						V::Obj(vec![
							("patterns", words(m, &a.patterns)),
							("body", list(m, &a.body)),
							("term", s(term)),
						])
					})
					.collect();
				f.push(("arms", V::Arr(arms)));
				b"case"
			},
			CommandKind::Arith(a) => {
				f.push(("expr", arith(m, a)));
				b"arith"
			},
			CommandKind::Cond(e) => {
				f.push(("expr", cond(m, e)));
				b"cond"
			},
			CommandKind::FuncDef(fd) => {
				f.push(("name", s(&fd.name)));
				if !fd.extra_names.is_empty() {
					f.push(("extra_names", V::Arr(fd.extra_names.iter().map(|n| s(n)).collect())));
				}
				f.push(("keyword", V::Bool(fd.keyword)));
				f.push(("body", command(m, &fd.body)));
				b"function"
			},
			CommandKind::Coproc(cp) => {
				f.push(("name", cp.name.as_ref().map_or(V::Null, |n| s(n))));
				f.push(("body", command(m, &cp.body)));
				b"coproc"
			},
			CommandKind::Repeat(r) => {
				f.push(("count", word(m, &r.count)));
				f.push(("body", list(m, &r.body)));
				b"repeat"
			},
			CommandKind::Try(t) => {
				f.push(("body", list(m, &t.body)));
				f.push(("always", list(m, &t.always)));
				b"try"
			},
			CommandKind::AnonFunc(a) => {
				f.push(("body", command(m, &a.body)));
				f.push(("args", words(m, &a.args)));
				b"anon_func"
			},
		};
		f.insert(2, ("type", s(ty)));
		f.push(("redirs", V::Arr(c.redirs.iter().map(|r| redir(m, r)).collect())));
		V::Obj(f)
	}

	fn redir(m: &OffMap, r: &Redir) -> V {
		let fd = match &r.fd {
			None => V::Null,
			Some(RedirFd::Num(n)) => V::Num(u64::from(*n)),
			Some(RedirFd::Var(v)) => {
				let mut t = b"{".to_vec();
				t.extend_from_slice(v);
				t.push(b'}');
				V::Str(t)
			},
		};
		let target = match &r.target {
			RedirTarget::Word(w) => word(m, w),
			RedirTarget::HereDoc(d) => V::Obj(vec![(
				"heredoc",
				V::Obj(vec![
					("delim", s(&d.delim)),
					("delim_raw", s(&d.delim_raw)),
					("quoted", V::Bool(d.quoted)),
					("text", s(&d.text)),
				]),
			)]),
		};
		V::Obj(vec![
			("span", m.span(r.span)),
			("fd", fd),
			("op", s(super::redir_op(r.op))),
			("target", target),
		])
	}

	fn assign(m: &OffMap, a: &Assign) -> V {
		let value = match &a.value {
			AssignValue::Scalar(w) => word(m, w),
			AssignValue::Array(e) => V::Obj(vec![("array", elems(m, e))]),
		};
		V::Obj(vec![
			("id", id(a.id)),
			("span", m.span(a.span)),
			("name", s(&a.name)),
			("index", a.index.as_ref().map_or(V::Null, |w| word(m, w))),
			("append", V::Bool(a.append)),
			("value", value),
		])
	}

	fn elems(m: &OffMap, e: &[ArrayElem]) -> V {
		V::Arr(
			e.iter()
				.map(|el| {
					V::Obj(vec![
						("key", el.key.as_ref().map_or(V::Null, |w| word(m, w))),
						("append", V::Bool(el.append)),
						("value", word(m, &el.value)),
					])
				})
				.collect(),
		)
	}

	fn cond(m: &OffMap, e: &CondExpr) -> V {
		match e {
			CondExpr::Unary { op, arg } => {
				V::Obj(vec![("type", s(b"unary")), ("op", s(op)), ("arg", word(m, arg))])
			},
			CondExpr::Binary { op, lhs, rhs } => V::Obj(vec![
				("type", s(b"binary")),
				("op", s(op)),
				("lhs", word(m, lhs)),
				("rhs", word(m, rhs)),
			]),
			CondExpr::Word(w) => V::Obj(vec![("type", s(b"word")), ("word", word(m, w))]),
			CondExpr::Not(x) => V::Obj(vec![("type", s(b"not")), ("expr", cond(m, x))]),
			CondExpr::Group(x) => V::Obj(vec![("type", s(b"group")), ("expr", cond(m, x))]),
			CondExpr::And(a, b) => {
				V::Obj(vec![("type", s(b"and")), ("lhs", cond(m, a)), ("rhs", cond(m, b))])
			},
			CondExpr::Or(a, b) => {
				V::Obj(vec![("type", s(b"or")), ("lhs", cond(m, a)), ("rhs", cond(m, b))])
			},
		}
	}

	pub(super) fn word(m: &OffMap, w: &Word) -> V {
		V::Obj(vec![("id", id(w.id)), ("span", m.span(w.span)), ("parts", parts(m, &w.parts))])
	}

	fn parts(m: &OffMap, ps: &[WordPart]) -> V {
		V::Arr(ps.iter().map(|p| part(m, p)).collect())
	}

	fn tv(t: &[u8], v: &[u8]) -> V {
		V::Obj(vec![("type", s(t)), ("value", s(v))])
	}

	fn part(m: &OffMap, p: &WordPart) -> V {
		match p {
			WordPart::Lit(v) => tv(b"lit", v),
			WordPart::Escaped(v) => tv(b"escaped", v),
			WordPart::SQuote(v) => tv(b"squote", v),
			WordPart::AnsiC(v) => tv(b"ansic", v),
			WordPart::BadSubst(v) => tv(b"bad_subst", v),
			WordPart::BadComsub(b) => tv(b"bad_comsub", &b.text),
			WordPart::DroppedQuote => tv(b"dropped_quote", b"\""),
			WordPart::DQuote(inner) => {
				V::Obj(vec![("type", s(b"dquote")), ("parts", parts(m, inner))])
			},
			WordPart::Locale(inner) => {
				V::Obj(vec![("type", s(b"locale")), ("parts", parts(m, inner))])
			},
			WordPart::Param(pp) => param(m, pp),
			WordPart::Comsub(c) => {
				let kind: &[u8] = match c.kind {
					ComsubKind::Dollar => b"dollar",
					ComsubKind::Backtick => b"backtick",
					ComsubKind::NoFork => b"nofork",
					ComsubKind::ValueSub => b"valuesub",
				};
				V::Obj(vec![
					("type", s(b"comsub")),
					("kind", s(kind)),
					("text", s(&c.text)),
					("body", list(m, &c.body)),
				])
			},
			WordPart::Arith(a) => V::Obj(vec![("type", s(b"arith")), ("expr", arith(m, a))]),
			WordPart::ProcSub(ps) => V::Obj(vec![
				("type", s(b"procsub")),
				("output", V::Bool(ps.output)),
				("body", list(m, &ps.body)),
			]),
			WordPart::Compound(e) => V::Obj(vec![("type", s(b"compound")), ("elems", elems(m, e))]),
			WordPart::Zsh(raw) => {
				let mut text = Vec::new();
				crate::bash::syntax::print::zsh_text(raw, &mut text);
				V::Obj(vec![("type", s(b"zsh")), ("text", V::Str(text))])
			},
		}
	}

	fn param(m: &OffMap, p: &Param) -> V {
		let (name, kind): (Vec<u8>, &[u8]) = match &p.name {
			ParamName::Var(v) => (v.clone(), b"var"),
			ParamName::Positional(n) => {
				let mut t = Vec::new();
				crate::bash::syntax::util::push_u32(&mut t, *n);
				(t, b"positional")
			},
			ParamName::Special(sp) => (vec![super::special_char(*sp)], b"special"),
		};
		let index = match &p.index {
			None => V::Null,
			Some(Subscript::At) => s(b"@"),
			Some(Subscript::Star) => s(b"*"),
			Some(Subscript::Expr(w)) => word(m, w),
		};
		let ow = |t: &[u8], colon: bool, w: Option<&Word>| {
			V::Obj(vec![
				("type", s(t)),
				("colon", V::Bool(colon)),
				("word", w.map_or(V::Null, |w| word(m, w))),
			])
		};
		let op = match &p.op {
			ParamOp::None => V::Obj(vec![("type", s(b"none"))]),
			ParamOp::Length => V::Obj(vec![("type", s(b"length"))]),
			ParamOp::Indirect => V::Obj(vec![("type", s(b"indirect"))]),
			ParamOp::PrefixNames { star } => {
				V::Obj(vec![("type", s(b"prefix_names")), ("star", V::Bool(*star))])
			},
			ParamOp::Default { colon, word } => ow(b"default", *colon, Some(word)),
			ParamOp::Assign { colon, word } => ow(b"assign", *colon, Some(word)),
			ParamOp::Error { colon, word } => ow(b"error", *colon, word.as_ref()),
			ParamOp::Alt { colon, word } => ow(b"alt", *colon, Some(word)),
			ParamOp::Substr { offset, len } => V::Obj(vec![
				("type", s(b"substr")),
				("offset", arith(m, offset)),
				("len", len.as_ref().map_or(V::Null, |l| arith(m, l))),
			]),
			ParamOp::Trim { suffix, longest, pat } => V::Obj(vec![
				("type", s(b"trim")),
				("suffix", V::Bool(*suffix)),
				("longest", V::Bool(*longest)),
				("pat", word(m, pat)),
			]),
			ParamOp::Replace { mode, pat, rep } => {
				let mode: &[u8] = match mode {
					ReplaceMode::First => b"first",
					ReplaceMode::All => b"all",
					ReplaceMode::Prefix => b"prefix",
					ReplaceMode::Suffix => b"suffix",
				};
				V::Obj(vec![
					("type", s(b"replace")),
					("mode", s(mode)),
					("pat", word(m, pat)),
					("rep", rep.as_ref().map_or(V::Null, |w| word(m, w))),
				])
			},
			ParamOp::Case { mode, all, pat } => {
				let mode: &[u8] = match mode {
					CaseMode::Upper => b"upper",
					CaseMode::Lower => b"lower",
					CaseMode::Toggle => b"toggle",
				};
				V::Obj(vec![
					("type", s(b"case")),
					("mode", s(mode)),
					("all", V::Bool(*all)),
					("pat", pat.as_ref().map_or(V::Null, |w| word(m, w))),
				])
			},
			ParamOp::Transform(c) => V::Obj(vec![("type", s(b"transform")), ("op", s(&[*c]))]),
		};
		V::Obj(vec![
			("type", s(b"param")),
			("name", V::Str(name)),
			("name_kind", s(kind)),
			("braced", V::Bool(p.braced)),
			("indirect", V::Bool(p.indirect)),
			("index", index),
			("op", op),
		])
	}
}

const fn redir_op(op: RedirOp) -> &'static [u8] {
	match op {
		RedirOp::In => b"<",
		RedirOp::Out => b">",
		RedirOp::Append => b">>",
		RedirOp::Clobber => b">|",
		RedirOp::AppendClobber => b">>|",
		RedirOp::OutErrClobber => b"&>|",
		RedirOp::AppendErrClobber => b"&>>|",
		RedirOp::ReadWrite => b"<>",
		RedirOp::DupIn => b"<&",
		RedirOp::DupOut => b">&",
		RedirOp::OutErr => b"&>",
		RedirOp::AppendErr => b"&>>",
		RedirOp::HereDoc { strip_tabs: false } => b"<<",
		RedirOp::HereDoc { strip_tabs: true } => b"<<-",
		RedirOp::HereString => b"<<<",
	}
}

const fn special_char(sp: Special) -> u8 {
	match sp {
		Special::At => b'@',
		Special::Star => b'*',
		Special::Count => b'#',
		Special::Status => b'?',
		Special::Flags => b'-',
		Special::ShellPid => b'$',
		Special::LastBg => b'!',
	}
}

// ---- shfmt
// ------------------------------------------------------------------------

mod shfmt {
	use super::*;

	/// Source scanning helpers.
	struct Ctx<'a> {
		m:   &'a OffMap,
		src: &'a [u8],
	}

	/// A statement being assembled.
	struct St {
		pos:     u32,
		end:     u32,
		cmd:     Option<V>,
		negated: bool,
		redirs:  Vec<V>,
		/// End of the last redirection (bytes).
		rend:    u32,
		semi:    Option<u32>,
		bg:      bool,
	}

	/// shfmt `Stmt.End`: after the `;`/`&` if any, else the end of the
	/// command or of its last redirection (a here-document's delimiter).
	fn stmt_end(st: &St) -> u32 {
		match st.semi {
			Some(sm) => sm + 1,
			None if st.redirs.is_empty() => st.end,
			None => st.end.max(st.rend),
		}
	}

	pub(super) fn program(map: &OffMap, src: &[u8], prog: &Program) -> V {
		let ctx = Ctx { m: map, src };
		let mut stmts = Vec::new();
		let mut floor = 0;
		for unit in &prog.commands {
			for item in &unit.list.items {
				let (v, end) = ctx.item(item, floor);
				stmts.push(v);
				floor = end;
			}
		}
		let (pos, end) = match (prog.commands.first(), prog.commands.last()) {
			(Some(a), Some(b)) => (a.span.lo, b.span.hi),
			_ => (0, 0),
		};
		let mut f = vec![("Type", s(b"File"))];
		if !stmts.is_empty() {
			f.push(("Pos", map.pos(pos)));
			f.push(("End", map.pos(end)));
			f.push(("Stmts", V::Arr(stmts)));
		}
		V::Obj(f)
	}

	impl Ctx<'_> {
		fn at(&self, i: u32) -> u8 {
			self.src.get(i as usize).copied().unwrap_or(0)
		}

		/// Skip blanks, newlines, `\newline` and comments from `i`.
		fn skip_ws(&self, mut i: u32) -> u32 {
			loop {
				match self.at(i) {
					b' ' | b'\t' | b'\n' => i += 1,
					b'\\' if self.at(i + 1) == b'\n' => i += 2,
					b'#' => {
						while (i as usize) < self.src.len() && self.at(i) != b'\n' {
							i += 1;
						}
					},
					_ => return i,
				}
			}
		}

		/// Position of `kw` at or after `i` (skipping blanks, comments,
		/// separators); `i` when not found.
		fn find(&self, i: u32, kw: &[u8]) -> u32 {
			let mut j = i;
			loop {
				j = self.skip_ws(j);
				if self
					.src
					.get(j as usize..)
					.is_some_and(|r| r.starts_with(kw))
				{
					return j;
				}
				match self.at(j) {
					b';' | b'&' => j += 1,
					_ => return i,
				}
			}
		}

		/// End of the token text that ends right before `hi`, trimming blanks.
		fn trim_back(&self, lo: u32, mut hi: u32) -> u32 {
			while hi > lo && matches!(self.at(hi - 1), b' ' | b'\t' | b'\n') {
				hi -= 1;
			}
			hi
		}

		fn lit(&self, lo: u32, hi: u32, typed: bool) -> V {
			let mut f = Vec::new();
			if typed {
				f.push(("Type", s(b"Lit")));
			}
			f.push(("Pos", self.m.pos(lo)));
			f.push(("End", self.m.pos(hi)));
			f.push(("ValuePos", self.m.pos(lo)));
			f.push(("ValueEnd", self.m.pos(hi)));
			f.push(("Value", s(self.src.get(lo as usize..hi as usize).unwrap_or_default())));
			V::Obj(f)
		}

		fn lit_value(&self, lo: u32, hi: u32, value: &[u8]) -> V {
			V::Obj(vec![
				("Pos", self.m.pos(lo)),
				("End", self.m.pos(hi)),
				("ValuePos", self.m.pos(lo)),
				("ValueEnd", self.m.pos(hi)),
				("Value", s(value)),
			])
		}

		fn stmt(&self, st: St) -> V {
			let end = stmt_end(&st);
			let mut f = vec![("Pos", self.m.pos(st.pos)), ("End", self.m.pos(end))];
			if let Some(c) = st.cmd {
				f.push(("Cmd", c));
			}
			f.push(("Position", self.m.pos(st.pos)));
			if let Some(sm) = st.semi {
				f.push(("Semicolon", self.m.pos(sm)));
			}
			if st.negated {
				f.push(("Negated", V::Bool(true)));
			}
			if st.bg {
				f.push(("Background", V::Bool(true)));
			}
			if !st.redirs.is_empty() {
				f.push(("Redirs", V::Arr(st.redirs)));
			}
			V::Obj(f)
		}

		/// One list item as a `Stmt`, with the comments shfmt attaches to it
		/// (comment lines since `floor`, the previous statement's end, and
		/// a comment after it on the same line); also returns its end.
		fn item(&self, it: &ListItem, floor: u32) -> (V, u32) {
			let mut st = self.and_or(&it.and_or);
			match it.sep {
				Sep::Semi | Sep::Amp => {
					let ch: &[u8] = if it.sep == Sep::Semi { b";" } else { b"&" };
					let at = self.find(it.and_or.span.hi, ch);
					if self.at(at) == ch[0] {
						st.semi = Some(at);
					}
					st.bg = it.sep == Sep::Amp;
				},
				Sep::Disown => {
					let at = self.find(it.and_or.span.hi, b"&");
					if self.at(at) == b'&' {
						st.semi = Some(at);
					}
					st.bg = true;
				},
				Sep::Newline | Sep::None => {},
			}
			let end = stmt_end(&st);
			let mut comments = self.comments_before(st.pos, floor);
			comments.extend(self.comment_after(end));
			let mut v = self.stmt(st);
			if it.sep == Sep::Disown
				&& let V::Obj(f) = &mut v
			{
				let at = f
					.iter()
					.position(|(k, _)| *k == "Background")
					.map_or(f.len(), |i| i + 1);
				f.insert(at, ("Disown", V::Bool(true)));
			}
			if !comments.is_empty()
				&& let V::Obj(f) = &mut v
			{
				f.insert(2, ("Comments", V::Arr(comments)));
			}
			(v, end)
		}

		fn list(&self, l: &List) -> V {
			let mut floor = 0;
			let mut out = Vec::with_capacity(l.items.len());
			for it in &l.items {
				let (v, end) = self.item(it, floor);
				out.push(v);
				floor = end;
			}
			V::Arr(out)
		}

		/// A shfmt `Comment` for the `#` at `hash`, running to the end of the
		/// line.
		fn comment(&self, hash: u32) -> V {
			let mut end = hash as usize;
			while end < self.src.len() && self.src[end] != b'\n' {
				end += 1;
			}
			V::Obj(vec![
				("Pos", self.m.pos(hash)),
				("End", self.m.pos(end as u32)),
				("Hash", self.m.pos(hash)),
				("Text", s(&self.src[hash as usize + 1..end])),
			])
		}

		/// Comment lines directly above a statement that starts its line,
		/// back to `floor` (blank lines between them are skipped).
		fn comments_before(&self, pos: u32, floor: u32) -> Vec<V> {
			let src = self.src;
			let pos = (pos as usize).min(src.len());
			let mut start = src[..pos]
				.iter()
				.rposition(|&c| c == b'\n')
				.map_or(0, |i| i + 1);
			if src[start..pos].iter().any(|&c| !matches!(c, b' ' | b'\t')) {
				return Vec::new();
			}
			let mut found = Vec::new();
			while start > floor as usize && start > 0 {
				let line_end = start - 1;
				let line_start = src[..line_end]
					.iter()
					.rposition(|&c| c == b'\n')
					.map_or(0, |i| i + 1);
				if line_start < floor as usize {
					break;
				}
				let line = &src[line_start..line_end];
				let indent = line
					.iter()
					.take_while(|&&c| matches!(c, b' ' | b'\t'))
					.count();
				match line.get(indent) {
					None => {},
					Some(b'#') => found.push(self.comment((line_start + indent) as u32)),
					Some(_) => break,
				}
				start = line_start;
			}
			found.reverse();
			found
		}

		/// A comment after a statement on the same line.
		fn comment_after(&self, end: u32) -> Option<V> {
			let mut i = end as usize;
			while i < self.src.len() && matches!(self.src[i], b' ' | b'\t') {
				i += 1;
			}
			(self.src.get(i) == Some(&b'#')).then(|| self.comment(i as u32))
		}

		fn and_or(&self, ao: &AndOr) -> St {
			let mut st = self.pipeline(&ao.first);
			for (op, p) in &ao.rest {
				let left_end = st.end;
				let x = self.stmt(st);
				let yst = self.pipeline(p);
				let end = stmt_end(&yst);
				let y = self.stmt(yst);
				let opt: &[u8] = if *op == AndOrOp::And { b"&&" } else { b"||" };
				let op_pos = self.find(left_end, opt);
				let cmd = V::Obj(vec![
					("Type", s(b"BinaryCmd")),
					("Pos", self.m.pos(ao.span.lo)),
					("End", self.m.pos(end)),
					("OpPos", self.m.pos(op_pos)),
					("Op", s(opt)),
					("X", x),
					("Y", y),
				]);
				st = St {
					pos: ao.span.lo,
					end,
					cmd: Some(cmd),
					negated: false,
					redirs: Vec::new(),
					rend: 0,
					semi: None,
					bg: false,
				};
			}
			st
		}

		fn pipeline(&self, p: &Pipeline) -> St {
			let mut inner = self.stage(&p.stages[0].cmd);
			for (i, st) in p.stages.iter().enumerate().skip(1) {
				let prev = &p.stages[i - 1];
				let opt: &[u8] = if prev.pipe_stderr { b"|&" } else { b"|" };
				let op_pos = self.find(prev.cmd.span.hi, opt);
				let pos = inner.pos;
				let x = self.stmt(inner);
				let yst = self.stage(&st.cmd);
				let end = stmt_end(&yst);
				let y = self.stmt(yst);
				inner = St {
					pos,
					end,
					cmd: Some(V::Obj(vec![
						("Type", s(b"BinaryCmd")),
						("Pos", self.m.pos(pos)),
						("End", self.m.pos(end)),
						("OpPos", self.m.pos(op_pos)),
						("Op", s(opt)),
						("X", x),
						("Y", y),
					])),
					negated: false,
					redirs: Vec::new(),
					rend: 0,
					semi: None,
					bg: false,
				};
			}
			if let Some(t) = p.time {
				let tpos = self.find(p.span.lo + u32::from(p.bang), b"time");
				let mut f = vec![
					("Type", s(b"TimeClause")),
					("Pos", self.m.pos(tpos)),
					("End", self.m.pos(p.span.hi)),
					("Time", self.m.pos(tpos)),
				];
				if t.posix {
					f.push(("PosixFormat", V::Bool(true)));
				}
				let has_cmd = !(p.stages.len() == 1 && is_empty_simple(&p.stages[0].cmd));
				if has_cmd {
					f.push(("Stmt", self.stmt(inner)));
				}
				inner = St {
					pos:     tpos,
					end:     p.span.hi,
					cmd:     Some(V::Obj(f)),
					negated: false,
					redirs:  Vec::new(),
					rend:    0,
					semi:    None,
					bg:      false,
				};
			}
			inner.pos = p.span.lo;
			inner.negated = p.bang;
			inner
		}

		/// One pipeline stage: the command and its redirections.
		fn stage(&self, c: &Command) -> St {
			let (cmd, end) = self.command(c);
			let (redirs, rend) = if let CommandKind::FuncDef(_) = c.kind {
				(Vec::new(), 0)
			} else {
				self.redirs(&c.redirs)
			};
			St { pos: c.span.lo, end, cmd, negated: false, redirs, rend, semi: None, bg: false }
		}

		/// Redirections and the end of the last one.
		fn redirs(&self, rs: &[Redir]) -> (Vec<V>, u32) {
			let mut next_body: Option<u32> = None;
			let mut end = 0;
			let v = rs
				.iter()
				.map(|r| {
					let (v, e) = self.redir(r, &mut next_body);
					end = e;
					v
				})
				.collect();
			(v, end)
		}

		fn redir(&self, r: &Redir, next_body: &mut Option<u32>) -> (V, u32) {
			let mut end = r.span.hi;
			let op = redir_op(r.op);
			let op_pos = match r.fd {
				None => r.span.lo,
				Some(_) => self.find_op(r.span.lo, op),
			};
			let mut f = vec![
				("Pos", self.m.pos(r.span.lo)),
				("End", self.m.pos(r.span.hi)),
				("OpPos", self.m.pos(op_pos)),
				("Op", s(op)),
			];
			if r.fd.is_some() {
				f.push(("N", self.lit(r.span.lo, op_pos, false)));
			}
			match &r.target {
				RedirTarget::Word(w) => f.push(("Word", self.word(w, false))),
				RedirTarget::HereDoc(d) => {
					let wlo = self.skip_ws(op_pos + op.len() as u32);
					let whi = wlo + d.delim_raw.len() as u32;
					let delim_word = Word {
						id:    crate::bash::syntax::span::NodeId(0),
						span:  Span::new(wlo, whi),
						parts: first_word_parts(&d.delim_raw),
					};
					f.push(("Word", self.word(&delim_word, false)));
					let body = next_body.unwrap_or_else(|| self.line_after(r.span.hi));
					let strip = matches!(r.op, RedirOp::HereDoc { strip_tabs: true });
					let (text_end, delim_end) = self.doc_end(body, &d.delim, strip);
					*next_body = Some(self.line_after(delim_end));
					let parts = if text_end == body {
						Vec::new()
					} else if d.quoted {
						vec![self.lit_with(body, delim_end, &self.src[body as usize..text_end as usize])]
					} else {
						self.text_parts(body, text_end, delim_end)
					};
					let mut h = vec![("Pos", self.m.pos(body)), ("End", self.m.pos(delim_end))];
					if !parts.is_empty() {
						h.push(("Parts", V::Arr(parts)));
					}
					f[1] = ("End", self.m.pos(delim_end));
					end = delim_end;
					f.push(("Hdoc", V::Obj(h)));
				},
			}
			(V::Obj(f), end)
		}

		fn find_op(&self, lo: u32, op: &[u8]) -> u32 {
			let mut i = lo;
			while (i as usize) < self.src.len() {
				if self.src[i as usize..].starts_with(op) {
					return i;
				}
				i += 1;
			}
			lo
		}

		/// Start of the line after the one containing `i`.
		fn line_after(&self, i: u32) -> u32 {
			let mut j = i as usize;
			while j < self.src.len() && self.src[j] != b'\n' {
				j += 1;
			}
			(j + 1).min(self.src.len()) as u32
		}

		/// End of a here-document body starting at `body`: the start of the
		/// delimiter text and the end of the delimiter line (without newline).
		fn doc_end(&self, body: u32, delim: &[u8], strip: bool) -> (u32, u32) {
			let mut i = body as usize;
			while i < self.src.len() {
				let end = self.src[i..]
					.iter()
					.position(|&c| c == b'\n')
					.map_or(self.src.len(), |n| i + n);
				let mut j = i;
				if strip {
					while j < end && self.src[j] == b'\t' {
						j += 1;
					}
				}
				if &self.src[j..end] == delim {
					return (j as u32, end as u32);
				}
				i = end + 1;
			}
			let n = self.src.len() as u32;
			(n, n)
		}

		/// Parts of an unquoted here-document body.
		/// Parts of an unquoted here-document body `lo..hi`; shfmt ends a
		/// final literal at the end of the delimiter line (`doc_end`).
		fn text_parts(&self, lo: u32, hi: u32, doc_end: u32) -> Vec<V> {
			let text = &self.src[lo as usize..hi as usize];
			let Ok(w) = parse_text(text, crate::bash::syntax::Features::NONE, TextMode::HereDoc)
			else {
				return vec![self.lit_with(lo, doc_end, text)];
			};
			let spans = part_spans(self.src, lo, hi, &w.parts);
			let mut out = self.parts(&w.parts, &spans);
			let lit_kind = |p: &WordPart| {
				matches!(
					p,
					WordPart::Lit(_)
						| WordPart::Escaped(_)
						| WordPart::BadSubst(_)
						| WordPart::BadComsub(_)
						| WordPart::DroppedQuote
				)
			};
			if w.parts.last().is_some_and(lit_kind) {
				let mut k = w.parts.len() - 1;
				while k > 0 && lit_kind(&w.parts[k - 1]) {
					k -= 1;
				}
				let run_lo = spans[k].0;
				out.pop();
				out.push(self.lit_with(run_lo, doc_end, &self.src[run_lo as usize..hi as usize]));
			}
			out
		}

		/// The shfmt command for `c` and the end of the command proper
		/// (without trailing redirections).
		fn command(&self, c: &Command) -> (Option<V>, u32) {
			let lo = c.span.lo;
			let hi = match c.redirs.first() {
				Some(r) if !matches!(c.kind, CommandKind::Simple(_) | CommandKind::FuncDef(_)) => {
					self.trim_back(lo, r.span.lo)
				},
				_ => c.span.hi,
			};
			let p = |o| self.m.pos(o);
			let v = match &c.kind {
				CommandKind::Simple(sc) => return self.simple(sc),
				CommandKind::Brace(l) => V::Obj(vec![
					("Type", s(b"Block")),
					("Pos", p(lo)),
					("End", p(hi)),
					("Lbrace", p(lo)),
					("Rbrace", p(hi.saturating_sub(1))),
					("Stmts", self.list(l)),
				]),
				CommandKind::Subshell(l) => V::Obj(vec![
					("Type", s(b"Subshell")),
					("Pos", p(lo)),
					("End", p(hi)),
					("Lparen", p(lo)),
					("Rparen", p(hi.saturating_sub(1))),
					("Stmts", self.list(l)),
				]),
				CommandKind::If(i) => self.if_clause(hi, &i.arms, i.else_body.as_ref(), true, lo),
				CommandKind::While(w) => {
					let cond_end = w.cond.items.last().map_or(lo, |it| it.and_or.span.hi);
					let do_pos = self.find(cond_end, b"do");
					let mut f = vec![
						("Type", s(b"WhileClause")),
						("Pos", p(lo)),
						("End", p(hi)),
						("WhilePos", p(lo)),
						("DoPos", p(do_pos)),
						("DonePos", p(hi.saturating_sub(4))),
					];
					if w.until {
						f.push(("Until", V::Bool(true)));
					}
					f.push(("Cond", self.list(&w.cond)));
					f.push(("Do", self.list(&w.body)));
					V::Obj(f)
				},
				CommandKind::For(fr) | CommandKind::Select(fr) => {
					let select = matches!(c.kind, CommandKind::Select(_));
					let mut iter = vec![
						("Type", s(b"WordIter")),
						("Pos", p(fr.var_span.lo)),
						(
							"End",
							p(fr
								.words
								.as_ref()
								.and_then(|w| w.last())
								.map_or(fr.var_span.hi, |w| w.span.hi)),
						),
						("Name", self.lit_value(fr.var_span.lo, fr.var_span.hi, &fr.var)),
					];
					let (extra, mut after) = self.extra_names(fr.var_span.hi, &fr.extra_vars);
					if let Some(extra) = extra {
						iter.push(("ExtraNames", extra));
					}
					if let Some(ws) = &fr.words {
						let in_pos = self.find(after, b"in");
						iter.push(("InPos", p(in_pos)));
						after = ws.last().map_or(in_pos + 2, |w| w.span.hi);
						if !ws.is_empty() {
							iter.push(("Items", V::Arr(ws.iter().map(|w| self.word(w, false)).collect())));
						}
					}
					self.for_clause(lo, hi, select, V::Obj(iter), after, &fr.body)
				},
				CommandKind::ArithFor(a) => {
					let lp = self.find(lo + 3, b"((");
					let rp = self.find(a.step.span.hi, b"))");
					let mut l = vec![
						("Type", s(b"CStyleLoop")),
						("Pos", p(lp)),
						("End", p(rp + 2)),
						("Lparen", p(lp)),
						("Rparen", p(rp)),
					];
					for (k, t) in [("Init", &a.init), ("Cond", &a.cond), ("Post", &a.step)] {
						if let Some(x) = self.arith(t) {
							l.push((k, x));
						}
					}
					self.for_clause(lo, hi, false, V::Obj(l), rp + 2, &a.body)
				},
				CommandKind::Case(cs) => {
					let in_pos = self.find(cs.word.span.hi, b"in");
					let mut items = Vec::new();
					let mut at = in_pos + 2;
					for arm in &cs.arms {
						let plo = arm.patterns.first().map_or(at, |w| w.span.lo);
						let body_end = arm.body.items.last().map_or_else(
							|| arm.patterns.last().map_or(plo, |w| w.span.hi + 1),
							|it| it.and_or.span.hi,
						);
						let op: &[u8] = match arm.term {
							CaseTerm::Break => b";;",
							CaseTerm::FallThrough => b";&",
							CaseTerm::Continue => b";;&",
						};
						let op_pos = self.find(body_end, op);
						let found = self
							.src
							.get(op_pos as usize..)
							.is_some_and(|r| r.starts_with(op));
						let end = if found {
							op_pos + op.len() as u32
						} else {
							body_end
						};
						let mut f = vec![("Pos", p(plo)), ("End", p(end)), ("Op", s(op))];
						if found {
							f.push(("OpPos", p(op_pos)));
						}
						f.push((
							"Patterns",
							V::Arr(arm.patterns.iter().map(|w| self.word(w, false)).collect()),
						));
						if !arm.body.items.is_empty() {
							f.push(("Stmts", self.list(&arm.body)));
						}
						items.push(V::Obj(f));
						at = end;
					}
					let mut f = vec![
						("Type", s(b"CaseClause")),
						("Pos", p(lo)),
						("End", p(hi)),
						("Case", p(lo)),
						("In", p(in_pos)),
						("Esac", p(hi.saturating_sub(4))),
						("Word", self.word(&cs.word, false)),
					];
					if !items.is_empty() {
						f.push(("Items", V::Arr(items)));
					}
					V::Obj(f)
				},
				CommandKind::Arith(a) => {
					let mut f = vec![
						("Type", s(b"ArithmCmd")),
						("Pos", p(lo)),
						("End", p(hi)),
						("Left", p(lo)),
						("Right", p(hi.saturating_sub(2))),
					];
					if let Some(x) = self.arith(a) {
						f.push(("X", x));
					}
					V::Obj(f)
				},
				CommandKind::Cond(e) => V::Obj(vec![
					("Type", s(b"TestClause")),
					("Pos", p(lo)),
					("End", p(hi)),
					("Left", p(lo)),
					("Right", p(hi.saturating_sub(2))),
					("X", self.test(e)),
				]),
				CommandKind::FuncDef(fd) => {
					let name_lo = if fd.keyword { self.skip_ws(lo + 8) } else { lo };
					let name_hi = name_lo + fd.name.len() as u32;
					let (extra, names_hi) = self.extra_names(name_hi, &fd.extra_names);
					let parens = self.at(self.skip_ws(names_hi)) == b'(';
					let mut f = vec![
						("Type", s(b"FuncDecl")),
						("Pos", p(lo)),
						("End", p(c.span.hi)),
						("Position", p(lo)),
					];
					if fd.keyword {
						f.push(("RsrvWord", V::Bool(true)));
					}
					if parens {
						f.push(("Parens", V::Bool(true)));
					}
					f.push(("Name", self.lit_value(name_lo, name_hi, &fd.name)));
					if let Some(extra) = extra {
						f.push(("ExtraNames", extra));
					}
					let (bc, bend) = self.command(&fd.body);
					let (redirs, rend) = self.redirs(&fd.body.redirs);
					let body = St {
						pos: fd.body.span.lo,
						end: bend,
						cmd: bc,
						negated: false,
						redirs,
						rend,
						semi: None,
						bg: false,
					};
					f.push(("Body", self.stmt(body)));
					return (Some(V::Obj(f)), c.span.hi);
				},
				CommandKind::Coproc(cp) => {
					let mut f = vec![
						("Type", s(b"CoprocClause")),
						("Pos", p(lo)),
						("End", p(c.span.hi)),
						("Coproc", p(lo)),
					];
					if let Some(name) = &cp.name {
						let nlo = self.skip_ws(lo + 6);
						let nhi = nlo + name.len() as u32;
						f.push((
							"Name",
							V::Obj(vec![
								("Pos", p(nlo)),
								("End", p(nhi)),
								("Parts", V::Arr(vec![self.lit(nlo, nhi, true)])),
							]),
						));
					}
					f.push(("Stmt", self.stmt(self.stage(&cp.body))));
					return (Some(V::Obj(f)), c.span.hi);
				},
				CommandKind::Repeat(r) => {
					let do_pos = self.find(r.count.span.hi, b"do");
					V::Obj(vec![
						("Type", s(b"RepeatClause")),
						("Pos", p(lo)),
						("End", p(hi)),
						("RepeatPos", p(lo)),
						("Count", self.word(&r.count, true)),
						("DoPos", p(do_pos)),
						("Do", self.list(&r.body)),
					])
				},
				CommandKind::Try(t) => {
					let body_end = t.body.items.last().map_or(lo + 1, |it| it.and_or.span.hi);
					let rbrace = self.find(body_end, b"}");
					let always = self.find(rbrace + 1, b"always");
					V::Obj(vec![
						("Type", s(b"TryClause")),
						("Pos", p(lo)),
						("End", p(hi)),
						("Body", self.list(&t.body)),
						("AlwaysPos", p(always)),
						("Always", self.list(&t.always)),
					])
				},
				CommandKind::AnonFunc(a) => {
					let mut f = vec![("Type", s(b"AnonFuncDecl")), ("Pos", p(lo)), ("End", p(hi))];
					let (bc, bend) = self.command(&a.body);
					let (redirs, rend) = self.redirs(&a.body.redirs);
					let body = St {
						pos: a.body.span.lo,
						end: bend,
						cmd: bc,
						negated: false,
						redirs,
						rend,
						semi: None,
						bg: false,
					};
					f.push(("Body", self.stmt(body)));
					if !a.args.is_empty() {
						f.push(("Args", V::Arr(a.args.iter().map(|w| self.word(w, false)).collect())));
					}
					V::Obj(f)
				},
			};
			(Some(v), hi)
		}

		/// zsh's extra loop variables or function names written after the
		/// first one (which ends at `from`): their `Lit`s (`None` when there
		/// are none) and the end of the last.
		fn extra_names(&self, from: u32, names: &[Vec<u8>]) -> (Option<V>, u32) {
			if names.is_empty() {
				return (None, from);
			}
			let mut at = from;
			let lits = names
				.iter()
				.map(|n| {
					let lo = self.skip_ws(at);
					at = lo + n.len() as u32;
					self.lit_value(lo, at, n)
				})
				.collect();
			(Some(V::Arr(lits)), at)
		}

		fn for_clause(&self, lo: u32, hi: u32, select: bool, lp: V, after: u32, body: &List) -> V {
			let p = |o| self.m.pos(o);
			let do_pos = self.find(after, b"do");
			let braces = self.at(do_pos) != b'd';
			let do_pos = if braces {
				self.find(after, b"{")
			} else {
				do_pos
			};
			let mut f = vec![
				("Type", s(b"ForClause")),
				("Pos", p(lo)),
				("End", p(hi)),
				("ForPos", p(lo)),
				("DoPos", p(do_pos)),
				("DonePos", p(hi.saturating_sub(if braces { 1 } else { 4 }))),
			];
			if select {
				f.push(("Select", V::Bool(true)));
			}
			if braces {
				f.push(("Braces", V::Bool(true)));
			}
			f.push(("Loop", lp));
			f.push(("Do", self.list(body)));
			V::Obj(f)
		}

		fn if_clause(
			&self,
			hi: u32,
			arms: &[IfArm],
			else_body: Option<&List>,
			typed: bool,
			pos: u32,
		) -> V {
			let p = |o| self.m.pos(o);
			let Some((arm, rest)) = arms.split_first() else {
				return V::Null;
			};
			let cond_end = arm.cond.items.last().map_or(pos, |it| it.and_or.span.hi);
			let then_pos = self.find(cond_end, b"then");
			let mut f = Vec::new();
			if typed {
				f.push(("Type", s(b"IfClause")));
			}
			f.push(("Pos", p(pos)));
			f.push(("End", p(hi)));
			f.push(("Position", p(pos)));
			f.push(("ThenPos", p(then_pos)));
			f.push(("FiPos", p(hi.saturating_sub(2))));
			f.push(("Cond", self.list(&arm.cond)));
			f.push(("Then", self.list(&arm.body)));
			let body_end = arm
				.body
				.items
				.last()
				.map_or(then_pos + 4, |it| it.and_or.span.hi);
			if !rest.is_empty() {
				let elif = self.find(body_end, b"elif");
				f.push(("Else", self.if_clause(hi, rest, else_body, false, elif)));
			} else if let Some(e) = else_body {
				let epos = self.find(body_end, b"else");
				f.push((
					"Else",
					V::Obj(vec![
						("Pos", p(epos)),
						("End", p(hi)),
						("Position", p(epos)),
						("FiPos", p(hi.saturating_sub(2))),
						("Then", self.list(e)),
					]),
				));
			}
			V::Obj(f)
		}

		/// An arithmetic expression as one `Word` leaf.
		fn arith(&self, a: &ArithText) -> Option<V> {
			let mut lo = a.span.lo;
			while lo < a.span.hi && matches!(self.at(lo), b' ' | b'\t' | b'\n') {
				lo += 1;
			}
			let hi = self.trim_back(lo, a.span.hi);
			(hi > lo).then(|| {
				V::Obj(vec![
					("Type", s(b"Word")),
					("Pos", self.m.pos(lo)),
					("End", self.m.pos(hi)),
					("Parts", V::Arr(vec![self.lit(lo, hi, true)])),
				])
			})
		}

		fn test(&self, e: &CondExpr) -> V {
			let p = |o| self.m.pos(o);
			match e {
				CondExpr::Word(w) => self.word(w, true),
				CondExpr::Unary { op, arg } => {
					let olo = self.find_back_op(arg.span.lo, op);
					V::Obj(vec![
						("Type", s(b"UnaryTest")),
						("Pos", p(olo)),
						("End", p(arg.span.hi)),
						("OpPos", p(olo)),
						("Op", s(op)),
						("X", self.word(arg, true)),
					])
				},
				CondExpr::Binary { op, lhs, rhs } => V::Obj(vec![
					("Type", s(b"BinaryTest")),
					("Pos", p(lhs.span.lo)),
					("End", p(rhs.span.hi)),
					("OpPos", p(self.find(lhs.span.hi, op))),
					("Op", s(op)),
					("X", self.word(lhs, true)),
					("Y", self.word(rhs, true)),
				]),
				CondExpr::Not(x) => {
					let (xlo, xhi) = test_span(x);
					let olo = self.find_back_op(xlo, b"!");
					V::Obj(vec![
						("Type", s(b"UnaryTest")),
						("Pos", p(olo)),
						("End", p(xhi)),
						("OpPos", p(olo)),
						("Op", s(b"!")),
						("X", self.test(x)),
					])
				},
				CondExpr::Group(x) => {
					let (xlo, xhi) = test_span(x);
					let lp = self.find_back_op(xlo, b"(");
					let rp = self.find(xhi, b")");
					V::Obj(vec![
						("Type", s(b"ParenTest")),
						("Pos", p(lp)),
						("End", p(rp + 1)),
						("Lparen", p(lp)),
						("Rparen", p(rp)),
						("X", self.test(x)),
					])
				},
				CondExpr::And(a, b) | CondExpr::Or(a, b) => {
					let op: &[u8] = if matches!(e, CondExpr::And(..)) {
						b"&&"
					} else {
						b"||"
					};
					let (alo, ahi) = test_span(a);
					let (_, bhi) = test_span(b);
					V::Obj(vec![
						("Type", s(b"BinaryTest")),
						("Pos", p(alo)),
						("End", p(bhi)),
						("OpPos", p(self.find(ahi, op))),
						("Op", s(op)),
						("X", self.test(a)),
						("Y", self.test(b)),
					])
				},
			}
		}

		/// Position of `op` written before `i` (skipping blanks).
		fn find_back_op(&self, i: u32, op: &[u8]) -> u32 {
			let mut j = i;
			while j > 0 && matches!(self.at(j - 1), b' ' | b'\t' | b'\n') {
				j -= 1;
			}
			let n = op.len() as u32;
			if j >= n && self.src.get((j - n) as usize..j as usize) == Some(op) {
				j - n
			} else {
				i
			}
		}

		fn simple(&self, sc: &Simple) -> (Option<V>, u32) {
			let first = sc
				.assigns
				.first()
				.map(|a| a.span.lo)
				.or_else(|| sc.words.first().map(|w| w.span.lo));
			let Some(lo) = first else { return (None, 0) };
			let hi = sc
				.words
				.last()
				.map(|w| w.span.hi)
				.or_else(|| sc.assigns.last().map(|a| a.span.hi))
				.unwrap_or(lo);
			let p = |o| self.m.pos(o);
			if sc.assigns.is_empty()
				&& let Some(head) = sc.words.first()
				&& let [WordPart::Lit(name)] = &head.parts[..]
			{
				if matches!(
					&name[..],
					b"declare" | b"local" | b"export" | b"readonly" | b"typeset" | b"nameref"
				) {
					let args: Vec<V> = sc.words[1..].iter().map(|w| self.decl_arg(w)).collect();
					let mut f = vec![
						("Type", s(b"DeclClause")),
						("Pos", p(lo)),
						("End", p(hi)),
						("Variant", self.lit_value(head.span.lo, head.span.hi, name)),
					];
					if !args.is_empty() {
						f.push(("Args", V::Arr(args)));
					}
					return (Some(V::Obj(f)), hi);
				}
				if &name[..] == b"let" && sc.words.len() > 1 {
					let exprs = sc.words[1..].iter().map(|w| self.word(w, true)).collect();
					return (
						Some(V::Obj(vec![
							("Type", s(b"LetClause")),
							("Pos", p(lo)),
							("End", p(hi)),
							("Let", p(lo)),
							("Exprs", V::Arr(exprs)),
						])),
						hi,
					);
				}
			}
			let mut f = vec![("Type", s(b"CallExpr")), ("Pos", p(lo)), ("End", p(hi))];
			if !sc.assigns.is_empty() {
				f.push(("Assigns", V::Arr(sc.assigns.iter().map(|a| self.assign(a)).collect())));
			}
			if !sc.words.is_empty() {
				f.push(("Args", V::Arr(sc.words.iter().map(|w| self.word(w, false)).collect())));
			}
			(Some(V::Obj(f)), hi)
		}

		fn assign(&self, a: &Assign) -> V {
			let p = |o| self.m.pos(o);
			let mut f = vec![("Pos", p(a.span.lo)), ("End", p(a.span.hi))];
			if a.append {
				f.push(("Append", V::Bool(true)));
			}
			let nhi = a.span.lo + a.name.len() as u32;
			f.push(("Name", self.lit_value(a.span.lo, nhi, &a.name)));
			if let Some(i) = &a.index {
				f.push(("Index", self.word(i, true)));
			}
			match &a.value {
				AssignValue::Scalar(w) => {
					if !w.parts.is_empty() {
						f.push(("Value", self.word(w, false)));
					}
				},
				AssignValue::Array(elems) => {
					let alo = self.find(a.span.lo, b"(");
					let alo = if self.at(alo) == b'(' {
						alo
					} else {
						a.span.hi.saturating_sub(1)
					};
					f.push(("Array", self.array(alo, a.span.hi, elems)));
				},
			}
			V::Obj(f)
		}

		fn array(&self, lo: u32, hi: u32, elems: &[ArrayElem]) -> V {
			let p = |o| self.m.pos(o);
			let es: Vec<V> = elems
				.iter()
				.map(|e| {
					let elo = e
						.key
						.as_ref()
						.map_or(e.value.span.lo, |k| k.span.lo.saturating_sub(1));
					let mut f = vec![("Pos", p(elo)), ("End", p(e.value.span.hi))];
					if let Some(k) = &e.key {
						f.push(("Index", self.word(k, true)));
					}
					if !e.value.parts.is_empty() {
						f.push(("Value", self.word(&e.value, false)));
					}
					V::Obj(f)
				})
				.collect();
			let mut f = vec![
				("Pos", p(lo)),
				("End", p(hi)),
				("Lparen", p(lo)),
				("Rparen", p(hi.saturating_sub(1))),
			];
			if !es.is_empty() {
				f.push(("Elems", V::Arr(es)));
			}
			V::Obj(f)
		}

		fn decl_arg(&self, w: &Word) -> V {
			let p = |o| self.m.pos(o);
			let lo = w.span.lo;
			let hi = w.span.hi;
			// `name=(…)` and `name=value`.
			if let Some(WordPart::Lit(first)) = w.parts.first()
				&& let Some(eq) = first.iter().position(|&c| c == b'=')
				&& crate::bash::syntax::util::is_identifier(
					first[..eq].strip_suffix(b"+").unwrap_or(&first[..eq]),
				) {
				let append = first[..eq].ends_with(b"+");
				let name = first[..eq].strip_suffix(b"+").unwrap_or(&first[..eq]);
				let mut f = vec![("Pos", p(lo)), ("End", p(hi))];
				if append {
					f.push(("Append", V::Bool(true)));
				}
				f.push(("Name", self.lit_value(lo, lo + name.len() as u32, name)));
				let vlo = lo + eq as u32 + 1;
				if let Some(WordPart::Compound(elems)) = w.parts.get(1) {
					f.push(("Array", self.array(vlo, hi, elems)));
				} else if vlo < hi {
					let mut rest = w.clone();
					rest.span = Span::new(vlo, hi);
					if let Some(WordPart::Lit(l)) = rest.parts.first_mut() {
						l.drain(..=eq);
						if l.is_empty() {
							rest.parts.remove(0);
						}
					}
					f.push(("Value", self.word(&rest, false)));
				}
				return V::Obj(f);
			}
			let mut f = vec![("Pos", p(lo)), ("End", p(hi)), ("Naked", V::Bool(true))];
			match &w.parts[..] {
				[WordPart::Lit(n)] if crate::bash::syntax::util::is_identifier(n) => {
					f.push(("Name", self.lit_value(lo, hi, n)));
				},
				_ => f.push(("Value", self.word(w, false))),
			}
			V::Obj(f)
		}

		/// A word; `typed` adds `"Type": "Word"` (interface positions).
		fn word(&self, w: &Word, typed: bool) -> V {
			let spans = part_spans(self.src, w.span.lo, w.span.hi, &w.parts);
			let parts = self.parts(&w.parts, &spans);
			let mut f = Vec::new();
			if typed {
				f.push(("Type", s(b"Word")));
			}
			f.push(("Pos", self.m.pos(w.span.lo)));
			f.push(("End", self.m.pos(w.span.hi)));
			if !parts.is_empty() {
				f.push(("Parts", V::Arr(parts)));
			}
			V::Obj(f)
		}

		/// Parts with their source spans; literal and escaped runs merge into
		/// one `Lit` holding the source text, as shfmt keeps them.
		fn parts(&self, parts: &[WordPart], spans: &[(u32, u32)]) -> Vec<V> {
			let mut out = Vec::new();
			let mut run: Option<(u32, u32)> = None;
			for (part, &(lo, hi)) in parts.iter().zip(spans) {
				if matches!(part, WordPart::Lit(_)) {
					// shfmt makes every `$` that starts no expansion a `Lit` of
					// its own; a literal part's `$` bytes are exactly those.
					let mut start = lo;
					for at in lo..hi {
						if self.at(at) == b'$' {
							if let Some((a, _)) = run.take() {
								out.push(self.lit(a, at, true));
							} else if at > start {
								out.push(self.lit(start, at, true));
							}
							out.push(self.lit(at, at + 1, true));
							start = at + 1;
						}
					}
					if start < hi {
						run = Some(run.map_or((start, hi), |(a, _)| (a, hi)));
					}
					continue;
				}
				if matches!(
					part,
					WordPart::Escaped(_)
						| WordPart::BadSubst(_)
						| WordPart::BadComsub(_)
						| WordPart::DroppedQuote
						| WordPart::Zsh(_)
				) {
					run = Some(run.map_or((lo, hi), |(a, _)| (a, hi)));
					continue;
				}
				if let Some((a, b)) = run.take() {
					out.push(self.lit(a, b, true));
				}
				out.push(self.part(part, lo, hi));
			}
			if let Some((a, b)) = run {
				out.push(self.lit(a, b, true));
			}
			out
		}

		fn part(&self, part: &WordPart, lo: u32, hi: u32) -> V {
			let p = |o| self.m.pos(o);
			match part {
				WordPart::SQuote(v) | WordPart::AnsiC(v) => {
					let mut f = vec![
						("Type", s(b"SglQuoted")),
						("Pos", p(lo)),
						("End", p(hi)),
						("Left", p(lo)),
						("Right", p(hi.saturating_sub(1))),
					];
					if matches!(part, WordPart::AnsiC(_)) {
						f.push(("Dollar", V::Bool(true)));
					}
					// shfmt omits empty strings.
					if !v.is_empty() {
						f.push(("Value", s(v)));
					}
					V::Obj(f)
				},
				WordPart::DQuote(inner) | WordPart::Locale(inner) => {
					let dollar = matches!(part, WordPart::Locale(_));
					let ilo = lo + 1 + u32::from(dollar);
					let spans = part_spans(self.src, ilo, hi.saturating_sub(1), inner);
					let parts = self.parts(inner, &spans);
					let mut f = vec![
						("Type", s(b"DblQuoted")),
						("Pos", p(lo)),
						("End", p(hi)),
						("Left", p(lo)),
						("Right", p(hi.saturating_sub(1))),
					];
					if dollar {
						f.push(("Dollar", V::Bool(true)));
					}
					if !parts.is_empty() {
						f.push(("Parts", V::Arr(parts)));
					}
					V::Obj(f)
				},
				WordPart::Param(pp) => self.param(pp, lo, hi),
				WordPart::Comsub(c) => {
					let mut f = vec![
						("Type", s(b"CmdSubst")),
						("Pos", p(lo)),
						("End", p(hi)),
						("Left", p(lo)),
						("Right", p(hi.saturating_sub(1))),
					];
					if !c.body.items.is_empty() {
						f.push(("Stmts", self.list(&c.body)));
					}
					match c.kind {
						ComsubKind::Backtick => f.push(("Backquotes", V::Bool(true))),
						ComsubKind::NoFork => f.push(("TempFile", V::Bool(true))),
						ComsubKind::ValueSub => f.push(("ReplyVar", V::Bool(true))),
						ComsubKind::Dollar => {},
					}
					V::Obj(f)
				},
				WordPart::Arith(a) => {
					let bracket = self.at(lo + 1) == b'[';
					let mut f = vec![
						("Type", s(b"ArithmExp")),
						("Pos", p(lo)),
						("End", p(hi)),
						("Left", p(lo)),
						("Right", p(hi.saturating_sub(if bracket { 1 } else { 2 }))),
					];
					if bracket {
						f.push(("Bracket", V::Bool(true)));
					}
					if let Some(x) = self.arith(a) {
						f.push(("X", x));
					}
					V::Obj(f)
				},
				WordPart::ProcSub(ps) => {
					let mut f = vec![
						("Type", s(b"ProcSubst")),
						("Pos", p(lo)),
						("End", p(hi)),
						("OpPos", p(lo)),
						("Rparen", p(hi.saturating_sub(1))),
						("Op", s(if ps.output { b">(" } else { b"<(" })),
					];
					if !ps.body.items.is_empty() {
						f.push(("Stmts", self.list(&ps.body)));
					}
					V::Obj(f)
				},
				WordPart::Compound(elems) => self.array(lo, hi, elems),
				WordPart::Lit(_)
				| WordPart::Escaped(_)
				| WordPart::BadSubst(_)
				| WordPart::BadComsub(_)
				| WordPart::DroppedQuote
				| WordPart::Zsh(_) => self.lit(lo, hi, true),
			}
		}

		fn param(&self, pp: &Param, lo: u32, hi: u32) -> V {
			let p = |o| self.m.pos(o);
			let mut f =
				vec![("Type", s(b"ParamExp")), ("Pos", p(lo)), ("End", p(hi)), ("Dollar", p(lo))];
			let mut name_lo = lo + 1;
			if pp.braced {
				f.push(("Rbrace", p(hi.saturating_sub(1))));
				name_lo += 1;
			} else {
				f.push(("Short", V::Bool(true)));
			}
			let excl = matches!(pp.op, ParamOp::Indirect | ParamOp::PrefixNames { .. }) || pp.indirect;
			if excl {
				f.push(("Excl", V::Bool(true)));
				name_lo += 1;
			}
			if pp.op == ParamOp::Length {
				f.push(("Length", V::Bool(true)));
				name_lo += 1;
			}
			let mut name = Vec::new();
			match &pp.name {
				ParamName::Var(v) => name.extend_from_slice(v),
				ParamName::Positional(n) => crate::bash::syntax::util::push_u32(&mut name, *n),
				ParamName::Special(sp) => name.push(special_char(*sp)),
			}
			let name_hi = name_lo + name.len() as u32;
			f.push(("Param", self.lit_value(name_lo, name_hi, &name)));
			match &pp.index {
				Some(Subscript::At | Subscript::Star) => {
					let at: &[u8] = if pp.index == Some(Subscript::At) {
						b"@"
					} else {
						b"*"
					};
					f.push((
						"Index",
						V::Obj(vec![
							("Type", s(b"Word")),
							("Pos", p(name_hi + 1)),
							("End", p(name_hi + 2)),
							("Parts", V::Arr(vec![self.lit_with(name_hi + 1, name_hi + 2, at)])),
						]),
					));
				},
				Some(Subscript::Expr(w)) => f.push(("Index", self.word(w, true))),
				None => {},
			}
			let opw = |op: &[u8], w: Option<&Word>| {
				let mut e = vec![("Op", s(op))];
				if let Some(w) = w
					&& !w.parts.is_empty()
				{
					e.push(("Word", self.word(w, false)));
				}
				V::Obj(e)
			};
			match &pp.op {
				ParamOp::None | ParamOp::Length | ParamOp::Indirect => {},
				ParamOp::PrefixNames { star } => f.push(("Names", s(if *star { b"*" } else { b"@" }))),
				ParamOp::Default { colon, word } => {
					f.push(("Exp", opw(if *colon { b":-" } else { b"-" }, Some(word))));
				},
				ParamOp::Assign { colon, word } => {
					f.push(("Exp", opw(if *colon { b":=" } else { b"=" }, Some(word))));
				},
				ParamOp::Error { colon, word } => {
					f.push(("Exp", opw(if *colon { b":?" } else { b"?" }, word.as_ref())));
				},
				ParamOp::Alt { colon, word } => {
					f.push(("Exp", opw(if *colon { b":+" } else { b"+" }, Some(word))));
				},
				ParamOp::Substr { offset, len } => {
					let mut sl = Vec::new();
					if let Some(x) = self.arith(offset) {
						sl.push(("Offset", x));
					}
					if let Some(l) = len
						&& let Some(x) = self.arith(l)
					{
						sl.push(("Length", x));
					}
					f.push(("Slice", V::Obj(sl)));
				},
				ParamOp::Trim { suffix, longest, pat } => {
					let op: &[u8] = match (suffix, longest) {
						(false, false) => b"#",
						(false, true) => b"##",
						(true, false) => b"%",
						(true, true) => b"%%",
					};
					f.push(("Exp", opw(op, Some(pat))));
				},
				ParamOp::Replace { mode, pat, rep } => {
					let mut r = Vec::new();
					if *mode == ReplaceMode::All {
						r.push(("All", V::Bool(true)));
					}
					let orig = if matches!(mode, ReplaceMode::Prefix | ReplaceMode::Suffix) {
						// shfmt keeps the anchor in the pattern.
						let alo = pat.span.lo.saturating_sub(1);
						let spans = part_spans(self.src, pat.span.lo, pat.span.hi, &pat.parts);
						let mut parts =
							vec![self.lit(alo, spans.first().map_or(pat.span.lo, |s| s.0), true)];
						parts.extend(self.parts(&pat.parts, &spans));
						let merged = merge_lit_vs(parts, self);
						V::Obj(vec![("Pos", p(alo)), ("End", p(pat.span.hi)), ("Parts", V::Arr(merged))])
					} else {
						self.word(pat, false)
					};
					r.push(("Orig", orig));
					if let Some(w) = rep {
						r.push(("With", self.word(w, false)));
					}
					f.push(("Repl", V::Obj(r)));
				},
				ParamOp::Case { mode, all, pat } => {
					let op: &[u8] = match (mode, all) {
						(CaseMode::Upper, false) => b"^",
						(CaseMode::Upper, true) => b"^^",
						(CaseMode::Lower, false) => b",",
						(CaseMode::Lower, true) => b",,",
						(CaseMode::Toggle, false) => b"~",
						(CaseMode::Toggle, true) => b"~~",
					};
					f.push(("Exp", opw(op, pat.as_ref())));
				},
				ParamOp::Transform(c) => {
					let at = hi.saturating_sub(2);
					f.push((
						"Exp",
						V::Obj(vec![
							("Op", s(b"@")),
							(
								"Word",
								V::Obj(vec![
									("Pos", p(at)),
									("End", p(at + 1)),
									("Parts", V::Arr(vec![self.lit_with(at, at + 1, &[*c])])),
								]),
							),
						]),
					));
				},
			}
			V::Obj(f)
		}

		fn lit_with(&self, lo: u32, hi: u32, v: &[u8]) -> V {
			V::Obj(vec![
				("Type", s(b"Lit")),
				("Pos", self.m.pos(lo)),
				("End", self.m.pos(hi)),
				("ValuePos", self.m.pos(lo)),
				("ValueEnd", self.m.pos(hi)),
				("Value", s(v)),
			])
		}
	}

	/// The parts of the first word of `raw` (a here-document delimiter as
	/// written).
	fn first_word_parts(raw: &[u8]) -> Vec<WordPart> {
		let parsed = crate::bash::syntax::parse_all(raw, crate::bash::syntax::Features::NONE).ok();
		let word = parsed.as_ref().and_then(|p| {
			let cmd = &p
				.commands
				.first()?
				.list
				.items
				.first()?
				.and_or
				.first
				.stages
				.first()?
				.cmd;
			match &cmd.kind {
				CommandKind::Simple(s) => s.words.first().cloned(),
				_ => None,
			}
		});
		word.map_or_else(|| vec![WordPart::Lit(raw.to_vec())], |w| w.parts)
	}

	/// Join a leading anchor `Lit` with a following `Lit` (shfmt keeps
	/// `#x` of `${a/#x/y}` as one literal).
	fn merge_lit_vs(parts: Vec<V>, c: &Ctx<'_>) -> Vec<V> {
		let mut out: Vec<V> = Vec::new();
		for v in parts {
			if let (Some(prev), Some((lo2, hi2))) = (out.last(), lit_span(&v))
				&& let Some((lo1, hi1)) = lit_span(prev)
				&& hi1 == lo2
			{
				let merged = c.lit(lo1, hi2, true);
				out.pop();
				out.push(merged);
				continue;
			}
			out.push(v);
		}
		out
	}

	fn lit_span(v: &V) -> Option<(u32, u32)> {
		let V::Obj(f) = v else { return None };
		if !matches!(f.first(), Some(("Type", V::Str(t))) if t == b"Lit") {
			return None;
		}
		let get = |k: &str| {
			f.iter().find(|(n, _)| *n == k).and_then(|(_, v)| match v {
				V::Obj(p) => p
					.iter()
					.find(|(n, _)| *n == "Offset")
					.and_then(|(_, v)| match v {
						V::Num(n) => Some(*n as u32),
						_ => None,
					}),
				_ => None,
			})
		};
		Some((get("ValuePos")?, get("ValueEnd")?))
	}

	const fn is_empty_simple(c: &Command) -> bool {
		matches!(&c.kind, CommandKind::Simple(s) if s.assigns.is_empty() && s.words.is_empty())
			&& c.redirs.is_empty()
	}

	/// Source extent of a `[[ ]]` expression.
	fn test_span(e: &CondExpr) -> (u32, u32) {
		match e {
			CondExpr::Word(w) => (w.span.lo, w.span.hi),
			CondExpr::Unary { arg, .. } => (arg.span.lo.saturating_sub(3), arg.span.hi),
			CondExpr::Binary { lhs, rhs, .. } => (lhs.span.lo, rhs.span.hi),
			CondExpr::Not(x) => {
				let (a, b) = test_span(x);
				(a.saturating_sub(2), b)
			},
			CondExpr::Group(x) => {
				let (a, b) = test_span(x);
				(a.saturating_sub(2), b + 2)
			},
			CondExpr::And(a, b) | CondExpr::Or(a, b) => (test_span(a).0, test_span(b).1),
		}
	}
}

// ---- part spans
// ---------------------------------------------------------------------

/// Source spans of `parts`, which lie in `src[lo..hi]` (re-scanning the
/// source; transformed text such as re-printed command substitutions is
/// located by its delimiters).
fn part_spans(src: &[u8], lo: u32, hi: u32, parts: &[WordPart]) -> Vec<(u32, u32)> {
	let mut sc = PartScan { src, i: lo as usize, hi: hi as usize };
	let mut out = Vec::with_capacity(parts.len());
	for p in parts {
		let a = sc.i;
		sc.part(p);
		let b = sc.i.min(sc.hi.max(a));
		out.push((a as u32, b as u32));
	}
	// A zsh word ends at the word's end whatever its stored text dropped
	// (`\newline`).
	if let (Some(WordPart::Zsh(_)), Some(last)) = (parts.last(), out.last_mut()) {
		last.1 = last.1.max(hi);
	}
	out
}

struct PartScan<'a> {
	src: &'a [u8],
	i:   usize,
	hi:  usize,
}

impl PartScan<'_> {
	fn at(&self, i: usize) -> u8 {
		self.src.get(i).copied().unwrap_or(0)
	}

	fn skip_cont(&mut self) {
		while self.at(self.i) == b'\\' && self.at(self.i + 1) == b'\n' {
			self.i += 2;
		}
	}

	fn part(&mut self, p: &WordPart) {
		self.skip_cont();
		match p {
			WordPart::Lit(s) => {
				for &b in s {
					self.skip_cont();
					if self.at(self.i) == b {
						self.i += 1;
					} else {
						break;
					}
				}
			},
			WordPart::Escaped(s) => self.i += 1 + s.len(),
			WordPart::SQuote(s) => self.i += 2 + s.len(),
			WordPart::AnsiC(s) => self.i += 3 + s.len(),
			WordPart::DQuote(inner) | WordPart::Locale(inner) => {
				self.i += if matches!(p, WordPart::Locale(_)) {
					2
				} else {
					1
				};
				for q in inner {
					self.part(q);
				}
				self.skip_cont();
				self.i += 1;
			},
			WordPart::Param(pp) => {
				if pp.braced {
					let inner_end = param_inner_end(pp);
					self.close_after(inner_end.map_or(self.i + 2, |e| e as usize), b'}');
				} else {
					self.i += 1;
					match &pp.name {
						ParamName::Var(v) => self.i += v.len(),
						_ => self.i += 1,
					}
				}
			},
			WordPart::Comsub(c) => match c.kind {
				ComsubKind::Backtick => {
					self.i += 1;
					while self.i < self.src.len() && self.at(self.i) != b'`' {
						if self.at(self.i) == b'\\' {
							self.i += 1;
						}
						self.i += 1;
					}
					self.i += 1;
				},
				ComsubKind::Dollar if c.body.items.is_empty() || self.at(self.i + 2) == b'(' => {
					self.i += 2 + c.text.len() + 1;
				},
				ComsubKind::Dollar => self.after_list(&c.body, b')'),
				ComsubKind::NoFork | ComsubKind::ValueSub => self.after_list(&c.body, b'}'),
			},
			WordPart::ProcSub(ps) => self.after_list(&ps.body, b')'),
			WordPart::Arith(a) => {
				let e = a.span.hi as usize;
				self.i = if self.at(e) == b']' { e + 1 } else { e + 2 };
			},
			WordPart::Compound(elems) => {
				let e = elems
					.last()
					.map_or(self.i + 1, |e| e.value.span.hi as usize);
				self.close_after(e, b')');
			},
			WordPart::BadSubst(t) => self.i += t.len(),
			WordPart::BadComsub(b) => self.i += b.text.len(),
			WordPart::DroppedQuote => self.i += 1,
			WordPart::Zsh(raw) => {
				let mut text = Vec::new();
				crate::bash::syntax::print::zsh_text(raw, &mut text);
				for &b in &text {
					self.skip_cont();
					if self.at(self.i) == b {
						self.i += 1;
					} else {
						break;
					}
				}
			},
		}
	}

	/// After a command list: skip separators and blanks to `close`.
	fn after_list(&mut self, l: &List, close: u8) {
		let start = l
			.items
			.last()
			.map_or(self.i + 2, |it| it.and_or.span.hi as usize);
		let mut j = start.max(self.i);
		while j < self.src.len() {
			match self.at(j) {
				b' ' | b'\t' | b'\n' | b';' | b'&' => j += 1,
				b'#' => {
					while j < self.src.len() && self.at(j) != b'\n' {
						j += 1;
					}
				},
				c if c == close => {
					j += 1;
					break;
				},
				_ => j += 1,
			}
		}
		self.i = j;
	}

	/// Move to just after the first `close` at or after `from`.
	fn close_after(&mut self, from: usize, close: u8) {
		let mut j = from.max(self.i);
		while j < self.src.len() && self.at(j) != close {
			j += 1;
		}
		self.i = (j + 1).min(self.src.len());
	}
}

/// End of the last source-located piece inside a `${…}`.
fn param_inner_end(p: &Param) -> Option<u32> {
	let w = |w: &Word| Some(w.span.hi);
	let from_op = match &p.op {
		ParamOp::Default { word, .. } | ParamOp::Assign { word, .. } | ParamOp::Alt { word, .. } => {
			w(word)
		},
		ParamOp::Error { word, .. } => word.as_ref().and_then(w),
		ParamOp::Trim { pat, .. } => w(pat),
		ParamOp::Replace { pat, rep, .. } => rep.as_ref().map_or(Some(pat.span.hi), w),
		ParamOp::Case { pat, .. } => pat.as_ref().and_then(w),
		ParamOp::Substr { offset, len } => Some(len.as_ref().map_or(offset.span.hi, |l| l.span.hi)),
		_ => None,
	};
	from_op.or(match &p.index {
		Some(Subscript::Expr(x)) => Some(x.span.hi),
		_ => None,
	})
}
