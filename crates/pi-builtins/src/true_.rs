use brush_core::{ExecutionResult, builtins};

/// No-op command. Same with :.
pub(crate) struct TrueCommand {}

const MAN_PAGE: &str = "\
TRUE(1)

NAME
    true - return a successful result

SYNOPSIS
    true

DESCRIPTION
    The true utility returns a successful exit status.
";

impl builtins::SimpleCommand for TrueCommand {
	fn get_content(
		_name: &str,
		content_type: builtins::ContentType,
		_options: &builtins::ContentOptions,
	) -> Result<String, brush_core::Error> {
		match content_type {
			builtins::ContentType::DetailedHelp => Ok("Returns a successful exit status.".into()),
			builtins::ContentType::ShortUsage => Ok("true".into()),
			builtins::ContentType::ShortDescription => Ok("true - success".into()),
			builtins::ContentType::ManPage => Ok(MAN_PAGE.into()),
		}
	}

	fn execute<SE: brush_core::ShellExtensions, I: Iterator<Item = S>, S: AsRef<str>>(
		_context: brush_core::ExecutionContext<'_, SE>,
		_args: I,
	) -> Result<ExecutionResult, brush_core::Error> {
		Ok(ExecutionResult::success())
	}
}
