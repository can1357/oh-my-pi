//! A stage of a multi-command pipeline runs in a subshell: an error in it, or
//! an `exit`, `return`, `break` or `continue`, ends that stage alone. The
//! stage exits with the error's status, the other stages run to completion,
//! and the commands after the pipeline still run. A word that fails to expand
//! in the current shell ends the command line, inside a function as outside
//! one. Each row's expected standard output, diagnostic and exit status is
//! GNU Bash 5.2.21's for the same script read from a file. (`bash -c` reports
//! 127, not 1, for a stage that ends at `${v:?}`, an unset variable under
//! `set -u`, or a bad substitution; every other status here is the same in
//! both.)
#![cfg(unix)]

use std::{collections::BTreeSet, fs};

use bytes::Bytes;
use pi_shell::{
	cancel::CancelToken,
	shell::{Shell, ShellExecuteOptions, ShellRunOptions, StreamSinks, execute_shell_streams},
};

/// The command that ends most rows: the status of the line so far and of
/// each stage of the pipeline before it.
const PARENT: &str = "printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"";

/// A function whose body fails to expand a word before it prints anything.
const F: &str = "f() { : \"$((1/0))\"; printf STAGE_AFTER; }";

/// Standard output, whether anything reached standard error, and the exit
/// status of `script`, run in a fresh shell the way the bash tool runs a
/// command, in an empty working directory.
async fn run(script: &str) -> (String, bool, Option<i32>) {
	let (stdout, stderr, status) = run_streams(script).await;
	(stdout, !stderr.is_empty(), status)
}

/// Standard output, standard error and the exit status of `script`, run as
/// [`run`] runs it. What the shell writes anywhere else (the host process's
/// own standard error) is in neither.
async fn run_streams(script: &str) -> (String, String, Option<i32>) {
	let dir = tempfile::tempdir().expect("working directory");
	let (stdout_tx, stdout_rx) = flume::unbounded::<Bytes>();
	let (stderr_tx, stderr_rx) = flume::unbounded::<Bytes>();
	let result = execute_shell_streams(
		ShellExecuteOptions {
			command: script.to_owned(),
			cwd: Some(dir.path().to_string_lossy().into_owned()),
			timeout_ms: Some(30_000),
			..Default::default()
		},
		StreamSinks { stdout: Some(stdout_tx), stderr: Some(stderr_tx) },
		CancelToken::new(None),
	)
	.await
	.unwrap_or_else(|error| panic!("{script}: {error}"));
	let collect = |rx: flume::Receiver<Bytes>| {
		let bytes: Vec<u8> = rx.drain().flat_map(|chunk| chunk.to_vec()).collect();
		String::from_utf8(bytes).expect("UTF-8 output")
	};
	(collect(stdout_rx), collect(stderr_rx), result.exit_code)
}

/// Runs every `(script, Bash's standard output, whether Bash wrote a
/// diagnostic, Bash's exit status)` row and fails listing each row that
/// differs.
async fn assert_bash(rows: &[(&str, &str, bool, i32)]) {
	let mut differing = Vec::new();
	for &(script, stdout, diagnostic, status) in rows {
		let expected = (stdout.to_owned(), diagnostic, Some(status));
		let observed = run(script).await;
		if observed != expected {
			differing.push(format!("{script}\n  Bash:     {expected:?}\n  observed: {observed:?}"));
		}
	}
	assert!(
		differing.is_empty(),
		"{} of {} rows differ from Bash 5.2.21:\n{}",
		differing.len(),
		rows.len(),
		differing.join("\n")
	);
}

/// Each class of expansion error, in the first, a middle and the last stage.
/// It had ended the whole command line: no later stage ran, nothing after the
/// pipeline ran, and the line exited 1.
#[tokio::test]
async fn an_expansion_error_ends_only_its_stage() {
	assert_bash(&[
		(
			": \"${missing:?BOOM}\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			": | : \"${missing:?BOOM}\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			": | : \"${missing:?BOOM}\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			"set -u; : \"$missing\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			"set -u; : | : \"$missing\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			"set -u; : | : \"$missing\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			"v='a b'; : \"${!v}\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			"v='a b'; : | : \"${!v}\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			"v='a b'; : | : \"${!v}\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			": \"$((1/0))\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			": | : \"$((1/0))\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			": | : \"$((1/0))\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			": \"$((1+))\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			": | : \"$((1+))\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			": | : \"$((1+))\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
	])
	.await;
}

/// The same error in every other kind of stage: an external command, an
/// assignment, a brace group, a function call, `[[ ]]`, `for`, `case`,
/// `while`, and an arithmetic command that divides by zero.
#[tokio::test]
async fn every_kind_of_stage_ends_alone_at_an_error() {
	assert_bash(&[
		(
			"/bin/echo \"${missing:?BOOM}\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			": | /bin/echo \"${missing:?BOOM}\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \
			 \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			": | /bin/echo \"${missing:?BOOM}\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			"v=\"${missing:?BOOM}\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			": | v=\"${missing:?BOOM}\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			": | v=\"${missing:?BOOM}\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			"{ : \"${missing:?BOOM}\"; } | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			": | { : \"${missing:?BOOM}\"; } | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			": | { : \"${missing:?BOOM}\"; }; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			"f() { : \"${missing:?BOOM}\"; }; f | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \
			 \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			"f() { : \"${missing:?BOOM}\"; }; : | f | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \
			 \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			"f() { : \"${missing:?BOOM}\"; }; : | f; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			"[[ -n \"${missing:?BOOM}\" ]] | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			": | [[ -n \"${missing:?BOOM}\" ]] | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \
			 \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			": | [[ -n \"${missing:?BOOM}\" ]]; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			"for i in \"${missing:?BOOM}\"; do :; done | /bin/cat; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			": | for i in \"${missing:?BOOM}\"; do :; done | /bin/cat; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			": | for i in \"${missing:?BOOM}\"; do :; done; printf 'PARENT=%s PIPESTATUS=%s\\n' \
			 \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			"case \"${missing:?BOOM}\" in *) ;; esac | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \
			 \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			": | case \"${missing:?BOOM}\" in *) ;; esac | /bin/cat; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			": | case \"${missing:?BOOM}\" in *) ;; esac; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			"while : \"${missing:?BOOM}\"; do :; done | /bin/cat; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			": | while : \"${missing:?BOOM}\"; do :; done | /bin/cat; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			": | while : \"${missing:?BOOM}\"; do :; done; printf 'PARENT=%s PIPESTATUS=%s\\n' \
			 \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			"(( 1/0 )) | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			": | (( 1/0 )) | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			": | (( 1/0 )); printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
	])
	.await;
}

/// `pipefail`, `errexit`, `!`, `||` and the ERR trap act on the status the
/// failed stage exits with, as on any other failed stage.
#[tokio::test]
async fn pipeline_options_see_the_failed_stage_status() {
	assert_bash(&[
		(
			"set -o pipefail; : \"${missing:?BOOM}\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \
			 \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			"set -o pipefail; : | : \"${missing:?BOOM}\" | /bin/cat; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			"set -o pipefail; : | : \"${missing:?BOOM}\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			"set -e; : \"${missing:?BOOM}\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			"set -e; : | : \"${missing:?BOOM}\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \
			 \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			"! : \"${missing:?BOOM}\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			"! : | : \"${missing:?BOOM}\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			": | : \"${missing:?BOOM}\" || printf 'OR=%s\\n' \"$?\"; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"OR=1\nPARENT=0 PIPESTATUS=0\n",
			true,
			0,
		),
		(
			"trap 'printf \"TRAP=%s\\n\" \"$?\"' ERR; : | : \"${missing:?BOOM}\"; printf \
			 'PARENT=%s\\n' \"$?\"",
			"TRAP=1\nPARENT=1\n",
			true,
			0,
		),
	])
	.await;
}

/// `exit`, `return`, `break` and `continue` in the last stage end that stage
/// only. `exit` had ended the command line, and the others had returned from
/// the enclosing function or left the enclosing loop.
#[tokio::test]
async fn a_stage_cannot_leave_the_shell_a_function_or_a_loop() {
	assert_bash(&[
		(
			": | exit 3; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=3 PIPESTATUS=0 3\n",
			false,
			0,
		),
		(
			": | { exit 3; }; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=3 PIPESTATUS=0 3\n",
			false,
			0,
		),
		(
			"f() { exit 3; }; : | f; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=3 PIPESTATUS=0 3\n",
			false,
			0,
		),
		(
			"f() { : | return 4; printf 'INF=%s\\n' \"$?\"; }; f; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"INF=4\nPARENT=0 PIPESTATUS=0\n",
			false,
			0,
		),
		(
			"for i in 1 2; do : | break; printf 'I=%s\\n' \"$i\"; done; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"I=1\nI=2\nPARENT=0 PIPESTATUS=0\n",
			false,
			0,
		),
		(
			"for i in 1 2; do : | continue; printf 'I=%s\\n' \"$i\"; done; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"I=1\nI=2\nPARENT=0 PIPESTATUS=0\n",
			false,
			0,
		),
	])
	.await;
}

/// A stage reports its error where its standard error goes at that moment:
/// a word fails to expand before the command's own redirections are made,
/// while a group, loop, `[[ ]]` or function body fails inside its own.
#[tokio::test]
async fn a_stage_reports_its_error_on_its_own_standard_error() {
	assert_bash(&[
		(
			": \"${missing:?BOOM}\" 2>/dev/null | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \
			 \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			"2>/dev/null : \"${missing:?BOOM}\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \
			 \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			"{ : \"${missing:?BOOM}\"; } 2>/dev/null | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \
			 \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			false,
			0,
		),
		(
			"f() { : \"${missing:?BOOM}\"; }; f 2>/dev/null | /bin/cat; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			false,
			0,
		),
		(
			"f() { : \"${missing:?BOOM}\"; } 2>/dev/null; f | /bin/cat; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			false,
			0,
		),
		(
			"[[ -n \"${missing:?BOOM}\" ]] 2>/dev/null | /bin/cat; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			false,
			0,
		),
		(
			"for i in \"${missing:?BOOM}\"; do :; done 2>/dev/null | /bin/cat; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			false,
			0,
		),
		// The group stops at the error: its next command does not run.
		(
			"{ : \"${missing:?BOOM}\"; printf 'NO=reached\\n' >&2; } | /bin/cat; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
	])
	.await;
}

/// The stages after the failed one still run, the stages before it are
/// still waited for, an inner pipeline's failure stays inside its stage, and
/// the next line runs.
#[tokio::test]
async fn the_other_stages_and_the_next_commands_still_run() {
	assert_bash(&[
		(
			": | : \"${missing:?BOOM}\" | { /bin/cat; printf 'AFTER=ran\\n'; }; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"AFTER=ran\nPARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			"{ sleep 0.3; printf 'UP=done\\n' >up.txt; } | : \"${missing:?BOOM}\" | /bin/cat; printf \
			 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"; /bin/cat up.txt",
			"PARENT=0 PIPESTATUS=0 1 0\nUP=done\n",
			true,
			0,
		),
		(
			"{ : \"${missing:?BOOM}\" | /bin/cat; printf 'INNER=%s\\n' \"$?\"; } | /bin/cat; printf \
			 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"INNER=0\nPARENT=0 PIPESTATUS=0 0\n",
			true,
			0,
		),
		(
			": \"${missing:?BOOM}\" | /bin/cat\nprintf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
	])
	.await;
}

/// A builtin stage that fails with an error rather than a status (here a
/// write to a closed standard output) ends alone, reported on the builtin's
/// own standard error.
#[tokio::test]
async fn a_builtin_stage_that_fails_with_an_error_ends_alone() {
	assert_bash(&[
		(
			"printf 'X\\n' >&- | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			": | printf 'X\\n' >&-; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			"printf 'X\\n' >&- 2>/dev/null | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			false,
			0,
		),
	])
	.await;
}

/// What is not a stage's own subshell keeps ending the command line: a
/// lone command, the last stage under `lastpipe` (it runs in the current
/// shell), and `errexit` acting on the pipeline's failure. An explicit
/// `( )` subshell and a failed redirection already ended their stage alone.
#[tokio::test]
async fn an_error_outside_a_stage_subshell_still_ends_the_command_line() {
	assert_bash(&[
		(
			": \"${missing:?BOOM}\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"",
			true,
			1,
		),
		(
			"set -u; : \"$missing\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"",
			true,
			1,
		),
		(
			": \"$((1/0))\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"",
			true,
			1,
		),
		(
			"shopt -s lastpipe; : | : \"${missing:?BOOM}\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \
			 \"$?\" \"${PIPESTATUS[*]}\"",
			"",
			true,
			1,
		),
		(
			"set -u; shopt -s lastpipe; : | : \"$missing\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \
			 \"$?\" \"${PIPESTATUS[*]}\"",
			"",
			true,
			1,
		),
		(
			"shopt -s lastpipe; : | : \"$((1/0))\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"",
			true,
			1,
		),
		(
			"v='a b'; shopt -s lastpipe; : | : \"${!v}\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"",
			true,
			1,
		),
		(
			"shopt -s lastpipe; : | exit 3; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"",
			false,
			3,
		),
		(
			"f() { shopt -s lastpipe; : | return 4; printf 'INF=%s\\n' \"$?\"; }; f; printf \
			 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=4 PIPESTATUS=4\n",
			false,
			0,
		),
		(
			"set -e; : | : \"${missing:?BOOM}\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"",
			true,
			1,
		),
		(
			"set -e -o pipefail; : \"${missing:?BOOM}\" | /bin/cat; printf 'PARENT=%s \
			 PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"",
			true,
			1,
		),
		(
			"( : \"${missing:?BOOM}\" ) | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			": | ( : \"${missing:?BOOM}\" ); printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			": >\"${missing:?BOOM}\" | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			": | : >\"${missing:?BOOM}\"; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \
			 \"${PIPESTATUS[*]}\"",
			"PARENT=1 PIPESTATUS=0 1\n",
			true,
			0,
		),
		(
			"exit 3 | /bin/cat; printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
			"PARENT=0 PIPESTATUS=3 0\n",
			false,
			0,
		),
	])
	.await;
}

/// A word that fails to expand inside a function body ends the command line
/// the call is on, as it does outside a function, and as in Bash: the call is
/// not one command that failed, so neither the rest of the body, `||`, an
/// enclosing function nor the rest of the line runs. The same holds for a
/// function run as the last stage under `lastpipe`, with or without
/// `pipefail`, since that stage runs in the current shell. The next line, an
/// `eval`, and a subshell (`( )`, a command substitution, a background job, a
/// pipeline stage) still go on, and the error is reported where it happens.
/// Before, the call failed with status 1 and the line went on.
#[tokio::test]
async fn an_expansion_error_in_a_function_ends_the_command_line() {
	let mut rows: Vec<(String, &str, bool, i32)> = Vec::new();
	for error in ["$((1/0))", "$((1+))", "${!v}", "${missing:?BOOM}"] {
		for pipefail in ["", "set -o pipefail; "] {
			rows.push((
				format!(
					"v='a b'; {pipefail}shopt -s lastpipe; f() {{ : \"{error}\"; printf STAGE_AFTER; \
					 }}; : | f; {PARENT}"
				),
				"",
				true,
				1,
			));
		}
	}
	rows.extend([
		(format!("{F}; f; {PARENT}"), "", true, 1),
		(format!("{F}; g() {{ f; printf G; }}; g; {PARENT}"), "", true, 1),
		(format!("{F}; f || printf OR; {PARENT}"), "", true, 1),
		(format!("{F}\nf\nprintf 'NEXT=%s\\n' \"$?\""), "NEXT=1\n", true, 0),
		(format!("{F}; eval f; printf 'AFTER=%s\\n' \"$?\""), "AFTER=1\n", true, 0),
		(format!("{F}; ( f; printf SUB ); printf 'AFTER=%s\\n' \"$?\""), "AFTER=1\n", true, 0),
		(format!("{F}; x=$(f); printf 'AFTER=%s X=%s\\n' \"$?\" \"$x\""), "AFTER=1 X=\n", true, 0),
		(format!("{F}; f & wait; printf 'AFTER=%s\\n' \"$?\""), "AFTER=0\n", true, 0),
		(format!("{F}; f | /bin/cat; {PARENT}"), "PARENT=0 PIPESTATUS=1 0\n", true, 0),
		// Reported on the standard error in effect inside the body: a group's,
		// the call's own (also as the `lastpipe` stage), the definition's.
		(
			"f() { : \"$((1/0))\"; }\n{ f; } 2>diag\nif [ -s diag ]; then printf 'DIAG=yes\\n'; fi"
				.to_owned(),
			"DIAG=yes\n",
			false,
			0,
		),
		(
			"shopt -s lastpipe; f() { : \"$((1/0))\"; }\n: | f 2>diag\nif [ -s diag ]; then printf \
			 'DIAG=yes\\n'; fi"
				.to_owned(),
			"DIAG=yes\n",
			false,
			0,
		),
		(
			"f() { : \"$((1/0))\"; } 2>diag\nf\nif [ -s diag ]; then printf 'DIAG=yes\\n'; fi"
				.to_owned(),
			"DIAG=yes\n",
			false,
			0,
		),
	]);
	let rows: Vec<(&str, &str, bool, i32)> = rows
		.iter()
		.map(|(script, stdout, diagnostic, status)| (script.as_str(), *stdout, *diagnostic, *status))
		.collect();
	assert_bash(&rows).await;
}

/// What an earlier stage records before it sleeps: the process identifier of
/// the shell it starts, and the pipe that shell writes to (`pipe:[inode]`).
const RECORD: &str = "echo $$ >>pids; readlink /proc/$$/fd/1 >>pipes";

/// Whether process `pid` is still a child of this test process, running or
/// exited and not yet reaped.
fn is_child(pid: &str) -> bool {
	// `/proc/<pid>/stat` reads `pid (comm) state ppid …`; comm may hold spaces.
	let parent = std::process::id().to_string();
	fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
		stat
			.rsplit_once(')')
			.and_then(|(_, rest)| rest.split_whitespace().nth(1))
			.is_some_and(|ppid| ppid == parent)
	})
}

/// The number of descriptors this test process holds on one of `pipes`.
fn descriptors_on(pipes: &BTreeSet<String>) -> usize {
	fs::read_dir("/proc/self/fd")
		.expect("descriptors")
		.filter_map(|fd| fs::read_link(fd.ok()?.path()).ok())
		.filter(|target| pipes.contains(target.to_string_lossy().as_ref()))
		.count()
}

/// When the last stage, which `lastpipe` runs in the current shell, ends the
/// line with an error, a persistent shell's run returns only once the stages
/// before it have finished: nothing it started is still running, holding a
/// descriptor or about to start a process. The earlier stage finishes its
/// work as it does in Bash, where it outlives the shell. Before, the run
/// returned at once while the earlier stage went on, so it wrote its file and
/// started processes after the run had returned. Each earlier stage records
/// the process it starts and the pipe it writes to, and only those are
/// checked: tests that `cargo test` runs on other threads of this process
/// start processes and open pipes of their own meanwhile.
#[tokio::test]
async fn a_failed_lastpipe_stage_returns_after_the_stages_before_it() {
	let dir = tempfile::tempdir().expect("working directory");
	let cwd = dir.path().to_string_lossy().into_owned();
	let shell = Shell::new(None);
	let run = async |command: &str| {
		shell
			.run(
				ShellRunOptions {
					command: command.to_owned(),
					cwd: Some(cwd.clone()),
					..Default::default()
				},
				None,
				CancelToken::new(None),
			)
			.await
			.unwrap_or_else(|error| panic!("{command}: {error}"))
			.exit_code
	};
	let read = |file: &str| fs::read_to_string(dir.path().join(file)).unwrap_or_default();
	run(":").await;
	let group = format!("{{ /bin/sh -c '{RECORD}; exec /bin/sleep 0.3'; printf done >marker; }}");
	let external = format!("/bin/sh -c '{RECORD}; /bin/sleep 0.3; printf done >marker'");
	let mut differing = Vec::new();
	for (stage, last) in [
		(&group, ": \"${missing:?BOOM}\""),
		(&external, ": \"${missing:?BOOM}\""),
		(&group, ": \"$((1/0))\""),
		(&group, "f"),
	] {
		for file in ["marker", "pids", "pipes"] {
			let _ = fs::remove_file(dir.path().join(file));
		}
		let script =
			format!("shopt -s lastpipe; f() {{ : \"$((1/0))\"; }}; {stage} | {last}; {PARENT}");
		let status = run(&script).await;
		let pids = read("pids");
		let pipes: BTreeSet<String> = read("pipes").lines().map(str::to_owned).collect();
		let observed = (
			status,
			read("marker"),
			!pids.is_empty() && !pids.split_whitespace().any(is_child),
			!pipes.is_empty() && descriptors_on(&pipes) == 0,
		);
		if observed != (Some(1), "done".to_owned(), true, true) {
			differing.push(format!(
				"{script}\n  (status, marker, its process gone, its pipe closed): {observed:?}"
			));
		}
	}
	assert!(differing.is_empty(), "{}", differing.join("\n"));
}

/// `compgen` runs its completion function, command and word list with its
/// own standard streams, as Bash does: what they write and the errors they
/// report go to `compgen`'s `2>diag`, never to the host process's own
/// standard error. A word that fails to expand in the completion function or
/// in `-W` ends `compgen`'s command line, as it would anywhere else, and the
/// error is reported once: through `command compgen`, which wraps `compgen`'s
/// error as its own, and in a pipeline stage, whose subshell ends at it.
/// Before, the completion function ran with the shell's default streams (in
/// the bash tool, the host's standard error got the error and `2>diag` stayed
/// empty), its error became status 1 and the line went on, and a `-W` error
/// failed only `compgen`.
#[tokio::test]
async fn compgen_runs_its_function_command_and_words_on_its_own_streams() {
	const BAD: &str = "f() { : \"$((1/0))\"; printf BAD; }";
	let count = |pattern: &str| format!("printf 'N=%s\\n' \"$(grep -c {pattern} diag)\"");
	let errors = count("division");
	let after = "printf 'AFTER=%s\\n' \"$?\"";
	let rows: Vec<(String, &str, bool, i32)> = vec![
		(format!("{BAD}\ncompgen -F f -- word 2>diag; printf AFTER\n{errors}"), "N=1\n", false, 0),
		(
			format!("{BAD}\ncommand compgen -F f -- word 2>diag; printf AFTER\n{errors}"),
			"N=1\n",
			false,
			0,
		),
		(
			format!("{BAD}\ncompgen -F f -- word 2>diag | cat; {after}\n{errors}"),
			"AFTER=0\nN=1\n",
			false,
			0,
		),
		(
			format!("{BAD}\nx=$(compgen -F f -- word 2>diag); {after}\n{errors}"),
			"AFTER=1\nN=1\n",
			false,
			0,
		),
		(format!("compgen -W '$((1/0))' -- x 2>diag; printf AFTER\n{errors}"), "N=1\n", false, 0),
		(
			format!("compgen -W '$(echo WERR >&2; echo xa)' -- x 2>diag; {after}\n{}", count("WERR")),
			"xa\nAFTER=0\nN=1\n",
			false,
			0,
		),
		(
			format!("compgen -C 'echo CERR >&2' -- x 2>diag; {after}\n{}", count("CERR")),
			"AFTER=1\nN=1\n",
			false,
			0,
		),
		(
			format!(
				"f() {{ echo FERR >&2; COMPREPLY=(a); }}; compgen -F f -- word 2>diag; {after}\n{}",
				count("FERR")
			),
			"a\nAFTER=0\nN=1\n",
			false,
			0,
		),
	];
	let rows: Vec<(&str, &str, bool, i32)> = rows
		.iter()
		.map(|(script, stdout, diagnostic, status)| (script.as_str(), *stdout, *diagnostic, *status))
		.collect();
	assert_bash(&rows).await;
}

/// `PS4` is expanded with the standard streams of the command it traces and
/// with `set -x` off, as Bash does (`indirection_level_string` in
/// print_cmd.c): what a command substitution in it writes reaches the run's
/// standard error once before each trace line, and the substitution's own
/// commands are not traced. Before, `set -x` stayed on inside the
/// substitution, so tracing each of its commands expanded `PS4` again,
/// without end (megabytes of `+`; through the addon, a run that timed out);
/// and before that, `PS4` was expanded with the shell's default streams, so
/// in the bash tool its output went to the host process's own standard error.
#[tokio::test]
async fn ps4_is_expanded_untraced_with_the_traced_command_streams() {
	for (script, stderr) in [
		("PS4='$(printf PS4OUT >&2)+ '; set -x; :; set +x", "PS4OUT+ :\nPS4OUT+ set +x\n"),
		(
			"PS4='$(printf PS4OUT >&2)+ '; set -x; f() { :; }; f; set +x",
			"PS4OUT+ f\nPS4OUT+ :\nPS4OUT+ set +x\n",
		),
		(
			"PS4='$([[ $- == *x* ]] && printf X >&2 || printf NOX >&2)+ '; set -x; :; set +x",
			"NOX+ :\nNOX+ set +x\n",
		),
	] {
		let observed = run_streams(script).await;
		assert_eq!(observed, (String::new(), stderr.to_owned(), Some(0)), "{script}");
	}
}

/// A word that fails to expand ends the command line wherever the word is,
/// not only in a simple command: a `for` word list, a `case` word, a `[[ ]]`
/// operand (also an arithmetic one), an `(( ))` or `for (( ))` expression,
/// and the target of a redirection made by a group, a function definition, a
/// here-string or a here-document, as in Bash. Inside a function the call
/// does not fail like one command: the rest of the line is discarded. The
/// error is reported where it happens (the function definition's
/// `2>/dev/null` silences it), a pipeline stage still ends alone, and a
/// redirection of an external command still fails only that command, as
/// Bash's child makes it. Before, the error left the function as an
/// ordinary error, the call failed with status 1 and the line went on, and a
/// target that failed to expand on a closed standard error printed `I/O write
/// error: standard error not available`.
#[tokio::test]
async fn an_expansion_error_in_any_word_ends_the_command_line() {
	let after = "printf 'AFTER=%s\\n' \"$?\"";
	let rows: Vec<(String, &str, bool, i32)> = vec![
		(format!("f() {{ for x in $((1/0)); do :; done; printf IN; }}; f; {after}"), "", true, 1),
		(format!("f() {{ case $((1/0)) in *) ;; esac; printf IN; }}; f; {after}"), "", true, 1),
		(format!("f() {{ [[ $((1/0)) == a ]]; printf IN; }}; f; {after}"), "", true, 1),
		(format!("f() {{ [[ -n \"${{missing:?BOOM}}\" ]]; printf IN; }}; f; {after}"), "", true, 1),
		(format!("f() {{ [[ $((1/0)) -eq 1 ]]; printf IN; }}; f; {after}"), "", true, 1),
		(format!("f() {{ (( ${{missing:?BOOM}} )); printf IN; }}; f; {after}"), "", true, 1),
		(
			// `; i<1; i++`, not `;;`: the parser takes `;;` inside `for ((` for
			// the `case` terminator (a separate defect, on main too).
			format!(
				"f() {{ for ((i=${{missing:?BOOM}}; i<1; i++)); do :; done; printf IN; }}; f; {after}"
			),
			"",
			true,
			1,
		),
		(format!("f() {{ {{ :; }} >\"${{missing:?BOOM}}\"; printf IN; }}; f; {after}"), "", true, 1),
		(format!("f() {{ :; }} >\"${{missing:?BOOM}}\"; f; {after}"), "", true, 1),
		(format!("{{ cat; }} <<<\"${{missing:?BOOM}}\"; {after}"), "", true, 1),
		(format!("{{ cat; }} <<EOF\n${{missing:?BOOM}}\nEOF\n{after}"), "", true, 1),
		(format!("f() {{ for x in $((1/0)); do :; done; }} 2>/dev/null; f; {after}"), "", false, 1),
		(
			format!("{{ for x in $((1/0)); do :; done; printf IN; }} | cat; {after}"),
			"AFTER=0\n",
			true,
			0,
		),
		(
			format!(": 2>&- >\"${{missing:?BOOM}}\" | cat; {PARENT}"),
			"PARENT=0 PIPESTATUS=1 0\n",
			false,
			0,
		),
		(format!("/bin/true >\"${{missing:?BOOM}}\"; {after}"), "AFTER=1\n", true, 0),
		(
			format!("f() {{ /bin/cat <<<\"${{missing:?BOOM}}\"; printf IN; }}; f; {after}"),
			"INAFTER=0\n",
			true,
			0,
		),
	];
	let rows: Vec<(&str, &str, bool, i32)> = rows
		.iter()
		.map(|(script, stdout, diagnostic, status)| (script.as_str(), *stdout, *diagnostic, *status))
		.collect();
	assert_bash(&rows).await;
}

/// Under `set -e`, an error Bash reports through `report_error` (error.c)
/// exits the shell where it is reported, with `$?` as its status, or 1 when
/// `$?` is 0: even in an `if` or `while` condition, after `!`, and before
/// `&&` or `||`, since `report_error` reads the shell's `-e` setting, not the
/// command's context. That is every word that fails to expand but an
/// arithmetic evaluation error, which Bash reports through `internal_error`
/// and which only discards the line. Only `eval`, `source` and `command` run
/// where their status is ignored turn `-e` off for what they run
/// (`execute_builtin` in execute_cmd.c); `builtin eval` does not. A subshell
/// (a pipeline stage, `( )`) ends alone, and a command substitution, which
/// does not inherit `-e`, discards its line. Before, such an error in a
/// function or a compound command's own words discarded the line and the
/// next line ran, and one in a simple command did the same outside a
/// function.
#[tokio::test]
async fn errexit_ends_the_shell_at_an_error_bash_reports_through_report_error() {
	let v = "set -e; v='a b';";
	let f = "f() { : \"${!v}\"; printf IN; };";
	let after = "printf SAME\nprintf 'NEXT=%s' \"$?\"";
	let rows: Vec<(String, &str, bool, i32)> = vec![
		(format!("{v} : \"${{!v}}\"; printf SAME\nprintf NEXT"), "", true, 1),
		(
			format!("{v} f() {{ for x in \"${{!v}}\"; do :; done; printf IN; }}; f\nprintf NEXT"),
			"",
			true,
			1,
		),
		(format!("{v} {f} if f; then printf THEN; else printf ELSE; fi; {after}"), "", true, 1),
		(format!("{v} {f} f || printf OR; {after}"), "", true, 1),
		(format!("{v} {f} ! f; {after}"), "", true, 1),
		(format!("{v} while [[ ${{!v}} ]]; do break; done; {after}"), "", true, 1),
		(
			format!("{v} f() {{ case ${{!v}} in *) ;; esac; printf IN; }}; f && printf AND; {after}"),
			"",
			true,
			1,
		),
		(format!("{v} {{ :; }} >\"${{!v}}\" || printf OR; {after}"), "", true, 1),
		(format!("set -e; shopt -s failglob; : /nonexistent-dir-xyz/*; {after}"), "", true, 1),
		// `$?` is the status.
		(format!("{v} (exit 3) || : \"${{!v}}\"; {after}"), "", true, 3),
		// `eval`, `source` and `command` where the status is ignored: the
		// line is discarded, and the next line runs.
		(
			format!(
				"{v} if eval ': \"${{!v}}\"; printf IN'; then printf THEN; else printf ELSE; fi; \
				 {after}"
			),
			"ELSESAMENEXT=0",
			true,
			0,
		),
		(
			format!("{v} eval ': \"${{!v}}\"; printf IN' || printf OR; {after}"),
			"ORSAMENEXT=0",
			true,
			0,
		),
		(
			format!(
				"printf ': \"${{!v}}\"; printf IN\\n' >payload; {v} if . ./payload; then printf THEN; \
				 else printf ELSE; fi; {after}"
			),
			"ELSESAMENEXT=0",
			true,
			0,
		),
		(
			format!(
				"{v} if command eval ': \"${{!v}}\"; printf IN'; then printf THEN; else printf ELSE; \
				 fi; {after}"
			),
			"ELSESAMENEXT=0",
			true,
			0,
		),
		(
			format!(
				"{v} g() {{ eval ': \"${{!v}}\"; printf IN'; }}; if g; then printf THEN; else printf \
				 ELSE; fi; {after}"
			),
			"ELSESAMENEXT=0",
			true,
			0,
		),
		(
			format!(
				"{v} if builtin eval ': \"${{!v}}\"; printf IN'; then printf THEN; else printf ELSE; \
				 fi; {after}"
			),
			"",
			true,
			1,
		),
		// Subshells.
		(
			format!("{v} : \"${{!v}}\" | cat; printf 'AFTER=%s\\n' \"$?\"\nprintf NEXT"),
			"AFTER=0\nNEXT",
			true,
			0,
		),
		(
			format!("{v} ( : \"${{!v}}\"; printf IN ) || printf 'OR=%s\\n' \"$?\"\nprintf NEXT"),
			"OR=1\nNEXT",
			true,
			0,
		),
		(
			format!("{v} x=$(: \"${{!v}}\"; printf IN); printf 'X=%s\\n' \"$x\"\nprintf NEXT"),
			"",
			true,
			1,
		),
		// An arithmetic evaluation error discards the line only.
		("set -e; : $((1/0)); printf SAME\nprintf NEXT".to_owned(), "NEXT", true, 0),
		(
			"set -e; f() { : $((1/0)); printf IN; }; if f; then :; fi; printf SAME\nprintf NEXT"
				.to_owned(),
			"NEXT",
			true,
			0,
		),
		(
			"set -e; for x in $((1+)); do :; done; printf SAME\nprintf NEXT".to_owned(),
			"NEXT",
			true,
			0,
		),
		("set -e; (( $((1/0)) )); printf SAME\nprintf NEXT".to_owned(), "NEXT", true, 0),
	];
	let rows: Vec<(&str, &str, bool, i32)> = rows
		.iter()
		.map(|(script, stdout, diagnostic, status)| (script.as_str(), *stdout, *diagnostic, *status))
		.collect();
	assert_bash(&rows).await;
}

/// A required parameter (`${v:?}`) or, under `set -u`, an unset variable ends
/// a non-interactive shell wherever it is expanded, inside an arithmetic
/// expression too: a word of `(( ))`, `for (( ))`, `$(( ))` or an
/// arithmetic `[[ ]]` operand, and a bare variable name evaluated in one
/// (Bash's `expr_streval` jumps to `FORCE_EOF`, expr.c). The error is
/// reported where it happens. An arithmetic evaluation error inside a word
/// of such an expression still discards only the line. Before, the
/// arithmetic error that carried a word's failure lost whether it ended the
/// shell, and an unset variable name failed only its command.
#[tokio::test]
async fn a_fatal_expansion_error_in_arithmetic_ends_the_shell() {
	let next = "printf AFTER\nprintf NEXT";
	let rows: Vec<(String, &str, bool, i32)> = vec![
		(format!("f() {{ (( ${{missing:?BOOM}} )); printf IN; }}; f; {next}"), "", true, 1),
		(format!(": $(( ${{missing:?BOOM}} )); {next}"), "", true, 1),
		(format!("[[ ${{missing:?BOOM}} -eq 1 ]] || printf OR; {next}"), "", true, 1),
		(format!("for ((i=${{missing:?BOOM}}; i<1; i++)); do :; done; {next}"), "", true, 1),
		(format!("set -u; f() {{ (( missing )); printf IN; }}; f; {next}"), "", true, 1),
		(format!("set -u; {{ (( missing )); }} 2>diag; {next}"), "", false, 1),
		(format!("set -u; if (( missing )); then printf THEN; fi; {next}"), "", true, 1),
		(format!("set -u; let missing; {next}"), "", true, 1),
		(format!("set -u; : $(( missing )); {next}"), "", true, 1),
		(format!("set -u; [[ missing -eq 1 ]]; {next}"), "", true, 1),
		("(( $((1/0)) )); printf SAME\nprintf NEXT".to_owned(), "NEXT", true, 0),
	];
	let rows: Vec<(&str, &str, bool, i32)> = rows
		.iter()
		.map(|(script, stdout, diagnostic, status)| (script.as_str(), *stdout, *diagnostic, *status))
		.collect();
	assert_bash(&rows).await;
}

/// An error evaluating the expression of an arithmetic command fails only
/// that command, with status 1 and one diagnostic on its standard error, as
/// in Bash: `execute_arith_command`, `execute_arith_for_command` and
/// `arithcomp` see `expok == 0` and return failure (execute_cmd.c, test.c).
/// That is `(( ))`, each of the three expressions of `for (( ))` and an
/// arithmetic `[[ ]]` comparison, whose failure is a false comparison, after
/// both operand words were expanded. The rest of the line runs; `if`, `||`,
/// `!`, `while`, the ERR trap and `set -e` see a failed command. Only an
/// error expanding a word of the expression discards the line. Before, the
/// evaluation error discarded the rest of the line, or ended a function.
#[tokio::test]
async fn an_arithmetic_evaluation_error_fails_only_its_command() {
	let after = "printf 'SAME=%s\\n' \"$?\"\nprintf 'NEXT=%s\\n' \"$?\"";
	let next = "SAME=0\nNEXT=0\n";
	let rows: Vec<(String, String, bool, i32)> = vec![
		(format!("(( 1/0 )); {after}"), "SAME=1\nNEXT=0\n".to_owned(), true, 0),
		(format!("(( 1+ )); {after}"), "SAME=1\nNEXT=0\n".to_owned(), true, 0),
		(
			format!("f() {{ (( 1/0 )); printf 'IN=%s\\n' \"$?\"; }}; f; {after}"),
			format!("IN=1\n{next}"),
			true,
			0,
		),
		(
			format!("{{ (( 1/0 )); printf 'IN=%s\\n' \"$?\"; }}; {after}"),
			format!("IN=1\n{next}"),
			true,
			0,
		),
		(format!("(( 1/0 )) || printf 'OR=%s\\n' \"$?\"; {after}"), format!("OR=1\n{next}"), true, 0),
		(
			format!("if (( 1/0 )); then printf THEN; else printf 'ELSE=%s\\n' \"$?\"; fi; {after}"),
			format!("ELSE=1\n{next}"),
			true,
			0,
		),
		(format!("! (( 1/0 )); {after}"), next.to_owned(), true, 0),
		(format!("while (( 1/0 )); do :; done; {after}"), next.to_owned(), true, 0),
		(
			format!("trap 'printf ERR' ERR; (( 1/0 )); {after}"),
			"ERRSAME=1\nNEXT=0\n".to_owned(),
			true,
			0,
		),
		(
			format!("x=5; (( x = 1/0 )); printf 'X=%s ' \"$x\"; {after}"),
			"X=5 SAME=0\nNEXT=0\n".to_owned(),
			true,
			0,
		),
		(format!("{{ (( 1/0 )); }} 2>diag; {after}"), "SAME=1\nNEXT=0\n".to_owned(), false, 0),
		(
			format!("shopt -s lastpipe; : | (( 1/0 )); {after}"),
			"SAME=1\nNEXT=0\n".to_owned(),
			true,
			0,
		),
		(format!("set -e; (( 1/0 )); {after}"), String::new(), true, 1),
		(
			format!("set -e; (( 1/0 )) || printf 'OR=%s\\n' \"$?\"; {after}"),
			format!("OR=1\n{next}"),
			true,
			0,
		),
		(
			format!("for ((i=1/0; i<1; i++)); do :; done; {after}"),
			"SAME=1\nNEXT=0\n".to_owned(),
			true,
			0,
		),
		(
			format!("for ((i=0; i<1/0; i++)); do :; done; {after}"),
			"SAME=1\nNEXT=0\n".to_owned(),
			true,
			0,
		),
		(
			format!("for ((i=0; i<1; i+=1/0)); do printf BODY; done; {after}"),
			"BODYSAME=1\nNEXT=0\n".to_owned(),
			true,
			0,
		),
		(
			format!("set -e; for ((i=0; i<1/0; i++)); do :; done; {after}"),
			"SAME=1\nNEXT=0\n".to_owned(),
			true,
			0,
		),
		(format!("[[ 1 -eq 1/0 ]]; {after}"), "SAME=1\nNEXT=0\n".to_owned(), true, 0),
		(
			format!("f() {{ [[ 1 -eq 1/0 ]]; printf 'IN=%s\\n' \"$?\"; }}; f; {after}"),
			format!("IN=1\n{next}"),
			true,
			0,
		),
		(format!("[[ 1 -eq 1/0 || 1 -eq 1 ]]; {after}"), next.to_owned(), true, 0),
		(
			format!(
				"[[ 1/0 -eq $(printf R >marker; echo 1) ]]; printf 'M=%s ' \"$(cat marker)\"; {after}"
			),
			"M=R SAME=0\nNEXT=0\n".to_owned(),
			true,
			0,
		),
		(format!("set -e; [[ 1 -eq 1/0 ]]; {after}"), String::new(), true, 1),
	];
	let rows: Vec<(&str, &str, bool, i32)> = rows
		.iter()
		.map(|(script, stdout, diagnostic, status)| {
			(script.as_str(), stdout.as_str(), *diagnostic, *status)
		})
		.collect();
	assert_bash(&rows).await;
}

/// Bash checks `set -e` and the ERR trap at a simple command, `(( ))`,
/// `[[ ]]`, function definition, subshell and a pipeline of multiple
/// commands, but not at the status a brace group, loop, `if` or `case` itself
/// returns (`execute_command_internal`, execute_cmd.c). The command inside
/// the compound already got its own check. Before, Brush's pipeline-level
/// check did both again: it exited at an otherwise exempt `! true` and fired
/// the ERR trap twice for an inner `false`.
#[tokio::test]
async fn errexit_and_err_trap_do_not_check_a_compound_commands_own_status() {
	let after = "printf 'SAME=%s\\n' \"$?\"\nprintf NEXT";
	let rows: Vec<(String, &str, bool, i32)> = vec![
		(format!("set -e; for x in a; do ! true; done; {after}"), "SAME=1\nNEXT", false, 0),
		(format!("set -e; {{ ! true; }}; {after}"), "SAME=1\nNEXT", false, 0),
		(format!("set -e; if :; then ! true; fi; {after}"), "SAME=1\nNEXT", false, 0),
		(format!("set -e; case a in a) ! true;; esac; {after}"), "SAME=1\nNEXT", false, 0),
		(format!("set -e; while :; do ! true; break; done; {after}"), "SAME=0\nNEXT", false, 0),
		(
			format!("set -e; for ((i=0; i<1; i++)); do ! true; done; {after}"),
			"SAME=1\nNEXT",
			false,
			0,
		),
		(
			format!("trap 'printf ERR' ERR; for x in a; do false; done; {after}"),
			"ERRSAME=1\nNEXT",
			false,
			0,
		),
		(format!("trap 'printf ERR' ERR; {{ ! true; }}; {after}"), "SAME=1\nNEXT", false, 0),
		(
			format!("trap 'printf ERR' ERR; if :; then false; fi; {after}"),
			"ERRSAME=1\nNEXT",
			false,
			0,
		),
	];
	let rows: Vec<(&str, &str, bool, i32)> = rows
		.iter()
		.map(|(script, stdout, diagnostic, status)| (script.as_str(), *stdout, *diagnostic, *status))
		.collect();
	assert_bash(&rows).await;
}

/// An error that ends the shell does so however many builtins wrap it, as in
/// Bash: `compgen -W` with a required parameter or an unset variable under
/// `set -u`, run directly and through `command`, `builtin`, both nested, a
/// function, `eval`, a sourced file, `time` and as the `lastpipe` stage;
/// `compgen -F` and `-W` under `set -e` with an invalid indirection. A
/// pipeline stage still ends alone, and `compgen -C` runs its command in a
/// subshell. Before, the builtin's wrapper lost whether the error ended the
/// shell, so the next line ran. (`compgen -F` with a required parameter and
/// no `set -e` is left out: Bash then exits with the status from before
/// `compgen`, which its completion code restores as it unwinds.)
#[tokio::test]
async fn a_fatal_error_ends_the_shell_through_any_builtin_that_wraps_it() {
	let required = "compgen -W '${missing:?BOOM}' -- x";
	let after = "printf 'AFTER=%s\\n' \"$?\"\nprintf 'NEXT=%s\\n' \"$?\"";
	let rows: Vec<(String, &str, bool, i32)> = vec![
		(format!("{required} 2>diag; {after}"), "", false, 1),
		(format!("set -u; compgen -W '$missing' -- x 2>diag; {after}"), "", false, 1),
		(format!("command {required} 2>diag; {after}"), "", false, 1),
		(format!("builtin {required} 2>diag; {after}"), "", false, 1),
		(format!("command builtin {required} 2>diag; {after}"), "", false, 1),
		(format!("builtin command {required} 2>diag; {after}"), "", false, 1),
		(format!("g() {{ {required}; printf G; }}; g 2>diag; {after}"), "", false, 1),
		(format!("eval \"compgen -W '\\${{missing:?BOOM}}' -- x\" 2>diag; {after}"), "", false, 1),
		(
			format!(
				"printf \"compgen -W '\\${{missing:?BOOM}}' -- x; printf IN\\n\" >payload; . \
				 ./payload 2>diag; {after}"
			),
			"",
			false,
			1,
		),
		(format!("time {required} 2>diag; {after}"), "", true, 1),
		(format!("shopt -s lastpipe; : | {required} 2>diag; {after}"), "", false, 1),
		(format!("set -u; command compgen -W '$missing' -- x 2>diag; {after}"), "", false, 1),
		(format!("set -u; eval \"compgen -W '\\$missing' -- x\" 2>diag; {after}"), "", false, 1),
		(format!("set -e; v='a b'; compgen -W '${{!v}}' -- x 2>diag; {after}"), "", false, 1),
		(
			format!("set -e; v='a b'; f() {{ : \"${{!v}}\"; }}; compgen -F f -- x 2>diag; {after}"),
			"",
			false,
			1,
		),
		(
			format!("set -e; f() {{ : \"${{missing:?BOOM}}\"; }}; compgen -F f -- x 2>diag; {after}"),
			"",
			false,
			1,
		),
		(format!("{required} 2>diag | cat; {after}"), "AFTER=0\nNEXT=0\n", false, 0),
		(
			format!("compgen -C ': ${{missing:?BOOM}}' -- x 2>diag; {after}"),
			"AFTER=1\nNEXT=0\n",
			false,
			0,
		),
	];
	let rows: Vec<(&str, &str, bool, i32)> = rows
		.iter()
		.map(|(script, stdout, diagnostic, status)| (script.as_str(), *stdout, *diagnostic, *status))
		.collect();
	assert_bash(&rows).await;
}

/// `time` reports the time a pipeline took even when an error discards its
/// line or ends the shell, as Bash's `time_command` does (execute_cmd.c); only
/// a `set -e` exit at an error Bash reports through `report_error` leaves no
/// report, since that exits the shell where it is reported. Before, the
/// report was lost whenever the pipeline ended with an error.
#[tokio::test]
async fn time_reports_a_pipeline_that_ends_with_an_error() {
	let next = "printf SAME\nprintf NEXT";
	let mut differing = Vec::new();
	for (script, stdout, reports, status) in [
		(format!("time : $((1/0)); {next}"), "NEXT", 1, Some(0)),
		(format!("time : ${{missing:?BOOM}}; {next}"), "", 1, Some(1)),
		(format!("v='a b'; time : \"${{!v}}\"; {next}"), "NEXT", 1, Some(0)),
		(format!("set -e; v='a b'; time : \"${{!v}}\"; {next}"), "", 0, Some(1)),
		(format!("f() {{ : $((1/0)); }}; time f; {next}"), "NEXT", 1, Some(0)),
		(format!("time {{ : $((1/0)); }} 2>diag; {next}"), "NEXT", 1, Some(0)),
		(format!("time : $((1/0)) | cat; {next}"), "SAMENEXT", 1, Some(0)),
		(format!("time (( 1/0 )); {next}"), "SAMENEXT", 1, Some(0)),
		(format!("set -e; time false; {next}"), "", 1, Some(1)),
	] {
		let (observed_stdout, stderr, observed_status) = run_streams(&script).await;
		let observed = (
			observed_stdout,
			stderr
				.lines()
				.filter(|line| line.starts_with("real"))
				.count(),
			observed_status,
		);
		if observed != (stdout.to_owned(), reports, status) {
			differing.push(format!(
				"{script}\n  Bash: {:?}\n  observed: {observed:?}",
				(stdout, reports, status)
			));
		}
	}
	assert!(differing.is_empty(), "{}", differing.join("\n"));
}

/// An expansion error inside a sourced file or an `eval` string that runs in
/// a subshell ends the whole subshell, as in Bash, whose `parse_and_execute`
/// jumps to the subshell's top level at a `DISCARD` when
/// `subshell_environment` is set (evalstring.c): the next line of the file or
/// string does not run, and the subshell's status is 1. That holds for a
/// pipeline stage in any position, a function stage, `( )`, a command
/// substitution and a background job. Outside a subshell the next line of the
/// file runs, as in Bash. Before, the sourced file or `eval` consumed the
/// error and ran its next line, so a stage that should have ended wrote its
/// file and gave status 0.
#[tokio::test]
async fn an_abandoned_line_inside_source_or_eval_ends_the_whole_subshell() {
	let payload = "printf ': \"$((1/0))\"\\nprintf BAD; printf bad >marker\\n' > payload; ";
	let marker = "; if [ -e marker ]; then printf 'MARKER\\n'; fi";
	let pipeline = "printf 'PARENT=%s PIPESTATUS=%s\\n' \"$?\" \"${PIPESTATUS[*]}\"";
	let rows: Vec<(String, &str, bool, i32)> = vec![
		(
			format!("{payload}. ./payload; printf 'AFTER=%s\\n' \"$?\"{marker}"),
			"BADAFTER=0\nMARKER\n",
			true,
			0,
		),
		(
			format!("{payload}. ./payload | cat; {pipeline}{marker}"),
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			format!("{payload}: | . ./payload | cat; {pipeline}{marker}"),
			"PARENT=0 PIPESTATUS=0 1 0\n",
			true,
			0,
		),
		(
			format!("{payload}( . ./payload ); printf 'AFTER=%s\\n' \"$?\"{marker}"),
			"AFTER=1\n",
			true,
			0,
		),
		(
			format!("{payload}x=$(. ./payload); printf 'X=[%s] AFTER=%s\\n' \"$x\" \"$?\"{marker}"),
			"X=[] AFTER=1\n",
			true,
			0,
		),
		(
			format!("{payload}eval \"$(cat payload)\" | cat; {pipeline}{marker}"),
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
		(
			// A bare `wait`: `wait $!` loses a background group's status here (a
			// separate defect, on main too); the job must still end at the error.
			format!("{payload}{{ . ./payload; }} & wait; printf 'AFTER=%s\\n' \"$?\"{marker}"),
			"AFTER=0\n",
			true,
			0,
		),
		(
			format!("{payload}f() {{ . ./payload; }}; f | cat; {pipeline}{marker}"),
			"PARENT=0 PIPESTATUS=1 0\n",
			true,
			0,
		),
	];
	let rows: Vec<(&str, &str, bool, i32)> = rows
		.iter()
		.map(|(script, stdout, diagnostic, status)| (script.as_str(), *stdout, *diagnostic, *status))
		.collect();
	assert_bash(&rows).await;
}

/// `-e` follows Bash's `execute_builtin` and `command_builtin` exactly. A
/// simple command's own `command` prefix (`CMD_COMMAND_BUILTIN`) turns `-e`
/// off for the builtin it runs where its status is ignored, so `command eval
/// … || …` and `command builtin eval … || …` go on. `builtin` calls its
/// builtin directly, and `command` run that way executes its command without
/// `CMD_IGNORE_RETURN`, so `-e` applies to that command: `builtin command
/// eval … || …`, `builtin command . file || …`, `builtin command compgen -W
/// … || …` and `builtin command false || …` exit. Before, any `command` whose
/// status was ignored turned `-e` off.
#[tokio::test]
async fn a_command_run_through_builtin_command_keeps_errexit() {
	let v = "set -e; v='a b';";
	let after = "|| printf OR; printf AFTER\nprintf NEXT";
	let rows: Vec<(String, &str, bool, i32)> = vec![
		(format!("{v} builtin command eval ': \"${{!v}}\"' {after}"), "", true, 1),
		(format!("{v} command eval ': \"${{!v}}\"' {after}"), "ORAFTERNEXT", true, 0),
		(format!("{v} command builtin eval ': \"${{!v}}\"' {after}"), "ORAFTERNEXT", true, 0),
		(
			format!(
				"{v} if builtin command eval ': \"${{!v}}\"'; then printf T; fi; printf AFTER\nprintf \
				 NEXT"
			),
			"",
			true,
			1,
		),
		(
			format!("{v} printf ': \"${{!v}}\"\\n' > indirect; builtin command . ./indirect {after}"),
			"",
			true,
			1,
		),
		(format!("{v} builtin command compgen -W '${{!v}}' -- x {after}"), "", true, 1),
		(format!("{v} command compgen -W '${{!v}}' -- x {after}"), "NEXT", true, 0),
		(format!("set -e; builtin command eval ': \"$((1/0))\"' {after}"), "", true, 1),
		(format!("set -e; builtin command false {after}"), "", false, 1),
		(format!("set -e; command false {after}"), "ORAFTERNEXT", false, 0),
		(format!("set -e; command eval 'false; printf IN' {after}"), "INAFTERNEXT", false, 0),
		(format!("set -e; builtin command eval 'false; printf IN' {after}"), "", false, 1),
	];
	let rows: Vec<(&str, &str, bool, i32)> = rows
		.iter()
		.map(|(script, stdout, diagnostic, status)| (script.as_str(), *stdout, *diagnostic, *status))
		.collect();
	assert_bash(&rows).await;
}

/// `!` inverts a pipeline's status, not a request to leave the shell or a
/// function: a fatal error under `!` (`! let missing` under `set -u`, a
/// required parameter through `eval`, `.`, `command eval` or a function)
/// still exits with status 1, `! return 3` returns 3 and `( ! exit 3 )` exits
/// 3, as in Bash. Before, the run stopped but reported status 0, and `return`
/// and `exit` under `!` gave 0.
#[tokio::test]
async fn negation_keeps_the_status_of_a_fatal_error_return_or_exit() {
	let next = "printf AFTER\nprintf NEXT";
	let rows: Vec<(String, &str, bool, i32)> = vec![
		(format!("set -u; ! let missing; {next}"), "", true, 1),
		(format!("! eval ': \"${{missing:?BOOM}}\"'; {next}"), "", true, 1),
		(format!("printf ': \"${{missing:?BOOM}}\"\\n' > p2; ! . ./p2; {next}"), "", true, 1),
		(format!("set -u; f() {{ let missing; }}; ! f; {next}"), "", true, 1),
		(format!("! command eval ': \"${{missing:?BOOM}}\"'; {next}"), "", true, 1),
		("g() { ! return 3; }; g; printf 'S=%s\\n' \"$?\"".to_owned(), "S=3\n", false, 0),
		("( ! exit 3 ); printf 'S=%s\\n' \"$?\"".to_owned(), "S=3\n", false, 0),
	];
	let rows: Vec<(&str, &str, bool, i32)> = rows
		.iter()
		.map(|(script, stdout, diagnostic, status)| (script.as_str(), *stdout, *diagnostic, *status))
		.collect();
	assert_bash(&rows).await;
}
