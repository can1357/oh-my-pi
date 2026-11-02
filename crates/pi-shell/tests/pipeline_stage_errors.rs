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
	let stdout: Vec<u8> = stdout_rx.drain().flat_map(|chunk| chunk.to_vec()).collect();
	let wrote_stderr = stderr_rx.drain().any(|chunk| !chunk.is_empty());
	(String::from_utf8(stdout).expect("UTF-8 output"), wrote_stderr, result.exit_code)
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
