//! The report Bash 5.3 prints on standard error for a job or command a
//! signal ended (`notify_of_job_status`), and the job table around it,
//! through the session API (`Shell::run`, what pi-natives' shell calls).
//!
//! Each row is one script (or several tool calls on one shell) and what
//! `bash -c` 5.3.20 prints for it: `tests/fixtures/signal_death_report.json`
//! (see `bash_oracle` for the oracle rule and `PI_SHELL_BASH_ORACLE`). The
//! report lines keep Bash's `bash: line N: ` prefix, which this shell
//! prints before every diagnostic, so the rows compare its line.
//!
//! The background rows are every signal (HUP INT QUIT ABRT KILL SEGV PIPE
//! TERM USR1 ALRM) in every scenario (reported after the next foreground
//! command, at the next line, by `wait %1` and `wait -n` on the same and on
//! the next line, by `jobs` on the same and on the next line, trapped by
//! the shell, disowned) for a program, a job the shell runs itself (the
//! `sleep` builtin, a program in Bash) and a pipeline. A program sent INT
//! or QUIT resets them to their default first: a background job starts with
//! both ignored.

mod bash_oracle;

use bash_oracle::{assert_rows, rows};

const FIXTURE: &str = "signal_death_report.json";

/// A program run in the background that a signal ended is reported once, at
/// the next notify point (a line read, `wait`, `jobs`), with its pid, the
/// signal's text and its command, then forgotten (`wait %1` finds no job,
/// `wait $!` its saved status). INT and PIPE are reported by no line, TERM
/// and a signal the shell traps neither, but those jobs stay for `wait` and
/// `jobs`. Fails if a report is missing, early, repeated or lands at the
/// wrong point, or if the job outlives it.
#[tokio::test(flavor = "multi_thread")]
async fn a_background_program_a_signal_ends_is_reported_at_bash_notify_points() {
	assert_rows(rows(FIXTURE, "background_external"), 16).await;
}

/// A background job the shell runs itself (the `sleep` builtin) that a
/// signal ends is reported as the program Bash runs would be, `(core
/// dumped)` included where this host writes a core for a process. Fails if
/// such a job dies silently or reports differently from a program.
#[tokio::test(flavor = "multi_thread")]
async fn a_background_job_run_in_the_shell_reports_as_a_program_would() {
	assert_rows(rows(FIXTURE, "background_in_shell"), 16).await;
}

/// A background pipeline whose last stage a signal ended is reported with
/// one line per stage, each with its pid and status; `$!` is the last
/// stage's pid. Fails if the report lists the job as one process, or comes
/// at another point than for a lone program.
#[tokio::test(flavor = "multi_thread")]
async fn a_background_pipeline_reports_each_stage() {
	assert_rows(rows(FIXTURE, "background_pipeline"), 16).await;
}

/// A foreground command, subshell or pipeline a signal ended is reported
/// when the wait for it ends, on the shell's standard error (past the
/// command's own redirections); not for the command `bash -c` runs in its
/// own place (the last of the string), nor in a command substitution, nor
/// for INT and PIPE; TERM and a trapped signal print `jobs`' short form.
/// Fails on a missing, extra or misplaced foreground report.
#[tokio::test(flavor = "multi_thread")]
async fn a_foreground_command_a_signal_ends_is_reported() {
	assert_rows(rows(FIXTURE, "foreground"), 16).await;
}

/// Bash 5.3's other notify points (a `$( )`, a `<( )`, a compound array
/// assignment's text, a sourced file's line, a here-document's
/// substitution) report with the line Bash names, and the statement
/// boundaries that are no notify point (`eval`, arithmetic, a function
/// call, a backquote substitution) report nothing early. A command
/// substitution reports nothing and forgets each ended job but `$!`'s.
#[tokio::test(flavor = "multi_thread")]
async fn reports_come_at_bash_5_3_notify_points() {
	assert_rows(rows(FIXTURE, "notify_points"), 16).await;
}

/// The stages of a background pipeline are processes of their own: `kill`
/// of a stage's pid reaches that stage alone and fails once it ended, `jobs
/// -l` lists each with its status, `jobs -p` the first. Fails if a stage is
/// folded into its job.
#[tokio::test(flavor = "multi_thread")]
async fn background_pipeline_stages_are_processes_of_their_own() {
	assert_rows(rows(FIXTURE, "pipeline_stages"), 16).await;
}

/// `jobs` and `jobs -l` print Bash's status text and columns for a job a
/// signal ended, and see its end at once. Fails on a stale `Running` or a
/// different column.
#[tokio::test(flavor = "multi_thread")]
async fn jobs_lists_bash_status_text() {
	assert_rows(rows(FIXTURE, "jobs_listing"), 16).await;
}

/// While a `lastpipe` pipeline's last command runs, Bash 5.3 freezes the
/// job list: the pipeline's other processes are a foreground job that
/// command can list, wait for and kill but not remove; a command it runs
/// that a signal ends stays as a job, reported at the next notify point.
/// Fails if the job is missing, removed early, or reported at the wrong
/// point.
#[tokio::test(flavor = "multi_thread")]
async fn a_lastpipe_pipeline_keeps_its_job_while_frozen() {
	assert_rows(rows(FIXTURE, "lastpipe"), 16).await;
}

/// A background job started without job control ignores SIGINT and SIGQUIT
/// (Bash's `setup_async_signals`), its programs too, unless it traps them
/// itself. Fails if such a signal ends the job.
#[tokio::test(flavor = "multi_thread")]
async fn a_background_job_ignores_sigint_and_sigquit() {
	assert_rows(rows(FIXTURE, "async_signals"), 16).await;
}

/// A job that a signal ends between two tool calls on one shell is
/// reported at the start of the next call's output; one ended by TERM stays
/// for `jobs` and `wait`. Fails if the report is lost or comes late.
#[tokio::test(flavor = "multi_thread")]
async fn a_job_that_ends_between_tool_calls_is_reported_in_the_next() {
	assert_rows(rows(FIXTURE, "next_run"), 16).await;
}
