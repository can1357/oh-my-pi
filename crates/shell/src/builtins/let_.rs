use std::io::Write;

use clap::Parser;

use crate::{
	Error, ExecutionContext, ExecutionExitCode, ExecutionResult, ShellExtensions,
	arithmetic::Evaluatable, builtins, parser::arithmetic::parse,
};

/// Evaluate arithmetic expressions.
#[derive(Parser)]
pub(crate) struct LetCommand {
	/// Arithmetic expressions to evaluate.
	#[arg(trailing_var_arg = true, allow_hyphen_values = true)]
	exprs: Vec<String>,
}

impl builtins::Command for LetCommand {
	type Error = Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		let mut result = ExecutionExitCode::InvalidUsage.into();

		if self.exprs.is_empty() {
			writeln!(context.stderr(), "missing expression")?;
			return Ok(result);
		}

		for expr in &self.exprs {
			let parsed = parse(expr.as_str())?;
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
