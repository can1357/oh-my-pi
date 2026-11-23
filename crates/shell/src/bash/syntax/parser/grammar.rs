//! The bash 5.3 grammar (`parse.y`) as recursive descent over the lexer,
//! building nodes of the parser's [`Tree`](crate::bash::syntax::tree::Tree).

use alloc::{boxed::Box, vec::Vec};

use super::{
	PResult, ParseError, ParseErrorKind, Parser, SmallBytes,
	lex::{T, Tok},
};
use crate::bash::syntax::{
	ast::{AndOrOp, CaseTerm, CompleteCommand, ParseWarning, RedirOp, Sep, Time},
	span::Span,
	tree::{
		CondB, FdB, Id, Part, Payload, Seq, TargetB, TextPk, WordPart,
		shape::{self, AndOr, Command, Cond, List, Pipeline, Word},
	},
	util::push_u32,
};

/// Tokens that can begin a command.
const fn starts_command(k: T) -> bool {
	matches!(
		k,
		T::Word
			| T::Assign
			| T::Number
			| T::RedirWord
			| T::Bang
			| T::Time
			| T::If
			| T::Case
			| T::For
			| T::Select
			| T::While
			| T::Until
			| T::LParen
			| T::LBrace
			| T::ArithCmd
			| T::CondStart
			| T::Function
			| T::Coproc
	) || k.is_redir_op()
}

/// Tokens that begin a compound command (`shell_command`).
const fn starts_shell_command(k: T) -> bool {
	matches!(
		k,
		T::For
			| T::Case
			| T::While
			| T::Until
			| T::Select
			| T::If
			| T::LParen
			| T::LBrace
			| T::ArithCmd
			| T::CondStart
	)
}

/// Quote removal of a here-document delimiter word.
fn delim_text(parts: Seq<'_, WordPart<'_>>, out: &mut Vec<u8>) {
	for p in parts {
		match p.get() {
			Part::Lit(s) | Part::Escaped(s) | Part::SQuote(s) => out.extend_from_slice(s),
			Part::DQuote(inner) | Part::Locale(inner) => delim_text(inner, out),
			Part::AnsiC(raw) => {
				out.extend_from_slice(&crate::bash::syntax::util::ansi_decode(raw));
			},
			_ => crate::bash::syntax::print::one_part_text(p, out),
		}
	}
}

/// Split `for ((…))` text at its top-level `;`s (bash
/// `make_arith_for_command`): each piece starts after leading blanks.
fn split_arith_for(text: &[u8], semis: &[usize]) -> Vec<(usize, usize)> {
	let mut pieces = Vec::with_capacity(semis.len() + 1);
	let mut start = 0;
	for &end in semis.iter().chain(core::iter::once(&text.len())) {
		let mut s = start;
		while s < end && matches!(text[s], b' ' | b'\t') {
			s += 1;
		}
		pieces.push((s, end));
		start = end + 1;
	}
	pieces
}

/// A `test_unop` operator.
fn is_unop(w: &[u8]) -> bool {
	matches!(w, [b'-', c] if b"abcdefghknoprstuvwxzGLOSNR".contains(c))
}

/// A `test_binop` operator.
const fn is_binop(w: &[u8]) -> bool {
	matches!(
		w,
		b"="
			| b"<"
			| b">"
			| b"=="
			| b"!="
			| b"=~"
			| b"!~"
			| b"-nt"
			| b"-ot"
			| b"-lt"
			| b"-gt"
			| b"-eq"
			| b"-ef"
			| b"-ne"
			| b"-ge"
			| b"-le"
	)
}

/// The cond parser's error marker (bash `COND_ERROR`).
enum CondFail {
	/// A message was already decided.
	Err(ParseError),
	/// Silent failure: bash reports ``syntax error near `X'`` at the cursor.
	Silent,
}

type CResult<T> = Result<T, CondFail>;

impl From<ParseError> for CondFail {
	fn from(e: ParseError) -> Self {
		Self::Err(e)
	}
}

/// A top-level list read by [`Parser::top_list`].
pub(super) struct Top {
	pub list: Id<List>,
	pub lo:   u32,
	pub hi:   u32,
	pub line: u32,
}

impl Parser<'_> {
	/// One top-level command (`inputunit`); `None` at end of input.
	pub(super) fn complete_command(&mut self) -> PResult<Option<CompleteCommand>> {
		let source_replay = self.frames.is_empty() && self.in_source();
		self.t.clear();
		self.doc_nodes.clear();
		let Some(top) = self.top_list()? else {
			return Ok(None);
		};
		debug_assert_eq!(self.t.scratch_len(), 0, "a builder left children on the scratch stack");
		self.fill_docs(0);
		let node_count = self.t.assign_ids(top.list.index());
		// The command takes the buffers it was built in (see
		// `Parser::recycle`).
		let tree = core::mem::take(&mut self.t);
		Ok(Some(CompleteCommand {
			span: Span::new(top.lo, top.hi.max(top.lo)),
			line: top.line,
			tree,
			root: top.list,
			node_count,
			source_replay: source_replay && self.alias_uses.is_empty(),
			aliases: core::mem::take(&mut self.alias_uses),
			warnings: core::mem::take(&mut self.warnings),
		}))
	}

	/// The list of one top-level command, here-document bodies not yet
	/// filled in; `None` at end of input.
	pub(super) fn top_list(&mut self) -> PResult<Option<Top>> {
		self.reset_lexer();
		self.discard_line = false;
		self.compound.clear();
		self.alias_uses.clear();
		self.warnings.clear();
		self.docs.clear();
		self.pending.clear();
		loop {
			match self.peek_kind()? {
				T::Newline => {
					self.take()?;
					self.reset_lexer();
				},
				T::Eof => {
					self.la = None;
					return Ok(None);
				},
				_ => break,
			}
		}
		// A fresh parser: size the buffers once (the first token is already
		// in them); later commands reuse them.
		if self.t.nodes.capacity() < 64 {
			let rest = self.src.len().saturating_sub(self.src_pos());
			self.t.reserve_for(rest.min(2048));
			self.toks.reserve_for(rest.min(1024));
		}
		let first = self.peek_tok()?;
		let lo = first.lo;
		let line = first.line;
		let mark = self.t.open();
		loop {
			let and_or = self.and_or()?;
			match self.peek_kind()? {
				k @ (T::Semi | T::Amp) => {
					self.take()?;
					let sep = if k == T::Semi { Sep::Semi } else { Sep::Amp };
					let item = self.t.item(and_or, sep);
					self.t.kid(mark, item);
					if matches!(self.peek_kind()?, T::Newline | T::Eof) {
						break;
					}
				},
				T::Newline => {
					let item = self.t.item(and_or, Sep::Newline);
					self.t.kid(mark, item);
					break;
				},
				T::Eof => {
					let item = self.t.item(and_or, Sep::None);
					self.t.kid(mark, item);
					break;
				},
				_ => return Err(self.unexpected()),
			}
		}
		let list = self.t.list_at(mark);
		let mut hi = self.last_hi;
		// The terminator; a newline has already read pending here-documents.
		let term = self.take()?;
		if term.kind == T::Eof && !self.pending.is_empty() {
			self.gather();
		}
		if !self.docs.is_empty() {
			let end = self.src_pos();
			let end = if end > 0 && self.src.get(end - 1) == Some(&b'\n') {
				end - 1
			} else {
				end
			};
			hi = hi.max(self.base + end as u32);
		}
		Ok(Some(Top { list, lo, hi, line }))
	}

	/// A list inside a compound command (`compound_list`), one nesting
	/// level deeper.
	pub(super) fn compound_list(&mut self) -> PResult<Id<List>> {
		self.nested(Self::compound_items)
	}

	fn compound_items(&mut self) -> PResult<Id<List>> {
		self.skip_newlines()?;
		let mark = self.t.open();
		loop {
			if !starts_command(self.peek_kind()?) {
				if self.t.opened_len(mark) == 0 {
					return Err(self.unexpected());
				}
				break;
			}
			let and_or = self.and_or()?;
			let sep = match self.peek_kind()? {
				T::Semi => Sep::Semi,
				T::Amp => Sep::Amp,
				T::Newline => Sep::Newline,
				_ => {
					let item = self.t.item(and_or, Sep::None);
					self.t.kid(mark, item);
					break;
				},
			};
			self.take()?;
			self.skip_newlines()?;
			let item = self.t.item(and_or, sep);
			self.t.kid(mark, item);
			if !starts_command(self.peek_kind()?) {
				break;
			}
		}
		let list = self.t.list_at(mark);
		Ok(list)
	}

	fn and_or(&mut self) -> PResult<Id<AndOr>> {
		let lo = self.peek_tok()?.lo;
		let mark = self.t.open();
		let first = self.pipeline_command()?;
		self.t.kid(mark, first);
		loop {
			let op = match self.peek_kind()? {
				T::AndAnd => AndOrOp::And,
				T::OrOr => AndOrOp::Or,
				_ => break,
			};
			self.take()?;
			self.skip_newlines()?;
			let p = self.pipeline_command()?;
			self.t.set_connector(p, op);
			self.t.kid(mark, p);
		}
		let n = self.t.and_or_at(Span::new(lo, self.last_hi), mark);
		Ok(n)
	}

	fn pipeline_command(&mut self) -> PResult<Id<Pipeline>> {
		let lo = self.peek_tok()?.lo;
		let mut bang = false;
		let mut time: Option<Time> = None;
		// `! !` toggles back to no inversion but still allows the null
		// command.
		let mut prefixed = false;
		loop {
			match self.peek_kind()? {
				T::Bang => {
					self.take()?;
					bang = !bang;
					prefixed = true;
				},
				T::Time => {
					self.take()?;
					let opt = self.peek_kind()? == T::TimeOpt;
					if opt {
						self.take()?;
					}
					let ign = self.peek_kind()? == T::TimeIgn;
					if ign {
						self.take()?;
					}
					let posix = time.is_some_and(|t| t.posix) || opt || ign;
					time = Some(Time { posix });
				},
				_ => break,
			}
		}
		if (prefixed || time.is_some())
			&& matches!(self.peek_kind()?, T::Newline | T::Semi | T::Amp | T::Eof)
		{
			let at = self.last_hi;
			let s = self.t.simple(&[], &[], false);
			let cmd = self.t.command(Span::new(at, at), Payload::Simple(s), &[]);
			return Ok(self
				.t
				.pipeline(Span::new(lo, self.last_hi), bang, time, &[cmd]));
		}
		let mark = self.t.open();
		let first = self.command()?;
		self.t.kid(mark, first);
		loop {
			let k = self.peek_kind()?;
			if !matches!(k, T::Bar | T::BarAnd) {
				break;
			}
			self.take()?;
			if k == T::BarAnd
				&& let Some(last) = self.t.opened_last(mark)
			{
				self.t.set_pipe_stderr(last);
			}
			self.skip_newlines()?;
			let c = self.command()?;
			self.t.kid(mark, c);
		}
		let n = self
			.t
			.pipeline_at(Span::new(lo, self.last_hi), bang, time, mark);
		Ok(n)
	}

	fn command(&mut self) -> PResult<Id<Command>> {
		let k = self.peek_kind()?;
		let lo = self.peek_tok()?.lo;
		match k {
			T::Word => {
				let t = self.take()?;
				if self.peek_kind()? == T::LParen {
					return self.posix_function(t, lo);
				}
				self.simple(Some(t), lo)
			},
			T::Assign | T::Number | T::RedirWord => self.simple(None, lo),
			_ if k.is_redir_op() => self.simple(None, lo),
			T::Function => self.function_keyword(lo),
			T::Coproc => self.coproc(lo),
			_ if starts_shell_command(k) => self.shell_command_with_redirs(lo),
			_ => Err(self.unexpected()),
		}
	}

	/// `shell_command [redirection_list]`.
	fn shell_command_with_redirs(&mut self, lo: u32) -> PResult<Id<Command>> {
		let payload = self.shell_command()?;
		let mark = self.t.open();
		loop {
			let k = self.peek_kind()?;
			if !(matches!(k, T::Number | T::RedirWord) || k.is_redir_op()) {
				break;
			}
			let r = self.redirection()?;
			self.t.kid(mark, r);
		}
		let n = self
			.t
			.command_at(Span::new(lo, self.last_hi), payload, mark);
		Ok(n)
	}

	fn expect(&mut self, k: T) -> PResult<Tok> {
		let t = self.take()?;
		if t.kind == k {
			Ok(t)
		} else {
			Err(self.token_error(&t))
		}
	}

	/// A compound command's payload.
	fn shell_command(&mut self) -> PResult<Payload> {
		let k = self.peek_kind()?;
		Ok(match k {
			T::For => self.for_cmd()?,
			T::Select => Payload::Select(self.select_cmd()?),
			T::Case => Payload::Case(self.case_cmd()?),
			T::While | T::Until => {
				self.take()?;
				let cond = self.compound_list()?;
				self.expect(T::Do)?;
				let body = self.compound_list()?;
				self.expect(T::Done)?;
				self.close_compound();
				Payload::While(self.t.while_(k == T::Until, cond, body))
			},
			T::If => Payload::If(self.if_cmd()?),
			T::LParen => {
				self.take()?;
				let body = self.compound_list()?;
				self.expect(T::RParen)?;
				self.close_compound();
				Payload::Subshell(body)
			},
			T::LBrace => {
				self.take()?;
				let body = self.compound_list()?;
				self.expect(T::RBrace)?;
				self.close_compound();
				Payload::Brace(body)
			},
			T::ArithCmd => {
				let t = self.take()?;
				let t = self.take_arith(t);
				Payload::Arith(self.t.arith(Span::new(t.lo, t.hi), &t.text, false))
			},
			T::CondStart => Payload::Cond(self.cond_command()?),
			_ => return Err(self.unexpected()),
		})
	}

	fn if_cmd(&mut self) -> PResult<Id<shape::If>> {
		self.take()?;
		let mark = self.t.open();
		let cond = self.compound_list()?;
		self.expect(T::Then)?;
		let body = self.compound_list()?;
		self.t.kid(mark, cond);
		self.t.kid(mark, body);
		let mut else_body = None;
		loop {
			let t = self.take()?;
			match t.kind {
				T::Elif => {
					let cond = self.compound_list()?;
					self.expect(T::Then)?;
					let body = self.compound_list()?;
					self.t.kid(mark, cond);
					self.t.kid(mark, body);
				},
				T::Else => {
					else_body = Some(self.compound_list()?);
					self.expect(T::Fi)?;
					break;
				},
				T::Fi => break,
				_ => return Err(self.token_error(&t)),
			}
		}
		self.close_compound();
		let n = self.t.if_at(else_body, mark);
		Ok(n)
	}

	/// After `for NAME` / `select NAME`: the optional `in` list and the body,
	/// then the `for` node.
	fn loop_tail(&mut self, var: &[u8], var_span: Span) -> PResult<Id<shape::For>> {
		let mark = self.t.open();
		let mut words = false;
		if self.peek_kind()? == T::Semi {
			self.take()?;
			self.skip_newlines()?;
		} else {
			self.skip_newlines()?;
			if self.peek_kind()? == T::In {
				self.take()?;
				loop {
					match self.peek_kind()? {
						T::Word | T::Assign | T::Number => {
							let t = self.take()?;
							let w = self.tok_word(t);
							self.t.kid(mark, w);
						},
						T::Newline | T::Semi => {
							self.take()?;
							break;
						},
						T::Eof => break,
						_ => return Err(self.unexpected()),
					}
				}
				self.skip_newlines()?;
				words = true;
			}
		}
		let body = self.do_body()?;
		let n = self.t.for_at(&[var], var_span, words.then_some(mark), body);
		Ok(n)
	}

	/// `DO compound_list DONE` or `'{' compound_list '}'`.
	fn do_body(&mut self) -> PResult<Id<List>> {
		let t = self.take()?;
		match t.kind {
			T::Do => {
				let body = self.compound_list()?;
				self.expect(T::Done)?;
				self.close_compound();
				Ok(body)
			},
			T::LBrace => {
				let body = self.compound_list()?;
				self.expect(T::RBrace)?;
				self.close_compound();
				self.close_compound();
				Ok(body)
			},
			_ => Err(self.token_error(&t)),
		}
	}

	/// A word token as a word (numbers become literal words).
	fn tok_word(&mut self, t: Tok) -> Id<Word> {
		if t.has_word() {
			let w = self.take_word(t);
			return self.word_node(w);
		}
		let mut text = SmallBytes::new();
		push_u32(&mut text, t.val);
		let p = self.t.text_part(TextPk::Lit, &text);
		self.t.word(t.span(), &[p])
	}

	/// Text of a word token for names (`for NAME`, `function NAME`).
	fn word_text(&self, t: &Tok) -> SmallBytes {
		let w = self.word(t);
		if let Some(s) = w.plain() {
			return SmallBytes::from_slice(s);
		}
		let mut out = Vec::new();
		w.render(&self.t, &mut out);
		out.into()
	}

	fn for_cmd(&mut self) -> PResult<Payload> {
		let for_line = self.take()?.line;
		let t = self.take()?;
		if t.kind == T::ArithFor {
			return Ok(Payload::ArithFor(self.arith_for(t, for_line)?));
		}
		if !matches!(t.kind, T::Word | T::Assign) {
			return Err(self.token_error(&t));
		}
		let var = self.word_text(&t);
		Ok(Payload::For(self.loop_tail(&var, t.span())?))
	}

	fn select_cmd(&mut self) -> PResult<Id<shape::For>> {
		self.take()?;
		let t = self.take()?;
		if !matches!(t.kind, T::Word | T::Assign) {
			return Err(self.token_error(&t));
		}
		let var = self.word_text(&t);
		self.loop_tail(&var, t.span())
	}

	fn arith_for(&mut self, t: Tok, for_line: u32) -> PResult<Id<shape::ArithFor>> {
		if matches!(self.peek_kind()?, T::Newline | T::Semi) {
			self.take()?;
			self.skip_newlines()?;
		} else if self.peek_kind()? == T::Eof {
			self.skip_newlines()?;
		}
		let body = self.do_body()?;
		let arith = self.take_arith(t);
		let pieces = split_arith_for(&arith.text, &arith.semis);
		if pieces.len() != 3 {
			let detail: &[u8] = if pieces.len() < 3 {
				b"syntax error: arithmetic expression required"
			} else {
				b"syntax error: `;' unexpected"
			};
			let mut msg = b"syntax error: `((".to_vec();
			msg.extend_from_slice(&arith.text);
			msg.extend_from_slice(b"))'");
			let kind = ParseErrorKind::Message(msg.into_boxed_slice());
			return Err(
				ParseError::new(t.span(), for_line, kind)
					.with_detail(Some(ParseWarning { line: for_line, bash_msg: detail.to_vec() })),
			);
		}
		let mut at = |i: usize| {
			let (s, e) = pieces[i];
			let span = Span::new(arith.lo + s as u32, (arith.lo + e as u32).min(arith.hi));
			self.t.arith(span, &arith.text[s..e], false)
		};
		let (init, cond, step) = (at(0), at(1), at(2));
		Ok(self.t.arith_for(init, cond, step, body))
	}

	fn case_cmd(&mut self) -> PResult<Id<shape::Case>> {
		self.take()?;
		let t = self.take()?;
		if !matches!(t.kind, T::Word | T::Assign | T::Number) {
			return Err(self.token_error(&t));
		}
		let word = self.tok_word(t);
		self.skip_newlines()?;
		self.expect(T::In)?;
		let arms = self.t.open();
		loop {
			self.skip_newlines()?;
			if self.peek_kind()? == T::Esac {
				self.take()?;
				break;
			}
			if self.peek_kind()? == T::LParen {
				self.take()?;
			}
			let pats = self.t.open();
			loop {
				let t = self.take()?;
				if !matches!(t.kind, T::Word | T::Assign | T::Number) {
					return Err(self.token_error(&t));
				}
				let p = self.tok_word(t);
				self.t.kid(pats, p);
				if self.peek_kind()? == T::Bar {
					self.take()?;
				} else {
					break;
				}
			}
			self.expect(T::RParen)?;
			self.skip_newlines()?;
			let body =
				if matches!(self.peek_kind()?, T::SemiSemi | T::SemiAnd | T::SemiSemiAnd | T::Esac) {
					self.t.list(&[])
				} else {
					self.compound_list()?
				};
			let t = self.take()?;
			let (term, end) = match t.kind {
				T::SemiSemi => (CaseTerm::Break, false),
				T::SemiAnd => (CaseTerm::FallThrough, false),
				T::SemiSemiAnd => (CaseTerm::Continue, false),
				T::Esac => (CaseTerm::Break, true),
				_ => return Err(self.token_error(&t)),
			};
			let arm = self.t.case_arm_at(body, term, pats);
			self.t.kid(arms, arm);
			if end {
				break;
			}
		}
		self.close_compound();
		let n = self.t.case_at(word, arms);
		Ok(n)
	}

	/// `NAME ( ) newline_list function_body`; the name token was taken.
	fn posix_function(&mut self, name: Tok, lo: u32) -> PResult<Id<Command>> {
		self.take()?;
		self.expect(T::RParen)?;
		self.skip_newlines()?;
		let name = self.word_text(&name);
		self.function_body(&name, false, lo)
	}

	fn function_keyword(&mut self, lo: u32) -> PResult<Id<Command>> {
		self.take()?;
		let t = self.take()?;
		if !matches!(t.kind, T::Word | T::Assign) {
			return Err(self.token_error(&t));
		}
		let name = self.word_text(&t);
		match self.peek_kind()? {
			T::LParen => {
				self.take()?;
				self.expect(T::RParen)?;
				self.skip_newlines()?;
			},
			T::Newline => self.skip_newlines()?,
			_ => {},
		}
		self.function_body(&name, true, lo)
	}

	fn function_body(&mut self, name: &[u8], keyword: bool, lo: u32) -> PResult<Id<Command>> {
		let k = self.peek_kind()?;
		if !starts_shell_command(k) {
			return Err(self.unexpected());
		}
		let blo = self.peek_tok()?.lo;
		let body = self.shell_command_with_redirs(blo)?;
		let f = self.t.funcdef(&[name], keyword, false, body);
		Ok(self
			.t
			.command(Span::new(lo, self.last_hi), Payload::FuncDef(f), &[]))
	}

	fn coproc(&mut self, lo: u32) -> PResult<Id<Command>> {
		self.take()?;
		let k = self.peek_kind()?;
		let (name, body) = if starts_shell_command(k) {
			let blo = self.peek_tok()?.lo;
			(None, self.shell_command_with_redirs(blo)?)
		} else if k == T::Word {
			let blo = self.peek_tok()?.lo;
			let t = self.take()?;
			if starts_shell_command(self.peek_kind()?) {
				let name = self.word_text(&t);
				let blo2 = self.peek_tok()?.lo;
				(Some(name), self.shell_command_with_redirs(blo2)?)
			} else {
				(None, self.simple(Some(t), blo)?)
			}
		} else if matches!(k, T::Assign | T::Number | T::RedirWord) || k.is_redir_op() {
			let blo = self.peek_tok()?.lo;
			(None, self.simple(None, blo)?)
		} else {
			return Err(self.unexpected());
		};
		let c = self.t.coproc(name.as_deref(), body);
		Ok(self
			.t
			.command(Span::new(lo, self.last_hi), Payload::Coproc(c), &[]))
	}

	/// A simple command; `first` is an already-taken first word.
	fn simple(&mut self, first: Option<Tok>, lo: u32) -> PResult<Id<Command>> {
		let mark = self.t.open();
		let mut have_word = false;
		if let Some(t) = first {
			self.lx.redirlist = false;
			have_word = true;
			let w = self.tok_word(t);
			self.t.kid(mark, w);
		}
		let mut first_elem = !have_word;
		loop {
			let k = self.peek_kind()?;
			match k {
				T::Word | T::Assign => {
					let t = self.take()?;
					self.lx.redirlist = false;
					if k == T::Assign && !have_word {
						let w = self.take_word(t);
						if w.is_assign() {
							let a = self.assign_node(w);
							self.t.kid(mark, a);
						} else {
							let w = self.word_node(w);
							have_word = true;
							self.t.kid(mark, w);
						}
					} else {
						let w = self.tok_word(t);
						have_word = true;
						self.t.kid(mark, w);
					}
				},
				_ if matches!(k, T::Number | T::RedirWord) || k.is_redir_op() => {
					let r = self.redirection()?;
					self.t.kid(mark, r);
					if first_elem {
						self.lx.redirlist = true;
					}
				},
				_ => break,
			}
			first_elem = false;
		}
		self.lx.redirlist = false;
		let n = self.t.simple_at(Span::new(lo, self.last_hi), mark);
		Ok(n)
	}

	fn redirection(&mut self) -> PResult<Id<shape::Redir>> {
		let lo = self.peek_tok()?.lo;
		let mut fd_num = None;
		let mut fd_var: Option<Vec<u8>> = None;
		match self.peek_kind()? {
			T::Number => {
				let t = self.take()?;
				fd_num = Some(t.val);
			},
			T::RedirWord => {
				let t = self.take()?;
				let mut text = Vec::new();
				self.word(&t).render(&self.t, &mut text);
				let name = text
					.get(1..text.len().saturating_sub(1))
					.unwrap_or_default()
					.to_vec();
				fd_var = Some(name);
			},
			_ => {},
		}
		let has_fd = fd_num.is_some() || fd_var.is_some();
		let t = self.take()?;
		let op = match t.kind {
			T::Lt => RedirOp::In,
			T::Gt => RedirOp::Out,
			T::GtGt => RedirOp::Append,
			T::GtBar => RedirOp::Clobber,
			T::LtGt => RedirOp::ReadWrite,
			T::LtAnd => RedirOp::DupIn,
			T::GtAnd => RedirOp::DupOut,
			T::AndGt if !has_fd => RedirOp::OutErr,
			T::AndGtGt if !has_fd => RedirOp::AppendErr,
			T::LtLt => RedirOp::HereDoc { strip_tabs: false },
			T::LtLtDash => RedirOp::HereDoc { strip_tabs: true },
			T::LtLtLt => RedirOp::HereString,
			_ => return Err(self.token_error(&t)),
		};
		let w = self.take()?;
		let target = match (op, w.kind) {
			(RedirOp::DupIn | RedirOp::DupOut, T::Number) => {
				let mut text = SmallBytes::new();
				push_u32(&mut text, w.val);
				let p = self.t.text_part(TextPk::Lit, &text);
				TargetB::Word(self.t.word(w.span(), &[p]))
			},
			(RedirOp::DupIn | RedirOp::DupOut, T::Dash) => {
				let p = self.t.text_part(TextPk::Lit, b"-");
				TargetB::Word(self.t.word(w.span(), &[p]))
			},
			(RedirOp::HereDoc { strip_tabs }, T::Word | T::Assign) => {
				// bash `push_heredoc`: at most 16 documents wait for their
				// bodies; the 17th is fatal (bash exits the shell).
				if self.pending.len() >= 16 {
					let kind =
						ParseErrorKind::Message(Box::from(&b"maximum here-document count exceeded"[..]));
					return Err(ParseError::new(w.span(), self.bash_line(), kind));
				}
				let wt = self.take_word(w);
				let quoted = wt.quoted;
				let mut delim_raw = Vec::new();
				wt.render(&self.t, &mut delim_raw);
				let word = self.word_node(wt);
				let mut delim = Vec::new();
				delim_text(crate::bash::syntax::tree::Word::of(&self.t, word).parts(), &mut delim);
				let seq = self.push_doc(delim.clone(), strip_tabs, quoted);
				let doc = self.t.heredoc(&delim, &delim_raw, quoted, b"");
				let text = self.t.heredoc_body(doc);
				self.doc_nodes.push((text, seq));
				TargetB::HereDoc(doc)
			},
			(_, T::Word | T::Assign) => TargetB::Word(self.tok_word(w)),
			_ => return Err(self.token_error(&w)),
		};
		let fd = match (&fd_num, &fd_var) {
			(Some(n), _) => Some(FdB::Num(*n)),
			(None, Some(v)) => Some(FdB::Var(v)),
			(None, None) => None,
		};
		Ok(self.t.redir(Span::new(lo, self.last_hi), op, fd, target))
	}

	// ---- [[ … ]] ---------------------------------------------------------

	fn cond_command(&mut self) -> PResult<Id<Cond>> {
		self.cond_line = self.bash_line();
		self.take()?;
		// bash reads the expression with `read_token` directly, so the last
		// token stays `[[` throughout.
		self.lx.before = self.lx.last;
		self.lx.last = self.lx.cur;
		self.lx.condexpr = true;
		let mut tok = T::Eof;
		let res = self.cond_or(&mut tok);
		let expr = match res {
			Ok(e) if tok == T::CondEnd => e,
			Ok(_) => {
				let detail = self.cond_error(tok);
				return Err(self.near_with(Some(detail)));
			},
			Err(CondFail::Err(e)) => return Err(e),
			Err(CondFail::Silent) => return Err(self.near_with(None)),
		};
		self.lx.condcmd = false;
		self.lx.condexpr = false;
		self.lx.before = T::CondCmd;
		self.lx.last = T::CondCmd;
		self.lx.cur = T::CondEnd;
		self.close_compound();
		Ok(expr)
	}

	/// The message bash prints when the expression ends at `tok`.
	fn cond_error(&mut self, tok: T) -> ParseWarning {
		let line = self.bash_line();
		if tok == T::Eof {
			return ParseWarning { line, bash_msg: b"unexpected EOF while looking for `]]'".to_vec() };
		}
		let mut msg = b"syntax error in conditional expression".to_vec();
		let text = self
			.last_cond_text
			.take()
			.unwrap_or_else(|| tok.text().to_vec());
		if !text.is_empty() {
			msg.extend_from_slice(b": unexpected token `");
			msg.extend_from_slice(&text);
			msg.push(b'\'');
		}
		ParseWarning { line, bash_msg: msg }
	}

	/// ``syntax error near `X'`` after a `[[ … ]]` failure (or the
	/// end-of-file error when input ran out).
	fn near_with(&mut self, detail: Option<ParseWarning>) -> ParseError {
		let at_eof = self.peek().is_none();
		let e = if at_eof
			&& detail
				.as_ref()
				.is_some_and(|d| d.bash_msg.starts_with(b"unexpected EOF"))
		{
			self.eof_error()
		} else {
			self.near_error()
		};
		e.with_detail(detail)
	}

	/// Read a cond token (no token-history shift), remembering its text.
	fn cond_read(&mut self) -> PResult<Tok> {
		let t = self.read_token()?;
		// One buffer for every token of the expression.
		let mut text = self.last_cond_text.take().unwrap_or_default();
		text.clear();
		self.token_text_into(&t, &mut text);
		self.last_cond_text = Some(text);
		self.cond_eof = t.kind == T::Eof;
		if !self.cond_eof {
			// The command's span runs through `]]`.
			self.last_hi = t.hi;
		}
		Ok(t)
	}

	fn cond_skip_newlines(&mut self) -> PResult<Tok> {
		loop {
			let t = self.cond_read()?;
			if t.kind != T::Newline {
				return Ok(t);
			}
		}
	}

	fn cond_or(&mut self, tok: &mut T) -> CResult<Id<Cond>> {
		let l = self.cond_and(tok)?;
		if *tok == T::OrOr {
			let r = self.nested(|p| p.cond_or(tok))?;
			return Ok(self.t.cond(CondB::Or(l, r)));
		}
		Ok(l)
	}

	fn cond_and(&mut self, tok: &mut T) -> CResult<Id<Cond>> {
		let l = self.cond_term(tok)?;
		if *tok == T::AndAnd {
			let r = self.nested(|p| p.cond_and(tok))?;
			return Ok(self.t.cond(CondB::And(l, r)));
		}
		Ok(l)
	}

	fn cond_msg(&self, text: &[u8], pre: &[u8], post: &[u8]) -> CondFail {
		// bash counts the newline before the end of input it just read.
		let line = if self.cond_eof {
			self.eof_line()
		} else {
			self.bash_line()
		};
		self.cond_msg_at(line, text, pre, post)
	}

	/// A `[[ … ]]` error with its message at `line`; the final error is
	/// bash's end-of-file error when the last token read was the end of
	/// input, else ``syntax error near `X'``.
	fn cond_msg_at(&self, line: u32, text: &[u8], pre: &[u8], post: &[u8]) -> CondFail {
		let mut msg = pre.to_vec();
		msg.extend_from_slice(text);
		msg.extend_from_slice(post);
		let detail = ParseWarning { line, bash_msg: msg };
		CondFail::Err(self.cond_final().with_detail(Some(detail)))
	}

	fn cond_final(&self) -> ParseError {
		if self.cond_eof {
			self.eof_error()
		} else {
			self.near_error()
		}
	}

	fn cond_term(&mut self, tok: &mut T) -> CResult<Id<Cond>> {
		let t = self.cond_skip_newlines()?;
		*tok = t.kind;
		match t.kind {
			T::CondEnd => Err(CondFail::Silent),
			T::LParen => {
				let inner = match self.nested(|p| p.cond_or(tok)) {
					Ok(inner) => inner,
					Err(CondFail::Err(e)) => {
						// bash adds ``expected `)'`` (at the line of `[[`) after
						// the error inside the parentheses.
						let mut warnings = e.warnings.into_vec();
						warnings.extend(
							e.detail
								.map(|(line, msg)| ParseWarning { line, bash_msg: msg.into_vec() }),
						);
						let detail =
							ParseWarning { line: self.cond_line, bash_msg: b"expected `)'".to_vec() };
						let mut fin = if self.cond_eof {
							self.eof_error()
						} else {
							ParseError { warnings: Box::new([]), detail: None, ..e }
						};
						fin.warnings = warnings.into_boxed_slice();
						return Err(CondFail::Err(fin.with_detail(Some(detail))));
					},
					Err(CondFail::Silent) => return Err(CondFail::Silent),
				};
				if *tok != T::RParen {
					let text = self.last_cond_text.clone().unwrap_or_default();
					return Err(self.cond_msg_at(
						self.cond_line,
						&text,
						b"unexpected token `",
						b"', expected `)'",
					));
				}
				let next = self.cond_skip_newlines()?;
				*tok = next.kind;
				Ok(self.t.cond(CondB::Group(inner)))
			},
			T::Bang => {
				let inner = self.nested(|p| p.cond_term(tok))?;
				Ok(self.t.cond(CondB::Not(inner)))
			},
			T::Word | T::Assign | T::Number => {
				let w = self.tok_word(t);
				if plain_text(&self.t, w) == Some(b"!") {
					let inner = self.nested(|p| p.cond_term(tok))?;
					return Ok(self.t.cond(CondB::Not(inner)));
				}
				if let Some(op) = plain_text(&self.t, w)
					&& is_unop(op)
				{
					let op = SmallBytes::from_slice(op);
					let a = self.cond_read()?;
					if !matches!(a.kind, T::Word | T::Assign | T::Number) {
						let text = self.token_text(&a);
						return Err(self.cond_msg(
							&text,
							b"unexpected argument `",
							b"' to conditional unary operator",
						));
					}
					let arg = self.tok_word(a);
					let next = self.cond_skip_newlines()?;
					*tok = next.kind;
					return Ok(self.t.cond(CondB::Unary { op: &op, arg }));
				}
				let o = self.cond_read()?;
				let op: SmallBytes = match o.kind {
					T::Word | T::Assign => {
						let ow = self.tok_word(o);
						match plain_text(&self.t, ow) {
							Some(text) if is_binop(text) => {
								if matches!(text, b"=" | b"==" | b"!=") {
									self.lx.extpat = true;
								} else if text == b"=~" {
									self.lx.regexp = true;
								}
								SmallBytes::from_slice(text)
							},
							_ => {
								let text = self.last_cond_text.clone().unwrap_or_default();
								return Err(self.cond_msg(
									&text,
									b"unexpected token `",
									b"', conditional binary operator expected",
								));
							},
						}
					},
					T::Lt => SmallBytes::from_slice(b"<"),
					T::Gt => SmallBytes::from_slice(b">"),
					T::CondEnd | T::AndAnd | T::OrOr | T::RParen => {
						*tok = o.kind;
						return Ok(self.t.cond(CondB::Word(w)));
					},
					_ => {
						let text = self.token_text(&o);
						return Err(self.cond_msg(
							&text,
							b"unexpected token `",
							b"', conditional binary operator expected",
						));
					},
				};
				let saved_extglob = self.lx.extglob;
				if self.lx.extpat {
					self.lx.extglob = true;
				}
				let r = self.cond_read();
				self.lx.extglob = saved_extglob;
				self.lx.extpat = false;
				self.lx.regexp = false;
				let r = r?;
				if !matches!(r.kind, T::Word | T::Assign | T::Number) {
					let text = self.token_text(&r);
					return Err(self.cond_msg(
						&text,
						b"unexpected argument `",
						b"' to conditional binary operator",
					));
				}
				let rhs = self.tok_word(r);
				let next = self.cond_skip_newlines()?;
				*tok = next.kind;
				Ok(self.t.cond(CondB::Binary { op: &op, lhs: w, rhs }))
			},
			_ => {
				let text = self.token_text(&t);
				Err(self.cond_msg(&text, b"unexpected token `", b"' in conditional command"))
			},
		}
	}
}

/// The text of word `w` when it is one literal.
fn plain_text(t: &crate::bash::syntax::tree::Tree, w: Id<Word>) -> Option<&[u8]> {
	let parts = crate::bash::syntax::tree::Word::of(t, w).parts();
	match (parts.len(), parts.first().map(WordPart::get)) {
		(1, Some(Part::Lit(s))) => Some(s),
		_ => None,
	}
}
