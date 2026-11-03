//! The zsh grammar behind [`crate::bash::syntax::Parser`]: one top-level event
//! per call, as zsh's `loop` calls `parse_event` (zsh 5.9 `Src/init.c`,
//! `Src/parse.c`).
//!
//! An event is one input line and the constructs it opens, here-documents
//! included; aliases defined by one event apply to the next. Node ids are
//! numbered by the crate's shared pass, so they follow the rules of
//! [`crate::bash::syntax::Parser`].
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use alloc::vec::Vec;

use super::lex::{Ctx, T};
use crate::bash::syntax::{
	ast::{CompleteCommand, List, ParseWarning},
	features::{AliasLookup, Features},
	parser::{ParseError, ParseErrorKind, Resume, finish},
	span::{Pos, Span},
};

/// Incremental zsh parser over one source: what [`crate::bash::syntax::Parser`]
/// runs when [`Features::ZSH`] is set.
///
/// Errors carry zsh's message texts (``parse error near `fi'``,
/// `unmatched '`, `closing brace expected`, `condition expected: x`) as
/// [`ParseErrorKind::Message`]; when zsh printed two messages (an error in
/// a command substitution, then the word around it), the first is
/// [`ParseError::detail`]. An error at the end of the input has its span
/// at the end of the source.
pub struct ZshParser<'s> {
	/// zsh's lexer and parser state.
	cx:     Ctx<'s>,
	/// A syntax error ended the parse (zsh abandons a script there).
	failed: bool,
}

impl<'s> ZshParser<'s> {
	/// Parser at the start of `src`; `aliases` holds regular, global and
	/// suffix aliases. Called by [`crate::bash::syntax::Parser::new`] under
	/// [`Features::ZSH`].
	pub fn new(src: &'s [u8], feat: Features, aliases: &'s dyn AliasLookup) -> Self {
		Self { cx: Ctx::new(src, 0, 1, feat, aliases), failed: false }
	}

	/// Resume at `pos` (from an earlier [`ZshParser::pos`] over the same
	/// source); called by [`crate::bash::syntax::Parser::with_pos`].
	pub fn with_pos(self, pos: Pos) -> Self {
		let cx = &self.cx;
		Self {
			cx:     Ctx::new(cx.src, pos.offset as usize, pos.line, cx.feat, cx.aliases),
			failed: false,
		}
	}

	/// Resume where an earlier parser stopped, unread alias text included;
	/// called by [`crate::bash::syntax::Parser::with_resume`].
	pub fn with_resume(self, resume: &'s Resume) -> Self {
		let mut p = self.with_pos(resume.pos);
		p.cx.push_resume(&resume.pending, &resume.active);
		p
	}

	/// Where the next [`ZshParser::next_command`] starts in the source.
	pub fn pos(&self) -> Pos {
		Pos { offset: self.cx.src_off(), line: self.cx.line }
	}

	/// Where the next command starts, with any unread alias text (suffix
	/// aliases are named `.suffix` in [`Resume::active`]).
	pub fn resume(&self) -> Resume {
		let (pending, active) = self.cx.pending_alias_text();
		let active = if pending.is_empty() {
			Vec::new()
		} else {
			active
		};
		Resume { pos: self.pos(), pending, active }
	}

	/// The grammar switches in effect.
	pub const fn features(&self) -> Features {
		self.cx.feat
	}

	/// Parse the next top-level event; `None` at the end of input. After an
	/// error the parser stays at the end of input, as a zsh script stops at
	/// a syntax error.
	pub fn next_command(&mut self) -> Option<Result<CompleteCommand, ParseError>> {
		if self.failed {
			return None;
		}
		loop {
			let cx = &mut self.cx;
			cx.docs.clear();
			cx.alias_uses.clear();
			cx.msgs.clear();
			cx.errflag = false;
			cx.lexstop = false;
			let (ok, items) = cx.parse_event_top();
			if ok && !cx.errflag {
				let lo = items.first().map_or(0, |i| i.and_or.span.lo);
				let hi = items.last().map_or(lo, |i| i.and_or.span.hi);
				let mut list = List { items };
				finish::fill_docs(&mut list, &cx.docs);
				let node_count = finish::assign_ids(&mut list);
				return Some(Ok(CompleteCommand {
					span: Span::new(lo, hi),
					line: cx.ev_line,
					list,
					node_count,
					source_replay: false,
					aliases: core::mem::take(&mut cx.alias_uses),
					warnings: Vec::new(),
				}));
			}
			if cx.errflag || !cx.msgs.is_empty() {
				self.failed = true;
				return Some(Err(self.error()));
			}
			if cx.lx.tok == T::Endinput {
				return None;
			}
		}
	}

	/// The error for the messages zsh printed.
	fn error(&mut self) -> ParseError {
		let cx = &mut self.cx;
		let at_end = cx.err_tok == T::Endinput || cx.lexstop;
		let end = cx.src.len() as u32;
		let span = if at_end {
			Span::new(end, end)
		} else {
			Span::new(cx.lx.lo, cx.lx.hi)
		};
		let mut msgs = core::mem::take(&mut cx.msgs);
		let (line, msg) = msgs
			.pop()
			.unwrap_or_else(|| (cx.line, b"parse error".to_vec()));
		let detail = msgs
			.into_iter()
			.next()
			.map(|(line, bash_msg)| ParseWarning { line, bash_msg });
		ParseError::new(span, line, ParseErrorKind::Message(msg.into_boxed_slice()))
			.with_detail(detail)
	}
}
