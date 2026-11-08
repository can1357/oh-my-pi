//! `$!` in subshells, as Bash 5.3 runs a script (Bash 5.2.21 agrees on
//! every row): every subshell copies it, while the child it names stays
//! its parent's, not the subshell's.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Runs each script in a fresh shell and asserts Bash's output and exit
/// status 0, reporting every row that differs.
async fn assert_bash_outputs(rows: &[(&str, &str)]) {
	let mut mismatches = Vec::new();
	for &(script, bash_output) in rows {
		let (tx, rx) = flume::unbounded::<String>();
		let result = Shell::new(None)
			.run(
				ShellRunOptions { command: script.to_owned(), ..Default::default() },
				Some(tx),
				CancelToken::new(Some(20_000)),
			)
			.await
			.expect("run");
		let output: String = rx.drain().collect();
		if (result.exit_code, output.as_str()) != (Some(0), bash_output) {
			mismatches.push(format!(
				"`{script}`\n  bash: Some(0) {bash_output:?}\n  omp:  {:?} {output:?}",
				result.exit_code
			));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ from bash:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

/// A command substitution, a `( )` subshell and a pipeline stage expand
/// `$!` to the parent's: a command substitution saw none.
#[tokio::test(flavor = "multi_thread")]
async fn every_subshell_sees_the_parents_bang() {
	assert_bash_outputs(&[
		(r#"/bin/sleep 0.1 & [ "$!" = "$(echo $!)" ] && echo same || echo differ; wait"#, "same\n"),
		(r#"f(){ :; }; f & [ "$!" = "$(echo $!)" ] && echo same || echo differ; wait"#, "same\n"),
		(r#"f(){ :; }; f & p=$!; ( [ "$!" = "$p" ] && echo same ); wait"#, "same\n"),
		(
			r#"f(){ :; }; f & p=$!; echo x | { read -r _; [ "$!" = "$p" ] && echo same; }; wait"#,
			"same\n",
		),
	])
	.await;
}

/// The child `$!` names is not the subshell's to wait for: `wait PID`,
/// `wait` and `wait -n PID` in the subshell leave it alone.
#[tokio::test(flavor = "multi_thread")]
async fn a_subshell_does_not_wait_for_its_parents_child() {
	assert_bash_outputs(&[
		(
			r#"f(){ sleep 0.2; }; f & p=$!; ( wait "$p" 2>/dev/null; echo "s=$?" ); wait "$!"; echo "t=$?""#,
			"s=127\nt=0\n",
		),
		(r"f(){ sleep 0.2; }; f & ( wait 2>&1 ); echo done; wait", "done\n"),
		(
			r#"f(){ sleep 0.2; }; f & p=$!; ( wait -n "$p" 2>/dev/null; echo "n=$?" ); wait"#,
			"n=127\n",
		),
	])
	.await;
}

/// `$!` of a background pipeline is its last process's pid, as the process
/// reports `$$` itself (it was the shell's virtual pid).
#[tokio::test(flavor = "multi_thread")]
async fn a_background_pipelines_bang_is_its_last_process() {
	assert_bash_outputs(&[(
		r#"T=$(mktemp); /bin/sleep 0.1 | /bin/sh -c 'echo $$ >"$1"; exec /bin/sleep 0.1' sh "$T" & p=$!; wait; [ "$p" = "$(cat "$T")" ] && echo last; rm -f "$T""#,
		"last\n",
	)])
	.await;
}
