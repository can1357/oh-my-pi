//! `stat` builtin: display file or file-system status.
//!
//! Ported from uutils coreutils 0.8.0.

use brush_core::{ShellExtensions, builtins::Registration};

use crate::host::util;

#[cfg(not(any(unix, windows)))]
use crate::host::{self, Host, Utility, matches_parser};

#[cfg(any(unix, windows))]
use imp::Stat;

#[cfg(not(any(unix, windows)))]
struct Stat {
	matches: clap::ArgMatches,
}

#[cfg(not(any(unix, windows)))]
matches_parser!(Stat, app);

#[cfg(not(any(unix, windows)))]
impl Utility for Stat {
	const NAME: &'static str = "stat";

	fn run(self, host: &mut Host) -> i32 {
		let _ = self;
		host.error("unsupported on this platform", 1);
		1
	}
}

#[cfg(not(any(unix, windows)))]
fn app() -> clap::Command {
	clap::Command::new(Stat::NAME)
		.version("0.8.0")
		.about("Display file or file system status.")
		.override_usage(host::format_usage("stat [OPTION]... FILE..."))
}

/// Creates the `stat` builtin registration.
pub(crate) fn stat_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Stat, SE>()
}

#[cfg(any(unix, windows))]
mod imp {
	#[cfg(unix)]
	use std::os::unix::fs::{FileTypeExt, MetadataExt};
	use std::{
		borrow::Cow,
		cell::OnceCell,
		ffi::{OsStr, OsString},
		fs::{self, FileType, Metadata},
		io::Write,
		path::Path,
	};

	use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};
	use thiserror::Error;
	#[cfg(windows)]
	use uucore::time::{FormatSystemTimeFallback, format_system_time, system_time_to_sec};
	use uucore::display::Quotable;

	use crate::host::{self, Host, Utility, matches_parser};
	#[cfg(unix)]
	use uucore::{
		entries,
		fs::{display_permissions, major, minor},
		fsext::{
			FsMeta, MetadataTimeField, StatFs, metadata_get_time, pretty_filetype, pretty_fstype,
			read_fs_list, statfs,
		},
		libc::mode_t,
		time::{FormatSystemTimeFallback, format_system_time, system_time_to_sec},
	};

	const ABOUT: &str = "Display file or file system status.";
	const USAGE: &str = "stat [OPTION]... FILE...";
	const AFTER_HELP: &str = "Valid format sequences for files (without `--file-system`):

-`%a`: access rights in octal (note '#' and '0' printf flags)
-`%A`: access rights in human readable form
-`%b`: number of blocks allocated (see %B)
-`%B`: the size in bytes of each block reported by %b
-`%C`: SELinux security context string
-`%d`: device number in decimal
-`%D`: device number in hex
-`%f`: raw mode in hex
-`%F`: file type
-`%g`: group ID of owner
-`%G`: group name of owner
-`%h`: number of hard links
-`%i`: inode number
-`%m`: mount point
-`%n`: file name
-`%N`: quoted file name with dereference (follow) if symbolic link
-`%o`: optimal I/O transfer size hint
-`%s`: total size, in bytes
-`%t`: major device type in hex, for character/block device special files
-`%T`: minor device type in hex, for character/block device special files
-`%u`: user ID of owner
-`%U`: user name of owner
-`%w`: time of file birth, human-readable; - if unknown
-`%W`: time of file birth, seconds since Epoch; 0 if unknown
-`%x`: time of last access, human-readable
-`%X`: time of last access, seconds since Epoch
-`%y`: time of last data modification, human-readable

-`%Y`: time of last data modification, seconds since Epoch
-`%z`: time of last status change, human-readable
-`%Z`: time of last status change, seconds since Epoch

Valid format sequences for file systems:

-`%a`: free blocks available to non-superuser
-`%b`: total data blocks in file system
-`%c`: total file nodes in file system
-`%d`: free file nodes in file system
-`%f`: free blocks in file system
-`%i`: file system ID in hex
-`%l`: maximum length of filenames
-`%n`: file name
-`%s`: block size (for faster transfers)
-`%S`: fundamental block size (for block counts)
-`%t`: file system type in hex
-`%T`: file system type in human readable form

NOTE: your shell may have its own version of stat, which usually supersedes
the version described here.  Please refer to your shell's documentation
for details about the options it supports.";

	#[derive(Debug, Error)]
	enum StatError {
		#[error("Invalid quoting style: {style}")]
		InvalidQuotingStyle { style: String },
		#[error("missing operand\nTry 'stat --help' for more information.")]
		MissingOperand,
		#[error("{directive}: invalid directive")]
		InvalidDirective { directive: String },
		#[error("cannot read table of mounted file systems: {error}")]
		#[cfg_attr(not(unix), allow(dead_code, reason = "mount tables are unix-only"))]
		CannotReadFilesystem { error: String },
		#[error("using '-' to denote standard input does not work in file system mode")]
		#[cfg_attr(not(unix), allow(dead_code, reason = "stdin filesystem mode is unix-only"))]
		StdinFilesystemMode,
		#[error("cannot read file system information for {file}: {error}")]
		CannotReadFilesystemInfo { file: String, error: String },
		#[error("cannot stat {file}: {error}")]
		CannotStat { file: String, error: String },
	}

	mod options {
		pub const DEREFERENCE: &str = "dereference";
		pub const FILE_SYSTEM: &str = "file-system";
		pub const FORMAT: &str = "format";
		pub const PRINTF: &str = "printf";
		pub const TERSE: &str = "terse";
		pub const BSD_SHELL: &str = "bsd-shell";
		pub const BSD_TIMEFMT: &str = "bsd-timefmt";
		pub const FILES: &str = "files";
	}

	#[derive(Default, Debug, PartialEq, Eq, Clone, Copy)]
	struct Flags {
		alter: bool,
		zero:  bool,
		left:  bool,
		space: bool,
		sign:  bool,
		group: bool,
		major: bool,
		minor: bool,
	}

	/// checks if the string is within the specified bound,
	/// if it gets out of bound, error out by printing sub-string from index
	/// `beg` to`end`, where `beg` & `end` is the beginning and end index of
	/// sub-string, respectively
	fn check_bound(slice: &str, bound: usize, beg: usize, end: usize) -> Result<(), StatError> {
		if end >= bound {
			return Err(StatError::InvalidDirective {
				directive: slice[beg..end].quote().to_string(),
			});
		}
		Ok(())
	}

	enum Padding {
		Zero,
		Space,
	}

	/// pads the string with zeroes or spaces and prints it
	///
	/// # Example
	/// ```ignore
	/// uu_stat::pad_and_print(out, "1", false, 5, Padding::Zero) == "00001";
	/// ```
	/// currently only supports '0' & ' ' as the padding character
	/// because the format specification of print! does not support general
	/// fill characters.
	fn pad_and_print(out: &mut dyn Write, result: &str, left: bool, width: usize, padding: Padding) {
		let _ = match (left, padding) {
			(false, Padding::Zero) => write!(out, "{result:0>width$}"),
			(false, Padding::Space) => write!(out, "{result:>width$}"),
			(true, Padding::Zero) => write!(out, "{result:0<width$}"),
			(true, Padding::Space) => write!(out, "{result:<width$}"),
		};
	}

	/// Pads and prints raw bytes (Unix-specific) or falls back to string
	/// printing
	///
	/// On Unix systems, this preserves non-UTF8 data by printing raw bytes
	/// On other platforms, falls back to lossy string conversion
	#[cfg(unix)]
	fn pad_and_print_bytes<W: Write>(
		mut writer: W,
		bytes: &[u8],
		left: bool,
		width: usize,
		precision: Precision,
	) -> Result<(), std::io::Error> {
		let display_bytes = match precision {
			Precision::Number(p) if p < bytes.len() => &bytes[..p],
			_ => bytes,
		};

		let display_len = display_bytes.len();
		let padding_needed = width.saturating_sub(display_len);

		let (left_pad, right_pad) = if left {
			(0, padding_needed)
		} else {
			(padding_needed, 0)
		};

		if left_pad > 0 {
			write_padding(&mut writer, left_pad)?;
		}
		writer.write_all(display_bytes)?;
		if right_pad > 0 {
			write_padding(&mut writer, right_pad)?;
		}

		Ok(())
	}

	/// write padding based on a writer W and n size
	/// writer is genric to be any buffer like: `std::io::stdout`
	/// n is the calculated padding size
	#[cfg(unix)]
	fn write_padding<W: Write>(writer: &mut W, n: usize) -> Result<(), std::io::Error> {
		for _ in 0..n {
			writer.write_all(b" ")?;
		}
		Ok(())
	}

	#[derive(Debug)]
	pub enum OutputType<'a> {
		Str(String),
		#[cfg_attr(not(unix), allow(dead_code))]
		OsStr(&'a OsString),
		Integer(i64),
		Unsigned(u64),
		UnsignedHex(u64),
		UnsignedOct(u32),
		Timestamp { sec: i64, nsec: u32 },
		Unknown,
	}

	#[derive(Default)]
	enum QuotingStyle {
		Locale,
		Shell,
		#[default]
		ShellEscapeAlways,
		Quote,
	}

	impl std::str::FromStr for QuotingStyle {
		type Err = StatError;

		fn from_str(s: &str) -> Result<Self, Self::Err> {
			match s {
				"locale" => Ok(Self::Locale),
				"shell" => Ok(Self::Shell),
				"shell-escape-always" => Ok(Self::ShellEscapeAlways),
				// The others aren't exposed to the user
				_ => Err(StatError::InvalidQuotingStyle { style: s.to_string() }),
			}
		}
	}

	#[derive(Debug, PartialEq, Eq, Clone, Copy)]
	enum Precision {
		NotSpecified,
		NoNumber,
		Number(usize),
	}

	#[derive(Debug, PartialEq, Eq)]
	enum Token {
		Char(char),
		Byte(u8),
		Directive { flag: Flags, width: usize, precision: Precision, format: char },
	}

	trait ScanUtil {
		fn scan_num<F>(&self) -> Option<(F, usize)>
		where
			F: std::str::FromStr;
		fn scan_char(&self, radix: u32) -> Option<(char, usize)>;
	}

	impl ScanUtil for str {
		/// Scans for a number at the beginning of the string
		/// Returns the parsed number and the character count
		/// Since we only deal with ASCII characters (+, -, 0-9), character count
		/// equals byte count
		fn scan_num<F>(&self) -> Option<(F, usize)>
		where
			F: std::str::FromStr,
		{
			let mut chars = self.chars();
			let count = chars
				.next()
				.filter(|&c| c.is_ascii_digit() || c == '-' || c == '+')
				.map_or(0, |_| 1 + chars.take_while(char::is_ascii_digit).count());

			if count > 0 {
				F::from_str(&self[..count]).ok().map(|x| (x, count))
			} else {
				None
			}
		}

		fn scan_char(&self, radix: u32) -> Option<(char, usize)> {
			let count = match radix {
				8 => 3,
				16 => 2,
				_ => return None,
			};
			let chars = self.chars().enumerate();
			let mut res = 0;
			let mut offset = 0;
			for (i, c) in chars {
				if i >= count {
					break;
				}
				match c.to_digit(radix) {
					Some(digit) => {
						let tmp = res * radix + digit;
						if tmp < 256 {
							res = tmp;
						} else {
							break;
						}
					},
					None => break,
				}
				offset = i + 1;
			}
			if offset > 0 {
				Some((res as u8 as char, offset))
			} else {
				None
			}
		}
	}

	fn group_num(s: &str) -> Cow<'_, str> {
		let is_negative = s.starts_with('-');
		assert!(is_negative || s.chars().take(1).all(|c| c.is_ascii_digit()));
		assert!(s.chars().skip(1).all(|c| c.is_ascii_digit()));
		if s.len() < 4 {
			return s.into();
		}
		let mut res = String::with_capacity((s.len() - 1) / 3);
		let s = if is_negative {
			res.push('-');
			&s[1..]
		} else {
			s
		};
		let mut alone = (s.len() - 1) % 3 + 1;
		res.push_str(&s[..alone]);
		while alone != s.len() {
			res.push(',');
			res.push_str(&s[alone..alone + 3]);
			alone += 3;
		}
		res.into()
	}

	struct Stater {
		follow:             bool,
		show_fs:            bool,
		from_user:          bool,
		files:              Vec<OsString>,
		time_format:        Option<String>,
		#[cfg_attr(not(unix), allow(dead_code))]
		mount_list:         OnceCell<Option<Vec<OsString>>>,
		#[cfg_attr(not(unix), allow(dead_code))]
		mount_list_needed:  bool,
		default_tokens:     Vec<Token>,
		#[cfg_attr(not(unix), allow(dead_code))]
		default_dev_tokens: Vec<Token>,
	}

	/// Prints a formatted output based on the provided output type, flags,
	/// width, and precision.
	///
	/// # Arguments
	///
	/// * `output` - A reference to the [`OutputType`] enum containing the value
	///   to be printed.
	/// * `flags` - A Flags struct containing formatting flags.
	/// * `width` - The width of the field for the printed output.
	/// * `precision` - How many digits of precision, if any.
	///
	/// This function delegates the printing process to more specialized
	/// functions depending on the output type.
	fn print_it(
		out: &mut dyn Write,
		output: &OutputType,
		flags: Flags,
		width: usize,
		precision: Precision,
	) {
		// If the precision is given as just '.', the precision is taken to be zero.
		// A negative precision is taken as if the precision were omitted.
		// This gives the minimum number of digits to appear for d, i, o, u, x, and X
		// conversions, the maximum number of characters to be printed from a string
		// for s and S conversions.

		// #
		// The value should be converted to an "alternate form".
		// For o conversions, the first character of the output string  is made  zero
		// (by  prefixing  a 0 if it was not zero already). For x and X conversions, a
		// nonzero result has the string "0x" (or "0X" for X conversions) prepended to
		// it.

		// 0
		// The value should be zero padded.
		// For d, i, o, u, x, X, a, A, e, E, f, F, g, and G conversions, the converted
		// value is padded on the left with zeros rather than blanks. If the 0 and -
		// flags both appear, the 0 flag is ignored. If a precision  is  given with a
		// numeric conversion (d, i, o, u, x, and X), the 0 flag is ignored. For other
		// conversions, the behavior is undefined.

		// -
		// The converted value is to be left adjusted on the field boundary.  (The
		// default is right justification.) The  converted  value  is padded on the
		// right with blanks, rather than on the left with blanks or zeros.
		// A - overrides a 0 if both are given.

		// ' ' (a space)
		// A blank should be left before a positive number (or empty string) produced by
		// a signed conversion.

		// +
		// A sign (+ or -) should always be placed before a number produced by a signed
		// conversion. By default, a sign  is  used only for negative numbers.
		// A + overrides a space if both are used.
		let padding_char = determine_padding_char(flags);

		match output {
			OutputType::Str(s) => print_str(out, s, flags, width, precision),
			OutputType::OsStr(s) => print_os_str(out, s, flags, width, precision),
			OutputType::Integer(num) => print_integer(out, *num, flags, width, precision, padding_char),
			OutputType::Unsigned(num) => {
				print_unsigned(out, *num, flags, width, precision, padding_char);
			},
			OutputType::UnsignedOct(num) => {
				print_unsigned_oct(out, *num, flags, width, precision, padding_char);
			},
			OutputType::UnsignedHex(num) => {
				print_unsigned_hex(out, *num, flags, width, precision, padding_char);
			},
			OutputType::Timestamp { sec, nsec } => {
				print_timestamp(out, *sec, *nsec, flags, width, precision, padding_char);
			},
			OutputType::Unknown => {
				let _ = write!(out, "?");
			},
		}
	}

	/// Determines the padding character based on the provided flags and
	/// precision.
	///
	/// # Arguments
	///
	/// * `flags` - A reference to the Flags struct containing formatting flags.
	///
	/// # Returns
	///
	/// * Padding - An instance of the Padding enum representing the padding
	///   character.
	fn determine_padding_char(flags: Flags) -> Padding {
		if flags.zero && !flags.left {
			Padding::Zero
		} else {
			Padding::Space
		}
	}

	/// Prints a string value based on the provided flags, width, and precision.
	///
	/// # Arguments
	///
	/// * `s` - The string to be printed.
	/// * `flags` - A reference to the Flags struct containing formatting flags.
	/// * `width` - The width of the field for the printed string.
	/// * `precision` - How many digits of precision, if any.
	fn print_str(out: &mut dyn Write, s: &str, flags: Flags, width: usize, precision: Precision) {
		let s = match precision {
			Precision::Number(p) if p < s.len() => &s[..p],
			_ => s,
		};
		pad_and_print(out, s, flags.left, width, Padding::Space);
	}

	/// Prints a `OsString` value based on the provided flags, width, and
	/// precision. It converts the value to bytes and prints them; if that
	/// fails, it prints the lossy string version.
	///
	/// # Arguments
	///
	/// * `s` - The `OsString` to be printed.
	/// * `flags` - A reference to the Flags struct containing formatting flags.
	/// * `width` - The width of the field for the printed string.
	/// * `precision` - How many digits of precision, if any.
	fn print_os_str(
		out: &mut dyn Write,
		s: &OsString,
		flags: Flags,
		width: usize,
		precision: Precision,
	) {
		// (upstream behavior); the `OsStr` output type is only produced by the
		// `%m` mount-point directive, which is Unix-only. Elsewhere fall back to
		// a lossy string so the code compiles and behaves sensibly.
		#[cfg(unix)]
		{
			use std::os::unix::ffi::OsStrExt;

			let bytes = s.as_bytes();

			if pad_and_print_bytes(&mut *out, bytes, flags.left, width, precision)
				.is_err()
			{
				// if an error occurred while trying to print bytes fall back to normal lossy
				// string so it can be printed
				let fallback_string = s.to_string_lossy();
				print_str(out, &fallback_string, flags, width, precision);
			}
		}
		#[cfg(not(unix))]
		{
			print_str(out, &s.to_string_lossy(), flags, width, precision);
		}
	}

	fn quote_file_name(file_name: &str, quoting_style: &QuotingStyle) -> String {
		match quoting_style {
			QuotingStyle::Locale | QuotingStyle::Shell => {
				let escaped = file_name.replace('\'', r"\'");
				format!("'{escaped}'")
			},
			QuotingStyle::ShellEscapeAlways => {
				let quote = if file_name.contains('\'') { '"' } else { '\'' };
				format!("{quote}{file_name}{quote}")
			},
			QuotingStyle::Quote => file_name.to_string(),
		}
	}

	fn get_quoted_file_name(
		display_name: &str,
		// directory for the `readlink` syscall; `display_name` stays as typed.
		resolved: &Path,
		file_type: FileType,
		from_user: bool,
		host: &mut Host,
	) -> Result<String, i32> {
		let quoting_style = host.var("QUOTING_STYLE")
			.and_then(|style| style.parse().ok())
			.unwrap_or_default();

		if file_type.is_symlink() {
			let quoted_display_name = quote_file_name(display_name, &quoting_style);
			match fs::read_link(resolved) {
				Ok(dst) => {
					let quoted_dst = quote_file_name(&dst.to_string_lossy(), &quoting_style);
					Ok(format!("{quoted_display_name} -> {quoted_dst}"))
				},
				Err(e) => {
					host.error(e, 1);
					Err(1)
				},
			}
		} else {
			let style = if from_user {
				quoting_style
			} else {
				QuotingStyle::Quote
			};
			Ok(quote_file_name(display_name, &style))
		}
	}

	#[cfg(unix)]
	fn process_token_filesystem(
		out: &mut dyn Write,
		t: &Token,
		meta: &StatFs,
		display_name: &str,
	) {
		match *t {
			Token::Byte(byte) => write_raw_byte(out, byte),
			Token::Char(c) => {
				let _ = write!(out, "{c}");
			},
			Token::Directive { flag, width, precision, format } => {
				let output = match format {
					// free blocks available to non-superuser
					'a' => OutputType::Unsigned(meta.avail_blocks()),
					// total data blocks in file system
					'b' => OutputType::Unsigned(meta.total_blocks()),
					// total file nodes in file system
					'c' => OutputType::Unsigned(meta.total_file_nodes()),
					// free file nodes in file system
					'd' => OutputType::Unsigned(meta.free_file_nodes()),
					// free blocks in file system
					'f' => OutputType::Unsigned(meta.free_blocks()),
					// file system ID in hex
					'i' => OutputType::UnsignedHex(meta.fsid()),
					// maximum length of filenames
					'l' => OutputType::Unsigned(meta.namelen()),
					// file name
					'n' => OutputType::Str(display_name.to_string()),
					// block size (for faster transfers)
					's' => OutputType::Unsigned(meta.io_size()),
					// fundamental block size (for block counts)
					'S' => OutputType::Integer(meta.block_size()),
					// file system type in hex
					't' => OutputType::UnsignedHex(meta.fs_type() as u64),
					// file system type in human readable form
					'T' => OutputType::Str(pretty_fstype(meta.fs_type()).into()),
					_ => OutputType::Unknown,
				};

				print_it(out, &output, flag, width, precision);
			},
		}
	}

	/// Prints an integer value based on the provided flags, width, and
	/// precision.
	///
	/// # Arguments
	///
	/// * `num` - The integer value to be printed.
	/// * `flags` - A reference to the Flags struct containing formatting flags.
	/// * `width` - The width of the field for the printed integer.
	/// * `precision` - How many digits of precision, if any.
	/// * `padding_char` - The padding character as determined by
	///   `determine_padding_char`.
	fn print_integer(
		out: &mut dyn Write,
		num: i64,
		flags: Flags,
		width: usize,
		precision: Precision,
		padding_char: Padding,
	) {
		let num = num.to_string();
		let arg = if flags.group {
			group_num(&num)
		} else {
			Cow::Borrowed(num.as_str())
		};
		let prefix = if flags.sign {
			"+"
		} else if flags.space {
			" "
		} else {
			""
		};
		let extended = match precision {
			Precision::NotSpecified => format!("{prefix}{arg}"),
			Precision::NoNumber => format!("{prefix}{arg}"),
			Precision::Number(p) => format!("{prefix}{arg:0>p$}"),
		};
		pad_and_print(out, &extended, flags.left, width, padding_char);
	}

	/// Formats an epoch timestamp with GNU `stat`'s truncation rules: no
	/// precision prints whole seconds (so `stat -c %Y` survives shell
	/// arithmetic), a bare `.` prints all nine fractional digits, and an
	/// explicit precision truncates or zero-pads the fraction.
	fn timestamp_string(sec: i64, nsec: u32, precision: Precision) -> String {
		match precision {
			Precision::NotSpecified | Precision::Number(0) => sec.to_string(),
			Precision::NoNumber => format!("{sec}.{nsec:09}"),
			Precision::Number(p) if p <= 9 => {
				let frac = format!("{nsec:09}");
				format!("{sec}.{}", &frac[..p])
			},
			Precision::Number(p) => format!("{sec}.{nsec:09}{:0<pad$}", "", pad = p - 9),
		}
	}

	fn print_timestamp(
		out: &mut dyn Write,
		sec: i64,
		nsec: u32,
		flags: Flags,
		width: usize,
		precision: Precision,
		padding_char: Padding,
	) {
		let prefix = if flags.sign {
			"+"
		} else if flags.space {
			" "
		} else {
			""
		};
		let extended = format!("{prefix}{}", timestamp_string(sec, nsec, precision));
		pad_and_print(out, &extended, flags.left, width, padding_char);
	}

	/// Prints an unsigned integer value based on the provided flags, width, and
	/// precision.
	///
	/// # Arguments
	///
	/// * `num` - The unsigned integer value to be printed.
	/// * `flags` - A reference to the Flags struct containing formatting flags.
	/// * `width` - The width of the field for the printed unsigned integer.
	/// * `precision` - How many digits of precision, if any.
	/// * `padding_char` - The padding character as determined by
	///   `determine_padding_char`.
	fn print_unsigned(
		out: &mut dyn Write,
		num: u64,
		flags: Flags,
		width: usize,
		precision: Precision,
		padding_char: Padding,
	) {
		let num = num.to_string();
		let s = if flags.group {
			group_num(&num)
		} else {
			Cow::Borrowed(num.as_str())
		};
		let s = match precision {
			Precision::NotSpecified => s,
			Precision::NoNumber => s,
			Precision::Number(p) => format!("{s:0>p$}").into(),
		};
		pad_and_print(out, &s, flags.left, width, padding_char);
	}

	/// Prints an unsigned octal integer value based on the provided flags,
	/// width, and precision.
	///
	/// # Arguments
	///
	/// * `num` - The unsigned octal integer value to be printed.
	/// * `flags` - A reference to the Flags struct containing formatting flags.
	/// * `width` - The width of the field for the printed unsigned octal
	///   integer.
	/// * `precision` - How many digits of precision, if any.
	/// * `padding_char` - The padding character as determined by
	///   `determine_padding_char`.
	fn print_unsigned_oct(
		out: &mut dyn Write,
		num: u32,
		flags: Flags,
		width: usize,
		precision: Precision,
		padding_char: Padding,
	) {
		let prefix = if flags.alter { "0" } else { "" };
		let s = match precision {
			Precision::NotSpecified => format!("{prefix}{num:o}"),
			Precision::NoNumber => format!("{prefix}{num:o}"),
			Precision::Number(p) => format!("{prefix}{num:0>p$o}"),
		};
		pad_and_print(out, &s, flags.left, width, padding_char);
	}

	/// Prints an unsigned hexadecimal integer value based on the provided flags,
	/// width, and precision.
	///
	/// # Arguments
	///
	/// * `num` - The unsigned hexadecimal integer value to be printed.
	/// * `flags` - A reference to the Flags struct containing formatting flags.
	/// * `width` - The width of the field for the printed unsigned hexadecimal
	///   integer.
	/// * `precision` - How many digits of precision, if any.
	/// * `padding_char` - The padding character as determined by
	///   `determine_padding_char`.
	fn print_unsigned_hex(
		out: &mut dyn Write,
		num: u64,
		flags: Flags,
		width: usize,
		precision: Precision,
		padding_char: Padding,
	) {
		let prefix = if flags.alter { "0x" } else { "" };
		let s = match precision {
			Precision::NotSpecified => format!("{prefix}{num:x}"),
			Precision::NoNumber => format!("{prefix}{num:x}"),
			Precision::Number(p) => format!("{prefix}{num:0>p$x}"),
		};
		pad_and_print(out, &s, flags.left, width, padding_char);
	}

	fn write_raw_byte(out: &mut dyn Write, byte: u8) {
		let _ = out.write_all(&[byte]);
	}

	impl Stater {
		fn process_flags(chars: &[char], i: &mut usize, bound: usize, flag: &mut Flags) {
			while *i < bound {
				match chars[*i] {
					'#' => flag.alter = true,
					'0' => flag.zero = true,
					'-' => flag.left = true,
					' ' => flag.space = true,
					// This is not documented but the behavior seems to be
					// the same as a space. For example `stat -c "%I5s" f`
					// prints "    0".
					'I' => flag.space = true,
					'+' => flag.sign = true,
					'\'' => flag.group = true,
					_ => break,
				}
				*i += 1;
			}
		}

		/// Converts a character index to a byte index in a UTF-8 string
		/// This is necessary because Rust strings are UTF-8 encoded, so character
		/// positions don't always align with byte positions for multi-byte
		/// characters
		fn char_index_to_byte_index(format_str: &str, char_index: usize) -> usize {
			format_str
				.char_indices()
				.nth(char_index)
				.map_or(format_str.len(), |(byte_idx, _)| byte_idx)
		}

		fn handle_percent_case(
			chars: &[char],
			i: &mut usize,
			bound: usize,
			format_str: &str,
		) -> Result<Token, StatError> {
			let old = *i;

			*i += 1;
			if *i >= bound {
				return Ok(Token::Char('%'));
			}
			if chars[*i] == '%' {
				return Ok(Token::Char('%'));
			}

			let mut flag = Flags::default();

			Self::process_flags(chars, i, bound, &mut flag);

			let mut width = 0;
			let mut precision = Precision::NotSpecified;
			let mut j = *i;

			let j_byte = Self::char_index_to_byte_index(format_str, j);
			if let Some((field_width, offset)) = format_str[j_byte..].scan_num::<usize>() {
				width = field_width;
				j += offset;

				// Reject directives like `%<NUMBER>` by checking if width has been parsed.
				if j >= bound || chars[j] == '%' {
					let invalid_directive: String = chars[old..=j.min(bound - 1)].iter().collect();
					return Err(StatError::InvalidDirective {
						directive: invalid_directive.quote().to_string(),
					});
				}
			}
			check_bound(format_str, bound, old, j)?;

			if chars[j] == '.' {
				j += 1;
				check_bound(format_str, bound, old, j)?;

				let j_byte = Self::char_index_to_byte_index(format_str, j);
				match format_str[j_byte..].scan_num::<i32>() {
					Some((value, offset)) => {
						if value >= 0 {
							precision = Precision::Number(value as usize);
						}
						j += offset;
					},
					None => precision = Precision::NoNumber,
				}
				check_bound(format_str, bound, old, j)?;
			}

			*i = j;

			// Check for multi-character specifiers (e.g., `%Hd`, `%Lr`)
			if *i + 1 < bound
				&& let Some(&next_char) = chars.get(*i + 1)
				&& (chars[*i] == 'H' || chars[*i] == 'L')
				&& (next_char == 'd' || next_char == 'r')
			{
				flag.major = chars[*i] == 'H';
				flag.minor = chars[*i] == 'L';
				*i += 1;
				return Ok(Token::Directive { flag, width, precision, format: next_char });
			}

			Ok(Token::Directive { flag, width, precision, format: chars[*i] })
		}

		fn handle_escape_sequences(
			chars: &[char],
			i: &mut usize,
			bound: usize,
			format_str: &str,
			err: &mut dyn Write,
		) -> Token {
			*i += 1;
			if *i >= bound {
				// write; message literalized from locales/en-US.ftl.
				let _ = writeln!(err, "stat: warning: backslash at end of format");
				return Token::Char('\\');
			}
			match chars[*i] {
				'a' => Token::Byte(0x07),   // BEL
				'b' => Token::Byte(0x08),   // Backspace
				'f' => Token::Byte(0x0c),   // Form feed
				'n' => Token::Byte(0x0a),   // Line feed
				'r' => Token::Byte(0x0d),   // Carriage return
				't' => Token::Byte(0x09),   // Horizontal tab
				'\\' => Token::Byte(b'\\'), // Backslash
				'\'' => Token::Byte(b'\''), // Single quote
				'"' => Token::Byte(b'"'),   // Double quote
				'0'..='7' => {
					// Parse octal escape sequence (up to 3 digits)
					let mut value = 0u8;
					let mut count = 0;
					while *i < bound && count < 3 {
						if let Some(digit) = chars[*i].to_digit(8) {
							value = value * 8 + digit as u8;
							*i += 1;
							count += 1;
						} else {
							break;
						}
					}
					*i -= 1; // Adjust index to account for the outer loop increment
					Token::Byte(value)
				},
				'x' => {
					// Parse hexadecimal escape sequence (\xNN format)
					// Uses UTF-8 safe byte indexing to handle multi-byte characters properly
					if *i + 1 < bound {
						let byte_index = Self::char_index_to_byte_index(format_str, *i + 1);
						if let Some((c, offset)) = format_str[byte_index..].scan_char(16) {
							*i += offset;
							Token::Byte(c as u8)
						} else {
							// context-stderr write.
							let _ = writeln!(
								err,
								"stat: warning: unrecognized escape '\\x'"
							);
							Token::Byte(b'x')
						}
					} else {
						// context-stderr write.
						let _ = writeln!(
							err,
							"stat: warning: incomplete hex escape '\\x'"
						);
						Token::Byte(b'x')
					}
				},
				other => {
					// write.
					let _ = writeln!(
						err,
						"stat: warning: unrecognized escape '\\{other}'"
					);
					Token::Byte(other as u8)
				},
			}
		}

		fn generate_tokens(
			format_str: &str,
			use_printf: bool,
			err: &mut dyn Write,
		) -> Result<Vec<Token>, StatError> {
			let mut tokens = Vec::new();
			let chars = format_str.chars().collect::<Vec<char>>();
			let bound = chars.len();
			let mut i = 0;
			while i < bound {
				match chars.get(i) {
					Some('%') => {
						tokens.push(Self::handle_percent_case(&chars, &mut i, bound, format_str)?);
					},
					Some('\\') => {
						if use_printf {
							tokens.push(Self::handle_escape_sequences(&chars, &mut i, bound, format_str, err));
						} else {
							tokens.push(Token::Char('\\'));
						}
					},
					Some(c) => tokens.push(Token::Char(*c)),
					None => break,
				}
				i += 1;
			}
			if !use_printf && !format_str.ends_with('\n') {
				tokens.push(Token::Char('\n'));
			}
			Ok(tokens)
		}

		#[cfg(unix)]
		fn populate_mount_list() -> Result<Vec<OsString>, StatError> {
			let mut mount_list = read_fs_list()
				.map_err(|e| StatError::CannotReadFilesystem { error: e.to_string() })?
				.iter()
				.map(|mi| mi.mount_dir.clone())
				.collect::<Vec<_>>();

			// Reverse sort. The longer comes first.
			mount_list.sort();
			mount_list.reverse();

			Ok(mount_list)
		}

		fn new(matches: &ArgMatches, host: &mut Host) -> Result<Self, StatError> {
			let files: Vec<OsString> = matches
				.get_many::<OsString>(options::FILES)
				.map(|v| v.map(OsString::from).collect())
				.unwrap_or_default();
			if files.is_empty() {
				return Err(StatError::MissingOperand);
			}
			let format_str = if matches.contains_id(options::PRINTF) {
				matches
					.get_one::<String>(options::PRINTF)
					.expect("Invalid format string")
			} else {
				matches
					.get_one::<String>(options::FORMAT)
					.map_or("", |s| s.as_str())
			};

			let use_printf = matches.contains_id(options::PRINTF);
			let terse = matches.get_flag(options::TERSE);
			let show_fs = matches.get_flag(options::FILE_SYSTEM);

			let default_tokens = if format_str.is_empty() {
				Self::generate_tokens(
					&Self::default_format(show_fs, terse, false),
					use_printf,
					&mut host.stderr,
				)?
			} else {
				Self::generate_tokens(format_str, use_printf, &mut host.stderr)?
			};
			let default_dev_tokens =
				Self::generate_tokens(
					&Self::default_format(show_fs, terse, true),
					use_printf,
					&mut host.stderr,
				)?;

			// mount points aren't displayed when showing filesystem information, or
			// whenever the format string does not request the mount point.
			let mount_list_needed = !show_fs
				&& default_tokens
					.iter()
					.any(|tok| matches!(tok, Token::Directive { format: 'm', .. }));

			Ok(Self {
				follow: matches.get_flag(options::DEREFERENCE),
				show_fs,
				from_user: !format_str.is_empty(),
				files,
				time_format: matches.get_one::<String>(options::BSD_TIMEFMT).cloned(),
				mount_list: OnceCell::new(),
				mount_list_needed,
				default_tokens,
				default_dev_tokens,
			})
		}

		/// The `strftime` format for human-readable time directives; BSD `-t`
		/// overrides the GNU default.
		fn time_fmt(&self) -> &str {
			self.time_format.as_deref().unwrap_or(PRETTY_DATETIME_FORMAT)
		}

		#[cfg(unix)]
		fn find_mount_point<P: AsRef<Path>>(
			&self,
			p: P,
			host: &mut Host,
		) -> Option<&OsString> {
			if !self.mount_list_needed {
				return None;
			}

			let mount_list = self.mount_list.get_or_init(|| {
				match Self::populate_mount_list() {
					Ok(list) => Some(list),
					Err(e) => {
						// Show warning like GNU does when mount information cannot be read
						// context-stderr write.
						let _ = writeln!(
							&mut host.stderr,
							"stat: warning: cannot read table of mounted file systems: {e}"
						);
						None
					},
				}
			});

			let path = p.as_ref().canonicalize().ok()?;
			mount_list
				.as_ref()?
				.iter()
				.find(|root| path.starts_with(root))
		}

		#[cfg(unix)]
		fn exec(&self, host: &mut Host) -> i32 {
			let mut stdin_is_fifo = false;
			if let Ok(md) = fs::metadata("/dev/stdin") {
				stdin_is_fifo = md.file_type().is_fifo();
			}

			let mut ret = 0;
			for f in &self.files {
				ret |= self.do_stat(f, stdin_is_fifo, host);
			}
			ret
		}

		#[cfg(unix)]
		fn process_token_files(
			&self,
			t: &Token,
			meta: &Metadata,
			display_name: &str,
			// directory for the `%m`/`%N` syscalls (upstream passed the raw
			// operand); display output keeps `display_name` as typed. The
			// SELinux `follow_symbolic_links` parameter is dropped along with
			// SELinux support.
			resolved: &Path,
			file_type: FileType,
			from_user: bool,
			host: &mut Host,
		) -> Result<(), i32> {
			match *t {
				Token::Byte(byte) => write_raw_byte(&mut host.stdout, byte),
				Token::Char(c) => {
					let _ = write!(host.stdout, "{c}");
				},

				Token::Directive { flag, width, precision, format } => {
					let output = match format {
						// access rights in octal
						'a' => OutputType::UnsignedOct(0o7777 & meta.mode()),
						// access rights in human readable form
						'A' => OutputType::Str(display_permissions(meta, true)),
						// number of blocks allocated (see %B)
						'b' => OutputType::Unsigned(meta.blocks()),

						// the size in bytes of each block reported by %b
						// FIXME: blocksize differs on various platform
						// See coreutils/gnulib/lib/stat-size.h ST_NBLOCKSIZE //
						'B' => OutputType::Unsigned(512),
						// SELinux security context string
						// upstream's non-SELinux fallback string.
						'C' => OutputType::Str("unsupported for this operating system".to_string()),
						// device number in decimal
						'd' if flag.major => OutputType::Unsigned(major(meta.dev() as _) as u64),
						'd' if flag.minor => OutputType::Unsigned(minor(meta.dev() as _) as u64),
						'd' => OutputType::Unsigned(meta.dev()),
						// device number in hex
						'D' => OutputType::UnsignedHex(meta.dev()),
						// raw mode in hex
						'f' => OutputType::UnsignedHex(meta.mode() as u64),
						// file type
						'F' => OutputType::Str(pretty_filetype(meta.mode() as mode_t, meta.len())),
						// group ID of owner
						'g' => OutputType::Unsigned(meta.gid() as u64),
						// group name of owner
						'G' => {
							let group_name =
								entries::gid2grp(meta.gid()).unwrap_or_else(|_| "UNKNOWN".to_owned());
							OutputType::Str(group_name)
						},
						// number of hard links
						'h' => OutputType::Unsigned(meta.nlink()),
						// inode number
						'i' => OutputType::Unsigned(meta.ino()),
						// mount point
						'm' => match self.find_mount_point(resolved, host) {
							Some(s) => OutputType::OsStr(s),
							None => OutputType::Str(String::new()),
						},
						// file name
						'n' => OutputType::Str(display_name.to_string()),
						// quoted file name with dereference if symbolic link
						'N' => {
							let file_name =
								get_quoted_file_name(display_name, resolved, file_type, from_user, host)?;
							OutputType::Str(file_name)
						},
						// optimal I/O transfer size hint
						'o' => OutputType::Unsigned(meta.blksize()),
						// total size, in bytes
						's' => OutputType::Integer(meta.len() as i64),
						// major device type in hex, for character/block device special
						// files
						't' => OutputType::UnsignedHex(major(meta.rdev() as _) as u64),
						// minor device type in hex, for character/block device special
						// files
						'T' => OutputType::UnsignedHex(minor(meta.rdev() as _) as u64),
						// user ID of owner
						'u' => OutputType::Unsigned(meta.uid() as u64),
						// user name of owner
						'U' => {
							let user_name =
								entries::uid2usr(meta.uid()).unwrap_or_else(|_| "UNKNOWN".to_owned());
							OutputType::Str(user_name)
						},

						// time of file birth, human-readable; - if unknown
						'w' => OutputType::Str(pretty_time(meta, MetadataTimeField::Birth, self.time_fmt())),
						// time of file birth, seconds since Epoch; 0 if unknown
						'W' => {
							let (sec, nsec) = metadata_get_time(meta, MetadataTimeField::Birth)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},
						// time of last access, human-readable
						'x' => OutputType::Str(pretty_time(meta, MetadataTimeField::Access, self.time_fmt())),
						// time of last access, seconds since Epoch
						'X' => {
							let (sec, nsec) = metadata_get_time(meta, MetadataTimeField::Access)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},
						// time of last data modification, human-readable
						'y' => OutputType::Str(pretty_time(meta, MetadataTimeField::Modification, self.time_fmt())),
						// time of last data modification, seconds since Epoch
						'Y' => {
							let (sec, nsec) = metadata_get_time(meta, MetadataTimeField::Modification)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},
						// time of last status change, human-readable
						'z' => OutputType::Str(pretty_time(meta, MetadataTimeField::Change, self.time_fmt())),
						// time of last status change, seconds since Epoch
						'Z' => {
							let (sec, nsec) = metadata_get_time(meta, MetadataTimeField::Change)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},
						'R' => OutputType::UnsignedHex(meta.rdev()),
						'r' if flag.major => OutputType::Unsigned(major(meta.rdev() as _) as u64),
						'r' if flag.minor => OutputType::Unsigned(minor(meta.rdev() as _) as u64),
						'r' => OutputType::Unsigned(meta.rdev()),
						_ => OutputType::Unknown,
					};
					print_it(&mut host.stdout, &output, flag, width, precision);
				},
			}
			Ok(())
		}

		#[cfg(unix)]
		fn do_stat(&self, file: &OsStr, stdin_is_fifo: bool, host: &mut Host) -> i32 {
			let display_name = file.to_string_lossy();
			let file = if display_name == "-" {
				if self.show_fs {
					// write.
					let _ =
						writeln!(&mut host.stderr, "stat: {}", StatError::StdinFilesystemMode);
					return 1;
				}
				if let Ok(p) = Path::new("/dev/stdin").canonicalize() {
					p.into_os_string()
				} else {
					OsString::from("/dev/stdin")
				}
			} else {
				OsString::from(file)
			};
			// directory for every syscall below; `display_name` keeps the
			// operand as typed for `%n` and error messages.
			let resolved = host.resolve(&file);
			if self.show_fs {
				match statfs(resolved.as_os_str()) {
					Ok(meta) => {
						let tokens = &self.default_tokens;

						// Usage
						for t in tokens {
							process_token_filesystem(&mut host.stdout, t, &meta, &display_name);
						}
					},
					Err(error) => {
						// context-stderr write.
						let _ = writeln!(
							&mut host.stderr,
							"stat: {}",
							StatError::CannotReadFilesystemInfo {
								file: display_name.quote().to_string(),
								error,
							}
						);
						return 1;
					},
				}
			} else {
				let follow_symbolic_links = self.follow || stdin_is_fifo && display_name == "-";
				let result = if follow_symbolic_links {
					fs::metadata(&resolved)
				} else {
					fs::symlink_metadata(&resolved)
				};
				match result {
					Ok(meta) => {
						let file_type = meta.file_type();
						let tokens = if self.from_user
							|| !(file_type.is_char_device() || file_type.is_block_device())
						{
							&self.default_tokens
						} else {
							&self.default_dev_tokens
						};

						for t in tokens {
							if let Err(code) = self.process_token_files(
								t,
								&meta,
								&display_name,
								&resolved,
								file_type,
								self.from_user,
								host,
							) {
								return code;
							}
						}
					},
					Err(e) => {
						// context-stderr write.
						let _ = writeln!(&mut host.stderr, "stat: {}", StatError::CannotStat {
							file:  display_name.quote().to_string(),
							error: e.to_string(),
						});
						return 1;
					},
				}
			}
			0
		}

		fn default_format(show_fs: bool, terse: bool, show_dev_type: bool) -> String {
			// SELinux related format is *ignored*
			// locales/en-US.ftl.

			if show_fs {
				if terse {
					"%n %i %l %t %s %S %b %f %a %c %d\n".into()
				} else {
					"  File: \"%n\"\n    ID: %-8i Namelen: %-7l Type: %T\nBlock size: %-10s Fundamental \
					 block size: %S\nBlocks: Total: %-10b Free: %-10f Available: %a\nInodes: Total: \
					 %-10c Free: %d\n"
						.into()
				}
			} else if terse {
				"%n %s %b %f %u %g %D %i %h %t %T %X %Y %Z %W %o\n".into()
			} else {
				let device_line = if show_dev_type {
					"Device: %Hd,%Ld\tInode: %-10i  Links: %-5h Device type: %t,%T\n"
				} else {
					"Device: %Hd,%Ld\tInode: %-10i  Links: %h\n"
				};

				format!(
					"  File: %N\n  size: %-10s\tBlocks: %-10b IO Block: %-6o %F\n{device_line}Access: \
					 (%04a/%10.10A)  Uid: (%5u/%8U)   Gid: (%5g/%8G)\nAccess: %x\nModify: %y\nChange: \
					 %z\n Birth: %w\n"
				)
			}
		}
	}

	///
	/// BSD stat's `-f` takes a format string (`stat -f "%Sm %N" file`), while
	/// GNU's `-f` is `--file-system`; parsed as GNU, a BSD invocation prints
	/// filesystem info for each real operand and errors on the format operand.
	/// An invocation is treated as BSD when a `-f` cluster (optionally with the
	/// BSD boolean flags `L`/`n`/`q`/`F`/`s`/`x`) carries a format value
	/// containing `%` — GNU filesystem mode would have to target a file
	/// literally named like a format string, which never happens in practice —
	/// or when a cluster of BSD boolean flags contains the BSD-only output
	/// styles `-s` (shell assignments) or `-x` (Linux-like verbose). Detected
	/// invocations are rewritten to the GNU equivalent (`-c`/`--printf` plus a
	/// translated format, or hidden style/timefmt options) before clap parsing.
	///
	/// Returns `None` when the invocation is not BSD-shaped, `Some(Err(_))`
	/// when it is BSD-shaped but uses an option or directive with no GNU
	/// counterpart.
	fn rewrite_bsd_invocation(argv: &[OsString]) -> Option<Result<Vec<OsString>, String>> {
		let toks: Vec<Cow<'_, str>> = argv.iter().map(|a| a.to_string_lossy()).collect();
		let mut detected = false;
		for (idx, tok) in toks.iter().enumerate().skip(1) {
			if tok.as_ref() == "--" {
				break;
			}
			let Some(cluster) = tok.strip_prefix('-') else {
				continue;
			};
			if cluster.is_empty() || cluster.starts_with('-') {
				continue;
			}
			// `-s` / `-x` are BSD-only output styles: a cluster of BSD boolean
			// flags containing one marks the invocation (GNU stat has neither).
			if cluster
				.chars()
				.all(|c| matches!(c, 'L' | 'n' | 'q' | 'F' | 's' | 'x'))
				&& cluster.chars().any(|c| matches!(c, 's' | 'x'))
			{
				detected = true;
				break;
			}
			let Some(fpos) = cluster.find('f') else {
				continue;
			};
			if !cluster[..fpos]
				.chars()
				.all(|c| matches!(c, 'L' | 'n' | 'q' | 'F' | 's' | 'x'))
			{
				continue;
			}
			let attached = &cluster[fpos + 1..];
			let format = if attached.is_empty() {
				toks.get(idx + 1).map(Cow::as_ref)
			} else {
				Some(attached)
			};
			if format.is_some_and(|f| f.contains('%')) {
				detected = true;
				break;
			}
		}
		if !detected {
			return None;
		}
		Some(bsd_to_gnu_argv(argv, &toks))
	}

	/// Output style selected by a BSD invocation.
	enum BsdStyle {
		/// `-f <fmt>`: caller-supplied BSD format string.
		Custom(String),
		/// `-s`: eval-able `st_dev=… st_ino=…` shell assignments.
		Shell,
		/// `-x`: Linux-like verbose block.
		Verbose,
	}

	/// Parses a detected BSD invocation and produces the equivalent GNU argv.
	fn bsd_to_gnu_argv(argv: &[OsString], toks: &[Cow<'_, str>]) -> Result<Vec<OsString>, String> {
		let mut follow = false;
		let mut no_newline = false;
		let mut style: Option<BsdStyle> = None;
		let mut timefmt: Option<String> = None;
		let mut files: Vec<OsString> = Vec::new();

		let mut i = 1;
		while i < toks.len() {
			if toks[i].as_ref() == "--" {
				files.extend_from_slice(&argv[i + 1..]);
				break;
			}
			let cluster: Vec<char> = match toks[i].strip_prefix('-') {
				Some(c) if !c.is_empty() && !c.starts_with('-') => c.chars().collect(),
				// Operands keep the original (possibly non-UTF8) bytes.
				_ => {
					files.push(argv[i].clone());
					i += 1;
					continue;
				},
			};
			let mut consumed_next = false;
			let mut k = 0;
			while k < cluster.len() {
				match cluster[k] {
					'L' => follow = true,
					'n' => no_newline = true,
					// `-q` (suppress error messages) and `-F` (ls -F type
					// decorations) have no GNU counterpart worth emulating.
					'q' | 'F' => {},
					// Output styles; like BSD, the last one seen wins.
					's' => style = Some(BsdStyle::Shell),
					'x' => style = Some(BsdStyle::Verbose),
					c @ ('f' | 't') => {
						// The rest of the cluster is the attached value,
						// otherwise the next token is.
						let value: String = if k + 1 < cluster.len() {
							cluster[k + 1..].iter().collect()
						} else {
							consumed_next = true;
							match toks.get(i + 1) {
								Some(v) => v.to_string(),
								None => return Err(format!("option '-{c}' requires an argument")),
							}
						};
						if c == 'f' {
							style = Some(BsdStyle::Custom(value));
						} else {
							timefmt = Some(value);
						}
						break;
					},
					other => {
						return Err(format!(
							"option '-{other}' is not supported (BSD stat compatibility)"
						));
					},
				}
				k += 1;
			}
			i += 1 + usize::from(consumed_next);
		}

		let mut out: Vec<OsString> = Vec::with_capacity(files.len() + 7);
		out.push(argv[0].clone());
		if follow {
			out.push("-L".into());
		}
		match style {
			// `-s` renders directly from the metadata (the full octal
			// `st_mode` and `st_flags` have no GNU format directive); its
			// timestamps are epoch integers regardless of `-t`, as on BSD.
			Some(BsdStyle::Shell) => out.push("--bsd-shell".into()),
			Some(BsdStyle::Verbose) => {
				out.push("--bsd-timefmt".into());
				out.push(timefmt.unwrap_or_else(|| BSD_VERBOSE_TIMEFMT.into()).into());
				out.push(if no_newline { "--printf".into() } else { "-c".into() });
				out.push(BSD_VERBOSE_FORMAT.into());
			},
			Some(BsdStyle::Custom(format)) => {
				let translated = translate_bsd_format(&format, no_newline)?;
				if let Some(timefmt) = timefmt {
					out.push("--bsd-timefmt".into());
					out.push(timefmt.into());
				}
				// `--printf` suppresses the mandatory trailing newline (BSD
				// `-n`); the translator escapes literal backslashes so text
				// survives printf mode.
				out.push(if no_newline { "--printf".into() } else { "-c".into() });
				out.push(translated.into());
			},
			None => return Err("BSD-style '-f' expects a format string".to_string()),
		}
		out.push("--".into());
		out.extend(files);
		Ok(out)
	}

	/// Translates a BSD stat format string into the GNU format language used by
	/// this implementation. Directives with no GNU counterpart (`%f` user
	/// flags, `%v` inode generation, `%Y` symlink target, ...) are rejected.
	/// With `printf_mode` set, literal backslashes are escaped so the result
	/// survives `--printf` escape processing unchanged.
	fn translate_bsd_format(fmt: &str, printf_mode: bool) -> Result<String, String> {
		let chars: Vec<char> = fmt.chars().collect();
		let mut out = String::with_capacity(fmt.len() + 8);
		let mut i = 0;
		while i < chars.len() {
			if chars[i] != '%' {
				if printf_mode && chars[i] == '\\' {
					out.push_str(r"\\");
				} else {
					out.push(chars[i]);
				}
				i += 1;
				continue;
			}
			let start = i;
			i += 1;
			if i >= chars.len() {
				out.push('%');
				break;
			}
			if chars[i] == '%' {
				out.push_str("%%");
				i += 1;
				continue;
			}
			// Flags, width, and precision use the same syntax in both format
			// languages; copy them through verbatim.
			let mut spec = String::new();
			while i < chars.len() && matches!(chars[i], '#' | '+' | '-' | '0' | ' ') {
				spec.push(chars[i]);
				i += 1;
			}
			while i < chars.len() && chars[i].is_ascii_digit() {
				spec.push(chars[i]);
				i += 1;
			}
			if i < chars.len() && chars[i] == '.' {
				spec.push('.');
				i += 1;
				while i < chars.len() && chars[i].is_ascii_digit() {
					spec.push(chars[i]);
					i += 1;
				}
			}
			// BSD grammar: %[flags][width][.prec][fmt][sub]datum, with
			// fmt ∈ {D,O,U,X,F,S} (output representation) and sub ∈ {H,M,L}
			// (datum sub-field). Only `S` ("string form") changes the GNU
			// mapping; the numeric representations keep GNU's defaults.
			let mut string_form = false;
			if i < chars.len() && matches!(chars[i], 'D' | 'O' | 'U' | 'X' | 'F' | 'S') {
				string_form = chars[i] == 'S';
				i += 1;
			}
			let mut sub = None;
			if i < chars.len() && matches!(chars[i], 'H' | 'M' | 'L') {
				sub = Some(chars[i]);
				i += 1;
			}
			let Some(&datum) = chars.get(i) else {
				return Err(unsupported_bsd_directive(&chars[start..]));
			};
			i += 1;
			let gnu: &str = match datum {
				// Times: mtime / atime / ctime / birth; `S` selects the
				// human-readable form, otherwise seconds since Epoch.
				'm' => {
					if string_form {
						"y"
					} else {
						"Y"
					}
				},
				'a' => {
					if string_form {
						"x"
					} else {
						"X"
					}
				},
				'c' => {
					if string_form {
						"z"
					} else {
						"Z"
					}
				},
				'B' => {
					if string_form {
						"w"
					} else {
						"W"
					}
				},
				// File name as typed.
				'N' => "n",
				// Size in bytes.
				'z' => "s",
				// Owner / group: numeric, or (`S`) by name.
				'u' => {
					if string_form {
						"U"
					} else {
						"u"
					}
				},
				'g' => {
					if string_form {
						"G"
					} else {
						"g"
					}
				},
				// Permissions: octal bits, or (`S`) the human-readable form.
				'p' if string_form => "A",
				'p' if matches!(sub, None | Some('L')) => "a",
				// Inode, hard links, device, rdev, blocks, block size.
				'i' => "i",
				'l' => "h",
				'd' => match sub {
					Some('H') => "Hd",
					Some('L') => "Ld",
					None => "d",
					Some(_) => return Err(unsupported_bsd_directive(&chars[start..i])),
				},
				'r' => match sub {
					Some('H') => "Hr",
					Some('L') => "Lr",
					None => "r",
					Some(_) => return Err(unsupported_bsd_directive(&chars[start..i])),
				},
				'b' => "b",
				'k' => "o",
				// File type, human readable (`%HT` / `%T`).
				'T' => "F",
				// `%n` and `%t` are literal newline / tab in BSD formats.
				'n' => {
					out.push('\n');
					continue;
				},
				't' => {
					out.push('\t');
					continue;
				},
				_ => return Err(unsupported_bsd_directive(&chars[start..i])),
			};
			out.push('%');
			out.push_str(&spec);
			out.push_str(gnu);
		}
		Ok(out)
	}

	fn unsupported_bsd_directive(directive: &[char]) -> String {
		let directive: String = directive.iter().collect();
		format!("unsupported BSD format directive '{directive}'")
	}

	/// GNU-language rendering of BSD `stat -x` ("Linux-like" verbose output).
	const BSD_VERBOSE_FORMAT: &str = concat!(
		"  File: \"%n\"\n",
		"  Size: %-11s  FileType: %F\n",
		"  Mode: (%04a/%.10A)         Uid: (%5u/%8U)  Gid: (%5g/%8G)\n",
		"Device: %Hd,%Ld   Inode: %i    Links: %h\n",
		"Access: %x\n",
		"Modify: %y\n",
		"Change: %z\n",
		" Birth: %w",
	);

	/// BSD `stat -x` renders timestamps `ctime(3)`-style.
	const BSD_VERBOSE_TIMEFMT: &str = "%a %b %e %H:%M:%S %Y";

	/// BSD `stat -s`: one eval-able line of `st_*=value` shell assignments per
	/// file, rendered directly from the metadata.
	fn bsd_shell_exec(matches: &ArgMatches, host: &mut Host) -> i32 {
		let files: Vec<OsString> = matches
			.get_many::<OsString>(options::FILES)
			.map(|v| v.cloned().collect())
			.unwrap_or_default();
		if files.is_empty() {
			host.error(StatError::MissingOperand, 1);
			return 1;
		}
		let follow = matches.get_flag(options::DEREFERENCE);
		let mut ret = 0;
		for file in &files {
			let display_name = file.to_string_lossy();
			let resolved = host.resolve(file);
			let result = if follow {
				fs::metadata(&resolved)
			} else {
				fs::symlink_metadata(&resolved)
			};
			match result {
				Ok(meta) => {
					let _ = writeln!(host.stdout, "{}", bsd_shell_line(&meta, &resolved));
				},
				Err(e) => {
					let _ = writeln!(&mut host.stderr, "stat: {}", StatError::CannotStat {
						file:  display_name.quote().to_string(),
						error: e.to_string(),
					});
					ret = 1;
				},
			}
		}
		ret
	}

	#[cfg(unix)]
	fn bsd_shell_line(meta: &Metadata, _resolved: &Path) -> String {
		#[cfg(target_os = "macos")]
		let flags = std::os::macos::fs::MetadataExt::st_flags(meta);
		#[cfg(not(target_os = "macos"))]
		let flags = 0u32;
		let birth = metadata_get_time(meta, MetadataTimeField::Birth)
			.map_or(0, |t| system_time_to_sec(t).0);
		format!(
			"st_dev={} st_ino={} st_mode=0{:o} st_nlink={} st_uid={} st_gid={} st_rdev={} \
			 st_size={} st_atime={} st_mtime={} st_ctime={} st_birthtime={birth} st_blksize={} \
			 st_blocks={} st_flags={flags}",
			meta.dev(),
			meta.ino(),
			meta.mode(),
			meta.nlink(),
			meta.uid(),
			meta.gid(),
			meta.rdev(),
			meta.len(),
			meta.atime(),
			meta.mtime(),
			meta.ctime(),
			meta.blksize(),
			meta.blocks(),
		)
	}

	#[cfg(windows)]
	fn bsd_shell_line(meta: &Metadata, resolved: &Path) -> String {
		let ids = win::handle_info(resolved, !meta.file_type().is_symlink());
		let (dev, ino, nlink) = ids.map_or((0, 0, 1), |i| (i.volume_serial, i.file_index, i.links));
		let sec = |field| win::md_time(meta, field).map_or(0, |t| system_time_to_sec(t).0);
		format!(
			"st_dev={dev} st_ino={ino} st_mode=0{:o} st_nlink={nlink} st_uid=0 st_gid=0 st_rdev=0 \
			 st_size={} st_atime={} st_mtime={} st_ctime={} st_birthtime={} st_blksize=4096 \
			 st_blocks={} st_flags=0",
			win::synth_mode(meta),
			meta.len(),
			sec(win::TimeField::Access),
			sec(win::TimeField::Modification),
			sec(win::TimeField::Change),
			sec(win::TimeField::Birth),
			win::allocated_size(resolved, meta.len()).div_ceil(512),
		)
	}

	/// GNU `-f`/`--file-system` whose first operand names no file but looks
	/// like a BSD format string (contains `%` or whitespace): rather than
	/// failing on a nonexistent operand, re-interpret the invocation as BSD
	/// `stat -f <fmt> <file>...`. Existing-path operands always keep GNU
	/// filesystem mode.
	fn bsd_filesystem_fallback(matches: &ArgMatches, host: &Host) -> Option<Vec<OsString>> {
		if !matches.get_flag(options::FILE_SYSTEM)
			|| matches.contains_id(options::FORMAT)
			|| matches.contains_id(options::PRINTF)
		{
			return None;
		}
		let files: Vec<&OsString> = matches.get_many::<OsString>(options::FILES)?.collect();
		// A format plus at least one operand; a lone missing path stays a GNU
		// error.
		if files.len() < 2 {
			return None;
		}
		let fmt = files[0].to_string_lossy();
		if !(fmt.contains('%') || fmt.chars().any(char::is_whitespace)) {
			return None;
		}
		if host.resolve(files[0]).symlink_metadata().is_ok() {
			return None;
		}
		let translated = translate_bsd_format(&fmt, false).ok()?;
		let mut argv: Vec<OsString> = Vec::with_capacity(files.len() + 4);
		argv.push("stat".into());
		if matches.get_flag(options::DEREFERENCE) {
			argv.push("-L".into());
		}
		argv.push("-c".into());
		argv.push(translated.into());
		argv.push("--".into());
		argv.extend(files[1..].iter().map(|f| (*f).clone()));
		Some(argv)
	}

	/// Builds a [`Stater`] from parsed matches and runs it.
	fn run_stater(matches: &ArgMatches, host: &mut Host) -> i32 {
		match Stater::new(matches, host) {
			Ok(stater) => stater.exec(host),
			Err(error) => {
				host.error(error, 1);
				1
			},
		}
	}


	/// Parsed `stat` invocation.
	pub(crate) struct Stat {
		matches: ArgMatches,
	}

	matches_parser!(Stat, app);

	impl Utility for Stat {
		const NAME: &'static str = "stat";

		fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
			match rewrite_bsd_invocation(&argv) {
				None => Ok(argv),
				Some(result) => result,
			}
		}

		fn run(self, host: &mut Host) -> i32 {
			if self.matches.get_flag(options::BSD_SHELL) {
				return bsd_shell_exec(&self.matches, host);
			}
			if let Some(argv) = bsd_filesystem_fallback(&self.matches, host) {
				return match app().try_get_matches_from(argv) {
					Ok(matches) => run_stater(&matches, host),
					// The rebuilt argv is a plain `-c FORMAT -- FILE...`; a
					// parse failure here is unreachable in practice.
					Err(err) => {
						let _ = write!(host.stderr, "{err}");
						1
					},
				};
			}
			run_stater(&self.matches, host)
		}
	}

	pub(crate) fn app() -> Command {
		Command::new(Stat::NAME)
			.version("0.8.0")
			.about(ABOUT)
			.after_help(AFTER_HELP)
			.override_usage(host::format_usage(USAGE))
			.infer_long_args(true)
			.arg(
				Arg::new(options::DEREFERENCE)
					.short('L')
					.long(options::DEREFERENCE)
					.help("follow links")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::FILE_SYSTEM)
					.short('f')
					.long(options::FILE_SYSTEM)
					.help("display file system status instead of file status")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::TERSE)
					.short('t')
					.long(options::TERSE)
					.help("print the information in terse form")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::BSD_SHELL)
					.long(options::BSD_SHELL)
					.hide(true)
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::BSD_TIMEFMT)
					.long(options::BSD_TIMEFMT)
					.value_name("TIMEFMT")
					.hide(true),
			)
			.arg(
				Arg::new(options::FORMAT)
					.short('c')
					.long(options::FORMAT)
					.help(
						"use the specified FORMAT instead of the default;\noutput a newline after each \
						 use of FORMAT",
					)
					.value_name("FORMAT"),
			)
			.arg(
				Arg::new(options::PRINTF)
					.long(options::PRINTF)
					.value_name("FORMAT")
					.help(
						"like --format, but interpret backslash escapes,\nand do not output a mandatory \
						 trailing newline;\nif you want a newline, include \\n in FORMAT",
					),
			)
			.arg(
				Arg::new(options::FILES)
					.action(ArgAction::Append)
					.value_parser(ValueParser::os_string())
					.value_hint(clap::ValueHint::FilePath),
			)
	}

	const PRETTY_DATETIME_FORMAT: &str = "%Y-%m-%d %H:%M:%S.%N %z";

	#[cfg(unix)]
	fn pretty_time(meta: &Metadata, md_time_field: MetadataTimeField, fmt: &str) -> String {
		if let Some(time) = metadata_get_time(meta, md_time_field) {
			let mut tmp = Vec::new();
			if format_system_time(
				&mut tmp,
				time,
				fmt,
				FormatSystemTimeFallback::Float,
			)
			.is_ok()
			{
				return String::from_utf8(tmp).unwrap();
			}
		}
		"-".to_string()
	}

	/// Upstream format-parser unit tests, kept because the token parser is the
	/// most intricate part of the utility and the print paths were repatched.
	#[cfg(test)]
	mod unit_tests {
		use super::{Flags, Precision, ScanUtil, Stater, Token, group_num, timestamp_string};

		#[test]
		fn test_scanners() {
			assert_eq!(Some((-5, 2)), "-5zxc".scan_num::<i32>());
			assert_eq!(Some((51, 2)), "51zxc".scan_num::<u32>());
			assert_eq!(Some((192, 4)), "+192zxc".scan_num::<i32>());
			assert_eq!(None, "z192zxc".scan_num::<i32>());

			assert_eq!(Some(('a', 3)), "141zxc".scan_char(8));
		}

		#[test]
		fn test_group_num() {
			assert_eq!("12,379,821,234", group_num("12379821234"));
			assert_eq!("821,234", group_num("821234"));
			assert_eq!("1,234", group_num("1234"));
			assert_eq!("234", group_num("234"));
			assert_eq!("", group_num(""));
			assert_eq!("-5", group_num("-5"));
			assert_eq!("-1,234", group_num("-1234"));
		}

		#[test]
		fn normal_format() {
			let s = "%'010.2ac%-#5.w\n";
			let expected = vec![
				Token::Directive {
					flag:      Flags { group: true, zero: true, ..Default::default() },
					width:     10,
					precision: Precision::Number(2),
					format:    'a',
				},
				Token::Char('c'),
				Token::Directive {
					flag:      Flags { left: true, alter: true, ..Default::default() },
					width:     5,
					precision: Precision::NoNumber,
					format:    'w',
				},
				Token::Char('\n'),
			];
			assert_eq!(&expected, &Stater::generate_tokens(s, false, &mut Vec::new()).unwrap());
		}

		#[test]
		fn printf_format() {
			let s = r#"%-# 15a\t\r\"\\\a\b\x1B\f\x0B%+020.-23w\x12\167\132\112\n"#;
			let expected = vec![
				Token::Directive {
					flag:      Flags { left: true, alter: true, space: true, ..Default::default() },
					width:     15,
					precision: Precision::NotSpecified,
					format:    'a',
				},
				Token::Byte(b'\t'),
				Token::Byte(b'\r'),
				Token::Byte(b'"'),
				Token::Byte(b'\\'),
				Token::Byte(b'\x07'),
				Token::Byte(b'\x08'),
				Token::Byte(b'\x1B'),
				Token::Byte(b'\x0C'),
				Token::Byte(b'\x0B'),
				Token::Directive {
					flag:      Flags { sign: true, zero: true, ..Default::default() },
					width:     20,
					precision: Precision::NotSpecified,
					format:    'w',
				},
				Token::Byte(b'\x12'),
				Token::Byte(b'w'),
				Token::Byte(b'Z'),
				Token::Byte(b'J'),
				Token::Byte(b'\n'),
			];
			assert_eq!(&expected, &Stater::generate_tokens(s, true, &mut Vec::new()).unwrap());
		}

		#[test]
		fn test_timestamp_string() {
			// `stat -c %Y` must yield integers so shell arithmetic works.
			assert_eq!(timestamp_string(1712345678, 999_999_999, Precision::NotSpecified), "1712345678");
			assert_eq!(timestamp_string(1712345678, 123_456_789, Precision::Number(0)), "1712345678");
			// `%.Y` prints all nine fractional digits; explicit precision
			// truncates (GNU semantics) or zero-pads past nine.
			assert_eq!(
				timestamp_string(1712345678, 123_456_789, Precision::NoNumber),
				"1712345678.123456789"
			);
			assert_eq!(timestamp_string(1712345678, 123_456_789, Precision::Number(3)), "1712345678.123");
			assert_eq!(timestamp_string(1712345678, 5, Precision::Number(3)), "1712345678.000");
			assert_eq!(
				timestamp_string(1712345678, 123_456_789, Precision::Number(11)),
				"1712345678.12345678900"
			);
		}
	}
	/// file-status path is Unix-only (`std::os::unix`); this reimplements the
	/// GNU directives on top of `std::fs::Metadata`, direct
	/// `GetFileInformationByHandle` queries (inode / link count / device),
	/// and the Win32 volume APIs for `--file-system` mode.
	#[cfg(windows)]
	mod win {
		use std::{
			ffi::OsStr, fs::Metadata, os::windows::fs::MetadataExt, path::Path, time::SystemTime,
		};

		/// `FILE_ATTRIBUTE_READONLY`.
		const READONLY: u32 = 0x0000_0001;

		// POSIX `st_mode` type bits, synthesized for `%f`/`%F`/`%A`/`%a`.
		const S_IFDIR: u32 = 0o040000;
		const S_IFREG: u32 = 0o100000;
		const S_IFLNK: u32 = 0o120000;

		/// Which timestamp a directive refers to. Windows exposes creation,
		/// access, and write times; it has no POSIX "status change" time, so
		/// `%z`/`%Z` reuse the write time (last data modification), matching
		/// how ports such as Cygwin's `stat` behave.
		#[derive(Clone, Copy)]
		pub enum TimeField {
			Access,
			Modification,
			Change,
			Birth,
		}

		/// Resolve a [`TimeField`] to the corresponding [`SystemTime`], or
		/// `None` when the platform cannot supply it.
		pub fn md_time(md: &Metadata, field: TimeField) -> Option<SystemTime> {
			match field {
				TimeField::Access => md.accessed().ok(),
				TimeField::Modification | TimeField::Change => md.modified().ok(),
				TimeField::Birth => md.created().ok(),
			}
		}

		/// Synthesize a POSIX-style `st_mode` from Windows attributes: the file
		/// type bits plus a best-effort permission mask (read-only files/dirs
		/// drop their write bits; directories and symlinks are traversable).
		pub fn synth_mode(md: &Metadata) -> u32 {
			let readonly = md.file_attributes() & READONLY != 0;
			let ft = md.file_type();
			if ft.is_symlink() {
				S_IFLNK | 0o777
			} else if ft.is_dir() {
				S_IFDIR | if readonly { 0o555 } else { 0o755 }
			} else {
				S_IFREG | if readonly { 0o444 } else { 0o644 }
			}
		}

		/// Human-readable file type for `%F`, mirroring uucore's
		/// `pretty_filetype` for the types reachable on Windows.
		pub fn file_type_str(mode: u32, size: u64) -> String {
			match mode & 0o170000 {
				S_IFDIR => "directory",
				S_IFLNK => "symbolic link",
				_ if size == 0 => "regular empty file",
				_ => "regular file",
			}
			.to_string()
		}

		/// `ls -l`-style permission string for `%A` derived from the synthetic
		/// mode (e.g. `drwxr-xr-x`).
		pub fn perms_string(mode: u32) -> String {
			let mut s = String::with_capacity(10);
			s.push(match mode & 0o170000 {
				S_IFDIR => 'd',
				S_IFLNK => 'l',
				_ => '-',
			});
			for shift in [6u32, 3, 0] {
				let bits = (mode >> shift) & 0o7;
				s.push(if bits & 0o4 != 0 { 'r' } else { '-' });
				s.push(if bits & 0o2 != 0 { 'w' } else { '-' });
				s.push(if bits & 0o1 != 0 { 'x' } else { '-' });
			}
			s
		}

		/// On-disk allocated size in bytes for `%b`, honoring sparse and
		/// compressed files via `GetCompressedFileSizeW`. `Metadata::len()` is
		/// the logical size, which overstates allocation for sparse files, so
		/// the compressed/allocated size is queried directly. Falls back to
		/// `logical` when the query fails.
		pub fn allocated_size(path: &Path, logical: u64) -> u64 {
			use std::os::windows::ffi::OsStrExt;

			use windows_sys::Win32::Storage::FileSystem::GetCompressedFileSizeW;

			const INVALID_FILE_SIZE: u32 = u32::MAX;

			let wide: Vec<u16> = path
				.as_os_str()
				.encode_wide()
				.chain(std::iter::once(0))
				.collect();
			let mut high: u32 = 0;
			// SAFETY: `wide` is NUL-terminated and `high` is a valid `&mut u32`.
			let low = unsafe { GetCompressedFileSizeW(wide.as_ptr(), &mut high) };
			// A low dword of INVALID_FILE_SIZE is ambiguous (a real 4 GiB-1 low
			// word or an error); MSDN says to disambiguate via GetLastError.
			if low == INVALID_FILE_SIZE
				&& std::io::Error::last_os_error().raw_os_error().unwrap_or(0) != 0
			{
				return logical;
			}
			(u64::from(high) << 32) | u64::from(low)
		}

		/// Per-file identity numbers for `%d`/`%D`/`%h`/`%i`: volume serial,
		/// hard-link count, and NTFS file index.
		pub struct HandleInfo {
			pub volume_serial: u64,
			pub links:         u64,
			pub file_index:    u64,
		}

		/// Query [`HandleInfo`] via `GetFileInformationByHandle`, the stable
		/// replacement for std's unstable `windows_by_handle` metadata
		/// extensions. `follow_links` mirrors how the caller's metadata was
		/// obtained, so a `--no-dereference` stat reports the link itself.
		/// Returns `None` when the file cannot be opened or queried.
		pub fn handle_info(path: &Path, follow_links: bool) -> Option<HandleInfo> {
			use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};

			use windows_sys::Win32::Storage::FileSystem::{
				BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
				FILE_FLAG_OPEN_REPARSE_POINT, GetFileInformationByHandle,
			};

			// `FILE_FLAG_BACKUP_SEMANTICS` is required to open directories;
			// `access_mode(0)` asks for metadata access only.
			let mut flags = FILE_FLAG_BACKUP_SEMANTICS;
			if !follow_links {
				flags |= FILE_FLAG_OPEN_REPARSE_POINT;
			}
			let file = std::fs::OpenOptions::new()
				.access_mode(0)
				.custom_flags(flags)
				.open(path)
				.ok()?;
			// SAFETY: zeroed BY_HANDLE_FILE_INFORMATION is a valid out
			// buffer, and the handle stays open across the call.
			let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
			if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
				return None;
			}
			Some(HandleInfo {
				volume_serial: u64::from(info.dwVolumeSerialNumber),
				links:         u64::from(info.nNumberOfLinks),
				file_index:    (u64::from(info.nFileIndexHigh) << 32)
					| u64::from(info.nFileIndexLow),
			})
		}

		/// File-system status collected for `stat --file-system` on Windows.
		pub struct StatFs {
			pub fs_type:      String,
			pub serial:       u64,
			pub name_len:     u64,
			pub cluster_size: u64,
			pub total_blocks: u64,
			pub free_blocks:  u64,
		}

		/// Query volume information for the file's containing volume via Win32.
		/// Returns a human-readable error string on failure (mapped to the GNU
		/// "cannot read file system information" message by the caller).
		pub fn statfs(path: &Path) -> Result<StatFs, String> {
			use std::os::windows::ffi::OsStrExt;

			use windows_sys::Win32::Storage::FileSystem::{
				GetDiskFreeSpaceW, GetVolumeInformationW, GetVolumePathNameW,
			};

			fn wide(s: &OsStr) -> Vec<u16> {
				s.encode_wide().chain(std::iter::once(0)).collect()
			}

			fn wide_to_string(buf: &[u16]) -> String {
				let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
				String::from_utf16_lossy(&buf[..len])
			}

			let file_wide = wide(path.as_os_str());
			// Resolve the mount root (e.g. `C:\`) that owns the path.
			let mut root = [0u16; 260];
			// SAFETY: `file_wide` is NUL-terminated and `root` is a valid
			// mutable buffer whose capacity is passed as `root.len()`.
			if unsafe { GetVolumePathNameW(file_wide.as_ptr(), root.as_mut_ptr(), root.len() as u32) }
				== 0
			{
				return Err(std::io::Error::last_os_error().to_string());
			}

			let mut fs_name = [0u16; 260];
			let mut serial: u32 = 0;
			let mut max_component: u32 = 0;
			let mut flags: u32 = 0;
			// SAFETY: `root` is a NUL-terminated path; the serial/flag out
			// params are valid `&mut u32`; `fs_name` is a valid buffer sized by
			// `fs_name.len()`; the volume-name buffer is null with size 0.
			if unsafe {
				GetVolumeInformationW(
					root.as_ptr(),
					std::ptr::null_mut(),
					0,
					&mut serial,
					&mut max_component,
					&mut flags,
					fs_name.as_mut_ptr(),
					fs_name.len() as u32,
				)
			} == 0
			{
				return Err(std::io::Error::last_os_error().to_string());
			}

			let mut sectors_per_cluster: u32 = 0;
			let mut bytes_per_sector: u32 = 0;
			let mut free_clusters: u32 = 0;
			let mut total_clusters: u32 = 0;
			// SAFETY: `root` is a NUL-terminated path and every out param is a
			// valid `&mut u32`.
			if unsafe {
				GetDiskFreeSpaceW(
					root.as_ptr(),
					&mut sectors_per_cluster,
					&mut bytes_per_sector,
					&mut free_clusters,
					&mut total_clusters,
				)
			} == 0
			{
				return Err(std::io::Error::last_os_error().to_string());
			}

			let cluster_size = u64::from(sectors_per_cluster) * u64::from(bytes_per_sector);
			Ok(StatFs {
				fs_type: wide_to_string(&fs_name),
				serial: u64::from(serial),
				name_len: u64::from(max_component),
				cluster_size,
				total_blocks: u64::from(total_clusters),
				free_blocks: u64::from(free_clusters),
			})
		}
	}

	/// `std::fs::Metadata` timestamp through the shared datetime format.
	#[cfg(windows)]
	fn pretty_time(meta: &Metadata, field: win::TimeField, fmt: &str) -> String {
		if let Some(time) = win::md_time(meta, field) {
			let mut tmp = Vec::new();
			if format_system_time(
				&mut tmp,
				time,
				fmt,
				FormatSystemTimeFallback::Float,
			)
			.is_ok()
			{
				return String::from_utf8(tmp).unwrap();
			}
		}
		"-".to_string()
	}

	#[cfg(windows)]
	fn process_token_filesystem(
		out: &mut dyn Write,
		t: &Token,
		meta: &win::StatFs,
		display_name: &str,
	) {
		match *t {
			Token::Byte(byte) => write_raw_byte(out, byte),
			Token::Char(c) => {
				let _ = write!(out, "{c}");
			},
			Token::Directive { flag, width, precision, format } => {
				let output = match format {
					// free blocks available to non-superuser
					'a' => OutputType::Unsigned(meta.free_blocks),
					// total data blocks in file system
					'b' => OutputType::Unsigned(meta.total_blocks),
					// total / free file nodes (not tracked on Windows)
					'c' | 'd' => OutputType::Unsigned(0),
					// free blocks in file system
					'f' => OutputType::Unsigned(meta.free_blocks),
					// file system ID in hex (volume serial number)
					'i' => OutputType::UnsignedHex(meta.serial),
					// maximum length of filenames
					'l' => OutputType::Unsigned(meta.name_len),
					// file name
					'n' => OutputType::Str(display_name.to_string()),
					// block size (for faster transfers)
					's' => OutputType::Unsigned(meta.cluster_size),
					// fundamental block size (for block counts)
					'S' => OutputType::Integer(meta.cluster_size as i64),
					// file system type in hex (no numeric magic on Windows)
					't' => OutputType::UnsignedHex(0),
					// file system type in human readable form
					'T' => OutputType::Str(meta.fs_type.clone()),
					_ => OutputType::Unknown,
				};
				print_it(out, &output, flag, width, precision);
			},
		}
	}

	#[cfg(windows)]
	impl Stater {
		fn exec(&self, host: &mut Host) -> i32 {
			let mut ret = 0;
			for f in &self.files {
				ret |= self.do_stat(f, host);
			}
			ret
		}

		fn process_token_files(
			&self,
			t: &Token,
			meta: &Metadata,
			display_name: &str,
			resolved: &Path,
			file_type: FileType,
			from_user: bool,
			host: &mut Host,
		) -> Result<(), i32> {
			match *t {
				Token::Byte(byte) => write_raw_byte(&mut host.stdout, byte),
				Token::Char(c) => {
					let _ = write!(host.stdout, "{c}");
				},
				Token::Directive { flag, width, precision, format } => {
					let mode = win::synth_mode(meta);
					// `%d`/`%D`/`%h`/`%i` need a fresh handle query; skip it for
					// every other directive.
					let ids = matches!(format, 'd' | 'D' | 'h' | 'i')
						.then(|| win::handle_info(resolved, !meta.file_type().is_symlink()))
						.flatten();
					let output = match format {
						// access rights in octal
						'a' => OutputType::UnsignedOct(0o7777 & mode),
						// access rights in human readable form
						'A' => OutputType::Str(win::perms_string(mode)),
						// number of blocks allocated (512-byte units, see %B)
						'b' => {
							OutputType::Unsigned(win::allocated_size(resolved, meta.len()).div_ceil(512))
						},
						// the size in bytes of each block reported by %b
						'B' => OutputType::Unsigned(512),
						// SELinux security context string (unsupported)
						'C' => OutputType::Str("unsupported for this operating system".to_string()),
						// device number: Windows volume serial number
						'd' if flag.major || flag.minor => OutputType::Unsigned(0),
						'd' => OutputType::Unsigned(ids.as_ref().map_or(0, |ids| ids.volume_serial)),
						// device number in hex
						'D' => {
							OutputType::UnsignedHex(ids.as_ref().map_or(0, |ids| ids.volume_serial))
						},
						// raw mode in hex
						'f' => OutputType::UnsignedHex(u64::from(mode)),
						// file type
						'F' => OutputType::Str(win::file_type_str(mode, meta.len())),
						// group ID of owner (not modeled on Windows)
						'g' => OutputType::Unsigned(0),
						// group name of owner
						'G' => OutputType::Str("UNKNOWN".to_string()),
						// number of hard links
						'h' => OutputType::Unsigned(ids.as_ref().map_or(1, |ids| ids.links)),
						// inode number (NTFS file index)
						'i' => OutputType::Unsigned(ids.as_ref().map_or(0, |ids| ids.file_index)),
						// mount point (not resolved on Windows)
						'm' => OutputType::Str(String::new()),
						// file name
						'n' => OutputType::Str(display_name.to_string()),
						// quoted file name with dereference if symbolic link
						'N' => OutputType::Str(get_quoted_file_name(
							display_name,
							resolved,
							file_type,
							from_user,
							host,
						)?),
						// optimal I/O transfer size hint
						'o' => OutputType::Unsigned(4096),
						// total size, in bytes
						's' => OutputType::Integer(meta.len() as i64),
						// device type (no special files on Windows)
						't' | 'T' => OutputType::UnsignedHex(0),
						// user ID of owner (not modeled on Windows)
						'u' => OutputType::Unsigned(0),
						// user name of owner
						'U' => OutputType::Str("UNKNOWN".to_string()),
						// time of file birth, human-readable; - if unknown
						'w' => OutputType::Str(pretty_time(meta, win::TimeField::Birth, self.time_fmt())),
						// time of file birth, seconds since Epoch; 0 if unknown
						'W' => {
							let (sec, nsec) = win::md_time(meta, win::TimeField::Birth)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},
						// time of last access, human-readable
						'x' => OutputType::Str(pretty_time(meta, win::TimeField::Access, self.time_fmt())),
						// time of last access, seconds since Epoch
						'X' => {
							let (sec, nsec) = win::md_time(meta, win::TimeField::Access)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},
						// time of last data modification, human-readable
						'y' => OutputType::Str(pretty_time(meta, win::TimeField::Modification, self.time_fmt())),
						// time of last data modification, seconds since Epoch
						'Y' => {
							let (sec, nsec) = win::md_time(meta, win::TimeField::Modification)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},
						// time of last status change, human-readable (write time)
						'z' => OutputType::Str(pretty_time(meta, win::TimeField::Change, self.time_fmt())),
						// time of last status change, seconds since Epoch
						'Z' => {
							let (sec, nsec) = win::md_time(meta, win::TimeField::Change)
								.map_or((0, 0), system_time_to_sec);
							OutputType::Timestamp { sec, nsec }
						},
						// rdev (no device special files on Windows)
						'R' => OutputType::UnsignedHex(0),
						'r' => OutputType::Unsigned(0),
						_ => OutputType::Unknown,
					};
					print_it(&mut host.stdout, &output, flag, width, precision);
				},
			}
			Ok(())
		}

		fn do_stat(&self, file: &OsStr, host: &mut Host) -> i32 {
			let display_name = file.to_string_lossy();
			// directory; `display_name` keeps the operand as typed for `%n`
			// and error messages.
			let resolved = host.resolve(file);
			if self.show_fs {
				let result = fs::metadata(&resolved)
					.map_err(|error| error.to_string())
					.and_then(|_| win::statfs(&resolved));
				match result {
					Ok(meta) => {
						for t in &self.default_tokens {
							process_token_filesystem(&mut host.stdout, t, &meta, &display_name);
						}
					},
					Err(error) => {
						let _ = writeln!(
							&mut host.stderr,
							"stat: {}",
							StatError::CannotReadFilesystemInfo {
								file: display_name.quote().to_string(),
								error,
							}
						);
						return 1;
					},
				}
			} else {
				let result = if self.follow {
					fs::metadata(&resolved)
				} else {
					fs::symlink_metadata(&resolved)
				};
				match result {
					Ok(meta) => {
						let file_type = meta.file_type();
						// Windows has no character/block special files, so the
						// device-type default format is never selected.
						for t in &self.default_tokens {
							if let Err(code) = self.process_token_files(
								t,
								&meta,
								&display_name,
								&resolved,
								file_type,
								self.from_user,
								host,
							) {
								return code;
							}
						}
					},
					Err(e) => {
						let _ = writeln!(&mut host.stderr, "stat: {}", StatError::CannotStat {
							file:  display_name.quote().to_string(),
							error: e.to_string(),
						});
						return 1;
					},
				}
			}
			0
		}
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::{fs, path::PathBuf};

	use super::Stat;
	use crate::host::run_util;

	fn run_in(cwd: PathBuf, args: Vec<&str>) -> (i32, String, String) {
		let (code, capture) = run_util::<Stat>(&args, "", cwd);
		(code, capture.out(), capture.err())
	}

	/// Canonicalized temp dir (macOS tempdirs live behind /var -> /private/var,
	/// which mount-point/canonicalize logic would otherwise expand
	/// mid-assertion).
	fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let canon = fs::canonicalize(dir.path()).unwrap();
		(dir, canon)
	}

	#[test]
	fn resolves_relative_operand_against_scope_cwd() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("data.bin"), b"hello world!").unwrap();

		// Relative operand + scope cwd differing from the process cwd: only the
		// The operand is resolved against the shell working directory.
		let (code, stdout, stderr) = run_in(root, vec!["-c", "%s", "data.bin"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "12\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn percent_n_prints_operand_as_typed() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("data.bin"), b"x").unwrap();

		// GNU prints the file name exactly as typed, not the resolved path.
		let (code, stdout, stderr) = run_in(root, vec!["-c", "%n", "data.bin"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "data.bin\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn dereference_switches_between_link_and_target() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("target"), b"abc").unwrap();
		std::os::unix::fs::symlink("target", root.join("link")).unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["-c", "%F", "link"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "symbolic link\n", ""));

		let (code, stdout, stderr) = run_in(root, vec!["-L", "-c", "%F", "link"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "regular file\n", ""));
	}

	#[test]
	fn nonexistent_file_reports_cannot_stat() {
		let (_dir, root) = canonical_tempdir();

		let (code, stdout, stderr) = run_in(root, vec!["missing"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.starts_with("stat: cannot stat 'missing':"), "unexpected stderr: {stderr:?}");
	}

	#[test]
	fn file_system_mode_succeeds() {
		let (_dir, root) = canonical_tempdir();

		let (code, stdout, stderr) = run_in(root, vec!["-f", "-c", "%S", "."]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		assert!(
			stdout.trim_end().parse::<u64>().is_ok(),
			"fundamental block size should be numeric: {stdout:?}"
		);
	}

	#[test]
	fn printf_controls_trailing_newline_and_escapes() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("data.bin"), b"hello world!").unwrap();

		// --printf emits no mandatory trailing newline...
		let (code, stdout, _) = run_in(root.clone(), vec!["--printf", "%s", "data.bin"]);
		assert_eq!((code, stdout.as_str()), (0, "12"));

		// ...but interprets backslash escapes.
		let (code, stdout, _) = run_in(root, vec!["--printf", r"%s\t%n\n", "data.bin"]);
		assert_eq!((code, stdout.as_str()), (0, "12\tdata.bin\n"));
	}

	#[test]
	fn terse_prints_name_as_typed_and_size() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("data.bin"), b"hello world!").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["-t", "data.bin"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let fields: Vec<&str> = stdout.split_whitespace().collect();
		assert_eq!(fields[0], "data.bin");
		assert_eq!(fields[1], "12");
		assert_eq!(fields.len(), 16, "terse format has 16 fields: {stdout:?}");
	}

	#[test]
	fn missing_operand_is_error() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec![]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.contains("stat: missing operand"), "unexpected stderr: {stderr:?}");
		assert!(stderr.contains("Try 'stat --help'"), "unexpected stderr: {stderr:?}");
	}

	#[test]
	fn help_renders_to_scope_stdout() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec!["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("file system status"));
		assert_eq!(stderr, "");
	}

	#[test]
	fn bsd_dash_f_format_is_translated() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("data.bin"), b"hello world!").unwrap();

		// macOS `stat -f "%Sm %N"`: BSD `-f` takes a format; the invocation is
		// detected and translated instead of being parsed as `--file-system`.
		let (code, stdout, stderr) = run_in(root.clone(), vec!["-f", "%Sm %N", "data.bin"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		assert!(stdout.ends_with(" data.bin\n"), "unexpected stdout: {stdout:?}");
		assert!(
			stdout.chars().next().is_some_and(|c| c.is_ascii_digit()),
			"human-readable mtime should lead: {stdout:?}"
		);

		// Size, name-as-typed, and epoch mtime.
		let (code, stdout, stderr) = run_in(root, vec!["-f", "%N: %z (%m)", "data.bin"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		assert!(stdout.starts_with("data.bin: 12 ("), "unexpected stdout: {stdout:?}");
		let epoch = stdout
			.trim_end()
			.trim_end_matches(')')
			.rsplit('(')
			.next()
			.unwrap();
		assert!(epoch.parse::<u64>().is_ok(), "epoch mtime should be numeric: {stdout:?}");
	}

	#[test]
	fn bsd_flag_cluster_follows_symlink_and_suppresses_newline() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("target"), b"abc").unwrap();
		std::os::unix::fs::symlink("target", root.join("link")).unwrap();

		// `-Lnf`: BSD boolean flags clustered with `-f`; `-n` drops the
		// trailing newline (mapped to --printf), `-L` follows the link.
		let (code, stdout, stderr) = run_in(root, vec!["-Lnf", "%z", "link"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "3", ""));
	}

	#[test]
	fn bsd_string_form_and_subfield_directives() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("data.bin"), b"x").unwrap();

		// %HT → %F (file type), %Lp → %a (permission bits, octal).
		let (code, stdout, stderr) = run_in(root, vec!["-f", "%HT/%Lp", "data.bin"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let (kind, perms) = stdout.trim_end().rsplit_once('/').unwrap();
		assert_eq!(kind, "regular file");
		assert!(perms.chars().all(|c| c.is_digit(8)), "octal perms expected: {stdout:?}");
	}

	#[test]
	fn bsd_unsupported_directive_is_rejected() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("data.bin"), b"x").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["-f", "%v", "data.bin"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(
			stderr.contains("unsupported BSD format directive '%v'"),
			"unexpected stderr: {stderr:?}"
		);
	}

	#[test]
	fn epoch_time_specifiers_print_integers() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("data.bin"), b"x").unwrap();

		// Regression: `%X`/`%Y`/`%Z` printed floats, which broke shell
		// arithmetic like `$(($(stat -c %Y a) - $(stat -c %Y b)))`.
		let (code, stdout, stderr) = run_in(root, vec!["-c", "%X %Y %Z %W", "data.bin"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let fields: Vec<&str> = stdout.split_whitespace().collect();
		assert_eq!(fields.len(), 4, "unexpected stdout: {stdout:?}");
		for field in fields {
			assert!(field.parse::<i64>().is_ok(), "epoch fields must be integers: {stdout:?}");
		}
	}

	#[test]
	fn epoch_time_precision_prints_fraction() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("data.bin"), b"x").unwrap();

		// `%.3Y` keeps three fractional digits; bare `%.Y` prints all nine.
		let (code, stdout, _) = run_in(root.clone(), vec!["-c", "%.3Y", "data.bin"]);
		assert_eq!(code, 0);
		let (sec, frac) = stdout.trim_end().split_once('.').expect("fraction expected");
		assert!(sec.parse::<i64>().is_ok(), "unexpected stdout: {stdout:?}");
		assert_eq!(frac.len(), 3, "unexpected stdout: {stdout:?}");

		let (_, stdout, _) = run_in(root, vec!["-c", "%.Y", "data.bin"]);
		let (_, frac) = stdout.trim_end().split_once('.').expect("fraction expected");
		assert_eq!(frac.len(), 9, "unexpected stdout: {stdout:?}");
	}

	#[test]
	fn bsd_shell_format_prints_evalable_assignments() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("data.bin"), b"hello world!").unwrap();

		// BSD `stat -s`: one line of `st_*=value` pairs, eval-able in sh.
		let (code, stdout, stderr) = run_in(root, vec!["-s", "data.bin"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		assert_eq!(stdout.lines().count(), 1, "one line per file: {stdout:?}");
		let keys: Vec<&str> = stdout
			.split_whitespace()
			.map(|pair| pair.split_once('=').expect("key=value pair").0)
			.collect();
		assert_eq!(keys, [
			"st_dev",
			"st_ino",
			"st_mode",
			"st_nlink",
			"st_uid",
			"st_gid",
			"st_rdev",
			"st_size",
			"st_atime",
			"st_mtime",
			"st_ctime",
			"st_birthtime",
			"st_blksize",
			"st_blocks",
			"st_flags",
		]);
		assert!(stdout.contains(" st_size=12 "), "unexpected stdout: {stdout:?}");
		let mode = stdout
			.split_whitespace()
			.find_map(|pair| pair.strip_prefix("st_mode="))
			.unwrap();
		assert!(mode.starts_with('0'), "octal mode with leading zero: {stdout:?}");
		assert!(u32::from_str_radix(mode, 8).is_ok(), "octal mode: {stdout:?}");
	}

	#[test]
	fn bsd_verbose_format_prints_linux_like_block() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("data.bin"), b"hello world!").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["-x", "data.bin"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		assert!(stdout.starts_with("  File: \"data.bin\"\n"), "unexpected stdout: {stdout:?}");
		assert!(stdout.contains("FileType:"), "unexpected stdout: {stdout:?}");
		assert!(stdout.contains("  Mode: (0"), "unexpected stdout: {stdout:?}");
		// ctime(3)-style timestamps: "Access: Wed Aug 20 10:11:12 2026".
		let access = stdout.lines().find(|l| l.starts_with("Access: ")).unwrap();
		let year = access.rsplit(' ').next().unwrap();
		assert_eq!(year.len(), 4, "ctime-style year expected: {access:?}");
		assert!(year.parse::<u32>().is_ok(), "ctime-style year expected: {access:?}");
	}

	#[test]
	fn bsd_dash_f_size_format_prints_size() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("data.bin"), b"hello world!").unwrap();

		// Acceptance: BSD `stat -f '%z bytes' file`.
		let (code, stdout, stderr) = run_in(root, vec!["-f", "%z bytes", "data.bin"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "12 bytes\n", ""));
	}

	#[test]
	fn bsd_dash_t_timefmt_formats_times() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("data.bin"), b"x").unwrap();

		// BSD `-t` supplies the strftime format for `%Sm`-style directives;
		// this used to be ignored with a warning.
		let (code, stdout, stderr) = run_in(root, vec!["-f", "%Sm", "-t", "%Y", "data.bin"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let year: u32 = stdout.trim_end().parse().expect("year only");
		assert!((1970..=9999).contains(&year), "unexpected stdout: {stdout:?}");
	}

	#[test]
	fn gnu_filesystem_mode_keeps_existing_path_operands() {
		let (_dir, root) = canonical_tempdir();

		// `stat -f <existing path>` stays GNU `--file-system` mode.
		let (code, stdout, stderr) = run_in(root, vec!["-f", "."]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		assert!(stdout.contains("Namelen:"), "filesystem block expected: {stdout:?}");
	}

	#[test]
	fn bsd_dash_f_fallback_on_nonexistent_format_like_operand() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("data.bin"), b"x").unwrap();

		// No `%` directive, but the operand names no file and looks like a
		// format string: BSD semantics print it literally instead of failing
		// with a filesystem error on a nonexistent operand.
		let (code, stdout, stderr) = run_in(root, vec!["-f", "no percent here", "data.bin"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "no percent here\n", ""));
	}
}

#[cfg(all(test, windows))]
mod win_tests {
	use std::{fs, path::PathBuf};

	use super::Stat;
	use crate::host::run_util;

	fn run_in(cwd: PathBuf, args: Vec<&str>) -> (i32, String, String) {
		let (code, capture) = run_util::<Stat>(&args, "", cwd);
		(code, capture.out(), capture.err())
	}

	#[test]
	fn reports_size_and_type_for_regular_file() {
		let (_dir, root) = tempdir();
		fs::write(root.join("data.bin"), b"hello world!").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["-c", "%s %F", "data.bin"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "12 regular file\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn empty_file_reports_regular_empty_file() {
		let (_dir, root) = tempdir();
		fs::write(root.join("empty.bin"), b"").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["-c", "%F", "empty.bin"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "regular empty file\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn percent_n_prints_operand_as_typed() {
		let (_dir, root) = tempdir();
		fs::write(root.join("data.bin"), b"x").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["-c", "%n", "data.bin"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "data.bin\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn nonexistent_file_reports_cannot_stat() {
		let (_dir, root) = tempdir();

		let (code, stdout, stderr) = run_in(root, vec!["-c", "%s", "missing.bin"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.contains("cannot stat"), "unexpected stderr: {stderr:?}");
	}

	/// `--file-system` mode goes through the Win32 volume backend and must not
	/// error on a real path.
	#[test]
	fn file_system_mode_succeeds() {
		let (_dir, root) = tempdir();
		fs::write(root.join("data.bin"), b"x").unwrap();

		let (code, _stdout, stderr) = run_in(root, vec!["-f", "-c", "%T", "data.bin"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
	}

	#[test]
	fn file_system_mode_rejects_missing_file() {
		let (_dir, root) = tempdir();

		let (code, stdout, stderr) = run_in(root, vec!["-f", "-c", "%T", "missing.bin"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(
			stderr.contains("cannot read file system information"),
			"unexpected stderr: {stderr:?}"
		);
	}
}
