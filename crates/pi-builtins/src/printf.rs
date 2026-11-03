use std::{ffi::OsString, io::Write, ops::ControlFlow};

use brush_core::{Error, ErrorKind, ExecutionResult, builtins, escape, expansion};
use clap::Parser;
use uucore::format;

/// Format a string.
#[derive(Parser)]
#[clap(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct PrintfCommand {
	/// If specified, the output of the command is assigned to this variable.
	#[arg(short = 'v')]
	output_variable: Option<String>,

	/// Format string + arguments to the format string.
	#[arg(trailing_var_arg = true, required = true, allow_hyphen_values = true)]
	format_and_args: Vec<String>,
}

impl builtins::Command for PrintfCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		let mut errors = context.stderr();
		let mut report = Report { errors: &mut errors, invalid: false };
		if let Some(variable_name) = &self.output_variable {
			// Format to a u8 vector.
			let mut result: Vec<u8> = vec![];
			format(self.format_and_args.as_slice(), &mut result, &mut report)?;

			// Convert to a string.
			let result_str = String::from_utf8(result).map_err(|_| {
				brush_core::ErrorKind::PrintfInvalidUsage("invalid UTF-8 output".into())
			})?;

			// Assign to the selected variable.
			expansion::assign_to_named_parameter(
				context.shell,
				&context.params,
				variable_name,
				result_str,
			)
			.await?;
		} else {
			// uucore writes every literal format byte on its own, so batch them:
			// one write per call (or per 64 KiB) instead of one per byte. Flush
			// before reporting a formatting error so partial output still lands.
			let mut stdout = std::io::BufWriter::with_capacity(64 * 1024, context.stdout());
			let formatted = format(self.format_and_args.as_slice(), &mut stdout, &mut report);
			stdout.flush()?;
			formatted?;
		}

		// A number printf could not read is reported and taken as zero, as Bash
		// reports and takes it, and the command fails.
		if report.invalid {
			return Ok(ExecutionResult::general_error());
		}
		Ok(ExecutionResult::success())
	}
}

/// Where printf writes what it has to say about its own arguments, and
/// whether it could not read one of them.
struct Report<W: Write> {
	/// The shell's standard error.
	errors:  W,
	/// Whether an argument printf reads as a number is none, which it reports
	/// and takes as zero, as Bash does, and which makes the command fail.
	invalid: bool,
}

impl<W: Write> Report<W> {
	/// Reports `message`, as Bash reports it, without failing the command for
	/// a write that does not land.
	fn say(&mut self, message: std::fmt::Arguments<'_>) {
		let _ = writeln!(self.errors, "printf: {message}");
	}
}

fn format(
	format_and_args: &[String],
	writer: impl Write,
	report: &mut Report<impl Write>,
) -> Result<(), brush_core::Error> {
	match format_and_args {
		// Special-case invocation of printf with %q-based format string from bash-completion.
		// It has hard-coded expectation of backslash-style escaping instead of quoting.
		[fmt, arg] if fmt == "%q" => format_special_case_for_percent_q(None, arg, writer),
		[fmt, arg] if fmt == "~%q" => format_special_case_for_percent_q(Some("~"), arg, writer),
		// Handle format string with arguments using uucore
		[fmt, args @ ..] => format_via_uucore(fmt, args.iter(), writer, report),
		// Handle case with no format string (we shouldn't be able to get here since clap will
		// fail parsing when the format string is missing)
		[] => Err(ErrorKind::PrintfInvalidUsage("missing operand".into()).into()),
	}
}

fn format_special_case_for_percent_q(
	prefix: Option<&str>,
	arg: &str,
	mut writer: impl Write,
) -> Result<(), brush_core::Error> {
	let mut result = escape::quote_if_needed(arg, escape::QuoteMode::BackslashEscape).to_string();

	if let Some(prefix) = prefix {
		result.insert_str(0, prefix);
	}

	write!(writer, "{result}")?;

	Ok(())
}

/// Rust's formatter keeps a directive's width and precision in a `u16`: a
/// larger one ends the process with "Formatting argument out of range". No
/// shell may end that way, and Bash has no such limit, so a directive that
/// reaches one is written here instead of by uucore.
const FORMATTER_LIMIT: usize = u16::MAX as usize;

/// The digits of an `f64`'s decimal expansion, which ends at the last digit
/// of 2^-1074, 1074 places after the point: a precision past this asks for
/// zeroes, which [`write_float`] appends. Rust's own formatting writes these
/// digits exactly, where uucore's stops being exact after about a hundred.
const EXACT_DIGITS: usize = 1_100;

/// The largest width or precision Bash passes to `printf(3)`, which takes
/// them as an `int`: a larger one written in the directive makes it write
/// nothing, and a larger one read from an argument is held to this and
/// reported.
const FIELD_LIMIT: usize = i32::MAX as usize;

/// What a directive writes for its width or its precision.
#[derive(Clone, Copy)]
enum Field {
	/// The number written in the directive.
	Fixed(usize),
	/// A `*`: the number is an argument, read when the directive is written.
	Star,
}

/// A directive this writes itself.
struct Spec {
	/// The flags between the `%` and the width.
	flags:      String,
	/// The width, if one is written.
	width:      Option<Field>,
	/// The precision, if one is written.
	precision:  Option<Field>,
	/// The conversion's letter.
	conversion: u8,
}

impl Spec {
	/// Whether the flag `flag` is written.
	fn has(&self, flag: char) -> bool {
		self.flags.contains(flag)
	}
}

/// A piece of a format string split by [`scan_directives`].
enum Piece {
	/// Text with no directive in it, with its escapes still in it.
	Literal(String),
	/// A directive uucore writes as it is spelled, with one argument.
	Uucore(String),
	/// A directive this writes itself.
	Mine(Spec),
	/// A directive this cannot read, which Bash reports before it stops.
	Invalid(char),
}

/// Splits `format_string` into literal text and directives, when one of them
/// is this builtin's to write: a width or precision larger than uucore may be
/// given or read from an argument (`*`, whose size is known only then), a
/// conversion uucore does not write as Bash writes it (a float, `%b`, `%c`,
/// `%q`), or one that cannot be read at all. `None` leaves the whole string
/// to uucore, which writes the rest as Bash writes them.
fn scan_directives(format_string: &str) -> Option<Vec<Piece>> {
	let bytes = format_string.as_bytes();
	let mut pieces: Vec<Piece> = Vec::new();
	let mut literal_start = 0;
	let mut mine = false;
	let mut at = 0;
	// Holds the text before a directive until that directive is pushed, so
	// that every piece is written in the order it is written in.
	let flush = |pieces: &mut Vec<Piece>, from: usize, to: usize| {
		if to > from && let Some(text) = format_string.get(from..to) {
			pieces.push(Piece::Literal(text.to_owned()));
		}
	};
	while at < bytes.len() {
		if bytes[at] != b'%' {
			at += 1;
			continue;
		}
		let start = at;
		at += 1;
		let flags_start = at;
		while let Some(flag) = bytes.get(at) {
			if !matches!(flag, b'-' | b'0' | b'+' | b' ' | b'#' | b'\'') {
				break;
			}
			at += 1;
		}
		let flags = format_string.get(flags_start..at)?.to_owned();
		let width = eat_number(bytes, &mut at);
		let has_width = width.is_some();
		let has_precision = bytes.get(at) == Some(&b'.');
		let precision = if has_precision {
			at += 1;
			Some(eat_number(bytes, &mut at).unwrap_or(Some(Field::Fixed(0))))
		} else {
			None
		};
		let Some(&conversion) = bytes.get(at) else { return None };
		at += 1;
		if conversion == b'%' {
			continue;
		}
		// A `*` that names its argument by position (`*2$`) is no directive
		// Bash writes: it reports the character and stops.
		let (Some(width), Some(precision)) = (width.unwrap_or(Some(Field::Fixed(0))), precision.unwrap_or(Some(Field::Fixed(0))))
		else {
			mine = true;
			flush(&mut pieces, literal_start, start);
			literal_start = at;
			// Bash names the character after the `*`, which is where it
			// stops reading the directive.
			let star = format_string.get(start..at).and_then(|text| text.find('*'));
			let named = star
				.and_then(|star| bytes.get(start + star + 1).copied())
				.unwrap_or(b'*');
			pieces.push(Piece::Invalid(char::from(named)));
			break;
		};
		let large = |field: Field| matches!(field, Field::Fixed(number) if number > FORMATTER_LIMIT);
		let star = matches!(width, Field::Star) || matches!(precision, Field::Star);
		// uucore writes every directive as Bash writes it but the ones it
		// cannot be given: a field larger than its formatter holds, which
		// ends the process; a field read from an argument, whose size is
		// known only then; and a `%c` with a precision, which it refuses and
		// Bash ignores. Those are written here, and nothing else is.
		// Bash takes `#` for a decimal as no flag at all, where uucore
		// refuses the directive.
		let refused = flags.contains('#') && matches!(conversion, b'd' | b'i' | b'u');
		// `%a` and `%q` are written here whatever their field: uucore writes
		// a hexadecimal float in lower case for `%A` and quotes a string
		// where Bash escapes it with backslashes.
		let takes = refused
			|| matches!(conversion, b'a' | b'A' | b'q')
			|| star
			|| large(width)
			|| (has_precision && large(precision))
			|| (has_precision && conversion == b'c');
		if !takes {
			continue;
		}
		mine = true;
		flush(&mut pieces, literal_start, start);
		literal_start = at;
		pieces.push(Piece::Mine(Spec {
			flags,
			width: has_width.then_some(width),
			precision: has_precision.then_some(precision),
			conversion,
		}));
	}
	if !mine {
		return None;
	}
	flush(&mut pieces, literal_start, bytes.len());
	// A directive uucore writes keeps its place: the text around it is a
	// literal piece, and the directive itself is one of its own.
	Some(split_uucore_directives(pieces))
}

/// Splits each literal piece at the directives uucore writes, so that every
/// directive takes its argument in the order it is written.
fn split_uucore_directives(pieces: Vec<Piece>) -> Vec<Piece> {
	let mut split = Vec::with_capacity(pieces.len());
	for piece in pieces {
		let Piece::Literal(text) = piece else {
			split.push(piece);
			continue;
		};
		let bytes = text.as_bytes();
		let mut literal_start = 0;
		let mut at = 0;
		while at < bytes.len() {
			if bytes[at] != b'%' {
				at += 1;
				continue;
			}
			let start = at;
			at += 1;
			while bytes.get(at).is_some_and(|byte| {
				matches!(byte, b'-' | b'0' | b'+' | b' ' | b'#' | b'\'' | b'.' | b'*')
					|| byte.is_ascii_digit()
			}) {
				at += 1;
			}
			let Some(&conversion) = bytes.get(at) else { break };
			at += 1;
			if conversion == b'%' {
				continue;
			}
			if start > literal_start {
				split.push(Piece::Literal(text[literal_start..start].to_owned()));
			}
			split.push(Piece::Uucore(text[start..at].to_owned()));
			literal_start = at;
		}
		if literal_start < text.len() {
			split.push(Piece::Literal(text[literal_start..].to_owned()));
		}
	}
	split
}

/// The width or precision written at `at`, if one is there: `Some(None)` for
/// a `*` that names its argument by position (`*2$`), which Bash reports.
fn eat_number(bytes: &[u8], at: &mut usize) -> Option<Option<Field>> {
	if bytes.get(*at) == Some(&b'*') {
		*at += 1;
		let start = *at;
		while bytes.get(*at).is_some_and(u8::is_ascii_digit) {
			*at += 1;
		}
		if bytes.get(*at) == Some(&b'$') {
			*at += 1;
			return Some(None);
		}
		*at = start;
		return Some(Some(Field::Star));
	}
	let start = *at;
	while bytes.get(*at).is_some_and(u8::is_ascii_digit) {
		*at += 1;
	}
	if *at == start {
		return None;
	}
	// A number this machine cannot hold is larger than any field Bash passes
	// on, which is all the caller reads it for.
	let digits = std::str::from_utf8(&bytes[start..*at]).ok()?;
	Some(Some(Field::Fixed(digits.parse().unwrap_or(usize::MAX))))
}

/// Writes `format_string`'s pieces, taking the arguments each takes and
/// starting again while any are left, as Bash does.
fn write_pieces(
	pieces: &[Piece],
	arguments: &[OsString],
	writer: &mut dyn Write,
	report: &mut Report<impl Write>,
) -> Result<(), brush_core::Error> {
	let mut taken = 0;
	loop {
		let before = taken;
		for piece in pieces {
			match piece {
				Piece::Literal(text) => write_uucore(text, &[], writer)?,
				Piece::Uucore(spelled) => {
					let next = (taken + 1).min(arguments.len());
					let used = arguments.get(taken..next).unwrap_or_default();
					write_uucore(spelled, used, writer)?;
					taken = next;
				},
				Piece::Mine(spec) => {
					if write_field(spec, arguments, &mut taken, writer, report)? {
						return Ok(());
					}
				},
				Piece::Invalid(character) => {
					report.say(format_args!("`{character}': invalid format character"));
					report.invalid = true;
					return Ok(());
				},
			}
		}
		if taken >= arguments.len() || taken == before {
			return Ok(());
		}
	}
}

/// Writes `text` with the escapes Bash expands in a format string, or in a
/// `%b` argument when `argument` is set, where `\c` stops every later byte
/// and `\nnn` is an octal character. Returns whether `\c` stopped it.
fn write_escaped(
	text: &[u8],
	argument: bool,
	writer: &mut dyn Write,
) -> Result<bool, brush_core::Error> {
	let mut out: Vec<u8> = Vec::with_capacity(text.len());
	let mut at = 0;
	let mut stopped = false;
	while at < text.len() {
		if text[at] != b'\\' || at + 1 == text.len() {
			out.push(text[at]);
			at += 1;
			continue;
		}
		let escape = text[at + 1];
		at += 2;
		match escape {
			b'a' => out.push(0x07),
			b'b' => out.push(0x08),
			b'e' | b'E' => out.push(0x1b),
			b'f' => out.push(0x0c),
			b'n' => out.push(b'\n'),
			b'r' => out.push(b'\r'),
			b't' => out.push(b'\t'),
			b'v' => out.push(0x0b),
			b'\\' => out.push(b'\\'),
			b'c' if argument => {
				stopped = true;
				break;
			},
			b'"' | b'\'' if argument => out.push(escape),
			b'0' | b'1'..=b'7' => {
				// In a format string the octal digits follow a `0`; in a `%b`
				// argument they may follow the backslash itself.
				let mut digits = 0;
				let mut value: u32 = 0;
				if escape != b'0' {
					value = u32::from(escape - b'0');
					digits = 1;
				}
				while digits < 3 && text.get(at).is_some_and(|byte| (b'0'..=b'7').contains(byte)) {
					value = value * 8 + u32::from(text[at] - b'0');
					at += 1;
					digits += 1;
				}
				out.push(u8::try_from(value & 0xff).unwrap_or(0));
			},
			b'x' => {
				let mut digits = 0;
				let mut value: u32 = 0;
				while digits < 2 && text.get(at).is_some_and(u8::is_ascii_hexdigit) {
					value = value * 16 + u32::from(char::from(text[at]).to_digit(16).unwrap_or(0));
					at += 1;
					digits += 1;
				}
				if digits == 0 {
					out.extend_from_slice(b"\\x");
				} else {
					out.push(u8::try_from(value & 0xff).unwrap_or(0));
				}
			},
			b'u' | b'U' => {
				let places = if escape == b'u' { 4 } else { 8 };
				let mut digits = 0;
				let mut value: u32 = 0;
				while digits < places && text.get(at).is_some_and(u8::is_ascii_hexdigit) {
					value = value * 16 + u32::from(char::from(text[at]).to_digit(16).unwrap_or(0));
					at += 1;
					digits += 1;
				}
				match (digits, char::from_u32(value)) {
					(0, _) | (_, None) => {
						out.push(b'\\');
						out.push(escape);
					},
					(_, Some(character)) => {
						let mut buffer = [0u8; 4];
						out.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
					},
				}
			},
			other => {
				out.push(b'\\');
				out.push(other);
			},
		}
	}
	writer.write_all(&out)?;
	Ok(stopped)
}

/// Writes one directive this builtin writes itself, taking the arguments it
/// takes. Returns whether a `%b` argument's `\c` stopped every later byte.
fn write_field<W: Write>(
	spec: &Spec,
	arguments: &[OsString],
	taken: &mut usize,
	writer: &mut dyn Write,
	report: &mut Report<W>,
) -> Result<bool, brush_core::Error> {
	let mut read = |field: Option<Field>, report: &mut Report<W>| match field {
		Some(Field::Star) => {
			let Some(argument) = arguments.get(*taken) else { return 0 };
			*taken += 1;
			let written = argument.to_string_lossy();
			match read_number(written.trim()) {
				Ok(number) => number,
				Err(ReadError::NotANumber) => {
					report.say(format_args!("{written}: invalid number"));
					report.invalid = true;
					0
				},
	Err(ReadError::OutOfRange) => i64::MAX,
			}
		},
		Some(Field::Fixed(number)) => i64::try_from(number).unwrap_or(i64::MAX),
		None => 0,
	};
	let written_width = matches!(spec.width, Some(Field::Fixed(_)));
	let written_precision = matches!(spec.precision, Some(Field::Fixed(_)));
	let width_number = read(spec.width, report);
	let precision_number = read(spec.precision, report);
	// A number read from an argument is held to what an `int` takes, as Bash
	// holds it; a written one larger than that makes the directive write
	// nothing at all, as Bash leaves it.
	let over = |number: i64| number > i64::try_from(FIELD_LIMIT).unwrap_or(i64::MAX);
	if (written_width && over(width_number)) || (written_precision && over(precision_number)) {
		*taken = (*taken + 1).min(arguments.len());
		return Ok(false);
	}
	if (!written_width && over(width_number)) || (!written_precision && over(precision_number)) {
		let value = arguments.get(*taken).map(|value| value.to_string_lossy());
		report.say(format_args!(
			"warning: {}: Numerical result out of range",
			value.unwrap_or_default()
		));
	}
	let held = |number: i64| number.clamp(i64::from(i32::MIN), i64::from(i32::MAX));
	let width_number = held(width_number);
	let precision_number = held(precision_number);
	// A negative width is a left-justified one, as in C; a negative precision
	// is none at all.
	let left = spec.has('-') || width_number < 0;
	let width = spec.width.map_or(0, |_| width_number.unsigned_abs() as usize);
	let precision = spec
		.precision
		.and_then(|_| usize::try_from(precision_number).ok());

	let argument = arguments.get(*taken);
	*taken += usize::from(argument.is_some());
	let empty = OsString::new();
	let argument = argument.unwrap_or(&empty);
	let (mut text, stopped) = field_text(spec, precision, argument, report)?;

	// The precision an integer carries is the digits it takes at least, and
	// a string's is the bytes it keeps; a float's is already written. The
	// digits an integer is short are written in pieces, like the padding
	// below: a precision may be as large as an `int`.
	let mut digits = 0;
	if let Some(precision) = precision {
		match spec.conversion {
			b'd' | b'i' | b'o' | b'u' | b'x' | b'X' => {
				digits = precision.saturating_sub(text.len() - body_starts_at(&text));
			},
			b's' | b'b' => text.truncate(precision),
			_ => {},
		}
	}

	// The zeroes of `0` go after the sign and any `0x`, as they do for a
	// width uucore writes itself; an integer with a precision takes spaces
	// instead, as it does in C, and so does a value that is no number
	// (`inf`, `nan`), which has no digits to pad.
	let numeric = !matches!(spec.conversion, b'c' | b's' | b'b' | b'q')
		&& text.iter().any(u8::is_ascii_digit);
	// An integer with a precision pads with spaces, as it does in C, whether
	// or not that precision adds a digit of its own.
	let precise_integer =
		precision.is_some() && matches!(spec.conversion, b'd' | b'i' | b'o' | b'u' | b'x' | b'X');
	let zeroes = spec.has('0') && numeric && !precise_integer;
	let padding = width.saturating_sub(text.len() + digits);
	// Where the field's own digits start, which the zeroes of a precision
	// and of `0` are written before.
	let head = if digits > 0 || zeroes {
		// The zeroes a precision asks for, and those of `0`, go after the
		// sign and any `0x`, as uucore places them itself.
		body_starts_at(&text)
	} else if left || padding == 0 {
		text.len()
	} else {
		0
	};

	// Nothing here is built as one string: a field may be as wide as an
	// `int`, which is two gigabytes of it.
	let mut piece = [b' '; 8 * 1024];
	let mut pour = |writer: &mut dyn Write, byte: u8, mut left: usize| -> std::io::Result<()> {
		if byte != b' ' {
			piece.fill(byte);
		}
		while left > 0 {
			let now = left.min(piece.len());
			writer.write_all(&piece[..now])?;
			left -= now;
		}
		if byte != b' ' {
			piece.fill(b' ');
		}
		Ok(())
	};
	if left {
		writer.write_all(&text[..head])?;
		pour(writer, b'0', digits)?;
		writer.write_all(&text[head..])?;
		pour(writer, b' ', padding)?;
	} else {
		if !zeroes {
			pour(writer, b' ', padding)?;
		}
		writer.write_all(&text[..head])?;
		if zeroes {
			pour(writer, b'0', padding)?;
		}
		pour(writer, b'0', digits)?;
		writer.write_all(&text[head..])?;
	}
	Ok(stopped)
}

/// The bytes one directive writes for `argument`, before its width pads them.
/// Returns whether a `%b` argument's `\c` stopped every later byte.
fn field_text(
	spec: &Spec,
	precision: Option<usize>,
	argument: &OsString,
	report: &mut Report<impl Write>,
) -> Result<(Vec<u8>, bool), brush_core::Error> {
	let written = argument.to_string_lossy();
	match spec.conversion {
		b's' => Ok((argument.as_encoded_bytes().to_vec(), false)),
		b'b' => {
			let mut text = Vec::new();
			let stopped = write_escaped(argument.as_encoded_bytes(), true, &mut text)?;
			Ok((text, stopped))
		},
		b'c' => {
			let first = written.chars().next();
			Ok((first.map(|c| c.to_string().into_bytes()).unwrap_or_default(), false))
		},
		b'q' => {
			let quoted = escape::quote_if_needed(&written, escape::QuoteMode::BackslashEscape);
			Ok((quoted.into_owned().into_bytes(), false))
		},
		b'e' | b'E' | b'f' | b'F' | b'g' | b'G' => {
			Ok((write_float(spec, precision, &written, report), false))
		},
		b'a' | b'A' => Ok((write_hex_float(spec, precision, &written, report), false)),
		_ => {
			// An integer, which uucore writes as Bash writes it, without the
			// field this pads itself. Bash takes `#` for an integer as no
			// flag at all, where uucore refuses it.
			let mut reduced = String::from("%");
			for flag in spec.flags.chars() {
				if flag != '#' || matches!(spec.conversion, b'o' | b'x' | b'X') {
					reduced.push(flag);
				}
			}
			reduced.push(char::from(spec.conversion));
			let mut text = Vec::new();
			write_uucore(&reduced, std::slice::from_ref(argument), &mut text)?;
			Ok((text, false))
		},
	}
}

/// What `%e`, `%f` and `%g` write for `written`: Rust's own formatting, whose
/// digits are exact, held to the digits an `f64` has and extended with the
/// zeroes a larger precision asks for, as Bash writes them.
fn write_float(
	spec: &Spec,
	precision: Option<usize>,
	written: &str,
	report: &mut Report<impl Write>,
) -> Vec<u8> {
	let value = read_float(written, report);
	let upper = spec.conversion.is_ascii_uppercase();
	let sign = if value.is_sign_negative() {
		"-"
	} else if spec.has('+') {
		"+"
	} else if spec.has(' ') {
		" "
	} else {
		""
	};
	if !value.is_finite() {
		let name = if value.is_nan() { "nan" } else { "inf" };
		let name = if upper { name.to_uppercase() } else { name.to_owned() };
		return format!("{sign}{name}").into_bytes();
	}
	let value = value.abs();
	let precision = precision.unwrap_or(6);
	let alternate = spec.has('#');
	let body = match spec.conversion.to_ascii_lowercase() {
		b'f' => {
			let mut text = format!("{value:.*}", precision.min(EXACT_DIGITS));
			let end = text.len();
			extend_zeroes(&mut text, precision, end);
			if precision == 0 && alternate {
				text.push('.');
			}
			text
		},
		b'e' => exponent_form(value, precision, alternate, upper),
		_ => {
			// `%g` writes the shorter of the two forms, counting significant
			// digits, and drops the zeroes at the end unless `#` keeps them.
			let significant = precision.max(1);
			let exponent = decimal_exponent(value, significant);
			let mut text = if exponent < -4 || exponent >= i64::try_from(significant).unwrap_or(i64::MAX) {
				exponent_form(value, significant - 1, alternate, upper)
			} else {
				let places = usize::try_from(i64::try_from(significant - 1).unwrap_or(0) - exponent)
					.unwrap_or(0);
				let mut text = format!("{value:.*}", places.min(EXACT_DIGITS));
				let end = text.len();
				extend_zeroes(&mut text, places, end);
				if places == 0 && alternate {
					text.push('.');
				}
				text
			};
			if !alternate {
				strip_zeroes(&mut text);
			}
			text
		},
	};
	format!("{sign}{body}").into_bytes()
}

/// What `%a` writes for `written`: uucore's hexadecimal digits, which are
/// exact and few, with the zeroes a larger precision asks for.
fn write_hex_float(
	spec: &Spec,
	precision: Option<usize>,
	written: &str,
	report: &mut Report<impl Write>,
) -> Vec<u8> {
	let value = read_float(written, report);
	let mut reduced = String::from("%");
	reduced.push_str(&spec.flags);
	if let Some(precision) = precision.filter(|precision| *precision <= FORMATTER_LIMIT) {
		reduced.push('.');
		reduced.push_str(&precision.to_string());
	}
	reduced.push('a');
	let mut text = Vec::new();
	// uucore reads the number as a decimal it holds exactly, so it is given
	// every digit of the value, which 767 after the point reach for any
	// `f64`: the shortest one that reads back (`5e-324`) is a different
	// number to it, whose hexadecimal digits are not the value's.
	let exact = if value.is_finite() { format!("{value:.767e}") } else { value.to_string() };
	let _ = write_uucore(&reduced, &[OsString::from(exact)], &mut text);
	let mut text = String::from_utf8(text).unwrap_or_default();
	if let Some(precision) = precision.filter(|precision| *precision > FORMATTER_LIMIT)
		&& text.bytes().any(|byte| byte.is_ascii_digit())
	{
		let exponent = text.find(['p', 'P']).unwrap_or(text.len());
		extend_zeroes(&mut text, precision, exponent);
	}
	if spec.conversion == b'A' {
		text = text.to_uppercase();
	}
	text.into_bytes()
}

/// `value` in the form `%e` writes, with `places` digits after the point and
/// an exponent of at least two digits, as C writes it.
fn exponent_form(value: f64, places: usize, alternate: bool, upper: bool) -> String {
	let written = format!("{value:.*e}", places.min(EXACT_DIGITS));
	let (mantissa, exponent) = written.split_once('e').unwrap_or((written.as_str(), "0"));
	let mut mantissa = mantissa.to_owned();
	let end = mantissa.len();
	extend_zeroes(&mut mantissa, places, end);
	if places == 0 && alternate {
		mantissa.push('.');
	}
	let exponent: i64 = exponent.parse().unwrap_or(0);
	let marker = if upper { 'E' } else { 'e' };
	let sign = if exponent < 0 { '-' } else { '+' };
	format!("{mantissa}{marker}{sign}{:02}", exponent.unsigned_abs())
}

/// The power of ten `value` is written with when `%g` counts `significant`
/// digits of it.
fn decimal_exponent(value: f64, significant: usize) -> i64 {
	if value == 0.0 {
		return 0;
	}
	let written = format!("{value:.*e}", (significant - 1).min(EXACT_DIGITS));
	written.split_once('e').and_then(|(_, exponent)| exponent.parse().ok()).unwrap_or(0)
}

/// Extends the digits after the point in `text` to `places` of them, where
/// they end at `end`: Rust writes every digit an `f64` has, and the rest are
/// zeroes.
fn extend_zeroes(text: &mut String, places: usize, end: usize) {
	let point = text[..end].find('.');
	let written = point.map_or(0, |point| end - point - 1);
	if written >= places {
		return;
	}
	let mut zeroes = String::with_capacity(places - written + 1);
	if point.is_none() {
		zeroes.push('.');
	}
	for _ in written..places {
		zeroes.push('0');
	}
	text.insert_str(end, &zeroes);
}

/// Drops the zeroes at the end of `text`'s digits, and the point with them,
/// as `%g` drops them.
fn strip_zeroes(text: &mut String) {
	let Some(point) = text.find('.') else { return };
	let end = text.find(['e', 'E']).unwrap_or(text.len());
	let mut keep = end;
	while keep > point + 1 && text.as_bytes()[keep - 1] == b'0' {
		keep -= 1;
	}
	if keep == point + 1 {
		keep = point;
	}
	text.replace_range(keep..end, "");
}

/// The number `written` holds, as Bash reads a `%f` argument: a decimal or
/// hexadecimal float, or a character constant. One that is no number is
/// reported and taken as zero, as Bash reports and takes it.
fn read_float(written: &str, report: &mut Report<impl Write>) -> f64 {
	let written = written.trim();
	if written.is_empty() {
		return 0.0;
	}
	if let Some(character) = written.strip_prefix('\'').or(written.strip_prefix('"')) {
		return character.chars().next().map_or(0.0, |c| f64::from(u32::from(c)));
	}
	if let Ok(value) = written.parse::<f64>() {
		return value;
	}
	if let Some(value) = read_hex_float(written) {
		return value;
	}
	report.say(format_args!("{written}: invalid number"));
	report.invalid = true;
	0.0
}

/// The value of a hexadecimal float (`0x1p-1074`), which Rust does not parse.
fn read_hex_float(written: &str) -> Option<f64> {
	let (negative, rest) = match written.strip_prefix('-') {
		Some(rest) => (true, rest),
		None => (false, written.strip_prefix('+').unwrap_or(written)),
	};
	let rest = rest.strip_prefix("0x").or(rest.strip_prefix("0X"))?;
	let (digits, exponent) = match rest.split_once(['p', 'P']) {
		Some((digits, exponent)) => (digits, exponent.parse::<i32>().ok()?),
		None => (rest, 0),
	};
	let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
	if whole.is_empty() && fraction.is_empty() {
		return None;
	}
	let mut value = 0.0f64;
	for digit in whole.chars() {
		value = value * 16.0 + f64::from(digit.to_digit(16)?);
	}
	let mut place = 1.0 / 16.0;
	for digit in fraction.chars() {
		value += f64::from(digit.to_digit(16)?) * place;
		place /= 16.0;
	}
	// The power of two is taken in steps: the smallest `f64` is 2^-1074, and
	// one step of `powi` past 2^-1022 is already zero.
	let mut left = exponent;
	while left != 0 {
		let step = left.clamp(-500, 500);
		value *= 2.0f64.powi(step);
		left -= step;
	}
	Some(if negative { -value } else { value })
}

/// Why [`read_number`] could not read an argument.
enum ReadError {
	/// It is no number at all.
	NotANumber,
	/// It is a number larger than this machine holds.
	OutOfRange,
}

/// The number `written` holds, as Bash reads a width, a precision or a `%d`
/// argument: a decimal, a hexadecimal after `0x`, an octal after `0`, or the
/// character after a quote, with a sign and nothing else around it.
fn read_number(written: &str) -> Result<i64, ReadError> {
	if written.is_empty() {
		return Ok(0);
	}
	if let Some(character) = written.strip_prefix('\'').or(written.strip_prefix('"')) {
		return Ok(character.chars().next().map_or(0, |c| i64::from(u32::from(c))));
	}
	let (negative, digits) = match written.strip_prefix('-') {
		Some(digits) => (true, digits),
		None => (false, written.strip_prefix('+').unwrap_or(written)),
	};
	let read = if let Some(hexadecimal) = digits.strip_prefix("0x").or(digits.strip_prefix("0X")) {
		i64::from_str_radix(hexadecimal, 16)
	} else if digits.len() > 1 && digits.starts_with('0') {
		i64::from_str_radix(&digits[1..], 8)
	} else {
		digits.parse()
	};
	match read {
		Ok(number) => Ok(if negative { -number } else { number }),
		// A number past what this holds is still a number: Bash reports it as
		// out of range and holds it to what an `int` takes.
		// A number this machine cannot hold is still a number, which Bash
		// reports as out of range and holds to what an `int` takes; one that
		// is no number at all it reports and takes as zero.
		Err(_) if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) => {
			Err(ReadError::OutOfRange)
		},
		Err(_) => Err(ReadError::NotANumber),
	}
}

/// Where a number's own digits start in `text`: after a sign, a space held
/// for one, and the `0x` of a hexadecimal.
fn body_starts_at(text: &[u8]) -> usize {
	let mut head = 0;
	while matches!(text.get(head), Some(b'-' | b'+' | b' ')) {
		head += 1;
	}
	if matches!(text.get(head), Some(b'0')) && matches!(text.get(head + 1), Some(b'x' | b'X')) {
		head += 2;
	}
	head
}

/// Writes `format_string` with `args`, the arguments printf was given.
fn format_via_uucore(
	format_string: &str,
	args: impl Iterator<Item = impl Into<OsString>>,
	mut writer: impl Write,
	report: &mut Report<impl Write>,
) -> Result<(), brush_core::Error> {
	let arguments: Vec<OsString> = args.map(Into::into).collect();
	write_with_uucore(format_string, &arguments, &mut writer, report)
}

/// [`format_via_uucore`] with the writer and the arguments as they are, so
/// that the pieces of a format string this writes itself do not make another
/// copy of it for every writer they pass on (see [`write_pieces`]).
///
/// A directive whose field is larger than the formatter takes, or whose
/// conversion uucore does not write as Bash writes it, is written here, not
/// by uucore, which would end the process or write something else.
fn write_with_uucore(
	format_string: &str,
	arguments: &[OsString],
	writer: &mut dyn Write,
	report: &mut Report<impl Write>,
) -> Result<(), brush_core::Error> {
	// Every argument a directive reads as a number is read here first: uucore
	// reports one it cannot read on this process's own standard error, which
	// is not the shell's and may be a terminal someone is reading, and it
	// leaves the command successful. Bash reports it on the shell's standard
	// error, writes what it could read, and fails.
	let arguments = read_numbers(format_string, arguments, report);
	match scan_directives(format_string) {
		Some(pieces) => write_pieces(&pieces, &arguments, writer, report),
		None => write_uucore(format_string, &arguments, writer),
	}
}

/// The arguments as the directives of `format_string` read them: one a
/// directive reads as a number and cannot is reported and replaced by what
/// could be read of it, which is nothing for a word that is no number at
/// all, as Bash reports and takes them.
fn read_numbers(
	format_string: &str,
	arguments: &[OsString],
	report: &mut Report<impl Write>,
) -> Vec<OsString> {
	let mut arguments = arguments.to_vec();
	let bytes = format_string.as_bytes();
	let mut taken = 0;
	loop {
		let before = taken;
		let mut at = 0;
		while at < bytes.len() {
			if bytes[at] != b'%' {
				at += 1;
				continue;
			}
			at += 1;
			let mut stars = 0;
			while let Some(byte) = bytes.get(at) {
				match byte {
					b'-' | b'0' | b'+' | b' ' | b'#' | b'\'' | b'.' => at += 1,
					b'*' => {
						stars += 1;
						at += 1;
					},
					byte if byte.is_ascii_digit() => at += 1,
					_ => break,
				}
			}
			let Some(&conversion) = bytes.get(at) else { break };
			at += 1;
			if conversion == b'%' {
				continue;
			}
			// A `*` reads a number of its own, which [`write_field`] reports.
			taken = (taken + stars).min(arguments.len());
			let Some(argument) = arguments.get(taken) else { break };
			let written = argument.to_string_lossy().trim().to_owned();
			let read = match conversion {
				b'd' | b'i' | b'o' | b'u' | b'x' | b'X' => read_number_or_report(&written, report),
				b'e' | b'E' | b'f' | b'F' | b'g' | b'G' | b'a' | b'A' => {
					read_float_or_report(&written, report)
				},
				_ => None,
			};
			if let Some(read) = read {
				arguments[taken] = OsString::from(read);
			}
			taken += 1;
		}
		if taken >= arguments.len() || taken == before {
			return arguments;
		}
	}
}

/// What a `%d` argument holds, when it is not a number this writes as it is:
/// `None` leaves the argument alone.
fn read_number_or_report(written: &str, report: &mut Report<impl Write>) -> Option<String> {
	if written.is_empty() || read_number(written).is_ok() {
		return None;
	}
	report.say(format_args!("{written}: invalid number"));
	report.invalid = true;
	// Bash writes what it could read of the word, which is the digits it
	// starts with, and nothing for a word that starts with none.
	let digits = written.strip_prefix(['-', '+']).unwrap_or(written);
	let end = digits.bytes().position(|byte| !byte.is_ascii_digit()).unwrap_or(digits.len());
	let sign = if written.starts_with('-') { "-" } else { "" };
	Some(format!("{sign}{}", if end == 0 { "0" } else { &digits[..end] }))
}

/// What a `%f` argument holds, when it is not a number this writes as it is.
fn read_float_or_report(written: &str, report: &mut Report<impl Write>) -> Option<String> {
	if written.is_empty() || written.parse::<f64>().is_ok() || read_hex_float(written).is_some() {
		return None;
	}
	// `nan(…)` is a number with a payload, which Bash reads and writes as
	// `nan`; uucore reads neither.
	let named = written.strip_prefix(['-', '+']).unwrap_or(written).to_ascii_lowercase();
	if named.starts_with("nan(") && named.ends_with(')') {
		let sign = if written.starts_with('-') { "-" } else { "" };
		return Some(format!("{sign}nan"));
	}
	if written.starts_with('\'') || written.starts_with('"') {
		return None;
	}
	report.say(format_args!("{written}: invalid number"));
	report.invalid = true;
	let digits = written.strip_prefix(['-', '+']).unwrap_or(written);
	let end = digits
		.bytes()
		.position(|byte| !byte.is_ascii_digit() && byte != b'.')
		.unwrap_or(digits.len());
	let sign = if written.starts_with('-') { "-" } else { "" };
	let read = &digits[..end];
	Some(format!("{sign}{}", if read.is_empty() || read == "." { "0" } else { read }))
}

/// [`write_with_uucore`] for a format string uucore is to write as it is,
/// which the pieces of one this writes itself are.
fn write_uucore(
	format_string: &str,
	arguments: &[OsString],
	mut writer: &mut dyn Write,
) -> Result<(), brush_core::Error> {
	// Convert string arguments to FormatArgument::Unparsed
	let format_args: Vec<_> = arguments
		.iter()
		.map(|arg| format::FormatArgument::Unparsed(arg.clone()))
		.collect();

	// Parse format string once.
	let format_items = parse_format_string(format_string)?;

	// Wrap the format arguments.
	let mut format_args_wrapper = format::FormatArguments::new(&format_args);

	// Keep going until we've exhausted all format arguments. Also make sure to run
	// at least once even if there's no format arguments.
	// A format with no directive that takes an argument is written once, as
	// Bash writes it: starting again would never reach the arguments.
	let takes_arguments = format_items.iter().any(|item| matches!(item, format::FormatItem::Spec(_)));
	while format_args.is_empty() || !format_args_wrapper.is_exhausted() {
		// Process all format items, in order. We'll bail when we're told to stop.
		for item in &format_items {
			let control_flow =
				item
					.write(&mut writer, &mut format_args_wrapper)
					.map_err(|e| match e {
						// Propagate I/O errors directly so they can be handled appropriately
						format::FormatError::IoError(io_err) => Error::from(io_err),
						// Wrap other format errors
						other => Error::from(ErrorKind::PrintfInvalidUsage(std::format!(
							"printf formatting error: {other}"
						))),
					})?;

			if control_flow == ControlFlow::Break(()) {
				break;
			}
		}

		// Start next batch if not exhausted
		if !format_args_wrapper.is_exhausted() {
			format_args_wrapper.start_next_batch();
		}

		if format_args.is_empty() || !takes_arguments {
			break;
		}
	}

	Ok(())
}

fn parse_format_string(
	format_string: &str,
) -> Result<Vec<format::FormatItem<format::EscapedChar>>, brush_core::Error> {
	let format_items: Result<Vec<_>, _> =
		format::parse_spec_and_escape(format_string.as_bytes()).collect();

	// Observe any errors we encountered along the way.
	let format_items = format_items
		.map_err(|e| ErrorKind::PrintfInvalidUsage(format!("printf parsing error: {e}")))?;

	Ok(format_items)
}

#[cfg(test)]
#[expect(clippy::panic_in_result_fn)]
mod tests {
	use anyhow::Result;

	use super::*;

	fn sprintf_via_uucore(
		format_string: &str,
		args: impl Iterator<Item = impl Into<OsString>>,
	) -> Result<String> {
		let mut result = vec![];
		let mut errors = Vec::new();
		let mut report = Report { errors: &mut errors, invalid: false };
		format_via_uucore(format_string, args, &mut result, &mut report)?;
		assert!(errors.is_empty(), "printf said {}", String::from_utf8_lossy(&errors));

		Ok(String::from_utf8(result)?)
	}

	#[test]
	fn test_basic_sprintf() -> Result<()> {
		assert_eq!(sprintf_via_uucore("%s", std::iter::once(&"xyz"))?, "xyz");
		assert_eq!(sprintf_via_uucore(r"%d\n", std::iter::once(&"1"))?, "1\n");

		Ok(())
	}

	#[test]
	fn test_sprintf_without_args() -> Result<()> {
		let empty: [&str; 0] = [];

		assert_eq!(sprintf_via_uucore("xyz", empty.iter())?, "xyz");
		assert_eq!(sprintf_via_uucore("%s|", empty.iter())?, "|");

		Ok(())
	}

	#[test]
	fn test_sprintf_with_cycles() -> Result<()> {
		assert_eq!(sprintf_via_uucore("%s|", ["x", "y"].iter())?, "x|y|");

		Ok(())
	}

	/// A width or precision larger than the formatter takes is written here,
	/// as Bash 5.2.21 writes it, instead of ending the process. Each row's
	/// length and ends are Bash's.
	#[test]
	fn wide_fields_follow_bash() -> Result<()> {
		let one = |format: &str, arg: &str| sprintf_via_uucore(format, std::iter::once(arg));

		let width = one("%0200000d", "1")?;
		assert_eq!(width.len(), 200_000);
		assert!(width.starts_with("00000") && width.ends_with('1'));

		assert_eq!(one("%-70000d", "7")?.len(), 70_000);
		assert!(one("%-70000d", "7")?.starts_with("7 "));
		assert!(one("%+070000d", "7")?.starts_with("+000"));
		assert!(one("%#070000x", "255")?.starts_with("0x000"));
		assert!(one("%70000s", "abc")?.starts_with("   "));
		assert_eq!(one("%70000c", "y")?.len(), 70_000);

		// A precision is the digits an integer takes at least.
		assert_eq!(one("%.70000d", "-7")?.len(), 70_001);
		assert!(one("%.70000d", "-7")?.starts_with("-000"));
		assert_eq!(one("%.70000x", "255")?.len(), 70_000);

		// A precision is the decimals a float takes, before any exponent.
		assert_eq!(one("%.70000f", "1.5")?.len(), 70_002);
		assert_eq!(one("%.70000e", "1.5")?.len(), 70_006);
		assert!(one("%.70000e", "1.5")?.ends_with("0e+00"));
		// `%g` counts significant digits and drops trailing zeroes.
		assert_eq!(one("%.70000g", "1.5")?, "1.5");

		// A precision never shortens a string, and `%c` has none.
		assert_eq!(one("%.70000s", "abc")?, "abc");
		assert_eq!(one("%.70000c", "yz")?, "y");
		assert_eq!(one("%.5c", "yz")?, "y");

		// Text and other directives around a wide one keep their place, and
		// the format starts again while arguments remain.
		assert_eq!(
			sprintf_via_uucore("[%s|%.70000s]", ["a", "b", "c", "d"].iter())?.len(),
			2 * "[a|b]".len()
		);

		Ok(())
	}
}
