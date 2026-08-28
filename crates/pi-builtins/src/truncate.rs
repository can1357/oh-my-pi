//! `truncate` builtin: shrink or extend files to a specified size.
//!
//! Ported from uutils coreutils 0.8.0.

#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::{
	ffi::OsString,
	fs::{Metadata, OpenOptions, metadata},
	io::ErrorKind,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use uucore::{
	display::Quotable,
	parser::parse_size::{ParseSizeError, Parser, allow_list_with_all_suffixes},
};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum TruncateMode {
	Absolute(u64),
	Extend(u64),
	Reduce(u64),
	AtMost(u64),
	AtLeast(u64),
	RoundDown(u64),
	RoundUp(u64),
}

impl TruncateMode {
	/// Compute a target size in bytes for this truncate mode.
	///
	/// `fsize` is the size of the reference file, in bytes.
	///
	/// If the mode is [`TruncateMode::Reduce`] and the value to reduce by is
	/// greater than `fsize`, this returns 0 (it cannot return a negative number).
	///
	/// Returns `None` if rounding by 0, else the target size.
	fn to_size(&self, fsize: u64) -> Option<u64> {
		match self {
			Self::Absolute(size) => Some(*size),
			Self::Extend(size) => Some(fsize + size),
			Self::Reduce(size) => Some(fsize.saturating_sub(*size)),
			Self::AtMost(size) => Some(fsize.min(*size)),
			Self::AtLeast(size) => Some(fsize.max(*size)),
			Self::RoundDown(size) => fsize.checked_rem(*size).map(|remainder| fsize - remainder),
			Self::RoundUp(size) => fsize.checked_next_multiple_of(*size),
		}
	}

	/// The numeric value carried by this mode.
	fn value(&self) -> u64 {
		match self {
			Self::Absolute(n)
			| Self::Extend(n)
			| Self::Reduce(n)
			| Self::AtMost(n)
			| Self::AtLeast(n)
			| Self::RoundDown(n)
			| Self::RoundUp(n) => *n,
		}
	}

	/// Multiply this mode's value by `factor` (for `--io-blocks` scaling).
	///
	/// Returns `None` on overflow.
	fn scale(&self, factor: u64) -> Option<Self> {
		let value = self.value().checked_mul(factor)?;
		Some(match self {
			Self::Absolute(_) => Self::Absolute(value),
			Self::Extend(_) => Self::Extend(value),
			Self::Reduce(_) => Self::Reduce(value),
			Self::AtMost(_) => Self::AtMost(value),
			Self::AtLeast(_) => Self::AtLeast(value),
			Self::RoundDown(_) => Self::RoundDown(value),
			Self::RoundUp(_) => Self::RoundUp(value),
		})
	}

	/// Determine whether this mode specifies an absolute size.
	fn is_absolute(&self) -> bool {
		matches!(self, Self::Absolute(_))
	}
}

mod options {
	pub static IO_BLOCKS: &str = "io-blocks";
	pub static NO_CREATE: &str = "no-create";
	pub static REFERENCE: &str = "reference";
	pub static SIZE: &str = "size";
	pub static ARG_FILES: &str = "files";
}

/// Parsed `truncate` invocation.
pub(crate) struct Truncate {
	matches: ArgMatches,
}

matches_parser!(Truncate, app);

impl Utility for Truncate {
	const NAME: &'static str = "truncate";

	fn run(self, host: &mut Host) -> i32 {
		let files: Vec<OsString> = self
			.matches
			.get_many::<OsString>(options::ARG_FILES)
			.map(|values| values.cloned().collect())
			.unwrap_or_default();

		if files.is_empty() {
			host.error("missing file operand", 1);
			return 1;
		}

		let io_blocks = self.matches.get_flag(options::IO_BLOCKS);
		let no_create = self.matches.get_flag(options::NO_CREATE);
		let reference = self
			.matches
			.get_one::<String>(options::REFERENCE)
			.map(String::from);
		let size = self.matches.get_one::<String>(options::SIZE).map(String::from);

		if let Err(error) = truncate(host, no_create, io_blocks, reference, size, &files) {
			host.error(error, 1);
		}
		host.exit_code()
	}
}

/// The `truncate` argument model.
fn app() -> Command {
	Command::new(Truncate::NAME)
		.version("0.8.0")
		.about("Shrink or extend the size of each file to the specified size.")
		.override_usage(format_usage("truncate [OPTION]... [FILE]..."))
		.after_help(
			"SIZE is an integer with an optional prefix and optional unit.\nThe available units (K, \
			 M, G, T, P, E, Z, and Y) use the following format:\n    'KB' => 1000 (kilobytes)\n    \
			 'K' => 1024 (kibibytes)\n    'MB' => 1000*1000 (megabytes)\n    'M' => 1024*1024 \
			 (mebibytes)\n    'GB' => 1000*1000*1000 (gigabytes)\n    'G' => 1024*1024*1024 \
			 (gibibytes)\nSIZE may also be prefixed by one of the following to adjust the size of \
			 each\nfile based on its current size:\n    '+' => extend by\n    '-' => reduce by\n    \
			 '<' => at most\n    '>' => at least\n    '/' => round down to multiple of\n    '%' => \
			 round up to multiple of",
		)
		.infer_long_args(true)
		.arg(
			Arg::new(options::IO_BLOCKS)
				.short('o')
				.long(options::IO_BLOCKS)
				.help("treat SIZE as the number of I/O blocks of the file rather than bytes")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_CREATE)
				.short('c')
				.long(options::NO_CREATE)
				.help("do not create files that do not exist")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::REFERENCE)
				.short('r')
				.long(options::REFERENCE)
				.required_unless_present(options::SIZE)
				.help("base the size of each file on the size of RFILE")
				.value_name("RFILE")
				.value_hint(clap::ValueHint::FilePath),
		)
		.arg(
			Arg::new(options::SIZE)
				.short('s')
				.long(options::SIZE)
				.required_unless_present(options::REFERENCE)
				.help(
					"set or adjust the size of each file according to SIZE, which is in bytes unless \
					 --io-blocks is specified",
				)
				.allow_hyphen_values(true)
				.value_name("SIZE"),
		)
		.arg(
			Arg::new(options::ARG_FILES)
				.value_name("FILE")
				.action(ArgAction::Append)
				.required(true)
				.value_hint(clap::ValueHint::FilePath)
				.value_parser(clap::value_parser!(OsString)),
		)
}

/// The I/O block size of a file, falling back to 512 when the filesystem
/// reports 0 (mirrors GNU's `ST_BLKSIZE`).
#[cfg(unix)]
fn io_blocksize(file_metadata: &Metadata) -> u64 {
	match file_metadata.blksize() {
		0 => 512,
		blksize => blksize,
	}
}

#[cfg(not(unix))]
fn io_blocksize(_file_metadata: &Metadata) -> u64 {
	512
}

/// Truncate one file according to `mode`.
///
/// Unless `no_create` is set, the file is created if it does not already
/// exist. If the target size is larger than the file, it is padded with
/// zeros; if smaller, bytes beyond it are discarded. When `io_blocks` is
/// set, the size is scaled by the file's I/O block size, matching GNU
/// (which scales by the block size observed after opening the file).
fn file_truncate(
	host: &Host,
	no_create: bool,
	io_blocks: bool,
	reference_size: Option<u64>,
	mode: &TruncateMode,
	filename: &OsString,
) -> Result<(), String> {
	let resolved = host.resolve(filename);

	// A pipe has no length, and opening it for writing would block waiting
	// for a reader; refuse it before the open.
	#[cfg(unix)]
	if let Ok(pre_metadata) = metadata(&resolved) {
		if pre_metadata.file_type().is_fifo() {
			return Err(format!(
				"cannot open {} for writing: No such device or address",
				filename.to_string_lossy().quote()
			));
		}
	}

	let create = !no_create;
	let file = match OpenOptions::new().write(true).create(create).open(&resolved) {
		Ok(file) => file,
		Err(error) if error.kind() == ErrorKind::NotFound && !create => return Ok(()),
		Err(error) => {
			return Err(format!("cannot open {} for writing: {error}", filename.quote()));
		},
	};

	let file_metadata = file
		.metadata()
		.map_err(|error| format!("cannot fstat {}: {error}", filename.quote()))?;

	let mode = if io_blocks {
		let blksize = io_blocksize(&file_metadata);
		mode.scale(blksize).ok_or_else(|| {
			format!(
				"overflow in {} * {blksize} byte blocks for file {}",
				mode.value(),
				filename.quote()
			)
		})?
	} else {
		*mode
	};

	// The reference size is either the given reference file's size, or the size
	// of the file to be truncated when no reference was provided.
	let actual_reference_size = reference_size.unwrap_or_else(|| file_metadata.len());
	let Some(truncate_size) = mode.to_size(actual_reference_size) else {
		return Err("division by zero".to_string());
	};

	file.set_len(truncate_size).map_err(|error| {
		format!(
			"failed to truncate {} at {truncate_size} bytes: {error}",
			filename.quote()
		)
	})
}

fn truncate(
	host: &mut Host,
	no_create: bool,
	io_blocks: bool,
	reference: Option<String>,
	size: Option<String>,
	filenames: &[OsString],
) -> Result<(), String> {
	if io_blocks && size.is_none() {
		return Err("--io-blocks was specified but --size was not".to_string());
	}

	let reference_size = match reference {
		Some(reference_path) => {
			let reference_metadata = metadata(host.resolve(&reference_path)).map_err(|error| {
				match error.kind() {
					ErrorKind::NotFound => format!(
						"cannot stat {}: No such file or directory",
						reference_path.quote()
					),
					_ => error.to_string(),
				}
			})?;
			Some(reference_metadata.len())
		},
		None => None,
	};

	// Omitting the mode is equivalent to extending a file by 0 bytes.
	let mode = match size.as_deref() {
		Some(string) => parse_mode_and_size(string)
			.map_err(|error| format!("Invalid number: {error}"))?,
		None => TruncateMode::Extend(0),
	};

	// GNU rejects rounding to a multiple of zero up front, before touching
	// any file.
	if matches!(mode, TruncateMode::RoundDown(0) | TruncateMode::RoundUp(0)) {
		return Err("division by zero".to_string());
	}

	// If a reference file has been given, the truncate mode cannot be absolute.
	if reference_size.is_some() && mode.is_absolute() {
		return Err("you must specify a relative '--size' with '--reference'".to_string());
	}

	for filename in filenames {
		if let Err(error) =
			file_truncate(host, no_create, io_blocks, reference_size, &mode, filename)
		{
			host.error(error, 1);
		}
	}

	Ok(())
}

/// Decide whether a character is one of the size modifiers, like `+` or `<`.
///
/// `=` is the BSD spelling of an absolute size.
fn is_modifier(c: char) -> bool {
	c == '+' || c == '-' || c == '<' || c == '>' || c == '/' || c == '%' || c == '='
}

/// Parse a size string with an optional modifier symbol as its first character.
fn parse_mode_and_size(size_string: &str) -> Result<TruncateMode, ParseSizeError> {
	let mut size_string = size_string.trim();

	if let Some(c) = size_string.chars().next() {
		if is_modifier(c) {
			size_string = &size_string[1..];
		}
		let mut allow_list = allow_list_with_all_suffixes("EgGkKmMPQRtTYZ");
		// `b` counts 512-byte blocks (dd-style); accepted here for agent
		// convenience even though GNU truncate omits it.
		allow_list.push("b".to_string());
		let allow_list_ref = allow_list.iter().map(AsRef::as_ref).collect::<Vec<&str>>();
		Parser::default()
			.with_allow_list(&allow_list_ref)
			.parse_u64(size_string)
			.map(match c {
				'+' => TruncateMode::Extend,
				'-' => TruncateMode::Reduce,
				'<' => TruncateMode::AtMost,
				'>' => TruncateMode::AtLeast,
				'/' => TruncateMode::RoundDown,
				'%' => TruncateMode::RoundUp,
				_ => TruncateMode::Absolute,
			})
	} else {
		Err(ParseSizeError::ParseFailure(size_string.to_string()))
	}
}

/// Creates the `truncate` builtin registration.
pub(crate) fn truncate_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Truncate, SE>()
}

#[cfg(test)]
mod tests {
	use std::{fs, path::PathBuf};

	use super::*;
	use crate::host::run_util;

	fn run_in(cwd: PathBuf, args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Truncate>(args, "", cwd);
		(code, capture.out(), capture.err())
	}

	/// Canonicalized temp dir (macOS tempdirs live behind `/var` -> `/private/var`).
	fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let canon = fs::canonicalize(dir.path()).unwrap();
		(dir, canon)
	}

	fn len(path: &PathBuf) -> u64 {
		fs::metadata(path).unwrap().len()
	}

	#[test]
	fn resolves_relative_operand_against_host_cwd() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("f"), b"12345678").unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), &["-s", "5", "f"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert_eq!(len(&root.join("f")), 5);
	}

	#[test]
	fn extend_grows_by_relative_amount() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("f"), b"1234").unwrap();

		let (code, _, stderr) = run_in(root.clone(), &["-s", "+3", "f"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(len(&root.join("f")), 7);
	}

	#[test]
	fn at_most_caps_only_larger_files() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("big"), vec![0u8; 20]).unwrap();
		fs::write(root.join("small"), b"abc").unwrap();

		let (code, _, stderr) = run_in(root.clone(), &["-s", "<10", "big", "small"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(len(&root.join("big")), 10);
		assert_eq!(len(&root.join("small")), 3);
	}

	#[test]
	fn no_create_skips_missing_file() {
		let (_dir, root) = canonical_tempdir();

		let (code, stdout, stderr) = run_in(root.clone(), &["-c", "-s", "5", "missing"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert!(!root.join("missing").exists());
	}

	#[test]
	fn missing_file_without_no_create_is_created_at_size() {
		let (_dir, root) = canonical_tempdir();

		let (code, _, stderr) = run_in(root.clone(), &["-s", "9", "fresh"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(len(&root.join("fresh")), 9);
	}

	#[test]
	fn reference_copies_size_of_rfile() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("ref"), b"123456").unwrap();
		fs::write(root.join("f"), b"x").unwrap();

		let (code, _, stderr) = run_in(root.clone(), &["-r", "ref", "f"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(len(&root.join("f")), 6);
	}

	#[test]
	fn missing_reference_file_fails_with_stat_error() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("f"), b"x").unwrap();

		let (code, _, stderr) = run_in(root.clone(), &["-r", "nope", "f"]);
		assert_eq!(code, 1);
		assert!(stderr.contains("cannot stat 'nope': No such file or directory"));
		assert_eq!(len(&root.join("f")), 1, "operand must be untouched");
	}

	#[test]
	fn invalid_size_reports_error_and_exit_1() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("f"), b"x").unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), &["-s", "bogus", "f"]);
		assert_eq!((code, stdout.as_str()), (1, ""));
		assert!(stderr.contains("truncate: Invalid number:"));
		assert_eq!(len(&root.join("f")), 1, "operand must be untouched");
	}

	#[test]
	fn reference_with_absolute_size_is_rejected() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("ref"), b"123").unwrap();
		fs::write(root.join("f"), b"x").unwrap();

		let (code, _, stderr) = run_in(root.clone(), &["-r", "ref", "-s", "5", "f"]);
		assert_eq!(code, 1);
		assert!(stderr.contains("you must specify a relative '--size' with '--reference'"));
	}

	#[test]
	fn parse_mode_and_size_prefixes() {
		assert_eq!(parse_mode_and_size("10"), Ok(TruncateMode::Absolute(10)));
		assert_eq!(parse_mode_and_size("+10"), Ok(TruncateMode::Extend(10)));
		assert_eq!(parse_mode_and_size("-10"), Ok(TruncateMode::Reduce(10)));
		assert_eq!(parse_mode_and_size("<10"), Ok(TruncateMode::AtMost(10)));
		assert_eq!(parse_mode_and_size(">10"), Ok(TruncateMode::AtLeast(10)));
		assert_eq!(parse_mode_and_size("/10"), Ok(TruncateMode::RoundDown(10)));
		assert_eq!(parse_mode_and_size("%10"), Ok(TruncateMode::RoundUp(10)));
		assert_eq!(parse_mode_and_size("=10"), Ok(TruncateMode::Absolute(10)));
		assert_eq!(parse_mode_and_size("1kB"), Ok(TruncateMode::Absolute(1000)));
		// `b` counts 512-byte blocks; rejecting it broke `truncate -s 2b f`.
		assert_eq!(parse_mode_and_size("2b"), Ok(TruncateMode::Absolute(1024)));
	}

	#[test]
	fn b_suffix_counts_512_byte_blocks() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("f"), b"x").unwrap();

		let (code, _, stderr) = run_in(root.clone(), &["-s", "2b", "f"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(len(&root.join("f")), 1024);
	}

	#[test]
	fn bsd_equals_prefix_sets_absolute_size() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("f"), b"x").unwrap();

		let (code, _, stderr) = run_in(root.clone(), &["-s", "=100", "f"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(len(&root.join("f")), 100);
	}

	/// Regression: `-o` used to be parsed and then silently ignored, truncating
	/// to the raw byte count (real data loss for `truncate -o -s 1 f`).
	#[cfg(unix)]
	#[test]
	fn io_blocks_scales_size_by_file_blocksize() {
		use std::os::unix::fs::MetadataExt;

		let (_dir, root) = canonical_tempdir();
		let path = root.join("f");
		fs::write(&path, vec![0u8; 4096]).unwrap();
		let blksize = fs::metadata(&path).unwrap().blksize();
		assert!(blksize > 1, "test needs a real filesystem block size");

		let (code, _, stderr) = run_in(root.clone(), &["-o", "-s", "1", "f"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(len(&path), blksize, "-o must scale SIZE by st_blksize, not truncate to 1 byte");
	}

	#[test]
	fn io_blocks_without_size_is_rejected() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("ref"), b"123").unwrap();
		fs::write(root.join("f"), b"x").unwrap();

		let (code, _, stderr) = run_in(root.clone(), &["-o", "-r", "ref", "f"]);
		assert_eq!(code, 1);
		assert!(stderr.contains("--io-blocks was specified but --size was not"));
	}

	/// Regression: `%0`/`/0` must fail up front with GNU's error, not create
	/// or modify any operand.
	#[test]
	fn round_to_zero_is_division_by_zero_up_front() {
		let (_dir, root) = canonical_tempdir();

		for size in ["%0", "/0"] {
			let (code, _, stderr) = run_in(root.clone(), &["-s", size, "missing"]);
			assert_eq!(code, 1, "size {size} must fail");
			assert!(stderr.contains("division by zero"), "size {size}: {stderr}");
			assert!(
				!root.join("missing").exists(),
				"size {size} must not create the operand"
			);
		}
	}

	#[test]
	fn help_renders_to_stdout() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), &["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("round up to multiple of"));
		assert_eq!(stderr, "");
	}
}
