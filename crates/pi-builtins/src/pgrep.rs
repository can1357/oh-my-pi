//! The `pgrep` process-matching command, moved from `pi-shell`.

use clap::Parser;

use crate::{
	host::{ProcContext, Process},
	proc_match,
};

/// Finds processes matching the supplied selection criteria.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct PgrepCommand {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

impl Process for PgrepCommand {
	const USES_PATHS: bool = true;

	fn run(&self, context: &ProcContext) -> impl Future<Output = std::io::Result<i32>> + Send {
		proc_match::run(proc_match::ProcMatchMode::Grep, &self.argv, context)
	}
}

#[cfg(test)]
mod tests {
	use super::PgrepCommand;
	use crate::host::run_proc;

	#[cfg(unix)]
	fn matching_process() -> std::process::Child {
		std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn matching process")
	}

	async fn execute(argv: &[&str]) -> (i32, String) {
		let argv: Vec<&str> = std::iter::once("pgrep").chain(argv.iter().copied()).collect();
		let (code, out, _) = run_proc::<PgrepCommand>(&argv, None).await;
		(code, out)
	}

	#[tokio::test]
	async fn exits_one_when_no_process_matches() {
		let (code, output) = execute(&["-p", &i32::MAX.to_string()]).await;
		assert_eq!(code, 1);
		assert!(output.is_empty());
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn exits_zero_and_prints_matching_pid() {
		let mut child = matching_process();
		let pid = child.id();
		let (code, output) = execute(&["-p", &pid.to_string()]).await;
		child.kill().expect("kill matching process");
		child.wait().expect("reap matching process");
		assert_eq!(code, 0);
		assert_eq!(output, format!("{pid}\n"));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn count_prints_number_of_matches() {
		let mut child = matching_process();
		let pid = child.id();
		let (code, output) = execute(&["-c", "-p", &pid.to_string()]).await;
		child.kill().expect("kill matching process");
		child.wait().expect("reap matching process");
		assert_eq!(code, 0);
		assert_eq!(output, "1\n");
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn quiet_suppresses_matching_output() {
		let mut child = matching_process();
		let pid = child.id();
		let (code, output) = execute(&["-q", "-p", &pid.to_string()]).await;
		child.kill().expect("kill matching process");
		child.wait().expect("reap matching process");
		assert_eq!(code, 0);
		assert!(output.is_empty());
	}
}
