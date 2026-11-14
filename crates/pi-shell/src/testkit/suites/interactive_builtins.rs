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

fn run_fs(src: &str, fs: crate::testkit::MemFs) -> (String, String, i32) {
	let out = run_script(FakeHost::new().with_fs(fs), src.as_bytes(), &[], Fault::None);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status,
	)
}

/// `history -r` reads a file, `-n` the lines added to it since, `-a`
/// appends the entries of this session (those `-n` read included).
#[test]
fn history_files_read_append_and_read_new() {
	let fs = crate::testkit::MemFs::new();
	fs.add_file("/home/bn", b"a\nb\nc\n", 0o600);
	let (out, err, _) = run_fs(
		"HISTFILE=/home/bn; history -r; echo d >> /home/bn; echo e >> /home/bn; history -n; \
		 history; history -s f; history -a; while IFS= read -r l; do echo \"<$l>\"; done < /home/bn",
		fs,
	);
	assert_eq!(err, "");
	assert_eq!(
		out,
		"    1  a\n    2  b\n    3  c\n    4  d\n    5  e\n<a>\n<b>\n<c>\n<d>\n<e>\n<d>\n<e>\n<f>\n"
	);
}

/// `HISTTIMEFORMAT` stamps entries added while it is set (`??` for the
/// others); `HISTIGNORE` patterns keep lines out.
#[test]
fn history_timestamps_and_histignore() {
	let (out, err) = run(
		"history -s x1; HISTTIMEFORMAT='[%s] '; history -s x2; history; HISTIGNORE='a*:x'; history \
		 -s abc; history -s xy; history -s x; history 2",
	);
	assert_eq!(err, "");
	assert_eq!(
		out,
		"    1  ??x1\n    2  [1700000000] x2\n    2  [1700000000] x2\n    3  [1700000000] xy\n"
	);
}

/// `history -p`: each argument expanded and printed, nothing stored.
#[test]
fn history_p_expands_arguments() {
	let (out, err) = run(
		"history -s 'echo a b c'; history -s 'ls /x/y.tar.gz'; history -p '!!' '!-2:2' '!e:$' \
		 '!!:t:r' '!?a b?' '!!:s/x/Q/' '!#' 'x!y' '\"!!\"' '!!:p'; echo st=$?; history",
	);
	assert_eq!(
		out,
		"ls /x/y.tar.gz\nb\nc\ny.tar\necho a b c\nls /Q/y.tar.gz\n\n\"ls /x/y.tar.gz\"\nls \
		 /x/y.tar.gz\nst=1\n    1  echo a b c\n    2  ls /x/y.tar.gz\n"
	);
	assert_eq!(err, "bash: line 1: history: x!y: history expansion failed\n");
}

/// The `-a` target must be writable; without a file name `HISTFILE` is
/// needed.
#[test]
fn history_file_errors() {
	let (_, err, _) = run_fs(
		"history -s a; history -a /nonexist/z; echo st=$?; unset HISTFILE; history -w; echo st=$?",
		crate::testkit::MemFs::new(),
	);
	assert_eq!(
		err,
		"bash: line 1: history: /nonexist/z: cannot create: No such file or directory\nbash: line \
		 1: history: HISTFILE: parameter null or not set\n"
	);
}

/// An interactive bash with `histexpand` expands each line it reads, shows
/// the result on standard error, and drops a line whose expansion fails.
/// Golden: `bash --norc -i` 5.3.20 reading a pipe (prompts left out).
#[test]
fn interactive_history_expansion() {
	use crate::{
		bash::{Origin, Script, ShellInit},
		testkit::fault::{Rig, skeleton_init},
	};
	let mut init = ShellInit {
		interactive: true,
		options: vec![("history".into(), true), ("histexpand".into(), true)],
		..skeleton_init(&[])
	};
	init.env.push(("PS1".into(), "".into()));
	let input = "echo a\n!!\n!zz\necho st=$?\necho !!:9\necho st=$?\n";
	let mut rig = Rig::new(FakeHost::new().with_stdin(input.as_bytes()), init);
	rig.run(Script { origin: Origin::Stdin, ..Script::command(Vec::new()) }, Fault::None);
	let out = String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned();
	let err = String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned();
	assert_eq!(out, "a\na\nst=0\nst=0\n");
	assert_eq!(err, "echo a\nbash: !zz: event not found\nbash: :9: bad word specifier\n");
}
