//! `pidwait` process-waiting builtin, moved from `pi-shell`.

use brush_core::builtins;
use clap::Parser;

use crate::proc_match;

/// Waits for processes selected by process attributes or a name pattern.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct PidwaitCommand {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

impl builtins::Command for PidwaitCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		proc_match::run(proc_match::ProcMatchMode::Wait, self.argv.clone(), context).await
	}
}

#[cfg(test)]
mod tests {
	use std::{process::Command as ProcessCommand, time::Duration};

	use brush_core::builtins::Command as _;

	use super::PidwaitCommand;

	async fn execute_bounded(argv: Vec<String>) -> anyhow::Result<brush_core::ExecutionResult> {
		let mut shell = brush_core::Shell::builder().build().await?;
		let params = shell.default_exec_params();
		let command = PidwaitCommand { argv };
		let context = brush_core::ExecutionContext {
			shell: &mut shell,
			command_name: "pidwait".to_string(),
			params,
		};
		Ok(tokio::time::timeout(Duration::from_secs(2), command.execute(context))
			.await
			.expect("pidwait exceeded its two-second test bound")?)
	}

	#[tokio::test]
	async fn exits_one_when_nothing_matches() -> anyhow::Result<()> {
		let result = execute_bounded(vec!["-p".to_string(), i32::MAX.to_string()]).await?;

		assert_eq!(u8::from(&result.exit_code), 1);
		Ok(())
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
		let outcome = execute_bounded(vec!["-p".to_string(), pid.to_string()]).await;
		let _ = child.kill();
		let _ = child.wait();

		let result = outcome?;
		assert!(result.is_success() || u8::from(&result.exit_code) == 1);
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
			let mut shell = brush_core::Shell::builder().build().await?;
			let params = shell.default_exec_params();
			let command = PidwaitCommand { argv: vec!["-p".to_string(), child.id().to_string()] };
			let context = brush_core::ExecutionContext {
				shell: &mut shell,
				command_name: "pidwait".to_string(),
				params,
			};
			let probe = async {
				// Give pidwait time to select the process and start waiting.
				tokio::time::sleep(Duration::from_millis(200)).await;
				tokio::time::timeout(Duration::from_secs(5), tokio::task::spawn_blocking(|| {})).await
			};
			// `None`: pidwait returned while its process was still running.
			let probed = tokio::select! {
				_ = command.execute(context) => None,
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
