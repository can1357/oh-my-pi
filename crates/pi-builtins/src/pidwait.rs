//! `pidwait` process-waiting builtin, moved from `pi-shell`.

use clap::Parser;

use crate::{
	host::{ProcContext, Process},
	proc_match,
};

/// Waits for processes selected by process attributes or a name pattern.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct PidwaitCommand {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

impl Process for PidwaitCommand {
	const USES_PATHS: bool = true;

	fn run(&self, context: &ProcContext) -> impl Future<Output = std::io::Result<i32>> + Send {
		proc_match::run(proc_match::ProcMatchMode::Wait, &self.argv, context)
	}
}

#[cfg(test)]
mod tests {
	use std::{process::Command as ProcessCommand, time::Duration};

	use super::PidwaitCommand;
	use crate::host::run_proc;

	async fn execute_bounded(argv: &[&str]) -> i32 {
		let argv: Vec<&str> = std::iter::once("pidwait").chain(argv.iter().copied()).collect();
		tokio::time::timeout(Duration::from_secs(2), run_proc::<PidwaitCommand>(&argv, None))
			.await
			.expect("pidwait exceeded its two-second test bound")
			.0
	}

	#[tokio::test]
	async fn exits_one_when_nothing_matches() {
		assert_eq!(execute_bounded(&["-p", &i32::MAX.to_string()]).await, 1);
	}

	#[tokio::test]
	async fn already_exited_pid_returns_promptly() -> anyhow::Result<()> {
		#[cfg(unix)]
		let mut child = ProcessCommand::new("sh").args(["-c", "exit 0"]).spawn()?;
		#[cfg(windows)]
		let mut child = ProcessCommand::new("cmd").args(["/C", "exit 0"]).spawn()?;
		let pid = child.id();

		// Leave the child unreaped so it remains visible in the process snapshot,
		// while giving the trivial command enough time to reach its exited state.
		tokio::time::sleep(Duration::from_millis(100)).await;
		let code = execute_bounded(&["-p", &pid.to_string()]).await;
		let _ = child.kill();
		let _ = child.wait();

		assert!(code == 0 || code == 1, "status {code}");
		Ok(())
	}

	/// A waiting `pidwait` must not hold a blocking-pool thread: hosts cap that
	/// pool (eight threads in pi-natives on Windows) and run every utility
	/// builtin on it, so a few long waits would stall unrelated commands.
	#[test]
	fn waiting_holds_no_blocking_pool_thread() -> anyhow::Result<()> {
		let runtime = tokio::runtime::Builder::new_multi_thread()
			.max_blocking_threads(1)
			.enable_all()
			.build()?;
		runtime.block_on(async {
			#[cfg(unix)]
			let mut child = ProcessCommand::new("sleep").arg("30").spawn()?;
			#[cfg(windows)]
			let mut child = ProcessCommand::new("ping")
				.args(["-n", "30", "127.0.0.1"])
				.stdout(std::process::Stdio::null())
				.spawn()?;
			let pid = child.id().to_string();
			let probe = async {
				// Give pidwait time to select the process and start waiting.
				tokio::time::sleep(Duration::from_millis(200)).await;
				tokio::time::timeout(Duration::from_secs(5), tokio::task::spawn_blocking(|| {})).await
			};
			let argv = ["pidwait", "-p", &pid];
			// `None`: pidwait returned while its process was still running.
			let probed = tokio::select! {
				_ = run_proc::<PidwaitCommand>(&argv, None) => None,
				probed = probe => Some(probed),
			};
			let _ = child.kill();
			let _ = child.wait();

			let probed = probed.expect("pidwait returned while its process was running");
			assert!(
				matches!(probed, Ok(Ok(()))),
				"a blocking task could not run while pidwait was waiting"
			);
			Ok(())
		})
	}
}
