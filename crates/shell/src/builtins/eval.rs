use clap::Parser;

use crate::{Error, ExecutionContext, ExecutionResult, ShellExtensions, builtins};

/// Evaluate the given string as script.
#[derive(Parser)]
pub(crate) struct EvalCommand {
	/// The script to evaluate.
	#[clap(allow_hyphen_values = true)]
	args: Vec<String>,
}

impl builtins::Command for EvalCommand {
	type Error = Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		if !self.args.is_empty() {
			let args_concatenated = self.args.join(" ");

			// Our new source context is relative to the current position because we are
			// only providing the raw string being eval'd.
			// TODO(source-info): Provide the location of the specific tokens that make up
			// `self.args`.
			let source_info = context.shell.call_stack().current_pos_as_source_info();

			// Return the direct result of running the string; we intentionally
			// pass through the result and honor its requested control flow. eval
			// executes in the current environment, so all control flow (return,
			// exit, break, continue) should propagate.
			context
				.shell
				.run_string(args_concatenated, &source_info, &context.params)
				.await
		} else {
			Ok(ExecutionResult::success())
		}
	}
}
