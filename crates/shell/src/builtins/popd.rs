use clap::Parser;

use crate::{
	ExecutionContext, ExecutionResult, ShellExtensions, builtins,
	builtins::dirs::{DirError, DirsCommand},
};

/// Pop a path from the current directory stack.
#[derive(Parser)]
pub(crate) struct PopdCommand {
	/// Pop the path without changing the current working directory.
	#[clap(short = 'n')]
	no_directory_change: bool,
	//
	// TODO(popd): implement +N and -N
}

impl builtins::Command for PopdCommand {
	type Error = DirError;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		if let Some(popped) = context.shell.directory_stack_mut().pop() {
			if !self.no_directory_change {
				context.shell.set_working_dir(&popped)?;
			}

			// Display dirs.
			let dirs_cmd = DirsCommand::default();
			dirs_cmd.execute(context).await?;

			Ok(ExecutionResult::success())
		} else {
			Err(DirError::DirStackEmpty)
		}
	}
}
