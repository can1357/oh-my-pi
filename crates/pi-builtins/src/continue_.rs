use brush_core::{ExecutionControlFlow, ExecutionExitCode, ExecutionResult, builtins};
use clap::Parser;

/// Continue to the next iteration of a control-flow loop.
#[derive(Parser)]
pub(crate) struct ContinueCommand {
	/// If specified, indicates which nested loop to continue to the next
	/// iteration of.
	#[clap(default_value_t = 1)]
	which_loop: i8,
}

impl builtins::Command for ContinueCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		_context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		// If specified, which_loop needs to be positive.
		if self.which_loop <= 0 {
			return Ok(ExecutionExitCode::InvalidUsage.into());
		}

		let mut result = ExecutionResult::success();

		result.next_control_flow = ExecutionControlFlow::ContinueLoop {
			#[expect(clippy::cast_sign_loss)]
			levels:                                   (self.which_loop - 1) as usize,
		};

		Ok(result)
	}
}
