//! `exec` with no command moves its redirections into the shell's own
//! descriptors for every later command of the run, as in Bash 5.2.21 reading
//! a script: `exec 2>/dev/null` silences what later commands write to
//! standard error, `exec 1>file` sends their output to the file, `exec 3>file`
//! opens a descriptor they can write to and `exec 3>&-` closes it, and
//! `exec 2>&3` puts back a descriptor saved earlier. The run's output pipe
//! carried standard output and error even after `exec`, because each run's
//! streams sat in its execution parameters, which shadowed the shell's
//! descriptors that `exec` changes.
//!
//! The expected outputs are what Bash prints for the same script read on its
//! standard input, with standard output and error in one stream. Setting
//! `PI_SHELL_BASH_ORACLE=1` runs the scripts under `bash` instead, to check
//! them.
#![cfg(target_os = "linux")]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

fn oracle() -> bool {
	std::env::var_os("PI_SHELL_BASH_ORACLE").is_some()
}

/// Runs `script` as one run of `shell` and returns its exit status and its
/// standard output and error in one stream.
async fn run_in(shell: &Shell, script: &str) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = shell
		.run(
			ShellRunOptions { command: script.to_owned(), ..Default::default() },
			Some(tx),
			CancelToken::new(Some(60_000)),
		)
		.await
		.expect("run");
	(result.exit_code, rx.drain().collect())
}

/// Runs `script` in a fresh shell, or under Bash for the oracle.
async fn run(script: &str) -> (Option<i32>, String) {
	if oracle() {
		let script = script.to_owned();
		return tokio::task::spawn_blocking(move || {
			use std::io::Write;
			let mut child = std::process::Command::new("sh")
				.args(["-c", "exec bash --noprofile --norc 2>&1"])
				.stdin(std::process::Stdio::piped())
				.stdout(std::process::Stdio::piped())
				.spawn()
				.expect("bash");
			child
				.stdin
				.take()
				.expect("stdin")
				.write_all(format!("{script}\n").as_bytes())
				.expect("write");
			let output = child.wait_with_output().expect("bash output");
			(output.status.code(), String::from_utf8_lossy(&output.stdout).into_owned())
		})
		.await
		.expect("join");
	}
	run_in(&Shell::new(None), script).await
}

/// Each `exec` form, across the commands and lines of one run, in a function
/// (the shell's own descriptors) and in a subshell (only the subshell's).
#[tokio::test(flavor = "multi_thread")]
async fn exec_redirections_persist_for_later_commands_as_in_bash() {
	let rows: [(&str, &str, &str); 9] = [
		("exec-2-null", "exec 2>/dev/null; echo E >&2; echo O", "O\n"),
		("exec-2-null-next-line", "exec 2>/dev/null\necho E >&2\necho O", "O\n"),
		(
			"exec-1-file",
			r#"t=$(mktemp); exec 3>&1 1>"$t"; echo hidden; exec 1>&3 3>&-; echo shown; cat "$t"; rm -f "$t""#,
			"shown\nhidden\n",
		),
		(
			"exec-3-file-and-close",
			r#"t=$(mktemp); exec 3>"$t"; echo a >&3; echo b >&3; exec 3>&-; { echo c >&3; } 2>/dev/null; echo "st=$?"; cat "$t"; rm -f "$t""#,
			"st=1\na\nb\n",
		),
		(
			"exec-2-to-1",
			r#"t=$(mktemp); exec 3>&1 1>"$t" 2>&1; echo O; echo E >&2; exec 1>&3 2>&3 3>&-; cat "$t"; rm -f "$t""#,
			"O\nE\n",
		),
		(
			"exec-2-restore-from-3",
			"exec 3>&2 2>/dev/null; echo E1 >&2; exec 2>&3 3>&-; echo E2 >&2; echo O",
			"E2\nO\n",
		),
		("exec-in-function", "f() { exec 2>/dev/null; }; f; echo E >&2; echo O", "O\n"),
		("exec-in-subshell", "( exec 2>/dev/null; echo E1 >&2 ); echo E2 >&2", "E2\n"),
		("external-command-after-exec", "exec 2>/dev/null; /bin/sh -c 'echo E >&2; echo O'", "O\n"),
	];
	let mut mismatches = Vec::new();
	for (name, script, expected) in rows {
		let (status, output) = run(script).await;
		if (status, output.as_str()) != (Some(0), expected) {
			mismatches.push(format!(
				"{name}: `{script}`\n  want: Some(0) {expected:?}\n  got:  {status:?} {output:?}"
			));
		}
	}
	assert!(mismatches.is_empty(), "{} rows differ:\n{}", mismatches.len(), mismatches.join("\n"));
}

/// Each run of a session starts with its own output streams, so `exec`
/// changes made in one run end with it: a later run's standard error is
/// seen again, and a descriptor `exec` opened is closed. Bash has no runs
/// (each is a new script with fresh standard streams); ending the change
/// also lets the earlier run's output reach its end, as `exec 3>&1` would
/// otherwise hold that run's pipe open.
#[tokio::test(flavor = "multi_thread")]
async fn a_later_run_starts_with_its_own_streams() {
	if oracle() {
		return;
	}
	let shell = Shell::new(None);
	assert_eq!(
		run_in(&shell, "exec 2>/dev/null 3>&1; echo E1 >&2; echo O1").await,
		(Some(0), "O1\n".to_owned())
	);
	assert_eq!(
		run_in(&shell, r#"echo E2 >&2; { echo x >&3; } 2>/dev/null; echo "st=$?""#).await,
		(Some(0), "E2\nst=1\n".to_owned())
	);
}

/// `exec` with a command would replace the host process, so the shell
/// refuses it and goes on, while `exec` with only redirections still works.
#[tokio::test(flavor = "multi_thread")]
async fn exec_with_a_command_is_refused() {
	if oracle() {
		return;
	}
	assert_eq!(
		run("exec false; echo refused=$?; exec 2>/dev/null; exec false; echo again=$?").await,
		(Some(0), "exec: not available in this shell\nrefused=1\nagain=1\n".to_owned())
	);
}
