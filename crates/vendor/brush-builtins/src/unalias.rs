use std::io::Write;

use brush_core::{ExecutionResult, builtins};
use clap::Parser;

/// Unset a shell alias.
#[derive(Parser)]
pub(crate) struct UnaliasCommand {
	/// Remove all aliases.
	#[arg(short = 'a')]
	remove_all: bool,

	/// Names of aliases to operate on.
	aliases: Vec<String>,
}

impl builtins::Command for UnaliasCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		let mut exit_code = ExecutionResult::success();

		if self.remove_all {
			context.shell.aliases_mut().clear();
		} else {
			for alias in &self.aliases {
				if context.shell.aliases_mut().remove(alias).is_none() {
					writeln!(context.stderr(), "{}: {}: not found", context.command_name, alias)?;
					exit_code = ExecutionResult::general_error();
				}
			}
		}

		Ok(exit_code)
	}
}
