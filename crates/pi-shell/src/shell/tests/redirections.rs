//! Where the shell's own diagnostics go under redirections, measured
//! against Bash 5.2.21 and 5.3.0
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
