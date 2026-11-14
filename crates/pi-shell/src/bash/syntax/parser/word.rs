//! Words: a port of bash's `read_token_word` and of the quoting rules of
//! `parse_matched_pair`, lexing straight into word-part nodes of the
//! parser's [`Tree`].

use alloc::{boxed::Box, vec::Vec};

use super::{PResult, Parser, SmallBytes, TextMode, lex::unmatched_error};
use crate::bash::syntax::{
	ast::{CaseMode, ComsubKind, ReplaceMode, Special},
	span::Span,
	tree::{
		AssignB, GroupPk, Id, Mark, NameB, OpB, Pk, Run, Seq, SubB, TextPk, Tree, Word,
		shape::{self, Elem, Part},
	},
	util::{char_len, is_break, is_name_char, is_name_start},
};

/// The text of a word token that is one unquoted literal.
pub(super) enum Plain<'s> {
	None,
	/// Bytes of the input buffer.
	Input(&'s [u8]),
	/// Bytes read piecewise (across alias buffers, special bytes).
	Owned(SmallBytes),
}

/// A word token being built.
pub(super) struct WordTok<'s> {
	pub lo:     u32,
	pub hi:     u32,
	/// The part nodes.
	pub parts:  Run<Part>,
	/// bash `quoted`: a quote character or backslash appeared.
	pub quoted: bool,
	/// The text is an assignment (bash `assignment()`): how to split it.
	pub asg:    Option<Box<AsgSplit>>,
	pub plain:  Plain<'s>,
}

/// Where an assignment word splits.
pub(super) struct AsgSplit {
	pub name:     SmallBytes,
	/// Parts `[a, b)` of the subscript of `name[sub]=`, and its span.
	pub index:    Option<(usize, usize, Span)>,
	pub append:   bool,
	/// First part of the value.
	pub value_at: usize,
	pub value_lo: u32,
	/// `name=(…)` read as a compound assignment: the element nodes.
	pub array:    Option<Run<Elem>>,
}

impl WordTok<'_> {
	/// The token text when the word is one unquoted literal.
	pub(super) fn plain(&self) -> Option<&[u8]> {
		match &self.plain {
			Plain::None => None,
			Plain::Input(s) => Some(s),
			Plain::Owned(s) => Some(s),
		}
	}

	/// Whether the word is an assignment (`name=`, `name[i]+=`, …).
	pub(super) const fn is_assign(&self) -> bool {
		self.asg.is_some()
	}

	/// bash's text of the word, for messages.
	pub(super) fn render(&self, t: &Tree, out: &mut Vec<u8>) {
		use crate::bash::syntax::print::{elems_text, parts_text};
		let parts = t.run_ids(self.parts);
		match self.asg.as_ref().and_then(|a| Some((a.value_at, a.array?))) {
			Some((at, elems)) => {
				parts_text(Seq::over(t, &parts[..at]), out);
				elems_text(Seq::over(t, t.run_ids(elems)), out);
				parts_text(Seq::over(t, &parts[at..]), out);
			},
			None => parts_text(Seq::over(t, parts), out),
		}
	}
}

/// Accumulates literal bytes and part nodes (on the tree's scratch stack).
struct Acc {
	mark: Mark<Part>,
	lit:  SmallBytes,
}

impl Acc {
	fn new(t: &Tree) -> Self {
		Self { mark: t.open(), lit: SmallBytes::new() }
	}

	fn flush(&mut self, t: &mut Tree) {
		if !self.lit.is_empty() {
			let n = t.text_part(TextPk::Lit, &self.lit);
			self.lit.clear();
			t.kid(self.mark, n);
		}
	}

	fn push(&mut self, t: &mut Tree, p: Id<Part>) {
		self.flush(t);
		t.kid(self.mark, p);
	}

	/// Parts pushed so far (literal bytes not flushed excluded).
	const fn len(&self, t: &Tree) -> usize {
		t.opened_len(self.mark)
	}

	fn is_empty(&self, t: &Tree) -> bool {
		self.len(t) == 0 && self.lit.is_empty()
	}

	fn finish(mut self, t: &mut Tree) -> Run<Part> {
		self.flush(t);
		t.close_run(self.mark)
	}
}

/// Assignment-prefix scanner state (bash `assignment()` run incrementally).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Scan {
	Start,
	Name,
	/// Inside a literal `[…]` (depth).
	LitSub(u32),
	AfterSub,
	Plus,
	Found,
	No,
}

/// How a part loop ends.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Stop {
	/// `"…"`: the closing quote (consumed). `all`: nested in a non-pattern
	/// `${…}` word inside `"…"` or a here-document, where a backslash quotes
	/// any character.
	DQuote { all: bool },
	/// `${…}` operator word: `}` (not consumed); also `/` for the pattern of
	/// `${x/p/r}`. `pat`: a pattern operator (`#`, `%`, `/`, `^`, `,`), whose
	/// word keeps `'` as a quote inside `"…"`. `doc`: inside an unquoted
	/// here-document, where a non-pattern word takes `$'…'` literally.
	Brace { dq: bool, slash: bool, pat: bool, doc: bool },
	/// `[…]` subscript: the matching `]` (not consumed).
	Bracket,
	/// Extglob / regexp group: the matching `)` (consumed).
	Group,
	/// End of input ([`parse_text`](super::parse_text)).
	Text(TextMode),
}

impl Stop {
	const fn in_dq(self) -> bool {
		matches!(self, Self::DQuote { .. } | Self::Brace { dq: true, .. } | Self::Text(_))
	}
}

const fn special_dollar(c: u8) -> Option<Special> {
	Some(match c {
		b'@' => Special::At,
		b'*' => Special::Star,
		b'#' => Special::Count,
		b'?' => Special::Status,
		b'-' => Special::Flags,
		b'$' => Special::ShellPid,
		b'!' => Special::LastBg,
		_ => return None,
	})
}

/// Bytes with no special meaning in an unquoted word.
const PLAIN_WORD_BYTES: [bool; 256] = {
	let mut bytes = [true; 256];
	let special = b"\\'\"`$<>();&| \t\n[]=+}@*?!";
	let mut i = 0;
	while i < special.len() {
		bytes[special[i] as usize] = false;
		i += 1;
	}
	bytes
};

const fn plain_word_byte(c: u8) -> bool {
	PLAIN_WORD_BYTES[c as usize]
}

/// A parameter expansion being parsed (`${…}`): its name, subscript and
/// operator, as nodes once read.
struct ParamB {
	name:     NameOwned,
	index:    Option<SubB>,
	op:       OpB,
	braced:   bool,
	indirect: bool,
}

/// [`NameB`] with the variable name held.
#[derive(Clone, PartialEq, Eq)]
enum NameOwned {
	Var(SmallBytes),
	Positional(u32),
	Special(Special),
}

impl<'s> Parser<'s> {
	/// The part node of a parameter expansion.
	fn param_node(&mut self, p: &ParamB) -> Id<Part> {
		let name = match &p.name {
			NameOwned::Var(v) => NameB::Var(v),
			NameOwned::Positional(n) => NameB::Positional(*n),
			NameOwned::Special(s) => NameB::Special(*s),
		};
		self.t.param(name, p.index, p.op, p.braced, p.indirect)
	}

	fn plain_param(&mut self, name: NameOwned) -> Id<Part> {
		let p = ParamB { name, index: None, op: OpB::None, braced: false, indirect: false };
		self.param_node(&p)
	}

	/// The kind of part node `p`.
	fn part_kind(&self, p: Id<Part>) -> Pk {
		self.t.part_kind(p)
	}

	/// Read one word token at the cursor (bash `read_token_word`).
	/// `acceptable`: an assignment may start here.
	#[inline(never)]
	pub(super) fn read_word(&mut self, acceptable: bool) -> PResult<WordTok<'s>> {
		let lo = self.off();
		let compassign = self.lx.compassign;
		// Fast path: a run of ordinary bytes in the current buffer ending the
		// word.
		if self.pos < self.buf.len() && !self.lx.regexp && !compassign {
			let buf: &'s [u8] = self.buf;
			let rest = &buf[self.pos..];
			let n = run_len(self.feat, rest, |c| !plain_word_byte(c));
			if n > 0
				&& rest.get(n).is_some_and(|&c| {
					is_break(c) && !(matches!(c, b'<' | b'>') && rest.get(n + 1) == Some(&b'('))
				}) {
				let run = &rest[..n];
				let part = self.t.text_part(TextPk::Lit, run);
				let parts = self.t.run(&[part]);
				self.advance(n);
				return Ok(WordTok {
					lo,
					hi: self.off(),
					parts,
					quoted: false,
					asg: None,
					plain: Plain::Input(run),
				});
			}
		}
		let mut acc = Acc::new(&self.t);
		let mut quoted = false;
		let mut scan = if compassign { Scan::No } else { Scan::Start };
		let mut split: Option<Box<AsgSplit>> = None;
		let mut sub: Option<(usize, usize, Span)> = None;
		let mut first = true;
		loop {
			// A run of ordinary bytes in the current buffer.
			if self.pos < self.buf.len() {
				let buf: &'s [u8] = self.buf;
				let rest = &buf[self.pos..];
				let n = run_len(self.feat, rest, |c| !plain_word_byte(c));
				if n > 0 {
					let run = &rest[..n];
					match scan {
						Scan::Start | Scan::Name => {
							let ok = if scan == Scan::Start {
								is_name_start(run[0]) && run[1..].iter().all(|&c| is_name_char(c))
							} else {
								run.iter().all(|&c| is_name_char(c))
							};
							scan = if ok { Scan::Name } else { Scan::No };
						},
						Scan::LitSub(_) | Scan::Found | Scan::No => {},
						Scan::AfterSub | Scan::Plus => scan = Scan::No,
					}
					acc.lit.extend_from_slice(run);
					self.advance(n);
					first = false;
					continue;
				}
			}
			let Some(c) = self.peek() else { break };
			match c {
				b'\\' => {
					if self.peek_at(1) == Some(b'\n') {
						self.bump();
						self.bump();
						continue;
					}
					self.bump();
					quoted = true;
					if !matches!(scan, Scan::Found | Scan::LitSub(_)) {
						scan = Scan::No;
					}
					match self.peek() {
						None => acc.lit.push(b'\\'),
						Some(d) => {
							let bytes = self.take_char(d);
							let p = self.t.text_part(TextPk::Escaped, &bytes);
							acc.push(&mut self.t, p);
						},
					}
				},
				b'}'
					if self.lx.funsubst
						&& first
						&& acc.is_empty(&self.t)
						&& self.reserved_word_acceptable(self.lx.last) =>
				{
					self.bump();
					acc.lit.push(b'}');
					break;
				},
				b'\'' | b'"' | b'`' => {
					if c != b'`' {
						quoted = true;
					}
					if !matches!(scan, Scan::Found | Scan::LitSub(_)) {
						scan = Scan::No;
					}
					acc.flush(&mut self.t);
					let part = self.quoted_part(c, false)?;
					acc.push(&mut self.t, part);
				},
				b'(' | b'|' if self.lx.regexp => {
					self.bump();
					acc.lit.push(c);
					if c == b'(' {
						self.group_into(&mut acc)?;
					}
					scan = Scan::No;
				},
				b'@' | b'*' | b'+' | b'?' | b'!'
					if self.lx.extglob && self.peek_at(1) == Some(b'(') =>
				{
					self.bump();
					self.bump();
					acc.lit.push(c);
					acc.lit.push(b'(');
					self.group_into(&mut acc)?;
					scan = Scan::No;
				},
				b'$' => {
					if !matches!(scan, Scan::Found | Scan::LitSub(_)) {
						scan = Scan::No;
					}
					if let Some(part) = self.dollar(Stop::Group, false)? {
						if matches!(self.part_kind(part), Pk::AnsiC | Pk::Locale) {
							quoted = true;
						}
						acc.push(&mut self.t, part);
					} else {
						self.bump();
						acc.lit.push(b'$');
					}
				},
				b'<' | b'>' if self.peek_at(1) == Some(b'(') => {
					if !matches!(scan, Scan::Found | Scan::LitSub(_)) {
						scan = Scan::No;
					}
					acc.flush(&mut self.t);
					let part = self.procsub(c == b'>')?;
					acc.push(&mut self.t, part);
				},
				b'['
					if (scan == Scan::Name && acceptable)
						|| (compassign && first && acc.is_empty(&self.t)) =>
				{
					// Subscript of an assignment (`a[i]=`) or of a compound
					// array element (`[k]=v`), read as a group.
					let sub_lo = self.off();
					self.bump();
					acc.lit.push(b'[');
					acc.flush(&mut self.t);
					let start = acc.len(&self.t);
					let inner = self.parts_until(Stop::Bracket)?;
					let inner_hi = self.off();
					self.t.kid_run(acc.mark, inner);
					let end = acc.len(&self.t);
					if self.peek() == Some(b']') {
						self.bump();
					}
					acc.lit.push(b']');
					sub = Some((start, end, Span::new(sub_lo + 1, inner_hi)));
					scan = Scan::AfterSub;
				},
				b'[' => {
					self.bump();
					acc.lit.push(b'[');
					scan = match scan {
						Scan::Name => Scan::LitSub(1),
						Scan::LitSub(d) => Scan::LitSub(d + 1),
						Scan::Found => Scan::Found,
						_ => Scan::No,
					};
				},
				b']' => {
					self.bump();
					acc.lit.push(b']');
					scan = match scan {
						Scan::LitSub(1) => Scan::AfterSub,
						Scan::LitSub(d) => Scan::LitSub(d - 1),
						Scan::Found => Scan::Found,
						_ => Scan::No,
					};
				},
				b'+' => {
					self.bump();
					acc.lit.push(b'+');
					scan = match scan {
						Scan::Name | Scan::AfterSub if self.peek() == Some(b'=') => Scan::Plus,
						Scan::LitSub(d) => Scan::LitSub(d),
						Scan::Found => Scan::Found,
						_ => Scan::No,
					};
				},
				b'=' => {
					self.bump();
					acc.lit.push(b'=');
					let at = matches!(scan, Scan::Name | Scan::AfterSub | Scan::Plus);
					let keyed =
						compassign && sub.is_some() && matches!(scan, Scan::AfterSub | Scan::Plus);
					if (at && !compassign) || keyed {
						let append = scan == Scan::Plus;
						let name = if compassign {
							SmallBytes::new()
						} else if sub.is_some()
							&& let Some(p) = self.t.opened(acc.mark, 0)
							&& self.part_kind(p) == Pk::Lit
						{
							let s = self.t.part_text(p);
							SmallBytes::from_slice(&s[..s.len() - 1])
						} else {
							let n = acc.lit.len() - 1 - usize::from(append);
							SmallBytes::from_slice(&acc.lit[..n])
						};
						acc.flush(&mut self.t);
						let value_at = acc.len(&self.t);
						let value_lo = self.off();
						let mut s =
							AsgSplit { name, index: sub, append, value_at, value_lo, array: None };
						scan = Scan::Found;
						// `name=(…)`: a compound assignment.
						if self.peek() == Some(b'(') && (acceptable || self.lx.assignok) && !compassign {
							self.bump();
							s.array = Some(self.compound_assignment()?);
						}
						split = Some(Box::new(s));
					} else if scan != Scan::Found {
						scan = Scan::No;
					}
				},
				_ if is_break(c) => break,
				_ => {
					// `]`, `}`, `@`, `*`, `?`, `!` and bytes read one at a time
					// (across alias buffers, where the fast path stops).
					self.take_char_into(c, &mut acc.lit);
					scan = match scan {
						Scan::Start if is_name_start(c) => Scan::Name,
						Scan::Name if is_name_char(c) => Scan::Name,
						Scan::Found | Scan::LitSub(_) => scan,
						_ => Scan::No,
					};
				},
			}
			first = false;
		}
		let hi = self.off();
		// A word that is one literal keeps its text for the lexer's checks.
		let plain = if !quoted && acc.len(&self.t) == 0 && !acc.lit.is_empty() {
			Plain::Owned(acc.lit.clone())
		} else {
			Plain::None
		};
		let parts = acc.finish(&mut self.t);
		let plain = match plain {
			Plain::Owned(s) if parts.len() == 1 => Plain::Owned(s),
			_ => Plain::None,
		};
		Ok(WordTok { lo, hi, parts, quoted, asg: split, plain })
	}

	/// The token as a plain word.
	pub(super) fn word_node(&mut self, w: WordTok<'_>) -> Id<shape::Word> {
		let span = Span::new(w.lo, w.hi);
		match w.asg.and_then(|a| Some((a.value_at, a.array?))) {
			Some((at, elems)) => {
				let compound = self.t.compound_part(elems);
				let mark = self.t.open();
				let n = w.parts.len() as usize;
				self.t.kid_run(mark, w.parts.slice(0, at.min(n)));
				self.t.kid(mark, compound);
				self.t.kid_run(mark, w.parts.slice(at.min(n), n));
				let r = self.t.close_run(mark);
				self.t.word_over(span, r)
			},
			None => self.t.word_over(span, w.parts),
		}
	}

	/// The token as an assignment (only when [`WordTok::is_assign`]).
	pub(super) fn assign_node(&mut self, w: WordTok<'_>) -> Id<shape::Assign> {
		let (lo, hi) = (w.lo, w.hi);
		let a = w.asg.expect("assign_node on a non-assignment word");
		let parts = w.parts;
		let index = a
			.index
			.map(|(s, e, span)| self.t.word_over(span, parts.slice(s, e)));
		let value_parts = parts.slice(a.value_at, parts.len() as usize);
		let value_span = Span::new(a.value_lo, hi);
		let span = Span::new(lo, hi);
		match a.array {
			Some(elems) if value_parts.is_empty() => {
				self
					.t
					.assign(span, &a.name, index, a.append, AssignB::Array(elems))
			},
			Some(elems) => {
				let compound = self.t.compound_part(elems);
				let mark = self.t.open();
				self.t.kid(mark, compound);
				self.t.kid_run(mark, value_parts);
				let r = self.t.close_run(mark);
				let value = self.t.word_over(value_span, r);
				self
					.t
					.assign(span, &a.name, index, a.append, AssignB::Scalar(value))
			},
			None => {
				let value = self.t.word_over(value_span, value_parts);
				self
					.t
					.assign(span, &a.name, index, a.append, AssignB::Scalar(value))
			},
		}
	}

	/// One compound-assignment word as an element.
	pub(super) fn elem_node(&mut self, w: WordTok<'_>) -> Id<Elem> {
		let keyed = w.asg.as_ref().is_some_and(|a| a.index.is_some());
		if !keyed {
			let value = self.word_node(w);
			return self.t.elem(None, false, value);
		}
		let hi = w.hi;
		let a = w.asg.expect("checked");
		let (s, e, span) = a.index.expect("checked");
		let key = self.t.word_over(span, w.parts.slice(s, e));
		let value_parts = w.parts.slice(a.value_at, w.parts.len() as usize);
		let value = self.t.word_over(Span::new(a.value_lo, hi), value_parts);
		self.t.elem(Some(key), a.append, value)
	}

	/// Consume a character into a literal without allocating an intermediate
	/// buffer.
	fn take_char_into(&mut self, c: u8, out: &mut impl Extend<u8>) {
		if c.is_ascii() {
			out.extend([c]);
			self.bump();
		} else {
			out.extend(self.take_char(c).iter().copied());
		}
	}

	/// Consume one (UTF-8) character at the cursor and return its bytes.
	fn take_char(&mut self, c: u8) -> SmallBytes {
		if self.feat.multibyte() {
			// The bytes after the first are part of the character whatever
			// they look like.
			let n = self.feat.char_len(c, self.peek_at(1).unwrap_or(0));
			let mut out = SmallBytes::new();
			for _ in 0..n {
				let Some(d) = self.peek() else { break };
				out.push(d);
				self.bump();
			}
			return out;
		}
		let n = char_len(c);
		let mut out = SmallBytes::new();
		out.push(c);
		self.bump();
		for _ in 1..n {
			match self.peek() {
				Some(d) if (d & 0xc0) == 0x80 => {
					out.push(d);
					self.bump();
				},
				_ => break,
			}
		}
		out
	}

	/// The quoted construct starting at `c` (`'`, `"` or a backquote).
	/// `dq`: inside double quotes (single quotes are literal there).
	fn quoted_part(&mut self, c: u8, dq: bool) -> PResult<Id<Part>> {
		let line = self.bash_line();
		match c {
			b'\'' if !dq => {
				self.bump();
				let mut s = SmallBytes::new();
				loop {
					let buf: &'s [u8] = self.buf;
					let rest = buf.get(self.pos..).unwrap_or_default();
					if let Some(n) = rest.iter().position(|&c| c == b'\'') {
						let part = if s.is_empty() {
							self.t.text_part(TextPk::SQuote, &rest[..n])
						} else {
							s.extend_from_slice(&rest[..n]);
							self.t.text_part(TextPk::SQuote, &s)
						};
						self.advance_lines(n);
						self.bump();
						return Ok(part);
					}
					s.extend_from_slice(rest);
					self.advance_lines(rest.len());
					match self.peek() {
						None => return Err(unmatched_error(self.eof_span(), line, "'")),
						Some(b'\'') => {
							self.bump();
							return Ok(self.t.text_part(TextPk::SQuote, &s));
						},
						Some(d) => {
							s.push(d);
							self.bump();
						},
					}
				}
			},
			b'"' => {
				self.bump();
				let parts = self.parts_until_line(Stop::DQuote { all: false }, line)?;
				Ok(self.t.group_part(GroupPk::DQuote, parts))
			},
			_ => self.backquote(line, dq),
		}
	}

	/// Consume a run of name characters (`[A-Za-z0-9_]`).
	fn take_name(&mut self) -> SmallBytes {
		let mut name = SmallBytes::new();
		while let Some(c) = self.peek()
			&& is_name_char(c)
		{
			name.push(c);
			self.bump();
		}
		name
	}

	pub(super) fn eof_span(&self) -> Span {
		let at = self.off();
		Span::new(at, at)
	}

	/// `` `…` ``: the raw text (bash keeps it verbatim) and its body, parsed
	/// from the text with `\$`, `` \` ``, `\\` (and `\"` inside `"…"`)
	/// unescaped.
	fn backquote(&mut self, line: u32, dq: bool) -> PResult<Id<Part>> {
		self.bump();
		let text_lo = self.off();
		let mut text = Vec::new();
		loop {
			let Some(c) = self.peek() else {
				return Err(unmatched_error(self.eof_span(), line, "`"));
			};
			match c {
				b'`' => {
					self.bump();
					break;
				},
				b'\\' => {
					self.bump();
					match self.peek() {
						Some(b'\n') => self.bump(),
						Some(d) => {
							text.push(b'\\');
							text.push(d);
							self.bump();
						},
						None => text.push(b'\\'),
					}
				},
				_ => {
					self.take_char_into(c, &mut text);
				},
			}
		}
		let mut code = Vec::with_capacity(text.len());
		let mut i = 0;
		while i < text.len() {
			if text[i] == b'\\'
				&& i + 1 < text.len()
				&& (matches!(text[i + 1], b'$' | b'`' | b'\\') || (dq && text[i + 1] == b'"'))
			{
				code.push(text[i + 1]);
				i += 2;
			} else {
				code.push(text[i]);
				i += 1;
			}
		}
		let body = super::sub_parse_list(&mut self.t, &code, self.feat, text_lo, self.depth)
			.ok_or_else(|| self.too_deep())?;
		Ok(self.t.comsub(ComsubKind::Backtick, body, &text))
	}

	/// Parts up to the terminator of `stop`.
	pub(super) fn parts_until(&mut self, stop: Stop) -> PResult<Run<Part>> {
		let line = self.bash_line();
		self.parts_until_line(stop, line)
	}

	fn parts_until_line(&mut self, stop: Stop, line: u32) -> PResult<Run<Part>> {
		let mut acc = Acc::new(&self.t);
		self.parts_into(&mut acc, stop, line)?;
		Ok(acc.finish(&mut self.t))
	}

	/// The rest of an extglob or regexp group after its `(`, as literal
	/// text with expansions, through the matching `)`.
	fn group_into(&mut self, acc: &mut Acc) -> PResult<()> {
		let line = self.bash_line();
		self.parts_into(acc, Stop::Group, line)
	}

	/// The part loop shared by every quoting context.
	#[allow(clippy::cognitive_complexity, reason = "one state machine over bash's quoting rules")]
	fn parts_into(&mut self, acc: &mut Acc, stop: Stop, line: u32) -> PResult<()> {
		let dq = stop.in_dq();
		let mut depth = 0u32;
		let mut lit_sq = false;
		let mut sq_line = line;
		loop {
			if self.pos < self.buf.len() {
				let buf: &'s [u8] = self.buf;
				let rest = &buf[self.pos..];
				let n = run_len(self.feat, rest, |c| {
					matches!(
						c,
						b'\\'
							| b'\''
							| b'"'
							| b'`'
							| b'$'
							| b'<'
							| b'>'
							| b'('
							| b')'
							| b'['
							| b']'
							| b'}'
							| b'/'
							| b'\n'
					)
				});
				if n > 0 {
					acc.lit.extend_from_slice(&rest[..n]);
					self.advance(n);
					continue;
				}
			}
			let Some(c) = self.peek() else {
				if lit_sq {
					return Err(unmatched_error(self.eof_span(), sq_line, "'"));
				}
				return match stop {
					Stop::Text(_) => Ok(()),
					Stop::DQuote { .. } => Err(unmatched_error(self.eof_span(), line, "\"")),
					Stop::Brace { .. } => Err(unmatched_error(self.eof_span(), line, "}")),
					Stop::Bracket => Err(unmatched_error(self.eof_span(), line, "]")),
					Stop::Group => Err(unmatched_error(self.eof_span(), line, ")")),
				};
			};
			match c {
				// In a non-pattern `${…}` word inside "…", `'` is an ordinary
				// character; outside posix mode it still pairs, so `}` and `"`
				// between the quotes do not end anything.
				b'\'' if matches!(stop, Stop::Brace { dq: true, pat: false, .. }) => {
					self.bump();
					acc.lit.push(b'\'');
					if !self.feat.contains(crate::bash::syntax::Features::POSIX) {
						if !lit_sq {
							sq_line = self.bash_line();
						}
						lit_sq = !lit_sq;
					}
				},
				b'"' if lit_sq => {
					self.bump();
					acc.flush(&mut self.t);
					let p = self.t.dropped_quote();
					acc.push(&mut self.t, p);
				},
				b'}' | b'/' if lit_sq => {
					self.bump();
					acc.lit.push(c);
				},
				b'"' if matches!(stop, Stop::DQuote { .. }) => {
					self.bump();
					return Ok(());
				},
				b'}' if matches!(stop, Stop::Brace { .. }) => return Ok(()),
				b'/' if matches!(stop, Stop::Brace { slash: true, .. }) => return Ok(()),
				b']' if stop == Stop::Bracket && depth == 0 => return Ok(()),
				b')' if stop == Stop::Group && depth == 0 => {
					self.bump();
					acc.lit.push(b')');
					return Ok(());
				},
				b'[' | b'('
					if (stop == Stop::Bracket && c == b'[') || (stop == Stop::Group && c == b'(') =>
				{
					depth += 1;
					self.bump();
					acc.lit.push(c);
				},
				b']' | b')'
					if (stop == Stop::Bracket && c == b']') || (stop == Stop::Group && c == b')') =>
				{
					depth -= 1;
					self.bump();
					acc.lit.push(c);
				},
				b'\n' => {
					self.bump();
					acc.lit.push(b'\n');
				},
				b'\\' => {
					self.bump();
					match self.peek() {
						Some(b'\n') => self.bump(),
						None => acc.lit.push(b'\\'),
						Some(d) => {
							let escaped = if dq {
								match stop {
									Stop::Text(TextMode::HereDoc) => matches!(d, b'$' | b'`' | b'\\'),
									// Pattern and replacement words quote with every
									// backslash (`"${v/a/\q}"` is `q…`).
									Stop::Brace { pat: true, .. } => true,
									Stop::Brace { .. } => matches!(d, b'$' | b'`' | b'"' | b'\\' | b'}'),
									Stop::DQuote { all: true } => true,
									_ => matches!(d, b'$' | b'`' | b'"' | b'\\'),
								}
							} else {
								true
							};
							let bytes = self.take_char(d);
							if escaped {
								acc.flush(&mut self.t);
								let p = self.t.text_part(TextPk::Escaped, &bytes);
								acc.push(&mut self.t, p);
							} else {
								// The backslash stays, and the character after it
								// starts nothing (`"${a#'x'\'}"`).
								acc.lit.push(b'\\');
								acc.lit.extend_from_slice(&bytes);
							}
						},
					}
				},
				b'\'' if !dq || matches!(stop, Stop::Brace { .. }) => {
					acc.flush(&mut self.t);
					let part = self.quoted_part(c, false)?;
					acc.push(&mut self.t, part);
				},
				b'"'
					if stop != Stop::Text(TextMode::HereDoc)
						&& stop != Stop::Text(TextMode::DoubleQuote) =>
				{
					acc.flush(&mut self.t);
					if stop == Stop::Text(TextMode::Arith) {
						// Arithmetic: double quotes are removed.
						self.bump();
						let inner = self.parts_until_line(Stop::DQuote { all: false }, line)?;
						self.t.kid_run(acc.mark, inner);
					} else if matches!(stop, Stop::Brace { dq: true, pat: false, .. }) {
						// `"${v:+x="\p"}"`: every backslash in these quotes quotes.
						self.bump();
						let inner =
							self.parts_until_line(Stop::DQuote { all: true }, self.bash_line())?;
						let p = self.t.group_part(GroupPk::DQuote, inner);
						acc.push(&mut self.t, p);
					} else {
						let part = self.quoted_part(c, true)?;
						acc.push(&mut self.t, part);
					}
				},
				b'`' => {
					acc.flush(&mut self.t);
					let part = self.quoted_part(c, dq)?;
					acc.push(&mut self.t, part);
				},
				b'$' => {
					if lit_sq
						&& self.peek_at(1) == Some(b'(')
						&& self.peek_at(2) != Some(b'(')
						&& let Some(part) = self.bad_comsub()
					{
						// The text ran to the `}` ending the word.
						acc.push(&mut self.t, part);
						lit_sq = false;
						continue;
					}
					let ansi_ok = !matches!(
						stop,
						Stop::DQuote { .. } | Stop::Text(_) | Stop::Brace { doc: true, pat: false, .. }
					);
					if let Some(part) = self.dollar(stop, !ansi_ok)? {
						acc.push(&mut self.t, part);
					} else {
						self.bump();
						acc.lit.push(b'$');
					}
				},
				b'<' | b'>' if !dq && self.peek_at(1) == Some(b'(') => {
					acc.flush(&mut self.t);
					let part = self.procsub(c == b'>')?;
					acc.push(&mut self.t, part);
				},
				_ => {
					self.take_char_into(c, &mut acc.lit);
				},
			}
		}
	}

	/// A `$` expansion at the cursor; `None` when the `$` is literal.
	/// `no_quotes`: `$'` and `$"` are not special (inside `"…"`).
	pub(super) fn dollar(&mut self, ctx: Stop, no_quotes: bool) -> PResult<Option<Id<Part>>> {
		let Some(c) = self.peek_at(1) else {
			return Ok(None);
		};
		let dq = ctx.in_dq();
		let doc = matches!(ctx, Stop::Text(TextMode::HereDoc) | Stop::Brace { doc: true, .. });
		match c {
			_ if is_name_start(c) => {
				self.bump();
				let name = self.take_name();
				Ok(Some(self.plain_param(NameOwned::Var(name))))
			},
			b'0'..=b'9' => {
				self.bump();
				self.bump();
				Ok(Some(self.plain_param(NameOwned::Positional(u32::from(c - b'0')))))
			},
			_ if special_dollar(c).is_some() => {
				self.bump();
				self.bump();
				let s = special_dollar(c).expect("checked");
				Ok(Some(self.plain_param(NameOwned::Special(s))))
			},
			b'{' => {
				let n2 = self.peek_at(2);
				if matches!(n2, Some(b' ' | b'\t' | b'\n' | b'|')) {
					self.bump();
					self.bump();
					let value = n2 == Some(b'|');
					if value {
						self.bump();
					}
					return self.funsub(value).map(Some);
				}
				self.braced_param(dq, doc).map(Some)
			},
			b'(' => {
				self.bump();
				self.bump();
				if self.peek() == Some(b'(') {
					return self.dollar_dparen().map(Some);
				}
				self.dollar_paren().map(Some)
			},
			b'[' => {
				self.bump();
				self.bump();
				let lo = self.off();
				let line = self.bash_line();
				let src = self.raw_arith(b'[', b']', line)?;
				let hi = self.off() - 1;
				let a = self.t.arith(Span::new(lo, hi), &src, true);
				Ok(Some(self.t.arith_part(a)))
			},
			b'\'' if !no_quotes => {
				self.bump();
				let line = self.bash_line();
				self.bump();
				let mut raw = SmallBytes::new();
				loop {
					let Some(d) = self.peek() else {
						return Err(unmatched_error(self.eof_span(), line, "'"));
					};
					self.bump();
					match d {
						b'\'' => break,
						b'\\' => {
							raw.push(b'\\');
							if let Some(e) = self.peek() {
								raw.push(e);
								self.bump();
							}
						},
						_ => raw.push(d),
					}
				}
				Ok(Some(self.t.text_part(TextPk::AnsiC, &raw)))
			},
			b'"' if !no_quotes => {
				self.bump();
				let line = self.bash_line();
				self.bump();
				let parts = self.parts_until_line(Stop::DQuote { all: false }, line)?;
				Ok(Some(self.t.group_part(GroupPk::Locale, parts)))
			},
			_ => Ok(None),
		}
	}

	/// `$((` seen (cursor at the second `(`): arithmetic when the text closes
	/// with `))`, otherwise a command substitution of a subshell.
	fn dollar_dparen(&mut self) -> PResult<Id<Part>> {
		let lo = self.off();
		let line = self.bash_line();
		let text = self.raw_arith(b'(', b')', line)?;
		let hi = self.off() - 1;
		// text is `(…)…` without the final `)`.
		if let Some(inner) = arith_inner(&text) {
			let a = self
				.t
				.arith(Span::new(lo + 1, hi.saturating_sub(1)), inner, false);
			return Ok(self.t.arith_part(a));
		}
		let body = super::sub_parse_list(&mut self.t, &text, self.feat, lo, self.depth)
			.ok_or_else(|| self.too_deep())?;
		Ok(self.t.comsub(ComsubKind::Dollar, body, &text))
	}

	/// `$(` seen: parse the command substitution.
	fn dollar_paren(&mut self) -> PResult<Id<Part>> {
		let (body, text) = self.comsub(b')', false)?;
		Ok(self.t.comsub(ComsubKind::Dollar, body, &text))
	}

	/// `${ ` / `${|` seen: a nofork command substitution.
	fn funsub(&mut self, value: bool) -> PResult<Id<Part>> {
		let (body, text) = self.comsub(b'}', value)?;
		let kind = if value {
			ComsubKind::ValueSub
		} else {
			ComsubKind::NoFork
		};
		Ok(self.t.comsub(kind, body, &text))
	}

	/// `<(` / `>(` at the cursor.
	fn procsub(&mut self, output: bool) -> PResult<Id<Part>> {
		self.bump();
		self.bump();
		let (body, _) = self.comsub(b')', false)?;
		Ok(self.t.procsub(output, body))
	}

	/// `"${a+'$('\'}"`: between the literal quotes of a `${…}` word inside
	/// "…", bash parses a `$(` only when it expands the word, and over the
	/// text up to the end of the word. `Some` when that text does not parse:
	/// the part keeps the error for expansion time and the cursor moves to
	/// the `}` ending the word.
	fn bad_comsub(&mut self) -> Option<Id<Part>> {
		let buf: &'s [u8] = self.buf;
		let rest = buf.get(self.pos..).unwrap_or_default();
		let len = word_end_in_quote(rest)?;
		let text = &rest[..len];
		let mut sub = Parser::new(&text[2..], self.feat, crate::bash::syntax::NO_ALIASES);
		let e = sub.comsub(b')', false).err()?;
		let part = self.t.bad_comsub(text, e.line, &e.bash_msg());
		self.advance_lines(len);
		Some(part)
	}

	/// `${…}` at the cursor; `doc`: inside an unquoted here-document.
	fn braced_param(&mut self, dq: bool, doc: bool) -> PResult<Id<Part>> {
		let start = self.mark();
		let line = self.bash_line();
		self.bump();
		self.bump();
		match self.nested(|p| p.param_body(dq, doc, line))? {
			Some(p) => {
				if self.peek() == Some(b'}') {
					self.bump();
					return Ok(self.param_node(&p));
				}
				self.bad_subst(start, line)
			},
			None => self.bad_subst(start, line),
		}
	}

	/// Skip to the `}` closing a `${` that bash rejects at expansion time and
	/// keep its text.
	fn bad_subst(&mut self, start: super::cursor::Mark<'s>, line: u32) -> PResult<Id<Part>> {
		// Re-scan from the start with bash's matching rules.
		let restarted = self.reset(start);
		if restarted {
			self.bump();
			self.bump();
		}
		let mut text = b"${".to_vec();
		let body = self.raw_matched(b'{', b'}', super::raw::Flags::DOLBRACE, line)?;
		text.extend_from_slice(&body);
		text.push(b'}');
		Ok(self.t.text_part(TextPk::BadSubst, &text))
	}

	/// The inside of `${…}` up to (not including) the closing `}`; `None`
	/// when bash would report a bad substitution.
	fn param_body(&mut self, dq: bool, doc: bool, line: u32) -> PResult<Option<ParamB>> {
		let mut p = ParamB {
			name:     NameOwned::Special(Special::Count),
			index:    None,
			op:       OpB::None,
			braced:   true,
			indirect: false,
		};
		let c0 = self.peek();
		let c1 = self.peek_at(1);
		// `"${$'x1'%t}"`: inside "…" (and here-documents) bash replaces a
		// `$'…'` name with its unquoted value (`extquote`); unquoted, the
		// name stays quoted and the expansion is bad.
		if dq && c0 == Some(b'$') && c1 == Some(b'\'') {
			let save = self.mark();
			if let Some(part) = self.dollar(Stop::Group, false)?
				&& self.part_kind(part) == Pk::AnsiC
			{
				let name = crate::bash::syntax::util::ansi_decode(self.t.part_text(part));
				if crate::bash::syntax::util::is_identifier(&name)
					&& !self.peek().is_some_and(|c| is_name_char(c) || c == b'[')
				{
					p.name = NameOwned::Var(name.into());
					return self.param_op(p, dq, doc, line);
				}
			}
			if !self.reset(save) {
				return Ok(None);
			}
		}
		// `${#…}`: length, unless `#` itself is the parameter.
		if c0 == Some(b'#') && c1 != Some(b'}') && c1.is_some_and(starts_param) {
			let save = self.mark();
			self.bump();
			if let Some((name, index)) = self.param_name()?
				&& self.peek() == Some(b'}')
			{
				p.name = name;
				p.index = index;
				p.op = OpB::Length;
				return Ok(Some(p));
			}
			if !self.reset(save) {
				return Ok(None);
			}
		}
		// `${!…}`: indirection, prefix names, array keys. bash allows only a
		// name, a digit, `@`, `*` (and `#`, `?` outside posix mode) after
		// the `!`; otherwise `!` is `$!` followed by an operator.
		let posix = self.feat.contains(crate::bash::syntax::Features::POSIX);
		let indir = |c: u8| {
			is_name_start(c)
				|| c.is_ascii_digit()
				|| matches!(c, b'@' | b'*')
				|| (!posix && matches!(c, b'#' | b'?'))
		};
		if c0 == Some(b'!') && c1.is_some_and(indir) {
			let save = self.mark();
			self.bump();
			if self.prefix_names_end() {
				// `${!prefix*}` / `${!prefix@}`.
				let name = self.take_name();
				let star = self.peek() == Some(b'*');
				self.bump();
				p.name = NameOwned::Var(name);
				p.op = OpB::PrefixNames { star };
				return Ok(Some(p));
			}
			match self.param_name()? {
				Some((name, index)) => {
					p.name = name;
					p.index = index;
					if self.peek() == Some(b'}') {
						p.op = OpB::Indirect;
						return Ok(Some(p));
					}
					p.indirect = true;
					return self.param_op(p, dq, doc, line);
				},
				None => {
					if !self.reset(save) {
						return Ok(None);
					}
				},
			}
		}
		match self.param_name()? {
			Some((name, index)) => {
				// `${#:}`, `${#%}`, `${#/}`, … : `$#` with an operator and no
				// word is a bad substitution.
				if name == NameOwned::Special(Special::Count)
					&& matches!(self.peek(), Some(b':' | b'%' | b'/' | b'=' | b'+' | b'^' | b','))
					&& self.peek_at(1) == Some(b'}')
				{
					return Ok(None);
				}
				p.name = name;
				p.index = index;
				self.param_op(p, dq, doc, line)
			},
			None => Ok(None),
		}
	}

	/// After `${!`: whether the name is followed directly by `*}` / `@}`.
	fn prefix_names_end(&self) -> bool {
		let Some(rest) = self.buf.get(self.pos..) else {
			return false;
		};
		if !rest.first().is_some_and(|&c| is_name_start(c)) {
			return false;
		}
		let n = rest
			.iter()
			.position(|&c| !is_name_char(c))
			.unwrap_or(rest.len());
		matches!((rest.get(n), rest.get(n + 1)), (Some(b'*' | b'@'), Some(b'}')))
	}

	/// A parameter name (with subscript) at the cursor.
	fn param_name(&mut self) -> PResult<Option<(NameOwned, Option<SubB>)>> {
		let Some(c) = self.peek() else {
			return Ok(None);
		};
		let name = if is_name_start(c) {
			NameOwned::Var(self.take_name())
		} else if c.is_ascii_digit() {
			let mut n = 0u32;
			while let Some(d) = self.peek()
				&& d.is_ascii_digit()
			{
				n = n.saturating_mul(10).saturating_add(u32::from(d - b'0'));
				self.bump();
			}
			NameOwned::Positional(n)
		} else if let Some(s) = special_dollar(c) {
			self.bump();
			NameOwned::Special(s)
		} else {
			return Ok(None);
		};
		let mut index = None;
		if matches!(name, NameOwned::Var(_)) && self.peek() == Some(b'[') {
			let lo = self.off();
			self.bump();
			let at = self.peek();
			if matches!(at, Some(b'@' | b'*')) && self.peek_at(1) == Some(b']') {
				self.bump();
				self.bump();
				index = Some(if at == Some(b'@') {
					SubB::At
				} else {
					SubB::Star
				});
			} else {
				let parts = self.parts_until(Stop::Bracket)?;
				let hi = self.off();
				if self.peek() != Some(b']') {
					return Ok(None);
				}
				self.bump();
				index = Some(SubB::Expr(self.t.word_over(Span::new(lo + 1, hi), parts)));
			}
		}
		Ok(Some((name, index)))
	}

	/// The operator after the parameter name, up to the closing `}`.
	fn param_op(
		&mut self,
		mut p: ParamB,
		dq: bool,
		doc: bool,
		line: u32,
	) -> PResult<Option<ParamB>> {
		let Some(c) = self.peek() else {
			return Ok(Some(p));
		};
		let brace = Stop::Brace { dq, slash: false, pat: false, doc };
		match c {
			b'}' => {},
			b':' => {
				self.bump();
				if let Some(op @ (b'-' | b'=' | b'?' | b'+')) = self.peek() {
					self.bump();
					let w = self.op_word(brace)?;
					p.op = self.word_op(op, true, w);
				} else {
					let (offset, len) = self.substr(line)?;
					p.op = OpB::Substr { offset, len };
				}
			},
			b'-' | b'=' | b'?' | b'+' => {
				self.bump();
				let w = self.op_word(brace)?;
				p.op = self.word_op(c, false, w);
			},
			b'#' | b'%' => {
				self.bump();
				let longest = self.peek() == Some(c);
				if longest {
					self.bump();
				}
				let pat = self.op_word(Stop::Brace { dq, slash: false, pat: true, doc })?;
				p.op = OpB::Trim { suffix: c == b'%', longest, pat };
			},
			b'/' => {
				self.bump();
				let mode = match self.peek() {
					Some(b'/') => {
						self.bump();
						ReplaceMode::All
					},
					Some(b'#') => {
						self.bump();
						ReplaceMode::Prefix
					},
					Some(b'%') => {
						self.bump();
						ReplaceMode::Suffix
					},
					_ => ReplaceMode::First,
				};
				// After `//` bash looks for the `/` before the replacement from
				// the second byte of the pattern: `${a///a/}` replaces `/a`. An
				// anchor (`${a/#/x}`) is part of the pattern text, so it gets no
				// such skip.
				let lo = self.off();
				let lead = matches!(mode, ReplaceMode::All) && self.peek() == Some(b'/');
				if lead {
					self.bump();
				}
				let pat_lo = self.off();
				let parts = self.parts_until(Stop::Brace { dq, slash: true, pat: true, doc })?;
				let pat_hi = self.off();
				let pat = if lead {
					let slash = self.t.text_part(TextPk::Lit, b"/");
					let mark = self.t.open();
					self.t.kid(mark, slash);
					self.t.kid_run(mark, parts);
					let r = self.t.close_run(mark);
					self.t.word_over(Span::new(lo, pat_hi), r)
				} else {
					self.t.word_unmerged(Span::new(pat_lo, pat_hi), parts)
				};
				let rep = if self.peek() == Some(b'/') {
					self.bump();
					Some(self.op_word(Stop::Brace { dq, slash: false, pat: true, doc })?)
				} else {
					None
				};
				p.op = OpB::Replace { mode, pat, rep };
			},
			b'^' | b',' | b'~' => {
				self.bump();
				let all = self.peek() == Some(c);
				if all {
					self.bump();
				}
				let mode = match c {
					b'^' => CaseMode::Upper,
					b',' => CaseMode::Lower,
					_ => CaseMode::Toggle,
				};
				let w = self.op_word(Stop::Brace { dq, slash: false, pat: true, doc })?;
				let pat = (!Word::of(&self.t, w).parts().is_empty()).then_some(w);
				p.op = OpB::Case { mode, all, pat };
			},
			b'@' => {
				self.bump();
				match (self.peek(), self.peek_at(1)) {
					(
						Some(op @ (b'Q' | b'E' | b'P' | b'A' | b'a' | b'K' | b'k' | b'U' | b'u' | b'L')),
						Some(b'}'),
					) => {
						self.bump();
						p.op = OpB::Transform(op);
					},
					_ => return Ok(None),
				}
			},
			_ => return Ok(None),
		}
		Ok(Some(p))
	}

	/// An operator word inside `${…}` (parts as read, not merged).
	fn op_word(&mut self, stop: Stop) -> PResult<Id<shape::Word>> {
		let lo = self.off();
		let parts = self.parts_until(stop)?;
		let hi = self.off();
		Ok(self.t.word_unmerged(Span::new(lo, hi), parts))
	}

	fn word_op(&self, op: u8, colon: bool, word: Id<shape::Word>) -> OpB {
		match op {
			b'-' => OpB::Default { colon, word },
			b'=' => OpB::Assign { colon, word },
			b'?' => OpB::Error {
				colon,
				word: (!Word::of(&self.t, word).parts().is_empty()).then_some(word),
			},
			_ => OpB::Alt { colon, word },
		}
	}

	/// `${x:off[:len]}` after the `:`: arithmetic text nodes.
	fn substr(&mut self, line: u32) -> PResult<(Id<shape::Arith>, Option<Id<shape::Arith>>)> {
		let lo = self.off();
		let (off, at_colon) = self.raw_until_colon(line)?;
		let hi = self.off();
		let offset = self.t.arith(Span::new(lo, hi), &off, false);
		if !at_colon {
			return Ok((offset, None));
		}
		self.bump();
		let lo2 = self.off();
		let (len, _) = self.raw_until_colon(line)?;
		let hi2 = self.off();
		Ok((offset, Some(self.t.arith(Span::new(lo2, hi2), &len, false))))
	}

	/// Read one word in `mode` until end of input ([`parse_text`]).
	pub(super) fn text_word(&mut self, mode: TextMode) -> PResult<Id<shape::Word>> {
		self.lx.extglob = false;
		let lo = self.off();
		let parts = self.parts_until(Stop::Text(mode))?;
		let hi = self.off();
		Ok(self.t.word_over(Span::new(lo, hi), parts))
	}
}

/// `$((…))`: `text` is what followed `$(` up to the final `)`; arithmetic
/// when it is `(…)` with the first parenthesis closed by the last.
fn arith_inner(text: &[u8]) -> Option<&[u8]> {
	if text.first() != Some(&b'(') || text.last() != Some(&b')') {
		return None;
	}
	let mut depth = 0i32;
	let mut quote = 0u8;
	let mut i = 0;
	while i < text.len() {
		let c = text[i];
		if quote != 0 {
			if c == b'\\' && quote == b'"' {
				i += 1;
			} else if c == quote {
				quote = 0;
			}
		} else {
			match c {
				b'\\' => i += 1,
				b'\'' | b'"' | b'`' => quote = c,
				b'(' => depth += 1,
				b')' => {
					depth -= 1;
					if depth == 0 {
						return (i == text.len() - 1).then(|| &text[1..i]);
					}
				},
				_ => {},
			}
		}
		i += 1;
	}
	None
}

/// Length of `rest` up to the `}` that ends the `${…}` word it is in, as
/// bash's parse-time scan pairs quotes; `rest` starts inside a `'…'` pair.
fn word_end_in_quote(rest: &[u8]) -> Option<usize> {
	let mut i = rest.iter().position(|&c| c == b'\'')? + 1;
	let mut depth = 0u32;
	while let Some(&c) = rest.get(i) {
		match c {
			b'\\' => i += 1,
			b'\'' => i += rest.get(i + 1..)?.iter().position(|&c| c == b'\'')? + 1,
			b'"' => {
				i += 1;
				while let Some(&d) = rest.get(i) {
					if d == b'"' {
						break;
					}
					if d == b'\\' {
						i += 1;
					}
					i += 1;
				}
			},
			b'{' => depth += 1,
			b'}' if depth == 0 => return Some(i),
			b'}' => depth -= 1,
			_ => {},
		}
		i += 1;
	}
	None
}

/// Length of the run at the start of `rest` before the first byte that is
/// `special`. Under a charset flag ([`Features::multibyte`]) the bytes after
/// a character's first byte never end the run, and a character cut by the
/// end of `rest` is left to the byte-at-a-time path.
#[inline]
fn run_len(
	feat: crate::bash::syntax::Features,
	rest: &[u8],
	special: impl Fn(u8) -> bool,
) -> usize {
	if !feat.multibyte() {
		return rest.iter().position(|&c| special(c)).unwrap_or(rest.len());
	}
	let mut i = 0;
	while let Some(&c) = rest.get(i) {
		if c >= 0x80 {
			let n = feat.char_len(c, rest.get(i + 1).copied().unwrap_or(0));
			if i + n > rest.len() {
				return i;
			}
			i += n;
		} else if special(c) {
			return i;
		} else {
			i += 1;
		}
	}
	i
}

/// Whether `c` can follow `${#` / `${!` as a parameter.
const fn starts_param(c: u8) -> bool {
	is_name_start(c) || c.is_ascii_digit() || special_dollar(c).is_some()
}
