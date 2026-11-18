//! Variant names of the engine's large fieldless enums, packed into one
//! byte array at compile time.
//!
//! A `match` that returns a `&'static str` per variant (what strum's
//! `IntoStaticStr` and `Display` derive, inlined at every use) compiles to
//! a lookup table of string pointers: one dynamic relocation per variant
//! and per inlined copy, which the loader applies at every process start
//! (about 32 instructions each in glibc 2.43). The names here are strum's
//! own (`VariantNames`, the spellings `IntoStaticStr` would give), copied
//! at compile time into an array of bytes and one of end offsets: no
//! pointers, nothing to relocate.
//!
//! Do not revert these enums to `#[derive(IntoStaticStr, Display)]`: that
//! was measured at +1,340 relocations, +3.9 % instructions on every
//! `obash` start.

/// Bytes of all `names` together.
pub const fn packed_len(names: &[&str]) -> usize {
	let mut n = 0;
	let mut i = 0;
	while i < names.len() {
		n += names[i].len();
		i += 1;
	}
	n
}

/// The names of `N` variants packed into `BYTES` bytes; built by
/// [`PackedNames::new`] in a `static` (see [`packed_names!`]).
pub struct PackedNames<const BYTES: usize, const N: usize> {
	bytes: [u8; BYTES],
	/// End offset of each name in `bytes`.
	ends:  [u16; N],
}

impl<const BYTES: usize, const N: usize> PackedNames<BYTES, N> {
	/// Pack `names` (an enum's `strum::VariantNames::VARIANTS`); a size
	/// mismatch fails the constant's evaluation, so the build.
	pub const fn new(names: &[&str]) -> Self {
		assert!(names.len() == N && packed_len(names) == BYTES && BYTES <= u16::MAX as usize);
		let mut bytes = [0_u8; BYTES];
		let mut ends = [0_u16; N];
		let mut at = 0;
		let mut i = 0;
		while i < N {
			let name = names[i].as_bytes();
			let mut j = 0;
			while j < name.len() {
				bytes[at] = name[j];
				at += 1;
				j += 1;
			}
			ends[i] = at as u16;
			i += 1;
		}
		Self { bytes, ends }
	}

	/// The name of variant `i` (`""` past the last one).
	pub fn get(&'static self, i: usize) -> &'static str {
		let start = match i.checked_sub(1) {
			Some(prev) => self.ends.get(prev).map_or(0, |&e| usize::from(e)),
			None => 0,
		};
		let end = self.ends.get(i).map_or(start, |&e| usize::from(e));
		// Whole names cut from valid UTF-8: the check never fails.
		self
			.bytes
			.get(start..end)
			.and_then(|b| std::str::from_utf8(b).ok())
			.unwrap_or_default()
	}
}

/// `From<E>` and `From<&E>` for `&'static str` (and with `, Display` the
/// `Display` impl) of fieldless enum `E` (deriving `strum::VariantNames`;
/// variants without explicit discriminants, so `e as usize` is the
/// declaration index) from its packed names: what strum's `IntoStaticStr`
/// and `Display` give, without a relocated pointer table.
macro_rules! packed_names {
	($ty:ty,Display) => {
		$crate::bash::packed_names::packed_names!($ty);

		impl std::fmt::Display for $ty {
			fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
				f.pad(<&'static str>::from(*self))
			}
		}
	};
	($ty:ty) => {
		impl From<$ty> for &'static str {
			fn from(v: $ty) -> Self {
				static NAMES: $crate::bash::packed_names::PackedNames<
					{ $crate::bash::packed_names::packed_len(<$ty as strum::VariantNames>::VARIANTS) },
					{ <$ty as strum::VariantNames>::VARIANTS.len() },
				> =
					$crate::bash::packed_names::PackedNames::new(<$ty as strum::VariantNames>::VARIANTS);
				NAMES.get(v as usize)
			}
		}

		impl From<&$ty> for &'static str {
			fn from(v: &$ty) -> Self {
				Self::from(*v)
			}
		}
	};
}

pub(crate) use packed_names;

#[cfg(test)]
mod tests {
	use std::str::FromStr;

	use strum::{IntoEnumIterator, VariantNames};

	use crate::bash::{
		diag::DiagCode,
		event::{EventKind, NodeKind},
		host::Rlimit,
		ids::{IntrinsicId, ModeId},
		ir::Opcode,
		signal::Signal,
		store::{MiscKey, OptId, Table},
		zshopt::ZshOpt,
	};

	/// Variant `i` in declaration order is named `VARIANTS[i]` (no
	/// explicit discriminant shifts `e as usize`).
	fn by_iter<E>()
	where
		E: IntoEnumIterator + VariantNames + Copy + std::fmt::Debug,
		&'static str: From<E>,
	{
		assert_eq!(E::iter().count(), E::VARIANTS.len());
		for (v, &name) in E::iter().zip(E::VARIANTS) {
			assert!(!name.is_empty(), "{v:?} has no name");
			assert_eq!(<&'static str>::from(v), name, "{v:?}");
		}
	}

	/// Every name parses (strum) to the variant it is the packed name of.
	fn by_parse<E>()
	where
		E: FromStr + VariantNames + Copy,
		&'static str: From<E>,
	{
		for &name in E::VARIANTS {
			let v = E::from_str(name)
				.ok()
				.unwrap_or_else(|| panic!("{name} does not parse"));
			assert_eq!(<&'static str>::from(v), name);
		}
	}

	#[test]
	fn packed_names_follow_declaration_order() {
		by_iter::<ZshOpt>();
		by_iter::<IntrinsicId>();
		by_iter::<OptId>();
		by_iter::<Signal>();
		by_iter::<EventKind>();
		by_iter::<Table>();
		by_iter::<Rlimit>();
		by_iter::<DiagCode>();
		by_parse::<ZshOpt>();
		by_parse::<IntrinsicId>();
		by_parse::<OptId>();
		by_parse::<Signal>();
		by_parse::<Opcode>();
		by_parse::<MiscKey>();
		by_parse::<NodeKind>();
		by_parse::<ModeId>();
	}

	#[test]
	fn display_pads_like_str() {
		assert_eq!(format!("{:>8}", ZshOpt::Xtrace), "  xtrace");
		assert_eq!(format!("{:<6}|", Signal::Int), "INT   |");
	}
}
