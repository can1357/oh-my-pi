use std::io::Write;

use clap::Parser;

use crate::{
	Error, ExecutionContext, ExecutionControlFlow, ExecutionExitCode, ExecutionResult,
	ShellExtensions, builtins,
};

/// Return from the current function.
#[derive(Parser)]
pub(crate) struct ReturnCommand {
	/// The exit code to return.
	code: Option<i32>,
}

impl builtins::Command for ReturnCommand {
	type Error = Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		#[expect(clippy::cast_sign_loss, reason = "shell exit status is defined modulo 256")]
		let code_8bit = if let Some(code_32bit) = &self.code {
			(code_32bit & 0xff) as u8
		} else {
			context.shell.last_exit_status()
		};

		if context.shell.in_function() || context.shell.in_sourced_script() {
			let mut result = ExecutionResult::new(code_8bit);
			result.next_control_flow = ExecutionControlFlow::ReturnFromFunctionOrScript;

			Ok(result)
		} else {
			let _ =
				writeln!(context.stderr(), "return: can only be used in a function or sourced script");
			Ok(ExecutionExitCode::InvalidUsage.into())
		}
	}
}
