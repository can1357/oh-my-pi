//! JSON export (see [`to_json`](crate::bash::syntax::to_json) for the schemas).

use alloc::{string::String, vec, vec::Vec};

use crate::bash::syntax::{JsonDialect, Offsets, ast::*, span::Span};

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

// Consume the value tree as we write it. Logical conditions retain the
// external binary JSON shape, so both writing and dropping that shape must
// use an explicit stack rather than the Rust call stack.
fn write(out: &mut String, v: V, pretty: bool, depth: usize) {
	enum Step {
		Value(V, usize),
		Entry(usize, bool),
		Key(&'static str),
		End(char, usize, bool),
	}
	let nl = |out: &mut String, d: usize| {
		if pretty {
			out.push('\n');
			for _ in 0..d {
				out.push('\t');
			}
		}
	};
	let mut pending = vec![Step::Value(v, depth)];
	while let Some(step) = pending.pop() {
		match step {
			Step::Entry(depth, comma) => {
				if comma {
					out.push(',');
				}
				nl(out, depth);
			},
			Step::Key(key) => {
				write_str(out, key.as_bytes());
				out.push(':');
				if pretty {
					out.push(' ');
				}
			},
			Step::End(close, depth, nonempty) => {
				if nonempty {
					nl(out, depth);
				}
				out.push(close);
			},
			Step::Value(value, depth) => match value {
				V::Null => out.push_str("null"),
				V::Bool(b) => out.push_str(if b { "true" } else { "false" }),
				V::Num(n) => write_num(out, n),
				V::Str(b) => write_str(out, &b),
				V::Arr(items) => {
					out.push('[');
					pending.push(Step::End(']', depth, !items.is_empty()));
					for (i, item) in items.into_iter().enumerate().rev() {
						pending.push(Step::Value(item, depth + 1));
						pending.push(Step::Entry(depth + 1, i > 0));
					}
				},
				V::Obj(fields) => {
					out.push('{');
					pending.push(Step::End('}', depth, !fields.is_empty()));
					for (i, (key, item)) in fields.into_iter().enumerate().rev() {
						pending.push(Step::Value(item, depth + 1));
						pending.push(Step::Key(key));
						pending.push(Step::Entry(depth + 1, i > 0));
					}
				},
			},
		}
	}
}

/// Serialize a program as JSON.
///
/// `src` supplies the original offsets, line/column numbers and shfmt word
/// text slices. Command names and descriptor text come from the parsed tree.
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
/// tree, and extglob groups stay inside `Lit`.
/// zsh words are `Lit` leaves holding their source text; zsh-only commands
/// use node types shfmt lacks (`RepeatClause`, `TryClause`, `AnonFuncDecl`),
/// `&|` sets `Background` and `Disown`, and extra loop variables or function
/// names are listed in `ExtraNames`.
/// Command extents and keyword positions come from the parser, not from
/// adjacent redirections. Unwritten group delimiters and conditional keywords
/// are omitted. Every object in `Parts` includes its `Type`.
pub fn to_json(src: &[u8], program: &Program, dialect: JsonDialect, offsets: Offsets) -> String {
	let map = OffMap::new(src, offsets);
	let mut out = String::new();
	match dialect {
		JsonDialect::Native => {
			let v = native::program(&map, program);
			write(&mut out, v, false, 0);
		},
		JsonDialect::Shfmt => {
			let v = shfmt::program(&map, src, program);
			write(&mut out, v, true, 0);
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
					let names = fr.extra_vars.iter().map(|v| s(&v.text)).collect();
					f.push(("extra_vars", V::Arr(names)));
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
					let names = fd.extra_names.iter().map(|n| s(&n.text)).collect();
					f.push(("extra_names", V::Arr(names)));
				}
				f.push(("keyword", V::Bool(fd.keyword)));
				f.push(("body", command(m, &fd.body)));
				b"function"
			},
			CommandKind::Coproc(cp) => {
				f.push(("name", cp.name.as_ref().map_or(V::Null, |n| s(&n.text))));
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
			RedirTarget::HereDoc(d) => {
				let mut fields = vec![
					("delim", s(&d.delim)),
					("delim_raw", s(&d.delim_raw)),
					("quoted", V::Bool(d.quoted)),
					("text", s(&d.text)),
				];
				if let Some(delimiter) = &d.delimiter {
					fields.push(("delimiter", word(m, delimiter)));
				}
				V::Obj(vec![("heredoc", V::Obj(fields))])
			},
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
			CondExpr::Unary { op, arg, .. } => {
				V::Obj(vec![("type", s(b"unary")), ("op", s(op)), ("arg", word(m, arg))])
			},
			CondExpr::Binary { op, lhs, rhs, .. } => V::Obj(vec![
				("type", s(b"binary")),
				("op", s(op)),
				("lhs", word(m, lhs)),
				("rhs", word(m, rhs)),
			]),
			CondExpr::Word(w) => V::Obj(vec![("type", s(b"word")), ("word", word(m, w))]),
			CondExpr::Not { rest, expr, .. } => {
				let mut v = cond(m, expr);
				for _ in 0..=rest.len() {
					v = V::Obj(vec![("type", s(b"not")), ("expr", v)]);
				}
				v
			},
			CondExpr::Group { expr, .. } => {
				V::Obj(vec![("type", s(b"group")), ("expr", cond(m, expr))])
			},
			CondExpr::And(terms, _) | CondExpr::Or(terms, _) => {
				let kind: &[u8] = if matches!(e, CondExpr::And(..)) {
					b"and"
				} else {
					b"or"
				};
				let (last, rest) = terms.split_last().expect("logical chain has operands");
				let mut rhs = cond(m, last);
				for lhs in rest.iter().rev() {
					rhs = V::Obj(vec![("type", s(kind)), ("lhs", cond(m, lhs)), ("rhs", rhs)]);
				}
				rhs
			},
		}
	}

	pub(super) fn word(m: &OffMap, w: &Word) -> V {
		let mut fields = vec![("id", id(w.id))];
		if let Some(span) = w.span.recorded() {
			fields.push(("span", m.span(span)));
		}
		fields.push(("parts", parts(m, &w.parts)));
		V::Obj(fields)
	}

	fn parts(m: &OffMap, ps: &[WordPart]) -> V {
		V::Arr(ps.iter().map(|p| part(m, p)).collect())
	}

	fn tv(t: &[u8], v: &[u8]) -> V {
		V::Obj(vec![("type", s(t)), ("value", s(v))])
	}

	fn part(m: &OffMap, p: &WordPart) -> V {
		let mut value = match p {
			WordPart::Lit(v) => tv(b"lit", v),
			WordPart::Escaped(v) => tv(b"escaped", v),
			WordPart::SQuote(v) => tv(b"squote", v),
			WordPart::AnsiC(v) => tv(b"ansic", v),
			WordPart::BadSubst(v) => tv(b"bad_subst", v),
			WordPart::BadComsub(b) => tv(b"bad_comsub", &b.text),
			WordPart::DroppedQuote(_) => tv(b"dropped_quote", b"\""),
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
		};
		if let Some(pos) = p.pos()
			&& let V::Obj(fields) = &mut value
		{
			fields.insert(0, ("span", m.span(pos.span)));
		}
		value
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
			ParamOp::Replace { mode, pat, rep, .. } => {
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
			ParamOp::Transform { op, .. } => {
				V::Obj(vec![("type", s(b"transform")), ("op", s(&[*op]))])
			},
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

	/// What a `for`/`select`/`for ((…))` clause needs besides its loop head.
	struct ForClause {
		/// Start of the command.
		lo:     u32,
		/// End of the command proper, redirections excluded.
		hi:     u32,
		/// Offset of the closing `done` or `}`, as the parser recorded it.
		close:  Option<u32>,
		/// `select` rather than `for`.
		select: bool,
		/// Offset of `do` or `{`, as the parser recorded it.
		do_pos: Option<u32>,
		/// The body is a `{ … }` group.
		braces: bool,
	}

	/// What every arm of one `if` shares.
	struct IfClause<'a> {
		/// End of the command proper, redirections excluded.
		hi:        u32,
		/// Offset of `fi` (or of the closing `}`), as the parser recorded it.
		close:     Option<u32>,
		/// The `else` body.
		else_body: Option<&'a List>,
		/// Offset of `else`, as the parser recorded it.
		else_pos:  Option<u32>,
	}

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
			// `sm + 1` invents a byte when the separator came from the text
			// an alias expanded to, where it has none. Correcting it needs
			// the parser to record the separator's own span on `ListItem`,
			// which this change does not do; the fixture list names the row
			// it leaves red.
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

		fn lit_value(&self, lo: u32, hi: u32, value: &[u8], typed: bool) -> V {
			let mut f = Vec::with_capacity(6);
			if typed {
				f.push(("Type", s(b"Lit")));
			}
			f.push(("Pos", self.m.pos(lo)));
			f.push(("End", self.m.pos(hi)));
			f.push(("ValuePos", self.m.pos(lo)));
			f.push(("ValueEnd", self.m.pos(hi)));
			f.push(("Value", s(value)));
			V::Obj(f)
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
			let mut end = 0;
			let v = rs
				.iter()
				.map(|r| {
					let (v, e) = self.redir(r);
					end = e;
					v
				})
				.collect();
			(v, end)
		}

		fn redir(&self, r: &Redir) -> (V, u32) {
			let mut end = r.span.hi;
			let op = redir_op(r.op);
			let op_pos = r.op_pos;
			let mut f = vec![
				("Pos", self.m.pos(r.span.lo)),
				("End", self.m.pos(r.span.hi)),
				("OpPos", self.m.pos(op_pos)),
				("Op", s(op)),
			];
			if let Some(name) = &r.fd_name {
				f.push(("N", self.lit_value(name.span.lo, name.span.hi, &name.text, false)));
			}
			match &r.target {
				RedirTarget::Word(w) => f.push(("Word", self.word(w, false))),
				RedirTarget::HereDoc(d) => {
					if let Some(word) = &d.delimiter {
						f.push(("Word", self.word(word, false)));
					} else {
						f.push((
							"Word",
							V::Obj(vec![(
								"Parts",
								V::Arr(vec![self.lit_optional(None, &d.delim_raw, true)]),
							)]),
						));
					}
					let (parts, span) = if let Some(source) = &d.source {
						let doc_end = source.close.map_or(source.span.hi, |close| close.hi);
						let parts = if source.raw.is_empty() {
							Vec::new()
						} else if d.quoted {
							vec![self.lit_with(source.span.lo, doc_end, &source.raw)]
						} else {
							self.text_parts(source, doc_end)
						};
						(parts, Some(Span::new(source.span.lo, doc_end)))
					} else if d.text.is_empty() {
						(Vec::new(), None)
					} else {
						(vec![self.lit_optional(None, &d.text, true)], None)
					};
					if let Some(hdoc) = self.optional_word(span, parts, false) {
						if let Some(span) = span {
							f[1] = ("End", self.m.pos(span.hi));
							end = span.hi;
						}
						f.push(("Hdoc", hdoc));
					}
				},
			}
			(V::Obj(f), end)
		}

		/// The stored body is the parser's input, not a slice recovered from
		/// the command's source. Its sub-parser keeps the recorded origin.
		fn text_parts(&self, source: &HereDocSource, doc_end: u32) -> Vec<V> {
			let Ok(word) = crate::bash::syntax::parser::parse_doc_text(
				source,
				crate::bash::syntax::Features::NONE,
			) else {
				return vec![self.lit_with(source.span.lo, doc_end, &source.raw)];
			};
			let mut parts = self.parts(&word.parts);
			// shfmt extends the final literal to the closing delimiter's end,
			// while its value contains only the bytes read in the body.
			if let Some(V::Obj(fields)) = parts.last_mut()
				&& matches!(fields.first(), Some(("Type", V::Str(kind))) if kind == b"Lit")
			{
				for (key, value) in fields {
					if matches!(*key, "End" | "ValueEnd") {
						*value = self.m.pos(doc_end);
					}
				}
			}
			parts
		}

		/// The shfmt command and its parser-recorded extent, without surrounding
		/// redirections. Synthesized groups retain only their enclosing range.
		fn command(&self, c: &Command) -> (Option<V>, u32) {
			let Span { lo, hi } = c.extent.unwrap_or(c.span);
			let p = |o| self.m.pos(o);
			// The closing token's own offset is the parser's to record. A
			// command it synthesized rather than read has none, and the
			// export then carries none: subtracting a byte from the span's
			// end invents a position that text an alias expanded has not
			// got, and lands inside a neighbouring node.
			let close = |f: &mut Vec<(&'static str, V)>, key: &'static str| {
				if let Some(at) = c.close {
					f.push((key, p(at)));
				}
			};
			let v = match &c.kind {
				CommandKind::Simple(sc) => return self.simple(sc),
				CommandKind::Brace(l) => {
					let mut f = vec![("Type", s(b"Block")), ("Pos", p(lo)), ("End", p(hi))];
					if let Some(span) = c.extent {
						f.push(("Lbrace", p(span.lo)));
					}
					close(&mut f, "Rbrace");
					f.push(("Stmts", self.list(l)));
					V::Obj(f)
				},
				CommandKind::Subshell(l) => {
					let mut f = vec![("Type", s(b"Subshell")), ("Pos", p(lo)), ("End", p(hi))];
					if let Some(span) = c.extent {
						f.push(("Lparen", p(span.lo)));
					}
					close(&mut f, "Rparen");
					f.push(("Stmts", self.list(l)));
					V::Obj(f)
				},
				CommandKind::If(i) => self.if_clause(
					&IfClause {
						hi,
						close: c.close,
						else_body: i.else_body.as_ref(),
						else_pos: i.else_pos,
					},
					&i.arms,
					true,
					Some(lo),
				),
				CommandKind::While(w) => {
					let mut f = vec![
						("Type", s(b"WhileClause")),
						("Pos", p(lo)),
						("End", p(hi)),
						("WhilePos", p(lo)),
					];
					if let Some(at) = w.do_pos {
						f.push(("DoPos", p(at)));
					}
					close(&mut f, "DonePos");
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
						("Pos", p(fr.header.lo)),
						("End", p(fr.header.hi)),
						("Name", self.lit_value(fr.var_span.lo, fr.var_span.hi, &fr.var, false)),
					];
					if let Some(extra) = self.extra_names(&fr.extra_vars) {
						iter.push(("ExtraNames", extra));
					}
					if let Some(ws) = &fr.words {
						if let Some(at) = fr.in_pos {
							iter.push(("InPos", p(at)));
						}
						if !ws.is_empty() {
							iter.push(("Items", V::Arr(ws.iter().map(|w| self.word(w, false)).collect())));
						}
					}
					self.for_clause(
						&ForClause {
							lo,
							hi,
							close: c.close,
							select,
							do_pos: fr.do_pos,
							braces: fr.braces,
						},
						V::Obj(iter),
						&fr.body,
					)
				},
				CommandKind::ArithFor(a) => {
					let mut l = vec![
						("Type", s(b"CStyleLoop")),
						("Pos", p(a.header.lo)),
						("End", p(a.header.hi)),
						("Lparen", p(a.header.lo)),
						("Rparen", p(a.rparen)),
					];
					for (k, t) in [("Init", &a.init), ("Cond", &a.cond), ("Post", &a.step)] {
						if let Some(x) = self.arith(t) {
							l.push((k, x));
						}
					}
					self.for_clause(
						&ForClause {
							lo,
							hi,
							close: c.close,
							select: false,
							do_pos: a.do_pos,
							braces: a.braces,
						},
						V::Obj(l),
						&a.body,
					)
				},
				CommandKind::Case(cs) => {
					let mut items = Vec::new();
					let mut at = lo;
					for arm in &cs.arms {
						let plo = arm.patterns.first().map_or(at, |w| w.span.lo);
						// An arm with no body ends after the `)` that closes
						// its patterns, which the parser recorded. Where it
						// recorded none — zsh's `(x)` arm reads its `)` on
						// another branch — the arm ends at its last pattern:
						// a byte past it is a byte of whatever follows, and
						// in text an alias expanded it is not the arm's at
						// all.
						let body_end = arm.body.items.last().map_or_else(
							|| {
								arm.rparen
									.map_or_else(|| arm.patterns.last().map_or(plo, |w| w.span.hi), |r| r.hi)
							},
							|it| it.and_or.span.hi,
						);
						let op: &[u8] = match arm.term {
							CaseTerm::Break => b";;",
							CaseTerm::FallThrough => b";&",
							CaseTerm::Continue => b";;&",
						};
						// The parser records the terminator it read. `None`
						// means the arm ended at `esac` with none written, so
						// there is nothing to point at: scanning forward for
						// one finds the terminator of an enclosing arm.
						let end = arm.term_span.map_or(body_end, |t| t.hi);
						let mut f = vec![("Pos", p(plo)), ("End", p(end)), ("Op", s(op))];
						if let Some(t) = arm.term_span {
							f.push(("OpPos", p(t.lo)));
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
					let mut f =
						vec![("Type", s(b"CaseClause")), ("Pos", p(lo)), ("End", p(hi)), ("Case", p(lo))];
					if let Some(at) = cs.in_pos {
						f.push(("In", p(at)));
					}
					close(&mut f, "Esac");
					f.push(("Word", self.word(&cs.word, false)));
					if !items.is_empty() {
						f.push(("Items", V::Arr(items)));
					}
					V::Obj(f)
				},
				CommandKind::Arith(a) => {
					let mut f =
						vec![("Type", s(b"ArithmCmd")), ("Pos", p(lo)), ("End", p(hi)), ("Left", p(lo))];
					close(&mut f, "Right");
					if let Some(x) = self.arith(a) {
						f.push(("X", x));
					}
					V::Obj(f)
				},
				CommandKind::Cond(e) => {
					let mut f =
						vec![("Type", s(b"TestClause")), ("Pos", p(lo)), ("End", p(hi)), ("Left", p(lo))];
					close(&mut f, "Right");
					f.push(("X", self.test(e)));
					V::Obj(f)
				},
				CommandKind::FuncDef(fd) => {
					let mut f = vec![
						("Type", s(b"FuncDecl")),
						("Pos", p(c.span.lo)),
						("End", p(c.span.hi)),
						("Position", p(lo)),
					];
					if fd.keyword {
						f.push(("RsrvWord", V::Bool(true)));
					}
					if fd.parens {
						f.push(("Parens", V::Bool(true)));
					}
					f.push(("Name", self.lit_value(fd.name_span.lo, fd.name_span.hi, &fd.name, false)));
					if let Some(extra) = self.extra_names(&fd.extra_names) {
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
						f.push((
							"Name",
							V::Obj(vec![
								("Pos", p(name.span.lo)),
								("End", p(name.span.hi)),
								(
									"Parts",
									V::Arr(vec![self.lit_with(name.span.lo, name.span.hi, &name.text)]),
								),
							]),
						));
					}
					f.push(("Stmt", self.stmt(self.stage(&cp.body))));
					return (Some(V::Obj(f)), c.span.hi);
				},
				CommandKind::Repeat(r) => {
					let mut f = vec![
						("Type", s(b"RepeatClause")),
						("Pos", p(lo)),
						("End", p(hi)),
						("RepeatPos", p(lo)),
						("Count", self.word(&r.count, true)),
					];
					if let Some(at) = r.do_pos {
						f.push(("DoPos", p(at)));
					}
					close(&mut f, "DonePos");
					f.push(("Do", self.list(&r.body)));
					V::Obj(f)
				},
				CommandKind::Try(t) => {
					let mut f = vec![
						("Type", s(b"TryClause")),
						("Pos", p(lo)),
						("End", p(hi)),
						("Body", self.list(&t.body)),
						("Rbrace", p(t.rbrace)),
						("AlwaysPos", p(t.always_pos)),
						("Always", self.list(&t.always)),
					];
					close(&mut f, "AlwaysEnd");
					V::Obj(f)
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
		/// first one: their `Lit`s, at the spans the parser read them at,
		/// or `None` when there are none.
		fn extra_names(&self, names: &[Name]) -> Option<V> {
			(!names.is_empty()).then(|| {
				V::Arr(
					names
						.iter()
						.map(|n| self.lit_value(n.span.lo, n.span.hi, &n.text, false))
						.collect(),
				)
			})
		}

		fn for_clause(&self, c: &ForClause, lp: V, body: &List) -> V {
			let p = |o| self.m.pos(o);
			let mut f = vec![
				("Type", s(b"ForClause")),
				("Pos", p(c.lo)),
				("End", p(c.hi)),
				("ForPos", p(c.lo)),
			];
			if let Some(at) = c.do_pos {
				f.push(("DoPos", p(at)));
			}
			if let Some(at) = c.close {
				f.push(("DonePos", p(at)));
			}
			if c.select {
				f.push(("Select", V::Bool(true)));
			}
			if c.braces {
				f.push(("Braces", V::Bool(true)));
			}
			f.push(("Loop", lp));
			f.push(("Do", self.list(body)));
			V::Obj(f)
		}

		fn if_clause(&self, c: &IfClause<'_>, arms: &[IfArm], typed: bool, pos: Option<u32>) -> V {
			let p = |o| self.m.pos(o);
			let Some((arm, rest)) = arms.split_first() else {
				return V::Null;
			};
			let mut f = Vec::new();
			if typed {
				f.push(("Type", s(b"IfClause")));
			}
			if let Some(at) = pos {
				f.push(("Pos", p(at)));
			}
			f.push(("End", p(c.hi)));
			if let Some(at) = pos {
				f.push(("Position", p(at)));
			}
			if let Some(at) = arm.then_pos {
				f.push(("ThenPos", p(at)));
			}
			if let Some(at) = c.close {
				f.push(("FiPos", p(at)));
			}
			f.push(("Cond", self.list(&arm.cond)));
			f.push(("Then", self.list(&arm.body)));
			if let Some((next, _)) = rest.split_first() {
				f.push(("Else", self.if_clause(c, rest, false, next.kw_pos)));
			} else if let Some(e) = c.else_body {
				let mut g = Vec::new();
				if let Some(at) = c.else_pos {
					g.push(("Pos", p(at)));
				}
				g.push(("End", p(c.hi)));
				if let Some(at) = c.else_pos {
					g.push(("Position", p(at)));
				}
				if let Some(at) = c.close {
					g.push(("FiPos", p(at)));
				}
				g.push(("Then", self.list(e)));
				f.push(("Else", V::Obj(g)));
			}
			V::Obj(f)
		}

		/// An arithmetic expression as one `Word` leaf.
		fn arith(&self, a: &ArithText) -> Option<V> {
			let start = a
				.src
				.iter()
				.position(|c| !matches!(c, b' ' | b'\t' | b'\n'))?;
			let end = a
				.src
				.iter()
				.rposition(|c| !matches!(c, b' ' | b'\t' | b'\n'))?
				+ 1;
			let mut word = vec![("Type", s(b"Word"))];
			self.span_fields(&mut word, a.trimmed);
			word.push(("Parts", V::Arr(vec![self.lit_optional(a.trimmed, &a.src[start..end], true)])));
			Some(V::Obj(word))
		}

		fn test(&self, e: &CondExpr) -> V {
			let p = |o| self.m.pos(o);
			match e {
				CondExpr::Word(w) => self.word(w, true),
				CondExpr::Unary { op, op_lo, arg } => V::Obj(vec![
					("Type", s(b"UnaryTest")),
					("Pos", p(*op_lo)),
					("End", p(arg.span.hi)),
					("OpPos", p(*op_lo)),
					("Op", s(op)),
					("X", self.word(arg, true)),
				]),
				CondExpr::Binary { op, op_lo, lhs, rhs } => V::Obj(vec![
					("Type", s(b"BinaryTest")),
					("Pos", p(lhs.span.lo)),
					("End", p(rhs.span.hi)),
					("OpPos", p(*op_lo)),
					("Op", s(op)),
					("X", self.word(lhs, true)),
					("Y", self.word(rhs, true)),
				]),
				CondExpr::Not { lo, rest, expr } => {
					// Every `!` of the run carries the offset the parser read
					// it at; wrapping from the innermost out keeps this a
					// loop, as the run itself is.
					let hi = Self::test_span(expr).1;
					let mut v = self.test(expr);
					for &olo in std::iter::once(lo).chain(rest.iter()).rev() {
						v = V::Obj(vec![
							("Type", s(b"UnaryTest")),
							("Pos", p(olo)),
							("End", p(hi)),
							("OpPos", p(olo)),
							("Op", s(b"!")),
							("X", v),
						]);
					}
					v
				},
				CondExpr::Group { lparen, rparen, rparen_hi, expr } => V::Obj(vec![
					("Type", s(b"ParenTest")),
					("Pos", p(*lparen)),
					("End", p(*rparen_hi)),
					("Lparen", p(*lparen)),
					("Rparen", p(*rparen)),
					("X", self.test(expr)),
				]),
				CondExpr::And(terms, ops) | CondExpr::Or(terms, ops) => {
					let op: &[u8] = if matches!(e, CondExpr::And(..)) {
						b"&&"
					} else {
						b"||"
					};
					let (last, rest) = terms.split_last().expect("logical chain has operands");
					let (_, end) = Self::test_span(last);
					let mut rhs = self.test(last);
					for (lhs, &olo) in rest.iter().zip(ops.iter()).rev() {
						let (lo, _) = Self::test_span(lhs);
						rhs = V::Obj(vec![
							("Type", s(b"BinaryTest")),
							("Pos", p(lo)),
							("End", p(end)),
							("OpPos", p(olo)),
							("Op", s(op)),
							("X", self.test(lhs)),
							("Y", rhs),
						]);
					}
					rhs
				},
			}
		}

		/// Source extent of a `[[ ]]` expression. Every operator carries
		/// the offset the parser read it at, so no part of the extent is
		/// recovered by reading the source back.
		fn test_span(e: &CondExpr) -> (u32, u32) {
			match e {
				CondExpr::Word(w) => (w.span.lo, w.span.hi),
				CondExpr::Unary { op_lo, arg, .. } => (*op_lo, arg.span.hi),
				CondExpr::Binary { lhs, rhs, .. } => (lhs.span.lo, rhs.span.hi),
				CondExpr::Not { lo, expr, .. } => (*lo, Self::test_span(expr).1),
				CondExpr::Group { lparen, rparen_hi, .. } => (*lparen, *rparen_hi),
				CondExpr::And(terms, _) | CondExpr::Or(terms, _) => {
					let first = terms.first().expect("logical chain has operands");
					let last = terms.last().expect("logical chain has operands");
					(Self::test_span(first).0, Self::test_span(last).1)
				},
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
				&& let [part] = &head.parts[..]
				&& let Some(name) = Self::decl_bytes(part)
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
						("Variant", self.lit_value(head.span.lo, head.span.hi, name, false)),
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
			f.push(("Name", self.lit_optional(a.name_span, &a.name, false)));
			if let Some(i) = &a.index
				&& let Some(index) = self.optional_word(i.span.recorded(), self.parts(&i.parts), true)
			{
				f.push(("Index", index));
			}
			match &a.value {
				AssignValue::Scalar(w) => {
					if let Some(value) =
						self.optional_word(w.span.recorded(), self.parts(&w.parts), false)
					{
						f.push(("Value", value));
					}
				},
				AssignValue::Array(elems) => {
					f.push(("Array", self.array(elems)));
				},
			}
			V::Obj(f)
		}

		fn array(&self, array: &CompoundArray) -> V {
			let p = |o| self.m.pos(o);
			let es: Vec<V> = array
				.iter()
				.map(|e| {
					let mut f = Vec::new();
					if let Some(lo) = e.lo {
						f.push(("Pos", p(lo)));
					}
					f.push(("End", p(e.value.span.hi)));
					if let Some(k) = &e.key
						&& let Some(index) =
							self.optional_word(k.span.recorded(), self.parts(&k.parts), true)
					{
						f.push(("Index", index));
					}
					if let Some(value) =
						self.optional_word(e.value.span.recorded(), self.parts(&e.value.parts), false)
					{
						f.push(("Value", value));
					}
					V::Obj(f)
				})
				.collect();
			let mut f = Vec::new();
			if let Some(lo) = array.lparen {
				f.push(("Pos", p(lo)));
			}
			if let Some(close) = array.rparen {
				f.push(("End", p(close.hi)));
			}
			if let Some(lo) = array.lparen {
				f.push(("Lparen", p(lo)));
			}
			if let Some(close) = array.rparen {
				f.push(("Rparen", p(close.lo)));
			}
			if !es.is_empty() {
				f.push(("Elems", V::Arr(es)));
			}
			V::Obj(f)
		}

		fn decl_bytes(part: &WordPart) -> Option<&[u8]> {
			match part {
				WordPart::Lit(text) => Some(text.as_slice()),
				WordPart::Zsh(text) => Some(text.as_slice()),
				_ => None,
			}
		}

		fn decl_arg(&self, w: &Word) -> V {
			let p = |o| self.m.pos(o);
			let lo = w.span.lo;
			let hi = w.span.hi;
			// `name=(…)` and `name=value`.
			if let Some(part) = w.parts.first()
				&& let Some(first) = Self::decl_bytes(part)
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
				f.push(("Name", self.lit_optional(w.assignment.map(|a| a.name), name, false)));
				if let Some(WordPart::Compound(elems)) = w.parts.get(1) {
					f.push(("Array", self.array(elems)));
				} else {
					let mut rest = w.parts.clone();
					if let Some(WordPart::Lit(l)) = rest.first_mut() {
						l.value.remove_prefix(eq + 1);
						l.pos = w.assignment.map(|a| {
							let span = Span::new(a.value_lo, l.pos.map_or(hi, |p| p.span.hi));
							PartSpan { span, content: span, close: None }
						});
						if l.is_empty() {
							rest.remove(0);
						}
					}
					if let Some(value) = self.optional_word(
						w.assignment.map(|a| Span::new(a.value_lo, hi)),
						self.parts(&rest),
						false,
					) {
						f.push(("Value", value));
					}
				}
				return V::Obj(f);
			}
			let mut f = vec![("Pos", p(lo)), ("End", p(hi)), ("Naked", V::Bool(true))];
			match &w.parts[..] {
				[WordPart::Lit(n)] if crate::bash::syntax::util::is_identifier(n) => {
					f.push(("Name", self.lit_value(lo, hi, n, false)));
				},
				_ => {
					if let Some(value) =
						self.optional_word(w.span.recorded(), self.parts(&w.parts), false)
					{
						f.push(("Value", value));
					}
				},
			}
			V::Obj(f)
		}

		/// A word; `typed` adds `"Type": "Word"` (interface positions).
		fn word(&self, w: &Word, typed: bool) -> V {
			let parts = self.parts(&w.parts);
			let mut f = Vec::new();
			if typed {
				f.push(("Type", s(b"Word")));
			}
			self.span_fields(&mut f, w.span.recorded());
			if !parts.is_empty() {
				f.push(("Parts", V::Arr(parts)));
			}
			V::Obj(f)
		}

		/// Optional shfmt words need a part; unlike native nodes, they cannot
		/// distinguish a present empty operand from an absent operand.
		fn optional_word(&self, span: Option<Span>, parts: Vec<V>, typed: bool) -> Option<V> {
			if parts.is_empty() {
				return None;
			}
			let mut fields = Vec::new();
			if typed {
				fields.push(("Type", s(b"Word")));
			}
			self.span_fields(&mut fields, span);
			fields.push(("Parts", V::Arr(parts)));
			Some(V::Obj(fields))
		}

		fn append_literal(
			run: &mut Option<(Option<Span>, Vec<u8>)>,
			span: Option<Span>,
			bytes: &[u8],
		) {
			if bytes.is_empty() {
				return;
			}
			let (extent, text) = run.get_or_insert_with(|| (span, Vec::with_capacity(bytes.len())));
			*extent = extent.zip(span).map(|(a, b)| Span::new(a.lo, b.hi));
			text.extend_from_slice(bytes);
		}

		/// Literal runs keep the bytes held by the parsed parts. A source
		/// range locates a part; it is not the value of alias-expanded text.
		fn parts(&self, parts: &[WordPart]) -> Vec<V> {
			let mut out = Vec::new();
			let mut run: Option<(Option<Span>, Vec<u8>)> = None;
			for part in parts {
				if let WordPart::Lit(literal) = part {
					let span = literal.pos.map(|pos| pos.span);
					let mut start = 0;
					let mut lo = span.map(|span| span.lo);
					for &(index, token) in &literal.value.dollars {
						Self::append_literal(
							&mut run,
							lo.map(|lo| Span::new(lo, token.lo)),
							&literal.value.bytes[start..index],
						);
						if let Some((span, text)) = run.take() {
							out.push(self.lit_at(span, text, true));
						}
						out.push(self.lit_with(token.lo, token.hi, b"$"));
						start = index + 1;
						lo = Some(token.hi);
					}
					Self::append_literal(
						&mut run,
						lo.zip(span).map(|(lo, span)| Span::new(lo, span.hi)),
						&literal.value.bytes[start..],
					);
					continue;
				}
				let literal = matches!(
					part,
					WordPart::Escaped(_)
						| WordPart::BadSubst(_)
						| WordPart::BadComsub(_)
						| WordPart::DroppedQuote(_)
						| WordPart::Zsh(_)
				);
				if literal {
					let span = part.pos().map(|p| p.span);
					let (extent, text) = run.get_or_insert_with(|| (span, Vec::new()));
					*extent = extent.zip(span).map(|(a, b)| Span::new(a.lo, b.hi));
					crate::bash::syntax::print::parts_text(core::slice::from_ref(part), text);
					continue;
				}
				if let Some((span, text)) = run.take() {
					out.push(self.lit_at(span, text, true));
				}
				out.push(self.part(part));
			}
			if let Some((span, text)) = run {
				out.push(self.lit_at(span, text, true));
			}
			out
		}

		fn span_fields(&self, fields: &mut Vec<(&'static str, V)>, span: Option<Span>) {
			if let Some(span) = span {
				fields.push(("Pos", self.m.pos(span.lo)));
				fields.push(("End", self.m.pos(span.hi)));
			}
		}

		fn part_fields(
			&self,
			kind: &[u8],
			pos: Option<PartSpan>,
			left: &'static str,
			right: &'static str,
		) -> Vec<(&'static str, V)> {
			let mut fields = vec![("Type", s(kind))];
			self.span_fields(&mut fields, pos.map(|p| p.span));
			if let Some(pos) = pos {
				fields.push((left, self.m.pos(pos.span.lo)));
				if let Some(close) = pos.close {
					fields.push((right, self.m.pos(close.lo)));
				}
			}
			fields
		}

		fn part(&self, part: &WordPart) -> V {
			let pos = part.pos();
			match part {
				WordPart::SQuote(v) | WordPart::AnsiC(v) => {
					let mut f = self.part_fields(b"SglQuoted", pos, "Left", "Right");
					if matches!(part, WordPart::AnsiC(_)) {
						f.push(("Dollar", V::Bool(true)));
					}
					if !v.is_empty() {
						f.push(("Value", s(v)));
					}
					V::Obj(f)
				},
				WordPart::DQuote(inner) | WordPart::Locale(inner) => {
					let mut f = self.part_fields(b"DblQuoted", pos, "Left", "Right");
					if matches!(part, WordPart::Locale(_)) {
						f.push(("Dollar", V::Bool(true)));
					}
					let parts = self.parts(inner);
					if !parts.is_empty() {
						f.push(("Parts", V::Arr(parts)));
					}
					V::Obj(f)
				},
				WordPart::Param(pp) => self.param(pp),
				WordPart::Comsub(c) => {
					let mut f = self.part_fields(b"CmdSubst", pos, "Left", "Right");
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
					let mut f = self.part_fields(b"ArithmExp", pos, "Left", "Right");
					if a.bracket {
						f.push(("Bracket", V::Bool(true)));
					}
					if let Some(x) = self.arith(a) {
						f.push(("X", x));
					}
					V::Obj(f)
				},
				WordPart::ProcSub(ps) => {
					let mut f = self.part_fields(b"ProcSubst", pos, "OpPos", "Rparen");
					f.push(("Op", s(if ps.output { b">(" } else { b"<(" })));
					if !ps.body.items.is_empty() {
						f.push(("Stmts", self.list(&ps.body)));
					}
					V::Obj(f)
				},
				WordPart::Compound(elems) => self.array(elems),
				WordPart::Lit(_)
				| WordPart::Escaped(_)
				| WordPart::BadSubst(_)
				| WordPart::BadComsub(_)
				| WordPart::DroppedQuote(_)
				| WordPart::Zsh(_) => {
					let mut text = Vec::new();
					crate::bash::syntax::print::parts_text(core::slice::from_ref(part), &mut text);
					self.lit_at(pos.map(|p| p.span), text, true)
				},
			}
		}

		fn param(&self, located: &Located<Box<Param>>) -> V {
			let pp = &located.value;
			let p = |o| self.m.pos(o);
			let mut f = vec![("Type", s(b"ParamExp"))];
			self.span_fields(&mut f, located.pos.map(|p| p.span));
			if let Some(pos) = located.pos {
				f.push(("Dollar", p(pos.span.lo)));
			}
			if pp.braced {
				if let Some(close) = located.pos.and_then(|p| p.close) {
					f.push(("Rbrace", p(close.lo)));
				}
			} else {
				f.push(("Short", V::Bool(true)));
			}
			let excl = matches!(pp.op, ParamOp::Indirect | ParamOp::PrefixNames { .. }) || pp.indirect;
			if excl {
				f.push(("Excl", V::Bool(true)));
			}
			if pp.op == ParamOp::Length {
				f.push(("Length", V::Bool(true)));
			}
			let mut name = Vec::new();
			match &pp.name {
				ParamName::Var(v) => name.extend_from_slice(v),
				ParamName::Positional(n) => crate::bash::syntax::util::push_u32(&mut name, *n),
				ParamName::Special(sp) => name.push(special_char(*sp)),
			}
			f.push(("Param", self.lit_optional(pp.name_span, &name, false)));
			match &pp.index {
				Some(Subscript::At | Subscript::Star) => {
					let at: &[u8] = if pp.index == Some(Subscript::At) {
						b"@"
					} else {
						b"*"
					};
					let mut index = vec![("Type", s(b"Word"))];
					self.span_fields(&mut index, pp.index_span);
					index.push(("Parts", V::Arr(vec![self.lit_optional(pp.index_span, at, true)])));
					f.push(("Index", V::Obj(index)));
				},
				Some(Subscript::Expr(w)) => {
					if let Some(index) =
						self.optional_word(w.span.recorded(), self.parts(&w.parts), true)
					{
						f.push(("Index", index));
					}
				},
				None => {},
			}
			let opw = |op: &[u8], w: Option<&Word>| {
				let mut e = vec![("Op", s(op))];
				if let Some(w) = w
					&& let Some(word) =
						self.optional_word(w.span.recorded(), self.parts(&w.parts), false)
				{
					e.push(("Word", word));
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
				ParamOp::Replace { mode, anchor, pat, rep } => {
					let mut r = Vec::new();
					if *mode == ReplaceMode::All {
						r.push(("All", V::Bool(true)));
					}
					let (span, parts) = if let Some(alo) = *anchor {
						let byte = if *mode == ReplaceMode::Suffix {
							b'%'
						} else {
							b'#'
						};
						let mut parts = vec![self.lit_with(alo.lo, alo.hi, &[byte])];
						parts.extend(self.parts(&pat.parts));
						(Some(Span::new(alo.lo, pat.span.hi)), merge_lit_vs(parts))
					} else {
						(pat.span.recorded(), self.parts(&pat.parts))
					};
					if let Some(orig) = self.optional_word(span, parts, false) {
						r.push(("Orig", orig));
					}
					if let Some(w) = rep
						&& let Some(with) =
							self.optional_word(w.span.recorded(), self.parts(&w.parts), false)
					{
						r.push(("With", with));
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
				ParamOp::Transform { op: c, at } => {
					f.push((
						"Exp",
						V::Obj(vec![
							("Op", s(b"@")),
							(
								"Word",
								V::Obj(vec![
									("Pos", p(at.lo)),
									("End", p(at.hi)),
									("Parts", V::Arr(vec![self.lit_with(at.lo, at.hi, &[*c])])),
								]),
							),
						]),
					));
				},
			}
			V::Obj(f)
		}

		fn lit_with(&self, lo: u32, hi: u32, value: &[u8]) -> V {
			self.lit_value(lo, hi, value, true)
		}

		fn lit_optional(&self, span: Option<Span>, value: &[u8], typed: bool) -> V {
			self.lit_at(span, value.to_vec(), typed)
		}

		fn lit_at(&self, span: Option<Span>, value: Vec<u8>, typed: bool) -> V {
			let mut fields = Vec::new();
			if typed {
				fields.push(("Type", s(b"Lit")));
			}
			self.span_fields(&mut fields, span);
			if let Some(span) = span {
				fields.push(("ValuePos", self.m.pos(span.lo)));
				fields.push(("ValueEnd", self.m.pos(span.hi)));
			}
			fields.push(("Value", V::Str(value)));
			V::Obj(fields)
		}
	}

	/// Join a leading anchor `Lit` with a following `Lit` (shfmt keeps
	/// `#x` of `${a/#x/y}` as one literal).
	fn merge_lit_vs(parts: Vec<V>) -> Vec<V> {
		let mut out: Vec<V> = Vec::new();
		for v in parts {
			if let (Some(prev), Some((lo, _))) = (out.last_mut(), lit_span(&v))
				&& let Some((_, end)) = lit_span(prev)
				&& end == lo
			{
				let V::Obj(before) = prev else {
					unreachable!("a literal is an object")
				};
				let V::Obj(after) = v else {
					unreachable!("a literal is an object")
				};
				for (key, value) in after {
					if let Some((_, old)) = before.iter_mut().find(|(name, _)| *name == key) {
						match (key, old, value) {
							("Value", V::Str(a), V::Str(mut b)) => a.append(&mut b),
							("End" | "ValueEnd", old, value) => *old = value,
							_ => {},
						}
					}
				}
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
}
