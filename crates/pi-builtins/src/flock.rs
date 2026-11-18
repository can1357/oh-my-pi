//! util-linux `flock` builtin: take an advisory lock on a file, a directory or
//! one of the shell's open descriptors, optionally around a command.
//!
//! In-process so the lock lands on the shell's own descriptor table (`exec
//! 9>lock; flock 9`), the command runs through the shell's dispatch
//! ([`Host::run_command_async`]: builtins first, held under the lock for its
//! lifetime), and a wait for a contended lock ends with the shell's
//! cancellation.
//!
//! A thread blocked in `flock(2)` can only be interrupted by a signal, which a
//! builtin has no business sending inside its host process. A contended lock
//! is therefore retried without blocking, pausing [`RETRY_FIRST`] and then
//! twice as long each time up to [`RETRY_MAX`], so `-w` deadlines and
//! cancellation are exact and nothing is left behind in the kernel's wait
//! queue.
//!
//! Options, diagnostics and exit statuses follow util-linux `flock.c`
//! (`sysexits.h` statuses; the `-E` status for a conflict or timeout; the
//! command's own status otherwise).

use std::{
	borrow::Cow,
	ffi::{OsStr, OsString},
	fmt,
	fs::File,
	io::{self, Write as _},
	path::Path,
	sync::Arc,
	time::{Duration, Instant},
};

use clap::Parser;

use crate::{
	host::{AsyncUtility, Host, ShellCommand, strip_errno},
	openfile::OpenFile,
};

/// `sysexits.h`: the command was used incorrectly.
const EX_USAGE: i32 = 64;
/// `sysexits.h`: the lock could not be applied to the file.
const EX_DATAERR: i32 = 65;
/// `sysexits.h`: the lock file could not be opened.
const EX_NOINPUT: i32 = 66;
/// `sysexits.h`: the command could not be executed.
const EX_UNAVAILABLE: i32 = 69;
/// `sysexits.h`: the system ran out of a resource.
const EX_OSERR: i32 = 71;
/// `sysexits.h`: the lock file could not be created.
const EX_CANTCREAT: i32 = 73;

/// The pause before the first retry of a contended lock.
const RETRY_FIRST: Duration = Duration::from_millis(1);
/// The longest pause between retries of a contended lock: how long a freed
/// lock can go unnoticed.
const RETRY_MAX: Duration = Duration::from_millis(25);

const VERSION: &str = "flock from util-linux 2.42.4\n";

const USAGE: &str = concat!(
	"\nUsage:\n",
	" flock [options] <file>|<directory> <command> [<argument>...]\n",
	" flock [options] <file>|<directory> -c <command>\n",
	" flock [options] <file descriptor number>\n",
	" flock [options] --fd <file descriptor number> -c <command>\n",
	" flock [options] --fd <file descriptor number> <command> [<argument>...]\n",
	"\n",
	"Manage file locks from shell scripts.\n",
	"\nOptions:\n",
	" -s, --shared             get a shared lock\n",
	" -x, --exclusive          get an exclusive lock (default)\n",
	" -u, --unlock             remove a lock\n",
	" -n, --nb, --nonblocking  fail rather than wait\n",
	" -w, --timeout <secs>     wait for a limited amount of time\n",
	" -E, --conflict-exit-code <number>  exit code after conflict or timeout\n",
	" -o, --close              close file descriptor before running command\n",
	" -c, --command <command>  run a single command string through the shell\n",
	" -F, --no-fork            execute command without forking\n",
	"     --wait               same as --timeout\n",
	"     --fcntl              use fcntl(F_OFD_SETLK) rather than flock()\n",
	"     --start <offset>     starting offset for lock (implies --fcntl)\n",
	"     --length <number>    number of bytes to lock (implies --fcntl)\n",
	"     --fd <number>        use the file descriptor number to wrap the\n",
	"                          lock around the command execution\n",
	"\n",
	" -h, --help               display this help\n",
	" -V, --version            display version\n",
	"\nFor more details see flock(1).\n",
);

/// A `flock` invocation: its words as typed, which [`parse`] reads the way
/// util-linux's `getopt_long` loop does (options end at the first operand, so
/// the command keeps its own).
#[derive(Parser)]
#[command(name = "flock", disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct Flock {
	#[arg(num_args = 0..)]
	words: Vec<OsString>,
}

impl AsyncUtility for Flock {
	const NAME: &'static str = "flock";
	const RUNS_COMMANDS: bool = true;
	const USAGE_ERROR: u8 = EX_USAGE as u8;

	/// Puts every word behind `--`, so clap hands them over untouched.
	fn rewrite_argv(mut argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		argv.insert(argv.len().min(1), OsString::from("--"));
		Ok(argv)
	}

	async fn run(self, host: &mut Host) -> i32 {
		let plan = match parse(&self.words) {
			Ok(Parsed::Run(plan)) => plan,
			Ok(Parsed::Help) => return print(host, USAGE),
			Ok(Parsed::Version) => return print(host, VERSION),
			Err(error) => {
				warn(host, &error.message);
				if error.try_help {
					let _ = writeln!(host.stderr, "Try 'flock --help' for more information.");
				}
				return EX_USAGE;
			},
		};
		execute(&plan, host).await
	}
}

/// The lock `flock` applies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Operation {
	Shared,
	Exclusive,
	Unlock,
}

/// The bytes an open file description lock covers (`--start`, `--length`). A
/// zero length runs to the end of the file, however far it grows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Range {
	start:  u64,
	length: u64,
}

/// Which kind of lock is applied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Api {
	/// `flock(2)`: the whole file.
	Flock,
	/// `--fcntl`: an open file description lock (`F_OFD_SETLK`) on a range.
	Ofd(Range),
}

/// What gets locked.
#[derive(Debug, PartialEq, Eq)]
enum Target<'a> {
	/// A file or directory, created when missing.
	Path(&'a OsStr),
	/// One of the shell's open descriptors.
	Descriptor(i32),
}

impl fmt::Display for Target<'_> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Path(name) => Path::new(name).display().fmt(f),
			Self::Descriptor(number) => number.fmt(f),
		}
	}
}

/// The command run under the lock.
#[derive(Debug, PartialEq, Eq)]
enum Command<'a> {
	/// A command and its arguments.
	Argv(&'a [OsString]),
	/// `-c`: shell source.
	Line(&'a OsStr),
}

/// A complete invocation.
#[derive(Debug, PartialEq)]
struct Plan<'a> {
	operation:       Operation,
	api:             Api,
	nonblocking:     bool,
	/// `-w`, in seconds as typed.
	timeout:         Option<f64>,
	/// `-E`: the status of a conflict or timeout.
	conflict_status: u8,
	verbose:         bool,
	target:          Target<'a>,
	command:         Option<Command<'a>>,
}

#[derive(Debug, PartialEq)]
enum Parsed<'a> {
	Help,
	Version,
	Run(Plan<'a>),
}

/// A usage error: its message, and whether util-linux follows it with the
/// `Try 'flock --help'` pointer.
#[derive(Debug, PartialEq, Eq)]
struct UsageError {
	message:  String,
	try_help: bool,
}

impl UsageError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into(), try_help: false }
	}

	fn with_help(message: impl Into<String>) -> Self {
		Self { message: message.into(), try_help: true }
	}

	fn unrecognized(word: &OsStr) -> Self {
		Self::with_help(format!("unrecognized option '{}'", word.to_string_lossy()))
	}

	fn missing_argument(word: &OsStr) -> Self {
		Self::with_help(format!("option '{}' requires an argument", word.to_string_lossy()))
	}
}

/// An option of `flock`, whichever way it is spelled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Opt {
	Shared,
	Exclusive,
	Unlock,
	Nonblocking,
	Timeout,
	ConflictExitCode,
	Close,
	NoFork,
	Verbose,
	Fcntl,
	Start,
	Length,
	Fd,
	Help,
	Version,
}

/// The long options. `-c`/`--command` is not among them: util-linux leaves it
/// to its unknown-option branch, and so does [`parse`].
const LONG_OPTIONS: &[(&str, Opt)] = &[
	("shared", Opt::Shared),
	("exclusive", Opt::Exclusive),
	("unlock", Opt::Unlock),
	("nonblocking", Opt::Nonblocking),
	("nb", Opt::Nonblocking),
	("timeout", Opt::Timeout),
	("wait", Opt::Timeout),
	("conflict-exit-code", Opt::ConflictExitCode),
	("close", Opt::Close),
	("no-fork", Opt::NoFork),
	("verbose", Opt::Verbose),
	("fcntl", Opt::Fcntl),
	("start", Opt::Start),
	("length", Opt::Length),
	("fd", Opt::Fd),
	("help", Opt::Help),
	("version", Opt::Version),
];

impl Opt {
	const fn short(byte: u8) -> Option<Self> {
		Some(match byte {
			b's' => Self::Shared,
			b'e' | b'x' => Self::Exclusive,
			b'u' => Self::Unlock,
			b'n' => Self::Nonblocking,
			b'w' => Self::Timeout,
			b'E' => Self::ConflictExitCode,
			b'o' => Self::Close,
			b'F' => Self::NoFork,
			b'h' => Self::Help,
			b'V' => Self::Version,
			_ => return None,
		})
	}

	/// The option `name` spells: its exact name, or as `getopt_long` allows,
	/// a prefix that only one option starts with.
	fn long(name: &[u8]) -> Option<Self> {
		if let Some(&(_, opt)) = LONG_OPTIONS.iter().find(|(long, _)| long.as_bytes() == name) {
			return Some(opt);
		}
		let mut abbreviated = LONG_OPTIONS
			.iter()
			.filter(|(long, _)| long.as_bytes().starts_with(name))
			.map(|&(_, opt)| opt);
		let first = abbreviated.next()?;
		abbreviated.all(|opt| opt == first).then_some(first)
	}

	const fn takes_value(self) -> bool {
		matches!(
			self,
			Self::Timeout | Self::ConflictExitCode | Self::Start | Self::Length | Self::Fd
		)
	}
}

/// The options seen so far.
struct Scan<'a> {
	operation:       Operation,
	nonblocking:     bool,
	timeout:         Option<f64>,
	conflict_status: u8,
	close:           bool,
	no_fork:         bool,
	verbose:         bool,
	fcntl:           bool,
	range:           Range,
	/// `--fd`; negative is as good as missing.
	descriptor:      Option<i64>,
	/// `-c` or `--command` among the options, as spelled.
	command_option:  Option<&'a OsStr>,
}

impl<'a> Scan<'a> {
	/// Applies `opt` with its `value` (empty when it takes none). `Some` ends
	/// the parse at once: `-h` and `-V` act where they stand.
	fn apply(&mut self, opt: Opt, value: &str) -> Result<Option<Parsed<'a>>, UsageError> {
		match opt {
			Opt::Shared => self.operation = Operation::Shared,
			Opt::Exclusive => self.operation = Operation::Exclusive,
			Opt::Unlock => self.operation = Operation::Unlock,
			Opt::Nonblocking => self.nonblocking = true,
			Opt::Timeout => self.timeout = Some(parse_seconds(value)?),
			Opt::ConflictExitCode => {
				let label = "invalid exit code (allowed values: 0-255)";
				self.conflict_status = match parse_integer(value) {
					Ok(status) => u8::try_from(status).map_err(|_| out_of_range(label, value))?,
					Err(error) => return Err(error.report(label, value)),
				};
			},
			Opt::Close => self.close = true,
			Opt::NoFork => self.no_fork = true,
			Opt::Verbose => self.verbose = true,
			Opt::Fcntl => self.fcntl = true,
			Opt::Start => {
				self.range.start = parse_size(value)
					.map_err(|error| error.report_errno("invalid as start offset", value))?;
				self.fcntl = true;
			},
			Opt::Length => {
				self.range.length = parse_size(value)
					.map_err(|error| error.report_errno("invalid as length of lock range", value))?;
				self.fcntl = true;
			},
			Opt::Fd => self.descriptor = Some(parse_descriptor(value)?),
			Opt::Help => return Ok(Some(Parsed::Help)),
			Opt::Version => return Ok(Some(Parsed::Version)),
		}
		Ok(None)
	}
}

/// Reads `words` (everything after `flock`) as util-linux does.
///
/// Options end at the first operand or at `--`. `-c`/`--command` takes the
/// next word as shell source, among the options (with `--fd`) or right after
/// the file. A lone operand is a descriptor number; with more, the first is
/// the file and the rest the command.
fn parse(words: &[OsString]) -> Result<Parsed<'_>, UsageError> {
	if words.is_empty() {
		return Err(UsageError::with_help("not enough arguments"));
	}
	let mut scan = Scan {
		operation:       Operation::Exclusive,
		nonblocking:     false,
		timeout:         None,
		conflict_status: 1,
		close:           false,
		no_fork:         false,
		verbose:         false,
		fcntl:           false,
		range:           Range::default(),
		descriptor:      None,
		command_option:  None,
	};
	let mut next = 0;
	while let Some(word) = words.get(next) {
		let bytes = word.as_encoded_bytes();
		if bytes == b"--" {
			next += 1;
			break;
		}
		if bytes.len() < 2 || bytes[0] != b'-' {
			break;
		}
		next += 1;
		if let Some(long) = bytes.strip_prefix(b"--") {
			let (name, inline) = match long.iter().position(|&byte| byte == b'=') {
				Some(at) => (&long[..at], Some(&long[at + 1..])),
				None => (long, None),
			};
			let Some(opt) = Opt::long(name) else {
				if bytes == b"--command" {
					scan.command_option = Some(word);
					continue;
				}
				return Err(UsageError::unrecognized(word));
			};
			let value = match (opt.takes_value(), inline) {
				(true, Some(inline)) => String::from_utf8_lossy(inline),
				(true, None) => {
					let value = words.get(next).ok_or_else(|| UsageError::missing_argument(word))?;
					next += 1;
					value.to_string_lossy()
				},
				(false, Some(_)) => return Err(UsageError::unrecognized(word)),
				(false, None) => Cow::Borrowed(""),
			};
			if let Some(done) = scan.apply(opt, &value)? {
				return Ok(done);
			}
			continue;
		}
		let mut cluster = &bytes[1..];
		while let Some((&byte, rest)) = cluster.split_first() {
			cluster = rest;
			let Some(opt) = Opt::short(byte) else {
				if bytes == b"-c" {
					scan.command_option = Some(word);
					break;
				}
				return Err(UsageError::unrecognized(word));
			};
			let value = if !opt.takes_value() {
				Cow::Borrowed("")
			} else if cluster.is_empty() {
				let value = words.get(next).ok_or_else(|| UsageError::missing_argument(word))?;
				next += 1;
				value.to_string_lossy()
			} else {
				String::from_utf8_lossy(std::mem::take(&mut cluster))
			};
			if let Some(done) = scan.apply(opt, &value)? {
				return Ok(done);
			}
		}
	}

	if scan.no_fork && scan.close {
		return Err(UsageError::new("the --no-fork and --close options are incompatible"));
	}
	let operands = &words[next..];
	let one_command = |option: &OsStr| {
		UsageError::new(format!(
			"{} requires exactly one command argument",
			option.to_string_lossy()
		))
	};
	let mut descriptor = scan.descriptor;
	let mut file = None;
	let command = if let Some(option) = scan.command_option {
		let [source] = operands else {
			return Err(one_command(option));
		};
		Some(Command::Line(source))
	} else if descriptor.is_none()
		&& let [name, rest @ ..] = operands
		&& !rest.is_empty()
	{
		file = Some(name.as_os_str());
		Some(match rest {
			[option, source @ ..] if option == "-c" || option == "--command" => {
				let [source] = source else {
					return Err(one_command(option));
				};
				Command::Line(source)
			},
			// `flock lock -- cmd`: the separator is not the command.
			[separator, argv @ ..] if separator == "--" && !argv.is_empty() => Command::Argv(argv),
			argv => Command::Argv(argv),
		})
	} else if let [number, ..] = operands {
		if descriptor.is_some() {
			Some(Command::Argv(operands))
		} else {
			descriptor = Some(parse_descriptor(&number.to_string_lossy())?);
			None
		}
	} else if descriptor.is_some() {
		return Err(UsageError::new("missing command"));
	} else {
		None
	};
	let target = match (file, descriptor.map(i32::try_from)) {
		(Some(name), _) => Target::Path(name),
		(None, Some(Ok(number))) if number >= 0 => Target::Descriptor(number),
		_ => return Err(UsageError::new("missing file descriptor, file or directory")),
	};
	Ok(Parsed::Run(Plan {
		operation: scan.operation,
		api: if scan.fcntl { Api::Ofd(scan.range) } else { Api::Flock },
		nonblocking: scan.nonblocking,
		timeout: scan.timeout,
		conflict_status: scan.conflict_status,
		verbose: scan.verbose,
		target,
		command,
	}))
}

/// Why a number did not parse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NumberError {
	Invalid,
	Range,
}

impl NumberError {
	/// util-linux's `<label>: '<text>'`, with `strerror(ERANGE)` when the
	/// number is out of range.
	fn report(self, label: &str, text: &str) -> UsageError {
		match self {
			Self::Invalid => UsageError::new(format!("{label}: '{text}'")),
			Self::Range => out_of_range(label, text),
		}
	}

	/// As [`NumberError::report`], for the parsers that always leave an
	/// `errno` behind.
	fn report_errno(self, label: &str, text: &str) -> UsageError {
		match self {
			Self::Invalid => UsageError::new(format!("{label}: '{text}': Invalid argument")),
			Self::Range => out_of_range(label, text),
		}
	}
}

fn out_of_range(label: &str, text: &str) -> UsageError {
	UsageError::new(format!("{label}: '{text}': Numerical result out of range"))
}

/// `strtoimax` over all of `text`, base 10.
fn parse_integer(text: &str) -> Result<i64, NumberError> {
	use std::num::IntErrorKind;

	text.trim_start().parse::<i64>().map_err(|error| match error.kind() {
		IntErrorKind::PosOverflow | IntErrorKind::NegOverflow => NumberError::Range,
		_ => NumberError::Invalid,
	})
}

/// A descriptor number: any integer up to `INT_MAX` (a negative one is
/// reported later, as a missing descriptor).
fn parse_descriptor(text: &str) -> Result<i64, UsageError> {
	let label = "invalid file descriptor";
	match parse_integer(text) {
		Ok(number) if number > i64::from(i32::MAX) => Err(out_of_range(label, text)),
		Ok(number) => Ok(number),
		Err(error) => Err(error.report(label, text)),
	}
}

/// `-w`'s seconds, fractions allowed.
fn parse_seconds(text: &str) -> Result<f64, UsageError> {
	text
		.trim_start()
		.parse()
		.map_err(|_| UsageError::new(format!("invalid timeout: '{text}'")))
}

/// util-linux's size syntax: an integer (decimal, `0x` hexadecimal or `0`
/// octal), optionally with a decimal fraction and a `K`/`M`/`G`/`T`/`P`/`E`
/// suffix: powers of 1024 bare or with `iB`, of 1000 with `B`.
fn parse_size(text: &str) -> Result<u64, NumberError> {
	let digits = text.trim_start();
	let digits = digits.strip_prefix('+').unwrap_or(digits);
	let (radix, digits) = match digits.as_bytes() {
		[b'0', b'x' | b'X', ..] => (16, &digits[2..]),
		[b'0', _, ..] => (8, &digits[1..]),
		_ => (10, digits),
	};
	let end = digits.find(|c: char| !c.is_digit(radix)).unwrap_or(digits.len());
	let (whole, rest) = digits.split_at(end);
	let whole = match whole {
		// A lone leading `0` was taken for the octal prefix.
		"" if radix == 8 => 0,
		"" => return Err(NumberError::Invalid),
		whole => u64::from_str_radix(whole, radix).map_err(|_| NumberError::Range)?,
	};
	if rest.is_empty() {
		return Ok(whole);
	}
	let (fraction, suffix) = match rest.strip_prefix('.') {
		Some(rest) => rest.split_at(rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len())),
		None => ("", rest),
	};
	let mut suffix = suffix.chars();
	let power = suffix
		.next()
		.and_then(|unit| "KMGTPEZY".find(unit.to_ascii_uppercase()))
		.ok_or(NumberError::Invalid)?;
	let base: u128 = match suffix.as_str() {
		"" | "iB" | "ib" => 1024,
		"B" | "b" => 1000,
		_ => return Err(NumberError::Invalid),
	};
	let unit = base.checked_pow(power as u32 + 1).ok_or(NumberError::Range)?;
	// Enough digits for every unit, with room to scale them in a `u128`.
	let fraction = &fraction[..fraction.len().min(12)];
	let part = fraction
		.parse::<u128>()
		.ok()
		.and_then(|part| part.checked_mul(unit))
		.map_or(0, |part| part / 10_u128.pow(fraction.len() as u32));
	u128::from(whole)
		.checked_mul(unit)
		.and_then(|bytes| bytes.checked_add(part))
		.and_then(|bytes| u64::try_from(bytes).ok())
		.ok_or(NumberError::Range)
}

/// How long a contended lock is waited for.
#[derive(Clone, Copy)]
enum Patience {
	/// `-n`, or `-w 0`.
	Never,
	Forever,
	/// `-w`: until the deadline.
	Until(Instant),
}

/// The open file a lock is applied to.
enum LockFile {
	/// The lock file `flock` opened; closing it drops the lock.
	Owned(File),
	/// A descriptor of the shell, which keeps the lock once `flock` is done.
	Shell(Arc<File>),
}

impl LockFile {
	fn file(&self) -> &File {
		match self {
			Self::Owned(file) => file,
			Self::Shell(file) => file,
		}
	}
}

/// How a lock file is opened.
#[derive(Clone, Copy)]
enum Access {
	Read,
	Write,
	ReadWrite,
}

/// Writes `text` to stdout and succeeds.
fn print(host: &Host, text: &str) -> i32 {
	let _ = host.stdout_writer().write_all(text.as_bytes());
	0
}

/// Writes `flock: <message>` to stderr.
fn warn(host: &mut Host, message: impl fmt::Display) {
	let _ = writeln!(host.stderr, "flock: {message}");
}

/// Takes the lock of `plan`, then runs its command under it.
async fn execute(plan: &Plan<'_>, host: &mut Host) -> i32 {
	let mut lock = match plan.target {
		Target::Descriptor(number) => {
			// Only a host file carries a lock; `None` inside: something else.
			let found = host.paths().file(number).map(|file| match file {
				OpenFile::File(file) => Some(Arc::clone(file)),
				OpenFile::Vfs(_) | OpenFile::Stream(_) => None,
			});
			match found {
				Some(Some(file)) => LockFile::Shell(file),
				other => {
					let reason =
						if other.is_some() { "Operation not supported" } else { "Bad file descriptor" };
					warn(host, format_args!("{number}: {reason}"));
					return EX_DATAERR;
				},
			}
		},
		Target::Path(name) => {
			// An exclusive open file description lock needs write access.
			let access = match (plan.api, plan.operation) {
				(Api::Ofd(_), Operation::Exclusive) => Access::Write,
				_ => Access::Read,
			};
			match open_lock_file(host, name, access).await {
				Ok(file) => LockFile::Owned(file),
				Err(error) => {
					warn(
						host,
						format_args!("cannot open lock file {}: {}", plan.target, strip_errno(&error)),
					);
					return open_failure_status(&error);
				},
			}
		},
	};

	// util-linux keeps whole microseconds of `-w`.
	let patience = match plan.timeout.map(|seconds| (seconds * 1e6).trunc()) {
		Some(micros) if micros < 0.0 || micros.is_nan() => {
			warn(host, "cannot set up timer: Invalid argument");
			return EX_OSERR;
		},
		_ if plan.nonblocking => Patience::Never,
		None => Patience::Forever,
		// A zero timeout is `-n`.
		Some(micros) if micros == 0.0 => Patience::Never,
		Some(micros) => Duration::try_from_secs_f64(micros / 1e6)
			.ok()
			.and_then(|timeout| Instant::now().checked_add(timeout))
			.map_or(Patience::Forever, Patience::Until),
	};

	let started = Instant::now();
	let mut reopened = false;
	loop {
		let error = match acquire(lock.file(), plan.operation, plan.api, patience).await {
			Ok(true) => break,
			Ok(false) => {
				if plan.verbose {
					warn(host, match patience {
						Patience::Until(_) => "timeout while waiting to get lock",
						Patience::Never | Patience::Forever => "failed to get lock",
					});
				}
				return i32::from(plan.conflict_status);
			},
			Err(error) => error,
		};
		// A filesystem whose `flock` is an `fcntl` lock underneath (NFSv4)
		// wants write access for an exclusive lock: open the file again.
		if let Target::Path(name) = plan.target
			&& !reopened && plan.operation != Operation::Shared
			&& sys::wants_write_access(&error)
			&& let Ok(file) = open_lock_file(host, name, Access::ReadWrite).await
		{
			lock = LockFile::Owned(file);
			reopened = true;
			continue;
		}
		warn(host, format_args!("{}: {}", plan.target, strip_errno(&error)));
		return if sys::out_of_locks(&error) || error.kind() == io::ErrorKind::OutOfMemory {
			EX_OSERR
		} else {
			EX_DATAERR
		};
	}
	if plan.verbose {
		let took = started.elapsed();
		let _ = writeln!(
			host.stdout_writer(),
			"flock: getting lock took {}.{:06} seconds",
			took.as_secs(),
			took.subsec_micros()
		);
	}

	let Some(command) = &plan.command else {
		return 0;
	};
	if plan.verbose {
		let _ = writeln!(host.stdout_writer(), "flock: executing {}", command_name(command, host));
	}
	let mut shell_command = match *command {
		Command::Argv(argv) => ShellCommand::new(argv.to_vec()),
		Command::Line(source) => ShellCommand::line(source),
	};
	if let Ok(stdin) = host.stdin.file().to_fd() {
		shell_command = shell_command.stdin(stdin);
	}
	let status = match host.run_command_async(shell_command).await {
		Ok(status) => status.code(),
		Err(error) if error.kind() == io::ErrorKind::Interrupted => 130,
		Err(error) => {
			let reason = match error.kind() {
				io::ErrorKind::NotFound => Cow::Borrowed("No such file or directory"),
				io::ErrorKind::PermissionDenied => Cow::Borrowed("Permission denied"),
				_ => Cow::Owned(strip_errno(&error)),
			};
			let name = command_name(command, host).into_owned();
			warn(host, format_args!("failed to execute {name}: {reason}"));
			if error.kind() == io::ErrorKind::OutOfMemory { EX_OSERR } else { EX_UNAVAILABLE }
		},
	};
	// The lock was held for as long as the command ran.
	drop(lock);
	status
}

/// The name util-linux reports for `command`: its first word, or for `-c`
/// the shell (`$SHELL`, else `/bin/sh`).
fn command_name<'a>(command: &Command<'a>, host: &'a Host) -> Cow<'a, str> {
	match *command {
		Command::Argv(argv) => argv.first().map_or(Cow::Borrowed(""), |name| name.to_string_lossy()),
		Command::Line(_) => {
			Cow::Borrowed(host.var("SHELL").filter(|shell| !shell.is_empty()).unwrap_or("/bin/sh"))
		},
	}
}

/// Opens the lock file `name` as util-linux does: created when missing
/// (mode 0666 less the umask), and a directory opened as it is. Only a host
/// file will do: nothing else can carry a lock.
///
/// The returned future owns what it needs, so it holds no borrow of `host`
/// while it waits.
fn open_lock_file(
	host: &Host,
	name: &OsStr,
	access: Access,
) -> impl Future<Output = io::Result<File>> + Send + use<> {
	let path = host.resolve(name);
	let fs = host.vfs();
	let options = sys::open_options(access, host.umask());
	async move {
		let opened = match fs.open_with(&path, &options).await {
			Err(error) => match sys::fallback_options(&error) {
				Some(fallback) => fs.open_with(&path, &fallback).await,
				None => Err(error),
			},
			opened => opened,
		};
		opened?
			.into_native()
			.map_err(|_| io::Error::new(io::ErrorKind::Unsupported, "Operation not supported"))
	}
}

/// util-linux's status for a lock file that could not be opened.
fn open_failure_status(error: &io::Error) -> i32 {
	if sys::out_of_descriptors(error) {
		return EX_OSERR;
	}
	match error.kind() {
		io::ErrorKind::OutOfMemory => EX_OSERR,
		io::ErrorKind::ReadOnlyFilesystem | io::ErrorKind::StorageFull => EX_CANTCREAT,
		_ => EX_NOINPUT,
	}
}

/// Applies `operation` to `file`, waiting for a conflicting lock as long as
/// `patience` allows. `Ok(false)`: the lock is still held elsewhere.
async fn acquire(
	file: &File,
	operation: Operation,
	api: Api,
	patience: Patience,
) -> io::Result<bool> {
	let mut retry = RETRY_FIRST;
	loop {
		if sys::try_lock(file, operation, api)? {
			return Ok(true);
		}
		let pause = match patience {
			Patience::Never => return Ok(false),
			Patience::Forever => retry,
			Patience::Until(deadline) => {
				let left = deadline.saturating_duration_since(Instant::now());
				if left.is_zero() {
					return Ok(false);
				}
				retry.min(left)
			},
		};
		tokio::time::sleep(pause).await;
		retry = (retry * 2).min(RETRY_MAX);
	}
}

/// `flock(2)` and open file description locks.
#[cfg(unix)]
mod sys {
	use std::{
		fs::{File, TryLockError},
		io,
	};

	use pi_vfs::OpenOptions;

	use super::{Access, Api, Operation, Range};

	/// Applies `operation` without waiting; `Ok(false)` when a conflicting
	/// lock is held.
	pub(super) fn try_lock(file: &File, operation: Operation, api: Api) -> io::Result<bool> {
		let range = match api {
			Api::Flock => return flock(file, operation),
			Api::Ofd(range) => range,
		};
		ofd(file, operation, range)
	}

	fn flock(file: &File, operation: Operation) -> io::Result<bool> {
		loop {
			let attempt = match operation {
				Operation::Exclusive => file.try_lock(),
				Operation::Shared => file.try_lock_shared(),
				Operation::Unlock => return file.unlock().map(|()| true),
			};
			match attempt {
				Ok(()) => return Ok(true),
				Err(TryLockError::WouldBlock) => return Ok(false),
				Err(TryLockError::Error(error)) => match error.raw_os_error() {
					Some(libc::EINTR) => {},
					// An `fcntl`-backed `flock` (NFS) reports a conflict this way.
					Some(libc::EACCES) => return Ok(false),
					_ => return Err(error),
				},
			}
		}
	}

	#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
	fn ofd(file: &File, operation: Operation, range: Range) -> io::Result<bool> {
		use std::os::fd::AsRawFd as _;

		let offset = |bytes: u64| {
			libc::off_t::try_from(bytes).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))
		};
		// SAFETY: an all-zero `flock` is valid; zero `l_whence` is `SEEK_SET`.
		let mut lock: libc::flock = unsafe { std::mem::zeroed() };
		// The lock types are `c_int` on Linux and `c_short` on Apple targets.
		lock.l_type = match operation {
			Operation::Shared => libc::F_RDLCK,
			Operation::Exclusive => libc::F_WRLCK,
			Operation::Unlock => libc::F_UNLCK,
		} as libc::c_short;
		lock.l_start = offset(range.start)?;
		lock.l_len = offset(range.length)?;
		loop {
			// SAFETY: `file` owns a live descriptor, and `lock` is a valid
			// `flock` the call only reads.
			if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_OFD_SETLK, &raw const lock) } == 0 {
				return Ok(true);
			}
			let error = io::Error::last_os_error();
			match error.raw_os_error() {
				Some(libc::EAGAIN | libc::EACCES) => return Ok(false),
				Some(libc::EINTR) => {},
				_ => return Err(error),
			}
		}
	}

	#[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
	fn ofd(_file: &File, _operation: Operation, _range: Range) -> io::Result<bool> {
		Err(io::Error::new(io::ErrorKind::Unsupported, "Operation not supported"))
	}

	/// `open(2)` flags for a lock file: `O_CREAT` with any access, read-only
	/// included, which `std`'s own `create` refuses.
	pub(super) fn open_options(access: Access, umask: u32) -> OpenOptions {
		let mut options = OpenOptions::new();
		options
			.read(!matches!(access, Access::Write))
			.write(!matches!(access, Access::Read))
			.mode(0o666 & !umask)
			.custom_flags(libc::O_CREAT | libc::O_NOCTTY);
		options
	}

	/// Linux refuses `O_CREAT` on a directory: open it read-only without.
	pub(super) fn fallback_options(error: &io::Error) -> Option<OpenOptions> {
		(error.kind() == io::ErrorKind::IsADirectory).then(|| {
			let mut options = OpenOptions::new();
			options.read(true).custom_flags(libc::O_NOCTTY);
			options
		})
	}

	/// Whether a failed lock is worth another try on a read-write descriptor.
	pub(super) fn wants_write_access(error: &io::Error) -> bool {
		matches!(error.raw_os_error(), Some(libc::EIO | libc::EBADF))
	}

	pub(super) fn out_of_locks(error: &io::Error) -> bool {
		error.raw_os_error() == Some(libc::ENOLCK)
	}

	pub(super) fn out_of_descriptors(error: &io::Error) -> bool {
		matches!(error.raw_os_error(), Some(libc::EMFILE | libc::ENFILE))
	}
}

/// `LockFileEx` with `flock(2)` semantics.
///
/// A Windows byte-range lock is mandatory: nobody else reads or writes the
/// locked bytes. `flock` locks are advisory (`flock script.sh script.sh`
/// must still read its script), so the default lock covers one byte no file
/// reaches, [`FLOCK_BYTE`], which every whole-file lock of other programs
/// covers too. `--fcntl` locks the range it is given, the whole file by
/// default, as those programs do.
///
/// The lock belongs to the open file (shared by duplicated handles), as on
/// Unix. Windows stacks locks one handle takes on the same bytes instead of
/// converting them, so the range is unlocked before every attempt: asking
/// again converts the lock, as `flock(2)` does.
#[cfg(windows)]
mod sys {
	use std::{fs::File, io, os::windows::io::AsRawHandle as _};

	use pi_vfs::OpenOptions;
	use windows_sys::Win32::{
		Foundation::{ERROR_IO_PENDING, ERROR_LOCK_VIOLATION, ERROR_NOT_LOCKED},
		Storage::FileSystem::{
			FILE_FLAG_BACKUP_SEMANTICS, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx,
			UnlockFileEx,
		},
		System::IO::OVERLAPPED,
	};

	use super::{Access, Api, Operation};

	/// The byte a `flock`-style lock covers: the last one of a whole-file
	/// lock that ends at `i64::MAX`, far beyond any file's data.
	const FLOCK_BYTE: u64 = i64::MAX as u64 - 1;

	/// An `OVERLAPPED` naming the byte `offset`.
	fn region(offset: u64) -> OVERLAPPED {
		let mut region = OVERLAPPED::default();
		region.Anonymous.Anonymous.Offset = offset as u32;
		region.Anonymous.Anonymous.OffsetHigh = (offset >> 32) as u32;
		region
	}

	/// Applies `operation` without waiting; `Ok(false)` when a conflicting
	/// lock is held.
	pub(super) fn try_lock(file: &File, operation: Operation, api: Api) -> io::Result<bool> {
		let (offset, length) = match api {
			Api::Flock => (FLOCK_BYTE, 1),
			Api::Ofd(range) if range.length == 0 => (range.start, u64::MAX - range.start),
			Api::Ofd(range) => (range.start, range.length),
		};
		let (low, high) = (length as u32, (length >> 32) as u32);
		let handle = file.as_raw_handle();
		let mut unlocked = region(offset);
		// SAFETY: `file` owns a live handle, and `unlocked` outlives the
		// synchronous call.
		if unsafe { UnlockFileEx(handle, 0, low, high, &raw mut unlocked) } == 0 {
			let error = io::Error::last_os_error();
			if error.raw_os_error() != Some(ERROR_NOT_LOCKED as i32) {
				return Err(error);
			}
		}
		let flags = match operation {
			Operation::Unlock => return Ok(true),
			Operation::Shared => LOCKFILE_FAIL_IMMEDIATELY,
			Operation::Exclusive => LOCKFILE_FAIL_IMMEDIATELY | LOCKFILE_EXCLUSIVE_LOCK,
		};
		let mut locked = region(offset);
		// SAFETY: as above; with `LOCKFILE_FAIL_IMMEDIATELY` the call never
		// leaves a request pending on `locked`.
		if unsafe { LockFileEx(handle, flags, 0, low, high, &raw mut locked) } != 0 {
			return Ok(true);
		}
		let error = io::Error::last_os_error();
		match error.raw_os_error().map(i32::cast_unsigned) {
			Some(ERROR_LOCK_VIOLATION | ERROR_IO_PENDING) => Ok(false),
			_ => Err(error),
		}
	}

	/// Read-write, created when missing: a lock needs read or write access.
	pub(super) fn open_options(_access: Access, _umask: u32) -> OpenOptions {
		let mut options = OpenOptions::new();
		options.read(true).write(true).create(true);
		options
	}

	/// A read-only file or a directory refuses write access: open it for
	/// reading (a directory handle needs backup semantics).
	pub(super) fn fallback_options(error: &io::Error) -> Option<OpenOptions> {
		(error.kind() == io::ErrorKind::PermissionDenied).then(|| {
			let mut options = OpenOptions::new();
			options
				.read(true)
				.custom_flags(FILE_FLAG_BACKUP_SEMANTICS as i32);
			options
		})
	}

	pub(super) const fn wants_write_access(_error: &io::Error) -> bool {
		false
	}

	pub(super) const fn out_of_locks(_error: &io::Error) -> bool {
		false
	}

	pub(super) const fn out_of_descriptors(_error: &io::Error) -> bool {
		false
	}
}

#[cfg(test)]
mod tests {
	use std::{
		collections::HashMap,
		fs::File,
		io::{Read as _, Seek as _},
		path::Path,
		time::{Duration, Instant},
	};

	use tokio_util::sync::CancellationToken;

	use super::*;
	use crate::extras::{Fd, Invocation};

	/// Longest any single `flock` of these tests may take.
	const LIMIT: Duration = Duration::from_secs(20);

	fn words(args: &[&str]) -> Vec<OsString> {
		args.iter().map(OsString::from).collect()
	}

	/// The plan of `flock ARGS`.
	fn plan_of(words: &[OsString]) -> Plan<'_> {
		match parse(words) {
			Ok(Parsed::Run(plan)) => plan,
			other => panic!("no plan: {other:?}"),
		}
	}

	/// The usage error of `flock ARGS`: its message, and whether the help
	/// pointer follows.
	fn usage_error(args: &[&str]) -> (String, bool) {
		match parse(&words(args)) {
			Err(error) => (error.message, error.try_help),
			Ok(parsed) => panic!("parsed: {parsed:?}"),
		}
	}

	/// What a `flock` run left behind.
	struct Outcome {
		code: i32,
		out:  String,
		err:  String,
	}

	/// Runs `flock ARGS` in `cwd` as the shell would, with `fds` as its
	/// further open descriptors and its commands served by the test runner.
	async fn flock_with(
		args: &[&str],
		cwd: &Path,
		fds: Vec<(i32, Fd)>,
		cancel: Option<CancellationToken>,
	) -> Outcome {
		let output = tempfile::tempfile().expect("stdout file");
		let error = tempfile::tempfile().expect("stderr file");
		let env: HashMap<String, String> = std::env::vars().collect();
		let mut invocation = Invocation::new(
			std::iter::once("flock").chain(args.iter().copied()).map(str::to_owned).collect(),
			cwd.to_path_buf(),
			pi_vfs::Fs::native(),
		);
		invocation.commands = Some(Box::new(crate::host::TestRunner::new(
			env.clone(),
			cwd.to_path_buf(),
			output.try_clone().expect("stdout"),
			error.try_clone().expect("stderr"),
		)));
		invocation.env = env;
		invocation.stdio = [
			Fd::File(File::open(if cfg!(windows) { "NUL" } else { "/dev/null" }).expect("null device")),
			Fd::File(output.try_clone().expect("stdout")),
			Fd::File(error.try_clone().expect("stderr")),
		];
		invocation.fds = fds;
		invocation.cancel = cancel;
		let code = tokio::time::timeout(LIMIT, crate::extras::run(invocation))
			.await
			.expect("flock ended in time");
		let read = |mut file: File| {
			let mut text = String::new();
			file.rewind().expect("rewind capture");
			file.read_to_string(&mut text).expect("read capture");
			text
		};
		Outcome { code, out: read(output), err: read(error) }
	}

	async fn flock(args: &[&str], cwd: &Path) -> Outcome {
		flock_with(args, cwd, Vec::new(), None).await
	}

	/// A second open file description of `dir/lock`, as another process
	/// would hold.
	fn other_handle(dir: &Path) -> File {
		File::options()
			.read(true)
			.write(true)
			.create(true)
			.truncate(false)
			.open(dir.join("lock"))
			.expect("lock file")
	}

	/// Whether an exclusive `flock`-style lock on `file`'s file is free:
	/// takes and drops one through `file`.
	fn free(file: &File) -> bool {
		match sys::try_lock(file, Operation::Exclusive, Api::Flock) {
			Ok(free) => {
				if free {
					sys::try_lock(file, Operation::Unlock, Api::Flock).expect("unlock");
				}
				free
			},
			Err(error) => panic!("probe: {error}"),
		}
	}

	fn hold(file: &File, operation: Operation) {
		assert!(sys::try_lock(file, operation, Api::Flock).expect("lock"), "lock was free");
	}

	#[test]
	fn options_stop_at_the_first_operand() {
		let args = words(&["-n", "-E", "9", "lock", "cmd", "-s", "--verbose"]);
		let plan = plan_of(&args);
		assert_eq!(plan.operation, Operation::Exclusive);
		assert!(plan.nonblocking && !plan.verbose);
		assert_eq!(plan.conflict_status, 9);
		assert_eq!(plan.target, Target::Path(OsStr::new("lock")));
		assert_eq!(plan.command, Some(Command::Argv(&args[4..])));
	}

	#[test]
	fn options_spell_as_getopt_long_reads_them() {
		let cases: &[(&[&str], Operation, bool, Option<f64>)] = &[
			(&["-sn", "3"], Operation::Shared, true, None),
			(&["-xw5", "3"], Operation::Exclusive, false, Some(5.0)),
			(&["-e", "-w", ".25", "3"], Operation::Exclusive, false, Some(0.25)),
			(&["--shared", "--nb", "3"], Operation::Shared, true, None),
			(&["--nonblock", "--timeout=1.5", "3"], Operation::Exclusive, true, Some(1.5)),
			(&["--wait", "2", "--excl", "3"], Operation::Exclusive, false, Some(2.0)),
			(&["-u", "--", "3"], Operation::Unlock, false, None),
			(&["-o", "--unl", "3"], Operation::Unlock, false, None),
		];
		for &(args, operation, nonblocking, timeout) in cases {
			let args = words(args);
			let plan = plan_of(&args);
			assert_eq!(
				(plan.operation, plan.nonblocking, plan.timeout, &plan.target),
				(operation, nonblocking, timeout, &Target::Descriptor(3)),
				"{args:?}"
			);
			assert_eq!(plan.command, None);
		}
	}

	#[test]
	fn command_forms() {
		let args = words(&["lock", "-c", "echo a; echo b"]);
		assert_eq!(plan_of(&args).command, Some(Command::Line(OsStr::new("echo a; echo b"))));
		let args = words(&["lock", "--command", "true"]);
		assert_eq!(plan_of(&args).command, Some(Command::Line(OsStr::new("true"))));
		let args = words(&["--fd", "7", "-c", "true"]);
		let plan = plan_of(&args);
		assert_eq!(plan.target, Target::Descriptor(7));
		assert_eq!(plan.command, Some(Command::Line(OsStr::new("true"))));
		let args = words(&["--fd=7", "make", "-j4"]);
		let plan = plan_of(&args);
		assert_eq!(plan.target, Target::Descriptor(7));
		assert_eq!(plan.command, Some(Command::Argv(&args[1..])));
		// The separator agents put before the command is not the command.
		let args = words(&["lock", "--", "bash", "-lc", "true"]);
		assert_eq!(plan_of(&args).command, Some(Command::Argv(&args[2..])));
		// A file named like a number is still a file once a command follows.
		let args = words(&["9", "true"]);
		assert_eq!(plan_of(&args).target, Target::Path(OsStr::new("9")));
	}

	#[test]
	fn fcntl_ranges() {
		let args = words(&["--fcntl", "3"]);
		assert_eq!(plan_of(&args).api, Api::Ofd(Range::default()));
		let args = words(&["--start", "1K", "--length=0x10", "3"]);
		assert_eq!(plan_of(&args).api, Api::Ofd(Range { start: 1024, length: 16 }));
		assert_eq!(parse_size("2MB"), Ok(2_000_000));
		assert_eq!(parse_size("0.5MiB"), Ok(524_288));
		assert_eq!(parse_size("010"), Ok(8));
		assert_eq!(parse_size("0"), Ok(0));
		assert_eq!(parse_size("1Q"), Err(NumberError::Invalid));
		assert_eq!(parse_size("-1"), Err(NumberError::Invalid));
		assert_eq!(parse_size("99999Y"), Err(NumberError::Range));
	}

	#[test]
	fn help_and_version_act_where_they_stand() {
		assert_eq!(parse(&words(&["-n", "-h", "--bogus"])), Ok(Parsed::Help));
		assert_eq!(parse(&words(&["--version"])), Ok(Parsed::Version));
		assert_eq!(parse(&words(&["--help"])), Ok(Parsed::Help));
	}

	#[test]
	fn usage_errors_read_like_util_linux() {
		let help = true;
		let cases: &[(&[&str], &str, bool)] = &[
			(&[], "not enough arguments", help),
			(&["--bogus", "3"], "unrecognized option '--bogus'", help),
			(&["-q", "3"], "unrecognized option '-q'", help),
			(&["--n", "3"], "unrecognized option '--n'", help),
			(&["--shared=1", "3"], "unrecognized option '--shared=1'", help),
			(&["-w"], "option '-w' requires an argument", help),
			(&["--timeout"], "option '--timeout' requires an argument", help),
			(&["-w", "soon", "3"], "invalid timeout: 'soon'", !help),
			(&["-E", "x", "3"], "invalid exit code (allowed values: 0-255): 'x'", !help),
			(
				&["-E", "256", "3"],
				"invalid exit code (allowed values: 0-255): '256': Numerical result out of range",
				!help,
			),
			(&["--start", "x", "3"], "invalid as start offset: 'x': Invalid argument", !help),
			(&["-o", "-F", "3"], "the --no-fork and --close options are incompatible", !help),
			(&["-n"], "missing file descriptor, file or directory", !help),
			(&["--fd", "3"], "missing command", !help),
			(&["-c", "true"], "missing file descriptor, file or directory", !help),
			(&["-1"], "unrecognized option '-1'", help),
			(&["--", "-1"], "missing file descriptor, file or directory", !help),
			(&["lockfile"], "invalid file descriptor: 'lockfile'", !help),
			(
				&["99999999999"],
				"invalid file descriptor: '99999999999': Numerical result out of range",
				!help,
			),
			(&["lock", "-c"], "-c requires exactly one command argument", !help),
			(&["lock", "-c", "a", "b"], "-c requires exactly one command argument", !help),
			(&["--fd", "3", "--command"], "--command requires exactly one command argument", !help),
		];
		for &(args, message, try_help) in cases {
			assert_eq!(usage_error(args), (message.to_owned(), try_help), "{args:?}");
		}
	}

	#[tokio::test]
	async fn usage_error_exits_64_with_the_help_pointer() {
		let dir = tempfile::tempdir().expect("tempdir");
		let run = flock(&["--bogus", "lock", "true"], dir.path()).await;
		assert_eq!(run.code, 64);
		assert_eq!(
			run.err,
			"flock: unrecognized option '--bogus'\nTry 'flock --help' for more information.\n"
		);
		assert_eq!(run.out, "");
		assert!(!dir.path().join("lock").exists());
	}

	#[tokio::test]
	async fn help_and_version_print_to_stdout() {
		let dir = tempfile::tempdir().expect("tempdir");
		let run = flock(&["--help"], dir.path()).await;
		assert_eq!((run.code, run.out.as_str(), run.err.as_str()), (0, USAGE, ""));
		let run = flock(&["-V"], dir.path()).await;
		assert_eq!((run.code, run.out.as_str()), (0, "flock from util-linux 2.42.4\n"));
	}

	/// Contract: the lock file is created, held while the command runs, and
	/// free again afterwards; the command's status is `flock`'s.
	#[tokio::test]
	async fn command_runs_under_the_lock_and_its_status_propagates() {
		let dir = tempfile::tempdir().expect("tempdir");
		let run = flock(&["lock", "echo", "held"], dir.path()).await;
		assert_eq!((run.code, run.out.as_str(), run.err.as_str()), (0, "held\n", ""));
		assert!(free(&other_handle(dir.path())), "the lock outlived the command");
		assert_eq!(flock(&["lock", "false"], dir.path()).await.code, 1);
		// The command sees the lock held: a nested attempt conflicts.
		let run = flock(&["lock", "flock", "-n", "-E", "42", "lock", "true"], dir.path()).await;
		assert_eq!(run.code, 42);
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn command_string_and_signal_statuses_propagate() {
		let dir = tempfile::tempdir().expect("tempdir");
		assert_eq!(flock(&["lock", "-c", "exit 7"], dir.path()).await.code, 7);
		assert_eq!(flock(&["lock", "sh", "-c", "exit 3"], dir.path()).await.code, 3);
		assert_eq!(flock(&["lock", "sh", "-c", "kill -TERM $$"], dir.path()).await.code, 128 + 15);
	}

	#[tokio::test]
	async fn missing_command_exits_69() {
		let dir = tempfile::tempdir().expect("tempdir");
		let run = flock(&["lock", "no-such-command-flock-test"], dir.path()).await;
		assert_eq!(run.code, 69);
		assert_eq!(
			run.err,
			"flock: failed to execute no-such-command-flock-test: No such file or directory\n"
		);
		assert!(free(&other_handle(dir.path())));
	}

	#[tokio::test]
	async fn unopenable_lock_file_exits_66() {
		let dir = tempfile::tempdir().expect("tempdir");
		let run = flock(&["missing-dir/lock", "true"], dir.path()).await;
		assert_eq!(run.code, 66);
		assert_eq!(
			run.err,
			"flock: cannot open lock file missing-dir/lock: No such file or directory\n"
		);
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn a_directory_is_locked_as_it_is() {
		let dir = tempfile::tempdir().expect("tempdir");
		let holder = File::open(dir.path()).expect("open directory");
		assert_eq!(flock(&[".", "true"], dir.path()).await.code, 0);
		hold(&holder, Operation::Exclusive);
		assert_eq!(flock(&["-n", ".", "true"], dir.path()).await.code, 1);
	}

	/// Contract: `-n` fails at once on a conflict, with status 1 or `-E`'s;
	/// shared locks coexist, a shared and an exclusive one do not.
	#[tokio::test]
	async fn nonblocking_conflicts_exit_with_the_conflict_status() {
		let dir = tempfile::tempdir().expect("tempdir");
		let holder = other_handle(dir.path());
		hold(&holder, Operation::Exclusive);
		let run = flock(&["-n", "lock", "echo", "ran"], dir.path()).await;
		assert_eq!((run.code, run.out.as_str(), run.err.as_str()), (1, "", ""));
		assert_eq!(flock(&["-n", "-E", "75", "lock", "true"], dir.path()).await.code, 75);
		assert_eq!(flock(&["-E", "0", "--nb", "lock", "false"], dir.path()).await.code, 0);
		assert_eq!(flock(&["-s", "-n", "lock", "true"], dir.path()).await.code, 1);
		let run = flock(&["--verbose", "-n", "lock", "true"], dir.path()).await;
		assert_eq!((run.code, run.out.as_str(), run.err.as_str()), (1, "", "flock: failed to get lock\n"));

		hold(&holder, Operation::Shared);
		assert_eq!(flock(&["-s", "-n", "lock", "true"], dir.path()).await.code, 0);
		assert_eq!(flock(&["-x", "-n", "lock", "true"], dir.path()).await.code, 1);
	}

	/// Contract: `-w` gives up at its deadline with the conflict status, and
	/// `-w 0` is `-n`.
	#[tokio::test]
	async fn timeout_gives_up_at_the_deadline() {
		let dir = tempfile::tempdir().expect("tempdir");
		let holder = other_handle(dir.path());
		hold(&holder, Operation::Exclusive);
		let started = Instant::now();
		let run = flock(&["--verbose", "-w", "0.2", "-E", "5", "lock", "true"], dir.path()).await;
		let waited = started.elapsed();
		assert_eq!(
			(run.code, run.err.as_str()),
			(5, "flock: timeout while waiting to get lock\n")
		);
		assert!(waited >= Duration::from_millis(200), "gave up after {waited:?}");
		let run = flock(&["--verbose", "-w", "0", "lock", "true"], dir.path()).await;
		assert_eq!((run.code, run.err.as_str()), (1, "flock: failed to get lock\n"));
		let run = flock(&["-w", "-1", "lock", "true"], dir.path()).await;
		assert_eq!((run.code, run.err.as_str()), (71, "flock: cannot set up timer: Invalid argument\n"));
	}

	/// Contract: a waiting `flock` gets the lock once its holder lets go.
	#[tokio::test]
	async fn waiting_ends_when_the_lock_is_released() {
		let dir = tempfile::tempdir().expect("tempdir");
		let holder = other_handle(dir.path());
		hold(&holder, Operation::Exclusive);
		let release = tokio::spawn(async move {
			tokio::time::sleep(Duration::from_millis(150)).await;
			drop(holder);
		});
		let started = Instant::now();
		let run = flock(&["--verbose", "-w", "15", "lock", "echo", "ran"], dir.path()).await;
		let waited = started.elapsed();
		release.await.expect("release");
		assert_eq!((run.code, run.err.as_str()), (0, ""));
		assert!(waited >= Duration::from_millis(150), "locked after {waited:?}");
		let mut lines = run.out.lines();
		let took = lines.next().expect("timing line");
		let seconds: f64 = took
			.strip_prefix("flock: getting lock took ")
			.and_then(|rest| rest.strip_suffix(" seconds"))
			.and_then(|seconds| seconds.parse().ok())
			.unwrap_or_else(|| panic!("timing line: {took:?}"));
		assert!((0.1..15.0).contains(&seconds), "{took}");
		assert_eq!(lines.collect::<Vec<_>>(), ["flock: executing echo", "ran"]);
	}

	/// Contract: two `flock`s on one file never run their commands at the
	/// same time, and both do run.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn concurrent_exclusive_invocations_take_turns() {
		let dir = tempfile::tempdir().expect("tempdir");
		// Each command fails if the other is inside, and leaves its mark.
		let critical = "mkdir busy || exit 9; sleep 0.2; rmdir busy; echo x >> ran";
		let (argv, line) = (["lock", "sh", "-c", critical], ["lock", "-c", critical]);
		let (first, second) =
			tokio::join!(flock(&argv, dir.path()), flock(&line, dir.path()));
		assert_eq!((first.code, second.code), (0, 0), "{} {}", first.err, second.err);
		assert_eq!(std::fs::read_to_string(dir.path().join("ran")).expect("marks"), "x\nx\n");
	}

	/// Contract: shared holders run together, and an exclusive one waits for
	/// all of them.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn concurrent_shared_invocations_overlap() {
		let dir = tempfile::tempdir().expect("tempdir");
		// Each reader waits (up to 5 s) to see the other inside.
		let reader = |me: &str, other: &str| {
			format!(
				"touch {me}; n=0; until [ -e {other} ]; do n=$((n+1)); [ $n -gt 500 ] && exit 9; \
				 sleep 0.01; done; sleep 0.1; echo r >> order"
			)
		};
		let (a, b) = (reader("a", "b"), reader("b", "a"));
		// The writer arrives once both readers are inside.
		let writer = async {
			while !(dir.path().join("a").exists() && dir.path().join("b").exists()) {
				tokio::time::sleep(Duration::from_millis(5)).await;
			}
			flock(&["-x", "lock", "-c", "echo w >> order"], dir.path()).await
		};
		let (first, second) = (["-s", "lock", "-c", &a], ["--shared", "lock", "-c", &b]);
		let (first, second, third) = tokio::join!(
			flock(&first, dir.path()),
			flock(&second, dir.path()),
			tokio::time::timeout(LIMIT, writer),
		);
		let third = third.expect("readers got inside");
		assert_eq!((first.code, second.code, third.code), (0, 0, 0));
		assert_eq!(std::fs::read_to_string(dir.path().join("order")).expect("order"), "r\nr\nw\n");
	}

	/// Contract: the descriptor form locks the shell's own open file, which
	/// keeps the lock after `flock` returns; `-u` drops it.
	#[tokio::test]
	async fn descriptor_form_locks_the_shells_open_file() {
		let dir = tempfile::tempdir().expect("tempdir");
		let shell_fd = other_handle(dir.path());
		let other = other_handle(dir.path());
		let fds = || vec![(9, Fd::File(shell_fd.try_clone().expect("dup")))];

		let run = flock_with(&["-n", "9"], dir.path(), fds(), None).await;
		assert_eq!((run.code, run.out.as_str(), run.err.as_str()), (0, "", ""));
		assert!(!free(&other), "the lock went away with flock");
		// Asking again through the same open file is no conflict.
		assert_eq!(flock_with(&["-n", "-s", "9"], dir.path(), fds(), None).await.code, 0);
		assert_eq!(flock(&["-n", "lock", "true"], dir.path()).await.code, 1);
		assert_eq!(flock(&["-n", "-s", "lock", "true"], dir.path()).await.code, 0);

		assert_eq!(flock_with(&["-u", "9"], dir.path(), fds(), None).await.code, 0);
		assert!(free(&other), "-u left the lock");

		// `--fd` wraps a command, and the shell's file keeps the lock.
		let run = flock_with(&["--fd", "9", "echo", "in"], dir.path(), fds(), None).await;
		assert_eq!((run.code, run.out.as_str()), (0, "in\n"));
		assert!(!free(&other));
		drop(shell_fd);
		assert!(free(&other), "closing the file left the lock");
	}

	#[tokio::test]
	async fn descriptor_form_waits_and_conflicts_like_the_file_form() {
		let dir = tempfile::tempdir().expect("tempdir");
		let shell_fd = other_handle(dir.path());
		let other = other_handle(dir.path());
		hold(&other, Operation::Exclusive);
		let fds = || vec![(3, Fd::File(shell_fd.try_clone().expect("dup")))];
		assert_eq!(flock_with(&["-n", "-E", "8", "3"], dir.path(), fds(), None).await.code, 8);
		assert_eq!(flock_with(&["-w", "0.05", "3"], dir.path(), fds(), None).await.code, 1);
		let release = tokio::spawn(async move {
			tokio::time::sleep(Duration::from_millis(100)).await;
			drop(other);
		});
		assert_eq!(flock_with(&["3"], dir.path(), fds(), None).await.code, 0);
		release.await.expect("release");
		assert!(!free(&other_handle(dir.path())));
	}

	#[tokio::test]
	async fn closed_descriptor_exits_65() {
		let dir = tempfile::tempdir().expect("tempdir");
		let run = flock(&["9"], dir.path()).await;
		assert_eq!((run.code, run.err.as_str()), (65, "flock: 9: Bad file descriptor\n"));
	}

	/// Contract: cancelling a waiting `flock` ends it with status 130,
	/// without the lock and without running the command.
	#[tokio::test]
	async fn cancellation_ends_the_wait() {
		let dir = tempfile::tempdir().expect("tempdir");
		let holder = other_handle(dir.path());
		hold(&holder, Operation::Exclusive);
		let cancel = CancellationToken::new();
		let trigger = cancel.clone();
		let canceller = tokio::spawn(async move {
			tokio::time::sleep(Duration::from_millis(100)).await;
			trigger.cancel();
		});
		let started = Instant::now();
		let run = flock_with(&["lock", "echo", "ran"], dir.path(), Vec::new(), Some(cancel)).await;
		canceller.await.expect("canceller");
		assert_eq!((run.code, run.out.as_str()), (130, ""));
		assert!(started.elapsed() < Duration::from_secs(10));
		drop(holder);
		assert!(free(&other_handle(dir.path())), "the cancelled flock took the lock");
	}

	/// Contract: `--fcntl` takes an open file description lock: exclusive
	/// against other open files, re-entrant through the same one.
	#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple", windows))]
	#[tokio::test]
	async fn fcntl_locks_conflict_between_open_files() {
		let dir = tempfile::tempdir().expect("tempdir");
		let shell_fd = other_handle(dir.path());
		let fds = || vec![(9, Fd::File(shell_fd.try_clone().expect("dup")))];
		assert_eq!(flock_with(&["--fcntl", "-n", "9"], dir.path(), fds(), None).await.code, 0);
		assert_eq!(flock_with(&["--fcntl", "-n", "9"], dir.path(), fds(), None).await.code, 0);
		assert_eq!(flock(&["--fcntl", "-n", "lock", "true"], dir.path()).await.code, 1);
		assert_eq!(flock(&["--fcntl", "-s", "-n", "lock", "true"], dir.path()).await.code, 1);
		assert_eq!(flock_with(&["--fcntl", "-u", "9"], dir.path(), fds(), None).await.code, 0);
		assert_eq!(flock(&["--fcntl", "-n", "lock", "true"], dir.path()).await.code, 0);

		// Bytes outside a locked range are free.
		assert_eq!(flock_with(&["--length", "10", "9"], dir.path(), fds(), None).await.code, 0);
		assert_eq!(flock(&["--start", "10", "-n", "lock", "true"], dir.path()).await.code, 0);
		assert_eq!(flock(&["--start", "5", "-n", "lock", "true"], dir.path()).await.code, 1);
		assert_eq!(
			flock_with(&["-u", "--length", "10", "9"], dir.path(), fds(), None).await.code,
			0
		);
		assert_eq!(flock(&["--start", "5", "-n", "lock", "true"], dir.path()).await.code, 0);
	}

	/// The probes the other tests rely on: a second open file sees a held
	/// lock, and shared locks coexist.
	#[test]
	fn locks_belong_to_the_open_file() {
		let dir = tempfile::tempdir().expect("tempdir");
		let (a, b) = (other_handle(dir.path()), other_handle(dir.path()));
		hold(&a, Operation::Exclusive);
		assert!(!free(&b));
		assert!(!sys::try_lock(&b, Operation::Shared, Api::Flock).expect("shared"));
		hold(&a, Operation::Shared);
		assert!(sys::try_lock(&b, Operation::Shared, Api::Flock).expect("shared"));
		// A duplicate is the same open file: no conflict with itself.
		hold(&a.try_clone().expect("dup"), Operation::Shared);
		drop(a);
		hold(&b, Operation::Exclusive);
	}
}
