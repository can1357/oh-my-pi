use std::io::Write;

use clap::Parser;

use super::printf_engine;
use crate::{
	Error, ErrorKind, ExecutionContext, ExecutionResult, ShellExtensions, builtins, escape,
	expansion,
};

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
	type Error = Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		if let Some(variable_name) = &self.output_variable {
			// Format to a u8 vector.
			let mut result: Vec<u8> = vec![];
			format(self.format_and_args.as_slice(), &mut result)?;

			// Convert to a string.
			let result_str = String::from_utf8(result)
				.map_err(|_| ErrorKind::PrintfInvalidUsage("invalid UTF-8 output".into()))?;

			// Assign to the selected variable.
			expansion::assign_to_named_parameter(
				context.shell,
				&context.params,
				variable_name,
				result_str,
			)
			.await?;
		} else {
			format(self.format_and_args.as_slice(), context.stdout())?;
			context.stdout().flush()?;
		}

		Ok(ExecutionResult::success())
	}
}

fn format(format_and_args: &[String], writer: impl Write) -> Result<(), Error> {
	match format_and_args {
		// Special-case invocation of printf with %q-based format string from bash-completion.
		// It has hard-coded expectation of backslash-style escaping instead of quoting.
		[fmt, arg] if fmt == "%q" => format_special_case_for_percent_q(None, arg, writer),
		[fmt, arg] if fmt == "~%q" => format_special_case_for_percent_q(Some("~"), arg, writer),
		// Handle a format string with arguments using the first-party engine.
		[fmt, args @ ..] => printf_engine::format(fmt, args, writer).map_err(|error| match error {
			printf_engine::PrintfError::Io(error) => error.into(),
			error => ErrorKind::PrintfInvalidUsage(format!("printf formatting error: {error}")).into(),
		}),
		// Handle case with no format string (we shouldn't be able to get here since clap will
		// fail parsing when the format string is missing)
		[] => Err(ErrorKind::PrintfInvalidUsage("missing operand".into()).into()),
	}
}

fn format_special_case_for_percent_q(
	prefix: Option<&str>,
	arg: &str,
	mut writer: impl Write,
) -> Result<(), Error> {
	let mut result = escape::quote_if_needed(arg, escape::QuoteMode::BackslashEscape).to_string();

	if let Some(prefix) = prefix {
		result.insert_str(0, prefix);
	}

	write!(writer, "{result}")?;

	Ok(())
}

#[cfg(test)]
#[expect(
	clippy::panic_in_result_fn,
	reason = "test fixtures deliberately unwrap invalid format cases"
)]
mod tests {
	use super::*;
	use crate::TestResult as Result;

	fn sprintf(format_string: &str, args: &[&str]) -> Result<String> {
		let args = args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
		let mut result = vec![];
		printf_engine::format(format_string, &args, &mut result)?;

		Ok(String::from_utf8(result)?)
	}

	#[test]
	fn test_basic_sprintf() -> Result<()> {
		assert_eq!(sprintf("%s", &["xyz"])?, "xyz");
		assert_eq!(sprintf(r"%d\n", &["1"])?, "1\n");

		Ok(())
	}

	#[test]
	fn test_sprintf_without_args() -> Result<()> {
		assert_eq!(sprintf("xyz", &[])?, "xyz");
		assert_eq!(sprintf("%s|", &[])?, "|");

		Ok(())
	}

	#[test]
	fn test_sprintf_with_cycles() -> Result<()> {
		assert_eq!(sprintf("%s|", &["x", "y"])?, "x|y|");

		Ok(())
	}
}
