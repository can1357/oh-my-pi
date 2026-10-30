use std::io::Write;

use brush_core::{ExecutionResult, ShellExtensions, builtins};
use clap::Parser;

/// Stands in for a builtin the embedding shell withholds because it would act
/// on the host process itself (`exec` replaces it, `suspend` stops it).
#[derive(Parser)]
#[clap(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct WithheldCommand {
	#[clap(allow_hyphen_values = true)]
	args: Vec<String>,
}

impl builtins::Command for WithheldCommand {
	type Error = brush_core::Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		writeln!(context.stderr(), "{}: not available in this shell", context.command_name)?;
		Ok(ExecutionResult::general_error())
	}
}

/// Registration that replaces a builtin the embedding shell withholds.
///
/// It starts disabled, so the name resolves exactly as a disabled builtin
/// does, and re-enabling it (`enable exec`) only enables the refusal: the real
/// implementation is no longer registered.
pub fn withheld_builtin<SE: ShellExtensions>() -> builtins::Registration<SE> {
	let mut registration = builtins::builtin::<WithheldCommand, SE>();
	registration.disabled = true;
	registration
}
