//! A fatal expansion error raised while the EXIT trap is running leaves the
//! shell with the status the shell was already exiting with, not with the
//! constant the other fatal sites use.
//!
//! Every expectation below was measured live against Bash 5.2.21
//! (`/usr/bin/bash`) and Bash 5.3.0; the two agree on every row here, so no
//! row depends on a Bash-version split.
#![cfg(unix)]

use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, execute_shell},
};

async fn run(command: &str) -> (Option<i32>, String) {
	let dir = tempfile::tempdir().expect("tempdir");
	let (tx, rx) = flume::unbounded::<String>();
	let result = execute_shell(
		ShellExecuteOptions {
			// The diagnostic text is bash's and is not under test; only the
			// status the shell leaves with is.
			command: format!("exec 2>/dev/null\n{command}"),
			cwd: Some(dir.path().to_string_lossy().into_owned()),
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

/// A forked subshell's EXIT trap: the subshell leaves with the status it was
/// exiting with (4), not the generic fatal status.
#[tokio::test]
async fn exit_trap_in_a_subshell_keeps_the_exiting_status() {
	let (code, output) = run("( trap ': ${nope?boom}' EXIT; exit 4 ); echo \"S:$?\"").await;
	assert_eq!(code, Some(0));
	assert_eq!(output, "S:4\n");
}

/// The same inside a command substitution, whose status reaches `$?` through
/// the assignment.
#[tokio::test]
async fn exit_trap_in_a_command_substitution_keeps_the_exiting_status() {
	let (code, output) = run("x=$( trap ': ${nope?boom}' EXIT; exit 4 ); echo \"S:$?\"").await;
	assert_eq!(code, Some(0));
	assert_eq!(output, "S:4\n");
}

/// A `nounset` reference, not a `${x?msg}` one: the same site, a different
/// diagnostic.
#[tokio::test]
async fn nounset_in_an_exit_trap_keeps_the_exiting_status() {
	let (code, output) = run("( trap 'set -u; : $nope' EXIT; exit 4 ); echo \"S:$?\"").await;
	assert_eq!(code, Some(0));
	assert_eq!(output, "S:4\n");
}

/// A pipeline element's EXIT trap, read back through `PIPESTATUS`.
#[tokio::test]
async fn exit_trap_in_a_pipeline_element_keeps_the_exiting_status() {
	let (code, output) =
		run("( trap ': ${nope?boom}' EXIT; exit 4 ) | cat; echo \"S:${PIPESTATUS[0]}\"").await;
	assert_eq!(code, Some(0));
	assert_eq!(output, "S:4\n");
}

/// The run's own EXIT trap: the status reaches the caller of the shell.
#[tokio::test]
async fn exit_trap_at_the_top_level_keeps_the_exiting_status() {
	let (code, output) = run("trap ': ${nope?boom}' EXIT; exit 4").await;
	assert_eq!(code, Some(4), "output: {output}");
}

/// The status is carried, not replaced by a second constant: a different
/// exiting status comes back unchanged.
#[tokio::test]
async fn exit_trap_at_the_top_level_carries_any_exiting_status() {
	let (code, output) = run("trap ': ${nope?boom}' EXIT; exit 9").await;
	assert_eq!(code, Some(9), "output: {output}");
}

/// Zero is a status like any other: a successful exit interrupted by a fatal
/// error in its EXIT trap still leaves 0, as both Bashes do.
#[tokio::test]
async fn exit_trap_keeps_a_zero_exiting_status() {
	let (code, output) = run("( trap ': ${nope?boom}' EXIT; exit 0 ); echo \"S:$?\"").await;
	assert_eq!(code, Some(0));
	assert_eq!(output, "S:0\n");
}

/// `exit 300` is a wait status of 44 by the time the EXIT trap is armed, and
/// the carried status must be that same 44 — the value `$?` reports inside the
/// trap — with no second narrowing applied on the way out.
#[tokio::test]
async fn exit_trap_carries_a_wrapped_exiting_status_unchanged() {
	let (code, output) =
		run("( trap 'echo \"T:$?\"; : ${nope?boom}' EXIT; exit 300 ); echo \"S:$?\"").await;
	assert_eq!(code, Some(0));
	assert_eq!(output, "T:44\nS:44\n");
}

/// The same for a negative `exit` argument, whose wait status is 255: the
/// status the trap sees and the status the subshell leaves with must agree.
#[tokio::test]
async fn exit_trap_carries_a_negative_exiting_status_unchanged() {
	let (code, output) =
		run("( trap 'echo \"T:$?\"; : ${nope?boom}' EXIT; exit -1 ); echo \"S:$?\"").await;
	assert_eq!(code, Some(0));
	assert_eq!(output, "T:255\nS:255\n");
}

/// A wrapped status at the top level reaches the caller of the shell too.
#[tokio::test]
async fn exit_trap_at_the_top_level_carries_a_wrapped_status() {
	let (code, output) = run("trap ': ${nope?boom}' EXIT; exit 300").await;
	assert_eq!(code, Some(44), "output: {output}");
}

/// A function called from the EXIT trap is still inside it: the innermost
/// *trap* frame is what decides, and function frames do not hide it.
#[tokio::test]
async fn a_function_called_from_the_exit_trap_is_still_in_it() {
	let (code, output) =
		run("( f(){ : ${nope?boom}; }; trap 'f' EXIT; exit 4 ); echo \"S:$?\"").await;
	assert_eq!(code, Some(0));
	assert_eq!(output, "S:4\n");
}

/// Negative control: with `errexit` on, bash reaches these rows through its
/// own errexit jump, which this change does not model, so the upstream
/// constant stays. Both Bashes answer 1 here, and so must we.
#[tokio::test]
async fn errexit_keeps_the_upstream_constant() {
	let (code, output) = run("( set -e; trap ': ${nope?boom}' EXIT; exit 7 ); echo \"S:$?\"").await;
	assert_eq!(code, Some(0));
	assert_eq!(output, "S:1\n");
}

/// Negative control: `errexit` inherited by the subshell from its parent
/// counts the same as `set -e` inside it.
#[tokio::test]
async fn inherited_errexit_keeps_the_upstream_constant() {
	let (code, output) =
		run("set -e; ( trap ': ${nope?boom}' EXIT; exit 7 ) || echo \"S:$?\"").await;
	assert_eq!(code, Some(0));
	assert_eq!(output, "S:1\n");
}

/// Negative control: a trap action of another kind running *inside* the EXIT
/// trap is the innermost trap frame, and it does not carry the exiting
/// status. Here the EXIT trap's `false` fires the ERR trap, and the fatal
/// error happens in the ERR trap.
#[tokio::test]
async fn a_nested_non_exit_trap_keeps_the_upstream_constant() {
	let (code, output) =
		run("( trap ': ${nope?boom}' ERR; trap 'false' EXIT; exit 4 ); echo \"S:$?\"").await;
	assert_eq!(code, Some(0));
	assert_eq!(output, "S:1\n");
}

/// Negative control: an ERR trap that is not nested in an EXIT trap keeps the
/// constant as well. The fatal error in the ERR trap ends the subshell, so
/// the `echo` after `false` never runs — both Bashes agree.
#[tokio::test]
async fn an_err_trap_outside_an_exit_trap_keeps_the_upstream_constant() {
	let (code, output) =
		run("( trap ': ${nope?boom}' ERR; false; echo \"A:$?\"; exit 4 ); echo \"S:$?\"").await;
	assert_eq!(code, Some(0));
	assert_eq!(output, "S:1\n");
}

/// Negative control: no trap at all is the unchanged fatal path.
#[tokio::test]
async fn a_fatal_error_outside_any_trap_keeps_the_upstream_constant() {
	let (code, output) = run("( : ${nope?boom} ); echo \"S:$?\"").await;
	assert_eq!(code, Some(0));
	assert_eq!(output, "S:1\n");
}
