use std::io::Write;

use brush_core::{ExecutionResult, builtins};
use clap::Parser;

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
	type Error = crate::dirs::DirError;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		mut context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		let Some(top) = context.shell.directory_stack().last().cloned() else {
			writeln!(context.stderr(), "popd: directory stack empty").map_err(brush_core::Error::from)?;
			return Ok(ExecutionResult::general_error());
		};
		// The entry stays on the stack when its directory cannot be entered, as
		// in Bash; `set -P` resolves symbolic links here, as `cd` does.
		let physical = context.shell.options().do_not_resolve_symlinks_when_changing_dir;
		if !self.no_directory_change
			&& let Err(reason) = {
				let entered = crate::cd::enter_directory(&mut context, &top, physical).await;
				for name in entered.as_ref().map(crate::cd::Entered::readonly).unwrap_or_default() {
					let _ = writeln!(context.stderr(), "{name}: readonly variable");
				}
				entered.map(|_| ())
			}
		{
			writeln!(context.stderr(), "popd: {}: {reason}", top.display())
				.map_err(brush_core::Error::from)?;
			return Ok(ExecutionResult::general_error());
		}
		context.shell.directory_stack_mut().pop();

		// Display dirs.
		let dirs_cmd = crate::dirs::DirsCommand::default();
		dirs_cmd.execute(context).await?;

		Ok(ExecutionResult::success())
	}
}
