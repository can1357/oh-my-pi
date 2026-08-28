//! `paste` builtin: merge corresponding or successive lines of files.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	cell::RefCell,
	ffi::OsString,
	fs::File,
	io::{self, BufRead, BufReader, Read, Write},
	iter::Cycle,
	rc::Rc,
	slice::Iter,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use uucore::{display::Quotable, i18n::charmap::mb_char_len};

use crate::host::{Host, Stdin, Utility, format_usage, matches_parser, os_bytes, util};

mod options {
	pub const DELIMITER: &str = "delimiters";
	pub const SERIAL: &str = "serial";
	pub const FILE: &str = "file";
	pub const ZERO_TERMINATED: &str = "zero-terminated";
}

/// Parsed `paste` invocation.
pub(crate) struct Paste {
	matches: ArgMatches,
}

matches_parser!(Paste, app);

impl Utility for Paste {
	const NAME: &'static str = "paste";

	fn run(self, host: &mut Host) -> i32 {
		let serial = self.matches.get_flag(options::SERIAL);
		let delimiters = self
			.matches
			.get_one::<OsString>(options::DELIMITER)
			.expect("delimiter has a default")
			.clone();
		let files = self
			.matches
			.get_many::<OsString>(options::FILE)
			.expect("file has a default")
			.cloned()
			.collect();
		let line_ending = if self.matches.get_flag(options::ZERO_TERMINATED) {
			b'\0'
		} else {
			b'\n'
		};

		match paste(host, files, serial, &delimiters, line_ending) {
			Ok(()) => host.exit_code(),
			Err(err) => {
				host.error(err, 1);
				1
			},
		}
	}
}

/// The `paste` argument model.
fn app() -> Command {
	Command::new(Paste::NAME)
		.version("0.8.0")
		.about("Merge lines of files")
		.override_usage(format_usage("paste [OPTION]... [FILE]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(options::SERIAL)
				.long(options::SERIAL)
				.short('s')
				.help("paste one file at a time instead of in parallel")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DELIMITER)
				.long(options::DELIMITER)
				.short('d')
				.help("reuse characters from LIST instead of TABs")
				.value_name("LIST")
				.default_value("\t")
				.hide_default_value(true)
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(options::FILE)
				.value_name("FILE")
				.action(ArgAction::Append)
				.default_value("-")
				.value_hint(clap::ValueHint::FilePath)
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(options::ZERO_TERMINATED)
				.long(options::ZERO_TERMINATED)
				.short('z')
				.help("line delimiter is NUL, not newline")
				.action(ArgAction::SetTrue),
		)
}

fn paste(
	host: &mut Host,
	filenames: Vec<OsString>,
	serial: bool,
	delimiters: &OsString,
	line_ending: u8,
) -> Result<(), String> {
	let delimiters = parse_delimiters(delimiters)?;
	let mut prepared = Vec::with_capacity(filenames.len());
	for filename in filenames {
		if filename == "-" {
			prepared.push(PreparedSource::StandardInput);
		} else {
			let file = File::open(host.resolve(&filename)).map_err(|err| {
				format!("{}: {}", filename.to_string_lossy(), strip_errno(&err))
			})?;
			prepared.push(PreparedSource::File(BufReader::new(file)));
		}
	}

	let stdin = Rc::new(RefCell::new(BufReader::new(&mut host.stdin)));
	let mut sources = prepared
		.into_iter()
		.map(|source| match source {
			PreparedSource::File(reader) => InputSource::File(reader),
			PreparedSource::StandardInput => InputSource::StandardInput(Rc::clone(&stdin)),
		})
		.collect::<Vec<_>>();

	let source_count = sources.len();
	let stdout = &mut host.stdout;
	if !serial && source_count == 1 {
		return write_single_input_source(stdout, sources.pop().unwrap(), line_ending)
			.map_err(|err| strip_errno(&err));
	}

	let mut delimiter_state = DelimiterState::new(&delimiters);
	let mut output = Vec::new();
	if serial {
		for source in &mut sources {
			output.clear();
			loop {
				if source.read_until(line_ending, &mut output).map_err(|err| strip_errno(&err))?
					== 0
				{
					break;
				}
				remove_trailing_line_ending(line_ending, &mut output);
				delimiter_state.write_delimiter(&mut output);
			}
			delimiter_state.remove_trailing_delimiter(&mut output);
			stdout.write_all(&output).map_err(|err| strip_errno(&err))?;
			stdout.write_all(&[line_ending]).map_err(|err| strip_errno(&err))?;
		}
	} else {
		let mut eof = vec![false; source_count];
		loop {
			output.clear();
			let mut eof_count = 0;
			for (i, source) in sources.iter_mut().enumerate() {
				if eof[i] {
					eof_count += 1;
				} else if source
					.read_until(line_ending, &mut output)
					.map_err(|err| strip_errno(&err))?
					== 0
				{
					eof[i] = true;
					eof_count += 1;
				} else {
					remove_trailing_line_ending(line_ending, &mut output);
				}
				delimiter_state.write_delimiter(&mut output);
			}
			if eof_count == source_count {
				break;
			}
			delimiter_state.remove_trailing_delimiter(&mut output);
			stdout.write_all(&output).map_err(|err| strip_errno(&err))?;
			stdout.write_all(&[line_ending]).map_err(|err| strip_errno(&err))?;
			delimiter_state.reset_to_first_delimiter();
		}
	}
	Ok(())
}

fn write_single_input_source(
	writer: &mut impl Write,
	mut source: InputSource<'_>,
	line_ending: u8,
) -> io::Result<()> {
	let mut buffer = [0_u8; 8192];
	let mut has_data = false;
	let mut last_byte = line_ending;
	loop {
		let count = source.read(&mut buffer)?;
		if count == 0 {
			break;
		}
		has_data = true;
		last_byte = buffer[count - 1];
		writer.write_all(&buffer[..count])?;
	}
	if has_data && last_byte != line_ending {
		writer.write_all(&[line_ending])?;
	}
	Ok(())
}

fn parse_delimiters(delimiters: &OsString) -> Result<Box<[Box<[u8]>]>, String> {
	let bytes = os_bytes(delimiters).ok_or_else(|| {
		format!(
			"invalid UTF-8 input {} encountered when converting to bytes on a platform that doesn't expose byte arguments",
			delimiters.quote()
		)
	})?;
	let mut result = Vec::<Box<[u8]>>::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'\\' {
			i += 1;
			if i >= bytes.len() {
				return Err(format!(
					"delimiter list ends with an unescaped backslash: {}",
					delimiters.to_string_lossy()
				));
			}
			match bytes[i] {
				b'0' => result.push(Box::new([])),
				b'\\' => result.push(Box::new(*b"\\")),
				b'n' => result.push(Box::new(*b"\n")),
				b't' => result.push(Box::new(*b"\t")),
				b'b' => result.push(Box::new(*b"\x08")),
				b'f' => result.push(Box::new(*b"\x0c")),
				b'r' => result.push(Box::new(*b"\r")),
				b'v' => result.push(Box::new(*b"\x0b")),
				_ => {
					let len = mb_char_len(&bytes[i..]).min(bytes.len() - i);
					result.push(Box::from(&bytes[i..i + len]));
					i += len;
					continue;
				},
			}
			i += 1;
		} else {
			let len = mb_char_len(&bytes[i..]).min(bytes.len() - i);
			result.push(Box::from(&bytes[i..i + len]));
			i += len;
		}
	}
	Ok(result.into_boxed_slice())
}

fn remove_trailing_line_ending(line_ending: u8, output: &mut Vec<u8>) {
	if output.last() == Some(&line_ending) {
		output.pop();
	}
}

enum DelimiterState<'a> {
	NoDelimiters,
	OneDelimiter(&'a [u8]),
	MultipleDelimiters {
		current:    &'a [u8],
		delimiters: &'a [Box<[u8]>],
		iterator:   Cycle<Iter<'a, Box<[u8]>>>,
	},
}

impl<'a> DelimiterState<'a> {
	fn new(delimiters: &'a [Box<[u8]>]) -> Self {
		match delimiters {
			[] => Self::NoDelimiters,
			[only] if only.is_empty() => Self::NoDelimiters,
			[only] => Self::OneDelimiter(only),
			[first, ..] => Self::MultipleDelimiters {
				current: first,
				delimiters,
				iterator: delimiters.iter().cycle(),
			},
		}
	}

	fn reset_to_first_delimiter(&mut self) {
		if let Self::MultipleDelimiters { delimiters, iterator, .. } = self {
			*iterator = delimiters.iter().cycle();
		}
	}

	fn remove_trailing_delimiter(&self, output: &mut Vec<u8>) {
		let len = match self {
			Self::NoDelimiters => return,
			Self::OneDelimiter(d) => d.len(),
			Self::MultipleDelimiters { current, .. } => current.len(),
		};
		if len > 0 {
			output.truncate(output.len().saturating_sub(len));
		}
	}

	fn write_delimiter(&mut self, output: &mut Vec<u8>) {
		match self {
			Self::NoDelimiters => {},
			Self::OneDelimiter(d) => output.extend_from_slice(d),
			Self::MultipleDelimiters { current, iterator, .. } => {
				let d = iterator.next().unwrap();
				output.extend_from_slice(d);
				*current = d;
			},
		}
	}
}

enum PreparedSource {
	File(BufReader<File>),
	StandardInput,
}

enum InputSource<'a> {
	File(BufReader<File>),
	StandardInput(Rc<RefCell<BufReader<&'a mut Stdin>>>),
}

impl Read for InputSource<'_> {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		match self {
			Self::File(reader) => reader.read(buf),
			Self::StandardInput(stdin) => stdin.borrow_mut().read(buf),
		}
	}
}

impl BufRead for InputSource<'_> {
	fn fill_buf(&mut self) -> io::Result<&[u8]> {
		match self {
			Self::File(reader) => reader.fill_buf(),
			Self::StandardInput(_) => Err(io::Error::other(
				"standard input does not support direct buffer access",
			)),
		}
	}

	fn consume(&mut self, amount: usize) {
		if let Self::File(reader) = self {
			reader.consume(amount);
		}
	}

	fn read_until(&mut self, byte: u8, buf: &mut Vec<u8>) -> io::Result<usize> {
		match self {
			Self::File(reader) => reader.read_until(byte, buf),
			Self::StandardInput(stdin) => stdin.borrow_mut().read_until(byte, buf),
		}
	}
}

fn strip_errno(error: &io::Error) -> String {
	let mut message = error.to_string();
	if let Some(position) = message.find(" (os error ") {
		message.truncate(position);
	}
	message
}

/// Creates the `paste` builtin registration.
pub(crate) fn paste_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Paste, SE>()
}

#[cfg(test)]
mod tests {
	use std::{fs, path::Path};

	use super::Paste;
	use crate::host::run_util;

	fn paste(argv: &[&str], stdin: &str, cwd: &Path) -> (i32, Vec<u8>, String) {
		let (code, capture) = run_util::<Paste>(argv, stdin, cwd);
		(code, capture.stdout(), capture.err())
	}

	#[test]
	fn merges_files_in_parallel_and_cycles_delimiters() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a"), "a1\na2\n").unwrap();
		fs::write(dir.path().join("b"), "b1\nb2\n").unwrap();
		fs::write(dir.path().join("c"), "c1\nc2\n").unwrap();
		assert_eq!(
			paste(&["-d", ",:", "a", "b", "c"], "", dir.path()),
			(0, b"a1,b1:c1\na2,b2:c2\n".to_vec(), String::new())
		);
	}

	#[test]
	fn serial_mode_pastes_each_file_separately() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a"), "a1\na2\n").unwrap();
		fs::write(dir.path().join("b"), "b1\nb2\n").unwrap();
		assert_eq!(
			paste(&["-s", "-d", ",", "a", "b"], "", dir.path()),
			(0, b"a1,a2\nb1,b2\n".to_vec(), String::new())
		);
	}

	#[test]
	fn repeated_stdin_operands_consume_successive_lines() {
		assert_eq!(
			paste(&["-", "-"], "first\nsecond\n", Path::new("/")),
			(0, b"first\tsecond\n".to_vec(), String::new())
		);
	}

	#[test]
	fn zero_terminated_mode_uses_nul_for_input_and_output() {
		assert_eq!(
			paste(&["-z", "-d", ","], "a\0b", Path::new("/")),
			(0, b"a\0b\0".to_vec(), String::new())
		);
	}

	#[test]
	fn zero_delimiter_escape_joins_without_separator() {
		assert_eq!(
			paste(&["-s", "-d", "\\0"], "a\nb\n", Path::new("/")),
			(0, b"ab\n".to_vec(), String::new())
		);
	}

	#[test]
	fn reports_trailing_backslash_in_delimiter_list() {
		let (code, _, err) = paste(&["-d", "\\"], "", Path::new("/"));
		assert_eq!(code, 1);
		assert_eq!(err, "paste: delimiter list ends with an unescaped backslash: \\\n");
	}

	#[test]
	fn resolves_relative_file_operands_against_shell_cwd() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("input"), "line").unwrap();
		assert_eq!(
			paste(&["input"], "", dir.path()),
			(0, b"line\n".to_vec(), String::new())
		);
	}
}
