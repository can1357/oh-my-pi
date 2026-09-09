//! Shared tolerant lexer: token-level primitives that the strict
//! [`Deserializer`](crate::slopjson::Deserializer), the streaming partial
//! builder ([`parse_streaming`](crate::slopjson::parse_streaming)), and the
//! incoming cursors are built on. [`Mode`] selects how truncation and unescaped
//! inner double quotes are treated.
//!
//! The grammar is a forgiving superset of JSON covering malformations commonly
//! produced by language models:
//!
//! - single-quoted strings and unquoted object keys (JSON5);
//! - trailing / stray commas, and `//` + block comments;
//! - Python literals `True` / `False` / `None`, plus `0x` / `0b` numeric
//!   literals;
//! - raw control characters and invalid `\x` escapes inside strings (kept
//!   literally);
//! - unescaped quotes inside strings — a single quote only closes a string when
//!   followed by a value terminator, recovering apostrophes such as `'it's'`;
//!   the same recovery applies to double quotes in [`Mode::Streaming`] only,
//!   everywhere else they close strictly;
//! - unquoted string values in value position (strict mode only) — an
//!   unrecognized bareword such as `{"paths": packages/foo/*}` is recovered as
//!   a string up to the next `,` / `}` / `]` / newline.

use std::{mem, ops, ops::Range};

use smallvec::SmallVec;

use crate::{
	CowStr, IntoStr, Str, StrMut,
	slopjson::{
		PullPathSegment,
		error::ParseError,
		hex4, is_whitespace,
		value::{Number, Value},
	},
};

/// One component of the JSON path at which a tolerance was applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RepairPathSegment {
	/// Object member name.
	Key(Str),
	/// Array element index.
	Index(usize),
}

/// Exact tolerant-parser branch that accepted non-standard JSON.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepairKind {
	/// A line or block comment was ignored.
	Comment,
	/// A string used single rather than double quotes.
	SingleQuotedString,
	/// An object key was not quoted.
	UnquotedKey,
	/// A Python-spelled literal was accepted.
	PythonLiteral,
	/// An extra comma was ignored between container entries.
	StrayComma,
	/// A comma immediately before a container close was ignored.
	TrailingComma,
	/// A string escape was not part of the JSON escape vocabulary.
	InvalidEscape,
	/// A raw control character occurred inside a string.
	RawControlCharacter,
	/// A hexadecimal or binary integer literal was accepted.
	RadixNumber,
	/// A number used a relaxed spelling such as a leading plus or bare dot.
	RelaxedNumber,
	/// An unquoted bareword was recovered as a string value.
	BarewordValue,
	/// Streaming display recovery treated an unescaped quote as content.
	InnerQuote,
}

/// One lossless record of a tolerant syntax branch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Repair {
	/// Raw half-open byte range in the source document.
	pub span:   Range<usize>,
	/// JSON path being parsed when the tolerance fired.
	pub path:   SmallVec<RepairPathSegment, 4>,
	/// Exact tolerant branch that fired.
	pub kind:   RepairKind,
	/// Original source spelling covered by `span`.
	pub before: Str,
	/// Canonical spelling or replacement.
	pub after:  Str,
}

/// Compact append-only parser repair record.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RepairLog(SmallVec<Repair, 4>);

impl RepairLog {
	/// Empty repair record.
	pub const fn new() -> Self {
		Self(SmallVec::new())
	}

	/// Number of recorded repairs.
	pub const fn len(&self) -> usize {
		self.0.len()
	}

	/// Whether no tolerance branch fired.
	pub const fn is_empty(&self) -> bool {
		self.0.is_empty()
	}

	/// Borrow repairs in source order.
	pub fn as_slice(&self) -> &[Repair] {
		&self.0
	}

	pub(crate) fn append_unique(&mut self, mut other: Self, _path: &[PullPathSegment]) {
		for repair in other.0.drain(..) {
			if !self.0.contains(&repair) {
				self.0.push(repair);
			}
		}
		self.0.sort_by_key(|repair| repair.span.start);
	}
}

impl ops::Deref for RepairLog {
	type Target = [Repair];

	fn deref(&self) -> &Self::Target {
		self.as_slice()
	}
}

/// Maximum container nesting before the parser refuses (strict) or rolls
/// back to the last valid prefix (partial).
pub const MAX_DEPTH: u32 = 128;

/// A keyword literal: standard JSON plus Python `True`/`False`/`None`.
#[derive(Clone, Copy)]
pub enum Atom {
	Bool(bool),
	Null,
}

/// Decoded state of a string token at the current streaming edge.
pub struct StringProgress<'a> {
	pub(crate) value:      CowStr<'a>,
	pub(crate) stable_len: usize,
	pub(crate) complete:   bool,
}

/// Reading of the lookahead past a candidate closing quote.
enum QuoteLook {
	/// A value terminator (or final end of input) follows: the quote closes.
	Closes,
	/// Ordinary content follows: the quote is literal (inner-quote recovery).
	Inner,
	/// The lookahead ends on a lone `/` at the buffer edge, which may still
	/// grow into a comment and flip this quote from inner to closing.
	Undecided,
}

impl From<Atom> for Value {
	fn from(atom: Atom) -> Self {
		match atom {
			Atom::Bool(b) => Self::Bool(b),
			Atom::Null => Self::Null,
		}
	}
}

const KEYWORDS: [(&str, Atom); 6] = [
	("true", Atom::Bool(true)),
	("false", Atom::Bool(false)),
	("null", Atom::Null),
	("True", Atom::Bool(true)),
	("False", Atom::Bool(false)),
	("None", Atom::Null),
];

const fn is_ident_char(b: u8) -> bool {
	b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// Index of the first byte at or after `i` that is not whitespace or part of
/// a `//` line / `/* */` block comment.
fn skip_insignificant(s: &[u8], mut i: usize) -> usize {
	let n = s.len();
	loop {
		while i < n && is_whitespace(s[i]) {
			i += 1;
		}
		if i + 1 < n && s[i] == b'/' {
			match s[i + 1] {
				b'/' => {
					i += 2;
					while i < n && s[i] != b'\n' {
						i += 1;
					}
					continue;
				},
				b'*' => {
					i += 2;
					while i + 1 < n && !(s[i] == b'*' && s[i + 1] == b'/') {
						i += 1;
					}
					i = (i + 2).min(n);
					continue;
				},
				_ => {},
			}
		}
		return i;
	}
}

/// Grammar tolerance selected by the parser's consumer.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
	/// Final parse: complete input required, double quotes close strictly.
	Strict,
	/// Mid-stream snapshot ([`crate::slopjson::parse_streaming`]): incomplete
	/// tokens tolerated and unescaped inner double quotes recovered for
	/// display.
	Streaming,
	/// Incoming typed pulls: incomplete tokens tolerated, but double quotes
	/// close strictly so pulled values match the final parse.
	Incoming,
}

impl Mode {
	/// Truncated tokens roll back or report progress instead of erroring.
	const fn incomplete_ok(self) -> bool {
		!matches!(self, Self::Strict)
	}

	/// An unescaped inner `"` is recovered as literal string content.
	const fn dq_recovery(self) -> bool {
		matches!(self, Self::Streaming)
	}
}

/// Cursor over the input with the tolerant token readers; [`Mode`] selects
/// how truncation and unescaped inner double quotes are treated.
pub struct Parser<'a> {
	src:             &'a str,
	s:               &'a [u8],
	i:               usize,
	mode:            Mode,
	repairs:         RepairLog,
	repair_path:     SmallVec<RepairPathSegment, 4>,
	track_structure: bool,
}

impl<'a> Parser<'a> {
	pub(crate) const fn new(src: &'a str, mode: Mode) -> Self {
		Self {
			src,
			s: src.as_bytes(),
			i: 0,
			mode,
			repairs: RepairLog::new(),
			repair_path: SmallVec::new(),
			track_structure: false,
		}
	}

	pub(crate) const fn resume(src: &'a str, mode: Mode, offset: usize) -> Self {
		Self {
			src,
			s: src.as_bytes(),
			i: offset,
			mode,
			repairs: RepairLog::new(),
			repair_path: SmallVec::new(),
			track_structure: false,
		}
	}

	pub(crate) fn take_repairs(&mut self) -> RepairLog {
		mem::take(&mut self.repairs)
	}

	pub(crate) fn record_comma(&mut self, at: usize, trailing: bool) {
		self.record(
			at..at + 1,
			if trailing {
				RepairKind::TrailingComma
			} else {
				RepairKind::StrayComma
			},
			Str::default(),
		);
	}

	pub(crate) fn repairs(&self) -> &[Repair] {
		self.repairs.as_slice()
	}

	pub(crate) fn set_repair_path(&mut self, path: &[PullPathSegment]) {
		self.track_structure = path.is_empty();
		self.repair_path.clear();
		self
			.repair_path
			.extend(path.iter().filter_map(|segment| match segment {
				PullPathSegment::Key(key) => Some(RepairPathSegment::Key(key.clone())),
				PullPathSegment::Keys(keys) => keys.first().cloned().map(RepairPathSegment::Key),
				PullPathSegment::Index(index) => Some(RepairPathSegment::Index(*index)),
			}));
	}

	pub(crate) const fn tracks_structure(&self) -> bool {
		self.track_structure
	}

	pub(crate) fn push_repair_path(&mut self, segment: RepairPathSegment) {
		self.repair_path.push(segment);
	}

	pub(crate) fn pop_repair_path(&mut self) {
		self.repair_path.pop();
	}

	pub(crate) fn retarget_repairs_from(&mut self, start: usize, segment: RepairPathSegment) {
		for repair in self
			.repairs
			.0
			.iter_mut()
			.filter(|repair| repair.span.start >= start)
		{
			repair.path.push(segment.clone());
		}
	}

	fn record(&mut self, span: Range<usize>, kind: RepairKind, after: impl IntoStr) {
		let before = Str::new(&self.src[span.clone()]);
		self.repairs.0.push(Repair {
			span,
			path: self.repair_path.clone(),
			kind,
			before,
			after: after.into_str(),
		});
	}

	pub(crate) const fn pos(&self) -> usize {
		self.i
	}

	/// Source text from `start` to the current position.
	pub(crate) fn src_from(&self, start: usize) -> &'a str {
		&self.src[start..self.i]
	}

	pub(crate) const fn at_end(&self) -> bool {
		self.i >= self.s.len()
	}

	pub(crate) fn peek(&self) -> Option<u8> {
		self.s.get(self.i).copied()
	}

	pub(crate) const fn bump(&mut self) {
		self.i += 1;
	}

	/// Consume the rest of the input (partial-mode rollback of an
	/// unrecognized trailing token).
	pub(crate) const fn skip_to_end(&mut self) {
		self.i = self.s.len();
	}

	/// Skip whitespace plus `//` line and `/* */` block comments.
	pub(crate) fn ws(&mut self) {
		loop {
			while self.i < self.s.len() && is_whitespace(self.s[self.i]) {
				self.i += 1;
			}
			if self.i + 1 >= self.s.len() || self.s[self.i] != b'/' {
				return;
			}
			let start = self.i;
			let complete = match self.s[self.i + 1] {
				b'/' => {
					self.i += 2;
					while self.i < self.s.len() && self.s[self.i] != b'\n' {
						self.i += 1;
					}
					self.i < self.s.len() || self.mode == Mode::Strict
				},
				b'*' => {
					self.i += 2;
					while self.i + 1 < self.s.len()
						&& !(self.s[self.i] == b'*' && self.s[self.i + 1] == b'/')
					{
						self.i += 1;
					}
					let closed = self.i + 1 < self.s.len();
					self.i = if closed { self.i + 2 } else { self.s.len() };
					closed || self.mode == Mode::Strict
				},
				_ => return,
			};
			if complete {
				self.record(start..self.i, RepairKind::Comment, Str::default());
			}
		}
	}

	/// Read a string starting at the opening `quote`. Borrowed (zero-copy)
	/// when the literal needs no unescaping.
	pub(crate) fn string(&mut self, quote: u8) -> Result<CowStr<'a>, ParseError> {
		Ok(self.string_progress(quote)?.value)
	}

	/// Read a string and retain the information an incremental consumer needs.
	///
	/// `stable_len` excludes output whose meaning can change when more bytes
	/// arrive: a trailing split escape, or everything from a quote whose
	/// close/inner reading is still undecidable at the buffer edge. Complete
	/// parsers ignore it; the incoming cursor uses it to emit only chunks
	/// that are guaranteed prefixes of the final decoded string.
	pub(crate) fn string_progress(&mut self, quote: u8) -> Result<StringProgress<'a>, ParseError> {
		let s = self.s;
		let n = s.len();
		let mut i = self.i + 1; // skip opening quote
		let string_start = self.i;
		let mut out: Option<StrMut> = None;
		let mut run_start = i;
		let mut unstable_from = None;
		while i < n {
			let b = s[i];
			if b < 0x20 {
				match b {
					b'\n' => self.record(i..i + 1, RepairKind::RawControlCharacter, "\\n"),
					b'\r' => self.record(i..i + 1, RepairKind::RawControlCharacter, "\\r"),
					b'\t' => self.record(i..i + 1, RepairKind::RawControlCharacter, "\\t"),
					b'\x08' => self.record(i..i + 1, RepairKind::RawControlCharacter, "\\b"),
					b'\x0c' => self.record(i..i + 1, RepairKind::RawControlCharacter, "\\f"),
					_ => self.record(i..i + 1, RepairKind::RawControlCharacter, format!("\\u{b:04X}")),
				}
				i += 1;
				continue;
			}
			if b != b'\\' && b != quote {
				i += 1;
				continue;
			}
			if b == quote {
				// Apostrophe / inner-quote recovery (a quote that isn't followed by a
				// value terminator is literal) is always safe for single quotes; for
				// double quotes it is Streaming-only display leniency. Elsewhere
				// double quotes close on the first unescaped quote like standard
				// JSON, so malformed structure fails loudly instead of silently
				// swallowing commas/colons or sibling members.
				let look = if quote != b'\'' && !self.mode.dq_recovery() {
					QuoteLook::Closes
				} else {
					self.quote_lookahead(i + 1)
				};
				match look {
					QuoteLook::Closes => {
						self.i = i + 1;
						let value = finish(out, &self.src[run_start..i]);
						let stable_len = value.len();
						if quote == b'\'' {
							let after = Value::String(Str::new(value.as_str())).to_string();
							self.record(string_start..self.i, RepairKind::SingleQuotedString, after);
						}
						return Ok(StringProgress { value, stable_len, complete: true });
					},
					// A lone `/` at the buffer edge may grow into a comment, flipping
					// this quote from inner to closing — nothing from the quote on is
					// stable yet.
					QuoteLook::Undecided => {
						if unstable_from.is_none() {
							unstable_from = Some(out.as_ref().map_or(0, |o| o.len()) + (i - run_start));
						}
					},
					// Unescaped inner quote (e.g. apostrophe in `'it's'`) — literal.
					QuoteLook::Inner => {
						if quote == b'"' {
							self.record(i..i + 1, RepairKind::InnerQuote, "\\\"");
						}
					},
				}
				i += 1;
				continue;
			}
			// Backslash escape.
			let out = out.get_or_insert_default();
			out.push_str(&self.src[run_start..i]);
			let escape_output_start = out.len();
			i += 1;
			if i >= n {
				unstable_from = Some(escape_output_start);
				out.push('\\');
				run_start = i;
				break;
			}
			match s[i] {
				b'"' => out.push('"'),
				b'\'' => out.push('\''),
				b'\\' => out.push('\\'),
				b'/' => out.push('/'),
				b'b' => out.push('\u{0008}'),
				b'f' => out.push('\u{000C}'),
				b'n' => out.push('\n'),
				b'r' => out.push('\r'),
				b't' => out.push('\t'),
				b'u' => {
					if let Some(unit) = hex4(s, i + 1) {
						i += 4;
						if let Some(ch) = char::from_u32(unit) {
							out.push(ch);
						} else if (0xd800..0xdc00).contains(&unit)
							&& s.get(i + 1) == Some(&b'\\')
							&& s.get(i + 2) == Some(&b'u')
							&& let Some(low) = hex4(s, i + 3)
							&& (0xdc00..0xe000).contains(&low)
						{
							// Surrogate pair split across two \u escapes.
							let combined = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
							out.push(
								char::from_u32(combined)
									.expect("surrogate pair combines to a valid scalar"),
							);
							i += 6;
						} else {
							// A high surrogate at the streaming edge may acquire its low
							// surrogate in the next fragment, so do not emit it yet.
							if self.mode.incomplete_ok() && (0xd800..0xdc00).contains(&unit) && i + 7 > n {
								unstable_from = Some(escape_output_start);
							}
							// Lone surrogate: representable in a JS string, not in Rust.
							out.push('\u{FFFD}');
						}
					} else {
						if i + 5 > n {
							unstable_from = Some(escape_output_start);
						} else {
							self.record(i - 1..i + 1, RepairKind::InvalidEscape, "\\\\u");
						}
						out.push_str("\\u"); // invalid \u — keep literal
					}
				},
				_ => {
					// Invalid escape — keep the backslash and the escaped char literal.
					let ch = self.src[i..]
						.chars()
						.next()
						.expect("escape byte starts a char");
					self.record(i - 1..i + ch.len_utf8(), RepairKind::InvalidEscape, {
						let mut replacement = StrMut::from("\\\\");
						replacement.push(ch);
						replacement
					});
					out.push('\\');
					out.push(ch);
					i += ch.len_utf8() - 1;
				},
			}
			i += 1;
			run_start = i;
		}
		// Unterminated string: report progress when truncation is tolerated.
		if self.mode.incomplete_ok() {
			self.i = i;
			let value = finish(out, &self.src[run_start..n]);
			let stable_len = unstable_from.unwrap_or_else(|| value.len());
			return Ok(StringProgress { value, stable_len, complete: false });
		}

		Err(ParseError::UnterminatedString)
	}

	/// Classify the lookahead after a candidate closing quote: a quote closes
	/// a string only when the next significant char (past whitespace and
	/// comments) ends a value.
	fn quote_lookahead(&self, from: usize) -> QuoteLook {
		let k = skip_insignificant(self.s, from);
		match self.s.get(k) {
			None | Some(b',' | b'}' | b']' | b':') => QuoteLook::Closes,
			Some(b'/') if self.mode.incomplete_ok() && k + 1 == self.s.len() => QuoteLook::Undecided,
			Some(_) => QuoteLook::Inner,
		}
	}

	/// Read a numeric token. `Ok(None)` (lenient mode only) marks a malformed
	/// or truncated number the caller must roll back; strict mode errors.
	pub(crate) fn number(&mut self) -> Result<Option<Number>, ParseError> {
		let start = self.i;
		while self.i < self.s.len()
			&& matches!(
				self.s[self.i],
				b'0'..=b'9' | b'-' | b'+' | b'.' | b'x' | b'X' | b'a'..=b'f' | b'A'..=b'F'
			) {
			self.i += 1;
		}
		match parse_number_token(&self.src[start..self.i]) {
			Some(number) => {
				let raw = &self.src[start..self.i];
				let kind = if raw
					.as_bytes()
					.get(1)
					.is_some_and(|byte| matches!(byte, b'x' | b'X' | b'b' | b'B'))
					&& raw.starts_with('0')
				{
					Some(RepairKind::RadixNumber)
				} else if raw.starts_with('+') || raw.starts_with('.') || raw.ends_with('.') {
					Some(RepairKind::RelaxedNumber)
				} else {
					None
				};
				if let Some(kind) = kind {
					self.record(start..self.i, kind, number.to_string());
				}
				Ok(Some(number))
			},
			None if self.mode.incomplete_ok() => Ok(None),
			None => Err(ParseError::InvalidNumber(start)),
		}
	}

	/// Match a keyword literal at the cursor; consumes only on success.
	/// Requires a non-identifier boundary so `Truex` / `nullish` are not
	/// misread as the keyword followed by junk.
	pub(crate) fn match_keyword(&mut self) -> Option<Atom> {
		for (word, atom) in KEYWORDS {
			if self.s[self.i..].starts_with(word.as_bytes())
				&& !self
					.s
					.get(self.i + word.len())
					.copied()
					.is_some_and(is_ident_char)
			{
				let start = self.i;
				self.i += word.len();
				if word.as_bytes()[0].is_ascii_uppercase() {
					let after = match atom {
						Atom::Bool(true) => "true",
						Atom::Bool(false) => "false",
						Atom::Null => "null",
					};
					self.record(start..self.i, RepairKind::PythonLiteral, after);
				}
				return Some(atom);
			}
		}
		None
	}

	/// Consume a `null` / `None` literal if present (for `Option` fields).
	/// Never consumes on a non-null keyword such as `true`.
	pub(crate) fn eat_null(&mut self) -> bool {
		for word in ["null", "None"] {
			if self.s[self.i..].starts_with(word.as_bytes())
				&& !self
					.s
					.get(self.i + word.len())
					.copied()
					.is_some_and(is_ident_char)
			{
				let start = self.i;
				self.i += word.len();
				if word == "None" {
					self.record(start..self.i, RepairKind::PythonLiteral, "null");
				}
				return true;
			}
		}
		false
	}

	/// Read an unquoted object key: everything up to a structural delimiter
	/// or whitespace. May be empty.
	pub(crate) fn unquoted_key(&mut self) -> &'a str {
		let start = self.i;
		while self.i < self.s.len() {
			let b = self.s[self.i];
			if matches!(b, b':' | b',' | b'}') || is_whitespace(b) {
				break;
			}
			self.i += 1;
		}
		if self.i > start {
			let after = Value::String(Str::new(&self.src[start..self.i])).to_string();
			self.record(start..self.i, RepairKind::UnquotedKey, after);
		}
		&self.src[start..self.i]
	}

	/// Strict-mode recovery of an unquoted string value, e.g.
	/// `{"paths": packages/foo/*}`: consume until `,` / `}` / `]` / newline
	/// and trim trailing whitespace. Recovery still fails — so a final parse
	/// never accepts a half-formed or non-finite argument — when the token:
	/// - hits end-of-input before a delimiter (truncated value);
	/// - contains a `"`, `{`, `[`, or a key-like `:` — this parser accepts
	///   unquoted keys, so a missed comma (`{"a": foo "b": 1}`) would otherwise
	///   silently swallow the following field. A colon followed by `/` or `\`
	///   stays literal so URL and Windows-path values recover;
	/// - is a non-finite JS atom (`NaN` / `Infinity` / `undefined`).
	pub(crate) fn bareword(&mut self) -> Result<&'a str, ParseError> {
		let s = self.s;
		let start = self.i;
		let mut i = start;
		while i < s.len() {
			let b = s[i];
			if matches!(b, b',' | b'}' | b']' | b'\n' | b'\r') {
				break;
			}
			if b == b'"'
				|| b == b'{'
				|| b == b'['
				|| (b == b':' && !matches!(s.get(i + 1).copied(), Some(b'/' | b'\\')))
			{
				return Err(ParseError::UnexpectedToken(start));
			}
			i += 1;
		}
		if i >= s.len() {
			return Err(ParseError::UnexpectedToken(start));
		}
		let mut end = i;
		while end > start && is_whitespace(s[end - 1]) {
			end -= 1;
		}
		let word = &self.src[start..end];
		if matches!(word, "NaN" | "Infinity" | "-Infinity" | "+Infinity" | "undefined") {
			return Err(ParseError::UnexpectedToken(start));
		}
		self.i = i;
		let after = Value::String(Str::new(word)).to_string();
		self.record(start..end, RepairKind::BarewordValue, after);
		Ok(word)
	}
}

/// Assemble the final string: borrowed when nothing needed unescaping.
fn finish(owned: Option<StrMut>, tail: &str) -> CowStr<'_> {
	match owned {
		None => CowStr::Borrowed(tail),
		Some(mut out) => {
			out.push_str(tail);
			CowStr::Owned(out)
		},
	}
}

/// Parse a relaxed numeric token with JS `Number()` semantics: decimal
/// (optional sign, leading/trailing dot, exponent) plus unsigned `0x` hex and
/// `0b` binary. Integers that fit stay exact integers; everything else is
/// `f64`. `None` for malformed or non-finite tokens — unlike JS, an
/// overflow-to-infinity (`1e999`) is rejected rather than surfaced.
fn parse_number_token(token: &str) -> Option<Number> {
	let bytes = token.as_bytes();
	if bytes.len() > 2 && bytes[0] == b'0' && bytes[1] | 0x20 == b'x' {
		return parse_radix(&bytes[2..], 16);
	}
	if bytes.len() > 2 && bytes[0] == b'0' && bytes[1] | 0x20 == b'b' {
		return parse_radix(&bytes[2..], 2);
	}
	let signed = token.strip_prefix('+').unwrap_or(token);
	let digits = signed.strip_prefix('-').unwrap_or(signed);
	if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
		if signed.starts_with('-') {
			if let Ok(value) = signed.parse::<i64>() {
				return Some(Number::from(value));
			}
		} else if let Ok(value) = digits.parse::<u64>() {
			return Some(Number::from(value));
		}
		// Out-of-range integer: fall through to f64 like JS.
	}
	Number::from_f64(signed.parse::<f64>().ok()?)
}

/// Fold hex/binary digits into an integer, spilling to `f64` on overflow the
/// way JS `Number("0x…")` loses precision instead of failing.
fn parse_radix(digits: &[u8], radix: u32) -> Option<Number> {
	if digits.is_empty() {
		return None;
	}
	let mut int = 0u64;
	let mut float = 0f64;
	let mut overflowed = false;
	for &b in digits {
		let d = u64::from((b as char).to_digit(radix)?);
		if !overflowed {
			if let Some(v) = int
				.checked_mul(u64::from(radix))
				.and_then(|v| v.checked_add(d))
			{
				int = v;
				continue;
			}
			overflowed = true;
			float = int as f64;
		}
		float = float.mul_add(f64::from(radix), d as f64);
	}
	if overflowed {
		Number::from_f64(float)
	} else {
		Some(Number::from(int))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn streaming_inner_quote_repair_is_exact() {
		let source = r#""a"b""#;
		let mut parser = Parser::new(source, Mode::Streaming);
		let progress = parser.string_progress(b'"').unwrap();
		assert!(progress.complete);
		assert_eq!(progress.value.as_str(), "a\"b");
		let repairs = parser.take_repairs();
		assert_eq!(repairs.len(), 1);
		assert_eq!(repairs[0].kind, RepairKind::InnerQuote);
		assert_eq!(repairs[0].span, 2..3);
		assert_eq!(repairs[0].before.as_str(), "\"");
		assert_eq!(repairs[0].after.as_str(), "\\\"");
	}
}
