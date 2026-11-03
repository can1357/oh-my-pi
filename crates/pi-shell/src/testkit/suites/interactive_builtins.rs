//! Builtins for interactive use (programmable completion, line editing,
//! history re-runs) in a non-interactive shell: they exist and behave as
//! bash's do there instead of failing as unknown commands. Goldens: bash
//! 5.3.20 (`bash -c`).

use crate::testkit::{FakeHost, Fault, run_script};

fn run(src: &str) -> (String, String) {
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
	)
}

/// The history of the `fc` tests: three entries, numbered from 1.
const HISTORY: &str = "history -s 'echo a a b'; history -s 'echo b'; history -s 'printf c\\\\n'; ";

#[test]
fn completion_and_line_editing_builtins_are_accepted() {
	let (out, err) = run(
		"type -t complete compopt bind compgen; complete -F _f foo; echo c=$?; complete -r foo; \
		 echo r=$?; compopt -o nospace; echo o=$?; bind '\"\\C-x\": kill-line'; echo b=$?",
	);
	assert_eq!(out, "builtin\nbuiltin\nbuiltin\nbuiltin\nc=0\nr=0\no=1\nb=0\n");
	assert_eq!(
		err,
		"bash: line 1: compopt: not currently executing completion function\nbash: line 1: bind: \
		 warning: line editing not enabled\n"
	);
}

/// `-W` words, `-P`/`-S` around them, `-X` (with `!`) filtering, `-V` into an
/// array, `IFS` splitting, status 1 without matches, and only bash's own
/// builtins for `-b`.
#[test]
fn compgen_builds_word_lists() {
	let (out, err) = run(
		"compgen -W 'alpha beta' -P x -S y -- al; compgen -W 'alpha beta' -X '!b*'; compgen -W \
		 'alpha  beta' -V arr -- a; declare -p arr; compgen -W alpha -- z; echo st=$?; compgen -b \
		 -- comp; IFS=:; compgen -W 'a:b::c'",
	);
	assert_eq!(err, "");
	assert_eq!(out.lines().collect::<Vec<_>>(), [
		"xalphay",
		"beta",
		"declare -a arr=([0]=\"alpha\")",
		"st=1",
		"compgen",
		"complete",
		"compopt",
		"a",
		"b",
		"c",
	]);
}

/// Listing (`-n`, `-r`, relative and out-of-range numbers) and re-running
/// (`-s` with every `pat=rep` applied, echoed to stderr first).
#[test]
fn fc_lists_and_reruns_history() {
	let (out, err) = run(&format!(
		"{HISTORY}fc -l; fc -lnr; fc -l -2; fc -l 9 2; fc -s a=Z 1; fc -s zz; echo st=$?"
	));
	assert_eq!(out.lines().collect::<Vec<_>>(), [
		"1\t echo a a b",
		"2\t echo b",
		"3\t printf c\\\\n",
		"\t printf c\\\\n",
		"\t echo b",
		"\t echo a a b",
		"2\t echo b",
		"3\t printf c\\\\n",
		"1\t echo a a b",
		"2\t echo b",
		"Z Z b",
		"st=1",
	]);
	assert_eq!(err, "echo Z Z b\nbash: line 1: fc: no command found\n");
}

/// A `-c` shell's history is empty: listing and editing succeed with
/// nothing to do, re-running finds no command.
#[test]
fn fc_with_an_empty_history() {
	let (out, err) = run("fc -l; echo l=$?; fc; echo e=$?; fc -s; echo s=$?");
	assert_eq!(out, "l=0\ne=0\ns=1\n");
	assert_eq!(err, "bash: line 1: fc: no command found\n");
}
