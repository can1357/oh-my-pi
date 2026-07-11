// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::ffi::OsString;

use clap::{Arg, ArgAction, Command};
use uucore::format_usage;

pub mod options {
	pub const BYTES: &str = "BYTES";
	pub const LINES: &str = "LINES";
	pub const QUIET: &str = "QUIET";
	pub const VERBOSE: &str = "VERBOSE";
	pub const ZERO: &str = "ZERO";
	pub const FILES: &str = "FILE";
	pub const PRESUME_INPUT_PIPE: &str = "-PRESUME-INPUT-PIPE";
}

pub fn uu_app() -> Command {
	Command::new("head")
		.version(uucore::crate_version!())
		.about(
			"Print the first 10 lines of each FILE to standard output.\nWith more than one FILE, \
			 precede each with a header giving the file name.\nWith no FILE, or when FILE is -, read \
			 standard input.",
		)
		.override_usage(format_usage("head [FLAG]... [FILE]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(options::BYTES)
				.short('c')
				.long("bytes")
				.value_name("[-]NUM")
				.help(
					"print the first NUM bytes of each file;\nwith a leading '-', print all but the \
					 last\nNUM bytes of each file",
				)
				.overrides_with_all([options::BYTES, options::LINES])
				.allow_hyphen_values(true),
		)
		.arg(
			Arg::new(options::LINES)
				.short('n')
				.long("lines")
				.value_name("[-]NUM")
				.help(
					"print the first NUM lines instead of the first 10;\nwith a leading '-', print all \
					 but the last\nNUM lines of each file",
				)
				.overrides_with_all([options::LINES, options::BYTES])
				.allow_hyphen_values(true),
		)
		.arg(
			Arg::new(options::QUIET)
				.short('q')
				.long("quiet")
				.visible_alias("silent")
				.help("never print headers giving file names")
				.overrides_with_all([options::VERBOSE, options::QUIET])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::VERBOSE)
				.short('v')
				.long("verbose")
				.help("always print headers giving file names")
				.overrides_with_all([options::QUIET, options::VERBOSE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::PRESUME_INPUT_PIPE)
				.long("presume-input-pipe")
				.alias("-presume-input-pipe")
				.hide(true)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::ZERO)
				.short('z')
				.long("zero-terminated")
				.help("line delimiter is NUL, not newline")
				.overrides_with(options::ZERO)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::FILES)
				.action(ArgAction::Append)
				.value_parser(clap::value_parser!(OsString))
				.value_hint(clap::ValueHint::FilePath),
		)
}
