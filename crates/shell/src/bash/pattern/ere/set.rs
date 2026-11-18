//! Compiled bracket expressions of an ERE.

use crate::bash::pattern::{class::Class, ere::unit::Mode};

/// One member of a bracket expression; units are stored folded when the
/// regex ignores case.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Item {
	/// A single character, `[.c.]` or `[=c=]`.
	Unit(u32),
	/// `a-z`, by code point (or byte) value.
	Range(u32, u32),
	/// `[:alpha:]` and friends.
	Class(Class),
}

/// A bracket expression: `[abc]`, `[^a-z]`, `[[:alpha:]_]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Set {
	negated: bool,
	items:   Vec<Item>,
	/// Membership of the ASCII units, precomputed (before negation).
	ascii:   u128,
}

impl Set {
	/// Compile the members of a bracket expression.
	pub fn new(negated: bool, items: Vec<Item>, mode: Mode) -> Self {
		let mut set = Self { negated, items, ascii: 0 };
		set.ascii = (0..128u32)
			.filter(|&u| set.member(mode, u))
			.fold(0, |bits, u| bits | (1 << u));
		set
	}

	fn member(&self, mode: Mode, u: u32) -> bool {
		self.items.iter().any(|item| match *item {
			Item::Unit(c) => c == u,
			Item::Range(lo, hi) => (lo..=hi).contains(&u),
			Item::Class(class) => mode.in_class(class, u),
		})
	}

	/// Whether the (already folded) unit `u` matches.
	pub fn matches(&self, mode: Mode, u: u32) -> bool {
		let hit = if u < 128 {
			(self.ascii >> u) & 1 == 1
		} else {
			self.member(mode, u)
		};
		hit != self.negated
	}
}
