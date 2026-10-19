//! `nl` builtin: write files to standard output with line numbers added.
//!
//! Behavior notes: `pBRE` takes a basic regular expression (back-references
//! included), an unreadable operand is reported and skipped instead of ending
//! the run, `-l` counts only blank lines numbered under the `a` style,
//! unnumbered lines are indented by the separator's width, and malformed
//! options get GNU's diagnostics in command-line order.

use std::{
	ffi::OsString,
	io::{self, BufRead, BufReader, Write},
	sync::atomic::{AtomicBool, Ordering},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use fancy_regex::Regex;
use uucore::{display::Quotable, i18n::charmap::mb_char_len};

use crate::{
	bre,
	host::{Host, Utility, format_usage, matches_parser, os_bytes, strip_errno, util},
};

mod options {
	pub const BODY_NUMBERING: &str = "body-numbering";
	pub const SECTION_DELIMITER: &str = "section-delimiter";
	pub const FOOTER_NUMBERING: &str = "footer-numbering";
	pub const HEADER_NUMBERING: &str = "header-numbering";
	pub const LINE_INCREMENT: &str = "line-increment";
	pub const JOIN_BLANK_LINES: &str = "join-blank-lines";
	pub const NUMBER_FORMAT: &str = "number-format";
	pub const NO_RENUMBER: &str = "no-renumber";
	pub const NUMBER_SEPARATOR: &str = "number-separator";
	pub const STARTING_LINE_NUMBER: &str = "starting-line-number";
	pub const NUMBER_WIDTH: &str = "number-width";
	pub const FILE: &str = "file";
}

/// Options carrying a value, which GNU validates in command-line order.
const VALUED_OPTIONS: [&str; 10] = [
	options::BODY_NUMBERING,
	options::SECTION_DELIMITER,
	options::FOOTER_NUMBERING,
	options::HEADER_NUMBERING,
	options::LINE_INCREMENT,
	options::JOIN_BLANK_LINES,
	options::NUMBER_FORMAT,
	options::NUMBER_SEPARATOR,
	options::STARTING_LINE_NUMBER,
	options::NUMBER_WIDTH,
];

const AFTER_HELP: &str = "\
Default options are: -bt -d'\\:' -fn -hn -i1 -l1 -n'rn' -s<TAB> -v1 -w6

CC are two delimiter characters used to construct logical page delimiters;
a missing second character implies ':'.  As a GNU extension one can specify
more than two characters, and also specifying the empty string (-d '')
disables section matching.

STYLE is one of:

  a      number all lines
  t      number only nonempty lines
  n      number no lines
  pBRE   number only lines that contain a match for the basic regular
         expression, BRE

FORMAT is one of:

  ln     left justified, no leading zeros
  rn     right justified, no leading zeros
  rz     right justified, leading zeros";

/// `strerror(ERANGE)`, which GNU appends when a NUMBER is below its minimum.
const ERANGE: &str = "Numerical result out of range";
/// `strerror(EOVERFLOW)`, which GNU appends when a NUMBER is too large.
const EOVERFLOW: &str = "Value too large for defined data type";

/// Padding source for [`fill`].
const SPACES: [u8; 64] = [b' '; 64];
/// Zero-padding source for [`fill`] under `-n rz`.
const ZEROS: [u8; 64] = [b'0'; 64];

/// Parsed `nl` invocation.
pub(crate) struct Nl {
	matches: ArgMatches,
}

matches_parser!(Nl, app);

impl Utility for Nl {
	const NAME: &'static str = "nl";

	fn run(self, host: &mut Host) -> i32 {
		let settings = match Settings::from_matches(&self.matches) {
			Ok(settings) => settings,
			Err(message) => {
				host.error(message, 1);
				return 1;
			},
		};
		let stdin = OsString::from("-");
		let files: Vec<&OsString> = self
			.matches
			.get_many::<OsString>(options::FILE)
			.map_or_else(|| vec![&stdin], Iterator::collect);
		number_files(host, &settings, &files)
	}
}

/// The `nl` argument model.
fn app() -> Command {
	// GNU's `getopt` hands a required argument over even when it starts with
	// `-`, so `-v -5` and `-s -` work.
	let valued = |id: &'static str, short: char, value_name: &'static str, help: &'static str| {
		Arg::new(id)
			.short(short)
			.long(id)
			.value_name(value_name)
			.help(help)
			.allow_hyphen_values(true)
	};
	Command::new(Nl::NAME)
		.version("0.8.0")
		.about("Write each FILE to standard output, with line numbers added.")
		.override_usage(format_usage("nl [OPTION]... [FILE]..."))
		.after_help(AFTER_HELP)
		.infer_long_args(true)
		// `-h` is --header-numbering.
		.disable_help_flag(true)
		.args_override_self(true)
		.arg(valued(options::BODY_NUMBERING, 'b', "STYLE", "use STYLE for numbering body lines"))
		.arg(
			valued(options::SECTION_DELIMITER, 'd', "CC", "use CC for logical page delimiters")
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(valued(options::FOOTER_NUMBERING, 'f', "STYLE", "use STYLE for numbering footer lines"))
		.arg(valued(options::HEADER_NUMBERING, 'h', "STYLE", "use STYLE for numbering header lines"))
		.arg(valued(options::LINE_INCREMENT, 'i', "NUMBER", "line number increment at each line"))
		.arg(valued(
			options::JOIN_BLANK_LINES,
			'l',
			"NUMBER",
			"group of NUMBER empty lines counted as one",
		))
		.arg(valued(
			options::NUMBER_FORMAT,
			'n',
			"FORMAT",
			"insert line numbers according to FORMAT",
		))
		.arg(
			Arg::new(options::NO_RENUMBER)
				.short('p')
				.long(options::NO_RENUMBER)
				.help("do not reset line numbers for each section")
				.action(ArgAction::SetTrue),
		)
		.arg(
			valued(
				options::NUMBER_SEPARATOR,
				's',
				"STRING",
				"add STRING after (possible) line number",
			)
			.value_parser(clap::value_parser!(OsString)),
		)
		.arg(valued(
			options::STARTING_LINE_NUMBER,
			'v',
			"NUMBER",
			"first line number for each section",
		))
		.arg(valued(options::NUMBER_WIDTH, 'w', "NUMBER", "use NUMBER columns for line numbers"))
		.arg(
			Arg::new("help")
				.long("help")
				.help("Print help information")
				.action(ArgAction::Help),
		)
		.arg(
			Arg::new(options::FILE)
				.hide(true)
				.action(ArgAction::Append)
				.value_hint(clap::ValueHint::FilePath)
				.value_parser(clap::value_parser!(OsString)),
		)
}

/// Which lines a section numbers: the `-b`/`-h`/`-f` STYLE.
enum Style {
	/// `a`: every line, with `-l` grouping runs of blank lines.
	All,
	/// `t`: non-empty lines.
	NonEmpty,
	/// `n`: no lines.
	None,
	/// `pBRE`: lines containing a match.
	Matching(Regex),
}

impl Style {
	/// Parses a STYLE. Like GNU, only the first character selects it, so
	/// `-b all` is `-b a`.
	///
	/// # Errors
	/// [`Invalid::Usage`] for an unknown style; [`Invalid::Fatal`] for a BRE
	/// that does not compile.
	fn parse(spec: &str, section: &str) -> Result<Self, Invalid> {
		match spec.as_bytes().first() {
			Some(b'a') => Ok(Self::All),
			Some(b't') => Ok(Self::NonEmpty),
			Some(b'n') => Ok(Self::None),
			Some(b'p') => {
				let ere = bre::bre_to_ere(&spec[1..], bre::Backrefs::Supported)
					.map_err(|error| Invalid::Fatal(error.message().to_owned()))?;
				Regex::new(&ere)
					.map(Self::Matching)
					.map_err(|error| Invalid::Fatal(error.to_string()))
			},
			_ => Err(Invalid::Usage(format!("invalid {section} numbering style: {}", spec.quote()))),
		}
	}

	/// Whether `text` (newline stripped) gets a number.
	///
	/// `blank_run` is GNU's `-l` counter: only the `a` style advances or
	/// resets it, so blank lines in other styles and section delimiter lines
	/// leave a pending run intact.
	///
	/// # Errors
	/// [`Stop::Fatal`] when the regex engine gives up on a search.
	fn numbers(&self, text: &[u8], join_blank: u64, blank_run: &mut u64) -> Result<bool, Stop> {
		Ok(match self {
			Self::All if join_blank > 1 && text.is_empty() => {
				*blank_run += 1;
				let numbered = *blank_run == join_blank;
				if numbered {
					*blank_run = 0;
				}
				numbered
			},
			Self::All => {
				*blank_run = 0;
				true
			},
			Self::NonEmpty => !text.is_empty(),
			Self::None => false,
			// `fancy-regex` matches `str`: invalid UTF-8 matches as U+FFFD,
			// and valid lines (the norm) are borrowed, not copied.
			Self::Matching(regex) => regex
				.is_match(&String::from_utf8_lossy(text))
				.map_err(|_| Stop::Fatal("error in regular expression search".to_owned()))?,
		})
	}
}

/// How a line number fills its `-w` columns: the `-n` FORMAT.
#[derive(Clone, Copy)]
enum NumberFormat {
	/// `ln`: left justified.
	Left,
	/// `rn`: right justified.
	Right,
	/// `rz`: right justified with leading zeros after any sign.
	RightZero,
}

impl NumberFormat {
	/// Writes `number` in at least `width` columns.
	fn write(self, out: &mut impl Write, number: i64, width: usize) -> io::Result<()> {
		let mut buffer = [0; 20];
		let digits = magnitude_digits(number.unsigned_abs(), &mut buffer);
		let sign: &[u8] = if number < 0 { b"-" } else { b"" };
		let padding = width.saturating_sub(sign.len() + digits.len());
		match self {
			Self::Left => {
				out.write_all(sign)?;
				out.write_all(digits)?;
				fill(out, &SPACES, padding)
			},
			Self::Right => {
				fill(out, &SPACES, padding)?;
				out.write_all(sign)?;
				out.write_all(digits)
			},
			Self::RightZero => {
				out.write_all(sign)?;
				fill(out, &ZEROS, padding)?;
				out.write_all(digits)
			},
		}
	}
}

/// The decimal digits of `value`, rendered into the tail of `buffer`.
fn magnitude_digits(mut value: u64, buffer: &mut [u8; 20]) -> &[u8] {
	let mut start = buffer.len();
	loop {
		start -= 1;
		buffer[start] = b'0' + (value % 10) as u8;
		value /= 10;
		if value == 0 {
			return &buffer[start..];
		}
	}
}

/// Writes `count` bytes of `source`'s fill character in bounded chunks: GNU
/// accepts widths up to `INT_MAX`, which must not become one allocation.
fn fill(out: &mut impl Write, source: &[u8; 64], mut count: usize) -> io::Result<()> {
	while count > 0 {
		let chunk = count.min(source.len());
		out.write_all(&source[..chunk])?;
		count -= chunk;
	}
	Ok(())
}

/// The logical-page section a delimiter line opens.
#[derive(Clone, Copy)]
enum Section {
	Header,
	Body,
	Footer,
}

impl Section {
	/// The section `text` (newline stripped) opens: the delimiter `unit`
	/// repeated three (header), two (body), or one (footer) times, and nothing
	/// else. An empty unit disables section matching.
	fn of(text: &[u8], unit: &[u8]) -> Option<Self> {
		if unit.is_empty() || text.is_empty() || text.len() % unit.len() != 0 {
			return None;
		}
		let section = match text.len() / unit.len() {
			1 => Self::Footer,
			2 => Self::Body,
			3 => Self::Header,
			_ => return None,
		};
		text.chunks_exact(unit.len())
			.all(|chunk| chunk == unit)
			.then_some(section)
	}
}

/// A rejected option value.
enum Invalid {
	/// GNU reports it, keeps parsing, then exits with the `--help` hint.
	Usage(String),
	/// GNU reports it and exits on the spot.
	Fatal(String),
}

/// The range a NUMBER option accepts.
#[derive(Clone, Copy)]
struct Bounds {
	min:       i64,
	max:       i64,
	/// Whether a value above `max` is clamped to it rather than rejected.
	clamp_max: bool,
}

impl Bounds {
	/// `-v` and `-i`: any `intmax_t`.
	const ANY: Self = Self { min: i64::MIN, max: i64::MAX, clamp_max: false };
	/// `-l`: any non-negative count; GNU clamps oversized ones.
	const BLANK_LINES: Self = Self { min: 0, max: i64::MAX, clamp_max: true };
	/// `-w`: a positive `int`.
	const WIDTH: Self = Self { min: 1, max: i32::MAX as i64, clamp_max: false };
}

/// Parses a NUMBER the way GNU's `xnumtoimax` does: optional leading
/// whitespace and sign, then decimal digits and nothing else.
///
/// # Errors
/// [`Invalid::Fatal`] reading `<what>: 'ARG'`. Out-of-range values append
/// GNU's errno text: `ERANGE` below a finite minimum, `EOVERFLOW` above the
/// maximum or past the `i64` range.
fn parse_number(arg: &str, what: &str, bounds: Bounds) -> Result<i64, Invalid> {
	let reject = |reason: Option<&str>| {
		Invalid::Fatal(match reason {
			Some(reason) => format!("{what}: {}: {reason}", arg.quote()),
			None => format!("{what}: {}", arg.quote()),
		})
	};
	// C `isspace`, which unlike `char::is_ascii_whitespace` includes `\v`.
	let number = arg.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == '\x0b');
	let digits = number.strip_prefix(['+', '-']).unwrap_or(number);
	if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
		return Err(reject(None));
	}
	// The digits are valid, so a parse failure is an `i64` overflow.
	let Ok(value) = number.parse::<i64>() else {
		return if number.starts_with('-') {
			Err(reject(Some(if bounds.min == i64::MIN { EOVERFLOW } else { ERANGE })))
		} else if bounds.clamp_max {
			Ok(bounds.max)
		} else {
			Err(reject(Some(EOVERFLOW)))
		};
	};
	if value < bounds.min {
		Err(reject(Some(ERANGE)))
	} else if value <= bounds.max {
		Ok(value)
	} else if bounds.clamp_max {
		Ok(bounds.max)
	} else {
		Err(reject(Some(EOVERFLOW)))
	}
}

/// The `-d` delimiter unit: a lone character pairs with `:` (POSIX), anything
/// longer is used whole (GNU), and the empty string disables sections.
fn section_delimiter(arg: &[u8]) -> Vec<u8> {
	let mut unit = arg.to_vec();
	if !arg.is_empty() && mb_char_len(arg) >= arg.len() {
		unit.push(b':');
	}
	unit
}

/// Everything the options decide.
struct Settings {
	header:     Style,
	body:       Style,
	footer:     Style,
	/// One logical-page delimiter unit; empty disables section matching.
	delimiter:  Vec<u8>,
	start:      i64,
	increment:  i64,
	/// Under the `a` style, only every `join_blank`-th consecutive blank line
	/// is numbered; 0 and 1 number them all.
	join_blank: u64,
	width:      usize,
	format:     NumberFormat,
	/// Whether each section delimiter restarts numbering at `start`.
	renumber:   bool,
	separator:  Vec<u8>,
}

impl Settings {
	/// Applies the options in command-line order, as GNU's `getopt` loop does:
	/// an invalid STYLE or FORMAT is reported and parsing continues to the
	/// `--help` hint, while a malformed NUMBER or BRE ends it at once.
	///
	/// # Errors
	/// Every diagnostic gathered, newline-separated, each after the first
	/// carrying its own `nl: ` prefix (the first gets [`Host::error`]'s).
	fn from_matches(matches: &ArgMatches) -> Result<Self, String> {
		let mut settings = Self {
			header:     Style::None,
			body:       Style::NonEmpty,
			footer:     Style::None,
			delimiter:  b"\\:".to_vec(),
			start:      1,
			increment:  1,
			join_blank: 1,
			width:      6,
			format:     NumberFormat::Right,
			renumber:   !matches.get_flag(options::NO_RENUMBER),
			separator:  b"\t".to_vec(),
		};
		let mut given: Vec<(usize, &str)> = VALUED_OPTIONS
			.iter()
			.filter_map(|&id| Some((matches.index_of(id)?, id)))
			.collect();
		given.sort_unstable();

		let mut diagnostics = Vec::new();
		for (_, id) in given {
			match settings.apply(matches, id) {
				Ok(()) => {},
				Err(Invalid::Usage(message)) => diagnostics.push(message),
				Err(Invalid::Fatal(message)) => {
					diagnostics.push(message);
					return Err(diagnostics.join("\nnl: "));
				},
			}
		}
		if diagnostics.is_empty() {
			Ok(settings)
		} else {
			Err(format!("{}\nTry 'nl --help' for more information.", diagnostics.join("\nnl: ")))
		}
	}

	/// Applies the valued option `id`.
	fn apply(&mut self, matches: &ArgMatches, id: &str) -> Result<(), Invalid> {
		let text = || {
			matches
				.get_one::<String>(id)
				.expect("given options have a value")
				.as_str()
		};
		let bytes = || {
			let value = matches
				.get_one::<OsString>(id)
				.expect("given options have a value");
			os_bytes(value).ok_or_else(|| {
				Invalid::Fatal(format!(
					"invalid UTF-8 input {} encountered when converting to bytes on a platform that doesn't expose byte arguments",
					value.quote()
				))
			})
		};
		match id {
			options::HEADER_NUMBERING => self.header = Style::parse(text(), "header")?,
			options::BODY_NUMBERING => self.body = Style::parse(text(), "body")?,
			options::FOOTER_NUMBERING => self.footer = Style::parse(text(), "footer")?,
			options::STARTING_LINE_NUMBER => {
				self.start = parse_number(text(), "invalid starting line number", Bounds::ANY)?;
			},
			options::LINE_INCREMENT => {
				self.increment = parse_number(text(), "invalid line number increment", Bounds::ANY)?;
			},
			options::JOIN_BLANK_LINES => {
				let count =
					parse_number(text(), "invalid line number of blank lines", Bounds::BLANK_LINES)?;
				self.join_blank = u64::try_from(count).expect("bounded to a non-negative count");
			},
			options::NUMBER_WIDTH => {
				let width = parse_number(text(), "invalid line number field width", Bounds::WIDTH)?;
				self.width = usize::try_from(width).expect("bounded to a positive int");
			},
			options::NUMBER_FORMAT => {
				self.format = match text() {
					"ln" => NumberFormat::Left,
					"rn" => NumberFormat::Right,
					"rz" => NumberFormat::RightZero,
					other => {
						return Err(Invalid::Usage(format!(
							"invalid line numbering format: {}",
							other.quote()
						)));
					},
				};
			},
			options::NUMBER_SEPARATOR => self.separator = bytes()?.to_vec(),
			options::SECTION_DELIMITER => self.delimiter = section_delimiter(bytes()?),
			_ => unreachable!("{id} is not a valued nl option"),
		}
		Ok(())
	}

	/// The STYLE governing `section`.
	const fn style(&self, section: Section) -> &Style {
		match section {
			Section::Header => &self.header,
			Section::Body => &self.body,
			Section::Footer => &self.footer,
		}
	}
}

/// Why numbering stopped before the end of an input.
enum Stop {
	/// The shell cancelled the run and reports the status itself.
	Cancelled,
	/// Reading the operand failed; GNU reports it and moves on to the next.
	Read(io::Error),
	/// GNU exits on these: a write error, line number overflow, or a failed
	/// regex search.
	Fatal(String),
}

impl Stop {
	/// Classifies an input failure; a cancelled provider read is the shell's
	/// abort, not an error in the operand.
	fn read(error: io::Error) -> Self {
		if pi_vfs::is_cancelled(&error) { Self::Cancelled } else { Self::Read(error) }
	}

	fn write(error: io::Error) -> Self {
		Self::Fatal(format!("write error: {}", strip_errno(&error)))
	}
}

/// Numbering state, carried across operands: GNU numbers them as one stream.
struct Numberer<'s> {
	settings:  &'s Settings,
	style:     &'s Style,
	/// The next line number; `None` once adding the increment overflowed.
	next:      Option<i64>,
	/// Blank lines seen under the `a` style since one was last numbered.
	blank_run: u64,
	/// The current line, reused across reads.
	line:      Vec<u8>,
}

impl<'s> Numberer<'s> {
	fn new(settings: &'s Settings) -> Self {
		Self {
			settings,
			style: &settings.body,
			next: Some(settings.start),
			blank_run: 0,
			line: Vec::new(),
		}
	}

	/// Numbers `input` onto `out`, polling `cancel` between lines.
	fn number(
		&mut self,
		input: &mut impl BufRead,
		out: &mut impl Write,
		cancel: &AtomicBool,
	) -> Result<(), Stop> {
		let settings = self.settings;
		loop {
			if cancel.load(Ordering::Relaxed) {
				return Err(Stop::Cancelled);
			}
			self.line.clear();
			if input.read_until(b'\n', &mut self.line).map_err(Stop::read)? == 0 {
				return Ok(());
			}
			// Like GNU, complete a final line that lacks its newline.
			if self.line.last() != Some(&b'\n') {
				self.line.push(b'\n');
			}
			let text = &self.line[..self.line.len() - 1];

			if let Some(section) = Section::of(text, &settings.delimiter) {
				self.style = settings.style(section);
				if settings.renumber {
					self.next = Some(settings.start);
				}
				out.write_all(b"\n").map_err(Stop::write)?;
				continue;
			}

			if self.style.numbers(text, settings.join_blank, &mut self.blank_run)? {
				let Some(number) = self.next else {
					return Err(Stop::Fatal("line number overflow".to_owned()));
				};
				settings
					.format
					.write(out, number, settings.width)
					.and_then(|()| out.write_all(&settings.separator))
					.map_err(Stop::write)?;
				self.next = number.checked_add(settings.increment);
			} else {
				fill(out, &SPACES, settings.width + settings.separator.len()).map_err(Stop::write)?;
			}
			out.write_all(&self.line).map_err(Stop::write)?;
		}
	}
}

/// Numbers each operand in turn (`-` is standard input), reporting and
/// skipping unreadable ones as GNU does.
fn number_files(host: &mut Host, settings: &Settings, files: &[&OsString]) -> i32 {
	let cancel = host.cancel_flag();
	let mut out = host.stdout_writer();
	let mut numberer = Numberer::new(settings);
	for &file in files {
		let result = if file == "-" {
			numberer.number(&mut BufReader::new(&mut host.stdin), &mut out, &cancel)
		} else {
			match host.fs().open(host.resolve(file)) {
				Ok(input) => numberer.number(&mut BufReader::new(input), &mut out, &cancel),
				Err(error) => Err(Stop::read(error)),
			}
		};
		match result {
			Ok(()) => {},
			Err(Stop::Cancelled) => break,
			Err(Stop::Read(error)) => {
				host.error(format_args!("{}: {}", file.maybe_quote(), strip_errno(&error)), 1);
			},
			Err(Stop::Fatal(message)) => {
				let _ = out.flush();
				host.error(message, 1);
				return 1;
			},
		}
	}
	if let Err(error) = out.flush() {
		host.error(format_args!("write error: {}", strip_errno(&error)), 1);
	}
	host.exit_code()
}

/// Creates the `nl` builtin registration.
pub(crate) fn nl_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Nl, SE>()
}

#[cfg(test)]
mod tests {
	use std::{fs, path::Path};

	use super::Nl;
	use crate::host::run_util;

	fn nl(argv: &[&str], stdin: &str) -> (i32, String, String) {
		nl_in(argv, stdin, Path::new("/"))
	}

	fn nl_in(argv: &[&str], stdin: &str, cwd: &Path) -> (i32, String, String) {
		let (code, capture) = run_util::<Nl>(argv, stdin, cwd);
		(code, capture.out(), capture.err())
	}

	#[test]
	fn numbers_operands_as_one_stream_and_completes_the_last_line() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a"), "x\n\ny").unwrap();
		assert_eq!(
			nl_in(&["a", "-"], "z\n", dir.path()),
			(0, "     1\tx\n       \n     2\ty\n     3\tz\n".to_owned(), String::new())
		);
	}

	#[test]
	fn section_delimiters_switch_style_and_restart_numbering_unless_p() {
		let input = "\\:\\:\\:\nh\n\\:\\:\nb1\nb2\n\\:\nf\n";
		assert_eq!(
			nl(&["-ha", "-fn"], input),
			(0, "\n     1\th\n\n     1\tb1\n     2\tb2\n\n       f\n".to_owned(), String::new())
		);
		assert_eq!(
			nl(&["-ha", "-fa", "-p"], input),
			(0, "\n     1\th\n\n     2\tb1\n     3\tb2\n\n     4\tf\n".to_owned(), String::new())
		);
	}

	#[test]
	fn custom_section_delimiter_pairs_a_lone_character_with_colon() {
		assert_eq!(
			nl(&["-d", "X", "-ba", "-fn"], "X:\na\nX:X:\nb\n"),
			(0, "\n       a\n\n     1\tb\n".to_owned(), String::new())
		);
		assert_eq!(
			nl(&["-d", "", "-ba"], "\\:\\:\n\n"),
			(0, "     1\t\\:\\:\n     2\t\n".to_owned(), String::new())
		);
	}

	#[test]
	fn join_blank_lines_counts_only_a_style_blanks_across_delimiters() {
		assert_eq!(
			nl(&["-ba", "-l", "2"], "a\n\n\\:\\:\n\nb\n\n"),
			(0, "     1\ta\n       \n\n     1\t\n     2\tb\n       \n".to_owned(), String::new())
		);
		assert_eq!(
			nl(&["-bt", "-l", "2"], "a\n\n\nb\n"),
			(0, "     1\ta\n       \n       \n     2\tb\n".to_owned(), String::new())
		);
	}

	#[test]
	fn regex_style_uses_basic_regular_expressions() {
		assert_eq!(
			nl(&["-b", "pa\\+"], "aa\nb\na+\n"),
			(0, "     1\taa\n       b\n     2\ta+\n".to_owned(), String::new())
		);
		assert_eq!(
			nl(&["-b", "pa+"], "aa\na+\n"),
			(0, "       aa\n     1\ta+\n".to_owned(), String::new())
		);
		assert_eq!(
			nl(&["-b", "p\\(a\\)\\1"], "aa\nab\n"),
			(0, "     1\taa\n       ab\n".to_owned(), String::new())
		);
	}

	#[test]
	fn formats_pad_to_width_and_unnumbered_lines_skip_the_separator_width() {
		assert_eq!(
			nl(&["-v", "-2", "-n", "rz", "-w", "4"], "a\nb\nc\n"),
			(0, "-002\ta\n-001\tb\n0000\tc\n".to_owned(), String::new())
		);
		assert_eq!(
			nl(&["-n", "ln", "-w", "3", "-v", "9", "-i", "-10"], "a\nb\n"),
			(0, "9  \ta\n-1 \tb\n".to_owned(), String::new())
		);
		assert_eq!(
			nl(&["-s", ": "], "a\n\n"),
			(0, "     1: a\n        \n".to_owned(), String::new())
		);
	}

	#[test]
	fn unreadable_operand_is_reported_and_skipped() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a"), "x\n").unwrap();
		let (code, out, err) = nl_in(&["missing", "a"], "", dir.path());
		assert_eq!(code, 1);
		assert_eq!(out, "     1\tx\n");
		assert_eq!(err, "nl: missing: No such file or directory\n");
	}

	#[test]
	fn line_number_overflow_stops_after_the_last_representable_number() {
		assert_eq!(
			nl(&["-v", "9223372036854775807"], "a\nb\n"),
			(1, "9223372036854775807\ta\n".to_owned(), "nl: line number overflow\n".to_owned())
		);
	}

	#[test]
	fn invalid_styles_accumulate_until_a_fatal_number_error() {
		assert_eq!(
			nl(&["-b", "x", "-n", "xx"], "a\n"),
			(
				1,
				String::new(),
				"nl: invalid body numbering style: 'x'\nnl: invalid line numbering format: \
				 'xx'\nTry 'nl --help' for more information.\n"
					.to_owned()
			)
		);
		assert_eq!(
			nl(&["-b", "x", "-w", "0", "-h", "y"], "a\n"),
			(
				1,
				String::new(),
				"nl: invalid body numbering style: 'x'\nnl: invalid line number field width: '0': \
				 Numerical result out of range\n"
					.to_owned()
			)
		);
	}

	#[test]
	fn number_arguments_follow_gnu_range_rules() {
		let err = |argv: &[&str]| nl(argv, "a\n").2;
		assert_eq!(err(&["-w", "5x"]), "nl: invalid line number field width: '5x'\n");
		assert_eq!(
			err(&["-w", "2147483648"]),
			"nl: invalid line number field width: '2147483648': Value too large for defined data type\n"
		);
		assert_eq!(
			err(&["-v", "-99999999999999999999"]),
			"nl: invalid starting line number: '-99999999999999999999': Value too large for defined \
			 data type\n"
		);
		assert_eq!(
			err(&["-l", "-1"]),
			"nl: invalid line number of blank lines: '-1': Numerical result out of range\n"
		);
		assert_eq!(
			nl(&["-l", "99999999999999999999", "-w", " +2"], "a\n"),
			(0, " 1\ta\n".to_owned(), String::new())
		);
	}
}
