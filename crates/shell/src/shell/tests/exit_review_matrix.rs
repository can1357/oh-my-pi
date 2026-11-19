//! Final-gate matrix: raw termination status versus a function's outgoing
//! status, conditional-only versus unconditional remaining segments, minimizer
//! on/off; first arithmetic-for header (init/test present/omitted) versus a
//! completed body's loop-back, with/without a caller suffix.

use super::*;

async fn run_case(shell: &Shell, command: &str) -> (ShellRunResult, String) {
	let (tx, rx) = flume::unbounded();
	let result = shell
		.run(
			ShellRunOptions { command: command.into(), ..Default::default() },
			Some(tx),
			CancelToken::default(),
		)
		.await
		.expect("shell run");
	(result, rx.try_iter().collect())
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_segmented_continuation_uses_function_status() {
	let _guard = shell_test_lock().lock().await;
	for minimized in [false, true] {
		let root = tempfile::tempdir().expect("minimizer directory");
		for status in [0, 1] {
			for negated in [false, true] {
				let shell = Shell::new(minimized.then(|| ShellOptions {
					minimizer: Some(printf_minimizer(&root.path().join("minimizer.toml"), None)),
					..Default::default()
				}));
				let prefix = if negated { "! " } else { "" };
				// Establish the outgoing status with a non-aborting subshell,
				// independently of the exit-attribution continuation walker.
				let succeeded = (status == 0) != negated;
				let (control, _) = run_case(&shell, &format!("{prefix}(exit {status})")).await;
				assert_eq!(control.exit_code, Some(i32::from(!succeeded)));
				run_case(&shell, &format!("f() {{ {prefix}exit {status}; }}")).await;
				for (suffix, expected) in [
					("", false),
					(" && printf never", succeeded),
					(" && printf never && printf later", succeeded),
					(" && printf never; printf tail", true),
					("; printf tail", true),
				] {
					let command = format!("f{suffix}");
					let (result, output) = run_case(&shell, &command).await;
					assert_eq!(result.exit_code, Some(status), "{prefix}{command}");
					assert!(output.is_empty(), "aborted suffix ran: {command}");
					assert_eq!(
						result.ended_by_exit, expected,
						"minimized={minimized}, negated={negated}, status={status}: {command}"
					);
				}
			}
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_initial_arithmetic_header_keeps_unentered_body() {
	let _guard = shell_test_lock().lock().await;
	for header in ["i=0;i<1;i++", ";i<1;i++", "i=0;;i++", ";;"] {
		for suffix in ["", "; printf tail"] {
			let shell = Shell::new(None);
			// Without an exit, this first header reaches the body. A break
			// keeps omitted conditions finite without predicting termination.
			let (_, output) = run_case(
				&shell,
				&format!("i=0; trap ':' DEBUG; for (({header})); do printf body; break; done"),
			)
			.await;
			assert_eq!(output, "body", "header={header}");
			let command = format!(
				"i=0; trap 'exit 0' DEBUG; for (({header})); do printf body; break; done{suffix}"
			);
			let (result, output) = run_case(&shell, &command).await;
			assert_eq!(result.exit_code, Some(0), "{command}");
			assert!(output.is_empty(), "body ran after DEBUG exit: {command}");
			assert!(result.ended_by_exit, "first body was left unrun: {command}");

			// Once the body has reached its final exit, the iteration edge
			// must not count that same body again as new input.
			let command = format!("trap - DEBUG; i=0; for (({header})); do exit 0; done{suffix}");
			let (result, output) = run_case(&Shell::new(None), &command).await;
			assert!(output.is_empty(), "{command}");
			assert_eq!(result.ended_by_exit, !suffix.is_empty(), "{command}");
		}
	}
	// A DEBUG exit during a later header must not replay the body that
	// already ran; only a submitted suffix outside that loop is new input.
	for header in ["i=0;i<2;i++", ";i<2;i++"] {
		for suffix in ["", "; printf tail"] {
			let command = format!(
				"i=0; trap 'if ((i==1)); then exit 0; fi' DEBUG; for (({header})); do printf body; \
				 done{suffix}"
			);
			let (result, output) = run_case(&Shell::new(None), &command).await;
			assert_eq!(output, "body", "{command}");
			assert_eq!(result.ended_by_exit, !suffix.is_empty(), "{command}");
		}
	}
}
