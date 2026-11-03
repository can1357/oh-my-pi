use std::io::Write;

use brush_core::{ExecutionResult, builtins};
use clap::Parser;

/// Push a path onto the current directory stack.
#[derive(Parser)]
pub(crate) struct PushdCommand {
	/// Push the path without changing the current working directory.
	#[clap(short = 'n')]
	no_directory_change: bool,

	/// Directory to push on the directory stack.
	dir: String,
	//
	// TODO(pushd): implement +N and -N
}

impl builtins::Command for PushdCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		mut context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		if self.no_directory_change {
			context
				.shell
				.directory_stack_mut()
				.push(std::path::PathBuf::from(&self.dir));
		} else {
			let prev_working_dir = context.shell.working_dir().to_path_buf();

			let dir = std::path::Path::new(&self.dir);
			// `set -P` resolves symbolic links here too, as Bash's `pushd` changes
			// directory as its `cd` does.
			let physical = context.shell.options().do_not_resolve_symlinks_when_changing_dir;
			let entered = crate::cd::enter_directory(&mut context, dir, physical).await;
			let readonly: Vec<&str> =
				entered.as_ref().map(crate::cd::Entered::readonly).unwrap_or_default().to_vec();
			for name in &readonly {
				writeln!(context.stderr(), "{name}: readonly variable")?;
			}
			if let Err(reason) = entered {
				writeln!(context.stderr(), "pushd: {}: {reason}", self.dir)?;
				return Ok(ExecutionResult::general_error());
			}
			// A name that may not be written leaves the stack as it was and
			// the command failed, though the directory is entered, as in
			// Bash.
			if !readonly.is_empty() {
				return Ok(ExecutionResult::general_error());
			}

			context.shell.directory_stack_mut().push(prev_working_dir);
		}

		// Display dirs.
		let dirs_cmd = crate::dirs::DirsCommand::default();
		dirs_cmd.execute(context).await?;

		Ok(ExecutionResult::success())
	}
}
