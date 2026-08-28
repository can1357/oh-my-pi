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

		let args: Vec<_> = self.args.iter().skip(1).cloned().collect();
		if args.is_empty() {
			return Ok(ExecutionResult::success());
		}

		let builtin_name = args[0].to_string();

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
