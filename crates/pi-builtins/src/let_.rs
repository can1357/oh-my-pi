use std::io::Write;

use brush_core::{ExecutionExitCode, ExecutionResult, arithmetic::Evaluatable, builtins};
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
			let parsed = brush_parser::arithmetic::parse(expr.as_str())?;
			let evaluated = parsed.eval(context.shell)?;

			if evaluated == 0 {
				result = ExecutionResult::general_error();
			} else {
				result = ExecutionResult::success();
			}
		}

		Ok(result)
	}
}
