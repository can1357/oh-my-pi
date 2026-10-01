//! `pkill` process-signalling builtin moved from `pi-shell`.

use brush_core::builtins;
use clap::Parser;

use crate::proc_match;

/// Selects processes by name or attributes and sends them a signal.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct PkillCommand {
	/// Arguments interpreted by the shared process-matching engine.
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

impl builtins::Command for PkillCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		proc_match::run(proc_match::ProcMatchMode::Kill, self.argv.clone(), context).await
	}
}

#[cfg(test)]
mod tests {
	use brush_core::{Shell, builtins};

	use super::PkillCommand;

	const NO_MATCH: &str = "^__brush_pkill_test_no_such_process_6f239a1d__$";

	async fn run(args: &str) -> brush_core::ExecutionResult {
		let mut shell = Shell::builder()
			.builtin("pkill", builtins::builtin::<PkillCommand, _>())
			.build()
			.await
			.expect("test shell should build");
		shell
			.run_dash_c_command(format!("pkill {args} {NO_MATCH}"))
			.await
			.expect("pkill should execute")
	}

	#[tokio::test]
	async fn exits_one_when_no_process_matches() {
		assert_eq!(u8::from(run("").await.exit_code), 1);
	}

	#[tokio::test]
	async fn accepts_a_signal_name() {
		assert_eq!(u8::from(run("-TERM").await.exit_code), 1);
	}

	#[tokio::test]
	async fn accepts_a_signal_number() {
		assert_eq!(u8::from(run("-9").await.exit_code), 1);
	}
}
