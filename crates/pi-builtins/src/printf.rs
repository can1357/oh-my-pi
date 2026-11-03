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
/// reaches it is formatted here without it, and its result is padded or
/// extended to what Bash prints.
const FORMATTER_LIMIT: usize = u16::MAX as usize;

/// The precision uucore is given for a float whose own is larger: every
/// `f64`'s decimal and hexadecimal expansion ends well inside this many
/// digits, so the digits past it are zeroes, which [`write_wide`] appends.
const FLOAT_DIGITS: usize = 2_000;

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

/// A piece of a format string split by [`scan_wide_directives`].
enum Piece {
	/// Text with no directive in it but `%%`, which uucore writes for its
	/// escapes.
	Literal(String),
	/// A directive uucore writes as it is spelled, with one argument.
	Plain(String),
	/// A directive whose width or precision is larger than uucore may be
	/// given, or a `%c` with a precision, which uucore refuses and Bash
	/// ignores.
	Wide {
		/// The directive as uucore may write it.
		reduced:    String,
		/// The width to pad the field to, when it is the large one.
		width:      Option<usize>,
		/// Whether `-` pads the field on the right.
		left:       bool,
		/// Whether `0` pads a number with zeroes.
		zeroes:     bool,
		/// The precision, when it is the large one: the digits an integer
		/// takes at least, or the decimals a float takes.
		precision:  Option<usize>,
		/// The conversion's letter.
		conversion: u8,
	},
	/// A directive whose width or precision is an argument: how large it is
	/// is known only once that argument is read, so the directive is built
	/// then, as [`Piece::Plain`] or as [`Piece::Wide`].
	Star {
		/// The flags between the `%` and the width.
		flags:      String,
		/// The width, which may be the `*`.
		width:      Option<Field>,
		/// The precision, which may be the `*`.
		precision:  Option<Field>,
		/// The conversion's letter.
		conversion: u8,
	},
	/// A directive whose written width or precision is larger than Bash
	/// passes to `printf(3)`: it writes nothing and takes its argument, as
	/// Bash leaves it.
	Nothing,
}

/// Splits `format_string` into literal text and directives when one of them
/// carries a width or precision larger than uucore may be given, carries one
/// as an argument (a `*`, whose size is known only then), or is a `%c` with a
/// precision, which uucore refuses and Bash ignores. `None` leaves the whole
/// string to uucore, as does a directive this cannot read, which uucore
/// reports.
fn scan_wide_directives(format_string: &str) -> Option<Vec<Piece>> {
	let bytes = format_string.as_bytes();
	let mut pieces: Vec<Piece> = Vec::new();
	let mut literal = String::new();
	let mut wide = false;
	let mut at = 0;
	while at < bytes.len() {
		if bytes[at] != b'%' {
			literal.push(char::from(bytes[at]));
			at += 1;
			continue;
		}
		let start = at;
		at += 1;
		let mut left = false;
		let mut zeroes = false;
		while let Some(&flag) = bytes.get(at) {
			match flag {
				b'-' => left = true,
				b'0' => zeroes = true,
				b'+' | b' ' | b'#' | b'\'' => {},
				_ => break,
			}
			at += 1;
		}
		let width_start = at;
		let width = eat_number(bytes, &mut at);
		let width_end = at;
		let has_width = width_end > width_start;
		let has_precision = bytes.get(at) == Some(&b'.');
		let precision = if has_precision {
			at += 1;
			Some(eat_number(bytes, &mut at).unwrap_or(Some(Field::Fixed(0))))
		} else {
			None
		};
		let Some(&conversion) = bytes.get(at) else { return None };
		at += 1;
		let spelled = format_string.get(start..at)?.to_owned();
		if conversion == b'%' {
			literal.push_str(&spelled);
			continue;
		}
		let width = width.unwrap_or(Some(Field::Fixed(0)));
		let precision = precision.unwrap_or(Some(Field::Fixed(0)));
		// A number this machine cannot hold is uucore's to report.
		let (Some(width), Some(precision)) = (width, precision) else { return None };
		// A `*` says the number is an argument: how large it is, and so
		// whether uucore may be given it at all, is known only then.
		if matches!(width, Field::Star) || matches!(precision, Field::Star) {
			wide = true;
			if !literal.is_empty() {
				pieces.push(Piece::Literal(std::mem::take(&mut literal)));
			}
			pieces.push(Piece::Star {
				flags: format_string.get(start + 1..width_start)?.to_owned(),
				width: has_width.then_some(width),
				precision: has_precision.then_some(precision),
				conversion,
			});
			continue;
		}
		let (Field::Fixed(width), Field::Fixed(precision)) = (width, precision) else {
			return None;
		};
		// A width or precision larger than an `int` makes Bash write the
		// directive as nothing at all, its argument taken.
		if width > FIELD_LIMIT || (has_precision && precision > FIELD_LIMIT) {
			wide = true;
			if !literal.is_empty() {
				pieces.push(Piece::Literal(std::mem::take(&mut literal)));
			}
			pieces.push(Piece::Nothing);
			continue;
		}
		let float = matches!(conversion, b'e' | b'E' | b'f' | b'F' | b'g' | b'G' | b'a' | b'A');
		let wide_width = width > FORMATTER_LIMIT;
		let wide_precision =
			has_precision && precision > if float { FLOAT_DIGITS } else { FORMATTER_LIMIT };
		let ignored_precision = has_precision && conversion == b'c';
		if !(wide_width || wide_precision || ignored_precision) {
			pieces.push(Piece::Plain(spelled));
			continue;
		}
		wide = true;
		if !literal.is_empty() {
			pieces.push(Piece::Literal(std::mem::take(&mut literal)));
		}
		// What uucore is given: the flags, the width unless it is too large,
		// and the precision unless it is too large, dropped for `%c` or held
		// to the digits a float's expansion needs.
		let mut reduced = String::from("%");
		reduced.push_str(format_string.get(start + 1..width_start)?);
		if !wide_width {
			reduced.push_str(format_string.get(width_start..width_end)?);
		}
		if has_precision && !ignored_precision {
			if wide_precision {
				reduced.push_str(".2000");
			} else {
				reduced.push_str(format_string.get(width_end..at - 1)?);
			}
		}
		reduced.push(char::from(conversion));
		pieces.push(Piece::Wide {
			reduced,
			width: wide_width.then_some(width),
			left,
			zeroes,
			precision: wide_precision.then_some(precision),
			conversion,
		});
	}
	if !wide {
		return None;
	}
	if !literal.is_empty() {
		pieces.push(Piece::Literal(literal));
	}
	Some(pieces)
}

/// The width or precision written at `at`, if one is there: `Some(None)` for
/// a number too large for this machine, or for a `*` that names its argument
/// by position (`*2$`), which this does not read and uucore reports.
fn eat_number(bytes: &[u8], at: &mut usize) -> Option<Option<Field>> {
	if bytes.get(*at) == Some(&b'*') {
		*at += 1;
		// A `*` may also name an argument by position (`*2$`).
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

/// Writes one directive whose width or precision is larger than uucore may be
/// given: uucore writes it without that width or precision, and the text it
/// leaves is extended to the digits the precision asks for and padded to the
/// width, as Bash writes them.
fn write_wide(
	reduced: &str,
	width: Option<usize>,
	left: bool,
	zeroes: bool,
	precision: Option<usize>,
	conversion: u8,
	argument: Option<&OsString>,
	writer: &mut dyn Write,
) -> Result<(), brush_core::Error> {
	let mut text = Vec::new();
	write_uucore(reduced, argument.map(std::slice::from_ref).unwrap_or_default(), &mut text)?;
	let mut text = String::from_utf8(text)
		.map_err(|_| ErrorKind::PrintfInvalidUsage("invalid UTF-8 output".into()))?;

	if let Some(precision) = precision {
		let digits = matches!(conversion, b'd' | b'i' | b'o' | b'u' | b'x' | b'X');
		let float = matches!(conversion, b'e' | b'E' | b'f' | b'F' | b'a' | b'A');
		if digits {
			// The value takes at least this many digits, zeroes before it,
			// after any sign and any `0x`.
			let head = body_starts_at(&text);
			let body = text.len() - head;
			if body < precision {
				text.insert_str(head, &"0".repeat(precision - body));
			}
		} else if float && text.bytes().any(|byte| byte.is_ascii_digit()) {
			// A float takes this many digits after the point, and uucore
			// wrote the first `FLOAT_DIGITS` of them, which is past the end
			// of the value's expansion, so the rest are zeroes; they go
			// before the exponent. `%g` counts significant digits and drops
			// trailing zeroes, so what uucore wrote is already what Bash
			// writes. A value that is no number (`inf`, `nan`) has no digits
			// at all, and Bash writes it as it is.
			let mut exponent = text
				.find(['e', 'E', 'p', 'P'])
				.filter(|_| matches!(conversion, b'e' | b'E' | b'a' | b'A'))
				.unwrap_or(text.len());
			let point = text[..exponent].find('.');
			let written = point.map_or(0, |point| exponent - point - 1);
			if written < precision {
				if point.is_none() {
					text.insert(exponent, '.');
					exponent += 1;
				}
				text.insert_str(exponent, &"0".repeat(precision - written));
			}
		}
	}

	let padding = width.unwrap_or(0).saturating_sub(text.len());
	if padding == 0 {
		writer.write_all(text.as_bytes())?;
		return Ok(());
	}
	// The padding is written on its own, in pieces: a field may be as wide as
	// an `int`, which is two gigabytes of it.
	let (head, fill) = if left {
		(text.len(), b' ')
	} else if zeroes && !matches!(conversion, b'c' | b's' | b'b') {
		// Zeroes go after the sign and any `0x`, as they do for a width
		// uucore writes itself.
		(body_starts_at(&text), b'0')
	} else {
		(0, b' ')
	};
	writer.write_all(text[..head].as_bytes())?;
	let piece = [fill; 8 * 1024];
	let mut left_to_write = padding;
	while left_to_write > 0 {
		let now = left_to_write.min(piece.len());
		writer.write_all(&piece[..now])?;
		left_to_write -= now;
	}
	writer.write_all(text[head..].as_bytes())?;
	Ok(())
}

/// Where a number's own digits start in `text`: after a sign, a space held
/// for one, and the `0x` of a hexadecimal.
fn body_starts_at(text: &str) -> usize {
	let body = text.trim_start_matches(['-', '+', ' ']);
	let body = body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")).unwrap_or(body);
	text.len() - body.len()
}

/// Writes one directive whose width or precision is an argument: the numbers
/// are read, and the directive is written with them in it, by uucore when it
/// may be given them and by [`write_wide`] when it may not. An argument that
/// is no number is reported and taken as zero, and one larger than an `int`
/// is reported and held to it, as Bash reports and holds them.
fn write_star<W: Write>(
	flags: &str,
	width: Option<Field>,
	precision: Option<Field>,
	conversion: u8,
	arguments: &[OsString],
	taken: &mut usize,
	writer: &mut dyn Write,
	report: &mut Report<W>,
) -> Result<(), brush_core::Error> {
	// A `%` with a `*` in it is written from its parts, never as it was
	// spelled: uucore cannot be given a field this may have read.
	let mut read = |field: Option<Field>, report: &mut Report<W>| match field {
		Some(Field::Star) => {
			let Some(argument) = arguments.get(*taken) else { return 0 };
			*taken += 1;
			let written = argument.to_string_lossy();
			match read_number(written.trim()) {
				Some(number) => number,
				None => {
					report.say(format_args!("{written}: invalid number"));
					report.invalid = true;
					0
				},
			}
		},
		Some(Field::Fixed(number)) => i64::try_from(number).unwrap_or(i64::MAX),
		None => 0,
	};
	let width_number = read(width, report);
	let precision_number = read(precision, report);
	// A field larger than an `int` is held to one, which Bash reports against
	// the argument the directive writes.
	let held = i64::from(i32::MIN)..=i64::from(i32::MAX);
	if !(held.contains(&width_number) && held.contains(&precision_number)) {
		let written = arguments.get(*taken).map(|argument| argument.to_string_lossy());
		report.say(format_args!(
			"warning: {}: Numerical result out of range",
			written.unwrap_or_default()
		));
	}
	let width_number = width_number.clamp(i64::from(i32::MIN), i64::from(i32::MAX));
	let precision_number = precision_number.clamp(i64::from(i32::MIN), i64::from(i32::MAX));
	// A negative width is a left-justified one, as in C; a negative precision
	// is none at all.
	let left = flags.contains('-') || width_number < 0;
	let width = width.map(|_| width_number.unsigned_abs() as usize);
	let precision = precision.and_then(|_| usize::try_from(precision_number).ok());
	let float = matches!(conversion, b'e' | b'E' | b'f' | b'F' | b'g' | b'G' | b'a' | b'A');
	let wide_width = width.is_some_and(|width| width > FORMATTER_LIMIT);
	let wide_precision = precision
		.is_some_and(|precision| precision > if float { FLOAT_DIGITS } else { FORMATTER_LIMIT });
	let ignored_precision = precision.is_some() && conversion == b'c';
	// The directive as uucore may write it: the flags, with `-` for a
	// negative width, and each number unless it is too large.
	let mut reduced = String::from("%");
	reduced.push_str(flags);
	if left && !flags.contains('-') {
		reduced.push('-');
	}
	match width {
		Some(width) if !wide_width => reduced.push_str(&width.to_string()),
		_ => {},
	}
	match precision {
		Some(_) if ignored_precision => {},
		Some(_) if wide_precision => reduced.push_str(".2000"),
		Some(precision) => {
			reduced.push('.');
			reduced.push_str(&precision.to_string());
		},
		None => {},
	}
	reduced.push(char::from(conversion));
	let argument = arguments.get(*taken);
	*taken += usize::from(argument.is_some());
	if !(wide_width || wide_precision || ignored_precision) {
		return write_uucore(&reduced, argument.map(std::slice::from_ref).unwrap_or_default(), writer);
	}
	write_wide(
		&reduced,
		wide_width.then(|| width.unwrap_or(0)),
		left,
		flags.contains('0'),
		wide_precision.then(|| precision.unwrap_or(0)),
		conversion,
		argument,
		writer,
	)
}

/// Writes `format_string`, whose directives are not all uucore's to write,
/// one piece at a time, taking the arguments each takes and starting again
/// while any are left, as Bash does.
fn format_wide(
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
				Piece::Literal(text) => {
					write_uucore(text, &[], writer)?;
				},
				Piece::Plain(spelled) => {
					let next = (taken + 1).min(arguments.len());
					let used = arguments.get(taken..next).unwrap_or_default();
					write_uucore(spelled, used, writer)?;
					taken = next;
				},
				Piece::Wide { reduced, width, left, zeroes, precision, conversion } => {
					let argument = arguments.get(taken);
					taken += usize::from(argument.is_some());
					write_wide(
						reduced,
						*width,
						*left,
						*zeroes,
						*precision,
						*conversion,
						argument,
						writer,
					)?;
				},
				Piece::Star { flags, width, precision, conversion } => {
					write_star(
						flags,
						*width,
						*precision,
						*conversion,
						arguments,
						&mut taken,
						writer,
						report,
					)?;
				},
				Piece::Nothing => {
					taken = (taken + 1).min(arguments.len());
				},
			}
		}
		if taken >= arguments.len() || taken == before {
			return Ok(());
		}
	}
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
/// copy of it for every writer they pass on (see [`format_wide`]).
///
/// A directive whose width or precision is larger than the formatter takes is
/// written here, not by uucore, which would end the process.
fn write_with_uucore(
	format_string: &str,
	arguments: &[OsString],
	writer: &mut dyn Write,
	report: &mut Report<impl Write>,
) -> Result<(), brush_core::Error> {
	match scan_wide_directives(format_string) {
		Some(pieces) => format_wide(&pieces, arguments, writer, report),
		None => write_uucore(format_string, arguments, writer),
	}
}

/// The number `written` holds, as Bash reads a width, a precision or a `%d`
/// argument: a decimal, a hexadecimal after `0x`, or an octal after `0`, with
/// a sign and nothing else around it.
fn read_number(written: &str) -> Option<i64> {
	if written.is_empty() {
		return Some(0);
	}
	let (negative, digits) = match written.strip_prefix('-') {
		Some(digits) => (true, digits),
		None => (false, written.strip_prefix('+').unwrap_or(written)),
	};
	let number = if let Some(hexadecimal) = digits.strip_prefix("0x").or(digits.strip_prefix("0X"))
	{
		i64::from_str_radix(hexadecimal, 16)
	} else if digits.len() > 1 && digits.starts_with('0') {
		i64::from_str_radix(&digits[1..], 8)
	} else {
		digits.parse()
	}
	.ok()?;
	Some(if negative { -number } else { number })
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

		if format_args.is_empty() {
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
