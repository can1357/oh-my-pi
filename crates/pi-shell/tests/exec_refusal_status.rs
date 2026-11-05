//! Every way the kernel can refuse to exec a file the shell FOUND reports
//! the status and the wording Bash 5.3.0 reports, whether the spawn happens
//! at once or is DEFERRED because the command's own redirection blocks.
//!
//! Measured against Bash 5.2.21 (`/usr/bin/bash`) and Bash 5.3.0. The two
//! agree on every cause here except a `#!` interpreter that cannot be
//! found: there 5.2.21 gives 127 and `cannot execute: required file not
//! found`, while 5.3.0 gives 126 and `INTERP: bad interpreter: No such file
//! or directory`. 5.3.0 is this engine's target (`pi-shell` is "the bash 5.3
//! engine"), so 126 and the interpreter's name are what these rows expect.
#![cfg(unix)]

use std::{fs, os::unix::fs::PermissionsExt};

use pi_shell::{Shell, ShellOptions, ShellRunOptions, cancel::CancelToken};

/// One case: the directory to prepare, whether `f` is a FIFO, the script,
/// the script's own exit status, and fragments its output must contain.
struct Row {
	name:   &'static str,
	setup:  fn(&std::path::Path),
	/// Make `f` a FIFO before the script runs. The refused command's own
	/// redirection then blocks on the open, so its spawn is DEFERRED until
	/// the script's other job opens the read end, and the refusal comes
	/// back after that deferral.
	fifo:   bool,
	script: &'static str,
	status: i32,
	wants:  &'static [&'static str],
}

fn write(path: &std::path::Path, text: &str, mode: u32) {
	fs::write(path, text).expect("write");
	fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("chmod");
}

fn make_fifo(path: &std::path::Path) {
	let fifo = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).expect("path");
	// SAFETY: a NUL-terminated path in a fresh temporary directory.
	let rc = unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) };
	assert_eq!(rc, 0, "mkfifo: {}", std::io::Error::last_os_error());
}

fn missing_interpreter(dir: &std::path::Path) {
	write(&dir.join("s"), "#!/does/not/exist\necho hi\n", 0o755);
}

fn interpreter_is_a_directory(dir: &std::path::Path) {
	fs::create_dir_all(dir.join("d")).expect("mkdir");
	write(&dir.join("s"), &format!("#!{}/d\necho hi\n", dir.display()), 0o755);
}

fn interpreter_not_executable(dir: &std::path::Path) {
	write(&dir.join("i"), "#!/bin/sh\n", 0o644);
	write(&dir.join("s"), &format!("#!{}/i\necho hi\n", dir.display()), 0o755);
}

fn interpreter_is_itself_a_script(dir: &std::path::Path) {
	write(&dir.join("i"), "#!/does/not/exist\n", 0o755);
	write(&dir.join("s"), &format!("#!{}/i\necho hi\n", dir.display()), 0o755);
}

fn script_not_executable(dir: &std::path::Path) {
	write(&dir.join("s"), "#!/bin/sh\necho hi\n", 0o644);
}

fn binary_without_shebang(dir: &std::path::Path) {
	write(&dir.join("s"), "\u{0}\u{1}\u{2}BAD\n", 0o755);
}

/// A file the kernel also refuses with `ENOEXEC`, but which both Bash
/// versions RUN as a shell script rather than reporting.
fn text_without_shebang(dir: &std::path::Path) {
	write(&dir.join("s"), "echo hi\n", 0o755);
}

fn a_directory(dir: &std::path::Path) {
	fs::create_dir_all(dir.join("d")).expect("mkdir");
}

fn nothing(_dir: &std::path::Path) {}

fn symlink_loop(dir: &std::path::Path) {
	std::os::unix::fs::symlink("s", dir.join("s")).expect("symlink");
}

/// Immediate spawns. Upstream main already probes the refused file for all
/// of these and answers as Bash 5.3.0 does; they are here so a change to the
/// deferred path cannot quietly break them.
const IMMEDIATE: &[Row] = &[
	Row {
		name:   "missing-interpreter",
		setup:  missing_interpreter,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &["/does/not/exist: bad interpreter: No such file or directory"],
	},
	Row {
		name:   "interpreter-is-itself-a-script",
		setup:  interpreter_is_itself_a_script,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &["bad interpreter: No such file or directory"],
	},
	Row {
		name:   "missing-interpreter-in-a-background-job",
		setup:  missing_interpreter,
		fifo:   false,
		script: "./s & wait $!",
		status: 126,
		wants:  &["/does/not/exist: bad interpreter: No such file or directory"],
	},
	Row {
		name:   "missing-interpreter-through-exec",
		setup:  missing_interpreter,
		fifo:   false,
		script: "( exec ./s )",
		status: 126,
		wants:  &["/does/not/exist: bad interpreter: No such file or directory"],
	},
	Row {
		name:   "interpreter-is-a-directory",
		setup:  interpreter_is_a_directory,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &["bad interpreter: Permission denied"],
	},
	Row {
		name:   "interpreter-not-executable",
		setup:  interpreter_not_executable,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &["bad interpreter: Permission denied"],
	},
	Row {
		name:   "script-not-executable",
		setup:  script_not_executable,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &["Permission denied"],
	},
	Row {
		name:   "binary-without-shebang",
		setup:  binary_without_shebang,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &["cannot execute binary file"],
	},
	Row {
		name:   "a-directory",
		setup:  a_directory,
		fifo:   false,
		script: "./d",
		status: 126,
		wants:  &["Is a directory"],
	},
	Row {
		name:   "no-such-file",
		setup:  nothing,
		fifo:   false,
		script: "./nothing",
		status: 127,
		wants:  &["No such file or directory"],
	},
	Row {
		name:   "symlink-loop",
		setup:  symlink_loop,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &["Too many levels of symbolic links"],
	},
];

/// Deferred spawns: `f` is a FIFO the refused command writes to and another
/// job reads, so the open blocks and the spawn waits. Each script reports
/// the refused command's own status with `echo status=$?`, so the row
/// asserts that status in the output and 0 for the script itself.
const DEFERRED: &[Row] = &[
	Row {
		name:   "deferred-missing-interpreter",
		setup:  missing_interpreter,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &["/does/not/exist: bad interpreter: No such file or directory", "status=126"],
	},
	Row {
		name:   "deferred-missing-interpreter-in-the-foreground",
		setup:  missing_interpreter,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f; echo status=$?; wait $p",
		status: 0,
		wants:  &["/does/not/exist: bad interpreter: No such file or directory", "status=126"],
	},
	Row {
		name:   "deferred-interpreter-not-executable",
		setup:  interpreter_not_executable,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &["bad interpreter: Permission denied", "status=126"],
	},
	Row {
		name:   "deferred-script-not-executable",
		setup:  script_not_executable,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &["Permission denied", "status=126"],
	},
	Row {
		name:   "deferred-a-directory",
		setup:  a_directory,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./d >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &["Is a directory", "status=126"],
	},
	Row {
		name:   "deferred-no-such-file",
		setup:  nothing,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./nothing >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &["No such file or directory", "status=127"],
	},
	Row {
		name:   "deferred-binary-without-shebang",
		setup:  binary_without_shebang,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &["cannot execute binary file", "status=126"],
	},
	Row {
		name:   "deferred-text-without-shebang",
		setup:  text_without_shebang,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &["status=0"],
	},
];

/// Runs every row in a fresh shell and a fresh directory, reporting all
/// mismatches at once.
async fn check(rows: &[Row]) {
	let mut bad = Vec::new();
	for row in rows {
		let dir = tempfile::tempdir().expect("tempdir");
		(row.setup)(dir.path());
		if row.fifo {
			make_fifo(&dir.path().join("f"));
		}
		let shell = Shell::new(Some(ShellOptions::default()));
		let (tx, rx) = flume::unbounded::<String>();
		let result = shell
			.run(
				ShellRunOptions {
					command: row.script.into(),
					cwd: Some(dir.path().to_string_lossy().into_owned()),
					timeout_ms: Some(10_000),
					..Default::default()
				},
				Some(tx),
				CancelToken::new(None),
			)
			.await
			.expect("shell execution");
		let output: String = rx.drain().collect();
		let missing: Vec<&str> =
			row.wants.iter().copied().filter(|w| !output.contains(w)).collect();
		if result.exit_code != Some(row.status) || !missing.is_empty() {
			bad.push(format!(
				"{}: status {:?} (want {}), output {output:?} missing {missing:?}",
				row.name, result.exit_code, row.status
			));
		}
	}
	assert!(bad.is_empty(), "{}", bad.join("\n"));
}

/// A refusal the shell reports before the process exists keeps Bash 5.3.0's
/// status and wording.
#[tokio::test]
async fn an_immediate_refused_exec_reports_bash_5_3_s_status_and_wording() {
	check(IMMEDIATE).await;
}

/// A refusal that arrives after the spawn waited for the command's own
/// blocked redirection reports the same status and wording as one that
/// arrives at once: the file is probed either way.
#[tokio::test]
async fn a_deferred_refused_exec_reports_bash_5_3_s_status_and_wording() {
	check(DEFERRED).await;
}
