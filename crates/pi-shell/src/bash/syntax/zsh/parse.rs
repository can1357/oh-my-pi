//! The zsh 5.9 parser: a port of `Src/parse.c` (`parse_event`, `par_event`,
//! `par_list`, `par_sublist`, `par_pline`, `par_cmd`, `par_for`,
//! `par_case`, `par_if`, `par_while`, `par_repeat`, `par_subsh`,
//! `par_funcdef`, `par_time`, `par_dinbrack`, `par_simple`, `par_redir`,
//! `par_wordlist`, `par_nl_wordlist` and the `par_cond` family).
//!
//! zsh's parser emits word code; this port keeps its control flow and token
//! handling and builds the crate's AST instead. As in zsh, a syntax error
//! sets the token to `LEXERR` and unwinds through the callers' token
//! checks (`YYERROR`), so a construct that failed leaves a placeholder that
//! never reaches a successful result.
//!
//! Every word is `[WordPart::Zsh(tokstr)]`: zsh's token string. Arithmetic
//! text ([`ArithText::src`]) is zsh's token string too.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use alloc::{boxed::Box, vec, vec::Vec};

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
	ast::*,
	features::Features,
	span::{NodeId, Span},
};

/// What `par_cmd` produced: a command, or a `time` pipeline that the
/// enclosing pipeline takes over.
enum Cmd {
	/// A command.
	Plain(Command),
	/// `time` and its pipeline.
	Timed(Pipeline),
}

impl Cmd {
	/// The command a pipeline stage holds.
	fn into_command(self) -> Command {
		match self {
			Self::Plain(c) => c,
			Self::Timed(p) => pipeline_command(p),
		}
	}
}

/// Result of `par_pline`.
enum Pline {
	/// The stages.
	Stages(Vec<Stage>),
	/// A lone `time` pipeline.
	Timed(Pipeline),
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
/// never reaches a successful parse).
fn failed() -> CommandKind {
	CommandKind::Simple(Simple::default())
}

/// A word holding token string `s`.
fn zword(s: Vec<u8>, span: Span) -> Word {
	Word { id: NodeId(0), span, parts: vec![WordPart::Zsh(s)] }
}

/// A command with no words (the empty pipeline of `!`, `coproc`, `time`).
fn empty_command(span: Span) -> Command {
	Command { id: NodeId(0), span, kind: CommandKind::Simple(Simple::default()), redirs: Vec::new() }
}

/// A pipeline as one command: its lone stage, or a group around it.
fn pipeline_command(p: Pipeline) -> Command {
	if p.stages.len() == 1 && !p.bang && p.time.is_none() && !p.stages[0].pipe_stderr {
		return p
			.stages
			.into_iter()
			.next()
			.map_or_else(|| empty_command(Span::default()), |s| s.cmd);
	}
	let span = p.span;
	let and_or = AndOr { id: NodeId(0), span, first: p, rest: Vec::new() };
	Command {
		id: NodeId(0),
		span,
		kind: CommandKind::Brace(List { items: vec![ListItem { and_or, sep: Sep::None }] }),
		redirs: Vec::new(),
	}
}

/// A list as one command: its lone pipeline as a command, or a group.
fn list_command(mut list: List, span: Span) -> Command {
	let lone = matches!(
		&list.items[..],
		[item] if item.sep == Sep::None && item.and_or.rest.is_empty()
	);
	if lone && let Some(item) = list.items.pop() {
		return pipeline_command(item.and_or.first);
	}
	Command { id: NodeId(0), span, kind: CommandKind::Brace(list), redirs: Vec::new() }
}

/// zsh `IS_DASH`.
const fn is_dash(c: u8) -> bool {
	c == b'-' || c == DASH
}

/// zsh `keyvalpairelement` applied at parse time: `[key]=value` /
/// `[key]+=value` of an array assignment.
fn array_elem(w: Word) -> ArrayElem {
	if let [WordPart::Zsh(s)] = &w.parts[..]
		&& s.first() == Some(&INBRACK)
		&& let Some(end) = tail(s, 1)
			.iter()
			.position(|&c| c == OUTBRACK)
			.map(|i| i + 1)
	{
		let append = s.get(end + 1) == Some(&b'+') && s.get(end + 2) == Some(&EQUALS);
		if append || s.get(end + 1) == Some(&EQUALS) {
			let vstart = end + 2 + usize::from(append);
			let lo = w.span.lo;
			let kspan = Span::new(lo + 1, lo + end as u32);
			let vspan = Span::new((lo + vstart as u32).min(w.span.hi), w.span.hi);
			return ArrayElem {
				key: Some(zword(span(s, 1, end).to_vec(), kspan)),
				append,
				value: zword(tail(s, vstart).to_vec(), vspan),
			};
		}
	}
	ArrayElem { key: None, append: false, value: w }
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
	fn tok_word(&self) -> Word {
		zword(self.lx.buf.clone(), self.tok_span())
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
	/// parsed, after an error or at a blank line or the end of input.
	pub(super) fn parse_event_top(&mut self) -> (bool, Vec<ListItem>) {
		self.lx.tok = T::Endinput;
		self.ps = ParseFlags { incmdpos: true, ..ParseFlags::default() };
		self.zshlex();
		let mut items = Vec::new();
		let ok = self.par_event(T::Endinput, &mut items);
		(ok, items)
	}

	/// zsh `parse_event(OUTPAR)` as `skipcomm` runs it: validates a command
	/// substitution body; the tree is discarded.
	pub(super) fn parse_event_nested(&mut self, endtok: T) -> bool {
		self.lx.tok = T::Endinput;
		self.ps.incmdpos = true;
		self.zshlex();
		let mut items = Vec::new();
		self.par_event(endtok, &mut items)
	}

	/// zsh `par_event` (its tail recursion as a loop).
	fn par_event(&mut self, endtok: T, items: &mut Vec<ListItem>) -> bool {
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
					items.push(ListItem { and_or, sep });
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
	fn par_list(&mut self) -> List {
		let mut items = Vec::new();
		loop {
			self.skip_seps();
			let Some(and_or) = self.par_sublist() else {
				break;
			};
			if let Some(sep) = self.item_sep() {
				items.push(ListItem { and_or, sep });
				self.ps.incmdpos = true;
				loop {
					self.zshlex();
					if self.lx.tok != T::Seper {
						break;
					}
				}
			} else {
				items.push(ListItem { and_or, sep: Sep::None });
				break;
			}
		}
		List { items }
	}

	/// zsh `par_list1`: one sublist.
	fn par_list1(&mut self) -> List {
		let mut items = Vec::new();
		if let Some(and_or) = self.par_sublist() {
			items.push(ListItem { and_or, sep: Sep::None });
		}
		List { items }
	}

	/// zsh `par_sublist`: `sublist2 [ ( DBAR | DAMPER ) { SEPER } sublist ]`.
	fn par_sublist(&mut self) -> Option<AndOr> {
		let lo = self.lx.lo;
		let first = self.par_sublist2()?;
		let mut rest = Vec::new();
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
				Some(p) => rest.push((op, p)),
				None => break,
			}
		}
		for _ in 0..pushed {
			self.cmdpop();
		}
		Some(AndOr { id: NodeId(0), span: Span::new(lo, self.lx.last_hi), first, rest })
	}

	/// zsh `par_sublist2`: `[ COPROC | BANG ] pline`.
	fn par_sublist2(&mut self) -> Option<Pipeline> {
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
		let stages = match pl {
			Some(Pline::Timed(mut tp)) if !coproc => {
				tp.span.lo = lo;
				if !bang {
					return Some(tp);
				}
				vec![Stage { cmd: pipeline_command(tp), pipe_stderr: false }]
			},
			Some(Pline::Timed(tp)) => {
				vec![Stage { cmd: pipeline_command(tp), pipe_stderr: false }]
			},
			Some(Pline::Stages(stages)) => stages,
			None => vec![Stage {
				cmd:         empty_command(Span::new(span.hi, span.hi)),
				pipe_stderr: false,
			}],
		};
		let mut p = Pipeline { id: NodeId(0), span, bang: false, time: None, stages };
		if coproc {
			let body = pipeline_command(p);
			let cmd = Command {
				id: NodeId(0),
				span,
				kind: CommandKind::Coproc(Coproc { name: None, body: Box::new(body) }),
				redirs: Vec::new(),
			};
			p = Pipeline {
				id: NodeId(0),
				span,
				bang: false,
				time: None,
				stages: vec![Stage { cmd, pipe_stderr: false }],
			};
		}
		p.bang = bang;
		Some(p)
	}

	/// zsh `par_pline`: `cmd [ ( BAR | BARAMP ) { SEPER } pline ]`.
	fn par_pline(&mut self) -> Option<Pline> {
		let mut stages = Vec::new();
		// zsh recurses with each `|`/`|&` on the cmdstack until it returns.
		let mut pushed = 0usize;
		loop {
			let Some(c) = self.par_cmd(false) else {
				if stages.is_empty() {
					return None;
				}
				self.lx.tok = T::Lexerr;
				break;
			};
			if matches!(self.lx.tok, T::Bar | T::Baramp) {
				let pipe_stderr = self.lx.tok == T::Baramp;
				stages.push(Stage { cmd: c.into_command(), pipe_stderr });
				self.cmdpush(if pipe_stderr { CS_ERRPIPE } else { CS_PIPE });
				pushed += 1;
				self.zshlex();
				self.skip_seps();
				continue;
			}
			if stages.is_empty()
				&& let Cmd::Timed(tp) = c
			{
				return Some(Pline::Timed(tp));
			}
			stages.push(Stage { cmd: c.into_command(), pipe_stderr: false });
			break;
		}
		for _ in 0..pushed {
			self.cmdpop();
		}
		Some(Pline::Stages(stages))
	}

	/// Redirections following a command.
	fn trailing_redirs(&mut self, redirs: &mut Vec<Redir>) {
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
			let mut c = pipeline_command(tp);
			c.redirs.append(&mut redirs);
			c.span = Span::new(lo, self.lx.last_hi);
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
				Some(CommandKind::Arith(ArithText { span: inner, src: s, bracket: false }))
			},
			_ => {
				if self.lx.tok == T::Time {
					self.lx.tok = T::String;
				}
				match self.par_simple(nr, &mut redirs) {
					Some(k) => Some(k),
					None if nr == 0 => return None,
					None => Some(failed()),
				}
			},
		};
		if cs.is_some() {
			self.cmdpop();
		}
		let kind = kind.unwrap_or_else(failed);
		self.trailing_redirs(&mut redirs);
		self.end_cmd();
		let mut cmd = Command { id: NodeId(0), span: Span::new(lo, self.lx.last_hi), kind, redirs };
		attach_function_redirs(&mut cmd);
		Some(Cmd::Plain(cmd))
	}

	/// The body of a loop after its head: `DO list DONE | INBRACE list
	/// OUTBRACE | list ZEND | list1`.
	fn loop_body(&mut self, csh: bool, kind: Loop) -> Option<List> {
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
	fn par_for(&mut self) -> Option<CommandKind> {
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
				exprs.push(ArithText { span, src, bracket: false });
			}
			self.ps.infor = 0;
			self.ps.incmdpos = true;
			self.zshlex();
			self.ps.incmdpos = true;
			self.skip_seps();
			let body = self.loop_body(csh, Loop::For)?;
			let mut it = exprs.into_iter();
			let (init, cond, step) = (it.next()?, it.next()?, it.next()?);
			return Some(CommandKind::ArithFor(ArithFor { init, cond, step, body }));
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
		let mut vars = vars.into_iter();
		let var = vars.next().unwrap_or_default();
		let f = For { var, extra_vars: vars.collect(), var_span, words, body };
		Some(if sel {
			CommandKind::Select(f)
		} else {
			CommandKind::For(f)
		})
	}

	/// zsh `par_case`.
	#[allow(clippy::cognitive_complexity, reason = "a direct port of zsh's par_case")]
	fn par_case(&mut self) -> Option<CommandKind> {
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
		let mut arms = Vec::new();
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
			let mut patterns = Vec::new();
			self.ps.incasepat = -1;
			self.ps.incmdpos = true;
			if !skip_lex {
				self.zshlex();
			}
			loop {
				if self.lx.tok == T::Outpar {
					patterns.push(zword(core::mem::take(&mut s.0), s.1));
					self.ps.incasepat = 0;
					self.ps.incmdpos = true;
					self.zshlex();
					break;
				} else if self.lx.tok == T::Bar {
					patterns.push(zword(core::mem::take(&mut s.0), s.1));
					self.ps.incasepat = 1;
					self.ps.incmdpos = false;
				} else {
					if patterns.is_empty() && s.0.first() == Some(&INPAR) {
						if !case_paren_pattern(&mut s.0) {
							return self.yyerr();
						}
						patterns.push(zword(core::mem::take(&mut s.0), s.1));
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
			arms.push(CaseArm { patterns, body, term });
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
		Some(CommandKind::Case(Case { word, arms }))
	}

	/// zsh `par_if`.
	#[allow(clippy::cognitive_complexity, reason = "a direct port of zsh's par_if")]
	fn par_if(&mut self) -> Option<CommandKind> {
		let mut arms = Vec::new();
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
				arms.push(IfArm { cond, body });
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
				arms.push(IfArm { cond, body });
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
				arms.push(IfArm { cond, body });
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
		if arms.is_empty() {
			return self.yyerr();
		}
		Some(CommandKind::If(If { arms, else_body }))
	}

	/// zsh `par_while`.
	fn par_while(&mut self) -> Option<CommandKind> {
		let until = self.lx.tok == T::Until;
		self.zshlex();
		let cond = self.par_list();
		self.ps.incmdpos = true;
		self.skip_seps();
		let body = self.loop_body(false, Loop::While)?;
		Some(CommandKind::While(While { until, cond, body }))
	}

	/// zsh `par_repeat`.
	fn par_repeat(&mut self) -> Option<CommandKind> {
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
		Some(CommandKind::Repeat(Repeat { count, body }))
	}

	/// zsh `par_subsh`: `( list )`, `{ list }`, `{ list } always { list }`.
	fn par_subsh(&mut self, zsh_construct: bool) -> Option<CommandKind> {
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
			return Some(CommandKind::Try(Try { body: list, always }));
		}
		Some(if otok == T::Inpar {
			CommandKind::Subshell(list)
		} else {
			CommandKind::Brace(list)
		})
	}

	/// A function body after `()` or the names: `INBRACE list OUTBRACE`,
	/// else a command (`name ()`) or a `list1` (`function`, under
	/// `shortloops`). `anon`: an anonymous function, whose arguments follow
	/// outside command position.
	fn func_body(&mut self, anon: bool, keyword: bool) -> Option<Command> {
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
			return Some(Command {
				id:     NodeId(0),
				span:   Span::new(lo, self.lx.last_hi),
				kind:   CommandKind::Brace(list),
				redirs: Vec::new(),
			});
		}
		if keyword {
			if !self.opt(Features::ZSH_SHORT_LOOPS) {
				return self.yyerr();
			}
			let list = self.par_list1();
			return Some(list_command(list, Span::new(lo, self.lx.last_hi)));
		}
		let Some(c) = self.par_cmd(anon) else {
			return self.yyerr();
		};
		if anon {
			self.ps.incmdpos = false;
		}
		Some(c.into_command())
	}

	/// zsh `par_funcdef`: `function name… [ () ] body` / `function body
	/// [ args ]`.
	fn par_funcdef(&mut self) -> Option<CommandKind> {
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
			return Some(CommandKind::AnonFunc(AnonFunc { body: Box::new(body), args, traced }));
		}
		let mut names = names.into_iter();
		let name = names.next().unwrap_or_default();
		Some(CommandKind::FuncDef(FuncDef {
			name,
			extra_names: names.collect(),
			keyword: true,
			traced,
			body: Box::new(body),
		}))
	}

	/// zsh `par_time`: `TIME sublist2`.
	fn par_time(&mut self, lo: u32) -> Pipeline {
		self.zshlex();
		if let Some(mut p) = self.par_sublist2() {
			p.time = Some(Time { posix: false });
			p.span.lo = lo;
			return p;
		}
		let span = Span::new(lo, self.lx.last_hi);
		Pipeline {
			id: NodeId(0),
			span,
			bang: false,
			time: Some(Time { posix: false }),
			stages: vec![Stage {
				cmd:         empty_command(Span::new(span.hi, span.hi)),
				pipe_stderr: false,
			}],
		}
	}

	/// zsh `par_dinbrack`: `DINBRACK cond DOUTBRACK`.
	fn par_dinbrack(&mut self) -> Option<CommandKind> {
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
		e.map(CommandKind::Cond)
	}

	/// An `ENVSTRING` token (`name[sub][+]=value`) as an assignment.
	fn envstring_assign(&self) -> Assign {
		let s = &self.lx.buf;
		let span = self.tok_span();
		let (name, index, mut p) = split_name(s);
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
			zword(i, Span::new(ilo, ilo))
		});
		Assign {
			id: NodeId(0),
			span,
			name,
			index,
			append,
			value: AssignValue::Scalar(zword(tail(s, value_from).to_vec(), Span::new(vlo, span.hi))),
		}
	}

	/// The elements of an array assignment after its `name=(`, up to its
	/// `)`.
	fn array_elems(&mut self) -> Option<Vec<ArrayElem>> {
		self.cmdpush(CS_ARRAY);
		self.zshlex();
		let words = self.par_nl_wordlist();
		self.cmdpop();
		if self.lx.tok != T::Outpar {
			return self.yyerr();
		}
		Some(words.into_iter().map(array_elem).collect())
	}

	/// zsh `par_simple`: assignments, words, redirections, and the
	/// `name ()` / `()` function definitions. `nr`: redirections `par_cmd`
	/// already read into `redirs`.
	#[allow(clippy::cognitive_complexity, reason = "a direct port of zsh's par_simple")]
	fn par_simple(&mut self, nr: usize, redirs: &mut Vec<Redir>) -> Option<CommandKind> {
		let mut nr = nr;
		let mut assigns = Vec::new();
		let mut words: Vec<Word> = Vec::new();
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
					assigns.push(self.envstring_assign());
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
					let index = index.map(|i| zword(i, Span::new(lo, lo)));
					assigns.push(Assign {
						id: NodeId(0),
						span: Span::new(lo, self.lx.hi),
						name,
						index,
						append,
						value: AssignValue::Array(elems),
					});
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
						let toksave = self.tok_word();
						let idstring = plain(span(b, 1, b.len() - 1));
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
						}
					}
					if !redir_var {
						if postassigns > 0 {
							postassigns += 1;
						} else {
							argc += 1;
						}
						words.push(self.tok_word());
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
					words.push(self.tok_word());
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
					let words_n = self.par_nl_wordlist();
					self.cmdpop();
					self.ps.intypeset = true;
					if self.lx.tok != T::Outpar {
						return self.yyerr();
					}
					let elems = words_n.into_iter().map(array_elem).collect();
					words.push(Word {
						id:    NodeId(0),
						span:  Span::new(lo, self.lx.hi),
						parts: vec![WordPart::Zsh(head), WordPart::Compound(elems)],
					});
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
						func = Some(CommandKind::AnonFunc(AnonFunc {
							body: Box::new(body),
							args,
							traced: false,
						}));
					} else {
						let mut names = words.iter().map(word_text);
						let name = names.next().unwrap_or_default();
						let extra_names = names.collect();
						func = Some(CommandKind::FuncDef(FuncDef {
							name,
							extra_names,
							keyword: false,
							traced: false,
							body: Box::new(body),
						}));
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
		Some(func.unwrap_or(CommandKind::Simple(Simple { assigns, words, typeset })))
	}

	/// zsh `par_redir`: `( OUTANG | … | TRINANG ) STRING`; `idstring` is the
	/// variable of a `{var}>` redirection.
	fn par_redir(&mut self, idstring: Option<Vec<u8>>) -> Option<Redir> {
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
		let fd = match idstring {
			Some(v) => Some(RedirFd::Var(v)),
			None => u32::try_from(fd1).ok().map(RedirFd::Num),
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
			return Some(Redir {
				span: Span::new(lo, hi),
				fd,
				op: RedirOp::HereDoc { strip_tabs: strip },
				target: RedirTarget::HereDoc(HereDoc {
					delim,
					delim_raw,
					quoted,
					text: crate::bash::syntax::parser::doc_placeholder(seq as u32),
				}),
			});
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
		self.zshlex();
		Some(Redir {
			span: Span::new(lo, target.span.hi),
			fd,
			op: redir_op(rt),
			target: RedirTarget::Word(target),
		})
	}

	/// zsh `par_wordlist`: `{ STRING }`.
	fn par_wordlist(&mut self) -> Vec<Word> {
		let mut words = Vec::new();
		while self.lx.tok == T::String {
			words.push(self.tok_word());
			self.zshlex();
		}
		words
	}

	/// zsh `par_nl_wordlist`: `{ STRING | SEPER }`.
	fn par_nl_wordlist(&mut self) -> Vec<Word> {
		let mut words = Vec::new();
		while matches!(self.lx.tok, T::String | T::Seper) {
			if self.lx.tok == T::String {
				words.push(self.tok_word());
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
	fn cond_error(&mut self, pre: &[u8], arg: &[u8]) -> Option<CondExpr> {
		let mut msg = pre.to_vec();
		msg.extend_from_slice(&plain(arg));
		self.zwarn(msg);
		self.errflag = true;
		self.yyerr()
	}

	/// zsh `par_cond`: `cond_1 { SEPER } [ DBAR { SEPER } cond ]`.
	fn par_cond(&mut self) -> Option<CondExpr> {
		let a = self.par_cond_1()?;
		while self.cond_sep() {
			self.zshlex();
		}
		if self.lx.tok == T::Dbar {
			self.zshlex();
			while self.cond_sep() {
				self.zshlex();
			}
			let b = self.par_cond()?;
			return Some(CondExpr::Or(Box::new(a), Box::new(b)));
		}
		Some(a)
	}

	/// zsh `par_cond_1`: `cond_2 { SEPER } [ DAMPER { SEPER } cond_1 ]`.
	fn par_cond_1(&mut self) -> Option<CondExpr> {
		let a = self.par_cond_2()?;
		while self.cond_sep() {
			self.zshlex();
		}
		if self.lx.tok == T::Damper {
			self.zshlex();
			while self.cond_sep() {
				self.zshlex();
			}
			let b = self.par_cond_1()?;
			return Some(CondExpr::And(Box::new(a), Box::new(b)));
		}
		Some(a)
	}

	/// zsh `par_cond_2`: `BANG cond_2 | INPAR cond OUTPAR | STRING STRING
	/// STRING | STRING STRING | STRING ( INANG | OUTANG ) STRING`.
	#[allow(clippy::cognitive_complexity, reason = "a direct port of zsh's par_cond_2")]
	fn par_cond_2(&mut self) -> Option<CondExpr> {
		while self.cond_sep() {
			self.zshlex();
		}
		if self.lx.tok == T::Bang {
			self.zshlex();
			let e = self.par_cond_2()?;
			return Some(CondExpr::Not(Box::new(e)));
		}
		if self.lx.tok == T::Inpar {
			self.zshlex();
			while self.cond_sep() {
				self.zshlex();
			}
			let r = self.par_cond();
			while self.cond_sep() {
				self.zshlex();
			}
			if self.lx.tok != T::Outpar {
				return self.yyerr();
			}
			self.zshlex();
			return r.map(|e| CondExpr::Group(Box::new(e)));
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
			return Some(CondExpr::Binary {
				op:  op.to_vec(),
				lhs: zword(s1.0, s1.1),
				rhs: zword(s3.0, s3.1),
			});
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
	fn par_cond_double(&mut self, a: Tw, b: Tw) -> Option<CondExpr> {
		if a.0.len() < 2 || !is_dash(a.0[0]) {
			return self.cond_error(b"parse error: condition expected: ", &a.0);
		}
		Some(CondExpr::Unary { op: plain(&a.0), arg: zword(b.0, b.1) })
	}

	/// zsh `par_cond_triple`: `a op b`.
	fn par_cond_triple(&mut self, lhs: Tw, mid: Tw, rhs: Tw) -> Option<CondExpr> {
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
			return Some(CondExpr::Binary {
				op:  plain(op),
				lhs: zword(lhs.0, lhs.1),
				rhs: zword(rhs.0, rhs.1),
			});
		}
		if lhs.0.len() > 1 && is_dash(lhs.0[0]) {
			return self.par_cond_multi(lhs, vec![mid, rhs]);
		}
		self.cond_error(b"condition expected: ", &mid.0)
	}

	/// zsh `par_cond_multi`: a module condition `-x arg…`. Its operands are
	/// the parts of the [`CondExpr::Unary`] word, one [`WordPart::Zsh`]
	/// each (no part for none), so a word with other than one part is such
	/// a condition.
	fn par_cond_multi(&mut self, a: Tw, l: Vec<Tw>) -> Option<CondExpr> {
		if a.0.len() < 2 || !is_dash(a.0[0]) {
			return self.cond_error(b"condition expected: ", &a.0);
		}
		let lo = l.first().map_or(a.1.hi, |t| t.1.lo);
		let hi = l.last().map_or(a.1.hi, |t| t.1.hi);
		let parts = l.into_iter().map(|t| WordPart::Zsh(t.0)).collect();
		Some(CondExpr::Unary {
			op:  plain(&a.0),
			arg: Word { id: NodeId(0), span: Span::new(lo, hi), parts },
		})
	}
}

/// The text of a function-name word.
fn word_text(w: &Word) -> Vec<u8> {
	match &w.parts[..] {
		[WordPart::Zsh(s)] => plain(s),
		_ => Vec::new(),
	}
}

/// zsh keeps redirections written on a function definition with the
/// function (`execfuncdef`'s `redir_prog`): they move onto the body, a
/// group around it if it is not one.
fn attach_function_redirs(cmd: &mut Command) {
	if cmd.redirs.is_empty() {
		return;
	}
	let CommandKind::FuncDef(f) = &mut cmd.kind else {
		return;
	};
	let redirs = core::mem::take(&mut cmd.redirs);
	if !matches!(f.body.kind, CommandKind::Brace(_)) {
		let body = core::mem::replace(&mut *f.body, empty_command(Span::default()));
		let span = body.span;
		let and_or = AndOr {
			id: NodeId(0),
			span,
			first: Pipeline {
				id: NodeId(0),
				span,
				bang: false,
				time: None,
				stages: vec![Stage { cmd: body, pipe_stderr: false }],
			},
			rest: Vec::new(),
		};
		*f.body = Command {
			id: NodeId(0),
			span,
			kind: CommandKind::Brace(List { items: vec![ListItem { and_or, sep: Sep::None }] }),
			redirs: Vec::new(),
		};
	}
	f.body.redirs.extend(redirs);
}
