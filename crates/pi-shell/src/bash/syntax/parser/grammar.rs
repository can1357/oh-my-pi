//! The bash 5.3 grammar (`parse.y`) as recursive descent over the lexer.

use alloc::{boxed::Box, vec, vec::Vec};

use super::{
	PResult, ParseError, ParseErrorKind, Parser, doc_placeholder,
	lex::{T, Tok},
	word::WordTok,
};
use crate::bash::syntax::{
	ast::*,
	span::{NodeId, Span},
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

/// Text of a word token for names (`for NAME`, `function NAME`).
fn word_text(w: &WordTok) -> Vec<u8> {
	let mut out = Vec::new();
	w.render(&mut out);
	out
}

/// Quote removal of a here-document delimiter word.
fn delim_text(parts: &[WordPart], out: &mut Vec<u8>) {
	for p in parts {
		match p {
			WordPart::Lit(s) | WordPart::Escaped(s) | WordPart::SQuote(s) => out.extend_from_slice(s),
			WordPart::DQuote(inner) | WordPart::Locale(inner) => delim_text(inner, out),
			WordPart::AnsiC(raw) => {
				out.extend_from_slice(&crate::bash::syntax::util::ansi_decode(raw));
			},
			other => crate::bash::syntax::print::parts_text(core::slice::from_ref(other), out),
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

impl Parser<'_> {
	/// One top-level command (`inputunit`); `None` at end of input.
	pub(super) fn complete_command(&mut self) -> PResult<Option<CompleteCommand>> {
		let source_replay = self.frames.is_empty() && self.in_source();
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
		let first = self.peek_tok()?;
		let lo = first.lo;
		let line = first.line;
		let mut items = Vec::new();
		loop {
			let and_or = self.and_or()?;
			match self.peek_kind()? {
				k @ (T::Semi | T::Amp) => {
					self.take()?;
					let sep = if k == T::Semi { Sep::Semi } else { Sep::Amp };
					items.push(ListItem { and_or, sep });
					if matches!(self.peek_kind()?, T::Newline | T::Eof) {
						break;
					}
				},
				T::Newline => {
					items.push(ListItem { and_or, sep: Sep::Newline });
					break;
				},
				T::Eof => {
					items.push(ListItem { and_or, sep: Sep::None });
					break;
				},
				_ => return Err(self.unexpected()),
			}
		}
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
		let mut list = List { items };
		super::finish::fill_docs(&mut list, &self.docs);
		let node_count = super::finish::assign_ids(&mut list);
		Ok(Some(CompleteCommand {
			span: Span::new(lo, hi.max(lo)),
			line,
			list,
			node_count,
			source_replay: source_replay && self.alias_uses.is_empty(),
			aliases: core::mem::take(&mut self.alias_uses),
			warnings: core::mem::take(&mut self.warnings),
		}))
	}

	/// A list inside a compound command (`compound_list`).
	pub(super) fn compound_list(&mut self) -> PResult<List> {
		self.skip_newlines()?;
		let mut items = Vec::new();
		loop {
			if !starts_command(self.peek_kind()?) {
				if items.is_empty() {
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
					items.push(ListItem { and_or, sep: Sep::None });
					break;
				},
			};
			self.take()?;
			self.skip_newlines()?;
			items.push(ListItem { and_or, sep });
			if !starts_command(self.peek_kind()?) {
				break;
			}
		}
		Ok(List { items })
	}

	fn and_or(&mut self) -> PResult<AndOr> {
		let lo = self.peek_tok()?.lo;
		let first = self.pipeline_command()?;
		let mut rest = Vec::new();
		loop {
			let op = match self.peek_kind()? {
				T::AndAnd => AndOrOp::And,
				T::OrOr => AndOrOp::Or,
				_ => break,
			};
			self.take()?;
			self.skip_newlines()?;
			rest.push((op, self.pipeline_command()?));
		}
		Ok(AndOr { id: NodeId(0), span: Span::new(lo, self.last_hi), first, rest })
	}

	fn pipeline_command(&mut self) -> PResult<Pipeline> {
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
			let cmd = Command {
				id:     NodeId(0),
				span:   Span::new(at, at),
				kind:   CommandKind::Simple(Simple::default()),
				redirs: Vec::new(),
			};
			return Ok(Pipeline {
				id: NodeId(0),
				span: Span::new(lo, self.last_hi),
				bang,
				time,
				stages: vec![Stage { cmd, pipe_stderr: false }],
			});
		}
		let mut stages = vec![Stage { cmd: self.command()?, pipe_stderr: false }];
		loop {
			let k = self.peek_kind()?;
			if !matches!(k, T::Bar | T::BarAnd) {
				break;
			}
			self.take()?;
			if k == T::BarAnd
				&& let Some(last) = stages.last_mut()
			{
				last.pipe_stderr = true;
			}
			self.skip_newlines()?;
			stages.push(Stage { cmd: self.command()?, pipe_stderr: false });
		}
		Ok(Pipeline { id: NodeId(0), span: Span::new(lo, self.last_hi), bang, time, stages })
	}

	fn command(&mut self) -> PResult<Command> {
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
	fn shell_command_with_redirs(&mut self, lo: u32) -> PResult<Command> {
		let mut cmd = self.shell_command(lo)?;
		self.redirection_list(&mut cmd.redirs)?;
		cmd.span = Span::new(lo, self.last_hi);
		Ok(cmd)
	}

	fn redirection_list(&mut self, redirs: &mut Vec<Redir>) -> PResult<()> {
		loop {
			let k = self.peek_kind()?;
			if matches!(k, T::Number | T::RedirWord) || k.is_redir_op() {
				let r = self.redirection()?;
				redirs.push(r);
			} else {
				return Ok(());
			}
		}
	}

	fn expect(&mut self, k: T) -> PResult<Tok> {
		let t = self.take()?;
		if t.kind == k {
			Ok(t)
		} else {
			Err(self.token_error(&t))
		}
	}

	fn shell_command(&mut self, lo: u32) -> PResult<Command> {
		let k = self.peek_kind()?;
		let kind = match k {
			T::For => self.for_cmd()?,
			T::Select => self.select_cmd()?,
			T::Case => self.case_cmd()?,
			T::While | T::Until => {
				self.take()?;
				let cond = self.compound_list()?;
				self.expect(T::Do)?;
				let body = self.compound_list()?;
				self.expect(T::Done)?;
				self.close_compound();
				CommandKind::While(While { until: k == T::Until, cond, body })
			},
			T::If => self.if_cmd()?,
			T::LParen => {
				self.take()?;
				let body = self.compound_list()?;
				self.expect(T::RParen)?;
				self.close_compound();
				CommandKind::Subshell(body)
			},
			T::LBrace => {
				self.take()?;
				let body = self.compound_list()?;
				self.expect(T::RBrace)?;
				self.close_compound();
				CommandKind::Brace(body)
			},
			T::ArithCmd => {
				let t = self.take()?.arith.expect("arithmetic token");
				CommandKind::Arith(ArithText {
					span:    Span::new(t.lo, t.hi),
					src:     t.text,
					bracket: false,
				})
			},
			T::CondStart => self.cond_command()?,
			_ => return Err(self.unexpected()),
		};
		Ok(Command { id: NodeId(0), span: Span::new(lo, self.last_hi), kind, redirs: Vec::new() })
	}

	fn if_cmd(&mut self) -> PResult<CommandKind> {
		self.take()?;
		let mut arms = Vec::new();
		let cond = self.compound_list()?;
		self.expect(T::Then)?;
		let body = self.compound_list()?;
		arms.push(IfArm { cond, body });
		let mut else_body = None;
		loop {
			let t = self.take()?;
			match t.kind {
				T::Elif => {
					let cond = self.compound_list()?;
					self.expect(T::Then)?;
					let body = self.compound_list()?;
					arms.push(IfArm { cond, body });
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
		Ok(CommandKind::If(If { arms, else_body }))
	}

	/// After `for NAME` / `select NAME`: the optional `in` list and the body.
	/// Returns the words and the body.
	fn loop_tail(&mut self) -> PResult<(Option<Vec<Word>>, List)> {
		let mut words = None;
		if self.peek_kind()? == T::Semi {
			self.take()?;
			self.skip_newlines()?;
		} else {
			self.skip_newlines()?;
			if self.peek_kind()? == T::In {
				self.take()?;
				let mut list = Vec::new();
				loop {
					match self.peek_kind()? {
						T::Word | T::Assign | T::Number => {
							let t = self.take()?;
							list.push(Self::tok_word(t));
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
				words = Some(list);
			}
		}
		let body = self.do_body()?;
		Ok((words, body))
	}

	/// `DO compound_list DONE` or `'{' compound_list '}'`.
	fn do_body(&mut self) -> PResult<List> {
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
	fn tok_word(t: Tok) -> Word {
		if let Some(w) = t.word {
			return w.into_word();
		}
		let mut text = Vec::new();
		push_u32(&mut text, t.num);
		Word { id: NodeId(0), span: t.span(), parts: vec![WordPart::Lit(text)] }
	}

	fn for_cmd(&mut self) -> PResult<CommandKind> {
		let for_line = self.take()?.line;
		let t = self.take()?;
		if t.kind == T::ArithFor {
			return self.arith_for(t, for_line);
		}
		if !matches!(t.kind, T::Word | T::Assign) {
			return Err(self.token_error(&t));
		}
		let var_span = t.span();
		let var = word_text(t.word.as_ref().expect("word token"));
		let (words, body) = self.loop_tail()?;
		Ok(CommandKind::For(For { var, extra_vars: Vec::new(), var_span, words, body }))
	}

	fn select_cmd(&mut self) -> PResult<CommandKind> {
		self.take()?;
		let t = self.take()?;
		if !matches!(t.kind, T::Word | T::Assign) {
			return Err(self.token_error(&t));
		}
		let var_span = t.span();
		let var = word_text(t.word.as_ref().expect("word token"));
		let (words, body) = self.loop_tail()?;
		Ok(CommandKind::Select(For { var, extra_vars: Vec::new(), var_span, words, body }))
	}

	fn arith_for(&mut self, t: Tok, for_line: u32) -> PResult<CommandKind> {
		if matches!(self.peek_kind()?, T::Newline | T::Semi) {
			self.take()?;
			self.skip_newlines()?;
		} else if self.peek_kind()? == T::Eof {
			self.skip_newlines()?;
		}
		let body = self.do_body()?;
		let arith = t.arith.as_ref().expect("arithmetic token");
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
		let at = |i: usize| {
			let (s, e) = pieces[i];
			ArithText {
				span:    Span::new(arith.lo + s as u32, (arith.lo + e as u32).min(arith.hi)),
				src:     arith.text[s..e].to_vec(),
				bracket: false,
			}
		};
		Ok(CommandKind::ArithFor(ArithFor { init: at(0), cond: at(1), step: at(2), body }))
	}

	fn case_cmd(&mut self) -> PResult<CommandKind> {
		self.take()?;
		let t = self.take()?;
		if !matches!(t.kind, T::Word | T::Assign | T::Number) {
			return Err(self.token_error(&t));
		}
		let word = Self::tok_word(t);
		self.skip_newlines()?;
		self.expect(T::In)?;
		let mut arms = Vec::new();
		loop {
			self.skip_newlines()?;
			if self.peek_kind()? == T::Esac {
				self.take()?;
				break;
			}
			if self.peek_kind()? == T::LParen {
				self.take()?;
			}
			let mut patterns = Vec::new();
			loop {
				let t = self.take()?;
				if !matches!(t.kind, T::Word | T::Assign | T::Number) {
					return Err(self.token_error(&t));
				}
				patterns.push(Self::tok_word(t));
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
					List::default()
				} else {
					self.compound_list()?
				};
			let t = self.take()?;
			let term = match t.kind {
				T::SemiSemi => CaseTerm::Break,
				T::SemiAnd => CaseTerm::FallThrough,
				T::SemiSemiAnd => CaseTerm::Continue,
				T::Esac => {
					arms.push(CaseArm { patterns, body, term: CaseTerm::Break });
					break;
				},
				_ => return Err(self.token_error(&t)),
			};
			arms.push(CaseArm { patterns, body, term });
		}
		self.close_compound();
		Ok(CommandKind::Case(Case { word, arms }))
	}

	/// `NAME ( ) newline_list function_body`; the name token was taken.
	fn posix_function(&mut self, name: Tok, lo: u32) -> PResult<Command> {
		self.take()?;
		self.expect(T::RParen)?;
		self.skip_newlines()?;
		let name = word_text(name.word.as_ref().expect("word token"));
		self.function_body(name, false, lo)
	}

	fn function_keyword(&mut self, lo: u32) -> PResult<Command> {
		self.take()?;
		let t = self.take()?;
		if !matches!(t.kind, T::Word | T::Assign) {
			return Err(self.token_error(&t));
		}
		let name = word_text(t.word.as_ref().expect("word token"));
		match self.peek_kind()? {
			T::LParen => {
				self.take()?;
				self.expect(T::RParen)?;
				self.skip_newlines()?;
			},
			T::Newline => self.skip_newlines()?,
			_ => {},
		}
		self.function_body(name, true, lo)
	}

	fn function_body(&mut self, name: Vec<u8>, keyword: bool, lo: u32) -> PResult<Command> {
		let k = self.peek_kind()?;
		if !starts_shell_command(k) {
			return Err(self.unexpected());
		}
		let blo = self.peek_tok()?.lo;
		let body = self.shell_command_with_redirs(blo)?;
		Ok(Command {
			id:     NodeId(0),
			span:   Span::new(lo, self.last_hi),
			kind:   CommandKind::FuncDef(FuncDef {
				name,
				extra_names: Vec::new(),
				keyword,
				body: Box::new(body),
			}),
			redirs: Vec::new(),
		})
	}

	fn coproc(&mut self, lo: u32) -> PResult<Command> {
		self.take()?;
		let k = self.peek_kind()?;
		let (name, body) = if starts_shell_command(k) {
			let blo = self.peek_tok()?.lo;
			(None, self.shell_command_with_redirs(blo)?)
		} else if k == T::Word {
			let blo = self.peek_tok()?.lo;
			let t = self.take()?;
			if starts_shell_command(self.peek_kind()?) {
				let name = word_text(t.word.as_ref().expect("word token"));
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
		Ok(Command {
			id:     NodeId(0),
			span:   Span::new(lo, self.last_hi),
			kind:   CommandKind::Coproc(Coproc { name, body: Box::new(body) }),
			redirs: Vec::new(),
		})
	}

	/// A simple command; `first` is an already-taken first word.
	fn simple(&mut self, first: Option<Tok>, lo: u32) -> PResult<Command> {
		let mut s = Simple::default();
		let mut redirs = Vec::new();
		let mut have_word = false;
		if let Some(t) = first {
			self.lx.redirlist = false;
			have_word = true;
			s.words.push(Self::tok_word(t));
		}
		let mut first_elem = !have_word;
		loop {
			let k = self.peek_kind()?;
			match k {
				T::Word | T::Assign => {
					let t = self.take()?;
					self.lx.redirlist = false;
					if k == T::Assign && s.words.is_empty() {
						let w = t.word.expect("word token");
						if w.is_assign() {
							s.assigns.push(w.into_assign());
						} else {
							s.words.push(w.into_word());
						}
					} else {
						s.words.push(Self::tok_word(t));
					}
				},
				T::Number | T::RedirWord => {
					let r = self.redirection()?;
					redirs.push(r);
					if first_elem {
						self.lx.redirlist = true;
					}
				},
				_ if k.is_redir_op() => {
					let r = self.redirection()?;
					redirs.push(r);
					if first_elem {
						self.lx.redirlist = true;
					}
				},
				_ => break,
			}
			first_elem = false;
		}
		self.lx.redirlist = false;
		Ok(Command {
			id: NodeId(0),
			span: Span::new(lo, self.last_hi),
			kind: CommandKind::Simple(s),
			redirs,
		})
	}

	fn redirection(&mut self) -> PResult<Redir> {
		let lo = self.peek_tok()?.lo;
		let mut fd = None;
		match self.peek_kind()? {
			T::Number => {
				let t = self.take()?;
				fd = Some(RedirFd::Num(t.num));
			},
			T::RedirWord => {
				let t = self.take()?;
				let mut text = Vec::new();
				if let Some(w) = &t.word {
					w.render(&mut text);
				}
				let name = text
					.get(1..text.len().saturating_sub(1))
					.unwrap_or_default()
					.to_vec();
				fd = Some(RedirFd::Var(name));
			},
			_ => {},
		}
		let t = self.take()?;
		let op = match t.kind {
			T::Lt => RedirOp::In,
			T::Gt => RedirOp::Out,
			T::GtGt => RedirOp::Append,
			T::GtBar => RedirOp::Clobber,
			T::LtGt => RedirOp::ReadWrite,
			T::LtAnd => RedirOp::DupIn,
			T::GtAnd => RedirOp::DupOut,
			T::AndGt if fd.is_none() => RedirOp::OutErr,
			T::AndGtGt if fd.is_none() => RedirOp::AppendErr,
			T::LtLt => RedirOp::HereDoc { strip_tabs: false },
			T::LtLtDash => RedirOp::HereDoc { strip_tabs: true },
			T::LtLtLt => RedirOp::HereString,
			_ => return Err(self.token_error(&t)),
		};
		let w = self.take()?;
		let target = match (op, w.kind) {
			(RedirOp::DupIn | RedirOp::DupOut, T::Number) => {
				let mut text = Vec::new();
				push_u32(&mut text, w.num);
				RedirTarget::Word(Word {
					id:    NodeId(0),
					span:  w.span(),
					parts: vec![WordPart::Lit(text)],
				})
			},
			(RedirOp::DupIn | RedirOp::DupOut, T::Dash) => RedirTarget::Word(Word {
				id:    NodeId(0),
				span:  w.span(),
				parts: vec![WordPart::Lit(b"-".to_vec())],
			}),
			(RedirOp::HereDoc { strip_tabs }, T::Word | T::Assign) => {
				// bash `push_heredoc`: at most 16 documents wait for their
				// bodies; the 17th is fatal (bash exits the shell).
				if self.pending.len() >= 16 {
					let kind =
						ParseErrorKind::Message(Box::from(&b"maximum here-document count exceeded"[..]));
					return Err(ParseError::new(w.span(), self.bash_line(), kind));
				}
				let wt = w.word.expect("word token");
				let quoted = wt.quoted;
				let mut delim_raw = Vec::new();
				wt.render(&mut delim_raw);
				let mut delim = Vec::new();
				let word = wt.into_word();
				delim_text(&word.parts, &mut delim);
				let seq = self.push_doc(delim.clone(), strip_tabs, quoted);
				RedirTarget::HereDoc(HereDoc { delim, delim_raw, quoted, text: doc_placeholder(seq) })
			},
			(_, T::Word | T::Assign) => RedirTarget::Word(Self::tok_word(w)),
			_ => return Err(self.token_error(&w)),
		};
		Ok(Redir { span: Span::new(lo, self.last_hi), fd, op, target })
	}

	// ---- [[ … ]] ---------------------------------------------------------

	fn cond_command(&mut self) -> PResult<CommandKind> {
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
		Ok(CommandKind::Cond(expr))
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
		self.last_cond_text = Some(Self::token_text(&t));
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

	fn cond_or(&mut self, tok: &mut T) -> CResult<CondExpr> {
		let l = self.cond_and(tok)?;
		if *tok == T::OrOr {
			let r = self.cond_or(tok)?;
			return Ok(CondExpr::Or(Box::new(l), Box::new(r)));
		}
		Ok(l)
	}

	fn cond_and(&mut self, tok: &mut T) -> CResult<CondExpr> {
		let l = self.cond_term(tok)?;
		if *tok == T::AndAnd {
			let r = self.cond_and(tok)?;
			return Ok(CondExpr::And(Box::new(l), Box::new(r)));
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

	fn cond_term(&mut self, tok: &mut T) -> CResult<CondExpr> {
		let t = self.cond_skip_newlines()?;
		*tok = t.kind;
		match t.kind {
			T::CondEnd => Err(CondFail::Silent),
			T::LParen => {
				let inner = match self.cond_or(tok) {
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
				Ok(CondExpr::Group(Box::new(inner)))
			},
			T::Bang => {
				let inner = self.cond_term(tok)?;
				Ok(CondExpr::Not(Box::new(inner)))
			},
			T::Word | T::Assign | T::Number => {
				let w = Self::tok_word(t);
				if is_plain(&w, b"!") {
					let inner = self.cond_term(tok)?;
					return Ok(CondExpr::Not(Box::new(inner)));
				}
				if let Some(op) = plain_text(&w)
					&& is_unop(op)
				{
					let op = op.to_vec();
					let a = self.cond_read()?;
					if !matches!(a.kind, T::Word | T::Assign | T::Number) {
						let text = Self::token_text(&a);
						return Err(self.cond_msg(
							&text,
							b"unexpected argument `",
							b"' to conditional unary operator",
						));
					}
					let arg = Self::tok_word(a);
					let next = self.cond_skip_newlines()?;
					*tok = next.kind;
					return Ok(CondExpr::Unary { op, arg });
				}
				let o = self.cond_read()?;
				let op: Vec<u8> = match o.kind {
					T::Word | T::Assign => {
						let ow = Self::tok_word(o);
						match plain_text(&ow) {
							Some(text) if is_binop(text) => {
								if matches!(text, b"=" | b"==" | b"!=") {
									self.lx.extpat = true;
								} else if text == b"=~" {
									self.lx.regexp = true;
								}
								text.to_vec()
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
					T::Lt => b"<".to_vec(),
					T::Gt => b">".to_vec(),
					T::CondEnd | T::AndAnd | T::OrOr | T::RParen => {
						*tok = o.kind;
						return Ok(CondExpr::Word(w));
					},
					_ => {
						let text = Self::token_text(&o);
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
					let text = Self::token_text(&r);
					return Err(self.cond_msg(
						&text,
						b"unexpected argument `",
						b"' to conditional binary operator",
					));
				}
				let rhs = Self::tok_word(r);
				let next = self.cond_skip_newlines()?;
				*tok = next.kind;
				Ok(CondExpr::Binary { op, lhs: w, rhs })
			},
			_ => {
				let text = Self::token_text(&t);
				Err(self.cond_msg(&text, b"unexpected token `", b"' in conditional command"))
			},
		}
	}
}

/// The text of a word that is one literal.
fn plain_text(w: &Word) -> Option<&[u8]> {
	match &w.parts[..] {
		[WordPart::Lit(s)] => Some(s),
		_ => None,
	}
}

fn is_plain(w: &Word, s: &[u8]) -> bool {
	plain_text(w) == Some(s)
}
