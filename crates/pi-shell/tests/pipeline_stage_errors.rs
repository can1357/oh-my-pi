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

/// The children of this test process (nextest runs each test in a process
/// of its own).
fn child_processes() -> BTreeSet<String> {
	fs::read_dir("/proc/self/task")
		.expect("threads")
		.filter_map(|thread| fs::read_to_string(thread.ok()?.path().join("children")).ok())
		.flat_map(|children| {
			children
				.split_whitespace()
				.map(str::to_owned)
				.collect::<Vec<_>>()
		})
		.collect()
}

/// The number of descriptors this test process has open.
fn open_descriptors() -> usize {
	fs::read_dir("/proc/self/fd").expect("descriptors").count()
}

/// When the last stage, which `lastpipe` runs in the current shell, ends the
/// line with an error, a persistent shell's run returns only once the stages
/// before it have finished: nothing it started is still running, holding a
/// descriptor or about to start a process. The earlier stage finishes its
/// work as it does in Bash, where it outlives the shell. Before, the run
/// returned at once while the earlier stage went on, so it wrote its file and
/// started processes after the run had returned.
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
	run(":").await;
	let mut differing = Vec::new();
	for (stage, last) in [
		("{ /bin/sleep 0.3; printf done >marker; }", ": \"${missing:?BOOM}\""),
		("/bin/sh -c 'sleep 0.3; printf done >marker'", ": \"${missing:?BOOM}\""),
		("{ /bin/sleep 0.3; printf done >marker; }", ": \"$((1/0))\""),
		("{ /bin/sleep 0.3; printf done >marker; }", "f"),
	] {
		let marker = dir.path().join("marker");
		let _ = fs::remove_file(&marker);
		let (children, descriptors) = (child_processes(), open_descriptors());
		let script =
			format!("shopt -s lastpipe; f() {{ : \"$((1/0))\"; }}; {stage} | {last}; {PARENT}");
		let status = run(&script).await;
		let observed = (
			status,
			fs::read_to_string(&marker).unwrap_or_default(),
			child_processes() == children,
			open_descriptors() <= descriptors,
		);
		if observed != (Some(1), "done".to_owned(), true, true) {
			differing.push(format!(
				"{script}\n  (status, marker, no new child, no new descriptor): {observed:?}"
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

/// `PS4` is expanded with the standard streams of the command it traces, so
/// what a command substitution in it writes reaches the run's standard error
/// with the trace line, as in Bash. Before, `PS4` was expanded with the
/// shell's default streams, and in the bash tool that output went to the
/// host process's own standard error.
#[tokio::test]
async fn ps4_is_expanded_with_the_traced_command_streams() {
	let (stdout, stderr, status) =
		run_streams("PS4='$(printf PS4OUT >&2)+ '; set -x; :; set +x").await;
	assert_eq!((stdout.as_str(), status), ("", Some(0)), "{stderr:?}");
	assert!(stderr.contains("PS4OUT+ :"), "{stderr:?}");
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
