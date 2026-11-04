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

/// Permission bits alone cannot predict an exec: only the OS knows whether
/// this user may execute it and whether its interpreter exists.
#[tokio::test]
async fn path_search_continues_after_real_exec_refusals() {
	let dir = tempfile::tempdir().expect("scratch directory");
	for name in ["denied", "broken", "good", "loop", "text"] {
		std::fs::create_dir(dir.path().join(name)).unwrap();
	}
	for (path, contents, mode) in [
		("denied/pick", "#!/bin/sh\necho BAD\n", 0o001),
		("broken/pick", "#!/no-such-exec-interpreter-18004\n", 0o755),
		("good/pick", "#!/bin/sh\nprintf 'GOOD:%s\\n' \"$*\"\n", 0o755),
		("text/pick", "printf 'TEXT:%s\\n' \"$*\"\n", 0o755),
		("pick", "printf 'ZERO:%s ARGS:%s\\n' \"$0\" \"$*\"\n", 0o755),
	] {
		let file = dir.path().join(path);
		std::fs::write(&file, contents).unwrap();
		std::fs::set_permissions(file, std::fs::Permissions::from_mode(mode)).unwrap();
	}
	std::os::unix::fs::symlink("pick", dir.path().join("loop/pick")).unwrap();
	let huge = format!("/{}", "a/".repeat(2200));
	let mut wrong = Vec::new();
	for utility in ["env", "xargs"] {
		for (label, path, name) in [
			("empty command", "good".to_owned(), "''"),
			("oversized component", format!("{huge}:good"), "pick"),
			("actual permission class", "denied:good".to_owned(), "pick"),
			("missing interpreter", "broken:good".to_owned(), "pick"),
			("denial survives later missing interpreter", "denied:broken".to_owned(), "pick"),
			("fatal error stops search", "loop:good".to_owned(), "pick"),
			("ENOEXEC invokes sh instead of later program", "text:good".to_owned(), "pick"),
			("an empty PATH entry preserves the fallback script name", String::new(), "pick"),
		] {
			let script = if utility == "env" {
				format!("env PATH='{path}' {name} arg; echo st:$?")
			} else {
				format!("printf 'arg\\n' | env PATH='{path}' xargs {name}; echo st:$?")
			};
			// Absolute utility names preserve the custom PATH for the operand.
			let oracle = script
				.replace("env PATH=", "/usr/bin/env PATH=")
				.replace(" xargs ", " /usr/bin/xargs ");
			let expected = std::process::Command::new("/bin/bash")
				.args(["--noprofile", "--norc", "-c", &oracle])
				.env("LC_ALL", "C")
				.current_dir(dir.path())
				.output()
				.unwrap();
			let expected = (
				String::from_utf8(expected.stdout).unwrap(),
				String::from_utf8(expected.stderr)
					.unwrap()
					.replace("/usr/bin/env:", "env:")
					.replace("/usr/bin/xargs:", "xargs:"),
			);
			let actual = run(dir.path(), &script).await;
			if actual != expected {
				wrong.push(format!("{utility}: {label}: {actual:?}, GNU {expected:?}"));
			}
		}
	}
	assert!(wrong.is_empty(), "{wrong:#?}");
}

#[tokio::test]
async fn inherited_functions_and_aliases_do_not_replace_the_utilitys_control_words() {
	let dir = tempfile::tempdir().unwrap();
	for definition in
		["exec() { echo intercepted; };", "shopt -s expand_aliases; alias exec='echo intercepted'\n"]
	{
		let source = format!("{definition} env no-such-control-word-18004; echo st:$?");
		assert_eq!(
			run(dir.path(), &source).await,
			(
				"st:127\n".to_owned(),
				"env: 'no-such-control-word-18004': No such file or directory\n".to_owned(),
			)
		);
	}
	let got = run(dir.path(), "command() { echo intercepted; }; env true; echo st:$?").await;
	assert_eq!(got, ("st:0\n".to_owned(), String::new()));
	let got = run(
		dir.path(),
		"compgen() { echo intercepted >marker; }; env -i /bin/true; if test -e marker; then echo \
		 bad; else echo isolated; fi",
	)
	.await;
	assert_eq!(got, ("isolated\n".to_owned(), String::new()));
}

#[tokio::test]
async fn user_eval_keeps_its_own_function_and_alias_namespace() {
	let dir = tempfile::tempdir().unwrap();
	let got = run(dir.path(), "command() { printf 'USER:%s\\n' \"$*\"; }; env eval 'command'").await;
	assert_eq!(got, ("USER:\n".to_owned(), String::new()));
	let got =
		run(dir.path(), "shopt -s expand_aliases; alias word='echo USER'\nenv eval word").await;
	assert_eq!(got, ("USER\n".to_owned(), String::new()));
}
