// Copyright 2017 Google Inc.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

use std::{error::Error, io::Write, str::FromStr};

use pi_uutils_ctx::stderr;

use super::{ComparableValue, Matcher, MatcherIO, WalkEntry};

#[derive(Clone, Copy, Debug)]
enum Unit {
	Byte,
	TwoByteWord,
	Block,
	KibiByte,
	MebiByte,
	GibiByte,
}

impl FromStr for Unit {
	type Err = Box<dyn Error>;

	fn from_str(s: &str) -> Result<Self, Box<dyn Error>> {
		Ok(match s {
			"c" => Self::Byte,
			"w" => Self::TwoByteWord,
			"" | "b" => Self::Block,
			"k" => Self::KibiByte,
			"M" => Self::MebiByte,
			"G" => Self::GibiByte,
			_ => {
				return Err(From::from(format!(
					"Invalid suffix {s} for -size. Only allowed values are <nothing>, b, c, w, k, M or \
					 G"
				)));
			},
		})
	}
}

fn byte_size_to_unit_size(unit: Unit, byte_size: u64) -> u64 {
	// Short circuit (to avoid a overflow error when subtracting 1 later on)
	if byte_size == 0 {
		return 0;
	}
	let bits_to_shift = match unit {
		Unit::Byte => 0,
		Unit::TwoByteWord => 1,
		Unit::Block => 9,
		Unit::KibiByte => 10,
		Unit::MebiByte => 20,
		Unit::GibiByte => 30,
	};
	// Skip pointless arithmetic.
	if bits_to_shift == 0 {
		return byte_size;
	}
	// We want to round up (e.g. 1 byte - 1024 bytes = 1k.
	// 1025 bytes to 2048 bytes = 2k etc.
	((byte_size - 1) >> bits_to_shift) + 1
}

/// Matcher that checks whether a file's size if {less than | equal to | more
/// than} N units in size.
pub struct SizeMatcher {
	value_to_match: ComparableValue,
	unit:           Unit,
}

impl SizeMatcher {
	pub fn new(
		value_to_match: ComparableValue,
		suffix_string: &str,
	) -> Result<Self, Box<dyn Error>> {
		Ok(Self { unit: suffix_string.parse()?, value_to_match })
	}
}

impl Matcher for SizeMatcher {
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		match file_info.metadata() {
			Ok(metadata) => self
				.value_to_match
				.matches(byte_size_to_unit_size(self.unit, metadata.len())),
			Err(e) => {
				writeln!(
					&mut stderr(),
					"Error getting file size for {}: {}",
					file_info.path().to_string_lossy(),
					e
				)
				.unwrap();
				false
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::find::{matchers::tests::get_dir_entry_for, tests::FakeDependencies};

	#[test]
	fn test_byte_size_to_unit_size() {
		assert_eq!(byte_size_to_unit_size(Unit::KibiByte, 0), 0);
		assert_eq!(byte_size_to_unit_size(Unit::KibiByte, 1), 1);
		assert_eq!(byte_size_to_unit_size(Unit::KibiByte, 1024), 1);
		assert_eq!(byte_size_to_unit_size(Unit::KibiByte, 1025), 2);
		assert_eq!(byte_size_to_unit_size(Unit::Byte, 1025), 1025);
		assert_eq!(byte_size_to_unit_size(Unit::TwoByteWord, 1025), 513);
		assert_eq!(byte_size_to_unit_size(Unit::Block, 1025), 3);
		assert_eq!(byte_size_to_unit_size(Unit::KibiByte, 1025), 2);
		assert_eq!(byte_size_to_unit_size(Unit::MebiByte, 1024 * 1024 + 1), 2);
		assert_eq!(byte_size_to_unit_size(Unit::GibiByte, 1024 * 1024 * 1024 + 1), 2);
	}

	#[test]
	fn unit_from_string() {
		assert_eq!(byte_size_to_unit_size("c".parse().unwrap(), 2), 2);
		assert_eq!(byte_size_to_unit_size("w".parse().unwrap(), 3), 2);
		assert_eq!(byte_size_to_unit_size("b".parse().unwrap(), 513), 2);
		assert_eq!(byte_size_to_unit_size("".parse().unwrap(), 513), 2);
		assert_eq!(byte_size_to_unit_size("k".parse().unwrap(), 1025), 2);
		assert_eq!(byte_size_to_unit_size("M".parse().unwrap(), 1024 * 1024 + 1), 2);
		assert_eq!(byte_size_to_unit_size("G".parse().unwrap(), 2024 * 1024 * 1024 + 1), 2);
	}

	#[test]
	fn size_matcher_bad_unit() {
		if let Err(e) = SizeMatcher::new(ComparableValue::EqualTo(2), "xyz") {
			assert!(
				e.to_string().contains("Invalid suffix") && e.to_string().contains("xyz"),
				"bad description: {e}"
			);
		} else {
			panic!("parsing a unit string should fail");
		}
	}

	#[test]
	fn size_matcher() {
		let file_info = get_dir_entry_for("./test_data/size", "512bytes");

		let equal_to_2_blocks = SizeMatcher::new(ComparableValue::EqualTo(2), "b").unwrap();
		let equal_to_1_blocks = SizeMatcher::new(ComparableValue::EqualTo(1), "b").unwrap();
		let deps = FakeDependencies::new();

		assert!(
			!equal_to_2_blocks.matches(&file_info, &mut deps.new_matcher_io()),
			"512-byte file should not match size of 2 blocks"
		);
		assert!(
			equal_to_1_blocks.matches(&file_info, &mut deps.new_matcher_io()),
			"512-byte file should match size of 1 block"
		);
	}
}
