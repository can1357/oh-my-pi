//! `dd` builtin: copy a file, converting and formatting according to operands.
//!
//! The copy engine implements block accounting, conversions, statistics, and
//! diagnostics to match the reference output byte for byte. Files
//! open through the shell's filesystem; without `if=`/`of=` the
//! command's own standard streams are used, and seeking them (`skip=`,
//! `seek=`, `conv=sparse`) reaches the shell's descriptor when it has one.

mod human;
mod tables;

use std::{
	ffi::{OsStr, OsString},
	io::{self, Read, Seek, SeekFrom, Write},
	time::{Duration, Instant},
};

use brush_core::{ShellExtensions, builtins::Registration, openfiles::OpenFile};
use clap::{Arg, ArgMatches, Command};
use pi_vfs::{File, OpenOptions};
use uucore::{
	display::Quotable,
	format::num_format::{Float, FloatVariant, Formatter},
	parser::parse_size::{ParseSizeError, Parser as SizeParser, allow_list_with_all_suffixes},
};

use self::human::human_readable;
use crate::host::{Host, Utility, format_usage, matches_parser, strip_errno, util};

/// Default `ibs`/`obs`.
const DEFAULT_BLOCKSIZE: usize = 512;

/// `MIN (IDX_MAX - 1, MIN (SSIZE_MAX, OFF_T_MAX))` on a 64-bit host.
const MAX_BLOCKSIZE: i64 = i64::MAX - 1;

// Conversions (`conv=`).
const C_ASCII: u32 = 1 << 0;
const C_EBCDIC: u32 = 1 << 1;
const C_IBM: u32 = 1 << 2;
const C_BLOCK: u32 = 1 << 3;
const C_UNBLOCK: u32 = 1 << 4;
const C_LCASE: u32 = 1 << 5;
const C_UCASE: u32 = 1 << 6;
const C_SWAB: u32 = 1 << 7;
const C_NOERROR: u32 = 1 << 8;
const C_NOTRUNC: u32 = 1 << 9;
const C_SYNC: u32 = 1 << 10;
/// Separate input and output buffers: output is reblocked to `obs`.
const C_TWOBUFS: u32 = 1 << 11;
const C_NOCREAT: u32 = 1 << 12;
const C_EXCL: u32 = 1 << 13;
const C_FDATASYNC: u32 = 1 << 14;
const C_FSYNC: u32 = 1 << 15;
const C_SPARSE: u32 = 1 << 16;

const CONVERSIONS: &[(&str, u32)] = &[
	("ascii", C_ASCII | C_UNBLOCK | C_TWOBUFS),
	("ebcdic", C_EBCDIC | C_BLOCK | C_TWOBUFS),
	("ibm", C_IBM | C_BLOCK | C_TWOBUFS),
	("block", C_BLOCK | C_TWOBUFS),
	("unblock", C_UNBLOCK | C_TWOBUFS),
	("lcase", C_LCASE | C_TWOBUFS),
	("ucase", C_UCASE | C_TWOBUFS),
	("sparse", C_SPARSE),
	("swab", C_SWAB | C_TWOBUFS),
	("noerror", C_NOERROR),
	("nocreat", C_NOCREAT),
	("excl", C_EXCL),
	("notrunc", C_NOTRUNC),
	("sync", C_SYNC),
	("fdatasync", C_FDATASYNC),
	("fsync", C_FSYNC),
];

// Flags (`iflag=`/`oflag=`). A zero value marks a flag GNU rejects on this
// platform because the underlying `open` flag does not exist.
const O_APPEND: u32 = 1 << 0;
const O_DIRECT: u32 = 1 << 1;
const O_DIRECTORY: u32 = 1 << 2;
const O_DSYNC: u32 = 1 << 3;
const O_NOATIME: u32 = 1 << 4;
const O_NOCACHE: u32 = 1 << 5;
const O_NOCTTY: u32 = 1 << 6;
const O_NOFOLLOW: u32 = 1 << 7;
const O_NONBLOCK: u32 = 1 << 8;
const O_SYNC: u32 = 1 << 9;
const O_FULLBLOCK: u32 = 1 << 10;
const O_COUNT_BYTES: u32 = 1 << 11;
const O_SKIP_BYTES: u32 = 1 << 12;
const O_SEEK_BYTES: u32 = 1 << 13;
const O_BINARY: u32 = 1 << 14;
const O_TEXT: u32 = 1 << 15;

const fn platform(supported: bool, flag: u32) -> u32 {
	if supported { flag } else { 0 }
}

const FLAGS: &[(&str, u32)] = &[
	("append", O_APPEND),
	("binary", platform(cfg!(windows), O_BINARY)),
	("cio", 0),
	(
		"direct",
		platform(
			cfg!(any(target_os = "linux", target_os = "android", target_os = "freebsd")),
			O_DIRECT,
		),
	),
	("directory", platform(cfg!(unix), O_DIRECTORY)),
	(
		"dsync",
		platform(
			cfg!(any(target_os = "linux", target_os = "android", target_vendor = "apple")),
			O_DSYNC,
		),
	),
	("noatime", platform(cfg!(any(target_os = "linux", target_os = "android")), O_NOATIME)),
	("nocache", O_NOCACHE),
	("noctty", platform(cfg!(unix), O_NOCTTY)),
	("nofollow", platform(cfg!(unix), O_NOFOLLOW)),
	("nolinks", 0),
	("nonblock", platform(cfg!(unix), O_NONBLOCK)),
	("sync", platform(cfg!(unix), O_SYNC)),
	("text", platform(cfg!(windows), O_TEXT)),
	("fullblock", O_FULLBLOCK),
	("count_bytes", O_COUNT_BYTES),
	("skip_bytes", O_SKIP_BYTES),
	("seek_bytes", O_SEEK_BYTES),
];

/// `status=` level.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
	None,
	NoXfer,
	Default,
	Progress,
}

/// Everything the operands select, after GNU's post-processing.
struct Settings {
	input_file:          Option<OsString>,
	output_file:         Option<OsString>,
	input_blocksize:     usize,
	output_blocksize:    usize,
	conversion_blocksize: usize,
	conversions:         u32,
	input_flags:         u32,
	output_flags:        u32,
	status:              Status,
	skip_records:        i64,
	skip_bytes:          usize,
	seek_records:        i64,
	seek_bytes:          usize,
	max_records:         i64,
	max_bytes:           usize,
	warn_partial_read:   bool,
	fullblock:           bool,
}

/// Parsed `dd` invocation: the operands, verbatim.
pub(crate) struct Dd {
	matches: ArgMatches,
}

matches_parser!(Dd, app);

impl Utility for Dd {
	const NAME: &'static str = "dd";

	fn run(self, host: &mut Host) -> i32 {
		let operands: Vec<OsString> = self
			.matches
			.get_many::<OsString>(OPERANDS)
			.map_or_default(|values| values.cloned().collect());
		let settings = match parse_operands(host, &operands) {
			Ok(settings) => settings,
			Err(code) => return code,
		};
		Copier::new(host, settings).main()
	}
}

const AFTER_HELP: &str = "  bs=BYTES        read and write up to BYTES bytes at a time (default: 512);
                  overrides ibs and obs
  cbs=BYTES       convert BYTES bytes at a time
  conv=CONVS      convert the file as per the comma separated symbol list
  count=N         copy only N input blocks
  ibs=BYTES       read up to BYTES bytes at a time (default: 512)
  if=FILE         read from FILE instead of standard input
  iflag=FLAGS     read as per the comma separated symbol list
  obs=BYTES       write BYTES bytes at a time (default: 512)
  of=FILE         write to FILE instead of standard output
  oflag=FLAGS     write as per the comma separated symbol list
  seek=N          (or oseek=N) skip N obs sized output blocks
  skip=N          (or iseek=N) skip N ibs sized input blocks
  status=LEVEL    The LEVEL of information to print to standard error;
                  'none' suppresses everything but error messages,
                  'noxfer' suppresses the final transfer statistics,
                  'progress' shows periodic transfer statistics

N and BYTES may be followed by the following multiplicative suffixes:
c=1, w=2, b=512, kB=1000, K=1024, MB=1000*1000, M=1024*1024, xM=M,
GB=1000*1000*1000, G=1024*1024*1024, and so on for T, P, E, Z, Y, R, Q.
Binary prefixes can be used, too: KiB=K, MiB=M, and so on.
If N ends in 'B', it counts bytes not blocks.

Each CONV symbol may be:

  ascii     from EBCDIC to ASCII
  ebcdic    from ASCII to EBCDIC
  ibm       from ASCII to alternate EBCDIC
  block     pad newline-terminated records with spaces to cbs-size
  unblock   replace trailing spaces in cbs-size records with newline
  lcase     change upper case to lower case
  ucase     change lower case to upper case
  sparse    try to seek rather than write all-NUL output blocks
  swab      swap every pair of input bytes
  sync      pad every input block with NULs to ibs-size; when used
            with block or unblock, pad with spaces rather than NULs
  excl      fail if the output file already exists
  nocreat   do not create the output file
  notrunc   do not truncate the output file
  noerror   continue after read errors
  fdatasync  physically write output file data before finishing
  fsync     likewise, but also write metadata

Each FLAG symbol may be:

  append    append mode (makes sense only for output; conv=notrunc suggested)
  direct    use direct I/O for data
  directory  fail unless a directory
  dsync     use synchronized I/O for data
  sync      likewise, but also for metadata
  fullblock  accumulate full blocks of input (iflag only)
  nonblock  use non-blocking I/O
  noatime   do not update access time
  nocache   Request to drop cache.  See also oflag=sync
  noctty    do not assign controlling terminal from file
  nofollow  do not follow symlinks";

const OPERANDS: &str = "operands";

/// The `dd` argument model, as uutils' `uu_app`: `--help`, `--version`, and
/// `NAME=VALUE` operands, which [`parse_operands`] interprets.
fn app() -> Command {
	Command::new(Dd::NAME)
		.version("0.8.0")
		.about("Copy a file, converting and formatting according to the operands.")
		.override_usage(format_usage("dd [OPERAND]...\ndd OPTION"))
		.after_help(AFTER_HELP)
		.infer_long_args(true)
		.arg(Arg::new(OPERANDS).num_args(1..).value_parser(clap::value_parser!(OsString)))
}

/// Creates the `dd` builtin registration.
pub(crate) fn dd_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Dd, SE>()
}

// ---------------------------------------------------------------------------
// Operand parsing.

/// Splits a `NAME=VALUE` operand at its first `=`.
fn split_operand(operand: &OsStr) -> Option<(&str, &OsStr)> {
	let bytes = operand.as_encoded_bytes();
	let eq = bytes.iter().position(|&b| b == b'=')?;
	let name = std::str::from_utf8(&bytes[..eq]).ok()?;
	// SAFETY: `bytes` came from `as_encoded_bytes` and is split right after
	// the ASCII `=`, a valid boundary for `from_encoded_bytes_unchecked`.
	let value = unsafe { OsStr::from_encoded_bytes_unchecked(&bytes[eq + 1..]) };
	Some((name, value))
}

/// A comma-separated `conv=`/`iflag=`/`oflag=` list: the or-ed flags of
/// `table` (whose zero entries this platform does not support).
fn parse_symbols(host: &mut Host, value: &OsStr, table: &[(&str, u32)], error: &str) -> Result<u32, i32> {
	let value = value.to_string_lossy();
	let mut flags = 0;
	for symbol in value.split(',') {
		match table.iter().find(|(name, flag)| *flag != 0 && *name == symbol) {
			Some((_, flag)) => flags |= flag,
			None => return Err(host.usage_error(format_args!("{error}: {}", symbol.quote()), 1)),
		}
	}
	Ok(flags)
}

/// Why a number operand was rejected.
#[derive(Debug, PartialEq, Eq)]
enum NumberError {
	Invalid,
	Overflow,
}

/// One `x`-free factor of a number operand (uutils' `parse_bytes_no_x`):
/// digits with an optional unit, parsed by `uucore`'s size parser plus dd's
/// own `c` (1), `w` (2), and `b` (512) units.
///
/// GNU's `xstrtoumax` grammar is kept where `parse_size` is broader:
/// numbers are decimal only (`010` is ten, not octal eight), leading white
/// space and `+` are skipped, a lone unit means one of it (`K` is 1024),
/// lower case `k` is the only lower-case multiplier, and dd's `B` (bytes)
/// marker may follow a unit that does not already end in `B` (`1cB`, `1kDB`).
fn parse_factor(factor: &str) -> Result<u128, NumberError> {
	let factor = factor.trim_start_matches([' ', '\t', '\n', '\x0b', '\x0c', '\r']);
	let factor = factor.strip_prefix('+').unwrap_or(factor);
	let digits = factor.bytes().take_while(u8::is_ascii_digit).count();
	let (number, unit) = factor.split_at(digits);
	let number = match number.trim_start_matches('0') {
		"" if digits > 0 => "0",
		trimmed => trimmed,
	};
	match parse_unit(number, unit) {
		Err(NumberError::Invalid) => match unit.strip_suffix('B') {
			Some(rest) if (digits > 0 || !rest.is_empty()) && !rest.ends_with('B') => {
				parse_unit(number, rest)
			},
			_ => Err(NumberError::Invalid),
		},
		parsed => parsed,
	}
}

/// `number` (decimal digits, possibly none) times `unit`.
fn parse_unit(number: &str, unit: &str) -> Result<u128, NumberError> {
	let (rest, scale) = match unit {
		"c" => ("", 1),
		"w" => ("", 2),
		"b" => ("", 512),
		_ => (unit, 1),
	};
	if number.is_empty() && rest.is_empty() {
		// A lone unit means one of it; nothing at all is no number.
		return if unit.is_empty() { Err(NumberError::Invalid) } else { Ok(scale) };
	}
	// Checked up front: `parse_size` reads `0b1` as binary before it looks
	// at the unit.
	if !rest.is_empty() && !allow_list_with_all_suffixes("KMGTPEZYRQk").iter().any(|u| u == rest) {
		return Err(NumberError::Invalid);
	}
	let value = SizeParser::default().parse(&format!("{number}{rest}")).map_err(|error| match error {
		ParseSizeError::SizeTooBig(_) => NumberError::Overflow,
		_ => NumberError::Invalid,
	})?;
	value.checked_mul(scale).ok_or(NumberError::Overflow)
}

/// A number operand (uutils' `parse_bytes_with_opt_multiplier`): factors
/// joined by `x` are multiplied. Returns the value and whether a `0x`
/// factor made it zero, which earns GNU's warning.
fn parse_number(value: &str) -> Result<(u64, bool), NumberError> {
	let factors: Vec<&str> = value.split('x').collect();
	let parsed: Vec<_> = factors.iter().map(|factor| parse_factor(factor)).collect();
	if parsed.contains(&Err(NumberError::Invalid)) {
		return Err(NumberError::Invalid);
	}
	// A zero factor wins over an overflowing one, as in GNU.
	if parsed.contains(&Ok(0)) {
		let zero_multiplier = factors[..factors.len() - 1].contains(&"0");
		return Ok((0, zero_multiplier));
	}
	let mut product: u128 = 1;
	for factor in parsed {
		product = product.checked_mul(factor?).ok_or(NumberError::Overflow)?;
	}
	match u64::try_from(product) {
		Ok(product) if product <= i64::MAX as u64 => Ok((product, false)),
		_ => Err(NumberError::Overflow),
	}
}

/// GNU `scanargs`: operands in order, then the cross-operand rules.
fn parse_operands(host: &mut Host, operands: &[OsString]) -> Result<Settings, i32> {
	let mut input_file = None;
	let mut output_file = None;
	let mut conversions = 0;
	let mut input_flags = 0;
	let mut output_flags = 0;
	let mut status = Status::Default;
	let mut blocksize = 0usize;
	let mut input_blocksize = 0usize;
	let mut output_blocksize = 0usize;
	let mut conversion_blocksize = 0usize;
	let mut skip: i64 = 0;
	let mut seek_records: i64 = 0;
	let mut max_records: i64 = i64::MAX;
	let mut skip_bytes_suffix = false;
	let mut seek_bytes_suffix = false;
	let mut count_bytes_suffix = false;

	for operand in operands {
		let unrecognized = |host: &mut Host| {
			host.usage_error(format_args!("unrecognized operand {}", operand.quote()), 1)
		};
		let Some((name, value)) = split_operand(operand) else {
			return Err(unrecognized(host));
		};
		match name {
			"if" => input_file = Some(value.to_os_string()),
			"of" => output_file = Some(value.to_os_string()),
			"conv" => conversions |= parse_symbols(host, value, CONVERSIONS, "invalid conversion")?,
			"iflag" => input_flags |= parse_symbols(host, value, FLAGS, "invalid input flag")?,
			"oflag" => output_flags |= parse_symbols(host, value, FLAGS, "invalid output flag")?,
			"status" => {
				// Exclusive: the last level listed wins.
				for level in value.to_string_lossy().split(',') {
					status = match level {
						"none" => Status::None,
						"noxfer" => Status::NoXfer,
						"progress" => Status::Progress,
						_ => {
							let message = format_args!("invalid status level: {}", level.quote());
							return Err(host.usage_error(message, 1));
						},
					};
				}
			},
			"bs" | "ibs" | "obs" | "cbs" | "skip" | "iseek" | "seek" | "oseek" | "count" => {
				let (n_min, n_max) = match name {
					"ibs" | "obs" | "bs" => (1, MAX_BLOCKSIZE),
					"cbs" => (1, i64::MAX),
					_ => (0, i64::MAX),
				};
				let parsed = value.to_str().ok_or(NumberError::Invalid).and_then(parse_number);
				let n = match parsed {
					Ok((n, zero_multiplier)) => {
						if zero_multiplier {
							let _ = writeln!(
								host.stderr,
								"dd: warning: {} is a zero multiplier; use {} if that is intended",
								"0x".quote(),
								"00x".quote()
							);
						}
						if n < n_min as u64 {
							Err(NumberError::Invalid)
						} else if n > n_max as u64 {
							Err(NumberError::Overflow)
						} else {
							Ok(n as i64)
						}
					},
					Err(error) => Err(error),
				};
				let n = match n {
					Ok(n) => n,
					Err(error) => {
						let reason = match error {
							NumberError::Overflow => format!(": {}", strip_errno(&eoverflow())),
							NumberError::Invalid => String::new(),
						};
						let _ = writeln!(host.stderr, "dd: invalid number: {}{reason}", value.quote());
						return Err(1);
					},
				};
				let bytes_suffix = value.as_encoded_bytes().contains(&b'B');
				match name {
					"ibs" => input_blocksize = n as usize,
					"obs" => output_blocksize = n as usize,
					"bs" => blocksize = n as usize,
					"cbs" => conversion_blocksize = n as usize,
					"skip" | "iseek" => {
						skip = n;
						skip_bytes_suffix |= bytes_suffix;
					},
					"seek" | "oseek" => {
						seek_records = n;
						seek_bytes_suffix |= bytes_suffix;
					},
					_ => {
						max_records = n;
						count_bytes_suffix |= bytes_suffix;
					},
				}
			},
			_ => return Err(unrecognized(host)),
		}
	}

	if blocksize != 0 {
		input_blocksize = blocksize;
		output_blocksize = blocksize;
	} else {
		// POSIX: without bs=, partial reads are aggregated into obs blocks.
		conversions |= C_TWOBUFS;
	}
	if input_blocksize == 0 {
		input_blocksize = DEFAULT_BLOCKSIZE;
	}
	if output_blocksize == 0 {
		output_blocksize = DEFAULT_BLOCKSIZE;
	}
	if conversion_blocksize == 0 {
		conversions &= !(C_BLOCK | C_UNBLOCK);
	}

	if output_flags & O_FULLBLOCK != 0 {
		return Err(host.usage_error("invalid output flag: 'fullblock'", 1));
	}

	if skip_bytes_suffix {
		input_flags |= O_SKIP_BYTES;
	}
	let (skip_records, skip_bytes) = if input_flags & O_SKIP_BYTES != 0 && skip != 0 {
		(skip / input_blocksize as i64, (skip % input_blocksize as i64) as usize)
	} else {
		(skip, 0)
	};

	if count_bytes_suffix {
		input_flags |= O_COUNT_BYTES;
	}
	let mut max_bytes = 0;
	if input_flags & O_COUNT_BYTES != 0 && max_records != i64::MAX {
		max_bytes = (max_records % input_blocksize as i64) as usize;
		max_records /= input_blocksize as i64;
	}

	if seek_bytes_suffix {
		output_flags |= O_SEEK_BYTES;
	}
	let mut seek_bytes = 0;
	if output_flags & O_SEEK_BYTES != 0 && seek_records != 0 {
		seek_bytes = (seek_records % output_blocksize as i64) as usize;
		seek_records /= output_blocksize as i64;
	}

	let warn_partial_read = conversions & C_TWOBUFS == 0
		&& input_flags & O_FULLBLOCK == 0
		&& (skip_records != 0
			|| (0 < max_records && max_records < i64::MAX)
			|| (input_flags | output_flags) & O_DIRECT != 0);
	let fullblock = input_flags & O_FULLBLOCK != 0;
	input_flags &= !O_FULLBLOCK;

	let multiple_bits = |bits: u32| bits & bits.wrapping_sub(1) != 0;
	let die = |host: &mut Host, message: &str| {
		let _ = writeln!(host.stderr, "dd: {message}");
		1
	};
	if multiple_bits(conversions & (C_ASCII | C_EBCDIC | C_IBM)) {
		return Err(die(host, "cannot combine any two of {ascii,ebcdic,ibm}"));
	}
	if multiple_bits(conversions & (C_BLOCK | C_UNBLOCK)) {
		return Err(die(host, "cannot combine block and unblock"));
	}
	if multiple_bits(conversions & (C_LCASE | C_UCASE)) {
		return Err(die(host, "cannot combine lcase and ucase"));
	}
	if multiple_bits(conversions & (C_EXCL | C_NOCREAT)) {
		return Err(die(host, "cannot combine excl and nocreat"));
	}
	if multiple_bits(input_flags & (O_DIRECT | O_NOCACHE))
		|| multiple_bits(output_flags & (O_DIRECT | O_NOCACHE))
	{
		return Err(die(host, "cannot combine direct and nocache"));
	}

	Ok(Settings {
		input_file,
		output_file,
		input_blocksize,
		output_blocksize,
		conversion_blocksize,
		conversions,
		input_flags,
		output_flags,
		status,
		skip_records,
		skip_bytes,
		seek_records,
		seek_bytes,
		max_records,
		max_bytes,
		warn_partial_read,
		fullblock,
	})
}

// ---------------------------------------------------------------------------
// Descriptor helpers for the command's own streams.

fn eoverflow() -> io::Error {
	#[cfg(unix)]
	{
		io::Error::from_raw_os_error(libc::EOVERFLOW)
	}
	#[cfg(not(unix))]
	{
		io::Error::new(io::ErrorKind::FileTooLarge, "Value too large for defined data type")
	}
}

fn espipe() -> io::Error {
	#[cfg(unix)]
	{
		io::Error::from_raw_os_error(libc::ESPIPE)
	}
	#[cfg(not(unix))]
	{
		io::Error::new(io::ErrorKind::NotSeekable, "Illegal seek")
	}
}

fn is_espipe(error: &io::Error) -> bool {
	error.kind() == io::ErrorKind::NotSeekable
}

/// What `fstat` reports that `dd` cares about.
#[derive(Clone, Copy)]
struct FileStat {
	regular:   bool,
	directory: bool,
	size:      u64,
}

impl FileStat {
	/// A pipe or in-process stream: no usable size.
	const STREAM: Self = Self { regular: false, directory: false, size: 0 };

	fn of_vfs(metadata: &pi_vfs::Metadata) -> Self {
		Self { regular: metadata.is_file(), directory: metadata.is_dir(), size: metadata.len() }
	}
}

/// `lseek` on one of the command's standard streams.
fn seek_stream(file: &OpenFile, pos: SeekFrom) -> io::Result<u64> {
	if let Some(mut file) = file.as_vfs() {
		return file.seek(pos);
	}
	#[cfg(unix)]
	{
		let Ok(fd) = file.try_borrow_as_fd() else {
			return Err(espipe());
		};
		let pos = match pos {
			SeekFrom::Start(offset) => rustix::fs::SeekFrom::Start(offset),
			SeekFrom::End(offset) => rustix::fs::SeekFrom::End(offset),
			SeekFrom::Current(offset) => rustix::fs::SeekFrom::Current(offset),
		};
		Ok(rustix::fs::seek(fd, pos)?)
	}
	#[cfg(not(unix))]
	match file {
		OpenFile::File(file) => {
			let mut file: &std::fs::File = file;
			file.seek(pos)
		},
		_ => Err(espipe()),
	}
}

/// `fstat` on one of the command's standard streams.
fn stat_stream(file: &OpenFile) -> io::Result<FileStat> {
	if let Some(file) = file.as_vfs() {
		return file.metadata().map(|metadata| FileStat::of_vfs(&metadata));
	}
	#[cfg(unix)]
	{
		let Ok(fd) = file.try_borrow_as_fd() else {
			return Ok(FileStat::STREAM);
		};
		let stat = rustix::fs::fstat(fd)?;
		let kind = rustix::fs::FileType::from_raw_mode(stat.st_mode as _);
		Ok(FileStat {
			regular:   kind == rustix::fs::FileType::RegularFile,
			directory: kind == rustix::fs::FileType::Directory,
			size:      stat.st_size as u64,
		})
	}
	#[cfg(not(unix))]
	match file {
		OpenFile::File(file) => {
			let metadata = file.metadata()?;
			Ok(FileStat { regular: metadata.is_file(), directory: metadata.is_dir(), size: metadata.len() })
		},
		_ => Ok(FileStat::STREAM),
	}
}

/// `fsync`/`fdatasync` on one of the command's standard streams.
fn sync_stream(file: &OpenFile, data_only: bool) -> io::Result<()> {
	if let Some(file) = file.as_vfs() {
		return if data_only { file.sync_data() } else { file.sync_all() };
	}
	#[cfg(unix)]
	{
		let Ok(fd) = file.try_borrow_as_fd() else {
			return Ok(());
		};
		#[cfg(not(target_vendor = "apple"))]
		if data_only {
			return Ok(rustix::fs::fdatasync(fd)?);
		}
		Ok(rustix::fs::fsync(fd)?)
	}
	#[cfg(not(unix))]
	match file {
		OpenFile::File(file) => {
			if data_only {
				file.sync_data()
			} else {
				file.sync_all()
			}
		},
		_ => Ok(()),
	}
}

/// `ftruncate` on one of the command's standard streams.
fn truncate_stream(file: &OpenFile, len: u64) -> io::Result<()> {
	if let Some(file) = file.as_vfs() {
		return file.set_len(len);
	}
	#[cfg(unix)]
	{
		let fd = file.try_borrow_as_fd().map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
		Ok(rustix::fs::ftruncate(fd, len)?)
	}
	#[cfg(not(unix))]
	match file {
		OpenFile::File(file) => file.set_len(len),
		_ => Err(io::Error::from(io::ErrorKind::InvalidInput)),
	}
}

/// The `open` flags a `dd` flag set adds, for natively opened files.
fn open_flags(flags: u32, input: bool) -> i32 {
	#[cfg(unix)]
	{
		let mut open = 0;
		let mut add = |flag: u32, value: i32| {
			if flags & flag != 0 {
				open |= value;
			}
		};
		add(O_DIRECTORY, libc::O_DIRECTORY);
		add(O_NOCTTY, libc::O_NOCTTY);
		add(O_NOFOLLOW, libc::O_NOFOLLOW);
		add(O_NONBLOCK, libc::O_NONBLOCK);
		add(O_SYNC, libc::O_SYNC);
		#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
		add(O_DSYNC, libc::O_DSYNC);
		#[cfg(any(target_os = "linux", target_os = "android"))]
		{
			add(O_NOATIME, libc::O_NOATIME);
			if input && flags & (O_SYNC | O_DSYNC) != 0 {
				open |= libc::O_RSYNC;
			}
		}
		let _ = input;
		open
	}
	// POSIX opens a directory for reading and fails the first read (EISDIR);
	// Win32 refuses to open one at all unless asked for backup semantics.
	#[cfg(windows)]
	{
		use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
		let _ = flags;
		if input { FILE_FLAG_BACKUP_SEMANTICS as i32 } else { 0 }
	}
	#[cfg(not(any(unix, windows)))]
	{
		let _ = (flags, input);
		0
	}
}

/// Allocates a zeroed buffer, reporting failure instead of aborting. The
/// zeroed allocation maps lazily, so a huge `bs=` costs only what is touched.
fn try_zeroed(len: usize) -> Option<Vec<u8>> {
	if len == 0 {
		return Some(Vec::new());
	}
	let layout = std::alloc::Layout::array::<u8>(len).ok()?;
	// SAFETY: `layout` has a non-zero size.
	let ptr = std::ptr::NonNull::new(unsafe { std::alloc::alloc_zeroed(layout) })?;
	// SAFETY: `ptr` came from the global allocator with the layout of `len`
	// bytes, all initialized (zeroed); capacity equals that allocation.
	Some(unsafe { Vec::from_parts(ptr, len, len) })
}

// ---------------------------------------------------------------------------
// The copy.

/// How a run ends early: `Quit` still closes the files and prints the
/// statistics (GNU `quit`), `Die` reports nothing more (GNU `error`/`die`).
enum Exit {
	Quit(i32),
	Die(i32),
}

struct Copier<'h> {
	host:   &'h mut Host,
	s:      Settings,
	input:  Option<File>,
	output: Option<File>,
	input_name:  OsString,
	output_name: OsString,

	ibuf: Option<Vec<u8>>,
	obuf: Option<Vec<u8>>,
	/// Bytes pending in `obuf`.
	oc:   usize,

	trans_table:        [u8; 256],
	translation_needed: bool,
	newline_character:  u8,
	space_character:    u8,

	r_full:     i64,
	r_partial:  i64,
	w_full:     i64,
	w_partial:  i64,
	r_truncate: i64,
	w_bytes:    u64,

	/// Input position; -1 once it overflowed.
	input_offset:     i64,
	input_seekable:   bool,
	input_seek_error: Option<io::Error>,
	prev_nread:       i64,
	warn_partial_read: bool,
	final_op_was_seek: bool,
	sparse:           bool,
	/// Column within the current conversion record (`block`/`unblock`).
	col:              usize,
	pending_spaces:   usize,
	/// The odd byte `conv=swab` carries to the next block.
	saved_byte:       Option<u8>,

	start_time:       Instant,
	next_time:        Instant,
	progress_len:     usize,
	reported_w_bytes: Option<u64>,
}

impl<'h> Copier<'h> {
	fn new(host: &'h mut Host, s: Settings) -> Self {
		let now = Instant::now();
		let warn_partial_read = s.warn_partial_read;
		let sparse = s.conversions & C_SPARSE != 0;
		Self {
			host,
			input_name: s.input_file.clone().unwrap_or_else(|| "standard input".into()),
			output_name: s.output_file.clone().unwrap_or_else(|| "standard output".into()),
			s,
			input: None,
			output: None,
			ibuf: None,
			obuf: None,
			oc: 0,
			trans_table: std::array::from_fn(|i| i as u8),
			translation_needed: false,
			newline_character: b'\n',
			space_character: b' ',
			r_full: 0,
			r_partial: 0,
			w_full: 0,
			w_partial: 0,
			r_truncate: 0,
			w_bytes: 0,
			input_offset: 0,
			input_seekable: false,
			input_seek_error: None,
			prev_nread: 0,
			warn_partial_read,
			final_op_was_seek: false,
			sparse,
			col: 0,
			pending_spaces: 0,
			saved_byte: None,
			start_time: now,
			next_time: now,
			progress_len: 0,
			reported_w_bytes: None,
		}
	}

	fn diagnose(&mut self, message: impl std::fmt::Display) {
		let _ = writeln!(self.host.stderr, "dd: {message}");
	}

	fn diagnose_errno(&mut self, error: &io::Error, message: impl std::fmt::Display) {
		let _ = writeln!(self.host.stderr, "dd: {message}: {}", strip_errno(error));
	}

	fn main(mut self) -> i32 {
		self.apply_translations();
		if let Err(code) = self.open_files() {
			return code;
		}

		self.start_time = Instant::now();
		self.next_time = self.start_time + Duration::from_secs(1);

		let mut exit_status = match self.dd_copy() {
			Ok(status) => status,
			Err(Exit::Die(code)) => return code,
			Err(Exit::Quit(code)) => return self.finish_up().unwrap_or(code),
		};
		let sync_status = self.synchronize_output();
		if sync_status != 0 {
			exit_status = sync_status;
		}
		self.finish_up().unwrap_or(exit_status)
	}

	/// Closes the files and prints the statistics; `Some(status)` when a
	/// close failed, which ends the run without statistics.
	fn finish_up(&mut self) -> Option<i32> {
		if let Some(input) = self.input.take()
			&& let Err(error) = input.close()
		{
			let name = self.input_name.quote().to_string();
			self.diagnose_errno(&error, format!("closing input file {name}"));
			return Some(1);
		}
		if let Some(output) = self.output.take()
			&& let Err(error) = output.close()
		{
			let name = self.output_name.quote().to_string();
			self.diagnose_errno(&error, format!("closing output file {name}"));
			return Some(1);
		}
		self.print_stats();
		let _ = self.host.stderr.flush();
		None
	}

	fn apply_translations(&mut self) {
		let conversions = self.s.conversions;
		let translate = |table: &[u8; 256], trans: &mut [u8; 256]| {
			for byte in trans.iter_mut() {
				*byte = table[usize::from(*byte)];
			}
		};
		if conversions & C_ASCII != 0 {
			translate(&tables::EBCDIC_TO_ASCII, &mut self.trans_table);
			self.translation_needed = true;
		}
		if conversions & C_UCASE != 0 {
			self.trans_table.iter_mut().for_each(|b| *b = b.to_ascii_uppercase());
			self.translation_needed = true;
		} else if conversions & C_LCASE != 0 {
			self.trans_table.iter_mut().for_each(|b| *b = b.to_ascii_lowercase());
			self.translation_needed = true;
		}
		let target = if conversions & C_EBCDIC != 0 {
			Some(&tables::ASCII_TO_EBCDIC)
		} else if conversions & C_IBM != 0 {
			Some(&tables::ASCII_TO_IBM)
		} else {
			None
		};
		if let Some(table) = target {
			translate(table, &mut self.trans_table);
			self.translation_needed = true;
			self.newline_character = table[usize::from(b'\n')];
			self.space_character = table[usize::from(b' ')];
		}
	}

	/// Opens `if=` and `of=` (GNU `main` before the copy).
	fn open_files(&mut self) -> Result<(), i32> {
		match self.s.input_file.clone() {
			Some(path) => {
				let resolved = self.host.resolve(&path);
				let mut options = OpenOptions::new();
				options.read(true).custom_flags(open_flags(self.s.input_flags, true));
				match self.host.fs().open_with(&resolved, &options) {
					Ok(file) => self.input = Some(file),
					Err(error) => {
						let name = path.quote().to_string();
						self.diagnose_errno(&error, format!("failed to open {name}"));
						return Err(1);
					},
				}
			},
			None => self.check_stream_flags(false)?,
		}

		match self.seek_input(SeekFrom::Current(0)) {
			Ok(offset) => {
				self.input_seekable = true;
				self.input_offset = offset as i64;
			},
			Err(error) => self.input_seek_error = Some(error),
		}

		let Some(path) = self.s.output_file.clone() else {
			return self.check_stream_flags(true);
		};
		let conversions = self.s.conversions;
		let size = (self.s.seek_records as i128) * (self.s.output_blocksize as i128)
			+ self.s.seek_bytes as i128;
		if size > i64::MAX as i128 && conversions & C_NOTRUNC == 0 {
			self.diagnose(format!(
				"offset too large: cannot truncate to a length of seek={} ({}-byte) blocks",
				self.s.seek_records, self.s.output_blocksize
			));
			return Err(1);
		}

		let truncate = self.s.seek_records == 0 && conversions & C_NOTRUNC == 0;
		let append = self.s.output_flags & O_APPEND != 0;
		let open = |read: bool| {
			let mut options = OpenOptions::new();
			options
				.read(read)
				.write(true)
				.append(append)
				// std rejects O_TRUNC with O_APPEND; truncation happens below.
				.truncate(truncate && !append)
				.create(conversions & C_NOCREAT == 0)
				.create_new(conversions & C_EXCL != 0)
				.mode(0o666)
				.custom_flags(open_flags(self.s.output_flags, false));
			options
		};
		let resolved = self.host.resolve(&path);
		let mut opened = Err(io::Error::from(io::ErrorKind::Other));
		if self.s.seek_records != 0 {
			opened = self.host.fs().open_with(&resolved, &open(true));
		}
		if opened.is_err() {
			opened = self.host.fs().open_with(&resolved, &open(false));
		}
		let file = match opened {
			Ok(file) => file,
			Err(error) => {
				let name = path.quote().to_string();
				self.diagnose_errno(&error, format!("failed to open {name}"));
				return Err(1);
			},
		};
		if truncate && append && let Err(error) = file.set_len(0) {
			let name = path.quote().to_string();
			self.diagnose_errno(&error, format!("failed to open {name}"));
			return Err(1);
		}

		if self.s.seek_records != 0 && conversions & C_NOTRUNC == 0 {
			let size = size as u64;
			if let Err(error) = file.set_len(size) {
				// POSIX specifies ftruncate only for regular files, directories,
				// and shared memory; other types (devices) fail silently.
				match file.metadata() {
					Err(stat_error) => {
						let name = path.quote().to_string();
						self.diagnose_errno(&stat_error, format!("cannot fstat {name}"));
					},
					Ok(metadata) if metadata.is_file() || metadata.is_dir() => {
						let name = path.quote().to_string();
						self.diagnose_errno(
							&error,
							format!("failed to truncate to {size} bytes in output file {name}"),
						);
					},
					Ok(_) => {},
				}
			}
		}
		self.output = Some(file);
		Ok(())
	}

	/// GNU `set_fd_flags` for the command's own stdin/stdout: only the
	/// `directory` check applies; status flags are not changed on a descriptor
	/// the shell shares.
	fn check_stream_flags(&mut self, output: bool) -> Result<(), i32> {
		let flags = if output { self.s.output_flags } else { self.s.input_flags };
		if flags & O_DIRECTORY == 0 {
			return Ok(());
		}
		let stream = if output { &self.host.stdout } else { self.host.stdin.file() };
		let error = match stat_stream(stream) {
			Ok(stat) if stat.directory => return Ok(()),
			Ok(_) => {
				#[cfg(unix)]
				{
					io::Error::from_raw_os_error(libc::ENOTDIR)
				}
				#[cfg(not(unix))]
				{
					io::Error::from(io::ErrorKind::NotADirectory)
				}
			},
			Err(error) => error,
		};
		let name = if output { &self.output_name } else { &self.input_name };
		let name = name.quote().to_string();
		self.diagnose_errno(&error, format!("setting flags for {name}"));
		Err(1)
	}

	fn read_input(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		match self.input.as_mut() {
			Some(file) => {
				let result = file.read(buf);
				// Reading a directory handle fails with ERROR_INVALID_FUNCTION
				// ("Incorrect function"); POSIX reports EISDIR.
				#[cfg(windows)]
				if let Err(error) = &result
					&& error.raw_os_error()
						== Some(windows_sys::Win32::Foundation::ERROR_INVALID_FUNCTION as i32)
					&& file.metadata().is_ok_and(|meta| meta.is_dir())
				{
					return Err(pi_vfs::is_a_directory());
				}
				result
			},
			None => self.host.stdin.read(buf),
		}
	}

	fn read_output(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		match self.output.as_mut() {
			Some(file) => file.read(buf),
			// The command's stdout is write-only here.
			None => Err(io::Error::from(io::ErrorKind::Unsupported)),
		}
	}

	fn seek_input(&mut self, pos: SeekFrom) -> io::Result<u64> {
		match self.input.as_mut() {
			Some(file) => file.seek(pos),
			None => seek_stream(self.host.stdin.file(), pos),
		}
	}

	fn seek_output(&mut self, pos: SeekFrom) -> io::Result<u64> {
		match self.output.as_mut() {
			Some(file) => file.seek(pos),
			None => seek_stream(&self.host.stdout, pos),
		}
	}

	fn stat_input(&self) -> io::Result<FileStat> {
		match self.input.as_ref() {
			Some(file) => file.metadata().map(|metadata| FileStat::of_vfs(&metadata)),
			None => stat_stream(self.host.stdin.file()),
		}
	}

	fn stat_output(&self) -> io::Result<FileStat> {
		match self.output.as_ref() {
			Some(file) => file.metadata().map(|metadata| FileStat::of_vfs(&metadata)),
			None => stat_stream(&self.host.stdout),
		}
	}

	fn advance_input_offset(&mut self, offset: i64) {
		if 0 <= self.input_offset {
			self.input_offset = self.input_offset.checked_add(offset).unwrap_or(-1);
		}
	}

	/// GNU `iread`: one `read`, retried on `EINTR`, with the partial-read
	/// warning.
	fn iread(&mut self, output: bool, buf: &mut [u8]) -> io::Result<usize> {
		let size = buf.len();
		let nread = loop {
			let result = if output { self.read_output(buf) } else { self.read_input(buf) };
			match result {
				Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
				result => break result,
			}
		};
		if let Ok(n) = nread
			&& 0 < n
			&& self.warn_partial_read
			&& 0 < self.prev_nread
			&& (self.prev_nread as usize) < size
		{
			if self.s.status != Status::None {
				let prev = self.prev_nread;
				let unit = if prev == 1 { "byte" } else { "bytes" };
				self.diagnose(format!(
					"warning: partial read ({prev} {unit}); suggest iflag=fullblock"
				));
			}
			self.warn_partial_read = false;
		}
		self.prev_nread = match nread {
			Ok(n) => n as i64,
			Err(_) => -1,
		};
		nread
	}

	/// `iread`, or with `iflag=fullblock` reads until `buf` is full or EOF.
	fn iread_fnc(&mut self, output: bool, buf: &mut [u8]) -> io::Result<usize> {
		if !self.s.fullblock {
			return self.iread(output, buf);
		}
		let mut nread = 0;
		while nread < buf.len() {
			match self.iread(output, &mut buf[nread..])? {
				0 => break,
				n => nread += n,
			}
		}
		Ok(nread)
	}

	/// GNU `iwrite`: writes all of `buf` (or seeks over it under
	/// `conv=sparse`), returning how much was written and the error that
	/// stopped it short.
	fn iwrite(&mut self, buf: &[u8]) -> (usize, Option<io::Error>) {
		let size = buf.len();
		let mut total = 0;
		while total < size {
			self.final_op_was_seek = false;
			if self.sparse && buf.iter().all(|&b| b == 0) {
				if self.seek_output(SeekFrom::Current(size as i64)).is_ok() {
					self.final_op_was_seek = true;
					total = size;
					continue;
				}
				// Don't warn about the advisory sparse request.
				self.sparse = false;
			}
			let result = match self.output.as_mut() {
				Some(file) => file.write(&buf[total..]),
				None => self.host.stdout.write(&buf[total..]),
			};
			match result {
				Ok(0) => {
					#[cfg(unix)]
					let error = io::Error::from_raw_os_error(libc::ENOSPC);
					#[cfg(not(unix))]
					let error = io::Error::from(io::ErrorKind::StorageFull);
					return (total, Some(error));
				},
				Ok(n) => total += n,
				Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
				Err(error) => return (total, Some(error)),
			}
		}
		(total, None)
	}

	fn alloc_ibuf(&mut self) -> Result<(), Exit> {
		if self.ibuf.is_some() {
			return Ok(());
		}
		let extra = usize::from(self.s.conversions & C_SWAB != 0);
		match try_zeroed(self.s.input_blocksize + extra) {
			Some(buf) => {
				self.ibuf = Some(buf);
				Ok(())
			},
			None => {
				let size = self.s.input_blocksize;
				self.diagnose(format!(
					"memory exhausted by input buffer of size {size} bytes ({})",
					human_readable(size as u64, true, 1, 1)
				));
				Err(Exit::Die(1))
			},
		}
	}

	fn alloc_obuf(&mut self) -> Result<(), Exit> {
		if self.s.conversions & C_TWOBUFS == 0 {
			return self.alloc_ibuf();
		}
		if self.obuf.is_some() {
			return Ok(());
		}
		match try_zeroed(self.s.output_blocksize) {
			Some(buf) => {
				self.obuf = Some(buf);
				Ok(())
			},
			None => {
				let size = self.s.output_blocksize;
				self.diagnose(format!(
					"memory exhausted by output buffer of size {size} bytes ({})",
					human_readable(size as u64, true, 1, 1)
				));
				Err(Exit::Die(1))
			},
		}
	}

	/// The buffer output goes through: `obuf`, or the shared `ibuf` when
	/// input and output blocks coincide.
	fn take_obuf(&mut self) -> Vec<u8> {
		if self.s.conversions & C_TWOBUFS != 0 {
			self.obuf.take().unwrap_or_default()
		} else {
			self.ibuf.take().unwrap_or_default()
		}
	}

	fn put_obuf(&mut self, buf: Vec<u8>) {
		if self.s.conversions & C_TWOBUFS != 0 {
			self.obuf = Some(buf);
		} else {
			self.ibuf = Some(buf);
		}
	}

	fn check_cancelled(&self) -> Result<(), Exit> {
		if self.host.is_cancelled() { Err(Exit::Quit(130)) } else { Ok(()) }
	}

	/// GNU `skip`: advance input (or output) by `records` blocks plus
	/// `bytes`, seeking when possible and reading otherwise. Returns the
	/// records that could not be skipped; `bytes` keeps the unskipped bytes.
	fn skip(
		&mut self,
		output: bool,
		mut records: i64,
		blocksize: usize,
		bytes: &mut usize,
	) -> Result<i64, Exit> {
		let offset = i64::try_from(records as i128 * blocksize as i128 + *bytes as i128).ok();
		let lseek_error = match offset {
			None => None,
			Some(offset) => {
				let sought = if output {
					self.seek_output(SeekFrom::Current(offset))
				} else {
					self.seek_input(SeekFrom::Current(offset))
				};
				match sought {
					Ok(_) => {
						if output {
							*bytes = 0;
							return Ok(0);
						}
						let stat = match self.stat_input() {
							Ok(stat) => stat,
							Err(error) => {
								let name = self.input_name.quote().to_string();
								self.diagnose_errno(&error, format!("cannot fstat {name}"));
								return Err(Exit::Die(1));
							},
						};
						let size = stat.size as i64;
						let mut offset = offset;
						if stat.regular
							&& 0 < size && 0 <= self.input_offset
							&& size - self.input_offset < offset
						{
							// Past EOF: report the full blocks not skipped.
							records = (offset - size) / blocksize as i64;
							offset = size - self.input_offset;
						} else {
							records = 0;
						}
						self.advance_input_offset(offset);
						return Ok(records);
					},
					Err(error) => Some(error),
				}
			},
		};

		// The seek may have failed for being too far (or not been tried).
		// If the end is reachable, that is the reason: give up.
		let end = if output {
			self.seek_output(SeekFrom::End(0))
		} else {
			self.seek_input(SeekFrom::End(0))
		};
		if end.is_ok() {
			let error = lseek_error.unwrap_or_else(eoverflow);
			let what = if output { "cannot seek" } else { "cannot skip" };
			let name = if output { &self.output_name } else { &self.input_name };
			let name = name.maybe_quote().to_string();
			self.diagnose_errno(&error, format!("{name}: {what}"));
			return Err(Exit::Quit(1));
		}
		let lseek_error = lseek_error.unwrap_or_else(espipe);

		if output {
			self.alloc_obuf()?;
		} else {
			self.alloc_ibuf()?;
		}
		let mut buf = if output { self.take_obuf() } else { self.ibuf.take().unwrap_or_default() };
		let start = usize::from(!output && self.s.conversions & C_SWAB != 0);
		let result = loop {
			if let Err(exit) = self.check_cancelled() {
				break Err(exit);
			}
			let size = if records != 0 { blocksize } else { *bytes };
			match self.iread_fnc(output, &mut buf[start..start + size]) {
				Err(error) => {
					if output {
						let name = self.output_name.maybe_quote().to_string();
						self.diagnose_errno(&lseek_error, format!("{name}: cannot seek"));
					} else {
						let name = self.input_name.quote().to_string();
						self.diagnose_errno(&error, format!("error reading {name}"));
						if self.s.conversions & C_NOERROR != 0 {
							self.print_stats();
						}
					}
					break Err(Exit::Quit(1));
				},
				Ok(0) => break Ok(records),
				Ok(n) => {
					if !output {
						self.advance_input_offset(n as i64);
					}
				},
			}
			if records != 0 {
				records -= 1;
			} else {
				*bytes = 0;
			}
			if records == 0 && *bytes == 0 {
				break Ok(0);
			}
		};
		if output {
			self.put_obuf(buf);
		} else {
			self.ibuf = Some(buf);
		}
		result
	}

	/// GNU `advance_input_after_read_error`: step past a bad block.
	fn advance_input_after_read_error(&mut self, nbytes: usize) -> bool {
		let error = if !self.input_seekable {
			match &self.input_seek_error {
				Some(error) if is_espipe(error) => return true,
				Some(error) => io::Error::new(error.kind(), strip_errno(error)),
				None => espipe(),
			}
		} else {
			self.advance_input_offset(nbytes as i64);
			if self.input_offset < 0 {
				let name = self.input_name.quote().to_string();
				self.diagnose(format!("offset overflow while reading file {name}"));
				return false;
			}
			match self.seek_input(SeekFrom::Current(0)) {
				Ok(offset) => {
					let offset = offset as i64;
					if offset == self.input_offset {
						return true;
					}
					let diff = self.input_offset - offset;
					if !(0 <= diff && diff <= nbytes as i64) && self.s.status != Status::None {
						self.diagnose("warning: invalid file offset after failed read");
					}
					match self.seek_input(SeekFrom::Current(diff)) {
						Ok(_) => return true,
						Err(error) => error,
					}
				},
				Err(error) => error,
			}
		};
		let name = self.input_name.maybe_quote().to_string();
		self.diagnose_errno(&error, format!("{name}: cannot seek"));
		false
	}

	/// GNU `dd_copy`.
	fn dd_copy(&mut self) -> Result<i32, Exit> {
		let mut exit_status = 0;
		let conversions = self.s.conversions;
		let ibs = self.s.input_blocksize;

		if self.s.skip_records != 0 || self.s.skip_bytes != 0 {
			let us_bytes = self.s.skip_records as i128 * ibs as i128 + self.s.skip_bytes as i128;
			let us_bytes_overflow = us_bytes > i64::MAX as i128;
			let input_offset0 = self.input_offset;
			let mut skip_bytes = self.s.skip_bytes;
			let us_blocks = self.skip(false, self.s.skip_records, ibs, &mut skip_bytes)?;
			if (us_blocks != 0
				|| (0 <= self.input_offset
					&& (us_bytes_overflow
						|| us_bytes != (self.input_offset - input_offset0) as i128)))
				&& self.s.status != Status::None
			{
				let name = self.input_name.maybe_quote().to_string();
				self.diagnose(format!("{name}: cannot skip to specified offset"));
			}
		}

		if self.s.seek_records != 0 || self.s.seek_bytes != 0 {
			let obs = self.s.output_blocksize;
			let mut bytes = self.s.seek_bytes;
			let mut write_records = self.skip(true, self.s.seek_records, obs, &mut bytes)?;
			if write_records != 0 || bytes != 0 {
				let mut buf = self.take_obuf();
				let zeroed = if write_records != 0 { obs } else { bytes };
				buf[..zeroed].fill(0);
				let result = loop {
					if let Err(exit) = self.check_cancelled() {
						break Err(exit);
					}
					let size = if write_records != 0 { obs } else { bytes };
					let (written, error) = self.iwrite(&buf[..size]);
					if written != size {
						let error = error.unwrap_or_else(|| io::Error::from(io::ErrorKind::WriteZero));
						let name = self.output_name.quote().to_string();
						self.diagnose_errno(&error, format!("writing to {name}"));
						break Err(Exit::Quit(1));
					}
					if write_records != 0 {
						write_records -= 1;
					} else {
						bytes = 0;
					}
					if write_records == 0 && bytes == 0 {
						break Ok(());
					}
				};
				self.put_obuf(buf);
				result?;
			}
		}

		if self.s.max_records == 0 && self.s.max_bytes == 0 {
			return Ok(exit_status);
		}

		self.alloc_ibuf()?;
		self.alloc_obuf()?;
		let mut ibuf = self.ibuf.take().unwrap_or_default();
		let result = self.copy_loop(&mut ibuf, &mut exit_status);
		self.ibuf = Some(ibuf);
		if let Some(status) = result? {
			return Ok(status);
		}

		// A byte left over from conv=swab.
		if let Some(saved) = self.saved_byte.take() {
			if conversions & C_BLOCK != 0 {
				self.copy_with_block(&[saved])?;
			} else if conversions & C_UNBLOCK != 0 {
				self.copy_with_unblock(&[saved])?;
			} else {
				self.output_char(saved)?;
			}
		}

		if conversions & C_BLOCK != 0 && self.col > 0 {
			// Pad the final, unterminated record.
			for _ in self.col..self.s.conversion_blocksize {
				self.output_char(self.space_character)?;
			}
		}

		if self.col != 0 && conversions & C_UNBLOCK != 0 {
			self.output_char(self.newline_character)?;
		}

		if self.oc != 0 {
			let obuf = self.obuf.take().unwrap_or_default();
			let oc = self.oc;
			let (written, error) = self.iwrite(&obuf[..oc]);
			self.obuf = Some(obuf);
			self.w_bytes += written as u64;
			if written != 0 {
				self.w_partial += 1;
			}
			if written != oc {
				let error = error.unwrap_or_else(|| io::Error::from(io::ErrorKind::WriteZero));
				let name = self.output_name.quote().to_string();
				self.diagnose_errno(&error, format!("error writing {name}"));
				return Ok(1);
			}
		}

		// A trailing hole from conv=sparse extends a regular file.
		if self.final_op_was_seek {
			let stat = match self.stat_output() {
				Ok(stat) => stat,
				Err(error) => {
					let name = self.output_name.quote().to_string();
					self.diagnose_errno(&error, format!("cannot fstat {name}"));
					return Ok(1);
				},
			};
			if stat.regular
				&& let Ok(offset) = self.seek_output(SeekFrom::Current(0))
				&& stat.size < offset
			{
				let truncated = match self.output.as_ref() {
					Some(file) => file.set_len(offset),
					None => truncate_stream(&self.host.stdout, offset),
				};
				if let Err(error) = truncated {
					let name = self.output_name.quote().to_string();
					self.diagnose_errno(
						&error,
						format!("failed to truncate to {offset} bytes in output file {name}"),
					);
					return Ok(1);
				}
			}
		}

		if conversions & (C_FDATASYNC | C_FSYNC) != 0
			&& self.s.status == Status::Progress
			&& self.reported_w_bytes.is_some_and(|reported| reported < self.w_bytes)
		{
			self.print_xfer_stats(None);
		}

		Ok(exit_status)
	}
}

impl Copier<'_> {
	/// The read/convert/write loop of GNU `dd_copy`. `Some(status)` ends the
	/// copy at once (a failed direct write), skipping the final flush.
	fn copy_loop(&mut self, ibuf: &mut [u8], exit_status: &mut i32) -> Result<Option<i32>, Exit> {
		let conversions = self.s.conversions;
		let ibs = self.s.input_blocksize;
		let start = usize::from(conversions & C_SWAB != 0);
		let pad = if conversions & (C_BLOCK | C_UNBLOCK) != 0 { b' ' } else { 0 };
		let sync = conversions & C_SYNC != 0;
		let noerror = conversions & C_NOERROR != 0;
		// Size of the previous block when it was partial.
		let mut partread = 0;

		loop {
			self.check_cancelled()?;
			if self.s.status == Status::Progress {
				let now = Instant::now();
				if self.next_time <= now {
					self.print_xfer_stats(Some(now));
					self.next_time += Duration::from_secs(1);
				}
			}

			let records = self.r_partial + self.r_full;
			if i128::from(records) >= i128::from(self.s.max_records) + i128::from(self.s.max_bytes != 0)
			{
				break;
			}

			// With noerror, zero the block first so the data of a failed read
			// is followed by padding.
			if sync && noerror {
				ibuf[start..start + ibs].fill(pad);
			}

			let size = if records >= self.s.max_records { self.s.max_bytes } else { ibs };
			let mut n = match self.iread_fnc(false, &mut ibuf[start..start + size]) {
				Ok(0) => break,
				Ok(n) => {
					self.advance_input_offset(n as i64);
					n
				},
				Err(error) => {
					if !noerror || self.s.status != Status::None {
						let name = self.input_name.quote().to_string();
						self.diagnose_errno(&error, format!("error reading {name}"));
					}
					if !noerror {
						*exit_status = 1;
						break;
					}
					self.print_stats();
					if !self.advance_input_after_read_error(ibs - partread) {
						*exit_status = 1;
						// Suppress duplicate diagnostics.
						self.input_seekable = false;
						self.input_seek_error = Some(espipe());
					}
					if sync && partread == 0 {
						// Replace the missing input with padding.
						0
					} else {
						continue;
					}
				},
			};

			if n < ibs {
				self.r_partial += 1;
				partread = n;
				if sync {
					if !noerror {
						ibuf[start + n..start + ibs].fill(pad);
					}
					n = ibs;
				}
			} else {
				self.r_full += 1;
				partread = 0;
			}

			if conversions & C_TWOBUFS == 0 {
				let (written, error) = self.iwrite(&ibuf[start..start + n]);
				self.w_bytes += written as u64;
				if written != n {
					let error = error.unwrap_or_else(|| io::Error::from(io::ErrorKind::WriteZero));
					let name = self.output_name.quote().to_string();
					self.diagnose_errno(&error, format!("error writing {name}"));
					return Ok(Some(1));
				}
				if n == ibs {
					self.w_full += 1;
				} else {
					self.w_partial += 1;
				}
				continue;
			}

			if self.translation_needed {
				for byte in &mut ibuf[start..start + n] {
					*byte = self.trans_table[usize::from(*byte)];
				}
			}

			let (from, len) =
				if conversions & C_SWAB != 0 { self.swab(ibuf, n) } else { (start, n) };
			let block = &ibuf[from..from + len];
			if conversions & C_BLOCK != 0 {
				self.copy_with_block(block)?;
			} else if conversions & C_UNBLOCK != 0 {
				self.copy_with_unblock(block)?;
			} else {
				self.copy_simple(block)?;
			}
		}
		Ok(None)
	}

	/// Swaps byte pairs of the `n` bytes at `ibuf[1..]`, carrying an odd byte
	/// over to the next block through the spare byte at `ibuf[0]`. Returns
	/// the swapped range.
	fn swab(&mut self, ibuf: &mut [u8], n: usize) -> (usize, usize) {
		if n == 0 {
			return (1, 0);
		}
		let (mut from, mut len) = (1, n);
		if let Some(saved) = self.saved_byte.take() {
			ibuf[0] = saved;
			from = 0;
			len += 1;
		}
		if len % 2 == 1 {
			len -= 1;
			self.saved_byte = Some(ibuf[from + len]);
		}
		for [a, b] in ibuf[from..from + len].as_chunks_mut::<2>().0 {
			std::mem::swap(a, b);
		}
		(from, len)
	}

	/// Writes a full `obuf` (GNU `write_output`).
	fn write_output(&mut self) -> Result<(), Exit> {
		let obs = self.s.output_blocksize;
		let obuf = self.obuf.take().unwrap_or_default();
		let (written, error) = self.iwrite(&obuf[..obs]);
		self.obuf = Some(obuf);
		self.w_bytes += written as u64;
		if written != obs {
			let error = error.unwrap_or_else(|| io::Error::from(io::ErrorKind::WriteZero));
			let name = self.output_name.quote().to_string();
			self.diagnose_errno(&error, format!("writing to {name}"));
			if written != 0 {
				self.w_partial += 1;
			}
			return Err(Exit::Quit(1));
		}
		self.w_full += 1;
		self.oc = 0;
		Ok(())
	}

	fn output_char(&mut self, byte: u8) -> Result<(), Exit> {
		if let Some(obuf) = self.obuf.as_mut() {
			obuf[self.oc] = byte;
		}
		self.oc += 1;
		if self.oc >= self.s.output_blocksize {
			self.write_output()?;
		}
		Ok(())
	}

	fn copy_simple(&mut self, mut buf: &[u8]) -> Result<(), Exit> {
		let obs = self.s.output_blocksize;
		while !buf.is_empty() {
			let nfree = buf.len().min(obs - self.oc);
			if let Some(obuf) = self.obuf.as_mut() {
				obuf[self.oc..self.oc + nfree].copy_from_slice(&buf[..nfree]);
			}
			buf = &buf[nfree..];
			self.oc += nfree;
			if self.oc >= obs {
				self.write_output()?;
			}
		}
		Ok(())
	}

	/// `conv=block`: newline-terminated records become `cbs`-byte records,
	/// space padded; longer records are truncated and counted.
	fn copy_with_block(&mut self, buf: &[u8]) -> Result<(), Exit> {
		let cbs = self.s.conversion_blocksize;
		for &byte in buf {
			if byte == self.newline_character {
				for _ in self.col.min(cbs)..cbs {
					self.output_char(self.space_character)?;
				}
				self.col = 0;
			} else {
				if self.col == cbs {
					self.r_truncate += 1;
				} else if self.col < cbs {
					self.output_char(byte)?;
				}
				self.col = self.col.saturating_add(1);
			}
		}
		Ok(())
	}

	/// `conv=unblock`: `cbs`-byte records lose trailing spaces and gain a
	/// newline.
	fn copy_with_unblock(&mut self, buf: &[u8]) -> Result<(), Exit> {
		let cbs = self.s.conversion_blocksize;
		let mut i = 0;
		while i < buf.len() {
			let byte = buf[i];
			let col = self.col;
			self.col += 1;
			if col >= cbs {
				self.col = 0;
				self.pending_spaces = 0;
				self.output_char(self.newline_character)?;
				// Reprocess this byte as the start of the next record.
				continue;
			}
			if byte == self.space_character {
				self.pending_spaces += 1;
			} else {
				while self.pending_spaces != 0 {
					self.output_char(self.space_character)?;
					self.pending_spaces -= 1;
				}
				self.output_char(byte)?;
			}
			i += 1;
		}
		Ok(())
	}

	/// GNU `synchronize_output`: `conv=fdatasync`/`conv=fsync`.
	fn synchronize_output(&mut self) -> i32 {
		let mut mask = self.s.conversions;
		self.s.conversions &= !(C_FDATASYNC | C_FSYNC);
		let mut status = 0;
		if mask & C_FDATASYNC != 0
			&& let Err(error) = self.sync_output(true)
		{
			if !sync_unsupported(&error) {
				let name = self.output_name.quote().to_string();
				self.diagnose_errno(&error, format!("fdatasync failed for {name}"));
				status = 1;
			}
			mask |= C_FSYNC;
		}
		if mask & C_FSYNC != 0
			&& let Err(error) = self.sync_output(false)
		{
			let name = self.output_name.quote().to_string();
			self.diagnose_errno(&error, format!("fsync failed for {name}"));
			return 1;
		}
		status
	}

	fn sync_output(&self, data_only: bool) -> io::Result<()> {
		match self.output.as_ref() {
			Some(file) if data_only => file.sync_data(),
			Some(file) => file.sync_all(),
			None => sync_stream(&self.host.stdout, data_only),
		}
	}

	/// GNU `print_stats`: the record counts and the transfer line.
	fn print_stats(&mut self) {
		if self.s.status == Status::None {
			return;
		}
		if self.progress_len > 0 {
			let _ = writeln!(self.host.stderr);
			self.progress_len = 0;
		}
		let _ = write!(
			self.host.stderr,
			"{}+{} records in\n{}+{} records out\n",
			self.r_full, self.r_partial, self.w_full, self.w_partial
		);
		if self.r_truncate != 0 {
			let plural = if self.r_truncate == 1 { "" } else { "s" };
			let _ = writeln!(self.host.stderr, "{} truncated record{plural}", self.r_truncate);
		}
		if self.s.status == Status::NoXfer {
			return;
		}
		self.print_xfer_stats(None);
	}

	/// GNU `print_xfer_stats`; `progress` is the time of a periodic
	/// `status=progress` report, which rewrites the current line.
	fn print_xfer_stats(&mut self, progress: Option<Instant>) {
		let now = progress.unwrap_or_else(Instant::now);
		let w_bytes = self.w_bytes;
		let si = human_readable(w_bytes, false, 1, 1);
		let iec = human_readable(w_bytes, true, 1, 1);

		let elapsed = u64::try_from(now.saturating_duration_since(self.start_time).as_nanos())
			.unwrap_or(u64::MAX);
		let (delta_s, rate) = if elapsed > 0 {
			let rate = human_readable(w_bytes, false, 1_000_000_000, elapsed);
			(elapsed as f64 / 1e9, format!("{rate}/s"))
		} else {
			(0.0, "Infinity B/s".to_string())
		};
		let time = if progress.is_some() {
			format!("{delta_s:.0} s")
		} else {
			// `%g`.
			let mut time = Vec::new();
			let float = Float { variant: FloatVariant::Shortest, ..Default::default() };
			let _ = float.fmt(&mut time, &delta_s.into());
			format!("{} s", String::from_utf8_lossy(&time))
		};

		let lacks_prefix = |s: &str| s.as_bytes()[s.len() - 2] == b' ';
		let line = if lacks_prefix(&si) {
			let unit = if w_bytes == 1 { "byte" } else { "bytes" };
			format!("{w_bytes} {unit} copied, {time}, {rate}")
		} else if lacks_prefix(&iec) {
			format!("{w_bytes} bytes ({si}) copied, {time}, {rate}")
		} else {
			format!("{w_bytes} bytes ({si}, {iec}) copied, {time}, {rate}")
		};

		let stderr = &mut self.host.stderr;
		if progress.is_some() {
			let padding = self.progress_len.saturating_sub(line.len());
			let _ = write!(stderr, "\r{line}{:padding$}", "");
			self.progress_len = line.len();
		} else {
			let _ = writeln!(stderr, "{line}");
		}
		let _ = stderr.flush();
		self.reported_w_bytes = Some(w_bytes);
	}
}

/// `fdatasync` errors GNU tolerates (falling back to `fsync`).
fn sync_unsupported(error: &io::Error) -> bool {
	#[cfg(unix)]
	{
		matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EINVAL))
	}
	#[cfg(not(unix))]
	{
		matches!(error.kind(), io::ErrorKind::Unsupported | io::ErrorKind::InvalidInput)
	}
}

#[cfg(test)]
mod tests {
	use std::{
		collections::VecDeque,
		fs,
		path::{Path, PathBuf},
		sync::{Arc, Mutex},
	};

	use brush_core::openfiles;
	use clap::Parser;

	use super::*;
	use crate::host::run_caught;

	/// A pipe-like stdin delivering one queued chunk per `read`.
	#[derive(Clone)]
	struct Chunked(Arc<Mutex<VecDeque<Vec<u8>>>>);

	impl Chunked {
		fn new(chunks: &[&[u8]]) -> Box<Self> {
			Box::new(Self(Arc::new(Mutex::new(chunks.iter().map(|chunk| chunk.to_vec()).collect()))))
		}
	}

	impl Read for Chunked {
		fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
			let mut chunks = self.0.lock().unwrap();
			let Some(chunk) = chunks.front_mut() else {
				return Ok(0);
			};
			let n = chunk.len().min(buf.len());
			buf[..n].copy_from_slice(&chunk[..n]);
			chunk.drain(..n);
			if chunk.is_empty() {
				chunks.pop_front();
			}
			Ok(n)
		}
	}

	impl Write for Chunked {
		fn write(&mut self, _: &[u8]) -> io::Result<usize> {
			Err(io::Error::from(io::ErrorKind::Unsupported))
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	impl openfiles::Stream for Chunked {
		fn clone_box(&self) -> Box<dyn openfiles::Stream> {
			Box::new(self.clone())
		}

		#[cfg(unix)]
		fn try_clone_to_owned(&self) -> Result<std::os::fd::OwnedFd, brush_core::Error> {
			Err(brush_core::error::ErrorKind::CannotConvertToNativeFd.into())
		}

		#[cfg(unix)]
		fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, brush_core::Error> {
			Err(brush_core::error::ErrorKind::CannotConvertToNativeFd.into())
		}
	}

	struct Outcome {
		code: i32,
		out:  Vec<u8>,
		err:  String,
	}

	impl Outcome {
		/// Stderr with the elapsed time and rate replaced by `T` and `R`.
		fn stats(&self) -> String {
			let pattern = regex::Regex::new(r"copied, [0-9.e+-]+ s, [0-9.]+ [kMGTPEZYRQ]?B/s").unwrap();
			pattern.replace_all(&self.err, "copied, T, R").into_owned()
		}
	}

	fn run_with(args: &[&str], stdin: Box<dyn openfiles::Stream>, cwd: &Path) -> Outcome {
		let (mut host, capture) = Host::for_test_with_stdin("dd", stdin, cwd);
		let argv = std::iter::once("dd").chain(args.iter().copied());
		let code = match Dd::try_parse_from(argv) {
			Ok(parsed) => run_caught(parsed, &mut host),
			Err(error) if error.use_stderr() => {
				let _ = write!(host.stderr, "{error}");
				1
			},
			Err(error) => {
				let _ = write!(host.stdout, "{error}");
				0
			},
		};
		drop(host);
		Outcome { code, out: capture.stdout(), err: capture.err() }
	}

	fn run(args: &[&str], stdin: &[u8], cwd: &Path) -> Outcome {
		run_with(args, Chunked::new(&[stdin]), cwd)
	}

	fn tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let root = fs::canonicalize(dir.path()).unwrap();
		(dir, root)
	}

	const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

	#[test]
	fn skip_and_count_select_byte_records() {
		let (_dir, root) = tempdir();
		fs::write(root.join("f"), DIGITS).unwrap();
		let outcome = run(&["if=f", "bs=1", "skip=10", "count=20"], b"", &root);
		assert_eq!(outcome.code, 0);
		assert_eq!(outcome.out, b"abcdefghijklmnopqrst");
		assert_eq!(
			outcome.stats(),
			"20+0 records in\n20+0 records out\n20 bytes copied, T, R\n"
		);
	}

	#[test]
	fn copies_to_file_counting_partial_last_block() {
		let (_dir, root) = tempdir();
		let data: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
		fs::write(root.join("f"), &data).unwrap();
		let outcome = run(&["if=f", "of=g", "bs=4k"], b"", &root);
		assert_eq!(outcome.code, 0);
		assert_eq!(fs::read(root.join("g")).unwrap(), data);
		assert_eq!(
			outcome.stats(),
			"2+1 records in\n2+1 records out\n10000 bytes (10 kB, 9.8 KiB) copied, T, R\n"
		);
	}

	#[test]
	fn stats_name_only_the_units_that_carry_a_prefix() {
		let (_dir, root) = tempdir();
		fs::write(root.join("f"), vec![b'x'; 1000]).unwrap();
		let outcome = run(&["if=f", "of=g"], b"", &root);
		assert_eq!(
			outcome.stats(),
			"1+1 records in\n1+1 records out\n1000 bytes (1.0 kB) copied, T, R\n"
		);
		let outcome = run(&["if=f", "of=g", "count=1", "bs=1"], b"", &root);
		assert!(outcome.stats().ends_with("\n1 byte copied, T, R\n"), "{}", outcome.err);
	}

	#[test]
	fn case_conversions_translate_ascii_letters() {
		let (_dir, root) = tempdir();
		let outcome = run(&["conv=ucase"], b"Hello, World! \xe9", &root);
		assert_eq!(outcome.out, b"HELLO, WORLD! \xe9");
		let outcome = run(&["conv=lcase", "status=none"], b"MiXeD", &root);
		assert_eq!(outcome.out, b"mixed");
	}

	#[test]
	fn ebcdic_tables_map_letters_and_newline() {
		let (_dir, root) = tempdir();
		let outcome = run(&["conv=ebcdic", "status=none"], b"A\n ", &root);
		assert_eq!(outcome.out, [0xc1, 0x25, 0x40]);
		let outcome = run(&["conv=ascii", "status=none"], &[0xc1, 0x25, 0x40], &root);
		assert_eq!(outcome.out, b"A\n ");
	}

	#[test]
	fn seek_keeps_or_truncates_the_tail_per_notrunc() {
		let (_dir, root) = tempdir();
		fs::write(root.join("g"), b"0123456789").unwrap();
		let outcome = run(&["of=g", "conv=notrunc", "seek=2", "bs=3"], b"AB", &root);
		assert_eq!(outcome.code, 0);
		assert_eq!(fs::read(root.join("g")).unwrap(), b"012345AB89");

		fs::write(root.join("g"), b"0123456789").unwrap();
		run(&["of=g", "seek=2", "bs=3"], b"AB", &root);
		assert_eq!(fs::read(root.join("g")).unwrap(), b"012345AB");

		// Byte-unit seeks never suppress O_TRUNC, which GNU keys on records.
		fs::write(root.join("g"), b"0123456789").unwrap();
		run(&["of=g", "seek=3", "oflag=seek_bytes"], b"AB", &root);
		assert_eq!(fs::read(root.join("g")).unwrap(), b"\0\0\0AB");
	}

	#[test]
	fn byte_flags_and_b_suffix_count_bytes_not_blocks() {
		let (_dir, root) = tempdir();
		fs::write(root.join("f"), DIGITS).unwrap();
		let outcome = run(&["if=f", "iflag=skip_bytes,count_bytes", "skip=5", "count=13", "bs=4"], b"", &root);
		assert_eq!(outcome.out, b"56789abcdefgh");
		assert!(outcome.stats().starts_with("3+1 records in\n3+1 records out\n"));
		let outcome = run(&["if=f", "skip=5B", "count=13B", "bs=4"], b"", &root);
		assert_eq!(outcome.out, b"56789abcdefgh");
	}

	#[test]
	fn fullblock_accumulates_short_pipe_reads() {
		let (_dir, root) = tempdir();
		let chunks: &[&[u8]] = &[b"abc", b"defghij"];
		let outcome = run_with(&["bs=4", "count=2", "iflag=fullblock"], Chunked::new(chunks), &root);
		assert_eq!(outcome.out, b"abcdefgh");
		assert!(outcome.stats().starts_with("2+0 records in\n2+0 records out\n"));

		let outcome = run_with(&["bs=4", "count=2"], Chunked::new(chunks), &root);
		assert_eq!(outcome.out, b"abcdefg");
		assert_eq!(
			outcome.stats(),
			"dd: warning: partial read (3 bytes); suggest iflag=fullblock\n1+1 records in\n1+1 records \
			 out\n7 bytes copied, T, R\n"
		);
	}

	#[test]
	fn without_bs_output_is_reblocked_to_obs() {
		let (_dir, root) = tempdir();
		let chunks: &[&[u8]] = &[b"abc", b"defghij"];
		let outcome = run_with(&["ibs=4", "obs=3"], Chunked::new(chunks), &root);
		assert_eq!(outcome.out, b"abcdefghij");
		assert!(outcome.stats().starts_with("1+2 records in\n3+1 records out\n"));
	}

	#[test]
	fn sync_pads_short_blocks_with_nuls_or_spaces() {
		let (_dir, root) = tempdir();
		let outcome = run(&["bs=4", "conv=sync", "status=none"], b"abcdef", &root);
		assert_eq!(outcome.out, b"abcdef\0\0");
		let outcome = run(&["bs=4", "cbs=8", "conv=sync,block", "status=none"], b"ab\n", &root);
		// The space padding is itself a record: two blocked records result.
		assert_eq!(outcome.out, b"ab              ");
	}

	#[test]
	fn block_truncates_long_records_and_counts_them() {
		let (_dir, root) = tempdir();
		let outcome = run(&["cbs=4", "conv=block"], b"ab\nabcdefg\nxyz", &root);
		assert_eq!(outcome.out, b"ab  abcdxyz ");
		assert!(outcome.stats().contains("records out\n1 truncated record\n"), "{}", outcome.err);
		let outcome = run(&["cbs=4", "conv=unblock", "status=none"], b"AB  CD  EF    GH", &root);
		assert_eq!(outcome.out, b"AB\nCD\nEF\n  GH\n");
	}

	#[test]
	fn swab_swaps_pairs_across_block_boundaries() {
		let (_dir, root) = tempdir();
		let outcome = run(&["bs=3", "conv=swab", "status=none"], b"abcdefg", &root);
		assert_eq!(outcome.out, b"badcfeg");
	}

	#[test]
	fn status_levels_trim_the_report() {
		let (_dir, root) = tempdir();
		let outcome = run(&["status=none"], b"hi", &root);
		assert_eq!((outcome.out.as_slice(), outcome.err.as_str()), (b"hi".as_slice(), ""));
		let outcome = run(&["status=noxfer"], b"hi", &root);
		assert_eq!(outcome.err, "0+1 records in\n0+1 records out\n");
		// status is exclusive: the last level wins.
		let outcome = run(&["status=none,noxfer"], b"hi", &root);
		assert_eq!(outcome.err, "0+1 records in\n0+1 records out\n");
	}

	#[test]
	fn zero_count_copies_nothing_without_allocating() {
		let (_dir, root) = tempdir();
		let outcome = run(&["bs=1M", "count=0"], b"data", &root);
		assert_eq!((outcome.code, outcome.out.len()), (0, 0));
		assert_eq!(outcome.stats(), "0+0 records in\n0+0 records out\n0 bytes copied, T, R\n");
		// A block size no allocator can satisfy is fine when nothing is read.
		assert_eq!(run(&["bs=1E", "count=0", "status=none"], b"", &root).code, 0);
	}

	#[test]
	fn missing_input_fails_before_any_statistics() {
		let (_dir, root) = tempdir();
		let outcome = run(&["if=missing", "of=out"], b"", &root);
		assert_eq!(outcome.code, 1);
		assert_eq!(outcome.err, "dd: failed to open 'missing': No such file or directory\n");
		assert!(!root.join("out").exists(), "output must not be created");
	}

	#[test]
	fn excl_refuses_an_existing_output() {
		let (_dir, root) = tempdir();
		fs::write(root.join("g"), b"keep").unwrap();
		let outcome = run(&["of=g", "conv=excl"], b"new", &root);
		assert_eq!(outcome.code, 1);
		assert_eq!(outcome.err, "dd: failed to open 'g': File exists\n");
		assert_eq!(fs::read(root.join("g")).unwrap(), b"keep");
		let outcome = run(&["of=missing", "conv=nocreat"], b"new", &root);
		assert_eq!(outcome.err, "dd: failed to open 'missing': No such file or directory\n");
	}

	#[test]
	fn operand_errors_match_gnu() {
		let (_dir, root) = tempdir();
		let try_help = "Try 'dd --help' for more information.\n";
		let cases: &[(&[&str], String)] = &[
			(&["foo"], format!("dd: unrecognized operand 'foo'\n{try_help}")),
			(&["foo=bar"], format!("dd: unrecognized operand 'foo=bar'\n{try_help}")),
			(&["-"], format!("dd: unrecognized operand '-'\n{try_help}")),
			(&["--", "x"], format!("dd: unrecognized operand 'x'\n{try_help}")),
			(&["conv=sync,"], format!("dd: invalid conversion: ''\n{try_help}")),
			(&["iflag=fullblock,foo"], format!("dd: invalid input flag: 'foo'\n{try_help}")),
			(&["oflag=fullblock"], format!("dd: invalid output flag: 'fullblock'\n{try_help}")),
			(&["status=loud"], format!("dd: invalid status level: 'loud'\n{try_help}")),
			(&["bs=1m"], "dd: invalid number: '1m'\n".to_string()),
			(&["bs=0"], "dd: invalid number: '0'\n".to_string()),
			(&["count=-1"], "dd: invalid number: '-1'\n".to_string()),
			(&["conv=lcase,ucase"], "dd: cannot combine lcase and ucase\n".to_string()),
			(&["conv=excl,nocreat"], "dd: cannot combine excl and nocreat\n".to_string()),
			(&["conv=ascii,ibm"], "dd: cannot combine any two of {ascii,ebcdic,ibm}\n".to_string()),
		];
		for (args, expected) in cases {
			let outcome = run(args, b"", &root);
			assert_eq!((outcome.code, &outcome.err), (1, expected), "args {args:?}");
		}
		let overflow = run(&["bs=1Z"], b"", &root);
		let reason = strip_errno(&eoverflow());
		assert_eq!(overflow.err, format!("dd: invalid number: '1Z': {reason}\n"));
		// Options other than --help/--version are clap usage errors.
		for option in ["-x", "--foo"] {
			let outcome = run(&[option], b"", &root);
			assert_eq!(outcome.code, 1);
			assert!(outcome.err.contains(&format!("unexpected argument '{option}'")), "{}", outcome.err);
		}
	}

	#[test]
	fn zero_multiplier_warns_once_per_operand() {
		let (_dir, root) = tempdir();
		let outcome = run(&["count=0x0x3", "status=noxfer"], b"data", &root);
		assert_eq!(outcome.code, 0);
		assert_eq!(
			outcome.err,
			"dd: warning: '0x' is a zero multiplier; use '00x' if that is intended\n0+0 records \
			 in\n0+0 records out\n"
		);
	}

	#[test]
	fn number_syntax_follows_gnu() {
		let parse = |s: &str| parse_number(s).ok().map(|(n, _)| n);
		assert_eq!(parse("2b"), Some(1024));
		assert_eq!(parse("3w"), Some(6));
		assert_eq!(parse("1kB"), Some(1000));
		assert_eq!(parse("1KiB"), Some(1024));
		assert_eq!(parse("K"), Some(1024));
		assert_eq!(parse("2x3xK"), Some(6144));
		assert_eq!(parse("1Bx2"), Some(2));
		assert_eq!(parse(" +5"), Some(5));
		assert_eq!(parse("1bB"), Some(512));
		assert_eq!(parse("1kDB"), Some(1000));
		assert_eq!(parse("1ciB"), None);
		assert_eq!(parse("1bD"), None);
		assert_eq!(parse("1KBB"), None);
		assert_eq!(parse("c"), Some(1));
		// Decimal only: no octal, hex, or binary prefixes.
		assert_eq!(parse("010"), Some(10));
		assert_eq!(parse("0b"), Some(0));
		assert_eq!(parse("0b1"), None);
		assert_eq!(parse("1kBB"), None);
		assert_eq!(parse("1bq"), None);
		assert_eq!(parse("B"), None);
		assert_eq!(parse(""), None);
		assert_eq!(parse("2x"), None);
		assert_eq!(parse("1t"), None);
		assert_eq!(parse("-5"), None);
		assert_eq!(parse_number("9223372036854775808"), Err(NumberError::Overflow));
		assert_eq!(parse_number("2x4611686018427387904"), Err(NumberError::Overflow));
		// A zero factor beats an overflowing one, and `0x` earns the warning.
		assert_eq!(parse_number("0x99999999999999999999999999999999999999999"), Ok((0, true)));
		assert_eq!(parse_number("2x0"), Ok((0, false)));
		assert_eq!(parse_number("00x5"), Ok((0, false)));
	}

	#[test]
	fn seek_on_unseekable_stdout_fails_after_statistics() {
		let (_dir, root) = tempdir();
		let outcome = run(&["seek=1"], b"data", &root);
		assert_eq!(outcome.code, 1);
		let reason = strip_errno(&espipe());
		assert_eq!(
			outcome.stats(),
			format!(
				"dd: 'standard output': cannot seek: {reason}\n0+0 records in\n0+0 records out\n0 \
				 bytes copied, T, R\n"
			)
		);
	}

	#[test]
	fn skipping_a_short_pipe_warns() {
		let (_dir, root) = tempdir();
		let outcome = run(&["bs=4", "skip=3"], b"0123456789", &root);
		assert_eq!(outcome.out, b"");
		assert!(outcome.err.starts_with("dd: 'standard input': cannot skip to specified offset\n"));
	}

	#[test]
	fn sparse_output_still_extends_the_file() {
		let (_dir, root) = tempdir();
		fs::write(root.join("zeros"), vec![0u8; 2048]).unwrap();
		let outcome = run(&["if=zeros", "of=sp", "bs=512", "conv=sparse", "status=none"], b"", &root);
		assert_eq!(outcome.code, 0);
		assert_eq!(fs::read(root.join("sp")).unwrap(), vec![0u8; 2048]);
	}

	#[test]
	fn read_errors_report_and_fail() {
		let (_dir, root) = tempdir();
		let outcome = run(&["if=."], b"", &root);
		assert_eq!(outcome.code, 1);
		assert!(outcome.err.starts_with("dd: error reading '.': Is a directory\n"), "{}", outcome.err);
		assert!(outcome.stats().ends_with("0+0 records in\n0+0 records out\n0 bytes copied, T, R\n"));
	}

	#[test]
	fn cancellation_stops_an_endless_copy() {
		let (_dir, root) = tempdir();
		let (mut host, _capture) = Host::for_test_with_stdin("dd", Chunked::new(&[&[1; 64]]), &root);
		host.cancel_for_test();
		let parsed = Dd::try_parse_from(["dd", "--", "status=none"]).unwrap();
		assert_eq!(run_caught(parsed, &mut host), 130);
	}

	#[test]
	fn help_goes_to_stdout() {
		let (_dir, root) = tempdir();
		let outcome = run(&["--he"], b"", &root);
		assert_eq!((outcome.code, outcome.err.as_str()), (0, ""));
		let help = String::from_utf8(outcome.out).unwrap();
		assert!(help.contains("dd [OPERAND]..."), "{help}");
		assert!(help.contains("conv=CONVS"));
	}
}
