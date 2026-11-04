//! zsh/zpty through the obash binary run as `zsh` (a real pty from the
//! process host). Expected output from `/bin/zsh -f -c SCRIPT` 5.9, each
//! script passed whole as the `-c` string.

#![cfg(unix)]

mod obash_support;

use std::os::unix::process::CommandExt;

use crate::obash_support::{obash, output};

/// Run `script` as `zsh -f -c script`: stdout, stderr, status.
fn zsh(script: &str) -> (String, String, i32) {
	let out = output(obash().arg0("zsh").args(["-f", "-c", script]));
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code().unwrap_or(-1),
	)
}

fn check(script: &str, stdout: &str, stderr: &str) {
	let (out, err, status) = zsh(script);
	assert_eq!(out, stdout, "stdout of {script}");
	assert_eq!(err, stderr, "stderr of {script}");
	assert_eq!(status, 0, "status of {script}");
}

#[test]
fn zsh_mod_zpty_reads_a_line_of_cat() {
	check(
		"zmodload zsh/zpty
zpty x cat
zpty -w x hello
zpty -r x line
print -r -- ${(q+)line}
zpty -d x",
		"$'hello\\C-M\\n'\n",
		"",
	);
}

/// `-b`: the read takes what is there (cat has not answered yet).
#[test]
fn zsh_mod_zpty_non_blocking_read_takes_what_is_there() {
	check(
		"zmodload zsh/zpty
zpty -b x cat
zpty -w x hello
zpty -r x line
print -r -- st=$? ${(q+)line}
zpty -d x",
		"st=1 ''\n",
		"",
	);
}

#[test]
fn zsh_mod_zpty_lists_tests_and_echoes() {
	check(
		"zmodload zsh/zpty
zpty -e -b x cat
zpty -b y 'cat; true'
zpty -L
zpty -t x; print t=$?
zpty -d
zpty -L; print end
zpty -e x cat
zpty -w x hi
zpty -r x l1; zpty -r x l2
print -r -- ${(q+)l1} ${(q+)l2}
zpty -d x",
		"zpty -b y 'cat; true'\nzpty -e -b x cat\nt=0\nend\n$'hi\\C-M\\n' $'hi\\C-M\\n'\n",
		"",
	);
}

/// The command runs in a subshell of this shell: its functions are there;
/// a pattern read stops at the match.
#[test]
fn zsh_mod_zpty_runs_a_shell_function_and_reads_to_a_pattern() {
	check(
		r#"zmodload zsh/zpty
f() { print -r -- "in f: $1 ctx=${ZSH_EVAL_CONTEXT#*:} sub=$ZSH_SUBSHELL"; print -n '<PROMPT>'; read -r x; print -r -- "got $x" }
zpty z f arg
zpty -r z out '*<PROMPT>'
print -r -- ${(q+)out}
zpty -w z typed
zpty -r -m z out '*got typed*'
print -r -- st=$? ${(q+)out}
zpty -d z"#,
		"$'in f: arg ctx=zpty:shfunc sub=0\\C-M\\n<PROMPT>'\nst=0 'got typed'\n",
		"",
	);
}

#[test]
fn zsh_mod_zpty_usage_errors() {
	check(
		"zmodload zsh/zpty
zpty
zpty -r; print $?
zpty -r nope; print $?
zpty -rw x; print $?
zpty -dL; print $?
zpty x; print $?
zpty x cat
zpty x cat; print $?
zpty -r x a b c; print $?
zpty -r x a '(' ; print $?
zpty -t; print $?
zpty -d x nope; print $?
zpty y 'echo a; )'; print $?
zpty -L; print end",
		"1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\nend\n",
		"zsh:zpty:3: missing pty command name
zsh:zpty:4: no such pty command: nope
zsh:zpty:5: illegal option combination
zsh:zpty:6: illegal option combination
zsh:zpty:7: missing command
zsh:zpty:9: pty command name already used: x
zsh:zpty:10: too many arguments
zsh:zpty:11: bad pattern: (
zsh:zpty:12: missing pty command name
zsh:zpty:13: no such pty command: nope
(zpty):14: parse error near `)'
",
	);
}

/// `zpty -w` without strings copies standard input; an empty string ends
/// the write with status 1 (zsh's `ptywritestr` wrote nothing).
#[test]
fn zsh_mod_zpty_writes_stdin_and_stops_at_an_empty_string() {
	check(
		"zmodload zsh/zpty
zpty c cat
print a line of text | zpty -w c
var=
zpty -r c var && print -r -- ${var%%$'\\r\\n'}
zpty -n -w c 'no newline'
zpty -w c ' and more'
zpty -r c var
print -r -- ${(q+)var}
zpty -w c a '' b; print w=$?
zpty -d c",
		"a line of text\n$'no newline and more\\C-M\\n'\nw=1\n",
		"",
	);
}

/// Reads after the command finished: what it wrote is still there, and a
/// read without a parameter copies everything to standard output.
#[test]
fn zsh_mod_zpty_reads_the_output_of_a_finished_command() {
	check(
		"zmodload zsh/zpty
zpty d 'print one; print two'
zpty -r d l; print -r -- r=$? ${(q+)l}
zpty -r d l '*two*'; print -r -- r=$? ${(q+)l}
zpty -d d
zpty o 'print -n abc'
zpty -r o; print \" r=$?\"
zpty -d o",
		"r=0 $'one\\C-M\\n'\nr=0 two\nabc r=0\n",
		"",
	);
}

/// Errors of the command's text report under `(zpty)` with the script's
/// line numbers running on into the text.
#[test]
fn zsh_mod_zpty_command_errors_name_zpty() {
	check(
		"zmodload zsh/zpty
:
zpty x \"print \\$LINENO; nosuchcmd
print \\$LINENO\"
zpty -r x l; zpty -r x m; zpty -r x n; print -r -- ${(q+)l} ${(q+)m} ${(q+)n}
zpty -d x",
		"$'3\\C-M\\n' $'(zpty):3: command not found: nosuchcmd\\C-M\\n' $'4\\C-M\\n'\n",
		"",
	);
}

/// The command's `/dev/tty` is the pty, an external started under it has
/// it as its standard input, and output after the external still arrives.
#[test]
fn zsh_mod_zpty_dev_tty_is_the_pty() {
	check(
		"zmodload zsh/zpty
zpty t 'tty >/dev/tty; [[ -t 0 ]] && print stdin-tty; tty; print end'
zpty -r t a; zpty -r t b; zpty -r t c; zpty -r t d
[[ $a == /dev/* && $c == $a ]] && print -r ok ${(q+)b} ${(q+)d}
zpty -d t",
		"ok $'stdin-tty\\C-M\\n' $'end\\C-M\\n'\n",
		"",
	);
}
