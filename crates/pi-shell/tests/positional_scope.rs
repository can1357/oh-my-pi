//! Positional parameters and call-frame variables across the `.` and host
//! callout boundaries.
//!
//! The `.` rows were measured on Bash 5.2.21 and Bash 5.3.0, which agree on
//! every one of them. Bash's `timeout` and `nohup` are external programs and
//! cannot run a shell function, so the callout rows have no Bash column: they
//! are pinned to the engine's own `( … )` subshell, whose `FUNCNAME`,
//! `BASH_SOURCE`, `BASH_ARGC`, `BASH_ARGV` and `caller` were measured against
//! both Bash versions.
#![cfg(unix)]

use std::collections::HashMap;

use pi_shell::{Shell, ShellOptions, ShellRunOptions, cancel::CancelToken};

/// Runs `script` in a fresh shell and a fresh directory holding `files`,
/// returning everything it wrote to the caller's fds.
async fn output(files: &[(&str, &str)], script: &str) -> String {
	let session_env = HashMap::from([
		("PI_DISABLE_NOHUP_BUILTIN".into(), "0".into()),
		("PI_DISABLE_UUTILS_BUILTINS".into(), "0".into()),
	]);
	let dir = tempfile::tempdir().expect("tempdir");
	for (name, body) in files {
		std::fs::write(dir.path().join(name), body).expect("write fixture");
	}
	let shell =
		Shell::new(Some(ShellOptions { session_env: Some(session_env), ..Default::default() }));
	let (tx, rx) = flume::unbounded::<String>();
	shell
		.run(
			ShellRunOptions {
				command: script.into(),
				cwd: Some(dir.path().to_string_lossy().into_owned()),
				timeout_ms: Some(20_000),
				..Default::default()
			},
			Some(tx),
			CancelToken::new(None),
		)
		.await
		.expect("shell execution");
	rx.drain().collect()
}

/// Reports every `(files, script, expected output)` row that does not match.
async fn assert_rows(rows: &[(&[(&str, &str)], &str, &str)]) {
	let mut mismatches = Vec::new();
	for &(files, script, want) in rows {
		let got = output(files, script).await;
		if got != want {
			mismatches.push(format!("`{script}`: want {want:?}, got {got:?}"));
		}
	}
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// `. file args` installs its arguments and puts the caller's parameters back
/// when the file ends. Outside any function the file keeps its own only when
/// the `set` builtin replaced them while it ran: `shift` is not that, and
/// `set` back to the very arguments the file was given still is. Measured on
/// Bash 5.2.21 and 5.3.0.
#[tokio::test]
async fn a_sourced_file_keeps_its_parameters_only_after_the_set_builtin() {
	assert_rows(&[
		// The file leaves the parameters alone: the caller's come back.
		(
			&[("lib.sh", ":\n")],
			"set -- p1 p2\n. ./lib.sh A B C\necho \"after: $#:[$*]\"",
			"after: 2:[p1 p2]\n",
		),
		// `set` replaced them: the file's own stay.
		(
			&[("lib.sh", "set -- S1 S2\n")],
			"set -- p1 p2\n. ./lib.sh A B C\necho \"after: $#:[$*]\"",
			"after: 2:[S1 S2]\n",
		),
		// `set --` with nothing after it is still the `set` builtin.
		(
			&[("lib.sh", "set --\n")],
			"set -- p1 p2\n. ./lib.sh A B C\necho \"after: $#:[$*]\"",
			"after: 0:[]\n",
		),
		// `shift` is not the `set` builtin: the caller's parameters come back.
		(
			&[("lib.sh", "shift\n")],
			"set -- p1 p2\n. ./lib.sh A B C\necho \"after: $#:[$*]\"",
			"after: 2:[p1 p2]\n",
		),
		(
			&[("lib.sh", "shift 0\n")],
			"set -- p1 p2\n. ./lib.sh A B C\necho \"after: $#:[$*]\"",
			"after: 2:[p1 p2]\n",
		),
		// `set` with options only changes no parameter.
		(
			&[("lib.sh", "set +x\n")],
			"set -- p1 p2\n. ./lib.sh A B C\necho \"after: $#:[$*]\"",
			"after: 2:[p1 p2]\n",
		),
		// `set` to the very arguments the file was given: still the file's own.
		(
			&[("lib.sh", "set -- A B C\n")],
			"set -- p1 p2\n. ./lib.sh A B C\necho \"after: $#:[$*]\"",
			"after: 3:[A B C]\n",
		),
		// Ending on the installed values after two `set`s keeps them too.
		(
			&[("lib.sh", "set -- S1 S2\nset -- A B C\n")],
			"set -- p1 p2\n. ./lib.sh A B C\necho \"after: $#:[$*]\"",
			"after: 3:[A B C]\n",
		),
		// A subshell of the file changes nothing the file can keep.
		(
			&[("lib.sh", "( set -- Z )\nshift\n")],
			"set -- p1 p2\n. ./lib.sh A B C\necho \"after: $#:[$*]\"",
			"after: 2:[p1 p2]\n",
		),
		// A function the file calls sets its own parameters, not the file's.
		(
			&[("lib.sh", "f\n")],
			"set -- p1 p2\nf() { set -- F1 F2; }\n. ./lib.sh A B C\necho \"after: $#:[$*]\"",
			"after: 2:[p1 p2]\n",
		),
		// A `set` before the `.` does not make the file keep its arguments.
		(
			&[("lib.sh", ":\n")],
			"set -- p1 p2\nset -- q\n. ./lib.sh A B\necho \"after: $#:[$*]\"",
			"after: 1:[q]\n",
		),
		// Without arguments nothing is saved, so the file's `shift` stands.
		(
			&[("lib.sh", "shift\n")],
			"set -- p1 p2\n. ./lib.sh\necho \"after: $#:[$*]\"",
			"after: 1:[p2]\n",
		),
	])
	.await;
}
/// Calling a function, and starting another `.` file whose read fails, both
/// end the enclosing file's record of a `set` of its own, so the caller's
/// parameters come back. Measured on Bash 5.2.21 and 5.3.0.
#[tokio::test]
async fn a_function_call_and_a_failed_source_end_the_set_record() {
	const RUN: &str = "set -- p1 p2\n. ./lib.sh A B C\necho \"after: $#:[$*]\"";
	assert_rows(&[
		// A function call with arguments, and one without.
		(&[("lib.sh", "set -- S1 S2\ng(){ :; }\ng G\n")], RUN, "after: 2:[p1 p2]\n"),
		(&[("lib.sh", "set -- S1 S2\ng(){ :; }\ng\n")], RUN, "after: 2:[p1 p2]\n"),
		// Through `eval`, and nested.
		(&[("lib.sh", "set -- S1 S2\ng(){ :; }\neval g\n")], RUN, "after: 2:[p1 p2]\n"),
		(&[("lib.sh", "set -- S1 S2\nh(){ :; }\ng(){ h; }\ng\n")], RUN, "after: 2:[p1 p2]\n"),
		// A `set` after the call is the file's own again.
		(&[("lib.sh", "g(){ :; }\ng\nset -- S1 S2\n")], RUN, "after: 2:[S1 S2]\n"),
		// The call ran in a subshell, so it ended nothing here.
		(&[("lib.sh", "set -- S1 S2\ng(){ :; }\n( g )\n")], RUN, "after: 2:[S1 S2]\n"),
		(&[("lib.sh", "set -- S1 S2\ng(){ :; }\ng | cat\n")], RUN, "after: 2:[S1 S2]\n"),
		// A builtin and an external end nothing.
		(&[("lib.sh", "set -- S1 S2\ntrue\n:\n")], RUN, "after: 2:[S1 S2]\n"),
		(&[("lib.sh", "set -- S1 S2\n/bin/true\n")], RUN, "after: 2:[S1 S2]\n"),
		// A `.` whose file is missing, or a directory.
		(&[("lib.sh", "set -- S1 S2\n. ./absent Q 2>/dev/null\n")], RUN, "after: 2:[p1 p2]\n"),
		(&[("lib.sh", "set -- S1 S2\n. ./absent 2>/dev/null\n")], RUN, "after: 2:[p1 p2]\n"),
		(
			&[("lib.sh", "set -- S1 S2\nmkdir -p adir\n. ./adir 2>/dev/null\n")],
			RUN,
			"after: 2:[p1 p2]\n",
		),
		// A `.` with no operand at all is a usage error, not a file: it ends
		// nothing.
		(&[("lib.sh", "set -- S1 S2\n. 2>/dev/null\n")], RUN, "after: 2:[S1 S2]\n"),
	])
	.await;
}

/// A sourced file's RETURN trap runs while the file's own parameters and
/// its `BASH_ARGV` push are still in place, and after its `FUNCNAME`,
/// `BASH_SOURCE` and `BASH_LINENO` level has gone. Measured on Bash 5.2.21
/// and 5.3.0.
#[tokio::test]
async fn a_sourced_files_return_trap_runs_before_the_parameters_go_back() {
	let show = "trap 'echo \"  trap: $#:[$*] ARGC=[${BASH_ARGC[*]}] S0=${BASH_SOURCE[0]##*/} \
	            F0=${FUNCNAME[0]}\"' RETURN\n";
	assert_rows(&[
		// At the top level the trap sees the file's parameters, and its own
		// `set` is the file's, so the file keeps it. `BASH_SOURCE` is empty
		// there: the file's level has gone and a command string has no
		// `main` level.
		(
			&[("lib.sh", &format!("{show}set -- IN FILE\n"))],
			"set -- p1 p2\nshopt -s extdebug\n. ./lib.sh A B\necho \"after: $#:[$*]\"",
			"  trap: 2:[IN FILE] ARGC=[2 2] S0= F0=\nafter: 2:[IN FILE]\n",
		),
		(
			&[("lib.sh", &format!("{show}:\n"))],
			"set -- p1 p2\nshopt -s extdebug\n. ./lib.sh A B\necho \"after: $#:[$*]\"",
			"  trap: 2:[A B] ARGC=[2 2] S0= F0=\nafter: 2:[p1 p2]\n",
		),
		// Inside a function the function's parameters always come back, and
		// the function's own RETURN trap runs after them.
		(
			&[("lib.sh", &format!("{show}:\n"))],
			"set -- p1 p2\nshopt -s extdebug\nf() { . ./lib.sh A B; echo \"  f: $#:[$*]\"; }\nf FUN \
			 PARAM\necho \"after: $#:[$*]\"",
			"  trap: 2:[A B] ARGC=[2 2 2] S0=bash F0=f\n  f: 2:[FUN PARAM]\n  trap: 2:[FUN PARAM] \
			 ARGC=[2 2] S0=bash F0=f\nafter: 2:[p1 p2]\n",
		),
	])
	.await;
}

/// The `BASH_ARGV` base is the outermost level, below every `.` file and
/// function call already running: a base pushed while a `.` file runs must
/// list after that file's own push, and must not stop the file putting the
/// caller's parameters back. Measured on Bash 5.2.21 and 5.3.0.
#[tokio::test]
async fn the_argument_base_sits_below_a_running_sourced_file() {
	let arrays = "echo \"  in argc=<${BASH_ARGC[*]}> argv=<${BASH_ARGV[*]}>\"\n";
	assert_rows(&[
		// A `.` without arguments pushes the file name; the base the file's
		// own read adds belongs under it.
		(
			&[("lib.sh", arrays)],
			"set -- ROOT ONE TWO\n. ./lib.sh\necho \"after: $#:[$*]\"",
			"  in argc=<1 3> argv=<./lib.sh TWO ONE ROOT>\nafter: 3:[ROOT ONE TWO]\n",
		),
		// The same with arguments and `extdebug` on from the start.
		(
			&[("lib.sh", arrays)],
			"set -- ROOT ONE TWO\nshopt -s extdebug\n. ./lib.sh X Y\necho \"after: $#:[$*]\"",
			"  in argc=<2 3> argv=<Y X TWO ONE ROOT>\nafter: 3:[ROOT ONE TWO]\n",
		),
		// `extdebug` switched on inside the file, then a read and a `shift`:
		// the caller's parameters still come back.
		(
			&[("lib.sh", "shopt -s extdebug\n: \"${BASH_ARGV[*]}\"\nshift\n")],
			"set -- ROOT ONE TWO\n. ./lib.sh -a -b VALUE\necho \"after: $#:[$*]\"",
			"after: 3:[ROOT ONE TWO]\n",
		),
		// The same with a function call and with a callout as the trigger.
		(
			&[("lib.sh", "shopt -s extdebug\ng(){ :; }\ng\nshift\n")],
			"set -- ROOT ONE TWO\n. ./lib.sh -a -b VALUE\necho \"after: $#:[$*]\"",
			"after: 3:[ROOT ONE TWO]\n",
		),
		(
			&[("lib.sh", "shopt -s extdebug\ntimeout 2 true\nshift\n")],
			"set -- ROOT ONE TWO\n. ./lib.sh -a -b VALUE\necho \"after: $#:[$*]\"",
			"after: 3:[ROOT ONE TWO]\n",
		),
	])
	.await;
}
/// `extdebug` switched on inside the caller still gives a callout's operand
/// the caller's arguments as the `BASH_ARGV` base, not the command the
/// callout runs its operand from.
#[tokio::test]
async fn a_callout_operand_sees_the_callers_argument_base() {
	let report = "report() { echo \"  ARGC=[${BASH_ARGC[*]}] ARGV=[${BASH_ARGV[*]}]\"; }";
	assert_callout_matches_subshell(&[(
		&[],
		&format!(
			"set -- p1 p2\n{report}\nf() {{ shopt -s extdebug; timeout 5 report A B; }}\nf X Y Z"
		),
		&[],
		&format!("set -- p1 p2\n{report}\nf() {{ shopt -s extdebug; ( report A B ); }}\nf X Y Z"),
		"  ARGC=[2 3] ARGV=[B A Z Y X]\n",
	)])
	.await;
}

/// Each `.` file decides on its own: entering one forgets the enclosing
/// file's `set`, and a nested file that ended gives the one around it nothing
/// to keep. Measured on Bash 5.2.21 and 5.3.0.
#[tokio::test]
async fn a_nested_sourced_file_decides_for_the_file_around_it() {
	assert_rows(&[
		// The inner file's `set` reaches the outer file, which keeps it.
		(
			&[
				("inner.sh", "set -- S1 S2\n"),
				(
					"outer.sh",
					"echo \"outer: $#:[$*]\"\n. ./inner.sh N1\necho \"outer-after: $#:[$*]\"\n",
				),
			],
			"set -- p1 p2\n. ./outer.sh O1 O2\necho \"after: $#:[$*]\"",
			"outer: 2:[O1 O2]\nouter-after: 2:[S1 S2]\nafter: 2:[p1 p2]\n",
		),
		// An inner file without arguments still forgets the outer file's `set`.
		(
			&[("inner.sh", ":\n"), ("outer.sh", "set -- S1 S2\n. ./inner.sh\n")],
			"set -- p1 p2\n. ./outer.sh A B C\necho \"after: $#:[$*]\"",
			"after: 2:[p1 p2]\n",
		),
		// A `set` inside the inner file is the outer file's own.
		(
			&[("inner.sh", "set -- I1 I2\n"), ("outer.sh", ". ./inner.sh\n")],
			"set -- p1 p2\n. ./outer.sh A B C\necho \"after: $#:[$*]\"",
			"after: 2:[I1 I2]\n",
		),
		// Two files in a row: the second saves and restores on its own.
		(
			&[("a.sh", "set -- S1 S2\n"), ("b.sh", ":\n")],
			"set -- p1 p2\n. ./a.sh A B\necho \"mid: $#:[$*]\"\n. ./b.sh C D\necho \"after: $#:[$*]\"",
			"mid: 2:[S1 S2]\nafter: 2:[S1 S2]\n",
		),
	])
	.await;
}

/// Inside a function the caller's parameters always come back, whatever the
/// file did to them. Measured on Bash 5.2.21 and 5.3.0.
#[tokio::test]
async fn a_sourced_file_inside_a_function_never_keeps_its_parameters() {
	assert_rows(&[
		(
			&[("lib.sh", "echo \"  lib: $#:[$*]\"\n")],
			"set -- p1 p2\nf() { . ./lib.sh A B; echo \"  f: $#:[$*]\"; }\nf x y z\necho \"after: \
			 $#:[$*]\"",
			"  lib: 2:[A B]\n  f: 3:[x y z]\nafter: 2:[p1 p2]\n",
		),
		(
			&[("lib.sh", "set -- S1 S2\n")],
			"set -- p1 p2\nf() { . ./lib.sh A B; echo \"  f: $#:[$*]\"; }\nf x y z\necho \"after: \
			 $#:[$*]\"",
			"  f: 3:[x y z]\nafter: 2:[p1 p2]\n",
		),
		(
			&[("lib.sh", "shift\n")],
			"set -- p1 p2\nf() { . ./lib.sh A B C; echo \"  f: $#:[$*]\"; }\nf x y z\necho \"after: \
			 $#:[$*]\"",
			"  f: 3:[x y z]\nafter: 2:[p1 p2]\n",
		),
		// Without arguments nothing is saved: the file changes the function's.
		(
			&[("lib.sh", "set -- S1 S2\n")],
			"set -- p1 p2\nf() { . ./lib.sh; echo \"  f: $#:[$*]\"; }\nf x y z\necho \"after: \
			 $#:[$*]\"",
			"  f: 2:[S1 S2]\nafter: 2:[p1 p2]\n",
		),
		// `return` out of the file leaves the function's parameters alone.
		(
			&[("lib.sh", "echo \"  lib: $#:[$*]\"\nreturn 3\n")],
			"set -- p1 p2\nf() { . ./lib.sh A B; echo \"  f: rc=$? $#:[$*]\"; }\nf x y z\necho \
			 \"after: $#:[$*]\"",
			"  lib: 2:[A B]\n  f: rc=3 3:[x y z]\nafter: 2:[p1 p2]\n",
		),
		// An inner file that keeps its own parameters still cannot reach the
		// function's.
		(
			&[("inner.sh", ":\n"), ("outer.sh", "set -- S1 S2\n. ./inner.sh Q\n")],
			"set -- p1 p2\nf() { . ./outer.sh A B; echo \"  f: $#:[$*]\"; }\nf x y z\necho \"after: \
			 $#:[$*]\"",
			"  f: 3:[x y z]\nafter: 2:[p1 p2]\n",
		),
	])
	.await;
}

/// A host callout runs its operand in a subshell of the caller, so the
/// operand must see exactly the call frames an ordinary `( … )` subshell of
/// the same caller sees: `FUNCNAME`, `BASH_SOURCE`, `BASH_LINENO`,
/// `BASH_ARGC`, `BASH_ARGV` and what `caller` reads from them.
///
/// Reports every row where the callout and the subshell disagree, or either
/// differs from the expected output. Each side gets its own fixture files so
/// a library can carry the call under test under one name.
async fn assert_callout_matches_subshell(
	rows: &[(&[(&str, &str)], &str, &[(&str, &str)], &str, &str)],
) {
	let mut mismatches = Vec::new();
	for &(files, callout, control_files, subshell, want) in rows {
		let got = output(files, callout).await;
		let control = output(control_files, subshell).await;
		if got != want || control != want {
			mismatches
				.push(format!("`{callout}`: want {want:?}, callout {got:?}, subshell {control:?}"));
		}
	}
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// A function that reports the call-stack arrays it sees.
const REPORT: &str =
	"report() { echo \"  F0=${FUNCNAME[0]} F1=${FUNCNAME[1]} n=${#FUNCNAME[@]}\"; }";
/// The same report into a file: `nohup` detaches its operand's stdout.
const REPORT_FILE: &str =
	"report() { echo \"  F0=${FUNCNAME[0]} F1=${FUNCNAME[1]} n=${#FUNCNAME[@]}\" > out; }";

#[tokio::test]
async fn a_callout_operand_sees_the_calling_frames() {
	const LIB: &str = "report() { echo \"  F0=${FUNCNAME[0]} F1=${FUNCNAME[1]} n=${#FUNCNAME[@]} \
	                   S0=${BASH_SOURCE[0]##*/}\"; }\n";
	assert_callout_matches_subshell(&[
		// `timeout` and `nohup` run their operand through the engine, so a
		// function operand reads the call-stack arrays there.
		(
			&[],
			&format!("set -- p1 p2\n{REPORT}\nf() {{ timeout 5 report; }}\nf x y"),
			&[],
			&format!("set -- p1 p2\n{REPORT}\nf() {{ ( report ); }}\nf x y"),
			"  F0=report F1=f n=2\n",
		),
		(
			&[],
			&format!(
				"set -- p1 p2\n{REPORT_FILE}\nf() {{ nohup report >/dev/null 2>&1; }}\nf x y\ncat out"
			),
			&[],
			&format!("set -- p1 p2\n{REPORT_FILE}\nf() {{ ( report ); }}\nf x y\ncat out"),
			"  F0=report F1=f n=2\n",
		),
		// A `.` level counts as a frame too.
		(
			&[("lib.sh", &format!("{LIB}timeout 5 report\n"))],
			"f() { . ./lib.sh A B; }\nf x y",
			&[("lib.sh", &format!("{LIB}( report )\n"))],
			"f() { . ./lib.sh A B; }\nf x y",
			"  F0=report F1=source n=3 S0=lib.sh\n",
		),
	])
	.await;
}

/// `caller` reads the same frames, so it names the calling function and its
/// file. Its line is the one the operand was reached from, and a callout
/// reaches its operand from a one-line command of its own, so that line is
/// 1 where an ordinary subshell of the same caller reports the line of the
/// `( … )`.
#[tokio::test]
async fn caller_in_a_callout_operand_names_the_calling_function() {
	assert_rows(&[
		(&[], "report() { caller 0; }\nf() { timeout 5 report; }\nf x y", "1 f bash\n"),
		(&[], "report() { caller 0; }\nf() { ( report ); }\nf x y", "2 f bash\n"),
	])
	.await;
}

/// Under `extdebug` the operand's own arguments sit on `BASH_ARGV` above the
/// caller's function arguments and the shell's own, as in a subshell.
#[tokio::test]
async fn a_callout_operand_sees_the_argument_stack() {
	let report = "report() { echo \"  ARGC=[${BASH_ARGC[*]}] ARGV=[${BASH_ARGV[*]}]\"; }";
	assert_callout_matches_subshell(&[(
		&[],
		&format!("set -- p1 p2\n{report}\nshopt -s extdebug\nf() {{ timeout 5 report r1; }}\nf x y"),
		&[],
		&format!(
			"set -- p1 p2\n{report}\nshopt -s extdebug\nf() {{ ( set -- report r1; report r1 ); \
			 }}\nf x y"
		),
		"  ARGC=[1 2 2] ARGV=[r1 y x p2 p1]\n",
	)])
	.await;
}

/// The frames a callout operand gains must not cost it what it already had:
/// the caller's locals, and its own arguments rather than the caller's
/// (can1357/oh-my-pi#18030).
#[tokio::test]
async fn a_callout_operand_keeps_its_own_arguments_and_the_callers_locals() {
	assert_rows(&[(
		&[],
		"report() { echo \"  l=$local_value a=$1 n=$#\"; }\nf() { local local_value=local; timeout \
		 5 report argument; }\nf caller",
		"  l=local a=argument n=1\n",
	)])
	.await;
}

/// A write to the positional parameters that a callout's launch makes must not
/// outlive the operand. The launch vector is the operand command's own `$@`,
/// so whatever runs in the caller's frame after the operand returns — an EXIT
/// trap the operand installed, the rest of the caller — reads the caller's
/// parameters again, as it does in an ordinary `( … )` subshell of the same
/// caller. Measured on Bash 5.2.21 and 5.3.0 (`explore/gen8.py` rows c1-c4),
/// which agree on every row.
#[tokio::test]
async fn a_callouts_launch_vector_does_not_outlive_its_operand() {
	const EXIT_TRAP: &str =
		"report() { trap 'echo \"  EXIT=[$*] n=$# F=${FUNCNAME[0]:-none}\"' EXIT; }";
	const EXIT_TRAP_FILE: &str =
		"report() { trap 'echo \"  EXIT=[$*] n=$# F=${FUNCNAME[0]:-none}\" > out' EXIT; }";
	assert_callout_matches_subshell(&[
		// `timeout` builds its subshell with `run_subshell_in`.
		(
			&[],
			&format!("set -- s1 s2\n{EXIT_TRAP}\nf() {{ timeout 5 report OWN ARG; }}\nf F1 F2"),
			&[],
			&format!("set -- s1 s2\n{EXIT_TRAP}\nf() {{ ( report OWN ARG ); }}\nf F1 F2"),
			"  EXIT=[F1 F2] n=2 F=f\n",
		),
		// `extdebug` pushes an argument base as well, and changes nothing here.
		(
			&[],
			&format!(
				"set -- s1 s2\nshopt -s extdebug\n{EXIT_TRAP}\nf() {{ timeout 5 report OWN ARG; }}\nf \
				 F1 F2"
			),
			&[],
			&format!(
				"set -- s1 s2\nshopt -s extdebug\n{EXIT_TRAP}\nf() {{ ( report OWN ARG ); }}\nf F1 F2"
			),
			"  EXIT=[F1 F2] n=2 F=f\n",
		),
		// Outside any function the shell's own parameters are what remain.
		(
			&[],
			&format!("set -- s1 s2\n{EXIT_TRAP}\ntimeout 5 report OWN ARG"),
			&[],
			&format!("set -- s1 s2\n{EXIT_TRAP}\n( report OWN ARG )"),
			"  EXIT=[s1 s2] n=2 F=none\n",
		),
		// `nohup` builds its subshell with `exec_subshell_in` instead, and
		// detaches the operand's output, so the trap writes to a file.
		(
			&[],
			&format!(
				"set -- s1 s2\n{EXIT_TRAP_FILE}\nf() {{ nohup report OWN ARG >/dev/null 2>&1; }}\nf \
				 F1 F2\ncat out"
			),
			&[],
			&format!(
				"set -- s1 s2\n{EXIT_TRAP_FILE}\nf() {{ ( report OWN ARG ); }}\nf F1 F2\ncat out"
			),
			"  EXIT=[F1 F2] n=2 F=f\n",
		),
	])
	.await;
}

/// The operand's own run is what the launch vector belongs to, so a RETURN
/// trap of the operand — which runs inside it — still reads the operand's own
/// arguments. Measured on Bash 5.2.21 and 5.3.0 (`explore/gen8.py` rows
/// c5-c7).
#[tokio::test]
async fn a_callout_operands_return_trap_still_reads_its_own_arguments() {
	const RETURN_TRAP: &str = "report() { trap 'trap - RETURN; echo \"  RETURN=[$*] n=$# \
	                           F=${FUNCNAME[0]:-none}\"' RETURN; :; }";
	const RETURN_TRAP_FILE: &str = "report() { trap 'trap - RETURN; echo \"  RETURN=[$*] n=$# \
	                                F=${FUNCNAME[0]:-none}\" > out' RETURN; :; }";
	assert_callout_matches_subshell(&[
		(
			&[],
			&format!("set -- s1 s2\n{RETURN_TRAP}\nf() {{ timeout 5 report OWN ARG; }}\nf F1 F2"),
			&[],
			&format!("set -- s1 s2\n{RETURN_TRAP}\nf() {{ ( report OWN ARG ); }}\nf F1 F2"),
			"  RETURN=[OWN ARG] n=2 F=report\n",
		),
		(
			&[],
			&format!(
				"set -- s1 s2\nshopt -s extdebug\n{RETURN_TRAP}\nf() {{ timeout 5 report OWN ARG; \
				 }}\nf F1 F2"
			),
			&[],
			&format!(
				"set -- s1 s2\nshopt -s extdebug\n{RETURN_TRAP}\nf() {{ ( report OWN ARG ); }}\nf F1 \
				 F2"
			),
			"  RETURN=[OWN ARG] n=2 F=report\n",
		),
		(
			&[],
			&format!(
				"set -- s1 s2\n{RETURN_TRAP_FILE}\nf() {{ nohup report OWN ARG >/dev/null 2>&1; }}\nf \
				 F1 F2\ncat out"
			),
			&[],
			&format!(
				"set -- s1 s2\n{RETURN_TRAP_FILE}\nf() {{ ( report OWN ARG ); }}\nf F1 F2\ncat out"
			),
			"  RETURN=[OWN ARG] n=2 F=report\n",
		),
	])
	.await;
}

/// An `exit` from inside the operand runs the EXIT trap above the operand's
/// own frames, so that trap reads the operand's arguments, not the caller's:
/// the launch vector ends with the operand's run, not before its traps.
/// Measured on Bash 5.2.21 and 5.3.0 (`explore/gen8.py` rows c8-c9).
///
/// The engine's own `( … )` subshell cannot be the control here: it unwinds
/// the function's frames before it starts its EXIT trap, so it prints
/// `EXIT=[F1 F2] F=[f]` where both Bash versions print the operand's. That is
/// a defect of the ordinary subshell's exit path, present at main and
/// untouched by this change; these rows pin the callout against Bash.
#[tokio::test]
async fn an_exit_inside_a_callout_operand_keeps_the_operands_arguments() {
	const EXIT_TRAP: &str =
		"report() { trap 'echo \"  EXIT=[$*] F=[${FUNCNAME[*]}]\"' EXIT; exit 4; }";
	assert_rows(&[
		(
			&[],
			&format!(
				"set -- s1 s2\n{EXIT_TRAP}\nf() {{ timeout 5 report OWN ARG; echo \"  rc=$?\"; }}\nf \
				 F1 F2"
			),
			"  EXIT=[OWN ARG] F=[report f]\n  rc=4\n",
		),
		(
			&[],
			&format!(
				"set -- s1 s2\nshopt -s extdebug\n{EXIT_TRAP}\nf() {{ timeout 5 report OWN ARG; echo \
				 \"  rc=$?\"; }}\nf F1 F2"
			),
			"  EXIT=[OWN ARG] F=[report f]\n  rc=4\n",
		),
	])
	.await;
}

/// The launch vector is the operand command's own words, so the operand's own
/// write to the positional parameters is a write to the subshell's — which
/// are the caller's — and is what everything after the operand reads. A
/// builtin operand is the case that shows it: `eval` runs shell code in the
/// subshell itself, where `set --` and `shift` reach the parameters, unlike a
/// function operand, whose own scope they reach instead.
///
/// Measured on Bash 5.2.21 and 5.3.0 (`explore/gen10.py` rows r1, r2, r3, r5,
/// r6, r10, r11), which agree on every row.
#[tokio::test]
async fn a_callout_operands_own_parameter_writes_outlive_it() {
	// One single-quoted word for the `eval` operand, as the shell needs it.
	fn operand(body: &str) -> String {
		format!("'{}'", body.replace('\'', "'\\''"))
	}
	let trap = "trap 'printf \"  EXIT=[%s] n=%s F=[%s]\\n\" \"$*\" \"$#\" \"${FUNCNAME[*]}\"' EXIT";
	let set = operand(&format!("set -- o1 o2; {trap}"));
	let shift = operand(&format!("shift; {trap}"));
	let source = operand(&format!(". ./lib L1; {trap}"));
	let call = operand(&format!("set -- o1 o2; leaf L; {trap}"));
	assert_callout_matches_subshell(&[
		// `set --` in the operand: its values are what the EXIT trap reads.
		(
			&[],
			&format!("set -- c1 c2\nf() {{ timeout 5 eval {set}; }}\nf F1 F2"),
			&[],
			&format!("set -- c1 c2\nf() {{ ( eval {set} ); }}\nf F1 F2"),
			"  EXIT=[o1 o2] n=2 F=[f]\n",
		),
		// The same outside any function, and through `nohup`'s builder.
		(
			&[],
			&format!("set -- c1 c2\ntimeout 5 eval {set}"),
			&[],
			&format!("set -- c1 c2\n( eval {set} )"),
			"  EXIT=[o1 o2] n=2 F=[]\n",
		),
		(
			&[],
			&format!("set -- c1 c2\nf() {{ nohup eval {set} 2>/dev/null; }}\nf F1 F2"),
			&[],
			&format!("set -- c1 c2\nf() {{ ( eval {set} ); }}\nf F1 F2"),
			"  EXIT=[o1 o2] n=2 F=[f]\n",
		),
		// `shift` shifts the caller's parameters, not the launch vector.
		(
			&[],
			&format!("set -- c1 c2\nf() {{ timeout 5 eval {shift}; }}\nf F1 F2 F3"),
			&[],
			&format!("set -- c1 c2\nf() {{ ( eval {shift} ); }}\nf F1 F2 F3"),
			"  EXIT=[F2 F3] n=2 F=[f]\n",
		),
		// A `.` inside the operand saves and restores the caller's, so the
		// trap reads the caller's whether or not the file replaced them.
		(
			&[("lib", "printf '  LIB=[%s]\\n' \"$*\"\n")],
			&format!("set -- c1 c2\nf() {{ timeout 5 eval {source}; }}\nf F1 F2"),
			&[("lib", "printf '  LIB=[%s]\\n' \"$*\"\n")],
			&format!("set -- c1 c2\nf() {{ ( eval {source} ); }}\nf F1 F2"),
			"  LIB=[L1]\n  EXIT=[F1 F2] n=2 F=[f]\n",
		),
		(
			&[("lib", "set -- S1 S2\n")],
			&format!("set -- c1 c2\nf() {{ timeout 5 eval {source}; }}\nf F1 F2"),
			&[("lib", "set -- S1 S2\n")],
			&format!("set -- c1 c2\nf() {{ ( eval {source} ); }}\nf F1 F2"),
			"  EXIT=[F1 F2] n=2 F=[f]\n",
		),
		// A function the operand calls gets its own arguments and leaves the
		// operand's write standing.
		(
			&[],
			&format!(
				"set -- c1 c2\nleaf() {{ printf '  LEAF=[%s]\\n' \"$*\"; }}\nf() {{ timeout 5 eval \
				 {call}; }}\nf F1 F2"
			),
			&[],
			&format!(
				"set -- c1 c2\nleaf() {{ printf '  LEAF=[%s]\\n' \"$*\"; }}\nf() {{ ( eval {call} ); \
				 }}\nf F1 F2"
			),
			"  LEAF=[L]\n  EXIT=[o1 o2] n=2 F=[f]\n",
		),
		// `extdebug` changes none of it.
		(
			&[],
			&format!("set -- c1 c2\nshopt -s extdebug\nf() {{ timeout 5 eval {set}; }}\nf F1 F2"),
			&[],
			&format!("set -- c1 c2\nshopt -s extdebug\nf() {{ ( eval {set} ); }}\nf F1 F2"),
			"  EXIT=[o1 o2] n=2 F=[f]\n",
		),
	])
	.await;
}

/// A cleanup trap an operand installs removes the operand's own names, not
/// the caller's: the same defect where it costs a user data. Measured on Bash
/// 5.2.21 and 5.3.0 (`explore/gen9.py` row r7).
#[tokio::test]
async fn a_cleanup_trap_in_a_callout_operand_removes_the_operands_names() {
	let body = "set -- operand-owned; trap 'rm -f -- \"$@\"' EXIT".replace('\'', "'\\''");
	let report = "printf '  caller=%s operand=%s\\n' \"$(test -e caller-owned && echo yes || echo \
	              no)\" \"$(test -e operand-owned && echo yes || echo no)\"";
	assert_rows(&[(
		&[],
		&format!(
			": > caller-owned\n: > operand-owned\nset -- caller-owned\nf() {{ timeout 5 eval \
			 '{body}'; }}\nf caller-owned\n{report}"
		),
		"  caller=yes operand=no\n",
	)])
	.await;
}

/// A callout inside a callout's operand is a subshell of a subshell: the
/// inner operand's EXIT trap reads the parameters of the function that ran the
/// outer callout, never the outer callout's own command line. Measured on
/// Bash 5.2.21 and 5.3.0 (`explore/gen9.py` rows r8, r9) with each wrapper
/// replaced by a `( … )` of the same caller.
#[tokio::test]
async fn a_nested_callout_does_not_expose_the_outer_launch_vector() {
	const LEAF: &str = "leaf() { local l=leaf; trap 'printf \"  EXIT=[%s]:%s:[%s]\\n\" \"$*\" \
	                    \"$l\" \"${FUNCNAME[*]}\"' EXIT; printf '  LEAF=[%s]:%s:[%s]\\n' \"$*\" \
	                    \"$l\" \"${FUNCNAME[*]}\"; }";
	const TAIL: &str =
		"f() { local l=outer; mid M1 M2; printf '  OUTER=[%s]:%s\\n' \"$*\" \"$l\"; }\nf F1 F2";
	let want = "  LEAF=[OWN ARG]:leaf:[leaf mid f]\n  EXIT=[M1 M2]:mid:[mid f]\n  MID=[M1 \
	            M2]:mid\n  OUTER=[F1 F2]:outer\n";
	let mid = |inner: &str| {
		format!("mid() {{ local l=mid; {inner}; printf '  MID=[%s]:%s\\n' \"$*\" \"$l\"; }}\n{TAIL}")
	};
	assert_callout_matches_subshell(&[
		(
			&[],
			&format!("set -- ROOT ONE\n{LEAF}\n{}", mid("timeout 5 timeout 5 leaf OWN ARG")),
			&[],
			&format!("set -- ROOT ONE\n{LEAF}\n{}", mid("( ( leaf OWN ARG ) )")),
			want,
		),
		(
			&[],
			&format!("set -- ROOT ONE\n{LEAF}\n{}", mid("nohup timeout 5 leaf OWN ARG 2>/dev/null")),
			&[],
			&format!("set -- ROOT ONE\n{LEAF}\n{}", mid("( ( leaf OWN ARG ) )")),
			want,
		),
	])
	.await;
}

/// A builtin that is the operand itself reads the caller's parameters, not
/// the words the callout was launched with: `getopts` parses `-a value`,
/// and `shift` shifts what the caller has. The operand's words are one
/// command of the subshell, exactly as in the `( … )` the callout stands
/// for. Measured on Bash 5.2.21 and 5.3.0, which agree on every row.
#[tokio::test]
async fn a_direct_builtin_operand_reads_the_callers_parameters() {
	assert_callout_matches_subshell(&[
		// `getopts a opt` on `-a value` succeeds; on the launch words
		// (`getopts a opt`) it finds no option and returns 1.
		(
			&[],
			"set -- -a value\ntimeout 5 getopts a opt\nprintf 'rc=%s\\n' \"$?\"",
			&[],
			"set -- -a value\n( getopts a opt )\nprintf 'rc=%s\\n' \"$?\"",
			"rc=0\n",
		),
		(
			&[],
			"set -- -a value\nenv getopts a opt\nprintf 'rc=%s\\n' \"$?\"",
			&[],
			"set -- -a value\n( getopts a opt )\nprintf 'rc=%s\\n' \"$?\"",
			"rc=0\n",
		),
		// `shift 2` with one parameter fails; the launch words are two, so
		// reading those made it succeed.
		(
			&[],
			"set -- p1\ntimeout 5 shift 2\nprintf 'rc=%s n=%s\\n' \"$?\" \"$#\"",
			&[],
			"set -- p1\n( shift 2 )\nprintf 'rc=%s n=%s\\n' \"$?\" \"$#\"",
			"rc=1 n=1\n",
		),
		// Bare `shift` with no parameter at all fails the same way.
		(
			&[],
			"set --\ntimeout 5 shift\nprintf 'rc=%s n=%s\\n' \"$?\" \"$#\"",
			&[],
			"set --\n( shift )\nprintf 'rc=%s n=%s\\n' \"$?\" \"$#\"",
			"rc=1 n=0\n",
		),
		// A shift the operand can make shifts the caller's parameters, and
		// the subshell keeps it to itself.
		(
			&[],
			"set -- p1 p2\ntimeout 5 shift\nprintf 'rc=%s n=%s\\n' \"$?\" \"$#\"",
			&[],
			"set -- p1 p2\n( shift )\nprintf 'rc=%s n=%s\\n' \"$?\" \"$#\"",
			"rc=0 n=2\n",
		),
	])
	.await;
}
