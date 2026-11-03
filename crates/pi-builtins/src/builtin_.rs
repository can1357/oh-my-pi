use std::io::Write;

use brush_core::{ExecutionExitCode, ExecutionResult, builtins};
use clap::Parser;

/// Directly invokes a built-in, without going through typical search order.
#[derive(Default, Parser)]
pub(crate) struct BuiltinCommand {
	#[clap(skip)]
	args: Vec<brush_core::CommandArg>,
}

impl builtins::DeclarationCommand for BuiltinCommand {
	fn set_declarations(&mut self, args: Vec<brush_core::CommandArg>) {
		self.args = args;
	}
}

impl builtins::Command for BuiltinCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		mut context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		if self.args.is_empty() {
			return Ok(ExecutionResult::success());
		}

		// As Bash's `builtin` does, a leading `--` ends its options, and it
		// takes no other (`no_options`).
		let mut args: Vec<_> = self.args.iter().skip(1).cloned().collect();
		match args.first().map(ToString::to_string) {
			Some(first) if first == "--" => {
				args.remove(0);
			},
			Some(option) if option.len() > 1 && option.starts_with('-') => {
				writeln!(context.stderr(), "builtin: {option}: invalid option")?;
				writeln!(context.stderr(), "builtin: usage: builtin [shell-builtin [arg ...]]")?;
				return Ok(ExecutionExitCode::InvalidUsage.into());
			},
			_ => {},
		}
		if args.is_empty() {
			return Ok(ExecutionResult::success());
		}

		let builtin_name = args[0].to_string();

		if let Some(builtin) = context.shell.builtins().get(&builtin_name)
			&& !builtin.disabled
		{
			// The builtin runs on behalf of this command, which Bash's
			// dispatch saw as `builtin`: the command's redirections end with
			// it, even for `exec` or a `command exec` it runs.
			context.params.set_dispatches_simple_command(false);
			context.command_name = builtin_name;
			(builtin.execute_func)(context, args).await
		} else {
			Err(brush_core::ErrorKind::BuiltinNotFound(builtin_name).into())
		}
	}
}
