//! Never-failing parses for mid-stream JSON buffers.

use crate::{
	Str,
	slopjson::{
		parser::{MAX_DEPTH, Mode, Parser},
		value::{Object, Value},
	},
};

/// Parse possibly-incomplete JSON during streaming.
///
/// Always returns a value, never fails: an empty object for
/// empty/whitespace/unrecoverable buffers, and an auto-closed best-effort
/// value for truncated ones. Incomplete trailing atoms (a half-streamed
/// `tru`, number, or bareword) roll back to the last valid prefix instead of
/// retaining junk.
pub fn parse_streaming(partial_json: &str) -> Value {
	let trimmed = partial_json.trim_start();
	if trimmed.is_empty() {
		return Value::Object(Object::new());
	}
	PartialParser { p: Parser::new(trimmed, Mode::Streaming) }
		.parse_root()
		.unwrap_or_else(|| Value::Object(Object::new()))
}

/// Lenient-mode tree builder. Unlike the visitor-driven strict path this
/// must materialize containers, because an incomplete trailing atom rolls
/// the enclosing object/array back to its last valid prefix — something a
/// one-pass visitor cannot undo. Total: no input makes it fail.
struct PartialParser<'a> {
	p: Parser<'a>,
}

impl PartialParser<'_> {
	fn parse_root(&mut self) -> Option<Value> {
		self.p.ws();
		self.p.peek()?;
		self.value(0)
	}

	/// `None` marks an incomplete atom (or a too-deep container) at the
	/// streaming edge; the enclosing container retains its prefix instead.
	fn value(&mut self, depth: u32) -> Option<Value> {
		match self.p.peek()? {
			b'{' | b'[' if depth >= MAX_DEPTH => {
				self.p.skip_to_end();
				None
			},
			b'{' => Some(Value::Object(self.object(depth + 1))),
			b'[' => Some(Value::Array(self.array(depth + 1))),
			quote @ (b'"' | b'\'') => {
				let text = self.p.string(quote).expect("lenient string never fails");
				Some(Value::String(Str::from(text)))
			},
			b'-' | b'+' | b'.' | b'0'..=b'9' => {
				let number = self.p.number().expect("lenient number never errors")?;
				Some(Value::Number(number))
			},
			_ => {
				if let Some(atom) = self.p.match_keyword() {
					Some(atom.into())
				} else {
					// Incomplete / unrecognized token at the streaming edge.
					self.p.skip_to_end();
					None
				}
			},
		}
	}

	fn object(&mut self, depth: u32) -> Object {
		self.p.bump(); // consume {
		let mut out = Object::new();
		loop {
			self.p.ws();
			let Some(b) = self.p.peek() else { return out };
			match b {
				b'}' => {
					self.p.bump();
					return out;
				},
				// Tolerate leading / doubled / trailing commas.
				b',' => {
					self.p.bump();
					continue;
				},
				_ => {},
			}
			let key = match self.p.peek() {
				Some(quote @ (b'"' | b'\'')) => {
					Str::from(self.p.string(quote).expect("lenient string never fails"))
				},
				_ => Str::new(self.p.unquoted_key()),
			};
			self.p.ws();
			if self.p.peek() == Some(b':') {
				self.p.bump();
			} else {
				return out;
			}
			self.p.ws();
			if self.p.at_end() {
				return out;
			}
			let Some(value) = self.value(depth) else {
				return out;
			};
			out.insert(key, value);
			self.p.ws();
			match self.p.peek() {
				Some(b',') => self.p.bump(),
				Some(b'}') => {
					self.p.bump();
					return out;
				},
				_ => return out,
			}
		}
	}

	fn array(&mut self, depth: u32) -> Vec<Value> {
		self.p.bump(); // consume [
		let mut out = Vec::new();
		loop {
			self.p.ws();
			let Some(b) = self.p.peek() else { return out };
			match b {
				b']' => {
					self.p.bump();
					return out;
				},
				b',' => {
					self.p.bump();
					continue;
				},
				_ => {},
			}
			let Some(value) = self.value(depth) else {
				return out;
			};
			out.push(value);
			self.p.ws();
			match self.p.peek() {
				Some(b',') => self.p.bump(),
				Some(b']') => {
					self.p.bump();
					return out;
				},
				_ => return out,
			}
		}
	}
}
