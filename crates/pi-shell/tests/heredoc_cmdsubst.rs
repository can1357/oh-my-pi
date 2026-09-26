//! Quoted here-documents nested in `"$(...)"` must stay opaque: their bodies
//! are data, never shell source.
#![cfg(unix)]

use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, execute_shell},
};

async fn run(command: &str, cwd: &std::path::Path) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = execute_shell(
		ShellExecuteOptions {
			command: command.to_string(),
			cwd: Some(cwd.to_string_lossy().into_owned()),
			timeout_ms: Some(30_000),
			..Default::default()
		},
		Some(tx),
		CancelToken::new(None),
	)
	.await
	.expect("shell execution");
	let output: String = rx.drain().collect();
	(result.exit_code, output)
}

#[tokio::test]
async fn quoted_heredoc_in_double_quoted_cmdsubst_does_not_run_backticks() {
	let dir = tempfile::tempdir().expect("tempdir");
	let (code, output) =
		run("printf '%s\\n' \"$(cat <<'EOF'\na (b's c) `touch pwned` d's\nEOF\n)\"", dir.path())
			.await;
	assert!(!dir.path().join("pwned").exists(), "backtick span in heredoc body was executed");
	assert_eq!(code, Some(0), "output: {output}");
	assert_eq!(output, "a (b's c) `touch pwned` d's\n");
}

/// A lone `)` in the body must not close the substitution early.
#[tokio::test]
async fn quoted_heredoc_body_paren_does_not_close_cmdsubst() {
	let dir = tempfile::tempdir().expect("tempdir");
	let (code, output) = run("printf '%s\\n' \"$(cat <<'EOF'\n)\nEOF\n)\"", dir.path()).await;
	assert_eq!(code, Some(0), "output: {output}");
	assert_eq!(output, ")\n");
}
