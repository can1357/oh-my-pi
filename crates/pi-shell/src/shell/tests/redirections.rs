//! Where an external command's standard streams go under redirections,
//! measured against Bash 5.2.21 and 5.3.0 running each script with `bash -c`
//! (the bash tool runs a command string). Each script runs through
//! [`Shell::run`] in a fresh directory.

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

/// An external command gets a standard descriptor the script closed, or any
/// other descriptor it closed, closed, as in Bash, not the null device: a
/// write to it fails.
#[tokio::test(flavor = "multi_thread")]
async fn a_closed_descriptor_stays_closed_in_an_external_command() {
	check(&[
		Row {
			script: "/bin/sh -c 'echo LEAKED >&2' 2>&-; echo s=$?",
			fifos:  &[],
			output: "s=2\n",
			status: 0,
			files:  &[],
		},
		Row {
			script: "/bin/sh -c 'echo LEAKED' >&-; echo s=$?",
			fifos:  &[],
			output: "/bin/sh: 1: echo: echo: I/O error\ns=1\n",
			status: 0,
			files:  &[],
		},
		Row {
			script: "{ /bin/sh -c 'echo X >&5; echo s=$?' 5>&-; } 5>f",
			fifos:  &[],
			output: "/bin/sh: 1: 5: Bad file descriptor\ns=2\n",
			status: 0,
			files:  &[("f", Some(""))],
		},
		// A background command whose FIFO open its own process makes.
		Row {
			script: "/bin/sh -c 'echo LEAKED >&2; echo st=$?' 2>&- >f & /bin/cat f; wait $!; echo \
			         s=$?",
			fifos:  &["f"],
			output: "st=2\ns=0\n",
			status: 0,
			files:  &[],
		},
	])
	.await;
}
