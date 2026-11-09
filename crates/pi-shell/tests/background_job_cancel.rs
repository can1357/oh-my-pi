//! Cancelling a run reaches the in-process background jobs it started, so a
//! run cancelled while it `wait`s on one ends at once and reports why (its
//! result says it timed out; like bash killed by a signal, the shell prints
//! nothing).
#![cfg(unix)]

use std::time::{Duration, Instant};

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Each `&` job had a token of its own that the run's token did not reach, so
/// the cancelled run sat in `wait` until the host's 2 s grace aborted it.
#[tokio::test(flavor = "multi_thread")]
async fn cancelled_run_stops_waiting_on_its_background_job() {
	for script in ["sleep 20 & wait; echo after", "{ sleep 20; } & wait %1; echo after"] {
		let (tx, rx) = flume::unbounded::<String>();
		let started = Instant::now();
		let result = Shell::new(None)
			.run(
				ShellRunOptions { command: script.to_owned(), ..Default::default() },
				Some(tx),
				CancelToken::new(Some(300)),
			)
			.await
			.expect("run");
		let elapsed = started.elapsed();
		let output: String = rx.drain().collect();

		assert!(elapsed < Duration::from_millis(1500), "`{script}` took {elapsed:?}");
		assert!(!output.contains("after"), "`{script}` kept running: {output:?}");
		assert_eq!((result.exit_code, result.timed_out), (None, true), "`{script}`");
	}
}
