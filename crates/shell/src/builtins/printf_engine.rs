use std::io;

use thiserror::Error;

use crate::escape::{self, QuoteMode};

const MAX_WIDTH: usize = 1_000_000;

#[derive(Debug, Error)]
pub(super) enum PrintfError {
	#[error("invalid conversion specification at byte {offset}")]
	InvalidSpec { offset: usize },
	#[error("format ends in %")]
	TrailingPercent,
	#[error("missing hexadecimal number in escape")]
	MissingHex,
	#[error("invalid Unicode escape at byte {offset}")]
	InvalidUnicode { offset: usize },
	#[error("formatting width or precision is too large")]
	TooWide,
	#[error(transparent)]
	Io(#[from] io::Error),
}

#[derive(Clone, Copy)]
enum Location {
	Next,
	Position(usize),
}

#[derive(Clone, Copy)]
enum Count {
	Fixed(usize),
	Argument(Location),
}

#[derive(Clone, Copy, Default)]
struct Flags {
	left:      bool,
	plus:      bool,
	space:     bool,
	alternate: bool,
	zero:      bool,
	quote:     bool,
}

#[derive(Clone, Copy)]
struct Spec {
	conversion: u8,
	location:   Location,
	flags:      Flags,
	width:      Option<Count>,
	precision:  Option<Count>,
}

enum Item<'a> {
	Bytes(&'a [u8]),
	Escaped(Vec<u8>),
	Stop,
	Spec(Spec),
}

struct Arguments<'a> {
	values:  &'a [String],
	batch:   usize,
	next:    usize,
	highest: Option<usize>,
}

impl<'a> Arguments<'a> {
	fn new(values: &'a [String]) -> Self {
		Self { values, batch: 0, next: 0, highest: None }
	}

	fn get(&mut self, location: Location) -> &'a str {
		let index = match location {
			Location::Next => {
				let index = self.next;
				self.next = self.next.saturating_add(1);
				index
			},
			Location::Position(position) => {
				let index = self.batch.saturating_add(position);
				self.highest = Some(self.highest.map_or(index, |old| old.max(index)));
				index
			},
		};
		self.values.get(index).map_or("", String::as_str)
	}

	fn next_batch(&mut self) {
		self.batch = self
			.next
			.max(self.highest.map_or(0, |index| index.saturating_add(1)));
		self.next = self.batch;
		self.highest = None;
	}
}

pub(super) fn format(
	format: &str,
	arguments: &[String],
	mut writer: impl io::Write,
) -> Result<(), PrintfError> {
	let items = parse(format.as_bytes())?;
	let mut arguments = Arguments::new(arguments);
	loop {
		let batch_start = arguments.batch;
		for item in &items {
			match item {
				Item::Bytes(bytes) => writer.write_all(bytes)?,
				Item::Escaped(bytes) => writer.write_all(bytes)?,
				Item::Stop => return Ok(()),
				Item::Spec(spec) if !write_spec(*spec, &mut arguments, &mut writer)? => return Ok(()),
				Item::Spec(_) => {},
			}
		}
		arguments.next_batch();
		if arguments.batch >= arguments.values.len() || arguments.batch == batch_start {
			break;
		}
	}
	Ok(())
}

fn parse(input: &[u8]) -> Result<Vec<Item<'_>>, PrintfError> {
	let mut items = Vec::new();
	let mut cursor = 0;
	let mut literal = 0;
	while cursor < input.len() {
		if !matches!(input[cursor], b'%' | b'\\') {
			cursor += 1;
			continue;
		}
		if literal < cursor {
			items.push(Item::Bytes(&input[literal..cursor]));
		}
		if input[cursor] == b'%' {
			if input.get(cursor + 1) == Some(&b'%') {
				items.push(Item::Bytes(b"%"));
				cursor += 2;
			} else {
				let (spec, end) = parse_spec(input, cursor + 1)?;
				items.push(Item::Spec(spec));
				cursor = end;
			}
		} else {
			let (escaped, end, stop) = parse_escape(input, cursor + 1, false)?;
			if stop {
				items.push(Item::Stop);
			} else {
				items.push(Item::Escaped(escaped));
			}
			cursor = end;
		}
		literal = cursor;
	}
	if literal < input.len() {
		items.push(Item::Bytes(&input[literal..]));
	}
	Ok(items)
}

fn parse_spec(input: &[u8], mut cursor: usize) -> Result<(Spec, usize), PrintfError> {
	if cursor >= input.len() {
		return Err(PrintfError::TrailingPercent);
	}
	let location = parse_position(input, &mut cursor).unwrap_or(Location::Next);
	let mut flags = Flags::default();
	loop {
		match input.get(cursor) {
			Some(b'-') => flags.left = true,
			Some(b'+') => flags.plus = true,
			Some(b' ') => flags.space = true,
			Some(b'#') => flags.alternate = true,
			Some(b'0') => flags.zero = true,
			Some(b'\'') => flags.quote = true,
			_ => break,
		}
		cursor += 1;
	}
	let width = parse_count(input, &mut cursor);
	let precision = if input.get(cursor) == Some(&b'.') {
		cursor += 1;
		Some(parse_count(input, &mut cursor).unwrap_or(Count::Fixed(0)))
	} else {
		None
	};
	while matches!(input.get(cursor), Some(b'h' | b'l' | b'j' | b'z' | b't' | b'L')) {
		cursor += 1;
	}
	let Some(&conversion) = input.get(cursor) else {
		return Err(PrintfError::TrailingPercent);
	};
	if !matches!(
		conversion,
		b's'
			| b'b' | b'q'
			| b'c' | b'd'
			| b'i' | b'u'
			| b'o' | b'x'
			| b'X' | b'e'
			| b'E' | b'f'
			| b'F' | b'g'
			| b'G'
	) {
		return Err(PrintfError::InvalidSpec { offset: cursor });
	}
	let invalid_options = match conversion {
		b'c' => flags.zero || flags.alternate || flags.quote || precision.is_some(),
		b's' => flags.zero || flags.alternate || flags.quote,
		b'b' | b'q' => {
			flags.left
				|| flags.plus
				|| flags.space
				|| flags.alternate
				|| flags.zero
				|| flags.quote
				|| width.is_some()
				|| precision.is_some()
		},
		b'd' | b'i' => flags.alternate,
		b'u' => flags.alternate,
		_ => false,
	};
	if invalid_options {
		return Err(PrintfError::InvalidSpec { offset: cursor });
	}
	Ok((Spec { conversion, location, flags, width, precision }, cursor + 1))
}

fn parse_position(input: &[u8], cursor: &mut usize) -> Option<Location> {
	let start = *cursor;
	let value = parse_usize(input, cursor)?;
	if input.get(*cursor) == Some(&b'$') && value != 0 {
		*cursor += 1;
		Some(Location::Position(value - 1))
	} else {
		*cursor = start;
		None
	}
}

fn parse_count(input: &[u8], cursor: &mut usize) -> Option<Count> {
	if input.get(*cursor) == Some(&b'*') {
		*cursor += 1;
		return Some(Count::Argument(parse_position(input, cursor).unwrap_or(Location::Next)));
	}
	parse_usize(input, cursor).map(Count::Fixed)
}

fn parse_usize(input: &[u8], cursor: &mut usize) -> Option<usize> {
	let start = *cursor;
	let mut value = 0usize;
	while let Some(digit @ b'0'..=b'9') = input.get(*cursor).copied() {
		value = value
			.saturating_mul(10)
			.saturating_add(usize::from(digit - b'0'));
		*cursor += 1;
	}
	(*cursor != start).then_some(value)
}

fn checked_count(value: usize) -> Result<usize, PrintfError> {
	if value > MAX_WIDTH {
		return Err(PrintfError::TooWide);
	}
	Ok(value)
}

fn resolve_width(
	count: Option<Count>,
	arguments: &mut Arguments<'_>,
) -> Result<(usize, bool), PrintfError> {
	let Some(count) = count else {
		return Ok((0, false));
	};
	let (value, negative) = match count {
		Count::Fixed(value) => (value, false),
		Count::Argument(location) => {
			let value = parse_i64(arguments.get(location));
			(value.unsigned_abs() as usize, value < 0)
		},
	};
	Ok((checked_count(value)?, negative))
}

fn resolve_precision(
	count: Option<Count>,
	arguments: &mut Arguments<'_>,
) -> Result<Option<usize>, PrintfError> {
	let value = match count {
		None => return Ok(None),
		Some(Count::Fixed(value)) => value,
		Some(Count::Argument(location)) => parse_i64(arguments.get(location)).max(0) as usize,
	};
	checked_count(value).map(Some)
}

fn write_spec(
	spec: Spec,
	arguments: &mut Arguments<'_>,
	writer: &mut impl io::Write,
) -> Result<bool, PrintfError> {
	let (width, negative_width) = resolve_width(spec.width, arguments)?;
	let precision = resolve_precision(spec.precision, arguments)?;
	let left = spec.flags.left || negative_width;
	match spec.conversion {
		b's' => {
			let value = arguments.get(spec.location).as_bytes();
			write_padded(
				writer,
				&value[..precision.unwrap_or(value.len()).min(value.len())],
				width,
				left,
				b' ',
			)?;
		},
		b'c' => {
			let byte = arguments
				.get(spec.location)
				.as_bytes()
				.first()
				.copied()
				.unwrap_or(0);
			write_padded(writer, &[byte], width, left, b' ')?;
		},
		b'b' => return write_escaped_argument(arguments.get(spec.location).as_bytes(), writer),
		b'q' => {
			let quoted = escape::quote_if_needed(arguments.get(spec.location), QuoteMode::SingleQuote);
			write_padded(writer, quoted.as_bytes(), width, left, b' ')?;
		},
		b'd' | b'i' => {
			let value = parse_i64(arguments.get(spec.location));
			let negative = value < 0;
			let sign = if negative {
				Some(b'-')
			} else if spec.flags.plus {
				Some(b'+')
			} else if spec.flags.space {
				Some(b' ')
			} else {
				None
			};
			let digits = value.unsigned_abs().to_string();
			write_number(writer, &digits, sign, b"", width, precision, left, spec.flags.zero)?;
		},
		b'u' | b'o' | b'x' | b'X' => {
			let value = parse_u64(arguments.get(spec.location));
			let digits = match spec.conversion {
				b'u' => value.to_string(),
				b'o' => format!("{value:o}"),
				b'x' => format!("{value:x}"),
				b'X' => format!("{value:X}"),
				_ => unreachable!(),
			};
			let octal_prefix = spec.flags.alternate
				&& spec.conversion == b'o'
				&& ((value == 0 && precision == Some(0))
					|| (!digits.starts_with('0') && precision.unwrap_or(0) <= digits.len()));
			let prefix: &[u8] = if octal_prefix {
				b"0"
			} else if spec.flags.alternate && value != 0 && spec.conversion == b'x' {
				b"0x"
			} else if spec.flags.alternate && value != 0 && spec.conversion == b'X' {
				b"0X"
			} else {
				b""
			};
			write_number(writer, &digits, None, prefix, width, precision, left, spec.flags.zero)?;
		},
		b'e' | b'E' | b'f' | b'F' | b'g' | b'G' => {
			let value = parse_float(arguments.get(spec.location));
			let text = format_float(value.abs(), spec.conversion, precision, spec.flags.alternate);
			let sign = if value.is_sign_negative() {
				Some(b'-')
			} else if spec.flags.plus {
				Some(b'+')
			} else if spec.flags.space {
				Some(b' ')
			} else {
				None
			};
			write_number(writer, &text, sign, b"", width, None, left, spec.flags.zero)?;
		},
		_ => unreachable!(),
	}
	Ok(true)
}

fn write_number(
	writer: &mut impl io::Write,
	digits: &str,
	sign: Option<u8>,
	prefix: &[u8],
	width: usize,
	precision: Option<usize>,
	left: bool,
	zero: bool,
) -> Result<(), PrintfError> {
	let digits = if precision == Some(0) && digits == "0" {
		""
	} else {
		digits
	};
	let precision_zeros = precision.unwrap_or(0).saturating_sub(digits.len());
	let len = usize::from(sign.is_some()) + prefix.len() + precision_zeros + digits.len();
	let padding = width.saturating_sub(len);
	if !left && !(zero && precision.is_none()) {
		write_repeat(writer, b' ', padding)?;
	}
	if let Some(sign) = sign {
		writer.write_all(&[sign])?;
	}
	writer.write_all(prefix)?;
	if !left && zero && precision.is_none() {
		write_repeat(writer, b'0', padding)?;
	}
	write_repeat(writer, b'0', precision_zeros)?;
	writer.write_all(digits.as_bytes())?;
	if left {
		write_repeat(writer, b' ', padding)?;
	}
	Ok(())
}

fn write_padded(
	writer: &mut impl io::Write,
	bytes: &[u8],
	width: usize,
	left: bool,
	padding: u8,
) -> Result<(), PrintfError> {
	let count = width.saturating_sub(bytes.len());
	if !left {
		write_repeat(writer, padding, count)?;
	}
	writer.write_all(bytes)?;
	if left {
		write_repeat(writer, padding, count)?;
	}
	Ok(())
}

fn write_repeat(writer: &mut impl io::Write, byte: u8, mut count: usize) -> io::Result<()> {
	let block = [byte; 64];
	while count != 0 {
		let written = count.min(block.len());
		writer.write_all(&block[..written])?;
		count -= written;
	}
	Ok(())
}

fn parse_i64(input: &str) -> i64 {
	parse_integer(input).unwrap_or(0) as i64
}

fn parse_u64(input: &str) -> u64 {
	parse_integer(input).unwrap_or(0) as u64
}

fn parse_integer(input: &str) -> Option<i128> {
	if matches!(input.as_bytes().first(), Some(b'\'' | b'"')) {
		return input[1..].chars().next().map(|character| character as i128);
	}
	let (negative, input) = input
		.strip_prefix('-')
		.map_or((false, input), |rest| (true, rest));
	let input = input.strip_prefix('+').unwrap_or(input);
	let (radix, digits) = input
		.strip_prefix("0x")
		.or_else(|| input.strip_prefix("0X"))
		.map_or_else(
			|| {
				if input.len() > 1 && input.starts_with('0') {
					(8, &input[1..])
				} else {
					(10, input)
				}
			},
			|rest| (16, rest),
		);
	let end = digits
		.find(|character: char| character.to_digit(radix).is_none())
		.unwrap_or(digits.len());
	let value = i128::from_str_radix(&digits[..end], radix).ok()?;
	Some(if negative { -value } else { value })
}

fn parse_float(input: &str) -> f64 {
	if matches!(input.as_bytes().first(), Some(b'\'' | b'"')) {
		return input[1..]
			.chars()
			.next()
			.map_or(0.0, |character| character as u32 as f64);
	}
	input.parse().unwrap_or(0.0)
}

fn format_float(value: f64, conversion: u8, precision: Option<usize>, alternate: bool) -> String {
	let upper = conversion.is_ascii_uppercase();
	let lower = conversion.to_ascii_lowercase();
	let mut output = if lower == b'f' {
		format!("{value:.precision$}", precision = precision.unwrap_or(6))
	} else if lower == b'e' {
		format_scientific(value, precision.unwrap_or(6), false)
	} else {
		format_general(value, precision.unwrap_or(6).max(1), alternate)
	};
	if alternate && !output.contains('.') {
		if let Some(index) = output.find('e') {
			output.insert(index, '.');
		} else {
			output.push('.');
		}
	}
	if upper {
		output.make_ascii_uppercase();
	}
	output
}

fn format_scientific(value: f64, precision: usize, trim: bool) -> String {
	if !value.is_finite() {
		return value.to_string();
	}
	let raw = format!("{value:.precision$e}");
	let (mut mantissa, exponent) = raw.split_once('e').unwrap_or((&raw, "0"));
	let owned;
	if trim && mantissa.contains('.') {
		owned = mantissa
			.trim_end_matches('0')
			.trim_end_matches('.')
			.to_owned();
		mantissa = &owned;
	}
	let exponent: i32 = exponent.parse().unwrap_or(0);
	format!("{mantissa}e{exponent:+03}")
}

fn format_general(value: f64, precision: usize, alternate: bool) -> String {
	if !value.is_finite() {
		return value.to_string();
	}
	let exponent = if value == 0.0 {
		0
	} else {
		value.log10().floor() as i32
	};
	if exponent < -4 || exponent >= precision as i32 {
		let mut text = format_scientific(value, precision - 1, !alternate);
		if alternate && precision > 1 && !text[..text.find('e').unwrap_or(text.len())].contains('.') {
			text.insert(1, '.');
		}
		text
	} else {
		let decimals = (precision as i32 - exponent - 1).max(0) as usize;
		let mut text = format!("{value:.decimals$}");
		if !alternate && text.contains('.') {
			text.truncate(text.trim_end_matches('0').trim_end_matches('.').len());
		}
		text
	}
}

fn write_escaped_argument(input: &[u8], writer: &mut impl io::Write) -> Result<bool, PrintfError> {
	let mut cursor = 0;
	let mut literal = 0;
	while cursor < input.len() {
		if input[cursor] != b'\\' {
			cursor += 1;
			continue;
		}
		writer.write_all(&input[literal..cursor])?;
		let (escaped, end, stop) = parse_escape(input, cursor + 1, true)?;
		writer.write_all(&escaped)?;
		if stop {
			return Ok(false);
		}
		cursor = end;
		literal = cursor;
	}
	writer.write_all(&input[literal..])?;
	Ok(true)
}

fn parse_escape(
	input: &[u8],
	mut cursor: usize,
	three_zero_digits: bool,
) -> Result<(Vec<u8>, usize, bool), PrintfError> {
	let Some(&code) = input.get(cursor) else {
		return Ok((vec![b'\\'], cursor, false));
	};
	cursor += 1;
	let byte = match code {
		b'\\' => Some(b'\\'),
		b'"' => Some(b'"'),
		b'a' => Some(7),
		b'b' => Some(8),
		b'c' => return Ok((Vec::new(), cursor, true)),
		b'e' => Some(27),
		b'f' => Some(12),
		b'n' => Some(b'\n'),
		b'r' => Some(b'\r'),
		b't' => Some(b'\t'),
		b'v' => Some(11),
		b'0' => Some(
			parse_radix(input, &mut cursor, 8, if three_zero_digits { 3 } else { 2 }).unwrap_or(0)
				as u8,
		),
		b'1'..=b'7' => {
			cursor -= 1;
			Some(parse_radix(input, &mut cursor, 8, 3).unwrap_or(0) as u8)
		},
		b'x' => Some(parse_radix(input, &mut cursor, 16, 2).ok_or(PrintfError::MissingHex)? as u8),
		b'u' | b'U' => {
			let digits = if code == b'u' { 4 } else { 8 };
			let offset = cursor;
			let value = parse_radix_exact(input, &mut cursor, 16, digits)
				.ok_or(PrintfError::InvalidUnicode { offset })?;
			let character = char::from_u32(value).ok_or(PrintfError::InvalidUnicode { offset })?;
			return Ok((character.to_string().into_bytes(), cursor, false));
		},
		_ => return Ok((vec![b'\\', code], cursor, false)),
	};
	Ok((vec![byte.unwrap()], cursor, false))
}

fn parse_radix(input: &[u8], cursor: &mut usize, radix: u32, limit: usize) -> Option<u32> {
	let start = *cursor;
	let mut value = 0u32;
	while *cursor < input.len() && *cursor - start < limit {
		let Some(digit) = char::from(input[*cursor]).to_digit(radix) else {
			break;
		};
		value = value.wrapping_mul(radix).wrapping_add(digit);
		*cursor += 1;
	}
	(*cursor != start).then_some(value)
}

fn parse_radix_exact(input: &[u8], cursor: &mut usize, radix: u32, digits: usize) -> Option<u32> {
	let start = *cursor;
	let value = parse_radix(input, cursor, radix, digits)?;
	(*cursor - start == digits).then_some(value)
}

#[cfg(test)]
mod tests {
	use super::format;

	fn printf(format_string: &str, arguments: &[&str]) -> String {
		let arguments = arguments
			.iter()
			.map(|value| (*value).to_owned())
			.collect::<Vec<_>>();
		let mut output = Vec::new();
		format(format_string, &arguments, &mut output).unwrap();
		String::from_utf8(output).unwrap()
	}

	#[test]
	fn strings_escapes_and_cycles() {
		assert_eq!(printf("%s|", &["x", "y"]), "x|y|");
		assert_eq!(printf("%b-after", &[r"x\ny"]), "x\ny-after");
		assert_eq!(printf(r"\101\x42\u0043", &[]), "ABC");
	}

	#[test]
	fn integer_flags_width_and_precision() {
		assert_eq!(printf("%+06d %#x %#o %.4u", &["-12", "31", "8", "7"]), "-00012 0x1f 010 0007");
		assert_eq!(printf("%#.0o %#.3o", &["0", "8"]), "0 010");
		assert_eq!(printf("%*s", &["-5", "x"]), "x    ");
	}

	#[test]
	fn floating_point_forms() {
		assert_eq!(
			printf("%.2f %.1e %.3g %.3G", &["1.25", "12", "12345", "0.00123"]),
			"1.25 1.2e+01 1.23e+04 0.00123"
		);
		assert_eq!(printf("%F %E %#.1g", &["1.5", "12", "100"]), "1.500000 1.200000E+01 1.e+02");
	}

	#[test]
	fn chars_quotes_positional_arguments_and_early_stop() {
		assert_eq!(printf("%2$s %1$c %3$q", &["abc", "two", "a b"]), "two a 'a b'");
		assert_eq!(printf("%b ignored %s", &[r"done\c", "tail"]), "done");
	}
}
