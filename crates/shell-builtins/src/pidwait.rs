//! `pidwait` process-waiting builtin.

use clap::Parser;
use omp_shell::builtins;

use crate::proc_match;

/// Waits for processes selected by process attributes or a name pattern.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct PidwaitCommand {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

impl builtins::Command for PidwaitCommand {
	type Error = omp_shell::Error;

	async fn execute<SE: omp_shell::ShellExtensions>(
		&self,
		context: omp_shell::ExecutionContext<'_, SE>,
	) -> Result<omp_shell::ExecutionResult, Self::Error> {
		proc_match::run(proc_match::ProcMatchMode::Wait, self.argv.clone(), context).await
	}
}

#[cfg(test)]
mod tests {
	use std::{error, process::Command as ProcessCommand, time::Duration};

	use omp_shell::builtins::Command as _;
	use tokio::time;

	use super::PidwaitCommand;

	async fn execute_bounded(
		argv: Vec<String>,
	) -> Result<omp_shell::ExecutionResult, Box<dyn error::Error>> {
		let mut shell = omp_shell::Shell::builder().build().await?;
		let params = shell.default_exec_params();
		let command = PidwaitCommand { argv };
		let context = omp_shell::ExecutionContext {
			shell: &mut shell,
			command_name: "pidwait".to_string(),
			params,
		};
		Ok(time::timeout(Duration::from_secs(2), command.execute(context))
			.await
			.expect("pidwait exceeded its two-second test bound")?)
	}

	#[tokio::test]
	async fn exits_one_when_nothing_matches() -> Result<(), Box<dyn error::Error>> {
		let result = execute_bounded(vec!["-p".to_string(), i32::MAX.to_string()]).await?;

		assert_eq!(u8::from(&result.exit_code), 1);
		Ok(())
	}

	#[tokio::test]
	async fn already_exited_pid_returns_promptly() -> Result<(), Box<dyn error::Error>> {
		#[cfg(unix)]
		let mut child = ProcessCommand::new("sh").args(["-c", "exit 0"]).spawn()?;
		#[cfg(windows)]
		let mut child = ProcessCommand::new("cmd").args(["/C", "exit 0"]).spawn()?;
		let pid = child.id();

		// Leave the child unreaped so it remains visible in the process snapshot,
		// while giving the trivial command enough time to reach its exited state.
		time::sleep(Duration::from_millis(100)).await;
		let outcome = execute_bounded(vec!["-p".to_string(), pid.to_string()]).await;
		let _ = child.kill();
		let _ = child.wait();

		let result = outcome?;
		assert!(result.is_success() || u8::from(&result.exit_code) == 1);
		Ok(())
	}
}
