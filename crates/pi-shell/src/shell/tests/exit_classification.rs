//! Exit notices distinguish early exit/errexit from other shell termination.

use super::*;

async fn run_exit_case(shell: &Shell, command: &str) -> ShellRunResult {
	shell
		.run(
			ShellRunOptions { command: command.into(), ..Default::default() },
			None,
			CancelToken::default(),
		)
		.await
		.expect("shell run")
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_posix_fatal_is_not_an_exit_notice() {
	let _guard = shell_test_lock().lock().await;
	for command in [
		"set +e; set -o posix; readonly x=1; x=2; echo never",
		"set +e; set -o posix; readonly RO=1; RO=2 :; echo never",
		"set +e; set -o posix; : < /no/such/exit-classification-file; echo never",
	] {
		let result = run_exit_case(&Shell::new(None), command).await;
		assert_ne!(result.exit_code, Some(0), "{command}");
		assert!(!result.ended_by_exit, "fatal termination is not exit/errexit: {command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_segmented_exec_stops_without_exit_notice() {
	let _guard = shell_test_lock().lock().await;
	let root = tempfile::tempdir().expect("chain directory");
	let minimizer = printf_minimizer(&root.path().join("minimizer.toml"), None);
	let shell = Shell::new(Some(ShellOptions { minimizer: Some(minimizer), ..Default::default() }));
	run_exit_case(&shell, "f() { exec /usr/bin/true; }").await;
	let result = run_exit_case(&shell, "f; printf hello; exit 73").await;
	assert_eq!(result.exit_code, Some(0), "exec still terminates the segmented chain");
	assert!(!result.ended_by_exit, "exec does not become exit when a later segment remains");
	assert!(
		!run_exit_case(&shell, "printf hello; printf world")
			.await
			.ended_by_exit
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_cleanup_preserves_first_exit_report() {
	let _guard = shell_test_lock().lock().await;
	for trap in [":", "exit 0", "exec /usr/bin/true"] {
		for (tail, expected) in [("", false), ("; echo never", true)] {
			let shell = Shell::new(None);
			let command = format!("trap '{trap}' EXIT; f() {{ exit 0; }}; f{tail}");
			let result = run_exit_case(&shell, &command).await;
			assert_eq!(result.ended_by_exit, expected, "{command}");
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_successors_follow_terminating_status() {
	let _guard = shell_test_lock().lock().await;
	for minimized in [false, true] {
		let root = tempfile::tempdir().expect("chain directory");
		let shell = Shell::new(minimized.then(|| ShellOptions {
			minimizer: Some(printf_minimizer(&root.path().join("minimizer.toml"), None)),
			..Default::default()
		}));
		for status in [0, 1] {
			for operator in ["&&", "||"] {
				for negated in [false, true] {
					for tail in ["", "; printf tail"] {
						let prefix = if negated { "! " } else { "" };
						let command = format!("{prefix}exit {status} {operator} printf never{tail}");
						let succeeded = (status == 0) != negated;
						let expected = !tail.is_empty() || succeeded == (operator == "&&");
						let result = run_exit_case(&shell, &command).await;
						assert_eq!(result.exit_code, Some(status), "{command}");
						assert_eq!(result.ended_by_exit, expected, "minimized={minimized}: {command}");
					}
				}
			}
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_zsh_captures_suffix_before_function_unwind() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(None);
	run_exit_case(&shell, "emulate zsh").await;
	for (command, expected) in [
		("f() { exit 0; echo never; }; f", true),
		("f() { exit 0; }; f", false),
		("() { exit 0; echo never; }", true),
		("() { exit 0; }", false),
		("g() { exit 0; }; g; echo never", true),
	] {
		let result = run_exit_case(&shell, command).await;
		assert_eq!(result.exit_code, Some(0), "{command}");
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_composites_set_the_continuation_status() {
	let _guard = shell_test_lock().lock().await;
	for (command, expected) in [
		// An if without else succeeds when its condition fails, so the &&
		// successor WOULD run and was cut short; the || successor would not.
		("if exit 1; then :; fi && printf never", true),
		("if exit 1; then :; fi || printf never", false),
		// A while loop that ends because its condition failed also completes
		// successfully (POSIX: exit status 0 without break).
		("while exit 1; do :; done && printf never", true),
		("while exit 1; do :; done || printf never", false),
	] {
		let result = run_exit_case(&Shell::new(None), command).await;
		assert_eq!(result.exit_code, Some(1), "{command}");
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_negation_crosses_frame_boundaries() {
	let _guard = shell_test_lock().lock().await;
	for (command, expected) in [
		// The negated pipeline inside the function yields failure, so the &&
		// successor would not run and nothing was cut short.
		("f() { ! exit 0; }; f && printf never", false),
		("f() { ! exit 0; }; f || printf never", true),
		("f() { ! ! exit 1; }; f && printf never", false),
		("g() { ! exit 0; }; f() { g; }; f && printf never", false),
	] {
		let result = run_exit_case(&Shell::new(None), command).await;
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_trap_interruption_keeps_unrun_suffix() {
	let _guard = shell_test_lock().lock().await;
	for (command, expected) in [
		// A DEBUG trap runs before each command: the exit it triggers leaves
		// the following command unrun.
		("trap 'exit 0' DEBUG; printf never", true),
		// An ERR trap firing after a failing command likewise precedes the
		// suffix that never ran.
		("trap 'exit 0' ERR; false; printf never", true),
	] {
		let result = run_exit_case(&Shell::new(None), command).await;
		assert_eq!(result.exit_code, Some(0), "{command}");
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_zsh_always_cleanup_is_not_cut_input() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(None);
	run_exit_case(&shell, "emulate zsh").await;
	for (command, expected) in [
		// The only apparent suffix is mandatory cleanup: it runs, so nothing
		// ordinary was cut short.
		("f() { { exit 0; } always { printf cleanup; }; }; f", false),
		// A genuine suffix after the always block remains unrun input.
		("f() { { exit 0; } always { printf cleanup; }; }; f; printf never", true),
	] {
		let result = run_exit_case(&shell, command).await;
		assert_eq!(result.exit_code, Some(0), "{command}");
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}
