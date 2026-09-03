//! Pipeline streaming contracts: builtin/compound/function pipeline stages
//! run concurrently and deliver output chunks while the command is still
//! running, instead of buffering until exit.
#![cfg(unix)]

use std::time::{Duration, Instant};

use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, execute_shell},
};

async fn run_collecting(command: &str) -> (Option<Duration>, Duration, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let start = Instant::now();

	let collector = tokio::spawn(async move {
		let mut first_hit: Option<Duration> = None;
		let mut output = String::new();
		while let Ok(chunk) = rx.recv_async().await {
			if first_hit.is_none() && chunk.contains("hit") {
				first_hit = Some(start.elapsed());
			}
			output.push_str(&chunk);
		}
		(first_hit, output)
	});

	let result = execute_shell(
		ShellExecuteOptions {
			command: command.to_string(),
			timeout_ms: Some(30_000),
			..Default::default()
		},
		Some(tx),
		CancelToken::new(None),
	)
	.await
	.expect("shell execution");
	let total = start.elapsed();
	assert_eq!(result.exit_code, Some(0), "command failed: {command}");

	let (first_hit, output) = collector.await.expect("collector task");
	(first_hit, total, output)
}

/// A pipeline stage's output must reach the chunk callback while the pipeline
/// is still running. Regression: compound and function stages used to execute
/// inline during pipeline spawn, so downstream stages (and the consumer) saw
/// nothing until the stage exited; utility builtins used to hold stdout in an
/// exit-flushed `BufWriter`.
#[tokio::test]
async fn pipeline_stages_stream_before_exit() {
	for command in [
		"echo hit; sleep 1",
		"{ echo hit; sleep 1; } | cat",
		"{ echo hit; sleep 1; } | grep .",
		"f() { echo hit; sleep 1; }; f | cat",
	] {
		let (first_hit, total, _) = run_collecting(command).await;
		let first_hit = first_hit.expect("saw the first output chunk");
		// The producer sleeps 1s after emitting the first line; seeing that
		// line only in the back half of the run means it was buffered.
		assert!(
			first_hit < total / 2,
			"`{command}`: first chunk at {first_hit:?}, finished at {total:?}: buffered until exit"
		);
	}
}

/// Regression: a compound stage that outfills the connecting pipe's buffer
/// used to deadlock the whole shell — the stage ran inline during pipeline
/// spawn, blocking on a pipe whose reader had not been spawned yet.
#[tokio::test]
async fn compound_stage_larger_than_pipe_buffer_does_not_deadlock() {
	let (_, _, output) = run_collecting("{ seq 1 200000; echo hit; } | head -n 1").await;
	// The merged channel may also carry seq's EPIPE diagnostic once head
	// closes the pipe; the contract is that head emitted its line and the
	// pipeline terminated.
	assert_eq!(output.lines().next(), Some("1"));
}
