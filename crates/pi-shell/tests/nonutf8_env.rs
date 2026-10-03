//! Regression tests for oh-my-pi issue #8925: a host environment entry whose
//! key or value is not valid Unicode must not crash session startup or command
//! execution.
//!
//! This lives in `tests/` (a process of its own) on purpose: `set_var` mutates
//! the process-global environment, and a corrupt entry would poison any other
//! test binary that still reads it via `std::env::vars()`.

#![cfg(unix)]

use std::os::unix::ffi::OsStrExt;

use pi_shell::{ShellExecuteOptions, cancel::CancelToken, execute_shell};

/// The corrupt bytes cmux/Ghostty staged as `GHOSTTY_BIN_DIR` on the
/// reporter's host: `9d d9 50` has no valid UTF-8 encoding.
const GHOSTTY_BIN_DIR_BYTES: &[u8] = &[0x9d, 0xd9, 0x50];

/// Sets then restores a process-global env var, scoped to the test body.
struct ScopedEnvVar {
	key: &'static str,
}

impl ScopedEnvVar {
	fn set_corrupt(key: &'static str, bytes: &[u8]) -> Self {
		// SAFETY: this dedicated test process mutates the environment only
		// here, between awaits, so no other thread is reading or writing it
		// concurrently.
		unsafe { std::env::set_var(key, std::ffi::OsStr::from_bytes(bytes)) };
		Self { key }
	}

	fn set(key: &'static str, value: &str) -> Self {
		// SAFETY: as in `set_corrupt`; the process-global environment is
		// mutated only at these controlled points.
		unsafe { std::env::set_var(key, value) };
		Self { key }
	}
}

impl Drop for ScopedEnvVar {
	fn drop(&mut self) {
		// SAFETY: the guard is dropped after all awaits have completed, when
		// no runtime thread is reading the environment.
		unsafe { std::env::remove_var(self.key) };
	}
}

/// Runs one shell command through the public one-shot entry point and returns
/// its exit code plus captured stdout.
async fn run(command: &str) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded();
	let result = execute_shell(
		ShellExecuteOptions { command: command.to_string(), ..Default::default() },
		Some(tx),
		CancelToken::default(),
	)
	.await
	.expect("shell execution");
	let output = rx.try_iter().collect();
	(result.exit_code, output)
}

/// The session (re)created by each `execute_shell` call copies the host
/// environment key by key. A corrupt value must be skipped, not panicked over,
/// while other entries (here the sentinel and PATH) still land.
#[tokio::test(flavor = "multi_thread")]
async fn session_start_skips_non_utf8_value_and_preserves_env() {
	let path = std::env::var("PATH").unwrap_or_default();

	let _corrupt = ScopedEnvVar::set_corrupt("OMP_TEST_CORRUPT_8925", GHOSTTY_BIN_DIR_BYTES);
	let _sentinel = ScopedEnvVar::set("OMP_TEST_SENTINEL_8925", "sentinel-value");

	// Starts with a corrupt var present: must not panic.
	let (code, output) = run("echo $OMP_TEST_SENTINEL_8925").await;
	assert_eq!(code, Some(0), "session start must succeed with a corrupt env var");
	assert!(
		output.contains("sentinel-value"),
		"valid env entries must still be copied; got {output:?}"
	);

	// PATH survives the copy unchanged.
	let (code, output) = run("echo \"$PATH\"").await;
	assert_eq!(code, Some(0));
	assert_eq!(output.trim_end(), path, "PATH must survive the corrupt-env copy");
}

/// The process builtins (`sleep`, `timeout`, `pgrep`, …) each build a plain
/// brush shell that inherits the host environment via brush-core's
/// `get_host_env_vars`, the second `std::env::vars()` sink. Must not panic
/// either.
#[tokio::test(flavor = "multi_thread")]
async fn process_builtin_shell_build_survives_non_utf8_env() {
	let _corrupt = ScopedEnvVar::set_corrupt("OMP_TEST_CORRUPT_8925", GHOSTTY_BIN_DIR_BYTES);

	let (code, _) = run("sleep 0").await;
	assert_eq!(code, Some(0), "process builtin must survive a corrupt env var");
}
