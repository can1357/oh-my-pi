//! Where the shell's own diagnostics go and what status a failure leaves,
//! through `pi_shell::Shell::run`.
//!
//! A fatal error in a pipeline stage (`: ${x?}`, `$((1/0))`, a readonly
//! assignment, `set -u`, a function that fails so) is written to the
//! stage's redirected standard error (`{ …; } 2>>file | cmd`), as Bash
//! writes it at once, before the stage's redirections are undone; the
//! stage ends with status 1. A diagnostic to a closed or full standard
//! error is lost without ending the shell, and each builtin fails with
//! Bash's status then (`bind -Z` is a usage error, 2).
//!
//! Each row's expected output is Bash 5.3.20 running the script as
//! `bash -c` (the oracle rule and `PI_SHELL_BASH_ORACLE` are in
//! `bash_oracle`): a fatal expansion error leaves a `-c` string with status
//! 127. The rows are in `fixtures/stage_diagnostics.json`.
#![cfg(target_os = "linux")]

mod bash_oracle;

use bash_oracle::{Row, assert_rows, rows};

const FIXTURE: &str = "stage_diagnostics.json";

/// The errored-stage rows, split into the foreground and `lastpipe` shapes
/// and the background ones (`background`, `background-listed`).
fn errored_stage_rows(background: bool) -> Vec<Row> {
	rows(FIXTURE, "an_errored_stage_ends_with_its_error_status")
		.into_iter()
		.filter(|row| row.name.starts_with("background") == background)
		.collect()
}

/// Each failing stage body in the first, middle and last stage, with
/// `pipefail`, and with `lastpipe` (and a `return` from the last stage):
/// the diagnostic reaches the stage's own standard error file, and the
/// statuses and `PIPESTATUS` are Bash's. The rows sleep to order the
/// stages, so they run one at a time.
#[tokio::test(flavor = "multi_thread")]
async fn an_errored_stage_writes_to_its_own_stderr_and_ends_with_its_status() {
	assert_rows(errored_stage_rows(false), 1).await;
}

/// The same failing stages first in a background pipeline: the diagnostic
/// reaches the stage's file, and the job is one record per process, as in
/// Bash: `jobs -p` names the first stage, which has ended (`kill` of it
/// fails, `wait %1` gets its status under `pipefail`), and `jobs -l` lists
/// each process with its own state (`Exit 1`, then `Done`).
#[tokio::test(flavor = "multi_thread")]
async fn errored_stage_in_a_background_pipeline_is_listed_per_process() {
	assert_rows(errored_stage_rows(true), 1).await;
}

/// `exec 2>&-` or `exec 2>/dev/full`, then a failure that prints a
/// diagnostic: the lost write does not end the shell, and the failure's
/// own status (127 for a fatal expansion error in a `-c` string) stays.
#[tokio::test(flavor = "multi_thread")]
async fn a_diagnostic_to_a_closed_or_failing_stderr_is_not_fatal() {
	assert_rows(rows(FIXTURE, "a_diagnostic_to_a_closed_or_failing_stderr_is_not_fatal"), 4).await;
}

/// Each builtin's failure with standard error discarded, closed or full:
/// the status is Bash's whatever happens to the message.
#[tokio::test(flavor = "multi_thread")]
async fn each_builtin_fails_as_bash_does_on_a_closed_or_full_stderr() {
	assert_rows(rows(FIXTURE, "each_builtin_fails_as_bash_does_on_a_closed_or_full_stderr"), 4)
		.await;
}
