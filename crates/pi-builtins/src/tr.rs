//! `tr` builtin: translate, squeeze, or delete bytes from standard input.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{ffi::OsString, io::{BufReader, Write}};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, value_parser};
use uucore::display::Quotable;

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes, util};
use operation::{
	DeleteOperation, Sequence, SqueezeOperation, SymbolTranslator, TranslateOperation, flush_output,
	translate_input,
};
use simd::process_input;

mod unicode_table {
pub static BEL: u8 = 0x7;
pub static BS: u8 = 0x8;
pub static HT: u8 = 0x9;
pub static LF: u8 = 0xa;
pub static VT: u8 = 0xb;
pub static FF: u8 = 0xc;
pub static CR: u8 = 0xd;
pub static SPACE: u8 = 0x20;
pub static SPACES: &[u8] = &[HT, LF, VT, FF, CR, SPACE];
pub static BLANK: &[u8] = &[HT, SPACE];
}

mod simd {
//! I/O processing infrastructure for tr operations with SIMD optimizations

use std::io::{BufRead, Write};


use super::operation::ChunkProcessor;

/// Helper to detect single-character operations for optimization
pub fn find_single_change<T, F>(table: &[T; 256], check: F) -> Option<(u8, T)>
where
	F: Fn(usize, &T) -> bool,
	T: Copy,
{
	let matches: Vec<_> = table
		.iter()
		.enumerate()
		.filter_map(|(i, val)| check(i, val).then_some((i as u8, *val)))
		.take(2)
		.collect();

	(matches.len() == 1).then(|| matches[0])
}

/// SIMD-optimized single character replacement
#[inline]
pub fn process_single_char_replace(
	input: &[u8],
	output: &mut Vec<u8>,
	source_char: u8,
	target_char: u8,
) {
	let count = bytecount::count(input, source_char);
	if count == 0 {
		output.extend_from_slice(input);
	} else if count == input.len() {
		output.resize(output.len() + input.len(), target_char);
	} else {
		output.extend(
			input
				.iter()
				.map(|&b| if b == source_char { target_char } else { b }),
		);
	}
}

/// SIMD-optimized delete operation for single character
pub fn process_single_delete(input: &[u8], output: &mut Vec<u8>, delete_char: u8) {
	let count = bytecount::count(input, delete_char);
	if count == 0 {
		output.extend_from_slice(input);
	} else if count < input.len() {
		output.extend(input.iter().filter(|&&b| b != delete_char).copied());
	}
	// If count == input.len(), all deleted, output nothing
}

/// Unified I/O processing for all operations
pub fn process_input<R, W, P>(
	input: &mut R,
	output: &mut W,
	processor: &P,
) -> Result<(), String>
where
	R: BufRead,
	W: Write,
	P: ChunkProcessor + ?Sized,
{
	const BUFFER_SIZE: usize = 32768;
	let mut buf = [0; BUFFER_SIZE];
	let mut output_buf = Vec::with_capacity(BUFFER_SIZE);

	loop {
		let length = match input.read(&mut buf[..]) {
			Ok(0) => break,
			Ok(len) => len,
			Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
			Err(e) => return Err(format!("read error: {e}")),
		};

		output_buf.clear();
		processor.process_chunk(&buf[..length], &mut output_buf);

		if !output_buf.is_empty() {
			write_output(output, &output_buf)?;
		}
	}

	Ok(())
}

/// Helper function to handle platform-specific write operations
#[inline]
pub fn write_output<W: Write>(output: &mut W, buf: &[u8]) -> Result<(), String> {
	output.write_all(buf).map_err(|e| format!("write error: {e}"))
}
}


mod operation {
use std::{
	char,
	error::Error,
	fmt::{Debug, Display},
	io::{BufRead, Write},
};

use nom::{
	IResult, Parser,
	branch::alt,
	bytes::complete::{tag, take, take_till, take_until},
	character::complete::one_of,
	combinator::{map, map_opt, peek, recognize, value},
	multi::{many_m_n, many0},
	sequence::{delimited, preceded, separated_pair, terminated},
};


use super::unicode_table;

/// Common trait for operations that can process chunks of data
pub trait ChunkProcessor {
	fn process_chunk(&self, input: &[u8], output: &mut Vec<u8>);
}

#[derive(Debug, Clone)]
pub enum BadSequence {
	MissingCharClassName,
	InvalidCharClass(String),
	MissingEquivalentClassChar,
	MultipleCharRepeatInSet2,
	CharRepeatInSet1,
	InvalidRepeatCount(String),
	EmptySet2WhenNotTruncatingSet1,
	ClassExceptLowerUpperInSet2,
	ClassInSet2NotMatchedBySet1,
	Set1LongerSet2EndsInClass,
	ComplementMoreThanOneUniqueInSet2,
	BackwardsRange { end: u32, start: u32 },
	MultipleCharInEquivalence(String),
}

impl Display for BadSequence {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::MissingCharClassName => write!(f, "missing character class name '[::]'"),
			Self::InvalidCharClass(class) => write!(f, "invalid character class '{class}'"),
			Self::MissingEquivalentClassChar => {
				write!(f, "missing equivalence class character '[==]'")
			},
			Self::MultipleCharRepeatInSet2 => {
				write!(f, "only one [c*] repeat construct may appear in string2")
			},
			Self::CharRepeatInSet1 => {
				write!(f, "the [c*] repeat construct may not appear in string1")
			},
			Self::InvalidRepeatCount(count) => {
				write!(f, "invalid repeat count '{count}' in [c*n] construct")
			},
			Self::EmptySet2WhenNotTruncatingSet1 => {
				write!(f, "when not truncating set1, string2 must be non-empty")
			},
			Self::ClassExceptLowerUpperInSet2 => write!(
				f,
				"when translating, the only character classes that may appear in set2 are 'upper' and \
				 'lower'"
			),
			Self::ClassInSet2NotMatchedBySet1 => write!(
				f,
				"when translating, every 'upper'/'lower' in set2 must be matched by a 'upper'/'lower' \
				 in the same position in set1"
			),
			Self::Set1LongerSet2EndsInClass => write!(
				f,
				"when translating with string1 longer than string2,\nthe latter string must not end \
				 with a character class"
			),
			Self::ComplementMoreThanOneUniqueInSet2 => write!(
				f,
				"when translating with complemented character classes,\nstring2 must map all \
				 characters in the domain to one"
			),
			Self::BackwardsRange { end, start } => {
				fn endpoint(value: u32) -> String {
					match char::from_u32(value) {
						Some(ch @ '\x20'..='\x7e') => ch.escape_default().to_string(),
						_ => format!("\\{value:03o}"),
					}
				}
				write!(
					f,
					"range-endpoints of '{}-{}' are in reverse collating sequence order",
					endpoint(*start),
					endpoint(*end)
				)
			},
			Self::MultipleCharInEquivalence(chars) => {
				write!(f, "{chars}: equivalence class operand must be a single character")
			},
		}
	}
}

impl Error for BadSequence {}

#[derive(Debug, Clone, Copy)]
pub enum Class {
	Alnum,
	Alpha,
	Blank,
	Control,
	Digit,
	Graph,
	Lower,
	Print,
	Punct,
	Space,
	Upper,
	Xdigit,
}

#[derive(Debug, Clone, Copy)]
pub enum Sequence {
	Char(u8),
	CharRange(u8, u8),
	CharStar(u8),
	CharRepeat(u8, usize),
	Class(Class),
}

impl Sequence {
	pub fn flatten(&self) -> Box<dyn Iterator<Item = u8>> {
		match self {
			Self::Char(c) => Box::new(std::iter::once(*c)),
			Self::CharRange(l, r) => Box::new(*l..=*r),
			Self::CharStar(c) => Box::new(std::iter::repeat(*c)),
			Self::CharRepeat(c, n) => Box::new(std::iter::repeat_n(*c, *n)),
			Self::Class(class) => match class {
				Class::Alnum => Box::new((b'0'..=b'9').chain(b'A'..=b'Z').chain(b'a'..=b'z')),
				Class::Alpha => Box::new((b'A'..=b'Z').chain(b'a'..=b'z')),
				Class::Blank => Box::new(unicode_table::BLANK.iter().copied()),
				Class::Control => Box::new((0..=31).chain(std::iter::once(127))),
				Class::Digit => Box::new(b'0'..=b'9'),
				Class::Graph => Box::new(
					(48..=57) // digit
						.chain(65..=90) // uppercase
						.chain(97..=122) // lowercase
						// punctuations
						.chain(33..=47)
						.chain(58..=64)
						.chain(91..=96)
						.chain(123..=126),
				),
				Class::Print => Box::new(
					(48..=57) // digit
						.chain(65..=90) // uppercase
						.chain(97..=122) // lowercase
						// punctuations
						.chain(33..=47)
						.chain(58..=64)
						.chain(91..=96)
						.chain(123..=126)
						.chain(std::iter::once(32)), // space
				),
				Class::Punct => Box::new((33..=47).chain(58..=64).chain(91..=96).chain(123..=126)),
				Class::Space => Box::new(unicode_table::SPACES.iter().copied()),
				Class::Xdigit => Box::new((b'0'..=b'9').chain(b'A'..=b'F').chain(b'a'..=b'f')),
				Class::Lower => Box::new(b'a'..=b'z'),
				Class::Upper => Box::new(b'A'..=b'Z'),
			},
		}
	}

	// Hide all the nasty sh*t in here
	pub fn solve_set_characters(
		set1_str: &[u8],
		set2_str: &[u8],
		complement_flag: bool,
		truncate_set1_flag: bool,
		translating: bool,
		stderr: &mut dyn Write,
	) -> Result<(Vec<u8>, Vec<u8>), BadSequence> {
		let is_char_star = |s: &&Self| -> bool { matches!(s, Self::CharStar(_)) };

		let set1 = Self::from_str(set1_str, stderr)?;
		if set1.iter().filter(is_char_star).count() != 0 {
			return Err(BadSequence::CharRepeatInSet1);
		}

		let mut set2 = Self::from_str(set2_str, stderr)?;
		if set2.iter().filter(is_char_star).count() > 1 {
			return Err(BadSequence::MultipleCharRepeatInSet2);
		}

		if translating
			&& set2.iter().any(|&x| {
				matches!(x, Self::Class(_)) && !matches!(x, Self::Class(Class::Upper | Class::Lower))
			}) {
			return Err(BadSequence::ClassExceptLowerUpperInSet2);
		}

		let mut set1_solved: Vec<u8> = set1.iter().flat_map(Self::flatten).collect();
		if complement_flag {
			set1_solved = (0..=u8::MAX).filter(|x| !set1_solved.contains(x)).collect();
		}
		let set1_len = set1_solved.len();

		let set2_len = set2
			.iter()
			.filter_map(|s| match s {
				Self::CharStar(_) => None,
				r => Some(r),
			})
			.flat_map(Self::flatten)
			.count();

		let star_compensate_len = set1_len.saturating_sub(set2_len);
		//Replace CharStar with CharRepeat
		set2 = set2
			.iter()
			.filter_map(|s| match s {
				Self::CharStar(0) => None,
				Self::CharStar(c) => Some(Self::CharRepeat(*c, star_compensate_len)),
				r => Some(*r),
			})
			.collect();

		// For every upper/lower in set2, there must be an upper/lower in set1 at the
		// same position. The position is calculated by expanding everything before the
		// upper/lower in both sets
		for (set2_pos, set2_item) in set2.iter().enumerate() {
			if matches!(set2_item, Self::Class(_)) {
				let mut set2_part_solved_len = 0;
				if set2_pos >= 1 {
					set2_part_solved_len = set2.iter().take(set2_pos).flat_map(Self::flatten).count();
				}

				let mut class_matches = false;
				for (set1_pos, set1_item) in set1.iter().enumerate() {
					if matches!(set1_item, Self::Class(_)) {
						let mut set1_part_solved_len = 0;
						if set1_pos >= 1 {
							set1_part_solved_len =
								set1.iter().take(set1_pos).flat_map(Self::flatten).count();
						}

						if set1_part_solved_len == set2_part_solved_len {
							class_matches = true;
							break;
						}
					}
				}

				if !class_matches {
					return Err(BadSequence::ClassInSet2NotMatchedBySet1);
				}
			}
		}

		let set2_solved: Vec<_> = set2.iter().flat_map(Self::flatten).collect();

		// Calculate the set of unique characters in set2
		let mut set2_uniques = set2_solved.clone();
		set2_uniques.sort_unstable();
		set2_uniques.dedup();

		// If the complement flag is used in translate mode, only one unique
		// character may appear in set2. Validate this with the set of uniques
		// in set2 that we just generated.
		// Also, set2 must not overgrow set1, otherwise the mapping can't be 1:1.
		if set1.iter().any(|x| matches!(x, Self::Class(_)))
			&& translating
			&& complement_flag
			&& (set2_uniques.len() > 1 || set2_solved.len() > set1_len)
		{
			return Err(BadSequence::ComplementMoreThanOneUniqueInSet2);
		}

		if set2_solved.len() < set1_solved.len() {
			if truncate_set1_flag {
				set1_solved.truncate(set2_solved.len());
			} else if matches!(set2.last().copied(), Some(Self::Class(Class::Upper | Class::Lower))) {
				return Err(BadSequence::Set1LongerSet2EndsInClass);
			}
		}

		Ok((set1_solved, set2_solved))
	}
}

impl Sequence {
	pub fn from_str(input: &[u8], stderr: &mut dyn Write) -> Result<Vec<Self>, BadSequence> {
		let parsed = many0(alt((
			map(Self::parse_char_range, |s| (s, None)),
			map(Self::parse_char_star, |s| (s, None)),
			map(Self::parse_char_repeat, |s| (s, None)),
			map(Self::parse_class, |s| (s, None)),
			map(Self::parse_char_equal, |s| (s, None)),
			// NOTE: This must be the last one
			map(Self::parse_backslash_or_char_with_warning, |(s, warning)| {
				(Ok(Self::Char(s)), warning)
			}),
		)))
		.parse(input)
		.map(|(_, r)| r)
		.unwrap();
		parsed
			.into_iter()
			.map(|(sequence, warning)| {
				if let Some(warning) = warning {
					let _ = writeln!(stderr, "tr: warning: {warning}");
				}
				sequence
			})
			.collect()
	}

	fn parse_octal(input: &[u8]) -> IResult<&[u8], u8> {
		// For `parse_char_range`, `parse_char_star`, `parse_char_repeat`,
		// `parse_char_equal`. Because in these patterns, there's no ambiguous cases.
		preceded(tag("\\"), Self::parse_octal_up_to_three_digits).parse(input)
	}

	fn parse_octal_with_warning(input: &[u8]) -> IResult<&[u8], (u8, Option<String>)> {
		let (digits, _) = tag("\\")(input)?;
		if let Ok((rest, value)) = Self::parse_octal_up_to_three_digits(digits) {
			return Ok((rest, (value, None)));
		}

		let (rest, value) = Self::parse_octal_two_digits(digits)?;
		let warning = if let Ok(origin_octal) = std::str::from_utf8(digits) {
			let actual_octal_tail = std::str::from_utf8(&digits[..2]).unwrap();
			let outstand_char = char::from_u32(digits[2] as u32).unwrap();
			format!(
				"the ambiguous octal escape \\{origin_octal} is being interpreted as the 2-byte \
				 sequence \\0{actual_octal_tail}, {outstand_char}"
			)
		} else {
			"invalid utf8 sequence".to_string()
		};
		Ok((rest, (value, Some(warning))))
	}

	fn parse_octal_up_to_three_digits(input: &[u8]) -> IResult<&[u8], u8> {
		map_opt(recognize(many_m_n(1, 3, one_of("01234567"))), |out: &[u8]| {
			let str_to_parse = std::str::from_utf8(out).unwrap();
			u8::from_str_radix(str_to_parse, 8).ok()
		})
		.parse(input)
	}


	fn parse_octal_two_digits(input: &[u8]) -> IResult<&[u8], u8> {
		map_opt(recognize(many_m_n(2, 2, one_of("01234567"))), |out: &[u8]| {
			u8::from_str_radix(std::str::from_utf8(out).unwrap(), 8).ok()
		})
		.parse(input)
	}

	fn parse_backslash(input: &[u8]) -> IResult<&[u8], u8> {
		preceded(tag("\\"), Self::single_char)
			.parse(input)
			.map(|(l, a)| {
				let c = match a {
					b'a' => unicode_table::BEL,
					b'b' => unicode_table::BS,
					b'f' => unicode_table::FF,
					b'n' => unicode_table::LF,
					b'r' => unicode_table::CR,
					b't' => unicode_table::HT,
					b'v' => unicode_table::VT,
					x => x,
				};
				(l, c)
			})
	}

	fn parse_backslash_or_char(input: &[u8]) -> IResult<&[u8], u8> {
		alt((Self::parse_octal, Self::parse_backslash, Self::single_char)).parse(input)
	}

	fn parse_backslash_or_char_with_warning(
		input: &[u8],
	) -> IResult<&[u8], (u8, Option<String>)> {
		alt((
			Self::parse_octal_with_warning,
			map(Self::parse_backslash, |value| (value, None)),
			map(Self::single_char, |value| (value, None)),
		))
		.parse(input)
	}

	fn single_char(input: &[u8]) -> IResult<&[u8], u8> {
		take(1usize)(input).map(|(l, a)| (l, a[0]))
	}

	fn parse_char_range(input: &[u8]) -> IResult<&[u8], Result<Self, BadSequence>> {
		separated_pair(Self::parse_backslash_or_char, tag("-"), Self::parse_backslash_or_char)
			.parse(input)
			.map(|(l, (a, b))| {
				(l, {
					let (start, end) = (u32::from(a), u32::from(b));

					let range = start..=end;

					if range.is_empty() {
						Err(BadSequence::BackwardsRange { end, start })
					} else {
						Ok(Self::CharRange(start as u8, end as u8))
					}
				})
			})
	}

	fn parse_char_star(input: &[u8]) -> IResult<&[u8], Result<Self, BadSequence>> {
		delimited(tag("["), Self::parse_backslash_or_char, tag("*]"))
			.parse(input)
			.map(|(l, a)| (l, Ok(Self::CharStar(a))))
	}

	fn parse_char_repeat(input: &[u8]) -> IResult<&[u8], Result<Self, BadSequence>> {
		delimited(
			tag("["),
			separated_pair(
				Self::parse_backslash_or_char,
				tag("*"),
				// TODO
				// Why are the opening and closing tags not sufficient?
				// Backslash check is a workaround for `check_against_gnu_tr_tests_repeat_bs_9`
				take_till(|ue| matches!(ue, b']' | b'\\')),
			),
			tag("]"),
		)
		.parse(input)
		.map(|(l, (c, cnt_str))| {
			let s = String::from_utf8_lossy(cnt_str);
			let result = if cnt_str.starts_with(b"0") {
				match usize::from_str_radix(&s, 8) {
					Ok(0) => Ok(Self::CharStar(c)),
					Ok(count) => Ok(Self::CharRepeat(c, count)),
					Err(_) => Err(BadSequence::InvalidRepeatCount(s.to_string())),
				}
			} else {
				match s.parse::<usize>() {
					Ok(0) => Ok(Self::CharStar(c)),
					Ok(count) => Ok(Self::CharRepeat(c, count)),
					Err(_) => Err(BadSequence::InvalidRepeatCount(s.to_string())),
				}
			};
			(l, result)
		})
	}

	fn parse_class(input: &[u8]) -> IResult<&[u8], Result<Self, BadSequence>> {
		preceded(tag("[:"), terminated(take_until(":]"), tag(":]")))
			.parse(input)
			.map(|(l, class_name)| {
				(l, match class_name {
					b"" => Err(BadSequence::MissingCharClassName),
					b"alnum" => Ok(Self::Class(Class::Alnum)),
					b"alpha" => Ok(Self::Class(Class::Alpha)),
					b"blank" => Ok(Self::Class(Class::Blank)),
					b"cntrl" => Ok(Self::Class(Class::Control)),
					b"digit" => Ok(Self::Class(Class::Digit)),
					b"graph" => Ok(Self::Class(Class::Graph)),
					b"lower" => Ok(Self::Class(Class::Lower)),
					b"print" => Ok(Self::Class(Class::Print)),
					b"punct" => Ok(Self::Class(Class::Punct)),
					b"space" => Ok(Self::Class(Class::Space)),
					b"upper" => Ok(Self::Class(Class::Upper)),
					b"xdigit" => Ok(Self::Class(Class::Xdigit)),
					_ => Err(BadSequence::InvalidCharClass(format!(
						"[:{}:]",
						String::from_utf8_lossy(class_name)
					))),
				})
			})
	}

	fn parse_char_equal(input: &[u8]) -> IResult<&[u8], Result<Self, BadSequence>> {
		preceded(
			tag("[="),
			(
				alt((value(Err(()), peek(tag("=]"))), map(Self::parse_backslash_or_char, Ok))),
				map(terminated(take_until("=]"), tag("=]")), |v: &[u8]| {
					if v.is_empty() { Ok(()) } else { Err(v) }
				}),
			),
		)
		.parse(input)
		.map(|(l, (a, b))| {
			(l, match (a, b) {
				(Err(()), _) => Err(BadSequence::MissingEquivalentClassChar),
				(Ok(c), Ok(())) => Ok(Self::Char(c)),
				(Ok(c), Err(v)) => Err(BadSequence::MultipleCharInEquivalence(format!(
					"{}{}",
					String::from_utf8_lossy(&[c]),
					String::from_utf8_lossy(v),
				))),
			})
		})
	}
}

pub trait SymbolTranslator {
	fn translate(&mut self, current: u8) -> Option<u8>;

	/// Takes two [`SymbolTranslator`]s and creates a new [`SymbolTranslator`]
	/// over both in sequence.
	///
	/// This behaves pretty much identical to [`Iterator::chain`].
	fn chain<T>(self, other: T) -> ChainedSymbolTranslator<Self, T>
	where
		Self: Sized,
	{
		ChainedSymbolTranslator::<Self, T> { stage_a: self, stage_b: other }
	}
}

pub struct ChainedSymbolTranslator<A, B> {
	stage_a: A,
	stage_b: B,
}

impl<A: SymbolTranslator, B: SymbolTranslator> SymbolTranslator for ChainedSymbolTranslator<A, B> {
	fn translate(&mut self, current: u8) -> Option<u8> {
		self
			.stage_a
			.translate(current)
			.and_then(|c| self.stage_b.translate(c))
	}
}

/// Convert a set of bytes to a 256-element bitmap for O(1) lookup
fn set_to_bitmap(set: &[u8]) -> [bool; 256] {
	let mut bitmap = [false; 256];
	for &byte in set {
		bitmap[byte as usize] = true;
	}
	bitmap
}

#[derive(Debug)]
pub struct DeleteOperation {
	pub(crate) delete_table: [bool; 256],
}

impl DeleteOperation {
	pub fn new(set: Vec<u8>) -> Self {
		Self { delete_table: set_to_bitmap(&set) }
	}
}

impl SymbolTranslator for DeleteOperation {
	fn translate(&mut self, current: u8) -> Option<u8> {
		// keep if not present in the delete set
		(!self.delete_table[current as usize]).then_some(current)
	}
}

impl ChunkProcessor for DeleteOperation {
	fn process_chunk(&self, input: &[u8], output: &mut Vec<u8>) {
		use super::simd::{find_single_change, process_single_delete};

		// Check if this is single character deletion
		if let Some((delete_char, _)) =
			find_single_change(&self.delete_table, |_, &should_delete| should_delete)
		{
			process_single_delete(input, output, delete_char);
		} else {
			// Standard deletion
			output.extend(
				input
					.iter()
					.filter(|&&b| !self.delete_table[b as usize])
					.copied(),
			);
		}
	}
}

#[derive(Debug)]
pub struct TranslateOperation {
	pub(crate) translation_table: [u8; 256],
}

impl TranslateOperation {
	pub fn new(set1: Vec<u8>, set2: Vec<u8>) -> Result<Self, BadSequence> {
		// Initialize translation table with identity mapping
		let mut translation_table = std::array::from_fn(|i| i as u8);

		if let Some(fallback) = set2.last().copied() {
			// Apply translations from set1 to set2
			for (from, to) in set1
				.into_iter()
				.zip(set2.into_iter().chain(std::iter::repeat(fallback)))
			{
				translation_table[from as usize] = to;
			}

			Ok(Self { translation_table })
		} else if set1.is_empty() && set2.is_empty() {
			// Identity mapping for empty sets
			Ok(Self { translation_table })
		} else {
			Err(BadSequence::EmptySet2WhenNotTruncatingSet1)
		}
	}
}

impl SymbolTranslator for TranslateOperation {
	fn translate(&mut self, current: u8) -> Option<u8> {
		Some(self.translation_table[current as usize])
	}
}

impl ChunkProcessor for TranslateOperation {
	fn process_chunk(&self, input: &[u8], output: &mut Vec<u8>) {
		use super::simd::{find_single_change, process_single_char_replace};

		// Check if this is a simple single-character translation
		if let Some((source, target)) =
			find_single_change(&self.translation_table, |i, &val| val != i as u8)
		{
			// Use SIMD-optimized single character replacement
			process_single_char_replace(input, output, source, target);
		} else {
			// Standard translation using table lookup
			output.extend(input.iter().map(|&b| self.translation_table[b as usize]));
		}
	}
}

#[derive(Debug, Clone)]
pub struct SqueezeOperation {
	squeeze_table: [bool; 256],
	previous:      Option<u8>,
}

impl SqueezeOperation {
	pub fn new(set1: Vec<u8>) -> Self {
		Self { squeeze_table: set_to_bitmap(&set1), previous: None }
	}
}

impl SymbolTranslator for SqueezeOperation {
	fn translate(&mut self, current: u8) -> Option<u8> {
		let next = if self.squeeze_table[current as usize] {
			match self.previous {
				Some(v) if v == current => None,
				_ => Some(current),
			}
		} else {
			Some(current)
		};
		self.previous = Some(current);
		next
	}
}

pub fn translate_input<T, R, W>(
	input: &mut R,
	output: &mut W,
	mut translator: T,
) -> Result<(), String>
where
	T: SymbolTranslator,
	R: BufRead,
	W: Write,
{
	const BUFFER_SIZE: usize = 32768; // Large buffer for better throughput
	let mut buf = [0; BUFFER_SIZE];
	let mut output_buf = Vec::with_capacity(BUFFER_SIZE);

	loop {
		let length = match input.read(&mut buf[..]) {
			Ok(0) => break, // EOF reached
			Ok(len) => len,
			Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
			Err(e) => return Err(format!("read error: {e}")),
		};

		// Process the buffer and collect translated chars to output
		output_buf.clear();
		for &byte in &buf[..length] {
			if let Some(translated) = translator.translate(byte) {
				output_buf.push(translated);
			}
		}

		if !output_buf.is_empty() {
			super::simd::write_output(output, &output_buf)?;
		}
	}

	Ok(())
}

/// Platform-specific flush operation
#[inline]
pub fn flush_output<W: Write>(output: &mut W) -> Result<(), String> {
	output.flush().map_err(|e| format!("write error: {e}"))
}
}

mod options {
	pub const COMPLEMENT: &str = "complement";
	pub const DELETE: &str = "delete";
	pub const SQUEEZE: &str = "squeeze-repeats";
	pub const TRUNCATE_SET1: &str = "truncate-set1";
	pub const SETS: &str = "sets";
}


/// Parsed `tr` invocation.
pub(crate) struct Tr {
	matches: ArgMatches,
}

matches_parser!(Tr, app);

impl Utility for Tr {
	const NAME: &'static str = "tr";

	fn run(self, host: &mut Host) -> i32 {
		if let Err(error) = tr_main(&self.matches, host) {
			host.error(error, 1);
			return 1;
		}
		0
	}
}

fn tr_main(matches: &clap::ArgMatches, host: &mut Host) -> Result<(), String> {
	let delete_flag = matches.get_flag(options::DELETE);
	let complement_flag = matches.get_flag(options::COMPLEMENT);
	let squeeze_flag = matches.get_flag(options::SQUEEZE);
	let truncate_set1_flag = matches.get_flag(options::TRUNCATE_SET1);

	let sets: Vec<_> = matches
		.get_many::<OsString>(options::SETS)
		.into_iter()
		.flatten()
		.map(ToOwned::to_owned)
		.collect();

	if sets.is_empty() {
		return Err("missing operand".to_string());
	}

	let sets_len = sets.len();
	if !(delete_flag || squeeze_flag) && sets_len == 1 {
		return Err(format!(
			"missing operand after {}\nTwo strings must be given when translating.",
			sets[0].quote()
		));
	}

	if delete_flag && squeeze_flag && sets_len == 1 {
		return Err(format!(
			"missing operand after {}\nTwo strings must be given when deleting and squeezing.",
			sets[0].quote()
		));
	}

	if sets_len > 1 {
		if delete_flag && !squeeze_flag {
			let operand = sets[1].quote();
			let message = if sets_len == 2 {
				format!(
					"extra operand {operand}\nOnly one string may be given when deleting without \
					 squeezing repeats."
				)
			} else {
				format!("extra operand {operand}")
			};
			return Err(message);
		}
		if sets_len > 2 {
			return Err(format!("extra operand {}", sets[2].quote()));
		}
	}

	if let Some(first) = sets.first() {
		let bytes = os_bytes(first).ok_or_else(|| format!("invalid argument {}", first.quote()))?;
		let trailing_backslashes = bytes
			.iter()
			.rev()
			.take_while(|&&byte| byte == b'\\')
			.count();
		if trailing_backslashes % 2 == 1 {
			let _ = writeln!(
				host.stderr,
				"tr: warning: an unescaped backslash at end of string is not portable"
			);
		}
	}

	let translating = !delete_flag && sets.len() > 1;
	let mut sets_iter = sets.iter().map(OsString::as_os_str);
	let set1_arg = sets_iter.next().unwrap_or_default();
	let set2_arg = sets_iter.next().unwrap_or_default();
	let set1_bytes =
		os_bytes(set1_arg).ok_or_else(|| format!("invalid argument {}", set1_arg.quote()))?;
	let set2_bytes =
		os_bytes(set2_arg).ok_or_else(|| format!("invalid argument {}", set2_arg.quote()))?;
	let (set1, set2) = Sequence::solve_set_characters(
		set1_bytes,
		set2_bytes,
		complement_flag,
		truncate_set1_flag && translating,
		translating,
		&mut host.stderr,
	)
	.map_err(|error| error.to_string())?;

	let mut input = BufReader::new(&mut host.stdin);
	let output = &mut host.stdout;

	if delete_flag {
		if squeeze_flag {
			let operation = DeleteOperation::new(set1).chain(SqueezeOperation::new(set2));
			translate_input(&mut input, output, operation)?;
		} else {
			process_input(&mut input, output, &DeleteOperation::new(set1))?;
		}
	} else if squeeze_flag {
		if sets_len == 1 {
			translate_input(&mut input, output, SqueezeOperation::new(set1))?;
		} else {
			let operation = TranslateOperation::new(set1, set2.clone())
				.map_err(|error| error.to_string())?
				.chain(SqueezeOperation::new(set2));
			translate_input(&mut input, output, operation)?;
		}
	} else {
		let operation =
			TranslateOperation::new(set1, set2).map_err(|error| error.to_string())?;
		process_input(&mut input, output, &operation)?;
	}

	flush_output(output)
}

fn app() -> Command {
	Command::new("tr")
		.version("0.8.0")
		.about("Translate or delete characters")
		.override_usage(format_usage("tr [OPTION]... SET1 [SET2]"))
		.after_help(
			"Translate, squeeze, and/or delete characters from standard input, writing to standard \
			 output.",
		)
		.infer_long_args(true)
		.trailing_var_arg(true)
		.arg(
			Arg::new(options::COMPLEMENT)
				.visible_short_alias('C')
				.short('c')
				.long(options::COMPLEMENT)
				.help("use the complement of SET1")
				.action(ArgAction::SetTrue)
				.overrides_with(options::COMPLEMENT),
		)
		.arg(
			Arg::new(options::DELETE)
				.short('d')
				.long(options::DELETE)
				.help("delete characters in SET1, do not translate")
				.action(ArgAction::SetTrue)
				.overrides_with(options::DELETE),
		)
		.arg(
			Arg::new(options::SQUEEZE)
				.long(options::SQUEEZE)
				.short('s')
				.help(
					"replace each sequence of a repeated character listed in the last specified SET \
					 with a single occurrence",
				)
				.action(ArgAction::SetTrue)
				.overrides_with(options::SQUEEZE),
		)
		.arg(
			Arg::new(options::TRUNCATE_SET1)
				.long(options::TRUNCATE_SET1)
				.short('t')
				.help("first truncate SET1 to length of SET2")
				.action(ArgAction::SetTrue)
				.overrides_with(options::TRUNCATE_SET1),
		)
		.arg(
			Arg::new(options::SETS)
				.num_args(1..)
				.value_parser(value_parser!(OsString)),
		)
}

/// Creates the `tr` builtin registration.
pub(crate) fn tr_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Tr, SE>()
}

#[cfg(test)]
mod tests {
	use super::{Tr, operation::Sequence};
	use crate::host::run_util;

	fn solve(
		set1: &[u8],
		set2: &[u8],
		complement: bool,
		truncate: bool,
		translating: bool,
	) -> Result<(Vec<u8>, Vec<u8>), String> {
		Sequence::solve_set_characters(
			set1,
			set2,
			complement,
			truncate,
			translating,
			&mut Vec::new(),
		)
		.map_err(|error| error.to_string())
	}

	#[test]
	fn expands_literals_ranges_and_escapes() {
		let (set1, _) = solve(b"a-c\\n\\141", b"", false, false, false).unwrap();
		assert_eq!(set1, b"abc\na");
	}

	#[test]
	fn expands_character_classes() {
		let (set1, _) = solve(b"[:digit:][:upper:]", b"", false, false, false).unwrap();
		assert_eq!(set1, b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
	}

	#[test]
	fn expands_decimal_and_octal_repeats() {
		let (_, decimal) = solve(b"abcdef", b"[x*3]", false, false, true).unwrap();
		let (_, octal) = solve(b"abcdef", b"[x*03]", false, false, true).unwrap();
		assert_eq!(decimal, b"xxx");
		assert_eq!(octal, b"xxx");
	}

	#[test]
	fn star_repeat_fills_the_remaining_set() {
		let (_, set2) = solve(b"abcdef", b"1[x*]2", false, false, true).unwrap();
		assert_eq!(set2, b"1xxxx2");
	}

	#[test]
	fn complement_excludes_set1_bytes() {
		let (set1, _) = solve(b"a-c", b"", true, false, false).unwrap();
		assert_eq!(set1.len(), 253);
		assert!(!set1.contains(&b'a'));
		assert!(!set1.contains(&b'b'));
		assert!(!set1.contains(&b'c'));
	}

	#[test]
	fn truncate_limits_set1_to_set2_length() {
		let (set1, set2) = solve(b"a-f", b"12", false, true, true).unwrap();
		assert_eq!(set1, b"ab");
		assert_eq!(set2, b"12");
	}

	#[test]
	fn equivalence_class_is_one_byte() {
		let (set1, _) = solve(b"[=x=]", b"", false, false, false).unwrap();
		assert_eq!(set1, b"x");
	}

	#[test]
	fn rejects_backwards_ranges() {
		assert_eq!(
			solve(b"z-a", b"", false, false, false).unwrap_err(),
			"range-endpoints of 'z-a' are in reverse collating sequence order"
		);
	}

	#[test]
	fn rejects_repeat_construct_in_set1() {
		assert_eq!(
			solve(b"[x*]", b"y", false, false, true).unwrap_err(),
			"the [c*] repeat construct may not appear in string1"
		);
	}

	#[test]
	fn rejects_non_case_class_in_translating_set2() {
		assert_eq!(
			solve(b"a-z", b"[:digit:]", false, false, true).unwrap_err(),
			"when translating, the only character classes that may appear in set2 are 'upper' and \
			 'lower'"
		);
	}

	#[test]
	fn translates_input_through_simd_path() {
		let (code, capture) = run_util::<Tr>(&["a", "z"], "banana", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "bznznz");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn deletes_input_through_simd_path() {
		let (code, capture) = run_util::<Tr>(&["-d", "aeiou"], "beautiful day", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "btfl dy");
	}

	#[test]
	fn squeezes_across_repeated_runs() {
		let (code, capture) = run_util::<Tr>(&["-s", " "], "a    b  c", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "a b c");
	}

	#[test]
	fn translates_then_squeezes() {
		let (code, capture) = run_util::<Tr>(&["-s", "a-c", "x"], "abcccade", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "xde");
	}

	#[test]
	fn reports_missing_second_set() {
		let (code, capture) = run_util::<Tr>(&["abc"], "", "/");
		assert_eq!(code, 1);
		assert_eq!(
			capture.err(),
			"tr: missing operand after 'abc'\nTwo strings must be given when translating.\n"
		);
	}

	#[test]
	fn reports_ambiguous_octal_escape_warning() {
		let (code, capture) = run_util::<Tr>(&["\\400", "x"], " 0", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "xx");
		assert_eq!(
			capture.err(),
			"tr: warning: the ambiguous octal escape \\400 is being interpreted as the 2-byte \
			 sequence \\040, 0\n"
		);
	}
}
