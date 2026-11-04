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
