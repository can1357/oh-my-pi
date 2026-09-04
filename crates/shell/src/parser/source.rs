use std::{
	fmt::{self, Display},
	sync::Arc,
};

/// Represents a position in source text.
#[derive(Clone, Default, Debug)]
#[cfg_attr(test, derive(PartialEq, Eq, serde::Serialize, serde::Deserialize))]
pub struct SourcePosition {
	/// The 0-based index of the character in the input stream.
	pub index:  usize,
	/// The 1-based line number.
	pub line:   usize,
	/// The 1-based column number.
	pub column: usize,
}

impl Display for SourcePosition {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_fmt(format_args!("{},{}", self.line, self.column))
	}
}

impl SourcePosition {
	/// Returns a new `SourcePosition` offset by the given
	/// `SourcePositionOffset`.
	///
	/// # Arguments
	///
	/// * `offset` - The offset to apply.
	pub const fn offset(&self, offset: &SourcePositionOffset) -> Self {
		Self {
			index:  self.index + offset.index,
			line:   self.line + offset.line,
			column: if offset.line == 0 {
				self.column + offset.column
			} else {
				offset.column + 1
			},
		}
	}
}

/// Represents an offset in source text.
#[derive(Clone, Default, Debug)]
#[cfg_attr(test, derive(PartialEq, Eq, serde::Serialize, serde::Deserialize))]
pub struct SourcePositionOffset {
	/// The 0-based character offset.
	pub index:  usize,
	/// The 0-based line offset.
	pub line:   usize,
	/// The 0-based column offset.
	pub column: usize,
}

/// Represents a span within source text.
#[derive(Clone, Default, Debug)]
#[cfg_attr(test, derive(PartialEq, Eq, serde::Serialize, serde::Deserialize))]
pub struct SourceSpan {
	/// The start position.
	pub start: Arc<SourcePosition>,
	/// The end position of the span (exclusive).
	pub end:   Arc<SourcePosition>,
}

impl SourceSpan {
	/// Returns the length of the token in characters.
	pub fn length(&self) -> usize {
		self.end.index - self.start.index
	}

	pub(crate) fn within(start: &Self, end: &Self) -> Self {
		Self { start: start.start.clone(), end: end.end.clone() }
	}
}
