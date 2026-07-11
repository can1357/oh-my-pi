use std::path::Path;

use brush_core::builtins;
use clap::Parser;

/// Evaluate the provided script in the current shell environment.
#[derive(Parser)]
pub(crate) struct DotCommand {
	/// Path to the script to evaluate.
	script_path: String,

	/// Any arguments to be passed as positional parameters to the script.
	#[arg(trailing_var_arg = true, allow_hyphen_values = true)]
	script_args: Vec<String>,
}

impl builtins::Command for DotCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		// TODO(dot): Handle trap inheritance.
		context
			.shell
			.source_script(Path::new(&self.script_path), self.script_args.iter(), &context.params)
			.await
	}
}
