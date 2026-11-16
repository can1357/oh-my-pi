//! Cursor over the fixed escape-sequence grammars the input parser matches.
//!
//! Every recognizer in this module tree is an anchored, backtracking-free
//! pattern over ASCII syntax bytes (`ESC [ ? 2048 ; 1 $ y`), so a forward
//! cursor with a handful of primitives replaces the regular expressions the
//! JS implementation used.

/// Forward-only cursor over a sequence.
pub(super) struct Scan<'a> {
	text: &'a str,
	pos:  usize,
}

impl<'a> Scan<'a> {
	pub(super) const fn new(text: &'a str) -> Self {
		Self { text, pos: 0 }
	}

	/// Byte offset of the cursor.
	pub(super) const fn pos(&self) -> usize {
		self.pos
	}

	/// Whether the whole input was consumed.
	pub(super) const fn at_end(&self) -> bool {
		self.pos == self.text.len()
	}

	/// The unconsumed input.
	pub(super) fn rest(&self) -> &'a str {
		&self.text[self.pos..]
	}

	/// Consume `literal` when the remaining input starts with it.
	pub(super) fn eat(&mut self, literal: &str) -> bool {
		let matched = self.rest().starts_with(literal);
		if matched {
			self.pos += literal.len();
		}
		matched
	}

	/// Consume bytes while `accept` holds and return them.
	///
	/// `accept` must treat every non-ASCII byte the same way (all callers test
	/// ASCII classes or ASCII exclusions), which keeps the cursor on a char
	/// boundary.
	pub(super) fn take_while(&mut self, accept: impl Fn(u8) -> bool) -> &'a str {
		let rest = self.rest();
		let length = rest.bytes().take_while(|&byte| accept(byte)).count();
		self.pos += length;
		&rest[..length]
	}

	/// Consume one or more ASCII digits.
	pub(super) fn digits(&mut self) -> Option<&'a str> {
		let digits = self.take_while(|byte| byte.is_ascii_digit());
		(!digits.is_empty()).then_some(digits)
	}

	/// Consume one or more ASCII digits as a number (saturating).
	pub(super) fn number(&mut self) -> Option<u32> {
		self.digits().map(parse_saturating)
	}
}

/// Parse a run of ASCII digits, saturating at `u32::MAX` (JS `parseInt`
/// never fails on a digit run either).
pub(super) fn parse_saturating(digits: &str) -> u32 {
	digits.bytes().fold(0u32, |value, digit| {
		value
			.saturating_mul(10)
			.saturating_add(u32::from(digit.wrapping_sub(b'0')))
	})
}

/// The single Unicode scalar `text` consists of, if it is exactly one.
pub(super) fn single_scalar(text: &str) -> Option<char> {
	let mut chars = text.chars();
	match (chars.next(), chars.next()) {
		(Some(scalar), None) => Some(scalar),
		_ => None,
	}
}
