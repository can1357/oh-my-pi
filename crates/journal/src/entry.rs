//! Journal entry identities and records.

use std::{fmt, str::FromStr};

use omp_core::{Str, Ulid, UlidParseError};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

use crate::Kind;

/// The identity of one journal entry.
#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EntryId(Ulid);

impl EntryId {
	/// Returns the underlying ULID.
	#[must_use]
	pub const fn as_ulid(self) -> Ulid {
		self.0
	}
}

impl fmt::Display for EntryId {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		self.0.fmt(formatter)
	}
}

impl FromStr for EntryId {
	type Err = UlidParseError;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		Ulid::from_string(value).map(Self)
	}
}

impl From<Ulid> for EntryId {
	fn from(value: Ulid) -> Self {
		Self(value)
	}
}

impl From<EntryId> for Ulid {
	fn from(value: EntryId) -> Self {
		value.0
	}
}

impl Serialize for EntryId {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: Serializer,
	{
		serializer.collect_str(self)
	}
}

impl<'de> Deserialize<'de> for EntryId {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: Deserializer<'de>,
	{
		let value = Str::deserialize(deserializer)?;
		value.as_str().parse().map_err(de::Error::custom)
	}
}

/// One committed journal entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
	/// Monotonic entry identity.
	pub id:    EntryId,
	/// Versioned event kind.
	pub kind:  Kind,
	/// Entry that caused this entry, absent only for genesis.
	pub by:    Option<EntryId>,
	/// Explicit branch parent; absence means the previous file entry.
	pub prior: Option<EntryId>,
	/// Optional non-normative operation label.
	pub label: Option<Str>,
	/// Single-line JSON payload.
	pub data:  Str,
}

/// One entry waiting for the journal to assign its identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryDraft {
	/// Versioned event kind.
	pub kind:  Kind,
	/// Entry that caused this entry, absent only for genesis.
	pub by:    Option<EntryId>,
	/// Explicit branch parent; absence means the current file tip.
	pub prior: Option<EntryId>,
	/// Optional non-normative operation label.
	pub label: Option<Str>,
	/// Single-line JSON payload.
	pub data:  Str,
}
