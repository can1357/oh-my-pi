use std::io::Write;

use clap::Parser;

use crate::{
	Error, ExecutionContext, ExecutionResult, ShellExtensions, builtins,
	sys::resource::{get_children_user_and_system_time, get_self_user_and_system_time},
	timing,
};

/// Report on usage time.
#[derive(Parser)]
pub(crate) struct TimesCommand {}

impl builtins::Command for TimesCommand {
	type Error = Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		let (self_user, self_system) = get_self_user_and_system_time()?;
		writeln!(
			context.stdout(),
			"{} {}",
			timing::format_duration_non_posixly(&self_user),
			timing::format_duration_non_posixly(&self_system),
		)?;

		let (children_user, children_system) = get_children_user_and_system_time()?;
		writeln!(
			context.stdout(),
			"{} {}",
			timing::format_duration_non_posixly(&children_user),
			timing::format_duration_non_posixly(&children_system),
		)?;

		Ok(ExecutionResult::success())
	}
}
