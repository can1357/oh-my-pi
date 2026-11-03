//! Regressions from the fourth review of #17845, each compared with Bash
//! 5.2.21 reading the same text on its standard input. The text runs as
//! calls to one persistent `pi_shell::Shell`, the shell the bash tool's
//! executor keeps for a session, with the output minimizer on and off; Bash
//! reads the calls one after another as one script. `PI_SHELL_BASH_ORACLE=1`
//! sends the calls to Bash on both sides, to check the comparison.
#![cfg(target_os = "linux")]

use std::path::Path;

use pi_shell::{
	Shell, ShellOptions, ShellRunOptions, cancel::CancelToken, minimizer::MinimizerOptions,
};

fn oracle() -> bool {
	std::env::var_os("PI_SHELL_BASH_ORACLE").is_some()
}

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

/// Runs `calls` in `dir`, one call after another on one shell, the output
/// minimizer on or off: the status of the last call and every call's output.
async fn run_calls(minimize: bool, dir: &Path, calls: &[&str]) -> (Option<i32>, String) {
	if oracle() {
		return run_bash(dir, calls).await;
	}
	let options = minimize.then(|| ShellOptions {
		minimizer: Some(MinimizerOptions { enabled: Some(true), ..Default::default() }),
		..Default::default()
	});
	let shell = Shell::new(options);
	let cd = format!("cd '{}'", dir.display());
	let mut status = None;
	let mut output = String::new();
	for call in std::iter::once(cd.as_str()).chain(calls.iter().copied()) {
		let (call_status, call_output) = run_in(&shell, call).await;
		status = call_status;
		output.push_str(&call_output);
	}
	(status, output)
}

/// Bash 5.2.21 reading `calls`, each on a line of its own, as one script on
/// its standard input, in `dir`.
async fn run_bash(dir: &Path, calls: &[&str]) -> (Option<i32>, String) {
	let script = format!("cd '{}'\n{}\n", dir.display(), calls.join("\n"));
	tokio::task::spawn_blocking(move || {
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
			.write_all(script.as_bytes())
			.expect("write");
		let output = child.wait_with_output().expect("bash output");
		(output.status.code(), String::from_utf8_lossy(&output.stdout).into_owned())
	})
	.await
	.expect("join")
}

/// The files `names` in `dir`, with their contents (`-` for a missing one).
fn files(dir: &Path, names: &[&str]) -> Vec<(String, String)> {
	names
		.iter()
		.map(|name| {
			let text = std::fs::read_to_string(dir.join(name)).unwrap_or_else(|_| "-".to_owned());
			((*name).to_owned(), text)
		})
		.collect()
}

/// A command whose word names a function, an alias or anything else that
/// can change the shell's state (here an `exec` of a descriptor) keeps a
/// chain whole when the output minimizer would otherwise run it a segment
/// at a time, as each segment runs with streams of its own: the change
/// reaches the commands after it, as in Bash. The definitions come in a call
/// before the chain, on the same shell; a definition in the chain's own call
/// keeps it whole too. Each row runs with the minimizer on and off.
#[tokio::test(flavor = "multi_thread")]
async fn a_command_that_may_change_the_shell_keeps_a_chain_whole() {
	let rows: &[(&str, &str, &str, &[&str])] = &[
		("function-stdout", "quiet() { exec >hidden; }", "quiet; echo HIDDEN; echo END", &["hidden"]),
		("function-stderr-file", "quiet() { exec 2>hidden; }", "quiet; echo ERR >&2; echo OUT", &[
			"hidden",
		]),
		(
			"function-stderr-null",
			"quiet() { exec 2>/dev/null; }",
			"quiet; echo ERR >&2; echo OUT",
			&[],
		),
		("function-dup", "dup() { exec 3>&1; }", "dup; echo X >&3; echo END", &[]),
		(
			"nested-function",
			"inner() { exec >hidden; }; outer() { inner; }",
			"outer; echo HIDDEN; echo END",
			&["hidden"],
		),
		("alias", "shopt -s expand_aliases; alias e=exec", "e >hidden; echo HIDDEN; echo END", &[
			"hidden",
		]),
		("function-eval", "quiet() { eval 'exec >hidden'; }", "quiet; echo HIDDEN; echo END", &[
			"hidden",
		]),
		("eval", ":", "eval 'exec >hidden'; echo HIDDEN; echo END", &["hidden"]),
		("source", "printf 'exec >hidden\\n' > q.sh", ". ./q.sh; echo HIDDEN; echo END", &["hidden"]),
		(
			"function-source",
			"printf 'exec >hidden\\n' > q.sh; quiet() { . ./q.sh; }",
			"quiet; echo HIDDEN; echo END",
			&["hidden"],
		),
		("err-trap", "trap 'exec >hidden' ERR", "false; echo HIDDEN; echo END", &["hidden"]),
		("command-function", "command() { exec >hidden; }", "command; echo HIDDEN; echo END", &[
			"hidden",
		]),
		(
			"utility-function",
			"echo() { exec >hidden; builtin echo \"$@\"; }",
			"echo HIDDEN; echo END",
			&["hidden"],
		),
		("same-call", ":", "quiet() { exec >hidden; }; quiet; echo HIDDEN; echo END", &["hidden"]),
		("plain-exec", ":", "exec >hidden; echo HIDDEN; echo END", &["hidden"]),
		("harmless-function", "say() { builtin echo \"$@\"; }", "say A; echo B; echo C", &[]),
	];
	let mut mismatches = Vec::new();
	for &(name, setup, chain, names) in rows {
		let bash_dir = tempfile::tempdir().expect("dir");
		let bash = run_bash(bash_dir.path(), &[setup, chain]).await;
		let bash_files = files(bash_dir.path(), names);
		for minimize in [true, false] {
			let dir = tempfile::tempdir().expect("dir");
			let here = run_calls(minimize, dir.path(), &[setup, chain]).await;
			let here_files = files(dir.path(), names);
			if (&here, &here_files) != (&bash, &bash_files) {
				mismatches.push(format!(
					"{name} (minimizer {}): `{setup}` then `{chain}`\n  bash: {bash:?} \
					 {bash_files:?}\n  omp:  {here:?} {here_files:?}",
					if minimize { "on" } else { "off" }
				));
			}
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ from bash:\n{}",
		mismatches.len(),
		rows.len() * 2,
		mismatches.join("\n")
	);
}
