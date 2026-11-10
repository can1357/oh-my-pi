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
	/// Fragments the output must contain. One that begins with `!` must
	/// NOT appear: that is how a row proves the shell did not reach for a
	/// report bash does not make here.
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

/// `/` and 124 `x`: what Bash 5.3.0 names of the interpreter written by
/// [`long_interpreter`], which is one byte shorter than the line.
macro_rules! long_interp {
	() => {
		"/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
	};
}
const LONG_INTERP: &str = long_interp!();

/// The whole report, so the row proves where the name STOPS: one `x` more
/// would not match.
const LONG_WANT: &str = concat!(long_interp!(), ": bad interpreter: No such file or directory");

/// An interpreter of `/` plus 125 `x`, one byte past what bash samples:
/// `#!` plus 126 bytes is 128, and bash names only the first 127 bytes of
/// the file, so it reports [`LONG_INTERP`] and drops the last `x`.
fn long_interpreter(dir: &std::path::Path) {
	assert_eq!(LONG_INTERP.len(), 125, "`#!` plus this must be one byte past the sample");
	write(&dir.join("s"), &format!("#!{LONG_INTERP}x\necho hi\n"), 0o755);
}

/// A `#!` line ending in a carriage return, as a file edited on Windows
/// does. Bash 5.3.0 names the interpreter with the CR shown as `^M`
/// rather than writing the control byte out.
fn interpreter_with_a_carriage_return(dir: &std::path::Path) {
	write(&dir.join("s"), "#!/does/not/exist\r\necho hi\n", 0o755);
}

/// A `#!` line that is ONLY a carriage return. Bash 5.3.0 drops it and
/// names the EMPTY interpreter — there is no `^M` here, because nothing
/// precedes it. (Bash 5.2.21 gives 127 `cannot execute: required file not
/// found`; 5.3.0 wins.)
fn interpreter_is_only_a_carriage_return(dir: &std::path::Path) {
	write(&dir.join("s"), "#!\r", 0o755);
}

/// A `#!` line that is only a carriage return, but WITH a newline after
/// it. Bash 5.3.0 names `^M` here: the byte it drops is the newline, not
/// the CR, so unlike [`interpreter_is_only_a_carriage_return`] the CR is
/// part of the name.
fn carriage_return_interpreter_with_a_newline(dir: &std::path::Path) {
	write(&dir.join("s"), "#!\r\necho hi\n", 0o755);
}

/// An interpreter with a NUL in it. Bash prints the name with `%s`, so
/// the NUL ends it and everything after it is not named.
fn interpreter_with_a_nul(dir: &std::path::Path) {
	write(&dir.join("s"), "#!/does/not/exist\u{0}suffix\necho hi\n", 0o755);
}

/// A `#!` line with no newline at all. bash writes its NUL terminator
/// over the last byte it read, so the last byte of the file is never part
/// of the name: it reports `/does/not/exis`.
fn interpreter_missing_a_newline(dir: &std::path::Path) {
	write(&dir.join("s"), "#!/does/not/exist", 0o755);
}

/// A file of exactly `#!` and nothing else. The terminator lands on the
/// `!`, so bash does not see a `#!` line at all and reports the plain
/// refusal instead of a bad interpreter.
fn only_a_hash_bang(dir: &std::path::Path) {
	write(&dir.join("s"), "#!", 0o755);
}

/// `#!` and nothing but blanks, and no newline at all: bash names an
/// EMPTY interpreter here rather than treating the file as one without a
/// `#!` line.
fn blank_interpreter_without_a_newline(dir: &std::path::Path) {
	write(&dir.join("s"), "#!\t  ", 0o755);
}

/// A script the shell may execute but not read, whose interpreter is
/// missing. Nothing can name that interpreter, so bash reports the file
/// it was given instead, with 127.
fn unreadable_missing_interpreter(dir: &std::path::Path) {
	write(&dir.join("s"), "#!/does/not/exist\necho hi\n", 0o111);
}

/// A script the shell may execute but not read, with no `#!` line at all.
/// The kernel answers `ENOEXEC`, so bash goes on to run the file as a
/// shell script and reports THAT open's error: `Permission denied`, 126.
/// It never calls `check_binary_file`, because it has no sample to call it
/// on, so `cannot execute binary file` is the one thing it does not say.
fn unreadable_text_without_shebang(dir: &std::path::Path) {
	write(&dir.join("s"), "echo hi\n", 0o111);
}

/// The same, with contents that really are binary: unreadable is
/// unreadable, so Bash 5.3.0 reports `Permission denied` here too and the
/// file's contents never come into it.
fn unreadable_binary_without_shebang(dir: &std::path::Path) {
	write(&dir.join("s"), "\u{0}\u{1}\u{2}BAD\n", 0o111);
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
	Row {
		name:   "interpreter-with-a-carriage-return",
		setup:  interpreter_with_a_carriage_return,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &["/does/not/exist^M: bad interpreter: No such file or directory", "!exist\r"],
	},
	Row {
		name:   "interpreter-is-only-a-carriage-return",
		setup:  interpreter_is_only_a_carriage_return,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &["./s: : bad interpreter: No such file or directory", "!^M"],
	},
	Row {
		name:   "carriage-return-interpreter-with-a-newline",
		setup:  carriage_return_interpreter_with_a_newline,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &["./s: ^M: bad interpreter: No such file or directory"],
	},
	Row {
		name:   "interpreter-with-a-nul",
		setup:  interpreter_with_a_nul,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &["./s: /does/not/exist: bad interpreter: No such file or directory", "!suffix"],
	},
	Row {
		name:   "interpreter-missing-a-newline",
		setup:  interpreter_missing_a_newline,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &["./s: /does/not/exis: bad interpreter: No such file or directory"],
	},
	Row {
		name:   "only-a-hash-bang",
		setup:  only_a_hash_bang,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &["!bad interpreter"],
	},
	Row {
		name:   "long-interpreter",
		setup:  long_interpreter,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &[LONG_WANT],
	},
	Row {
		name:   "blank-interpreter-without-a-newline",
		setup:  blank_interpreter_without_a_newline,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &[": bad interpreter: "],
	},
	Row {
		name:   "unreadable-missing-interpreter",
		setup:  unreadable_missing_interpreter,
		fifo:   false,
		script: "./s",
		status: 127,
		wants:  &["cannot execute: required file not found"],
	},
	Row {
		name:   "argument-list-too-long",
		setup:  missing_interpreter,
		fifo:   false,
		script: "x=xxxxxxxxxx; for i in 1 2 3 4 5; do x=$x$x$x$x$x$x$x$x$x$x; done; ./s \"$x\"",
		status: 126,
		wants:  &["Argument list too long", "!bad interpreter"],
	},
	Row {
		name:   "path-lookup-missing-interpreter",
		setup:  missing_interpreter,
		fifo:   false,
		script: "PATH=$PWD:$PATH s",
		status: 126,
		wants:  &["/s: /does/not/exist: bad interpreter: No such file or directory"],
	},
	Row {
		name:   "unreadable-text-without-shebang",
		setup:  unreadable_text_without_shebang,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &["Permission denied", "!cannot execute binary file"],
	},
	Row {
		name:   "unreadable-binary-without-shebang",
		setup:  unreadable_binary_without_shebang,
		fifo:   false,
		script: "./s",
		status: 126,
		wants:  &["Permission denied", "!cannot execute binary file"],
	},
];

/// Deferred spawns: `f` is a FIFO the refused command writes to and another
/// job reads, so the open blocks and the spawn waits. Each script reports
/// the refused command's own status with `echo status=$?`, so the row
/// asserts that status in the output and 0 for the script itself.
///
/// Two rows do NOT reach the forked child's reporter, and are here so the
/// change cannot alter what they do: `deferred-missing-interpreter-in-the-
/// foreground`, whose FIFO an engine I/O worker opens, so the engine
/// reports the refusal itself; and `deferred-text-without-shebang`, which
/// the engine deliberately keeps for its `ENOEXEC` script fallback. Every
/// other row was observed entering the child.
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
	Row {
		name:   "deferred-interpreter-with-a-carriage-return",
		setup:  interpreter_with_a_carriage_return,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &[
			"/does/not/exist^M: bad interpreter: No such file or directory",
			"status=126",
			"!exist\r",
		],
	},
	Row {
		name:   "deferred-interpreter-is-only-a-carriage-return",
		setup:  interpreter_is_only_a_carriage_return,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &["./s: : bad interpreter: No such file or directory", "status=126", "!^M"],
	},
	Row {
		name:   "deferred-carriage-return-interpreter-with-a-newline",
		setup:  carriage_return_interpreter_with_a_newline,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &["./s: ^M: bad interpreter: No such file or directory", "status=126"],
	},
	Row {
		name:   "deferred-interpreter-with-a-nul",
		setup:  interpreter_with_a_nul,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &[
			"./s: /does/not/exist: bad interpreter: No such file or directory",
			"status=126",
			"!suffix",
		],
	},
	Row {
		name:   "deferred-interpreter-missing-a-newline",
		setup:  interpreter_missing_a_newline,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &["./s: /does/not/exis: bad interpreter: No such file or directory", "status=126"],
	},
	Row {
		name:   "deferred-only-a-hash-bang",
		setup:  only_a_hash_bang,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &["status=126", "!bad interpreter"],
	},
	Row {
		name:   "deferred-long-interpreter",
		setup:  long_interpreter,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &[LONG_WANT, "status=126"],
	},
	Row {
		name:   "deferred-blank-interpreter-without-a-newline",
		setup:  blank_interpreter_without_a_newline,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &[": bad interpreter: ", "status=126"],
	},
	Row {
		name:   "deferred-unreadable-missing-interpreter",
		setup:  unreadable_missing_interpreter,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &["cannot execute: required file not found", "status=127"],
	},
	Row {
		name:   "deferred-argument-list-too-long",
		setup:  missing_interpreter,
		fifo:   true,
		script: "x=xxxxxxxxxx; for i in 1 2 3 4 5; do x=$x$x$x$x$x$x$x$x$x$x; done; /bin/cat f >out \
		         & p=$!; ./s \"$x\" >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &["Argument list too long", "status=126", "!bad interpreter"],
	},
	Row {
		name:   "deferred-path-lookup-missing-interpreter",
		setup:  missing_interpreter,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; PATH=$PWD:$PATH s >f & q=$!; wait $q; echo status=$?; wait \
		         $p",
		status: 0,
		wants:  &["/s: /does/not/exist: bad interpreter: No such file or directory", "status=126"],
	},
	Row {
		name:   "deferred-unreadable-text-without-shebang",
		setup:  unreadable_text_without_shebang,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &["Permission denied", "status=126", "!cannot execute binary file"],
	},
	Row {
		name:   "deferred-unreadable-binary-without-shebang",
		setup:  unreadable_binary_without_shebang,
		fifo:   true,
		script: "/bin/cat f >out & p=$!; ./s >f & q=$!; wait $q; echo status=$?; wait $p",
		status: 0,
		wants:  &["Permission denied", "status=126", "!cannot execute binary file"],
	},
];

/// Root's DAC bypass lets `open(O_RDONLY)` succeed on a mode-0111 file, so
/// both Bash 5.3.0 and this engine read the file and answer from its
/// contents instead of from the refused read.  When `geteuid() == 0`,
/// these override the non-root expectation for the mode-0111 rows: the
/// shebang is found and named (126 `bad interpreter` rather than 127
/// `required file not found`), the text file runs as the script it is, and
/// the binary one is recognised as binary.
const ROOT_OVERRIDES: &[(&str, i32, &[&str])] = &[
	("unreadable-missing-interpreter", 126, &[
		"/does/not/exist: bad interpreter: No such file or directory"
	]),
	("deferred-unreadable-missing-interpreter", 0, &[
		"/does/not/exist: bad interpreter: No such file or directory",
		"status=126",
	]),
	("unreadable-text-without-shebang", 0, &["hi"]),
	("deferred-unreadable-text-without-shebang", 0, &["status=0"]),
	("unreadable-binary-without-shebang", 126, &["cannot execute binary file"]),
	("deferred-unreadable-binary-without-shebang", 0, &["cannot execute binary file", "status=126"]),
];

/// Runs every row in a fresh shell and a fresh directory, reporting all
/// mismatches at once.
async fn check(rows: &[Row]) {
	// SAFETY: geteuid is always safe to call.
	let root = unsafe { libc::geteuid() } == 0;
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
		let (status, wants): (i32, &[&str]) = if root {
			ROOT_OVERRIDES
				.iter()
				.find(|(n, ..)| *n == row.name)
				.map(|(_, s, w)| (*s, *w))
				.unwrap_or((row.status, row.wants))
		} else {
			(row.status, row.wants)
		};
		let missing: Vec<&str> = wants
			.iter()
			.copied()
			.filter(|w| match w.strip_prefix('!') {
				Some(absent) => output.contains(absent),
				None => !output.contains(w),
			})
			.collect();
		if result.exit_code != Some(status) || !missing.is_empty() {
			bad.push(format!(
				"{}: status {:?} (want {}), output {output:?} missing {missing:?}",
				row.name, result.exit_code, status
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
