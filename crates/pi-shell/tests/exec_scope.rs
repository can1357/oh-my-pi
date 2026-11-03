//! How long an `exec` without a command keeps its redirections, and where a
//! builtin's own diagnostic goes, through `pi_shell::Shell::run`.
//!
//! Bash keeps the redirections of `exec` reached directly or through
//! `command` for the rest of the shell, and undoes them when the command
//! ends once `builtin` is anywhere in the wrapper chain (`builtin exec 2>f`,
//! `command builtin exec 2>f`), as for any other builtin. A diagnostic of
//! the command (`builtin -x exec 2>/dev/null`, `builtin exec` with `exec`
//! disabled) goes to the standard error its redirections set up.
//!
//! Each row's expected output is Bash 5.3.20 running the script as
//! `bash -c` (the oracle rule and `PI_SHELL_BASH_ORACLE` are in
//! `bash_oracle`); the rows are in `fixtures/exec_scope.json`.
#![cfg(target_os = "linux")]

mod bash_oracle;

use bash_oracle::{assert_rows, rows};

const FIXTURE: &str = "exec_scope.json";

/// Rows that do not wait on time: many run at once.
const PARALLEL: usize = 16;

/// Every chain of `builtin` and `command` wrappers (each option spelling
/// they accept) in front of `exec 2>/dev/null`: the change lasts only
/// without `builtin` in the chain, in the script and inside `{ …; } 2>&1`;
/// the diagnostics of a missing `-a` argument, an invalid option and a
/// disabled `exec` go to the redirected standard error; the describing
/// `command -v`/`-V` forms run nothing.
#[tokio::test(flavor = "multi_thread")]
async fn exec_keeps_its_redirections_only_without_builtin_in_the_chain() {
	assert_rows(rows(FIXTURE, "exec_through_wrappers_follows_bash"), PARALLEL).await;
}

/// `exec` with each option (`-c`, `-l`, `-a name`, bundled and repeated,
/// `--`), reached through each wrapper chain: the redirections stay or end
/// as for a bare `exec`, and an option error prints Bash's usage text to the
/// command's standard error with status 2.
#[tokio::test(flavor = "multi_thread")]
async fn exec_parses_its_options_as_bash_does() {
	assert_rows(rows(FIXTURE, "exec_parses_its_options_as_bash_does"), PARALLEL).await;
}

/// Each spelling of `exec` with only redirections, inside each command
/// whose redirections Bash undoes when it ends (group, function call and
/// definition, `if`, `while`, `eval`, subshell), changing the descriptor
/// that command redirects (the change ends with the command) or another one
/// (the change stays, unless `exec` came through `builtin`).
#[tokio::test(flavor = "multi_thread")]
async fn exec_changes_last_as_long_as_bash_keeps_them() {
	assert_rows(rows(FIXTURE, "exec_changes_last_as_long_as_bash_keeps_them"), PARALLEL).await;
}

/// Each `exec` form, across the commands and lines of one run, in a
/// function (the shell's own descriptors) and in a subshell (only the
/// subshell's), and an external started after it.
#[tokio::test(flavor = "multi_thread")]
async fn exec_redirections_persist_for_later_commands() {
	assert_rows(rows(FIXTURE, "exec_redirections"), PARALLEL).await;
}
