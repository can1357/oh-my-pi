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
///
/// Each row turns the command's status into a word of its own, because the
/// message and the status of a failed write belong to whichever shell
/// `/bin/sh` is (dash gives 2 for a closed stderr, Bash gives 1); what the
/// rows pin is the contract both report: the write fails, the command says
/// so, and the text never reaches the host's own stream or a file.
#[tokio::test(flavor = "multi_thread")]
async fn a_closed_descriptor_stays_closed_in_an_external_command() {
	check(&[
		Row {
			script: "/bin/sh -c 'echo LEAKED >&2' 2>&-; if [ $? -ne 0 ]; then echo closed; fi",
			fifos:  &[],
			output: "closed\n",
			status: 0,
			files:  &[],
		},
		Row {
			script: "/bin/sh -c 'echo LEAKED' >&- 2>e; if [ $? -ne 0 ]; then echo closed; fi; if [ \
			         -s e ]; then echo diagnosed; fi; if grep -q LEAKED e; then echo leaked; fi",
			fifos:  &[],
			output: "closed\ndiagnosed\n",
			status: 0,
			files:  &[],
		},
		Row {
			script: "{ /bin/sh -c 'echo X >&5' 5>&- 2>e; if [ $? -ne 0 ]; then echo closed; fi; } 5>f",
			fifos:  &[],
			output: "closed\n",
			status: 0,
			files:  &[("f", Some(""))],
		},
		// A background command whose FIFO open its own process makes.
		Row {
			script: "/bin/sh -c 'echo LEAKED >&2; if [ $? -ne 0 ]; then echo closed; fi' 2>&- >f & \
			         /bin/cat f; wait $!; echo s=$?",
			fifos:  &["f"],
			output: "closed\ns=0\n",
			status: 0,
			files:  &[],
		},
	])
	.await;
}

/// A text file the kernel refuses with `ENOEXEC` runs as a script, and its
/// commands still find the descriptor the caller closed closed.
///
/// This is where the shell leaves Bash on purpose. Bash 5.2.21 and 5.3.0
/// both recover by starting a shell on the file, and the `open` of the file
/// lands on the lowest free descriptor — descriptor 2 when the caller wrote
/// `2>&-`. Bash leaves it there, so the script's own commands are handed a
/// readable descriptor onto the script's text (`readlink /proc/self/fd/2`
/// in the child names the script). The shell reads the file through the
/// host instead and has no such descriptor, so the slot stays closed, which
/// is what the caller asked for and what every other closed-descriptor row
/// gets. The visible difference is small and in the caller's favour: a
/// failing write to descriptor 2 inside such a script ends the command with
/// the status its shell gives a failed `dup` (2 in dash) instead of the
/// status it gives a failed `write` (1).
#[tokio::test(flavor = "multi_thread")]
async fn a_closed_descriptor_stays_closed_in_a_script_the_kernel_refused() {
	check(&[Row {
		script: "printf '%s\\n' \"/bin/sh -c 'exec 9>&2'\" 'if [ $? -ne 0 ]; then echo fd2-closed; \
		         else echo fd2-open; fi' > sc; chmod +x sc; ./sc 2>&- > out",
		fifos:  &[],
		output: "",
		status: 0,
		files:  &[("out", Some("fd2-closed\n"))],
	}])
	.await;
}
