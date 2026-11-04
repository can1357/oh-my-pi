//! Redirections that a background command's own process makes, measured
//! against Bash 5.2.21 and 5.3.0 running each script with `bash -c` (the
//! bash tool runs a command string).
//! Each script runs through [`Shell::run`] in a fresh directory.

#![cfg(unix)]

use std::fmt::Write as _;

use super::*;

/// One script and what Bash leaves behind.
struct Row {
	script: &'static str,
	/// FIFOs to create before the run.
	fifos:  &'static [&'static str],
	/// Everything the run writes, with each `NAME: line N: ` prefix removed.
	output: &'static str,
	status: i32,
	/// Files and their contents (prefixes removed); `None`: must not exist.
	files:  &'static [(&'static str, Option<&'static str>)],
}

/// Removes the `NAME: line N: ` prefix Bash and the shell put on their own
/// diagnostics, whose `NAME` differs between them.
fn strip_prefixes(text: &str) -> String {
	text
		.split_inclusive('\n')
		.map(|line| {
			let Some(at) = line.find(": line ") else {
				return line;
			};
			let rest = &line[at + ": line ".len()..];
			let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
			match rest[digits..].strip_prefix(": ") {
				Some(body) if digits > 0 && !line[..at].contains(' ') => body,
				_ => line,
			}
		})
		.collect()
}

async fn check(rows: &[Row]) {
	let mut failures = Vec::new();
	for row in rows {
		let dir = tempfile::tempdir().expect("temp dir");
		for fifo in row.fifos {
			let path =
				std::ffi::CString::new(dir.path().join(fifo).into_os_string().into_encoded_bytes())
					.expect("path");
			// SAFETY: `path` is a NUL-terminated string that outlives the call.
			assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0, "mkfifo {fifo}");
		}
		let (tx, rx) = flume::unbounded::<String>();
		let result = Shell::new(None)
			.run(
				ShellRunOptions {
					command: row.script.to_owned(),
					cwd: Some(dir.path().to_string_lossy().into_owned()),
					..Default::default()
				},
				Some(tx),
				CancelToken::new(Some(10_000)),
			)
			.await
			.expect("run");
		let output = strip_prefixes(&rx.drain().collect::<String>());
		let mut got =
			format!("status {:?} timed_out {}\n{output}", result.exit_code, result.timed_out);
		let mut want = format!("status {:?} timed_out false\n{}", Some(row.status), row.output);
		for (name, contents) in row.files {
			let read = std::fs::read_to_string(dir.path().join(name)).ok();
			let _ = writeln!(got, "-- {name}: {:?}", read.as_deref().map(strip_prefixes));
			let _ = writeln!(want, "-- {name}: {:?}", contents.map(str::to_owned));
		}
		if got != want {
			failures.push(format!("`{}`\n  want: {want:?}\n  got:  {got:?}", row.script));
		}
	}
	assert!(
		failures.is_empty(),
		"{} of {} rows differ from Bash:\n{}",
		failures.len(),
		rows.len(),
		failures.join("\n")
	);
}

/// A background command whose redirections its own process makes (one opens
/// a FIFO) makes them with only the descriptors the command will have, as
/// Bash's child does: under a low `ulimit -n` they fit, and a descriptor of
/// the host process is not there to duplicate.
#[tokio::test(flavor = "multi_thread")]
async fn a_background_command_makes_its_redirections_with_only_its_own_descriptors() {
	check(&[
		Row {
			script: "ulimit -n 9; /bin/cat <f >out & echo hi >f; wait; echo s=$?",
			fifos:  &["f"],
			output: "s=0\n",
			status: 0,
			files:  &[("out", Some("hi\n"))],
		},
		Row {
			script: "/bin/cat pipe >err & ulimit -n 9; /bin/true 2>pipe </nonexistent/BOOM & wait \
			         %2; echo s=$?; wait",
			fifos:  &["pipe"],
			output: "s=1\n",
			status: 0,
			files:  &[("err", Some("/nonexistent/BOOM: No such file or directory\n"))],
		},
		Row {
			script: "/bin/cat f >/dev/null & /bin/sh -c 'echo x' >f 1>&9 2>err & wait $!; echo s=$?; \
			         wait",
			fifos:  &["f"],
			output: "9: Bad file descriptor\ns=1\n",
			status: 0,
			files:  &[("err", None)],
		},
	])
	.await;
}

/// A descriptor the host process holds open without close-on-exec is not
/// one of a background command's own: a duplication of it in the
/// command's redirections fails as in Bash, whose child has only the
/// shell's descriptors. Regression: the process duplicated the host's
/// descriptor and wrote into it.
#[tokio::test(flavor = "multi_thread")]
async fn a_background_command_cannot_duplicate_a_descriptor_only_the_host_holds() {
	let null = std::fs::File::open("/dev/null").expect("open /dev/null");
	// SAFETY: F_DUPFD on an open descriptor returns a new one without
	// close-on-exec; it is closed below.
	let host = unsafe { libc::fcntl(std::os::fd::AsRawFd::as_raw_fd(&null), libc::F_DUPFD, 300) };
	assert!(host >= 300, "dup host descriptor");
	let script: &'static str = Box::leak(
		format!(
			"/bin/cat f >/dev/null & /bin/sh -c 'echo x' >f 1>&{host} 2>err & wait $!; echo s=$?; \
			 wait"
		)
		.into_boxed_str(),
	);
	let output: &'static str =
		Box::leak(format!("{host}: Bad file descriptor\ns=1\n").into_boxed_str());
	check(&[Row { script, fifos: &["f"], output, status: 0, files: &[("err", None)] }]).await;
	// SAFETY: `host` was opened above and is closed once.
	unsafe { libc::close(host) };
}

/// Under the shell's own low `ulimit -n`, process substitutions leave the
/// command room for the descriptors it opens itself, as in Bash. Regression:
/// they took the lowest descriptors, under the command's limit, and the
/// command could not load its libraries.
#[tokio::test(flavor = "multi_thread")]
async fn process_substitutions_leave_room_under_the_shells_own_limit() {
	check(&[Row {
		script: "ulimit -n 10; /bin/cat <(echo 1) <(echo 2) <(echo 3) <(echo 4) <(echo 5) <(echo \
		         6); echo s=$?",
		fifos:  &[],
		output: "1\n2\n3\n4\n5\n6\ns=0\n",
		status: 0,
		files:  &[],
	}])
	.await;
}

/// The shell's own `ulimit -n` does not move its chosen descriptors down:
/// they stay at 63 and below while the host process's limit allows them.
/// This is the one measured divergence from Bash in this file, and the
/// rows below are what it costs and what it buys. Bash chooses by the one
/// limit it has, which is both; here a command is given its descriptors
/// before its own limit is applied, so a high one stays usable while the
/// lowest free ones take the room the command needs for its own opens.
/// Row 1 is the cost: `ulimit -n 48; echo <(true)` prints `/dev/fd/63`
/// where Bash 5.2.21 and 5.3.0 both print `/dev/fd/3`. Row 2 is what it
/// buys: under `ulimit -n 10` eight process substitutions all run, where
/// choosing the lowest free descriptors leaves the command's loader no
/// free number below the limit and it exits 127 with
/// `libc.so.6: cannot open shared object file: Error 24`, and where Bash
/// loses two of the eight to `cannot make pipe for process substitution`.
#[tokio::test(flavor = "multi_thread")]
async fn shell_chosen_descriptors_stay_clear_of_a_lowered_ulimit() {
	check(&[
		Row {
			script: "ulimit -n 48; echo <(true); coproc cat; echo ${COPROC[@]}",
			fifos:  &[],
			output: "/dev/fd/63\n63 60\n",
			status: 0,
			files:  &[],
		},
		Row {
			script: "ulimit -n 10; /bin/cat <(echo a) <(echo b) <(echo c) <(echo d) <(echo e) <(echo \
			         f) <(echo g) <(echo h); echo s=$?",
			fifos:  &[],
			output: "a\nb\nc\nd\ne\nf\ng\nh\ns=0\n",
			status: 0,
			files:  &[],
		},
	])
	.await;
}
