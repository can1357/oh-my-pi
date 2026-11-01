use std::io::Write;

use brush_core::{ExecutionExitCode, ExecutionResult, arithmetic, builtins};
use clap::Parser;

/// Evaluate arithmetic expressions.
#[derive(Parser)]
pub(crate) struct LetCommand {
	/// Arithmetic expressions to evaluate.
	#[arg(trailing_var_arg = true, allow_hyphen_values = true)]
	exprs: Vec<String>,
}

impl builtins::Command for LetCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		let mut result = ExecutionExitCode::InvalidUsage.into();

		if self.exprs.is_empty() {
			writeln!(context.stderr(), "missing expression")?;
			return Ok(result);
		}

		for expr in &self.exprs {
			let parsed = arithmetic::parse_for_builtin(&context.params, expr.as_str()).await?;
			let evaluated = arithmetic::evaluate(context.shell, &context.params, &parsed).await?;

			if evaluated == 0 {
				result = ExecutionResult::general_error();
			} else {
				result = ExecutionResult::success();
			}
		}

		Ok(result)
	}
}
