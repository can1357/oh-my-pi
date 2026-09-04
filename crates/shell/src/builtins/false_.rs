use crate::{Error, ExecutionContext, ExecutionResult, ShellExtensions, builtins};

/// Return exit code 1.
pub(crate) struct FalseCommand {}

impl builtins::SimpleCommand for FalseCommand {
	fn get_content(
		_name: &str,
		content_type: builtins::ContentType,
		_options: &builtins::ContentOptions,
	) -> Result<String, Error> {
		match content_type {
			builtins::ContentType::DetailedHelp => Ok("Returns a failure exit status.".into()),
			builtins::ContentType::ShortUsage => Ok("false".into()),
			builtins::ContentType::ShortDescription => Ok("false - fail".into()),
			builtins::ContentType::ManPage => {
				Ok("NAME\n    false - Return an unsuccessful result.\n\nSYNOPSIS\n    \
				    false\n\nDESCRIPTION\n    Return an unsuccessful result.\n\n    Exit Status:\n    \
				    Always fails.\n\nSEE ALSO\n    bash(1)\n"
					.into())
			},
		}
	}

	fn execute<SE: ShellExtensions, I: Iterator<Item = S>, S: AsRef<str>>(
		_context: ExecutionContext<'_, SE>,
		_args: I,
	) -> Result<ExecutionResult, Error> {
		Ok(ExecutionResult::general_error())
	}
}
