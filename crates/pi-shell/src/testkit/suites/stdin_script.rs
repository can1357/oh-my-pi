//! A script read from standard input (`bash < script`): the engine reads it
//! a line at a time, so commands that read fd 0 consume the lines that
//! follow, and multi-line commands are read to their end (goldens from
//! bash 5.3.20).

use crate::{
	bash::{Origin, Script},
	testkit::{
		FakeHost, Fault,
		fault::{Rig, skeleton_init},
	},
};

fn run(stdin: &str) -> (String, String, i32) {
	let mut rig = Rig::new(FakeHost::new().with_stdin(stdin.as_bytes()), skeleton_init(&[]));
	let status =
		rig.run(Script { origin: Origin::Stdin, ..Script::command(Vec::new()) }, Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

#[test]
fn read_in_the_script_gets_the_next_line() {
	let (out, err, status) = run("read x\nhello\necho got $x\n");
	assert_eq!(out, "got hello\n");
	assert_eq!(err, "");
	assert_eq!(status, 0);
}

#[test]
fn multi_line_commands_and_here_documents_are_read_to_their_end() {
	let (out, err, _) = run(
		"read v <<E\nbody\nE\necho $v\nif true\nthen echo t; fi\nf() {\n echo f\n}\nf\necho a \
		 \\\nb\necho 'x\ny'\n",
	);
	assert_eq!(out, "body\nt\nf\na b\nx\ny\n");
	assert_eq!(err, "");
}

/// Syntax errors print without `-c`, and the rest of the input is not run.
#[test]
fn syntax_errors_report_the_line_without_dash_c() {
	let (out, err, status) = run("echo one\necho (\necho two\n");
	assert_eq!(out, "one\n");
	assert_eq!(
		err,
		"bash: line 2: syntax error near unexpected token `newline'\nbash: line 2: `echo ('\n"
	);
	assert_eq!(status, 2);
}

/// Input that ends inside a command is a syntax error at end of file.
#[test]
fn input_ending_inside_a_command_is_an_eof_error() {
	let (out, err, status) = run("echo one\nif true; then echo two\n");
	assert_eq!(out, "one\n");
	assert_eq!(
		err,
		"bash: line 3: syntax error: unexpected end of file from `if' command on line 2\n"
	);
	assert_eq!(status, 2);
}
