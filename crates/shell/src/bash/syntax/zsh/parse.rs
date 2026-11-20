//! The zsh 5.9 parser: a port of `Src/parse.c` (`parse_event`, `par_event`,
//! `par_list`, `par_sublist`, `par_pline`, `par_cmd`, `par_for`,
//! `par_case`, `par_if`, `par_while`, `par_repeat`, `par_subsh`,
//! `par_funcdef`, `par_time`, `par_dinbrack`, `par_simple`, `par_redir`,
//! `par_wordlist`, `par_nl_wordlist` and the `par_cond` family).
//!
//! zsh's parser emits word code; this port keeps its control flow and token
//! handling and builds the crate's syntax tree ([`Tree`]) instead. As in
//! zsh, a syntax error sets the token to `LEXERR` and unwinds through the
//! callers' token checks (`YYERROR`), so a construct that failed leaves a
//! placeholder that never reaches a successful result.
//!
//! Every word is one [`Pk::Zsh`] part holding zsh's token string.
//! Arithmetic text is zsh's token string too.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use alloc::{vec, vec::Vec};

use super::{
	lex::{
		CS_ALWAYS, CS_ARRAY, CS_CASE, CS_CMDAND, CS_CMDOR, CS_COND, CS_CURSH, CS_ELIF, CS_ELIFTHEN,
		CS_ELSE, CS_ERRPIPE, CS_FOR, CS_FOREACH, CS_FUNCDEF, CS_IF, CS_IFTHEN, CS_PIPE, CS_REPEAT,
		CS_SELECT, CS_SUBSH, CS_UNTIL, CS_WHILE, Ctx, ParseFlags, PendingDoc, T, iblank, ident_end,
		isident, munge_terminator, plain, skipparens,
	},
	tok::{
		BAR, DASH, EQUALS, INANG, INBRACE, INBRACK, INPAR, META, OUTANGPROC, OUTBRACE, OUTBRACK,
		OUTPAR, TILDE, at, head, is_null, span, tail,
	},
};
use crate::bash::syntax::{
	ast::{AndOrOp, CaseTerm, RedirOp, Sep, Time},
	features::Features,
	span::Span,
	tree::{
		AssignB, CondB, FdB, Id, Mark, Payload, Run, TargetB, TextPk, Tree,
		shape::{self, Command as CommandS, Pipeline as PipelineS},
	},
};

/// What `par_cmd` produced: a command node, or a `time` pipeline node that
/// the enclosing pipeline takes over.
enum Cmd {
	/// A command.
	Plain(Id<CommandS>),
	/// `time` and its pipeline.
	Timed(Id<PipelineS>),
}

/// Result of `par_pline`.
enum Pline {
	/// The stage commands.
	Stages(Mark<CommandS>),
	/// A lone `time` pipeline.
	Timed(Id<PipelineS>),
}

/// Which loop `loop_body` parses the body of.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Loop {
	/// `for`/`foreach`/`select`.
	For,
	/// `while`/`until`.
	While,
	/// `repeat`.
	Repeat,
}

/// The placeholder a failed construct leaves (the token is `LEXERR`, so it
/// never reaches a successful parse). A construct that fails part way
/// (`par_case`, `par_if`, `par_for`) leaves the children it had opened on
/// the scratch stack for the enclosing builder to take; that tree is
/// thrown away with the failed event, as `LEXERR` sticks until then.
fn failed(t: &mut Tree) -> Payload {
	Payload::Simple(t.simple(&[], &[], false))
}

/// zsh `IS_DASH`.
const fn is_dash(c: u8) -> bool {
	c == b'-' || c == DASH
}

/// Splits `name[sub]` of an assignment token into the name text and the
/// subscript token string.
fn split_name(s: &[u8]) -> (Vec<u8>, Option<Vec<u8>>, usize) {
	let mut p = 0;
	while p < s.len() && !matches!(at(s, p), INBRACK | b'=' | b'+') {
		p += 1;
	}
	let name = plain(head(s, p));
	if s.get(p) != Some(&INBRACK) {
		return (name, None, p);
	}
	let open = p;
	skipparens(INBRACK, OUTBRACK, s, &mut p);
	let close = if p > open + 1 && s.get(p - 1) == Some(&OUTBRACK) {
		p - 1
	} else {
		p
	};
	(name, Some(span(s, open + 1, close.max(open + 1)).to_vec()), p)
}

/// zsh's pattern massage in `par_case` for a whole `(…)` pattern word:
/// blanks around top-level `|` and the parentheses are removed, then the
/// parentheses themselves. `false` when the word is not one balanced group.
pub(super) fn case_paren_pattern(s: &mut Vec<u8>) -> bool {
	let mut i = 0;
	let mut pct = 0;
	while i < s.len() {
		if at(s, i) == INPAR {
			pct += 1;
		}
		if pct == 0 {
			break;
		}
		if pct == 1 {
			if matches!(at(s, i), BAR | INPAR) {
				while i + 1 < s.len() && iblank(at(s, i + 1)) {
					s.remove(i + 1);
				}
			}
			if matches!(at(s, i), BAR | OUTPAR) {
				while i >= 1 && iblank(at(s, i - 1)) && (i < 2 || at(s, i - 2) != META) {
					s.remove(i - 1);
					i -= 1;
				}
			}
		}
		if at(s, i) == OUTPAR {
			pct -= 1;
		}
		i += 1;
	}
	if i < s.len() || pct != 0 || i == 0 {
		return false;
	}
	s.pop();
	s.remove(0);
	true
}

/// zsh's `redirtab` onto the AST operators.
const fn redir_op(t: T) -> RedirOp {
	match t {
		T::Outangbang => RedirOp::Clobber,
		T::Doutang => RedirOp::Append,
		T::Doutangbang => RedirOp::AppendClobber,
		T::Inang => RedirOp::In,
		T::Inoutang => RedirOp::ReadWrite,
		T::Dinang => RedirOp::HereDoc { strip_tabs: false },
		T::Dinangdash => RedirOp::HereDoc { strip_tabs: true },
		T::Inangamp => RedirOp::DupIn,
		T::Outangamp => RedirOp::DupOut,
		T::Ampoutang => RedirOp::OutErr,
		T::Outangampbang => RedirOp::OutErrClobber,
		T::Doutangamp => RedirOp::AppendErr,
		T::Doutangampbang => RedirOp::AppendErrClobber,
		T::Trinang => RedirOp::HereString,
		_ => RedirOp::Out,
	}
}

/// A token string with its source span (`[[ … ]]` operands).
type Tw = (Vec<u8>, Span);

/// zsh `keyvalpairelement` applied at parse time: `[key]=value` /
/// `[key]+=value` of an array assignment, as an element node of `t`.
fn array_elem(t: &mut Tree, s: &[u8], span: Span) -> Id<shape::Elem> {
	if s.first() == Some(&INBRACK)
		&& let Some(end) = tail(s, 1)
			.iter()
			.position(|&c| c == OUTBRACK)
			.map(|i| i + 1)
	{
		let append = s.get(end + 1) == Some(&b'+') && s.get(end + 2) == Some(&EQUALS);
		if append || s.get(end + 1) == Some(&EQUALS) {
			let vstart = end + 2 + usize::from(append);
			let lo = span.lo;
			let kspan = Span::new(lo + 1, lo + end as u32);
			let vspan = Span::new((lo + vstart as u32).min(span.hi), span.hi);
			let key = t.zword(span_of_bytes(s, 1, end), kspan);
			let value = t.zword(tail(s, vstart), vspan);
			return t.elem(Some(key), append, value);
		}
	}
	let value = t.zword(s, span);
	t.elem(None, false, value)
}

/// The elements of an array value from its token strings, as one run.
fn elems_run(t: &mut Tree, words: &[Tw]) -> Run<shape::Elem> {
	let mark = t.open();
	for (s, sp) in words {
		let e = array_elem(t, s, *sp);
		t.kid(mark, e);
	}
	t.close_run(mark)
}

/// `span(s, a, b)` from the token helpers, under a name that does not clash
/// with [`Span`] values.
fn span_of_bytes(s: &[u8], a: usize, b: usize) -> &[u8] {
	span(s, a, b)
}

impl Ctx<'_> {
	/// `YYERROR`: mark the parse failed.
	const fn yyerr<X>(&mut self) -> Option<X> {
		self.lx.tok = T::Lexerr;
		None
	}

	/// Source span of the current token.
	const fn tok_span(&self) -> Span {
		Span::new(self.lx.lo, self.lx.hi)
	}

	/// The current token as a word.
	fn tok_word(&mut self) -> Id<shape::Word> {
		let span = self.tok_span();
		self.t.zword(&self.lx.buf, span)
	}

	/// The current token string with its span.
	fn tw(&self) -> Tw {
		(self.lx.buf.clone(), self.tok_span())
	}

	/// Skips `SEPER` tokens.
	fn skip_seps(&mut self) {
		while self.lx.tok == T::Seper {
			self.zshlex();
		}
	}

	/// The separator a list item ends with, if the token is one.
	const fn item_sep(&self) -> Option<Sep> {
		match self.lx.tok {
			T::Seper => Some(if self.lx.sep_nl {
				Sep::Newline
			} else {
				Sep::Semi
			}),
			T::Amper => Some(Sep::Amp),
			T::Amperbang => Some(Sep::Disown),
			_ => None,
		}
	}

	/// The parser-state reset `par_cmd` ends with.
	const fn end_cmd(&mut self) {
		self.ps.incmdpos = true;
		self.ps.incasepat = 0;
		self.ps.incond = 0;
		self.ps.intypeset = false;
	}

	/// zsh `parse_event(ENDINPUT)`: the next top-level event (one input
	/// line and the constructs it opens). `false` when no command was
	/// parsed, after an error or at a blank line or the end of input; the
	/// list node otherwise.
	pub(super) fn parse_event_top(&mut self) -> (bool, Id<shape::List>) {
		self.lx.tok = T::Endinput;
		self.ps = ParseFlags { incmdpos: true, ..ParseFlags::default() };
		self.zshlex();
		let items = self.t.open();
		let ok = self.par_event(T::Endinput, items);
		(ok, self.t.list_at(items))
	}

	/// zsh `parse_event(OUTPAR)` as `skipcomm` runs it: validates a command
	/// substitution body; the nodes are not kept.
	pub(super) fn parse_event_nested(&mut self, endtok: T) -> bool {
		if !self.enter() {
			return false;
		}
		self.lx.tok = T::Endinput;
		self.ps.incmdpos = true;
		self.zshlex();
		let items = self.t.open();
		let ok = self.par_event(endtok, items);
		self.t.drop_opened(items);
		self.leave();
		ok
	}

	/// zsh `par_event` (its tail recursion as a loop).
	fn par_event(&mut self, endtok: T, items: Mark<shape::Item>) -> bool {
		let mut first = true;
		loop {
			while self.lx.tok == T::Seper {
				if self.ps.isnewlin > 0 && endtok == T::Endinput {
					return !first && !self.errflag;
				}
				self.zshlex();
			}
			if self.lx.tok == T::Endinput {
				return !first && !self.errflag;
			}
			if self.lx.tok == endtok {
				return true;
			}
			if first && endtok == T::Endinput {
				self.ev_line = self.lx.toklineno;
			}
			let mut r = false;
			if let Some(and_or) = self.par_sublist() {
				let tok = self.lx.tok;
				let sep = if tok == T::Endinput || tok == endtok {
					Some(Sep::None)
				} else {
					self.item_sep()
				};
				if let Some(sep) = sep {
					let item = self.t.item(and_or, sep);
					self.t.kid(items, item);
					r = true;
					match tok {
						T::Seper => {
							if self.ps.isnewlin <= 0 || endtok != T::Endinput {
								self.zshlex();
							}
						},
						T::Amper | T::Amperbang => self.zshlex(),
						_ => {},
					}
				}
			}
			if !r {
				self.err_tok = self.lx.tok;
				self.lx.tok = T::Lexerr;
				if self.errflag {
					self.yyerror(false);
					return false;
				}
				self.yyerror(true);
				self.errflag = true;
				return false;
			}
			first = false;
		}
	}

	/// zsh `par_list`: `{ SEPER } [ sublist [ { SEPER | AMPER | AMPERBANG }
	/// list ] ]`.
	fn par_list(&mut self) -> Id<shape::List> {
		if !self.enter() {
			return self.t.list(&[]);
		}
		let list = self.par_list_items();
		self.leave();
		list
	}

	fn par_list_items(&mut self) -> Id<shape::List> {
		let items = self.t.open();
		loop {
			self.skip_seps();
			let Some(and_or) = self.par_sublist() else {
				break;
			};
			if let Some(sep) = self.item_sep() {
				let item = self.t.item(and_or, sep);
				self.t.kid(items, item);
				self.ps.incmdpos = true;
				loop {
					self.zshlex();
					if self.lx.tok != T::Seper {
						break;
					}
				}
			} else {
				let item = self.t.item(and_or, Sep::None);
				self.t.kid(items, item);
				break;
			}
		}
		self.t.list_at(items)
	}

	/// zsh `par_list1`: one sublist.
	fn par_list1(&mut self) -> Id<shape::List> {
		match self.par_sublist() {
			Some(and_or) => {
				let item = self.t.item(and_or, Sep::None);
				self.t.list(&[item])
			},
			None => self.t.list(&[]),
		}
	}

	/// zsh `par_sublist`: `sublist2 [ ( DBAR | DAMPER ) { SEPER } sublist ]`.
	fn par_sublist(&mut self) -> Option<Id<shape::AndOr>> {
		let lo = self.lx.lo;
		let first = self.par_sublist2()?;
		let pipelines = self.t.open();
		self.t.kid(pipelines, first);
		// zsh recurses with each `&&`/`||` on the cmdstack until it returns.
		let mut pushed = 0usize;
		while matches!(self.lx.tok, T::Dbar | T::Damper) {
			let (op, cs) = if self.lx.tok == T::Dbar {
				(AndOrOp::Or, CS_CMDOR)
			} else {
				(AndOrOp::And, CS_CMDAND)
			};
			self.cmdpush(cs);
			pushed += 1;
			self.zshlex();
			self.skip_seps();
			match self.par_sublist2() {
				Some(p) => {
					self.t.set_connector(p, op);
					self.t.kid(pipelines, p);
				},
				None => break,
			}
		}
		for _ in 0..pushed {
			self.cmdpop();
		}
		Some(self.t.and_or_at(Span::new(lo, self.lx.last_hi), pipelines))
	}

	/// zsh `par_sublist2`: `[ COPROC | BANG ] pline`.
	fn par_sublist2(&mut self) -> Option<Id<PipelineS>> {
		let lo = self.lx.lo;
		let (mut coproc, mut bang) = (false, false);
		if self.lx.tok == T::Coproc {
			coproc = true;
			self.zshlex();
		} else if self.lx.tok == T::Bang {
			bang = true;
			self.zshlex();
		}
		let pl = self.par_pline();
		if pl.is_none() && !coproc && !bang {
			return None;
		}
		let span = Span::new(lo, self.lx.last_hi);
		let mut p = match pl {
			Some(Pline::Timed(tp)) if !coproc => {
				self.t.set_start(tp, lo);
				if !bang {
					return Some(tp);
				}
				let c = self.t.pipeline_command(tp);
				self.t.pipeline(span, false, None, &[c])
			},
			Some(Pline::Timed(tp)) => {
				let c = self.t.pipeline_command(tp);
				self.t.pipeline(span, false, None, &[c])
			},
			Some(Pline::Stages(stages)) => self.t.pipeline_at(span, false, None, stages),
			None => {
				let c = self.t.empty_command(Span::new(span.hi, span.hi));
				self.t.pipeline(span, false, None, &[c])
			},
		};
		if coproc {
			let body = self.t.pipeline_command(p);
			let cp = self.t.coproc(None, body);
			let cmd = self.t.command(span, Payload::Coproc(cp), &[]);
			p = self.t.pipeline(span, false, None, &[cmd]);
		}
		if bang {
			self.t.set_bang(p);
		}
		Some(p)
	}

	/// zsh `par_pline`: `cmd [ ( BAR | BARAMP ) { SEPER } pline ]`.
	fn par_pline(&mut self) -> Option<Pline> {
		let stages = self.t.open();
		// zsh recurses with each `|`/`|&` on the cmdstack until it returns.
		let mut pushed = 0usize;
		loop {
			let Some(c) = self.par_cmd(false) else {
				if self.t.opened_len(stages) == 0 {
					return None;
				}
				self.lx.tok = T::Lexerr;
				break;
			};
			if matches!(self.lx.tok, T::Bar | T::Baramp) {
				let pipe_stderr = self.lx.tok == T::Baramp;
				let cmd = self.stage_command(c);
				if pipe_stderr {
					self.t.set_pipe_stderr(cmd);
				}
				self.t.kid(stages, cmd);
				self.cmdpush(if pipe_stderr { CS_ERRPIPE } else { CS_PIPE });
				pushed += 1;
				self.zshlex();
				self.skip_seps();
				continue;
			}
			if self.t.opened_len(stages) == 0
				&& let Cmd::Timed(tp) = c
			{
				return Some(Pline::Timed(tp));
			}
			let cmd = self.stage_command(c);
			self.t.kid(stages, cmd);
			break;
		}
		for _ in 0..pushed {
			self.cmdpop();
		}
		Some(Pline::Stages(stages))
	}

	/// The command a pipeline stage holds.
	fn stage_command(&mut self, c: Cmd) -> Id<CommandS> {
		match c {
			Cmd::Plain(c) => c,
			Cmd::Timed(p) => self.t.pipeline_command(p),
		}
	}

	/// Redirections following a command.
	fn trailing_redirs(&mut self, redirs: &mut Vec<Id<shape::Redir>>) {
		while self.lx.tok.is_redirop() {
			if let Some(r) = self.par_redir(None) {
				redirs.push(r);
			}
		}
	}

	/// zsh `par_cmd`: `{ redir } ( for | case | if | while | repeat | subsh
	/// | funcdef | time | dinbrack | dinpar | simple ) { redir }`.
	/// `zsh_construct`: the token after the command is not in command
	/// position (arguments of an anonymous function).
	fn par_cmd(&mut self, zsh_construct: bool) -> Option<Cmd> {
		let lo = self.lx.lo;
		let mut redirs = Vec::new();
		self.trailing_redirs(&mut redirs);
		let nr = redirs.len();
		if self.lx.tok == T::Time && !self.inpartime {
			self.inpartime = true;
			let tp = self.par_time(lo);
			self.inpartime = false;
			self.trailing_redirs(&mut redirs);
			self.end_cmd();
			if redirs.is_empty() {
				return Some(Cmd::Timed(tp));
			}
			// A timed pipeline never unwraps: this is a group around it.
			let c = self.t.pipeline_command(tp);
			let c = self
				.t
				.with_redirs(c, &redirs, Span::new(lo, self.lx.last_hi));
			return Some(Cmd::Plain(c));
		}
		let cs = match self.lx.tok {
			T::For => Some(CS_FOR),
			T::Foreach => Some(CS_FOREACH),
			T::Select => Some(CS_SELECT),
			T::Case => Some(CS_CASE),
			T::While => Some(CS_WHILE),
			T::Until => Some(CS_UNTIL),
			T::Repeat => Some(CS_REPEAT),
			T::Inpar => Some(CS_SUBSH),
			T::Inbrace => Some(CS_CURSH),
			T::Func => Some(CS_FUNCDEF),
			T::Dinbrack => Some(CS_COND),
			_ => None,
		};
		if let Some(cs) = cs {
			self.cmdpush(cs);
		}
		let kind = match self.lx.tok {
			T::For | T::Foreach | T::Select => self.par_for(),
			T::Case => self.par_case(),
			T::If => self.par_if(),
			T::While | T::Until => self.par_while(),
			T::Repeat => self.par_repeat(),
			T::Inpar | T::Inbrace => self.par_subsh(zsh_construct),
			T::Func => self.par_funcdef(),
			T::Dinbrack => self.par_dinbrack(),
			T::Dinpar => {
				let (s, span) = self.tw();
				let inner =
					Span::new((span.lo + 2).min(span.hi), span.hi.saturating_sub(2).max(span.lo));
				self.zshlex();
				Some(Payload::Arith(self.t.arith(inner, &s, false)))
			},
			_ => {
				if self.lx.tok == T::Time {
					self.lx.tok = T::String;
				}
				match self.par_simple(nr, &mut redirs) {
					Some(k) => Some(k),
					None if nr == 0 => return None,
					None => Some(failed(&mut self.t)),
				}
			},
		};
		if cs.is_some() {
			self.cmdpop();
		}
		let payload = match kind {
			Some(k) => k,
			None => failed(&mut self.t),
		};
		self.trailing_redirs(&mut redirs);
		self.end_cmd();
		let cmd = self
			.t
			.command(Span::new(lo, self.lx.last_hi), payload, &redirs);
		Some(Cmd::Plain(self.t.attach_function_redirs(cmd)))
	}

	/// The body of a loop after its head: `DO list DONE | INBRACE list
	/// OUTBRACE | list ZEND | list1`.
	fn loop_body(&mut self, csh: bool, kind: Loop) -> Option<Id<shape::List>> {
		match self.lx.tok {
			T::Doloop | T::Inbrace => {
				let close = if self.lx.tok == T::Doloop {
					T::Done
				} else {
					T::Outbrace
				};
				self.zshlex();
				let body = self.par_list();
				if self.lx.tok != close {
					return self.yyerr();
				}
				self.ps.incmdpos = false;
				self.zshlex();
				Some(body)
			},
			_ if csh || self.opt(Features::ZSH_CSH_JUNKIE_LOOPS) => {
				let body = self.par_list();
				if self.lx.tok != T::Zend {
					return self.yyerr();
				}
				if kind == Loop::For {
					self.ps.incmdpos = false;
				}
				self.zshlex();
				Some(body)
			},
			_ if !(self.opt(Features::ZSH_SHORT_LOOPS)
				|| (kind == Loop::Repeat && self.opt(Features::ZSH_SHORT_REPEAT))) =>
			{
				self.yyerr()
			},
			_ => Some(self.par_list1()),
		}
	}

	/// zsh `par_for`: `for ((…))`, `for`/`foreach`/`select` over words.
	#[allow(clippy::cognitive_complexity, reason = "a direct port of zsh's par_for")]
	fn par_for(&mut self) -> Option<Payload> {
		let csh = self.lx.tok == T::Foreach;
		let sel = self.lx.tok == T::Select;
		self.ps.incmdpos = false;
		self.ps.infor = if self.lx.tok == T::For { 2 } else { 0 };
		self.zshlex();
		if self.lx.tok == T::Dinpar {
			let mut exprs = Vec::with_capacity(3);
			for want in [T::Dinpar, T::Dinpar, T::Doutpar] {
				self.zshlex();
				if self.lx.tok != want {
					return self.yyerr();
				}
				let (src, span) = self.tw();
				exprs.push(self.t.arith(span, &src, false));
			}
			self.ps.infor = 0;
			self.ps.incmdpos = true;
			self.zshlex();
			self.ps.incmdpos = true;
			self.skip_seps();
			let body = self.loop_body(csh, Loop::For)?;
			let (init, cond, step) = (exprs[0], exprs[1], exprs[2]);
			return Some(Payload::ArithFor(self.t.arith_for(init, cond, step, body)));
		}
		self.ps.infor = 0;
		if self.lx.tok != T::String || !isident(&self.lx.buf, self.opt(Features::ZSH_WIDE_IDENT)) {
			return self.yyerr();
		}
		let var_span = self.tok_span();
		let mut vars = Vec::new();
		self.ps.incmdpos = true;
		let ona = self.noaliases;
		self.noaliases = true;
		loop {
			vars.push(plain(&self.lx.buf));
			self.zshlex();
			if self.lx.tok != T::String || self.lx.buf == b"in" || sel {
				break;
			}
			if !isident(&self.lx.buf, self.opt(Features::ZSH_WIDE_IDENT)) || self.errflag {
				self.noaliases = ona;
				return self.yyerr();
			}
		}
		self.noaliases = ona;
		let posix_in = self.ps.isnewlin;
		while self.ps.isnewlin != 0 {
			self.zshlex();
		}
		let words = if self.lx.tok == T::String && self.lx.buf == b"in" {
			self.ps.incmdpos = false;
			self.zshlex();
			let w = self.par_wordlist();
			if self.lx.tok != T::Seper {
				return self.yyerr();
			}
			Some(w)
		} else if posix_in == 0 && self.lx.tok == T::Inpar {
			self.ps.incmdpos = false;
			self.zshlex();
			let w = self.par_nl_wordlist();
			if self.lx.tok != T::Outpar {
				return self.yyerr();
			}
			self.ps.incmdpos = true;
			self.zshlex();
			Some(w)
		} else {
			None
		};
		self.ps.incmdpos = true;
		self.skip_seps();
		let body = self.loop_body(csh, Loop::For)?;
		let names: Vec<&[u8]> = if vars.is_empty() {
			vec![b""]
		} else {
			vars.iter().map(Vec::as_slice).collect()
		};
		let fr = self.t.for_at(&names, var_span, words, body);
		Some(if sel {
			Payload::Select(fr)
		} else {
			Payload::For(fr)
		})
	}

	/// zsh `par_case`.
	#[allow(clippy::cognitive_complexity, reason = "a direct port of zsh's par_case")]
	fn par_case(&mut self) -> Option<Payload> {
		self.ps.incmdpos = false;
		self.zshlex();
		if self.lx.tok != T::String {
			return self.yyerr();
		}
		let word = self.tok_word();
		self.ps.incmdpos = true;
		let ona = self.noaliases;
		self.noaliases = true;
		self.zshlex();
		self.skip_seps();
		if !(self.lx.tok == T::String && self.lx.buf == b"in") && self.lx.tok != T::Inbrace {
			self.noaliases = ona;
			return self.yyerr();
		}
		let brflag = self.lx.tok == T::Inbrace;
		self.ps.incasepat = 1;
		self.ps.incmdpos = false;
		self.noaliases = ona;
		self.zshlex();
		let arms = self.t.open();
		loop {
			self.skip_seps();
			if self.lx.tok == T::Outbrace {
				break;
			}
			if self.lx.tok == T::Inpar {
				self.zshlex();
			}
			let skip_lex = self.lx.tok == T::Bar;
			let mut s: Tw = if skip_lex {
				(Vec::new(), Span::new(self.lx.lo, self.lx.lo))
			} else {
				if self.lx.tok != T::String {
					return self.yyerr();
				}
				if self.lx.buf == b"esac" {
					break;
				}
				self.tw()
			};
			let patterns = self.t.open();
			self.ps.incasepat = -1;
			self.ps.incmdpos = true;
			if !skip_lex {
				self.zshlex();
			}
			loop {
				if self.lx.tok == T::Outpar {
					let w = self.t.zword(&core::mem::take(&mut s.0), s.1);
					self.t.kid(patterns, w);
					self.ps.incasepat = 0;
					self.ps.incmdpos = true;
					self.zshlex();
					break;
				} else if self.lx.tok == T::Bar {
					let w = self.t.zword(&core::mem::take(&mut s.0), s.1);
					self.t.kid(patterns, w);
					self.ps.incasepat = 1;
					self.ps.incmdpos = false;
				} else {
					if self.t.opened_len(patterns) == 0 && s.0.first() == Some(&INPAR) {
						if !case_paren_pattern(&mut s.0) {
							return self.yyerr();
						}
						let w = self.t.zword(&core::mem::take(&mut s.0), s.1);
						self.t.kid(patterns, w);
						break;
					}
					return self.yyerr();
				}
				self.zshlex();
				s = match self.lx.tok {
					T::String => {
						let t = self.tw();
						self.zshlex();
						t
					},
					T::Outpar | T::Bar => (Vec::new(), Span::new(self.lx.lo, self.lx.lo)),
					_ => return self.yyerr(),
				};
			}
			self.ps.incasepat = 0;
			let body = self.par_list();
			let term = match self.lx.tok {
				T::Semiamp => CaseTerm::FallThrough,
				T::Semibar => CaseTerm::Continue,
				_ => CaseTerm::Break,
			};
			let arm = self.t.case_arm_at(body, term, patterns);
			self.t.kid(arms, arm);
			if (self.lx.tok == T::Esac && !brflag) || (self.lx.tok == T::Outbrace && brflag) {
				break;
			}
			if !matches!(self.lx.tok, T::Dsemi | T::Semiamp | T::Semibar) {
				return self.yyerr();
			}
			self.ps.incasepat = 1;
			self.ps.incmdpos = false;
			self.zshlex();
		}
		self.ps.incmdpos = true;
		self.ps.incasepat = 0;
		self.zshlex();
		Some(Payload::Case(self.t.case_at(word, arms)))
	}

	/// zsh `par_if`.
	#[allow(clippy::cognitive_complexity, reason = "a direct port of zsh's par_if")]
	fn par_if(&mut self) -> Option<Payload> {
		let arms = self.t.open();
		let mut usebrace = false;
		let mut xtok;
		// Each pass pushes `if`/`elif` (zsh pushes `elif` for `fi` and
		// `else` too); every `break` leaves one entry for the pop after the
		// loop.
		loop {
			xtok = self.lx.tok;
			self.cmdpush(if xtok == T::If { CS_IF } else { CS_ELIF });
			if xtok == T::Fi {
				self.ps.incmdpos = false;
				self.zshlex();
				break;
			}
			self.zshlex();
			if xtok == T::Else {
				break;
			}
			self.skip_seps();
			if !(xtok == T::If || xtok == T::Elif) {
				self.cmdpop();
				return self.yyerr();
			}
			let cond = self.par_list();
			self.ps.incmdpos = true;
			if self.lx.tok == T::Endinput {
				self.cmdpop();
				return self.yyerr();
			}
			self.skip_seps();
			xtok = T::Fi;
			let then = if self.cmdstack.last() == Some(&CS_IF) {
				CS_IFTHEN
			} else {
				CS_ELIFTHEN
			};
			if self.lx.tok == T::Then {
				usebrace = false;
				self.cmdpop();
				self.cmdpush(then);
				self.zshlex();
				let body = self.par_list();
				self.ps.incmdpos = true;
				self.cmdpop();
				self.t.kid(arms, cond);
				self.t.kid(arms, body);
			} else if self.lx.tok == T::Inbrace {
				usebrace = true;
				self.cmdpop();
				self.cmdpush(then);
				self.zshlex();
				let body = self.par_list();
				if self.lx.tok != T::Outbrace {
					self.cmdpop();
					return self.yyerr();
				}
				self.t.kid(arms, cond);
				self.t.kid(arms, body);
				self.zshlex();
				self.ps.incmdpos = true;
				if self.lx.tok == T::Seper {
					break;
				}
				self.cmdpop();
			} else if !self.opt(Features::ZSH_SHORT_LOOPS) {
				self.cmdpop();
				return self.yyerr();
			} else {
				self.cmdpop();
				self.cmdpush(then);
				let body = self.par_list1();
				self.t.kid(arms, cond);
				self.t.kid(arms, body);
				self.ps.incmdpos = true;
				break;
			}
		}
		self.cmdpop();
		let mut else_body = None;
		if xtok == T::Else || self.lx.tok == T::Else {
			self.cmdpush(CS_ELSE);
			self.skip_seps();
			let body = if self.lx.tok == T::Inbrace && usebrace {
				self.zshlex();
				let b = self.par_list();
				if self.lx.tok != T::Outbrace {
					self.cmdpop();
					return self.yyerr();
				}
				b
			} else {
				let b = self.par_list();
				if self.lx.tok != T::Fi {
					self.cmdpop();
					return self.yyerr();
				}
				b
			};
			self.ps.incmdpos = false;
			else_body = Some(body);
			self.zshlex();
			self.cmdpop();
		}
		if self.t.opened_len(arms) == 0 {
			return self.yyerr();
		}
		Some(Payload::If(self.t.if_at(else_body, arms)))
	}

	/// zsh `par_while`.
	fn par_while(&mut self) -> Option<Payload> {
		let until = self.lx.tok == T::Until;
		self.zshlex();
		let cond = self.par_list();
		self.ps.incmdpos = true;
		self.skip_seps();
		let body = self.loop_body(false, Loop::While)?;
		Some(Payload::While(self.t.while_(until, cond, body)))
	}

	/// zsh `par_repeat`.
	fn par_repeat(&mut self) -> Option<Payload> {
		self.ps.incmdpos = false;
		self.zshlex();
		if self.lx.tok != T::String {
			return self.yyerr();
		}
		let count = self.tok_word();
		self.ps.incmdpos = true;
		self.zshlex();
		self.skip_seps();
		let body = self.loop_body(false, Loop::Repeat)?;
		Some(Payload::Repeat(self.t.repeat(count, body)))
	}

	/// zsh `par_subsh`: `( list )`, `{ list }`, `{ list } always { list }`.
	fn par_subsh(&mut self, zsh_construct: bool) -> Option<Payload> {
		let otok = self.lx.tok;
		self.zshlex();
		let list = self.par_list();
		let close = if otok == T::Inpar {
			T::Outpar
		} else {
			T::Outbrace
		};
		if self.lx.tok != close {
			return self.yyerr();
		}
		self.ps.incmdpos = !zsh_construct;
		self.zshlex();
		if otok == T::Inbrace && self.lx.tok == T::String && self.lx.buf == b"always" {
			self.ps.incmdpos = true;
			loop {
				self.zshlex();
				if self.lx.tok != T::Seper {
					break;
				}
			}
			if self.lx.tok != T::Inbrace {
				return self.yyerr();
			}
			self.cmdpop();
			self.cmdpush(CS_ALWAYS);
			self.zshlex();
			let always = self.par_list();
			self.skip_seps();
			self.ps.incmdpos = true;
			if self.lx.tok != T::Outbrace {
				return self.yyerr();
			}
			self.zshlex();
			return Some(Payload::Try(self.t.try_(list, always)));
		}
		Some(if otok == T::Inpar {
			Payload::Subshell(list)
		} else {
			Payload::Brace(list)
		})
	}

	/// A function body after `()` or the names: `INBRACE list OUTBRACE`,
	/// else a command (`name ()`) or a `list1` (`function`, under
	/// `shortloops`). `anon`: an anonymous function, whose arguments follow
	/// outside command position.
	fn func_body(&mut self, anon: bool, keyword: bool) -> Option<Id<CommandS>> {
		let lo = self.lx.lo;
		if self.lx.tok == T::Inbrace {
			self.zshlex();
			let list = self.par_list();
			if self.lx.tok != T::Outbrace {
				return self.yyerr();
			}
			if anon {
				self.ps.incmdpos = false;
			}
			self.zshlex();
			return Some(self.t.group(Span::new(lo, self.lx.last_hi), list));
		}
		if keyword {
			if !self.opt(Features::ZSH_SHORT_LOOPS) {
				return self.yyerr();
			}
			let list = self.par_list1();
			return Some(self.t.list_command(list, Span::new(lo, self.lx.last_hi)));
		}
		let Some(c) = self.par_cmd(anon) else {
			return self.yyerr();
		};
		if anon {
			self.ps.incmdpos = false;
		}
		Some(self.stage_command(c))
	}

	/// zsh `par_funcdef`: `function name… [ () ] body` / `function body
	/// [ args ]`.
	fn par_funcdef(&mut self) -> Option<Payload> {
		self.ps.incmdpos = false;
		self.zshlex();
		let mut traced = false;
		if self.lx.tok == T::String && self.lx.buf.first() == Some(&DASH) {
			if self.lx.buf[..] == [DASH, b'T'] {
				traced = true;
				self.zshlex();
			}
			if self.lx.tok == T::String && self.lx.buf[..] == [DASH, DASH] {
				self.zshlex();
			}
		}
		let mut names = Vec::new();
		while self.lx.tok == T::String {
			if matches!(self.lx.buf[..], [INBRACE | b'{']) {
				self.lx.tok = T::Inbrace;
				break;
			}
			names.push(plain(&self.lx.buf));
			self.zshlex();
		}
		self.ps.incmdpos = true;
		if self.lx.tok == T::Inoutpar {
			self.zshlex();
		}
		self.skip_seps();
		let body = self.func_body(names.is_empty(), true)?;
		if names.is_empty() {
			let mut args = Vec::new();
			while self.lx.tok == T::String {
				args.push(self.tok_word());
				self.zshlex();
			}
			return Some(Payload::AnonFunc(self.t.anon_func(body, &args, traced)));
		}
		let names: Vec<&[u8]> = names.iter().map(Vec::as_slice).collect();
		Some(Payload::FuncDef(self.t.funcdef(&names, true, traced, body)))
	}

	/// zsh `par_time`: `TIME sublist2`; the pipeline node.
	fn par_time(&mut self, lo: u32) -> Id<PipelineS> {
		self.zshlex();
		if let Some(p) = self.par_sublist2() {
			self.t.set_timed(p, lo);
			return p;
		}
		let span = Span::new(lo, self.lx.last_hi);
		let cmd = self.t.empty_command(Span::new(span.hi, span.hi));
		self
			.t
			.pipeline(span, false, Some(Time { posix: false }), &[cmd])
	}

	/// zsh `par_dinbrack`: `DINBRACK cond DOUTBRACK`.
	fn par_dinbrack(&mut self) -> Option<Payload> {
		self.ps.incond = 1;
		self.ps.incmdpos = false;
		self.zshlex();
		let e = self.par_cond();
		if self.lx.tok != T::Doutbrack {
			return self.yyerr();
		}
		self.ps.incond = 0;
		self.ps.incmdpos = true;
		self.zshlex();
		e.map(Payload::Cond)
	}

	/// An `ENVSTRING` token (`name[sub][+]=value`) as an assignment node.
	fn envstring_assign(&mut self) -> Id<shape::Assign> {
		let s = self.lx.buf.clone();
		let span = self.tok_span();
		let (name, index, mut p) = split_name(&s);
		let append = s.get(p) == Some(&b'+');
		if append {
			p += 1;
		}
		let value_from = if s.get(p) == Some(&b'=') {
			p + 1
		} else {
			s.iter().position(|&c| c == b'=').map_or(s.len(), |i| i + 1)
		};
		let vlo = (span.lo + value_from as u32).min(span.hi);
		let index = index.map(|i| {
			let ilo = (span.lo + name.len() as u32 + 1).min(span.hi);
			self.t.zword(&i, Span::new(ilo, ilo))
		});
		let value = self.t.zword(tail(&s, value_from), Span::new(vlo, span.hi));
		self
			.t
			.assign(span, &name, index, append, AssignB::Scalar(value))
	}

	/// The element nodes of an array assignment after its `name=(`, up to
	/// its `)`.
	fn array_elems(&mut self) -> Option<Run<shape::Elem>> {
		self.cmdpush(CS_ARRAY);
		self.zshlex();
		let words = self.par_nl_wordlist_tw();
		self.cmdpop();
		if self.lx.tok != T::Outpar {
			return self.yyerr();
		}
		Some(elems_run(&mut self.t, &words))
	}

	/// zsh `par_simple`: assignments, words, redirections, and the
	/// `name ()` / `()` function definitions. `nr`: redirections `par_cmd`
	/// already read into `redirs`.
	#[allow(clippy::cognitive_complexity, reason = "a direct port of zsh's par_simple")]
	fn par_simple(&mut self, nr: usize, redirs: &mut Vec<Id<shape::Redir>>) -> Option<Payload> {
		let mut nr = nr;
		let mut assigns = Vec::new();
		let mut words: Vec<Id<shape::Word>> = Vec::new();
		// The token text of each word, for function names.
		let mut texts: Vec<Vec<u8>> = Vec::new();
		let mut hasalias = self.input_hasalias();
		let mut isnull = true;
		let mut assignments = false;
		let mut postassigns = 0usize;
		let mut argc = 0usize;
		let mut sr = 0usize;
		let mut typeset = false;
		loop {
			match self.lx.tok {
				T::Nocorrect => {},
				T::Envstring => {
					let a = self.envstring_assign();
					assigns.push(a);
					isnull = false;
					assignments = true;
				},
				T::Envarray => {
					let oldcmdpos = self.ps.incmdpos;
					self.ps.incmdpos = false;
					let lo = self.lx.lo;
					let (name, index, p) = split_name(&self.lx.buf);
					let append = self.lx.buf.get(p) == Some(&b'+');
					let elems = self.array_elems()?;
					self.ps.incmdpos = oldcmdpos;
					let index = index.map(|i| self.t.zword(&i, Span::new(lo, lo)));
					let a = self.t.assign(
						Span::new(lo, self.lx.hi),
						&name,
						index,
						append,
						AssignB::Array(elems),
					);
					assigns.push(a);
					isnull = false;
					assignments = true;
				},
				t if t.is_redirop() => {
					if let Some(r) = self.par_redir(None) {
						redirs.push(r);
						nr += 1;
					}
					continue;
				},
				_ => break,
			}
			self.zshlex();
			if hasalias.is_none() {
				hasalias = self.input_hasalias();
			}
		}
		if matches!(self.lx.tok, T::Amper | T::Amperbang) {
			return self.yyerr();
		}
		let mut func = None;
		loop {
			match self.lx.tok {
				T::String | T::Typeset => {
					let mut redir_var = false;
					self.ps.incmdpos = false;
					if self.lx.tok == T::Typeset {
						self.ps.intypeset = true;
						typeset = true;
					}
					let b = &self.lx.buf;
					if !self.opt(Features::ZSH_IGNORE_BRACES)
						&& b.len() > 2
						&& at(b, 0) == INBRACE
						&& b.last() == Some(&OUTBRACE)
						&& ident_end(b, 1, self.opt(Features::ZSH_WIDE_IDENT)) >= b.len() - 1
					{
						let idstring = plain(span(b, 1, b.len() - 1));
						let text = b.clone();
						let toksave = self.tok_word();
						redir_var = true;
						self.zshlex();
						if hasalias.is_none() {
							hasalias = self.input_hasalias();
						}
						if self.lx.tok.is_redirop() && self.lx.tokfd == -1 {
							if let Some(r) = self.par_redir(Some(idstring)) {
								redirs.push(r);
							}
							sr += 1;
						} else {
							if postassigns > 0 {
								postassigns += 1;
							} else {
								argc += 1;
							}
							words.push(toksave);
							texts.push(text);
						}
					}
					if !redir_var {
						if postassigns > 0 {
							postassigns += 1;
						} else {
							argc += 1;
						}
						texts.push(self.lx.buf.clone());
						let w = self.tok_word();
						words.push(w);
						self.zshlex();
						if hasalias.is_none() {
							hasalias = self.input_hasalias();
						}
					}
				},
				t if t.is_redirop() => {
					if let Some(r) = self.par_redir(None) {
						redirs.push(r);
					}
					sr += 1;
				},
				T::Envstring => {
					postassigns += 1;
					texts.push(self.lx.buf.clone());
					let w = self.tok_word();
					words.push(w);
					self.zshlex();
					if hasalias.is_none() {
						hasalias = self.input_hasalias();
					}
				},
				T::Envarray => {
					postassigns += 1;
					let lo = self.lx.lo;
					let mut head = self.lx.buf.clone();
					head.push(b'=');
					self.cmdpush(CS_ARRAY);
					self.ps.intypeset = false;
					self.zshlex();
					let words_n = self.par_nl_wordlist_tw();
					self.cmdpop();
					self.ps.intypeset = true;
					if self.lx.tok != T::Outpar {
						return self.yyerr();
					}
					let headp = self.t.text_part(TextPk::Zsh, &head);
					let elems = elems_run(&mut self.t, &words_n);
					let compound = self.t.compound_part(elems);
					let w = self.t.word(Span::new(lo, self.lx.hi), &[headp, compound]);
					words.push(w);
					texts.push(Vec::new());
					self.zshlex();
				},
				T::Inoutpar => {
					if !self.opt(Features::ZSH_MULTI_FUNC_DEF) && argc > 1 {
						return self.yyerr();
					}
					if assignments || postassigns > 0 {
						return self.yyerr();
					}
					if let Some(a) = &hasalias
						&& !self.opt(Features::ZSH_ALIAS_FUNC_DEF)
						&& argc > 0
						&& self.input_hasalias().as_ref() != Some(a)
					{
						let mut msg = b"defining function based on alias `".to_vec();
						msg.extend_from_slice(a);
						msg.push(b'\'');
						self.zwarn(msg);
						return self.yyerr();
					}
					self.ps.incmdpos = true;
					self.cmdpush(CS_FUNCDEF);
					self.zshlex();
					self.skip_seps();
					let anon = argc == 0;
					let body = self.func_body(anon, false);
					self.cmdpop();
					let body = body?;
					if anon {
						let mut args = Vec::new();
						while self.lx.tok == T::String || self.lx.tok.is_redirop() {
							if self.lx.tok == T::String {
								args.push(self.tok_word());
								self.zshlex();
							} else if let Some(r) = self.par_redir(None) {
								redirs.push(r);
							}
						}
						func = Some(Payload::AnonFunc(self.t.anon_func(body, &args, false)));
					} else {
						let names: Vec<Vec<u8>> = texts.iter().map(|t| plain(t)).collect();
						let mut refs: Vec<&[u8]> = names.iter().map(Vec::as_slice).collect();
						if refs.is_empty() {
							refs.push(b"");
						}
						func = Some(Payload::FuncDef(self.t.funcdef(&refs, false, false, body)));
					}
					isnull = false;
					break;
				},
				_ => break,
			}
			isnull = false;
		}
		if isnull && sr + nr == 0 {
			return None;
		}
		self.ps.incmdpos = true;
		self.ps.intypeset = false;
		Some(func.unwrap_or_else(|| Payload::Simple(self.t.simple(&assigns, &words, typeset))))
	}

	/// zsh `par_redir`: `( OUTANG | … | TRINANG ) STRING`; `idstring` is the
	/// variable of a `{var}>` redirection.
	fn par_redir(&mut self, idstring: Option<Vec<u8>>) -> Option<Id<shape::Redir>> {
		let lo = self.lx.lo;
		let oldcmdpos = self.ps.incmdpos;
		self.ps.incmdpos = false;
		let rt = self.lx.tok;
		let fd1 = self.lx.tokfd;
		self.zshlex();
		if !matches!(self.lx.tok, T::String | T::Envstring) {
			return self.yyerr();
		}
		self.ps.incmdpos = oldcmdpos;
		let num = u32::try_from(fd1).ok();
		let fd = match &idstring {
			Some(v) => Some(FdB::Var(v)),
			None => num.map(FdB::Num),
		};
		if matches!(rt, T::Dinang | T::Dinangdash) {
			let strip = rt == T::Dinangdash;
			let name = &self.lx.buf;
			let mut delim = munge_terminator(name);
			if strip {
				let n = delim.iter().take_while(|&&c| c == b'\t').count();
				delim.drain(..n);
			}
			let quoted = name.iter().any(|&c| is_null(c));
			let delim_raw = plain(name);
			let seq = self.docs.len();
			self.docs.push(Vec::new());
			self
				.ps
				.hdocs
				.push(PendingDoc { seq, delim: delim.clone(), strip, quoted });
			let hi = self.lx.hi;
			self.zshlex();
			let doc = self.t.heredoc(&delim, &delim_raw, quoted, b"");
			let text = self.t.heredoc_body(doc);
			self.doc_nodes.push((text, seq as u32));
			return Some(self.t.redir(
				Span::new(lo, hi),
				RedirOp::HereDoc { strip_tabs: strip },
				fd,
				TargetB::HereDoc(doc),
			));
		}
		let name = &self.lx.buf;
		let bad = match rt {
			T::Outang | T::Outangbang => name.starts_with(&[INANG, INPAR]),
			T::Inang => name.starts_with(&[OUTANGPROC, INPAR]),
			_ => false,
		};
		if bad {
			return self.yyerr();
		}
		let target = self.tok_word();
		let thi = self.lx.hi;
		self.zshlex();
		Some(
			self
				.t
				.redir(Span::new(lo, thi), redir_op(rt), fd, TargetB::Word(target)),
		)
	}

	/// zsh `par_wordlist`: `{ STRING }`.
	fn par_wordlist(&mut self) -> Mark<shape::Word> {
		let words = self.t.open();
		while self.lx.tok == T::String {
			let w = self.tok_word();
			self.t.kid(words, w);
			self.zshlex();
		}
		words
	}

	/// zsh `par_nl_wordlist`: `{ STRING | SEPER }`.
	fn par_nl_wordlist(&mut self) -> Mark<shape::Word> {
		let words = self.t.open();
		while matches!(self.lx.tok, T::String | T::Seper) {
			if self.lx.tok == T::String {
				let w = self.tok_word();
				self.t.kid(words, w);
			}
			self.zshlex();
		}
		words
	}

	/// [`Ctx::par_nl_wordlist`] as token strings with their spans.
	fn par_nl_wordlist_tw(&mut self) -> Vec<Tw> {
		let mut words = Vec::new();
		while matches!(self.lx.tok, T::String | T::Seper) {
			if self.lx.tok == T::String {
				words.push(self.tw());
			}
			self.zshlex();
		}
		words
	}

	/// zsh `COND_SEP`: a newline inside `[[ … ]]`.
	fn cond_sep(&self) -> bool {
		self.lx.tok == T::Seper && self.lx.sep_nl
	}

	/// `do condlex(); while (COND_SEP());`
	fn cond_next(&mut self) {
		loop {
			self.zshlex();
			if !self.cond_sep() {
				break;
			}
		}
	}

	/// zsh `COND_ERROR`: report, set the error flag, fail.
	fn cond_error(&mut self, pre: &[u8], arg: &[u8]) -> Option<Id<shape::Cond>> {
		let mut msg = pre.to_vec();
		msg.extend_from_slice(&plain(arg));
		self.zwarn(msg);
		self.errflag = true;
		self.yyerr()
	}

	/// zsh `par_cond`: `cond_1 { SEPER } [ DBAR { SEPER } cond ]`.
	fn par_cond(&mut self) -> Option<Id<shape::Cond>> {
		let a = self.par_cond_1()?;
		while self.cond_sep() {
			self.zshlex();
		}
		if self.lx.tok == T::Dbar {
			self.zshlex();
			while self.cond_sep() {
				self.zshlex();
			}
			let b = self.nested_cond(Self::par_cond)?;
			return Some(self.t.cond(CondB::Or(a, b)));
		}
		Some(a)
	}

	/// zsh `par_cond_1`: `cond_2 { SEPER } [ DAMPER { SEPER } cond_1 ]`.
	fn par_cond_1(&mut self) -> Option<Id<shape::Cond>> {
		let a = self.par_cond_2()?;
		while self.cond_sep() {
			self.zshlex();
		}
		if self.lx.tok == T::Damper {
			self.zshlex();
			while self.cond_sep() {
				self.zshlex();
			}
			let b = self.nested_cond(Self::par_cond_1)?;
			return Some(self.t.cond(CondB::And(a, b)));
		}
		Some(a)
	}

	/// `f` one nesting level deeper ([`Ctx::enter`]).
	fn nested_cond(
		&mut self,
		f: fn(&mut Self) -> Option<Id<shape::Cond>>,
	) -> Option<Id<shape::Cond>> {
		if !self.enter() {
			return None;
		}
		let r = f(self);
		self.leave();
		r
	}

	/// zsh `par_cond_2`: `BANG cond_2 | INPAR cond OUTPAR | STRING STRING
	/// STRING | STRING STRING | STRING ( INANG | OUTANG ) STRING`.
	#[allow(clippy::cognitive_complexity, reason = "a direct port of zsh's par_cond_2")]
	fn par_cond_2(&mut self) -> Option<Id<shape::Cond>> {
		while self.cond_sep() {
			self.zshlex();
		}
		if self.lx.tok == T::Bang {
			self.zshlex();
			let e = self.nested_cond(Self::par_cond_2)?;
			return Some(self.t.cond(CondB::Not(e)));
		}
		if self.lx.tok == T::Inpar {
			self.zshlex();
			while self.cond_sep() {
				self.zshlex();
			}
			let r = self.nested_cond(Self::par_cond);
			while self.cond_sep() {
				self.zshlex();
			}
			if self.lx.tok != T::Outpar {
				return self.yyerr();
			}
			self.zshlex();
			return r.map(|e| self.t.cond(CondB::Group(e)));
		}
		let s1 = self.tokstr().map(|s| (s.to_vec(), self.tok_span()));
		let dble = s1
			.as_ref()
			.is_some_and(|(s, _)| s.len() == 2 && is_dash(s[0]));
		if self.lx.tok != T::String {
			if let Some(s1) = s1
				&& self.lx.tok != T::Lexerr
				&& !dble
			{
				self.cond_next();
				return self.par_cond_double((b"-n".to_vec(), s1.1), s1);
			}
			return self.yyerr();
		}
		let s1 = s1.unwrap_or_default();
		self.zshlex();
		while self.cond_sep() {
			self.zshlex();
		}
		if matches!(self.lx.tok, T::Inang | T::Outang) {
			let op: &[u8] = if self.lx.tok == T::Inang { b"<" } else { b">" };
			self.cond_next();
			if self.lx.tok != T::String {
				return self.yyerr();
			}
			let s3 = self.tw();
			self.cond_next();
			let lhs = self.t.zword(&s1.0, s1.1);
			let rhs = self.t.zword(&s3.0, s3.1);
			return Some(self.t.cond(CondB::Binary { op, lhs, rhs }));
		}
		if self.lx.tok != T::String {
			if self.lx.tok != T::Lexerr {
				return if dble {
					self.par_cond_multi(s1, Vec::new())
				} else {
					self.par_cond_double((b"-n".to_vec(), s1.1), s1)
				};
			}
			return self.yyerr();
		}
		let s2 = self.tw();
		let dble2 = s2.0.len() == 2 && is_dash(s2.0[0]);
		self.ps.incond += 1;
		self.cond_next();
		self.ps.incond -= 1;
		if self.lx.tok == T::String && !dble2 {
			let s3 = self.tw();
			self.cond_next();
			if self.lx.tok == T::String {
				let mut l = vec![s2, s3];
				while self.lx.tok == T::String {
					l.push(self.tw());
					self.cond_next();
				}
				return self.par_cond_multi(s1, l);
			}
			return self.par_cond_triple(s1, s2, s3);
		}
		self.par_cond_double(s1, s2)
	}

	/// zsh `par_cond_double`: `-x word`.
	fn par_cond_double(&mut self, a: Tw, b: Tw) -> Option<Id<shape::Cond>> {
		if a.0.len() < 2 || !is_dash(a.0[0]) {
			return self.cond_error(b"parse error: condition expected: ", &a.0);
		}
		let arg = self.t.zword(&b.0, b.1);
		Some(self.t.cond(CondB::Unary { op: &plain(&a.0), arg }))
	}

	/// zsh `par_cond_triple`: `a op b`.
	fn par_cond_triple(&mut self, lhs: Tw, mid: Tw, rhs: Tw) -> Option<Id<shape::Cond>> {
		let eq = |x: u8| x == EQUALS || x == b'=';
		let op = &mid.0;
		let binary = match op[..] {
			[x] if eq(x) => true,
			[x, y] if eq(x) && eq(y) => true,
			[b'!', y] if eq(y) => true,
			[x, y] if eq(x) && (y == b'~' || y == TILDE) => true,
			_ => op.first().copied().is_some_and(is_dash),
		};
		if binary {
			let l = self.t.zword(&lhs.0, lhs.1);
			let r = self.t.zword(&rhs.0, rhs.1);
			return Some(
				self
					.t
					.cond(CondB::Binary { op: &plain(op), lhs: l, rhs: r }),
			);
		}
		if lhs.0.len() > 1 && is_dash(lhs.0[0]) {
			return self.par_cond_multi(lhs, vec![mid, rhs]);
		}
		self.cond_error(b"condition expected: ", &mid.0)
	}

	/// zsh `par_cond_multi`: a module condition `-x arg…`. Its operands are
	/// the parts of the unary condition's word, one [`Pk::Zsh`] part each
	/// (no part for none), so a word with other than one part is such a
	/// condition.
	fn par_cond_multi(&mut self, a: Tw, l: Vec<Tw>) -> Option<Id<shape::Cond>> {
		if a.0.len() < 2 || !is_dash(a.0[0]) {
			return self.cond_error(b"condition expected: ", &a.0);
		}
		let lo = l.first().map_or(a.1.hi, |t| t.1.lo);
		let hi = l.last().map_or(a.1.hi, |t| t.1.hi);
		let parts: Vec<_> = l
			.iter()
			.map(|t| self.t.text_part(TextPk::Zsh, &t.0))
			.collect();
		let arg = self.t.word(Span::new(lo, hi), &parts);
		Some(self.t.cond(CondB::Unary { op: &plain(&a.0), arg }))
	}

	/// Put the gathered here-document bodies into their text nodes,
	/// retiring the registrations.
	pub(super) fn fill_docs(&mut self) {
		for (node, seq) in self.doc_nodes.drain(..) {
			if let Some(text) = self.docs.get(seq as usize) {
				self.t.set_text(node, text);
			}
		}
	}
}
