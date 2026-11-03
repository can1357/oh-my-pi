//! `env` and `xargs` report a command they cannot run as GNU coreutils 9.4
//! and findutils do after `execvp`: glibc's choice of error, then status 126,
//! or 127 when nothing has the name.
#![cfg(unix)]

use std::{os::unix::fs::PermissionsExt as _, path::Path};

use bytes::Bytes;
use pi_shell::{ShellExecuteOptions, StreamSinks, cancel::CancelToken, execute_shell_streams};

/// The text of every chunk received so far.
fn received_text(chunks: &flume::Receiver<Bytes>) -> String {
	let mut bytes = Vec::new();
	for chunk in chunks.try_iter() {
		bytes.extend_from_slice(&chunk);
	}
	String::from_utf8_lossy(&bytes).into_owned()
}

/// Runs `script` in a fresh session from `cwd`, returning its stdout and
/// stderr.
async fn run(cwd: &Path, script: &str) -> (String, String) {
	let (stdout, stdout_chunks) = flume::unbounded();
	let (stderr, stderr_chunks) = flume::unbounded();
	let options = ShellExecuteOptions {
		command: script.to_owned(),
		cwd: Some(cwd.to_str().expect("UTF-8 working directory").to_owned()),
		..Default::default()
	};
	execute_shell_streams(
		options,
		StreamSinks { stdout: Some(stdout), stderr: Some(stderr) },
		CancelToken::default(),
	)
	.await
	.expect("shell execution");
	(received_text(&stdout_chunks), received_text(&stderr_chunks))
}

/// Each row's status and diagnostic as GNU's utilities give them (measured
/// with coreutils 9.4 `env` and findutils `xargs`). `d` holds a script `foo`
/// that may not be executed, a directory `dirfoo`, a symbolic link `loop` to
/// itself, and `ok/foo` that may be executed; `long` is a name longer than
/// the file system allows (`NAME_MAX`). An argument list of 30 copies of a
/// 100,000-byte value is past what the OS accepts (`E2BIG`), and the `exec`
/// that fails on it is reported by `env`, not by the shell.
#[tokio::test]
async fn a_command_that_cannot_run_reports_execvp_s_error() {
	let long = "x".repeat(300);
	let big = format!("export P={}; ", "x".repeat(100_000));
	let refs = "${P} ".repeat(30);
	let rows: [(&str, String, String, String); 11] = [
		(
			"name over NAME_MAX, searched",
			format!("env {long}; echo st:$?"),
			"st:126\n".into(),
			format!("env: '{long}': File name too long\n"),
		),
		(
			"name over NAME_MAX, with a slash",
			format!("env ./{long}; echo st:$?"),
			"st:126\n".into(),
			format!("env: './{long}': File name too long\n"),
		),
		(
			"a missing directory moves the search on",
			format!("env PATH=/nonexistent-dir-17793 {long}; echo st:$?"),
			"st:127\n".into(),
			format!("env: '{long}': No such file or directory\n"),
		),
		(
			"a directory in PATH",
			"env PATH=$PWD/d dirfoo; echo st:$?".into(),
			"st:126\n".into(),
			"env: 'dirfoo': Permission denied\n".into(),
		),
		(
			"a symbolic link loop in PATH",
			"env PATH=$PWD/d loop; echo st:$?".into(),
			"st:126\n".into(),
			"env: 'loop': Too many levels of symbolic links\n".into(),
		),
		(
			"a directory named by path",
			"env ./d/dirfoo; echo st:$?".into(),
			"st:126\n".into(),
			"env: './d/dirfoo': Permission denied\n".into(),
		),
		(
			"a file that may not be executed, then a program",
			"env PATH=$PWD/d:$PWD/d/ok foo; echo st:$?".into(),
			"ok\nst:0\n".into(),
			String::new(),
		),
		(
			"xargs, name over NAME_MAX",
			format!("echo a | xargs {long}; echo st:$?"),
			"st:126\n".into(),
			format!("xargs: {long}: File name too long\n"),
		),
		(
			"xargs, a directory in PATH",
			"echo a | env PATH=$PWD/d:/usr/bin:/bin xargs dirfoo; echo st:$?".into(),
			"st:126\n".into(),
			"xargs: dirfoo: Permission denied\n".into(),
		),
		(
			"an argument list too long, program named by path",
			format!("{big}env -S './d/ok/foo {refs}'; echo st:$?"),
			"st:126\n".into(),
			"env: './d/ok/foo': Argument list too long\n".into(),
		),
		(
			"an argument list too long, program found in PATH",
			format!("{big}export PATH=\"$PWD/d/ok:$PATH\"; env -S 'foo {refs}'; echo st:$?"),
			"st:126\n".into(),
			"env: 'foo': Argument list too long\n".into(),
		),
	];
	let mut wrong = Vec::new();
	for (row, script, stdout, stderr) in rows {
		let dir = tempfile::tempdir().expect("scratch directory");
		let d = dir.path().join("d");
		std::fs::create_dir_all(d.join("dirfoo")).expect("directory in PATH");
		std::fs::create_dir_all(d.join("ok")).expect("program directory");
		std::fs::write(d.join("foo"), "echo no\n").expect("unexecutable script");
		std::fs::write(d.join("ok/foo"), "#!/bin/sh\necho ok\n").expect("program");
		std::fs::set_permissions(d.join("ok/foo"), std::fs::Permissions::from_mode(0o755))
			.expect("executable program");
		std::os::unix::fs::symlink("loop", d.join("loop")).expect("symbolic link loop");
		let got = run(dir.path(), &script).await;
		if got != (stdout.clone(), stderr.clone()) {
			wrong.push(format!("{row}: got {got:?}, GNU gives {:?}", (stdout, stderr)));
		}
	}
	assert!(wrong.is_empty(), "{wrong:#?}");
}
