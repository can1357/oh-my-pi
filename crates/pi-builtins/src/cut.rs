//! `cut` builtin: print selected byte, character, or field columns.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	ffi::OsString,
	fs::File,
	io::{self, BufRead, BufReader, Read, Write},
};

use bstr::io::BufReadExt;
use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};
use uucore::{display::Quotable, line_ending::LineEnding, ranges::Range};

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes, util};

/// Parsed `cut` invocation.
pub(crate) struct Cut {
	matches: ArgMatches,
}

matches_parser!(Cut, app);

impl Utility for Cut {
	const NAME: &'static str = "cut";

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		// GNU cut accepts `-d=` as a delimiter spelling. Clap otherwise parses it
		// as an empty value assigned to `-d`.
		Ok(argv
			.into_iter()
			.map(|arg| if arg == "-d=" { OsString::from("--delimiter==") } else { arg })
			.collect())
	}

	fn run(self, host: &mut Host) -> i32 {
		if let Err(error) = cut_main(&self.matches, host) {
			host.error(error, 1);
			return 1;
		}
		host.exit_code()
	}
}

mod matcher {
use memchr::{memchr, memchr2};

// Find the next matching byte sequence positions
// Return (first, last) where haystack[first..last] corresponds to the matched
// pattern
pub trait Matcher {
	fn next_match(&self, haystack: &[u8]) -> Option<(usize, usize)>;
}

// Matches for the exact byte sequence pattern
pub struct ExactMatcher<'a> {
	needle: &'a [u8],
}

impl<'a> ExactMatcher<'a> {
	pub fn new(needle: &'a [u8]) -> Self {
		assert!(!needle.is_empty());
		Self { needle }
	}
}

impl Matcher for ExactMatcher<'_> {
	fn next_match(&self, haystack: &[u8]) -> Option<(usize, usize)> {
		let mut pos = 0usize;
		loop {
			let match_idx = memchr(self.needle[0], &haystack[pos..])?;
			let match_idx = match_idx + pos; // account for starting from pos

			if self.needle.len() == 1 || haystack[match_idx + 1..].starts_with(&self.needle[1..]) {
				return Some((match_idx, match_idx + self.needle.len()));
			}

			pos = match_idx + 1;
		}
	}
}

// Matches for any number of SPACE or TAB
pub struct WhitespaceMatcher {}

impl Matcher for WhitespaceMatcher {
	fn next_match(&self, haystack: &[u8]) -> Option<(usize, usize)> {
		let match_idx = memchr2(b' ', b'\t', haystack)?;
		let mut skip = match_idx + 1;

		while skip < haystack.len() {
			match haystack[skip] {
				b' ' | b'\t' => skip += 1,
				_ => break,
			}
		}

		Some((match_idx, skip))
	}
}

#[cfg(test)]
mod matcher_tests {

	use super::*;

	#[test]
	fn test_exact_matcher_single_byte() {
		let matcher = ExactMatcher::new(":".as_bytes());
				assert_eq!(matcher.next_match("".as_bytes()), None);
		assert_eq!(matcher.next_match(":".as_bytes()), Some((0, 1)));
		assert_eq!(matcher.next_match(":abcxyz".as_bytes()), Some((0, 1)));
		assert_eq!(matcher.next_match("abc:xyz".as_bytes()), Some((3, 4)));
		assert_eq!(matcher.next_match("abcxyz:".as_bytes()), Some((6, 7)));
		assert_eq!(matcher.next_match("abcxyz".as_bytes()), None);
			}

	#[test]
	fn test_exact_matcher_multi_bytes() {
		let matcher = ExactMatcher::new("<>".as_bytes());
				assert_eq!(matcher.next_match("".as_bytes()), None);
		assert_eq!(matcher.next_match("<>".as_bytes()), Some((0, 2)));
		assert_eq!(matcher.next_match("<>abcxyz".as_bytes()), Some((0, 2)));
		assert_eq!(matcher.next_match("abc<>xyz".as_bytes()), Some((3, 5)));
		assert_eq!(matcher.next_match("abcxyz<>".as_bytes()), Some((6, 8)));
		assert_eq!(matcher.next_match("abcxyz".as_bytes()), None);
			}

	#[test]
	fn test_whitespace_matcher_single_space() {
		let matcher = WhitespaceMatcher {};
				assert_eq!(matcher.next_match("".as_bytes()), None);
		assert_eq!(matcher.next_match(" ".as_bytes()), Some((0, 1)));
		assert_eq!(matcher.next_match("\tabcxyz".as_bytes()), Some((0, 1)));
		assert_eq!(matcher.next_match("abc\txyz".as_bytes()), Some((3, 4)));
		assert_eq!(matcher.next_match("abcxyz ".as_bytes()), Some((6, 7)));
		assert_eq!(matcher.next_match("abcxyz".as_bytes()), None);
			}

	#[test]
	fn test_whitespace_matcher_multi_spaces() {
		let matcher = WhitespaceMatcher {};
				assert_eq!(matcher.next_match("".as_bytes()), None);
		assert_eq!(matcher.next_match(" \t ".as_bytes()), Some((0, 3)));
		assert_eq!(matcher.next_match("\t\tabcxyz".as_bytes()), Some((0, 2)));
		assert_eq!(matcher.next_match("abc \txyz".as_bytes()), Some((3, 5)));
		assert_eq!(matcher.next_match("abcxyz  ".as_bytes()), Some((6, 8)));
		assert_eq!(matcher.next_match("abcxyz".as_bytes()), None);
			}
}
}

mod searcher {
use super::matcher::Matcher;

// Generic searcher that relies on a specific matcher
pub struct Searcher<'a, 'b, M: Matcher> {
	matcher:  &'a M,
	haystack: &'b [u8],
	position: usize,
}

impl<'a, 'b, M: Matcher> Searcher<'a, 'b, M> {
	pub fn new(matcher: &'a M, haystack: &'b [u8]) -> Self {
		Self { matcher, haystack, position: 0 }
	}
}

// Iterate over field delimiters
// Returns (first, last) positions of each sequence, where
// `haystack[first..last]` corresponds to the delimiter.
impl<M: Matcher> Iterator for Searcher<'_, '_, M> {
	type Item = (usize, usize);

	fn next(&mut self) -> Option<Self::Item> {
		let (first, last) = self.matcher.next_match(&self.haystack[self.position..])?;
		let result = (first + self.position, last + self.position);
		self.position += last;

		Some(result)
	}
}

#[cfg(test)]
mod exact_searcher_tests {

	use super::{super::matcher::ExactMatcher, *};

	#[test]
	fn test_normal() {
		let matcher = ExactMatcher::new("a".as_bytes());
		let iter = Searcher::new(&matcher, "a.a.a".as_bytes());
		let items: Vec<(usize, usize)> = iter.collect();
		assert_eq!(vec![(0, 1), (2, 3), (4, 5)], items);
	}

	#[test]
	fn test_empty() {
		let matcher = ExactMatcher::new("a".as_bytes());
		let iter = Searcher::new(&matcher, "".as_bytes());
		let items: Vec<(usize, usize)> = iter.collect();
		assert!(items.is_empty());
	}

	fn test_multibyte(line: &[u8], expected: &[(usize, usize)]) {
		let matcher = ExactMatcher::new("ab".as_bytes());
		let iter = Searcher::new(&matcher, line);
		let items: Vec<(usize, usize)> = iter.collect();
		assert_eq!(expected, items);
	}

	#[test]
	fn test_multibyte_normal() {
		test_multibyte("...ab...ab...".as_bytes(), &[(3, 5), (8, 10)]);
	}

	#[test]
	fn test_multibyte_needle_head_at_end() {
		test_multibyte("a".as_bytes(), &[]);
	}

	#[test]
	fn test_multibyte_starting_needle() {
		test_multibyte("ab...ab...".as_bytes(), &[(0, 2), (5, 7)]);
	}

	#[test]
	fn test_multibyte_trailing_needle() {
		test_multibyte("...ab...ab".as_bytes(), &[(3, 5), (8, 10)]);
	}

	#[test]
	fn test_multibyte_first_byte_false_match() {
		test_multibyte("aA..aCaC..ab..aD".as_bytes(), &[(10, 12)]);
	}

	#[test]
	fn test_searcher_with_exact_matcher() {
		let matcher = ExactMatcher::new("<>".as_bytes());
		let haystack = "<><>a<>b<><>cd<><>".as_bytes();
		let mut searcher = Searcher::new(&matcher, haystack);
		assert_eq!(searcher.next(), Some((0, 2)));
		assert_eq!(searcher.next(), Some((2, 4)));
		assert_eq!(searcher.next(), Some((5, 7)));
		assert_eq!(searcher.next(), Some((8, 10)));
		assert_eq!(searcher.next(), Some((10, 12)));
		assert_eq!(searcher.next(), Some((14, 16)));
		assert_eq!(searcher.next(), Some((16, 18)));
		assert_eq!(searcher.next(), None);
		assert_eq!(searcher.next(), None);
	}
}

#[cfg(test)]
mod whitespace_searcher_tests {

	use super::{super::matcher::WhitespaceMatcher, *};

	#[test]
	fn test_space() {
		let matcher = WhitespaceMatcher {};
		let iter = Searcher::new(&matcher, " . . ".as_bytes());
		let items: Vec<(usize, usize)> = iter.collect();
		assert_eq!(vec![(0, 1), (2, 3), (4, 5)], items);
	}

	#[test]
	fn test_tab() {
		let matcher = WhitespaceMatcher {};
		let iter = Searcher::new(&matcher, "\t.\t.\t".as_bytes());
		let items: Vec<(usize, usize)> = iter.collect();
		assert_eq!(vec![(0, 1), (2, 3), (4, 5)], items);
	}

	#[test]
	fn test_empty() {
		let matcher = WhitespaceMatcher {};
		let iter = Searcher::new(&matcher, "".as_bytes());
		let items: Vec<(usize, usize)> = iter.collect();
		assert!(items.is_empty());
	}

	fn test_multispace(line: &[u8], expected: &[(usize, usize)]) {
		let matcher = WhitespaceMatcher {};
		let iter = Searcher::new(&matcher, line);
		let items: Vec<(usize, usize)> = iter.collect();
		assert_eq!(expected, items);
	}

	#[test]
	fn test_multispace_normal() {
		test_multispace("...  ... \t...\t ... \t ...".as_bytes(), &[
			(3, 5),
			(8, 10),
			(13, 15),
			(18, 21),
		]);
	}

	#[test]
	fn test_multispace_begin() {
		test_multispace(" \t\t...".as_bytes(), &[(0, 3)]);
	}

	#[test]
	fn test_multispace_end() {
		test_multispace("...\t  ".as_bytes(), &[(3, 6)]);
	}

	#[test]
	fn test_searcher_with_whitespace_matcher() {
		let matcher = WhitespaceMatcher {};
		let haystack = "\t a b \t cd\t\t".as_bytes();
		let mut searcher = Searcher::new(&matcher, haystack);
		assert_eq!(searcher.next(), Some((0, 2)));
		assert_eq!(searcher.next(), Some((3, 4)));
		assert_eq!(searcher.next(), Some((5, 8)));
		assert_eq!(searcher.next(), Some((10, 12)));
		assert_eq!(searcher.next(), None);
		assert_eq!(searcher.next(), None);
	}
}
}

use matcher::{ExactMatcher, Matcher, WhitespaceMatcher};
use searcher::Searcher;

struct Options<'a> {
	out_delimiter: Option<&'a [u8]>,
	line_ending:   LineEnding,
	field_opts:    Option<FieldOptions<'a>>,
}

enum Delimiter<'a> {
	Whitespace,
	Slice(&'a [u8]),
}

struct FieldOptions<'a> {
	delimiter:      Delimiter<'a>,
	only_delimited: bool,
}

enum Mode<'a> {
	Bytes(Vec<Range>, Options<'a>),
	Characters(Vec<Range>, Options<'a>),
	Fields(Vec<Range>, Options<'a>),
}

impl Default for Delimiter<'_> {
	fn default() -> Self {
		Self::Slice(b"\t")
	}
}

fn list_to_ranges(list: &str, complement: bool) -> Result<Vec<Range>, String> {
	if complement {
		Range::from_list(list).map(|r| uucore::ranges::complement(&r))
	} else {
		Range::from_list(list)
	}
}

fn cut_bytes<R: Read, W: Write>(
	reader: R,
	out: &mut W,
	ranges: &[Range],
	opts: &Options,
) -> io::Result<()> {
	let newline_char = opts.line_ending.into();
	let mut buf_in = BufReader::new(reader);
	let out_delim = opts.out_delimiter.unwrap_or(b"\t");

	let result = buf_in.for_byte_record(newline_char, |line| {
		let mut print_delim = false;
		for &Range { low, high } in ranges {
			if low > line.len() {
				break;
			}
			if print_delim {
				out.write_all(out_delim)?;
			} else if opts.out_delimiter.is_some() {
				print_delim = true;
			}
			// change `low` from 1-indexed value to 0-index value
			let low = low - 1;
			let high = high.min(line.len());
			out.write_all(&line[low..high])?;
		}
		out.write_all(&[newline_char])?;
		Ok(true)
	});

	result.map(|_| ())
}

/// Output delimiter is explicitly specified
fn cut_fields_explicit_out_delim<R: Read, W: Write, M: Matcher>(
	reader: R,
	out: &mut W,
	matcher: &M,
	ranges: &[Range],
	only_delimited: bool,
	newline_char: u8,
	out_delim: &[u8],
) -> io::Result<()> {
	let mut buf_in = BufReader::new(reader);

	let result = buf_in.for_byte_record_with_terminator(newline_char, |line| {
		let mut fields_pos = 1;
		let mut low_idx = 0;
		let mut delim_search = Searcher::new(matcher, line).peekable();
		let mut print_delim = false;

		if delim_search.peek().is_none() {
			if !only_delimited {
				// Always write the entire line, even if it doesn't end with `newline_char`
				out.write_all(line)?;
				if line.is_empty() || line[line.len() - 1] != newline_char {
					out.write_all(&[newline_char])?;
				}
			}

			return Ok(true);
		}

		for &Range { low, high } in ranges {
			if low - fields_pos > 0 {
				// current field is not in the range, so jump to the field corresponding to the
				// beginning of the range if any
				low_idx = match delim_search.nth(low - fields_pos - 1) {
					Some((_, last)) => last,
					None => break,
				};
			}

			// at this point, current field is the first in the range
			for _ in 0..=high - low {
				// skip printing delimiter if this is the first matching field for this line
				if print_delim {
					out.write_all(out_delim)?;
				} else {
					print_delim = true;
				}

				if let Some((first, last)) = delim_search.next() {
					// print the current field up to the next field delim
					let segment = &line[low_idx..first];

					out.write_all(segment)?;

					low_idx = last;
					fields_pos = high + 1;
				} else {
					// this is the last field in the line, so print the rest
					let segment = &line[low_idx..];

					out.write_all(segment)?;

					if line[line.len() - 1] == newline_char {
						return Ok(true);
					}
					break;
				}
			}
		}

		out.write_all(&[newline_char])?;
		Ok(true)
	});

	result.map(|_| ())
}

/// Output delimiter is the same as input delimiter
fn cut_fields_implicit_out_delim<R: Read, W: Write, M: Matcher>(
	reader: R,
	out: &mut W,
	matcher: &M,
	ranges: &[Range],
	only_delimited: bool,
	newline_char: u8,
) -> io::Result<()> {
	let mut buf_in = BufReader::new(reader);

	let result = buf_in.for_byte_record_with_terminator(newline_char, |line| {
		let mut fields_pos = 1;
		let mut low_idx = 0;
		let mut delim_search = Searcher::new(matcher, line).peekable();
		let mut print_delim = false;

		if delim_search.peek().is_none() {
			if !only_delimited {
				// Always write the entire line, even if it doesn't end with `newline_char`
				out.write_all(line)?;
				if line.is_empty() || line[line.len() - 1] != newline_char {
					out.write_all(&[newline_char])?;
				}
			}

			return Ok(true);
		}

		for &Range { low, high } in ranges {
			if low - fields_pos > 0 {
				if let Some((first, last)) = delim_search.nth(low - fields_pos - 1) {
					low_idx = if print_delim { first } else { last }
				} else {
					break;
				}
			}

			if let Some((first, _)) = delim_search.nth(high - low) {
				let segment = &line[low_idx..first];

				out.write_all(segment)?;

				print_delim = true;
				low_idx = first;
				fields_pos = high + 1;
			} else {
				let segment = &line[low_idx..line.len()];

				out.write_all(segment)?;

				if line[line.len() - 1] == newline_char {
					return Ok(true);
				}
				break;
			}
		}
		out.write_all(&[newline_char])?;
		Ok(true)
	});

	result.map(|_| ())
}

/// Streams and filters fields where the record terminator and
/// field delimiter are the same character (specified by `newline_char`)
fn cut_fields_newline_char_delim<R: Read, W: Write>(
	reader: R,
	out: &mut W,
	ranges: &[Range],
	newline_char: u8,
	out_delim: &[u8],
	only_delimited: bool,
) -> io::Result<()> {
	let mut reader = BufReader::new(reader);
	let mut line = Vec::new();

	// We start at 1 because 'cut' field indexing is 1-based
	let mut current_field_idx = 1;
	let mut first_field_printed = false;
	let mut has_data = false;
	let mut suppressed = false;

	let mut range_idx = 0;

	loop {
		line.clear();

		let is_selected = range_idx < ranges.len() && current_field_idx >= ranges[range_idx].low;
		let needs_data = is_selected || current_field_idx == 1;

		let mut has_processed_data = false;

		if needs_data {
			// Standard read: copies bytes into `line`
			loop {
				let buf = reader.fill_buf()?;
				if buf.is_empty() {
					break;
				}

				has_processed_data = true;

				if let Some(pos) = memchr::memchr(newline_char, buf) {
					let amt = pos + 1;
					line.extend_from_slice(&buf[..amt]);
					reader.consume(amt);

					break;
				}
				let len = buf.len();
				line.extend_from_slice(buf);
				reader.consume(len);
			}
		} else {
			// Zero-allocation skip: scans the buffer and advances the cursor without
			// copying
			loop {
				let buf = reader.fill_buf()?;
				if buf.is_empty() {
					break; // EOF
				}

				has_processed_data = true;

				if let Some(pos) = memchr::memchr(newline_char, buf) {
					let bytes_to_consume = pos + 1;
					reader.consume(bytes_to_consume);
					break;
				}

				let len = buf.len();
				reader.consume(len);
			}
		}

		if !has_processed_data {
			break;
		}
		has_data = true;

		// To comply with -s when the stream consists of only a single field.
		if current_field_idx == 1 {
			let is_eof_next = reader.fill_buf()?.is_empty();

			if is_eof_next && line.last() != Some(&newline_char) {
				if only_delimited {
					suppressed = true;
				} else {
					// GNU cut prints the whole line if no delimiter is found.
					out.write_all(&line)?;
				}
				break;
			}
		}

		if range_idx < ranges.len() && current_field_idx > ranges[range_idx].high {
			range_idx += 1;

			// EARLY EXIT: If we've exhausted all ranges, stop reading the stream entirely.
			if range_idx == ranges.len() {
				break;
			}
		}

		// Check if the current field falls inside the current active range
		let is_selected = range_idx < ranges.len() && current_field_idx >= ranges[range_idx].low;

		if is_selected {
			if first_field_printed {
				out.write_all(out_delim)?;
			}

			let has_newline = line.last() == Some(&newline_char);
			let content = if has_newline {
				&line[..line.len() - 1]
			} else {
				&line[..]
			};

			out.write_all(content)?;
			first_field_printed = true;
		}

		current_field_idx += 1;
	}

	if has_data && !suppressed {
		out.write_all(&[newline_char])?;
	}

	Ok(())
}

fn cut_fields<R: Read, W: Write>(
	reader: R,
	out: &mut W,
	ranges: &[Range],
	opts: &Options,
) -> io::Result<()> {
	let newline_char = opts.line_ending.into();
	let field_opts = opts.field_opts.as_ref().unwrap(); // it is safe to unwrap() here - field_opts will always be Some() for cut_fields() call
	match field_opts.delimiter {
		Delimiter::Slice(delim) if delim == [newline_char] => {
			let out_delim = opts.out_delimiter.unwrap_or(delim);
			cut_fields_newline_char_delim(
				reader,
				out,
				ranges,
				newline_char,
				out_delim,
				field_opts.only_delimited,
			)
		},
		Delimiter::Slice(delim) => {
			let matcher = ExactMatcher::new(delim);
			match opts.out_delimiter {
				Some(out_delim) => cut_fields_explicit_out_delim(
					reader,
					out,
					&matcher,
					ranges,
					field_opts.only_delimited,
					newline_char,
					out_delim,
				),
				None => cut_fields_implicit_out_delim(
					reader,
					out,
					&matcher,
					ranges,
					field_opts.only_delimited,
					newline_char,
				),
			}
		},
		Delimiter::Whitespace => {
			let matcher = WhitespaceMatcher {};
			cut_fields_explicit_out_delim(
				reader,
				out,
				&matcher,
				ranges,
				field_opts.only_delimited,
				newline_char,
				opts.out_delimiter.unwrap_or(b"\t"),
			)
		},
	}
}

fn cut_files<'a, I>(host: &mut Host, filenames: I, mode: &Mode)
where
	I: IntoIterator<Item = &'a OsString>,
{
	let inputs = filenames
		.into_iter()
		.map(|name| {
			let path = if name == "-" { None } else { Some(host.resolve(name)) };
			(name, path)
		})
		.collect::<Vec<_>>();
	let mut stdin_read = false;
	let mut failed = false;
	let mut out = host.stdout_writer();

	for (filename, path) in inputs {
		let result = if let Some(path) = path {
			File::open(path)
				.map_err(|error| io::Error::new(error.kind(), format!("{}: {error}", filename.maybe_quote())))
				.and_then(|file| match mode {
					Mode::Bytes(ranges, opts) | Mode::Characters(ranges, opts) => {
						cut_bytes(file, &mut out, ranges, opts)
					},
					Mode::Fields(ranges, opts) => cut_fields(file, &mut out, ranges, opts),
				})
		} else if stdin_read {
			continue;
		} else {
			stdin_read = true;
			match mode {
				Mode::Bytes(ranges, opts) | Mode::Characters(ranges, opts) => {
					cut_bytes(&mut host.stdin, &mut out, ranges, opts)
				},
				Mode::Fields(ranges, opts) => cut_fields(&mut host.stdin, &mut out, ranges, opts),
			}
		};
		if let Err(error) = result {
			let _ = writeln!(host.stderr, "cut: {error}");
			failed = true;
		}
	}

	if let Err(error) = out.flush() {
		let _ = writeln!(host.stderr, "cut: write error: {error}");
		failed = true;
	}
	drop(out);
	if failed {
		host.fail(1);
	}
}

/// Gets input and output delimiters, accepting non-UTF-8 bytes like GNU `cut`.
fn get_delimiters(matches: &ArgMatches) -> Result<(Delimiter<'_>, Option<&[u8]>), String> {
	let whitespace_delimited = matches.get_flag(options::WHITESPACE_DELIMITED);
	let delim_opt = matches.get_one::<OsString>(options::DELIMITER);
	let delim = match delim_opt {
		Some(_) if whitespace_delimited => {
			return Err(
				"invalid input: Only one of --delimiter (-d) or -w option can be specified".into(),
			);
		},
		Some(os_string) => {
			if os_string.is_empty() {
				Delimiter::Slice(b"\0")
			} else {
				let bytes = os_bytes(os_string)
					.ok_or_else(|| format!("invalid argument {}", os_string.maybe_quote()))?;
				if os_string.to_str().is_some_and(|s| s.chars().count() > 1)
					|| os_string.to_str().is_none() && bytes.len() > 1
				{
					return Err("the delimiter must be a single character".into());
				}
				Delimiter::Slice(bytes)
			}
		},
		None if whitespace_delimited => Delimiter::Whitespace,
		None => Delimiter::default(),
	};
	let out_delim = matches
		.get_one::<OsString>(options::OUTPUT_DELIMITER)
		.map(|value| {
			if value.is_empty() {
				Ok(&b"\0"[..])
			} else {
				os_bytes(value)
					.ok_or_else(|| format!("invalid argument {}", value.maybe_quote()))
			}
		})
		.transpose()?;
	Ok((delim, out_delim))
}

mod options {
	pub const BYTES: &str = "bytes";
	pub const CHARACTERS: &str = "characters";
	pub const DELIMITER: &str = "delimiter";
	pub const FIELDS: &str = "fields";
	pub const ZERO_TERMINATED: &str = "zero-terminated";
	pub const ONLY_DELIMITED: &str = "only-delimited";
	pub const OUTPUT_DELIMITER: &str = "output-delimiter";
	pub const WHITESPACE_DELIMITED: &str = "whitespace-delimited";
	pub const COMPLEMENT: &str = "complement";
	pub const FILE: &str = "file";
	// ignored option
	pub const NOTHING: &str = "nothing";
}

fn cut_main(matches: &ArgMatches, host: &mut Host) -> Result<(), String> {
	let complement = matches.get_flag(options::COMPLEMENT);
	let only_delimited = matches.get_flag(options::ONLY_DELIMITED);
	let (delimiter, out_delimiter) = get_delimiters(matches)?;
	let line_ending = LineEnding::from_zero_flag(matches.get_flag(options::ZERO_TERMINATED));

	// Only one, and only one of cutting mode arguments, i.e. `-b`, `-c`, `-f`,
	// is expected. Count occurrences because repeated modes are an error.
	let mode_args_count = [
		matches.indices_of(options::BYTES),
		matches.indices_of(options::CHARACTERS),
		matches.indices_of(options::FIELDS),
	]
	.into_iter()
	.map(|indices| indices.unwrap_or_default().count())
	.sum();

	let mode_parse = match (
		mode_args_count,
		matches.get_one::<String>(options::BYTES),
		matches.get_one::<String>(options::CHARACTERS),
		matches.get_one::<String>(options::FIELDS),
	) {
		(1, Some(ranges), None, None) => list_to_ranges(ranges, complement).map(|ranges| {
			Mode::Bytes(ranges, Options { out_delimiter, line_ending, field_opts: None })
		}),
		(1, None, Some(ranges), None) => list_to_ranges(ranges, complement).map(|ranges| {
			Mode::Characters(ranges, Options { out_delimiter, line_ending, field_opts: None })
		}),
		(1, None, None, Some(ranges)) => list_to_ranges(ranges, complement).map(|ranges| {
			Mode::Fields(ranges, Options {
				out_delimiter,
				line_ending,
				field_opts: Some(FieldOptions { delimiter, only_delimited }),
			})
		}),
		(2.., ..) => Err(
			"invalid usage: expects no more than one of --fields (-f), --chars (-c) or --bytes (-b)"
				.to_owned(),
		),
		_ => Err(
			"invalid usage: expects one of --fields (-f), --chars (-c) or --bytes (-b)".to_owned(),
		),
	};

	let mode = match mode_parse? {
		Mode::Bytes(..) | Mode::Characters(..) if matches.contains_id(options::DELIMITER) => {
			return Err(
				"invalid input: The '--delimiter' ('-d') option can only be used when printing a sequence of fields"
					.into(),
			);
		},
		Mode::Bytes(..) | Mode::Characters(..)
			if matches.get_flag(options::WHITESPACE_DELIMITED) =>
		{
			return Err(
				"invalid input: The '-w' option can only be used when printing a sequence of fields".into(),
			);
		},
		Mode::Bytes(..) | Mode::Characters(..) if matches.get_flag(options::ONLY_DELIMITED) => {
			return Err(
				"invalid input: The '--only-delimited' ('-s') option can only be used when printing a sequence of fields"
					.into(),
			);
		},
		mode => mode,
	};
	let files = matches
		.get_many::<OsString>(options::FILE)
		.expect("clap provides '-' by default");
	cut_files(host, files, &mode);
	Ok(())
}

fn app() -> Command {
	Command::new(Cut::NAME)
		.version("0.8.0")
		.override_usage(format_usage("cut OPTION... [FILE]..."))
		.about("Print specified byte or field columns from each line of stdin or input files")
		.after_help(
			"Each invocation must specify exactly one of --bytes, --characters, or --fields. Use - \
			 as a file operand to read standard input.",
		)
		.infer_long_args(true)
		// While `args_override_self(true)` for some arguments, such as `-d`
		// and `--output-delimiter`, is consistent to the behavior of GNU cut,
		// arguments related to cutting mode, i.e. `-b`, `-c`, `-f`, should
		// cause an error when there is more than one of them, as described in
		// the manual of GNU cut: "Use one, and only one of -b, -c or -f".
		// `ArgAction::Append` is used on `-b`, `-c`, `-f` arguments, so that
		// the occurrences of those could be counted and be handled accordingly.
		.args_override_self(true)
		.arg(
			Arg::new(options::BYTES)
				.short('b')
				.long(options::BYTES)
				.help("filter byte columns from the input source")
				.allow_hyphen_values(true)
				.value_name("LIST")
				.action(ArgAction::Append),
		)
		.arg(
			Arg::new(options::CHARACTERS)
				.short('c')
				.long(options::CHARACTERS)
				.help("alias for character mode")
				.allow_hyphen_values(true)
				.value_name("LIST")
				.action(ArgAction::Append),
		)
		.arg(
			Arg::new(options::DELIMITER)
				.short('d')
				.long(options::DELIMITER)
				.value_parser(ValueParser::os_string())
				.help(
					"specify the delimiter character that separates fields in the input source \
					 (default: Tab)",
				)
				.value_name("DELIM"),
		)
		.arg(
			Arg::new(options::WHITESPACE_DELIMITED)
				.short('w')
				.help(
					"use any amount of whitespace (Space, Tab) to separate fields (FreeBSD extension)",
				)
				.value_name("WHITESPACE")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::FIELDS)
				.short('f')
				.long(options::FIELDS)
				.help("filter field columns from the input source")
				.allow_hyphen_values(true)
				.value_name("LIST")
				.action(ArgAction::Append),
		)
		.arg(
			Arg::new(options::COMPLEMENT)
				.long(options::COMPLEMENT)
				.help("invert the filter, displaying all but the selected columns")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::ONLY_DELIMITED)
				.short('s')
				.long(options::ONLY_DELIMITED)
				.help("in field mode, only print lines which contain the delimiter")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::ZERO_TERMINATED)
				.short('z')
				.long(options::ZERO_TERMINATED)
				.help("filter records separated by NUL instead of newline")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::OUTPUT_DELIMITER)
				.long(options::OUTPUT_DELIMITER)
				.value_parser(ValueParser::os_string())
				.help("in field mode, replace the delimiter in output lines with this argument")
				.value_name("NEW_DELIM"),
		)
		.arg(
			Arg::new(options::FILE)
				.hide(true)
				.action(ArgAction::Append)
				.value_hint(clap::ValueHint::FilePath)
				.default_value("-")
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(options::NOTHING)
				.short('n')
				.help("(ignored)")
				.action(ArgAction::SetTrue),
		)
}

/// Creates the `cut` builtin registration.
pub(crate) fn cut_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Cut, SE>()
}

#[cfg(test)]
mod integration_tests {
	use super::Cut;
	use crate::host::run_util;

	#[test]
	fn reads_default_operand_from_stdin() {
		let (code, capture) = run_util::<Cut>(&["-f", "2", "-d", ":"], "left:right\n", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "right\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn resolves_file_operands_against_shell_cwd() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("input"), b"abcdef\n").unwrap();
		let (code, capture) = run_util::<Cut>(&["-b", "2-4", "input"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "bcd\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn missing_mode_is_an_error() {
		let (code, capture) = run_util::<Cut>(&[], "", "/");
		assert_eq!(code, 1);
		assert_eq!(
			capture.err(),
			"cut: invalid usage: expects one of --fields (-f), --chars (-c) or --bytes (-b)\n"
		);
	}
}
