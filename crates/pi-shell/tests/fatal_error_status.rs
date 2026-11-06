//! The status a shell exits with after a fatal error depends on where the
//! error is caught (bash's `top_level` jumps), not on an `exit` status: every
//! row is the output and exit status of Bash 5.2.21 and 5.3.0 for the same
//! `-c` string (they agree on all of them), run here through `Shell::run`.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Run `script` (its diagnostics discarded) in a fresh shell: its output and
/// exit status.
///
/// `TMPDIR` points at a `TempDir` of this run, so the rows that make a
/// scratch directory with `mktemp -d` leave nothing behind: the directory
/// goes when this function returns. `export` is the first command either
/// way, so no row's `$?` moves.
async fn run(script: &str) -> (String, Option<i32>) {
	let tmp = tempfile::Builder::new()
		.prefix("fatal-error-status-")
		.tempdir()
		.expect("scratch directory");
	let (tx, rx) = flume::unbounded::<String>();
	let command =
		format!("exec 2>/dev/null\nexport TMPDIR='{}'\n{script}", tmp.path().display());
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

/// A fatal expansion error (`${x?}`, `set -u`) inside an EXIT trap ends the
/// trap and the shell exits with the status the trap started with (bash's
/// `run_exit_trap` catches the jump), in every kind of shell. The engine
/// exited 1 (127 at top level): it treated the error as `exit 1`. `exit 5`
/// and `set -e` in the trap still decide the status.
#[tokio::test(flavor = "multi_thread")]
async fn fatal_error_in_exit_trap_exits_with_the_saved_status() {
	check(&[
		(r##"( trap ': ${nope?boom}' EXIT; exit 4 ); echo "S:$?""##, "S:4\n", 0),
		(r##"x=$( trap 'set -u; : $nope' EXIT; exit 4 ); echo "S:$?""##, "S:4\n", 0),
		(
			r##"{ trap ': ${nope:?boom}' EXIT; exit 4; } | cat; echo "S:${PIPESTATUS[0]}""##,
			"S:4\n",
			0,
		),
		(r##"( f() { exit 4; }; trap 'x=${nope?boom}' EXIT; f ); echo "S:$?""##, "S:4\n", 0),
		(
			r##"( ( trap ': ${nope?boom}' EXIT; exit 4 ); echo "S:inner $?" ); echo "S:$?""##,
			"S:inner 4\nS:0\n",
			0,
		),
		(r##"trap ': ${nope?boom}' EXIT; exit 4"##, "", 4),
		(r##"trap ': ${nope?boom}' EXIT; (exit 3)"##, "", 3),
		(r##"( trap 'exit 5' EXIT; exit 4 ); echo "S:$?""##, "S:5\n", 0),
		(r##"( trap 'set -e; false' EXIT; exit 4 ); echo "S:$?""##, "S:1\n", 0),
	])
	.await;
}

/// A pipeline stage or `&` job that is one simple command (a function call
/// included) has no catch of its own in bash: its fatal error lands where
/// its parent's would, so it exits 127 under a `-c` string (`run_one_command`)
/// and with the trap's saved status inside an EXIT trap. The engine exited 1
/// like a subshell. A builtin the child runs (`eval`), a `( … )` parent and a
/// `{ …; } &` group keep exiting 1.
#[tokio::test(flavor = "multi_thread")]
async fn forked_simple_command_exits_where_its_parent_would() {
	check(&[
		(r##": "${missing:?BOOM}" & wait $!; echo "S:$?""##, "S:127\n", 0),
		(r##"f() { : "${missing:?BOOM}"; }; f & wait $!; echo "S:$?""##, "S:127\n", 0),
		(r##"/bin/echo "${missing:?BOOM}" & wait $!; echo "S:$?""##, "S:127\n", 0),
		(r##"x=${missing:?BOOM} & wait $!; echo "S:$?""##, "S:127\n", 0),
		(r##"f() { eval ': "${missing:?BOOM}"'; }; f & wait $!; echo "S:$?""##, "S:127\n", 0),
		(r##"! : ${nope?} & wait $!; echo "S:$?""##, "S:127\n", 0),
		(r##"f() { set -u; : $nope; }; f | cat; echo "S:${PIPESTATUS[0]}""##, "S:127\n", 0),
		(r##"eval ': ${nope?}' & wait $!; echo "S:$?""##, "S:1\n", 0),
		(r##"eval ': ${nope?}' | cat; echo "S:${PIPESTATUS[0]}""##, "S:1\n", 0),
		(r##"( : ${nope?} & wait $!; echo "S:$?" ); echo "S:$?""##, "S:1\nS:0\n", 0),
		(r##"{ : ${nope?}; } & wait $!; echo "S:$?""##, "S:1\n", 0),
		(r##"trap ': ${nope?} & wait $!; echo "S:$?"' EXIT; exit 4"##, "S:4\n", 4),
		(r##"trap ': $((1/0)) | cat; echo "S:${PIPESTATUS[0]}"' EXIT; exit 4"##, "S:4\n", 4),
	])
	.await;
}

/// When the forked command's own words fail, bash's child has not reset its
/// traps yet, so the EXIT trap it inherited runs in the child too (twice in
/// all); once a function runs in it, the trap is reset. The engine never ran
/// it.
#[tokio::test(flavor = "multi_thread")]
async fn forked_simple_command_runs_the_exit_trap_it_inherited() {
	check(&[
		(r##"trap 'echo T' EXIT; : ${nope?} & wait $!; echo "S:$?""##, "T\nS:127\nT\n", 0),
		(r##"trap 'echo T' EXIT; : ${nope?} | cat; echo "S:${PIPESTATUS[0]}""##, "T\nS:127\nT\n", 0),
		(r##"trap 'echo T' EXIT; f() { : ${nope?}; }; f & wait $!; echo "S:$?""##, "S:127\nT\n", 0),
		(
			r##"( trap 'echo T' EXIT; : $((1/0)) & wait $!; echo "S:$?" ); echo "S:$?""##,
			"T\nS:1\nT\nS:0\n",
			0,
		),
	])
	.await;
}

/// An arithmetic error or bad substitution in `eval`, a trap action or a
/// subshell's own code ends a subshell with status 1 and its EXIT trap
/// (bash's `parse_and_execute` hands the jump on under
/// `subshell_environment`). The engine went on with the next command, or
/// ended the subshell without its EXIT trap. The shell itself still goes on.
#[tokio::test(flavor = "multi_thread")]
async fn discarded_command_ends_a_subshell() {
	check(&[
		(r##"( eval ': $((1/0))'; echo no ); echo "S:$?""##, "S:1\n", 0),
		(
			r##"( trap 'echo "S:trap $?"' EXIT; : $((1/0)); echo no ); echo "S:$?""##,
			"S:trap 1\nS:1\n",
			0,
		),
		(
			r##"x=$( trap 'echo "S:trap $?"' EXIT; : ${a.b}; echo no ); echo "$x S:$?""##,
			"S:trap 1 S:1\n",
			0,
		),
		(r##"( trap ': $((1+))' ERR; false; echo no ); echo "S:$?""##, "S:1\n", 0),
		(r##"eval ': $((1/0))'; echo "S:after $?""##, "S:after 1\n", 0),
	])
	.await;
}

/// bash resets the traps before `exec` tries a program, so the shell that
/// exits after the failure runs no EXIT trap; a name not found on `PATH`
/// fails before that, and `execfail` keeps the shell and its trap.
#[tokio::test(flavor = "multi_thread")]
async fn failed_exec_runs_no_exit_trap_once_the_program_was_tried() {
	check(&[
		(r##"trap 'echo T' EXIT; exec /nonexistent/cmd"##, "", 127),
		(r##"trap 'echo T' EXIT; exec nosuchcmd_fatalstatus"##, "T\n", 127),
		(r##"( trap 'echo T' EXIT; exec /nonexistent/cmd ); echo "S:$?""##, "S:127\n", 0),
		(
			r##"shopt -s execfail; trap 'echo T' EXIT; exec /nonexistent/cmd; echo "S:after $?""##,
			"S:after 127\nT\n",
			0,
		),
	])
	.await;
}

/// In posix mode a failed assignment (a readonly variable, a bad subscript,
/// a `for` variable) is a fatal error like `${x?}` (bash's
/// `posix_variable_assignment_error`): 127 from a `-c` string, the saved
/// status in an EXIT trap. The engine exited 1 everywhere.
#[tokio::test(flavor = "multi_thread")]
async fn posix_assignment_error_is_a_fatal_error() {
	check(&[
		(r##"set -o posix; readonly r=1; r=2; echo no"##, "", 127),
		(r##"set -o posix; readonly r=1; for r in 1; do :; done; echo no"##, "", 127),
		(r##"set -o posix; readonly r=1; r=2 :; echo no"##, "", 127),
		(r##"( trap 'set -o posix; b[]=x' EXIT; exit 4 ); echo "S:$?""##, "S:4\n", 0),
		(r##"set -o posix; readonly r=1; r=2 & wait $!; echo "S:$?""##, "S:127\n", 0),
		(r##"( set -o posix; readonly r=1; r=2; echo no ); echo "S:$?""##, "S:1\n", 0),
	])
	.await;
}

/// A trap that runs inside the EXIT trap's action (ERR, DEBUG, a signal)
/// takes the jump out of both actions, and the shell exits with the status
/// of that moment, not with the status the EXIT trap saved (bash's nested
/// `parse_and_execute` leaves `last_command_exit_value` behind). The engine
/// exited with the EXIT trap's saved status in every one of them.
///
/// The two RETURN rows are the control for that rule, not an instance of
/// it: without `functrace` a top-level RETURN trap is NOT inherited by a
/// function, so no action runs and no jump is taken. (An earlier round of
/// this change read them as "a RETURN trap's own `return_catch` swallows
/// the jump"; that model was retracted in round 6, and the `set -T` rows
/// of `a_return_trap_is_a_nested_trap_like_any_other` carry the real
/// behaviour.)
#[tokio::test(flavor = "multi_thread")]
async fn a_trap_inside_the_exit_trap_exits_with_the_status_of_the_moment() {
	check(&[
		(r##"trap ': "${zz?B}"' ERR; trap false EXIT; exit 7"##, "", 1),
		(r##"trap ': "${zz?B}"' ERR; trap 'echo S:a; false; echo S:b' EXIT; exit 7"##, "S:a\n", 1),
		(r##"trap 'echo S:E1; : "${zz?B}"; echo S:E2' ERR; trap false EXIT; exit 7"##, "S:E1\n", 1),
		(r##"trap ': "${zz?B}"' ERR; f(){ false; }; trap 'f' EXIT; exit 7"##, "", 1),
		(r##"trap ': "${zz?B}"' ERR; trap 'false' EXIT; exit 0"##, "", 1),
		(r##"trap ': "${zz?B}"' USR1; trap 'kill -USR1 $$; echo S:in $?' EXIT; exit 7"##, "", 0),
		// Not inherited without `set -T`: the action never runs.
		(r##"trap ': "${zz?B}"' RETURN; f(){ return 3; }; trap 'f' EXIT; exit 7"##, "", 7),
		(r##"trap ': "${zz?B}"' RETURN; f(){ return 3; }; f; echo S:after $?"##, "S:after 3\n", 0),
		// Outside an EXIT trap the shell's own catch still decides.
		(r##"trap ': "${zz?B}"' ERR; false; echo S:after $?"##, "", 127),
		(r##"trap ': "${zz?B}"' USR1; kill -USR1 $$; echo S:after $?"##, "", 127),
		(r##"trap 'exit 9' ERR; trap false EXIT; exit 7"##, "", 9),
	])
	.await;
}

/// `exec`ing a text file the operating system refuses (no `#!`) makes the
/// shell run that file as a script, and bash had already reset the traps
/// before it called `execve`, so the replaced shell's EXIT trap never runs
/// (`shell_execve`'s `ENOEXEC` path). The engine ran it.
#[tokio::test(flavor = "multi_thread")]
async fn an_exec_of_a_text_file_runs_no_exit_trap() {
	check(&[
		(
			r##"d=$(mktemp -d); printf ': ${zz?B}\n' > $d/t; chmod +x $d/t; trap 'echo S:T:$?' EXIT; exec $d/t; echo S:BAD"##,
			"",
			1,
		),
		(
			r##"d=$(mktemp -d); printf 'echo S:ran\n' > $d/t; chmod +x $d/t; trap 'echo S:T:$?' EXIT; exec $d/t; echo S:BAD"##,
			"S:ran\n",
			0,
		),
		(
			r##"d=$(mktemp -d); printf 'exit 6\n' > $d/t; chmod +x $d/t; trap 'echo S:T:$?' EXIT; exec $d/t; echo S:BAD"##,
			"",
			6,
		),
		(
			r##"d=$(mktemp -d); printf ': ${zz?B}\n' > $d/t; chmod +x $d/t; ( trap 'echo S:T:$?' EXIT; exec $d/t ); echo S:$?"##,
			"S:1\n",
			0,
		),
		(
			r##"d=$(mktemp -d); printf ': ${zz?B}\n' > $d/t; chmod +x $d/t; x=$( trap 'echo S:T:$?' EXIT; exec $d/t ); echo "[$x] S:$?""##,
			"[] S:1\n",
			0,
		),
		// Without `exec` the shell is not replaced and its trap still runs.
		(
			r##"d=$(mktemp -d); printf ': ${zz?B}\n' > $d/t; chmod +x $d/t; trap 'echo S:T:$?' EXIT; $d/t; echo S:after $?"##,
			"S:after 1\nS:T:0\n",
			0,
		),
	])
	.await;
}

/// The innermost trap nested in an EXIT trap's action decides the fatal
/// status: a DEBUG trap uses its saved status, and an ERR trap uses the
/// failed command's status. Bash 5.2.21 and 5.3.0 give the answers below.
#[tokio::test(flavor = "multi_thread")]
async fn the_innermost_trap_in_an_exit_trap_decides_the_fatal_status() {
	check(&[
		// The innermost nested trap decides (a signal trap whose action sets
		// an ERR trap).
		(
			r##"trap 'trap '"'"': ${x?BOOM}'"'"' ERR; false' USR1; trap 'kill -USR1 $$' EXIT; exit 7"##,
			"",
			1,
		),
		// A DEBUG trap inside the EXIT trap's action.
		(
			r##"trap 'trap '"'"': ${unset_review?BOOM}'"'"' DEBUG; :; echo BAD' EXIT; exit 7"##,
			"",
			0,
		),
	])
	.await;
}

/// `errexit` makes a fatal error caught by the EXIT trap end the shell
/// with status 1, rather than the status that the trap saved. Bash 5.2.21
/// and 5.3.0 agree, whether `errexit` was set before or inside the action.
#[tokio::test(flavor = "multi_thread")]
async fn errexit_turns_a_fatal_error_in_an_exit_trap_into_status_one() {
	check(&[
		// `errexit` while the fatal error lands in the EXIT trap.
		(r##"trap 'set -e; : ${x?BOOM}' EXIT; exit 7"##, "", 1),
		(r##"( trap 'set -e; : ${x?BOOM}' EXIT; exit 7 ); echo "S:$?""##, "S:1\n", 0),
		(r##"trap 'set -e; : ${x?BOOM}' EXIT; exit 0"##, "", 1),
		(r##"set -e; trap ': ${x?BOOM}' EXIT; exit 7"##, "", 1),
	])
	.await;
}

/// A POSIX arithmetic-subscript assignment error is a discard, not a
/// fatal error: Bash 5.2.21 and 5.3.0 exit 1 rather than 127, including
/// when the assignment runs in a background child.
#[tokio::test(flavor = "multi_thread")]
async fn a_posix_arithmetic_subscript_assignment_error_is_a_discard() {
	check(&[
		// A posix arithmetic-subscript assignment error is a discard.
		(r##"set -o posix; declare -a A; A[bad!]=x; echo BAD"##, "", 1),
		(r##"set -o posix; declare -a A; A[bad!]=x & wait $!; echo "S:$?""##, "S:1\n", 0),
	])
	.await;
}

/// A POSIX temporary-environment assignment error ends the shell before
/// the command runs. Bash 5.2.21 and 5.3.0 exit 1 for an external command
/// and 127 for a special builtin; a child's EXIT trap still runs.
#[tokio::test(flavor = "multi_thread")]
async fn a_posix_temporary_assignment_error_ends_the_shell_before_the_command_runs() {
	check(&[
		// A posix temporary-environment assignment error, by what it runs.
		(r##"set -o posix; readonly R; R=x /usr/bin/true; echo BAD"##, "", 1),
		(r##"set -o posix; readonly R; R=x :; echo BAD"##, "", 127),
		(r##"( set -o posix; readonly R; R=x /usr/bin/true; echo BAD ); echo "S:$?""##, "S:1\n", 0),
		(
			r##"( trap 'echo S:T' EXIT; set -o posix; readonly R; R=x /usr/bin/true; echo BAD; exit 4 ); echo "S:$?""##,
			"S:T\nS:1\n",
			0,
		),
		(r##"set -o posix; readonly R; R=x /usr/bin/true & wait $!; echo "S:$?""##, "S:1\n", 0),
	])
	.await;
}

/// With `errexit` on, bash raises `ERREXIT` instead of `FORCE_EOF` or
/// `DISCARD`, and every catch answers with 1: the EXIT trap's action, a
/// trap nested in it, the shell itself, and a child forked before expansion.
/// Bash 5.2.21 and 5.3.0 agree on these statuses and their controls.
#[tokio::test(flavor = "multi_thread")]
async fn errexit_converts_fatal_and_discarded_expansion_jumps_to_status_one() {
	check(&[
		// `errexit` and a child the shell forked before it expanded anything.
		(
			r##"trap 'set -e; : ${u?BOOM} | :; echo P:${PIPESTATUS[*]}' EXIT; exit 7"##,
			"P:1 0\n",
			7,
		),
		(r##"trap ': ${u?BOOM} | :; echo P:${PIPESTATUS[*]}' EXIT; exit 7"##, "P:7 0\n", 7),
		(r##"set -e; : ${u?BOOM} & wait $!; echo W:$?"##, "", 1),
		(r##"set -e; : ${u?BOOM} | :; echo P:${PIPESTATUS[*]}"##, "P:1 0\n", 0),
		(r##"trap 'set -e; : ${u?BOOM} & wait $!; echo W:$?' EXIT; exit 7"##, "", 1),
		// `errexit` and a trap nested in the EXIT trap's action.
		(r##"trap 'set -e; trap '"'"': ${u?BOOM}'"'"' DEBUG; :' EXIT; exit 7"##, "", 1),
		(
			r##"trap 'set -e; trap '"'"': ${u?BOOM}'"'"' USR2; kill -USR2 $$' EXIT; exit 7"##,
			"",
			1,
		),
		(
			r##"trap 'trap '"'"'set -e; : ${u?BOOM}'"'"' USR2; kill -USR2 $$; echo AFTER' EXIT; exit 7"##,
			"",
			1,
		),
		// `errexit` and a discarded command (a bad substitution).
		(r##"trap 'set -e; : ${x.y}; echo AFTER' EXIT; exit 3"##, "", 1),
		(r##"set -e; trap ': ${x.y}; echo AFTER' EXIT; exit 3"##, "", 1),
		(r##"trap ': ${x.y}; echo AFTER' EXIT; exit 3"##, "", 3),
		(r##"trap 'set -e; : ${x.y} | cat; echo P:${PIPESTATUS[0]}' EXIT; exit 7"##, "P:1\n", 7),
		(r##"trap ': ${x.y} | cat; echo P:${PIPESTATUS[0]}' EXIT; exit 7"##, "P:7\n", 7),
		(r##"trap 'set -e; trap '"'"': ${x.y}'"'"' DEBUG; :; echo AFTER' EXIT; exit 7"##, "", 1),
	])
	.await;
}

/// An arithmetic error in an assignment makes bash's assignment jump:
/// no `eval`, `.`, or function contains it, and `errexit` does not replace
/// it. Bash 5.2.21 and 5.3.0 keep the status of the catch where it lands.
#[tokio::test(flavor = "multi_thread")]
async fn an_assignment_arithmetic_error_bypasses_eval_and_function_catches() {
	check(&[
		// An arithmetic error in an assignment: no catch of eval, `.` or a
		// function, and `errexit` does not change it.
		(r##"declare -a A; eval 'A[bad!]=x'; echo AFTER:$?"##, "", 1),
		(r##"declare -i I; eval 'I=bad!'; echo AFTER:$?"##, "", 1),
		(r##"set -o posix; declare -i I; eval 'I=bad!'; echo AFTER:$?"##, "", 1),
		(r##"set -o posix; declare -i I; I=bad!; echo AFTER:$?"##, "", 1),
		(r##"set -o posix; declare -ia A; A=x/0; echo AFTER:$?"##, "", 1),
		(r##"f(){ declare -a A; A[bad!]=x; }; f; echo AFTER:$?"##, "", 1),
		(r##"set -o posix; declare -a A; eval 'A[bad!]=x'; echo AFTER:$?"##, "", 1),
		(
			r##"trap 'eval '"'"'set -o posix; declare -a A; A[bad!]=x'"'"'; echo BAD' EXIT; exit 7"##,
			"",
			7,
		),
		(
			r##"set -e; trap 'eval '"'"'set -o posix; declare -a A; A[bad!]=x'"'"'' EXIT; exit 7"##,
			"",
			7,
		),
		(
			r##"trap 'set -e; declare -a A; A[bad!]=x | cat; echo P:${PIPESTATUS[0]}' EXIT; exit 7"##,
			"P:7\n",
			7,
		),
		(r##"set -e; declare -a A; A[bad!]=x & wait $!; echo W:$?"##, "", 1),
		(r##"x=$( declare -a A; A[bad!]=x; echo IN ); echo "[$x] AFTER:$?""##, "[] AFTER:1\n", 0),
	])
	.await;
}

/// A POSIX temporary-environment assignment error is a discard that
/// `eval` catches. Bash 5.2.21 and 5.3.0 continue after `eval`, including
/// when it runs inside an EXIT trap's action.
#[tokio::test(flavor = "multi_thread")]
async fn eval_catches_a_posix_temporary_assignment_error() {
	check(&[
		// A posix temporary-environment assignment error is a discard `eval`
		// and `.` catch.
		(r##"set -o posix; readonly R; eval 'R=x /usr/bin/true'; echo AFTER:$?"##, "AFTER:1\n", 0),
		(
			r##"trap 'eval '"'"'set -o posix; readonly R; R=x /usr/bin/true'"'"'; echo BAD' EXIT; exit 7"##,
			"BAD\n",
			7,
		),
	])
	.await;
}

/// A command substitution in a forked command's words leaves it one
/// simple command: its fatal error lands where its parent's jump would.
/// Bash 5.2.21 and 5.3.0 agree for words, assignments, and redirections.
#[tokio::test(flavor = "multi_thread")]
async fn a_forked_simple_command_keeps_its_error_catch_with_command_substitutions() {
	check(&[
		// A command substitution in the words of a forked simple command.
		(r##": "${u?BOOM}" "$( echo ready )" & wait $!; echo W:$?"##, "W:127\n", 0),
		(r##": "${u?BOOM}" "$( echo ready )" | cat; echo P:${PIPESTATUS[0]}"##, "P:127\n", 0),
		(
			r##"trap 'echo T:$?' EXIT; : "${u?BOOM}" "$( echo ready )" & wait $!; echo W:$?"##,
			"T:127\nW:127\nT:0\n",
			0,
		),
		(r##"x="$( echo a )" : "${u?BOOM}" & wait $!; echo W:$?"##, "W:127\n", 0),
		(r##": "${u?BOOM}" > "$( echo /dev/null )" & wait $!; echo W:$?"##, "W:127\n", 0),
	])
	.await;
}

/// An ignored `eval` status disables `errexit`, but an ignored function
/// status or a condition does not disable it for a fatal expansion error.
/// Bash's `builtin_ignoring_errexit` applies to `eval` and `.`, and Bash
/// 5.2.21 and 5.3.0 give the answers below.
#[tokio::test(flavor = "multi_thread")]
async fn an_ignored_eval_status_disables_errexit_but_an_ignored_function_status_does_not() {
	check(&[
		// `eval` and `.` whose status is ignored turn `errexit` off.
		(
			r##"set -e; if eval ': ${u?BOOM}'; then echo YES; else echo NO:$?; fi; echo AFTER:$?"##,
			"",
			127,
		),
		(
			r##"set -e; if eval ': ${x.y}'; then echo YES; else echo NO:$?; fi; echo AFTER:$?"##,
			"NO:1\nAFTER:0\n",
			0,
		),
		(
			r##"set -e; if eval ': $((7/0))'; then echo YES; else echo NO:$?; fi; echo AFTER:$?"##,
			"NO:1\nAFTER:0\n",
			0,
		),
		(r##"set -e; eval ': ${u?BOOM}' || echo OR:$?; echo AFTER:$?"##, "", 127),
		// A function's ignored status does not, nor does the condition
		// itself.
		(r##"set -e; if : ${u?BOOM}; then echo YES; fi; echo AFTER:$?"##, "", 1),
		(r##"set -e; f(){ : ${u?BOOM}; }; if f; then echo YES; fi; echo AFTER:$?"##, "", 1),
		(r##"set -e; f(){ : ${u?BOOM}; }; f || echo OR:$?; echo AFTER:$?"##, "", 1),
		(
			r##"set -e; if (: ${u?BOOM}); then echo YES; else echo NO:$?; fi; echo AFTER:$?"##,
			"NO:1\nAFTER:0\n",
			0,
		),
	])
	.await;
}

/// An arithmetic error in a word is a discard that `errexit` does not
/// replace. Bash 5.2.21 and 5.3.0 let `eval` catch it and preserve the
/// enclosing catch's status inside an EXIT trap.
#[tokio::test(flavor = "multi_thread")]
async fn an_arithmetic_error_in_a_word_is_a_discard_even_with_errexit() {
	check(&[
		// An arithmetic error in a word: a discard `errexit` does not
		// replace.
		(r##"trap 'set -e; : $((7/0)); echo AFTER:$?' EXIT; exit 7"##, "", 7),
		(r##"trap ': $((7/0)); echo AFTER' EXIT; exit 3"##, "", 3),
		(r##"trap 'trap '"'"': $((7/0))'"'"' DEBUG; :' EXIT; exit 7"##, "", 7),
		(r##"set -e; : $((7/0)) || echo OR:$?; echo AFTER:$?"##, "", 1),
		(r##": $((7/0)); echo AFTER:$?"##, "", 1),
		(r##"f(){ : $((7/0)); }; f; echo AFTER:$?"##, "", 1),
		(r##"eval ': $((7/0))'; echo AFTER:$?"##, "AFTER:1\n", 0),
		(r##"( : $((7/0)); echo IN ); echo AFTER:$?"##, "AFTER:1\n", 0),
		(r##": $((7/0)) & wait $!; echo W:$?"##, "W:1\n", 0),
	])
	.await;
}

/// A bad substitution is a discard that `errexit` replaces with
/// `ERREXIT`; without `errexit`, a nested DEBUG trap keeps its saved
/// status. Bash 5.2.21 and 5.3.0 agree on both answers.
#[tokio::test(flavor = "multi_thread")]
async fn a_bad_substitution_uses_errexit_or_the_nested_traps_saved_status() {
	check(&[
		// A discarded expansion that `errexit` does replace.
		(r##"trap 'set -e; : ${x.y} | /usr/bin/cat; echo P:${PIPESTATUS[0]}' EXIT; exit 7"##, "P:1\n", 7),
		(r##"trap 'trap '"'"': ${x.y}'"'"' DEBUG; :' EXIT; exit 7"##, "", 7),
	])
	.await;
}

/// An assignment's arithmetic error bypasses subshell, command-substitution,
/// function, and nested-trap catches and keeps the status of the enclosing
/// catch. Bash 5.2.21 and 5.3.0 do not let `errexit` replace this jump.
#[tokio::test(flavor = "multi_thread")]
async fn an_assignment_arithmetic_error_keeps_the_status_of_its_enclosing_catch() {
	check(&[
		// An arithmetic error in an assignment: no catch of a subshell, a
		// command substitution or a trap nested in the EXIT trap's action.
		(r##"trap '( declare -i I; I=bad!; echo INNER ); echo AFTER:$?' EXIT; exit 7"##, "AFTER:7\n", 7),
		(
			r##"trap 'v=$( declare -i I; I=bad!; echo IN ); echo "[$v] AFTER:$?"' EXIT; exit 7"##,
			"[] AFTER:7\n",
			7,
		),
		(r##"trap 'trap '"'"'declare -i I; I=bad!'"'"' DEBUG; :' EXIT; exit 7"##, "", 0),
		(r##"( declare -i I; I=bad!; echo IN ); echo AFTER:$?"##, "AFTER:1\n", 0),
		(r##"x=$( declare -i I; I=bad!; echo IN ); echo "[$x] AFTER:$?""##, "[] AFTER:1\n", 0),
		(r##"trap 'declare -i I; I=bad!; echo AFTER' EXIT; exit 3"##, "", 3),
		(r##"trap 'set -e; declare -i I; I=bad!; echo AFTER' EXIT; exit 7"##, "", 7),
		(
			r##"trap 'f(){ declare -i I; I=bad!; echo INNER; }; f | /usr/bin/cat; echo P:${PIPESTATUS[*]}' EXIT; exit 7"##,
			"P:7 0\n",
			7,
		),
		(r##"set -e; f(){ declare -i I; I=bad!; }; if f; then echo YES; fi; echo AFTER:$?"##, "", 1),
	])
	.await;
}

/// A POSIX temporary-environment assignment error inside an EXIT trap's
/// subshell ends that subshell with 1, not the trap's saved status. Bash
/// 5.2.21 and 5.3.0 then continue the action and exit with its saved status.
#[tokio::test(flavor = "multi_thread")]
async fn a_posix_temporary_assignment_error_in_an_exit_trap_ends_only_its_subshell() {
	check(&[
		// A posix temporary-environment assignment error in a subshell of
		// the EXIT trap's action still ends that subshell with 1.
		(
			r##"trap '( set -o posix; readonly R; R=x /usr/bin/true; echo INNER ); echo AFTER:$?' EXIT; exit 7"##,
			"AFTER:1\n",
			7,
		),
	])
	.await;
}

/// A subshell hands its enclosing catch on to its own children, so an
/// assignment's arithmetic error keeps that catch's status through nested
/// subshells and command substitutions. Bash 5.2.21 and 5.3.0 agree.
#[tokio::test(flavor = "multi_thread")]
async fn an_assignment_arithmetic_error_keeps_the_enclosing_catch_through_nested_children() {
	check(&[
		// An assignment's arithmetic error through nested children.
		(
			r##"trap '( ( declare -i I; I=bad! ); echo TWO:$? ); echo ONE:$?' EXIT; exit 7"##,
			"TWO:7\nONE:0\n",
			7,
		),
		(
			r##"trap '( v=$( declare -i I; I=bad! ); echo TWO:$? ); echo ONE:$?' EXIT; exit 7"##,
			"TWO:7\nONE:0\n",
			7,
		),
		(
			r##"trap '( ( declare -a A; A[bad!]=x ); echo TWO:$? )' EXIT; exit 7"##,
			"TWO:7\n",
			7,
		),
		(r##"( ( declare -i I; I=bad! ); echo TWO:$? ); echo ONE:$?"##, "TWO:1\nONE:0\n", 0),
	])
	.await;
}

/// An ERR trap nested in an EXIT trap's action saves the failed command's
/// status, not a constant 1. Bash 5.2.21 and 5.3.0 use that status when a
/// fatal expansion or an assignment's arithmetic error leaves the action.
#[tokio::test(flavor = "multi_thread")]
async fn an_err_trap_nested_in_an_exit_trap_saves_the_failed_commands_status() {
	check(&[
		// An ERR trap nested in the EXIT trap's action starts with the
		// status of the command that failed.
		(r##"trap 'trap '"'"': ${x?boom}'"'"' ERR; (exit 9)' EXIT; exit 7"##, "", 9),
		(r##"trap 'trap '"'"': ${x?boom}'"'"' ERR; (exit 42)' EXIT; exit 7"##, "", 42),
		(r##"trap 'trap '"'"': ${x?boom}'"'"' ERR; false' EXIT; exit 7"##, "", 1),
		(
			r##"trap 'trap '"'"'declare -i I; I=bad!'"'"' ERR; (exit 9)' EXIT; exit 7"##,
			"",
			9,
		),
	])
	.await;
}

/// Bash runs the ERR trap before reading `exit_immediately_on_error`, so
/// the action's `set -e` or `set +e` decides whether the failed command
/// ends the shell. Bash 5.2.21 and 5.3.0 agree even when the action errors.
#[tokio::test(flavor = "multi_thread")]
async fn errexit_is_read_after_the_err_trap_action_ends() {
	check(&[
		// `errexit` is read when the ERR trap action ends.
		(
			r##"trap 'trap '"'"'set -e; : $((7/0)); echo TRAP_BAD'"'"' ERR; (exit 9); echo EXIT_AFTER' EXIT; exit 7"##,
			"",
			9,
		),
		(
			r##"trap 'trap '"'"'set -e; true; : $((7/0)); echo TRAP_BAD'"'"' ERR; (exit 9); echo EXIT_AFTER' EXIT; exit 7"##,
			"",
			9,
		),
		(
			r##"trap 'trap '"'"'set -e; : $((7/0)); echo TRAP_BAD'"'"' ERR; false; echo EXIT_AFTER' EXIT; exit 7"##,
			"",
			1,
		),
		(
			r##"trap 'set -e; trap '"'"'set +e; : ${a.b}; echo TRAP_BAD'"'"' ERR; (exit 9); echo EXIT_AFTER' EXIT; exit 7"##,
			"EXIT_AFTER\n",
			7,
		),
		(
			r##"trap 'set -e; trap '"'"'set +e; : $((7/0)); echo TRAP_BAD'"'"' ERR; (exit 9); echo EXIT_AFTER' EXIT; exit 7"##,
			"EXIT_AFTER\n",
			7,
		),
		(
			r##"trap 'set -e; trap '"'"'set +e; false; echo OK_ERR'"'"' ERR; (exit 9); echo EXIT_AFTER' EXIT; exit 7"##,
			"OK_ERR\nEXIT_AFTER\n",
			7,
		),
	])
	.await;
}

/// A RETURN trap inherited with `set -T` is a nested trap like any other:
/// a jump out of its action carries the status the trap saved. Bash
/// 5.2.21 and 5.3.0 agree; without `set -T`, the function runs no action.
#[tokio::test(flavor = "multi_thread")]
async fn a_return_trap_is_a_nested_trap_like_any_other() {
	check(&[
		// A RETURN trap nested in the EXIT trap's action.
		(
			r##"trap 'set -E -T; trap '"'"': ${review_missing?BOOM}; echo TRAP_BAD'"'"' RETURN; f(){ return 9; }; f; echo EXIT_AFTER' EXIT; exit 7"##,
			"",
			0,
		),
		(
			r##"trap 'set -T; trap '"'"': ${u?BOOM}; echo TB'"'"' RETURN; f(){ (exit 5); return 9; }; f; echo AFTER:$?' EXIT; exit 7"##,
			"",
			5,
		),
		(
			r##"trap 'set -E; trap '"'"': ${review_missing?BOOM}'"'"' RETURN; f(){ return 9; }; f; echo AFTER' EXIT; exit 7"##,
			"AFTER\n",
			7,
		),
	])
	.await;
}

/// An arithmetic error in a `for ((;;))` header ends only that loop with
/// status 1, even with `errexit` set or another loop around it. Bash 5.2.21
/// and 5.3.0 agree; a sound or omitted header still lets the loop run.
#[tokio::test(flavor = "multi_thread")]
async fn an_arithmetic_for_header_error_ends_only_that_loop() {
	check(&[
		// An arithmetic error in a `for ((;;))` header ends only that loop.
		(r##"for ((i=0; 1/0; i++)); do :; done; echo NEXT:$?"##, "NEXT:1\n", 0),
		(r##"set -e; for ((i=0; 1/0; i++)); do :; done; echo NEXT:$?"##, "NEXT:1\n", 0),
		(
			r##"trap 'set -e; for ((i=0; 1/0; i++)); do :; done; echo NEXT:$?' EXIT; exit 7"##,
			"NEXT:1\n",
			7,
		),
		(r##"for ((i=bad!; i<3; i++)); do echo B; done; echo NEXT:$?"##, "NEXT:1\n", 0),
		(r##"for ((i=0; i<3; i=bad!)); do echo B; done; echo NEXT:$?"##, "B\nNEXT:1\n", 0),
		(
			r##"for x in 1 2; do for ((i=0; 1/0; i++)); do :; done; echo IN:$?; done; echo NEXT:$?"##,
			"IN:1\nIN:1\nNEXT:0\n",
			0,
		),
		(
			r##"for ((i=0; i<3; i++)); do for ((j=0; 1/0; j++)); do :; done; echo IN:$?; break; done; echo NEXT:$?"##,
			"IN:1\nNEXT:0\n",
			0,
		),
		// The loop still runs when its header is sound.
		(r##"for ((i=0; i<2; i++)); do echo B$i; done; echo NEXT:$?"##, "B0\nB1\nNEXT:0\n", 0),
		(r##"for ((;;)); do echo ONCE; break; done; echo NEXT:$?"##, "ONCE\nNEXT:0\n", 0),
		(r##"i=0; for ((; i<2; i++)); do echo B$i; done; echo NEXT:$?"##, "B0\nB1\nNEXT:0\n", 0),
	])
	.await;
}

/// `readonly` and `export` reject a subscripted name as an invalid
/// identifier without evaluating its subscript, so the line carries on
/// with status 1. Bash 5.2.21 and 5.3.0 agree on every row.
#[tokio::test(flavor = "multi_thread")]
async fn readonly_and_export_reject_subscripted_names_without_evaluating_them() {
	check(&[
		// `readonly` and `export` reject a subscripted name without
		// evaluating the subscript.
		(r##"readonly "A[bad!]=3"; echo O:AFTER:$?"##, "O:AFTER:1\n", 0),
		(r##"export "A[bad!]=3"; echo O:AFTER:$?"##, "O:AFTER:1\n", 0),
		(r##"eval 'readonly "A[bad!]=3"'; echo O:AFTER:$?"##, "O:AFTER:1\n", 0),
		(r##"eval 'export "A[bad!]=3"'; echo O:AFTER:$?"##, "O:AFTER:1\n", 0),
		(r##"declare -a A; readonly "A[bad!]=3"; echo O:AFTER:$?"##, "O:AFTER:1\n", 0),
		(r##"declare -i A; readonly "A[1/0]=3"; echo O:AFTER:$?"##, "O:AFTER:1\n", 0),
		(r##"readonly "A[1/0]=3"; echo O:AFTER:$?"##, "O:AFTER:1\n", 0),
		(
			r##"trap 'readonly "A[bad!]=3"; echo O:AFTER:$?' EXIT; exit 7"##,
			"O:AFTER:1\n",
			7,
		),
	])
	.await;
}

/// bash's `execute_arith_for_command` evaluates the three header
/// expressions without touching `last_command_exit_value`: the first pass of
/// the body sees the status from before the loop, and a later pass sees the
/// previous pass's. The loop's own result is still 0 when it runs no pass,
/// and 1 when a header expression fails. The engine wrote the header's
/// truth value into the status, which an EXIT action's fatal error then
/// answered with: `trap 'for ((…)); do __r=2; done' EXIT; exit 7` exited 1
/// where both bashes exit 7.
#[tokio::test(flavor = "multi_thread")]
async fn an_arithmetic_for_header_leaves_the_status_alone() {
	check(&[
		(r##"(exit 5); for ((i=0;i<2;i++)); do echo "I:$?"; done; echo A:$?"##, "I:5\nI:0\nA:0\n", 0),
		(
			r##"(exit 5); for ((i=0;i<3;i++)); do echo "I:$?"; (exit 2); done; echo A:$?"##,
			"I:5\nI:2\nI:2\nA:2\n",
			0,
		),
		// A command substitution in any of the three header expressions
		// does set the status, and the header's own arithmetic does not:
		// the body sees the substitution's.
		(
			r##"(exit 5); for ((i=$(echo 0); i<1; i++)); do echo "I:$?"; done; echo A:$?"##,
			"I:0\nA:0\n",
			0,
		),
		(
			r##"(exit 5); for ((i=0; i<$(echo 1); i++)); do echo "I:$?"; done; echo A:$?"##,
			"I:0\nA:0\n",
			0,
		),
		(
			r##"(exit 5); for ((i=0; i<2; i=$(echo $((i+1))) )); do echo "I:$?"; done; echo A:$?"##,
			"I:5\nI:0\nA:0\n",
			0,
		),
		// A test expression that reads `$?` reads the status the header
		// left alone, so the first pass runs and the second does not.
		(r##"(exit 5); for ((i=1;i<$?;i++)); do echo B; done; echo A:$?"##, "B\nA:0\n", 0),
		(r##"false; for ((;;)); do echo "I:$?"; break; done; echo A:$?"##, "I:1\nA:0\n", 0),
		// The loop's own result: 0 with no pass or after `break`, 1 from a
		// failed header expression.
		(r##"(exit 5); for ((i=0;i<0;i++)); do :; done; echo A:$?"##, "A:0\n", 0),
		(r##"(exit 5); for ((i=0;i<1;i++)); do break; done; echo A:$?"##, "A:0\n", 0),
		(r##"(exit 5); for ((i=0; 1/0; i++)); do :; done; echo A:$?"##, "A:1\n", 0),
		// The status an EXIT action's fatal error answers with.
		(
			r##"readonly __r=1; set -e; trap 'for ((j=0;j<1;j++)); do __r=2; done' EXIT; exit 7"##,
			"",
			7,
		),
		(
			r##"readonly __r=1; set -e; trap 'for ((j=0;j<1;j++)); do echo "I:$?"; __r=2; done' EXIT; exit 7"##,
			"I:7\n",
			1,
		),
	])
	.await;
}

/// A `${ ;}` substitution runs in the current shell and its body goes
/// through the same `parse_and_execute` an `eval` or a `.` does, so a
/// discard there ends the substitution and the enclosing command carries
/// on with status 1 and whatever the body wrote before the jump. An
/// assignment's arithmetic error and a fatal expansion error are not
/// discards and still end the shell. `errexit` is off inside the body, as
/// it is inside a `$( )`. Bash 5.2.21 has no such substitution, so Bash
/// 5.3.0 is the oracle for every row of this test.
#[tokio::test(flavor = "multi_thread")]
async fn a_nofork_substitution_catches_a_discard() {
	check(&[
		// Every discard the substitution catches, and what the word keeps.
		(r##"x=${ set -o posix; readonly r=1; r=2 true; }; echo AFTER:$?"##, "AFTER:1\n", 0),
		(r##"set -o posix; readonly r=1; x=${ r=2 true; }; echo AFTER:$?"##, "AFTER:1\n", 0),
		(
			r##"readonly r=1; x=${ echo BEFORE; r=2; echo BAD; }; echo "AFTER:$? <$x>""##,
			"AFTER:1 <BEFORE>\n",
			0,
		),
		(
			r##"x=${ echo BEFORE; : $((1/0)); echo BAD; }; echo "AFTER:$? <$x>""##,
			"AFTER:1 <BEFORE>\n",
			0,
		),
		(
			r##"x=${ echo BEFORE; : ${nope.bad}; echo BAD; }; echo "AFTER:$? <$x>""##,
			"AFTER:1 <BEFORE>\n",
			0,
		),
		// The caller's scope and `REPLY` come back as they do when the
		// body ends normally.
		(
			r##"f(){ local v=outer; x=${ local v=inner; readonly r=1; r=2; }; echo "v=$v x=<$x> s=$?"; }; f"##,
			"v=outer x=<> s=1\n",
			0,
		),
		(r##"x=${| REPLY=hello; readonly r=1; r=2; }; echo "AFTER:$? <$x>""##, "AFTER:1 <hello>\n", 0),
		// `errexit` is off inside the body, and does not convert a jump
		// out of it.
		(r##"set -e; x=${ false; echo AFTER_FALSE; }; echo "DONE:$? <$x>""##, "DONE:0 <AFTER_FALSE>\n", 0),
		(r##"set -e; x=${ : ${review_missing?BOOM}; }; echo AFTER:$?"##, "", 127),
		(r##"set -e; set -u; x=${ : $review_missing; }; echo AFTER:$?"##, "", 127),
		// Controls: the jumps a `${ ;}` does not catch, and the forms that
		// already caught this one.
		(r##"x=${ declare -i I; I=bad!; echo BAD; }; echo AFTER:$?"##, "", 1),
		(r##"x=${ echo BEFORE; : ${review_missing?BOOM}; echo BAD; }; echo AFTER:$?"##, "", 127),
		(r##"x=${ exit 5; }; echo AFTER:$?"##, "", 5),
		(r##"set -o posix; readonly r=1; x=$( r=2 true ); echo AFTER:$?"##, "AFTER:1\n", 0),
		(r##"set -o posix; readonly r=1; eval 'r=2 true'; echo AFTER:$?"##, "AFTER:1\n", 0),
	])
	.await;
}
