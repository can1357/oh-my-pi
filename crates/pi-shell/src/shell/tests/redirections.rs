//! How redirections behave, measured against Bash 5.2.21 and 5.3.0
//! running each script with `bash -c` (the bash tool runs a command string).
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

/// `&>file` and `>&file` refuse an existing regular file under `set -o
/// noclobber`, as `>file` does; `>|`, `&>>` and a file that is not regular
/// are written.
#[tokio::test(flavor = "multi_thread")]
async fn noclobber_covers_every_output_redirection_that_truncates() {
	let row = |script, fifos, output| Row { script, fifos, output, status: 0, files: &[] };
	check(&[
		row(
			"set -o noclobber; echo a > f; echo b &>f; echo s1=$?; echo c >&f; echo s2=$?; cat f",
			&[],
			"f: cannot overwrite existing file\ns1=1\nf: cannot overwrite existing file\ns2=1\na\n",
		),
		row(
			"set -o noclobber; echo b &>f; echo s1=$?; echo c >&g; echo s2=$?; cat f g",
			&[],
			"s1=0\ns2=0\nb\nc\n",
		),
		row("set -o noclobber; echo a > f; echo b &>>f; echo s=$?; cat f", &[], "s=0\na\nb\n"),
		row("set -o noclobber; echo a > f; echo b >|f; echo s=$?; cat f", &[], "s=0\nb\n"),
		row(
			"set -o noclobber; /bin/cat p >got & echo x >p; echo s=$?; wait; cat got",
			&["p"],
			"s=0\nx\n",
		),
		row(
			"set -o noclobber; echo b &>/dev/null; echo s1=$?; echo c >&/dev/null; echo s2=$?",
			&[],
			"s1=0\ns2=0\n",
		),
		row(
			"set -o noclobber; /bin/cat p >got & echo x &>p; echo s=$?; wait; cat got",
			&["p"],
			"s=0\nx\n",
		),
		row(
			"set -o noclobber; echo a >f; /bin/cat p >/dev/null & /bin/echo b >p &>f & wait $!; echo \
			 s=$?; wait; cat f",
			&["p"],
			"f: cannot overwrite existing file\ns=1\na\n",
		),
		// The file changes kind between the shell's look and the background
		// command's own open (a FIFO before it is replaced by a regular file):
		// the open itself decides, and the regular file is kept.
		Row {
			script: r#"set -C; printf ORIGINAL >replacement; /bin/echo BAD >gate >victim & p=$!; /bin/mv replacement victim; /bin/cat gate >/dev/null & wait "$p"; echo s=$?; wait; /bin/cat victim"#,
			fifos:  &["gate", "victim"],
			output: "victim: cannot overwrite existing file\ns=1\nORIGINAL",
			status: 0,
			files:  &[],
		},
	])
	.await;
}

/// A redirection naming a descriptor the shell already holds (`/dev/fd/N`,
/// `/dev/stdout`, …) obeys `noclobber` by what that descriptor is: a
/// regular file behind the alias is refused, a FIFO behind it is written.
/// Bash 5.2.21 and 5.3.0 agree on every row.
#[tokio::test(flavor = "multi_thread")]
async fn noclobber_judges_a_descriptor_alias_by_the_object_behind_it() {
	check(&[
		Row {
			script: "printf ORIGINAL >f; exec 3<>f; set -o noclobber; printf BAD >/dev/fd/3; echo \
			         s=$?; cat f",
			fifos:  &[],
			output: "/dev/fd/3: cannot overwrite existing file\ns=1\nORIGINAL",
			status: 0,
			files:  &[("f", Some("ORIGINAL"))],
		},
		Row {
			script: "printf ORIGINAL >f; exec 3<>f; set -o noclobber; printf BAD &>/dev/fd/3; echo \
			         s=$?; cat f",
			fifos:  &[],
			output: "/dev/fd/3: cannot overwrite existing file\ns=1\nORIGINAL",
			status: 0,
			files:  &[("f", Some("ORIGINAL"))],
		},
		Row {
			script: "printf ORIGINAL >f; exec 3<>f; set -o noclobber; printf BAD >&/dev/fd/3; echo \
			         s=$?; cat f",
			fifos:  &[],
			output: "/dev/fd/3: cannot overwrite existing file\ns=1\nORIGINAL",
			status: 0,
			files:  &[("f", Some("ORIGINAL"))],
		},
		// A FIFO behind the alias is not clobbered by a write, so it passes.
		Row {
			script: "exec 3<>p; set -o noclobber; printf BAD >/dev/fd/3; echo s=$?; exec 3>&-",
			fifos:  &["p"],
			output: "s=0\n",
			status: 0,
			files:  &[],
		},
		// The same alias in the process a background command's own opens run
		// in (its first redirection waits for the FIFO's other end).
		Row {
			script: r#"printf ORIGINAL >f; exec 3<>f; set -o noclobber; /bin/cat gate >/dev/null & /bin/echo BAD >gate >/dev/fd/3 & p=$!; wait "$p"; echo s=$?; wait; cat f"#,
			fifos:  &["gate"],
			output: "/dev/fd/3: cannot overwrite existing file\ns=1\nORIGINAL",
			status: 0,
			files:  &[("f", Some("ORIGINAL"))],
		},
	])
	.await;
}

/// A file `noclobber`'s reopen cannot open at all is still refused when the
/// path is a regular file, and when its metadata cannot be read (a dangling
/// symlink, whose exclusive create reports that the file exists); a path
/// that is readable and not regular keeps the open's own error. Bash
/// 5.2.21 and 5.3.0 agree on every row.
#[tokio::test(flavor = "multi_thread")]
async fn noclobber_refuses_an_existing_file_it_cannot_open() {
	check(&[
		Row {
			script: "printf ORIGINAL >f; /bin/chmod 444 f; set -o noclobber; printf BAD >f; echo \
			         s=$?; cat f",
			fifos:  &[],
			output: "f: cannot overwrite existing file\ns=1\nORIGINAL",
			status: 0,
			files:  &[("f", Some("ORIGINAL"))],
		},
		Row {
			script: "printf ORIGINAL >f; /bin/chmod 444 f; set -o noclobber; printf BAD &>f; echo \
			         s=$?; cat f",
			fifos:  &[],
			output: "f: cannot overwrite existing file\ns=1\nORIGINAL",
			status: 0,
			files:  &[("f", Some("ORIGINAL"))],
		},
		Row {
			script: "/bin/ln -s absent d; set -o noclobber; printf BAD >d; echo s=$?",
			fifos:  &[],
			output: "d: cannot overwrite existing file\ns=1\n",
			status: 0,
			files:  &[("absent", None)],
		},
		Row {
			script: "/bin/ln -s absent d; set -o noclobber; printf BAD &>d; echo s=$?",
			fifos:  &[],
			output: "d: cannot overwrite existing file\ns=1\n",
			status: 0,
			files:  &[("absent", None)],
		},
		// The same two in the process a background command's own opens run in.
		Row {
			script: r#"printf ORIGINAL >f; /bin/chmod 444 f; set -o noclobber; /bin/echo BAD >gate >f & p=$!; /bin/cat gate >/dev/null & wait "$p"; echo s=$?; wait; cat f"#,
			fifos:  &["gate"],
			output: "f: cannot overwrite existing file\ns=1\nORIGINAL",
			status: 0,
			files:  &[("f", Some("ORIGINAL"))],
		},
		Row {
			script: r#"/bin/ln -s absent d; set -o noclobber; /bin/echo BAD >gate >d & p=$!; /bin/cat gate >/dev/null & wait "$p"; echo s=$?; wait"#,
			fifos:  &["gate"],
			output: "d: cannot overwrite existing file\ns=1\n",
			status: 0,
			files:  &[("absent", None)],
		},
		// Readable and not regular: the open's own error stands.
		Row {
			script: "/bin/mkdir sub; set -o noclobber; printf BAD >sub; echo s=$?",
			fifos:  &[],
			output: "sub: Is a directory\ns=1\n",
			status: 0,
			files:  &[],
		},
	])
	.await;
}

/// Bash refuses an existing regular file under `noclobber` without opening
/// it, so nothing the file holds can delay the refusal. A write lease
/// another process holds makes an open of that file wait for the lease to
/// break (45 s by default), which the process a background command's own
/// opens run in used to do: the command then reached its limit instead of
/// being refused.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn noclobber_refuses_a_leased_file_without_waiting_for_the_lease() {
	let dir = tempfile::tempdir().expect("temp dir");
	std::fs::write(dir.path().join("f"), b"ORIGINAL").expect("victim");
	let gate = std::ffi::CString::new(
		dir.path()
			.join("gate")
			.into_os_string()
			.into_encoded_bytes(),
	)
	.expect("path");
	// SAFETY: `gate` is a NUL-terminated string that outlives the call.
	assert_eq!(unsafe { libc::mkfifo(gate.as_ptr(), 0o600) }, 0, "mkfifo gate");
	// A lease break arrives as `SIGIO`, whose default action would end this
	// process; nothing here acts on it.
	// SAFETY: setting a signal disposition on this process.
	unsafe { libc::signal(libc::SIGIO, libc::SIG_IGN) };
	let victim = std::ffi::CString::new(dir.path().join("f").into_os_string().into_encoded_bytes())
		.expect("path");
	// SAFETY: `victim` is a NUL-terminated string that outlives the call.
	let held = unsafe { libc::open(victim.as_ptr(), libc::O_RDONLY) };
	assert!(held >= 0, "open the file to lease it");
	// SAFETY: `held` is an open descriptor this process owns.
	let taken = unsafe { libc::fcntl(held, libc::F_SETLEASE, libc::F_WRLCK) };
	if taken != 0 {
		// This filesystem grants no lease, so there is nothing to wait on
		// and nothing for this row to measure.
		// SAFETY: `held` is open and used nowhere else.
		unsafe { libc::close(held) };
		return;
	}
	let (tx, rx) = flume::unbounded::<String>();
	let result = Shell::new(None)
		.run(
			ShellRunOptions {
				command: r#"set -C; /bin/echo BAD >gate >f & p=$!; /bin/cat gate >/dev/null & wait "$p"; echo s=$?; wait"#
					.to_owned(),
				cwd:     Some(dir.path().to_string_lossy().into_owned()),
				..Default::default()
			},
			Some(tx),
			CancelToken::new(Some(10_000)),
		)
		.await
		.expect("run");
	// SAFETY: `held` is open and used nowhere else.
	unsafe { libc::close(held) };
	let output = strip_prefixes(&rx.drain().collect::<String>());
	assert!(!result.timed_out, "the refusal waited for the lease: {output:?}");
	assert_eq!(output, "f: cannot overwrite existing file\ns=1\n");
	assert_eq!(std::fs::read_to_string(dir.path().join("f")).expect("kept"), "ORIGINAL");
}
