//! Raw text scanning (bash `parse_matched_pair`), command substitutions
//! (`parse_comsub`) and compound assignments (`parse_compound_assignment`).

use alloc::vec::Vec;

use super::{
	PResult, Parser,
	lex::{LexState, T, unmatched_error},
	word::merge_lits,
};
use crate::bash::syntax::{
	ast::{ArrayElem, CompoundArray, List, Word},
	features::Features,
	span::{NodeId, Span},
	util::{ansi_decode, sh_single_quote},
};

/// `parse_matched_pair` flags.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Flags(u8);

impl Flags {
	pub const ALLOWESC: Self = Self(1);
	pub const ARITH: Self = Self(8);
	pub const DOLBRACE: Self = Self(4);
	pub const DQUOTE: Self = Self(2);
	pub const FIRSTCLOSE: Self = Self(16);
	pub const NONE: Self = Self(0);

	const fn has(self, f: Self) -> bool {
		self.0 & f.0 != 0
	}

	const fn with(self, f: Self) -> Self {
		Self(self.0 | f.0)
	}
}

impl Parser<'_> {
	/// Arithmetic text after `open` up to the matching `close` (consumed), as
	/// bash stores it.
	pub(super) fn raw_arith(&mut self, open: u8, close: u8, line: u32) -> PResult<Vec<u8>> {
		self.raw_matched(open, close, Flags::ARITH, line)
	}

	/// `$((` fallback scan: keep the inner pair's bounds from the cursor,
	/// even when alias text gives every byte the same source position.
	pub(super) fn raw_arith_pair(&mut self, line: u32) -> PResult<(Vec<u8>, Option<Span>)> {
		let mut out = Vec::new();
		let inner = self.raw_into(&mut out, 0, b'(', b')', Flags::ARITH, line)?;
		Ok((out, inner))
	}

	/// bash `parse_matched_pair` with `qc` 0: the text after `open` up to the
	/// matching `close` (consumed, not included).
	pub(super) fn raw_matched(
		&mut self,
		open: u8,
		close: u8,
		flags: Flags,
		line: u32,
	) -> PResult<Vec<u8>> {
		let mut out = Vec::new();
		let flags = if open == b'{' {
			flags.with(Flags::FIRSTCLOSE)
		} else {
			flags
		};
		self.raw_into(&mut out, 0, open, close, flags, line)?;
		Ok(out)
	}

	/// The scanner proper; `qc` is the enclosing quote (`'`, `"` or 0).
	fn raw_into(
		&mut self,
		out: &mut Vec<u8>,
		qc: u8,
		open: u8,
		close: u8,
		flags: Flags,
		line: u32,
	) -> PResult<Option<Span>> {
		self.raw_depth += 1;
		let res = self.raw_scan(out, qc, open, close, flags, line);
		self.raw_depth -= 1;
		res
	}

	#[allow(clippy::cognitive_complexity, reason = "a direct port of parse_matched_pair")]
	fn raw_scan(
		&mut self,
		out: &mut Vec<u8>,
		qc: u8,
		open: u8,
		close: u8,
		flags: Flags,
		line: u32,
	) -> PResult<Option<Span>> {
		let mut count = 1u32;
		let mut passnext = false;
		let mut wasdol = false;
		let mut gtlt = false;
		let dq = qc == b'"' || flags.has(Flags::DQUOTE);
		let rflags = if dq { Flags::DQUOTE } else { Flags::NONE };
		let arithmetic = flags.has(Flags::ARITH);
		let collect_pieces = arithmetic && self.raw_depth == 1 && self.arith_pieces.is_some();
		// `${…}` operator state: whether single quotes quote (`#`, `%`, `/`…).
		let mut dolbrace_quote = false;
		let mut dolbrace_op = false;
		let start = out.len();
		let mut inner_lo = None;
		let mut inner_hi = None;
		let mut piece_start = out.len();
		let mut piece_lo = None;
		let mut trimmed = None;
		let mut inner_trimmed = None;
		let mut piece_trimmed = None;
		loop {
			let Some(ch) = self.peek() else {
				let close_str: &'static str = match close {
					b')' => ")",
					b'}' => "}",
					b']' => "]",
					b'\'' => "'",
					b'"' => "\"",
					_ => "`",
				};
				return Err(unmatched_error(self.eof_span(), line, close_str));
			};
			if ch == b'\\' && !passnext && qc != b'\'' && self.peek_at(1) == Some(b'\n') {
				self.bump();
				self.bump();
				continue;
			}
			// The offset `ch` was read at: a one-byte token's end comes from
			// the cursor, which does not advance in the text an alias
			// expanded to.
			let at = self.off();
			let in_inner = arithmetic && inner_lo.is_some() && inner_hi.is_none();
			self.bump();
			if collect_pieces && piece_lo.is_none() {
				if matches!(ch, b' ' | b'\t') {
					piece_start = out.len() + 1;
				} else {
					piece_lo = Some(at);
				}
			}
			if ch >= 0x80 && self.feat.multibyte() {
				// A whole character: its later bytes are never special.
				out.push(ch);
				let n = self.feat.char_len(ch, self.peek().unwrap_or(0));
				for _ in 1..n {
					let Some(d) = self.peek() else { break };
					out.push(d);
					self.bump();
				}
				passnext = false;
				wasdol = false;
				if arithmetic {
					include_nonblank(&mut trimmed, ch, at, self.off());
				}
				if in_inner {
					include_nonblank(&mut inner_trimmed, ch, at, self.off());
				}
				if collect_pieces {
					include_nonblank(&mut piece_trimmed, ch, at, self.off());
				}
				continue;
			}
			if passnext {
				passnext = false;
				out.push(ch);
				if arithmetic {
					include_nonblank(&mut trimmed, ch, at, self.off());
				}
				if in_inner {
					include_nonblank(&mut inner_trimmed, ch, at, self.off());
				}
				if collect_pieces {
					include_nonblank(&mut piece_trimmed, ch, at, self.off());
				}
				continue;
			}
			if ch == close {
				count -= 1;
				if arithmetic && count == 1 && inner_hi.is_none() {
					inner_hi = Some(at);
				}
			} else if ch == open
				&& ((open != close && wasdol && open == b'{') || !flags.has(Flags::FIRSTCLOSE))
			{
				count += 1;
				if arithmetic && out.len() == start {
					inner_lo = Some(self.off());
				}
			}
			out.push(ch);
			if count == 0 {
				out.pop();
				self.raw_close = at;
				if arithmetic {
					self.raw_trimmed = trimmed;
					self.raw_inner_trimmed = inner_trimmed;
				}
				if self.raw_depth == 1
					&& let Some(pieces) = &mut self.arith_pieces
				{
					pieces.push((
						piece_start,
						out.len(),
						Span::new(piece_lo.unwrap_or(at), at),
						piece_trimmed,
					));
				}
				return Ok(inner_lo.zip(inner_hi).map(|(lo, hi)| Span::new(lo, hi)));
			}
			// Each top-level separator ends an operand at the position the
			// cursor read it, not at an offset calculated from stored text.
			if ch == b';'
				&& self.raw_depth == 1
				&& let Some(pieces) = &mut self.arith_pieces
			{
				pieces.push((
					piece_start,
					out.len() - 1,
					Span::new(piece_lo.unwrap_or(at), at),
					piece_trimmed,
				));
				piece_start = out.len();
				piece_lo = None;
				piece_trimmed = None;
			}
			if open == b'\'' {
				if flags.has(Flags::ALLOWESC) && ch == b'\\' {
					passnext = true;
				}
				continue;
			}
			if ch == b'\\' {
				passnext = true;
			}
			if flags.has(Flags::DOLBRACE) && !dolbrace_op {
				if matches!(ch, b'%' | b'#' | b'/' | b'^' | b',') && out.len() > 1 {
					dolbrace_quote = true;
					dolbrace_op = true;
				} else if b"#%^,~:-=?+/".contains(&ch) {
					dolbrace_op = true;
				}
			}
			if open != close {
				if matches!(ch, b'\'' | b'"' | b'`') {
					let ansi = wasdol && ch == b'\'';
					let locale = wasdol && ch == b'"';
					let mut nested = Vec::new();
					let nflags = if ansi {
						Flags::ALLOWESC.with(rflags)
					} else {
						rflags
					};
					self.raw_into(&mut nested, ch, ch, ch, nflags, line)?;
					if ansi {
						let decoded = ansi_decode(&nested);
						out.truncate(out.len() - 2);
						if !dq || (flags.has(Flags::DOLBRACE) && dolbrace_quote) {
							sh_single_quote(out, &decoded);
						} else {
							out.extend_from_slice(&decoded);
						}
					} else if locale {
						out.truncate(out.len() - 2);
						out.push(b'"');
						out.extend_from_slice(&nested);
						out.push(b'"');
					} else {
						out.extend_from_slice(&nested);
						out.push(ch);
					}
				} else if (wasdol
					&& matches!(ch, b'(' | b'{' | b'[')
					&& (flags.has(Flags::DOLBRACE)
						|| (flags.has(Flags::ARITH)
							&& (ch == b'(' || (ch == b'{' && self.funsub_next())))))
					|| (flags.has(Flags::DOLBRACE) && gtlt && ch == b'(')
				{
					if open == ch {
						count -= 1;
					}
					self.raw_dollar(out, ch, rflags, line)?;
				}
			} else if open == b'"' && ch == b'`' {
				let mut nested = Vec::new();
				self.raw_into(&mut nested, 0, b'`', b'`', rflags, line)?;
				out.extend_from_slice(&nested);
				out.push(b'`');
			} else if open != b'`' && wasdol && matches!(ch, b'(' | b'{' | b'[') {
				if open == ch {
					count -= 1;
				}
				self.raw_dollar(out, ch, rflags, line)?;
			}
			gtlt = matches!(ch, b'<' | b'>') && !gtlt;
			if arithmetic {
				include_nonblank(&mut trimmed, ch, at, self.off());
			}
			if in_inner && inner_hi.is_none() {
				include_nonblank(&mut inner_trimmed, ch, at, self.off());
			}
			if collect_pieces && ch != b';' {
				include_nonblank(&mut piece_trimmed, ch, at, self.off());
			}
			wasdol = ch == b'$' && !wasdol;
		}
	}

	/// Whether the next byte starts a nofork command substitution body.
	fn funsub_next(&mut self) -> bool {
		matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'|'))
	}

	/// `parse_dollar_word`: `$(`, `${`, `$[` (the opener already in `out`).
	fn raw_dollar(&mut self, out: &mut Vec<u8>, ch: u8, rflags: Flags, line: u32) -> PResult<()> {
		match ch {
			b'(' => {
				let nested = if self.peek() == Some(b'(') {
					let mut nested = Vec::new();
					self.raw_into(&mut nested, 0, b'(', b')', Flags::ARITH, line)?;
					nested
				} else {
					self.comsub(b')', false)?.1
				};
				out.extend_from_slice(&nested);
				out.push(b')');
			},
			b'{' => {
				let nested = if self.funsub_next() {
					let value = self.peek() == Some(b'|');
					if value || matches!(self.peek(), Some(b' ' | b'\t')) {
						self.bump();
					}
					self.comsub(b'}', value)?.1
				} else {
					let mut nested = Vec::new();
					let nflags = Flags::FIRSTCLOSE.with(Flags::DOLBRACE).with(rflags);
					self.raw_into(&mut nested, 0, b'{', b'}', nflags, line)?;
					nested
				};
				out.extend_from_slice(&nested);
				out.push(b'}');
			},
			_ => {
				let mut nested = Vec::new();
				self.raw_into(&mut nested, 0, b'[', b']', rflags.with(Flags::ARITH), line)?;
				out.extend_from_slice(&nested);
				out.push(b']');
			},
		}
		Ok(())
	}

	/// Raw text of a `${x:off:len}` field: up to `:` or `}` at nesting
	/// level 0 (not consumed). Returns the text and whether it stopped at `:`.
	pub(super) fn raw_until_colon(&mut self, line: u32) -> PResult<(Vec<u8>, bool)> {
		let mut out = Vec::new();
		let mut depth = 0u32;
		// bash `skiparith`: a `:` after a top-level `?` belongs to the
		// conditional operator (`${s:j?1:0:j}`).
		let mut skipcol = 0u32;
		let mut trimmed = None;
		loop {
			let Some(c) = self.peek() else {
				return Err(unmatched_error(self.eof_span(), line, "}"));
			};
			let at = self.off();
			let before = out.len();
			match c {
				b'?' if depth == 0 => {
					skipcol += 1;
					self.bump();
					out.push(c);
				},
				b':' if depth == 0 && skipcol > 0 => {
					skipcol -= 1;
					self.bump();
					out.push(c);
				},
				b':' | b'}' if depth == 0 => {
					self.raw_trimmed = trimmed;
					return Ok((out, c == b':'));
				},
				b'\\' => {
					self.bump();
					match self.peek() {
						Some(b'\n') => self.bump(),
						Some(d) => {
							out.push(b'\\');
							out.push(d);
							self.bump();
						},
						None => out.push(b'\\'),
					}
				},
				b'\'' | b'"' | b'`' => {
					self.bump();
					out.push(c);
					let mut nested = Vec::new();
					self.raw_into(&mut nested, c, c, c, Flags::NONE, line)?;
					out.extend_from_slice(&nested);
					out.push(c);
				},
				b'$' if matches!(self.peek_at(1), Some(b'(' | b'{' | b'[')) => {
					self.bump();
					let d = self.peek().unwrap_or(b'(');
					self.bump();
					out.push(b'$');
					out.push(d);
					self.raw_dollar(&mut out, d, Flags::NONE, line)?;
				},
				b'(' | b'[' => {
					depth += 1;
					self.bump();
					out.push(c);
				},
				b')' | b']' => {
					depth = depth.saturating_sub(1);
					self.bump();
					out.push(c);
				},
				_ => {
					self.bump();
					out.push(c);
				},
			}
			if out.len() > before {
				include_nonblank(&mut trimmed, c, at, self.off());
			}
		}
	}

	/// A command substitution body after `$(`, `${ `, `${|`, `<(` or `>(`
	/// (bash `parse_comsub`): the commands and the text bash stores between
	/// the delimiters.
	pub(super) fn comsub(&mut self, close: u8, value: bool) -> PResult<(List, Vec<u8>, Span)> {
		debug_assert!(self.la.is_none(), "a command substitution starts inside a word");
		let mut lx = LexState::new();
		lx.extglob = self.feat.contains(Features::EXTGLOB);
		lx.eof_token = close;
		lx.funsubst = close == b'}';
		lx.cur = if close == b'}' {
			T::DolBrace
		} else {
			T::DolParen
		};
		let saved_lx = core::mem::replace(&mut self.lx, lx);
		let saved_compound = core::mem::take(&mut self.compound);
		let saved_pending = core::mem::take(&mut self.pending);
		let saved_expand = self.expand_aliases;
		self.expand_aliases = saved_expand && self.feat.contains(Features::POSIX);
		let close_tok = if close == b'}' { T::RBrace } else { T::RParen };

		self.skip_newlines()?;
		let mut list = if self.peek_kind()? == close_tok {
			List::default()
		} else {
			self.compound_list()?
		};
		let t = self.take()?;
		if t.kind != close_tok {
			return Err(self.token_error(&t));
		}
		let last = self.lx.last;
		let before = self.lx.before;
		if !self.pending.is_empty() {
			self.gather_ahead();
		}
		super::finish::fill_docs(&mut list, &self.docs);

		self.lx = saved_lx;
		self.compound = saved_compound;
		self.pending = saved_pending;
		self.expand_aliases = saved_expand;

		let tcmd = crate::bash::syntax::print::comsub_text(&list);
		let mut text = Vec::with_capacity(tcmd.len() + 4);
		if close == b')' {
			if tcmd.first() == Some(&b'(') {
				text.push(b' ');
			}
			text.extend_from_slice(&tcmd);
		} else if tcmd.is_empty() {
			text.push(b' ');
		} else {
			text.push(if value { b'|' } else { b' ' });
			text.extend_from_slice(&tcmd);
			let was_semi = last == T::Semi;
			let was_newline = last == T::Newline;
			let was_word = (was_semi || was_newline) && matches!(before, T::Word | T::Assign);
			let lastc = tcmd.last().copied().unwrap_or(0);
			if was_newline {
				text.push(b'\n');
			} else if was_word || was_semi || !matches!(lastc, b'\n' | b';' | b'&') {
				text.push(b';');
			}
			text.push(b' ');
		}
		Ok((list, text, t.span()))
	}

	/// `name=(` seen: the elements up to the closing `)` (bash
	/// `parse_compound_assignment`).
	pub(super) fn compound_assignment(&mut self, lparen: u32) -> PResult<CompoundArray> {
		let line = self.bash_line();
		let mut lx = self.lx.clone();
		lx.compassign = true;
		lx.condcmd = false;
		lx.condexpr = false;
		lx.regexp = false;
		lx.extpat = false;
		lx.last = T::Word;
		lx.cur = T::Word;
		lx.esacs = 0;
		lx.expect_in = 0;
		lx.expect_in_cmd = None;
		let saved = core::mem::replace(&mut self.lx, lx);
		let saved_la = self.la.take();
		let mut elems = Vec::new();
		let rparen = loop {
			let t = self.read_token()?;
			match t.kind {
				T::Newline => {},
				T::RParen => break t.span(),
				T::Word | T::Assign => {
					let w = t.word.expect("word tokens carry a word");
					elems.push(into_elem(w));
				},
				T::Eof => return Err(unmatched_error(self.eof_span(), line, ")")),
				_ => {
					self.lx.cur = t.kind;
					// bash recovers from this one (`DISCARD`): the command and
					// the rest of the line are dropped.
					self.discard_line = true;
					return Err(self.token_error(&t));
				},
			}
		};
		let assignok = saved.assignok;
		self.lx = saved;
		self.lx.assignok = assignok;
		self.la = saved_la;
		Ok(CompoundArray { lparen: Some(lparen), rparen: Some(rparen), elems })
	}
}

/// One compound-assignment word as an element.
fn into_elem(w: super::word::WordTok) -> ArrayElem {
	let lo = Some(w.lo);
	let keyed = w.asg.as_ref().is_some_and(|a| a.index.is_some());
	if !keyed {
		return ArrayElem { lo, key: None, append: false, value: w.into_word() };
	}
	let hi = w.hi;
	let a = w.asg.expect("checked");
	let mut parts = w.parts;
	let value_parts = parts.split_off(a.value_at);
	let (s, e, span) = a.index.expect("checked");
	let key = Word {
		id:         NodeId(0),
		span:       span.into(),
		parts:      merge_lits(parts.drain(s..e).collect()),
		assignment: None,
	};
	let value = Word {
		id:         NodeId(0),
		span:       Span::new(a.value_lo, hi).into(),
		parts:      merge_lits(value_parts),
		assignment: None,
	};
	ArrayElem { lo, key: Some(key), append: a.append, value }
}

fn include_nonblank(span: &mut Option<Span>, byte: u8, lo: u32, hi: u32) {
	if !matches!(byte, b' ' | b'\t' | b'\n') {
		match span {
			Some(span) => span.hi = hi,
			None => *span = Some(Span::new(lo, hi)),
		}
	}
}
