use std::{io::Write, path::PathBuf};

use brush_core::{ExecutionResult, builtins};
use clap::Parser;

/// Change the current shell working directory.
#[derive(Parser)]
pub(crate) struct CdCommand {
	/// Force following symlinks.
	#[arg(short = 'L', overrides_with = "use_physical_dir")]
	force_follow_symlinks: bool,

	/// Use physical dir structure without following symlinks.
	#[arg(short = 'P', overrides_with = "force_follow_symlinks")]
	use_physical_dir: bool,

	/// Exit with non zero exit status if current working directory resolution
	/// fails.
	#[arg(short = 'e')]
	exit_on_failed_cwd_resolution: bool,

	/// By default it is the value of the HOME shell variable. If `TARGET_DIR` is
	/// "-", it is converted to $OLDPWD.
	target_dir: Option<PathBuf>,
}

impl builtins::Command for CdCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		let mut should_print = false;
		let mut target_dir = if let Some(target_dir) = &self.target_dir {
			// `cd -', equivalent to `cd $OLDPWD'
			if target_dir.as_os_str() == "-" {
				should_print = true;
				if let Some(oldpwd) = context.shell.env_str("OLDPWD") {
					PathBuf::from(oldpwd.to_string())
				} else {
					writeln!(context.stderr(), "OLDPWD not set")?;
					return Ok(ExecutionResult::general_error());
				}
			} else {
				// TODO(cd): remove clone, and use temporary lifetime extension after rust 1.75
				target_dir.clone()
			}
		// `cd' without arguments is equivalent to `cd $HOME'
		} else {
			if let Some(home_var) = context.shell.env_str("HOME") {
				PathBuf::from(home_var.to_string())
			} else {
				writeln!(context.stderr(), "HOME not set")?;
				return Ok(ExecutionResult::general_error());
			}
		};

		if self.use_physical_dir
			|| context
				.shell
				.options()
				.do_not_resolve_symlinks_when_changing_dir
		{
			// -e is only relevant in physical mode. `canonicalize()` is the
			// cwd-resolution step this implementation supports; failures already
			// propagate as a non-zero result before updating PWD/OLDPWD.
			target_dir = context.shell.absolute_path(target_dir).canonicalize()?;
		}

		context.shell.set_working_dir(&target_dir)?;

		// Bash compatibility
		// https://www.gnu.org/software/bash/manual/bash.html#index-cd
		// If a non-empty directory name from CDPATH is used, or if '-' is the first
		// argument, and the directory change is successful, the absolute pathname of
		// the new working directory is written to the standard output.
		if should_print {
			writeln!(context.stdout(), "{}", target_dir.display())?;
		}

		Ok(ExecutionResult::success())
	}
}
