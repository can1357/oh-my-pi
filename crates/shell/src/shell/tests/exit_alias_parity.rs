//! The segmented stop probe uses the abort-time parse context and parses
//! the actual segment input, including the errexit-suppression wrapper.

use super::*;

async fn run_case(
	shell: &Shell,
	command: &str,
	trace: Option<Arc<RunTrace>>,
) -> (ShellRunResult, String) {
	let (tx, rx) = flume::unbounded();
	let result = shell
		.run(
			ShellRunOptions { command: command.into(), trace, ..Default::default() },
			Some(tx),
			CancelToken::default(),
		)
		.await
		.expect("shell run");
	(result, rx.try_iter().collect())
}

/// Exercise both execution paths, not just two minimizer settings. The
/// aborting segment's trace must actually identify a physical segment.
async fn both_modes(
	setup: &str,
	body: &str,
	expected_status: i32,
	expected_output: &str,
	expected_flags: [bool; 2],
	live_alias: Option<bool>,
) {
	let _guard = shell_test_lock().lock().await;
	let root = tempfile::tempdir().expect("minimizer directory");
	for (segmented, expected) in [false, true].into_iter().zip(expected_flags) {
		let shell = Shell::new(segmented.then(|| ShellOptions {
			minimizer: Some(printf_minimizer(&root.path().join("minimizer.toml"), None)),
			..Default::default()
		}));
		assert_eq!(run_case(&shell, setup, None).await.0.exit_code, Some(0), "{setup}");
		let trace = Arc::new(RunTrace::new(body));
		let (result, output) = run_case(&shell, body, Some(Arc::clone(&trace))).await;
		let snapshot = trace.snapshot();
		let end = snapshot
			.history
			.iter()
			.find(|entry| {
				entry.vpid == snapshot.root_vpid
					&& matches!(entry.data, crate::bash::trace::history::HistoryData::RunEnd { .. })
			})
			.expect("root run end");
		assert_eq!(end.segment.is_some(), segmented, "wrong execution path: {body}");
		assert_eq!(result.exit_code, Some(expected_status), "{body}");
		assert_eq!(output, expected_output, "{setup}: {body}");
		assert_eq!(result.ended_by_exit, expected, "segmented={segmented}: {setup}: {body}");
		if let Some(present) = live_alias {
			let (alias, _) = run_case(&shell, "alias printf", None).await;
			assert_eq!(alias.exit_code, Some(i32::from(!present)), "live table: {setup}");
		}
	}
}

/// EXIT cleanup that rewrites the alias table must not reclassify the stop.
#[tokio::test(flavor = "multi_thread")]
async fn exit_cleanup_alias_change_classifies_at_the_abort() {
	for (setup, expected, live_alias) in [
		// Cleanup adds a comment alias: only the frozen table sees work.
		(
			"shopt -s expand_aliases; f() { trap \"builtin printf cleanup; alias printf='#'\" EXIT; \
			 exit 0; }",
			true,
			true,
		),
		// Cleanup removes a comment alias: only the live table sees work.
		(
			"shopt -s expand_aliases; alias printf='#'; f() { trap 'builtin printf cleanup; unalias \
			 printf' EXIT; exit 0; }",
			false,
			false,
		),
		// Stable command alias, cleanup changes an unrelated name.
		(
			"shopt -s expand_aliases; alias printf='builtin printf'; f() { trap \"builtin printf \
			 cleanup; alias u='#'\" EXIT; exit 0; }",
			true,
			true,
		),
		// Stable comment alias, cleanup changes an unrelated name.
		(
			"shopt -s expand_aliases; alias printf='#'; f() { trap \"builtin printf cleanup; alias \
			 u='#'\" EXIT; exit 0; }",
			false,
			true,
		),
	] {
		both_modes(setup, "f; printf tail", 0, "cleanup", [expected; 2], Some(live_alias)).await;
	}
}

/// A tail that parses away bare can be a syntax error once wrapped. A
/// successor of a failing `&&` leg, by contrast, is neither run nor owed.
#[tokio::test(flavor = "multi_thread")]
async fn exit_stop_probe_parses_the_effective_segment_source() {
	for (setup, body, expected_flags) in [
		("shopt -s expand_aliases", "exit 7; printf hello", [true, true]),
		("shopt -s expand_aliases; alias gone='#'", "exit 7; gone && printf hello", [false, true]),
		("shopt -s expand_aliases", "exit 7; gone && printf hello", [true, true]),
		("shopt -s expand_aliases; alias printf='builtin printf'", "exit 7 && printf hello", [
			false, false,
		]),
	] {
		both_modes(setup, body, 7, "", expected_flags, None).await;
	}
}
