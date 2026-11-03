//! zsh function text: a port of zsh 5.9 `Src/text.c` (`getpermtext`,
//! `gettext2`, `getredirs`, the `taddstr` family) and of the function
//! header of `printshfuncnode` (`Src/hashtable.c`), over the zsh AST.
//!
//! This is the text `functions NAME`, `which NAME` and `$functions[NAME]`
//! show: one command per line, a tab per nesting level, bodies of
//! compound commands on their own lines, here-document bodies after the
//! line that opens them. The engine stores it as a zsh function's source;
//! parsing it again with the zsh grammar gives back the same tree, so
//! printing that tree gives back the same text.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use alloc::vec::Vec;

use super::tok::{INBRACK, OUTBRACK, head, tail};
use crate::bash::syntax::{ast::*, print::zsh_text, util::push_u32};

/// zsh `getpermtext(prog, NULL, indent)`: the text of `list`, lines after
/// the first indented by `indent` tabs plus nesting. Used for function
/// bodies and by [`crate::bash::syntax::print_list`] with `PrintStyle::Zsh`.
pub fn getpermtext(list: &List, indent: usize) -> Vec<u8> {
	let mut t = Text::new(Vec::new(), indent, 0);
	t.list(list);
	t.dopending();
	t.out
}

/// zsh's text of one command at indentation 0 (its redirections
/// included), for [`crate::bash::syntax::print`] with `PrintStyle::Zsh`.
pub fn command_text(cmd: &Command) -> Vec<u8> {
	let mut t = Text::new(Vec::new(), 0, 0);
	t.command(cmd, false);
	t.dopending();
	t.out
}

/// What `functions NAME` prints for function `f` defined as `name`.
///
/// `name () {`, the body indented by a tab, `}` and the function's
/// redirections, without the final newline. The engine keeps it as the
/// function's source.
pub fn function_text(name: &[u8], f: &FuncDef) -> Vec<u8> {
	function_text_expand(name, f, 0)
}

/// [`function_text`] with zsh's `text_expand_tabs` (`functions -x N`,
/// `which -x N`).
///
/// The indentation zsh adds is a tab per level for `expand` 0, `expand`
/// spaces per level when it is positive, and nothing when it is negative;
/// tabs inside quotes, here-documents and command substitutions stay.
pub fn function_text_expand(name: &[u8], f: &FuncDef, expand: i32) -> Vec<u8> {
	let mut out = Vec::new();
	quoted_name(name, &mut out);
	out.extend_from_slice(b" () {\n");
	let mut t = Text::new(out, 1, expand);
	t.tab();
	let redirs = t.func_body(&f.body);
	t.dopending();
	t.out.extend_from_slice(b"\n}");
	if !redirs.is_empty() {
		t.redirs(redirs, false);
		t.dopending();
	}
	t.out
}

/// The value of `$functions[NAME]` for function `f`: its body as
/// [`function_text`] indents it, with the leading tab.
pub fn body_text(f: &FuncDef) -> Vec<u8> {
	let mut t = Text::new(alloc::vec![b'\t'], 1, 0);
	t.func_body(&f.body);
	t.dopending();
	t.out
}

/// A stored function source ([`function_text`]) re-printed as function
/// `name` with zsh's `text_expand_tabs` = `expand`
/// ([`function_text_expand`]).
///
/// For `functions -x N` / `which -x N`, which only have the source; `None`
/// when `source` is not one function definition.
pub fn reindent_function(name: &[u8], source: &[u8], expand: i32) -> Option<Vec<u8>> {
	let feat = crate::bash::syntax::Features::ZSH
		| crate::bash::syntax::Features::ZSH_SHORT_LOOPS
		| crate::bash::syntax::Features::ZSH_MULTI_FUNC_DEF
		| crate::bash::syntax::Features::ZSH_INTERACTIVE_COMMENTS;
	let mut p = super::driver::ZshParser::new(source, feat, crate::bash::syntax::NO_ALIASES);
	let cc = p.next_command()?.ok()?;
	if p.next_command().is_some() {
		return None;
	}
	let [item] = &cc.list.items[..] else {
		return None;
	};
	let pipe = &item.and_or.first;
	if !item.and_or.rest.is_empty() || pipe.bang || pipe.time.is_some() {
		return None;
	}
	let [stage] = &pipe.stages[..] else {
		return None;
	};
	let CommandKind::FuncDef(f) = &stage.cmd.kind else {
		return None;
	};
	Some(function_text_expand(name, f, expand))
}

/// zsh `quotedzputs` for a function name (no `rcquotes`): as is when it
/// has no special character, `$'…'` when it has an unprintable one, else
/// single-quoted.
fn quoted_name(s: &[u8], out: &mut Vec<u8>) {
	if s.is_empty() {
		out.extend_from_slice(b"''");
		return;
	}
	if s.iter().any(|&c| c < 0x20 || c == 0x7f) {
		out.extend_from_slice(b"$'");
		for &c in s {
			match c {
				b'\n' => out.extend_from_slice(b"\\n"),
				b'\t' => out.extend_from_slice(b"\\t"),
				0x1b => out.extend_from_slice(b"\\e"),
				b'\\' | b'\'' => {
					out.push(b'\\');
					out.push(c);
				},
				c if c < 0x20 || c == 0x7f => {
					out.push(b'\\');
					out.push(b'0' + (c >> 6));
					out.push(b'0' + ((c >> 3) & 7));
					out.push(b'0' + (c & 7));
				},
				c => out.push(c),
			}
		}
		out.push(b'\'');
		return;
	}
	if !s
		.iter()
		.any(|c| b"#$^*()=|{}[]`<>?~;&\n\t \\'\"".contains(c))
	{
		out.extend_from_slice(s);
		return;
	}
	let mut inquote = false;
	for &c in s {
		if c == b'\'' {
			if inquote {
				out.push(b'\'');
				inquote = false;
			}
			out.extend_from_slice(b"\\'");
		} else {
			if !inquote {
				out.push(b'\'');
				inquote = true;
			}
			out.push(c);
		}
	}
	if inquote {
		out.push(b'\'');
	}
}

/// Whether a typeset argument is an assignment (zsh `ENVSTRING`/`ENVARRAY`
/// after a `typeset`-family reserved word): `name[sub][+]=…` with a literal
/// `=` (an ordinary word has the `Equals` token), or `name=(…)`.
fn is_typeset_assign(w: &Word) -> bool {
	match &w.parts[..] {
		[WordPart::Zsh(_), WordPart::Compound(_)] => true,
		[WordPart::Zsh(s)] => {
			let mut i = super::lex::ident_end(s, 0);
			if i == 0 {
				return false;
			}
			if s.get(i) == Some(&INBRACK) {
				super::lex::skipparens(INBRACK, OUTBRACK, s, &mut i);
			}
			if s.get(i) == Some(&b'+') {
				i += 1;
			}
			s.get(i) == Some(&b'=')
		},
		_ => false,
	}
}

/// zsh's text buffer state (`tbuf`, `tindent`, `tpending`; `tnewlins` set).
struct Text {
	out:     Vec<u8>,
	indent:  usize,
	/// Here-document bodies waiting for the next newline.
	pending: Option<Vec<u8>>,
	/// zsh `text_expand_tabs`.
	expand:  i32,
}

impl Text {
	const fn new(out: Vec<u8>, indent: usize, expand: i32) -> Self {
		Self { out, indent, pending: None, expand }
	}

	/// zsh `zoutputtab`: one level of indentation.
	fn tab(&mut self) {
		match usize::try_from(self.expand) {
			Ok(0) => self.out.push(b'\t'),
			Ok(n) => self.out.resize(self.out.len() + n, b' '),
			Err(_) => {},
		}
	}

	/// zsh `taddstr`.
	fn s(&mut self, s: &[u8]) {
		self.out.extend_from_slice(s);
	}

	/// zsh `taddchr`.
	fn c(&mut self, c: u8) {
		self.out.push(c);
	}

	/// zsh `taddnl` with `tnewlins`: pending here-documents, a newline and
	/// the indentation.
	fn nl(&mut self) {
		self.dopending();
		self.out.push(b'\n');
		for _ in 0..self.indent {
			self.tab();
		}
	}

	/// zsh `dec_tindent`.
	const fn dec(&mut self) {
		self.indent = self.indent.saturating_sub(1);
	}

	/// zsh `taddpending`.
	fn addpending(&mut self, body: &[u8], term: &[u8]) {
		let p = self.pending.get_or_insert_with(Vec::new);
		if !p.is_empty() {
			p.push(b'\n');
		}
		p.extend_from_slice(body);
		p.extend_from_slice(term);
	}

	/// zsh `tdopending`.
	fn dopending(&mut self) {
		if let Some(p) = self.pending.take() {
			self.out.push(b'\n');
			self.out.extend_from_slice(&p);
		}
	}

	/// A word (zsh: its token string, untokenized when the text is done).
	fn word(&mut self, w: &Word) {
		for p in &w.parts {
			match p {
				WordPart::Zsh(s) => zsh_text(s, &mut self.out),
				WordPart::Compound(elems) => {
					self.c(b'(');
					self.elems(elems);
					self.c(b')');
				},
				other => {
					crate::bash::syntax::print::parts_text(core::slice::from_ref(other), &mut self.out);
				},
			}
		}
	}

	/// zsh `taddlist`: words separated by spaces.
	fn words(&mut self, ws: &[Word]) {
		for (i, w) in ws.iter().enumerate() {
			if i > 0 {
				self.c(b' ');
			}
			self.word(w);
		}
	}

	/// Array elements separated by spaces (`[k]=v` as zsh's word holds it).
	fn elems(&mut self, elems: &[ArrayElem]) {
		for (i, e) in elems.iter().enumerate() {
			if i > 0 {
				self.c(b' ');
			}
			if let Some(k) = &e.key {
				self.c(b'[');
				self.word(k);
				self.s(if e.append { b"]+=" } else { b"]=" });
			}
			self.word(&e.value);
		}
	}

	/// The `WC_LIST` case of `gettext2`: items on their own lines.
	fn list(&mut self, l: &List) {
		let n = l.items.len();
		for (i, item) in l.items.iter().enumerate() {
			self.sublist(&item.and_or);
			match item.sep {
				Sep::Amp => self.s(b" &"),
				Sep::Disown => self.s(b" &|"),
				_ => {},
			}
			if i + 1 < n {
				self.nl();
			}
		}
	}

	/// The `WC_SUBLIST` case: `a && b || c`.
	fn sublist(&mut self, ao: &AndOr) {
		self.pipeline(&ao.first);
		for (op, p) in &ao.rest {
			self.s(if *op == AndOrOp::And {
				b" && "
			} else {
				b" || "
			});
			self.pipeline(p);
		}
	}

	/// The `WC_SUBLIST` flags, `WC_TIMED` and `WC_PIPE` cases.
	fn pipeline(&mut self, p: &Pipeline) {
		let empty = p.stages.len() == 1 && is_empty(&p.stages[0].cmd);
		if p.bang {
			self.s(if empty && p.time.is_none() {
				b"!"
			} else {
				b"! "
			});
		}
		if p.time.is_some() {
			self.s(b"time");
			if empty {
				return;
			}
			self.c(b' ');
			self.indent += 1;
		}
		if !empty {
			for (i, st) in p.stages.iter().enumerate() {
				if i > 0 {
					self.s(b" | ");
				}
				self.command(&st.cmd, st.pipe_stderr);
			}
		}
		if p.time.is_some() {
			self.dec();
		}
	}

	/// A function body: a group's list (its redirections are returned for
	/// after the `}`), or the command.
	fn func_body<'a>(&mut self, body: &'a Command) -> &'a [Redir] {
		if let CommandKind::Brace(l) = &body.kind {
			self.list(l);
			&body.redirs
		} else {
			self.command(body, false);
			&[]
		}
	}

	/// One command and its redirections (`stderr`: the `2>&1` zsh adds for
	/// `|&`).
	fn command(&mut self, cmd: &Command, stderr: bool) {
		let redirs: &[Redir] = &cmd.redirs;
		match &cmd.kind {
			CommandKind::Simple(s) => self.simple(s),
			CommandKind::Subshell(l) => self.group(b"(", l, b")"),
			CommandKind::Brace(l) => self.group(b"{", l, b"}"),
			CommandKind::Try(t) => {
				self.s(b"{");
				self.indent += 1;
				self.nl();
				self.list(&t.body);
				self.dec();
				self.nl();
				self.s(b"} always {");
				self.indent += 1;
				self.nl();
				self.list(&t.always);
				self.dec();
				self.nl();
				self.s(b"}");
			},
			CommandKind::FuncDef(f) => {
				self.s(&f.name);
				for n in &f.extra_names {
					self.c(b' ');
					self.s(n);
				}
				self.s(b" () {");
				self.indent += 1;
				self.nl();
				let body_redirs = self.func_body(&f.body);
				self.dec();
				self.nl();
				self.s(b"}");
				if !body_redirs.is_empty() {
					self.redirs(body_redirs, false);
				}
			},
			CommandKind::AnonFunc(a) => {
				self.s(b"() {");
				self.indent += 1;
				self.nl();
				let body_redirs = self.func_body(&a.body);
				self.dec();
				self.nl();
				self.s(b"}");
				if !body_redirs.is_empty() {
					self.redirs(body_redirs, false);
				}
				if !a.args.is_empty() {
					self.c(b' ');
					self.words(&a.args);
				}
			},
			CommandKind::For(f) => {
				self.s(b"for ");
				self.s(&f.var);
				for v in &f.extra_vars {
					self.c(b' ');
					self.s(v);
				}
				if let Some(ws) = &f.words {
					self.s(b" in ");
					self.words(ws);
				}
				self.nl();
				self.s(b"do");
				self.indent += 1;
				self.nl();
				self.list(&f.body);
				self.dec();
				self.nl();
				self.s(b"done");
			},
			CommandKind::ArithFor(f) => {
				self.s(b"for ((");
				zsh_text(&f.init.src, &mut self.out);
				self.s(b"; ");
				zsh_text(&f.cond.src, &mut self.out);
				self.s(b"; ");
				zsh_text(&f.step.src, &mut self.out);
				self.s(b")) do");
				self.indent += 1;
				self.nl();
				self.list(&f.body);
				self.dec();
				self.nl();
				self.s(b"done");
			},
			CommandKind::Select(f) => {
				self.s(b"select ");
				self.s(&f.var);
				if let Some(ws) = &f.words {
					self.s(b" in ");
					self.words(ws);
				}
				self.nl();
				self.s(b"do");
				self.nl();
				self.indent += 1;
				self.list(&f.body);
				self.dec();
				self.nl();
				self.s(b"done");
			},
			CommandKind::While(w) => {
				self.s(if w.until { b"until " } else { b"while " });
				self.indent += 1;
				self.list(&w.cond);
				self.dec();
				self.nl();
				self.s(b"do");
				self.indent += 1;
				self.nl();
				self.list(&w.body);
				self.dec();
				self.nl();
				self.s(b"done");
			},
			CommandKind::Repeat(r) => {
				self.s(b"repeat ");
				self.word(&r.count);
				self.nl();
				self.s(b"do");
				self.indent += 1;
				self.nl();
				self.list(&r.body);
				self.dec();
				self.nl();
				self.s(b"done");
			},
			CommandKind::Case(c) => self.case(c),
			CommandKind::If(i) => self.if_cmd(i),
			CommandKind::Cond(e) => {
				self.s(b"[[ ");
				self.cond(e);
				self.s(b" ]]");
			},
			CommandKind::Arith(a) => {
				self.s(b"((");
				zsh_text(&a.src, &mut self.out);
				self.s(b"))");
			},
			CommandKind::Coproc(c) => {
				let empty = is_empty(&c.body);
				self.s(if empty { b"coproc" } else { b"coproc " });
				if !empty {
					self.command(&c.body, false);
				}
			},
		}
		if !redirs.is_empty() || stderr {
			self.redirs(redirs, stderr);
		}
	}

	/// The `WC_SUBSH`/`WC_CURSH` cases.
	fn group(&mut self, open: &[u8], l: &List, close: &[u8]) {
		self.s(open);
		self.indent += 1;
		self.nl();
		self.list(l);
		self.dec();
		self.nl();
		self.s(close);
	}

	/// The `WC_ASSIGN`/`WC_SIMPLE`/`WC_TYPESET` cases.
	fn simple(&mut self, s: &Simple) {
		for a in &s.assigns {
			self.s(&a.name);
			if let Some(i) = &a.index {
				self.c(b'[');
				self.word(i);
				self.c(b']');
			}
			if a.append {
				self.c(b'+');
			}
			self.c(b'=');
			match &a.value {
				AssignValue::Scalar(w) => self.word(w),
				AssignValue::Array(elems) => {
					self.c(b'(');
					self.elems(elems);
					self.c(b')');
				},
			}
			self.c(b' ');
		}
		let split = s
			.words
			.iter()
			.skip(1)
			.position(is_typeset_assign)
			.map(|i| i + 1);
		let Some(k) = split else {
			self.words(&s.words);
			return;
		};
		self.words(head(&s.words, k));
		self.c(b' ');
		for w in tail(&s.words, k) {
			self.word(w);
			self.c(b' ');
		}
	}

	/// The `WC_CASE` case.
	fn case(&mut self, c: &Case) {
		self.s(b"case ");
		self.word(&c.word);
		self.s(b" in");
		if c.arms.is_empty() {
			self.nl();
			self.s(b"esac");
			return;
		}
		self.indent += 1;
		for (i, arm) in c.arms.iter().enumerate() {
			if i > 0 {
				self.dec();
				self.case_term(c.arms[i - 1].term);
			}
			self.nl();
			self.c(b'(');
			for (j, p) in arm.patterns.iter().enumerate() {
				if j > 0 {
					self.s(b" | ");
				}
				self.word(p);
			}
			self.s(b") ");
			self.indent += 1;
			self.list(&arm.body);
		}
		self.dec();
		self.case_term(c.arms[c.arms.len() - 1].term);
		self.dec();
		self.nl();
		self.s(b"esac");
	}

	/// ` ;;`, ` ;&`, ` ;|`.
	fn case_term(&mut self, t: CaseTerm) {
		self.s(match t {
			CaseTerm::Break => b" ;;",
			CaseTerm::FallThrough => b" ;&",
			CaseTerm::Continue => b" ;|",
		});
	}

	/// The `WC_IF` case.
	fn if_cmd(&mut self, i: &If) {
		for (n, arm) in i.arms.iter().enumerate() {
			if n > 0 {
				self.dec();
				self.nl();
				self.s(b"elif ");
			} else {
				self.s(b"if ");
			}
			self.indent += 1;
			self.list(&arm.cond);
			self.dec();
			self.nl();
			self.s(b"then");
			self.indent += 1;
			self.nl();
			self.list(&arm.body);
		}
		if let Some(e) = &i.else_body {
			self.dec();
			self.nl();
			self.s(b"else");
			self.indent += 1;
			self.nl();
			self.list(e);
		}
		self.dec();
		self.nl();
		self.s(b"fi");
	}

	/// The `WC_COND` case: zsh re-adds parentheses around `||` inside `&&`
	/// (and the reverse) and around a negated `!`/`&&`/`||`.
	fn cond(&mut self, e: &CondExpr) {
		match ungroup(e) {
			CondExpr::Not(x) => {
				self.s(b"! ");
				self.cond_paren(x, |x| {
					matches!(x, CondExpr::Not(_) | CondExpr::And(..) | CondExpr::Or(..))
				});
			},
			CondExpr::And(a, b) => {
				self.cond_paren(a, |x| matches!(x, CondExpr::Or(..)));
				self.s(b" && ");
				self.cond_paren(b, |x| matches!(x, CondExpr::Or(..)));
			},
			CondExpr::Or(a, b) => {
				self.cond_paren(a, |x| matches!(x, CondExpr::And(..)));
				self.s(b" || ");
				self.cond_paren(b, |x| matches!(x, CondExpr::And(..)));
			},
			CondExpr::Unary { op, arg } => {
				self.s(op);
				self.c(b' ');
				if let [WordPart::Zsh(_)] = &arg.parts[..] {
					self.word(arg);
				} else {
					for (i, p) in arg.parts.iter().enumerate() {
						if i > 0 {
							self.c(b' ');
						}
						if let WordPart::Zsh(s) = p {
							zsh_text(s, &mut self.out);
						}
					}
				}
			},
			CondExpr::Binary { op, lhs, rhs } => {
				self.word(lhs);
				self.c(b' ');
				self.s(op);
				self.c(b' ');
				self.word(rhs);
			},
			CondExpr::Word(w) => {
				self.s(b"-n ");
				self.word(w);
			},
			CondExpr::Group(x) => self.cond(x),
		}
	}

	/// An operand, in `( … )` when `paren` holds for it.
	fn cond_paren(&mut self, e: &CondExpr, paren: impl Fn(&CondExpr) -> bool) {
		let inner = ungroup(e);
		if paren(inner) {
			self.s(b"( ");
			self.cond(inner);
			self.s(b" )");
		} else {
			self.cond(inner);
		}
	}

	/// zsh `getredirs`: ` r1 r2 …`.
	fn redirs(&mut self, rs: &[Redir], stderr: bool) {
		self.c(b' ');
		for r in rs {
			self.redir(r);
			self.c(b' ');
		}
		if stderr {
			self.s(b"2>&1 ");
		}
		self.out.pop();
	}

	/// One redirection of `getredirs`.
	fn redir(&mut self, r: &Redir) {
		let read = matches!(
			r.op,
			RedirOp::In
				| RedirOp::ReadWrite
				| RedirOp::HereDoc { .. }
				| RedirOp::HereString
				| RedirOp::DupIn
		);
		match &r.fd {
			Some(RedirFd::Var(v)) => {
				self.c(b'{');
				self.s(v);
				self.c(b'}');
			},
			Some(RedirFd::Num(n)) if *n != u32::from(!read) => push_u32(&mut self.out, *n),
			_ => {},
		}
		let op: &[u8] = match r.op {
			RedirOp::Out => b">",
			RedirOp::Clobber => b">|",
			RedirOp::Append => b">>",
			RedirOp::AppendClobber => b">>|",
			RedirOp::OutErr => b"&>",
			RedirOp::OutErrClobber => b"&>|",
			RedirOp::AppendErr => b"&>>",
			RedirOp::AppendErrClobber => b"&>>|",
			RedirOp::ReadWrite => b"<>",
			RedirOp::In => b"<",
			RedirOp::HereDoc { .. } => b"<<",
			RedirOp::HereString => b"<<<",
			RedirOp::DupIn => b"<&",
			RedirOp::DupOut => b">&",
		};
		self.s(op);
		match &r.target {
			RedirTarget::HereDoc(d) => {
				self.s(&d.delim_raw);
				self.addpending(&d.text, &d.delim);
			},
			RedirTarget::Word(w) => {
				if !matches!(r.op, RedirOp::DupIn | RedirOp::DupOut) {
					self.c(b' ');
				}
				self.word(w);
			},
		}
	}
}

/// The expression inside any `( … )` groups.
fn ungroup(mut e: &CondExpr) -> &CondExpr {
	while let CondExpr::Group(x) = e {
		e = x;
	}
	e
}

/// The empty command of `!`, `time`, `coproc` with nothing after them.
const fn is_empty(c: &Command) -> bool {
	matches!(&c.kind, CommandKind::Simple(s) if s.assigns.is_empty() && s.words.is_empty())
		&& c.redirs.is_empty()
}
