//! Strict RFC 8259 prefix classification for streaming buffers.

use smallvec::SmallVec;

use crate::slopjson::{is_valid_escape, is_whitespace};

/// Classification of a streaming buffer against strict JSON (RFC 8259).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonPrefixState {
	/// Exactly one whole JSON value (plus surrounding whitespace).
	Complete,
	/// A proper prefix of some valid JSON value — more bytes can still
	/// complete it.
	Prefix,
	/// No suffix can ever make it valid strict JSON (e.g. a raw control
	/// character inside a string, or a second top-level value).
	Invalid,
}

/// What the strict-prefix scanner expects at the current position.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Expect {
	Value,
	ObjKeyOrEnd,
	ObjKey,
	ObjColon,
	ObjCommaOrEnd,
	ArrValueOrEnd,
	ArrCommaOrEnd,
	End,
}

/// Outcome of scanning one token: finished, cut off at end-of-input, or
/// unsalvageable.
enum Scan {
	Done,
	More,
	Dead,
}

#[cold]
const fn invalid() -> JsonPrefixState {
	JsonPrefixState::Invalid
}

#[cold]
const fn dead() -> Scan {
	Scan::Dead
}

/// Classify `text` as a strict-JSON value, prefix, or dead end.
///
/// Streaming decoders can use this to decide whether a fragment extends the
/// current JSON buffer: concatenation is impossible when the buffer is already
/// a complete value, already unsalvageable, or the appended bytes make it a
/// dead end. Unlike [`parse_streaming`](crate::slopjson::parse_streaming), this
/// is deliberately strict: forgiving repair would mask exactly the corruption
/// signals the caller needs.
///
/// A top-level number at end-of-input classifies as
/// [`Complete`](JsonPrefixState::Complete) even though more digits could extend
/// it; consumers that permit top-level scalars must account for that ambiguity.
pub fn classify_json_prefix(text: &str) -> JsonPrefixState {
	Classifier { s: text.as_bytes(), i: 0 }.run()
}

/// Container stack entry: `true` = object, `false` = array.
type Stack = SmallVec<bool, 32>;

/// A value just finished; the next expectation follows from the stack.
fn value_done(stack: &Stack) -> Expect {
	match stack.last().copied() {
		None => Expect::End,
		Some(true) => Expect::ObjCommaOrEnd,
		Some(false) => Expect::ArrCommaOrEnd,
	}
}

struct Classifier<'a> {
	s: &'a [u8],
	i: usize,
}

impl Classifier<'_> {
	fn run(&mut self) -> JsonPrefixState {
		let mut stack = Stack::new();
		let mut expect = Expect::Value;

		while self.i < self.s.len() {
			let b = self.s[self.i];
			if is_whitespace(b) {
				self.i += 1;
				continue;
			}
			match expect {
				Expect::Value | Expect::ArrValueOrEnd => {
					if b == b']' && expect == Expect::ArrValueOrEnd {
						stack.pop();
						self.i += 1;
						expect = value_done(&stack);
						continue;
					}
					if b == b'{' {
						stack.push(true);
						self.i += 1;
						expect = Expect::ObjKeyOrEnd;
						continue;
					}
					if b == b'[' {
						stack.push(false);
						self.i += 1;
						expect = Expect::ArrValueOrEnd;
						continue;
					}
					let scan = match b {
						b'"' => self.string(),
						b'-' | b'0'..=b'9' => self.number(),
						b't' | b'f' | b'n' => self.keyword(),
						_ => return invalid(),
					};
					match scan {
						Scan::Dead => return invalid(),
						Scan::More => return JsonPrefixState::Prefix,
						Scan::Done => expect = value_done(&stack),
					}
				},
				Expect::ObjKeyOrEnd | Expect::ObjKey => {
					if b == b'}' && expect == Expect::ObjKeyOrEnd {
						stack.pop();
						self.i += 1;
						expect = value_done(&stack);
						continue;
					}
					if b != b'"' {
						return invalid();
					}
					match self.string() {
						Scan::Dead => return invalid(),
						Scan::More => return JsonPrefixState::Prefix,
						Scan::Done => expect = Expect::ObjColon,
					}
				},
				Expect::ObjColon => {
					if b != b':' {
						return invalid();
					}
					self.i += 1;
					expect = Expect::Value;
				},
				Expect::ObjCommaOrEnd => {
					if b == b'}' {
						stack.pop();
						self.i += 1;
						expect = value_done(&stack);
						continue;
					}
					if b != b',' {
						return invalid();
					}
					self.i += 1;
					expect = Expect::ObjKey;
				},
				Expect::ArrCommaOrEnd => {
					if b == b']' {
						stack.pop();
						self.i += 1;
						expect = value_done(&stack);
						continue;
					}
					if b != b',' {
						return invalid();
					}
					self.i += 1;
					expect = Expect::Value;
				},
				// Trailing non-whitespace after a complete value.
				Expect::End => return invalid(),
			}
		}
		if expect == Expect::End {
			JsonPrefixState::Complete
		} else {
			JsonPrefixState::Prefix
		}
	}

	/// Consume a string starting at the opening quote.
	fn string(&mut self) -> Scan {
		let s = self.s;
		let n = s.len();
		self.i += 1; // opening quote
		while self.i < n {
			let b = s[self.i];
			if b == b'"' {
				self.i += 1;
				return Scan::Done;
			}
			if b == b'\\' {
				self.i += 1;
				if self.i >= n {
					return Scan::More;
				}
				let escape = s[self.i];
				if !is_valid_escape(escape) {
					return dead();
				}
				self.i += 1;
				if escape == b'u' {
					for _ in 0..4 {
						if self.i >= n {
							return Scan::More;
						}
						if !s[self.i].is_ascii_hexdigit() {
							return dead();
						}
						self.i += 1;
					}
				}
				continue;
			}
			if b < 0x20 {
				return dead(); // raw control char: strict JSON forbids it
			}
			self.i += 1;
		}
		Scan::More
	}

	/// Consume a number starting at `-` or a digit.
	const fn number(&mut self) -> Scan {
		let s = self.s;
		let n = s.len();
		if s[self.i] == b'-' {
			self.i += 1;
		}
		if self.i >= n {
			return Scan::More;
		}
		match s[self.i] {
			// 0: no further integer digits allowed.
			b'0' => self.i += 1,
			b'1'..=b'9' => {
				while self.i < n && s[self.i].is_ascii_digit() {
					self.i += 1;
				}
			},
			_ => return dead(),
		}
		if self.i < n && s[self.i] == b'.' {
			self.i += 1;
			if self.i >= n {
				return Scan::More;
			}
			if !s[self.i].is_ascii_digit() {
				return dead();
			}
			while self.i < n && s[self.i].is_ascii_digit() {
				self.i += 1;
			}
		}
		if self.i < n && matches!(s[self.i], b'e' | b'E') {
			self.i += 1;
			if self.i < n && matches!(s[self.i], b'+' | b'-') {
				self.i += 1;
			}
			if self.i >= n {
				return Scan::More;
			}
			if !s[self.i].is_ascii_digit() {
				return dead();
			}
			while self.i < n && s[self.i].is_ascii_digit() {
				self.i += 1;
			}
		}
		Scan::Done
	}

	/// Consume `true` / `false` / `null`; the caller guarantees the first
	/// byte is `t` / `f` / `n`, which picks the word uniquely.
	fn keyword(&mut self) -> Scan {
		for word in [&b"true"[..], b"false", b"null"] {
			if word[0] != self.s[self.i] {
				continue;
			}
			let available = word.len().min(self.s.len() - self.i);
			if self.s[self.i..self.i + available] != word[..available] {
				return dead();
			}
			self.i += available;
			return if available == word.len() {
				Scan::Done
			} else {
				Scan::More
			};
		}
		dead()
	}
}
