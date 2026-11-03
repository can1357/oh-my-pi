use std::{ffi::OsString, io::Write, ops::ControlFlow};

use brush_core::{Error, ErrorKind, ExecutionResult, builtins, escape, expansion};
use clap::Parser;
use uucore::format::{self, FormatChar as _};

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
		if let Some(variable_name) = &self.output_variable {
			// Format to a u8 vector.
			let mut result: Vec<u8> = vec![];
			format(self.format_and_args.as_slice(), &mut result)?;

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
			let formatted = format(self.format_and_args.as_slice(), &mut stdout);
			stdout.flush()?;
			formatted?;
		}

		Ok(ExecutionResult::success())
	}
}

fn format(format_and_args: &[String], writer: impl Write) -> Result<(), brush_core::Error> {
	match format_and_args {
		[fmt, args @ ..] => format_via_uucore(fmt, args.iter(), writer),
		// Handle case with no format string (we shouldn't be able to get here since clap will
		// fail parsing when the format string is missing)
		[] => Err(ErrorKind::PrintfInvalidUsage("missing operand".into()).into()),
	}
}

fn format_via_uucore(
	format_string: &str,
	args: impl Iterator<Item = impl Into<OsString>>,
	mut writer: impl Write,
) -> Result<(), brush_core::Error> {
	// Convert string arguments to FormatArgument::Unparsed
	let format_args: Vec<_> = args
		.map(|s| format::FormatArgument::Unparsed(s.into()))
		.collect();

	// Parse format string once.
	let format_items = parse_format_string(format_string)?;

	// Wrap the format arguments.
	let mut format_args_wrapper = format::FormatArguments::new(&format_args);

	// As in Bash, the format is written once, then again while arguments remain;
	// a format that uses no argument (no conversion) is written once.
	let uses_arguments = format_items
		.iter()
		.any(|item| matches!(item, format::FormatItem::Spec(_)));
	loop {
		for item in &format_items {
			match item {
				// Bash quotes `%q` with backslashes (`a\ b`), not with single quotes.
				format::FormatItem::Spec(format::Spec::QuotedString { position }) => {
					let arg = format_args_wrapper.next_string(*position).to_string_lossy();
					let quoted = escape::quote_if_needed(&arg, escape::QuoteMode::BackslashEscape);
					writer.write_all(quoted.as_bytes())?;
				},
				// `\c` in a `%b` argument ends all output, as in Bash; uucore would
				// end only the argument.
				format::FormatItem::Spec(format::Spec::EscapedString { position }) => {
					let arg = format_args_wrapper.next_string(*position);
					for c in format::parse_escape_only(
						arg.as_encoded_bytes(),
						format::OctalParsing::ThreeDigits,
					) {
						if c.write(&mut writer)? == ControlFlow::Break(()) {
							return Ok(());
						}
					}
				},
				// Nothing else ends output: the format's own `\c` is literal (see
				// `parse_format_string`).
				item => {
					let _: ControlFlow<()> = item
						.write(&mut writer, &mut format_args_wrapper)
						.map_err(|e| match e {
							// Propagate I/O errors directly so they can be handled appropriately
							format::FormatError::IoError(io_err) => Error::from(io_err),
							// Wrap other format errors
							other => Error::from(ErrorKind::PrintfInvalidUsage(std::format!(
								"printf formatting error: {other}"
							))),
						})?;
				},
			}
		}

		if !uses_arguments {
			break;
		}
		format_args_wrapper.start_next_batch();
		if format_args_wrapper.is_exhausted() {
			break;
		}
	}

	Ok(())
}

fn parse_format_string(
	format_string: &str,
) -> Result<Vec<format::FormatItem<format::EscapedChar>>, brush_core::Error> {
	let format_items: Result<Vec<_>, _> = format::parse_spec_and_escape(format_string.as_bytes())
		.map(|item| match item {
			// Bash ends output at `\c` only in a `%b` argument; in the format it
			// is the two characters as written.
			Ok(format::FormatItem::Char(format::EscapedChar::End)) => {
				Ok(format::FormatItem::Char(format::EscapedChar::Backslash(b'c')))
			},
			item => item,
		})
		.collect();

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
		format_via_uucore(format_string, args, &mut result)?;

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
}
