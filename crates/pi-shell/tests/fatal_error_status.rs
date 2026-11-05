//! The status a shell exits with after a fatal error depends on where the
//! error is caught (bash's `top_level` jumps), not on an `exit` status: every
//! row is the output and exit status of Bash 5.2.21 and 5.3.0 for the same
//! `-c` string (they agree on all of them), run here through `Shell::run`.
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
/// `parse_and_execute` leaves `last_command_exit_value` behind). A RETURN
/// trap is different: its own `return_catch` swallows the jump, so what
/// encloses it decides. The engine exited with the EXIT trap's saved
/// status in every one of them.
#[tokio::test(flavor = "multi_thread")]
async fn a_trap_inside_the_exit_trap_exits_with_the_status_of_the_moment() {
	check(&[
		(r##"trap ': "${zz?B}"' ERR; trap false EXIT; exit 7"##, "", 1),
		(r##"trap ': "${zz?B}"' ERR; trap 'echo S:a; false; echo S:b' EXIT; exit 7"##, "S:a\n", 1),
		(r##"trap 'echo S:E1; : "${zz?B}"; echo S:E2' ERR; trap false EXIT; exit 7"##, "S:E1\n", 1),
		(r##"trap ': "${zz?B}"' ERR; f(){ false; }; trap 'f' EXIT; exit 7"##, "", 1),
		(r##"trap ': "${zz?B}"' ERR; trap 'false' EXIT; exit 0"##, "", 1),
		(r##"trap ': "${zz?B}"' USR1; trap 'kill -USR1 $$; echo S:in $?' EXIT; exit 7"##, "", 0),
		// A RETURN trap's jump is caught by the trap itself.
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

/// Round-2 review rows, each the output and status of Bash 5.2.21 and 5.3.0
/// for the same `-c` string: the innermost trap nested in the EXIT trap's
/// action decides (a DEBUG trap takes its own saved status, an ERR trap the
/// failure status), `errexit` makes the EXIT trap's own jump exit 1, a posix
/// arithmetic-subscript assignment error stays a discard (1, not the fatal
/// 127), and a posix temporary-environment assignment error ends the shell
/// before the command runs.
#[tokio::test(flavor = "multi_thread")]
async fn round_two_rows() {
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
		// `errexit` while the fatal error lands in the EXIT trap.
		(r##"trap 'set -e; : ${x?BOOM}' EXIT; exit 7"##, "", 1),
		(r##"( trap 'set -e; : ${x?BOOM}' EXIT; exit 7 ); echo "S:$?""##, "S:1\n", 0),
		(r##"trap 'set -e; : ${x?BOOM}' EXIT; exit 0"##, "", 1),
		(r##"set -e; trap ': ${x?BOOM}' EXIT; exit 7"##, "", 1),
		// A posix arithmetic-subscript assignment error is a discard.
		(r##"set -o posix; declare -a A; A[bad!]=x; echo BAD"##, "", 1),
		(r##"set -o posix; declare -a A; A[bad!]=x & wait $!; echo "S:$?""##, "S:1\n", 0),
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

/// Round-3 review rows, each the output and status of Bash 5.2.21 and 5.3.0
/// for the same `-c` string. With `errexit` on, bash raises `ERREXIT` where
/// it would have raised its `FORCE_EOF` or its `DISCARD`, and every catch
/// answers that with 1: the EXIT trap's action, a trap nested in it, the
/// shell itself, and a child the shell forked before it expanded anything.
/// An arithmetic error in an assignment is bash's own jump instead: no
/// `eval`, `.` or function contains it, `errexit` does not change it, and it
/// keeps the status of the place it lands. A command substitution in a
/// forked command's words leaves it one simple command, which lands where
/// its parent's jump would have.
#[tokio::test(flavor = "multi_thread")]
async fn round_three_rows() {
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
		// A posix temporary-environment assignment error is a discard `eval`
		// and `.` catch.
		(r##"set -o posix; readonly R; eval 'R=x /usr/bin/true'; echo AFTER:$?"##, "AFTER:1\n", 0),
		(
			r##"trap 'eval '"'"'set -o posix; readonly R; R=x /usr/bin/true'"'"'; echo BAD' EXIT; exit 7"##,
			"BAD\n",
			7,
		),
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
