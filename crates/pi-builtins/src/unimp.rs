use brush_core::{ExecutionExitCode, builtins, trace_categories};
use clap::Parser;

/// (UNIMPLEMENTED COMMAND)
#[derive(Parser)]
pub(crate) struct UnimplementedCommand {
	#[clap(allow_hyphen_values = true)]
	args: Vec<String>,

	#[clap(skip)]
	declarations: Vec<brush_core::CommandArg>,
}

impl builtins::Command for UnimplementedCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		tracing::warn!(target: trace_categories::UNIMPLEMENTED,
			 "unimplemented built-in: {} {}",
			 context.command_name,
			 self.args.join(" ")
		);
		Ok(ExecutionExitCode::Unimplemented.into())
	}
}

impl builtins::DeclarationCommand for UnimplementedCommand {
	fn set_declarations(&mut self, declarations: Vec<brush_core::CommandArg>) {
		self.declarations = declarations;
	}
}
