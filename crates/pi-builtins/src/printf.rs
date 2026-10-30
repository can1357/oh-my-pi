use std::{ffi::OsString, io::Write, ops::ControlFlow};

use brush_core::{
	Error, ErrorKind, ExecutionParameters, ExecutionResult, builtins, escape, expansion,
};
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
		if let Some(variable_name) = &self.output_variable {
			// Format to a u8 vector.
			let mut result: Vec<u8> = vec![];
			format(&context.params, self.format_and_args.as_slice(), &mut result).await?;

			// Convert to a string, a stride at a time: `String::from_utf8` of
			// the whole buffer is one scan nothing can interrupt, and the
			// buffer is as large as what the caller expanded.
			let result_str = utf8_in_strides(&context.params, &result).await?;

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
			let formatted =
				format(&context.params, self.format_and_args.as_slice(), &mut stdout).await;
			stdout.flush()?;
			formatted?;
		}

		Ok(ExecutionResult::success())
	}
}

async fn format(
	params: &ExecutionParameters,
	format_and_args: &[String],
	writer: impl Write,
) -> Result<(), brush_core::Error> {
	match format_and_args {
		// Special-case invocation of printf with %q-based format string from bash-completion.
		// It has hard-coded expectation of backslash-style escaping instead of quoting.
		[fmt, arg] if fmt == "%q" => {
			format_special_case_for_percent_q(params, None, arg, writer).await
		},
		[fmt, arg] if fmt == "~%q" => {
			format_special_case_for_percent_q(params, Some("~"), arg, writer).await
		},
		// Handle format string with arguments using uucore
		[fmt, args @ ..] => format_via_uucore(params, fmt, args, writer).await,
		// Handle case with no format string (we shouldn't be able to get here since clap will
		// fail parsing when the format string is missing)
		[] => Err(ErrorKind::PrintfInvalidUsage("missing operand".into()).into()),
	}
}

async fn format_special_case_for_percent_q(
	params: &ExecutionParameters,
	prefix: Option<&str>,
	arg: &str,
	mut writer: impl Write,
) -> Result<(), brush_core::Error> {
	// `printf %q "$big"` lets the caller size what is escaped, so the escape
	// runs in strides and the result is written straight from the borrowed
	// `Cow`: the `to_string` that used to stand here copied the whole
	// argument, and the `insert_str` that put the prefix on moved all of it
	// again.
	let quoted =
		escape::quote_if_needed_divided(params, arg, escape::QuoteMode::BackslashEscape).await?;

	if let Some(prefix) = prefix {
		write!(writer, "{prefix}")?;
	}

	writer.write_all(quoted.as_ref().as_bytes())?;

	Ok(())
}

async fn format_via_uucore(
	params: &ExecutionParameters,
	format_string: &str,
	args: &[String],
	mut writer: impl Write,
) -> Result<(), brush_core::Error> {
	// Convert string arguments to FormatArgument::Unparsed. Each conversion
	// copies the argument, and `printf -v out %s "$big"` makes that copy the
	// size of the expansion: 64 MiB of it held the worker here before the
	// formatter was even reached. Copying in strides divides it, and the
	// checkpoint `clone_in_strides` spends per argument also divides a loop
	// over a million short ones.
	let mut format_args = Vec::with_capacity(args.len());
	for arg in args {
		format_args.push(format::FormatArgument::Unparsed(OsString::from(
			brush_core::clone_in_strides(params, arg).await?,
		)));
	}

	// Parse format string once.
	let format_items = parse_format_string(format_string)?;

	// Wrap the format arguments.
	let mut format_args_wrapper = format::FormatArguments::new(&format_args);

	// Keep going until we've exhausted all format arguments. Also make sure to run
	// at least once even if there's no format arguments.
	//
	// The loop runs the whole format once per batch of arguments, so
	// `printf -v v '%s\n' "${million[@]}"` runs it a million times. Charge it
	// by steps: what a single item writes is uucore's own copy, which no
	// checkpoint of ours can enter, so there are no bytes of ours to charge.
	let mut budget = brush_core::ElementBudget::new();
	while format_args.is_empty() || !format_args_wrapper.is_exhausted() {
		// Process all format items, in order. We'll bail when we're told to stop.
		for item in &format_items {
			let due = budget.charge(0);
			if due > 0 {
				brush_core::loop_checkpoints(params, due).await?;
			}

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

/// Validates `bytes` as UTF-8 and copies them into a `String`, a stride at a
/// time.
///
/// `String::from_utf8` of the whole buffer is one scan nothing can interrupt,
/// and `printf -v out %s "$big"` makes the buffer the size of the expansion:
/// for 64 MiB it was a 64 MiB validation followed by the assignment's own
/// work. Splitting the buffer at character boundaries validates and copies
/// the same bytes in pieces of [`brush_core::DIVIDE_COPY_ABOVE_BYTES`], with
/// a checkpoint before each.
///
/// # Errors
///
/// Returns [`brush_core::ErrorKind::PrintfInvalidUsage`] if the formatted
/// output is not UTF-8, and [`brush_core::ErrorKind::Interrupted`] if the run
/// is cancelled part way.
async fn utf8_in_strides(
	params: &ExecutionParameters,
	bytes: &[u8],
) -> Result<String, brush_core::Error> {
	let mut out = String::with_capacity(bytes.len());
	let mut rest = bytes;
	while !rest.is_empty() {
		let mut end = rest.len().min(brush_core::DIVIDE_COPY_ABOVE_BYTES);
		if end < rest.len() {
			// A stride lands mid-character at most three bytes in; step back
			// off the continuation bytes so each piece validates on its own.
			while end > 0 && rest[end] & 0xC0 == 0x80 {
				end -= 1;
			}
			if end == 0 {
				return Err(invalid_utf8_output());
			}
		}
		let piece = std::str::from_utf8(&rest[..end]).map_err(|_| invalid_utf8_output())?;
		brush_core::push_str_in_strides(params, &mut out, piece).await?;
		rest = &rest[end..];
	}

	Ok(out)
}

fn invalid_utf8_output() -> brush_core::Error {
	ErrorKind::PrintfInvalidUsage("invalid UTF-8 output".into()).into()
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

	async fn sprintf_via_uucore(format_string: &str, args: &[&str]) -> Result<String> {
		let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
		let params = ExecutionParameters::default();
		let mut result = vec![];
		format_via_uucore(&params, format_string, &args, &mut result).await?;

		Ok(String::from_utf8(result)?)
	}

	#[tokio::test]
	async fn test_basic_sprintf() -> Result<()> {
		assert_eq!(sprintf_via_uucore("%s", &["xyz"]).await?, "xyz");
		assert_eq!(sprintf_via_uucore(r"%d\n", &["1"]).await?, "1\n");

		Ok(())
	}

	#[tokio::test]
	async fn test_sprintf_without_args() -> Result<()> {
		assert_eq!(sprintf_via_uucore("xyz", &[]).await?, "xyz");
		assert_eq!(sprintf_via_uucore("%s|", &[]).await?, "|");

		Ok(())
	}

	#[tokio::test]
	async fn test_sprintf_with_cycles() -> Result<()> {
		assert_eq!(sprintf_via_uucore("%s|", &["x", "y"]).await?, "x|y|");

		Ok(())
	}

	/// A value the caller sized is validated and copied in pieces, and the
	/// result is byte-for-byte what `String::from_utf8` produced before,
	/// including a multi-byte character that straddles a stride boundary.
	#[tokio::test]
	async fn utf8_in_strides_matches_from_utf8_across_boundaries() -> Result<()> {
		let params = ExecutionParameters::default();
		for pad in [brush_core::DIVIDE_COPY_ABOVE_BYTES - 1, brush_core::DIVIDE_COPY_ABOVE_BYTES] {
			let mut text = "a".repeat(pad);
			text.push('é');
			text.push_str(&"b".repeat(brush_core::DIVIDE_COPY_ABOVE_BYTES + 7));
			assert_eq!(utf8_in_strides(&params, text.as_bytes()).await?, text);
		}
		assert_eq!(utf8_in_strides(&params, b"").await?, "");
		assert!(utf8_in_strides(&params, b"\xff").await.is_err());

		Ok(())
	}
}
