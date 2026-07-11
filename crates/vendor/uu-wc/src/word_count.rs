// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.
use std::{
	cmp::max,
	ops::{Add, AddAssign},
};

#[derive(Debug, Default, Copy, Clone)]
pub struct WordCount {
	pub bytes:           usize,
	pub chars:           usize,
	pub lines:           usize,
	pub words:           usize,
	pub max_line_length: usize,
}

impl Add for WordCount {
	type Output = Self;

	fn add(self, other: Self) -> Self {
		Self {
			bytes:           self.bytes + other.bytes,
			chars:           self.chars + other.chars,
			lines:           self.lines + other.lines,
			words:           self.words + other.words,
			max_line_length: max(self.max_line_length, other.max_line_length),
		}
	}
}

impl AddAssign for WordCount {
	fn add_assign(&mut self, other: Self) {
		*self = *self + other;
	}
}
