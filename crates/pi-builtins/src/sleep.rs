//! The `sleep` builtin, moved from `pi-shell`.

use std::{future::Future, io::Write, time::Duration};

use clap::Parser;
use tokio::time;

use crate::{
	duration::parse_duration,
	host::{INTERRUPTED_EXIT_CODE, ProcContext, Process},
};

/// Pause execution for the sum of the requested durations.
#[derive(Parser)]
#[command(disable_help_flag = true)]
pub(crate) struct SleepCommand {
	// GNU reports `sleep -1` as an invalid time interval (exit 1), not as an
	// unknown option; let hyphenated operands through to `parse_duration`.
	#[arg(required = true, allow_hyphen_values = true)]
	durations: Vec<String>,
}

impl Process for SleepCommand {
	fn run(&self, context: &ProcContext) -> impl Future<Output = std::io::Result<i32>> + Send {
		let durations = &self.durations;
		async move {
			if context.is_cancelled() {
				return Ok(INTERRUPTED_EXIT_CODE);
			}
			let mut total = Duration::ZERO;
			for duration in durations {
				let Some(parsed) = parse_duration(duration) else {
					let _ = writeln!(context.stderr(), "sleep: invalid time interval '{duration}'");
					return Ok(1);
				};
				// `infinity` parses as `Duration::MAX`; keep the sum saturating.
				total = total.saturating_add(parsed);
			}
			context.flush_output().await?;
			let sleep = time::sleep(total);
			tokio::pin!(sleep);
			if let Some(cancel_token) = context.cancel_token() {
				tokio::select! {
					() = &mut sleep => Ok(0),
					() = cancel_token.cancelled() => Ok(INTERRUPTED_EXIT_CODE),
				}
			} else {
				sleep.await;
				Ok(0)
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use tokio::time;
	use tokio_util::sync::CancellationToken;

	use super::SleepCommand;
	use crate::{duration::parse_duration, host::run_proc};

	#[tokio::test]
	async fn valid_durations_parse_and_short_sleep_completes() {
		assert_eq!(parse_duration("0.001"), Some(Duration::from_millis(1)));
		assert_eq!(parse_duration("0.001s"), Some(Duration::from_millis(1)));
		assert_eq!(parse_duration("0.001m"), Some(Duration::from_millis(60)));
		// Sub-millisecond precision must survive: GNU sleep honors 100µs.
		assert_eq!(parse_duration("0.0001"), Some(Duration::from_micros(100)));
		assert_eq!(parse_duration("0.000001h"), Some(Duration::from_micros(3600)));
		assert_eq!(parse_duration("0.00000001d"), Some(Duration::from_micros(864)));

		let (code, ..) = time::timeout(
			Duration::from_millis(100),
			run_proc::<SleepCommand>(&["sleep", "0.001", "0.001s"], None),
		)
		.await
		.expect("short sleep should complete promptly");
		assert_eq!(code, 0);
	}

	#[tokio::test]
	async fn infinity_operand_parses_and_sleep_is_cancellable() {
		// GNU accepts `inf`/`infinity`, any case, with an optional `+` sign.
		for spec in ["infinity", "inf", "INFINITY", "Inf", "+infinity", "+inf"] {
			assert_eq!(parse_duration(spec), Some(Duration::MAX), "spec {spec:?}");
		}
		assert_eq!(parse_duration("nan"), None);
		assert_eq!(parse_duration("-inf"), None);

		// `sleep infinity` must block until cancelled rather than erroring out.
		let token = CancellationToken::new();
		let execution = async {
			let ((code, ..), ()) =
				tokio::join!(run_proc::<SleepCommand>(&["sleep", "infinity"], Some(token.clone())), async {
					tokio::task::yield_now().await;
					token.cancel();
				});
			code
		};
		let code = time::timeout(Duration::from_millis(100), execution)
			.await
			.expect("cancelled infinite sleep should return promptly");
		assert_eq!(code, 130);
	}

	#[tokio::test]
	async fn hyphenated_operand_is_an_invalid_interval_not_an_unknown_flag() {
		// `sleep -1` must not die in clap with an unknown-option error; GNU
		// reports an invalid time interval and exits 1.
		let (code, _, stderr) = run_proc::<SleepCommand>(&["sleep", "-1"], None).await;
		assert_eq!(code, 1);
		assert_eq!(stderr, "sleep: invalid time interval '-1'\n");
	}

	#[tokio::test]
	async fn invalid_duration_reports_original_diagnostic_and_exit_code() {
		let (code, _, stderr) = run_proc::<SleepCommand>(&["sleep", "not-a-duration"], None).await;
		assert_eq!(code, 1);
		assert_eq!(stderr, "sleep: invalid time interval 'not-a-duration'\n");
	}

	#[tokio::test]
	async fn cancelled_invocation_returns_promptly() {
		let token = CancellationToken::new();
		let execution = async {
			let ((code, ..), ()) =
				tokio::join!(run_proc::<SleepCommand>(&["sleep", "0.250"], Some(token.clone())), async {
					tokio::task::yield_now().await;
					token.cancel();
				});
			code
		};
		let code = time::timeout(Duration::from_millis(100), execution)
			.await
			.expect("cancelled sleep should return promptly");
		assert_eq!(code, 130);
	}
}
