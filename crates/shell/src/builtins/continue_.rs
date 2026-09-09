use clap::Parser;

use crate::{
	Error, ExecutionContext, ExecutionControlFlow, ExecutionExitCode, ExecutionResult,
	ShellExtensions, builtins,
};

/// Continue to the next iteration of a control-flow loop.
#[derive(Parser)]
pub(crate) struct ContinueCommand {
	/// If specified, indicates which nested loop to continue to the next
	/// iteration of.
	#[clap(default_value_t = 1)]
	which_loop: i8,
}

impl builtins::Command for ContinueCommand {
	type Error = Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		_context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		// If specified, which_loop needs to be positive.
		if self.which_loop <= 0 {
			return Ok(ExecutionExitCode::InvalidUsage.into());
		}

		let mut result = ExecutionResult::success();

		result.next_control_flow = ExecutionControlFlow::ContinueLoop {
			#[expect(clippy::cast_sign_loss, reason = "positive loop count is validated above")]
			levels: (self.which_loop - 1) as usize,
		};

		Ok(result)
	}
}
