//! `strings` builtin: print the runs of printable characters in files.
//!
//! Matches the output of GNU binutils `strings` (2.46) with whole-file
//! scanning, the default since 2.26; llvm-strings served as an additional
//! behavioral reference. No object-format parsing is done, so `-d`/`--data`
//! scans the whole file like `-a`/`--all`, and `-T`/`--target` is accepted and
//! ignored. Input is streamed through one reusable buffer.
//!
//! Supported flags: `-a`/`--all`, `-d`/`--data`, `-f`/`--print-file-name`,
//! `-n N`/`--bytes=N`/`-N` (minimum length, default 4, parsed like
//! `strtoul(…, 0)`), `-t {o,d,x}`/`--radix=` and `-o` (offset as `%7o `,
//! `%7d `, `%7x `), `-e {s,S,b,l,B,L}`/`--encoding=`, `-w`/
//! `--include-all-whitespace`, `-s SEP`/`--output-separator=SEP`,
//! `-U {d,l,i,x,e,h}`/`--unicode=`, `-T`/`--target`, `-h`/`-H`/`--help`,
//! `-v`/`-V`/`--version`. Operands are files; `-` or no operand reads
//! standard input (`{standard input}` under `-f`).
//!
//! A run of a multi-byte encoding (`-e b/l/B/L`) is aligned to its first
//! character; after a non-printable character the scan resumes one byte past
//! that character's start, as GNU's `unget_part_char` does. `-U locale` prints
//! each UTF-8 character whole (GNU 2.46 prints only its first byte, binutils
//! bug 34902); every other `-U` mode reproduces GNU's output, offsets included.

use std::{
	ffi::{OsStr, OsString},
	io::{self, Read, Write},
	sync::atomic::{AtomicBool, Ordering},
};

use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};

use crate::host::{
	Host, SIGPIPE_EXIT_CODE, Utility, format_usage, matches_parser, os_bytes_lossy, strip_errno,
};

const ALL: &str = "all";
const DATA: &str = "data";
const FILE_NAME: &str = "print-file-name";
const HELP: &str = "help";
const BYTES: &str = "bytes";
const WHITESPACE: &str = "include-all-whitespace";
const RADIX: &str = "radix";
const TARGET: &str = "target";
const ENCODING: &str = "encoding";
const SEPARATOR: &str = "output-separator";
const UNICODE: &str = "unicode";
const VERSION: &str = "version";
const FILES: &str = "files";

const CHUNK_SIZE: usize = 64 * 1024;
const STDIN_NAME: &[u8] = b"{standard input}";

/// GNU's short options: letter, the long option it is rewritten to, and
/// whether it takes a value. `-o` and the digit options are handled apart.
const SHORT_OPTIONS: &[(char, &str, bool)] = &[
	('a', ALL, false),
	('d', DATA, false),
	('f', FILE_NAME, false),
	('h', HELP, false),
	('H', HELP, false),
	('n', BYTES, true),
	('w', WHITESPACE, false),
	('t', RADIX, true),
	('e', ENCODING, true),
	('T', TARGET, true),
	('s', SEPARATOR, true),
	('U', UNICODE, true),
	('v', VERSION, false),
	('V', VERSION, false),
];

/// GNU's long options and whether each takes a value.
const LONG_OPTIONS: &[(&str, bool)] = &[
	(ALL, false),
	(BYTES, true),
	(DATA, false),
	(ENCODING, true),
	(HELP, false),
	(WHITESPACE, false),
	(SEPARATOR, true),
	(FILE_NAME, false),
	(RADIX, true),
	(TARGET, true),
	(UNICODE, true),
	(VERSION, false),
];

const USAGE: &str = "Usage: strings [option(s)] [file(s)]
 Display printable strings in [file(s)] (stdin by default)
 The options are:
  -a - --all                Scan the entire file, not just the data section [default]
  -d --data                 Only scan the data sections in the file
  -f --print-file-name      Print the name of the file before each string
  -n <number>               Locate & print any sequence of at least <number>
    --bytes=<number>         displayable characters.  (The default is 4).
  -t --radix={o,d,x}        Print the location of the string in base 8, 10 or 16
  -w --include-all-whitespace Include all whitespace as valid string characters
  -o                        An alias for --radix=o
  -T --target=<BFDNAME>     Specify the binary file format
  -e --encoding={s,S,b,l,B,L} Select character size and endianness:
                            s = 7-bit, S = 8-bit, {b,l} = 16-bit, {B,L} = 32-bit
  --unicode={default|locale|invalid|hex|escape|highlight}
  -U {d|l|i|x|e|h}          Specify how to treat UTF-8 encoded unicode characters
  -s --output-separator=<string> String used to separate strings in output.
  -h --help                 Display this information
  -v -V --version           Print the program's version number
";

/// Parsed `strings` invocation.
pub(crate) struct Strings {
	matches: ArgMatches,
}

matches_parser!(Strings, command);

impl Utility for Strings {
	const NAME: &'static str = "strings";

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		Ok(normalize_argv(argv))
	}

	fn run(self, host: &mut Host) -> i32 {
		let config = match Config::from_matches(&self.matches) {
			Ok(config) => config,
			Err(Exit::Help) => {
				let _ = host.stdout.write_all(USAGE.as_bytes());
				return 0;
			},
			Err(Exit::Usage) => {
				let _ = host.stderr.write_all(USAGE.as_bytes());
				host.fail(1);
				return 1;
			},
			Err(Exit::Fatal(message)) => {
				host.error(message, 1);
				return 1;
			},
		};
		let files: Vec<OsString> = self
			.matches
			.get_many::<OsString>(FILES)
			.map_or_else(|| vec![OsString::from("-")], |files| files.cloned().collect());

		let mut out = host.stdout_writer();
		let mut scanner = Scanner {
			config,
			highlight: out.is_terminal(),
			buf: vec![0; CHUNK_SIZE],
			run: Vec::new(),
			putback: Vec::with_capacity(4),
		};
		let cancel = host.cancel_flag();
		for name in &files {
			if host.is_cancelled() {
				return 130;
			}
			let result = if name == "-" {
				scanner.scan(&mut host.stdin, &mut out, STDIN_NAME, &cancel)
			} else {
				let display = name.to_string_lossy();
				let path = host.resolve(name);
				match host.fs().metadata(&path) {
					Err(err) if pi_vfs::is_cancelled(&err) => return 130,
					Err(err) if err.kind() == io::ErrorKind::NotFound => {
						host.error(format!("'{display}': No such file"), 1);
						continue;
					},
					Err(err) => {
						host.error(
							format!("Warning: could not locate '{display}'.  reason: {}", strip_errno(&err)),
							1,
						);
						continue;
					},
					Ok(metadata) if metadata.is_dir() => {
						host.error(format!("Warning: '{display}' is a directory"), 1);
						continue;
					},
					Ok(_) => {},
				}
				match host.fs().open(&path) {
					Ok(mut file) => scanner.scan(&mut file, &mut out, &os_bytes_lossy(name), &cancel),
					Err(err) => Err(ScanError::Read(err)),
				}
			};
			match result {
				Ok(()) => {},
				Err(ScanError::Cancelled) => return 130,
				Err(ScanError::Read(err)) if pi_vfs::is_cancelled(&err) => return 130,
				Err(ScanError::Read(err)) => {
					let display = if name == "-" {
						String::from_utf8_lossy(STDIN_NAME).into_owned()
					} else {
						name.to_string_lossy().into_owned()
					};
					host.error(format!("{display}: {}", strip_errno(&err)), 1);
				},
				Err(ScanError::Write(err)) => return write_failure(host, &err),
			}
		}
		if let Err(err) = out.flush() {
			return write_failure(host, &err);
		}
		host.exit_code()
	}
}

fn write_failure(host: &mut Host, error: &io::Error) -> i32 {
	if error.kind() == io::ErrorKind::BrokenPipe {
		return SIGPIPE_EXIT_CODE;
	}
	host.error(format!("write error: {}", strip_errno(error)), 1);
	1
}

/// Rewrites GNU `getopt` syntax into long options clap parses in order:
/// short clusters become `--long[=value]`, `-o` becomes `--radix=o`, and the
/// `-N` digit options become one trailing `--bytes=WORD`, where WORD is what
/// GNU passes to `set_string_min` (the argv word holding the last digit, minus
/// its first byte; the previous word when the digit does not end its cluster).
fn normalize_argv(argv: Vec<OsString>) -> Vec<OsString> {
	let mut out = Vec::with_capacity(argv.len() + 1);
	let mut numeric: Option<OsString> = None;
	let mut operands_from = argv.len();
	let mut index = 1;
	if let Some(program) = argv.first() {
		out.push(program.clone());
	}
	while index < argv.len() {
		let word = &argv[index];
		index += 1;
		let Some(text) = word.to_str() else {
			out.push(word.clone());
			continue;
		};
		if text == "--" {
			operands_from = index - 1;
			break;
		}
		if let Some(long) = text.strip_prefix("--") {
			out.push(word.clone());
			if !long.contains('=') && long_takes_value(long) && index < argv.len() {
				out.push(argv[index].clone());
				index += 1;
			}
			continue;
		}
		let Some(cluster) = text.strip_prefix('-').filter(|cluster| !cluster.is_empty()) else {
			out.push(word.clone());
			continue;
		};
		let word_index = index - 1;
		for (at, letter) in cluster.char_indices() {
			let rest = &cluster[at + letter.len_utf8()..];
			if letter.is_ascii_digit() {
				let source = if rest.is_empty() { word } else { &argv[word_index - 1] };
				let source = source.to_string_lossy();
				numeric = Some(OsString::from(source.get(1..).unwrap_or_default()));
				continue;
			}
			if letter == 'o' {
				out.push(OsString::from("--radix=o"));
				continue;
			}
			match SHORT_OPTIONS.iter().find(|(short, ..)| *short == letter) {
				Some(&(_, long, true)) => {
					let value = if !rest.is_empty() {
						Some(OsString::from(rest))
					} else if index < argv.len() {
						index += 1;
						Some(argv[index - 1].clone())
					} else {
						None
					};
					match value {
						Some(value) => {
							let mut option = OsString::from(format!("--{long}="));
							option.push(value);
							out.push(option);
						},
						None => out.push(OsString::from(format!("-{letter}"))),
					}
					break;
				},
				Some(&(_, long, false)) => out.push(OsString::from(format!("--{long}"))),
				None => out.push(OsString::from(format!("-{letter}"))),
			}
		}
	}
	if let Some(word) = numeric {
		let mut option = OsString::from("--bytes=");
		option.push(word);
		out.push(option);
	}
	out.extend(argv[operands_from..].iter().cloned());
	out
}

/// Whether the long option `name` (exact, or a unique prefix as `getopt_long`
/// accepts) takes a value.
fn long_takes_value(name: &str) -> bool {
	if let Some(&(_, takes)) = LONG_OPTIONS.iter().find(|(long, _)| *long == name) {
		return takes;
	}
	let mut hits = LONG_OPTIONS.iter().filter(|(long, _)| long.starts_with(name));
	match (hits.next(), hits.next()) {
		(Some(&(_, takes)), None) => takes,
		_ => false,
	}
}

fn command() -> Command {
	let flag = |id: &'static str| Arg::new(id).long(id).action(ArgAction::Count);
	let valued = |id: &'static str| {
		Arg::new(id)
			.long(id)
			.action(ArgAction::Append)
			.allow_hyphen_values(true)
			.value_parser(ValueParser::os_string())
	};
	Command::new(Strings::NAME)
		.version("(GNU Binutils compatible) 2.46")
		.about("Display printable strings in [file(s)] (stdin by default).")
		.override_usage(format_usage("strings [option(s)] [file(s)]"))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.infer_long_args(true)
		.arg(flag(ALL).help("scan the entire file [default]"))
		.arg(flag(DATA).help("scan the entire file (no object-format parsing)"))
		.arg(flag(FILE_NAME).help("print the name of the file before each string"))
		.arg(flag(HELP).help("display this information"))
		.arg(flag(WHITESPACE).help("include all whitespace as valid string characters"))
		.arg(valued(BYTES).value_name("number").help("minimum string length (default 4)"))
		.arg(valued(RADIX).value_name("o|d|x").help("print the offset of each string in base 8, 10 or 16"))
		.arg(valued(TARGET).value_name("BFDNAME").help("accepted and ignored"))
		.arg(valued(ENCODING).value_name("s|S|b|l|B|L").help("character size and endianness"))
		.arg(valued(SEPARATOR).value_name("string").help("string used to separate strings in output"))
		.arg(valued(UNICODE).value_name("d|l|i|x|e|h").help("how to treat UTF-8 encoded characters"))
		.arg(Arg::new(VERSION).long(VERSION).action(ArgAction::Version).help("print the version number"))
		.arg(
			Arg::new(FILES)
				.value_name("FILE")
				.num_args(0..)
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string()),
		)
}

/// Why option processing stopped short of scanning.
enum Exit {
	/// `-h`: GNU's usage text on stdout, status 0.
	Help,
	/// GNU's `usage (stderr, 1)`.
	Usage,
	/// GNU's `fatal`: `strings: <message>`, status 1.
	Fatal(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Radix {
	Octal,
	Decimal,
	Hex,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Unicode {
	Default,
	Locale,
	Escape,
	Hex,
	Highlight,
	Invalid,
}

/// Character size and byte order selected by `-e`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Encoding {
	Byte,
	Big16,
	Little16,
	Big32,
	Little32,
}

impl Encoding {
	const fn width(self) -> usize {
		match self {
			Self::Byte => 1,
			Self::Big16 | Self::Little16 => 2,
			Self::Big32 | Self::Little32 => 4,
		}
	}

	fn decode(self, bytes: &[u8]) -> u32 {
		match self {
			Self::Byte => u32::from(bytes[0]),
			Self::Big16 => u32::from(u16::from_be_bytes([bytes[0], bytes[1]])),
			Self::Little16 => u32::from(u16::from_le_bytes([bytes[0], bytes[1]])),
			Self::Big32 => u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
			Self::Little32 => u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
		}
	}
}

/// Options shared by every input.
struct Config {
	min: usize,
	encoding: Encoding,
	/// GNU's `STRING_ISGRAPHIC` over byte values.
	graphic: [bool; 256],
	unicode: Unicode,
	radix: Option<Radix>,
	separator: Vec<u8>,
	file_names: bool,
}

impl Config {
	/// Applies the options in command-line order, failing where GNU's option
	/// loop would, then its post-loop checks (`-U` forcing `-e S`, the encoding).
	fn from_matches(matches: &ArgMatches) -> Result<Self, Exit> {
		enum Event<'a> {
			Help,
			Bytes(&'a OsStr),
			Radix(&'a OsStr),
			Encoding(&'a OsStr),
			Unicode(&'a OsStr),
		}
		let valued = |id: &str| {
			matches
				.indices_of(id)
				.into_iter()
				.flatten()
				.zip(matches.get_many::<OsString>(id).into_iter().flatten())
		};
		let mut events: Vec<(usize, Event<'_>)> = Vec::new();
		if matches.get_count(HELP) > 0
			&& let Some(index) = matches.index_of(HELP)
		{
			events.push((index, Event::Help));
		}
		events.extend(valued(BYTES).map(|(index, value)| (index, Event::Bytes(value))));
		events.extend(valued(RADIX).map(|(index, value)| (index, Event::Radix(value))));
		events.extend(valued(ENCODING).map(|(index, value)| (index, Event::Encoding(value))));
		events.extend(valued(UNICODE).map(|(index, value)| (index, Event::Unicode(value))));
		events.sort_by_key(|(index, _)| *index);

		let mut min = 4;
		let mut radix = None;
		let mut encoding = b's';
		let mut unicode = Unicode::Default;
		for (_, event) in events {
			match event {
				Event::Help => return Err(Exit::Help),
				Event::Bytes(value) => min = parse_min(value).map_err(Exit::Fatal)?,
				Event::Radix(value) => {
					radix = Some(match value.as_encoded_bytes() {
						b"o" => Radix::Octal,
						b"d" => Radix::Decimal,
						b"x" => Radix::Hex,
						_ => return Err(Exit::Usage),
					});
				},
				Event::Encoding(value) => match value.as_encoded_bytes() {
					&[letter] => encoding = letter,
					_ => return Err(Exit::Usage),
				},
				Event::Unicode(value) => {
					unicode = match value.as_encoded_bytes() {
						b"default" | b"d" => Unicode::Default,
						b"locale" | b"l" => Unicode::Locale,
						b"escape" | b"e" => Unicode::Escape,
						b"invalid" | b"i" => Unicode::Invalid,
						b"hex" | b"x" => Unicode::Hex,
						b"highlight" | b"h" => Unicode::Highlight,
						_ => {
							return Err(Exit::Fatal(format!(
								"invalid argument to -U/--unicode: {}",
								value.to_string_lossy()
							)));
						},
					};
				},
			}
		}
		if unicode != Unicode::Default {
			encoding = b'S';
		}
		let (encoding, eight_bit) = match encoding {
			b's' => (Encoding::Byte, false),
			b'S' => (Encoding::Byte, true),
			b'b' => (Encoding::Big16, false),
			b'l' => (Encoding::Little16, false),
			b'B' => (Encoding::Big32, false),
			b'L' => (Encoding::Little32, false),
			_ => return Err(Exit::Usage),
		};
		let all_whitespace = matches.get_count(WHITESPACE) > 0;
		let graphic = std::array::from_fn(|byte| {
			let byte = byte as u8;
			byte == b'\t'
				|| (0x20..=0x7e).contains(&byte)
				|| (eight_bit && byte > 0x7f)
				|| (all_whitespace && matches!(byte, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r'))
		});
		let separator = matches
			.get_many::<OsString>(SEPARATOR)
			.and_then(Iterator::last)
			.map_or_else(|| b"\n".to_vec(), |separator| os_bytes_lossy(separator).into_owned());
		Ok(Self {
			min,
			encoding,
			graphic,
			unicode,
			radix,
			separator,
			file_names: matches.get_count(FILE_NAME) > 0,
		})
	}

	fn is_graphic(&self, value: u32) -> bool {
		usize::try_from(value).ok().and_then(|value| self.graphic.get(value)).copied().unwrap_or(false)
	}
}

/// GNU's `set_string_min`: `strtoul (arg, &end, 0)` with its range checks
/// and messages.
fn parse_min(arg: &OsStr) -> Result<usize, String> {
	let text = arg.to_string_lossy();
	let bytes = text.as_bytes();
	let mut at = bytes
		.iter()
		.position(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r'))
		.unwrap_or(bytes.len());
	let negative = match bytes.get(at) {
		Some(b'-') => {
			at += 1;
			true
		},
		Some(b'+') => {
			at += 1;
			false
		},
		_ => false,
	};
	let (radix, digits) = if matches!(bytes.get(at..at + 2), Some(b"0x" | b"0X"))
		&& bytes.get(at + 2).is_some_and(u8::is_ascii_hexdigit)
	{
		(16, at + 2)
	} else if bytes.get(at) == Some(&b'0') {
		(8, at)
	} else {
		(10, at)
	};
	let mut end = digits;
	let mut value: u64 = 0;
	let mut overflow = false;
	while let Some(digit) = bytes.get(end).and_then(|&byte| char::from(byte).to_digit(radix)) {
		match value.checked_mul(u64::from(radix)).and_then(|value| value.checked_add(u64::from(digit))) {
			Some(next) => value = next,
			None => overflow = true,
		}
		end += 1;
	}
	// No digits: `strtoul` leaves `end` at the start of the argument.
	let end = if end == digits { 0 } else { end };
	if end < bytes.len() {
		return Err(format!("invalid integer argument {text}"));
	}
	let value = if overflow {
		u64::MAX
	} else if negative {
		value.wrapping_neg()
	} else {
		value
	};
	let Ok(min) = u32::try_from(value) else {
		return Err(format!("minimum string length is too big: {text}"));
	};
	if min == 0 {
		return Err(format!("minimum string length is too small: {text}"));
	}
	if min == u32::MAX {
		return Err(format!("minimum string length {text} is too big"));
	}
	Ok(min as usize)
}

enum ScanError {
	Read(io::Error),
	Write(io::Error),
	Cancelled,
}

type Scan<T = ()> = Result<T, ScanError>;

/// A buffered input with GNU's file `address` bookkeeping and the one-step
/// rewind `unget_part_char` needs.
struct Source<'a, R> {
	reader: &'a mut R,
	buf: &'a mut [u8],
	pos: usize,
	len: usize,
	eof: bool,
	address: u64,
	cancel: &'a AtomicBool,
}

impl<R: Read> Source<'_, R> {
	/// Makes `want` unread bytes available unless the input ends first.
	fn fill(&mut self, want: usize) -> Scan {
		if self.len - self.pos >= want || self.eof {
			return Ok(());
		}
		self.buf.copy_within(self.pos..self.len, 0);
		self.len -= self.pos;
		self.pos = 0;
		while self.len < want && !self.eof {
			if self.cancel.load(Ordering::Relaxed) {
				return Err(ScanError::Cancelled);
			}
			match self.reader.read(&mut self.buf[self.len..]) {
				Ok(0) => self.eof = true,
				Ok(read) => self.len += read,
				Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
				Err(err) => return Err(ScanError::Read(err)),
			}
		}
		Ok(())
	}

	/// GNU's `get_char`: the next `encoding` character, or `None` at end of
	/// input (a trailing partial character is consumed).
	fn next_char(&mut self, encoding: Encoding) -> Scan<Option<u32>> {
		let width = encoding.width();
		self.fill(width)?;
		let available = self.len - self.pos;
		if available < width {
			self.pos = self.len;
			self.address += available as u64;
			return Ok(None);
		}
		let value = encoding.decode(&self.buf[self.pos..self.pos + width]);
		self.pos += width;
		self.address += width as u64;
		Ok(Some(value))
	}

	/// GNU's `unget_part_char`: rewinds all but the first byte of the
	/// character just read.
	fn unget(&mut self, encoding: Encoding) {
		let back = encoding.width() - 1;
		self.pos -= back;
		self.address -= back as u64;
	}

	/// One byte through GNU's `-U` putback stack, counting fresh reads (even
	/// the one hitting end of input) in `read` like `get_unicode_byte`.
	fn unicode_byte(&mut self, putback: &mut Vec<u8>, read: &mut u64) -> Scan<Option<u8>> {
		if let Some(byte) = putback.pop() {
			return Ok(Some(byte));
		}
		*read += 1;
		Ok(self.next_char(Encoding::Byte)?.map(|byte| byte as u8))
	}
}

/// Scanning state reused across inputs.
struct Scanner {
	config: Config,
	/// Whether stdout is a terminal, for `-U highlight` colours.
	highlight: bool,
	buf: Vec<u8>,
	/// The candidate run (GNU's `buf`, or `print_buf` under `-U`).
	run: Vec<u8>,
	putback: Vec<u8>,
}

impl Scanner {
	fn scan<R: Read, W: Write>(
		&mut self,
		reader: &mut R,
		out: &mut W,
		name: &[u8],
		cancel: &AtomicBool,
	) -> Scan {
		let mut source =
			Source { reader, buf: &mut self.buf, pos: 0, len: 0, eof: false, address: 0, cancel };
		self.putback.clear();
		if self.config.unicode == Unicode::Default {
			scan_plain(&self.config, &mut source, out, name, &mut self.run)
		} else {
			scan_unicode(
				&self.config,
				self.highlight,
				&mut source,
				out,
				name,
				&mut self.run,
				&mut self.putback,
			)
		}
	}
}

fn write_prefix<W: Write>(out: &mut W, config: &Config, name: &[u8], address: u64) -> io::Result<()> {
	if config.file_names {
		out.write_all(name)?;
		out.write_all(b": ")?;
	}
	match config.radix {
		None => Ok(()),
		Some(Radix::Octal) => write!(out, "{address:7o} "),
		Some(Radix::Decimal) => write!(out, "{address:7} "),
		Some(Radix::Hex) => write!(out, "{address:7x} "),
	}
}

/// GNU's `print_strings` without `-U`: find `min` printable characters in a
/// row, then print through to the next non-printable one.
fn scan_plain<R: Read, W: Write>(
	config: &Config,
	source: &mut Source<'_, R>,
	out: &mut W,
	name: &[u8],
	run: &mut Vec<u8>,
) -> Scan {
	let encoding = config.encoding;
	'scan: loop {
		let start = source.address;
		run.clear();
		while run.len() < config.min {
			let Some(value) = source.next_char(encoding)? else {
				return Ok(());
			};
			if !config.is_graphic(value) {
				source.unget(encoding);
				continue 'scan;
			}
			run.push(value as u8);
		}
		write_prefix(out, config, name, start).map_err(ScanError::Write)?;
		out.write_all(run).map_err(ScanError::Write)?;
		if encoding == Encoding::Byte {
			loop {
				source.fill(1)?;
				let pending = &source.buf[source.pos..source.len];
				if pending.is_empty() {
					break;
				}
				let printable = pending.iter().position(|&byte| !config.graphic[usize::from(byte)]);
				let take = printable.unwrap_or(pending.len());
				out.write_all(&pending[..take]).map_err(ScanError::Write)?;
				// The terminating byte is consumed, as GNU's single-byte unget is a no-op.
				let consumed = take + usize::from(printable.is_some());
				source.pos += consumed;
				source.address += consumed as u64;
				if printable.is_some() {
					break;
				}
			}
		} else {
			while let Some(value) = source.next_char(encoding)? {
				if !config.is_graphic(value) {
					source.unget(encoding);
					break;
				}
				out.write_all(&[value as u8]).map_err(ScanError::Write)?;
			}
		}
		out.write_all(&config.separator).map_err(ScanError::Write)?;
	}
}

/// GNU's `print_unicode_stream`: like [`scan_plain`] over bytes, but a valid
/// UTF-8 sequence counts as one character and is shown per the `-U` mode;
/// under `-U invalid` it ends a run instead. Mirrors GNU's putback stack and
/// address arithmetic so offsets agree.
fn scan_unicode<R: Read, W: Write>(
	config: &Config,
	highlight: bool,
	source: &mut Source<'_, R>,
	out: &mut W,
	name: &[u8],
	run: &mut Vec<u8>,
	putback: &mut Vec<u8>,
) -> Scan {
	let invalid = config.unicode == Unicode::Invalid;
	let mut address: u64 = 0;
	loop {
		let mut read: u64 = 0;
		let mut start: i64 = 0;
		let mut chars = 0usize;
		let mut at_eof = false;
		run.clear();
		while chars < config.min {
			let Some(lead) = source.unicode_byte(putback, &mut read)? else {
				at_eof = true;
				break;
			};
			if !config.is_graphic(u32::from(lead)) {
				chars = 0;
				run.clear();
				continue;
			}
			if chars == 0 {
				start = read as i64 - 1;
			}
			if lead < 0x7f {
				run.push(lead);
				chars += 1;
				continue;
			}
			if lead < 0xc0 {
				chars = 0;
				run.clear();
				continue;
			}
			let Some(second) = source.unicode_byte(putback, &mut read)? else {
				at_eof = true;
				break;
			};
			if second & 0xc0 != 0x80 || (lead & 0x20 == 0 && invalid) {
				putback.push(second);
				chars = 0;
				run.clear();
				continue;
			}
			if lead & 0x20 == 0 {
				run.extend_from_slice(&[lead, second]);
				chars += 1;
				continue;
			}
			let Some(third) = source.unicode_byte(putback, &mut read)? else {
				at_eof = true;
				break;
			};
			if third & 0xc0 != 0x80 || (lead & 0x10 == 0 && invalid) {
				putback.extend_from_slice(&[third, second]);
				chars = 0;
				run.clear();
				continue;
			}
			if lead & 0x10 == 0 {
				run.extend_from_slice(&[lead, second, third]);
				chars += 1;
				continue;
			}
			let Some(fourth) = source.unicode_byte(putback, &mut read)? else {
				at_eof = true;
				break;
			};
			if fourth & 0xc0 != 0x80 {
				putback.extend_from_slice(&[fourth, third, second]);
				chars = 0;
				run.clear();
			} else if invalid {
				// GNU pushes these back in this order, so they re-read reordered.
				putback.extend_from_slice(&[fourth, second, third]);
				chars = 0;
				run.clear();
			} else {
				run.extend_from_slice(&[lead, second, third, fourth]);
				chars += 1;
			}
		}

		if chars >= config.min {
			write_prefix(out, config, name, address.wrapping_add_signed(start))
				.map_err(ScanError::Write)?;
			let mut at = 0;
			while at < run.len() {
				if run[at] < 0x7f {
					out.write_all(&run[at..=at]).map_err(ScanError::Write)?;
					at += 1;
				} else {
					at += write_utf8_char(out, &run[at..], config.unicode, highlight)
						.map_err(ScanError::Write)?;
				}
			}
			loop {
				let Some(lead) = source.unicode_byte(putback, &mut read)? else {
					at_eof = true;
					break;
				};
				if !config.is_graphic(u32::from(lead)) {
					break;
				}
				if lead < 0x7f {
					out.write_all(&[lead]).map_err(ScanError::Write)?;
					continue;
				}
				if lead < 0xc0 {
					break;
				}
				let Some(second) = source.unicode_byte(putback, &mut read)? else {
					at_eof = true;
					break;
				};
				if second & 0xc0 != 0x80 || (lead & 0x20 == 0 && invalid) {
					putback.push(second);
					break;
				}
				if lead & 0x20 == 0 {
					write_utf8_char(out, &[lead, second], config.unicode, highlight)
						.map_err(ScanError::Write)?;
					continue;
				}
				let Some(third) = source.unicode_byte(putback, &mut read)? else {
					at_eof = true;
					break;
				};
				if third & 0xc0 != 0x80 || (lead & 0x10 == 0 && invalid) {
					putback.extend_from_slice(&[third, second]);
					break;
				}
				if lead & 0x10 == 0 {
					write_utf8_char(out, &[lead, second, third], config.unicode, highlight)
						.map_err(ScanError::Write)?;
					continue;
				}
				let Some(fourth) = source.unicode_byte(putback, &mut read)? else {
					at_eof = true;
					break;
				};
				if fourth & 0xc0 != 0x80 || invalid {
					putback.extend_from_slice(&[fourth, third, second]);
					break;
				}
				write_utf8_char(out, &[lead, second, third, fourth], config.unicode, highlight)
					.map_err(ScanError::Write)?;
			}
			out.write_all(&config.separator).map_err(ScanError::Write)?;
		}
		if at_eof {
			return Ok(());
		}
		address += read;
	}
}

/// GNU's `display_utf8_char` for a valid sequence at the start of `bytes`;
/// returns the sequence length.
fn write_utf8_char<W: Write>(
	out: &mut W,
	bytes: &[u8],
	mode: Unicode,
	highlight: bool,
) -> io::Result<usize> {
	let len = match bytes[0] & 0x30 {
		0x00 | 0x10 => 2,
		0x20 => 3,
		_ => 4,
	};
	let bytes = &bytes[..len];
	match mode {
		Unicode::Escape | Unicode::Highlight => {
			let colour = mode == Unicode::Highlight && highlight;
			if colour {
				out.write_all(b"\x1b[31;47m")?;
			}
			match *bytes {
				[b0, b1] => write!(out, "\\u{:02x}{:02x}", (b0 & 0x1c) >> 2, ((b0 & 0x03) << 6) | (b1 & 0x3f))?,
				[b0, b1, b2] => write!(
					out,
					"\\u{:02x}{:02x}",
					((b0 & 0x0f) << 4) | ((b1 & 0x3c) >> 2),
					((b1 & 0x03) << 6) | (b2 & 0x3f)
				)?,
				[b0, b1, b2, b3] => write!(
					out,
					"\\u{:02x}{:02x}{:02x}",
					((b0 & 0x07) << 2) | ((b1 & 0x30) >> 4),
					((b1 & 0x0f) << 4) | ((b2 & 0x3c) >> 2),
					((b2 & 0x03) << 6) | (b3 & 0x3f)
				)?,
				_ => {},
			}
			if colour {
				out.write_all(b"\x1b[0m")?;
			}
		},
		Unicode::Hex => {
			out.write_all(b"<0x")?;
			for byte in bytes {
				write!(out, "{byte:02x}")?;
			}
			out.write_all(b">")?;
		},
		Unicode::Locale | Unicode::Default | Unicode::Invalid => out.write_all(bytes)?,
	}
	Ok(len)
}

#[cfg(test)]
mod tests {
	use std::{fs, path::Path};

	use super::{CHUNK_SIZE, Strings};
	use crate::host::run_util;

	fn run(cwd: &Path, stdin: &str, args: &[&str]) -> (i32, Vec<u8>, String) {
		let (code, capture) = run_util::<Strings>(args, stdin, cwd);
		(code, capture.stdout(), capture.err())
	}

	fn run_file(bytes: &[u8], args: &[&str]) -> (i32, Vec<u8>, String) {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("in"), bytes).unwrap();
		let mut argv = args.to_vec();
		argv.push("in");
		run(dir.path(), "", &argv)
	}

	fn out(bytes: &[u8], args: &[&str]) -> String {
		let (code, stdout, stderr) = run_file(bytes, args);
		assert_eq!((code, stderr.as_str()), (0, ""));
		String::from_utf8(stdout).unwrap()
	}

	fn utf16le(text: &str) -> Vec<u8> {
		text.encode_utf16().flat_map(u16::to_le_bytes).collect()
	}

	#[test]
	fn default_min_length_four_on_binary() {
		let data = b"\x00\x01abc\x00defg\x7fhijkl\xffmn\tok\x00\x02xyz";
		assert_eq!(out(data, &[]), "defg\nhijkl\nmn\tok\n");
		assert_eq!(out(data, &["-a"]), "defg\nhijkl\nmn\tok\n");
		assert_eq!(out(data, &["-d"]), "defg\nhijkl\nmn\tok\n");
	}

	#[test]
	fn minimum_length_forms() {
		let data = b"ab\x00abcdef\x00abcdefg\x00x";
		assert_eq!(out(data, &["-n", "2"]), "ab\nabcdef\nabcdefg\n");
		assert_eq!(out(data, &["-n2"]), "ab\nabcdef\nabcdefg\n");
		assert_eq!(out(data, &["--bytes=7"]), "abcdefg\n");
		assert_eq!(out(data, &["-6"]), "abcdef\nabcdefg\n");
		assert_eq!(out(data, &["-n", "0x7"]), "abcdefg\n");
		// The digit option wins over `-n` wherever it appears.
		assert_eq!(out(data, &["-7", "-n", "2"]), "abcdefg\n");
	}

	#[test]
	fn invalid_minimum_lengths_are_fatal() {
		let (code, stdout, stderr) = run_file(b"abcd", &["-n", "0"]);
		assert_eq!((code, stdout.as_slice(), stderr.as_str()), (1, &b""[..], "strings: minimum string length is too small: 0\n"));
		let (code, _, stderr) = run_file(b"abcd", &["-n", "abc"]);
		assert_eq!((code, stderr.as_str()), (1, "strings: invalid integer argument abc\n"));
		let (code, _, stderr) = run_file(b"abcd", &["-n", "08"]);
		assert_eq!((code, stderr.as_str()), (1, "strings: invalid integer argument 08\n"));
		let (code, _, stderr) = run_file(b"abcd", &["-n", "5000000000"]);
		assert_eq!((code, stderr.as_str()), (1, "strings: minimum string length is too big: 5000000000\n"));
	}

	#[test]
	fn offset_radixes() {
		let mut data = vec![0u8; 300];
		data.extend_from_slice(b"hello\x00world!\x00");
		assert_eq!(out(&data, &["-t", "x"]), "    12c hello\n    132 world!\n");
		assert_eq!(out(&data, &["--radix=d"]), "    300 hello\n    306 world!\n");
		assert_eq!(out(&data, &["-o"]), "    454 hello\n    462 world!\n");
		assert_eq!(out(&data, &["-o", "-tx"]), "    12c hello\n    132 world!\n");
		assert_eq!(out(&data, &["-f", "-td"]), "in:     300 hello\nin:     306 world!\n");
	}

	#[test]
	fn bad_radix_prints_usage() {
		let (code, stdout, stderr) = run_file(b"abcd", &["-t", "q"]);
		assert_eq!((code, stdout.as_slice()), (1, &b""[..]));
		assert!(stderr.starts_with("Usage: strings [option(s)] [file(s)]\n"), "{stderr}");
		let (code, _, stderr) = run_file(b"abcd", &["-e", "z"]);
		assert_eq!(code, 1);
		assert!(stderr.starts_with("Usage: strings"), "{stderr}");
	}

	#[test]
	fn print_file_name_with_two_files() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a"), b"alpha\x00x").unwrap();
		fs::write(dir.path().join("b"), b"\x00beta123").unwrap();
		let (code, stdout, stderr) = run(dir.path(), "", &["-f", "a", "b"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(stdout, b"a: alpha\nb: beta123\n");
	}

	#[test]
	fn wide_encodings() {
		let mut data = utf16le("wide str");
		data.extend_from_slice(&[0, 0]);
		data.extend_from_slice(&utf16le("ab"));
		assert_eq!(out(&data, &["-e", "l"]), "wide str\n");
		assert_eq!(out(&data, &[]), "");

		// A non-printable unit resumes the scan one byte later, realigning.
		let mut shifted = vec![0x01];
		shifted.extend_from_slice(&utf16le("text"));
		assert_eq!(out(&shifted, &["-el", "-tx"]), "      1 text\n");

		let big: Vec<u8> = "word".encode_utf16().flat_map(u16::to_be_bytes).collect();
		assert_eq!(out(&big, &["--encoding=b"]), "word\n");
		let wide: Vec<u8> = "four".chars().flat_map(|c| u32::from(c).to_le_bytes()).collect();
		assert_eq!(out(&wide, &["-e", "L"]), "four\n");
	}

	#[test]
	fn eight_bit_encoding_keeps_high_bytes() {
		let data = b"caf\xe9s\x00";
		assert_eq!(run_file(data, &["-e", "S"]).1, b"caf\xe9s\n");
		assert_eq!(out(data, &[]), "");
	}

	#[test]
	fn include_all_whitespace() {
		let data = b"line one\nline two\r\n\x00tail";
		assert_eq!(out(data, &["-w"]), "line one\nline two\r\n\ntail\n");
		assert_eq!(out(data, &[]), "line one\nline two\ntail\n");
	}

	#[test]
	fn output_separator() {
		assert_eq!(out(b"abcd\x00efgh\x00ab", &["-s", ","]), "abcd,efgh,");
		assert_eq!(out(b"abcd\x00efgh", &["--output-separator=--"]), "abcd--efgh--");
	}

	#[test]
	fn strings_spanning_buffer_boundaries() {
		let mut data = vec![0u8; CHUNK_SIZE - 3];
		data.extend_from_slice(b"boundary-string\x00");
		data.extend(std::iter::repeat_n(b'x', 3 * CHUNK_SIZE + 7));
		let long = "x".repeat(3 * CHUNK_SIZE + 7);
		assert_eq!(out(&data, &["-t", "d"]), format!("  65533 boundary-string\n  65549 {long}\n"));

		// A minimum-length window straddling the boundary.
		let mut data = vec![0u8; CHUNK_SIZE - 2];
		data.extend_from_slice(b"abcd");
		assert_eq!(out(&data, &[]), "abcd\n");
	}

	#[test]
	fn missing_file_and_directory_continue_with_status_one() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a"), b"present\x00").unwrap();
		fs::create_dir(dir.path().join("sub")).unwrap();
		let (code, stdout, stderr) = run(dir.path(), "", &["nope", "sub", "a"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, b"present\n");
		assert_eq!(
			stderr,
			"strings: 'nope': No such file\nstrings: Warning: 'sub' is a directory\n"
		);
	}

	#[test]
	fn reads_standard_input() {
		let dir = tempfile::tempdir().unwrap();
		let (code, stdout, _) = run(dir.path(), "hello\x01wor\x02world", &[]);
		assert_eq!((code, stdout.as_slice()), (0, &b"hello\nworld\n"[..]));
		let (code, stdout, _) = run(dir.path(), "hello", &["-f", "-"]);
		assert_eq!((code, stdout.as_slice()), (0, &b"{standard input}: hello\n"[..]));
	}

	#[test]
	fn unicode_modes() {
		let data = "héllo wörld\x00ééx\x00".as_bytes();
		assert_eq!(out(data, &[]), "llo w\n");
		assert_eq!(out(data, &["-U", "d"]), "llo w\n");
		assert_eq!(out(data, &["-U", "i"]), "llo w\n");
		assert_eq!(out(data, &["-n3", "--unicode=escape"]), "h\\u00e9llo w\\u00f6rld\n\\u00e9\\u00e9x\n");
		assert_eq!(out(data, &["-U", "x"]), "h<0xc3a9>llo w<0xc3b6>rld\n");
		assert_eq!(out(data, &["-n", "3", "-U", "l"]), "héllo wörld\nééx\n");
		assert_eq!(out("ab€😀z\x00".as_bytes(), &["-Ue", "-t", "d"]), "      0 ab\\u20ac\\u01f600z\n");

		let (code, _, stderr) = run_file(data, &["-U", "z"]);
		assert_eq!((code, stderr.as_str()), (1, "strings: invalid argument to -U/--unicode: z\n"));
	}

	#[test]
	fn help_prints_usage_on_stdout() {
		let dir = tempfile::tempdir().unwrap();
		let (code, stdout, stderr) = run(dir.path(), "", &["-h"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert!(stdout.starts_with(b"Usage: strings [option(s)] [file(s)]\n"));
	}
}
