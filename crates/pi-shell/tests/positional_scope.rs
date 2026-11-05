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
