// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.
// spell-checker:ignore dired subdired

use std::{
	cell::RefCell,
	fmt,
	io::{BufWriter, Write},
};

use pi_uutils_ctx::CtxStdout;
use uucore::error::UResult;

/// `dired` Module Documentation
///
/// This module handles the --dired output format, representing file and
/// directory listings.
///
/// Key Mechanisms:
/// 1. **Position Tracking**:
///    - The module tracks byte positions for each file or directory entry.
///    - `BytePosition`: Represents a byte range with start and end positions.
///    - `DiredOutput`: Contains positions for DIRED and SUBDIRED outputs and
///      maintains a padding value.
///
/// 2. **Padding**:
///    - Padding is used when dealing with directory names or the "total" line.
///    - The module adjusts byte positions by adding padding for these cases.
///    - This ensures correct offset for subsequent files or directories.
///
/// 3. **Position Calculation**:
///    - Functions like `calculate_dired`, `calculate_subdired`, and
///      `calculate_and_update_positions` compute byte positions based on output
///      length, previous positions, and padding.
///
/// 4. **Output**:
///    - The module provides functions to print the DIRED output
///      (`print_dired_output`) based on calculated positions and configuration.
///    - Helpers like `print_positions` print positions with specific prefixes.
///
/// Overall, the module ensures each entry in the DIRED output has the correct
/// byte position, considering additional lines or padding affecting positions.
use crate::Config;

#[derive(Debug, Clone, PartialEq)]
pub struct BytePosition {
	pub start: usize,
	pub end:   usize,
}

/// Represents the output structure for DIRED, containing positions for both
/// DIRED and SUBDIRED.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DiredOutput {
	pub dired_positions:    Vec<BytePosition>,
	pub subdired_positions: Vec<BytePosition>,
	pub padding:            usize,
	pub line_offset:        usize,
}

impl fmt::Display for BytePosition {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{} {}", self.start, self.end)
	}
}

// When --dired is used, all lines starts with 2 spaces
static DIRED_TRAILING_OFFSET: usize = 2;

/// Calculates the byte positions for DIRED
pub fn calculate_dired(
	dired: &DiredOutput,
	output_display_len: usize,
	dfn_len: usize,
) -> (usize, usize) {
	let offset_from_previous_line = dired.line_offset;

	let start = output_display_len + offset_from_previous_line;
	let end = start + dfn_len;
	(start, end)
}

pub fn indent(out: &mut BufWriter<CtxStdout>) -> UResult<()> {
	write!(out, "  ")?;
	Ok(())
}

pub fn calculate_subdired(dired: &mut DiredOutput, path_len: usize) {
	let offset_from_previous_line = dired.line_offset + dired.padding;
	let start = offset_from_previous_line + DIRED_TRAILING_OFFSET;
	let end = start + path_len;
	dired.subdired_positions.push(BytePosition { start, end });
}

/// Prints the dired output based on the given configuration and dired
/// structure.
pub fn print_dired_output(
	config: &Config,
	dired: &DiredOutput,
	out: &mut BufWriter<CtxStdout>,
) -> UResult<()> {
	out.flush()?;
	if !dired.dired_positions.is_empty() {
		print_positions(out, "//DIRED//", &dired.dired_positions)?;
	}
	// SUBDIRED is needed whenever directory headings are printed (multiple args or
	// -R), so don't gate it on config.recursive.
	if !dired.subdired_positions.is_empty() {
		print_positions(out, "//SUBDIRED//", &dired.subdired_positions)?;
	}
	writeln!(out, "//DIRED-OPTIONS// --quoting-style={}", config.quoting_style)?;
	Ok(())
}

/// Helper function to print positions with a given prefix.
fn print_positions(
	out: &mut BufWriter<CtxStdout>,
	prefix: &str,
	positions: &[BytePosition],
) -> UResult<()> {
	write!(out, "{prefix}")?;
	for c in positions {
		write!(out, " {c}")?;
	}
	writeln!(out)?;
	Ok(())
}

pub fn add_total(dired: &mut DiredOutput, total_len: usize) {
	dired.padding += total_len + DIRED_TRAILING_OFFSET;
}

// when using -R, we have the dirname. we need to add it to the padding
pub fn add_dir_name(dired: &mut DiredOutput, dir_len: usize) {
	// "  dirname:\n"
	dired.padding += dir_len + DIRED_TRAILING_OFFSET + 2;
}

/// Calculates byte positions and updates the dired structure.
pub fn calculate_and_update_positions(
	dired: &mut DiredOutput,
	output_display_len: usize,
	dfn_len: usize,
	line_len: usize,
) {
	let (start, end) = calculate_dired(dired, output_display_len, dfn_len);
	update_positions(dired, start, end, line_len);
}

/// Updates the dired positions based on the given start and end positions.
/// update when it is the first element in the list (to manage "total X")
/// insert when it isn't the about total
pub fn update_positions(dired: &mut DiredOutput, start: usize, end: usize, line_len: usize) {
	// padding can be 0 but as it doesn't matter
	let padding = dired.padding;
	dired
		.dired_positions
		.push(BytePosition { start: start + padding, end: end + padding });
	dired.line_offset += padding + line_len;
	// Remove the previous padding
	dired.padding = 0;
}

thread_local! {
	 /// Records whether the current invocation's argv contained a raw
	 /// `--dired`/`-D` operand. Upstream scans the process args; in-process the
	 /// builtin's argv is recorded by `run` via [`set_dired_arg_present`].
	 static DIRED_ARG_PRESENT: RefCell<bool> = const { RefCell::new(false) };
}

/// pi-uutils: records whether `--dired`/`-D` appears in the builtin's argv.
/// Called by `run` before clap parsing; replaces the upstream process-global
/// argument scan, which would otherwise read the host process arguments.
pub fn set_dired_arg_present(args: &[std::ffi::OsString]) {
	let present = args
		.iter()
		.any(|x| x.as_encoded_bytes() == b"--dired" || x.as_encoded_bytes() == b"-D");
	DIRED_ARG_PRESENT.with(|c| *c.borrow_mut() = present);
}

/// Checks if the "--dired" or "-D" argument was present in the builtin's argv.
/// we don't use clap here because we need to know if the argument is present
/// as it can be overridden by --hyperlink
pub fn is_dired_arg_present() -> bool {
	DIRED_ARG_PRESENT.with(|c| *c.borrow())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_calculate_dired() {
		let output_display = "sample_output".to_string();
		let dfn = "sample_file".to_string();
		let dired = DiredOutput {
			dired_positions:    vec![BytePosition { start: 5, end: 10 }],
			subdired_positions: vec![],
			padding:            0,
			line_offset:        11,
		};
		let (start, end) = calculate_dired(&dired, output_display.len(), dfn.len());

		assert_eq!(start, 24);
		assert_eq!(end, 35);
	}

	#[test]
	fn test_calculate_subdired() {
		let mut dired = DiredOutput {
			dired_positions:    vec![
				BytePosition { start: 0, end: 3 },
				BytePosition { start: 4, end: 7 },
				BytePosition { start: 8, end: 11 },
			],
			subdired_positions: vec![],
			padding:            0,
			line_offset:        12,
		};
		let path_len = 5;
		calculate_subdired(&mut dired, path_len);
		assert_eq!(dired.subdired_positions, vec![BytePosition { start: 14, end: 19 }],);
	}

	#[test]
	fn test_add_dir_name() {
		let mut dired = DiredOutput {
			dired_positions:    vec![
				BytePosition { start: 0, end: 3 },
				BytePosition { start: 4, end: 7 },
				BytePosition { start: 8, end: 11 },
			],
			subdired_positions: vec![],
			padding:            0,
			line_offset:        0,
		};
		let dir_len = 5;
		add_dir_name(&mut dired, dir_len);
		assert_eq!(dired, DiredOutput {
			dired_positions:    vec![
				BytePosition { start: 0, end: 3 },
				BytePosition { start: 4, end: 7 },
				BytePosition { start: 8, end: 11 },
			],
			subdired_positions: vec![],
			// 9 = 5 for dir_len + 2 for "  " + 1 for : + 1 for \n
			padding:            9,
			line_offset:        0,
		});
	}

	#[test]
	fn test_add_total() {
		let mut dired = DiredOutput {
			dired_positions:    vec![
				BytePosition { start: 0, end: 3 },
				BytePosition { start: 4, end: 7 },
				BytePosition { start: 8, end: 11 },
			],
			subdired_positions: vec![],
			padding:            0,
			line_offset:        12,
		};
		// if we have "total: 2"
		let total_len = 8;
		add_total(&mut dired, total_len);
		// 10 = 8 (len) + 2 ("  ")
		assert_eq!(dired.padding, 10);
	}

	#[test]
	fn test_add_dir_name_and_total() {
		// test when we have
		//   dirname:
		//   total 0
		//   -rw-r--r-- 1 sylvestre sylvestre 0 Sep 30 09:41 ab

		let mut dired = DiredOutput {
			dired_positions:    vec![
				BytePosition { start: 0, end: 3 },
				BytePosition { start: 4, end: 7 },
				BytePosition { start: 8, end: 11 },
			],
			subdired_positions: vec![],
			padding:            0,
			line_offset:        12,
		};
		let dir_len = 5;
		add_dir_name(&mut dired, dir_len);
		// 9 = 2 ("  ") + 1 (\n) + 5 + 1 (: of dirname)
		assert_eq!(dired.padding, 9);

		let total_len = 8;
		add_total(&mut dired, total_len);
		assert_eq!(dired.padding, 19);
	}

	#[test]
	fn test_dired_update_positions() {
		let mut dired = DiredOutput {
			dired_positions:    vec![BytePosition { start: 5, end: 10 }],
			subdired_positions: vec![],
			padding:            10,
			line_offset:        0,
		};

		// Test with adjust = true
		update_positions(&mut dired, 15, 20, 1);
		let last_position = dired.dired_positions.last().unwrap();
		assert_eq!(last_position.start, 25); // 15 + 10 (end of the previous position)
		assert_eq!(last_position.end, 30); // 20 + 10 (end of the previous position)

		// Test with adjust = false
		update_positions(&mut dired, 30, 35, 1);
		let last_position = dired.dired_positions.last().unwrap();
		assert_eq!(last_position.start, 30);
		assert_eq!(last_position.end, 35);
	}

	#[test]
	fn test_calculate_and_update_positions() {
		let mut dired = DiredOutput {
			dired_positions:    vec![
				BytePosition { start: 0, end: 3 },
				BytePosition { start: 4, end: 7 },
				BytePosition { start: 8, end: 11 },
			],
			subdired_positions: vec![],
			padding:            5,
			line_offset:        12,
		};
		let output_display_len = 15;
		let dfn_len = 5;
		calculate_and_update_positions(&mut dired, output_display_len, dfn_len, 20);
		assert_eq!(dired.dired_positions, vec![
			BytePosition { start: 0, end: 3 },
			BytePosition { start: 4, end: 7 },
			BytePosition { start: 8, end: 11 },
			BytePosition { start: 32, end: 37 },
		]);
		assert_eq!(dired.padding, 0);
	}
}
