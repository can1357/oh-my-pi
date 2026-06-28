// Copyright 2017 Google Inc.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

use std::{fs::File, io::Write};

use pi_uutils_ctx::stderr;

use super::{Matcher, MatcherIO, WalkEntry};

pub enum PrintDelimiter {
	Newline,
	Null,
}

impl std::fmt::Display for PrintDelimiter {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Newline => writeln!(f),
			Self::Null => write!(f, "\0"),
		}
	}
}

/// This matcher just prints the name of the file to stdout.
pub struct Printer {
	delimiter:   PrintDelimiter,
	output_file: Option<File>,
}

impl Printer {
	pub fn new(delimiter: PrintDelimiter, output_file: Option<File>) -> Self {
		Self { delimiter, output_file }
	}

	fn print(
		&self,
		file_info: &WalkEntry,
		matcher_io: &mut MatcherIO,
		mut out: impl Write,
		print_error_message: bool,
	) {
		match write!(out, "{}{}", file_info.display_path().to_string_lossy(), self.delimiter) {
			Ok(_) => {},
			Err(e) => {
				if print_error_message {
					writeln!(
						&mut stderr(),
						"Error writing {:?} for {}",
						file_info.display_path().to_string_lossy(),
						e
					)
					.unwrap();
					matcher_io.set_exit_code(1);
				}
			},
		}
		out.flush().unwrap();
	}
}

impl Matcher for Printer {
	fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
		if let Some(file) = &self.output_file {
			self.print(file_info, matcher_io, file, true);
		} else {
			self.print(file_info, matcher_io, &mut *matcher_io.deps.get_output().borrow_mut(), false);
		}
		true
	}

	fn has_side_effects(&self) -> bool {
		true
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::find::{
		matchers::tests::get_dir_entry_for,
		tests::{FakeDependencies, fix_up_slashes},
	};

	#[test]
	fn prints_newline() {
		let abbbc = get_dir_entry_for("./test_data/simple", "abbbc");

		let matcher = Printer::new(PrintDelimiter::Newline, None);
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
		assert_eq!(fix_up_slashes("./test_data/simple/abbbc\n"), deps.get_output_as_string());
	}

	#[test]
	fn prints_null() {
		let abbbc = get_dir_entry_for("./test_data/simple", "abbbc");

		let matcher = Printer::new(PrintDelimiter::Null, None);
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
		assert_eq!(fix_up_slashes("./test_data/simple/abbbc\0"), deps.get_output_as_string());
	}

	#[test]
	#[cfg(target_os = "linux")]
	fn prints_error_message() {
		let dev_full = File::open("/dev/full").unwrap();
		let abbbc = get_dir_entry_for("./test_data/simple", "abbbc");

		let matcher = Printer::new(PrintDelimiter::Newline, Some(dev_full));
		let deps = FakeDependencies::new();

		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
		assert!(deps.get_output_as_string().is_empty());
	}
}
