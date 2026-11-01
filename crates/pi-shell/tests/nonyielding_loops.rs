//! A loop whose body only runs builtins never awaits anything. `timeout` must
//! still stop it, a script with such a loop in the background must still run
//! on, and cancelling the run must still end it.
#![cfg(unix)]

use std::{
	sync::mpsc,
	time::{Duration, Instant},
};

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Runs `command` on a runtime of its own and returns its output, or `None`
/// when it has not finished after `limit`. A loop that never yields would pin
/// a runtime worker for good, so the runtime lives on a thread that is left
/// behind instead of shut down.
fn run_within(
	command: &str,
	cwd: Option<&std::path::Path>,
	cancel_after_ms: Option<u32>,
	limit: Duration,
) -> Option<String> {
	let (done_tx, done_rx) = mpsc::channel();
	let command = command.to_owned();
	let cwd = cwd.map(|cwd| cwd.to_string_lossy().into_owned());
	std::thread::spawn(move || {
		let runtime = tokio::runtime::Builder::new_multi_thread()
			.worker_threads(4)
			.enable_all()
			.build()
			.expect("runtime");
		let output = runtime.block_on(async move {
			let (tx, rx) = flume::unbounded::<String>();
			let result = Shell::new(None)
				.run(
					ShellRunOptions { command, cwd, ..Default::default() },
					Some(tx),
					CancelToken::new(cancel_after_ms),
				)
				.await;
			let output: String = rx.drain().collect();
			format!(
				"{output}[run: {}]",
				result.map_or_else(|e| e.to_string(), |r| format!("{:?}", r.exit_code))
			)
		});
		let _ = done_tx.send(output);
		std::mem::forget(runtime);
	});
	done_rx.recv_timeout(limit).ok()
}

#[test]
fn timeout_stops_a_loop_that_never_yields() {
	let started = Instant::now();
	let output = run_within(
		"timeout 1 eval 'while :; do :; done'; echo \"status=$?\"",
		None,
		None,
		Duration::from_secs(10),
	)
	.expect("`timeout 1` did not stop the loop within 10 s");
	assert!(output.contains("status=124"), "timeout did not report 124: {output:?}");
	assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
}

/// Without the yield this script hung on a 4-worker runtime when an external
/// command (`mkfifo` here; `/usr/bin/touch t` too, a builtin does not) ran
/// just before the background loop: it never got past `sleep 0.2`, so neither
/// `kill %1` nor `wait` ran. The test asserts only that the script reaches its
/// end: `kill %1` marks the job done, so `wait` returns whether or not the loop
/// stopped.
#[test]
fn background_loop_after_an_external_command_lets_the_script_reach_kill_and_wait() {
	let dir = tempfile::tempdir().expect("tempdir");
	let output = run_within(
		"mkfifo f; while :; do :; done & sleep 0.2; kill %1; wait; echo end",
		Some(dir.path()),
		None,
		Duration::from_secs(10),
	)
	.expect("the script did not reach its end within 10 s");
	assert!(output.contains("end"), "the script did not finish: {output:?}");
}

/// pi-shell aborts a cancelled run after a 2 s grace period, so a run that
/// ends in under 2 s shows the cancellation itself reached the loop.
#[test]
fn cancelling_the_run_stops_a_loop_under_timeout() {
	let started = Instant::now();
	run_within("timeout 30 eval 'while :; do :; done'", None, Some(500), Duration::from_secs(10))
		.expect("the cancelled run did not end within 10 s");
	assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
}
