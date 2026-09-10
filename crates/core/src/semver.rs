//! Compact semantic versions and compile-time literals.

use serde::{Deserialize, Serialize};

/// Three-component semantic version stored in three bytes.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct SemVer {
	/// Major version.
	pub major: u8,
	/// Minor version.
	pub minor: u8,
	/// Patch version.
	pub patch: u8,
}

const _: () = assert!(size_of::<SemVer>() == 3, "SemVer must stay 3 bytes");

impl SemVer {
	/// Creates a semantic version from its three components.
	pub const fn new(major: u8, minor: u8, patch: u8) -> Self {
		Self { major, minor, patch }
	}

	/// Parses the token spelling captured by [`semver!`](crate::semver).
	///
	/// # Panics
	///
	/// Panics when the literal is malformed or any component exceeds [`u8`].
	#[doc(hidden)]
	pub const fn __from_macro_literal(literal: &str) -> Self {
		let bytes = literal.as_bytes();
		let mut components = [0_u8; 3];
		let mut component = 0_usize;
		let mut has_digit = false;
		let mut index = 0_usize;

		while index < bytes.len() {
			let byte = bytes[index];
			if byte.is_ascii_digit() {
				let Some(value) = components[component].checked_mul(10) else {
					panic!("semantic version components must fit in u8");
				};
				let Some(value) = value.checked_add(byte - b'0') else {
					panic!("semantic version components must fit in u8");
				};
				components[component] = value;
				has_digit = true;
			} else if byte == b'.' {
				assert!(has_digit && component != 2, "expected major.minor or major.minor.patch");
				component += 1;
				has_digit = false;
			} else {
				panic!("semantic version literals contain only digits and dots");
			}
			index += 1;
		}

		assert!(has_digit && component != 0, "expected major.minor or major.minor.patch");
		Self::new(components[0], components[1], components[2])
	}
}

/// Creates a compact [`SemVer`] from `major.minor` or `major.minor.patch`.
///
/// An omitted patch component defaults to zero. Every component must fit in a
/// [`u8`]; invalid literals fail during constant evaluation.
///
/// # Example
///
/// ```
/// use omp_core::{SemVer, semver};
///
/// const VERSION: SemVer = semver!(5.6);
/// assert_eq!(VERSION, SemVer::new(5, 6, 0));
/// ```
///
/// Components above 255 are rejected at compile time:
///
/// ```compile_fail
/// use omp_core::semver;
///
/// let _ = semver!(256.0);
/// ```
#[macro_export]
macro_rules! semver {
	($major_minor:literal) => {{
		const VERSION: $crate::SemVer =
			$crate::SemVer::__from_macro_literal(stringify!($major_minor));
		VERSION
	}};
	($major_minor:literal. $patch:literal) => {{
		const VERSION: $crate::SemVer = $crate::SemVer::__from_macro_literal(concat!(
			stringify!($major_minor),
			".",
			stringify!($patch)
		));
		VERSION
	}};
}

#[cfg(test)]
mod tests {
	use super::SemVer;
	const TWO_COMPONENTS: SemVer = semver!(5.6);
	const THREE_COMPONENTS: SemVer = semver!(5.6.7);
	const MAX_COMPONENTS: SemVer = semver!(255.255.255);

	#[test]
	fn macro_defaults_patch_and_supports_three_components() {
		assert_eq!(TWO_COMPONENTS, SemVer::new(5, 6, 0));
		assert_eq!(THREE_COMPONENTS, SemVer::new(5, 6, 7));
		assert_eq!(MAX_COMPONENTS, SemVer::new(u8::MAX, u8::MAX, u8::MAX));
	}
}
