//! The `pgrep` process-matching command, moved from `pi-shell`.

use brush_core::builtins;
use clap::Parser;

use crate::proc_match;

/// Finds processes matching the supplied selection criteria.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct PgrepCommand {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

impl builtins::Command for PgrepCommand {
	type Error = brush_core::Error;

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> impl Future<Output = Result<brush_core::ExecutionResult, Self::Error>> + Send {
		proc_match::run(proc_match::ProcMatchMode::Grep, self.argv.clone(), context)
	}
}

#[cfg(test)]
mod tests {
	use std::io::Read as _;

	use brush_core::{
		ExecutionContext, Shell,
		builtins::Command as _,
		openfiles::{self, OpenFiles},
	};

	#[cfg(unix)]
	fn matching_process() -> std::process::Child {
		std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn matching process")
	}

	use super::PgrepCommand;

	async fn execute(argv: Vec<String>) -> (brush_core::ExecutionResult, String) {
		let mut shell = Shell::builder().build().await.expect("build test shell");
		let mut params = shell.default_exec_params();
		let (mut output, writer) = std::io::pipe().expect("create output pipe");
		params.set_fd(OpenFiles::STDIN_FD, openfiles::null().expect("open null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, writer.into());
		params.set_fd(OpenFiles::STDERR_FD, openfiles::null().expect("open null stderr"));
		let command = PgrepCommand { argv };
		let result = command
			.execute(ExecutionContext { shell: &mut shell, command_name: "pgrep".into(), params })
			.await
			.expect("execute pgrep");
		let mut stdout = String::new();
		output.read_to_string(&mut stdout).expect("read pgrep output");
		(result, stdout)
	}

	#[tokio::test]
	async fn exits_one_when_no_process_matches() {
		let (result, output) = execute(vec!["-p".into(), i32::MAX.to_string()]).await;
		assert_eq!(u8::from(result.exit_code), 1);
		assert!(output.is_empty());
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn exits_zero_and_prints_matching_pid() {
		let mut child = matching_process();
		let pid = child.id();
		let (result, output) = execute(vec!["-p".into(), pid.to_string()]).await;
		child.kill().expect("kill matching process");
		child.wait().expect("reap matching process");
		assert_eq!(u8::from(result.exit_code), 0);
		assert_eq!(output, format!("{pid}\n"));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn count_prints_number_of_matches() {
		let mut child = matching_process();
		let pid = child.id();
		let (result, output) = execute(vec!["-c".into(), "-p".into(), pid.to_string()]).await;
		child.kill().expect("kill matching process");
		child.wait().expect("reap matching process");
		assert_eq!(u8::from(result.exit_code), 0);
		assert_eq!(output, "1\n");
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn quiet_suppresses_matching_output() {
		let mut child = matching_process();
		let pid = child.id();
		let (result, output) = execute(vec!["-q".into(), "-p".into(), pid.to_string()]).await;
		child.kill().expect("kill matching process");
		child.wait().expect("reap matching process");
		assert_eq!(u8::from(result.exit_code), 0);
		assert!(output.is_empty());
	}
}
