//! Where the shell's own diagnostics and an external command's standard
//! streams go under redirections, measured against Bash 5.2.21 and 5.3.0
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

const BOOM: Option<&str> = Some("missing: BOOM\n");

/// A fatal expansion error in the body of a redirected compound command,
/// function, `[[ ]]`, coprocess or process substitution goes through the
/// redirection in force when it happens, as Bash writes it, not to the
/// shell's own standard error after the redirection was undone.
#[tokio::test(flavor = "multi_thread")]
async fn a_fatal_expansion_error_goes_through_the_redirection_in_force() {
	let row = |script, output, status, files| Row { script, fifos: &[], output, status, files };
	check(&[
		row(r#"{ : "${missing:?BOOM}"; } 2>err; echo after"#, "", 127, &[("err", BOOM)]),
		row(r#"{ : "${missing:?BOOM}"; } 2>err & wait %1; echo s=$?"#, "s=1\n", 0, &[("err", BOOM)]),
		row(r#"if : "${missing:?BOOM}"; then :; fi 2>err; echo after"#, "", 127, &[("err", BOOM)]),
		row(r#"while : "${missing:?BOOM}"; do break; done 2>err; echo after"#, "", 127, &[(
			"err", BOOM,
		)]),
		row(r#"until : "${missing:?BOOM}"; do break; done 2>err; echo after"#, "", 127, &[(
			"err", BOOM,
		)]),
		row(r#"for i in 1; do : "${missing:?BOOM}"; done 2>err; echo after"#, "", 127, &[(
			"err", BOOM,
		)]),
		row(r#"case x in x) : "${missing:?BOOM}";; esac 2>err; echo after"#, "", 127, &[(
			"err", BOOM,
		)]),
		row(r#"f(){ : "${missing:?BOOM}"; } 2>err; f; echo after"#, "", 127, &[("err", BOOM)]),
		row(r#"f(){ : "${missing:?BOOM}"; }; f 2>err; echo after"#, "", 127, &[("err", BOOM)]),
		row(r#"[[ "${missing:?BOOM}" = x ]] 2>err; echo after"#, "", 127, &[("err", BOOM)]),
		row(r#"[[ "${missing:?BOOM}" = x ]] 2>err & wait %1; echo s=$?"#, "s=1\n", 0, &[(
			"err", BOOM,
		)]),
		row(r#"coproc { : "${missing:?BOOM}"; } 2>err; wait $!; echo P=$?"#, "P=1\n", 0, &[(
			"err", BOOM,
		)]),
		row(r#"cat <({ : "${missing:?BOOM}"; } 2>err); echo P=$?"#, "P=0\n", 0, &[("err", BOOM)]),
		row(r#"eval ': "${missing:?BOOM}"' 2>err; echo after"#, "", 127, &[("err", BOOM)]),
		row(r#"set -u; { : "$unset_var"; } 2>err; echo after"#, "", 127, &[(
			"err",
			Some("unset_var: unbound variable\n"),
		)]),
		row(r"{ : $((1/0)); } 2>err; echo after", "", 1, &[(
			"err",
			Some("1/0: division by 0 (error token is \"0\")\n"),
		)]),
		// The simple command's own redirection is never made: its words
		// expand first.
		row(r#"{ 2>inner : "${missing:?BOOM}"; } 2>outer & wait; echo s=$?"#, "s=0\n", 0, &[
			("outer", BOOM),
			("inner", None),
		]),
		row(r#"{ { : "${missing:?BOOM}"; } 2>inner; } 2>outer & wait %1; echo s=$?"#, "s=1\n", 0, &[
			("inner", BOOM),
			("outer", Some("")),
		]),
		// Already right before this change: a subshell's own descriptor table.
		row(r#"( : "${missing:?BOOM}" ) 2>err; echo after s=$?"#, "after s=1\n", 0, &[("err", BOOM)]),
		// A diagnostic larger than a pipe's buffer, bound to a pipe whose reader
		// is slow: it is delivered whole after the subshell ends, and the run
		// finishes.
		row(
			r#"m=$(head -c 100000 /dev/zero | tr "\0" x); { : "${missing:?$m}"; } 2>&1 | { /bin/sleep .2; /bin/cat; } | tail -c 6; echo done"#,
			"xxxxx\ndone\n",
			0,
			&[],
		),
	])
	.await;
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
