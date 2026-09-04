use std::path::Path;

use clap::Parser;

use crate::{Error, ExecutionContext, ExecutionResult, ShellExtensions, builtins};

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
	type Error = Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		// TODO(dot): Handle trap inheritance.
		context
			.shell
			.source_script(Path::new(&self.script_path), self.script_args.iter(), &context.params)
			.await
	}
}
