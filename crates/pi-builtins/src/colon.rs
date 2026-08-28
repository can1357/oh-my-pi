use brush_core::{ExecutionResult, builtins};

/// No-op command.
pub(crate) struct ColonCommand {}

impl builtins::SimpleCommand for ColonCommand {
	fn get_content(
		_name: &str,
		content_type: builtins::ContentType,
		_options: &builtins::ContentOptions,
	) -> Result<String, brush_core::Error> {
		match content_type {
			builtins::ContentType::DetailedHelp => Ok("Null command; always returns success.".into()),
			builtins::ContentType::ShortUsage => Ok(":: :".into()),
			builtins::ContentType::ShortDescription => Ok(": - Null command".into()),
			builtins::ContentType::ManPage => Ok(
				"NAME\n    : - Null command.\n\nSYNOPSIS\n    :\n\nDESCRIPTION\n    Null command.\n\n    No effect; the command does nothing.\n\n    Exit Status:\n    Always succeeds.\n"
					.into(),
			),
		}
	}

	fn execute<SE: brush_core::ShellExtensions, I: Iterator<Item = S>, S: AsRef<str>>(
		_context: brush_core::ExecutionContext<'_, SE>,
		_args: I,
	) -> Result<ExecutionResult, brush_core::Error> {
		Ok(ExecutionResult::success())
	}
}
