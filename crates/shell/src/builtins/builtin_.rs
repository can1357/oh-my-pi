use clap::Parser;

use crate::{
	CommandArg, Error, ErrorKind, ExecutionContext, ExecutionResult, ShellExtensions, builtins,
};

/// Directly invokes a built-in, without going through typical search order.
#[derive(Default, Parser)]
pub(crate) struct BuiltinCommand {
	#[clap(skip)]
	args: Vec<CommandArg>,
}

impl builtins::DeclarationCommand for BuiltinCommand {
	fn set_declarations(&mut self, args: Vec<CommandArg>) {
		self.args = args;
	}
}

impl builtins::Command for BuiltinCommand {
	type Error = Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		mut context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		if self.args.is_empty() {
			return Ok(ExecutionResult::success());
		}

		let args: Vec<_> = self.args.iter().skip(1).cloned().collect();
		if args.is_empty() {
			return Ok(ExecutionResult::success());
		}

		let builtin_name = args[0].to_string();
		let execute_func = context
			.shell
			.builtins()
			.get(&builtin_name)
			.filter(|builtin| !builtin.disabled)
			.map(|builtin| builtin.execute_func.clone());

		if let Some(execute_func) = execute_func {
			context.command_name = builtin_name;
			execute_func(context, args).await
		} else {
			Err(ErrorKind::BuiltinNotFound(builtin_name).into())
		}
	}
}
