use brush_core::builtins;
use clap::Parser;

/// Evaluate the given string as script.
#[derive(Parser)]
pub(crate) struct EvalCommand {
	/// The script to evaluate.
	#[clap(allow_hyphen_values = true)]
	args: Vec<String>,
}

impl builtins::Command for EvalCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		// Even with no arguments, `eval` is refused at the nesting limit, as in
		// Bash, which checks the limit before it runs the builtin
		// (`execute_builtin` in execute_cmd.c).
		let args_concatenated = self.args.join(" ");

		tracing::debug!("Applying eval to: {:?}", args_concatenated);

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
			.eval_string(args_concatenated, &source_info, &context.params)
			.await
	}
}
