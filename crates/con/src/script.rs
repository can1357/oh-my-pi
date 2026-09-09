//! Config-script parsing: statements, quoting, comments, list and kv
//! literals.
//!
//! The language is deliberately tiny — a config file is a program, not a
//! data format:
//!
//! - Statements are separated by newlines or `;`.
//! - `//` starts a comment at an argument boundary (outside quotes).
//! - `"..."` quotes an atom; escapes: `\"` `\\` `\n` `\t`; literal newlines are
//!   permitted inside quotes.
//! - `[a b c]` is a list literal, `{key value ...}` a kv block; both may span
//!   lines.
//! - Tokens are untyped words; the target variable/argument's [`TypeSpec`]
//!   decides how they parse ([`coerce_one`]).

use std::fmt::{self, Write as _};

use omp_core::{Str, StrMut};

use crate::{
	ParseError, TypeSpec, Value, ValueKind,
	value::{Kv, write_atom},
};

/// One parsed script argument.
#[derive(Clone, Debug, PartialEq)]
pub enum Arg {
	/// Bare word or quoted string.
	Atom(Str),
	/// `[...]` list literal.
	List(Vec<Self>),
	/// `{...}` key/value block literal.
	Kv(Vec<(Str, Self)>),
}

impl Arg {
	/// Atom text, if this is an atom.
	#[must_use]
	pub const fn as_atom(&self) -> Option<&Str> {
		match self {
			Self::Atom(s) => Some(s),
			_ => None,
		}
	}

	/// Renders the argument back to script-literal form.
	#[must_use]
	pub fn to_script(&self) -> Str {
		let mut out = StrMut::new("");
		let _ = write!(out, "{self}");
		out.freeze()
	}
}

impl fmt::Display for Arg {
	/// Script-literal rendering; atoms are re-quoted when required.
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Atom(s) => write_atom(f, s.as_str()),
			Self::List(items) => {
				f.write_str("[")?;
				for (i, item) in items.iter().enumerate() {
					if i > 0 {
						f.write_str(" ")?;
					}
					write!(f, "{item}")?;
				}
				f.write_str("]")
			},
			Self::Kv(pairs) => {
				f.write_str("{")?;
				for (i, (k, v)) in pairs.iter().enumerate() {
					if i > 0 {
						f.write_str(" ")?;
					}
					write_atom(f, k.as_str())?;
					f.write_str(" ")?;
					write!(f, "{v}")?;
				}
				f.write_str("}")
			},
		}
	}
}

/// One executable statement: `args[0]` is the name being dispatched.
#[derive(Clone, Debug, PartialEq)]
pub struct Statement {
	/// Arguments, name included at index 0. Never empty.
	pub args: Vec<Arg>,
	/// 1-based source line the statement started on.
	pub line: u32,
}

/// Parses a full script into statements.
///
/// Zero-copy: atom payloads are refcounted slices of `src` unless escape
/// processing forced a rebuild.
pub fn parse(src: &Str) -> Result<Vec<Statement>, ParseError> {
	Lexer { src, text: src.as_str(), pos: 0, line: 1 }.script()
}

struct Lexer<'s> {
	src:  &'s Str,
	text: &'s str,
	pos:  usize,
	line: u32,
}

impl Lexer<'_> {
	fn peek(&self) -> Option<char> {
		self.text[self.pos..].chars().next()
	}

	fn bump(&mut self) -> Option<char> {
		let ch = self.peek()?;
		if ch == '\n' {
			self.line += 1;
		}
		self.pos += ch.len_utf8();
		Some(ch)
	}

	/// Skips whitespace and comments. Newlines are only consumed when
	/// `newlines` is true (inside literals); at top level they terminate
	/// statements.
	fn skip_trivia(&mut self, newlines: bool) {
		loop {
			match self.peek() {
				Some('\n') if !newlines => return,
				Some(ch) if ch.is_whitespace() => {
					self.bump();
				},
				Some('/') if self.text[self.pos..].starts_with("//") => {
					while let Some(ch) = self.peek() {
						if ch == '\n' {
							break;
						}
						self.bump();
					}
				},
				_ => return,
			}
		}
	}

	fn script(&mut self) -> Result<Vec<Statement>, ParseError> {
		let mut stmts = Vec::new();
		loop {
			self.skip_trivia(false);
			match self.peek() {
				None => return Ok(stmts),
				Some('\n' | ';') => {
					self.bump();
				},
				Some(_) => {
					let line = self.line;
					let args = self.statement()?;
					if !args.is_empty() {
						stmts.push(Statement { args, line });
					}
				},
			}
		}
	}

	/// Collects arguments until a top-level statement boundary.
	fn statement(&mut self) -> Result<Vec<Arg>, ParseError> {
		let mut args = Vec::new();
		loop {
			self.skip_trivia(false);
			match self.peek() {
				None | Some('\n' | ';') => return Ok(args),
				Some('/') if self.text[self.pos..].starts_with("//") => return Ok(args),
				Some(_) => args.push(self.arg()?),
			}
		}
	}

	/// Parses one argument at a non-trivia position.
	fn arg(&mut self) -> Result<Arg, ParseError> {
		match self.peek() {
			Some('"') => Ok(Arg::Atom(self.quoted()?)),
			Some('[') => self.list(),
			Some('{') => self.kv(),
			Some(ch @ (']' | '}')) => Err(ParseError::UnexpectedClose { line: self.line, token: ch }),
			_ => Ok(Arg::Atom(self.word())),
		}
	}

	fn quoted(&mut self) -> Result<Str, ParseError> {
		let open_line = self.line;
		self.bump(); // consume `"`
		let body_start = self.pos;
		let mut owned: Option<StrMut> = None;
		let mut plain_end = self.pos;
		loop {
			match self.bump() {
				None => return Err(ParseError::UnterminatedString { line: open_line }),
				Some('"') => {
					return Ok(match owned {
						Some(buf) => buf.freeze(),
						None => self.src.slice(body_start..plain_end),
					});
				},
				Some('\\') => {
					let buf =
						owned.get_or_insert_with(|| StrMut::from(&self.text[body_start..plain_end]));
					match self.bump() {
						None => return Err(ParseError::UnterminatedString { line: open_line }),
						Some('n') => buf.push_str("\n"),
						Some('t') => buf.push_str("\t"),
						Some(ch) => buf.push(ch),
					}
				},
				Some(ch) => {
					if let Some(buf) = &mut owned {
						buf.push(ch);
					} else {
						plain_end = self.pos;
					}
				},
			}
		}
	}

	fn word(&mut self) -> Str {
		let start = self.pos;
		while let Some(ch) = self.peek() {
			if ch.is_whitespace() || matches!(ch, ';' | '"' | '[' | ']' | '{' | '}') {
				break;
			}
			self.bump();
		}
		self.src.slice(start..self.pos)
	}

	fn list(&mut self) -> Result<Arg, ParseError> {
		let open_line = self.line;
		self.bump(); // consume `[`
		let mut items = Vec::new();
		loop {
			self.skip_trivia(true);
			match self.peek() {
				None => return Err(ParseError::UnterminatedList { line: open_line }),
				Some(']') => {
					self.bump();
					return Ok(Arg::List(items));
				},
				Some(';') => {
					self.bump();
				},
				Some(_) => items.push(self.arg()?),
			}
		}
	}

	fn kv(&mut self) -> Result<Arg, ParseError> {
		let open_line = self.line;
		self.bump(); // consume `{`
		let mut pairs = Vec::new();
		loop {
			self.skip_trivia(true);
			match self.peek() {
				None => return Err(ParseError::UnterminatedKv { line: open_line }),
				Some('}') => {
					self.bump();
					return Ok(Arg::Kv(pairs));
				},
				Some(';') => {
					self.bump();
				},
				Some(_) => {
					let Arg::Atom(key) = self.arg()? else {
						return Err(ParseError::KvKey { line: self.line });
					};
					self.skip_trivia(true);
					if matches!(self.peek(), None | Some('}')) {
						return Err(ParseError::UnterminatedKv { line: open_line });
					}
					let value = self.arg()?;
					pairs.push((key, value));
				},
			}
		}
	}
}

/// Why a token failed to coerce to a target type.
pub enum CoerceIssue {
	/// Wrong shape for the expected kind.
	Kind { expected: ValueKind, got: Str },
	/// Atom is not a declared enum variant.
	Variant { got: Str },
}

impl CoerceIssue {
	fn kind(expected: ValueKind, arg: &Arg) -> Self {
		Self::Kind { expected, got: arg.to_script() }
	}
}

/// Coerces one argument to a typed value.
pub fn coerce_one(arg: &Arg, ty: &TypeSpec) -> Result<Value, CoerceIssue> {
	match ty.kind {
		ValueKind::Bool => match arg.as_atom().map(Str::as_str) {
			Some("true" | "1") => Ok(Value::Bool(true)),
			Some("false" | "0") => Ok(Value::Bool(false)),
			_ => Err(CoerceIssue::kind(ValueKind::Bool, arg)),
		},
		ValueKind::Int => arg
			.as_atom()
			.and_then(|s| s.as_str().parse::<i64>().ok())
			.map(Value::Int)
			.ok_or_else(|| CoerceIssue::kind(ValueKind::Int, arg)),
		ValueKind::Float => arg
			.as_atom()
			.and_then(|s| s.as_str().parse::<f64>().ok())
			.map(Value::Float)
			.ok_or_else(|| CoerceIssue::kind(ValueKind::Float, arg)),
		ValueKind::Str => match arg {
			Arg::Atom(s) => Ok(Value::Str(s.clone())),
			_ => Err(CoerceIssue::kind(ValueKind::Str, arg)),
		},
		ValueKind::Duration => arg
			.as_atom()
			.and_then(|s| s.as_str().parse::<crate::Span>().ok())
			.map(Value::Duration)
			.ok_or_else(|| CoerceIssue::kind(ValueKind::Duration, arg)),
		ValueKind::Enum => match arg.as_atom() {
			Some(s) if ty.variants.contains(&s.as_str()) => Ok(Value::Enum(s.clone())),
			Some(s) => Err(CoerceIssue::Variant { got: s.clone() }),
			None => Err(CoerceIssue::kind(ValueKind::Enum, arg)),
		},
		ValueKind::List => {
			let elem = ty.elem.unwrap_or(TypeSpec::STR);
			match arg {
				Arg::List(items) => {
					let items: Result<Vec<_>, _> = items.iter().map(|a| coerce_one(a, elem)).collect();
					Ok(Value::List(items?))
				},
				// A lone atom is a one-element list: `sv::maps de_dust`.
				atom @ Arg::Atom(_) => Ok(Value::List(vec![coerce_one(atom, elem)?])),
				Arg::Kv(_) => Err(CoerceIssue::kind(ValueKind::List, arg)),
			}
		},
		ValueKind::Kv => match arg {
			Arg::Kv(pairs) => Ok(Value::Kv(kv_infer(pairs))),
			_ => Err(CoerceIssue::kind(ValueKind::Kv, arg)),
		},
	}
}

/// Coerces a var-set argument tail. List targets absorb every remaining
/// argument (`sv::maps de_dust de_nuke`); everything else takes exactly one.
pub fn coerce_set_args(args: &[Arg], ty: &TypeSpec) -> Result<Value, CoerceIssue> {
	if ty.kind == ValueKind::List && args.len() != 1 {
		let elem = ty.elem.unwrap_or(TypeSpec::STR);
		let items: Result<Vec<_>, _> = args.iter().map(|a| coerce_one(a, elem)).collect();
		return Ok(Value::List(items?));
	}
	match args {
		[one] => coerce_one(one, ty),
		_ => Err(CoerceIssue::Kind {
			expected: ty.kind,
			got:      Str::new_static("<multiple arguments>"),
		}),
	}
}

/// Untyped inference for kv-block leaf values: `true`/`false`, integers,
/// floats, else string.
fn infer(arg: &Arg) -> Value {
	match arg {
		Arg::Atom(s) => {
			let text = s.as_str();
			match text {
				"true" => Value::Bool(true),
				"false" => Value::Bool(false),
				_ => {
					if let Ok(i) = text.parse::<i64>() {
						Value::Int(i)
					} else if let Ok(f) = text.parse::<f64>() {
						Value::Float(f)
					} else {
						Value::Str(s.clone())
					}
				},
			}
		},
		Arg::List(items) => Value::List(items.iter().map(infer).collect()),
		Arg::Kv(pairs) => Value::Kv(kv_infer(pairs)),
	}
}

fn kv_infer(pairs: &[(Str, Arg)]) -> Kv {
	Kv(pairs.iter().map(|(k, v)| (k.clone(), infer(v))).collect())
}
