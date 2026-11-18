//! What happened to a path, as a bit set.

use std::{
	fmt,
	ops::{BitAnd, BitOr, BitOrAssign, Not},
};

/// The changes one [`Event`](crate::watch::Event) reports, and what its path is.
///
/// The bits are those of fswatch's `fsw_event_flag`, so a numeric rendering
/// matches `fswatch --numeric`.
#[derive(Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct Flags(u32);

/// Every named flag, in bit order, with fswatch's name for it.
const NAMES: [(Flags, &str); 15] = [
	(Flags::PLATFORM_SPECIFIC, "PlatformSpecific"),
	(Flags::CREATED, "Created"),
	(Flags::UPDATED, "Updated"),
	(Flags::REMOVED, "Removed"),
	(Flags::RENAMED, "Renamed"),
	(Flags::OWNER_MODIFIED, "OwnerModified"),
	(Flags::ATTRIBUTE_MODIFIED, "AttributeModified"),
	(Flags::MOVED_FROM, "MovedFrom"),
	(Flags::MOVED_TO, "MovedTo"),
	(Flags::IS_FILE, "IsFile"),
	(Flags::IS_DIR, "IsDir"),
	(Flags::IS_SYMLINK, "IsSymLink"),
	(Flags::LINK, "Link"),
	(Flags::OVERFLOW, "Overflow"),
	(Flags::CLOSE_WRITE, "CloseWrite"),
];

impl Flags {
	/// The path's attributes (mode, times, extended attributes) changed.
	pub const ATTRIBUTE_MODIFIED: Self = Self(1 << 6);
	/// A file opened for writing was closed.
	pub const CLOSE_WRITE: Self = Self(1 << 14);
	/// The path was created.
	pub const CREATED: Self = Self(1 << 1);
	/// The path is a directory.
	pub const IS_DIR: Self = Self(1 << 10);
	/// The path is a regular file (or, where the system does not tell, not a
	/// directory).
	pub const IS_FILE: Self = Self(1 << 9);
	/// The path is a symbolic link.
	pub const IS_SYMLINK: Self = Self(1 << 11);
	/// The path's hard-link count changed.
	pub const LINK: Self = Self(1 << 12);
	/// The path is the old name of a rename.
	pub const MOVED_FROM: Self = Self(1 << 7);
	/// The path is the new name of a rename.
	pub const MOVED_TO: Self = Self(1 << 8);
	/// No change.
	pub const NO_OP: Self = Self(0);
	/// Changes were lost; anything below the path (a root) may have changed.
	pub const OVERFLOW: Self = Self(1 << 13);
	/// The path's owner or group changed.
	pub const OWNER_MODIFIED: Self = Self(1 << 5);
	/// A change only this platform reports (an access, a mount); the raw
	/// value is in [`Event::native`](crate::watch::Event::native).
	pub const PLATFORM_SPECIFIC: Self = Self(1 << 0);
	/// The path was removed.
	pub const REMOVED: Self = Self(1 << 3);
	/// The path was renamed; one of [`Flags::MOVED_FROM`] and
	/// [`Flags::MOVED_TO`] accompanies it when the system tells which name
	/// this is.
	pub const RENAMED: Self = Self(1 << 4);
	/// The flags that describe the path rather than a change to it.
	pub const TYPES: Self = Self(Self::IS_FILE.0 | Self::IS_DIR.0 | Self::IS_SYMLINK.0);
	/// The path's content changed.
	pub const UPDATED: Self = Self(1 << 2);

	/// The raw bits.
	#[must_use]
	pub const fn bits(self) -> u32 {
		self.0
	}

	/// The flags of `bits`; unnamed bits are kept.
	#[must_use]
	pub const fn from_bits(bits: u32) -> Self {
		Self(bits)
	}

	/// Whether every flag of `other` is set.
	#[must_use]
	pub const fn contains(self, other: Self) -> bool {
		self.0 & other.0 == other.0
	}

	/// Whether any flag of `other` is set.
	#[must_use]
	pub const fn intersects(self, other: Self) -> bool {
		self.0 & other.0 != 0
	}

	/// Whether no flag is set.
	#[must_use]
	pub const fn is_empty(self) -> bool {
		self.0 == 0
	}

	/// These flags with those of `other` set as well.
	#[must_use]
	pub const fn union(self, other: Self) -> Self {
		Self(self.0 | other.0)
	}

	/// These flags without those of `other`.
	#[must_use]
	pub const fn difference(self, other: Self) -> Self {
		Self(self.0 & !other.0)
	}

	/// fswatch's names of the set flags, in bit order.
	pub fn names(self) -> impl Iterator<Item = &'static str> {
		NAMES
			.iter()
			.filter(move |(flag, _)| self.contains(*flag))
			.map(|&(_, name)| name)
	}

	/// The flag fswatch names `name` (`Created`, `IsDir`, `NoOp`, …).
	#[must_use]
	pub fn from_name(name: &str) -> Option<Self> {
		if name == "NoOp" {
			return Some(Self::NO_OP);
		}
		NAMES
			.iter()
			.find(|(_, known)| *known == name)
			.map(|&(flag, _)| flag)
	}
}

impl BitOr for Flags {
	type Output = Self;

	fn bitor(self, other: Self) -> Self {
		self.union(other)
	}
}

impl BitOrAssign for Flags {
	fn bitor_assign(&mut self, other: Self) {
		self.0 |= other.0;
	}
}

impl BitAnd for Flags {
	type Output = Self;

	fn bitand(self, other: Self) -> Self {
		Self(self.0 & other.0)
	}
}

impl Not for Flags {
	type Output = Self;

	fn not(self) -> Self {
		Self(!self.0)
	}
}

impl fmt::Debug for Flags {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		if self.is_empty() {
			return f.write_str("NoOp");
		}
		for (index, name) in self.names().enumerate() {
			if index > 0 {
				f.write_str("|")?;
			}
			f.write_str(name)?;
		}
		Ok(())
	}
}
