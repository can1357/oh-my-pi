//! `set -e`: where a failure exits the shell and where bash ignores it
//! (goldens from bash 5.3.20).

use crate::testkit::{FakeHost, Fault, run_script};

fn run(src: &str) -> (String, i32) {
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	(String::from_utf8_lossy(&out.stdout).into_owned(), out.status)
}

#[test]
fn conditions_lists_and_negation_do_not_exit() {
	let (out, status) = run(
		"set -e; if false; then :; fi; false && true; ! true; while false; do :; done; f() { false; \
		 echo in f; }; f || echo no; echo reached; false; echo not",
	);
	assert_eq!(out, "in f\nreached\n");
	assert_eq!(status, 1);
}

#[test]
fn subshells_inherit_the_context_of_their_command() {
	let (out, status) = run("set -e; (false; echo A $?) && echo B; echo C; (false; echo D); echo E");
	assert_eq!(out, "A 1\nB\nC\n");
	assert_eq!(status, 1);
}

#[test]
fn err_trap_runs_before_the_exit() {
	let (out, status) = run("set -e; trap 'echo err $?' ERR; false; echo no");
	assert_eq!(out, "err 1\n");
	assert_eq!(status, 1);
}

#[test]
fn command_substitution_resets_errexit_unless_inherit_errexit() {
	let (out, status) = run("set -e; echo $(false; echo ok); x=$(false); echo no");
	assert_eq!(out, "ok\n");
	assert_eq!(status, 1);
	let (out, status) = run("shopt -s inherit_errexit; set -e; echo \"[$(false; echo bad)]\"");
	assert_eq!(out, "[]\n");
	assert_eq!(status, 0);
}

#[test]
fn compound_status_alone_does_not_exit_but_a_function_call_does() {
	let (out, status) =
		run("set -e; { false && true; }; for ((i=0; i<2; i++)); do :; done; echo ok");
	assert_eq!(out, "ok\n");
	assert_eq!(status, 0);
	let (out, status) = run("set -e; f() { ! true; }; f; echo no");
	assert_eq!(out, "");
	assert_eq!(status, 1);
}

#[test]
fn functions_and_sourced_text_called_from_a_condition_ignore_it() {
	let (out, status) =
		run("set -e; g() { false; echo in g; }; g && echo t; eval 'false; echo ev' && echo t2");
	assert_eq!(out, "in g\nt\nev\nt2\n");
	assert_eq!(status, 0);
}
