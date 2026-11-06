//! The sites the fatal-jump model of #18131 still answers differently from
//! bash. Every row is the output and exit status of Bash 5.2.21 and Bash
//! 5.3.0 for the same `-c` string (they agree on all of them), run here
//! through `Shell::run`; each group names the rule it defends and carries
//! the controls that rule must not break.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Run `script` (its diagnostics discarded) in a fresh shell: its output and
/// exit status.
async fn run(script: &str) -> (String, Option<i32>) {
	let (tx, rx) = flume::unbounded::<String>();
	let command = format!("exec 2>/dev/null\n{script}");
	let result = Shell::new(None)
		.run(
			ShellRunOptions { command, ..Default::default() },
			Some(tx),
			CancelToken::new(Some(10_000)),
		)
		.await
		.expect("run");
	(rx.drain().collect(), result.exit_code)
}

async fn check(rows: &[(&str, &str, i32)]) {
	let mut wrong = Vec::new();
	for &(script, output, status) in rows {
		let got = run(script).await;
		if got != (output.to_owned(), Some(status)) {
			wrong.push(format!("`{script}`: got {got:?}, bash gives ({output:?}, {status})"));
		}
	}
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// An ERR trap runs only if one was set when the command that failed
/// started (bash's `was_error_trap`), and that holds for every command bash
/// reports on its own — not only a simple command. A `(( ))`, a `[[ ]]` and
/// a `{ …; }` group whose only DEBUG action installed the trap must not run
/// it; a `for` body and a `case` arm must, because their own command starts
/// after the action.
#[tokio::test(flavor = "multi_thread")]
async fn the_err_trap_arming_sample_covers_every_command() {
	check(&[
		(r##"trap 'trap "exit 23" ERR' DEBUG; { false; }; echo AFTER:$?"##, "AFTER:1\n", 0),
		(r##"trap 'trap "echo N" ERR' DEBUG; { false; }; echo A:$?"##, "A:1\n", 0),
		// Controls: the trap installed before the command still runs, once.
		(r##"trap 'trap "exit 23" ERR' DEBUG; false; echo AFTER:$?"##, "AFTER:1\n", 0),
		(r##"trap 'trap "echo N" ERR' DEBUG; ( false ); echo A:$?"##, "A:1\n", 0),
		(r##"trap 'trap "echo N" ERR' DEBUG; false | false; echo A:$?"##, "A:1\n", 0),
		(r##"trap 'trap "echo N" ERR' DEBUG; f(){ false; }; f; echo A:$?"##, "A:1\n", 0),
		// A command that starts after the action does run the new trap.
		(r##"trap 'trap "echo N" ERR' DEBUG; for i in 1; do false; done; echo A:$?"##, "N\nA:1\n", 0),
		(r##"trap 'trap "echo N" ERR' DEBUG; case x in x) false;; esac; echo A:$?"##, "N\nA:1\n", 0),
		// A trap already set fires exactly once for each shape.
		(r##"trap 'echo T' ERR; { false; }; echo A:$?"##, "T\nA:1\n", 0),
		(r##"trap 'echo T' ERR; ((0)); echo A:$?"##, "T\nA:1\n", 0),
		(r##"trap 'echo T' ERR; [[ a = b ]]; echo A:$?"##, "T\nA:1\n", 0),
		(r##"trap 'echo T' ERR; ( false ); echo A:$?"##, "T\nA:1\n", 0),
		(r##"trap 'echo T' ERR; false | false; echo A:$?"##, "T\nA:1\n", 0),
		(r##"trap 'echo T' ERR; for i in 1; do false; done; echo A:$?"##, "T\nA:1\n", 0),
		(r##"trap 'echo T' ERR; case x in x) false;; esac; echo A:$?"##, "T\nA:1\n", 0),
		(r##"trap 'echo T' ERR; f(){ false; }; f; echo A:$?"##, "T\nA:1\n", 0),
		// A tested context runs no ERR trap at all.
		(r##"trap 'echo T' ERR; if false; then :; fi; echo A:$?"##, "A:0\n", 0),
		(r##"trap 'echo T' ERR; while false; do :; done; echo A:$?"##, "A:0\n", 0),
		// A trap the command's own body installs still fires for the
		// commands after it inside that body.
		(r##"{ trap 'echo N' ERR; false; }; echo A:$?"##, "N\nA:1\n", 0),
		(r##"( trap 'echo N' ERR; false ); echo A:$?"##, "N\nA:1\n", 0),
	])
	.await;
}

/// A RETURN trap's action runs after the sourced file has already ended, so
/// its `return` is invalid there and must not replace the status the file
/// returned.
#[tokio::test(flavor = "multi_thread")]
async fn a_return_action_does_not_replace_a_sourced_files_status() {
	check(&[
		(
			r##"cd "$(mktemp -d)"; trap 'return 13' RETURN; printf 'return 9\n' > s; . ./s; exit $?"##,
			"",
			9,
		),
		(
			r##"cd "$(mktemp -d)"; trap 'return 13' RETURN; printf 'false\n' > s; . ./s; exit $?"##,
			"",
			1,
		),
		(
			r##"cd "$(mktemp -d)"; printf '(exit 5); return 9\n' > s; trap 'set -T; trap "return 13" RETURN; . ./s; echo A:$?' EXIT; exit 7"##,
			"A:9\n",
			7,
		),
		// Control: the same source with no RETURN trap. (A RETURN trap whose
		// action itself returns, on a FUNCTION, is not a control here:
		// Bash 5.2.21 and 5.3.0 both recurse until they are killed.)
		(r##"cd "$(mktemp -d)"; printf 'return 9\n' > s; . ./s; exit $?"##, "", 9),
	])
	.await;
}

/// In a posix shell an invalid temporary-environment assignment NAME is a
/// fatal error before the command runs: 127 for a special builtin, 1 for
/// anything else, and the command does not run.
#[tokio::test(flavor = "multi_thread")]
async fn an_invalid_temporary_environment_name_ends_a_posix_shell() {
	check(&[
		(r##"set -o posix; A[0]=2 :; echo AFTER:$?"##, "", 127),
		(r##"set -o posix; A[0]=2 true; echo AFTER:$?"##, "", 1),
		(r##"set -o posix; f(){ echo F; }; A[0]=2 f; echo AFTER:$?"##, "", 1),
		(r##"set -o posix; eval 'A[0]=2 :'; echo AFTER:$?"##, "", 127),
		(r##"set -o posix; A[bad!]=2 :; echo AFTER:$?"##, "", 127),
		// Controls: a valid name, and the same names outside posix mode.
		(r##"set -o posix; V=2 :; echo AFTER:$?"##, "AFTER:0\n", 0),
		(r##"A[0]=2 :; echo AFTER:$?"##, "AFTER:0\n", 0),
	])
	.await;
}
