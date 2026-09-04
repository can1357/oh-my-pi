//! The `sleep` builtin.

use std::{future::Future, io::Write, result, time::Duration};

use clap::Parser;
use omp_shell::{ExecutionContext, ExecutionExitCode, ExecutionResult, builtins};
use tokio::time;

use crate::host::parse_duration;

/// Pause execution for the sum of the requested durations.
#[derive(Parser)]
#[command(disable_help_flag = true)]
pub(crate) struct SleepCommand {
	#[arg(required = true, allow_hyphen_values = true)]
	durations: Vec<String>,
}

impl builtins::Command for SleepCommand {
	type Error = omp_shell::Error;

	fn new<I>(args: I) -> result::Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		Self::try_parse_from(args).inspect_err(|error| {
			if error.use_stderr() {
				tracing::warn!(
					builtin = "sleep",
					error_kind = ?error.kind(),
					"builtin arguments rejected"
				);
			}
		})
	}

	fn execute<SE: omp_shell::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = result::Result<ExecutionResult, omp_shell::Error>> + Send {
		let durations = self.durations.clone();
		async move {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			let mut total = Duration::ZERO;
			for duration in &durations {
				let Some(parsed) = parse_duration(duration) else {
					tracing::warn!(builtin = "sleep", "builtin duration rejected");
					let _ = writeln!(context.stderr(), "sleep: invalid time interval '{duration}'");
					return Ok(ExecutionResult::new(1));
				};
				total = total.saturating_add(parsed);
			}
			let sleep = time::sleep(total);
			tokio::pin!(sleep);
			if let Some(cancel_token) = context.cancel_token() {
				tokio::select! {
					() = &mut sleep => Ok(ExecutionResult::success()),
					() = cancel_token.cancelled() => Ok(ExecutionExitCode::Interrupted.into()),
				}
			} else {
				sleep.await;
				Ok(ExecutionResult::success())
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use std::io::{self, Read};

	use omp_shell::{
		ExecutionParameters, Shell,
		builtins::Command,
		openfiles::{OpenFile, OpenFiles},
	};
	use tokio_util::sync::CancellationToken;

	use super::*;

	#[tokio::test]
	async fn valid_durations_parse_and_short_sleep_completes() {
		assert_eq!(parse_duration("0.001"), Some(Duration::from_millis(1)));
		assert_eq!(parse_duration("0.001s"), Some(Duration::from_millis(1)));
		assert_eq!(parse_duration("0.001m"), Some(Duration::from_millis(60)));
		assert_eq!(parse_duration("0.0001"), Some(Duration::from_micros(100)));
		assert_eq!(parse_duration("0.000001h"), Some(Duration::from_micros(3600)));
		assert_eq!(parse_duration("0.00000001d"), Some(Duration::from_micros(864)));

		let mut shell = Shell::builder()
			.build()
			.await
			.expect("test shell should build");
		let command = SleepCommand { durations: vec!["0.001".into(), "0.001s".into()] };
		let context = ExecutionContext {
			shell:        &mut shell,
			command_name: "sleep".into(),
			params:       ExecutionParameters::default(),
		};
		let result = time::timeout(Duration::from_millis(100), command.execute(context))
			.await
			.expect("short sleep should complete promptly")
			.expect("sleep execution should succeed");

		assert!(result.is_success());
	}

	#[tokio::test]
	async fn infinity_operand_parses_and_sleep_is_cancellable() {
		for spec in ["infinity", "inf", "INFINITY", "Inf", "+infinity", "+inf"] {
			assert_eq!(parse_duration(spec), Some(Duration::MAX), "spec {spec:?}");
		}
		assert_eq!(parse_duration("nan"), None);
		assert_eq!(parse_duration("-inf"), None);

		let token = CancellationToken::new();
		let mut params = ExecutionParameters::default();
		params.set_cancel_token(token.clone());
		let mut shell = Shell::builder()
			.build()
			.await
			.expect("test shell should build");
		let command = SleepCommand { durations: vec!["infinity".into()] };
		let context = ExecutionContext { shell: &mut shell, command_name: "sleep".into(), params };
		let execution = async {
			let (result, ()) = tokio::join!(command.execute(context), async {
				tokio::task::yield_now().await;
				token.cancel();
			});
			result
		};
		let result = time::timeout(Duration::from_millis(100), execution)
			.await
			.expect("cancelled infinite sleep should return promptly")
			.expect("sleep execution should succeed");

		assert_eq!(u8::from(result.exit_code), u8::from(ExecutionExitCode::Interrupted));
	}

	#[tokio::test]
	async fn hyphenated_operand_is_an_invalid_interval_not_an_unknown_flag() {
		let command = <SleepCommand as Command>::new(["sleep".into(), "-1".into()])
			.expect("hyphenated operand should reach the builtin");

		let (mut stderr_reader, stderr_writer) = io::pipe().expect("stderr pipe should open");
		let mut params = ExecutionParameters::default();
		params.set_fd(OpenFiles::STDERR_FD, OpenFile::from(stderr_writer));
		let mut shell = Shell::builder()
			.build()
			.await
			.expect("test shell should build");
		let context = ExecutionContext { shell: &mut shell, command_name: "sleep".into(), params };
		let result = command
			.execute(context)
			.await
			.expect("sleep execution should succeed");
		let mut stderr = String::new();
		stderr_reader
			.read_to_string(&mut stderr)
			.expect("stderr should be readable");

		assert_eq!(u8::from(result.exit_code), 1);
		assert_eq!(stderr, "sleep: invalid time interval '-1'\n");
	}

	#[tokio::test]
	async fn invalid_duration_reports_original_diagnostic_and_exit_code() {
		let (mut stderr_reader, stderr_writer) = io::pipe().expect("stderr pipe should open");
		let mut params = ExecutionParameters::default();
		params.set_fd(OpenFiles::STDERR_FD, OpenFile::from(stderr_writer));
		let mut shell = Shell::builder()
			.build()
			.await
			.expect("test shell should build");
		let command = SleepCommand { durations: vec!["not-a-duration".into()] };
		let context = ExecutionContext { shell: &mut shell, command_name: "sleep".into(), params };
		let result = command
			.execute(context)
			.await
			.expect("sleep execution should succeed");
		let mut stderr = String::new();
		stderr_reader
			.read_to_string(&mut stderr)
			.expect("stderr should be readable");

		assert_eq!(u8::from(result.exit_code), 1);
		assert_eq!(stderr, "sleep: invalid time interval 'not-a-duration'\n");
	}

	#[tokio::test]
	async fn cancelled_invocation_returns_promptly() {
		let token = CancellationToken::new();
		let mut params = ExecutionParameters::default();
		params.set_cancel_token(token.clone());
		let mut shell = Shell::builder()
			.build()
			.await
			.expect("test shell should build");
		let command = SleepCommand { durations: vec!["0.250".into()] };
		let context = ExecutionContext { shell: &mut shell, command_name: "sleep".into(), params };
		let execution = async {
			let (result, ()) = tokio::join!(command.execute(context), async {
				tokio::task::yield_now().await;
				token.cancel();
			});
			result
		};
		let result = time::timeout(Duration::from_millis(100), execution)
			.await
			.expect("cancelled sleep should return promptly")
			.expect("sleep execution should succeed");

		assert_eq!(u8::from(result.exit_code), u8::from(ExecutionExitCode::Interrupted));
	}
}
