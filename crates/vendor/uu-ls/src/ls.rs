// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) somegroup nlink tabsize dired subdired dtype
// colorterm stringly spell-checker:ignore nohash strtime clocale

#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::{
	borrow::Cow,
	cell::{OnceCell, RefCell},
	cmp::Reverse,
	ffi::{OsStr, OsString},
	fs::{self, DirEntry, FileType, Metadata, ReadDir},
	io::{BufWriter, ErrorKind, Write},
	ops::RangeInclusive,
	path::{Path, PathBuf},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use clap::{
	Arg, ArgAction, Command,
	builder::{NonEmptyStringValueParser, PossibleValue, ValueParser},
};
use lscolors::Colorable;
use pi_uutils_ctx::CtxStdout;
#[cfg(unix)]
use rustc_hash::FxHashMap;
use rustc_hash::FxHashSet;
use thiserror::Error;
#[cfg(unix)]
use uucore::libc::{S_IXGRP, S_IXOTH, S_IXUSR};
use uucore::{
	display::Quotable,
	error::{UError, UResult},
	format_usage,
	fs::FileInformation,
	fsext::metadata_get_time,
	os_str_as_bytes_lossy,
	parser::shortcut_value_parser::ShortcutValueParser,
	version_cmp::version_cmp,
};

mod colors;
mod config;
mod dired;
mod display;

use colors::StyleManager;
pub use config::{Config, options};
use config::{Dereference, Files, Sort, options::QUOTING_STYLE};
use dired::DiredOutput;
pub use display::Format;
use display::{display_items, display_size, should_display, show_dir_name};

#[derive(Error, Debug)]
enum LsError {
	#[error("invalid line width: '{0}'")]
	InvalidLineWidth(String),

	#[error("general io error: {0}")]
	IOError(#[from] std::io::Error),

	#[error("{}", match .1.kind() {
        ErrorKind::NotADirectory => format!("cannot access {}: Not a directory", .0.quote()),
        ErrorKind::NotFound => format!("cannot access {}: No such file or directory", .0.quote()),
        ErrorKind::PermissionDenied => match .1.raw_os_error().unwrap_or(1) {
            1 => format!("cannot access {}: Operation not permitted", .0.quote()),
            _ => if pi_uutils_ctx::resolve(.0).is_dir() {
                format!("cannot open directory {}: Permission denied", .0.quote())
            } else {
                format!("cannot open file {}: Permission denied", .0.quote())
            },
        },
        _ => if 9 == .1.raw_os_error().unwrap_or(1) {
            format!("cannot open directory {}: Bad file descriptor", .0.quote())
        } else {
            format!("unknown io error: {}, '{:?}'", .0.quote(), .1)
        },
    })]
	IOErrorContext(PathBuf, std::io::Error, bool),

	#[error("invalid --block-size argument '{0}'")]
	BlockSizeParseError(String),

	#[error("--dired and --zero are incompatible")]
	DiredAndZeroAreIncompatible,

	#[error("{}: not listing already-listed directory", .0.maybe_quote())]
	AlreadyListedError(PathBuf),

	#[error("invalid --time-style argument {}\nPossible values are:\n  - [posix-]full-iso\n  - [posix-]long-iso\n  - [posix-]iso\n  - [posix-]locale\n  - +FORMAT (e.g., +%H:%M) for a 'date'-style format\n\nFor more information try --help", .0.quote())]
	TimeStyleParseError(String),
}

impl UError for LsError {
	fn code(&self) -> i32 {
		match self {
			Self::InvalidLineWidth(_) => 2,
			Self::IOError(_) => 1,
			Self::IOErrorContext(_, _, false) => 1,
			Self::IOErrorContext(_, _, true) => 2,
			Self::BlockSizeParseError(_) => 2,
			Self::DiredAndZeroAreIncompatible => 2,
			Self::AlreadyListedError(_) => 2,
			Self::TimeStyleParseError(_) => 2,
		}
	}
}

/// pi-uutils: in-process replacement for uucore's process-global error
/// Writes the recoverable error to the context stderr and accumulates its
/// exit code (mirroring uucore's recoverable-error reporting), so it continues.
pub(crate) fn show_ls_error(err: LsError) {
	pi_uutils_ctx::set_exit_code(err.code());
	let _ = writeln!(pi_uutils_ctx::stderr(), "ls: {err}");
}

/// In-process builtin entry point. The host installs a [`pi_uutils_ctx`] scope
/// (stdio + working directory + environment) on a dedicated blocking thread,
/// then calls this. Unlike uutils' `#[uucore::main] uumain`, this never calls
/// `std::process::exit` and renders clap help/usage/version to the context
/// streams, so it is safe to run inside the long-lived host shell process.
pub fn run(args: Vec<OsString>) -> i32 {
	// Detect a raw `--dired`/`-D` operand before clap parsing (it can be masked
	// by `--hyperlink` via overrides_with); see `dired::is_dired_arg_present`.
	dired::set_dired_arg_present(&args);

	let matches = match uu_app().try_get_matches_from(args) {
		Ok(matches) => matches,
		Err(err) => {
			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(pi_uutils_ctx::stderr(), "{rendered}");
				return 2;
			}
			let _ = write!(pi_uutils_ctx::stdout(), "{rendered}");
			return 0;
		},
	};

	let config = match Config::from(&matches) {
		Ok(config) => config,
		Err(err) => {
			let code = err.code();
			let _ = writeln!(pi_uutils_ctx::stderr(), "ls: {err}");
			return if code == 0 { 1 } else { code };
		},
	};

	let locs = matches
		.get_many::<OsString>(options::PATHS)
		.map_or_else(|| vec![Path::new(".")], |v| v.map(Path::new).collect());

	match list(locs, &config) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let _ = writeln!(pi_uutils_ctx::stderr(), "ls: {err}");
			if code == 0 { 1 } else { code }
		},
	}
}

pub fn uu_app() -> Command {
	Command::new("ls")
		.version(uucore::crate_version!())
		.override_usage(format_usage("ls [OPTION]... [FILE]..."))
		.about(
			"List directory contents.\nIgnore files and directories starting with a '.' by default",
		)
		.color(clap::ColorChoice::Never)
		.infer_long_args(true)
		.disable_help_flag(true)
		.args_override_self(true)
		.arg(
			Arg::new(options::HELP)
				.long(options::HELP)
				.help("Print help information.")
				.action(ArgAction::Help),
		)
		// Format arguments
		.arg(
			Arg::new(options::FORMAT)
				.long(options::FORMAT)
				.help("Set the display format.")
				.value_parser(ShortcutValueParser::new([
					"long",
					"verbose",
					"single-column",
					"columns",
					"vertical",
					"across",
					"horizontal",
					"commas",
				]))
				.hide_possible_values(true)
				.require_equals(true)
				.overrides_with_all([
					options::FORMAT,
					options::format::COLUMNS,
					options::format::LONG,
					options::format::ACROSS,
					options::format::COLUMNS,
					options::DIRED,
				]),
		)
		.arg(
			Arg::new(options::format::COLUMNS)
				.short('C')
				.help("Display the files in columns.")
				.overrides_with_all([
					options::FORMAT,
					options::format::COLUMNS,
					options::format::LONG,
					options::format::ACROSS,
					options::format::COLUMNS,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::format::LONG)
				.short('l')
				.long(options::format::LONG)
				.help("Display detailed information.")
				.overrides_with_all([
					options::FORMAT,
					options::format::COLUMNS,
					options::format::LONG,
					options::format::ACROSS,
					options::format::COLUMNS,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::format::ACROSS)
				.short('x')
				.help("List entries in rows instead of in columns.")
				.overrides_with_all([
					options::FORMAT,
					options::format::COLUMNS,
					options::format::LONG,
					options::format::ACROSS,
					options::format::COLUMNS,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::format::TAB_SIZE)
				.short('T')
				.long(options::format::TAB_SIZE)
				.value_name("COLS")
				.help("Assume tab stops at each COLS instead of 8"),
		)
		.arg(
			Arg::new(options::format::COMMAS)
				.short('m')
				.help("List entries separated by commas.")
				.overrides_with_all([
					options::FORMAT,
					options::format::COLUMNS,
					options::format::LONG,
					options::format::ACROSS,
					options::format::COLUMNS,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::ZERO)
				.long(options::ZERO)
				.overrides_with(options::ZERO)
				.help("List entries separated by ASCII NUL characters.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DIRED)
				.long(options::DIRED)
				.short('D')
				.help("generate output designed for Emacs' dired (Directory Editor) mode")
				.action(ArgAction::SetTrue)
				.overrides_with(options::HYPERLINK),
		)
		.arg(
			Arg::new(options::HYPERLINK)
				.long(options::HYPERLINK)
				.help("hyperlink file names WHEN")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("always").alias("yes").alias("force"),
					PossibleValue::new("auto").alias("tty").alias("if-tty"),
					PossibleValue::new("never").alias("no").alias("none"),
				]))
				.require_equals(true)
				.num_args(0..=1)
				.default_missing_value("always")
				.default_value("never")
				.value_name("WHEN")
				.overrides_with(options::DIRED),
		)
		// The next four arguments do not override with the other format
		// options, see the comment in Config::from for the reason.
		// Ideally, they would use Arg::override_with, with their own name
		// but that doesn't seem to work in all cases. Example:
		// ls -1g1
		// even though `ls -11` and `ls -1 -g -1` work.
		.arg(
			Arg::new(options::format::ONE_LINE)
				.short('1')
				.help("List one file per line.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::format::LONG_NO_GROUP)
				.short('o')
				.help(
					"Long format without group information.\nIdentical to --format=long with \
					 --no-group.",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::format::LONG_NO_OWNER)
				.short('g')
				.help("Long format without owner information.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::format::LONG_NUMERIC_UID_GID)
				.short('n')
				.long(options::format::LONG_NUMERIC_UID_GID)
				.help("-l with numeric UIDs and GIDs.")
				.action(ArgAction::SetTrue),
		)
		// Quoting style
		.arg(
			Arg::new(QUOTING_STYLE)
				.long(QUOTING_STYLE)
				.help("Set quoting style.")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("literal"),
					PossibleValue::new("locale"),
					PossibleValue::new("shell"),
					PossibleValue::new("shell-escape"),
					PossibleValue::new("shell-always"),
					PossibleValue::new("shell-escape-always"),
					PossibleValue::new("clocale"),
					PossibleValue::new("c").alias("c-maybe"),
					PossibleValue::new("escape"),
				]))
				.overrides_with_all([
					QUOTING_STYLE,
					options::quoting::LITERAL,
					options::quoting::ESCAPE,
					options::quoting::C,
				]),
		)
		.arg(
			Arg::new(options::quoting::LITERAL)
				.short('N')
				.long(options::quoting::LITERAL)
				.alias("l")
				.help("Use literal quoting style. Equivalent to `--quoting-style=literal`")
				.overrides_with_all([
					QUOTING_STYLE,
					options::quoting::LITERAL,
					options::quoting::ESCAPE,
					options::quoting::C,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::quoting::ESCAPE)
				.short('b')
				.long(options::quoting::ESCAPE)
				.help("Use escape quoting style. Equivalent to `--quoting-style=escape`")
				.overrides_with_all([
					QUOTING_STYLE,
					options::quoting::LITERAL,
					options::quoting::ESCAPE,
					options::quoting::C,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::quoting::C)
				.short('Q')
				.long(options::quoting::C)
				.help("Use C quoting style. Equivalent to `--quoting-style=c`")
				.overrides_with_all([
					QUOTING_STYLE,
					options::quoting::LITERAL,
					options::quoting::ESCAPE,
					options::quoting::C,
				])
				.action(ArgAction::SetTrue),
		)
		// Control characters
		.arg(
			Arg::new(options::HIDE_CONTROL_CHARS)
				.short('q')
				.long(options::HIDE_CONTROL_CHARS)
				.help("Replace control characters with '?' if they are not escaped.")
				.overrides_with_all([options::HIDE_CONTROL_CHARS, options::SHOW_CONTROL_CHARS])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SHOW_CONTROL_CHARS)
				.long(options::SHOW_CONTROL_CHARS)
				.help("Show control characters 'as is' if they are not escaped.")
				.overrides_with_all([options::HIDE_CONTROL_CHARS, options::SHOW_CONTROL_CHARS])
				.action(ArgAction::SetTrue),
		)
		// Time arguments
		.arg(
			Arg::new(options::TIME)
				.long(options::TIME)
				.help(
					"Show time in `<field>`:\naccess time (-u): atime, access, use;\nchange time (-t): \
					 ctime, status.\nmodification time: mtime, modification.\nbirth time: birth, \
					 creation;",
				)
				.value_name("field")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("atime").alias("access").alias("use"),
					PossibleValue::new("ctime").alias("status"),
					PossibleValue::new("mtime").alias("modification"),
					PossibleValue::new("birth").alias("creation"),
				]))
				.hide_possible_values(true)
				.require_equals(true)
				.overrides_with_all([options::TIME, options::time::ACCESS, options::time::CHANGE]),
		)
		.arg(
			Arg::new(options::time::CHANGE)
				.short('c')
				.help(
					"If the long listing format (e.g., -l, -o) is being used, print the\nstatus change \
					 time (the 'ctime' in the inode) instead of the modification\ntime. When \
					 explicitly sorting by time (--sort=time or -t) or when not\nusing a long listing \
					 format, sort according to the status change time.",
				)
				.overrides_with_all([options::TIME, options::time::ACCESS, options::time::CHANGE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::time::ACCESS)
				.short('u')
				.help(
					"If the long listing format (e.g., -l, -o) is being used, print the\nstatus access \
					 time instead of the modification time. When explicitly\nsorting by time \
					 (--sort=time or -t) or when not using a long listing\nformat, sort according to \
					 the access time.",
				)
				.overrides_with_all([options::TIME, options::time::ACCESS, options::time::CHANGE])
				.action(ArgAction::SetTrue),
		)
		// Hide and ignore
		.arg(
			Arg::new(options::HIDE)
				.long(options::HIDE)
				.action(ArgAction::Append)
				.value_name("PATTERN")
				.help("do not list implied entries matching shell PATTERN (overridden by -a or -A)"),
		)
		.arg(
			Arg::new(options::IGNORE)
				.short('I')
				.long(options::IGNORE)
				.action(ArgAction::Append)
				.value_name("PATTERN")
				.help("do not list implied entries matching shell PATTERN"),
		)
		.arg(
			Arg::new(options::IGNORE_BACKUPS)
				.short('B')
				.long(options::IGNORE_BACKUPS)
				.help("Ignore entries which end with ~.")
				.action(ArgAction::SetTrue),
		)
		// Sort arguments
		.arg(
			Arg::new(options::SORT)
				.long(options::SORT)
				.help(
					"Sort by `<field>`: name, none (-U), time (-t), size (-S), extension (-X) or width",
				)
				.value_name("field")
				.value_parser(ShortcutValueParser::new([
					"name",
					"none",
					"time",
					"size",
					"version",
					"extension",
					"width",
				]))
				.require_equals(true)
				.overrides_with_all([
					options::SORT,
					options::sort::SIZE,
					options::sort::TIME,
					options::sort::NONE,
					options::sort::VERSION,
					options::sort::EXTENSION,
				]),
		)
		.arg(
			Arg::new(options::sort::SIZE)
				.short('S')
				.help("Sort by file size, largest first.")
				.overrides_with_all([
					options::SORT,
					options::sort::SIZE,
					options::sort::TIME,
					options::sort::NONE,
					options::sort::VERSION,
					options::sort::EXTENSION,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::sort::TIME)
				.short('t')
				.help("Sort by modification time (the 'mtime' in the inode), newest first.")
				.overrides_with_all([
					options::SORT,
					options::sort::SIZE,
					options::sort::TIME,
					options::sort::NONE,
					options::sort::VERSION,
					options::sort::EXTENSION,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::sort::VERSION)
				.short('v')
				.help("Natural sort of (version) numbers in the filenames.")
				.overrides_with_all([
					options::SORT,
					options::sort::SIZE,
					options::sort::TIME,
					options::sort::NONE,
					options::sort::VERSION,
					options::sort::EXTENSION,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::sort::EXTENSION)
				.short('X')
				.help("Sort alphabetically by entry extension.")
				.overrides_with_all([
					options::SORT,
					options::sort::SIZE,
					options::sort::TIME,
					options::sort::NONE,
					options::sort::VERSION,
					options::sort::EXTENSION,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::sort::NONE)
				.short('U')
				.help(
					"Do not sort; list the files in whatever order they are stored in the\ndirectory.  \
					 This is especially useful when listing very large directories,\nsince not doing \
					 any sorting can be noticeably faster.",
				)
				.overrides_with_all([
					options::SORT,
					options::sort::SIZE,
					options::sort::TIME,
					options::sort::NONE,
					options::sort::VERSION,
					options::sort::EXTENSION,
				])
				.action(ArgAction::SetTrue),
		)
		// Dereferencing
		.arg(
			Arg::new(options::dereference::ALL)
				.short('L')
				.long(options::dereference::ALL)
				.help(
					"When showing file information for a symbolic link, show information for the\nfile \
					 the link references rather than the link itself.",
				)
				.overrides_with_all([
					options::dereference::ALL,
					options::dereference::DIR_ARGS,
					options::dereference::ARGS,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::dereference::DIR_ARGS)
				.long(options::dereference::DIR_ARGS)
				.help(
					"Do not follow symlinks except when they link to directories and are\ngiven as \
					 command line arguments.",
				)
				.overrides_with_all([
					options::dereference::ALL,
					options::dereference::DIR_ARGS,
					options::dereference::ARGS,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::dereference::ARGS)
				.short('H')
				.long(options::dereference::ARGS)
				.help("Do not follow symlinks except when given as command line arguments.")
				.overrides_with_all([
					options::dereference::ALL,
					options::dereference::DIR_ARGS,
					options::dereference::ARGS,
				])
				.action(ArgAction::SetTrue),
		)
		// Long format options
		.arg(
			Arg::new(options::NO_GROUP)
				.long(options::NO_GROUP)
				.short('G')
				.help("Do not show group in long format.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::AUTHOR)
				.long(options::AUTHOR)
				.help(
					"Show author in long format. On the supported platforms,\nthe author always \
					 matches the file owner.",
				)
				.action(ArgAction::SetTrue),
		)
		// Other Flags
		.arg(
			Arg::new(options::files::ALL)
				.short('a')
				.long(options::files::ALL)
				// Overrides -A (as the order matters)
				.overrides_with_all([options::files::ALL, options::files::ALMOST_ALL])
				.help("Do not ignore hidden files (files with names that start with '.').")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::files::ALMOST_ALL)
				.short('A')
				.long(options::files::ALMOST_ALL)
				// Overrides -a (as the order matters)
				.overrides_with_all([options::files::ALL, options::files::ALMOST_ALL])
				.help(
					"In a directory, do not ignore all file names that start with '.',\nonly ignore \
					 '.' and '..'.",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::files::UNSORTED_ALL)
				.short('f')
				.help(
					"List all files in directory order, unsorted. Equivalent to -aU. Disables --color \
					 unless explicitly specified.",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DIRECTORY)
				.short('d')
				.long(options::DIRECTORY)
				.help(
					"Only list the names of directories, rather than listing directory contents.\nThis \
					 will not follow symbolic links unless one of `--dereference-command-line\n(-H)`, \
					 `--dereference (-L)`, or `--dereference-command-line-symlink-to-dir` \
					 is\nspecified.",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::size::HUMAN_READABLE)
				.short('h')
				.long(options::size::HUMAN_READABLE)
				.help("Print human readable file sizes (e.g. 1K 234M 56G).")
				.overrides_with_all([options::size::BLOCK_SIZE, options::size::SI])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::size::KIBIBYTES)
				.short('k')
				.long(options::size::KIBIBYTES)
				.help(
					"default to 1024-byte blocks for file system usage; used only with -s and \
					 per\ndirectory totals",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::size::SI)
				.long(options::size::SI)
				.help("Print human readable file sizes using powers of 1000 instead of 1024.")
				.overrides_with_all([options::size::BLOCK_SIZE, options::size::HUMAN_READABLE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::size::BLOCK_SIZE)
				.long(options::size::BLOCK_SIZE)
				.require_equals(true)
				.value_name("BLOCK_SIZE")
				.help("scale sizes by BLOCK_SIZE when printing them")
				.overrides_with_all([options::size::SI, options::size::HUMAN_READABLE]),
		)
		.arg(
			Arg::new(options::INODE)
				.short('i')
				.long(options::INODE)
				.help("print the index number of each file")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::REVERSE)
				.short('r')
				.long(options::REVERSE)
				.help(
					"Reverse whatever the sorting method is e.g., list files in reverse\nalphabetical \
					 order, youngest first, smallest first, or whatever.",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::RECURSIVE)
				.short('R')
				.long(options::RECURSIVE)
				.help("List the contents of all directories recursively.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::WIDTH)
				.long(options::WIDTH)
				.short('w')
				.help("Assume that the terminal is COLS columns wide.")
				.value_name("COLS"),
		)
		.arg(
			Arg::new(options::size::ALLOCATION_SIZE)
				.short('s')
				.long(options::size::ALLOCATION_SIZE)
				.help("print the allocated size of each file, in blocks")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::COLOR)
				.long(options::COLOR)
				.help("Color output based on file type.")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("always").alias("yes").alias("force"),
					PossibleValue::new("auto").alias("tty").alias("if-tty"),
					PossibleValue::new("never").alias("no").alias("none"),
				]))
				.require_equals(true)
				.num_args(0..=1),
		)
		.arg(
			Arg::new(options::INDICATOR_STYLE)
				.long(options::INDICATOR_STYLE)
				.help(
					"Append indicator with style WORD to entry names:\nnone (default),  slash (-p), \
					 file-type (--file-type), classify (-F)",
				)
				.value_parser(ShortcutValueParser::new(["none", "slash", "file-type", "classify"]))
				.overrides_with_all([
					options::indicator_style::FILE_TYPE,
					options::indicator_style::SLASH,
					options::indicator_style::CLASSIFY,
					options::INDICATOR_STYLE,
				]),
		)
		.arg(
			// The --classify flag can take an optional when argument to
			// control its behavior from version 9 of GNU coreutils.
			// There is currently an inconsistency where GNU coreutils allows only
			// the long form of the flag to take the argument while we allow it
			// for both the long and short form of the flag.
			Arg::new(options::indicator_style::CLASSIFY)
				.short('F')
				.long(options::indicator_style::CLASSIFY)
				.help(
					"Append a character to each file name indicating the file type. Also, for\nregular \
					 files that are executable, append '*'. The file type indicators are\n'/' for \
					 directories, '@' for symbolic links, '|' for FIFOs, '=' for sockets,\n'>' for \
					 doors, and nothing for regular files. when may be omitted, or one of:\n    none - \
					 Do not classify. This is the default.\n    auto - Only classify if standard \
					 output is a terminal.\n    always - Always classify.\nSpecifying --classify and \
					 no when is equivalent to --classify=always. This will\nnot follow symbolic links \
					 listed on the command line unless the\n--dereference-command-line (-H), \
					 --dereference (-L), or\n--dereference-command-line-symlink-to-dir options are \
					 specified.",
				)
				.value_name("when")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("always").alias("yes").alias("force"),
					PossibleValue::new("auto").alias("tty").alias("if-tty"),
					PossibleValue::new("never").alias("no").alias("none"),
				]))
				.default_missing_value("always")
				.require_equals(true)
				.num_args(0..=1)
				.overrides_with_all([
					options::indicator_style::FILE_TYPE,
					options::indicator_style::SLASH,
					options::indicator_style::CLASSIFY,
					options::INDICATOR_STYLE,
				]),
		)
		.arg(
			Arg::new(options::indicator_style::FILE_TYPE)
				.long(options::indicator_style::FILE_TYPE)
				.help("Same as --classify, but do not append '*'")
				.overrides_with_all([
					options::indicator_style::FILE_TYPE,
					options::indicator_style::SLASH,
					options::indicator_style::CLASSIFY,
					options::INDICATOR_STYLE,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::indicator_style::SLASH)
				.short('p')
				.help("Append / indicator to directories.")
				.overrides_with_all([
					options::indicator_style::FILE_TYPE,
					options::indicator_style::SLASH,
					options::indicator_style::CLASSIFY,
					options::INDICATOR_STYLE,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			//This still needs support for posix-*
			Arg::new(options::TIME_STYLE)
				.long(options::TIME_STYLE)
				.help("time/date format with -l; see TIME_STYLE below")
				.value_name("TIME_STYLE")
				.value_parser(NonEmptyStringValueParser::new())
				.overrides_with_all([options::TIME_STYLE]),
		)
		.arg(
			Arg::new(options::FULL_TIME)
				.long(options::FULL_TIME)
				.overrides_with(options::FULL_TIME)
				.help("like -l --time-style=full-iso")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::CONTEXT)
				.short('Z')
				.long(options::CONTEXT)
				.help("print any security context of each file")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::GROUP_DIRECTORIES_FIRST)
				.long(options::GROUP_DIRECTORIES_FIRST)
				.help(
					"group directories before files; can be augmented with\na --sort option, but any \
					 use of --sort=none (-U) disables grouping",
				)
				.action(ArgAction::SetTrue),
		)
		// Positional arguments
		.arg(
			Arg::new(options::PATHS)
				.action(ArgAction::Append)
				.value_hint(clap::ValueHint::AnyPath)
				.value_parser(ValueParser::os_string()),
		)
		.after_help(
			"The TIME_STYLE argument can be full-iso, long-iso, iso, locale or +FORMAT. FORMAT is \
			 interpreted like in date. Also the TIME_STYLE environment variable sets the default \
			 style to use.",
		)
}

/// Represents the possible values of [`PathData::display_name`]. The reason
/// this is a separate enum is to avoid a self-referential struct, as it is
/// moved in hot loops.
#[derive(Debug)]
enum PathDataDisplayName<'a> {
	SelfReferential,
	Custom(Cow<'a, OsStr>),
}

/// Represents a Path along with it's associated data.
/// Any data that will be reused several times makes sense to be added to this
/// structure. Caching data here helps eliminate redundant syscalls to fetch
/// same information.
#[derive(Debug)]
struct PathData<'a> {
	// Result<MetaData> got from symlink_metadata() or metadata() based on config
	md:               OnceCell<Option<Metadata>>,
	ft:               OnceCell<Option<FileType>>,
	// can be used to avoid reading the filetype. Can be also called d_type:
	// https://www.gnu.org/software/libc/manual/html_node/Directory-Entries.html
	de:               RefCell<Option<DirEntry>>,
	security_context: OnceCell<Box<str>>,
	// Name of the file - will be empty for . or ..
	display_name:     PathDataDisplayName<'a>,
	// PathBuf that all above data corresponds to
	p_buf:            Cow<'a, Path>,
	must_dereference: bool,
	command_line:     bool,
}

impl<'a> PathData<'a> {
	fn new(
		p_buf: Cow<'a, Path>,
		dir_entry: Option<DirEntry>,
		file_name: Option<Cow<'a, OsStr>>,
		config: &Config,
		command_line: bool,
	) -> Self {
		// We cannot use `Path::ends_with` or `Path::Components`, because they remove
		// occurrences of '.' For '..', the filename is None
		let display_name = if let Some(name) = file_name {
			PathDataDisplayName::Custom(name)
		} else if command_line {
			PathDataDisplayName::SelfReferential
		} else {
			PathDataDisplayName::Custom(
				dir_entry
					.as_ref()
					.map(DirEntry::file_name)
					.unwrap_or_default()
					.into(),
			)
		};

		let must_dereference = match &config.dereference {
			Dereference::All => true,
			Dereference::Args => command_line,
			Dereference::DirArgs => {
				if command_line {
					if let Ok(md) = pi_uutils_ctx::resolve(&p_buf).metadata() {
						md.is_dir()
					} else {
						false
					}
				} else {
					false
				}
			},
			Dereference::None => false,
		};

		// Why prefer to check the DirEntry file_type()?  B/c the call is
		// nearly free compared to a metadata() call on a Path
		let ft: OnceCell<Option<FileType>> = OnceCell::new();
		let md: OnceCell<Option<Metadata>> = OnceCell::new();
		let security_context: OnceCell<Box<str>> = OnceCell::new();

		let de: RefCell<Option<DirEntry>> = if let Some(de) = dir_entry {
			if must_dereference && let Ok(md_pb) = pi_uutils_ctx::resolve(&p_buf).metadata() {
				ft.get_or_init(|| Some(md_pb.file_type()));
				md.get_or_init(|| Some(md_pb));
			}

			if let Ok(ft_de) = de.file_type() {
				ft.get_or_init(|| Some(ft_de));
			}

			RefCell::new(Some(de))
		} else {
			RefCell::new(None)
		};

		Self { md, ft, de, security_context, display_name, p_buf, must_dereference, command_line }
	}

	fn metadata(&self) -> Option<&Metadata> {
		self
			.md
			.get_or_init(|| {
				if !self.must_dereference
					&& let Some(dir_entry) = RefCell::take(&self.de)
				{
					return dir_entry.metadata().ok();
				}

				match get_metadata_with_deref_opt(self.path(), self.must_dereference) {
					Err(err) => {
						// FIXME: A bit tricky to propagate the result here
						let _ = pi_uutils_ctx::stdout().flush();
						let errno = err.raw_os_error().unwrap_or(1i32);
						// a bad fd will throw an error when dereferenced,
						// but GNU will not throw an error until a bad fd "dir"
						// is entered, here we match that GNU behavior, by handing
						// back the non-dereferenced metadata upon an EBADF
						if self.must_dereference
							&& errno == 9i32
							&& let Ok(file) = pi_uutils_ctx::resolve(self.path()).read_link()
						{
							return file.symlink_metadata().ok();
						}
						show_ls_error(LsError::IOErrorContext(
							self.path().to_path_buf(),
							err,
							self.command_line,
						));
						None
					},
					Ok(md) => Some(md),
				}
			})
			.as_ref()
	}

	fn file_type(&self) -> Option<&FileType> {
		self
			.ft
			.get_or_init(|| self.metadata().map(Metadata::file_type))
			.as_ref()
	}

	fn is_dangling_link(&self) -> bool {
		// deref enabled, self is real dir entry, self has metadata associated with
		// link, but not with target
		self.must_dereference && self.file_type().is_none() && self.metadata().is_none()
	}

	#[cfg(unix)]
	fn is_executable_file(&self) -> bool {
		self.file_type().is_some_and(FileType::is_file)
			&& self.metadata().is_some_and(file_is_executable)
	}

	fn security_context(&self, config: &Config) -> &str {
		self
			.security_context
			.get_or_init(|| get_security_context(&self.p_buf, self.must_dereference, config).into())
	}

	fn path(&self) -> &Path {
		&self.p_buf
	}

	fn display_name(&self) -> &OsStr {
		match self.display_name {
			PathDataDisplayName::SelfReferential => self.p_buf.as_os_str(),
			PathDataDisplayName::Custom(ref cow) => cow,
		}
	}
}

impl Colorable for PathData<'_> {
	fn file_name(&self) -> OsString {
		self.display_name().to_os_string()
	}

	fn file_type(&self) -> Option<FileType> {
		self.file_type().copied()
	}

	fn metadata(&self) -> Option<Metadata> {
		self.metadata().cloned()
	}

	fn path(&self) -> PathBuf {
		self.path().to_path_buf()
	}
}

type DirData = (PathBuf, bool);

// A struct to encapsulate state that is passed around from `list` functions.
#[cfg_attr(not(unix), allow(dead_code))]
struct ListState<'a> {
	out:               BufWriter<CtxStdout>,
	style_manager:     Option<StyleManager<'a>>,
	// TODO: More benchmarking with different use cases is required here.
	// From experiments, BTreeMap may be faster than HashMap, especially as the
	// number of users/groups is very limited. It seems like nohash::IntMap
	// performance was equivalent to BTreeMap.
	// It's possible a simple vector linear(binary?) search implementation would be even faster.
	#[cfg(unix)]
	uid_cache:         FxHashMap<u32, String>,
	#[cfg(unix)]
	gid_cache:         FxHashMap<u32, String>,
	#[cfg(not(unix))]
	uid_cache:         (),
	#[cfg(not(unix))]
	gid_cache:         (),
	recent_time_range: RangeInclusive<SystemTime>,
	stack:             Vec<DirData>,
	listed_ancestors:  FxHashSet<FileInformation>,
	initial_locs_len:  usize,
	display_buf:       Vec<u8>,
}

#[allow(clippy::cognitive_complexity)]
pub fn list(locs: Vec<&Path>, config: &Config) -> UResult<()> {
	let mut files = Vec::<PathData>::new();
	let mut dirs = Vec::<PathData>::new();
	let mut dired = DiredOutput::default();
	let initial_locs_len = locs.len();
	let now = SystemTime::now();

	let mut state = ListState {
		out: BufWriter::new(pi_uutils_ctx::stdout()),
		style_manager: config.color.as_ref().map(StyleManager::new),
		#[cfg(unix)]
		uid_cache: FxHashMap::default(),
		#[cfg(unix)]
		gid_cache: FxHashMap::default(),
		#[cfg(not(unix))]
		uid_cache: (),
		#[cfg(not(unix))]
		gid_cache: (),
		// Time range for which to use the "recent" format. Anything from 0.5 year in the past to now
		// (files with modification time in the future use "old" format).
		// According to GNU a Gregorian year has 365.2425 * 24 * 60 * 60 == 31556952 seconds on the
		// average.
		recent_time_range: (now - Duration::new(31_556_952 / 2, 0))..=now,
		stack: Vec::new(),
		listed_ancestors: FxHashSet::default(),
		initial_locs_len,
		display_buf: Vec::with_capacity(if config.format == Format::Long {
			128
		} else {
			0
		}),
	};

	for loc in locs {
		let path_data = PathData::new(loc.into(), None, None, config, true);

		// Getting metadata here is no big deal as it's just the CWD
		// and we really just want to know if the strings exist as files/dirs
		//
		// Proper GNU handling is don't show if dereferenced symlink DNE
		// but only for the base dir, for a child dir show, and print ?s
		// in long format
		if path_data.metadata().is_none() {
			continue;
		}

		let show_dir_contents = if let Some(ft) = path_data.file_type() {
			!config.directory && ft.is_dir()
		} else {
			pi_uutils_ctx::set_exit_code(1);
			false
		};

		if show_dir_contents {
			dirs.push(path_data);
		} else {
			files.push(path_data);
		}
	}

	sort_entries(&mut files, config);
	sort_entries(&mut dirs, config);

	if let Some(style_manager) = state.style_manager.as_mut() {
		// ls will try to write a reset before anything is written if normal
		// color is given
		if style_manager.get_normal_style().is_some() {
			let to_write = style_manager.reset(true);
			write!(state.out, "{to_write}")?;
		}
	}

	display_items(&files, config, &mut state, &mut dired)?;

	for (pos, path_data) in dirs.iter().enumerate() {
		let needs_blank_line = pos != 0 || !files.is_empty();
		// Do read_dir call here to match GNU semantics by printing
		// read_dir errors before directory headings, names and totals
		let read_dir = match fs::read_dir(pi_uutils_ctx::resolve(path_data.path())) {
			Err(err) => {
				// flush stdout buffer before the error to preserve formatting and order
				state.out.flush()?;
				show_ls_error(LsError::IOErrorContext(
					path_data.path().to_path_buf(),
					err,
					path_data.command_line,
				));
				continue;
			},
			Ok(rd) => rd,
		};

		state.listed_ancestors.insert(FileInformation::from_path(
			pi_uutils_ctx::resolve(path_data.path()),
			path_data.must_dereference,
		)?);

		// List each of the arguments to ls first.
		depth_first_list(
			(path_data.path().to_path_buf(), needs_blank_line),
			read_dir,
			config,
			&mut state,
			&mut dired,
			true,
		)?;

		// Only runs if it must list recursively.
		while let Some(dir_data) = state.stack.pop() {
			let read_dir = match fs::read_dir(pi_uutils_ctx::resolve(&dir_data.0)) {
				Err(err) => {
					// flush stdout buffer before the error to preserve formatting and order
					state.out.flush()?;
					show_ls_error(LsError::IOErrorContext(
						path_data.path().to_path_buf(),
						err,
						path_data.command_line,
					));
					continue;
				},
				Ok(rd) => rd,
			};

			depth_first_list(dir_data, read_dir, config, &mut state, &mut dired, false)?;

			// Heuristic to ensure stack does not keep its capacity forever if there is
			// combinatorial explosion; we decrease it logarithmically here.
			let (cap, len) = (state.stack.capacity(), state.stack.len());
			if cap > (len + 4) * 2 {
				state.stack.shrink_to(len + (cap - len) / 2);
			}
		}

		// No need to clear state.buf since [`enter_directory`] drains it.
		state.listed_ancestors.clear();
	}
	if config.dired && !config.hyperlink {
		dired::print_dired_output(config, &dired, &mut state.out)?;
	}
	Ok(())
}

fn sort_entries(entries: &mut [PathData], config: &Config) {
	match config.sort {
		Sort::Time => entries.sort_unstable_by_key(|k| {
			Reverse(
				k.metadata()
					.and_then(|md| metadata_get_time(md, config.time))
					.unwrap_or(UNIX_EPOCH),
			)
		}),
		Sort::Size => {
			entries.sort_unstable_by_key(|k| Reverse(k.metadata().map_or(0, Metadata::len)));
		},
		// The default sort in GNU ls is case insensitive
		Sort::Name => entries.sort_unstable_by(|a, b| a.display_name().cmp(b.display_name())),
		Sort::Version => entries.sort_unstable_by(|a, b| {
			version_cmp(
				os_str_as_bytes_lossy(a.path().as_os_str()).as_ref(),
				os_str_as_bytes_lossy(b.path().as_os_str()).as_ref(),
			)
			.then(a.path().cmp(b.path()))
		}),
		Sort::Extension => entries.sort_unstable_by(|a, b| {
			a.path()
				.extension()
				.cmp(&b.path().extension())
				.then(a.path().file_stem().cmp(&b.path().file_stem()))
		}),
		Sort::Width => entries.sort_unstable_by(|a, b| {
			a.display_name()
				.len()
				.cmp(&b.display_name().len())
				.then(a.display_name().cmp(b.display_name()))
		}),
		Sort::None => {},
	}

	if config.reverse {
		entries.reverse();
	}

	if config.group_directories_first && config.sort != Sort::None {
		entries.sort_unstable_by_key(|p| {
			let ft = {
				// We will always try to deref symlinks to group directories, so PathData.md
				// is not always useful.
				if p.must_dereference {
					p.file_type()
				} else {
					None
				}
			};

			!match ft {
				None => {
					// If it metadata cannot be determined, treat as a file.
					get_metadata_with_deref_opt(&p.p_buf, true).map_or_else(|_| false, |m| m.is_dir())
				},
				Some(ft) => ft.is_dir(),
			}
		});
	}
}

fn depth_first_list(
	(dir_path, needs_blank_line): DirData,
	mut read_dir: ReadDir,
	config: &Config,
	state: &mut ListState,
	dired: &mut DiredOutput,
	is_top_level: bool,
) -> UResult<()> {
	let path_data = PathData::new(dir_path.as_path().into(), None, None, config, false);

	// Print dir heading - name... 'total' comes after error display
	if state.initial_locs_len > 1 || config.recursive {
		if is_top_level {
			if needs_blank_line {
				writeln!(state.out)?;
				if config.dired {
					dired.padding += 1;
				}
			}
			if config.dired {
				dired::indent(&mut state.out)?;
			}
			show_dir_name(&path_data, &mut state.out, config)?;
			writeln!(state.out)?;
			if config.dired {
				let dir_len = path_data.path().as_os_str().len();
				// add the //SUBDIRED// coordinates
				dired::calculate_subdired(dired, dir_len);
				// Add the padding for the dir name
				dired::add_dir_name(dired, dir_len);
			}
		} else {
			writeln!(state.out)?;
			if config.dired {
				dired.padding += 1;
				dired::indent(&mut state.out)?;
				let dir_name_size = path_data.path().as_os_str().len();
				dired::calculate_subdired(dired, dir_name_size);
				dired::add_dir_name(dired, dir_name_size);
			}
			show_dir_name(&path_data, &mut state.out, config)?;
			writeln!(state.out)?;
		}
	}

	// Append entries with initial dot files and record their existence
	let (ref mut buf, trim) = if config.files == Files::All {
		const DOT_DIRECTORIES: usize = 2;
		let v = vec![
			PathData::new(path_data.path().into(), None, Some(OsStr::new(".").into()), config, false),
			PathData::new(
				// On WASI the sandbox may block access to ".." at the
				// preopened root.  Fall back to "." so the entry still
				// appears with valid metadata instead of an error.
				{
					let dotdot = path_data.path().join("..");
					#[cfg(target_os = "wasi")]
					let dotdot = if dotdot.metadata().is_err() {
						path_data.path().into()
					} else {
						dotdot
					};
					dotdot.into()
				},
				None,
				Some(OsStr::new("..").into()),
				config,
				false,
			),
		];
		(v, DOT_DIRECTORIES)
	} else {
		(Vec::new(), 0)
	};

	// Convert those entries to the PathData struct
	for raw_entry in read_dir.by_ref() {
		match raw_entry {
			Ok(dir_entry) => {
				if should_display(&dir_entry, config) {
					buf.push(PathData::new(
						path_data.path().join(dir_entry.file_name()).into(),
						Some(dir_entry),
						None,
						config,
						false,
					));
				}
			},
			Err(err) => {
				state.out.flush()?;
				show_ls_error(LsError::IOError(err));
			},
		}
	}
	// Relinquish unused space since we won't need it anymore.
	buf.shrink_to_fit();

	sort_entries(buf, config);

	if config.format == Format::Long || config.alloc_size {
		let total = write_total(buf, config, &mut state.out)?;
		if config.dired {
			dired::add_total(dired, total);
		}
	}

	display_items(buf, config, state, dired)?;

	if config.recursive {
		for e in buf
			.iter()
			.skip(trim)
			.filter(|p| p.file_type().is_some_and(FileType::is_dir))
			.rev()
		{
			// Try to open only to report any errors in order to match GNU semantics.
			if let Err(err) = fs::read_dir(pi_uutils_ctx::resolve(e.path())) {
				state.out.flush()?;
				show_ls_error(LsError::IOErrorContext(e.path().to_path_buf(), err, e.command_line));
			} else {
				let fi =
					FileInformation::from_path(pi_uutils_ctx::resolve(e.path()), e.must_dereference)?;
				if state.listed_ancestors.insert(fi) {
					// Push to stack, but with a less aggressive growth curve.
					let (cap, len) = (state.stack.capacity(), state.stack.len());
					if cap == len {
						state.stack.reserve_exact(len / 4 + 4);
					}
					state.stack.push((e.path().to_path_buf(), true));
				} else {
					state.out.flush()?;
					show_ls_error(LsError::AlreadyListedError(e.path().to_path_buf()));
				}
			}
		}
	}
	Ok(())
}

fn get_metadata_with_deref_opt(p_buf: &Path, dereference: bool) -> std::io::Result<Metadata> {
	let resolved = pi_uutils_ctx::resolve(p_buf);
	if dereference {
		resolved.metadata()
	} else {
		resolved.symlink_metadata()
	}
}

fn write_total(
	items: &[PathData],
	config: &Config,
	out: &mut BufWriter<CtxStdout>,
) -> UResult<usize> {
	let mut total_size = 0;
	for item in items {
		total_size += item
			.metadata()
			.as_ref()
			.map_or(0, |md| get_block_size(md, config));
	}
	if config.dired {
		dired::indent(out)?;
	}
	let total = format!("total {}", display_size(total_size, config));
	out.write_all(total.as_bytes())?;
	out.write_all(&[config.line_ending as u8])?;
	Ok(total.len() + 1)
}

#[allow(unused_variables)]
fn get_block_size(md: &Metadata, config: &Config) -> u64 {
	/* GNU ls will display sizes in terms of block size
		md.len() will differ from this value when the file has some holes
	*/
	#[cfg(unix)]
	{
		use uucore::format::human::SizeFormat;

		let raw_blocks = if md.file_type().is_char_device() || md.file_type().is_block_device() {
			0u64
		} else {
			md.blocks() * 512
		};
		match config.size_format {
			SizeFormat::Binary | SizeFormat::Decimal => raw_blocks,
			SizeFormat::Bytes => raw_blocks / config.block_size,
		}
	}
	#[cfg(not(unix))]
	{
		// no way to get block size for windows, fall-back to file size
		md.len()
	}
}

#[cfg(unix)]
fn file_is_executable(md: &Metadata) -> bool {
	// Mode always returns u32, but the flags might not be, based on the platform
	// e.g. linux has u32, mac has u16.
	// S_IXUSR -> user has execute permission
	// S_IXGRP -> group has execute permission
	// S_IXOTH -> other users have execute permission
	#[allow(clippy::unnecessary_cast)]
	return md.mode() & ((S_IXUSR | S_IXGRP | S_IXOTH) as u32) != 0;
}

/// This returns the `SELinux` security context as UTF8 `String`.
/// In the long term this should be changed to [`OsStr`], see discussions at
/// #2621/#2656
fn get_security_context<'a>(
	path: &'a Path,
	must_dereference: bool,
	config: &'a Config,
) -> Cow<'a, str> {
	static SUBSTITUTE_STRING: &str = "?";

	// If we must dereference, ensure that the symlink is actually valid even if the
	// system does not support SELinux.
	// Conforms to the GNU coreutils where a dangling symlink results in exit code
	// 1.
	if must_dereference && let Err(err) = get_metadata_with_deref_opt(path, must_dereference) {
		// The Path couldn't be dereferenced, so return early and set exit code 1
		// to indicate a minor error
		// Only show error when context display is requested to avoid duplicate messages
		if config.context {
			show_ls_error(LsError::IOErrorContext(path.to_path_buf(), err, false));
		}
		return Cow::Borrowed(SUBSTITUTE_STRING);
	}

	#[cfg(all(feature = "selinux", any(target_os = "linux", target_os = "android")))]
	if config.selinux_supported {
		match selinux::SecurityContext::of_path(pi_uutils_ctx::resolve(path), must_dereference, false)
		{
			Err(_r) => {
				// TODO: show the actual reason why it failed
				let _ = writeln!(
					pi_uutils_ctx::stderr(),
					"ls: warning: failed to get security context of: {}",
					path.quote()
				);
				return Cow::Borrowed(SUBSTITUTE_STRING);
			},
			Ok(None) => return Cow::Borrowed(SUBSTITUTE_STRING),
			Ok(Some(context)) => {
				let context = context.as_bytes();

				let context = context.strip_suffix(&[0]).unwrap_or(context);

				let res: String = match str::from_utf8(context) {
					Ok(s) => s.to_string(),
					Err(e) => {
						let _ = writeln!(
							pi_uutils_ctx::stderr(),
							"ls: warning: getting security context of: {}: {}",
							path.quote(),
							e
						);
						String::from_utf8_lossy(context).into_owned()
					},
				};

				return Cow::Owned(res);
			},
		}
	}

	#[cfg(all(feature = "smack", target_os = "linux"))]
	if config.smack_supported {
		// For SMACK, use the path to get the label
		// If must_dereference is true, we follow the symlink
		let target_path = if must_dereference {
			fs::canonicalize(pi_uutils_ctx::resolve(path)).unwrap_or_else(|_| path.to_path_buf())
		} else {
			path.to_path_buf()
		};

		return uucore::smack::get_smack_label_for_path(&target_path)
			.map_or(Cow::Borrowed(SUBSTITUTE_STRING), Cow::Owned);
	}

	Cow::Borrowed(SUBSTITUTE_STRING)
}
