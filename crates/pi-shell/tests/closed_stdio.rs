//! A standard stream closed by the script stays closed in external commands,
//! including while their deferred FIFO redirections run in order.
#![cfg(unix)]

use std::{ffi::CString, path::Path};

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

fn fifo(dir: &Path) {
	let path = CString::new(dir.join("f").as_os_str().as_encoded_bytes()).unwrap();
	// SAFETY: `path` is a valid NUL-terminated path for the duration of the
	// call.
	assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0, "mkfifo");
}

async fn run(dir: &Path, script: &str) -> String {
	let (tx, rx) = flume::unbounded::<String>();
	let result = Shell::new(None)
		.run(
			ShellRunOptions {
				command: script.to_owned(),
				cwd: Some(dir.to_str().unwrap().to_owned()),
				..Default::default()
			},
			Some(tx),
			CancelToken::new(Some(20_000)),
		)
		.await
		.expect("shell run");
	let output = rx.drain().collect::<String>();
	assert!(!result.cancelled && !result.timed_out, "{script}\n{result:?}\n{output}");
	assert_eq!(result.exit_code, Some(0), "{script}\n{output}");
	output
}

#[tokio::test(flavor = "multi_thread")]
async fn deferred_duplication_of_closed_stderr_fails() {
	let dir = tempfile::tempdir().unwrap();
	fifo(dir.path());
	let output = run(
		dir.path(),
		"exec 2>&-; /bin/cat f >out & reader=$!; /bin/echo BAD >f 1>&2 & wait $!; echo s=$?; kill \
		 $reader; wait",
	)
	.await;
	assert_eq!(output, "s=1\n");
	assert_eq!(std::fs::read(dir.path().join("out")).unwrap(), b"");
}

#[tokio::test(flavor = "multi_thread")]
async fn deferred_duplication_of_closed_stdout_fails() {
	let dir = tempfile::tempdir().unwrap();
	fifo(dir.path());
	let output = run(
		dir.path(),
		"exec 3>&1; exec 1>&-; /bin/echo DATA >f & writer=$!; /bin/true <f 2>&1 & wait $!; echo \
		 s=$? >&3; kill $writer 2>/dev/null; wait",
	)
	.await;
	assert!(output.lines().any(|line| line == "s=1"), "{output:?}");
	assert!(output.contains("1: Bad file descriptor"), "{output:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn closed_stdio_without_redirections_is_not_the_null_device() {
	let dir = tempfile::tempdir().unwrap();
	for prefix in ["", "ulimit -n 64; "] {
		for (command, status) in [
			("exec 0<&-; /bin/cat; echo s=$?", "s=1"),
			("exec 3>&1; exec 1>&-; /bin/echo DATA; echo s=$? >&3", "s=1"),
			("exec 2>&-; /bin/sh -c 'echo DATA >&2'; echo s=$?", "s=2"),
		] {
			let output = run(dir.path(), &format!("{prefix}{command}")).await;
			assert!(output.lines().any(|line| line == status), "{prefix}{command}\n{output:?}");
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn deferred_failed_duplication_still_opens_the_fifo_before_failing() {
	let dir = tempfile::tempdir().unwrap();
	fifo(dir.path());
	let output = run(
		dir.path(),
		"ulimit -n 32; exec 2>&-; /bin/cat f >out & reader=$!; /bin/echo BAD >f 1>&2 & wait $!; \
		 echo s=$?; wait $reader; echo reader=$?",
	)
	.await;
	assert_eq!(output, "s=1\nreader=0\n");
	assert_eq!(std::fs::read(dir.path().join("out")).unwrap(), b"");
}

#[tokio::test(flavor = "multi_thread")]
async fn deferred_redirections_can_reopen_a_closed_standard_stream() {
	let dir = tempfile::tempdir().unwrap();
	fifo(dir.path());
	let output = run(
		dir.path(),
		"ulimit -n 32; exec 1>&-; /bin/cat f >out & reader=$!; /bin/echo DATA >f 2>&1 & wait $!; \
		 echo s=$? >&2; wait $reader; echo reader=$? >&2",
	)
	.await;
	assert_eq!(output, "s=0\nreader=0\n");
	assert_eq!(std::fs::read(dir.path().join("out")).unwrap(), b"DATA\n");
}
