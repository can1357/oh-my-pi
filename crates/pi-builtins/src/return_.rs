use std::io::Write;

use brush_core::{ExecutionControlFlow, ExecutionExitCode, ExecutionResult, builtins};
use clap::Parser;

/// Return from the current function.
#[derive(Parser)]
pub(crate) struct ReturnCommand {
	/// The exit code to return.
	code: Option<i32>,
}

impl builtins::Command for ReturnCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		// With no operand Bash returns `$?` as it is, 256 included
		// (`return_catch_value = last_command_exit_value`).
		#[expect(clippy::cast_sign_loss)]
		let code = if let Some(code_32bit) = &self.code {
			ExecutionExitCode::from((code_32bit & 0xff) as u8)
		} else {
			ExecutionExitCode::from(context.shell.last_exit_status())
		};

		if context.shell.in_function() || context.shell.in_sourced_script() {
			let mut result = ExecutionResult::from(code);
			result.next_control_flow = ExecutionControlFlow::ReturnFromFunctionOrScript;

			Ok(result)
		} else {
			let _ =
				writeln!(context.stderr(), "return: can only be used in a function or sourced script");
			Ok(ExecutionExitCode::InvalidUsage.into())
		}
	}
}
