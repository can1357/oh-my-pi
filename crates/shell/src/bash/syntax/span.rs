//! Source positions: byte spans, parser resume points and AST node ids.

use serde::{Deserialize, Serialize};

/// Half-open byte range `[lo, hi)` into the source the parser was given.
///
/// The engine re-bases spans to the start of each compiled unit before they
/// appear in events, so a client re-parsing the unit bytes sees the same
/// offsets.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Span {
	/// First byte.
	pub lo: u32,
	/// One past the last byte.
	pub hi: u32,
}

impl Span {
	/// Span covering `[lo, hi)`.
	pub const fn new(lo: u32, hi: u32) -> Self {
		Self { lo, hi }
	}

	/// The bytes this span covers in `src`; empty when out of range.
	pub fn slice(self, src: &[u8]) -> &[u8] {
		src.get(self.lo as usize..self.hi as usize)
			.unwrap_or_default()
	}

	/// The same span shifted down by `base` (re-basing to a unit start).
	pub const fn rebase(self, base: u32) -> Self {
		Self { lo: self.lo.saturating_sub(base), hi: self.hi.saturating_sub(base) }
	}
}

/// Preorder index of an AST node within one
/// [`CompleteCommand`](crate::bash::syntax::CompleteCommand).
///
/// Ids are deterministic for a given (bytes,
/// [`Features`](crate::bash::syntax::Features), alias substitutions): a client
/// re-parsing the bytes announced in a `UnitCompiled` event gets identical ids.
/// Named `NodeId` inside this crate only; the engine re-exports it as
/// `AstNodeId` so it never collides with the mesh node id of other parts.
#[derive(
	Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
pub struct NodeId(pub u32);

/// Parser resume point: byte offset plus the 1-based line at that offset.
///
/// The engine parses one top-level command at a time and resumes the next
/// parse from the previous [`Parser::pos`](crate::bash::syntax::Parser::pos),
/// so alias and option changes take effect on the next command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Pos {
	/// Byte offset into the source.
	pub offset: u32,
	/// 1-based line number at `offset`.
	pub line:   u32,
}

impl Pos {
	/// Start of a source.
	pub const START: Self = Self { offset: 0, line: 1 };
}

impl Default for Pos {
	fn default() -> Self {
		Self::START
	}
}
