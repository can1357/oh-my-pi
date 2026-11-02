use brush_core::{ExecutionResult, builtins};
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

		// As Bash's `builtin` does, a leading `--` ends its options.
		let mut args: Vec<_> = self.args.iter().skip(1).cloned().collect();
		if args.first().is_some_and(|arg| arg.to_string() == "--") {
			args.remove(0);
		}
		if args.is_empty() {
			return Ok(ExecutionResult::success());
		}

		let builtin_name = args[0].to_string();

		// Bash undoes the redirections of a `builtin` command when it ends,
		// and only `exec` itself (or `command exec`) keeps them, so
		// `builtin exec` with no command changes no descriptor.
		if builtin_name == "exec" && !exec_runs_command(&args[1..]) {
			return Ok(ExecutionResult::success());
		}

		if let Some(builtin) = context.shell.builtins().get(&builtin_name)
			&& !builtin.disabled
		{
			context.command_name = builtin_name;
			(builtin.execute_func)(context, args).await
		} else {
			Err(brush_core::ErrorKind::BuiltinNotFound(builtin_name).into())
		}
	}
}

/// Whether `exec`'s arguments name a command to run: an operand after its
/// options `-c`, `-l` and `-a NAME`.
fn exec_runs_command(args: &[brush_core::CommandArg]) -> bool {
	let mut words = args.iter().map(ToString::to_string);
	while let Some(word) = words.next() {
		match word.as_str() {
			"--" => return words.next().is_some(),
			"-a" => {
				words.next();
			},
			option if option.starts_with('-') && option.len() > 1 => {},
			_ => return true,
		}
	}
	false
}
