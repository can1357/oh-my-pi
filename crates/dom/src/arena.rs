use core::{fmt, num::NonZeroU64};

use serde::{Deserialize, Serialize};

/// Stable, nonzero identity of a DOM node.
///
/// Handles are allocated monotonically and are never reused, including after
/// a node is removed or a DOM is re-derived from a snapshot.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct Handle(NonZeroU64);

impl Handle {
	/// Creates a handle from its nonzero numeric representation.
	#[must_use]
	pub const fn new(value: u64) -> Option<Self> {
		match NonZeroU64::new(value) {
			Some(value) => Some(Self(value)),
			None => None,
		}
	}

	/// Returns the numeric representation.
	#[must_use]
	pub const fn get(self) -> u64 {
		self.0.get()
	}
}

impl fmt::Display for Handle {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		self.0.fmt(formatter)
	}
}
