//! Regression tests for OMP issue #8925: a host environment entry whose
//! key or value is not valid Unicode must not crash shell startup or command
//! execution.
//!
//! A naive `std::env::vars()` call panics on the first non-Unicode entry
//! before any command can run (e.g. the corrupt `GHOSTTY_BIN_DIR` staged by
//! cmux/Ghostty, bytes `9d d9 50`). The engine reads the host environment via
//! `vars_os()` and skips corrupt entries while copying the rest.
//!
//! The corrupt entries are injected on the spawned `omp-sh` child only; this
//! test process's own environment stays clean.

#![cfg(unix)]

use std::{env, ffi::OsStr, os::unix::ffi::OsStrExt, process::Command};

/// The corrupt bytes cmux/Ghostty staged as `GHOSTTY_BIN_DIR` on the
/// reporter's host: `9d d9 50` has no valid UTF-8 encoding.
const GHOSTTY_BIN_DIR_BYTES: &[u8] = &[0x9d, 0xd9, 0x50];

fn run_with_corrupt_env(script: &str) -> (String, String, i32) {
	let output = Command::new(env!("CARGO_BIN_EXE_omp-sh"))
		.args(["-c", script])
		.env("GHOSTTY_BIN_DIR", OsStr::from_bytes(GHOSTTY_BIN_DIR_BYTES))
		.env(OsStr::from_bytes(b"\xffOMP_TEST_BAD_KEY_8925"), "x")
		.env("OMP_TEST_SENTINEL_8925", "sentinel-value")
		.output()
		.expect("execute omp-sh");
	let stdout = String::from_utf8(output.stdout).expect("omp-sh stdout is UTF-8");
	let stderr = String::from_utf8(output.stderr).expect("omp-sh stderr is UTF-8");
	let exit = output.status.code().expect("omp-sh exited normally");
	(stdout, stderr, exit)
}

/// Startup copies the host environment entry by entry. Corrupt entries must be
/// skipped, not panicked over, while valid entries (the sentinel and `PATH`)
/// still land in the shell.
#[test]
fn startup_skips_non_utf8_entries_and_preserves_valid_env() {
	let path = env::var("PATH").unwrap_or_default();

	let (stdout, stderr, exit) =
		run_with_corrupt_env("echo \"$OMP_TEST_SENTINEL_8925\"; echo \"$PATH\"");
	assert_eq!(exit, 0, "shell must start with a corrupt env entry; stderr: {stderr}");
	let mut lines = stdout.lines();
	assert_eq!(
		lines.next(),
		Some("sentinel-value"),
		"valid env entries must still be copied; stdout: {stdout:?}"
	);
	assert_eq!(
		lines.next(),
		Some(path.as_str()),
		"PATH must survive the corrupt-env copy; stdout: {stdout:?}"
	);
}

/// The corrupt value itself is dropped: the variable is simply absent inside
/// the shell rather than truncated, lossy-decoded, or fatal.
#[test]
fn corrupt_entries_are_absent_not_mangled() {
	let (stdout, stderr, exit) =
		run_with_corrupt_env("if [ -z \"${GHOSTTY_BIN_DIR+set}\" ]; then echo unset; fi");
	assert_eq!(exit, 0, "shell must start with a corrupt env entry; stderr: {stderr}");
	assert_eq!(stdout.trim_end(), "unset", "a non-UTF-8 value must be skipped, not decoded");
}

/// Process builtins (`sleep`, `timeout`, `pgrep`, …) inherit the host
/// environment into the shells they build; that second sink must not panic on
/// a corrupt entry either.
#[test]
fn process_builtins_survive_non_utf8_env() {
	let (_, stderr, exit) = run_with_corrupt_env("sleep 0");
	assert_eq!(exit, 0, "process builtin must survive a corrupt env entry; stderr: {stderr}");
}
