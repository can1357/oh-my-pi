use brush_core::{ExecutionControlFlow, ExecutionResult, builtins};
use clap::Parser;

/// Exit the shell.
#[derive(Parser)]
pub(crate) struct ExitCommand {
	/// The exit code to return.
	#[arg(allow_hyphen_values = true)]
	code: Option<i64>,
}

impl builtins::Command for ExitCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		#[expect(clippy::cast_sign_loss)]
		let code_8bit = if let Some(code_32bit) = &self.code {
			(code_32bit & 0xff) as u8
		} else {
			context.shell.last_exit_status()
		};

		let mut result = ExecutionResult::new(code_8bit);
		result.next_control_flow = ExecutionControlFlow::ExitShell;

		Ok(result)
	}
}
