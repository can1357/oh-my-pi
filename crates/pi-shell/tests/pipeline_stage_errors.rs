//! A stage of a multi-command pipeline runs in a subshell: an error in it, or
//! an `exit`, `return`, `break` or `continue`, ends that stage alone. The
//! stage exits with the error's status, the other stages run to completion,
//! and the commands after the pipeline still run. Each row's expected
//! standard output, diagnostic and exit status is GNU Bash 5.2.21's for the
//! same script read from a file. (`bash -c` reports 127, not 1, for a stage
//! that ends at `${v:?}`, an unset variable under `set -u`, or a bad
//! substitution; every other status here is the same in both.)
#![cfg(unix)]

use bytes::Bytes;
use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, StreamSinks, execute_shell_streams},
};

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
