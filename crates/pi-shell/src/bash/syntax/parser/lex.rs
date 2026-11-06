//! Tokens: a port of bash's `read_token`, `special_case_tokens`, the
//! reserved-word check and alias expansion (`alias_expand_token`), plus
//! here-document gathering.

use alloc::{boxed::Box, vec::Vec};

use super::{
	PResult, ParseError, ParseErrorKind, Parser, PendingDoc,
	cursor::{self, Frame},
	word::WordTok,
};
use crate::bash::syntax::{
	ast::{AliasUse, ParseWarning},
	features::{AliasLookup, Features},
	span::Span,
	util::{ansi_quote, is_break, is_identifier, is_meta, push_u32, should_ansi_quote},
};

/// bash token codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum T {
	Word,
	Assign,
	Number,
	RedirWord,
	ArithCmd,
	ArithFor,
	CondCmd,
	DolParen,
	DolBrace,
	Newline,
	Eof,
	Semi,
	Amp,
	Bar,
	LParen,
	RParen,
	Lt,
	Gt,
	Dash,
	AndAnd,
	OrOr,
	GtGt,
	LtLt,
	LtAnd,
	GtAnd,
	SemiSemi,
	SemiAnd,
	SemiSemiAnd,
	LtLtDash,
	LtLtLt,
	AndGt,
	AndGtGt,
	LtGt,
	GtBar,
	BarAnd,
	If,
	Then,
	Else,
	Elif,
	Fi,
	Case,
	Esac,
	For,
	Select,
	While,
	Until,
	Do,
	Done,
	Function,
	Coproc,
	CondStart,
	CondEnd,
	In,
	Bang,
	Time,
	TimeOpt,
	TimeIgn,
	LBrace,
	RBrace,
}

impl T {
	/// Text bash prints for the token in error messages (`word_token_alist`
	/// and `other_token_alist`); empty for value tokens.
	pub const fn text(self) -> &'static [u8] {
		match self {
			Self::If => b"if",
			Self::Then => b"then",
			Self::Else => b"else",
			Self::Elif => b"elif",
			Self::Fi => b"fi",
			Self::Case => b"case",
			Self::Esac => b"esac",
			Self::For => b"for",
			Self::Select => b"select",
			Self::While => b"while",
			Self::Until => b"until",
			Self::Do => b"do",
			Self::Done => b"done",
			Self::In => b"in",
			Self::Function => b"function",
			Self::Time => b"time",
			Self::LBrace => b"{",
			Self::RBrace => b"}",
			Self::Bang => b"!",
			Self::CondStart => b"[[",
			Self::CondEnd => b"]]",
			Self::Coproc => b"coproc",
			Self::TimeIgn => b"--",
			Self::TimeOpt => b"-p",
			Self::AndAnd => b"&&",
			Self::OrOr => b"||",
			Self::GtGt => b">>",
			Self::LtLt => b"<<",
			Self::LtAnd => b"<&",
			Self::GtAnd => b">&",
			Self::SemiSemi => b";;",
			Self::SemiAnd => b";&",
			Self::SemiSemiAnd => b";;&",
			Self::LtLtDash => b"<<-",
			Self::LtLtLt => b"<<<",
			Self::AndGt => b"&>",
			Self::AndGtGt => b"&>>",
			Self::LtGt => b"<>",
			Self::GtBar => b">|",
			Self::BarAnd => b"|&",
			Self::Eof => b"EOF",
			Self::Gt => b">",
			Self::Lt => b"<",
			Self::Dash => b"-",
			Self::Semi => b";",
			Self::LParen => b"(",
			Self::RParen => b")",
			Self::Bar => b"|",
			Self::Amp => b"&",
			Self::Newline => b"newline",
			Self::Word
			| Self::Assign
			| Self::Number
			| Self::RedirWord
			| Self::ArithCmd
			| Self::ArithFor
			| Self::CondCmd
			| Self::DolParen
			| Self::DolBrace => b"",
		}
	}

	/// Tokens that begin a redirection.
	pub const fn is_redir_op(self) -> bool {
		matches!(
			self,
			Self::Lt
				| Self::Gt
				| Self::GtGt
				| Self::GtBar
				| Self::LtGt
				| Self::LtLt
				| Self::LtLtDash
				| Self::LtLtLt
				| Self::LtAnd
				| Self::GtAnd
				| Self::AndGt
				| Self::AndGtGt
		)
	}
}

/// Reserved words (`word_token_alist`).
const fn reserved(text: &[u8]) -> Option<T> {
	Some(match text {
		b"if" => T::If,
		b"then" => T::Then,
		b"else" => T::Else,
		b"elif" => T::Elif,
		b"fi" => T::Fi,
		b"case" => T::Case,
		b"esac" => T::Esac,
		b"for" => T::For,
		b"select" => T::Select,
		b"while" => T::While,
		b"until" => T::Until,
		b"do" => T::Do,
		b"done" => T::Done,
		b"in" => T::In,
		b"function" => T::Function,
		b"time" => T::Time,
		b"{" => T::LBrace,
		b"}" => T::RBrace,
		b"!" => T::Bang,
		b"[[" => T::CondStart,
		b"]]" => T::CondEnd,
		b"coproc" => T::Coproc,
		_ => return None,
	})
}

/// One token with its value.
pub(super) struct Tok {
	pub kind:  T,
	/// Source span.
	pub lo:    u32,
	pub hi:    u32,
	/// 1-based line of the first byte.
	pub line:  u32,
	/// Word value of `Word`, `Assign` and `RedirWord` (the name, as a plain
	/// word).
	pub word:  Option<WordTok>,
	/// `Number` value.
	pub num:   u32,
	/// Value of `ArithCmd` / `ArithFor`, absent from ordinary tokens.
	pub arith: Option<Box<ArithTok>>,
}

/// The uncommon arithmetic token payload, kept out of every word token.
pub(super) struct ArithTok {
	pub text:  Vec<u8>,
	pub semis: Vec<usize>,
	pub lo:    u32,
	pub hi:    u32,
}

impl Tok {
	pub(super) const fn new(kind: T, lo: u32, hi: u32, line: u32) -> Self {
		Self { kind, lo, hi, line, word: None, num: 0, arith: None }
	}

	pub(super) const fn span(&self) -> Span {
		Span::new(self.lo, self.hi)
	}
}

/// Lexer state: bash's token history and `parser_state` flags.
#[derive(Clone, Debug)]
pub(super) struct LexState {
	/// The token most recently returned (`current_token`).
	pub cur:           T,
	/// `last_read_token`.
	pub last:          T,
	/// `token_before_that`.
	pub before:        T,
	pub casepat:       bool,
	pub casestmt:      bool,
	pub condcmd:       bool,
	pub condexpr:      bool,
	pub regexp:        bool,
	pub extpat:        bool,
	pub alexpnext:     bool,
	pub assignok:      bool,
	pub cmdbltin:      bool,
	pub allowopnbrc:   bool,
	pub redirlist:     bool,
	pub compassign:    bool,
	pub funsubst:      bool,
	/// `shell_eof_token` inside a command substitution: `)` or `}`.
	pub eof_token:     u8,
	pub esacs:         u32,
	pub expect_in:     u32,
	pub expect_in_cmd: Option<T>,
	pub open_brace:    u32,
	/// `extglob` in effect (forced on for `[[ … == pat ]]`).
	pub extglob:       bool,
}

impl LexState {
	pub(super) const fn new() -> Self {
		Self {
			cur:           T::Newline,
			last:          T::Newline,
			before:        T::Newline,
			casepat:       false,
			casestmt:      false,
			condcmd:       false,
			condexpr:      false,
			regexp:        false,
			extpat:        false,
			alexpnext:     false,
			assignok:      false,
			cmdbltin:      false,
			allowopnbrc:   false,
			redirlist:     false,
			compassign:    false,
			funsubst:      false,
			eof_token:     0,
			esacs:         0,
			expect_in:     0,
			expect_in_cmd: None,
			open_brace:    0,
			extglob:       false,
		}
	}
}

/// Builtins whose arguments may be assignments (`declare a=(1 2)`).
const fn assignment_builtin(word: &[u8]) -> bool {
	matches!(
		word,
		b"alias" | b"declare" | b"export" | b"local" | b"readonly" | b"typeset" | b"eval" | b"let"
	)
}

/// Whether bash's `assignment()` accepts `s` (a function name that looks
/// like an assignment is printed with the `function` keyword).
pub fn looks_like_assignment(s: &[u8]) -> bool {
	let Some((&c, _)) = s.split_first() else {
		return false;
	};
	if !crate::bash::syntax::util::is_name_start(c) {
		return false;
	}
	let mut i = 0;
	while i < s.len() {
		let c = s[i];
		match c {
			b'=' => return true,
			b'[' => {
				let mut depth = 0usize;
				while i < s.len() {
					match s[i] {
						b'[' => depth += 1,
						b']' => {
							depth -= 1;
							if depth == 0 {
								break;
							}
						},
						_ => {},
					}
					i += 1;
				}
				return s.get(i + 1) == Some(&b'=')
					|| (s.get(i + 1) == Some(&b'+') && s.get(i + 2) == Some(&b'='));
			},
			b'+' if s.get(i + 1) == Some(&b'=') => return true,
			_ if crate::bash::syntax::util::is_name_char(c) => {},
			_ => return false,
		}
		i += 1;
	}
	false
}

impl<'s> Parser<'s> {
	/// Reset the lexer for a new top-level command.
	pub(super) fn reset_lexer(&mut self) {
		self.lx = LexState::new();
		self.lx.extglob = self.feat.contains(Features::EXTGLOB);
		self.la = None;
	}

	/// `yylex`: shift the token history and read a token.
	pub(super) fn lex(&mut self) -> PResult<Tok> {
		self.lx.before = self.lx.last;
		self.lx.last = self.lx.cur;
		let t = self.read_token()?;
		self.lx.cur = t.kind;
		Ok(t)
	}

	/// The lookahead token.
	pub(super) fn peek_tok(&mut self) -> PResult<&Tok> {
		if self.la.is_none() {
			let t = self.lex()?;
			self.la = Some(t);
		}
		Ok(self.la.as_ref().expect("lookahead was just filled"))
	}

	/// Kind of the lookahead token.
	pub(super) fn peek_kind(&mut self) -> PResult<T> {
		Ok(self.peek_tok()?.kind)
	}

	/// Consume the lookahead token (reading one if needed).
	pub(super) fn take(&mut self) -> PResult<Tok> {
		let t = match self.la.take() {
			Some(t) => t,
			None => self.lex()?,
		};
		self.last_hi = t.hi;
		Ok(t)
	}

	/// Skip newline tokens (`newline_list`).
	pub(super) fn skip_newlines(&mut self) -> PResult<()> {
		while self.peek_kind()? == T::Newline {
			self.take()?;
		}
		Ok(())
	}

	/// bash `reserved_word_acceptable`.
	pub(super) fn reserved_word_acceptable(&self, t: T) -> bool {
		match t {
			T::Newline
			| T::Semi
			| T::LParen
			| T::RParen
			| T::Bar
			| T::Amp
			| T::LBrace
			| T::RBrace
			| T::AndAnd
			| T::ArithCmd
			| T::Bang
			| T::BarAnd
			| T::CondEnd
			| T::Do
			| T::Done
			| T::Elif
			| T::Else
			| T::Esac
			| T::Fi
			| T::If
			| T::OrOr
			| T::SemiSemi
			| T::SemiAnd
			| T::SemiSemiAnd
			| T::Then
			| T::Time
			| T::TimeOpt
			| T::TimeIgn
			| T::Coproc
			| T::Until
			| T::While
			| T::DolParen
			| T::DolBrace => true,
			_ => self.lx.last == T::Word && matches!(self.lx.before, T::Coproc | T::Function),
		}
	}

	/// bash `command_token_position`.
	pub(super) fn command_token_position(&self, t: T) -> bool {
		t == T::Assign
			|| (self.lx.redirlist && !t.is_redir_op())
			|| (!matches!(t, T::SemiSemi | T::SemiAnd | T::SemiSemiAnd)
				&& self.reserved_word_acceptable(t))
	}

	/// bash `assignment_acceptable`.
	pub(super) fn assignment_acceptable(&self) -> bool {
		self.command_token_position(self.lx.last) && !self.lx.casepat
	}

	/// bash `time_command_acceptable`.
	fn time_command_acceptable(&self) -> bool {
		if self.feat.contains(Features::POSIX) {
			let buf: &'s [u8] = self.buf;
			let rest = buf.get(self.pos..).unwrap_or_default();
			if rest.iter().find(|&&c| c != b' ' && c != b'\t') == Some(&b'-') {
				return false;
			}
		}
		match self.lx.last {
			T::Newline | T::Semi => self.lx.before != T::Bar,
			T::AndAnd
			| T::OrOr
			| T::Amp
			| T::While
			| T::Do
			| T::Until
			| T::If
			| T::Then
			| T::Elif
			| T::Else
			| T::LBrace
			| T::LParen
			| T::RParen
			| T::Bang
			| T::Time
			| T::TimeOpt
			| T::TimeIgn
			| T::DolParen
			| T::DolBrace => true,
			_ => false,
		}
	}

	/// Record an open compound command for end-of-input messages (bash
	/// `set_compoundcmd_top`).
	pub(super) fn open_compound(&mut self, t: T, line: u32) {
		if matches!(
			t,
			T::Case
				| T::Select
				| T::For
				| T::If
				| T::While
				| T::Until
				| T::LBrace
				| T::LParen
				| T::CondStart
		) {
			self.compound.push((t, line));
		}
	}

	pub(super) fn close_compound(&mut self) {
		self.compound.pop();
	}

	/// `read_token`.
	pub(super) fn read_token(&mut self) -> PResult<Tok> {
		loop {
			self.skip_blanks();
			let lo = self.off();
			let line = self.line;
			let Some(mut c) = self.peek() else {
				return Ok(Tok::new(T::Eof, lo, lo, line));
			};
			if c == b'#' {
				self.skip_comment();
				match self.peek() {
					None => return Ok(Tok::new(T::Eof, lo, lo, line)),
					Some(n) => c = n,
				}
			}
			if c == b'\n' {
				let nlo = self.off();
				self.bump();
				if !self.pending.is_empty() {
					self.gather();
				}
				self.lx.alexpnext = false;
				self.lx.assignok = false;
				self.lx.cmdbltin = false;
				return Ok(Tok::new(T::Newline, nlo, nlo + 1, line));
			}
			if self.lx.regexp {
				if let Some(t) = self.read_word_token(lo, line)? {
					return Ok(t);
				}
				continue;
			}
			if is_meta(c) {
				if let Some(t) = self.read_operator(c, lo, line)? {
					return Ok(t);
				}
				// A `<(` / `>(` process substitution starts a word.
				if let Some(t) = self.read_word_token(lo, line)? {
					return Ok(t);
				}
				continue;
			}
			if c == b'-' && matches!(self.lx.last, T::LtAnd | T::GtAnd) {
				self.bump();
				self.lx.cmdbltin = false;
				return Ok(Tok::new(T::Dash, lo, lo + 1, line));
			}
			if let Some(t) = self.read_word_token(lo, line)? {
				return Ok(t);
			}
		}
	}

	/// Operators. `None` means the input is a process substitution and the
	/// cursor is back at the `<` / `>`.
	fn read_operator(&mut self, c: u8, lo: u32, line: u32) -> PResult<Option<Tok>> {
		self.lx.alexpnext = false;
		self.lx.assignok = false;
		self.lx.cmdbltin = false;
		let m = self.mark();
		self.bump();
		let p = self.peek();
		let kind = if p == Some(c) {
			match c {
				b'<' => {
					self.bump();
					match self.peek() {
						Some(b'-') => {
							self.bump();
							Some(T::LtLtDash)
						},
						Some(b'<') => {
							self.bump();
							Some(T::LtLtLt)
						},
						_ => Some(T::LtLt),
					}
				},
				b'>' => {
					self.bump();
					Some(T::GtGt)
				},
				b';' => {
					self.bump();
					self.lx.casepat = true;
					if self.peek() == Some(b'&') {
						self.bump();
						Some(T::SemiSemiAnd)
					} else {
						Some(T::SemiSemi)
					}
				},
				b'&' => {
					self.bump();
					Some(T::AndAnd)
				},
				b'|' => {
					self.bump();
					Some(T::OrOr)
				},
				b'(' => {
					if let Some(t) = self.dparen(lo, line)? {
						return Ok(Some(t));
					}
					None
				},
				_ => None,
			}
		} else {
			match (c, p) {
				(b'<', Some(b'&')) => {
					self.bump();
					Some(T::LtAnd)
				},
				(b'>', Some(b'&')) => {
					self.bump();
					Some(T::GtAnd)
				},
				(b'<', Some(b'>')) => {
					self.bump();
					Some(T::LtGt)
				},
				(b'>', Some(b'|')) => {
					self.bump();
					Some(T::GtBar)
				},
				(b'&', Some(b'>')) => {
					self.bump();
					if self.peek() == Some(b'>') {
						self.bump();
						Some(T::AndGtGt)
					} else {
						Some(T::AndGt)
					}
				},
				(b'|', Some(b'&')) => {
					self.bump();
					Some(T::BarAnd)
				},
				(b';', Some(b'&')) => {
					self.bump();
					self.lx.casepat = true;
					Some(T::SemiAnd)
				},
				_ => None,
			}
		};
		if let Some(kind) = kind {
			return Ok(Some(Tok::new(kind, lo, self.off(), line)));
		}
		if c == b')' && self.lx.last == T::LParen && self.lx.before == T::Word {
			self.lx.allowopnbrc = true;
		}
		if c == b'(' && !self.lx.casepat && !self.lx.condcmd && self.lx.last != T::Word {
			self.open_compound(T::LParen, line);
		} else if self.lx.casepat && c == b')' {
			self.lx.casepat = false;
		}
		if (c == b'<' || c == b'>') && p == Some(b'(') {
			self.reset(m);
			return Ok(None);
		}
		let kind = match c {
			b'<' => T::Lt,
			b'>' => T::Gt,
			b';' => T::Semi,
			b'&' => T::Amp,
			b'|' => T::Bar,
			b'(' => T::LParen,
			_ => T::RParen,
		};
		Ok(Some(Tok::new(kind, lo, lo + 1, line)))
	}

	/// `((` after `(` was consumed (`parse_dparen`): an arithmetic `for`, an
	/// arithmetic command, or a nested subshell.
	fn dparen(&mut self, lo: u32, line: u32) -> PResult<Option<Tok>> {
		if self.lx.last == T::For {
			self.bump();
			let alo = self.off();
			let start = self.bash_line();
			// A `for ((…))` inside a substitution inside another one starts
			// its own collection.
			let depth = core::mem::replace(&mut self.raw_depth, 0);
			let outer = self.arith_semis.replace(Vec::new());
			let text = self.raw_arith(b'(', b')', start);
			let semis = core::mem::replace(&mut self.arith_semis, outer).unwrap_or_default();
			self.raw_depth = depth;
			let text = text?;
			let ahi = self.off().saturating_sub(1);
			if self.peek() != Some(b')') {
				return Err(self.near_error());
			}
			self.bump();
			let mut t = Tok::new(T::ArithFor, lo, self.off(), line);
			t.arith = Some(Box::new(ArithTok { text, semis, lo: alo, hi: ahi }));
			return Ok(Some(t));
		}
		if self.reserved_word_acceptable(self.lx.last) {
			let m = self.mark();
			self.bump();
			let alo = self.off();
			let start = self.bash_line();
			let text = self.raw_arith(b'(', b')', start)?;
			let ahi = self.off().saturating_sub(1);
			if self.peek() == Some(b')') {
				self.bump();
				let mut t = Tok::new(T::ArithCmd, lo, self.off(), line);
				t.arith = Some(Box::new(ArithTok { text, semis: Vec::new(), lo: alo, hi: ahi }));
				return Ok(Some(t));
			}
			// Not `(( … ))`: a subshell inside a subshell. Re-read from the
			// second parenthesis.
			if self.reset(m) && !self.lx.casepat && !self.lx.condcmd {
				self.open_compound(T::LParen, line);
			}
			return Ok(Some(Tok::new(T::LParen, lo, lo + 1, line)));
		}
		Ok(None)
	}

	/// Read a word token (`read_token_word` and its epilogue). `None` means
	/// an alias was expanded and the token must be read again.
	fn read_word_token(&mut self, lo: u32, line: u32) -> PResult<Option<Tok>> {
		let acceptable = self.assignment_acceptable();
		// Keywords need no word tree unless the grammar treats them as an
		// ordinary argument. Keep their bytes borrowed until that decision.
		let keyword = self.keyword_bytes();
		let w = if let Some(text) = keyword {
			self.advance(text.len());
			None
		} else {
			Some(self.read_word(acceptable)?)
		};
		let hi = self.off();
		let next = self.peek();
		let plain = keyword.or_else(|| w.as_ref().and_then(WordTok::plain));
		// NUMBER: all digits before `<`/`>`, or after `<&`/`>&`.
		if let Some(text) = plain
			&& text.first().is_some_and(u8::is_ascii_digit)
			&& text.iter().all(u8::is_ascii_digit)
			&& (matches!(next, Some(b'<' | b'>')) || matches!(self.lx.last, T::LtAnd | T::GtAnd))
			&& let Some(n) = parse_int(text)
		{
			let mut t = Tok::new(T::Number, lo, hi, line);
			t.num = n;
			return Ok(Some(t));
		}
		if let Some(text) = plain
			&& let Some(k) = self.special_case_tokens(text)
		{
			if k == T::LBrace {
				self.open_compound(k, line);
			}
			return Ok(Some(Tok::new(k, lo, hi, line)));
		}
		let posix = self.feat.contains(Features::POSIX);
		if posix
			&& let Some(text) = plain
			&& let Some(k) = self.check_reserved(text, line)
		{
			return Ok(Some(Tok::new(k, lo, hi, line)));
		}
		if self.expand_aliases && !w.as_ref().is_some_and(|word| word.quoted) {
			match plain {
				Some(text) => {
					if self.alias_expand(text) {
						return Ok(None);
					}
					self.lx.alexpnext = false;
				},
				None => self.lx.alexpnext = false,
			}
		}
		if !posix
			&& let Some(text) = plain
			&& let Some(k) = self.check_reserved(text, line)
		{
			return Ok(Some(Tok::new(k, lo, hi, line)));
		}
		let w = w.unwrap_or_else(|| WordTok {
			lo,
			hi,
			parts: vec![crate::bash::syntax::WordPart::Lit(
				keyword.expect("borrowed keyword").to_vec(),
			)],
			quoted: false,
			asg: None,
		});
		let last = self.lx.last;
		if self.command_token_position(last) || self.lx.cmdbltin {
			match w.plain() {
				Some(text) if assignment_builtin(text) => self.lx.assignok = true,
				Some(b"command") if posix => self.lx.cmdbltin = true,
				_ => self.lx.cmdbltin = false,
			}
		} else {
			self.lx.cmdbltin = false;
		}
		// `{name}>` / `{name}<`: a variable to receive the fd.
		if matches!(next, Some(b'<' | b'>'))
			&& let Some(text) = w.plain()
			&& text.len() > 2
			&& text[0] == b'{'
			&& text[text.len() - 1] == b'}'
			&& valid_redir_var(&text[1..text.len() - 1])
		{
			let mut t = Tok::new(T::RedirWord, lo, hi, line);
			t.word = Some(w);
			return Ok(Some(t));
		}
		let kind = if w.is_assign() && (self.assignment_acceptable() || self.lx.compassign) {
			T::Assign
		} else {
			T::Word
		};
		match last {
			T::Function => self.lx.allowopnbrc = true,
			T::Case | T::For => {
				self.lx.expect_in_cmd = Some(last);
				self.lx.expect_in += 1;
			},
			T::Select => self.lx.expect_in += 1,
			_ => {},
		}
		let mut t = Tok::new(kind, lo, hi, line);
		t.word = Some(w);
		Ok(Some(t))
	}

	/// A contiguous, unquoted keyword entirely in the original source.
	/// Alias buffers can join words across boundaries and use the full scanner.
	fn keyword_bytes(&self) -> Option<&'s [u8]> {
		if !self.in_source() || self.lx.regexp {
			return None;
		}
		let buf: &'s [u8] = self.buf;
		let rest = &buf[self.pos..];
		let keyword: &[u8] = match rest {
			[b'i', b'f', ..] => b"if",
			[b'i', b'n', ..] => b"in",
			[b't', b'h', ..] => b"then",
			[b't', b'i', ..] => b"time",
			[b'e', b'l', b's', ..] => b"else",
			[b'e', b'l', b'i', ..] => b"elif",
			[b'e', b's', ..] => b"esac",
			[b'f', b'i', ..] => b"fi",
			[b'f', b'o', ..] => b"for",
			[b'f', b'u', ..] => b"function",
			[b'c', b'a', ..] => b"case",
			[b'c', b'o', ..] => b"coproc",
			[b's', b'e', ..] => b"select",
			[b'w', b'h', ..] => b"while",
			[b'u', b'n', ..] => b"until",
			[b'd', b'o', b'n', ..] => b"done",
			[b'd', b'o', ..] => b"do",
			[b'{', ..] => b"{",
			[b'}', ..] => b"}",
			[b'!', b'(', ..] if self.lx.extglob => return None,
			[b'!', ..] => b"!",
			[b'[', b'[', ..] => b"[[",
			[b']', b']', ..] => b"]]",
			_ => return None,
		};
		if !rest.starts_with(keyword) {
			return None;
		}
		let n = keyword.len();
		let text = &rest[..n];
		if rest
			.get(n)
			.is_some_and(|c| !matches!(c, b' ' | b'\t' | b'\n' | b';' | b'&' | b'|' | b'(' | b')'))
		{
			return None;
		}
		Some(text)
	}

	/// bash `special_case_tokens`.
	fn special_case_tokens(&mut self, text: &[u8]) -> Option<T> {
		let lx = &mut self.lx;
		if lx.last == T::Word && matches!(lx.before, T::For | T::Case | T::Select) && text == b"in" {
			if lx.expect_in_cmd == Some(T::Case) {
				lx.casepat = true;
				lx.esacs += 1;
			}
			lx.expect_in = lx.expect_in.saturating_sub(1);
			lx.expect_in_cmd = None;
			return Some(T::In);
		}
		if lx.expect_in > 0 && matches!(lx.last, T::Word | T::Newline) && text == b"in" {
			if lx.expect_in_cmd == Some(T::Case) && lx.casestmt {
				lx.casepat = true;
				lx.esacs += 1;
			}
			lx.expect_in -= 1;
			lx.expect_in_cmd = None;
			return Some(T::In);
		} else if lx.expect_in > 0 && matches!(lx.last, T::Newline | T::Semi) && text == b"do" {
			lx.expect_in -= 1;
			lx.expect_in_cmd = None;
			return Some(T::Do);
		}
		if lx.last == T::Word && matches!(lx.before, T::For | T::Select) && text == b"do" {
			lx.expect_in = lx.expect_in.saturating_sub(1);
			lx.expect_in_cmd = None;
			return Some(T::Do);
		}
		if lx.esacs > 0 && lx.last == T::In && text == b"esac" {
			lx.esacs -= 1;
			lx.casepat = false;
			return Some(T::Esac);
		}
		if lx.allowopnbrc {
			lx.allowopnbrc = false;
			if text == b"{" {
				lx.open_brace += 1;
				return Some(T::LBrace);
			}
		}
		if lx.last == T::ArithFor && text == b"do" {
			return Some(T::Do);
		}
		if lx.last == T::ArithFor && text == b"{" {
			lx.open_brace += 1;
			return Some(T::LBrace);
		}
		if self.lx.open_brace > 0 && text == b"}" && self.reserved_word_acceptable(self.lx.last) {
			self.lx.open_brace -= 1;
			return Some(T::RBrace);
		}
		let lx = &mut self.lx;
		if lx.last == T::Time && text == b"-p" {
			return Some(T::TimeOpt);
		}
		if matches!(lx.last, T::Time | T::TimeOpt) && text == b"--" {
			return Some(T::TimeIgn);
		}
		if lx.condexpr && text == b"]]" {
			return Some(T::CondEnd);
		}
		None
	}

	/// bash `CHECK_FOR_RESERVED_WORD`.
	fn check_reserved(&mut self, text: &[u8], line: u32) -> Option<T> {
		if !self.reserved_word_acceptable(self.lx.last) {
			return None;
		}
		let k = reserved(text)?;
		let lx = &mut self.lx;
		if lx.casepat && k != T::Esac {
			return None;
		}
		if k == T::Time && !self.time_command_acceptable() {
			return None;
		}
		let lx = &mut self.lx;
		if lx.casepat && matches!(lx.last, T::Bar | T::LParen) && k == T::Esac {
			return None;
		}
		match k {
			T::Esac => {
				lx.casepat = false;
				lx.casestmt = false;
				lx.esacs = lx.esacs.saturating_sub(1);
			},
			T::Case => {
				lx.casestmt = true;
				lx.expect_in_cmd = Some(T::Case);
			},
			T::CondEnd => {
				lx.condcmd = false;
				lx.condexpr = false;
			},
			T::CondStart => lx.condcmd = true,
			T::For => lx.expect_in_cmd = Some(T::For),
			T::LBrace => lx.open_brace += 1,
			T::RBrace if lx.open_brace > 0 => lx.open_brace -= 1,
			_ => {},
		}
		self.open_compound(k, line);
		if self.feat.contains(Features::POSIX) {
			self.lx.alexpnext = false;
		}
		Some(k)
	}

	/// bash `alias_expand_token`: push the alias value when `text` is an
	/// eligible alias. Returns whether it did.
	fn alias_expand(&mut self, text: &[u8]) -> bool {
		if !self.lx.alexpnext && !self.assignment_acceptable() {
			return false;
		}
		if self.alias_active(text) {
			return false;
		}
		let aliases: &'s dyn AliasLookup = self.aliases;
		let Some(value) = aliases.alias(text) else {
			return false;
		};
		self
			.alias_uses
			.push(AliasUse { name: text.to_vec(), value: value.to_vec() });
		let expand_next = matches!(value.last(), Some(b' ' | b'\t'));
		// bash returns a space after the last character of the expansion
		// (unless it ends in a blank, newline, metacharacter or unquoted
		// backslash, or inside a quote) so the alias stays marked as in use
		// while its last word is read.
		if alias_needs_space(value) {
			let outer = Frame {
				buf:         self.buf,
				pos:         self.pos,
				alias:       text.to_vec(),
				expand_next: false,
			};
			self.frames.push(outer);
			self.buf = &cursor::END_ALIAS_SPACE;
			self.pos = 0;
		}
		let outer = Frame { buf: self.buf, pos: self.pos, alias: text.to_vec(), expand_next };
		self.frames.push(outer);
		self.buf = value;
		self.pos = 0;
		true
	}

	/// Read the bodies of pending here-documents (bash
	/// `gather_here_documents`), starting at the cursor.
	pub(super) fn gather(&mut self) {
		let pending = core::mem::take(&mut self.pending);
		let at_line = self.bash_line();
		for doc in pending {
			let text = self.read_doc(&doc, at_line);
			let slot = doc.seq as usize;
			if slot < self.docs.len() {
				self.docs[slot] = text;
			}
		}
	}

	/// Pending here-documents at the end of a command substitution: bash
	/// warns and reads them from the lines after the current one.
	pub(super) fn gather_ahead(&mut self) {
		let n = self.pending.len();
		let mut msg = b"warning: command substitution: ".to_vec();
		push_u32(&mut msg, n as u32);
		msg.extend_from_slice(if n == 1 {
			b" unterminated here-document"
		} else {
			b" unterminated here-documents"
		});
		self
			.warnings
			.push(ParseWarning { line: self.bash_line(), bash_msg: msg });
		if !self.in_source() {
			self.gather();
			return;
		}
		// Read from the start of the next line (or from where an earlier
		// read-ahead stopped), then come back.
		let (start, start_line) = match self.skip {
			Some(sk) => (sk.to, sk.line),
			None => match self.src[self.pos..].iter().position(|&c| c == b'\n') {
				Some(n) => (self.pos + n + 1, self.line + 1),
				None => (self.src.len(), self.line + 1),
			},
		};
		let saved_pos = self.pos;
		let saved_line = self.line;
		let saved_virt = self.virt_done;
		let saved_skip = self.skip.take();
		let at = saved_skip.map_or(start, |s| s.at);
		self.pos = start;
		self.line = start_line;
		let pending = core::mem::take(&mut self.pending);
		let at_line = saved_line;
		for doc in pending {
			let text = self.read_doc(&doc, at_line);
			let slot = doc.seq as usize;
			if slot < self.docs.len() {
				self.docs[slot] = text;
			}
		}
		let to = self.pos;
		let line = self.line;
		self.pos = saved_pos;
		self.line = saved_line;
		self.virt_done = saved_virt;
		self.skip = Some(super::cursor::Skip { at, to, line });
	}

	/// Read one here-document body (bash `make_here_document`).
	fn read_doc(&mut self, doc: &PendingDoc, at_line: u32) -> Vec<u8> {
		let mut text = Vec::new();
		let mut line = Vec::new();
		let delim = &doc.delim[..];
		loop {
			let line_start = self.mark();
			line.clear();
			if !self.read_doc_line(&mut line, !doc.quoted) {
				self.doc_eof_warning(doc, at_line);
				break;
			}
			let mut body: &[u8] = &line;
			if doc.strip && !body.is_empty() {
				if body.len() == delim.len() + 1
					&& body.starts_with(delim)
					&& body[delim.len()] == b'\n'
				{
					break;
				}
				while body.first() == Some(&b'\t') {
					body = &body[1..];
				}
			}
			if body.is_empty() {
				continue;
			}
			if body.len() == delim.len() + 1 && body.starts_with(delim) && body[delim.len()] == b'\n' {
				break;
			}
			if self.lx.eof_token != 0
				&& body.starts_with(delim)
				&& body[delim.len()..].contains(&self.lx.eof_token)
			{
				// bash pushes the rest of the line back as input.
				let tabs = line.len() - body.len();
				let back = tabs + delim.len();
				if self.reset(line_start) {
					for _ in 0..back {
						self.bump();
					}
				}
				self.doc_eof_warning(doc, at_line);
				break;
			}
			text.extend_from_slice(body);
		}
		text
	}

	fn doc_eof_warning(&mut self, doc: &PendingDoc, at_line: u32) {
		let mut msg = b"warning: here-document at line ".to_vec();
		push_u32(&mut msg, at_line);
		msg.extend_from_slice(b" delimited by end-of-file (wanted `");
		msg.extend_from_slice(&doc.delim);
		msg.extend_from_slice(b"')");
		self
			.warnings
			.push(ParseWarning { line: self.bash_line(), bash_msg: msg });
	}

	/// One here-document line with its newline (bash `read_a_line`); `false`
	/// at end of input. `unquoted` removes `\newline`.
	fn read_doc_line(&mut self, out: &mut Vec<u8>, unquoted: bool) -> bool {
		loop {
			if self.pos == 0 && core::ptr::eq(self.buf.as_ptr(), cursor::END_ALIAS_SPACE.as_ptr()) {
				self.pos = 1;
				continue;
			}
			// Fast path: copy up to a newline or backslash.
			let buf: &'s [u8] = self.buf;
			let rest = buf.get(self.pos..).unwrap_or_default();
			let n = rest
				.iter()
				.position(|&c| c == b'\n' || (unquoted && c == b'\\') || c == 0)
				.unwrap_or(rest.len());
			if n > 0 {
				out.extend_from_slice(&rest[..n]);
				self.advance(n);
			}
			let Some(c) = self.peek() else {
				if out.is_empty() {
					return false;
				}
				out.push(b'\n');
				return true;
			};
			self.bump();
			if self.at_alias_space() {
				// bash adds no end-of-alias space while it reads a document.
				continue;
			}
			match c {
				0 => {},
				b'\n' => {
					out.push(b'\n');
					return true;
				},
				b'\\' => match self.peek() {
					Some(b'\n') => self.bump(),
					None => out.push(b'\\'),
					Some(d) => {
						out.push(b'\\');
						out.push(d);
						self.bump();
						if d == b'\n' {
							return true;
						}
					},
				},
				_ => out.push(c),
			}
		}
	}

	/// Queue a here-document; its text slot gets the body at the next newline.
	pub(super) fn push_doc(&mut self, delim: Vec<u8>, strip: bool, quoted: bool) -> u32 {
		let seq = self.docs.len() as u32;
		self.docs.push(Vec::new());
		self.pending.push(PendingDoc { seq, delim, strip, quoted });
		seq
	}

	/// Text of a token for error messages (bash `error_token_from_token`).
	pub(super) fn token_text(t: &Tok) -> Vec<u8> {
		match t.kind {
			T::Word | T::Assign => {
				let mut out = Vec::new();
				if let Some(w) = &t.word {
					w.render(&mut out);
				}
				out
			},
			T::Number => {
				let mut out = Vec::new();
				push_u32(&mut out, t.num);
				out
			},
			T::ArithCmd | T::ArithFor => t.arith.as_ref().expect("arithmetic token").text.clone(),
			T::RedirWord => {
				let mut out = Vec::new();
				if let Some(w) = &t.word {
					w.render(&mut out);
				}
				out
			},
			k => k.text().to_vec(),
		}
	}

	/// Syntax error at token `t` (already taken from the input).
	pub(super) fn token_error(&self, t: &Tok) -> ParseError {
		if t.kind == T::Eof {
			return self.eof_error();
		}
		let mut text = Self::token_text(t);
		if should_ansi_quote(&text) {
			let mut q = Vec::new();
			ansi_quote(&mut q, &text);
			text = q;
		}
		let closing = match (self.lx.eof_token, t.kind) {
			(b')', T::RParen) | (b'}', T::RBrace) | (0, _) => None,
			(c, _) => Some(c),
		};
		let kind = ParseErrorKind::UnexpectedToken { token: text.into_boxed_slice(), closing };
		ParseError::new(t.span(), self.bash_line(), kind)
	}

	/// Error at the lookahead token.
	pub(super) fn unexpected(&mut self) -> ParseError {
		match self.take() {
			Ok(t) => self.token_error(&t),
			Err(e) => e,
		}
	}

	/// End of input where a token was needed.
	pub(super) fn eof_error(&self) -> ParseError {
		let at = self.off();
		let line = self.eof_line();
		let span = Span::new(at, at);
		if self.lx.eof_token != 0 {
			let close: &'static str = if self.lx.eof_token == b')' { ")" } else { "}" };
			return unmatched_error(span, line, close);
		}
		if let Some(&(t, from)) = self.compound.last() {
			let kw: &'static str = match t {
				T::If => "if",
				T::Case => "case",
				T::For => "for",
				T::Select => "select",
				T::While => "while",
				T::Until => "until",
				T::LBrace => "{",
				T::LParen => "(",
				_ => "[[",
			};
			return ParseError::new(span, line, ParseErrorKind::UnexpectedEof {
				from: Some((kw, from)),
			});
		}
		ParseError::new(span, line, ParseErrorKind::UnexpectedEof { from: None })
	}

	/// bash's ``syntax error near `x'`` for errors without a token: the text
	/// before the cursor on the current line, back to a blank or `;|&`.
	pub(super) fn near_error(&self) -> ParseError {
		// A port of `error_token_from_text` over bash's current input line
		// (the line holding the last character read, with its newline).
		let src = self.src;
		let cursor = self.src_pos().min(src.len());
		let past_end = cursor == src.len() && self.virt_done && self.virt == b'\n';
		let (line_end, at_end) = if cursor > 0 && src[cursor - 1] == b'\n' {
			(cursor - 1, true)
		} else if past_end {
			(cursor, true)
		} else {
			(
				src[cursor..]
					.iter()
					.position(|&c| c == b'\n')
					.map_or(src.len(), |n| cursor + n),
				false,
			)
		};
		let line_start = src[..line_end]
			.iter()
			.rposition(|&c| c == b'\n')
			.map_or(0, |i| i + 1);
		let t = |i: usize| {
			if line_start + i < line_end {
				src[line_start + i]
			} else {
				b'\n'
			}
		};
		let mut i = if at_end {
			line_end - line_start
		} else {
			cursor - line_start
		};
		while i > 0 && matches!(t(i), b' ' | b'\t' | b'\n') {
			i -= 1;
		}
		let token_end = if i > 0 { i + 1 } else { 0 };
		while i > 0 && !matches!(t(i), b' ' | b'\n' | b'\t' | b';' | b'|' | b'&') {
			i -= 1;
		}
		while i != token_end && matches!(t(i), b' ' | b'\t' | b'\n') {
			i += 1;
		}
		let (lo, hi) = if token_end > 0 {
			(line_start + i, line_start + token_end)
		} else {
			(line_start, (line_start + 1).min(line_end.max(line_start + 1)))
		};
		let text: Box<[u8]> = (lo..hi).map(|k| t(k - line_start)).collect();
		ParseError::new(
			Span::new(self.base + lo as u32, self.base + hi as u32),
			self.bash_line(),
			ParseErrorKind::Near(text),
		)
	}
}

/// ``unexpected EOF while looking for matching `X'``.
pub(super) fn unmatched_error(span: Span, line: u32, close: &'static str) -> ParseError {
	ParseError::new(span, line, ParseErrorKind::Unmatched(close))
}

/// A redirection fd number bash accepts (fits an `int`).
fn parse_int(text: &[u8]) -> Option<u32> {
	let mut n: u32 = 0;
	for &d in text {
		n = n.checked_mul(10)?.checked_add(u32::from(d - b'0'))?;
	}
	i32::try_from(n).is_ok().then_some(n)
}

/// `{var}` names: an identifier or an array reference.
fn valid_redir_var(name: &[u8]) -> bool {
	if is_identifier(name) {
		return true;
	}
	match name.iter().position(|&c| c == b'[') {
		Some(i) => is_identifier(&name[..i]) && name.ends_with(b"]") && name.len() > i + 2,
		None => false,
	}
}

/// Whether bash appends a space after alias `value` (`shell_getc`'s
/// `END_ALIAS` condition): the last byte is not a blank, newline,
/// metacharacter or unquoted backslash, and the value does not end inside a
/// quote.
fn alias_needs_space(value: &[u8]) -> bool {
	let Some(&last) = value.last() else {
		return false;
	};
	if matches!(last, b' ' | b'\t' | b'\n') || is_meta(last) || is_break(last) {
		return false;
	}
	let mut quote = 0u8;
	let mut escaped = false;
	for &c in value {
		if escaped {
			escaped = false;
			continue;
		}
		match (quote, c) {
			(0 | b'"', b'\\') => escaped = true,
			(0, b'\'' | b'"') => quote = c,
			(q, c) if q != 0 && c == q => quote = 0,
			_ => {},
		}
	}
	quote == 0 && !escaped
}
