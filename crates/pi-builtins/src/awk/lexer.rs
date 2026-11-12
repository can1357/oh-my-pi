//! AWK tokenizer, ported from GoAWK's `lexer` package.
//!
//! The parser asks for a regex token explicitly (after it saw `/` or `/=` in
//! operand position), which is how AWK's `/` division/regex ambiguity is
//! resolved.

use std::fmt;

/// Source position of a token: 1-based line and byte column.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Pos {
	pub line: usize,
	pub col:  usize,
}

/// Builtin functions known to the lexer as keywords.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Func {
	Atan2,
	Close,
	Cos,
	Exp,
	Fflush,
	Gsub,
	Index,
	Int,
	Length,
	Log,
	Match,
	Rand,
	Sin,
	Split,
	Sprintf,
	Sqrt,
	Srand,
	Strftime,
	Sub,
	Substr,
	System,
	Systime,
	Tolower,
	Toupper,
}

impl Func {
	pub const fn name(self) -> &'static str {
		match self {
			Self::Atan2 => "atan2",
			Self::Close => "close",
			Self::Cos => "cos",
			Self::Exp => "exp",
			Self::Fflush => "fflush",
			Self::Gsub => "gsub",
			Self::Index => "index",
			Self::Int => "int",
			Self::Length => "length",
			Self::Log => "log",
			Self::Match => "match",
			Self::Rand => "rand",
			Self::Sin => "sin",
			Self::Split => "split",
			Self::Sprintf => "sprintf",
			Self::Sqrt => "sqrt",
			Self::Srand => "srand",
			Self::Strftime => "strftime",
			Self::Sub => "sub",
			Self::Substr => "substr",
			Self::System => "system",
			Self::Systime => "systime",
			Self::Tolower => "tolower",
			Self::Toupper => "toupper",
		}
	}
}

/// A token kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Tok {
	Illegal,
	Eof,
	Newline,
	Add,
	AddAssign,
	And,
	Append,
	Assign,
	Colon,
	Comma,
	Decr,
	Div,
	DivAssign,
	Dollar,
	Equals,
	Gte,
	Greater,
	Incr,
	LBrace,
	LBracket,
	Less,
	LParen,
	Lte,
	Match,
	Mod,
	ModAssign,
	Mul,
	MulAssign,
	NotMatch,
	Not,
	NotEquals,
	Or,
	Pipe,
	Pow,
	PowAssign,
	Question,
	RBrace,
	RBracket,
	RParen,
	Semicolon,
	Sub,
	SubAssign,
	Begin,
	Break,
	Continue,
	Delete,
	Do,
	Else,
	End,
	Exit,
	For,
	Function,
	Getline,
	If,
	In,
	Next,
	Nextfile,
	Print,
	Printf,
	Return,
	While,
	Builtin(Func),
	Name,
	Number,
	Str,
	Regex,
}

impl fmt::Display for Tok {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let s = match self {
			Self::Illegal => "<illegal>",
			Self::Eof => "EOF",
			Self::Newline => "<newline>",
			Self::Add => "+",
			Self::AddAssign => "+=",
			Self::And => "&&",
			Self::Append => ">>",
			Self::Assign => "=",
			Self::Colon => ":",
			Self::Comma => ",",
			Self::Decr => "--",
			Self::Div => "/",
			Self::DivAssign => "/=",
			Self::Dollar => "$",
			Self::Equals => "==",
			Self::Gte => ">=",
			Self::Greater => ">",
			Self::Incr => "++",
			Self::LBrace => "{",
			Self::LBracket => "[",
			Self::Less => "<",
			Self::LParen => "(",
			Self::Lte => "<=",
			Self::Match => "~",
			Self::Mod => "%",
			Self::ModAssign => "%=",
			Self::Mul => "*",
			Self::MulAssign => "*=",
			Self::NotMatch => "!~",
			Self::Not => "!",
			Self::NotEquals => "!=",
			Self::Or => "||",
			Self::Pipe => "|",
			Self::Pow => "^",
			Self::PowAssign => "^=",
			Self::Question => "?",
			Self::RBrace => "}",
			Self::RBracket => "]",
			Self::RParen => ")",
			Self::Semicolon => ";",
			Self::Sub => "-",
			Self::SubAssign => "-=",
			Self::Begin => "BEGIN",
			Self::Break => "break",
			Self::Continue => "continue",
			Self::Delete => "delete",
			Self::Do => "do",
			Self::Else => "else",
			Self::End => "END",
			Self::Exit => "exit",
			Self::For => "for",
			Self::Function => "function",
			Self::Getline => "getline",
			Self::If => "if",
			Self::In => "in",
			Self::Next => "next",
			Self::Nextfile => "nextfile",
			Self::Print => "print",
			Self::Printf => "printf",
			Self::Return => "return",
			Self::While => "while",
			Self::Builtin(func) => func.name(),
			Self::Name => "name",
			Self::Number => "number",
			Self::Str => "string",
			Self::Regex => "regex",
		};
		f.write_str(s)
	}
}

/// The keyword or builtin-function token for `name`, if it is one.
fn keyword(name: &[u8]) -> Option<Tok> {
	Some(match name {
		b"BEGIN" => Tok::Begin,
		b"break" => Tok::Break,
		b"continue" => Tok::Continue,
		b"delete" => Tok::Delete,
		b"do" => Tok::Do,
		b"else" => Tok::Else,
		b"END" => Tok::End,
		b"exit" => Tok::Exit,
		b"for" => Tok::For,
		b"function" | b"func" => Tok::Function,
		b"getline" => Tok::Getline,
		b"if" => Tok::If,
		b"in" => Tok::In,
		b"next" => Tok::Next,
		b"nextfile" => Tok::Nextfile,
		b"print" => Tok::Print,
		b"printf" => Tok::Printf,
		b"return" => Tok::Return,
		b"while" => Tok::While,
		b"atan2" => Tok::Builtin(Func::Atan2),
		b"close" => Tok::Builtin(Func::Close),
		b"cos" => Tok::Builtin(Func::Cos),
		b"exp" => Tok::Builtin(Func::Exp),
		b"fflush" => Tok::Builtin(Func::Fflush),
		b"gsub" => Tok::Builtin(Func::Gsub),
		b"index" => Tok::Builtin(Func::Index),
		b"int" => Tok::Builtin(Func::Int),
		b"length" => Tok::Builtin(Func::Length),
		b"log" => Tok::Builtin(Func::Log),
		b"match" => Tok::Builtin(Func::Match),
		b"rand" => Tok::Builtin(Func::Rand),
		b"sin" => Tok::Builtin(Func::Sin),
		b"split" => Tok::Builtin(Func::Split),
		b"sprintf" => Tok::Builtin(Func::Sprintf),
		b"sqrt" => Tok::Builtin(Func::Sqrt),
		b"srand" => Tok::Builtin(Func::Srand),
		b"strftime" => Tok::Builtin(Func::Strftime),
		b"sub" => Tok::Builtin(Func::Sub),
		b"substr" => Tok::Builtin(Func::Substr),
		b"system" => Tok::Builtin(Func::System),
		b"systime" => Tok::Builtin(Func::Systime),
		b"tolower" => Tok::Builtin(Func::Tolower),
		b"toupper" => Tok::Builtin(Func::Toupper),
		_ => return None,
	})
}

/// A scanned token: kind, position, and value (the name, number text,
/// unescaped string, regex source, or error message).
pub(super) struct Token {
	pub pos: Pos,
	pub tok: Tok,
	pub val: Vec<u8>,
}

/// Tokenizer over AWK source bytes.
pub(super) struct Lexer<'a> {
	src:       &'a [u8],
	offset:    usize,
	ch:        u8,
	pos:       Pos,
	next_pos:  Pos,
	had_space: bool,
	last_tok:  Tok,
}

impl<'a> Lexer<'a> {
	pub fn new(src: &'a [u8]) -> Self {
		let mut lexer = Self {
			src,
			offset: 0,
			ch: 0,
			pos: Pos::default(),
			next_pos: Pos { line: 1, col: 1 },
			had_space: false,
			last_tok: Tok::Illegal,
		};
		lexer.next();
		lexer
	}

	/// Whether whitespace preceded the last token (user function calls must
	/// not have a space before `(`).
	pub const fn had_space(&self) -> bool {
		self.had_space
	}

	/// The next unscanned byte; 0 at end of input.
	pub const fn peek_byte(&self) -> u8 {
		self.ch
	}

	pub fn scan(&mut self) -> Token {
		let token = self.scan_inner();
		self.last_tok = token.tok;
		token
	}

	fn illegal(&self, message: &str) -> Token {
		Token { pos: self.pos, tok: Tok::Illegal, val: message.as_bytes().to_vec() }
	}

	fn scan_inner(&mut self) -> Token {
		self.had_space = false;
		while matches!(self.ch, b' ' | b'\t' | b'\r' | b'\\') {
			self.had_space = true;
			if self.ch == b'\\' {
				self.next();
				if self.ch == b'\r' {
					self.next();
				}
				if self.ch != b'\n' {
					return self.illegal("expected \\n after \\ line continuation");
				}
			}
			self.next();
		}
		if self.ch == b'#' {
			self.next();
			while self.ch != b'\n' && self.ch != 0 {
				self.next();
			}
		}
		if self.ch == 0 {
			return Token { pos: self.pos, tok: Tok::Eof, val: Vec::new() };
		}

		let pos = self.pos;
		let ch = self.ch;
		self.next();

		if is_name_start(ch) {
			let start = self.offset - 2;
			while is_name_start(self.ch) || self.ch.is_ascii_digit() {
				self.next();
			}
			let name = &self.src[start..self.offset - 1];
			return match keyword(name) {
				Some(tok) => Token { pos, tok, val: Vec::new() },
				None => Token { pos, tok: Tok::Name, val: name.to_vec() },
			};
		}

		let tok = match ch {
			b'$' => Tok::Dollar,
			b'0'..=b'9' | b'.' => {
				let start = self.offset - 2;
				let mut got_digit = false;
				if ch != b'.' {
					got_digit = true;
					while self.ch.is_ascii_digit() {
						self.next();
					}
					if self.ch == b'.' {
						self.next();
					}
				}
				while self.ch.is_ascii_digit() {
					got_digit = true;
					self.next();
				}
				if !got_digit {
					return self.illegal("expected digits");
				}
				if self.ch == b'e' || self.ch == b'E' {
					self.next();
					let mut got_sign = false;
					if self.ch == b'+' || self.ch == b'-' {
						got_sign = true;
						self.next();
					}
					let mut got_exp = false;
					while self.ch.is_ascii_digit() {
						self.next();
						got_exp = true;
					}
					// "1e" is "1 e" (e a variable); "1e+" is "1e + ...".
					if !got_exp {
						if got_sign {
							self.unread();
						}
						self.unread();
					}
				}
				let val = self.src[start..self.offset - 1].to_vec();
				return Token { pos, tok: Tok::Number, val };
			},
			b'{' => Tok::LBrace,
			b'}' => Tok::RBrace,
			b'=' => self.choice(b'=', Tok::Assign, Tok::Equals),
			b'<' => self.choice(b'=', Tok::Less, Tok::Lte),
			b'>' => match self.ch {
				b'=' => {
					self.next();
					Tok::Gte
				},
				b'>' => {
					self.next();
					Tok::Append
				},
				_ => Tok::Greater,
			},
			b'"' | b'\'' => {
				let mut index = self.offset - 1;
				let src = self.src;
				let parsed = parse_string(ch, src, &mut index);
				// Re-sync the lexer with the bytes the string consumed.
				while self.offset - 1 < index && self.ch != 0 {
					self.next();
				}
				let value = match parsed {
					Ok(value) => value,
					Err(message) => return self.illegal(message),
				};
				if self.ch != ch {
					return self.illegal("didn't find end quote in string");
				}
				self.next();
				return Token { pos, tok: Tok::Str, val: value };
			},
			b'(' => Tok::LParen,
			b')' => Tok::RParen,
			b',' => Tok::Comma,
			b';' => Tok::Semicolon,
			b'+' => match self.ch {
				b'+' => {
					self.next();
					Tok::Incr
				},
				b'=' => {
					self.next();
					Tok::AddAssign
				},
				_ => Tok::Add,
			},
			b'-' => match self.ch {
				b'-' => {
					self.next();
					Tok::Decr
				},
				b'=' => {
					self.next();
					Tok::SubAssign
				},
				_ => Tok::Sub,
			},
			b'*' => match self.ch {
				b'*' => {
					self.next();
					self.choice(b'=', Tok::Pow, Tok::PowAssign)
				},
				b'=' => {
					self.next();
					Tok::MulAssign
				},
				_ => Tok::Mul,
			},
			b'/' => self.choice(b'=', Tok::Div, Tok::DivAssign),
			b'%' => self.choice(b'=', Tok::Mod, Tok::ModAssign),
			b'[' => Tok::LBracket,
			b']' => Tok::RBracket,
			b'\n' => Tok::Newline,
			b'^' => self.choice(b'=', Tok::Pow, Tok::PowAssign),
			b'!' => match self.ch {
				b'=' => {
					self.next();
					Tok::NotEquals
				},
				b'~' => {
					self.next();
					Tok::NotMatch
				},
				_ => Tok::Not,
			},
			b'~' => Tok::Match,
			b'?' => Tok::Question,
			b':' => Tok::Colon,
			b'&' => {
				if self.ch == b'&' {
					self.next();
					Tok::And
				} else {
					return self.illegal("unexpected char after '&'");
				}
			},
			b'|' => self.choice(b'|', Tok::Pipe, Tok::Or),
			_ => return Token { pos, tok: Tok::Illegal, val: b"unexpected char".to_vec() },
		};
		Token { pos, tok, val: Vec::new() }
	}

	/// Scans a `/regex/` whose opening `/` (or `/=`) was the last token.
	pub fn scan_regex(&mut self) -> Token {
		let token = self.scan_regex_inner();
		self.last_tok = token.tok;
		token
	}

	fn scan_regex_inner(&mut self) -> Token {
		let mut pos = self.pos;
		let mut chars = Vec::with_capacity(32);
		match self.last_tok {
			Tok::Div => pos.col = pos.col.saturating_sub(1),
			_ => {
				pos.col = pos.col.saturating_sub(2);
				chars.push(b'=');
			},
		}
		while self.ch != b'/' {
			let mut c = self.ch;
			if c == 0 {
				return self.illegal("didn't find end slash in regex");
			}
			if c == b'\r' || c == b'\n' {
				return self.illegal("can't have newline in regex");
			}
			if c == b'\\' {
				self.next();
				if self.ch != b'/' {
					chars.push(b'\\');
				}
				c = self.ch;
				if c == 0 {
					return self.illegal("didn't find end slash in regex");
				}
			}
			chars.push(c);
			self.next();
		}
		self.next();
		Token { pos, tok: Tok::Regex, val: chars }
	}

	fn next(&mut self) {
		self.pos = self.next_pos;
		if self.offset >= self.src.len() {
			if self.ch != 0 {
				self.ch = 0;
				self.offset += 1;
				self.next_pos.col += 1;
			}
			return;
		}
		let ch = self.src[self.offset];
		if ch == b'\n' {
			self.next_pos.line += 1;
			self.next_pos.col = 1;
		} else if ch != b'\r' {
			self.next_pos.col += 1;
		}
		self.ch = ch;
		self.offset += 1;
	}

	fn unread(&mut self) {
		self.offset -= 1;
		self.pos.col -= 1;
		self.next_pos.col -= 1;
		self.ch = self.src[self.offset - 1];
	}

	fn choice(&mut self, ch: u8, one: Tok, two: Tok) -> Tok {
		if self.ch == ch {
			self.next();
			two
		} else {
			one
		}
	}
}

const fn is_name_start(ch: u8) -> bool {
	ch == b'_' || ch.is_ascii_alphabetic()
}

const fn hex_digit(ch: u8) -> Option<u8> {
	match ch {
		b'0'..=b'9' => Some(ch - b'0'),
		b'a'..=b'f' => Some(ch - b'a' + 10),
		b'A'..=b'F' => Some(ch - b'A' + 10),
		_ => None,
	}
}

/// Processes the backslash escapes of a `-v` or operand `var=value` value, as
/// POSIX requires.
pub(super) fn unescape(s: &[u8]) -> Vec<u8> {
	let mut index = 0;
	parse_string(0, s, &mut index).unwrap_or_else(|_| s.to_vec())
}

/// Parses string contents starting at `src[*index]` up to (not including)
/// the `quote` byte or the end, advancing `*index`.
///
/// Escapes: `\n \t \r \a \b \f \v \\ \" \/`, `\ooo` octal, `\xHH` hex,
/// `\uHHHH` Unicode. Any other escaped character keeps its backslash, as in
/// onetrue-awk, so `"\."` is still a literal dot when used as a regex.
fn parse_string(quote: u8, src: &[u8], index: &mut usize) -> Result<Vec<u8>, &'static str> {
	let ch = |i: usize| src.get(i).copied().unwrap_or(0);
	let mut chars = Vec::with_capacity(32);
	loop {
		let c = ch(*index);
		if c == quote || (c == 0 && *index >= src.len()) {
			break;
		}
		if quote != 0 && (c == b'\r' || c == b'\n') {
			return Err("can't have newline in string");
		}
		if c != b'\\' {
			chars.push(c);
			*index += 1;
			continue;
		}
		*index += 1;
		let e = ch(*index);
		if *index >= src.len() {
			// Trailing backslash (only possible for `unescape`).
			chars.push(b'\\');
			break;
		}
		match e {
			b'n' => chars.push(b'\n'),
			b't' => chars.push(b'\t'),
			b'r' => chars.push(b'\r'),
			b'a' => chars.push(0x07),
			b'b' => chars.push(0x08),
			b'f' => chars.push(0x0c),
			b'v' => chars.push(0x0b),
			b'\\' => chars.push(b'\\'),
			b'"' => chars.push(b'"'),
			b'\'' => chars.push(b'\''),
			b'/' => chars.push(b'/'),
			b'x' => {
				let Some(first) = hex_digit(ch(*index + 1)) else {
					return Err("1 or 2 hex digits expected");
				};
				*index += 1;
				let mut value = first;
				if let Some(second) = hex_digit(ch(*index + 1)) {
					value = value * 16 + second;
					*index += 1;
				}
				chars.push(value);
			},
			b'u' => {
				let Some(first) = hex_digit(ch(*index + 1)) else {
					return Err("1-8 hex digits expected");
				};
				*index += 1;
				let mut value = u32::from(first);
				for _ in 0..7 {
					let Some(digit) = hex_digit(ch(*index + 1)) else {
						break;
					};
					*index += 1;
					value = value.wrapping_mul(16).wrapping_add(u32::from(digit));
				}
				let Some(c) = char::from_u32(value) else {
					return Err("invalid Unicode character");
				};
				let mut buf = [0; 4];
				chars.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
			},
			b'0'..=b'7' => {
				let mut value = e - b'0';
				for _ in 0..2 {
					let d = ch(*index + 1);
					if !(b'0'..=b'7').contains(&d) {
						break;
					}
					value = value.wrapping_mul(8).wrapping_add(d - b'0');
					*index += 1;
				}
				chars.push(value);
			},
			other => {
				chars.push(b'\\');
				chars.push(other);
			},
		}
		*index += 1;
	}
	Ok(chars)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn kinds(src: &str) -> Vec<Tok> {
		let mut lexer = Lexer::new(src.as_bytes());
		let mut out = Vec::new();
		loop {
			let token = lexer.scan();
			out.push(token.tok);
			if matches!(token.tok, Tok::Eof | Tok::Illegal) {
				return out;
			}
		}
	}

	#[test]
	fn operators_and_keywords() {
		assert_eq!(kinds("a += 1 ** 2 !~ $3"), [
			Tok::Name,
			Tok::AddAssign,
			Tok::Number,
			Tok::Pow,
			Tok::Number,
			Tok::NotMatch,
			Tok::Dollar,
			Tok::Number,
			Tok::Eof
		]);
		assert_eq!(kinds("BEGIN { getline x }"), [
			Tok::Begin,
			Tok::LBrace,
			Tok::Getline,
			Tok::Name,
			Tok::RBrace,
			Tok::Eof
		]);
	}

	#[test]
	fn number_exponent_without_digits_is_a_name() {
		let mut lexer = Lexer::new(b"1e x");
		let token = lexer.scan();
		assert_eq!((token.tok, token.val.as_slice()), (Tok::Number, &b"1"[..]));
		assert_eq!(lexer.scan().tok, Tok::Name);
	}

	#[test]
	fn string_escapes() {
		let mut lexer = Lexer::new(br#""a\tb\n\101\x41\.\"""#);
		let token = lexer.scan();
		assert_eq!(token.tok, Tok::Str);
		assert_eq!(token.val, b"a\tb\nAA\\.\"");
	}

	#[test]
	fn unescape_keeps_trailing_backslash() {
		assert_eq!(unescape(br"a\tb\"), b"a\tb\\");
	}
}
