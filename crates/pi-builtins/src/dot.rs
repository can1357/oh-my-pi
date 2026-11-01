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
		//
		// `source` copies its operands into the script's positional
		// parameters, and `. f "${big[@]}"` lets the caller size each one:
		// the copy used to happen inside the call, as `Into<String>` on a
		// borrowed operand, in one uninterrupted step. Copying here in
		// strides leaves that conversion a move.
		let mut script_args = Vec::with_capacity(self.script_args.len());
		for arg in &self.script_args {
			script_args.push(brush_core::clone_in_strides(&context.params, arg).await?);
		}

		context
			.shell
			.source_script(Path::new(&self.script_path), script_args.into_iter(), &context.params)
			.await
	}
}
