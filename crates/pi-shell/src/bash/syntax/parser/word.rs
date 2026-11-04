//! Words: a port of bash's `read_token_word` and of the quoting rules of
//! `parse_matched_pair`, lexing straight into [`WordPart`]s.

use alloc::{boxed::Box, vec, vec::Vec};

use super::{PResult, Parser, TextMode, empty_word, lex::unmatched_error};
use crate::bash::syntax::{
	ast::*,
	span::{NodeId, Span},
	util::{char_len, is_break, is_name_char, is_name_start},
};

/// A word token being built.
pub(super) struct WordTok {
	pub lo:     u32,
	pub hi:     u32,
	pub parts:  Vec<WordPart>,
	/// bash `quoted`: a quote character or backslash appeared.
	pub quoted: bool,
	/// The text is an assignment (bash `assignment()`): how to split it.
	pub asg:    Option<Box<AsgSplit>>,
}

/// Where an assignment word splits.
pub(super) struct AsgSplit {
	pub name:     Vec<u8>,
	/// Parts `[a, b)` of the subscript of `name[sub]=`, and its span.
	pub index:    Option<(usize, usize, Span)>,
	pub append:   bool,
	/// First part of the value.
	pub value_at: usize,
	pub value_lo: u32,
	/// `name=(…)` read as a compound assignment, and the parts after it.
	pub array:    Option<Vec<ArrayElem>>,
}

impl WordTok {
	/// The token text when the word is one unquoted literal.
	pub(super) fn plain(&self) -> Option<&[u8]> {
		if self.quoted {
			return None;
		}
		match &self.parts[..] {
			[WordPart::Lit(s)] => Some(s),
			_ => None,
		}
	}

	/// Whether the word is an assignment (`name=`, `name[i]+=`, …).
	pub(super) const fn is_assign(&self) -> bool {
		self.asg.is_some()
	}

	/// bash's text of the word, for messages.
	pub(super) fn render(&self, out: &mut Vec<u8>) {
		crate::bash::syntax::print::parts_text(&self.parts_for_render(), out);
	}

	fn parts_for_render(&self) -> Vec<WordPart> {
		let mut parts = self.parts.clone();
		if let Some(a) = &self.asg
			&& let Some(elems) = &a.array
		{
			parts.insert(a.value_at, WordPart::Compound(elems.clone()));
		}
		parts
	}

	/// The token as a plain word.
	pub(super) fn into_word(self) -> Word {
		let lo = self.lo;
		let hi = self.hi;
		let mut parts = self.parts;
		if let Some(a) = self.asg
			&& let Some(elems) = a.array
		{
			parts.insert(a.value_at, WordPart::Compound(elems));
		}
		Word { id: NodeId(0), span: Span::new(lo, hi), parts: merge_lits(parts) }
	}

	/// The token as an assignment (only when [`WordTok::is_assign`]).
	pub(super) fn into_assign(self) -> Assign {
		let lo = self.lo;
		let hi = self.hi;
		let a = self.asg.expect("into_assign on a non-assignment word");
		let mut parts = self.parts;
		let value_parts = parts.split_off(a.value_at);
		let index = a.index.map(|(s, e, span)| Word {
			id: NodeId(0),
			span,
			parts: merge_lits(parts.drain(s..e).collect()),
		});
		let value = match a.array {
			Some(elems) if value_parts.is_empty() => AssignValue::Array(elems),
			Some(elems) => {
				let mut v = vec![WordPart::Compound(elems)];
				v.extend(value_parts);
				AssignValue::Scalar(Word {
					id:    NodeId(0),
					span:  Span::new(a.value_lo, hi),
					parts: merge_lits(v),
				})
			},
			None => AssignValue::Scalar(Word {
				id:    NodeId(0),
				span:  Span::new(a.value_lo, hi),
				parts: merge_lits(value_parts),
			}),
		};
		Assign {
			id: NodeId(0),
			span: Span::new(lo, hi),
			name: a.name,
			index,
			append: a.append,
			value,
		}
	}
}

/// Join adjacent literal parts.
pub(super) fn merge_lits(mut parts: Vec<WordPart>) -> Vec<WordPart> {
	parts.retain(|part| !matches!(part, WordPart::Lit(s) if s.is_empty()));
	parts.dedup_by(|next, previous| {
		if let (WordPart::Lit(next), WordPart::Lit(previous)) = (next, previous) {
			previous.extend_from_slice(next);
			true
		} else {
			false
		}
	});
	parts
}

/// Accumulates literal bytes and parts.
struct Acc {
	parts: Vec<WordPart>,
	lit:   Vec<u8>,
}

impl Acc {
	const fn new() -> Self {
		Self { parts: Vec::new(), lit: Vec::new() }
	}

	fn flush(&mut self) {
		if !self.lit.is_empty() {
			self
				.parts
				.push(WordPart::Lit(core::mem::take(&mut self.lit)));
		}
	}

	fn push(&mut self, p: WordPart) {
		self.flush();
		self.parts.push(p);
	}

	fn finish(mut self) -> Vec<WordPart> {
		self.flush();
		self.parts
	}

	const fn is_empty(&self) -> bool {
		self.parts.is_empty() && self.lit.is_empty()
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
const fn plain_word_byte(c: u8) -> bool {
	!matches!(
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
			| b';'
			| b'&'
			| b'|'
			| b' '
			| b'\t'
			| b'\n'
			| b'['
			| b']'
			| b'='
			| b'+'
			| b'}'
			| b'@'
			| b'*'
			| b'?'
			| b'!'
	)
}

impl<'s> Parser<'s> {
	/// Read one word token at the cursor (bash `read_token_word`).
	/// `acceptable`: an assignment may start here.
	pub(super) fn read_word(&mut self, acceptable: bool) -> PResult<WordTok> {
		let lo = self.off();
		let mut acc = Acc::new();
		let mut quoted = false;
		let mut scan = if self.lx.compassign {
			Scan::No
		} else {
			Scan::Start
		};
		let mut split: Option<Box<AsgSplit>> = None;
		let mut sub: Option<(usize, usize, Span)> = None;
		let compassign = self.lx.compassign;
		let mut first = true;
		loop {
			// Fast path: a run of ordinary bytes in the current buffer.
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
							acc.push(WordPart::Escaped(bytes));
						},
					}
				},
				b'}'
					if self.lx.funsubst
						&& first
						&& acc.is_empty()
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
					let part = self.quoted_part(c, false)?;
					acc.push(part);
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
						if matches!(part, WordPart::AnsiC(_) | WordPart::Locale(_)) {
							quoted = true;
						}
						acc.push(part);
					} else {
						self.bump();
						acc.lit.push(b'$');
					}
				},
				b'<' | b'>' if self.peek_at(1) == Some(b'(') => {
					if !matches!(scan, Scan::Found | Scan::LitSub(_)) {
						scan = Scan::No;
					}
					let part = self.procsub(c == b'>')?;
					acc.push(part);
				},
				b'['
					if (scan == Scan::Name && acceptable) || (compassign && first && acc.is_empty()) =>
				{
					// Subscript of an assignment (`a[i]=`) or of a compound
					// array element (`[k]=v`), read as a group.
					let sub_lo = self.off();
					self.bump();
					acc.lit.push(b'[');
					acc.flush();
					let start = acc.parts.len();
					let inner = self.parts_until(Stop::Bracket)?;
					let inner_hi = self.off();
					acc.parts.extend(inner);
					let end = acc.parts.len();
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
							Vec::new()
						} else {
							match acc.parts.first() {
								Some(WordPart::Lit(s)) if sub.is_some() => s[..s.len() - 1].to_vec(),
								_ => {
									let n = acc.lit.len() - 1 - usize::from(append);
									acc.lit[..n].to_vec()
								},
							}
						};
						acc.flush();
						let value_at = acc.parts.len();
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
					let bytes = self.take_char(c);
					acc.lit.extend_from_slice(&bytes);
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
		let parts = acc.finish();
		Ok(WordTok { lo, hi, parts, quoted, asg: split })
	}

	/// Consume one (UTF-8) character at the cursor and return its bytes.
	fn take_char(&mut self, c: u8) -> Vec<u8> {
		if self.feat.multibyte() {
			// The bytes after the first are part of the character whatever
			// they look like.
			let n = self.feat.char_len(c, self.peek_at(1).unwrap_or(0));
			let mut out = Vec::with_capacity(n);
			for _ in 0..n {
				let Some(d) = self.peek() else { break };
				out.push(d);
				self.bump();
			}
			return out;
		}
		let n = char_len(c);
		let mut out = Vec::with_capacity(n);
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
	fn quoted_part(&mut self, c: u8, dq: bool) -> PResult<WordPart> {
		let line = self.bash_line();
		match c {
			b'\'' if !dq => {
				self.bump();
				let mut s = Vec::new();
				loop {
					let buf: &'s [u8] = self.buf;
					let rest = buf.get(self.pos..).unwrap_or_default();
					if let Some(n) = rest.iter().position(|&c| c == b'\'') {
						s.extend_from_slice(&rest[..n]);
						self.advance_lines(n);
						self.bump();
						return Ok(WordPart::SQuote(s));
					}
					s.extend_from_slice(rest);
					self.advance_lines(rest.len());
					match self.peek() {
						None => return Err(unmatched_error(self.eof_span(), line, "'")),
						Some(b'\'') => {
							self.bump();
							return Ok(WordPart::SQuote(s));
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
				Ok(WordPart::DQuote(parts))
			},
			_ => self.backquote(line, dq),
		}
	}

	/// Consume a run of name characters (`[A-Za-z0-9_]`).
	fn take_name(&mut self) -> Vec<u8> {
		let mut name = Vec::new();
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
	fn backquote(&mut self, line: u32, dq: bool) -> PResult<WordPart> {
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
					let bytes = self.take_char(c);
					text.extend_from_slice(&bytes);
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
		let body = super::sub_parse_list(&code, self.feat, text_lo).unwrap_or_default();
		Ok(WordPart::Comsub(Box::new(Comsub { kind: ComsubKind::Backtick, body, text })))
	}

	/// Parts up to the terminator of `stop`.
	pub(super) fn parts_until(&mut self, stop: Stop) -> PResult<Vec<WordPart>> {
		let line = self.bash_line();
		self.parts_until_line(stop, line)
	}

	fn parts_until_line(&mut self, stop: Stop, line: u32) -> PResult<Vec<WordPart>> {
		let mut acc = Acc::new();
		self.parts_into(&mut acc, stop, line)?;
		Ok(acc.finish())
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
					acc.push(WordPart::DroppedQuote);
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
								acc.push(WordPart::Escaped(bytes));
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
					let part = self.quoted_part(c, false)?;
					acc.push(part);
				},
				b'"'
					if stop != Stop::Text(TextMode::HereDoc)
						&& stop != Stop::Text(TextMode::DoubleQuote) =>
				{
					if stop == Stop::Text(TextMode::Arith) {
						// Arithmetic: double quotes are removed.
						self.bump();
						let inner = self.parts_until_line(Stop::DQuote { all: false }, line)?;
						for p in inner {
							acc.push(p);
						}
					} else if matches!(stop, Stop::Brace { dq: true, pat: false, .. }) {
						// `"${v:+x="\p"}"`: every backslash in these quotes quotes.
						self.bump();
						let inner =
							self.parts_until_line(Stop::DQuote { all: true }, self.bash_line())?;
						acc.push(WordPart::DQuote(inner));
					} else {
						let part = self.quoted_part(c, true)?;
						acc.push(part);
					}
				},
				b'`' => {
					let part = self.quoted_part(c, dq)?;
					acc.push(part);
				},
				b'$' => {
					if lit_sq
						&& self.peek_at(1) == Some(b'(')
						&& self.peek_at(2) != Some(b'(')
						&& let Some(part) = self.bad_comsub()
					{
						// The text ran to the `}` ending the word.
						acc.push(part);
						lit_sq = false;
						continue;
					}
					let ansi_ok = !matches!(
						stop,
						Stop::DQuote { .. } | Stop::Text(_) | Stop::Brace { doc: true, pat: false, .. }
					);
					if let Some(part) = self.dollar(stop, !ansi_ok)? {
						acc.push(part);
					} else {
						self.bump();
						acc.lit.push(b'$');
					}
				},
				b'<' | b'>' if !dq && self.peek_at(1) == Some(b'(') => {
					let part = self.procsub(c == b'>')?;
					acc.push(part);
				},
				_ => {
					let bytes = self.take_char(c);
					acc.lit.extend_from_slice(&bytes);
				},
			}
		}
	}

	/// A `$` expansion at the cursor; `None` when the `$` is literal.
	/// `no_quotes`: `$'` and `$"` are not special (inside `"…"`).
	pub(super) fn dollar(&mut self, ctx: Stop, no_quotes: bool) -> PResult<Option<WordPart>> {
		let Some(c) = self.peek_at(1) else {
			return Ok(None);
		};
		let dq = ctx.in_dq();
		let doc = matches!(ctx, Stop::Text(TextMode::HereDoc) | Stop::Brace { doc: true, .. });
		let param = |name: ParamName| {
			Some(WordPart::Param(Box::new(Param {
				name,
				index: None,
				op: ParamOp::None,
				braced: false,
				indirect: false,
			})))
		};
		match c {
			_ if is_name_start(c) => {
				self.bump();
				let name = self.take_name();
				Ok(param(ParamName::Var(name)))
			},
			b'0'..=b'9' => {
				self.bump();
				self.bump();
				Ok(param(ParamName::Positional(u32::from(c - b'0'))))
			},
			_ if special_dollar(c).is_some() => {
				self.bump();
				self.bump();
				Ok(param(ParamName::Special(special_dollar(c).expect("checked"))))
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
				Ok(Some(WordPart::Arith(ArithText { span: Span::new(lo, hi), src, bracket: true })))
			},
			b'\'' if !no_quotes => {
				self.bump();
				let line = self.bash_line();
				self.bump();
				let mut raw = Vec::new();
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
				Ok(Some(WordPart::AnsiC(raw)))
			},
			b'"' if !no_quotes => {
				self.bump();
				let line = self.bash_line();
				self.bump();
				let parts = self.parts_until_line(Stop::DQuote { all: false }, line)?;
				Ok(Some(WordPart::Locale(parts)))
			},
			_ => Ok(None),
		}
	}

	/// `$((` seen (cursor at the second `(`): arithmetic when the text closes
	/// with `))`, otherwise a command substitution of a subshell.
	fn dollar_dparen(&mut self) -> PResult<WordPart> {
		let lo = self.off();
		let line = self.bash_line();
		let text = self.raw_arith(b'(', b')', line)?;
		let hi = self.off() - 1;
		// text is `(…)…` without the final `)`.
		if let Some(inner) = arith_inner(&text) {
			return Ok(WordPart::Arith(ArithText {
				span:    Span::new(lo + 1, hi.saturating_sub(1)),
				src:     inner.to_vec(),
				bracket: false,
			}));
		}
		let body = super::sub_parse_list(&text, self.feat, lo).unwrap_or_default();
		Ok(WordPart::Comsub(Box::new(Comsub { kind: ComsubKind::Dollar, body, text })))
	}

	/// `$(` seen: parse the command substitution.
	fn dollar_paren(&mut self) -> PResult<WordPart> {
		let (body, text) = self.comsub(b')', false)?;
		Ok(WordPart::Comsub(Box::new(Comsub { kind: ComsubKind::Dollar, body, text })))
	}

	/// `${ ` / `${|` seen: a nofork command substitution.
	fn funsub(&mut self, value: bool) -> PResult<WordPart> {
		let (body, text) = self.comsub(b'}', value)?;
		let kind = if value {
			ComsubKind::ValueSub
		} else {
			ComsubKind::NoFork
		};
		Ok(WordPart::Comsub(Box::new(Comsub { kind, body, text })))
	}

	/// `<(` / `>(` at the cursor.
	fn procsub(&mut self, output: bool) -> PResult<WordPart> {
		self.bump();
		self.bump();
		let (body, _) = self.comsub(b')', false)?;
		Ok(WordPart::ProcSub(Box::new(ProcSub { output, body })))
	}

	/// `"${a+'$('\'}"`: between the literal quotes of a `${…}` word inside
	/// "…", bash parses a `$(` only when it expands the word, and over the
	/// text up to the end of the word. `Some` when that text does not parse:
	/// the part keeps the error for expansion time and the cursor moves to
	/// the `}` ending the word.
	fn bad_comsub(&mut self) -> Option<WordPart> {
		let buf: &'s [u8] = self.buf;
		let rest = buf.get(self.pos..).unwrap_or_default();
		let len = word_end_in_quote(rest)?;
		let text = &rest[..len];
		let mut sub = Parser::new(&text[2..], self.feat, crate::bash::syntax::NO_ALIASES);
		let e = sub.comsub(b')', false).err()?;
		let part = BadComsub { text: text.to_vec(), line: e.line, msg: e.bash_msg() };
		self.advance_lines(len);
		Some(WordPart::BadComsub(Box::new(part)))
	}

	/// `${…}` at the cursor; `doc`: inside an unquoted here-document.
	fn braced_param(&mut self, dq: bool, doc: bool) -> PResult<WordPart> {
		let start = self.mark();
		let line = self.bash_line();
		self.bump();
		self.bump();
		match self.param_body(dq, doc, line)? {
			Some(p) => {
				if self.peek() == Some(b'}') {
					self.bump();
					return Ok(WordPart::Param(Box::new(p)));
				}
				self.bad_subst(start, line)
			},
			None => self.bad_subst(start, line),
		}
	}

	/// Skip to the `}` closing a `${` that bash rejects at expansion time and
	/// keep its text.
	fn bad_subst(&mut self, start: super::cursor::Mark<'s>, line: u32) -> PResult<WordPart> {
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
		Ok(WordPart::BadSubst(text))
	}

	/// The inside of `${…}` up to (not including) the closing `}`; `None`
	/// when bash would report a bad substitution.
	fn param_body(&mut self, dq: bool, doc: bool, line: u32) -> PResult<Option<Param>> {
		let mut p = Param {
			name:     ParamName::Special(Special::Count),
			index:    None,
			op:       ParamOp::None,
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
			if let Some(WordPart::AnsiC(raw)) = self.dollar(Stop::Group, false)? {
				let name = crate::bash::syntax::util::ansi_decode(&raw);
				if crate::bash::syntax::util::is_identifier(&name)
					&& !self.peek().is_some_and(|c| is_name_char(c) || c == b'[')
				{
					p.name = ParamName::Var(name);
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
				p.op = ParamOp::Length;
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
				p.name = ParamName::Var(name);
				p.op = ParamOp::PrefixNames { star };
				return Ok(Some(p));
			}
			match self.param_name()? {
				Some((name, index)) => {
					p.name = name;
					p.index = index;
					if self.peek() == Some(b'}') {
						p.op = ParamOp::Indirect;
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
				if name == ParamName::Special(Special::Count)
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
	fn param_name(&mut self) -> PResult<Option<(ParamName, Option<Subscript>)>> {
		let Some(c) = self.peek() else {
			return Ok(None);
		};
		let name = if is_name_start(c) {
			ParamName::Var(self.take_name())
		} else if c.is_ascii_digit() {
			let mut n = 0u32;
			while let Some(d) = self.peek()
				&& d.is_ascii_digit()
			{
				n = n.saturating_mul(10).saturating_add(u32::from(d - b'0'));
				self.bump();
			}
			ParamName::Positional(n)
		} else if let Some(s) = special_dollar(c) {
			self.bump();
			ParamName::Special(s)
		} else {
			return Ok(None);
		};
		let mut index = None;
		if matches!(name, ParamName::Var(_)) && self.peek() == Some(b'[') {
			let lo = self.off();
			self.bump();
			let at = self.peek();
			if matches!(at, Some(b'@' | b'*')) && self.peek_at(1) == Some(b']') {
				self.bump();
				self.bump();
				index = Some(if at == Some(b'@') {
					Subscript::At
				} else {
					Subscript::Star
				});
			} else {
				let parts = self.parts_until(Stop::Bracket)?;
				let hi = self.off();
				if self.peek() != Some(b']') {
					return Ok(None);
				}
				self.bump();
				index = Some(Subscript::Expr(Word {
					id:    NodeId(0),
					span:  Span::new(lo + 1, hi),
					parts: merge_lits(parts),
				}));
			}
		}
		Ok(Some((name, index)))
	}

	/// The operator after the parameter name, up to the closing `}`.
	fn param_op(&mut self, mut p: Param, dq: bool, doc: bool, line: u32) -> PResult<Option<Param>> {
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
					p.op = word_op(op, true, w);
				} else {
					let (offset, len) = self.substr(line)?;
					p.op = ParamOp::Substr { offset, len };
				}
			},
			b'-' | b'=' | b'?' | b'+' => {
				self.bump();
				let w = self.op_word(brace)?;
				p.op = word_op(c, false, w);
			},
			b'#' | b'%' => {
				self.bump();
				let longest = self.peek() == Some(c);
				if longest {
					self.bump();
				}
				let pat = self.op_word(Stop::Brace { dq, slash: false, pat: true, doc })?;
				p.op = ParamOp::Trim { suffix: c == b'%', longest, pat };
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
				let mut pat = self.op_word(Stop::Brace { dq, slash: true, pat: true, doc })?;
				if lead {
					let mut parts = vec![WordPart::Lit(b"/".to_vec())];
					parts.append(&mut pat.parts);
					pat.parts = merge_lits(parts);
					pat.span = Span::new(lo, pat.span.hi);
				}
				let rep = if self.peek() == Some(b'/') {
					self.bump();
					Some(self.op_word(Stop::Brace { dq, slash: false, pat: true, doc })?)
				} else {
					None
				};
				p.op = ParamOp::Replace { mode, pat, rep };
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
				let pat = if w.parts.is_empty() { None } else { Some(w) };
				p.op = ParamOp::Case { mode, all, pat };
			},
			b'@' => {
				self.bump();
				match (self.peek(), self.peek_at(1)) {
					(
						Some(op @ (b'Q' | b'E' | b'P' | b'A' | b'a' | b'K' | b'k' | b'U' | b'u' | b'L')),
						Some(b'}'),
					) => {
						self.bump();
						p.op = ParamOp::Transform(op);
					},
					_ => return Ok(None),
				}
			},
			_ => return Ok(None),
		}
		Ok(Some(p))
	}

	/// An operator word inside `${…}`.
	fn op_word(&mut self, stop: Stop) -> PResult<Word> {
		let lo = self.off();
		let parts = self.parts_until(stop)?;
		let hi = self.off();
		Ok(Word { id: NodeId(0), span: Span::new(lo, hi), parts })
	}

	/// `${x:off[:len]}` after the `:`: arithmetic texts.
	fn substr(&mut self, line: u32) -> PResult<(ArithText, Option<ArithText>)> {
		let lo = self.off();
		let (off, at_colon) = self.raw_until_colon(line)?;
		let hi = self.off();
		let offset = ArithText { span: Span::new(lo, hi), src: off, bracket: false };
		if !at_colon {
			return Ok((offset, None));
		}
		self.bump();
		let lo2 = self.off();
		let (len, _) = self.raw_until_colon(line)?;
		let hi2 = self.off();
		Ok((offset, Some(ArithText { span: Span::new(lo2, hi2), src: len, bracket: false })))
	}

	/// Read one word in `mode` until end of input ([`parse_text`]).
	pub(super) fn text_word(&mut self, mode: TextMode) -> PResult<Word> {
		self.lx.extglob = false;
		let lo = self.off();
		let parts = self.parts_until(Stop::Text(mode))?;
		let hi = self.off();
		let mut w = empty_word(lo, hi);
		w.parts = merge_lits(parts);
		Ok(w)
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

fn word_op(op: u8, colon: bool, word: Word) -> ParamOp {
	match op {
		b'-' => ParamOp::Default { colon, word },
		b'=' => ParamOp::Assign { colon, word },
		b'?' => ParamOp::Error {
			colon,
			word: if word.parts.is_empty() {
				None
			} else {
				Some(word)
			},
		},
		_ => ParamOp::Alt { colon, word },
	}
}
